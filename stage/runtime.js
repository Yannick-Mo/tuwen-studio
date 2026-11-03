/**
 * Stage 运行时：seek(t) 是纯函数。
 * 预览 = 每帧调 seek；导出 = 每帧调 seek 后截图。两条路径共用同一份渲染逻辑，
 * 所以「预览什么样，导出就是什么样」不是承诺，而是结构决定的。
 */
(function () {
  'use strict';

  const S = {
    W: 1080, H: 1920, fps: 30, grade: 'none',
    root: null, scenes: [], capEl: null, capKey: null, capSpans: [],
    fx: null, fxCtx: null, fxPat: null, noise: null, vig: null,
    primary: null, ready: null,
  };

  const FAMILY = '"Microsoft YaHei", "Noto Sans SC", "PingFang SC", sans-serif';
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  const EASE = {
    linear: (p) => p,
    outCubic: (p) => 1 - Math.pow(1 - p, 3),
    inOutSine: (p) => -(Math.cos(Math.PI * p) - 1) / 2,
    outExpo: (p) => (p >= 1 ? 1 : 1 - Math.pow(2, -10 * p)),
    outBack: (p) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2); },
  };
  const ease = (name, p) => (EASE[name] || EASE.outCubic)(clamp(p, 0, 1));

  function rng(seed) {
    let s = (seed >>> 0) || 1;
    return function () {
      s ^= s << 13; s >>>= 0;
      s ^= s >> 17;
      s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
  }
  const strSeed = (str) => {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  };

  // ---------- 文本排版 ----------
  const mcv = document.createElement('canvas');
  const mctx = mcv.getContext('2d');
  const fontOf = (size, weight) => `${weight} ${size}px ${FAMILY}`;
  function measure(text, font) { mctx.font = font; return mctx.measureText(text).width; }

  const NO_START = '，。、；：？！）》」』】”’…—·%';
  const NO_END = '（《「『【“‘';
  // 换行时别把词拆开：「一/个教室」比「一个/教室」难读得多
  const NO_LINE_START = '的了是在也都就而和与个把被让给对从向到里着过一不很太又才再还这那有没';

  function tokenize(text) {
    const out = [];
    const re = /[A-Za-z0-9]+(?:['’\-][A-Za-z0-9]+)*|[ \t]+|[\s\S]/gu;
    let m;
    while ((m = re.exec(text)) !== null) out.push(m[0]);
    return out;
  }

  /** 按宽度断行，带中文禁则（标点不出现在行首）。 */
  function layoutText(text, maxW, font) {
    mctx.font = font;
    const tokens = tokenize(text.replace(/\s+/g, ' ').trim());
    const lines = [];
    let line = '';
    for (const tk of tokens) {
      const test = line + tk;
      if (line === '' || mctx.measureText(test).width <= maxW) { line = test; continue; }
      if (NO_START.includes(tk[0])) { line = test; continue; }        // 标点挤在行尾
      if (NO_END.includes(line[line.length - 1])) { lines.push(line + tk); line = ''; continue; }
      lines.push(line.replace(/\s+$/, ''));
      line = tk.replace(/^\s+/, '');
    }
    if (line.trim()) lines.push(line);
    return lines;
  }

  const TEXT_STYLE = {
    title:   { size: 92,  weight: 800, color: '#ffffff', lh: 1.26, shadow: '0 8px 36px rgba(0,0,0,.72), 0 2px 8px rgba(0,0,0,.55)' },
    keyword: { size: 122, weight: 900, color: '#ffd166', lh: 1.14, shadow: '0 10px 46px rgba(0,0,0,.85)' },
    sub:     { size: 50,  weight: 500, color: 'rgba(255,255,255,.88)', lh: 1.55, shadow: '0 4px 22px rgba(0,0,0,.75)' },
    chip:    { size: 38,  weight: 700, color: '#0b1220', lh: 1.2, shadow: 'none' },
  };

  // ---------- 镜头运动 ----------
  function layerMotion(layer, p, W, H) {
    const m = layer.motion || {};
    const name = m.preset || 'none';
    const amt = m.amount ?? 0.1;
    const e = ease(m.ease || 'outCubic', p);
    let scale = 1, x = 0, y = 0, rot = 0, blur = 0, opacity = 1;

    switch (name) {
      case 'push-in':   scale = 1.02 + amt * e; break;
      case 'pull-out':  scale = 1.02 + amt * (1 - e); break;
      case 'pan-left':  scale = 1 + amt * 2.2; x = (0.5 - e) * amt * W; break;
      case 'pan-right': scale = 1 + amt * 2.2; x = (e - 0.5) * amt * W; break;
      case 'pan-up':    scale = 1 + amt * 2.2; y = (0.5 - e) * amt * H; break;
      case 'pan-down':  scale = 1 + amt * 2.2; y = (e - 0.5) * amt * H; break;
      case 'float':
        scale = 1 + amt * 0.5 + Math.sin(p * Math.PI * 2) * 0.006;
        x = Math.sin(p * Math.PI * 2 + 0.8) * amt * 60;
        y = Math.cos(p * Math.PI * 2) * amt * 45;
        break;
      case 'drift':
        scale = 1.1 + amt * 0.2;
        x = Math.sin(p * Math.PI * 1.4 + 1.2) * amt * 40;
        y = (0.5 - e) * amt * H * 0.5;
        break;
      case 'shake': {
        const k = Math.max(0, 1 - Math.abs(p - 0.5) * 5);
        scale = 1 + amt;
        x = Math.sin(p * 150) * 20 * k;
        y = Math.cos(p * 121) * 14 * k;
        blur = 0;
        break;
      }
      case 'still': scale = 1 + amt; break;
      default: scale = 1;
    }
    return { scale, x, y, rot, blur, opacity };
  }

  function applyTextMotion(node, layer, local) {
    const at = layer.at ?? 0;
    const dur = layer.motion?.duration ?? 0.55;
    const preset = layer.motion?.preset || 'fade-up';
    const p = clamp((local - at) / dur, 0, 1);
    const el = node.el;

    if (local < at) { el.style.opacity = '0'; el.style.visibility = 'hidden'; return; }
    el.style.visibility = 'visible';

    if (preset === 'per-char' || preset === 'typewriter') {
      el.style.opacity = '1';
      el.style.transform = 'none';
      const { spans } = node;
      for (let i = 0; i < spans.length; i++) {
        if (preset === 'typewriter') spans[i].style.opacity = i / spans.length <= p ? '1' : '0';
        else {
          const cp = ease('outCubic', clamp((p * spans.length - i) / 1.4, 0, 1));
          spans[i].style.opacity = String(cp);
          spans[i].style.transform = `translateY(${(1 - cp) * 26}px)`;
        }
      }
      return;
    }

    if (preset === 'pop-in') {
      const e = ease('outBack', p);
      el.style.opacity = String(clamp(p * 2, 0, 1));
      el.style.transform = `scale(${(0.86 + 0.14 * e).toFixed(4)})`;
      return;
    }
    if (preset === 'none') { el.style.opacity = '1'; el.style.transform = 'none'; return; }

    const e = ease('outCubic', p);
    el.style.opacity = String(e);
    el.style.transform = `translateY(${(1 - e) * 30}px)`;
    el.style.filter = p < 1 ? `blur(${(1 - e) * 5}px)` : '';
  }

  // ---------- 图层构建 ----------
  function buildImageLayer(layer) {
    const wrap = document.createElement('div');
    wrap.className = 'lyr';
    wrap.style.zIndex = String(layer.z || 0);
    const img = document.createElement('img');
    img.src = layer.src;
    img.decoding = 'async';
    img.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;object-fit:cover;transform-origin:50% 50%;will-change:transform,opacity,filter';
    wrap.appendChild(img);
    return { type: 'image', el: wrap, img, layer };
  }

  function buildTextLayer(layer) {
    const st = TEXT_STYLE[layer.style] || TEXT_STYLE.title;
    const W = layer.w ?? (S.W - 180);
    const el = document.createElement('div');
    el.style.cssText = `position:absolute;z-index:${layer.z ?? 50};left:${layer.x ?? 90}px;top:${layer.y ?? 320}px;width:${W}px;`;
    el.style.font = fontOf(st.size, st.weight);
    el.style.color = layer.color || st.color;
    el.style.lineHeight = String(st.lh);
    el.style.textShadow = st.shadow;
    el.style.textAlign = layer.align || 'left';
    el.style.willChange = 'transform,opacity,filter';

    const lines = layoutText(layer.text || '', W, fontOf(st.size, st.weight));
    const spans = [];
    const emphasis = new Set(layer.emphasis || []);
    for (const line of lines) {
      const div = document.createElement('div');
      for (const ch of line) {
        const sp = document.createElement('span');
        sp.textContent = ch;
        sp.style.display = 'inline-block';
        sp.style.whiteSpace = 'pre';
        if (emphasis.has(ch)) sp.style.color = layer.emphasisColor || '#ffd166';
        div.appendChild(sp);
        spans.push(sp);
      }
      el.appendChild(div);
    }
    return { type: 'text', el, spans, layer };
  }

  function buildStickerLayer(layer) {
    const el = document.createElement('img');
    el.src = layer.src;
    const w = layer.w ?? 200;
    el.style.cssText = `position:absolute;z-index:${layer.z ?? 60};left:${layer.x ?? 0}px;top:${layer.y ?? 0}px;width:${w}px;height:auto;transform-origin:50% 50%;will-change:transform,opacity`;
    return { type: 'sticker', el, layer };
  }

  function buildShapeLayer(layer) {
    const el = document.createElement('div');
    const w = layer.w ?? 400, h = layer.h ?? 8;
    el.style.cssText = `position:absolute;z-index:${layer.z ?? 40};left:${layer.x ?? 90}px;top:${layer.y ?? 0}px;width:${w}px;height:${h}px;border-radius:${layer.radius ?? h / 2}px;background:${layer.color || '#ffd166'};will-change:transform,opacity`;
    return { type: 'shape', el, layer };
  }

  function buildLayer(layer) {
    switch (layer.type) {
      case 'image': return buildImageLayer(layer);
      case 'text': return buildTextLayer(layer);
      case 'sticker': return buildStickerLayer(layer);
      case 'shape': return buildShapeLayer(layer);
      default: return null;
    }
  }

  // ---------- 粒子 ----------
  function makeParticles(kind, density, seed) {
    const r = rng(seed);
    const n = Math.round(40 + clamp(density, 0, 1) * 160);
    const parts = [];
    for (let i = 0; i < n; i++) {
      parts.push({
        x: r(), y: r(), z: 0.35 + r() * 0.65,
        vy: 0.006 + r() * 0.03,
        sw: 0.4 + r() * 1.6,
        ph: r() * Math.PI * 2,
        a: 0.15 + r() * 0.55,
      });
    }
    return { kind, parts };
  }

  function drawParticles(ctx, scene, local) {
    const P = scene.parts;
    if (!P) return;
    const { W, H } = S;
    for (const p of P.parts) {
      let y = (p.y + p.vy * local * 6) % 1;
      const x = (p.x + Math.sin(local * p.sw + p.ph) * 0.02) * W;
      const yy = y * H;
      const rad = 1.2 + p.z * 3.2;
      const alpha = p.a * (0.55 + 0.45 * Math.sin(local * 2 + p.ph));
      if (P.kind === 'speed') {
        ctx.strokeStyle = `rgba(255,255,255,${alpha * 0.5})`;
        ctx.lineWidth = rad * 0.6;
        ctx.beginPath();
        ctx.moveTo(x, yy);
        ctx.lineTo(x + 60 * p.z, yy - 160 * p.z * (0.5 + p.z));
        ctx.stroke();
      } else {
        const warm = P.kind === 'embers';
        ctx.fillStyle = warm
          ? `rgba(255,${140 + Math.round(p.z * 80)},80,${alpha})`
          : `rgba(255,255,255,${alpha * 0.75})`;
        ctx.beginPath();
        ctx.arc(x, yy, rad, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  function makeNoise() {
    const c = document.createElement('canvas');
    c.width = 160; c.height = 160;
    const g = c.getContext('2d');
    const img = g.createImageData(160, 160);
    const r = rng(20240801);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = Math.round(r() * 255);
      img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = v;
      img.data[i + 3] = Math.round(r() * 26);
    }
    g.putImageData(img, 0, 0);
    return c;
  }

  function drawGrain(ctx, amount, t) {
    // 已弃用：改用 CSS 平铺（见 mount 里的 #grain）
    void amount; void t;
  }

  // ---------- 字幕 ----------
  /** 把词级时间戳摊到每个字上（没有词级时间就返回 null，退回线性） */
  function charTimes(cap) {
    const chars = [...cap.text];
    const n = chars.length;
    const words = cap.words;
    if (!words || !words.length) return null;
    const times = new Array(n).fill(null);
    let pos = 0;
    for (const w of words) {
      const wc = [...(w.w || '')];
      while (pos < n && /\s/.test(chars[pos])) pos++;
      const span = Math.max(0.001, w.end - w.start);
      for (let k = 0; k < wc.length && pos < n; k++, pos++) {
        times[pos] = {
          start: w.start + span * (k / Math.max(1, wc.length)),
          end: w.start + span * ((k + 1) / Math.max(1, wc.length)),
        };
      }
    }
    return times;
  }

  /** 两行时重新配平，避免「年。」这种孤字行 */
  function balanceLines(lines, maxW, font) {
    if (lines.length !== 2) return lines;
    const chars = [...lines.join('')];
    const n = chars.length;
    if (n < 6) return lines;
    let best = null;
    const from = Math.max(1, Math.ceil(n * 0.28));
    const to = Math.min(n - 1, Math.floor(n * 0.72));
    for (let i = from; i <= to; i++) {
      const afterPunct = /[，。、；：？！]/.test(chars[i - 1] || '');
      if (!afterPunct && (NO_START.includes(chars[i]) || NO_LINE_START.includes(chars[i]))) continue;
      const a = chars.slice(0, i).join('');
      const b = chars.slice(i).join('');
      const wa = measure(a, font);
      const wb = measure(b, font);
      if (wa > maxW || wb > maxW) continue;
      // 能断在标点后面就优先断在标点后面，比单纯求两行齐宽好读
      const bonus = /[，。、；：？！]/.test(chars[i - 1] || '') ? -420 : 0;
      const score = Math.abs(wa - wb) + bonus;
      if (!best || score < best.score) best = { score, lines: [a, b] };
    }
    return best ? best.lines : lines;
  }

  function capLayout(cap, sceneKey) {
    const cs = S.capStyle || CAP_STYLES.karaoke;
    // 字号和边距按宽度等比缩放：9:16 是基准，16:9 才不会字幕小得像注释
    const k = S.W / 1080;
    const baseSize = Math.round((cap.size || 62) * k * (cs.scale || 1));
    const maxW = S.W - Math.round(150 * k);
    let size = baseSize;
    let lines = [];
    const font = (s) => fontOf(s, 800);
    for (let attempt = 0; attempt < 6; attempt++) {
      lines = layoutText(cap.text, maxW, font(size));
      if (lines.length <= 2) break;
      size -= 4;
    }
    if (lines.length === 2) lines = balanceLines(lines, maxW, font(size));
    if (lines.length > 2) {
      lines = lines.slice(0, 2);
      lines[1] = lines[1].slice(0, Math.max(1, lines[1].length)) + '…';
    }
    return { lines, size, key: sceneKey };
  }

  // 字幕样式：一条片子只用一种。漫画字靠粗描边 + 硬投影 + 描边色块，不是换字体就行。
  const CAP_STYLES = {
    karaoke: {
      color: '#fff', stroke: '1px rgba(0,0,0,.42)',
      shadow: '0 2px 0 rgba(0,0,0,.55), 0 6px 22px rgba(0,0,0,.85), 0 0 46px rgba(0,0,0,.6)',
      weight: 800, track: '0.5px', gap: 8, reveal: 'karaoke', dim: 0.52, dimScale: 0.985, rise: 16, tilt: 0,
    },
    comic: {
      color: '#ffe14d', stroke: '9px #0b0b0b',
      shadow: '6px 6px 0 rgba(0,0,0,.9)',
      weight: 900, track: '2px', gap: 2, reveal: 'pop', dim: 0, dimScale: 1, rise: 0, tilt: -2.5, scale: 1.22,
    },
    impact: {
      color: '#fff', stroke: '8px #000',
      shadow: '0 0 0 rgba(0,0,0,0)',
      weight: 900, track: '3px', gap: 2, reveal: 'pop', dim: 0, dimScale: 1, rise: 0, tilt: 0, scale: 1.15,
    },
    clean: {
      color: '#fff', stroke: '0px rgba(0,0,0,0)',
      shadow: '0 2px 14px rgba(0,0,0,.95)',
      weight: 600, track: '0.2px', gap: 6, reveal: 'fade', dim: 0.7, dimScale: 1, rise: 10, tilt: 0, scale: 0.92,
    },
  };

  function buildCaptionDom(cap, layout) {
    const cs = S.capStyle || CAP_STYLES.karaoke;
    S.capEl.innerHTML = '';
    S.capSpans = [];
    const spans = [];
    const emphasis = new Set(cap.emphasis || []);

    for (let li = 0; li < layout.lines.length; li++) {
      const line = document.createElement('div');
      line.className = 'cap-line';
      line.style.font = fontOf(layout.size, cs.weight);
      line.style.color = cs.color;
      line.style.textShadow = cs.shadow;
      line.style.webkitTextStroke = cs.stroke;
      line.style.paintOrder = 'stroke fill';
      line.style.letterSpacing = cs.track;
      line.style.marginTop = li === 0 ? '0px' : `${cs.gap}px`;
      if (cs.tilt) line.style.transform = `rotate(${cs.tilt}deg)`;

      for (const ch of layout.lines[li]) {
        const sp = document.createElement('span');
        sp.className = 'w';
        sp.textContent = ch;
        if (emphasis.has(ch)) sp.style.color = '#ffd166';
        line.appendChild(sp);
        spans.push(sp);
      }
      S.capEl.appendChild(line);
      spans.push(null); // 行分隔
    }
    S.capSpans = spans.filter(Boolean);
    return spans;
  }

  function captionTimes(cap) {
    // 返回每个字符的 [start,end]（相对 scene）
    const chars = (cap._chars || []);
    return chars;
  }

  function renderCaptions(t) {
    const s = S.primary;
    if (!s) { S.capEl.style.opacity = '0'; return; }
    const local = t - s.start;
    const cap = s.caps.find((c) => local >= c.start - 0.001 && local <= c.end + 0.001);
    if (!cap) { S.capEl.style.opacity = '0'; S.capKey = null; return; }

    const key = `${s.id}:${cap._i}`;
    if (key !== S.capKey) {
      S.capKey = key;
      buildCaptionDom(cap, cap._layout);
    }

    const age = local - cap.start;
    const cs = S.capStyle || CAP_STYLES.karaoke;
    const a = clamp(age / 0.16, 0, 1);
    S.capEl.style.opacity = String(a);
    S.capEl.style.transform = `translateY(${((1 - a) * cs.rise).toFixed(2)}px)`;

    // 逐字出场：karaoke 是「暗→亮」，pop 是「弹出」，fade 是一整行淡入
    const totalChars = [...cap.text].length || 1;
    const ct = cap._charTimes;
    let idx = 0;
    for (const sp of S.capSpans) {
      if (idx >= totalChars) break;
      const t0 = ct && ct[idx]
        ? ct[idx].start
        : cap.start + (idx / totalChars) * Math.max(0.001, cap.end - cap.start);
      const on = local >= t0;
      if (cs.reveal === 'pop') {
        if (on) {
          const e = ease('outBack', clamp((local - t0) / 0.14, 0, 1));
          sp.style.opacity = '1';
          sp.style.transform = `scale(${(0.55 + 0.45 * e).toFixed(3)})`;
        } else {
          sp.style.opacity = '0';
        }
      } else if (cs.reveal === 'fade') {
        sp.style.opacity = '1';
      } else {
        sp.style.opacity = on ? '1' : String(cs.dim);
        sp.style.transform = on ? 'scale(1)' : `scale(${cs.dimScale})`;
      }
      idx++;
    }
  }

  // ---------- 转场 ----------
  function applyIn(type, q) {
    const e = ease('outCubic', q);
    const W = S.W;
    switch (type) {
      case 'crossfade': return { op: e, sx: 1, tx: 0, blur: 0 };
      case 'zoom-blur': return { op: clamp(e * 1.2, 0, 1), sx: 1.14 - 0.14 * e, tx: 0, blur: 9 * (1 - e) };
      case 'whip-pan': return { op: clamp(e * 1.4, 0, 1), sx: 1.02, tx: W * 0.55 * (1 - e), blur: 10 * (1 - e) };
      case 'wipe': return { op: 1, sx: 1, tx: 0, blur: 0, clip: `inset(0 0 0 ${(1 - e) * 100}%)` };
      case 'flash': return { op: clamp(e * 2, 0, 1), sx: 1, tx: 0, blur: 0, bright: 1 + 1.6 * Math.sin(Math.PI * q) };
      case 'cut': return { op: 1, sx: 1, tx: 0, blur: 0 };
      default: return { op: e, sx: 1, tx: 0, blur: 0 };
    }
  }

  function applyOut(type, q) {
    const e = ease('outCubic', q);
    const W = S.W;
    switch (type) {
      case 'crossfade': return { op: 1 - e, sx: 1, tx: 0, blur: 0 };
      case 'zoom-blur': return { op: clamp(1 - e * 1.1, 0, 1), sx: 1 + 0.17 * e, tx: 0, blur: 9 * e };
      case 'whip-pan': return { op: clamp(1 - e * 1.2, 0, 1), sx: 1.02, tx: -W * 0.55 * e, blur: 10 * e };
      case 'wipe': return { op: 1, sx: 1, tx: 0, blur: 0 };
      case 'flash': return { op: 1 - clamp(1 - e * 2, 0, 1) * 0.0, sx: 1, tx: 0, blur: 0, bright: 1 + 1.2 * Math.sin(Math.PI * q) };
      case 'cut': return { op: 1, sx: 1, tx: 0, blur: 0 };
      default: return { op: 1 - e, sx: 1, tx: 0, blur: 0 };
    }
  }

  // ---------- 主循环 ----------
  function seek(tMs) {
    const t = tMs / 1000;
    const active = [];
    for (const s of S.scenes) {
      const local = t - s.start;
      const visible = local >= -0.0005 && local <= s.duration + 0.0005;
      if (!visible) {
        if (s.visible) { s.el.style.display = 'none'; s.visible = false; }
        continue;
      }
      if (!s.visible) { s.el.style.display = 'block'; s.visible = true; }
      active.push(s);
    }
    S.primary = active.length ? active[active.length - 1] : null;

    for (const s of active) {
      const local = t - s.start;
      const p = clamp(local / s.duration, 0, 1);
      let op = 1, sx = 1, tx = 0, blur = 0, bright = 1, clip = '';

      const prev = S.scenes[s.idx - 1];
      const next = S.scenes[s.idx + 1];

      if (prev) {
        const overlap = prev.start + prev.duration - s.start;
        if (prev.transitionOut && overlap > 0.001 && local < overlap) {
          const r = applyIn(prev.transitionOut.type, clamp(local / overlap, 0, 1));
          op *= r.op; sx *= r.sx; tx += r.tx; blur = Math.max(blur, r.blur);
          bright *= r.bright || 1; if (r.clip) clip = r.clip;
        }
      }
      if (next) {
        const overlap = s.start + s.duration - next.start;
        if (s.transitionOut && overlap > 0.001 && t >= next.start) {
          const r = applyOut(s.transitionOut.type, clamp((t - next.start) / overlap, 0, 1));
          op *= r.op; sx *= r.sx; tx += r.tx; blur = Math.max(blur, r.blur);
          bright *= r.bright || 1;
        }
      }

      s.el.style.opacity = op.toFixed(4);
      s.el.style.transform = `translate3d(${tx.toFixed(2)}px,0,0) scale(${sx.toFixed(4)})`;
      s.el.style.clipPath = clip;
      const filters = [S.grade];
      if (blur > 0.06) filters.push(`blur(${blur.toFixed(2)}px)`);
      if (bright !== 1) filters.push(`brightness(${bright.toFixed(3)})`);
      s.el.style.filter = filters.filter((f) => f && f !== 'none').join(' ');

      for (const node of s.layers) {
        if (node.type === 'image') {
          const m = layerMotion(node.layer, p, S.W, S.H);
          node.img.style.transform = `translate3d(${m.x.toFixed(2)}px,${m.y.toFixed(2)}px,0) scale(${m.scale.toFixed(4)}) rotate(${m.rot}deg)`;
          node.img.style.opacity = String(m.opacity);
        } else if (node.type === 'text') {
          applyTextMotion(node, node.layer, local);
        } else if (node.type === 'sticker') {
          const at = node.layer.at ?? 0.15;
          const q = clamp((local - at) / (node.layer.motion?.duration ?? 0.45), 0, 1);
          const e = ease('outBack', q);
          node.el.style.opacity = String(clamp(q * 2.2, 0, 1));
          node.el.style.transform = `scale(${(0.5 + 0.5 * e).toFixed(4)}) rotate(${node.layer.rotate || 0}deg)`;
        } else if (node.type === 'shape') {
          const at = node.layer.at ?? 0;
          const q = clamp((local - at) / (node.layer.motion?.duration ?? 0.6), 0, 1);
          const e = ease('outCubic', q);
          node.el.style.opacity = String(e);
          if (node.layer.grow !== false) node.el.style.transform = `scaleX(${e.toFixed(4)})`;
          node.el.style.transformOrigin = '0% 50%';
        }
      }
    }

    renderCaptions(t);

    const ctx = S.fxCtx;
    ctx.clearRect(0, 0, S.W, S.H);
    if (S.primary) {
      const fx = S.primary.fx || {};
      if (S.primary.parts) drawParticles(ctx, S.primary, t - S.primary.start);
      const g = clamp(fx.grain || 0, 0, 1);
      S.grain.style.opacity = String(g * 0.9);
      if (g > 0) {
        const f = Math.round(t * S.fps);
        S.grain.style.backgroundPosition = `${(f * 37) % 160}px ${(f * 61) % 160}px`;
      }
      S.vig.style.opacity = String(fx.vignette ?? 0.3);
    } else {
      S.grain.style.opacity = '0';
      S.vig.style.opacity = '0';
    }
  }

  // ---------- 挂载 ----------
  async function mount(project) {
    S.W = project.size[0];
    S.H = project.size[1];
    S.fps = project.fps || 30;
    S.grade = project.grade || 'none';
    S.capStyle = CAP_STYLES[project.captionStyle] || CAP_STYLES.karaoke;

    const root = document.getElementById('root');
    root.innerHTML = '';
    root.style.width = S.W + 'px';
    root.style.height = S.H + 'px';
    document.body.style.width = S.W + 'px';
    document.body.style.height = S.H + 'px';
    S.root = root;
    S.scenes = [];
    S.capKey = null;

    for (let i = 0; i < project.scenes.length; i++) {
      const sc = project.scenes[i];
      const el = document.createElement('div');
      el.className = 'scene';
      el.style.zIndex = String(i + 1);
      el.style.display = 'none';
      el.style.transformOrigin = '50% 50%';

      const layers = [];
      for (const layer of sc.layers || []) {
        const node = buildLayer(layer);
        if (!node) continue;
        el.appendChild(node.el);
        layers.push(node);
      }

      const caps = (sc.captions || []).map((c, ci) => {
        const base = { ...c, _i: ci };
        base.start = c.start ?? 0;
        base.end = c.end ?? (sc.duration ?? 3);
        base._layout = capLayout(base, sc.id);
        base._charTimes = charTimes(base);
        return base;
      });

      root.appendChild(el);
      S.scenes.push({
        id: sc.id, idx: i, start: sc.start, duration: sc.duration,
        el, layers, caps,
        fx: sc.fx || {}, transitionOut: sc.transitionOut || null,
        parts: sc.fx?.particles ? makeParticles(sc.fx.particles, sc.fx.density ?? 0.4, strSeed(sc.id)) : null,
        visible: false,
      });
    }

    // 字幕层
    const capEl = document.createElement('div');
    capEl.id = 'captions';
    capEl.style.bottom = `${Math.round(S.H * 0.172)}px`;
    capEl.style.opacity = '0';
    root.appendChild(capEl);
    S.capEl = capEl;

    // 粒子层
    const fxc = document.createElement('canvas');
    fxc.id = 'fx';
    fxc.width = S.W; fxc.height = S.H;
    root.appendChild(fxc);
    S.fx = fxc;
    S.fxCtx = fxc.getContext('2d');

    // 颗粒：CSS 平铺 + 每帧位移，比在 canvas 上刷全屏快一个数量级
    const noise = makeNoise();
    const grain = document.createElement('div');
    grain.id = 'grain';
    grain.style.cssText = 'position:absolute;inset:0;z-index:950;pointer-events:none;opacity:0;background-repeat:repeat';
    grain.style.backgroundImage = `url(${noise.toDataURL('image/png')})`;
    root.appendChild(grain);
    S.grain = grain;

    // 暗角
    const vig = document.createElement('div');
    vig.id = 'vignette';
    vig.style.background = `radial-gradient(ellipse at 50% 46%, rgba(0,0,0,0) 38%, rgba(0,0,0,.55) 82%, rgba(0,0,0,.8) 100%)`;
    vig.style.opacity = '0';
    root.appendChild(vig);
    S.vig = vig;

    if (document.fonts && document.fonts.ready) await document.fonts.ready;

    const imgs = Array.from(root.querySelectorAll('img'));
    await Promise.all(imgs.map((im) => (im.decode ? im.decode().catch(() => {}) : Promise.resolve())));

    seek(0);
    return true;
  }

  window.__mount = mount;
  window.__seek = seek;
  window.__meta = () => ({ w: S.W, h: S.H, fps: S.fps, duration: (S.scenes.at(-1) || {}).start + (S.scenes.at(-1) || {}).duration });
})();
