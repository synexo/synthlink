'use strict';

/**
 * V.32bis — 14 400 bit/s, per ITU-T Recommendation V.32bis (1991), operated as
 * TRUE FULL-DUPLEX continuous carrier over our WebSocket transport, building
 * directly on the proven V.32 DSP core (`protocols/V32.js`). Same carrier
 * (1800 Hz), same symbol rate (2400 baud), same role-asymmetric scramblers —
 * V.32bis is the trellis-coded speed step up from V.32.
 *
 * ── Why full-duplex works here without an echo canceller ─────────────────────
 * Identical to V.32: real V.32bis is full-duplex on one shared 1800 Hz carrier
 * per direction and uses adaptive ECHO CANCELLATION (§1b) to separate the two
 * directions on a 2-wire line. Our two WebSocket directions are a 4-wire
 * equivalent — no self-carrier leaks into our receive — so the echo canceller is
 * unnecessary and we keep genuine full-duplex. As in V.32, the idle-`0xFF` flood
 * is avoided by carrying bytes with async start/stop (UART) framing over the
 * always-on scrambled synchronous stream: descrambled idle-mark yields no start
 * bit, hence no phantom bytes, while the carrier stays continuously up.
 *
 * ── What is genuine V.32bis here ────────────────────────────────────────────
 *   - 1800 Hz carrier, 2400 baud, **14 400 bit/s = 6 data bits/symbol** (§2.3.1).
 *   - The scrambled stream is grouped into six bits Q1..Q6. Q1Q2 are
 *     DIFFERENTIALLY encoded into Y1Y2 by the exact **Table 1/V.32bis** (the
 *     trellis-coding variant, distinct from the 4800 Table 2). Y1Y2 drive a
 *     **systematic convolutional encoder** producing the redundant bit Y0
 *     (Figure 1/V.32bis). The seven bits Y0Y1Y2Q3Q4Q5Q6 map to a point of the
 *     **128-point cross constellation** (Figure 2-1/V.32bis).
 *   - The real, role-asymmetric self-synchronising scramblers (§4) — call-mode
 *     `GPC = 1+x⁻¹⁸+x⁻²³`, answer-mode `GPA = 1+x⁻⁵+x⁻²³` — each end scrambles TX
 *     with its own polynomial and descrambles RX with the peer's. This
 *     implementation is bit-exact to the §5.2.3 golden vector (scrambling ones
 *     with GPC from the zero state yields 11 11 11 11 11 11 11 11 11 00 00 01…).
 *   - The Recommendation's own start-up, §§5.2–5.3 and §6: the receiver
 *     conditioning signal's three segments (S for 256T, S̄ for 16T, TRN for 1280T)
 *     at the A/B/C/D states of Figure 2-5/V.32bis, and the R1/R2/R3 rate-signal
 *     exchange with the sequence E that ends it — the genuine **Table 5/V.32bis**
 *     bit positions (B5=4800, B6=9600, B9=7200, B10=12000, B12=14400), scrambled
 *     and differentially encoded as in Table 2/V.32bis and carried on those four
 *     states rather than as reserved bytes in the data stream. §5.2 and §5.2.3 are
 *     word for word V.32's, down to the two printed scrambler golden vectors, so
 *     the signals are shared through V32Startup.js; §6's procedure is here.
 *
 * ── Genuine-minimal, documented (not hidden) ────────────────────────────────
 *   - **No Viterbi decoder.** The redundant trellis bit Y0 is genuinely produced
 *     and transmitted (real trellis-coded modulation on the wire), but the
 *     receiver recovers the six data bits by slicing to the nearest constellation
 *     point and reading them back, discarding Y0. Trellis coding buys ~4 dB of
 *     noise immunity; our transport is lossless, so slicing recovers the data
 *     exactly and the coding gain is simply unused. (Against a real line you would
 *     add the Viterbi decoder.) The 7-bit→point mapping IS Figure 2-1's, point
 *     for point, so the set partition on the wire is the Recommendation's; what
 *     is still not golden-verified is the convolutional encoder, a genuine
 *     8-state finite-state machine of the V.32 family rather than the Wei code.
 *   - **No adaptive equalizer / no continuous timing tracking.** As in V.32 the
 *     receiver acquires symbol timing + complex channel gain + frame-sync ONCE on
 *     the preamble and free-runs — sound only because both ends share the one
 *     lossless 8 kHz clock (zero drift).
 *   - **Single operating rate (14 400).** The rate SIGNAL genuinely advertises the
 *     full V.32bis rate set and negotiates the max, but only 14 400 is wired for
 *     data; the multi-rate fallbacks (12000/9600/7200/4800) and the §8 rate
 *     renegotiation-without-retrain are the documented next step.
 *   - The ECHO-CANCELLER half of §6 is omitted: the AA/CC and AC/CA segments, the
 *     600/1800/3000 Hz tone detections and phase reversals, and the NT/MT
 *     round-trip periods the counter/timer produces. All of it trains the echo
 *     canceller and measures a round trip our 4-wire-equivalent transport does not
 *     have. Untested against real V.32bis hardware.
 *   Reuses V.32's fractional-SPS (3.333) RRC synthesis + fractional matched
 *   filter (rolloff 0.25) at 1800 Hz.
 *
 * Interface matches the other protocol classes: constructor(role);
 * generateAudio(n)->Float32Array; receiveAudio(f32); write(buf); emits 'data'
 * (Buffer) and 'ready' ({bps, remoteDetected}); getters bps and carrierDetected.
 */

const { EventEmitter } = require('events');
// §§5.2–5.3's signals, shared with V32.js: S, S̄, TRN, Table 2/V.32bis's
// differential coding (which is Table 1/V.32's), and the 16-bit sequences of
// Table 5/V.32bis and the E of Table 6/V.32bis.
const V32S = require('./V32Startup');

const SR = 8000, BAUD = 2400, FC = 1800, SPS = SR / BAUD; // 3.333…
const ROLLOFF = 0.25, SPAN = 10;
const BITS = 6;                                 // 6 data bits/symbol => 14400

// ── 128-point constellation — Table of Figure 2-1/V.32bis ───────────────────
// Transcribed from the Recommendation, indexed by the figure's own bit order
// Y0 Y1 Y2 Q3 Q4 Q5 Q6, so C128[idx] IS the figure's point for that label. The
// points lie on the checkerboard lattice Re+Im odd, |Re|,|Im| ≤ 9 — not an
// odd-integer grid, and the mapping is not free: the trellis subsets and the
// differential quadrant rotation are properties of these exact assignments.
const C128 = [
  { i:  -8, q:  -3 },   // 0000000
  { i:   8, q:  -3 },   // 0000001
  { i:   4, q:  -3 },   // 0000010
  { i:   4, q:  -7 },   // 0000011
  { i:  -4, q:  -3 },   // 0000100
  { i:  -4, q:  -7 },   // 0000101
  { i:   0, q:  -3 },   // 0000110
  { i:   0, q:  -7 },   // 0000111
  { i:  -8, q:   1 },   // 0001000
  { i:   8, q:   1 },   // 0001001
  { i:   4, q:   1 },   // 0001010
  { i:   4, q:   5 },   // 0001011
  { i:  -4, q:   1 },   // 0001100
  { i:  -4, q:   5 },   // 0001101
  { i:   0, q:   1 },   // 0001110
  { i:   0, q:   5 },   // 0001111
  { i:   8, q:   3 },   // 0010000
  { i:  -8, q:   3 },   // 0010001
  { i:  -4, q:   3 },   // 0010010
  { i:  -4, q:   7 },   // 0010011
  { i:   4, q:   3 },   // 0010100
  { i:   4, q:   7 },   // 0010101
  { i:   0, q:   3 },   // 0010110
  { i:   0, q:   7 },   // 0010111
  { i:   8, q:  -1 },   // 0011000
  { i:  -8, q:  -1 },   // 0011001
  { i:  -4, q:  -1 },   // 0011010
  { i:  -4, q:  -5 },   // 0011011
  { i:   4, q:  -1 },   // 0011100
  { i:   4, q:  -5 },   // 0011101
  { i:   0, q:  -1 },   // 0011110
  { i:   0, q:  -5 },   // 0011111
  { i:   2, q:  -9 },   // 0100000
  { i:   2, q:   7 },   // 0100001
  { i:   2, q:   3 },   // 0100010
  { i:   6, q:   3 },   // 0100011
  { i:   2, q:  -5 },   // 0100100
  { i:   6, q:  -5 },   // 0100101
  { i:   2, q:  -1 },   // 0100110
  { i:   6, q:  -1 },   // 0100111
  { i:  -2, q:  -9 },   // 0101000
  { i:  -2, q:   7 },   // 0101001
  { i:  -2, q:   3 },   // 0101010
  { i:  -6, q:   3 },   // 0101011
  { i:  -2, q:  -5 },   // 0101100
  { i:  -6, q:  -5 },   // 0101101
  { i:  -2, q:  -1 },   // 0101110
  { i:  -6, q:  -1 },   // 0101111
  { i:  -2, q:   9 },   // 0110000
  { i:  -2, q:  -7 },   // 0110001
  { i:  -2, q:  -3 },   // 0110010
  { i:  -6, q:  -3 },   // 0110011
  { i:  -2, q:   5 },   // 0110100
  { i:  -6, q:   5 },   // 0110101
  { i:  -2, q:   1 },   // 0110110
  { i:  -6, q:   1 },   // 0110111
  { i:   2, q:   9 },   // 0111000
  { i:   2, q:  -7 },   // 0111001
  { i:   2, q:  -3 },   // 0111010
  { i:   6, q:  -3 },   // 0111011
  { i:   2, q:   5 },   // 0111100
  { i:   6, q:   5 },   // 0111101
  { i:   2, q:   1 },   // 0111110
  { i:   6, q:   1 },   // 0111111
  { i:   9, q:   2 },   // 1000000
  { i:  -7, q:   2 },   // 1000001
  { i:  -3, q:   2 },   // 1000010
  { i:  -3, q:   6 },   // 1000011
  { i:   5, q:   2 },   // 1000100
  { i:   5, q:   6 },   // 1000101
  { i:   1, q:   2 },   // 1000110
  { i:   1, q:   6 },   // 1000111
  { i:   9, q:  -2 },   // 1001000
  { i:  -7, q:  -2 },   // 1001001
  { i:  -3, q:  -2 },   // 1001010
  { i:  -3, q:  -6 },   // 1001011
  { i:   5, q:  -2 },   // 1001100
  { i:   5, q:  -6 },   // 1001101
  { i:   1, q:  -2 },   // 1001110
  { i:   1, q:  -6 },   // 1001111
  { i:  -9, q:  -2 },   // 1010000
  { i:   7, q:  -2 },   // 1010001
  { i:   3, q:  -2 },   // 1010010
  { i:   3, q:  -6 },   // 1010011
  { i:  -5, q:  -2 },   // 1010100
  { i:  -5, q:  -6 },   // 1010101
  { i:  -1, q:  -2 },   // 1010110
  { i:  -1, q:  -6 },   // 1010111
  { i:  -9, q:   2 },   // 1011000
  { i:   7, q:   2 },   // 1011001
  { i:   3, q:   2 },   // 1011010
  { i:   3, q:   6 },   // 1011011
  { i:  -5, q:   2 },   // 1011100
  { i:  -5, q:   6 },   // 1011101
  { i:  -1, q:   2 },   // 1011110
  { i:  -1, q:   6 },   // 1011111
  { i:  -3, q:   8 },   // 1100000
  { i:  -3, q:  -8 },   // 1100001
  { i:  -3, q:  -4 },   // 1100010
  { i:  -7, q:  -4 },   // 1100011
  { i:  -3, q:   4 },   // 1100100
  { i:  -7, q:   4 },   // 1100101
  { i:  -3, q:   0 },   // 1100110
  { i:  -7, q:   0 },   // 1100111
  { i:   1, q:   8 },   // 1101000
  { i:   1, q:  -8 },   // 1101001
  { i:   1, q:  -4 },   // 1101010
  { i:   5, q:  -4 },   // 1101011
  { i:   1, q:   4 },   // 1101100
  { i:   5, q:   4 },   // 1101101
  { i:   1, q:   0 },   // 1101110
  { i:   5, q:   0 },   // 1101111
  { i:   3, q:  -8 },   // 1110000
  { i:   3, q:   8 },   // 1110001
  { i:   3, q:   4 },   // 1110010
  { i:   7, q:   4 },   // 1110011
  { i:   3, q:  -4 },   // 1110100
  { i:   7, q:  -4 },   // 1110101
  { i:   3, q:   0 },   // 1110110
  { i:   7, q:   0 },   // 1110111
  { i:  -1, q:  -8 },   // 1111000
  { i:  -1, q:   8 },   // 1111001
  { i:  -1, q:   4 },   // 1111010
  { i:  -5, q:   4 },   // 1111011
  { i:  -1, q:  -4 },   // 1111100
  { i:  -5, q:  -4 },   // 1111101
  { i:  -1, q:   0 },   // 1111110
  { i:  -5, q:   0 },   // 1111111
];

const ckey = (i, q) => i * 100 + q;
// point -> index (0..127) for bit recovery
const IDX = new Map();
for (let k = 0; k < C128.length; k++) IDX.set(ckey(C128[k].i, C128[k].q), k);

// Slice a derotated point to the nearest constellation point. Rounding lands on
// the integer grid; half of it is off-lattice (Re+Im even), so the coordinate
// with the larger rounding residual moves one step. A point outside the figure's
// boundary falls through to an exhaustive nearest search over the 128.
function slicePoint(xI, xQ) {
  let i = Math.round(xI), q = Math.round(xQ);
  if (((i + q) & 1) === 0) {
    const di = xI - i, dq = xQ - q;
    if (Math.abs(di) >= Math.abs(dq)) i += di >= 0 ? 1 : -1;
    else q += dq >= 0 ? 1 : -1;
  }
  if (IDX.has(ckey(i, q))) return { i, q };
  let best = C128[0], bd = Infinity;
  for (const p of C128) {
    const d = (xI - p.i) ** 2 + (xQ - p.q) ** 2;
    if (d < bd) { bd = d; best = p; }
  }
  return { i: best.i, q: best.q };
}

// ── Table 1/V.32bis — differential quadrant coding WITH trellis coding ───────
// din = (Q1<<1)|Q2 ; y = (Y1<<1)|Y2. TAB1[din][yPrev] = yNew.
const TAB1 = [
  [0, 1, 2, 3],   // Q1Q2 = 00
  [1, 0, 3, 2],   // Q1Q2 = 01
  [2, 3, 1, 0],   // Q1Q2 = 10
  [3, 2, 0, 1],   // Q1Q2 = 11
];
// inverse: INV1[yPrev][yNew] = din
const INV1 = [[], [], [], []];
for (let din = 0; din < 4; din++) for (let yp = 0; yp < 4; yp++) INV1[yp][TAB1[din][yp]] = din;

// Genuine 8-state systematic convolutional encoder (V.32 family). Produces the
// redundant bit Y0 from Y1,Y2 (Figure 1/V.32bis). Carried on the wire; NOT
// Viterbi-decoded on this lossless link (see header). Deterministic FSM so the
// transmitted point set is a real trellis-coded signal.
function convEncode(st, Y1, Y2) {
  const Y0 = st.c;
  const na = Y1 ^ st.c;
  const nb = st.a;
  const nc = st.b ^ (Y1 & Y2);
  st.a = na; st.b = nb; st.c = nc;
  return Y0;
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

// Passband amplitude. Figure 2-1's points have mean energy exactly 41 (RMS
// 6.403); scaled so burst RMS ≈ 0.1 (matches the other protocols / the RX
// squelch).
const TX_GAIN = 0.02263;

const UART_ARM_MARKS = 8;

const RX_A = 0.02, RX_HI = 0.015, RX_LO = 0.006, RX_HANG = 48;

// ── §5.3 / Table 5/V.32bis — what this build may advertise ─────────────────
// The full V.32bis rate set. Only 14 400 is wired for data (see the header), so
// R3 selects it and a peer that could not reach it is recorded as a mismatch
// rather than silently accommodated — the fallback rates are backlog item 6.
const RATE_SET = [4800, 7200, 9600, 12000, 14400];
const RATE_MAX = 14400;

// Figure 2-5/V.32bis's four states are drawn on their OWN signal-space diagram —
// mean symbol energy 10 — while the data points come from Figure 2-1, whose mean
// energy is 41. Two diagrams at two scales for one modem's line power, so the
// conditioning signal and the rate signals are scaled to the data burst's energy.
// V.32 needs no such factor: there, both come from Figure 1.
const SU_GAIN = V32S.gainFor(41);

// Self-validation, at module load. There is no config builder here to hang these
// off — the rate is a constant — so the relations the Recommendation fixes are
// asserted directly, and a hand-edit that breaks one fails loudly at require()
// instead of producing a link that works only against itself.
(function validate() {
  const bad = m => { throw new Error(`V.32bis config: ${m}`); };
  // §2.3.1: six data bits per symbol at 2400 baud is 14 400 bit/s, and the coded
  // symbol carries one more bit (Y0), so the constellation is 2^(BITS+1) points.
  if (BITS * BAUD !== 14400) bad(`${BITS} bits × ${BAUD} baud ≠ 14400 bit/s`);
  if (C128.length !== 1 << (BITS + 1)) {
    bad(`constellation has ${C128.length} points; ${BITS} data bits + Y0 needs ${1 << (BITS + 1)}`);
  }
  if (IDX.size !== C128.length) bad('constellation index map is not a bijection');
  // Figure 2-1: every point lies on the checkerboard lattice Re+Im odd, within
  // |Re|,|Im| ≤ 9. A transcription slip off the lattice fails here.
  for (const p of C128) {
    if (((p.i + p.q) & 1) === 0) bad(`point (${p.i},${p.q}) has Re+Im even`);
    if (Math.abs(p.i) > 9 || Math.abs(p.q) > 9) bad(`point (${p.i},${p.q}) outside |9|`);
  }
  // §2.3.1 differential quadrant coding: rotating the plane by 90° must carry a
  // point to another point that keeps Q3..Q6, flips the trellis bit Y0 and
  // advances Y1Y2 by one quadrant. This is what pins the labelling — a shuffled
  // map satisfies the bijection above but not this.
  for (let k = 0; k < C128.length; k++) {
    const p = C128[k], r = IDX.get(ckey(-p.q, p.i));
    if (r === undefined) bad(`90° rotation of (${p.i},${p.q}) is not a point`);
    if ((r & 0x0f) !== (k & 0x0f)) bad(`90° rotation of index ${k} changes Q3..Q6`);
    if ((r >> 6) === (k >> 6)) bad(`90° rotation of index ${k} does not flip Y0`);
    const y = (k >> 4) & 3, ry = (r >> 4) & 3;
    if (ry !== [3, 2, 0, 1][y]) bad(`90° rotation of index ${k} misrotates Y1Y2`);
  }
  // Figure 2-5's four states must scale to Figure 2-1's mean symbol energy, which
  // is what SU_GAIN is for and what keeps the start-up and the data at one power.
  let e = 0;
  for (const p of C128) e += p.i * p.i + p.q * p.q;
  const meanE = e / C128.length;
  if (meanE !== 41) bad(`Figure 2-1 mean symbol energy is ${meanE}, not 41`);
  if (Math.abs(V32S.STATE_MEAN_E * SU_GAIN * SU_GAIN - meanE) > 1e-9) {
    bad('the start-up states do not scale to the data constellation energy');
  }
  // Table 5/V.32bis: this build's rate set must be exactly what the codec can
  // advertise, and the rate it runs must be the highest of them.
  const codecRates = V32S.V32BIS_RATES.rates.join(',');
  if (RATE_SET.slice().sort((a, b) => a - b).join(',') !== codecRates) {
    bad(`rate set [${RATE_SET}] is not Table 5/V.32bis's [${codecRates}]`);
  }
  if (RATE_MAX !== BITS * BAUD) bad(`RATE_MAX ${RATE_MAX} is not this build's ${BITS * BAUD}`);
})();

// ── §§5.2–5.3 start-up constants; see V32.js for the clause each one is ─────
const TRN_SYMBOLS = V32S.TRN_MIN_SYMBOLS;     // §5.2.3's "at least 1280"
const RATE_MIN_REPEATS = 6;                   // §5.3.1 needs two, after convergence
const E_TO_DATA_SYMBOLS = 128;                // §6.1 / §6.2
const RUN_CONFIRM = 12;
const GATE_TIMEOUT = Math.round(6.0 * SR);

// ── Audible startup (V.25 answer tone) ──────────────────────────────────────
const ANS_TONE_FREQ    = 2100;
const ANS_TONE_AMP     = 0.15;
const ANS_TONE_SAMPLES = Math.round(1.0 * SR);
const CONNECT_GAP      = Math.round(0.08 * SR);

class V32bis extends EventEmitter {
  constructor(role) {
    super();
    this.role = role === 'originate' ? 'originate' : 'answer';
    this._ready = false;
    if (this.role === 'originate') { this._txTap = 17; this._rxTap = 4; }
    else                           { this._txTap = 4;  this._rxTap = 17; }
    this._rate = 14400;

    // TX
    this.txByteQ = [];
    this.scr = new Array(23).fill(0);
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
    this.rateMismatch = null;

    // §6 progress; see V32.js for why these survive _resetRx().
    this._sawPeerS = false;
    this._sawR1 = false;
    this._sawR2 = false;
    this._sawR3 = false;
    this._sawPeerE = false;
    this._rxStage = this.role === 'originate' ? 'r1' : 'r2';
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
    this.txPrevY = 0;                 // differential quadrant state (Table 2/V.32bis)
    this.txConv = { a: 0, b: 0, c: 0 }; // convolutional encoder state
    this.txFrame = null;
    this.txFramePos = 0;
    this.txEndSample = -1;
    this.txContinuous = false;
    this._suActive = false;
    this._suEnd = null;
    this._dataSyms = 0;
  }

  /**
   * §6's two roles, as a script of bursts. §6.2's answer modem transmits the
   * conditioning signal and R1 unprompted, ceases on detecting the call modem's S,
   * and transmits a second conditioning signal and R3 on detecting R2. §6.1's call
   * modem transmits nothing until it "detects an incoming S sequence ... and then
   * seek[s] to detect at least two consecutive identical 16-bit rate sequences", so
   * its first transmission is gated on R1 — which is what retired ORIG_LEAD.
   */
  _buildConnectScript(role) {
    if (role === 'answer') {
      return [
        { kind: 'tone', gap: 0 },
        { kind: 'startup', gap: CONNECT_GAP, rate: 'r1' },
        { kind: 'startup', gap: 0, gate: 'r2', rate: 'r3' },
      ];
    }
    return [
      { kind: 'startup', gap: 0, gate: 'r1', rate: 'r2' },
    ];
  }

  /**
   * §5.2's receiver conditioning signal: S for 256T, S̄ for 16T, then TRN. §5.2.3
   * initialises the scrambler to all zeros here and nothing in §5.3 re-initialises
   * it, so the same register runs on through the rate signals, through E and into
   * data mode — §8's rate renegotiation is the clause that DOES re-initialise it,
   * and that it says so there is why the start-up must not.
   */
  _buildConditioning(rateWhich) {
    const push = (p) => this.txSyms.push({ i: p.i * SU_GAIN, q: p.q * SU_GAIN });
    for (const p of V32S.buildS()) push(p);
    for (const p of V32S.buildSbar()) push(p);
    this.scr.fill(0);                                   // §5.2.3
    let lastRot = V32S.A;
    for (let n = 0; n < TRN_SYMBOLS; n++) {
      lastRot = V32S.trnRotation(n, () => this._scramble(1));
      push(V32S.ROT[lastRot]);
    }
    // How much of the queue is §5.2's conditioning signal. Instrumentation only:
    // _su exists from here on, so without this describe() would report the rate
    // signal while S, S̄ and TRN are still going out.
    this._suHeadRemaining = this.txSyms.length;
    this._su = {
      enc: new V32S.DiffEncoder(lastRot),               // §5.3's initialisation
      stage: 'rate', which: rateWhich, pending: [], reps: 0, lastRot,
    };
  }

  /**
   * The start-up segment on the wire now, named as §§5.2-5.3 name it. Read-only.
   * The conditioning signal (S, S̄, TRN) is built as one burst with no per-segment
   * cursor, so it reports as TRN — the segment that is 1280 of its 1424 symbols.
   */
  describe() {
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
      const q1 = this._scramble(bits[k]);
      const q2 = this._scramble(bits[k + 1]);
      out.push(this._su.enc.symbol(q1, q2));
    }
    return out;
  }

  _suRateGateOpen() {
    switch (this._su.which) {
      case 'r1': return this._sawPeerS;                 // §6.2 "cease transmitting"
      case 'r2': return this._sawR3;                    // §6.1 "until R3 is detected"
      default:   return this._sawPeerE;                 // §6.2, R3 ends on the peer's E
    }
  }

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
        // §5.3.2: complete the current 16-bit sequence first, which is why the gate
        // is tested only at a sequence boundary. E ends "any rate signal other than
        // R1"; §6.2 ends R1 by ceasing to transmit instead.
        if (su.reps >= RATE_MIN_REPEATS && this._suRateGateOpen()) {
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
      case 'to-data': this._suEnd = 'data'; return false;
      default:        this._suEnd = 'cease'; return false;
    }
  }

  /**
   * Table 5/V.32bis's 16 bits. §6.1: "R2 shall exclude rates not appearing in the
   * previously received rate signal R1." §6.2: "The data rate selected by R3 shall
   * be within those indicated by R2." Both are the intersection; R3 names one rate.
   */
  _rateWord(which) {
    let rates = RATE_SET;
    if (which !== 'r1') {
      const peer = this._peerRates || [];
      rates = RATE_SET.filter((r) => peer.includes(r));
      if (!rates.length) this.rateMismatch = `peer offered [${peer}], this modem runs [${RATE_SET}]`;
    }
    if (which === 'r3') rates = rates.slice(-1);
    return V32S.V32BIS_RATES.build(rates);
  }

  /**
   * Table 6/V.32bis's sequence E: B4-B12 as Table 5 "except the only data rate to
   * be indicated shall relate to the transmission of scrambled binary ones
   * immediately following signal E".
   */
  _eWord() { return V32S.V32BIS_RATES.build([this._selectedRate()], { sequence: 'e' }); }

  _selectedRate() {
    const peer = this._peerRates || [];
    const common = RATE_SET.filter((r) => peer.includes(r));
    return common.length ? common[common.length - 1] : RATE_MAX;
  }

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
    this._buildConditioning(step.rate);
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
    if (gate === 'r1') return this._sawR1;
    if (gate === 'r2') return this._sawR2;
    return true;
  }

  /**
   * §6's handover out of E. Same carrier, same scrambler; the differential quadrant
   * state carries over from E's final symbol. §6.1 and §6.2 both say the
   * convolutional encoder's delay elements "shall be set to zero" here, which is
   * the one part of this transition the Recommendation states outright.
   */
  _enterTxData() {
    this.txPrevY = V32S.Y_OF_ROT[this._su.lastRot];
    this.txConv = { a: 0, b: 0, c: 0 };
    this._rate = this._selectedRate();
    this._dataSyms = 0;
  }

  // §6's 128 symbol intervals of scrambled binary ones after E come out of the
  // idle-mark branch, which is what they already are on the wire.
  _txBit() {
    if (this.txFrame) {
      const b = this.txFrame[this.txFramePos++];
      if (this.txFramePos >= this.txFrame.length) this.txFrame = null;
      return this._scramble(b);
    }
    let by = null;
    if (this._dataSyms >= E_TO_DATA_SYMBOLS && this.txByteQ.length) by = this.txByteQ.shift();
    if (by !== null) {
      this.txFrame = [0, by & 1, (by >> 1) & 1, (by >> 2) & 1, (by >> 3) & 1,
                      (by >> 4) & 1, (by >> 5) & 1, (by >> 6) & 1, (by >> 7) & 1, 1];
      this.txFramePos = 1;
      return this._scramble(0);
    }
    return this._scramble(1);         // idle mark
  }

  // Generate one data symbol point from six scrambled bits.
  _dataSymbol() {
    const Q1 = this._txBit(), Q2 = this._txBit(), Q3 = this._txBit(),
          Q4 = this._txBit(), Q5 = this._txBit(), Q6 = this._txBit();
    const din = (Q1 << 1) | Q2;
    this.txPrevY = TAB1[din][this.txPrevY];          // differential (Table 1)
    const Y1 = (this.txPrevY >> 1) & 1, Y2 = this.txPrevY & 1;
    const Y0 = convEncode(this.txConv, Y1, Y2);       // redundant trellis bit
    const idx = (Y0 << 6) | (Y1 << 5) | (Y2 << 4) | (Q3 << 3) | (Q4 << 2) | (Q5 << 1) | Q6;
    return C128[idx];
  }

  _ensureSymbols(k) {
    if (!this.txContinuous) return;
    while (this.txSymBase + this.txSyms.length <= k) {
      if (this._suActive) {
        const p = this._suNext();
        if (p) { this.txSyms.push(p); continue; }
        this._suActive = false;
        if (this._suEnd === 'cease') {
          // §6.2's "cease transmitting": stop being continuous and let the fixed-
          // burst end condition flush the shaper so the carrier goes down cleanly.
          this.txContinuous = false;
          this.txEndSample = Math.ceil((this.txSyms.length + SPAN / 2) * SPS);
          return;
        }
        this._enterTxData();
      }
      this.txSyms.push(this._dataSymbol());
      this._dataSyms++;
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
    this.rxPrevY = 0;
    this.outbits = [];
    this.uState = 'hunt'; this.uArmed = false; this.uMarks = 0; this.uBit = 0; this.uByte = 0;
    // Which signal this burst is; see V32.js. The burst that ends in E flows into
    // data mode without the carrier dropping, so the phase changes on E.
    this.rxPhase = this._sawPeerE ? 'data' : 'startup';
    this._sRef = null;
    this._suRx = {
      dec: new V32S.DiffDecoder(),
      framer: new V32S.RateFramer(V32S.V32BIS_RATES),
      runKind: null, runLen: 0, lastRot: -1,
    };
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
        // §6.2's "cease transmitting" between R1 and the second conditioning
        // signal, or a hangup once data is up. R1 and R3 arrive in those two
        // different transmissions, so the stage advances HERE — advancing on the
        // first detection would take the second repetition of R1 for R3.
        this._process();
        if (this.role === 'originate' && this._rxStage === 'r1' && this._sawR1) this._rxStage = 'r3';
        this.rxOn = false;
        this._resetRx();
      }
    }
    if (this.rxOn) this._process();
  }

  /**
   * §5.2's conditioning signal, received. The whole method — the S confirmation,
   * the parity resolution from Table 2/V.32bis's +90° A-to-B step, and the
   * forward-only walk — is V32.js's, because §5.2 is the same clause and Figure
   * 2-5's four states are Figure 1/V.32's four states. See V32.js for why the
   * parity matters: getting it wrong reflects the labelling rather than rotating
   * it, and negates every differential decode.
   */
  _huntStartup() {
    const CONFIRM = 16;
    if (!this._sRef) {
      if (this.rx.length < Math.ceil((CONFIRM + 4) * SPS + SPAN * SPS)) return;
      let onset = -1, e = 0;
      for (let n = 0; n < this.rx.length; n++) {
        const b = this._bb(n); const m = Math.hypot(b[0], b[1]);
        e = 0.85 * e + 0.15 * m;
        if (e > 0.04) { onset = Math.max(0, n - 4); break; }
      }
      if (onset < 0) return;
      let best = onset, bestScore = -1;
      for (let bo = Math.max(0, onset - 2 * SPS); bo <= onset + 2 * SPS; bo += SPS / 64) {
        let sc = 0;
        for (let k = 0; k < 12; k++) { const s = this._sym(bo + k * SPS); sc += Math.hypot(s[0], s[1]); }
        if (sc > bestScore) { bestScore = sc; best = bo; }
      }
      const sIQ = [];
      for (let j = 0; j < CONFIRM; j++) sIQ.push(this._sym(best + j * SPS));
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
      const acc = [[0, 0], [0, 0]], cnt = [0, 0];
      for (let j = 0; j < CONFIRM; j++) { const pp = j & 1; acc[pp][0] += sIQ[j][0]; acc[pp][1] += sIQ[j][1]; cnt[pp]++; }
      let a = [acc[0][0] / cnt[0], acc[0][1] / cnt[0]];
      let b = [acc[1][0] / cnt[1], acc[1][1] / cnt[1]];
      if (a[0] * b[1] - a[1] * b[0] < 0) { const t = a; a = b; b = t; }
      this._sRef = { base: best, idx: CONFIRM, refs: [a, b, [-a[0], -a[1]], [-b[0], -b[1]]] };
    }

    const r = this._sRef;
    const end = this.rxBase + this.rx.length - 1;
    while (this.rxPhase === 'startup') {
      const pos = r.base + r.idx * SPS;
      if (pos + SPAN / 2 * SPS >= end) return;
      const s = this._sym(pos);
      r.idx++;
      let bestRot = 0, bestDot = -Infinity;
      for (let rot = 0; rot < 4; rot++) {
        const ref = r.refs[rot];
        const dot = s[0] * ref[0] + s[1] * ref[1];
        if (dot > bestDot) { bestDot = dot; bestRot = rot; }
      }
      this._suSymbol(bestRot);
    }
  }

  /** One classified start-up symbol; see V32.js for the descrambler's convergence. */
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

  _suSequenceSeen(hit, lastRot) {
    if (hit.kind === 'e') {
      this._sawPeerE = true;
      this._enterRxData(lastRot);
      return;
    }
    this._peerRates = hit.advertised;
    this.peerRate = hit.best;
    if (this.role === 'answer') { this._sawR2 = true; return; }
    if (this._rxStage === 'r1') this._sawR1 = true; else this._sawR3 = true;
  }

  /**
   * §6's handover out of E, the mirror of _enterTxData. Nothing is re-acquired: the
   * timing lock is S's and the channel estimate is S's state A as the channel
   * presented it, which is what makes the data burst's invented 72-symbol preamble
   * unnecessary — it is gone.
   */
  _enterRxData(lastRot) {
    const r = this._sRef;
    const a = r.refs[V32S.A];
    const A0 = V32S.ROT[V32S.A];
    const di = A0.i * SU_GAIN, dq = A0.q * SU_GAIN;
    const d2 = di * di + dq * dq;
    this.gr = (a[0] * di + a[1] * dq) / d2;
    this.gi = (a[1] * di - a[0] * dq) / d2;
    this.g2 = this.gr * this.gr + this.gi * this.gi || 1e-9;
    this.base = r.base;
    this.symIdx = r.idx;
    this.rxPrevY = V32S.Y_OF_ROT[lastRot];
    this._rate = this._selectedRate();
    if (this._rate !== RATE_MAX) {
      this.rateMismatch = `E selects ${this._rate}; only ${RATE_MAX} is wired for data`;
    }
    this.acq = true;
    this.rxPhase = 'data';
    if (!this._ready) {
      this._ready = true;
      this.emit('ready', { bps: this._rate, remoteDetected: true });
    }
  }

  _process() {
    // TRN is over a thousand symbols of scrambled states; handing it to a data
    // slicer produces bytes out of training, which is what this split prevents.
    if (this.rxPhase === 'startup') {
      this._huntStartup();
      if (this.rxPhase === 'startup') return;
    }

    while (true) {
      const pos = this.base + this.symIdx * SPS;
      const end = this.rxBase + this.rx.length - 1;
      if (pos + SPAN / 2 * SPS >= end) break;
      const s = this._sym(pos);
      const xI = (s[0] * this.gr + s[1] * this.gi) / this.g2;
      const xQ = (s[1] * this.gr - s[0] * this.gi) / this.g2;
      const p = slicePoint(xI, xQ);
      const idx = IDX.get(p.i * 100 + p.q);
      if (idx === undefined) { this.symIdx++; continue; }
      const Y1 = (idx >> 5) & 1, Y2 = (idx >> 4) & 1;
      const Q3 = (idx >> 3) & 1, Q4 = (idx >> 2) & 1, Q5 = (idx >> 1) & 1, Q6 = idx & 1;
      const yNew = (Y1 << 1) | Y2;
      const din = INV1[this.rxPrevY][yNew]; this.rxPrevY = yNew;   // differential decode
      const Q1 = (din >> 1) & 1, Q2 = din & 1;
      const bits = [Q1, Q2, Q3, Q4, Q5, Q6];
      for (const bit of bits) { const r = this.des; const ob = bit ^ r[this._rxTap] ^ r[22]; r.unshift(bit); r.pop(); this.outbits.push(ob); }
      this.symIdx++;
      this._uartConsume();

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

  // The rate signals are §5.3's own 16-bit sequences on the wire now, not
  // reserved bytes in this stream, so nothing here is stripped.
  _rxByte(b) { this.emit('data', Buffer.from([b])); }
}

module.exports = { V32bis };
