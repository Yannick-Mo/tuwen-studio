/**
 * 分镜表：出图之前先看清楚要花多少钱、拍成什么样。
 * 时长优先用真实配音（本地引擎免费、结果有缓存），量不出来才退回估算。
 * 只读 spec，不碰网络、不花钱——这一步慢一点，后面省得多。
 */
import path from 'node:path';
import { buildProject } from './demo.js';
import { normalizeProject } from './schema.js';
import { buildPrompt, shotFor } from './images.js';
import { buildTimeline } from './timeline.js';
import { synthesizeAll } from './tts.js';
import { prepareVoices } from './encode.js';
import { DELIVERY_LABELS } from './delivery.js';

/** 中文语速约 5 字/秒，标点略停顿。只在量不到真声音时兜底。 */
export function estimateVoiceSeconds(text) {
  const chars = [...String(text || '')].filter((c) => c.trim()).length;
  const punct = (String(text || '').match(/[，。！？、；：…—]/g) || []).length;
  return +(0.22 + chars / 5.0 + punct * 0.16).toFixed(2);
}

/** spec → 规范化的 project（不落盘） */
export function projectFromSpec(spec) {
  return normalizeProject(buildProject(spec, { assetBase: `/projects/${spec.id}` }));
}

/**
 * 真跑一遍配音，量出每一镜的真实秒数。
 * 本地引擎不花钱，结果按内容哈希缓存，第二次是纯读盘。
 * 任何一镜量不出来就整体返回 null——宁可用估算，也不给半真半假的表。
 */
export async function measureVoices(spec, opts = {}) {
  try {
    const project = projectFromSpec(spec);
    const dir = path.resolve('projects', project.id);
    const { voices } = await synthesizeAll(project, path.join(dir, 'voice'), {
      fallback: opts.fallback, quiet: true, engine: opts.engine,
    });
    // 解码一遍再量：和真正渲染走的是同一条路，差几帧都算得出来
    const prepared = await prepareVoices(project, voices, path.join(dir, 'work'));
    const map = new Map([...prepared].map(([k, v]) => [k, v.duration]));
    const complete = project.scenes.every((s) => map.get(s.id) > 0);
    return complete ? map : null;
  } catch {
    return null;
  }
}

export function buildStoryboard(spec, opts = {}) {
  const project = projectFromSpec(spec);
  const problems = [];
  const warnings = [];

  const seen = new Set();
  for (const s of project.scenes) {
    if (seen.has(s.id)) problems.push(`镜头 id 重复：${s.id}`);
    seen.add(s.id);
    if (!s.narration || !s.narration.trim()) problems.push(`${s.id} 没有旁白`);
    if (s.narration && s.narration.length > 42) warnings.push(`${s.id} 旁白 ${s.narration.length} 字，字幕大概率要折成两行`);
    for (const id of s.cast || []) {
      if (!project.characters.some((c) => c.id === id)) problems.push(`${s.id} 的 cast 引用了不存在的角色：${id}`);
    }
    if (!s.visual?.subject && !s.motif) warnings.push(`${s.id} 没有 visual.subject，出图会退化成用旁白当描述`);
  }
  if (!project.scenes.length) problems.push('没有镜头');

  // 有真实配音就用真实时长，没有再退回估算
  const measured = opts.voices || null;
  const durations = new Map(project.scenes.map((s) => [
    s.id,
    (measured && measured.get(s.id)) || estimateVoiceSeconds(s.narration),
  ]));
  const timeline = buildTimeline(project, durations);

  const rows = project.scenes.map((s, i) => {
    const shot = shotFor(s, i);
    const cast = (s.cast || []).map((id) => project.characters.find((c) => c.id === id)?.name || id);
    const t = timeline.scenes[i];
    return {
      index: i + 1,
      id: s.id,
      narration: s.narration,
      voiceSeconds: +durations.get(s.id).toFixed(2),
      shotSeconds: +(t.end - t.start).toFixed(2),
      shot: shot.text,
      framing: cast.length && !shot.custom ? shot.framing : '',
      subject: s.visual?.subject || '',
      cast,
      speaker: s.speaker
        ? (project.characters.find((c) => c.id === s.speaker)?.name || s.speaker)
        : '',
      voice: s.voice
        ? { rate: s.voice.rate || '', pitch: s.voice.pitch || '', delivery: s.voice.delivery || '', name: s.voice.name || '' }
        : null,
      transition: s.transitionOut ? `${s.transitionOut.type} ${s.transitionOut.duration}s` : '—',
      prompt: buildPrompt(project, s, i),
    };
  });

  const images = project.scenes.length;
  const sheets = project.characters.length;
  const totalSeconds = +timeline.totalDuration.toFixed(2);
  const frames = timeline.totalFrames;

  return {
    ok: problems.length === 0,
    id: project.id,
    title: project.meta.title,
    aspect: project.meta.aspect,
    scenes: rows,
    totals: {
      scenes: rows.length,
      images,
      characterSheets: sheets,
      estimatedSeconds: totalSeconds,
      durationSource: measured ? 'measured' : 'estimated',
      frames,
      estimatedMinutes: +((images * 7 + frames * 0.09 / 4) / 60).toFixed(1),
    },
    problems,
    warnings,
  };
}

/** 终端里看得下去的分镜表 */
export function formatStoryboard(sb) {
  const how = sb.totals.durationSource === 'measured' ? '实测配音' : '估算（没量到配音）';
  const lines = [];
  lines.push(`▸ ${sb.id} · ${sb.title} · ${sb.aspect}`);
  lines.push(`  ${sb.totals.scenes} 镜 / ${sb.totals.estimatedSeconds}s（${how}） / 需出图 ${sb.totals.images} 张（含 ${sb.totals.characterSheets} 张定妆照）/ 预估 ${sb.totals.estimatedMinutes} 分钟`);
  lines.push('');
  for (const r of sb.scenes) {
    const who = r.cast.length ? `  👤 ${r.cast.join(' + ')}` : '';
    const say = r.speaker ? `  🗣 ${r.speaker}` : '';
    const tone = r.voice && (r.voice.rate || r.voice.delivery)
      ? `  🎚 ${[r.voice.rate, DELIVERY_LABELS[r.voice.delivery]].filter(Boolean).join(' · ')}`
      : '';
    lines.push(`  ${String(r.index).padStart(2)}. ${r.id}  ${String(r.shotSeconds).padStart(5)}s  ${r.shot}${who}${say}${tone}`);
    lines.push(`      台词：${r.narration}（${r.voiceSeconds}s）`);
    if (r.subject) lines.push(`      画面：${r.subject}`);
    if (r.framing) lines.push(`      构图：${r.framing}`);
    if (r.transition !== '—') lines.push(`      转场：${r.transition}`);
  }
  if (sb.warnings.length) {
    lines.push('');
    for (const w of sb.warnings) lines.push(`  ! ${w}`);
  }
  if (sb.problems.length) {
    lines.push('');
    for (const p of sb.problems) lines.push(`  ✗ ${p}`);
  }
  return lines.join('\n');
}
