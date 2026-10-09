// Typing into the firmware's own BASIC editor (the "BASIC" icon on the second page of the calc/convert menu).
// The device has no digit keys: key 0x1A cycles the input mode letters -> digits -> pinyin -> letters; key 0x12 toggles upper/lower case in
// letter mode; in digit mode the keys b n m / g h j / t y u are 1-9 and 0x30 is 0; key 0x30 in letter mode opens a symbol palette whose nine
// slots are chosen with the same b n m g h j t y u keys (0x16 turns the page). Everything here was found by pressing keys and watching the screen.
'use strict';
const PALETTE = [
  ['.', ',', ';', '-', '/', '?', '!', '$', '%'],
  ['(', ')', ':', '`', "'", '"', '<', '>', '{'],
  ['}', '[', ']', '#', '~', '@', '^', '&', '*'],
  ['+', '=', '_', '|', '\\'],
];
const SLOT = 'bnmghjtyu';
const KEY = { Enter: 0x0D, Esc: 0x1B, Up: 0x14, Down: 0x15, Right: 0x16, Left: 0x17, Help: 0x19, Mode: 0x1A, Case: 0x12 };

function typer(s) {
  const st = { mode: 'letter', upper: false };
  const tap = (c, hold = 8, gap = 8) => { s.tap(c, hold, gap); if (c === KEY.Enter) st.mode = 'letter'; };   // a new line starts in letter mode
  function toLetters() { while (st.mode !== 'letter') { tap(KEY.Mode); s.run(30); st.mode = st.mode === 'digit' ? 'pinyin' : 'letter'; } }
  function toDigits() { while (st.mode !== 'digit') { tap(KEY.Mode); s.run(30); st.mode = st.mode === 'letter' ? 'digit' : 'pinyin'; } }
  function setCase(up) { if (st.upper !== up) { toLetters(); tap(KEY.Case); st.upper = up; } }
  function symbol(ch) {
    for (let p = 0; p < PALETTE.length; p++) {
      const i = PALETTE[p].indexOf(ch);
      if (i < 0) continue;
      toLetters(); tap(0x30); s.run(20);
      for (let k = 0; k < p; k++) { tap(KEY.Right); s.run(15); }
      tap(SLOT.charCodeAt(i)); s.run(30);
      return true;
    }
    return false;
  }
  function type(text) {
    for (const ch of text) {
      if (/[A-Z]/.test(ch)) { setCase(true); toLetters(); tap(ch.toLowerCase().charCodeAt(0)); }
      else if (/[a-z]/.test(ch)) { setCase(false); toLetters(); tap(ch.charCodeAt(0)); }
      else if (/[1-9]/.test(ch)) { toDigits(); tap(SLOT.charCodeAt(Number(ch) - 1)); }
      else if (ch === '0') { toDigits(); tap(0x30); }
      else if (ch === ' ') { toLetters(); tap(0x20); }
      else if (ch === '\n') { tap(KEY.Enter); s.run(40); }
      else if (!symbol(ch)) throw new Error('cannot type ' + JSON.stringify(ch));
    }
  }
  // text currently in the 20x5 text RAM, one string per row
  function screen() { const rows = []; for (let r = 0; r < 5; r++) rows.push(Buffer.from(s.m.ram.subarray(0x2C0 + r * 20, 0x2C0 + r * 20 + 20)).toString('latin1').replace(/[^ -~]/g, '.')); return rows; }
  return { type, tap, screen, state: st, KEY };
}

// from the main menu to a fresh BASIC file in the editor: calc/convert key twice, down twice to the second page, right twice to BASIC, Enter, answer Y
function openEditor(s) {
  for (const k of [0x02, 0x02, 0x15, 0x15, 0x16, 0x16, 0x0D, 0x79]) { s.tap(k, 10, 10); s.run(250); }
}
module.exports = { typer, openEditor, KEY };
