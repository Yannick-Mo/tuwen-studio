/**
 * 本地工作台：把分镜、预览、单镜重渲做成可点的界面。
 * 只监听 127.0.0.1，静态资源直接读仓库，接口只有三个。
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = path.resolve('.');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.json': 'application/json',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

/** 把 url 还原成文件路径，并确认它确实落在 base 目录里（防 ..%2f 之类的穿越） */
function within(base, urlPath) {
  const file = path.resolve(base, `.${urlPath}`);
  const rel = path.relative(base, file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return file;
}

function serveFile(req, res, file) {
  const ext = path.extname(file).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const stat = fs.statSync(file);
  const range = req.headers.range;
  // 视频要支持 Range，否则拖不动进度条
  if (range && stat.size > 1024 * 1024) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m && m[1] ? parseInt(m[1], 10) : 0;
    const end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
    res.writeHead(206, {
      'Content-Type': type,
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
    });
    fs.createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes' });
  fs.createReadStream(file).pipe(res);
}

async function listProjects() {
  const dir = path.join(ROOT, 'projects');
  const out = [];
  for (const name of await fsp.readdir(dir).catch(() => [])) {
    const p = path.join(dir, name, 'project.json');
    try {
      const project = JSON.parse(await fsp.readFile(p, 'utf8'));
      const resultPath = path.join(dir, name, 'out', 'result.json');
      const result = await fsp.readFile(resultPath, 'utf8').then(JSON.parse).catch(() => null);
      out.push({
        id: project.id,
        title: project.meta?.title || project.id,
        scenes: project.scenes?.length || 0,
        duration: result?.duration || project.timeline?.totalDuration || null,
        qcOk: result?.qc?.ok ?? null,
        hasVideo: Boolean(result?.out),
      });
    } catch { /* 跳过不完整项目 */ }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

async function loadProject(id) {
  const dir = path.join(ROOT, 'projects', id);
  const project = JSON.parse(await fsp.readFile(path.join(dir, 'project.json'), 'utf8'));
  const result = await fsp.readFile(path.join(dir, 'out', 'result.json'), 'utf8').then(JSON.parse).catch(() => null);
  const findings = [];
  for (const s of project.scenes || []) {
    const img = path.join(dir, 'img', `${s.id}.jpg`);
    const has = await fsp.stat(img).then(() => true).catch(() => false);
    findings.push({
      id: s.id,
      narration: s.narration,
      start: s.start,
      duration: s.duration,
      cast: s.cast || [],
      subject: s.visual?.subject || '',
      shot: s.visual?.shot || '',
      transition: s.transitionOut?.type || null,
      hasImage: has,
    });
  }
  return {
    id: project.id,
    title: project.meta?.title || project.id,
    aspect: project.meta?.aspect,
    fps: project.meta?.fps,
    characters: project.characters || [],
    scenes: findings,
    result,
  };
}

/** 超时要把整棵进程树收掉：ffmpeg/chromium 是子进程，只杀 node 会让它们留在后台 */
function killTree(child) {
  if (!child || !child.pid) return;
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* 尽力而为 */ }
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* 尽力而为 */ } }
  }
}

function runCli(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'src', 'cli.js'), ...args], { cwd: ROOT, windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { killTree(child); reject(new Error('超时')); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error((err || out).trim().split('\n').slice(-8).join('\n')));
    });
  });
}

export async function startStudio({ port = 7788, open = false } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const p = decodeURIComponent(url.pathname);

    try {
      if (p === '/' || p === '/studio') { serveFile(req, res, path.join(ROOT, 'studio', 'index.html')); return; }
      if (p.startsWith('/studio/')) {
        const file = within(path.join(ROOT, 'studio'), p.slice('/studio'.length));
        if (!file) { res.writeHead(404); res.end('not found'); return; }
        serveFile(req, res, file);
        return;
      }
      if (p.startsWith('/projects/')) {
        const file = within(path.join(ROOT, 'projects'), p.slice('/projects'.length));
        if (!file) { res.writeHead(404); res.end('not found'); return; }
        if (fs.existsSync(file) && fs.statSync(file).isFile()) { serveFile(req, res, file); return; }
        res.writeHead(404); res.end('not found');
        return;
      }
      if (p === '/api/projects') { sendJson(res, 200, await listProjects()); return; }

      const m = /^\/api\/project\/([a-z0-9_-]+)$/.exec(p);
      if (m) { sendJson(res, 200, await loadProject(m[1])); return; }

      const r = /^\/api\/project\/([a-z0-9_-]+)\/scene\/([A-Za-z0-9_-]+)$/.exec(p);
      if (r && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const { prompt, noImage } = JSON.parse(body || '{}');
        const args = ['scene', path.join(ROOT, 'projects', r[1], 'project.json'), `--id=${r[2]}`];
        if (noImage) args.push('--no-image');
        else if (prompt) args.push(`--prompt=${prompt}`);
        const out = await runCli(args, 10 * 60 * 1000);
        const json = JSON.parse(out.trim().split('\n').filter((l) => l.startsWith('{')).pop() || '{}');
        sendJson(res, 200, json);
        return;
      }

      res.writeHead(404); res.end('not found');
    } catch (e) {
      sendJson(res, 500, { ok: false, error: String(e.message).slice(0, 800) });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  const actual = server.address().port;
  return { url: `http://127.0.0.1:${actual}/`, port: actual, close: () => new Promise((r) => server.close(r)) };
}
