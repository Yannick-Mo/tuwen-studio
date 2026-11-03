/**
 * 闸门测试：分镜表没给人看过，就不许花钱出图。
 *
 * 这条规则以前只写在工具描述里——Agent 第一次就传 confirmed 的话，
 * 插件会直接开始出图，一分钱不花的那次分镜表就被整个跳过了。
 * 现在它是一条状态：没看过，confirmed 也不放行。
 *
 *   node test/gate.mjs
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { apply } from '../plugin-video-studio/index.js';
import { ROOT, PROJECTS_DIR, CACHE_ROOT } from '../src/util.js';

const ID = 'gate-test';
const DIR = path.join(PROJECTS_DIR, ID);
const SEEN = path.join(CACHE_ROOT, 'storyboard-seen.json');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`);
}
const exists = (p) => fs.stat(p).then(() => true).catch(() => false);

// 注册工具（effect 直接执行，register 收进数组）
const tools = [];
apply({ effect: (f) => f(), tools: { register: (t) => tools.push(t) } }, { engineDir: ROOT });
const build = tools.find((t) => t.name === 'video_studio_build');
if (!build) throw new Error('没注册出 video_studio_build');

const spec = (subject) => ({
  id: ID,
  title: '闸门测试',
  aspect: '9:16',
  scenes: [
    { id: 'g1', narration: '第一句，用来验证闸门。', visual: { subject } },
    { id: 'g2', narration: '第二句，还是验证闸门。', visual: { subject: '另一个画面' } },
  ],
});

console.log('▸ 闸门测试');
await fs.rm(DIR, { recursive: true, force: true });
await fs.rm(SEEN, { force: true });

// ① 一次 confirmed 都不给就把钱花出去？不行
const r1 = await build.execute({ spec: spec('海边的灯塔'), projectId: ID, confirmed: true });
check('跳过分镜表直接被拦下', r1.planned === true && r1.gate === 'not-seen',
  `planned=${r1.planned} gate=${r1.gate || '-'}`);
check('被拦时确实没有出图', !(await exists(path.join(DIR, 'out', `${ID}.mp4`))), 'out/ 里没有成片');
check('记账本记下了这次分镜表', await exists(SEEN));

// ② spec 改一个字 = 另一个分镜，得重新给人看
const r2 = await build.execute({ spec: spec('海边的废弃灯塔'), projectId: ID, confirmed: true });
check('spec 改一个字就重新要确认', r2.planned === true && r2.gate === 'not-seen',
  `planned=${r2.planned} gate=${r2.gate || '-'}`);

// ③ 正常路径：先不带 confirmed（人能看到表），再带 confirmed 才放行
const r3 = await build.execute({ spec: spec('海边的废弃灯塔'), projectId: ID });
check('不带 confirmed 只出分镜表', r3.planned === true && !r3.gate, '没有 gate 标记');

await fs.rm(DIR, { recursive: true, force: true });
await fs.rm(SEEN, { force: true });

const pass = results.filter((c) => c.ok).length;
const fail = results.length - pass;
console.log(`\n${fail === 0 ? '✓ 通过' : '✗ 失败'}  ${pass}/${results.length}`);
if (fail) process.exit(1);
