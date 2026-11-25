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

const { TONE_AMP, LINE_RMS, rmsAt } = require('../LineLevel');
const { EventEmitter } = require('events');
const config = require('../../../config');
const { V34, retrainWatch } = require('./V34');
const P2V34 = require('./V34Phase2');
const {
  makeConfig, configFromCP, trainingConfig, KT_MAX, legalRates, buildConstellation, defaultMask,
  maskFromUcodes, ucodesFromMask, V90Coder, MAG, A_MAG, UCODES, toFloat, fromFloat,
  quantCoef, DEFAULT_COEFS, DEFAULT_UCODE_MIN, averagePower,
} = require('./V90Mapper');
const P4 = require('./V90Phase4');
const P3 = require('./V90Phase3');
const DIL = require('./V90Dil');
// Table 12's field accessors, for reading a DIL descriptor out of the Ja bits the
// upstream V.34 receiver recovers. V.34's own Phase 3 module is not needed here:
// the downstream signals are two-point and their differential encoding is mod 2,
// which _p3Downstream does as the XOR §8.4.2 describes.
const BF = require('./BitFrame');
// §8.2's Phase 2: Tables 7, 8, 9 and 10, and the V.34 signals every one of them is
// defined by reference to.
const V90P2 = require('./V90Phase2');
const P2 = require('./V34Phase2');

const SR = 8000;
const SYMS_PER_FRAME = 6;

// Upstream is V.34 at its top rate. V.90 §6.1 makes 4800–28800 mandatory and
// 31200/33600 optional; we have 33600, so we take it.
const UPSTREAM_RATE = 33600;
// Table 10 bits 34:36 name the upstream symbol rate as an index into V.34's own
// labelling, and 33600 is 3429 baud, which is index 5. Derived rather than written:
// the two must not be able to disagree.
const UPSTREAM_SR_INDEX = P2.SYMBOL_RATES.indexOf(3429);

// ── U_INFO — the codeword every Phase 3 downstream signal is built on ───────
// Table 10/V.90 bits 25:31 carry it in INFO1a: "U_INFO: Ucode of the PCM
// codeword to be used by the digital modem for the 2 point train... U_INFO
// shall be greater than 66." §8.4.4 then builds Sd's W from 16 + U_INFO, which
// caps it at 111. It is the ANALOGUE modem's choice, because Table 10 is the
// analogue modem's sequence, and this constant is that choice. It is no longer
// what the digital modem uses: §9.2.2.1.9 puts it on the wire and the digital
// modem reads it out of INFO1a, so `this._uInfo` is the value in force at either
// end. A digital modem that never received an INFO1a has nothing but this, which
// is what it used before Phase 2 existed.
//
// 111 is the top of the legal range, and taking it means 16 + U_INFO is 127:
// exactly the value SD_W_UCODE was hardcoded to before this, so Sd is unchanged
// bit for bit while W stops being a number with a comment and becomes a
// derivation from the clause that defines it.
//
// It is also the only value in the range that leaves TRN1d and Jd — which ride
// the U_INFO codeword itself, four Uchords below Sd's W — inside the level band
// the DIL sits in; anything lower drops the rest of Phase 3 below the DIL floor
// instead. §8.4.4 fixes the ~4.3 dB Sd-to-TRN1d step, so U_INFO moves the pair
// together and cannot close it.
const U_INFO = 111;

// ── Sd training signal ──────────────────────────────────────────────────────
// 64 repetitions of {+W, +0, +W, −W, −0, −W}, then 8 of the sign-inverted
// pattern. §8.4.4 defines W as the codeword whose Ucode is 16 + U_INFO; "0" is
// Ucode 0, whose magnitude is 0. Note that a DATA frame can never contain a zero
// sample — the working constellation starts at Ucode 37 (magnitude 139) — so "is
// this group a zero-bearing Sd repetition?" is an exact, collision-free
// discriminator for finding where Sd ends.
// §8.4.4's W follows U_INFO, so once U_INFO is negotiated so is W: both live on
// the instance, and this is what one starts with.
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
//   L_SP and L_TP are deliberately COPRIME WITH SIX, and with EACH OTHER. A
//   data frame is six symbols and the impairments DIL is meant to find —
//   robbed-bit signalling above all — are per-frame-interval, so a pattern
//   length sharing a factor with six puts the same probe in the same interval
//   on every repetition and could never see them. Coprime with each other is
//   the second half and is about what the probe SOUNDS like: SP and TP of the
//   same period repeat together, which makes the whole segment periodic at that
//   period and puts a line spectrum on it. 127 and 125 have no common factor,
//   so the pair does not repeat inside a 768-symbol segment at all.
//
//   They are 127 and 125 rather than the 11 and 7 they were because 11 and 7
//   repeat 70 and 110 times inside one segment: a probe that periodic is a tone,
//   and this signal measured five times more tonal than a real modem's Phase 3
//   where it should be indistinguishable from it. §8.4.1 allows 1..128 bits and
//   states nothing else about them.
//
//   Nothing here measures the frame-interval walk yet (see V90Phase3's foot),
//   but a transmitter that makes the measurement impossible would have to be
//   redone rather than added to.
const DIL_SEGMENTS = 32;
const DIL_H = new Array(8).fill(127);
// REFc, the reference codeword every DIL-segment falls back to on the symbols
// TP does not mark as training — about half of them. One value for all eight
// chords, and a high one: a reference that tracked the chord being trained
// (REFc = the chord's own midpoint, which is what this was) tracks the thing it
// is supposed to anchor, so a chord-1 segment had no symbol in it above Ucode
// 14 and the sequence swept 58 dB from chord 1 to chord 8. A constant anchor
// holds every segment's level up to within a few dB regardless of what it
// probes. 120 rather than the maximum 127 leaves 3.6 dB of headroom under
// full scale; it is non-zero, which keeps the Sd zero-bearing discriminator
// exact, and it is ≡ 8 (mod 16) where every training Ucode below is ≡ 2, 6, 10
// or 14, so a segment's training symbol and its reference can never coincide.
const DIL_REF_UCODE = 120;
const DIL_REF = new Array(8).fill(DIL_REF_UCODE);
// The order the 32 segments are asked for. §8.4.1 fixes neither an ordering nor
// a power, so this is ours: four passes, each taking one training Ucode from
// every chord, with the chords in bit-reversed order so that neighbouring
// segments are never neighbouring chords. Chord-ascending order — which is what
// this was — puts the segments in ascending level order too, and a monotone
// sweep is what a DIL is heard as rather than what it measures.
const DIL_CHORD_ORDER = [0, 4, 2, 6, 1, 5, 3, 7];

// SP and TP are maximal-length sequences from two different primitive degree-7
// polynomials — a Galois LFSR, taken as bits rather than as a table, so the
// polynomial that generates each is what the file states. Period 127, 64 ones
// to 63 zeroes. TP is truncated to 125 to make the two lengths coprime; a
// truncated m-sequence is still a pattern, which is all §8.4.1 asks for.
function mSequence(poly, length, seed = 1) {
  const out = [];
  let r = seed;
  for (let i = 0; i < length; i++) {
    const b = r & 1;
    out.push(b);
    r >>= 1;
    if (b) r ^= poly;
  }
  return out;
}
const DIL_SP = mSequence(0x41, 127);       // x⁷+x+1
const DIL_TP = mSequence(0x44, 125);       // x⁷+x³+1, truncated

// ── Audible startup ─────────────────────────────────────────────────────────
const ANS_TONE_FREQ = 2100, ANS_TONE_AMP = TONE_AMP, ANS_TONE_SAMPLES = Math.round(1.0 * SR);
const CONNECT_GAP = Math.round(0.08 * SR);

// ── Phase 4 (§9.4) ──────────────────────────────────────────────────────────
// The in-band control channel is GONE in both directions. CP used to be packed
// into bytes on the upstream and MP into bytes on the downstream; §9.4.2 puts CP
// on §10.1.3.9/V.34's modulation (the upstream V.34's Phase 4) and §9.4.1 puts MP
// on the sign of the PCM codeword, which is what Table 16's "fill bits to the next
// multiple of 6 symbols" says it is. Only the carriage changed — every bit of both
// sequences was already the Recommendation's. There is no CTL_JA either, for the
// same reason one phase earlier.
//
// §9.4.1.1's Ri minimum, §9.4.1.2's R̄i and TRN2d, and §8.6.1/.2's Ed and B1d.
const RI_MIN_SYMBOLS = P4.R_MIN_SYMBOLS;      // 192T
const TRN2D_SYMBOLS = P4.TRN2D_MIN_SYMBOLS;   // 2040T
// A received sample in Table 1's sixteen-bit scale as a fraction of it (V90Dil's level).
const PCM_TO_LEVEL = 4 / 32768;
const RD_SYMBOLS = 384;                       // §9.6.1.1.1, "Rd for 384T"
// §9.6.1 / §9.6.2: E (or Ed) "within 5000 ms plus 2 round-trip delays"; a round
// trip is taken as 200 ms, a long one for a terrestrial call.
const RENEG_E_SAMPLES = Math.round((5.0 + 2 * 0.2) * SR);
// §11.4's rule for MP applies here too: a sequence sent once is eaten by the
// receiver's descrambler settling after a signal that is not differentially
// encoded. Two is the floor, and the cap is what makes a lost CP degrade to a
// connect rather than to a hang.
const P4_SEQ_MIN_REPS = 2, P4_MP_MAX_REPS = 24;

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
    // The upstream is the analogue modem's, scrambled with GPA (§6.5) whichever
    // end this is; the digital modem's own transmissions are GPC (§5.3). The V.34
    // instance would otherwise pick by ROLE, which makes the caller GPC — the
    // reverse of V.90, and invisible to a loopback because both ends inherit it.
    if (this.isDigital) this.up.setScramblers('GPC', 'GPA');
    else                this.up.setScramblers('GPA', 'GPC');
    // §9.2/V.90 is V.90's own probing and ranging, between the analogue and the
    // digital modem, and it is not §11.2/V.34 — but it is §11.2's procedure with the
    // two modems renamed, clause for clause and bound for bound, so it runs on that
    // machine with V.90's own parts and V.90's own INFO sequences. `_phase2Profile`
    // is that, and V90Phase2.js is the transcription behind it.
    this.up.setPhase2Profile(this._phase2Profile());
    if (this.isDigital) {
      // §9.2.1's part is played through this class; §9.3.1's is not. The digital
      // modem's Phase 3 is Sd and TRN1d as PCM codewords, generated below, so the
      // V.34 instance transmits Phase 2 and then stops. Its receiver carries on and
      // is what detects the analogue modem's S, S̄ and Ja.
      this.up.setPhase2Only(true);
      // The ANSam is this class's, emitted in the `tone` stage. Without this the
      // V.34 instance would put a second one in front of its own Phase 2.
      this.up.setV8Complete(true);
    }
    // §9.3.2.1 gives the ANALOGUE modem the leading part in Phase 3 — 70 ± 5 ms of
    // silence, then S for 128T and S̄ for 16T — where V.34 §11.3.1.2.1 gives it to
    // the answer modem. The digital modem answers on the PCM side with Sd and is
    // not a V.34 transmitter, so a V.34-gated originate would wait for an S that
    // this link never carries.
    if (!this.isDigital) {
      this.up.setPhase3Lead(true);
      // The tail itself is installed at the END of the constructor: it sets _dil,
      // and the downstream-state block below still assigns _dil = null.
    }
    // The analogue modem's Phase 3 carries THREE S-to-S̄ transitions (§9.3.2.1,
    // §9.3.2.8, §9.3.2.10) with §9.3.2.4's silence between the first and second. The
    // upstream receiver needs no telling: it reads Phases 3 and 4 as one procedure
    // across any silence and leaves it only on the analogue modem's E.

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
    // §9.2.2.1.9 / Table 10 bits 25:31 — U_INFO in force, and §8.4.4's W with it.
    // The analogue modem sets both from its own choice and sends them; the digital
    // modem replaces both when INFO1a arrives.
    this._uInfo = U_INFO;
    this._sdW = SD_W_UCODE;
    // The digital modem's law is its network's (§3.6): configured, named in INFO0d
    // (bit 39), and what every codeword it sends is the level of. The analogue
    // modem learns it from that INFO0d.
    this._aLaw = this.isDigital && nat.v90Law === 'a';
    this._txMag = this._aLaw ? A_MAG : MAG;
    this._peerUpstreamRates = [];

    // Scrambler taps, by modem type: the digital modem scrambles with GPC (§5.3)
    // and the analogue modem with GPA (§6.5), and each descrambles with the other's.
    // Clause 7/V.34's polynomials; 17 is x⁻¹⁸ (GPC) and 4 is x⁻⁵ (GPA).
    this._txTap = this.isDigital ? 17 : 4;
    this._rxTap = this.isDigital ? 4 : 17;

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
    // Nothing but user data crosses either direction now, so the digital modem
    // reads the upstream as data from the first byte; the analogue modem opens its
    // side where §9.4.1 says data begins, which is after Ed and B1d.
    this._rxData = this.isDigital;
    this._upReady = false;
    this.peerRate = 0;

    // ── Phase 4 (§9.4) ─────────────────────────────────────────────────────
    this._p4Stage = null;        // digital: transmit stage; analogue: receive stage
    this._p4N = 0;               // symbols emitted in the current transmit stage
    this._p4Reps = 0;
    this._cptSeen = false;       // §9.4.1.1's gate off Ri
    this._cpPrimeSeen = false;   // §9.4.1.4's gate onto Ed
    this._p4Bits = [];           // the training-constellation bit stream
    this._p4Scan = 0;            // forward cursor into it — see _huntMP
    this._cpScan = 0;            // absolute cursor into the upstream Phase 3 ring
    this._rPolarity = null;      // §8.6.4's NOTE: R and R̄ differ by polarity alone
    this._rbarSeen = false;      // the R-to-R̄i transition §9.4.2.1 waits for
    this._mpPrimeSeen = false;

    // ── Wire the upstream ───────────────────────────────────────────────────
    if (this.isDigital) {
      // Digital modem: upstream V.34 carries the analogue modem's data AND its CP.
      // The upstream carries CP and never V.34's own MP, so this instance's Phase 4
      // is V.90's too — receive-only, since the digital modem transmits no V.34
      // signal after §9.2. Declaring it is what keeps V.34's MP hunt off a stream
      // that will never hold one.
      // E follows CP′ (§9.4.2.4), so CP′ is what arms the upstream receiver's E
      // detector, from which it enters data mode at B1.
      this.up.setPhase4({ inbound: true, ackSeen: () => this._cpPrimeSeen });
      this.up.on('data', buf => { this.emit('data', buf); });
      this.up.on('ready', () => { this._upReady = true; this._maybeReady(); });
      // §9.6.1.2: the analogue modem's S in data mode is a rate renegotiation, and
      // its E at the end of one is the upstream's data mode again.
      this.up.setRenegInData(true);
      this.up.on('retrain', (e) => {
        if (!e || e.why !== 'far end renegotiates') return;
        this._beginReneg(false);
      });
      this.up.on('retrained', () => { this._upReady = true; this._renegDone(); });
    } else {
      // Analogue modem: queue CP immediately. Note we cannot wait for the
      // upstream V.34 to fire 'ready' — that event means "my RECEIVER acquired
      // the peer", and this side only ever transmits V.34; its receiver is the
      // downstream PCM decoder. Queuing now is correct anyway: V34.write() parks
      // the bytes behind its own rate-exchange control frames, so CP goes out as
      // the first thing on the upstream the instant data mode opens.
      // Ja is a Phase 3 SIGNAL (§8.3.1) and CP is now a Phase 4 one (§9.4.2, on
      // §10.1.3.9/V.34's modulation), so neither is queued as bytes: both are
      // handed to the upstream V.34's own stage machine.
      // Last, because they set _dil and the downstream-state block above clears it.
      this._installPhase3Tail();
      this._installPhase4();
      this._configureTraining(P4.parseCP(this._buildCPBits(true), this.constellationSet.length));
    }
  }

  /**
   * §9.2's part, and the four sequences that go with it.
   *
   * The role split is §9.2's own and it is the mirror of V.34's: the DIGITAL modem
   * — this class's answer side — plays the part §11.2 gives the call modem, tone B
   * and INFO0d; the ANALOGUE modem, which is the originate side and the one a
   * browser runs, plays the answer modem's part with tone A and INFO0a. Getting
   * that backwards would put both modems on the same tone, which is the same shape
   * of mistake `setPhase3Lead` exists to prevent one phase later.
   *
   * Table 8 is Table 14/V.34 and Table 9 is Table 15/V.34 — the Recommendation says
   * so and V90Phase2.js asserts it — so INFO0a and INFO1d are built by the V.34
   * class's own builders and only INFO0d and Table 10's INFO1a are supplied here.
   */
  _phase2Profile() {
    if (this.isDigital) {
      return {
        part: 'toneB',
        info0: () => this._info0dBits(),
        peerInfo0: V90P2.INFO0A,
        peerInfo1: V90P2.INFO1A_V90,
        settle: (p2, info1) => this._settlePhase2Digital(info1),
      };
    }
    return {
      part: 'toneA',
      info1: () => this._info1aBits(),
      peerInfo0: V90P2.INFO0D,
      peerInfo1: V90P2.INFO1D,
      settle: () => this._settlePhase2Analogue(),
    };
  }

  /**
   * Table 7/V.90 — INFO0d, which is Table 14/V.34's capability bits plus what only
   * a digital modem can declare.
   *
   * The V.34 capability half describes V.34 MODE — what this modem would fall back
   * to if the analogue modem asked for it in INFO1a bits 37:39 — so it is the
   * upstream V.34 instance's own answer, taken from it rather than restated.
   */
  _info0dBits() {
    const v34 = P2.parseInfo(P2.INFO0, this.up.phase2Info0Bits()) || {};
    return P2.buildInfo(V90P2.INFO0D, {
      rate2743: v34.rate2743 | 0, rate2800: v34.rate2800 | 0, rate3429: v34.rate3429 | 0,
      lowCarrier3000: v34.lowCarrier3000 | 0, highCarrier3000: v34.highCarrier3000 | 0,
      lowCarrier3200: v34.lowCarrier3200 | 0, highCarrier3200: v34.highCarrier3200 | 0,
      allow3429: v34.allow3429 | 0,
      canReducePower: 0,                 // no transmit level control on this link
      maxRateDifference: 0,
      cme: 0,
      support1664: v34.support1664 | 0,
      reserved26: 0,
      ackInfo0: v34.ackInfo0 | 0,        // §9.2.1.2.1's bit 28, kept in step with V.34's
      // Bits 29:32 and 33:37 are transmit power, "in −1 dBm0 steps where 0
      // represents −6 dBm0" and "−0.5 dBm0 steps where 0 represents −0.5 dBm0".
      // This link has no transmit level control at either end, so both declare the
      // top of their range, which is the nominal each clause names.
      nominalPower: 0,
      maxPower: 0,
      // Bit 38 — "the digital modem's power shall be measured at the output of the
      // codec". It is: this modem's output IS codewords, and there are no terminals
      // downstream of them on this transport.
      powerAtCodec: 1,
      // Bit 39 — "0 = µ-law, 1 = A-law". `_aLaw` is what the mapper is built on.
      aLaw: this._aLaw ? 1 : 0,
      // Bit 40 — "ability to operate V.90 with an upstream symbol rate of 3429",
      // which is exactly the rate the upstream V.34 runs.
      upstream3429: 1,
      reserved41: 0,
    });
  }

  /**
   * Table 10/V.90 — INFO1a, the analogue modem's request for V.90.
   *
   * Every field here was a locally chosen constant before this: U_INFO, the
   * upstream symbol rate and MD's length were agreed by both ends reading the same
   * number rather than by either end saying it, and a value both ends read cannot
   * be caught by any round trip however wrong it is. So they are transmitted now.
   */
  _info1aBits() {
    return P2.buildInfo(V90P2.INFO1A_V90, {
      reserved12: 0,
      // §10.1.3.5/V.34, as INFO1c: no manufacturer-defined signal, so no MD.
      mdLength: 0,
      uinfo: this._uInfo,
      reserved32: 0,
      // Bits 34:36 — the upstream V.34's symbol rate, as an index into V.34's own
      // labelling. 33600 runs at 3429, which is index 5.
      upstreamSymbolRate: UPSTREAM_SR_INDEX,
      // Bits 37:39 — the integer 6: "V.90 operation is desired". This is the field
      // §9.2.1.1.8 branches the whole Recommendation on.
      mode: V90P2.MODE_V90,
      frequencyOffset: 0,                // measured: this link has none
    });
  }

  /**
   * §9.2.1.1.8 — what the digital modem does with INFO1a.
   *
   * "Proceed to Phase 3 of the start-up procedure if bits 37:39 of INFO1a indicate
   * the integer 6. If bits 37:39 indicate an integer between 0 and 5, the digital
   * modem shall proceed in accordance with 11.3.1.1/V.34 assuming the role of a
   * call modem." The second branch is a V.34 call, which this class does not become
   * — the modulation was already chosen in V.8 — so a mode other than 6 is recorded
   * rather than acted on, and the connect goes on as V.90.
   */
  _settlePhase2Digital(info1) {
    this.phase2Mode = info1.mode;
    if (info1.mode !== V90P2.MODE_V90) {
      this.phase2ModeMismatch = `INFO1a asked for mode ${info1.mode}; this build runs V.90 only`;
      return;
    }
    // Table 10 — "UINFO: Ucode of the PCM codeword to be used by the digital modem
    // for the 2 point train ... UINFO shall be greater than 66." A value outside
    // that is not a value to use: the clause's floor is what makes Sd's zero-bearing
    // discriminator collision-free, so an out-of-range request is refused and the
    // default kept.
    if (info1.uinfo >= V90P2.UINFO_MIN && info1.uinfo <= V90P2.UINFO_MAX) {
      this._uInfo = info1.uinfo;
      this._sdW = P3.sdWUcode(info1.uinfo);
    } else {
      this.phase2ModeMismatch = `INFO1a asked for UINFO ${info1.uinfo}, outside Table 10's range`;
    }
    this.peerUpstreamSr = info1.upstreamSymbolRate;
  }

  /**
   * The signal on the wire now, named as §8/§9 name it. Read-only, like V34's.
   * The DIGITAL modem's downstream is this class's own stage machine; the
   * ANALOGUE modem transmits through the V.34 instance, so it defers to that —
   * which is the same split setPhase3Lead and setPhase2Profile exist for.
   */
  describe() {
    if (!this.isDigital) return this.up ? this.up.describe() : null;
    const st = this.txStage;
    if (st === 'phase2') return this.up ? this.up.describe() : { phase: 2, signal: null };
    const PHASE = { tone: 1, sd: 3, trn1d: 3, jd: 3, jprimed: 3, dil: 3, p4: 4, data: 5 };
    if (!(st in PHASE)) return null;
    return { phase: PHASE[st], signal: st };
  }

  /** The analogue modem chose all of it, so there is nothing to read back. */
  _settlePhase2Analogue() {
    this.phase2Mode = V90P2.MODE_V90;
    // INFO0d names the digital modem's law (bit 39) and its Table 15 power limit
    // (bits 33:37); the DIL asked for and what is chosen from it depend on both.
    const i0 = this.up._p2 && this.up._p2.peerInfo0;
    if (i0) { this._law = i0.aLaw ? 'a' : 'mu'; this._maxPower = i0.maxPower | 0; }
    this._installPhase3Tail();
  }

  // ─── Phase 3: the DIL descriptor (analogue → digital) ─────────────────────
  /** The descriptor this modem asks for. See the DIL_* constants for the why. */
  _buildDILDescriptor() {
    // The analogue modem's DIL is the one it learns the route from (V90Dil.design):
    // every codeword up to a third of full scale, six frames each.
    if (!this.isDigital) return DIL.design(this._law || 'mu', this._uInfo);
    // Four Ucodes per chord, evenly spaced inside it, skipping the chord's own
    // REF so a segment's training symbol and its reference are never the same
    // codeword — a segment where they coincide carries no information.
    // The set is unchanged from chord-ascending order; only the ORDER moved, so
    // that consecutive segments do not climb in level. See DIL_CHORD_ORDER.
    const ucodes = [];
    for (let k = 0; k < DIL_SEGMENTS / 8; k++) {
      for (const c of DIL_CHORD_ORDER) {
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
      dilDone: () => (this.isDigital ? this._dilSymsSeen >= dilSyms : !!this._dilChosen),
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
      if (this.up.p3) this.up.p3.trimmed += i + 1;
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
  /**
   * V.42 (vendor/src/ec): while a link is set, data-mode bits come from and go to
   * it in place of start-stop characters. Each direction is its own pump here:
   * the digital modem sends downstream PCM and hears the upstream V.34, the
   * analogue modem the reverse; null puts the characters back.
   */
  setBitLink(link) {
    this._link = null;
    if (!link) { this.up.setBitLink(null); return; }
    if (this.isDigital) {
      this._link = { nextBit: link.nextBit, feedBit: () => {} };
      this.up.setBitLink({ nextBit: () => 1, feedBit: link.feedBit });
    } else {
      this._link = { nextBit: () => 1, feedBit: link.feedBit };
      this.up.setBitLink({ nextBit: link.nextBit, feedBit: () => {} });
    }
  }

  write(bytes) {
    if (this.isDigital) { for (const b of bytes) this.txByteQ.push(b & 0xff); }
    else this.up.write(bytes);
  }

  /**
   * Payload bytes still queued for transmission. Follows write()'s split: the
   * analogue modem holds nothing of its own, so reading txByteQ for both roles
   * would report an upstream that is never draining as permanently empty.
   */
  get txPending() { return this.isDigital ? this.txByteQ.length : this.up.txPending; }

  // ─── Downstream configuration (exactly what CP carries) ───────────────────
  _configureDownstream() {
    const set = this.constellationSet;
    this.C = this.intervalIndex.map((i, k) => buildConstellation(set[i] || set[0], this._arrived(k)));
    this.coder = new V90Coder(this.cfg, this.C, { coefs: this.coefs, lookahead: this.lookahead, mag: this._txMag });
    // §8.6.4's Rd: "the highest power PCM codeword from the data mode
    // constellation of each data frame interval as passed in CP", as it arrives.
    this._rdMagsNow = this.C.map((c) => c.ascMag[c.ascMag.length - 1].mag);
  }

  /**
   * §9.4.2.1's CPt — "the constellation parameters that the digital modem shall use
   * during Phase 4 TRAINING" — as an encoder of its own.
   *
   * §§8.6.2, 8.6.3 and 8.6.5 all send TRN2d, MP and Ed through §5.4's encoder on this
   * set, not on the data-mode one, and not as a sign on a single codeword: the
   * training constellation is what the analogue modem's receiver is conditioned for
   * before CP has told either end what data mode will be. Both ends build it from the
   * same CPt — the analogue modem from the one it wrote, the digital modem from the
   * one it read.
   */
  _configureTraining(cp) {
    this._cpt = cp;
    const C = cp.intervalIndex.map((i, k) => buildConstellation(cp.constellations[i] || cp.constellations[0], this._arrived(k)));
    this.cfgT = trainingConfig(cp.drn, cp.Sr);       // CPt's drn is +8, not CP's +20
    this.coderT = new V90Coder(this.cfgT, C, { coefs: cp.coefs, lookahead: cp.ld, mag: this._txMag });
    this._desT = new Array(23).fill(0);
    this._p4Bits = [];
  }

  /** Whether data is crossing the line: until a retrain begins (§9.5). */
  get carrying() { return this._ready && !this._retraining && !this._reneg; }

  /**
   * Begin a retrain from data mode (§9.5.1.1, §9.5.2.1). V.90's start-up holds
   * too much of a call's state to wind back in place, so the handshake answers
   * `retrain` with a fresh instance that enters Phase 2 at the retrain's step
   * (resumeFrom), as BinModem's modem goes back to its phase 2.
   */
  retrain() {
    if (!this._ready || this._retraining) return false;
    this._retraining = true;
    this.emit('retrain', { why: 'asked' });
    return true;
  }

  /**
   * This instance continues a call `prev` was carrying: §9.5's silence, then
   * this modem's tone and Phase 2 from §9.2.1.1.3 (digital, tone B) or
   * §9.2.2.1.3 (analogue, tone A), the INFO0s as exchanged at the call's start.
   * Bytes written and not yet sent go with it.
   */
  resumeFrom(prev) {
    const was = prev.up && prev.up._p2;
    this.up._p2Retrain = true;
    this.up._p2.peerInfo0 = was && was.peerInfo0;
    this._retraining = true;
    if (this.isDigital) this.txByteQ = prev.txByteQ;
    else this.up.txByteQ = prev.up.txByteQ;
  }

  /** Handshake tells us whether a genuine V.8 Phase 1 already ran. */
  setV8Complete(done) {
    this._v8Done = !!done;
    // Straight into §9.2, not into the silence that waits for Ja: Phase 2 is what
    // follows Phase 1 now, and `gap` is where it hands over.
    if (done && this.txStage === 'tone') this.txStage = 'phase2';
  }

  // ─── Phase 4: CP (analogue → digital, over the upstream V.34) ─────────────
  // Genuine Table 14/V.90 bit layout — see V90Phase4.js. CP is what actually
  // configures the downstream: rate (drn), shaping redundancy (Sr), lookahead,
  // the shaper coefficients in the spec's signed Q1.6, the codec selection, the
  // constellation set and the per-interval index. The digital modem cannot send
  // a data frame until it arrives.
  /** The analogue modem's CPt configuration: data mode's S, K at most Table 17's. */
  _trainingCfg() {
    const S = this.cfg.S, K = Math.min(KT_MAX, this.cfg.K);
    return trainingConfig(K + S - 8, 6 - S);
  }

  _buildCPBits(cpt = false, ack = false) {
    return P4.buildCP({
      cpt,
      // CPt's rate is Table 17's, coded (drn + 8) — see trainingConfig. Data mode's
      // shaping with K capped at Table 17's 24; the data constellations carry at
      // least that, since they carry the data K.
      drn: cpt ? (this._trainChoice ? this._trainChoice.drn : this._trainingCfg().drn) : (this._renegCfg || this.cfg).drn,
      Sr: (this._renegCfg || this.cfg).Sr,
      // Table 14 bits 49:50 — lₐ is the analogue modem's choice, and §9.4.2.1 lets it
      // make a different one for training than for data. Zero is taken for CPt: the
      // shaper's lookahead is a pipeline delay, so a non-zero one leaves the last lₐ
      // frames of every Phase 4 signal inside the encoder — and the signal that ends
      // Phase 4 is Ed, which is two frames long.
      ld: cpt ? 0 : this.lookahead,
      ack: ack || this._mpSeen,
      silent: false,
      aLaw: !this.isDigital && this._law === 'a',      // §Table 14 bit 35: the law INFO0d named
      upstreamRates: this.up.rateLadder(),
      coefs: this.coefs,
      trnRatio: 1,                                     // no codec-output attenuation here
      constellations: cpt && this._trainChoice ? this._trainChoice.constellations : (this._renegSets || this.constellationSet),
      intervalIndex: cpt && this._trainChoice ? this._trainChoice.intervalIndex : this.intervalIndex,
      constellationsDiffer: false,
    });
  }
  /**
   * §9.4.2's part of Phase 4, handed to the upstream V.34: CPt until the digital
   * modem's R-to-R̄i transition, then CP and CP′, then §10.1.3.2/V.34's E. §8.5.2
   * gives all of them §10.1.3.9/V.34's modulation, which is the chain the upstream
   * already runs for J and Ja, so what this supplies is the bits and the one gate.
   */
  _installPhase4() {
    this.up.setPhase4({
      rbarSeen: () => this._rbarSeen,          // §9.4.2.2
      mpSeen: () => this._mpSeen,              // §9.4.2.3
      mpDone: () => this._mpPrimeSeen || this._p4Stage === 'ed',   // §9.4.2.4
      cptBits: () => this._buildCPBits(true),
      cpBits: (ack) => this._buildCPBits(false, ack),
    });
  }
  _applyCP(nCons, bits) {
    const cp = P4.parseCP(bits, nCons);
    if (!cp.sync || !cp.crcOk || !cp.isCP) {
      this.emit('cpError', { sync: cp.sync, crcOk: cp.crcOk, isCP: cp.isCP });
      return false;
    }
    this._cpData = cp;
    this.cfg = configFromCP(cp.drn, cp.Sr);            // drn + Sr pin (K,S) exactly
    this._rate = this.cfg.bitRate;
    this.lookahead = cp.ld;
    this.coefs = cp.coefs;
    this.constellationSet = cp.constellations;
    this.intervalIndex = cp.intervalIndex;
    this._peerUpstreamRates = cp.upstreamRates;
    this._cpALaw = cp.aLaw;
    this._configureDownstream();
    this._cpApplied = true;
    return true;
  }

  // ─── Phase 4: MP (digital → analogue, downstream) ─────────────────────────
  // Genuine Table 16/V.90 Type 0 layout (no precoder coefficients — the
  // precoder is degenerate on a flat channel, as it is for V.34 here).
  _buildMPBits(ack, D) {
    // The digital modem's MP sets the upstream rate (§9.4.1.3), and the upstream
    // is what this end RECEIVES: its rate is what the upstream V.34 receiver
    // measured it can take in training, latched at the first MP. Through
    // BinModem's µ-law network that is 26 400, where 33 600 does not decode.
    if (this.isDigital && !this._upCapLatched) {
      this._upCapLatched = true;
      this._rateUp = this.up._rxCap();
      this.up._mpCap = this._rateUp;
    }
    return P4.buildMP({
      D,
      drn: Math.round(this._rateUp / 2400),            // 33600 ⇒ drn 14
      ack: ack && this._cpApplied,
      trellis: 0,                                      // 16-state, matching our V.34
      nonlinear: false,
      expandedShaping: false,
      upstreamRates: this.up.rateLadder(),
    });
  }
  _applyMP(bits) {
    const mp = P4.parseMP(bits);
    if (!mp.sync || !mp.crcOk) { this.emit('mpError', { sync: mp.sync, crcOk: mp.crcOk }); return false; }
    this._rateUp = mp.drn * 2400;
    // The analogue modem's upstream transmitter runs the rate the digital modem
    // asked for (V34._useRate reads it at data entry).
    if (!this.isDigital) this.up._mpCap = this._rateUp;
    this.peerRate = this._rate;
    this._mpSeen = true;
    return true;
  }

  /**
   * §9.4.2 — CP off the upstream Phase 4 signalling, out of the same differentially
   * encoded bit stream Ja arrived in. CP's LENGTH varies with the number of
   * constellations it carries, and a real receiver gets it from the Phase 4 framing;
   * here the sequence is self-delimiting instead — the CRC only closes at the right
   * length, so one to six is tried and the one that checks is the one that was sent.
   */
  _huntCP() {
    // Only during Phase 4, which is where §9.4.2 sends CP. Scanning the Phase 3 bit
    // stream for it as well costs a six-way parse at every 17-one run in Ja and SCR,
    // for seconds, and finds nothing — the phase gate is what keeps this cheap.
    // It runs on past this end's own Phase 4 until CP′ has been read: the analogue
    // modem's E follows its CP′ (§9.4.2.4), and E is what enters the upstream's data
    // mode, however early this end's transmit side reached its own.
    if (this._cpPrimeSeen || (this.txStage !== 'p4' && this.txStage !== 'data')) return;
    const b = this.up.p3 && this.up.p3.bits;
    if (!b) return;
    // The upstream starts a new Phase 3/4 receiver at a renegotiation's S, its
    // count from zero.
    if (this._cpP3 !== this.up.p3) { this._cpP3 = this.up.p3; this._cpScan = this.up.p3.trimmed; }
    // CP's LENGTH is not known in advance — it varies with the number of
    // constellations — so one to six are tried, but only for a candidate that
    // already carries a frame sync and Table 14's start bit, and each is CRC'd IN
    // PLACE. Nothing is copied out of the buffer until one closes.
    let nHit = 0;
    const p3 = this.up.p3;
    const hit = P4.findSequence(b, this._cpScan - p3.trimmed, P4.cpLength(1), P4.CP_SYNC_BITS, (at) => {
      for (let n = 1; n <= 6; n++) {
        const len = P4.cpLength(n);
        // A longer form has not arrived yet: this candidate is undecided, not
        // rejected (see BitFrame.findSequence).
        if (at + len > b.length) return null;
        const crcStart = P4.CP_FIXED_END + n * P4.CP_CONST_BITS;
        if (P4.cpCrc(b, n, at) !== BF.getUInt(b, at + crcStart + 1, at + crcStart + 16)) continue;
        nHit = n;
        return true;
      }
      return false;
    });
    this._cpScan = hit.scanned + p3.trimmed;
    if (hit.at < 0) return;

    const n = nHit, len = P4.cpLength(n);
    const bits = b.slice(hit.at, hit.at + len);
    const cp = P4.parseCP(bits, n);
    // §9.4.1.1 gates Ri on CPt; CP proper is what configures the downstream.
    if (!cp.isCP) {
      if (!this._cptSeen) { this._cptSeen = true; this._configureTraining(cp); }
    } else {
      // §9.4.1.4 waits for a CP′ — the analogue modem acknowledging THIS modem's MP
      // — before it may send Ed, so the hunt does not stop at the first CP.
      if (cp.ack) this._cpPrimeSeen = true;
      if (!this._cpApplied) this._applyCP(n, bits);
    }
    b.splice(0, hit.at + len); p3.trimmed += hit.at + len;
    this._cpScan = p3.trimmed;
  }

  _maybeReady() {
    if (this._ready) return;
    if (this.isDigital) {
      // The digital modem is ready once the upstream carries data AND CP has told
      // it what to transmit — it genuinely cannot send a frame before that.
      if (!this._cpApplied || !this._upReady) return;
    } else {
      if (this.dataStart < 0) return;
    }
    this._ready = true;
    this._retraining = false;
    this.emit('ready', { bps: this._rate, remoteDetected: true });
  }

  // ═══ TX ═══════════════════════════════════════════════════════════════════
  generateAudio(count) {
    if (!this.isDigital) return this.up.generateAudio(count);   // analogue: V.34 upstream

    // §9.2.1 — the digital modem's Phase 2 is analogue signalling (tone B, INFO0d's
    // DPSK, L1 and L2), not PCM codewords, so it comes from the V.34 instance the
    // same way the analogue modem's does. When it ends, this class takes the wire
    // back for §9.3.1's Sd; the V.34 instance is `setPhase2Only` and transmits
    // nothing further.
    if (this.txStage === 'phase2') {
      if (!this.up.phase2Complete) return this.up.generateAudio(count);
      this.txStage = 'gap'; this.txGapN = 0;
    }

    const out = new Float32Array(count);
    for (let c = 0; c < count; c++) {
      switch (this.txStage) {
        case 'tone': {
          if (this._v8Done) { this.txStage = 'phase2'; return this.generateAudio(count); }
          const n = this.txN++;
          if (n >= ANS_TONE_SAMPLES) { this.txStage = 'phase2'; return this.generateAudio(count); }
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
            this.txSyms = sdRepetition(inv, this._sdW, this._txMag);
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
          out[c] = toFloat(signedCodeword(this._uInfo, sign, this._txMag));
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
                // Every rung up to the configured rate, not that rate alone: the
                // analogue modem chooses from what Jd enables, after measuring the
                // route with DIL (§9.3.2.10), and the CP it sends back reconfigures
                // this end (configFromCP) at whatever rung it picks. Offering one
                // rung left it nothing to fall back to — BinModem's route analysis
                // found 56 000 out of reach and could only fail the call.
                this.txJdBits = P3.buildJd({
                  rates: this._jdRates(),
                  cpConst: 0, rrConst: 0,
                  lookahead: this.lookahead || 1,
                }).slice();
              }
            } else {
              // J′d done. DIL if one was requested, else straight on — §9.3.1.5
              // sends the modem to Phase 4 when the requested DIL is zero-length.
              this._loadDilSegment();
              if (this.txDilSyms.length) { this.txStage = 'dil'; c--; continue; }
              this._enterPhase4();
              c--; continue;
            }
          }
          const bit = this._scramble3(this.txJdBits.shift());
          const sign = this._lastP3Sign ^ bit;        // differential encoding
          this._lastP3Sign = sign;
          out[c] = toFloat(signedCodeword(this._uInfo, sign, this._txMag));
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
            if (this._dilTerminated()) { this._enterPhase4(); c--; continue; }
            this._loadDilSegment();
            if (!this.txDilSyms.length) { this._enterPhase4(); c--; continue; }
          }
          const sym = this.txDilSyms.shift();
          out[c] = toFloat(signedCodeword(sym.ucode, sym.sign > 0 ? 1 : 0, this._txMag));
          break;
        }
        // §9.4.1 — Phase 4 on the downstream: Ri, R̄i, TRN2d, MP, MP′, Ed. Every
        // one of them is a PCM codeword with a sign, which is what Table 16's
        // "fill bits to the next multiple of 6 symbols" means and what retires the
        // byte channel MP used to travel on.
        case 'p4': {
          const s = this._p4Symbol();
          if (s === null) {
            // Ed has run and Phase 4 is over. B1d and data need CP; without it the
            // answer is another Ed rather than silence, for the reason DIL keeps
            // probing while it waits — silence here is a sample count that is not a
            // multiple of six and walks the downstream off Sd's data frame phase.
            if (!this._enterData()) this._p4Reps = 0;
            c--; continue;
          }
          out[c] = toFloat(s);
          break;
        }
        case 'data': {
          // §9.6.1: Rd begins on the boundary of a data frame, which is where the
          // last frame's symbols run out.
          if (!this.txSyms.length && this._reneg && !this._reneg.txStarted &&
              (this._reneg.initiating || this._farSbarSeen())) {
            this._renegTx();
            c--; continue;
          }
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
    this.coder.reset();
    this.scr.fill(0);
    // §8.6.1 — "B1d consists of 48 data frames of scrambled ones", which is what
    // the data path's warm-up run of marks already is; only its length moves.
    this.txWarmup = P4.B1D_FRAMES * this.cfg.D;
    this.txStage = 'data';
    if (this._reneg) { this._reneg.txDone = true; this._renegDone(); }
    return true;
  }

  // ─── §9.6 rate renegotiation, the digital modem ──────────────────────────
  /**
   * Begin one: `initiating` from this end (§9.6.1.1), else on the analogue
   * modem's S (§9.6.1.2.1). The downstream keeps its data frames throughout; what
   * the analogue modem sends next is S̄ and CP, read as Phase 4's are.
   */
  _beginReneg(initiating) {
    if (!this.isDigital || !this._ready || this._retraining || this._reneg) return false;
    this.renegotiations = (this.renegotiations || 0) + 1;
    this._reneg = { initiating, txStarted: false, txDone: false, at: this._rxSamples || 0 };
    this._cpApplied = false; this._cpPrimeSeen = false;
    // What the upstream's Phase 4 stream already holds is the start-up's CP′,
    // repeated: read again, it ran this renegotiation on the old parameters.
    const p3 = this.up.p3;
    if (p3) { p3.trimmed += p3.bits.length; p3.bits.length = 0; }
    this._cpScan = p3 ? p3.trimmed : 0;
    this._upReady = false;
    this.up._mpCap = this._rateUp;               // the upstream rate stays MP's
    this.emit('renegotiate', { why: initiating ? 'asked' : 'far end' });
    return true;
  }

  /**
   * Begin a rate renegotiation from data mode (§9.6.1.1 / §9.6.2.1). The digital
   * modem may offer to receive no faster than `maxUpBps` upstream (its MP); the
   * downstream rate is the analogue modem's to choose in CP. False, and nothing
   * done, outside data mode.
   */
  renegotiate(maxUpBps) {
    if (!this.isDigital) return this._renegotiateAnalogue(maxUpBps);
    if (!this._beginReneg(true)) return false;
    if (maxUpBps) {
      const r = this.up.rateLadder().filter((x) => x <= maxUpBps).pop();
      if (r) { this._rateUp = r; this.up._mpCap = r; }
    }
    return true;
  }

  /** The analogue modem's S-to-S̄ transition, in the upstream's renegotiation burst. */
  _farSbarSeen() {
    const u = this.up;
    return !!(u._reneg && u._reneg.rxStarted && u.p3 && u.p3.sbarCount > 0);
  }

  /**
   * Rd, R̄d, TRN2d, MP, MP′, Ed, then B1d and data at CP's new rate. Training goes
   * through CPt's mapping with the data CP's redundancy, look-ahead and shaping,
   * as BinModem's digital modem trains a renegotiation.
   */
  _renegTx() {
    this._reneg.txStarted = true;
    const cpt = this._cpt, cp = this._cpData;
    const built = cpt.constellations.map(m => buildConstellation(m));
    const C = cpt.intervalIndex.map(i => built[i] || built[0]);
    this.cfgT = trainingConfig(cpt.drn, cp.Sr);
    this.coderT = new V90Coder(this.cfgT, C, { coefs: cp.coefs, lookahead: cp.ld, mag: this._txMag });
    this._rdCodes = this.C.map((c) => c.members[0]);
    this.txStage = 'p4'; this._p4Stage = 'rd';
    this._p4N = 0; this._p4Reps = 0; this.txP4Bits = null;
    this.txP4Syms = null; this._p4TrainStarted = false; this._p4Flushed = false;
  }

  /**
   * The analogue modem's half (§9.6.2). As initiator it asks for a downstream no
   * faster than `maxBps` (on the ladder, and offered in the digital modem's Jd) and
   * sends S, S̄ and CP at once; as responder it waits for Rd's turn to R̄d.
   */
  _renegotiateAnalogue(maxBps) {
    if (!this._ready || this._retraining || this._reneg) return false;
    const offered = this._peerDownstreamRates && this._peerDownstreamRates.length ? this._peerDownstreamRates : legalRates();
    const rates = legalRates().filter((r) => r <= (maxBps || this._rate) + 1 && offered.some((o) => Math.abs(o - r) < 1));
    let cfg = null;
    if (this._route) {
      // What the DIL measured carries the new rate on its own constellations.
      const ch = DIL.choose(this._route, this._law || 'mu', this._maxPower || 0,
        (drn) => rates.some((r) => Math.abs(r - (drn + 20) * 8000 / 6) < 1));
      if (ch) { cfg = configFromCP(ch.data.drn, 0); this._renegSets = ch.data.constellations.map((l) => maskFromUcodes(l)); }
    }
    for (let i = rates.length - 1; i >= 0 && !cfg; i--) {
      try { cfg = makeConfig(rates[i], this.cfg.Sr); } catch (e) { try { cfg = makeConfig(rates[i]); } catch (e2) { cfg = null; } }
    }
    if (!cfg) return false;
    this._renegCfg = cfg;
    this._startRenegAnalogue(true);
    this._reneg.txStarted = true; this._reneg.sbarAt = this._rxSamples || 0;
    this.up.sendRenegV90();
    return true;
  }

  _startRenegAnalogue(initiating) {
    this.renegotiations = (this.renegotiations || 0) + 1;
    this._reneg = { initiating, txStarted: false, at: this._rxSamples || 0 };
    this._mpSeen = false; this._mpPrimeSeen = false;
    this.emit('renegotiate', { why: initiating ? 'asked' : 'far end' });
  }

  /** The digital modem's Rd in data: Phase 4 again, on CPt's mapping with data mode's shaping. */
  _beginRenegRx(pol) {
    if (!this._reneg) this._startRenegAnalogue(false);
    const cfg = this._renegCfg || this.cfg;
    const cpt = this._cpt;
    const C = cpt.intervalIndex.map((i, k) => buildConstellation(cpt.constellations[i] || cpt.constellations[0], this._arrived(k)));
    this.cfgT = trainingConfig(cpt.drn, cfg.Sr);
    this.coderT = new V90Coder(this.cfgT, C, { coefs: this.coefs, lookahead: this.lookahead });
    this._desT = new Array(23).fill(0);
    this._p4Bits = []; this._p4Scan = 0;
    this._rMags = this._rdMagsNow;
    this._p4Stage = 'r'; this._rPolarity = pol; this._rbarSeen = false;
    this._rxRn = true;
  }

  /** Ed has passed: B1d and data, at the rate this end's CP asked for. */
  _renegEnterData(startAbs) {
    this._rxRn = false; this._rMags = null;
    if (this._renegCfg) {
      this.cfg = this._renegCfg; this._renegCfg = null; this._rate = this.cfg.bitRate;
      if (this._renegSets) { this.constellationSet = this._renegSets; this._renegSets = null; }
      this._configureDownstream();
    }
    this.dataStart = startAbs;
    this._framesDone = 0;
    this._desSettle = 24;
    this.des.fill(0);
    this.coder.reset();
    this.uState = 'hunt'; this.uArmed = false; this.uMarks = 0;
    this._reneg = null;
    this.emit('renegotiated', { bps: this._rate, bpsUpstream: this._rateUp });
  }

  /** Both directions back in data: the renegotiation is over. */
  _renegDone() {
    const r = this._reneg;
    if (!r || !r.txDone || !this._upReady || !this._cpApplied) return;
    this._reneg = null;
    this.emit('renegotiated', { bps: this._rate, bpsUpstream: this._rateUp });
  }

  /**
   * The next MP, MP′ or Ed sequence, or false when §9.4.1.5's Ed has been sent.
   *
   * Each sequence is a whole number of data frames by construction — Table 16 fills
   * MP to one and §8.6.2 makes Ed exactly two — so a sequence boundary is always a
   * frame boundary and the encoder never straddles two.
   */
  _p4NextSequence() {
    const D = this.cfgT.D;
    // In a renegotiation MP′ waits for CP itself (§9.6.1.2.3): the cap is start-up's
    // way out of a lost sequence, and here §9.6.1's 5 s to E is (a retrain).
    const capped = !this._reneg && this._p4Reps >= P4_MP_MAX_REPS;
    if (this._p4Stage === 'mp' && this._p4Reps >= P4_SEQ_MIN_REPS &&
        (this._cpApplied || capped)) {
      this._p4Stage = 'mpprime'; this._p4Reps = 0;
    }
    if (this._p4Stage === 'mpprime' && this._p4Reps >= P4_SEQ_MIN_REPS &&
        (this._cpPrimeSeen || capped)) {
      this._p4Stage = 'ed'; this._p4Reps = 0;
    }
    if (this._p4Stage === 'ed') {
      if (this._p4Reps >= 1) return false;                 // §9.4.1.5 — one Ed, then B1d
      this._p4Reps++;
      this.txP4Bits = new Array(P4.ED_FRAMES * D).fill(P4.ED_BIT);   // §8.6.2
      return true;
    }
    this._p4Reps++;
    this.txP4Bits = this._buildMPBits(this._p4Stage === 'mpprime', D).slice();
    return true;
  }

  /**
   * One symbol of a Phase 4 signal that goes through §5.4's encoder, pulling another
   * six-symbol data frame from `next` whenever the last one is spent. The counter is
   * in SYMBOLS because every clause in §9.4 states its lengths in T.
   */
  _p4Frame(next) {
    if (!this.txP4Syms || !this.txP4Syms.length) {
      // §8.6.5's initialisation applies to TRN2d only, and TRN2d is the first thing
      // through this encoder, so it is done on the way in.
      if (!this._p4TrainStarted) {
        this._p4TrainStarted = true;
        this.scr3.fill(0);
        this.coderT.reset();
      }
      // The shaper's lookahead means the first lₐ frames produce no symbols; the
      // encoder is fed until it does, exactly as the data path does. Returning a
      // zero sample instead would insert a symbol and walk the frame grid.
      while (!this.txP4Syms || !this.txP4Syms.length) {
        const syms = this.coderT.encodeFrame(next());
        if (syms) this.txP4Syms = syms.slice();
      }
    }
    this._p4N++;
    return this.txP4Syms.shift();
  }

  /** §9.4.1.1 — Phase 4 begins where DIL (or J′d, when none was requested) ends. */
  _enterPhase4() {
    this.txStage = 'p4';
    // Phase 3's backlog is not Phase 4's: dropping it keeps the CP hunt off Ja and
    // SCR, which cannot contain a CP.
    if (this.up.p3) { this.up.p3.trimmed += this.up.p3.bits.length; this.up.p3.bits.length = 0; }
    this._p4Stage = 'ri';
    this._p4N = 0; this._p4Reps = 0; this.txP4Bits = null;
    this.txP4Syms = null; this._p4TrainStarted = false; this._p4Flushed = false;
  }

  /**
   * One downstream Phase 4 symbol, or null when Ed has ended the phase.
   *
   * §8.6.4's NOTE — "Neither R nor R̄ are differentially encoded. This imposes a
   * requirement on the receiver to be able to detect these sequences regardless of
   * their polarity" — is stated as an exception, which is what says the rest of the
   * sign-carried Phase 4 signals are differentially encoded, exactly as §8.4.2's Jd
   * is. MP, MP′ and Ed therefore ride the Jd chain and R and R̄i do not.
   *
   * The one divergence, stated rather than absorbed: §8.6.5 generates TRN2d through
   * "the encoder of 5.4" on the constellation CPt passed, and there is no separate
   * training constellation here — CPt carries the same set CP does. TRN2d is
   * therefore §8.4.5's form, scrambled ones on the sign of the U_INFO codeword,
   * which is what TRN1d already is. Its LENGTH and its place in the procedure are
   * the Recommendation's.
   */
  _p4Symbol() {
    const u = this._uInfo;
    // Every stage tests its own end BEFORE emitting, so the stage a symbol is
    // emitted under is the stage that symbol belongs to. The alternative — advance
    // after emitting — puts each signal's last symbol under the next signal's name,
    // which is invisible on the wire and wrong in anything that reads the machine.
    for (;;) switch (this._p4Stage) {
      // §9.4.1.1 — "transmit signal Ri for a minimum of 192T", until CPt. The end is
      // taken at a data frame boundary: every Phase 4 signal is a whole number of
      // six-symbol frames, or the downstream walks off the phase Sd established.
      case 'ri': {
        if (this._p4N >= RI_MIN_SYMBOLS && this._cptSeen && this._p4N % P4.R_PERIOD === 0) {
          this._p4Stage = 'rbari'; this._p4N = 0; continue;
        }
        return signedCodeword(u, P4.R_SIGNS[this._p4N++ % P4.R_PERIOD], this._txMag);
      }
      // §9.6.1.1.1 / §9.6.1.2.2 — "signal Rd for 384T and R̄d for 24T", Rd being
      // §8.6.4's R on "the highest power PCM codeword from the data mode
      // constellation of each data frame interval as passed in CP". TRN2d follows,
      // which §9.6 makes optional and BinModem's digital modem sends.
      case 'rd': {
        if (this._p4N >= RD_SYMBOLS) { this._p4Stage = 'rbard'; this._p4N = 0; continue; }
        const k = this._p4N++ % P4.R_PERIOD;
        return signedCodeword(this._rdCodes[k], P4.R_SIGNS[k], this._txMag);
      }
      case 'rbard': {
        if (this._p4N >= P4.RBAR_SYMBOLS) {
          if (this._reneg) this._reneg.rbardAt = this._rxSamples || 0;
          this._p4Stage = 'trn2d'; this._p4N = 0; continue;
        }
        const k = this._p4N++ % P4.R_PERIOD;
        return signedCodeword(this._rdCodes[k], P4.RBAR_SIGNS[k], this._txMag);
      }
      // §9.4.1.2 — "send signal R̄i for 24T", which is §8.6.4's four repetitions.
      case 'rbari': {
        if (this._p4N >= P4.RBAR_SYMBOLS) { this._p4Stage = 'trn2d'; this._p4N = 0; continue; }
        return signedCodeword(u, P4.RBAR_SIGNS[this._p4N++ % P4.R_PERIOD], this._txMag);
      }
      // §9.4.1.2 — "followed by TRN2d for a minimum of 2040T". §8.6.5: scrambled
      // binary ones through §5.4's encoder on the constellation set CPt passed, with
      // the scrambler, differential encoder and shaper memory initialized to zero
      // first. That is a real encoder run, not a sign on one codeword — which is what
      // makes the analogue modem's Phase 4 receiver a new path rather than a reuse.
      case 'trn2d': {
        if (this._p4N >= TRN2D_SYMBOLS) {
          this._p4Stage = 'mp'; this._p4N = 0; this._p4Reps = 0; this.txP4Bits = null;
          continue;
        }
        return this._p4Frame(() => {
          const n = this.cfgT.D, bits = new Array(n);
          for (let i = 0; i < n; i++) bits[i] = this._scramble3(P4.TRN2D_BIT);
          return bits;
        });
      }
      // §9.4.1.3 / §9.4.1.4 — MP until the analogue modem's CP, then MP′ until its
      // CP′, then §9.4.1.5's SINGLE Ed. Every one of those is a signal the far end
      // sends; the caps behind them are what makes a lost sequence degrade to a
      // connect rather than to a hang.
      case 'mp':
      case 'mpprime':
      case 'ed': {
        // Both cursors, not just the bits: a frame's bits are consumed six symbols
        // before those symbols are, so testing the bits alone drops the last frame of
        // Ed — and Ed is the signal the analogue modem ends Phase 4 on.
        const spent = (!this.txP4Syms || !this.txP4Syms.length) &&
                      (!this.txP4Bits || !this.txP4Bits.length);
        if (spent && !this._p4NextSequence()) {
          // Ed has gone into the encoder, but with a look-ahead its last lₐ frames
          // are still inside it, and Ed is two frames long. They go before B1d,
          // which starts the coding afresh (§8.6.1), as BinModem's digital modem
          // sends them: the shaper choosing over what is left.
          if (!this._p4Flushed) {
            this._p4Flushed = true;
            const rest = this.coderT.flush();
            if (rest.length) { this.txP4Syms = [].concat(...rest); continue; }
          }
          return null;
        }
        return this._p4Frame(() => {
          const n = this.cfgT.D, bits = new Array(n);
          for (let i = 0; i < n; i++) {
            // The shaper's lookahead pulls more than one frame on the way in, so the
            // refill is here rather than at the top of the case: a sequence that runs
            // out mid-frame would otherwise be padded with undefined.
            if (!this.txP4Bits.length && !this._p4NextSequence()) this.txP4Bits = new Array(n).fill(1);
            bits[i] = this._scramble3(this.txP4Bits.shift());
          }
          return bits;
        });
      }
      default: return null;
    }
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
    if (this._link) return this._scramble(this._link.nextBit());
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
    // §9.5.1.2 / §9.5.2.2: the far end's tone, held more than 50 ms, from data
    // mode. The analogue modem plays tone A's part in V.90 and the digital modem
    // tone B's (§9.2), so each watches for the other's.
    if (this._ready && !this._retraining) {
      if (!this._rtw) this._rtw = retrainWatch(this.isDigital ? P2V34.TONE_A_HZ : P2V34.TONE_B_HZ);
      for (let i = 0; i < f32.length; i++) {
        if (this._rtw(f32[i])) { this._retraining = true; this.emit('retrain', { why: 'far end' }); break; }
      }
      if (this._retraining) return;
    }
    if (this.isDigital) {
      this._rxSamples = (this._rxSamples || 0) + f32.length;
      // §9.6.1: no E "within 5000 ms plus 2 round-trip delays after transmitting
      // the R-to-R̄d transition" is a retrain (§9.5.1.1).
      const r = this._reneg;
      if (r && r.rbardAt != null && this._rxSamples - r.rbardAt > RENEG_E_SAMPLES) {
        this._reneg = null; this.retrain();
        return;
      }
      this.up.receiveAudio(f32);
      this._huntJa();          // §9.3.1.3 — Ja arrives as Phase 3 signal, not as data
      this._huntCP();          // §9.4.2   — and CP as a Phase 4 one
      return;
    }

    // §9.2.2 — during Phase 2 the digital modem is sending tone B, INFO0d and the
    // probing signals, which are analogue signals and not codewords. They belong to
    // the V.34 instance's Phase 2 receiver; handing them to the downstream decoder
    // would have it hunt Sd in a tone. The gate is this modem's OWN Phase 2 ending,
    // which is the moment it has sent INFO1a — after which the digital modem sends
    // silence until Sd, so nothing is lost in the gap between the two ends settling.
    if (this.up.phase2Active) { this.up.receiveAudio(f32); return; }

    // §9.6.2: no Ed "within 5000 ms plus 2 round-trip delays after sending the
    // S-to-S̄ transition" is a retrain (§9.5.2.1).
    this._rxSamples = (this._rxSamples || 0) + f32.length;
    const rn = this._reneg;
    if (rn && rn.sbarAt != null && this._rxSamples - rn.sbarAt > RENEG_E_SAMPLES) {
      this._reneg = null; this._rxRn = false; this._renegCfg = null; this._renegSets = null;
      this.retrain();
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
    const W = MAG[this._sdW];
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
            if (!this._sbarDSeen && sdMatches(v, MAG[this._sdW], true)) this._sbarDSeen = true;
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
        if (this._p3Stage !== 'dil' && this._p3Stage !== 'p4') {
          this._p3Downstream(v); this._sdGroups++; continue;
        }

        // §9.3.2.9 — the DIL this modem asked for. It knows every symbol of it,
        // because it wrote the descriptor; the first group that does not match is
        // the digital modem having completed its current segment and moved on
        // (§9.3.1.6). That is a discriminator built from its own request rather
        // than from a length both ends agree on.
        if (this._dilRead(v)) { this._dilSymsSeen += SYMS_PER_FRAME; this._sdGroups++; continue; }

        // §9.4.1 — Phase 4 begins where DIL stops. Everything in it is a sign on the
        // U_INFO codeword, so it is read frame by frame here rather than by handing
        // the groups to the data decoder, which has no idea what they are yet.
        if (this._p3Stage !== 'p4') { this._p3Stage = 'p4'; this._p4Stage = 'r'; }
        if (!this._p4Downstream(v)) { this._sdGroups++; continue; }

        this.dataStart = startAbs;
        this._framesDone = 0;
        // §8.6.1's B1d — 48 data frames of scrambled ones — is what the UART's run
        // of idle marks now is, so it needs no counting. What does need dropping is
        // the descrambler's own settling: it is self-synchronising, so its first 23
        // bits are garbage, and reading them is one spurious byte at the head of
        // every session. That is what the byte channel's DLE 'D' mark stood in for.
        this._desSettle = 24;
        this.des.fill(0);
        this.coder.reset();
        this.uState = 'hunt'; this.uArmed = false; this.uMarks = 0;
        this._maybeReady();
        continue;
      }

      // §9.6.2: in data mode the digital modem's Rd is a rate renegotiation, its
      // own (§9.6.2.2.1) or the answer to this end's S̄ (§9.6.2.1.4). Its frames, and
      // Phase 4's after them, are read as start-up's are; B1d begins data again.
      if (this._ready) {
        if (!this._rxRn) {
          const pol = this._rdMagsNow && rPolarityOf(v, this._rdMagsNow);
          if (pol != null) this._beginRenegRx(pol);
        }
        if (this._rxRn) {
          if (!this._p4Downstream(v)) { this._framesDone++; continue; }
          this._renegEnterData(startAbs);
          continue;
        }
      }
      const bits = this.coder.decodeFrame(v);
      this._framesDone++;
      for (const bit of bits) {
        const r = this.des;
        const ob = bit ^ r[this._rxTap] ^ r[22];
        r.unshift(bit); r.pop();
        if (this._desSettle > 0) this._desSettle--;
        else this.outbits.push(ob);
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
   * One six-symbol group of the digital modem's Phase 4. Returns true when this
   * group is the first DATA frame — that is, when Ed has ended §9.4.1.
   *
   * §8.6.4's NOTE is the whole design of the R stage: R̄ inverts R at every
   * position, so a receiver keyed on the absolute sign finds the R-to-R̄i transition
   * at one polarity and misses it at the other. What is tracked is the POLARITY of
   * the period-6 pattern, and the transition is a change in it.
   */
  _p4Downstream(v) {
    if (this._p4Stage === 'r') {
      const pol = rPolarityOf(v, this._rMags || this._riMags || MAG[this._uInfo]);
      if (pol !== null) {
        if (this._rPolarity === null) this._rPolarity = pol;
        else if (pol !== this._rPolarity) {
          this._rPolarity = pol; this._rbarSeen = true;
          // §9.6.2.2.2: on the Rd-to-R̄d transition, S, S̄ and CP.
          const r = this._reneg;
          if (r && !r.txStarted) { r.txStarted = true; r.sbarAt = this._rxSamples || 0; this.up.sendRenegV90(); }
        }
        return false;
      }
      // The first group that is not R is TRN2d's first data frame.
      this._p4Stage = 'mp';
      this._p4Bits.length = 0;
      this._p4Scan = 0;
      this.coderT.reset();
      this._desT.fill(0);
    }

    // §§8.6.2, 8.6.3 and 8.6.5 — TRN2d, MP, MP′ and Ed are all §5.4 encoder output on
    // CPt's constellation, so they are DECODED here, on training parameters, before
    // this modem knows anything about data mode. TRN2d's descrambled ones cannot
    // satisfy sixteen CRC bits, which is what finds MP inside it without counting.
    const bits = this.coderT.decodeFrame(v);
    if (!bits) return false;
    for (const bit of bits) {
      const r = this._desT;
      const ob = bit ^ r[this._rxTap] ^ r[22];
      r.unshift(bit); r.pop();
      this._p4Bits.push(ob);
    }
    if (this._p4Bits.length > 8192) {
      const drop = this._p4Bits.length - 8192;
      this._p4Bits.splice(0, drop);
      this._p4Scan = Math.max(0, this._p4Scan - drop);
    }

    if (!this._mpPrimeSeen) { this._huntMP(); return false; }

    // From MP′ on, the stream is a run of whole sequences and `_huntMP` has left the
    // buffer on a sequence boundary, so what follows is READ rather than searched
    // for. It has to be: Table 16's bits 52:67 are sixteen reserved zeroes, so a
    // trailing-zero window finds an "Ed" inside every MP that is sent.
    const b = this._p4Bits;
    const D = this.cfgT.D;
    const N = P4.mpLength(D), E = P4.ED_FRAMES * D;
    const isEd = () => b.length >= E && b.slice(0, E).every((x) => x === 0);
    for (;;) {                                   // further MP′ repetitions
      if (b.length < N) break;
      const mp = P4.parseMP(b.slice(0, N));
      if (!mp.sync || !mp.crcOk) break;
      b.splice(0, N);
    }
    // §9.4.1.5 — a single Ed, and B1d begins on the very next data frame.
    if (this._p4Stage !== 'ed') {
      if (isEd()) { this._p4Stage = 'ed'; b.splice(0, E); }
      return false;
    }
    while (isEd()) b.splice(0, E);
    return b.length > 0;
  }

  /** §9.4.1.3's MP, out of the training-constellation bit stream. */
  _huntMP() {
    const b = this._p4Bits;
    const N = P4.mpLength(this.cfgT.D);
    // The CRC is computed in place; only the sequence that passes it is ever copied
    // out. TRN2d descrambles to constant ones and every position in it opens a
    // valid-looking frame sync, so a hunt that parsed each candidate would run a
    // full CRC at every bit of a 2040-symbol signal.
    const hit = P4.findSequence(b, this._p4Scan, N, P4.CP_SYNC_BITS,
      (at) => P4.mpCrc(b, at) === BF.getUInt(b, at + P4.MP_CRC_START + 1, at + P4.MP_CRC_START + 16));
    this._p4Scan = hit.scanned;
    if (hit.at < 0) return;
    const bits = b.slice(hit.at, hit.at + N);
    const mp = P4.parseMP(bits);
    this._applyMP(bits);
    if (mp.ack) this._mpPrimeSeen = true;
    b.splice(0, hit.at + N);
    this._p4Scan = 0;
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
        this._dilSent = [];
        for (const seg of P3.dilSegments(this._dil)) for (const x of seg.syms) this._dilSent.push(x);
        this._dilAn = new DIL.Analysis(); this._dilFed = new Uint8Array(this._dilSent.length); this._dilFedN = 0;
        this._dilCand = null; this._dilChosen = false;
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
  /**
   * §9.3.2.9 — one group of the DIL this modem asked for, found and read into the
   * analysis. The route may move every level (a pad, the other law, a robbed bit),
   * so the group is placed by its SIGNS, which survive all of those, and by a gain
   * common to the whole probe; every position this modem wrote is a candidate
   * until the groups leave one. Each symbol read is fed, as sent and as received,
   * to the analysis, and once every position has been read the constellations are
   * chosen from it (_applyDil). A group that no longer fits is the DIL's end.
   */
  _dilRead(v) {
    const exp = this._dilSent;
    if (!exp || !exp.length) return false;
    const L = exp.length;
    // A place's fit for this group: null if a sign disagrees or a level stands far
    // above what was asked for there, else the log gain over the codewords loud
    // enough to read (and how many), which a pad shifts and nothing else moves much.
    // What each codeword was sent as, in the law the digital modem named (INFO0d).
    const law = this._law || 'mu';
    const sentMag = (u) => DIL.linear(law, u) / 4;
    const fit = (p, ceiling) => {
      let lr = 0, n = 0;
      for (let k = 0; k < SYMS_PER_FRAME; k++) {
        const e = exp[(p + k) % L], x = v[k], em = sentMag(e.ucode);
        if (Math.abs(x) > ceiling * Math.max(em, 48) + 32) return null;
        if (em < 48) continue;                         // too quiet for its sign or a ratio
        if ((x > 0 ? 1 : -1) !== e.sign) return null;
        lr += Math.log(Math.max(1, Math.abs(x)) / em); n++;
      }
      return { g: n ? lr / n : 0, n };
    };
    if (this._dilPos === null) {
      if (!this._dilCand) { this._dilCand = new Map(); for (let p = 0; p < L; p += SYMS_PER_FRAME) this._dilCand.set(p, { gs: [], groups: 0 }); }
      const next = new Map();
      for (const [p, c] of this._dilCand) {
        const f = fit(p, 2.6);
        if (!f) continue;
        const gs = f.n ? [...c.gs, f.g] : c.gs;
        const m = gs.length ? gs.reduce((t, x) => t + x, 0) / gs.length : 0;
        if (gs.some((x) => Math.abs(x - m) > 0.25)) continue;
        next.set((p + SYMS_PER_FRAME) % L, { gs, groups: c.groups + 1 });
      }
      this._dilCand = next.size ? next : null;
      if (!next.size) return false;
      // Segments share their signs and neighbours' codewords are a few per cent
      // apart, so more than one place fits for a while. Two segments' groups in, the
      // place whose gain held steadiest over the most readable groups is the one.
      const groups = next.values().next().value.groups;
      if (next.size > 1 && groups < 2 * (DIL.H + 1)) return true;
      let best = null, bestScore = Infinity;
      for (const [q, c] of next) {
        if (c.gs.length < 4 && next.size > 1) continue;
        const m = c.gs.reduce((t, x) => t + x, 0) / (c.gs.length || 1);
        const score = c.gs.reduce((t, x) => t + (x - m) ** 2, 0) / (c.gs.length || 1);
        if (score < bestScore) { bestScore = score; best = q; }
      }
      if (best === null) return true;                 // nothing readable yet: listen on
      const c = next.get(best);
      this._dilGain = c.gs.length ? c.gs.reduce((t, x) => t + x, 0) / c.gs.length : 0;
      this._dilPos = best;
      this._dilCand = null;
      return true;
    }
    const p = this._dilPos;
    // The DIL ends where a group stops fitting: its signs, its gain, or, in a quiet
    // segment with no sign worth reading, a level far above what was asked for.
    const f = fit(p, 2 * Math.exp(this._dilGain));
    if (!f || (f.n && Math.abs(f.g - this._dilGain) > 0.3)) return false;
    for (let k = 0; k < SYMS_PER_FRAME; k++) {
      const e = exp[(p + k) % L];
      this._dilAn.feed(e.ucode, e.sign > 0, k, v[k] * PCM_TO_LEVEL);
      if (!this._dilFed[(p + k) % L]) { this._dilFed[(p + k) % L] = 1; this._dilFedN++; }
    }
    this._dilPos = (p + SYMS_PER_FRAME) % L;
    if (!this._dilChosen && this._dilFedN >= L) this._applyDil();
    return true;
  }

  /**
   * The route, and what it carries: V90Dil's choice of data and training
   * constellations inside the far end's power limit, at a rate its Jd offers and
   * this end is configured to take. The receiver slices against the levels the DIL
   * measured from here on.
   */
  _applyDil() {
    this._dilChosen = true;
    const route = this._dilAn.route();
    const offered = this._peerDownstreamRates && this._peerDownstreamRates.length ? this._peerDownstreamRates : legalRates();
    const top = this._configuredDown || (this._configuredDown = this.cfg.bitRate);
    const enabled = (drn) => {
      const r = (drn + 20) * 8000 / 6;
      return r <= top + 1 && offered.some((o) => Math.abs(o - r) < 1);
    };
    const ch = DIL.choose(route, this._law || 'mu', this._maxPower || 0, enabled);
    if (!ch) return;                                  // nothing better known: as configured
    this._route = route;
    this.cfg = configFromCP(ch.data.drn, 0);
    this._rate = this.cfg.bitRate;
    this.constellationSet = ch.data.constellations.map((l) => maskFromUcodes(l));
    this.intervalIndex = ch.data.intervalIndex.slice();
    this._trainChoice = {
      drn: ch.training.drn,
      constellations: ch.training.constellations.map((l) => maskFromUcodes(l)),
      intervalIndex: ch.training.intervalIndex.slice(),
    };
    this._riMags = Array.from({ length: SYMS_PER_FRAME }, (_, k) => route.levels[k][this._uInfo] / PCM_TO_LEVEL);
    this._configureDownstream();
    this._configureTraining(P4.parseCP(this._buildCPBits(true), this._trainChoice.constellations.length));
  }

  /** The levels interval k's codewords arrive at, in received-sample units, once the DIL has said. */
  _arrived(k) {
    const r = this._route;
    return r && !this.isDigital ? Float64Array.from(r.levels[k], (x) => x / PCM_TO_LEVEL) : null;
  }

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
    this._p4Stage = null; this._rPolarity = null; this._rbarSeen = false;
    this._mpPrimeSeen = false; this._desSettle = 0; this._cpPrimeSeen = false;
    if (this._p4Bits) this._p4Bits.length = 0;
    this._p4Scan = 0;
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
  /** §9.3.1.5's Jd rate list: every ladder rate up to this end's configured one. */
  _jdRates() {
    return legalRates().filter((r) => r <= this._rate + 1);
  }

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
    if (this._link) { while (this.outbits.length) this._link.feedBit(this.outbits.shift()); return; }
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

  /**
   * A byte arriving from the digital modem over the downstream PCM channel.
   *
   * There is no control channel left in front of it: §9.4.1 puts MP on the sign of
   * the PCM codeword and ends Phase 4 at Ed, so by the time a byte can be framed at
   * all the link is in data mode.
   */
  _downstreamByte(b) { this.emit('data', Buffer.from([b])); }
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
function signedCodeword(ucode, sign, mag = MAG) {
  return sign ? mag[ucode] : -mag[ucode];
}

/** One Sd repetition: {+W,+0,+W,−W,−0,−W}, or its sign inverse. */
function sdRepetition(inverted, wUcode, mag = MAG) {
  const W = mag[wUcode === undefined ? SD_W_UCODE : wUcode];
  const p = [W, 0, W, -W, 0, -W];
  return inverted ? p.map(v => -v) : p;
}
function sdMatches(v, W, inverted) {
  const sgn = inverted ? -1 : 1;
  // W as it ARRIVED: a digital pad scales every level and a gateway between the
  // laws moves it to the other law's nearest codeword, so the pattern is matched
  // against its own first symbol, anywhere from 14 dB down to 2 dB up on W as
  // sent. The zeros stay zeros under both: Ucode 0 is the least level of both laws.
  const w = sgn * v[0];
  if (!(w > W * 0.2 && w < W * 1.26)) return false;
  const near = (a, b) => Math.abs(a - b) <= Math.max(w * 0.15, 32);
  return Math.abs(v[1]) <= SD_ZERO_TOL && near(v[2], sgn * w) &&
         near(v[3], -sgn * w) && Math.abs(v[4]) <= SD_ZERO_TOL && near(v[5], -sgn * w);
}
/**
 * §8.6.4's R (or R̄) as a polarity, or null if this group is neither.
 *
 * Every symbol is the same codeword and only the signs move, in the period-6
 * pattern + + + − − −; polarity 1 is that pattern and polarity 0 its inverse, which
 * is R̄. Returning the polarity rather than "is this R" is what the clause's NOTE
 * requires of the receiver.
 */
function rPolarityOf(v, mags) {
  const magOf = (k) => (typeof mags === 'number' ? mags : mags[k]);
  const near = (a, b, mag) => Math.abs(a - b) <= Math.max(mag * 0.15, 32);
  let ok = true, inv = true;
  for (let k = 0; k < SYMS_PER_FRAME; k++) {
    const mag = magOf(k);
    const want = P4.R_SIGNS[k] ? mag : -mag;
    if (!near(v[k], want, mag)) ok = false;
    if (!near(v[k], -want, mag)) inv = false;
  }
  return ok ? 1 : inv ? 0 : null;
}

/** Sd repetitions carry the zero symbol at intervals 1 and 4; data frames cannot. */
function isSdGroup(v) { return Math.abs(v[1]) <= SD_ZERO_TOL && Math.abs(v[4]) <= SD_ZERO_TOL; }

V90.prototype._sdGroups = 0;
V90.prototype._framesDone = 0;
V90.prototype.huntPos = 0;

module.exports = { V90 };
