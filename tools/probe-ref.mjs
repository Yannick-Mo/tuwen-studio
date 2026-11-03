import { loadEnv } from '../src/util.js';
import fs from 'node:fs/promises';
const env = loadEnv();
const H = { 'Content-Type':'application/json', Authorization:`Bearer ${env.ARK_API_KEY}` };
const base = env.ARK_BASE_URL;
const model = 'doubao-seedream-4-5-251128';

async function gen(body) {
  const r = await fetch(`${base}/images/generations`, { method:'POST', headers:H, body: JSON.stringify({ model, response_format:'url', watermark:false, size:'1440x2560', ...body }) });
  const t = await r.text();
  if (!r.ok) return { ok:false, status:r.status, text:t.slice(0,300) };
  const j = JSON.parse(t);
  const img = await fetch(j.data[0].url);
  return { ok:true, buf: Buffer.from(await img.arrayBuffer()), url: j.data[0].url };
}

// 1. 角色定妆照
const a = await gen({ prompt: '电影感定妆照：一个二十岁的中国女孩，齐肩短发，穿橙色战术太空服，左眉有一道小疤，正面半身，简洁深灰背景，柔光' });
console.log('sheet:', a.ok ? 'ok' : `${a.status} ${a.text}`);
if (a.ok) await fs.mkdir('.tmp/char',{recursive:true}), await fs.writeFile('.tmp/char/sheet.jpg', a.buf);

// 2. 用 URL 作参考
if (a.ok) {
  const b = await gen({ prompt: '同一个女孩，站在飞船驾驶舱里，回头看向镜头，电影感', image: [a.url] });
  console.log('ref-by-url:', b.ok ? 'ok' : `${b.status} ${b.text}`);
  if (b.ok) await fs.writeFile('.tmp/char/scene.jpg', b.buf);
}

// 3. 用 base64 作参考
if (a.ok) {
  const dataUrl = 'data:image/jpeg;base64,' + a.buf.toString('base64');
  const c = await gen({ prompt: '同一个女孩，站在飞船驾驶舱里，回头看向镜头，电影感', image: [dataUrl] });
  console.log('ref-by-base64:', c.ok ? 'ok' : `${c.status} ${String(c.text).slice(0,220)}`);
  if (c.ok) await fs.writeFile('.tmp/char/scene64.jpg', c.buf);
}
