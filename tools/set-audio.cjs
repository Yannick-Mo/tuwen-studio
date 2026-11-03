const fs = require('fs');
const p = 'specs/chapter-02.json';
const j = JSON.parse(fs.readFileSync(p,'utf8'));
j.audio = { bgmStyle: 'tense' };
fs.writeFileSync(p, JSON.stringify(j, null, 2));
console.log('spec updated');
