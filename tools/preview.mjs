import path from 'node:path';
import fs from 'node:fs/promises';
import { normalizeProject, toStageProject } from '../src/schema.js';
import { buildTimeline, applyTimeline } from '../src/timeline.js';
import { openStage, mount, grabFrame, seek, shot } from '../src/stage.js';
import { buildProject, DEMO } from '../src/demo.js';
import { renderMockImages } from '../src/mock-art.js';
import { ensureDir } from '../src/util.js';

const dir = path.resolve('projects', DEMO.id);
const imgDir = path.join(dir, 'img');
await ensureDir(imgDir);

const project = normalizeProject(buildProject(DEMO, { assetBase: `/projects/${DEMO.id}` }));
const { width, height } = { width: project.meta.size[0], height: project.meta.size[1] };

const stage = await openStage({ width, height });
try {
  const art = await stage.browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await art.setViewportSize({ width, height });
  const specs = DEMO.scenes.map((s, i) => ({ name: `${s.id}.jpg`, w: width, h: height, seed: 9100 + i * 733, motif: s.motif, intensity: 1, palette: project.style.palette }));
  await renderMockImages(art, specs, imgDir);
  await art.close();

  const durations = new Map(DEMO.scenes.map((s) => [s.id, 2.8]));
  const timeline = buildTimeline(project, durations);
  applyTimeline(project, timeline);

  project.scenes.forEach((s, i) => {
    const t = timeline.scenes[i];
    const offset = t.voiceStart - t.start;
    s.captions = [{
      text: s.narration,
      start: Math.max(0, offset - 0.1),
      end: offset + 2.8,
      words: null,
    }];
  });

  await mount(stage.page, toStageProject(project));
  await ensureDir('.tmp/frames');
  const times = [0.6, 1.6, 3.6, 5.2, 7.4, 9.2, 11.5, 13.0, 15.4, 17.2];
  for (let i = 0; i < times.length; i++) {
    await grabFrame(stage.page, times[i] * 1000, path.join('.tmp/frames', `f${String(i).padStart(2, '0')}_${times[i]}s.jpg`));
  }
  const t1 = Date.now();
  for (let i = 0; i < 30; i++) { await seek(stage.page, i * 16); await shot(stage.page); }
  console.log(`capture: ${((Date.now() - t1) / 30).toFixed(1)}ms/frame`);
  console.log('timeline', timeline.totalDuration.toFixed(2), 's', timeline.totalFrames, 'frames');
  console.log('frames written');
} finally {
  await stage.close();
}
