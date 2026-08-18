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
 * quarter superconstellation; the two points of a 4D symbol are rotated by Z(m)·90°
 * and [Z(m)+2·I1+U0]·90° clockwise (U0 = trellis output).
 *
 * Clean-link simplifications (documented in PROTOCOLS §0 / §7), forced by
 * the lossless, ISI-free, drift-free transport:
 *   - No precoder ⇒ c(n)=0 ⇒ modulo-encoder C0(m)=0 ⇒ U0(m)=Y0(m) (pure trellis).
 *   - No superframe bit-inversion sync ⇒ V0(m)=0 (UART framing carries sync instead).
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
// inverse: given any lattice point, return {rep(first-quadrant), rot}, rotCW(rep,rot)=point
function invRot(p) {
  const x = p.i, y = p.q;
  if (x > 0 && y > 0) return { rep: { i: x, q: y }, rot: 0 };
  if (x > 0 && y < 0) return { rep: { i: -y, q: x }, rot: 1 };
  if (x < 0 && y < 0) return { rep: { i: -x, q: -y }, rot: 2 };
  return { rep: { i: y, q: -x }, rot: 3 };            // x<0 && y>0
}

// ── Trellis (§9.6.3), rate-independent ───────────────────────────────────────
const FIG9 = [
  [0, 7, 4, 3],   // Im=-3
  [5, 2, 1, 6],   // Im=-1
  [4, 0, 3, 7],   // Im=+1
  [1, 6, 5, 2],   // Im=+3
];
function subsetLabel(p) {
  const re = (((((p.i + 3) / 2) % 4) + 4) % 4);
  const im = (((((p.q + 3) / 2) % 4) + 4) % 4);
  return FIG9[im][re];
}
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
function makeConfig({ sRate, bitRate, frameBits, kShell, mRings, swp = 0xffff }) {
  // frameBits is the HIGH-frame bit count b; a low frame carries b−1 (§8.2). q and
  // the constellation derive from the high frame; low frames reuse the same parser
  // and constellation, differing only in that the top shell-mapper bit is a forced
  // 0 (§9.3.1). SWP=0xffff ⇒ every frame high ⇒ constant b (no switching).
  const qBits = ((frameBits - kShell) / 4 - 3) / 2;
  if (!Number.isInteger(qBits) || qBits < 0) throw new Error('bad V.34 config: q not integer');
  const switching = (swp & 0xffff) !== 0xffff;
  // Per-mapping-frame parity from the 16-bit switching pattern, LSB-first, repeating
  // every 16 frames; both ends drive it from a frame counter reset at data-burst
  // start so the high/low sequence is identical. (SWP value is the spec's; the
  // bit-indexing convention is a self-consistent choice — see PROTOCOLS.md §7.)
  const isHighFrame = idx => switching ? (((swp >>> (((idx % 16) + 16) % 16)) & 1) === 1) : true;
  const ringSize = 1 << qBits;
  const quarterPts = ringSize * mRings;              // = L/4

  // Quarter superconstellation (§9.1): odd-integer lattice (§9.6.3.1). Each
  // 90°-rotation orbit has exactly one first-quadrant member; use it as the
  // canonical rep, ordered by magnitude (tie → greater imaginary first).
  const reps = [];
  const R = 81;
  for (let b = 1; b <= R; b += 2) for (let a = 1; a <= R; a += 2) reps.push({ i: a, q: b });
  reps.sort((p1, p2) => {
    const e1 = p1.i * p1.i + p1.q * p1.q, e2 = p2.i * p2.i + p2.q * p2.q;
    if (e1 !== e2) return e1 - e2;
    if (p1.q !== p2.q) return p2.q - p1.q;
    return p1.i - p2.i;
  });
  const quarter = reps.slice(0, quarterPts);
  const labelMap = new Map();
  for (let k = 0; k < quarter.length; k++) labelMap.set(quarter[k].i * 10000 + quarter[k].q, k);
  const labelOf = rep => { const v = labelMap.get(rep.i * 10000 + rep.q); return v === undefined ? -1 : v; };

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
    swp, switching, groupBits,
    frameBitsHigh: frameBits, frameBitsLow: frameBits - 1,
    isHighFrame,
    // data-stream bits drawn for the mapping frame at index idx
    bitsForFrame: idx => (isHighFrame(idx) ? frameBits : frameBits - 1),
  };
}

const CONFIGS = {
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

// ── Coder (stateful across frames within a burst), bound to a config ─────────
class V34Coder {
  constructor(cfg) { this.cfg = cfg; this.reset(); }
  reset() { this.zPrev = 0; this.conv = 0; this.rxZPrev = 0; }

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
      const U0 = this.conv & 1;                                 // Y0(m); C0=0,V0=0 ⇒ U0=Y0
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

module.exports = { V34Coder, makeConfig, CONFIGS, SYMS_PER_FRAME, sliceOdd, invRot };
