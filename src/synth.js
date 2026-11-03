/**
 * 程序化音频：配乐和音效全部本地合成，不依赖任何素材库，没有版权问题。
 * 目标不是「好听的音乐」，而是「不抢人声、有节奏、比 drone 强」的底子。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureDir } from './util.js';

const SR = 48000;

const SEMI = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
export function noteFreq(name) {
  const m = /^([A-G])(#|b)?(-?\d)$/.exec(name);
  if (!m) throw new Error(`无效音名 ${name}`);
  const semi = SEMI[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  return 440 * Math.pow(2, (semi + (+m[3] + 1) * 12 - 69) / 12);
}

/** 极简双二阶带通，用于噪声塑形（扫频时每 64 采样重算一次系数） */
function makeBandpass(fs) {
  let b0 = 0, b1 = 0, b2 = 0, a1 = 0, a2 = 0, x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  function set(f, q) {
    const w0 = (2 * Math.PI * f) / fs;
    const alpha = Math.sin(w0) / (2 * q);
    const cos = Math.cos(w0);
    const a0 = 1 + alpha;
    b0 = alpha / a0; b1 = 0; b2 = -alpha / a0;
    a1 = (-2 * cos) / a0; a2 = (1 - alpha) / a0;
  }
  function run(x) {
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    return y;
  }
  return { set, run };
}

function rand(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296 * 2 - 1; };
}

function adsr(t, dur, { a = 0.02, d = 0.1, s = 0.7, r = 0.3 } = {}) {
  if (t < 0 || t > dur) return 0;
  if (t < a) return t / a;
  if (t < a + d) return 1 - (1 - s) * ((t - a) / d);
  if (t > dur - r) return s * Math.max(0, (dur - t) / r);
  return s;
}

function addVoice(buf, startSec, freq, durSec, gain, shape, { wave = 'sine' } = {}) {
  const start = Math.round(startSec * SR);
  const n = Math.round(durSec * SR);
  for (let i = 0; i < n; i++) {
    const idx = start + i;
    if (idx >= buf.length) break;
    const t = i / SR;
    const env = adsr(t, durSec, shape);
    if (env <= 0) continue;
    const ph = 2 * Math.PI * freq * t;
    let v = Math.sin(ph);
    if (wave === 'warm') v = Math.sin(ph) * 0.72 + Math.sin(ph * 2) * 0.18 + Math.sin(ph * 3) * 0.06;
    buf[idx] += v * env * gain;
  }
}

const PROG = {
  calm: [
    { bass: 'A2', chord: ['A3', 'C4', 'E4'], arp: ['A4', 'C5', 'E5', 'C5'] },
    { bass: 'F2', chord: ['F3', 'A3', 'C4'], arp: ['F4', 'A4', 'C5', 'A4'] },
    { bass: 'C3', chord: ['C4', 'E4', 'G4'], arp: ['E4', 'G4', 'C5', 'G4'] },
    { bass: 'G2', chord: ['G3', 'B3', 'D4'], arp: ['G4', 'B4', 'D5', 'B4'] },
  ],
  tense: [
    { bass: 'A1', chord: ['A3', 'C4', 'E4'], arp: ['A4', 'E5', 'C5', 'A4'] },
    { bass: 'A1', chord: ['A3', 'C4', 'F4'], arp: ['F4', 'C5', 'A4', 'F4'] },
    { bass: 'G1', chord: ['G3', 'B3', 'D4'], arp: ['G4', 'D5', 'B4', 'G4'] },
    { bass: 'F1', chord: ['F3', 'A3', 'C4'], arp: ['F4', 'C5', 'A4', 'F4'] },
  ],
  // 明亮上行：励志、爽点、结题
  uplift: [
    { bass: 'C2', chord: ['C4', 'E4', 'G4'], arp: ['G4', 'C5', 'E5', 'C5'] },
    { bass: 'G2', chord: ['G3', 'B3', 'D4'], arp: ['D4', 'G4', 'B4', 'G4'] },
    { bass: 'A2', chord: ['A3', 'C4', 'E4'], arp: ['E4', 'A4', 'C5', 'A4'] },
    { bass: 'F2', chord: ['F3', 'A3', 'C4'], arp: ['C4', 'F4', 'A4', 'F4'] },
  ],
  // 悬疑：小调下行，低音更重
  mystery: [
    { bass: 'D2', chord: ['D3', 'F3', 'A3'], arp: ['A4', 'D5', 'F5', 'D5'] },
    { bass: 'B1', chord: ['B2', 'D3', 'F3'], arp: ['F4', 'B4', 'D5', 'B4'] },
    { bass: 'G1', chord: ['G3', 'B3', 'D4'], arp: ['D4', 'G4', 'B4', 'G4'] },
    { bass: 'A1', chord: ['A3', 'C4', 'E4'], arp: ['E4', 'A4', 'C5', 'A4'] },
  ],
  // 轻快跳跃：搞笑、日常
  funny: [
    { bass: 'C3', chord: ['C4', 'E4', 'G4'], arp: ['C5', 'E5', 'G5', 'E5'] },
    { bass: 'A2', chord: ['A3', 'C4', 'E4'], arp: ['A4', 'C5', 'E5', 'C5'] },
    { bass: 'F2', chord: ['F3', 'A3', 'C4'], arp: ['F4', 'A4', 'C5', 'A4'] },
    { bass: 'G2', chord: ['G3', 'B3', 'D4'], arp: ['G4', 'B4', 'D5', 'B4'] },
  ],
  // 温暖：叙事、回忆、情感
  warm: [
    { bass: 'F2', chord: ['F3', 'A3', 'C4'], arp: ['A4', 'C5', 'F5', 'C5'] },
    { bass: 'C3', chord: ['C4', 'E4', 'G4'], arp: ['E4', 'G4', 'C5', 'G4'] },
    { bass: 'D3', chord: ['D4', 'F4', 'A4'], arp: ['F4', 'A4', 'D5', 'A4'] },
    { bass: 'B2', chord: ['B3', 'D4', 'F4'], arp: ['D4', 'F4', 'B4', 'F4'] },
  ],
};

/** 每套配乐自己的速度：太快像片头，太慢像葬礼 */
export const BGM_BPM = { calm: 76, tense: 68, uplift: 84, mystery: 62, funny: 100, warm: 72 };

/**
 * 生成一段可循环的底乐：pad + 琶音 + 低音，带淡入淡出。
 * BPM 76，4 拍一小节，四小节一个循环。
 */
export function synthMusic({ seconds, style = 'calm' }) {
  const bpm = BGM_BPM[style] || 76;
  const beat = 60 / bpm;
  const bar = beat * 4;
  const prog = PROG[style] || PROG.calm;
  const total = Math.max(bar * 4, Math.ceil(seconds / (bar * 4)) * bar * 4);
  const n = Math.round(total * SR);
  const L = new Float32Array(n);
  const R = new Float32Array(n);

  for (let b = 0; b * bar < total; b++) {
    const ch = prog[b % prog.length];
    const t0 = b * bar;
    // pad：整小节铺底
    for (const name of ch.chord) {
      const f = noteFreq(name);
      addVoice(L, t0, f * 0.9985, bar * 1.02, 0.085, { a: bar * 0.25, d: 0.4, s: 0.75, r: bar * 0.5 }, { wave: 'warm' });
      addVoice(R, t0, f * 1.0015, bar * 1.02, 0.085, { a: bar * 0.25, d: 0.4, s: 0.75, r: bar * 0.5 }, { wave: 'warm' });
    }
    // 低音：每小节两下
    addVoice(L, t0, noteFreq(ch.bass), beat * 1.8, 0.155, { a: 0.02, d: 0.25, s: 0.55, r: 0.6 });
    addVoice(R, t0, noteFreq(ch.bass), beat * 1.8, 0.155, { a: 0.02, d: 0.25, s: 0.55, r: 0.6 });
    addVoice(L, t0 + beat * 2, noteFreq(ch.bass), beat * 1.6, 0.105, { a: 0.02, d: 0.25, s: 0.5, r: 0.6 });
    addVoice(R, t0 + beat * 2, noteFreq(ch.bass), beat * 1.6, 0.105, { a: 0.02, d: 0.25, s: 0.5, r: 0.6 });
    // 琶音：八分音符
    for (let k = 0; k < 8; k++) {
      const name = ch.arp[k % ch.arp.length];
      const f = noteFreq(name);
      const g = k % 2 === 0 ? 0.115 : 0.08;
      const pan = k % 2 === 0 ? 0.72 : 0.28;
      addVoice(L, t0 + k * beat * 0.5, f, beat * 0.55, g * (1 - pan + 0.35), { a: 0.004, d: 0.12, s: 0.25, r: 0.35 });
      addVoice(R, t0 + k * beat * 0.5, f, beat * 0.55, g * (pan + 0.35), { a: 0.004, d: 0.12, s: 0.25, r: 0.35 });
    }
  }

  // 一点反馈延迟当混响，避免干瘪
  const dly = Math.round(0.11 * SR);
  for (let i = dly; i < n; i++) {
    L[i] += L[i - dly] * 0.26;
    R[i] += R[i - Math.round(dly * 1.17)] * 0.24;
  }

  // 淡入淡出
  const fin = Math.round(1.2 * SR);
  const fout = Math.round(Math.min(2.4, total * 0.15) * SR);
  for (let i = 0; i < fin && i < n; i++) { L[i] *= i / fin; R[i] *= i / fin; }
  for (let i = 0; i < fout && i < n; i++) { const k = 1 - i / fout; L[n - 1 - i] *= k; R[n - 1 - i] *= k; }

  return trimTo({ L, R, total }, seconds);
}

function trimTo(buf, seconds) {
  const n = Math.min(buf.L.length, Math.round(seconds * SR));
  return { L: buf.L.subarray(0, n), R: buf.R.subarray(0, n), total: n / SR };
}

/** 音效：whoosh / boom / riser / tick / pop */
export function synthSfx(kind) {
  const spec = {
    whoosh: { dur: 0.55, gain: 0.55 },
    boom: { dur: 0.95, gain: 0.75 },
    riser: { dur: 1.0, gain: 0.5 },
    tick: { dur: 0.06, gain: 0.3 },
    pop: { dur: 0.12, gain: 0.45 },
  }[kind];
  if (!spec) throw new Error(`未知音效 ${kind}`);

  const n = Math.round(spec.dur * SR);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const noise = rand(0x9e3779b9 + kind.length);
  const bp = makeBandpass(SR);

  if (kind === 'whoosh' || kind === 'riser') {
    for (let i = 0; i < n; i++) {
      const p = i / n;
      if (i % 64 === 0) {
        const f = kind === 'riser' ? 260 + 6200 * p * p : 340 + 2600 * Math.sin(Math.PI * p) - 120 * p;
        bp.set(f, kind === 'riser' ? 2.2 : 1.4);
      }
      const env = kind === 'riser' ? Math.pow(p, 1.7) : Math.sin(Math.PI * p) ** 1.3;
      const v = bp.run(noise()) * env * spec.gain;
      L[i] = v; R[i] = v * 0.92;
    }
  } else if (kind === 'boom') {
    const low = makeBandpass(SR);
    low.set(90, 0.9);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const p = t / spec.dur;
      const f = 92 * Math.exp(-2.2 * p) + 38;
      const body = Math.sin(2 * Math.PI * f * t) * Math.exp(-4.2 * p);
      const crack = low.run(noise()) * Math.exp(-16 * p) * 0.35;
      const v = (body + crack) * spec.gain;
      L[i] = v; R[i] = v * 0.96;
    }
  } else if (kind === 'tick') {
    const hp = makeBandpass(SR);
    hp.set(4200, 1.2);
    for (let i = 0; i < n; i++) {
      const v = hp.run(noise()) * Math.exp(-70 * (i / n)) * spec.gain;
      L[i] = v; R[i] = v;
    }
  } else if (kind === 'pop') {
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const f = 300 + 260 * Math.exp(-24 * t);
      const v = Math.sin(2 * Math.PI * f * t) * Math.exp(-30 * t) * spec.gain;
      L[i] = v; R[i] = v;
    }
  }

  return { L, R, total: spec.dur };
}

/** 写成 16bit 立体声 wav */
export function writeWav(file, { L, R }) {
  const n = L.length;
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 4, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 4, 40);
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  const k = peak > 0.0001 ? Math.min(1, 0.82 / peak) : 1;
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(L[i] * k * 32767))), 44 + i * 4);
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(R[i] * k * 32767))), 46 + i * 4);
  }
  return fs.writeFile(file, buf).then(() => file);
}

/** 生成/复用音效库（全局缓存） */
export async function ensureSfx(cacheDir) {
  await ensureDir(cacheDir);
  const out = {};
  for (const kind of ['whoosh', 'boom', 'riser', 'tick', 'pop']) {
    const file = path.join(cacheDir, `${kind}.wav`);
    try { await fs.access(file); } catch { await writeWav(file, synthSfx(kind)); }
    out[kind] = file;
  }
  return out;
}

export async function renderMusic(file, seconds, style) {
  return writeWav(file, synthMusic({ seconds, style }));
}
