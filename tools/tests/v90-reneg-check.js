#!/usr/bin/env node
'use strict';
// tools/tests/v90-reneg-check.js — V.90's rate renegotiation (§9.6), whole modems,
// SynthLink against SynthLink, V.42 on, no Rust. bm-v90 [4] holds the digital
// modem's half against BinModem's analogue modem.
//
//   node tools/tests/v90-reneg-check.js
//
// Two ModemDSPs in lockstep reach data mode with LAPM, then one end renegotiates
// in place, the data frames kept in step (§9.6): the analogue modem with S, S̄ and
// CP on the upstream, the digital modem with Rd and R̄d on the downstream, and
// Phase 4's tail from there. The text written after crosses the same V.42 link,
// and no retrain is taken. Then §9.6.1's timeout: a digital modem whose Rd is
// not answered retrains (§9.5.1.1), and the call comes back.

const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const { wholeModem } = require(path.join(ROOT, 'tools', 'bridge', 'peer'));

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log(`  ok   ${msg}`); } else { fail++; console.log(`  FAIL ${msg}`); } }

function run(who, max, { deafAnalogue = false, secs = 30 } = {}) {
  const o = wholeModem('originate', 'V90'), a = wholeModem('answer', 'V90');
  const E = { o, a }, rx = { o: '', a: '' }, ev = [];
  for (const k of ['o', 'a']) {
    E[k].on('ready', (i) => { ev.push(`${k} ready ${i.errorControl}`); E[k].write(Buffer.from(`${k.toUpperCase()} HELLO\r\n`)); });
    E[k].on('data', (d) => { rx[k] += d.toString('latin1'); });
  }
  const proto = (k) => E[k].dsp._handshake._protocol;
  const hooked = new Set();
  let asked = null, wrote = false, first = null;
  for (let b = 0; b < secs * 50; b++) {
    const t = b / 50;
    for (const k of ['o', 'a']) {
      const p = proto(k);
      if (p && !hooked.has(p)) {
        hooked.add(p);
        p.on('renegotiate', (e) => ev.push(`${k} renegotiate ${e.why}`));
        p.on('renegotiated', (e) => ev.push(`${k} renegotiated ${Math.round(e.bps)}/${e.bpsUpstream}`));
        p.on('retrain', (e) => ev.push(`${k} retrain ${e.why}`));
      }
    }
    if (!first && proto('o') && proto('a') && proto('o').carrying && proto('a').carrying) first = { o: proto('o'), a: proto('a') };
    if (first && asked === null && t > 12) {
      if (deafAnalogue) proto('o')._rdMagsNow = null;      // hears no Rd, so never answers
      asked = proto(who).renegotiate(max);
    }
    if (asked && !wrote && t > secs - 8) { wrote = true; o.write(Buffer.from('O AFTER\r\n')); a.write(Buffer.from('A AFTER\r\n')); }
    const x = o.generateAudio(160), y = a.generateAudio(160);
    a.receiveAudio(x); o.receiveAudio(y);
  }
  return { ev, rx, asked, first, now: { o: proto('o'), a: proto('a') } };
}

const exact = (rx) => rx.o === 'A HELLO\r\nA AFTER\r\n' && rx.a === 'O HELLO\r\nO AFTER\r\n';

{
  console.log('\n[the analogue modem asks for 40 000 down (§9.6.2.1)]');
  const r = run('o', 40000);
  ok(r.asked === true, 'begun from data mode with LAPM up');
  ok(r.ev.includes('o renegotiate asked') && r.ev.includes('a renegotiate far end'), 'the digital modem answered its S (§9.6.1.2)');
  ok(Math.round(r.now.o.bps) === 40000 && Math.round(r.now.a.bps) === 40000, `both at 40 000 down — ${Math.round(r.now.o.bps)} / ${Math.round(r.now.a.bps)}`);
  ok(r.now.o === r.first.o && r.now.a === r.first.a && !r.ev.some((e) => / retrain /.test(e)), 'in place: no retrain, the same instances');
  ok(exact(r.rx), `text exact both ways after, over the same V.42 link — ${JSON.stringify(r.rx)}`);
}
{
  console.log('\n[the digital modem asks, upstream at most 24 000 (§9.6.1.1)]');
  const r = run('a', 24000);
  ok(r.ev.includes('a renegotiate asked') && r.ev.includes('o renegotiate far end'), 'the analogue modem answered its Rd (§9.6.2.2)');
  ok(r.now.o.bpsUpstream === 24000 && r.now.a.bpsUpstream === 24000, `both at 24 000 up — ${r.now.o.bpsUpstream} / ${r.now.a.bpsUpstream}`);
  ok(Math.round(r.now.o.bps) === 56000, 'the downstream is the analogue modem\'s choice, and stays');
  ok(r.now.o === r.first.o && !r.ev.some((e) => / retrain /.test(e)), 'in place: no retrain');
  ok(exact(r.rx), `text exact both ways after — ${JSON.stringify(r.rx)}`);
}
{
  console.log('\n[the digital modem asks, and the analogue modem never hears Rd (§9.6.1)]');
  const r = run('a', 24000, { deafAnalogue: true, secs: 40 });
  ok(r.ev.includes('a retrain asked'), `no E within 5 s and two round trips: a retrain (§9.5.1.1) — ${r.ev.join(', ')}`);
  ok(r.now.a !== r.first.a && r.now.o !== r.first.o && r.now.o.carrying && r.now.a.carrying, 'both retrained onto fresh instances and carry again');
  ok(exact(r.rx), `text exact both ways after — ${JSON.stringify(r.rx)}`);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
