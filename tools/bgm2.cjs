const fs = require('fs');
let e = fs.readFileSync('src/encode.js','utf8');
e = e.replace("bgmGain = -13", "bgmGain = -9");
e = e.replace(
  "[bg][0:a]sidechaincompress=threshold=0.02:ratio=8:attack=15:release=320[duck]",
  "[bg][0:a]sidechaincompress=threshold=0.06:ratio=3:attack=20:release=250[duck]"
);
fs.writeFileSync('src/encode.js', e);
for (const f of ['src/schema.js','src/demo.js']) {
  let t = fs.readFileSync(f,'utf8');
  t = t.replace("bgmGain: -13", "bgmGain: -9");
  fs.writeFileSync(f, t);
}
console.log('bgm -9dB + soft ducking');
