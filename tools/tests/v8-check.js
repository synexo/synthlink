#!/usr/bin/env node
'use strict';
// tools/tests/v8-check.js — V.8's LAPM indication (Table 6, §7.3, §7.4) and its
// CJ: read as it lands after a CM cut short, sent after a whole CM octet (§8.2),
// and, lost on the line, made good by the absence of CM (§8).
//
//   node tools/tests/v8-check.js
//
// The protocols octet at its literal value first, then through our parser, then
// two V8Sequencers on one line: LAPM is settled only when CM said it AND the
// answerer said it back in JM (§7.4: "if the LAPM protocol code is indicated in
// CM, the protocol octet may be included in JM in order to complete the
// negotiation"). bm-whole holds the same against BinModem's V.8.

const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const V8 = require(path.join(ROOT, 'vendor', 'src', 'dsp', 'V8'));
const { V8Sequencer } = require(path.join(ROOT, 'vendor', 'src', 'dsp', 'V8Sequencer'));
const { V21Modulator, V21Demodulator } = require(path.join(ROOT, 'vendor', 'src', 'dsp', 'protocols', 'V21'));
// The originator picks from the config's preference, a singleton both ends share.
require(path.join(ROOT, 'vendor', 'config')).modem.native.protocolPreference = ['V34', 'V32bis'];

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log(`  ok   ${msg}`); } else { fail++; console.log(`  FAIL ${msg}`); } }

console.log('[the octet]');
{
  // Table 6: tag b0–b3 = 0 1 0 1, b4 = 0 (a category), b5–b7 = 1 0 0 for LAPM.
  const bits = [0, 1, 0, 1, 0, 1, 0, 0];
  const byte = bits.reduce((v, b, k) => v | (b << k), 0);
  ok(byte === 0x2A, `Table 6's LAPM octet is 0x${byte.toString(16)}`);
  const framed = V8.packCategoryOctet([0, 1, 0, 1], [1, 0, 0]);
  ok(JSON.stringify(framed.slice(1, 9)) === JSON.stringify(bits), 'the bit-level builder packs the same eight bits');
  const withIt = V8.buildCMBytes({ v34: true, v32bis: true, lapm: true });
  const without = V8.buildCMBytes({ v34: true, v32bis: true });
  ok(withIt.includes(0x2A) && !without.includes(0x2A), `CM carries it only when asked — ${withIt.toString('hex')} / ${without.toString('hex')}`);
  // After the modulation modes and before PSTN access, Table 2's order.
  const v90 = V8.buildCMBytes({ v34: true, pcm: true, pcmAnalogue: true, lapm: true });
  ok(v90.indexOf(0x2A) < v90.indexOf(0x0B), `in Table 2's order, before PSTN access — ${v90.toString('hex')}`);
}

console.log('\n[the parser]');
for (const m of [{ v34: true, lapm: true }, { v34: true, v32bis: true, v21: true, lapm: true }, { v32bis: true }]) {
  const b = V8.buildCMBytes(m);
  const msgs = V8.parseV8Bytes({ buf: Buffer.alloc(0) }, Buffer.concat([b, b]));
  const d = msgs[0] && msgs[0].modes;
  ok(d && d.lapm === !!m.lapm && d.v34 === !!m.v34 && d.v32bis === !!m.v32bis && d.v21 === !!m.v21,
     `${b.toString('hex')}: LAPM ${!!m.lapm}, and the modulations read as before`);
}

{
  // §7.4's two identical JMs must agree on LAPM too. The compared bytes stopped at
  // the last modulation octet, so under a 30 dB echo a JM whose LAPM octet was
  // lost matched one that had it, and the caller took LAPM as unsaid.
  // BinModem's JM there: sync, call function, modn0..modn2, then LAPM.
  const whole = Buffer.from([0xE0, 0xC1, 0x05, 0x12, 0x10, 0x2A]);
  const lost = Buffer.from([0xE0, 0xC1, 0x05, 0x12, 0x10]);
  const [a, b] = V8.parseV8Bytes({ buf: Buffer.alloc(0) }, Buffer.concat([whole, lost, whole]));
  ok(a && b && a.modes.lapm && !b.modes.lapm && !a.bytes.equals(b.bytes),
     `a JM with LAPM and one that lost it compare different — ${a && a.bytes.toString('hex')} / ${b && b.bytes.toString('hex')}`);
}

{
  // A caller stops repeating CM mid-sequence to send CJ (BinModem does, after
  // the sync). CJ must be read as it lands, not when a fourth byte follows: the
  // wait handed V.34 the line 200 ms late, past the caller's INFO0c.
  const st = { buf: Buffer.alloc(0) };
  let got = [];
  for (const b of [0xE0, 0x00, 0x00]) got = got.concat(V8.parseV8Bytes(st, Buffer.from([b])));
  ok(got.some((m) => m.type === 'CJ'), `a CM cut short after its sync, then CJ: CJ read at once — ${JSON.stringify(got.map((m) => m.type))}`);
}

console.log('\n[two V.8s on one line]');
function negotiate(callLapm, answerLapm) {
  const o = new V8Sequencer({ role: 'originate', parms: { modulations: ['V34', 'V32bis'], lapm: callLapm } });
  const a = new V8Sequencer({ role: 'answer', parms: { modulations: ['V34', 'V32bis'], lapm: answerLapm } });
  const res = {};
  o.on('result', (r) => { res.o = r; }); a.on('result', (r) => { res.a = r; });
  // What the caller put on the line, read back by a V.21 receiver of our own.
  const tap = new V21Demodulator(2), sent = [];
  tap.on('data', (b) => { for (const x of b) sent.push(x); });
  o.start(); a.start();
  for (let b = 0; b < 8 * 50 && !(res.o && res.a); b++) {
    const x = o.generateAudio(160), y = a.generateAudio(160);
    tap.process(x);
    a.receiveAudio(x); o.receiveAudio(y);
  }
  return { res, jm: a._jmBytes, cm: o._cmBytes, sent };
}
for (const [c, an, want] of [[true, true, true], [true, false, false], [false, true, false], [false, false, false]]) {
  const { res, jm, cm, sent } = negotiate(c, an);
  ok(res.o && res.a && res.o.protocol === 'V34' && res.a.protocol === 'V34', `caller ${c}, answerer ${an}: V.34 agreed`);
  ok(res.o && res.a && res.o.lapm === want && res.a.lapm === want,
     `caller ${c}, answerer ${an}: LAPM settled ${want} at both ends — CM ${cm && cm.toString('hex')}, JM ${jm && jm.toString('hex')}`);
  ok(jm && jm.includes(0x2A) === want, `JM says it only when CM did and the answerer runs it`);
  // §8.2: "complete the current octet and associated start and stop bits and
  // then signal CJ": what precedes CJ on the line is whole CM octets.
  const at = sent.findIndex((v, k) => v === 0 && sent[k + 1] === 0 && sent[k + 2] === 0);
  ok(at > 0 && cm.includes(sent[at - 1]), `CJ follows a whole CM octet (0x${at > 0 ? sent[at - 1].toString(16) : '?'}), not one cut short`);
}

console.log('\n[CJ lost: the absence of CM ends JM]');
{
  // §8: "other criteria may be used to terminate transmission of JM, such as ...
  // the absence of CM for a suitably long period of time." The caller's CM, then
  // silence where its CJ should have been.
  const a = new V8Sequencer({ role: 'answer', parms: { modulations: ['V34'] } });
  let agreedAt = null, n = 0;
  a.on('agreed', () => { if (agreedAt === null) agreedAt = n; });
  a.start();
  const m = new V21Modulator(1);
  const cm = V8.buildCMBytes({ v34: true });
  for (let k = 0; k < 12; k++) { m.writeBits(new Array(10).fill(1)); m.write(cm); }
  let lastCm = null;
  for (let b = 0; b < 6 * 50 && agreedAt === null; b++) {
    const cmLeft = m._bits.length > 0;
    const x = cmLeft ? m.generate(160) : new Float32Array(160);
    if (cmLeft) lastCm = n + 160;
    a.generateAudio(160); a.receiveAudio(x); n += 160;
  }
  const after = agreedAt === null ? null : (agreedAt - lastCm) / 8;
  ok(after !== null && after > 150 && after < 400, `the answerer proceeded ${after && after.toFixed(0)} ms after the caller's CM stopped, with no CJ`);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
