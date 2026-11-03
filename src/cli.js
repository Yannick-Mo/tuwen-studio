#!/usr/bin/env node
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { normalizeProject, toStageProject } from './schema.js';
import { buildTimeline, applyTimeline } from './timeline.js';
import { synthesizeAll, alignWords } from './tts.js';
import {
  prepareVoices, buildVoiceTrack, mixAudio, mux,
  encodeParallel, encodeRange, concatSegments,
} from './encode.js';
import { renderMusic, ensureSfx } from './synth.js';
import { openStage, mount, grabFrame } from './stage.js';
import { pickImages, generateOne, ensureCharacterSheets } from './images.js';
import { qcReport, contactSheet, imageSheet } from './qc.js';
import { makeCover, pickCoverScene } from './cover.js';
import { ensureDir, exists, loadEnv, decodePcm, log, writeJson, sha1 } from './util.js';
import { DEMO, buildProject, withSubjects } from './demo.js';
import { buildStoryboard, formatStoryboard, measureVoices } from './plan.js';

const t0 = Date.now();
const el = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

function finalizeCaptions(project, timeline, prepared) {
  project.scenes.forEach((s, i) => {
    const t = timeline.scenes[i];
    const v = prepared.get(s.id);
    const dur = v ? v.duration : 3;
    const words = alignWords(s.narration, dur, v?.words);
    const offset = t.voiceStart - t.start;
    const first = words[0]?.start ?? 0;
    const last = words.at(-1)?.end ?? dur;
    s.captions = [{
      text: s.narration,
      start: Math.max(0, +(offset + first - 0.08).toFixed(3)),
      end: +(offset + last + 0.16).toFixed(3),
      words: words.map((w) => ({ ...w, start: +(offset + w.start).toFixed(3), end: +(offset + w.end).toFixed(3) })),
      emphasis: [],
    }];
  });
}

/** 重渲前把上一版成片挪进 out/history/，只留最近 5 个 */
async function archivePrevious(outDir, id) {
  const mp4 = path.join(outDir, `${id}.mp4`);
  if (!(await exists(mp4))) return null;
  const hist = path.join(outDir, 'history');
  await ensureDir(hist);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dst = path.join(hist, `${stamp}.mp4`);
  await fs.copyFile(mp4, dst);
  const files = (await fs.readdir(hist)).filter((f) => f.endsWith('.mp4')).sort();
  while (files.length > 5) {
    await fs.rm(path.join(hist, files.shift()), { force: true });
  }
  return dst;
}

/** 每渲一版就在 versions.json 里记一笔，方便「回到上一版」 */
async function recordVersion(outDir, entry) {
  const f = path.join(outDir, 'versions.json');
  let list = [];
  try { list = JSON.parse(await fs.readFile(f, 'utf8')); } catch { list = []; }
  list.push(entry);
  while (list.length > 20) list.shift();
  await writeJson(f, list);
}

/** 每镜一个渲染指纹：这一镜的时间轴/字幕/图层/图片。只有它变了，这一镜才重渲 */
async function renderFingerprint(project, stageProject, imgDir) {
  // 用图片内容而不是修改时间：缓存命中时会把文件重新拷一遍，mtime 每次都变
  const out = [];
  for (const [i, s] of project.scenes.entries()) {
    const buf = await fs.readFile(path.join(imgDir, `${s.id}.jpg`)).catch(() => null);
    out.push(sha1(`${JSON.stringify(stageProject.scenes[i] || {})}|${buf ? sha1(buf) : 0}`));
  }
  return out;
}

async function runDemo(demo, opts = {}) {
  const dir = path.resolve('projects', demo.id);
  const imgDir = path.join(dir, 'img');
  const voiceDir = path.join(dir, 'voice');
  const workDir = path.join(dir, 'work');
  const outDir = path.join(dir, 'out');
  const segDir = path.join(workDir, 'seg');
  for (const d of [imgDir, voiceDir, workDir, outDir, segDir, path.join(dir, 'assets')]) await ensureDir(d);

  const project = normalizeProject(buildProject(demo, { assetBase: `/projects/${demo.id}` }));
  const { width, height } = { width: project.meta.size[0], height: project.meta.size[1] };

  log(`\n▸ 项目 ${demo.id}  ${width}x${height} @${project.meta.fps}fps`);

  const stage = await openStage({ width, height });
  try {
    // ① 画面
    log(`\n① 画面`);
    const artPage = await stage.browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    await artPage.setViewportSize({ width, height });
    let sheets = new Map();
    if ((project.characters || []).length) {
      log(`  角色定妆照（${project.characters.length} 个）`);
      sheets = await ensureCharacterSheets({ project, dir, env: loadEnv() });
    }
    const imageResult = await pickImages({
      page: artPage,
      project,
      scenes: project.scenes,
      imgDir,
      sheets,
      opts: { mock: opts.mock, maxImages: opts.maxImages },
    });
    await artPage.close();
    log(`  ✓ ${imageResult.files.length} 张 → ${path.relative(process.cwd(), imgDir)}`);
    // 出图后立刻拼一张联系表：图不对题在这一步就该被发现，别等到成片
    const imagesSheet = path.join(outDir, 'images-sheet.jpg');
    await imageSheet(imageResult.files, imagesSheet);
    log(`  原图联系表 → ${path.relative(process.cwd(), imagesSheet)}`);

    // ② 配音
    log(`\n② 配音（${project.voice.name} · ${opts.engine || project.voice.engine || 'edge'}）`);
    const { voices, stats, engineUsed, fellBack } = await synthesizeAll(project, voiceDir, {
      fallback: opts.fallback, engine: opts.engine,
    });
    log(`  引擎统计：edge=${stats.edge} piper=${stats.piper} sapi=${stats.sapi} volc=${stats.volc} cache=${stats.cache}  ${el()}`);
    log(`  本片配音引擎：${engineUsed}${fellBack ? `（优化版失败已整条退回：${fellBack.slice(0, 60)}）` : ''}`);

    // ③ 时间轴
    log(`\n③ 按真实语音时长排时间轴`);
    const prepared = await prepareVoices(project, voices, workDir);
    const durations = new Map([...prepared].map(([k, v]) => [k, v.duration]));
    const timeline = buildTimeline(project, durations);
    applyTimeline(project, timeline);
    finalizeCaptions(project, timeline, prepared);
    log(`  总时长 ${timeline.totalDuration.toFixed(2)}s / ${timeline.totalFrames} 帧`);
    for (const s of timeline.scenes) log(`   · ${s.id}  ${s.start.toFixed(2)}→${s.end.toFixed(2)}s  语音 ${s.voiceDur.toFixed(2)}s`);
    // 把实际用的引擎写进项目，重渲时按这个走，不会被「当时的默认值」带跑
    project.voice.engineUsed = engineUsed;
    if (fellBack) project.voice.fellBack = fellBack;
    await writeJson(path.join(dir, 'project.json'), project);

    // ④ 渲染
    log(`\n④ 逐帧渲染`);
    let ranges = timeline.ranges;
    if (opts.frames) {
      let left = opts.frames;
      ranges = ranges.map((r) => {
        const take = Math.max(0, Math.min(left, r.toFrame - r.fromFrame));
        left -= take;
        return { ...r, toFrame: r.fromFrame + take };
      }).filter((r) => r.toFrame > r.fromFrame);
    }
    const stageProject = toStageProject(project);
    const fingerprint = await renderFingerprint(project, stageProject, imgDir);
    const concurrency = Math.max(1, Math.min(opts.jobs || 4, (os.cpus().length || 4) - 1));
    const pages = [stage.page];
    for (let i = 1; i < concurrency; i++) pages.push(await stage.makeWorker());
    for (const p of pages) await mount(p, stageProject);
    log(`  ${pages.length} 个渲染进程并行`);

    const segs = await encodeParallel(pages, ranges, project.meta.fps, segDir, (d, t) => {
      if (d % 30 === 0 || d === t) log(`   ${String(Math.round((d / t) * 100)).padStart(3)}%  ${d}/${t} 帧  ${el()}`);
    }, { fingerprints: fingerprint });
    const video = path.join(workDir, 'video.mp4');
    await concatSegments(segs, video);

    if (!opts.frames) {
      // ⑤ 音频
      log(`\n⑤ 音频（配乐 + 转场音效 + 响度归一）`);
      const voiceWav = path.join(workDir, 'voice.wav');
      const placements = await buildSfxPlacements(project, timeline);
      await buildVoiceTrack(project, timeline, prepared, voiceWav, placements);
      const bgm = path.join(dir, 'assets', 'bgm.wav');
      const style = project.audio?.bgmStyle
        || ((project.meta.template || '').includes('novel') ? 'tense' : 'calm');
      await renderMusic(bgm, timeline.totalDuration, style);
      log(`  配乐 ${style} · 音效 ${placements.length} 处`);
      const mix = path.join(workDir, 'mix.m4a');
      await mixAudio({ voiceWav, bgm, total: timeline.totalDuration, out: mix, loudness: project.audio.loudness ?? -14, bgmGain: project.audio.bgmGain ?? -13 });

      // ⑥ 成片（先把上一版存进 history，别让好的那一版被覆盖掉）
      const out = path.join(outDir, `${demo.id}.mp4`);
      const archived = await archivePrevious(outDir, demo.id);
      if (archived) log(`  上一版已归档 → ${path.relative(process.cwd(), archived)}`);
      await mux(video, mix, out);

      // ⑦ 质检
      log(`\n⑥ 质检`);
      const qc = await qcReport(out, { duration: timeline.totalDuration });
      await writeJson(path.join(outDir, 'qc.json'), qc);
      for (const c of qc.checks) log(`   ${c.ok ? '✓' : '✗'} ${c.name.padEnd(4)} ${c.detail}`);

      const sheet = path.join(outDir, 'contact-sheet.jpg');
      await contactSheet(out, sheet);

      // 封面：拿指定镜头的画面当底，压暗之后把标题放上去，比抽帧靠谱
      const coverFile = path.join(outDir, 'cover.jpg');
      const coverScene = (project.scenes || []).find((s) => s.id === project.meta.coverShot)
        || pickCoverScene(project);
      const coverSrc = coverScene ? path.join(imgDir, `${coverScene.id}.jpg`) : null;
      let coverOk = false;
      if (coverSrc && (await exists(coverSrc))) {
        try {
          const coverPage = await stage.browser.newPage();
          await makeCover(coverPage, {
            image: coverSrc,
            title: project.meta.coverTitle || project.meta.title,
            kicker: project.meta.kicker || '',
            w: project.meta.size[0],
            h: project.meta.size[1],
            out: coverFile,
          });
          await coverPage.close();
          coverOk = true;
        } catch (e) {
          log(`  ! 封面生成失败：${String(e.message).slice(0, 80)}`);
        }
      }
      if (!coverOk) {
        await grabFrame(stage.page, Math.min(1400, timeline.totalDuration * 400), coverFile);
      }

      // 画面没全部用上模型，这条片子就不算成品——质检只看技术指标，看不出来
      const degraded = imageResult.stats.mode !== 'ark';
      const result = {
        ok: qc.ok && !degraded,
        id: demo.id,
        title: project.meta.title,
        out, cover: path.join(outDir, 'cover.jpg'), sheet, imagesSheet,
        duration: qc.duration, sizeMB: qc.sizeMB, frames: timeline.totalFrames,
        voice: stats, images: imageResult.stats, degraded, qc,
        scenes: timeline.scenes.map((s) => ({ id: s.id, start: +s.start.toFixed(2), end: +s.end.toFixed(2) })),
      };
      await writeJson(path.join(outDir, 'result.json'), result);
      await recordVersion(outDir, {
        at: new Date().toISOString(),
        duration: result.duration,
        sizeMB: result.sizeMB,
        ok: result.ok,
        degraded,
        engine: project.voice?.engineUsed || 'edge',
        scenes: project.scenes.length,
      });

      if (degraded) {
        log(`\n! 画面降级（mode=${imageResult.stats.mode}）：技术指标合格，但画面不是全模型出的，不算成品`);
      }

      log(`\n✓ 成片 ${path.relative(process.cwd(), out)}  ${qc.sizeMB}MB  ${qc.duration}s  ${el()}`);
      log(`  封面 ${path.relative(process.cwd(), path.join(outDir, 'cover.jpg'))}`);
      log(`  联系表 ${path.relative(process.cwd(), sheet)}`);
      return result;
    } else {
      log(`\n✓ 采样渲染完成（${opts.frames} 帧）→ ${path.relative(process.cwd(), video)}`);
      return { ok: true, id: demo.id, sample: path.relative(process.cwd(), video) };
    }
  } finally {
    await stage.close();
  }
}

async function renderProject(projectFile, opts = {}) {
  const raw = JSON.parse(await fs.readFile(projectFile, 'utf8'));
  const project = normalizeProject(raw);
  const dir = path.dirname(path.resolve(projectFile));
  const workDir = path.join(dir, 'work');
  await ensureDir(workDir);
  const { width, height } = { width: project.meta.size[0], height: project.meta.size[1] };

  log(`\n▸ 渲染 ${project.id}  ${width}x${height}  ${project.scenes.length} 镜`);

  // 已有 audio.duration 则直接用；否则合成
  const needTts = project.scenes.some((s) => !s.audio?.duration);
  let prepared = new Map();
  const voiceDir = path.join(dir, 'voice');
  if (needTts) {
    log('  配音中…');
    const { voices } = await synthesizeAll(project, voiceDir, { fallback: opts.fallback });
    prepared = await prepareVoices(project, voices, workDir);
  } else {
    const { decodePcm } = await import('./util.js');
    for (const s of project.scenes) {
      const pcm = await decodePcm(path.resolve(dir, s.audio.src), { rate: 48000, channels: 2 });
      prepared.set(s.id, { pcm, duration: pcm.length / (48000 * 4) });
    }
  }

  const durations = new Map([...prepared].map(([k, v]) => [k, v.duration]));
  const timeline = buildTimeline(project, durations);
  applyTimeline(project, timeline);
  finalizeCaptions(project, timeline, prepared);

  const stage = await openStage({ width, height });
  try {
    const stageProject = toStageProject(project);
    const fingerprint = await renderFingerprint(project, stageProject, path.join(dir, 'img'));
    const concurrency = Math.max(1, Math.min(opts.jobs || 4, (os.cpus().length || 4) - 1));
    const pages = [stage.page];
    for (let i = 1; i < concurrency; i++) pages.push(await stage.makeWorker());
    for (const p of pages) await mount(p, stageProject);
    const segs = await encodeParallel(pages, timeline.ranges, project.meta.fps, path.join(workDir, 'seg'), (d, t) => {
      if (d % 60 === 0 || d === t) log(`   ${String(Math.round((d / t) * 100)).padStart(3)}%`);
    }, { fingerprints: fingerprint });
    const video = path.join(workDir, 'video.mp4');
    await concatSegments(segs, video);
    const voiceWav = path.join(workDir, 'voice.wav');
    await buildVoiceTrack(project, timeline, prepared, voiceWav);
    const bgm = project.audio?.bgm ? path.resolve(dir, project.audio.bgm) : null;
    const mix = path.join(workDir, 'mix.m4a');
    await mixAudio({ voiceWav, bgm, total: timeline.totalDuration, out: mix, loudness: project.audio.loudness ?? -14, bgmGain: project.audio.bgmGain ?? -13 });
    const out = path.join(dir, 'out', `${project.id}.mp4`);
    await ensureDir(path.dirname(out));
    await mux(video, mix, out);
    const qc = await qcReport(out, { duration: timeline.totalDuration });
    log(`\n✓ ${out}  ${qc.sizeMB}MB  ${qc.duration}s`);
  } finally {
    await stage.close();
  }
}

/** 改一镜：重出这张图 → 只重渲这一段 → 重拼 → 重封装。不动其它镜头，也不重新配音。 */
async function rerenderScene(projectFile, opts = {}) {
  const file = path.resolve(projectFile);
  const dir = path.dirname(file);
  const project = normalizeProject(JSON.parse(await fs.readFile(file, 'utf8')));
  const fps = project.meta.fps;
  const idx = project.scenes.findIndex((s) => s.id === opts.id);
  if (idx < 0) throw new Error(`没有 id 为 ${opts.id} 的镜头`);
  const scene = project.scenes[idx];
  if (scene.start == null) throw new Error('这个项目还没排过时间轴，先完整跑一次 build');

  const segDir = path.join(dir, 'work', 'seg');
  const segFile = path.join(segDir, `seg_${String(idx).padStart(3, '0')}.mp4`);
  const mixFile = path.join(dir, 'work', 'mix.m4a');
  if (!(await exists(segFile))) throw new Error('缺少分段文件，先完整跑一次 build');
  if (!(await exists(mixFile))) throw new Error('缺少混音文件，先完整跑一次 build');

  // ① 图：换文件 / 重出 / 不动
  let image = null;
  if (opts.image) {
    const dst = path.join(dir, 'img', `${scene.id}.jpg`);
    await fs.copyFile(path.resolve(opts.image), dst);
    image = { mode: 'file', file: dst };
  } else if (!opts.noImage) {
    let sheets = null;
    if ((scene.cast || []).length) {
      sheets = await ensureCharacterSheets({ project, dir, env: loadEnv() });
    }
    // --prompt 改的是「画面描述」这一段，不是整段提示词：
    // 景别、人物、参考图映射、负向词仍然照常拼进去，否则一致性立刻崩。
    if (opts.prompt) scene.visual = { ...(scene.visual || {}), subject: opts.prompt };
    image = await generateOne({
      project, scene, index: idx,
      imgDir: path.join(dir, 'img'),
      seed: opts.seed, sheets,
    });
    image.mode = 'ark';
  }

  // ② 这一段的范围（下一镜的起点就是本段的终点）
  const fromFrame = Math.round(scene.start * fps);
  const toFrame = idx < project.scenes.length - 1
    ? Math.round(project.scenes[idx + 1].start * fps)
    : (project.timeline?.totalFrames ?? Math.round((scene.start + scene.duration) * fps));

  // ③ 只渲这一段（仍然挂载整条时间轴，转场才接得上）
  const [width, height] = project.meta.size;
  const stage = await openStage({ width, height });
  try {
    await mount(stage.page, toStageProject(project));
    await encodeRange(stage.page, { index: idx, fromFrame, toFrame }, fps, segFile, null);
  } finally {
    await stage.close();
  }

  // ④ 重拼 + 重封装
  const names = (await fs.readdir(segDir)).filter((f) => /^seg_\d+\.mp4$/.test(f)).sort();
  const video = path.join(dir, 'work', 'video.mp4');
  await concatSegments(names.map((f) => path.join(segDir, f)), video);
  const out = path.join(dir, 'out', `${project.id}.mp4`);
  await mux(video, mixFile, out);

  // ⑤ 写回 project.json（下次整体重跑也能复现这张图）
  await writeJson(file, project);

  const qc = await qcReport(out, { duration: project.timeline?.totalDuration });
  const resultPath = path.join(dir, 'out', 'result.json');
  try {
    const r = JSON.parse(await fs.readFile(resultPath, 'utf8'));
    r.sizeMB = qc.sizeMB;
    r.qc = qc;
    r.lastSceneRender = { scene: scene.id, at: new Date().toISOString(), image: image?.mode || 'unchanged' };
    await writeJson(resultPath, r);
  } catch { /* 没有旧结果就算了 */ }

  return {
    ok: qc.ok, scene: scene.id, frames: toFrame - fromFrame,
    out, image, qc,
  };
}

/** 转场配什么音效：kind / 提前多少秒 / 增益 */
const SFX_RULES = {
  'zoom-blur': ['riser', 0.45, 0.30],
  'whip-pan': ['whoosh', 0.12, 0.42],
  wipe: ['whoosh', 0.08, 0.45],
  flash: ['boom', 0, 0.6],
  crossfade: ['pop', 0, 0.28],
};

async function buildSfxPlacements(project, timeline) {
  const lib = await ensureSfx(path.resolve('.cache/sfx'));
  const decoded = new Map();
  const placements = [];
  for (let i = 0; i < timeline.scenes.length - 1; i++) {
    const tr = project.scenes[i].transitionOut;
    const rule = tr && SFX_RULES[tr.type];
    if (!rule) continue;
    const [kind, lead, gain] = rule;
    if (!decoded.has(kind)) decoded.set(kind, await decodePcm(lib[kind], { rate: 48000, channels: 2 }));
    placements.push({ pcm: decoded.get(kind), at: Math.max(0, timeline.scenes[i + 1].start - lead), gain });
  }
  return placements;
}

/** 只取静帧：审片、挑封面、给 Agent 看画面是否对 */
async function framesFor(projectFile, times) {
  const dir = path.dirname(path.resolve(projectFile));
  const project = normalizeProject(JSON.parse(await fs.readFile(projectFile, 'utf8')));
  const { width, height } = { width: project.meta.size[0], height: project.meta.size[1] };
  const stage = await openStage({ width, height });
  try {
    await mount(stage.page, toStageProject(project));
    const outDir = path.join(dir, 'out', 'frames');
    await ensureDir(outDir);
    const files = [];
    for (const t of times) {
      const f = path.join(outDir, `t${t.toFixed(2).replace('.', '_')}.jpg`);
      await grabFrame(stage.page, t * 1000, f);
      files.push({ t, file: f });
    }
    return files;
  } finally {
    await stage.close();
  }
}

async function listProjects() {
  const root = path.resolve('projects');
  const rows = [];
  const dirs = await fs.readdir(root).catch(() => []);
  for (const d of dirs) {
    const p = path.join(root, d, 'project.json');
    if (!(await exists(p))) continue;
    const j = JSON.parse(await fs.readFile(p, 'utf8'));
    const out = path.join(root, d, 'out', `${j.id}.mp4`);
    rows.push({
      id: j.id,
      title: j.meta?.title,
      scenes: j.scenes?.length ?? 0,
      duration: j.timeline?.totalDuration ? +j.timeline.totalDuration.toFixed(2) : null,
      out: (await exists(out)) ? out : null,
    });
  }
  return rows;
}

const [, , cmd, ...rest] = process.argv;
const args = Object.fromEntries(rest.filter((a) => a.startsWith('--')).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v === undefined ? true : v];
}));
const positional = rest.filter((a) => !a.startsWith('--'));

try {
  if (cmd === 'demo') {
    const r = await runDemo(withSubjects(DEMO), {
      fallback: !!args.fallback,
      frames: args.frames ? Number(args.frames) : 0,
      jobs: args.jobs ? Number(args.jobs) : 0,
      mock: !!args.mock,
    });
    if (args.json) console.log(JSON.stringify(r));
  } else if (cmd === 'plan') {
    if (!positional[0]) throw new Error('用法: tuwen plan <spec.json> [--json] [--fast]');
    const spec = JSON.parse(await fs.readFile(positional[0], 'utf8'));
    if (!spec.id) spec.id = path.basename(positional[0], '.json');
    // 默认真跑一遍配音量时长（本地、免费、有缓存）；--fast 跳过，退回字数估算
    const voices = args.fast ? null : await measureVoices(spec, { fallback: !!args.fallback, engine: args.engine });
    const sb = buildStoryboard(spec, { voices });
    const dir = path.resolve('projects', spec.id);
    await ensureDir(dir);
    await writeJson(path.join(dir, 'storyboard.json'), sb);
    await fs.writeFile(path.join(dir, 'storyboard.md'), `${formatStoryboard(sb)}\n`, 'utf8');
    console.log(args.json ? JSON.stringify(sb) : formatStoryboard(sb));
    if (!sb.ok) process.exitCode = 2;
  } else if (cmd === 'build') {
    if (!positional[0]) throw new Error('用法: tuwen build <spec.json> [--yes]');
    const specPath = positional[0];
    const spec = JSON.parse(await fs.readFile(specPath, 'utf8'));
    if (!spec.id) spec.id = path.basename(specPath, '.json');

    // 先出分镜表：这一步不花钱
    const voices = args.fast ? null : await measureVoices(spec, { fallback: !!args.fallback, engine: args.engine });
    const sb = buildStoryboard(spec, { voices });
    const dir = path.resolve('projects', spec.id);
    await ensureDir(dir);
    await writeJson(path.join(dir, 'storyboard.json'), sb);
    await fs.writeFile(path.join(dir, 'storyboard.md'), `${formatStoryboard(sb)}\n`, 'utf8');

    if (!args.yes) {
      console.log(formatStoryboard(sb));
      console.log('\n— 分镜表已存到 projects/' + spec.id + '/storyboard.md');
      console.log('— 到这里一分钱没花。确认后加 --yes 重新运行，才会真正出图。');
      process.exitCode = 2;
    } else {
      if (!sb.ok) throw new Error(`分镜表有问题，先改 spec：\n${sb.problems.map((p) => `- ${p}`).join('\n')}`);
      const r = await runDemo(spec, {
        fallback: !!args.fallback,
        engine: args.engine,
        jobs: args.jobs ? Number(args.jobs) : 0,
        mock: !!args.mock,
        specPath,
      });
      if (args.json) console.log(JSON.stringify(r));
    }
  } else if (cmd === 'scene') {
    if (!positional[0]) throw new Error('用法: tuwen scene <project.json> --id=s3 [--prompt="..."] [--seed=123] [--image=path] [--no-image]');
    const id = args.id || positional[1];
    if (!id) throw new Error('要指定 --id=<镜头 id>，例如 --id=s3');
    const r = await rerenderScene(positional[0], {
      id,
      prompt: args.prompt ? String(args.prompt) : null,
      seed: args.seed !== undefined ? Number(args.seed) : null,
      image: args.image ? String(args.image) : null,
      noImage: !!(args['no-image'] || args.noImage),
    });
    console.log(JSON.stringify(r));
  } else if (cmd === 'frames') {
    if (!positional[0]) throw new Error('用法: tuwen frames <project.json> --times=1,3.5,6');
    const times = String(args.times || '1,3,5').split(',').map(Number).filter((n) => Number.isFinite(n) && n >= 0);
    const files = await framesFor(path.resolve(positional[0]), times);
    console.log(JSON.stringify({ ok: true, frames: files }));
  } else if (cmd === 'studio') {
    const { startStudio } = await import('./studio.js');
    const s = await startStudio({ port: args.port ? Number(args.port) : 7788 });
    console.log(`\n▸ 工作台已启动：${s.url}`);
    console.log('  浏览器打开它，就能点分镜、看成片、改提示词、只重渲一镜。Ctrl+C 结束。');
  } else if (cmd === 'list') {
    console.log(JSON.stringify(await listProjects()));
  } else if (cmd === 'render') {
    if (!positional[0]) throw new Error('用法: tuwen render <project.json>');
    await renderProject(positional[0], { fallback: !!args.fallback, jobs: args.jobs ? Number(args.jobs) : 0 });
  } else {
    console.log(`图文视频工坊 · 内核引擎

  node src/cli.js demo                    跑内置示例（知识科普 · 9:16）
  node src/cli.js plan <spec.json>        只出分镜表，不花钱（先看再拍）
  node src/cli.js build <spec.json>       出分镜表并停下（加 --yes 才真正出图）
  node src/cli.js scene <p.json> --id=s3  只改一镜（重出图 + 只重渲这一段）
  node src/cli.js render <project.json>   只重渲已有项目（图/音已就绪）
  node src/cli.js frames <p.json> --times=1,3.5   取静帧审片
  node src/cli.js studio                  打开本地工作台（分镜 / 预览 / 单镜重渲）
  node src/cli.js list                    列出项目

  选项：--jobs=4 并行进程数  --fallback 强制本地 SAPI 配音  --mock 用占位图  --json 输出机器可读结果
        plan/build 加 --fast 则分镜表用字数估算，不真跑配音量时长
        scene 子命令：--prompt="新的画面描述"  --seed=123  --image=本地图片 --no-image 只重渲不改图`);
  }
} catch (err) {
  console.error(`\n✗ ${err.message}`);
  if (args.json) console.log(JSON.stringify({ ok: false, error: err.message }));
  process.exitCode = 1;
}
