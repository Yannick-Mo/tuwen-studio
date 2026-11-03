/**
 * 把插件装进 DSH：在 profile 的 node_modules 里建一个链接，指向本仓库的 plugin-video-studio。
 *
 *   node scripts/install-plugin.mjs              # 自动找 ~/.dsh/profiles/*
 *   node scripts/install-plugin.mjs --profile web
 *   node scripts/install-plugin.mjs --list
 *   node scripts/install-plugin.mjs --force      # 已经存在时先删掉再建
 *
 * 用链接而不是复制：改了仓库里的代码，重开一个会话就生效，不用重装。
 */
import fs from 'node:fs/promises';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const PKG = '@local/dsh-video-studio';
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const value = (n) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : null;
};

const REPO = path.resolve(import.meta.dirname, '..');
const PLUGIN_SRC = path.join(REPO, 'plugin-video-studio');
const PROFILES_ROOT = path.join(os.homedir(), '.dsh', 'profiles');

function profiles() {
  try {
    return readdirSync(PROFILES_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => ({ name: d.name, dir: path.join(PROFILES_ROOT, d.name) }))
      .filter((p) => existsSync(path.join(p.dir, 'node_modules')) || existsSync(path.join(p.dir, 'package.json')));
  } catch { return []; }
}

async function link(target, source) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  if (process.platform === 'win32') {
    // /J 是目录联接：不需要管理员权限，和符号链接一样指向真实目录
    const r = spawnSync('cmd', ['/c', 'mklink', '/J', target, source], { windowsHide: true });
    if (r.status !== 0) throw new Error(`mklink 失败：${(r.stderr || r.stdout || '').toString().trim()}`);
  } else {
    await fs.symlink(source, target, 'dir');
  }
}

const found = profiles();

if (flag('list')) {
  console.log(`插件源：${PLUGIN_SRC}`);
  console.log(`发现 ${found.length} 个 profile：`);
  for (const p of found) {
    const dest = path.join(p.dir, 'node_modules', ...PKG.split('/'));
    const there = existsSync(dest);
    console.log(`  ${p.name.padEnd(16)} ${there ? '已装' : '未装'}  ${dest}`);
  }
  process.exit(0);
}

const want = value('profile');
const targets = want
  ? found.filter((p) => p.name === want || p.dir === path.resolve(want))
  : found;

if (!targets.length) {
  console.error(found.length ? `找不到 profile：${want}` : `没在 ${PROFILES_ROOT} 下发现任何 profile。先启动一次 DSH，或显式给 --profile <路径>`);
  process.exit(1);
}

if (!existsSync(path.join(PLUGIN_SRC, 'index.js'))) {
  console.error(`插件源不完整：${PLUGIN_SRC} 里没有 index.js`);
  process.exit(1);
}

let failed = 0;
for (const p of targets) {
  const dest = path.join(p.dir, 'node_modules', ...PKG.split('/'));
  try {
    if (existsSync(dest) || lstatSync(dest, { throwIfNoEntry: false })) {
      if (!flag('force')) {
        console.log(`· ${p.name}：已经存在，跳过（要覆盖加 --force）  ${dest}`);
        continue;
      }
      await fs.rm(dest, { recursive: true, force: true });
    }
    await link(dest, PLUGIN_SRC);
    console.log(`✓ ${p.name}：${dest}  →  ${PLUGIN_SRC}`);
  } catch (e) {
    failed++;
    console.error(`✗ ${p.name}：${e.message}`);
  }
}

if (failed) process.exit(1);
console.log('');
console.log('装好了。重开一个 DSH 会话，六个 video_studio_* 工具就会出现。');
console.log('第一次用之前先跑一次：tuwen doctor');
