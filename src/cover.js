/**
 * 封面：从成片里抽一帧是碰运气，抽到过场或半张脸就废了。
 * 这里拿一张指定镜头的画面当底，压一层暗角，把标题当钩子放上去。
 */
import fs from 'node:fs/promises';

const FONT = '"Noto Sans SC", "Source Han Sans SC", "Microsoft YaHei", "PingFang SC", sans-serif';

function esc(s) {
  return String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/**
 * @param page  playwright 页面
 * @param opts  { image, title, kicker, w, h, out }
 */
export async function makeCover(page, { image, title, kicker = '', w = 1080, h = 1920, out }) {
  const b64 = (await fs.readFile(image)).toString('base64');
  // 按字数定字号：短标题压成一行更有力，长标题才允许折两行，且尽量两边齐
  const maxW = w * 0.85;
  const len = Math.max(1, [...String(title || '')].length);
  const lines = len <= 12 ? 1 : 2;
  const byFit = (maxW / Math.ceil(len / lines)) * 0.98;
  const titleSize = Math.round(Math.min(w * 0.092, byFit));
  const kickerSize = Math.round(w * 0.032);

  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    *{margin:0;padding:0;box-sizing:border-box}
    html,body{width:${w}px;height:${h}px;overflow:hidden;background:#000}
    .wrap{position:relative;width:100%;height:100%}
    .bg{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
    .scrim{position:absolute;inset:0;
      background:
        linear-gradient(to top, rgba(0,0,0,.92) 0%, rgba(0,0,0,.72) 22%, rgba(0,0,0,.28) 46%, rgba(0,0,0,0) 62%),
        ${w > h ? 'linear-gradient(to right, rgba(0,0,0,.62) 0%, rgba(0,0,0,0) 58%),' : ''}
        radial-gradient(ellipse at 50% 38%, rgba(0,0,0,0) 42%, rgba(0,0,0,.45) 100%);}
    .text{position:absolute;left:${Math.round(w * 0.075)}px;right:${Math.round(w * 0.075)}px;bottom:${Math.round(h * 0.145)}px}
    .kicker{font-family:${FONT};font-size:${kickerSize}px;font-weight:700;letter-spacing:.14em;
      color:#ffd166;margin-bottom:${Math.round(w * 0.026)}px;text-shadow:0 2px 12px rgba(0,0,0,.9)}
    .title{font-family:${FONT};font-size:${titleSize}px;line-height:1.16;font-weight:900;color:#fff;
      letter-spacing:.01em;
      text-shadow:0 4px 0 rgba(0,0,0,.35), 0 10px 34px rgba(0,0,0,.95);
      -webkit-text-stroke:1px rgba(0,0,0,.28);
      display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
  </style></head><body>
    <div class="wrap">
      <img class="bg" src="data:image/jpeg;base64,${b64}">
      <div class="scrim"></div>
      <div class="text">
        ${kicker ? `<div class="kicker">${esc(kicker)}</div>` : ''}
        <div class="title">${esc(title)}</div>
      </div>
    </div>
  </body></html>`;

  await page.setViewportSize({ width: w, height: h });
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => (document.fonts ? document.fonts.ready : null));
  const buf = await page.screenshot({ type: 'jpeg', quality: 92 });
  await fs.writeFile(out, buf);
  return out;
}

/** 选哪一镜当封面底图：有角色的优先，其次中间那镜 */
export function pickCoverScene(project) {
  const scenes = project.scenes || [];
  if (!scenes.length) return null;
  const withCast = scenes.filter((s) => (s.cast || []).length);
  return withCast[0] || scenes[Math.floor(scenes.length / 2)];
}
