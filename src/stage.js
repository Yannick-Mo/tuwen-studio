import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { chromium } from 'playwright';

const ROOT = path.resolve('.');
// 渲染页只需要两样东西：舞台本身和项目素材。
// 以前是整个仓库都对外服务，`GET /.env` 就能把 API Key 读走——本地端口也是端口。
const ALLOW = ['/stage/', '/projects/'];
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.json': 'application/json',
};

/** 还原成绝对路径，并判断它是否落在允许的目录里 */
function resolveAllowed(url) {
  const file = path.resolve(ROOT, `.${url}`);
  const rel = path.relative(ROOT, file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const asUrl = `/${rel.replace(/\\/g, '/')}`;
  return ALLOW.some((p) => asUrl.startsWith(p)) ? file : null;
}

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = decodeURIComponent((req.url || '/').split('?')[0]);
      const file = resolveAllowed(url);
      if (!file) { res.writeHead(404); res.end('not found'); return; }
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'Cache-Control': 'no-store',
        });
        res.end(data);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

export async function openStage({ width, height }) {
  const { server, port } = await startServer();
  const browser = await chromium.launch({
    args: [
      '--force-color-profile=srgb',
      '--disable-lcd-text',
      '--hide-scrollbars',
      '--font-render-hinting=none',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
    ],
  });
  const base = `http://127.0.0.1:${port}/stage/index.html`;

  const makeWorker = async () => {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.on('pageerror', (e) => console.error('[stage] pageerror:', e.message));
    page.on('console', (m) => { if (m.type() === 'error') console.error('[stage]', m.text()); });
    await page.goto(base, { waitUntil: 'load' });
    return page;
  };

  const page = await makeWorker();
  return {
    browser, page, port, makeWorker,
    async close() { await browser.close(); await new Promise((r) => server.close(r)); },
  };
}

export async function mount(page, stageProject) {
  await page.evaluate((p) => window.__mount(p), stageProject);
}

export async function seek(page, ms) {
  await page.evaluate((t) => window.__seek(t), ms);
}

/** 直接走 CDP：比 page.screenshot 少一次编排，且能开 optimizeForSpeed */
export async function shot(page) {
  if (!page.__cdp) page.__cdp = await page.context().newCDPSession(page);
  const { data } = await page.__cdp.send('Page.captureScreenshot', {
    format: 'jpeg', quality: 88, optimizeForSpeed: true,
    captureBeyondViewport: false, fromSurface: true,
  });
  return Buffer.from(data, 'base64');
}

export async function grabFrame(page, ms, file) {
  await seek(page, ms);
  const buf = await shot(page);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(file, buf);
}
