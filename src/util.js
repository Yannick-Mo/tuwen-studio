import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

/** 读 .env（不覆盖已有环境变量），没有就返回 {} */
export function loadEnv(file = '.env') {
  const out = { ...process.env };
  try {
    const raw = readFileSync(path.resolve(file), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s.startsWith('#')) continue;
      const i = s.indexOf('=');
      if (i < 0) continue;
      const k = s.slice(0, i).trim();
      const v = s.slice(i + 1).trim().replace(/^["']|["']$/g, '');
      if (!(k in out)) out[k] = v;
    }
  } catch { /* 没有 .env 就只用进程环境 */ }
  return out;
}

export const sha1 = (s) => createHash('sha1').update(s).digest('hex').slice(0, 16);

export async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

export async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

/** 运行子进程，收集 stdout/stderr（Buffer）。 */
export function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, ...opts.spawn });
    const out = [];
    const err = [];
    child.stdout?.on('data', (d) => out.push(d));
    child.stderr?.on('data', (d) => err.push(d));
    child.on('error', reject);
    child.on('close', (code) => {
      const stdout = Buffer.concat(out);
      const stderr = Buffer.concat(err).toString();
      if (code === 0 || opts.allowFail) resolve({ code, stdout, stderr });
      else reject(new Error(`${path.basename(cmd)} exited ${code}\n${stderr.slice(-3000)}`));
    });
    if (opts.stdin) {
      child.stdin.end(opts.stdin);
    }
    if (opts.onSpawn) opts.onSpawn(child);
  });
}

/** 运行 ffmpeg，失败时抛出带 stderr 的错误。 */
export async function ffmpeg(args, opts = {}) {
  return run(opts.bin || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], opts);
}

/** 运行 ffprobe，返回 JSON。 */
export async function ffprobe(file) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error', '-show_format', '-show_streams', '-of', 'json', file,
  ]);
  return JSON.parse(stdout.toString('utf8'));
}

/** 把 mp3/wav 解码成 48k / 16bit / 立体声 PCM Buffer。 */
export async function decodePcm(file, { rate = 48000, channels = 2 } = {}) {
  const { stdout } = await ffmpeg([
    '-i', file, '-vn',
    '-ac', String(channels), '-ar', String(rate),
    '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1',
  ]);
  return stdout;
}

export function wavFromPcm(pcm, { rate = 48000, channels = 2 } = {}) {
  const header = Buffer.alloc(44);
  const byteRate = rate * channels * 2;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function silencePcm(seconds, { rate = 48000, channels = 2 } = {}) {
  return Buffer.alloc(Math.max(0, Math.round(seconds * rate)) * channels * 2);
}

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function log(msg) {
  process.stdout.write(`${msg}\n`);
}

export async function readJson(p) {
  return JSON.parse(await fs.readFile(p, 'utf8'));
}

export async function writeJson(p, obj) {
  await ensureDir(path.dirname(p));
  await fs.writeFile(p, JSON.stringify(obj, null, 2), 'utf8');
}
