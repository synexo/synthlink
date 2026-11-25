'use strict';

/*!
 * @license
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Copyright (C) 2026 Joseph Quinn
 *
 * Ported from BinModem <https://github.com/CasualArclamp/BinModem>,
 * crates/datapump/src/v90/dil.rs (design, Analysis, Route, ladder, quietest,
 * widest, choose, average_power) and v90/mod.rs (POWER_LIMITS), at commit
 * 623f935e28fe6de3a8a4f41492feb46e1bb86c3a of <https://github.com/synexo/BinModem>.
 * Copyright the BinModem authors; GPL-3.0-or-later. See NOTICE.
 */
/**
 * V.90 digital impairment learning (§8.4.1, §9.3.2.9) — the analogue modem's
 * side: the DIL it asks for, what the route did to each codeword, and the
 * constellations that follow. Ported from BinModem's crates/datapump v90::dil
 * (GPL-3.0, PROVENANCE.md), whose analogue modem chooses this way against real
 * servers.
 *
 * Between the digital modem and the codec there may be more than wire. A T1
 * carrying signalling in its bits overwrites the low bit of every sixth octet
 * (robbed-bit signalling), so in one data frame interval half the codewords
 * arrive as their neighbours. A digital pad scales every level. A gateway between
 * the two companding laws moves every codeword to the other law's nearest. None
 * of it is announced and all of it is exact, so the analogue modem asks for every
 * codeword, several times in every interval, and writes down what arrived.
 *
 * Levels here are fractions of the sixteen-bit full scale Table 1/V.90 is printed
 * in, which is what a sample on this transport already is.
 */

const INTERVALS = 6;
const UCODES = 128;

/** Table 1/V.90's linear value of a Ucode on the sixteen-bit scale, either law. */
function linear(law, u) {
  const chord = u >> 4, step = u & 15;
  if (law !== 'a') return 4 * (((2 * step + 33) << chord) - 33);
  return u < 32 ? 16 * u + 8 : ((2 * step + 33) << (chord - 1)) * 8;
}
const level = (law, u) => linear(law, u) / 32768;

/** Table 15/V.90: the average power limit, in Table 1's units, by INFO0d's bits 33:37. */
const POWER_LIMITS = [
  15124, 14276, 13480, 12724, 12012, 11340, 10708, 10108, 9544, 9008, 8504, 8028, 7580, 7156, 6756, 6380, 6020,
  5684, 5368, 5068, 4784, 4516, 4264, 4024, 3800, 3588, 3388, 3196, 3020, 2852, 2692, 2540,
];
const powerLimit = (maxPower) => POWER_LIMITS[Math.max(0, Math.min(POWER_LIMITS.length - 1, maxPower | 0))];

/** Symbols a segment: H of 5 is six data frames, one of references and five of the codeword learned. */
const H = 5;
const PATTERN = (H + 1) * INTERVALS;
/** Codewords between one segment and the next: neighbours one apart are all but alike. */
const ORDER_STEP = 3;
/** Chords in turn, never two neighbours in a row: the order the descriptor walks them. */
const CHORD_ORDER = [0, 4, 2, 6, 1, 5, 3, 7];
/**
 * The loudest codeword the DIL asks for, and so any constellation uses: what
 * reaches a modem past a softphone is held down well above a third of full scale,
 * and Table 15's powers put nothing up there that a constellation needs.
 */
const LOUDEST = 0.3;
/** Neighbouring levels, in the noise's standard deviations: five either side of the boundary. */
const SPACING = 10.0;
/** The modulus encoder's room (5.4.3): the moduli's product at least 5/4 of 2^K. */
const ROOM = [5, 4];
/**
 * The least spread believed: two sixteen-bit LSBs, the transport's ±1 LSB round
 * trip. A route of exact codewords reads no spread at all, and spacing by none
 * would keep a robbed bit's twin levels as two.
 */
const NOISE_FLOOR = 2 / 32768;

/**
 * The DIL this modem asks for: every codeword up to LOUDEST but U_INFO, each in a
 * segment of six frames, the first all references at U_INFO and the other five
 * the codeword itself, signs from a fixed balanced pattern. Three times up the
 * codewords, three apart, so neighbouring segments differ.
 */
function design(law, uinfo) {
  // A balanced sign pattern with no spectral line: an m-sequence's first 36.
  const sp = [];
  let r = 0x41;
  for (let i = 0; i < PATTERN; i++) { const b = ((r >> 6) ^ r) & 1; r = ((r << 1) | b) & 0x7f; sp.push(b); }
  const tp = Array.from({ length: PATTERN }, (_, n) => (n >= INTERVALS ? 1 : 0));
  // The order: chords taken in turn (CHORD_ORDER), and inside each chord its
  // codewords three apart, three times up. So no two neighbouring segments are
  // alike, which is what lets a reader place itself (and BinModem's reason for
  // three passes), and the downstream does not climb the codewords for seconds,
  // as a real call's DIL does not (v90-dil-level-check).
  const byChord = Array.from({ length: 8 }, () => []);
  for (let c = 0; c < 8; c++) {
    for (let first = 0; first < ORDER_STEP; first++) {
      for (let u = c * 16 + first; u < c * 16 + 16; u += ORDER_STEP) if (u !== uinfo && level(law, u) <= LOUDEST) byChord[c].push(u);
    }
  }
  const ucodes = [];
  for (let k = 0; byChord.some((l) => k < l.length); k++) for (const c of CHORD_ORDER) if (k < byChord[c].length) ucodes.push(byChord[c][k]);
  return { n: ucodes.length, sp, tp, h: new Array(8).fill(H), ref: new Array(8).fill(uinfo), ucodes };
}

/** Reads a DIL as it arrives: per interval and codeword, the mean level and its spread. */
class Analysis {
  constructor() {
    this.sum = Array.from({ length: INTERVALS }, () => new Float64Array(UCODES));
    this.squares = Array.from({ length: INTERVALS }, () => new Float64Array(UCODES));
    this.count = Array.from({ length: INTERVALS }, () => new Uint32Array(UCODES));
  }
  /** One symbol: the codeword and sign sent, its interval, and the level received. */
  feed(ucode, positive, interval, value) {
    const v = positive ? value : -value, i = interval % INTERVALS, u = ucode % UCODES;
    this.sum[i][u] += v; this.squares[i][u] += v * v; this.count[i][u]++;
  }
  route() {
    const levels = Array.from({ length: INTERVALS }, () => new Float64Array(UCODES));
    const spread = new Float64Array(UCODES);
    for (let u = 0; u < UCODES; u++) {
      let variance = 0, degrees = 0;
      for (let i = 0; i < INTERVALS; i++) {
        const n = this.count[i][u];
        if (!n) continue;
        const mean = this.sum[i][u] / n;
        levels[i][u] = mean;
        variance += this.squares[i][u] - n * mean * mean;
        degrees += Math.max(0, n - 1);
      }
      spread[u] = degrees > 0 ? Math.sqrt(Math.max(0, variance) / degrees) : Infinity;
    }
    return new Route(levels, spread, this.count.map((c) => Uint32Array.from(c)));
  }
}

class Route {
  constructor(levels, spread, readings) { this.levels = levels; this.spread = spread; this.readings = readings; }

  /** A route that does nothing: every codeword as itself, `noise` of spread. */
  static clean(law, noise) {
    const levels = Array.from({ length: INTERVALS }, () => Float64Array.from({ length: UCODES }, (_, u) => level(law, u)));
    const readings = Array.from({ length: INTERVALS }, () => new Uint32Array(UCODES).fill(1));
    return new Route(levels, new Float64Array(UCODES).fill(noise), readings);
  }

  /** The typical spread: the median across codewords read. */
  noise() {
    const s = [...this.spread].filter(Number.isFinite).sort((a, b) => a - b);
    return s.length ? Math.max(NOISE_FLOOR, s[s.length >> 1]) : Infinity;
  }

  /**
   * The spread data mode can expect at an RMS level `rms`: the spread's square
   * fitted as a floor plus a share of each segment's power, taken at data mode's
   * power, never tidier than the quiet codewords read.
   */
  noiseAt(law, rms) {
    const pts = [];
    for (let u = 0; u < UCODES; u++) if (Number.isFinite(this.spread[u]) && level(law, u) <= LOUDEST) pts.push([level(law, u) ** 2, this.spread[u] ** 2]);
    if (pts.length < 2) return this.noise();
    const n = pts.length, mx = pts.reduce((t, p) => t + p[0], 0) / n, my = pts.reduce((t, p) => t + p[1], 0) / n;
    let sxx = 0, sxy = 0;
    for (const [x, y] of pts) { sxx += (x - mx) ** 2; sxy += (x - mx) * (y - my); }
    const slope = sxx > 0 ? Math.max(0, sxy / sxx) : 0;
    const floor = Math.max(0, my - slope * mx);
    return Math.max(Math.sqrt(floor + slope * rms * rms), this.noise());
  }
}

/**
 * Interval i's codewords from the quietest up, `spacing` apart in level and each
 * at least half that from its own opposite. Codewords the route put in the same
 * place (a robbed bit's neighbours) are one level: the one that arrived as itself
 * is kept. A codeword whose readings spread over half a spacing is not a level.
 */
function ladder(route, law, i, spacing) {
  const lv = (u) => route.levels[i][u];
  const order = [];
  for (let u = 0; u < UCODES; u++) if (route.readings[i][u] > 0 && 2 * route.spread[u] <= spacing) order.push(u);
  order.sort((a, b) => lv(a) - lv(b));
  const moved = (u) => Math.abs(lv(u) - level(law, u));
  const levels = [];
  let bottom = -Infinity;
  for (const u of order) {
    if (levels.length && lv(u) - bottom < 0.3 * spacing) {
      if (moved(u) < moved(levels[levels.length - 1])) levels[levels.length - 1] = u;
    } else { bottom = lv(u); levels.push(u); }
  }
  const chosen = [];
  for (const u of levels) {
    if (2 * lv(u) < spacing) continue;
    if (!chosen.length || lv(u) - lv(chosen[chosen.length - 1]) >= spacing) chosen.push(u);
  }
  return chosen;
}

const fitsWithRoom = (moduli, k) => k < 120 && moduli.reduce((p, m) => p * m, 1) * ROOM[1] >= ROOM[0] * Math.pow(2, k);

/**
 * 8.5.2's average power of a constellation set carrying K bits, in Table 1's units
 * squared: each level weighted by how many of the 2^K messages the modulus
 * encoder sends to it. Labels run loudest first (5.4.4).
 */
function averagePower(law, sets, k) {
  if (k >= 52 || sets.some((s) => !s.length)) return Infinity;
  const total = Math.pow(2, k);
  let r = total - 1, a = 1, power = 0;
  for (const set of sets) {
    const m = set.length, ki = r % m, next = Math.floor(r / m);
    const pts = [...set].sort((x, y) => y - x);
    for (let j = 0; j < pts.length; j++) {
      const n = j < ki ? a * (next + 1) : j === ki ? total - a * (r - next) : a * next;
      const l = linear(law, pts[j]);
      power += l * l * n;
    }
    r = next; a *= m;
  }
  return power / (INTERVALS * total);
}

/** The quietest set carrying K bits on these ladders, or null past the power limit. */
function quietest(route, law, k, spacing, limit) {
  const ladders = Array.from({ length: INTERVALS }, (_, i) => ladder(route, law, i, spacing));
  const even = Math.ceil(Math.pow(2, k / INTERVALS) - 1e-9);
  const sizes = ladders.map((l) => Math.min(even, l.length));
  while (!fitsWithRoom(sizes, k)) {
    let cheapest = -1;
    for (let i = 0; i < INTERVALS; i++) {
      if (sizes[i] >= ladders[i].length) continue;
      if (cheapest < 0 || route.levels[i][ladders[i][sizes[i]]] < route.levels[cheapest][ladders[cheapest][sizes[cheapest]]]) cheapest = i;
    }
    if (cheapest < 0) return null;
    sizes[cheapest]++;
  }
  const sets = ladders.map((l, i) => l.slice(0, sizes[i]));
  return averagePower(law, sets, k) <= limit ? sets : null;
}

/** The set with the widest spacing, at least `least` noises, that still carries K bits. */
function widest(route, law, k, least, limit) {
  const noise = route.noiseAt(law, Math.sqrt(limit) / 32768);
  const build = (f) => quietest(route, law, k, f * noise, limit);
  let best = build(least);
  if (!best) return null;
  let low = least, high = 64 * least;
  for (let n = 0; n < 24; n++) {
    const mid = 0.5 * (low + high), sets = build(mid);
    if (sets) { best = sets; low = mid; } else high = mid;
  }
  return best;
}

/** Table 2's bounds: K 15..39, S 3..6, D 21..42. */
const K_RANGE = [15, 39], D_RANGE = [21, 42];
const largestK = (s) => Math.min(K_RANGE[1], D_RANGE[1] - s);
const maskOf = (set) => set.map(Number);

/**
 * What the analogue modem asks for, unshaped: the fastest data-mode set that
 * `enabled(drn)` allows and the route carries at SPACING inside the power limit,
 * and a training set (Table 17: K 6..24) twice as widely spaced, at no less than
 * half the data power if one does. Each is { drn, K, constellations: [6 Ucode
 * lists], intervalIndex: [0..5] }. Null if the route carries nothing.
 */
function choose(route, law, maxPower, enabled) {
  const limit = powerLimit(maxPower) ** 2;
  const s = 6;                                   // Sr 0: six sign bits, no shaping redundancy
  let data = null;
  for (let k = largestK(s); k >= D_RANGE[0] - s && !data; k--) {
    if (!enabled(k + s - 20)) continue;
    const sets = widest(route, law, k, SPACING, limit);
    if (sets) data = { K: k, drn: k + s - 20, sets };
  }
  if (!data) return null;
  const dataPower = averagePower(law, data.sets, data.K);
  let training = null;
  for (let k = 24; k >= 6 && !training; k--) {
    const sets = widest(route, law, k, 2 * SPACING, limit);
    if (sets && 2 * averagePower(law, sets, k) >= dataPower) training = { K: k, drn: k + s - 8, sets };
  }
  for (let k = 24; k >= 6 && !training; k--) {
    const sets = widest(route, law, k, 2 * SPACING, limit);
    if (sets) training = { K: k, drn: k + s - 8, sets };
  }
  if (!training) return null;
  const idx = [0, 1, 2, 3, 4, 5];
  return {
    data: { drn: data.drn, K: data.K, constellations: data.sets.map(maskOf), intervalIndex: idx },
    training: { drn: training.drn, K: training.K, constellations: training.sets.map(maskOf), intervalIndex: idx },
  };
}

module.exports = {
  INTERVALS, UCODES, H, PATTERN, LOUDEST, SPACING, POWER_LIMITS,
  linear, level, powerLimit, design, Analysis, Route, ladder, averagePower, quietest, widest, choose,
};
