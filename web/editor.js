/* Line editor of the GVBASIC editing screen (20 x 5 text grid), independent of the page.
 *   - text is kept as device byte strings (double-byte characters are two bytes, one cell each)
 *   - lines that were not touched are written back with their original bytes
 *   - touched lines are re-tokenised from their text
 * Keys (like the real editor): arrows move, Enter adds the next line (number + 10) or moves down,
 * Backspace/Delete remove, Esc finishes editing (the caller then asks for the file name). */
(function (root) {
'use strict';
const GV = (typeof module !== 'undefined' && module.exports) ? require('./gvb.js') : root.GVB;
const WIDTH = 20, HEIGHT = 5, MAX_LINE = 250;

/* lead: bytes above it start a double-byte character: 160 for Big5 (and GB2312), 0x80 for GBK, whose extension area starts lower - the editor works in the character set of the file it edits */
const isLead = (s, i, lead = 160) => s.charCodeAt(i) > lead && i + 1 < s.length;
function charStarts(s, lead) { const a = []; for (let i = 0; i < s.length; i += isLead(s, i, lead) ? 2 : 1) a.push(i); return a; }
function snap(s, idx, lead) { // never leave the cursor in the middle of a double-byte character
  if (idx >= s.length) return s.length;
  let last = 0; for (const p of charStarts(s, lead)) { if (p > idx) break; last = p; } return last;
}
function wrap(text, lead) { // -> [{start, text}] rows of at most 20 columns, double-byte characters are never split
  const rows = []; let start = 0, w = 0, cur = '';
  for (let i = 0; i < text.length;) {
    const dbl = isLead(text, i, lead), cw = dbl ? 2 : 1;
    if (w + cw > WIDTH) { rows.push({ start, text: cur }); start = i; cur = ''; w = 0; }
    cur += dbl ? text.slice(i, i + 2) : text[i]; w += cw; i += cw;
  }
  rows.push({ start, text: cur });
  return rows;
}
const LINE_RE = /^\s*(\d+)\s?([\s\S]*)$/;

class LineEditor {
  /* opts: { name, bytes, charset, ext }   bytes = existing .BAS (omit for a new program); ext = accept the simulator's own words (SLEEP, PAINT ...), on by itself for a .BAS that already has some; charset = 'big5' | 'gbk': how the text of the file is encoded - found out from the file's text when not given (a new program: Big5) */
  constructor(opts) {
    opts = opts || {};
    this.name = opts.name || '';
    this.insert = true; this.msg = ''; this.dirty = false; this.top = 0;
    this.cs = opts.charset || 'big5'; this.ext = !!opts.ext;
    if (opts.bytes) {
      const ls = GV.parseBas(opts.bytes);
      if (GV.extWordsIn(ls).length) this.ext = true;
      if (!opts.charset) this.cs = GV.detectCharset(ls);
      this.base = ls.base;
      this.lines = ls.map(l => { const text = l.no + ' ' + GV.listLineBytes(l.body); return { text, orig: l.body, origText: text }; });
    } else { this.base = 0x7000; this.lines = []; }
    this.lead = this.cs === 'gbk' ? 0x80 : 160;
    if (!this.lines.length) { this.lines.push({ text: '10 ', orig: null, origText: null }); this.cur = 0; this.idx = 3; }
    else { this.cur = 0; this.idx = 0; }
  }

  get line() { return this.lines[this.cur]; }

  layout() {
    const rows = []; let cursorRow = 0, cursorCol = 0;
    this.lines.forEach((ln, li) => {
      const rs = wrap(ln.text, this.lead);
      if (li === this.cur && this.idx === ln.text.length && rs[rs.length - 1].text.length >= WIDTH) rs.push({ start: ln.text.length, text: '' });
      let placed = false;
      rs.forEach((r, k) => {
        if (li === this.cur && !placed && (this.idx < r.start + r.text.length || k === rs.length - 1)) {
          placed = true; cursorRow = rows.length; cursorCol = this.idx - r.start;
        }
        rows.push({ li, start: r.start, text: r.text });
      });
    });
    return { rows, cursorRow, cursorCol };
  }

  /* what the LCD shows: five rows (byte strings) and the cursor cell */
  view() {
    const { rows, cursorRow, cursorCol } = this.layout();
    if (cursorRow < this.top) this.top = cursorRow;
    if (cursorRow >= this.top + HEIGHT) this.top = cursorRow - HEIGHT + 1;
    this.top = Math.max(0, Math.min(this.top, Math.max(0, rows.length - HEIGHT)));
    if (cursorRow >= this.top + HEIGHT) this.top = cursorRow - HEIGHT + 1;
    const out = [];
    for (let i = 0; i < HEIGHT; i++) out.push(rows[this.top + i] ? rows[this.top + i].text : '');
    return { rows: out, cx: Math.min(cursorCol, WIDTH - 1), cy: cursorRow - this.top, insert: this.insert };
  }

  /* leaving a line: re-format it the way the device would (upper case, keyword spacing) and check it */
  finalize(li) {
    const ln = this.lines[li]; if (!ln || ln.text === ln.origText) return true;
    const t = ln.text;
    if (t.trim() === '') return true;
    const m = LINE_RE.exec(t);
    if (!m || parseInt(m[1], 10) > 9999) { this.msg = 'Line number error'; return false; }
    try { ln.text = String(parseInt(m[1], 10)) + ' ' + GV.listLineBytes(GV.tokenizeBody(m[2], this.lead, this.ext ? { ext: true } : undefined)); }
    catch (e) { this.msg = e.message; return false; }
    return true;
  }
  moveTo(li, idx) {
    if (li !== this.cur && !this.finalize(this.cur)) return false;
    this.cur = li; this.idx = snap(this.lines[li].text, idx, this.lead); return true;
  }
  lineNo(ln) { const m = LINE_RE.exec(ln.text); return m ? parseInt(m[1], 10) : NaN; }
  sortLines() {
    if (this.lines.some(l => Number.isNaN(this.lineNo(l)))) return;
    const keep = this.line;
    this.lines = this.lines.map((l, i) => [l, i]).sort((a, b) => (this.lineNo(a[0]) - this.lineNo(b[0])) || (a[1] - b[1])).map(x => x[0]);
    this.cur = this.lines.indexOf(keep);
  }

  /* act: up down left right enter backspace delete home end pageup pagedown insert char (with ch = 1 or 2 byte string) */
  key(act, ch) {
    this.msg = '';
    const ln = this.line;
    switch (act) {
      case 'left':
        if (this.idx > 0) { const s = charStarts(ln.text, this.lead); this.idx = s[s.indexOf(snap(ln.text, this.idx - 1, this.lead))]; }
        else if (this.cur > 0) this.moveTo(this.cur - 1, 1e9);
        break;
      case 'right':
        if (this.idx < ln.text.length) this.idx += isLead(ln.text, this.idx, this.lead) ? 2 : 1;
        else if (this.cur < this.lines.length - 1) this.moveTo(this.cur + 1, 0);
        break;
      case 'up': case 'down': case 'pageup': case 'pagedown': {
        const { rows, cursorRow, cursorCol } = this.layout();
        const d = act === 'up' ? -1 : act === 'down' ? 1 : act === 'pageup' ? -HEIGHT : HEIGHT;
        const r = Math.max(0, Math.min(rows.length - 1, cursorRow + d));
        if (r !== cursorRow) { const t = rows[r]; this.moveTo(t.li, t.start + Math.min(cursorCol, t.text.length)); }
        break;
      }
      case 'home': this.idx = 0; break;
      case 'end': this.idx = ln.text.length; break;
      case 'insert': this.insert = !this.insert; break;
      case 'enter': {
        if (!this.finalize(this.cur)) break;
        if (this.cur === this.lines.length - 1) {
          const n = this.lineNo(this.line);
          if (Number.isNaN(n)) { if (this.line.text.trim() === '') break; this.msg = 'Line number error'; break; }
          this.lines.push({ text: Math.min(9999, n + 10) + ' ', orig: null, origText: null });
          this.cur = this.lines.length - 1; this.idx = this.line.text.length;
        } else { this.cur++; this.idx = 0; }
        this.sortLines();
        break;
      }
      case 'backspace':
        if (this.idx > 0) {
          const s = charStarts(ln.text, this.lead); const p = s[s.indexOf(snap(ln.text, this.idx - 1, this.lead))];
          ln.text = ln.text.slice(0, p) + ln.text.slice(this.idx); this.idx = p; this.dirty = true;
        } else if (ln.text === '' && this.lines.length > 1) this.removeLine();
        break;
      case 'delete':
        if (this.idx < ln.text.length) { ln.text = ln.text.slice(0, this.idx) + ln.text.slice(this.idx + (isLead(ln.text, this.idx, this.lead) ? 2 : 1)); this.dirty = true; }
        else if (ln.text === '' && this.lines.length > 1) this.removeLine();
        break;
      case 'char': {
        if (!ch) break;
        if (ln.text.length + ch.length > MAX_LINE) { this.msg = 'Line too long'; break; }
        const over = !this.insert && this.idx < ln.text.length;
        const cut = over ? (isLead(ln.text, this.idx, this.lead) ? 2 : 1) : 0;
        ln.text = ln.text.slice(0, this.idx) + ch + ln.text.slice(this.idx + cut);
        this.idx += ch.length; this.dirty = true;
        break;
      }
      default: break;
    }
  }
  removeLine() {
    this.lines.splice(this.cur, 1); this.dirty = true;
    if (this.cur >= this.lines.length) this.cur = this.lines.length - 1;
    this.idx = this.lines[this.cur].text.length;
  }

  /* -> { bytes, warnings }  or  { errors: [{ li, msg }] } */
  build() {
    const errors = [];
    const byNo = new Map();
    this.lines.forEach((ln, li) => {
      const t = ln.text;
      if (t.trim() === '') return;
      const m = LINE_RE.exec(t);
      const no = m ? parseInt(m[1], 10) : NaN;
      if (!m || no > 9999) { errors.push({ li, msg: 'Line number error' }); return; }
      if (m[2].trim() === '') { byNo.delete(no); return; }               // a bare number deletes that line
      let body;
      if (ln.orig && t === ln.origText) body = ln.orig;
      else { try { body = GV.tokenizeBody(m[2], this.lead, this.ext ? { ext: true } : undefined); } catch (e) { errors.push({ li, msg: e.message }); return; } }
      byNo.set(no, { no, body });
    });
    if (errors.length) return { errors };
    if (!byNo.size) return { errors: [{ li: 0, msg: 'Empty program' }] };
    const lines = [...byNo.values()].sort((a, b) => a.no - b.no);
    const bytes = GV.buildBas(lines, this.base);
    const warnings = [];
    try {
      const prog = GV.compileProgram(GV.parseBas(bytes));
      for (const l of prog.lines) for (const ins of l.code) if (ins.op === 'error' || ins.op === 'unsupported') warnings.push({ no: l.no, msg: ins.msg || ('unsupported ' + ins.name) });
    } catch (e) { warnings.push({ no: 0, msg: e.message }); }
    return { bytes, warnings };
  }
}

const api = { LineEditor, wrap, WIDTH, HEIGHT };
if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.GVBEdit = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
