// Installs the app icon from sized PNGs in a folder (icon-16.png ... icon-1024.png), and packs them into icon.ico.
// Run: node scripts/make-icon.mjs <folder>
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const root = path.join(here, '..');
const from = process.argv[2];
if (!from) throw new Error('Give the folder that holds icon-<size>.png');

const read = (s) => fs.readFileSync(path.join(from, `icon-${s}.png`));
const icons = path.join(root, 'src-tauri', 'icons');
fs.mkdirSync(icons, { recursive: true });
fs.writeFileSync(path.join(root, 'public', 'icon.png'), read(64));
fs.writeFileSync(path.join(icons, '32x32.png'), read(32));
fs.writeFileSync(path.join(icons, '128x128.png'), read(128));
fs.writeFileSync(path.join(icons, 'icon.png'), read(256));
fs.writeFileSync(path.join(icons, 'icon-1024.png'), read(1024));

const sizes = [16, 32, 48, 64, 128, 256];
const images = sizes.map(read);
const head = Buffer.alloc(6 + 16 * sizes.length);
head.writeUInt16LE(1, 2);
head.writeUInt16LE(sizes.length, 4);
let at = head.length;
sizes.forEach((s, i) => {
  const e = 6 + i * 16;
  head[e] = s >= 256 ? 0 : s;
  head[e + 1] = s >= 256 ? 0 : s;
  head.writeUInt16LE(1, e + 4);
  head.writeUInt16LE(32, e + 6);
  head.writeUInt32LE(images[i].length, e + 8);
  head.writeUInt32LE(at, e + 12);
  at += images[i].length;
});
fs.writeFileSync(path.join(icons, 'icon.ico'), Buffer.concat([head, ...images]));
console.log('Icon installed');
