// node web/test_flash.js : the machine layer for big machine-code images (flash banks, the BIOS routines found in an RPG engine image,
// RUN "file", Big5 -> GBK). Uses an image made up here, never the real engine image file.
const G = require('./gvb.js');
const { FlashImage } = require('./flash.js');
const { assemble } = require('./asm6502.js');
let failed = 0;
const check = (ok, what) => { console.log((ok ? 'PASS ' : 'FAIL ') + what); if (!ok) failed++; };

/* a 2-page image: page 0 = machine code at window $A000 (file +$2000), page 1 = markers */
function makeImage() {
  const b = new Uint8Array(0x10000);
  const put = (off, bytes) => b.set(bytes, off);
  const code = assemble('.org $A000\n LDA #$2A\n STA $3000\n RTS').segments[0].bytes;
  put(0x2000, code);                                   // window $A000 of page 0
  put(0x4000 + 0x10, [0x11, 0x22]);                    // page 0, window $4010 (first block comes from +$4000)
  put(0x0000 + 0x20, [0x33]);                          // page 0, window $8020 (third block comes from +$0000)
  put(0x8000 + 0x4000, [0x77]);                        // page 1, window $4000
  return b;
}

async function run(basic, opts) {
  opts = opts || {};
  const lines = basic.map((s, i) => ({ no: (i + 1) * 10, body: G.tokenizeBody(s) }));
  const dev = new G.Device(); const m = new G.Machine(dev, new G.DatStore([]));
  if (opts.flash !== false) m.flash = new FlashImage(makeImage(), { name: 'test' });
  m.prog = G.compileProgram(lines);
  if (opts.loadProgram) m.loadProgram = opts.loadProgram;
  if (opts.preload) m.preload = opts.preload;
  const fin = await m.run();
  return { dev, fin, m };
}
const asmSeg = src => assemble(src).segments;

(async () => {
  // 1. the bank window
  let r = await run(['A=PEEK(0):B=PEEK(16400):C=PEEK(32800):POKE 16400,1:D=PEEK(16400)', 'POKE 0,A+1:E=PEEK(16384):POKE 0,A+2:F=PEEK(16384)', 'POKE 12288,PEEK(1190)-A:POKE 12289,PEEK(6597)']);
  const v = n => r.m.getVar(n);
  check(r.fin.ended && v('B') === 0x11 && v('C') === 0x33, 'the window shows the page selected by the bank register ($4010 = $11, $8020 = $33, in the usual block order)');
  check(v('D') === 0x11, 'writes into the ROM window are ignored');
  check(v('E') === 0x77, 'bank register + 1 selects the next page');
  check(v('F') === 0, 'a bank outside the image is plain RAM');
  check(r.dev.mem[0x3000] === 0 && r.dev.mem[0x3001] === 0x55, 'the install leaves the bank at $04A6 and the signature $55 at $19C5 (what the main program of the RPG checks)');

  // 2. CALL into machine code that lives in the image
  r = await run(['CALL 40960:PRINT PEEK(12288)']);
  check(r.dev.mem[0x3000] === 0x2A, 'CALL into the window runs the machine code of the image');

  // 3. the LCD bitmap is where this machine keeps it ($09C0), and $19C0 is just RAM
  r = await run(['POKE 2496,128:POKE 6592,200', 'A=PEEK(6592)']);
  check(r.dev.gfx[0] === 1 && r.dev.gfx[1] === 0 && r.m.getVar('A') === 200, 'screen RAM at $09C0; $19C0 is plain RAM for the engine');
  r = await run(['POKE 6592,128:POKE 2496,7'], { flash: false });
  check(r.dev.gfx[0] === 1 && r.dev.mem[2496] === 7, 'without an image everything is as before: screen RAM at $19C0');

  // 4. BIOS routines: $E153 number to digits, $E135 small text, $E19E bitmap, $E1A1/$E1A7 boxes
  r = await run(['CALL 8192'], { preload: d => { for (const s of asmSeg(`
      .org $2000
      LDA #$39
      STA $80
      LDA #$30
      STA $81
      JSR $E153           ; 12345
      JSR $E135
      LDA #$00
      STA $92
      LDA #$30
      STA $93
      LDA #$04
      STA $03A6
      LDA #$02
      STA $03A7
      LDA #$0B
      STA $03A8
      LDA #$03
      STA $03A9
      JSR $E19E           ; picture: 8 x 2, data at $3000
      LDA #$01
      STA $03AC
      LDA #$14
      STA $03A6
      STA $03A7
      LDA #$17
      STA $03A8
      LDA #$17
      STA $03A9
      JSR $E1A7           ; frame (20,20)-(23,23)
      LDA #$1E
      STA $03A6
      STA $03A7
      LDA #$20
      STA $03A8
      STA $03A9
      JSR $E1A1           ; filled box (30,30)-(32,32)
      RTS`)) d.mem.set(s.bytes, s.addr); d.mem.set([0xF0, 0x0F], 0x3000); } });
  const m = r.dev.mem, digits = String.fromCharCode(...m.subarray(0x82, 0x87));
  check(digits === '12345', '$E153 turns the 16-bit number in $80/$81 into five digits at $82: "' + digits + '"');
  check(r.dev.small === true && r.dev.gfx.every((v, i) => !v || (i >= 2 * 160 && i < 4 * 160) || i >= 20 * 160), '$E135 clears the LCD (everything drawn here came after it)');
  const px = (x, y) => r.dev.gfx[y * 160 + x];
  check([4, 5, 6, 7].every(x => px(x, 2)) && ![8, 9, 10, 11].some(x => px(x, 2)) && ![4, 5, 6, 7].some(x => px(x, 3)) && [8, 9, 10, 11].every(x => px(x, 3)), '$E19E draws the 1-bit picture (rows padded to bytes, leftmost pixel = top bit)');
  check(px(20, 20) && px(23, 20) && px(20, 23) && px(23, 23) && px(20, 21) && px(23, 22) && !px(21, 21) && !px(22, 22), '$E1A7 draws a frame');
  check(px(30, 30) && px(31, 31) && px(32, 32) && px(30, 32), '$E1A1 draws a filled box');
  r = await run(['CALL 8192'], { preload: d => { for (const s of asmSeg('.org $2000\n LDA #1\n STA $03A6\n STA $03A7\n LDA #2\n STA $03A8\n STA $03A9\n LDA #2\n STA $03AC\n JSR $E1A7\n JSR $E1A7\n RTS')) d.mem.set(s.bytes, s.addr); } });
  check(![1, 2].some(x => r.dev.gfx[1 * 160 + x]), 'drawing mode 2 inverts: the same box twice leaves nothing');
  // $E10B: paint row ($84) of the 20-column text RAM into the bitmap (the item list of an engine writes its 2-byte entries from $02D4 = row 1, then calls it for rows 1 and 2)
  {
    const stamped = [];
    r = await run(['CALL 8192'], { preload: d => {
      d.stampCell = (rr, c) => { stamped.push(rr + ',' + c); return d.text[rr * 20 + c] > d.lead ? 2 : 1; };
      for (const s of asmSeg('.org $2000\n LDA #$FA\n STA $02D4\n LDA #$47\n STA $02D5\n LDA #$41\n STA $02D6\n LDA #1\n STA $84\n JSR $E10B\n LDA #2\n STA $84\n JSR $E10B\n RTS')) d.mem.set(s.bytes, s.addr); } });
    check(r.fin.ended && stamped.join(' ') === '1,0 1,2', '$E10B paints the characters of text row $84 (a 2-byte entry and a letter in row 1, nothing for the empty row 2)  (' + stamped.join(' ') + ')');
    check(r.dev.stamped[20] === 1 && r.dev.stamped[21] === 1 && r.dev.stamped[22] === 1 && r.dev.stamped[23] === 0, '... and marks those cells as part of the bitmap');
  }

  // 5. RUN "file": the other program starts, variables are gone, machine RAM stays
  const second = G.tokenizeBody('PRINT A;PEEK(12288)');
  const otherBytes = G.buildBas([{ no: 10, body: second }], 0x7000);
  let asked = null;
  r = await run(['A=5:POKE 12288,9:RUN "OTHER"', 'PRINT "not reached"'], { flash: false, loadProgram: async n => { asked = n; return otherBytes; } });
  const text = String.fromCharCode(...r.dev.text.subarray(0, 20)).replace(/\0/g, ' ').trim();
  check(asked === 'OTHER' && text === '09' && r.fin.ended, 'RUN "OTHER" loads and starts the other program; its BASIC variables are cleared, machine RAM is kept ("' + text + '")');
  r = await run(['RUN "NOPE"'], { flash: false, loadProgram: async () => null });
  check(r.fin.error && /NOT EXIST/.test(r.fin.error.message), 'RUN of a missing program is an error');

  // 6. character sets: the program's Big5 text is re-encoded for a GB machine
  const big5 = G.toByteString('你好'), gbk = G.toByteString('你好', 'gbk');
  check(new TextDecoder('big5').decode(Uint8Array.from(big5, c => c.charCodeAt(0))) === '你好' && new TextDecoder('gbk').decode(Uint8Array.from(gbk, c => c.charCodeAt(0))) === '你好' && big5 !== gbk, 'toByteString encodes for Big5 and for GBK');
  const prog = G.convertLines([{ no: 10, body: Uint8Array.from([0x98, 0x22, 0x1f, ...[...big5].slice(0, 2).map(c => c.charCodeAt(0)), 0x1f, 0xfa, 0x50, 0x22]) }], 'gbk');
  const conv = Array.from(prog[0].body);
  check(String.fromCharCode(conv[3], conv[4]) === gbk.slice(0, 2) && conv[5] === 0x1f && conv[6] === 0xfa && conv[7] === 0x50 && conv[0] === 0x98, 'convertLines re-encodes the characters, keeps tokens and device pictograms');
  {
    // 6b. GBK puts 256 of Big5's characters at FA40-FEA0, where the mainland machine has its own pictograms (shown as a boxed hex code): those characters are stored under spare codes
    const enc = G.toByteString('麼點龍黃麥鹽', 'big5'), body = []; for (let i = 0; i < enc.length; i += 2) body.push(0x1f, enc.charCodeAt(i), enc.charCodeAt(i + 1));
    const cv = Array.from(G.convertLines([{ no: 10, body: Uint8Array.from(body) }], 'gbk')[0].body);
    let shown = '', low = true; for (let i = 0; i < cv.length; i += 3) { shown += G.gbkChar(cv[i + 1], cv[i + 2]); if (cv[i + 1] >= 0xfa) low = false; }
    check(shown === '麼點龍黃麥鹽' && low, 'characters that GBK stores at FA40+ (麼 點 龍 黃 麥 鹽) are converted to spare codes below FA and read back as themselves (got "' + shown + '")');
    const plain = G.toByteString('麼', 'gbk'), spare = G.toByteString('麼', 'gbk', true);
    check(plain.charCodeAt(0) === 0xfc && plain.charCodeAt(1) === 0x4e && spare.charCodeAt(0) < 0xfa && G.gbkChar(spare.charCodeAt(0), spare.charCodeAt(1)) === '麼', 'typed text on the mainland machine uses the spare code; files for a real machine (no flag) keep the true GBK code FC4E');
    check(G.toByteString('你好', 'gbk', true) === gbk && G.gbkChar(0xc4, 0xe3) === '你', 'ordinary GB2312 characters are not touched');
    let bad = 0, n = 0; const dec = new TextDecoder('big5');
    for (let hi = 0xa4; hi <= 0xf9; hi++) for (let lo = 0x40; lo <= 0xfe; lo++) {
      if (lo > 0x7e && lo < 0xa1) continue;
      const u = dec.decode(Uint8Array.of(hi, lo)); if (u.length !== 1 || u === '�' || u.codePointAt(0) < 0x3400) continue;
      const out = G.convertLines([{ no: 10, body: Uint8Array.of(0x1f, hi, lo) }], 'gbk')[0].body;
      if (out[1] === 0xa1 && out[2] === 0xf5) continue;                      // no GBK code at all: the box
      n++; if (out[1] >= 0xfa || G.gbkChar(out[1], out[2]) !== u) bad++;
    }
    check(bad === 0 && n > 12000, 'every Big5 ideograph that has a GBK code converts to one that shows as the same character and stays out of the pictogram range (' + n + ' checked, ' + bad + ' wrong)');
  }

  // 6b2. BASIC text and the engine's small text on one screen: $E135 clears the LCD (BASIC's printed text is gone, the normal text layer stays hidden), and a later PRINT does not bring
  // the engine's 26-column scratch text back as big text (after "GAME OVER!" the title screen showed both layers on top of each other)
  {
    let r2 = await run(['PRINT "HI"', 'POKE 704+30,65', 'CALL 57653']);
    check(r2.fin.ended && r2.dev.small === true && r2.dev.printed === false, '$E135 after BASIC printed text: the screen is the engine\'s small text, BASIC\'s text layer is off again  (small ' + r2.dev.small + ', printed ' + r2.dev.printed + ')');
    r2 = await run(['PRINT "HI"', 'POKE 704+30,65:POKE 704+31,66', 'CALL 57653', 'PRINT "Z"']);
    const cells = Array.from(r2.dev.text).map((v, i) => v ? i + ':' + String.fromCharCode(v) : '').filter(Boolean);
    check(r2.fin.ended && r2.dev.printed === true && r2.dev.small === false && cells.join(',') === '20:Z', 'a PRINT after $E135 shows only what it printed: the old "HI" and the engine\'s scratch text are gone  (cells: ' + cells.join(',') + ')');
  }

  // 6c. the flash chip's command interface (what a program uses to keep a save game in the image): erase a 4 KB sector, program bytes, F0 resets
  {
    const img = new FlashImage(makeImage(), { name: 'w' }), dev = new G.Device(); let changes = 0; img.onWrite = () => changes++;
    dev.flash = img; dev.mem[0] = img.base; dev.mem[0xE0] = 0;
    const w = (a, v) => dev.poke(a, v), r = a => dev.peek(a);
    const cmd = (...seq) => { for (const [a, v] of seq) w(a, v); };
    check(r(0x4010) === 0x11, 'before any command a write to the window is ignored and reads see the image'); w(0x4010, 0x99); check(r(0x4010) === 0x11 && changes === 0, 'a plain write changes nothing');
    cmd([0x5555, 0xAA], [0xAAAA, 0x55], [0x5555, 0xA0], [0x4010, 0x01]);
    check(r(0x4010) === (0x11 & 0x01) && changes === 1, 'AA 55 A0 then a byte: a program can only clear bits (0x11 & 0x01)');
    cmd([0x5555, 0xAA], [0xAAAA, 0x55], [0x5555, 0x80], [0x5555, 0xAA], [0xAAAA, 0x55], [0x4010, 0x30]);
    check(r(0x4010) === 0xFF && r(0x4FFF) === 0xFF && r(0x4000) === 0xFF && changes === 2, 'AA 55 80 AA 55 30 erases the 4 KB sector around the address to FF');
    check(r(0x6000) === 0 && r(0x8020) === 0x33, 'neighbouring sectors are untouched');
    cmd([0x5555, 0xAA], [0xAAAA, 0x55], [0x5555, 0xA0], [0x4011, 0xF0]);
    check(r(0x4011) === 0xF0, 'the byte right after A0 is data even when it is F0');
    cmd([0x5555, 0xAA], [0x4012, 0x77], [0x5555, 0xA0], [0x4013, 0x00]);
    check(r(0x4013) === 0xFF, 'a broken unlock sequence does nothing');
    dev.mem[0] = 3; w(0x5555, 0xAA); check(img.write(3, 0x5555, 0xAA) === false, 'a bank that is not part of the image is not flash (the write goes to RAM)');
  }

  // 7. the engine's keypad: raw scan values in RAM, shown while a key is down
  {
    const dev = new G.Device(); dev.flash = new FlashImage(makeImage()); dev.flash.initRam(dev);
    const idle = dev.mem[0xC9] === 0xFF && dev.mem[0xCD] === 0xFF && dev.mem[0xC8] === 0xFF;
    dev.keyDown(20, ''); const up = dev.mem[0xC9] === 0xFB && dev.mem[199] === 128 + 20;
    dev.keyDown(23, ''); const left = dev.mem[0xCD] === 0x7F;
    dev.keyDown(1004, ''); const f4 = dev.mem[0xC8] === 0xDF && dev.mem[199] === 128 + 23;     // F4 only exists as a raw value
    check(idle && up && left && f4, 'keys show up as raw scan values ($C9/$CD/$C8) next to the key code in $C7');
    await new Promise(r => setTimeout(r, 300));
    check(dev.mem[0xC8] === 0xDF, 'a key stays down for as long as it is held (no fixed 160 ms hold any more)');
    dev.keyUp(20); dev.keyUp(23); dev.keyUp(1004); await new Promise(r => setTimeout(r, 100));
    check(dev.mem[0xC8] === 0xDF && dev.mem[0xC9] === 0xFB, 'a key that was let go stays down until a program has looked at it');
    dev.peek(0xC8); dev.peek(0xC9); dev.peek(0xCD); await new Promise(r => setTimeout(r, 30));
    check(dev.mem[0xC9] === 0xFF && dev.mem[0xCD] === 0xFF && dev.mem[0xC8] === 0xFF, 'the raw values go back to $FF after the key was released and read');
    dev.keyDown(20, ''); dev.keyUp(20);
    check(dev.peek(0xC9) === 0xFB, 'a very short tap is still seen by a program that looks once');
    check(dev.mem[0xC9] === 0xFB, '... and stays at least 70 ms');
    await new Promise(r => setTimeout(r, 100));
    check(dev.mem[0xC9] === 0xFF, '... then it is gone: a tap is a step, not a long walk');
  }

  // the ROM text routines the engine's text painter ($BB00) calls: they only report a cell to draw (the font is the page's, dev.paintCell)
  {
    const { SysCalls } = require('./syscalls.js');
    const dev = new G.Device(), calls = []; dev.paintCell = (r, c, code) => calls.push([r, c, code]);
    dev.flash = new FlashImage(makeImage()); dev.flash.initRam(dev);
    check(dev.mem[0xCE5E] === 0 && dev.mem[0xCE60] === 26 && dev.mem[0xCE62] === 52 && dev.mem[0xCE68] === 130, 'the ROM table $CE5E holds the start of each text row in the text RAM (row pitch 26)');
    const os = new SysCalls(dev), cpu = { a: 0, x: 0, y: 0 };
    cpu.x = 26 * 1 + 4; os.JSR[0xD1BA].call(os, cpu); cpu.a = 0x41; os.JSR[0xCE7E].call(os, cpu); os.JSR[0xCED6].call(os, cpu);
    dev.mem[0x92] = 0xC4; dev.mem[0x93] = 0xE3; cpu.x = 26 * 2 + 10; os.JSR[0xD1BA].call(os, cpu); os.JSR[0xD716].call(os, cpu); os.JSR[0xCA5F].call(os, cpu); os.JSR[0xCEEE].call(os, cpu);
    check(JSON.stringify(calls) === '[[1,4,65],[2,10,50403]]', 'cell index -> row / column, ASCII and double-byte glyphs are reported to the page  (' + JSON.stringify(calls) + ')');
    check(cpu.x === 26 * 2 + 10 && cpu.a === 0x41, 'the routines leave the registers alone, as the engine expects');
  }

  // INT $010A, the drawing board an RPG engine image uses for the player's 32x32 portrait; the program reads it back at $09CA (4 bytes per row)
  {
    const { SysCalls } = require('./syscalls.js');
    const dev = new G.Device(); dev.flash = new FlashImage(makeImage()); dev.gfxBase = 0x09C0;
    const os = new SysCalls(dev); let done = false; os.drawingBoard().then(() => { done = true; });
    await new Promise(r => setTimeout(r, 20));
    check(!done && dev.hint && /畫頭像/.test(dev.hint), 'the board waits for keys and shows a help line');
    {   // layout: the editing frame, the frame of the real-size picture and the area the program reads
      const on = (x, y) => dev.gfx[y * 160 + x] === 1, inkIn = (x0, y0, x1, y1) => { let n = 0; for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) n += dev.gfx[y * 160 + x]; return n; };
      check(on(6, 5) && on(73, 5) && on(6, 72) && on(73, 72) && on(40, 5) && on(40, 72) && on(6, 40) && on(73, 40), 'the editing view has a closed frame at x 6-73, y 5-72');
      check(inkIn(7, 6, 72, 6) === 0 && inkIn(7, 71, 72, 71) === 0 && inkIn(7, 6, 7, 71) === 0 && inkIn(72, 6, 72, 71) === 0, '... with one empty pixel between the frame and the 64 x 64 editing area (x 8-71, y 7-70)');
      check(on(79, 0) && on(79, 32) && on(112, 0) && on(112, 32) && on(95, 32) && !on(95, 0), 'the real-size picture has a frame on its left, right and bottom (its top edge is the screen edge, no frame there)');
      check(inkIn(80, 0, 111, 31) === 0, 'and nothing but the picture itself lies in the 32 x 32 area the program reads (still empty)');
      check(inkIn(74, 33, 159, 79) === 0 && inkIn(113, 0, 159, 32) === 0, 'nothing else is drawn on the right (the help text is added by the page, which has the font)');
    }
    const press = async k => { dev.keyDown(k, ''); await new Promise(r => setTimeout(r, 15)); };
    await press(32);                       // flip the pixel at the cursor (16,16)
    await press(22); await press(100);     // right, pen down: (17,16) is drawn
    await press(21); await press(21);      // down twice: (17,17) and (17,18)
    await press(100);                      // pen up
    await press(21);                       // down (17,19) without drawing
    await press(101); await press(20);     // eraser, up: (17,18) is erased again
    await press(13);                       // done
    await new Promise(r => setTimeout(r, 20));
    const px = (x, y) => dev.peek(0x09C0 + y * 20 + (x >> 3)) >> (7 - (x & 7)) & 1;
    check(done && dev.hint === null, 'Enter ends it');
    check(px(80 + 16, 16) === 1 && px(80 + 17, 16) === 1 && px(80 + 17, 17) === 1 && px(80 + 17, 18) === 0 && px(80 + 16, 17) === 0, 'space, pen and eraser drew the picture at x 80-111, y 0-31 (where the program reads it)');
    check(dev.peek(0x09CA + 2 + 16 * 20) === 0xC0, 'the program reads the bytes at $09CA + column + 20 * row: row 16 is 00 00 C0 00');
    let ink = 0; for (let y = 0; y < 80; y++) for (let x = 0; x < 160; x++) if (dev.gfx[y * 160 + x] && !(x >= 80 && x < 112 && y < 32)) ink++;
    check(ink === 0, 'nothing but the picture is left on the LCD');
  }

  console.log(failed ? '\n' + failed + ' FAILED' : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
