// node web/test_hw.js : the hardware layer for games that talk to the chip directly (wqxhw.js), with a tiny game made up here
const G = require('./gvb.js'), HW = require('./wqxhw.js'), { FlashImage } = require('./flash.js'), { assemble } = require('./asm6502.js');
let failed = 0;
const check = (ok, what) => { console.log((ok ? 'PASS ' : 'FAIL ') + what); if (!ok) failed++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* a 2-page image: header at file $4000 (name, JMP entry at +$18, A5 AA 55 at +$1B), code at $4040:
 * wait for the timer tick in $01, count frames in RAM $0800, scan keypad lines $04 and $80 into $0810 / $0811, put the counter on the LCD ($19C0) */
function makeGame() {
  const b = new Uint8Array(0x10000).fill(0xFF);
  const hdr = [0x40, 0x00, ...Buffer.from('TEST GAME'), ...new Array(0x18 - 2 - 9).fill(0), 0x4C, 0x40, 0x40, 0xA5, 0xAA, 0x55];
  b.set(hdr, 0x4000);
  const code = assemble(`
      .org $4040
      CLD
      LDX #$FF
      TXS
      LDA #$00
      STA $0800
loop: LDA $01
      AND #$01
      BEQ loop
      INC $0800
      LDA #$04
      STA $09
      LDA $08
      STA $0810
      LDA #$80
      STA $09
      LDA $08
      STA $0811
      LDA #$00
      STA $09
      LDA $0800
      STA $19C0
      JMP loop`).segments[0];
  b.set(code.bytes, 0x4000 + (code.addr - 0x4000));
  return b;
}

(async () => {
  const bytes = makeGame(), info = HW.detectGame(bytes);
  check(info && info.name === 'TEST GAME' && info.entry === 0x4040, 'detectGame reads the name and the entry point from the header');
  check(HW.detectGame(new Uint8Array(0x8000)) === null && HW.detectGame(new Uint8Array(100)) === null, 'files without a game header are not games');
  const noSig = bytes.slice(); noSig[0x401B] = 0; check(HW.detectGame(noSig) === null, 'the A5 AA 55 signature is required');

  const dev = new G.Device(), game = new HW.RawGame(dev, new FlashImage(bytes, { name: 'TEST GAME' }), info, { autoTick: false });
  game.io.keymap = { 23: [[0x04, 0]], 22: [[0x04, 2]], 13: [[0x80, 5]] };         // left, right, enter, as a game would define them
  let result = null; game.run().then(r => { result = r; });
  await sleep(50);
  check(game.running && dev.mem[0x0800] === 0, 'the game starts and waits for the timer tick (no frame yet)');
  const stepsIdle = game.cpu.steps; await sleep(100);
  check(game.cpu.steps - stepsIdle < 200000, 'while it waits for a tick the CPU does not spin flat out (' + (game.cpu.steps - stepsIdle) + ' steps in 100 ms)');
  for (let i = 0; i < 5; i++) { game.io.tick(); await sleep(15); }
  check(dev.mem[0x0800] === 5, 'one frame per tick (counter = ' + dev.mem[0x0800] + ')');
  check(dev.peek(0x19C0) === 5 && dev.gfx[5] === 1 && dev.gfx[0] === 0, 'writes to $19C0 show up on the LCD bitmap');
  game.io.tick(); await sleep(15);
  check(dev.mem[0x0810] === 0 && dev.mem[0x0811] === 0, 'nothing pressed: the scan reads 0');
  game.io.press(23); game.io.tick(); await sleep(15);
  check(dev.mem[0x0810] === 0x01 && dev.mem[0x0811] === 0, 'left shows on line $04 bit 0');
  game.io.press(22); game.io.press(13); game.io.tick(); await sleep(15);
  check(dev.mem[0x0810] === 0x05 && dev.mem[0x0811] === 0x20, 'right (line $04 bit 2) and enter (line $80 bit 5) show on their lines');
  game.io.release(23); game.io.release(22); game.io.release(13); game.io.tick(); await sleep(15);
  check(dev.mem[0x0810] === 0 && dev.mem[0x0811] === 0, 'released keys read 0 again');
  game.stop(); game.io.tick(); await sleep(50);
  check(result && result.stopped && !game.running, 'stop() ends the run');
  check(dev.hw === null, 'the hardware layer is detached afterwards');

  // the same device runs plain BASIC again, with zero page behaving as RAM
  const m = new G.Machine(dev, new G.DatStore([]));
  m.prog = G.compileProgram([{ no: 10, body: G.tokenizeBody('POKE 8,77:POKE 1,9:PRINT PEEK(8);PEEK(1)') }]);
  const r = await m.run();
  check(r.ended && String.fromCharCode(...dev.text.subarray(0, 4)) === '779\0'.replace('\0', '\0'), 'afterwards zero page is plain RAM again for BASIC programs');

  // install or run? The header is the same for every program, a short trial run on bare hardware decides (the real RPG engine image has the header too)
  let cl = HW.classifyImage(makeGame());
  check(cl.kind === 'game' && cl.info.name === 'TEST GAME', 'a game that only uses the chip is run, not installed  (' + cl.reason + ')');
  const needsBios = makeGame(); needsBios.set(assemble('.org $4040\n CLD\n JSR $E135\n RTS').segments[0].bytes, 0x4040);
  cl = HW.classifyImage(needsBios);
  check(cl.kind === 'install' && cl.info, 'an image that reaches into the ROM at once is installed, although it has the header  (' + cl.reason + ')');
  const withInt = makeGame(); withInt.set(assemble('.org $4040\n CLD\n INT $8A2E\n RTS').segments[0].bytes, 0x4040);
  cl = HW.classifyImage(withInt);
  check(cl.kind === 'install', 'an INT system call (BRK) counts as reaching into the ROM  (' + cl.reason + ')');
  check(HW.classifyImage(new Uint8Array(0x10000)).kind === 'install', 'an image without a header is installed');
  { const dv = new G.Device(), gm = new HW.RawGame(dv, new FlashImage(withInt, { name: 'TEST GAME' }), HW.detectGame(withInt), { autoTick: false });
    const res = await gm.run();
    check(res.error && /安裝/.test(res.error.message), 'forced to run as a game, such an image stops with a message that says to install it instead  (' + (res.error && res.error.message.slice(0, 40)) + ')'); }
  { const fsm = require('fs'), pth = require('path'); const real = [['神州/GVbasic+.bin', 'install'], ['SUPER-MARIO V1.2.bin', 'game']];
    for (const [f, want] of real) {
      const p = pth.join(__dirname, '..', f); if (!fsm.existsSync(p)) { console.log('skip  ' + f + ' is not here'); continue; }
      const c = HW.classifyImage(new Uint8Array(fsm.readFileSync(p)));
      check(c.kind === want, 'the real ' + f + ' is told apart correctly: ' + c.kind + '  (' + c.reason + ')'); } }

  console.log(failed ? '\n' + failed + ' FAILED' : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
