'use strict';
// §§5.2–5.3/V.32 and §§5.2–5.3/V.32bis before any of it is on a wire: the four
// states of Figure 1/V.32 against Table 3/V.32's own coordinates, every row of
// Table 1/V.32 at its literal digits, the two scrambler golden vectors §5.2.3
// prints, Table 5/V.32 and Table 4/V.32bis, the four rate-signal tables at their
// literal cells, and §5.3.1's detection rule in both directions.
//
// Same job as v34-phase3-check: hold the transcription where a mis-transcription
// fails as a test rather than as a link that works only against itself. The
// tables here were read from the ITU PDFs' text layer; the two constellation
// figures were read from the page images and cross-checked against the tables,
// which is the method PROTOIMPROVE.md sets out and the reason the figure half is
// asserted against the table half below rather than trusted on its own.
//
//   node tools/tests/v32-startup-check.js

const V32S = require('../../vendor/src/dsp/protocols/V32Startup');

let pass = 0, fail = 0;
function ok(cond, what) {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL ❌  ${what}`);
}
function eq(got, want, what) { ok(String(got) === String(want), `${what}: got ${got}, want ${want}`); }
function section(name) { console.log(`\n[${name}]`); }

// ── 1. Figure 1/V.32's circled states, against Table 3/V.32 ─────────────────
// Figure 1 labels its points Y1 Y2 Q3 Q4 and circles four of them as "subset
// A B C D of states used at 4800 bit/s and for training": A = 0001, B = 0101,
// C = 1101, D = 1001. Table 3/V.32's nonredundant column gives the Re/Im for
// those same four labels. The figure is only trusted where the table agrees.
section('Figure 1/V.32 — the four training states');
const TABLE3_NONREDUNDANT = {                 // Y1Y2Q3Q4 → [Re, Im], as printed
  '0000': [-1, -1], '0001': [-3, -1], '0010': [-1, -3], '0011': [-3, -3],
  '0100': [1, -1], '0101': [1, -3], '0110': [3, -1], '0111': [3, -3],
  '1000': [-1, 1], '1001': [-1, 3], '1010': [-3, 1], '1011': [-3, 3],
  '1100': [1, 1], '1101': [3, 1], '1110': [1, 3], '1111': [3, 3],
};
const CIRCLED = { A: '0001', B: '0101', C: '1101', D: '1001' };
for (const [letter, label] of Object.entries(CIRCLED)) {
  const rot = V32S[letter];
  const [re, im] = TABLE3_NONREDUNDANT[label];
  eq(`${V32S.ROT[rot].i},${V32S.ROT[rot].q}`, `${re},${im}`, `state ${letter} (Figure 1 label ${label})`);
  // Table 1's "signal state" column and Figure 1's label must name the same Y1Y2.
  eq(V32S.Y_OF_ROT[rot], parseInt(label.slice(0, 2), 2), `state ${letter} Y1Y2`);
}
// The whole 16-point nonredundant constellation and the four training states have
// the same mean symbol energy, which is why V.32 needs no scaling between them.
let e16 = 0;
for (const [re, im] of Object.values(TABLE3_NONREDUNDANT)) e16 += re * re + im * im;
eq(e16 / 16, 10, 'Figure 1 mean symbol energy');
eq(V32S.STATE_MEAN_E, 10, 'training-state mean symbol energy');
eq(V32S.gainFor(10), 1, 'V.32 needs no start-up gain');

// ── 2. Table 1/V.32, every row ──────────────────────────────────────────────
// "Differential quadrant coding for 4800 bit/s and for nonredundant coding at
// 9600 bit/s", transcribed as printed: Q1 Q2 | Y1n-1 Y2n-1 | change | Y1n Y2n |
// signal state. Table 2/V.32bis is the same sixteen rows.
section('Table 1/V.32 — differential quadrant coding');
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
for (const [q, yPrev, , yNew, state] of TABLE1) {
  const enc = new V32S.DiffEncoder(V32S.ROT_OF_Y[parseInt(yPrev, 2)]);
  const rot = enc.symbol(+q[0], +q[1]);
  eq(V32S.Y_OF_ROT[rot].toString(2).padStart(2, '0'), yNew, `Q1Q2=${q} Yprev=${yPrev} → Y`);
  eq(V32S.LETTER[rot], state, `Q1Q2=${q} Yprev=${yPrev} → state`);
}
// The printed "phase quadrant change" column, as a rotation of the plane.
for (const [q, , change] of TABLE1.filter((r) => r[2])) {
  const want = { '0': 0, '+90': 1, '+180': 2, '+270': 3 }[change];
  eq(V32S.PHASE_CHANGE[parseInt(q, 2)], want, `Q1Q2=${q} phase quadrant change ${change}°`);
}
// Round-trip: the decoder must invert the encoder for every dibit from every state.
section('Table 1 round-trip');
for (let y = 0; y < 4; y++) {
  for (let d = 0; d < 4; d++) {
    const enc = new V32S.DiffEncoder(y);
    const dec = new V32S.DiffDecoder();
    dec.bits(y);
    const got = dec.bits(enc.symbol((d >> 1) & 1, d & 1));
    eq(`${got[0]}${got[1]}`, `${(d >> 1) & 1}${d & 1}`, `dibit ${d} from rot ${y}`);
  }
}

// ── 3. §5.2.1 and §5.2.2 — S and S̄ ──────────────────────────────────────────
section('§5.2.1 / §5.2.2 — segments 1 and 2');
eq(V32S.S_SYMBOLS, 256, '§5.2.1 S duration');
eq(V32S.SBAR_SYMBOLS, 16, '§5.2.2 S̄ duration');
const S = V32S.buildS(), SBAR = V32S.buildSbar();
eq(S.length, 256, 'S length');
eq(SBAR.length, 16, 'S̄ length');
ok(S.every((p, k) => p === V32S.ROT[k % 2 ? V32S.B : V32S.A]), 'S alternates between A and B');
ok(SBAR.every((p, k) => p === V32S.ROT[k % 2 ? V32S.D : V32S.C]), 'S̄ alternates between C and D');
// §5.2.2's "well-defined event": every symbol of S̄ is the phase reversal of the
// symbol of S at the same parity. This is what the receiver's time reference is.
for (let k = 0; k < 2; k++) {
  ok(SBAR[k].i === -S[k].i && SBAR[k].q === -S[k].q, `S̄[${k}] is S[${k}] reversed`);
}
// S's two states are a quarter turn apart and the ORDERED pair (A, B) turns
// counter-clockwise, which is what lets a receiver resolve which of the two its
// even-indexed samples landed on. Get that wrong and the four references come out
// reflected rather than rotated — see the last section.
//
// Note it is the ordered pair, not the step direction: S alternates A B A B, so
// the steps themselves alternate +90° and −90° and carry no such information.
const cross = (p, n) => p.i * n.q - p.q * n.i;
ok(cross(S[0], S[1]) > 0, '(A, B) is a counter-clockwise quarter turn');
ok(cross(S[1], S[0]) < 0, '(B, A) is the other way, which is what names the parity');
ok(cross(SBAR[0], SBAR[1]) > 0, '(C, D) turns the same way as (A, B)');

// ── 4. §5.2.3's printed golden vectors ──────────────────────────────────────
// "Depending on whether the modem is in call or answer mode, the scrambler output
// patterns and corresponding signal states will then begin as below, where the
// bits and the signal states are shown in time sequence from left to right."
// These are the strongest check in either Recommendation on the scrambler AND on
// the first-bit-of-each-dibit rule, because they pin both at once.
section('§5.2.3 — the printed scrambler golden vectors');
const GOLDEN = [
  ['Call mode modem (GPC)', 17,
    '11 11 11 11 11 11 11 11 11 00 00 01 11 11 11', 'CCCCCCCCCAAACCC'],
  ['Answer mode modem (GPA)', 4,
    '11 11 10 00 00 11 11 10 00 00 11 10 01 11 11', 'CCCAACCCAACCACC'],
];
for (const [name, tap, printedBits, printedStates] of GOLDEN) {
  const want = printedBits.replace(/ /g, '');
  const reg = new Array(23).fill(0);                       // §5.2.3: "all zeros"
  const scramble = (b) => { const o = b ^ reg[tap] ^ reg[22]; reg.unshift(o); reg.pop(); return o; };
  let bits = '', states = '';
  for (let n = 0; n < printedStates.length; n++) {
    const rot = V32S.trnRotation(n, () => { const o = scramble(1); bits += o; return o; });
    states += V32S.LETTER[rot];
  }
  eq(bits, want, `${name} scrambler output`);
  eq(states, printedStates, `${name} signal states`);
}
// §5.2.3: "The first 256 transmitted signal states are determined from the state
// of the first bit occurring (in time) in each dibit. When this bit is ZERO,
// signal state A is transmitted; when this bit is ONE, signal state C is
// transmitted." Nothing else may appear there — which is also why a receiver
// cannot recover the scrambler stream from that stretch.
section('§5.2.3 — the first 256 states');
{
  const reg = new Array(23).fill(0);
  const scramble = (b) => { const o = b ^ reg[17] ^ reg[22]; reg.unshift(o); reg.pop(); return o; };
  let onlyAC = true, sawA = false, sawC = false;
  for (let n = 0; n < V32S.TRN_ABS_SYMBOLS; n++) {
    const rot = V32S.trnRotation(n, () => scramble(1));
    if (rot === V32S.A) sawA = true;
    else if (rot === V32S.C) sawC = true;
    else onlyAC = false;
  }
  ok(onlyAC, 'the first 256 TRN states are only A or C');
  ok(sawA && sawC, 'both A and C occur in the first 256');
}
eq(V32S.TRN_MIN_SYMBOLS, 1280, '§5.2.3 minimum TRN duration');
eq(V32S.TRN_MAX_SYMBOLS, 8192, '§5.2.3 maximum TRN duration');

// Table 5/V.32 (Table 4/V.32bis), "Encoding for TRN segment after the first 256
// symbols": 00 A, 01 B, 11 C, 10 D. Held as the table prints it, dibit first.
section('Table 5/V.32 — TRN after the first 256 symbols');
for (const [dibit, state] of [['00', 'A'], ['01', 'B'], ['11', 'C'], ['10', 'D']]) {
  let k = 0;
  const rot = V32S.trnRotation(V32S.TRN_ABS_SYMBOLS, () => +dibit[k++]);
  eq(V32S.LETTER[rot], state, `dibit ${dibit}`);
}

// ── 5. The rate-signal tables at their literal cells ────────────────────────
// Table 6/V.32 and Table 7/V.32 (E); Table 5/V.32bis and Table 6/V.32bis (E).
// '-' is a cell the table leaves to the modem; the assertion is on the fixed
// cells and on which bit each rate lives in.
section('Table 6/V.32 and Table 7/V.32');
const V32_TABLE6_PRINTED = '0000---1---1---1';
const V32_TABLE7_PRINTED = '1111---1---1---1';   // B7 prints as "B1", which is 1
const V32BIS_TABLE5_PRINTED = '00001--11--1-001';
const V32BIS_TABLE6_PRINTED = '11111--11--1-001';

function checkTable(codec, printed, sequence, label) {
  // Every fixed digit of the printed row must come out of a built sequence
  // whatever rates it advertises, and every '-' must be a cell the codec can move.
  const none = codec.build([], { sequence });
  const all = codec.build(codec.rates, { sequence });
  for (let k = 0; k < 16; k++) {
    if (printed[k] === '-') continue;
    eq(none[k], +printed[k], `${label} B${k} (advertising nothing)`);
    eq(all[k], +printed[k], `${label} B${k} (advertising everything)`);
  }
  let movable = 0;
  for (let k = 0; k < 16; k++) if (none[k] !== all[k]) movable++;
  eq(movable, codec.rates.length, `${label} moves exactly one cell per rate`);
}
checkTable(V32S.V32_RATES, V32_TABLE6_PRINTED, 'rate', 'Table 6/V.32');
checkTable(V32S.V32_RATES, V32_TABLE7_PRINTED, 'e', 'Table 7/V.32');
section('Table 5/V.32bis and Table 6/V.32bis');
checkTable(V32S.V32BIS_RATES, V32BIS_TABLE5_PRINTED, 'rate', 'Table 5/V.32bis');
checkTable(V32S.V32BIS_RATES, V32BIS_TABLE6_PRINTED, 'e', 'Table 6/V.32bis');

// The rate bit positions, as each table names them.
section('rate bit positions');
eq(JSON.stringify(V32S.V32_RATE_BITS), JSON.stringify({ 2400: 4, 4800: 5, 9600: 6 }),
  'Table 6/V.32 B4/B5/B6 = 2400/4800/9600');
eq(JSON.stringify(V32S.V32BIS_RATE_BITS),
  JSON.stringify({ 4800: 5, 9600: 6, 7200: 9, 12000: 10, 14400: 12 }),
  'Table 5/V.32bis B5/B6/B9/B10/B12');
// Note 3/Table 5/V.32bis and Table 6/V.32's B4-6 row: no rate bit set calls for a
// GSTN cleardown, so it must be a CONFORMING sequence advertising nothing rather
// than a malformed one — a receiver has to be able to read it to act on it.
for (const codec of [V32S.V32_RATES, V32S.V32BIS_RATES]) {
  const clear = codec.build([]);
  eq(codec.kindOf(clear), 'rate', `${codec.name}: a cleardown is a conforming rate signal`);
  eq(codec.decode(clear).best, 0, `${codec.name}: a cleardown advertises no rate`);
}

// ── 6. §5.3.1 — "two consecutive identical 16-bit sequences" ────────────────
section('§5.3.1 — detecting a rate signal');
{
  const codec = V32S.V32BIS_RATES;
  const seq = codec.build([4800, 9600, 14400]);
  const other = codec.build([4800]);

  // One sequence is not a detection.
  let f = new V32S.RateFramer(codec);
  let hits = 0;
  for (const b of seq) if (f.push(b)) hits++;
  eq(hits, 0, 'one sequence is not enough');

  // Two DIFFERENT conforming sequences are not a detection either.
  f = new V32S.RateFramer(codec);
  hits = 0;
  for (const b of [...seq, ...other]) if (f.push(b)) hits++;
  eq(hits, 0, 'two different sequences are not enough');

  // Two identical ones are, and they carry every advertised rate.
  f = new V32S.RateFramer(codec);
  let hit = null;
  for (const b of [...seq, ...seq]) hit = f.push(b) || hit;
  ok(hit !== null, 'two identical conforming sequences are detected');
  eq(hit && hit.kind, 'rate', 'detected as a rate signal');
  eq(hit && hit.advertised.join(','), '4800,9600,14400', 'advertised rates');
  eq(hit && hit.best, 14400, 'best advertised rate');

  // Unaligned: the seven fixed cells are what find the boundary, so a detection
  // must still happen when the stream does not start on B0.
  f = new V32S.RateFramer(codec);
  hit = null;
  for (const b of [1, 0, 1, ...seq, ...seq, ...seq]) hit = f.push(b) || hit;
  eq(hit && hit.best, 14400, 'detection finds its own alignment');

  // §5.3.2's E is sent ONCE, so it is read off the frame the rate signal
  // established rather than by §5.3.1's rule. Before the lock it must NOT be
  // detected; after it, it must be.
  f = new V32S.RateFramer(codec);
  hits = 0;
  for (const b of [...codec.build([14400], { sequence: 'e' })].concat(codec.build([14400], { sequence: 'e' }))) {
    if (f.push(b)) hits++;
  }
  eq(hits, 0, 'E alone never satisfies §5.3.1');
  f = new V32S.RateFramer(codec);
  hit = null;
  for (const b of [...seq, ...seq]) hit = f.push(b) || hit;
  let eHit = null;
  for (const b of codec.build([14400], { sequence: 'e' })) eHit = f.push(b) || eHit;
  eq(eHit && eHit.kind, 'e', 'E is read on the locked frame');
  eq(eHit && eHit.best, 14400, 'E names the agreed rate');
}

// ── 7. The whole chain: scramble → differentially encode → states → back ────
// A rate signal as it actually reaches the wire, and the reflection hazard that
// makes the receiver's parity resolution load-bearing rather than cosmetic.
section('rate signal through the full chain');
{
  const codec = V32S.V32_RATES;
  const seq = codec.build([9600]);
  const txReg = new Array(23).fill(0);
  const scramble = (b) => { const o = b ^ txReg[17] ^ txReg[22]; txReg.unshift(o); txReg.pop(); return o; };
  const enc = new V32S.DiffEncoder(V32S.C);
  const rots = [];
  for (let rep = 0; rep < 6; rep++) {
    for (let k = 0; k < 16; k += 2) rots.push(enc.symbol(scramble(seq[k]), scramble(seq[k + 1])));
  }

  const decodeWith = (map) => {
    const dec = new V32S.DiffDecoder();
    const rxReg = new Array(23).fill(0);
    const framer = new V32S.RateFramer(codec);
    let hit = null;
    for (const r of rots) {
      const ib = dec.bits(map(r));
      if (!ib) continue;
      for (const bit of ib) {
        const ob = bit ^ rxReg[17] ^ rxReg[22];
        rxReg.unshift(bit); rxReg.pop();
        hit = framer.push(ob) || hit;
      }
    }
    return hit;
  };

  eq(decodeWith((r) => r) && decodeWith((r) => r).best, 9600, 'decodes through the real chain');
  // A pure rotation of the reference is harmless — that is what differential
  // coding buys, and it is why S's starting state need not be fixed.
  for (let k = 1; k < 4; k++) {
    const h = decodeWith((r) => (r + k) & 3);
    eq(h && h.best, 9600, `a reference rotated by ${k * 90}° still decodes`);
  }
  // A REFLECTION is not harmless: it is what a receiver gets by taking S's two
  // states the wrong way round, and it destroys the decode rather than shifting
  // it. This is the assertion that says the parity resolution has to exist.
  ok(decodeWith((r) => (1 - r + 4) & 3) === null, 'a reflected reference does not decode');
}

console.log(`\n=== ${fail === 0 ? 'ALL PASS ✅' : 'FAILURES ❌'} === ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
