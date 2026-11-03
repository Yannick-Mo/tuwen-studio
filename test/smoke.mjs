/**
 * 冒烟测试：一条固定 spec 跑完整流程，然后核对关键指标。
 *
 * 默认用占位图，不花钱、不依赖外网、结果可复现；
 * 传 --real 则走真实出图，额外校验画面来源。
 *
 *   node test/smoke.mjs           # 离线自检
 *   node test/smoke.mjs --real    # 真跑一次（会消耗出图额度）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ROOT, PROJECTS_DIR } from '../src/util.js';

const REAL = process.argv.includes('--real');
const SPEC = path.join(ROOT, 'test', 'fixtures', 'smoke.json');
const ID = 'smoke';
const DIR = path.join(PROJECTS_DIR, ID);

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`);
}

function runNode(args) {
  return new Promise((resolve) => {
    // 故意在临时目录里跑：引擎的所有路径都必须从文件位置算，不能依赖当前工作目录
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: os.tmpdir() });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

const t0 = Date.now();
console.log(`▸ 冒烟测试 ${REAL ? '（真实出图）' : '（占位图，离线）'}`);

// 从干净状态起跑，否则旧产物会让测试永远通过
await fs.rm(DIR, { recursive: true, force: true });

const args = [path.join(ROOT, 'src', 'cli.js'), 'build', SPEC, '--yes'];
if (!REAL) args.push('--mock');
const r = await runNode(args);

check('构建退出码为 0', r.code === 0, `code=${r.code}`);
if (r.code !== 0) {
  console.error(r.err.slice(-2000) || r.out.slice(-2000));
}

const readJson = async (p) => JSON.parse(await fs.readFile(p, 'utf8'));
const exists = async (p) => !!(await fs.stat(p).catch(() => null));

const result = await readJson(path.join(DIR, 'out', 'result.json'));
const project = await readJson(path.join(DIR, 'project.json'));
const spec = await readJson(SPEC);

check('产物齐全', !!(result.out && result.cover && result.sheet && result.imagesSheet));
check('成片文件存在', await exists(result.out));

// 时间轴：分镜表上写的帧数，必须和成片一致
check('帧数与 project.json 一致', project.timeline.totalFrames === result.frames,
  `${project.timeline.totalFrames} vs ${result.frames}`);

// 时长：真实配音决定，给 15% 或 1.5 秒的宽容
const expect = project.timeline.totalDuration;
check('成片时长与时间轴吻合', Math.abs(result.duration - expect) <= Math.max(1.5, expect * 0.15),
  `${result.duration}s vs ${expect.toFixed(2)}s`);

// 质检七项
check('质检七项通过', result.qc.checks.length === 7 && result.qc.ok === true,
  result.qc.checks.filter((c) => !c.ok).map((c) => c.name).join(',') || 'all pass');

// 每镜都有声音，且不是空文件
const voiceFiles = await Promise.all(spec.scenes.map(async (s) => {
  const base = path.join(DIR, 'voice', s.id);
  for (const ext of ['.mp3', '.wav']) {
    const f = base + ext;
    const st = await fs.stat(f).catch(() => null);
    if (st && st.size > 2048) return true;
  }
  return false;
}));
check('每镜都有有效配音', voiceFiles.every(Boolean), `${voiceFiles.filter(Boolean).length}/${voiceFiles.length}`);

// 每镜都有图，且 shot 里把台词和图并排给出了（交付前看图的入口）
const imgFiles = await Promise.all(spec.scenes.map((s) => exists(path.join(DIR, 'img', `${s.id}.jpg`))));
check('每镜都有画面', imgFiles.every(Boolean), `${imgFiles.filter(Boolean).length}/${imgFiles.length}`);
check('结果里带着「台词 + 图」清单', Array.isArray(result.shots)
  && result.shots.length === spec.scenes.length
  && result.shots.every((s) => s.narration && s.image));

// 机器侧的图像门禁：每张图都要能被解码，不能只靠人眼看联系表
const { verifyImages } = await import('../src/images.js');
const broken = await verifyImages(result.shots.map((s) => s.image));
check('每张图都能解码', broken.length === 0, broken.map((b) => path.basename(b.file)).join(',') || 'all ok');

// 软字幕：条数和镜头数一致，且不能互相重叠（重叠会让播放器叠两层字）
const srtText = await fs.readFile(path.join(DIR, 'out', 'smoke.srt'), 'utf8');
const cues = srtText.trim().split(/\n\n+/).filter(Boolean).map((b) => {
  const m = /(\d\d:\d\d:\d\d,\d\d\d) --> (\d\d:\d\d:\d\d,\d\d\d)/.exec(b);
  const toSec = (t) => t.split(/[:,]/).reduce((acc, x, i) => acc + Number(x) * [3600, 60, 1, 0.001][i], 0);
  return m ? { a: toSec(m[1]), b: toSec(m[2]) } : null;
}).filter(Boolean);
const overlap = cues.some((c, i) => i && c.a < cues[i - 1].b - 0.001);
check('软字幕已导出且不重叠', cues.length === spec.scenes.length && !overlap,
  `${cues.length} 条${overlap ? '（有重叠）' : ''}`);

// 引擎记录：重渲要按它走，不能凭空变
check('配音引擎已记录', !!project.voice.engineUsed, project.voice.engineUsed);

// 画面来源
if (REAL) {
  check('画面全部来自模型', result.images.mode === 'ark', result.images.mode);
  check('结果未被标记降级', result.degraded === false);
} else {
  check('占位图模式被正确标记为降级', result.images.mode === 'mock' && result.degraded === true);
  check('降级时 result.ok 为 false', result.ok === false, '质检过但不算成品');
}

// 自检命令本身要能跑通：换台机器第一个该跑的就是它
const doctorJson = await new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'cli.js'), 'doctor', '--json'], { cwd: os.tmpdir() });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.on('close', () => resolve(out.trim().split('\n').pop() || ''));
});
let doctorOk = false;
try {
  const j = JSON.parse(doctorJson);
  doctorOk = Array.isArray(j.checks)
    && j.checks.some((c) => c.name === 'ffmpeg' && c.ok)
    && typeof j.paths?.projects === 'string';
} catch { doctorOk = false; }
check('doctor 能给出机器可读的自检结果', doctorOk);

// 插件得能在「引擎被当成包安装」的情况下找到引擎（不能靠硬编码路径）
check('插件能解析到引擎目录', await (async () => {
  try {
    const { apply } = await import('../plugin-video-studio/index.js');
    const tools = [];
    apply({ effect: (f) => f(), tools: { register: (t) => tools.push(t) } }, { engineDir: ROOT });
    return tools.length === 6;
  } catch { return false; }
})(), '6 个工具');

const pass = results.filter((c) => c.ok).length;
const fail = results.length - pass;
const secs = ((Date.now() - t0) / 1000).toFixed(1);

console.log(`\n${fail === 0 ? '✓ 通过' : '✗ 失败'}  ${pass}/${results.length}  ${secs}s`);
if (fail) {
  console.log('\n没过的项：');
  for (const c of results.filter((x) => !x.ok)) console.log(`  ✗ ${c.name}  ${c.detail}`);
  process.exit(1);
}
