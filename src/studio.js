/**
 * 本地工作台：把分镜、预览、单镜重渲做成可点的界面。
 * 只监听 127.0.0.1，静态资源直接读仓库，接口只有三个。
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { ROOT, PROJECTS_DIR } from './util.js';

// 配置页的一次性令牌：本地端口也不能让随便哪个网页往这儿 POST 一个 key
const SETUP_TOKEN = randomBytes(16).toString('hex');
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
  const dir = PROJECTS_DIR;
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
  const dir = path.join(PROJECTS_DIR, id);
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
        const file = within(PROJECTS_DIR, p.slice('/projects'.length));
        if (!file) { res.writeHead(404); res.end('not found'); return; }
        if (fs.existsSync(file) && fs.statSync(file).isFile()) { serveFile(req, res, file); return; }
        res.writeHead(404); res.end('not found');
        return;
      }
      if (p === '/api/projects') { sendJson(res, 200, await listProjects()); return; }

      // ── 配置页：key 只在这台机器上从浏览器进文件，永远不经过对话 ──
      if (p === '/setup') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(setupPage());
        return;
      }
      if (p === '/api/config' && req.method === 'GET') {
        const { readConfig } = await import('./config.js');
        const cfg = readConfig();
        sendJson(res, 200, {
          file: cfg.file,
          exists: cfg.exists,
          rows: cfg.rows.map(({ key, group, label, hint, secret, fallback, set, source, masked }) => ({
            key, group, label, hint, secret, fallback, set, source, masked,
          })),
        });
        return;
      }
      if (p === '/api/config' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 64 * 1024) throw new Error('请求体过大');
        }
        const data = JSON.parse(body || '{}');
        if (data.token !== SETUP_TOKEN) { sendJson(res, 403, { ok: false, error: '页面令牌不对，刷新配置页重试' }); return; }
        const { writeConfig } = await import('./config.js');
        const values = data.values && typeof data.values === 'object' ? data.values : {};
        const r = await writeConfig(values);
        sendJson(res, 200, { ok: true, file: r.file, written: r.written });
        return;
      }
      if (p === '/api/doctor') {
        const { runDoctor, formatDoctor } = await import('./doctor.js');
        const r = await runDoctor({ network: url.searchParams.get('network') === '1' });
        sendJson(res, 200, { ok: r.ok, text: formatDoctor(r), checks: r.checks });
        return;
      }

      const m = /^\/api\/project\/([a-z0-9_-]+)$/.exec(p);
      if (m) { sendJson(res, 200, await loadProject(m[1])); return; }

      const r = /^\/api\/project\/([a-z0-9_-]+)\/scene\/([A-Za-z0-9_-]+)$/.exec(p);
      if (r && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const { prompt, noImage } = JSON.parse(body || '{}');
        const args = ['scene', path.join(PROJECTS_DIR, r[1], 'project.json'), `--id=${r[2]}`];
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

/**
 * 配置页。故意做成「浏览器 ↔ 本机文件」两点一线：
 * 你在输入框里打的 key 不会进对话、不进日志、不上传，只写进用户目录的那个 .env。
 */
function setupPage() {
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>图文视频工坊 · 配置</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;padding:32px 20px 80px;background:#0d1117;color:#e6edf3;
       font:15px/1.6 "Microsoft YaHei","PingFang SC",system-ui,sans-serif}
  main{max-width:760px;margin:0 auto}
  h1{font-size:22px;margin:0 0 6px}
  h2{font-size:14px;margin:28px 0 10px;color:#7d8590;font-weight:600;letter-spacing:.04em}
  .sub{color:#9aa4b2;margin:0 0 4px;font-size:14px}
  code{background:#161b22;border:1px solid #21262d;border-radius:4px;padding:1px 5px;font-size:13px}
  .field{margin:0 0 14px}
  .field label{display:block;font-size:13px;color:#c9d1d9;margin-bottom:5px}
  .field .hint{font-size:12px;color:#7d8590;margin-top:4px}
  input[type=text],input[type=password]{width:100%;padding:9px 11px;border-radius:6px;
    border:1px solid #30363d;background:#0d1117;color:#e6edf3;font-size:14px;font-family:inherit}
  input:focus{outline:none;border-color:#388bfd;box-shadow:0 0 0 3px rgba(56,139,253,.15)}
  .state{font-size:12px;color:#7d8590;margin-left:8px}
  .clear{font-size:12px;color:#7d8590;margin-left:10px;cursor:pointer;user-select:none}
  .row{display:flex;align-items:center;gap:12px;margin-top:24px;position:sticky;bottom:0;
       background:linear-gradient(to top,#0d1117 70%,transparent);padding:16px 0}
  button{padding:9px 18px;border-radius:6px;border:1px solid #30363d;background:#21262d;
         color:#e6edf3;font-size:14px;font-family:inherit;cursor:pointer}
  button.primary{background:#238636;border-color:#2ea043}
  button:disabled{opacity:.55;cursor:default}
  #msg{font-size:13px}
  .ok{color:#3fb950}.bad{color:#f85149}
  pre{background:#161b22;border:1px solid #21262d;border-radius:6px;padding:12px;
      font-size:12px;line-height:1.6;white-space:pre-wrap;color:#9aa4b2;margin:14px 0 0}
</style></head>
<body><main>
  <h1>配置</h1>
  <p class="sub">这些 Key 只在这台机器上用。填完直接写进 <code id="path">…</code>，
     不进对话、不进日志、不上传。</p>
  <p class="sub">已经是安全值（打码显示）的项，留空就表示不改动。</p>
  <form id="f"><div id="groups">正在读取配置…</div>
    <div class="row">
      <button type="submit" class="primary" id="save">保存</button>
      <button type="button" id="check">检查环境</button>
      <span id="msg"></span>
    </div>
    <pre id="doctor" hidden></pre>
  </form>
</main>
<script>
  var TOKEN = "__TOKEN__";
  var rows = [];
  function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g, function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c]; }); }
  function el(id){ return document.getElementById(id); }

  fetch('/api/config').then(function(r){ return r.json(); }).then(function(j){
    rows = j.rows || [];
    el('path').textContent = j.file;
    if (!rows.length) { el('groups').textContent = '（没有可配置项）'; return; }
    var order = [], byGroup = {};
    rows.forEach(function(r){
      if (!byGroup[r.group]) { byGroup[r.group] = []; order.push(r.group); }
      byGroup[r.group].push(r);
    });
    el('groups').innerHTML = order.map(function(g){
      return '<h2>' + esc(g) + '</h2>' + byGroup[g].map(field).join('');
    }).join('');
  }).catch(function(e){ el('groups').textContent = '读取失败：' + e.message; });

  function field(r){
    var current = r.secret ? '' : (r.masked || '');
    var state = r.set
      ? (r.secret ? '已配置（' + esc(r.masked) + '）' : '')
      : (r.secret ? '未配置' : '');
    var ph = r.secret ? (r.set ? '留空不改，填了就覆盖' : '粘贴到这里') : esc(r.fallback || '');
    var id = 'in-' + r.key;
    return '<div class="field" data-key="' + esc(r.key) + '" data-secret="' + (r.secret ? 1 : 0) + '">'
      + '<label for="' + id + '">' + esc(r.label) + ' <code>' + esc(r.key) + '</code>'
      + '<span class="state">' + state + '</span>'
      + (r.secret && r.set ? '<label class="clear"><input type="checkbox" class="cl"> 清空这项</label>' : '')
      + '</label>'
      + '<input id="' + id + '" type="' + (r.secret ? 'password' : 'text') + '" value="' + esc(current) + '" placeholder="' + ph + '" autocomplete="off" spellcheck="false">'
      + (r.hint ? '<div class="hint">' + esc(r.hint) + '</div>' : '')
      + '</div>';
  }

  el('f').addEventListener('submit', function(ev){
    ev.preventDefault();
    var values = {};
    Array.prototype.forEach.call(document.querySelectorAll('.field'), function(d){
      var key = d.getAttribute('data-key');
      var secret = d.getAttribute('data-secret') === '1';
      var input = d.querySelector('input[type=password],input[type=text]');
      var cl = d.querySelector('input.cl');
      if (secret) {
        if (cl && cl.checked) values[key] = '';
        else if (input && input.value.trim()) values[key] = input.value.trim();
      } else if (input) {
        values[key] = input.value.trim();
      }
    });
    el('save').disabled = true;
    el('msg').className = '';
    el('msg').textContent = '保存中…';
    fetch('/api/config', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ token: TOKEN, values: values }) })
      .then(function(r){ return r.json(); })
      .then(function(j){
        el('save').disabled = false;
        if (j.ok) { el('msg').className='ok'; el('msg').textContent='已保存 → ' + j.file + '（' + j.written + ' 项）'; setTimeout(function(){ location.reload(); }, 900); }
        else { el('msg').className='bad'; el('msg').textContent = j.error || '保存失败'; }
      })
      .catch(function(e){ el('save').disabled = false; el('msg').className='bad'; el('msg').textContent='保存失败：'+e.message; });
  });

  el('check').addEventListener('click', function(){
    var pre = el('doctor');
    pre.hidden = false; pre.textContent = '检查中…';
    fetch('/api/doctor').then(function(r){ return r.json(); }).then(function(j){
      pre.textContent = j.text || '没有结果';
    }).catch(function(e){ pre.textContent = '检查失败：' + e.message; });
  });
</script>
</body></html>`;
  return html.replace('__TOKEN__', SETUP_TOKEN);
}
