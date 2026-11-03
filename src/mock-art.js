/**
 * 占位图生成器（mock provider）。
 * 真实项目里这一层换成 Seedream / 万相 / Nano Banana 的适配器即可；
 * 接口一致：{ prompt, aspect, palette, motif, seed } -> 一张图。
 * 这里用 Canvas 画抽象画面，保证整条管线在没有任何 API key 时也能跑通。
 */
import path from 'node:path';
import { ensureDir } from './util.js';

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:#000;overflow:hidden}canvas{display:block}
</style></head><body><canvas id="c"></canvas>
<script>
const C = document.getElementById('c');
let W = 1080, H = 1920;
function hexA(hex, a) {
  const n = parseInt(hex.replace('#',''), 16);
  const r = (n>>16)&255, g = (n>>8)&255, b = n&255;
  return 'rgba('+r+','+g+','+b+','+a+')';
}
function rng(seed){ let s=(seed>>>0)||1; return ()=>{ s^=s<<13; s>>>=0; s^=s>>17; s^=s<<5; s>>>=0; return s/4294967296; }; }
function blob(ctx,x,y,r,color,a){
  const g=ctx.createRadialGradient(x,y,0,x,y,r);
  g.addColorStop(0,hexA(color,a)); g.addColorStop(.55,hexA(color,a*.45)); g.addColorStop(1,hexA(color,0));
  ctx.fillStyle=g; ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2); ctx.fill();
}
function stars(ctx,r,n,W,H){
  for(let i=0;i<n;i++){
    const x=r()*W, y=r()*H, s=r()*1.9+.3, a=r()*.7+.12;
    ctx.fillStyle='rgba(255,255,255,'+a.toFixed(3)+')';
    ctx.beginPath(); ctx.arc(x,y,s,0,Math.PI*2); ctx.fill();
  }
}
window.__draw = function(spec){
  const { w, h, seed, palette, motif, intensity } = spec;
  W=w; H=h; C.width=w; C.height=h;
  const ctx=C.getContext('2d');
  const r=rng(seed);
  const p1=palette[1]||'#1e3a8a', p2=palette[2]||'#f59e0b', p0=palette[0]||'#0b1220';

  const bg=ctx.createLinearGradient(0,0,w*.35,h);
  bg.addColorStop(0,'#05070d'); bg.addColorStop(.45,p0); bg.addColorStop(1,'#03040a');
  ctx.fillStyle=bg; ctx.fillRect(0,0,w,h);

  blob(ctx, w*.2, h*.18, w*.85, p1, .55);
  blob(ctx, w*.85, h*.7, w*.8, p2, .22);
  blob(ctx, w*.5, h*.42, w*.55, p1, .35);

  stars(ctx, r, Math.round(220*intensity), w, h);

  const cx=w*.5, cy=h*.43;
  if (motif==='blackhole' || motif==='photo') {
    const R=w*.29;
    for(let i=0;i<3;i++){
      const rr=R*(1.35+i*.16);
      ctx.save(); ctx.translate(cx,cy); ctx.rotate(-.28);
      const g=ctx.createLinearGradient(-rr,0,rr,0);
      g.addColorStop(0,hexA(p2,0)); g.addColorStop(.5,hexA(p2,.85-i*.22)); g.addColorStop(1,hexA(p2,0));
      ctx.strokeStyle=g; ctx.lineWidth=w*.035*(1-i*.22);
      ctx.beginPath(); ctx.ellipse(0,0,rr,rr*.30,0,0,Math.PI*2); ctx.stroke();
      ctx.restore();
    }
    const hg=ctx.createRadialGradient(cx,cy,R*.92,cx,cy,R*1.02);
    hg.addColorStop(0,'rgba(255,220,150,0)'); hg.addColorStop(.6,'rgba(255,210,130,.55)'); hg.addColorStop(1,'rgba(255,200,120,0)');
    ctx.fillStyle=hg; ctx.beginPath(); ctx.arc(cx,cy,R*1.02,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#05060a'; ctx.beginPath(); ctx.arc(cx,cy,R,0,Math.PI*2); ctx.fill();
    ctx.strokeStyle='rgba(255,255,255,.10)'; ctx.lineWidth=2;
    ctx.beginPath(); ctx.arc(cx,cy,R*1.005,0,Math.PI*2); ctx.stroke();
  }
  if (motif==='star') {
    ctx.save(); ctx.translate(cx,cy*.92);
    for(let i=0;i<64;i++){
      const a=r()*Math.PI*2, len=w*(.08+r()*.32), wd=1+r()*2.4;
      ctx.strokeStyle=hexA(p2,.10+r()*.35); ctx.lineWidth=wd;
      ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(Math.cos(a)*len,Math.sin(a)*len); ctx.stroke();
    }
    const cg=ctx.createRadialGradient(0,0,0,0,0,w*.28);
    cg.addColorStop(0,'rgba(255,245,220,.95)'); cg.addColorStop(.35,hexA(p2,.55)); cg.addColorStop(1,hexA(p2,0));
    ctx.fillStyle=cg; ctx.beginPath(); ctx.arc(0,0,w*.28,0,Math.PI*2); ctx.fill();
    ctx.restore();
  }
  if (motif==='collapse') {
    ctx.save(); ctx.translate(cx,cy);
    for(let i=0;i<14;i++){
      const rr=w*(.10+i*.035);
      ctx.strokeStyle=hexA(i%3===0?p2:'#ffffff',.05+r()*.20); ctx.lineWidth=1.5+r()*2;
      ctx.beginPath(); ctx.arc(0,0,rr,0,Math.PI*2); ctx.stroke();
    }
    blob(ctx,0,0,w*.22,p2,.6);
    ctx.restore();
  }
  if (motif==='galaxy') {
    ctx.save(); ctx.translate(cx,cy); ctx.rotate(-.5);
    for(let i=0;i<520;i++){
      const t=r(), arm=i%2?0:Math.PI;
      const a=arm+t*7.2, rr=w*.045+t*w*.40;
      const x=Math.cos(a)*rr, y=Math.sin(a)*rr*.55;
      ctx.fillStyle=hexA(i%7===0?p2:'#dfe8ff',.10+r()*.5);
      ctx.beginPath(); ctx.arc(x,y,1+r()*2.2,0,Math.PI*2); ctx.fill();
    }
    blob(ctx,0,0,w*.20,'#ffe9c4',.55);
    ctx.restore();
  }
  if (motif==='horizon') {
    const hy=h*.62;
    ctx.save();
    const pg=ctx.createRadialGradient(cx,hy,w*.2,cx,hy,w*1.1);
    pg.addColorStop(0,hexA(p1,.75)); pg.addColorStop(1,'#02030a');
    ctx.fillStyle=pg; ctx.beginPath(); ctx.arc(cx,hy+w*1.35,w*1.35,0,Math.PI*2); ctx.fill();
    ctx.strokeStyle=hexA(p2,.55); ctx.lineWidth=3;
    ctx.beginPath(); ctx.arc(cx,hy+w*1.35,w*1.35,Math.PI*1.15,Math.PI*1.85); ctx.stroke();
    ctx.restore();
  }
  if (motif==='void') {
    // 看不见本体，只能看见被它撕碎、拖进去的东西
    ctx.save(); ctx.translate(cx,cy*1.02); ctx.rotate(-0.42);
    for (let i=0;i<260;i++){
      const a=r()*Math.PI*2;
      const t=Math.pow(r(),0.55);
      const rr=w*(0.06+ (1-t)*0.62);
      const x=Math.cos(a)*rr, y=Math.sin(a)*rr*0.40;
      const len=6+r()*46*(0.4+t);
      ctx.strokeStyle=hexA(i%9===0?p2:'#cfe0ff', .06+r()*.34);
      ctx.lineWidth=0.7+r()*1.8;
      ctx.beginPath(); ctx.moveTo(x,y);
      ctx.lineTo(x*1.10, y*1.10);
      ctx.stroke();
      if (len>30){ ctx.fillStyle=hexA('#ffffff',.15+r()*.35); ctx.beginPath(); ctx.arc(x,y,1+r()*1.6,0,Math.PI*2); ctx.fill(); }
    }
    ctx.restore();
    const rim=ctx.createRadialGradient(cx,cy,w*.10,cx,cy,w*.17);
    rim.addColorStop(0,'rgba(0,0,0,.98)'); rim.addColorStop(.72,'rgba(0,0,0,.98)');
    rim.addColorStop(.86,hexA(p2,.55)); rim.addColorStop(1,hexA(p2,0));
    ctx.fillStyle=rim; ctx.beginPath(); ctx.arc(cx,cy,w*.17,0,Math.PI*2); ctx.fill();
  }

  // 顶部/底部压暗，给字幕让位
  const tg=ctx.createLinearGradient(0,0,0,h*.35);
  tg.addColorStop(0,'rgba(0,0,0,.65)'); tg.addColorStop(1,'rgba(0,0,0,0)');
  ctx.fillStyle=tg; ctx.fillRect(0,0,w,h*.35);
  const bg2=ctx.createLinearGradient(0,h*.62,0,h);
  bg2.addColorStop(0,'rgba(0,0,0,0)'); bg2.addColorStop(1,'rgba(0,0,0,.85)');
  ctx.fillStyle=bg2; ctx.fillRect(0,h*.62,w,h*.38);

  // 颗粒
  const img=ctx.getImageData(0,0,w,h);
  const d=img.data;
  for(let i=0;i<d.length;i+=4){ const n=(r()-.5)*16; d[i]+=n; d[i+1]+=n; d[i+2]+=n; }
  ctx.putImageData(img,0,0);
};
</script></body></html>`;

export async function renderMockImages(page, specs, outDir) {
  await ensureDir(outDir);
  await page.setContent(PAGE, { waitUntil: 'load' });
  const files = [];
  for (const spec of specs) {
    await page.evaluate((s) => window.__draw(s), spec);
    const file = path.join(outDir, spec.name);
    await page.screenshot({ path: file, type: 'jpeg', quality: 92 });
    files.push(file);
  }
  return files;
}
