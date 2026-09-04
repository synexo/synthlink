'use strict';
/**
 * v90-phase4-check — the CP and MP sequences against Tables 14 and 16/V.90.
 *
 * Checks the layout literally rather than only round-tripping it, because a
 * self-consistent encoder/decoder pair will happily agree on a WRONG layout.
 * So: assert the frame sync, assert every start bit named by the table is a 0
 * at exactly the position given, assert the documented field positions decode
 * the values that were encoded, and only then round-trip.
 *
 * Run: node tools/tests/v90-phase4-check.js
 */
const P = require('../../vendor/src/dsp/protocols/V90Phase4');
const { defaultMask, maskFromUcodes, ucodesFromMask } = require('../../vendor/src/dsp/protocols/V90Mapper');

let fail = 0;
const ok = (cond, msg) => { if (!cond) { console.error('  FAIL:', msg); fail++; } };

// ── CP: structure ───────────────────────────────────────────────────────────
const mask = defaultMask();
const cp = P.buildCP({
  drn: 22, Sr: 3, ld: 1, ack: true, silent: false, aLaw: false,
  upstreamRates: [28800, 31200, 33600],
  coefs: { a1: 0, a2: 0, b1: -1, b2: 0 },
  trnRatio: 1,
  constellations: [mask], intervalIndex: [0, 0, 0, 0, 0, 0],
});
console.log(`CP length ${cp.length} bits for one constellation ` +
            `(136 fixed + 136 constellation + 17 CRC group + 3 fill)`);
ok(cp.length === 292, `CP is 292 bits with one constellation (got ${cp.length})`);
ok(cp.slice(0, 17).every(b => b === 1), 'CP bits 0:16 are the 17-one frame sync');
for (const p of [17, 34, 51, 68, 85, 102, 119, 136, 153, 170, 187, 204, 221, 238, 255, 272]) {
  ok(cp[p] === 0, `CP start bit at ${p} is 0`);
}
console.log('CP start bits verified at 17, 34, 51, 68, 85, 102, 119 and every 17 thereafter');

// ── CP: field positions decode what was encoded ─────────────────────────────
ok(cp[19] === 1, 'CP bit 19 = 1 marks CP (not CPt)');
ok(P.getUInt(cp, 20, 24) === 22, 'CP bits 20:24 carry drn = 22 (56000)');
ok(P.getUInt(cp, 31, 32) === 3, 'CP bits 31:32 carry Sr = 3');
ok(cp[33] === 1, 'CP bit 33 is the acknowledge bit');
ok(cp[35] === 0, 'CP bit 35 = 0 selects µ-law');
ok(P.getUInt(cp, 49, 50) === 1, 'CP bits 49:50 carry lₐ = 1');
ok(P.getQ1_6(cp, 86) === -1, 'CP bits 86:93 carry b₁ = −1 in signed Q1.6');
ok(P.getQ1_6(cp, 69) === 0, 'CP bits 69:76 carry a₁ = 0');
// rate mask: 28800/31200/33600 are the last three of the 13 rates
ok(cp[36 + 10] === 1 && cp[36 + 11] === 1 && cp[36 + 12] === 1, 'CP bits 36:48 mark 28800/31200/33600');
ok(cp[36] === 0, 'CP bit 36 (4800) is clear — we do not advertise it');
// drn → rate, per the table's own formula
const rate = (P.getUInt(cp, 20, 24) + 20) * 8000 / 6;
ok(rate === 56000, `drn 22 ⇒ (22+20)·8000/6 = ${rate}`);
console.log(`CP fields: drn=22 ⇒ ${rate} bit/s, Sr=3, lₐ=1, µ-law, b₁=−1`);

// ── CP: the Uchord masks land on the right Ucodes ───────────────────────────
// Chord 1 is Ucodes 0..15 at bits 137:152; chord 8 is 112..127 at 256:271.
const ucodes = ucodesFromMask(mask);
ok(!ucodes.includes(0) && ucodes.includes(127), 'default mask excludes Ucode 0, includes 127');
ok(cp[137 + 0] === 0, 'CP bit 137 (Ucode 0) clear — matches the default mask');
ok(cp[256 + 15] === 1, 'CP bit 271 (Ucode 127) set — matches the default mask');
ok(cp[137 + 5] === 0 && cp[171 + 5] === 1,
   'Ucode 5 clear (bit 142) and Ucode 37 set (bit 176) — chord boundaries line up');
console.log('CP Uchord masks: chord 1 ↔ Ucode 0 at bit 137, chord 8 ↔ Ucode 127 at bit 271');

// ── CP: round trip, including through the byte packing ──────────────────────
const bytes = P.bitsToBytes(cp);
const back = P.parseCP(P.bytesToBits(bytes, cp.length), 1);
ok(back.sync, 'CP frame sync survives the byte packing');
ok(back.crcOk, 'CP CRC validates');
ok(back.drn === 22 && back.Sr === 3 && back.ld === 1, 'CP scalar fields round-trip');
ok(back.aLaw === false && back.ack === true, 'CP codec and acknowledge bits round-trip');
ok(back.coefs.b1 === -1 && back.coefs.a1 === 0 && back.coefs.a2 === 0 && back.coefs.b2 === 0,
   'CP shaper coefficients round-trip');
ok(back.upstreamRates.join() === '28800,31200,33600', 'CP upstream capability mask round-trips');
ok(back.intervalIndex.join() === '0,0,0,0,0,0', 'CP interval→constellation indices round-trip');
ok(Buffer.compare(Buffer.from(back.constellations[0]), Buffer.from(mask)) === 0,
   'CP constellation mask round-trips bit-exact');
console.log(`CP round trip: ${cp.length} bits → ${bytes.length} bytes → exact`);

// ── CP: the CRC actually catches corruption ─────────────────────────────────
// §10.1.2.3.2/V.34 covers the information bits only — not the frame sync, the
// start bits or the fill. So the sweep runs over every information bit, and the
// start bits get the opposite assertion immediately below.
const cpStarts = new Set(P.cpStartBits(1));
const infoBits = [];
for (let p = 18; p < 272; p++) if (!cpStarts.has(p)) infoBits.push(p);
let missed = 0;
for (const p of infoBits) {
  const c = cp.slice();
  c[p] ^= 1;
  if (P.parseCP(c, 1).crcOk) missed++;
}
console.log(`CP CRC: ${infoBits.length - missed}/${infoBits.length} ` +
            `single-bit information-bit corruptions detected`);
ok(missed === 0, 'every single-bit corruption of an information bit is caught');

let coveredStart = 0;
for (const p of [34, 51, 68, 85, 102, 119, 136, 153, 170, 187, 204, 221, 238, 255]) {
  const c = cp.slice();
  c[p] = 1;
  if (!P.parseCP(c, 1).crcOk) coveredStart++;
}
ok(coveredStart === 0, 'start bits sit outside the CRC — setting one does not change it');
console.log('CP CRC coverage excludes frame sync, start and fill bits (§10.1.2.3.2/V.34)');

// ── CP: multiple constellations ─────────────────────────────────────────────
const m2 = maskFromUcodes(Array.from({ length: 64 }, (_, i) => i + 64));
const cp2 = P.buildCP({
  drn: 22, Sr: 3, ld: 2, ack: false, aLaw: false, upstreamRates: [33600],
  coefs: { a1: 0.5, a2: -0.25, b1: -1, b2: 0.125 }, trnRatio: 1.5,
  constellations: [mask, m2], intervalIndex: [0, 1, 0, 1, 0, 1],
});
ok(cp2.length === 292 + 136, `CP with two constellations is ${292 + 136} bits (got ${cp2.length})`);
const back2 = P.parseCP(cp2, 2);
ok(back2.crcOk, 'two-constellation CP CRC validates');
ok(back2.intervalIndex.join() === '0,1,0,1,0,1', 'per-interval constellation indices round-trip');
ok(Buffer.compare(Buffer.from(back2.constellations[1]), Buffer.from(m2)) === 0,
   'second constellation round-trips');
ok(back2.coefs.a1 === 0.5 && back2.coefs.a2 === -0.25 && back2.coefs.b2 === 0.125,
   'fractional Q1.6 coefficients round-trip');
ok(Math.abs(back2.trnRatio - 1.5) < 1e-4, 'Q3.13 TRN1d ratio round-trips');
console.log('CP: 2 constellations + alternating interval indices verified');

// ── MP ──────────────────────────────────────────────────────────────────────
const mp = P.buildMP({ drn: 14, ack: true, upstreamRates: [28800, 31200, 33600] });
console.log(`\nMP length ${mp.length} bits (Type 0, filled to a multiple of 6)`);
ok(mp.length % 6 === 0, 'MP length is a multiple of 6');
ok(mp.slice(0, 17).every(b => b === 1), 'MP bits 0:16 are the 17-one frame sync');
for (const p of [17, 34, 51, 68]) ok(mp[p] === 0, `MP start bit at ${p} is 0`);
ok(mp[18] === 0, 'MP bit 18 = 0 selects Type 0 (no precoder coefficients)');
ok(P.getUInt(mp, 24, 27) === 14, 'MP bits 24:27 carry drn = 14');
ok(14 * 2400 === 33600, 'drn 14 ⇒ 14·2400 = 33600 upstream');
ok(P.getUInt(mp, 29, 30) === 0, 'MP bits 29:30 select the 16-state trellis');
const mpBack = P.parseMP(P.bytesToBits(P.bitsToBytes(mp), mp.length));
ok(mpBack.crcOk, 'MP CRC validates');
ok(mpBack.drn === 14 && mpBack.ack === true, 'MP fields round-trip');
ok(mpBack.upstreamRates.join() === '28800,31200,33600', 'MP capability mask round-trips');
console.log(`MP fields: drn=14 ⇒ ${14 * 2400} bit/s upstream, 16-state trellis, Type 0`);

console.log(fail ? `\nFAILED (${fail})` : '\nv90-phase4-check OK');
process.exit(fail ? 1 : 0);
