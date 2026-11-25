#!/usr/bin/env node
'use strict';
// tools/tests/v32-retrain-check.js — V.32 §5.5 / V.32bis §7, retrain, SynthLink
// against SynthLink. Needs nothing built; bm-v32 holds the same against BinModem.
//
//   node tools/tests/v32-retrain-check.js
//
// The cue first, on its own: each role's RetrainWatch must fire on the far end's
// retrain signal after §5.5's 128 symbol intervals and not before, and never on
// its own role's signal or on data. Then whole calls through a noise burst: both
// ends find reception unsatisfactory, retrain at a rate the error leaves room for,
// and carry text again after it. A retrain whose S is lost in the noise is begun
// again rather than left waiting, and a clean call never retrains.

const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const P = path.join(ROOT, 'vendor', 'src', 'dsp', 'protocols');
const { RetrainWatch, RETRAIN_HELD } = require(path.join(P, 'V32Preface'));
const { lineDirection } = require(path.join(ROOT, 'tools', 'bridge', 'peer'));

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log(`  ok   ${msg}`); } else { fail++; console.log(`  FAIL ${msg}`); } }

const SR = 8000, SPS = SR / 2400;

// When a watch fires on `signal(n)`, in symbols, or null within `secs`.
function firesAt(role, signal, secs = 1) {
  const w = new RetrainWatch(role, SPS);
  for (let n = 0; n < secs * SR; n++) if (w.push(signal(n), n)) return n / SPS;
  return null;
}
const tone = (f, a = 0.1) => (n) => a * Math.cos(2 * Math.PI * f * n / SR);
const ac = (n) => tone(600, 0.07)(n) + tone(3000, 0.07)(n);     // AC: 600 and 3000, nothing at 1800
const aa = tone(1800, 0.1);                                      // AA: a bare 1800

console.log('[the cue: RetrainWatch]');
{
  const t = firesAt('originate', ac);
  ok(t !== null && t > RETRAIN_HELD && t < RETRAIN_HELD + 16, `call modem on AC: after ${t && t.toFixed(1)} T (more than ${RETRAIN_HELD})`);
  const u = firesAt('answer', aa);
  ok(u !== null && u > RETRAIN_HELD && u < RETRAIN_HELD + 16, `answer modem on AA: after ${u && u.toFixed(1)} T`);
  ok(firesAt('originate', aa) === null, 'call modem never on AA, its own signal');
  ok(firesAt('answer', ac) === null, 'answer modem never on AC, its own signal');
  // AC interrupted every 100 T is never held for 128.
  const broken = (n) => ((n / SPS) % 100 < 95 ? ac(n) : 0);
  ok(firesAt('originate', broken, 2) === null, 'a cue that breaks before 128 T does not fire');
}

/**
 * One SynthLink call in lockstep, each direction through `line(t)`'s choice of
 * noise. Each end writes HELLO on ready and AFTER on retrained.
 */
function call(cls, secs, noisy, prep) {
  const M = require(path.join(P, cls))[cls];
  const o = new M('originate'), a = new M('answer');
  const ends = { o, a };
  const log = { o: [], a: [] }, rx = { o: '', a: '' }, afterAt = { o: null, a: null };
  for (const k of ['o', 'a']) {
    const m = ends[k];
    m.setV8Complete(true);
    if (prep) prep(m);
    m.on('ready', () => m.write(Buffer.from(`${k.toUpperCase()} HELLO\r\n`)));
    m.on('retrain', (e) => log[k].push({ t: m._clockRx / SR, why: e.why }));
    m.on('retrained', (e) => { log[k].push({ t: m._clockRx / SR, retrained: e.bps }); afterAt[k] = rx[k].length; m.write(Buffer.from(`${k.toUpperCase()} AFTER\r\n`)); });
    m.on('data', (b) => { rx[k] += b.toString('latin1'); });
  }
  const clean = [lineDirection({ noiseDb: 60, seed: 1 }), lineDirection({ noiseDb: 60, seed: 2 })];
  const lines = {};
  for (let b = 0; b < secs * 50; b++) {
    const t = b / 50, db = noisy(t);
    const L = db == null ? clean : (lines[db] = lines[db] || [lineDirection({ noiseDb: db, seed: 3 }), lineDirection({ noiseDb: db, seed: 4 })]);
    const x = o.generateAudio(160), y = a.generateAudio(160);
    a.receiveAudio(L[0](x)); o.receiveAudio(L[1](y));
  }
  return { log, rx, afterAt, o, a };
}
const burst = (db, from, to) => (t) => (t >= from && t < to ? db : null);

for (const [cls, prep, db, rateBelow] of [
  ['V32', (m) => m.setTrellis(true), 25, 9600],
  ['V32bis', null, 25, 14400],
]) {
  console.log(`[${cls}: two seconds of noise at ${db} dB, from 5 s]`);
  const r = call(cls, 16, burst(db, 5, 7), prep);
  for (const k of ['o', 'a']) {
    const who = k === 'o' ? 'call modem' : 'answer modem';
    const began = r.log[k].find((e) => e.why);
    const done = r.log[k].find((e) => e.retrained);
    ok(began && began.why === 'unsatisfactory' && began.t > 5 && began.t < 7, `${who} found reception unsatisfactory — ${began ? `${began.why} at ${began.t.toFixed(2)} s` : 'no retrain'}`);
    ok(done && done.retrained < rateBelow, `${who} retrained below ${rateBelow} — ${done ? `${done.retrained} at ${done.t.toFixed(2)} s` : 'never'}`);
    const other = k === 'o' ? 'A' : 'O';
    const after = r.afterAt[k] == null ? '' : r.rx[k].slice(r.afterAt[k]);
    ok(r.rx[k].startsWith(`${other} HELLO\r\n`) && after === `${other} AFTER\r\n`,
       `${who} read the far end's text before, and exactly its text after — ${JSON.stringify(after)}`);
  }
}

console.log('[V32: the retrain begins in the noise and loses the far end\'s S]');
{
  // At 15 dB the retrain's own start-up fails inside the burst; begun again once
  // RETRAIN_PATIENCE has passed, it completes on the clean line after.
  const r = call('V32', 20, burst(15, 5, 7));
  for (const k of ['o', 'a']) {
    const who = k === 'o' ? 'call modem' : 'answer modem';
    const whys = r.log[k].filter((e) => e.why).map((e) => e.why);
    const done = r.log[k].find((e) => e.retrained);
    ok(whys.includes('stalled') && done, `${who}: ${whys.join(', ')}, then retrained at ${done ? done.retrained : '—'}`);
    const other = k === 'o' ? 'A' : 'O';
    ok(r.afterAt[k] != null && r.rx[k].slice(r.afterAt[k]) === `${other} AFTER\r\n`, `${who} carries text after it`);
  }
}

console.log('[a clean call never retrains]');
for (const cls of ['V32', 'V32bis']) {
  const r = call(cls, 10, () => null);
  ok(!r.log.o.length && !r.log.a.length && r.rx.o === 'A HELLO\r\n' && r.rx.a === 'O HELLO\r\n',
     `${cls}: no retrain in 10 s, text exact both ways`);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
