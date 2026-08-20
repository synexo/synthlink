'use strict';
/**
 * v90-shaper-check — the spectral shaper (§5.4.6 / Figure 2/V.90) in isolation.
 *
 * The shaper spends the Sr redundant sign bits to steer the transmitted spectrum.
 * Two things must hold, and they are independent:
 *
 *   A. **It costs no data.** For every trellis state, every legal rule and every
 *      data pattern, the emitted sign vector must map back to exactly one
 *      (rule, data) pair — otherwise the S data sign bits are unrecoverable.
 *      This is checked exhaustively for Sr = 1, 2 and 3 (Table 3 layouts).
 *
 *   B. **It actually shapes.** With the default coefficients (b₁ = −1, so
 *      y[n] = x[n] + x[n−1]) minimising the metric should suppress low-frequency
 *      energy. Measured against an unshaped (rule-A-always) control on the same
 *      data, via the DC/low-band energy of the emitted sequence.
 *
 * Run: node tools/v90-shaper-check.js
 */
const {
  ALLOWED, NEXT_STATE, applyRule, RULE_A, RULE_B, RULE_C, RULE_D,
  shapingLayout, ShaperFilter, quantCoef, DEFAULT_COEFS,
  makeConfig, buildConstellation, defaultMask, V90Coder, MAG,
} = require('../vendor/src/dsp/protocols/V90Mapper');

let fail = 0;
const ok = (cond, msg) => { if (!cond) { console.error('  FAIL:', msg); fail++; } };
const RULE_NAME = { [RULE_A]: 'A', [RULE_B]: 'B', [RULE_C]: 'C', [RULE_D]: 'D' };

// ── trellis sanity ──────────────────────────────────────────────────────────
ok(ALLOWED[0].join() === [RULE_A, RULE_B].join(), 'state 0 allows exactly {A,B}');
ok(ALLOWED[1].join() === [RULE_C, RULE_D].join(), 'state 1 allows exactly {C,D}');
ok(NEXT_STATE[RULE_A] === 0 && NEXT_STATE[RULE_B] === 1 &&
   NEXT_STATE[RULE_C] === 0 && NEXT_STATE[RULE_D] === 1, 'A→0 B→1 C→0 D→1');
console.log('trellis: state 0 → {A→0, B→1}; state 1 → {C→0, D→1}');

// rules must be involutions (so the receiver can un-apply by re-applying)
for (const w of [2, 3, 6]) {
  for (const rule of [RULE_A, RULE_B, RULE_C, RULE_D]) {
    for (let mask = 0; mask < (1 << w); mask++) {
      const v = Array.from({ length: w }, (_, k) => !!(mask & (1 << k)));
      const twice = applyRule(applyRule(v, rule), rule);
      ok(twice.join() === v.join(), `rule ${RULE_NAME[rule]} is an involution at width ${w}`);
    }
  }
}
console.log('rules: A/B/C/D are involutions at widths 2, 3 and 6');

// ── A. exhaustive bijection, per Table 3 layout ─────────────────────────────
for (const Sr of [1, 2, 3]) {
  const { width, dataPerFrame } = shapingLayout(Sr);
  for (const state of [0, 1]) {
    const seen = new Map();
    for (const rule of ALLOWED[state]) {
      for (let d = 0; d < (1 << dataPerFrame); d++) {
        const initial = new Array(width).fill(false);
        initial[0] = false;                                   // redundant position, init 0
        for (let k = 1; k < width; k++) initial[k] = !!(d & (1 << (k - 1)));
        const emitted = applyRule(initial, rule).map(b => (b ? 1 : 0)).join('');
        ok(!seen.has(emitted),
           `Sr=${Sr} state=${state}: ${emitted} collides ` +
           `(${RULE_NAME[rule]},${d}) with ${seen.get(emitted)}`);
        seen.set(emitted, `(${RULE_NAME[rule]},${d})`);

        // and the receiver's rule-recovery must pick the right rule back out
        const got = applyRule(initial, rule);
        const p0 = got[0];
        const guess = state === 0 ? (p0 ? RULE_B : RULE_A) : (p0 ? RULE_C : RULE_D);
        ok(guess === rule,
           `Sr=${Sr} state=${state}: recovered rule ${RULE_NAME[guess]} ≠ ${RULE_NAME[rule]}`);
        const undone = applyRule(got, guess);
        for (let k = 1; k < width; k++) {
          ok(undone[k] === initial[k], `Sr=${Sr} state=${state}: data bit ${k} recovered`);
        }
      }
    }
    const expect = ALLOWED[state].length * (1 << dataPerFrame);
    ok(seen.size === expect, `Sr=${Sr} state=${state}: ${seen.size} patterns, expected ${expect}`);
  }
  console.log(`Sr=${Sr}: ${Sr} shaping frame(s) × ${width} positions, ` +
              `${dataPerFrame} data bit(s) each — bijection exhaustively verified from both states`);
}

// ── coefficient quantisation (8-bit two's complement, 6 fractional bits) ────
ok(quantCoef(-1) === -1, 'b₁ = −1 survives quantisation');
ok(quantCoef(0.5) === 0.5, '0.5 survives quantisation');
ok(quantCoef(1 / 3) === Math.round(64 / 3) / 64, '1/3 quantises to the 6-fraction-bit grid');
console.log(`coefficients: default a₁=${DEFAULT_COEFS.a1} b₁=${DEFAULT_COEFS.b1} ` +
            `a₂=${DEFAULT_COEFS.a2} b₂=${DEFAULT_COEFS.b2} ⇒ y[n] = x[n] + x[n−1]`);

// ── B. does it actually shape? ──────────────────────────────────────────────
// Same random data through a shaped coder and an unshaped control (Sr=0-style:
// rule A always), comparing low-band energy of the emitted PCM sequence.
const cfg = makeConfig(56000);
const C = Array.from({ length: 6 }, () => buildConstellation(defaultMask()));

function emit(lookahead, forceRuleA) {
  const coder = new V90Coder(cfg, C, { lookahead });
  if (forceRuleA) {
    // control: disable the search, always take the first legal rule from state 0,
    // which is rule A (and from state 1, rule C) — i.e. no metric-driven choice.
    coder._branchCost = () => 0;
  }
  const out = [];
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let f = 0; f < 4000; f++) {
    const bits = Array.from({ length: cfg.D }, () => (rnd() < 0.5 ? 0 : 1));
    const syms = coder.encodeFrame(bits);
    if (syms) out.push(...syms);
  }
  for (const fr of coder.flush()) out.push(...fr);
  return out;
}

// energy in a low band, via a Goertzel-style magnitude at a few low bins
function bandEnergy(x, fLo, fHi) {
  const SR = 8000;
  let e = 0;
  for (let f = fLo; f <= fHi; f += 10) {
    let re = 0, im = 0;
    const w = 2 * Math.PI * f / SR;
    for (let n = 0; n < x.length; n++) { re += x[n] * Math.cos(w * n); im -= x[n] * Math.sin(w * n); }
    e += (re * re + im * im) / (x.length * x.length);
  }
  return e;
}

const shaped = emit(1, false);
const control = emit(1, true);
ok(shaped.length === control.length, 'shaped and control sequences are the same length');
const loS = bandEnergy(shaped, 0, 200), loC = bandEnergy(control, 0, 200);
const hiS = bandEnergy(shaped, 3000, 3800), hiC = bandEnergy(control, 3000, 3800);
console.log(`low band (0–200 Hz):    shaped ${loS.toExponential(3)}  vs  control ${loC.toExponential(3)}` +
            `   → ${(10 * Math.log10(loS / loC)).toFixed(1)} dB`);
console.log(`high band (3–3.8 kHz):  shaped ${hiS.toExponential(3)}  vs  control ${hiC.toExponential(3)}` +
            `   → ${(10 * Math.log10(hiS / hiC)).toFixed(1)} dB`);
ok(loS < loC, 'the shaper reduces low-frequency energy relative to the unshaped control');

console.log(fail ? `\nFAILED (${fail})` : '\nv90-shaper-check OK');
process.exit(fail ? 1 : 0);
