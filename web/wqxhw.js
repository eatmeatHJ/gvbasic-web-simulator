/* Hardware layer for machine-code games that talk to the chip directly instead of calling the BIOS (e.g. a platformer .bin).
 * Only what such a game was seen to use is modelled (docs/硬體層機器碼程式.md): the zero page $00-$3F is the I/O area,
 *   $00  bank register: the 32 KB flash page shown in $4000-$BFFF (pages are relative to the value at start, like the engine images')
 *   $01  interrupt status, read clears it: bit 0 is the timer tick the game uses as its frame sync (it polls it, no interrupts are used)
 *   $09  keypad: which lines are selected (one bit each)       $08  keypad: columns read back, 1 = a key on a selected line is down
 * The LCD is the packed bitmap at $19C0 that the device already has. Which registers do what was read from the game's own code
 * (its keypad scan routine) and from its behaviour; the real chip may have more to it. */
(function (root) {
'use strict';

/* The image of a game: 32 KB pages in the window order of the device. A game starts with a header at the beginning of its first page's
 * $4000 block: u16, the name, ... JMP entry at +$18, the signature A5 AA 55 at +$1B. */
function detectGame(bytes) {
  if (bytes.length < 0x8000 || bytes.length % 0x8000) return null;
  if (bytes[0x4018] !== 0x4C || bytes[0x401B] !== 0xA5 || bytes[0x401C] !== 0xAA || bytes[0x401D] !== 0x55) return null;
  const entry = bytes[0x4019] | (bytes[0x401A] << 8);
  if (entry < 0x4000 || entry >= 0xC000) return null;
  let name = ''; for (let i = 0x4002; i < 0x4018 && bytes[i] >= 0x20 && bytes[i] < 0x7F; i++) name += String.fromCharCode(bytes[i]);
  return { name: name.trim() || 'GAME', entry };
}

/* Keypad matrix as the game scans it: UI key code -> [line selected through $09, bit read back from $08].
 * The game's own routine combines them like this (a platformer .bin): line $04: bit0, bit1, bit2; line $08: bit1; line $40: bit7, bit3;
 * line $80: bit5, bit2, bit3; line $20: bit0. Which physical key each is on the real keypad is not known; they are assigned by what the
 * game does with them (see GAME_KEYS). UI codes: 20 up, 21 down, 22 right, 23 left, 13 Enter, 27 Esc, 32 space, letters = lowercase char code. */
/* The platformer's keys: found by holding each bit during play. Certain: left (line 04 bit 0), right (04 bit 2), jump (40 bit 7), run / fire (40 bit 3),
 * start (80 bit 5). Guessed from the bit order: down (04 bit 1), up (08 bit 1). The bits that had no visible effect at the start of level 1 (they
 * may need a mushroom or a pipe) and the ones the scan routine treats specially (80 bit 2, 20 bit 0) are left out; 80 bit 3 toggles a flag
 * (pause?) and sits on the P key. */
const GAME_KEYS = {
  'SUPER-MARIO V1.2': {
    23: [[0x04, 0]],           // left arrow  -> left
    22: [[0x04, 2]],           // right arrow -> right
    21: [[0x04, 1]],           // down arrow  -> down (guess)
    20: [[0x08, 1]],           // up arrow    -> up (guess)
    122: [[0x40, 7]],          // Z           -> jump
    32: [[0x40, 7]],           // space       -> jump
    120: [[0x40, 3]],          // X           -> run / fire
    13: [[0x80, 5]],           // Enter       -> start
    112: [[0x80, 3]],          // P           -> toggles a flag (pause?)
  },
};
const KEYS_HELP = '可用的鍵：← → ↑ ↓、Z、空白鍵、X、Enter、P（用途依程式而定）';

class HwIO {
  constructor(dev, keymap) {
    this.dev = dev; this.keymap = keymap || {};
    this.down = new Set();        // UI key codes currently held
    this.raw = new Set();         // debugging: [line, bit] pairs held directly, e.g. '4:0'
    this.pending = 0;             // interrupt status bits waiting to be read
    this.idle = false;            // set when the program is only waiting for a tick: the CPU loop may sleep
    this.log = null;              // debugging: an array to collect register accesses
  }
  tick() { this.pending |= 1; }
  press(code) { this.down.add(code); }
  release(code) { this.down.delete(code); }
  releaseAll() { this.down.clear(); }
  read(a) {
    switch (a) {
      case 0x01: { const v = this.pending; this.pending = 0; if (!(v & 1)) this.idle = true; return v; }
      case 0x08: return this.columns();
      default: return this.dev.mem[a];
    }
  }
  write(a, v) {
    this.dev.mem[a] = v;
    if (this.log) this.log.push('W$' + a.toString(16).padStart(2, '0') + '=' + v.toString(16));
  }
  /* the columns of every selected line that have a key down */
  columns() {
    const lines = this.dev.mem[0x09]; let r = 0;
    for (const code of this.down) { const k = this.keymap[code]; if (!k) continue; for (const [line, bit] of k) if (lines & line) r |= 1 << bit; }
    for (const p of this.raw) { const [line, bit] = p.split(':').map(Number); if (lines & line) r |= 1 << bit; }
    return r;
  }
}

/* Install it or run it? Every program image has this header (an RPG engine image, GVbasic+.bin, too), so the header only says "a program". A trial run tells more: the image is started on bare
 * hardware (this layer, no ROM); a self-contained game keeps running without ever touching the ROM, while a program written for the real BIOS reaches for it at once
 * (the engine image: a BRK = INT call after 20 instructions). Returns { kind: 'game' | 'install', info, reason }. */
function classifyImage(bytes, maxSteps) {
  const info = detectGame(bytes);
  if (!info) return { kind: 'install', info: null, reason: 'no BIN header' };
  const cjs = typeof module !== 'undefined' && module.exports;
  const GV = cjs ? require('./gvb.js') : root.GVB, FI = (cjs ? require('./flash.js') : root.FLASH).FlashImage, CPU = cjs ? require('./cpu6502.js').CPU6502 : root.CPU6502;
  const dev = new GV.Device(), flash = new FI(bytes, { name: info.name }), io = new HwIO(dev, {});
  dev.flash = flash; dev.gfxBase = 0x19C0; dev.hw = io; dev.mem[0] = flash.base;
  let why = null;
  const cpu = new CPU({ read: a => dev.peek(a), write: (a, v) => dev.poke(a, v) });
  cpu.onBrk = (c, at) => { why = 'BRK (INT system call) at $' + at.toString(16); return false; };
  cpu.reset(info.entry);
  const limit = maxSteps || 200000;
  for (let n = 0; n < limit && !why; n++) {
    if (cpu.pc >= 0xC000) { why = 'runs code in the ROM area at $' + cpu.pc.toString(16); break; }
    if (n % 5000 === 4999) io.tick();
    cpu.step();
  }
  return why ? { kind: 'install', info, reason: why } : { kind: 'game', info, reason: 'ran ' + limit + ' instructions on bare hardware' };
}

/* Runs a game image on the device: the CPU starts at the game's entry and never returns; stop() ends it. */
class RawGame {
  constructor(dev, flash, info, opts) {
    this.dev = dev; this.flash = flash; this.info = info; this.opts = opts || {};
    this.fps = this.opts.fps || 20;                    // frame sync rate (the real timer period is not known)
    this.io = new HwIO(dev, GAME_KEYS[info.name] || {});
    this.running = false; this.halt = false; this.kind = 'raw';
  }
  async run() {
    const dev = this.dev, MC = (typeof module !== 'undefined' && module.exports) ? require('./cpu6502.js') : { CPU6502: root.CPU6502 };
    dev.mem.fill(0); dev.pending = -1;
    dev.flash = this.flash; dev.gfxBase = 0x19C0; dev.charset = 'big5'; dev.small = false; dev.printed = false; dev.hw = this.io;
    dev.mem[0] = this.flash.base;                      // the page the game was started from; its other pages are base+1 ...
    dev.gfx.fill(0); dev.touch();
    const cpu = this.cpu = new MC.CPU6502({ read: a => dev.peek(a), write: (a, v) => dev.poke(a, v) });
    cpu.onBrk = (c, at) => { throw new Error('這個映像在 $' + at.toString(16).toUpperCase() + ' 呼叫了系統 ROM（BRK／INT），它不是能自己跑的遊戲：請改用「安裝」，再執行呼叫它的 .BAS'); };
    cpu.reset(this.info.entry);
    this.running = true;
    this.timer = this.opts.autoTick === false ? null : setInterval(() => this.io.tick(), 1000 / this.fps);
    try {
      await cpu.run(() => this.halt, () => { if (this.io.idle) { this.io.idle = false; return true; } return false; });
    } catch (e) {
      if (!e.stopped) { this.running = false; if (this.timer) clearInterval(this.timer); dev.hw = null; return { error: e }; }
    }
    this.running = false; if (this.timer) clearInterval(this.timer); dev.hw = null;
    return { stopped: true };
  }
  setFps(f) { this.fps = f; if (this.timer) { clearInterval(this.timer); this.timer = setInterval(() => this.io.tick(), 1000 / f); } }
  stop() { this.halt = true; }
}

const api = { detectGame, classifyImage, HwIO, RawGame, GAME_KEYS, KEYS_HELP };
if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.WQXHW = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
