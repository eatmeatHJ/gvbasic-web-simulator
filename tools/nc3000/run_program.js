// Type a program into the firmware's BASIC editor (lines separated by '|'; the editor numbers them 10, 20, ...), save it as TB, run it,
// then report the final text screen and the tones on the buzzer (bit 7 of port $18), measured in CPU cycles.
//   PROG='BEEP|PRINT "OK"' node tools/nc3000/run_program.js [frames to run, default 600]   (NC3000_FW = folder with the firmware files)
const { make } = require('./sim.js');
const { typer, openEditor } = require('./basic.js');
const s = make(); s.boot(); openEditor(s);
const t = typer(s);
for (const line of process.env.PROG.split('|')) { t.type(line); t.tap(0x0D); s.run(60); }
t.tap(0x1B, 10, 10); s.run(150); t.tap(0x0D, 10, 10); s.run(150);
t.type('tb'); t.tap(0x0D, 10, 10); s.run(250);
const m = s.m, ev = [];
const ow = m.ioWrite.bind(m);
let rec = false;
m.ioWrite = (a, v) => { if (rec && a === 0x18) ev.push([m.cpu.cycles, v]); return ow(a, v); };
rec = true; const c0 = m.cpu.cycles;
t.tap(0x0D, 10, 10);
const frames = Number(process.argv[2] || 600);
for (let i = 0; i < frames; i += 60) { s.run(60); if (i % 180 === 0) s.snap(); }
rec = false;
console.log('screen', JSON.stringify(t.screen()));
let last = null; const edges = [];
for (const [c, v] of ev) { const b = (v >> 7) & 1; if (last === null || b !== last) { edges.push([c, b]); last = b; } }
// tones: a run of edges whose spacing stays near one value; the IRQ handler steals ~1500 cycles now and then, which must not split a tone
const tones = []; let tone = null;
for (let i = 1; i < edges.length; i++) {
  const d = edges[i][0] - edges[i - 1][0];
  if (tone && d <= 4000 && (Math.abs(d - tone.hp) <= tone.hp * 0.06 || (d > tone.hp && d <= tone.hp + 1700))) {
    if (Math.abs(d - tone.hp) <= tone.hp * 0.06) { tone.sum += d; tone.n++; }
    tone.last = edges[i][0]; tone.edges++;
  } else {
    if (tone) tones.push(tone);
    tone = (d <= 4000 && d >= 100) ? { first: edges[i - 1][0], last: edges[i][0], hp: d, sum: d, n: 1, edges: 1 } : null;
  }
  if (tone) tone.hp = tone.sum / tone.n;
}
if (tone) tones.push(tone);
let prevEnd = null; const MHZ = Number(process.env.MHZ || 10.24);
for (const g of tones) if (g.edges >= 8) { const len = g.last - g.first + g.hp; console.log('tone: half-period', g.hp.toFixed(1), 'cycles (period', (2 * g.hp).toFixed(1) + ') = ' + (MHZ * 1e6 / (2 * g.hp)).toFixed(1) + ' Hz at ' + MHZ + ' MHz; length', Math.round(len), 'cycles = ' + (len / (MHZ * 1e3)).toFixed(1) + ' ms; start', g.first - c0, prevEnd === null ? '' : 'silence before ' + Math.round(g.first - prevEnd) + ' = ' + ((g.first - prevEnd) / (MHZ * 1e3)).toFixed(1) + ' ms'); prevEnd = g.last + g.hp; }
console.log('edges', edges.length, 'cycles', m.cpu.cycles - c0);
if (process.env.PNG) s.save(process.env.PNG, 4);
