'use strict';

/**
 * v34-phase4-signal-check — §11.4's procedure, on the wire.
 *
 * v34-phase4-check holds Table 20's bit layout and §10.1.3.9's two modulations as
 * standalone blocks. This asserts that a real V.34 call puts MP out through that
 * modulation, in §11.4's order, instead of packing it into bytes and sending it over
 * the established link — which is what it did until the backlog's item 0.
 *
 * The stage order and the TRN that MP's differential encoder is initialised from are
 * read off the transmitter's own machine; the acknowledge bit is read off the far
 * end, because "MP′ arrived" is the only thing that can distinguish a Phase 4
 * exchange from a Phase 4 transmission.
 *
 * Run: node tools/tests/v34-phase4-signal-check.js
 */

const path = require('path');
const root = path.join(__dirname, '..', '..');
const cfg = require(path.join(root, 'vendor/synthlink-config.js'));
cfg.modem.native.protocolPreference = ['V34'];
cfg.modem.native.v8ModulationModes = ['V34'];

const { V34 } = require(path.join(root, 'vendor/src/dsp/protocols/V34.js'));
const P4 = require(path.join(root, 'vendor/src/dsp/protocols/V34Phase4.js'));
const P3 = require(path.join(root, 'vendor/src/dsp/protocols/V34Phase3.js'));

let pass = 0, fail = 0;
const ok = (c, w) => { if (c) { pass++; console.log(`  ok   ${w}`); } else { fail++; console.log(`  FAIL ${w}`); } };
const eq = (g, w, what) => ok(g === w, `${what} — ${g}${g === w ? '' : ` (want ${w})`}`);

const A = new V34('originate');            // call modem   — §11.4.1
const B = new V34('answer');               // answer modem — §11.4.2

// Stage order and per-stage symbol counts, off the tail machine itself. A stage
// change is recorded where it happens, because §10.1.3.2's E is ten symbols and a
// per-block sample would step over it.
function watch(m, into) {
  const orig = m._p3Advance.bind(m);
  m._counts = {};
  m._p3Advance = function (p3, t) {
    // The stage whose CASE ran is the one in force on entry: a bits-based stage sets
    // its own bits and the NEXT stage's name in the same step, so reading the name
    // afterwards attributes every sequence to whatever follows it.
    const stage = p3.stage;
    const r = orig(p3, t);
    const n = p3.bits ? p3.bits.length / 2 : (p3.run ? p3.run.length : 0);
    if (n) m._counts[stage] = (m._counts[stage] || 0) + n;
    if (into[into.length - 1] !== stage) into.push(stage);
    return r;
  };
}
const aStages = [], bStages = [];
watch(A, aStages); watch(B, bStages);

const N = 160;
let got = '';
A.on('data', (b) => { got += b.toString('latin1'); });
for (let t = 0; t < 3000; t++) {
  const a = A.generateAudio(N), b = B.generateAudio(N);
  A.receiveAudio(b); B.receiveAudio(a);
  if (B._ready && !B._sentTest) { B._sentTest = true; B.write(Buffer.from('mp\r\n')); }
  if (got.length >= 4) break;
}

console.log('\n[the call itself]');
ok(A._ready && B._ready, 'both ends reached data mode');
eq(got, 'mp\r\n', 'the payload after Phase 4 is exact');

console.log('\n[§11.4 — the order on the wire]');
for (const [name, st] of [['call modem', aStages], ['answer modem', bStages]]) {
  const want = ['j', 'jprime', 'p4-trn', 'p4-mp', 'p4-mpprime', 'p4-e'];
  const got4 = st.filter((s) => want.includes(s));
  const seq = want.filter((s) => got4.includes(s));
  ok(JSON.stringify(seq) === JSON.stringify(want),
     `${name}: J → J′ → TRN → MP → MP′ → E — got ${seq.join(' → ')}`);
  for (let i = 1; i < want.length; i++) {
    ok(got4.indexOf(want[i]) > got4.indexOf(want[i - 1]) ||
       got4.lastIndexOf(want[i - 1]) < got4.indexOf(want[i]),
       `${name}: ${want[i]} comes after ${want[i - 1]}`);
  }
}

console.log('\n[§11.4.1.1.1 and §10.1.3.9 — TRN, MP and E as signals]');
// §10.1.3.2: "E is a 20-bit sequence of binary ones", two bits to a 2D symbol
// interval, so ten symbols. Against the clause's digits, not against E_BITS.
eq(P4.E_BITS, 20, '§10.1.3.2 — E is 20 bits');
eq(A._counts['p4-e'], 10, 'E occupies ten 2D symbol intervals on the wire');
eq(P4.MP_BITS % 2, 0, 'Table 20 — MP fills a whole number of 2-bit symbol intervals');
eq(A._counts['p4-mpprime'], P4.MP_BITS / 2 * 2,
   'MP′ is sent twice — a sequence sent once is the one the descrambler eats');
ok(A._counts['p4-mp'] >= P4.MP_BITS / 2 * 2,
   `MP is sent at least twice (${A._counts['p4-mp']} symbols)`);
ok(A._counts['p4-trn'] > 0, 'TRN is transmitted between J′ and MP (§11.4.1.1.1)');
eq(A._counts['p4-trn'] % 2, 0, 'the Phase 4 TRN is a whole number of symbol intervals');

console.log('\n[the exchange, not just the transmission]');
ok(A.peerMP && B.peerMP, 'each end read the other\'s MP off the Phase 4 signalling');
ok(A.peerMP.crcOk && B.peerMP.crcOk, 'both sequences passed their own CRC');
ok(A.peerMPPrime && B.peerMPPrime,
   '§10.1.3.9 — each end read the other\'s MP′, which is what makes this an exchange');
ok((A.peerMPPrime || {}).ack === true && (B.peerMPPrime || {}).ack === true,
   'Table 20 bit 33 is what distinguishes MP′ from MP');
eq(A.peerRate, B.bps, 'the call modem took its peer\'s rate from Table 20 bits 20:27');
eq(B.peerRate, A.bps, 'and the answer modem from the opposite field');
ok(!A.mpMismatch && !B.mpMismatch,
   'the coding parameters MP names are the ones this decoder implements');

// The Phase 4 modulation is §10.1.3.3's chain, which is what signal J advertises:
// a 4-point MP for the pattern this modem sends. A 16-point J with a 4-point MP is
// the mismatch this pins.
ok(JSON.stringify(P3.jPattern(4)) !== JSON.stringify(P3.jPattern(16)),
   'Table 18 — J names which of §10.1.3.9\'s two forms MP will use');
eq(P4.MP_BITS_PER_SYMBOL[4], 2, '§10.1.3.9 — the 4-point form is two bits a symbol');

console.log(`\n${fail === 0 ? '=== ALL PASS ✅ ===' : '=== FAILURES ❌ ==='} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
