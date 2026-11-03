import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { chromium } from 'playwright';

const ROOT = path.resolve('.');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.json': 'application/json',
};

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = decodeURIComponent((req.url || '/').split('?')[0]);
      const file = path.join(ROOT, url);
      if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
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
