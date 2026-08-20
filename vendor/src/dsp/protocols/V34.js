'use strict';

/**
 * V.34 — ITU-T V.34 (1998), operated as TRUE FULL-DUPLEX continuous carrier over
 * the SynthLink WebSocket transport, in the project's "genuine minimal" style
 * (see PROTOCOLS.md §0). Built on the proven V.32/V.32bis DSP core: same
 * fractional-SPS root-raised-cosine synthesis + fractional matched filter,
 * acquire-once/free-run receiver, role-asymmetric self-synchronising scramblers,
 * async UART framing over an always-on scrambled stream, and an in-band
 * control-frame capability exchange.
 *
 * ── Genuine V.34 here ────────────────────────────────────────────────────────
 *   - A real V.34 symbol rate + carrier. STAGE A uses S = 2400 baud with a
 *     1800 Hz carrier — a genuine V.34 configuration (V.34 symbol rates are
 *     2400·a/c; for S=2400 the low/high carriers are 1600/1800 Hz) that also
 *     lets us reuse the proven 3.333-SPS V.32bis front-end unchanged. (Higher
 *     rates S=3200/1829 Hz are a later stage.)
 *   - The genuine V.34 **grid constellation**: the energy-ordered subset of the
 *     odd-integer lattice {(i,q): i,q ∈ ±1,±3,±5,…} (V.34 §9.6.1). The lattice is
 *     invariant under negation and 90° rotation, as the V.34 4D differential /
 *     trellis coding requires. STAGE A carries 8 data bits/symbol over the 256
 *     lowest-energy points → 8·2400 = 19 200 bit/s.
 *   - The real, role-asymmetric self-synchronising scramblers — **identical to
 *     V.32/V.32bis** — call-mode GPC = 1+x⁻¹⁸+x⁻²³, answer-mode GPA = 1+x⁻⁵+x⁻²³
 *     (V.34 uses the same generators). Each end scrambles TX with its own
 *     polynomial and descrambles RX with the peer's. Bit-exact to the §5.2.3
 *     golden vector already verified project-wide.
 *   - Async start/stop (UART) framing; a capability exchange carrying the agreed
 *     bit rate; an audible startup (2100 Hz answer tone → training → preamble).
 *
 * ── Genuine-minimal, documented (not hidden) ────────────────────────────────
 *   Justified by the lossless, 4-wire-equivalent, drift-free transport (§0):
 *   - **No line probing / INFO exchange** (V.34 Phase 1–2). The symbol rate and
 *     carrier are fixed rather than chosen from channel measurements.
 *   - **No precoder** (§9.6.2). V.34's Tomlinson-Harashima-style precoder cancels
 *     channel ISI using the far-end response h[]; on a flat, ISI-free channel
 *     h≈[1,0,0] so the precoder output is ≈0 and Y≈U (the constellation point).
 *     It degenerates to identity here, exactly as V.32bis's Viterbi is unused.
 *   - **No non-linear warping** (§9.7, itself optional in the spec).
 *   - **No Viterbi decoder.** (STAGE A′ adds the genuine 16-state 4D trellis and
 *     carries U0 on the wire; the receiver slices and discards it — the ~coding
 *     gain is unused on a lossless link, as with V.32bis's Y0.)
 *   - **No adaptive equalizer / no continuous timing tracking** — acquire-once on
 *     the preamble then free-run, sound only on the shared zero-drift 8 kHz clock.
 *   - **Simplified startup:** the recognizable audible pre-roll + acquirable
 *     preamble instead of V.34's exact S/Ŝ/PP/TRN/MP/E/J/JP segment state machine.
 *   - **Single rate for now** (19200/2400); multi-rate + higher symbol rates
 *     (3200 baud → 28800/33600) are later stages (see PROTOCOLS.md §7).
 *
 * The genuine encode chain — shell-mapping constellation shaping (§9.4), 4D
 * differential coding (§9.5), the Figure-10 16-state 4D trellis on the wire
 * (§9.6.3), and the quarter-superconstellation ring/point mapper (§9.6.1) — lives
 * in V34Mapper.js and is exercised bit-exact by tools/v34-map-check.js.
 *
 * Interface matches the other protocol classes: constructor(role);
 * generateAudio(n)->Float32Array; receiveAudio(f32); write(buf); emits 'data'
 * (Buffer) and 'ready' ({bps, remoteDetected}); getters bps and carrierDetected.
 */

const { EventEmitter } = require('events');

// ── Genuine V.34 encode chain (shell map + 4D differential + 16-state trellis +
// mapper), §9.3–9.6, provided by V34Coder. A mapping frame is CFG.frameBits
// scrambled bits → CFG.symsPerFrame (8) constellation points, and back. See
// V34Mapper.js. Data-mode configuration (symbol rate + bit rate) is selected here.
const { V34Coder, makeConfig, CONFIGS, sliceOdd, invRot } = require('./V34Mapper');
const config = require('../../../config');

// ── Per-symbol-rate RF front-end (genuine V.34 carrier, Table 2). Roll-off/span
// are the largest excess bandwidth that keeps the occupied band FC ± S/2·(1+β)
// inside (0, 4000) Hz at 8 kHz while opening the eye — each verified in
// tools/v34-eye.js. 3429 is razor-thin (lower edge ≈ 4 Hz) but sound on the
// lossless link (span 32 at β=0.14 → 0 slice errors, eye test).
const RF = {
  2400: { fc: 1800, rolloff: 0.25, span: 10 },
  3200: { fc: 1920, rolloff: 0.20, span: 24 },
  3429: { fc: 1959, rolloff: 0.14, span: 32 },
};
// ── Per-constellation amplitude (shaped mean symbol energy + preamble reference),
// measured from the shell-shaped point distribution (tools/v34-map-check.js).
// meanE sets the TX gain (data-burst RMS ≈ 0.1); |REF| ≈ sqrt(meanE) so the
// preamble sits at the data level. Keyed by rate because two rates share sRate=3200
// but have different constellation sizes (28800 L=768 vs 31200 L=1280).
const AMP = {
  '19200/2400': { meanE: 214, ref: { i: 9,  q: 9  } },
  '28800/3200': { meanE: 427, ref: { i: 15, q: 15 } },
  '31200/3200': { meanE: 725, ref: { i: 19, q: 19 } },
  '33600/3429': { meanE: 725, ref: { i: 19, q: 19 } },
};

// Resolve the per-call rate from the shared config singleton (mutated by the
// server/client just before DSP construction, exactly like protocolPreference).
// Accepts a rate-name ('33600/3429') or a bps number (33600); defaults to the
// highest available. Unknown values fall back to the max.
const RATE_ALIASES = { 19200: '19200/2400', 28800: '28800/3200', 31200: '31200/3200', 33600: '33600/3429' };
const DEFAULT_RATE = '33600/3429';
function resolveRateName() {
  const sel = config.modem && config.modem.native && config.modem.native.v34Rate;
  if (typeof sel === 'string' && CONFIGS[sel]) return sel;
  if (typeof sel === 'number' && RATE_ALIASES[sel]) return RATE_ALIASES[sel];
  if (typeof sel === 'string' && RATE_ALIASES[+sel]) return RATE_ALIASES[+sel];
  return DEFAULT_RATE;
}

// ── Rate-dependent state, (re)built by configure(). Method bodies reference these
// module bindings; both ends of a link share the config singleton and select the
// same rate, so configure() runs once per process for the active rate (it re-runs
// only if a later construction selects a different rate — e.g. a test sweeping
// rates). This mirrors the shared-singleton contract in CLAUDE.md.
const SR = 8000;
const SYMS_PER_FRAME = 8;
const SEG_A = 48, SEG_B = 24, PRE = SEG_A + SEG_B;
const WARMUP_BITS = 48, UART_ARM_MARKS = 8;
const RX_A = 0.02, RX_HI = 0.015, RX_LO = 0.006, RX_HANG = 48;
const DLE = 0x10, CTL_RATE = 0x52 /*R*/, CTL_DATA = 0x44 /*D*/;
const DATA_MARK = [DLE, CTL_DATA], RATE_REPEATS = 3;
const ANS_TONE_FREQ = 2100, ANS_TONE_AMP = 0.15, ANS_TONE_SAMPLES = Math.round(1.0 * SR);
const CONNECT_GAP = Math.round(0.08 * SR), ORIG_LEAD = Math.round(0.60 * SR);

let CURRENT_RATE = null;
let CFG, FE, labelOf, BAUD, FC, SPS, ROLLOFF, SPAN, RRC_G = 1;
let MEAN_E, TX_GAIN, REF, ACQ_MIN, RATE_BPS, RATE_FRAME, AATRAIN_SEG1, AATRAIN_ALT;

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
const rrc = t => rrcAt(t) * RRC_G;

function configure(rateName) {
  if (rateName === CURRENT_RATE) return;
  CFG = makeConfig(CONFIGS[rateName]);
  FE = RF[CFG.sRate];
  const amp = AMP[rateName];
  labelOf = CFG.labelOf;
  BAUD = CFG.sRate; FC = FE.fc; SPS = SR / BAUD; ROLLOFF = FE.rolloff; SPAN = FE.span;
  { let s = 0; for (let k = -SPAN * 4; k <= SPAN * 4; k++) s += rrcAt(k / 4) ** 2; RRC_G = 1 / Math.sqrt(s / 4); }
  MEAN_E = amp.meanE;
  TX_GAIN = 0.1 / Math.sqrt(MEAN_E) * Math.SQRT2 * 0.999;   // data-burst RMS ≈ 0.1
  REF = amp.ref;
  ACQ_MIN = Math.ceil((PRE + 10) * SPS);
  RATE_BPS = CFG.bitRate;                                   // advertised (nominal) rate
  RATE_FRAME = [DLE, CTL_RATE, (RATE_BPS >> 8) & 0xff, RATE_BPS & 0xff];
  AATRAIN_SEG1 = Math.round(0.05 * BAUD);
  AATRAIN_ALT  = Math.round(0.20 * BAUD);
  CURRENT_RATE = rateName;
}
configure(DEFAULT_RATE);   // module-load default; re-resolved per construction below

class V34 extends EventEmitter {
  constructor(role) {
    super();
    configure(resolveRateName());   // pick this call's rate from the shared config singleton
    this.role = role === 'originate' ? 'originate' : 'answer';
    this._ready = false;
    if (this.role === 'originate') { this._txTap = 17; this._rxTap = 4; }
    else                           { this._txTap = 4;  this._rxTap = 17; }
    this._rate = RATE_BPS;

    // TX
    this.txByteQ = [];
    this.txCtrlQ = [];
    this.scr = new Array(23).fill(0);
    this.txCoder = new V34Coder(CFG);
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
    this.rxCoder = new V34Coder(CFG);
    this._resetRx();
  }

  /**
   * Handshake tells us a genuine V.8 exchange (ANSam/CM/JM/CJ) already ran.
   * The answerer's ANSam has therefore been heard and this class must not emit
   * its own 2100 Hz answer tone on top of it — a second tone lands during the
   * peer's post-CJ training and trips its energy-onset acquisition.
   */
  setV8Complete(done) {
    if (!done) return;
    this._connectQ = this._connectQ.filter(step => step.kind !== 'tone');
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
    this.txFrame = null;
    this.txFramePos = 0;
    this.txWarmup = 0;
    this.txEndSample = -1;
    this.txContinuous = false;
    this.txFrameIdx = 0;      // mapping-frame counter for §8.2 switching (reset per data burst)
  }

  _buildPreamble() {
    for (let k = 0; k < SEG_A; k++) this.txSyms.push((k & 1) ? { i: -REF.i, q: -REF.q } : { i: REF.i, q: REF.q });
    for (let k = 0; k < SEG_B; k++) this.txSyms.push({ i: REF.i, q: REF.q });
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
    for (let k = 0; k < AATRAIN_SEG1; k++) this.txSyms.push({ i: REF.i, q: REF.q });
    for (let k = 0; k < AATRAIN_ALT;  k++) this.txSyms.push((k & 1) ? { i: -REF.i, q: -REF.q } : { i: REF.i, q: REF.q });
  }

  _startBurst(kind) {
    this._resetTxBurst();
    this.scr.fill(0);
    this.txCoder.reset();

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

  // Encode one mapping frame: this frame's parity (high/low, §8.2) comes from the
  // SWP-driven frame counter; pull the matching bit count (b or b−1) of scrambled
  // bits, run the genuine V.34 chain (shell map + differential + trellis + mapper)
  // → SYMS_PER_FRAME points. For the all-high configs this is always b bits.
  _encodeFrameSymbols() {
    const idx = this.txFrameIdx++;
    const high = CFG.isHighFrame(idx);
    const nb = high ? CFG.frameBitsHigh : CFG.frameBitsLow;
    const bits = new Array(nb);
    for (let i = 0; i < nb; i++) bits[i] = this._txBit();
    return this.txCoder.encodeFrame(bits, high);
  }

  _ensureSymbols(k) {
    if (!this.txContinuous) return;
    while (this.txSymBase + this.txSyms.length <= k) {
      const pts = this._encodeFrameSymbols();
      for (const p of pts) this.txSyms.push(p);
    }
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
    this.outbits = [];
    this.rxPts = [];                 // sliced points accumulating toward one mapping frame
    this.rxFrameIdx = 0;             // mapping-frame counter, aligned to TX frame 0 at acquisition
    this.rxCoder.reset();
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
      // Fractional symbol-timing search. The step must resolve the ISI-free instant:
      // at the tightest rate (3429, 2.33 SPS, β=0.14) the eye is sharp enough that a
      // ~0.07-sample timing error tips the slicer (SPS/16 → ~99% symbol errors, SPS/64
      // → 0; see tools/v34-eye.js / rx timing sweep). SPS/64 is a one-time acquisition
      // cost and leaves the wider 2400/3200 eyes unaffected.
      for (let bo = Math.max(0, onset - 2 * SPS); bo <= onset + 2 * SPS; bo += SPS / 64) {
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
      const R2 = REF.i * REF.i + REF.q * REF.q;
      this.gr = (mI * REF.i + mQ * REF.q) / R2;
      this.gi = (mQ * REF.i - mI * REF.q) / R2;
      this.g2 = this.gr * this.gr + this.gi * this.gi || 1e-9;
      this.base = best; this.symIdx = jB + SEG_B;
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
      // slice to the nearest odd-integer lattice point (the transmitted point on
      // the lossless link); guard against a rep outside the quarter set.
      const pt = { i: sliceOdd(xI), q: sliceOdd(xQ) };
      this.symIdx++;
      if (labelOf(invRot(pt).rep) < 0) { this.rxPts = []; continue; }  // resync on stray point
      this.rxPts.push(pt);
      if (this.rxPts.length === SYMS_PER_FRAME) {
        // This frame's parity is fixed by the SWP-driven counter, aligned to the TX
        // because acquisition lands on TX frame 0 and both advance in lockstep on
        // the drift-free clock. decodeFrame returns b (high) or b−1 (low) bits.
        const high = CFG.isHighFrame(this.rxFrameIdx++);
        const fbits = this.rxCoder.decodeFrame(this.rxPts, high);
        this.rxPts = [];
        for (let b = 0; b < fbits.length; b++) {
          const bit = fbits[b];
          const r = this.des; const ob = bit ^ r[this._rxTap] ^ r[22]; r.unshift(bit); r.pop(); this.outbits.push(ob);
        }
        this._uartConsume();
      }

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
        this.peerRate = (this._cHi << 8) | b;
        this._rate = Math.min(this._rate, this.peerRate) || this._rate;
        this._cState = 'idle';
        break;
      }
    }
  }
}

module.exports = { V34 };
