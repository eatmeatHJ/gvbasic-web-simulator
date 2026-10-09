/* MOS 6502 (NMOS) CPU core, as used in the handheld devices this simulator targets.
 * Documented instructions incl. decimal mode and the JMP ($xxFF) page bug; every other opcode is a NOP of the
 * size the real chip fetches (the device emulators treat them that way), counted in cpu.illegal.
 * The CPU only talks to a bus {read(addr), write(addr, value)} and has two hooks the emulated OS uses:
 *   traps   : fetching an address in cpu.traps runs a JS routine and then behaves like RTS
 *             (JSR $E02A ... : the device's ROM routines are implemented in JS)
 *   onBrk   : BRK is the device's 3-byte system call  INT $pppp = 00 pp pp
 */
(function (root) {
'use strict';

/* mnemonic -> { addressing mode: opcode } */
const SPEC = {
  ADC: { imm: 0x69, zp: 0x65, zpx: 0x75, abs: 0x6D, abx: 0x7D, aby: 0x79, indx: 0x61, indy: 0x71 },
  AND: { imm: 0x29, zp: 0x25, zpx: 0x35, abs: 0x2D, abx: 0x3D, aby: 0x39, indx: 0x21, indy: 0x31 },
  ASL: { acc: 0x0A, zp: 0x06, zpx: 0x16, abs: 0x0E, abx: 0x1E },
  BCC: { rel: 0x90 }, BCS: { rel: 0xB0 }, BEQ: { rel: 0xF0 }, BIT: { zp: 0x24, abs: 0x2C }, BMI: { rel: 0x30 },
  BNE: { rel: 0xD0 }, BPL: { rel: 0x10 }, BRK: { imp: 0x00 }, BVC: { rel: 0x50 }, BVS: { rel: 0x70 },
  CLC: { imp: 0x18 }, CLD: { imp: 0xD8 }, CLI: { imp: 0x58 }, CLV: { imp: 0xB8 },
  CMP: { imm: 0xC9, zp: 0xC5, zpx: 0xD5, abs: 0xCD, abx: 0xDD, aby: 0xD9, indx: 0xC1, indy: 0xD1 },
  CPX: { imm: 0xE0, zp: 0xE4, abs: 0xEC }, CPY: { imm: 0xC0, zp: 0xC4, abs: 0xCC },
  DEC: { zp: 0xC6, zpx: 0xD6, abs: 0xCE, abx: 0xDE }, DEX: { imp: 0xCA }, DEY: { imp: 0x88 },
  EOR: { imm: 0x49, zp: 0x45, zpx: 0x55, abs: 0x4D, abx: 0x5D, aby: 0x59, indx: 0x41, indy: 0x51 },
  INC: { zp: 0xE6, zpx: 0xF6, abs: 0xEE, abx: 0xFE }, INX: { imp: 0xE8 }, INY: { imp: 0xC8 },
  JMP: { abs: 0x4C, ind: 0x6C }, JSR: { abs: 0x20 },
  LDA: { imm: 0xA9, zp: 0xA5, zpx: 0xB5, abs: 0xAD, abx: 0xBD, aby: 0xB9, indx: 0xA1, indy: 0xB1 },
  LDX: { imm: 0xA2, zp: 0xA6, zpy: 0xB6, abs: 0xAE, aby: 0xBE },
  LDY: { imm: 0xA0, zp: 0xA4, zpx: 0xB4, abs: 0xAC, abx: 0xBC },
  LSR: { acc: 0x4A, zp: 0x46, zpx: 0x56, abs: 0x4E, abx: 0x5E }, NOP: { imp: 0xEA },
  ORA: { imm: 0x09, zp: 0x05, zpx: 0x15, abs: 0x0D, abx: 0x1D, aby: 0x19, indx: 0x01, indy: 0x11 },
  PHA: { imp: 0x48 }, PHP: { imp: 0x08 }, PLA: { imp: 0x68 }, PLP: { imp: 0x28 },
  ROL: { acc: 0x2A, zp: 0x26, zpx: 0x36, abs: 0x2E, abx: 0x3E }, ROR: { acc: 0x6A, zp: 0x66, zpx: 0x76, abs: 0x6E, abx: 0x7E },
  RTI: { imp: 0x40 }, RTS: { imp: 0x60 },
  SBC: { imm: 0xE9, zp: 0xE5, zpx: 0xF5, abs: 0xED, abx: 0xFD, aby: 0xF9, indx: 0xE1, indy: 0xF1 },
  SEC: { imp: 0x38 }, SED: { imp: 0xF8 }, SEI: { imp: 0x78 },
  STA: { zp: 0x85, zpx: 0x95, abs: 0x8D, abx: 0x9D, aby: 0x99, indx: 0x81, indy: 0x91 },
  STX: { zp: 0x86, zpy: 0x96, abs: 0x8E }, STY: { zp: 0x84, zpx: 0x94, abs: 0x8C },
  TAX: { imp: 0xAA }, TAY: { imp: 0xA8 }, TSX: { imp: 0xBA }, TXA: { imp: 0x8A }, TXS: { imp: 0x9A }, TYA: { imp: 0x98 },
};

const MODE_NAMES = ['imp', 'acc', 'imm', 'zp', 'zpx', 'zpy', 'abs', 'abx', 'aby', 'ind', 'indx', 'indy', 'rel'];
const [M_IMP, M_ACC, M_IMM, M_ZP, M_ZPX, M_ZPY, M_ABS, M_ABX, M_ABY, M_IND, M_INDX, M_INDY, M_REL] = MODE_NAMES.map((_, i) => i);
const MNEMONICS = Object.keys(SPEC);
const OPID = new Int16Array(256).fill(-1);       // opcode -> instruction id (-1 = undocumented)
const OPMODE = new Uint8Array(256);              // opcode -> addressing mode
for (const [name, modes] of Object.entries(SPEC)) for (const [m, op] of Object.entries(modes)) { OPID[op] = MNEMONICS.indexOf(name); OPMODE[op] = MODE_NAMES.indexOf(m); }
const I = {}; MNEMONICS.forEach((n, i) => { I[n] = i; });
const { ADC, AND, ASL, BCC, BCS, BEQ, BIT, BMI, BNE, BPL, BRK, BVC, BVS, CLC, CLD, CLI, CLV, CMP, CPX, CPY, DEC, DEX, DEY, EOR, INC, INX, INY,
  JMP, JSR, LDA, LDX, LDY, LSR, NOP, ORA, PHA, PHP, PLA, PLP, ROL, ROR, RTI, RTS, SBC, SEC, SED, SEI, STA, STX, STY, TAX, TAY, TSX, TXA, TXS, TYA } = I;

// undocumented opcodes that the device treats as NOPs: operand bytes they swallow
const NOP2 = new Set([0x04, 0x14, 0x34, 0x44, 0x54, 0x64, 0x74, 0x80, 0x82, 0x89, 0xC2, 0xD4, 0xE2, 0xF4]);
const NOP3 = new Set([0x0C, 0x1C, 0x3C, 0x5C, 0x7C, 0xDC, 0xFC]);

const SENTINEL = 0xFFF0;                         // return address that means "back to the host"

class CPU6502 {
  constructor(bus) {
    this.rd = bus.read.bind ? bus.read.bind(bus) : bus.read;
    this.wr = bus.write.bind ? bus.write.bind(bus) : bus.write;
    this.a = this.x = this.y = 0; this.sp = 0xFD; this.pc = 0;
    this.c = 0; this.z = 0; this.i = 1; this.d = 0; this.v = 0; this.n = 0;
    this.illegal = 0; this.steps = 0; this.halted = false; this.ips = 0;
    this.traps = new Map(); this.trapMask = new Uint8Array(65536);
    this.onBrk = null;
    this.guard = null;                           // optional (pc) => void, called when the CPU fetches from an address range it should not
    this.addTrap(SENTINEL, cpu => { cpu.halted = true; cpu.noRts = true; });
  }
  addTrap(addr, fn) { this.traps.set(addr, fn); this.trapMask[addr] = 1; }

  get p() { return (this.n << 7) | (this.v << 6) | 0x20 | (this.d << 3) | (this.i << 2) | (this.z << 1) | this.c; }
  setP(v) { this.n = (v >> 7) & 1; this.v = (v >> 6) & 1; this.d = (v >> 3) & 1; this.i = (v >> 2) & 1; this.z = (v >> 1) & 1; this.c = v & 1; }
  push(v) { this.wr(0x100 | this.sp, v & 0xFF); this.sp = (this.sp - 1) & 0xFF; }
  pull() { this.sp = (this.sp + 1) & 0xFF; return this.rd(0x100 | this.sp); }
  nz(v) { this.z = v === 0 ? 1 : 0; this.n = (v >> 7) & 1; return v; }
  rts() { const lo = this.pull(); const hi = this.pull(); this.pc = (((hi << 8) | lo) + 1) & 0xFFFF; }

  reset(pc) { this.a = this.x = this.y = 0; this.sp = 0xFD; this.setP(0x04); this.pc = pc & 0xFFFF; this.halted = false; }

  /* run machine code at addr as if it had been CALLed: returns (a Promise) when it executes the final RTS; regs = A/X/Y at entry */
  async call(addr, shouldStop, regs) {
    this.reset(addr);
    if (regs) { this.a = regs.a & 0xFF; this.x = regs.x & 0xFF; this.y = regs.y & 0xFF; }
    const ret = (SENTINEL - 1) & 0xFFFF;
    this.push(ret >> 8); this.push(ret & 0xFF);
    await this.run(shouldStop);
  }
  /* Keep to cpu.ips (instructions per second; 0 = no limit). A virtual clock like the BASIC speed limit: a timer that oversleeps is caught up, but only by 40 ms. */
  async pace() {
    const t = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (this._t0 === undefined || this._ipsSeen !== this.ips) { this._t0 = t; this._vt = 0; this._ck = this.steps; this._ipsSeen = this.ips; }
    const ds = this.steps - this._ck; this._ck = this.steps;
    const el = t - this._t0; this._vt = Math.max(this._vt, el - 40) + ds * 1000 / this.ips;
    if (this._vt - el > 4) await new Promise(res => setTimeout(res, this._vt - el));
  }
  async run(shouldStop, idleCheck) {                  // idleCheck() true = the program only waits for the outside world: sleep a moment
    let t0 = Date.now(), n = 0;
    while (!this.halted) {
      const r = this.step();
      if (r) await r;
      if (idleCheck && idleCheck()) {
        if (shouldStop && shouldStop()) { const e = new Error('stopped'); e.stopped = true; throw e; }
        await new Promise(res => setTimeout(res, 1)); t0 = Date.now(); continue;
      }
      if (this.ips ? (++n & 0x3FF) === 0 : (++n & 0x3FFF) === 0) {
        if (shouldStop && shouldStop()) { const e = new Error('stopped'); e.stopped = true; throw e; }
        if (this.ips) await this.pace();
        else if (Date.now() - t0 > 12) { await new Promise(res => setTimeout(res, 0)); t0 = Date.now(); }
      }
    }
  }
  /* synchronous run for tests: stops at the sentinel, or when an instruction jumps to itself (a "trap loop") */
  runSync(maxSteps) {
    for (let n = 0; n < maxSteps && !this.halted; n++) {
      const pc = this.pc;
      const r = this.step();
      if (r) throw new Error('blocking system call in runSync');
      if (this.pc === pc && !this.halted) return { trapped: pc, steps: n };
    }
    return { steps: this.steps, halted: this.halted };
  }

  step() {
    const rd = this.rd, wr = this.wr;
    const pc0 = this.pc;
    this.steps++;
    if (this.trapMask[pc0]) {
      this.noRts = false;
      const r = this.traps.get(pc0)(this);
      if (r && r.then) return r.then(() => { if (!this.noRts) this.rts(); });
      if (!this.noRts) this.rts();
      return undefined;
    }
    if (this.guard) this.guard(pc0);
    const op = rd(pc0);
    let pc = (pc0 + 1) & 0xFFFF;
    const id = OPID[op];
    if (id < 0) {                                 // undocumented opcode: a NOP of the right length
      this.illegal++;
      this.pc = NOP3.has(op) ? (pc + 2) & 0xFFFF : NOP2.has(op) ? (pc + 1) & 0xFFFF : pc;
      return undefined;
    }
    let ea = 0;
    switch (OPMODE[op]) {
      case M_IMM: ea = pc; pc = (pc + 1) & 0xFFFF; break;
      case M_ZP: ea = rd(pc); pc = (pc + 1) & 0xFFFF; break;
      case M_ZPX: ea = (rd(pc) + this.x) & 0xFF; pc = (pc + 1) & 0xFFFF; break;
      case M_ZPY: ea = (rd(pc) + this.y) & 0xFF; pc = (pc + 1) & 0xFFFF; break;
      case M_ABS: ea = rd(pc) | (rd((pc + 1) & 0xFFFF) << 8); pc = (pc + 2) & 0xFFFF; break;
      case M_ABX: ea = ((rd(pc) | (rd((pc + 1) & 0xFFFF) << 8)) + this.x) & 0xFFFF; pc = (pc + 2) & 0xFFFF; break;
      case M_ABY: ea = ((rd(pc) | (rd((pc + 1) & 0xFFFF) << 8)) + this.y) & 0xFFFF; pc = (pc + 2) & 0xFFFF; break;
      case M_IND: { const p = rd(pc) | (rd((pc + 1) & 0xFFFF) << 8); ea = rd(p) | (rd((p & 0xFF00) | ((p + 1) & 0xFF)) << 8); pc = (pc + 2) & 0xFFFF; break; }   // JMP ($xxFF) page bug
      case M_INDX: { const z = (rd(pc) + this.x) & 0xFF; ea = rd(z) | (rd((z + 1) & 0xFF) << 8); pc = (pc + 1) & 0xFFFF; break; }
      case M_INDY: { const z = rd(pc); ea = ((rd(z) | (rd((z + 1) & 0xFF) << 8)) + this.y) & 0xFFFF; pc = (pc + 1) & 0xFFFF; break; }
      case M_REL: { const o = rd(pc); pc = (pc + 1) & 0xFFFF; ea = (pc + ((o << 24) >> 24)) & 0xFFFF; break; }
      default: break;                              // implied / accumulator
    }
    this.pc = pc;
    let v, t;
    switch (id) {
      case LDA: this.a = this.nz(rd(ea)); break;
      case LDX: this.x = this.nz(rd(ea)); break;
      case LDY: this.y = this.nz(rd(ea)); break;
      case STA: wr(ea, this.a); break;
      case STX: wr(ea, this.x); break;
      case STY: wr(ea, this.y); break;
      case TAX: this.x = this.nz(this.a); break;
      case TAY: this.y = this.nz(this.a); break;
      case TXA: this.a = this.nz(this.x); break;
      case TYA: this.a = this.nz(this.y); break;
      case TSX: this.x = this.nz(this.sp); break;
      case TXS: this.sp = this.x; break;
      case PHA: this.push(this.a); break;
      case PLA: this.a = this.nz(this.pull()); break;
      case PHP: this.push(this.p | 0x10); break;
      case PLP: this.setP(this.pull()); break;
      case AND: this.a = this.nz(this.a & rd(ea)); break;
      case ORA: this.a = this.nz(this.a | rd(ea)); break;
      case EOR: this.a = this.nz(this.a ^ rd(ea)); break;
      case BIT: v = rd(ea); this.z = (this.a & v) === 0 ? 1 : 0; this.n = (v >> 7) & 1; this.v = (v >> 6) & 1; break;
      case ADC: this.adc(rd(ea)); break;
      case SBC: this.sbc(rd(ea)); break;
      case CMP: v = rd(ea); t = this.a - v; this.c = t >= 0 ? 1 : 0; this.nz(t & 0xFF); break;
      case CPX: v = rd(ea); t = this.x - v; this.c = t >= 0 ? 1 : 0; this.nz(t & 0xFF); break;
      case CPY: v = rd(ea); t = this.y - v; this.c = t >= 0 ? 1 : 0; this.nz(t & 0xFF); break;
      case INC: v = rd(ea); wr(ea, v); wr(ea, this.nz((v + 1) & 0xFF)); break;
      case DEC: v = rd(ea); wr(ea, v); wr(ea, this.nz((v - 1) & 0xFF)); break;
      case INX: this.x = this.nz((this.x + 1) & 0xFF); break;
      case INY: this.y = this.nz((this.y + 1) & 0xFF); break;
      case DEX: this.x = this.nz((this.x - 1) & 0xFF); break;
      case DEY: this.y = this.nz((this.y - 1) & 0xFF); break;
      case ASL: if (OPMODE[op] === M_ACC) { this.c = (this.a >> 7) & 1; this.a = this.nz((this.a << 1) & 0xFF); } else { v = rd(ea); wr(ea, v); this.c = (v >> 7) & 1; wr(ea, this.nz((v << 1) & 0xFF)); } break;
      case LSR: if (OPMODE[op] === M_ACC) { this.c = this.a & 1; this.a = this.nz(this.a >> 1); } else { v = rd(ea); wr(ea, v); this.c = v & 1; wr(ea, this.nz(v >> 1)); } break;
      case ROL: if (OPMODE[op] === M_ACC) { t = this.c; this.c = (this.a >> 7) & 1; this.a = this.nz(((this.a << 1) | t) & 0xFF); } else { v = rd(ea); wr(ea, v); t = this.c; this.c = (v >> 7) & 1; wr(ea, this.nz(((v << 1) | t) & 0xFF)); } break;
      case ROR: if (OPMODE[op] === M_ACC) { t = this.c; this.c = this.a & 1; this.a = this.nz((this.a >> 1) | (t << 7)); } else { v = rd(ea); wr(ea, v); t = this.c; this.c = v & 1; wr(ea, this.nz((v >> 1) | (t << 7))); } break;
      case BCC: if (!this.c) this.pc = ea; break;
      case BCS: if (this.c) this.pc = ea; break;
      case BEQ: if (this.z) this.pc = ea; break;
      case BNE: if (!this.z) this.pc = ea; break;
      case BMI: if (this.n) this.pc = ea; break;
      case BPL: if (!this.n) this.pc = ea; break;
      case BVS: if (this.v) this.pc = ea; break;
      case BVC: if (!this.v) this.pc = ea; break;
      case JMP: this.pc = ea; break;
      case JSR: { const r = (this.pc - 1) & 0xFFFF; this.push(r >> 8); this.push(r & 0xFF); this.pc = ea; break; }
      case RTS: this.rts(); break;
      case RTI: this.setP(this.pull()); { const lo = this.pull(); const hi = this.pull(); this.pc = (hi << 8) | lo; } break;
      case BRK: {
        if (this.onBrk) { const r = this.onBrk(this, pc0); if (r !== false) return r; }
        const r = (pc0 + 2) & 0xFFFF; this.push(r >> 8); this.push(r & 0xFF); this.push(this.p | 0x10); this.i = 1;
        this.pc = rd(0xFFFE) | (rd(0xFFFF) << 8); break;
      }
      case CLC: this.c = 0; break; case SEC: this.c = 1; break;
      case CLI: this.i = 0; break; case SEI: this.i = 1; break;
      case CLD: this.d = 0; break; case SED: this.d = 1; break;
      case CLV: this.v = 0; break;
      case NOP: break;
      default: throw new Error('unhandled instruction id ' + id);
    }
    return undefined;
  }

  adc(m) {
    const a = this.a, c = this.c;
    if (!this.d) {
      const t = a + m + c;
      this.v = (~(a ^ m) & (a ^ t) & 0x80) ? 1 : 0; this.c = t > 0xFF ? 1 : 0;
      this.a = this.nz(t & 0xFF);
    } else { // NMOS decimal mode: Z comes from the binary result, N and V from the intermediate value
      this.z = ((a + m + c) & 0xFF) === 0 ? 1 : 0;
      let t = (a & 0x0F) + (m & 0x0F) + c;
      if (t > 9) t += 6;
      t = (t <= 0x0F ? (t & 0x0F) : (t & 0x0F) + 0x10) + (a & 0xF0) + (m & 0xF0);
      this.n = (t >> 7) & 1; this.v = (~(a ^ m) & (a ^ t) & 0x80) ? 1 : 0;
      if ((t & 0x1F0) > 0x90) t += 0x60;
      this.c = (t & 0xFF0) > 0xF0 ? 1 : 0;
      this.a = t & 0xFF;
    }
  }
  sbc(m) {
    const a = this.a, borrow = 1 - this.c;
    const t = a - m - borrow;
    this.v = ((a ^ m) & (a ^ t) & 0x80) ? 1 : 0; this.c = t >= 0 ? 1 : 0; this.nz(t & 0xFF);   // flags always from the binary subtraction
    if (!this.d) { this.a = t & 0xFF; return; }
    let lo = (a & 0x0F) - (m & 0x0F) - borrow;
    if (lo < 0) lo = ((lo - 6) & 0x0F) - 0x10;
    let r = (a & 0xF0) - (m & 0xF0) + lo;
    if (r < 0) r -= 0x60;
    this.a = r & 0xFF;
  }
}

const api = { CPU6502, SPEC, MODE_NAMES, SENTINEL };
if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.CPU6502 = CPU6502, root.CPU6502_SPEC = SPEC;
})(typeof globalThis !== 'undefined' ? globalThis : this);
