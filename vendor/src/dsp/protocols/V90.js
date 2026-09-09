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
const P3 = require('./V90Phase3');
// Table 12's field accessors, for reading a DIL descriptor out of the Ja bits the
// upstream V.34 receiver recovers. V.34's own Phase 3 module is not needed here:
// the downstream signals are two-point and their differential encoding is mod 2,
// which _p3Downstream does as the XOR §8.4.2 describes.
const BF = require('./BitFrame');

const SR = 8000;
const SYMS_PER_FRAME = 6;

// Upstream is V.34 at its top rate. V.90 §6.1 makes 4800–28800 mandatory and
// 31200/33600 optional; we have 33600, so we take it.
const UPSTREAM_RATE = 33600;

// ── U_INFO — the codeword every Phase 3 downstream signal is built on ───────
// Table 10/V.90 bits 25:31 carry it in INFO1a: "U_INFO: Ucode of the PCM
// codeword to be used by the digital modem for the 2 point train... U_INFO
// shall be greater than 66." §8.4.4 then builds Sd's W from 16 + U_INFO, which
// caps it at 111. Chosen LOCALLY here, and a negotiated value once Phase 2
// exchanges INFO1a — this constant exists only until then.
//
// 111 is the top of the legal range, and taking it means 16 + U_INFO is 127:
// exactly the value SD_W_UCODE was hardcoded to before this, so Sd is unchanged
// bit for bit while W stops being a number with a comment and becomes a
// derivation from the clause that defines it.
const U_INFO = 111;

// ── Sd training signal ──────────────────────────────────────────────────────
// 64 repetitions of {+W, +0, +W, −W, −0, −W}, then 8 of the sign-inverted
// pattern. §8.4.4 defines W as the codeword whose Ucode is 16 + U_INFO; "0" is
// Ucode 0, whose magnitude is 0. Note that a DATA frame can never contain a zero
// sample — the working constellation starts at Ucode 37 (magnitude 139) — so "is
// this group a zero-bearing Sd repetition?" is an exact, collision-free
// discriminator for finding where Sd ends.
const SD_W_UCODE = P3.sdWUcode(U_INFO);
const SD_NORMAL_REPS = 64, SD_INVERTED_REPS = 8;   // §8.4.4: 384T then 48T
const SD_ZERO_TOL = 60;                    // |v| below this is the Sd "0" symbol

// ── Phase 3, digital modem (§8.4, §9.3.1) ──────────────────────────────────
// TRN1d ≥ 2040T (§9.3.1.4) and an integer multiple of six symbols (§8.4.5);
// 2040 is 340 frames, so the minimum is already legal and is what is sent.
const TRN1D_SYMBOLS = P3.TRN1D_MIN_SYMBOLS;
// §9.3.1.5's Jd repetition count used to be a constant here, because it repeats
// "until it detects S" and the analogue modem's S was not on the wire. It is now,
// so the count is whatever the procedure produces — see _analogueSSeen().
// §8.4.3: J′d is twelve binary zeroes.
const JPRIME_BITS = 12;

// ── The DIL this analogue modem requests (§8.4.1, Table 12) ────────────────
// Every value here is a legal choice inside the Recommendation's own bounds
// rather than a shortcut around them, which is what "stay within spec" costs
// and buys.
//
//   N = 32 segments, all eight Hc = 127, so every segment is (127+1)×6 = 768
//   symbols = 96 ms and one pass of the sequence is 3.07 s. That sits inside
//   Figure 5's ≤5 s for DIL with room to spare, and is what moves a V.90
//   start-up from ~4 s to ~7.6 s — recognisably a 56k handshake without the
//   full wait. 0 ≤ N ≤ 255 and 1 ≤ c ≤ 8 are the clause's bounds; N = 0 would
//   mean "DIL is not transmitted" and Figure 6 rather than Figure 5.
//
//   The 32 training Ucodes sweep the codeword space four per Uchord, because
//   DIL exists to probe what the path does to each chord and a probe that
//   visits one chord is not one.
//
//   L_SP = 11 and L_TP = 7 are deliberately COPRIME WITH SIX. A data frame is
//   six symbols and the impairments DIL is meant to find — robbed-bit
//   signalling above all — are per-frame-interval. A pattern whose length
//   divides six would put the same probe in the same interval on every
//   repetition and could never see them; 11 and 7 walk the probe across all six
//   intervals. Nothing here measures that yet (see V90Phase3's foot), but a
//   transmitter that makes the measurement impossible would have to be redone
//   rather than added to.
const DIL_SEGMENTS = 32;
const DIL_H = new Array(8).fill(127);
// REFc, the reference codeword for each Uchord: the midpoint of the chord's own
// sixteen Ucodes. Non-zero by construction, which keeps the Sd discriminator
// above exact — a zero-bearing DIL group would be indistinguishable from Sd.
const DIL_REF = Array.from({ length: 8 }, (_, c) => c * 16 + 8);
const DIL_SP = [1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0];              // L_SP = 11
const DIL_TP = [1, 0, 1, 1, 0, 1, 1];                          // L_TP = 7

// ── Audible startup ─────────────────────────────────────────────────────────
const ANS_TONE_FREQ = 2100, ANS_TONE_AMP = 0.15, ANS_TONE_SAMPLES = Math.round(1.0 * SR);
const CONNECT_GAP = Math.round(0.08 * SR);

// ── In-band control framing (Phase 4 carrier) ───────────────────────────────
// Length-prefixed so payloads need no escaping. After DLE 'D' every byte is user
// data, exactly as in V.32bis/V.34 here.
const DLE = 0x10, CTL_CP = 0x43 /*C*/, CTL_MP = 0x4d /*M*/, CTL_DATA = 0x44 /*D*/;
// There is no CTL_JA any more. The DIL descriptor used to be packed into bytes and
// carried on this channel; §8.3.1's real Ja now carries it as a Phase 3 signal on
// the upstream V.34, which is where a Phase 3 sequence belongs. Only the carriage
// changed — the descriptor's bits were already the Recommendation's.

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
    // §9.2/V.90 is V.90's own probing and ranging, between the analogue and the
    // DIGITAL modem, and it is not V.34 §11.2. This instance is used for Phase 3
    // and nothing earlier, so its Phase 2 is off and the V.34 start-up begins where
    // V.90 hands over to it.
    this.up.setPhase2Enabled(false);
    // §9.3.2.1 gives the ANALOGUE modem the leading part in Phase 3 — 70 ± 5 ms of
    // silence, then S for 128T and S̄ for 16T — where V.34 §11.3.1.2.1 gives it to
    // the answer modem. The digital modem answers on the PCM side with Sd and is
    // not a V.34 transmitter, so a V.34-gated originate would wait for an S that
    // this link never carries.
    if (!this.isDigital) {
      this.up.setPhase3Lead(true);
      // The tail itself is installed at the END of the constructor: it sets _dil,
      // and the downstream-state block below still assigns _dil = null.
    } else {
      // The analogue modem's Phase 3 carries THREE S-to-S̄ transitions (§9.3.2.1,
      // §9.3.2.8, §9.3.2.10) with §9.3.2.4's silence between the first and second,
      // so the upstream receiver must not read that silence as the end of Phase 3.
      this.up.setPhase3SbarTarget(3);
    }

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
    this.txTrnN = 0; this.txJdRep = 0; this.txJdBits = null;
    this.txDilSyms = []; this._lastP3Sign = 0;
    this.txSyms = [];                                  // signed 14-bit-scale PCM values
    this.txStage = 'tone';
    this.txN = 0;
    this.txGapN = 0;
    this.txSdRep = 0;
    this.scr = new Array(23).fill(0);
    this.txWarmup = WARMUP_BITS;
    this.txFrame = null; this.txFramePos = 0;
    this._cpApplied = false;
    this._jaSent = false; this._jaSeen = false; this._dil = null;
    // ── Downstream Phase 3, as SIGNALS rather than as a symbol count ─────────
    // §9.3.2.4 to §9.3.2.10 make every one of the analogue modem's Phase 3 steps
    // conditional on something it has detected. What used to be `_p3Left`, a count
    // derived from a Jd repetition constant both ends read, is now four detections:
    // the Sd-to-S̄d transition, Jd, J′d, and the end of the DIL it asked for.
    this._sbarDSeen = false;     // §9.3.2.4
    this._jdReceived = false;    // §9.3.2.6
    this._jprimeDSeen = false;   // §9.3.2.8
    this._dilSymsSeen = 0;       // §9.3.2.9 — how much of its own probe has arrived
    this._p3Stage = 'sd';        // sd → trn1d → jd → jprimed → dil → data
    this._p3PrevSign = null;
    this._p3Des = new Array(23).fill(0);
    this._p3Bits = [];
    this._dilExpect = null;      // the symbol sequence this modem asked to be sent
    this._dilPos = 0;
    this.scr3 = new Array(23).fill(0);   // Phase 3's own scrambler — see _scramble3
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
      // Ja is no longer here: it is a Phase 3 SIGNAL now (§8.3.1), transmitted by
      // the upstream V.34 before this control channel exists at all. CP stays —
      // it is Phase 4 (Table 14/V.90) and belongs on the data carrier.
      this._sendCP();
      // Last, because it sets _dil and the downstream-state block above clears it.
      this._installPhase3Tail();
    }
  }

  // ─── Phase 3: the DIL descriptor (analogue → digital) ─────────────────────
  /** The descriptor this modem asks for. See the DIL_* constants for the why. */
  _buildDILDescriptor() {
    // Four Ucodes per chord, evenly spaced inside it, skipping the chord's own
    // REF so a segment's training symbol and its reference are never the same
    // codeword — a segment where they coincide carries no information.
    const ucodes = [];
    for (let c = 0; c < 8; c++) {
      for (let k = 0; k < DIL_SEGMENTS / 8; k++) {
        const u = c * 16 + 2 + k * 4;
        ucodes.push(u === DIL_REF[c] ? u + 1 : u);
      }
    }
    return {
      n: DIL_SEGMENTS, sp: DIL_SP, tp: DIL_TP,
      h: DIL_H, ref: DIL_REF, ucodes,
    };
  }
  /**
   * §8.3.1 — Ja is now on the wire as a SIGNAL: "Sequence Ja consists of repetitions
   * of the DIL descriptor detailed below. The modulation used for transmitting Ja is
   * as defined in 10.1.3.3/V.34." That is V.34's J modulation, which the upstream
   * V.34 class already emits for its own J, so Ja is that chain fed the descriptor's
   * bits instead of Table 18's pattern.
   *
   * It used to travel as a DLE-framed byte payload on the Phase 4 control channel —
   * bit-exact content, but arriving after the upstream had reached data mode, which
   * put a Phase 3 signal inside Phase 4. The descriptor built here is unchanged;
   * only its carriage moved.
   */
  _installPhase3Tail() {
    this._dil = this._buildDILDescriptor();
    const jaBits = P3.buildDIL(this._dil);
    const dilSyms = P3.dilSymbolCount(this._dil);
    this.up.setPhase3Tail({
      first: 'ja',
      resumeAt: 's-hold',
      jaBits,
      dilRequested: this._dil.n > 0,
      // Every gate is a detection on the downstream PCM side. See the fields they
      // read, declared together in the constructor.
      sbarD: () => this._sbarDSeen,           // §9.3.2.4
      jdReceived: () => this._jdReceived,     // §9.3.2.6 / §9.3.2.7
      jprimeD: () => this._jprimeDSeen,       // §9.3.2.8
      // §9.3.2.9/.10 leave "enough of the DIL sequence" to the analogue modem. One
      // full pass of the probe it asked for is that judgement, made from its own
      // descriptor — not a length the two ends have to agree on.
      dilDone: () => this._dilSymsSeen >= dilSyms,
    });
  }

  /** The digital modem's side of §8.3.1: read Ja out of the upstream Phase 3 bits. */
  _huntJa() {
    if (this._jaSeen) return;
    const b = this.up.p3 && this.up.p3.bits;
    if (!b || b.length < 64) return;
    for (let i = 0; i + 64 <= b.length; i++) {
      let sync = true;
      for (let k = 0; k < 17 && sync; k++) if (b[i + k] !== 1) sync = false;
      if (!sync) continue;
      const desc = this._tryParseJa(b, i);
      if (!desc) continue;
      this._dil = desc;
      this._jaSeen = true;
      b.splice(0, i + 1);
      return;
    }
  }

  /**
   * Parse one descriptor at `at`, or null.
   *
   * Table 12's LENGTH is not fixed — α and β move every field after SP and TP — so
   * N, L_SP and L_TP are read from the head first and the descriptor's own length is
   * computed from them before the rest is parsed. The CRC is what makes this safe to
   * run against a stream that also carries S, PP and TRN: a 17-one run in
   * differentially-misread training will not also satisfy a 16-bit CRC.
   */
  _tryParseJa(bits, at) {
    if (at + 64 > bits.length) return null;
    const head = bits.slice(at, at + 64);
    const n = BF.getUInt(head, 18, 25);
    const lsp = BF.getUInt(head, 35, 41) + 1;
    const ltp = BF.getUInt(head, 43, 49) + 1;
    if (n > 255 || lsp > 128 || ltp > 128) return null;
    const len = P3.dilLength(lsp, ltp, n);
    if (at + len > bits.length) return null;
    const desc = P3.parseDIL(bits.slice(at, at + len));
    if (!desc.sync || !desc.crcOk || desc.n !== n) return null;
    return desc;
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
        if (c.buf.length >= c.len) {
          this._applyCP(c.nCons, c.buf);
          c.state = 'idle';
        }
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
          // §9.3.1.3: Sd follows the RECEIPT OF Ja, not the receipt of CP. CP is
          // Phase 4 and arrives on the same byte channel; the gate moved to Ja
          // so the phases run in the Recommendation's order. Data still cannot
          // start before CP, which is checked where data starts.
          if (this.txGapN >= CONNECT_GAP && this._jaSeen) {
            // Sd only. MP and the coder belong to Phase 4 and are set up where
            // data begins — they used to be set up here because the gate above
            // was CP, so the coder was guaranteed to exist by this point. It no
            // longer is: Ja can arrive before CP, which is the Recommendation's
            // order and the whole point of the change.
            this.txStage = 'sd'; this.txSdRep = 0; this.txSyms = [];
            this.scr.fill(0); this.txWarmup = WARMUP_BITS;
          }
          break;
        case 'sd': {
          if (!this.txSyms.length) {
            if (this.txSdRep >= SD_NORMAL_REPS + SD_INVERTED_REPS) {
              // §9.3.1.4: TRN1d follows Sd/S̄d.
              this.txStage = 'trn1d'; this.txTrnN = 0;
              this.scr3.fill(0);                       // §8.4.5
              c--; continue;
            }
            const inv = this.txSdRep >= SD_NORMAL_REPS;
            this.txSyms = sdRepetition(inv);
            this.txSdRep++;
          }
          out[c] = toFloat(this.txSyms.shift());
          break;
        }
        // §8.4.5 — the U_INFO codeword, signs from binary ones through the
        // scrambler. Sign 1 is positive, sign 0 negative.
        case 'trn1d': {
          if (this.txTrnN >= TRN1D_SYMBOLS) {
            // §9.3.1.4: Jd follows. §8.4.2's differential encoder "shall be
            // initialized with the final symbol of the transmitted TRN1d".
            this.txStage = 'jd'; this.txJdRep = 0; this.txJdBits = null;
            c--; continue;
          }
          const sign = this._scramble3(1);
          this._lastP3Sign = sign;
          this.txTrnN++;
          out[c] = toFloat(signedCodeword(U_INFO, sign));
          break;
        }
        // §8.4.2 / §8.4.3 — Table 13's 72 bits, then twelve zeroes, both
        // scrambled, differentially encoded, and carried as the SIGN of the
        // U_INFO codeword.
        case 'jd':
        case 'jprimed': {
          if (!this.txJdBits || !this.txJdBits.length) {
            if (this.txStage === 'jd') {
              // §9.3.1.5: "The digital modem shall continue to repeat the Jd
              // sequence until it detects S. It shall then complete the current Jd
              // sequence and then transmit J′d." That is now what happens — the S
              // is §9.3.2.7's, detected by the upstream V.34 receiver — where a
              // fixed repetition count both ends read used to stand in for it.
              // Completing the CURRENT sequence is why the test is here, at a
              // sequence boundary, rather than per symbol.
              if (this._analogueSSeen()) {
                this.txStage = 'jprimed';
                this.txJdBits = new Array(JPRIME_BITS).fill(0);
              } else {
                this.txJdRep++;
                this.txJdBits = P3.buildJd({
                  rates: [this._rate],
                  cpConst: 0, rrConst: 0,
                  lookahead: this.lookahead || 1,
                }).slice();
              }
            } else {
              // J′d done. DIL if one was requested, else straight on — §9.3.1.5
              // sends the modem to Phase 4 when the requested DIL is zero-length.
              this._loadDilSegment();
              if (this.txDilSyms.length) { this.txStage = 'dil'; c--; continue; }
              if (!this._enterData()) break;
              c--; continue;
            }
          }
          const bit = this._scramble3(this.txJdBits.shift());
          const sign = this._lastP3Sign ^ bit;        // differential encoding
          this._lastP3Sign = sign;
          out[c] = toFloat(signedCodeword(U_INFO, sign));
          break;
        }
        // §8.4.1 — the requested probe. §9.3.1.6: "The digital modem shall send the
        // DIL requested by the analogue modem. After receiving a subsequent
        // S-to-S̄ transition, the digital modem shall complete sending the current
        // segment of the DIL and proceed to Phase 4." Both halves are now signals:
        // the transition is §9.3.2.10's, counted by the upstream V.34 receiver, and
        // "complete the current segment" is why the test sits at a segment boundary
        // rather than per symbol. §8.4.1's requirement that DIL terminate on a
        // segment boundary is therefore met by the procedure rather than by playing
        // exactly one repetition and stopping.
        case 'dil': {
          if (!this.txDilSyms.length) {
            // Phase 4 also needs CP: the digital modem cannot encode a data frame
            // until the analogue modem has told it which constellations to use.
            // Both conditions are tested TOGETHER, and only at a segment boundary,
            // because the alternative is emitting silence while waiting — and
            // silence here is not merely quiet, it is a number of samples that is
            // not a multiple of six, which walks the whole downstream off the data
            // frame phase Sd established. Another segment is the correct filler:
            // §8.4.1 repeats the sequence until the analogue modem terminates it,
            // so continuing to probe while waiting for CP is the procedure rather
            // than a stall.
            if (this._dilTerminated() && this._enterData()) { c--; continue; }
            this._loadDilSegment();
            if (!this.txDilSyms.length) { if (!this._enterData()) break; c--; continue; }
          }
          const sym = this.txDilSyms.shift();
          out[c] = toFloat(signedCodeword(sym.ucode, sym.sign > 0 ? 1 : 0));
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

  /**
   * Phase 3's scrambler: GPC again (§5.3 defers to clause 7/V.34, which is what
   * _scramble runs), but on its OWN register.
   *
   * §8.4.5 requires the scrambler to be initialized to zero before TRN1d, and
   * the data scrambler is reset when data begins. Sharing one register would
   * make the data path's state depend on how many Phase 3 symbols happened to
   * be sent, which is a coupling with nothing to gain: the two are separate
   * runs of the same polynomial, and keeping them separate leaves the tested
   * data path bit-identical to before Phase 3 existed.
   */
  /**
   * Enter data mode, or report that it cannot be entered yet.
   *
   * Phase 4 needs CP: the digital modem cannot encode a data frame until the
   * analogue modem has told it which constellations to use, and `coder` does not
   * exist until _applyCP builds it. In practice CP has long since arrived — it
   * is written immediately after Ja on the same byte channel and DIL is seconds
   * long — but the stage machine must not be able to reach the coder without it,
   * and returning false here means the caller emits silence and asks again.
   */
  _enterData() {
    if (!this._cpApplied || !this.coder) return false;
    const mp = this._buildMPBytes();
    this.txCtrlQ = [DLE, CTL_MP, (mp.length >> 8) & 0xff, mp.length & 0xff,
                    ...mp, DLE, CTL_DATA];
    this.coder.reset();
    this.txStage = 'data';
    return true;
  }

  _scramble3(bit) {
    const r = this.scr3;
    const o = bit ^ r[this._txTap] ^ r[22];
    r.unshift(o); r.pop();
    return o;
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
    if (this.isDigital) {
      this.up.receiveAudio(f32);
      this._huntJa();          // §9.3.1.3 — Ja arrives as Phase 3 signal, not as data
      return;
    }

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
        // Sd first: its repetitions carry the zero symbol at intervals 1 and 4
        // and nothing else on this link does, so the discriminator finds where
        // Sd ends. It is consulted ONLY here — once Phase 3 has begun, DIL
        // deliberately probes the low Uchords whose magnitudes (Ucode ≤ 22,
        // |mag| ≤ 57) sit inside SD_ZERO_TOL and would read as Sd zeros.
        if (this._p3Stage === 'sd') {
          if (isSdGroup(v)) {
            // §9.3.2.4's gate is the Sd-to-S̄d transition, not the end of Sd:
            // §8.4.4 sends 64 normal repetitions then 8 sign-inverted ones, so the
            // transition is the polarity flip INSIDE the run.
            if (!this._sbarDSeen && sdMatches(v, MAG[SD_W_UCODE], true)) this._sbarDSeen = true;
            this._sdGroups++; continue;
          }
          // First group that is not Sd is TRN1d's first frame — its codeword is
          // U_INFO, which is never near zero.
          this._p3Stage = 'trn1d';
        }
        // §9.3.2.5 to §9.3.2.8: TRN1d, then Jd, then J′d, read as SIGNALS. TRN1d's
        // signs are scrambled ones and are NOT differentially encoded (§8.4.5),
        // while Jd and J′d are (§8.4.2, §8.4.3) — so decoding everything
        // differentially turns TRN1d into noise that cannot match Jd's frame sync,
        // and the sync is what finds Jd without counting through TRN1d.
        if (this._p3Stage !== 'dil') { this._p3Downstream(v); this._sdGroups++; continue; }

        // §9.3.2.9 — the DIL this modem asked for. It knows every symbol of it,
        // because it wrote the descriptor; the first group that does not match is
        // the digital modem having completed its current segment and moved on
        // (§9.3.1.6). That is a discriminator built from its own request rather
        // than from a length both ends agree on.
        if (this._dilMatches(v)) { this._dilSymsSeen += SYMS_PER_FRAME; this._sdGroups++; continue; }

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

  /**
   * One six-symbol group of the digital modem's Phase 3, read as signs.
   *
   * §8.4.5, §8.4.2 and §8.4.3 all carry their bits as "the sign of the PCM codeword
   * whose Ucode is U_INFO", with a sign of 1 positive. Jd and J′d are differentially
   * encoded on top of that; TRN1d is not. Differential decoding is initial-state
   * free and the clause 7 descrambler is self-synchronising, so neither the symbol
   * the far end initialised from nor its scrambler state has to be known.
   */
  _p3Downstream(v) {
    for (let k = 0; k < SYMS_PER_FRAME; k++) {
      const sign = v[k] > 0 ? 1 : 0;
      // Downstream Phase 3 is a TWO-point signal, so its differential encoding is
      // mod 2, not V.34's mod 4: the transmitter forms each sign as the previous
      // sign XOR the bit (§8.4.2), and this inverts that. Written as the XOR the
      // clause describes rather than borrowed from the four-point decoder, whose
      // mod-4 arithmetic happens to agree here and would stop agreeing the moment
      // anything about the signal changed.
      if (this._p3PrevSign === null) { this._p3PrevSign = sign; continue; }
      const bit = sign ^ this._p3PrevSign;
      this._p3PrevSign = sign;
      const reg = this._p3Des;
      const ob = bit ^ reg[this._rxTap] ^ reg[22];
      reg.unshift(bit); reg.pop();
      this._p3Bits.push(ob);
    }
    if (this._p3Bits.length > 4096) this._p3Bits.splice(0, this._p3Bits.length - 4096);

    if (!this._jdReceived) this._huntJd();
    else if (!this._jprimeDSeen) this._huntJprimeD();
  }

  /**
   * §9.3.2.6 — find Jd. Table 13's 72 bits open with a 17-one frame sync and close
   * with a CRC, so the sync locates it and the CRC is what makes a false positive
   * out of TRN1d's differentially-misread noise effectively impossible.
   */
  _huntJd() {
    const b = this._p3Bits;
    for (let i = 0; i + P3.JD_BITS <= b.length; i++) {
      let sync = true;
      for (let k = 0; k < 17 && sync; k++) if (b[i + k] !== 1) sync = false;
      if (!sync) continue;
      const jd = P3.parseJd(b.slice(i, i + P3.JD_BITS));
      if (!jd.sync || !jd.crcOk) continue;
      this._jdReceived = true;
      this._peerDownstreamRates = jd.rates;
      this._p3Stage = 'jd';
      b.splice(0, i + P3.JD_BITS);
      return;
    }
  }

  /**
   * §9.3.2.8 — J′d is twelve binary zeroes (§8.4.3) and terminates Jd. Only whole Jd
   * repetitions precede it, so the search consumes Jd sequences as it finds them and
   * declares J′d on the first twelve-zero run that starts on a sequence boundary.
   */
  _huntJprimeD() {
    const b = this._p3Bits;
    for (;;) {
      if (b.length >= JPRIME_BITS && b.slice(0, JPRIME_BITS).every((x) => x === 0)) {
        this._jprimeDSeen = true;
        this._p3Stage = 'dil';
        this._dilExpect = this._dilSymbols();
        // Unknown, deliberately: the bit stream lags the symbol stream by whatever
        // is still queued behind J′d, so some DIL has already gone past by the time
        // twelve zeroes are visible. The phase is RECOVERED from the sequence rather
        // than derived from that backlog — this modem wrote the descriptor, so it can
        // find where in its own probe the far end has got to.
        this._dilPos = null;
        b.length = 0;
        return;
      }
      if (b.length < P3.JD_BITS) return;
      b.splice(0, P3.JD_BITS);                       // another whole Jd repetition
    }
  }

  /** The DIL this modem requested, flattened to one pass of signed codewords. */
  _dilSymbols() {
    if (!this._dil || !this._dil.n) return [];
    const out = [];
    for (const seg of P3.dilSegments(this._dil)) {
      for (const s of seg.syms) out.push(signedCodeword(s.ucode, s.sign > 0 ? 1 : 0));
    }
    return out;
  }

  /**
   * Does this group continue the DIL this modem asked for? §8.4.1 repeats the whole
   * sequence, so the expectation wraps. A group that does not match is the digital
   * modem past its last segment (§9.3.1.6) and therefore Phase 4.
   */
  _dilMatches(v) {
    const exp = this._dilExpect;
    if (!exp || !exp.length) return false;
    const at = (p) => {
      for (let k = 0; k < SYMS_PER_FRAME; k++) {
        if (Math.abs(v[k] - exp[(p + k) % exp.length]) > 32) return false;
      }
      return true;
    };
    if (this._dilPos === null) {
      // One search, on the first group after J′d. DIL runs on the six-symbol frame
      // grid (§8.4.1's Lc = (Hc+1)×6), so only multiples of six can be the phase.
      for (let p = 0; p < exp.length; p += SYMS_PER_FRAME) {
        if (at(p)) { this._dilPos = (p + SYMS_PER_FRAME) % exp.length; return true; }
      }
      return false;
    }
    if (!at(this._dilPos)) return false;
    this._dilPos = (this._dilPos + SYMS_PER_FRAME) % exp.length;
    return true;
  }

  _resync() {
    this.sdLocked = false; this.dataStart = -1; this._sdGroups = 0; this._framesDone = 0;
    this._p3Stage = 'sd';
    this._sbarDSeen = false; this._jdReceived = false; this._jprimeDSeen = false;
    this._dilSymsSeen = 0; this._dilPos = 0; this._p3Bits.length = 0;
    this._p3PrevSign = null;
    this._p3Des.fill(0);
  }

  /**
   * How many symbols of Phase 3 follow S̄d, from this modem's own descriptor.
   *
   * The analogue modem WROTE the DIL descriptor, so DIL's length is a number it
   * already holds rather than something it has to be told; §9.3.2.5 and §9.3.2.6
   * make the 2040T of TRN1d the analogue modem's own count too. What is not the
   * Recommendation's is the Jd repetition count — the real receiver decodes Jd
   * and detects J′d, and until the analogue modem's S is on the wire there is
   * nothing for the digital modem to stop on, so both
   * ends read the same constant. That is the one place this pair agrees by
   * shared constant rather than by signal, and putting Ja and S on the wire is
   * what removes it.
   *
   * Every term is a multiple of six, so the data frames that follow stay on the
   * interval-0 phase Sd established.
   */
  /**
   * The NEXT DIL segment, loaded into the transmit queue.
   *
   * One segment at a time rather than one pass at a time, because §9.3.1.6's
   * granularity is the segment — "complete sending the current segment of the DIL
   * and proceed to Phase 4" — and a queue holding a whole pass can only be
   * interrupted a pass late. §8.4.1 repeats the SEQUENCE, so the segment index
   * wraps at the end of a pass rather than the last segment repeating.
   */
  _loadDilSegment() {
    this.txDilSyms = [];
    if (!this._dil || !this._dil.n) return;
    if (!this._dilSegs) { this._dilSegs = P3.dilSegments(this._dil); this._dilSeg = 0; }
    const seg = this._dilSegs[this._dilSeg];
    this._dilSeg = (this._dilSeg + 1) % this._dilSegs.length;
    this.txDilSyms.push(...seg.syms);
  }

  /**
   * §9.3.1.4/.5's "detect signal S": the analogue modem's §9.3.2.7 S, which is the
   * SECOND S of its Phase 3 — the first is the one at the head, §9.3.2.1's, that
   * started the digital modem training in the first place.
   */
  _analogueSSeen() {
    const p3 = this.up && this.up.p3;
    return !!p3 && p3.sCount >= 2;
  }

  /**
   * §9.3.1.6's "subsequent S-to-S̄ transition": §9.3.2.10's, which is the THIRD the
   * analogue modem sends — the head's, then §9.3.2.8's after J′d, then this one.
   * The NOTE under §9.3.1.6 is about exactly this counting ("failure by the digital
   * modem to detect both S-to-S̄ transitions may result in the premature termination
   * of DIL"), which is why the target is a count and not a flag.
   */
  _dilTerminated() {
    const p3 = this.up && this.up.p3;
    return !!p3 && p3.sbarCount >= 3;
  }

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
/**
 * A PCM codeword with a sign, as the linear value the line carries.
 *
 * §8.4.5, §8.4.2 and §8.4.3 all state the same convention for the Phase 3
 * signals: "A sign of 0 represents a negative voltage, a sign of 1 represents a
 * positive voltage." MAG[] is the µ-law magnitude table the mapper already
 * builds, so this is that sentence and nothing else.
 */
function signedCodeword(ucode, sign) {
  return sign ? MAG[ucode] : -MAG[ucode];
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
