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
 * in V34Mapper.js and is exercised bit-exact by tools/tests/v34-map-check.js.
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
  2400: { a: 1,  c: 1, d: 3, e: 4, high: true,  rolloff: 0.25, span: 10 },
  3200: { a: 4,  c: 3, d: 3, e: 5, high: true,  rolloff: 0.20, span: 24 },
  3429: { a: 10, c: 7, d: 4, e: 7, high: true,  rolloff: 0.14, span: 32 },
};
// Table 2 gives 3429 the same d/e for both carriers, so `high` is nominal there.
const gcd = (x, y) => (y ? gcd(y, x % y) : x);
// ── Per-constellation amplitude (shaped mean symbol energy + preamble reference),
// measured from the shell-shaped point distribution (tools/tests/v34-map-check.js).
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
const DLE = 0x10, CTL_MP = 0x4d /*M*/, CTL_DATA = 0x44 /*D*/;
const DATA_MARK = [DLE, CTL_DATA], MP_REPEATS = 3;
// Keep resending MP while waiting for the far end's rather than sending three and
// hoping, but cap it: a lost control frame must degrade to entering data mode, not
// to a hung link.
const MP_MAX_REPEATS = 12;
const ANS_TONE_FREQ = 2100, ANS_TONE_AMP = 0.15, ANS_TONE_SAMPLES = Math.round(1.0 * SR);
const CONNECT_GAP = Math.round(0.08 * SR);

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
const P2_NOMINAL = 0.1 * Math.SQRT2;
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
// does). Two of the clauses call for a retrain per §11.5 as their only remedy —
// §11.2.2.1.5 and the Tone-detected halves of §11.2.2.1.6 / §11.2.2.2.4 — and §11.5
// does not exist in this build; those alone still advance, and say so where they
// are written. Everything else recovers where the clause sends it.
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
// §11.3.1.2.4 / §11.3.1.1.7 repeat it until the far end's S — respectively S̄ — is
// detected. Phase 4 here begins with the data burst's own acquirable preamble
// rather than with V.34's signal S, so there is no S for J to terminate on and both
// ends read the same constant instead. That is the ONE place this pair's Phase 3
// agrees by constant rather than by signal; it is exactly the position V.90's
// JD_REPS is in, for the same reason, and putting Phase 4's S on the wire is what
// removes it. Four repetitions is 32 symbols — a sequence rather than a blip, and
// not what the start-up's length is made of.
const J_REPEATS = 4;

// §11.3.2.1.1's deadline, as the call modem's fallback when no S-to-S̄ arrives:
// "if ... sequence J is not received within 2800 ms plus two round trip delays".
// NOTE the DIVERGENCE, which is deliberate and stated rather than hidden: the
// Recommendation's action on expiry is a retrain (§11.5.1.1), and there is no
// retrain state machine in this implementation. On expiry this modem proceeds into
// its own Phase 3 regardless, because proceeding degrades to the previous
// behaviour — a call that trains anyway — where hanging does not. A retrain path is
// the thing to add here, not a different constant.
const S_GATE_TIMEOUT = Math.round(2.8 * SR);

// How many symbols of unbroken S (or S̄) alternation the receiver requires before it
// will call one. S is 128T and S̄ only 16T, so the confirmation has to fit inside the
// shorter of the two with margin; 12 does, and is long enough that TRN — whose
// rotations are random — reaches it with probability 2^-11 per position.
const P3_RUN_CONFIRM = 12;
// The Phase 3 bit stream is a ring, not a log: the longest thing read out of it is
// one DIL descriptor, and a consumer that has stopped reading must not be able to
// grow it without bound.
const P3_BIT_CAP = 4096;

let CURRENT_RATE = null;
let CFG, FE, labelOf, BAUD, FC, SPS, ROLLOFF, SPAN, RRC_G = 1;
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
let MEAN_E, TX_GAIN, REF, ACQ_MIN, RATE_BPS;
// §10.1.3's NOTE requires the average signal power in Phase 3 to be the power the
// data mode goes on to use. Every Phase 3 segment is drawn from a unit-scale point
// set — S, TRN and J from the four rotations of point 0 (energy 2), PP from the
// unit circle (energy 1) — so each is scaled to MEAN_E here rather than emitted at
// lattice scale, which would put Phase 3 tens of dB under the data burst and train
// the far end at a gain it will not see again.
let P3_GAIN_S, P3_GAIN_PP;
// Table 20/V.34 MP, built once per configured rate. `ack` is the only per-instance
// difference (an MP with the acknowledge bit set is MP′, §10.1.3.9), so both
// variants are pre-built here and picked by the transmitter.
let MP_FRAME, MPP_FRAME;

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

function configure(rateName) {
  if (rateName === CURRENT_RATE) return;
  CFG = makeConfig(CONFIGS[rateName]);
  FE = RF[CFG.sRate];
  const amp = AMP[rateName];
  labelOf = CFG.labelOf;
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
  MEAN_E = amp.meanE;
  TX_GAIN = 0.1 / Math.sqrt(MEAN_E) * Math.SQRT2 * 0.999;   // data-burst RMS ≈ 0.1
  REF = amp.ref;
  ACQ_MIN = Math.ceil((PRE + 10) * SPS);
  RATE_BPS = CFG.bitRate;                                   // advertised (nominal) rate
  // Both directions carry the same rate: this link is symmetric, so the
  // asymmetric-rate enable (bit 50) stays clear. Trellis 16 state, Θ = 0 and
  // minimum shaping are what V34Mapper actually implements — the (K, M, L) triples
  // in CONFIGS are Table 10's Minimum columns — so the peer reading them back and
  // disagreeing means it cannot decode us.
  const mp = {
    callToAnswer: RATE_BPS, answerToCall: RATE_BPS,
    aux: false, trellis: 16, theta: false, expandedShaping: false,
    asymmetric: false,
    rates: Object.values(CONFIGS).map(c => c.bitRate).sort((a, b) => a - b),
  };
  MP_FRAME  = [DLE, CTL_MP, ...V34Phase4.buildMPBytes({ ...mp, ack: false })];
  MPP_FRAME = [DLE, CTL_MP, ...V34Phase4.buildMPBytes({ ...mp, ack: true })];
  P3_GAIN_S  = Math.sqrt(MEAN_E / P3.meanEnergy(P3.buildS()));
  P3_GAIN_PP = Math.sqrt(MEAN_E / P3.meanEnergy(P3.buildPP()));
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
    // Phase 3's own clause 7 register — see _buildPhase3 for why it is not `scr`.
    this.scr3 = new Array(23).fill(0);
    this.txCoder = new V34Coder(CFG);
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
    this.mpMismatch = null;     // set if the peer selected coding we do not run
    this.rxCoder = new V34Coder(CFG);
    // Phase 3 reception state. These deliberately survive _resetRx(): the receiver
    // passes through Phase 3 exactly once per call, and the burst that follows the
    // silence at its end is Phase 4's, which acquires on the data preamble.
    this._sbarSeen = false;      // §11.3.1.1.1's gate — the S-to-S̄ transition
    this._sawPhase3 = false;     // set when the Phase 3 signal has ended
    this._sGateTimedOut = false;
    // How many S-to-S̄ transitions the far end's Phase 3 contains. Plain V.34 sends
    // one (§11.3.1.2.1). V.90's analogue modem sends three — the head's, §9.3.2.8's
    // after J′d, and §9.3.2.10's DIL terminator — so the digital modem's receiver
    // must not treat §9.3.2.4's intervening silence as the end of Phase 3.
    this._p3SbarTarget = 1;
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
    p.des3.fill(0);
    p.bits.length = 0;
  }

  /** Phase 3 reception state. Survives _resetRx until Phase 3 genuinely ends. */
  _newP3() {
    return {
      runKind: null, runLen: 0, lastRot: -1, runFirstRot: -1, inS: false,
      sCount: 0, sbarCount: 0,
      reflect: false, parityKnown: false,
      dec: new P3.JDecoder(), des3: new Array(23).fill(0), bits: [],
    };
  }

  /** §9.3.1: how many S-to-S̄ transitions the peer's Phase 3 will contain. */
  setPhase3SbarTarget(n) { this._p3SbarTarget = n; }

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

  setPhase2Enabled(on) {
    this._phase2Enabled = !!on;
    const hadTone = this._connectQ.some((s) => s.kind === 'tone');
    this._connectQ = this._buildConnectScript(this.role);
    if (!hadTone) this._connectQ = this._connectQ.filter((s) => s.kind !== 'tone');
  }

  /** Transmit Phase 2 and then nothing. See _buildConnectScript. */
  setPhase2Only(on) {
    this._phase2Only = !!on;
    const hadTone = this._connectQ.some((s) => s.kind === 'tone');
    this._connectQ = this._buildConnectScript(this.role);
    if (!hadTone) this._connectQ = this._connectQ.filter((s) => s.kind !== 'tone');
  }

  setPhase3Lead(lead) {
    const want = lead ? 'answer' : this.role;
    const hadTone = this._connectQ.some((s) => s.kind === 'tone');
    this._connectQ = this._buildConnectScript(want);
    if (!hadTone) this._connectQ = this._connectQ.filter((s) => s.kind !== 'tone');
  }

  get carrierDetected() { return this.rxOn || this.acq; }
  get bps() { return this._rate; }

  write(bytes) { for (const by of bytes) this.txByteQ.push(by & 0xff); }

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
    this.txFrameIdx = 0;      // mapping-frame counter for §8.2 switching (reset per data burst)
  }

  _buildPreamble() {
    for (let k = 0; k < SEG_A; k++) this.txSyms.push((k & 1) ? { i: -REF.i, q: -REF.q } : { i: REF.i, q: REF.q });
    for (let k = 0; k < SEG_B; k++) this.txSyms.push({ i: REF.i, q: REF.q });
  }

  /**
   * §11.3's two roles. The answer modem leads on a timer the Recommendation gives
   * it (70 ± 5 ms, §11.3.1.2.1); the call modem leads on nothing, because
   * §11.3.1.1.1 makes it "initially silent" until it detects S and the subsequent
   * S̄ — `gate: 'sbar'`, satisfied by the receiver rather than by a sample count.
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
    if (role === 'answer') {
      return [
        { kind: 'tone',   gap: 0 },
        ...p2,
        { kind: 'phase3', gap: ANS_PHASE3_SILENCE },
        { kind: 'data',   gap: CONNECT_GAP },
      ];
    }
    return [
      ...p2,
      { kind: 'phase3', gap: 0, gate: 'sbar' },
      { kind: 'data',   gap: CONNECT_GAP },
    ];
  }

  /**
   * Phase 3 in §11.3's order: S, S̄, [MD, S, S̄], PP, TRN, J × n, J′.
   *
   * J′ sits at the tail because §11.4.1.1.1 is where it belongs — "the call modem
   * shall stop sending J sequences, ... transmit one J′ sequence, and then transmit
   * signal TRN" — so J′ is the handoff out of Phase 3, and the data burst's
   * preamble is what follows it here.
   *
   * The scrambler is `scr3`, its own register. §10.1.3.8 requires it initialized to
   * zero before TRN specifically, and the data path resets `scr` when data begins;
   * sharing one register would make the data path's state depend on how many Phase
   * 3 symbols happened to be sent. Same split, for the same reason, as V90.js.
   */
  _buildPhase3() {
    const push = (syms, g) => { for (const p of syms) this.txSyms.push({ i: p.i * g, q: p.q * g }); };

    // §11.3.1.2.1 / §11.3.1.1.3 — S for 128T then S̄ for 16T.
    push(P3.buildS(), P3_GAIN_S);
    push(P3.buildSbar(), P3_GAIN_S);

    // §11.3.1.1.4 / §11.3.1.2.1 — MD, when its declared length is non-zero, then S
    // and S̄ again. MD_SYMBOLS is 0 here (§10.1.3.5); the branch is real.
    if (this._mdSymbols > 0) {
      push(this._buildMD(this._mdSymbols), P3_GAIN_S);
      push(P3.buildS(), P3_GAIN_S);
      push(P3.buildSbar(), P3_GAIN_S);
    }

    // §11.3.1.1.5 / §11.3.1.2.2 — PP, 288 symbols, equation (10-1).
    push(P3.buildPP(), P3_GAIN_PP);

    // §11.3.1.1.6 / §11.3.1.2.3 — TRN, four constellation points, ≥ 512T.
    this.scr3.fill(0);                                   // §10.1.3.8
    let lastTrn = null;
    for (let n = 0; n < TRN_SYMBOLS; n++) {
      lastTrn = P3.trnSymbol(() => this._scramble3(1));
      this.txSyms.push({ i: lastTrn.i * P3_GAIN_S, q: lastTrn.q * P3_GAIN_S });
    }

    // Everything up to here is fixed-length and can be built in one go. What
    // follows cannot: §11.3.1.2.4 repeats J "until" the far end's S̄, and V.90's
    // §9.3.2.4 repeats Ja until S̄d, so the tail's length is a SIGNAL and the
    // remaining symbols are produced one at a time by _p3Next().
    //
    // §10.1.3.3: the differential encoder "shall be initialized using the final
    // symbol of the transmitted TRN sequence".
    this._p3 = {
      enc: new P3.JEncoder(P3.rotationOf(lastTrn)),
      stage: this._p3Tail ? this._p3Tail.first : 'j',
      bits: null, bitPos: 0, reps: 0, count: 0, done: false,
    };
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
        p3.bitPos += 2;
        const p = p3.enc.symbol(i1, i2);
        return { i: p.i * P3_GAIN_S, q: p.q * P3_GAIN_S };
      }
      // A stage emitting a fixed run of symbols (S, S̄, one SCR symbol) counts down.
      if (p3.run && p3.count < p3.run.length) {
        const p = p3.run[p3.count++];
        return { i: p.i * P3_GAIN_S, q: p.q * P3_GAIN_S };
      }
      // Both cursors are cleared BEFORE advancing: a stage that re-arms the same bit
      // array (Ja repeats its descriptor) would otherwise re-enter with the cursor
      // still at the end and neither emit nor terminate.
      p3.bits = null; p3.bitPos = 0; p3.run = null; p3.count = 0;
      if (!this._p3Advance(p3, t)) { p3.done = true; return null; }
    }
  }

  /**
   * The tail's stage transitions. Returns false when the tail is over.
   *
   * Every gate here is a predicate the owner supplies, and each one names the
   * clause it implements. Where a gate is absent the stage falls through on its own
   * length, which is what plain V.34 does — its J count is the constant item 1 left
   * behind and V.90's tail is what retires.
   */
  _p3Advance(p3, t) {
    switch (p3.stage) {
      // ── Plain V.34: J × J_REPEATS then one J′ (§10.1.3.3, §10.1.3.4) ────────
      case 'j':
        if (p3.reps++ < J_REPEATS) { p3.bits = P3.jPattern(4); return true; }
        p3.stage = 'jprime'; return true;
      case 'jprime':
        p3.bits = P3.jPrimePattern(); p3.stage = 'end'; return true;

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
      case 'sbar-terminate':
        p3.run = P3.buildSbar(); p3.stage = 'end'; return true;

      default:
        return false;
    }
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
        // Tone B". On INFO1c it proceeds per §11.2.1.2.9, which is INFO1a. On
        // Tone B the clause says §11.5.2.2, a retrain, and this build has none — so
        // that exit lands on INFO1a as well, and the peer sees a sequence rather
        // than silence.
        { id: 'INFOMARKSa', name: 'INFOMARKSa', recovery: true, next: 'INFO1a',
          emit: 'info', bits: () => P2.infomarks(P2_MARKS_RUN),
          repeatUntil: () => !!p2.peerInfo1 || toneSeen() },
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
      // §11.2.2.1.5's only remedy is a retrain per §11.5.1.1, which this build does
      // not have — so this bound is carried, recorded, and then advances. It is one
      // of the two places §11.2.2 is still not implemented, and the shape is right
      // for it: the clause's 650 ms plus a round trip is already the step's bound.
      { name: 'L2', emit: 'probe', level: P2.LEVEL.L2, dur: P2_L2, until: () => toneSeen(),
        emitMax: P2_L2_MAX, bound: () => P2_BOUND_L2_CALL + p2.rtd },
      { id: 'INFO1c', name: 'INFO1c', emit: 'info', bits: () => prof.info1() },
      // §11.2.2.1.6 — "condition its receiver to detect either Tone A or
      // INFOMARKSa. Upon detection of INFOMARKSa, the call modem shall either
      // initiate a retrain ... or send INFO1c and proceed in accordance with
      // 11.2.1.1.8." The second alternative is taken, and it is what closes the
      // loop with the answer modem's §11.2.2.2.4. Upon Tone A the clause asks for a
      // retrain response (§11.5.1.2) and there is none, so that case advances.
      { name: 'wait INFO1a', emit: 'silence', until: () => p2.peerInfo1,
        bound: () => P2_BOUND_INFO1A + p2.rtd,                         // §11.2.2.1.6
        recover: () => (p2.peerMarks ? { goto: 'INFO1c' } : null) },
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
    const have = new Set(Object.values(CONFIGS).map((c) => c.sRate));
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
    const byRate = new Map();
    for (const c of Object.values(CONFIGS)) {
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
    for (const c of Object.values(CONFIGS)) mine.set(c.sRate, true);
    let chosen = CFG.sRate;
    for (let k = P2.SYMBOL_RATES.length - 1; k >= 0; k--) {
      const r = P2.SYMBOL_RATES[k];
      if (mine.has(r) && (peer[`maxDataRate${r}`] || 0) > 0) { chosen = r; break; }
    }
    this._p2.chosenRate = chosen;
    this._p2.myMdLength = 0;             // §10.1.3.5, as INFO1c
    const idx = P2.SYMBOL_RATES.indexOf(chosen);
    const best = Object.values(CONFIGS).filter((c) => c.sRate === chosen)
      .reduce((a, c) => Math.max(a, Math.round(c.bitRate / 2400)), 0);
    return P2.buildInfo(P2.INFO1A, {
      minPowerReduction: 0, additionalPowerReduction: 0,
      mdLength: 0,
      highCarrier: 0,
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
      this.rateMismatch = `INFO1 selected ${rate} baud; this build is configured for ${CFG.sRate}`;
    }
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
    // 'data' — continuous full-duplex flow: preamble then framed bits forever
    this._buildPreamble();
    this.txWarmup = WARMUP_BITS;
    this.txContinuous = true;
    this.txCtrlQ = [];
    this._mpSent = 0;
    this._mpPhase = 'mp';
    for (let r = 0; r < MP_REPEATS; r++, this._mpSent++) this.txCtrlQ.push(...MP_FRAME);
    this.txState = 'active';
    this._idleSamples = 0;
  }

  /**
   * A step waits for its own gap, and a step carrying `gate` waits for a SIGNAL as
   * well. `gate: 'sbar'` is §11.3.1.1.1 — the call modem stays silent until it has
   * detected S and the subsequent S̄ — with S_GATE_TIMEOUT as the fallback described
   * where that constant is declared.
   */
  _maybeStartBurst() {
    if (!this._connectQ.length) return;
    const step = this._connectQ[0];
    if (this._idleSamples < step.gap) return;
    if (step.gate === 'sbar' && !this._sbarSeen) {
      if (this._idleSamples < S_GATE_TIMEOUT) return;
      this._sGateTimedOut = true;
    }
    // §9.3.2.7 — the analogue modem begins S only "after receiving Jd".
    if (step.gate === 'jd' && !(this._p3Tail && this._p3Tail.jdReceived())) {
      if (this._idleSamples < S_GATE_TIMEOUT) return;
      this._sGateTimedOut = true;
    }
    this._startBurst(this._connectQ.shift().kind);
  }

  /**
   * Phase 4's MP exchange, run over the DLE control channel: send MP until the
   * far end's arrives, answer it with MP′ (§10.1.3.9: "an MP sequence with the
   * acknowledge bit set to 1 is denoted by MP′"), then mark the start of data.
   * The acknowledge bit is therefore load-bearing here rather than decorative —
   * data mode is gated on having read and agreed with the peer's parameters.
   */
  _refillCtrl() {
    if (this.txCtrlQ.length || this._mpPhase !== 'mp') return;
    if (this.peerMP || this._mpSent >= MP_MAX_REPEATS) {
      if (this.peerMP) this.txCtrlQ.push(...MPP_FRAME);
      this.txCtrlQ.push(...DATA_MARK);
      this._mpPhase = 'done';
      return;
    }
    this.txCtrlQ.push(...MP_FRAME);
    this._mpSent++;
  }

  _txBit() {
    if (this.txWarmup > 0) { this.txWarmup--; return this._scramble(1); }
    if (this.txFrame) {
      const b = this.txFrame[this.txFramePos++];
      if (this.txFramePos >= this.txFrame.length) this.txFrame = null;
      return this._scramble(b);
    }
    let by = null;
    this._refillCtrl();
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
    if (this._p3Active) {
      while (this.txSymBase + this.txSyms.length <= k) {
        const p = this._p3Next();
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
      return;
    }
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
      out[c] = (ai * CAR_COS[ci] - aq * CAR_SIN[ci]) * TX_GAIN;
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
    this._bank = null;                      // rebuilt on the next acquisition
    this._onsetPos = 0; this._onsetE = 0; this._onsetHit = -1;   // see _scanOnset
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
    // Which signal this burst is. Phase 3 comes first and exactly once; everything
    // after the silence that ends it is Phase 4, which is what the data preamble
    // acquisition below was written against.
    this.rxPhase = this._sawPhase3 ? 'data' : 'phase3';
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
      this.p3.dec.prev = null; this.p3.runKind = null; this.p3.runLen = 0;
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
    const b = this._bank;
    if (b && b.base === base && b.rate === CURRENT_RATE) return b;
    const W = [], N0 = [];
    for (let ph = 0; ph < SPS_Q; ph++) {
      const pos = base + ph * SPS;
      const n0 = Math.ceil(pos - SPAN / 2 * SPS), n1 = Math.floor(pos + SPAN / 2 * SPS);
      const w = new Float64Array(n1 - n0 + 1);
      for (let j = 0; j < w.length; j++) w[j] = rrc((n0 + j - pos) / SPS);
      W.push(w); N0.push(n0);
    }
    this._bank = { base, rate: CURRENT_RATE, W, N0 };
    return this._bank;
  }

  // pos for symbol idx, summed the exact way (integer SPS_P steps) rather than by
  // idx*SPS, which accumulates rounding over a burst of thousands of symbols.
  _symPos(base, idx) {
    const ph = ((idx % SPS_Q) + SPS_Q) % SPS_Q;
    return base + ph * SPS + ((idx - ph) / SPS_Q) * SPS_P;
  }

  _symAt(base, idx) {
    const ph = ((idx % SPS_Q) + SPS_Q) % SPS_Q, m = (idx - ph) / SPS_Q;
    const bk = this._symBank(base);
    const w = bk.W[ph], n0 = bk.N0[ph] + m * SPS_P;
    const B = this.rxBase, I = this.rxI, Q = this.rxQ;
    const lo = Math.max(0, B - n0);
    const hi = Math.min(w.length - 1, B + this.rxLen - 1 - n0);
    let ai = 0, aq = 0;
    for (let j = lo; j <= hi; j++) { const p = w[j], k = n0 + j - B; ai += I[k] * p; aq += Q[k] * p; }
    return [ai, aq];
  }

  receiveAudio(f32) {
    // §11.2's detectors run on the raw samples and are done with once Phase 2 is:
    // Phase 3 and the data burst are QAM at the selected symbol rate and have
    // nothing to say to a 600 bit/s DPSK demodulator.
    if (this._p2 && !this._p2.settled) this._p2Receive(f32);
    for (let i = 0; i < f32.length; i++) {
      const s = f32[i];
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
        // A silence ends Phase 3 only once the peer has sent every S-to-S̄ transition
        // its procedure contains. V.90's analogue modem falls silent MID-Phase 3
        // (§9.3.2.4) and resumes with S after Jd, so a receiver that took the first
        // silence for the end would hand §9.3.2.7's S to the data acquisition.
        // Recorded before _resetRx, which reads it to decide what comes next.
        if (this.rxPhase === 'phase3' && this.p3.sbarCount >= this._p3SbarTarget) {
          this._sawPhase3 = true;
        }
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

    if (!this._sRef) {
      // Onset, then the same fractional timing search the data path uses. S is
      // constant-modulus, so maximising summed symbol magnitude finds the ISI-free
      // instant exactly as it does on the preamble.
      const onset = this._scanOnset();
      if (onset < 0) return;
      let best = onset, bestScore = -1;
      for (let bo = Math.max(0, onset - 2 * SPS); bo <= onset + 2 * SPS; bo += SPS / 64) {
        let sc = 0;
        for (let k = 0; k < 12; k++) { const s = this._symAt(bo, k); sc += Math.hypot(s[0], s[1]); }
        if (sc > bestScore) { bestScore = sc; best = bo; }
      }
      // Confirm this really is S before adopting a reference from it: constant
      // modulus, and consecutive symbols 90° apart. Anything else — a V.21 tail, a
      // truncated tone — fails here rather than producing a reference that a later
      // 180° coincidence would fire against.
      const sIQ = [];
      for (let j = 0; j < CONFIRM; j++) sIQ.push(this._symAt(best, j));
      const mags = sIQ.map((s) => Math.hypot(s[0], s[1]));
      const mAvg = mags.reduce((t, m) => t + m, 0) / mags.length;
      if (mAvg < 1e-6) return;
      for (const m of mags) if (Math.abs(m - mAvg) > 0.35 * mAvg) return;
      for (let j = 1; j < CONFIRM; j++) {
        let d = Math.atan2(sIQ[j][1], sIQ[j][0]) - Math.atan2(sIQ[j - 1][1], sIQ[j - 1][0]);
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        if (Math.abs(Math.abs(d) - Math.PI / 2) > 0.5) return;
      }
      // Average each parity: S alternates two fixed points, so the even-index mean
      // and the odd-index mean ARE the channel's view of them.
      const acc = [[0, 0], [0, 0]], cnt = [0, 0];
      for (let j = 0; j < CONFIRM; j++) {
        const p = j & 1; acc[p][0] += sIQ[j][0]; acc[p][1] += sIQ[j][1]; cnt[p]++;
      }
      this._sRef = {
        base: best, idx: CONFIRM,
        a: [acc[0][0] / cnt[0], acc[0][1] / cnt[0]],
        b: [acc[1][0] / cnt[1], acc[1][1] / cnt[1]],
      };
      this._sMag = mAvg;
    }

    // Walk forward, classifying every symbol against the FOUR rotations of point 0.
    // The reference gives rotation 0 and rotation 3 directly (S's two points), and
    // the other two are their negations, so one confirmed stretch of S calibrates
    // the whole constellation — which is what lets everything after it (S̄ runs, and
    // the differentially encoded bits of J, J′ and Ja) be read without any further
    // acquisition. On this transport the clock does not drift, so the timing found
    // on S is still the timing 1500 symbols later.
    const r = this._sRef;
    const end = this.rxBase + this.rxLen - 1;
    for (;;) {
      const pos = this._symPos(r.base, r.idx);
      if (pos + SPAN / 2 * SPS >= end) return;
      const s = this._symAt(r.base, r.idx);
      r.idx++;

      // ref[0] and ref[3] are S's two points; S̄'s are their negations (§10.1.3.7).
      let bestRot = 0, bestDot = -Infinity;
      for (let rot = 0; rot < 4; rot++) {
        const ref = (rot === 0) ? r.a : (rot === 3) ? r.b
                  : (rot === 2) ? [-r.a[0], -r.a[1]] : [-r.b[0], -r.b[1]];
        const dot = s[0] * ref[0] + s[1] * ref[1];
        if (dot > bestDot) { bestDot = dot; bestRot = rot; }
      }
      this._p3Symbol(bestRot);
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
  _p3Symbol(rot) {
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
        this._sbarSeen = true;
        this._resolveP3Parity(p);
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
        p.bits.push(ob);
      }
      // Bounded: a consumer that is not reading is not a reason to grow without
      // limit, and nothing needs more history than one descriptor.
      if (p.bits.length > P3_BIT_CAP) p.bits.splice(0, p.bits.length - P3_BIT_CAP);
    }
  }

  _process() {
    // Phase 3 is not the data burst and must not be handed to the data burst's
    // acquisition. TRN is 512 symbols of random 90° rotations, which will sooner or
    // later present two consecutive 180° steps followed by three near-zero ones —
    // exactly the preamble predicate below — so letting acquisition run here does
    // not merely waste work, it false-locks on noise-shaped training.
    if (this.rxPhase === 'phase3') { this._huntSbar(); return; }

    if (!this.acq) {
      if (this.rxLen < ACQ_MIN) return;
      const onset = this._scanOnset();
      if (onset < 0) return;
      let best = onset, bestScore = -1;
      // Fractional symbol-timing search. The step must resolve the ISI-free instant:
      // at the tightest rate (3429, 2.33 SPS, β=0.14) the eye is sharp enough that a
      // ~0.07-sample timing error tips the slicer (SPS/16 → ~99% symbol errors,
      // SPS/64 → 0, measured). SPS/64 is a one-time acquisition
      // cost and leaves the wider 2400/3200 eyes unaffected.
      for (let bo = Math.max(0, onset - 2 * SPS); bo <= onset + 2 * SPS; bo += SPS / 64) {
        let sc = 0; for (let k = 0; k < 12; k++) { const s = this._symAt(bo, k); sc += Math.hypot(s[0], s[1]); }
        if (sc > bestScore) { bestScore = sc; best = bo; }
      }
      const nSy = PRE + 8, ang = [], mag = [], sIQ = [];
      for (let j = 0; j < nSy; j++) { const s = this._symAt(best, j); ang.push(Math.atan2(s[1], s[0])); mag.push(Math.hypot(s[0], s[1])); sIQ.push(s); }
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
      const pos = this._symPos(this.base, this.symIdx);
      const end = this.rxBase + this.rxLen - 1;
      if (pos + SPAN / 2 * SPS >= end) break;
      const s = this._symAt(this.base, this.symIdx);
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
      if (drop > 512) this._dropRx(drop);
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
        if (b === CTL_MP) { this._cState = 'mp'; this._mpBuf = []; }
        else if (b === CTL_DATA) { this._rxData = true; this._cState = 'idle'; }
        else this._cState = 'idle';
        break;
      case 'mp': {
        // Fixed length, so a 0x10 inside the sequence needs no escaping.
        this._mpBuf.push(b);
        if (this._mpBuf.length < V34Phase4.MP_BYTES) break;
        this._cState = 'idle';
        this._acceptMP(V34Phase4.parseMPBytes(this._mpBuf));
        break;
      }
    }
  }

  /**
   * Take the far end's MP. The rate we read is the one for the direction the peer
   * transmits, which is the opposite field from the one we filled in.
   */
  _acceptMP(mp) {
    if (!mp.sync || !mp.crcOk || mp.type !== 0) return;
    const rate = this.role === 'answer' ? mp.callToAnswer : mp.answerToCall;
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

module.exports = { V34 };
