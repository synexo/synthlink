#!/usr/bin/env node
'use strict';
// tools/tests/bridge-line-check.js — the bridge's line model, checked on its own.
//
//   node tools/tests/bridge-line-check.js
//
// DEVELOPMENT ONLY. Needs nothing built: it exercises tools/bridge/peer.js's
// pure parts — lineDirection (loss and noise, after BinModem's test `Line`) and
// the resampler (a far clock's ppm) — so that a receiver failing through the
// bridge is never a line model that is not what its options say.

const path = require('path');
const { lineDirection, lineFilter, resampler, VOICE_BAND_DB } = require(path.join(__dirname, '..', 'bridge', 'peer'));

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log(`  ok   ${msg}`); } else { fail++; console.log(`  FAIL ${msg}`); } }
const rms = a => Math.sqrt(a.reduce((t, x) => t + x * x, 0) / a.length);
const dB = x => 20 * Math.log10(x);

console.log('[loss]');
{
  const x = new Float32Array(8000).map((_, n) => 0.5 * Math.cos(2 * Math.PI * 1000 * n / 8000));
  for (const L of [0, 10, 30]) {
    const y = lineDirection({ lossDb: L })(x);
    const got = dB(rms(x)) - dB(rms(y));
    ok(Math.abs(got - L) < 0.01, `${L} dB loss measures ${got.toFixed(3)} dB`);
  }
}

console.log('[noise]');
{
  const z = new Float32Array(80000);
  for (const N of [20, 40, 60]) {
    const y = lineDirection({ noiseDb: N })(z);
    // The level is quoted in the voice band; the whole 4 kHz holds VOICE_BAND_DB more.
    const want = dB(Math.SQRT1_2) - N + VOICE_BAND_DB;
    const got = dB(rms(y));
    ok(Math.abs(got - want) < 0.1, `noiseDb ${N}: whole-band rms ${got.toFixed(2)} dBFS, want ${want.toFixed(2)}`);
  }
  const a = lineDirection({ noiseDb: 30, seed: 7 })(z), b = lineDirection({ noiseDb: 30, seed: 7 })(z);
  ok(a.every((v, k) => v === b[k]), 'the same seed is the same noise');
  const c = lineDirection({ noiseDb: 30, seed: 8 })(z);
  ok(!a.every((v, k) => v === c[k]), 'another seed is other noise');
  ok(lineDirection({})(z).every(v => v === 0), 'no options, no noise');
}

console.log('[resampler]');
{
  // A tone through ±100 ppm, fitted by least squares against the same tone time-
  // scaled; the error is everything the interpolator got wrong.
  for (const f of [500, 2000, 3400]) {
    const res = [];
    for (const r of [1.0001, 1 / 1.0001]) {
      const rs = resampler(r); let n = 0; const y = [];
      for (let b = 0; b < 200; b++) {
        const blk = new Float32Array(160);
        for (let i = 0; i < 160; i++, n++) blk[i] = Math.cos(2 * Math.PI * f * n / 8000);
        y.push(...rs(blk));
      }
      let worst = -Infinity;
      for (const w0 of [4000, 16000, 28000]) {
        const w = 2 * Math.PI * f / 8000; let cc = 0, ss = 0, cs = 0, yc = 0, ys = 0; const K = 400;
        for (let k = w0; k < w0 + K; k++) { const c = Math.cos(w * k * r), s = Math.sin(w * k * r); cc += c * c; ss += s * s; cs += c * s; yc += y[k] * c; ys += y[k] * s; }
        const det = cc * ss - cs * cs, A = (yc * ss - ys * cs) / det, B = (ys * cc - yc * cs) / det;
        let e = 0, p = 0;
        for (let k = w0; k < w0 + K; k++) { const m = A * Math.cos(w * k * r) + B * Math.sin(w * k * r); e += (y[k] - m) ** 2; p += m * m; }
        worst = Math.max(worst, 10 * Math.log10(e / p));
      }
      res.push(worst);
    }
    ok(res.every(v => v < (f > 3000 ? -70 : -80)), `${f} Hz at ±100 ppm: ${res.map(v => v.toFixed(1)).join(' / ')} dB`);
    ok(Math.abs(res[0] - res[1]) < 1, `${f} Hz: the two directions agree`);
  }
  ok(resampler(1)(new Float32Array([1, 2, 3])).join() === '1,2,3', 'ratio 1 passes straight through');
}

console.log('[dispersion]');
{
  // The filter measured back off its own taps: magnitude in dB and group delay in
  // ms at a frequency, the latter from the phase slope over ±1 Hz.
  const resp = (h, f) => { let re = 0, im = 0; for (let n = 0; n < h.length; n++) { re += h[n] * Math.cos(2 * Math.PI * f * n / 8000); im -= h[n] * Math.sin(2 * Math.PI * f * n / 8000); } return [Math.hypot(re, im), Math.atan2(im, re)]; };
  const dB = (h, f) => 20 * Math.log10(resp(h, f)[0]);
  const gd = (h, f) => { let d = resp(h, f + 1)[1] - resp(h, f - 1)[1]; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return -d / (4 * Math.PI) * 1000; };
  const flat = lineFilter({});
  ok([300, 600, 1700, 3000, 3400].every(f => Math.abs(dB(flat, f)) < 0.05), 'no distortion: flat to 0.05 dB from 300 to 3400 Hz');
  ok(Math.abs(dB(flat, 150) + 6) < 0.2 && Math.abs(dB(flat, 3800) + 6) < 0.2, `band edges at half amplitude: ${dB(flat, 150).toFixed(2)} / ${dB(flat, 3800).toFixed(2)} dB`);
  const narrow = lineFilter({ lowHz: 300, highHz: 3400 });
  ok(Math.abs(dB(narrow, 300) + 6) < 0.2 && Math.abs(dB(narrow, 3400) + 6) < 0.2 && dB(narrow, 3673) < -40, `a narrow line, 300–3400: ${dB(narrow, 3673).toFixed(0)} dB at 3673 Hz (S's upper line at 3429 baud)`);
  ok([600, 1700, 3000].every(f => Math.abs(gd(flat, f) - 16) < 0.01), 'no distortion: group delay a constant 16 ms');
  const d = lineFilter({ tiltDb: 8, edgeDelayMs: 1 });
  const tilt = dB(d, 600) - dB(d, 3000);
  ok(Math.abs(tilt - 8 * 2400 / 3100) < 0.3, `8 dB tilt: 600 to 3000 Hz falls ${tilt.toFixed(2)} dB, want ${(8 * 2400 / 3100).toFixed(2)}`);
  const rise = gd(d, 3400) - gd(d, 1700), lowRise = gd(d, 300) - gd(d, 1700);
  ok(Math.abs(rise - 1) < 0.2 && Math.abs(lowRise - 1) < 0.2, `1 ms edge delay: +${rise.toFixed(3)} ms at 3400, +${lowRise.toFixed(3)} ms at 300 over 1700 Hz`);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
