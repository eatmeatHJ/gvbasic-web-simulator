/* Text -> .BAS: the line-numbered listing form of a GVBASIC program ("10 PRINT "HI"") turned into the tokenised file the device keeps.
 * Used by tools/txt2bas.js and by the page (a .txt next to the programs can be run or saved as .BAS).
 *   - the text may be UTF-8 or GBK (Big5 is tried when GBK gives garbage); a BOM, CRLF, a trailing Ctrl-Z are tolerated
 *   - non-ASCII characters are encoded in the target character set: Big5 (Taiwan models, this project's default) or GBK (mainland models);
 *     'auto' uses Big5 when every character exists there (traditional text), otherwise GBK (simplified text)
 *   - {FA48}: four hex digits in braces are a device code written as is (how this project's own listings show pictograms)
 *   - all errors are collected, not just the first; characters that do not exist in the target set are reported, never dropped silently */
(function (root) {
'use strict';
const GV = (typeof module !== 'undefined' && module.exports) ? require('./gvb.js') : root.GVB;

const LINE_RE = /^\s*(\d+)\s?([\s\S]*)$/;

/* bytes of a text file -> { text, encoding } */
function decodeText(bytes) {
  let b = bytes; if (b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) b = b.subarray(3);
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(b), encoding: 'utf-8' }; } catch (e) { /* not UTF-8 */ }
  const gbk = new TextDecoder('gbk').decode(b), bad = (gbk.match(/�/g) || []).length;
  if (!bad) return { text: gbk, encoding: 'gbk' };
  const big5 = new TextDecoder('big5').decode(b);
  return (big5.match(/�/g) || []).length < bad ? { text: big5, encoding: 'big5' } : { text: gbk, encoding: 'gbk' };
}

/* does this text look like a program listing? (most non-empty lines start with a line number) */
function looksLikeProgram(text) {
  const lines = text.replace(/\r/g, '').split('\n').filter(l => l.trim() !== '' && l !== '\x1a');
  if (lines.length < 3) return false;
  return lines.filter(l => /^\s*\d{1,4}(\s|$)/.test(l)).length >= lines.length * 0.8;
}

/* text -> { bytes, charset, lines, errors: [{line, no, msg}], warnings: [{no, msg}] }
 * opts: { charset: 'auto' | 'big5' | 'gbk', base: pointer base of the file (default $7000, the NC3000),
 *         ext: true = also accept the arucil simulator's own words (result.ext = true, result.extUsed lists them; the bytes only run in this emulator),
 *              'auto' = device language first, the simulator's words only if they are the only problem } */
function convertText(text, opts) {
  opts = opts || {};
  const r = convertOnce(text, Object.assign({}, opts, { ext: opts.ext === true }));
  if (opts.ext === 'auto' && r.errors.length && r.errors.every(e => e.sim)) {      // only the simulator's own words stand in the way: convert them to in-memory tokens, to run here
    const r2 = convertOnce(text, Object.assign({}, opts, { ext: true }));
    if (!r2.errors.length) return r2;
  }
  return r;
}
function convertOnce(text, opts) {
  const errors = [], warnings = [], ext = !!opts.ext, extUsed = [];
  const src = text.replace(/\r/g, '').replace(/\x1a/g, '').split('\n');
  // pass 1: choose the character set
  const chars = new Set(); for (const ch of text) if (ch.codePointAt(0) >= 128) chars.add(ch);
  let cs = opts.charset || 'auto';
  if (cs === 'auto') {                                  // private-use characters are what a GBK decoder makes of the mainland models' own pictures
    const big5 = GV.charsetReverse('big5'), pua = ch => { const c = ch.codePointAt(0); return c >= 0xE000 && c <= 0xF8FF; };
    cs = [...chars].some(pua) ? 'gbk' : [...chars].every(ch => big5.has(ch)) ? 'big5' : 'gbk';
  }
  const rev = GV.charsetReverse(cs), lead = cs === 'gbk' ? 0x80 : 160;
  const missing = new Map();
  const encode = (s, no) => {                           // Unicode text -> the device's byte string
    let out = '';
    for (const part of s.split(/(\{[0-9A-Fa-f]{4}\})/)) {
      const m = /^\{([0-9A-Fa-f]{4})\}$/.exec(part), v = m ? parseInt(m[1], 16) : 0;
      if (m && (v >> 8) >= 0x81) { out += String.fromCharCode(v >> 8, v & 255); continue; }      // a device code written as {FA48}
      for (const ch of part) {
        if (ch.codePointAt(0) < 128) out += ch;
        else if (rev.has(ch)) out += rev.get(ch);
        else { out += '?'; if (!missing.has(ch)) missing.set(ch, no); }
      }
    }
    return out;
  };
  // pass 2: lines
  const byNo = new Map();
  src.forEach((raw, li) => {
    if (raw.trim() === '') return;
    const m = LINE_RE.exec(raw);
    if (!m) { errors.push({ line: li + 1, msg: 'no line number: ' + raw.slice(0, 40) }); return; }
    const no = parseInt(m[1], 10);
    if (no > 9999) { errors.push({ line: li + 1, no, msg: 'line number above 9999' }); return; }
    if (m[2].trim() === '') { byNo.delete(no); return; }
    let body;
    const lower = [], suspect = [];
    try { body = GV.tokenizeBody(encode(m[2], no), lead, { lower, suspect, ext, extUsed }); } catch (e) { errors.push({ line: li + 1, no, msg: e.message, sim: !!e.sim }); return; }
    if (suspect.length) warnings.push({ no, msg: [...new Set(suspect)].join(', ') + '( is a function of the arucil simulator; in a device program it is an array with that name' });
    if (lower.length) warnings.push({ no, msg: 'lowercase name ' + [...new Set(lower)].join(', ') + ': the device answers SYNTAX ERROR to lowercase variable names, written here in capitals' });
    byNo.set(no, { no, body });
  });
  for (const [ch, no] of missing) warnings.push({ no, msg: 'character ' + ch + ' (U+' + ch.codePointAt(0).toString(16).toUpperCase() + ') does not exist in ' + cs.toUpperCase() + ', written as ?' });
  if (!byNo.size && !errors.length) errors.push({ line: 0, msg: 'no program lines' });
  if (errors.length) return { errors, warnings, charset: cs };
  const lines = [...byNo.values()].sort((a, b) => a.no - b.no);
  const bytes = GV.buildBas(lines, opts.base === undefined ? 0x7000 : opts.base);
  try {                                                  // statements the interpreter cannot run (same check as the editor)
    const prog = GV.compileProgram(GV.parseBas(bytes), { ext });
    for (const l of prog.lines) for (const ins of l.code) if (ins.op === 'error' || ins.op === 'unsupported') warnings.push({ no: l.no, msg: ins.msg || ('unsupported ' + ins.name) });
  } catch (e) { warnings.push({ no: 0, msg: e.message }); }
  return { bytes, charset: cs, lines: lines.length, errors, warnings, ext: extUsed.length > 0, extUsed };
}

/* A .BAS as a text file that convertText turns back into the same program: the listing (one program line per line, `{FA48}` for device pictograms), UTF-8 with a BOM and CRLF line ends, which every
 * editor reads whatever the Chinese in it is (Big5 or GBK). charset: the character set of the file's text (found out from the text when not given). -> { text, bytes } */
function basToText(bytes, charset) {
  const text = GV.listProgram(bytes, charset).replace(/\r?\n/g, '\r\n');
  const body = new TextEncoder().encode(text), out = new Uint8Array(3 + body.length);
  out.set([0xEF, 0xBB, 0xBF]); out.set(body, 3);
  return { text, bytes: out };
}

const api = { decodeText, looksLikeProgram, convertText, basToText };
if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.TXT2BAS = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
