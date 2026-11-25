'use strict';

/**
 * V34Mapper — the genuine V.34 encode/decode chain, clean-room from ITU-T V.34
 * (02/98): parser (§9.3.1), shell mapper (§9.4), differential encoder (§9.5), and
 * mapper + trellis encoder (§9.6). Config-driven so one implementation serves every
 * data-mode rate; four configurations are provided:
 *
 *   19200 / 2400 sym/s : b=64 SWP=FFFF; K=28 M=12 q=3 L=384
 *   28800 / 3200 sym/s : b=72 SWP=FFFF; K=28 M=12 q=4 L=768
 *   31200 / 3200 sym/s : b=78 SWP=FFFF; K=26 M=10 q=5 L=1280
 *   33600 / 3429 sym/s : b=79 SWP=14A5; K=27 M=11 q=5 L=1408   ← frame-switched
 *
 * The first three use SWP=all-high (constant b, no switching). 33600 uses the
 * genuine V.34 §8.2 mechanism: a 16-bit switching pattern (SWP) selects, per
 * mapping frame, whether it carries b (high) or b−1 (low) data bits — a low frame
 * inserts a forced 0 as the high-order shell-mapper bit (§9.3.1), so the shell
 * mapper always sees K bits while one fewer bit is drawn from the data stream. The
 * long-run average b (≈78.4 for 14A5) yields the 33600 payload rate that no
 * integer bits-per-frame at 3429 baud can hit; both ends run the identical
 * SWP-driven pattern from a frame counter reset at the start of the data burst, so
 * the split is deterministic and data round-trips exactly. A mapping frame
 * = 4 four-dimensional symbols = 8 two-dimensional symbols. Of the b scrambled
 * primary bits, the first K go to the shell mapper (→ 8 ring indices); the rest
 * split into 4 groups of (b−K)/4 = 3 + 2q bits, each carrying (I1,I2,I3) and two
 * q-bit Q-subgroups. Point index Q(n) = Qbits + 2^q·ring selects a point from the
 * Figure 5 quarter superconstellation, whose point set and numbering are the
 * Recommendation's (see quarterPoints); the two points of a 4D symbol are rotated by Z(m)·90°
 * and [Z(m)+2·I1+U0]·90° clockwise (U0 = trellis output).
 *
 * Clean-link simplifications (documented in PROTOCOLS §0 / §7), forced by
 * the lossless, ISI-free, drift-free transport:
 *   - No precoder ⇒ c(n)=0 ⇒ modulo-encoder C0(m)=0 ⇒ U0(m)=Y0(m) (pure trellis).
 *   - Superframe synchronisation IS on the wire: V0(m) is Table 12's bit-inversion
 *     pattern, inserted at the first 4D interval of each half data frame (§9.6.3,
 *     eq. 9-32), counted from B1 as "the last data frame in a superframe"
 *     (§10.1.3.1). The receiver discards U0, so it needs no knowledge of V0.
 *   - No auxiliary channel (AMP all-primary); no non-linear warping.
 *   - Receiver slices and inverts algebraically: Z=rot0, (2·I1+U0)=rot1−rot0, so
 *     I1=value>>1 with U0 discarded — the trellis genuinely runs at the transmitter
 *     (shaping the emitted signal) but needs no Viterbi at the receiver, exactly as
 *     V.32bis carries Y0. The 16-state convolutional encoder still evolves on TX.
 *
 * Genuinely present: shell-mapping constellation shaping, 4D differential coding,
 * the Figure-10 16-state 4D trellis on the wire, and the quarter-superconstellation
 * ring/point structure.
 */

const SYMS_PER_FRAME = 8;         // 4 4D symbols × 2  (fixed across all rates)

// full-constellation slice: nearest odd-integer lattice point (§9.6.3.1 grid)
function sliceOdd(v) { return Math.round((v - 1) / 2) * 2 + 1; }

// rotate a point by rot·90° clockwise: R(a,b) = (b,-a)
function rotCW(p, rot) {
  let i = p.i, q = p.q;
  for (let r = 0; r < (rot & 3); r++) { const ni = q, nq = -i; i = ni; q = nq; }
  return { i, q };
}
// Residue class mod 4 of an odd-integer lattice point → the rotation that carries
// the Figure 5 quarter onto it. The quarter is the (1,1) class (see quarterPoints);
// one 90° clockwise step sends (1,1)→(1,3)→(3,3)→(3,1)→(1,1), so the four classes
// are a single orbit and the class alone names the rotation. That is what makes the
// quarter a system of orbit representatives with no boundary cases.
const m4 = v => ((v % 4) + 4) % 4;
function rotOf(p) {
  const a = m4(p.i), b = m4(p.q);
  if (a === 1) return b === 1 ? 0 : 1;
  return b === 3 ? 2 : 3;
}
// inverse: given any lattice point, return {rep, rot} with rotCW(rep, rot) = point
function invRot(p) {
  const rot = rotOf(p);
  return { rep: rotCW(p, (4 - rot) & 3), rot };
}

// ── Figure 5/V.34: the quarter superconstellation ────────────────────────────
// §9.1, verbatim: the 1664-point superconstellation is the union of four
// quarter-constellations, the quarter being the 416 points Figure 5 draws; "the
// point with the smallest magnitude is labelled as 0 ... when two or more points
// have the same magnitude, the point with the greatest imaginary component is
// taken first"; and a constellation with L points is labels 0 … L/4−1 plus their
// three rotations.
//
// The rule above only orders a point SET; the set is what Figure 5 fixes. Its
// axes are ticked every 4 units over −43 … +45 on both, so the quarter is not a
// quadrant at all: it is the sublattice Re ≡ Im ≡ 1 (mod 4) of the odd-integer
// grid, spanning all four quadrants. Every label printed in Figure 5 was checked
// against what this generator produces, row by row, all 416.
function quarterPoints(count) {
  const pts = [];
  // radius that certainly holds `count` points of a lattice with one point per
  // 16 square units, with margin, then trimmed to count by the ordering below
  const R = 4 * Math.ceil(Math.sqrt(count) + 4) + 1;
  for (let a = -R; a <= R; a++) {
    if (m4(a) !== 1) continue;
    for (let b = -R; b <= R; b++) {
      if (m4(b) !== 1) continue;
      pts.push({ i: a, q: b });
    }
  }
  pts.sort((p1, p2) => {
    const e1 = p1.i * p1.i + p1.q * p1.q, e2 = p2.i * p2.i + p2.q * p2.q;
    if (e1 !== e2) return e1 - e2;
    return p2.q - p1.q;                 // greatest imaginary component first
  });
  if (pts.length < count) throw new Error('V.34: quarter-constellation search radius too small');
  const out = pts.slice(0, count);
  // The search box must strictly contain the selected disc, or a point just
  // outside it could have belonged inside and the tail of the numbering would be
  // silently wrong — the ordering rule cannot detect that on its own.
  const last = out[count - 1];
  if (last.i * last.i + last.q * last.q >= R * R) {
    throw new Error('V.34: quarter-constellation search box does not contain the selected points');
  }
  return out;
}

// ── Trellis (§9.6.3), rate-independent ───────────────────────────────────────
// Figure 9/V.34, the subset labels of the sixteen odd-coordinate points nearest the
// origin, rows Im = −3 … +3 and columns Re = −3 … +3. The labelling is periodic
// under (4, 4) and (4, −4). Two properties the figure has to satisfy are asserted
// at module load below: every point of Figure 5's quarter (Re ≡ Im ≡ 1 mod 4) has
// low label bits 00, and a quarter turn clockwise adds one to the low two bits and
// leaves the high bit alone. The Im = +1 row once had its middle two entries
// swapped; both properties fail on that, and nothing else here could see it,
// because the receiver discards U0.
const FIG9 = [
  [0, 7, 4, 3],   // Im=-3
  [5, 2, 1, 6],   // Im=-1
  [4, 3, 0, 7],   // Im=+1
  [1, 6, 5, 2],   // Im=+3
];
function subsetLabel(p) {
  const re = (((((p.i + 3) / 2) % 4) + 4) % 4);
  const im = (((((p.q + 3) / 2) % 4) + 4) % 4);
  return FIG9[im][re];
}
(function checkFig9() {
  for (let re = -7; re <= 7; re += 2) {
    for (let im = -7; im <= 7; im += 2) {
      const l = subsetLabel({ i: re, q: im });
      if (((re & 3) === 1) && ((im & 3) === 1) && (l & 3) !== 0) {
        throw new Error(`V.34 Figure 9: quarter point (${re},${im}) has label ${l}, low bits not 00`);
      }
      const r = subsetLabel({ i: im, q: -re });          // a quarter turn clockwise
      if ((r & 4) !== (l & 4) || (r & 3) !== ((l + 1) & 3)) {
        throw new Error(`V.34 Figure 9: (${re},${im}) label ${l} turns clockwise to ${r}`);
      }
    }
  }
})();
const TABLE13 = [
  [0x0, 0x0, 0x1, 0x1, 0x8, 0x8, 0x9, 0x9],
  [0x3, 0x2, 0x2, 0x3, 0xB, 0xA, 0xA, 0xB],
  [0x5, 0x5, 0x4, 0x4, 0xD, 0xD, 0xC, 0xC],
  [0x6, 0x7, 0x7, 0x6, 0xE, 0xF, 0xF, 0xE],
  [0x8, 0x8, 0x9, 0x9, 0x0, 0x0, 0x1, 0x1],
  [0xB, 0xA, 0xA, 0xB, 0x3, 0x2, 0x2, 0x3],
  [0xD, 0xD, 0xC, 0xC, 0x5, 0x5, 0x4, 0x4],
  [0xE, 0xF, 0xF, 0xE, 0x6, 0x7, 0x7, 0x6],
];
function conv16Next(state, Y1, Y2) {          // 16-state systematic encoder (Figure 10)
  const Y0 = state & 1;
  const ns = state ^ ((Y1 << 1) | (Y2 << 2) | ((Y2 ^ Y0) << 3) | (Y0 << 4));
  return ns >> 1;
}

// ── Config builder ───────────────────────────────────────────────────────────
// ── Table 7/V.34: framing parameters. A superframe is 280 ms and holds J data
// frames; a data frame holds P mapping frames. P is what the switching pattern's
// period actually is (§8.2) — it is NOT 16.
const T7 = {
  2400: { J: 7, P: 12 }, 2743: { J: 8, P: 12 }, 2800: { J: 7, P: 14 },
  3000: { J: 7, P: 15 }, 3200: { J: 7, P: 16 }, 3429: { J: 8, P: 15 },
};

// ── Table 10/V.34: mapping parameters K, M and L, Minimum-shaping columns, for
// the four rates this build runs. Transcribed literally, which is also what makes
// MP bit 32 (constellation shaping) genuinely 0 rather than a guess: these are the
// Minimum rows, not the Expanded ones. A config that does not match its row is a
// mis-transcription, not a variant.
const T10_MIN = {
  // Transcribed from the printed table (Minimum columns), for every row RATE_LADDER
  // below runs — the rule-derived framing must reproduce each one.
  '2400/14400': { K: 28, M: 12, L: 96 },
  '2400/16800': { K: 28, M: 12, L: 192 },
  '2400/19200': { K: 28, M: 12, L: 384 },
  '2400/21600': { K: 28, M: 12, L: 768 },
  '3200/19200': { K: 28, M: 12, L: 96 },
  '3200/21600': { K: 26, M: 10, L: 160 },
  '3200/24000': { K: 24, M: 8,  L: 256 },
  '3200/26400': { K: 30, M: 14, L: 448 },
  '3200/28800': { K: 28, M: 12, L: 768 },
  '3200/31200': { K: 26, M: 10, L: 1280 },
  '3429/19200': { K: 25, M: 9,  L: 72 },
  '3429/21600': { K: 31, M: 15, L: 120 },
  '3429/24000': { K: 28, M: 12, L: 192 },
  '3429/26400': { K: 26, M: 10, L: 320 },
  '3429/28800': { K: 24, M: 8,  L: 512 },
  '3429/31200': { K: 29, M: 13, L: 832 },
  '3429/33600': { K: 27, M: 11, L: 1408 },
};

/**
 * One rate's mapping parameters from the rules printed beside Tables 7–10, not
 * from the tables: §8.2's N = R × 0.28 / J, b = ⌈N/P⌉, r = N − (b−1)P and the SWP
 * counter (add r at each of P frames, mark the frame when the count reaches P,
 * first frame most significant); 9-1's K = b − 12 − 8q with q the least that
 * brings K under 32; §9.2's minimum M = ⌈2^(K/8)⌉. makeConfig then holds the
 * result against T10_MIN's printed row, so a wrong rule fails at load.
 * Primary channel only (no auxiliary), b > 12 only.
 */
function framingFor(sRate, bitRate) {
  const { J, P } = T7[sRate];
  const N = Math.round(bitRate * 0.28 / J);
  const b = Math.ceil(N / P), r = N - (b - 1) * P;
  let swp = 0, count = 0;
  for (let i = 0; i < P; i++) { count += r; swp <<= 1; if (count >= P) { count -= P; swp |= 1; } }
  if (b <= 12) throw new Error(`V.34: ${bitRate}/${sRate} has b = ${b}; this mapper runs b > 12 only`);
  let q = 0; while (b - 12 - 8 * q >= 32) q++;
  const K = b - 12 - 8 * q;
  const M = Math.ceil(2 ** (K / 8) - 1e-12);
  return { sRate, bitRate, frameBits: b, kShell: K, mRings: M, swp: r === P ? 0xffff : swp };
}

// The data rates each symbol rate runs here: every Table 10 row in T10_MIN.
const RATE_LADDER = {};
for (const key of Object.keys(T10_MIN)) {
  const [sRate, bitRate] = key.split('/').map(Number);
  (RATE_LADDER[sRate] = RATE_LADDER[sRate] || []).push(bitRate);
}
for (const k of Object.keys(RATE_LADDER)) RATE_LADDER[k].sort((a, b) => a - b);

function makeConfig({ sRate, bitRate, frameBits, kShell, mRings, swp = 0xffff }) {
  // frameBits is the HIGH-frame bit count b; a low frame carries b−1 (§8.2). q and
  // the constellation derive from the high frame; low frames reuse the same parser
  // and constellation, differing only in that the top shell-mapper bit is a forced
  // 0 (§9.3.1). SWP=0xffff ⇒ every frame high ⇒ constant b (no switching).
  const qBits = ((frameBits - kShell) / 4 - 3) / 2;
  if (!Number.isInteger(qBits) || qBits < 0) throw new Error('bad V.34 config: q not integer');
  // §8.2: "SWP is represented by 12- to 16-bit binary numbers where 0 and 1
  // represent low and high frames, respectively. The left-most bit corresponds to
  // the first mapping frame in a data frame. The right-most bit is always 1."
  // So the pattern is P bits wide (Table 7), indexed MSB-first — NOT 16 bits
  // LSB-first, which is what this code did before the tables were transcribed.
  // Both ends drive it from a frame counter reset at data-burst start, so the
  // high/low sequence is identical either way; only the spec-correct one
  // interworks with a real V.34.
  const frame = T7[sRate];
  if (!frame) throw new Error(`V.34: no Table 7 framing parameters for ${sRate} baud`);
  const { J, P } = frame;
  const swpMask = (1 << P) - 1;
  const swpP = swp & swpMask;
  const switching = swpP !== swpMask;
  if (switching && (swpP & 1) !== 1) {
    throw new Error(`V.34: SWP ${swp.toString(16)} right-most bit must be 1 (§8.2)`);
  }
  const isHighFrame = idx => switching
    ? (((swpP >>> (P - 1 - (((idx % P) + P) % P))) & 1) === 1)
    : true;
  // §8.2 consistency: N data bits per data frame, b = smallest integer ≥ N/P,
  // and the number of high frames per period is r = N − (b−1)P.
  const N = Math.round(bitRate * 0.28 / J);
  const r = N - (frameBits - 1) * P;
  let ones = 0; for (let i = 0; i < P; i++) ones += (swpP >>> i) & 1;
  if (ones !== r) {
    throw new Error(`V.34: SWP ${swp.toString(16)} has ${ones} high frames, §8.2 requires r=${r} ` +
                    `(N=${N}, b=${frameBits}, P=${P})`);
  }
  const ringSize = 1 << qBits;
  const quarterPts = ringSize * mRings;              // = L/4

  // Table 10 cross-check. L is the full superconstellation, four times the
  // quarter this mapper builds, so it is derived here rather than declared — a
  // wrong kShell or mRings moves it and the row stops matching.
  const row = T10_MIN[`${sRate}/${bitRate}`];
  if (row) {
    const L = 4 * quarterPts;
    if (kShell !== row.K || mRings !== row.M || L !== row.L) {
      throw new Error(`V.34 ${bitRate}/${sRate}: config gives K=${kShell} M=${mRings} L=${L}, ` +
                      `Table 10 minimum row is K=${row.K} M=${row.M} L=${row.L}`);
    }
  }
  // For a constant-b config the frame arithmetic is exact: b bits per mapping
  // frame, 8 two-dimensional symbols per frame. A switched-b config (33600) is
  // covered by the §8.2 SWP one-count check above instead.
  // In §8.2's own terms, which carry no symbol-rate rounding: with every frame
  // high, a data frame's N bits are exactly P frames of b. (b × the printed 3429
  // / 8 is not the bit rate — 3429 is 24000/7 rounded.)
  if (!switching && frameBits * P !== N) {
    throw new Error(`V.34: b=${frameBits} × P=${P} is not N=${N} for ${bitRate} at ${sRate} sym/s`);
  }

  const quarter = quarterPoints(quarterPts);
  const key = p => p.i * 10000 + p.q;
  const labelMap = new Map();
  for (let k = 0; k < quarter.length; k++) labelMap.set(key(quarter[k]), k);
  const labelOf = rep => { const v = labelMap.get(key(rep)); return v === undefined ? -1 : v; };

  // §9.1 quarter→full expansion: the four rotations of the quarter must be
  // pairwise disjoint and together give the L points of this constellation, and
  // invRot must recover (rep, rot) for every one of them. A quarter that is not a
  // system of orbit representatives passes a bijection check and fails this.
  {
    const full = new Set();
    for (const p of quarter) {
      for (let rot = 0; rot < 4; rot++) {
        const u = rotCW(p, rot);
        if (full.has(key(u))) throw new Error('V.34: quarter constellation is not rotation-disjoint');
        full.add(key(u));
        const back = invRot(u);
        if (back.rot !== rot || back.rep.i !== p.i || back.rep.q !== p.q) {
          throw new Error('V.34: invRot does not invert the §9.1 rotation');
        }
      }
    }
    if (full.size !== 4 * quarterPts) throw new Error('V.34: expanded constellation is not L points');
  }

  // §9.1 ordering and §9.2 rings: labels rise with magnitude, ties resolved by the
  // greater imaginary component, and the M rings the shell mapper indexes are the
  // consecutive blocks of 2^q labels — so ring order IS magnitude order. A
  // relabelling that keeps the point set but loses this still round-trips against
  // itself and puts the shaping gain on the wrong points.
  {
    for (let k = 1; k < quarter.length; k++) {
      const a = quarter[k - 1], b = quarter[k];
      const ea = a.i * a.i + a.q * a.q, eb = b.i * b.i + b.q * b.q;
      if (eb < ea || (eb === ea && b.q > a.q)) throw new Error('V.34: quarter constellation is out of §9.1 order');
    }
    for (let ring = 1; ring < mRings; ring++) {
      const inner = quarter[ring * ringSize - 1], outer = quarter[ring * ringSize];
      const ei = inner.i * inner.i + inner.q * inner.q, eo = outer.i * outer.i + outer.q * outer.q;
      if (eo < ei) throw new Error('V.34: rings are not concentric in label order');
    }
  }

  // Shell mapper tables (§9.4) for this M.
  const n = 8 * (mRings - 1) + 1, M = mRings;
  const g2 = new Array(n).fill(0);
  for (let p = 0; p < n; p++) g2[p] = (p <= 2 * (M - 1)) ? (M - Math.abs(p - (M - 1))) : 0;
  const g4 = new Array(n).fill(0);
  for (let p = 0; p < n; p++) { let s = 0; if (p <= 4 * (M - 1)) for (let i = 0; i <= p; i++) s += g2[i] * g2[p - i]; g4[p] = s; }
  const g8 = new Array(n).fill(0);
  for (let p = 0; p < n; p++) { let s = 0; if (p <= 8 * (M - 1)) for (let i = 0; i <= p; i++) s += g4[i] * g4[p - i]; g8[p] = s; }
  const z8 = new Array(n + 1).fill(0);
  for (let p = 1; p <= n; p++) z8[p] = z8[p - 1] + (g8[p - 1] || 0);

  function indexToRings(R0) {
    let A = 0; while (z8[A + 1] !== undefined && z8[A + 1] <= R0) A++;
    let B = 0, R1;
    for (;;) { let s = 0; for (let p = 0; p < B + 1; p++) s += g4[p] * g4[A - p]; if (R0 - z8[A] - s < 0) break; B++; }
    { let s = 0; for (let p = 0; p < B; p++) s += g4[p] * g4[A - p]; R1 = R0 - z8[A] - s; }
    const R2 = R1 % g4[B], R3 = (R1 - R2) / g4[B];
    let C = 0; for (;;) { let s = 0; for (let p = 0; p < C + 1; p++) s += g2[p] * g2[B - p]; if (R2 - s < 0) break; C++; }
    let R4; { let s = 0; for (let p = 0; p < C; p++) s += g2[p] * g2[B - p]; R4 = R2 - s; }
    let D = 0; for (;;) { let s = 0; for (let p = 0; p < D + 1; p++) s += g2[p] * g2[A - B - p]; if (R3 - s < 0) break; D++; }
    let R5; { let s = 0; for (let p = 0; p < D; p++) s += g2[p] * g2[A - B - p]; R5 = R3 - s; }
    const E = R4 % g2[C], F = (R4 - E) / g2[C], G = R5 % g2[D], H = (R5 - G) / g2[D];
    const m = [[0, 0], [0, 0], [0, 0], [0, 0]];
    if (C < M) { m[0][0] = E; m[0][1] = C - E; } else { m[0][1] = M - 1 - E; m[0][0] = C - m[0][1]; }
    if (B - C < M) { m[1][0] = F; m[1][1] = B - C - F; } else { m[1][1] = M - 1 - F; m[1][0] = B - C - m[1][1]; }
    if (D < M) { m[2][0] = G; m[2][1] = D - G; } else { m[2][1] = M - 1 - G; m[2][0] = D - m[2][1]; }
    if (A - B - D < M) { m[3][0] = H; m[3][1] = A - B - D - H; } else { m[3][1] = M - 1 - H; m[3][0] = A - B - D - m[3][1]; }
    return m;
  }
  function ringsToIndex(m) {
    const C = m[0][0] + m[0][1], E = (C < M) ? m[0][0] : M - 1 - m[0][1];
    const BmC = m[1][0] + m[1][1], F = (BmC < M) ? m[1][0] : M - 1 - m[1][1], B = C + BmC;
    const D = m[2][0] + m[2][1], G = (D < M) ? m[2][0] : M - 1 - m[2][1];
    const AmBmD = m[3][0] + m[3][1], H = (AmBmD < M) ? m[3][0] : M - 1 - m[3][1], A = B + D + AmBmD;
    const R4 = F * g2[C] + E, R5 = H * g2[D] + G;
    let s2 = 0; for (let p = 0; p < C; p++) s2 += g2[p] * g2[B - p]; const R2 = R4 + s2;
    let s3 = 0; for (let p = 0; p < D; p++) s3 += g2[p] * g2[A - B - p]; const R3 = R5 + s3;
    const R1 = R3 * g4[B] + R2;
    let s1 = 0; for (let p = 0; p < B; p++) s1 += g4[p] * g4[A - p];
    return R1 + z8[A] + s1;
  }

  const groupBits = 3 + 2 * qBits;                 // per-4D-symbol bits after the shell field
  return {
    sRate, bitRate, frameBits, kShell, mRings, qBits, ringSize, quarterPts,
    symsPerFrame: SYMS_PER_FRAME, quarter, labelOf,
    pointForLabel: label => quarter[label],
    indexToRings, ringsToIndex,
    swp: swpP, switching, groupBits, J, P, N, highFramesPerPeriod: r,
    frameBitsHigh: frameBits, frameBitsLow: frameBits - 1,
    isHighFrame,
    // data-stream bits drawn for the mapping frame at index idx
    bitsForFrame: idx => (isHighFrame(idx) ? frameBits : frameBits - 1),
  };
}

const CONFIGS = {
  // The four configurable top rates, written out as they always were and held
  // against framingFor() below; RATE_CONFIGS has the whole ladder.
  '19200/2400': { sRate: 2400, bitRate: 19200, frameBits: 64, kShell: 28, mRings: 12 },
  '28800/3200': { sRate: 3200, bitRate: 28800, frameBits: 72, kShell: 28, mRings: 12 },
  // 31200/3200: near drop-in on the proven 3200 front-end — larger 1280-pt
  // constellation, still constant-b (all-high SWP), no frame switching.
  '31200/3200': { sRate: 3200, bitRate: 31200, frameBits: 78, kShell: 26, mRings: 10 },
  // 33600/3429: the top V.34 rate. Needs the 3429 front-end (2.33 SPS, 1959 Hz)
  // AND §8.2 frame switching (SWP=14A5 ⇒ mixed b/b−1 frames). b here is the HIGH
  // frame bit count (79); low frames carry 78 via the §9.3.1 forced-0 shell bit.
  '33600/3429': { sRate: 3429, bitRate: 33600, frameBits: 79, kShell: 27, mRings: 11, swp: 0x14a5 },
};

// Every ladder rate, keyed 'bitRate/sRate' like CONFIGS, from the rules.
const RATE_CONFIGS = {};
for (const sRate of Object.keys(RATE_LADDER)) {
  for (const bitRate of RATE_LADDER[sRate]) RATE_CONFIGS[`${bitRate}/${sRate}`] = framingFor(+sRate, bitRate);
}
for (const [k, c] of Object.entries(CONFIGS)) {
  const g = RATE_CONFIGS[k];
  const swpOf = (x) => (x.swp === undefined ? 0xffff : x.swp);
  if (!g || g.frameBits !== c.frameBits || g.kShell !== c.kShell || g.mRings !== c.mRings ||
      (swpOf(c) & ((1 << T7[c.sRate].P) - 1)) !== (swpOf(g) & ((1 << T7[c.sRate].P) - 1))) {
    throw new Error(`V.34: CONFIGS ${k} disagrees with the §8.2/9-1 rules`);
  }
}

/**
 * The mean energy of a configuration's data constellation, in lattice units², as
 * the shell mapper uses it — computed, not measured. The K shell bits are uniform,
 * over [0, 2^K) in a high frame and [0, 2^(K−1)) in a low one (§9.3.1's S_K = 0),
 * so a stratified pass over each range gives every ring's frequency; within a ring
 * the label bits are uniform; and §8.2's r high frames in P set the mix. This
 * scale is what §10.1.3's NOTE ties to training power, so a RECEIVER needs it for
 * the rate it receives. Cached per configuration (≈ 90 ms each).
 */
const MEAN_E_CACHE = new Map();
// The same, for every configuration RATE_CONFIGS holds, as meanEnergyComputed()
// gives it at the default sample count: about 90 ms each, so a call's first rate
// estimate, which walks the whole ladder, cost 1.5 s of CPU in one half second on
// a browser's page. v34-mean-energy-check holds the table to the computation.
const MEAN_E_TABLE = {
  '14400/2400': 53.664581298828125,
  '16800/2400': 107.13131332397461,
  '19200/2400': 214.04667854309082,
  '21600/2400': 428.3117036819458,
  '19200/3200': 53.664581298828125,
  '21600/3200': 90.63729858398438,
  '24000/3200': 162.74551391601562,
  '26400/3200': 258.59198570251465,
  '28800/3200': 428.3117036819458,
  '31200/3200': 725.1307473182678,
  '19200/3429': 41.323544311523435,
  '21600/3429': 65.68058929443359,
  '24000/3429': 107.13131332397461,
  '26400/3429': 172.21204681396483,
  '28800/3429': 283.7604335784912,
  '31200/3429': 457.53277454376223,
  '33600/3429': 727.6751909255981,
};
function meanEnergy(cfg, samples = 1 << 16) {
  const key = `${cfg.bitRate}/${cfg.sRate}`;
  if (samples === 1 << 16 && key in MEAN_E_TABLE) return MEAN_E_TABLE[key];
  return meanEnergyComputed(cfg, samples);
}
function meanEnergyComputed(cfg, samples = 1 << 16) {
  const key = `${cfg.bitRate}/${cfg.sRate}`;
  if (samples === 1 << 16 && MEAN_E_CACHE.has(key)) return MEAN_E_CACHE.get(key);
  const ringE = [];
  for (let m = 0; m < cfg.mRings; m++) {
    let e = 0;
    for (let j = 0; j < cfg.ringSize; j++) { const p = cfg.quarter[m * cfg.ringSize + j]; e += p.i * p.i + p.q * p.q; }
    ringE.push(e / cfg.ringSize);
  }
  const frameE = (span) => {
    let e = 0;
    for (let i = 0; i < samples; i++) {
      const rings = cfg.indexToRings(Math.floor((i + 0.5) * span / samples));
      for (const pair of rings) for (const ring of pair) e += ringE[ring];
    }
    return e / (samples * 8);
  };
  const hi = frameE(2 ** cfg.kShell);
  const r = cfg.switching ? cfg.highFramesPerPeriod : cfg.P;
  const v = r === cfg.P ? hi : (r * hi + (cfg.P - r) * frameE(2 ** (cfg.kShell - 1))) / cfg.P;
  if (samples === 1 << 16) MEAN_E_CACHE.set(key, v);
  return v;
}

// ── Table 12/V.34 — bit inversion patterns for superframe synchronisation ────
// "The left-most bit corresponds to the first half data frame of a superframe."
// One bit per half data frame, so the period is 2J: 16 when J = 8, 14 when J = 7.
const T12 = {
  8: '0111011111111010',
  7: '01110111111110',
};

/**
 * V0(m), §9.6.3: the inversion bit for 4D symbol interval m, where m = 0 is the
 * first 4D interval of B1. Inversions are introduced only "when m is an integer
 * multiple of 2P" — the first 4D interval of each half data frame — and B1 is sent
 * "as if the data frame were the last data frame in a superframe" (§10.1.3.1), so
 * B1's two half data frames take the pattern's last two bits and data begins on
 * its first.
 */
function superframeV0(J, P, m) {
  const pat = T12[J];
  if (!pat) throw new Error(`V.34: no Table 12 pattern for J=${J}`);
  if (m % (2 * P) !== 0) return 0;
  const h = m / (2 * P);
  return pat.charCodeAt((h + 2 * J - 2) % (2 * J)) === 49 ? 1 : 0;
}

// ── Coder (stateful across frames within a burst), bound to a config ─────────
class V34Coder {
  constructor(cfg) { this.cfg = cfg; this.reset(); }
  // §10.1.3.1: "Prior to transmission of B1, the scrambler, trellis encoder,
  // differential encoder, and the precoding filter tap delay line are initialized
  // to zeroes" — and B1's first mapping frame is time index i = 0 (§8), which is
  // what the 4D counter m = 4i + j counts from.
  reset() { this.zPrev = 0; this.conv = 0; this.rxZPrev = 0; this.m = 0; }

  // high=true → b data bits (K shell bits); high=false → b−1 data bits, with a
  // forced 0 inserted as the top shell bit (§9.3.1) so the shell mapper still sees
  // K bits. `bits` therefore has length bitsForFrame(idx): K+4·groupBits (high) or
  // (K−1)+4·groupBits (low). The I/Q parser and constellation are identical.
  encodeFrame(bits, high = true) {                 // -> symsPerFrame points
    const cfg = this.cfg, K = cfg.kShell, q = cfg.qBits, RS = cfg.ringSize;
    const kReal = high ? K : K - 1;                // real shell bits drawn from the stream
    let R0 = 0;
    for (let i = 0; i < kReal; i++) if (bits[i]) R0 += 2 ** i;  // S1 is LSB (eq 9-7); bit 2^(K−1) stays 0 when low
    const rings = cfg.indexToRings(R0);
    const pts = [];
    let bp = kReal;
    for (let j = 0; j < 4; j++) {
      const I1 = bits[bp++], I2 = bits[bp++], I3 = bits[bp++];
      const Qk = [0, 0];
      for (let k = 0; k < 2; k++) { let v = 0; for (let t = 0; t < q; t++) v |= bits[bp++] << t; Qk[k] = v; }
      const I = I2 + 2 * I3;
      const Z = (I + this.zPrev) & 3;
      // Eq. (9-32): U0 = Y0 ⊕ C0 ⊕ V0. C0 = 0 with no precoder; V0 is superframe sync.
      const U0 = (this.conv & 1) ^ superframeV0(cfg.J, cfg.P, this.m++);
      const u0 = rotCW(cfg.pointForLabel(Qk[0] + RS * rings[j][0]), Z);
      const u1 = rotCW(cfg.pointForLabel(Qk[1] + RS * rings[j][1]), (Z + 2 * I1 + U0) & 3);
      const y = TABLE13[subsetLabel(u0)][subsetLabel(u1)];
      this.conv = conv16Next(this.conv, y & 1, (y >> 1) & 1);
      this.zPrev = Z;
      pts.push(u0, u1);
    }
    return pts;
  }

  decodeFrame(pts, high = true) {                 // symsPerFrame points -> bitsForFrame bits
    const cfg = this.cfg, K = cfg.kShell, q = cfg.qBits, RS = cfg.ringSize;
    const kReal = high ? K : K - 1;
    const bits = new Array(kReal + 4 * cfg.groupBits).fill(0);
    const rings = [[0, 0], [0, 0], [0, 0], [0, 0]];
    let bp = kReal;
    for (let j = 0; j < 4; j++) {
      const a = invRot(pts[2 * j]), b = invRot(pts[2 * j + 1]);
      const label0 = cfg.labelOf(a.rep), label1 = cfg.labelOf(b.rep);
      rings[j][0] = label0 >> q; rings[j][1] = label1 >> q;
      const Q0 = label0 & (RS - 1), Q1 = label1 & (RS - 1);
      const Z = a.rot;
      const I = (Z - this.rxZPrev) & 3;
      const value = (b.rot - a.rot) & 3;                        // = 2·I1 + U0
      const I1 = value >> 1;                                    // U0 discarded (redundant)
      const I2 = I & 1, I3 = (I >> 1) & 1;
      this.rxZPrev = Z;
      bits[bp++] = I1; bits[bp++] = I2; bits[bp++] = I3;
      for (let t = 0; t < q; t++) bits[bp++] = (Q0 >> t) & 1;
      for (let t = 0; t < q; t++) bits[bp++] = (Q1 >> t) & 1;
    }
    const R0 = cfg.ringsToIndex(rings);
    for (let i = 0; i < kReal; i++) bits[i] = (Math.floor(R0 / 2 ** i)) & 1;  // low: 2^(K−1) bit is the dropped forced 0
    return bits;
  }
}

/**
 * V34Viterbi — the receiver's half of §9.6's 16-state trellis code: from received
 * 2D symbols (in lattice units, as the slicer sees them) to the most likely
 * transmitted points, a fixed DEPTH of 4D symbols late.
 *
 * Built from the transmitter's own definitions, nothing restated:
 *  - each 2D point's subset label is Figure 9's (subsetLabel);
 *  - a 4D symbol's pair of labels names Table 13's 4D subset y, whose two low bits
 *    drive Figure 10's encoder (conv16Next);
 *  - the redundant bit is in the pair, (s0 ⊕ s1) & 1 = Y0 ⊕ V0 — equation (9-32)'s
 *    U0, with V0 the superframe inversion — on every 4D symbol the encoder makes.
 * So from state s the branches allowed are the label pairs of parity (s & 1) ⊕ V0,
 * and the metric of a branch is the nearest pair of points in its two subsets. It
 * depends on the state only through that parity, so each 4D symbol costs 64 pair
 * evaluations and 64 add-compare-selects. Points are nearest-in-coset, ignoring
 * the constellation's edge; a decision outside it falls back to the hard slice.
 */
const VIT_DEPTH = 40;                               // 4D symbols of traceback
// For a coordinate v and Figure 9's residue index k (0..3, the (p+3)/2 mod 4 of
// subsetLabel), the nearest odd p with that index.
function nearestOfIndex(v, k) {
  const base = 2 * k - 3;                           // index k ⇔ p ≡ 2k − 3 (mod 8)
  return base + 8 * Math.round((v - base) / 8);
}
// The 64 label pairs grouped by (parity, y's two low bits), with y itself.
const VIT_GROUPS = (() => {
  const g = Array.from({ length: 8 }, () => []);
  for (let a = 0; a < 8; a++) for (let b = 0; b < 8; b++) {
    const y = TABLE13[a][b];
    g[(((a ^ b) & 1) << 2) | (y & 3)].push([a, b]);
  }
  return g;
})();
// conv16Next for every state and (Y1, Y2), as yl = Y1 | Y2 << 1.
const CONV16_NEXT = Int8Array.from({ length: 64 }, (_, n) => conv16Next(n >> 2, n & 1, (n >> 1) & 1));
// VIT_GROUPS flattened: group g's pairs at [VIT_OFF[g], VIT_OFF[g + 1]).
const VIT_OFF = new Int32Array(9), VIT_A = [], VIT_B = [];
for (let g = 0; g < 8; g++) { VIT_OFF[g] = VIT_A.length; for (const [a, b] of VIT_GROUPS[g]) { VIT_A.push(a); VIT_B.push(b); } }
VIT_OFF[8] = VIT_A.length;

/**
 * §9.6's 16-state trellis, decoded. Allocation-free per symbol: the survivors live in
 * a ring of preallocated typed arrays, and each 4D symbol's candidate points are its
 * two 2D symbols' nearest point per label, kept by label rather than as objects. It
 * made the same decisions in the same order as the version it replaced, which
 * allocated a dozen arrays and objects a symbol and was a fifth of a V.34 call's CPU.
 */
class V34Viterbi {
  constructor(J, P) {
    this.J = J; this.P = P;
    this.m = 0;                                     // 4D symbols since B1 (V0's counter)
    this.metric = new Float64Array(16).fill(1e30); this.metric[0] = 0;   // the encoder starts at 0
    this._next = new Float64Array(16);
    this.pending = null;                            // the first 2D symbol of a pair
    this.out = [];                                  // decided points, in order
    this._gm = new Float64Array(8); this._ga = new Int8Array(8); this._gb = new Int8Array(8);
    this._d0 = new Float64Array(8); this._d1 = new Float64Array(8);
    const N = VIT_DEPTH + 1;
    this._ring = Array.from({ length: N }, () => ({
      prev: new Int8Array(16), pa: new Int8Array(16), pb: new Int8Array(16),
      i0: new Float64Array(8), q0: new Float64Array(8), i1: new Float64Array(8), q1: new Float64Array(8),
    }));
    this._head = 0; this._len = 0;                  // oldest entry, and how many are kept
  }
  /** Nearest point of each of the 8 labels to x, into d (distance), pi, pq. */
  static _labelsInto(x, d, pi8, pq8) {
    d.fill(Infinity);
    for (let kq = 0; kq < 4; kq++) {
      const pq = nearestOfIndex(x[1], kq), dq = (x[1] - pq) ** 2;
      for (let ki = 0; ki < 4; ki++) {
        const pi = nearestOfIndex(x[0], ki), dd = (x[0] - pi) ** 2 + dq;
        const l = FIG9[kq][ki];
        if (dd < d[l]) { d[l] = dd; pi8[l] = pi; pq8[l] = pq; }
      }
    }
  }
  /** Nearest point of each of the 8 labels to x: [{d, i, q}] by label. */
  static _labels(x) {
    const d = new Float64Array(8), pi = new Float64Array(8), pq = new Float64Array(8);
    V34Viterbi._labelsInto(x, d, pi, pq);
    return Array.from({ length: 8 }, (_, l) => ({ d: d[l], i: pi[l], q: pq[l] }));
  }
  /** One received 2D symbol [re, im]; decided points appear in `out`. */
  push(x) {
    if (!this.pending) { this.pending = x; return; }
    const N = this._ring.length;
    const slot = this._ring[(this._head + this._len) % N];
    const d0 = this._d0, d1 = this._d1;
    V34Viterbi._labelsInto(this.pending, d0, slot.i0, slot.q0);
    V34Viterbi._labelsInto(x, d1, slot.i1, slot.q1);
    this.pending = null;
    // Each group's best pair.
    const gm = this._gm, ga = this._ga, gb = this._gb;
    for (let g = 0; g < 8; g++) {
      let bd = Infinity, ba = -1, bb = -1;
      for (let j = VIT_OFF[g]; j < VIT_OFF[g + 1]; j++) {
        const a = VIT_A[j], b = VIT_B[j], dd = d0[a] + d1[b];
        if (dd < bd) { bd = dd; ba = a; bb = b; }
      }
      gm[g] = bd; ga[g] = ba; gb[g] = bb;
    }
    const v0 = superframeV0(this.J, this.P, this.m++);
    const next = this._next.fill(Infinity), prev = slot.prev, pa = slot.pa, pb = slot.pb;
    pa.fill(-1);
    for (let st = 0; st < 16; st++) {
      const base = this.metric[st];
      if (base >= 1e29) continue;
      const par = (st & 1) ^ v0;
      for (let yl = 0; yl < 4; yl++) {
        const g = (par << 2) | yl;
        const ns = CONV16_NEXT[(st << 2) | yl];
        const m = base + gm[g];
        if (m < next[ns]) { next[ns] = m; prev[ns] = st; pa[ns] = ga[g]; pb[ns] = gb[g]; }
      }
    }
    let lo = Infinity; for (let st = 0; st < 16; st++) if (next[st] < lo) lo = next[st];
    for (let st = 0; st < 16; st++) next[st] -= lo;  // keep the metrics bounded
    this._next = this.metric; this.metric = next;
    this._len++;
    if (this._len > VIT_DEPTH) {
      // Trace back from the best state to the oldest kept symbol and decide it.
      let st = 0; for (let k = 1; k < 16; k++) if (this.metric[k] < this.metric[st]) st = k;
      for (let h = this._len - 1; h > 0; h--) st = this._ring[(this._head + h) % N].prev[st];
      const old = this._ring[this._head];
      const a = old.pa[st], b = old.pb[st];
      this.out.push({ i: old.i0[a], q: old.q0[a] }, { i: old.i1[b], q: old.q1[b] });
      this._head = (this._head + 1) % N; this._len--;
    }
  }
}

module.exports = { V34Coder, V34Viterbi, VIT_DEPTH, makeConfig, CONFIGS, RATE_CONFIGS, RATE_LADDER, framingFor, meanEnergy, meanEnergyComputed, MEAN_E_TABLE, SYMS_PER_FRAME, sliceOdd, invRot, quarterPoints, T12, superframeV0,
  // For the check harnesses, which re-derive Y0 from transmitted points.
  _trellis: { TABLE13, subsetLabel, conv16Next } };
