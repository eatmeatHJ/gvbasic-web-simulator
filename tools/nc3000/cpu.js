// NMOS 6502 with cycle counts (decimal mode included). Undocumented opcodes are NOPs of the length the chip fetches.
// bus: { read(addr), write(addr, value) }. step() runs one instruction (or takes a pending interrupt) and returns its cycles.
'use strict';
class CPU6502 {
  constructor(bus) {
    this.bus = bus; this.a = 0; this.x = 0; this.y = 0; this.sp = 0xFD; this.pc = 0;
    this.c = 0; this.z = 0; this.i = 1; this.d = 0; this.v = 0; this.n = 0;
    this.cycles = 0; this.irq = false; this.nmi = false; this.illegal = 0; this.steps = 0;
  }
  get p() { return (this.n << 7) | (this.v << 6) | 0x20 | (this.d << 3) | (this.i << 2) | (this.z << 1) | this.c; }
  setP(v) { this.n = (v >> 7) & 1; this.v = (v >> 6) & 1; this.d = (v >> 3) & 1; this.i = (v >> 2) & 1; this.z = (v >> 1) & 1; this.c = v & 1; }
  reset() { this.sp = 0xFD; this.i = 1; this.d = 0; this.pc = this.bus.read(0xFFFC) | (this.bus.read(0xFFFD) << 8); this.cycles += 7; }
  push(v) { this.bus.write(0x100 | this.sp, v); this.sp = (this.sp - 1) & 255; }
  pull() { this.sp = (this.sp + 1) & 255; return this.bus.read(0x100 | this.sp); }
  interrupt(vec, brk) {
    this.push(this.pc >> 8); this.push(this.pc & 255); this.push(this.p | (brk ? 0x10 : 0)); this.i = 1; this.d = 0;
    this.pc = this.bus.read(vec) | (this.bus.read(vec + 1) << 8); this.cycles += 7; return 7;
  }
  nz(v) { this.z = v === 0 ? 1 : 0; this.n = (v >> 7) & 1; return v; }
  adc(m) {
    let a = this.a;
    if (this.d) {
      let lo = (a & 15) + (m & 15) + this.c; if (lo > 9) lo += 6;
      let hi = (a >> 4) + (m >> 4) + (lo > 15 ? 1 : 0);
      const bin = a + m + this.c; this.z = (bin & 255) === 0 ? 1 : 0;
      this.n = (hi << 4) & 128 ? 1 : 0; this.v = (~(a ^ m) & (a ^ (hi << 4)) & 128) ? 1 : 0;
      if (hi > 9) hi += 6; this.c = hi > 15 ? 1 : 0; this.a = ((hi << 4) | (lo & 15)) & 255;
    } else {
      const s = a + m + this.c; this.v = (~(a ^ m) & (a ^ s) & 128) ? 1 : 0; this.c = s > 255 ? 1 : 0; this.a = this.nz(s & 255);
    }
  }
  sbc(m) {
    const a = this.a;
    if (this.d) {
      const bin = a - m - (1 - this.c);
      let lo = (a & 15) - (m & 15) - (1 - this.c), hi = (a >> 4) - (m >> 4);
      if (lo < 0) { lo -= 6; hi--; }
      if (hi < 0) hi -= 6;
      this.v = ((a ^ m) & (a ^ bin) & 128) ? 1 : 0; this.c = bin >= 0 ? 1 : 0; this.nz(bin & 255);
      this.a = ((hi << 4) | (lo & 15)) & 255;
    } else { this.adc(m ^ 255); }
  }
  cmp(r, m) { const t = r - m; this.c = t >= 0 ? 1 : 0; this.nz(t & 255); }
  step() {
    const b = this.bus; this.steps++;
    if (this.nmi) { this.nmi = false; return this.interrupt(0xFFFA, false); }
    if (this.irq && !this.i) return this.interrupt(0xFFFE, false);
    const op = b.read(this.pc); this.pc = (this.pc + 1) & 0xFFFF;
    const rd = (a) => b.read(a), wr = (a, v) => b.write(a, v);
    // operand address helpers (return address); page-cross flag in cross
    let ad = 0, cross = 0, cyc = 0;
    const zp = () => rd(this.pc++ & 0xFFFF) ;
    const fetch16 = () => { const lo = rd(this.pc), hi = rd((this.pc + 1) & 0xFFFF); this.pc = (this.pc + 2) & 0xFFFF; return lo | (hi << 8); };
    const mode = (m) => {
      switch (m) {
        case 'imm': ad = this.pc; this.pc = (this.pc + 1) & 0xFFFF; break;
        case 'zp': ad = zp(); break;
        case 'zpx': ad = (zp() + this.x) & 255; break;
        case 'zpy': ad = (zp() + this.y) & 255; break;
        case 'abs': ad = fetch16(); break;
        case 'abx': { const t = fetch16(); ad = (t + this.x) & 0xFFFF; cross = (t & 0xFF00) !== (ad & 0xFF00) ? 1 : 0; break; }
        case 'aby': { const t = fetch16(); ad = (t + this.y) & 0xFFFF; cross = (t & 0xFF00) !== (ad & 0xFF00) ? 1 : 0; break; }
        case 'inx': { const t = (zp() + this.x) & 255; ad = rd(t) | (rd((t + 1) & 255) << 8); break; }
        case 'iny': { const t = zp(); const base = rd(t) | (rd((t + 1) & 255) << 8); ad = (base + this.y) & 0xFFFF; cross = (base & 0xFF00) !== (ad & 0xFF00) ? 1 : 0; break; }
      }
    };
    const branch = (cond) => { const off = rd(this.pc); this.pc = (this.pc + 1) & 0xFFFF; if (!cond) return 2; const t = (this.pc + ((off << 24) >> 24)) & 0xFFFF; const x = (t & 0xFF00) !== (this.pc & 0xFF00) ? 1 : 0; this.pc = t; return 3 + x; };
    const alu = (m, f, base, indexedExtra) => { mode(m); f(rd(ad)); return base + (indexedExtra ? cross : 0); };
    const rmw = (m, f, base) => { mode(m); const v = rd(ad); wr(ad, v); wr(ad, f(v)); return base; };
    let t;
    switch (op) {
      // ---- loads
      case 0xA9: cyc = alu('imm', v => { this.a = this.nz(v); }, 2); break;
      case 0xA5: cyc = alu('zp', v => { this.a = this.nz(v); }, 3); break;
      case 0xB5: cyc = alu('zpx', v => { this.a = this.nz(v); }, 4); break;
      case 0xAD: cyc = alu('abs', v => { this.a = this.nz(v); }, 4); break;
      case 0xBD: cyc = alu('abx', v => { this.a = this.nz(v); }, 4, 1); break;
      case 0xB9: cyc = alu('aby', v => { this.a = this.nz(v); }, 4, 1); break;
      case 0xA1: cyc = alu('inx', v => { this.a = this.nz(v); }, 6); break;
      case 0xB1: cyc = alu('iny', v => { this.a = this.nz(v); }, 5, 1); break;
      case 0xA2: cyc = alu('imm', v => { this.x = this.nz(v); }, 2); break;
      case 0xA6: cyc = alu('zp', v => { this.x = this.nz(v); }, 3); break;
      case 0xB6: cyc = alu('zpy', v => { this.x = this.nz(v); }, 4); break;
      case 0xAE: cyc = alu('abs', v => { this.x = this.nz(v); }, 4); break;
      case 0xBE: cyc = alu('aby', v => { this.x = this.nz(v); }, 4, 1); break;
      case 0xA0: cyc = alu('imm', v => { this.y = this.nz(v); }, 2); break;
      case 0xA4: cyc = alu('zp', v => { this.y = this.nz(v); }, 3); break;
      case 0xB4: cyc = alu('zpx', v => { this.y = this.nz(v); }, 4); break;
      case 0xAC: cyc = alu('abs', v => { this.y = this.nz(v); }, 4); break;
      case 0xBC: cyc = alu('abx', v => { this.y = this.nz(v); }, 4, 1); break;
      // ---- stores
      case 0x85: mode('zp'); wr(ad, this.a); cyc = 3; break;
      case 0x95: mode('zpx'); wr(ad, this.a); cyc = 4; break;
      case 0x8D: mode('abs'); wr(ad, this.a); cyc = 4; break;
      case 0x9D: mode('abx'); wr(ad, this.a); cyc = 5; break;
      case 0x99: mode('aby'); wr(ad, this.a); cyc = 5; break;
      case 0x81: mode('inx'); wr(ad, this.a); cyc = 6; break;
      case 0x91: mode('iny'); wr(ad, this.a); cyc = 6; break;
      case 0x86: mode('zp'); wr(ad, this.x); cyc = 3; break;
      case 0x96: mode('zpy'); wr(ad, this.x); cyc = 4; break;
      case 0x8E: mode('abs'); wr(ad, this.x); cyc = 4; break;
      case 0x84: mode('zp'); wr(ad, this.y); cyc = 3; break;
      case 0x94: mode('zpx'); wr(ad, this.y); cyc = 4; break;
      case 0x8C: mode('abs'); wr(ad, this.y); cyc = 4; break;
      // ---- transfers
      case 0xAA: this.x = this.nz(this.a); cyc = 2; break;
      case 0xA8: this.y = this.nz(this.a); cyc = 2; break;
      case 0x8A: this.a = this.nz(this.x); cyc = 2; break;
      case 0x98: this.a = this.nz(this.y); cyc = 2; break;
      case 0xBA: this.x = this.nz(this.sp); cyc = 2; break;
      case 0x9A: this.sp = this.x; cyc = 2; break;
      // ---- stack
      case 0x48: this.push(this.a); cyc = 3; break;
      case 0x08: this.push(this.p | 0x10); cyc = 3; break;
      case 0x68: this.a = this.nz(this.pull()); cyc = 4; break;
      case 0x28: this.setP(this.pull()); cyc = 4; break;
      // ---- logic / arithmetic
      case 0x29: cyc = alu('imm', v => { this.a = this.nz(this.a & v); }, 2); break;
      case 0x25: cyc = alu('zp', v => { this.a = this.nz(this.a & v); }, 3); break;
      case 0x35: cyc = alu('zpx', v => { this.a = this.nz(this.a & v); }, 4); break;
      case 0x2D: cyc = alu('abs', v => { this.a = this.nz(this.a & v); }, 4); break;
      case 0x3D: cyc = alu('abx', v => { this.a = this.nz(this.a & v); }, 4, 1); break;
      case 0x39: cyc = alu('aby', v => { this.a = this.nz(this.a & v); }, 4, 1); break;
      case 0x21: cyc = alu('inx', v => { this.a = this.nz(this.a & v); }, 6); break;
      case 0x31: cyc = alu('iny', v => { this.a = this.nz(this.a & v); }, 5, 1); break;
      case 0x09: cyc = alu('imm', v => { this.a = this.nz(this.a | v); }, 2); break;
      case 0x05: cyc = alu('zp', v => { this.a = this.nz(this.a | v); }, 3); break;
      case 0x15: cyc = alu('zpx', v => { this.a = this.nz(this.a | v); }, 4); break;
      case 0x0D: cyc = alu('abs', v => { this.a = this.nz(this.a | v); }, 4); break;
      case 0x1D: cyc = alu('abx', v => { this.a = this.nz(this.a | v); }, 4, 1); break;
      case 0x19: cyc = alu('aby', v => { this.a = this.nz(this.a | v); }, 4, 1); break;
      case 0x01: cyc = alu('inx', v => { this.a = this.nz(this.a | v); }, 6); break;
      case 0x11: cyc = alu('iny', v => { this.a = this.nz(this.a | v); }, 5, 1); break;
      case 0x49: cyc = alu('imm', v => { this.a = this.nz(this.a ^ v); }, 2); break;
      case 0x45: cyc = alu('zp', v => { this.a = this.nz(this.a ^ v); }, 3); break;
      case 0x55: cyc = alu('zpx', v => { this.a = this.nz(this.a ^ v); }, 4); break;
      case 0x4D: cyc = alu('abs', v => { this.a = this.nz(this.a ^ v); }, 4); break;
      case 0x5D: cyc = alu('abx', v => { this.a = this.nz(this.a ^ v); }, 4, 1); break;
      case 0x59: cyc = alu('aby', v => { this.a = this.nz(this.a ^ v); }, 4, 1); break;
      case 0x41: cyc = alu('inx', v => { this.a = this.nz(this.a ^ v); }, 6); break;
      case 0x51: cyc = alu('iny', v => { this.a = this.nz(this.a ^ v); }, 5, 1); break;
      case 0x69: cyc = alu('imm', v => this.adc(v), 2); break;
      case 0x65: cyc = alu('zp', v => this.adc(v), 3); break;
      case 0x75: cyc = alu('zpx', v => this.adc(v), 4); break;
      case 0x6D: cyc = alu('abs', v => this.adc(v), 4); break;
      case 0x7D: cyc = alu('abx', v => this.adc(v), 4, 1); break;
      case 0x79: cyc = alu('aby', v => this.adc(v), 4, 1); break;
      case 0x61: cyc = alu('inx', v => this.adc(v), 6); break;
      case 0x71: cyc = alu('iny', v => this.adc(v), 5, 1); break;
      case 0xE9: cyc = alu('imm', v => this.sbc(v), 2); break;
      case 0xE5: cyc = alu('zp', v => this.sbc(v), 3); break;
      case 0xF5: cyc = alu('zpx', v => this.sbc(v), 4); break;
      case 0xED: cyc = alu('abs', v => this.sbc(v), 4); break;
      case 0xFD: cyc = alu('abx', v => this.sbc(v), 4, 1); break;
      case 0xF9: cyc = alu('aby', v => this.sbc(v), 4, 1); break;
      case 0xE1: cyc = alu('inx', v => this.sbc(v), 6); break;
      case 0xF1: cyc = alu('iny', v => this.sbc(v), 5, 1); break;
      case 0xC9: cyc = alu('imm', v => this.cmp(this.a, v), 2); break;
      case 0xC5: cyc = alu('zp', v => this.cmp(this.a, v), 3); break;
      case 0xD5: cyc = alu('zpx', v => this.cmp(this.a, v), 4); break;
      case 0xCD: cyc = alu('abs', v => this.cmp(this.a, v), 4); break;
      case 0xDD: cyc = alu('abx', v => this.cmp(this.a, v), 4, 1); break;
      case 0xD9: cyc = alu('aby', v => this.cmp(this.a, v), 4, 1); break;
      case 0xC1: cyc = alu('inx', v => this.cmp(this.a, v), 6); break;
      case 0xD1: cyc = alu('iny', v => this.cmp(this.a, v), 5, 1); break;
      case 0xE0: cyc = alu('imm', v => this.cmp(this.x, v), 2); break;
      case 0xE4: cyc = alu('zp', v => this.cmp(this.x, v), 3); break;
      case 0xEC: cyc = alu('abs', v => this.cmp(this.x, v), 4); break;
      case 0xC0: cyc = alu('imm', v => this.cmp(this.y, v), 2); break;
      case 0xC4: cyc = alu('zp', v => this.cmp(this.y, v), 3); break;
      case 0xCC: cyc = alu('abs', v => this.cmp(this.y, v), 4); break;
      case 0x24: cyc = alu('zp', v => { this.z = (this.a & v) === 0 ? 1 : 0; this.n = (v >> 7) & 1; this.v = (v >> 6) & 1; }, 3); break;
      case 0x2C: cyc = alu('abs', v => { this.z = (this.a & v) === 0 ? 1 : 0; this.n = (v >> 7) & 1; this.v = (v >> 6) & 1; }, 4); break;
      // ---- shifts, inc/dec
      case 0x0A: this.c = (this.a >> 7) & 1; this.a = this.nz((this.a << 1) & 255); cyc = 2; break;
      case 0x4A: this.c = this.a & 1; this.a = this.nz(this.a >> 1); cyc = 2; break;
      case 0x2A: t = this.c; this.c = (this.a >> 7) & 1; this.a = this.nz(((this.a << 1) | t) & 255); cyc = 2; break;
      case 0x6A: t = this.c; this.c = this.a & 1; this.a = this.nz((this.a >> 1) | (t << 7)); cyc = 2; break;
      case 0x06: cyc = rmw('zp', v => { this.c = (v >> 7) & 1; return this.nz((v << 1) & 255); }, 5); break;
      case 0x16: cyc = rmw('zpx', v => { this.c = (v >> 7) & 1; return this.nz((v << 1) & 255); }, 6); break;
      case 0x0E: cyc = rmw('abs', v => { this.c = (v >> 7) & 1; return this.nz((v << 1) & 255); }, 6); break;
      case 0x1E: cyc = rmw('abx', v => { this.c = (v >> 7) & 1; return this.nz((v << 1) & 255); }, 7); break;
      case 0x46: cyc = rmw('zp', v => { this.c = v & 1; return this.nz(v >> 1); }, 5); break;
      case 0x56: cyc = rmw('zpx', v => { this.c = v & 1; return this.nz(v >> 1); }, 6); break;
      case 0x4E: cyc = rmw('abs', v => { this.c = v & 1; return this.nz(v >> 1); }, 6); break;
      case 0x5E: cyc = rmw('abx', v => { this.c = v & 1; return this.nz(v >> 1); }, 7); break;
      case 0x26: cyc = rmw('zp', v => { const k = this.c; this.c = (v >> 7) & 1; return this.nz(((v << 1) | k) & 255); }, 5); break;
      case 0x36: cyc = rmw('zpx', v => { const k = this.c; this.c = (v >> 7) & 1; return this.nz(((v << 1) | k) & 255); }, 6); break;
      case 0x2E: cyc = rmw('abs', v => { const k = this.c; this.c = (v >> 7) & 1; return this.nz(((v << 1) | k) & 255); }, 6); break;
      case 0x3E: cyc = rmw('abx', v => { const k = this.c; this.c = (v >> 7) & 1; return this.nz(((v << 1) | k) & 255); }, 7); break;
      case 0x66: cyc = rmw('zp', v => { const k = this.c; this.c = v & 1; return this.nz((v >> 1) | (k << 7)); }, 5); break;
      case 0x76: cyc = rmw('zpx', v => { const k = this.c; this.c = v & 1; return this.nz((v >> 1) | (k << 7)); }, 6); break;
      case 0x6E: cyc = rmw('abs', v => { const k = this.c; this.c = v & 1; return this.nz((v >> 1) | (k << 7)); }, 6); break;
      case 0x7E: cyc = rmw('abx', v => { const k = this.c; this.c = v & 1; return this.nz((v >> 1) | (k << 7)); }, 7); break;
      case 0xE6: cyc = rmw('zp', v => this.nz((v + 1) & 255), 5); break;
      case 0xF6: cyc = rmw('zpx', v => this.nz((v + 1) & 255), 6); break;
      case 0xEE: cyc = rmw('abs', v => this.nz((v + 1) & 255), 6); break;
      case 0xFE: cyc = rmw('abx', v => this.nz((v + 1) & 255), 7); break;
      case 0xC6: cyc = rmw('zp', v => this.nz((v - 1) & 255), 5); break;
      case 0xD6: cyc = rmw('zpx', v => this.nz((v - 1) & 255), 6); break;
      case 0xCE: cyc = rmw('abs', v => this.nz((v - 1) & 255), 6); break;
      case 0xDE: cyc = rmw('abx', v => this.nz((v - 1) & 255), 7); break;
      case 0xE8: this.x = this.nz((this.x + 1) & 255); cyc = 2; break;
      case 0xC8: this.y = this.nz((this.y + 1) & 255); cyc = 2; break;
      case 0xCA: this.x = this.nz((this.x - 1) & 255); cyc = 2; break;
      case 0x88: this.y = this.nz((this.y - 1) & 255); cyc = 2; break;
      // ---- flags
      case 0x18: this.c = 0; cyc = 2; break;
      case 0x38: this.c = 1; cyc = 2; break;
      case 0x58: this.i = 0; cyc = 2; break;
      case 0x78: this.i = 1; cyc = 2; break;
      case 0xB8: this.v = 0; cyc = 2; break;
      case 0xD8: this.d = 0; cyc = 2; break;
      case 0xF8: this.d = 1; cyc = 2; break;
      // ---- branches
      case 0x10: cyc = branch(!this.n); break;
      case 0x30: cyc = branch(this.n); break;
      case 0x50: cyc = branch(!this.v); break;
      case 0x70: cyc = branch(this.v); break;
      case 0x90: cyc = branch(!this.c); break;
      case 0xB0: cyc = branch(this.c); break;
      case 0xD0: cyc = branch(!this.z); break;
      case 0xF0: cyc = branch(this.z); break;
      // ---- jumps
      case 0x4C: this.pc = fetch16(); cyc = 3; break;
      case 0x6C: { const p = fetch16(); this.pc = rd(p) | (rd((p & 0xFF00) | ((p + 1) & 0xFF)) << 8); cyc = 5; break; }
      case 0x20: { const a = fetch16(); const r = (this.pc - 1) & 0xFFFF; this.push(r >> 8); this.push(r & 255); this.pc = a; cyc = 6; break; }
      case 0x60: { const lo = this.pull(), hi = this.pull(); this.pc = (((hi << 8) | lo) + 1) & 0xFFFF; cyc = 6; break; }
      case 0x40: this.setP(this.pull()); { const lo = this.pull(), hi = this.pull(); this.pc = (hi << 8) | lo; } cyc = 6; break;
      case 0x00: this.pc = (this.pc + 1) & 0xFFFF; this.interrupt(0xFFFE, true); cyc = 0; this.cycles -= 7; cyc = 7; break;
      case 0xEA: cyc = 2; break;
      default: {
        this.illegal++;
        if (op === 0x04 || op === 0x44 || op === 0x64) { this.pc = (this.pc + 1) & 0xFFFF; cyc = 3; }
        else if (op === 0x14 || op === 0x34 || op === 0x54 || op === 0x74 || op === 0xD4 || op === 0xF4) { this.pc = (this.pc + 1) & 0xFFFF; cyc = 4; }
        else if (op === 0x80 || op === 0x82 || op === 0x89 || op === 0xC2 || op === 0xE2) { this.pc = (this.pc + 1) & 0xFFFF; cyc = 2; }
        else if (op === 0x0C) { this.pc = (this.pc + 2) & 0xFFFF; cyc = 4; }
        else if (op === 0x1C || op === 0x3C || op === 0x5C || op === 0x7C || op === 0xDC || op === 0xFC) { this.pc = (this.pc + 2) & 0xFFFF; cyc = 4; }
        else cyc = 2;
      }
    }
    this.cycles += cyc;
    return cyc;
  }
}
module.exports = { CPU6502 };
