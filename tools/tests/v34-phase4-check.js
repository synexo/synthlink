'use strict';
/**
 * v34-phase4-check — the MP sequence against Table 20/V.34 (Type 0).
 *
 * Checks the layout literally rather than only round-tripping it, because a
 * self-consistent encoder/decoder pair will happily agree on a WRONG layout. So:
 * assert the frame sync, assert every start bit the table names is a 0 at exactly
 * the position given, assert the documented field positions decode the values that
 * were encoded, assert the CRC's spec-defined coverage, and only then round-trip.
 *
 * Run: node tools/tests/v34-phase4-check.js
 */
const P = require('../../vendor/src/dsp/protocols/V34Phase4');
const { CONFIGS } = require('../../vendor/src/dsp/protocols/V34Mapper');

let fail = 0;
const ok = (cond, msg) => { if (!cond) { console.error('  FAIL:', msg); fail++; } };

const RATES = Object.values(CONFIGS).map(c => c.bitRate).sort((a, b) => a - b);

const mp = P.buildMP({
  callToAnswer: 33600, answerToCall: 19200,
  aux: false, trellis: 32, theta: true, expandedShaping: true,
  asymmetric: true, ack: false, rates: RATES,
});

// ── structure ───────────────────────────────────────────────────────────────
console.log(`MP length ${mp.length} bits (Table 20: 0:84 defined + 85:87 fill)`);
ok(mp.length === 88, `MP is 88 bits (got ${mp.length})`);
ok(mp.length % 8 === 0 && P.MP_BYTES === 11, 'MP packs into exactly 11 bytes');
ok(mp.slice(0, 17).every(b => b === 1), 'MP bits 0:16 are the 17-one frame sync');
for (const p of [17, 34, 51, 68]) ok(mp[p] === 0, `MP start bit at ${p} is 0`);
ok(mp.slice(85, 88).every(b => b === 0), 'MP bits 85:87 are the 000 fill');
ok(mp[19] === 0, 'MP bit 19 (reserved for ITU) is 0');
ok(mp.slice(52, 68).every(b => b === 0), 'MP bits 52:67 (reserved for ITU) are 0');
ok(mp[49] === 0, 'MP bit 49 (reserved for ITU) is 0');
console.log('MP start bits verified at 17, 34, 51, 68; reserved fields are 0');

// ── field positions decode what was encoded ─────────────────────────────────
ok(mp[18] === 0, 'MP bit 18 = 0 selects Type 0 (no precoder coefficients)');
ok(P.getUInt(mp, 20, 23) === 14, 'MP bits 20:23 carry N = 14 for call→answer');
ok(P.getUInt(mp, 24, 27) === 8, 'MP bits 24:27 carry N = 8 for answer→call');
ok(14 * 2400 === 33600 && 8 * 2400 === 19200, 'Table 20 rate = N·2400 in both directions');
ok(mp[28] === 0, 'MP bit 28 is the auxiliary-channel select');
ok(P.getUInt(mp, 29, 30) === 1, 'MP bits 29:30 = 1 selects the 32-state trellis');
ok(mp[31] === 1, 'MP bit 31 = 1 selects Θ = 0.3125');
ok(mp[32] === 1, 'MP bit 32 = 1 selects expanded shaping');
ok(mp[33] === 0, 'MP bit 33 clear — this is MP, not MP′');
ok(mp[50] === 1, 'MP bit 50 is the asymmetric-rate enable');

// Table 20's mask: bit 35 = 2400, bit 36 = 4800, … bit 48 = 33 600.
ok(P.MASK_LO === 35 && P.RATES.length === 14, 'capability mask is bits 35:48, fourteen rates');
ok(P.RATES[0] === 2400 && P.RATES[13] === 33600, 'mask spans 2400 … 33 600');
ok(mp[35 + 11] === 1, 'bit 46 (28 800) set — Table 20 names this bit explicitly');
ok(mp[35 + 12] === 1, 'bit 47 (31 200) set — Table 20 names this bit explicitly');
ok(mp[35 + 13] === 1, 'bit 48 (33 600) set — Table 20 names this bit explicitly');
ok(mp[35] === 0, 'bit 35 (2400) clear — we do not offer it');
console.log(`MP fields: 33600 call→answer, 19200 answer→call, 32-state, Θ=0.3125, expanded`);

// ── MP′ is MP with the acknowledge bit set, and nothing else ────────────────
const mpp = P.buildMP({
  callToAnswer: 33600, answerToCall: 19200,
  aux: false, trellis: 32, theta: true, expandedShaping: true,
  asymmetric: true, ack: true, rates: RATES,
});
const diff = [];
for (let i = 0; i < mp.length; i++) if (mp[i] !== mpp[i]) diff.push(i);
ok(mpp[33] === 1, 'MP′ has the acknowledge bit set');
ok(diff.includes(33), 'bit 33 is what distinguishes MP′ from MP');
ok(diff.every(i => i === 33 || (i >= 69 && i <= 84)),
   `only bit 33 and the CRC differ between MP and MP′ (got ${diff.join(',')})`);
console.log('MP′ = MP with bit 33 set (§10.1.3.9) — no other field moves');

// ── CRC coverage is §10.1.2.3.2's, not "everything" ─────────────────────────
const starts = new Set(P.MP_START_BITS);
const info = [];
for (let p = 18; p < 68; p++) if (!starts.has(p)) info.push(p);
let missed = 0;
for (const p of info) {
  const c = mp.slice(); c[p] ^= 1;
  if (P.parseMP(c).crcOk) missed++;
}
console.log(`MP CRC: ${info.length - missed}/${info.length} single-bit ` +
            `information-bit corruptions detected`);
ok(missed === 0, 'every single-bit corruption of an information bit is caught');
let coveredStart = 0;
for (const p of [34, 51]) { const c = mp.slice(); c[p] = 1; if (!P.parseMP(c).crcOk) coveredStart++; }
for (const p of [85, 86, 87]) { const c = mp.slice(); c[p] = 1; if (!P.parseMP(c).crcOk) coveredStart++; }
ok(coveredStart === 0, 'start and fill bits sit outside the CRC (§10.1.2.3.2/V.34)');
console.log('MP CRC coverage excludes frame sync, start and fill bits');

// ── round trip, including through the byte packing ──────────────────────────
const bytes = P.bitsToBytes(mp);
ok(bytes.length === 11, `MP packs to 11 bytes (got ${bytes.length})`);
const back = P.parseMPBytes(bytes);
ok(back.sync && back.crcOk, 'MP frame sync and CRC survive the byte packing');
ok(back.type === 0, 'MP type round-trips');
ok(back.callToAnswer === 33600 && back.answerToCall === 19200, 'both directional rates round-trip');
ok(back.trellis === 32, 'trellis selection round-trips as a state count');
ok(back.theta === 0.3125, 'Θ round-trips as its value, not its bit');
ok(back.expandedShaping === true && back.asymmetric === true && back.aux === false,
   'shaping, asymmetric and auxiliary flags round-trip');
ok(back.rates.join() === RATES.join(), `capability mask round-trips (${back.rates.join('/')})`);
console.log(`MP round trip: 88 bits → 11 bytes → exact`);

// ── the rate field's own constraint ─────────────────────────────────────────
// Table 20: "N is a 4-bit integer between 1 and 14". 36 000 would need N = 15.
let threw = false;
try { P.buildMP({ callToAnswer: 36000, answerToCall: 19200, rates: RATES }); } catch (e) { threw = true; }
ok(threw, 'a rate outside N·2400, N ∈ 1..14 is refused rather than truncated');
threw = false;
try { P.buildMP({ callToAnswer: 19200, answerToCall: 19200, trellis: 8, rates: RATES }); } catch (e) { threw = true; }
ok(threw, 'a trellis that is not 16/32/64 state is refused (bit pattern 3 is reserved)');

// Every rate this build actually offers must be expressible in the MP.
for (const r of RATES) ok(P.rateToN(r) * 2400 === r, `configured rate ${r} is N·2400`);
console.log(`MP rate field accepts every configured rate: ${RATES.join(', ')}`);


// ── §10.1.3.2 and §10.1.3.9 — the modulation that carries MP, E and V.90's CP ──
// The clauses, and only what they state. A round trip alone would pass on a wrong
// point set or a wrong bit order, exactly as it did for Figure 5 and Figure 2-1,
// so the point set and the bit order are asserted against the printed text first.
{
  const P3 = require('../../vendor/src/dsp/protocols/V34Phase3');
  const { quarterPoints } = require('../../vendor/src/dsp/protocols/V34Mapper');

  // §10.1.3.2 — "E is a 20-bit sequence of binary ones used to signal the end of MP."
  ok(P.E_BITS === 20, 'E is 20 bits');
  ok(P.eBits().length === 20 && P.eBits().every((b) => b === 1), 'E is binary ones');

  // §10.1.3.9 — "Integer 2 * Q2n + Q1n selects the point from the
  // quarter-superconstellation of Figure 5", so the point set is that quarter's
  // own first four, in §9.1's numbering, and not four points chosen here.
  const q4 = quarterPoints(4);
  ok(P.MP16_POINTS.length === 4, 'the 16-point form selects among four points');
  ok(P.MP16_POINTS.every((p, k) => p.i === q4[k].i && p.q === q4[k].q),
    'and they are Figure 5\'s quarter points 0 to 3, in §9.1 order');
  // Four base points × four rotations is the sixteen the clause names, and they
  // must be distinct or the demodulator cannot invert them.
  {
    const seen = new Set();
    for (const b of P.MP16_POINTS) for (let r = 0; r < 4; r++) {
      const p = P3.rotCW(b, r); seen.add(`${p.i},${p.q}`);
    }
    ok(seen.size === 16, 'the 16-point constellation has sixteen distinct points');
  }
  // The 4-point form "is generated as described in 10.1.3.3", which rotates point 0
  // alone — so its four symbols are exactly J's four.
  {
    const bits = [0, 0, 1, 0, 0, 1, 1, 1];        // In = 0, 1, 2, 3 in turn
    const syms = P.modulateParams(bits, 4, 0);
    const jenc = new P3.JEncoder(0);
    const want = [];
    for (let n = 0; n < bits.length; n += 2) want.push(jenc.symbol(bits[n], bits[n + 1]));
    ok(syms.every((s, k) => s.i === want[k].i && s.q === want[k].q),
      'the 4-point form is §10.1.3.3\'s chain, symbol for symbol');
  }
  // "In = 2 * I2n + I1n are differentially encoded to generate integer Zn as the
  // modulo 4 sum of In and Zn−1. Finally, the transmitted point is obtained by
  // clockwise rotation of the selected point by Zn * 90 degrees." Asserted as the
  // arithmetic, at every combination, rather than inferred from a round trip.
  for (let sel = 0; sel < 4; sel++) {
    for (let In = 0; In < 4; In++) {
      for (let z0 = 0; z0 < 4; z0++) {
        const bits = [In & 1, (In >> 1) & 1, sel & 1, (sel >> 1) & 1];   // I1 first in time
        const got = P.modulateParams(bits, 16, z0)[0];
        const want = P3.rotCW(P.MP16_POINTS[sel], (z0 + In) & 3);
        ok(got.i === want.i && got.q === want.q,
          `16-point: sel=${sel} In=${In} z0=${z0} rotates by (z0+In) mod 4`);
      }
    }
  }
  // I1n is "the first bit in time" in both forms — so swapping the first two bits
  // must change the symbol whenever I1 and I2 differ. Without this the bit order
  // is only pinned by the encoder agreeing with its own decoder.
  {
    const a = P.modulateParams([1, 0, 0, 0], 16, 0)[0];
    const b = P.modulateParams([0, 1, 0, 0], 16, 0)[0];
    ok(a.i !== b.i || a.q !== b.q, 'I1n and I2n are not interchangeable');
    ok(a.i === P3.rotCW(P.MP16_POINTS[0], 1).i, 'I1n = 1 alone gives In = 1');
    ok(b.i === P3.rotCW(P.MP16_POINTS[0], 2).i, 'I2n = 1 alone gives In = 2');
  }
  // Q1n likewise precedes Q2n: 2 * Q2n + Q1n.
  {
    const a = P.modulateParams([0, 0, 1, 0], 16, 0)[0];
    const b = P.modulateParams([0, 0, 0, 1], 16, 0)[0];
    ok(a.i === P.MP16_POINTS[1].i && a.q === P.MP16_POINTS[1].q, 'Q1n = 1 alone selects point 1');
    ok(b.i === P.MP16_POINTS[2].i && b.q === P.MP16_POINTS[2].q, 'Q2n = 1 alone selects point 2');
  }
  // A sequence that is not a whole number of symbol intervals is refused rather
  // than padded: MP's own fill bits are what make it come out even.
  {
    let threw = false;
    try { P.modulateParams([1, 0, 1], 16, 0); } catch (e) { threw = true; }
    ok(threw, 'a partial symbol interval is an error, not something to pad');
  }
  // Round trips, both forms, with the differential encoder started where
  // §10.1.3.9 starts it — "using the final symbol of the transmitted TRN sequence".
  for (const points of [4, 16]) {
    const per = P.MP_BITS_PER_SYMBOL[points];
    let x = 12345;
    const bits = Array.from({ length: per * 64 }, () => {
      x = (x * 1103515245 + 12345) & 0x7fffffff; return (x >> 16) & 1;
    });
    for (let z0 = 0; z0 < 4; z0++) {
      const syms = P.modulateParams(bits, points, z0);
      ok(syms.length === bits.length / per, `${points}-point: ${per} bits per 2D symbol interval`);
      ok(P.demodulateParams(syms, points, z0).join('') === bits.join(''),
        `${points}-point round trip from z0 = ${z0}`);
    }
    // Rotation-differential: a receiver that locked onto a rotated copy of the
    // whole sequence still recovers the I bits, which is the property the clause's
    // differential encoding exists for.
    const syms = P.modulateParams(bits, points, 0);
    const turned = syms.map((s) => P3.rotCW(s, 1));
    const back = P.demodulateParams(turned, points, 1);
    ok(back.filter((_, k) => points === 4 || k % per < 2).join('')
       === bits.filter((_, k) => points === 4 || k % per < 2).join(''),
      `${points}-point: the I bits survive a whole-sequence rotation`);
  }
  // An MP sequence, modulated. Table 20's Type 0 is 85 bits plus fill, and the
  // 4-point form takes two bits a symbol — so the fill V.90's Table 16 asks for
  // ("to extend the MP sequence length to the next multiple of 6 symbols") is what
  // makes a real sequence come out whole, and this is that arithmetic.
  {
    const mp = P.buildMP({ callToAnswer: 33600, answerToCall: 33600, rates: [33600], ack: false });
    const pad = (n, per, syms) => (per * syms - (n % (per * syms))) % (per * syms);
    for (const points of [4, 16]) {
      const per = P.MP_BITS_PER_SYMBOL[points];
      const bits = mp.concat(new Array(pad(mp.length, per, 6)).fill(0));
      const syms = P.modulateParams(bits, points, 0);
      ok(syms.length % 6 === 0, `a padded MP is a whole number of data frames (${points}-point)`);
      const back = P.demodulateParams(syms, points, 0).slice(0, mp.length);
      ok(P.parseMP(back).crcOk, `MP survives the ${points}-point modulation with its CRC intact`);
    }
  }
}

console.log(fail ? `\nFAILED (${fail})` : '\nv34-phase4-check OK');
process.exit(fail ? 1 : 0);
