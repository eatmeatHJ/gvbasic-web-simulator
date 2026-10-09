// LHA -lh5- decoder (8 KB window), written from the published algorithm (Okumura's ar002). Used only to read the archive of a downloaded program; nothing is executed.
const NC = 510, NP = 14, NT = 19, CBIT = 9, TBIT = 5, PBIT = 4, THRESHOLD = 3, TB = 12;

function makeDecoder(lens, n) {
  const count = new Int32Array(17);
  for (let i = 0; i < n; i++) count[lens[i]]++;
  count[0] = 0;
  const first = new Int32Array(17), index = new Int32Array(17); let code = 0, idx = 0;
  for (let l = 1; l <= 16; l++) { first[l] = code; index[l] = idx; idx += count[l]; code = (code + count[l]) << 1; }
  const symbols = new Int32Array(idx), fill = new Int32Array(17), table = new Int32Array(1 << TB);
  for (let i = 0; i < n; i++) {
    const l = lens[i]; if (!l) continue;
    const rank = fill[l]++; symbols[index[l] + rank] = i;
    if (l <= TB) { const c = first[l] + rank, lo = c << (TB - l), hi = (c + 1) << (TB - l); const e = (l << 16) | i; for (let k = lo; k < hi; k++) table[k] = e; }
  }
  return { count, first, index, symbols, table, single: undefined };
}

function lh5(buf, start, origSize) {
  const out = new Uint8Array(origSize);
  let pos = start, acc = 0, nb = 0;
  const fillbits = () => { while (nb <= 23) { acc = (acc << 8) | (pos < buf.length ? buf[pos] : 0); pos++; nb += 8; } };
  const get = n => { if (n === 0) return 0; if (nb < n) fillbits(); const v = (acc >>> (nb - n)) & ((1 << n) - 1); nb -= n; return v; };
  const peek = n => { if (nb < n) fillbits(); return (acc >>> (nb - n)) & ((1 << n) - 1); };
  function decodeSym(d) {
    if (d.single !== undefined) return d.single;
    if (nb < 16) fillbits();
    const e = d.table[(acc >>> (nb - TB)) & ((1 << TB) - 1)];
    if (e) { nb -= e >> 16; return e & 0xFFFF; }
    const p16 = (acc >>> (nb - 16)) & 0xFFFF;
    for (let l = TB + 1; l <= 16; l++) {
      const c = (p16 >>> (16 - l)) - d.first[l];
      if (c >= 0 && c < d.count[l]) { nb -= l; return d.symbols[d.index[l] + c]; }
    }
    throw new Error('bad code at input offset ' + pos);
  }
  function readPtLen(nn, nbit, special) {
    const n = get(nbit);
    if (n === 0) return { single: get(nbit) };
    const lens = new Uint8Array(nn); let i = 0;
    while (i < n) {
      let c = get(3);
      if (c === 7) { while (get(1)) c++; }
      lens[i++] = c;
      if (i === special) { let z = get(2); while (z-- > 0) lens[i++] = 0; }
    }
    return makeDecoder(lens, nn);
  }
  function readCLen(ptd) {
    const n = get(CBIT);
    if (n === 0) return { single: get(CBIT) };
    const lens = new Uint8Array(NC); let i = 0;
    while (i < n) {
      let c = decodeSym(ptd);
      if (c <= 2) {
        if (c === 0) c = 1; else if (c === 1) c = get(4) + 3; else c = get(CBIT) + 20;
        while (c-- > 0) lens[i++] = 0;
      } else lens[i++] = c - 2;
    }
    return makeDecoder(lens, NC);
  }
  let op = 0, blocksize = 0, cdec = null, pdec = null;
  while (op < origSize) {
    if (blocksize === 0) {
      blocksize = get(16);
      const ptd = readPtLen(NT, TBIT, 3);
      cdec = readCLen(ptd);
      pdec = readPtLen(NP, PBIT, -1);
    }
    blocksize--;
    const c = decodeSym(cdec);
    if (c < 256) out[op++] = c;
    else {
      const len = c - 256 + THRESHOLD;
      let j = decodeSym(pdec); if (j !== 0) j = (1 << (j - 1)) + get(j - 1);
      let src = op - j - 1;
      for (let k = 0; k < len && op < origSize; k++, src++) out[op++] = src >= 0 ? out[src] : 0;
    }
  }
  return out;
}
module.exports = { lh5 };
