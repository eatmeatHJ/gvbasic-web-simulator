// NC3000 machine model for the real firmware: 6502 + RAM, NOR/NAND flash, bank registers, keypad matrix, interrupts.
// Written from the register-level notes of the WQXEmu project (bank layout, frame schedule) and completed by watching what the firmware does;
// nothing is copied from another emulator's source. No firmware is included here: pass in the NOR image (1 MB) and the NAND image (528-byte pages).
'use strict';
const { CPU6502 } = require('./cpu.js');

const ORDER = [0x4000, 0x6000, 0x0000, 0x2000];              // the four 8 KB pieces of a 32 KB NOR bank, in the order they appear at $4000 $6000 $8000 $A000
const SLICES = 1202, SLICE_CYCLES = 128, FRAME_RATE = 64;

class NC3000 {
  constructor(nor, nand, opts) {
    opts = opts || {};
    this.nor = new Uint8Array(nor);                              // 1 MB NOR, linear; writable copy
    this.nand = new Uint8Array(nand);                          // raw NAND, 528-byte pages (512 data + 16 spare); writable copy
    this.nandBase = (opts.nandBase === undefined ? 64 : opts.nandBase);   // the dump starts at the firmware's block 2 (row 64): the first two blocks are not in it
    this.ram = new Uint8Array(0x10000);
    this.io = new Uint8Array(0x40);
    this.ext = new Uint8Array(256);                            // RTC / extended registers reached through $3E (index) and $3F (data)
    this.bank = 0; this.bbs = 0; this.roa = 0;
    this.innerInt = 0;                                         // value last written to $01
    this.cpu = new CPU6502({ read: a => this.read(a), write: (a, v) => this.write(a, v) });
    const enter = this.cpu.interrupt.bind(this.cpu);
    this.cpu.interrupt = (vec, brk) => { if (vec === 0xFFFE && !brk) { this.ivLatched = this.ivQueue.length ? this.ivQueue.shift() : 0xF8; this.irqs++; } return enter(vec, brk); };
    this.irqs = 0; this.norSt = { cyc: 0, mode: 'read', status: false }; this.norLog = []; this.norSector = opts.norSector || 0x1000;
    this.log = opts.log || null; this.seen = new Set();
    this.framePhase = 0; this.frame = 0;
    this.nandState = { cmd: 0, addr: [], pos: 0, mode: 'idle', page: 0, col: 0, ctl: 0, buf: null, status: 0xC0 };
    this.keymat = new Uint8Array(8);                           // 8 columns of the matrix, bit r set = the key on row r is down
    this.ivQueue = []; this.ivLatched = 0xF8;                  // pending interrupt sources; $3D returns the one latched when the CPU took the IRQ ($F8 = none)
    this.timer = [0, 0]; this.timerOn = [false, false];
    this.trace = null;
    this.ioHits = new Map();
    this.reset();
  }
  reset() {
    this.ram.fill(0); this.io.fill(0); this.ext.fill(0); this.bank = 0; this.bbs = 0; this.roa = 0; this.innerInt = 0;
    this.ext[0x0A] = 0; this.ivQueue.length = 0;
    this.cpu.a = this.cpu.x = this.cpu.y = 0; this.cpu.reset();
  }
  // ---------------------------------------------------------------- memory
  norAt(off) { return this.nor[off & 0xFFFFF]; }
  read(a) {
    a &= 0xFFFF;
    if (a < 0x40) return this.ioRead(a);
    if (a < 0x4000) return this.ram[a];
    if (a < 0xC000) {
      const b = this.bank, j = (a - 0x4000) >> 13, o = a & 0x1FFF;
      if (this.roa && b < 2) return this.ram[((b === 0 ? 0 : 0x8000) + j * 0x2000 + o) & 0xFFFF];
      if (b === 0 && j < 2) return this.ram[a];                   // bank 0 without ROA: $4000-$7FFF is RAM
      return this.norRead((b & 31) * 0x8000 + ORDER[j] + o);
    }
    if (a < 0xE000) {
      const idx = this.bbs & 15, o = a & 0x1FFF;
      if (idx === 1) return this.ram[0x6000 + o];
      return this.nor[(idx >> 2) * 0x8000 + ORDER[idx & 3] + o];
    }
    return this.nor[0x6000 + (a & 0x1FFF)];
  }
  write(a, v) {
    a &= 0xFFFF; v &= 255;
    if (a < 0x40) { this.ioWrite(a, v); return; }
    if (a < 0x4000) { this.ram[a] = v; return; }
    if (a < 0xC000) {
      const b = this.bank, j = (a - 0x4000) >> 13, o = a & 0x1FFF;
      if (this.roa && b < 2) { this.ram[((b === 0 ? 0 : 0x8000) + j * 0x2000 + o) & 0xFFFF] = v; return; }
      if (b === 0 && j < 2) { this.ram[a] = v; return; }
      this.norWrite((b & 31) * 0x8000 + ORDER[j] + o, a, v); return;
    }
    if (a < 0xE000) { if ((this.bbs & 15) === 1) this.ram[0x6000 + (a & 0x1FFF)] = v; }
  }
  // NOR flash (AMD-style command set): the firmware keeps its file system header and user area in the last banks and programs them through the usual
  // $AA/$55/$A0 and $AA/$55/$80/$AA/$55/$30 sequences with the command addresses $5555 / $AAAA. Operations finish at once; the first read afterwards returns "done" status.
  norRead(off) { const st = this.norSt; if (st.status) { st.status = false; return 0xFF; } return this.nor[off]; }
  norWrite(off, a, v) {
    const st = this.norSt, low = a & 0xFFF;
    if (st.mode === 'prog') { this.nor[off] &= v; st.mode = 'read'; st.status = true; this.norLog.push('P' + off.toString(16)); return; }
    if (v === 0xF0) { st.cyc = 0; return; }
    switch (st.cyc) {
      case 0: if (low === 0x555 && v === 0xAA) st.cyc = 1; break;
      case 1: st.cyc = (low === 0xAAA && v === 0x55) ? 2 : 0; break;
      case 2: if (low === 0x555 && v === 0xA0) { st.mode = 'prog'; st.cyc = 0; } else if (low === 0x555 && v === 0x80) st.cyc = 3; else st.cyc = 0; break;
      case 3: st.cyc = (low === 0x555 && v === 0xAA) ? 4 : 0; break;
      case 4: st.cyc = (low === 0xAAA && v === 0x55) ? 5 : 0; break;
      case 5:
        if (v === 0x30) { const b0 = off & ~(this.norSector - 1); this.nor.fill(0xFF, b0, b0 + this.norSector); st.status = true; this.norLog.push('E' + off.toString(16)); }
        else if (v === 0x10 && low === 0x555) { this.nor.fill(0xFF); st.status = true; this.norLog.push('CHIP'); }
        st.cyc = 0; break;
    }
  }
  lcd() { return this.ram.subarray(0x19C0, 0x19C0 + 1600); }
  // ---------------------------------------------------------------- IO
  note(kind, a, v) {
    const k = kind + a.toString(16);
    this.ioHits.set(k, (this.ioHits.get(k) || 0) + 1);
    if (this.log && !this.seen.has(k)) { this.seen.add(k); this.log(kind + ' $' + a.toString(16).padStart(2, '0') + (v === undefined ? '' : ' = $' + v.toString(16).padStart(2, '0')) + '  pc=$' + this.cpu.pc.toString(16)); }
  }
  ioRead(a) {
    this.note('R', a);
    switch (a) {
      case 0x00: return this.bank;
      case 0x01: { const t = this.io[1]; this.io[1] &= 0xC0; this.updateIrq(); return t; }
      case 0x02: return ((this.cpu.cycles >> 8) + this.timer[0]) & 255;          // free-running counters: the firmware only needs them to be non-zero after the first moments (a warm reset keeps them running)
      case 0x03: return ((this.cpu.cycles >> 16) + this.timer[1]) & 255;
      case 0x04: this.timerOn[0] = false; return 0x02;
      case 0x05: this.timerOn[0] = true; return 0x02;
      case 0x06: this.timerOn[1] = false; return 0x03;
      case 0x07: this.timerOn[1] = true; return 0x03;
      case 0x08: return (~this.keyRows() | 0x0E) & 0xFF;
      case 0x0A: return this.io[0x0A];
      case 0x18: return this.io[0x18];
      case 0x1E: { const r = this.keyRows(); return (~(r >> 2) & 3); }
      case 0x39: return this.nandRead();
      case 0x3A: case 0x3B: case 0x3C: return this.io[a];
      case 0x3D: return this.ivLatched;
      case 0x3E: return this.io[0x3E];
      case 0x3F: return this.ext[this.io[0x3E]];
      default: return this.io[a];
    }
  }
  ioWrite(a, v) {
    this.note('W', a, v);
    this.io[a] = v;
    switch (a) {
      case 0x00: this.bank = v; break;
      case 0x02: this.timer[0] = v - (this.cpu.cycles >> 8); break;
      case 0x03: this.timer[1] = v - (this.cpu.cycles >> 16); break;
      case 0x01: this.innerInt = v; break;
      case 0x05: if (v === 0xFF) this.sleeping = true; break;                       // standby: the CPU stops until a key wakes the machine through its reset vector (RAM keeps its contents)
      case 0x0A: this.bbs = v & 15; this.roa = (v >> 7) & 1; break;
      case 0x18: this.nandCtl(v); break;
      case 0x39: this.nandWrite(v); break;
      case 0x3E: break;
      case 0x3F: this.ext[this.io[0x3E]] = v; break;
    }
  }
  // keypad: the firmware puts a one on a single bit of $09 (bit 7-c selects column c), then reads the rows back: rows 7,6,5,4 and 0 at $08 bits 7,6,5,4,0,
  // rows 3 and 2 at $1E bits 1 and 0; a pressed key reads as 0
  keyRows() { let r = 0; const sel = this.io[9]; for (let c = 0; c < 8; c++) if ((sel >> (7 - c)) & 1) r |= this.keymat[c]; return r; }
  key(col, row, down) { if (down) this.keymat[col] |= 1 << row; else this.keymat[col] &= ~(1 << row); }
  // ---------------------------------------------------------------- NAND (528-byte pages: 512 data + 16 spare, 32 pages per block)
  // address cycles: column byte, then the row (page number) in 2 or 3 bytes; erase takes the row bytes only. The page is worked out when the first data byte moves,
  // so it does not matter how many row cycles the firmware sends.
  nandCtl(v) { const s = this.nandState; s.ctl = v; }
  nandWrite(v) {
    const s = this.nandState, cle = (s.ctl >> 5) & 1, ale = (s.ctl >> 4) & 1, ce = (s.ctl >> 2) & 1;
    if (ce) return;
    if (cle) { this.nandCommand(v); return; }
    if (ale) { s.addr.push(v); return; }
    if (s.mode === 'programaddr') { this.nandResolve(); s.mode = 'program'; s.buf = new Uint8Array(528).fill(0xFF); }
    if (s.mode === 'program') { s.buf[s.pos++ % 528] = v; }
  }
  nandResolve() {
    const s = this.nandState, a = s.addr; let row = 0;
    for (let i = 1; i < a.length; i++) row |= a[i] << (8 * (i - 1));
    s.page = row; s.col = (a[0] || 0) + (s.area === 0x01 ? 256 : s.area === 0x50 ? 512 : 0); s.pos = s.col;
  }
  nandCommand(c) {
    const s = this.nandState;
    if (c === 0xFF) { s.mode = 'idle'; s.status = 0xC0; }
    else if (c === 0x90) { s.mode = 'id'; s.pos = 0; }
    else if (c === 0x70) { s.mode = 'status'; }
    else if (c === 0x00 || c === 0x01 || c === 0x50) { s.mode = 'readaddr'; s.area = c; s.addr = []; }
    else if (c === 0x80) { s.mode = 'programaddr'; s.area = 0; s.addr = []; }
    else if (c === 0x10) { if (s.mode === 'programaddr') { this.nandResolve(); s.buf = new Uint8Array(528).fill(0xFF); s.mode = 'program'; } if (s.mode === 'program') this.nandProgram(); s.mode = 'idle'; }
    else if (c === 0x60) { s.mode = 'eraseaddr'; s.addr = []; }
    else if (c === 0xD0) { if (s.mode === 'eraseaddr') this.nandErase(); s.mode = 'idle'; }
  }
  nandRead() {
    const s = this.nandState, ce = (s.ctl >> 2) & 1;
    if (ce) return 0xFF;
    if (s.mode === 'id') { const id = [0xEC, 0x76, 0xA5, 0xC0]; return id[s.pos++ % id.length]; }
    if (s.mode === 'status') return s.status;
    if (s.mode === 'readaddr') { this.nandResolve(); s.mode = 'read'; }
    if (s.mode === 'read') {
      const row = s.page, pg = row - this.nandBase, p = s.pos; s.pos++;
      if (s.pos >= 528) { s.pos = 0; s.page++; }                 // keep going into the next page if the firmware reads on
      if (pg < 0) return row === 1 && p < 10 ? 'ggv nc3000'.charCodeAt(p) : 0xFF;   // the first two blocks are not in the dump: blank apart from the signature page
      const off = pg * 528 + p; return off < this.nand.length ? this.nand[off] : 0xFF;
    }
    return 0xFF;
  }
  nandProgram() {
    const s = this.nandState, base = (s.page - this.nandBase) * 528; this.nandWrites = (this.nandWrites || 0) + 1;
    if (base >= 0 && base + 528 <= this.nand.length) for (let i = 0; i < 528; i++) this.nand[base + i] &= s.buf[i];
  }
  nandErase() {
    const s = this.nandState; let row = 0; for (let i = 0; i < s.addr.length; i++) row |= s.addr[i] << (8 * i);
    const base = ((row & ~31) - this.nandBase) * 528; this.nandErases = (this.nandErases || 0) + 1;
    if (base >= 0 && base + 32 * 528 <= this.nand.length) this.nand.fill(0xFF, base, base + 32 * 528);
  }
  // ---------------------------------------------------------------- time
  /* one frame = 1/64 s: 1202 slices of 128 cycles */
  runFrame() {
    const cpu = this.cpu;
    if (this.sleeping) {
      if (this.keymat.some(x => x)) { this.sleeping = false; this.wakes = (this.wakes || 0) + 1; cpu.reset(); }
      else { cpu.cycles += SLICES * SLICE_CYCLES; this.finishFrame(); return; }
    }
    if (this.framePhase === 0) { this.bumpRtc(); }
    for (let slice = 0; slice < SLICES; slice++) {
      const target = cpu.cycles + SLICE_CYCLES;
      const pos = this.framePhase * SLICES + slice;
      if ((slice === 30 || slice === 330 || slice === 630 || slice === 930) && this.timeBaseEnabled()) { this.io[1] |= 0x08; this.updateIrq(); }
      if (slice === 100 && (this.framePhase & 31) === 0) { this.ivQueue.push(0x00); this.updateIrq(); }   // the 2 Hz tick the firmware counts as its clock
      while (cpu.cycles < target) {
        if (this.trace) this.trace(cpu);
        cpu.step();
      }
    }
    this.finishFrame();
  }
  updateIrq() { this.cpu.irq = (this.io[1] & 0x3F) !== 0 || this.ivQueue.length > 0; }
  timeBaseEnabled() { return (this.innerInt & 0x08) === 0 && (this.io[0x05] & 0x04) !== 0; }
  nmiEnabled() { return (this.innerInt & 0x10) === 0; }
  bumpRtc() {}
  finishFrame() {
    const cpu = this.cpu;
    if (this.framePhase === 0 || this.framePhase === 32) {
      if (this.nmiEnabled()) cpu.nmi = true;
    }
    this.framePhase = (this.framePhase + 1) % FRAME_RATE; this.frame++;
  }
}
module.exports = { NC3000 };
