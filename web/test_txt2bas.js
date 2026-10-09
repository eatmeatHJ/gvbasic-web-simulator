// node web/test_txt2bas.js : listing text -> .BAS (web/txt2bas.js, tools/txt2bas.js) and the Big5 / GBK handling around it
const fs = require('fs'), path = require('path');
const G = require('./gvb.js'), T = require('./txt2bas.js');
let failed = 0;
const check = (ok, what) => { console.log((ok ? 'PASS ' : 'FAIL ') + what); if (!ok) failed++; };
const enc = (s, e) => e === 'utf-8' ? Buffer.from(s, 'utf8') : Buffer.from(Array.from(G.toByteString(s, e), c => c.charCodeAt(0)));

(async () => {
  // 1. reading text files
  const bom = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('10 PRINT "你好"\n', 'utf8')]);
  check(T.decodeText(new Uint8Array(bom)).text.startsWith('10 PRINT "你好"') && T.decodeText(new Uint8Array(bom)).encoding === 'utf-8', 'UTF-8 with a BOM is read');
  const gbk = enc('10 PRINT "刘备"\n', 'gbk');
  check(T.decodeText(new Uint8Array(gbk)).text.includes('刘备') && T.decodeText(new Uint8Array(gbk)).encoding === 'gbk', 'GBK bytes are read as GBK');
  check(T.looksLikeProgram('10 A=1\n20 PRINT A\n30 END\n') && !T.looksLikeProgram('hello\nthis is a readme\nnot a program\n') && !T.looksLikeProgram('10 A=1\n'), 'a listing is told from other text files');

  // 2. a program: tokens, ordering, deleting with a bare number, CRLF and Ctrl-Z
  let r = T.convertText('20 PRINT "B"\r\n10 PRINT "A"\r\n30 X=1\r\n30\r\n\x1a');
  check(!r.errors.length && r.lines === 2 && G.listProgram(r.bytes) === '10 PRINT "A"\n20 PRINT "B"\n', 'lines are sorted, a bare line number deletes that line, CRLF and Ctrl-Z are fine');
  check(r.bytes[0] === 0 && G.parseBas(r.bytes).length === 2 && G.parseBas(r.bytes).base === 0x7000, 'the file is a normal .BAS (pointer base $7000 as usual)');

  // 3. round trip of this project's own sample programs: listing -> text -> .BAS -> listing is the same
  const dirs = ['samples'].map(d => path.join(__dirname, '..', d));
  let files = 0, same = 0; const diff = [];
  for (const d of dirs) if (fs.existsSync(d)) for (const f of fs.readdirSync(d)) {
    if (!/\.bas$/i.test(f)) continue;
    let b; try { b = new Uint8Array(fs.readFileSync(path.join(d, f))); G.parseBas(b); } catch (e) { continue; }
    files++;
    const cs = G.detectCharset(G.parseBas(b)), listing = G.listProgram(b, cs);
    const back = T.convertText(listing, { charset: cs });
    if (back.errors.length) { diff.push(f + ': ' + back.errors[0].msg); continue; }
    if (G.listProgram(back.bytes, cs) === listing) same++; else diff.push(f + ': listing differs');
  }
  if (!files) console.log('skip  no sample programs here (the repository has none): the listing round trip is not run'); else check(files > 5 && same === files, 'listing -> text -> .BAS -> listing is identical for ' + same + ' of ' + files + ' sample programs' + (diff.length ? ' (' + diff.slice(0, 3).join('; ') + ')' : ''));

  // 3b. basToText: the .txt the page saves next to a .BAS (UTF-8 with BOM, CRLF); converting it again gives the very same program
  {
    let n = 0, exact = 0; const bad = [];
    for (const d of dirs) if (fs.existsSync(d)) for (const f of fs.readdirSync(d)) {
      if (!/\.bas$/i.test(f)) continue;
      let b; try { b = new Uint8Array(fs.readFileSync(path.join(d, f))); G.parseBas(b); } catch (e) { continue; }
      n++;
      const cs = G.detectCharset(G.parseBas(b)), t = T.basToText(b, cs);
      const dec = T.decodeText(t.bytes), back = T.convertText(dec.text, { charset: cs });
      if (back.errors.length) { bad.push(f + ': ' + back.errors[0].msg); continue; }
      if (Buffer.from(back.bytes).equals(Buffer.from(b)) || G.listProgram(back.bytes, cs) === G.listProgram(b, cs)) exact++; else bad.push(f + ': differs');
    }
    if (!n) console.log('skip  no sample programs here: the BAS -> .txt -> BAS round trip is not run'); else check(n > 5 && exact === n, 'BAS -> .txt (basToText) -> BAS gives the same program for ' + exact + ' of ' + n + ' sample programs' + (bad.length ? ' (' + bad.slice(0, 3).join('; ') + ')' : ''));
    const one = T.convertText('10 PRINT "刘备天地会数字"\n20 PRINT "人机对战"', { charset: 'auto' }), tx = T.basToText(one.bytes);
    check(tx.bytes[0] === 0xEF && tx.bytes[1] === 0xBB && tx.bytes[2] === 0xBF && tx.text.includes('\r\n') && !/[^\r]\n/.test(tx.text), 'the file starts with a UTF-8 BOM and every line ends with CRLF');
    check(T.decodeText(tx.bytes).text.includes('刘备天地会数字'), 'simplified Chinese (a GBK program, found by its text: it needs 6 or more Chinese characters) stays readable in the .txt');
    const tw = T.basToText(T.convertText('10 PRINT "你好{FA48}"', { charset: 'auto' }).bytes);
    check(T.decodeText(tw.bytes).text.includes('你好{FA48}'), 'in a Big5 program a device pictogram is written as {FA48}');
  }

  // 4. every error is reported, keywords whose token is not known are refused (never turned into letters)
  r = T.convertText('10 CLEAR\n20 PRINT 1\n30 SLEEP 5\n40 POP\n45 PAINT 1\nXX PRINT\n');
  check(r.errors.length === 3 && /SLEEP/.test(r.errors[0].msg) && /PAINT/.test(r.errors[1].msg) && /no line number/.test(r.errors[2].msg), 'all errors are collected: SLEEP and PAINT (arucil-simulator-only statements) are refused and a line without a number is reported (' + r.errors.map(e => e.msg.split(' ')[0]).join(' | ') + ')');
  r = T.convertText('10 CLEAR\n20 POP\n');
  check(!r.errors.length && G.parseBas(r.bytes)[0].body[0] === 0x9b && G.parseBas(r.bytes)[1].body[0] === 0x8b, 'CLEAR (9b) and POP (8b) convert: their token numbers come from the official converter');

  // 5. character sets
  r = T.convertText('10 PRINT "你好嗎"');
  check(r.charset === 'big5' && !r.errors.length && G.detectCharset(G.parseBas(r.bytes)) === 'big5', 'traditional text -> Big5');
  r = T.convertText('10 PRINT "刘备天地会 数字"\n20 PRINT "冲出海底隧道"');
  const p = G.parseBas(r.bytes);
  check(r.charset === 'gbk' && !r.warnings.some(w => /does not exist/.test(w.msg)) && G.detectCharset(p) === 'gbk' && G.listProgram(r.bytes).includes('刘备天地会'), 'simplified text -> GBK, and the listing reads it back');
  r = T.convertText('10 PRINT "A{FA48}B"');
  check(!r.errors.length && r.bytes.includes(0xFA) && r.bytes.includes(0x48) && G.listProgram(r.bytes) === '10 PRINT "A{FA48}B"\n', '{FA48} is written as that device code');
  r = T.convertText('10 PRINT "你好 😀"', { charset: 'big5' });
  check(r.warnings.some(w => /does not exist in BIG5/.test(w.msg)), 'a character the character set does not have is reported, not dropped silently');
  r = T.convertText('10 PRINT "刘备"', { charset: 'gbk' });
  check(G.parseBas(r.bytes)[0].body.includes(0x1f), 'double-byte characters are stored as 1F hi lo');

  // 6. a GBK program runs with the GBK character set (no conversion, correct screen text)
  r = T.convertText('10 PRINT "刘备天地会马腾刘表刘璋"');
  const dev = new G.Device(), m = new G.Machine(dev, new G.DatStore([]));
  m.load(r.bytes, 'T.BAS'); const fin = await m.run();
  const cells = Array.from(dev.text.subarray(0, 40));
  check(fin.ended && dev.charset === 'gbk' && new TextDecoder('gbk').decode(Uint8Array.from(cells.filter(c => c))) === '刘备天地会马腾刘表刘璋', 'a GBK program shows its text correctly (screen charset ' + dev.charset + ')');

  console.log(failed ? '\n' + failed + ' FAILED' : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
