// node web/test_editor.js : the line editor edits real programs and the result runs in the interpreter
const fs = require('fs'), path = require('path');
const G = require('./gvb.js');
const E = require('./editor.js');
let failed = 0;
const check = (ok, what) => { console.log((ok ? 'PASS ' : 'FAIL ') + what); if (!ok) failed++; };
const type = (ed, s) => { for (const ch of s) ed.key('char', ch); };
if (!fs.existsSync(path.join(__dirname, '..', 'small-game', 'BF-I.BAS'))) { console.log('SKIP: edits a real sample program (small-game/BF-I.BAS), which the repository does not have; test_editor_charset.js has the self-contained editor tests'); process.exit(0); }
// BF-I.BAS as the author left it: sign-up locked (line 2 reads THEN 1). small-game/BF-I.BAS has been fixed since,
// so the locked version is rebuilt in memory by taking that one byte out again.
const bf_i = (() => {
  const now = new Uint8Array(fs.readFileSync(path.join(__dirname, '..', 'small-game', 'BF-I.BAS')));
  const ls = G.parseBas(now), l2 = ls.find(l => l.no === 2), b = Array.from(l2.body);
  const at = b.findIndex((x, i) => x === 0xc4 && b[i + 1] === 0x31 && b[i + 2] === 0x31 && b[i + 3] === 0x20 && b[i + 4] === 0xc5);
  if (at >= 0) l2.body = Uint8Array.from([...b.slice(0, at + 2), ...b.slice(at + 3)]);       // THEN 11 -> THEN 1
  return G.buildBas(ls, ls.base);
})();
const big5 = new TextDecoder('big5');

async function run(bytes, script) {
  const dev = new G.Device();
  const m = new G.Machine(dev, new G.DatStore([]));
  m.prog = G.compileProgram(G.parseBas(bytes));
  let fin = null; m.run().then(r => { fin = r; });
  const t0 = Date.now(); let i = 0;
  while (fin === null && Date.now() - t0 < 5000) {
    await new Promise(r => setImmediate(r));
    if (!(dev.input || dev.waiters.length)) continue;
    if (i >= script.length) { m.stop(); continue; }
    const s = script[i++];
    if (typeof s === 'function') s(dev); else dev.keyDown(s.charCodeAt(0), '');
  }
  return { dev, fin };
}
const row = (dev, r) => { let s = ''; for (let c = 0; c < 20; c++) { const b = dev.text[r * 20 + c]; if (!b) { s += ' '; continue; } if (b > 160) { s += big5.decode(Uint8Array.of(b, dev.text[r * 20 + c + 1])); c++; } else s += String.fromCharCode(b); } return s.trimEnd(); };

(async () => {
  // 1. fix the real BF-I.BAS line 2 (THEN 1 -> THEN 11) with the editor, as a user would
  let ed = new E.LineEditor({ name: 'BF-I.BAS', bytes: bf_i });
  const li = ed.lines.findIndex(l => /^2 /.test(l.text));
  const at = ed.lines[li].text.indexOf('THEN 1') + 6;
  ed.moveTo(li, at); ed.key('char', '1'); ed.key('enter');
  check(ed.lines[li].text.includes('THEN 11 ELSE'), 'line 2 now reads THEN 11 ELSE   → ' + ed.lines[li].text.slice(0, 40));
  let r = ed.build();
  check(!r.errors && r.warnings.length === 0, 'build succeeds with no warnings');
  const before = G.parseBas(bf_i), after = G.parseBas(r.bytes);
  const k2 = before.findIndex(l => l.no === 2);
  const same = before.every((l, k) => k === k2 || Buffer.compare(Buffer.from(l.body), Buffer.from(after[k].body)) === 0);
  check(before.length === after.length && same, 'every untouched line keeps its original bytes (' + (before.length - 1) + ' of ' + before.length + ' lines)');
  const tb = G.lex(before[k2].body), ta = G.lex(after[k2].body);
  const diffs = tb.map((t, i) => [t, ta[i]]).filter(([x, y]) => JSON.stringify(x) !== JSON.stringify(y));
  check(tb.length === ta.length && diffs.length === 1 && diffs[0][0].v === 1 && diffs[0][1].v === 11, 'the edited line differs from the original only by that number (1 → 11); ' + before[k2].body.length + ' → ' + after[k2].body.length + ' bytes');
  let res = await run(r.bytes, ['b']);
  check(/ENTER:/.test(row(res.dev, 4) + row(res.dev, 3) + row(res.dev, 2)) && res.dev.input === null, 'pressing 1 (b) in the edited program now reaches the ENTER: prompt   → ' + [0,1,2,3,4].map(i => row(res.dev, i)).join(' | '));

  // 2. a new program typed from scratch (auto line numbers, lower case accepted, ? = PRINT)
  ed = new E.LineEditor();
  type(ed, 'print "hello":a=2*3'); ed.key('enter'); type(ed, '? a;"!"'); ed.key('enter'); type(ed, 'end');
  check(ed.lines.map(l => l.text.slice(0, 3)).join('|') === '10 |20 |30 ', 'Enter appends the next line number (+10)  → ' + ed.lines.map(l => l.text).join(' / '));
  r = ed.build();
  res = await run(r.bytes, []);
  check(row(res.dev, 0) === 'hello' && row(res.dev, 1) === '6!', 'it runs: ' + row(res.dev, 0) + ' / ' + row(res.dev, 1));

  // 3. Chinese text inside a string and a remark
  ed = new E.LineEditor();
  type(ed, 'REM '); ed.key('char', G.toByteString('註解')); ed.key('enter');
  type(ed, 'PRINT "'); ed.key('char', G.toByteString('你')); ed.key('char', G.toByteString('好')); type(ed, '"');
  r = ed.build();
  const lines = G.parseBas(r.bytes);
  check(Buffer.from(lines[1].body).toString('hex').includes('1fa741') || /1f[0-9a-f]{4}1f[0-9a-f]{4}/.test(Buffer.from(lines[1].body).toString('hex')), 'double-byte characters are stored with the 0x1F prefix');
  res = await run(r.bytes, []);
  check(row(res.dev, 0) === '你好', 'Chinese text prints back correctly   → ' + row(res.dev, 0));
  check(G.listLineBytes(lines[0].body).includes(G.toByteString('註解')), 'remark text round-trips');

  // 4. mistakes are reported, not saved
  ed = new E.LineEditor(); ed.lines[0].text = '10 SLEEP 5';
  r = ed.build(); check(r.errors && /SLEEP/.test(r.errors[0].msg), 'a keyword the device does not have is refused   → ' + (r.errors && r.errors[0].msg));
  ed = new E.LineEditor(); ed.lines[0].text = 'PRINT 1';
  r = ed.build(); check(r.errors && /Line number/.test(r.errors[0].msg), 'a line without a number is refused');
  ed = new E.LineEditor(); ed.lines[0].text = '10 FOR I=1';          // legal to tokenise, wrong syntax
  r = ed.build(); check(r.bytes && r.warnings.length === 1 && r.warnings[0].no === 10, 'syntax problems are only warnings   → ' + JSON.stringify(r.warnings));

  // 5. lines are sorted by number; a bare number deletes that line; the later duplicate wins
  ed = new E.LineEditor(); ed.lines = [{ text: '30 PRINT 3' }, { text: '10 PRINT 1' }, { text: '20 PRINT 2' }, { text: '20 ' }, { text: '10 PRINT 9' }].map(l => Object.assign({ orig: null, origText: null }, l));
  r = ed.build(); const nums = G.parseBas(r.bytes).map(l => l.no + ':' + G.listLineBytes(l.body)).join(' ');
  check(nums === '10:PRINT 9 30:PRINT 3', 'sorted, bare number deletes, last duplicate wins   → ' + nums);

  // 6. wrapping and cursor
  ed = new E.LineEditor(); type(ed, 'PRINT "' + 'X'.repeat(30) + '"');
  let v = ed.view();
  check(v.rows[0].length === 20 && v.rows[1].length === 20 && v.rows[2].length === 1 && v.cy === 2 && v.cx === 1, 'a 41-byte line wraps over 3 rows; cursor after the last character (x=' + v.cx + ', y=' + v.cy + ')');
  ed.key('up'); check(ed.view().cy === 1, 'Up moves to the row above inside the same line');
  ed = new E.LineEditor({ bytes: bf_i }); for (let i = 0; i < 60; i++) ed.key('down');
  check(ed.view().cy >= 0 && ed.view().cy < 5, 'the view scrolls with the cursor (cursor row ' + ed.view().cy + ')');

  console.log(failed ? '\n' + failed + ' FAILED' : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('TEST CRASHED', e); process.exit(1); });
