// Unpack the files of the official NC3000 simulator's installer into a local folder (static: the installer is never executed).
//   node extract_fw.js <path to winsim_nc3000.zip/.exe> [output folder, default ./fw]
// The installer ends with LHA -lh5- streams; each is preceded by its name ("Program Files\<name>"), with the original size 17 bytes and the
// compressed size 13 bytes before the name (little endian). Writes obj.bin (NOR) and nd.bin (NAND) plus the small files.
// The result is firmware: keep it on your own machine, do not put it in the project.
'use strict';
const fs = require('fs'), path = require('path');
const { lh5 } = require('./lh5.js');
const src = process.argv[2], outDir = process.argv[3] || path.join(__dirname, 'fw');
if (!src) { console.log('usage: node extract_fw.js <installer> [output folder]'); process.exit(1); }
let b = fs.readFileSync(src);
if (b.readUInt32LE(0) === 0x04034b50) {                     // a .zip: take the .exe inside (the installer itself is only read, never run)
  let e = b.length - 22; while (e >= 0 && b.readUInt32LE(e) !== 0x06054b50) e--;
  let p = b.readUInt32LE(e + 16), found = null;
  for (let k = 0, n = b.readUInt16LE(e + 10); k < n && !found; k++) {
    const method = b.readUInt16LE(p + 10), csize = b.readUInt32LE(p + 20), nl = b.readUInt16LE(p + 28), xl = b.readUInt16LE(p + 30), cl = b.readUInt16LE(p + 32), lo = b.readUInt32LE(p + 42);
    if (/\.exe$/i.test(b.toString('latin1', p + 46, p + 46 + nl))) found = { method, csize, lo };
    p += 46 + nl + xl + cl;
  }
  if (!found) { console.log('no .exe inside the zip'); process.exit(1); }
  const start = found.lo + 30 + b.readUInt16LE(found.lo + 26) + b.readUInt16LE(found.lo + 28), raw = b.subarray(start, start + found.csize);
  b = found.method === 8 ? require('zlib').inflateRawSync(raw) : raw;
}
const key = Buffer.from('Program Files\\');
const known = ['wqxsim.exe', 'nd.bin', 'obj.bin', 'Sim.ini', 'dl.ini', 'readme.doc'];
fs.mkdirSync(outDir, { recursive: true });
let i = 0, n = 0;
while ((i = b.indexOf(key, i)) >= 0) {
  const rest = b.toString('latin1', i + key.length, i + key.length + 40);
  const name = known.find(k => rest.startsWith(k));
  if (!name) { i += key.length; continue; }
  const end = i + key.length + name.length, orig = b.readUInt32LE(i - 17);
  try { fs.writeFileSync(path.join(outDir, name), lh5(b, end, orig)); n++; console.log('wrote', name, orig, 'bytes'); }
  catch (e) { console.log('failed', name, e.message); }
  i = end;
}
console.log(n, 'files in', outDir);
