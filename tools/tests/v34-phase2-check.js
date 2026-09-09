'use strict';
// §10.1.2/V.34's Phase 2 signals before any of them is on a wire: Tables 14, 15
// and 16 at their literal bit positions, Table 17's probing tones at their literal
// frequencies and initial phases, §10.1.2.3.1's DPSK rule, §10.1.2.3.2's CRC over
// the coverage that clause defines, and §10.1.2.4's L1/L2 construction.
//
// Same job as v34-phase3-check and v32-startup-check: hold the transcription where
// a mis-transcription fails as a test rather than as a link that works only against
// itself. The probing signal is checked as a SIGNAL — its spectrum measured back
// out of the samples — because a table of 21 frequencies that is transcribed
// correctly and then synthesised wrongly looks identical to one that is not.
//
//   node tools/tests/v34-phase2-check.js

const P2 = require('../../vendor/src/dsp/protocols/V34Phase2');

let pass = 0, fail = 0;
function ok(cond, what) {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL ❌  ${what}`);
}
function eq(got, want, what) { ok(String(got) === String(want), `${what}: got ${got}, want ${want}`); }
function near(got, want, tol, what) { ok(Math.abs(got - want) <= tol, `${what}: got ${got}, want ${want} ±${tol}`); }
function section(name) { console.log(`\n[${name}]`); }

// ── §10.1.2.1 / §10.1.2.2 — the tones and their levels ──────────────────────
section('§10.1.2.1 / §10.1.2.2 — tones A and B');
eq(P2.TONE_A_HZ, 2400, 'tone A is 2400 Hz');
eq(P2.TONE_B_HZ, 1200, 'tone B is 1200 Hz');
eq(P2.GUARD_HZ, 1800, 'the guard tone is 1800 Hz');
{
  const a = P2.toneOf('answer'), b = P2.toneOf('originate');
  eq(a.name, 'A', 'the answer modem sends tone A');
  eq(b.name, 'B', 'the call modem sends tone B');
  ok(a.guardHz === 1800, 'tone A carries a guard tone');
  ok(b.guardHz === null, 'tone B carries no guard tone');
  // "Tone A is transmitted at 1 dB below the nominal transmit power while the
  // guard tone is transmitted at the nominal transmit power."
  near(20 * Math.log10(a.level), -1, 1e-9, 'tone A level in dB');
  near(20 * Math.log10(a.guardLevel), 0, 1e-9, 'tone A guard level in dB');
  near(20 * Math.log10(b.level), 0, 1e-9, 'tone B level in dB');
}
section('§10.1.2.3.1 — INFO carriers and levels');
{
  const a = P2.infoCarrierOf('answer'), c = P2.infoCarrierOf('originate');
  eq(a.hz, 2400, 'the answer modem sends INFO on 2400 Hz');
  eq(c.hz, 1200, 'the call modem sends INFO on 1200 Hz');
  near(20 * Math.log10(a.level), -1, 1e-9, 'answer INFO is 1 dB below nominal');
  near(20 * Math.log10(a.guardLevel), -7, 1e-9, 'answer INFO guard is 7 dB below nominal');
  near(20 * Math.log10(c.level), 0, 1e-9, 'call INFO is at nominal');
  eq(c.guardHz, null, 'the call modem sends no guard tone');
}
eq(P2.INFO_BIT_RATE, 600, '§10.1.2.3.1 INFO bit rate');

// ── §10.1.2.3.1 — the DPSK rule, stated both ways ───────────────────────────
section('§10.1.2.3.1 — binary DPSK');
// "The transmit point is rotated 180 degrees from the previous point if the
// transmit bit is a 1, and ... 0 degrees ... if the transmit bit is a 0."
eq(P2.dpskPhases([1], 0).join(','), '0,1', 'a 1 rotates 180° from the previous point');
eq(P2.dpskPhases([0], 0).join(','), '0,0', 'a 0 rotates 0° from the previous point');
eq(P2.dpskPhases([1], 1).join(','), '1,0', 'a 1 rotates 180° from the other phase too');
eq(P2.dpskPhases([1, 1, 1, 1], 0).join(','), '0,1,0,1,0', 'ones alternate the phase');
eq(P2.dpskPhases([0, 0, 0], 1).join(','), '1,1,1,1', 'zeros hold the phase');
// "Each INFO sequence is preceded by a point at an arbitrary carrier phase" — so
// the sequence is one longer than its bits, and the decode does not depend on
// which phase that point had.
{
  const bits = [1, 0, 1, 1, 0, 0, 0, 1, 1, 0];
  eq(P2.dpskPhases(bits, 0).length, bits.length + 1, 'a sequence is preceded by one point');
  for (const start of [0, 1]) {
    eq(P2.dpskBits(P2.dpskPhases(bits, start)).join(','), bits.join(','),
      `decodes the same from an arbitrary leading phase ${start}`);
  }
}
// §10.1.2.3.6: INFOMARKS is binary ones through that same modulator.
ok(P2.infomarks(6).every((b) => b === 1), '§10.1.2.3.6 INFOMARKS is binary ones');

// ── Tables 14, 15, 16 — the INFO sequences ──────────────────────────────────
// Transcribed as printed: the field name, its LSB:MSB range, and what the table
// says it means. The assertion is that the module writes each field at exactly
// those bits and nowhere else.
section('Table 14/V.34 — INFO0');
const TABLE14 = [
  ['fill', 0, 3], ['sync', 4, 11],
  ['rate2743', 12, 12], ['rate2800', 13, 13], ['rate3429', 14, 14],
  ['lowCarrier3000', 15, 15], ['highCarrier3000', 16, 16],
  ['lowCarrier3200', 17, 17], ['highCarrier3200', 18, 18],
  ['allow3429', 19, 19], ['canReducePower', 20, 20],
  ['maxRateDifference', 21, 23], ['cme', 24, 24], ['support1664', 25, 25],
  ['txClockSource', 26, 27], ['ackInfo0', 28, 28],
  ['crc', 29, 44], ['fill', 45, 48],
];
section('Table 15/V.34 — INFO1c');
const TABLE15 = [
  ['fill', 0, 3], ['sync', 4, 11],
  ['minPowerReduction', 12, 14], ['additionalPowerReduction', 15, 17],
  ['mdLength', 18, 24],
  ['highCarrier2400', 25, 25], ['preEmphasis2400', 26, 29], ['maxDataRate2400', 30, 33],
  ['highCarrier2743', 34, 34], ['preEmphasis2743', 35, 38], ['maxDataRate2743', 39, 42],
  ['highCarrier2800', 43, 43], ['preEmphasis2800', 44, 47], ['maxDataRate2800', 48, 51],
  ['highCarrier3000', 52, 52], ['preEmphasis3000', 53, 56], ['maxDataRate3000', 57, 60],
  ['highCarrier3200', 61, 61], ['preEmphasis3200', 62, 65], ['maxDataRate3200', 66, 69],
  ['highCarrier3429', 70, 70], ['preEmphasis3429', 71, 74], ['maxDataRate3429', 75, 78],
  ['frequencyOffset', 79, 88], ['crc', 89, 104], ['fill', 105, 108],
];
section('Table 16/V.34 — INFO1a');
const TABLE16 = [
  ['fill', 0, 3], ['sync', 4, 11],
  ['minPowerReduction', 12, 14], ['additionalPowerReduction', 15, 17],
  ['mdLength', 18, 24], ['highCarrier', 25, 25], ['preEmphasis', 26, 29],
  ['maxDataRate', 30, 33],
  ['answerToCallSymbolRate', 34, 36], ['callToAnswerSymbolRate', 37, 39],
  ['frequencyOffset', 40, 49], ['crc', 50, 65], ['fill', 66, 69],
];

/**
 * A field occupies exactly the printed bits if setting it to all ones lights those
 * bits and no others. That is a stronger check than reading the module's own table
 * back: it goes through buildInfo, which is what the wire sees.
 */
function checkTable(spec, printed, label) {
  section(`${label} — every field at its printed bits`);
  // The table must account for every bit of the sequence, with no gap and no
  // overlap: a field silently left out is the failure this catches.
  let next = 0;
  for (const [name, lo, hi] of printed) {
    eq(lo, next, `${label} ${name} begins where the previous field ended`);
    ok(hi >= lo, `${label} ${name} is a non-empty range`);
    next = hi + 1;
  }
  eq(next, spec.length, `${label} accounts for all ${spec.length} bits`);

  const zero = P2.buildInfo(spec, {});
  for (const [name, lo, hi] of printed) {
    if (name === 'fill' || name === 'sync' || name === 'crc') continue;
    const width = hi - lo + 1;
    const one = P2.buildInfo(spec, { [name]: (2 ** width) - 1 });
    const moved = [];
    for (let i = 0; i < spec.length; i++) if (one[i] !== zero[i]) moved.push(i);
    // The CRC moves too, which is the point of it; exclude that range.
    const inField = moved.filter((i) => i < spec.crc[0] || i > spec.crc[1]);
    eq(`${inField[0]}:${inField[inField.length - 1]}`, `${lo}:${hi}`, `${label} ${name}`);
    eq(inField.length, width, `${label} ${name} is ${width} bits wide`);
    ok(moved.some((i) => i >= spec.crc[0] && i <= spec.crc[1]), `${label} ${name} is covered by the CRC`);
  }
  // "Fill bits: 1111" and "Frame sync: 01110010, where the left-most bit is first
  // in time", at the positions the table gives them.
  for (const [name, lo, hi] of printed.filter((r) => r[0] === 'fill')) {
    for (let i = lo; i <= hi; i++) eq(zero[i], 1, `${label} fill bit ${i}`);
  }
  const syncAt = printed.find((r) => r[0] === 'sync');
  eq(zero.slice(syncAt[1], syncAt[2] + 1).join(''), '01110010', `${label} frame sync`);
}
checkTable(P2.INFO0, TABLE14, 'INFO0');
checkTable(P2.INFO1C, TABLE15, 'INFO1c');
checkTable(P2.INFO1A, TABLE16, 'INFO1a');

// ── §10.1.2.3.2 — the CRC ───────────────────────────────────────────────────
section('§10.1.2.3.2 — CRC coverage');
// "The CRC is formed by passing all of the information bits in a sequence, except
// the frame sync bits, the start bits, and the fill bits, through the CRC
// generator." INFO sequences have no start bits, so the coverage is exactly the
// span between the frame sync and the CRC.
for (const [spec, label] of [[P2.INFO0, 'INFO0'], [P2.INFO1C, 'INFO1c'], [P2.INFO1A, 'INFO1a']]) {
  eq(spec.covers[0], spec.sync[1] + 1, `${label} coverage begins after the frame sync`);
  eq(spec.covers[1], spec.crc[0] - 1, `${label} coverage ends before the CRC`);
  const base = P2.buildInfo(spec, {});
  // Flipping any covered bit must change the CRC; flipping a fill bit must not,
  // because the clause excludes it. Both directions, which is what makes this an
  // assertion about the coverage rather than about the polynomial.
  for (const i of [spec.covers[0], Math.floor((spec.covers[0] + spec.covers[1]) / 2), spec.covers[1]]) {
    const t = base.slice(); t[i] ^= 1;
    ok(P2.parseInfo(spec, t) === null, `${label}: flipping covered bit ${i} fails the CRC`);
  }
  for (const i of [spec.fill[0][0], spec.fill[1][0]]) {
    const t = base.slice(); t[i] ^= 1;
    const crcBefore = base.slice(spec.crc[0], spec.crc[1] + 1).join('');
    const rebuilt = P2.buildInfo(spec, {});
    eq(rebuilt.slice(spec.crc[0], spec.crc[1] + 1).join(''), crcBefore,
      `${label}: the CRC does not depend on fill bit ${i}`);
  }
  // The frame sync is excluded too, so a corrupted sync is a framing failure
  // rather than a CRC failure — parseInfo must reject it, and for that reason.
  const t = base.slice(); t[spec.sync[0]] ^= 1;
  ok(P2.parseInfo(spec, t) === null, `${label}: a corrupted frame sync is rejected`);
}

// ── Sequence durations at 600 bit/s ─────────────────────────────────────────
section('sequence durations at 600 bit/s');
for (const [spec, label, ms] of [[P2.INFO0, 'INFO0', 81.7], [P2.INFO1C, 'INFO1c', 181.7], [P2.INFO1A, 'INFO1a', 116.7]]) {
  near(spec.length / P2.INFO_BIT_RATE * 1000, ms, 0.1, `${label} is ${ms} ms`);
}

// ── §10.1.2.3.3 bits 21:23, Table 16 bits 34:39 — the symbol rate ladder ────
section('the symbol rate ladder');
// "With the symbol rates labelled in increasing order, where 0 represents 2400 and
// 5 represents 3429".
eq(P2.SYMBOL_RATES.join(','), '2400,2743,2800,3000,3200,3429', 'rates 0 through 5');
eq(P2.INFO1C_RATES.join(','), '2400,2743,2800,3000,3200,3429', 'Table 15 probes the same six');

// ── §10.1.2.4 / Table 17 — the probing signal ───────────────────────────────
section('Table 17/V.34 — probing tones, as printed');
const TABLE17 = [
  [150, 0], [300, 180], [450, 0], [600, 0], [750, 0],
  [1050, 0], [1350, 0], [1500, 0], [1650, 180], [1950, 0],
  [2100, 0], [2250, 180], [2550, 0], [2700, 180], [2850, 0],
  [3000, 180], [3150, 180], [3300, 180], [3450, 180], [3600, 0], [3750, 0],
];
eq(P2.PROBE_TONES.length, TABLE17.length, 'Table 17 has 21 rows');
for (let k = 0; k < TABLE17.length; k++) {
  eq(P2.PROBE_TONES[k][0], TABLE17[k][0], `Table 17 row ${k} frequency`);
  eq(P2.PROBE_TONES[k][1], TABLE17[k][1], `Table 17 row ${k} initial phase`);
}
// "spaced 150 Hz apart at frequencies from 150 Hz to 3750 Hz. Tones at 900 Hz,
// 1200 Hz, 1800 Hz, and 2400 Hz are omitted."
{
  const present = new Set(P2.PROBE_TONES.map(([f]) => f));
  for (let f = 150; f <= 3750; f += 150) {
    const omitted = [900, 1200, 1800, 2400].includes(f);
    eq(present.has(f), !omitted, `${f} Hz is ${omitted ? 'omitted' : 'present'}`);
  }
  eq(present.size, 21, '25 tones less the 4 omitted');
}
// "L1 is transmitted for 160 ms (24 repetitions)" — self-consistent at 150 Hz.
eq(P2.L1_MS, 160, 'L1 duration');
eq(P2.L1_REPETITIONS, 24, 'L1 repetitions');
near(P2.L1_REPETITIONS * 1000 / P2.PROBE_SPACING_HZ, P2.L1_MS, 1e-9, '24 repetitions at 150 Hz is 160 ms');
eq(P2.L2_MAX_MS, 550, 'L2 maximum duration');
// "at 6 dB above the nominal power level" / "at the nominal power level"
near(20 * Math.log10(P2.LEVEL.L1), 6, 1e-9, 'L1 is 6 dB above nominal');
near(20 * Math.log10(P2.LEVEL.L2), 0, 1e-9, 'L2 is at nominal');

section('§10.1.2.4 — the probe as a signal');
{
  const SR = 8000;
  // Periodic at 150 Hz. 8000/150 is 53.33, so an implementation that tiles a
  // rounded period fails this while still holding Table 17 correctly.
  const a = P2.probeSamples(SR, 160, 1, 0);
  const b = P2.probeSamples(SR, 160, 1, 160);          // 160 samples = 3 periods
  let worst = 0;
  for (let i = 0; i < 160; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
  ok(worst < 1e-9, `periodic at 150 Hz (worst sample difference ${worst.toExponential(1)})`);

  // The spectrum measured back out of the samples: every Table 17 tone present at
  // equal amplitude, every omitted one absent, and nothing between the bins. This
  // is what catches a correct table synthesised wrongly.
  const N = 1600;                                       // 200 ms = 30 whole periods
  const x = P2.probeSamples(SR, N, 1, 0);
  const mag = (f) => {
    let re = 0, im = 0;
    for (let n = 0; n < N; n++) {
      const w = 2 * Math.PI * f * n / SR;
      re += x[n] * Math.cos(w); im -= x[n] * Math.sin(w);
    }
    return Math.hypot(re, im) * 2 / N;
  };
  const present = P2.PROBE_TONES.map(([f]) => mag(f));
  const strongest = Math.max(...present), weakest = Math.min(...present);
  ok(weakest > 0.9 * strongest, `all 21 tones are within 1 dB of each other (${weakest.toFixed(4)}..${strongest.toFixed(4)})`);
  for (const f of [900, 1200, 1800, 2400]) {
    ok(mag(f) < 0.01 * weakest, `${f} Hz is absent from the transmitted probe`);
  }
  for (const f of [0, 75, 225, 3825, 3900]) {
    ok(mag(f) < 0.01 * weakest, `${f} Hz carries no energy`);
  }

  // The initial phases are Table 17's, read back out of the samples at t = 0.
  for (const [f, phi] of P2.PROBE_TONES) {
    let re = 0, im = 0;
    for (let n = 0; n < N; n++) {
      const w = 2 * Math.PI * f * n / SR;
      re += x[n] * Math.cos(w); im -= x[n] * Math.sin(w);
    }
    const deg = ((Math.atan2(-im, re) * 180 / Math.PI) + 360) % 360;
    const want = ((phi % 360) + 360) % 360;
    ok(Math.abs(((deg - want + 540) % 360) - 180) < 2, `${f} Hz starts at ${phi}° (measured ${deg.toFixed(1)}°)`);
  }

  // Levels: L1 six dB over L2, measured as RMS rather than asserted as a constant.
  const rms = (v) => { let s = 0; for (const y of v) s += y * y; return Math.sqrt(s / v.length); };
  const r1 = rms(P2.probeSamples(SR, 1600, P2.LEVEL.L1, 0));
  const r2 = rms(P2.probeSamples(SR, 1600, P2.LEVEL.L2, 0));
  near(20 * Math.log10(r1 / r2), 6, 0.01, 'L1 is 6 dB above L2 as transmitted');
}

console.log(`\n=== ${fail === 0 ? 'ALL PASS ✅' : 'FAILURES ❌'} === ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
