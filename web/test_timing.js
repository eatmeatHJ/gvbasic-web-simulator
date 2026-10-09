// node web/test_timing.js : execution speed, BEEP / PLAY, and the raw keypad bytes of the plain machine
const G = require('./gvb.js');
let failed = 0;
const check = (ok, what) => { console.log((ok ? 'PASS ' : 'FAIL ') + what); if (!ok) failed++; };

async function run(basic, setup) {
  const lines = basic.map((s, i) => ({ no: (i + 1) * 10, body: G.tokenizeBody(s) }));
  const dev = new G.Device(), m = new G.Machine(dev, new G.DatStore([]));
  m.prog = G.compileProgram(lines);
  if (setup) setup(dev, m);
  const t0 = Date.now(); const fin = await m.run();
  return { dev, m, fin, ms: Date.now() - t0 };
}

(async () => {
  // 1. music strings
  const n = G.parseMusic('O4L4CDE');
  check(n.length === 3 && Math.abs(n[0].freq - 261.63) < 0.1 && Math.abs(n[1].freq - 293.66) < 0.1 && n[0].dur === n[2].dur, 'PLAY string: octave 4, C D E at 261.6 / 293.7 Hz, equal lengths');
  check(Math.abs(G.parseMusic('O5A')[0].freq - 880) < 0.01 && Math.abs(G.parseMusic('O3A')[0].freq - 220) < 0.01, 'octave number moves A by 2x per octave (O5 = 880 Hz, O3 = 220 Hz)');
  const q = G.parseMusic('L8C L4DC#2R');
  check(q[0].dur === 0.2 && q[1].freq === 0 && q[1].dur === 0.2 && q[2].dur === 0.4 && Math.abs(q[3].freq - 277.18) < 0.1 && q[3].dur === 0.8 && q[4].freq === 0 && q[4].dur === 0.4, 'L sets the length, a space is a rest, a number after a note is its own length, # is a sharp, R a rest');
  check(G.parseMusic('O4L40BAGFDC').length === 6 && G.parseMusic('CCGGAAG   FFEEDDC').length === 7 + 3 + 7, 'strings from real programs parse (6 notes, notes + 3 rests)');

  // 2. BEEP / PLAY reach the host's audio, and the program waits for the tune
  const heard = [];
  const audio = { play(notes) { heard.push(notes); return notes.reduce((t, x) => t + x.dur, 0) / 20; }, stop() {} };   // 20x faster than real time to keep the test short
  let r = await run(['BEEP', 'PLAY "O4L4CD"', 'PRINT "done"'], d => { d.audio = audio; });
  check(heard.length === 2 && heard[0][0].freq === 4485 && heard[0][0].dur === 0.05 && heard[1].length === 2, 'BEEP and PLAY give the host a list of notes');
  check(r.ms >= 0.05 / 20 * 1000 + 0.8 / 20 * 1000 * 0.9, 'the program waits while the tune plays (' + r.ms + ' ms)');
  r = await run(['BEEP', 'PLAY "CDE"', 'PRINT "x"']);
  check(r.fin.ended && r.ms < 500, 'without audio (headless) BEEP and PLAY do nothing and do not wait');

  // 3. execution speed: statements per second
  r = await run(['FOR I=1 TO 300:NEXT I'], (d, m) => { m.rate = 1000; });
  check(r.ms >= 250 && r.ms < 700, 'at 1,000 statements/s a 300-iteration empty loop takes about 0.3 s (' + r.ms + ' ms)');
  r = await run(['FOR I=1 TO 300:NEXT I']);
  check(r.ms < 150, 'without a rate it runs flat out (' + r.ms + ' ms)');
  r = await run(['A$=INKEY$', 'FOR I=1 TO 100:NEXT I'], (d, m) => { m.rate = 1000; setTimeout(() => d.keyDown(13, ''), 400); });
  check(r.ms >= 450 && r.ms < 900, 'time spent waiting for a key is not "saved up" (the loop after it still takes its 0.1 s: total ' + r.ms + ' ms)');

  // 3b. the clock bytes $03F7-$03FD (PEEK 1015-1021): hour, minute, second in steps of two, year - 1881, month, day (0-based), weekday (0 = Sunday); layout as recorded from a reference implementation
  {
    const dv = new G.Device(); dv.clock = () => new Date(2004, 0, 1, 12, 34, 57);       // the reference's own default date: Thursday 2004-01-01
    const got = [1015, 1016, 1017, 1018, 1019, 1020, 1021].map(a => dv.peek(a));
    check(got.join() === [12, 34, 56, 123, 0, 0, 4].join(), 'PEEK(1015..1021) = hour, minute, second (even), year-1881, month-1, day-1, weekday  (' + got.join(',') + ')');
    dv.hour = () => 7; check(dv.peek(1015) === 7 && dv.peek(1016) === 34, 'the page can pin the hour (1015) without touching the other bytes');
  }

  // 4. the keypad matrix on the plain machine: 8 bytes, a pressed key clears its bit (arucil's key table); $BC.. by default, $BF.. for programs that read PEEK(191..198)
  const dev = new G.Device(); dev.resetRaw();
  check(Array.from({ length: 8 }, (_, i) => dev.mem[188 + i]).every(v => v === 0xFF), 'the matrix idles at $FF (8 bytes from $BC)');
  dev.keyDown(113, ''); const q1 = dev.mem[0xC3] === 0xEF;          // Q: byte 7, bit 4
  dev.keyDown(122, ''); const h1 = dev.mem[0xC3] === 0x6F;          // Z: byte 7, bit 7 (shares the byte with Q): the forum's 1P down chop = the duel program's 195/127
  dev.keyDown(112, ''); dev.keyDown(22, ''); const pr = dev.mem[0xBF] === 0xF7 && dev.mem[0xBC] === 0xF7;     // P: byte 3, right arrow: byte 0
  check(q1 && h1 && pr, 'Q / Z / P / right arrow set the bits the duel program compares ($C3 = $EF / $7F, $BF / $BC = $F7); two keys in one byte both show');
  await new Promise(res => setTimeout(res, 300));
  check(dev.mem[0xBC] === 0xF7, 'they stay while the key is held (no fixed time)');
  dev.keyUp(22); dev.peek(0xBC); await new Promise(res => setTimeout(res, 100));
  check(dev.mem[0xBC] === 0xFF && dev.mem[0xBF] === 0xF7 && dev.mem[0xC3] === 0x6F, 'a key that is let go and was looked at is released alone');
  dev.keyUp(113); dev.keyUp(122); dev.keyUp(112); dev.peek(0xC3); dev.peek(0xBF); await new Promise(res => setTimeout(res, 100));
  check(dev.mem[0xC3] === 0xFF && dev.mem[0xBF] === 0xFF, 'and the rest follow');
  { const d2 = new G.Device(); d2.rawBase = 191; d2.resetRaw();
    d2.keyDown(23, ''); const l = d2.mem[191] === 0x7F; d2.keyDown(22, ''); const lr = d2.mem[191] === 0x77; d2.keyDown(20, ''); const up = d2.mem[196] === 0xF7 && d2.mem[191] === 0x77;
    check(l && lr && up, 'with the matrix at $BF (the brick game): left = $7F, left + right = $77, up is another byte ($C4) and does not touch the paddle keys'); }
  { const mk = body => G.compileProgram([{ no: 10, body: G.tokenizeBody(body) }]);
    check(G.detectRawBase(mk('IF PEEK(191)=127 THEN 10')) === 191 && G.detectRawBase(mk('X=PEEK(197)')) === 191 && G.detectRawBase(mk('X=PEEK(P111)')) === 188 && G.detectRawBase(mk('X=PEEK(199)')) === 188, 'a program that reads PEEK(191..198) with constants gets the matrix at $BF, any other at $BC'); }

  { const run2 = async (src, base) => { const d = new G.Device(), m = new G.Machine(d, new G.DatStore([])); m.prog = G.compileProgram([{ no: 10, body: G.tokenizeBody(src) }]); if (base) m.rawBase = base; await m.run(); return d; };
    const a = await run2('X=1'), b = await run2('X=PEEK(191)'), c = await run2('X=1', 191), e = await run2('X=PEEK(191)', 188);
    check(a.rawBase === 188 && b.rawBase === 191 && c.rawBase === 191 && e.rawBase === 188, 'the keypad model chosen on the page wins over the program-based guess (auto: ' + a.rawBase + ' / ' + b.rawBase + ', $BF chosen: ' + c.rawBase + ', $BC chosen: ' + e.rawBase + ')');
    check(c.mem[191] === 0xFF && c.mem[198] === 0xFF && e.mem[188] === 0xFF, 'the chosen matrix idles at $FF'); }

  console.log(failed ? '\n' + failed + ' FAILED' : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
