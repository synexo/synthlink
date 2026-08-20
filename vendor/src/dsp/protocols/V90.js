'use strict';

/**
 * V.90 — ITU-T V.90 (09/98), 56 000 bit/s downstream PCM + 33 600 bit/s upstream
 * V.34, over the SynthLink WebSocket transport, in the project's "genuine
 * minimal" style (PROTOCOLS.md §0).
 *
 * ── Why V.90 fits this transport better than the analogue modems ────────────
 * V.21…V.34 are symmetric analogue modems: both ends synthesise a voiceband
 * waveform and the channel is treated as an ideal analogue line. V.90 is a
 * different animal. It does not modulate downstream at all. It exploits the fact
 * that the PSTN core was already digital — 8000 µ-law PCM samples per second —
 * with the ISP sitting on the digital side, and simply places PCM codewords onto
 * that digital path. **Our transport IS a PCM-sample channel**, so the downstream
 * maps onto it directly, and the entire DSP front-end that made V.34 hard —
 * carrier, RRC synthesis, matched filter, fractional symbol-timing acquisition —
 * does not exist here. The symbols ARE the samples.
 *
 * ── Roles ───────────────────────────────────────────────────────────────────
 * V.90 is inherently asymmetric and the mapping onto SynthLink is forced:
 *
 *      answer    = the DIGITAL modem  (server) → 56 000 downstream, PCM codewords
 *      originate = the ANALOGUE modem (browser) → 33 600 upstream, genuine V.34
 *
 * That is the only V.90-true mapping, and it happens to put the fast direction
 * where a BBS needs it. The upstream is the project's existing V.34 at its top
 * rate, used unmodified and in one direction only — V.90 §6 references V.34's
 * symbol rates, carriers, pre-emphasis, scrambler, framing and encoder directly,
 * so this is not an approximation of the upstream, it IS the upstream.
 *
 * ── The µ-law codebook: honoured, not simulated ─────────────────────────────
 * V.90's downstream transmitter is defined as SELECTING G.711 µ-law codewords,
 * and that is exactly what this code does — it emits the linear values those
 * codewords decode to, drawn from the Table 1 codebook. There is no quantiser
 * anywhere in the path and nothing is companded; the transmit behaviour is
 * genuine V.90 rather than a model of it.
 *
 * What differs from a real link is narrower, and worth stating precisely:
 *   - On the PSTN the 64 kbit/s digital path ENFORCES the codebook. Here nothing
 *     does: the restriction is self-imposed. We could ship arbitrary 16-bit
 *     levels and the transport would carry them.
 *   - A real digital modem hands 8-bit octets to the network; we ship the decoded
 *     16-bit linear values. The mapping is bijective, but our "network" is wider
 *     than a real one.
 *   - Consequently we inherit none of the impairments — robbed-bit signalling,
 *     digital pads, the analogue loop's own D/A — that make a real V.90 RECEIVER
 *     hard. That is the real simplification, and it is on the receive side.
 *
 * ── Startup ─────────────────────────────────────────────────────────────────
 * Real V.90 has four phases: (1) V.8 CM/JM, (2) INFO0/INFO1 + line probing +
 * ranging, (3) equalizer training + digital impairment learning, (4) CP/MP
 * parameter exchange + TRN2d/B1d. Phases 2–3 measure a channel that this
 * transport does not have. We keep the parts that carry information:
 *
 *   - **Phase 4 is genuine and functionally load-bearing.** CP travels upstream
 *     over the established V.34 link and really does determine the downstream
 *     constellation: the analogue modem chooses the Ucode masks, the spectral
 *     shaper coefficients and the lookahead depth, and the digital modem cannot
 *     transmit data until it arrives. MP comes back downstream. This is not a
 *     decorative rate exchange — nothing decodes without it.
 *   - **Sd frame alignment is the spec's own signal**: 64 repetitions of
 *     {+W, +0, +W, −W, −0, −W} then 8 of the sign-inverted pattern. Its first
 *     symbol is data frame interval 0, so locking the pattern's phase IS frame
 *     alignment. On the drift-free 8 kHz clock that is the entire receiver
 *     acquisition problem.
 *   - **Phase 1 is a genuine V.8 exchange.** V.90 signals its capability through
 *     bit b5 of the V.8 modn0 octet ("PCM avail"), which this repository's V.8
 *     implementation already builds and decodes. So V.90 negotiates through real
 *     ANSam / CM / JM / CJ like V.21 and V.22bis, rather than taking the
 *     want<X> bypass the other self-training protocols use. When V.8 has run, the
 *     class suppresses its own answer tone — the ANSam has already been heard.
 *
 * ── Deliberately out of scope (documented, not hidden) ─────────────────────
 *   - No INFO0/INFO1, no line probing, no ranging, no digital impairment
 *     learning (Phases 2–3): all of them measure a channel this transport does
 *     not have.
 *   - No robbed-bit-signalling detection, no digital-pad detection, no PCM-law
 *     auto-detection (CP selects the codec and we answer µ-law).
 *   - No analogue-loop equalizer, no timing tracking (symbols are samples).
 *   - CP and MP carry genuine Table 14/16 bit layouts, but they ride the
 *     established link as bytes rather than being modulated by Phase 4
 *     signalling; and the CRC convention is inferred (V.90 defers it to
 *     §10.1.2.3.2/V.34). See V90Phase4.js.
 *   - The full Table 2 rate ladder (28 000 … 56 000) is implemented and
 *     selectable; 56 000 is the default, at the (K,S) = (39,3) pair.
 *
 * Interface matches the other protocol classes: constructor(role);
 * generateAudio(n)->Float32Array; receiveAudio(f32); write(buf); emits 'data'
 * (Buffer) and 'ready' ({bps, remoteDetected}); getters bps and carrierDetected.
 */

const { EventEmitter } = require('events');
const config = require('../../../config');
const { V34 } = require('./V34');
const {
  makeConfig, configFromCP, legalRates, buildConstellation, defaultMask,
  maskFromUcodes, ucodesFromMask, V90Coder, MAG, UCODES, toFloat, fromFloat,
  quantCoef, DEFAULT_COEFS, DEFAULT_UCODE_MIN, averagePower,
} = require('./V90Mapper');
const P4 = require('./V90Phase4');

const SR = 8000;
const SYMS_PER_FRAME = 6;

// Upstream is V.34 at its top rate. V.90 §6.1 makes 4800–28800 mandatory and
// 31200/33600 optional; we have 33600, so we take it.
const UPSTREAM_RATE = 33600;

// ── Sd training signal ──────────────────────────────────────────────────────
// 64 repetitions of {+W, +0, +W, −W, −0, −W}, then 8 of the sign-inverted
// pattern. W is the largest Ucode (127 ⇒ magnitude 8031); "0" is Ucode 0, whose
// magnitude is 0. Note that a DATA frame can never contain a zero sample — the
// working constellation starts at Ucode 37 (magnitude 139) — so "is this group a
// zero-bearing Sd repetition?" is an exact, collision-free discriminator for
// finding where training ends and data begins.
const SD_W_UCODE = UCODES - 1;
const SD_NORMAL_REPS = 64, SD_INVERTED_REPS = 8;
const SD_ZERO_TOL = 60;                    // |v| below this is the Sd "0" symbol

// ── Audible startup ─────────────────────────────────────────────────────────
const ANS_TONE_FREQ = 2100, ANS_TONE_AMP = 0.15, ANS_TONE_SAMPLES = Math.round(1.0 * SR);
const CONNECT_GAP = Math.round(0.08 * SR);

// ── In-band control framing (Phase 4 carrier) ───────────────────────────────
// Length-prefixed so payloads need no escaping. After DLE 'D' every byte is user
// data, exactly as in V.32bis/V.34 here.
const DLE = 0x10, CTL_CP = 0x43 /*C*/, CTL_MP = 0x4d /*M*/, CTL_DATA = 0x44 /*D*/;

const WARMUP_BITS = 48, UART_ARM_MARKS = 8;
const RX_HI = 0.02, RX_LO = 0.004, RX_HANG = 400;

// Any rung of the Table 2 ladder may be selected per call; 56 000 is the default.
function resolveRate() {
  const sel = config.modem && config.modem.native && config.modem.native.v90Rate;
  const n = typeof sel === 'string' ? +sel : sel;
  if (!Number.isFinite(n)) return 56000;
  try { makeConfig(n); return n; } catch (_) { return 56000; }
}
function resolveSr() {
  const sel = config.modem && config.modem.native && config.modem.native.v90Sr;
  return Number.isFinite(sel) ? Math.max(0, Math.min(3, sel | 0)) : undefined;
}

class V90 extends EventEmitter {
  constructor(role) {
    super();
    this.role = role === 'originate' ? 'originate' : 'answer';
    this.isDigital = this.role === 'answer';          // digital modem = downstream TX
    this.cfg = makeConfig(resolveRate(), resolveSr());
    this._ready = false;
    this._rate = this.cfg.bitRate;                    // headline = downstream
    this._rateUp = UPSTREAM_RATE;

    // ── Upstream: the real V.34, used in ONE direction ──────────────────────
    // The analogue modem transmits it; the digital modem receives it. Set the
    // shared-singleton rate in the same tick we construct, per CLAUDE.md.
    const nat = config.modem.native;
    this._savedV34Rate = nat.v34Rate;
    nat.v34Rate = UPSTREAM_RATE;
    this.up = new V34(this.role);
    nat.v34Rate = this._savedV34Rate;

    // ── The analogue modem picks the downstream constellation (§5.4.4 / CP) ──
    // It is the one that would, on a real line, have measured which levels it can
    // actually resolve. Here that choice is a configuration, and it is genuinely
    // transmitted rather than assumed by both ends.
    this.lookahead = clampLd(nat.v90Lookahead);
    this.coefs = {
      a1: quantCoef(pick(nat.v90A1, DEFAULT_COEFS.a1)),
      b1: quantCoef(pick(nat.v90B1, DEFAULT_COEFS.b1)),
      a2: quantCoef(pick(nat.v90A2, DEFAULT_COEFS.a2)),
      b2: quantCoef(pick(nat.v90B2, DEFAULT_COEFS.b2)),
    };
    // CP carries a SET of constellations (up to six) plus a 4-bit index per data
    // frame interval selecting among them (§Table 14, bits 103:127). On a T1 the
    // intervals differ because robbed-bit signalling hits one frame in six; we
    // have no RBS, so one constellation is sent and all six intervals index it.
    const uMin = Number.isFinite(nat.v90UcodeMin) ? nat.v90UcodeMin : DEFAULT_UCODE_MIN;
    this.constellationSet = [maskFromUcodes(rangeUcodes(uMin))];
    this.intervalIndex = [0, 0, 0, 0, 0, 0];
    this.coder = null;                                 // built once parameters are agreed
    this.C = null;

    // Set true by the Handshake when this protocol was reached through a real
    // V.8 exchange, in which case the ANSam has already been heard and the class
    // must not emit its own answer tone on top of it.
    this._v8Done = false;

    if (!this.isDigital) this._configureDownstream();

    // ── Downstream TX state (digital modem only) ────────────────────────────
    this.txByteQ = [];
    this.txCtrlQ = [];
    this.txSyms = [];                                  // signed 14-bit-scale PCM values
    this.txStage = 'tone';
    this.txN = 0;
    this.txGapN = 0;
    this.txSdRep = 0;
    this.scr = new Array(23).fill(0);
    this.txWarmup = WARMUP_BITS;
    this.txFrame = null; this.txFramePos = 0;
    this._cpApplied = false;
    this._mpSeen = false;
    this._aLaw = false;
    this._peerUpstreamRates = [];

    // Scrambler taps: each end scrambles TX with its own polynomial and
    // descrambles RX with the peer's — the project-wide GPC/GPA pair (V.34 §7,
    // referenced by V.90 §6.5). Downstream is transmitted by the answer side.
    this._txTap = this.isDigital ? 4 : 17;
    this._rxTap = this.isDigital ? 17 : 4;

    // ── Downstream RX state (analogue modem only) ───────────────────────────
    this.rx = [];
    this.rxBase = 0;
    this.rxLevel = 0;
    this.rxOn = false;
    this.sdLocked = false;
    this.sdPhase = 0;                                  // absolute sample index of interval 0
    this.sawInverted = false;
    this.dataStart = -1;
    this.des = new Array(23).fill(0);
    this.outbits = [];
    this.uState = 'hunt'; this.uArmed = false; this.uMarks = 0; this.uBit = 0; this.uByte = 0;
    this._rxData = false;
    this._ctl = { state: 'idle', kind: 0, len: 0, buf: [] };
    this.peerRate = 0;

    // ── Wire the upstream ───────────────────────────────────────────────────
    if (this.isDigital) {
      // Digital modem: upstream V.34 carries the analogue modem's data AND its CP.
      this.up.on('data', buf => { for (const b of buf) this._upstreamByte(b); });
      this.up.on('ready', () => { this._maybeReady(); });
    } else {
      // Analogue modem: queue CP immediately. Note we cannot wait for the
      // upstream V.34 to fire 'ready' — that event means "my RECEIVER acquired
      // the peer", and this side only ever transmits V.34; its receiver is the
      // downstream PCM decoder. Queuing now is correct anyway: V34.write() parks
      // the bytes behind its own rate-exchange control frames, so CP goes out as
      // the first thing on the upstream the instant data mode opens.
      this._sendCP();
    }
  }

  get carrierDetected() {
    return this.isDigital ? this.up.carrierDetected : (this.rxOn || this.sdLocked);
  }
  get bps() { return this._rate; }
  get bpsUpstream() { return this._rateUp; }

  /** Bytes to send to the peer. Digital modem → downstream PCM; analogue → V.34. */
  write(bytes) {
    if (this.isDigital) { for (const b of bytes) this.txByteQ.push(b & 0xff); }
    else this.up.write(bytes);
  }

  // ─── Downstream configuration (exactly what CP carries) ───────────────────
  _configureDownstream() {
    const built = this.constellationSet.map(m => buildConstellation(m));
    this.C = this.intervalIndex.map(i => built[i] || built[0]);
    this.coder = new V90Coder(this.cfg, this.C, { coefs: this.coefs, lookahead: this.lookahead });
  }

  /** Handshake tells us whether a genuine V.8 Phase 1 already ran. */
  setV8Complete(done) { this._v8Done = !!done; if (done && this.txStage === 'tone') this.txStage = 'gap'; }

  // ─── Phase 4: CP (analogue → digital, over the upstream V.34) ─────────────
  // Genuine Table 14/V.90 bit layout — see V90Phase4.js. CP is what actually
  // configures the downstream: rate (drn), shaping redundancy (Sr), lookahead,
  // the shaper coefficients in the spec's signed Q1.6, the codec selection, the
  // constellation set and the per-interval index. The digital modem cannot send
  // a data frame until it arrives.
  _buildCPBits() {
    return P4.buildCP({
      drn: this.cfg.drn,
      Sr: this.cfg.Sr,
      ld: this.lookahead,
      ack: this._mpSeen,
      silent: false,
      aLaw: false,                                     // we answer µ-law
      upstreamRates: [UPSTREAM_RATE],
      coefs: this.coefs,
      trnRatio: 1,                                     // no codec-output attenuation here
      constellations: this.constellationSet,
      intervalIndex: this.intervalIndex,
      constellationsDiffer: false,
    });
  }
  _sendCP() {
    if (this._cpSent) return;
    this._cpSent = true;
    const bits = this._buildCPBits();
    const bytes = P4.bitsToBytes(bits);
    // nCons is carried alongside so the receiver knows the sequence length
    // before it parses (real CP is delimited by the Phase 4 signalling instead).
    this.up.write(Buffer.from([DLE, CTL_CP, this.constellationSet.length,
                               (bytes.length >> 8) & 0xff, bytes.length & 0xff, ...bytes]));
    this.up.write(Buffer.from([DLE, CTL_DATA]));
  }
  _applyCP(nCons, bytes) {
    const cp = P4.parseCP(P4.bytesToBits(bytes, P4.cpLength(nCons)), nCons);
    if (!cp.sync || !cp.crcOk || !cp.isCP) {
      this.emit('cpError', { sync: cp.sync, crcOk: cp.crcOk, isCP: cp.isCP });
      return false;
    }
    this.cfg = configFromCP(cp.drn, cp.Sr);            // drn + Sr pin (K,S) exactly
    this._rate = this.cfg.bitRate;
    this.lookahead = cp.ld;
    this.coefs = cp.coefs;
    this.constellationSet = cp.constellations;
    this.intervalIndex = cp.intervalIndex;
    this._peerUpstreamRates = cp.upstreamRates;
    this._aLaw = cp.aLaw;
    this._configureDownstream();
    this._cpApplied = true;
    return true;
  }

  // ─── Phase 4: MP (digital → analogue, downstream) ─────────────────────────
  // Genuine Table 16/V.90 Type 0 layout (no precoder coefficients — the
  // precoder is degenerate on a flat channel, as it is for V.34 here).
  _buildMPBytes() {
    return P4.bitsToBytes(P4.buildMP({
      drn: Math.round(this._rateUp / 2400),            // 33600 ⇒ drn 14
      ack: this._cpApplied,
      trellis: 0,                                      // 16-state, matching our V.34
      nonlinear: false,
      expandedShaping: false,
      upstreamRates: [UPSTREAM_RATE],
    }));
  }
  _applyMP(bytes) {
    const mp = P4.parseMP(P4.bytesToBits(bytes, P4.mpLength()));
    if (!mp.sync || !mp.crcOk) { this.emit('mpError', { sync: mp.sync, crcOk: mp.crcOk }); return false; }
    this._rateUp = mp.drn * 2400;
    this.peerRate = this._rate;
    this._mpSeen = true;
    return true;
  }

  /** A byte arriving from the analogue modem over the upstream V.34 link. */
  _upstreamByte(b) {
    if (this._rxData) { this.emit('data', Buffer.from([b])); return; }
    const c = this._ctl;
    switch (c.state) {
      case 'idle': if (b === DLE) c.state = 'esc'; break;
      case 'esc':
        if (b === CTL_CP) { c.kind = b; c.state = 'ncons'; }
        else if (b === CTL_DATA) { this._rxData = true; c.state = 'idle'; this._maybeReady(); }
        else c.state = 'idle';
        break;
      case 'ncons': c.nCons = b; c.state = 'len1'; break;
      case 'len1': c.len = b << 8; c.state = 'len2'; break;
      case 'len2': c.len |= b; c.buf = []; c.state = c.len ? 'payload' : 'idle'; break;
      case 'payload':
        c.buf.push(b);
        if (c.buf.length >= c.len) { this._applyCP(c.nCons, c.buf); c.state = 'idle'; }
        break;
    }
  }

  _maybeReady() {
    if (this._ready) return;
    if (this.isDigital) {
      // The digital modem is ready once the upstream carries data AND CP has told
      // it what to transmit — it genuinely cannot send a frame before that.
      if (!this._cpApplied || !this._rxData) return;
    } else {
      if (this.dataStart < 0) return;
    }
    this._ready = true;
    this.emit('ready', { bps: this._rate, remoteDetected: true });
  }

  // ═══ TX ═══════════════════════════════════════════════════════════════════
  generateAudio(count) {
    if (!this.isDigital) return this.up.generateAudio(count);   // analogue: V.34 upstream

    const out = new Float32Array(count);
    for (let c = 0; c < count; c++) {
      switch (this.txStage) {
        case 'tone': {
          if (this._v8Done) { this.txStage = 'gap'; this.txGapN = 0; c--; continue; }
          const n = this.txN++;
          if (n >= ANS_TONE_SAMPLES) { this.txStage = 'gap'; this.txGapN = 0; c--; continue; }
          out[c] = Math.sin(2 * Math.PI * ANS_TONE_FREQ * n / SR) * ANS_TONE_AMP;
          break;
        }
        case 'gap':
          // Silence until CP has arrived: the digital modem does not know what
          // constellation to use until the analogue modem tells it.
          this.txGapN++;
          if (this.txGapN >= CONNECT_GAP && this._cpApplied) {
            this.txStage = 'sd'; this.txSdRep = 0; this.txSyms = [];
            this.scr.fill(0); this.txWarmup = WARMUP_BITS;
            const mp = this._buildMPBytes();
            this.txCtrlQ = [DLE, CTL_MP, (mp.length >> 8) & 0xff, mp.length & 0xff,
                            ...mp, DLE, CTL_DATA];
            this.coder.reset();
          }
          break;
        case 'sd': {
          if (!this.txSyms.length) {
            if (this.txSdRep >= SD_NORMAL_REPS + SD_INVERTED_REPS) {
              this.txStage = 'data'; c--; continue;
            }
            const inv = this.txSdRep >= SD_NORMAL_REPS;
            this.txSyms = sdRepetition(inv);
            this.txSdRep++;
          }
          out[c] = toFloat(this.txSyms.shift());
          break;
        }
        case 'data': {
          while (!this.txSyms.length) {
            const bits = new Array(this.cfg.D);
            for (let i = 0; i < this.cfg.D; i++) bits[i] = this._txBit();
            const syms = this.coder.encodeFrame(bits);
            if (syms) this.txSyms = syms.slice();
          }
          out[c] = toFloat(this.txSyms.shift());
          break;
        }
      }
    }
    return out;
  }

  _scramble(bit) {
    const r = this.scr;
    const o = bit ^ r[this._txTap] ^ r[22];
    r.unshift(o); r.pop();
    return o;
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
    return this._scramble(1);                          // idle mark — no start bit, no phantom bytes
  }

  // ═══ RX ═══════════════════════════════════════════════════════════════════
  receiveAudio(f32) {
    if (this.isDigital) { this.up.receiveAudio(f32); return; }   // digital: V.34 upstream

    for (let i = 0; i < f32.length; i++) {
      const s = f32[i];
      this.rxLevel += 0.02 * (Math.abs(s) - this.rxLevel);
      if (this.rxLevel > RX_HI) this.rxOn = true;
      if (this.rxOn) this.rx.push(s);
    }
    if (this.rxOn) this._process();
  }

  _process() {
    if (!this.sdLocked) { this._huntSd(); if (!this.sdLocked) { this._trimHunt(); return; } }
    this._consumeFrames();
    this._trim(4 * SYMS_PER_FRAME);
  }

  /**
   * Lock the Sd pattern. Its first symbol is data frame interval 0, so finding
   * the pattern's phase IS frame alignment — no timing recovery, no equalizer,
   * nothing fractional. Requires MATCH_REPS consecutive clean repetitions so a
   * stray transient cannot false-lock.
   *
   * The search is a single forward pass: `huntPos` is an absolute sample index
   * that only ever advances, so each candidate offset is tested once no matter
   * how the RX audio is chunked. (Rescanning the whole buffer per chunk is
   * quadratic and, with a one-second answer tone sitting in front of Sd, slow
   * enough to look like a hang.)
   */
  _huntSd() {
    const MATCH_REPS = 3;
    const W = MAG[SD_W_UCODE];
    const need = MATCH_REPS * SYMS_PER_FRAME;
    const endAbs = this.rxBase + this.rx.length - need;
    if (this.huntPos < this.rxBase) this.huntPos = this.rxBase;
    const v = new Array(SYMS_PER_FRAME);
    for (; this.huntPos <= endAbs; this.huntPos++) {
      const p = this.huntPos - this.rxBase;
      let good = true;
      for (let r = 0; r < MATCH_REPS && good; r++) {
        const base = p + r * SYMS_PER_FRAME;
        for (let k = 0; k < SYMS_PER_FRAME; k++) v[k] = fromFloat(this.rx[base + k]);
        // Match the NORMAL polarity only. {+W,+0,+W,−W,−0,−W} is antisymmetric
        // under a three-symbol shift — shifting by 3 reproduces the sign-inverted
        // pattern exactly — so accepting either polarity would leave the frame
        // phase ambiguous mod 3 and could lock three symbols early, splitting
        // every frame across an Sd/data boundary. Requiring the leading half to
        // be positive pins the phase uniquely mod 6. Sd sends 64 normal
        // repetitions before the 8 inverted ones, so a receiver listening from
        // carrier onset always has normals to lock onto.
        if (!sdMatches(v, W, false)) good = false;
      }
      if (good) {
        this.sdLocked = true;
        this.sdPhase = this.huntPos;                   // absolute index of an interval-0 symbol
        return;
      }
    }
  }

  /** Bound the buffer while still hunting: nothing before huntPos can ever match. */
  _trimHunt() {
    const drop = this.huntPos - this.rxBase;
    if (drop > 4096) { this.rx.splice(0, drop); this.rxBase += drop; }
  }

  /**
   * Consume aligned six-symbol groups. While still in Sd, groups carry the zero
   * symbol at intervals 1 and 4; a data frame never can (the constellation's
   * smallest magnitude is well above zero), so the first group without zeros is
   * unambiguously the first data frame.
   */
  _consumeFrames() {
    for (;;) {
      const startAbs = this.dataStart >= 0
        ? this.dataStart + this._framesDone * SYMS_PER_FRAME
        : this.sdPhase + this._sdGroups * SYMS_PER_FRAME;
      const off = startAbs - this.rxBase;
      if (off < 0) { this._resync(); return; }
      if (off + SYMS_PER_FRAME > this.rx.length) return;
      const v = new Array(SYMS_PER_FRAME);
      for (let k = 0; k < SYMS_PER_FRAME; k++) v[k] = fromFloat(this.rx[off + k]);

      if (this.dataStart < 0) {
        if (isSdGroup(v)) { this._sdGroups++; continue; }
        this.dataStart = startAbs;
        this._framesDone = 0;
        this.des.fill(0);
        this.coder.reset();
        this.uState = 'hunt'; this.uArmed = false; this.uMarks = 0;
        this._maybeReady();
        continue;
      }

      const bits = this.coder.decodeFrame(v);
      this._framesDone++;
      for (const bit of bits) {
        const r = this.des;
        const ob = bit ^ r[this._rxTap] ^ r[22];
        r.unshift(bit); r.pop();
        this.outbits.push(ob);
      }
      this._uartConsume();
    }
  }

  _resync() { this.sdLocked = false; this.dataStart = -1; this._sdGroups = 0; this._framesDone = 0; }

  _trim(keep) {
    const anchor = this.dataStart >= 0
      ? this.dataStart + this._framesDone * SYMS_PER_FRAME
      : this.sdPhase + this._sdGroups * SYMS_PER_FRAME;
    const drop = Math.min(anchor - this.rxBase - keep, this.rx.length);
    if (drop > 1024) { this.rx.splice(0, drop); this.rxBase += drop; }
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
        if (bit === 1) { this._downstreamByte(this.uByte & 0xff); this.uState = 'hunt'; }
        else { this.uState = 'hunt'; this.uArmed = false; this.uMarks = 0; }
      }
    }
  }

  /** A byte arriving from the digital modem over the downstream PCM channel. */
  _downstreamByte(b) {
    if (this._rxData) { this.emit('data', Buffer.from([b])); return; }
    const c = this._ctl;
    switch (c.state) {
      case 'idle': if (b === DLE) c.state = 'esc'; break;
      case 'esc':
        if (b === CTL_MP) { c.kind = b; c.state = 'len1'; }
        else if (b === CTL_DATA) { this._rxData = true; c.state = 'idle'; }
        else c.state = 'idle';
        break;
      case 'len1': c.len = b << 8; c.state = 'len2'; break;
      case 'len2': c.len |= b; c.buf = []; c.state = c.len ? 'payload' : 'idle'; break;
      case 'payload':
        c.buf.push(b);
        if (c.buf.length >= c.len) { this._applyMP(c.buf); c.state = 'idle'; }
        break;
    }
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────
function pick(v, d) { return Number.isFinite(v) ? v : d; }
function clampLd(v) { const n = Number.isFinite(v) ? v : 1; return Math.max(0, Math.min(3, n | 0)); }
function rangeUcodes(min) {
  const l = [];
  for (let u = Math.max(0, Math.min(UCODES - 1, min)); u < UCODES; u++) l.push(u);
  return l;
}
/** One Sd repetition: {+W,+0,+W,−W,−0,−W}, or its sign inverse. */
function sdRepetition(inverted) {
  const W = MAG[SD_W_UCODE];
  const p = [W, 0, W, -W, 0, -W];
  return inverted ? p.map(v => -v) : p;
}
function sdMatches(v, W, inverted) {
  const sgn = inverted ? -1 : 1;
  const near = (a, b) => Math.abs(a - b) <= Math.max(W * 0.15, 32);
  return near(v[0], sgn * W) && Math.abs(v[1]) <= SD_ZERO_TOL && near(v[2], sgn * W) &&
         near(v[3], -sgn * W) && Math.abs(v[4]) <= SD_ZERO_TOL && near(v[5], -sgn * W);
}
/** Sd repetitions carry the zero symbol at intervals 1 and 4; data frames cannot. */
function isSdGroup(v) { return Math.abs(v[1]) <= SD_ZERO_TOL && Math.abs(v[4]) <= SD_ZERO_TOL; }

V90.prototype._sdGroups = 0;
V90.prototype._framesDone = 0;
V90.prototype.huntPos = 0;

module.exports = { V90 };
