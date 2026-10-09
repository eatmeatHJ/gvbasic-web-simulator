// node web/test_extensions.js : the arucil simulator's own words (SLEEP PAINT LOAD POINT CHECKKEY FOPEN FGETC FTELL FPUTC FREAD FWRITE FSEEK, OPEN ... FOR BINARY).
// The device has none of them: a program that uses them can be run here, but it never becomes a device .BAS.
const G = require('./gvb.js'), T = require('./txt2bas.js');
let failed = 0;
const check = (ok, what) => { console.log((ok ? 'PASS ' : 'FAIL ') + what); if (!ok) failed++; };
const screen = dev => { let s = ''; for (let i = 0; i < 100; i++) s += dev.text[i] ? String.fromCharCode(dev.text[i]) : ' '; return s.replace(/\s+/g, ' ').trim(); };

async function runText(text, dats, rate) {
  const r = T.convertText(text, { ext: 'auto' });
  if (r.errors.length) return { r };
  const dev = new G.Device(), store = new G.DatStore(dats || []), m = new G.Machine(dev, store);
  m.ext = r.ext; m.rate = rate || 0; m.load(r.bytes, 't');
  const t0 = Date.now(), fin = await m.run();
  return { r, dev, m, store, fin, ms: Date.now() - t0 };
}

(async () => {
  // 1. the converter keeps the device language apart from the simulator's words
  let r = T.convertText('10 SLEEP 5\n20 PRINT 1');
  check(r.errors.length === 1 && r.errors[0].sim && /arucil/.test(r.errors[0].msg), 'SLEEP is refused for a device .BAS, and marked as a simulator word  (' + (r.errors[0] && r.errors[0].msg.slice(0, 40)) + ')');
  r = T.convertText('10 SLEEP 5\n20 PRINT 1', { ext: 'auto' });
  check(!r.errors.length && r.ext && r.extUsed.join() === 'SLEEP', 'ext "auto" accepts it for running here');
  r = T.convertText('10 LOAD "A"\n20 PRINT 1', { ext: 'auto' });
  check(!r.errors.length && !r.ext, 'the device\'s own LOAD "file" is not mistaken for the simulator\'s LOAD');
  r = T.convertText('10 LOAD 4096,1,7', { ext: 'auto' });
  check(!r.errors.length && r.ext, 'LOAD addr,size,bytes is the simulator\'s');
  r = T.convertText('10 PRINT POINT(1,2)');
  check(!r.errors.length && r.warnings.some(w => /POINT\(/.test(w.msg)), 'POINT( in a plain program is only a warning (it is an array name on the device)');
  r = T.convertText('10 sleep 5\n20 a=1', { ext: 'auto' });
  check(!r.errors.length && !r.warnings.some(w => /lowercase/.test(w.msg)), 'lowercase is fine in a simulator program (its language ignores case)');
  r = T.convertText('10 SLEEP 5:PAINT 4096,0,0,8,2,4:X=POINT(1,1)+CHECKKEY(22)', { ext: 'auto' });
  check(G.listProgram(r.bytes) === '10 SLEEP 5:PAINT 4096,0,0,8,2,4:X=POINT(1,1)+CHECKKEY(22)\n', 'the listing shows the words again  (' + JSON.stringify(G.listProgram(r.bytes)) + ')');

  // 2. LOAD / PAINT / POINT
  let x = await runText('10 load 4096,2,255,129\n20 paint 4096,0,0,8,2\n30 print point(0,0);point(1,0);point(0,1);point(1,1);point(200,0)');
  check(x.fin.ended && screen(x.dev) === '11101', 'LOAD puts bytes in RAM, PAINT copies the picture, POINT reads pixels (outside the screen counts as black)  (screen: "' + screen(x.dev) + '")');
  x = await runText('10 load 4096,2,255,129\n20 paint 4096,0,0,8,2\n30 paint 4096,0,0,8,2,4\n40 print point(0,0);point(0,1);point(3,1)');
  check(x.fin.ended && screen(x.dev) === '000', 'PAINT mode 4 (xor) wipes what was just copied  (screen: "' + screen(x.dev) + '")');
  x = await runText('10 load 4096,1,128\n20 paint 4096,-1,0,8,1\n30 print point(0,0);point(1,0)');
  check(x.fin.ended && screen(x.dev) === '00', 'a picture may start left of the screen: its first column is cut off  (screen: "' + screen(x.dev) + '")');

  // 3. binary files
  x = await runText('10 open "B" for binary as 1\n20 fseek 1,2\n30 print fgetc(1);ftell(1);fopen(1);fopen(2)\n40 fread 1,8192,3\n50 print peek(8192);peek(8194)\n60 fputc 1,"Z"\n70 fwrite 1,8192,2\n80 close 1', [{ name: 'B.DAT', data: 'ABCDEFGH' }]);
  check(x.fin.ended && screen(x.dev) === '67310 6870', 'FSEEK / FGETC / FTELL / FOPEN / FREAD on a binary file  (screen: "' + screen(x.dev) + '")');
  check(x.store.get('B') === 'ABCDEFZDE', 'FPUTC and FWRITE write at the file pointer and extend the file  (' + x.store.get('B') + ')');
  x = await runText('10 open "NOPE" for binary as 1', []);
  check(x.fin.error && /FILE NOT EXIST/.test(x.fin.error.message), 'a binary file must exist already');
  x = await runText('10 open "R" for random as 1 len=2\n20 fputc 1,"A":fputc 1,"B":fseek 1,0:print fgetc(1);ftell(1);lof(1)\n30 close 1');
  check(x.fin.ended && screen(x.dev) === '6525' || (x.fin.ended && screen(x.dev) === '6512'), 'the byte statements also work on a random file  (screen: "' + (x.dev && screen(x.dev)) + '")');

  // 4. SLEEP waits 0.4 ms per tick when the machine is throttled, nothing when it runs flat out
  x = await runText('10 sleep 500\n20 print 1', [], 1000);
  check(x.fin.ended && x.ms >= 150 && x.ms < 1500, 'SLEEP 500 takes about 200 ms at a set speed  (' + x.ms + ' ms)');
  x = await runText('10 sleep 500\n20 print 1', [], 0);
  check(x.fin.ended && x.ms < 150, 'and nothing at "as fast as possible"  (' + x.ms + ' ms)');

  // 5. CHECKKEY follows the keys that are down
  const dev = new G.Device();
  dev.keyDown(22, ''); const down = dev.held.has(22); dev.keyUp(22);
  check(down && !dev.held.has(22), 'a key is "held" from keyDown to keyUp (CHECKKEY)');
  x = await runText('10 sleep 0:print checkkey(22);checkkey(23)');
  check(x.fin.ended && screen(x.dev) === '00', 'no key down: CHECKKEY is 0');

  // 6. without the switch the extra words do not exist
  const body = Uint8Array.from([0xee, 0x20, 0x35]);
  const plain = G.compileProgram([{ no: 10, body }]);
  check(plain.lines[0].code[0].op === 'unsupported' && /TOK_EE/.test(plain.lines[0].code[0].name), 'a device program with the byte $EE in it does not suddenly get a SLEEP');

  console.log(failed ? '\n' + failed + ' FAILED' : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
