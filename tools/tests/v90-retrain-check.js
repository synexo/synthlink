#!/usr/bin/env node
'use strict';
// tools/tests/v90-retrain-check.js — V.90's retrain (§9.5), whole modems, SynthLink
// against SynthLink, V.42 on, no Rust. bm-v90 [3] holds the same against BinModem.
//
//   node tools/tests/v90-retrain-check.js
//
// Two ModemDSPs in lockstep reach data mode with LAPM; one end asks for a retrain.
// Handshake answers a V.90 `retrain` with a fresh instance that enters Phase 2 at
// the retrain's step (resumeFrom), the far end hears its tone and does the same,
// and V.42, suspended meanwhile, carries the text written after over the same link.

const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const { wholeModem } = require(path.join(ROOT, 'tools', 'bridge', 'peer'));

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log(`  ok   ${msg}`); } else { fail++; console.log(`  FAIL ${msg}`); } }

for (const who of ['a', 'o']) {
  const name = who === 'a' ? 'the digital modem' : 'the analogue modem';
  console.log(`\n[${name} asks]`);
  const o = wholeModem('originate', 'V90'), a = wholeModem('answer', 'V90');
  const E = { o, a }, rx = { o: '', a: '' }, up = { o: [], a: [] };
  for (const k of ['o', 'a']) {
    E[k].on('ready', (i) => { up[k].push(i); E[k].write(Buffer.from(`${k.toUpperCase()} HELLO\r\n`)); });
    E[k].on('data', (d) => { rx[k] += d.toString('latin1'); });
  }
  const proto = (k) => E[k].dsp._handshake._protocol;
  let first = null, asked = null, wrote = false;
  for (let b = 0; b < 40 * 50; b++) {
    const t = b / 50;
    if (!first && up.o.length && up.a.length) first = { o: proto('o'), a: proto('a') };
    if (first && asked === null && t > 12) asked = proto(who).retrain();
    if (asked && !wrote && t > 30) { wrote = true; o.write(Buffer.from('O AFTER\r\n')); a.write(Buffer.from('A AFTER\r\n')); }
    const x = o.generateAudio(160), y = a.generateAudio(160);
    a.receiveAudio(x); o.receiveAudio(y);
  }
  ok(up.o[0] && up.o[0].errorControl === 'LAPM' && up.a[0] && up.a[0].errorControl === 'LAPM', 'both in data with LAPM first');
  ok(asked === true, 'the retrain was begun from data mode');
  ok(first && proto('o') !== first.o && proto('a') !== first.a, 'both ends retrained, each on a fresh instance (the far end on hearing the tone)');
  ok(proto('o').carrying && proto('a').carrying, 'both carrying again');
  ok(rx.o === 'A HELLO\r\nA AFTER\r\n' && rx.a === 'O HELLO\r\nO AFTER\r\n', `text exact both ways after, over the same V.42 link — ${JSON.stringify(rx)}`);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
