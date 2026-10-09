// node web/test_compat.js : language details found by running real programs (a card game, an RPG): SWAP, spaces inside numbers, INPUT#/EOF, FILE OPEN
const G = require('./gvb.js'), T2 = require('./txt2bas.js');
let failed = 0;
const check = (ok, what) => { console.log((ok ? 'PASS ' : 'FAIL ') + what); if (!ok) failed++; };

async function run(basic, dats, seed) {
  const lines = basic.map((s, i) => ({ no: (i + 1) * 10, body: G.tokenizeBody(s) }));
  const dev = new G.Device(), store = new G.DatStore(dats || []), m = new G.Machine(dev, store);
  m.prog = G.compileProgram(lines); if (seed !== undefined) m.seed = seed;
  const fin = await m.run();
  return { dev, m, fin, store };
}
const rows0 = dev => { const o = []; for (let i = 0; i < 5; i++) { let t = ''; for (let k = 0; k < 20; k++) { const c = dev.text[i * 20 + k]; t += c ? String.fromCharCode(c) : ' '; } if (t.trim()) o.push(t.trimEnd()); } return o; };
const screen = dev => { let s = ''; for (let i = 0; i < 100; i++) s += dev.text[i] ? String.fromCharCode(dev.text[i]) : ' '; return s.replace(/\s+$/, ''); };

(async () => {
  // 1. SWAP (token $88: how a card game shuffles and sorts its cards)
  let r = await run(['A=1:B=2:SWAP A,B', 'DIM P(4,13):P(1,1)=5:P(2,3)=9:SWAP P(1,1),P(2,3)', 'PRINT A;B;P(1,1);P(2,3)']);
  check(r.fin.ended && screen(r.dev) === '2195', 'SWAP exchanges two variables or array elements (screen: "' + screen(r.dev) + '")');
  const bytes = G.tokenizeBody('SWAP A,B');
  check(bytes[0] === 0x88, 'SWAP is token $88 in a saved program');

  // 1b. token numbers from the official converter (BasToTxt.exe table), and the statements / functions that came with them
  check(G.tokenizeBody('CLEAR')[0] === 0x9b && G.tokenizeBody('TEXT')[0] === 0x9d && G.tokenizeBody('NORMAL')[0] === 0xa0 && G.tokenizeBody('INVERSE')[0] === 0xa1 && G.tokenizeBody('POP')[0] === 0x8b && G.tokenizeBody('X=LOF(1)').includes(0xe8), 'CLEAR 9b, TEXT 9d, NORMAL a0, INVERSE a1, POP 8b, LOF e8');
  r = await run(['A=5:B$="X":DIM D(3):D(1)=7', 'CLEAR:DIM D(3):PRINT "[";A;B$;D(1);"]"']);
  check(r.fin.ended && screen(r.dev) === '[00]', 'CLEAR forgets variables, strings and arrays, so DIM works again  (screen: "' + screen(r.dev) + '")');
  r = await run(['DEF FN F(X)=X+1:CLEAR:PRINT FN F(1)']);
  check(r.fin.error && /UNDEF'D FUNCTION/.test(r.fin.error.message), 'CLEAR also forgets DEF FN');
  r = await run(['FOR I=1 TO 2:CLEAR:NEXT I:PRINT "ok";I']);
  check(r.fin.error && /NEXT WITHOUT FOR/.test(r.fin.error.message), 'CLEAR empties the FOR stack (firmware: NEXT WITHOUT FOR)');
  r = await run(['GOSUB 40', 'PRINT "back"', 'END', 'CLEAR:RETURN']);
  check(r.fin.error && /RETURN WITHOUT GOSUB/.test(r.fin.error.message), 'CLEAR empties the GOSUB stack (firmware: RETURN WITHOUT GOSUB)');
  r = await run(['DATA 1,2,3:READ A:CLEAR:READ B:PRINT A;B']);
  check(r.fin.ended && screen(r.dev) === '01', 'CLEAR sets the DATA pointer back to the start (firmware: A=0, B=1)  (screen: "' + screen(r.dev) + '")');
  r = await run(['GOSUB 40', 'PRINT "BACK":END', 'END', 'POP:PRINT "IN":GOTO 20']);
  check(r.fin.ended && /IN\s*BACK/.test(screen(r.dev)) && r.m.gosubs.length === 0, 'POP drops the GOSUB return address (screen: "' + screen(r.dev) + '")');
  r = await run(['POP']);
  check(r.fin.error && /RETURN WITHOUT GOSUB/.test(r.fin.error.message), 'POP with nothing to pop is an error');
  r = await run(['A$=MKI$(-2):PRINT CVI$(A$);LEN(A$);ASC(A$)']);
  check(r.fin.ended && screen(r.dev) === '-22254', 'MKI$ / CVI$: two bytes, low byte first, signed  (screen: "' + screen(r.dev) + '")');
  r = await run(['A$=MKS$(3.25):B$=MKS$(-3.25):PRINT CVS$(A$);LEN(A$);ASC(MID$(A$,1,1));ASC(MID$(A$,2,1));ASC(MID$(B$,2,1))']);
  check(r.fin.ended && screen(r.dev) === '3.25513080208', 'MKS$ / CVS$: 5 bytes, exponent first (130 for 3.25), then the fraction .101b = $50, sign in bit 7 of byte 2  (screen: "' + screen(r.dev) + '")');
  r = await run(['B$=MKS$(1.5)', 'FOR I=1 TO 5:PRINT ASC(MID$(B$,I,1));",";:NEXT I']);
  check(r.fin.ended && screen(r.dev) === '129,64,0,0,0,', 'MKS$(1.5) = 129,64,0,0,0 as read back from the NC3000 firmware  (screen: "' + screen(r.dev) + '")');
  r = await run(['PRINT ABS(CVS$(MKS$(-0.1))+0.1)<1E-6']);
  check(r.fin.ended && screen(r.dev) === '1', 'MKS$ / CVS$ round trip keeps 31 bits of fraction  (screen: "' + screen(r.dev) + '")');

  // 1c. operator precedence (arucil's test_case, fancyblock's grammar notes) and the device's RND generator
  r = await run(['PRINT 2^3^2;-2^2;2^-1;1 AND 1 OR 0 AND 0;1 OR 3 AND 2']);
  check(r.fin.ended && screen(r.dev) === '64-4.511', '^ groups left to right, -2^2 = -4, AND binds tighter than OR (as on the NC3000 firmware)  (screen: "' + screen(r.dev) + '")');
  r = await run(['PRINT NOT 0;NOT 5;NOT -1;NOT 1+1;NOT 0*5;-NOT 0;NOT NOT 3', 'A=1:PRINT NOT A=1;NOT A=2;6 AND 3;6 OR 3;0 OR 0.5', 'PRINT 1 OR 0 AND 0;0 AND 1 OR 1;2>1 AND 3>2;1=1 OR 0=1 AND 0=1']);
  check(r.fin.ended && screen(r.dev).replace(/\s+/g, '') === '1001' + '5-1' + '1' + '00111' + '1111', 'NOT, AND, OR give 0 or 1; NOT is tighter than * + and comparisons  (screen: "' + screen(r.dev).replace(/\s+/g, '') + '")');
  // how the device prints numbers (PRINT, STR$ and WRITE#), checked on the NC3000 firmware
  r = await run(['PRINT 0.5', 'PRINT -0.1', 'PRINT 1/3', 'PRINT 0.05;" ";0.000123']);
  check(r.fin.ended && rows0(r.dev).join(' ') === '.5 -.1 .333333333 .05 1.23E-04', 'numbers print without a leading zero, 9 digits, E notation below 0.01  (' + rows0(r.dev).join(' ') + ')');
  r = await run(['PRINT 999999999;" ";1E9', 'PRINT 1234567890', 'PRINT 2^40', 'PRINT STR$(0.5);STR$(1E-3)']);
  check(r.fin.ended && rows0(r.dev).join(' ') === '999999999 1E+09 1.23456789E+09 1.09951163E+12 .51E-03', 'plain decimals up to 999999999, then E+09; STR$ uses the same format  (' + rows0(r.dev).join(' ') + ')');
  // RND: sequences recorded from the NC3000 firmware (a 5-byte floating-point generator, docs/NC3000韌體.md)
  const rows = dev => { const o = []; for (let i = 0; i < 5; i++) { let t = ''; for (let k = 0; k < 20; k++) { const c = dev.text[i * 20 + k]; t += c ? String.fromCharCode(c) : ' '; } o.push(t.trimEnd()); } return o; };
  r = await run(['A=RND(-1)', 'PRINT RND(1)', 'PRINT RND(1)', 'PRINT RND(0)', 'PRINT RND(5)']);
  check(r.fin.ended && rows(r.dev).slice(0, 4).join(' ') === '.738207502 .272707136 .272707136 .299733446', 'RND(-1) starts the sequence .738207502 .272707136 .299733446, RND(0) repeats, RND(5) is just the next one  (' + rows(r.dev).join(' ') + ')');
  r = await run(['A=RND(-3)', 'PRINT RND(1)', 'A=RND(-3)', 'PRINT RND(1)', 'PRINT RND(1)']);
  check(r.fin.ended && rows(r.dev).slice(0, 3).join(' ') === '.235586735 .235586735 .186784665', 'RND(-3) always restarts at .235586735 then .186784665  (' + rows(r.dev).join(' ') + ')');
  { const dv = new G.Device(), mm = new G.Machine(dv, new G.DatStore([]));      // bytes as a device file would hold them (tokenizeBody writes capitals)
    mm.prog = G.compileProgram([{ no: 10, body: Uint8Array.from([0x61, 0x62, 0x63, 0x3d, 0x31]) }]); const fn = await mm.run();
    check(fn.error && /SYNTAX ERROR/.test(fn.error.message), 'a lowercase variable name in a program is a SYNTAX ERROR, as on the device'); }
  r = T2.convertText('10 abc=1\n20 PRINT abc');
  check(!r.errors.length && r.warnings.some(w => /lowercase name abc/.test(w.msg)) && G.listProgram(r.bytes) === '10 ABC=1\n20 PRINT ABC\n', 'the text converter writes capitals and says so');

  // 1d. random files (arucil's runtime_4 test, and what the downloaded falling-block game programs do)
  r = await run(['OPEN "R4" FOR RANDOM AS 1 LEN=5', 'FIELD 1, 1 AS A$, 2 AS B$, 2 AS C$', 'GET 1,2:PRINT A$;"-";B$;"-";C$', 'GET 1,1:PRINT A$;"-";B$;"-";C$', 'PRINT LOF(1):CLOSE 1'], [{ name: 'R4.DAT', data: '1234567890' }]);
  check(r.fin.ended && screen(r.dev).replace(/\s+/g, ' ') === '6-78-90 1-23-45 10', 'GET reads records of LEN bytes split by FIELD (same output as arucil), LOF is the size in bytes  (screen: "' + screen(r.dev) + '")');
  r = await run(['OPEN "M" FOR RANDOM AS#1 LEN=1:FIELD #1,1 AS MP$', 'FOR A=1 TO 5:LSET MP$=CHR$(64+A):PUT #1,A:NEXT', 'CLOSE #1:OPEN "M" FOR RANDOM AS#1 LEN=1:FIELD #1,1 AS MP$', 'GET #1,3:PRINT MP$;LOF(1);ASC(MP$)']);
  check(r.fin.ended && screen(r.dev) === 'C567', 'PUT builds a new file record by record, GET finds it again, a file that does not exist is created by OPEN  (screen: "' + screen(r.dev) + '")');
  check(r.store.get('M').length === 5 && r.store.get('M') === 'ABCDE', 'the DAT file holds the records back to back');
  r = await run(['OPEN "Q" FOR RANDOM AS 1:FIELD 1,6 AS A$,4 AS B$', 'LSET A$="AB":RSET B$="XY":PUT 1,1:GET 1,1:PRINT LEN(A$);LEN(B$);ASC(A$);MID$(A$,2,1);ASC(MID$(A$,3,1));B$']);
  check(r.fin.ended && screen(r.dev) === '6465B0  XY', 'FIELD without LEN, LSET / RSET keep the field width and leave the rest as it was (zero bytes show as blanks)  (screen: "' + screen(r.dev) + '")');
  r = await run(['OPEN "Q" FOR RANDOM AS 1:FIELD 1,2 AS A$', 'PUT 1,3']);
  check(r.fin.error && /RECORD NUMBER/.test(r.fin.error.message), 'a record cannot be written past the end plus one');
  r = await run(['OPEN "Q" FOR OUTPUT AS 1:PRINT LOF(1)']);
  check(r.fin.error && /FILE MODE/.test(r.fin.error.message), 'LOF needs a random file');

  // 1d2. file and random-file semantics measured on the real firmware (docs/NC3000韌體.md): LSET writes over the start of the variable and leaves the rest, RSET
  // fills the whole width with blanks on the left, the FIELD variables are windows into one record buffer, a plain assignment cuts a variable loose from it
  {
    const H = ['OPEN "R" FOR RANDOM AS #1 LEN=8', 'FIELD #1,4 AS A$,4 AS B$'];
    const asc4 = v => 'PRINT ASC(' + v + ');"/";ASC(MID$(' + v + ',2,1));"/";ASC(MID$(' + v + ',3,1));"/";ASC(MID$(' + v + ',4,1))';
    const cases = [
      [[...H, 'LSET A$="WXYZ":LSET A$="AB"', asc4('A$')], '65/66/89/90', 'LSET writes over the start of the variable, the rest stays'],
      [[...H, 'RSET B$="WXYZ":RSET B$="CD"', asc4('B$')], '32/32/67/68', 'RSET fills the whole width, blanks on the left'],
      [[...H, 'LSET A$="WXYZ":LSET A$=""', asc4('A$')], '87/88/89/90', 'LSET of an empty string changes nothing'],
      [[...H, 'RSET B$="WXYZ":RSET B$=""', asc4('B$')], '32/32/32/32', 'RSET of an empty string blanks the field'],
      [[...H, 'LSET A$="TOOLONG":PRINT A$'], 'TOOL', 'LSET keeps the first characters of a text that is too long'],
      [[...H, 'RSET B$="ABCDEFG":PRINT B$'], 'ABCD', 'RSET keeps the first characters of a text that is too long too'],
      [['A$="ABCDEF":LSET A$="XY":PRINT A$;LEN(A$)'], 'XYCDEF6', 'LSET on an ordinary string variable'],
      [['A$="ABCDEF":RSET A$="XY":PRINT A$;LEN(A$)'], '    XY6', 'RSET on an ordinary string variable'],
      [[...H, 'PRINT LEN(A$);ASC(A$)'], '40', 'a FIELD variable starts as zero bytes of the field width'],
      [[...H, 'A$="XY":LSET A$="Q":PRINT A$;LEN(A$)'], 'QY2', 'after a plain assignment LSET works on the ordinary string'],
      [[...H, 'A$="XY":PUT #1,1:GET #1,1:PRINT ASC(A$);LEN(A$)'], '882', 'a plain assignment cuts the variable loose: PUT does not write it, GET does not touch it'],
      [[...H, 'LSET A$="XY":PUT #1,1:A$="Q":GET #1,1:PRINT A$;LEN(A$)'], 'Q1', 'GET does not reconnect a cut-loose variable'],
      [[...H, 'A$="XY":PUT #1,1:CLOSE #1', ...H, 'GET #1,1:PRINT ASC(A$)'], '0', 'what a cut-loose variable held never reached the file'],
      [['OPEN "R" FOR RANDOM AS #1 LEN=8', 'FIELD #1,4 AS A$', 'FIELD #1,4 AS B$', 'LSET A$="WXYZ":PRINT B$'], 'WXYZ', 'two FIELD statements start at the same place: their variables share the bytes'],
      [[...H, 'LSET B$="QRST":FIELD #1,4 AS A$:PRINT ASC(B$)'], '0', 'a FIELD statement clears the whole record buffer'],
      [[...H, 'LSET A$="AB":CLOSE #1:PRINT A$'], 'AB', 'a FIELD variable keeps its text when the file is closed'],
      [[...H, 'LSET A$="AB":PUT #1,1:PUT #1,2:PRINT LOF(1)'], '16', 'records follow one another'],
      [['OPEN "R" FOR RANDOM AS #1', 'FIELD #1,4 AS A$,4 AS B$:PUT #1,1:PRINT LOF(1)'], '32', 'without LEN a record is 32 bytes'],
      [['OPEN "R" FOR RANDOM AS #1 LEN=0', 'PUT #1,1:PRINT LOF(1)'], '32', 'LEN=0 means 32 as well'],
      [['OPEN "R" FOR RANDOM AS #1 LEN=8', 'PUT #1,1:PRINT LOF(1)'], '8', 'PUT works without a FIELD (a record of zero bytes)'],
      [['OPEN "T" FOR OUTPUT AS #1:WRITE #1,"X":CLOSE #1', 'OPEN "T" FOR INPUT AS #1', 'PRINT EOF(1);:INPUT #1,A$:PRINT EOF(1)'], '01', 'EOF is 1 (not -1) once the last record has been read'],
      [['PRINT "AB";CHR$(0);CHR$(0);"CD";LEN("AB"+CHR$(0)+"C")'], 'ABCD4', 'PRINT draws no cell for CHR$(0)'],
      [['PRINT "[";CHR$(31);"]"'], '[]', 'PRINT draws no cell for CHR$(31) either'],
    ];
    for (const [prog, want, what] of cases) { r = await run(prog); check(r.fin.ended && screen(r.dev) === want, what + '  (screen: "' + screen(r.dev) + '"' + (r.fin.error ? ', error: ' + r.fin.error.message : '') + ')'); }
    const errors = [   // [program, error pattern, text]: the names the firmware prints; a statement that names a file that is not open (or open in the wrong mode) is a SYNTAX ERROR there, the functions say FILE MODE
      [['GET #1,1'], /^SYNTAX/, 'GET on a file that is not open'],
      [['WRITE #1,"X"'], /^SYNTAX/, 'WRITE# on a file that is not open'],
      [['INPUT #1,A$'], /^SYNTAX/, 'INPUT# on a file that is not open'],
      [['OPEN "T" FOR OUTPUT AS #1', 'FIELD #1,4 AS A$'], /^SYNTAX/, 'FIELD on a file that is not a random file'],
      [['OPEN "T" FOR OUTPUT AS #1:WRITE #1,"X":CLOSE #1', 'OPEN "T" FOR INPUT AS #1', 'WRITE #1,"Y"'], /^SYNTAX/, 'WRITE# on a file opened for INPUT'],
      [['OPEN "T" FOR OUTPUT AS #1', 'INPUT #1,A$'], /^SYNTAX/, 'INPUT# on a file opened for OUTPUT'],
      [['OPEN "T" FOR OUTPUT AS #1:WRITE #1,"X":CLOSE #1', 'OPEN "T" FOR INPUT AS #1', 'GET #1,1'], /^SYNTAX/, 'GET on a file that is not a random file'],
      [[...H, 'CLOSE #1', 'PUT #1,1'], /^SYNTAX/, 'PUT after CLOSE'],
      [['OPEN "T" FOR OUTPUT AS #4'], /^SYNTAX/, 'file number 4'],
      [['OPEN "T" FOR OUTPUT AS #0'], /^SYNTAX/, 'file number 0'],
      [['PRINT LOF(1)'], /^FILE MODE/, 'LOF of a file that is not open'],
      [['PRINT EOF(1)'], /^FILE MODE/, 'EOF of a file that is not open'],
      [['OPEN "T" FOR OUTPUT AS #1', 'PRINT EOF(1)'], /^FILE MODE/, 'EOF of an OUTPUT file'],
      [['OPEN "T" FOR APPEND AS #1', 'PRINT EOF(1)'], /^FILE MODE/, 'EOF of an APPEND file'],
      [[...H, 'PRINT EOF(1)'], /^FILE MODE/, 'EOF of a random file'],
      [['OPEN "T" FOR APPEND AS #1', 'PRINT LOF(1)'], /^FILE MODE/, 'LOF of an APPEND file'],
      [['OPEN "T" FOR OUTPUT AS #1:WRITE #1,"X":CLOSE #1', 'OPEN "T" FOR INPUT AS #1', 'PRINT LOF(1)'], /^FILE MODE/, 'LOF of an INPUT file'],
      [['OPEN "R" FOR RANDOM AS #1 LEN=4', 'CLEAR', 'PRINT LOF(1)'], /^FILE MODE/, 'CLEAR closes the files'],
      [['OPEN "T" FOR OUTPUT AS #1:CLOSE #1', 'CLOSE #1'], /^FILE CLOSE/, 'CLOSE of a file that is closed'],
      [['OPEN "T" FOR OUTPUT AS #1', 'OPEN "U" FOR OUTPUT AS #1'], /^FILE OPEN/, 'OPEN on a file number in use'],
      [['OPEN "NOPE" FOR INPUT AS #1'], /^FILE NOT EXIST/, 'OPEN FOR INPUT of a file that is not there'],
      [['OPEN "T" FOR OUTPUT AS #1:WRITE #1,"X":CLOSE #1', 'OPEN "T" FOR INPUT AS #1', 'INPUT #1,A$,B$'], /^OUT OF DATA/, 'INPUT# past the last item'],
      [['OPEN "R" FOR RANDOM AS #1 LEN=4', 'FIELD #1,8 AS A$'], /^OUT OF DATA/, 'FIELD wider than the record'],
      [['OPEN "R" FOR RANDOM AS #1', 'FIELD #1,40 AS A$'], /^OUT OF DATA/, 'FIELD wider than the default 32-byte record'],
      [['OPEN "R" FOR RANDOM AS #1 LEN=300'], /^ILLEGAL QUANTITY/, 'LEN above 255'],
      [[...H, 'PUT #1,0'], /^RECORD NUMBER/, 'record number 0'],
      [[...H, 'PUT #1,1:PUT #1,3'], /^RECORD NUMBER/, 'a record cannot leave a gap'],
      [[...H, 'GET #1,1'], /^RECORD NUMBER/, 'GET past the end of the file'],
      [[...H, 'LSET A$=5'], /^TYPE MISMATCH/, 'LSET needs a string'],
    ];
    for (const [prog, re, what] of errors) { r = await run(prog); check(r.fin.error && re.test(r.fin.error.message), what + ': ' + re + '  (got: ' + (r.fin.error ? r.fin.error.message : 'no error') + ')'); }
  }

  // 1e. things real programs do that the manual does not show (two sample programs)
  r = await run(['A=2:IF A=1 THEN 40:ELSE PRINT "NO":GOTO 50', 'PRINT "X"', 'END', 'PRINT "YES"', 'PRINT "END"']);
  check(r.fin.ended && screen(r.dev).replace(/\s+/g, ' ') === 'NO END', 'a colon in front of ELSE after THEN n  (screen: "' + screen(r.dev) + '")');
  r = await run(['A=1:IF A=1 THEN PRINT "T":ELSE PRINT "F"', 'IF A=2 THEN 60 ELSE PRINT "E"']);
  check(r.fin.ended && screen(r.dev).replace(/\s+/g, ' ') === 'T E', 'ELSE still works with and without the colon  (screen: "' + screen(r.dev) + '")');
  // junk after an assignment: checked on the NC3000 firmware (docs/NC3000韌體.md). Inside THEN/ELSE the rest of the line is dropped silently, anywhere else it is a SYNTAX ERROR.
  r = await run(['A=0:IF A=1 THEN PRINT "T" ELSE B$="" GOTO 40', 'PRINT "NOJUMP"', 'END', 'PRINT "AT40"']);
  check(r.fin.ended && screen(r.dev) === 'NOJUMP', 'ELSE B$="" GOTO 40: the GOTO after the assignment is ignored, the next line runs  (screen: "' + screen(r.dev) + '")');
  r = await run(['IF 1=1 THEN B$="" PRINT "X":PRINT "Y"', 'PRINT "N"']);
  check(r.fin.ended && screen(r.dev) === 'N', 'the rest of the line after such an assignment is dropped, even behind a colon  (screen: "' + screen(r.dev) + '")');
  r = await run(['IF 1=1 THEN A=1:B=2 PRINT "X"', 'PRINT "N"']);
  check(r.fin.ended && screen(r.dev) === 'N', 'same after a second assignment  (screen: "' + screen(r.dev) + '")');
  r = await run(['IF 1=1 THEN B$="":PRINT "X":PRINT "Y"', 'PRINT "N"']);
  check(r.fin.ended && screen(r.dev).replace(/\s+/g, ' ') === 'X Y N', 'colons keep working inside a branch  (screen: "' + screen(r.dev) + '")');
  for (const bad of ['B$="" GOTO 30', 'A=1 PRINT "X"', 'IF 1=1 THEN PRINT "A" PRINT "B"', 'FOR I=1 TO 2 PRINT "X"', 'IF 1=1 THEN LOCATE 1,1 PRINT "X"']) {
    r = await run([bad, 'PRINT "N"', 'PRINT "L"']);
    check(r.fin.error && /SYNTAX/.test(r.fin.error.message), bad + ': still a SYNTAX ERROR (bare assignment + statement, PRINT + PRINT, FOR + statement, LOCATE inside IF)');
  }
  r = await run(['OPEN "OA" FOR OUTPUTAS#1:WRITE #1,5:CLOSE#1', 'OPEN "OA" FOR APPENDAS#1:WRITE #1,6:CLOSE#1', 'OPEN "OA" FOR INPUT AS#1:INPUT #1,A:INPUT #1,B:PRINT A;B']);
  check(r.fin.ended && screen(r.dev) === '56', 'FOR OUTPUTAS#1 / APPENDAS#1: no blank needed before AS  (screen: "' + screen(r.dev) + '")');
  r = await run(['A=5:IF A<>1 THEN 30:REM remark with <> and more', 'PRINT "NO"', 'PRINT "YES"']);
  check(r.fin.ended && screen(r.dev) === 'YES', '<> in front of a REM on the same line is still one operator (the main program of an RPG)  (screen: "' + screen(r.dev) + '")');
  r = await run(['OPEN "G" FOR RANDOMAS#1LEN=4:FIELD#1,4ASY$', 'LSET Y$="AB":PUT 1,1:GET 1,1:PRINT ASC(Y$);LEN(Y$)']);
  check(r.fin.ended && screen(r.dev) === '654', 'FIELD#1,4ASY$ and RANDOMAS#1LEN=4 written without blanks (the character program of an RPG)  (screen: "' + screen(r.dev) + '")');
  r = await run(['INVERSE:PRINT "AB":NORMAL:PRINT "C":FLASH:PRINT "D":NORMAL:CLS:PRINT "E"']);
  check(r.fin.ended && r.dev.inv[0] === 0 && r.dev.inv[20] === 0, 'CLS clears the attributes, so text printed afterwards is normal again');
  r = await run(['INVERSE:PRINT "AB":NORMAL:PRINT "C":FLASH:PRINT "D"']);
  check(r.fin.ended && r.dev.inv[0] === 1 && r.dev.inv[1] === 1 && r.dev.inv[2] === 0 && r.dev.inv[20] === 0 && r.dev.inv[40] === 2, 'INVERSE, NORMAL and FLASH set the attribute of the text printed afterwards  (' + Array.from(r.dev.inv.subarray(0, 3)).join('') + ' ' + r.dev.inv[20] + ' ' + r.dev.inv[40] + ')');
  r = await run(['INVERSE:PRINT "A":NORMAL:FOR I=1 TO 6:PRINT I:NEXT']);
  check(r.fin.ended && r.dev.inv[0] === 0 && r.dev.inv.every(v => v === 0), 'inverse text scrolls away with its row');

  // 1f. GRAPH mode: every PRINT draws all the characters of the text RAM into the bitmap again (arucil's updateLCD); a space wipes its cell (the marker of a map editor program)
  {
    const dv = new G.Device(), mm = new G.Machine(dv, new G.DatStore([]));
    dv.stampCell = (r, c) => { const b = dv.text[r * 20 + c]; for (let y = 0; y < 16; y++) for (let x = 0; x < 8; x++) dv.gfx[(r * 16 + y) * 160 + c * 8 + x] = b === 32 ? 0 : 1; return 1; };   // a fake font: a block for a letter, nothing for a space
    mm.prog = G.compileProgram([{ no: 10, body: G.tokenizeBody('GRAPH:LOCATE 2,15:PRINT " build";') }, { no: 20, body: G.tokenizeBody('BOX 114,22,117,25') }, { no: 30, body: G.tokenizeBody('LOCATE 1,1:PRINT " ";') }]);
    await mm.run();
    const marker = (x, y) => dv.gfx[y * 160 + x];
    check(marker(114, 22) === 0 && marker(117, 25) === 0 && dv.gfx[24 * 160 + 120] === 1, 'a later PRINT re-draws the text RAM: the blank in front of "build" wipes the marker BOX drew in that cell, the letters stay  (marker pixel: ' + marker(114, 22) + ')');
  }

  // 1g. drawing as the device simulator does it (arucil's gvb_device.cpp): DDA lines, midpoint circles, draw mode & 3, BOX cut to the screen, coordinates 0..255
  {
    const px = d => { const o = []; for (let y = 0; y < 80; y++) for (let x = 0; x < 160; x++) if (d.gfx[y * 160 + x]) o.push(x + ',' + y); return o.join(' '); };
    let d = new G.Device(); d.line(0, 0, 4, 2, 1);
    check(px(d) === '0,0 1,0 2,1 3,1 4,2', 'a line steps like floor(i * d / length): (0,0)-(4,2) is 0,0 1,0 2,1 3,1 4,2 (not the rounded one)  (' + px(d) + ')');
    d = new G.Device(); d.line(4, 2, 0, 0, 1);
    check(px(d) === '0,0 1,0 2,1 3,1 4,2', 'and the same line the other way round');
    d = new G.Device(); d.ellipse(10, 10, 3, 3, false, 1);
    check(d.gfx[10 * 160 + 13] && d.gfx[10 * 160 + 7] && d.gfx[13 * 160 + 10] && d.gfx[7 * 160 + 10] && !d.gfx[10 * 160 + 10], 'a circle touches its four extreme points and is hollow');
    d = new G.Device(); d.ellipse(10, 10, 3, 3, true, 1);
    check(d.gfx[10 * 160 + 10] && d.gfx[10 * 160 + 8] && d.gfx[11 * 160 + 12], 'a filled circle is filled');
    r = await run(['GRAPH:DRAW 5,5,3:DRAW 6,6,4:DRAW 7,7,1:DRAW 7,7,2:DRAW 8,8,2']);
    check(r.fin.ended && !r.dev.gfx[5 * 160 + 5] && !r.dev.gfx[6 * 160 + 6] && !r.dev.gfx[7 * 160 + 7] && r.dev.gfx[8 * 160 + 8], 'draw mode 3 draws nothing, 4 is 4 & 3 = 0 = clear, 2 flips');
    r = await run(['GRAPH:BOX 100,10,200,20']);
    check(r.fin.ended && r.dev.gfx[10 * 160 + 159] === 1 && r.dev.gfx[15 * 160 + 159] === 1 && r.dev.gfx[15 * 160 + 100] === 1, 'a BOX that reaches past the screen is cut: its right side is drawn on the last column');
    r = await run(['GRAPH:LINE 0,0,300,0']);
    check(r.fin.ended && r.dev.gfx[0] === 1 && r.dev.gfx[159] === 1, 'a coordinate above 255 is cut to 255');
    r = await run(['GRAPH:BOX -1,0,10,10']);
    check(r.fin.error && /ILLEGAL QUANTITY/.test(r.fin.error.message), 'a negative coordinate is an error');
    r = await run(['GRAPH:BOX 10,10,20,20,0.5']);
    check(r.fin.ended && r.dev.gfx[15 * 160 + 15] === 1, 'a fill value that is not zero fills');
    r = await run(['PRINT "A"', 'POKE 199,155', 'PRINT "AFTER"']);
    check(r.fin.stopped && !/AFTER/.test(screen(r.dev)), 'POKE 199,155 ends the program (it is how programs leave on Esc)');
  }

  // 2. spaces inside a number are ignored, as in Applesoft ("8 0" is 80); a space between numbers separated by an operator is not part of one number
  r = await run(['A=8 0:B=1 2.5 0', 'PRINT A;B;3 + 4']);
  check(r.fin.ended && screen(r.dev) === '8012.57', '"8 0" is 80 and "1 2.5 0" is 12.5 ("' + screen(r.dev) + '")');

  // 3. INPUT#: after the last record has been read EOF is true (the end-of-record mark is consumed)
  r = await run([
    'OPEN "T" FOR OUTPUT AS #1:FOR I=1 TO 3:WRITE#1,"N"+STR$(I),I,I*2:NEXT I:CLOSE#1',
    'OPEN "T" FOR INPUT AS #1:L=0',
    'INPUT#1,N$,A,B:L=L+1:S=S+A+B:IF EOF(1) THEN CLOSE#1 ELSE 30',
    'PRINT L;S']);
  check(r.fin.ended && screen(r.dev) === '318', 'a read loop ended by EOF(1) reads exactly the 3 records written (screen: "' + screen(r.dev) + '", error: ' + (r.fin.error && r.fin.error.message) + ')');
  const dat = r.store.get('T');
  check(dat === '"N1",1,2\xff"N2",2,4\xff"N3",3,6\xff', 'WRITE# format: quoted strings, comma separated, FF ends a record');

  // 4. OPEN on a file number that is still open is an error (the setup programs of a real RPG stop there; their DAT files match byte for byte)
  r = await run(['OPEN "A" FOR OUTPUT AS #1', 'OPEN "A" FOR APPEND AS #1']);
  check(r.fin.error && /^FILE OPEN/.test(r.fin.error.message), 'OPEN on an open file number raises FILE OPEN (the firmware\'s name for it)');

  // 5. READ continues through all DATA statements in program order; OUT OF DATA when they run out
  r = await run(['DATA 1,2:READ A,B', 'DATA 3:READ C:READ D']);
  check(r.fin.error && /OUT OF DATA/.test(r.fin.error.message) && r.m.getVar('C') === 3, 'DATA/READ run through the program in order, then OUT OF DATA');

  // 5b. SWAP works the indexes out once: a card game shuffles with random indexes and must keep all 52 cards (it used to duplicate cards)
  {
    let lost = 0;
    for (let n = 0; n < 20; n++) {
      const rr = await run(['DIM P(4,13)', 'FOR I=1 TO 4:FOR J=1 TO 13:P(I,J)=I*100+J:NEXT J,I', 'FOR I=1 TO 4:FOR J=1 TO 13:SWAP P(INT(RND(1)*4+1),INT(RND(1)*13+1)),P(I,J):NEXT J,I']);
      const vals = rr.m.arrs.get('P').data.filter(v => v);
      lost += 52 - new Set(vals).size;
    }
    check(lost === 0, 'a deck shuffled with SWAP and random indexes keeps all 52 different cards in 20 shuffles (cards lost: ' + lost + ')');
  }

  // 5c. the string variables as the interpreter keeps them in RAM: programs find A$ and B$ in a table of 5-byte entries from 12605 and POKE the length and address, so that A$ is a window onto memory
  {
    const SCAN = ['A$="":B$="":FOR A=12605 TO 15000', 'IF PEEK(A)=65 AND PEEK(A+5)=66 THEN 50', 'NEXT A', 'PRINT "NOT FOUND":END'];
    r = await run([...SCAN, 'PRINT A;PEEK(A+1);PEEK(A+6)']);
    check(r.fin.ended && screen(r.dev) === '1260500', 'the entry of the first string variable is at 12605, the next one 5 bytes on (length byte 0 for an empty string)  (screen: "' + screen(r.dev) + '")');
    r = await run([...SCAN, 'POKE 12288,72:POKE 12289,73:POKE 12290,33', 'POKE A+1,3:POKE A+2,0:POKE A+3,48', 'PRINT A$;LEN(A$)']);
    check(r.fin.ended && screen(r.dev) === 'HI!3', 'POKEing length and address makes A$ read the bytes at 12288 ("HI!")  (screen: "' + screen(r.dev) + '")');
    r = await run([...SCAN, 'POKE A+1,4:POKE A+2,0:POKE A+3,48', 'LSET A$="XYZWV":PRINT PEEK(12288);PEEK(12291);PEEK(12292)']);
    check(r.fin.ended && screen(r.dev) === '88870', 'LSET writes into that memory, as many bytes as the length says ("XYZW", not the fifth)  (screen: "' + screen(r.dev) + '")');
    r = await run([...SCAN, 'POKE 12288,65:POKE A+1,2:POKE A+2,0:POKE A+3,48', 'A$="Q":PRINT A$;PEEK(12288);LEN(A$)']);
    check(r.fin.ended && screen(r.dev) === 'Q651', 'a plain assignment gives the variable its own storage again: the memory is left alone  (screen: "' + screen(r.dev) + '")');
    // the save / load idiom of a real program: A$ looks at game RAM, a random file record is copied from / to it
    r = await run([...SCAN, 'FOR I=0 TO 9:POKE 12400+I,I*3+1:NEXT I', 'POKE A+1,10:POKE A+2,112:POKE A+3,48', 'OPEN "SV" FOR RANDOM AS#1 LEN=10:FIELD#1,10 AS Y$', 'LSET Y$=A$:PUT#1,1', 'FOR I=0 TO 9:POKE 12400+I,0:NEXT I', 'GET#1,1:LSET A$=Y$', 'PRINT PEEK(12400);PEEK(12405);PEEK(12409)']);
    check(r.fin.ended && screen(r.dev) === '11628', 'save RAM through A$ into a record, wipe it, load it back through A$  (screen: "' + screen(r.dev) + '")');
    r = await run([...SCAN, 'POKE A+1,1:POKE A+2,0:POKE A+3,48:CLEAR', 'A$="":B$="":C$="X"', 'PRINT PEEK(12605);PEEK(12610);PEEK(12615);PEEK(12606)']);
    check(r.fin.ended && screen(r.dev) === '6566670', 'CLEAR starts a new table (entries again in the order of the first assignments)  (screen: "' + screen(r.dev) + '")');
  }

  // 5d. INPUT with the screen in GRAPH mode: what is typed is stamped into the bitmap, so deleting a character has to wipe its pixels too (the name stayed on the screen after Backspace)
  {
    const F = require('./lcdfont.js'), dev = new G.Device(), m = new G.Machine(dev, new G.DatStore([]));
    dev.stampCell = F.makeStamper(dev);
    m.prog = G.compileProgram(['GRAPH:INPUT A$', 'PRINT A$'].map((s, i) => ({ no: (i + 1) * 10, body: G.tokenizeBody(s) })));
    const done = m.run(); await new Promise(r => setTimeout(r, 30));
    const px = () => { let n = 0; for (let y = 0; y < 16; y++) for (let x = 0; x < 160; x++) n += dev.gfx[y * 160 + x]; return n; };
    const n0 = px(); dev.keyDown(-1, 'A'); const n1 = px(); dev.keyDown(-1, 'B'); const n2 = px();
    check(n0 > 0 && n1 > n0 && n2 > n1, 'GRAPH mode INPUT: every typed character adds pixels  (' + [n0, n1, n2].join(', ') + ')');
    dev.keyDown(29, ''); check(px() === n1, 'Backspace takes the last character out of the bitmap again  (' + px() + ' = ' + n1 + ')');
    dev.keyDown(29, ''); check(px() === n0, 'and the one before it  (' + px() + ' = ' + n0 + ')');
    dev.keyDown(-1, G.toByteString('你', 'big5')); const n3 = px(); dev.keyDown(-1, 'Z'); dev.keyDown(29, ''); dev.keyDown(29, '');
    check(n3 > n0 && px() === n0, 'a two-byte character (two cells) goes completely  (' + px() + ' = ' + n0 + ')');
    dev.keyDown(-1, 'Q'); dev.keyDown(13, ''); await done;
    check(screen(dev) !== '' && /Q/.test(screen(dev)), 'the line that was finished is still typed text (the Q is on the screen)');
  }

  // 5e. the key codes INKEY$ gives (measured on the NC3000 firmware: one character each; F1-F4 = 28-31, help 25, arrows 20-23, letters always lower case)
  {
    const K = G.codeFromKey;
    check(['F1', 'F2', 'F3', 'F4'].map(K).join() === '28,29,30,31', 'F1-F4 are the key codes 28-31 (F1 used to be the help key 25)  (' + ['F1', 'F2', 'F3', 'F4'].map(K).join() + ')');
    check(K('ArrowUp') === 20 && K('ArrowDown') === 21 && K('ArrowRight') === 22 && K('ArrowLeft') === 23 && K('Enter') === 13 && K('Escape') === 27 && K(' ') === 32, 'arrows 20 up, 21 down, 22 right, 23 left, Enter 13, Esc 27, space 32');
    check(K('PageUp') === 19 && K('PageDown') === 14 && K('Backspace') === 29, 'the page keys are 19 and 14, Backspace is the delete key 29');
    check(K('a') === 97 && K('A') === 97 && K('z') === 122 && K('Z') === 122, 'letters are always the lower-case code, Shift or Caps Lock or not');
    check(K('b') === 98 && K('1') === 98 && K('9') === 117, 'the number keys 1-9 are the keys b n m / g h j / t y u');
  }

  // 5f. a string literal needs no closing quote at the end of a line, and then runs to the end of the line, colons included (measured on the NC3000 firmware, whose own editor does not add the quote either)
  {
    const cases = [
      [['PRINT "AB'], 'AB', 'PRINT "AB without the closing quote prints AB'],
      [['PRINT "AB:PRINT 1'], 'AB:PRINT 1', 'the unclosed string takes the colon and everything after it with it'],
      [['A$="XY:PRINT A$;LEN(A$)'], '', 'so after A$="XY: the rest of the line is the string and nothing is printed'],
      [['PRINT "AB";:PRINT "CD'], 'ABCD', 'an unclosed string on the last statement of a line works next to closed ones'],
    ];
    for (const [prog, want, what] of cases) { r = await run(prog); check(r.fin.ended && screen(r.dev) === want, what + '  (screen: "' + screen(r.dev) + '")'); }
    const body = G.tokenizeBody('PRINT "AB');
    check(G.listLineBytes(body) === 'PRINT "AB', 'listing a line without the closing quote shows it as stored, no quote is added');
  }

  // 6. an installed engine image is only for programs that CALL machine code
  const withCall = G.buildBas([{ no: 10, body: G.tokenizeBody('POKE 8192,96:CALL 8192') }], 0x7000);
  const without = G.buildBas([{ no: 10, body: G.tokenizeBody('PRINT "HI":POKE 8192,96') }], 0x7000);
  check(G.programUsesCall(withCall) === true && G.programUsesCall(without) === false, 'programUsesCall tells programs that CALL machine code from those that do not');

  console.log(failed ? '\n' + failed + ' FAILED' : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
