/* A small 6502 assembler, for tests and for writing demo programs.
 *   LABEL:           NAME = $1234         .org $2000        .byte 1,2,"text"      .word label
 *   LDA #$12   LDA $12   LDA $1234,X   LDA ($12),Y   LDA ($12,X)   JMP ($1234)   ASL A   BNE label
 *   INT $8A2E        the device's 3-byte system call (00 8A 2E)
 * Numbers: $hex, %binary, decimal, 'c'.  Expressions: terms joined by + and -, with < (low byte) and > (high byte).
 * assemble(src) -> { segments: [{addr, bytes}], symbols } ;  flat(result) -> Uint8Array from the lowest address (and its address) */
(function (root) {
'use strict';
const { SPEC } = (typeof module !== 'undefined' && module.exports) ? require('./cpu6502.js') : { SPEC: root.CPU6502_SPEC };

const BRANCH = new Set(['BCC', 'BCS', 'BEQ', 'BMI', 'BNE', 'BPL', 'BVC', 'BVS']);
const IMPLIED_OK = op => SPEC[op] && SPEC[op].imp !== undefined;

function assemble(src) {
  const symbols = {}; const lines = [];
  const raw = src.split(/\r?\n/);
  const evalExpr = (s, pass2, ln) => {
    s = s.trim(); let total = 0, sign = 1, i = 0, known = true;
    const re = /\s*([+-])?\s*([<>])?\s*(\$[0-9A-Fa-f]+|%[01]+|\d+|'.'|[A-Za-z_][\w]*|\*)/y;
    if (!s) throw new Error('missing operand');
    for (let m; i < s.length && (m = (re.lastIndex = i, re.exec(s))); i = re.lastIndex) {
      const t = m[3]; let v;
      if (t[0] === '$') v = parseInt(t.slice(1), 16); else if (t[0] === '%') v = parseInt(t.slice(1), 2);
      else if (t[0] === "'") v = t.charCodeAt(1); else if (/^\d/.test(t)) v = parseInt(t, 10);
      else if (t === '*') v = ln.pc;
      else if (t in symbols) v = symbols[t]; else { known = false; v = 0; if (pass2) throw new Error('unknown symbol ' + t); }
      if (m[2] === '<') v &= 0xFF; if (m[2] === '>') v = (v >> 8) & 0xFF;
      total += (m[1] === '-' ? -1 : 1) * v;
    }
    if (i < s.length) throw new Error('cannot read expression "' + s + '"');
    return { v: total, known };
  };
  // ---- pass 1: parse lines, decide sizes, define labels
  let pc = 0x2000;
  raw.forEach((text, n) => {
    let t = text.replace(/("[^"]*")|;.*$/g, (m, s) => s || '').trim();
    if (!t) return;
    let m;
    while ((m = /^([A-Za-z_]\w*):\s*(.*)$/.exec(t))) { symbols[m[1]] = pc; t = m[2].trim(); }
    if (!t) return;
    const ln = { text, n: n + 1, pc };
    if ((m = /^([A-Za-z_]\w*)\s*=\s*(.+)$/.exec(t))) { symbols[m[1]] = evalExpr(m[2], false, ln).v; return; }
    if ((m = /^\.org\s+(.+)$/i.exec(t))) { pc = evalExpr(m[1], false, ln).v; ln.org = pc; lines.push(ln); return; }
    if ((m = /^\.(byte|word|str)\s+(.+)$/i.exec(t))) {
      ln.dir = m[1].toLowerCase(); ln.arg = m[2];
      const items = m[2].match(/"[^"]*"|[^,]+/g).map(x => x.trim());
      ln.items = items;
      ln.size = items.reduce((s, it) => s + (it[0] === '"' ? it.length - 2 : ln.dir === 'word' ? 2 : 1), 0);
      pc += ln.size; lines.push(ln); return;
    }
    m = /^([A-Za-z]{3})\b\s*(.*)$/.exec(t);
    if (!m) throw new Error('line ' + (n + 1) + ': cannot read "' + t + '"');
    const op = m[1].toUpperCase(), arg = m[2].trim();
    ln.op = op; ln.arg = arg;
    if (op === 'INT') { ln.mode = 'int'; ln.size = 3; }
    else {
      if (!SPEC[op]) throw new Error('line ' + (n + 1) + ': unknown mnemonic ' + op);
      let mode, e = null;
      if (arg === '') mode = IMPLIED_OK(op) ? 'imp' : null;
      else if (/^A$/i.test(arg) && SPEC[op].acc !== undefined) mode = 'acc';
      else if (arg[0] === '#') { mode = 'imm'; ln.expr = arg.slice(1); }
      else if ((m = /^\((.+),\s*X\)$/i.exec(arg))) { mode = 'indx'; ln.expr = m[1]; }
      else if ((m = /^\((.+)\),\s*Y$/i.exec(arg))) { mode = 'indy'; ln.expr = m[1]; }
      else if ((m = /^\((.+)\)$/.exec(arg))) { mode = 'ind'; ln.expr = m[1]; }
      else {
        let idx = '', ex = arg;
        if ((m = /^(.+),\s*([XY])$/i.exec(arg))) { ex = m[1]; idx = m[2].toLowerCase(); }
        ln.expr = ex;
        if (BRANCH.has(op)) mode = 'rel';
        else {
          e = evalExpr(ex, false, ln);
          const zpm = 'zp' + idx, abm = 'ab' + (idx || 's').replace('s', 's');
          const absMode = idx ? 'ab' + idx : 'abs';
          mode = (e.known && e.v >= 0 && e.v < 256 && SPEC[op][idx ? 'zp' + idx : 'zp'] !== undefined) ? (idx ? 'zp' + idx : 'zp') : absMode;
        }
      }
      if (!mode || SPEC[op][mode] === undefined) throw new Error('line ' + (n + 1) + ': ' + op + ' does not take "' + arg + '"');
      ln.mode = mode;
      ln.size = { imp: 1, acc: 1, imm: 2, zp: 2, zpx: 2, zpy: 2, abs: 3, abx: 3, aby: 3, ind: 3, indx: 2, indy: 2, rel: 2 }[mode];
    }
    pc += ln.size; lines.push(ln);
  });
  // ---- pass 2: emit
  const segments = []; let cur = null;
  const emit = (addr, b) => { if (!cur || cur.addr + cur.bytes.length !== addr) { cur = { addr, bytes: [] }; segments.push(cur); } cur.bytes.push(...b); };
  let at = 0x2000;
  for (const ln of lines) {
    try {
      if (ln.org !== undefined) { at = ln.org; cur = null; continue; }
      if (ln.dir) {
        const out = [];
        for (const it of ln.items) {
          if (it[0] === '"') for (const ch of it.slice(1, -1)) out.push(ch.charCodeAt(0));
          else { const v = evalExpr(it, true, ln).v; if (ln.dir === 'word') out.push(v & 0xFF, (v >> 8) & 0xFF); else out.push(v & 0xFF); }
        }
        emit(at, out); at += out.length; continue;
      }
      ln.pc = at;
      if (ln.mode === 'int') { const v = evalExpr(ln.arg, true, ln).v; emit(at, [0x00, (v >> 8) & 0xFF, v & 0xFF]); at += 3; continue; }
      const opcode = SPEC[ln.op][ln.mode];
      if (ln.mode === 'imp' || ln.mode === 'acc') { emit(at, [opcode]); at += 1; continue; }
      const v = evalExpr(ln.expr, true, ln).v;
      if (ln.mode === 'rel') {
        const off = v - (at + 2);
        if (off < -128 || off > 127) throw new Error('branch out of range');
        emit(at, [opcode, off & 0xFF]); at += 2;
      } else if (ln.size === 2) {
        if (ln.mode === 'imm' ? (v < -128 || v > 255) : (v < 0 || v > 255)) throw new Error('value ' + v + ' does not fit in a byte');
        emit(at, [opcode, v & 0xFF]); at += 2;
      } else { emit(at, [opcode, v & 0xFF, (v >> 8) & 0xFF]); at += 3; }
    } catch (e) { throw new Error('line ' + ln.n + ' (' + ln.text.trim() + '): ' + e.message); }
  }
  return { segments: segments.map(s => ({ addr: s.addr, bytes: Uint8Array.from(s.bytes) })), symbols };
}

function flat(res) {   // one contiguous block from the lowest address to the highest used one
  const lo = Math.min(...res.segments.map(s => s.addr)), hi = Math.max(...res.segments.map(s => s.addr + s.bytes.length));
  const out = new Uint8Array(hi - lo); for (const s of res.segments) out.set(s.bytes, s.addr - lo);
  return { addr: lo, bytes: out };
}

const api = { assemble, flat };
if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.ASM6502 = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
