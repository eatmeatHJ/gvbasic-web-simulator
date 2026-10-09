// node tools/make_demo.js   -> writes demo/HELLO.BIN, demo/DRAW.BIN, demo/CALLDEMO.BAS
// Small programs written for this project to show the machine-code side of the emulator.
const fs = require('fs');
const path = require('path');
const G = require('../web/gvb.js');
const { assemble } = require('../web/asm6502.js');
const { makeSmallBin } = require('../web/wqxos.js');

const out = path.join(__dirname, '..', 'demo');
fs.mkdirSync(out, { recursive: true });
const bin = (name, src) => {
  const seg = assemble(src).segments[0];                       // code starts at $2010, right after the 16-byte BIN header
  fs.writeFileSync(path.join(out, name), makeSmallBin(seg.bytes, seg.addr));
  console.log(name + ': ' + (16 + seg.bytes.length) + ' bytes');
};

// 1. text on the screen: copy two strings into screen RAM ($02C0 = row 1, $02E8 = row 3), update the LCD, wait for a key
bin('HELLO.BIN', `
      .org $2010
      INT $8A2E            ; clear the screen
      LDX #11
c1:   LDA m1-1,X
      STA $02BF,X          ; row 1
      DEX
      BNE c1
      LDX #15
c2:   LDA m2-1,X
      STA $02E7,X          ; row 3
      DEX
      BNE c2
      INT $8A15            ; update the LCD
      INT $C008            ; wait for a key
      RTS
m1:   .str "HELLO WORLD"
m2:   .str "PRESS ANY KEY.."`);

// 2. the graphics system calls: parameters go to RAM $043F.., then INT $C30x draws
const set = (addr, v) => `      LDA #${v}\n      STA $${addr.toString(16).padStart(4, '0')}\n`;
bin('DRAW.BIN', `
      .org $2010
      INT $8A2E
${set(0x445, 1)}
${set(0x43F, 4) + set(0x440, 4) + set(0x441, 155) + set(0x442, 75)}      INT $C30C            ; frame
${set(0x43F, 4) + set(0x440, 4) + set(0x441, 155) + set(0x442, 75)}      INT $C30B            ; diagonal
${set(0x43F, 155) + set(0x440, 4) + set(0x441, 4) + set(0x442, 75)}      INT $C30B            ; the other diagonal
${set(0x43F, 80) + set(0x440, 40) + set(0x452, 25)}      INT $C30E            ; circle
${set(0x43F, 80) + set(0x440, 40) + set(0x457, 50) + set(0x458, 12)}      INT $C30F            ; ellipse
${set(0x43F, 70) + set(0x440, 32) + set(0x441, 90) + set(0x442, 48)}      INT $C30A            ; filled box
      INT $C008
      RTS`);

// 3. the classic way from BASIC: POKE the machine code into RAM from DATA, put an argument in RAM, CALL, read the result back
const code = assemble('.org $2000\n LDA $3000\n ASL A\n STA $3001\n RTS').segments[0].bytes;
const basic = [
  [10, 'FOR I=0 TO ' + (code.length - 1) + ':READ A:POKE 8192+I,A:NEXT I'],
  [20, 'POKE 12288,21'],
  [30, 'CALL 8192'],
  [40, 'PRINT "21 * 2 =";PEEK(12289)'],
  [50, 'PRINT "any key..";:A$=INKEY$'],
  [60, 'END'],
  [100, 'DATA ' + Array.from(code).join(',')],
];
const lines = basic.map(([no, text]) => ({ no, body: G.tokenizeBody(text) }));
fs.writeFileSync(path.join(out, 'CALLDEMO.BAS'), G.buildBas(lines, 0x7000));
console.log('CALLDEMO.BAS: ' + lines.length + ' lines');
