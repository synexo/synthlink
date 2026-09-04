'use strict';

/**
 * V.32 — 9600 bps, per ITU-T Recommendation V.32, "minimal 9600" profile:
 * the mandatory non-redundant (uncoded) 16-QAM mode every V.32 modem had to
 * support for interworking, operated as a TRUE FULL-DUPLEX continuous-carrier
 * modem (unlike our V.29, which is half-duplex ping-pong).
 *
 * ── Why full-duplex works here without an echo canceller ─────────────────────
 * Real V.32 is genuinely full-duplex: both modems transmit simultaneously in
 * the SAME voiceband using a single shared 1800 Hz carrier per direction, which
 * on a 2-wire PSTN line demands near/far adaptive ECHO CANCELLATION (each modem
 * must subtract its own 1800 Hz carrier from what it hears). That echo canceller
 * is the single hardest part of a V.32 implementation.
 *
 * Our transport is two independent WebSocket directions — a 4-wire equivalent.
 * Each direction carries exactly one carrier and nothing of our own transmit
 * leaks back into our receive, so the echo canceller is UNNECESSARY. This is the
 * same architectural payoff that let V.29 run clean; for V.32 it removes the
 * component that makes V.32 hard, so we get to keep genuine full-duplex.
 *
 * ── Why continuous full-duplex does NOT flood with idle bytes here ───────────
 * A continuous QAM carrier with a free-running receiver and no framing turns an
 * idle (all-ones) carrier into a flood of 0xFF bytes — the exact failure that
 * pushed V.29 to a burst design. V.32 avoids it the honest way: it is a
 * SYNCHRONOUS SCRAMBLED modem. The transmitter always emits a scrambled bit
 * stream; when there is no data it scrambles continuous MARK (all ones). We
 * carry the byte stream on top of that with async start/stop (UART) framing
 * exactly as a modem in direct async mode (AT\N0) does, so descrambled idle mark
 * produces NO start bit and therefore NO bytes. The carrier stays up (true
 * full-duplex idle fill), but the line is silent at the byte layer.
 *
 * ── What is genuine V.32 here ───────────────────────────────────────────────
 *   - Single carrier 1800 Hz, 2400 baud, 16-state non-redundant QAM,
 *     4 data bits/symbol = 9600 bps (ITU-T V.32 §5, non-redundant coding).
 *   - The two most-significant bits Q1,Q2 of each 4-bit group are DIFFERENTIALLY
 *     encoded into Y1,Y2 (quadrant) by modulo-4 recursive addition (Q2/Y2 the
 *     MSB), resolving the 90° phase ambiguity; Q3,Q4 select the point within the
 *     quadrant (absolute). The 16 points sit on the {±1,±3}² grid (Figure 1/
 *     Table 3 non-redundant constellation), so a whole-constellation rotation by
 *     any multiple of 90° cancels in the differential decoder (rotational
 *     invariance).
 *   - The real, role-asymmetric self-synchronising V.32 scramblers (§7):
 *       Call-mode (originate)  GPC = 1 + x^-18 + x^-23
 *       Answer-mode            GPA = 1 + x^-5  + x^-23
 *     Each end scrambles its transmit with its OWN generating polynomial and
 *     descrambles the peer's receive with the PEER's polynomial.
 *   - 2400 baud at 8 kHz => 3.333 samples/symbol, handled by continuous
 *     root-raised-cosine synthesis + fractional matched filtering (rolloff 0.25),
 *     the same fractional-SPS machinery proven in V.29.
 *   - An audible multi-segment startup: the answerer's 2100 Hz V.25 answer tone,
 *     then a harsh QAM training segment (AA), then the acquirable timing/gain
 *     preamble the receiver locks on. A genuine R1/R2/R3-style rate-signal
 *     exchange (the modem announces "9600" and reads the peer's) rides the head
 *     of the data stream.
 *
 * ── What is deliberately "genuine minimal" (documented, not hidden) ─────────
 *   - The 32-state TRELLIS-CODED (TCM) 9600 mode is NOT implemented. Minimum
 *     interworking only requires the non-redundant 16-QAM mode; TCM (and the
 *     larger constellations) belong to V.32bis (12000/14400) and are the next
 *     step up. No convolutional encoder / Viterbi decoder here.
 *   - No adaptive equalizer and no continuous timing tracking. The receiver
 *     acquires symbol timing, carrier phase and gain ONCE on the training
 *     preamble and then free-runs. This is sound on our transport specifically
 *     because both ends share the one lossless 8 kHz clock with zero drift (the
 *     same reason the clean-link flags are safe) — there is nothing to track.
 *     Against a real V.32 modem over a real line you would add the V.22bis-style
 *     T/2 fractional equalizer + timing recovery. Untested against real hardware.
 *   - The startup keeps the recognizable V.32 segment STRUCTURE (answer tone ->
 *     training -> preamble -> rate signal -> data) but omits the echo-canceller
 *     training segments (AC/CA phase reversals), which exist only to train the
 *     echo canceller our transport makes unnecessary.
 *
 * Interface (matches the other protocol classes so HandshakeEngine can drive it):
 * constructor(role); generateAudio(n)->Float32Array; receiveAudio(f32);
 * write(buf); emits 'data' (Buffer) and 'ready' ({bps, remoteDetected});
 * getters bps and carrierDetected.
 */

const { EventEmitter } = require('events');

const SR = 8000, BAUD = 2400, FC = 1800, SPS = SR / BAUD; // 3.333…
const ROLLOFF = 0.25, SPAN = 10;

// ── V.32 non-redundant 16-QAM constellation (Figure 1/Table 3) ───────────────
// Points on the {±1,±3}² grid. Y1Y2 (quadrant, differentially encoded) chooses
// the quadrant by rotating the quadrant-I base point by Y*90° CCW; Q3Q4 (point
// within quadrant, absolute) chooses the base point.
//   base index = (Q3<<1)|Q4 :  00->(1,1) 01->(1,3) 10->(3,1) 11->(3,3)
const BASE = [ { i: 1, q: 1 }, { i: 1, q: 3 }, { i: 3, q: 1 }, { i: 3, q: 3 } ];
// rotate (i,q) CCW by y quarter-turns: (i,q)->(-q,i)
function rotCCW(i, q, y) {
  switch (y & 3) {
    case 0: return { i, q };
    case 1: return { i: -q, q: i };
    case 2: return { i: -i, q: -q };
    default: return { i: q, q: -i };
  }
}
// rotate (i,q) CW by y quarter-turns (inverse of rotCCW): (i,q)->(q,-i)
function rotCW(i, q, y) {
  switch (y & 3) {
    case 0: return { i, q };
    case 1: return { i: q, q: -i };
    case 2: return { i: -i, q: -q };
    default: return { i: -q, q: i };
  }
}
// quadrant (0..3, CCW from +,+) of a sliced grid point
function quadOf(i, q) {
  if (i > 0 && q > 0) return 0;
  if (i < 0 && q > 0) return 1;
  if (i < 0 && q < 0) return 2;
  return 3;
}
// nearest odd grid level in {-3,-1,1,3}
function level(v) { return v >= 2 ? 3 : v >= 0 ? 1 : v >= -2 ? -1 : -3; }

// Reference training point: quadrant-I outer corner (3,3) == Y=0, base (3,3).
const REF = { i: 3, q: 3 };

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

// Amplitude of the transmitted passband (grid coords up to 3, |point| up to
// 3√2). Chosen so burst RMS ≈ 0.1 (matches the other protocols / the RX squelch).
const TX_GAIN = 0.09;

// Training preamble (symbols): SEG_A alternating outer corners (3,3)/(-3,-3) for
// AGC + fractional symbol-timing lock; SEG_B constant (3,3) for the gain/phase
// reference (complex channel estimate) and the alternating->constant frame-sync
// marker.
const SEG_A = 48, SEG_B = 24, PRE = SEG_A + SEG_B;

// ── Framing / scrambler warm-up ─────────────────────────────────────────────
const WARMUP_BITS   = 40;   // scrambled-mark bits after preamble: flush the
                            // filter turn-on and converge the self-sync
                            // descrambler before the first real start bit.
const UART_ARM_MARKS = 8;   // idle-mark run required before honouring a start bit

// ── RX carrier squelch (raw-sample |x| EWMA; carrier RMS ~0.1, gaps == exact 0).
// Only used to gate the pre-data handshake bursts (which are silence-separated)
// and to detect hangup; the continuous data carrier keeps rxOn latched.
const RX_A = 0.02, RX_HI = 0.015, RX_LO = 0.006, RX_HANG = 48;
const ACQ_MIN = Math.ceil((PRE + 10) * SPS);

// ── R1/R2/R3 rate-signal exchange (rides the head of the data stream) ────────
// After training each modem announces its rate and reads the peer's, before any
// user data. Carried as reserved control bytes ahead of the byte stream:
//   DLE 'R' hi lo   — rate signal (hi<<8|lo = rate/100, i.e. 0x0060 = 9600)
//   DLE 'D'         — end of rate signals, user data follows
const DLE = 0x10, CTL_RATE = 0x52 /*R*/, CTL_DATA = 0x44 /*D*/;
const RATE_CODE = 9600 / 100;                 // 96
const RATE_FRAME = [DLE, CTL_RATE, (RATE_CODE >> 8) & 0xff, RATE_CODE & 0xff];
const DATA_MARK  = [DLE, CTL_DATA];
const RATE_REPEATS = 3;

// ── Audible startup (V.25 answer tone + harsh QAM training) ──────────────────
const ANS_TONE_FREQ    = 2100;
const ANS_TONE_AMP     = 0.15;
const ANS_TONE_SAMPLES = Math.round(1.0 * SR);   // ~1.0 s answer tone (answerer)
const AATRAIN_SEG1     = Math.round(0.05 * BAUD); // ~50 ms unmodulated 1800 Hz (symbols)
const AATRAIN_ALT      = Math.round(0.20 * BAUD); // ~200 ms of reversals — the "harsh static"
const CONNECT_GAP      = Math.round(0.08 * SR);  // ~80 ms guard between pre-roll bursts (>= squelch hangup)
const ORIG_LEAD        = Math.round(0.60 * SR);  // originate holds off so the answerer's tone leads

class V32 extends EventEmitter {
  constructor(role) {
    super();
    this.role = role === 'originate' ? 'originate' : 'answer';
    this._ready = false;

    // Role-asymmetric scrambler taps (index a-1 for x^-a, plus x^-23 at 22).
    // originate transmits GPC(18) and receives GPA(5); answer is the mirror.
    if (this.role === 'originate') { this._txTap = 17; this._rxTap = 4; }
    else                           { this._txTap = 4;  this._rxTap = 17; }

    // ── TX ──
    this.txByteQ = [];            // user (BBS) bytes queued for transmission
    this.txCtrlQ = [];            // control bytes (rate signals) sent before data
    this.scr = new Array(23).fill(0);
    this.txState = 'idle';        // 'idle' | 'active'
    this.txMode = 'qam';          // 'qam' | 'tone'
    this._connectQ = this._buildConnectScript(this.role);
    this._idleSamples = 0;
    this._resetTxBurst();

    // ── RX ──
    this.rxLevel = 0;
    this.rxOn = false;
    this.rxLow = 0;
    this.peerRate = 0;            // rate the peer announced (R1/R2/R3), 0 until seen
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
  get bps() { return 9600; }

  write(bytes) { for (const by of bytes) this.txByteQ.push(by & 0xff); }

  // ─── scrambler / descrambler (self-synchronising, multiplicative) ──────────
  _scramble(bit) { const r = this.scr; const out = bit ^ r[this._txTap] ^ r[22]; r.unshift(out); r.pop(); return out; }

  // ─── TX ────────────────────────────────────────────────────────────────────
  _resetTxBurst() {
    this.txSyms = [];             // array of {i,q} constellation points
    this.txSymBase = 0;           // absolute symbol index of txSyms[0] (for trimming)
    this.txMode = 'qam';
    this.txN = 0;                 // monotonic sample index (carrier phase + RRC time)
    this.txPrevY = 0;             // differential quadrant state (reset per data flow)
    this.txFrame = null;          // current byte's framed bits, or null
    this.txFramePos = 0;
    this.txWarmup = 0;
    this.txEndSample = -1;        // >=0 => finite burst (handshake pre-roll); -1 => continuous
    this.txContinuous = false;    // the data flow: never ends, never turns the carrier off
    this.txPreDone = false;       // preamble emitted, into framed bits
  }

  _buildPreamble() {
    for (let k = 0; k < SEG_A; k++) this.txSyms.push((k & 1) ? { i: -3, q: -3 } : { i: 3, q: 3 });
    for (let k = 0; k < SEG_B; k++) this.txSyms.push({ i: 3, q: 3 });
  }

  // Ordered non-syncing pre-roll bursts, each preceded by `gap` idle samples.
  // The answerer leads with the 2100 Hz answer tone; both then emit the harsh
  // AA training; the final 'data' item lays the acquirable preamble and then
  // FLOWS INTO CONTINUOUS DATA (it never turns the carrier off again — that is
  // what makes this full-duplex rather than V.29's ping-pong).
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

  // Harsh AA training: short unmodulated 1800 Hz carrier then 0°/180° reversals.
  // Goes const->alternating then alternating->silence, so it never yields the
  // alternating->constant boundary the frame-sync scanner locks on.
  _buildAATrain() {
    for (let k = 0; k < AATRAIN_SEG1; k++) this.txSyms.push({ i: 3, q: 3 });
    for (let k = 0; k < AATRAIN_ALT;  k++) this.txSyms.push((k & 1) ? { i: -3, q: -3 } : { i: 3, q: 3 });
  }

  _startBurst(kind) {
    this._resetTxBurst();
    this.scr.fill(0);             // known scrambler state at turn-on

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
    // 'data' — the continuous full-duplex flow: preamble, then framed bits
    // forever. Queue the rate signals ahead of any user data.
    this._buildPreamble();
    this.txPrevY = 0;             // SEG_B point (3,3) == Y=0: differential origin
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
      return;
    }
    // After the scripted pre-roll, the continuous data flow is already running
    // and never returns here; nothing else to start.
  }

  // Next framed+scrambled TX bit. Warm-up marks, then control bytes (rate
  // signals), then user bytes, then idle mark — all async start/stop framed.
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
      // start(0), d0..d7 LSB-first, stop(1)
      this.txFrame = [0, by & 1, (by >> 1) & 1, (by >> 2) & 1, (by >> 3) & 1,
                      (by >> 4) & 1, (by >> 5) & 1, (by >> 6) & 1, (by >> 7) & 1, 1];
      this.txFramePos = 1;
      return this._scramble(0);
    }
    return this._scramble(1);     // idle mark (fills the continuous carrier)
  }

  // Ensure txSyms covers through ABSOLUTE symbol index k (txSyms[0] == symbol
  // this.txSymBase). Only the continuous data flow generates via the bit path;
  // the finite pre-roll bursts pre-fill txSyms directly.
  _ensureSymbols(k) {
    if (!this.txContinuous) return;
    while (this.txSymBase + this.txSyms.length <= k) {
      const Q1 = this._txBit(), Q2 = this._txBit(), Q3 = this._txBit(), Q4 = this._txBit();
      const Qval = (Q2 << 1) | Q1;               // Q2 is the MSB (V.32 §5)
      this.txPrevY = (this.txPrevY + Qval) & 3;   // differential quadrant (mod-4 add)
      const base = BASE[(Q3 << 1) | Q4];
      this.txSyms.push(rotCCW(base.i, base.q, this.txPrevY));
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
      const n = this.txN++;                       // monotonic: carrier phase never jumps
      if (!this.txContinuous && this.txEndSample >= 0 && n >= this.txEndSample) {
        this.txState = 'idle'; this._resetTxBurst(); break;
      }
      const st = n / SPS;                          // absolute symbol time
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
    // Continuous flow: drop shaped-out leading symbols so txSyms stays flat.
    // Only txSymBase moves; txN (carrier phase) is untouched.
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
    this.rxBase = 0;              // flow-local absolute sample index of rx[0]
    this.acq = false;
    this.base = 0;                // fractional sample of symbol 0 of the flow
    this.symIdx = 0;
    this.des = new Array(23).fill(0);
    this.gr = 1; this.gi = 0; this.g2 = 1;   // complex channel estimate
    this.rxPrevY = 0;
    this.outbits = [];
    this.uState = 'hunt'; this.uArmed = false; this.uMarks = 0; this.uBit = 0; this.uByte = 0;
    this._rxData = false;         // false => still consuming rate signals
    this._cState = 'idle';        // control parser: idle|esc|r1|r2
    this._cHi = 0;
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
        // Carrier gone. During the pre-data handshake this happens on the guard
        // silences (discard the non-syncing pre-roll and re-arm). Once we have
        // acquired the continuous data flow the carrier never drops except at
        // real hangup, so a drop then means teardown.
        this._process();
        this.rxOn = false;
        if (!this.acq) this._resetRx();
        else this._resetRx();     // hangup: full reset
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
      // fractional symbol-timing lock: maximise SEG_A energy
      let best = onset, bestScore = -1;
      for (let bo = Math.max(0, onset - 2 * SPS); bo <= onset + 2 * SPS; bo += SPS / 16) {
        let sc = 0; for (let k = 0; k < 12; k++) { const s = this._sym(bo + k * SPS); sc += Math.hypot(s[0], s[1]); }
        if (sc > bestScore) { bestScore = sc; best = bo; }
      }
      // alternating(SEG_A) -> constant(SEG_B) boundary == frame sync
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
      // complex channel estimate g from SEG_B (received ≈ g·REF, REF=(3,3))
      let mI = 0, mQ = 0, cnt = 0;
      for (let j = jB + 1; j < jB + SEG_B - 1 && j < nSy; j++) { mI += sIQ[j][0]; mQ += sIQ[j][1]; cnt++; }
      mI /= Math.max(1, cnt); mQ /= Math.max(1, cnt);
      // g = mean / REF  (complex divide by (3,3)):  g = mean·conj(REF)/|REF|²
      this.gr = (mI * REF.i + mQ * REF.q) / 18;
      this.gi = (mQ * REF.i - mI * REF.q) / 18;
      this.g2 = this.gr * this.gr + this.gi * this.gi || 1e-9;
      this.base = best; this.symIdx = jB + SEG_B;   // first data symbol
      this.rxPrevY = 0;                              // SEG_B == Y=0 reference
      this.acq = true;
      if (!this._ready) { this._ready = true; this.emit('ready', { bps: 9600, remoteDetected: true }); }
    }

    // Continuous decode of all fully-buffered symbols.
    while (true) {
      const pos = this.base + this.symIdx * SPS;
      const end = this.rxBase + this.rx.length - 1;
      if (pos + SPAN / 2 * SPS >= end) break;
      const s = this._sym(pos);
      // derotate + gain-normalise by the channel estimate: x = y·conj(g)/|g|²
      const xI = (s[0] * this.gr + s[1] * this.gi) / this.g2;
      const xQ = (s[1] * this.gr - s[0] * this.gi) / this.g2;
      const gi = level(xI), gq = level(xQ);
      const Y = quadOf(gi, gq);
      const b = rotCW(gi, gq, Y);                    // un-rotate to quadrant-I base
      const Q3 = (Math.abs(b.i) === 3) ? 1 : 0, Q4 = (Math.abs(b.q) === 3) ? 1 : 0;
      const Qval = (Y - this.rxPrevY) & 3; this.rxPrevY = Y;
      const Q1 = Qval & 1, Q2 = (Qval >> 1) & 1;
      const bits = [Q1, Q2, Q3, Q4];
      for (const bit of bits) { const r = this.des; const ob = bit ^ r[this._rxTap] ^ r[22]; r.unshift(bit); r.pop(); this.outbits.push(ob); }
      this.symIdx++;
      this._uartConsume();

      // Trim consumed samples to keep the continuous RX buffer flat. Preserve
      // rxBase so the carrier phase (derived from the flow-local index) is exact.
      const drop = Math.floor(this.base + (this.symIdx - SPAN) * SPS) - this.rxBase;
      if (drop > 512) { this.rx.splice(0, drop); this.rxBase += drop; }
    }
  }

  // Async start/stop deframer over the descrambled bit stream.
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

  // One deframed byte: strip the leading R1/R2/R3 rate signals, then pass user
  // data up. The rate signals never reach the terminal.
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
      case 'r2': this.peerRate = ((this._cHi << 8) | b) * 100; this._cState = 'idle'; break;
    }
  }
}

module.exports = { V32 };
