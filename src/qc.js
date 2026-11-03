import path from 'node:path';
import fs from 'node:fs/promises';
import { ffprobe, ffmpeg, run, ffmpegBin } from './util.js';

/** 自动质检：黑帧、冻帧、响度、削波、时长、码率。不过就不交付。 */
export async function qcReport(file, expect = {}) {
  const info = await ffprobe(file);
  const v = info.streams.find((s) => s.codec_type === 'video') || {};
  const a = info.streams.find((s) => s.codec_type === 'audio') || {};
  const duration = Number(info.format.duration || 0);
  const checks = [];

  const { stderr } = await run(ffmpegBin(), [
    '-hide_banner', '-nostats', '-i', file,
    '-vf', 'blackdetect=d=0.3:pix_th=0.12,freezedetect=n=0.003:d=1.5',
    '-af', 'ebur128=peak=true',
    '-f', 'null', '-',
  ], { allowFail: true });

  const blacks = [...stderr.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)\s+black_duration:([\d.]+)/g)]
    .map((m) => ({ start: +m[1], end: +m[2], dur: +m[3] }));
  const freezes = [...stderr.matchAll(/freeze_start:\s*([\d.]+)/g)].map((m) => +m[1]);
  const loudness = [...stderr.matchAll(/I:\s*(-?[\d.]+)\s*LUFS/g)].map((m) => +m[1]);
  const peaks = [...stderr.matchAll(/Peak:\s*(-?[\d.]+)\s*dBFS/g)].map((m) => +m[1]);
  const I = loudness.length ? loudness[loudness.length - 1] : null;
  const TP = peaks.length ? peaks[peaks.length - 1] : null;

  checks.push({ name: '时长', ok: !!duration && (!expect.duration || Math.abs(duration - expect.duration) < 1.5), detail: `${duration.toFixed(2)}s${expect.duration ? ` / 预期 ${expect.duration.toFixed(2)}s` : ''}` });
  checks.push({ name: '黑帧', ok: blacks.length === 0, detail: blacks.length ? blacks.map((b) => `${b.start.toFixed(1)}s(${b.dur.toFixed(2)}s)`).join(', ') : '无' });
  checks.push({ name: '冻帧', ok: freezes.length === 0, detail: freezes.length ? `${freezes.length} 处` : '无' });
  // 两遍 loudnorm 之后误差能压到 0.5 LU 以内，所以容差收紧到 1.0，坏了才看得见
  checks.push({ name: '响度', ok: I !== null && Math.abs(I + 14) <= 1.0, detail: I !== null ? `${I} LUFS（目标 -14）` : '未测到' });
  checks.push({ name: '真峰值', ok: TP !== null && TP <= -1.0, detail: TP !== null ? `${TP} dBTP` : '未测到' });
  checks.push({ name: '音轨', ok: !!a.codec_name, detail: a.codec_name ? `${a.codec_name} ${a.channels}ch ${a.sample_rate}Hz` : '缺失' });
  checks.push({ name: '分辨率', ok: v.width === 1080 || v.width === 1920, detail: `${v.width}x${v.height} @${v.r_frame_rate}` });

  return {
    file,
    sizeMB: +(Number(info.format.size || 0) / 1048576).toFixed(2),
    duration: +duration.toFixed(2),
    video: { codec: v.codec_name, width: v.width, height: v.height, fps: v.r_frame_rate, frames: v.nb_frames },
    audio: { codec: a.codec_name, channels: a.channels, rate: a.sample_rate, bitrate: a.bit_rate },
    blackFrames: blacks, freezes, loudness: I, truePeak: TP,
    checks,
    ok: checks.every((c) => c.ok),
  };
}

/** 联系表：每 2 秒一帧拼成一张图，扫一眼代替看全片 */
export async function contactSheet(video, out, { every = 2, cols = 4 } = {}) {
  const info = await ffprobe(video);
  const dur = Number(info.format.duration || 0);
  const rows = Math.max(1, Math.ceil(dur / every / cols));
  await ffmpeg([
    '-y', '-i', video,
    '-vf', `fps=1/${every},scale=240:-1,tile=${cols}x${rows}:padding=6:margin=6:color=0x111111`,
    '-frames:v', '1', out,
  ], { allowFail: true });
  return out;
}

/** 挑一个能整除的列数，尽量不留空格子；横图少排几列，不然每格小得看不清 */
function gridCols(n, wide = false) {
  const maxCols = wide ? 2 : 4;
  for (const c of [4, 3, 2]) if (c <= maxCols && n % c === 0 && n / c <= 4) return c;
  return Math.min(maxCols, Math.ceil(Math.sqrt(n)));
}

/**
 * 原图联系表：图一生成就看一眼，别等到成片才发现某张跑题。
 * 顺序和 files 一致，从左到右、从上到下。
 */
export async function imageSheet(files, out, { cell = 360 } = {}) {
  const list = (files || []).filter(Boolean);
  if (!list.length) return null;
  const probe = await ffprobe(list[0]);
  const pv = probe.streams.find((x) => x.codec_type === 'video') || {};
  const cols = gridCols(list.length, (pv.width || 1080) > (pv.height || 1920));
  const rows = Math.ceil(list.length / cols);
  const slots = cols * rows;
  const tmp = path.join(path.dirname(out), '.sheet-src');
  await fs.rm(tmp, { recursive: true, force: true });
  await fs.mkdir(tmp, { recursive: true });
  try {
    const padH = Math.round((cell * (pv.height || 1920)) / (pv.width || 1080));
    await ffmpeg([
      '-y', '-f', 'lavfi', '-i', `color=c=0x111111:s=${cell}x${padH}:d=1`,
      '-frames:v', '1', path.join(tmp, 'pad.jpg'),
    ], { allowFail: true });
    // 用 000.jpg / 001.jpg 序列喂给 ffmpeg：顺序可控，也不依赖 Windows 上不可用的 glob
    for (let i = 0; i < slots; i++) {
      if (i < list.length) {
        await fs.copyFile(list[i], path.join(tmp, `${String(i).padStart(3, '0')}.jpg`));
      } else {
        // 空格子给纯色，别复制最后一张，会让人以为那一镜重复了
        await fs.copyFile(path.join(tmp, 'pad.jpg'), path.join(tmp, `${String(i).padStart(3, '0')}.jpg`));
      }
    }
    await ffmpeg([
      '-y', '-i', path.join(tmp, '%03d.jpg'),
      '-vf', `scale=${cell}:-1,tile=${cols}x${rows}:padding=6:margin=6:color=0x111111`,
      '-frames:v', '1', out,
    ], { allowFail: true });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
  return out;
}
