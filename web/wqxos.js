/* The device's system routines, implemented in JS ("high-level emulation", like DOSBox does for INT 21h).
 * Machine code reaches them in two ways (see docs/文曲星-系統調用.md):
 *    INT $pppp     the 3-byte instruction 00 pp pp (page, entry)  -> cpu.onBrk
 *    JSR $E0xx     a fixed ROM address                             -> cpu.traps
 * Anything not implemented stops the program with a message that names the call, so the next one to implement
 * is always obvious. Entries marked "approximate" follow the book's description but were not checked against a
 * real device. */
(function (root) {
'use strict';

const hex4 = n => n.toString(16).toUpperCase().padStart(4, '0');
const sleep = ms => new Promise(r => setTimeout(r, ms));

class WqxOS {
  constructor(dev, opts) {
    this.dev = dev; this.opts = opts || {};
    this.delayMs = this.opts.delayMs === undefined ? 1 : this.opts.delayMs;     // length of one DELAY unit (approximate)
    this.flash = this.opts.flash || null;                                        // optional {read(page, addr)} for JSR $E917
    this.calls = {};                                                             // how often each system routine ran (diagnostics)
    this.INT = {
      0x8A2E: this.clearLCD, 0x8A15: this.updateLCD, 0xC008: this.readKey, 0xC007: this.readKey, 0x021A: this.checkPower,
      0xC30B: c => this.draw(c, 'line'), 0xC30C: c => this.draw(c, 'box'), 0xC30A: c => this.draw(c, 'fillbox'),
      0xC30E: c => this.draw(c, 'circle'), 0xC310: c => this.draw(c, 'fillcircle'),
      0xC30F: c => this.draw(c, 'ellipse'), 0xC311: c => this.draw(c, 'fillellipse'),
      0xC312: this.messageBox,
      0x010A: this.drawingBoard,
    };
    this.JSR = { 0xE02A: c => this.delay(c.x), 0xE02D: c => this.delay(c.y), 0xE917: this.readFlash,
      0xE10B: this.paintTextRow, 0xE12D: this.refreshText, 0xE135: this.showSmallText, 0xE13B: this.clearSmallText, 0xE153: this.toDecimal, 0xE19E: this.drawBitmap,
      0xE1A1: function () { this.rect(true); }, 0xE1A7: function () { this.rect(false); },
      // the text-row painter at $BB00: for each cell of row ($84) from ($E0) to ($E1): X = cell index, $D1BA prepares the cell, then the ASCII path ($CE7E, $CED6)
      // or the double-byte path ($D716, $CA5F, $CEEE) fetches the glyph and draws it (docs/大型機器碼映像.md)
      0xD1BA: this.textCell, 0xCE7E: this.textAscii, 0xCED6: this.textDraw, 0xD716: this.textWide, 0xCA5F: function () { /* reads the glyph data */ }, 0xCEEE: this.textDraw };
  }

  install(cpu) {
    cpu.onBrk = (c, at) => this.int(c, at);
    for (const a of Object.keys(this.JSR)) cpu.addTrap(+a, c => {
      if (this.log) this.log.push('$' + hex4(+a) + this.argsOf(+a));                // debugging aid: this.log = [] records every BIOS call
      return this.JSR[a].call(this, c);
    });
    // the fixed BIOS page: a routine we do not know yet is reported instead of running zeros
    cpu.guard = pc => {
      if (pc >= 0xC000) {
        const ret = (cpu.rd(0x100 | ((cpu.sp + 2) & 0xFF)) << 8 | cpu.rd(0x100 | ((cpu.sp + 1) & 0xFF))) + 1;
        throw new Error('Unimplemented BIOS routine $' + hex4(pc) + ' (called from about $' + hex4(ret & 0xFFFF) + ')');
      }
    };
  }

  argsOf(addr) {
    const m = a => this.dev.peek(a);
    if (addr === 0xE1A1 || addr === 0xE1A7) return ' (' + m(0x3A6) + ',' + m(0x3A7) + ')-(' + m(0x3A8) + ',' + m(0x3A9) + ') mode ' + m(0x3AC);
    if (addr === 0xE19E) return ' (' + m(0x3A6) + ',' + m(0x3A7) + ')-(' + m(0x3A8) + ',' + m(0x3A9) + ') data $' + hex4(m(0x92) | (m(0x93) << 8));
    return '';
  }

  int(cpu, at) {
    const page = cpu.rd(at + 1), idx = cpu.rd(at + 2), key = (page << 8) | idx;
    cpu.pc = (at + 3) & 0xFFFF;                       // INT is 3 bytes long
    const h = this.INT[key];
    if (!h) throw new Error('Unimplemented system call INT $' + hex4(key) + ' (at $' + hex4(at) + ')');
    this.calls['INT $' + hex4(key)] = (this.calls['INT $' + hex4(key)] || 0) + 1;
    return h.call(this, cpu);
  }

  /* --- screen --- */
  clearLCD() { this.dev.cls(); }
  updateLCD() { this.dev.touch(); }                  // the screen is drawn from RAM at any time; small/big font ((0402)) is not modelled yet

  /* --- routines found in an RPG engine image (docs/大型機器碼映像.md): inferred from how they are called, not from documentation --- */
  /* $E135: the engine filled 6 rows x 26 columns at $02C0 (row pitch 26) and shows them: the LCD is cleared and the text is painted into it
   * (the F4 menu relies on this: it shows text, then inverts boxes over it). The painting needs a font, which only the browser has (dev.paintText);
   * the text RAM can be reused afterwards ($E13B clears it) without the screen changing. */
  showSmallText() {
    const d = this.dev; d.gfx.fill(0); d.small = true;
    d.printed = false; d.inv.fill(0); d.stamped.fill(0);        // the LCD was cleared: what BASIC had printed is gone from it, so the normal text layer must not show again
    if (d.paintText) d.paintText();
    d.touch();
  }
  /* $E12D (inferred, not documented anywhere): programs (a sample program) POKE characters into the text RAM at $02C0.. and then CALL 57645, so it is the "show the text RAM" call.
   * This machine shows text RAM at once, so there is nothing left to do. */
  refreshText() { this.dev.touch(); }
  /* $E10B (inferred, not documented): paint row ($84) of the normal text RAM (20 columns x 16-pixel rows) into the LCD bitmap. The item list of an RPG engine image writes 2-byte entries from
   * $02D4 (= row 1 of that layout, ten entries to a row), calls this with $84 = 1 and again with $84 = 2, and the selection box it draws next covers exactly the 16 x 16 pixels of the first
   * entry (y 16-31). The engine's own text is not shown by the page unless it is in the bitmap, so without this the list would stay empty. */
  paintTextRow() { this.dev.paintTextRow(this.dev.mem[0x84]); }
  clearSmallText() { this.dev.mem.fill(0, 0x2C0, 0x2C0 + 26 * 6); this.dev.touch(); }   // $E13B (inferred: called before a new text screen is composed, and by the engine at the start/end of its text routines)
  toDecimal() {                                                  // $E153: 16-bit number in $80/$81 -> 5 ASCII digits at $82-$86, leading zeros kept
    const m = this.dev.mem, n = m[0x80] | (m[0x81] << 8), s = String(n).padStart(5, '0');
    for (let i = 0; i < 5; i++) m[0x82 + i] = s.charCodeAt(i);
  }

  /* $E19E: paste a 1-bit picture. Rectangle (x1,y1)-(x2,y2) inclusive in $03A6-$03A9, picture data at the address in $92/$93
   * (row after row, each row padded to whole bytes, leftmost pixel in the top bit). The picture is read through the
   * bus, i.e. from whatever bank is selected right now. A set bit draws a pixel, a clear bit clears it. */
  drawBitmap() {
    const m = a => this.dev.peek(a), d = this.dev;
    const x1 = m(0x3A6), y1 = m(0x3A7), x2 = m(0x3A8), y2 = m(0x3A9), p = m(0x92) | (m(0x93) << 8);
    const w = x2 - x1 + 1, h = y2 - y1 + 1, bpr = (w + 7) >> 3;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d.pt(x1 + x, y1 + y, (m(p + y * bpr + (x >> 3)) >> (7 - (x & 7))) & 1 ? 1 : 0);
    d.touch();
  }

  /* $E1A1 = filled box, $E1A7 = frame (read from the order of the calls that build the F4 menu: a bar filled with mode 2, frames around it, the
   * selected item inverted again). Rectangle (x1,y1)-(x2,y2) inclusive in $03A6-$03A9, drawing mode in $03AC as in GVBASIC's BOX
   * (0 clear, 1 draw, 2 invert; only the low two bits count). The engine feeds them from 5-byte records (x1 y1 x2 y2 mode). */
  rect(fill) {
    const m = a => this.dev.peek(a), d = this.dev;
    let x1 = m(0x3A6), y1 = m(0x3A7), x2 = m(0x3A8), y2 = m(0x3A9); const mode = m(0x3AC) & 3;
    if (x1 > x2) [x1, x2] = [x2, x1]; if (y1 > y2) [y1, y2] = [y2, y1];
    for (let y = y1; y <= y2; y++) {
      if (fill || y === y1 || y === y2) for (let x = x1; x <= x2; x++) d.pt(x, y, mode);
      else { d.pt(x1, y, mode); if (x2 > x1) d.pt(x2, y, mode); }          // each pixel exactly once, so invert mode works
    }
    d.touch();
  }

  /* The ROM's text routines (inferred from the engine code at $BB00-$BB60, not documented): the font is the browser's (dev.paintCell), the position is the cell
   * the engine just announced with $D1BA (X = row*26 + column, the row pitch of its text RAM at $02C0). They keep the registers, as the engine expects. */
  textCell(c) { this.cell = { row: Math.floor(c.x / 26), col: c.x % 26 }; }
  textAscii(c) { this.glyph = c.a; }
  textWide() { this.glyph = (this.dev.mem[0x92] << 8) | this.dev.mem[0x93]; }
  textDraw() { if (this.cell && this.glyph !== undefined && this.dev.paintCell) { this.dev.paintCell(this.cell.row, this.cell.col, this.glyph); this.dev.touch(); } }

  /* INT $010A (not in the book): the built-in drawing board an RPG engine image uses to let the player draw a 32x32 portrait; afterwards the program reads the picture back
   * from LCD RAM at $09CA (rows of 4 bytes = x 80-111, y 0-31). The real tool's look and keys are unknown; this one edits the picture at twice its size on the left, shows it
   * at its real place on the right, and leaves it there when it is done. Keys: arrows move, space flips the pixel, D = pen (moving draws), E = eraser (moving erases),
   * C clears, I inverts, Enter or Esc finishes. dev.hint is the help line the page shows. */
  async drawingBoard() {
    const d = this.dev, N = 32, PX = 80, PY = 0;
    const pix = new Uint8Array(N * N);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) pix[y * N + x] = d.gfx[(PY + y) * 160 + PX + x] ? 1 : 0;
    d.text.fill(0); d.takeKey();
    let cx = 16, cy = 16, pen = 0, blink = true;
    const set = (x, y, v) => { if (x >= 0 && x < 160 && y >= 0 && y < 80) d.gfx[y * 160 + x] = v; };
    const hint = () => { d.hint = '畫頭像：方向鍵移動　空白鍵＝畫點／擦點　D＝筆　E＝橡皮　C＝清除　I＝反相　Enter＝完成' + ['', '　[筆：移動就畫]', '　[橡皮：移動就擦]'][pen]; };
    /* Layout (LCD pixels). The program reads the picture back at x 80-111, y 0-31, so that is where the real-size copy sits and nothing else may be drawn there. Left: the 2x editing
     * view, 64 x 64 at (EX, EY) inside a one-pixel gap and a frame, centred between the top of the picture and the last text row. Right: the real-size copy with a solid frame on its three
     * free sides (its top edge is the edge of the screen), and under it three lines of help in the machine's 12-pixel font (when the page has it), starting at the picture's left edge. */
    const EX = 8, EY = 7;
    const hline = (x0, x1, y) => { for (let x = x0; x <= x1; x++) set(x, y, 1); }, vline = (x, y0, y1) => { for (let y = y0; y <= y1; y++) set(x, y, 1); };
    const LEGEND = [[0xB7BD, 0xCFF2, 0xBCFC, 0xA3BA, 0xD2C6, 0xB6AF], [0xBFD5, 0xB0D7, 0xA3BA, 0xBBAD, 0xA3AF, 0xB2C1], [0x45, 0x6E, 0x74, 0x65, 0x72, 0xA3BA, 0xCDEA, 0xB3C9]];   // GBK: "方向键：移动" "空白：画／擦" "Enter：完成"
    const legend = () => { if (!d.paintCell) return; LEGEND.forEach((codes, i) => { let c = 13; for (const code of codes) { d.paintCell(3 + i, c, code); c += code > 255 ? 2 : 1; } }); };
    const paint = () => {
      d.gfx.fill(0);
      hline(EX - 2, EX + 65, EY - 2); hline(EX - 2, EX + 65, EY + 65); vline(EX - 2, EY - 2, EY + 65); vline(EX + 65, EY - 2, EY + 65);                 // frame around the editing view
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        if (pix[y * N + x]) { set(EX + 2 * x, EY + 2 * y, 1); set(EX + 1 + 2 * x, EY + 2 * y, 1); set(EX + 2 * x, EY + 1 + 2 * y, 1); set(EX + 1 + 2 * x, EY + 1 + 2 * y, 1); }
        if (pix[y * N + x]) set(PX + x, PY + y, 1);                                                                 // the picture at its real size, where the program reads it
      }
      vline(PX - 1, PY, PY + N); vline(PX + N, PY, PY + N); hline(PX - 1, PX + N, PY + N);                          // frame of the real-size picture: left, right and bottom
      if (blink) { const x0 = EX + 2 * cx - 1, y0 = EY + 2 * cy - 1; for (let i = 0; i < 4; i++) { const f = (x, y) => set(x, y, d.gfx[y * 160 + x] ^ 1); f(x0 + i, y0); f(x0 + i, y0 + 3); f(x0, y0 + i); f(x0 + 3, y0 + i); } }   // cursor: a blinking box round the pixel
      legend();
      d.touch();
    };
    const timer = setInterval(() => { blink = !blink; paint(); }, 350);
    try {
      hint(); paint();
      for (;;) {
        await d.waitKey(); const k = d.takeKey();
        let dx = 0, dy = 0;
        if (k === 23) dx = -1; else if (k === 22) dx = 1; else if (k === 20) dy = -1; else if (k === 21) dy = 1;
        else if (k === 13 || k === 27) break;
        else if (k === 32) pix[cy * N + cx] ^= 1;
        else if (k === 100) { pen = pen === 1 ? 0 : 1; if (pen) pix[cy * N + cx] = 1; }
        else if (k === 101) { pen = pen === 2 ? 0 : 2; if (pen) pix[cy * N + cx] = 0; }
        else if (k === 99) pix.fill(0);
        else if (k === 105) for (let i = 0; i < pix.length; i++) pix[i] ^= 1;
        if (dx || dy) { cx = Math.max(0, Math.min(N - 1, cx + dx)); cy = Math.max(0, Math.min(N - 1, cy + dy)); if (pen) pix[cy * N + cx] = pen === 1 ? 1 : 0; }
        hint(); blink = true; paint();
      }
    } finally { clearInterval(timer); d.hint = null; }
    d.gfx.fill(0);                                                       // what stays is the picture at its real place; the program draws the rest again
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (pix[y * N + x]) set(PX + x, PY + y, 1);
    d.touch();
  }

  /* --- keyboard / time / power --- */
  async readKey(cpu) {                               // waits for a key; its scan code comes back in A
    await this.dev.waitKey();
    const k = this.dev.takeKey() & 0xFF;
    cpu.a = k; cpu.nz(k);
  }
  checkPower(cpu) { cpu.a = 0; cpu.nz(0); }          // 0 = battery is fine
  async delay(n) { await sleep((n || 256) * this.delayMs); }   // X (or Y) = length; 0 means 256   (unit approximate)
  readFlash(cpu) {                                   // page in (05B4), address in (C8)(C9) + Y; byte comes back in A
    const m = a => this.dev.peek(a);
    const page = m(0x05B4), addr = (m(0xC8) | (m(0xC9) << 8)) + cpu.y;
    const v = this.flash ? this.flash.read(page, addr & 0xFFFF) & 0xFF : 0xFF;
    cpu.a = v; cpu.nz(v);
  }

  /* --- graphics: parameters live in RAM ($043F.. as listed in the book); (0445) = 1 draw, 0 erase --- */
  draw(cpu, what) {
    const m = a => this.dev.peek(a), d = this.dev;
    const x1 = m(0x43F), y1 = m(0x440), x2 = m(0x441), y2 = m(0x442), mode = m(0x445) ? 1 : 0;
    switch (what) {
      case 'line': d.line(x1, y1, x2, y2, mode); break;
      case 'box': d.box(x1, y1, x2, y2, false, mode); break;
      case 'fillbox': d.box(x1, y1, x2, y2, true, mode); break;
      case 'circle': d.ellipse(x1, y1, m(0x452), m(0x452), false, mode); break;
      case 'fillcircle': d.ellipse(x1, y1, m(0x452), m(0x452), true, mode); break;
      case 'ellipse': d.ellipse(x1, y1, m(0x457), m(0x458), false, mode); break;   // width/height treated as radii (approximate)
      default: break;
    }
    d.touch();
  }

  /* --- pop-up message box (approximate): table at X (low) / Y (high), A = 0.
   *   +0 $80  +1,+2 text address  +3 x  +4 y  +5 text length in bytes  +6 02 = one line, 04 = two ...  +7,+8 / +9 end marker */
  messageBox(cpu) {
    const m = a => this.dev.peek(a), d = this.dev;
    const t = cpu.x | (cpu.y << 8);
    const addr = m(t + 1) | (m(t + 2) << 8), px = m(t + 3), py = m(t + 4), len = m(t + 5), lines = Math.max(1, m(t + 6) >> 1);
    const col = Math.min(19, Math.floor(px / 8)), row = Math.min(4, Math.floor(py / 16));
    const x0 = Math.max(0, col * 8 - 3), y0 = Math.max(0, row * 16 - 3), x1 = Math.min(159, col * 8 + len * 8 + 2), y1 = Math.min(79, row * 16 + lines * 16 + 2);
    d.box(x0, y0, x1, y1, true, 0); d.box(x0, y0, x1, y1, false, 1);                 // clear and frame the area
    for (let i = 0; i < len; i++) { const c = col + i; if (c < 20) d.text[row * 20 + c] = m(addr + i); }
    d.touch();
  }
}

/* --- BIN programs smaller than 8 KB (format from the book): loaded at $2000, header AA A5 5A ... --- */
function parseSmallBin(bytes) {
  if (bytes.length < 0x10 || bytes[0] !== 0xAA || bytes[1] !== 0xA5 || bytes[2] !== 0x5A) return null;
  return { entry: bytes[8] | (bytes[9] << 8), length: bytes[3] | (bytes[4] << 8) | (bytes[5] << 16), loadAt: 0x2000 };
}
function makeSmallBin(code, entry) {                 // code is placed at $2010; entry defaults to its first byte
  const total = 0x10 + code.length, e = entry === undefined ? 0x2010 : entry;
  return Uint8Array.from([0xAA, 0xA5, 0x5A, total & 0xFF, (total >> 8) & 0xFF, (total >> 16) & 0xFF, 0x20, 0x4C, e & 0xFF, e >> 8,
    0x70, 0x03, 0x31, 0x03, 0xFF, 0xFF, ...code]);
}

const api = { WqxOS, parseSmallBin, makeSmallBin };
if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.WQXOS = WqxOS, root.WQXBIN = { parseSmallBin, makeSmallBin };
})(typeof globalThis !== 'undefined' ? globalThis : this);
