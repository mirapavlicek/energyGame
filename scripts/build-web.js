/* Složí webové assety hry do www/ pro nativní obal (Capacitor). */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'www');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'js'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'icons'), { recursive: true });

const copy = (rel) => fs.copyFileSync(path.join(ROOT, rel), path.join(OUT, rel));

for (const f of ['index.html', 'style.css', 'manifest.webmanifest', 'sw.js']) copy(f);
for (const f of fs.readdirSync(path.join(ROOT, 'js'))) copy(path.join('js', f));
for (const f of fs.readdirSync(path.join(ROOT, 'icons'))) copy(path.join('icons', f));

console.log('www/ připraveno (' + fs.readdirSync(OUT).length + ' položek)');
