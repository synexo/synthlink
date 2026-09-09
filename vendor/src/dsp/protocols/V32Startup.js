'use strict';

/**
 * V32Startup — the start-up signals of ITU-T V.32 (11/88) §§5.2–5.4 and of
 * V.32bis (02/91) §§5.2–5.3, 6: the receiver conditioning signal's three segments
 * (S, S̄, TRN), the 16-bit rate signals R1/R2/R3 and the sequence E that ends them.
 *
 * One module serves both Recommendations because §5.2 and §5.2.3 are word for word
 * the same in each, down to the two scrambler golden vectors printed in them, and
 * Table 5/V.32 and Table 4/V.32bis are the same four rows. What differs is only
 * which BITS of the 16-bit sequence carry which rate — Table 6/V.32 against Table
 * 5/V.32bis — so those are two codecs built from one builder rather than two
 * implementations. This is the same division V34Phase3.js makes for V.34 and V.90:
 * the signals live here, the per-modem PROCEDURE stays in the protocol class.
 *
 * It replaces `_buildAATrain()` — 250 ms of alternating corner points standing in
 * for the whole start-up — and with it the project-invented `DLE 'R' hi lo` rate
 * frame that rode the byte stream after training, exactly as V34Phase4's Table 20
 * MP replaced V.34's copy of that frame.
 *
 * ── The signals, from the clauses ────────────────────────────────────────────
 *   §5.2.1  Segment 1, S:   alternations between states A and B, 256 symbols
 *   §5.2.2  Segment 2, S̄:   alternations between states C and D, 16 symbols.
 *           "The transition from segment 1 to segment 2 provides a well-defined
 *           event in the signal that may be used for generating a time reference
 *           in the receiver." C and D are A and B rotated 180°, so that event is a
 *           phase reversal at either parity — asserted at load below.
 *   §5.2.3  Segment 3, TRN: binary ones scrambled at 4800 bit/s, differential
 *           quadrant encoding DISABLED, scrambler initialised to all zeros. The
 *           first 256 signal states come from the FIRST bit of each dibit alone —
 *           zero → A, one → C — and the rest map dibits straight onto states by
 *           Table 5/V.32 (Table 4/V.32bis). At least 1280 and at most 8192 symbols.
 *   §5.3    Rate signal:    a whole number of repeated 16-bit sequences, scrambled
 *           and transmitted at 4800 bit/s with dibits differentially encoded as in
 *           Table 1/V.32 (Table 2/V.32bis). "The differential encoder shall be
 *           initialized using the final symbol of the transmitted TRN segment."
 *   §5.3.1  Detection: "the receipt of two consecutive identical 16-bit sequences
 *           each with bits B0-3, B7, 11 and 15 conforming to Table 6/V.32."
 *   §5.3.2  Ending it: complete the current 16-bit sequence, then transmit one
 *           sequence E (Table 7/V.32, Table 6/V.32bis).
 *
 * ── States A, B, C, D ───────────────────────────────────────────────────────
 * "as shown in Figure 1/V.32" (Figure 2-5/V.32bis), the subset of states used at
 * 4800 bit/s and for training. Figure 1's point labels are Y1 Y2 Q3 Q4 and the four
 * circled states read A = 0001, B = 0101, C = 1101, D = 1001 — so Q3Q4 = 01 and the
 * four points are
 *
 *      A = (−3, −1)    B = (1, −3)    C = (3, 1)    D = (−1, 3)
 *
 * NOT the outer corners (±3, ±3), which is the natural guess and is wrong. Three
 * things pin it. Table 3/V.32's nonredundant column gives those exact coordinates
 * for those exact labels, cell for cell. Table 1/V.32's own "signal state" column
 * makes A = Y1Y2 00, B = 01, C = 11, D = 10, which is the quadrant each of those
 * four points is in. And their mean energy is 10, which is the mean energy of the
 * whole 16-point nonredundant constellation — so the conditioning signal is already
 * at the data burst's power, where the corners would be 2.5 dB over it.
 *
 * Figure 2-5/V.32bis is the same four points, measured off the scan against its own
 * ±2/±4 ticks: A and C and D land within 0.05 of those coordinates and B is drawn
 * about half a unit off, which the rotational closure the differential coding
 * requires rules out as a real value. V.32bis's data constellation is on a
 * different lattice at a different scale (Figure 2-1, mean energy 41), so a caller
 * whose data points are not Figure 1's scales these — see meanEnergy().
 *
 * ── Rotation order ──────────────────────────────────────────────────────────
 * A, B, C, D are one orbit under 90° counter-clockwise rotation, in that order:
 * B = jA, C = jB, D = jC. That is Table 1's +90° row, and it is what lets a
 * receiver classify every symbol of the whole start-up against two reference points
 * taken from S — the other two being their negations.
 */

// ── §5.2 / Figure 1/V.32 — the four states, in rotation order ────────────────
// ROT[r] is state A rotated counter-clockwise by r quarter-turns.
const ROT = [
  { i: -3, q: -1 },   // A
  { i:  1, q: -3 },   // B
  { i:  3, q:  1 },   // C
  { i: -1, q:  3 },   // D
];
const A = 0, B = 1, C = 2, D = 3;
const LETTER = ['A', 'B', 'C', 'D'];

// Table 1/V.32 (Table 2/V.32bis) "signal state" column: which Y1Y2 each state is.
// Y is not the rotation index — C is Y1Y2 = 11 and D is 10 — so the two directions
// are kept as explicit tables rather than as arithmetic.
const Y_OF_ROT = [0b00, 0b01, 0b11, 0b10];
const ROT_OF_Y = [A, B, D, C];        // inverse of Y_OF_ROT

// Table 1/V.32's "phase quadrant change" column, indexed by (Q1<<1)|Q2 with Q1
// first in time: 00 → +90°, 01 → 0°, 10 → +180°, 11 → +270°. In quarter-turns.
const PHASE_CHANGE = [1, 0, 2, 3];
// Its inverse. The permutation is the transposition (0 1), so it is its own
// inverse — held as its own table anyway, because relying on that is how a later
// edit to one of them silently stops matching the other.
const CHANGE_TO_DIBIT = [1, 0, 2, 3];

// ── §5.2.1 / §5.2.2 — S and S̄ ───────────────────────────────────────────────
const S_SYMBOLS = 256;
const SBAR_SYMBOLS = 16;

/**
 * §5.2.1's segment 1. The Recommendation says "alternations between states A and
 * B" and does not fix which comes first; this starts on A. Nothing downstream
 * depends on the choice — the segment-1-to-segment-2 event is a 180° reversal at
 * either parity, and a receiver resolves which parity it sampled by asking which way
 * the PAIR of averaged states turns — (A, B) counter-clockwise, (B, A) clockwise —
 * not from where the segment began. Note that the step direction cannot answer it:
 * S alternates A B A B, so its steps alternate +90° and −90°.
 */
function buildS(count = S_SYMBOLS) {
  if (count % 2 !== 0) throw new Error(`V.32 S must be an even number of symbols: ${count}`);
  const out = new Array(count);
  for (let n = 0; n < count; n++) out[n] = ROT[n % 2 ? B : A];
  return out;
}

/** §5.2.2's segment 2: alternations between C and D, which are A and B reversed. */
function buildSbar(count = SBAR_SYMBOLS) {
  if (count % 2 !== 0) throw new Error(`V.32 S̄ must be an even number of symbols: ${count}`);
  const out = new Array(count);
  for (let n = 0; n < count; n++) out[n] = ROT[n % 2 ? D : C];
  return out;
}

// ── §5.2.3 — TRN ────────────────────────────────────────────────────────────
const TRN_ABS_SYMBOLS = 256;      // "the first 256 transmitted signal states"
const TRN_MIN_SYMBOLS = 1280;     // "at least 1280"
const TRN_MAX_SYMBOLS = 8192;     // "and not exceed 8192"

// Table 5/V.32, Table 4/V.32bis — "Encoding for TRN segment after the first 256
// symbols". Dibit → signal state: 00 A, 01 B, 11 C, 10 D. Indexed by (b1<<1)|b2
// with b1 first in time, so entry 2 (dibit 10) is D and entry 3 (dibit 11) is C.
const TRN_TABLE = [A, B, D, C];

/**
 * One TRN symbol as a ROTATION index. `nextBit()` must return the next SCRAMBLED
 * bit; the caller owns the scrambler because §5.2.3 fixes its initial state (all
 * zeros) and its input (binary one) for this segment specifically, and because the
 * rate signal that follows continues the same register — §8/V.32bis is the clause
 * that re-initialises it, and it does so only for rate renegotiation, which is why
 * the start-up procedure must not.
 *
 * Both branches consume a whole dibit. Before symbol 256 only the first of the two
 * bits reaches the wire, which is why a receiver cannot recover the scrambler
 * stream from that stretch and does not try to.
 */
function trnRotation(index, nextBit) {
  const b1 = nextBit() & 1;                 // first in time
  const b2 = nextBit() & 1;
  if (index < TRN_ABS_SYMBOLS) return b1 ? C : A;
  return TRN_TABLE[(b1 << 1) | b2];
}

// ── §5.3 — the rate signal's differential encoder (Table 1/V.32) ─────────────
/**
 * "The differential encoder shall be initialized using the final symbol of the
 * transmitted TRN segment", so the constructor takes that symbol's rotation.
 */
class DiffEncoder {
  constructor(rot0 = A) { this.rot = rot0 & 3; }
  /** A dibit, Q1 first in time → the transmitted rotation. */
  symbol(q1, q2) {
    this.rot = (this.rot + PHASE_CHANGE[((q1 & 1) << 1) | (q2 & 1)]) & 3;
    return this.rot;
  }
}

/**
 * Its inverse. Differential DECODING needs no initial state — the change is
 * (rot − rotPrev) mod 4 whatever rotPrev was — which is what lets a receiver read a
 * rate signal without having seen the TRN symbol the encoder was initialised from,
 * and what makes the whole decode invariant to a 90° error in the reference.
 */
class DiffDecoder {
  constructor() { this.prev = null; }
  /** A received rotation → [Q1, Q2] with Q1 first in time, or null on the first. */
  bits(rot) {
    const r = rot & 3;
    if (this.prev === null) { this.prev = r; return null; }
    const change = (r - this.prev + 4) & 3;
    this.prev = r;
    const d = CHANGE_TO_DIBIT[change];
    return [(d >> 1) & 1, d & 1];
  }
}

// ── §5.3 — the 16-bit rate sequences ────────────────────────────────────────
// Held as B0..B15 arrays so a transcription reads in the order the tables print,
// B0 first in time. `null` is a "–" cell: a bit the table leaves to the modem.
//
// Table 6/V.32, "Coding of the 16-bit rate sequence":
//   B0 0  B1 0  B2 0  B3 0  B4 –  B5 –  B6 –  B7 1
//   B8 –  B9 –  10 –  11 1  12 –  13 –  14 –  15 1
//   B0-3, B7, 11, 15  For synchronizing on a received rate signal
//   B4  1 denotes ability to receive data at 2400 bit/s
//   B5  1 denotes ability to receive data at 4800 bit/s
//   B6  1 denotes ability to receive data at 9600 bit/s
//   B4-6  0 0 0 calls for a GSTN cleardown
//   B8  1 denotes availability of trellis coding/decoding at the highest data rate
//       indicated in B4-6
//   B9-14  0 0 1 0 0 0 denotes absence of special operational modes
//
// Table 7/V.32, "Coding of signal E":
//   B0 1  B1 1  B2 1  B3 1  B4 –  B5 –  B6 –  B7 B1
//   B8 –  B9 –  10 –  11 1  12 –  13 –  14 –  15 1
//   B4-14  As in Table 6/V.32, except that the only data rate and coding to be
//          indicated shall relate to the transmission of scrambled binary ones
//          immediately following signal E
//
// The B7 cell of Table 7 prints "B1" rather than a digit. B1 is 1 in that same
// table, so both readings of the cell give B7 = 1 and the ambiguity has no
// consequence; it is transcribed as printed here and resolved to 1 below.
//
// Table 5/V.32bis, "Coding of the rate signal":
//   B0..B15  0 0 0 0 1 – – 1 1 – – 1 – 0 0 1
//   B0-B3, B7, B11, B15  For synchronizing on a rate signal
//   B4 = 1 (Note 1)      B8 = 1 (Note 1)
//   B5  1 denotes that operation at 4800 bit/s rate is enabled
//   B6  1 denotes that operation at 9600 bit/s rate is enabled
//   B9  1 denotes that operation at 7200 bit/s rate is enabled
//   B10 1 denotes that operation at 12 000 bit/s rate is enabled
//   B12 1 denotes that operation at 14 400 bit/s rate is enabled
//   B13, B14 = 0, 0 (Note 2)
//   Note 3 – B4-B6, B9-B10, B12 set to zero calls for a GSTN cleardown.
//
// Table 6/V.32bis, "Coding of sequence E":
//   B0..B15  1 1 1 1 1 – – 1 1 – – 1 – 0 0 1
//   B4-B12 as in Table 5/V.32bis except the only data rate to be indicated shall
//   relate to the transmission of scrambled binary ones immediately following E.

const RATE_BITS = 16;
const SYNC_POSITIONS = [0, 1, 2, 3, 7, 11, 15];     // §5.3.1's B0-3, B7, 11, 15
const SYNC_RATE = [0, 0, 0, 0];                     // B0-B3 of a rate signal
const SYNC_E = [1, 1, 1, 1];                        // B0-B3 of sequence E

const V32_TABLE6 = [0, 0, 0, 0, null, null, null, 1, null, 0, 0, 1, 0, 0, 0, 1];
const V32BIS_TABLE5 = [0, 0, 0, 0, 1, null, null, 1, 1, null, null, 1, null, 0, 0, 1];

const V32_RATE_BITS = { 2400: 4, 4800: 5, 9600: 6 };
const V32BIS_RATE_BITS = { 4800: 5, 9600: 6, 7200: 9, 12000: 10, 14400: 12 };

/**
 * A codec for one Recommendation's rate signal: the fixed cells of its table, the
 * bit position of each rate it can advertise, and the two sync patterns that tell a
 * rate signal from an E.
 */
function makeRateCodec(name, template, rateBitOf) {
  if (template.length !== RATE_BITS) throw new Error(`${name}: rate table is not 16 cells`);
  const rates = Object.keys(rateBitOf).map(Number).sort((a, b) => a - b);

  /** The 16 bits of a rate signal (or of E) advertising exactly `advertised`. */
  function build(advertised, { sequence = 'rate' } = {}) {
    const bits = template.map((v) => (v === null ? 0 : v));
    const sync = sequence === 'e' ? SYNC_E : SYNC_RATE;
    for (let k = 0; k < 4; k++) bits[k] = sync[k];
    for (const r of advertised) {
      const pos = rateBitOf[r];
      if (pos === undefined) throw new Error(`${name}: no bit for ${r} bit/s`);
      bits[pos] = 1;
    }
    return bits;
  }

  /** §5.3.1's conformance test on the sync cells, for either sequence kind. */
  function kindOf(bits) {
    if (bits.length !== RATE_BITS) return null;
    for (const p of SYNC_POSITIONS.slice(4)) if (bits[p] !== template[p]) return null;
    const head = bits.slice(0, 4).join('');
    if (head === SYNC_RATE.join('')) return 'rate';
    if (head === SYNC_E.join('')) return 'e';
    return null;
  }

  /** Every rate the sequence advertises, and the highest of them. */
  function decode(bits) {
    const advertised = rates.filter((r) => bits[rateBitOf[r]] === 1);
    return { advertised, best: advertised.length ? advertised[advertised.length - 1] : 0 };
  }

  return { name, rates, rateBitOf, template, build, kindOf, decode };
}

const V32_RATES = makeRateCodec('Table 6/V.32', V32_TABLE6, V32_RATE_BITS);
const V32BIS_RATES = makeRateCodec('Table 5/V.32bis', V32BIS_TABLE5, V32BIS_RATE_BITS);

/**
 * §5.3.1's detector, and then the sequence frame it establishes.
 *
 * HUNTING, it applies §5.3.1 literally: "the receipt of two consecutive identical
 * 16-bit sequences each with bits B0-3, B7, 11 and 15 conforming". It is fed the
 * descrambled bit stream and finds its own alignment, because nothing on the wire
 * marks where a sequence begins — which is exactly what those seven fixed cells are
 * for.
 *
 * LOCKED, it reads aligned 16-bit groups. That second mode is not an optimisation:
 * §5.3.2 sends sequence E exactly ONCE, "marking and following the end of a whole
 * number of 16-bit rate sequences", so §5.3.1's two-consecutive-identical rule
 * cannot detect it and nothing else in the Recommendation needs to — by then the
 * receiver has been reading that modem's rate signal and knows where a sequence
 * begins.
 */
class RateFramer {
  constructor(codec) { this.codec = codec; this.reset(); }
  reset() { this.hist = []; this.locked = false; this.group = []; }
  /**
   * One descrambled bit → { kind, bits, advertised, best } at the end of a
   * conforming sequence, else null. `kind` is 'rate' or 'e'.
   */
  push(bit) {
    const b = bit & 1;
    if (this.locked) {
      this.group.push(b);
      if (this.group.length < RATE_BITS) return null;
      const bits = this.group;
      this.group = [];
      const kind = this.codec.kindOf(bits);
      if (!kind) return null;
      return { kind, bits, ...this.codec.decode(bits) };
    }
    this.hist.push(b);
    if (this.hist.length > 2 * RATE_BITS) this.hist.shift();
    if (this.hist.length < 2 * RATE_BITS) return null;
    const first = this.hist.slice(0, RATE_BITS);
    const second = this.hist.slice(RATE_BITS);
    for (let k = 0; k < RATE_BITS; k++) if (first[k] !== second[k]) return null;
    const kind = this.codec.kindOf(second);
    if (kind !== 'rate') return null;         // §5.3.1 is a rate-signal rule
    this.locked = true; this.group = []; this.hist = [];
    return { kind, bits: second, ...this.codec.decode(second) };
  }
}

// ── Power ───────────────────────────────────────────────────────────────────
/**
 * Mean symbol energy of the conditioning signal's states, which is 10 — the mean
 * energy of Figure 1/V.32's whole 16-point constellation, so a V.32 modem needs no
 * scaling at all. V.32bis draws its data points from Figure 2-1, a different
 * diagram at a different scale, and scales by sqrt(dataMeanE / 10) so that the
 * start-up and the data it precedes reach the line at one power.
 */
const STATE_MEAN_E = ROT.reduce((t, p) => t + p.i * p.i + p.q * p.q, 0) / ROT.length;
function gainFor(dataMeanE) { return Math.sqrt(dataMeanE / STATE_MEAN_E); }

// ── Structure the Recommendations fix, asserted at load ──────────────────────
// The rule PROTOIMPROVE.md sets for anything transcribed: a mis-transcription
// should fail at require() rather than produce a link that works only against
// itself. Every check below is a property a clause or a table states.
(function assertStructure() {
  const bad = (m) => { throw new Error(`V.32 start-up: ${m}`); };

  // The four states are one orbit under 90° CCW rotation, in ROT's order. This is
  // Table 1's +90° row and it is what the whole receiver is built on.
  for (let r = 0; r < 4; r++) {
    const p = ROT[r], n = ROT[(r + 1) & 3];
    if (n.i !== -p.q || n.q !== p.i) bad(`${LETTER[(r + 1) & 3]} is not ${LETTER[r]} rotated +90°`);
  }
  if (new Set(ROT.map((p) => `${p.i},${p.q}`)).size !== 4) bad('the four states are not distinct');
  if (STATE_MEAN_E !== 10) bad(`state mean energy is ${STATE_MEAN_E}, not Figure 1/V.32's 10`);

  // Table 1's two directions must invert each other, in both of their tables.
  for (let d = 0; d < 4; d++) if (CHANGE_TO_DIBIT[PHASE_CHANGE[d]] !== d) bad(`Table 1 dibit ${d} does not round-trip`);
  for (let y = 0; y < 4; y++) if (ROT_OF_Y[Y_OF_ROT[y]] !== y) bad(`Table 1 Y1Y2 for ${LETTER[y]} does not round-trip`);

  // §5.2.2's "well-defined event": S̄ is S reversed, at either parity.
  const s = buildS(), sb = buildSbar();
  for (let k = 0; k < 2; k++) {
    if (sb[k].i !== -s[k].i || sb[k].q !== -s[k].q) bad('S̄ is not S reversed');
  }
  // S's two states are a quarter turn apart, and the ORDERED pair (A, B) turns
  // counter-clockwise. That ordering is what resolves a receiver's parity — the
  // step direction cannot, because S alternates A B A B and so alternates ±90°.
  for (let k = 1; k < 4; k++) {
    const p = s[k - 1], n = s[k];
    const cw = (n.i === p.q && n.q === -p.i), ccw = (n.i === -p.q && n.q === p.i);
    if (!(cw || ccw)) bad('S does not alternate by a quarter turn');
  }
  if (ROT[A].i * ROT[B].q - ROT[A].q * ROT[B].i <= 0) bad('(A, B) does not turn counter-clockwise');

  // §5.2.3's printed golden vectors, which are the strongest check in either
  // Recommendation on the scrambler AND on the first-bit-of-each-dibit rule:
  //   Call mode modem  GPC: 11 11 11 11 11 11 11 11 11 00 00 01 11 11 11
  //                         C  C  C  C  C  C  C  C  C  A  A  A  C  C  C
  //   Answer mode      GPA: 11 11 10 00 00 11 11 10 00 00 11 10 01 11 11
  //                         C  C  C  A  A  C  C  C  A  A  C  C  A  C  C
  const GOLDEN = [
    ['GPC', 17, '111111111111111111000001111111', 'CCCCCCCCCAAACCC'],
    ['GPA', 4, '111110000011111000001110011111', 'CCCAACCCAACCACC'],
  ];
  for (const [gp, tap, wantBits, wantStates] of GOLDEN) {
    const reg = new Array(23).fill(0);
    const scramble = (b) => { const o = b ^ reg[tap] ^ reg[22]; reg.unshift(o); reg.pop(); return o; };
    let bits = '', states = '';
    for (let n = 0; n < wantStates.length; n++) {
      const before = [];
      const rot = trnRotation(n, () => { const o = scramble(1); before.push(o); return o; });
      bits += before.join('');
      states += LETTER[rot];
    }
    if (bits !== wantBits) bad(`§5.2.3 ${gp} scrambler output is ${bits}, not ${wantBits}`);
    if (states !== wantStates) bad(`§5.2.3 ${gp} signal states are ${states}, not ${wantStates}`);
  }

  // The rate tables: 16 cells, the fixed sync cells where the tables print them,
  // every advertised rate recoverable from its own bit, and a rate signal
  // distinguishable from an E.
  for (const codec of [V32_RATES, V32BIS_RATES]) {
    for (const r of codec.rates) {
      const one = codec.build([r]);
      if (codec.kindOf(one) !== 'rate') bad(`${codec.name}: a rate signal for ${r} does not conform`);
      const dec = codec.decode(one);
      if (dec.best !== r || dec.advertised.length !== 1) bad(`${codec.name}: ${r} does not decode as itself`);
      const e = codec.build([r], { sequence: 'e' });
      if (codec.kindOf(e) !== 'e') bad(`${codec.name}: sequence E for ${r} does not conform`);
    }
    // §5.3's cleardown reading: no rate bit set is a call for a GSTN cleardown, so
    // it must be a conforming sequence that advertises nothing rather than a
    // malformed one.
    const clear = codec.build([]);
    if (codec.kindOf(clear) !== 'rate' || codec.decode(clear).best !== 0) {
      bad(`${codec.name}: a cleardown is not a conforming rate signal advertising nothing`);
    }
  }
})();

module.exports = {
  ROT, A, B, C, D, LETTER,
  Y_OF_ROT, ROT_OF_Y, PHASE_CHANGE, CHANGE_TO_DIBIT,
  S_SYMBOLS, SBAR_SYMBOLS, buildS, buildSbar,
  TRN_ABS_SYMBOLS, TRN_MIN_SYMBOLS, TRN_MAX_SYMBOLS, TRN_TABLE, trnRotation,
  DiffEncoder, DiffDecoder,
  RATE_BITS, SYNC_POSITIONS, SYNC_RATE, SYNC_E,
  V32_TABLE6, V32BIS_TABLE5, V32_RATE_BITS, V32BIS_RATE_BITS,
  makeRateCodec, V32_RATES, V32BIS_RATES, RateFramer,
  STATE_MEAN_E, gainFor,
};
