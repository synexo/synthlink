'use strict';

/**
 * V34Phase3 — the Phase 3 segments of ITU-T V.34 (02/98) §10.1.3: S, S̄, MD, PP,
 * TRN and the J / J′ sequences that terminate a modem's own Phase 3. Built to the
 * Recommendation's own definitions the way V34Phase4 is built to Table 20 and
 * V90Phase3 to Tables 12 and 13, rather than to the 250 ms alternation that stood
 * in for the whole of Phase 3 before this.
 *
 * V.90 §9.3.2 does not redefine these — it references V.34's, and its analogue
 * modem's Phase 3 IS this sequence — so one implementation serves both. The
 * digital modem's half (Sd, TRN1d, Jd, J′d, DIL) is a different set of signals
 * and lives in V90Phase3.js.
 *
 * ── The order, from §11.3 ───────────────────────────────────────────────────
 * Figure 19/V.34 draws it, but the prose is what this follows (CLAUDE.md's rule,
 * and the same trap Figure 5/V.90 set for the digital modem):
 *
 *   §11.3.1.2.1  the ANSWER modem, after INFO1a, transmits silence for 70 ± 5 ms,
 *                then S for 128T and S̄ for 16T. If its MD length is zero it goes
 *                to .2.2; otherwise MD, then S for 128T and S̄ for 16T again
 *   §11.3.1.2.2  it then transmits PP
 *   §11.3.1.2.3  then TRN, four constellation points, for at least 512T
 *   §11.3.1.2.4  then J, while conditioning its receiver for S and the S-to-S̄
 *                transition; on detecting it, silence
 *   §11.3.1.2.6  after receiving the far end's J it may wait up to 500 ms, then
 *                begins transmitting S and proceeds to Phase 4
 *
 *   §11.3.1.1.1  the CALL modem is INITIALLY SILENT, conditioning its receiver to
 *                detect S and the subsequent S̄
 *   §11.3.1.1.2  after the S-to-S̄ transition it trains its equaliser on PP and may
 *                refine it on the first 512T of TRN
 *   §11.3.1.1.3  after that it receives J; having received J it may wait up to
 *                500 ms and then transmits S for 128T and S̄ for 16T
 *   §11.3.1.1.4  MD if its length is non-zero, then S 128T and S̄ 16T again
 *   §11.3.1.1.5  then PP
 *   §11.3.1.1.6  then TRN, four constellation points, at least 512T
 *   §11.3.1.1.7  then J, conditioning its receiver to detect S; on detecting S it
 *                proceeds to Phase 4
 *
 * So the answer modem leads and the call modem is gated on a SIGNAL rather than on
 * a timer. That is what replaced `ORIG_LEAD`, a 0.60 s originate-side silence with
 * no basis in the Recommendation: the V.8 sequencer hands the two ends their
 * protocol at measurably different instants (the originate side leaves CJ when its
 * transmit queue drains, the answer side when it has DEMODULATED CJ), so a fixed
 * lead is a guess at a skew that a detector simply absorbs.
 *
 * ── Power ───────────────────────────────────────────────────────────────────
 * §10.1.3's NOTE: "the transmitter should compensate for modulation factors ... so
 * that the average signal power transmitted in Phases 3 and 4 is maintained in
 * segment B1 and the subsequent data mode." Every segment here is drawn from a
 * unit-scale point set — S, TRN and J from the four rotations of point 0, which has
 * energy 2, and PP from the unit circle — so the caller scales each segment to the
 * data burst's mean symbol energy. `meanEnergy()` is what it scales by, and the
 * clause above is why it is a requirement rather than a convenience: a Phase 3 that
 * is quieter than the data it precedes is a receiver that trains at the wrong gain.
 *
 * ── What this does not do ───────────────────────────────────────────────────
 * PP exists so the far end can train an equaliser and TRN so it can refine one;
 * MD exists to train an echo canceller. On this transport there is no ISI, no echo
 * and no drift, so the segments are transmitted faithfully and nothing is measured
 * from them — the same division V90Phase3 makes for DIL. A later interop receiver
 * ADDS a measurement behind a transmitter that is already the Recommendation's,
 * instead of having to replace an invented one.
 *
 * MD is length zero here and that is not an omission: §10.1.3.5 makes MD optional
 * and says "if the signal is not present, the MD length indication will be 0". Its
 * length is carried in INFO1, which does not exist until the line-probing item, so
 * a modem that has no manufacturer-defined signal declares none. The procedure
 * branch that would emit it is present and exercised.
 */

// Point 0 of the Figure 5 quarter superconstellation. §9.1 orders the quarter by
// magnitude, so point 0 is the smallest, and the quarter is the Re ≡ Im ≡ 1
// (mod 4) sublattice — which makes (1,1) point 0. Imported rather than restated
// would couple this module to a rate-specific config; asserted against the
// generator instead, in v34-phase3-check.
const POINT0 = { i: 1, q: 1 };

/** Rotate a point by rot·90° CLOCKWISE. R(a,b) = (b,−a), as V34Mapper's rotCW. */
function rotCW(p, rot) {
  let i = p.i, q = p.q;
  for (let r = 0; r < (rot & 3); r++) { const ni = q, nq = -i; i = ni; q = nq; }
  return { i, q };
}

// The four rotations of point 0, indexed by clockwise quarter-turns. Counter-
// clockwise by 90° is clockwise by 270°, which is how §10.1.3.7's wording maps on.
const P0_CW = [0, 1, 2, 3].map((r) => rotCW(POINT0, r));
const CW = { R0: 0, R90: 1, R180: 2, R270: 3 };

// ── §10.1.3.7 — S and S̄ ─────────────────────────────────────────────────────
// "Signal S is transmitted by alternating between point 0 of the quarter-
// superconstellation of Figure 5 and the same point rotated counterclockwise by
// 90 degrees. Signal S̄ is transmitted by alternating between point 0 rotated by
// 180 degrees and point 0 rotated counterclockwise by 270 degrees. The signal S
// shall end with the transmission of point 0 rotated counterclockwise by 90
// degrees. Signal S̄ shall begin with the transmission of point 0 rotated by 180
// degrees."
//
// CCW 90° = CW 270°, and CCW 270° = CW 90°. So S alternates rotations {0, 270}
// starting at 0, and S̄ alternates {180, 90} starting at 180 — and the two end/begin
// rules are then automatic for any even length, which is what makes the S-to-S̄
// transition a clean 180° phase reversal a receiver can find without timing
// recovery of the data kind.
const S_ROTS = [CW.R0, CW.R270];
const SBAR_ROTS = [CW.R180, CW.R90];

const S_SYMBOLS = 128;        // §11.3.1.1.3 / §11.3.1.2.1 — S is 128T
const SBAR_SYMBOLS = 16;      // and S̄ is 16T

function buildS(count = S_SYMBOLS) {
  if (count % 2 !== 0) throw new Error(`V.34 S must be an even number of symbols: ${count}`);
  const out = new Array(count);
  for (let n = 0; n < count; n++) out[n] = P0_CW[S_ROTS[n % 2]];
  return out;
}

function buildSbar(count = SBAR_SYMBOLS) {
  if (count % 2 !== 0) throw new Error(`V.34 S̄ must be an even number of symbols: ${count}`);
  const out = new Array(count);
  for (let n = 0; n < count; n++) out[n] = P0_CW[SBAR_ROTS[n % 2]];
  return out;
}

// ── §10.1.3.6 — PP ──────────────────────────────────────────────────────────
// "Signal PP consists of six periods of a 48-symbol sequence and is used by the
// remote modem for training its equalizer. PP(i), i = 0, 1, ..., 287 is defined as
// follows: Set i = 4k + I where k = 0, 1, 2, ..., 71; and I = 0, 1, 2, 3 for each k
// then: PP(i) = e^{jπ(kI+4)/6} if k modulo 3 = 1, = e^{jπkI/6} otherwise. PP(0) is
// transmitted first."
const PP_PERIOD = 48, PP_PERIODS = 6, PP_SYMBOLS = PP_PERIOD * PP_PERIODS;   // 288

function ppPhase(i) {
  const k = Math.floor(i / 4), I = i % 4;
  return (k % 3 === 1) ? Math.PI * (k * I + 4) / 6 : Math.PI * (k * I) / 6;
}

function buildPP() {
  const out = new Array(PP_SYMBOLS);
  for (let i = 0; i < PP_SYMBOLS; i++) {
    const ph = ppPhase(i);
    out[i] = { i: Math.cos(ph), q: Math.sin(ph) };
  }
  return out;
}

// ── §10.1.3.8 — TRN (4-point) ───────────────────────────────────────────────
// "Signal TRN is a sequence of symbols generated by applying binary ones to the
// input of the scrambler described in clause 7 ... The 4-point TRN signal is
// generated by using two scrambled bits, I1n and I2n, which are transmitted every
// 2D symbol interval, where I1n is the first bit in time. The transmitted points
// are obtained by rotating point 0 from the quarter-superconstellation of Figure 5
// clockwise by In · 90 degrees, where In = 2 · I2n + I1n. The scrambler is
// initialized to zero prior to transmission of the TRN signal."
//
// The 16-point form (§10.1.3.8's second half, four scrambled bits selecting a point
// from the quarter and then rotating it) is what J requests when it asks for a
// 16-point Phase 4. J here always asks for 4-point, so the 16-point branch is not
// built — and it is J's own bit pattern that says so, not an assumption.
const TRN_MIN_SYMBOLS = 512;   // §11.3.1.1.6 / §11.3.1.2.3 — "at least 512T"

/**
 * One TRN symbol from a bit source. `nextBit()` must return the SCRAMBLED bit —
 * the caller owns the scrambler, because it is the same clause 7 register the data
 * path uses and §10.1.3.8 requires it initialized to zero here specifically.
 */
function trnSymbol(nextBit) {
  const i1 = nextBit() & 1;                 // first in time
  const i2 = nextBit() & 1;
  return P0_CW[(2 * i2 + i1) & 3];
}

// ── §10.1.3.3 / §10.1.3.4, Tables 18 and 19 — J and J′ ──────────────────────
// Table 18/V.34, "Definition of bits in J sequence":
//   4-point  0000100110010001, where the left-most bit is first in time.
//   16-point 0000110110010001, where the left-most bit is first in time.
// Table 19/V.34, "Definition of bits in J′ sequence":
//   bits 0-15  1111100110010001, where the left-most bit is first in time.
//
// Held as strings so the transcription reads as the table prints, and turned into
// bit arrays once. The two J patterns differ in exactly one bit (position 5), which
// is the constellation-size request and the reason J is what selects Phase 4's
// constellation rather than a separate signal.
const J_PATTERN_4POINT = '0000100110010001';
const J_PATTERN_16POINT = '0000110110010001';
const JPRIME_PATTERN = '1111100110010001';
const J_BITS = 16;

const toBits = (s) => Array.from(s, (c) => (c === '1' ? 1 : 0));
const jPattern = (constellation) => {
  if (constellation === 4) return toBits(J_PATTERN_4POINT);
  if (constellation === 16) return toBits(J_PATTERN_16POINT);
  throw new Error(`V.34 J: constellation must be 4 or 16, got ${constellation}`);
};
const jPrimePattern = () => toBits(JPRIME_PATTERN);

/**
 * §10.1.3.3's differential encoder, as a small object because both J and J′ run it
 * and J′ "is generated as described in 10.1.3.3" — including continuing from where
 * J left it. "Integers In = 2 · I2n + I1n are differentially encoded to generate the
 * integer Zn as the modulo 4 sum of In and Zn−1. The transmitted points are obtained
 * by rotating point 0 ... clockwise by Zn · 90 degrees. The differential encoder
 * shall be initialized using the final symbol of the transmitted TRN sequence."
 *
 * So `z0` is the ROTATION of TRN's last symbol, not zero — which is why the caller
 * has to hand it over and why trnSymbol returns a point the caller can invert.
 */
class JEncoder {
  constructor(z0 = 0) { this.z = z0 & 3; }
  /** Two scrambled bits, I1 first in time, → the transmitted point. */
  symbol(i1, i2) {
    const In = (2 * (i2 & 1) + (i1 & 1)) & 3;
    this.z = (this.z + In) & 3;
    return P0_CW[this.z];
  }
}

/**
 * The inverse of JEncoder. Differential DECODING needs no initial state — In is
 * (Zn − Zn−1) mod 4 whatever Z0 was — which is what lets a receiver read J, J′ and
 * Ja without having seen the TRN symbol the transmitter initialised from.
 */
class JDecoder {
  constructor() { this.prev = null; }
  /** A transmitted rotation → [I1, I2], or null for the first symbol. */
  bits(rot) {
    const z = rot & 3;
    if (this.prev === null) { this.prev = z; return null; }
    const In = (z - this.prev + 4) & 3;
    this.prev = z;
    return [In & 1, (In >> 1) & 1];             // I1 first in time
  }
}

/**
 * §8.3.5/V.90 — SCR. "Signal SCR is defined as binary ones modulated according to
 * 10.1.3.9/V.34 except that neither the scrambler nor the differential encoder need
 * be initialized at the beginning of its transmission. During Phase 3 and Phase 4
 * start-up procedures the constellation size depends on bit 47 of Jd."
 *
 * 10.1.3.9's 4-point MP "is generated as described in 10.1.3.3", which is J's
 * modulation — so SCR is J's chain fed binary ones, with both the scrambler and the
 * differential encoder CONTINUING rather than restarting. The caller therefore hands
 * in its live scrambler and its live JEncoder, and that continuation is the whole of
 * what distinguishes SCR from TRN.
 *
 * The analogue modem transmits it, at its discretion, only to hold line energy up
 * while it receives DIL (§9.3.2.9, and the NOTE at the foot of §8.3.1: "The analogue
 * modem may also continuously transmit SCR during the reception of DIL to maintain
 * line energy"). Nothing reads it.
 */
function scrSymbol(scramble, jenc) {
  const i1 = scramble(1);                       // first in time
  const i2 = scramble(1);
  return jenc.symbol(i1, i2);
}

/** The clockwise rotation index of a point that is one of point 0's four. */
function rotationOf(p) {
  for (let r = 0; r < 4; r++) if (P0_CW[r].i === p.i && P0_CW[r].q === p.q) return r;
  throw new Error(`V.34: point (${p.i},${p.q}) is not a rotation of point 0`);
}

// ── Power (§10.1.3 NOTE) ────────────────────────────────────────────────────
/** Mean symbol energy of a segment, which is what the caller normalises against. */
function meanEnergy(symbols) {
  if (!symbols.length) return 0;
  let e = 0;
  for (const s of symbols) e += s.i * s.i + s.q * s.q;
  return e / symbols.length;
}

// ── Structure the Recommendation fixes, asserted at load ────────────────────
// Same rule as V.32bis's constellation and V.34's makeConfig: a mis-transcription
// should fail at require() rather than produce a link that works only against
// itself. Every check below is a property the clause states, not a property of
// this implementation.
(function assertStructure() {
  // §9.1: the four rotations of point 0 are distinct — a quarter that is not
  // rotation-disjoint would make S and S̄ the same signal.
  const seen = new Set(P0_CW.map((p) => `${p.i},${p.q}`));
  if (seen.size !== 4) throw new Error('V.34 Phase 3: point 0 rotations are not distinct');

  // §10.1.3.7's two end/begin rules.
  const s = buildS(), sb = buildSbar();
  if (rotationOf(s[s.length - 1]) !== CW.R270) {
    throw new Error('V.34 Phase 3: S does not end on point 0 rotated CCW 90°');
  }
  if (rotationOf(sb[0]) !== CW.R180) {
    throw new Error('V.34 Phase 3: S̄ does not begin on point 0 rotated 180°');
  }
  // The S-to-S̄ transition is a 180° reversal at every phase of the alternation —
  // this is the property the call modem's detector is built on, so it is asserted
  // rather than assumed.
  for (let k = 0; k < 2; k++) {
    if ((rotationOf(sb[k]) - rotationOf(s[k]) + 4) % 4 !== 2) {
      throw new Error('V.34 Phase 3: S̄ is not S reversed');
    }
  }

  // §10.1.3.6: "six periods of a 48-symbol sequence" — periodicity is a structural
  // consequence of equation 10-1 and a strong check on its transcription.
  const pp = buildPP();
  if (pp.length !== 288) throw new Error('V.34 Phase 3: PP is not 288 symbols');
  for (let i = 0; i < PP_SYMBOLS - PP_PERIOD; i++) {
    const a = pp[i], b = pp[i + PP_PERIOD];
    if (Math.hypot(a.i - b.i, a.q - b.q) > 1e-9) {
      throw new Error(`V.34 Phase 3: PP is not periodic in ${PP_PERIOD} at i=${i}`);
    }
  }
  // Every PP symbol is on the unit circle: e^{jθ} for every branch of (10-1).
  for (const p of pp) {
    if (Math.abs(Math.hypot(p.i, p.q) - 1) > 1e-12) {
      throw new Error('V.34 Phase 3: a PP symbol is not on the unit circle');
    }
  }

  // Tables 18 and 19 are 16 bits each, and the two J patterns differ in exactly the
  // one bit that names the constellation size.
  for (const [name, pat] of [['J 4-point', J_PATTERN_4POINT], ['J 16-point', J_PATTERN_16POINT], ['J′', JPRIME_PATTERN]]) {
    if (pat.length !== J_BITS || /[^01]/.test(pat)) {
      throw new Error(`V.34 Phase 3: ${name} pattern is not 16 binary digits`);
    }
  }
  let diff = 0;
  for (let k = 0; k < J_BITS; k++) if (J_PATTERN_4POINT[k] !== J_PATTERN_16POINT[k]) diff++;
  if (diff !== 1) throw new Error('V.34 Phase 3: the two J patterns differ in other than one bit');
})();

module.exports = {
  POINT0, P0_CW, CW, rotCW, rotationOf,
  S_SYMBOLS, SBAR_SYMBOLS, S_ROTS, SBAR_ROTS, buildS, buildSbar,
  PP_PERIOD, PP_PERIODS, PP_SYMBOLS, ppPhase, buildPP,
  TRN_MIN_SYMBOLS, trnSymbol,
  J_BITS, J_PATTERN_4POINT, J_PATTERN_16POINT, JPRIME_PATTERN,
  jPattern, jPrimePattern, JEncoder, JDecoder, scrSymbol,
  meanEnergy,
};
