const fs = require('fs');
let t = fs.readFileSync('src/cli.js','utf8');
t = t.replace("'zoom-blur': ['riser', 0.45, 0.55]," , "'zoom-blur': ['riser', 0.45, 0.30],");
t = t.replace("'flash': ['boom', 0, 0.6],", "'flash': ['boom', 0, 0.45],");
t = t.replace("'whip-pan': ['whoosh', 0.12, 0.5],", "'whip-pan': ['whoosh', 0.12, 0.42],");
fs.writeFileSync('src/cli.js', t);
console.log('sfx gains lowered');
