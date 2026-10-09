// node tools/txt2bas.js <file.txt | folder> ... [-o outfolder] [--charset auto|big5|gbk] [--base 7000] [--force] [--ext]
// Turns program listings (line-numbered text, UTF-8 or GBK) into .BAS files that the device (and this simulator) can run.
// Without -o the .BAS is written next to the .txt. Files with errors are reported and skipped unless --force is given
// (then the lines that failed are left out). --ext also accepts the simulator's own words (SLEEP, PAINT, FREAD ...): such a .BAS only runs in this simulator.
// The tokenising is web/txt2bas.js, the same code the page uses.
const fs = require('fs'), path = require('path');
const T = require('../web/txt2bas.js');
const args = process.argv.slice(2);
const opt = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args.splice(i, 2)[1] : d; };
const flag = f => { const i = args.indexOf(f); if (i >= 0) { args.splice(i, 1); return true; } return false; };
const outDir = opt('-o'), charset = opt('--charset', 'auto'), base = parseInt(opt('--base', '7000'), 16), force = flag('--force'), ext = flag('--ext');
if (!args.length) { console.log('usage: node tools/txt2bas.js <file.txt | folder> ... [-o outfolder] [--charset auto|big5|gbk] [--base 7000] [--force] [--ext]'); process.exit(1); }

const files = [];
for (const a of args) {
  if (fs.statSync(a).isDirectory()) for (const f of fs.readdirSync(a).sort()) { if (/\.txt$/i.test(f)) files.push(path.join(a, f)); }
  else files.push(a);
}
if (outDir) fs.mkdirSync(outDir, { recursive: true });
let ok = 0, skipped = 0;
for (const f of files) {
  const { text, encoding } = T.decodeText(new Uint8Array(fs.readFileSync(f)));
  if (!T.looksLikeProgram(text)) { console.log(path.basename(f).padEnd(24), 'not a program listing (skipped)'); skipped++; continue; }
  const conv = t => T.convertText(t, { charset, base, ext: ext ? 'auto' : false });
  let r = conv(text);
  if (r.errors.length && force) {                       // drop the lines that failed and convert the rest
    const bad = new Set(r.errors.map(e => e.line));
    r = conv(text.replace(/\r/g, '').split('\n').filter((l, i) => !bad.has(i + 1)).join('\n'));
  }
  const name = path.basename(f).replace(/\.txt$/i, '') + '.BAS';
  if (r.errors.length) {
    console.log(path.basename(f).padEnd(24), 'FAILED (' + r.errors.length + ' errors), nothing written:');
    for (const e of r.errors.slice(0, 6)) console.log('     line ' + e.line + (e.no !== undefined ? ' (no. ' + e.no + ')' : '') + ': ' + e.msg);
    if (r.errors.length > 6) console.log('     ... ' + (r.errors.length - 6) + ' more');
    skipped++; continue;
  }
  const target = path.join(outDir || path.dirname(f), name);
  fs.writeFileSync(target, r.bytes);
  console.log(path.basename(f).padEnd(24), r.lines + ' lines, ' + r.bytes.length + ' bytes, text ' + encoding + ' -> ' + r.charset.toUpperCase() + (r.warnings.length ? ', ' + r.warnings.length + ' warnings' : '') + (r.ext ? ', simulator-only words: ' + r.extUsed.join(' ') : '') + '  -> ' + target);
  for (const w of r.warnings.slice(0, 4)) console.log('     ' + (w.no ? 'line ' + w.no + ': ' : '') + w.msg);
  ok++;
}
console.log('\nwritten: ' + ok + '   skipped or failed: ' + skipped);
process.exit(skipped && !ok ? 1 : 0);
