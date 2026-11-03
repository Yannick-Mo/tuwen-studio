const fs = require('fs');
let t = fs.readFileSync('src/cli.js','utf8');
t = t.replace(
  "await mixAudio({ voiceWav, bgm, total: timeline.totalDuration, out: mix, loudness: -14 });",
  "await mixAudio({ voiceWav, bgm, total: timeline.totalDuration, out: mix, loudness: project.audio.loudness ?? -14, bgmGain: project.audio.bgmGain ?? -13 });"
);
t = t.replace(
  "await mixAudio({ voiceWav, bgm, total: timeline.totalDuration, out: mix, loudness: project.audio.loudness ?? -14 });",
  "await mixAudio({ voiceWav, bgm, total: timeline.totalDuration, out: mix, loudness: project.audio.loudness ?? -14, bgmGain: project.audio.bgmGain ?? -13 });"
);
fs.writeFileSync('src/cli.js', t);
let e = fs.readFileSync('src/encode.js','utf8');
e = e.replace("bgmGain = -19", "bgmGain = -13");
fs.writeFileSync('src/encode.js', e);
console.log('patched');
