import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

// ── 位置：一律从「这个文件在哪」算，不从「你在哪个目录」算 ──────────
// 以前整套路径都基于 process.cwd()，导致换个目录跑 `tuwen list` 会静默返回空数组。
export const ROOT = path.resolve(import.meta.dirname, '..');
export const CACHE_ROOT = process.env.TUWEN_CACHE
  ? path.resolve(process.env.TUWEN_CACHE)
  : path.join(ROOT, '.cache');
export const PROJECTS_DIR = process.env.TUWEN_PROJECTS
  ? path.resolve(process.env.TUWEN_PROJECTS)
  : path.join(ROOT, 'projects');
export const CONFIG_DIR = process.env.TUWEN_HOME
  ? path.resolve(process.env.TUWEN_HOME)
  : path.join(os.homedir(), '.dsh', 'tuwen');
export const USER_ENV_FILE = path.join(CONFIG_DIR, '.env');
export const REPO_ENV_FILE = path.join(ROOT, '.env');

const require = createRequire(import.meta.url);
const safeRequire = (m) => { try { return require(m); } catch { return null; } };
const maybeFile = (p) => (p && existsSync(p) ? p : null);

function parseEnvFile(file) {
  const out = {};
  try {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s.startsWith('#')) continue;
      const i = s.indexOf('=');
      if (i < 0) continue;
      out[s.slice(0, i).trim()] = s.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    }
  } catch { /* 没有这个文件就当空 */ }
  return out;
}

let envCache = null;
/**
 * 配置优先级：进程环境变量 > ~/.dsh/tuwen/.env > 仓库 .env。
 * 用户级配置压过仓库级：仓库可能是别人 clone 的，自己的 key 应该放家里。
 */
export function loadEnv(file = REPO_ENV_FILE) {
  if (envCache) return envCache;
  envCache = { ...parseEnvFile(file), ...parseEnvFile(USER_ENV_FILE), ...process.env };
  return envCache;
}
/** 配置页保存之后要让当前进程看见新值 */
export function reloadEnv() { envCache = null; return loadEnv(); }

/** ffmpeg：环境变量 > 随包安装的 ffmpeg-static > PATH 里的 ffmpeg */
export function ffmpegBin() {
  const e = loadEnv();
  return maybeFile(e.FFMPEG_PATH) || maybeFile(safeRequire('ffmpeg-static')) || 'ffmpeg';
}
/** ffprobe：环境变量 > ffprobe-static > PATH */
export function ffprobeBin() {
  const e = loadEnv();
  const stat = safeRequire('ffprobe-static');
  return maybeFile(e.FFPROBE_PATH) || maybeFile(stat?.path || stat) || 'ffprobe';
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
  return run(opts.bin || ffmpegBin(), ['-hide_banner', '-loglevel', 'error', ...args], opts);
}

/** 运行 ffprobe，返回 JSON。 */
export async function ffprobe(file) {
  const { stdout } = await run(ffprobeBin(), [
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
