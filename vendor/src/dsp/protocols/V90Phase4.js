'use strict';

/**
 * V90Phase4 — the CP and MP parameter-exchange sequences of ITU-T V.90 (09/98),
 * built to the Recommendation's own bit layouts (Table 14/V.90 for CP, Table
 * 16/V.90 for MP) rather than to an invented framing.
 *
 * CP travels analogue→digital and is what actually configures the downstream:
 * the selected rate, the shaping redundancy Sr, the lookahead depth lₐ, the
 * spectral shaper coefficients, the µ-law/A-law codec selection, the
 * constellations themselves and which constellation each of the six data frame
 * intervals uses. MP travels digital→analogue and reports the upstream rate the
 * digital modem will accept plus the analogue transmitter's coding parameters.
 *
 * ── Sequence structure ──────────────────────────────────────────────────────
 * Both sequences are a run of 17 ones (frame sync) followed by 17-bit groups,
 * each group being a start bit 0 plus 16 payload bits, and ending with a CRC
 * group and fill. Every field below is placed at the literal bit position the
 * table gives, so the layout can be audited against the printed Recommendation
 * line by line.
 *
 *   CP (Table 14):
 *     0:16    frame sync, 17 ones          17      start bit 0
 *     18      reserved (0)                 19      0 = CPt, 1 = CP
 *     20:24   drn, rate = (drn+20)·8000/6  25:29   reserved (0)
 *     30      silent-period request        31:32   Sr, shaping redundancy
 *     33      acknowledge (MP seen)        34      start bit 0
 *     35      codec: 0 = µ-law, 1 = A-law  36:48   upstream rate capability mask
 *     49:50   lₐ lookahead frames          51      start bit 0
 *     52:67   TRN1d RMS ratio, uQ3.13      68      start bit 0
 *     69:76   a₁, signed Q1.6              77:84   a₂, signed Q1.6
 *     85      start bit 0                  86:93   b₁, signed Q1.6
 *     94:101  b₂, signed Q1.6              102     start bit 0
 *     103:127 six 4-bit constellation indices (one per data frame interval,
 *             with a start bit 0 at 119 splitting intervals 3 and 4)
 *     128     transmitter constellations differ from codec output
 *     129:135 reserved (0)
 *     136…271 constellation 0: eight 17-bit groups, each a start bit 0 plus a
 *             16-bit Uchord mask (chord 1 = Ucodes 0..15, … chord 8 = 112..127)
 *     …       up to six constellations, then optional codec constellations
 *     then    start bit 0, 16-bit CRC, fill 000
 *
 *   MP (Table 16), Type 0 (no precoder coefficients):
 *     0:16    frame sync, 17 ones          17      start bit 0
 *     18      MP type (0 = no precoder)    19:23   reserved (0)
 *     24:27   drn, upstream rate = drn·2400 (drn 2..14 ⇒ 4800..33600)
 *     28      reserved (0)                 29:30   trellis select (0 = 16 state)
 *     31      nonlinear encoder Θ select   32      shaping select
 *     33      acknowledge (CP seen)        34      start bit 0
 *     35      reserved (0)                 36:49   upstream rate capability mask
 *     50      reserved (0)                 51      start bit 0
 *     52:67   reserved (0)                 68      start bit 0
 *     69:84   CRC                          85…     fill to a multiple of 6
 *
 * ── The two honest gaps ─────────────────────────────────────────────────────
 *   1. **Transport.** Real CP/MP are modulated by the Phase 4 signalling of the
 *      startup sequence. Here the finished bit sequence is packed into bytes and
 *      carried over the already-established link (CP over the upstream V.34, MP
 *      in the downstream data stream). The CONTENT is bit-exact to the tables;
 *      the way it crosses the wire is not. This matters for real-modem interop
 *      and is recorded in PROTOCOLS.md.
 * ── and one that is now closed ──────────────────────────────────────────────
 *   The CRC. §10.1.2.3.2/V.34 is transcribed — generator x¹⁶ + x¹² + x⁵ + 1,
 *   register preset to all ones, covering every information bit *except* the
 *   frame sync bits, the start bits and the fill bits, remainder emitted as-is,
 *   bit 0 first and bit 0 the LSB — and its Figure 14, which was thought not to
 *   transcribe, has since been read off the page image: the register shifts DOWN
 *   in stage number with the information bit entering at stage 0, so the taps are
 *   stages 15, 10 and 3. See BitFrame.js's crc16 and v34-phase2-check.
 */

const CP_SYNC_BITS = 17;
const GROUP = 17;                     // one start bit + 16 payload bits
const CHORDS = 8, CHORD_BITS = 16;    // 8 × 16 = the 128 Ucodes
const CP_CONST_BITS = CHORDS * GROUP; // 136 bits per constellation
const CP_FIXED_END = 136;             // first constellation starts here
const UCODES = 128;

// Upstream capability mask: 13 rates, 4800..33600 in 2400 steps (CP bits 36:48).
const UPSTREAM_RATES = [4800, 7200, 9600, 12000, 14400, 16800, 19200,
                        21600, 24000, 26400, 28800, 31200, 33600];

// ─── bit helpers ────────────────────────────────────────────────────────────
// Shared with V.34's MP; see BitFrame.js for the CRC convention and its one
// remaining unverified degree of freedom.
const BF = require('./BitFrame');
const {
  putUInt, getUInt, putQ1_6, getQ1_6, putQ3_13, getQ3_13,
  crc16, crcCoverage, crcOf, findSequence, bitsToBytes, bytesToBits, newSequence,
} = BF;

// ─── CP ─────────────────────────────────────────────────────────────────────
function cpLength(nConstellations) {
  return CP_FIXED_END + nConstellations * CP_CONST_BITS + GROUP + 3;
}
// Keyed on the constellation count, which is the only thing it depends on: the list
// is rebuilt at every candidate position of every CP hunt otherwise, and BitFrame
// caches the Set it turns into by array identity.
const CP_STARTS = new Map();
function cpStartBits(nConstellations) {
  const hit = CP_STARTS.get(nConstellations);
  if (hit) return hit;
  const out = cpStartBitsOf(nConstellations);
  CP_STARTS.set(nConstellations, out);
  return out;
}
function cpStartBitsOf(nConstellations) {
  const s = [17, 34, 51, 68, 85, 102, 119, 136];
  for (let c = 0; c < nConstellations; c++) {
    for (let ch = 0; ch < CHORDS; ch++) s.push(CP_FIXED_END + c * CP_CONST_BITS + ch * GROUP);
  }
  s.push(CP_FIXED_END + nConstellations * CP_CONST_BITS);   // CRC group's start bit
  return [...new Set(s)];
}

/** The CP CRC, computed over the sequence at `at` without copying it out. */
function cpCrc(bits, n, at = 0) {
  return crcOf(bits, cpStartBits(n), CP_SYNC_BITS, CP_FIXED_END + n * CP_CONST_BITS, at);
}

/**
 * Build a CP sequence. `constellations` is an array of 1..6 masks (Uint8Array(16),
 * bit u = Ucode u); `intervalIndex` is six integers selecting one per interval.
 */
function buildCP(o) {
  const cons = o.constellations;
  if (!cons.length || cons.length > 6) throw new Error('V.90 CP: 1..6 constellations');
  const n = cons.length;
  const bits = newSequence(cpLength(n), cpStartBits(n));

  bits[19] = o.cpt ? 0 : 1;                                  // 1 = CP, 0 = CPt
  putUInt(bits, 20, 24, o.drn);                              // rate = (drn+20)·8000/6
  bits[30] = o.silent ? 1 : 0;
  putUInt(bits, 31, 32, o.Sr);
  bits[33] = o.ack ? 1 : 0;
  bits[35] = o.aLaw ? 1 : 0;                                 // 0 = µ-law
  for (let i = 0; i < UPSTREAM_RATES.length; i++) {
    bits[36 + i] = (o.upstreamRates || []).includes(UPSTREAM_RATES[i]) ? 1 : 0;
  }
  putUInt(bits, 49, 50, o.ld);
  putQ3_13(bits, 52, o.trnRatio == null ? 1 : o.trnRatio);
  putQ1_6(bits, 69, o.coefs.a1);
  putQ1_6(bits, 77, o.coefs.a2);
  putQ1_6(bits, 86, o.coefs.b1);
  putQ1_6(bits, 94, o.coefs.b2);
  // six 4-bit interval→constellation indices, with the start bit at 119 between
  // intervals 3 and 4 (hence the 103/120 split rather than a flat run).
  const idx = o.intervalIndex;
  for (let i = 0; i < 4; i++) putUInt(bits, 103 + i * 4, 106 + i * 4, idx[i]);
  for (let i = 0; i < 2; i++) putUInt(bits, 120 + i * 4, 123 + i * 4, idx[4 + i]);
  bits[128] = o.constellationsDiffer ? 1 : 0;

  for (let c = 0; c < n; c++) {
    const mask = cons[c];
    for (let ch = 0; ch < CHORDS; ch++) {
      const base = CP_FIXED_END + c * CP_CONST_BITS + ch * GROUP + 1;
      for (let k = 0; k < CHORD_BITS; k++) {
        const u = ch * CHORD_BITS + k;
        bits[base + k] = (mask[u >> 3] >> (u & 7)) & 1;
      }
    }
  }

  const crcStart = CP_FIXED_END + n * CP_CONST_BITS;
  putUInt(bits, crcStart + 1, crcStart + 16, cpCrc(bits, n));
  return bits;
}

function parseCP(bits, nConstellations) {
  const n = nConstellations;
  const crcStart = CP_FIXED_END + n * CP_CONST_BITS;
  const want = cpCrc(bits, n);
  const got = getUInt(bits, crcStart + 1, crcStart + 16);
  const upstreamRates = [];
  for (let i = 0; i < UPSTREAM_RATES.length; i++) if (bits[36 + i]) upstreamRates.push(UPSTREAM_RATES[i]);
  const intervalIndex = [];
  for (let i = 0; i < 4; i++) intervalIndex.push(getUInt(bits, 103 + i * 4, 106 + i * 4));
  for (let i = 0; i < 2; i++) intervalIndex.push(getUInt(bits, 120 + i * 4, 123 + i * 4));
  const constellations = [];
  for (let c = 0; c < n; c++) {
    const mask = new Uint8Array(16);
    for (let ch = 0; ch < CHORDS; ch++) {
      const base = CP_FIXED_END + c * CP_CONST_BITS + ch * GROUP + 1;
      for (let k = 0; k < CHORD_BITS; k++) {
        if (bits[base + k]) { const u = ch * CHORD_BITS + k; mask[u >> 3] |= 1 << (u & 7); }
      }
    }
    constellations.push(mask);
  }
  return {
    crcOk: want === got, sync: bits.slice(0, 17).every(b => b === 1),
    isCP: bits[19] === 1, drn: getUInt(bits, 20, 24), silent: !!bits[30],
    Sr: getUInt(bits, 31, 32), ack: !!bits[33], aLaw: !!bits[35],
    upstreamRates, ld: getUInt(bits, 49, 50), trnRatio: getQ3_13(bits, 52),
    coefs: { a1: getQ1_6(bits, 69), a2: getQ1_6(bits, 77), b1: getQ1_6(bits, 86), b2: getQ1_6(bits, 94) },
    intervalIndex, constellationsDiffer: !!bits[128], constellations,
  };
}

// ─── MP (Type 0) ────────────────────────────────────────────────────────────
const MP_START_BITS = [17, 34, 51, 68];
const MP_CRC_START = 68;
const MP_LAST_BIT = 85;                             // last defined bit before fill
/**
 * Table 16's fill: "0s to extend the MP sequence length to the next multiple of 6
 * SYMBOLS". §8.6.3 transmits MP "using the constellation parameters used to send
 * TRN2d", so a symbol is not a bit: six symbols are one data frame and one data
 * frame carries D bits, D being the training constellation's. "The next multiple of
 * 6 symbols" is therefore the next whole data frame, and the fill depends on D — which
 * is why this takes it. The default of 6 is the degenerate one-bit-per-symbol
 * carriage and gives the 90 bits the table reads as when a symbol IS a bit.
 */
function mpLength(D = 6) {
  return Math.ceil((MP_LAST_BIT + 1) / D) * D;
}
function buildMP(o) {
  const bits = newSequence(mpLength(o.D), MP_START_BITS);
  bits[18] = 0;                                     // Type 0 — no precoder coefficients
  putUInt(bits, 24, 27, o.drn);                     // upstream rate = drn·2400
  putUInt(bits, 29, 30, o.trellis == null ? 0 : o.trellis);   // 0 = 16 state
  bits[31] = o.nonlinear ? 1 : 0;
  bits[32] = o.expandedShaping ? 1 : 0;
  bits[33] = o.ack ? 1 : 0;
  for (let i = 0; i < UPSTREAM_RATES.length; i++) {
    bits[36 + i] = (o.upstreamRates || []).includes(UPSTREAM_RATES[i]) ? 1 : 0;
  }
  putUInt(bits, MP_CRC_START + 1, MP_CRC_START + 16, mpCrc(bits));
  return bits;
}
function mpCrc(bits, at = 0) {
  return crcOf(bits, MP_START_BITS, CP_SYNC_BITS, MP_CRC_START, at);
}
function parseMP(bits) {
  const want = mpCrc(bits);
  const got = getUInt(bits, MP_CRC_START + 1, MP_CRC_START + 16);
  const upstreamRates = [];
  for (let i = 0; i < UPSTREAM_RATES.length; i++) if (bits[36 + i]) upstreamRates.push(UPSTREAM_RATES[i]);
  return {
    crcOk: want === got, sync: bits.slice(0, 17).every(b => b === 1),
    type: bits[18], drn: getUInt(bits, 24, 27), trellis: getUInt(bits, 29, 30),
    nonlinear: !!bits[31], expandedShaping: !!bits[32], ack: !!bits[33], upstreamRates,
  };
}


// ── §8.5 and §8.6 — the Phase 4 SIGNALS, as distinct from the sequences ─────
//
// Everything above is bit content. This is the signalling §9.4 actually puts on
// the wire around it, and until now none of it existed: CP and MP crossed as
// DLE-framed byte payloads on the established link. Built here as standalone
// blocks, round-trip verified by v90-phase4-check, and wired to nothing yet, so
// that a data path which works is not disturbed by a signal that is not finished.
//
// The analogue modem's three (§8.5) are all V.34's, by reference: B1 is
// §10.1.3.1/V.34, E is §10.1.3.2/V.34, and CP "is modulated according to
// 10.1.3.9/V.34" — so they live in V34Phase4.js and are re-exported here under
// V.90's names, the way V90Phase3 does for MD, PP, S, SCR and TRN.

// §8.6.4 — "Signal R is transmitted by repeating the 6 symbol sequence containing
// PCM codewords with the sign pattern + + + – – – where the left-most sign is
// transmitted first. R̄ consists of 4 repetitions of the 6-symbol sequence
// containing the same PCM codewords with the sign pattern – – – + + + where the
// left-most sign is transmitted first."
//
// A sign of 1 is positive here, as everywhere else in §8.4 and §8.6.
const R_SIGNS = [1, 1, 1, 0, 0, 0];
const RBAR_SIGNS = [0, 0, 0, 1, 1, 1];
// R̄'s length is fixed by the clause and is not a minimum: four repetitions, which
// is 24 symbols — and §9.4.1.2's "send signal R̄i for 24T" is the same number said
// twice, which is what pins which of the two signals carries the bar. R itself has
// no stated length; §9.4.1.1 gives it a minimum of 192T.
const RBAR_REPS = 4;
const R_PERIOD = 6;                   // one data frame: six data frame intervals
const RBAR_SYMBOLS = RBAR_REPS * R_PERIOD;
const R_MIN_SYMBOLS = 192;            // §9.4.1.1

/**
 * §8.6.4's R or R̄, as signed PCM codewords.
 *
 * `ucodes` is the codeword for each of the six data frame intervals, and it is the
 * only thing that separates the clause's three named variants: Rd takes "the
 * highest power PCM codeword from the data mode constellation of each data frame
 * interval as passed in CP", Rt the same from the training constellation passed in
 * CPt, and Ri "the single PCM codeword whose Ucode is U_INFO for all data frame
 * intervals". So this builder takes the six and the caller names the signal.
 *
 * NOTE, and it is the Recommendation's own: "Neither R nor R̄ are differentially
 * encoded. This imposes a requirement on the receiver to be able to detect these
 * sequences regardless of their polarity." A receiver that locked to the absolute
 * sign would find the R-to-R̄ transition §9.4.2.1 waits for at one polarity and
 * miss it at the other.
 */
function buildR(ucodes, repetitions, bar = false) {
  if (ucodes.length !== R_PERIOD) throw new Error(`V.90 §8.6.4: R needs ${R_PERIOD} codewords`);
  const signs = bar ? RBAR_SIGNS : R_SIGNS;
  const out = [];
  for (let r = 0; r < repetitions; r++) {
    for (let k = 0; k < R_PERIOD; k++) out.push({ ucode: ucodes[k], sign: signs[k] });
  }
  return out;
}
/** R̄, whose four repetitions are the clause's own number. */
function buildRbar(ucodes) { return buildR(ucodes, RBAR_REPS, true); }
/** The single-codeword variants: Ri and R̄i, "for all data frame intervals". */
function iCodewords(uInfo) { return new Array(R_PERIOD).fill(uInfo); }

// §8.6.5 — "TRN2d is generated by applying scrambled binary ones to the encoder of
// 5.4 ... TRN2d shall be an integer multiple of 6 symbols long", and §9.4.1.2 asks
// for "a minimum of 2040T". §8.6.1 — "B1d consists of 48 data frames of scrambled
// ones". §8.6.2 — "Ed consists of 2 data frames of scrambled binary zeroes used to
// signal the end of MP."
//
// All three are the data-mode encoder fed a constant bit, so what a builder can
// state on its own is the bit and the length; the symbols belong to whichever
// encoder is in force, which is the point of the clauses naming different
// constellations for each (TRN2d and Ed use CPt's, B1d uses CP's data-mode set).
const TRN2D_MIN_SYMBOLS = 2040;
const ED_FRAMES = 2, B1D_FRAMES = 48;
const SYMS_PER_FRAME = 6;
const ED_SYMBOLS = ED_FRAMES * SYMS_PER_FRAME;
const B1D_SYMBOLS = B1D_FRAMES * SYMS_PER_FRAME;
/** The bit fed to the scrambler for each: ones for TRN2d and B1d, zeroes for Ed. */
const TRN2D_BIT = 1, B1D_BIT = 1, ED_BIT = 0;

// Table 17/V.90 — "Phase 4 signalling rate for different K and S". K runs 6 to 24
// and S 3 to 6 for every K, and every printed rate is (K + S) · 8000/6 bit/s: the
// table's two rate columns are that formula at S = 3 and at S = 6. Carried as the
// formula rather than as 19 transcribed rows: a value the Recommendation states as
// a formula is carried as the formula, with the printed endpoints asserted against
// it in v90-phase4-check.
const P4_K_MIN = 6, P4_K_MAX = 24;
const P4_S_MIN = 3, P4_S_MAX = 6;
function phase4Rate(K, S) {
  if (K < P4_K_MIN || K > P4_K_MAX) throw new Error(`V.90 Table 17: K ${K} is outside 6..24`);
  if (S < P4_S_MIN || S > P4_S_MAX) throw new Error(`V.90 Table 17: S ${S} is outside 3..6`);
  return (K + S) * 8000 / 6;
}

module.exports = {
  CP_SYNC_BITS, GROUP, CHORDS, CHORD_BITS, CP_CONST_BITS, CP_FIXED_END, UPSTREAM_RATES,
  cpLength, cpStartBits, cpCrc, mpCrc, findSequence,
  buildCP, parseCP, mpLength, MP_START_BITS, MP_CRC_START,
  buildMP, parseMP,
  R_SIGNS, RBAR_SIGNS, RBAR_REPS, R_PERIOD, RBAR_SYMBOLS, R_MIN_SYMBOLS,
  buildR, buildRbar, iCodewords,
  TRN2D_MIN_SYMBOLS, ED_FRAMES, B1D_FRAMES, ED_SYMBOLS, B1D_SYMBOLS,
  TRN2D_BIT, B1D_BIT, ED_BIT,
  P4_K_MIN, P4_K_MAX, P4_S_MIN, P4_S_MAX, phase4Rate,
  crc16, crcCoverage, bitsToBytes, bytesToBits, putUInt, getUInt, putQ1_6, getQ1_6, putQ3_13, getQ3_13,
};
