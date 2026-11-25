#!/usr/bin/env node
'use strict';
// tools/tests/v34-mean-energy-check.js — V34Mapper's MEAN_E_TABLE against the
// computation it stands in for (meanEnergyComputed), every configuration.
//
//   node tools/tests/v34-mean-energy-check.js
//
// The mean energy of a data configuration (the scale §10.1.3's NOTE ties to
// training power) takes about 90 ms to compute, and a call's first rate estimate
// walks every rung of the ladder: 1.5 s of CPU inside half a second of a browser's
// audio. So it is a table, and this holds the table to what it replaced, value for
// value, and asserts that every configuration has an entry.

const path = require('path');
const M = require(path.join(__dirname, '..', '..', 'vendor', 'src', 'dsp', 'protocols', 'V34Mapper'));

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log(`  ok   ${msg}`); } else { fail++; console.log(`  FAIL ${msg}`); } }

for (const key of Object.keys(M.RATE_CONFIGS)) {
  const cfg = M.makeConfig(M.RATE_CONFIGS[key]);
  const t = M.MEAN_E_TABLE[key], c = M.meanEnergyComputed(cfg);
  ok(t === c, `${key}: table ${t} is the computation's ${c}`);
}
ok(Object.keys(M.MEAN_E_TABLE).length === Object.keys(M.RATE_CONFIGS).length, 'one entry for every configuration, and no more');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
