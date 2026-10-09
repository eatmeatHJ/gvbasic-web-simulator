// node web/test_lcdfont.js : the device fonts (data from arucil's res/, read through web/lcdfont.js)
const F = require('./lcdfont.js'), G = require('./gvb.js');
let failed = 0;
const check = (ok, what) => { console.log((ok ? 'PASS ' : 'FAIL ') + what); if (!ok) failed++; };
const rows = (g, w, h) => { const b = F.bits(g, w, h), o = []; for (let y = 0; y < h; y++) { let s = ''; for (let x = 0; x < w; x++) s += b[y * w + x] ? '#' : '.'; o.push(s); } return o; };

// the index: rows A1-A9 are symbols, AA-AF do not exist, B0.. are the hanzi
check(F.index(0xA1, 0xA1) === 0 && F.index(0xA9, 0xA1) === 8 * 94 && F.index(0xB0, 0xA1) === 9 * 94 && F.index(0xD2, 0xBB) === (0xD2 - 0xA1 - 6) * 94 + (0xBB - 0xA1), 'GB2312 index: the rows AA-AF are skipped');
check(F.index(0x80, 0xA1) === -1 && F.index(0xA1, 0x40) === -1 && F.index(0xFE, 0xA1) === -1, 'codes outside GB2312 have no index');

// 一 (D2BB) is one horizontal stroke; 砖 (D7A8) 12 px has its stone radical on the left
const yi = rows(F.glyph16(0xD2, 0xBB), 16, 16);
check(yi.filter(r => r.includes('#')).length === 2 && yi[6] === '##############..', '一 is a long stroke (row 6: 14 pixels) with a small hook above it');
const zhuan = rows(F.glyph12(0xD7, 0xA8), 12, 12);
check(zhuan[4] === '###########.' && zhuan.every(r => r.length === 12), '砖 in the 12 px font: the wide horizontal stroke is on row 4');
const A = rows(F.ascii12(65), 6, 12);
check(A[2] === '...#..' && A[6] === '.#####' && A[4] === '.#...#', 'the 6 x 12 ASCII "A"');

// the 527 pictures of the mainland models: every slot from F8A1 on that has data is a 16 x 16 picture
let pics = 0; for (let l = 0xF8; l <= 0xFD; l++) for (let t = 0xA1; t <= 0xFE; t++) if (F.picture16(l, t)) pics++;
check(pics === 527, 'F8A1-FDFE: 527 pictures with data  (' + pics + ')');
check(F.picture16(0xB0, 0xA1) === null && F.picture16(0xF8, 0xA0) === null, 'other codes are no pictures');
check(F.glyph16(0xA1, 0xA1) !== null && F.glyph16(0x81, 0x40) === null, 'the ideographic space is a valid blank glyph; GBK-only codes are not in the font');

// the Big5 machines' pictograms FA40 and up: the same 527 pictures, two numberings found in programs (see the comment in lcdfont.js)
{
  const same = (g, h) => !!g && !!h && Buffer.from(g).equals(Buffer.from(h));
  const gb = k => F.picture16(0xF8 + Math.floor(k / 94), 0xA1 + (k % 94));       // picture k as the GB codes F8A1.. reach it
  check(same(F.pictogram16(0xFA47, 'a'), gb(7)) && same(F.pictogram16(0xFA48, 'a'), gb(8)) && same(F.pictogram16(0xFA49, 'a'), gb(9)) && same(F.pictogram16(0xFAAD, 'a'), gb(75)), "'a': the card suits at FA47 FA48 FA49 and FAAD (past the gap of second bytes 7F-A0) are pictures 7, 8, 9 and 75");
  const heart = rows(F.pictogram16(0xFA47, 'a'), 16, 16), diamond = rows(F.pictogram16(0xFAAD, 'a'), 16, 16);
  check(heart[3] === '...####.####....' && diamond[5] === '....#######.....', "and they look like a heart and a diamond");
  check(F.pictogram16(0xFA7F, 'a') === null && F.pictogram16(0xFA90, 'a') === null && F.pictogram16(0xFAA0, 'a') === null && F.pictogram16(0xFA7E, 'a') !== null && F.pictogram16(0xFAA1, 'a') !== null, "'a': second bytes 7F-A0 are no pictograms, 7E and A1 are");
  check(F.pictogramIndex(0xFB40, 'a') === 157 && F.pictogramIndex(0xFD76, 'a') === 525 && F.pictogram16(0xFD76, 'a') !== null && F.pictogram16(0xFE40, 'a') === null, "'a': 157 codes a row; the highest code the programs use (FD76) is the second last picture, nothing from FE40");
  check(same(F.pictogram16(0xFA50, 'a'), gb(16)) && same(F.pictogram16(0xFA52, 'a'), gb(18)) && same(F.pictogram16(0xFA53, 'a'), gb(19)) && same(F.pictogram16(0xFA54, 'a'), gb(20)), "'a': the four arrows");
  check(same(F.pictogram16(0xFA56, 'b'), gb(16)) && same(F.pictogram16(0xFA58, 'b'), gb(18)) && same(F.pictogram16(0xFA59, 'b'), gb(19)) && same(F.pictogram16(0xFA5A, 'b'), gb(20)), "'b': the same four arrows six codes later (FA56 FA58 FA59 FA5A)");
  check(same(F.pictogram16(0xFA46, 'b'), gb(0)) && F.pictogram16(0xFA45, 'b') === null, "'b': FA46 is the first picture, the \"?\" (an ordinary item)");
  check(same(F.pictogram16(0xFB46, 'b'), gb(256)) && same(F.pictogram16(0xFC1C, 'b'), gb(470)) && same(F.pictogram16(0xFB04, 'b'), gb(190)), "'b': the numbering is linear: FB04 FB46 FC1C (second bytes no real code has) are pictures 190, 256, 470");
  const body = (...codes) => ({ no: 10, body: Uint8Array.from(codes.flatMap(c => [0x1f, c >> 8, c & 255])) });
  check(G.detectPictoFamily([body(0xFA56, 0xFA58)]) === 'b' && G.detectPictoFamily([body(0xFA59, 0xFA5A, 0xFA56, 0xFA58)]) === 'b', 'detectPictoFamily: two of the arrows FA56 FA58 FA59 FA5A mean numbering b');
  check(G.detectPictoFamily([body(0xFA50, 0xFA52, 0xFA56)]) === 'a' && G.detectPictoFamily([body(0xFA58)]) === 'a' && G.detectPictoFamily([body(0xFA47, 0xFA48)]) === 'a' && G.detectPictoFamily([]) === 'a', 'numbering a: its arrows, a lone FA58, suits only, nothing at all');
  check(G.detectPictoFamily([body(0xFA56, 0xFB04)]) === 'b', 'a code with a second byte below 40 can only be numbering b');
}

// the stamper (used by the snapshot tests): GBK text lands in the bitmap as the font says
{
  const dev = new G.Device(); dev.charset = 'gbk'; dev.stampCell = F.makeStamper(dev);
  const m = new G.Machine(dev, new G.DatStore([]));
  m.prog = G.compileProgram([{ no: 10, body: G.tokenizeBody('GRAPH:PRINT "' + '\xD2\xBB' + 'A' + '\xF8\xA1' + '"') }]); m.charset = 'gbk';
  m.run().then(() => {});
  const wait = () => new Promise(r => setTimeout(r, 50));
  wait().then(() => {
    const px = (cx, w) => { let o = ''; for (let y = 0; y < 16; y++) { for (let x = 0; x < w; x++) o += dev.gfx[y * 160 + cx * 8 + x] ? '#' : '.'; o += '|'; } return o; };
    check(px(0, 16) === yi.join('|') + '|', 'GRAPH-mode text: 一 is painted with the device font at cell 0');
    const pic = rows(F.picture16(0xF8, 0xA1), 16, 16).join('|') + '|';
    check(px(3, 16) === pic, 'and the picture F8A1 after "一A" (cells 3-4)  [a mainland model picture, not a hex tile]');
    console.log(failed ? '\n' + failed + ' FAILED' : '\nall passed');
    process.exit(failed ? 1 : 0);
  });
}
