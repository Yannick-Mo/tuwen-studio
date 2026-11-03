/**
 * 自检：换一台机器最容易卡住的地方，这里一件一件查给你看。
 *
 * 原则：每一条失败都必须给出「下一步做什么」，而不是只抛一句「失败」。
 * 装东西这件事，用户需要的不是诊断报告，是命令。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import {
  ROOT, PROJECTS_DIR, CACHE_ROOT, CONFIG_DIR, USER_ENV_FILE, REPO_ENV_FILE,
  ffmpegBin, ffprobeBin, run, ensureDir,
} from './util.js';
import { configSummary } from './config.js';

const NODE_MIN = [20, 11]; // import.meta.dirname 从这个版本开始有

async function checkNode() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  const ok = major > NODE_MIN[0] || (major === NODE_MIN[0] && minor >= NODE_MIN[1]);
  return {
    name: 'Node',
    level: 'required',
    ok,
    detail: `v${process.versions.node}`,
    fix: ok ? '' : `升到 Node ${NODE_MIN.join('.')} 或更高：https://nodejs.org`,
  };
}

async function checkBinary(name, bin, args) {
  try {
    const { stdout } = await run(bin, args, { allowFail: true });
    const line = stdout.toString().split('\n')[0].trim();
    if (line) return { name, level: 'required', ok: true, detail: line.slice(0, 70), fix: '' };
    throw new Error('没有输出');
  } catch (e) {
    return {
      name,
      level: 'required',
      ok: false,
      detail: `找不到可用的 ${name}（${bin}）`,
      fix: `npm install（会装上 ffmpeg-static / ffprobe-static）；或设 FFMPEG_PATH/FFPROBE_PATH 指向已有的可执行文件`,
    };
  }
}

async function checkChromium() {
  try {
    const { chromium } = await import('playwright');
    const exe = chromium.executablePath();
    if (exe && existsSync(exe)) {
      return { name: 'Chromium（逐帧渲染）', level: 'required', ok: true, detail: path.basename(exe), fix: '' };
    }
    return {
      name: 'Chromium（逐帧渲染）',
      level: 'required',
      ok: false,
      detail: 'Playwright 装了，但浏览器还没下载',
      fix: 'npx playwright install chromium',
    };
  } catch (e) {
    return {
      name: 'Chromium（逐帧渲染）',
      level: 'required',
      ok: false,
      detail: `playwright 没装好：${String(e.message).slice(0, 60)}`,
      fix: 'npm install',
    };
  }
}

async function checkEdgeTTS() {
  try {
    const mod = await import('msedge-tts');
    if (typeof mod.MsEdgeTTS !== 'function') throw new Error('导出不完整');
    return { name: '配音引擎（edge）', level: 'required', ok: true, detail: '纯 Node 实现，不需要 Python', fix: '' };
  } catch (e) {
    return {
      name: '配音引擎（edge）',
      level: 'required',
      ok: false,
      detail: `msedge-tts 不可用：${String(e.message).slice(0, 60)}`,
      fix: 'npm install',
    };
  }
}

async function checkWritable(dir, name) {
  const probe = path.join(dir, `.doctor-${Date.now()}`);
  try {
    await ensureDir(dir);
    await fs.writeFile(probe, 'ok', 'utf8');
    await fs.rm(probe, { force: true });
    return { name, level: 'required', ok: true, detail: dir, fix: '' };
  } catch (e) {
    return {
      name,
      level: 'required',
      ok: false,
      detail: `${dir} 不可写：${String(e.message).slice(0, 60)}`,
      fix: '检查目录权限，或用 TUWEN_PROJECTS / TUWEN_CACHE 指到别的位置',
    };
  }
}

function checkConfig() {
  const { cfg, hasArk, hasVolc } = configSummary();
  const out = [];
  out.push({
    name: '图像模型 Key（方舟）',
    level: 'optional',
    ok: hasArk,
    detail: hasArk ? `已配置（${cfg.rows.find((r) => r.key === 'ARK_API_KEY').masked}）` : '没配：会用占位图，能出片但不算成品',
    fix: 'tuwen setup 打开配置页填进去',
  });
  out.push({
    name: 'volc 配音（可选）',
    level: 'optional',
    ok: hasVolc,
    detail: hasVolc ? '已配置' : '没配：用免费的 edge 配音（够用）',
    fix: '',
  });
  return out;
}

/** 真连一次网：合成两个字，验证接口通、音色对、能出音频 */
async function checkNetwork() {
  const { synthesizeEdge } = await import('./providers/edge-js.js');
  const out = path.join(CACHE_ROOT, `.doctor-tts-${Date.now()}.mp3`);
  try {
    await ensureDir(CACHE_ROOT);
    const t0 = Date.now();
    await synthesizeEdge({ text: '测试', voice: 'zh-CN-YunxiNeural', outFile: out });
    const size = (await fs.stat(out)).size;
    await fs.rm(out, { force: true });
    return {
      name: '联网合成一句', level: 'required', ok: size > 2048,
      detail: `${(size / 1024).toFixed(1)} KB / ${Date.now() - t0}ms`, fix: '',
    };
  } catch (e) {
    await fs.rm(out, { force: true }).catch(() => {});
    return {
      name: '联网合成一句', level: 'required', ok: false,
      detail: String(e.message).slice(0, 90),
      fix: '检查网络；公司网络可能挡了微软的语音接口（wss）。离线时可以用 voice.engine 之外的方式，或先跑 --network 之外的自检',
    };
  }
}

export async function runDoctor({ network = false } = {}) {
  const checks = [];
  checks.push(await checkNode());
  checks.push(await checkBinary('ffmpeg', ffmpegBin(), ['-version']));
  checks.push(await checkBinary('ffprobe', ffprobeBin(), ['-version']));
  checks.push(await checkChromium());
  checks.push(await checkEdgeTTS());
  checks.push(await checkWritable(PROJECTS_DIR, '项目目录可写'));
  checks.push(await checkWritable(CACHE_ROOT, '缓存目录可写'));
  checks.push(...checkConfig());
  if (network) checks.push(await checkNetwork());

  const failedRequired = checks.filter((c) => c.level === 'required' && !c.ok);
  const missingOptional = checks.filter((c) => c.level === 'optional' && !c.ok);
  return {
    ok: failedRequired.length === 0,
    ready: failedRequired.length === 0,
    // 能不能出「全模型」的片子：关键看有没有图像 Key
    fullQuality: failedRequired.length === 0 && !missingOptional.some((c) => c.name.includes('方舟')),
    paths: {
      engine: ROOT,
      projects: PROJECTS_DIR,
      cache: CACHE_ROOT,
      configDir: CONFIG_DIR,
      userEnv: USER_ENV_FILE,
      repoEnv: REPO_ENV_FILE,
      userEnvExists: existsSync(USER_ENV_FILE),
    },
    ffmpeg: ffmpegBin(),
    ffprobe: ffprobeBin(),
    checks,
    failed: failedRequired.map((c) => c.name),
  };
}

export function formatDoctor(r) {
  const lines = [];
  lines.push(`▸ 自检 ${r.ready ? '✓ 可以直接出片' : '✗ 还差东西'}${r.fullQuality ? '（全模型画面可用）' : ''}`);
  lines.push('');
  for (const c of r.checks) {
    lines.push(`  ${c.ok ? '✓' : c.level === 'required' ? '✗' : '·'} ${c.name.padEnd(16)} ${c.detail}`);
    if (!c.ok && c.fix) lines.push(`      → ${c.fix}`);
  }
  if (r.failed.length) {
    lines.push('');
    lines.push(`  必修 ${r.failed.length} 项：${r.failed.join('、')}`);
  }
  lines.push('');
  lines.push('  位置');
  for (const [k, v] of Object.entries(r.paths)) {
    lines.push(`    ${k.padEnd(14)} ${v}`);
  }
  lines.push(`    ffmpeg         ${r.ffmpeg}`);
  lines.push(`    ffprobe        ${r.ffprobe}`);
  return lines.join('\n');
}

export function formatConfig() {
  const { cfg } = configSummary();
  const lines = [];
  lines.push(`▸ 配置 ${cfg.exists ? '✓ 已保存到用户目录' : '· 还没有用户级配置'}`);
  lines.push(`  ${cfg.file}`);
  lines.push('');
  let group = '';
  for (const r of cfg.rows) {
    if (r.group !== group) { group = r.group; lines.push(`  ${group}`); }
    const val = r.secret ? r.masked || '（未配置）' : r.plain || '（默认）';
    lines.push(`    ${r.key.padEnd(22)} ${val}${r.source === 'repo' ? '  ← 来自仓库 .env' : ''}`);
  }
  lines.push('');
  lines.push('  配 Key：tuwen setup  → 浏览器里填，不经过对话');
  return lines.join('\n');
}
