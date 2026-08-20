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
 * ── The modelled network codec (the crucial scope call) ─────────────────────
 * Our transport is 16-bit LINEAR PCM and essentially lossless. V.90's whole
 * structure — which levels are legal, bits per symbol, the sign/segment layout —
 * is built around the G.711 µ-law codebook. Without a µ-law codec in the path
 * "V.90" would be meaningless: we would just be shipping linear PCM. So an 8-bit
 * µ-law quantiser is inserted **deliberately, as the modelled network codec**.
 * 16-bit linear represents every µ-law decode level exactly, so it ships
 * losslessly; the codec is what makes 56k both possible and bounded. This is
 * modelling the network, exactly as treating the WebSocket as a 4-wire line is —
 * legitimate, but a judgement call, and stated openly in PROTOCOLS.md.
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
 *   - **V.8 is bypassed**, as it is for every other self-training protocol here,
 *     and an ANSam-shaped 2100 Hz answer tone is emitted from inside the class
 *     for audible authenticity. Documented in PROTOCOLS.md.
 *
 * ── Deliberately out of scope (documented, not hidden) ─────────────────────
 *   - No V.8/V.8bis negotiation; no INFO0/INFO1, no line probing, no ranging.
 *   - No digital impairment learning, no robbed-bit-signalling detection, no
 *     digital-pad detection, no PCM-law auto-detection (we own the codec).
 *   - No analogue-loop equalizer, no timing tracking (symbols are samples).
 *   - Single downstream rate (56 000). The coder is fully (K,S)-parameterised so
 *     a lower rate is a CONFIGS entry; the exact Table 2 (K,S) pairings were not
 *     verified and are not reproduced.
 *   - The constellation exceeds the average power a real digital modem may emit.
 *
 * Interface matches the other protocol classes: constructor(role);
 * generateAudio(n)->Float32Array; receiveAudio(f32); write(buf); emits 'data'
 * (Buffer) and 'ready' ({bps, remoteDetected}); getters bps and carrierDetected.
 */

const { EventEmitter } = require('events');
const config = require('../../../config');
const { V34 } = require('./V34');
const {
  makeConfig, buildConstellation, defaultMask, maskFromUcodes, ucodesFromMask,
  V90Coder, MAG, UCODES, toFloat, fromFloat, quantCoef, DEFAULT_COEFS,
  DEFAULT_UCODE_MIN, averagePower,
} = require('./V90Mapper');

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

function resolveRate() {
  const sel = config.modem && config.modem.native && config.modem.native.v90Rate;
  const n = typeof sel === 'string' ? +sel : sel;
  return Number.isFinite(n) && makeConfigSafe(n) ? n : 56000;
}
function makeConfigSafe(r) { try { makeConfig(r); return true; } catch (_) { return false; } }

class V90 extends EventEmitter {
  constructor(role) {
    super();
    this.role = role === 'originate' ? 'originate' : 'answer';
    this.isDigital = this.role === 'answer';          // digital modem = downstream TX
    this.cfg = makeConfig(resolveRate());
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
    const uMin = Number.isFinite(nat.v90UcodeMin) ? nat.v90UcodeMin : DEFAULT_UCODE_MIN;
    this.masks = Array.from({ length: SYMS_PER_FRAME }, () => maskFromUcodes(rangeUcodes(uMin)));
    this.coder = null;                                 // built once parameters are agreed
    this.C = null;

    if (!this.isDigital) this._configureDownstream(this.masks, this.coefs, this.lookahead);

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
    this._sentMP = false;

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

  // ─── Downstream configuration (what CP carries) ───────────────────────────
  _configureDownstream(masks, coefs, lookahead) {
    this.C = masks.map(m => buildConstellation(m));
    this.coder = new V90Coder(this.cfg, this.C, { coefs, lookahead });
  }

  // ─── Phase 4: CP (analogue → digital, upstream over V.34) ─────────────────
  // Genuine CP *fields*: the per-interval 128-bit Ucode masks (§5.4.4), the
  // spectral shaper coefficients in the spec's own 8-bit two's-complement,
  // 6-fraction-bit format, the lookahead depth lₐ, and the selected downstream
  // rate. The exact Table 14 bit positions are NOT reproduced — see PROTOCOLS.md.
  _buildCP() {
    const p = [];
    p.push((this.cfg.bitRate >> 8) & 0xff, this.cfg.bitRate & 0xff);
    p.push(this.lookahead & 0x03);
    for (const c of [this.coefs.a1, this.coefs.b1, this.coefs.a2, this.coefs.b2]) {
      p.push(Math.round(c * 64) & 0xff);               // 8-bit two's complement, 6 fraction bits
    }
    for (const m of this.masks) for (let i = 0; i < 16; i++) p.push(m[i]);
    return p;
  }
  _sendCP() {
    if (this._cpSent) return;
    this._cpSent = true;
    const p = this._buildCP();
    this.up.write(Buffer.from([DLE, CTL_CP, (p.length >> 8) & 0xff, p.length & 0xff, ...p]));
    this.up.write(Buffer.from([DLE, CTL_DATA]));
  }
  _applyCP(p) {
    let i = 0;
    const rate = (p[i++] << 8) | p[i++];
    const ld = p[i++] & 0x03;
    const co = [];
    for (let k = 0; k < 4; k++) { let v = p[i++]; if (v > 127) v -= 256; co.push(v / 64); }
    const masks = [];
    for (let f = 0; f < SYMS_PER_FRAME; f++) {
      const m = new Uint8Array(16);
      for (let k = 0; k < 16; k++) m[k] = p[i++];
      masks.push(m);
    }
    if (rate !== this.cfg.bitRate) this.cfg = makeConfig(rate);
    this._rate = this.cfg.bitRate;
    this.masks = masks;
    this.lookahead = ld;
    this.coefs = { a1: co[0], b1: co[1], a2: co[2], b2: co[3] };
    this._configureDownstream(masks, this.coefs, ld);
    this._cpApplied = true;
  }

  // ─── Phase 4: MP (digital → analogue, downstream) ─────────────────────────
  _buildMP() {
    return [(this._rateUp >> 8) & 0xff, this._rateUp & 0xff,
            (this.cfg.bitRate >> 8) & 0xff, this.cfg.bitRate & 0xff];
  }

  /** A byte arriving from the analogue modem over the upstream V.34 link. */
  _upstreamByte(b) {
    if (this._rxData) { this.emit('data', Buffer.from([b])); return; }
    const c = this._ctl;
    switch (c.state) {
      case 'idle': if (b === DLE) c.state = 'esc'; break;
      case 'esc':
        if (b === CTL_CP) { c.kind = b; c.state = 'len1'; }
        else if (b === CTL_DATA) { this._rxData = true; c.state = 'idle'; this._maybeReady(); }
        else c.state = 'idle';
        break;
      case 'len1': c.len = b << 8; c.state = 'len2'; break;
      case 'len2': c.len |= b; c.buf = []; c.state = c.len ? 'payload' : 'idle'; break;
      case 'payload':
        c.buf.push(b);
        if (c.buf.length >= c.len) { this._applyCP(c.buf); c.state = 'idle'; }
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
            this.txCtrlQ = [DLE, CTL_MP, 0, 4, ...this._buildMP(), DLE, CTL_DATA];
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
        if (!sdMatches(v, W, false) && !sdMatches(v, W, true)) good = false;
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
        if (c.buf.length >= c.len) {
          this.peerRate = (c.buf[2] << 8) | c.buf[3];
          this._rateUp = (c.buf[0] << 8) | c.buf[1];
          c.state = 'idle';
        }
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
