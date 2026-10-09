// Convenience layer over the NC3000 model: load the local firmware files, press keys by key code, take LCD pictures.
//   const { make } = require('./sim.js');  const s = make();  s.run(300); s.tap('n'); ...
// The firmware files are NOT part of this project. Point NC3000_FW at a folder holding obj.bin (1 MB NOR) and nd.bin (NAND, 528-byte pages),
// see docs/NC3000韌體.md for how they are obtained.
'use strict';
const fs = require('fs'), path = require('path');
const { NC3000 } = require('./machine.js');
const { keyTable } = require('./keys.js');
const shot = require('./shot.js');
const FW = process.env.NC3000_FW || path.join(__dirname, 'fw');
function make(opts) {
  opts = opts || {};
  const nor = new Uint8Array(fs.readFileSync(path.join(FW, 'obj.bin')));
  const dump = opts.blankNand ? null : fs.readFileSync(path.join(FW, 'nd.bin'));
  // the whole chip has 4096 blocks of 32 pages; the dump covers the middle of it (see docs/NC3000韌體.md)
  const nand = new Uint8Array((4096 * 32 - 64) * 528).fill(0xFF);
  if (dump) nand.set(dump);
  const m = new NC3000(nor, nand, {});
  const kt = keyTable(nor);
  const s = { m, shots: [], keys: kt };
  s.run = n => { for (let i = 0; i < n; i++) m.runFrame(); };
  const pos = code => { const p = typeof code === 'string' ? kt.get(code.charCodeAt(0)) : kt.get(code); if (!p) throw new Error('no such key ' + code); return p; };
  s.down = code => { const p = pos(code); m.key(p[0], p[1], true); };
  s.up = code => { const p = pos(code); m.key(p[0], p[1], false); };
  s.tap = (code, hold = 8, gap = 8) => { s.down(code); s.run(hold); s.up(code); s.run(gap); };
  s.pix = () => { const g = new Uint8Array(160 * 80), l = m.lcd(); for (let y = 0; y < 80; y++) for (let x = 0; x < 160; x++) g[y * 160 + x] = (l[y * 20 + (x >> 3)] >> (7 - (x & 7))) & 1; return g; };
  s.snap = () => { s.shots.push(s.pix()); };
  s.save = (file, cols) => { shot.sheet(file, s.shots, cols || 2, 3); s.shots = []; };
  // power-on with an empty RAM: the firmware asks what to do with the flash data; "n" keeps it and the system repairs itself, then the logo screens wait for a key
  s.boot = () => {
    s.run(300); s.tap('n', 12, 12); s.run(1800); s.tap(0x0D, 10, 10); s.run(150);
    // the firmware's root directory lives in block 3636 (just past the dump), which the repair has just erased: put the root listing there
    // (the listing is the last page of the dump's first block)
    if (dump) m.nand.set(dump.subarray(31 * 528, 31 * 528 + 512), 116288 * 528);
  };
  return s;
}
module.exports = { make, FW };
