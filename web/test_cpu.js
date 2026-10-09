// node web/test_cpu.js : runs Klaus Dormann's 6502 functional test (ref/cputest/6502_functional_test.bin, GPLv3,
// a 64 KB memory image: code starts at $0400, success = the CPU parks at $3469) plus a few direct checks.
const fs = require('fs'), path = require('path');
const { CPU6502, SENTINEL } = require('./cpu6502.js');
let failed = 0;
const check = (ok, what) => { console.log((ok ? 'PASS ' : 'FAIL ') + what); if (!ok) failed++; };

function machine(bytes) {
  const mem = new Uint8Array(65536); mem.set(bytes);
  const cpu = new CPU6502({ read: a => mem[a], write: (a, v) => { mem[a] = v; } });
  return { mem, cpu };
}

// --- the standard test
const img = path.join(__dirname, '..', 'ref', 'cputest', '6502_functional_test.bin');
if (fs.existsSync(img)) {
  const { cpu } = machine(fs.readFileSync(img));
  cpu.reset(0x0400);
  const t0 = Date.now();
  const r = cpu.runSync(200e6);
  const ms = Date.now() - t0;
  check(r.trapped === 0x3469, `Klaus Dormann functional test reaches the success trap $3469   (${r.trapped === undefined ? 'no trap in ' + r.steps + ' steps' : 'stopped at $' + r.trapped.toString(16).toUpperCase()}; ${(cpu.steps / 1e6).toFixed(1)} M instructions in ${(ms / 1000).toFixed(1)} s)`);
  check(cpu.illegal === 0, 'no undocumented opcode was executed');
} else console.log('SKIP functional test: ref/cputest/6502_functional_test.bin not found');

// --- direct checks of the behaviours this project relies on
{
  const { mem, cpu } = machine([]);
  // JSR/RTS and a CALL-style return to the host through the sentinel
  mem.set([0xA9, 0x05, 0x20, 0x10, 0x20, 0x60], 0x2000);           // LDA #5 ; JSR $2010 ; RTS
  mem.set([0x69, 0x03, 0x60], 0x2010);                              // ADC #3 ; RTS
  cpu.call(0x2000).then(() => {
    check(cpu.a === 8 && cpu.halted, 'JSR/RTS and the return to the host (A = 5 + 3)');
    // decimal mode: 0x19 + 0x28 = 0x47, 0x99 + 0x01 = 0x00 with carry
    mem.set([0xF8, 0x18, 0xA9, 0x19, 0x69, 0x28, 0x85, 0x30, 0x18, 0xA9, 0x99, 0x69, 0x01, 0x85, 0x31, 0xD8, 0x60], 0x2100);   // SED CLC LDA #$19 ADC #$28 STA $30 CLC LDA #$99 ADC #$01 STA $31 CLD RTS
    return cpu.call(0x2100);
  }).then(() => {
    check(mem[0x30] === 0x47 && mem[0x31] === 0x00 && cpu.c === 1, 'decimal mode: 19+28=47, 99+01=00 with carry');
    // JMP ($xxFF) wraps inside the page (NMOS bug)
    mem.set([0x6C, 0xFF, 0x30], 0x2200); mem[0x30FF] = 0x00; mem[0x3000] = 0x23; mem[0x3100] = 0x99;   // JMP ($30FF): low byte from $30FF, high byte from $3000 (not $3100)
    mem.set([0xA9, 0x77, 0x60], 0x2300);
    return cpu.call(0x2200);
  }).then(() => {
    check(cpu.a === 0x77, 'JMP ($30FF) takes its high byte from $3000, not $3100 (NMOS page bug)');
    // BRK as the device's 3-byte system call
    const calls = [];
    cpu.onBrk = (c, at) => { calls.push([at, c.rd(at + 1), c.rd(at + 2)]); c.pc = (at + 3) & 0xFFFF; };
    mem.set([0x00, 0x8A, 0x2E, 0xA9, 0x42, 0x60], 0x2400);          // INT $8A2E ; LDA #$42 ; RTS
    return cpu.call(0x2400).then(() => {
      check(calls.length === 1 && calls[0][1] === 0x8A && calls[0][2] === 0x2E && cpu.a === 0x42, 'BRK is caught as  INT $8A2E  and execution continues after its 3 bytes');
    });
  }).then(() => {
    // a trap on a ROM address behaves like a subroutine written in JS
    let hit = 0;
    cpu.addTrap(0xE02A, c => { hit = c.x; });
    mem.set([0xA2, 0x50, 0x20, 0x2A, 0xE0, 0x60], 0x2500);          // LDX #$50 ; JSR $E02A ; RTS
    return cpu.call(0x2500).then(() => check(hit === 0x50, 'JSR $E02A runs a JS routine (it saw X = $50) and returns'));
  }).then(() => {
    console.log(failed ? '\n' + failed + ' FAILED' : '\nall passed');
    process.exit(failed ? 1 : 0);
  }).catch(e => { console.error('TEST CRASHED', e); process.exit(1); });
}
