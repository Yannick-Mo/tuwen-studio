import fs from 'node:fs';
import { normalizeProject } from '../src/schema.js';
import { buildPrompt } from '../src/images.js';
const p = normalizeProject(JSON.parse(fs.readFileSync('projects/chapter02/project.json','utf8')));
const scene = p.scenes.find(s => s.id === 's4');
console.log('--- visual.subject（面板里能改的就是这一句）---');
console.log(scene.visual.subject);
console.log('\n--- 实际发给 Seedream 的完整 prompt ---');
console.log(buildPrompt(p, scene, p.scenes.indexOf(scene)));
