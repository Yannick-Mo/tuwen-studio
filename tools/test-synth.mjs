import { synthMusic, synthSfx, writeWav } from '../src/synth.js';
import fs from 'node:fs/promises';
await fs.mkdir('.tmp/audio2', { recursive: true });
for (const style of ['calm','tense']) {
  const t0 = Date.now();
  const m = synthMusic({ seconds: 20, style });
  await writeWav(`.tmp/audio2/bgm-${style}.wav`, m);
  console.log(style, 'music', ((Date.now()-t0)/1000).toFixed(2)+'s', (m.total).toFixed(1)+'s');
}
for (const k of ['whoosh','boom','riser','tick','pop']) {
  await writeWav(`.tmp/audio2/${k}.wav`, synthSfx(k));
}
console.log('sfx ok');
