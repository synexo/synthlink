'use strict';
// Table 1/V.32 and Table 3/V.32 against the map V32.js actually transmits.
//
// Why this exists. The shipping data path diverged from both tables and had done
// since it was written, in two independent ways: the differential quadrant change
// was a plain modulo-4 addition of the dibit where Table 1 transposes 00 and 01,
// and the Q3Q4 base row had its middle two entries swapped against Table 3. Both
// round-tripped perfectly, because the receiver inverted the transmitter — which
// is the third time in this repository a map has been wrong in a way that only a
// printed table could see (V.32bis Figure 2-1 and V.34 Figure 5 were the others).
//
// So the assertions here are deliberately NOT round-trip assertions. A round trip
// passes on a shuffled map; only the tables can fail it. The round trip is checked
// too, at the end, because an inverse that stops matching is a different bug.
//
// It drives V32.js's own exported dataPoint/dataBits and the Table 1 tables in
// V32Startup.js, not copies of them: rename or re-index either and this throws
// rather than testing something that is no longer on the wire.
//
//   node tools/tests/v32-map-check.js

const { BASE, dataPoint, dataBits } = require('../../vendor/src/dsp/protocols/V32');
const V32S = require('../../vendor/src/dsp/protocols/V32Startup');

let pass = 0, fail = 0;
function ok(cond, what) {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL ❌  ${what}`);
}
function eq(got, want, what) { ok(String(got) === String(want), `${what}: got ${got}, want ${want}`); }
function section(name) { console.log(`\n[${name}]`); }

// ── Table 3/V.32, non-redundant column, transcribed as printed ──────────────
// "The two alternative signal-state mappings for 9600 bit/s", coded inputs
// Y1 Y2 Q3 Q4 → Re, Im. Only the non-redundant column is used here; the trellis
// column belongs to the 32-point mode this build does not implement.
const TABLE3 = {
  '0000': [-1, -1], '0001': [-3, -1], '0010': [-1, -3], '0011': [-3, -3],
  '0100': [1, -1], '0101': [1, -3], '0110': [3, -1], '0111': [3, -3],
  '1000': [-1, 1], '1001': [-1, 3], '1010': [-3, 1], '1011': [-3, 3],
  '1100': [1, 1], '1101': [3, 1], '1110': [1, 3], '1111': [3, 3],
};

// ── Table 1/V.32, transcribed as printed ────────────────────────────────────
// "Differential quadrant coding for 4800 bit/s and for nonredundant coding at
// 9600 bit/s" — the title is what says this table governs the data path here and
// not only the rate signals. Columns: Q1n Q2n | Y1n-1 Y2n-1 | phase quadrant
// change | Y1n Y2n | signal state for 4800 bit/s.
const TABLE1 = [
  ['00', '00', '+90', '01', 'B'], ['00', '01', '', '11', 'C'],
  ['00', '10', '', '00', 'A'], ['00', '11', '', '10', 'D'],
  ['01', '00', '0', '00', 'A'], ['01', '01', '', '01', 'B'],
  ['01', '10', '', '10', 'D'], ['01', '11', '', '11', 'C'],
  ['10', '00', '+180', '11', 'C'], ['10', '01', '', '10', 'D'],
  ['10', '10', '', '01', 'B'], ['10', '11', '', '00', 'A'],
  ['11', '00', '+270', '10', 'D'], ['11', '01', '', '00', 'A'],
  ['11', '10', '', '11', 'C'], ['11', '11', '', '01', 'B'],
];

// Table 3's own quadrant assignment for Y1Y2, read off its rows: 11 is the first
// quadrant, 10 the second, 00 the third, 01 the fourth. The data path counts
// quadrants as CCW quarter-turns from the first, so this is the join between the
// table's labels and what the differential coding accumulates.
const ROT_OF_Y = { 3: 0, 2: 1, 0: 2, 1: 3 };
const Y_OF_ROT = [3, 2, 0, 1];

section('Table 3/V.32 — quadrant assignment is the table\'s own');
for (const [label, [re, im]] of Object.entries(TABLE3)) {
  const y = parseInt(label.slice(0, 2), 2);
  const quad = re > 0 && im > 0 ? 0 : re < 0 && im > 0 ? 1 : re < 0 && im < 0 ? 2 : 3;
  eq(quad, ROT_OF_Y[y], `${label} lies in the quadrant Y1Y2=${label.slice(0, 2)} names`);
}

section('Table 3/V.32 — every one of the 16 points, as transmitted');
for (const [label, [re, im]] of Object.entries(TABLE3)) {
  const y = parseInt(label.slice(0, 2), 2);
  const Q3 = +label[2], Q4 = +label[3];
  const p = dataPoint(ROT_OF_Y[y], Q3, Q4);
  eq(`${p.i},${p.q}`, `${re},${im}`, `${label}`);
}

section('Table 3/V.32 — every one of the 16 points, as received');
for (const [label, [re, im]] of Object.entries(TABLE3)) {
  const got = dataBits(re, im);
  eq(Y_OF_ROT[got.rot].toString(2).padStart(2, '0'), label.slice(0, 2), `(${re},${im}) → Y1Y2`);
  eq(`${got.Q3}${got.Q4}`, label.slice(2), `(${re},${im}) → Q3Q4`);
}

section('Table 3/V.32 — the base row and the lattice');
// The quadrant-I rows, printed in order, ARE the base row.
for (let q34 = 0; q34 < 4; q34++) {
  const label = '11' + q34.toString(2).padStart(2, '0');
  const [re, im] = TABLE3[label];
  eq(`${BASE[q34].i},${BASE[q34].q}`, `${re},${im}`, `BASE[${q34.toString(2).padStart(2, '0')}] = ${label}`);
}
// All 16 points are distinct and on the {±1,±3}² grid — a slip off it fails here
// rather than as a slicer that quietly lands on the wrong point.
const seen = new Set();
for (const [re, im] of Object.values(TABLE3)) {
  ok([1, 3, -1, -3].includes(re) && [1, 3, -1, -3].includes(im), `(${re},${im}) is on the {±1,±3}² grid`);
  seen.add(`${re},${im}`);
}
eq(seen.size, 16, 'the 16 points are distinct');
// Mean symbol energy 10, which is also the mean energy of the four A/B/C/D
// training states — the reason V.32's start-up needs no scaling against its data.
let e = 0;
for (const [re, im] of Object.values(TABLE3)) e += re * re + im * im;
eq(e / 16, 10, 'mean symbol energy');
eq(V32S.STATE_MEAN_E, 10, 'the training states sit at the same energy');

section('Table 1/V.32 — every row, through the transmitted quadrant');
for (const [q, yPrev, , yNew] of TABLE1) {
  const Q1 = +q[0], Q2 = +q[1];
  // Exactly the line the transmitter runs.
  const rot = (ROT_OF_Y[parseInt(yPrev, 2)] + V32S.PHASE_CHANGE[(Q1 << 1) | Q2]) & 3;
  eq(Y_OF_ROT[rot].toString(2).padStart(2, '0'), yNew, `Q1Q2=${q} Yprev=${yPrev}`);
}

section('Table 1/V.32 — every row, through the received dibit');
for (const [q, yPrev, , yNew] of TABLE1) {
  // Exactly the line the receiver runs.
  const rot = ROT_OF_Y[parseInt(yNew, 2)], prev = ROT_OF_Y[parseInt(yPrev, 2)];
  const d = V32S.CHANGE_TO_DIBIT[(rot - prev) & 3];
  eq(`${(d >> 1) & 1}${d & 1}`, q, `Yprev=${yPrev} Ynew=${yNew} → Q1Q2`);
}

section('Table 1/V.32 — the phase quadrant change column');
for (const [q, , change] of TABLE1.filter((r) => r[2])) {
  const want = { '0': 0, '+90': 1, '+180': 2, '+270': 3 }[change];
  eq(V32S.PHASE_CHANGE[parseInt(q, 2)], want, `Q1Q2=${q} is ${change}°`);
}
// The specific thing that was wrong: this column is NOT the dibit. A test that
// only round-trips cannot tell the two apart, which is why it is named here.
ok(V32S.PHASE_CHANGE[0] !== 0 || V32S.PHASE_CHANGE[1] !== 1,
  'the change column is not a plain modulo-4 add of the dibit');
eq(V32S.PHASE_CHANGE.join(','), '1,0,2,3', 'Table 1 transposes dibits 00 and 01');

section('the data path is its own inverse');
// Not a substitute for the tables above — a shuffled map passes this — but an
// inverse that drifts from its forward direction is a real and different bug.
for (let rot = 0; rot < 4; rot++) {
  for (let Q3 = 0; Q3 < 2; Q3++) {
    for (let Q4 = 0; Q4 < 2; Q4++) {
      const p = dataPoint(rot, Q3, Q4);
      const back = dataBits(p.i, p.q);
      eq(`${back.rot}${back.Q3}${back.Q4}`, `${rot}${Q3}${Q4}`, `rot ${rot} Q3Q4 ${Q3}${Q4} round-trips`);
    }
  }
}
// And rotational invariance: rotating the whole constellation by any multiple of
// 90° must leave Q3Q4 alone and shift only the quadrant, which is what the
// differential coding cancels and what makes an absolute phase reference
// unnecessary for the data.
for (let k = 1; k < 4; k++) {
  for (let rot = 0; rot < 4; rot++) {
    for (let q34 = 0; q34 < 4; q34++) {
      const Q3 = (q34 >> 1) & 1, Q4 = q34 & 1;
      const a = dataBits(...Object.values(dataPoint(rot, Q3, Q4)));
      const b = dataBits(...Object.values(dataPoint((rot + k) & 3, Q3, Q4)));
      eq(`${b.Q3}${b.Q4}`, `${a.Q3}${a.Q4}`, `a ${k * 90}° rotation leaves Q3Q4 alone`);
      eq((b.rot - a.rot + 4) & 3, k, `a ${k * 90}° rotation shifts the quadrant by ${k}`);
    }
  }
}

console.log(`\n=== ${fail === 0 ? 'ALL PASS ✅' : 'FAILURES ❌'} === ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
