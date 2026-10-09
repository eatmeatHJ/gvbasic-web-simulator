// Klaus Dormann's functional test on the cycle-counting core
const fs = require('fs'), path = require('path');
const { CPU6502 } = require('./cpu.js');
const mem = new Uint8Array(65536); mem.set(fs.readFileSync(path.join(__dirname, '../../ref/cputest/6502_functional_test.bin')));
const cpu = new CPU6502({ read: a => mem[a], write: (a, v) => { mem[a] = v; } });
cpu.pc = 0x0400; cpu.i = 0;
let steps = 0;
for (;;) { const pc = cpu.pc; cpu.step(); steps++; if (cpu.pc === pc) break; if (steps > 200e6) break; }
const ok = cpu.pc === 0x3469;
console.log(ok ? 'PASS' : 'FAIL: trapped at $' + cpu.pc.toString(16), '(' + cpu.cycles + ' cycles)');
process.exit(ok ? 0 : 1);
