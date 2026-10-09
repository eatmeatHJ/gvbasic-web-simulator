/* The device's own bitmap fonts (data from arucil/gvbasic-simulator4cpp res/, MIT, see ref/arucil/LICENSE; they come from the machine's ROM):
 *   gb16     16 x 16 GB2312 characters, 32 bytes each (rows of 2 bytes, leftmost pixel = top bit of the first byte)
 *   gb12     12 x 12 GB2312 characters, 24 bytes each (rows of 2 bytes, the top 12 bits are the row)
 *   ascii12  6 x 12 ASCII, 12 bytes each (1 byte per row, the top 6 bits)
 *   pic16    the machine's own 16 x 16 pictures behind GB codes $F8A1-$FDD9 (527 of them; the mainland models' symbols, portraits and map tiles)
 * Only for the GBK / GB2312 side: the Big5 (Taiwan) machines have their own fonts, which we do not have.
 * Index of a GB2312 character: rows $A1-$A9 are symbols, rows $AA-$AF do not exist (arucil closes the gap), then $B0.. are the hanzi. */
(function (root) {
'use strict';
const node = typeof module !== 'undefined' && module.exports;
const FONTS = node ? require('./fonts.js') : root.GVB_FONTS;
const decode = b64 => node ? Uint8Array.from(Buffer.from(b64, 'base64')) : Uint8Array.from(atob(b64), c => c.charCodeAt(0));
const cache = {};
const data = name => cache[name] || (cache[name] = FONTS ? decode(FONTS[name]) : new Uint8Array(0));

const index = (lead, trail) => {
  if (lead < 0xA1 || lead > 0xF7 || trail < 0xA1 || trail > 0xFE) return -1;
  let r = lead - 0xA1; if (r > 8) r -= 6;
  return r * 94 + (trail - 0xA1);
};
const slice = (name, i, size) => { const d = data(name); if (i < 0 || (i + 1) * size > d.length) return null; const g = d.subarray(i * size, (i + 1) * size); return g; };
const blank = g => { for (let i = 0; i < g.length; i++) if (g[i]) return false; return true; };

/* the bytes of a glyph, or null when the font has none (then the caller falls back to a system font) */
function glyph16(lead, trail) { const g = slice('gb16', index(lead, trail), 32); return g && (!blank(g) || (lead === 0xA1 && trail === 0xA1)) ? g : null; }
function glyph12(lead, trail) { const g = slice('gb12', index(lead, trail), 24); return g && (!blank(g) || (lead === 0xA1 && trail === 0xA1)) ? g : null; }
function ascii12(code) { return code >= 0 && code < 256 ? slice('ascii12', code, 12) : null; }
function picture16(lead, trail) {
  if (lead < 0xF8 || lead > 0xFD || trail < 0xA1 || trail > 0xFE) return null;
  const g = slice('pic16', (lead - 0xF8) * 94 + (trail - 0xA1), 32); return g && !blank(g) ? g : null;
}
/* The Big5 machines (Taiwan) draw their own pictograms at FA40 and up; the 527 pictures are the same ones the GB codes F8A1-FDD9 reach, in the same order. Two numberings of
 * them turn up in programs (the number of a picture = k):
 *   'a'  FA40 is the first picture, only real Big5 codes: second byte 40-7E, then A1-FE, 157 per row. Seen: the four card suits at FA47 FA48 FA49 FAAD, the arrows at FA50 (up)
 *        FA52 (down) FA53 (right) FA54 (left), the building pictures of a map game around FC63-FC69, and the programs' highest code FD76 is the last picture.
 *   'b'  FA46 is the first picture and the number simply counts up (no gaps for second bytes 7F-A0): the arrows are at FA56 FA58 FA59 FA5A (the four directions of a push-box program,
 *        and the up / down keys of a music editor), FA46 is the "?" an RPG engine uses for an ordinary item, and the engine's item table holds codes like FB04 or FC1C, which no real
 *        Big5 or GBK code is.
 * Which numbering a machine model uses is not known; the page chooses by what the program's codes can mean (detectPictoFamily in gvb.js) and the user can override. */
function pictogramIndex(code, fam) {
  const lead = code >> 8, trail = code & 255;
  if (fam === 'b') return code - 0xFA46;
  if (lead < 0xFA || trail < 0x40 || trail === 0x7F || (trail > 0x7E && trail < 0xA1) || trail === 0xFF) return -1;
  return (lead - 0xFA) * 157 + (trail <= 0x7E ? trail - 0x40 : 63 + trail - 0xA1);
}
function pictogram16(code, fam) {
  const k = pictogramIndex(code, fam);
  if (k < 0 || k >= 564) return null;
  const g = slice('pic16', k, 32); return g && !blank(g) ? g : null;
}
/* bit pictures: width x height array of 0 / 1, the form the page's glyph code uses */
function bits(g, w, h) { const o = new Uint8Array(w * h), bw = (w + 7) >> 3; for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) o[y * w + x] = (g[y * bw + (x >> 3)] >> (7 - (x & 7))) & 1; return o; }

/* For tests and tools that run without a page: a dev.stampCell that paints the text cells of a Device into its bitmap with the device fonts only (ASCII 8x16, GB2312 16x16 and the pictures
 * when the screen is GBK; anything else becomes a solid 16x16 block). The page has its own, which also knows system fonts. */
function makeStamper(dev) {
  const A = node ? Uint8Array.from(Buffer.from(require('./font.js'), 'base64')) : Uint8Array.from(atob(root.GVB_ASCII16), c => c.charCodeAt(0));
  return (r, c) => {
    const t = dev.text, b = t[r * 20 + c], put = (bitsArr, w, col) => { for (let y = 0; y < 16; y++) for (let x = 0; x < w; x++) dev.gfx[(r * 16 + y) * 160 + col * 8 + x] = bitsArr[y * w + x]; return w >> 3; };
    if (!b) return 0;
    if (b > dev.lead && c < 19) {
      const lo = t[r * 20 + c + 1];
      const g = dev.charset === 'gbk' ? (picture16(b, lo) || glyph16(b, lo)) : null;
      return put(g ? bits(g, 16, 16) : new Uint8Array(256).fill(1), 16, c);
    }
    if (b > dev.lead) return 1;
    const o = (b < 160 ? b : 63) * 16, g = new Uint8Array(128);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 8; x++) g[y * 8 + x] = (A[o + y] >> (7 - x)) & 1;
    return put(g, 8, c);
  };
}

const api = { glyph16, glyph12, ascii12, picture16, pictogram16, pictogramIndex, bits, index, makeStamper };
if (node) module.exports = api; else root.LCDFONT = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
