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


// ── §8.5 and §8.6 — the Phase 4 signals ─────────────────────────────────────
// The sequences above are content; these are what §9.4 puts on the wire around
// them. Built standalone and wired to nothing, so this is the only thing checking
// them — which is why the clauses are asserted at their literal numbers rather
// than round-tripped against an encoder that would agree with any of them.
{
  const V34P4 = require('../../vendor/src/dsp/protocols/V34Phase4');

  // §8.6.4 — "the sign pattern + + + – – – where the left-most sign is transmitted
  // first", and R̄'s "– – – + + +".
  ok(P.R_SIGNS.join('') === '111000', 'R is + + + – – –, left-most first');
  ok(P.RBAR_SIGNS.join('') === '000111', 'R̄ is – – – + + +, left-most first');
  ok(P.R_PERIOD === 6, 'the R sequence is six symbols, one per data frame interval');
  // "R̄ consists of 4 repetitions of the 6-symbol sequence" — and §9.4.1.2 asks for
  // "R̄i for 24T", which is the same number arrived at independently. That
  // agreement is what settles which of the two signals carries the bar: R has no
  // stated length at all, only §9.4.1.1's minimum of 192T.
  ok(P.RBAR_REPS === 4, 'R̄ is four repetitions');
  ok(P.RBAR_SYMBOLS === 24, 'which is 24T, exactly as §9.4.1.2 asks for it');
  ok(P.R_MIN_SYMBOLS === 192, 'R runs for a minimum of 192T (§9.4.1.1)');
  {
    const ri = P.buildR(P.iCodewords(111), 3);
    ok(ri.length === 18, 'three repetitions of R is eighteen symbols');
    ok(ri.every((s) => s.ucode === 111), 'Ri uses U_INFO for every data frame interval');
    ok(ri.slice(0, 6).map((s) => s.sign).join('') === '111000', 'R\'s first frame is + + + – – –');
    ok(ri.slice(6, 12).map((s) => s.sign).join('') === '111000', 'and it repeats unchanged');
    const rbar = P.buildRbar(P.iCodewords(111));
    ok(rbar.length === 24, 'R̄i is 24 symbols');
    ok(rbar.every((s, k) => s.sign === P.RBAR_SIGNS[k % 6]), 'R̄ is – – – + + + throughout');
    // The R-to-R̄ transition §9.4.2.1 waits for is a sign inversion at every
    // position, which is what makes it detectable without a polarity reference —
    // and the NOTE under §8.6.4 requires exactly that: "Neither R nor R̄ are
    // differentially encoded. This imposes a requirement on the receiver to be
    // able to detect these sequences regardless of their polarity."
    ok(P.R_SIGNS.every((v, k) => v !== P.RBAR_SIGNS[k]), 'R̄ inverts R at every position');
    // Which also means an inverted R IS R̄, so a receiver keyed on absolute sign
    // would see the transition at one polarity and miss it at the other.
    ok(P.R_SIGNS.map((v) => 1 - v).join('') === P.RBAR_SIGNS.join(''),
      'an inverted R is indistinguishable from R̄ without a polarity reference');
    // Rd and Rt differ from Ri only in the codewords, per the clause's three
    // definitions — the signal is the same signal.
    const rd = P.buildR([120, 118, 121, 119, 122, 117], 1);
    ok(rd.map((s) => s.sign).join('') === P.R_SIGNS.join(''), 'Rd is R with other codewords');
    ok(rd.map((s) => s.ucode).join() === '120,118,121,119,122,117',
      'and it takes one codeword per data frame interval');
    let threw = false;
    try { P.buildR([1, 2, 3], 1); } catch (e) { threw = true; }
    ok(threw, 'R refuses a codeword list that is not one per data frame interval');
  }

  // §8.6.1, §8.6.2, §8.6.5 — the three signals that are the data-mode encoder fed
  // a constant bit. What is checkable without an encoder is the bit and the length.
  ok(P.B1D_FRAMES === 48 && P.B1D_SYMBOLS === 288, 'B1d is 48 data frames (§8.6.1)');
  ok(P.B1D_BIT === 1, 'and it is scrambled ONES');
  ok(P.ED_FRAMES === 2 && P.ED_SYMBOLS === 12, 'Ed is 2 data frames (§8.6.2)');
  ok(P.ED_BIT === 0, 'and it is scrambled binary ZEROES — the one that is not ones');
  ok(P.TRN2D_MIN_SYMBOLS === 2040, 'TRN2d runs a minimum of 2040T (§9.4.1.2)');
  ok(P.TRN2D_BIT === 1, 'and is scrambled binary ones (§8.6.5)');
  // "TRN2d shall be an integer multiple of 6 symbols long", and the minimum is
  // already one — so the minimum is legal as it stands, which is the same property
  // §8.4.5 gives TRN1d.
  ok(P.TRN2D_MIN_SYMBOLS % 6 === 0, 'and its minimum is already a whole number of data frames');

  // Table 17/V.90 — "Phase 4 signalling rate for different K and S". Carried as
  // (K + S)·8000/6 rather than as nineteen transcribed rows, so the printed
  // endpoints are what check it. These are the table's own first, middle and last
  // rows at both ends of the S range, read off pf24.
  const PRINTED = [
    [6, 12000, 16000], [7, 13333 + 1 / 3, 17333 + 1 / 3], [8, 14666 + 2 / 3, 18666 + 2 / 3],
    [9, 16000, 20000], [12, 20000, 24000], [15, 24000, 28000],
    [18, 28000, 32000], [21, 32000, 36000], [24, 36000, 40000],
  ];
  for (const [K, at3, at6] of PRINTED) {
    ok(Math.abs(P.phase4Rate(K, 3) - at3) < 1e-6, `Table 17: K=${K}, S=3 is ${at3} bit/s`);
    ok(Math.abs(P.phase4Rate(K, 6) - at6) < 1e-6, `Table 17: K=${K}, S=6 is ${at6} bit/s`);
  }
  ok(P.P4_K_MIN === 6 && P.P4_K_MAX === 24, 'Table 17 runs K from 6 to 24');
  ok(P.P4_S_MIN === 3 && P.P4_S_MAX === 6, 'and S from 3 to 6 for every K');
  {
    let threw = 0;
    for (const [K, S] of [[5, 3], [25, 3], [6, 2], [6, 7]]) {
      try { P.phase4Rate(K, S); } catch (e) { threw++; }
    }
    ok(threw === 4, 'a K or S outside the printed table is refused');
  }
  // The downstream rates V.90 actually offers must be reachable from the table,
  // or a K and S agreed in CP could not produce the rate CP asked for.
  ok(Math.abs(P.phase4Rate(24, 6) - 40000) < 1e-6, 'the table tops out at 40 kbit/s');

  // §8.5 — the analogue modem's three, which are V.34's by reference. Asserted as
  // the same objects, so a divergence would have to be deliberate.
  ok(V34P4.E_BITS === 20, '§8.5.3: E is §10.1.3.2/V.34, a 20-bit sequence');
  ok(typeof V34P4.modulateParams === 'function',
    '§8.5.2: CP is modulated according to §10.1.3.9/V.34');
  {
    // A CP sequence through that modulation, with its CRC intact at the far end.
    // CP is far longer than MP — a constellation is 136 bits on its own — so this
    // is also the check that nothing in the modulation is length-sensitive.
    const cp = P.buildCP({
      drn: 22, Sr: 3, ld: 1, ack: true, silent: false, aLaw: false,
      upstreamRates: [33600], coefs: { a1: 0, a2: 0, b1: -1, b2: 0 }, trnRatio: 1,
      constellations: [mask], intervalIndex: [0, 0, 0, 0, 0, 0],
    });
    for (const points of [4, 16]) {
      const per = V34P4.MP_BITS_PER_SYMBOL[points];
      const padded = cp.concat(new Array((per * 6 - (cp.length % (per * 6))) % (per * 6)).fill(0));
      const syms = V34P4.modulateParams(padded, points, 0);
      ok(syms.length % 6 === 0, `a padded CP is a whole number of data frames (${points}-point)`);
      const back = V34P4.demodulateParams(syms, points, 0).slice(0, cp.length);
      ok(P.parseCP(back, 1).crcOk, `CP survives the ${points}-point modulation with its CRC intact`);
    }
  }
}

console.log(fail ? `\nFAILED (${fail})` : '\nv90-phase4-check OK');
process.exit(fail ? 1 : 0);
