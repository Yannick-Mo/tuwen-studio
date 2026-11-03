/**
 * TTS 层：可替换的 provider。
 * edge-tts 音质好、带词级时间戳，但会间歇性 403（微软反滥用）；
 * 所以默认「重试 + 熔断 + 本地 SAPI 兜底」，保证流水线永远能出片。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ensureDir, exists, ffprobe, run, sha1, log } from './util.js';

const CACHE_DIR = path.resolve('.cache/tts');
const BLOCK_FILE = path.resolve('.cache/edge-blocked.json');
const BLOCK_MINUTES = 15;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function edgeBlocked() {
  try {
    const j = JSON.parse(await fs.readFile(BLOCK_FILE, 'utf8'));
    return Date.now() - j.at < BLOCK_MINUTES * 60 * 1000;
  } catch { return false; }
}

async function markEdgeBlocked() {
  await ensureDir(path.dirname(BLOCK_FILE));
  await fs.writeFile(BLOCK_FILE, JSON.stringify({ at: Date.now() }), 'utf8');
}

function parseSrtWords(srt) {
  const words = [];
  const blocks = srt.replace(/\r/g, '').split(/\n\n+/);
  for (const b of blocks) {
    const lines = b.split('\n').filter(Boolean);
    if (lines.length < 2) continue;
    const m = lines.find((l) => l.includes('-->'));
    const textLines = lines.filter((l) => l !== m && !/^\d+$/.test(l));
    if (!m || !textLines.length) continue;
    const [a, b2] = m.split('-->').map((s) => s.trim());
    const toSec = (t) => {
      const [hh, mm, rest] = t.split(':');
      const [ss, ms] = rest.split(/[,.]/);
      return (+hh) * 3600 + (+mm) * 60 + (+ss) + (+(ms || 0)) / 1000;
    };
    words.push({ w: textLines.join(' ').trim(), start: toSec(a), end: toSec(b2) });
  }
  return words;
}

async function probeDuration(file) {
  const info = await ffprobe(file);
  return Number(info.format?.duration || 0);
}

async function tryEdgeOnce({ text, voice, rate, pitch, mp3, srt }) {
  const args = ['--voice', voice, '--text', text, '--rate=' + rate, '--pitch=' + pitch,
    '--write-media', mp3, '--write-subtitles', srt];
  await run('edge-tts', args, { allowFail: true });
  if (!(await exists(mp3))) return null;
  const st = await fs.stat(mp3);
  if (st.size < 2048) return null;
  const dur = await probeDuration(mp3);
  if (!(dur > 0.15)) return null;
  let words = null;
  try {
    words = parseSrtWords(await fs.readFile(srt, 'utf8'));
    if (!words.length) words = null;
  } catch { words = null; }
  return { duration: dur, words };
}

async function sapiTTS({ text, wav }) {
  const txt = wav.replace(/\.wav$/, '.txt');
  const ps1 = wav.replace(/\.wav$/, '.ps1');
  await fs.writeFile(txt, text, 'utf8');
  const script = [
    'Add-Type -AssemblyName System.Speech',
    `$t = Get-Content -Raw -Encoding UTF8 '${txt.replace(/'/g, "''")}'`,
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    "try { $s.SelectVoice('Microsoft Huihui Desktop') } catch {}",
    '$s.Rate = 1',
    `$s.SetOutputToWaveFile('${wav.replace(/'/g, "''")}')`,
    '$s.Speak($t)',
    '$s.Dispose()',
  ].join('\n');
  await fs.writeFile(ps1, script, 'utf8');
  await run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1]);
  if (!(await exists(wav))) throw new Error('SAPI 未产出音频');
  const dur = await probeDuration(wav);
  return { file: wav, duration: dur, words: null, engine: 'sapi' };
}

/** 本地神经网络 TTS（Piper）：离线、快、音质可接受，作为 edge 被墙时的主力 */
export async function piperReady(model = '.models/zh_CN-huayan-medium.onnx') {
  const p = path.resolve(model);
  return (await exists(p)) && (await exists(p + '.json'));
}

async function piperTTS({ text, wav, model, lengthScale = 1.0 }) {
  const m = path.resolve(model);
  await run('piper', ['-m', m, '-c', m + '.json', '-f', wav, '--length-scale', String(lengthScale)],
    { stdin: Buffer.from(text, 'utf8') });
  if (!(await exists(wav))) throw new Error('piper 未产出音频');
  const dur = await probeDuration(wav);
  if (!(dur > 0.15)) throw new Error('piper 音频过短');
  return { file: wav, duration: dur, words: null, engine: 'piper' };
}

export class VoiceEngine {
  constructor(voice, opts = {}) {
    this.voice = voice;
    this.edgeDead = 0;       // 连续失败次数，>=2 时熔断
    this.forceFallback = !!opts.fallback;
    this.piperModel = opts.piperModel || '.models/zh_CN-huayan-medium.onnx';
    this.engine = opts.engine || voice.engine || 'edge';
    this.volcRefs = new Map();
    this.stats = { edge: 0, piper: 0, sapi: 0, volc: 0, cache: 0 };
  }

  /** 项目级嗓子 + 镜头级覆盖，合并成这一句的实际发音参数 */
  resolveVoice(scene) {
    const v = { ...this.voice, ...(scene?.voice || {}) };
    const r = Number.parseInt(v.rate ?? '0', 10) || 0;
    v.lengthScale = v.lengthScale ?? 1 / (1 + r / 100);
    return v;
  }

  /** 同一个说话人共用一段参考音频，音色才钉得住 */
  volcKey(scene) {
    return scene.speaker || '__narrator__';
  }

  volcRefFor(scene) {
    const ref = this.volcRefs.get(this.volcKey(scene));
    return ref ? [ref] : null;
  }

  /** 第一次出声之后，把这段音频存成这个人的参考锚点 */
  async seedVolcRef(scene, file) {
    const k = this.volcKey(scene);
    if (this.volcRefs.has(k)) return;
    try {
      const buf = await fs.readFile(file);
      if (buf.length >= 2048 && buf.length <= 10 * 1024 * 1024) {
        this.volcRefs.set(k, buf.toString('base64'));
      }
    } catch { /* 读不到就不锚定，至少还能出片 */ }
  }

  async say(scene, outDir) {
    await ensureDir(outDir);
    await ensureDir(CACHE_DIR);
    const v = this.resolveVoice(scene);
    const hasRef = this.engine === 'volc' && this.volcRefs.has(this.volcKey(scene));
    const key = sha1(`${this.engine}|${v.provider}|${v.name}|${v.rate}|${v.pitch}|${scene.performance || ''}|${hasRef ? 'ref' : 'base'}|${scene.narration}`);
    const metaPath = path.join(CACHE_DIR, `${key}.json`);

    if (await exists(metaPath)) {
      try {
        const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
        if (meta.cachedFile && (await exists(meta.cachedFile))) {
          const dst = path.join(outDir, `${scene.id}${path.extname(meta.cachedFile)}`);
          await fs.copyFile(meta.cachedFile, dst);
          if (this.engine === 'volc') await this.seedVolcRef(scene, dst);
          this.stats.cache++;
          return { ...meta, file: dst };
        }
      } catch { /* 缓存坏了就重做 */ }
    }

    const produced = await this.produce(scene, outDir, v);
    if (this.engine === 'volc') await this.seedVolcRef(scene, produced.file);
    const ext = path.extname(produced.file) || '.wav';
    const cachedFile = path.join(CACHE_DIR, `${key}${ext}`);
    await fs.copyFile(produced.file, cachedFile);
    await fs.writeFile(metaPath, JSON.stringify({ ...produced, file: cachedFile, cachedFile }), 'utf8');
    return produced;
  }

  async produce(scene, outDir, v) {
    const id = scene.id;

    // 优化版：能听懂表演描述，但生成式、不确定、慢，只整条用
    if (this.engine === 'volc') {
      const { synthesizeVolc, buildVolcPrompt } = await import('./providers/volc-tts.js');
      const r = await synthesizeVolc({
        prompt: buildVolcPrompt({ performance: scene.performance, text: scene.narration }),
        references: this.volcRefFor(scene),
        // 把「+12%」这类语速统一过去，否则换了引擎语速参数就不生效
        speechRate: Math.max(-50, Math.min(100, Number.parseInt(v.rate ?? '0', 10) || 0)),
      });
      const ext = r.format === 'wav' ? 'wav' : 'mp3';
      const file = path.join(outDir, `${id}.${ext}`);
      await fs.writeFile(file, r.buffer);
      this.stats.volc++;
      return { file, duration: r.duration, words: r.words, engine: 'volc', voice: 'seed-audio' };
    }

    if (!this.forceFallback && this.edgeDead < 2 && !(await edgeBlocked())) {
      const mp3 = path.join(outDir, `${id}.mp3`);
      const srt = path.join(outDir, `${id}.srt`);
      const delays = [700, 1600, 3200, 5500];
      for (let i = 0; i < delays.length; i++) {
        try {
          const r = await tryEdgeOnce({ text: scene.narration, voice: v.name, rate: v.rate, pitch: v.pitch, mp3, srt });
          if (r) {
            this.edgeDead = 0;
            this.stats.edge++;
            return { file: mp3, duration: r.duration, words: r.words, engine: 'edge', voice: v.name };
          }
        } catch { /* retry */ }
        await sleep(delays[i] + Math.random() * 300);
      }
      this.edgeDead++;
      log(`  ! edge-tts 不可用（${this.edgeDead}），改用本地引擎`);
      if (this.edgeDead >= 2) await markEdgeBlocked();
    }

    if (await piperReady(this.piperModel)) {
      try {
        const r = await piperTTS({ text: scene.narration, wav: path.join(outDir, `${id}.wav`), model: this.piperModel, lengthScale: v.lengthScale });
        this.stats.piper++;
        return { ...r, voice: 'zh_CN-huayan' };
      } catch (e) {
        log(`  ! piper 失败：${e.message.slice(0, 120)}`);
      }
    }

    const r = await sapiTTS({ text: scene.narration, wav: path.join(outDir, `${id}.wav`) });
    this.stats.sapi++;
    return { ...r, voice: 'Huihui' };
  }
}

/** 逐句合成（顺序执行，避免触发限流） */
async function runAll(project, outDir, engine, opts) {
  const voiceEngine = new VoiceEngine(project.voice, { ...opts, engine });

  // 指定了参考音频就全场用它当锚点，比「第一句自动锚定」更稳
  if (engine === 'volc' && project.voice?.reference) {
    try {
      const buf = await fs.readFile(path.resolve(project.voice.reference));
      const b64 = buf.toString('base64');
      for (const s of project.scenes) voiceEngine.volcRefs.set(voiceEngine.volcKey(s), b64);
      voiceEngine.volcRefs.set('__narrator__', b64);
      if (!opts.quiet) log(`  · 音色锚点：${project.voice.reference}`);
    } catch {
      if (!opts.quiet) log('  ! 参考音频读不到，改用第一句自动锚定');
    }
  }

  const result = new Map();
  for (const scene of project.scenes) {
    if (scene.audio?.duration) {
      result.set(scene.id, { file: scene.audio.src, duration: scene.audio.duration, words: scene.audio.words || null, engine: 'provided' });
      continue;
    }
    const r = await voiceEngine.say(scene, outDir);
    result.set(scene.id, r);
    if (!opts.quiet) log(`  · ${scene.id}  ${r.duration.toFixed(2)}s  ${r.engine}  ${scene.narration.slice(0, 18)}`);
  }
  return { voices: result, stats: voiceEngine.stats };
}

/**
 * 引擎按「整条」决定，绝不逐句混用。
 * 优化版（volc）中途任何一句失败，就把整条丢掉重做免费版——
 * 一条片子里出现两个嗓子，比音质差一点糟糕得多。
 */
export async function synthesizeAll(project, outDir, opts = {}) {
  const wanted = opts.engine || project.voice?.engine || 'edge';

  if (wanted === 'volc') {
    try {
      const r = await runAll(project, outDir, 'volc', opts);
      return { ...r, engineUsed: 'volc' };
    } catch (e) {
      const reason = String(e.message || e).slice(0, 200);
      log(`  ! 优化版配音整条失败：${reason}`);
      log('  → 整条退回免费版（不会一条片子里混两套声音）');
      await fs.rm(outDir, { recursive: true, force: true });
      await ensureDir(outDir);
      const r = await runAll(project, outDir, 'edge', opts);
      return { ...r, engineUsed: 'edge', fellBack: reason };
    }
  }

  const r = await runAll(project, outDir, 'edge', opts);
  return { ...r, engineUsed: 'edge' };
}

/** 用真实时长给字幕分配词级时间（SAPI 等无时间戳时的兜底） */
export function alignWords(text, duration, words) {
  if (words && words.length) return words;
  const chars = [...text];
  const out = [];
  const total = chars.reduce((n, c) => n + (c === '，' || c === '。' || c === '、' ? 2.2 : 1), 0);
  let t = 0;
  for (const c of chars) {
    const wgt = c === '，' || c === '。' || c === '、' ? 2.2 : 1;
    const d = (duration * wgt) / total;
    out.push({ w: c, start: t, end: t + d });
    t += d;
  }
  return out;
}
