'use strict';
// tools/tests/v34-encoder-vector-check.js — V34Coder against BinModem's V.34
// data-mode encoder, point for point.
//
//   node tools/tests/v34-encoder-vector-check.js
//
// tools/tests/vectors/bm-v34-encoder.json was written by BinModem's encoder (see
// tools/bridge/examples/v34_encoder_vectors.rs, which names the rev): from B1
// (§10.1.3.1, every register at zero), a fixed bit source through clause 7's
// scrambler, then §9's parser, shell mapper, differential encoder, mapper, trellis
// and superframe inversions. Needs no Rust — the vector is data.
//
// Not a round trip, and that is the point. Our receiver discards U0, so a loopback
// is green with the trellis wrong; this was red with Figure 9's Im = +1 row
// transcribed with two entries swapped, which is exactly what it was. EXACT: these
// are lattice points, not samples. A mismatch is a disagreement between two
// readings of the Recommendation — read the clause, then decide which is wrong.

const fs = require('fs');
const path = require('path');
const { V34Coder, makeConfig, RATE_CONFIGS: CONFIGS } = require('../../vendor/src/dsp/protocols/V34Mapper');

const V = JSON.parse(fs.readFileSync(path.join(__dirname, 'vectors', 'bm-v34-encoder.json'), 'utf8'));
let pass = 0, fail = 0;

for (const c of V.cases) {
  const cfg = makeConfig(CONFIGS[c.config]);
  const coder = new V34Coder(cfg);
  // The generator's bit source: xorshift32, low bit.
  let x = parseInt(V.seed, 16) >>> 0;
  const src = () => { x = (x ^ (x << 13)) >>> 0; x = (x ^ (x >>> 17)) >>> 0; x = (x ^ (x << 5)) >>> 0; return x & 1; };
  // Clause 7: GPC = 1 + x⁻¹⁸ + x⁻²³ for the call modem, GPA = 1 + x⁻⁵ + x⁻²³ for
  // the answer modem, from zero at B1.
  const tap = c.scrambler === 'call' ? 17 : 4;
  const reg = new Array(23).fill(0);
  const scr = (b) => { const o = b ^ reg[tap] ^ reg[22]; reg.unshift(o); reg.pop(); return o; };
  const got = [];
  for (let i = 0; got.length < c.points.length; i++) {
    const high = cfg.isHighFrame(i);
    const bits = Array.from({ length: high ? cfg.frameBitsHigh : cfg.frameBitsLow }, () => scr(src()));
    for (const p of coder.encodeFrame(bits, high)) got.push([p.i, p.q]);
  }
  let first = -1;
  for (let k = 0; k < c.points.length; k++) {
    if (got[k][0] !== c.points[k][0] || got[k][1] !== c.points[k][1]) { first = k; break; }
  }
  if (first < 0) { pass++; console.log(`  ok   ${c.config} ${c.scrambler}: ${c.points.length} points identical`); }
  else {
    fail++;
    console.log(`  FAIL ${c.config} ${c.scrambler}: first difference at 2D symbol ${first} ` +
                `(4D interval ${first >> 1}) — ours ${JSON.stringify(got[first])}, BinModem ${JSON.stringify(c.points[first])}`);
  }
}
console.log(`\nv34-encoder-vector-check: ${pass} passed, ${fail} failed  [${V.source}]`);
process.exit(fail ? 1 : 0);
