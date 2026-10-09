// Cycles per loop iteration, counted at the interpreter's NEXT handler ($7C97 in the run-time image of this firmware's GVBASIC); PRINT is
// avoided as a marker because it waits for the 2 Hz tick.
//   node tools/nc3000/loop_speed.js "A=A+1" [iterations]
const { make } = require('./sim.js');
const { typer, openEditor } = require('./basic.js');
const body = process.argv[2] || '', N = Number(process.argv[3] || 400);
const s = make(); s.boot(); openEditor(s);
const t = typer(s);
t.type('FOR I=1 TO ' + N + ':' + (body ? body + ':' : '') + 'NEXT I'); t.tap(0x0D); s.run(60);
t.tap(0x1B, 10, 10); s.run(150); t.tap(0x0D, 10, 10); s.run(150);
t.type('tb'); t.tap(0x0D, 10, 10); s.run(250);
const m = s.m, stamps = [];
m.trace = cpu => { if (cpu.pc === 0x7C97 && m.roa) stamps.push(m.cpu.cycles); };
t.tap(0x0D, 10, 10); s.run(Math.ceil(N * 12000 / 153856) + 400);
const d = []; for (let i = 20; i < stamps.length - 1; i++) d.push(stamps[i + 1] - stamps[i]);
d.sort((a, b) => a - b);
console.log(JSON.stringify(body), 'NEXT executed', stamps.length, 'times; cycles/iteration median', d[d.length >> 1], 'min', d[0], 'p90', d[Math.floor(d.length * 0.9)], '= ' + (d[d.length >> 1] / 10240).toFixed(3) + ' ms at 10.24 MHz');
