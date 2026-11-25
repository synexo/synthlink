#!/usr/bin/env node
'use strict';
// tools/tests/v22-level-check.js — V.22 and V.22bis at the edge of §4.4's
// receive range, whole modems, SynthLink against SynthLink, V.8 and V.42 on, no
// Rust.
//
//   node tools/tests/v22-level-check.js
//
// Each end transmits at −10 dBm0 and the line takes 32 dB, so each receives −42:
// inside −43, where circuit 109 must come ON. Three things stopped that:
//   - V.22bis's S1 detector and V.22's scrambled-binary-1 detector had their level
//     floors AT −43, which a −42 signal's 20 ms reading fell under often enough to
//     miss S1 (the caller stayed at 1200 while the answerer went to 2400) or to
//     hold the caller in SB1 for ever. Both are at −46 now, as V.21's is.
//   - The demodulator dropped carrier on the first sample under −48, where §3.2/
//     V.22bis has circuit 109 turn OFF 40 to 65 ms after the level falls; at −42
//     the 4 ms meter's dips on scrambled data restarted it mid-frame.
// And at −50, under −48, where it must not respond, neither end connects.
// BinModem is no reference here: its V.8 signals are 9 dB under its data, so
// at a fair data level its CM and ANSam reach us under −48.

const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const { wholeModem } = require(path.join(ROOT, 'tools', 'bridge', 'peer'));

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log(`  ok   ${msg}`); } else { fail++; console.log(`  FAIL ${msg}`); } }

function run(proto, lossDb, secs = 14) {
  const g = Math.pow(10, -lossDb / 20);
  const o = wholeModem('originate', proto), a = wholeModem('answer', proto);
  const up = {}, rx = { o: '', a: '' };
  o.on('ready', (i) => { up.o = i; o.write(Buffer.from('O SAYS HI\r\n')); });
  a.on('ready', (i) => { up.a = i; a.write(Buffer.from('A SAYS HI\r\n')); });
  o.on('data', (d) => { rx.o += d.toString('latin1'); });
  a.on('data', (d) => { rx.a += d.toString('latin1'); });
  for (let b = 0; b < secs * 50; b++) {
    const x = o.generateAudio(160), y = a.generateAudio(160);
    a.receiveAudio(x.map((v) => v * g)); o.receiveAudio(y.map((v) => v * g));
  }
  return { up, rx };
}

for (const [proto, bps] of [['V22bis', 2400], ['V22', 1200]]) {
  console.log(`\n[${proto} at −42 dBm0 each way]`);
  const { up, rx } = run(proto, 32);
  ok(up.o && up.a && up.o.bps === bps && up.a.bps === bps, `both at ${bps} — ${up.o && up.o.bps} / ${up.a && up.a.bps}`);
  ok(up.o && up.a && up.o.errorControl === 'LAPM' && up.a.errorControl === 'LAPM', 'both with LAPM');
  ok(rx.o === 'A SAYS HI\r\n' && rx.a === 'O SAYS HI\r\n', `text exact both ways — ${JSON.stringify(rx)}`);

  console.log(`\n[${proto} at −50 dBm0 each way]`);
  const q = run(proto, 40, 10);
  ok(!q.up.o && !q.up.a, 'neither end connects under −48');
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
