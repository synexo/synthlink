#!/usr/bin/env node
'use strict';
// v34-viterbi-check — §9.6's trellis code, decoded, against our own encoder.
//
//   node tools/tests/v34-viterbi-check.js
//
// V34Viterbi is built from the transmitter's definitions (Figure 9's labels,
// Table 13, Figure 10, equation (9-32)'s U0 = Y0 ⊕ V0), so the encoder is the
// reference: random bits through V34Coder, Gaussian noise of a known σ in lattice
// units, then the decoder's points against the points sent. Not a round trip of
// the decoder against itself — the noise is what makes a wrong trellis visible:
// with no noise a decoder that ignored the code entirely would also be exact.
// The negative control takes V0 out of the branch parity; that decoder must err.
const M = require('../../vendor/src/dsp/protocols/V34Mapper');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok   ${m}`); } else { fail++; console.log(`  FAIL ${m}`); } };

function run(key, sigma, frames, mutate) {
  const cfg = M.makeConfig(M.RATE_CONFIGS[key]);
  const enc = new M.V34Coder(cfg), vit = new M.V34Viterbi(cfg.J, cfg.P);
  if (mutate) mutate(vit);
  let x = 99, g = 7;
  const bit = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x & 1; };
  const u = () => { g ^= g << 13; g >>>= 0; g ^= g >>> 17; g ^= g << 5; g >>>= 0; return (g + 0.5) / 4294967296; };
  const gauss = () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
  const sent = []; let hard = 0;
  for (let f = 0; f < frames; f++) {
    const high = cfg.isHighFrame(f), nb = high ? cfg.frameBitsHigh : cfg.frameBitsLow;
    const bits = []; for (let i = 0; i < nb; i++) bits.push(bit());
    for (const p of enc.encodeFrame(bits, high)) {
      sent.push(p);
      const r = [p.i + sigma * gauss(), p.q + sigma * gauss()];
      if (M.sliceOdd(r[0]) !== p.i || M.sliceOdd(r[1]) !== p.q) hard++;
      vit.push(r);
    }
  }
  let wrong = 0;
  for (let k = 0; k < vit.out.length; k++) if (vit.out[k].i !== sent[k].i || vit.out[k].q !== sent[k].q) wrong++;
  return { hard: hard / sent.length, vit: wrong / Math.max(1, vit.out.length), decided: vit.out.length, sent: sent.length };
}

console.log('\nexact, and late by exactly the traceback depth');
for (const key of ['33600/3429', '24000/3429', '28800/3200', '19200/2400']) {
  const r = run(key, 0, 400);
  ok(r.vit === 0 && r.decided === r.sent - 2 * M.VIT_DEPTH, `${key}: no noise, every point, ${2 * M.VIT_DEPTH} late`);
}

console.log('\nthe coding gain');
for (const key of ['33600/3429', '19200/2400']) {
  // Where the hard slicer errs on 1.7 % and 3.3 % of symbols, the decoder on none.
  for (const sigma of [0.38, 0.42]) {
    const r = run(key, sigma, 1500);
    ok(r.hard > 0.01 && r.vit === 0, `${key} σ=${sigma}: hard ${(r.hard * 100).toFixed(2)} %, Viterbi ${(r.vit * 100).toFixed(2)} %`);
  }
}

console.log('\nnegative control: the superframe inversion misplaced by one 4D symbol');
{
  const r = run('33600/3429', 0.25, 1500, (vit) => { vit.m = 1; });   // V0 read one 4D symbol out
  ok(r.vit > 0.01, `a decoder whose V0 is out of place errs (${(r.vit * 100).toFixed(1)} % of symbols)`);
}

console.log(`\nv34-viterbi-check: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
