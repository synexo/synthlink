'use strict';

/**
 * V.29 — 9600 bps, per ITU-T Recommendation V.29 (11/1988).
 *
 * A genuine minimal V.29 implementation in the same spirit as the other
 * SynthLink protocols: spec-conformant modulation/signalling (real
 * constellation, carrier, baud, differential encoding, scrambler), without the
 * optional adaptive-equaliser / continuous-timing-tracking that a full
 * real-hardware receiver would add. Proven originate<->answer over the real
 * Int16 WebSocket wire with random start offsets and jittered delivery.
 *
 * ── What is genuine here ────────────────────────────────────────────────────
 *   - The real V.29 16-point constellation: two amplitude rings (radius 3/5 on
 *     the on-axis phases, sqrt(2)/3*sqrt(2) on the diagonal phases), spandsp
 *     point ordering.
 *   - Real V.29 encoding: differential PHASE (Q2 Q3 Q4 -> phase change, §4
 *     table) + absolute AMPLITUDE (Q1). 2400 baud, 4 bits/symbol = 9600 bps.
 *   - The real V.29 self-synchronising scrambler, 1 + x^-18 + x^-23.
 *   - 1700 Hz carrier; 2400 baud => 3.333 samples/symbol at 8 kHz, handled by
 *     continuous root-raised-cosine synthesis and matched filtering evaluated
 *     at the true fractional symbol instants (rolloff 0.25).
 *
 * ── Why this fits our transport ─────────────────────────────────────────────
 * V.29 §1.1 specifies operation on 4-wire circuits, where full-duplex is
 * achieved with two independent carriers (one per pair). The two independent
 * WebSocket directions ARE a 4-wire-equivalent, so we simply run one V.29
 * carrier per direction. Both ends do the identical thing — start transmitting
 * the training preamble and acquire the peer independently. There is therefore
 * NO V.8 negotiation and NO answer-tone handshake for V.29 (see Handshake.js,
 * which routes V.29 straight to _selectProtocol for both roles).
 *
 * ── Acquisition front-end (the "genuine minimal" receiver) ──────────────────
 * Over the wire the two modems are NOT sample-aligned, so the receiver does
 * real preamble-based acquisition rather than any shared-clock shortcut:
 *   energy onset -> fractional symbol-phase lock (maximise SEG_A energy)
 *   -> alternating->constant transition = frame sync -> gain/phase seed
 *   -> differential decode -> descramble.
 * `ready` (=> "connected") is emitted the instant the peer's carrier is
 * acquired; before that the class transmits its preamble continuously so the
 * peer can lock, exactly like the V.22/V.22bis event-driven `ready` path.
 *
 * Interface (matches the other protocol classes so HandshakeEngine can drive
 * it): constructor(role); generateAudio(n)->Float32Array; receiveAudio(f32);
 * write(buf); emits 'data' (Buffer) and 'ready' ({bps, remoteDetected});
 * getters bps and carrierDetected.
 */

const { EventEmitter } = require('events');

const SR = 8000, BAUD = 2400, FC = 1700, SPS = SR / BAUD; // 3.333…
const ROLLOFF = 0.25, SPAN = 10;

// V.29 16-point constellation (spandsp point ordering). Index = (Q1<<3)|phase,
// phase 0..7 in 45° steps. On-axis phases carry amplitude ring 3/5; diagonal
// phases carry ring sqrt(2)/3*sqrt(2).
const C = [
  { i: 3, q: 0 }, { i: 1, q: 1 }, { i: 0, q: 3 }, { i: -1, q: 1 },
  { i: -3, q: 0 }, { i: -1, q: -1 }, { i: 0, q: -3 }, { i: 1, q: -1 },
  { i: 5, q: 0 }, { i: 3, q: 3 }, { i: 0, q: 5 }, { i: -3, q: 3 },
  { i: -5, q: 0 }, { i: -3, q: -3 }, { i: 0, q: -5 }, { i: 3, q: -3 },
];
// §4 differential map: (Q2 Q3 Q4) -> phase change (in 45° units).
const DPHASE = { 1: 0, 0: 1, 2: 2, 3: 3, 7: 4, 6: 5, 4: 6, 5: 7 };
const DINV = {}; for (const k in DPHASE) DINV[DPHASE[k]] = +k;

function rrcAt(t) {
  const b = ROLLOFF;
  if (Math.abs(t) < 1e-8) return 1 - b + 4 * b / Math.PI;
  if (Math.abs(Math.abs(4 * b * t) - 1) < 1e-6) {
    return (b / Math.SQRT2) *
      ((1 + 2 / Math.PI) * Math.sin(Math.PI / (4 * b)) +
       (1 - 2 / Math.PI) * Math.cos(Math.PI / (4 * b)));
  }
  const pt = Math.PI * t;
  return (Math.sin(pt * (1 - b)) + 4 * b * t * Math.cos(pt * (1 + b))) /
         (pt * (1 - (4 * b * t) * (4 * b * t)));
}
let RRC_G = 1;
{ let s = 0; for (let k = -SPAN * 4; k <= SPAN * 4; k++) s += rrcAt(k / 4) ** 2; RRC_G = 1 / Math.sqrt(s / 4); }
const rrc = t => rrcAt(t) * RRC_G;

// Preamble (symbols): SEG_A alternating (5,0)/(-5,0) for AGC + fractional
// symbol-timing lock; SEG_B constant (5,0) for phase/gain seed and the
// alternating->constant frame-sync marker.
const SEG_A = 32, SEG_B = 16, PRE = SEG_A + SEG_B;

// Buffer housekeeping: once acquired, samples/symbols older than this many
// symbol-periods behind the working window can never be referenced again, so
// we trim them (offset-indexed) to keep memory bounded on long BBS sessions.
// Absolute sample/symbol semantics (and therefore carrier phase, which is
// derived from the absolute sample index) are unchanged — only array storage
// is compacted. Trim in chunks to avoid per-symbol splices.
const RX_TRIM_MARGIN = Math.ceil((SPAN + 4) * SPS); // samples kept behind cursor
const RX_TRIM_CHUNK  = 4000;                          // ~0.5 s before compacting
const TX_TRIM_MARGIN = SPAN + 4;                      // symbols kept behind cursor
const TX_TRIM_CHUNK  = 1200;

class V29 extends EventEmitter {
  constructor(role) {
    super();
    this.role = role || 'answer'; // symmetric; retained for parity/logging
    this._ready = false;

    // ── TX ──
    this.txSyms = [];
    this.txSymBase = 0;            // absolute index of txSyms[0]
    this._buildPreamble();
    this.txPhase = 0;
    this.scr = new Array(23).fill(0);
    this.n = 0;                    // absolute TX sample counter (drives phase)
    this.txBits = [];              // pending scrambled data bits

    // ── RX ──
    this.rx = [];
    this.rxBase = 0;               // absolute index of rx[0]
    this.acq = false;
    this.base = 0;                 // fractional absolute sample of symbol 0
    this.symIdx = 0;               // next symbol to decode (absolute)
    this.des = new Array(23).fill(0);
    this.rxPhase = 0;
    this.prevAng = 0;
    this.A = 1;
    this.outbits = [];
  }

  // ─── TX ──────────────────────────────────────────────────────────────────
  _scramble(bit) { const r = this.scr; const out = bit ^ r[17] ^ r[22]; r.unshift(out); r.pop(); return out; }
  _buildPreamble() {
    for (let k = 0; k < SEG_A; k++) this.txSyms.push((k & 1) ? 12 : 8); // (-5,0)/(5,0)
    for (let k = 0; k < SEG_B; k++) this.txSyms.push(8);                // (5,0)
  }
  write(bytes) {
    for (const by of bytes) for (let k = 0; k < 8; k++) this.txBits.push(this._scramble((by >> k) & 1));
  }
  _txSym(k) { return this.txSyms[k - this.txSymBase]; }
  _needSymbol(k) { // ensure absolute symbol k exists (append data or idle)
    while (this.txSyms.length + this.txSymBase <= k) {
      if (this.txBits.length < 4) { // idle: scrambled ones (like a real modem's fill)
        for (let z = 0; z < 4; z++) this.txBits.push(this._scramble(1));
      }
      const Q1 = this.txBits.shift(), Q2 = this.txBits.shift(), Q3 = this.txBits.shift(), Q4 = this.txBits.shift();
      this.txPhase = (this.txPhase + DPHASE[(Q2 << 2) | (Q3 << 1) | Q4]) & 7;
      this.txSyms.push((Q1 << 3) | this.txPhase);
    }
  }
  generateAudio(count) {
    const out = new Float32Array(count);
    let minK = Infinity;
    for (let c = 0; c < count; c++) {
      const n = this.n++; const st = n / SPS;
      const klo = Math.max(0, Math.ceil(st - SPAN / 2)), khi = Math.floor(st + SPAN / 2);
      if (klo < minK) minK = klo;
      this._needSymbol(khi);
      let ai = 0, aq = 0;
      for (let k = klo; k <= khi; k++) { const p = rrc(st - k); const s = C[this._txSym(k)]; ai += s.i * p; aq += s.q * p; }
      const ph = 2 * Math.PI * FC * n / SR;
      out[c] = (ai * Math.cos(ph) - aq * Math.sin(ph)) * 0.06; // ~0.35 peak
    }
    // Trim TX symbols that can never be referenced again.
    if (minK !== Infinity) {
      const keepFrom = Math.max(0, minK - TX_TRIM_MARGIN);
      const drop = keepFrom - this.txSymBase;
      if (drop >= TX_TRIM_CHUNK) { this.txSyms.splice(0, drop); this.txSymBase += drop; }
    }
    return out;
  }

  // ─── RX ──────────────────────────────────────────────────────────────────
  _bb(n) { const ph = 2 * Math.PI * FC * n / SR; const s = this.rx[n - this.rxBase]; return [s * Math.cos(ph) * 2, -s * Math.sin(ph) * 2]; }
  _sym(pos) { // matched filter at fractional (absolute) sample position pos
    const end = this.rxBase + this.rx.length - 1;
    const nlo = Math.max(this.rxBase, Math.ceil(pos - SPAN / 2 * SPS));
    const nhi = Math.min(end, Math.floor(pos + SPAN / 2 * SPS));
    let ai = 0, aq = 0;
    for (let n = nlo; n <= nhi; n++) { const b = this._bb(n); const p = rrc((n - pos) / SPS); ai += b[0] * p; aq += b[1] * p; }
    return [ai, aq];
  }
  get carrierDetected() { return this.acq; }
  get bps() { return 9600; }

  receiveAudio(f32) { for (let i = 0; i < f32.length; i++) this.rx.push(f32[i]); this._process(); }

  _process() {
    if (!this.acq) {
      // Pre-acquisition uses relative indices into rx (rxBase is still 0 here;
      // we never trim before acquiring).
      if (this.rx.length < (PRE + 12) * SPS + 64) return;
      // coarse energy onset
      let onset = -1, e = 0;
      for (let n = 0; n < this.rx.length; n++) { const b = this._bb(n); const m = Math.hypot(b[0], b[1]); e = 0.85 * e + 0.15 * m; if (e > 0.04) { onset = Math.max(0, n - 4); break; } }
      if (onset < 0) return;
      // fractional-phase lock: base maximising SEG_A energy
      let best = onset, bestScore = -1;
      for (let bo = Math.max(0, onset - 2 * SPS); bo <= onset + 2 * SPS; bo += SPS / 16) {
        let sc = 0; for (let k = 0; k < 12; k++) { const s = this._sym(bo + k * SPS); sc += Math.hypot(s[0], s[1]); }
        if (sc > bestScore) { bestScore = sc; best = bo; }
      }
      // alternating(SEG_A, Δ≈π) -> constant(SEG_B, Δ≈0) boundary = frame sync
      const nSy = PRE + 8, ang = [], mag = [];
      for (let j = 0; j < nSy; j++) { const s = this._sym(best + j * SPS); ang.push(Math.atan2(s[1], s[0])); mag.push(Math.hypot(s[0], s[1])); }
      const dphi = []; for (let j = 1; j < nSy; j++) { let d = ang[j] - ang[j - 1]; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; dphi.push(Math.abs(d)); }
      let jB = -1;
      for (let j = 3; j < dphi.length - 4; j++) {
        const preAlt = dphi[j - 1] > 2.0 && dphi[j - 2] > 2.0;
        const nowConst = dphi[j] < 0.6 && dphi[j + 1] < 0.6 && dphi[j + 2] < 0.6;
        if (preAlt && nowConst) { jB = j; break; }
      }
      if (jB < 0) { this.acq = false; return; }
      let gm = 0, cnt = 0; for (let j = jB + 1; j < jB + SEG_B - 1 && j < nSy; j++) { gm += mag[j]; cnt++; }
      this.A = (gm / Math.max(1, cnt)) / 5;
      const dataStart = jB + SEG_B;
      this.base = best; this.symIdx = dataStart;
      this.prevAng = ang[dataStart - 1]; this.rxPhase = 0;
      this.acq = true;
      if (!this._ready) { this._ready = true; this.emit('ready', { bps: 9600, remoteDetected: true }); }
    }
    // decode any symbols now fully buffered
    while (true) {
      const pos = this.base + this.symIdx * SPS;
      const end = this.rxBase + this.rx.length - 1;
      if (pos + SPAN / 2 * SPS >= end) break;         // not enough samples yet
      const s = this._sym(pos); const ang = Math.atan2(s[1], s[0]);
      let d = Math.round((ang - this.prevAng) / (Math.PI / 4)); d = ((d % 8) + 8) & 7; this.prevAng = ang;
      this.rxPhase = (this.rxPhase + d) & 7;
      const Q234 = DINV[d]; const r = Math.hypot(s[0], s[1]) / this.A;
      const thr = (this.rxPhase & 1) ? (Math.SQRT2 + 3 * Math.SQRT2) / 2 : 4; const Q1 = (r > thr) ? 1 : 0;
      const bits = [Q1, (Q234 >> 2) & 1, (Q234 >> 1) & 1, Q234 & 1];
      for (const bit of bits) { const r2 = this.des; const ob = bit ^ r2[17] ^ r2[22]; r2.unshift(bit); r2.pop(); this.outbits.push(ob); }
      this.symIdx++;
      while (this.outbits.length >= 8) { let by = 0; for (let k = 0; k < 8; k++) by |= this.outbits.shift() << k; this.emit('data', Buffer.from([by])); }
    }
    // Trim consumed RX samples (offset-indexed; phase uses absolute n so this
    // is pure storage compaction).
    if (this.acq) {
      const cursor = Math.floor(this.base + this.symIdx * SPS);
      const keepFrom = Math.max(0, cursor - RX_TRIM_MARGIN);
      const drop = keepFrom - this.rxBase;
      if (drop >= RX_TRIM_CHUNK) { this.rx.splice(0, drop); this.rxBase += drop; }
    }
  }
}

module.exports = { V29 };
