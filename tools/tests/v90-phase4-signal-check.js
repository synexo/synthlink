'use strict';

/**
 * v90-phase4-signal-check — §9.4's PROCEDURE, on the wire.
 *
 * v90-phase4-check holds the bit layouts of Tables 14, 16 and 17 and the shape of
 * R, R̄, TRN2d, Ed and B1d as standalone blocks. This is the other half: that a real
 * call puts those signals out in §9.4's order, at §9.4's lengths, in both
 * directions — which is what stages B and C of the backlog's item 0 actually did.
 *
 * It is deliberately NOT a round-trip test. A round trip passes on a procedure both
 * ends invent together, which is exactly what the DLE control channel these signals
 * replaced was; every assertion here is against a clause's own number, and the
 * recovered sequences are checked by their CRC rather than by comparing them to
 * what the transmitter happened to build.
 *
 * Run: node tools/tests/v90-phase4-signal-check.js
 */

const path = require('path');
const root = path.join(__dirname, '..', '..');
const cfg = require(path.join(root, 'vendor/synthlink-config.js'));
cfg.modem.native.protocolPreference = ['V90'];
cfg.modem.native.v8ModulationModes = ['V90'];

const { V90 } = require(path.join(root, 'vendor/src/dsp/protocols/V90.js'));
const P4 = require(path.join(root, 'vendor/src/dsp/protocols/V90Phase4.js'));

let pass = 0, fail = 0;
function ok(cond, what) {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}`); }
}
function eq(got, want, what) { ok(got === want, `${what} — ${got}${got === want ? '' : ` (want ${want})`}`); }

// ── Run one call, recording every Phase 4 symbol the digital modem transmits and
// every stage its upstream V.34 passes through. ─────────────────────────────
const A = new V90('originate');            // analogue modem — §9.4.2
const D = new V90('answer');               // digital modem  — §9.4.1
A.setV8Complete(true); D.setV8Complete(true);

const down = [];                           // {stage, value} per Phase 4 symbol
const origP4 = D._p4Symbol.bind(D);
D._p4Symbol = function () {
  // The stage is read AFTER the call: every stage in that machine tests its own end
  // before emitting, so the stage a symbol was emitted under is the one in force
  // when it returns.
  const v = origP4();
  if (v !== null) down.push({ stage: this._p4Stage, value: v });
  return v;
};

const upStages = [];                       // §9.4.2's stage order, in order — taken
                                           // from the stage machine itself, because E
                                           // is ten symbols and a per-block sample
                                           // misses it
const upSeq = [];                          // {isCP, ack, crcOk} per CP the digital read
const origApply = D._applyCP.bind(D);
D._applyCP = (n, bits) => { upSeq.push(P4.parseCP(bits, n)); return origApply(n, bits); };
const origHunt = D._huntCP.bind(D);
D._huntCP = function () {
  const b = this.up.p3 && this.up.p3.bits;
  if (b && this.txStage === 'p4' && !this._cpApplied) {
    for (let i = 0; i + P4.cpLength(1) <= b.length; i++) {
      if (b[i + P4.CP_SYNC_BITS] !== 0) continue;
      let sync = true;
      for (let k = 0; k < P4.CP_SYNC_BITS && sync; k++) if (b[i + k] !== 1) sync = false;
      if (!sync) continue;
      for (let n = 1; n <= 6; n++) {
        const len = P4.cpLength(n);
        if (i + len > b.length) break;
        const cp = P4.parseCP(b.slice(i, i + len), n);
        if (cp.sync && cp.crcOk) { upSeq.push(cp); break; }
      }
    }
  }
  return origHunt();
};

const origAdvance = A.up._p3Advance.bind(A.up);
A.up._p3Advance = function (p3, t) {
  const r = origAdvance(p3, t);
  if (upStages[upStages.length - 1] !== p3.stage) upStages.push(p3.stage);
  return r;
};

const N = 160;
let sent = false, got = [];
A.on('data', (buf) => got.push(...buf));
for (let t = 0; t < 2000; t++) {
  const a = A.generateAudio(N), d = D.generateAudio(N);
  A.receiveAudio(d); D.receiveAudio(a);
  if (D._ready && !sent) { sent = true; D.write(Buffer.from('phase 4\r\n')); }
  if (sent && got.length >= 9) break;
}

console.log('\n[the call itself]');
ok(A.dataStart >= 0, 'the analogue modem reached data mode');
ok(D._ready && A._ready, 'both ends report ready');
eq(Buffer.from(got).toString('latin1'), 'phase 4\r\n', 'the payload after B1d is exact');

// ── §9.4.1 — the downstream, signal by signal ──────────────────────────────
const runs = [];
for (const s of down) {
  const last = runs[runs.length - 1];
  if (last && last.stage === s.stage) last.values.push(s.value);
  else runs.push({ stage: s.stage, values: [s.value] });
}
const order = runs.map(r => r.stage);
const first = (name) => runs.find(r => r.stage === name);

console.log('\n[§9.4.1 — the digital modem]');
ok(JSON.stringify(order.slice(0, 4)) === JSON.stringify(['ri', 'rbari', 'trn2d', 'mp']),
   `Ri → R̄i → TRN2d → MP is the order on the wire — got ${order.slice(0, 4).join(' → ')}`);
ok(order.includes('mpprime') && order.indexOf('mpprime') > order.indexOf('mp'),
   'MP′ follows MP');
ok(order.includes('ed') && order.indexOf('ed') > order.indexOf('mpprime'),
   'Ed follows MP′');

const ri = first('ri'), rbar = first('rbari'), trn2d = first('trn2d'), ed = first('ed');
ok(ri.values.length >= 192, `§9.4.1.1 — Ri is at least 192T (${ri.values.length})`);
eq(ri.values.length % P4.R_PERIOD, 0, 'Ri is a whole number of 6-symbol data frames');
// Against the clause's own digits, not against P4.RBAR_SYMBOLS: an assertion that
// reads the constant the transmitter reads cannot see that constant being wrong,
// which is the failure this repository has hit four times.
eq(rbar.values.length, 24, '§9.4.1.2 — R̄i is exactly 24T');
eq(P4.RBAR_REPS, 4, '§8.6.4 — R̄ is four repetitions of the six-symbol sequence');
ok(trn2d.values.length >= 2040,
   `§9.4.1.2 — TRN2d is at least 2040T (${trn2d.values.length})`);
eq(ed.values.length, 12, '§8.6.2 — Ed is 2 data frames of six symbols');
eq(P4.B1D_FRAMES, 48, '§8.6.1 — B1d is 48 data frames');

// §8.6.4 — R and R̄ are one codeword and a sign pattern, and R̄ inverts R at every
// position. That is what makes them detectable regardless of polarity, and it is
// the property a receiver keyed on the absolute sign would get wrong.
const sgn = (v) => (v > 0 ? 1 : 0);
const mag = Math.abs(ri.values[0]);
ok(ri.values.every(v => Math.abs(Math.abs(v) - mag) < 1e-9),
   'R is one PCM codeword throughout — only the sign moves');
ok(ri.values.every((v, k) => sgn(v) === P4.R_SIGNS[k % P4.R_PERIOD]),
   '§8.6.4 — R carries the sign pattern + + + − − −, left-most first');
ok(rbar.values.every((v, k) => sgn(v) === P4.RBAR_SIGNS[k % P4.R_PERIOD]),
   '§8.6.4 — R̄ carries − − − + + +');
ok(P4.R_SIGNS.every((s, k) => s !== P4.RBAR_SIGNS[k]),
   'R̄ is R inverted at every position, which is why the transition is a POLARITY change');
ok(rbar.values.every(v => Math.abs(Math.abs(v) - mag) < 1e-9),
   'R̄i is the same codeword as Ri (§8.6.4: Ri and R̄i are U_INFO for every interval)');
// §8.6.5 puts TRN2d through §5.4's encoder on CPt's constellation, so unlike Ri it
// is NOT one codeword: a TRN2d that were would mean the training encoder was never
// built and the signal had fallen back to a sign on U_INFO.
ok(!trn2d.values.every(v => Math.abs(Math.abs(v) - mag) < 1e-9),
   '§8.6.5 — TRN2d is encoder output on CPt\'s constellation, not one codeword');

// §§8.6.2, 8.6.3 and 8.6.5 — TRN2d, MP, MP′ and Ed are §5.4 encoder output on the
// CPt constellation, not a sign on one codeword. So the check that they are on the
// wire is that the ANALOGUE modem demodulated them there: it reads MP on training
// parameters, before it knows anything about data mode, which is the new receive
// path stage B is. What that path recovered is checked below against the tables.
console.log('\n[§8.6.3 — MP through the training constellation]');
eq(P4.mpLength(6), 90, 'Table 16 — filled to a whole data frame; at 6 bits a frame, 90');
eq(P4.mpLength(A.cfgT.D) % A.cfgT.D, 0,
   'and at the training constellation\'s D, a whole number of frames');
ok(A.cfgT && D.cfgT && A.cfgT.D === D.cfgT.D,
   `both ends built the same training encoder from CPt (D = ${A.cfgT && A.cfgT.D})`);
// Table 14 bits 49:50 — the training and data-mode parameter sets are separate
// sequences and this build differs them where it matters: the shaper's lookahead is
// a pipeline delay, so CPt takes lₐ = 0 and Ed's last frames reach the wire.
{
  const cpt = P4.parseCP(A.up._p4.cptBits(), A.constellationSet.length);
  const cp = P4.parseCP(A.up._p4.cpBits(false), A.constellationSet.length);
  eq(cpt.isCP, false, '§9.4.2.1 — CPt is CP with bit 19 clear');
  eq(cp.isCP, true, '§9.4.2.3 — CP has it set');
  eq(cpt.ld, 0, 'CPt passes lₐ = 0, which is what lets Ed end Phase 4 on the wire');
  eq(A.cfgT.drn, cpt.drn, 'the training encoder was built from CPt, not from CP');
}
ok(A._mpSeen, '§9.4.1.3 — the analogue modem read MP off the training constellation');
ok(A._mpPrimeSeen, '§9.4.1.4 — and the MP′ that acknowledges its CP');
eq(A._rateUp, 33600, 'the upstream rate the analogue modem took from Table 16 bits 24:27');
ok(A._rbarSeen, '§9.4.2.2 — the R-to-R̄i transition was detected as a polarity change');

// A CRC that cannot fail is not a check: the sequence the analogue modem accepted is
// re-parsed here with one information bit flipped.
{
  const bits = P4.buildMP({ D: A.cfgT.D, drn: 14, ack: true, upstreamRates: [33600] });
  ok(P4.parseMP(bits).crcOk, 'a well-formed MP passes');
  bits[40] ^= 1;
  ok(!P4.parseMP(bits).crcOk, 'negative control: one flipped information bit fails the CRC');
}

// ── §9.4.2 — the upstream ──────────────────────────────────────────────────
console.log('\n[§9.4.2 — the analogue modem]');
const idx = (s) => upStages.indexOf(s);
ok(idx('p4-cpt') > idx('sbar-terminate'),
   '§9.4.2.1 — CPt follows Phase 3\'s terminating S̄, with no TRN between them');
ok(idx('p4-cp') > idx('p4-cpt'), 'CP follows CPt');
ok(idx('p4-cpprime') > idx('p4-cp'), 'CP′ follows CP');
ok(idx('p4-e') > idx('p4-cpprime'), '§8.5.3 — E follows CP′ and ends the exchange');

const cpts = upSeq.filter(c => !c.isCP), cps = upSeq.filter(c => c.isCP);
ok(cpts.length > 0, `§9.4.2.1 — CPt is on the wire (${cpts.length} read)`);
ok(cpts.every(c => c.crcOk), 'every CPt read passes its CRC');
ok(cps.length > 0, `§9.4.2.2 — CP is on the wire (${cps.length} read)`);
ok(cps.every(c => c.crcOk), 'every CP read passes its CRC');
// The digital modem stops hunting the moment CP is applied, which is correct and
// means CP′ never reaches upSeq. What it transmits is checked at the source instead:
// the wire ORDER above is what says the stage ran.
{
  const cpp = P4.parseCP(A.up._p4.cpBits(true), A.constellationSet.length);
  ok(cpp.crcOk && cpp.isCP && cpp.ack,
     'Table 14 bit 33 — the CP′ stage transmits a CP with the acknowledge bit set');
}
ok(D._cpApplied, 'the digital modem configured its downstream from the CP it read off Phase 4');
eq(D.constellationSet.length, cps[0].constellations.length,
   'the constellation count is recovered from the sequence, not agreed in advance');

console.log(`\n${fail === 0 ? '=== ALL PASS ✅ ===' : '=== FAILURES ❌ ==='} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
