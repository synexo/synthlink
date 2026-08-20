'use strict';
/**
 * v90-ulaw-check — the µ-law codebook and the transport it has to survive.
 *
 * V.90's entire structure is built on the G.711 µ-law level set, so this is the
 * first thing that has to be exactly right. Checks:
 *   1. Ucode → magnitude matches G.711 µ-law decoding, is monotonic, and spans
 *      0..8031 with the expected per-segment step doubling.
 *   2. The µ-law octet round-trips (ucode,sign) → octet → (ucode,sign).
 *   3. Codewords survive the REAL transport quantisation used by server.js and
 *      public/main.js (Float32 → Int16 → Float32) and slice back exactly.
 *
 * Run: node tools/v90-ulaw-check.js
 */
const {
  UCODES, MAG, ucodeMagnitude, ulawOctet, toFloat, fromFloat,
  defaultMask, buildConstellation, sliceLevel, averagePower, DEFAULT_UCODE_MIN,
} = require('../vendor/src/dsp/protocols/V90Mapper');

let fail = 0;
const ok = (cond, msg) => { if (!cond) { console.error('  FAIL:', msg); fail++; } };

// ── 1. codebook ─────────────────────────────────────────────────────────────
ok(MAG[0] === 0, 'ucode 0 magnitude is 0');
ok(MAG[127] === 8031, `ucode 127 magnitude is 8031 (got ${MAG[127]})`);
for (let u = 1; u < UCODES; u++) ok(MAG[u] > MAG[u - 1], `magnitude monotonic at u=${u}`);
// step doubles per segment: inside segment s the step is 2^(s+1)
for (let seg = 0; seg < 8; seg++) {
  const base = seg * 16;
  const step = MAG[base + 1] - MAG[base];
  ok(step === 2 ** (seg + 1), `segment ${seg} step is ${2 ** (seg + 1)} (got ${step})`);
}
// independent reference implementation of G.711 µ-law expansion
function refExpand(u) {
  const seg = u >> 4, man = u & 15;
  let v = ((man * 2) + 33) * (1 << seg) - 33;
  return v;
}
for (let u = 0; u < UCODES; u++) ok(MAG[u] === refExpand(u), `ucode ${u} matches reference expansion`);
console.log(`µ-law codebook: 128 ucodes, magnitudes ${MAG[0]}..${MAG[127]}, min step ${MAG[1] - MAG[0]}`);

// ── 2. octet round trip ─────────────────────────────────────────────────────
for (let u = 0; u < UCODES; u++) for (const pos of [true, false]) {
  const oct = ulawOctet(u, pos);
  const inv = (~oct) & 0xff;
  ok((inv & 0x7f) === u, `octet magnitude field round-trips for u=${u}`);
  ok(!!(inv & 0x80) === pos, `octet sign field round-trips for u=${u} pos=${pos}`);
}
console.log('µ-law octet: (ucode,sign) → octet → (ucode,sign) exact for all 256');

// ── 3. transport survival ───────────────────────────────────────────────────
// Exactly the helpers in server.js / public/main.js.
const f2i = f => { const s = Math.max(-1, Math.min(1, f)); return (s * 32767) | 0; };
const i2f = k => k / 32768;

const C = buildConstellation(defaultMask());
console.log(`default constellation: M=${C.M} (ucodes ${DEFAULT_UCODE_MIN}..127), ` +
            `min magnitude ${MAG[DEFAULT_UCODE_MIN]}, avg power ${averagePower(C).toExponential(3)}`);

let worstErr = 0, sliceErrors = 0;
for (const u of C.members) for (const pos of [true, false]) {
  const signed = pos ? MAG[u] : -MAG[u];
  const f = toFloat(signed);
  ok(Math.abs(f) <= 1, `ucode ${u} stays inside full scale (${f.toFixed(4)})`);
  const recovered = fromFloat(i2f(f2i(f)));               // through the wire
  worstErr = Math.max(worstErr, Math.abs(recovered - signed));
  const s = sliceLevel(C, recovered);
  if (C.labelToUcode[s.label] !== u || s.positive !== pos) sliceErrors++;
}
console.log(`transport round trip: worst level error ${worstErr} (14-bit scale), ` +
            `slice errors ${sliceErrors}/${C.M * 2}`);
ok(sliceErrors === 0, 'every legal codeword survives the transport and slices back exactly');

// margin: the smallest gap between adjacent legal levels vs the worst error
let minGap = Infinity;
for (let i = 1; i < C.ascMag.length; i++) minGap = Math.min(minGap, C.ascMag[i].mag - C.ascMag[i - 1].mag);
console.log(`level spacing margin: min gap ${minGap} vs worst transport error ${worstErr} ` +
            `(${(minGap / 2 / Math.max(worstErr, 1)).toFixed(1)}× the slicing threshold)`);
ok(minGap / 2 > worstErr, 'half the minimum level gap exceeds the worst transport error');

console.log(fail ? `\nFAILED (${fail})` : '\nv90-ulaw-check OK');
process.exit(fail ? 1 : 0);
