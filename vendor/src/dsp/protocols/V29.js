'use strict';

/**
 * V.29 — 9600 bps, per ITU-T Recommendation V.29 (11/1988), operated as a
 * HALF-DUPLEX PING-PONG data modem in the manner of the consumer 9600 modems
 * that used V.29 modulation before full-duplex V.32 existed.
 *
 * ── Why ping-pong (the honest history) ──────────────────────────────────────
 * V.29 is a half-duplex 16-QAM modem. Full-duplex 9600 on an ordinary 2-wire
 * dial-up line was not possible without echo cancellation — that is precisely
 * what V.32 added later. So before V.32, a consumer who wanted 9600 over V.29
 * modulation on a normal phone line used a HALF-DUPLEX PING-PONG scheme: the
 * modem buffers data locally, blasts a burst of V.29 in one direction, then
 * turns the line around for the reverse burst. The Hayes V-series "Express 96"
 * is the canonical example (standard V.29 16-QAM at 9600, run half-duplex with
 * local buffering and line-reversal turnaround). This class emulates that.
 *
 * Our transport is two independent WebSocket directions (a 4-wire equivalent),
 * so strictly we COULD run full-duplex — but that is not how a consumer used
 * V.29 on a real line, and (just as importantly) a continuous full-duplex V.29
 * carrier has no way to distinguish an idle carrier from data and floods the
 * peer with descrambled idle bytes. Emulating the Express 96 burst discipline
 * is both the honest representation and the clean fix: the carrier is present
 * only during a burst, the receiver re-acquires per burst (which is exactly
 * what this DSP's preamble acquisition front-end is built for), and idle is
 * true silence — no phantom bytes.
 *
 * ── What is genuine V.29 here ───────────────────────────────────────────────
 *   - The real V.29 16-point constellation (spandsp point ordering): two
 *     amplitude rings, 3/5 on the on-axis phases, sqrt(2)/3*sqrt(2) diagonal.
 *   - Real V.29 encoding: differential PHASE (Q2 Q3 Q4 -> phase change, §4
 *     table) + absolute AMPLITUDE (Q1). 2400 baud, 4 bits/symbol = 9600 bps.
 *   - The real V.29 self-synchronising scrambler, 1 + x^-18 + x^-23, reset at
 *     the head of each burst (a genuine V.29 turn-on scrambles from a known
 *     state; the descrambler is self-synchronising within 23 bits regardless).
 *   - 1700 Hz carrier; 2400 baud => 3.333 samples/symbol at 8 kHz, via
 *     continuous root-raised-cosine synthesis + fractional matched filtering
 *     (rolloff 0.25).
 *   - The preamble is the V.29-style two-segment turn-on: an alternating
 *     segment (SEG_A) for AGC + symbol-timing recovery, then a constant
 *     segment (SEG_B) whose alternating->constant boundary is the frame-sync
 *     marker and phase/gain seed.
 *
 * ── The async framing layer (genuine "direct-mode" modem behaviour) ─────────
 * Data bytes are carried with start/stop (UART) framing: each byte is 1 start
 * bit (space=0), 8 data bits LSB-first, 1 stop bit (mark=1). Between bytes and
 * during turn-on warm-up/trailer the line is mark (1). This is exactly how a
 * modem in direct async mode (AT\N0) carries data, and it makes idle within a
 * burst emit nothing — only a start bit begins a byte. (No V.42; raw async.)
 *
 * ── Line discipline / turnaround ────────────────────────────────────────────
 *   - Each end starts with one short training burst (preamble + mark) so the
 *     peer acquires and we fire 'ready' (== "connected"). Both sides do this
 *     regardless of what they hear, so mutual training can't deadlock.
 *   - A data burst is sent only when the line is free (we are not currently
 *     receiving a peer burst) — the ping-pong courtesy. Bursts are capped at
 *     MAX_BURST_BYTES so a long download is a train of bursts with gaps,
 *     leaving room for the reverse direction (a keystroke, an abort) to take a
 *     turn. This reproduces Express 96's "high latency under heavy two-way
 *     traffic" trade-off.
 *   - While idle we emit a periodic short keepalive burst so the peer's RX and
 *     the DSP's silence-hangup timer never see a dead line during quiet reading.
 *
 * Interface (unchanged, matches the other protocol classes so HandshakeEngine
 * can drive it): constructor(role); generateAudio(n)->Float32Array;
 * receiveAudio(f32); write(buf); emits 'data' (Buffer) and 'ready'
 * ({bps, remoteDetected}); getters bps and carrierDetected.
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

// ── Burst / framing / squelch parameters ────────────────────────────────────
const WARMUP_BITS   = 40;   // scrambled-mark bits after preamble: flushes the
                            // filter turn-on and lets the self-sync descrambler
                            // converge before the first real start bit.
const TRAILER_SYMS  = 12;   // scrambled-mark symbols after the last data byte,
                            // so the final byte filters out before carrier drop
                            // (>= SPAN to fully shape the last data symbol).
const MAX_BURST_BYTES = 256; // line-turnaround cap: a long transfer becomes a
                            // train of bursts, leaving gaps for reverse traffic.
const KEEPALIVE_GAP = Math.round(1.2 * SR); // idle this long -> keepalive burst.
// Turnaround guard time: mandatory silence after any burst before the next one
// may start, so the peer's receiver has time to detect carrier-drop, reset, and
// re-acquire the fresh preamble. This is the ping-pong line-reversal guard time;
// it also paces a long multi-burst transfer into cleanly separable bursts.
const TURNAROUND_GUARD = 360; // samples (~45 ms)

// RX carrier squelch (raw-sample |x| EWMA; burst RMS ~0.1, idle == exact 0).
const RX_A = 0.02, RX_HI = 0.015, RX_LO = 0.006, RX_HANG = 48;

// Minimum RX samples before attempting acquisition (preamble + frame-sync scan).
const ACQ_MIN = Math.ceil((PRE + 10) * SPS);

// UART: require a run of idle mark bits before honouring a start bit, so bit
// decisions made while the self-sync descrambler is still converging at burst
// turn-on (up to 23 bits) can't fake a leading frame. The warm-up is longer
// than this, so a real first byte is never missed.
const UART_ARM_MARKS = 8;

class V29 extends EventEmitter {
  constructor(role) {
    super();
    this.role = role || 'answer'; // symmetric; retained for parity/logging
    this._ready = false;

    // ── TX (burst engine) ──
    this.txByteQ = [];            // bytes queued for transmission
    this.scr = new Array(23).fill(0);
    this.txState = 'idle';        // 'idle' | 'active'
    this._needInitialTrain = true;
    this._idleSamples = 0;
    this._resetTxBurst();

    // ── RX (per-burst acquire + async deframe) ──
    this.rxLevel = 0;
    this.rxOn = false;
    this.rxLow = 0;
    this._resetRx();
  }

  get carrierDetected() { return this.rxOn || this.acq; }
  get bps() { return 9600; }

  write(bytes) { for (const by of bytes) this.txByteQ.push(by & 0xff); }

  // ─── TX ──────────────────────────────────────────────────────────────────
  _scramble(bit) { const r = this.scr; const out = bit ^ r[17] ^ r[22]; r.unshift(out); r.pop(); return out; }

  _resetTxBurst() {
    this.txSyms = [];
    this.txBurstN = 0;            // burst-local sample index (carrier + RRC)
    this.txPhase = 0;
    this.txFrame = null;          // current byte's framed bits, or null
    this.txFramePos = 0;
    this.txWarmup = 0;
    this.txBurstBytes = 0;
    this.txDataDone = false;      // no more data this burst -> trailer marks
    this.txTrailerSyms = 0;
    this.txEndSample = -1;        // absolute burst-local sample to stop at
  }

  _buildPreamble() {
    for (let k = 0; k < SEG_A; k++) this.txSyms.push((k & 1) ? 12 : 8); // (-5,0)/(5,0)
    for (let k = 0; k < SEG_B; k++) this.txSyms.push(8);                // (5,0)
  }

  _startBurst(kind) {
    this._resetTxBurst();
    this.scr.fill(0);             // known scrambler state at turn-on
    this.txWarmup = WARMUP_BITS;
    this._buildPreamble();
    if (kind === 'train') this.txDataDone = true; // train/keepalive: no payload
    this.txState = 'active';
    this._idleSamples = 0;
  }

  _maybeStartBurst() {
    if (this._needInitialTrain) { this._needInitialTrain = false; this._startBurst('train'); return; }
    // Every subsequent burst waits out the turnaround guard, so the peer can
    // detect our previous carrier-drop and re-acquire the next preamble cleanly.
    if (this._idleSamples < TURNAROUND_GUARD) return;
    // Data burst only when the line is free (ping-pong courtesy). Leftover bytes
    // from a capped burst simply ride the next one.
    if (this.txByteQ.length && !this.rxOn) { this._startBurst('data'); return; }
    // Keepalive only while we're not receiving (a live RX already keeps us alive).
    if (!this.rxOn && this._idleSamples >= KEEPALIVE_GAP) { this._startBurst('train'); return; }
  }

  // Next framed+scrambled TX bit. Sets txDataDone when it begins trailer marks.
  _txBit() {
    if (this.txWarmup > 0) { this.txWarmup--; return this._scramble(1); }
    if (this.txFrame) {
      const b = this.txFrame[this.txFramePos++];
      if (this.txFramePos >= this.txFrame.length) this.txFrame = null;
      return this._scramble(b);
    }
    if (!this.txDataDone && this.txBurstBytes < MAX_BURST_BYTES && this.txByteQ.length) {
      const by = this.txByteQ.shift(); this.txBurstBytes++;
      // start(0), d0..d7 LSB-first, stop(1)
      this.txFrame = [0, by & 1, (by >> 1) & 1, (by >> 2) & 1, (by >> 3) & 1,
                      (by >> 4) & 1, (by >> 5) & 1, (by >> 6) & 1, (by >> 7) & 1, 1];
      this.txFramePos = 1;
      return this._scramble(0);
    }
    this.txDataDone = true;       // no (more) data -> trailer / idle mark
    return this._scramble(1);
  }

  _ensureSymbols(k) {
    while (this.txSyms.length <= k) {
      if (this.txEndSample >= 0) break;
      const Q1 = this._txBit(), Q2 = this._txBit(), Q3 = this._txBit(), Q4 = this._txBit();
      this.txPhase = (this.txPhase + DPHASE[(Q2 << 2) | (Q3 << 1) | Q4]) & 7;
      this.txSyms.push((Q1 << 3) | this.txPhase);
      if (this.txDataDone) {
        this.txTrailerSyms++;
        if (this.txTrailerSyms >= TRAILER_SYMS) {
          // Stop after enough samples to shape all symbols we've emitted.
          this.txEndSample = Math.ceil(this.txSyms.length * SPS);
        }
      }
    }
  }

  generateAudio(count) {
    const out = new Float32Array(count);
    if (this.txState !== 'active') {
      this._maybeStartBurst();
      if (this.txState !== 'active') { this._idleSamples += count; return out; }
    }
    for (let c = 0; c < count; c++) {
      const bn = this.txBurstN++;
      if (this.txEndSample >= 0 && bn >= this.txEndSample) {
        // Burst finished mid-block: go silent for the remainder (already zeros).
        this.txState = 'idle';
        this._resetTxBurst();
        break;
      }
      const st = bn / SPS;
      const klo = Math.max(0, Math.ceil(st - SPAN / 2)), khi = Math.floor(st + SPAN / 2);
      this._ensureSymbols(khi);
      let ai = 0, aq = 0;
      const top = Math.min(khi, this.txSyms.length - 1);
      for (let k = klo; k <= top; k++) { const p = rrc(st - k); const s = C[this.txSyms[k]]; ai += s.i * p; aq += s.q * p; }
      const ph = 2 * Math.PI * FC * bn / SR;
      out[c] = (ai * Math.cos(ph) - aq * Math.sin(ph)) * 0.06; // ~0.35 peak
    }
    return out;
  }

  // ─── RX ──────────────────────────────────────────────────────────────────
  _resetRx() {
    this.rx = [];
    this.rxBase = 0;              // kept 0 within a burst (no cross-burst carry)
    this.acq = false;
    this.base = 0;                // fractional sample of symbol 0
    this.symIdx = 0;
    this.des = new Array(23).fill(0);
    this.rxPhase = 0;
    this.prevAng = 0;
    this.A = 1;
    this.outbits = [];
    // async UART deframer. `uArmed` latches once we've seen enough idle mark to
    // trust a start bit (rejects descrambler-convergence noise at burst turn-on);
    // it then stays armed between back-to-back bytes (a single stop bit suffices)
    // and only clears on a framing error, which forces a re-sync on fresh idle.
    this.uState = 'hunt';         // 'hunt' | 'data' | 'stop'
    this.uArmed = false;
    this.uMarks = 0;
    this.uBit = 0;
    this.uByte = 0;
  }

  _bb(n) { const ph = 2 * Math.PI * FC * n / SR; const s = this.rx[n - this.rxBase]; return [s * Math.cos(ph) * 2, -s * Math.sin(ph) * 2]; }
  _sym(pos) { // matched filter at fractional (burst-local) sample position pos
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
        // Peer carrier dropped: finish decoding this burst, then re-arm.
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
      if (jB < 0) return;         // not synced yet; wait for more of the burst
      let gm = 0, cnt = 0; for (let j = jB + 1; j < jB + SEG_B - 1 && j < nSy; j++) { gm += mag[j]; cnt++; }
      this.A = (gm / Math.max(1, cnt)) / 5;
      const dataStart = jB + SEG_B;
      this.base = best; this.symIdx = dataStart;
      this.prevAng = ang[dataStart - 1]; this.rxPhase = 0;
      this.acq = true;
      if (!this._ready) { this._ready = true; this.emit('ready', { bps: 9600, remoteDetected: true }); }
    }
    // decode symbols now fully buffered
    while (true) {
      const pos = this.base + this.symIdx * SPS;
      const end = this.rxBase + this.rx.length - 1;
      if (pos + SPAN / 2 * SPS >= end) break;         // not enough samples yet
      const s = this._sym(pos); const mag = Math.hypot(s[0], s[1]);
      // Carrier-drop floor: every real V.29 point has magnitude >= sqrt(2) (the
      // inner diagonal ring). When the matched-filter magnitude collapses below
      // ~0.6 of a ring the burst has ended and we're into the silence tail —
      // stop decoding rather than turn decayed/zero samples into garbage bytes.
      if (mag < 0.6 * this.A) break;
      const ang = Math.atan2(s[1], s[0]);
      let d = Math.round((ang - this.prevAng) / (Math.PI / 4)); d = ((d % 8) + 8) & 7; this.prevAng = ang;
      this.rxPhase = (this.rxPhase + d) & 7;
      const Q234 = DINV[d]; const r = mag / this.A;
      const thr = (this.rxPhase & 1) ? (Math.SQRT2 + 3 * Math.SQRT2) / 2 : 4; const Q1 = (r > thr) ? 1 : 0;
      const bits = [Q1, (Q234 >> 2) & 1, (Q234 >> 1) & 1, Q234 & 1];
      for (const bit of bits) { const r2 = this.des; const ob = bit ^ r2[17] ^ r2[22]; r2.unshift(bit); r2.pop(); this.outbits.push(ob); }
      this.symIdx++;
      this._uartConsume();
    }
  }

  // Async start/stop deframer over the descrambled bit stream. Idle mark (1s)
  // — preamble tail, warm-up, inter-byte gaps, trailer — produces no bytes.
  _uartConsume() {
    while (this.outbits.length) {
      const bit = this.outbits.shift();
      if (this.uState === 'hunt') {
        if (bit === 1) { if (!this.uArmed && this.uMarks < 255 && ++this.uMarks >= UART_ARM_MARKS) this.uArmed = true; }
        else if (this.uArmed) { this.uState = 'data'; this.uBit = 0; this.uByte = 0; }
        // a 0 before we've armed on idle mark is convergence noise: ignore.
      } else if (this.uState === 'data') {
        this.uByte |= (bit << this.uBit); this.uBit++;
        if (this.uBit === 8) this.uState = 'stop';
      } else { // 'stop'
        if (bit === 1) { this.emit('data', Buffer.from([this.uByte & 0xff])); this.uState = 'hunt'; }
        else { this.uState = 'hunt'; this.uArmed = false; this.uMarks = 0; } // framing error: resync
      }
    }
  }
}

module.exports = { V29 };
