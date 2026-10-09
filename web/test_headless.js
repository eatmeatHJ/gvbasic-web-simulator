// Headless end-to-end test:  node web/test_headless.js [folder-with-.BAS-files]
// Copies the folder to a temp dir (the originals are never touched), then drives the real interpreter
// with scripted key presses, using the same DatSession the web page uses.
const fs = require('fs');
const os = require('os');
const path = require('path');
const G = require('./gvb.js');
const FS = require('./fsys.js');

const SRC = path.resolve(process.argv[2] || path.join(__dirname, '..', 'small-game'));
if (!fs.existsSync(SRC)) { console.log('SKIP: no program folder (' + SRC + '); give one on the command line, the repository has no sample programs'); process.exit(0); }
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gvb-test-'));
const snap = d => fs.readdirSync(d).sort().map(f => f + ':' + fs.statSync(path.join(d, f)).size + ':' + fs.statSync(path.join(d, f)).mtimeMs).join('|');
const before = snap(SRC);
// only the programs are copied: existing .DAT files in the source folder (somebody's saved games) are left out
const copyDir = (a, b) => { fs.mkdirSync(b, { recursive: true }); for (const e of fs.readdirSync(a, { withFileTypes: true })) { if (e.isDirectory()) copyDir(path.join(a, e.name), path.join(b, e.name)); else if (/\.bas$/i.test(e.name)) fs.copyFileSync(path.join(a, e.name), path.join(b, e.name)); } };
copyDir(SRC, TMP); copyDir(SRC, path.join(TMP, 'sub'));      // same programs in the root and in a sub folder

class NodeBackend {
  constructor(root) { this.root = root; this.name = path.basename(root); this.kind = 'node'; this.writable = true; }
  async list(p) { const d = path.join(this.root, ...p); return fs.readdirSync(d, { withFileTypes: true }).map(e => ({ name: e.name, kind: e.isDirectory() ? 'dir' : 'file', size: e.isFile() ? fs.statSync(path.join(d, e.name)).size : 0 })); }
  async read(p, n) { return new Uint8Array(fs.readFileSync(path.join(this.root, ...p, n))); }
  async write(p, n, u8) { fs.writeFileSync(path.join(this.root, ...p, n), u8); }
}
const backend = new NodeBackend(TMP);
const session = new FS.DatSession(backend, (n, e) => { throw e; });

const big5 = new TextDecoder('big5');
function screenText(dev) {
  const rows = [];
  for (let r = 0; r < 5; r++) {
    let s = '';
    for (let c = 0; c < 20; c++) {
      const b = dev.text[r * 20 + c];
      if (b === 0) { s += ' '; continue; }
      if (b > 160) { const lo = dev.text[r * 20 + c + 1]; c++; s += ((b << 8) | lo) >= 0xfa40 ? '◆' : big5.decode(Uint8Array.of(b, lo)); }
      else s += String.fromCharCode(b);
    }
    rows.push(s.replace(/\s+$/, ''));
  }
  return rows;
}

async function runProgram(dirPath, name, script, opts = {}) {
  const dev = new G.Device();
  if (opts.hour !== undefined) dev.hour = () => opts.hour;
  const store = await session.load(dirPath);
  const m = new G.Machine(dev, store);
  m.name = name; m.prog = G.compileProgram(G.parseBas(await backend.read(dirPath, name)));
  const shots = [];
  let fin = null; m.run(opts.start).then(r => { fin = r; });
  let i = 0; const t0 = Date.now();
  while (fin === null) {
    await new Promise(r => setImmediate(r));
    if (Date.now() - t0 > 20000) throw new Error('timeout in ' + name);
    if (!(dev.input || dev.waiters.length)) continue;
    if (i >= script.length) { m.stop(); continue; }
    const step = script[i++];
    if (step.shot) { shots.push({ label: step.shot, rows: screenText(dev) }); continue; }
    if (typeof step === 'string' && dev.input) { for (const ch of step) dev.keyDown(-1, ch); dev.keyDown(13, ''); }
    else if (step.key !== undefined) dev.keyDown(typeof step.key === 'number' ? step.key : step.key.charCodeAt(0), '');
    else throw new Error('bad script step ' + JSON.stringify(step) + ' input=' + !!dev.input);
  }
  await session.idle();
  return { result: fin, shots };
}
const show = (title, r) => {
  console.log('=== ' + title + ' → ' + (r.result.error ? 'ERROR line ' + r.result.error.gvbLine + ': ' + r.result.error.message : JSON.stringify(r.result)));
  r.shots.forEach(s => { console.log('--- ' + s.label); s.rows.forEach(l => console.log('|' + l.padEnd(22) + '|')); });
};
const files = d => fs.readdirSync(path.join(TMP, ...d)).filter(f => /\.dat$/i.test(f)).sort().join(', ') || '(none)';
let failed = 0;
const check = (ok, what) => { console.log((ok ? 'PASS ' : 'FAIL ') + what); if (!ok) failed++; };

(async () => {
  // 1. DAT files go to the folder of the program that opened them
  let r = await runProgram([], 'BFdat.BAS', ['GH', { shot: 'BFdat in root' }, { key: 'x' }]);
  show('BFdat (root)', r);
  check(files([]) === 'G-dat.DAT, G-dat2.DAT', 'root folder got G-dat.DAT, G-dat2.DAT  → ' + files([]));
  check(files(['sub']) === '(none)', 'sub folder still has no DAT files');
  r = await runProgram(['sub'], 'BFdat.BAS', ['GH', { key: 'x' }]);
  check(files(['sub']) === 'G-dat.DAT, G-dat2.DAT', 'running the same program from sub/ writes into sub/  → ' + files(['sub']));

  // 2. a program only sees the DAT files of its own folder
  r = await runProgram(['sub'], 'BF.BAS', ['NOBODY', { shot: 'BF in sub, unknown player' }]);
  show('BF (sub, no such player)', r);
  check(r.result.error && /FILE NOT EXIST: NOBODY/.test(r.result.error.message), 'OPEN of a missing DAT is "FILE NOT EXIST" (looked up as NOBODY.DAT)');

  // 3. full game flow in the root folder
  r = await runProgram([], 'BF-I.BAS', [{ key: 'u' }, 'T1', 'T2', 'T3', 'T4', 'U1', 'U2', 'U3', 'U4'], { hour: 10 });
  r = await runProgram([], 'BF-I.BAS', ['TEST', 'PW'], { start: 11 });
  check(files([]) === 'Bank.DAT, G-dat.DAT, G-dat2.DAT, TEST.DAT', 'Bank.DAT and TEST.DAT created in root  → ' + files([]));
  r = await runProgram([], 'BF.BAS', ['TEST', 'PW', { shot: 'main menu' }, { key: 'n' }, { shot: 'status' }, { key: 'x' }, { key: 'x' }, { key: 'h' }, { shot: 'map' }]);
  show('BF play', r);
  check(r.shots[0].rows[0].includes('商戰選單'), 'game logs in and shows its main menu');

  // 4. the source folder was not modified
  check(snap(SRC) === before, 'source folder untouched (same files, sizes and timestamps as before the test)');
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(failed ? '\n' + failed + ' FAILED' : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('TEST CRASHED', e); process.exit(1); });
