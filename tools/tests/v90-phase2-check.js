'use strict';
// §8.2/V.90's Phase 2 INFO sequences before any of them is on a wire: Tables 7, 8,
// 9 and 10 at their literal bit positions, through the same builder the wire sees.
//
// Same job as v90-phase3-check and v34-phase2-check, and written to fail on a
// MIS-TRANSCRIPTION rather than on a broken round trip — a sequence whose fields
// are all in the wrong place round-trips perfectly against itself.
//
// Two of the four tables are claimed by the Recommendation to be V.34's own
// (Table 8 reprints Table 14/V.34, Table 9 reprints Table 15/V.34) and those
// claims are checked here against the printed definitions rather than taken on
// trust, because "identical ... and given here for convenience" is exactly the
// sentence a transcription would be tempted to skip past.
//
//   node tools/tests/v90-phase2-check.js

const P2 = require('../../vendor/src/dsp/protocols/V34Phase2');
const V90P2 = require('../../vendor/src/dsp/protocols/V90Phase2');

let pass = 0, fail = 0;
function ok(cond, what) {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL ❌  ${what}`);
}
function eq(got, want, what) { ok(String(got) === String(want), `${what}: got ${got}, want ${want}`); }
function section(name) { console.log(`\n[${name}]`); }

// ── The printed tables, as ranges in the order they are printed ─────────────
// Transcribed from the converted V.90 source, pf15 (Table 7), pf16 (Table 8),
// pf17 (Table 9) and pf18 (Table 10), printed pp. 13, 14, 15 and 16.
const TABLE7 = [                                 // INFO0d
  ['fill', 0, 3], ['sync', 4, 11],
  ['rate2743', 12, 12], ['rate2800', 13, 13], ['rate3429', 14, 14],
  ['lowCarrier3000', 15, 15], ['highCarrier3000', 16, 16],
  ['lowCarrier3200', 17, 17], ['highCarrier3200', 18, 18],
  ['allow3429', 19, 19], ['canReducePower', 20, 20],
  ['maxRateDifference', 21, 23],
  ['cme', 24, 24], ['support1664', 25, 25],
  ['reserved26', 26, 27], ['ackInfo0', 28, 28],
  ['nominalPower', 29, 32], ['maxPower', 33, 37],
  ['powerAtCodec', 38, 38], ['aLaw', 39, 39],
  ['upstream3429', 40, 40], ['reserved41', 41, 41],
  ['crc', 42, 57], ['fill', 58, 61],
];
const TABLE10 = [                                // INFO1a when V.90 is selected
  ['fill', 0, 3], ['sync', 4, 11],
  ['reserved12', 12, 17],
  ['mdLength', 18, 24],
  ['uinfo', 25, 31],
  ['reserved32', 32, 33],
  ['upstreamSymbolRate', 34, 36],
  ['mode', 37, 39],
  ['frequencyOffset', 40, 49],
  ['crc', 50, 65], ['fill', 66, 69],
];

/**
 * A field occupies exactly the printed bits if setting it to all ones lights those
 * bits and no others — checked through `buildInfo`, which is what the wire sees,
 * rather than by reading the module's own table back to itself.
 */
function checkTable(spec, printed, label) {
  section(`${label} — every field at its printed bits`);
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
    const inField = moved.filter((i) => i < spec.crc[0] || i > spec.crc[1]);
    eq(`${inField[0]}:${inField[inField.length - 1]}`, `${lo}:${hi}`, `${label} ${name}`);
    eq(inField.length, width, `${label} ${name} is ${width} bits wide`);
    ok(moved.some((i) => i >= spec.crc[0] && i <= spec.crc[1]),
      `${label} ${name} is covered by the CRC`);
  }
  for (const [name, lo, hi] of printed.filter((r) => r[0] === 'fill')) {
    for (let i = lo; i <= hi; i++) eq(zero[i], 1, `${label} fill bit ${i}`);
  }
  const syncAt = printed.find((r) => r[0] === 'sync');
  eq(zero.slice(syncAt[1], syncAt[2] + 1).join(''), '01110010', `${label} frame sync`);
}
checkTable(V90P2.INFO0D, TABLE7, 'INFO0d');
checkTable(V90P2.INFO1A_V90, TABLE10, 'INFO1a(V.90)');

// ── Tables 8 and 9 — the two the Recommendation says are V.34's ─────────────
section('Table 8 / Table 9 — "identical to ... V.34"');
// Table 8/V.90 prints INFO0a's definition in full, and every line of it matches
// Table 14/V.34. Checked as the printed ranges, not as an object identity, so that
// the claim is tested rather than the wiring.
const TABLE8 = [
  ['fill', 0, 3], ['sync', 4, 11],
  ['rate2743', 12, 12], ['rate2800', 13, 13], ['rate3429', 14, 14],
  ['lowCarrier3000', 15, 15], ['highCarrier3000', 16, 16],
  ['lowCarrier3200', 17, 17], ['highCarrier3200', 18, 18],
  ['allow3429', 19, 19], ['canReducePower', 20, 20],
  ['maxRateDifference', 21, 23],
  ['cme', 24, 24], ['support1664', 25, 25],
  // 26:27 are "reserved for the ITU" here where Table 14/V.34 carries the transmit
  // clock source. Same two bits, same zero on this link, different prose — so the
  // V.34 field name is what the layout check has to use.
  ['txClockSource', 26, 27], ['ackInfo0', 28, 28],
  ['crc', 29, 44], ['fill', 45, 48],
];
checkTable(V90P2.INFO0A, TABLE8, 'INFO0a');
eq(V90P2.INFO0A.length, 49, 'INFO0a is 49 bits, as Table 8 prints it');
eq(V90P2.INFO1D.length, 109, 'INFO1d is 109 bits, as Table 9 prints it');
// Table 9's own rows, spot-checked at the boundaries a nine-bit-block table gets
// wrong: the first rate block, the last, and the offset field after them.
eq(`${V90P2.INFO1D.fields.mdLength}`, '18,24', 'INFO1d MD length is bits 18:24');
eq(`${V90P2.INFO1D.fields.highCarrier2400}`, '25,25', 'INFO1d 2400 block begins at bit 25');
eq(`${V90P2.INFO1D.fields.maxDataRate3429}`, '75,78', 'INFO1d 3429 projected rate is bits 75:78');
eq(`${V90P2.INFO1D.fields.frequencyOffset}`, '79,88', 'INFO1d frequency offset is bits 79:88');
eq(`${V90P2.INFO1D.crc}`, '89,104', 'INFO1d CRC is bits 89:104');

// ── Table 10's stated values ────────────────────────────────────────────────
section('Table 10 — the values the clause fixes');
// "Bits 37:39 represent the integer 6, indicating that V.90 operation is desired."
eq(V90P2.MODE_V90, 6, 'bits 37:39 ask for V.90 with the integer 6');
// §9.2.1.1.8 — "If bits 37:39 of INFO1a indicate an integer between 0 and 5, the
// digital modem shall proceed in accordance with 11.3.1.1/V.34". Those integers
// are V.34 symbol rate labels, so 6 must lie outside them and inside three bits.
ok(V90P2.MODE_V90 > 5 && V90P2.MODE_V90 <= 7, 'the V.90 integer is outside V.34\'s 0 to 5 and fits three bits');
eq(P2.SYMBOL_RATES.length, 6, 'V.34 labels exactly six symbol rates, 0 to 5');
// "UINFO shall be greater than 66."
ok(V90P2.UINFO_MIN > 66, 'UINFO\'s floor is above 66');
eq(V90P2.UINFO_MAX, 127, 'UINFO\'s ceiling is the field\'s own seven bits');
// "An integer between 3 and 5 gives the symbol rate, where 3 represents 3000 and 5
// represents 3429."
eq(P2.SYMBOL_RATES[V90P2.UPSTREAM_RATE_INDEX_MIN], 3000, 'upstream index 3 is 3000 baud');
eq(P2.SYMBOL_RATES[V90P2.UPSTREAM_RATE_INDEX_MAX], 3429, 'upstream index 5 is 3429 baud');
eq(P2.SYMBOL_RATES[4], 3200, 'upstream index 4 is 3200 baud');

// ── Round trip through the real CRC ─────────────────────────────────────────
section('§8.2.3.2 — build and parse through the CRC');
{
  const d = P2.buildInfo(V90P2.INFO0D, {
    rate3429: 1, allow3429: 1, support1664: 1, ackInfo0: 1,
    nominalPower: 6, maxPower: 25, powerAtCodec: 1, aLaw: 0, upstream3429: 1,
    maxRateDifference: 5,
  });
  const got = P2.parseInfo(V90P2.INFO0D, d);
  ok(got !== null, 'INFO0d parses');
  eq(got.nominalPower, 6, 'INFO0d nominal power survives');
  eq(got.maxPower, 25, 'INFO0d maximum power survives');
  eq(got.aLaw, 0, 'INFO0d codec law survives');
  eq(got.upstream3429, 1, 'INFO0d upstream 3429 survives');
  eq(got.ackInfo0, 1, 'INFO0d bit 28 survives');
  // One bit flipped anywhere the CRC covers must fail the CRC, which is what makes
  // a lost sequence a retransmission rather than a wrong parameter.
  for (const at of [12, 28, 33, 41]) {
    const bad = d.slice(); bad[at] ^= 1;
    ok(P2.parseInfo(V90P2.INFO0D, bad) === null, `INFO0d rejects a flip at bit ${at}`);
  }
}
{
  const a = P2.buildInfo(V90P2.INFO1A_V90, {
    mdLength: 0, uinfo: 111, upstreamSymbolRate: 5,
    mode: V90P2.MODE_V90, frequencyOffset: 0,
  });
  const got = P2.parseInfo(V90P2.INFO1A_V90, a);
  ok(got !== null, 'INFO1a(V.90) parses');
  eq(got.uinfo, 111, 'UINFO survives');
  eq(got.upstreamSymbolRate, 5, 'the upstream symbol rate survives');
  eq(got.mode, 6, 'the mode field survives as 6');
  // The offset field is two\'s complement, and −512 is its "ignore this" value.
  for (const v of [0, 511, -511, P2.OFFSET_UNKNOWN]) {
    const s = P2.buildInfo(V90P2.INFO1A_V90, { mode: 6, frequencyOffset: v });
    eq(P2.parseInfo(V90P2.INFO1A_V90, s).frequencyOffset, v, `offset ${v} survives`);
  }
}
{
  // A V.90 INFO1a and a V.34 INFO1a are both 70 bits with the same frame sync and
  // CRC placement, so a receiver that reads the wrong one gets a PASSING CRC and
  // silently wrong fields. Bits 37:39 are the only thing that separates them, and
  // §9.2.1.1.8 reads exactly those. This pins that they are distinguishable.
  const v90 = P2.buildInfo(V90P2.INFO1A_V90, { mode: V90P2.MODE_V90 });
  const v34 = P2.buildInfo(P2.INFO1A, { answerToCallSymbolRate: 5, callToAnswerSymbolRate: 5 });
  eq(v90.length, v34.length, 'both INFO1a sequences are the same length');
  ok(P2.parseInfo(P2.INFO1A, v90) !== null, 'a V.90 INFO1a passes the V.34 parser\'s CRC');
  eq(P2.parseInfo(P2.INFO1A, v90).callToAnswerSymbolRate, V90P2.MODE_V90,
    'and shows the mode integer where V.34 reads its call-to-answer rate');
  eq(P2.parseInfo(V90P2.INFO1A_V90, v34).mode, 5,
    'a V.34 INFO1a shows a mode below 6, which is §9.2.1.1.8\'s V.34 branch');
}

// ── §8.2.3.3 — INFOMARKS ────────────────────────────────────────────────────
section('§8.2.3.3 — INFOMARKSd and INFOMARKSa');
// "created by ... applying binary ones to the DPSK modulator described in 8.2.3.1",
// which is §10.1.2.3.1/V.34's modulator and the same signal V.34 §10.1.2.3.6 names.
{
  const marks = P2.infomarks(16);
  ok(marks.every((b) => b === 1), 'INFOMARKS is binary ones');
  const ph = P2.dpskPhases(marks, 0);
  ok(ph.every((p, i) => p === (i & 1)), 'every one rotates the point 180 degrees');
}

// ── §9.2 on the wire: negotiated, not agreed ────────────────────────────────
section('§9.2 — the procedure, and U_INFO carried rather than shared');
// The one thing a table check cannot see. U_INFO, the upstream symbol rate and MD's
// length were all values both ends read from the same constant, and such a value
// cannot be caught by any round trip: both ends agree however wrong it is. So the
// analogue modem is given a U_INFO that is NOT the default and the digital modem's
// §8.4.4 W is read back: it can only follow if the value crossed the wire.
//
// Driven synchronously, which is right here. This asserts that the procedure
// COMPLETES and what it carried; §11.2's timing under a real-time pump is
// v34-phase2-recovery's job and needs a different harness entirely.
{
  const { V90 } = require('../../vendor/src/dsp/protocols/V90');
  const P3 = require('../../vendor/src/dsp/protocols/V90Phase3');
  const run = (uinfo) => {
    const a = new V90('originate'), d = new V90('answer');
    a.setV8Complete(true); d.setV8Complete(true);     // the ANSam is Phase 1's
    if (uinfo !== undefined) { a._uInfo = uinfo; a._sdW = P3.sdWUcode(uinfo); }
    let n = 0;
    while (n < 8000 * 12 && !(a.up.phase2Complete && d.up.phase2Complete)) {
      d.receiveAudio(a.generateAudio(160));
      a.receiveAudio(d.generateAudio(160));
      n += 160;
    }
    return { a, d, secs: n / 8000 };
  };

  const { a, d, secs } = run(96);
  ok(a.up.phase2Complete && d.up.phase2Complete, `both modems complete Phase 2 (${secs.toFixed(2)} s of audio)`);
  eq(`${a.up.phase2TimedOut}`, '', 'the analogue modem fires no §9.2.2.2 recovery bound');
  eq(`${d.up.phase2TimedOut}`, '', 'the digital modem fires no §9.2.1.2 recovery bound');
  ok(!a.up.phase2Incomplete && !d.up.phase2Incomplete, 'both received the peer\'s INFO1');
  // §9.2.1.1.8's branch: the digital modem read bits 37:39 and saw V.90.
  eq(d.phase2Mode, V90P2.MODE_V90, 'the digital modem reads mode 6 out of INFO1a');
  eq(d.phase2ModeMismatch || 'none', 'none', 'and takes no exception to it');
  // The assertion this section exists for.
  eq(d._uInfo, 96, 'the digital modem uses the U_INFO the analogue modem asked for');
  eq(d._sdW, P3.sdWUcode(96), 'and §8.4.4\'s W follows it');
  ok(d._sdW !== P3.sdWUcode(111), 'which is not the value it would have used alone');
  // Table 10 bits 34:36 arrive as an index into V.34's labelling.
  eq(P2.SYMBOL_RATES[d.peerUpstreamSr], 3429, 'the upstream symbol rate arrives as 3429');

  // "UINFO shall be greater than 66." A request below the floor is refused rather
  // than used: the floor is what keeps Sd's zero-bearing discriminator
  // collision-free, so honouring an illegal one would break the receiver quietly.
  const { d: d2 } = run(12);
  eq(d2._uInfo, 111, 'an out-of-range UINFO leaves the digital modem on its default');
  ok(/outside Table 10/.test(d2.phase2ModeMismatch || ''), 'and is reported rather than absorbed');
}

console.log(`\n=== ${fail === 0 ? 'ALL PASS ✅' : 'FAILURES ❌'} === ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
