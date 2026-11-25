'use strict';

/*!
 * @license
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Copyright (C) 2026 Joseph Quinn
 *
 * The measure of unsatisfactory reception and the rates a retrain then offers
 * (`_unsatisfactory`) are ported from BinModem
 * <https://github.com/CasualArclamp/BinModem>, crates/datapump/src/v32/startup.rs
 * (`UNSATISFACTORY_GAP`, `stop_offering`), at commit
 * 623f935e28fe6de3a8a4f41492feb46e1bb86c3a of <https://github.com/synexo/BinModem>.
 * Copyright the BinModem authors; GPL-3.0-or-later. See NOTICE.
 */

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
 *     4 data bits/symbol = 9600 bps (ITU-T V.32 §5, non-redundant coding); and
 *     the trellis 9600 and 4800 modes below.
 *   - The two most-significant bits Q1,Q2 of each 4-bit group are DIFFERENTIALLY
 *     encoded into Y1,Y2 (quadrant) by **Table 1/V.32**, whose title names this
 *     exact mode — "for 4800 bit/s and for nonredundant coding at 9600 bit/s" —
 *     so the rate signals and the data carry the same differential coding. Note it
 *     is NOT a modulo-4 addition of the dibit: its phase quadrant change column is
 *     +90°, 0°, +180°, +270° for 00, 01, 10, 11, which transposes the first two.
 *     Q3,Q4 select the point within the quadrant (absolute), by **Table 3/V.32**'s
 *     non-redundant column. The 16 points sit on the {±1,±3}² grid (Figure 1), so
 *     a whole-constellation rotation by any multiple of 90° cancels in the
 *     differential decoder (rotational invariance).
 *   - The real, role-asymmetric self-synchronising V.32 scramblers (§7):
 *       Call-mode (originate)  GPC = 1 + x^-18 + x^-23
 *       Answer-mode            GPA = 1 + x^-5  + x^-23
 *     Each end scrambles its transmit with its OWN generating polynomial and
 *     descrambles the peer's receive with the PEER's polynomial.
 *   - 2400 baud at 8 kHz => 3.333 samples/symbol, handled by continuous
 *     root-raised-cosine synthesis + fractional matched filtering (rolloff 0.25),
 *     the same fractional-SPS machinery proven in V.29.
 *   - The Recommendation's own start-up, §§5.2–5.4: the receiver conditioning
 *     signal's three segments (S for 256T, S̄ for 16T, TRN for 1280T) and the
 *     R1/R2/R3 rate-signal exchange with the sequence E that ends it, all at the
 *     A/B/C/D states of Figure 1/V.32 with the rate signals differentially encoded
 *     by Table 1/V.32. The signals live in V32Startup.js; §5.4's procedure — who
 *     transmits what, and which SIGNAL each end waits for before it does — is the
 *     connect script and the start-up receiver below.
 *
 * ── What is deliberately "genuine minimal" (documented, not hidden) ─────────
 *   - Three modes. 9600 non-redundant, the one 1 e) makes mandatory and the
 *     default. 9600 trellis-coded (§2.4.1.2) after setTrellis(true), used only
 *     when the far end also sets Table 6's B8: its differential table, encoder,
 *     32-point Figure 3 and Viterbi decoder are V.32bis's 9600, from V32bis.js.
 *     And 4800 (§2.4.2) on Figure 1's four states; setMaxRate(4800) forces it.
 *     The receiver codes at what the far end's E names.
 *   - An adaptive equalizer (SymbolEqualizer.js, T/2, ±EQ_L symbols), and the
 *     receiver TRACKS. Symbol timing, carrier
 *     phase and gain are acquired on signal S, which is what §5.2.2 says that
 *     segment boundary is for, and then followed: Gardner timing and a
 *     decision-directed phase loop through start-up, a complex-gain LMS in data,
 *     each second-order so a far clock ±100 ppm off (§2's 0.01%) leaves no
 *     standing error (TRK_* below). Tested against BinModem at 0 and ±100 ppm
 *     through the bridge's resampler (tools/tests/bm-v32.js), not yet against
 *     hardware. The equaliser trains in start-up on ideal states (A turned by
 *     quarter turns) and runs decision-directed in data; bm-v32 holds a line with
 *     12 dB of tilt and 2 ms of edge delay, where without it the text was garbage.
 *   - §5.4's half-duplex opening IS implemented (V32Preface.js): AA/CC and AC/CA,
 *     the 600/1800/3000 Hz tone detections, both phase reversals answered 64 ± 2 T
 *     later, the amplitude drop, and the NT/MT counts, with the call modem's S for
 *     NT ahead of its conditioning signal. It was omitted as "echo-canceller only"
 *     until BinModem showed a real answer modem will not leave AC without it. The
 *     echo canceller (EchoCanceller.js) runs on every call, as a real modem's does:
 *     on this 4-wire transport it finds no echo and is undone; in 2-wire mode
 *     (TwoWire.js) it cancels the echo that line returns.
 *
 * Interface (matches the other protocol classes so HandshakeEngine can drive it):
 * constructor(role); generateAudio(n)->Float32Array; receiveAudio(f32);
 * write(buf); emits 'data' (Buffer) and 'ready' ({bps, remoteDetected});
 * getters bps and carrierDetected.
 */

const { TONE_AMP, LINE_RMS, rmsAt } = require('../LineLevel');
const { EventEmitter } = require('events');
// §§5.2–5.3's signals: S, S̄, TRN, Table 1's differential coding, and the 16-bit
// rate sequences of Table 6/V.32 and the E of Table 7/V.32. Shared with V32bis.js,
// whose §5.2 and §5.2.3 are word for word the same clauses.
const V32S = require('./V32Startup');
// §5.4's half-duplex opening — AA/CC, AC/CA and their reversals. Shared with V32bis.js.
const V32P = require('./V32Preface');
const { EchoCanceller } = require('../EchoCanceller');
const { SymbolEqualizer } = require('../SymbolEqualizer');
// §2.4.1.2's trellis coding is V.32bis's 9600 exactly: Table 2/V.32 is Table
// 1/V.32bis, Figure 2/V.32's encoder is Figure 1/V.32bis's, and Figure 3/V.32 is
// Figure 2-3/V.32bis. So the code and its decoder come from there, unscaled: Figure
// 3's mean energy is Figure 1's, 10.
const { CODED, TAB1, convEncode, V32bisViterbi } = require('./V32bis');
const TCM_9600 = { bits: 4, pts: CODED[9600].figure };

const SR = 8000, BAUD = 2400, FC = 1800, SPS = SR / BAUD; // 3.333…
const ROLLOFF = 0.25, SPAN = 10;

// ── V.32 non-redundant 16-QAM constellation (Figure 1/Table 3) ───────────────
// Points on the {±1,±3}² grid. Y1Y2 (quadrant, differentially encoded) chooses
// the quadrant by rotating the quadrant-I base point by Y*90° CCW; Q3Q4 (point
// within quadrant, absolute) chooses the base point. Table 3's labels are
// rotationally consistent — rotating a quadrant-I point by 90° lands on the same
// Q3Q4 in the next quadrant — which is what makes one base row plus a rotation
// the whole of the map, rather than the 16-entry lookup V.32bis needs.
//
// These are Table 3/V.32's four quadrant-I rows in the order the table prints
// them, indexed (Q3<<1)|Q4:
//   1100 -> ( 1, 1)   1101 -> ( 3, 1)   1110 -> ( 1, 3)   1111 -> ( 3, 3)
// Entries 01 and 10 were the other way round until this was checked against the
// table: an error that round-trips perfectly, because the receiver inverted it.
const BASE = [ { i: 1, q: 1 }, { i: 3, q: 1 }, { i: 1, q: 3 }, { i: 3, q: 3 } ];
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

/**
 * Table 3/V.32's non-redundant map, both directions, in one place.
 *
 * They are a pair on purpose. Divergence B below lived in BOTH of them — the
 * transmitter's base index and the receiver's bit extraction — which is exactly
 * how a wrong constellation map round-trips for years without a test noticing.
 * One definition and its stated inverse is what makes that impossible to have in
 * only one direction. tools/tests/v32-map-check.js drives these, not a copy.
 *
 * `rot` is the quadrant as CCW quarter-turns from quadrant I, which is what the
 * differential coding accumulates.
 */
function dataPoint(rot, Q3, Q4) {
  const b = BASE[(Q3 << 1) | Q4];
  return rotCCW(b.i, b.q, rot);
}
function dataBits(i, q) {
  const rot = quadOf(i, q);
  const b = rotCW(i, q, rot);                 // back to quadrant I
  return { rot, Q3: Math.abs(b.q) === 3 ? 1 : 0, Q4: Math.abs(b.i) === 3 ? 1 : 0 };
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

// Amplitude of the transmitted passband (grid coords up to 3, |point| up to
// 3√2). Chosen so burst RMS ≈ 0.1 (matches the other protocols / the RX squelch).
// −10 dBm0 (LineLevel.js). 0.09 put the data on the line at −7.7, 2 dB over the
// usual −9 ceiling, and is rescaled by that measurement.
const TX_GAIN = 0.09 * LINE_RMS / rmsAt(-7.7);

const UART_ARM_MARKS = 8;   // idle-mark run required before honouring a start bit

// ── RX carrier squelch (raw-sample |x| EWMA; carrier RMS ~0.1, gaps == exact 0).
// Gates the answer modem's §5.4.2 cease-and-resume, which is the one real silence
// in the start-up, and detects hangup; the continuous carrier keeps rxOn latched.
// ON above −43 dBm0 and OFF below −48, V.32's circuit 109 thresholds as V.21's:
// mean |x| is about 0.8 of a QAM signal's RMS, and full scale is +3.17 dBm0. They
// were 0.015 and 0.006 (−29 and −37), and a far end after 20 dB of loss, at −30,
// was never heard at all.
const RX_A = 0.02, RX_HI = 0.0028, RX_LO = 0.00157, RX_HANG = 48;
// S's onset in the hunt: the baseband magnitude against the level being received,
// half of it, which is what the absolute 0.04 was at our own level.
const ONSET_FRAC = 0.5;

// ── §§5.2–5.4 start-up constants ────────────────────────────────────────────
// §5.2.3: "The duration of segment 3 shall be at least 1280 and not exceed 8192
// symbol intervals." The minimum is the legal choice taken here, per the backlog's
// rule that a shorter start-up comes from the knobs the Recommendation provides
// rather than by omission. It is 0.53 s at 2400 baud and is most of what the
// start-up now costs.
const TRN_SYMBOLS = V32S.TRN_MIN_SYMBOLS;

// §5.3.1 needs "two consecutive identical 16-bit sequences" to detect a rate
// signal, and the receiver reaches them through a descrambler that is only
// converging while TRN's dibits are still being differentially decoded as though
// they were a rate signal — 23 bits, so about a sequence and a half. Six is that
// with margin, and a rate signal repeats until the peer answers anyway.
const RATE_MIN_REPEATS = 6;

// §5.4.1: "After a delay of 128 symbol intervals, it shall apply an ON condition
// to circuit 109, and unclamp circuit 104", and §5.4.2's answer modem "shall
// transmit scrambled binary ones for 128 symbol intervals" before it is ready to
// transmit data. One constant, both ends.
const E_TO_DATA_SYMBOLS = 128;

// How many symbols of unbroken alternation the receiver requires before it will
// call an S or an S̄. S̄ is only 16T, so the confirmation has to fit inside it with
// margin; 12 does, and is long enough that TRN — whose states are scrambled —
// reaches it with probability 2^-11 per position.
const RUN_CONFIRM = 12;

// A gate here waits on a SIGNAL, not on a sample count, which is what retires
// ORIG_LEAD (a 0.60 s originate-side silence with no basis in the Recommendation).
// This is the fallback if the expected signal never comes. NOTE the DIVERGENCE,
// deliberate and stated rather than hidden: §5.4's recourse is to keep waiting and
// eventually clear the connection, and there is no cleardown state machine here.
// On expiry this modem proceeds anyway, because proceeding degrades to a call that
// trains against a peer that is not following the procedure, where hanging does
// not.
const GATE_TIMEOUT = Math.round(6.0 * SR);

// ── Audible startup (V.25 answer tone) ──────────────────────────────────────
const ANS_TONE_FREQ    = 2100;
const ANS_TONE_AMP     = TONE_AMP;           // −10 dBm0 (LineLevel.js)
const ANS_TONE_SAMPLES = Math.round(1.0 * SR);   // ~1.0 s answer tone (answerer)
// V.25 §2.2: 75 ± 20 ms of silence ends the answer sequence. §5.4.2's AC follows it.
const ANS_SILENCE      = Math.round(0.075 * SR);
// §5.4.2: after the amplitude drop, "cease transmitting for a period of 16 symbol
// intervals and then ... transmit the receiver conditioning signal".
const PREFACE_GAP      = Math.ceil(16 * SPS);

// §5.2's states are Figure 1/V.32's own points, which is the same signal space the
// data constellation is drawn from — both have mean symbol energy 10 — so a V.32
// modem needs no scaling between the two. V.32bis does; see V32Startup.gainFor.
const SU_GAIN = V32S.gainFor(10);
const STATE_R = Math.sqrt(V32S.STATE_MEAN_E) * SU_GAIN;   // the four states' radius, data units

// The echo canceller's window, and the receiver's around it (EchoCanceller.js).
// This end's FIRST conditioning signal goes out while the far end is required to
// be silent (§5.4.2 note 3: its TRN "is suitable for training the echo canceller
// in the transmitting modem"). The canceller adapts on its TRN only, not on S and
// S̄, which repeat every two symbols, and a filter learned from a periodic
// reference is one of many that explain the period. The receiver idles through
// the whole sequence and EC_GUARD samples after it: on a 2-wire line, all it hears
// then is our own echo, and a start-up receiver that hunts S there finds ours.
const EC_GUARD = 160;

// The receive equaliser (SymbolEqualizer.js): ±EQ_L symbols at T/2, which at 2400
// baud is ±3.3 ms, more than a line's group-delay spread. It trains on every
// start-up symbol within EQ_GATE of one of S's four states and runs
// decision-directed in data at a tenth of the step. The gate is wide because the
// four states are a quarter turn apart: at 0.15, 12 dB of tilt and 2 ms of delay
// put TRN's first symbols outside it, and an equaliser that never starts never
// gets better. On a flat line it stays the identity it starts as.
const EQ_L = 8;
const EQ_MU_TRAIN = 0.03;
const EQ_MU_DATA = 0.003;
const EQ_GATE = 0.5;
// The data-mode step's gear: ×1 at or under EQ_GEAR_FROM of the constellation's
// spacing, rising with the error to ×EQ_GEAR_MAX.
const EQ_GEAR_FROM = 0.07;
const EQ_GEAR_MAX = 4;
const EQ_GEAR_TRN = 3;               // training's ceiling: its step is ten times data's          // train only where |error|² < this × |state|²

// Tracking. The far modem's clock is its own: ±100 ppm moves the symbol instant
// a third of a sample per thousand symbols and turns the carrier 0.18 Hz, which
// is 40° across the conditioning signal alone. Timing is Gardner's detector on
// the matched-filter output and the half-symbol point between — it needs no
// decisions, so the same loop runs through start-up and data. Carrier phase is
// decision-directed against S's four states in start-up, and the complex channel
// gain is an LMS against the sliced point in data. All first-order: the error
// they leave at 100 ppm is under 0.05 sample and 2°.
// Timing is second-order too, for the same reason, and its proportional step is
// small: Gardner's detector has pattern jitter on a dense constellation, and at
// 0.04 it cost V.32bis 4 dB at 0 ppm. The integrator carries the drift instead.
const TRK_TIMING = 0.005;        // samples per unit of normalised Gardner error
const TRK_TFREQ = 2e-5;          // of the same, into the drift per symbol
const TRK_PHASE = 0.03;          // of the start-up phase error, per symbol
const TRK_GAIN = 0.02;           // complex-gain LMS step in data mode
// The far carrier is OFF frequency by the same ppm, a steady 4.7·10⁻⁴ rad a
// symbol at 100 ppm, and a first-order loop answers a ramp with a standing lag —
// 0.024 rad, a fifth of a grid step on V.32bis's outer points. So each phase loop
// is second-order: an integrator learns the turn per symbol and applies it ahead
// of the error. Started in start-up and carried into data.
const TRK_FREQ = 3e-4;           // of the phase error, into the turn per symbol

// The data path tracks its differential state as a QUADRANT index (quadOf below),
// and the start-up tracks a rotation index. This is the join between them, used
// once, where E hands over to data.
const QUAD_OF_ROT = [2, 3, 0, 1];   // A(−3,−1) B(1,−3) C(3,1) D(−1,3)

// §5.4: the rates this build can run, Table 6/V.32's B5 and B6. B4's 2400 has no
// modulation in V.32 and is never claimed. B8, trellis at 9600, is claimed only
// after setTrellis(true): the uncoded mode is the one 1 e) makes mandatory.
const RATE_SET = [4800, 9600];
const TRELLIS_BIT = 8;
// Symbols of the far end's retrain signal before the UART stops taking bits. The
// decoder's output runs ~14 T behind the line (more with the Viterbi's 24), so 16
// stops it before the first symbol of the tones is decoded.
const RETRAIN_MUTE = 16;
// §5.5's "unsatisfactory signal reception", which it leaves to the implementation:
// BinModem's measure, ported. The mean distance of each symbol from its decision
// (a one-pole over ~UNSAT_AVG symbols) above UNSAT_GAP of the constellation's
// closest spacing, without a break for UNSAT_HOLD symbols (a second). There the
// decisions driving the equaliser are as likely wrong as right.
const UNSAT_AVG = 100;
// A retrain that has not reached data in this long is begun again. The far end's S
// lost to the noise that caused the retrain leaves nothing to acquire from, and a
// gate timed out instead offers no rates, which Table 6 reads as a cleardown. One
// against BinModem takes 2.4 s; this is under GATE_TIMEOUT so it comes first.
const RETRAIN_PATIENCE = 5.0;
// Rate-signal groups in a row that are no sequence: R1's transmission is over.
const R1_ENDED = 8;
// Start-up symbols of a burst before its error counts: S's 256 and the first of
// TRN, while the equaliser is still learning the line.
const SU_MEASURE_FROM = 512;
// How much of the retrain threshold the start-up's error may reach for a rate to
// be offered. Data runs a little above it: at 0.537 of 12 000's 0.593 a call came
// up at 12 000 and retrained to 9600; 14 400 at 45 dB reads 0.34 of its 0.42.
const TRN_MARGIN = 0.85;
// An error still falling says the equaliser is still learning, not what the line
// is: on a 12 dB tilt it fell from 3.3 to 0.6 in the last 0.4 s before R1, and 14 400
// read as 9600. Compared with its value TREND_SPAN·2 symbols before; falling faster
// than TREND_FALL, nothing is restricted and a retrain is left to judge.
const TREND_SPAN = 128;
const TREND_FALL = 1.15;
// BinModem's is 0.25, tuned on its own receiver. Ours reads 0.26 at 14 400 on a
// 2-wire line at 45 dB that it decodes exactly, and 0.37–0.44 under noise it
// cannot read, so 0.30 is between: at 0.25 it retrained a call that was working.
const UNSAT_GAP = 0.30;
const UNSAT_HOLD = 2400;

// Closest spacing of each mode's points, in the units the receiver decides in.
function closest(pts) {
  let d = Infinity;
  for (const a of pts) for (const b of pts) if (a !== b) d = Math.min(d, Math.hypot(a.i - b.i, a.q - b.q));
  return d;
}
const SPACING = {
  4800: closest(V32S.ROT.map((p) => ({ i: p.i * SU_GAIN, q: p.q * SU_GAIN }))),
  9600: 2,                                   // Table 3's {±1, ±3}² grid
  tcm: closest(TCM_9600.pts),
};

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
    this.scr = new Array(23).fill(0);
    this.txState = 'idle';        // 'idle' | 'active'
    this.txMode = 'qam';          // 'qam' | 'tone'
    // One sample clock for both directions: received sample n arrived when
    // transmitted sample n left, which is what §5.4's 64 ± 2 T turnarounds are
    // measured on (V32Preface.js).
    this._clockTx = 0;
    this._clockRx = 0;
    this._ec = new EchoCanceller();
    // On, as in a real modem, which cannot tell a 2-wire line from a 4-wire one: on
    // no echo it learns nothing, and a training that removed nothing is undone.
    this._ecOn = true;
    this._ecSpan = { start: null, trnStart: null, searchFrom: null, trnEnd: null, end: null };
    this._ecState = 'before';     // before → training → held
    this._pre = this.role === 'originate' ? new V32P.CallPreface(SPS) : new V32P.AnswerPreface(SPS);
    this._preActive = false;      // the preface's tones are driving the TX flow
    this._rxGated = true;         // the start-up receiver waits for the preface
    this._connectQ = this._buildConnectScript(this.role);
    this._idleSamples = 0;
    this._resetTxBurst();

    // ── RX ──
    this.rxLevel = 0;
    this.rxOn = false;
    this.rxLow = 0;
    this.peerRate = 0;            // rate the peer announced (R1/R2/R3), 0 until seen
    this._rates = RATE_SET;
    this._trellis = false;        // do we offer §2.4.1.2's trellis coding at 9600
    this._peerTrellis = false;    // did the peer's last rate signal (B8)
    this._dataRate = 9600;        // what the data runs at, once E settles it
    this._dataTcm = false;
    this.rateMismatch = null;     // set if the peer's R3 selects a rate we do not run

    // §5.4 progress. These deliberately survive _resetRx(): the answer modem's
    // §5.4.2 cease divides ONE procedure into two transmissions, and what was
    // detected before the silence is still detected after it. The timing lock, the
    // reference and the descrambler do not survive — they belong to a burst.
    this._sawPeerS = false;       // an S sequence has been detected (§5.4.1/§5.4.2)
    this._sawR1 = false;
    this._sawR3 = false;
    this._sawR2 = false;
    this._sawPeerE = false;
    // Which rate sequence the next detection is. R1 and R3 arrive in different
    // transmissions, so this advances on the carrier drop between them rather than
    // on the first detection — a rate signal repeats, and taking the second
    // repetition of R1 for R3 is exactly what that would do.
    this._rxStage = this.role === 'originate' ? 'r1' : 'r2';
    this._resetRx();
  }

  /**
   * The echo canceller, and the receiver idling through this end's own training.
   * ON by default, whatever the line: a real modem runs both on every call. The
   * canceller needs receive sample n to have arrived as transmit sample n left; a
   * lockstep line gives that, and in ModemDSP ClockPair.js does. Off only for a
   * negative control.
   */
  setEchoCanceller(on) { this._ecOn = !!on; }

  /**
   * Handshake tells us a genuine V.8 exchange (ANSam/CM/JM/CJ) already ran.
   * The answerer's ANSam has therefore been heard and this class must not emit
   * its own 2100 Hz answer tone on top of it — a second tone lands during the
   * peer's post-CJ training and trips its energy-onset acquisition.
   */
  setV8Complete(done) {
    if (!done) return;
    this._connectQ = this._connectQ.filter(step => step.kind !== 'tone');
    // §5.4.1's "after receiving the answer tone for ... at least 1 s" is what V.8's
    // ANSam already was, so the call modem goes straight to AA.
    if (this._pre.skipListen) this._pre.skipListen();
  }

  /** §5.4's round-trip counts once measured (symbols): NT at the call modem, MT at the answer modem. */
  get roundTrip() { return this.role === 'originate' ? this._pre.nt : this._pre.mt; }

  get carrierDetected() { return this.rxOn || this.acq; }
  get bps() { return this._dataRate; }

  /**
   * Offer §2.4.1.2's trellis coding at 9600 (Table 6/V.32's B8). It is used when
   * both ends offer it; otherwise 9600 is the non-redundant mode. Call before
   * start-up.
   */
  setTrellis(on) { this._trellis = !!on; }

  /** Advertise no rate above `bps` (4800 or 9600). Call before start-up. */
  setMaxRate(bps) {
    const rates = RATE_SET.filter((r) => r <= bps);
    if (!rates.length) throw new Error(`V.32 has no rate at or below ${bps}`);
    this._rates = rates;
  }

  /**
   * V.42 (vendor/src/ec): while a link is set, data-mode bits come from and go to
   * it — the error-control stack's synchronous stream — in place of start-stop
   * characters; null puts the characters back.
   */
  setBitLink(link) { this._link = link || null; }
  /** Whether data bits are crossing the line now: not during a retrain (V.42 7.10 suspends then). */
  get carrying() { return !!this._rxOpen && this._dataSyms >= E_TO_DATA_SYMBOLS; }

  write(bytes) { for (const by of bytes) this.txByteQ.push(by & 0xff); }

  /** Payload bytes still queued for transmission. Transport flow control. */
  get txPending() { return this.txByteQ.length; }

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
    this.txEndSample = -1;        // >=0 => finite burst; -1 => continuous
    this.txContinuous = false;    // the data flow: never ends, never turns the carrier off
    this._suActive = false;       // §5.2/§5.3's signal-gated tail is driving the flow
    this._suEnd = null;           // how that tail finished: 'data' or 'cease'
    this._dataSyms = 0;           // symbols since data began (§5.4's 128)
  }

  /**
   * §5.4's two roles, as a script of bursts. Each step waits for its own gap and,
   * where it carries `gate`, for a SIGNAL as well.
   *
   * §5.4.2's answer modem transmits the receiver conditioning signal and R1
   * unprompted, ceases on detecting the call modem's S, and transmits a second
   * conditioning signal and R3 on detecting R2. §5.4.1's call modem transmits
   * NOTHING until it "detects an incoming S sequence ... and then seek[s] to detect
   * at least two consecutive identical 16-bit rate sequences" — so its first
   * transmission is gated on R1, which is what replaced ORIG_LEAD's fixed 0.60 s.
   *
   * Before any of that, the half-duplex opening: the answer modem's AC/CA and the
   * call modem's AA/CC, with their phase reversals and the NT/MT counts. It is one
   * 'preface' burst per role, driven symbol by symbol by V32Preface.js; it ends in
   * a cease, and the call modem's NT becomes the S it sends ahead of its
   * conditioning signal (§5.4.1: "an S sequence for a period NT").
   */
  _buildConnectScript(role) {
    if (role === 'answer') {
      return [
        { kind: 'tone', gap: 0 },
        { kind: 'preface', gap: ANS_SILENCE },
        { kind: 'startup', gap: PREFACE_GAP, rate: 'r1' },
        { kind: 'startup', gap: 0, gate: 'r2', rate: 'r3' },
      ];
    }
    return [
      { kind: 'preface', gap: 0, gate: 'preface' },
      { kind: 'startup', gap: 0, gate: 'r1', rate: 'r2', preS: true },
    ];
  }

  /**
   * §5.2's receiver conditioning signal, built in one go because all three segments
   * are fixed-length: S for 256T, S̄ for 16T, then TRN.
   *
   * §5.2.3 initialises the scrambler to all zeros HERE and not before — S and S̄
   * carry no scrambled bits — and nothing in §5.3 re-initialises it, so the same
   * register runs on through the rate signals, through E and into the data mode
   * that follows. §8/V.32bis is the clause that does re-initialise it, and it does
   * so only for rate renegotiation; that it says so there is why the start-up must
   * not. The last TRN symbol is kept because §5.3 initialises the rate signal's
   * differential encoder from it.
   */
  _buildConditioning(rateWhich, preS = 0) {
    // The first conditioning signal is tagged for the echo canceller (EC_GUARD):
    // 1 for S and S̄, 3 for TRN, which it trains on and searches. The answer
    // modem's second one overlaps the call modem's R2, so it is not.
    const first = !this._condTagged;
    this._condTagged = true;
    let tag = first ? 1 : 0;
    const push = (p) => this.txSyms.push(tag ? { i: p.i * SU_GAIN, q: p.q * SU_GAIN, cond: tag } : { i: p.i * SU_GAIN, q: p.q * SU_GAIN });
    // §5.4.1: the call modem's S "for a period NT", then the conditioning signal's
    // own 256 symbols of S. S has to be an even count; NT is rounded up to one.
    if (preS > 0) for (const p of V32S.buildS(preS + (preS & 1))) push(p);
    for (const p of V32S.buildS()) push(p);
    for (const p of V32S.buildSbar()) push(p);

    this.scr.fill(0);                                   // §5.2.3
    if (first) tag = 3;
    let lastRot = V32S.A;
    for (let n = 0; n < TRN_SYMBOLS; n++) {
      lastRot = V32S.trnRotation(n, () => this._scramble(1));
      push(V32S.ROT[lastRot]);
    }

    // What follows cannot be built ahead: §5.4 repeats a rate signal UNTIL the peer
    // answers, so the tail's length is a signal and _suNext() produces it one
    // symbol at a time.
    // How much of the queue is §5.2's conditioning signal. Instrumentation only:
    // _su exists from here on, so without this describe() would report the rate
    // signal while S, S̄ and TRN are still going out.
    this._suHeadRemaining = this.txSyms.length;
    this._su = {
      enc: new V32S.DiffEncoder(lastRot),
      stage: 'rate',
      which: rateWhich,
      pending: [],
      reps: 0,
      lastRot,
    };
  }

  /** The 16 bits of one rate sequence, scrambled then differentially encoded. */
  /**
   * The start-up segment on the wire now, named as §§5.2-5.3 name it. Read-only.
   * The conditioning signal (S, S̄, TRN) is built as one burst with no per-segment
   * cursor, so it reports as TRN — the segment that is 1280 of its 1424 symbols.
   */
  describe() {
    if (this._preActive) return { phase: 2, signal: this._pre.signal };
    if (this.txSyms.length >= this._suHeadRemaining && this._suHeadRemaining > 0) {
      return { phase: 3, signal: 'TRN' };
    }
    if (this._su) {
      const st = this._su.stage;
      if (st === 'rate') return { phase: 3, signal: { r1: 'R1', r2: 'R2', r3: 'R3' }[this._su.which] || 'R' };
      if (st === 'e') return { phase: 3, signal: 'E' };
      if (st === 'cease') return { phase: 3, signal: 'cease' };
      return { phase: 5, signal: 'data' };
    }
    if (this.txState === 'active') return { phase: 3, signal: 'TRN' };
    return null;
  }

  _suSequence(bits) {
    const out = [];
    for (let k = 0; k < bits.length; k += 2) {
      const q1 = this._scramble(bits[k]);               // first in time
      const q2 = this._scramble(bits[k + 1]);
      out.push(this._su.enc.symbol(q1, q2));
    }
    return out;
  }

  /** Whether the signal this rate stage waits for has arrived (§5.4). */
  _suRateGateOpen() {
    switch (this._su.which) {
      case 'r1': return this._sawPeerS;                 // §5.4.2 "cease transmitting"
      case 'r2': return this._sawR3;                    // §5.4.1 "until R3 is detected"
      default:   return this._sawPeerE;                 // §5.4.2, R3 ends on the peer's E
    }
  }

  /** One symbol of the signal-gated tail, or null when it is finished. */
  _suNext() {
    const su = this._su;
    for (;;) {
      if (su.pending.length) {
        su.lastRot = su.pending.shift();
        const p = V32S.ROT[su.lastRot];
        return { i: p.i * SU_GAIN, q: p.q * SU_GAIN };
      }
      if (!this._suAdvance(su)) return null;
    }
  }

  _suAdvance(su) {
    switch (su.stage) {
      case 'rate':
        // §5.3.2: whatever ends a rate signal, the modem "shall first complete the
        // transmission of the current 16-bit rate sequence" — which is why the gate
        // is tested only at a sequence boundary.
        if (su.reps >= RATE_MIN_REPEATS && this._suRateGateOpen()) {
          // §5.3.2 again: E marks the end of "any rate signal other than R1".
          // R1 is not ended by E — §5.4.2 ends it by ceasing to transmit.
          su.stage = su.which === 'r1' ? 'cease' : 'e';
          return true;
        }
        su.reps++;
        su.pending = this._suSequence(this._rateWord(su.which));
        return true;
      case 'e':
        su.pending = this._suSequence(this._eWord());
        su.stage = 'to-data';
        return true;
      case 'to-data':
        this._suEnd = 'data';
        return false;
      default:
        this._suEnd = 'cease';
        return false;
    }
  }

  /**
   * Table 6/V.32's 16 bits for one of the three rate signals.
   *
   * §5.4.1: "R2 shall exclude rates and operational modes not appearing in the
   * previously received rate signal R1." §5.4.2: "The data rate ... selected by R3
   * shall be within those indicated by R2." Both are honoured by intersecting with
   * what the peer advertised; with one implemented rate the intersection is either
   * that rate or empty, and an empty one is Table 6's call for a GSTN cleardown,
   * which is recorded rather than sent as a lie.
   */
  _rateWord(which) {
    let rates = this._rates;
    if (which !== 'r1') {
      const peer = this._peerRates || [];
      rates = this._rates.filter((r) => peer.includes(r));
      if (!rates.length) this.rateMismatch = `peer offered [${peer}], this modem runs [${this._rates}]`;
    }
    if (which !== 'r1') { this._lineFrozen = true; rates = rates.filter((r) => this._lineRoom(r)); }
    if (which === 'r3') rates = rates.slice(-1);        // §5.4.2: R3 names ONE rate
    const bits = V32S.V32_RATES.build(rates);
    // B8 is about "the highest data rate indicated", so only with 9600 in the
    // signal; and like the rates, R2 and R3 claim it only if the peer did.
    if (this._trellis && rates.includes(9600) && (which === 'r1' || this._peerTrellis)) bits[TRELLIS_BIT] = 1;
    return bits;
  }

  /**
   * Table 7/V.32's sequence E. §5.3.2: its B4-B14 are Table 6's "except that the
   * only data rate and coding to be indicated shall relate to the transmission of
   * scrambled binary ones immediately following signal E" — so it names the single
   * agreed rate, which is what the peer's last rate signal called for.
   */
  _eWord() {
    const bits = V32S.V32_RATES.build([this._rate()], { sequence: 'e' });
    if (this._tcm()) bits[TRELLIS_BIT] = 1;
    return bits;
  }

  _rate() {
    const peer = this._peerRates || [];
    const common = this._rates.filter((r) => peer.includes(r) && this._lineRoom(r));
    return common.length ? common[common.length - 1] : this._rates[this._rates.length - 1];
  }

  /**
   * §5.4.1: R2 "should also take account of the likely receiver performance with
   * the particular GSTN connection", and §5.4.2 says it of R3. This end's error on
   * the far end's conditioning signal, on four states far apart, is the line's own
   * noise; a rate it would leave this receiver unsatisfactory at is not offered.
   * 4800 always is. Measured against BinModem, the error in data then comes within
   * a few percent of it, a little under.
   */
  _lineRoom(r) {
    if (r === 4800 || this._lineErr == null) return true;
    if (this._lineWas != null && this._lineWas > TREND_FALL * this._lineErr) return true;
    const mode = r === 9600 && this._trellis && this._peerTrellis ? 'tcm' : r;
    return this._lineErr < TRN_MARGIN * UNSAT_GAP * SPACING[mode];
  }

  // §2.4.1: trellis at 9600 when both ends offered it (BinModem's agreed_coding).
  _tcm() { return this._rate() === 9600 && this._trellis && this._peerTrellis; }

  _startBurst(step) {
    this._resetTxBurst();

    if (step.kind === 'tone') {
      this.scr.fill(0);
      this.txMode = 'tone';
      this.txEndSample = ANS_TONE_SAMPLES;
      this.txState = 'active';
      this._idleSamples = 0;
      return;
    }
    if (step.kind === 'preface') {
      this._pre.begin(this._clockTx);
      this.txContinuous = true;
      this._preActive = true;
      this.txState = 'active';
      this._idleSamples = 0;
      return;
    }
    // §5.2's conditioning signal is fixed-length and built here; §5.3's rate
    // signals are signal-gated and run on the continuous path, which is also what
    // lets E flow straight into data mode without the carrier ever dropping.
    this._buildConditioning(step.rate, step.preS ? this._pre.nt : 0);
    this.txContinuous = true;
    this._suActive = true;
    this.txState = 'active';
    this._idleSamples = 0;
  }

  _maybeStartBurst() {
    if (!this._connectQ.length) return;
    const step = this._connectQ[0];
    if (this._idleSamples < step.gap) return;
    if (step.gate && !this._gateOpen(step.gate)) {
      if (this._idleSamples < GATE_TIMEOUT) return;
    }
    this._startBurst(this._connectQ.shift());
  }

  _gateOpen(gate) {
    if (gate === 'preface') return this._pre.wantsTx;   // §5.4.1: the answer tone, or the tones
    if (gate === 'r1') return this._sawR1;              // §5.4.1
    if (gate === 'r2') return this._sawR2;              // §5.4.2
    return true;
  }

  /**
   * §5.4's handover out of E. Data mode continues the SAME carrier and the SAME
   * scrambler; only the number of bits per symbol changes. The differential
   * quadrant state carries over from E's final symbol, which is the same rule §5.3
   * states for the rate signal's own encoder ("initialized using the final symbol
   * of the transmitted TRN segment") applied at the next segment boundary — and it
   * costs the receiver nothing, since differential decoding needs no initial state.
   */
  _enterTxData() {
    this.txPrevY = QUAD_OF_ROT[this._su.lastRot];
    this.txRot = this._su.lastRot;
    this.txY = V32S.Y_OF_ROT[this._su.lastRot];
    // §5.4: "the initial states of the delay elements of the convolution encoder
    // ... should be set to zero".
    this.txConv = { a: 0, b: 0, c: 0 };
    this._txMode = this._rate() === 4800 ? 4800 : this._tcm() ? 'tcm' : 9600;
    this._dataSyms = 0;
  }

  // Next framed+scrambled TX bit: user bytes, else idle mark — async start/stop
  // framed. §5.4's 128 symbol intervals of scrambled binary ones after E come out
  // of the idle-mark branch, which is what they already are on the wire.
  _txBit() {
    if (this.txFrame) {
      const b = this.txFrame[this.txFramePos++];
      if (this.txFramePos >= this.txFrame.length) this.txFrame = null;
      return this._scramble(b);
    }
    if (this._link) return this._scramble(this._rxOpen && this._dataSyms >= E_TO_DATA_SYMBOLS ? this._link.nextBit() : 1);
    let by = null;
    if (this._rxOpen && this._dataSyms >= E_TO_DATA_SYMBOLS && this.txByteQ.length) by = this.txByteQ.shift();
    if (by !== null) {
      // start(0), d0..d7 LSB-first, stop(1)
      this._txByte = by;          // put back if a retrain cuts it off
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
      if (this._preActive) {
        const at = this.txSymBase + this.txSyms.length;
        const rot = this._pre.rot(at);
        if (rot !== null) {
          const p = V32S.ROT[rot];
          this.txSyms.push({ i: p.i * SU_GAIN, q: p.q * SU_GAIN });
          continue;
        }
        // The preface's cease: flush the shaper and go idle, as R1's cease does.
        this._preActive = false;
        this.txContinuous = false;
        this.txEndSample = Math.ceil((at + SPAN / 2) * SPS);
        return;
      }
      if (this._suActive) {
        const p = this._suNext();
        if (p) { this.txSyms.push(p); continue; }
        this._suActive = false;
        if (this._suEnd === 'cease') {
          // §5.4.2's "cease transmitting". Stop being continuous and let the fixed-
          // burst end condition flush the shaper, so the carrier goes down cleanly.
          this.txContinuous = false;
          this.txEndSample = Math.ceil((this.txSymBase + this.txSyms.length + SPAN / 2) * SPS);
          return;
        }
        this._enterTxData();
      }
      const Q1 = this._txBit(), Q2 = this._txBit();
      if (this._txMode === 4800) {
        // §2.4.2: the dibit turns the quadrant by Table 1 and the symbol is one of
        // Figure 1's states A B C D, the start-up's own.
        this.txRot = (this.txRot + V32S.PHASE_CHANGE[(Q1 << 1) | Q2]) & 3;
        const p = V32S.ROT[this.txRot];
        this.txSyms.push({ i: p.i * SU_GAIN, q: p.q * SU_GAIN });
        this._dataSyms++;
        continue;
      }
      const Q3 = this._txBit(), Q4 = this._txBit();
      if (this._txMode === 'tcm') {
        // §2.4.1.2: Table 2's differential on Y1 Y2, Figure 2's redundant Y0, and
        // Y0 Y1 Y2 Q3 Q4 on Figure 3.
        this.txY = TAB1[(Q1 << 1) | Q2][this.txY];
        const Y0 = convEncode(this.txConv, (this.txY >> 1) & 1, this.txY & 1);
        this.txSyms.push(TCM_9600.pts[(Y0 << 4) | (this.txY << 2) | (Q3 << 1) | Q4]);
        this._dataSyms++;
        continue;
      }
      // Table 1/V.32's phase quadrant change — the SAME table the rate signals
      // use, which is what its title says: "for 4800 bit/s and for nonredundant
      // coding at 9600 bit/s". It is not a mod-4 add of the dibit: 00 is +90° and
      // 01 is 0°, so the two are transposed relative to one.
      this.txPrevY = (this.txPrevY + V32S.PHASE_CHANGE[(Q1 << 1) | Q2]) & 3;
      this.txSyms.push(dataPoint(this.txPrevY, Q3, Q4));
      this._dataSyms++;
    }
  }

  /**
   * Idle samples are counted one at a time, so a burst can start mid-block: §5.4.2's
   * 16-symbol silence is 53 samples, a third of a block.
   */
  generateAudio(count) {
    const out = new Float32Array(count);
    const n0 = this._clockTx;
    let c = 0;
    while (c < count) {
      if (this.txState !== 'active') {
        this._maybeStartBurst();
        if (this.txState !== 'active') { this._idleSamples++; this._clockTx++; c++; continue; }
      }
      c = this.txMode === 'tone' ? this._genTone(out, c) : this._genQam(out, c);
    }
    // Continuous flow: drop shaped-out leading symbols so txSyms stays flat.
    // Only txSymBase moves; txN (carrier phase) is untouched.
    if (this.txContinuous) {
      const oldest = Math.floor(this.txN / SPS - SPAN) - 1;
      const drop = oldest - this.txSymBase;
      if (drop > 512) { this.txSyms.splice(0, drop); this.txSymBase += drop; }
    }
    if (this._ecOn) for (let k = 0; k < count; k++) this._ec.sent(n0 + k, out[k]);
    return out;
  }

  /**
   * Where transmit sample n falls in the first conditioning signal, by the symbol
   * it is nearest: the sample indices at which S, TRN and the sequence begin and
   * end, which the receiver acts on as the same indices arrive.
   */
  _ecTag(n, st) {
    const e = this._ecSpan;
    if (e.end != null) return;
    const sym = this.txSyms[Math.round(st) - this.txSymBase];
    const tag = (sym && sym.cond) || 0;
    // 1: nothing to hear. 2: the canceller trains. 3: it trains and searches.
    if (tag && e.start == null) e.start = n;
    if (tag >= 2 && e.trnStart == null) e.trnStart = n;
    if (tag === 3 && e.searchFrom == null) e.searchFrom = n;
    if (!tag && e.start != null) { e.end = n; if (e.trnEnd == null) e.trnEnd = n; }
    else if (tag < 2 && e.trnStart != null && e.trnEnd == null) e.trnEnd = n;
  }

  _genTone(out, c) {
    for (; c < out.length; c++) {
      const n = this.txN++;
      if (this.txEndSample >= 0 && n >= this.txEndSample) { this.txState = 'idle'; this._resetTxBurst(); return c; }
      this._clockTx++;
      out[c] = Math.sin(2 * Math.PI * ANS_TONE_FREQ * n / SR) * ANS_TONE_AMP;
    }
    return c;
  }

  _genQam(out, c) {
    for (; c < out.length; c++) {
      const n = this.txN++;                       // monotonic: carrier phase never jumps
      if (!this.txContinuous && this.txEndSample >= 0 && n >= this.txEndSample) {
        this.txState = 'idle'; this._resetTxBurst(); return c;
      }
      this._clockTx++;
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
      this._ecTag(this._clockTx - 1, st);
    }
    return c;
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
    // Which signal this burst is. Every burst in this procedure begins with §5.2's
    // conditioning signal, and the one that ends in E flows into data mode without
    // the carrier dropping — so the phase changes on E, not on a silence.
    this.rxPhase = this._sawPeerE ? 'data' : 'startup';
    this._sRef = null;            // {base, idx, refs[4]} — the timing lock and A/B/C/D
    this._huntFrom = Math.ceil(SPAN / 2 * SPS);   // _huntStartup's forward-only scan
    this._suRx = {
      dec: new V32S.DiffDecoder(),
      framer: new V32S.RateFramer(V32S.V32_RATES),
      runKind: null, runLen: 0, lastRot: -1,
    };
    this._tPrev = null;           // Gardner: the previous symbol
    this._tPow = 0;               // and the power it normalises by
    this._dphi = 0;               // the carrier's turn per symbol, learnt
    this._tDrift = 0;             // and the symbol instant's drift per symbol
  }

  /**
   * Gardner's timing error for the symbol at pos, given its matched-filter output
   * s: (y_k − y_(k−1))·conj(m), m half a symbol before. A late sample sees m lean
   * toward y_k, so the error is positive and the instant moves back. Returns the
   * correction in samples, which the caller adds to its base.
   */
  _timing(pos, s) {
    const prev = this._tPrev;
    this._tPrev = s;
    const p = s[0] * s[0] + s[1] * s[1];
    this._tPow += (this._tPow ? 0.02 : 1) * (p - this._tPow);
    if (!prev || this._tPow < 1e-12) return 0;
    const m = this._sym(pos - SPS / 2);
    const e = (s[0] - prev[0]) * m[0] + (s[1] - prev[1]) * m[1];
    const en = e / this._tPow;
    this._tDrift -= TRK_TFREQ * en;
    let d = -TRK_TIMING * en + this._tDrift;
    if (d > 0.1) d = 0.1; else if (d < -0.1) d = -0.1;
    return d;
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
    const e = this._ecSpan;
    for (let i = 0; i < f32.length; i++) {
      const n = this._clockRx++;
      let s = f32[i];
      if (this._ecOn) {
        if (this._ecState === 'before' && e.trnStart != null && n >= e.trnStart) { this._ec.beginTraining(() => e.searchFrom); this._ecState = 'training'; }
        if (this._ecState === 'training' && e.trnEnd != null && n >= e.trnEnd) { this._ec.endTraining(); this._ecState = 'held'; }
        s = this._ec.process(n, s);
        // Our own first conditioning signal, and its echo tail: nothing to hear.
        if (e.start != null && n >= e.start && (e.end == null || n < e.end + EC_GUARD)) s = 0;
      }
      if (this._rxGated) {
        // §5.4's opening. Its tones are not S, and a start-up receiver handed them
        // has nothing to find; it starts on what V32Preface.js says is next — the
        // call modem on the far end's S, the answer modem on the drop that ends
        // the call modem's CC.
        this._pre.rx(s, n);
        this.rxLevel += RX_A * (Math.abs(s) - this.rxLevel);
        if (!this._pre.huntArmed) continue;
        this._rxGated = false;
        this.rxOn = false; this.rxLow = 0;
        this._resetRx();
      }
      if (this._rtWatch && this.rxPhase === 'data' && this._rtWatch.push(s, n)) {
        this._beginRetrain('far end');
        continue;
      }
      this.rxLevel += RX_A * (Math.abs(s) - this.rxLevel);
      if (this.rxLevel > RX_HI) { this.rxOn = true; this.rxLow = 0; }
      else if (this.rxLevel < RX_LO && this.rxOn) { this.rxLow++; }
      if (this.rxOn) this.rx.push(s);
      if (this.rxOn && this.rxLow > RX_HANG) {
        // Carrier gone. In this procedure that is §5.4.2's "cease transmitting"
        // between R1 and the second conditioning signal; after data mode it is a
        // hangup. R1 and R3 arrive in those two different transmissions, so the
        // stage advances HERE — advancing on the first detection instead would take
        // the second repetition of R1 for R3.
        this._process();
        if (this.role === 'originate' && this._rxStage === 'r1' && this._sawR1) this._rxStage = 'r3';
        this.rxOn = false;
        this._resetRx();
      }
    }
    if (this.rxOn) this._process();
    if (this._retrainAt != null && this._clockRx - this._retrainAt > RETRAIN_PATIENCE * SR) this._beginRetrain('stalled');
  }

  /**
   * §5.2's conditioning signal, received.
   *
   * S and S̄ have the SAME differential signature — both alternate by a quarter turn,
   * since C and D are A and B reversed — so a differential detector cannot separate
   * them and the reference has to be ABSOLUTE. Two reference points taken from S
   * give all four states, because A, B, C, D are one rotation orbit: C and D are the
   * negations of A and B.
   *
   * WHICH of the two the even-indexed samples landed on is the question §10.1.3.7
   * answers for V.34 and that V.32 answers differently: Table 1 makes A → B a +90°
   * step, so the SIGN of the step inside S names the parity. Getting it wrong is not
   * a harmless 90° error — it reflects the labelling rather than rotating it, which
   * negates every differential decode and would leave the rate signal never
   * conforming.
   *
   * The scan is forward-only (`_sRef.idx` only advances) for the reason V90's
   * `_huntSd` gives: rescanning the buffer on every chunk is quadratic, and with a
   * one-second answer tone in front of it that is slow enough to look like a hang.
   */
  _huntStartup() {
    const CONFIRM = 16;
    if (!this._sRef) {
      // The scan only moves forward. A candidate that fails the confirmation below
      // is stepped past rather than retried — retried, a buffer that opens INSIDE
      // a signal (as it does when §5.4's opening hands over to the hunt mid-S)
      // fails on its truncated first symbol for ever.
      const edge = Math.ceil(SPAN / 2 * SPS);
      let sIQ = null, best = 0;
      while (!sIQ) {
        let onset = -1, e = 0;
        for (let n = this._huntFrom; n < this.rx.length; n++) {
          const b = this._bb(n); const m = Math.hypot(b[0], b[1]);
          e = 0.85 * e + 0.15 * m;
          if (e > ONSET_FRAC * Math.max(this.rxLevel, RX_LO)) { onset = Math.max(this._huntFrom, n - 4); break; }
        }
        if (onset < 0) { this._huntFrom = Math.max(this._huntFrom, this.rx.length - 8); return; }
        if (onset + (CONFIRM + 3) * SPS + edge >= this.rx.length) return;
        // S is constant-modulus, so maximising summed symbol magnitude finds the
        // ISI-free instant exactly as the old preamble search did.
        let bestScore = -1;
        best = onset;
        for (let bo = Math.max(edge, onset - 2 * SPS); bo <= onset + 2 * SPS; bo += SPS / 64) {
          let sc = 0;
          for (let k = 0; k < 12; k++) { const s = this._sym(bo + k * SPS); sc += Math.hypot(s[0], s[1]); }
          if (sc > bestScore) { bestScore = sc; best = bo; }
        }
        sIQ = this._confirmS(best, CONFIRM);
        if (!sIQ) this._huntFrom = Math.ceil(onset + 4 * SPS);
      }
      // Each parity averages to one of S's two states as the channel presents it.
      const acc = [[0, 0], [0, 0]], cnt = [0, 0];
      for (let j = 0; j < CONFIRM; j++) { const p = j & 1; acc[p][0] += sIQ[j][0]; acc[p][1] += sIQ[j][1]; cnt[p]++; }
      let a = [acc[0][0] / cnt[0], acc[0][1] / cnt[0]];
      let b = [acc[1][0] / cnt[1], acc[1][1] / cnt[1]];
      // Table 1: A to B is +90°. A negative cross product means the even samples
      // landed on B, so the two are the other way round.
      if (a[0] * b[1] - a[1] * b[0] < 0) { const t = a; a = b; b = t; }
      // The references are IDEAL: A as received turned by quarter turns, not B as
      // received. On a dispersive line B is not A turned, and an equaliser aimed at
      // both would learn the line rather than undo it.
      const bi = [-a[1], a[0]];                        // A·j: Table 1's +90°
      this._sRef = {
        base: best, idx: CONFIRM,
        refs: [a, bi, [-a[0], -a[1]], [-bi[0], -bi[1]]],   // A, B, C, D
      };
      this._eq = new SymbolEqualizer(EQ_L);
      this._suResid = null; this._suResidMid = null; this._suResidOld = null;
    }

    // Walk forward, classifying every symbol against the four states. The lock
    // found on S is followed rather than assumed (TRK_* above), which is what lets
    // the whole conditioning signal, the rate signals, E and then data mode run on
    // it against a far clock with its own drift.
    const r = this._sRef;
    const end = this.rxBase + this.rx.length - 1;
    while (this.rxPhase === 'startup') {
      const pos = r.base + r.idx * SPS;
      if (pos + (EQ_L + 1) * SPS + SPAN / 2 * SPS >= end) return;
      const raw = this._sym(pos);
      const s = this._eqRun(pos);
      r.idx++;
      let bestRot = 0, bestDot = -Infinity;
      for (let rot = 0; rot < 4; rot++) {
        const ref = r.refs[rot];
        const dot = s[0] * ref[0] + s[1] * ref[1];
        if (dot > bestDot) { bestDot = dot; bestRot = rot; }
      }
      {
        const t = r.refs[bestRot], e2 = (s[0] - t[0]) ** 2 + (s[1] - t[1]) ** 2, r2 = t[0] * t[0] + t[1] * t[1];
        // Geared as in data: TRN is 1280 symbols, and on a 12 dB tilt the error was
        // still falling fast when it ended.
        const gearT = Math.min(EQ_GEAR_TRN, Math.max(1, (this._suResid || 0) / (EQ_GEAR_FROM * STATE_R * 2)));
        if (e2 < EQ_GATE * r2) this._eq.update(t[0], t[1], EQ_MU_TRAIN * gearT);
        // The line's error on four states far apart, in data units: the measure
        // the rate signals are chosen by (_lineRoom).
        if (r.idx > SU_MEASURE_FROM) {
          const d = Math.sqrt(e2 / r2) * STATE_R;
          this._suResid = this._suResid == null ? d : this._suResid + (d - this._suResid) / UNSAT_AVG;
          if (r.idx % TREND_SPAN === 0) { this._suResidOld = this._suResidMid; this._suResidMid = this._suResid; }
        }
      }
      // Track: the phase of this symbol against the state it was read as turns
      // all four references, which stay a quarter turn apart by construction.
      const ref = r.refs[bestRot];
      const pe = Math.atan2(ref[0] * s[1] - ref[1] * s[0], bestDot);
      this._dphi += TRK_FREQ * pe;
      const ph = TRK_PHASE * pe + this._dphi;
      const c = Math.cos(ph), sn = Math.sin(ph);
      for (const q of r.refs) { const i = q[0] * c - q[1] * sn; q[1] = q[0] * sn + q[1] * c; q[0] = i; }
      r.base += this._timing(pos, raw);
      this._suSymbol(bestRot);
      // §5.4.1: R1 and R3 come in two transmissions with a silence between. The
      // carrier drop that marks it (receiveAudio) is lost under heavy noise, and R3
      // was then taken for more of R1 for ever; R1's sequences stopping says the
      // same thing.
      if (this.role === 'originate' && this._rxStage === 'r1' && this._sawR1 &&
          this._suRx && this._suRx.framer.misses >= R1_ENDED) {
        this._rxStage = 'r3';
        this._resetRx();
        return;
      }
    }
  }

  /** The equalised symbol at pos, from the matched filter at T/2 around it. */
  _eqRun(pos) {
    return this._eq.run((m, half) => this._sym(pos + (m + (half ? 0.5 : 0)) * SPS));
  }

  /**
   * Confirm this really is S before adopting a reference from it, by what a
   * linear line leaves of it: S repeats every two symbols, and its two states
   * are distinct. And what separates it from §5.4's AC, which also alternates:
   * S's two states are a quarter turn apart, so their mean (the carrier's own
   * line) stands beside their half-difference (the 600/3000 Hz lines). AC's are
   * a half turn apart and have no mean. The constant-modulus test this replaced
   * failed on a tilted line, which weights those lines unequally. The symbols,
   * or null.
   */
  _confirmS(best, count) {
    const sIQ = [];
    for (let j = 0; j < count; j++) sIQ.push(this._sym(best + j * SPS));
    let p = 0;
    for (const v of sIQ) p += v[0] * v[0] + v[1] * v[1];
    p /= count;
    if (p < 1e-12) return null;
    let rep = 0;
    for (let j = 2; j < count; j++) rep += (sIQ[j][0] - sIQ[j - 2][0]) ** 2 + (sIQ[j][1] - sIQ[j - 2][1]) ** 2;
    if (rep / (count - 2) > 0.05 * p) return null;
    const acc = [[0, 0], [0, 0]];
    for (let j = 0; j < count; j++) { acc[j & 1][0] += sIQ[j][0]; acc[j & 1][1] += sIQ[j][1]; }
    const a = acc[0].map(v => v / (count / 2)), b = acc[1].map(v => v / (count / 2));
    const mean = Math.hypot(a[0] + b[0], a[1] + b[1]) / 2, diff = Math.hypot(a[0] - b[0], a[1] - b[1]) / 2;
    if (diff * diff < 0.1 * p || mean < 0.25 * diff || mean > 4 * diff) return null;
    return sIQ;
  }

  /**
   * One classified start-up symbol: track the S / S̄ alternation §5.4 gates on, and
   * demodulate the differentially encoded bit stream the rate signals ride.
   *
   * S alternates between rotations 0 and 1 and S̄ between 2 and 3; TRN is scrambled
   * and reaches neither for long, which is why an alternation of a minimum LENGTH is
   * what separates a signal from training that happens to land on two values.
   *
   * The descrambler is fed from the differential decode throughout, including
   * across S, S̄ and TRN's first 256 symbols where those bits are not the
   * transmitter's scrambler output at all. That is sound and not sloppy: the
   * descrambler is MULTIPLICATIVE, so 23 correct received bits is all it needs, and
   * the last of those wrong bits is a thousand symbols before the first rate
   * sequence. §5.2.3's first 256 states carry only the first bit of each dibit, so
   * there is no other reading available.
   */
  _suSymbol(rot) {
    const p = this._suRx;
    const kind = (rot === V32S.A || rot === V32S.B) ? 's'
               : (rot === V32S.C || rot === V32S.D) ? 'sbar' : null;
    if (kind && kind === p.runKind && rot !== p.lastRot) p.runLen++;
    else { p.runKind = kind; p.runLen = 1; }
    p.lastRot = rot;
    if (p.runLen === RUN_CONFIRM && p.runKind === 's') this._sawPeerS = true;

    const ib = p.dec.bits(rot);
    if (!ib) return;
    for (const bit of ib) {
      const reg = this.des;
      const ob = bit ^ reg[this._rxTap] ^ reg[22];
      reg.unshift(bit); reg.pop();
      const hit = p.framer.push(ob);
      if (hit) this._suSequenceSeen(hit, rot);
    }
  }

  /** A conforming 16-bit sequence: §5.4's own dispatch, by which one is due. */
  _suSequenceSeen(hit, lastRot) {
    if (hit.kind === 'e') {
      // §5.4: E comes only after the rate exchange it ends: the call modem has
      // heard R3, the answer modem R2, and it names the rate R3 settled on. A
      // group that passes the sync cells anywhere else is noise. At 36 dB one
      // took this end into data while the far end was still in its S̄.
      const exchanged = this.role === 'originate' ? this._sawR3 : this._sawR2;
      if (!exchanged || hit.best !== this._rate()) { this.falseE = (this.falseE || 0) + 1; return; }
      this._sawPeerE = true;
      this._enterRxData(lastRot, hit);
      return;
    }
    this._peerRates = hit.advertised;
    this.peerRate = hit.best;
    // The line's error as each of the far end's rate signals arrives, until this
    // end first builds its own R2 or R3, which freezes it. Not later: by then the
    // far end may have ceased and the measure be reading silence, and R3 must not
    // change between repetitions. Not the first: on a dispersive line the equaliser
    // is still converging, and 14 400 read as 9600.
    if (!this._lineFrozen && this._suResid != null) { this._lineErr = this._suResid; this._lineWas = this._suResidOld; }
    this._peerTrellis = hit.bits[TRELLIS_BIT] === 1;
    if (this.role === 'answer') { this._sawR2 = true; return; }
    if (this._rxStage === 'r1') this._sawR1 = true; else this._sawR3 = true;
  }

  /**
   * §5.4's handover out of E, the mirror of _enterTxData. Nothing is re-acquired:
   * the timing lock is S's, the channel estimate is S's state A as the channel
   * presented it, and the descrambler has been running on correct bits since the
   * first rate sequence. That is what makes the data burst's own preamble — 72
   * invented symbols of alternating and constant corner points — unnecessary, and
   * it is gone.
   */
  _enterRxData(lastRot, e) {
    const r = this._sRef;
    const a = r.refs[V32S.A];
    const A0 = V32S.ROT[V32S.A];
    const di = A0.i * SU_GAIN, dq = A0.q * SU_GAIN;
    const d2 = di * di + dq * dq;
    this.gr = (a[0] * di + a[1] * dq) / d2;
    this.gi = (a[1] * di - a[0] * dq) / d2;
    this.g2 = this.gr * this.gr + this.gi * this.gi || 1e-9;
    this.base = r.base;
    this.symIdx = r.idx;                       // r.idx is past E's final symbol
    this.rxPrevY = QUAD_OF_ROT[lastRot];
    this.rxRot = lastRot;
    // What follows E is coded as the far end's E says (Table 7), whatever this end
    // would have chosen.
    this._dataRate = e && RATE_SET.includes(e.best) ? e.best : this._rate();
    this._dataTcm = this._dataRate === 9600 && !!e && e.bits[TRELLIS_BIT] === 1;
    this._vit = this._dataTcm ? new V32bisViterbi(V32S.Y_OF_ROT[lastRot], TCM_9600) : null;
    this.acq = true;
    this.rxPhase = 'data';
    // Circuit 109 comes on 128 symbol intervals after the incoming E (§5.4.1, and
    // §5.4.2 by reference), not at it — see _process().
    this._rxDataSyms = 0;
    this._rxOpen = false;
    this._resid = 0; this._unsat = 0;
    // §5.5: the far end's retrain signal, listened for from here on.
    this._rtWatch = new V32P.RetrainWatch(this.role, SPS);
  }

  /**
   * §5.4.1: "On detecting an incoming 16-bit E sequence ... After a delay of 128
   * symbol intervals, it shall apply an ON condition to circuit 109 ... [and] be
   * ready to transmit data." Ready, and the transmitter's data with it, wait for
   * that — counted from the FAR end's E. The call modem sends its own E first, so
   * counting from that one put its first characters on the line while the answer
   * modem was still in its own 128, which BinModem drops.
   */
  _rxDataSymbol() {
    if (this._rxOpen || ++this._rxDataSyms < E_TO_DATA_SYMBOLS) return;
    this._rxOpen = true;
    this._retrainAt = null;
    if (this._ready) { this.emit('retrained', { bps: this.bps }); return; }
    this._ready = true;
    this.emit('ready', { bps: this.bps, remoteDetected: true });
  }

  /**
   * §5.5's "detection of unsatisfactory signal reception", one data symbol at a
   * time; on a second of it, start a retrain, offering only the rates the error
   * leaves room for (§5.4.1: R2 "should also take account of the likely receiver
   * performance"). 4800 is never given up: it is the rate both ends must have.
   * True when the retrain has begun and this symbol's processing must stop.
   */
  _spacingNow() { return SPACING[this._dataTcm ? 'tcm' : this._dataRate]; }

  _unsatisfactory(xI, xQ, pts, dI, dQ) {
    // From the NEAREST point (BinModem's measure, which its threshold is a fraction
    // of a spacing for), not from the trellis path's guess, which is often further.
    let d = Math.hypot(xI - dI, xQ - dQ);
    if (pts) for (const q of pts) { const e = Math.hypot(xI - q.i, xQ - q.q); if (e < d) d = e; }
    this._resid += (d - this._resid) / UNSAT_AVG;
    const room = UNSAT_GAP * SPACING[this._dataTcm ? 'tcm' : this._dataRate];
    this._unsat = this._resid > room ? this._unsat + 1 : 0;
    if (this._unsat <= UNSAT_HOLD) return false;
    const err = this._resid;
    this._rates = this._rates.filter((r) => r === 4800 ||
      (r < this._dataRate && err < UNSAT_GAP * SPACING[r === 9600 && this._trellis ? 'tcm' : r]));
    if (!this._rates.includes(4800)) this._rates = [4800, ...this._rates];
    this._beginRetrain('unsatisfactory');
    return true;
  }

  /**
   * §5.5: a retrain. Circuits 107 and 109 stay ON (the note to §5.5.2), so this
   * class stays ready and the bytes written meanwhile wait; everything the link
   * learnt is learnt again. The call modem goes straight to AA and the answer
   * modem to AC, each then proceeding "in accordance with § 5.4.x beginning with
   * the third paragraph", which is where V32Preface's two machines start.
   */
  _beginRetrain(why) {
    this.retrains = (this.retrains || 0) + 1;
    this._retrainAt = this._clockRx;
    this.emit('retrain', { why });
    // A byte part-sent is sent again; one already on the wire is the far end's to lose.
    if (this.txFrame && this._txByte != null) this.txByteQ.unshift(this._txByte);
    this.txState = 'idle';
    this._resetTxBurst();
    this._connectQ = this._buildConnectScript(this.role)
      .filter((step) => step.kind !== 'tone')
      .map((step, k) => (k === 0 ? { ...step, gap: 0 } : step));
    this._pre = this.role === 'originate' ? new V32P.CallPreface(SPS) : new V32P.AnswerPreface(SPS, V32P.RETRAIN_AC);
    if (this._pre.skipListen) this._pre.skipListen();
    this._rxGated = true;
    this._sawPeerS = false; this._sawR1 = false; this._sawR2 = false; this._sawR3 = false; this._sawPeerE = false;
    this._lineErr = null; this._lineFrozen = false;
    this._rxStage = this.role === 'originate' ? 'r1' : 'r2';
    this._rxOpen = false;
    this._rtWatch = null;
    this.rxOn = false; this.rxLow = 0;
    this._resetRx();
    this._ec.reset();
    this._ecState = 'before';
    this._ecSpan = { start: null, trnStart: null, searchFrom: null, trnEnd: null, end: null };
  }

  _process() {
    // §5.2's conditioning signal is not the data burst. TRN is over a thousand
    // symbols of scrambled states, so handing it to a data slicer produces bytes
    // out of training; the phase split is what keeps them apart.
    if (this.rxPhase === 'startup') {
      this._huntStartup();
      if (this.rxPhase === 'startup') return;
    }

    // Continuous decode of all fully-buffered symbols.
    while (true) {
      const pos = this.base + this.symIdx * SPS;
      const end = this.rxBase + this.rx.length - 1;
      if (pos + (EQ_L + 1) * SPS + SPAN / 2 * SPS >= end) break;
      const raw = this._sym(pos);
      const s = this._eqRun(pos);
      // derotate + gain-normalise by the channel estimate: x = y·conj(g)/|g|²
      const xI = (s[0] * this.gr + s[1] * this.gi) / this.g2;
      const xQ = (s[1] * this.gr - s[0] * this.gi) / this.g2;
      let dI, dQ, bits = null;
      if (this._vit) {
        // The bits are the decoder's, VIT_DEPTH symbols late; the loops steer by
        // its best path's guess at this symbol.
        bits = this._vit.push(xI, xQ);
        dI = this._vit.tentative.i; dQ = this._vit.tentative.q;
      } else if (this._dataRate === 4800) {
        let r = 0, bd = Infinity;
        for (let k = 0; k < 4; k++) {
          const q = V32S.ROT[k], dd = (xI - q.i * SU_GAIN) ** 2 + (xQ - q.q * SU_GAIN) ** 2;
          if (dd < bd) { bd = dd; r = k; }
        }
        dI = V32S.ROT[r].i * SU_GAIN; dQ = V32S.ROT[r].q * SU_GAIN;
        const d = V32S.CHANGE_TO_DIBIT[(r - this.rxRot) & 3];
        this.rxRot = r;
        bits = [(d >> 1) & 1, d & 1];
      } else {
        dI = level(xI); dQ = level(xQ);
      }
      if (this._unsatisfactory(xI, xQ, this._vit ? TCM_9600.pts : null, dI, dQ)) return;
      // Track: the channel gain g by LMS against the sliced point D (s ≈ g·D),
      // which follows the far carrier's phase and the line's level; and timing.
      {
        const eI = s[0] - (this.gr * dI - this.gi * dQ), eQ = s[1] - (this.gr * dQ + this.gi * dI);
        const k = TRK_GAIN / (dI * dI + dQ * dQ);
        this.gr += k * (eI * dI + eQ * dQ);
        this.gi += k * (eQ * dI - eI * dQ);
        // Second order: the phase part of the same error, into the turn per symbol,
        // which then turns g ahead of the next one.
        const pr = this.gr * dI - this.gi * dQ, pq = this.gr * dQ + this.gi * dI;
        this._dphi += TRK_FREQ * (eQ * pr - eI * pq) / (pr * pr + pq * pq || 1e-9);
        const c = Math.cos(this._dphi), sn = Math.sin(this._dphi);
        const gr = this.gr * c - this.gi * sn; this.gi = this.gr * sn + this.gi * c; this.gr = gr;
        this.g2 = this.gr * this.gr + this.gi * this.gi || 1e-9;
        // The equaliser, decision-directed, toward the same decision.
        // Geared: a larger step while the error is large, the fine one as it settles.
        // The call modem enters data with its equaliser trained on one TRN, and on a
        // 12 dB tilt it came in at 0.45 of a spacing and took 8 s to reach 0.12.
        const gear = Math.min(EQ_GEAR_MAX, Math.max(1, (this._resid || 0) / (EQ_GEAR_FROM * this._spacingNow())));
        this._eq.update(this.gr * dI - this.gi * dQ, this.gr * dQ + this.gi * dI, EQ_MU_DATA * gear);
        this.base += this._timing(pos, raw);
      }
      if (!this._vit && this._dataRate !== 4800) {
        // The inverse of Table 1's phase quadrant change, which is not the same as
        // subtracting a dibit — see the transmitter.
        const { rot, Q3, Q4 } = dataBits(dI, dQ);
        const d = V32S.CHANGE_TO_DIBIT[(rot - this.rxPrevY) & 3];
        this.rxPrevY = rot;
        bits = [(d >> 1) & 1, d & 1, Q3, Q4];
      }
      if (bits) for (const bit of bits) { const r = this.des; const ob = bit ^ r[this._rxTap] ^ r[22]; r.unshift(bit); r.pop(); this.outbits.push(ob); }
      this.symIdx++;
      this._rxDataSymbol();
      // Before 109 comes on the far end sends only scrambled ones (§5.4), so the
      // UART is held off them: a decode error at the E-to-data change runs on
      // through the descrambler's taps and arrives as a false start bit — the
      // junk first byte BinModem's 14 400 start produced.
      // And once the far end's retrain signal has stood for RETRAIN_MUTE, which is
      // before any of it reaches the decoder's output: the 128 T it must be heard
      // for would otherwise reach the terminal as a flood of bytes.
      if (!this._rxOpen || (this._rtWatch && this._rtWatch.held > RETRAIN_MUTE * SPS)) this.outbits.length = 0;
      this._uartConsume();

      // Trim consumed samples to keep the continuous RX buffer flat. Preserve
      // rxBase so the carrier phase (derived from the flow-local index) is exact.
      const drop = Math.floor(this.base + (this.symIdx - SPAN - EQ_L) * SPS) - this.rxBase;
      if (drop > 512) { this.rx.splice(0, drop); this.rxBase += drop; }
    }
  }

  // Async start/stop deframer over the descrambled bit stream.
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
        if (bit === 1) { this._rxByte(this.uByte & 0xff); this.uState = 'hunt'; }
        else { this.uState = 'hunt'; this.uArmed = false; this.uMarks = 0; }
      }
    }
  }

  // One deframed byte. The rate signals are §5.3's own 16-bit sequences on the
  // wire now, not reserved bytes in this stream, so nothing here is stripped.
  _rxByte(b) { this.emit('data', Buffer.from([b])); }
}

// BASE, dataPoint and dataBits are exported for tools/tests/v32-map-check.js, so
// that the harness holds Table 1 and Table 3 against the map this class actually
// transmits rather than against a second copy of it.
module.exports = { V32, BASE, dataPoint, dataBits };
