#!/usr/bin/env node
'use strict';
// tools/tests/v32bis-viterbi-check.js — V.32bis's Viterbi decoder against the
// transmitter's own encoder, through Gaussian noise of a known σ.
//
//   node tools/tests/v32bis-viterbi-check.js
//
// The NOISE is the point: with none, a decoder that ignored the code would also
// be exact. So the decoder is held against the slicer at noise where the slicer
// errs, and a negative control sends points from an encoder with one wire moved,
// which a decoder for THIS code must get wrong even at low noise. Then the same at
// each coded rate (7200, 9600, 12 000, 14 400), and each rate's figure against
// BinModem's own table of it.

const path = require('path');
const fs = require('fs');
const { V32bisViterbi, CODED, C128, TAB1, convEncode, slicePoint, IDX, INV1, VIT_DEPTH } =
  require(path.join(__dirname, '..', '..', 'vendor', 'src', 'dsp', 'protocols', 'V32bis'));

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log(`  ok   ${msg}`); } else { fail++; console.log(`  FAIL ${msg}`); } }

let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296; };
const gauss = () => { let u = 0; while (u === 0) u = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()); };

// The transmitter's chain: Table 1 then Figure 1 then Figure 2-1, as _dataSymbol has it.
function transmit(N, encode = convEncode) {
  const st = { a: 0, b: 0, c: 0 };
  let prevY = 0;
  const bits = [], pts = [];
  for (let n = 0; n < N; n++) {
    const q = [0, 0, 0, 0, 0, 0].map(() => (rnd() < 0.5 ? 1 : 0));
    prevY = TAB1[(q[0] << 1) | q[1]][prevY];
    const Y1 = (prevY >> 1) & 1, Y2 = prevY & 1;
    const Y0 = encode(st, Y1, Y2);
    pts.push(C128[(Y0 << 6) | (Y1 << 5) | (Y2 << 4) | (q[2] << 3) | (q[3] << 2) | (q[4] << 1) | q[5]]);
    bits.push(q);
  }
  return { bits, pts };
}

function errors(N, sigma, encode) {
  const { bits, pts } = transmit(N, encode);
  const vit = new V32bisViterbi(0);
  let prevY = 0, vErr = 0, hErr = 0, vN = 0;
  for (let n = 0; n < N; n++) {
    const x = pts[n].i + sigma * gauss(), y = pts[n].q + sigma * gauss();
    const out = vit.push(x, y);
    if (out) { const want = bits[n - VIT_DEPTH]; vN++; if (out.some((b, k) => b !== want[k])) vErr++; }
    const p = slicePoint(x, y), idx = IDX.get(p.i * 100 + p.q);
    const yNew = (idx >> 4) & 3, din = INV1[prevY][yNew]; prevY = yNew;
    const h = [(din >> 1) & 1, din & 1, (idx >> 3) & 1, (idx >> 2) & 1, (idx >> 1) & 1, idx & 1];
    if (h.some((b, k) => b !== bits[n][k])) hErr++;
  }
  return { v: vErr / vN, h: hErr / N };
}

console.log('[no noise]');
{
  const r = errors(4000, 0);
  ok(r.v === 0 && r.h === 0, `exact both ways (Viterbi ${r.v}, slicer ${r.h})`);
}

console.log('[noise: the slicer errs, Viterbi does not]');
// The points sit on the lattice Re+Im odd, nearest neighbours √2 apart, so the
// slicer's half-distance is 0.71. σ is per dimension, in lattice units.
for (const sigma of [0.3, 0.35, 0.4]) {
  const r = errors(20000, sigma);
  ok(r.h > 0.001 && r.v < r.h / 10, `σ ${sigma}: Viterbi ${(r.v * 100).toFixed(3)}% of symbols in error, slicer ${(r.h * 100).toFixed(2)}%`);
}

console.log('[negative control: another 8-state code]');
{
  // Figure 1 with T2's and T3's feedback swapped: a valid-looking trellis that is
  // not this one. Its points decode wrongly however clean they are.
  const other = (st, Y1, Y2) => {
    const Y0 = st.c, w = st.c ^ Y2;
    const na = st.c, nb = st.a ^ Y1 ^ Y2 ^ (st.b & w), nc = w ^ (Y1 & st.b);
    st.a = na; st.b = nb; st.c = nc; return Y0;
  };
  const r = errors(4000, 0.3, other);
  ok(r.v > 0.02, `points from another code: Viterbi errs on ${(r.v * 100).toFixed(1)}% (slicer ${(r.h * 100).toFixed(2)}%)`);
}

// ── Every coded rate: 7200, 9600, 12 000 and 14 400 ─────────────────────────
// The same chain on each rate's figure (CODED[rate].pts, at Figure 2-1's scale),
// the uncoded bits Q3 upwards, and against an exhaustive nearest-point slicer.
function transmitAt(t, N) {
  const st = { a: 0, b: 0, c: 0 };
  let prevY = 0;
  const bits = [], pts = [];
  for (let n = 0; n < N; n++) {
    const q = Array.from({ length: t.bits }, () => (rnd() < 0.5 ? 1 : 0));
    prevY = TAB1[(q[0] << 1) | q[1]][prevY];
    let idx = (convEncode(st, (prevY >> 1) & 1, prevY & 1) << 2) | prevY;
    for (let b = 2; b < t.bits; b++) idx = (idx << 1) | q[b];
    pts.push(t.pts[idx]); bits.push(q);
  }
  return { bits, pts };
}
function errorsAt(t, N, sigma) {
  const { bits, pts } = transmitAt(t, N);
  const vit = new V32bisViterbi(0, t);
  const U = t.bits - 2;
  let prevY = 0, vErr = 0, hErr = 0, vN = 0;
  for (let n = 0; n < N; n++) {
    const x = pts[n].i + sigma * gauss(), y = pts[n].q + sigma * gauss();
    const out = vit.push(x, y);
    if (out) { const want = bits[n - VIT_DEPTH]; vN++; if (out.length !== t.bits || out.some((b, k) => b !== want[k])) vErr++; }
    let idx = 0, bd = Infinity;
    t.pts.forEach((p, k) => { const d = (x - p.i) ** 2 + (y - p.q) ** 2; if (d < bd) { bd = d; idx = k; } });
    const yNew = (idx >> U) & 3, din = INV1[prevY][yNew]; prevY = yNew;
    const h = [(din >> 1) & 1, din & 1];
    for (let b = U - 1; b >= 0; b--) h.push((idx >> b) & 1);
    if (h.some((b, k) => b !== bits[n][k])) hErr++;
  }
  return { v: vErr / vN, h: hErr / N };
}
for (const rate of [7200, 9600, 12000, 14400]) {
  const t = CODED[rate];
  // σ a quarter of the nearest-neighbour distance, at transmit scale: half the way
  // to the slicer's decision boundary, where it errs on about a symbol in eight.
  let dmin = Infinity;
  for (const a of t.pts) for (const b of t.pts) if (a !== b) dmin = Math.min(dmin, Math.hypot(a.i - b.i, a.q - b.q));
  console.log(`[${rate}: ${t.pts.length} points, ${t.bits} bits a symbol]`);
  const r0 = errorsAt(t, 3000, 0);
  ok(r0.v === 0 && r0.h === 0, `${rate} exact without noise (Viterbi ${r0.v}, slicer ${r0.h})`);
  const r = errorsAt(t, 20000, 0.5 * dmin / 2);
  ok(r.h > 0.001 && r.v < r.h / 10, `${rate} σ at a quarter of the spacing: Viterbi ${(r.v * 100).toFixed(3)}%, slicer ${(r.h * 100).toFixed(2)}%`);
}

// ── The figures against BinModem's own tables ────────────────────────────────
// trellis.rs at the bridge's pinned commit, where cargo fetched it. Two readings
// of the Recommendation's drawn figures, made apart: they agree point for point
// or one of them is wrong. Skipped, and said so, when the source is not present.
{
  const os = require('os');
  const root = path.join(os.homedir(), '.cargo', 'git', 'checkouts');
  let src = null;
  try {
    for (const d of fs.readdirSync(root).filter((n) => n.startsWith('binmodem-'))) {
      for (const rev of fs.readdirSync(path.join(root, d))) {
        const f = path.join(root, d, rev, 'crates', 'datapump', 'src', 'v32', 'trellis.rs');
        if (rev.startsWith('623f935') && fs.existsSync(f)) src = fs.readFileSync(f, 'utf8');
      }
    }
  } catch { /* no cargo checkout */ }
  console.log('[the figures against BinModem trellis.rs]');
  if (!src) console.log('  SKIP BinModem source not fetched (build tools/bridge first)');
  else {
    for (const [rate, name] of [[7200, 'POINTS_16'], [9600, 'POINTS_32'], [12000, 'POINTS_64'], [14400, 'POINTS_128']]) {
      const m = src.match(new RegExp(`const ${name}: \\[\\(f64, f64\\); \\d+\\] = \\[([\\s\\S]*?)\\];`));
      const theirs = m ? [...m[1].matchAll(/\(\s*(-?[\d.]+),\s*(-?[\d.]+)\s*\)/g)].map((x) => [+x[1], +x[2]]) : [];
      const fig = CODED[rate].figure;
      const same = theirs.length === fig.length && fig.every((p, k) => p.i === theirs[k][0] && p.q === theirs[k][1]);
      ok(same, `${rate}: Figure ${{ 7200: '2-4', 9600: '2-3', 12000: '2-2', 14400: '2-1' }[rate]} is BinModem's ${name} (${theirs.length} points read)`);
    }
  }
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
