const fs = require('fs');
for (const f of ['src/schema.js','src/demo.js']) {
  let t = fs.readFileSync(f,'utf8');
  t = t.replace("bgmGain: -19", "bgmGain: -13");
  fs.writeFileSync(f, t);
}
console.log('bgm gain -19 -> -13');
