#!/usr/bin/env node
'use strict';
// tools/tests/v90-route-check.js — V.90 over a digital route that alters the
// codewords, SynthLink against SynthLink, whole modems with V.42, no Rust.
//
//   node tools/tests/v90-route-check.js
//
// What a SIP gateway hands an analogue modem is the codewords the network
// carried (tools/bridge/v90net.js, after BinModem's network model): the nearest
// codeword of the network's law, a T1's robbed bit in one octet of six, a digital
// pad scaling every level and requantising it. None is announced. Our analogue
// modem used to slice against exact µ-law levels and lost the call to any of
// them; it now learns the route from its DIL (V90Dil.js), chooses each interval's
// constellation from what arrived, inside the far end's Table 15 power, and
// slices against the levels it measured. The digital modem sends A-law when its
// network is A-law (config `v90Law`), and says so in INFO0d.
// bm-v90 [5] holds the analogue modem's half against BinModem's digital modem.

const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const config = require(path.join(ROOT, 'vendor', 'config'));
const { wholeModem } = require(path.join(ROOT, 'tools', 'bridge', 'peer'));
const { V90Net } = require(path.join(ROOT, 'tools', 'bridge', 'v90net'));
const DIL = require(path.join(ROOT, 'vendor', 'src', 'dsp', 'protocols', 'V90Dil'));
const P3 = require(path.join(ROOT, 'vendor', 'src', 'dsp', 'protocols', 'V90Phase3'));

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log(`  ok   ${msg}`); } else { fail++; console.log(`  FAIL ${msg}`); } }

// ── The analysis on its own: a DIL through each route, read as received ────────
console.log('\n[the DIL analysis (V90Dil)]');
for (const [name, route, want] of [
  ['clean µ-law', {}, (c) => c.data.drn === 22],
  ['a robbed bit in interval 2', { rbs: 2 }, (c) => c.data.constellations[2].length < c.data.constellations[0].length],
  ['a 6 dB pad', { padDb: 6 }, (c) => c.data.drn < 22],
]) {
  const net = new V90Net(route), desc = DIL.design('mu', 111), an = new DIL.Analysis();
  let k = 0;
  for (const seg of P3.dilSegments(desc)) for (const s of seg.syms) {
    an.feed(s.ucode, s.sign > 0, k++ % 6, net.downSample((s.sign > 0 ? 1 : -1) * DIL.linear('mu', s.ucode) / 32768));
  }
  const ch = DIL.choose(an.route(), 'mu', 0, () => true);
  ok(ch && want(ch), `${name}: ${ch ? `${Math.round((ch.data.drn + 20) * 8000 / 6)} down, interval sizes ${ch.data.constellations.map((x) => x.length).join(',')}` : 'no choice'}`);
}
{
  const desc = DIL.design('mu', 79), an = new DIL.Analysis();
  let k = 0;
  for (const seg of P3.dilSegments(desc)) for (const s of seg.syms) an.feed(s.ucode, s.sign > 0, k++ % 6, (s.sign > 0 ? 1 : -1) * DIL.linear('mu', s.ucode) / 32768);
  const ch = DIL.choose(an.route(), 'mu', 23, () => true);
  ok(ch && ch.data.constellations.every((set, i) => DIL.averagePower('mu', ch.data.constellations, ch.data.K) <= 4024 ** 2),
     'a −12 dBm0 server (INFO0d max power 23): the data set is inside Table 15\'s 4024');
}

// ── Whole calls ─────────────────────────────────────────────────────────────
function run(route, law) {
  config.modem.native.v90Law = law;
  const net = new V90Net(route);
  const o = wholeModem('originate', 'V90'), a = wholeModem('answer', 'V90');
  const up = {}, rx = { o: '', a: '' };
  for (const [k, m] of [['o', o], ['a', a]]) {
    m.on('ready', (i) => { up[k] = i; m.write(Buffer.from(`${k.toUpperCase()} SAYS HI 0123456789\r\n`)); });
    m.on('data', (d) => { rx[k] += d.toString('latin1'); });
  }
  for (let b = 0; b < 18 * 50; b++) {
    const x = o.generateAudio(160), y = a.generateAudio(160);
    a.receiveAudio(net.up(x)); o.receiveAudio(net.down(y));
  }
  config.modem.native.v90Law = undefined;
  return { up, rx };
}

for (const [name, route, law, least] of [
  ['clean', {}, 'mu', 56000],
  ['a robbed bit in interval 2', { rbs: 2 }, 'mu', 50000],
  ['a 6 dB pad', { padDb: 6 }, 'mu', 50000],
  ['A-law', { law: 'a' }, 'a', 56000],
  ['A-law, a 3 dB pad and a robbed bit in interval 5', { law: 'a', padDb: 3, rbs: 5 }, 'a', 50000],
]) {
  console.log(`\n[${name}]`);
  const { up, rx } = run(route, law);
  ok(up.o && up.a && up.o.errorControl === 'LAPM' && Math.round(up.o.bps) === Math.round(up.a.bps) && up.o.bps >= least - 1,
     `both in data with LAPM, the same rate, at least ${least} — ${up.o ? Math.round(up.o.bps) : 'no'} / ${up.a ? Math.round(up.a.bps) : 'no'}`);
  ok(rx.o === 'A SAYS HI 0123456789\r\n' && rx.a === 'O SAYS HI 0123456789\r\n', `text exact both ways — ${JSON.stringify(rx)}`);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
