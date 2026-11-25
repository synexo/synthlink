#!/usr/bin/env node
'use strict';
// tools/tests/echo-check.js — the echo canceller on its own, against a line
// whose echo is known exactly.
//
//   node tools/tests/echo-check.js
//
// What a call through the bridge cannot separate: whether the canceller learns
// the echo it was given, where it puts its taps, what it does with no echo at all
// (learns noise, so must be undone), and that held taps do not move while the far
// end talks. ERLE is 10·log10(echo power / residual power).

const path = require('path');
const { EchoCanceller } = require(path.join(__dirname, '..', '..', 'vendor', 'src', 'dsp', 'EchoCanceller'));

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log(`  ok   ${msg}`); } else { fail++; console.log(`  FAIL ${msg}`); } }

// A band-limited signal at 1800 Hz, the shape a V.32 transmitter puts out.
function signal(seed, N) {
  let s = seed >>> 0;
  const u = () => { s = (s * 1103515245 + 12345) >>> 0; return s / 4294967296 - 0.5; };
  const x = new Float64Array(N); let a = 0, b = 0;
  for (let n = 0; n < N; n++) {
    a = 0.7 * a + 0.3 * u(); b = 0.7 * b + 0.3 * u();
    x[n] = a * Math.cos(2 * Math.PI * 1800 * n / 8000) - b * Math.sin(2 * Math.PI * 1800 * n / 8000);
  }
  return { x };
}

// Transmit `lead` samples first, as a call sends S and S̄ (and V.34's PP) ahead of
// its TRN: a reflection 100 ms late can only be found against transmit history
// that exists. Train for `train` samples on our echo alone, then run `run` more with
// the far end talking, returning the ERLE over the run.
function line({ delay, gain, noise = 1e-4, lead = 1200, train = 3000, run = 4000, far = 0, echo = true }) {
  const N = lead + train + run, me = signal(1, N), them = signal(2, N);
  // Noise from its own generator, so a longer run trains on the same samples.
  let ns = 99; const nu = () => { ns = (ns * 1103515245 + 12345) >>> 0; return ns / 4294967296 - 0.5; };
  const ec = new EchoCanceller();
  let eh = 0, el = 0;
  train += lead;
  for (let n = 0; n < N; n++) {
    if (n === lead) ec.beginTraining();
    if (n === train) ec.endTraining();
    ec.sent(n, me.x[n]);
    const e = echo && n >= delay ? gain * me.x[n - delay] : 0;
    const f = n >= train ? far * them.x[n] : 0;
    const r = ec.process(n, e + f + noise * nu());
    if (n >= train) { eh += e * e; el += (r - f) ** 2; }
  }
  return { ec, erle: 10 * Math.log10(eh / Math.max(el, 1e-30)) };
}

console.log('[near echo, inside the first run]');
for (const delay of [0, 1, 40]) {
  const { ec, erle } = line({ delay, gain: 0.316 });
  ok(ec.kept && ec.farLag === null && erle > 40, `delay ${delay}: kept, no far run, ${erle.toFixed(1)} dB held under the far end`);
}

console.log('[a network reflection, beyond it]');
for (const delay of [200, 800]) {
  const { ec, erle } = line({ delay, gain: 0.316 });
  ok(ec.farLag !== null && ec.farLag <= delay && delay < ec.farLag + 64, `delay ${delay}: far run placed at ${ec.farLag}, score ${ec.farScore.toFixed(3)}`);
  ok(ec.kept && erle > 30, `delay ${delay}: ${erle.toFixed(1)} dB held under the far end`);
}

console.log('[no echo]');
{
  const { ec } = line({ delay: 0, gain: 0, echo: false, noise: 0.01 });
  ok(!ec.kept && ec.runs.length === 1 && ec.runs[0].w.every(v => v === 0), `training on noise alone is undone (${ec.trainedDb.toFixed(2)} dB removed)`);
}

console.log('[double talk: held taps do not move]');
{
  const a = line({ delay: 40, gain: 0.316, far: 0.3 });
  const w = Array.from(a.ec.runs[0].w);
  ok(a.erle > 40, `the far end talking over a held canceller: ${a.erle.toFixed(1)} dB`);
  // Running on with the far end talking changes nothing it learned.
  const b = line({ delay: 40, gain: 0.316, far: 0.3, run: 8000 });
  ok(b.ec.runs[0].w.every((v, k) => v === w[k]), 'taps identical after twice as long under double talk');
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
