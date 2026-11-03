const fs = require('fs');
let t = fs.readFileSync('src/synth.js','utf8');
t = t.replace("addVoice(L, t0, noteFreq(ch.bass), beat * 1.8, 0.20,", "addVoice(L, t0, noteFreq(ch.bass), beat * 1.8, 0.155,");
t = t.replace("addVoice(R, t0, noteFreq(ch.bass), beat * 1.8, 0.20,", "addVoice(R, t0, noteFreq(ch.bass), beat * 1.8, 0.155,");
t = t.replace("addVoice(L, t0 + beat * 2, noteFreq(ch.bass), beat * 1.6, 0.14,", "addVoice(L, t0 + beat * 2, noteFreq(ch.bass), beat * 1.6, 0.105,");
t = t.replace("addVoice(R, t0 + beat * 2, noteFreq(ch.bass), beat * 1.6, 0.14,", "addVoice(R, t0 + beat * 2, noteFreq(ch.bass), beat * 1.6, 0.105,");
t = t.replace("const g = k % 2 === 0 ? 0.075 : 0.05;", "const g = k % 2 === 0 ? 0.115 : 0.08;");
fs.writeFileSync('src/synth.js', t);
console.log('rebalanced');
