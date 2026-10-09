// node web/test_machinecode.js : machine code (CALL, INT $xxxx system calls, small BIN) running next to GVBASIC
const G = require('./gvb.js');
const { assemble } = require('./asm6502.js');
const { parseSmallBin, makeSmallBin } = require('./wqxos.js');
let failed = 0;
const check = (ok, what) => { console.log((ok ? 'PASS ' : 'FAIL ') + what); if (!ok) failed++; };
const big5 = new TextDecoder('big5');
const row = (dev, r) => { let s = ''; for (let c = 0; c < 20; c++) { const b = dev.text[r * 20 + c]; if (!b) { s += ' '; continue; } if (b > 160) { s += big5.decode(Uint8Array.of(b, dev.text[r * 20 + c + 1])); c++; } else s += String.fromCharCode(b); } return s.trimEnd(); };

/* basic = BASIC text of the program (one statement list per line number 10, 20 ...), segments = assembled machine code loaded before the run */
async function run(basic, segments, keys, mhz) {
  const lines = basic.map((s, i) => ({ no: (i + 1) * 10, body: G.tokenizeBody(s) }));
  const dev = new G.Device(); const m = new G.Machine(dev, new G.DatStore([]));
  m.prog = G.compileProgram(lines); m.cpuMhz = mhz || 0;
  m.preload = d => { for (const s of segments || []) d.mem.set(s.bytes, s.addr); };
  let fin = null; m.run().then(r => { fin = r; });
  const t0 = Date.now(); let i = 0;
  while (fin === null && Date.now() - t0 < 5000) {
    await new Promise(r => setImmediate(r));
    if (dev.waiters.length || dev.input) { if (i >= (keys || []).length) { m.stop(); continue; } dev.keyDown(keys[i++], ''); }
  }
  return { dev, fin, m, ms: Date.now() - t0 };
}
const asm = src => assemble(src).segments;

(async () => {
  // 1. the "display a message" recipe of the book: clear, copy text to the screen RAM, update, wait for a key
  let r = await run(['CALL 8448'], asm(`
      .org $2000
msg:  .str "HELLO WORLD"
      .org $2100
      INT $8A2E            ; clear the screen
      LDX #$0B
copy: LDA $1FFF,X
      STA $02BF,X
      DEX
      BNE copy
      LDA #$01
      STA $0402
      INT $8A15            ; update the LCD
      INT $C008            ; wait for a key; its scan code arrives in A
      STA $3000
      RTS`), [98]);
  check(row(r.dev, 0) === 'HELLO WORLD' && r.dev.mem[0x3000] === 98 && r.fin.ended, 'recipe from the book: text in screen RAM + INT $8A15 + INT $C008 (key code came back: ' + r.dev.mem[0x3000] + ')');

  // 2. graphics system calls: a line and a circle, parameters in RAM
  r = await run(['CALL 8192'], asm(`
      .org $2000
      LDA #10
      STA $043F
      LDA #20
      STA $0440
      LDA #100
      STA $0441
      LDA #20
      STA $0442
      LDA #1
      STA $0445
      INT $C30B            ; line (10,20)-(100,20)
      LDA #80
      STA $043F
      LDA #40
      STA $0440
      LDA #20
      STA $0452
      INT $C30E            ; circle, centre (80,40), radius 20
      INT $C008
      RTS`), [13]);
  const px = (x, y) => r.dev.gfx[y * 160 + x];
  check(px(10, 20) && px(55, 20) && px(100, 20) && !px(55, 21), 'INT $C30B draws a horizontal line');
  check(px(100, 40) && px(60, 40) && px(80, 20) && px(80, 60) && !px(80, 40), 'INT $C30E draws a circle (radius 20 around (80,40))');

  // 3. DELAY, power check, flash read stub
  r = await run(['CALL 8192:PRINT PEEK(12288)'], asm(`
      .org $2000
      LDX #$03
      JSR $E02A            ; DELAY
      INT $021A            ; battery check: 0 = fine
      STA $3000
      RTS`), []);
  check(row(r.dev, 0) === '0' && r.fin.ended, 'JSR $E02A (delay) and INT $021A (battery 0 = fine) work');

  // 4. a system routine we do not have is reported by name instead of crashing
  r = await run(['CALL 8192'], asm('.org $2000\n INT $C999\n RTS'), []);
  check(r.fin.error && /Unimplemented system call INT \$C999/.test(r.fin.error.message) && r.fin.error.gvbLine === 10, 'unknown INT is reported: "' + (r.fin.error && r.fin.error.message) + '"');
  r = await run(['CALL 8192'], asm('.org $2000\n JSR $E138\n RTS'), []);
  check(r.fin.error && /Unimplemented BIOS routine \$E138/.test(r.fin.error.message), 'unknown BIOS routine is reported: "' + (r.fin.error && r.fin.error.message) + '"');
  r = await run(['CALL 57645'], [], []);
  check(r.fin.ended, 'BASIC "CALL 57645" ($E12D, show the text RAM) is accepted');
  r = await run(['CALL 57600'], [], []);
  check(r.fin.error && /BIOS routine \$E100/.test(r.fin.error.message), 'BASIC "CALL 57600" (a ROM address nobody knows) says which routine is missing');

  // 4b. the machine code clock: ~130,000 instructions of a delay loop take next to no time flat out, and about 0.43 s at 1 MHz (an instruction takes ~3.3 cycles)
  const loop = asm(`
      .org $2000
      LDY #$FF
outer: LDX #$FF
inner: DEX
      BNE inner
      DEY
      BNE outer
      RTS`);
  r = await run(['CALL 8192'], loop, [], 0);
  const flat = r.ms;
  r = await run(['CALL 8192'], loop, [], 1);
  check(r.fin.ended && flat < 250 && r.ms >= 300 && r.ms < 1500, 'cpuMhz = 1 slows a 130,000 instruction loop to about 0.43 s  (flat out ' + flat + ' ms, at 1 MHz ' + r.ms + ' ms)');
  r = await run(['CALL 8192'], loop, [], 0.25);
  check(r.fin.ended && r.ms >= 1200 && r.ms < 4500, 'and at 0.25 MHz to about 1.7 s  (' + r.ms + ' ms)');

  // 5. BASIC and machine code share the same RAM, the same text screen and the same graphics RAM
  r = await run(['POKE 12288,5:CALL 8192:PRINT PEEK(12289)'], asm('.org $2000\n LDA $3000\n ASL A\n STA $3001\n RTS'), []);
  check(row(r.dev, 0) === '10', 'POKE 12288,5 -> machine code doubles it -> PEEK(12289) = ' + row(r.dev, 0));
  r = await run(['PRINT "HI":CALL 8192:PRINT PEEK(12288)'], asm('.org $2000\n LDA $02C0\n STA $3000\n RTS'), []);
  check(row(r.dev, 0) === 'HI' && row(r.dev, 1) === '72', 'machine code reads what BASIC PRINTed (screen RAM $02C0 = "H" = 72)');
  r = await run(['DRAW 3,0:PRINT PEEK(6592):POKE 6593,255:CALL 8192'], asm('.org $2000\n RTS'), []);
  check(row(r.dev, 0) === '16' && r.dev.gfx[8] === 1 && r.dev.gfx[15] === 1 && r.dev.gfx[16] === 0, 'graphics RAM $19C0.. is the packed LCD: DRAW 3,0 -> byte 16; POKE 6593,255 -> pixels 8..15');

  // 6. the pop-up message box of the book (INT $C312) with a table like the one in its example
  r = await run(['CALL 8208'], asm(`
      .org $2010
      LDX #<tbl
      LDY #>tbl
      LDA #$00
      INT $C312
      INT $C007
      RTS
msg:  .str "ITEMS 200"
tbl:  .byte $80, <msg, >msg, 9, 16, 9, 2, <tbl+9, >tbl+9, 2`), [13]);
  check(row(r.dev, 1).includes('ITEMS 200'), 'INT $C312 pops up a message at x=9,y=16  → row 2: "' + row(r.dev, 1) + '"');

  // 7. a small BIN file in the layout from the book (AA A5 5A ..., loaded at $2000, ends with RTS)
  const code = assemble(`.org $2010\n LDX #$00\nl: LDA #$C8\n STA $06D7,X\n INX\n CPX #$06\n BNE l\n RTS`).segments[0].bytes;
  const bin = makeSmallBin(code);
  const info = parseSmallBin(bin);
  check(info && info.entry === 0x2010 && info.length === bin.length && info.loadAt === 0x2000, 'makeSmallBin / parseSmallBin agree on the header (entry $2010, length ' + bin.length + ')');
  r = await run(['CALL ' + info.entry], [{ addr: info.loadAt, bytes: bin }], []);
  check([0x6D7, 0x6D8, 0x6DC].every(a => r.dev.mem[a] === 0xC8) && r.dev.mem[0x6DD] === 0 && r.fin.ended, 'the BIN runs: it set six RAM bytes to 200 ($C8), like the "pet save modifier" of the book');

  console.log(failed ? '\n' + failed + ' FAILED' : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('TEST CRASHED', e); process.exit(1); });
