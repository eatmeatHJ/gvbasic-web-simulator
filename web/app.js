(function () {
'use strict';
const { Machine, Device, DatStore, codeFromKey, toByteString, parseBas, compileProgram, listProgram } = GVB;
const FS = GVBFS;
const GVE = GVBEdit;
const { FlashImage } = FLASH;
const HWL = HWLAYER;
const TXT = TXT2BAS;
const $ = id => document.getElementById(id);

/* ---------------------------------------------------------------- state */
const dev = new Device();
let storage = null;
try { storage = window.localStorage; storage.getItem('gvb.probe'); } catch (e) { storage = null; }

let backend = null;            // current root (GVBFS backend)
let path = [];                 // current folder, relative to the root
let entries = [];              // what the menu shows: up / dir / bas / dat
let sel = 0, top = 0;          // menu cursor and first visible row
let mode = 'welcome';          // welcome | menu | running | hold | edit | save | confirm
let machine = null;
let editor = null;             // GVBEdit.LineEditor while editing
let saveState = null;          // { bytes, warnings, name: [chars] } while asking for the file name
let confirmState = null;       // { kind: 'delete' | 'overwrite', ... }
let numMode = false;           // on-screen keypad: letter keys type the digit printed on them
let session = null;            // DatSession of the current root
let flashes = [];              // installed machine-code images { id, name, scope, img: FlashImage, at }; none: the plain GVBASIC machine everywhere

const strToBytes = s => Uint8Array.from(s, c => c.charCodeAt(0));
function bytesToStr(u8) { let s = ''; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192)); return s; }
const sortName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
const big5 = new TextDecoder('big5'), gbk = new TextDecoder('gbk');

/* ---------------------------------------------------------------- device pictograms */
/* The device draws Big5 codes FA40 and up with pictures of its own (suits, map tiles, icons). The page draws them from the 527 pictures of web/lcdfont.js (pictogram16, two numberings,
 * see docs/圖形字編號.md); PICTO below (symbols for codes whose meaning was worked out from programs) is only the fallback when a picture is missing, and every code the pictures do not
 * cover is a framed tile with its four hex digits, so different pictures at least look different and can be told apart. 3 x 5 pixel digits, two on each of two lines, inside a 1-pixel frame. */
const HEX35 = ['111101101101111', '010110010010111', '111001111100111', '111001111001111', '101101111001001', '111100111001111', '111100111101111', '111001001010010',
  '111101111101111', '111101111001111', '010101111101101', '110101110101110', '011100100100011', '110101101101110', '111100110100111', '111100110100100'];
function hexTile(px, c, r, code) {
  const x0 = c * 8, y0 = r * 16, set = (x, y) => { if (x0 + x < 160) px[(y0 + y) * 160 + x0 + x] = 1; };
  clearCell(px, c, 16, r);
  for (let i = 0; i < 16; i++) { set(i, 0); set(i, 15); set(0, i); set(15, i); }
  const digits = [(code >> 12) & 15, (code >> 8) & 15, (code >> 4) & 15, code & 15];
  digits.forEach((d, k) => {
    const dx = 4 + (k & 1) * 4, dy = 3 + (k >> 1) * 6, bits = HEX35[d];
    for (let y = 0; y < 5; y++) for (let x = 0; x < 3; x++) if (bits[y * 3 + x] === '1') set(dx + x, dy + y);
  });
}
/* placeholder symbols for the pictograms whose meaning is known */
const PICTO = {
  0xfc67: '🏙️', 0xfc69: '🏬', 0xfc63: '🌐', 0xfaea: '🚆', 0xfbe3: '🏋️', 0xfca7: '⚔️', 0xfc65: '🏦',
  0xfa48: '♠︎', 0xfa47: '♥︎', 0xfaad: '♦︎', 0xfa49: '♣︎',     // card suits (read from how a card game draws them)
  0xfaa9: '▣', 0xfcb9: '🚶', 0xfa50: '↑', 0xfa52: '↓', 0xfa54: '←', 0xfa53: '→',
};

/* ---------------------------------------------------------------- LCD rendering */
const lcd = $('lcd'), ctx = lcd.getContext('2d');
const off = document.createElement('canvas'); off.width = 160; off.height = 80;
const octx = off.getContext('2d'); const img = octx.createImageData(160, 80);
const gc = document.createElement('canvas'); gc.width = 16; gc.height = 16;
const gctx = gc.getContext('2d', { willReadFrequently: true });
const glyphCache = new Map();
const ASCII16 = Uint8Array.from(atob(GVB_ASCII16), c => c.charCodeAt(0));   // real device 8x16 font
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const hex2rgb = h => { const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(h); return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [0, 0, 0]; };

function asciiGlyph(b) {
  let g = glyphCache.get('a' + b);
  if (g) return g;
  g = new Uint8Array(8 * 16);
  const o = (b < 160 ? b : 63) * 16;
  for (let y = 0; y < 16; y++) for (let x = 0; x < 8; x++) g[y * 8 + x] = (ASCII16[o + y] >> (7 - x)) & 1;
  glyphCache.set('a' + b, g);
  return g;
}
function glyph(ch) { // double-byte characters: rasterised from a system bitmap font (16 px)
  let g = glyphCache.get(ch);
  if (g) return g;
  gctx.clearRect(0, 0, 16, 16);
  gctx.fillStyle = '#000'; gctx.textBaseline = 'top';
  gctx.font = '15px "MingLiU","PMingLiU","Microsoft JhengHei","Noto Sans TC","PingFang TC",sans-serif';
  gctx.fillText(ch, 0, 1);
  const d = gctx.getImageData(0, 0, 16, 16).data;
  g = new Uint8Array(16 * 16);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) g[y * 16 + x] = d[(y * 16 + x) * 4 + 3] > 100 ? 1 : 0;
  glyphCache.set(ch, g);
  return g;
}
/* A printed character fills its whole cell, like on the device where text and graphics share one screen buffer: whatever graphics were under
 * the cell are gone (this is what keeps text readable on an inverted bar). The graphics layer and the text layer are still kept apart here, so
 * graphics drawn *after* the text do not erase it. */
function clearCell(px, c, w, r) { const x0 = c * 8, y0 = r * 16; for (let y = 0; y < 16; y++) for (let x = 0; x < w; x++) if (x0 + x < 160) px[(y0 + y) * 160 + x0 + x] = 0; }
function blit(px, bits, w, c, r) {
  const x0 = c * 8, y0 = r * 16;
  clearCell(px, c, w, r);
  for (let y = 0; y < 16; y++) for (let x = 0; x < w; x++) if (bits[y * w + x]) px[(y0 + y) * 160 + x0 + x] = 1;
}
/* small-font text screen (machine code's own 26 x 6 layout): 6 x 13 pixel cells, double-byte characters take two; rasterised from a bitmap system font (SimSun is 12 px) */
const sc = document.createElement('canvas'); sc.width = 12; sc.height = 14;
const sctx = sc.getContext('2d', { willReadFrequently: true });
function smallGlyph(ch, w) {
  const key = 's' + w + ch; let g = glyphCache.get(key);
  if (g) return g;
  sctx.clearRect(0, 0, 12, 14); sctx.fillStyle = '#000'; sctx.textBaseline = 'top';
  sctx.font = '12px "SimSun","NSimSun","MingLiU","Noto Sans Mono CJK SC","Courier New",monospace';
  sctx.fillText(ch, 0, 0);
  const d = sctx.getImageData(0, 0, 12, 14).data;
  g = new Uint8Array(w * 13);
  for (let y = 0; y < 13; y++) for (let x = 0; x < w; x++) g[y * w + x] = d[(y * 12 + x) * 4 + 3] > 110 ? 1 : 0;
  glyphCache.set(key, g); return g;
}
/* One cell of the engine's small text: 6 pixels wide (12 for a double-byte character, which covers two cells), 13 rows high, rows start at y = 13 * row (the engine's own boxes for
 * its text windows are laid out like this). code = a byte, or lead byte * 256 + second byte. clear = wipe the cell first (a single cell painted by the ROM text routine). */
/* a 12 x 13 box with the four hex digits of a code (two rows of two, 3 x 5 pixel digits) for a pictogram of the small-text screen that we have no picture for */
function smallHexTile(px, x0, y0, code) {
  const set = (x, y) => { if (x0 + x < 160 && y0 + y < 80) px[(y0 + y) * 160 + x0 + x] = 1; };
  for (let i = 0; i < 12; i++) { set(i, 0); set(i, 12); }
  for (let i = 0; i < 13; i++) { set(0, i); set(11, i); }
  [(code >> 12) & 15, (code >> 8) & 15, (code >> 4) & 15, code & 15].forEach((d, k) => {
    const dx = 2 + (k & 1) * 4, dy = 1 + (k >> 1) * 6, bits = HEX35[d];
    for (let y = 0; y < 5; y++) for (let x = 0; x < 3; x++) if (bits[y * 3 + x] === '1') set(dx + x, dy + y);
  });
}
function smallCell(r, c, code, clear) {
  const px = dev.gfx, dec = dev.charset === 'gbk' ? gbk : big5, wide = code > 255, w = wide ? 12 : 6, x0 = 2 + c * 6, y0 = 1 + r * 13;
  if (clear) for (let y = 0; y < 13; y++) for (let x = 0; x < w; x++) if (x0 + x < 160 && y0 + y < 80) px[(y0 + y) * 160 + x0 + x] = 0;
  let g = null;
  if (window.LCDFONT) {                                      // the machine's own 12 x 12 / 6 x 12 fonts (the 12 x 12 one is GB2312, so only for GBK); row 13 stays empty
    const real = wide ? (dev.charset === 'gbk' ? LCDFONT.glyph12(code >> 8, code & 255) : null) : (code >= 0x20 && code < 0x80 ? LCDFONT.ascii12(code) : null);
    if (real) { g = new Uint8Array(w * 13); g.set(LCDFONT.bits(real, w, 12)); }
  }
  if (!g && wide && dev.charset === 'gbk' && (code >> 8) >= 0xFA) { smallHexTile(px, x0, y0, code); return; }      // a pictogram without a picture: its code in a small box
  if (!g) {
    let ch;
    if (wide) { ch = dev.charset === 'gbk' ? GVB.gbkChar(code >> 8, code & 255) : dec.decode(Uint8Array.of(code >> 8, code & 255)); if (ch === '�') ch = '□'; }
    else if (code >= 0x20 && code < 0x80) ch = String.fromCharCode(code); else return;
    g = smallGlyph(ch, w);
  }
  for (let y = 0; y < 13; y++) for (let x = 0; x < w; x++) if (g[y * w + x] && x0 + x < 160 && y0 + y < 80) px[(y0 + y) * 160 + x0 + x] = 1;
}
function paintSmallText() {                // $E135: paint the engine's text RAM into the LCD bitmap (the LCD was just cleared)
  const m = dev.mem;
  for (let r = 0; r < 6; r++) for (let c = 0; c < 26; c++) {
    const b = m[0x2C0 + r * 26 + c]; if (!b) continue;
    if (b > dev.lead && c < 25) { smallCell(r, c, (b << 8) | m[0x2C0 + r * 26 + c + 1], false); c++; }
    else if (b < 0x80) smallCell(r, c, b, false);
  }
}
dev.paintCell = (r, c, code) => smallCell(r, c, code, true);

let blink = true, lastVer = -1, lastBlink = null, lastTheme = '';
function draw() { requestAnimationFrame(draw); render(); }
/* Paint the character in text cell (r, c) of the text RAM into px (a 160 x 80 bitmap). Returns the number of cells it covers (2 for a double-byte character), 0 for an empty cell,
 * and -1 when the character can only be shown by the emoji overlay (a picture symbol: it cannot become pixels). emoji = the list the overlay draws from, or null when painting into the bitmap itself. */
function paintTextCell(px, r, c, emoji) {
  const t = dev.text, dec = dev.charset === 'gbk' ? gbk : big5, b = t[r * 20 + c];
  if (!b) return 0;
  if (b > dev.lead && c < 19) {
    const lo = t[r * 20 + c + 1], k = (b << 8) | lo;
    if (k >= 0xfa40 && dev.charset === 'big5') { const fam = pictoFamily(), pg = fam && window.LCDFONT && LCDFONT.pictogram16(k, fam); if (pg) { blit(px, LCDFONT.bits(pg, 16, 16), 16, c, r); return 2; } if (PICTO[k]) { if (!emoji) return -1; clearCell(px, c, 16, r); emoji.push({ r, c, ch: PICTO[k] }); } else hexTile(px, c, r, k); return 2; }
    if (dev.charset === 'gbk' && dev.flash && b >= 0xFA && window.LCDFONT) {      // an installed engine image: its icon codes count up from FA46 (see lcdfont.js)
      const fam = pictoFamily(), pg = fam && LCDFONT.pictogram16(k, fam); if (pg) { blit(px, LCDFONT.bits(pg, 16, 16), 16, c, r); return 2; }
    }
    if (dev.charset === 'gbk' && window.LCDFONT) {           // the machine's own font (GB2312) and its pictures (F8A1-FDD9); anything it lacks falls through to the system font below
      const g = LCDFONT.picture16(b, lo) || LCDFONT.glyph16(b, lo);
      if (g) { blit(px, LCDFONT.bits(g, 16, 16), 16, c, r); return 2; }
    }
    if (dev.charset === 'gbk' && b >= 0xFA) { hexTile(px, c, r, k); return 2; }          // the pictogram area (FA40 and up) of the machine: no picture in our font, so its code is shown, not the rare ideograph a GBK table has there
    const s = dev.charset === 'gbk' ? GVB.gbkChar(b, lo) : dec.decode(Uint8Array.of(b, lo));      // gbkChar also finds characters stored under spare codes (see gvb.js)
    if (s.length === 1 && s.charCodeAt(0) >= 0xE000 && s.charCodeAt(0) <= 0xF8FF) { hexTile(px, c, r, k); return 2; }      // a picture of a mainland model that the font does not have: shown as its code
    blit(px, glyph(s === '�' ? '□' : s), 16, c, r); return 2;
  }
  if (b > dev.lead) return 1;
  blit(px, asciiGlyph(b), 8, c, r); return 1;
}
/* GRAPH mode: a printed character is drawn into the bitmap right away, like the device (and arucil's simulator) do; what is drawn, scrolled or cleared afterwards acts on its pixels. */
dev.stampCell = (r, c) => {
  const n = paintTextCell(dev.gfx, r, c, null);
  if (n > 0 && dev.inv[r * 20 + c] === 1) for (let y = 0; y < 16; y++) for (let x = 0; x < 8 * n; x++) dev.gfx[(r * 16 + y) * 160 + c * 8 + x] ^= 1;
  return n > 0 ? n : 0;
};

function render(force) {
  const theme = css('--lcd-bg') + css('--lcd-fg');
  if (!force && dev.version === lastVer && blink === lastBlink && theme === lastTheme) return;
  lastVer = dev.version; lastBlink = blink; lastTheme = theme;
  const px = new Uint8Array(160 * 80);
  px.set(dev.gfx);
  const emoji = [];
  if (!dev.flash || dev.printed) for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 20; c++) {
      if (dev.stamped[r * 20 + c]) continue;                       // GRAPH mode: this character is already part of the bitmap
      const n = paintTextCell(px, r, c, emoji); if (n > 1) c += n - 1;
    }
  }
  if (!dev.flash || dev.printed) for (let i = 0; i < 100; i++) {      // INVERSE / FLASH text: the cell's pixels are swapped (flashing ones only while the blink is on)
    const a = dev.inv[i]; if (!a || dev.stamped[i] || (a === 2 && !blink)) continue;
    const x0 = (i % 20) * 8, y0 = Math.floor(i / 20) * 16;
    for (let y = 0; y < 16; y++) for (let x = 0; x < 8; x++) px[(y0 + y) * 160 + x0 + x] ^= 1;
  }
  const bg = hex2rgb(css('--lcd-bg')), fg = hex2rgb(css('--lcd-fg'));
  const o = img.data;
  for (let i = 0; i < px.length; i++) { const c = px[i] ? fg : bg; o[i * 4] = c[0]; o[i * 4 + 1] = c[1]; o[i * 4 + 2] = c[2]; o[i * 4 + 3] = 255; }
  octx.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(off, 0, 0, 640, 320);
  ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
  for (const e of emoji) {
    ctx.font = '52px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji","Segoe UI Symbol",sans-serif';
    ctx.fillStyle = css('--lcd-fg');
    ctx.fillText(e.ch, e.c * 32 + 32, e.r * 64 + 34);
  }
  const cur = dev.cursor || (dev.input ? { x: dev.x, y: dev.y } : null);
  if (cur && blink) { ctx.fillStyle = css('--lcd-fg'); ctx.fillRect(cur.x * 32, cur.y * 64 + 56, 32, 6); }
}
dev.paintText = paintSmallText;
setInterval(() => { blink = !blink; }, 500);
requestAnimationFrame(draw);

/* ---------------------------------------------------------------- status bar */
function setStatus(kind, text, isErr) {
  $('status').innerHTML = '<span class="dot ' + kind + '"></span>' + (isErr ? '<span class="err"></span>' : '<b></b>');
  $('status').lastChild.textContent = text;
}
setInterval(() => {
  if (mode === 'running' && !(machine && machine.kind === 'raw')) {      // a hardware-level game shows its own help text
    const st = dev.hint || ((dev.input ? '等待輸入' : dev.waiters.length ? '等待按鍵' : '執行中') + (dev.flash && dev.flash.name ? '　· 映像：' + dev.flash.name : ''));
    if ($('status').textContent !== st) setStatus(dev.input || dev.waiters.length ? 'wait' : 'run', st);
  }
  if (typeof updateChips === 'function') updateChips();
}, 150);

/* ---------------------------------------------------------------- folder handling */
async function mount(b) {
  if (machine && machine.running) { machine.stop(); await new Promise(r => setTimeout(r, 30)); }
  backend = b; path = []; sel = 0; top = 0;
  session = new FS.DatSession(b, (name, e) => { setStatus('err', '寫入 ' + name + ' 失敗：' + e.message, true); console.error(e); });
  $('mode').textContent = b.kind === 'handle'
    ? '可讀寫：程式存的 DAT 會直接寫回這個實體資料夾。'
    : '唯讀來源：此瀏覽器不能直接寫入資料夾；程式寫出的 DAT 暫存在瀏覽器（重新整理不會消失），可用「下載」取出。';
  mode = 'menu';
  await loadDir();
  toMenu();
}

async function loadDir(keepName) {
  if (!backend) { entries = []; renderSide(); return; }
  let list;
  try { list = await backend.list(path); }
  catch (e) { setStatus('err', '無法讀取資料夾：' + e.message, true); list = []; }
  const dirs = list.filter(e => e.kind === 'dir' && !e.name.startsWith('.')).sort(sortName);
  const bas = list.filter(e => e.kind === 'file' && FS.isBas(e.name)).sort(sortName);
  const dat = list.filter(e => e.kind === 'file' && FS.isDat(e.name)).sort(sortName);
  entries = [];
  if (path.length) entries.push({ type: 'up', name: '..' });
  dirs.forEach(e => entries.push({ type: 'dir', name: e.name }));
  bas.forEach(e => entries.push({ type: 'bas', name: e.name, size: e.size }));
  for (const e of list.filter(x => x.kind === 'file' && FS.isTxt(x.name) && (x.size === undefined || x.size <= 300000)).sort(sortName)) {      // text listings of programs
    try { if (TXT.looksLikeProgram(TXT.decodeText(await backend.read(path, e.name)).text)) entries.push({ type: 'txt', name: e.name, size: e.size }); } catch (err) { /* unreadable: not listed */ }
  }
  dat.forEach(e => entries.push({ type: 'dat', name: e.name, size: e.size }));
  for (const e of list.filter(x => x.kind === 'file' && FS.isBin(x.name)).sort(sortName)) {
    const en = { type: 'bin', name: e.name, size: e.size };
    if (isImage(en)) { try { const c = await classifyEntry(en); en.image = c.kind; en.gameName = c.info && c.info.name; en.hasHeader = !!c.info; en.why = c.reason; } catch (err) { /* unreadable: shown as a plain image */ } }
    entries.push(en);
  }
  let idx = keepName ? entries.findIndex(e => e.name === keepName) : -1;
  if (idx < 0) idx = Math.min(sel, Math.max(0, entries.length - 1));
  sel = idx;
  renderSide();
  if (mode === 'menu') drawMenu();
}

async function openDir(name) {
  path = path.concat(name); top = 0; sel = 0;
  await loadDir();
  const first = entries.findIndex(e => e.type !== 'up'); sel = first < 0 ? 0 : first;
  if (mode === 'menu') { drawMenu(); refreshMenuStatus(); }
  renderSide();
}
async function goUp() {
  if (!path.length) return;
  const from = path[path.length - 1]; path = path.slice(0, -1); top = 0;
  await loadDir(from); if (mode === 'menu') { drawMenu(); refreshMenuStatus(); }
}
async function goTo(depth) { path = path.slice(0, depth); sel = 0; top = 0; await loadDir(); if (mode === 'menu') { drawMenu(); refreshMenuStatus(); } }

/* ---------------------------------------------------------------- LCD menu (like the real device's file list) */
const bs = (unicode, cs) => { const rev = GVB.charsetReverse(cs || 'big5'); let out = ''; for (const ch of unicode) out += ch.codePointAt(0) < 128 ? ch : rev.has(ch) ? rev.get(ch) : '?'; return out; };
/* The LCD menu is Big5 like a Taiwan device. A name with simplified Chinese (a name in traditional characters only is fine, one with simplified characters is not) has characters Big5 does not have: then the screen switches to GBK, which has both simplified and traditional. */
function uiCharset(names) {
  const big5 = GVB.charsetReverse('big5'), gbk = GVB.charsetReverse('gbk');
  for (const n of names) for (const ch of n) if (ch.codePointAt(0) >= 128 && !big5.has(ch) && gbk.has(ch)) return 'gbk';
  return 'big5';
}
function splitChars(s, lead) { lead = lead || 160; const out = []; for (let i = 0; i < s.length; i++) { if (s.charCodeAt(i) > lead && i + 1 < s.length) { out.push(s[i] + s[i + 1]); i++; } else out.push(s[i]); } return out; }
function clip(s, n, lead) { let out = '', len = 0; for (const ch of splitChars(s, lead)) { if (len + ch.length > n) break; out += ch; len += ch.length; } return out; }

function plainMachine() { dev.hw = null; dev.flash = null; dev.small = false; dev.charset = 'big5'; dev.gfxBase = 0x19C0; }   // the menu and the editor always show the plain machine
function drawMenu() {
  plainMachine(); dev.setMode('TEXT');
  if (backend) dev.charset = uiCharset([backend.name, ...path, ...entries.map(e => e.name)]);
  const cs = dev.charset, bs1 = u => bs(u, cs), clip1 = (s, n) => clip(s, n, dev.lead);
  if (!backend) {
    dev.putRow(0, 'GVBASIC');
    dev.putRow(2, clip(bs('請選擇資料夾'), 20));
    dev.putRow(3, 'Choose a folder');
    return;
  }
  if (sel < top) top = sel;
  if (sel >= top + 4) top = sel - 3;
  const counter = entries.length ? (sel + 1) + '/' + entries.length : '';
  const title = [backend.name, ...path].join('\\');
  const head = clip1(bs1(title), 19 - counter.length);
  dev.putRow(0, head + ' '.repeat(20 - head.length - counter.length) + counter);
  if (!entries.length) dev.putRow(1, ' (no .BAS files)');
  for (let i = 0; i < 4; i++) {
    const e = entries[top + i]; if (!e) continue;
    const label = e.type === 'dir' ? '[' + e.name + ']' : e.name;
    dev.putRow(1 + i, (top + i === sel ? '>' : ' ') + clip1(bs1(label), 19));
  }
  dev.touch();
}

function toMenu() {
  mode = 'menu'; dev.pending = -1;
  drawMenu(); renderSide(); refreshMenuStatus();
}
function refreshMenuStatus() {
  const e = entries[sel];
  if (!backend) { setStatus('', '尚未選擇資料夾'); $('prog').textContent = ''; return; }
  $('prog').textContent = [backend.name, ...path].join(' / ');
  if (!e) { setStatus('', '這個資料夾沒有 .BAS 或 .DAT'); return; }
  const kind = { up: '回上層', dir: '資料夾', bas: '程式', txt: '文字原始碼（TXT）', dat: '資料檔（DAT）', bin: '機器碼程式（BIN）' }[e.type];
  setStatus('', kind + '：' + e.name + (e.size !== undefined ? '（' + e.size + ' B）' : '') + (e.type === 'bas' ? '　· Enter 執行 · F4 修改' : e.type === 'txt' ? '　· Enter 轉成 BAS · Shift+Enter 試跑（不存檔）' : '') + (e.type === 'bin' ? (isImage(e) ? imageHint(e) : '　· Enter 執行（6502 機器碼，小型 BIN）') : ''));
}
function move(d) {
  if (!entries.length) return;
  sel = Math.max(0, Math.min(entries.length - 1, sel + d));
  drawMenu(); renderSide(); refreshMenuStatus();
}
function activate() {
  const e = entries[sel]; if (!e) return;
  if (e.type === 'up') goUp(); else if (e.type === 'dir') openDir(e.name); else if (e.type === 'txt') txtToBas(e); else if (e.type === 'bas' || e.type === 'bin') runEntry(e);
  else refreshMenuStatus();
}
const K_NEW = 1001, K_DELETE = 1002, K_FIND = 1003, K_EDIT = 1004;       // the device's function keys F1 / F2 / F3 / F4 (in the file menu: new, delete, - , modify); a running program gets 28-31 for them
const FKEY_CODE = { [K_NEW]: 28, [K_DELETE]: 29, [K_FIND]: 30, [K_EDIT]: 31 };
function menuKey(code) {
  switch (code) {
    case 20: move(-1); break;
    case 21: move(1); break;
    case 13: case 22: activate(); break;
    case 23: case 27: goUp(); break;
    case K_NEW: startEdit(null); break;
    case K_DELETE: askDelete(); break;
    case K_EDIT: { const e = entries[sel]; if (e && e.type === 'bas') startEdit(e); else setStatus('', '請先選一個 .BAS 程式再按 F4 修改'); break; }
    case K_FIND: setStatus('', 'F3（查找）：檔案選單沒有這個功能；執行中的程式按它會收到按鍵碼 30'); break;
    case 19: move(-4); break;                  // the page keys
    case 14: move(4); break;
    default: break;
  }
}

/* ---------------------------------------------------------------- editing: F1 new / F2 delete / F4 modify */
// Same flow as the real device: F4 opens the program in the line editor, Esc finishes editing and asks for
// the file name, Enter stores it. (Here Esc on the name screen goes back to editing instead of throwing the
// changes away; use "■ 停止" to abandon an edit.)
function screen(rows, cursor, cs) {
  plainMachine(); dev.setMode('TEXT'); if (cs) dev.charset = cs;
  rows.forEach((t, i) => dev.putRow(i, t));
  dev.cursor = cursor || null; dev.touch();
}
async function startEdit(entry) {
  if (mode === 'hold') toMenu();
  if (mode !== 'menu' || !backend) return;
  try {
    const bytes = entry ? await backend.read(path, entry.name) : null;
    editor = new GVE.LineEditor({ name: entry ? entry.name : '', bytes, charset: csSetting !== 'auto' ? csSetting : undefined });       // the editor works in the character set of the file (the "BAS 字集" setting wins)
  } catch (err) { setStatus('err', '無法開啟編輯：' + err.message, true); return; }
  editor.dirPath = path.slice();
  mode = 'edit'; renderSide(); drawEditor(); focusIme();
}
function drawEditor() {
  const v = editor.view();
  screen(v.rows, { x: v.cx, y: v.cy }, editor.cs);
  if (editor.msg) setStatus('err', editor.msg, true);
  else setStatus('', '編輯 ' + (editor.name || '新程式') + '　· Esc 結束並儲存 · F2 放棄' + (editor.insert ? '' : '　· 覆蓋模式'));
}
async function finishEdit() {
  const r = editor.build();
  if (r.errors) {
    const er = r.errors[0];
    editor.cur = er.li; editor.idx = editor.lines[er.li].text.length; drawEditor();
    setStatus('err', '第 ' + (er.li + 1) + ' 列：' + er.msg, true); return;
  }
  saveState = { bytes: r.bytes, warnings: r.warnings, chars: [...(editor.name || '').replace(/\.bas$/i, '')] };
  mode = 'save'; drawSave();
}
function drawSave() {
  const name = bs(saveState.chars.join(''));
  screen(['Input file name:', clip(name, 19), 'F2:Discard edits', 'Enter:Save', 'Esc:Back to edit'], { x: Math.min(name.length, 19), y: 1 });
  setStatus('', '輸入檔名（不用打 .BAS）　· Enter 儲存 · Esc 回到編輯 · F2 放棄修改');
}
function saveKey(act, ch) {
  if (act === 'esc') { mode = 'edit'; drawEditor(); return; }
  if (act === 'enter') { trySave(); return; }
  if (act === 'backspace') saveState.chars.pop();
  else if (act === 'char' && ch) {
    for (const c of GVB.byteStringToUnicode(ch)) if (/^[A-Za-z0-9 _\-.()㐀-鿿豈-﫿]$/.test(c) && saveState.chars.length < 18) saveState.chars.push(c);
  }
  drawSave();
}
async function trySave() {
  const name = saveState.chars.join('').trim();
  if (!name) { setStatus('err', '請輸入檔名', true); return; }
  const fname = /\.bas$/i.test(name) ? name : name + '.BAS';
  const hit = entries.find(e => e.type === 'bas' && e.name.toLowerCase() === fname.toLowerCase());
  const same = hit && editor.name && hit.name.toLowerCase() === editor.name.toLowerCase();
  if (hit && !same) { confirmState = { kind: 'overwrite', fname: hit.name }; mode = 'confirm'; drawConfirm(); return; }
  await doSave(hit ? hit.name : fname);
}
async function doSave(fname) {
  try { await backend.write(editor.dirPath, fname, saveState.bytes); }
  catch (err) { mode = 'save'; drawSave(); setStatus('err', '儲存失敗：' + err.message, true); return; }
  const warn = saveState.warnings.length ? '　· 注意：第 ' + saveState.warnings.map(w => w.no).join('、') + ' 行的語法可能有誤' : '';
  editor = null; saveState = null; confirmState = null;
  await loadDir(fname); toMenu();
  setStatus('', '已儲存 ' + fname + warn);
}
function askDelete() {
  const e = entries[sel];
  if (!e || (e.type !== 'bas' && e.type !== 'dat' && e.type !== 'txt')) { setStatus('', 'F2 刪除：請先選一個 .BAS、.TXT 或 .DAT'); return; }
  if (!backend.remove) { setStatus('err', '這個模式無法刪除檔案（只有 Chrome / Edge 選的實體資料夾可以）', true); return; }
  confirmState = { kind: 'delete', name: e.name }; mode = 'confirm'; drawConfirm();
}
function drawConfirm() {
  if (confirmState.kind === 'discard') {
    screen(['Discard changes?', 'The edits will be', 'lost.', 'Enter:Yes', 'Esc:No']);
    setStatus('', '要放棄這次的修改並離開嗎？　· Enter 放棄 · Esc 繼續編輯');
  } else if (confirmState.kind === 'delete') {
    const cs = uiCharset([confirmState.name]);
    screen(['Delete file?', clip(bs(confirmState.name, cs), 20, cs === 'gbk' ? 0x80 : 160), '', 'Enter:Yes', 'Esc:No'], null, cs);
    setStatus('', '要刪除 ' + confirmState.name + ' 嗎？　· Enter 刪除 · Esc 取消');
  } else {
    const cs = uiCharset([confirmState.fname]);
    screen(['File exists!', clip(bs(confirmState.fname, cs), 20, cs === 'gbk' ? 0x80 : 160), 'Overwrite?', 'Enter:Yes', 'Esc:No'], null, cs);
    setStatus('', confirmState.fname + ' 已存在，要覆蓋嗎？　· Enter 覆蓋 · Esc 取消');
  }
}
async function confirmKey(act) {
  if (act === 'esc') {
    const k = confirmState; confirmState = null;
    if (k.kind === 'overwrite') { mode = 'save'; drawSave(); }
    else if (k.kind === 'discard') { mode = k.back; if (mode === 'save') drawSave(); else drawEditor(); }
    else toMenu();
    return;
  }
  if (act !== 'enter') return;
  if (confirmState.kind === 'discard') { editor = null; saveState = null; confirmState = null; toMenu(); setStatus('', '已放棄修改'); return; }
  if (confirmState.kind === 'overwrite') { await doSave(confirmState.fname); return; }
  const name = confirmState.name; confirmState = null;
  try { await backend.remove(path, name); await loadDir(); toMenu(); setStatus('', '已刪除 ' + name); }
  catch (err) { toMenu(); setStatus('err', '刪除失敗：' + err.message, true); }
}
// F2 while editing = leave without saving. Nothing changed -> leave at once, otherwise ask first.
function abandonEdit() {
  if (mode !== 'edit' && mode !== 'save') return;
  if (!editor || !editor.dirty) { editor = null; saveState = null; confirmState = null; toMenu(); setStatus('', '已離開編輯'); return; }
  confirmState = { kind: 'discard', back: mode }; mode = 'confirm'; drawConfirm();
}
// edit / save / confirm screens share one key handler: act = up down left right enter backspace delete home end pageup pagedown insert esc char
function textAct(act, ch) {
  if (mode === 'edit') { if (act === 'esc') finishEdit(); else { editor.key(act, ch); drawEditor(); } }
  else if (mode === 'save') saveKey(act, ch);
  else if (mode === 'confirm') confirmKey(act);
}
const PAD_ACT = { 20: 'up', 21: 'down', 22: 'right', 23: 'left', 13: 'enter', 29: 'backspace', 27: 'esc', 19: 'pageup', 14: 'pagedown' };

/* ---------------------------------------------------------------- running a program */
const isImage = e => e.type === 'bin' && FlashImage.fits({ length: e.size || 0 });
const imageKinds = new Map();         // name + size -> the trial-run result (the same file is listed again after every change)
async function classifyEntry(e) {
  const key = e.name + ':' + e.size; if (imageKinds.has(key)) return imageKinds.get(key);
  const c = HWL.classifyImage(await backend.read(path, e.name)); imageKinds.set(key, c); return c;
}
const imageHint = e => e.image === 'game' ? '　· Enter 執行（機器碼遊戲 ' + (e.gameName || '') + '，自己讀鍵盤、不需要 BAS）'
  : e.image === 'install' ? '　· Enter 安裝（它要用到系統 ROM，不能自己跑；安裝後到同資料夾的 .BAS 執行）'
  : '　· Enter 執行或安裝（機器碼映像，' + (e.size / 32768) + ' 頁 × 32 KB）';   // a big .bin (whole 32 KB pages): a machine-code image, not a program

/* "installing" a big .bin: it goes into the machine's flash (here: kept in this browser), as a flash image is installed on the device. An image applies to the programs in the folder
 * it was installed from (and the folders below it); a second image for the same folder replaces the first. */
const curScope = () => path.length ? path[path.length - 1] : backend.name;
const persistFlash = () => FS.saveFlashes(flashes.map(f => ({ id: f.id, name: f.name, bytes: f.img.bytes, scope: f.scope, at: f.at })));
/* a program that saves into the image (the engine writes its save game into free flash pages) changes the image's bytes: keep the changed copy in this browser, a moment after the last write */
let flashSaveTimer = 0;
const watchFlash = img => { img.onWrite = () => { clearTimeout(flashSaveTimer); flashSaveTimer = setTimeout(persistFlash, 400); }; return img; };
/* the image a program in this folder runs on: the installed images whose folder is on the way to the program, the nearest one wins; an image without a folder applies everywhere, last */
function imageFor(dirPath) {
  const chain = [backend.name, ...dirPath]; let best = null, depth = -2;
  for (const f of flashes) { const d = f.scope ? chain.lastIndexOf(f.scope) : -1; if (f.scope && d < 0) continue; if (d > depth) { best = f; depth = d; } }
  return best;
}
async function installBin(e, bytes0) {
  if (mode === 'running' || !backend) return;
  try {
    const bytes = bytes0 || await backend.read(path, e.name);
    const img = watchFlash(new FlashImage(bytes, { name: e.name })), scope = curScope();
    const old = flashes.find(f => f.scope === scope);
    if (old) flashes.splice(flashes.indexOf(old), 1);
    flashes.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: e.name, scope, img, at: Date.now() });
    persistFlash(); renderFlash();
    setStatus('', '已安裝 ' + e.name + '（' + img.pages + ' 頁 × 32 KB）。「' + scope + '」資料夾（含子資料夾）內呼叫它的程式會在這個映像的機器上跑' + (old ? '（取代了這個資料夾原本的 ' + old.name + '）' : '') + '；接著進入資料夾，執行裡面的 .BAS');
    const di = entries.findIndex(x => x.type === 'dir'); if (di >= 0) sel = di;       // the programs that use the image are usually in a folder next to it
    plainMachine(); dev.setMode('TEXT');
    dev.putRow(0, clip(bs('已安裝 ' + e.name), 20)); dev.putRow(1, clip(bs('適用：' + scope), 20)); dev.putRow(2, clip(bs('進入資料夾執行 BAS'), 20)); dev.putRow(4, clip(bs('按任意鍵返回選單'), 20)); dev.touch();
    mode = 'hold'; renderSide();
  } catch (err) { setStatus('err', '無法安裝 ' + e.name + '：' + err.message, true); }
}
function removeFlash(id) {
  const k = flashes.findIndex(f => f.id === id); if (k < 0) return;
  const gone = flashes.splice(k, 1)[0]; persistFlash(); renderFlash(); renderSide();
  setStatus('', '已移除 ' + gone.name + '（' + (gone.scope ? '資料夾「' + gone.scope + '」' : '所有資料夾') + '）；那裡的程式回到一般機器');
}
function removeAllFlash() { flashes = []; persistFlash(); renderFlash(); renderSide(); setStatus('', '已移除所有機器碼映像'); }
/* the list in the side card, and the note above the file list when the folder you are looking at runs on an image */
function renderFlash() {
  $('flashcard').hidden = !flashes.length;
  $('flashtitle').textContent = '已安裝的機器碼映像（' + flashes.length + '）';
  const box = $('flashlist'); box.textContent = '';
  for (const f of flashes) {
    const row = document.createElement('div'); row.className = 'flashrow';
    const info = document.createElement('div');
    const nm = document.createElement('div'); nm.className = 'flashname'; nm.textContent = f.name; info.appendChild(nm);
    const meta = document.createElement('div'); meta.className = 'muted'; meta.textContent = f.img.pages + ' 頁 · ' + Math.round(f.img.bytes.length / 1024) + ' KB　適用：' + (f.scope ? '資料夾「' + f.scope + '」內的程式（含子資料夾）' : '所有資料夾'); info.appendChild(meta);
    const rm = document.createElement('button'); rm.className = 'b sm'; rm.textContent = '移除'; rm.onclick = () => { removeFlash(f.id); focusIme(); };
    row.appendChild(info); row.appendChild(rm); box.appendChild(row);
  }
  $('flashall').hidden = flashes.length < 2;
  renderImgNote();
}
function renderImgNote() {
  const f = backend ? imageFor(path) : null, n = $('imgnote');
  n.hidden = !f; if (!f) return;
  n.textContent = ''; const b = document.createElement('b'); b.textContent = f.name;
  n.appendChild(document.createTextNode('這個資料夾裡呼叫機器碼的程式，會在已安裝的映像 ')); n.appendChild(b); n.appendChild(document.createTextNode(' 的機器上跑（' + f.img.pages + ' 頁）　'));
  const a = document.createElement('a'); a.textContent = '移除'; a.style.cursor = 'pointer'; a.onclick = () => { removeFlash(f.id); focusIme(); }; n.appendChild(a);
}
$('flashall').onclick = () => { removeAllFlash(); focusIme(); };
FS.loadFlashes().then(list => {
  flashes = list.map(r => { try { return { id: r.id, name: r.name, scope: r.scope || null, img: watchFlash(new FlashImage(r.bytes, { name: r.name })), at: r.at || 0 }; } catch (e) { return null; } }).filter(Boolean);     // a damaged image is skipped
  renderFlash();
});

/* A big .bin is either a game that drives the hardware itself (header with an entry point: run it) or an extension for BASIC programs (install it). */
async function openImage(e, force) {
  let bytes;
  try { bytes = await backend.read(path, e.name); } catch (err) { setStatus('err', '無法讀取 ' + e.name + '：' + err.message, true); return; }
  const c = HWL.classifyImage(bytes), kind = force || c.kind;       // `force` is the "other" button: run an extension image as a game, or install a game
  if (kind === 'game' && c.info) startGame(e, bytes, c.info); else installBin(e, bytes);
}
async function startGame(e, bytes, info) {
  if (mode === 'running') return;
  const game = new HWL.RawGame(dev, new FlashImage(bytes, { name: e.name }), info, { fps: gameFps });
  machine = game; mode = 'running'; renderSide();
  $('prog').textContent = [backend.name, ...path, e.name].join(' / ');
  setStatus('run', '執行中：' + info.name + '（機器碼遊戲）　' + HWL.KEYS_HELP); focusIme();
  const res = await game.run();
  machine = null;
  if (res.error) { mode = 'hold'; setStatus('err', '機器碼遊戲停止：' + res.error.message + '　· 按任意鍵返回選單', true); await loadDir(e.name); renderSide(); return; }
  await loadDir(e.name); toMenu();
}

/* ---------------------------------------------------------------- running a program */
async function runEntry(e) {
  if (mode === 'running' || !backend) return;
  if (isImage(e)) { openImage(e); return; }
  const dirPath = path.slice();
  let store, bytes, small = null, txtCharset = null, extWords = null;
  try {
    bytes = await backend.read(dirPath, e.name);
    if (e.type === 'txt') {                                                 // convert on the fly, nothing is written
      const { result } = await readListing(e, true);
      if (result.errors.length) { showViewer(e.name + ' 無法執行', problems(result)); throw new Error(result.errors[0].msg + '（第 ' + result.errors[0].line + ' 行）'); }
      bytes = result.bytes; txtCharset = result.charset; if (result.ext) extWords = result.extUsed;
    }
    if (e.type === 'bin') {
      // a small BIN (< 8 KB, header AA A5 5A) is loaded into RAM at $2000 and CALLed at its entry address
      const info = SMALLBIN.parseSmallBin(bytes);
      if (!info) throw new Error('不是小型 BIN（檔頭 AA A5 5A），也不是整頁的機器碼映像');
      small = { info, bytes };
    }
    store = await session.load(dirPath);
  } catch (err) { setStatus('err', '無法載入 ' + e.name + '：' + err.message, true); return; }
  const inst = imageFor(dirPath), inScope = inst && (small || GVB.programUsesCall(bytes));   // only programs next to the image (an image saved without a folder: any folder) that call machine code run on its machine
  const m = new Machine(dev, store); m.name = e.name; m.flash = inScope ? inst.img : null; m.rate = rate; m.cpuMhz = cpuMhz; m.rawBase = kbdBase(); machine = m;
  m.forceCharset = csSetting !== 'auto' ? csSetting : txtCharset;           // null: found out from the program's text
  if (extWords) m.ext = true;                                               // a program written for the arucil simulator: its extra words are accepted (and it is never saved as a device .BAS)
  try {
    if (small) {
      m.prog = compileProgram([{ no: 10, body: GVB.tokenizeBody('CALL ' + small.info.entry) }, { no: 20, body: GVB.tokenizeBody('END') }]);
      m.preload = d => d.mem.set(small.bytes.subarray(0, 0xE000 - small.info.loadAt), small.info.loadAt);
    } else m.load(bytes, e.name);
  } catch (err) { machine = null; setStatus('err', '無法載入 ' + e.name + '：' + err.message, true); return; }
  m.loadProgram = async nm => {                       // RUN "name": another program of the same folder (name without .BAS is fine, any case)
    const want = GVB.byteStringToUnicode(nm).toUpperCase().replace(/\.BAS$/, '') + '.BAS';
    const f = (await backend.list(dirPath)).find(x => x.kind === 'file' && x.name.toUpperCase() === want);
    return f ? backend.read(dirPath, f.name) : null;
  };
  mode = 'running'; renderSide();
  $('prog').textContent = [backend.name, ...dirPath, e.name].join(' / ');
  setStatus('run', extWords ? '執行中　· 這支程式用到 arucil 模擬器的擴充語法（' + extWords.join('、') + '），只能在模擬器上跑，不是真機的 BAS' : '執行中'); focusIme();
  let res;
  try { res = await m.run(); } catch (err) { res = { internal: err }; console.error(err); }
  await session.idle();
  machine = null;
  if (res.stopped) { await loadDir(e.name); toMenu(); return; }
  mode = 'hold';
  if (res.error) setStatus('err', '錯誤（行 ' + res.error.gvbLine + '）：' + res.error.message + '　· 按任意鍵返回選單', true);
  else if (res.internal) setStatus('err', '內部錯誤：' + res.internal.message + '　· 按任意鍵返回選單', true);
  else setStatus('', '程式結束　· 按任意鍵返回選單');
  await loadDir(e.name);
  renderSide();
}

const runCode = code => (code === K_EDIT && dev.flash) ? code : (FKEY_CODE[code] || code);        // F1-F4 are 28-31 for a program; the engine image reads F4 as a raw scan value, as before
function routeUp(code) { if (mode !== 'running' || !machine) return; if (machine.kind === 'raw') machine.io.release(code); else dev.keyUp(runCode(code)); }
function route(code, ch) {
  if (mode === 'running' && machine && machine.kind === 'raw') { machine.io.press(code); return; }      // a game that scans the keypad itself: keys are held, not typed
  if (mode === 'running') { dev.keyDown(runCode(code), ch === undefined ? '' : ch); return; }
  if (mode === 'hold') { toMenu(); return; }
  if (mode === 'menu') { menuKey(code); return; }
  if (code === K_DELETE) { abandonEdit(); return; }   // F2 = discard while editing
  const act = PAD_ACT[code];                      // edit / save / confirm
  if (act) textAct(act);
  else if (ch) textAct('char', ch);
  else if (code >= 32 && code < 127) textAct('char', String.fromCharCode(code));
}

/* ---------------------------------------------------------------- side panel */
function renderSide() {
  if (typeof closeMenu === 'function') closeMenu();
  renderImgNote();
  const crumbs = $('crumbs'); crumbs.innerHTML = '';
  const t = $('files'); t.innerHTML = '';
  $('refresh').disabled = !backend || !(mode === 'menu' || mode === 'hold'); $('newprog').disabled = !backend || !(mode === 'menu' || mode === 'hold');
  $('stop').disabled = !(mode === 'running' || mode === 'hold' || mode === 'edit' || mode === 'save' || mode === 'confirm');
  $('stop').textContent = (mode === 'edit' || mode === 'save' || mode === 'confirm') ? '放棄修改' : '■ 停止';
  if (padF2) padF2.textContent = (mode === 'edit' || mode === 'save' || mode === 'confirm') ? 'F2 放棄' : 'F2 刪除';
  if (!backend) { t.innerHTML = '<tr><td class="muted">按「選擇資料夾…」，挑一個放有 .BAS 的資料夾。</td></tr>'; return; }
  const parts = [backend.name, ...path];
  parts.forEach((p, i) => {
    if (i) { const s = document.createElement('span'); s.className = 'sep'; s.textContent = '/'; crumbs.appendChild(s); }
    if (i === parts.length - 1) { const s = document.createElement('span'); s.className = 'cur'; s.textContent = p; crumbs.appendChild(s); }
    else { const b = document.createElement('button'); b.textContent = p; b.onclick = () => { if (mode === 'menu' || mode === 'hold') goTo(i); }; crumbs.appendChild(b); }
  });
  if (!entries.length) { t.innerHTML = '<tr><td class="muted">（沒有 .BAS 或 .DAT）</td></tr>'; return; }
  const busy = !(mode === 'menu' || mode === 'hold');
  entries.forEach((e, i) => {
    const tr = document.createElement('tr'); if (i === sel && (mode === 'menu' || mode === 'hold')) tr.className = 'sel';
    const nm = document.createElement('td'); nm.className = 'nm';
    const act = document.createElement('td'); act.className = 'act';
    const row = document.createElement('div'); row.className = 'nmrow'; nm.appendChild(row);            // tag, name (cut with an ellipsis when it is long), size: one line
    const tag = (txt, cls) => { const s = document.createElement('span'); s.className = 'tag ' + (cls || ''); s.textContent = txt; return s; };
    const link = (txt, fn) => { const a = document.createElement('a'); a.textContent = txt; a.title = txt; a.onclick = () => { if (!busy) { sel = i; fn(); } }; return a; };
    const btn = (txt, fn, dis) => { const b = document.createElement('button'); b.className = 'b sm'; b.textContent = txt; b.disabled = !!dis; b.onclick = () => { fn(); focusIme(); }; act.appendChild(b); return b; };
    const ic = (sym, title, fn, dis, cls) => { const b = document.createElement('button'); b.className = 'b ic' + (cls ? ' ' + cls : ''); b.textContent = sym; b.title = title; b.setAttribute('aria-label', title); b.disabled = !!dis; b.onclick = () => { fn(); focusIme(); }; act.appendChild(b); return b; };
    const more = items => { const b = ic('⋯', '更多功能', () => {}, false); b.onclick = ev => { ev.stopPropagation(); openMenu(b, items); }; return b; };
    const size = n => { const s = document.createElement('span'); s.className = 'muted sz'; s.textContent = n + ' B'; return s; };
    const del = () => ({ label: '刪除', disabled: busy || !backend.remove, title: backend.remove ? '' : '只有 Chrome / Edge 選的實體資料夾可以刪除檔案', fn: () => { sel = i; askDelete(); } });
    if (e.type === 'up') { row.appendChild(tag('↑')); row.appendChild(link('回上層 ..', () => goUp())); }
    else if (e.type === 'dir') { row.appendChild(tag('資料夾')); row.appendChild(link(e.name, () => openDir(e.name))); btn('開啟', () => openDir(e.name), busy); }
    else if (e.type === 'txt') {
      row.appendChild(tag('TXT', 'bas')); row.appendChild(link(e.name, () => txtToBas(e))); row.appendChild(size(e.size));
      ic('⇄', '轉成 BAS（存成 ' + e.name.replace(/\.txt$/i, '') + '.BAS）', () => { sel = i; txtToBas(e); }, busy, 'run');
      more([{ label: '試跑（不存檔）', disabled: busy, fn: () => { sel = i; runEntry(e); } }, { label: '原始碼', fn: () => viewText(e) }, del()]);
    } else if (e.type === 'bas') {
      row.appendChild(tag('BAS', 'bas')); row.appendChild(link(e.name, () => runEntry(e))); row.appendChild(size(e.size));
      ic('▶', '執行', () => { sel = i; runEntry(e); }, busy, 'run'); ic('✎', '修改（F4）', () => { sel = i; startEdit(e); }, busy);
      more([{ label: '原始碼', fn: () => viewSource(e) }, { label: '存成 TXT', fn: () => basToTxt(e) }, del()]);
    } else {
      row.appendChild(tag(e.type === 'bin' ? 'BIN' : 'DAT')); const nmt = document.createElement('span'); nmt.className = 'fname'; nmt.textContent = e.name; nmt.title = e.name; row.appendChild(nmt); row.appendChild(size(e.size));
      if (e.type === 'bin') {
        act.classList.add('wrap'); nm.classList.add('wrapnm');
        const n = document.createElement('div'); n.className = 'muted';
        if (isImage(e)) {
          n.textContent = '機器碼映像（' + (e.size / 32768) + ' 頁 × 32 KB）：' + (e.image === 'game' ? '試跑時完全沒碰系統 ROM，是自己讀硬體的遊戲，直接執行' : e.image === 'install' ? (e.hasHeader ? '有標準 BIN 檔頭，但試跑時馬上呼叫系統 ROM（' + e.why + '），不能自己跑：先安裝，再執行同資料夾（含子資料夾）裡呼叫它的 .BAS' : '沒有 BIN 檔頭，是給 BASIC 程式用的擴充：先安裝，再執行同資料夾（含子資料夾）裡呼叫它的 .BAS') : '遊戲直接執行，擴充要安裝');
          const here = flashes.find(f => f.name === e.name && f.scope === curScope() && f.img.bytes.length === e.size);          // this very file is installed from this folder
          if (here) row.children[0].after(tag('已安裝', 'bas'));
          nm.appendChild(n); btn(here ? '重新安裝' : e.image === 'install' ? '▶ 安裝' : e.image === 'game' ? '▶ 執行遊戲' : '▶ 執行／安裝', () => { sel = i; openImage(e); }, busy);
          if (here) btn('移除', () => removeFlash(here.id), busy);
          if (e.hasHeader) btn(e.image === 'install' ? '當遊戲試跑' : '改成安裝', () => { sel = i; openImage(e, e.image === 'install' ? 'game' : 'install'); }, busy);
        }
        else { n.textContent = '6502 機器碼：小型 BIN（< 8 KB）'; nm.appendChild(n); btn('▶ 執行', () => { sel = i; runEntry(e); }, busy); }
      }
      else { btn('檢視', () => viewDat(e)); btn('下載', () => downloadDat(e)); }
      if (backend.remove && e.type === 'dat') btn('刪除', () => deleteDat(e), busy);
    }
    tr.appendChild(nm); tr.appendChild(act); t.appendChild(tr);
  });

}

/* the "..." menu of a file row: a small floating list next to the button; any click elsewhere, Esc, a scroll or a resize closes it */
let openMenuEl = null;
function closeMenu() { if (openMenuEl) { openMenuEl.remove(); openMenuEl = null; } }
function openMenu(anchor, items) {
  const again = openMenuEl && openMenuEl.anchor === anchor; closeMenu(); if (again) return;
  const m = document.createElement('div'); m.className = 'fmenu'; m.setAttribute('role', 'menu'); m.anchor = anchor;
  for (const it of items) { const b = document.createElement('button'); b.type = 'button'; b.setAttribute('role', 'menuitem'); b.textContent = it.label; b.disabled = !!it.disabled; if (it.title) b.title = it.title; b.onclick = () => { closeMenu(); it.fn(); focusIme(); }; m.appendChild(b); }
  document.body.appendChild(m); openMenuEl = m;
  const r = anchor.getBoundingClientRect(), mw = m.offsetWidth, mh = m.offsetHeight;
  m.style.left = Math.max(8, Math.min(innerWidth - mw - 8, r.right - mw)) + 'px';
  m.style.top = (r.bottom + mh + 8 > innerHeight ? Math.max(8, r.top - mh - 4) : r.bottom + 4) + 'px';
}
document.addEventListener('pointerdown', e => { if (openMenuEl && !e.target.closest('.fmenu') && e.target !== openMenuEl.anchor) closeMenu(); }, true);
window.addEventListener('keydown', e => { if (e.key === 'Escape' && openMenuEl) { closeMenu(); e.preventDefault(); e.stopPropagation(); } }, true);
window.addEventListener('scroll', closeMenu, true); window.addEventListener('resize', closeMenu);

function showViewer(title, text) { const v = $('viewer'); v.hidden = false; v.textContent = title + '\n' + '─'.repeat(24) + '\n' + text; }
async function readListing(e, forRun) {                                    // a .txt program: decode and convert (all errors collected)
  const { text } = TXT.decodeText(await backend.read(path, e.name));
  return { text, result: TXT.convertText(text, { charset: csSetting === 'auto' ? 'auto' : csSetting, ext: forRun ? 'auto' : false }) };
}
const problems = r => r.errors.slice(0, 8).map(x => '第 ' + x.line + ' 行' + (x.no !== undefined ? '（行號 ' + x.no + '）' : '') + '：' + x.msg).join('\n') + (r.errors.length > 8 ? '\n… 還有 ' + (r.errors.length - 8) + ' 個' : '');
async function viewText(e) { try { showViewer(e.name + '（文字原始碼）', (await readListing(e)).text); } catch (err) { showViewer(e.name, '無法讀取：' + err.message); } }
async function txtToBas(e) {
  try {
    const { result } = await readListing(e);
    if (result.errors.length) { showViewer(e.name + ' 無法轉成 BAS', problems(result) + (result.errors.some(x => x.sim) ? '\n\n（SLEEP、PAINT 等是 arucil 模擬器自己加的語法，真機沒有，所以不能存成真機的 BAS；要在這個模擬器試跑，按列右邊的「⋯」→「試跑（不存檔）」，或選到這個檔按 Shift+Enter）' : '')); setStatus('err', '無法轉成 BAS：' + result.errors[0].msg, true); return; }
    const name = e.name.replace(/\.txt$/i, '') + '.BAS';
    if (entries.some(x => x.name.toUpperCase() === name.toUpperCase()) && !confirm(name + ' 已經存在，要覆蓋嗎？')) return;
    await backend.write(path, name, result.bytes);
    await loadDir(name);
    setStatus('', '已轉成 ' + name + '（' + result.lines + ' 行，' + result.charset.toUpperCase() + '）' + (result.warnings.length ? '，有 ' + result.warnings.length + ' 個警告：' + result.warnings[0].msg : ''));
  } catch (err) { setStatus('err', '轉換失敗：' + err.message, true); }
}
async function basToTxt(e) {
  try {
    const { bytes: out } = TXT.basToText(await backend.read(path, e.name), csSetting === 'auto' ? undefined : csSetting);
    const name = e.name.replace(/\.bas$/i, '') + '.txt';
    if (backend.kind !== 'handle') {                                            // a folder that cannot be written: hand the file over as a download
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([out], { type: 'text/plain;charset=utf-8' })); a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setStatus('', '已下載 ' + name + '（這個資料夾是唯讀來源，不能直接寫入）'); return;
    }
    if (entries.some(x => x.name.toUpperCase() === name.toUpperCase()) && !confirm(name + ' 已經存在，要覆蓋嗎？')) return;
    await backend.write(path, name, out);
    await loadDir(e.name);
    setStatus('', '已存成 ' + name + '（' + out.length + ' B，UTF-8；可以用「轉成 BAS」轉回來）');
  } catch (err) { setStatus('err', '存成 TXT 失敗：' + err.message, true); }
}
async function viewSource(e) {
  try { showViewer(e.name + '（還原成文字，原檔未改動）', listProgram(await backend.read(path, e.name), csSetting === 'auto' ? undefined : csSetting)); }
  catch (err) { showViewer(e.name, '無法解析：' + err.message); }
}
function datText(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0xff) out += '↵\n';
    else if (c > 160 && i + 1 < s.length) { out += big5.decode(Uint8Array.of(c, s.charCodeAt(i + 1))); i++; }
    else out += s[i];
  }
  return out;
}
async function viewDat(e) { showViewer(e.name + '（↵ = 一筆記錄結束）', datText(bytesToStr(await backend.read(path, e.name)))); }
async function downloadDat(e) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([await backend.read(path, e.name)], { type: 'application/octet-stream' }));
  a.download = e.name; document.body.appendChild(a); a.click(); a.remove();
}
async function deleteDat(e) {
  if (!confirm('要從資料夾刪除 ' + e.name + ' 嗎？')) return;
  try { await backend.remove(path, e.name); $('viewer').hidden = true; await loadDir(); } catch (err) { setStatus('err', '刪除失敗：' + err.message, true); }
}

/* ---------------------------------------------------------------- picking a folder */
async function pickFolder() {
  if (FS.canPickDirectory()) {
    try { const h = await window.showDirectoryPicker({ mode: 'readwrite' }); FS.saveHandle(h); await mount(new FS.HandleBackend(h)); }
    catch (e) { if (e.name !== 'AbortError') setStatus('err', '無法開啟資料夾：' + e.message, true); }
  } else $('pickfb').click();
}
$('pick').onclick = pickFolder;
$('pickfb').onchange = async e => { const f = e.target.files; if (f.length) await mount(FS.fromFileList(f, storage)); e.target.value = ''; };
$('refresh').onclick = () => { $('viewer').hidden = true; loadDir(); };
$('newprog').onclick = () => { startEdit(null); focusIme(); };
$('stop').onclick = () => {
  if (machine && machine.running) machine.stop();
  else if (mode === 'hold') toMenu();
  else if (mode === 'edit' || mode === 'save' || mode === 'confirm') abandonEdit();
  focusIme();
};

(async function restoreLast() {
  if (!FS.canPickDirectory()) return;
  const h = await FS.loadHandle(); if (!h) return;
  let perm = 'prompt'; try { perm = await h.queryPermission({ mode: 'readwrite' }); } catch (e) { /* ignore */ }
  if (perm === 'granted') { mount(new FS.HandleBackend(h)); return; }
  const b = $('reopen'); b.hidden = false; b.textContent = '重新開啟「' + h.name + '」';
  b.onclick = async () => {
    try { if (await h.requestPermission({ mode: 'readwrite' }) === 'granted') { b.hidden = true; await mount(new FS.HandleBackend(h)); } }
    catch (e) { setStatus('err', '無法重新開啟：' + e.message, true); }
  };
})();

/* ---------------------------------------------------------------- speed and sound */
const SPEEDS = [[0, '不限速（最快）'], [1000, '慢　約 1,000 句/秒'], [3000, '一般　約 3,000 句/秒'], [10000, '快　約 10,000 句/秒']];
let rate = 3000;
function store(k, v) { try { if (v === undefined) return storage && storage.getItem(k); storage && storage.setItem(k, v); } catch (e) { /* ignore */ } return null; }
(function () {
  const sel = $('speed');
  const saved = Number(store('gvb.rate')); if (SPEEDS.some(s => s[0] === saved) && store('gvb.rate') !== null) rate = saved;
  for (const [v, label] of SPEEDS) { const o = document.createElement('option'); o.value = v; o.textContent = label; sel.appendChild(o); }
  sel.value = String(rate);
  sel.onchange = () => { rate = Number(sel.value); store('gvb.rate', String(rate)); if (machine) machine.rate = rate; focusIme(); };
  const snd = $('sound'); snd.checked = store('gvb.sound') !== '0';
  snd.onchange = () => { store('gvb.sound', snd.checked ? '1' : '0'); if (!snd.checked) audio.stop(); focusIme(); };
})();

/* Numbering of the machine's pictograms (FA40 and up): auto = by the program (an installed engine image: B), a / b = forced, hex = only the boxed code (see web/lcdfont.js) */
let pictoSetting = 'auto';
function pictoFamily() { return pictoSetting === 'hex' ? null : pictoSetting === 'auto' ? (dev.flash ? 'b' : dev.pictoFamily || 'a') : pictoSetting; }
(function () {
  const sel = $('picto'), saved = store('gvb.picto'); if (['auto', 'a', 'b', 'hex'].includes(saved)) pictoSetting = saved;
  if (!sel) return;
  for (const [v, label] of [['auto', '自動判斷'], ['a', 'A：從 FA40 起算'], ['b', 'B：從 FA46 起算'], ['hex', '只顯示代碼方框']]) { const o = document.createElement('option'); o.value = v; o.textContent = label; sel.appendChild(o); }
  sel.value = pictoSetting;
  sel.onchange = () => { pictoSetting = sel.value; store('gvb.picto', pictoSetting); render(true); focusIme(); };
})();
let csSetting = 'auto';                 // character set of BAS text: auto | big5 | gbk
(function () {
  const sel = $('cs'), saved = store('gvb.cs'); if (['auto', 'big5', 'gbk'].includes(saved)) csSetting = saved;
  for (const [v, label] of [['auto', '自動判斷'], ['big5', 'Big5（台灣機種）'], ['gbk', 'GBK（大陸機種）']]) { const o = document.createElement('option'); o.value = v; o.textContent = label; sel.appendChild(o); }
  sel.value = csSetting;
  sel.onchange = () => { csSetting = sel.value; store('gvb.cs', csSetting); focusIme(); };
})();
const FPS_CHOICES = [15, 20, 30, 45, 60];
/* Machine code reached by CALL (an RPG engine image, small .BIN files) used to run flat out, far faster than the device: the character took many steps during a short tap. The number is
 * not the real clock of any model (the routines of the ROM cost nothing here, so the real thing is slower than its clock suggests); 0.5 is what makes one tap one step on the engine's map. */
const MHZ_CHOICES = [[0, '全速（最快）'], [5.12, '5.12 MHz'], [2, '2 MHz'], [1, '1 MHz'], [0.5, '0.5 MHz（預設）'], [0.25, '0.25 MHz']];
let cpuMhz = 0.5;
(function () {
  const sel = $('mhz'), saved = store('gvb.mhz'); if (saved !== null && MHZ_CHOICES.some(c => c[0] === Number(saved))) cpuMhz = Number(saved);
  if (!sel) return;                    // an old index.html from the browser cache has no such box: keep the default instead of stopping the whole page
  for (const [v, t] of MHZ_CHOICES) { const o = document.createElement('option'); o.value = v; o.textContent = t; sel.appendChild(o); }
  sel.value = String(cpuMhz);
  sel.onchange = () => { cpuMhz = Number(sel.value); store('gvb.mhz', String(cpuMhz)); if (machine && machine.kind !== 'raw') machine.cpuMhz = cpuMhz; focusIme(); };
})();
/* Which keypad matrix the programs that read the scan bytes (PEEK(191) ...) see: $BC or $BF, or automatic = the program decides (a constant PEEK(191..198) means $BF, anything else $BC) */
const KBD_CHOICES = [['auto', '自動（依程式判斷）'], [188, '矩陣從 $BC 起'], [191, '矩陣從 $BF 起']];
let kbdChoice = 'auto';
const kbdBase = () => (kbdChoice === 'auto' ? 0 : Number(kbdChoice));
(function () {
  const sel = $('kbd'), saved = store('gvb.kbd'); if (saved !== null && KBD_CHOICES.some(c => String(c[0]) === saved)) kbdChoice = saved === 'auto' ? 'auto' : Number(saved);
  if (!sel) return;                    // an old index.html from the browser cache has no such box
  for (const [v, t] of KBD_CHOICES) { const o = document.createElement('option'); o.value = v; o.textContent = t; sel.appendChild(o); }
  sel.value = String(kbdChoice);
  sel.onchange = () => {
    kbdChoice = sel.value === 'auto' ? 'auto' : Number(sel.value); store('gvb.kbd', String(kbdChoice));
    if (machine && machine.kind !== 'raw') { machine.rawBase = kbdBase(); dev.rawBase = machine.rawBase || GVB.detectRawBase(machine.prog); dev.resetRaw(); }       // takes effect at once
    focusIme();
  };
})();
let gameFps = 30;
(function () {
  const sel = $('fps'), saved = Number(store('gvb.fps')); if (FPS_CHOICES.includes(saved)) gameFps = saved;
  for (const f of FPS_CHOICES) { const o = document.createElement('option'); o.value = f; o.textContent = f + ' 幀/秒'; sel.appendChild(o); }
  sel.value = String(gameFps);
  sel.onchange = () => { gameFps = Number(sel.value); store('gvb.fps', String(gameFps)); if (machine && machine.setFps) machine.setFps(gameFps); focusIme(); };
})();

/* BEEP / PLAY: square-wave notes through Web Audio, like the device's piezo. The program waits for the tune either way (play() returns its length). */
const audio = (function () {
  let ac = null, out = null, live = [];
  const ctxReady = () => {
    if (!ac) { const C = window.AudioContext || window.webkitAudioContext; if (!C) return null; ac = new C(); out = ac.createGain(); out.gain.value = 0.12; out.connect(ac.destination); }
    if (ac.state === 'suspended') ac.resume();
    return ac;
  };
  return {
    play(notes) {
      const total = notes.reduce((t, n) => t + n.dur, 0);
      if (!$('sound').checked) return total;
      const c = ctxReady(); if (!c) return total;
      let at = c.currentTime + 0.03;
      for (const n of notes) {
        if (n.freq > 0) {
          const o = c.createOscillator(), g = c.createGain(), on = Math.max(0.01, n.dur * 0.92);
          o.type = 'square'; o.frequency.value = n.freq;
          g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(1, at + 0.003); g.gain.setValueAtTime(1, at + on - 0.006); g.gain.linearRampToValueAtTime(0, at + on);
          o.connect(g); g.connect(out); o.start(at); o.stop(at + on + 0.01);
          live.push(o); o.onended = () => { live = live.filter(x => x !== o); };
        }
        at += n.dur;
      }
      return total;
    },
    stop() { for (const o of live) { try { o.stop(); } catch (e) { /* already stopped */ } } live = []; },
  };
})();
dev.audio = audio;

/* ---------------------------------------------------------------- clock */
(function () {
  const h = $('hour');
  for (let i = 0; i < 24; i++) { const o = document.createElement('option'); o.value = i; o.textContent = i + ' 點'; h.appendChild(o); }
  const apply = () => { dev.hour = h.value === '' ? () => new Date().getHours() : () => Number(h.value); };
  h.onchange = apply; apply();
})();

/* ---------------------------------------------------------------- on-screen keypad */
let padF2 = null;
const LAYOUT = [
  [['q'], ['w'], ['e'], ['r'], ['t', 7], ['y', 8], ['u', 9], ['i'], ['o'], ['p']],
  [['a'], ['s'], ['d'], ['f'], ['g', 4], ['h', 5], ['j', 6], ['k'], ['l']],
  [['z'], ['x'], ['c'], ['v'], ['b', 1], ['n', 2], ['m', 3]],
];
function mkKey(label, opt) {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'k' + (opt.cls ? ' ' + opt.cls : '');
  b.textContent = label;
  if (opt.num) { const s = document.createElement('span'); s.className = 'n'; s.textContent = opt.num; b.appendChild(s); }
  let held = false;
  b.addEventListener('pointerdown', e => {
    e.preventDefault(); b.classList.add('down'); held = true;
    if (opt.onPress) opt.onPress(b); else route(opt.code, typeof opt.ch === 'function' ? opt.ch() : opt.ch);
  });
  const up = () => { b.classList.remove('down'); if (held) { held = false; if (opt.code !== undefined) routeUp(opt.code); } };
  b.addEventListener('pointerup', up); b.addEventListener('pointerleave', up); b.addEventListener('pointercancel', up);
  return b;
}
(function buildPad() {
  const pad = $('pad');
  const addRow = keys => { const r = document.createElement('div'); r.className = 'row'; keys.forEach(k => r.appendChild(k)); pad.appendChild(r); };
  padF2 = mkKey('F2 刪除', { code: K_DELETE, cls: 'wide fn' });       // becomes "F2 放棄" while editing
  addRow([
    mkKey('F1 新增', { code: K_NEW, cls: 'wide fn' }), padF2, mkKey('F3 查找', { code: K_FIND, cls: 'wide fn' }), mkKey('F4 修改', { code: K_EDIT, cls: 'wide fn' }),
    mkKey('數字鍵', { cls: 'wide fn', onPress: b => { numMode = !numMode; b.classList.toggle('on', numMode); } }),
  ]);
  LAYOUT.forEach(row => addRow(row.map(([ch, num]) => mkKey(ch, { code: ch.charCodeAt(0), ch: () => (numMode && num ? String(num) : ch), num }))));
  addRow([...'"(),;:=<>+-*/^$%#?'].map(c => mkKey(c, { code: c.charCodeAt(0), ch: c, cls: 'sym' })));
  addRow([
    mkKey('幫助', { code: 25, cls: 'wide' }), mkKey('Esc', { code: 27, cls: 'wide' }), mkKey('空白', { code: 32, ch: ' ', cls: 'wide' }),
    mkKey('0', { code: 48, ch: '0' }), mkKey('.', { code: 46, ch: '.' }),
    mkKey('刪除', { code: 29, cls: 'wide' }), mkKey('Enter', { code: 13, cls: 'wide' }),
  ]);
  addRow([
    mkKey('輸入法', { cls: 'wide', onPress: () => imeKey() }), mkKey('大小寫', { code: 18, cls: 'wide' }),
    mkKey('▲ 頁', { code: 19, cls: 'wide' }), mkKey('▼ 頁', { code: 14, cls: 'wide' }),
  ]);
  const a = document.createElement('div'); a.className = 'arrows';
  [['◀', 23], ['▲', 20], ['▼', 21], ['▶', 22]].forEach(([l, c]) => a.appendChild(mkKey(l, { code: c })));
  pad.appendChild(a);
})();

/* ---------------------------------------------------------------- physical keyboard */
/* Typing: the hidden box that gets the keystrokes is a password box by default, which makes the browser keep the system's input method (Zhuyin, Pinyin ...) out of it, so every key arrives as a plain
 * key whatever the input method is set to. "中文輸入" turns it into an ordinary text box: the system's input method works and its text comes in through compositionend. */
let imeMode = 'direct';
(function () { const sv = store('gvb.ime'); if (sv === 'cn') imeMode = 'cn'; })();
function applyIme() {
  $('ime').type = imeMode === 'cn' ? 'text' : 'password'; $('ime').value = '';
  const b = $('imebtn'); if (b) { b.textContent = imeMode === 'cn' ? '輸入：中文輸入法' : '輸入：直接'; b.classList.toggle('on', imeMode === 'cn'); b.title = imeMode === 'cn' ? '現在用系統的輸入法打字；按一下改回直接輸入英數' : '現在每個鍵都直接送給程式，不受系統輸入法影響；要打中文，按一下切到中文輸入法'; }
}
function toggleIme() { imeMode = imeMode === 'cn' ? 'direct' : 'cn'; store('gvb.ime', imeMode); applyIme(); focusIme(); }
function imeKey() { if (mode === 'running' && machine && machine.kind !== 'raw' && !dev.input) route(26); else toggleIme(); }       // the input-method key: a program polling the keys gets 26, otherwise it switches the way of typing
let capsOn = false;
const noteCaps = e => { if (e.getModifierState) capsOn = e.getModifierState('CapsLock'); };
window.addEventListener('keydown', noteCaps, true); window.addEventListener('keyup', noteCaps, true);
function updateChips() {
  const c = $('capschip'); if (!c) return;
  const show = mode === 'running' && dev.input && !(machine && machine.kind === 'raw');
  c.hidden = !show; if (show) { const t = capsOn ? 'A 大寫' : 'a 小寫'; if (c.textContent !== t) c.textContent = t; c.classList.toggle('on', capsOn); }
}
function focusIme() { try { $('ime').focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
document.addEventListener('pointerdown', e => { if (!e.target.closest('input,select,textarea,button,a,pre,summary')) focusIme(); });
$('lcd').addEventListener('pointerdown', focusIme);

window.addEventListener('keydown', e => {
  if (e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = (e.target.tagName || '').toLowerCase();
  if ((tag === 'input' && e.target.id !== 'ime') || tag === 'select' || tag === 'textarea') return;
  const k = e.key;
  if (mode === 'running') {
    if (dev.input) {
      if (k === 'Enter') route(13);
      else if (k === 'Backspace' || k === 'F2') route(29);
      else if (k.length === 1 && k.charCodeAt(0) < 128) route(-1, k);
      else return;                       // IME text arrives via compositionend
      e.preventDefault(); return;
    }
    if (k === 'F4' && dev.flash) { e.preventDefault(); route(K_EDIT); return; }
    const code = k === '?' ? 25 : codeFromKey(k);
    if (code < 0) return;
    e.preventDefault(); route(code); return;
  }
  if (mode === 'hold') { if (['Shift', 'Control', 'Alt', 'Meta', 'Tab'].includes(k)) return; e.preventDefault(); toMenu(); return; }
  if (mode === 'menu') {
    const map = { ArrowUp: 20, ArrowDown: 21, ArrowLeft: 23, ArrowRight: 22, Enter: 13, Escape: 27, Backspace: 23, F1: K_NEW, F2: K_DELETE, F3: K_FIND, F4: K_EDIT };
    if (k === 'Enter' && e.shiftKey && entries[sel] && entries[sel].type === 'txt') { e.preventDefault(); runEntry(entries[sel]); }
    else if (map[k] !== undefined) { e.preventDefault(); route(map[k]); }
    else if (k === 'PageUp') { e.preventDefault(); move(-4); }
    else if (k === 'PageDown') { e.preventDefault(); move(4); }
    else if (k === 'Home') { e.preventDefault(); move(-1e9); }
    else if (k === 'End') { e.preventDefault(); move(1e9); }
    return;
  }
  if (mode === 'edit' || mode === 'save' || mode === 'confirm') {
    const acts = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Enter: 'enter', Backspace: 'backspace',
      Delete: 'delete', Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown', Insert: 'insert', Escape: 'esc' };
    if (k === 'F2') { e.preventDefault(); abandonEdit(); }
    else if (acts[k]) { e.preventDefault(); textAct(acts[k]); }
    else if (k.length === 1 && k.charCodeAt(0) < 128) { e.preventDefault(); textAct('char', k); }
  }
});
window.addEventListener('keyup', e => {
  if (mode !== 'running' || !machine) return;
  const code = e.key === '?' ? 25 : codeFromKey(e.key); if (code >= 0) { if (machine.kind === 'raw') e.preventDefault(); routeUp(code); }
});
window.addEventListener('blur', () => { if (machine && machine.kind === 'raw') machine.io.releaseAll(); else if (machine) { dev.held.clear(); dev.resetRaw(); } });
$('ime').addEventListener('compositionend', e => {
  if (mode === 'running' && dev.input) for (const ch of splitChars(toByteString(e.data || '', dev.charset, true), dev.lead)) dev.keyDown(-1, ch);
  else if (mode === 'edit') for (const ch of splitChars(toByteString(e.data || '', editor.cs), editor.lead)) textAct('char', ch);
  else if (mode === 'save') for (const ch of splitChars(toByteString(e.data || ''))) textAct('char', ch);
  $('ime').value = '';
});
$('ime').addEventListener('input', e => { if (!e.isComposing) $('ime').value = ''; });
/* A stray F5 (right next to the F4 that games use all the time) must not throw away a running program or an edit that is not saved: while a program runs or an edit is open, F5 is swallowed and a note says so.
 * Ctrl+R, the browser's reload button and closing the tab are deliberate, but the browser asks first (beforeunload) when there is something to lose. */
let noteTimer = 0;
function note(text, ms) { const c = $('notechip'); if (!c) return; c.textContent = text; c.hidden = false; clearTimeout(noteTimer); noteTimer = setTimeout(() => { c.hidden = true; }, ms || 4500); }
const editing = () => mode === 'edit' || mode === 'save' || mode === 'confirm';
const hasWork = () => mode === 'running' || (editing() && !!editor && (editor.dirty || mode !== 'edit'));
window.addEventListener('keydown', e => {
  if (e.key !== 'F5' || e.ctrlKey || e.metaKey || e.altKey || !(mode === 'running' || editing())) return;
  e.preventDefault(); e.stopPropagation();
  note('F5 已攔下：重新整理會' + (mode === 'running' ? '中斷程式' : '丟掉編輯中的內容') + '。要重新整理請按 Ctrl+R');
}, true);
window.addEventListener('beforeunload', e => {
  if (machine && machine.vfs) machine.vfs.persist();
  if (flashSaveTimer) { clearTimeout(flashSaveTimer); flashSaveTimer = 0; persistFlash(); }               // a save game written into the image a moment ago
  if (hasWork()) { e.preventDefault(); e.returnValue = ''; }
});

/* ---------------------------------------------------------------- boot */
renderSide();
drawMenu();
applyIme(); $('imebtn').onclick = toggleIme;
setStatus('', '尚未選擇資料夾');
window.__gvb = { render, dev, mount, route, textAct, get machine() { return machine; }, get flash() { return flashes.length ? flashes[0].img : null; }, get flashes() { return flashes; }, get editor() { return editor; }, get mode() { return mode; }, get path() { return path; }, get entries() { return entries; }, get sel() { return sel; }, FS };
})();
