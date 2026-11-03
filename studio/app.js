const $ = (id) => document.getElementById(id);
const state = { projects: [], id: null, data: null, sid: null, busy: false, v: 0 };

async function api(url, opts) {
  const res = await fetch(url, opts);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

function setStatus(text, kind = '') {
  const el = $('status');
  el.textContent = text;
  el.className = `status ${kind}`;
}

function fmt(sec) {
  if (sec == null) return '—';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return m ? `${m}:${String(s).padStart(2, '0')}` : `${sec.toFixed(1)}s`;
}

async function boot() {
  state.projects = await api('/api/projects');
  const sel = $('projects');
  sel.innerHTML = '';
  for (const p of state.projects) {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = `${p.id} · ${p.title}`;
    sel.appendChild(o);
  }
  sel.addEventListener('change', () => selectProject(sel.value));
  const first = state.projects.find((p) => p.hasVideo) || state.projects[0];
  if (!first) { setStatus('还没有项目。先运行 node src/cli.js build --yes。'); return; }
  sel.value = first.id;
  await selectProject(first.id);
}

async function selectProject(id) {
  state.id = id;
  state.sid = null;
  state.data = await api(`/api/project/${id}`);
  const d = state.data;
  const r = d.result;
  $('meta').textContent = `${d.scenes.length} 镜 · ${r?.duration ? r.duration + 's' : '未渲染'} · ${r?.sizeMB ? r.sizeMB + 'MB' : ''} · ${d.aspect || ''}`;
  const badge = $('badge');
  if (r?.qc) {
    badge.textContent = r.qc.ok ? '质检通过' : '质检未通过';
    badge.className = `badge ${r.qc.ok ? 'ok' : 'bad'}`;
  } else {
    badge.textContent = '未渲染';
    badge.className = 'badge';
  }

  const player = $('player');
  if (r?.out) {
    player.src = `/projects/${id}/out/${id}.mp4?v=${Date.now()}`;
    player.poster = `/projects/${id}/out/cover.jpg?v=${Date.now()}`;
    player.style.display = '';
  } else {
    player.removeAttribute('src');
    player.style.display = 'none';
  }
  player.onloadedmetadata = () => {
    if (state.sid) {
      const s = d.scenes.find((x) => x.id === state.sid);
      if (s) player.currentTime = Math.max(0, s.start + 0.05);
    }
  };

  renderShots();
  if (d.scenes.length) selectShot(d.scenes[0].id);
}

function renderShots() {
  const box = $('shots');
  box.innerHTML = '';
  state.v += 1;
  for (const s of state.data.scenes) {
    const el = document.createElement('div');
    el.className = `shot${s.id === state.sid ? ' active' : ''}`;
    el.dataset.sid = s.id;
    const img = document.createElement('img');
    img.src = s.hasImage ? `/projects/${state.id}/img/${s.id}.jpg?v=${state.v}` : '';
    img.alt = s.id;
    img.loading = 'lazy';
    const body = document.createElement('div');
    body.className = 'body';
    body.innerHTML = `<div class="idx">${s.id} · ${fmt(s.duration)}</div><div class="text"></div><div class="who"></div>`;
    body.querySelector('.text').textContent = s.narration || '（无台词）';
    const who = body.querySelector('.who');
    for (const c of s.cast || []) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = c;
      who.appendChild(chip);
    }
    el.append(img, body);
    el.addEventListener('click', () => selectShot(s.id));
    box.appendChild(el);
  }
}

function selectShot(sid) {
  state.sid = sid;
  const s = state.data.scenes.find((x) => x.id === sid);
  for (const el of document.querySelectorAll('.shot')) el.classList.toggle('active', el.dataset.sid === sid);
  $('sid').textContent = sid;
  $('prompt').value = s.subject || '';
  $('shotmeta').innerHTML = '';
  const lines = [
    `时长 ${fmt(s.duration)}${s.start != null ? ` · 起始 ${fmt(s.start)}` : ''}`,
    s.shot ? `景别 ${s.shot}` : '',
    s.transition ? `转场 ${s.transition}` : '',
    s.cast?.length ? `角色 ${s.cast.join(' / ')}` : '无角色',
  ].filter(Boolean);
  $('shotmeta').textContent = lines.join('\n');
  $('current').textContent = s.narration || '';
  const player = $('player');
  if (player.src && s.start != null) player.currentTime = Math.max(0, s.start + 0.05);
  setStatus('');
}

async function run(kind) {
  if (state.busy || !state.sid) return;
  state.busy = true;
  const btns = [$('btn-regen'), $('btn-rerender')];
  btns.forEach((b) => (b.disabled = true));

  const sid = state.sid;
  const prompt = $('prompt').value.trim();
  const startedAt = Date.now();
  const tick = setInterval(() => setStatus(`${kind === 'regen' ? '重新出图并重渲' : '重渲'}中… ${Math.round((Date.now() - startedAt) / 1000)}s`), 500);
  setStatus('开始…');

  try {
    const body = kind === 'regen' ? { prompt } : { noImage: true };
    const r = await api(`/api/project/${state.id}/scene/${sid}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    clearInterval(tick);
    if (!r.ok) throw new Error(r.error || '引擎返回失败');
    const keep = state.sid;
    await selectProject(state.id);
    selectShot(keep);
    setStatus(`${sid} 已更新：${r.frames} 帧重渲 · ${r.image ? '已重新出图' : '沿用原图'}`, 'ok');
  } catch (e) {
    clearInterval(tick);
    setStatus(String(e.message), 'err');
  } finally {
    state.busy = false;
    btns.forEach((b) => (b.disabled = false));
  }
}

$('btn-regen').addEventListener('click', () => run('regen'));
$('btn-rerender').addEventListener('click', () => run('rerender'));

boot().catch((e) => setStatus(String(e.message), 'err'));
