import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { decodePcm, wavFromPcm, ffmpeg, ensureDir, log, clamp, run } from './util.js';
import { seek, shot } from './stage.js';

const RATE = 48000;
const CH = 2;
const dbToGain = (db) => Math.pow(10, db / 20);

function writeAsync(stream, buf) {
  return new Promise((resolve, reject) => {
    const ok = stream.write(buf, (err) => (err ? reject(err) : null));
    if (ok) resolve();
    else stream.once('drain', () => resolve());
  });
}

async function encodeSegment(page, fromFrame, count, fps, file, onFrame) {
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'image2pipe', '-vcodec', 'mjpeg', '-framerate', String(fps), '-i', '-',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-r', String(fps), '-g', String(fps * 2),
    '-an', file,
  ];
  const child = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg segment ${code}\n${stderr.slice(-1500)}`))));
  });

  for (let i = 0; i < count; i++) {
    await seek(page, ((fromFrame + i) * 1000) / fps);
    const buf = await shot(page);
    await writeAsync(child.stdin, buf);
    if (onFrame) onFrame();
  }
  child.stdin.end();
  await done;
}

/** 多页并行：每镜一个渲染进程，帧管道各自灌进各自的 ffmpeg */
export async function encodeParallel(pages, ranges, fps, outDir, onProgress) {
  await ensureDir(outDir);
  const work = ranges.filter((r) => r.toFrame > r.fromFrame);
  const total = work.reduce((n, r) => n + (r.toFrame - r.fromFrame), 0);

  const groups = Array.from({ length: pages.length }, () => []);
  const loads = new Array(pages.length).fill(0);
  for (const r of work) {
    const i = loads.indexOf(Math.min(...loads));
    groups[i].push(r);
    loads[i] += r.toFrame - r.fromFrame;
  }

  let done = 0;
  await Promise.all(groups.map((g, i) => (async () => {
    for (const r of g) {
      const file = path.join(outDir, `seg_${String(r.index).padStart(3, '0')}.mp4`);
      await encodeSegment(pages[i], r.fromFrame, r.toFrame - r.fromFrame, fps, file, () => {
        done++;
        if (onProgress && (done % 30 === 0 || done === total)) onProgress(done, total);
      });
    }
  })()));

  return work.map((r) => path.join(outDir, `seg_${String(r.index).padStart(3, '0')}.mp4`));
}

export async function encodeRanges(page, ranges, fps, outDir, onProgress) {
  return encodeParallel([page], ranges, fps, outDir, onProgress);
}

/** 只编一段（改一镜时用） */
export async function encodeRange(page, range, fps, outFile, onFrame) {
  const count = range.toFrame - range.fromFrame;
  if (count <= 0) throw new Error('这一段没有帧');
  await encodeSegment(page, range.fromFrame, count, fps, outFile, onFrame);
  return outFile;
}

export async function concatSegments(files, out) {
  const list = `${out}.txt`;
  const body = files
    .map((f) => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
    .join('\n');
  await fs.writeFile(list, body, 'utf8');
  await ffmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', out]);
  return out;
}

/** 解码 + 去掉首尾静音，得到干净的人声片段 */
export function trimPcm(pcm, { threshold = 200, padMs = 40 } = {}) {
  const frameBytes = 2 * CH;
  const frames = Math.floor(pcm.length / frameBytes);
  let start = 0;
  let end = frames;
  const peak = (i) => Math.abs(pcm.readInt16LE(i * frameBytes));
  while (start < frames && peak(start) < threshold) start++;
  while (end > start && peak(end - 1) < threshold) end--;
  const pad = Math.round((padMs / 1000) * RATE);
  start = Math.max(0, start - pad);
  end = Math.min(frames, end + pad);
  return pcm.subarray(start * frameBytes, end * frameBytes);
}

export async function prepareVoices(project, voices, workDir) {
  await ensureDir(workDir);
  const out = new Map();
  for (const scene of project.scenes) {
    const v = voices.get(scene.id);
    if (!v) continue;
    const raw = await decodePcm(v.file, { rate: RATE, channels: CH });
    const pcm = trimPcm(raw);
    out.set(scene.id, {
      pcm,
      duration: pcm.length / (RATE * CH * 2),
      engine: v.engine,
      words: v.words,
      file: v.file,
    });
  }
  return out;
}

/** 把人声按时间轴摆进一条整轨（零依赖、样本级精确）；音效也混进同一条轨 */
export async function buildVoiceTrack(project, timeline, prepared, outWav, placements = []) {
  const totalSamples = Math.round(timeline.totalDuration * RATE);
  const track = Buffer.alloc(totalSamples * CH * 2);
  for (let i = 0; i < project.scenes.length; i++) {
    const s = project.scenes[i];
    const v = prepared.get(s.id);
    if (!v) continue;
    const offset = Math.round(timeline.scenes[i].voiceStart * RATE) * CH * 2;
    const len = Math.min(v.pcm.length, track.length - offset);
    if (len > 0) v.pcm.copy(track, offset, 0, len);
  }
  for (const p of placements) mixPcm(track, p.pcm, p.at, p.gain ?? 1);
  await fs.writeFile(outWav, wavFromPcm(track, { rate: RATE, channels: CH }));
  return outWav;
}

/** 把一段 16bit 立体声 PCM 叠加到轨道上（越界截断、软限幅） */
export function mixPcm(track, pcm, atSec, gain = 1) {
  const frame = CH * 2;
  const offset = Math.round(atSec * RATE) * frame;
  const frames = Math.floor(pcm.length / frame);
  for (let i = 0; i < frames; i++) {
    const j = offset + i * frame;
    if (j + frame > track.length) break;
    for (let c = 0; c < CH; c++) {
      const v = track.readInt16LE(j + c * 2) + Math.round(pcm.readInt16LE(i * frame + c * 2) * gain);
      track.writeInt16LE(Math.max(-32768, Math.min(32767, v)), j + c * 2);
    }
  }
  return track;
}

/** loudnorm 打印在 stderr 里的测量块 */
function parseLoudnorm(stderr) {
  const m = stderr.match(/\{[^{}]*"input_i"[\s\S]*?\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    if (!Number.isFinite(Number(j.input_i))) return null;
    return j;
  } catch { return null; }
}

/**
 * 两遍 loudnorm：先量，再按量出来的值做线性归一。
 * 单遍 loudnorm 是动态的，十几秒的短片根本来不及收敛——片长越短，越容易差个一两 LU。
 */
async function loudnormFilter(inputArgs, chain, loudness) {
  const measure = `loudnorm=I=${loudness}:TP=-1.5:LRA=11:print_format=json`;
  let measured = null;
  try {
    const { stderr } = await run('ffmpeg', [
      '-hide_banner', '-nostats', ...inputArgs,
      '-filter_complex', `${chain}${measure}[a]`, '-map', '[a]', '-f', 'null', '-',
    ], { allowFail: true });
    measured = parseLoudnorm(stderr);
  } catch { measured = null; }

  if (!measured) return `${chain}loudnorm=I=${loudness}:TP=-1.5:LRA=11`;
  const p = [
    `loudnorm=I=${loudness}`, 'TP=-1.5', 'LRA=11',
    `measured_I=${measured.input_i}`,
    `measured_TP=${measured.input_tp}`,
    `measured_LRA=${measured.input_lra}`,
    `measured_thresh=${measured.input_thresh}`,
    `offset=${measured.target_offset}`,
    'linear=true',
  ].join(':');
  return `${chain}${p}`;
}

export async function mixAudio({ voiceWav, bgm, total, out, loudness = -14, bgmGain = -9 }) {
  if (!bgm) {
    const chain = await loudnormFilter(['-i', voiceWav], '', loudness);
    await ffmpeg(['-y', '-i', voiceWav, '-af', chain, '-c:a', 'aac', '-b:a', '192k', '-ar', String(RATE), out]);
    return out;
  }
  const fadeSt = Math.max(0, total - 1.0);
  const pre = [
    `[1:a]volume=${dbToGain(bgmGain).toFixed(4)},atrim=0:${total.toFixed(3)},asetpts=N/SR/TB,afade=t=out:st=${fadeSt.toFixed(2)}:d=1.0[bg]`,
    `[bg][0:a]sidechaincompress=threshold=0.06:ratio=3:attack=20:release=250[duck]`,
    `[0:a][duck]amix=inputs=2:normalize=0:duration=first`,
  ].join(';');
  const inputs = ['-i', voiceWav, '-stream_loop', '-1', '-i', bgm];
  // 先量再归一：短片单遍 loudnorm 会差 1~2 LU，正好卡在合格线边上
  const chain = await loudnormFilter(inputs, `${pre},`, loudness);
  await ffmpeg(['-y', ...inputs, '-filter_complex', `${chain},aresample=${RATE}[a]`, '-map', '[a]',
    '-c:a', 'aac', '-b:a', '192k', out]);
  return out;
}

export async function mux(video, audio, out) {
  if (!audio) {
    await ffmpeg(['-y', '-i', video, '-c', 'copy', '-movflags', '+faststart', out]);
    return out;
  }
  await ffmpeg([
    '-y', '-i', video, '-i', audio,
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'copy', '-c:a', 'copy',
    '-shortest', '-movflags', '+faststart', out,
  ]);
  return out;
}

/** 生成一条低调的环境底噪（没有 BGM 素材时占位，避免干声） */
export async function synthBgm(out, seconds, { root = 110 } = {}) {
  const notes = [1, 1.5, 2.0, 2.66];
  const inputs = notes.flatMap((m) => ['-f', 'lavfi', '-i', `sine=f=${(root * m).toFixed(2)}:r=48000:d=${seconds.toFixed(2)}`]);
  const parts = notes.map((_, i) => `[${i}:a]volume=${(0.22 / (i + 1)).toFixed(3)}[v${i}]`);
  const mix = notes.map((_, i) => `[v${i}]`).join('') + `amix=inputs=${notes.length}:normalize=0,lowpass=f=900,` +
    `tremolo=f=0.12:d=0.35,aecho=0.8:0.88:1200|1800:0.22|0.12[bg]`;
  await ffmpeg(['-y', ...inputs, '-filter_complex', [...parts, mix].join(';'), '-map', '[bg]', '-c:a', 'pcm_s16le', out]);
  return out;
}
