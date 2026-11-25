'use strict';

/*!
 * @license
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Copyright (C) 2026 Joseph Quinn
 *
 * The receive equaliser's least-squares solve on PP (`_p3Solve`, `_ppRefine`,
 * `leastSquares`), the raw S-to-S̄ detector (`_rawSbar`) and the reuse of the
 * solved equaliser in a later burst (`_eqFromSolved`) are ported from BinModem
 * <https://github.com/CasualArclamp/BinModem>, crates/datapump/src/v34/
 * receiver.rs (the hunt, `solve_known`, `reacquire`), at commit
 * 623f935e28fe6de3a8a4f41492feb46e1bb86c3a of <https://github.com/synexo/BinModem>.
 * Copyright the BinModem authors; GPL-3.0-or-later. See NOTICE.
 */

/**
 * V.34 — ITU-T V.34 (1998), operated as TRUE FULL-DUPLEX continuous carrier over
 * the SynthLink WebSocket transport, in the project's "genuine minimal" style
 * (see PROTOCOLS.md §0). Built on the proven V.32/V.32bis DSP core: same
 * fractional-SPS root-raised-cosine synthesis + fractional matched filter,
 * a receiver that acquires on S and carries that timing into data mode,
 * role-asymmetric self-synchronising scramblers, and async UART framing over an
 * always-on scrambled stream.
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
 *   - The start-up is §11's: Phase 2's probing and ranging, Phase 3's S, S̄, PP,
 *     TRN and J, Phase 4's J′/S, TRN, MP, MP′ and E, each end gated on the far
 *     end's signals, then B1 and data mode in the same transmission (§10.1.3.1).
 *   - Superframe synchronisation (Table 12) on the wire; data mode counts its
 *     mapping frames from B1 (§8).
 *
 * ── Genuine-minimal, documented (not hidden) ────────────────────────────────
 *   Justified by the lossless, 4-wire-equivalent, drift-free transport (§0):
 *   - **No probing ANALYSIS.** Phase 2 is real — §11.2's procedure, §10.1.2's
 *     tones, INFO sequences and Table 17's L1/L2 — and the symbol rate is
 *     negotiated through Table 16 rather than configured. What is not done is
 *     MEASURING L1 and L2: this transport has no amplitude distortion, group delay
 *     or noise, so INFO1c's projected rates come from what each configuration
 *     achieves rather than from a channel estimate. See V34Phase2.js.
 *   - **No precoder** (§9.6.2). V.34's Tomlinson-Harashima-style precoder cancels
 *     channel ISI using the far-end response h[]; on a flat, ISI-free channel
 *     h≈[1,0,0] so the precoder output is ≈0 and Y≈U (the constellation point).
 *     It degenerates to identity here, exactly as V.32bis's Viterbi is unused.
 *   - **No non-linear warping** (§9.7, itself optional in the spec).
 *   - **No Viterbi decoder.** (STAGE A′ adds the genuine 16-state 4D trellis and
 *     carries U0 on the wire; the receiver slices and discards it — the ~coding
 *     gain is unused on a lossless link, as with V.32bis's Y0.)
 *   - **Timing and carrier are acquired on S and then TRACKED** (TRK_* and
 *     _trkTiming / _trkPhase): Mueller–Müller timing and a second-order carrier
 *     rotator, so a far clock ±100 ppm off holds every symbol rate at its ceiling
 *     (bm-v34 [5]). There IS a receive equaliser (17 taps at T/2, trained on
 *     Phase 3/4; see _eqReset), which is what a far end whose pulse shaping is not
 *     ours needs — BinModem's is not.
 *   - **Retrains (§11.5) are not implemented.** Where a §11 recovery deadline
 *     expires, the modem proceeds instead; each such place says so.
 *
 * The genuine encode chain — shell-mapping constellation shaping (§9.4), 4D
 * differential coding (§9.5), the Figure-10 16-state 4D trellis on the wire
 * (§9.6.3), and the quarter-superconstellation ring/point mapper (§9.6.1) — lives
 * in V34Mapper.js and is exercised bit-exact by tools/tests/v34-map-check.js.
 *
 * Interface matches the other protocol classes: constructor(role);
 * generateAudio(n)->Float32Array; receiveAudio(f32); write(buf); emits 'data'
 * (Buffer) and 'ready' ({bps, remoteDetected}); getters bps and carrierDetected.
 */

const { TONE_AMP, LINE_RMS, rmsAt } = require('../LineLevel');
const { EventEmitter } = require('events');

// ── Genuine V.34 encode chain (shell map + 4D differential + 16-state trellis +
// mapper), §9.3–9.6, provided by V34Coder. A mapping frame is CFG.frameBits
// scrambled bits → CFG.symsPerFrame (8) constellation points, and back. See
// V34Mapper.js. Data-mode configuration (symbol rate + bit rate) is selected here.
const { V34Coder, V34Viterbi, makeConfig, CONFIGS, RATE_CONFIGS, meanEnergy, sliceOdd, invRot } = require('./V34Mapper');
// Phase 4's Modulation Parameter sequence, Table 20/V.34. It replaces what used
// to be a project-invented `DLE 'R' hi lo` rate frame: same DLE carriage, but the
// content is now the Recommendation's own bit layout and it is load-bearing —
// the peer's transmit rate, trellis, Θ and shaping selections are read from it
// and a disagreement is a hard failure rather than a silently wrong decode.
const V34Phase4 = require('./V34Phase4');
// Phase 3's segments, §10.1.3: S, S̄, MD, PP, TRN and the J / J′ sequences. It
// replaced `_buildAATrain`, which was 250 ms of alternating REF points standing in
// for the whole phase. V.90 §9.3.2 references V.34's segments rather than
// redefining them, and V90.js's analogue modem transmits through this class, so
// this serves both. See V34Phase3.js for the clause-by-clause order.
const P3 = require('./V34Phase3');
const { EchoCanceller } = require('../EchoCanceller');
// Phase 2's signals, §10.1.2: tones A and B with their 180° reversals, the INFO
// sequences and their 600 bit/s DPSK, and Table 17's L1 / L2 probing signal. The
// procedure §11.2 builds from them is below — same division as Phase 3.
const P2 = require('./V34Phase2');
const config = require('../../../config');

// ── Per-symbol-rate RF front-end (genuine V.34 carrier, Table 2). Roll-off/span
// are the largest excess bandwidth that keeps the occupied band FC ± S/2·(1+β)
// inside (0, 4000) Hz at 8 kHz while opening the eye — each verified against a
// perfect-timing loopback before being wired. 3429 is razor-thin (lower edge
// ≈ 4 Hz) but sound on the lossless link (span 32 at β=0.14 → 0 slice errors).
// §5.2: "The symbol rate shall be S = (a/c) x 2400 +/- 0.01% ... (in which symbol
// rates are shown rounded to the nearest integer)", Table 1/V.34. §5.3: "The
// carrier frequency shall be (d/e) x S Hz", Table 2/V.34. Both tables PRINT
// rounded integers, and this table's KEY is that printed value — it is what
// CONFIGS, Table 7 and Table 10 are keyed on, and what INFO1c's rate ladder
// names. The signal is generated from a/c and d/e instead, because the printed
// 3429 is 3428.5714... rounded and using it put the symbol rate 125 ppm out
// against a tolerance of 100 ppm. `high` records which of the two carriers
// Table 2 offers is the one transmitted, so INFO1c can declare it truthfully.
// Roll-off/span are NOT from the Recommendation — V.34 constrains the transmit
// spectrum by the templates of Figures 1 and 2 with a +/-1 dB tolerance (§5.4.1)
// and prescribes no pulse — so they stay the largest excess bandwidth that keeps
// FC +/- S/2*(1+beta) inside (0, 4000) Hz at 8 kHz while opening the eye. 3429 is
// razor-thin (lower edge ~4 Hz) but sound on the lossless link.
const RF = {
  // span 24, as 3200's: at 10 the truncated filter left 2400's receiver at ten times
  // the training error of the other two rates against BinModem (10⁻³ against 10⁻⁴),
  // which its rate rule then paid for at two rungs; a longer equaliser made it worse.
  2400: { a: 1,  c: 1, d: 3, e: 4, high: true,  rolloff: 0.25, span: 24 },
  3200: { a: 4,  c: 3, d: 3, e: 5, high: true,  rolloff: 0.20, span: 24 },
  3429: { a: 10, c: 7, d: 4, e: 7, high: true,  rolloff: 0.14, span: 32 },
};
// Table 2 gives 3429 the same d/e for both carriers, so `high` is nominal there.
const gcd = (x, y) => (y ? gcd(y, x % y) : x);
// Resolve the per-call rate from the shared config singleton (mutated by the
// server/client just before DSP construction, exactly like protocolPreference).
// Accepts a rate-name ('33600/3429') or a bps number (33600); defaults to the
// highest available. Unknown values fall back to the max.
const RATE_ALIASES = { 19200: '19200/2400', 28800: '28800/3200', 31200: '31200/3200', 33600: '33600/3429' };
const DEFAULT_RATE = '33600/3429';
function resolveRateName() {
  const sel = config.modem && config.modem.native && config.modem.native.v34Rate;
  if (typeof sel === 'string' && RATE_CONFIGS[sel]) return sel;
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
const UART_ARM_MARKS = 8;
const RX_A = 0.02, RX_HI = 0.015, RX_LO = 0.006, RX_HANG = 48;
// The front-end AGC (_agc). Its target is our own transmit RMS, the level every
// threshold here was set at; its floor is −48 dBm0 (full scale +3.17 dBm0), the
// level a modem's carrier detect drops at; 10 ms; at most 40 dB.
const AGC_TARGET = LINE_RMS;
const AGC_FLOOR = 0.00196;
const AGC_A = 1 / 80;
const AGC_MAX = 100;
// The gain follows only a level within 6 dB of its peak (in power, a quarter),
// the peak itself decaying over half a second so a real change of level is
// followed after a moment.
const AGC_HOLD = 0.25;
const AGC_PEAK_DECAY = Math.exp(-1 / (0.5 * 8000));
const ANS_TONE_FREQ = 2100, ANS_TONE_AMP = TONE_AMP, ANS_TONE_SAMPLES = Math.round(1.0 * SR);

// ── Phase 3 (§10.1.3 for the segments, §11.3 for the order) ─────────────────
// §11.3.1.2.1: the answer modem "shall transmit silence for 70 ± 5 ms" before its
// first S. The call modem has no corresponding constant — §11.3.1.1.1 makes it
// "initially silent" and gates it on DETECTING S and the subsequent S̄, which is
// what replaced ORIG_LEAD (a 0.60 s originate-side silence with no basis in the
// Recommendation). The V.8 sequencer hands the two ends their protocol at
// measurably different instants — the originate side leaves CJ when its transmit
// queue drains, the answer side only once it has DEMODULATED CJ — so a fixed lead
// was a guess at a skew a detector absorbs exactly.
const ANS_PHASE3_SILENCE = Math.round(0.070 * SR);

// ── §11.2 — Phase 2 durations, from the clauses rather than from Figure 16 ───
// §11.1.1.2 / §11.1.2.2: "transmit silence for 75 ± 5 ms, and proceed with Phase 2".
const P2_SILENCE = Math.round(0.075 * SR);
// §11.2.1.1.3 / §11.2.1.2.5: a reversal is delayed so that the interval between
// receiving the peer's reversal and this modem's own appearing on the line is
// 40 ± 1 ms, and the tone runs for 10 ms after it.
const P2_TURNAROUND = Math.round(0.040 * SR);
const P2_AFTER_REVERSAL = Math.round(0.010 * SR);
// §11.2.1.2.3: the answer modem reverses tone A only after it "has been
// transmitted for at least 50 ms"; §11.2.1.2.6 transmits it for 50 ms again.
const P2_TONE_MIN = Math.round(0.050 * SR);
// §10.1.2.4: L1 is 160 ms. L2 is "no longer than 550 ms"; the Recommendation sets
// no floor, so a short legal value is taken here for the same reason DIL's N is —
// the backlog's rule that a shorter start-up comes from the knobs the
// Recommendation provides rather than by omission.
const P2_L1 = Math.round(P2.L1_MS / 1000 * SR);
const P2_L2 = Math.round(0.100 * SR);
const P2_L2_MAX = Math.round(P2.L2_MAX_MS / 1000 * SR);
// §11.2.1.1.5 and §11.2.1.2.8: a modem RECEIVES L1 "for its 160 ms duration" and
// "may then receive signal L2 for a period of time not to exceed 500 ms". That
// bound is not a safety net — it is what stops the two modems waiting on each
// other, because the peer's L2 ends when it detects THIS modem's tone, and this
// modem does not send that tone until it has finished receiving.
//
// 500 ms is the clause's MAXIMUM and there is no floor, so a shorter legal value is
// taken here for the same reason L2's own duration is. It has to be shorter: the
// tone this modem sends when it stops receiving is what ends the peer's L2, and
// §11.2.2.2.3 gives the peer only 600 ms from the start of L2 to hear it. At the
// full 500 the tone leaves at 660 ms and arrives after the peer's recovery bound
// has already fired — which it did, in about one run in twenty, and presented as
// the peer restarting §11.2.1.2.3 for no visible reason.
const P2_RX_L2 = Math.round(0.200 * SR);
const P2_RX_PROBE = P2_L1 + P2_RX_L2;
// One INFO bit at 600 bit/s. 8000/600 is 13.33, so bit edges are tracked in
// floating point rather than rounded — and the receiver integrates over exactly
// one bit period, which puts a null on the 1800 Hz guard tone 600 Hz away.
const P2_BIT = SR / P2.INFO_BIT_RATE;
// The amplitude Phase 2 calls "nominal". A single tone at this level has the RMS
// the data burst has, so the whole start-up reaches the line at one power and the
// §10.1.2 level offsets mean what they say.
const P2_NOMINAL = TONE_AMP;                  // −10 dBm0 (LineLevel.js)
// Detector thresholds on the mixed-down correlator, as a fraction of P2_NOMINAL.
const P2_TONE_ON = 0.35, P2_TONE_OFF = 0.15;
// §11.2.2's recovery bounds, per step, in samples. These are the Recommendation's
// own numbers and they replaced one invented 3 s constant applied to every gated
// step — which was too tight: under a loaded real-time pump the two ends' sample
// clocks separate, a step expired before its peer's signal arrived, and the
// procedure desynchronised into a cascade of further expiries. One measured run
// came out 8 s long, which is three of them.
//
// The ACTIONS behind them are §11.2.2's own and are carried on the steps as
// `recover` (what a bound expiring does) and `interrupt` (what an arriving signal
// does). Two of the clauses call for a retrain per §11.5 — §11.2.2.1.5 and the
// Tone-detected halves of §11.2.2.1.6 / §11.2.2.2.4 — and get one
// (_startupTimeout). Everything else recovers where the clause sends it.
const P2_MS = (ms) => Math.round(ms / 1000 * SR);
// §11.2.2.1.3 / §11.2.2.2.2 — 2000 ms for the second reversal, both modems.
const P2_BOUND_REV2 = P2_MS(2000);
// §11.2.2.1.4 — 900 ms plus a round trip delay for the third Tone A reversal.
const P2_BOUND_REV3 = P2_MS(900);
// §11.2.2.1.6 — 700 ms plus a round trip from the end of INFO1c.
const P2_BOUND_INFO1A = P2_MS(700);
// §11.2.2.2.4 — 2000 ms plus TWO round trip delays for INFO1c.
const P2_BOUND_INFO1C = P2_MS(2000);
// §11.2.2.1.2 has no bound at all — "the call modem shall continue transmitting
// Tone B until it does detect a Tone A phase reversal" — and §11.2.2.2.1's remedy
// for the answer modem is to repeat INFO0a rather than to give up. A wait with no
// bound cannot be left literally unbounded here, because nothing above this class
// would end the call; this is the backstop, and it is NOT from the Recommendation.
const P2_BACKSTOP = P2_MS(10000);
// §11.2.2.1.5 — 650 ms plus a round trip from the beginning of L2, and
// §11.2.2.2.3 — 600 ms plus a round trip, likewise. Both are longer than
// §10.1.2.4's own 550 ms cap on TRANSMITTING L2, which is why a step can stop
// emitting the probe and go on waiting: `emitMax` is the transmit bound and
// `bound` the recovery one, and the gap between them is the Recommendation's.
const P2_BOUND_L2_CALL = P2_MS(650);
const P2_BOUND_L2_ANS = P2_MS(600);
// One INFO0 sequence on the line. §11.2.2.1.1 and §11.2.2.2.1 begin "if the modem
// detects [the peer's tone] before receiving INFO0x", and a modem cannot know that
// the sequence is not merely still arriving — so the tone has to have been up at
// least as long as the sequence it stands in place of before that reads as a loss.
// THAT interval is this file's choice; the clause states no time. Anything shorter
// fires in the error-free procedure, where the peer's tone follows its INFO0 by a
// few milliseconds and the sequence is only parsed on its last bit.
const P2_INFO0_LEN = Math.round((P2.INFO0.length + 1) * SR / P2.INFO_BIT_RATE);
// Consecutive decoded ones before INFOMARKS is believed. §10.1.2.3.6 is "binary
// ones to the DPSK modulator" with no frame, so a run is the whole signal; 48 bits
// is 80 ms and no INFO sequence contains a run near it (the longest is Table 14's
// four fill bits beside a run of set data bits).
const P2_MARKS_RUN = 48;
// A cap on §11.2.2's recoveries in one Phase 2, and it is NOT from the
// Recommendation — the clauses recover indefinitely, on the assumption that
// something above them eventually abandons the call. Nothing above this class
// does, so a procedure that recovered forever would be a `generateAudio` that
// never returns. Past the cap a step advances the way it did before this was
// implemented, which is the behaviour a caller can still see the end of.
const P2_MAX_RECOVERIES = 8;
// Step transitions allowed without a sample being emitted. Every recovery is a
// jump backwards, so a step list with a zero-length cycle in it would spin inside
// generateAudio for ever and present exactly as the sandbox's WS hang. This is the
// structural guard: it cannot fire while every cycle contains a step that emits.
const P2_SPIN_CAP = 64;
// How many interleaved sampling phases the INFO demodulator runs.
//
// There is no bit-timing recovery here and there does not need to be, but there
// DOES need to be more than one decimation phase. The integration windows are one
// bit long and free-running from the receiver's own sample zero; the transmitter's
// bits begin wherever §11.2's silence ends. Land half a bit out and every window
// straddles two bits, the differential decode is noise, and INFO0 never presents a
// frame sync with a passing CRC — which is a connect that fails outright, not one
// that degrades. It failed about one run in three that way.
//
// Four phases put some phase within an eighth of a bit of the transmitter's, and
// the frame sync plus the CRC pick the one that decoded. Cheaper than timing
// recovery and, on a link that cannot drift, sufficient.
const P2_INFO_PHASES = 4;
// The probe's own bin. 1050 Hz is a Table 17 tone and is not tone A, tone B or the
// guard — §10.1.2.4 omits all three from the probe — so it separates the two
// cleanly. It is also the tone INFO1's frequency-offset field is measured against,
// which is not a coincidence.
const P2_PROBE_BIN = 1050;
// Windows of probe required before its END may be believed. L1 alone is 160 ms,
// which is 96 windows, so 40 is well inside it and well outside any transient.
const P2_PROBE_CONFIRM = 20;
// One period of the probe, which is the window that nulls every Phase 2 tone.
const P2_PROBE_WIN = SR / P2.PROBE_SPACING_HZ;
// The probe is 21 tones sharing the level, so one bin holds a small fraction of it
// — measured at about 1/12 of nominal for L2 and four times that for L1.
const P2_PROBE_ON = 0.03, P2_PROBE_OFF = 0.015;
// Consecutive points of the opposed phase before a reversal is believed. §11.2
// holds a tone for 10 ms after every reversal, which is six points, so three is
// inside the shortest one the procedure sends and outside any edge transient.
const P2_REV_CONFIRM = 3;
// Consecutive quiet presence windows before a tone counts as gone. See _p2Presence:
// a reversal nulls one coherent window on its own.
const P2_TONE_DROP = 3;
// A carrier is MODULATED, rather than a tone that has just reversed, if it has
// flipped phase this many times in the last `P2_MOD_WINDOW` points.
//
// This is what keeps §11.2.2.1.1's repeated INFO0c out of the answer modem's
// reversal count, and it is needed because the two gates that were already here
// leave a window open between them. `toneOn` collapses within a couple of 150 Hz
// windows once modulation starts — but "a couple" is 20 ms, and a reversal is
// confirmed in 5, so an INFO sequence arriving where the procedure expects a tone
// gets a false reversal counted before the presence detector notices. Raising
// P2_REV_CONFIRM instead does not work: §11.2 holds a tone for only 10 ms after a
// real reversal, which is six points, so there is no room above it.
//
// Density separates the two cleanly rather than narrowly. A real reversal is
// exactly ONE flip in the window; INFO is a 600 bit/s stream that opens with
// §10.1.2.3.3's four fill bits and an eight-bit frame sync, so it reaches three
// flips within the first handful of points and holds the gate down for the whole
// sequence. Sixteen points is 27 ms, well under the 50 ms a tone is held before
// any reversal is sent, so a tone that follows a sequence is trusted again in time.
const P2_MOD_WINDOW = 16, P2_MOD_FLIPS = 3;

// §11.3.1.1.6 / §11.3.1.2.3: TRN "shall be transmitted for at least 512T". The
// minimum is the legal choice taken here, per the backlog's rule that a shorter
// start-up comes from the knobs the Recommendation provides rather than by
// omission.
const TRN_SYMBOLS = P3.TRN_MIN_SYMBOLS;

// §10.1.3.5: MD is OPTIONAL and its length is carried in INFO1 — "if the signal is
// not present, the MD length indication will be 0". There is no INFO exchange here
// until the line-probing item, so this modem declares no manufacturer-defined
// signal, which is what a modem without one does. The procedure branch that emits
// it (and the second S / S̄ pair that follows it) is present and is exercised by
// v34-phase3-check at a non-zero length.
const MD_SYMBOLS = 0;

// §10.1.3.3: J is "a whole number of repetitions" of Table 18's 16-bit pattern, and
// each end repeats it until a SIGNAL of the far end's: the answer modem until the
// call modem's S-to-S̄ transition (§11.3.1.2.4), the call modem until the answer
// modem's Phase 4 S followed by S̄ (§11.4.1.1.1). The floor is P4_SEQ_MIN_REPS,
// below. The ceilings are the recovery deadlines: §11.4.2.1.1 gives the call modem
// 600 ms plus a round trip from the start of J, and its action on expiry is a
// retrain (§11.5, _startupTimeout).
const J_DEADLINE_S = 0.600;
// §11.4.2.1.2 / §11.4.2.2.2: E must arrive within 2500 ms plus two (call) or three
// (answer) round trips, or the modem retrains. That bounds how long MP and MP′ are
// repeated while their acknowledgement is awaited; expiry retrains, as above.
const P4_DEADLINE_S = 2.500;

// §11.3.2.1.1's deadline, as the call modem's fallback when no S-to-S̄ arrives:
// "if ... sequence J is not received within 2800 ms plus two round trip delays".
// The action on expiry is a retrain (§11.5.1.1, _startupTimeout). Past
// START_RETRAINS, or before Phase 2 has run, this modem proceeds into its own
// Phase 3 regardless: a call that may still train, where hanging does not.
const S_GATE_TIMEOUT = Math.round(2.8 * SR);
// Start-up retrains in a row before a bound's expiry is let through instead
// (BinModem stops at two as well).
const START_RETRAINS = 2;
// §11.5's retrain. Silence "for 70 ± 5 ms" before the tone, and the far end's tone
// answered "after detecting Tone A [Tone B] for more than 50 ms". The watcher is a
// one-pole resonator at the far tone, RT_BW wide, against the total power. Data
// leaves about 2% of its power in that slot (30 Hz of 3.9 kHz at 3429 baud). Tone B
// is all of its own, and tone A under half: §10.1.2.1 sends it with the 1800 Hz
// guard at nominal power and itself 1 dB below. RT_SHARE sits between, at any
// level above RT_FLOOR.
const RETRAIN_SILENCE = Math.round(0.070 * SR);
const RT_HELD = Math.round(0.050 * SR);
const RT_BW = 30, RT_SHARE = 0.3, RT_FLOOR = rmsAt(-43) ** 2;
const RT_A = Math.exp(-2 * Math.PI * RT_BW / SR);

/**
 * A retrain tone's watch: true once `hz` has stood more than RT_HELD. V.90 keeps
 * one too (§9.5.1.2, §9.5.2.2), on the same tones with its parts renamed.
 */
function retrainWatch(hz) {
  const w = { w: 2 * Math.PI * hz / SR, n: 0, zr: 0, zi: 0, ms: 0, held: 0 };
  const fn = (x) => {
    const ph = w.w * (w.n++ % SR);
    w.zr = RT_A * w.zr + (1 - RT_A) * x * Math.cos(ph);
    w.zi = RT_A * w.zi - (1 - RT_A) * x * Math.sin(ph);
    w.ms = RT_A * w.ms + (1 - RT_A) * x * x;
    const tone = w.ms > RT_FLOOR && 2 * (w.zr * w.zr + w.zi * w.zi) > RT_SHARE * w.ms;
    w.held = tone ? w.held + 1 : 0;
    return w.held > RT_HELD;
  };
  fn.state = w;
  return fn;
}
// Circuit 104 clamped to marks while the far end is not sending data: its silence
// before a retrain tone, or a carrier that has gone. The slicer's error per
// dimension, over about RX_CLAMP_N symbols: silence reads near 1, and data at any
// rate this receiver selects (σ² ≤ 0.25, RATE_SIGMA2_MAX) stays well under the
// clamp. Hysteresis so a burst at the edge does not chatter it.
const RX_CLAMP_N = 16, RX_CLAMP_ON = 0.5, RX_CLAMP_OFF = 0.3;
// And a retrain asked for when the receiver can no longer hold the rate: the same
// error over RX_UNSAT_N symbols above RX_UNSAT for a second of symbols. A slicer's
// error saturates: noise that has swamped the lattice lands uniformly in a cell,
// which reads 1/3 per dimension, and a line at the rate's own bound (σ² 0.25 over
// both dimensions) reads about 0.12. RX_UNSAT sits near the top, past any rate. The retrain then picks the
// rate the line now holds.
const RX_UNSAT_N = 512, RX_UNSAT = 0.29;
// Short of that, a line that has merely worsened past the rate's bound (0.125 per
// dimension) for a second is renegotiated down (§11.6) to what the error allows.
const RX_FALLBACK = 0.16;
// And falling forward: below the configured rate, a receiver whose data-mode
// error has left room for a higher rung for RX_FORWARD_S is renegotiated up, no
// sooner than RX_CHANGE_GAP_S after the last change, and only where this end's
// receiver was the one that stepped it down. A step up the far end
// would not take (its MP held the rate) doubles the wait before the next try.
// The rung stepped up to must fit with its error at most RX_FORWARD_MARGIN of the
// bound, so a line sitting at a bound does not swing between two rates.
const RX_FORWARD_S = 5, RX_CHANGE_GAP_S = 10, RX_FORWARD_EVERY = 64, RX_FORWARD_MARGIN = 0.7;
// §11.6's renegotiation. The far end's S found inside data mode: a two-symbol
// alternation (x[k] ≈ x[k−2], x[k] far from x[k−1]) over RN_S_N symbols, which
// scrambled data cannot hold, for RN_S_HELD of S's 128. And §11.6.2: a
// renegotiation that has not come back to data by RN_TIMEOUT is a retrain.
const RN_S_N = 16, RN_S_HELD = 24, RN_S_REP = 0.05, RN_S_TURN = 1.0;
// Found that late, S is mostly gone: the receiver goes back RN_REWIND symbols, to
// before it began, which the data path keeps buffered for this.
const RN_REWIND = RN_S_N + RN_S_HELD + 16;
const RN_TIMEOUT = Math.round(6 * SR);

// How many symbols of unbroken S (or S̄) alternation the receiver requires before it
// will call one. S is 128T and S̄ only 16T, so the confirmation has to fit inside the
// shorter of the two with margin; 12 does, and is long enough that TRN — whose
// rotations are random — reaches it with probability 2^-11 per position.
const P3_RUN_CONFIRM = 12;
// The least-squares solve on PP (_p3Solve), after BinModem's receiver.rs: the
// equaliser is solved for outright from PP, which is known from its first symbol,
// rather than adapted from the identity while the tracking loops run, which on a
// dispersive line it never did. PP_SKIPPED symbols are left while the line's
// memory fills; PP_SOLVED are fitted, at each alignment within PP_SEARCH symbols of
// where S̄ put PP; the best fit is kept if its error is under PP_ENOUGH. Good fits
// measure 1–4·10⁻⁴; one at 0.04 (PP misplaced) was kept at a bound of 0.05 and
// cost a rung of rate.
const PP_SKIPPED = 48, PP_SOLVED = 200, PP_SEARCH = 4, PP_ENOUGH = 0.01, PP_TIE = 2;
// And where no fit is found within PP_SEARCH, BinModem's wide search: every
// alignment within PP_WIDE scored first by correlating the raw samples with PP,
// then solved at the PP_WIDE_TRIES best and either side of each. Under heavy smear
// S̄'s dip can mark PP a dozen symbols out.
const PP_WIDE = 40, PP_WIDE_TRIES = 3;
// The raw S̄ detector (_rawSbar): a symbol against the one two before it is the
// same throughout S and its opposite across S̄, whatever the timing and the
// carrier (BinModem's hunt). It finds PP on a line whose ISI keeps S̄ from ever
// classifying as twelve clean alternations against S's references.
const RAW_S_RUN = 32, RAW_SBAR_RUN = 4, RAW_SBAR_OF = 6;
const PP_REF = P3.buildPP();

/**
 * Complex least squares with a ridge: the w minimising Σ|row·w − t|² + λ|w|², by
 * the normal equations and Gaussian elimination with partial pivoting. Rows and w
 * are interleaved [re, im, re, im, ...]. Null if singular.
 */
function leastSquares(rows, targets, n) {
  // A = RᴴR + λI, b = Rᴴt, as 2n×2n real blocks would double the work, so complex.
  const Ar = new Float64Array(n * n), Ai = new Float64Array(n * n), br = new Float64Array(n), bi = new Float64Array(n);
  let tr = 0;
  for (let r = 0; r < rows.length; r++) {
    const x = rows[r], t = targets[r];
    for (let i = 0; i < n; i++) {
      const xr = x[2 * i], xi = x[2 * i + 1];
      br[i] += xr * t[0] + xi * t[1]; bi[i] += xr * t[1] - xi * t[0];       // conj(x_i)·t
      for (let j = 0; j < n; j++) {
        const yr = x[2 * j], yi = x[2 * j + 1];
        Ar[i * n + j] += xr * yr + xi * yi; Ai[i * n + j] += xr * yi - xi * yr; // conj(x_i)·x_j
      }
      tr += xr * xr + xi * xi;
    }
  }
  const lambda = 1e-4 * tr / n;
  for (let i = 0; i < n; i++) Ar[i * n + i] += lambda;
  for (let c = 0; c < n; c++) {
    let piv = c, best = 0;
    for (let r = c; r < n; r++) { const m = Ar[r * n + c] ** 2 + Ai[r * n + c] ** 2; if (m > best) { best = m; piv = r; } }
    if (best < 1e-24) return null;
    if (piv !== c) {
      for (let j = 0; j < n; j++) {
        let t = Ar[c * n + j]; Ar[c * n + j] = Ar[piv * n + j]; Ar[piv * n + j] = t;
        t = Ai[c * n + j]; Ai[c * n + j] = Ai[piv * n + j]; Ai[piv * n + j] = t;
      }
      let t = br[c]; br[c] = br[piv]; br[piv] = t; t = bi[c]; bi[c] = bi[piv]; bi[piv] = t;
    }
    const pr = Ar[c * n + c], pi = Ai[c * n + c], pm = pr * pr + pi * pi;
    for (let r = c + 1; r < n; r++) {
      const ar = Ar[r * n + c], ai = Ai[r * n + c];
      const fr = (ar * pr + ai * pi) / pm, fi = (ai * pr - ar * pi) / pm;   // a / pivot
      if (fr === 0 && fi === 0) continue;
      for (let j = c; j < n; j++) {
        const cr = Ar[c * n + j], ci = Ai[c * n + j];
        Ar[r * n + j] -= fr * cr - fi * ci; Ai[r * n + j] -= fr * ci + fi * cr;
      }
      br[r] -= fr * br[c] - fi * bi[c]; bi[r] -= fr * bi[c] + fi * br[c];
    }
  }
  const w = new Float64Array(2 * n);
  for (let r = n - 1; r >= 0; r--) {
    let sr = br[r], si = bi[r];
    for (let j = r + 1; j < n; j++) {
      const ar = Ar[r * n + j], ai = Ai[r * n + j], wr = w[2 * j], wi = w[2 * j + 1];
      sr -= ar * wr - ai * wi; si -= ar * wi + ai * wr;
    }
    const pr = Ar[r * n + r], pi = Ai[r * n + r], pm = pr * pr + pi * pi;
    w[2 * r] = (sr * pr + si * pi) / pm; w[2 * r + 1] = (si * pr - sr * pi) / pm;
  }
  return w;
}
// The Phase 3 bit stream is a ring, not a log: the longest thing read out of it is
// one DIL descriptor, and a consumer that has stopped reading must not be able to
// grow it without bound.
const P3_BIT_CAP = 4096;

// ── Phase 4 (§11.4) ─────────────────────────────────────────────────────────
// §11.4.1.1.1 puts TRN after J′ and §10.1.3.9 initialises MP's differential encoder
// "using the final symbol of the transmitted TRN sequence", so this TRN is what MP
// is encoded against rather than decoration. §11.4.1.1.2 and §11.4.1.2.2 both say
// "for a minimum of 512T"; the minimum is the legal choice taken, as in Phase 3.
const P4_TRN_SYMBOLS = P3.TRN_MIN_SYMBOLS;
// The cap V.90's analogue modem still counts its CP exchange against. Plain V.34's
// MP exchange is bounded by P4_DEADLINE_S instead.
const P4_MP_MAX_REPS = 48;
// And a floor of two, for the reason §10.1.3.3 makes J "a whole number of
// repetitions" and §8.3.1 repeats Ja: TRN is not differentially encoded, so the
// receiver's differential decode across it does not reproduce the transmitter's
// scrambler output and its self-synchronising descrambler spends the first 23 bits
// of whatever follows recovering. One sequence settles it; a sequence sent once is
// the sequence that gets eaten.
const P4_SEQ_MIN_REPS = 2;

// Two repetitions of each Table 18 pattern, first bit in time most significant —
// the shift register _huntJE keeps.
const jWin = (pat) => parseInt(pat + pat, 2) >>> 0;
const J_WIN_4 = jWin(P3.J_PATTERN_4POINT);
const J_WIN_16 = jWin(P3.J_PATTERN_16POINT);

// What _p3Next returns once E has gone: the tail hands the continuous burst to the
// data path, which starts with B1 on the very next symbol (§11.4.1.1.4, §11.4.1.2.4).
const ENTER_DATA = Object.freeze({ enterData: true });
// The data-mode gain tracker's step. Small: it follows a level and a slow phase, not
// symbol-rate noise.
const RX_GAIN_MU = 0.01;
// The receive equaliser (_eqReset): ±EQ_L symbols at T/2, so 4·EQ_L + 1 taps.
// Six, because a band edge 2 ms late is seven symbols at 3429 baud: at ±4 that
// line trained 10 dB under BinModem's own receiver; at ±6 it reads the same.
const EQ_L = 6;
const EQ_N = 4 * EQ_L + 1;
const EQ_MU_TRAIN = 0.05;     // normalised-LMS step on Phase 3/4's four points
const EQ_MU_DATA = 0.005;     // and decision-directed in data mode
const EQ_GATE = 0.1;          // train only where |error|² < this × |point|²
// The rate a receiver can take, from its own training (_rxCap). Training runs
// EQ_COARSE symbols at EQ_MU_TRAIN, then at EQ_MU_FINE, and ε = err²/|point|² is
// measured from EQ_SETTLE symbols into the fine stage: at the coarse step the
// equaliser's own adaptation noise dominates on a clean path, which would
// understate a link that is in fact clean (BinModem's V.34: 3·10⁻⁴ coarse,
// 5·10⁻⁵ fine), while a noise floor does not move (V.90's µ-law upstream: 6·10⁻⁴
// either way). In data-lattice units the noise is σ² = ε · meanE(rate); a rate is
// taken when σ per dimension is at most 0.35 of the half-step, i.e. σ² ≤ 0.25 —
// what the Viterbi decoder (V34Viterbi) holds error-free with margin: none in
// 12 000 symbols at σ = 0.42, where a hard slicer errs on 3%. Without it the bound
// was a quarter (σ² ≤ 2/16), and BinModem's V.90 upstream measured 28 800 at
// 0.18 erring and 26 400 at 0.11 clean.
const EQ_COARSE = 1000, EQ_SETTLE = 300, EQ_MU_FINE = 0.005;
const EQ_MIN_MEASURED = 200;
// Tracking a far clock with its own crystal (_trkPhase, _trkTiming). ±100 ppm turns
// the carrier 0.2 Hz, which is 45° — a whole decision region of Phase 3's four
// points — in 0.6 s, well inside BinModem's 1.2 s PP and TRN; and it walks the
// symbol instant a sample a second, off the ±EQ_L equaliser in a few seconds.
//
// Carrier: a second-order rotator after the equaliser, whose targets are turned
// back by the same angle so it never has to learn the rotation itself. It is the
// only loop that may turn the phase: the data-mode gain follows the level alone.
// A complex gain update was a third phase loop beside it and the equaliser, the
// split between them was free, and it wandered through whole turns. In Phase 3
// it has its own gate, looser than the equaliser's (TRK_GATE). Under the
// equaliser's alone, a turning carrier left the gate within 1700 symbols, and then
// nothing updated that could bring it back.
//
// Timing: Mueller and Müller's detector on the derotated output and its decision,
// into a second-order loop. Two were tried first. Gardner, on the matched filter's
// output, is biased here: the pulse has little excess bandwidth and BinModem
// shapes its own, and at 0 ppm it learnt a drift that cost four rungs. The
// equaliser's tap centroid hardly moves, because data mode's normalised step over
// 17 taps is too slow, so the loop wound up against a stale reading. The base
// moves in TRK_QUANTUM steps because the polyphase banks are exact per base. At
// 1/32 a step was 0.04 rad at the band edge, the whole of 33 600's error budget;
// at 1/256 the banks are rebuilt every 17 symbols at 100 ppm.
//
// Measured against BinModem, both roles, 0 and ±100 ppm: the loops settle on the
// predicted 3.6·10⁻⁴ rad and 2.3·10⁻⁴ samples a symbol, and every case reaches
// 33 600. A far clock that is SLOW (−ppm) still costs ε (2·10⁻⁴, against 5·10⁻⁵
// at 0 and +100) whatever these gains are. The resampler is symmetric to −75 dB at
// 3400 Hz, so the asymmetry is ours. Not yet explained.
const TRK_PHASE = 0.02;        // of the phase error, per symbol
const TRK_FREQ = 2e-4;         // of the phase error, into the turn per symbol
const TRK_TIMING = 0.02;       // samples per unit of normalised M&M error
const TRK_TFREQ = 4e-5;        // of the same, into the drift per symbol
const TRK_SETTLE = 500;        // trained symbols before the timing loop runs
const TRK_QUANTUM = 1 / 256;   // samples: the base moves in these
const TRK_GATE = 0.5;          // radians: Phase 3/4's carrier loop takes points this near
// The echo canceller's window (EchoCanceller.js). This end's Phase 3 S, S̄, PP and
// TRN go out while the far end is silent: the call modem starts its S only on
// hearing the answer modem's J, and the answer modem falls silent on hearing the
// call modem's S̄ (§11.3). The canceller adapts on PP and TRN, not on S and S̄,
// which repeat every two symbols. The receiver idles through all four and EC_GUARD
// samples after them, since all it can hear then is our own echo.
const EC_GUARD = 160;
const RATE_SIGMA2_MAX = 0.25;

let CURRENT_RATE = null;
let CFG, FE, BAUD, FC, SPS, ROLLOFF, SPAN, RRC_G = 1;
// SPS and the carrier are both exact rationals once the symbol rate is (§5.2/§5.3),
// and that is what makes the tables below exact rather than interpolated:
//   SPS  = SR/S      = 10c/3a      — 7/3 at 3429, 5/2 at 3200, 10/3 at 2400
//   FC/SR = 3da/10ec               — 12/49,       6/25,        9/40
// So the carrier repeats exactly every CAR_S samples, and the symbol timing phase
// repeats exactly every SPS_Q symbols (RX) / SPS_P samples (TX).
let SPS_P = 1, SPS_Q = 1, CAR_R = 0, CAR_S = 1;
let CAR_COS = null, CAR_SIN = null;
// TX polyphase bank: one tap vector per sample phase, since st = n/SPS advances by
// the integer SPS_Q whenever n advances by SPS_P. TX_KLO[ph] is the first symbol
// index the vector covers for n = ph.
let TX_W = null, TX_KLO = null;
let MEAN_E, TX_GAIN, RATE_BPS;
// §10.1.3's NOTE requires the average signal power in Phase 3 to be the power the
// data mode goes on to use. Every Phase 3 segment is drawn from a unit-scale point
// set — S, TRN and J from the four rotations of point 0 (energy 2), PP from the
// unit circle (energy 1) — so each is scaled to MEAN_E here rather than emitted at
// lattice scale, which would put Phase 3 tens of dB under the data burst and train
// the far end at a gain it will not see again.
let P3_GAIN_S, P3_GAIN_PP, P4_GAIN_16;

// A polyphase bank's taps for a symbol instant `frac` samples past a whole sample,
// at the current rate, with start indices relative to that sample (_symBank adds
// it). Cached by rate and fraction; read only once built.
const BANK_TAPS = new Map();
function bankTaps(frac) {
  const key = `${CURRENT_RATE}:${Math.round(frac * 2 ** 30)}`;
  let t = BANK_TAPS.get(key);
  if (t) return t;
  if (BANK_TAPS.size > 4096) BANK_TAPS.clear();
  const cap = Math.ceil(SPAN * SPS) + 4;
  t = { LEN: new Int32Array(SPS_Q), N0: new Int32Array(SPS_Q), W: [] };
  for (let ph = 0; ph < SPS_Q; ph++) {
    const pos = frac + ph * SPS;
    const n0 = Math.ceil(pos - SPAN / 2 * SPS), n1 = Math.floor(pos + SPAN / 2 * SPS);
    const len = n1 - n0 + 1, w = new Float64Array(Math.max(cap, len));
    for (let j = 0; j < len; j++) w[j] = rrc((n0 + j - pos) / SPS);
    t.LEN[ph] = len; t.N0[ph] = n0; t.W.push(w);
  }
  BANK_TAPS.set(key, t);
  return t;
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
// The RRC tap at an exact fractional delay. Called only when a polyphase bank is
// built — once per acquisition on RX, once per configure() on TX — never per
// sample, so it stays the literal expression rather than a table.
const rrc = t => rrcAt(t) * RRC_G;

// cos/sin of the carrier at sample n, from a CAR_S-entry table. Exact: the phase
// is 2*pi*(CAR_R/CAR_S)*n, so (CAR_R*n) mod CAR_S names it with no rounding and no
// argument growth — the direct form loses low-order bits as n climbs through a
// long call, which is a slow phase drift rather than a constant offset.
function buildCarrierTable() {
  CAR_COS = new Float64Array(CAR_S);
  CAR_SIN = new Float64Array(CAR_S);
  for (let j = 0; j < CAR_S; j++) {
    CAR_COS[j] = Math.cos(2 * Math.PI * j / CAR_S);
    CAR_SIN[j] = Math.sin(2 * Math.PI * j / CAR_S);
  }
}
const carIdx = n => { const j = (CAR_R * n) % CAR_S; return j < 0 ? j + CAR_S : j; };

// TX bank, built once per rate. Phase ph covers n = ph + m*SPS_P for every integer
// m, and st = n/SPS then differs by exactly m*SPS_Q — an integer symbol shift — so
// one vector serves every n in the phase class and the taps are the same doubles
// rrc() would return.
function buildTxBank() {
  TX_W = []; TX_KLO = [];
  for (let ph = 0; ph < SPS_P; ph++) {
    const st = ph / SPS;
    const klo = Math.ceil(st - SPAN / 2), khi = Math.floor(st + SPAN / 2);
    const w = new Float64Array(khi - klo + 1);
    for (let i = 0; i < w.length; i++) w[i] = rrc(st - (klo + i));
    TX_W.push(w); TX_KLO.push(klo);
  }
}

// Each rate's front end, built once and kept: configure() builds into the module
// bindings, and installFE() puts a built one back. The bindings are what every
// method reads; an instance re-installs its own at each entry (see the wrapping
// after the class), which is what makes them per call — JavaScript runs one
// method at a time, so between entries the bindings are free to change.
const FE_CACHE = new Map();
function snapshotFE() {
  return { CFG, FE, BAUD, FC, SPS, ROLLOFF, SPAN, RRC_G, SPS_P, SPS_Q, CAR_R, CAR_S, CAR_COS, CAR_SIN,
           TX_W, TX_KLO, MEAN_E, TX_GAIN, RATE_BPS, P3_GAIN_S, P3_GAIN_PP, P4_GAIN_16, CURRENT_RATE };
}
function installFE(f) {
  if (f.CURRENT_RATE === CURRENT_RATE) return;
  ({ CFG, FE, BAUD, FC, SPS, ROLLOFF, SPAN, RRC_G, SPS_P, SPS_Q, CAR_R, CAR_S, CAR_COS, CAR_SIN,
     TX_W, TX_KLO, MEAN_E, TX_GAIN, RATE_BPS, P3_GAIN_S, P3_GAIN_PP, P4_GAIN_16, CURRENT_RATE } = f);
}
/** The front end for `rateName`, installed. */
function frontEnd(rateName) {
  if (!FE_CACHE.has(rateName)) { configure(rateName); FE_CACHE.set(rateName, snapshotFE()); }
  const f = FE_CACHE.get(rateName);
  installFE(f);
  return f;
}

function configure(rateName) {
  if (rateName === CURRENT_RATE) return;
  if (FE_CACHE.has(rateName)) { installFE(FE_CACHE.get(rateName)); return; }
  CFG = makeConfig(RATE_CONFIGS[rateName]);
  FE = RF[CFG.sRate];
  // §5.2 / §5.3 exactly, not the rounded values Tables 1 and 2 print.
  BAUD = 2400 * FE.a / FE.c;
  FC = BAUD * FE.d / FE.e;
  SPS = SR / BAUD; ROLLOFF = FE.rolloff; SPAN = FE.span;
  { const n = 10 * FE.c, d = 3 * FE.a, g = gcd(n, d); SPS_P = n / g; SPS_Q = d / g; }
  { const n = 3 * FE.d * FE.a, d = 10 * FE.e * FE.c, g = gcd(n, d); CAR_R = n / g; CAR_S = d / g; }
  if (SPS_P / SPS_Q !== SPS) throw new Error(`V.34: SPS ${SPS} is not ${SPS_P}/${SPS_Q}`);
  buildCarrierTable();
  { let s = 0; for (let k = -SPAN * 4; k <= SPAN * 4; k++) s += rrcAt(k / 4) ** 2; RRC_G = 1 / Math.sqrt(s / 4); }
  buildTxBank();
  MEAN_E = meanEnergy(CFG);                                 // computed, not measured (V34Mapper)
  TX_GAIN = LINE_RMS / Math.sqrt(MEAN_E) * Math.SQRT2 * 0.999;   // data-burst RMS: −10 dBm0
  RATE_BPS = CFG.bitRate;                                   // advertised (nominal) rate
  // Table 20's MP is per instance now (_mpBits): its rate is what this end's
  // receiver measured it can take, not the configured rate.
  P3_GAIN_S  = Math.sqrt(MEAN_E / P3.meanEnergy(P3.buildS()));
  // §10.1.3's NOTE: "the average signal power transmitted in Phases 3 and 4 is
  // maintained in segment B1 and the subsequent data mode", so the 16-point Phase 4
  // set is scaled to the data constellation's mean energy as the 4-point one is.
  P4_GAIN_16 = Math.sqrt(MEAN_E / P3.meanEnergy(V34Phase4.MP16_POINTS));
  P3_GAIN_PP = Math.sqrt(MEAN_E / P3.meanEnergy(P3.buildPP()));
  CURRENT_RATE = rateName;
}
configure(DEFAULT_RATE);   // module-load default; re-resolved per construction below

/**
 * One data rate's per-instance configuration at the configured symbol rate. The
 * symbol-rate front end (filters, carrier, Phase 3/4 gains) is module-level and
 * shared; everything that depends on the DATA rate is here, per direction, so a
 * receiver can run the rate it measured it can take, and two calls in one process
 * can run different rates. Line power does not depend on the rate: data points
 * are scaled (per instance, `_txScale`) so their power is the training power
 * (§10.1.3's NOTE), and a receiver normalises with `p3GainS` — the far end's
 * training-to-lattice ratio at THIS rate.
 */
const DATA_CFG = new Map();
function dataCfg(bitRate) {
  const key = `${bitRate}/${CFG.sRate}`;
  if (DATA_CFG.has(key)) return DATA_CFG.get(key);
  if (!RATE_CONFIGS[key]) throw new Error(`V.34: no ${key} configuration`);
  const cfg = makeConfig(RATE_CONFIGS[key]);
  const meanE = meanEnergy(cfg);
  const d = {
    bitRate, cfg, meanE,
    p3GainS: Math.sqrt(meanE / P3.meanEnergy(P3.buildS())),
  };
  DATA_CFG.set(key, d);
  return d;
}

/** The ladder rates at the configured symbol rate, ascending. */
function ladder() {
  return Object.values(RATE_CONFIGS).filter((c) => c.sRate === CFG.sRate).map((c) => c.bitRate).sort((a, b) => a - b);
}

class V34 extends EventEmitter {
  constructor(role) {
    super();
    this._fe = frontEnd(resolveRateName());   // this call's rate, from the shared config singleton
    this._ec = new EchoCanceller();
    // On, as in a real modem, which cannot tell a 2-wire line from a 4-wire one: on
    // no echo it learns nothing, and a training that removed nothing is undone.
    this._ecOn = true;
    this._ecTx = 0; this._ecRx = 0;           // absolute sample clocks, one per direction
    this._ecSpan = { start: null, trnStart: null, searchFrom: null, trnEnd: null, end: null };
    this._ecState = 'before';                 // before → training → held
    this.role = role === 'originate' ? 'originate' : 'answer';
    this._ready = false;
    if (this.role === 'originate') { this._txTap = 17; this._rxTap = 4; }
    else                           { this._txTap = 4;  this._rxTap = 17; }
    this._rate = RATE_BPS;
    // This call's line levels, captured now: configure() is module-level, and a
    // later construction at another rate re-sets the globals under a call already
    // running. The product of each gain with TX_GAIN is rate-independent; the
    // factors are not, so they are taken together, once.
    this._g = { s: P3_GAIN_S, pp: P3_GAIN_PP, p16: P4_GAIN_16, tx: TX_GAIN, meanE: MEAN_E };
    this._configuredRate = RATE_BPS;   // the ceiling: what this end was set up for
    // The configured symbol rate is a ceiling too: INFO0 and INFO1 offer nothing
    // above it, and INFO1's choice at or below it is taken (_useSymbolRate).
    this._symCeil = CFG.sRate;
    this._txD = dataCfg(RATE_BPS);     // per direction; set to the agreed rate at data entry
    this._rxD = this._txD;
    this._mpCap = null;                // what our MP advertised, latched when first sent
    this._eqMeasured = null;           // the last burst's training measure (_eqReset)

    // TX
    this.txByteQ = [];
    this.scr = new Array(23).fill(0);
    // Phase 3's own clause 7 register — see _buildPhase3 for why it is not `scr`.
    this.scr3 = new Array(23).fill(0);
    this.txCoder = new V34Coder(this._txD.cfg);
    this.txState = 'idle';
    this.txMode = 'qam';
    this._connectQ = this._buildConnectScript(this.role);
    this._idleSamples = 0;
    // §11.2's state, transmit and receive. It outlives a burst: the procedure is
    // one exchange and its detectors have to survive every silence inside it.
    // Which PART of §11.2 this modem plays, and what its INFO sequences are. V.34
    // derives it from the role; V.90 replaces it wholesale — see setPhase2Profile.
    this._p2Profile = this._defaultPhase2Profile();
    this._p2 = this._newP2();
    this._mdSymbols = MD_SYMBOLS;        // until INFO1 says otherwise (§10.1.3.5)
    this.rtdSamples = 0;
    this.negotiatedSymbolRate = null;
    this.rateMismatch = null;
    this.phase2Incomplete = false;
    this._resetTxBurst();

    // RX
    this.rxLevel = 0;
    this.rxOn = false;
    this.rxLow = 0;
    this.peerRate = 0;
    this.peerMP = null;         // parsed Table 20/V.34 MP from the far end
    this.peerMPPrime = null;    // and its MP′, which is the far end acknowledging OURS
    this._mpScan = 0;           // absolute cursor into p3.bits — see _huntMP
    this._symScratch = [0, 0];  // the matched filter's output, for callers that do
                                // not retain it — see _symInto
    this._p4 = null;            // §9.4.2's CP exchange, when V.90 supplies one
    this.mpMismatch = null;     // set if the peer selected coding we do not run
    this.rxCoder = new V34Coder(this._rxD.cfg);
    // Phase 3 and 4 reception state. It deliberately survives _resetRx(): the far
    // end's Phases 3 and 4 are one procedure however many silences divide them —
    // the answer modem's between its Phase 3 and Phase 4, V.90's analogue modem's
    // §9.3.2.4 — and data mode is entered from it, at B1, not after it.
    this._sGateTimedOut = false;
    this._peerJ = 0;             // the size the far end's J asked for: 4 or 16
    this._peerE = false;
    this.p3 = this._newP3();
    this._resetRx();
  }

  /**
   * Which of S's two points the timing lock landed on — and it matters, because the
   * two answers are not related by a rotation.
   *
   * The reference is taken from S by parity: one mean is "the even-index symbol",
   * the other "the odd-index one". Nothing in that says WHICH of S's two points is
   * which, and the two hypotheses differ by a REFLECTION (label = 3 − true), not by
   * a rotation. A reflection leaves S and S̄ perfectly recognisable — both are still
   * alternations, which is why the detector that item 1 needed never noticed — but
   * it NEGATES every differential decode, so J, J′ and Ja come out as In′ = −In and
   * no frame sync is ever found.
   *
   * §10.1.3.7 supplies the disambiguator: "Signal S̄ shall begin with the
   * transmission of point 0 rotated by 180 degrees." So the first symbol of a
   * confirmed S̄ run is rotation 2 by definition. Its LABEL is therefore 2 if the
   * lock was even and 1 if it was odd, and that single comparison settles the
   * labelling for the rest of Phase 3. The decoder is restarted at the same moment,
   * because everything it produced before this point was read off the wrong map.
   */
  _resolveP3Parity(p) {
    if (p.parityKnown) return;
    p.reflect = (p.runFirstRot === 1);
    p.parityKnown = true;
    p.dec.prev = null;
    p.anchor = null;
    p.des3.fill(0);
    // Counted as bits that have LEFT the front rather than reset to zero: `trimmed`
    // is what every absolute cursor into this ring subtracts, so it may only go up.
    p.trimmed += p.bits.length;
    p.bits.length = 0;
  }

  /** Phase 3 reception state. Survives _resetRx until Phase 3 genuinely ends. */
  _newP3() {
    return {
      runKind: null, runLen: 0, lastRot: -1, runFirstRot: -1, inS: false,
      sCount: 0, sbarCount: 0,
      reflect: false, parityKnown: false,
      dec: new P3.JDecoder(), des3: new Array(23).fill(0), bits: [],
      // Total bits dropped off the FRONT of `bits`, by the cap below or by a
      // consumer taking a sequence out of it. A hunt keeps an absolute cursor and
      // subtracts this, so trimming the ring cannot make it skip a position.
      trimmed: 0,
    };
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
  }

  /**
   * Which side of §11.3's Phase 3 this modem plays, independently of its V.34 role.
   *
   * V.34 gives the leading part to the answer modem (§11.3.1.2.1) and the gated part
   * to the call modem (§11.3.1.1.1). V.90 swaps it: §9.3.2.1 gives the ANALOGUE
   * modem — which is V.90's originate side, and the side that runs this class — the
   * same "silence for 70 ± 5 ms, signal S for 128T and signal S̄ for 16T" the V.34
   * answer modem has. The digital modem is not a V.34 transmitter at all; it answers
   * with Sd on the PCM side, so there is no S here for the analogue modem to wait
   * for and a gated originate would sit out its whole timeout.
   *
   * Call before the first generateAudio(); it rebuilds the connect script.
   */
  /**
   * Whether this instance runs a Phase 2 at all.
   *
   * Nothing in this build turns it off any more: V.90 used to, because §9.2 was a
   * procedure this class did not have, and now it runs §9.2 here through
   * `setPhase2Profile` instead. The switch stays because "start at Phase 3" is a
   * real thing to ask of this class — it is what a retrain wants — and because
   * turning it off is how the V.34 start-up was reached before Phase 2 existed.
   * Call before the first generateAudio(); it rebuilds the connect script.
   */
  /**
   * §11.2's two parts, named by the tone each transmits rather than by the role.
   *
   * The call modem transmits tone B and INFO0c; the answer modem transmits tone A
   * and INFO0a. That is a property of the PART, not of who dialled — and §9.2/V.90
   * hands the parts to the other pair of modems: its digital modem plays the part
   * V.34 gives the call modem and its ANALOGUE modem, which is V.90's originate
   * side, plays the answer modem's. Keying the step lists, the carriers and the
   * peer's tone on the part rather than on `role` is what lets one machine run both
   * procedures, which is honest rather than merely convenient: §9.2's clauses are
   * §11.2's clauses with the two modems renamed, down to every duration and every
   * recovery bound.
   *
   * `peerInfo0` and `peerInfo1` are the specs this modem RECEIVES. They are part of
   * the profile because V.90's sequences are not V.34's — INFO0d is thirteen bits
   * longer than INFO0a, and a V.90 INFO1a is Table 10's fields in Table 16's frame,
   * so a receiver that hunted the wrong spec would get a passing CRC and wrong
   * values rather than a failure.
   */
  _defaultPhase2Profile(part) {
    const toneA = (part || (this.role === 'answer' ? 'toneA' : 'toneB')) === 'toneA';
    return {
      part: toneA ? 'toneA' : 'toneB',
      info0: () => this._info0Bits(),
      info1: () => (toneA ? this._info1aBits() : this._info1cBits()),
      peerInfo0: P2.INFO0,
      peerInfo1: toneA ? P2.INFO1C : P2.INFO1A,
      settle: null,
    };
  }

  /**
   * Run §9.2/V.90's Phase 2 on §11.2's machine, or any part of it.
   *
   * Given before the first generateAudio(). What a caller supplies is the part, the
   * two sequences it transmits, the two it receives, and — because Table 10 carries
   * fields Table 16 does not — what to do with the peer's INFO1 once it arrives.
   */
  setPhase2Profile(profile) {
    // The part is settled FIRST, because the defaults it fills in around depend on
    // it: which sequence this modem's INFO1 is, and which two it listens for.
    this._p2Profile = { ...this._defaultPhase2Profile(profile.part), ...profile };
    this._p2 = this._newP2();
    this._noRetrain = true;            // V.90's retrain is §9's, not §11.5
  }

  /**
   * This modem's own INFO0, for a caller that builds a longer one around it.
   * Table 7/V.90's first fourteen capability fields are Table 14/V.34's, and they
   * describe the V.34 mode this build would fall back to — so V90.js asks for them
   * here rather than deciding them a second time.
   */
  phase2Info0Bits() { return this._info0Bits(); }

  /** Whether §11.2 (or §9.2/V.90 on this machine) has finished. */
  get phase2Complete() { return !!(this._p2 && this._p2.settled); }

  /**
   * Whether the procedure is running RIGHT NOW — begun and not yet settled.
   *
   * Not the same question as `!phase2Complete`, and the difference is load-bearing
   * for V90.js: an instance that has never generated a sample has not completed
   * Phase 2 either, and a caller that routes its received audio on the negation
   * would starve a receiver that is only ever a receiver. `v90test`'s
   * acquisition-from-every-phase section is exactly that receiver.
   */
  get phase2Active() { return !!(this._p2Started && this._p2 && !this._p2.settled); }

  /**
   * The signal this modem is transmitting right now, as the Recommendation names
   * it. Read-only instrumentation for the UI: it inspects state the transmitter
   * already keeps and never sets any, so it cannot perturb a procedure whose
   * timing is load-sensitive. `null` means "nothing worth naming".
   *
   * The names are the clauses' own — 'INFO0a', 'L1', 'MP', 'E' — because the step
   * list and the Phase 3 stage machine were written against those clauses. What
   * they are called for a human is the caller's business, not this module's.
   */
  /**
   * Whether data is crossing the line now: false from a retrain's start until the
   * far end's B1 has been received again. V.42 suspends its timers through it.
   */
  get carrying() { return this._ready && !this._retraining; }

  /**
   * Begin a retrain from data mode (§11.5.1.1, §11.5.2.1). False, and nothing
   * done, outside data mode or on an instance that runs another Recommendation's
   * Phase 2 (V.90's), whose retrain is that Recommendation's.
   */
  retrain() {
    if (!this._ready || this._retraining || this._noRetrain) return false;
    this._beginRetrain('asked');
    return true;
  }

  /**
   * Begin a rate renegotiation from data mode (§11.6.1.1), offering to receive at
   * most `maxBps` (the configured rate if not given) and no more than this end's
   * receiver now holds. False, and nothing done, where retrain() would be.
   */
  renegotiate(maxBps) {
    if (!this._ready || this._retraining || this._noRetrain) return false;
    this._beginReneg(true, maxBps);
    this._renegTx();
    return true;
  }

  /**
   * The fastest rate the data-mode error so far leaves room for (see _rxCap),
   * with its error at most `margin` of the bound.
   */
  _dataCap(margin = 1) {
    const cur = this._rxD;
    const eps = 2 * (this._rxErrSlow || 0) / (cur.meanE || 1);
    const rates = ladder().filter((r) => r <= this._configuredRate);
    let best = rates[0];
    for (const r of rates) if (eps * dataCfg(r).meanE <= RATE_SIGMA2_MAX * margin) best = r;
    return best;
  }

  /**
   * §11.6: TRN, MP, MP′ and E again, from data mode, in the 4-point form; no
   * Phase 2, no PP. Both ends send S for 128T and S̄ for 16T first — the initiator
   * at once (§11.6.1.1.1), the responder on the initiator's S-to-S̄
   * (§11.6.1.2.2) — and each enters data at the other's B1.
   */
  _beginReneg(initiating, maxBps) {
    this.renegotiations = (this.renegotiations || 0) + 1;
    this._reneg = { initiating, txStarted: false, rxStarted: false, at: this._ecRx };
    this._retraining = true;
    this.emit('retrain', { why: initiating ? 'renegotiate' : 'far end renegotiates' });
    // V.90's upstream rate is its digital modem's MP's (V90._rateUp), not this end's.
    if (!this._renegInData) this._mpCap = Math.min(this._dataCap(), maxBps || this._configuredRate);
    this._mpBitsTx = null; this._mppBitsTx = null;
    this.peerMP = null; this.peerMPPrime = null; this._peerE = false; this._mpScan = 0;
    this._rate = this._configuredRate;
  }

  /**
   * This end's S, S̄, TRN, MP: Phase 4's tail, taken up inside the data burst. The
   * carrier and the symbol clock carry on: the far end's data receiver is what
   * finds S, and a burst begun afresh would put both somewhere it has not tracked.
   */
  _renegTx() {
    this._reneg.txStarted = true;
    if (this.txFrame && this.txFrame.length === 10) {
      let by = 0;
      for (let k = 0; k < 8; k++) by |= this.txFrame[1 + k] << k;
      this.txByteQ.unshift(by);
    }
    this.txFrame = null; this.txWarmup = 0;
    this._p3 = {
      enc: null, stage: 'p4-trn', bits: null, bitPos: 0, reps: 0, count: 0, done: false,
      run: [...P3.buildS(), ...P3.buildSbar()], jStart: null, mpReps: 0, reneg: true,
    };
    this._p3HeadRemaining = 0;
    this._p3Active = true;
  }

  /**
   * The far end's S, found inside data mode: the receiver takes it as Phase 4's
   * burst, from the equaliser it has (the line is the one it was trained on).
   */
  _renegRx() {
    this._reneg.rxStarted = true;
    this._ppTaps = Float64Array.from(this._eq.w);
    this.p3 = this._newP3();
    this.p3.ppSolved = true;           // no PP in §11.6
    // The samples from just before S become a new burst's, as one after a silence
    // would be: mixed to baseband again from sample 0.
    const k0 = Math.max(this.rxBase, Math.floor(this._symPos(this.base, this.symIdx - RN_REWIND)) - Math.ceil(SPAN * SPS / 2));
    const off = k0 - this.rxBase, n = this.rxLen - off;
    const raw = this.rx.slice(off, off + n);
    this.rxOn = false; this.rxLow = 0;
    this._resetRx();
    while (this.rxCap < n + 1) this._growRx();
    for (let L = 0; L < n; L++) {
      const ci = carIdx(L), x = raw[L];
      this.rx[L] = x; this.rxI[L] = x * CAR_COS[ci] * 2; this.rxQ[L] = -x * CAR_SIN[ci] * 2;
    }
    this.rxLen = n;
    this.rxOn = true;
  }

  /**
   * §11.5: silence for 70 ms, then this modem's tone, and Phase 2 from §11.2.1.1.3
   * (call modem) or §11.2.1.2.3 (answer modem), the INFO0s already exchanged. The
   * initiating and responding clauses enter at the same step: the call modem's tone
   * B waits for tone A's reversal either way, and the answer modem's tone A for
   * tone B held 50 ms. Everything Phases 2 to 4 learnt is learnt again, the rate
   * included; bytes written meanwhile wait.
   */
  _beginRetrain(why) {
    this.retrains = (this.retrains || 0) + 1;
    this._retraining = true;
    this._reneg = null;
    this.emit('retrain', { why });
    // A byte part-sent is sent again; one already on the wire is the far end's to lose.
    if (this.txFrame && this.txFrame.length === 10) {
      let by = 0;
      for (let k = 0; k < 8; k++) by |= this.txFrame[1 + k] << k;
      this.txByteQ.unshift(by);
    }
    this.txState = 'idle';
    this._resetTxBurst();
    this._idleSamples = 0;
    this._connectQ = this._buildConnectScript(this.role).filter((st) => st.kind !== 'tone');
    this._p2Retrain = true;
    const was = this._p2;
    this._p2 = this._newP2();
    this._p2.peerInfo0 = was && was.peerInfo0;
    this._p2Started = false;
    this._rtw = null;
    // Phases 3 and 4 are received afresh: a new S, a new PP solve, a new MP.
    this.p3 = this._newP3();
    this._peerJ = 0; this._peerE = false; this._sGateTimedOut = false;
    this.peerMP = null; this.peerMPPrime = null; this._mpScan = 0;
    this._mpCap = null; this._mpBitsTx = null; this._mppBitsTx = null;
    this._ppTaps = null; this._ppFit = null; this._trkS = null;
    this.rxOn = false; this.rxLow = 0;
    this._resetRx();
    this._eqMeasured = null;
    // The canceller learns the echo again on the new Phase 3.
    this._ec.reset();
    this._ecSpan = { start: null, trnStart: null, searchFrom: null, trnEnd: null, end: null };
    this._ecState = 'before';
  }

  /**
   * A start-up recovery bound expired, and §11.3.2 / §11.4.2 answer it with a
   * retrain (§11.5.1.1, §11.5.2.1). Scheduled for the next block, not begun inside
   * the symbol being built. Only once Phase 2 has run (its INFO0s are what a
   * retrain keeps), and at most START_RETRAINS in a row; past that, and on an
   * instance running another Recommendation's Phase 2, the call proceeds as it did.
   */
  _startupTimeout(what) {
    if (this._pendingRetrain) return true;
    (this.startupTimeouts = this.startupTimeouts || []).push(what);
    if (this._noRetrain || !(this._p2 && this._p2.peerInfo0) || (this._startupRetrains || 0) >= START_RETRAINS) return false;
    if (!this._pendingRetrain) { this._startupRetrains = (this._startupRetrains || 0) + 1; this._pendingRetrain = `no ${what}`; }
    return true;
  }

  /** The far end's retrain tone, held RT_HELD (§11.5.1.2, §11.5.2.2), sample by sample. */
  _retrainWatch(x) {
    if (!this._rtw) this._rtw = retrainWatch(this.role === 'answer' ? P2.TONE_B_HZ : P2.TONE_A_HZ);
    return this._rtw(x);
  }

  describe() {
    if (this._p3Active) {
      const st = this._p3 && this._p3.stage;
      // The Phase 3 head (S, S̄, MD, PP, TRN) is one fixed-length burst with no
      // per-segment cursor, and the tail's stage field is already set while it
      // drains — so the queue depth, not the stage, is what tells them apart. It
      // reports as TRN: 512 of the head's 944 symbols, and the part a listener hears.
      if (this.txSyms.length >= this._p3HeadRemaining && this._p3HeadRemaining > 0) {
        return { phase: 3, signal: 'TRN' };
      }
      if (!st) return { phase: 3, signal: 'TRN' };
      return { phase: st.startsWith('p4-') ? 4 : 3, signal: st };
    }
    if (this.txMode === 'phase2') {
      const step = this._p2 && this._p2.steps && this._p2.steps[this._p2.step];
      return { phase: 2, signal: step ? step.name : null };
    }
    if (this.txMode === 'tone') return { phase: 1, signal: 'ANS' };
    // Deliberately NOT reporting data here. The QAM burst is live through the
    // gaps in Phase 3's signal-gated tail too, so deciding it from txMode put a
    // "data" between Ja and the S-hold on V.90's analogue modem. Only the
    // handshake knows the call is up, and it says so.
    return null;
  }

  /**
   * The silence before Phase 2's own, in ms: V.8's post-CJ silence when the
   * handshake hands this class the line at CJ so that its receiver hears the far
   * end's INFO0 from there (§11.2.1.1.1, §11.2.1.2.1). Before the first burst.
   */
  setLeadSilence(ms) { this._leadSilence = Math.round(ms * SR / 1000); }

  setPhase2Enabled(on) {
    this._phase2Enabled = !!on;
    if (!on) this._noRetrain = true;
    const hadTone = this._connectQ.some((s) => s.kind === 'tone');
    this._connectQ = this._buildConnectScript(this.role);
    if (!hadTone) this._connectQ = this._connectQ.filter((s) => s.kind !== 'tone');
  }

  /** Transmit Phase 2 and then nothing. See _buildConnectScript. */
  /**
   * Choose the scrambler polynomials by NAME rather than by role. Clause 7 gives
   * the call modem GPC and the answer modem GPA, which is what the constructor
   * picks; V.90 assigns them by modem type instead (§5.3/V.90: the digital modem
   * uses GPC; §6.5/V.90: the analogue modem uses GPA), and its analogue modem is
   * the CALLER, so role and polynomial disagree there.
   */
  setScramblers(tx, rx) {
    const TAP = { GPC: 17, GPA: 4 };   // x⁻¹⁸ and x⁻⁵, each with x⁻²³
    if (!(tx in TAP) || !(rx in TAP)) throw new Error(`setScramblers: ${tx}/${rx}`);
    this._txTap = TAP[tx];
    this._rxTap = TAP[rx];
  }

  setPhase2Only(on) {
    this._phase2Only = !!on;
    const hadTone = this._connectQ.some((s) => s.kind === 'tone');
    this._connectQ = this._buildConnectScript(this.role);
    if (!hadTone) this._connectQ = this._connectQ.filter((s) => s.kind !== 'tone');
  }

  setPhase3Lead(lead) {
    this._v90Lead = !!lead;
    const hadTone = this._connectQ.some((s) => s.kind === 'tone');
    this._connectQ = this._buildConnectScript(this.role);
    if (!hadTone) this._connectQ = this._connectQ.filter((s) => s.kind !== 'tone');
  }

  get carrierDetected() { return this.rxOn || this.acq; }
  get bps() { return this._rate; }

  /**
   * V.42 (vendor/src/ec): while a link is set, data-mode bits come from and go to
   * it — the error-control stack's synchronous stream — in place of start-stop
   * characters; null puts the characters back.
   */
  setBitLink(link) { this._link = link || null; }

  write(bytes) { for (const by of bytes) this.txByteQ.push(by & 0xff); }

  /** Payload bytes still queued for transmission. Transport flow control. */
  get txPending() { return this.txByteQ.length; }

  _scramble(bit) { const r = this.scr; const out = bit ^ r[this._txTap] ^ r[22]; r.unshift(out); r.pop(); return out; }

  /** Clause 7's scrambler again, on Phase 3's own register. */
  _scramble3(bit) { const r = this.scr3; const out = bit ^ r[this._txTap] ^ r[22]; r.unshift(out); r.pop(); return out; }

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
    this._p3Active = false;   // Phase 3's tail is driving the continuous path
    this.txFrameIdx = 0;      // mapping-frame counter for §8.2 switching, i = 0 at B1
  }

  /**
   * §11.3's and §11.4's two roles.
   *
   * The answer modem leads Phase 3 on a timer the Recommendation gives it (70 ± 5
   * ms, §11.3.1.2.1), repeats J until the call modem's S-to-S̄ transition and falls
   * silent (§11.3.1.2.4). Its Phase 4 is a second transmission, begun on the call
   * modem's J: S for 128T, S̄ for 16T, TRN, MP, MP′, E (§11.4.1.2.1). The call modem
   * is "initially silent" (§11.3.1.1.1) and transmits its Phase 3 only "after
   * receiving J" (§11.3.1.1.3) — `gate: 'j'` — then carries on without a break into
   * Phase 4: J until the answer modem's S followed by S̄, J′, TRN, MP, MP′, E
   * (§11.4.1.1). Each end's data mode follows its E in the same transmission, B1
   * first. Every gate is satisfied by the receiver, not by a sample count.
   */
  _buildConnectScript(role) {
    const p2 = this._phase2Enabled === false ? [] : [{ kind: 'phase2', gap: 0 }];
    // V.90's DIGITAL modem runs §9.2 through this class and then stops
    // transmitting: its Phase 3 is Sd and TRN1d on the PCM downstream, which is
    // V90.js's own generator and not a V.34 signal at all. Its RECEIVER carries on
    // — rxPhase is set by the arriving carrier and owes nothing to this script —
    // so the analogue modem's S, S̄ and Ja are still detected here.
    if (this._phase2Only) {
      return role === 'answer' ? [{ kind: 'tone', gap: 0 }, ...p2] : [...p2];
    }
    // V.90's analogue modem takes the answer modem's lead in Phase 3 (§9.3.2.1) but
    // its Phase 4 is §9.4.2's, which follows the terminating S̄ in the same
    // transmission; setPhase3Tail adds the §9.3.2.4 resume.
    if (this._v90Lead) {
      return [...p2, { kind: 'phase3', gap: ANS_PHASE3_SILENCE }];
    }
    if (role === 'answer') {
      return [
        { kind: 'tone',   gap: 0 },
        ...p2,
        { kind: 'phase3', gap: ANS_PHASE3_SILENCE },
        { kind: 'phase4', gap: 0, gate: 'j' },
      ];
    }
    return [
      ...p2,
      { kind: 'phase3', gap: 0, gate: 'j' },
    ];
  }

  /**
   * Phase 3 in §11.3's order: S, S̄, [MD, S, S̄], PP, TRN, J × n, J′.
   *
   * J′ sits at the tail because §11.4.1.1.1 is where it belongs — "the call modem
   * shall stop sending J sequences, ... transmit one J′ sequence, and then transmit
   * signal TRN" — so J′ is the handoff out of Phase 3 into the call modem's Phase 4.
   *
   * The scrambler is `scr3`, its own register. §10.1.3.8 requires it initialized to
   * zero before TRN specifically, and the data path resets `scr` when data begins;
   * sharing one register would make the data path's state depend on how many Phase
   * 3 symbols happened to be sent. Same split, for the same reason, as V90.js.
   */
  _buildPhase3() {
    // The first plain-V.34 Phase 3 is tagged for the echo canceller (EC_GUARD): 1
    // for S, S̄ and MD, 2 for PP and TRN. The answer modem's Phase 4 overlaps the
    // call modem's J, and V.90's analogue lead is another procedure.
    const ecTag = !this._ecTagged && !this._v90Lead && !this._p3Tail;
    this._ecTagged = true;
    let tag = ecTag ? 1 : 0;
    const push = (syms, g) => { for (const p of syms) this.txSyms.push(tag ? { i: p.i * g, q: p.q * g, cond: tag } : { i: p.i * g, q: p.q * g }); };
    // How many symbols the fixed head is. Instrumentation only — describe() uses
    // it to tell S/S̄/MD/PP/TRN from the signal-gated tail that follows, which
    // shares this queue and the same stage field.
    const headStart = this.txSyms.length;

    // §11.3.1.2.1 / §11.3.1.1.3 — S for 128T then S̄ for 16T.
    push(P3.buildS(), this._g.s);
    push(P3.buildSbar(), this._g.s);

    // §11.3.1.1.4 / §11.3.1.2.1 — MD, when its declared length is non-zero, then S
    // and S̄ again. MD_SYMBOLS is 0 here (§10.1.3.5); the branch is real.
    if (this._mdSymbols > 0) {
      push(this._buildMD(this._mdSymbols), this._g.s);
      push(P3.buildS(), this._g.s);
      push(P3.buildSbar(), this._g.s);
    }

    // §11.3.1.1.5 / §11.3.1.2.2 — PP, 288 symbols, equation (10-1). The answer
    // modem's canceller trains on it. The call modem's does not: the answer modem
    // stops its J only once it has heard our S̄, a round trip later, so the start of
    // our PP is under the far end's J. Training through that left 9.6 dB.
    if (ecTag && this.role === 'answer') tag = 2;
    push(P3.buildPP(), this._g.pp);
    if (ecTag) tag = 3;

    // §11.3.1.1.6 / §11.3.1.2.3 — TRN, four constellation points, ≥ 512T.
    this.scr3.fill(0);                                   // §10.1.3.8
    let lastTrn = null;
    for (let n = 0; n < TRN_SYMBOLS; n++) {
      lastTrn = P3.trnSymbol(() => this._scramble3(1));
      this.txSyms.push(tag ? { i: lastTrn.i * this._g.s, q: lastTrn.q * this._g.s, cond: tag } : { i: lastTrn.i * this._g.s, q: lastTrn.q * this._g.s });
    }

    // Everything up to here is fixed-length and can be built in one go. What
    // follows cannot: §11.3.1.2.4 repeats J "until" the far end's S̄, and V.90's
    // §9.3.2.4 repeats Ja until S̄d, so the tail's length is a SIGNAL and the
    // remaining symbols are produced one at a time by _p3Next().
    //
    // §10.1.3.3: the differential encoder "shall be initialized using the final
    // symbol of the transmitted TRN sequence".
    // Plain V.34's two parts: the answer modem's J ends Phase 3 for it (§11.3.1.2.4);
    // the call modem's J runs on into Phase 4 (§11.4.1.1.1).
    this._p3 = {
      enc: new P3.JEncoder(P3.rotationOf(lastTrn)),
      stage: this._p3Tail ? this._p3Tail.first : (this.role === 'answer' ? 'j-answer' : 'j'),
      bits: null, bitPos: 0, reps: 0, count: 0, done: false,
      jStart: null, mpReps: 0,
    };
    this._p3HeadRemaining = this.txSyms.length - headStart;
  }

  /**
   * One symbol of Phase 3's signal-gated tail, or null when the tail is finished.
   *
   * Plain V.34 runs the `j` / `jprime` stages and stops. V.90's analogue modem
   * replaces them through setPhase3Tail(): §8.3.1's Ja, then the S / S̄ / SCR
   * placement §9.3.2.7 to §9.3.2.10 defines. Both drive the same encoder and the
   * same scrambler, because §8.3.1 says Ja's modulation IS 10.1.3.3/V.34's and
   * §8.3.5 says SCR's differential encoder is not reinitialised.
   */
  _p3Next() {
    const p3 = this._p3;
    if (!p3 || p3.done) return null;
    const t = this._p3Tail;

    for (;;) {
      // A stage that is streaming bits emits the next symbol from them. Two bits per
      // 2D symbol interval, I1 first in time (§10.1.3.3).
      if (p3.bits && p3.bitPos < p3.bits.length) {
        const i1 = this._scramble3(p3.bits[p3.bitPos]);           // first in time
        const i2 = this._scramble3(p3.bits[p3.bitPos + 1]);
        if (p3.size16) {
          // §10.1.3.9's 16-point form: I1n, I2n, Q1n, Q2n; 2·Q2n + Q1n picks the point,
          // In = 2·I2n + I1n is differentially encoded and rotates it clockwise.
          const q1 = this._scramble3(p3.bits[p3.bitPos + 2]);
          const q2 = this._scramble3(p3.bits[p3.bitPos + 3]);
          p3.bitPos += 4;
          p3.z = (p3.z + ((i2 << 1) | i1)) & 3;
          const p = P3.rotCW(V34Phase4.MP16_POINTS[(q2 << 1) | q1], p3.z);
          return { i: p.i * this._g.p16, q: p.q * this._g.p16 };
        }
        p3.bitPos += 2;
        const p = p3.enc.symbol(i1, i2);
        return { i: p.i * this._g.s, q: p.q * this._g.s };
      }
      // A stage emitting a fixed run of symbols (S, S̄, one SCR symbol) counts down.
      if (p3.run && p3.count < p3.run.length) {
        const p = p3.run[p3.count++];
        return { i: p.i * this._g.s, q: p.q * this._g.s };
      }
      // Both cursors are cleared BEFORE advancing: a stage that re-arms the same bit
      // array (Ja repeats its descriptor) would otherwise re-enter with the cursor
      // still at the end and neither emit nor terminate.
      p3.bits = null; p3.bitPos = 0; p3.run = null; p3.count = 0;
      const next = this._p3Advance(p3, t);
      if (next === ENTER_DATA) { p3.done = true; return ENTER_DATA; }
      if (!next) { p3.done = true; return null; }
    }
  }

  /**
   * The tail's stage transitions. Returns false when the tail is over.
   *
   * Every gate here is a predicate the owner supplies, and each one names the
   * clause it implements. Where a gate's signal does not come, a recovery
   * deadline from the same clause ends the stage instead, because retrains are not
   * implemented.
   */
  _p3Advance(p3, t) {
    switch (p3.stage) {
      // ── Plain V.34, the answer modem: J until the call modem's S-to-S̄ ───────
      // §11.3.1.2.4: "After transmitting signal TRN, the modem shall send sequence J
      // and condition its receiver to detect signal S and the S-to-S̄ transition.
      // After detecting the S-to-S̄ transition, the modem shall transmit silence."
      case 'j-answer':
        if (p3.reps >= P4_SEQ_MIN_REPS &&
            (this.p3.sbarCount >= 1 || p3.reps >= this._jCap())) return false;
        p3.reps++; p3.bits = P3.jPattern(4); return true;

      // ── Plain V.34, the call modem: J until the answer modem's Phase 4 S ──────
      // §11.3.1.1.7: "After transmitting signal TRN, the modem shall send sequence J
      // and condition its receiver to detect signal S." §11.4.1.1.1: "After detecting
      // S followed by S̄, the call modem shall stop sending J sequences ..., transmit
      // one J′ sequence, and then transmit signal TRN." The answer modem's Phase 3
      // carried the first S-to-S̄ this receiver saw; its Phase 4 carries the second.
      case 'j':
        if (p3.reps >= P4_SEQ_MIN_REPS &&
            (this.p3.sbarCount >= 2 || p3.reps >= this._jCap())) {
          // §11.4.2.1.1: no S-to-S̄ within 600 ms plus a round trip is a retrain.
          if (this.p3.sbarCount < 2 && this._startupTimeout('Phase 4 S')) { p3.reps++; p3.bits = P3.jPattern(4); return true; }
          p3.stage = 'jprime'; return true;
        }
        p3.reps++; p3.bits = P3.jPattern(4); return true;
      case 'jprime':
        p3.bits = P3.jPrimePattern(); p3.stage = 'p4-trn'; return true;

      // ── Phase 4 (§11.4), on §10.1.3.9's own modulation ──────────────────────
      // MP used to be packed into bytes and carried by the DLE control channel on
      // the established link, which put a start-up sequence inside data mode. It is
      // the same bits; what moved is that they now ride the chain J rides — two
      // scrambled bits per 2D symbol interval, differentially encoded, which is
      // §10.1.3.9's 4-point form and is what this modem's J advertises.
      //
      // §11.4.1.1.1: "... transmit one J′ sequence, and then transmit signal TRN."
      // §10.1.3.9 initialises the differential encoder from that TRN's final symbol,
      // which is why the encoder is rebuilt here rather than carried over from J′.
      // §10.1.3.8: TRN, MP, MP′ and E go "in a 4- or 16-point 2D constellation
      // depending on the signal J" — the FAR end's J, which requests the size this
      // end is to transmit them in (§10.1.3.3). "The scrambler is initialized to zero
      // prior to transmission of the TRN signal."
      case 'p4-trn': {
        // §11.6: "all sent using a 4-point constellation during rate renegotiation".
        p3.size16 = this._peerJ === 16 && !p3.reneg;
        this.scr3.fill(0);
        const syms = new Array(P4_TRN_SYMBOLS);
        if (p3.size16) {
          // 16-point TRN: 2·Q2n + Q1n selects the point, In rotates it — and TRN is
          // NOT differentially encoded; MP's encoder starts from the final In.
          const k = this._g.p16 / this._g.s;      // _p3Next scales a run by this._g.s
          let lastI = 0;
          for (let n = 0; n < P4_TRN_SYMBOLS; n++) {
            const i1 = this._scramble3(1), i2 = this._scramble3(1);
            const q1 = this._scramble3(1), q2 = this._scramble3(1);
            lastI = (i2 << 1) | i1;
            const pt = P3.rotCW(V34Phase4.MP16_POINTS[(q2 << 1) | q1], lastI);
            syms[n] = { i: pt.i * k, q: pt.q * k };
          }
          p3.z = lastI;
        } else {
          let last = null;
          for (let n = 0; n < P4_TRN_SYMBOLS; n++) syms[n] = last = P3.trnSymbol(() => this._scramble3(1));
          p3.enc = new P3.JEncoder(P3.rotationOf(last));
        }
        p3.run = syms;
        p3.stage = 'p4-mp';
        p3.mpReps = 0;
        return true;
      }
      // §11.4.1.1.2 / §11.4.1.2.2: MP until the far end's MP has been received, then
      // MP′ — "MP sequences with the acknowledge bit set" — and §11.4.1.1.3 /
      // §11.4.1.2.3: MP′ until the far end's MP′ or E, then "a single 20-bit E
      // sequence". After E comes B1 and data mode (§11.4.1.1.4).
      case 'p4-mp':
        if (p3.mpReps >= P4_SEQ_MIN_REPS && (this.peerMP || p3.mpReps >= this._p4Cap(this._mpBits(false).length))) {
          // §11.4.2.1.2 / §11.4.2.2.2: no MP, so no E, within the bound is a retrain.
          if (!this.peerMP && this._startupTimeout('MP')) { p3.mpReps++; p3.bits = this._mpBits(false).slice(); return true; }
          p3.stage = 'p4-mpprime'; p3.mpReps = 0; return true;
        }
        p3.mpReps++; p3.bits = this._mpBits(false).slice(); return true;
      case 'p4-mpprime':
        if (p3.mpReps >= P4_SEQ_MIN_REPS &&
            (this.peerMPPrime || this._peerE || p3.mpReps >= this._p4Cap(this._mpBits(true).length))) {
          if (!(this.peerMPPrime || this._peerE) && this._startupTimeout('E')) { p3.mpReps++; p3.bits = this._mpBits(true).slice(); return true; }
          p3.stage = 'p4-e'; return true;
        }
        p3.mpReps++; p3.bits = this._mpBits(true).slice(); return true;
      case 'p4-e':
        p3.bits = V34Phase4.eBits(); p3.stage = 'b1'; return true;
      case 'b1':
        return ENTER_DATA;

      // ── V.90 analogue modem, §9.4.2 ─────────────────────────────────────────
      // §8.5.2 points CP at §10.1.3.9/V.34, so CP is this same chain carrying Table
      // 14/V.90's bits instead of Table 20/V.34's. §9.4.2.1 sends CPt until the
      // digital modem's R-to-R̄i transition, and §8.6.4's NOTE is why that gate is a
      // POLARITY CHANGE rather than a sign pattern: R̄ inverts R at every position.
      case 'p4-cpt':
        if (this._p4.rbarSeen()) { p3.stage = 'p4-cp'; p3.mpReps = 0; return true; }
        p3.bits = this._p4.cptBits(); return true;
      // §9.4.2.3 — CP "after receiving the digital modem's MP sequence"; §9.4.2.4 —
      // CP′ until an MP′ or an Ed comes back, then §8.5.3's E. Both are the far end's
      // signals, with the cap behind them so a lost sequence degrades to a connect.
      case 'p4-cp':
        if (p3.mpReps >= P4_SEQ_MIN_REPS &&
            (this._p4.mpSeen() || p3.mpReps >= P4_MP_MAX_REPS)) {
          p3.stage = 'p4-cpprime'; p3.mpReps = 0; return true;
        }
        p3.mpReps++; p3.bits = this._p4.cpBits(false); return true;
      case 'p4-cpprime':
        if (p3.mpReps >= P4_SEQ_MIN_REPS &&
            (this._p4.mpDone() || p3.mpReps >= P4_MP_MAX_REPS)) { p3.stage = 'p4-e'; return true; }
        p3.mpReps++; p3.bits = this._p4.cpBits(true); return true;

      // ── V.90 analogue modem (§9.3.2) ────────────────────────────────────────
      // §8.3.1: "Sequence Ja consists of repetitions of the DIL descriptor...
      // Transmission of sequence Ja may be terminated without completing the final
      // DIL descriptor." §9.3.2.4 terminates it on the Sd-to-S̄d transition.
      case 'ja':
        if (t.sbarD()) { p3.stage = 'ja-silence'; return true; }
        p3.bits = t.jaBits; return true;

      // §9.3.2.4: "After detecting the Sd-to-S̄d transition, the analogue modem
      // shall terminate Ja and transmit silence." The burst ends here and the
      // owner restarts Phase 3 at the 's-hold' stage once Jd has been received —
      // silence inside a continuous burst would be a gap the far end reads as the
      // end of the signal, which on this transport it is.
      case 'ja-silence':
        return false;

      // §9.3.2.7: "After receiving Jd ... shall then begin transmitting signal S
      // and condition its receiver to detect J′d." Open-ended: S until J′d.
      case 's-hold':
        if (t.jprimeD()) { p3.stage = 'sbar-after-jprime'; return true; }
        p3.run = P3.buildS(P3.S_SYMBOLS); return true;

      // §9.3.2.8: "After detecting J′d, the analogue modem shall transmit S̄ for
      // 16T." Then DIL is received, or Phase 4 if none was requested.
      case 'sbar-after-jprime':
        p3.run = P3.buildSbar();
        p3.stage = t.dilRequested ? 'scr' : 'end';
        return true;

      // §9.3.2.9: "During the reception of DIL the analogue modem shall transmit
      // either silence or SCR at its discretion." SCR is taken — the NOTE under
      // §8.3.1 recommends it ("to maintain line energy"), and silence here would
      // drop the far end's carrier detect on a link whose only energy is ours.
      case 'scr':
        if (t.dilDone()) { p3.stage = 's-terminate'; return true; }
        p3.run = [P3.scrSymbol((b) => this._scramble3(b), p3.enc)];
        return true;

      // §9.3.2.10: "the analogue modem shall again transmit signal S for 128T
      // followed by S̄ for 16T. This indicates to the digital modem that the
      // analogue modem has received enough of the DIL sequence."
      case 's-terminate':
        p3.run = P3.buildS(); p3.stage = 'sbar-terminate'; return true;
      // §9.4.2.1 — Phase 4 follows the terminating S̄ directly; there is no TRN
      // between them, so CP's differential encoder carries on from Phase 3's, which
      // is what §8.3.5 already does for SCR.
      case 'sbar-terminate':
        p3.run = P3.buildSbar(); p3.stage = this._p4 ? 'p4-cpt' : 'end'; return true;

      default:
        return false;
    }
  }

  /** The round trip Phase 2 measured, in seconds; 0 before it has. */
  _rtdS() { return (this.rtdSamples || 0) / SR; }

  /** J repetitions that fit in §11.4.2.1.1's deadline: 600 ms plus a round trip. */
  _jCap() { return Math.ceil((J_DEADLINE_S + this._rtdS()) * BAUD / (P3.J_BITS / 2)); }

  /**
   * Repetitions of a Phase 4 sequence of `bits` bits that fit in §11.4.2's deadline
   * for E — 2500 ms plus the round trips — at the size this end is transmitting.
   */
  _p4Cap(bits) {
    const perSym = this._p3 && this._p3.size16 ? 4 : 2;
    return Math.ceil((P4_DEADLINE_S + 3 * this._rtdS()) * BAUD / (bits / perSym));
  }

  /**
   * V.90's analogue modem replaces V.34's J tail with §8.3.1's Ja and the S / S̄ /
   * SCR placement of §9.3.2.7 to §9.3.2.10. `first` names the stage a (re)started
   * Phase 3 burst begins its tail at, because §9.3.2.4's silence genuinely divides
   * the analogue modem's Phase 3 into two transmissions.
   */
  setPhase3Tail(tail) {
    this._p3Tail = tail;
    if (!tail || !tail.resumeAt) return;
    // §9.3.2.4's silence is a real division of the analogue modem's Phase 3, so it
    // is a real division of its connect script: Ja's burst, then §9.3.2.7's, which
    // waits on Jd having been received rather than on a sample count.
    this._p3Resume = tail.resumeAt;
    const at = this._connectQ.findIndex((s) => s.kind === 'phase3');
    if (at < 0) return;
    this._connectQ.splice(at + 1, 0, { kind: 'phase3-resume', gap: 0, gate: 'jd' });
  }

  /**
   * V.90's analogue modem replaces V.34's Phase 4 with §9.4.2's: CPt until the
   * digital modem's R-to-R̄i transition, then CP, CP′ and E. §8.5.2 gives them
   * §10.1.3.9/V.34's modulation, so they run on the same stage machine and the same
   * encoder; only the bits differ. Setting this also silences this class's own MP
   * hunt, because nothing upstream of an analogue modem sends V.34 MP.
   */
  setPhase4(spec) { this._p4 = spec; }

  /**
   * V.90's digital modem (§9.6.1.2.1): its upstream receiver watches data mode for
   * the analogue modem's S, as §11.6's does, and takes S, S̄ and CP into the Phase 4
   * bit stream the digital modem reads CP from. V.90's retrain is §9's, so none of
   * §11.5's watches come with it, and V.90 keeps its own timeouts.
   */
  setRenegInData(on) { this._renegInData = !!on; }

  /**
   * V.90's analogue modem in a rate renegotiation (§9.6.2.1.1–.3, §9.6.2.2.2): S for
   * 128T and S̄ for 16T inside the data burst, then CP, CP′ and E as Phase 4's are
   * (setPhase4), and B1 and data at the rate the digital modem's MP asks for.
   */
  sendRenegV90() {
    if (this.txFrame && this.txFrame.length === 10) {
      let by = 0;
      for (let k = 0; k < 8; k++) by |= this.txFrame[1 + k] << k;
      this.txByteQ.unshift(by);
    }
    this.txFrame = null; this.txWarmup = 0;
    // No TRN comes between S̄ and CP here, so CP's differential encoder starts from
    // the last S̄ symbol; the far end's decoder works on differences either way.
    const sbar = P3.buildSbar();
    this._p3 = {
      enc: new P3.JEncoder(P3.rotationOf(sbar[sbar.length - 1])), stage: 'p4-cp', bits: null, bitPos: 0,
      reps: 0, count: 0, done: false, run: [...P3.buildS(), ...sbar], jStart: null, mpReps: 0, reneg: true,
    };
    this._p3HeadRemaining = 0;
    this._p3Active = true;
  }

  /**
   * §10.1.3.5's MD. Its content is by definition manufacturer-defined, so what it
   * carries is this implementation's choice and only its LENGTH is on the wire in
   * INFO1. Scrambled ones through the Phase 3 scrambler, mapped exactly as TRN is,
   * makes it a signal a far end can train an echo canceller on — which is what the
   * clause says MD is for — without inventing a structure the Recommendation would
   * have specified if it wanted one.
   */
  _buildMD(count) {
    const out = new Array(count);
    for (let n = 0; n < count; n++) out[n] = P3.trnSymbol(() => this._scramble3(1));
    return out;
  }


  // ─── Phase 2 (§11.2) ───────────────────────────────────────────────────────
  /**
   * §11.2's procedure as an ordered list of steps. Each emits one signal and ends
   * on a duration, on a SIGNAL, or on both — which is the shape of every clause in
   * §11.2.1: the fixed intervals are the 40 ms turnarounds and the 10 ms tails,
   * and everything else waits for what the peer sends.
   *
   * Reading the clauses rather than Figure 16, per CLAUDE.md's rule and
   * PROTOIMPROVE.md's: Figure 16 interleaves the two modems' rows and its duration
   * marks do not attach to a signal.
   *
   * §11.2.1.1 — call modem                    §11.2.1.2 — answer modem
   *   silence 75 ms                             silence 75 ms
   *   INFO0c (bit 28 = 0)                       INFO0a (bit 28 = 0)
   *   tone B, until A's 1st reversal            tone A, ≥50 ms and until INFO0c + B
   *   +40 ms, reverse B, +10 ms, silence        1st A reversal, until B's reversal
   *   until A's 2nd reversal → RTDEc            → RTDEa, +40 ms, 2nd A reversal, +10 ms
   *   receive L1, L2                            transmit L1, L2 until B
   *   tone B, until A's 3rd reversal            tone A 50 ms, 3rd reversal, +10 ms
   *   +40 ms, reverse B, +10 ms                 silence until B's 2nd reversal
   *   transmit L1, L2 until A                   receive L1, L2
   *   INFO1c                                    tone A, until INFO1c
   *   silence, until INFO1a → Phase 3           INFO1a → Phase 3
   *
   * The one transport difference, stated rather than absorbed: §11.2.1.1.7 and
   * §11.2.1.2.6 end L2 on "the local echo of L2", which a 4-wire-equivalent link
   * does not produce. The peer's tone is what ends it here, with §10.1.2.4's
   * 550 ms capping what is transmitted and §11.2.2's bound behind that — the same
   * instant as on a line whose echo canceller has converged.
   *
   * Every step that can wait carries §11.2.2's own bound and, now, its own action:
   * `recover` for what an expiry does and `interrupt` for what an arriving signal
   * does. Recovery-only steps sit at the end of each list, are reached by a `goto`,
   * and are stepped over by the error-free procedure.
   */
  _buildPhase2() {
    const p2 = this._p2;
    // Every reversal this modem sends, timed. §11.2.1.1.4 and §11.2.1.2.4 measure
    // the round trip from one of these to the peer's answering reversal.
    const rev = () => { p2.txPhase += Math.PI; p2.txRevAt.push(p2.tn); };
    // §11.2.2.1.1 / §11.2.2.2.1, which are the same clause with the roles swapped:
    // a modem that detects the peer's tone without having received its INFO0, or
    // that receives the peer's INFO0 again, repeatedly sends its own. `lostInfo0`
    // is the first half and `staleInfo0` the second — "again" only counts while the
    // repetition still has bit 28 clear, because a peer that has acknowledged is
    // not asking for anything.
    // "After Tone B is detected", "if the modem detects Tone A" — a TONE, which is
    // not the same question as whether the peer's carrier is present. During an
    // INFO sequence the carrier is up and flipping, and between two repetitions of
    // one it is briefly steady; a step that advances on presence alone can leave
    // §11.2.1.2.3 on a few milliseconds of that. Measured, exactly this: a modem
    // sent its Tone A reversal into a peer that was mid-recovery and went straight
    // back to INFO0, the reversal was not counted because that step is not
    // conditioned to count one, and the peer then sat in an UNBOUNDED wait
    // (§11.2.2.1.2, §9.2.1.2.2) until the other end's 2000 ms bound broke it. The
    // flip-density discriminator already distinguishes the two; this is it, used
    // for the question it was built to answer.
    const toneSeen = () => p2.toneOn && !p2.modulated;
    const lostInfo0 = (past) => !p2.peerInfo0 && toneSeen() && past >= P2_INFO0_LEN;
    const staleInfo0 = () => p2.info0Repeats > 0 && p2.peerInfo0 && !p2.peerInfo0.ackInfo0;
    // Both clauses' exit: INFO0 received with bit 28 set, or INFO0 received and the
    // peer's tone detected. Either way "complete sending the current INFO0
    // sequence" — which is honoured by testing this only at a sequence boundary.
    const info0Done = () => !!p2.peerInfo0 && (!!p2.peerInfo0.ackInfo0 || toneSeen());
    const prof = this._p2Profile;
    if (prof.part === 'toneA') {
      return [
        { name: 'silence', emit: 'silence', dur: P2_SILENCE },
        { id: 'INFO0a', name: 'INFO0a', emit: 'info', bits: () => prof.info0() },
        // §11.2.1.2.3 — "After Tone B is detected and Tone A has been transmitted
        // for at least 50 ms".
        { id: 'A', name: 'A', emit: 'tone', min: P2_TONE_MIN, until: () => p2.peerInfo0 && toneSeen(),
          interrupt: (past) => (lostInfo0(past) || staleInfo0()) ? { goto: 'INFO0a×' } : null },
        // §11.2.1.2.3/.4 — the reversal, then wait for the peer's; RTDEa is the
        // interval between them less the 40 ms the peer holds off.
        // §11.2.1.2.4 — "the time interval between sending the Tone A phase
        // reversal at the line terminals and receiving the Tone B phase reversal at
        // the line terminals minus 40 ms". Both instants are recorded, so this is a
        // real measurement rather than a placeholder: on a link with no propagation
        // delay it correctly comes out at zero.
        // §11.2.2.2.2 — "condition its receiver to detect Tone B and then proceed
        // according to 11.2.1.2.3", which is the step above: tone A again, and a
        // fresh reversal once tone B is back. The reversal bookkeeping goes with
        // it — RTDEa is measured from the reversal actually sent, not the abandoned
        // one — which is what `resetRev` is.
        { id: 'Ā', name: 'Ā', emit: 'tone', onEnter: rev, countRev: true, until: () => p2.peerRev >= 1,
          bound: () => P2_BOUND_REV2,                                  // §11.2.2.2.2
          recover: () => ({ goto: 'A', resetRev: true }),
          interrupt: (past) => (lostInfo0(past) || staleInfo0())
            ? { goto: 'INFO0a×', resetRev: true } : null,              // §11.2.2.2.1
          onExit: () => { p2.rtd = Math.max(0, (p2.revAt[0] - p2.txRevAt[0]) - P2_TURNAROUND); } },
        // §11.2.1.2.5 — delayed so the reversal appears 40 ms after receiving the
        // peer's, then 10 ms more of tone.
        { name: 'A(40)', emit: 'tone', durFrom: () => p2.revAt[p2.revAt.length - 1] },
        { name: 'Ā(10)', emit: 'tone', onEnter: rev, dur: P2_AFTER_REVERSAL },
        { name: 'L1', emit: 'probe', level: P2.LEVEL.L1, dur: P2_L1 },
        // §11.2.2.2.3 — the wait for tone B outlives the probe: L2 stops at
        // §10.1.2.4's 550 ms and the step goes on listening in silence until
        // 600 ms plus a round trip, then goes back to §11.2.1.2.3.
        { name: 'L2', emit: 'probe', level: P2.LEVEL.L2, dur: P2_L2, until: () => toneSeen(),
          emitMax: P2_L2_MAX, bound: () => P2_BOUND_L2_ANS + p2.rtd,
          recover: () => ({ goto: 'A', resetRev: true }) },
        // §11.2.1.2.6 — tone A for 50 ms, a reversal, 10 ms more, then silence.
        { name: 'A(50)', emit: 'tone', dur: P2_TONE_MIN },
        { name: 'Ā(10)', emit: 'tone', onEnter: rev, dur: P2_AFTER_REVERSAL },
        // No clause bounds this one; §11.2.2.2.2's 2000 ms is the nearest stated
        // analogue and is what is used, rather than a number of this file's own.
        { name: 'wait B̄', emit: 'silence', countRev: true, until: () => p2.peerRev >= 2,
          bound: () => P2_BOUND_REV2 },
        // §11.2.1.2.7/.8 — receive L1 and L2, then tone A until INFO1c arrives.
        { name: 'rx L1/L2', emit: 'silence', dur: P2_L1, until: () => p2.probeEnded, max: P2_RX_PROBE },
        { name: 'A', emit: 'tone', until: () => p2.peerInfo1,
          bound: () => P2_BOUND_INFO1C + 2 * p2.rtd,                    // §11.2.2.2.4
          // §11.2.2.2.4 offers a retrain or INFOMARKSa. §11.5 does not exist here,
          // so the alternative is taken — and it is the half that pairs with the
          // call modem's §11.2.2.1.6, which answers INFOMARKSa by resending INFO1c.
          recover: () => ({ goto: 'INFOMARKSa' }) },
        { id: 'INFO1a', name: 'INFO1a', emit: 'info', bits: () => prof.info1() },
        // ── recovery-only steps: reached by a `goto` and skipped by the procedure ──
        // §11.2.2.2.1 — "the modem shall repeatedly send INFO0a", back to back
        // rather than alternating with the tone, and each one carries bit 28 as it
        // stands when that sequence begins.
        { id: 'INFO0a×', name: 'INFO0a×', recovery: true, next: 'A',
        // Entering the recovery CONSUMES the request that triggered it. Without
        // that, `info0Repeats` is a count that only ever rises: the step exits at
        // its sequence boundary, the interrupt sees the same old count and sends it
        // straight back, and the two ends spend the whole of §11.2.1.2.3 doing
        // 83 ms laps until the recovery cap stops them. A repetition that arrives
        // while this step is running re-arms it, which is the peer still asking.
        onEnter: () => { p2.info0Repeats = 0; },
          emit: 'info', bits: () => prof.info0(), repeatUntil: info0Done },
        // §11.2.2.2.4 — "send INFOMARKSa until it receives INFO1c or detects
        // Tone B". On INFO1c it proceeds per §11.2.1.2.9, which is INFO1a; on Tone B,
        // §11.5.2.2: the call modem is retraining, and this one answers.
        { id: 'INFOMARKSa', name: 'INFOMARKSa', recovery: true, next: 'INFO1a',
          emit: 'info', bits: () => P2.infomarks(P2_MARKS_RUN),
          repeatUntil: () => !!p2.peerInfo1 || toneSeen(),
          // Tone B instead of INFO1c is the call modem retraining (§11.5.2.2).
          interrupt: () => (!p2.peerInfo1 && toneSeen() && this._startupTimeout('INFO1c') ? { stay: true } : null) },
      ];
    }
    return [
      { name: 'silence', emit: 'silence', dur: P2_SILENCE },
      { id: 'INFO0c', name: 'INFO0c', emit: 'info', bits: () => prof.info0() },
      // §11.2.1.1.2/.3 — after INFO0a, detect tone A and its reversal.
      // §11.2.2.1.2: "continue transmitting Tone B until it does detect a Tone A
      // phase reversal" — no bound, so only the backstop applies. §11.2.2.1.1 is
      // the other thing that can be wrong here and is the one that fires: tone A
      // is up and INFO0a never decoded, which this step alone could wait out for
      // ever because its `until` needs both.
      { id: 'B', name: 'B', emit: 'tone', countRev: true, until: () => p2.peerInfo0 && p2.peerRev >= 1,
        interrupt: (past) => (lostInfo0(past) || staleInfo0()) ? { goto: 'INFO0c×' } : null },
      { name: 'B(40)', emit: 'tone', durFrom: () => p2.revAt[p2.revAt.length - 1] },
      { name: 'B̄(10)', emit: 'tone', onEnter: rev, dur: P2_AFTER_REVERSAL },
      // §11.2.1.1.4 — RTDEc is measured from this modem's own reversal to the
      // peer's second, less the 40 ms the peer holds off.
      // §11.2.1.1.4 — "the time interval between the appearance of the Tone B phase
      // reversal at the modem line terminals and receiving the second Tone A phase
      // reversal at the line terminals minus 40 ms".
      // §11.2.2.1.3 — "transmit silence and condition its receiver to detect
      // Tone A. After detecting Tone A ... transmit Tone B ... and proceed in
      // accordance with 11.2.1.1.3", which is the detour below and then step B.
      { name: 'wait Ā2', emit: 'silence', countRev: true, until: () => p2.peerRev >= 2,
        bound: () => P2_BOUND_REV2,                                    // §11.2.2.1.3
        recover: () => ({ goto: 'rx A', resetRev: true }),
        onExit: () => { p2.rtd = Math.max(0, (p2.revAt[1] - p2.txRevAt[0]) - P2_TURNAROUND); } },
      { name: 'rx L1/L2', emit: 'silence', dur: P2_L1, until: () => p2.probeEnded, max: P2_RX_PROBE },
      // §11.2.2.1.4 — on expiry "the modem waits 40 ms, then transmits a Tone B
      // phase reversal", which is the next two steps unchanged. The one thing that
      // must not happen is B(40) computing its 40 ms from the last reversal it saw:
      // there was none, that is why this fired, and the arithmetic would give it
      // nothing. `fullTurnaround` is the clause's flat 40 ms.
      { name: 'B', emit: 'tone', countRev: true, until: () => p2.peerRev >= 3,
        bound: () => P2_BOUND_REV3 + p2.rtd,                           // §11.2.2.1.4
        recover: () => ({ goto: 'B(40) after L1/L2', fullTurnaround: true }) },
      { id: 'B(40) after L1/L2', name: 'B(40)', emit: 'tone',
        durFrom: () => p2.revAt[p2.revAt.length - 1] },
      { name: 'B̄(10)', emit: 'tone', onEnter: rev, dur: P2_AFTER_REVERSAL },
      { name: 'L1', emit: 'probe', level: P2.LEVEL.L1, dur: P2_L1 },
      // §11.2.2.1.5: no tone A within 650 ms plus a round trip of L2's start is a
      // retrain per §11.5.1.1.
      { name: 'L2', emit: 'probe', level: P2.LEVEL.L2, dur: P2_L2, until: () => toneSeen(),
        emitMax: P2_L2_MAX, bound: () => P2_BOUND_L2_CALL + p2.rtd,
        recover: () => (this._startupTimeout('tone A after L2') ? { stay: true } : null) },
      { id: 'INFO1c', name: 'INFO1c', emit: 'info', bits: () => prof.info1() },
      // §11.2.2.1.6 — "condition its receiver to detect either Tone A or
      // INFOMARKSa. Upon detection of INFOMARKSa, the call modem shall either
      // initiate a retrain ... or send INFO1c and proceed in accordance with
      // 11.2.1.1.8." The second alternative is taken, and it is what closes the
      // loop with the answer modem's §11.2.2.2.4. Upon Tone A the clause asks for a
      // retrain response (§11.5.1.2) and there is none, so that case advances.
      { name: 'wait INFO1a', emit: 'silence', until: () => p2.peerInfo1,
        bound: () => P2_BOUND_INFO1A + p2.rtd,                         // §11.2.2.1.6
        recover: () => (p2.peerMarks ? { goto: 'INFO1c' }
          : this._startupTimeout('INFO1a') ? { stay: true } : null) },
      // ── recovery-only steps ────────────────────────────────────────────────
      // §11.2.2.1.1 — "the call modem shall repeatedly send INFO0c sequences".
      { id: 'INFO0c×', name: 'INFO0c×', recovery: true, next: 'B',
        // Entering the recovery CONSUMES the request that triggered it. Without
        // that, `info0Repeats` is a count that only ever rises: the step exits at
        // its sequence boundary, the interrupt sees the same old count and sends it
        // straight back, and the two ends spend the whole of §11.2.1.1.3 doing
        // 83 ms laps until the recovery cap stops them. A repetition that arrives
        // while this step is running re-arms it, which is the peer still asking.
        onEnter: () => { p2.info0Repeats = 0; },
        emit: 'info', bits: () => prof.info0(), repeatUntil: info0Done },
      // §11.2.2.1.3's first half: silence, listening for tone A, before returning
      // to §11.2.1.1.3.
      { id: 'rx A', name: 'rx A', recovery: true, next: 'B',
        emit: 'silence', until: () => toneSeen() },
    ];
  }

  /**
   * The step list, with the one structural property a `goto` depends on checked.
   *
   * Steps are addressed by `id` because `name` is not unique — the call modem
   * transmits Tone B at §11.2.1.1.3 and again at §11.2.1.1.6 and both are "B",
   * which is what `phase2TimedOut` should say. A duplicate `id` would make a
   * recovery land on whichever came first, which is a cycle rather than an error.
   */
  _phase2Steps() {
    const steps = this._buildPhase2();
    const seen = new Set();
    for (const s of steps) {
      if (!s.id) continue;
      if (seen.has(s.id)) throw new Error(`V34 Phase 2: duplicate step id "${s.id}"`);
      seen.add(s.id);
    }
    for (const s of steps) {
      if (s.next && !steps.some((t) => t.id === s.next)) {
        throw new Error(`V34 Phase 2: step "${s.name}" continues at missing "${s.next}"`);
      }
    }
    return steps;
  }

  /**
   * Table 14/V.34's INFO0, filled from what this build can actually run.
   *
   * Every capability bit is the truth about this modem rather than a maximal
   * advertisement: the rate bits name the symbol rates V34Mapper has configs for,
   * and the carrier bits name the ones RF has front-ends for. Bit 28 is 0 because
   * §11.2.1.1.1 and §11.2.1.2.1 both say so for the error-free procedure.
   */
  _info0Bits() {
    const have = new Set(Object.values(CONFIGS).map((c) => c.sRate).filter((r) => r <= this._symCeil));
    return P2.buildInfo(P2.INFO0, {
      rate2743: have.has(2743) ? 1 : 0,
      rate2800: have.has(2800) ? 1 : 0,
      rate3429: have.has(3429) ? 1 : 0,
      // Which of Table 2's two carriers this build can run, per rate. RF names one
      // per symbol rate and 3200's is the HIGH one ((d/e) = 3/5, 1920 Hz) — this
      // declared the low one while transmitting the high, which costs nothing on a
      // link where both ends read the same table and is a 91 Hz disagreement with
      // a modem that believes it.
      lowCarrier3000: 0, highCarrier3000: 0,     // no 3000 front-end in RF
      lowCarrier3200: (have.has(3200) && !RF[3200].high) ? 1 : 0,
      highCarrier3200: (have.has(3200) && RF[3200].high) ? 1 : 0,
      allow3429: have.has(3429) ? 1 : 0,
      canReducePower: 0,                 // no transmit level control on this link
      maxRateDifference: 0,              // symmetric: both directions run one rate
      cme: 0,
      support1664: 1,                    // V34Mapper's largest config is 1664 points
      txClockSource: 0,                  // internal
      // §11.2.1.1.1 / §11.2.1.2.1 send the first one with bit 28 clear, and the
      // NOTEs under §11.2.2.1.6 and §11.2.2.2.4 set it "after correctly receiving"
      // the peer's INFO0 — so it is read off the receiver rather than fixed. This
      // is what ends a §11.2.2.1.1 / §11.2.2.2.1 repetition: the peer stops asking
      // when it sees the acknowledgement, which is why the two ends cannot sit
      // repeating INFO0 at each other.
      ackInfo0: this._p2 && this._p2.peerInfo0 ? 1 : 0,
    });
  }

  /**
   * Table 15/V.34's INFO1c — the call modem's probing results.
   *
   * The probing RESULTS are not measured, and that is the honest half of this item:
   * this transport has no amplitude distortion, no group delay and no noise, so an
   * analysis of L1 and L2 would report a flat channel. Each rate the modem has a
   * config for is therefore projected at the data rate that config actually
   * achieves, and every rate it has no config for is reported as 0, which Table 15
   * defines as "the symbol rate cannot be used". A later interop receiver replaces
   * these numbers with measurements behind a transmitter that is already the
   * Recommendation's.
   */
  _info1cBits() {
    const values = {
      minPowerReduction: 0, additionalPowerReduction: 0,
      mdLength: 0,                       // §10.1.3.5: no manufacturer-defined signal
      frequencyOffset: 0,                // measured: this link has none
    };
    // Table 15: a maximum of 0 is "cannot be used", which is how a symbol rate above
    // the configured one is withheld; below it, the ladder's top within the ceiling.
    const byRate = new Map();
    for (const c of Object.values(RATE_CONFIGS)) {
      if (c.sRate > this._symCeil || c.bitRate > this._configuredRate) continue;
      const steps = Math.min(14, Math.round(c.bitRate / 2400));
      byRate.set(c.sRate, Math.max(byRate.get(c.sRate) || 0, steps));
    }
    for (const r of P2.INFO1C_RATES) {
      // §5.3 offers two carriers per symbol rate; RF picks one and this says which.
      values[`highCarrier${r}`] = (RF[r] && RF[r].high) ? 1 : 0;
      values[`preEmphasis${r}`] = 0;     // Tables 3 and 4 index 0: no pre-emphasis
      values[`maxDataRate${r}`] = byRate.get(r) || 0;
    }
    this._p2.myMdLength = values.mdLength;
    return P2.buildInfo(P2.INFO1C, values);
  }

  /**
   * Table 16/V.34's INFO1a — the answer modem's selection.
   *
   * §11.2.1.2.9 sends this after INFO1c, so the choice is made from what the peer
   * projected AND what this modem can run. Both directions get the same symbol
   * rate: this link is symmetric, which is also why INFO0's maxRateDifference is 0.
   */
  _info1aBits() {
    const peer = this._p2.peerInfo1 || {};
    const mine = new Map();
    for (const c of Object.values(CONFIGS)) if (c.sRate <= this._symCeil) mine.set(c.sRate, true);
    let chosen = CFG.sRate;
    for (let k = P2.SYMBOL_RATES.length - 1; k >= 0; k--) {
      const r = P2.SYMBOL_RATES[k];
      if (mine.has(r) && (peer[`maxDataRate${r}`] || 0) > 0) { chosen = r; break; }
    }
    this._p2.chosenRate = chosen;
    this._p2.myMdLength = 0;             // §10.1.3.5, as INFO1c
    const idx = P2.SYMBOL_RATES.indexOf(chosen);
    const best = Object.values(RATE_CONFIGS).filter((c) => c.sRate === chosen && c.bitRate <= this._configuredRate)
      .reduce((a, c) => Math.max(a, Math.round(c.bitRate / 2400)), 0);
    return P2.buildInfo(P2.INFO1A, {
      minPowerReduction: 0, additionalPowerReduction: 0,
      mdLength: 0,
      // Table 16: the carrier the call modem is to use, which has to be the one
      // this end's front end demodulates. 0 named the low carrier at 3200 (1829 Hz)
      // while RF runs the high (1920 Hz); at 3429 Table 2's two are one.
      highCarrier: RF[chosen] && RF[chosen].high ? 1 : 0,
      preEmphasis: 0,
      maxDataRate: Math.min(14, best),
      answerToCallSymbolRate: idx,
      callToAnswerSymbolRate: idx,
      frequencyOffset: 0,
    });
  }

  /** Fresh Phase 2 state, transmit and receive. */
  _newP2() {
    const peerTone = this._p2Profile.part === 'toneA' ? P2.TONE_B_HZ : P2.TONE_A_HZ;
    return {
      // transmit
      step: 0, steps: null, inStep: 0, txPhase: 0, guardPhase: 0, probeIdx: 0,
      infoPhases: null, infoPos: 0, dpskPhase: 0, entered: false,
      // receive: the peer's tone, its reversals, its INFO, and the probe
      peerTone,
      toneOn: false, refI: 0, refQ: 0, haveRef: false,
      pend: null, pendN: 0, pendAt: 0, lowRuns: 0,
      prev: null, modRing: new Array(P2_MOD_WINDOW).fill(0), modAt: 0, modSum: 0,
      modulated: false,
      peerRev: 0, revAt: [], txRevAt: [],
      // The peer's INFO0/INFO1, how many times each has arrived AGAIN — which is
      // §11.2.2.1.1's and §11.2.2.2.1's "receives repeated INFO0x sequences" — and
      // whether INFOMARKS has been heard (§11.2.2.1.6).
      peerInfo0: null, peerInfo1: null, info0Repeats: 0, info1Repeats: 0,
      peerMarks: false, recoveries: 0, forceTurnaround: false,
      pacc: [0, 0], tacc: [0, 0], paccN: 0,
      info: Array.from({ length: P2_INFO_PHASES }, (_, k) => ({
        acc: [0, 0], n: Math.round(k * P2_BIT / P2_INFO_PHASES),
        refI: 0, refQ: 0, haveRef: false, bits: [],
      })), wantRev: false,
      probeOn: false, probeEnded: false, probeSeen: 0,
      rtd: 0, chosenRate: null, n: 0, tn: 0, timedOut: [],
    };
  }

  /**
   * One block of Phase 2 transmit. Returns true while Phase 2 owns the audio.
   *
   * The carrier phase accumulates across steps rather than restarting per step:
   * a reversal is defined as a 180° change in a CONTINUING tone (§10.1.2.1), so a
   * step boundary that reset the phase would manufacture reversals the peer would
   * count.
   */
  _p2Generate(out, count) {
    const p2 = this._p2;
    // A step is addressed by `id` and not by `name`: two steps legitimately share a
    // name (the call modem transmits Tone B at §11.2.1.1.3 and again at §11.2.1.1.6,
    // and both are "B"), and `name` is what `phase2TimedOut` reports to a caller.
    const idxOf = (id) => p2.steps.findIndex((s) => s.id === id);
    // Recovery-only steps sit at the end of the list and are reached by a `goto`.
    // Normal advance steps over them, so the error-free procedure never enters one.
    const onward = (i) => { let k = i + 1; while (p2.steps[k] && p2.steps[k].recovery) k++; return k; };
    let spin = 0;
    for (let c = 0; c < count; c++) {
      const step = p2.steps[p2.step];
      if (!step) return false;
      if (!p2.entered) {
        p2.entered = true;
        p2.inStep = 0;
        // "condition its receiver to detect a Tone A phase reversal" (§11.2.1.1.2,
        // §11.2.1.2.3, §11.2.1.1.5, §11.2.1.2.6) — the receiver counts reversals
        // only while the procedure has asked it to. That conditioning is the whole
        // reason the count is not confused by INFO's own 180° modulation, which
        // rides the same carrier at the same 180° steps.
        p2.wantRev = !!step.countRev;
        // §11.2.1.1.3 / §11.2.1.2.5 time the turnaround from "receiving the Tone A
        // phase reversal AT THE LINE TERMINALS", not from the instant a detector
        // confirms it — and confirming one costs three points, about 5 ms. The
        // anchor is therefore the reversal's recorded arrival, so what appears on
        // the line is 40 ms after what arrived on it.
        if (step.bound) step._bound = step.bound();
        if (step.durFrom) {
          // §11.2.2.1.4's plain "waits 40 ms": there is no reversal to time from,
          // which is the condition that brought it here.
          const at = p2.forceTurnaround ? undefined : step.durFrom();
          p2.forceTurnaround = false;
          step.dur = at === undefined ? P2_TURNAROUND
            : Math.min(P2_TURNAROUND, Math.max(0, P2_TURNAROUND - (p2.tn - at)));
        }
        if (step.onEnter) step.onEnter();
        if (step.emit === 'info') {
          const bits = typeof step.bits === 'function' ? step.bits() : step.bits;
          // §10.1.2.3.1's "point at an arbitrary carrier phase" precedes the
          // sequence; the chain continues from the modem's current carrier phase,
          // which is as arbitrary as anything else and costs the peer nothing.
          p2.infoPhases = P2.dpskPhases(bits, 0);
          p2.infoPos = 0;
          p2.infoHalf = 0;
        }
        if (step.emit === 'probe') p2.probeIdx = 0;
      }

      // End conditions, in the order the clauses put them: a minimum first, then
      // the signal, then the fixed duration, then the recovery bound.
      const past = p2.inStep;
      let done = false, jump = null;
      // A §11.2.2 recovery triggered by what has ARRIVED rather than by a bound
      // expiring — §11.2.2.1.1 and §11.2.2.2.1 are the only two, and neither states
      // a time. Checked first: a step that is about to end normally is not in
      // trouble, but one whose peer is asking for its INFO0 again is, however much
      // of its own duration is left.
      if (step.interrupt && (jump = step.interrupt(past))) done = true;
      else if (step.until) {
        const minOk = !step.min || past >= step.min;
        const durOk = !step.dur || past >= step.dur;
        if (minOk && durOk && step.until()) done = true;
        else if (step.max && past >= step.max) done = true;
        else if (past >= (step._bound || P2_BACKSTOP)) {
          done = true;
          p2.timedOut.push(step.name);
          jump = step.recover ? step.recover() : null;
        }
      } else if (step.dur && past >= step.dur) done = true;
      else if (step.emit === 'info' && p2.infoPos >= p2.infoPhases.length * P2_BIT) {
        // "Repeatedly send INFO0c/INFO0a sequences" and "send INFOMARKSa until …":
        // the test is at a sequence boundary, which is also §11.2.2.1.1's "complete
        // sending the current INFO0c sequence". A new sequence is built rather than
        // replayed, so bit 28 carries what has been received since the last one,
        // and the DPSK chain continues from the phase the last point left — a
        // restart at phase 0 would be a reversal the peer counts.
        if (step.repeatUntil && !step.repeatUntil()) {
          const last = p2.infoPhases[p2.infoPhases.length - 1];
          p2.infoPhases = P2.dpskPhases(step.bits(), last);
          p2.infoPos = 0;
        } else done = true;
      }

      // `stay`: a retrain has been scheduled (_startupTimeout), and the step holds
      // until it takes the line at the next block.
      if (jump && jump.stay) { done = false; jump = null; step._bound = Infinity; }
      if (done) {
        let to;
        if (jump && p2.recoveries < P2_MAX_RECOVERIES) {
          p2.recoveries++;
          // A recovery is not a normal exit, so `onExit` does NOT run: every one of
          // them computes a round trip delay from a reversal that, by definition of
          // having got here, did not arrive.
          if (jump.resetRev) {
            // The clauses that jump backwards re-enter a step that sends a fresh
            // reversal and waits for a fresh answer to it. Counts kept from the
            // abandoned attempt would satisfy that wait immediately.
            p2.peerRev = 0; p2.revAt.length = 0; p2.txRevAt.length = 0;
            p2.haveRef = false; p2.pend = null;
          }
          if (jump.fullTurnaround) p2.forceTurnaround = true;
          to = idxOf(jump.goto);
        } else {
          if (!jump && step.onExit) step.onExit();
          to = step.next ? idxOf(step.next) : onward(p2.step);
        }
        // An unresolved target is a typo, and the cost of absorbing one is what
        // this line exists to stop: a recovery that silently advanced instead
        // landed on the step BEFORE the one the clause names and cycled there four
        // times before anything said so.
        if (to < 0) throw new Error(`V34 Phase 2: no step "${jump ? jump.goto : step.next}"`);
        p2.step = to; p2.entered = false;
        if (!p2.steps[p2.step]) return false;
        // Guard, not a policy: recoveries jump backwards, so a list with a
        // zero-length cycle would spin here for ever inside generateAudio.
        if (++spin > P2_SPIN_CAP) return false;
        c--;                                  // re-enter on this sample
        continue;
      }

      out[c] = this._p2Sample(step);
      p2.inStep++;
      p2.tn++;
      spin = 0;
    }
    return true;
  }

  /** One sample of whatever the current step emits. */
  _p2Sample(step) {
    const p2 = this._p2;
    // §11.2.2.1.5 / §11.2.2.2.3 wait past the end of what they transmit: L2 stops
    // at §10.1.2.4's 550 ms while the step goes on listening. `emitMax` is that
    // split — the transmit bound, where `dur` and `max` are step bounds.
    if (step.emitMax && p2.inStep >= step.emitMax) return 0;
    // §10.1.2's carriers belong to the PART: tone A with its 1800 Hz guard for the
    // part V.34 gives the answer modem and §9.2 gives the analogue modem, tone B
    // bare for the other. §8.2.3.1/V.90 states the same two carriers at the same
    // two levels, by role rather than by reference, and they agree.
    const which = this._p2Profile.part === 'toneA' ? 'answer' : 'originate';
    const me = P2.toneOf(which);
    const info = P2.infoCarrierOf(which);
    if (step.emit === 'silence') return 0;
    if (step.emit === 'probe') return P2.probeSample(SR, p2.probeIdx++, step.level * P2_NOMINAL);
    if (step.emit === 'info') {
      const k = Math.floor(p2.infoPos / P2_BIT);
      const half = p2.infoPhases[Math.min(k, p2.infoPhases.length - 1)];
      // The rotation is folded INTO the carrier phase rather than added at the
      // output. §10.1.2.3.1 rotates the transmitted point of one continuing
      // carrier, and a modem has one carrier: adding the rotation at the output
      // instead leaves a step of π wherever the sequence ends and a tone begins,
      // which the peer's reversal detector reads — correctly, and disastrously —
      // as a phase reversal of that tone.
      if (half !== p2.infoHalf) { p2.txPhase += Math.PI; p2.infoHalf = half; }
      p2.infoPos++;
      p2.txPhase += 2 * Math.PI * info.hz / SR;
      let v = Math.cos(p2.txPhase) * info.level * P2_NOMINAL;
      if (info.guardHz) {
        p2.guardPhase += 2 * Math.PI * info.guardHz / SR;
        v += Math.cos(p2.guardPhase) * info.guardLevel * P2_NOMINAL;
      }
      return v;
    }
    // 'tone' — the modem's own tone, plus the guard the answer modem carries.
    // step.onEnter's reversal added π to txPhase, so the reversal is a genuine
    // discontinuity in one continuing tone.
    p2.txPhase += 2 * Math.PI * me.hz / SR;
    let v = Math.cos(p2.txPhase) * me.level * P2_NOMINAL;
    if (me.guardHz) {
      p2.guardPhase += 2 * Math.PI * me.guardHz / SR;
      v += Math.cos(p2.guardPhase) * me.guardLevel * P2_NOMINAL;
    }
    return v;
  }

  /**
   * Phase 2 reception: the peer's tone and its reversals, the peer's INFO
   * sequences, and the probe.
   *
   * The tone and the INFO run off ONE mixed-down correlator at the peer's carrier,
   * because that frequency is both — §10.1.2.1 and §10.1.2.3.1 put the tone and the
   * INFO on the same 2400 Hz or 1200 Hz. The probe gets its own bin at 1050 Hz, and
   * gets it cleanly, because §10.1.2.4 OMITS 900, 1200, 1800 and 2400 Hz: L1 and L2
   * put no energy on either tone or the guard, and nothing else in Phase 2 puts any
   * on 1050 Hz. That omission is why these detectors do not have to be told which
   * step of the procedure they are in.
   *
   * The integration window is exactly one INFO bit, which places a spectral null at
   * the bit rate — 600 Hz — and 2400 Hz minus the 1800 Hz guard is exactly 600 Hz,
   * so the guard falls in that null rather than having to be filtered out.
   */
  _p2Receive(f32) {
    const p2 = this._p2;
    if (!p2) return;
    for (let i = 0; i < f32.length; i++) {
      const n = p2.n++;
      const x = f32[i];
      const wt = 2 * Math.PI * p2.peerTone * n / SR;
      const wp = 2 * Math.PI * P2_PROBE_BIN * n / SR;
      p2.pacc[0] += x * Math.cos(wp);
      p2.pacc[1] -= x * Math.sin(wp);
      p2.tacc[0] += x * Math.cos(wt);
      p2.tacc[1] -= x * Math.sin(wt);
      p2.paccN++;
      // PRESENCE — of the peer's tone and of the probe — integrates over exactly
      // one PROBE period rather than one INFO bit. Every Phase 2 frequency is a
      // multiple of 150 Hz away from every other (2400 − 1050 = 1350, 1200 − 1050 =
      // 150, 1800 − 2400 = 600), so a 150 Hz window nulls all of them exactly and
      // each bin sees only its own signal. A one-bit window nulls 600 Hz offsets
      // only, which leaves the probe's neighbouring tones leaking into the tone bin
      // and reading as a tone that is not there.
      if (p2.paccN >= P2_PROBE_WIN) {
        const pI = 2 * p2.pacc[0] / p2.paccN, pQ = 2 * p2.pacc[1] / p2.paccN;
        const tI = 2 * p2.tacc[0] / p2.paccN, tQ = 2 * p2.tacc[1] / p2.paccN;
        p2.pacc[0] = 0; p2.pacc[1] = 0; p2.tacc[0] = 0; p2.tacc[1] = 0;
        p2.paccN -= P2_PROBE_WIN;
        this._p2Presence(Math.hypot(tI, tQ), Math.hypot(pI, pQ));
      }
      // One accumulator per sampling phase, staggered a quarter bit apart.
      for (let k = 0; k < P2_INFO_PHASES; k++) {
        const ph = p2.info[k];
        ph.acc[0] += x * Math.cos(wt);
        ph.acc[1] -= x * Math.sin(wt);
        if (++ph.n < P2_BIT) continue;
        const I = 2 * ph.acc[0] / ph.n, Q = 2 * ph.acc[1] / ph.n;
        ph.acc[0] = 0; ph.acc[1] = 0; ph.n -= P2_BIT;
        // Phase 0 also drives the tone and its reversals. Those need a phase
        // reference held over many windows rather than bit alignment, so one
        // phase is enough for them and four would only multiply the count.
        if (k === 0) this._p2Point(I, Q, n);
        this._p2Info(ph, I, Q);
      }
    }
  }

  /** One integrated point from the peer's carrier: tone state, reversals, INFO. */
  /**
   * One integrated point from the peer's carrier.
   *
   * The carrier has TWO uses in Phase 2 — an unmodulated tone whose reversals are
   * counted, and a 600 bit/s DPSK stream — and they need different evidence that it
   * is there, which is why presence is judged twice.
   *
   * REVERSALS are gated on the 150 Hz presence window (`toneOn`), because that
   * window nulls every other Phase 2 frequency exactly and so goes false the moment
   * the tone stops. The one-bit window cannot do this job: L1's 2250 and 2550 Hz
   * tones sit 150 Hz from tone A, which a 600 Hz-spaced null does not remove, so a
   * probe reads as a tone with a randomly moving phase — which is what counted
   * seven reversals where the procedure sends three.
   *
   * The DPSK STREAM is gated on this window's own magnitude, because a 150 Hz
   * window averages an INFO sequence's own 180° flips toward zero and would tear up
   * the very sequence it is trying to receive.
   */
  _p2Point(I, Q, n) {
    const p2 = this._p2;
    if (Math.hypot(I, Q) < P2_TONE_OFF * P2_NOMINAL) { p2.prev = null; return; }


    // Flip density over the last P2_MOD_WINDOW points: one flip is a reversal,
    // several are a carrier carrying INFO. Kept as a ring of booleans and a running
    // sum so it costs a point what a point costs.
    if (p2.prev) {
      const flip = (I * p2.prev[0] + Q * p2.prev[1]) < 0 ? 1 : 0;
      p2.modSum += flip - p2.modRing[p2.modAt];
      p2.modRing[p2.modAt] = flip;
      p2.modAt = (p2.modAt + 1) % P2_MOD_WINDOW;
    }
    p2.prev = [I, Q];
    // Recorded on the state rather than kept local: the step list asks the same
    // question ("is the peer's carrier a tone, or is it carrying INFO?") and it is
    // the same answer.
    p2.modulated = p2.modSum >= P2_MOD_FLIPS;
    const modulated = p2.modulated;

    // Reversals, on the tone. `haveRef` is cleared with `toneOn` in _p2Presence, so
    // a tone that comes back after L1 or a silence cannot be read as a reversal of
    // the one before the gap.
    //
    // A reversal is only called once the opposed phase PERSISTS. The instant a tone
    // stops — and §11.2 stops one four times, straight into L1 or into silence —
    // the window straddling the edge holds part of a tone and part of something
    // else, and its phase wanders for a few points. Counted as they came, those
    // gave seven reversals where the procedure sends three. This is the same
    // run-confirmation V34Phase3's S detector and V.32's use, for the same reason:
    // a signal is a run, and a blip is not.
    if (p2.toneOn && !modulated && Math.hypot(I, Q) >= P2_TONE_ON * P2_NOMINAL) {
      if (!p2.haveRef) { p2.refI = I; p2.refQ = Q; p2.haveRef = true; p2.pend = null; }
      else if (I * p2.refI + Q * p2.refQ < 0) {
        if (!p2.pend || I * p2.pend[0] + Q * p2.pend[1] <= 0) {
          p2.pend = [I, Q]; p2.pendN = 1; p2.pendAt = n;      // a candidate
        } else if (++p2.pendN === P2_REV_CONFIRM) {
          // Both conditions are the Recommendation's: the receiver must have been
          // conditioned to detect a reversal (§11.2.1.1.2, §11.2.1.2.3 and their
          // fellows), and the peer's INFO0 must already have been received
          // (§11.2.1.1.2, §11.2.1.2.2). Either alone lets an INFO sequence's own
          // modulation into the count.
          if (p2.wantRev && p2.peerInfo0) {
            p2.peerRev++;
            // Recorded on the TRANSMIT clock, because that is the clock every
            // duration in this procedure is counted on. The two are separate: the
            // pump generates and receives on its own schedule and they are only in
            // lockstep in a synchronous test loop. `p2.n − pendAt` is how far back
            // in the received stream the reversal was, which is a real interval in
            // either clock, so subtracting it from the transmit clock puts the
            // arrival on the right timeline. Anchoring a transmit duration to a
            // receive index instead left a 40 ms step waiting for ten seconds.
            p2.revAt.push(p2.tn - (p2.n - p2.pendAt));
          }
          p2.refI = p2.pend[0]; p2.refQ = p2.pend[1];
          p2.pend = null;
        }
      } else {
        p2.pend = null;                     // still in phase: not a reversal
      }
    }

  }

  /**
   * One sampling phase's INFO point: differentially decode it and hunt a valid
   * sequence at the tail of that phase's own bit stream. An unmodulated tone
   * decodes as a run of zeros and never presents a frame sync followed by a passing
   * CRC, so the carrier's two uses need no gate between them.
   */
  _p2Info(ph, I, Q) {
    if (Math.hypot(I, Q) < P2_TONE_OFF * P2_NOMINAL) {
      ph.bits.length = 0; ph.haveRef = false;      // no carrier, no bit stream
      return;
    }
    if (!ph.haveRef) { ph.refI = I; ph.refQ = Q; ph.haveRef = true; return; }
    const half = (I * ph.refI + Q * ph.refQ) < 0 ? 1 : 0;
    ph.refI = I; ph.refQ = Q;
    // §10.1.2.3.6's INFOMARKS is binary ones and nothing else — no frame, no CRC,
    // so a long RUN of them is the whole signal. It is only consulted by
    // §11.2.2.1.6, and an unmodulated tone decodes as zeros, so nothing else in
    // Phase 2 can raise it.
    ph.ones = half ? (ph.ones || 0) + 1 : 0;
    if (ph.ones >= P2_MARKS_RUN) this._p2.peerMarks = true;
    ph.bits.push(half);
    if (ph.bits.length > P2.INFO1C.length + 8) ph.bits.shift();
    this._p2HuntInfo(ph);
  }

  /** A valid INFO sequence at the tail of the decoded bit stream, if there is one. */
  _p2HuntInfo(ph) {
    const p2 = this._p2;
    // Only the two sequences the PEER sends, which is what the profile names. V.34
    // used to hunt all three and got away with it because their lengths differ;
    // §9.2's do not — a V.90 INFO1a and a V.34 INFO1a are both 70 bits with the
    // same frame sync and the same CRC placement, so hunting the wrong one returns
    // a passing frame with fields read from the wrong columns.
    for (const spec of [this._p2Profile.peerInfo0, this._p2Profile.peerInfo1]) {
      if (ph.bits.length < spec.length) continue;
      const bits = ph.bits.slice(ph.bits.length - spec.length);
      const got = P2.parseInfo(spec, bits);
      if (!got) continue;
      // A sequence that arrives AGAIN is not noise to be dropped: it is
      // §11.2.2.1.1's and §11.2.2.2.1's "receives repeated INFO0x sequences", which
      // is the peer saying it has not had this modem's own. The latest copy is kept
      // rather than the first, because bit 28 changes between them and it is bit 28
      // that ends the repetition.
      if (spec === this._p2Profile.peerInfo0) { if (p2.peerInfo0) p2.info0Repeats++; p2.peerInfo0 = got; }
      else if (p2.peerInfo1) p2.info1Repeats++;
      else p2.peerInfo1 = got;
      for (const q of p2.info) q.bits.length = 0;   // one sequence, one detection
      // §11.2.1.1.2: "After receiving INFO0a, the call modem shall condition its
      // receiver to detect Tone A ... and detect the subsequent Tone A phase
      // reversal" — and §11.2.1.2.2 says the same to the answer modem. Conditioning
      // the receiver AT THIS POINT means acquiring the tone afresh: the phase
      // reference must not be carried over from the INFO sequence, whose own
      // modulation left it at an arbitrary one of the two phases. Carried over, the
      // tone that follows disagrees with it half the time and is counted as the
      // reversal the procedure has not sent yet.
      p2.haveRef = false;
      p2.pend = null;
      return;
    }
  }

  /**
   * L1 and L2, detected where the tones are not. §10.1.2.4 omits 900, 1200, 1800
   * and 2400 Hz from the probe, so 1050 Hz carries probe energy and nothing else in
   * Phase 2 and one bin answers it. `probeEnded` needs the probe to have been up
   * for a real stretch first — L1 alone is 160 ms — so that a step waiting to
   * RECEIVE the probe cannot fall through before it starts.
   */
  _p2Presence(toneMag, probeMag) {
    const p2 = this._p2;
    const was = p2.toneOn;
    const high = p2.toneOn ? toneMag > P2_TONE_OFF * P2_NOMINAL : toneMag > P2_TONE_ON * P2_NOMINAL;
    // A tone is declared GONE only after several consecutive quiet windows, and
    // that is not slack — it is required. This window is coherent and 150 Hz long,
    // so a 180° reversal falling inside one averages that window to nearly zero:
    // the presence detector is blinded by the very event it exists to qualify.
    // Measured, a reversal darkens one window; the real gaps in §11.2 are L1's
    // 160 ms and longer, so three windows separates them cleanly.
    if (high) { p2.lowRuns = 0; p2.toneOn = true; }
    else if (++p2.lowRuns >= P2_TONE_DROP) p2.toneOn = false;
    // The phase reference belongs to one continuous tone. §10.1.2.1 defines a
    // reversal as a change within the tone, so a gap ends the reference rather
    // than being spanned by it.
    if (was && !p2.toneOn) p2.haveRef = false;
    const on = p2.probeOn ? probeMag > P2_PROBE_OFF * P2_NOMINAL : probeMag > P2_PROBE_ON * P2_NOMINAL;
    if (on) { p2.probeOn = true; p2.probeSeen++; return; }
    // §11.2.1.1.5 and §11.2.1.2.8 receive L1 for its 160 ms and L2 after it, so the
    // END of the probe is only believable once enough of it has been seen — 20
    // windows is 133 ms, inside L1 alone.
    if (p2.probeOn && p2.probeSeen >= P2_PROBE_CONFIRM) p2.probeEnded = true;
    p2.probeOn = false;
  }

  /**
   * What Phase 2 settled, handed to Phase 3.
   *
   * §10.1.3.5's MD length is an INFO1 field, which is what retires MD_SYMBOLS as a
   * constant: the modem now emits the MD its peer asked for, and the branch in
   * _buildPhase3 that was present-but-never-taken is reached whenever a peer asks
   * for a non-zero length. Neither end asks for one here, because neither has a
   * manufacturer-defined signal to send — which is exactly what a modem without one
   * declares, and is now declared rather than assumed.
   *
   * Table 16's symbol rate fields are the answer modem's selection and both ends
   * read them from the same sequence, so the rate is negotiated rather than
   * configured. A selection this build cannot run is recorded and the configured
   * rate is kept, the same way an MP mismatch is.
   */
  _p2Settle() {
    const p2 = this._p2;
    if (!p2 || p2.settled) return;
    p2.settled = true;
    this.rtdSamples = p2.rtd;
    // Which §11.2.2 bounds expired, if any. Empty is the error-free procedure; a
    // non-empty list means the exchange completed on recovery bounds rather than
    // on the peer's signals, which is a thing to see rather than to infer from a
    // long connect.
    this.phase2TimedOut = p2.timedOut.slice();
    this.phase2Recoveries = p2.recoveries;
    const info1 = p2.peerInfo1;
    if (!info1) { this.phase2Incomplete = true; return; }
    // V.34's own INFO1 names the symbol rate; take it before anything below reads
    // BAUD. V.90's profile has its own reading and keeps its configuration.
    if (!this._p2Profile.settle) {
      const idx = this.role === 'answer' ? P2.SYMBOL_RATES.indexOf(p2.chosenRate)
                                         : info1.answerToCallSymbolRate;
      this._useSymbolRate(P2.SYMBOL_RATES[idx]);
    }
    // §10.1.3.5 and Tables 15/16 bits 18:24: each modem declares the length of the
    // MD IT will transmit, in 35 ms increments, in its OWN INFO1. So this modem's
    // MD comes from the sequence it sent and the peer's is what it should expect to
    // receive — reading the peer's field into its own transmitter was the obvious
    // wrong turn here. Both are zero because neither modem has a
    // manufacturer-defined signal, which is what §10.1.3.5 says such a modem
    // declares; what has changed is that the length is now CARRIED rather than
    // being a constant, and _buildPhase3's MD branch is driven by it.
    this._mdSymbols = Math.round((p2.myMdLength || 0) * 0.035 * BAUD);
    this.peerMdSymbols = Math.round((info1.mdLength || 0) * 0.035 * BAUD);
    // §9.2's INFO1a is Table 10/V.90 and names its fields differently — an upstream
    // symbol rate at 34:36 and a MODE at 37:39 where Table 16 has two symbol rates —
    // so what the sequence SELECTS is the profile's to read. MD above is not: both
    // tables put it at 18:24, in 35 ms increments, and mean the same thing by it.
    if (this._p2Profile.settle) { this._p2Profile.settle(p2, info1); return; }
    // Table 16 bits 34:39 name both directions. The answer modem chose them and
    // knows its own choice; the call modem reads them out of INFO1a.
    const idx = this.role === 'answer' ? P2.SYMBOL_RATES.indexOf(p2.chosenRate)
                                       : info1.answerToCallSymbolRate;
    const rate = P2.SYMBOL_RATES[idx];
    this.negotiatedSymbolRate = rate === undefined ? null : rate;
    if (rate !== undefined && rate !== CFG.sRate) {
      this.rateMismatch = `INFO1 selected ${rate} baud; this build has no front end for it`;
    }
  }

  /**
   * Run the call at symbol rate `S` (from INFO1, Table 16 bits 34:39): this call's
   * front end becomes S's, at the fastest ladder rate there within the configured
   * ceiling. Between Phase 2 and Phase 3, so nothing at the old rate is in flight
   * but the receive buffer, whose baseband was mixed with the old carrier.
   */
  _useSymbolRate(S) {
    if (S === undefined || S === CFG.sRate || !RF[S]) return;
    const at = Object.values(RATE_CONFIGS).filter((c) => c.sRate === S).map((c) => c.bitRate).sort((a, b) => a - b);
    if (!at.length) return;
    const rate = at.filter((r) => r <= this._configuredRate).pop() || at[0];
    this._fe = frontEnd(`${rate}/${S}`);
    this._g = { s: P3_GAIN_S, pp: P3_GAIN_PP, p16: P4_GAIN_16, tx: TX_GAIN, meanE: MEAN_E };
    this._configuredRate = rate;
    this._rate = rate;
    this._txD = dataCfg(rate);
    this._rxD = this._txD;
    this.txCoder = new V34Coder(this._txD.cfg);
    this.rxCoder = new V34Coder(this._rxD.cfg);
    this.rxOn = false; this.rxLow = 0;
    this._resetRx();
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
    // §11.2 runs on its own generator: its signals are tones, a 600 bit/s DPSK
    // carrier and a multitone probe, none of which goes through the QAM shaper.
    if (kind === 'phase2') {
      this._p2Started = true;
      this._p2.steps = this._phase2Steps();
      if (this._leadSilence && this._p2.steps[0].emit === 'silence') {
        this._p2.steps[0] = { ...this._p2.steps[0], dur: this._p2.steps[0].dur + this._leadSilence };
        this._leadSilence = 0;
      }
      if (this._p2Retrain) {
        // §11.5.1.2 / §11.5.2.2: 70 ms of silence, then straight to §11.2.1.1.3's
        // tone B or §11.2.1.2.3's tone A; the INFO0s stand from the call's start.
        this._p2Retrain = false;
        const at = this._p2.steps.findIndex((st) => st.id === (this._p2Profile.part === 'toneA' ? 'A' : 'B'));
        this._p2.steps = [{ name: 'silence', emit: 'silence', dur: RETRAIN_SILENCE }, ...this._p2.steps.slice(at)];
      }
      this._p2.step = 0; this._p2.entered = false;
      this.txMode = 'phase2';
      this.txState = 'active';
      this._idleSamples = 0;
      return;
    }
    // Phase 3's head (S, S̄, MD, PP, TRN) is fixed-length and built in one go; its
    // tail is signal-gated, so the burst runs on the continuous path and _p3Next()
    // feeds it. It stops being continuous the moment the tail says it is done,
    // which is what lets the existing fixed-burst end condition finish the shaper.
    if (kind === 'phase3') {
      this._buildPhase3();
      this.txContinuous = true;
      this._p3Active = true;
      this.txState = 'active';
      this._idleSamples = 0;
      return;
    }
    // §9.3.2.4's silence splits the analogue modem's Phase 3 in two. The second
    // transmission has no head — it resumes the tail's stage machine, keeping the
    // differential encoder and the scrambler, which §8.3.5 requires for SCR.
    if (kind === 'phase3-resume') {
      this._p3.stage = this._p3Resume;
      this._p3.done = false; this._p3.bits = null; this._p3.bitPos = 0;
      this._p3.run = null; this._p3.count = 0;
      this.txContinuous = true;
      this._p3Active = true;
      this.txState = 'active';
      this._idleSamples = 0;
      return;
    }
    // §11.4.1.2.1: the answer modem's Phase 4 is its own transmission — "signal S
    // for 128T ... then ... signal S̄ for 16T followed by signal TRN" — and runs on
    // the same tail machine from TRN onwards, so MP, MP′, E and the data mode that
    // follows them are the call modem's stages in the call modem's order.
    if (kind === 'phase4') {
      this._p3 = {
        enc: null, stage: 'p4-trn', bits: null, bitPos: 0, reps: 0, count: 0, done: false,
        run: [...P3.buildS(), ...P3.buildSbar()],
        jStart: null, mpReps: 0,
      };
      this._p3HeadRemaining = 0;
      this.txContinuous = true;
      this._p3Active = true;
      this.txState = 'active';
      this._idleSamples = 0;
      return;
    }
    throw new Error(`V.34: no burst of kind ${kind}`);
  }

  /**
   * Phase 4 is over and data mode begins, in the same transmission (§11.4.1.1.4,
   * §11.4.1.2.4). §10.1.3.1: B1 is "one data frame of scrambled ones", and "prior
   * to transmission of B1, the scrambler, trellis encoder, differential encoder, and
   * the precoding filter tap delay line are initialized to zeroes"; its first mapping
   * frame is time index i = 0 (§8), which the switching pattern and the superframe
   * inversions both count from.
   */
  _enterDataTx() {
    this._p3Active = false;
    this.scr.fill(0);
    this._useRate();
    this.txCoder.reset();
    this.txFrameIdx = 0;
    const cfg = this._txD.cfg;
    let b1 = 0;
    for (let i = 0; i < cfg.P; i++) b1 += cfg.bitsForFrame(i);
    this.txWarmup = b1;
    this.txFrame = null;
  }

  /**
   * A step waits for its own gap, and a step carrying `gate` waits for a SIGNAL as
   * well. `gate: 'j'` is §11.3.1.1.3 for the call modem — "After receiving J, the
   * call modem ... shall transmit signal S" — and §11.4.1.2.1 for the answer modem,
   * whose Phase 4 answers the call modem's Phase 3, J being its last segment. Each
   * end's J is the far end's FIRST J, so one detection serves. S_GATE_TIMEOUT is the
   * fallback described where that constant is declared.
   */
  _maybeStartBurst() {
    if (!this._connectQ.length) return;
    const step = this._connectQ[0];
    if (this._idleSamples < step.gap) return;
    if (step.gate === 'j' && !this._peerJ) {
      if (this._idleSamples < S_GATE_TIMEOUT) return;
      if (this._startupTimeout('J')) return;               // §11.3.2.1.1
      this._sGateTimedOut = true;
    }
    // §9.3.2.7 — the analogue modem begins S only "after receiving Jd".
    if (step.gate === 'jd' && !(this._p3Tail && this._p3Tail.jdReceived())) {
      if (this._idleSamples < S_GATE_TIMEOUT) return;
      this._sGateTimedOut = true;
    }
    this._startBurst(this._connectQ.shift().kind);
  }

  _txBit() {
    if (this.txWarmup > 0) { this.txWarmup--; return this._scramble(1); }
    if (this.txFrame) {
      const b = this.txFrame[this.txFramePos++];
      if (this.txFramePos >= this.txFrame.length) this.txFrame = null;
      return this._scramble(b);
    }
    if (this._link) return this._scramble(this._link.nextBit());
    const by = this.txByteQ.length ? this.txByteQ.shift() : null;
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
    const cfg = this._txD.cfg;
    const high = cfg.isHighFrame(idx);
    const nb = high ? cfg.frameBitsHigh : cfg.frameBitsLow;
    const bits = new Array(nb);
    for (let i = 0; i < nb; i++) bits[i] = this._txBit();
    const pts = this.txCoder.encodeFrame(bits, high);
    // A rate below the configured one has a smaller lattice; data power stays at
    // the training power TX_GAIN was set for.
    const k = Math.sqrt(this._g.meanE / this._txD.meanE);   // 1 at the configured rate
    if (k !== 1) for (const p of pts) { p.i *= k; p.q *= k; }
    return pts;
  }

  _ensureSymbols(k) {
    if (!this.txContinuous) return;
    if (this._p3Active) {
      while (this.txSymBase + this.txSyms.length <= k) {
        const p = this._p3Next();
        if (p === ENTER_DATA) { this._enterDataTx(); break; }
        if (!p) {
          // The tail is over. Everything still to be pulsed is already in txSyms,
          // so the burst stops being continuous and ends on the fixed-burst
          // condition once the shaper has run its span out.
          this._p3Active = false;
          this.txContinuous = false;
          this.txEndSample =
            Math.ceil((this.txSymBase + this.txSyms.length + SPAN / 2) * SPS);
          return;
        }
        this.txSyms.push(p);
      }
      if (this._p3Active) return;
    }
    while (this.txSymBase + this.txSyms.length <= k) {
      const pts = this._encodeFrameSymbols();
      for (const p of pts) this.txSyms.push(p);
    }
  }

  /**
   * Every transmitted sample, on one absolute clock the receiver shares, into the
   * echo canceller: it subtracts what it learned this end's echo to be.
   */
  generateAudio(count) {
    if (this._pendingRetrain) { const why = this._pendingRetrain; this._pendingRetrain = null; this._beginRetrain(why); }
    const n0 = this._ecTx;
    const out = this._generateAudio(count);
    if (this._ecOn) for (let k = 0; k < count; k++) this._ec.sent(n0 + k, out[k]);
    this._ecTx = n0 + count;
    return out;
  }

  /** Where transmit sample n falls in the tagged Phase 3, by its nearest symbol. */
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

  _generateAudio(count) {
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
    if (this.txMode === 'phase2') {
      if (!this._p2Generate(out, count)) {
        // §11.2 is over. What INFO1 settled feeds Phase 3, and the burst ends so
        // the connect script's next step — Phase 3 — can start on its own gap.
        this._p2Settle();
        this.txState = 'idle';
        this._resetTxBurst();
      }
      return out;
    }
    for (let c = 0; c < count; c++) {
      const n = this.txN++;
      if (!this.txContinuous && this.txEndSample >= 0 && n >= this.txEndSample) {
        this.txState = 'idle'; this._resetTxBurst(); break;
      }
      const ph = n % SPS_P, m = (n - ph) / SPS_P;
      const w = TX_W[ph], kb = TX_KLO[ph] + m * SPS_Q;   // exact: SPS_Q is an integer
      this._ensureSymbols(kb + w.length - 1);
      let ai = 0, aq = 0;
      for (let i = Math.max(0, -kb, this.txSymBase - kb); i < w.length; i++) {
        const s = this.txSyms[kb + i - this.txSymBase];
        if (!s) break;
        const p = w[i]; ai += s.i * p; aq += s.q * p;
      }
      const ci = carIdx(n);
      out[c] = (ai * CAR_COS[ci] - aq * CAR_SIN[ci]) * this._g.tx;
      if (this._ecSpan.end == null) this._ecTag(this._ecTx + c, n / SPS);
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
    // The baseband view of `rx`, one entry per sample, filled as samples arrive:
    // consecutive symbol windows overlap by SPAN (32 at the top rate), so deriving
    // it inside _symAt recomputed the same carrier pair thirty-two times a sample.
    // All three are one growable block rather than plain Arrays — this is the
    // per-sample path, and splice(0, n) on an Array of thousands copies the tail.
    // Capacity only grows; `rxLen` is the length.
    this.rxCap = this.rxCap || 8192;
    this.rx = new Float64Array(this.rxCap);
    this.rxI = new Float64Array(this.rxCap);
    this.rxQ = new Float64Array(this.rxCap);
    this.rxLen = 0;
    // Invalidated, not discarded: the tap arrays are reused across acquisitions and
    // a NaN base can never equal one, so the next _symBank call refills them.
    for (const bk of this._banks || []) bk.base = NaN;
    this._eqReset();
    this._onsetPos = 0; this._onsetE = 0; this._onsetHit = -1;   // see _scanOnset
    this.rxBase = 0;
    this.acq = false;
    this.base = 0;
    this.symIdx = 0;
    this.des = new Array(23).fill(0);
    this.gr = 1; this.gi = 0; this.g2 = 1;
    this.outbits = [];
    this._rxHold = [];               // decoded frames not yet released (_rxRelease)
    this.rxPts = [];                 // sliced points accumulating toward one mapping frame
    this.rxFrameIdx = 0;             // mapping-frame counter, i = 0 at B1's first mapping frame (§8)
    this.rxCoder.reset();
    this.uState = 'hunt'; this.uArmed = false; this.uMarks = 0; this.uBit = 0; this.uByte = 0;
    this._rxData = false;
    // Phases 3 and 4 are read in one domain — S-referenced rotations, differential
    // bits — however many silences divide them, and data mode is entered from it at
    // B1 (see _enterDataRx), never by acquiring afresh: a real V.34 carries its
    // timing and gain from training straight into data, and so does this receiver.
    this.rxPhase = 'phase3';
    this._sHuntPos = 0;                // absolute scan position, forward-only
    this._sRef = null;                 // {a, b}: the two S symbols as received
    // The timing lock belongs to a burst and is re-acquired on the next one — but
    // the S / S̄ counts do not, because §9.3.2.4's silence divides ONE Phase 3 into
    // two transmissions and the transitions on either side of it are the same
    // procedure's. The differential decoder restarts (its predecessor is on the far
    // side of a gap); the descrambler is self-synchronising and needs no help.
    // The parity goes with the timing lock, so a re-acquired burst re-resolves it on
    // its own S-to-S̄ transition. §9.3.2.7's S and §9.3.2.8's S̄ are exactly that.
    if (this.p3) {
      this.p3.dec.prev = null; this.p3.anchor = null; this.p3.runKind = null; this.p3.runLen = 0;
      this.p3.lastRot = -1; this.p3.parityKnown = false;
    }
  }

  // Energy onset, as an index into rx. Forward-only and sticky: the EWMA is carried
  // in `_onsetE` rather than restarted, which makes this the same recurrence over
  // the same prefix that rescanning from 0 computed — the identical value, without
  // re-walking the buffer on every block while the S confirmation is still failing.
  _scanOnset() {
    if (this._onsetHit >= 0) return this._onsetHit;
    for (let n = this._onsetPos; n < this.rxLen; n++) {
      const b = this._bb(n); const m = Math.hypot(b[0], b[1]);
      this._onsetE = 0.85 * this._onsetE + 0.15 * m;
      if (this._onsetE > 0.04) {
        this._onsetPos = n + 1; this._onsetHit = Math.max(0, n - 4); return this._onsetHit;
      }
    }
    this._onsetPos = this.rxLen;
    return -1;
  }

  _growRx() {
    const cap = this.rxCap * 2;
    for (const f of ['rx', 'rxI', 'rxQ']) { const n = new Float64Array(cap); n.set(this[f]); this[f] = n; }
    this.rxCap = cap;
  }

  // Discard the first `k` samples. rxBase carries the absolute index forward, so
  // nothing that indexes by absolute sample number has to know this happened.
  _dropRx(k) {
    const L = this.rxLen;
    for (const f of ['rx', 'rxI', 'rxQ']) this[f].copyWithin(0, k, L);
    this.rxLen = L - k; this.rxBase += k;
    this._onsetPos = Math.max(0, this._onsetPos - k);
    if (this._onsetHit >= 0) this._onsetHit = Math.max(0, this._onsetHit - k);
  }

  // Kept for the two onset scans, which walk `rx` by index before a symbol clock
  // exists; _sym reads rxI/rxQ instead.
  _bb(n) { const ci = carIdx(n); const s = this.rx[n - this.rxBase]; return [s * CAR_COS[ci] * 2, -s * CAR_SIN[ci] * 2]; }
  /**
   * The matched filter, as an exact polyphase bank.
   *
   * Every caller wants symbol `idx` of a burst whose first symbol sits at `base`,
   * i.e. pos = base + idx*SPS. Because SPS is the exact rational SPS_P/SPS_Q,
   * advancing idx by SPS_Q advances pos by exactly the INTEGER SPS_P — so the tap
   * vector depends only on idx mod SPS_Q, and one bank of SPS_Q vectors serves the
   * whole burst. The taps are the doubles rrc() returns, computed once per
   * acquisition instead of once per sample per symbol; nothing is interpolated.
   *
   * This is what the rounded symbol rate cost: at 3429 baud SPS was 8000/3429 and
   * the timing phase repeated only every 3429 symbols, so no exact bank existed.
   * At the Recommendation's 24000/7 it is 7/3 and there are three phases.
   */
  _symBank(base) {
    // Two banks, least recently used replaced: the equaliser reads every symbol
    // at its own instant AND half a symbol later, and one bank rebuilt at each
    // switch would cost more than the filtering.
    const banks = this._banks || (this._banks = []);
    this._bankUse = (this._bankUse || 0) + 1;
    for (const b of banks) if (b.base === base && b.rate === CURRENT_RATE) { b.use = this._bankUse; return b; }
    // The tap ARRAYS are reused, not reallocated. A timing search evaluates a few
    // hundred candidate positions and rebuilds the bank at every one of them, and
    // three fresh Float64Arrays per candidate was the acquisition's whole garbage
    // bill. The taps themselves are recomputed exactly as before — this is storage,
    // not arithmetic, and the window's length still varies by a sample with the
    // fractional position, which is what LEN carries.
    // The taps depend on base only through its fractional part: the integer part
    // moves every window by whole samples. So they are computed once per rate and
    // fraction (bankTaps) and shared, and a bank is the shared taps and its own
    // start indices. A timing search tries 257 positions on a grid of SPS/64, whose
    // fractions repeat, and rebuilt the taps at every one, every block; once S's
    // hunt stepped past a rejected onset at once, that was over a second of CPU
    // per half second of audio wherever there was no S to find.
    let bk = banks.find((b) => b.rate !== CURRENT_RATE);
    if (!bk && banks.length < 2) { bk = { base: NaN, rate: CURRENT_RATE, use: 0, LEN: null, N0: new Int32Array(SPS_Q), W: null }; banks.push(bk); }
    else if (!bk) bk = banks[0].use <= banks[1].use ? banks[0] : banks[1];
    if (bk.N0.length !== SPS_Q) bk.N0 = new Int32Array(SPS_Q);
    const whole = Math.floor(base);
    const taps = bankTaps(base - whole);
    bk.W = taps.W; bk.LEN = taps.LEN;
    for (let ph = 0; ph < SPS_Q; ph++) bk.N0[ph] = taps.N0[ph] + whole;
    bk.rate = CURRENT_RATE;
    bk.base = base;
    bk.use = this._bankUse;
    return bk;
  }

  /**
   * The receive equaliser: a T/2-spaced complex filter, 4·EQ_L + 1 taps over
   * ±EQ_L symbols, on the matched filter's output.
   *
   * Measured against BinModem before it was written. Its Phase 4 TRN arrives at our
   * matched filter with 6.4% rms scatter about the four points. BinModem's pulse
   * shaping is not our RRC, and no line is involved. The 33 600 lattice in those
   * units has a half-step of 0.037, so data was below the slicer. Least squares on
   * that TRN, then tested on later TRN: 1 tap 0.091, 9 taps T/2 0.0031, 17 taps
   * 0.0022. (The earlier reading, "30 dB SNR", came from fitting on DATA, where
   * decisions from garbage have nothing to converge to. Train on the sparse
   * signal.)
   *
   * It starts as the identity, so a far end whose shaping IS ours sees exactly the
   * receiver it had. It trains normalised-LMS on every Phase 3/4 symbol that sits
   * clearly on one of S's four points — PP, which does not, is gated out by the
   * size of its error — and runs decision-directed in data mode at a tenth of the
   * step.
   */
  _eqReset() {
    // A burst's training measure outlives the burst: the call modem's comes from
    // the answer modem's Phase 3, and its MP goes out after the silence that ends it.
    const o = this._eq;
    if (o && o.epsN >= EQ_MIN_MEASURED) this._eqMeasured = { sum: o.epsSum, n: o.epsN };
    this._eq = {
      w: new Float64Array(2 * EQ_N), x: new Float64Array(2 * EQ_N),
      c0: new Map(), c1: new Map(), base: NaN, y: [0, 0], trained: 0, epsSum: 0, epsN: 0,
    };
    this._eq.w[2 * 2 * EQ_L] = 1;               // identity: the centre tap
  }

  _eqTap(base, idx, half) {
    const eq = this._eq, c = half ? eq.c1 : eq.c0;
    let v = c.get(idx);
    if (!v) {
      v = this._symInto(half ? base + SPS / 2 : base, idx, [0, 0]);
      c.set(idx, v);
    }
    return v;
  }

  /** Equalised symbol idx, written to eq.y (the input vector stays in eq.x for the update). */
  _eqApply(base, idx) {
    const eq = this._eq;
    if (eq.base !== base) { eq.c0.clear(); eq.c1.clear(); eq.base = base; }
    const x = eq.x, w = eq.w;
    let j = 0;
    for (let m = -EQ_L; m <= EQ_L; m++) {
      const a = this._eqTap(base, idx + m, false); x[j++] = a[0]; x[j++] = a[1];
      if (m < EQ_L) { const b = this._eqTap(base, idx + m, true); x[j++] = b[0]; x[j++] = b[1]; }
    }
    let yi = 0, yq = 0;
    for (let k = 0; k < 2 * EQ_N; k += 2) {
      yi += w[k] * x[k] - w[k + 1] * x[k + 1];
      yq += w[k] * x[k + 1] + w[k + 1] * x[k];
    }
    // Entries this far behind are never read again.
    const old = idx - EQ_L - 2;
    eq.c0.delete(old); eq.c1.delete(old);
    eq.y[0] = yi; eq.y[1] = yq;
    return eq.y;
  }

  /** The tracking state for this call: the carrier and clock offsets outlive a burst. */
  _trk() {
    return this._trkS || (this._trkS = { th: 0, dth: 0, c: 1, s: 0, acc: 0, drift: 0, pow: 0 });
  }

  /** eq.y turned back by the carrier tracker's angle, into `out`. */
  _trkDerotate(y, out) {
    const t = this._trk();
    out[0] = y[0] * t.c + y[1] * t.s;
    out[1] = y[1] * t.c - y[0] * t.s;
    return out;
  }

  /** A target in the derotated domain, turned forward into the equaliser's. */
  _trkRotate(ti, tq) { const t = this._trk(); return [ti * t.c - tq * t.s, tq * t.c + ti * t.s]; }

  /** One phase error (radians, in the derotated domain): second-order update. */
  _trkPhase(pe) {
    const t = this._trk();
    t.dth += TRK_FREQ * pe;
    t.th += TRK_PHASE * pe + t.dth;
    if (t.th > Math.PI) t.th -= 2 * Math.PI; else if (t.th < -Math.PI) t.th += 2 * Math.PI;
    t.c = Math.cos(t.th); t.s = Math.sin(t.th);
  }

  /**
   * One symbol of timing, Mueller and Müller's detector on the derotated equaliser
   * output z and its decision d: Re{conj(d(k−1))·z(k) − conj(d(k))·z(k−1)}, over the
   * decision's power. It needs no excess bandwidth, which V.34's pulse does not
   * have, and it reads the instant through an equaliser that is almost still. A
   * null decision (an ungated Phase 3 symbol) breaks the pair. Returns the base
   * after this symbol — moved by whole TRK_QUANTUM steps only.
   */
  _trkTiming(base, z, d) {
    const t = this._trk(), pz = t.pz, pd = t.pd;
    if (!d) { t.pz = null; return base; }
    t.pz = [z[0], z[1]]; t.pd = [d[0], d[1]];
    if (!pz || this._eq.trained < TRK_SETTLE) return base;
    const p = d[0] * d[0] + d[1] * d[1];
    t.pow += (t.pow ? 0.01 : 1) * (p - t.pow);
    const e = ((pd[0] * z[0] + pd[1] * z[1]) - (d[0] * pz[0] + d[1] * pz[1])) / t.pow;
    t.drift += TRK_TFREQ * e;
    t.acc += TRK_TIMING * e + t.drift;
    if (Math.abs(t.acc) < TRK_QUANTUM) return base;
    const q = Math.trunc(t.acc / TRK_QUANTUM) * TRK_QUANTUM;
    t.acc -= q;
    return base + q;
  }

  /**
   * BinModem's second pass: how fast the constellation turns, from the rough fit's
   * residual phase early and late in its window, then the fit again with that turn
   * in the targets; and the carrier loop told the turn it measured. The loop has had
   * only S to learn from by PP's end, and at −100 ppm a turn it has half learnt left
   * a fit of 1.5·10⁻³ where 10⁻⁴ is usual.
   */
  _ppRefine(r, ppAt, best, t) {
    const k0 = PP_SKIPPED, k1 = PP_SKIPPED + PP_SOLVED, end = ppAt + k1 + best.d;
    const rows = [], base = [];
    for (let k = k0; k < k1; k++) {
      const idx = ppAt + best.d + k;
      rows.push(this._eqRow(r.base, idx));
      const p = PP_REF[k], g = this._g.pp, th = t.dth * (idx - end);
      const c = Math.cos(th), sn = Math.sin(th);
      base.push([(p.i * c - p.q * sn) * g, (p.i * sn + p.q * c) * g]);
    }
    const out = (w, x) => { let yr = 0, yi = 0; for (let i = 0; i < EQ_N; i++) { yr += w[2 * i] * x[2 * i] - w[2 * i + 1] * x[2 * i + 1]; yi += w[2 * i] * x[2 * i + 1] + w[2 * i + 1] * x[2 * i]; } return [yr, yi]; };
    const half = rows.length >> 1;
    const lean = (a, b) => { let lr = 0, li = 0; for (let k = a; k < b; k++) { const [yr, yi] = out(best.w, rows[k]); lr += yr * base[k][0] + yi * base[k][1]; li += yi * base[k][0] - yr * base[k][1]; } return [lr, li]; };
    const e = lean(0, half), l = lean(half, rows.length);
    const turn = Math.atan2(l[1] * e[0] - l[0] * e[1], l[0] * e[0] + l[1] * e[1]) / half;
    const tg = base.map((v, k) => { const th = turn * (k - rows.length); const c = Math.cos(th), sn = Math.sin(th); return [v[0] * c - v[1] * sn, v[0] * sn + v[1] * c]; });
    const w = leastSquares(rows, tg, EQ_N);
    if (!w) return;
    let er = 0, pw = 0;
    for (let k = 0; k < rows.length; k++) { const [yr, yi] = out(w, rows[k]); er += (yr - tg[k][0]) ** 2 + (yi - tg[k][1]) ** 2; pw += tg[k][0] ** 2 + tg[k][1] ** 2; }
    if (er / pw < best.mse) { best.w = w; best.mse = er / pw; t.dth += turn; }
  }

  /**
   * The raw S̄ detector, on the matched filter's outputs: Re(x·conj(x two back))
   * normalised is +1 through S, and through S̄ too (S̄ is S turned half a
   * revolution, and repeats as S does); only ACROSS the change is a symbol the
   * opposite of the one two before it. So: after RAW_S_RUN of S, a dip below −0.3
   * (smeared over a symbol or two by the line), S̄ starting at its deepest point,
   * confirmed by RAW_SBAR_RUN back above +0.5. PP follows S̄'s 16 symbols.
   */
  _rawSbar(r, idx) {
    const p = this.p3;
    if (!p || p.ppAt != null || p.sbarCount > 0) return;
    const x = this._symInto(r.base, idx, [0, 0]);
    const h = p.rawHist || (p.rawHist = []);
    h.push(x);
    if (h.length > 3) h.shift();
    if (h.length < 3) return;
    const y = h[0];
    const c = (x[0] * y[0] + x[1] * y[1]) / (Math.hypot(x[0], x[1]) * Math.hypot(y[0], y[1]) || 1);
    if (p.rawDip != null) {
      // Still in the dip: follow it to its deepest point.
      if (p.rawSeen === 0 && c < p.rawDipC) { p.rawDipC = c; p.rawDip = idx; return; }
      // Then S̄ itself: RAW_SBAR_RUN of the next RAW_SBAR_OF back above +0.5. Not
      // all of them, and not for long: at 10 dB and 1.5 ms the line's smear put two
      // negatives inside S̄'s own 16 symbols. Through S the reading is 1.00 without
      // exception, so a dip with S̄ behind it is distinctive enough.
      p.rawSeen++;
      if (c > 0.5) p.rawUp++;
      if (p.rawUp >= RAW_SBAR_RUN) { p.ppAt = p.rawDip + P3.SBAR_SYMBOLS; return; }
      if (p.rawSeen >= RAW_SBAR_OF) { p.rawDip = null; p.rawS = 0; }
      return;
    }
    if (c > 0.5) { p.rawS = (p.rawS || 0) + 1; p.rawMid = 0; return; }
    if (c < -0.3 && (p.rawS || 0) >= RAW_S_RUN) { p.rawDip = idx; p.rawDipC = c; p.rawSeen = 0; p.rawUp = 0; return; }
    // In between: the change's shallow edge, before its dip (−0.12 two symbols ahead
    // of −0.80 at 12 dB of tilt), must not cost the count of S behind it. Only a run
    // of them is not S.
    if (++p.rawMid > 3) p.rawS = 0;
  }

  /**
   * A new burst's equaliser, from the taps PP was solved for: loaded, and S's two
   * points read again through it (from symbols far enough into S that the taps span
   * S alone). Its training then runs as it would from the identity, coarse step
   * first: skipping straight to the fine step measured a worse ε on a clean line
   * and cost the lower configured rates two rungs.
   */
  _eqFromSolved(r) {
    const eq = this._eq;
    eq.w.set(this._ppTaps);
    eq.c0.clear(); eq.c1.clear(); eq.base = NaN;
    const acc = [[0, 0], [0, 0]], cnt = [0, 0];
    for (let k = EQ_L + 1; k < 16; k++) {
      const x = this._eqRow(r.base, k);
      let yr = 0, yi = 0;
      for (let i = 0; i < EQ_N; i++) { yr += eq.w[2 * i] * x[2 * i] - eq.w[2 * i + 1] * x[2 * i + 1]; yi += eq.w[2 * i] * x[2 * i + 1] + eq.w[2 * i + 1] * x[2 * i]; }
      acc[k & 1][0] += yr; acc[k & 1][1] += yi; cnt[k & 1]++;
    }
    r.a = [acc[0][0] / cnt[0], acc[0][1] / cnt[0]];
    r.b = [acc[1][0] / cnt[1], acc[1][1] / cnt[1]];
    const t = this._trk();
    t.pow = 0; t.pz = null;               // a new output domain: see _p3Solve
  }

  /** The equaliser's input row for symbol idx at base, as _eqApply lays it out. */
  _eqRow(base, idx) {
    const row = new Float64Array(2 * EQ_N);
    let j = 0;
    for (let m = -EQ_L; m <= EQ_L; m++) {
      const a = this._symInto(base, idx + m, [0, 0]); row[j++] = a[0]; row[j++] = a[1];
      if (m < EQ_L) { const b = this._symInto(base + SPS / 2, idx + m, [0, 0]); row[j++] = b[0]; row[j++] = b[1]; }
    }
    return row;
  }

  /**
   * The equaliser solved for from PP. Rows are the equaliser's own inputs; the
   * targets PP's points as sent, turned by the carrier loop's learnt turn so the
   * fit ends on the rotator's zero. Each alignment within PP_SEARCH is fitted and
   * the least error kept, as BinModem tries each alignment either side of where
   * its S̄ put the sequence. Then S's references are read again through the new
   * equaliser, so the decisions that follow are made in the domain it outputs.
   * A fit worse than PP_ENOUGH changes nothing: not a PP after all (V.90's analogue
   * modem's Phase 3 is not plain V.34's), or not enough of one.
   */
  /**
   * The wide search's candidates: each alignment within PP_WIDE scored by how the
   * raw centre samples correlate with PP, and the best PP_WIDE_TRIES taken with a
   * symbol either side. On a line with one strong path that alone points at the
   * place (BinModem's words), and only a few need solving.
   */
  _ppWideCandidates(r, ppAt) {
    const scored = [];
    for (let d = -PP_WIDE; d <= PP_WIDE; d++) {
      let sr = 0, si = 0;
      for (let k = PP_SKIPPED; k < PP_SKIPPED + PP_SOLVED; k++) {
        const x = this._symInto(r.base, ppAt + d + k, [0, 0]), p = PP_REF[k];
        sr += x[0] * p.i + x[1] * p.q; si += x[1] * p.i - x[0] * p.q;
      }
      scored.push([sr * sr + si * si, d]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    const out = new Set();
    for (const [, d] of scored.slice(0, PP_WIDE_TRIES)) for (const e of [d - 1, d, d + 1]) out.add(e);
    return [...out];
  }

  _p3Solve(r, ppAt, deltas) {
    const t = this._trk();
    const k0 = PP_SKIPPED, k1 = PP_SKIPPED + PP_SOLVED, end = ppAt + k1;
    const fits = [];
    for (const d of deltas) {
      const rows = [], tg = [];
      for (let k = k0; k < k1; k++) {
        const idx = ppAt + d + k;
        rows.push(this._eqRow(r.base, idx));
        const p = PP_REF[k], g = this._g.pp, th = t.dth * (idx - (end + d));
        const c = Math.cos(th), sn = Math.sin(th);
        tg.push([(p.i * c - p.q * sn) * g, (p.i * sn + p.q * c) * g]);
      }
      const w = leastSquares(rows, tg, EQ_N);
      if (!w) continue;
      let e = 0, pw = 0;
      for (let k = 0; k < rows.length; k++) {
        let yr = 0, yi = 0;
        const x = rows[k];
        for (let i = 0; i < EQ_N; i++) { yr += w[2 * i] * x[2 * i] - w[2 * i + 1] * x[2 * i + 1]; yi += w[2 * i] * x[2 * i + 1] + w[2 * i + 1] * x[2 * i]; }
        e += (yr - tg[k][0]) ** 2 + (yi - tg[k][1]) ** 2; pw += tg[k][0] ** 2 + tg[k][1] ** 2;
      }
      const mse = e / pw;
      // Where the taps' energy sits, in symbols from the centre.
      let num = 0, den = 0;
      for (let i = 0; i < EQ_N; i++) { const q = w[2 * i] ** 2 + w[2 * i + 1] ** 2; num += q * (i - 2 * EQ_L) / 2; den += q; }
      const delay = num / (den || 1);
      fits.push({ mse, w, d, delay, off: Math.abs(delay) });
    }
    // An equaliser spanning ±EQ_L fits nearly as well shifted by a few symbols,
    // and the least error alone took a shift that put its taps at one end. So among
    // the fits within PP_TIE of the best, the one whose taps sit most centred.
    let best = null;
    const least = Math.min(...fits.map(f => f.mse));
    for (const f of fits) if (f.mse <= PP_TIE * least && (!best || f.off < best.off)) best = f;
    if (best) this._ppRefine(r, ppAt, best, t);
    this._ppFit = best && { mse: best.mse, d: best.d, delay: best.delay };
    if (!best || best.mse > PP_ENOUGH) return false;
    const eq = this._eq;
    eq.w.set(best.w);
    this._ppTaps = Float64Array.from(best.w);
    eq.c0.clear(); eq.c1.clear(); eq.base = NaN;
    // The rotator restarts from the fit's end, turning as it had learnt.
    t.th = t.dth * (r.idx - (end + best.d)); t.c = Math.cos(t.th); t.s = Math.sin(t.th);
    // The output is in a new domain now (the transmitted level, some 40 times the
    // received one), and the timing detector normalises by a slow average of the
    // decisions' power: left as it was, its error read 1600 times too large for
    // hundreds of symbols, kicked the instant about, and cost the rate two rungs.
    t.pow = 0; t.pz = null;
    // S's two points through the solved equaliser, from the stretch of S before
    // S̄, named by parity. Which of them parity calls A depends on the equaliser's
    // delay, which can sit at half a symbol; so the S̄ direction the J decoder reads
    // is resolved again below against these same references, which makes any
    // naming consistent.
    const sbarAt = ppAt - P3.SBAR_SYMBOLS + best.d;
    const acc = [[0, 0], [0, 0]], cnt = [0, 0];
    for (let k = Math.max(EQ_L + 2, sbarAt - 48); k < sbarAt - 4; k++) {
      const x = this._eqRow(r.base, k);
      let yr = 0, yi = 0;
      for (let i = 0; i < EQ_N; i++) { yr += eq.w[2 * i] * x[2 * i] - eq.w[2 * i + 1] * x[2 * i + 1]; yi += eq.w[2 * i] * x[2 * i + 1] + eq.w[2 * i + 1] * x[2 * i]; }
      const th = -t.dth * (k - (end + best.d)), c = Math.cos(th), sn = Math.sin(th);
      const p = k & 1;
      acc[p][0] += yr * c - yi * sn; acc[p][1] += yr * sn + yi * c; cnt[p]++;
    }
    if (cnt[0] && cnt[1]) {
      r.a = [acc[0][0] / cnt[0], acc[0][1] / cnt[0]];
      r.b = [acc[1][0] / cnt[1], acc[1][1] / cnt[1]];
      delete r.eqB;
    }
    // The S̄ direction (reflect), resolved again against the new references: the
    // first S̄-like symbol after S-like ones, through the solved equaliser, found by
    // scanning either side of where the fit put S̄. And if only the raw detector
    // saw S̄, what the rotation detector would have set with it.
    const p3 = this.p3;
    if (p3) {
      const rotAt = (k) => {
        const x = this._eqRow(r.base, k);
        let yr = 0, yi = 0;
        for (let i = 0; i < EQ_N; i++) { yr += eq.w[2 * i] * x[2 * i] - eq.w[2 * i + 1] * x[2 * i + 1]; yi += eq.w[2 * i] * x[2 * i + 1] + eq.w[2 * i + 1] * x[2 * i]; }
        const th = -t.dth * (k - (end + best.d)), c = Math.cos(th), sn = Math.sin(th);
        const z = [yr * c - yi * sn, yr * sn + yi * c];
        let rot = 0, bd = -Infinity;
        for (let q = 0; q < 4; q++) { const ref = this._eqTarget(r, q), dt = z[0] * ref[0] + z[1] * ref[1]; if (dt > bd) { bd = dt; rot = q; } }
        return rot;
      };
      let first = null;
      for (let k = sbarAt - 8; k <= sbarAt + 8 && first === null; k++) {
        const isS = q => q === 0 || q === 3;
        if (!isS(rotAt(k)) && isS(rotAt(k - 1)) && isS(rotAt(k - 2)) && !isS(rotAt(k + 1))) first = rotAt(k);
      }
      if (first !== null) {
        p3.sCount = Math.max(p3.sCount, 1);
        if (p3.sbarCount === 0) { p3.sbarCount = 1; p3.inS = false; }
        p3.runFirstRot = first;
        p3.parityKnown = false;
        this._resolveP3Parity(p3);
      }
    }
    // Trained: the fine step from here, and the error the rate is chosen from is
    // measured after EQ_SETTLE more symbols.
    eq.trained = EQ_COARSE;
    eq.epsSum = 0; eq.epsN = 0;
    return true;
  }

  /**
   * The ideal point for rotation `rot` of S's reference: r.a turned by quarter
   * turns, with the direction of S's own A-to-B step (which of ±90° r.b is
   * nearer) — the same resolution the classification makes, without r.b's error.
   */
  _eqTarget(r, rot) {
    if (!r.eqB) {
      const a = r.a, b = r.b;
      const p = [-a[1], a[0]], m = [a[1], -a[0]];               // a·j and a·(−j)
      const dp = (b[0] - p[0]) ** 2 + (b[1] - p[1]) ** 2, dm = (b[0] - m[0]) ** 2 + (b[1] - m[1]) ** 2;
      r.eqB = dp < dm ? p : m;
    }
    const a = r.a, b = r.eqB;
    switch (rot) {
      case 0: return a;
      case 3: return b;
      case 2: return [-a[0], -a[1]];
      default: return [-b[0], -b[1]];
    }
  }

  /** One normalised-LMS step toward `ti, tq`, for the symbol _eqApply last produced. */
  _eqUpdate(ti, tq, mu) {
    const eq = this._eq, x = eq.x, w = eq.w;
    const ei = ti - eq.y[0], eq_ = tq - eq.y[1];
    let p = 1e-12;
    for (let k = 0; k < 2 * EQ_N; k++) p += x[k] * x[k];
    const g = mu / p;
    for (let k = 0; k < 2 * EQ_N; k += 2) {
      // w += mu · e · conj(x) / |x|²
      w[k]     += g * (ei * x[k] + eq_ * x[k + 1]);
      w[k + 1] += g * (eq_ * x[k] - ei * x[k + 1]);
    }
  }

  // pos for symbol idx, summed the exact way (integer SPS_P steps) rather than by
  // idx*SPS, which accumulates rounding over a burst of thousands of symbols.
  _symPos(base, idx) {
    const ph = ((idx % SPS_Q) + SPS_Q) % SPS_Q;
    return base + ph * SPS + ((idx - ph) / SPS_Q) * SPS_P;
  }

  _symAt(base, idx) { return this._symInto(base, idx, [0, 0]); }

  /**
   * The same filter, writing into a caller-supplied pair.
   *
   * Identical arithmetic to _symAt — this is where it lives and _symAt is the
   * allocating wrapper. The two timing searches evaluate thousands of symbols and
   * keep none of them, and a two-element array per symbol was the largest source of
   * garbage in an acquisition; a caller that RETAINS its results (the preamble scan
   * builds a list of them) still uses _symAt and gets its own array.
   */
  _symInto(base, idx, out) {
    const ph = ((idx % SPS_Q) + SPS_Q) % SPS_Q, m = (idx - ph) / SPS_Q;
    const bk = this._symBank(base);
    const w = bk.W[ph], n0 = bk.N0[ph] + m * SPS_P;
    const B = this.rxBase, I = this.rxI, Q = this.rxQ;
    const lo = Math.max(0, B - n0);
    const hi = Math.min(bk.LEN[ph] - 1, B + this.rxLen - 1 - n0);
    let ai = 0, aq = 0;
    for (let j = lo; j <= hi; j++) { const p = w[j], k = n0 + j - B; ai += I[k] * p; aq += Q[k] * p; }
    out[0] = ai; out[1] = aq;
    return out;
  }

  /**
   * |y| for one symbol, with nothing allocated at all. The timing searches maximise
   * summed magnitude and never look at the phase, which is the whole of their inner
   * loop.
   */
  _symMag(base, idx) {
    const s = this._symInto(base, idx, this._symScratch);
    return Math.sqrt(s[0] * s[0] + s[1] * s[1]);
  }

  /**
   * The front end's AGC: every detector from here on was set against our own line
   * level, and a far end after 20 dB of loss arrived below all of Phase 2's. The
   * gain follows the received RMS while there is a signal (above AGC_FLOOR), never
   * attenuates, and is frozen once Phase 2 is settled, so Phase 3, the canceller
   * and data see one gain and the equaliser and gain loops do the rest.
   */
  _agc(f32) {
    if (this._agcGain == null) { this._agcGain = 1; this._agcMs = 0; }
    const adapt = this._p2 && !this._p2.settled;
    if (!adapt && this._agcGain === 1) return f32;
    const out = new Float32Array(f32.length);
    for (let i = 0; i < f32.length; i++) {
      const x = f32[i];
      if (adapt) {
        const ms = this._agcMs + AGC_A * (x * x - this._agcMs);
        this._agcMs = ms;
        // Only while the level stands within AGC_HOLD of its recent peak: a
        // signal falling away into a gap otherwise drives the gain up after it,
        // and Phase 2 settled in one with the gain at 50 where 8 was right.
        this._agcPeak = Math.max(ms, (this._agcPeak || 0) * AGC_PEAK_DECAY);
        if (ms > AGC_FLOOR * AGC_FLOOR && ms > this._agcPeak * AGC_HOLD) {
          this._agcGain = Math.min(AGC_MAX, Math.max(1, AGC_TARGET / Math.sqrt(ms)));
        }
      }
      out[i] = x * this._agcGain;          // held from Phase 2's end onward
    }
    return out;
  }

  receiveAudio(f32) {
    f32 = this._agc(f32);
    // §11.2's detectors run on the raw samples and are done with once Phase 2 is:
    // Phase 3 and the data burst are QAM at the selected symbol rate and have
    // nothing to say to a 600 bit/s DPSK demodulator.
    if (this._p2 && !this._p2.settled) this._p2Receive(f32);
    // §11.6.2: a renegotiation that does not come back is a retrain.
    if (this._reneg && !this._renegInData && this._ecRx - this._reneg.at > RN_TIMEOUT) this._beginRetrain('renegotiation failed');
    const e = this._ecSpan;
    for (let i = 0; i < f32.length; i++) {
      const en = this._ecRx++;
      let s = f32[i];
      if (this._ecOn) {
        if (this._ecState === 'before' && e.trnStart != null && en >= e.trnStart) { this._ec.beginTraining(() => e.searchFrom); this._ecState = 'training'; }
        if (this._ecState === 'training' && e.trnEnd != null && en >= e.trnEnd) { this._ec.endTraining(); this._ecState = 'held'; }
        s = this._ec.process(en, s);
        // Our own Phase 3 and its echo tail: nothing to hear.
        if (e.start != null && en >= e.start && (e.end == null || en < e.end + EC_GUARD)) s = 0;
      }
      // From Phase 3 on, in start-up as in data mode: §11.3.2 and §11.4.2 answer
      // their bounds with a retrain, which the far end may begin there.
      if ((this._ready || (this._p2 && this._p2.settled)) && !this._retraining && !this._noRetrain && this._retrainWatch(s)) {
        this._ownStepDown = false;
        this._beginRetrain('far end');
        if (this._p2 && !this._p2.settled) this._p2Receive(f32.subarray(i + 1));
        // The rest of this block goes to Phase 2's detectors, which took the
        // block's head before the tone was found.
      }
      this.rxLevel += RX_A * (Math.abs(s) - this.rxLevel);
      if (this.rxLevel > RX_HI) { this.rxOn = true; this.rxLow = 0; }
      else if (this.rxLevel < RX_LO && this.rxOn) { this.rxLow++; }
      if (this.rxOn) {
        if (this.rxLen === this.rxCap) this._growRx();
        const ci = carIdx(this.rxBase + this.rxLen), L = this.rxLen++;
        this.rx[L] = s;
        this.rxI[L] = s * CAR_COS[ci] * 2;
        this.rxQ[L] = -s * CAR_SIN[ci] * 2;
      }
      if (this.rxOn && this.rxLow > RX_HANG) {
        this._process();
        if (this._rxData) { this._rxRelease(true); this._uartConsume(); }
        // A silence ends Phase 3 only once the peer has sent every S-to-S̄ transition
        // its procedure contains. V.90's analogue modem falls silent MID-Phase 3
        // (§9.3.2.4) and resumes with S after Jd, so a receiver that took the first
        // silence for the end would hand §9.3.2.7's S to the data acquisition.
        // Recorded before _resetRx, which reads it to decide what comes next.
        this.rxOn = false;
        this._resetRx();
      }
    }
    if (this.rxOn) this._process();
  }

  /**
   * Find the S-to-S̄ transition, which is §11.3.1.1.1's gate.
   *
   * S and S̄ have the SAME differential signature — both alternate by ±90°, since S̄
   * is S rotated by 180° — so a differential detector cannot separate them and the
   * reference has to be absolute. The two-symbol reference `_sRef` is taken from the
   * head of S once its structure is confirmed, and the transition is then the point
   * at which both parities correlate NEGATIVELY against it. That is rotation- and
   * gain-invariant with respect to the channel, which is what lets it run before any
   * of the data path's acquisition exists.
   *
   * The scan is forward-only (`_sHuntPos` is an absolute index that only advances),
   * for the reason V90's `_huntSd` gives: rescanning the buffer on every chunk is
   * quadratic, and with a one-second answer tone in front of it that is slow enough
   * to look like a hang rather than like arithmetic.
   */
  _huntSbar() {
    const CONFIRM = 16;                 // symbols of S structure required before trusting it
    const need = Math.ceil((CONFIRM + 4) * SPS + SPAN * SPS);
    if (this.rxLen < need) return;

    // A rejected candidate is stepped past and the next tried at once: one per
    // block advanced 4 symbols in 68, and an early onset never caught up with S.
    while (!this._sRef) {
      // Onset, then the same fractional timing search the data path uses. S is
      // constant-modulus, so maximising summed symbol magnitude finds the ISI-free
      // instant exactly as it does on the preamble.
      const onset = this._scanOnset();
      if (onset < 0) return;
      // The candidate is judged once its whole confirmation window is in, and
      // stepped past if it fails: a buffer that opens on the far end's start-up
      // transient (BinModem's Phase 4, after its silence) failed on the same
      // onset at every block for ever.
      if (onset + (CONFIRM + 4) * SPS + SPAN * SPS >= this.rxLen) return;
      const reject = () => { this._onsetHit = Math.ceil(onset + 4 * SPS); };
      // Coarse to fine: an eighth of a symbol across ±2, then a sixty-fourth across
      // the eighth either side of the best. The same grid as the exhaustive search
      // it replaced, at 50 positions rather than 257, every one a dozen filtered
      // symbols; it ran for every candidate onset a block, which with no S yet on
      // the line was most of the call's CPU.
      const score = (bo) => { let sc = 0; for (let k = 0; k < 12; k++) sc += this._symMag(bo, k); return sc; };
      let best = onset, bestScore = -1;
      const lo = Math.max(0, onset - 2 * SPS);
      for (let m = 0; lo + m * SPS / 8 <= onset + 2 * SPS; m++) {
        const bo = lo + m * SPS / 8, sc = score(bo);
        if (sc > bestScore) { bestScore = sc; best = bo; }
      }
      const centre = best;
      for (let m = -8; m <= 8; m++) {
        const bo = centre + m * SPS / 64;
        if (m === 0 || bo < lo || bo > onset + 2 * SPS) continue;
        const sc = score(bo);
        if (sc > bestScore) { bestScore = sc; best = bo; }
      }
      // Confirm this really is S before adopting a reference from it, by what a
      // linear line leaves of it: a two-symbol period, two distinct states, and a
      // mean (the carrier's own line) beside their half-difference (the lines at
      // the carrier ± half the symbol rate); a 180° alternation's have no mean.
      // Anything else — a V.21 tail, a truncated tone — fails here. The
      // constant-modulus test this replaced failed on any tilt: those two outer
      // lines sit at the band's two edges.
      const sIQ = [];
      for (let j = 0; j < CONFIRM; j++) sIQ.push(this._symAt(best, j));
      let pw = 0;
      for (const v of sIQ) pw += v[0] * v[0] + v[1] * v[1];
      pw /= CONFIRM;
      if (pw < 1e-12) { reject(); continue; }
      let rep = 0;
      for (let j = 2; j < CONFIRM; j++) rep += (sIQ[j][0] - sIQ[j - 2][0]) ** 2 + (sIQ[j][1] - sIQ[j - 2][1]) ** 2;
      if (rep / (CONFIRM - 2) > 0.05 * pw) { reject(); continue; }
      {
        const ev = [0, 0], od = [0, 0];
        for (let j = 0; j < CONFIRM; j++) { const t = (j & 1) ? od : ev; t[0] += sIQ[j][0]; t[1] += sIQ[j][1]; }
        const h = CONFIRM / 2;
        const mean = Math.hypot(ev[0] + od[0], ev[1] + od[1]) / (2 * h), diff = Math.hypot(ev[0] - od[0], ev[1] - od[1]) / (2 * h);
        if (diff * diff < 0.1 * pw || mean < 0.25 * diff || mean > 4 * diff) { reject(); continue; }
      }
      const mAvg = Math.sqrt(pw);
      // Average each parity: S alternates two fixed points, so the even-index mean
      // and the odd-index mean ARE the channel's view of them.
      const acc = [[0, 0], [0, 0]], cnt = [0, 0];
      for (let j = 0; j < CONFIRM; j++) {
        const p = j & 1; acc[p][0] += sIQ[j][0]; acc[p][1] += sIQ[j][1]; cnt[p]++;
      }
      // A new reference absorbs the carrier's phase as it stands; the learnt turn
      // per symbol carries on.
      { const t = this._trk(); t.th = 0; t.c = 1; t.s = 0; t.acc = 0; }
      this._sRef = {
        base: best, idx: CONFIRM,
        a: [acc[0][0] / cnt[0], acc[0][1] / cnt[0]],
        b: [acc[1][0] / cnt[1], acc[1][1] / cnt[1]],
      };
      this._sMag = mAvg;
      // A burst after the one PP was solved on (Phase 4's): the line has not
      // changed, so the solved equaliser still fits it, and only the timing and
      // the carrier's phase are new (BinModem's reacquire reasons the same way).
      // Begun from the identity instead, Phase 4's equaliser fought the loops
      // again, and BinModem's MP was heard too late to answer.
      if (this._ppTaps) this._eqFromSolved(this._sRef);
    }

    // Walk forward, classifying every symbol against the FOUR rotations of point 0.
    // The reference gives rotation 0 and rotation 3 directly (S's two points), and
    // the other two are their negations, so one confirmed stretch of S calibrates
    // the whole constellation — which is what lets everything after it (S̄ runs, and
    // the differentially encoded bits of J, J′ and Ja) be read without any further
    // acquisition. The timing and carrier found on S are followed from here on
    // (_trkTiming, _trkPhase), so they still hold 1500 symbols later against a far
    // clock with its own drift.
    const r = this._sRef;
    const end = this.rxBase + this.rxLen - 1;
    for (;;) {
      // The equaliser reads EQ_L symbols ahead, and caches what it reads, so a
      // symbol is taken only once all of those have arrived.
      const pos = this._symPos(r.base, r.idx + EQ_L);
      if (pos + SPAN / 2 * SPS >= end) return;
      const s = this._trkDerotate(this._eqApply(r.base, r.idx), this._trkY || (this._trkY = [0, 0]));
      r.idx++;

      // ref[0] and ref[3] are S's two points; S̄'s are their negations (§10.1.3.7).
      let bestRot = 0, bestDot = -Infinity, bestRef = r.a;
      for (let rot = 0; rot < 4; rot++) {
        const ref = (rot === 0) ? r.a : (rot === 3) ? r.b
                  : (rot === 2) ? [-r.a[0], -r.a[1]] : [-r.b[0], -r.b[1]];
        const dot = s[0] * ref[0] + s[1] * ref[1];
        if (dot > bestDot) { bestDot = dot; bestRot = rot; bestRef = ref; }
      }
      // Train on it if it is clearly that point — PP and the gaps are not. The
      // target is the IDEAL point, r.a turned by the classified quarter-turns, not
      // S's second measured point: on a filtered path (V.90's upstream through a
      // codec) S itself is read with ISI, r.b is not r.a turned 90°, and aiming at
      // both left the equaliser fitting an inconsistent constellation — it
      // floored at 0.012 where least squares on the same symbols reaches 0.0003.
      {
        const t = this._eqTarget(r, bestRot);
        const ei = t[0] - s[0], eq = t[1] - s[1];
        const r2 = t[0] * t[0] + t[1] * t[1];
        const e2 = ei * ei + eq * eq;
        if (e2 < EQ_GATE * r2) {
          const eqs = this._eq;
          const tf = this._trkRotate(t[0], t[1]);
          this._eqUpdate(tf[0], tf[1], eqs.trained < EQ_COARSE ? EQ_MU_TRAIN : EQ_MU_FINE);
          if (++eqs.trained > EQ_COARSE + EQ_SETTLE) { eqs.epsSum += e2 / r2; eqs.epsN++; }
        }
        // The carrier loop has its own, looser gate. Under the equaliser's alone, a
        // far carrier 0.2 Hz off turned the points out of it within 1700 symbols,
        // and with nothing updating, nothing could bring them back. This one takes
        // any symbol within TRK_GATE of its point in angle and roughly at its
        // radius, which a rotating QPSK keeps and PP's points do not.
        const pa = Math.atan2(t[0] * s[1] - t[1] * s[0], t[0] * s[0] + t[1] * s[1]);
        const rr = (s[0] * s[0] + s[1] * s[1]) / r2;
        const near = Math.abs(pa) < TRK_GATE && rr > 0.4 && rr < 2.5;
        if (near) this._trkPhase(pa);
        r.nb = this._trkTiming(r.base, s, near ? t : null);
      }
      r.base = r.nb;
      this._p3Symbol(bestRot, r.idx - 1);
      if (this.rxPhase !== 'phase3') return;    // E was read: data mode has the rest
      this._rawSbar(r, r.idx - 1);
      const pp = this.p3 && this.p3.ppAt;
      if (pp != null && !this.p3.ppSolved && r.idx >= pp + PP_SKIPPED + PP_SOLVED + PP_SEARCH + 2) {
        this.p3.ppSolved = true;
        const d = [];
        for (let k = -PP_SEARCH; k <= PP_SEARCH; k++) d.push(k);
        if (!this._p3Solve(r, pp, d)) this.p3.ppWide = true;
      }
      if (pp != null && this.p3.ppWide && r.idx >= pp + PP_SKIPPED + PP_SOLVED + PP_WIDE + 2) {
        this.p3.ppWide = false;
        this._p3Solve(r, pp, this._ppWideCandidates(r, pp));
      }
    }
  }

  /**
   * One classified Phase 3 symbol: track the S / S̄ alternation, and demodulate the
   * differential bit stream that J, J′ and Ja ride on.
   *
   * S is a strict alternation between rotations 0 and 3, S̄ between 2 and 1. PP, TRN
   * and Ja are none of those, so requiring an alternation of a minimum LENGTH is what
   * separates a signal from a run of training symbols that happens to land on two
   * values — and the run length is why a stray symbol cannot manufacture a
   * transition.
   */
  _p3Symbol(rot, symIdx) {
    const p = this.p3;
    const isS = (rot === 0 || rot === 3), isSbar = (rot === 1 || rot === 2);
    const kind = isS ? 's' : isSbar ? 'sbar' : null;

    // An alternation continues only if the rotation CHANGED — two identical
    // rotations in a row are not S, however well each one classifies.
    if (kind && kind === p.runKind && rot !== p.lastRot) p.runLen++;
    else { p.runKind = kind; p.runLen = 1; p.runFirstRot = rot; }
    p.lastRot = rot;

    if (p.runLen === P3_RUN_CONFIRM) {
      if (p.runKind === 's') {
        p.sCount++;
        p.inS = true;
      } else if (p.runKind === 'sbar' && p.inS) {
        // §11.3.1.1.1 / §9.3.1.4's "S and the S-to-S̄ transition": a confirmed S̄ run
        // that follows a confirmed S run, which is the only reading of "transition"
        // that a receiver can act on.
        p.sbarCount++;
        p.inS = false;
        // The first S-to-S̄ of a plain V.34 Phase 3 is followed by PP: where it
        // starts, for the solve. S̄ began P3_RUN_CONFIRM − 1 symbols back. This
        // overrules the raw detector's guess, which a dip in S can mislead and
        // which this one, where it sees S̄ at all, does not.
        if (p.sbarCount === 1 && !p.ppSolved) p.ppAt = symIdx - (P3_RUN_CONFIRM - 1) + P3.SBAR_SYMBOLS;
        this._resolveP3Parity(p);
        // §11.6.1.2.2: the responder's own S, S̄, TRN and MP follow the transition.
        if (this._reneg && !this._reneg.txStarted) this._renegTx();
      }
    }

    // §8.3.1's Ja and §10.1.3.3's J both ride the differential encoder, so both fall
    // out of the same decode. Differential DECODING needs no initial state, and the
    // clause 7 scrambler is self-synchronising, so neither the TRN symbol the encoder
    // was initialised from nor the scrambler's state has to be known here.
    const ib = p.dec.bits(p.reflect ? (3 - rot) & 3 : rot);
    if (ib) {
      for (const bit of ib) {
        const reg = p.des3;
        const ob = bit ^ reg[this._rxTap] ^ reg[22];
        reg.unshift(bit); reg.pop();
        // Where this decoder's output starts, in symbols: every symbol after the
        // first yields exactly two bits, so one anchor maps any bit back to the
        // symbol that carried it (see _huntE).
        if (!p.anchor) p.anchor = { abs: p.trimmed + p.bits.length, sym: symIdx };
        p.bits.push(ob);
        if (p.parityKnown) this._huntJ(ob);
      }
      // Bounded: a consumer that is not reading is not a reason to grow without
      // limit, and nothing needs more history than one descriptor.
      if (p.bits.length > P3_BIT_CAP) {
        const drop = p.bits.length - P3_BIT_CAP;
        p.bits.splice(0, drop); p.trimmed += drop;
      }
      this._huntMP();
      this._huntE();
    }
  }

  /**
   * J, read one descrambled bit at a time.
   *
   * J (§10.1.3.3) is a whole number of repetitions of one of Table 18's two
   * patterns, which differ only in the size they ask this end to transmit Phase 4
   * in; two consecutive repetitions is a J.
   */
  _huntJ(bit) {
    const p = this.p3;
    p.jWin = ((p.jWin << 1) | bit) >>> 0;
    p.jHave = Math.min(32, (p.jHave || 0) + 1);
    if (!this._peerJ && p.jHave === 32) {
      if (p.jWin === J_WIN_4) this._peerJ = 4;
      else if (p.jWin === J_WIN_16) this._peerJ = 16;
    }
  }

  /**
   * E (§10.1.3.2): "a 20-bit sequence of binary ones used to signal the end of MP".
   *
   * The far end sends it only once it holds an acknowledgement — MP′ in V.34
   * (§11.4.1.1.3, §11.4.1.2.3), CP′ in V.90 (§9.4.2.4) — and both hunts cut the
   * acknowledging sequence out of the front of the ring, so once armed the scan
   * starts there and the first twenty ones are E: the fill bits before it are zeros,
   * and a sequence's own frame sync is seventeen ones followed by a start bit of 0.
   * Lazy rather than per bit, because V.90's hunt for CP′ runs after these symbols
   * have been decoded, not between them. B1 begins on the symbol after E's last.
   */
  _huntE() {
    const p = this.p3;
    if (this.rxPhase !== 'phase3' || !p.anchor || !this._eArmed()) return;
    if (p.eScan == null || p.eScan < p.trimmed) { p.eScan = p.trimmed; p.eRun = 0; }
    const end = p.trimmed + p.bits.length;
    for (; p.eScan < end; p.eScan++) {
      p.eRun = p.bits[p.eScan - p.trimmed] ? p.eRun + 1 : 0;
      if (p.eRun === V34Phase4.E_BITS) {
        this._peerE = true;
        const sym = p.anchor.sym + Math.floor((p.eScan - p.anchor.abs) / 2);
        this._enterDataRx(sym + 1);
        return;
      }
    }
  }

  /** Whether the far end's acknowledgement has arrived, so that E may follow. */
  _eArmed() {
    if (this._p4) return !!(this._p4.ackSeen && this._p4.ackSeen());
    return !!this.peerMPPrime;
  }

  /**
   * Data mode, from symbol `b1` on: B1 (§10.1.3.1), then data.
   *
   * The timing is S's and stays S's — the same base, the same symbol clock — and so
   * is the gain. §10.1.3's NOTE has the average power of Phases 3 and 4 maintained
   * in B1 and data mode, and this end's S reference is one of point 0's rotations at
   * that power, so dividing by it puts the data constellation on its own lattice.
   * Which rotation the reference holds is what the parity resolution settled.
   */
  _enterDataRx(b1) {
    const r = this._sRef;
    if (!r) return;
    const tx = P3.rotCW(P3.POINT0, this.p3.reflect ? 3 : 0);
    this._useRate();
    const t2 = (tx.i * tx.i + tx.q * tx.q) * this._rxD.p3GainS;   // the received rate's lattice
    // g = received / transmitted, complex.
    this.gr = (r.a[0] * tx.i + r.a[1] * tx.q) / t2;
    this.gi = (r.a[1] * tx.i - r.a[0] * tx.q) / t2;
    this.g2 = this.gr * this.gr + this.gi * this.gi || 1e-9;
    this.base = r.base;
    this.symIdx = b1;
    this.rxPts = [];
    this.rxFrameIdx = 0;
    this.rxCoder.reset();
    // The trellis starts at state 0 and V0's count at B1, as the encoder does.
    this._vit = new V34Viterbi(this._rxD.cfg.J, this._rxD.cfg.P);
    this._vitHard = [];
    this.des.fill(0);
    this.outbits = [];
    this._rxHold = [];
    this.uState = 'hunt'; this.uArmed = false; this.uMarks = 0;
    this._rxData = true;
    this._rxErrFast = 0; this._clamp104 = false; this._rxErrSlow = 0; this._unsat = 0; this._marginal = 0;
    this.acq = true;
    this.rxPhase = 'data';
    this._sw = null;
    this._startupRetrains = 0;
    this._rateSetAt = this._ecRx; this._better = 0;
    // A step up that came back where it started: the far end's receiver is the
    // limit, and asking again soon would only cost the link another exchange.
    if (this._forwardFrom != null) {
      this._forwardBackoff = this._rate <= this._forwardFrom ? (this._forwardBackoff || 1) * 2 : 1;
      this._forwardFrom = null;
    }
    // A retrain begun in start-up comes back to nothing: the link's first data is
    // its `ready`, below.
    if (this._retraining) { this._retraining = false; this._reneg = null; if (this._ready) this.emit('retrained', { bps: this._rate }); }
    if (!this._ready) { this._ready = true; this.emit('ready', { bps: this._rate, remoteDetected: true }); }
  }

  /**
   * §11.4 — MP arrives in this same stream now, because §10.1.3.9's 4-point form is
   * §10.1.3.3's chain and that is what the decode above already inverts. The frame
   * sync locates a candidate and the CRC is what separates it from TRN, whose
   * descrambled bits are constant ones and cannot also satisfy sixteen CRC bits.
   *
   * V.90's analogue modem does not run this: its Phase 4 upstream carries CP, and
   * the digital modem's own hunt reads these bits from the outside.
   */
  _huntMP() {
    // Kept running past the first MP: an MP′ is the far end saying it read THIS
    // modem's parameters, and stopping at the first sequence turns an exchange back
    // into two transmissions. The stage machine still advances on `peerMP`, so a peer
    // whose MP′ never arrives still reaches data mode.
    if (this._p4 || this.peerMPPrime) return;
    const p = this.p3;
    const b = p && p.bits;
    if (!b) return;
    const N = V34Phase4.MP_BITS;
    // CRC'd in place, from a cursor that never revisits a position it has already
    // rejected: TRN descrambles to constant ones, so every position in it opens a
    // frame sync and a hunt that parsed each candidate would run a full CRC per bit
    // of a 512-symbol signal — for every symbol received.
    const hit = V34Phase4.findSequence(b, this._mpScan - p.trimmed, N, 17, (at) =>
      V34Phase4.mpCrcBits(b, at) ===
        V34Phase4.getUInt(b, at + V34Phase4.MP_CRC_START + 1, at + V34Phase4.MP_CRC_START + 16));
    this._mpScan = hit.scanned + p.trimmed;
    if (hit.at < 0) return;
    const mp = V34Phase4.parseMP(b.slice(hit.at, hit.at + N));
    if (mp.type !== 0) return;
    this._acceptMP(mp);
    if (mp.ack) this.peerMPPrime = mp;
    const drop = hit.at + N;
    b.splice(0, drop); p.trimmed += drop;
    this._mpScan = p.trimmed;
  }

  _process() {
    // Phases 3 and 4 are read as S-referenced rotations until E; data mode, below,
    // takes over at B1 on the same timing.
    if (this.rxPhase === 'phase3') { this._huntSbar(); return; }

    // Data mode is entered from Phase 4 at B1 and nowhere else.
    if (!this.acq) return;

    while (true) {
      const pos = this._symPos(this.base, this.symIdx + EQ_L);
      const end = this.rxBase + this.rxLen - 1;
      if (pos + SPAN / 2 * SPS >= end) break;
      const s = this._trkDerotate(this._eqApply(this.base, this.symIdx), this._trkY || (this._trkY = [0, 0]));
      const xI = (s[0] * this.gr + s[1] * this.gi) / this.g2;
      const xQ = (s[1] * this.gr - s[0] * this.gi) / this.g2;
      // slice to the nearest odd-integer lattice point (the transmitted point on
      // the lossless link); guard against a rep outside the quarter set.
      const pt = { i: sliceOdd(xI), q: sliceOdd(xQ) };
      // The gain from S is the far end's at training. It is held, not trusted: a
      // one-tap decision-directed update follows whatever the far transmitter's
      // data power and phase turn out to be. On a lossless loopback the error is
      // zero and it does not move.
      {
        // The level only: the carrier tracker owns the phase, and a complex update
        // here was a third loop that could take it, with the split between them
        // free to wander — which it did, through a whole turn in a few seconds.
        const pp = pt.i * pt.i + pt.q * pt.q;
        const k = 1 + RX_GAIN_MU * ((xI * pt.i + xQ * pt.q) / pp - 1);
        this.gr *= k; this.gi *= k;
        this.g2 = this.gr * this.gr + this.gi * this.gi || 1e-9;
        // And the equaliser, decision-directed, toward the same decision — turned
        // into its own domain — and the carrier tracker on the decision's phase.
        const tf = this._trkRotate(this.gr * pt.i - this.gi * pt.q, this.gr * pt.q + this.gi * pt.i);
        this._eqUpdate(tf[0], tf[1], EQ_MU_DATA);
        this._trkPhase((xQ * pt.i - xI * pt.q) / pp);
        this.base = this._trkTiming(this.base, [xI, xQ], [pt.i, pt.q]);
        const e2 = ((xI - pt.i) ** 2 + (xQ - pt.q) ** 2) / 2;
        this._rxErrFast += (e2 - this._rxErrFast) / RX_CLAMP_N;
        if (this._rxErrFast > RX_CLAMP_ON) this._clamp104 = true;
        else if (this._rxErrFast < RX_CLAMP_OFF) this._clamp104 = false;
        this._rxErrSlow += (e2 - this._rxErrSlow) / RX_UNSAT_N;
        this._unsat = this._rxErrSlow > RX_UNSAT ? this._unsat + 1 : 0;
        this._marginal = this._rxErrSlow > RX_FALLBACK ? (this._marginal || 0) + 1 : 0;
        if (this._marginal > BAUD && !this._retraining && !this._noRetrain && this._unsat === 0) {
          this._marginal = 0;
          const to = this._dataCap();
          if (to < this._rxD.bitRate) { this._ownStepDown = true; this._beginReneg(true, to); this._renegTx(); }
        }
        if ((this.symIdx & (RX_FORWARD_EVERY - 1)) === 0 && this._ownStepDown && this._rxD.bitRate < this._configuredRate &&
            !this._retraining && !this._noRetrain && this._unsat === 0 && this._marginal === 0) {
          const to = this._dataCap(RX_FORWARD_MARGIN);
          this._better = to > this._rxD.bitRate ? (this._better || 0) + RX_FORWARD_EVERY : 0;
          const gap = RX_CHANGE_GAP_S * SR * (this._forwardBackoff || 1);
          if (this._better > RX_FORWARD_S * BAUD && this._ecRx - (this._rateSetAt || 0) > gap) {
            this._better = 0;
            this._forwardFrom = this._rxD.bitRate;
            this._beginReneg(true, to); this._renegTx();
          }
        }
        if (this._unsat > BAUD && !this._retraining && !this._noRetrain) { this._ownStepDown = true; this._beginRetrain('unsatisfactory'); return; }
        if ((!this._noRetrain || this._renegInData) && !(this._reneg && this._reneg.rxStarted) && this._sInData(xI, xQ)) {
          if (!this._reneg) { this._beginReneg(false); this._ownStepDown = false; }
          this._clamp104 = true;
          this._renegRx();
          return;
        }
      }
      this.symIdx++;
      // §9.6's trellis code, decoded: the frame decoder takes Viterbi's points, a
      // fixed VIT_DEPTH of 4D symbols late, not the slicer's. The loops above keep
      // the slicer's, which they need now rather than later.
      this._vit.push([xI, xQ]);
      this._vitHard.push(pt);
      while (this._vit.out.length) this._rxPoint(this._vit.out.shift(), this._vitHard.shift());

      const drop = Math.floor(this.base + (this.symIdx - SPAN - RN_REWIND) * SPS) - this.rxBase;
      if (drop > 512) this._dropRx(drop);
    }
  }

  /** Whether the last RN_S_HELD data-mode points have been S's alternation. */
  _sInData(xI, xQ) {
    const w = this._sw || (this._sw = { h: [[0, 0], [0, 0]], rep: 1, turn: 0, pow: 1, held: 0 });
    const [a1, a2] = w.h;
    const pw = xI * xI + xQ * xQ;
    w.rep += (((xI - a2[0]) ** 2 + (xQ - a2[1]) ** 2) - w.rep) / RN_S_N;
    w.turn += (((xI - a1[0]) ** 2 + (xQ - a1[1]) ** 2) - w.turn) / RN_S_N;
    w.pow += (pw - w.pow) / RN_S_N;
    w.h = [[xI, xQ], a1];
    const s = w.rep < RN_S_REP * w.pow && w.turn > RN_S_TURN * w.pow;
    w.held = s ? w.held + 1 : 0;
    return w.held >= RN_S_HELD;
  }

  /** One decided data-mode point into the frame decoder (`hard` if it fell off the constellation). */
  _rxPoint(decided, hard) {
    let pt = decided;
    if (this._rxD.cfg.labelOf(invRot(pt).rep) < 0) pt = hard;
    if (this._rxD.cfg.labelOf(invRot(pt).rep) < 0) { this.rxPts = []; return; }  // resync on stray point
    this.rxPts.push(pt);
    if (this.rxPts.length === SYMS_PER_FRAME) {
      // This frame's parity is fixed by the SWP-driven counter, aligned to the TX
      // because acquisition lands on TX frame 0 and both advance one symbol per
      // symbol: timing tracking moves the instant, never the count. decodeFrame returns b (high) or b−1 (low) bits.
      // B1 is the first data frame (§10.1.3.1) and carries scrambled ones, not
      // data: it settles the descrambler and is not handed to the UART, which
      // would otherwise read the settling bits as characters.
      const rcfg = this._rxD.cfg;
      const inB1 = this.rxFrameIdx < rcfg.P;
      const high = rcfg.isHighFrame(this.rxFrameIdx++);
      const fbits = this.rxCoder.decodeFrame(this.rxPts, high);
      this.rxPts = [];
      const held = [];
      for (let b = 0; b < fbits.length; b++) {
        const bit = fbits[b];
        const r = this.des; const ob = bit ^ r[this._rxTap] ^ r[22]; r.unshift(bit); r.pop();
        if (!inB1) held.push(this._clamp104 ? 1 : ob);
      }
      // Held RN_REWIND symbols before the UART: the far end's renegotiation S is
      // found that late, and what was decoded of it is dropped (_renegRx).
      if (held.length) this._rxHold.push({ sym: this.symIdx, bits: held });
      this._rxRelease(false);
      // B1 descrambles to marks, so the line has been idle for a whole data frame
      // when it ends: the UART is armed for a start bit on the very next bit.
      if (inB1 && this.rxFrameIdx === rcfg.P) { this.uState = 'hunt'; this.uArmed = true; this.uMarks = UART_ARM_MARKS; }
      this._uartConsume();
    }
  }

  /** Held data-mode bits to the UART: those RN_REWIND symbols old, or all. */
  _rxRelease(all) {
    const h = this._rxHold;
    while (h.length && (all || h[0].sym <= this.symIdx - RN_REWIND)) for (const b of h.shift().bits) this.outbits.push(b);
  }

  _uartConsume() {
    if (this._link) { while (this.outbits.length) { const b = this.outbits.shift(); if (this._rxData) this._link.feedBit(b); } return; }
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
    if (this._rxData) this.emit('data', Buffer.from([b]));
  }

  /**
   * Take the far end's MP. The rate we read is the one for the direction the peer
   * transmits, which is the opposite field from the one we filled in.
   */
  /**
   * The fastest ladder rate this end's RECEIVER can take, from what its equaliser
   * measured in training (see RATE_SIGMA2_MAX), at most the configured rate. With
   * too little measured — a short Phase 3 — it is the configured rate, as before.
   */
  _rxCap() {
    const eq = this._eq;
    const rates = ladder().filter((r) => r <= this._configuredRate);
    const m = eq && eq.epsN >= EQ_MIN_MEASURED ? { sum: eq.epsSum, n: eq.epsN } : this._eqMeasured;
    if (!m) return this._configuredRate;
    const eps = m.sum / m.n;
    this.measuredEps = eps;
    let best = rates[0];
    for (const r of rates) if (eps * dataCfg(r).meanE <= RATE_SIGMA2_MAX) best = r;
    return best;
  }

  /** Every ladder rate at this call's symbol rate, up to the configured one. */
  rateLadder() { return ladder().filter((r) => r <= this._configuredRate); }

  /**
   * Table 20's MP, built from this end's measured cap the first time one is sent
   * and latched: an MP that changed between repetitions would be two different
   * sequences. Both directions carry the same maximum (bit 50 stays clear), and
   * the capability mask is every ladder rate up to the configured one.
   */
  _mpBits(ack) {
    if (this._mpCap == null) this._mpCap = this._rxCap();
    const key = ack ? '_mppBitsTx' : '_mpBitsTx';
    if (!this[key]) {
      this[key] = V34Phase4.buildMP({
        callToAnswer: this._mpCap, answerToCall: this._mpCap,
        aux: false, trellis: 16, theta: false, expandedShaping: false, asymmetric: false,
        rates: ladder().filter((r) => r <= this._configuredRate),
        ack,
      });
    }
    return this[key];
  }

  /**
   * Both directions at the agreed rate: the highest ladder rate within both MPs'
   * maxima (§11.4; symmetric, since neither sets bit 50). Applied at data entry,
   * once per direction, and a no-op when nothing has been agreed below the
   * configured rate.
   */
  _useRate() {
    const lim = Math.min(this._mpCap == null ? this._configuredRate : this._mpCap, this._rate || this._configuredRate);
    const rate = ladder().filter((r) => r <= lim).pop() || this._configuredRate;
    if (rate === this._txD.bitRate && rate === this._rxD.bitRate) return;
    const d = dataCfg(rate);
    this._txD = d; this._rxD = d;
    this.txCoder = new V34Coder(d.cfg);
    this.rxCoder = new V34Coder(d.cfg);
    this._rate = rate;
  }

  _acceptMP(mp) {
    if (!mp.sync || !mp.crcOk || mp.type !== 0) return;
    // Both of the peer's maxima, not only the direction we receive: with
    // asymmetric rates disallowed (bit 50 clear, ours and BinModem's) both
    // directions run ONE rate, the lowest of the four. Taking one field ran us at
    // 33 600 while BinModem, whose MP said it could receive us only at 28 800, ran
    // 28 800 — found on the bridge with line noise, where its view of our quieter
    // signal was the worse of the two.
    const rate = Math.min(mp.callToAnswer, mp.answerToCall);
    // These three select the coding the REMOTE transmitter must use, so a
    // disagreement means the sequence we are about to receive is not one this
    // decoder can invert. Record it; the link still runs, but wrongly, and a
    // silent wrong decode is what this exchange exists to rule out.
    if (mp.trellis !== 16 || mp.theta !== 0 || mp.expandedShaping) {
      this.mpMismatch = { trellis: mp.trellis, theta: mp.theta, expandedShaping: mp.expandedShaping };
    }
    this.peerMP = mp;
    this.peerRate = rate;
    this._rate = Math.min(this._rate, rate) || this._rate;
  }
}

// Every public entry, and the internals V.90 reaches into, install this call's
// front end first; emit re-installs it after the listeners, which may have built
// another call at another rate. The internals are only ever called from these.
for (const name of Object.getOwnPropertyNames(V34.prototype)) {
  if (name === 'constructor' || (name.startsWith('_') && name !== '_rxCap')) continue;
  const d = Object.getOwnPropertyDescriptor(V34.prototype, name);
  if (typeof d.value !== 'function') continue;
  const f = d.value;
  V34.prototype[name] = function (...args) { installFE(this._fe); return f.apply(this, args); };
}
V34.prototype.emit = function (...args) {
  const r = EventEmitter.prototype.emit.apply(this, args);
  installFE(this._fe);
  return r;
};

module.exports = { V34, retrainWatch };
