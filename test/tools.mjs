/**
 * 工具层测试：模型把参数传错时，插件该说什么。
 *
 * 背景：DSH 不会替我们校验参数（少传必填项也照样进 execute），所以每个工具
 * 必须自己挡住。以前 times 传成字符串会直接抛
 * `(args.times || []).filter is not a function` —— 模型看不懂，也不知道下一步做什么。
 *
 *   node test/tools.mjs
 */
import { apply } from '../plugin-video-studio/index.js';
import { ROOT } from '../src/util.js';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`);
}

const tools = [];
apply({ effect: (f) => f(), tools: { register: (t) => tools.push(t) } }, { engineDir: ROOT });
const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

/** 跑一次，断言「不抛异常、返回 ok:false、错误里有这个词」 */
async function bad(name, args, expectWord) {
  const tool = byName[name];
  if (!tool) return check(`${name} 存在`, false);
  let r;
  try {
    r = await tool.execute(args);
  } catch (e) {
    return check(`${name}(${JSON.stringify(args)}) 不该抛异常`, false, `抛了：${e.message}`);
  }
  const text = `${r?.error || ''} ${r?.hint || ''}`;
  const ok = r?.ok === false && text.includes(expectWord) && !/is not a function|Cannot read|undefined is not/.test(text);
  check(`${name} · ${expectWord}`, ok, ok ? '' : `实际：${JSON.stringify(r).slice(0, 160)}`);
}

console.log('▸ 工具参数边界');

await bad('video_studio_frames', { projectId: 'blackhole' }, '缺少参数 times');
await bad('video_studio_frames', { projectId: 'blackhole', times: '1,2' }, '应该是数字数组');
await bad('video_studio_frames', { projectId: 'blackhole', times: [] }, '空数组');
await bad('video_studio_frames', { projectId: 'blackhole', times: ['1'] }, '不是合法数字');
await bad('video_studio_frames', { projectId: 'blackhole', times: [undefined] }, '不是合法数字');
await bad('video_studio_frames', { times: [1] }, '缺少参数 projectId');
await bad('video_studio_frames', { projectId: 'Not-Valid-Id', times: [1] }, '格式不对');

await bad('video_studio_scene', { projectId: 'blackhole' }, '缺少参数 sceneId');
await bad('video_studio_scene', { projectId: 'blackhole', sceneId: 's3', seed: 'abc' }, 'seed 应该是非负整数');
await bad('video_studio_scene', { sceneId: 's3' }, '缺少参数 projectId');

await bad('video_studio_review', {}, '缺少参数 projectId');

await bad('video_studio_build', { spec: 'not-an-object', projectId: 'x' }, '应该是一个对象');
await bad('video_studio_build', { spec: { title: 't', scenes: [] }, projectId: 'x' }, 'scenes 不能为空');
await bad('video_studio_build', { spec: { id: 'Bad Id', scenes: [{ narration: 'a' }] } }, '格式不对');

await bad('video_studio_review', { projectId: 'no-such-project-xyz' }, 'project.json');
await bad('video_studio_scene', { projectId: 'no-such-project-xyz', sceneId: 's1', noImage: true }, 'project.json');

// 正常路径没被误伤
{
  const r = await byName.video_studio_list.execute({});
  check('video_studio_list 正常返回', Array.isArray(r?.projects), `${r?.projects?.length ?? '?'} 个项目`);
}
{
  const r = await byName.video_studio_guide.execute({});
  check('video_studio_guide 正常返回', typeof r?.guide === 'string' && r.guide.length > 1000, `${r?.guide?.length} 字`);
}

const pass = results.filter((c) => c.ok).length;
const fail = results.length - pass;
console.log(`\n${fail === 0 ? '✓ 通过' : '✗ 失败'}  ${pass}/${results.length}`);
if (fail) process.exit(1);
