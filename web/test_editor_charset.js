// node web/test_editor_charset.js : the line editor works in the character set of the file it edits (Big5 or GBK); nothing but programs made right here
const G = require('./gvb.js');
const E = require('./editor.js');
let failed = 0;
const check = (ok, what) => { console.log((ok ? 'PASS ' : 'FAIL ') + what); if (!ok) failed++; };
const big5 = new TextDecoder('big5');

(async () => {
  let ed;
  // the editor works in the character set of the file: a program converted from simplified Chinese text is GBK, it must not be shown (or re-encoded) as Big5
  {
    const T2 = require('./txt2bas.js'), gbk = new TextDecoder('gbk');
    const u8 = s => Uint8Array.from(s, c => c.charCodeAt(0));
    const conv = T2.convertText('10 PRINT "请选择对弈模式"\n20 PRINT "人机对战":END', { charset: 'auto' });
    ed = new E.LineEditor({ name: 'S.BAS', bytes: conv.bytes });
    check(ed.cs === 'gbk' && ed.lead === 0x80, 'a program converted from simplified Chinese text is detected as GBK  (' + ed.cs + ')');
    const shown = ed.view().rows.filter(Boolean).map(r => gbk.decode(u8(r))).join('');       // a long line wraps over the rows
    check(shown.includes('请选择对弈模式') && shown.includes('人机对战'), 'its text decodes as GBK on the editor screen  (' + shown + ')');
    check(big5.decode(u8(ed.lines[0].text)) !== gbk.decode(u8(ed.lines[0].text)), '(and decoded as Big5 it would be the garbage seen before)');
    // type a GBK character into the first line and build: the new bytes are GBK, the untouched line keeps its original bytes
    ed = new E.LineEditor({ name: 'S.BAS', bytes: conv.bytes }); ed.moveTo(0, 0); ed.key('end');
    ed.key('left'); ed.key('left'); ed.key('left'); ed.key('left');                    // over the closing quote and 式 模 (so the new character lands before 弈)
    for (const ch of [...'新']) ed.key('char', G.toByteString(ch, 'gbk'));
    const r = ed.build();
    const listed = G.listProgram(r.bytes, 'gbk');
    check(!r.errors && listed.includes('请选择对新弈模式') && listed.includes('人机对战'), 'typing a character and building keeps the file GBK  (' + listed.split('\n')[0] + ')');
    const l2 = G.parseBas(r.bytes).find(l => l.no === 20), o2 = G.parseBas(conv.bytes).find(l => l.no === 20);
    check(Buffer.from(l2.body).equals(Buffer.from(o2.body)), 'the line that was not touched is written back byte for byte');
    // a new program starts in Big5 (the project default); a forced character set wins
    check(new E.LineEditor({}).cs === 'big5' && new E.LineEditor({ bytes: conv.bytes, charset: 'big5' }).cs === 'big5' && new E.LineEditor({ charset: 'gbk' }).lead === 0x80, 'a new program is Big5; the "BAS 字集" setting can force either');
    // GBK characters whose first byte is below 0xA1 (the extension area) are one character, not two stray bytes
    const rare = G.toByteString('丂', 'gbk'), eg = new E.LineEditor({ charset: 'gbk' });
    eg.key('char', rare); eg.key('left');                                                // a new line starts as "10 ", the cursor behind it
    check(rare.charCodeAt(0) === 0x81 && eg.idx === 3, 'a GBK-extension character (first byte 81) is a single character for the cursor  (idx ' + eg.idx + ')');
  }

  console.log(failed ? '\n' + failed + ' FAILED' : '\nall passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('TEST CRASHED', e); process.exit(1); });
