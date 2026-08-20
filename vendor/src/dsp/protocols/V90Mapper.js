'use strict';

/**
 * V90Mapper — the genuine V.90 downstream (digital→analogue) PCM encode/decode
 * chain, clean-room from ITU-T V.90 (09/98): the G.711 µ-law codebook (Table 1),
 * the constellation sets Cᵢ (§5.4.4), the modulus encoder (§5.4.3), the sign-bit
 * parser (§5.4.2 / Table 3) and the spectral shaper (§5.4.6 / Figure 2).
 *
 * ── The shape of V.90 downstream ────────────────────────────────────────────
 * V.90 downstream is NOT modulation. There is no carrier, no pulse shaping, no
 * matched filter and no timing recovery: the symbols ARE the 8 kHz PCM samples,
 * one per sample period. The digital modem places PCM codewords directly on the
 * network; the analogue modem reads the levels back. Everything hard lives in the
 * mapper, which is this file.
 *
 * A **data frame** is six symbols (intervals i = 0..5) carrying D = S + K bits:
 *
 *     rate = (S + K) · 8000 / 6          → 28000…56000 in 8000/6 = 1333⅓ steps
 *
 * The six-symbol frame is not arbitrary: on a T1 the robbed-bit-signalling
 * pattern repeats every six frames, which is why V.90 lets each interval carry
 * its own constellation Cᵢ. Our transport has no RBS, so all six Cᵢ are equal —
 * see PROTOCOLS.md.
 *
 *   §5.4.2 parse   d0..d(S−1) → sign bits s0..s(S−1)
 *                  dS..d(D−1) → modulus bits b0..b(K−1),
 *                  R0 = b0 + b1·2¹ + … + b(K−1)·2^(K−1)      (b0 is the LSB)
 *   §5.4.3 modulus Kᵢ = Rᵢ mod Mᵢ ;  Rᵢ₊₁ = (Rᵢ − Kᵢ)/Mᵢ,  requires ∏Mᵢ ≥ 2^K
 *   §5.4.4 mapper  Kᵢ labels a member of Cᵢ, labelled DESCENDING by magnitude
 *                  (label 0 = largest PCM code in Cᵢ, label Mᵢ−1 = smallest)
 *   §5.4.6 signs   sign bit 1 ⇒ positive voltage, 0 ⇒ negative
 *
 * ── The spectral shaper (§5.4.6, Figure 2) ──────────────────────────────────
 * Of the six sign bits, S carry data and Sr = 6 − S are redundant and spent on
 * shaping. Table 3 partitions the six sign positions into Sr shaping frames of
 * 6/Sr positions each; position 0 of every shaping frame is the redundant one and
 * is initialised to 0, the rest carry s0, s1, … in order. (This general form
 * reproduces Table 3 exactly for Sr = 1, 2 and 3.)
 *
 * The shaper then picks, per shaping frame, one of four sign-inversion rules,
 * constrained to a 2-state trellis:
 *
 *      rule A  leave the signs alone            state 0 → 0
 *      rule B  invert every sign in the frame   state 0 → 1
 *      rule C  invert the even-numbered signs   state 1 → 0
 *      rule D  invert the odd-numbered signs    state 1 → 1
 *
 * From state 0 only A and B are allowed; from state 1 only C and D. The choice
 * minimises a spectral metric computed from the emitted linear PCM values:
 *
 *      y[n] = x[n] − b₁·x[n−1] + a₁·y[n−1]
 *      v[n] = y[n] − b₂·y[n−1] + a₂·v[n−1]
 *      w[n] = v²[n] + w[n−1]
 *
 * with a₁,a₂,b₁,b₂ chosen by the analogue modem and sent in CP (8-bit two's
 * complement, 6 bits after the binary point, |·| ≤ 1).
 *
 * **The rule is always recoverable, so the shaper costs no data.** Position 0 of
 * every shaping frame starts at 0, and each rule acts on it distinguishably: from
 * state 0, A leaves it 0 and B makes it 1; from state 1, C makes it 1 (it is an
 * even-numbered position) and D leaves it 0. So the receiver — which tracks the
 * trellis state deterministically from a known start — reads position 0, infers
 * the rule, un-inverts the remaining positions and recovers s0, s1, …. This is an
 * exact bijection, verified over every state/rule/data combination in
 * tools/v90-shaper-check.js.
 *
 * Lookahead depth lₐ (0..3; 0 and 1 mandatory in the spec) is an ENCODER-side
 * choice only: it changes which legal rule sequence is chosen, never how it is
 * decoded, so the receiver is independent of it.
 *
 * ── Clean-link notes (documented in PROTOCOLS.md, not hidden) ───────────────
 *   - The transport is 16-bit linear PCM, so an 8-bit µ-law quantiser is inserted
 *     deliberately as the MODELLED network codec. Without it "V.90" is meaningless
 *     — the level structure the whole Recommendation is built around would not
 *     exist. This is modelling the network, exactly as treating the WebSocket as a
 *     4-wire line does; it is a judgement call, stated openly.
 *   - No robbed-bit signalling, no digital pad, no PCM-law auto-detection (we own
 *     the codec and choose µ-law), no digital-impairment learning, no analogue-loop
 *     equalizer. All of these measure or repair a network segment this transport
 *     does not have.
 *   - The constellation we choose exceeds the average-power constraint a real
 *     digital modem must honour (§Table 15 / the FCC −12 dBm limit that capped real
 *     US connections at 53 333 bit/s, D = 40). We run D = 42 for a true 56 000
 *     because this transport has no regulatory or hybrid constraint. See below.
 */

// ─── G.711 µ-law codebook (Table 1/V.90) ─────────────────────────────────────
// Ucode u ∈ 0..127 is the magnitude index: segment = u>>4, mantissa = u&15.
// Magnitude is on G.711's 14-bit scale, 0 (u=0) … 8031 (u=127), monotonic in u.
// Minimum spacing is 2 (inside segment 0) and doubles per segment.
const UCODES = 128;
function ucodeMagnitude(u) {
  const seg = (u >> 4) & 7, man = u & 15;
  return (((man << 1) | 33) << seg) - 33;      // = (2·man + 33)·2^seg − 33
}
const MAG = new Int32Array(UCODES);
for (let u = 0; u < UCODES; u++) MAG[u] = ucodeMagnitude(u);

// The G.711 µ-law octet for (ucode, sign). G.711 transmits the complement, and
// bit 7 set means POSITIVE in V.90's convention (sign bit 1 ⇒ positive voltage).
// Provided for provenance/verification; the wire here carries linear values.
function ulawOctet(u, positive) {
  return (~(((positive ? 1 : 0) << 7) | (u & 0x7f))) & 0xff;
}

// ─── Transport scaling ───────────────────────────────────────────────────────
// G.711's 14-bit scale → the transport's 16-bit linear PCM: ×4. Peak 8031·4 =
// 32124 (0.980 of full scale, no clipping) and the minimum µ-law step becomes
// 8 LSB — comfortably above the ±1 LSB the Float32→Int16→Float32 transport
// round-trip costs, so codewords recover exactly by nearest-level slicing.
const PCM_SCALE = 4;
const FULL = 32768;
const toFloat = signedMag => (signedMag * PCM_SCALE) / FULL;
const fromFloat = f => Math.round((f * FULL) / PCM_SCALE);

// ─── Constellation sets Cᵢ (§5.4.4) ──────────────────────────────────────────
// A constellation is a 128-bit mask over the Ucodes (exactly the form CP carries).
// Members are labelled DESCENDING by magnitude: label 0 = largest.
function maskFromUcodes(list) {
  const m = new Uint8Array(16);
  for (const u of list) m[u >> 3] |= 1 << (u & 7);
  return m;
}
function ucodesFromMask(mask) {
  const out = [];
  for (let u = 0; u < UCODES; u++) if (mask[u >> 3] & (1 << (u & 7))) out.push(u);
  return out;
}
function buildConstellation(mask) {
  const members = ucodesFromMask(mask).sort((a, b) => MAG[b] - MAG[a]);  // descending
  const byUcode = new Int32Array(UCODES).fill(-1);
  for (let l = 0; l < members.length; l++) byUcode[members[l]] = l;
  return {
    mask, members, M: members.length, labelToUcode: members, ucodeToLabel: byUcode,
    // magnitudes in ascending order with their labels, for nearest-level slicing
    ascMag: members.map((u, l) => ({ u, l, mag: MAG[u] })).sort((a, b) => a.mag - b.mag),
  };
}

// Nearest legal level in C for a received 14-bit-scale signed value.
// Returns {label, positive}. Binary search on ascending magnitude.
function sliceLevel(C, signedValue) {
  const positive = signedValue >= 0;
  const mag = Math.abs(signedValue);
  const a = C.ascMag;
  let lo = 0, hi = a.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid].mag < mag) lo = mid + 1; else hi = mid;
  }
  let best = lo;
  if (lo > 0 && Math.abs(a[lo - 1].mag - mag) <= Math.abs(a[lo].mag - mag)) best = lo - 1;
  return { label: a[best].l, positive };
}

// ─── Default downstream constellation ────────────────────────────────────────
// 56 000 needs K = 39, hence ∏Mᵢ ≥ 2³⁹ = 549 755 813 888. With six equal
// intervals that forces Mᵢ ≥ 91 (90⁶ = 5.314e11 < 2³⁹ ≤ 5.679e11 = 91⁶), i.e.
// 91 of the 128 Ucodes per interval. We take the 91 LARGEST (u = 37..127),
// dropping the finely-spaced near-zero codes exactly as a real analogue modem
// would: the smallest surviving step is 32 LSB at 16-bit scale.
//
// On a real loop 91 distinguishable levels within the power limit is not
// attainable — which is precisely why real-world 56k links so rarely reached
// 56 000. Here it is legitimate, and it is the transport that makes it so, not a
// shortcut in the coder. See PROTOCOLS.md.
const DEFAULT_UCODE_MIN = 37;
function defaultMask() {
  const list = [];
  for (let u = DEFAULT_UCODE_MIN; u < UCODES; u++) list.push(u);
  return maskFromUcodes(list);
}

// Average constellation power (14-bit scale, mean of magnitude²) — reported so
// the power deviation above can be stated with a real number rather than a claim.
function averagePower(C) {
  let s = 0;
  for (const u of C.members) s += MAG[u] * MAG[u];
  return s / C.members.length;
}

// ─── Modulus encoder / decoder (§5.4.3) ──────────────────────────────────────
// R0 < 2^K ≤ ∏Mᵢ. At K = 39 that is < 5.5e11, well inside the exact-integer
// range of a double (2⁵³), so plain Number arithmetic is exact — but bitwise
// operators are 32-bit and must NOT be used on these values.
function modulusEncode(R0, M) {
  const K = new Array(M.length);
  let R = R0;
  for (let i = 0; i < M.length; i++) {
    const k = R % M[i];
    K[i] = k;
    R = (R - k) / M[i];
  }
  return K;
}
function modulusDecode(K, M) {
  let R = 0;
  for (let i = M.length - 1; i >= 0; i--) R = R * M[i] + K[i];
  return R;
}

// ─── Sign-bit parser (Table 3/V.90) ──────────────────────────────────────────
// Sr shaping frames of 6/Sr positions. Position 0 of each is the redundant bit
// (initialised 0); the remaining positions take s0, s1, … in order. Reproduces
// Table 3 for Sr = 1 (one 6-position frame), 2 (two 3-position) and 3 (three
// 2-position). Sr = 0 (S = 6) means no shaping at all: signs are the data bits.
function shapingLayout(Sr) {
  if (Sr === 0) return { frames: 0, width: 0, dataPerFrame: 0 };
  if (6 % Sr !== 0) throw new Error(`V.90: Sr=${Sr} does not divide the 6-symbol frame`);
  const width = 6 / Sr;
  return { frames: Sr, width, dataPerFrame: width - 1 };
}

// ─── Spectral shaper (§5.4.6, Figure 2) ──────────────────────────────────────
// Rules, as functions over a shaping frame's sign array (true = positive).
const RULE_A = 0, RULE_B = 1, RULE_C = 2, RULE_D = 3;
function applyRule(signs, rule) {
  const out = signs.slice();
  for (let k = 0; k < out.length; k++) {
    if (rule === RULE_B) out[k] = !out[k];
    else if (rule === RULE_C && (k % 2) === 0) out[k] = !out[k];
    else if (rule === RULE_D && (k % 2) === 1) out[k] = !out[k];
  }
  return out;
}
// 2-state trellis: from state 0 rules {A,B}; from state 1 rules {C,D}.
// A→0, B→1, C→0, D→1.
const ALLOWED = [[RULE_A, RULE_B], [RULE_C, RULE_D]];
const NEXT_STATE = { [RULE_A]: 0, [RULE_B]: 1, [RULE_C]: 0, [RULE_D]: 1 };

// Quantise a shaper coefficient the way CP carries it: 8-bit two's complement
// with 6 bits after the binary point, |value| ≤ 1.
function quantCoef(v) {
  let q = Math.round(v * 64);
  if (q > 127) q = 127; if (q < -128) q = -128;
  return q / 64;
}
const DEFAULT_COEFS = { a1: 0, b1: -1, a2: 0, b2: 0 };   // y[n] = x[n] + x[n−1] ⇒ minimising w suppresses DC

/**
 * The shaper's filter state. Kept separately from the trellis search so a
 * candidate branch can be evaluated on a copy and discarded.
 */
class ShaperFilter {
  constructor(coefs) {
    const c = coefs || DEFAULT_COEFS;
    this.a1 = quantCoef(c.a1); this.b1 = quantCoef(c.b1);
    this.a2 = quantCoef(c.a2); this.b2 = quantCoef(c.b2);
    this.reset();
  }
  reset() { this.xPrev = 0; this.yPrev = 0; this.vPrev = 0; }
  clone() { const f = Object.create(ShaperFilter.prototype); Object.assign(f, this); return f; }
  // Feed one emitted linear PCM value; return the incremental metric v².
  step(x) {
    const y = x - this.b1 * this.xPrev + this.a1 * this.yPrev;
    const v = y - this.b2 * this.yPrev + this.a2 * this.vPrev;
    this.xPrev = x; this.yPrev = y; this.vPrev = v;
    return v * v;
  }
}

// ─── Configurations ──────────────────────────────────────────────────────────
// Only 56 000 is wired and verified. The coder is fully (K,S)-parameterised and
// constraint-checked, so a lower rate is a CONFIGS entry plus a constellation
// whose ∏Mᵢ satisfies the K it needs — nothing else changes. The exact per-rate
// (K,S) pairings of Table 2/V.90 are NOT reproduced here; only the rate formula
// and the 56 000 endpoint were verified. See PROTOCOLS.md.
const CONFIGS = {
  56000: { K: 39, S: 3 },
};
const SYMS_PER_FRAME = 6;
const SYMBOL_RATE = 8000;

function makeConfig(rate) {
  const base = CONFIGS[rate];
  if (!base) throw new Error(`V.90: no configuration for ${rate} bit/s`);
  const { K, S } = base;
  const D = S + K;
  const Sr = SYMS_PER_FRAME - S;
  const bitRate = (D * SYMBOL_RATE) / SYMS_PER_FRAME;
  if (bitRate !== rate) throw new Error(`V.90: (K=${K},S=${S}) gives ${bitRate}, not ${rate}`);
  return { rate, K, S, D, Sr, bitRate, layout: shapingLayout(Sr), symsPerFrame: SYMS_PER_FRAME };
}

/**
 * V90Coder — one direction of the downstream PCM channel.
 *
 * encodeFrame(bits) takes cfg.D bits and returns either null (the shaper's
 * lookahead pipeline is still filling) or an array of six signed 14-bit-scale
 * PCM values. decodeFrame(values) is the exact inverse and, because rule
 * recovery is a bijection, needs no lookahead and never lags.
 */
class V90Coder {
  constructor(cfg, constellations, opts = {}) {
    this.cfg = cfg;
    this.C = constellations;                 // six constellation objects
    this.coefs = opts.coefs || DEFAULT_COEFS;
    this.lookahead = opts.lookahead == null ? 1 : Math.max(0, Math.min(3, opts.lookahead));
    const prod = this.C.reduce((a, c) => a * c.M, 1);
    if (prod < 2 ** cfg.K) {
      throw new Error(`V.90: constellation too small — ∏Mᵢ = ${prod} < 2^${cfg.K} = ${2 ** cfg.K}`);
    }
    this.reset();
  }

  reset() {
    this.txState = 0;                        // trellis state, TX
    this.txFilter = new ShaperFilter(this.coefs);
    this.pending = [];                       // shaping frames awaiting a committed rule
    this.doneFrames = [];                    // data frames with all signs committed
    this.rxState = 0;                        // trellis state, RX
  }

  // ── TX ────────────────────────────────────────────────────────────────────
  /** cfg.D bits → six signed PCM values, or null while the pipeline fills. */
  encodeFrame(bits) {
    const { K, S, Sr, layout } = this.cfg;
    // §5.4.2 parse: d0..d(S−1) are the sign bits, dS.. are the modulus bits.
    const signBits = bits.slice(0, S);
    let R0 = 0;
    for (let i = 0; i < K; i++) if (bits[S + i]) R0 += 2 ** i;      // b0 is the LSB
    // §5.4.3 modulus encode → §5.4.4 magnitudes.
    const M = this.C.map(c => c.M);
    const labels = modulusEncode(R0, M);
    const mags = labels.map((l, i) => MAG[this.C[i].labelToUcode[l]]);

    if (Sr === 0) {                          // no shaping: signs are the data bits
      const out = mags.map((m, i) => (signBits[i] ? m : -m));
      return out;
    }

    // Partition the six sign positions into Sr shaping frames (Table 3).
    const { frames, width, dataPerFrame } = layout;
    const dataFrame = { mags, signs: new Array(6).fill(true), remaining: frames };
    for (let j = 0; j < frames; j++) {
      const initial = new Array(width).fill(true);            // position 0 redundant, init 0
      initial[0] = false;                                     // "0" ⇒ negative
      for (let k = 1; k < width; k++) {
        const si = j * dataPerFrame + (k - 1);
        initial[k] = !!signBits[si];
      }
      this.pending.push({ frame: dataFrame, slot: j, width, initial });
    }
    this.doneFrames.push(dataFrame);
    this._commit();
    if (this.doneFrames.length && this.doneFrames[0].remaining === 0) {
      const f = this.doneFrames.shift();
      return f.mags.map((m, i) => (f.signs[i] ? m : -m));
    }
    return null;
  }

  /** Commit shaping frames whose lookahead window is full (Viterbi over 2 states). */
  _commit() {
    while (this.pending.length > this.lookahead) {
      const depth = Math.min(this.pending.length, this.lookahead + 1);
      let bestRule = null, bestCost = Infinity;
      for (const rule of ALLOWED[this.txState]) {
        const cost = this._branchCost(0, depth, rule, this.txState, this.txFilter);
        if (cost < bestCost) { bestCost = cost; bestRule = rule; }
      }
      const sf = this.pending.shift();
      const signs = applyRule(sf.initial, bestRule);
      for (let k = 0; k < sf.width; k++) {
        const pos = sf.slot * sf.width + k;
        sf.frame.signs[pos] = signs[k];
        this.txFilter.step(signs[k] ? sf.frame.mags[pos] : -sf.frame.mags[pos]);
      }
      sf.frame.remaining--;
      this.txState = NEXT_STATE[bestRule];
    }
  }

  /** Metric of taking `rule` at pending[idx], then the best legal continuation. */
  _branchCost(idx, depth, rule, state, filter) {
    const sf = this.pending[idx];
    const f = filter.clone();
    const signs = applyRule(sf.initial, rule);
    let cost = 0;
    for (let k = 0; k < sf.width; k++) {
      const pos = sf.slot * sf.width + k;
      cost += f.step(signs[k] ? sf.frame.mags[pos] : -sf.frame.mags[pos]);
    }
    const ns = NEXT_STATE[rule];
    if (idx + 1 >= depth) return cost;
    let best = Infinity;
    for (const r of ALLOWED[ns]) best = Math.min(best, this._branchCost(idx + 1, depth, r, ns, f));
    return cost + best;
  }

  /** Flush the lookahead pipeline (end of stream / end of burst). */
  flush() {
    const out = [];
    const saved = this.lookahead;
    this.lookahead = 0;
    this._commit();
    while (this.doneFrames.length && this.doneFrames[0].remaining === 0) {
      const f = this.doneFrames.shift();
      out.push(f.mags.map((m, i) => (f.signs[i] ? m : -m)));
    }
    this.lookahead = saved;
    return out;
  }

  // ── RX ────────────────────────────────────────────────────────────────────
  /** Six received signed PCM values → cfg.D bits. */
  decodeFrame(values) {
    const { K, S, Sr, layout } = this.cfg;
    const labels = new Array(6);
    const signs = new Array(6);
    for (let i = 0; i < 6; i++) {
      const s = sliceLevel(this.C[i], values[i]);
      labels[i] = s.label;
      signs[i] = s.positive;
    }
    const bits = new Array(this.cfg.D).fill(0);

    if (Sr === 0) {
      for (let i = 0; i < S; i++) bits[i] = signs[i] ? 1 : 0;
    } else {
      const { frames, width, dataPerFrame } = layout;
      for (let j = 0; j < frames; j++) {
        const got = signs.slice(j * width, j * width + width);
        // Position 0 started at 0 (negative). Which rule was applied is readable
        // from it given the state: state 0 → A leaves it 0, B makes it 1;
        // state 1 → C makes it 1, D leaves it 0.
        const p0 = got[0];
        const rule = this.rxState === 0 ? (p0 ? RULE_B : RULE_A)
                                        : (p0 ? RULE_C : RULE_D);
        const undone = applyRule(got, rule);                   // rules are involutions
        for (let k = 1; k < width; k++) {
          bits[j * dataPerFrame + (k - 1)] = undone[k] ? 1 : 0;
        }
        this.rxState = NEXT_STATE[rule];
      }
    }
    const R0 = modulusDecode(labels, this.C.map(c => c.M));
    for (let i = 0; i < K; i++) bits[S + i] = Math.floor(R0 / 2 ** i) % 2;
    return bits;
  }
}

module.exports = {
  UCODES, MAG, ucodeMagnitude, ulawOctet,
  PCM_SCALE, FULL, toFloat, fromFloat,
  maskFromUcodes, ucodesFromMask, buildConstellation, sliceLevel,
  defaultMask, averagePower, DEFAULT_UCODE_MIN,
  modulusEncode, modulusDecode, shapingLayout,
  RULE_A, RULE_B, RULE_C, RULE_D, ALLOWED, NEXT_STATE, applyRule,
  quantCoef, DEFAULT_COEFS, ShaperFilter,
  CONFIGS, makeConfig, V90Coder, SYMS_PER_FRAME, SYMBOL_RATE,
};
