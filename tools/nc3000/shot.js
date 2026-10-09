// write LCD frames (160x80, one byte per pixel) as a PNG contact sheet
'use strict';
const fs = require('fs'), zlib = require('zlib');
function crc32(buf) { let c, crc = 0xFFFFFFFF; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xFF; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xFFFFFFFF) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
function writePng(file, w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}
function sheet(file, frames, cols, scale) {
  scale = scale || 2; cols = cols || 2; const gap = 6, fw = 160 * scale, fh = 80 * scale, rows = Math.ceil(frames.length / cols);
  const W = cols * fw + (cols + 1) * gap, H = rows * fh + (rows + 1) * gap, rgb = Buffer.alloc(W * H * 3, 90);
  frames.forEach((f, i) => {
    const ox = gap + (i % cols) * (fw + gap), oy = gap + Math.floor(i / cols) * (fh + gap);
    for (let y = 0; y < 80; y++) for (let x = 0; x < 160; x++) {
      const c = f[y * 160 + x] ? [20, 30, 20] : [190, 205, 170];
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) { const p = ((oy + y * scale + dy) * W + ox + x * scale + dx) * 3; rgb[p] = c[0]; rgb[p + 1] = c[1]; rgb[p + 2] = c[2]; }
    }
  });
  writePng(file, W, H, rgb);
}
module.exports = { sheet, writePng };
