import { loadEnv } from '../src/util.js';
import fs from 'node:fs/promises';
const env = loadEnv();
const H = { 'Content-Type':'application/json', Authorization:`Bearer ${env.ARK_API_KEY}` };
const base = env.ARK_BASE_URL, model = 'doubao-seedream-4-5-251128';

async function gen(body) {
  const r = await fetch(`${base}/images/generations`, { method:'POST', headers:H, body: JSON.stringify({ model, response_format:'url', watermark:false, size:'1440x2560', ...body }) });
  const t = await r.text();
  if (!r.ok) return { ok:false, text:t.slice(0,200) };
  const j = JSON.parse(t);
  const img = await fetch(j.data[0].url);
  return { ok:true, buf: Buffer.from(await img.arrayBuffer()) };
}

await fs.mkdir('.tmp/duo', { recursive: true });

// 第二个角色定妆照
const zhou = await gen({ prompt: '角色定妆照，正面半身，简洁深灰背景，柔光，电影感：周野，三十岁中国男性，寸头，短络腮胡，右眉骨有旧伤，深灰色工装' , seed: 7 });
console.log('zhousheet:', zhou.ok ? 'ok' : zhou.text);
if (zhou.ok) await fs.writeFile('.tmp/duo/zhou.jpg', zhou.buf);

const linB64 = 'data:image/jpeg;base64,' + (await fs.readFile('.tmp/char/sheet.jpg')).toString('base64');
const zhouB64 = zhou.ok ? 'data:image/jpeg;base64,' + zhou.buf.toString('base64') : null;

if (zhouB64) {
  const a = await gen({ image:[linB64, zhouB64], prompt: '同一个驾驶舱里，林夏（左侧女性，齐肩黑发，橙色太空服，左眉细疤）和周野（右侧男性，寸头，络腮胡，深灰工装）隔着控制台对视，中景，电影感' });
  console.log('A 名字分别描述:', a.ok ? 'ok' : a.text);
  if (a.ok) await fs.writeFile('.tmp/duo/A.jpg', a.buf);

  const b = await gen({ image:[linB64, zhouB64], prompt: '参考图1中的女人和参考图2中的男人，站在同一个驾驶舱里隔着控制台对视，中景，电影感' });
  console.log('B 用参考图指代:', b.ok ? 'ok' : b.text);
  if (b.ok) await fs.writeFile('.tmp/duo/B.jpg', b.buf);
}
