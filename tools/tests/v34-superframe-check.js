'use strict';
// tools/tests/v34-superframe-check.js — V.34's superframe synchronisation:
// Table 12's bit inversion patterns and equation (9-32), U0 = Y0 ⊕ C0 ⊕ V0.
//
//   node tools/tests/v34-superframe-check.js
//
// Not a round trip, on purpose: our receiver discards U0, so a loopback is green
// whatever V0 is. A real receiver is not — it finds the superframe by these
// inversions — so this holds the pattern at its printed digits and then reads the
// inversions back off the TRANSMITTED POINTS, re-deriving Y0 from those points with
// Figure 10's encoder, independently of the coder's own state.

const M = require('../../vendor/src/dsp/protocols/V34Mapper');
const { V34Coder, makeConfig, CONFIGS, T12, superframeV0, invRot } = M;
const { TABLE13, subsetLabel, conv16Next } = M._trellis;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log(`  FAIL ${m}`); } };

// ── 1. Table 12, literally ────────────────────────────────────────────────────
// "J = 8: 01 11 01 11 11 11 10 10; J = 7: 01 11 01 11 11 11 10" — one bit per half
// data frame, so the period is 2J.
ok(T12[8] === '01 11 01 11 11 11 10 10'.replace(/ /g, ''), 'Table 12 J=8 pattern');
ok(T12[7] === '01 11 01 11 11 11 10'.replace(/ /g, ''), 'Table 12 J=7 pattern');
ok(T12[8].length === 16 && T12[7].length === 14, '"The period … is 16 when J = 8, and 14 when J = 7"');

// ── 2. Where the inversions fall ──────────────────────────────────────────────
// §9.6.3: only at m a multiple of 2P. §10.1.3.1: B1 is the LAST data frame of a
// superframe, so m = 0 and m = 2P (B1's two halves) take the last two pattern
// bits, and m = 4P — the first data frame after B1 — takes the first.
for (const J of [7, 8]) {
  for (const P of [12, 14, 15, 16]) {
    let offBoundary = 0;
    for (let m = 0; m < 2 * P * 2 * J * 2; m++) if (m % (2 * P) && superframeV0(J, P, m)) offBoundary++;
    ok(offBoundary === 0, `J=${J} P=${P}: no inversion off a half-data-frame boundary`);
    const at = h => superframeV0(J, P, h * 2 * P);
    ok(at(0) === +T12[J][2 * J - 2] && at(1) === +T12[J][2 * J - 1],
       `J=${J} P=${P}: B1 carries the pattern's last two bits`);
    let seq = ''; for (let h = 2; h < 2 + 2 * J; h++) seq += at(h);
    ok(seq === T12[J], `J=${J} P=${P}: the superframe after B1 carries the pattern from its first bit`);
  }
}

// ── 3. On the wire ────────────────────────────────────────────────────────────
// Encode real frames from reset (B1's first mapping frame is i = 0), then for every
// 4D interval read U0 off the two transmitted points — the second is rotated by
// [Z + 2·I1 + U0]·90° relative to the first's Z — and Y0 off a Figure 10 encoder
// fed only with what was transmitted. Their XOR must be V0(m).
for (const name of Object.keys(CONFIGS)) {
  const cfg = makeConfig(CONFIGS[name]);
  const coder = new V34Coder(cfg);
  let rng = 0x2545f491;
  const rnd = () => { rng ^= rng << 13; rng ^= rng >>> 17; rng ^= rng << 5; return (rng >>> 0) & 1; };
  let conv = 0, m = 0, bad = 0, inversions = 0;
  const frames = cfg.P * cfg.J * 2;          // two superframes and more
  for (let i = 0; i < frames; i++) {
    const bits = Array.from({ length: cfg.bitsForFrame(i) }, rnd);
    const pts = coder.encodeFrame(bits, cfg.isHighFrame(i));
    let bp = cfg.isHighFrame(i) ? cfg.kShell : cfg.kShell - 1;
    for (let j = 0; j < 4; j++, m++) {
      const I1 = bits[bp]; bp += cfg.groupBits;
      const u0 = pts[2 * j], u1 = pts[2 * j + 1];
      const value = (invRot(u1).rot - invRot(u0).rot) & 3;   // 2·I1 + U0, mod 4
      const U0 = (value - 2 * I1) & 3;
      const Y0 = conv & 1;
      const y = TABLE13[subsetLabel(u0)][subsetLabel(u1)];
      conv = conv16Next(conv, y & 1, (y >> 1) & 1);
      if (U0 > 1 || (U0 ^ Y0) !== superframeV0(cfg.J, cfg.P, m)) bad++;
      if (superframeV0(cfg.J, cfg.P, m)) inversions++;
    }
  }
  ok(bad === 0, `${name}: U0 = Y0 ⊕ V0 at every 4D interval (${bad} wrong of ${m})`);
  ok(inversions > 0, `${name}: the run crossed inversion points (${inversions})`);
}

console.log(fail === 0 ? `v34-superframe-check: ${pass} passed, 0 failed` : `v34-superframe-check: ${pass} passed, ${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
