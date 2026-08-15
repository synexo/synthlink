'use strict';

/**
 * V.32bis — 14 400 bit/s, per ITU-T Recommendation V.32bis (1991), operated as
 * TRUE FULL-DUPLEX continuous carrier over our WebSocket transport, building
 * directly on the proven V.32 DSP core (`protocols/V32.js`). Same carrier
 * (1800 Hz), same symbol rate (2400 baud), same role-asymmetric scramblers —
 * V.32bis is the trellis-coded speed step up from V.32.
 *
 * ── Why full-duplex works here without an echo canceller ─────────────────────
 * Identical to V.32: real V.32bis is full-duplex on one shared 1800 Hz carrier
 * per direction and uses adaptive ECHO CANCELLATION (§1b) to separate the two
 * directions on a 2-wire line. Our two WebSocket directions are a 4-wire
 * equivalent — no self-carrier leaks into our receive — so the echo canceller is
 * unnecessary and we keep genuine full-duplex. As in V.32, the idle-`0xFF` flood
 * is avoided by carrying bytes with async start/stop (UART) framing over the
 * always-on scrambled synchronous stream: descrambled idle-mark yields no start
 * bit, hence no phantom bytes, while the carrier stays continuously up.
 *
 * ── What is genuine V.32bis here ────────────────────────────────────────────
 *   - 1800 Hz carrier, 2400 baud, **14 400 bit/s = 6 data bits/symbol** (§2.3.1).
 *   - The scrambled stream is grouped into six bits Q1..Q6. Q1Q2 are
 *     DIFFERENTIALLY encoded into Y1Y2 by the exact **Table 1/V.32bis** (the
 *     trellis-coding variant, distinct from the 4800 Table 2). Y1Y2 drive a
 *     **systematic convolutional encoder** producing the redundant bit Y0
 *     (Figure 1/V.32bis). The seven bits Y0Y1Y2Q3Q4Q5Q6 map to a point of the
 *     **128-point cross constellation** (Figure 2-1/V.32bis).
 *   - The real, role-asymmetric self-synchronising scramblers (§4) — call-mode
 *     `GPC = 1+x⁻¹⁸+x⁻²³`, answer-mode `GPA = 1+x⁻⁵+x⁻²³` — each end scrambles TX
 *     with its own polynomial and descrambles RX with the peer's. This
 *     implementation is bit-exact to the §5.2.3 golden vector (scrambling ones
 *     with GPC from the zero state yields 11 11 11 11 11 11 11 11 11 00 00 01…).
 *   - The **rate-signal exchange** (§5.3): each modem announces its available
 *     rates with the genuine **Table 5/V.32bis** bit positions (B5=4800, B6=9600,
 *     B9=7200, B10=12000, B12=14400) and the peer selects the highest common rate
 *     (14 400). Verified to round-trip (`peerRate === 14400` both sides).
 *   - An audible startup: the answerer's 2100 Hz V.25 answer tone, a harsh QAM
 *     training segment, then the acquirable timing/gain preamble.
 *
 * ── Genuine-minimal, documented (not hidden) ────────────────────────────────
 *   - **No Viterbi decoder.** The redundant trellis bit Y0 is genuinely produced
 *     and transmitted (real trellis-coded modulation on the wire), but the
 *     receiver recovers the six data bits by slicing to the nearest constellation
 *     point and reading them back, discarding Y0. Trellis coding buys ~4 dB of
 *     noise immunity; our transport is lossless, so slicing recovers the data
 *     exactly and the coding gain is simply unused. (Against a real line you would
 *     add the Viterbi decoder.) Consequently the exact set-partition/subset
 *     assignment of Figure 2-1 is not required for correctness; the 7-bit→point
 *     mapping here is a self-consistent bijection over the correct 128-cross
 *     constellation rather than a byte-for-byte copy of Figure 2-1, and the
 *     convolutional encoder is a genuine 8-state finite-state machine of the
 *     V.32 family rather than an independently golden-verified Wei code.
 *   - **No adaptive equalizer / no continuous timing tracking.** As in V.32 the
 *     receiver acquires symbol timing + complex channel gain + frame-sync ONCE on
 *     the preamble and free-runs — sound only because both ends share the one
 *     lossless 8 kHz clock (zero drift).
 *   - **Single operating rate (14 400).** The rate SIGNAL genuinely advertises the
 *     full V.32bis rate set and negotiates the max, but only 14 400 is wired for
 *     data; the multi-rate fallbacks (12000/9600/7200/4800) and the §8 rate
 *     renegotiation-without-retrain are the documented next step.
 *   - The **AC/CA echo-canceller-training segments are omitted** (they train the
 *     echo canceller the transport makes unnecessary). Untested against real
 *     V.32bis hardware.
 *   Reuses V.32's fractional-SPS (3.333) RRC synthesis + fractional matched
 *   filter (rolloff 0.25) at 1800 Hz.
 *
 * Interface matches the other protocol classes: constructor(role);
 * generateAudio(n)->Float32Array; receiveAudio(f32); write(buf); emits 'data'
 * (Buffer) and 'ready' ({bps, remoteDetected}); getters bps and carrierDetected.
 */

const { EventEmitter } = require('events');

const SR = 8000, BAUD = 2400, FC = 1800, SPS = SR / BAUD; // 3.333…
const ROLLOFF = 0.25, SPAN = 10;
const BITS = 6;                                 // 6 data bits/symbol => 14400

// ── 128-point cross constellation (Figure 2-1/V.32bis) ───────────────────────
// Odd-integer grid {±1,±3,±5,±7,±9,±11}² minus the 16 outer corners (points with
// |i|≥9 AND |q|≥9): 144 − 16 = 128. Ordered once; the 7 coded bits index it.
const LEVELS = [-11, -9, -7, -5, -3, -1, 1, 3, 5, 7, 9, 11];
const C128 = [];
for (const q of LEVELS) for (const i of LEVELS) {
  if (Math.abs(i) >= 9 && Math.abs(q) >= 9) continue;   // drop the 16 corners
  C128.push({ i, q });
}
// (C128.length === 128)
// nearest odd level in [-11,11]
function sliceOdd(v) { let r = Math.round((v - 1) / 2) * 2 + 1; return r > 11 ? 11 : r < -11 ? -11 : r; }
// slice a derotated point to the nearest valid 128-cross point
function slicePoint(xI, xQ) {
  let i = sliceOdd(xI), q = sliceOdd(xQ);
  if (Math.abs(i) >= 9 && Math.abs(q) >= 9) {            // fell in an excluded corner
    const a = { i: Math.sign(i) * 7, q }, b = { i, q: Math.sign(q) * 7 };
    const da = (xI - a.i) ** 2 + (xQ - a.q) ** 2, db = (xI - b.i) ** 2 + (xQ - b.q) ** 2;
    return da < db ? a : b;
  }
  return { i, q };
}
// point -> index (0..127) for bit recovery
const IDX = new Map();
for (let k = 0; k < C128.length; k++) IDX.set(C128[k].i * 100 + C128[k].q, k);

// ── Table 1/V.32bis — differential quadrant coding WITH trellis coding ───────
// din = (Q1<<1)|Q2 ; y = (Y1<<1)|Y2. TAB1[din][yPrev] = yNew.
const TAB1 = [
  [0, 1, 2, 3],   // Q1Q2 = 00
  [1, 0, 3, 2],   // Q1Q2 = 01
  [2, 3, 1, 0],   // Q1Q2 = 10
  [3, 2, 0, 1],   // Q1Q2 = 11
];
// inverse: INV1[yPrev][yNew] = din
const INV1 = [[], [], [], []];
for (let din = 0; din < 4; din++) for (let yp = 0; yp < 4; yp++) INV1[yp][TAB1[din][yp]] = din;

// Genuine 8-state systematic convolutional encoder (V.32 family). Produces the
// redundant bit Y0 from Y1,Y2 (Figure 1/V.32bis). Carried on the wire; NOT
// Viterbi-decoded on this lossless link (see header). Deterministic FSM so the
// transmitted point set is a real trellis-coded signal.
function convEncode(st, Y1, Y2) {
  const Y0 = st.c;
  const na = Y1 ^ st.c;
  const nb = st.a;
  const nc = st.b ^ (Y1 & Y2);
  st.a = na; st.b = nb; st.c = nc;
  return Y0;
}

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

// Passband amplitude. 128-cross coords run to ±11 (|point| up to √170); scaled
// so burst RMS ≈ 0.1 (matches the other protocols / the RX squelch).
const TX_GAIN = 0.016;

// Training preamble: SEG_A alternating (7,7)/(-7,-7) for AGC + symbol-timing;
// SEG_B constant (7,7) for the complex gain/phase reference and the
// alternating->constant frame-sync marker.
const REF = { i: 7, q: 7 };
const SEG_A = 48, SEG_B = 24, PRE = SEG_A + SEG_B;

const WARMUP_BITS   = 48;   // scrambled-mark bits after preamble (descrambler converge)
const UART_ARM_MARKS = 8;

const RX_A = 0.02, RX_HI = 0.015, RX_LO = 0.006, RX_HANG = 48;
const ACQ_MIN = Math.ceil((PRE + 10) * SPS);

// ── Rate signal (§5.3 / Table 5/V.32bis) ────────────────────────────────────
// Genuine Table 5 capability bit positions. Advertise the full V.32bis set; the
// receiver selects the highest common rate. Carried as reserved control bytes
// ahead of the byte stream (DLE 'R' hi lo = the 16-bit rate word; DLE 'D' ends).
const RATE_B = { 4800: 1 << 5, 9600: 1 << 6, 7200: 1 << 9, 12000: 1 << 10, 14400: 1 << 12 };
const RATE_WORD =                                   // B4,B7,B8,B11,B15 sync/framing + all rate bits
  (1 << 4) | (1 << 7) | (1 << 8) | (1 << 11) | (1 << 15) |
  RATE_B[4800] | RATE_B[9600] | RATE_B[7200] | RATE_B[12000] | RATE_B[14400];
function rateFromWord(w) {                           // highest advertised rate
  if (w & RATE_B[14400]) return 14400;
  if (w & RATE_B[12000]) return 12000;
  if (w & RATE_B[9600]) return 9600;
  if (w & RATE_B[7200]) return 7200;
  if (w & RATE_B[4800]) return 4800;
  return 0;
}
const DLE = 0x10, CTL_RATE = 0x52 /*R*/, CTL_DATA = 0x44 /*D*/;
const RATE_FRAME = [DLE, CTL_RATE, (RATE_WORD >> 8) & 0xff, RATE_WORD & 0xff];
const DATA_MARK  = [DLE, CTL_DATA];
const RATE_REPEATS = 3;

// ── Audible startup ─────────────────────────────────────────────────────────
const ANS_TONE_FREQ    = 2100;
const ANS_TONE_AMP     = 0.15;
const ANS_TONE_SAMPLES = Math.round(1.0 * SR);
const AATRAIN_SEG1     = Math.round(0.05 * BAUD);
const AATRAIN_ALT      = Math.round(0.20 * BAUD);
const CONNECT_GAP      = Math.round(0.08 * SR);
const ORIG_LEAD        = Math.round(0.60 * SR);

class V32bis extends EventEmitter {
  constructor(role) {
    super();
    this.role = role === 'originate' ? 'originate' : 'answer';
    this._ready = false;
    if (this.role === 'originate') { this._txTap = 17; this._rxTap = 4; }
    else                           { this._txTap = 4;  this._rxTap = 17; }
    this._rate = 14400;

    // TX
    this.txByteQ = [];
    this.txCtrlQ = [];
    this.scr = new Array(23).fill(0);
    this.txState = 'idle';
    this.txMode = 'qam';
    this._connectQ = this._buildConnectScript(this.role);
    this._idleSamples = 0;
    this._resetTxBurst();

    // RX
    this.rxLevel = 0;
    this.rxOn = false;
    this.rxLow = 0;
    this.peerRate = 0;
    this._resetRx();
  }

  get carrierDetected() { return this.rxOn || this.acq; }
  get bps() { return this._rate; }

  write(bytes) { for (const by of bytes) this.txByteQ.push(by & 0xff); }

  _scramble(bit) { const r = this.scr; const out = bit ^ r[this._txTap] ^ r[22]; r.unshift(out); r.pop(); return out; }

  // ─── TX ────────────────────────────────────────────────────────────────────
  _resetTxBurst() {
    this.txSyms = [];
    this.txSymBase = 0;
    this.txMode = 'qam';
    this.txN = 0;
    this.txPrevY = 0;                 // differential quadrant state
    this.txConv = { a: 0, b: 0, c: 0 }; // convolutional encoder state
    this.txFrame = null;
    this.txFramePos = 0;
    this.txWarmup = 0;
    this.txEndSample = -1;
    this.txContinuous = false;
  }

  _buildPreamble() {
    for (let k = 0; k < SEG_A; k++) this.txSyms.push((k & 1) ? { i: -7, q: -7 } : { i: 7, q: 7 });
    for (let k = 0; k < SEG_B; k++) this.txSyms.push({ i: 7, q: 7 });
  }

  _buildConnectScript(role) {
    if (role === 'answer') {
      return [
        { kind: 'tone',  gap: 0 },
        { kind: 'train', gap: CONNECT_GAP },
        { kind: 'data',  gap: CONNECT_GAP },
      ];
    }
    return [
      { kind: 'train', gap: ORIG_LEAD },
      { kind: 'data',  gap: CONNECT_GAP },
    ];
  }

  _buildAATrain() {
    for (let k = 0; k < AATRAIN_SEG1; k++) this.txSyms.push({ i: 7, q: 7 });
    for (let k = 0; k < AATRAIN_ALT;  k++) this.txSyms.push((k & 1) ? { i: -7, q: -7 } : { i: 7, q: 7 });
  }

  _startBurst(kind) {
    this._resetTxBurst();
    this.scr.fill(0);

    if (kind === 'tone') {
      this.txMode = 'tone';
      this.txEndSample = ANS_TONE_SAMPLES;
      this.txState = 'active';
      this._idleSamples = 0;
      return;
    }
    if (kind === 'train') {
      this._buildAATrain();
      this.txEndSample = Math.ceil((this.txSyms.length + SPAN / 2) * SPS);
      this.txState = 'active';
      this._idleSamples = 0;
      return;
    }
    // 'data' — continuous full-duplex flow: preamble then framed bits forever
    this._buildPreamble();
    this.txPrevY = 0;
    this.txConv = { a: 0, b: 0, c: 0 };
    this.txWarmup = WARMUP_BITS;
    this.txContinuous = true;
    this.txCtrlQ = [];
    for (let r = 0; r < RATE_REPEATS; r++) this.txCtrlQ.push(...RATE_FRAME);
    this.txCtrlQ.push(...DATA_MARK);
    this.txState = 'active';
    this._idleSamples = 0;
  }

  _maybeStartBurst() {
    if (this._connectQ.length) {
      if (this._idleSamples < this._connectQ[0].gap) return;
      this._startBurst(this._connectQ.shift().kind);
    }
  }

  _txBit() {
    if (this.txWarmup > 0) { this.txWarmup--; return this._scramble(1); }
    if (this.txFrame) {
      const b = this.txFrame[this.txFramePos++];
      if (this.txFramePos >= this.txFrame.length) this.txFrame = null;
      return this._scramble(b);
    }
    let by = null;
    if (this.txCtrlQ.length) by = this.txCtrlQ.shift();
    else if (this.txByteQ.length) by = this.txByteQ.shift();
    if (by !== null) {
      this.txFrame = [0, by & 1, (by >> 1) & 1, (by >> 2) & 1, (by >> 3) & 1,
                      (by >> 4) & 1, (by >> 5) & 1, (by >> 6) & 1, (by >> 7) & 1, 1];
      this.txFramePos = 1;
      return this._scramble(0);
    }
    return this._scramble(1);         // idle mark
  }

  // Generate one data symbol point from six scrambled bits.
  _dataSymbol() {
    const Q1 = this._txBit(), Q2 = this._txBit(), Q3 = this._txBit(),
          Q4 = this._txBit(), Q5 = this._txBit(), Q6 = this._txBit();
    const din = (Q1 << 1) | Q2;
    this.txPrevY = TAB1[din][this.txPrevY];          // differential (Table 1)
    const Y1 = (this.txPrevY >> 1) & 1, Y2 = this.txPrevY & 1;
    const Y0 = convEncode(this.txConv, Y1, Y2);       // redundant trellis bit
    const idx = (Y0 << 6) | (Y1 << 5) | (Y2 << 4) | (Q3 << 3) | (Q4 << 2) | (Q5 << 1) | Q6;
    return C128[idx];
  }

  _ensureSymbols(k) {
    if (!this.txContinuous) return;
    while (this.txSymBase + this.txSyms.length <= k) this.txSyms.push(this._dataSymbol());
  }

  generateAudio(count) {
    const out = new Float32Array(count);
    if (this.txState !== 'active') {
      this._maybeStartBurst();
      if (this.txState !== 'active') { this._idleSamples += count; return out; }
    }
    if (this.txMode === 'tone') {
      for (let c = 0; c < count; c++) {
        const n = this.txN++;
        if (this.txEndSample >= 0 && n >= this.txEndSample) { this.txState = 'idle'; this._resetTxBurst(); break; }
        out[c] = Math.sin(2 * Math.PI * ANS_TONE_FREQ * n / SR) * ANS_TONE_AMP;
      }
      return out;
    }
    for (let c = 0; c < count; c++) {
      const n = this.txN++;
      if (!this.txContinuous && this.txEndSample >= 0 && n >= this.txEndSample) {
        this.txState = 'idle'; this._resetTxBurst(); break;
      }
      const st = n / SPS;
      const klo = Math.max(0, Math.ceil(st - SPAN / 2)), khi = Math.floor(st + SPAN / 2);
      this._ensureSymbols(khi);
      let ai = 0, aq = 0;
      for (let k = Math.max(klo, this.txSymBase); k <= khi; k++) {
        const s = this.txSyms[k - this.txSymBase];
        if (!s) break;
        const p = rrc(st - k); ai += s.i * p; aq += s.q * p;
      }
      const ph = 2 * Math.PI * FC * n / SR;
      out[c] = (ai * Math.cos(ph) - aq * Math.sin(ph)) * TX_GAIN;
    }
    if (this.txContinuous) {
      const oldest = Math.floor(this.txN / SPS - SPAN) - 1;
      const drop = oldest - this.txSymBase;
      if (drop > 512) { this.txSyms.splice(0, drop); this.txSymBase += drop; }
    }
    return out;
  }

  // ─── RX ────────────────────────────────────────────────────────────────────
  _resetRx() {
    this.rx = [];
    this.rxBase = 0;
    this.acq = false;
    this.base = 0;
    this.symIdx = 0;
    this.des = new Array(23).fill(0);
    this.gr = 1; this.gi = 0; this.g2 = 1;
    this.rxPrevY = 0;
    this.outbits = [];
    this.uState = 'hunt'; this.uArmed = false; this.uMarks = 0; this.uBit = 0; this.uByte = 0;
    this._rxData = false;
    this._cState = 'idle'; this._cHi = 0;
  }

  _bb(n) { const ph = 2 * Math.PI * FC * n / SR; const s = this.rx[n - this.rxBase]; return [s * Math.cos(ph) * 2, -s * Math.sin(ph) * 2]; }
  _sym(pos) {
    const end = this.rxBase + this.rx.length - 1;
    const nlo = Math.max(this.rxBase, Math.ceil(pos - SPAN / 2 * SPS));
    const nhi = Math.min(end, Math.floor(pos + SPAN / 2 * SPS));
    let ai = 0, aq = 0;
    for (let n = nlo; n <= nhi; n++) { const b = this._bb(n); const p = rrc((n - pos) / SPS); ai += b[0] * p; aq += b[1] * p; }
    return [ai, aq];
  }

  receiveAudio(f32) {
    for (let i = 0; i < f32.length; i++) {
      const s = f32[i];
      this.rxLevel += RX_A * (Math.abs(s) - this.rxLevel);
      if (this.rxLevel > RX_HI) { this.rxOn = true; this.rxLow = 0; }
      else if (this.rxLevel < RX_LO && this.rxOn) { this.rxLow++; }
      if (this.rxOn) this.rx.push(s);
      if (this.rxOn && this.rxLow > RX_HANG) {
        this._process();
        this.rxOn = false;
        this._resetRx();
      }
    }
    if (this.rxOn) this._process();
  }

  _process() {
    if (!this.acq) {
      if (this.rx.length < ACQ_MIN) return;
      let onset = -1, e = 0;
      for (let n = 0; n < this.rx.length; n++) { const b = this._bb(n); const m = Math.hypot(b[0], b[1]); e = 0.85 * e + 0.15 * m; if (e > 0.04) { onset = Math.max(0, n - 4); break; } }
      if (onset < 0) return;
      let best = onset, bestScore = -1;
      for (let bo = Math.max(0, onset - 2 * SPS); bo <= onset + 2 * SPS; bo += SPS / 16) {
        let sc = 0; for (let k = 0; k < 12; k++) { const s = this._sym(bo + k * SPS); sc += Math.hypot(s[0], s[1]); }
        if (sc > bestScore) { bestScore = sc; best = bo; }
      }
      const nSy = PRE + 8, ang = [], mag = [], sIQ = [];
      for (let j = 0; j < nSy; j++) { const s = this._sym(best + j * SPS); ang.push(Math.atan2(s[1], s[0])); mag.push(Math.hypot(s[0], s[1])); sIQ.push(s); }
      const dphi = []; for (let j = 1; j < nSy; j++) { let d = ang[j] - ang[j - 1]; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; dphi.push(Math.abs(d)); }
      let jB = -1;
      for (let j = 3; j < dphi.length - 4; j++) {
        const preAlt = dphi[j - 1] > 2.0 && dphi[j - 2] > 2.0;
        const nowConst = dphi[j] < 0.6 && dphi[j + 1] < 0.6 && dphi[j + 2] < 0.6;
        if (preAlt && nowConst) { jB = j; break; }
      }
      if (jB < 0) return;
      let mI = 0, mQ = 0, cnt = 0;
      for (let j = jB + 1; j < jB + SEG_B - 1 && j < nSy; j++) { mI += sIQ[j][0]; mQ += sIQ[j][1]; cnt++; }
      mI /= Math.max(1, cnt); mQ /= Math.max(1, cnt);
      const R2 = REF.i * REF.i + REF.q * REF.q;      // |REF|² = 98
      this.gr = (mI * REF.i + mQ * REF.q) / R2;
      this.gi = (mQ * REF.i - mI * REF.q) / R2;
      this.g2 = this.gr * this.gr + this.gi * this.gi || 1e-9;
      this.base = best; this.symIdx = jB + SEG_B;
      this.rxPrevY = 0;
      this.acq = true;
      if (!this._ready) { this._ready = true; this.emit('ready', { bps: this._rate, remoteDetected: true }); }
    }

    while (true) {
      const pos = this.base + this.symIdx * SPS;
      const end = this.rxBase + this.rx.length - 1;
      if (pos + SPAN / 2 * SPS >= end) break;
      const s = this._sym(pos);
      const xI = (s[0] * this.gr + s[1] * this.gi) / this.g2;
      const xQ = (s[1] * this.gr - s[0] * this.gi) / this.g2;
      const p = slicePoint(xI, xQ);
      const idx = IDX.get(p.i * 100 + p.q);
      if (idx === undefined) { this.symIdx++; continue; }
      const Y1 = (idx >> 5) & 1, Y2 = (idx >> 4) & 1;
      const Q3 = (idx >> 3) & 1, Q4 = (idx >> 2) & 1, Q5 = (idx >> 1) & 1, Q6 = idx & 1;
      const yNew = (Y1 << 1) | Y2;
      const din = INV1[this.rxPrevY][yNew]; this.rxPrevY = yNew;   // differential decode
      const Q1 = (din >> 1) & 1, Q2 = din & 1;
      const bits = [Q1, Q2, Q3, Q4, Q5, Q6];
      for (const bit of bits) { const r = this.des; const ob = bit ^ r[this._rxTap] ^ r[22]; r.unshift(bit); r.pop(); this.outbits.push(ob); }
      this.symIdx++;
      this._uartConsume();

      const drop = Math.floor(this.base + (this.symIdx - SPAN) * SPS) - this.rxBase;
      if (drop > 512) { this.rx.splice(0, drop); this.rxBase += drop; }
    }
  }

  _uartConsume() {
    while (this.outbits.length) {
      const bit = this.outbits.shift();
      if (this.uState === 'hunt') {
        if (bit === 1) { if (!this.uArmed && this.uMarks < 255 && ++this.uMarks >= UART_ARM_MARKS) this.uArmed = true; }
        else if (this.uArmed) { this.uState = 'data'; this.uBit = 0; this.uByte = 0; }
      } else if (this.uState === 'data') {
        this.uByte |= (bit << this.uBit); this.uBit++;
        if (this.uBit === 8) this.uState = 'stop';
      } else {
        if (bit === 1) { this._rxByte(this.uByte & 0xff); this.uState = 'hunt'; }
        else { this.uState = 'hunt'; this.uArmed = false; this.uMarks = 0; }
      }
    }
  }

  _rxByte(b) {
    if (this._rxData) { this.emit('data', Buffer.from([b])); return; }
    switch (this._cState) {
      case 'idle': if (b === DLE) this._cState = 'esc'; break;
      case 'esc':
        if (b === CTL_RATE) this._cState = 'r1';
        else if (b === CTL_DATA) { this._rxData = true; this._cState = 'idle'; }
        else this._cState = 'idle';
        break;
      case 'r1': this._cHi = b; this._cState = 'r2'; break;
      case 'r2': {
        const word = (this._cHi << 8) | b;
        this.peerRate = rateFromWord(word);
        // Select the highest rate common to both ends (both advertise 14400).
        this._rate = Math.min(this._rate, this.peerRate) || this._rate;
        this._cState = 'idle';
        break;
      }
    }
  }
}

module.exports = { V32bis };
