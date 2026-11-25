#!/usr/bin/env node
'use strict';
// tools/tests/v34-retrain-check.js — V.34 §11.5 retrain and §11.6 renegotiation, SynthLink against
// SynthLink. Needs nothing built; bm-v34 [9] holds the same against BinModem.
//
//   node tools/tests/v34-retrain-check.js
//
// The cue first, on its own: each role's watch must fire on the far end's tone
// once it has stood more than 50 ms (§11.5.1.2, §11.5.2.2), and never on its own
// role's tone, on data, or on a tone that breaks off sooner. Then whole calls:
// either end asking, and a noise burst that leaves the receivers unable to hold
// the rate, after which both carry text again. A clean call never retrains. Last,
// §11.6's renegotiation begun by either end, whose S the other finds in data, and
// start-up bounds whose expiry is now a retrain.

const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const P = path.join(ROOT, 'vendor', 'src', 'dsp', 'protocols');
const { V34 } = require(path.join(P, 'V34'));
const { lineDirection } = require(path.join(ROOT, 'tools', 'bridge', 'peer'));

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log(`  ok   ${msg}`); } else { fail++; console.log(`  FAIL ${msg}`); } }

const SR = 8000;

// When `role`'s watch fires on `signal(n)`, in ms, or null within `secs`.
function firesAt(role, signal, secs = 1) {
  const m = new V34(role);
  for (let n = 0; n < secs * SR; n++) if (m._retrainWatch(signal(n))) return n * 1000 / SR;
  return null;
}
const tone = (f, a = 0.1) => (n) => a * Math.cos(2 * Math.PI * f * n / SR + 0.3);
// Tone A as §10.1.2.1 sends it: 1 dB under its 1800 Hz guard, which is at nominal.
const A = (n) => tone(2400, 0.1 * Math.pow(10, -1 / 20))(n) + tone(1800, 0.1)(n), B = tone(1200);

console.log('[the cue]');
{
  const t = firesAt('originate', A);
  ok(t !== null && t > 50 && t < 70, `call modem on tone A: after ${t && t.toFixed(1)} ms (more than 50)`);
  const u = firesAt('answer', B);
  ok(u !== null && u > 50 && u < 70, `answer modem on tone B: after ${u && u.toFixed(1)} ms`);
  ok(firesAt('originate', B) === null, 'call modem never on tone B, its own');
  ok(firesAt('answer', A) === null, 'answer modem never on tone A, its own');
  ok(firesAt('originate', tone(2400, 0.0005)) === null, 'a tone under −43 dBm0 is not a retrain');
  ok(firesAt('originate', tone(1800)) === null, 'the guard alone is not tone A');
  // 30 ms of tone, 20 ms off: never held for 50.
  const broken = (n) => ((n % 400) < 240 ? A(n) : 0);
  ok(firesAt('originate', broken, 2) === null, 'a tone that breaks before 50 ms does not fire');
}

/**
 * One SynthLink call in lockstep, each direction through `noisy(t)`'s noise.
 * Each end writes HELLO on ready and AFTER on retrained; `act(t, ends)` runs per block.
 */
function call(secs, noisy, act) {
  const o = new V34('originate'), a = new V34('answer');
  const ends = { o, a };
  const log = { o: [], a: [] }, rx = { o: '', a: '' }, afterAt = { o: null, a: null }, bps = { o: [], a: [] };
  for (const k of ['o', 'a']) {
    const m = ends[k];
    m.setV8Complete(true);
    m.on('ready', (e) => { bps[k].push(e.bps); m.write(Buffer.from(`${k.toUpperCase()} HELLO\r\n`)); });
    m.on('retrain', (e) => log[k].push(e.why));
    m.on('retrained', (e) => { bps[k].push(e.bps); afterAt[k] = rx[k].length; m.write(Buffer.from(`${k.toUpperCase()} AFTER\r\n`)); });
    m.on('data', (b) => { rx[k] += b.toString('latin1'); });
  }
  const clean = [lineDirection({ noiseDb: 60, seed: 1 }), lineDirection({ noiseDb: 60, seed: 2 })];
  const lines = {};
  for (let b = 0; b < secs * 50; b++) {
    const t = b / 50, db = noisy(t);
    const L = db == null ? clean : (lines[db] = lines[db] || [lineDirection({ noiseDb: db, seed: 3 }), lineDirection({ noiseDb: db, seed: 4 })]);
    if (act) act(t, ends);
    const x = o.generateAudio(160), y = a.generateAudio(160);
    a.receiveAudio(L[0](x)); o.receiveAudio(L[1](y));
  }
  return { log, rx, afterAt, bps };
}
const quiet = () => null;
const after = (r, k, text) => r.afterAt[k] !== null && r.rx[k].slice(r.afterAt[k]).includes(text);

console.log('\n[a clean call]');
{
  const r = call(10, quiet);
  ok(r.log.o.length === 0 && r.log.a.length === 0, `no retrain on a clean line — ${JSON.stringify(r.log)}`);
  ok(r.rx.o === 'A HELLO\r\n' && r.rx.a === 'O HELLO\r\n', 'text exact both ways');
}

for (const who of ['o', 'a']) {
  const name = who === 'o' ? 'call' : 'answer';
  console.log(`\n[the ${name} modem asks]`);
  let asked = false;
  const r = call(18, quiet, (t, ends) => { if (!asked && t >= 6) { asked = true; ends[who].retrain(); } });
  const other = who === 'o' ? 'a' : 'o';
  ok(r.log[who][0] === 'asked' && r.log[other][0] === 'far end', `it began, the far end answered its tone — ${JSON.stringify(r.log)}`);
  ok(after(r, 'o', 'A AFTER\r\n') && after(r, 'a', 'O AFTER\r\n'), `text exact both ways after — ${JSON.stringify(r.rx)}`);
  ok(r.rx.o.startsWith('A HELLO\r\n') && r.rx.a.startsWith('O HELLO\r\n') &&
     r.rx.o === 'A HELLO\r\nA AFTER\r\n' && r.rx.a === 'O HELLO\r\nO AFTER\r\n',
     'nothing else: the silence before the tone is clamped (circuit 104), not decoded');
}

console.log('\n[a noise burst]');
{
  // A second at 25 dB, a few seconds into data mode.
  const r = call(20, (t) => (t >= 7 && t < 8 ? 25 : null));
  const all = [...r.log.o, ...r.log.a];
  ok(all.includes('unsatisfactory'), `a receiver found the rate unheld and asked — ${JSON.stringify(r.log)}`);
  ok(r.log.o.length >= 1 && r.log.a.length >= 1, 'both ends retrained');
  ok(after(r, 'o', 'A AFTER\r\n') && after(r, 'a', 'O AFTER\r\n'), `text exact both ways after — rates ${JSON.stringify(r.bps)}`);
}

console.log('\n[a start-up bound expires (§11.2.2, §11.3.2, §11.4.2)]');
for (const [from, to, what] of [[0.9, 1.8, 'no INFO1a (§11.2.2.1.6)'], [1.6, 3.0, 'no J (§11.3.2.1.1)'], [2.1, 3.5, 'no Phase 4 S (§11.4.2.1.1)']]) {
  // The line swamped for over a second: a bound expires, and its action is now a
  // retrain, which the far end answers in start-up too. Both reach data and carry
  // text after.
  const r = call(25, (t) => (t >= from && t < to ? 5 : null));
  const all = [...r.log.o, ...r.log.a];
  ok(all.includes(what.replace(/ \(.*/, '')), `${what}: the bound expired and was answered with a retrain — ${JSON.stringify(r.log)}`);
  // A retrain in start-up comes back to the link's first `ready`, not a `retrained`.
  ok(r.rx.o === 'A HELLO\r\n' && r.rx.a === 'O HELLO\r\n' && r.bps.o.length === 1 && r.bps.a.length === 1,
     `${what}: both reach data once, text exact — rates ${JSON.stringify(r.bps)}, ${JSON.stringify(r.rx)}`);
}

for (const who of ['o', 'a']) {
  const name = who === 'o' ? 'call' : 'answer';
  console.log(`\n[the ${name} modem renegotiates (§11.6)]`);
  let asked = false;
  const r = call(12, quiet, (t, ends) => { if (!asked && t >= 6) { asked = true; ends[who].renegotiate(24000); } });
  const other = who === 'o' ? 'a' : 'o';
  ok(r.log[who][0] === 'renegotiate' && r.log[other][0] === 'far end renegotiates', `it began, the far end found its S inside data and followed — ${JSON.stringify(r.log)}`);
  ok(r.bps.o.slice(-1)[0] === 24000 && r.bps.a.slice(-1)[0] === 24000, `both at 24 000 — ${JSON.stringify(r.bps)}`);
  ok(r.rx.o === 'A HELLO\r\nA AFTER\r\n' && r.rx.a === 'O HELLO\r\nO AFTER\r\n',
     `text exact both ways after, nothing else — ${JSON.stringify(r.rx)}`);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
