/* The banked part of the machine's address space.
 * On the device a big machine-code program (an RPG engine image, GVbasic+.bin: 6 x 32 KB) is "installed" into flash pages; whatever
 * page the bank register (zero page $00) selects shows up in the window $4000-$BFFF. Programs address pages
 * relative to the register: the first page is PEEK(0), the next one PEEK(0)+1 ...
 * The window is assembled from four 8 KB blocks of the selected 32 KB page, in the PC1000 order (WQXEmu's notes):
 *   $4000 <- +$4000   $6000 <- +$6000   $8000 <- +$0000   $A000 <- +$2000
 * This module only holds and maps the image; the file itself is the user's, it is never part of this project. */
(function (root) {
'use strict';

const BLOCK = [0x4000, 0x6000, 0x0000, 0x2000];
const PAGE = 0x8000;

/* The engine reads the keypad as raw scan values kept in RAM (active low, $FF = nothing pressed), not as key codes:
 *   $C9: $FB up, $F7 down, $7F right, $DF Enter        $CD: $7F left        $C8: $DF the F4 key (menu)
 * (read from how its movement routine compares them; the game manual says arrows walk, Enter examines, F4 opens the menu).
 * Keys are given the UI's codes: 20 up, 21 down, 22 right, 23 left, 13 Enter, 1004 F4. */
const RAW_KEYS = { 20: [0xC9, 0xFB], 21: [0xC9, 0xF7], 22: [0xC9, 0x7F], 23: [0xCD, 0x7F], 13: [0xC9, 0xDF], 1004: [0xC8, 0xDF] };
const RAW_IDLE = [0xC8, 0xC9, 0xCD];

class FlashImage {
  constructor(bytes, opts) {
    opts = opts || {};
    if (!FlashImage.fits(bytes)) throw new Error('Not a flash image: the size must be a multiple of 32 KB');
    this.bytes = bytes; this.name = opts.name || 'flash';
    this.pages = bytes.length / PAGE;
    this.rawKeys = RAW_KEYS; this.rawIdle = RAW_IDLE;
    this.gfxBase = 0x09C0;                                            // where this machine keeps the LCD bitmap (inferred from the engine's accesses and how the RPG reads its avatar back)
    this.base = opts.base === undefined ? 0x08 : opts.base;          // bank register value that selects page 0 (arbitrary: programs work relative to it)
  }
  static fits(bytes) { return bytes.length >= PAGE && bytes.length % PAGE === 0; }

  /* Writes into the window reach the flash chip's command interface (AMD style, the one the engine's own RAM routines use to keep a save game in the image's free pages):
   *   AA @ x555, 55 @ xAAA, then 80 (erase setup) and again AA 55 and 30 at an address of the sector = erase that 4 KB sector to FF,
   *   or A0 and then one write = program a byte (a program can only turn 1 bits into 0), F0 = back to reading. Every operation is finished at once, so the routines' status polling
   *   (DQ7 / DQ3) sees the final data right away. Returns false when the bank is not part of the image (the write goes to RAM there). onWrite is told about every change. */
  write(bank, a, v) {
    const k = bank - this.base;
    if (k < 0 || k >= this.pages || a < 0x4000 || a >= 0xC000) return false;
    const o = k * PAGE + BLOCK[(a - 0x4000) >> 13] + (a & 0x1FFF), x = a & 0xFFF, st = this.cmdState || 0;
    if (v === 0xF0 && st !== 3) { this.cmdState = 0; return true; }       // F0 resets - but right after A0 every value, F0 too, is data
    switch (st) {
      case 0: this.cmdState = x === 0x555 && v === 0xAA ? 1 : 0; break;
      case 1: this.cmdState = x === 0xAAA && v === 0x55 ? 2 : 0; break;
      case 2: this.cmdState = x === 0x555 && v === 0xA0 ? 3 : x === 0x555 && v === 0x80 ? 4 : 0; break;
      case 3: this.bytes[o] &= v; this.cmdState = 0; if (this.onWrite) this.onWrite(); break;
      case 4: this.cmdState = x === 0x555 && v === 0xAA ? 5 : 0; break;
      case 5: this.cmdState = x === 0xAAA && v === 0x55 ? 6 : 0; break;
      default: if (v === 0x30) { const s0 = o & ~0xFFF; this.bytes.fill(0xFF, s0, s0 + 0x1000); if (this.onWrite) this.onWrite(); } this.cmdState = 0;
    }
    return true;
  }

  /* byte at window address a ($4000-$BFFF) for bank register value `bank`; -1 when that bank is not part of the image (plain RAM there) */
  read(bank, a) {
    const k = bank - this.base;
    if (k < 0 || k >= this.pages || a < 0x4000 || a >= 0xC000) return -1;
    return this.bytes[k * PAGE + BLOCK[(a - 0x4000) >> 13] + (a & 0x1FFF)];
  }

  /* RAM state the install leaves behind (what the RPG's main program checks first, by PEEK(0)=PEEK(1190) and PEEK(6597)=85): the bank
   * register shows the page the program lives in, $04A6 remembers it, and $19C5 holds the signature $55. */
  initRam(dev) {
    dev.mem[0] = this.base;
    dev.mem[0x04A6] = this.base;
    dev.mem[0x19C5] = 0x55;
    for (const a of RAW_IDLE) dev.mem[a] = 0xFF;
    for (let r = 0; r < 6; r++) { const o = r * 26; dev.mem[0xCE5E + 2 * r] = o & 255; dev.mem[0xCE5F + 2 * r] = o >> 8; }      // a table in the ROM ($CE5E): where each text row starts in the text RAM (row pitch 26), read by the engine's text painter
  }

}

const api = { FlashImage };
if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.FLASH = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
