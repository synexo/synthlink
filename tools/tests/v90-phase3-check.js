'use strict';
/**
 * v90-phase3-check — Jd and the DIL descriptor against Tables 13 and 12/V.90.
 *
 * The counterpart of v90-phase4-check, and for the same reason it gives: a
 * self-consistent encoder/decoder pair will happily agree on a WRONG layout, so
 * the literal positions are asserted before anything is round-tripped. Assert
 * the frame sync, assert every start bit the table names is a 0 at exactly the
 * position given, assert the documented fields decode what was encoded, and
 * only then round-trip.
 *
 * Table 12 earns extra scrutiny because its layout is VARIABLE: SP and TP are
 * 1..128 bits carried in 16-bit instalments, so every position after them moves
 * with α = ⌈L_SP/16⌉×17 and β = α + ⌈L_TP/16⌉×17. A fixed-position check would
 * pass for one pattern length and silently mis-place every field for another,
 * so the α/β arithmetic is checked against the clause and the field positions
 * are checked at more than one pattern length.
 *
 * Run: node tools/tests/v90-phase3-check.js
 */
const P3 = require('../../vendor/src/dsp/protocols/V90Phase3');
const BF = require('../../vendor/src/dsp/protocols/BitFrame');

let fail = 0;
const ok = (cond, msg) => { if (!cond) { console.error('  FAIL:', msg); fail++; } };

// ── U_INFO's bounds come from two different clauses ─────────────────────────
ok(P3.U_INFO_MIN === 67, 'Table 10/V.90: U_INFO shall be greater than 66');
ok(P3.U_INFO_MAX === 111, '§8.4.4: 16 + U_INFO must be a Ucode, so U_INFO ≤ 111');
ok(!P3.uInfoValid(66) && P3.uInfoValid(67), 'U_INFO 66 rejected, 67 accepted');
ok(P3.uInfoValid(111) && !P3.uInfoValid(112), 'U_INFO 111 accepted, 112 rejected');
ok(P3.sdWUcode(111) === 127, '§8.4.4: W = 16 + U_INFO, so U_INFO 111 ⇒ W = 127');
console.log('U_INFO ∈ [67, 111]; W = 16 + U_INFO');

// ── Table 13/V.90 — Jd ──────────────────────────────────────────────────────
const jd = P3.buildJd({ rates: [56000, 48000], cpConst: 1, rrConst: 0, lookahead: 3 });
ok(jd.length === 72, `Jd is 72 bits (got ${jd.length})`);
ok(jd.slice(0, 17).every((b) => b === 1), 'Jd bits 0:16 are the 17-one frame sync');
for (const p of [17, 34, 51]) ok(jd[p] === 0, `Jd start bit at ${p} is 0`);
for (const p of [68, 69, 70, 71]) ok(jd[p] === 0, `Jd fill bit at ${p} is 0`);
ok(jd[47] === 1, 'Jd bit 47 carries the CP/E/SCR constellation select');
ok(jd[48] === 0, 'Jd bit 48 carries the rate-renegotiation constellation select');
ok(BF.getUInt(jd, 49, 50) === 3, 'Jd bits 49:50 carry the lookahead');

// The printed ladder: "Bit 18: 28 000; bit 19: 29 333; bit 20: 30 666; …; bit
// 33: 48 000" then "bit 35: 49 333; bit 36: 50 666; …; bit 40: 56 000".
ok(P3.jdRate(0) === 28000 && P3.jdRateBit(0) === 18, 'bit 18 is 28 000');
ok(P3.jdRate(1) === 29333 && P3.jdRateBit(1) === 19, 'bit 19 is 29 333');
ok(P3.jdRate(2) === 30667 && P3.jdRateBit(2) === 20, 'bit 20 is 30 666 (4000/3 step)');
ok(P3.jdRate(15) === 48000 && P3.jdRateBit(15) === 33, 'bit 33 is 48 000');
ok(P3.jdRate(16) === 49333 && P3.jdRateBit(16) === 35, 'bit 35 is 49 333 — the start bit at 34 splits the ladder');
ok(P3.jdRate(21) === 56000 && P3.jdRateBit(21) === 40, 'bit 40 is 56 000');
ok(P3.JD_RATE_COUNT === 22, 'the ladder is 22 rates; bits 41:46 are reserved, not rates');
ok(jd[40] === 1 && jd[33] === 1, 'the two requested rates set bits 40 and 33');
ok(jd.slice(41, 47).every((b) => b === 0), 'Jd bits 41:46 stay 0 — reserved for ITU');

const jdBack = P3.parseJd(jd);
ok(jdBack.sync && jdBack.crcOk, 'Jd sync and CRC validate');
ok(jdBack.rates.join() === '48000,56000', 'Jd rate mask round-trips');
ok(jdBack.lookahead === 3 && jdBack.cpConst === 1, 'Jd fields round-trip');
console.log('Jd: 72 bits, sync + 3 start bits + 22-rate ladder + CRC + 4 fill');

// ── Table 12/V.90 — the DIL descriptor ──────────────────────────────────────
// §8.4.1: "α = ⌈L_SP/16⌉ × 17 and β = α + ⌈L_TP/16⌉ × 17".
ok(P3.dilAlpha(1) === 17 && P3.dilAlpha(16) === 17, 'α is 17 for L_SP 1..16');
ok(P3.dilAlpha(17) === 34, 'α is 34 for L_SP 17 — padded to the next multiple of 16');
ok(P3.dilAlpha(128) === 8 * 17, 'α is 136 at the maximum L_SP of 128');
ok(P3.dilBeta(16, 16) === 34, 'β = α + ⌈L_TP/16⌉×17');
ok(P3.dilBeta(17, 33) === 34 + 3 * 17, 'β follows both padded lengths');

function checkDescriptor(sp, tp, n) {
  const ref = Array.from({ length: 8 }, (_, c) => c * 16 + 8);
  const h = [1, 2, 3, 4, 5, 6, 7, 127];
  const ucodes = Array.from({ length: n }, (_, i) => 23 + (i * 5) % 100);
  const d = { n, sp, tp, h, ref, ucodes };
  const bits = P3.buildDIL(d);
  const beta = P3.dilBeta(sp.length, tp.length);
  const tag = `L_SP=${sp.length} L_TP=${tp.length} N=${n}`;

  ok(bits.length === P3.dilLength(sp.length, tp.length, n), `${tag}: length agrees with dilLength`);
  ok(bits.length % 2 === 0, `${tag}: descriptor has an even number of bits`);
  ok(bits.slice(0, 17).every((b) => b === 1), `${tag}: bits 0:16 are the 17-one frame sync`);

  // Start bits at the fixed head of the table, and at the β-relative positions.
  for (const p of [17, 34, 51]) ok(bits[p] === 0, `${tag}: start bit at ${p}`);
  for (const p of [51 + beta, 68 + beta, 85 + beta, 102 + beta,
                   119 + beta, 136 + beta, 153 + beta, 170 + beta, 187 + beta]) {
    ok(bits[p] === 0, `${tag}: start bit at ${p} (β-relative)`);
  }

  // Fixed fields.
  ok(BF.getUInt(bits, 18, 25) === n, `${tag}: bits 18:25 carry N`);
  ok(BF.getUInt(bits, 35, 41) === sp.length - 1, `${tag}: bits 35:41 carry L_SP − 1`);
  ok(BF.getUInt(bits, 43, 49) === tp.length - 1, `${tag}: bits 43:49 carry L_TP − 1`);
  ok(bits.slice(26, 34).every((b) => b === 0), `${tag}: bits 26:33 reserved, 0`);
  ok(bits[42] === 0 && bits[50] === 0, `${tag}: bits 42 and 50 reserved, 0`);

  // H1 at 52+β:58+β, H2 at 60+β:66+β, and the reserved bits between them.
  ok(BF.getUInt(bits, 52 + beta, 58 + beta) === h[0], `${tag}: H1 at 52+β:58+β`);
  ok(BF.getUInt(bits, 60 + beta, 66 + beta) === h[1], `${tag}: H2 at 60+β:66+β`);
  ok(BF.getUInt(bits, 111 + beta, 117 + beta) === h[7], `${tag}: H8 at 111+β:117+β`);
  ok(bits[59 + beta] === 0 && bits[67 + beta] === 0 && bits[118 + beta] === 0,
    `${tag}: the reserved bits between H values are 0`);
  // REF1 at 120+β:126+β … REF8 at 179+β:185+β.
  ok(BF.getUInt(bits, 120 + beta, 126 + beta) === ref[0], `${tag}: REF1 at 120+β:126+β`);
  ok(BF.getUInt(bits, 179 + beta, 185 + beta) === ref[7], `${tag}: REF8 at 179+β:185+β`);
  // The first two training Ucodes at 188+β and 196+β.
  if (n >= 2) {
    ok(BF.getUInt(bits, 188 + beta, 194 + beta) === ucodes[0], `${tag}: 1st DIL segment Ucode at 188+β`);
    ok(BF.getUInt(bits, 196 + beta, 202 + beta) === ucodes[1], `${tag}: 2nd DIL segment Ucode at 196+β`);
  }
  // CRC group at 187+β+⌈N/2⌉×17.
  const crcLo = 188 + beta + Math.ceil(n / 2) * 17;
  ok(bits[crcLo - 1] === 0, `${tag}: start bit before the CRC at ${crcLo - 1}`);

  const back = P3.parseDIL(bits);
  ok(back.sync && back.crcOk, `${tag}: sync and CRC validate`);
  ok(back.n === n, `${tag}: N round-trips`);
  ok(back.sp.join('') === sp.join(''), `${tag}: SP round-trips`);
  ok(back.tp.join('') === tp.join(''), `${tag}: TP round-trips`);
  ok(back.h.join() === h.join(), `${tag}: the eight H round-trip`);
  ok(back.ref.join() === ref.join(), `${tag}: the eight REF round-trip`);
  ok(back.ucodes.join() === ucodes.join(), `${tag}: the ${n} training Ucodes round-trip`);
  return back;
}

// Three pattern lengths, so a layout that only works when α and β happen to be
// 17 and 34 cannot pass: one inside a single instalment, one that forces SP to
// pad to a second, one at the clause's maximum.
checkDescriptor([1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0], [1, 0, 1, 1, 0, 1, 1], 32);
checkDescriptor(new Array(17).fill(1), new Array(3).fill(0), 7);
checkDescriptor(new Array(128).fill(1), new Array(128).fill(1), 255);
console.log('DIL descriptor: fixed head, α/β-relative H, REF and Ucode fields, CRC — at three pattern lengths');

// ── §8.4.1's segment arithmetic ─────────────────────────────────────────────
const d = checkDescriptor([1, 0], [1, 1, 0], 4);
const segs = P3.dilSegments(d);
ok(segs.length === 4, 'one segment per N');
for (const s of segs) {
  ok(s.length === (d.h[P3.uchordOf(s.ucode) - 1] + 1) * 6, `Lc = (Hc + 1) × 6 for chord ${s.chord}`);
  ok(s.length % 6 === 0, 'a segment is a whole number of six-symbol data frames');
}
// "The LSB of each pattern applies to the first symbol of a DIL-segment", and
// "0 shall represent REFc and 1 shall represent a training symbol".
const s0 = segs[0];
ok(s0.syms[0].sign === (d.sp[0] ? 1 : -1), 'SP bit 0 gives the first symbol its sign');
ok(s0.syms[0].ucode === (d.tp[0] ? s0.ucode : d.ref[s0.chord - 1]),
  'TP bit 0 chooses training symbol or REFc for the first symbol');
ok(s0.syms[d.sp.length].sign === (d.sp[0] ? 1 : -1), 'SP repeats inside a longer segment');
ok(segs[1].syms[0].sign === (d.sp[0] ? 1 : -1), 'the patterns restart at each segment boundary');
ok(P3.dilSymbolCount(d) === segs.reduce((t, s) => t + s.length, 0), 'dilSymbolCount agrees with the segments');
console.log('DIL segments: Lc = (Hc+1)×6, SP/TP restart per segment and repeat within one');

// ── TRN1d's own constraint ──────────────────────────────────────────────────
ok(P3.TRN1D_MIN_SYMBOLS === 2040, '§9.3.1.4: TRN1d is a minimum of 2040T');
ok(P3.TRN1D_MIN_SYMBOLS % 6 === 0, '§8.4.5: TRN1d is an integer multiple of 6 symbols');

console.log(fail ? `\nFAILED (${fail})` : '\nv90-phase3-check OK');
process.exit(fail ? 1 : 0);
