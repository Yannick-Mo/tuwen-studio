/**
 * 图像层：场景 → 图片。
 * 有 key 走真模型，没 key 或配额用尽就降级到占位图——但降级要说清楚原因，
 * 不能让人以为画面是模型画的。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { sha1, ensureDir, exists, log, loadEnv, ffprobe, run } from './util.js';
import { generateArk, arkAvailable, ImageError } from './providers/ark.js';
import { ASPECTS } from './schema.js';

const CACHE_DIR = path.resolve('.cache/img');

/** 各画幅的合法出图尺寸（Seedream 要求 ≥3686400 像素） */
const ARK_SIZE_BY_ASPECT = {
  '9:16': '1440x2560',
  '16:9': '2560x1440',
  '3:4': '1920x2560',
  '4:3': '2560x1920',
  '1:1': '1920x1920',
};

/**
 * .env 里的 ARK_IMAGE_SIZE 只在这个画幅下才作数。
 * 否则横屏项目会拿到竖图、再被裁成一条——这是最容易静默出错的地方。
 */
export function imageSizeFor(project, env) {
  const aspect = project.meta.aspect || '9:16';
  const target = ASPECTS[aspect] || ASPECTS['9:16'];
  const want = target[0] / target[1];
  const configured = env?.ARK_IMAGE_SIZE;
  if (configured) {
    const [w, h] = String(configured).split('x').map(Number);
    if (w > 0 && h > 0 && Math.abs(w / h - want) / want < 0.02) return configured;
  }
  return ARK_SIZE_BY_ASPECT[aspect] || ARK_SIZE_BY_ASPECT['9:16'];
}

const MOTIF_SUBJECT = {
  blackhole: '一个巨大的黑洞悬浮在深空，明亮的吸积盘环绕，背景星光被引力透镜扭曲成弧',
  star: '一颗恒星在深空中燃烧，金色光芒与等离子体喷发，体积感强烈',
  collapse: '物质向中心坍缩形成的引力漩涡，光线被拉成同心弧线',
  photo: '望远镜拍摄的黑洞照片质感，橙红色光环包住中心黑暗，颗粒与噪点明显',
  galaxy: '俯瞰一个螺旋星系，旋臂由亿万颗恒星组成，中心核球明亮',
  void: '看不见本体的黑洞，只有被撕碎的物质形成发光漩涡并被拖入黑暗',
  horizon: '从太空看一颗行星的弧形地平线，蓝色大气层发出辉光',
};

/** 景别轮换：连续两镜用同一景别，观众会觉得画面卡住了。
 *  每条都带一个可数的构图约束——有人物时，纯形容词会被忽略，数字不会。 */
const SHOTS = [
  { text: '超广角大全景，环境占画面主导，人物是画面里的一个小点', framing: '人物高度不超过画面高度的四分之一' },
  { text: '中景，前中后景层次分明', framing: '人物高度约占画面高度的一半' },
  { text: '特写，局部细节占满画面，质感强烈', framing: '人物面部或手部占画面高度三分之二以上' },
  { text: '低角度仰拍，主体压向画面上方，有压迫感', framing: '人物高度约占画面高度的三分之二' },
  { text: '高角度俯视，构图对称，留出大面积负空间', framing: '人物高度不超过画面高度的三分之一' },
];

/** 某一镜用哪个景别：自定义优先，否则按顺序轮换 */
export function shotFor(scene, index) {
  const custom = typeof scene.visual?.shot === 'string' ? scene.visual.shot : null;
  if (custom) return { text: custom, framing: '', custom: true };
  return SHOTS[index % SHOTS.length];
}

/** 角色台词：外貌写死在每一镜的提示词里（L1），同时把定妆照当参考图传进去（L2） */
function castLine(project, scene, refCount) {
  const ids = scene.cast || [];
  if (!ids.length) return '';
  const chars = ids
    .map((id) => (project.characters || []).find((c) => c.id === id))
    .filter(Boolean);
  if (!chars.length) return '';
  const multi = chars.length > 1;
  const parts = chars.map((c, i) => {
    const pos = multi ? (i === 0 ? '左侧' : '右侧') : '';
    return `${pos ? `${pos}是` : ''}${c.name}（${c.look}${c.outfit ? `，${c.outfit}` : ''}）`;
  });
  // 参考图没真的传进去时（没 key、配额用尽），不能还在提示词里承诺「参考图1就是该人物」：
  // 模型照做不了，出图会既没有一致性、又照着错的指令猜。
  if (refCount === 0) {
    return `画面中的人物：${parts.join('；')}，五官、发型、服装、配饰必须完全一致`;
  }
  const refMap = multi
    ? chars.map((c, i) => `参考图${i + 1}是${c.name}`).join('，') + '；两个人不能串脸'
    : '参考图1就是该人物';
  // 参考图现在是四视图设定：告诉模型按需要的角度取用，而不是照抄其中一格
  const views = '每张参考图是同一人物的四视图设定（从左到右：正面、左侧、右侧、背面），只取本镜需要的角度';
  return `画面中的人物：${parts.join('；')}。${refMap}。${views}，五官、发型、伤疤、服装、配饰必须与参考图一致`;
}

export function buildPrompt(project, scene, index = 0, { refCount } = {}) {
  const subject = scene.visual?.subject || MOTIF_SUBJECT[scene.motif] || scene.narration || '';
  const hasCast = (scene.cast || []).length > 0;
  const shot = shotFor(scene, index);
  const framing = hasCast && !shot.custom ? shot.framing : '';
  const style = [project.style?.token, scene.visual?.style].filter(Boolean).join('，');
  const cast = castLine(project, scene, refCount);
  const vertical = project.meta.aspect === '9:16';
  // 别写「底部留白」：模型会照字面画一条空白带。字幕安全区靠主体位置解决，不靠留白。
  const composition = project.style?.composition || (vertical
    ? '竖屏 9:16 构图，主体位于画面中上部，画面铺满整个画幅、四边不留空白边距'
    : '横屏 16:9 构图，主体偏左，画面铺满整个画幅、四边不留空白边距');
  const negatives = hasCast
    ? '画面中不要出现成段文字、对话气泡、水印、标志、边框、分屏、底部空白带，不要出现第三个人'
    : '画面中不要出现成段文字、对话气泡、水印、标志、边框、分屏、底部空白带，不要出现完整人物或人脸';
  // 景别放最前（权重最高），量化约束放到接近结尾（收尾强调）
  return [shot.text, cast, subject, style, composition, framing, negatives, project.style?.negative]
    .filter(Boolean).join('，');
}

/** 角色定妆照：一次生成，之后每镜当参考图用 */
export async function ensureCharacterSheets({ project, dir, env }) {
  // 只给真的在某个镜头里出现过的角色出资产。
  // 定义了但一场戏都没用上的，出一张图纯属浪费额度。
  const used = new Set();
  for (const s of project.scenes || []) for (const id of s.cast || []) used.add(id);
  const chars = (project.characters || []).filter((c) => used.has(c.id));
  const map = new Map();
  if (!chars.length) return map;

  const e = env || loadEnv();
  const imgDir = path.join(dir, 'img');
  const cacheDir = path.join(CACHE_DIR, 'chars');
  await ensureDir(imgDir);
  await ensureDir(cacheDir);
  // 四视图横着排，用横图才装得下；和成片画幅无关
  const size = '2560x1440';
  const model = e.ARK_IMAGE_MODEL;

  for (const c of chars) {
    const prompt = [
      '同一人物的四视图设定图：正面、左侧面、右侧面、背面，四个视角从左到右并排，全身，中性站姿，纯浅灰背景，均匀柔光',
      '四个视角的发型、脸、服装、配饰必须完全一致，只是角度不同',
      `${c.name}，${c.look}${c.outfit ? `，${c.outfit}` : ''}`,
      project.style?.token,
      '整张图不要出现任何文字、标注、数字、水印、边框',
    ].filter(Boolean).join('，');
    const key = sha1(`sheet4|${model}|${size}|${prompt}`);
    const cachedFile = path.join(cacheDir, `${key}.jpg`);
    const dst = path.join(imgDir, `_char_${c.id}.jpg`);

    if (!(await exists(cachedFile))) {
      if (!arkAvailable(e)) continue;
      const out = await generateArk({ apiKey: e.ARK_API_KEY, baseURL: e.ARK_BASE_URL, model, prompt, size, seed: 7 });
      await saveVerified(out.buffer, cachedFile);
      log(`  · 角色设定图 ${c.name}（四视图）  ${(out.buffer.length / 1024).toFixed(0)}KB`);
    }
    await saveVerified(await fs.readFile(cachedFile), dst);
    const b64 = (await fs.readFile(dst)).toString('base64');
    map.set(c.id, { file: dst, ref: `data:image/jpeg;base64,${b64}`, key, prompt });
  }
  return map;
}

function sceneSeed(scene, i) {
  const base = `${scene.id}:${i}`;
  let h = 2166136261;
  for (let k = 0; k < base.length; k++) { h ^= base.charCodeAt(k); h = Math.imul(h, 16777619); }
  return Math.abs(h) % 1_000_000;
}

/** 只重出一张：改一镜时唯一该花的钱 */
export async function generateOne({ project, scene, index, imgDir, prompt, seed, env, sheets }) {
  await ensureDir(imgDir);
  const e = env || loadEnv();
  if (!arkAvailable(e)) {
    throw new ImageError('没有配置 ARK_API_KEY，无法重新出图（可以只用 --no-image 重渲）', { code: 'auth' });
  }
  const model = e.ARK_IMAGE_MODEL;
  const size = imageSizeFor(project, e);
  const s = seed ?? sceneSeed(scene, index);
  const refs = (scene.cast || []).map((id) => sheets?.get(id)).filter(Boolean);
  const refKey = refs.map((r) => r.key).join(',');
  const text = prompt || buildPrompt(project, scene, index, { refCount: refs.length });
  const key = sha1(`${model}|${size}|${s}|${refKey}|${text}`);
  const cachedFile = path.join(CACHE_DIR, `${key}.jpg`);
  const dst = path.join(imgDir, `${scene.id}.jpg`);

  if (await exists(cachedFile)) {
    await saveVerified(await fs.readFile(cachedFile), dst);
    return { file: dst, prompt: text, seed: s, cached: true, size };
  }
  const out = await generateArk({
    apiKey: e.ARK_API_KEY, baseURL: e.ARK_BASE_URL, model, prompt: text, size, seed: s,
    image: refs.map((r) => r.ref),
  });
  await saveVerified(out.buffer, dst);
  await fs.writeFile(cachedFile, out.buffer);
  await fs.writeFile(`${cachedFile}.json`, JSON.stringify({ prompt: text, model, size, seed: s, cast: scene.cast || [], at: new Date().toISOString() }, null, 2));
  return { file: dst, prompt: text, seed: s, cached: false, size: out.meta.size };
}

/** 真实模型生成一批场景图，带内容哈希缓存 */
export async function generateArkImages({ project, scenes, imgDir, env, sheets, opts = {} }) {
  await ensureDir(imgDir);
  await ensureDir(CACHE_DIR);
  const size = imageSizeFor(project, env);
  const model = env.ARK_IMAGE_MODEL;
  const maxImages = opts.maxImages || 40;
  if (scenes.length > maxImages) {
    throw new ImageError(`这个项目要 ${scenes.length} 张图，超过单条上限 ${maxImages}`, { code: 'quota' });
  }

  const files = [];
  let generated = 0;
  let cached = 0;
  const failed = [];

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const seed = sceneSeed(scene, i);
    const refs = (scene.cast || []).map((id) => sheets?.get(id)).filter(Boolean);
    const refKey = refs.map((r) => r.key).join(',');
    const prompt = buildPrompt(project, scene, i, { refCount: refs.length });
    const key = sha1(`${model}|${size}|${seed}|${refKey}|${prompt}`);
    const cachedFile = path.join(CACHE_DIR, `${key}.jpg`);
    const dst = path.join(imgDir, `${scene.id}.jpg`);

    // 缓存里的图也验一遍：缓存坏了会一路坏到成片里，而且再也长不好
    if (await exists(cachedFile)) {
      try {
        await saveVerified(await fs.readFile(cachedFile), dst);
        cached++;
        files.push(dst);
        continue;
      } catch (e) {
        log(`  · ${scene.id} 缓存里的图已损坏（${String(e.message).slice(0, 40)}），重新生成`);
        await fs.rm(cachedFile, { force: true }).catch(() => {});
        await fs.rm(`${cachedFile}.json`, { force: true }).catch(() => {});
      }
    }

    let out = null;
    let busted = null;
    for (let attempt = 0; attempt < 2 && !out; attempt++) {
      try {
        const got = await generateArk({
          apiKey: env.ARK_API_KEY, baseURL: env.ARK_BASE_URL, model, prompt, size,
          seed: seed + attempt * 1013,
          image: refs.map((r) => r.ref),
        });
        // 写盘时就校验：解不开的图当作这次尝试失败，换种子重来一次
        await saveVerified(got.buffer, dst);
        out = got;
      } catch (e) {
        const code = e.code || 'unknown';
        // 内容审核带概率性、网络会抖、个别图会坏：换种子重试一次，多数能过
        if (attempt === 0 && (code === 'content' || code === 'network' || code === 'bad-image')) {
          log(`  · ${scene.id} ${code === 'content' ? '被审核拦了一次'
            : code === 'bad-image' ? '出了一张坏图' : '网络抖了一下'}，换种子重试`);
          continue;
        }
        busted = { code, message: String(e.message).slice(0, 200) };
        failed.push({ id: scene.id, ...busted });
        log(`  ! ${scene.id} 出图失败（${code}）${String(e.message).slice(0, 80)}`);
      }
    }
    if (!out) {
      files.push(dst);
      continue;
    }
    await fs.writeFile(cachedFile, out.buffer);
    await fs.writeFile(`${cachedFile}.json`, JSON.stringify({ prompt, model, size, seed, cast: scene.cast || [], at: new Date().toISOString() }, null, 2));
    generated++;
    log(`  · ${scene.id}  ${(out.buffer.length / 1024).toFixed(0)}KB  ${out.meta.size}${refs.length ? `  +参考图${refs.length}` : ''}`);
    files.push(dst);
  }

  return {
    files,
    stats: {
      mode: failed.length ? 'partial' : 'ark',
      provider: 'ark', model, size, generated, cached,
      total: scenes.length, failed,
    },
  };
}

/** 降级：占位图，但返回的 stats 明确写清为什么 */
export async function generateMockImages({ page, project, scenes, imgDir, reason }) {
  const [width, height] = project.meta.size;
  const specs = scenes.map((s, i) => ({
    name: `${s.id}.jpg`, w: width, h: height,
    seed: 9100 + i * 733, motif: s.motif || 'blackhole', intensity: 1,
    palette: project.style.palette,
  }));
  const { renderMockImages } = await import('./mock-art.js');
  await renderMockImages(page, specs, imgDir);
  return {
    files: specs.map((s) => path.join(imgDir, s.name)),
    stats: { mode: 'mock', provider: 'mock', total: scenes.length, reason: reason || '未配置图像模型' },
  };
}

export async function pickImages({ page, project, scenes, imgDir, sheets, opts = {} }) {
  const env = loadEnv();
  if (opts.mock || !arkAvailable(env)) {
    log('  未配置图像模型（.env 缺少 ARK_API_KEY），使用占位图');
    const r = await generateMockImages({ page, project, scenes, imgDir, reason: '未配置 ARK_API_KEY' });
    return auditImages(r, { page, project, scenes, imgDir });
  }
  log(`  图像模型：${env.ARK_IMAGE_MODEL}`);
  try {
    // 这里每一张都在写盘时过了 saveVerified，不用再整体复核一遍
    const r = await generateArkImages({ project, scenes, imgDir, env, sheets, opts });
    log(`  ✓ ${r.stats.generated} 张新生成，${r.stats.cached} 张命中缓存`);

    // 有被拒的：只给缺的那几张补占位图，其它照旧，并在统计里标清楚
    const failedIds = (r.stats.failed || []).map((f) => f.id);
    if (failedIds.length) {
      const missing = scenes.filter((s) => failedIds.includes(s.id));
      await generateMockImages({ page, project, scenes: missing, imgDir, reason: '这几张被模型拒绝' });
      // 补位图也要验，不然「补了个空」比没补更糟
      const badFill = await verifyImages(missing.map((s) => path.join(imgDir, `${s.id}.jpg`)));
      if (badFill.length) log(`  ! 补位的占位图也坏了：${badFill.map((b) => path.basename(b.file)).join(', ')}`);
      r.stats.mode = 'partial';
      r.stats.degraded = failedIds;
      r.stats.broken = badFill;
      log(`  ! ${failedIds.length}/${scenes.length} 张被拒，已用占位图补位：${failedIds.join(', ')}`);
      log('  ! 这条片子不是全模型画面，别当成品交付');
    }
    return r;
  } catch (e) {
    const reason = `${e.code}: ${e.message}`;
    log(`  ! ${reason}`);
    log('  → 降级为占位图；修好配额后重跑同一条命令即可，缓存不会重复花钱');
    const r = await generateMockImages({ page, project, scenes, imgDir, reason });
    return auditImages(r, { page, project, scenes, imgDir });
  }
}

/**
 * 占位图这条路没有「写盘时校验」，所以补一道整体体检。
 * 坏掉的那几张重画一遍，还坏就标降级——绝不能带着一张解不开的图进渲染，
 * 那会一路走完全部渲染，最后交出一条「质检 7/7 通过」的废片。
 */
async function auditImages(r, { page, project, scenes, imgDir }) {
  const bad = await verifyImages(r.files);
  if (!bad.length) return r;
  const badIds = bad
    .map((b) => path.basename(b.file).replace(/\.[^.]+$/, ''))
    .filter((id) => scenes.some((s) => s.id === id));
  log(`  ! ${bad.length} 张图解不开：${bad.map((b) => `${path.basename(b.file)}（${b.reason}）`).join('，')}`);
  if (badIds.length) {
    const retry = scenes.filter((s) => badIds.includes(s.id));
    await generateMockImages({ page, project, scenes: retry, imgDir, reason: '重画坏掉的图' });
    const stillBad = await verifyImages(retry.map((s) => path.join(imgDir, `${s.id}.jpg`)));
    if (stillBad.length) log(`  ! 重画后仍然解不开：${stillBad.map((b) => path.basename(b.file)).join(', ')}`);
    log(`  → 已重画 ${badIds.join(', ')}；这条片子算降级`);
    r.stats.broken = stillBad;
  }
  r.stats.mode = 'partial';
  r.stats.degraded = [...new Set([...(r.stats.degraded || []), ...badIds])];
  return r;
}

/** 生成后再看一眼：这张图到底能不能解出一帧像素来 */
export async function checkImage(file) {
  const stat = await fs.stat(file);
  if (stat.size < 8192) return { ok: false, reason: `文件过小 ${stat.size}B` };
  // 光用 ffprobe 不够：它只解封装不看像素，一个扩展名是 .jpg 的垃圾文件
  // 也会被它报成「有一条 mjpeg 流」。必须真的解一帧，才知道这张图能不能用。
  const { code, stderr } = await run('ffmpeg', [
    '-hide_banner', '-v', 'error', '-i', file, '-frames:v', '1', '-f', 'null', '-',
  ], { allowFail: true });
  const err = String(stderr || '').trim();
  if (code !== 0 || err) {
    return { ok: false, reason: err.split('\n')[0].slice(0, 90) || `解码失败（退出码 ${code}）` };
  }
  try {
    const info = await ffprobe(file);
    const s = info.streams.find((x) => x.codec_type === 'video');
    if (!s) return { ok: false, reason: '不是图片' };
    return { ok: true, width: s.width, height: s.height };
  } catch {
    return { ok: false, reason: '无法解码' };
  }
}

/**
 * 落盘一张图，并且当场确认它能解码。
 * 先写 .part 再改名，和分段编码同一个套路：坏图绝不能带着正确的文件名进渲染，
 * 否则要等到成片里才发现——那时候已经花掉整条渲染的时间了。
 */
async function saveVerified(buffer, dst) {
  const part = `${dst}.part`;
  await fs.writeFile(part, buffer);
  let chk;
  try {
    chk = await checkImage(part);
  } catch (e) {
    chk = { ok: false, reason: String(e.message || e) };
  }
  if (!chk.ok) {
    await fs.rm(part, { force: true });
    throw new ImageError(`出图不可用：${chk.reason}`, { code: 'bad-image', retryable: true });
  }
  await fs.rename(part, dst);
  return chk;
}

/** 批量体检：渲染前最后一关。返回坏掉的图，空数组表示全好 */
export async function verifyImages(files) {
  const bad = [];
  for (const f of files || []) {
    if (!f) continue;
    let chk;
    try { chk = await checkImage(f); } catch (e) { chk = { ok: false, reason: String(e.message || e) }; }
    if (!chk.ok) bad.push({ file: f, reason: chk.reason });
  }
  return bad;
}
