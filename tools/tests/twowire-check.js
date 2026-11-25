#!/usr/bin/env node
'use strict';
// tools/tests/twowire-check.js — 2-wire mode (TwoWire.js: the line's echo and
// loss) and the paired clocks under it (ClockPair.js), each on its own, then
// whole calls over ModemDSP's real-time pump.
//
//   node tools/tests/twowire-check.js            ONLY=V32bis,V34 to narrow it
//
// The model first, because a call that fails on a model that is not what its
// options say proves nothing: an impulse sent comes back at the near and far
// delays and losses, and a re-base puts it in the new frame. Then two ModemDSPs,
// browser and server, each synthesising its own echo, with dsptest2's jittered
// delivery between them. The split-band protocols must survive on their filters
// alone. The full-duplex ones survive only through their echo cancellers, which
// is the point of the mode, so the canceller's own figures are asserted, and a
// negative control runs V.32bis with the canceller held off: it must fail.

const config = require('../../vendor/synthlink-config');
const { ModemDSP } = require('../../vendor/src/dsp/ModemDSP');
const { ClockPair } = require('../../vendor/src/dsp/ClockPair');
const { twoWire } = require('../../vendor/src/dsp/TwoWire');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log(`  ok   ${msg}`); } else { fail++; console.log(`  FAIL ${msg}`); } }

const LINE = { enabled: true, nearLossDb: -12, nearDelayMs: 1, farLossDb: -24, farDelayMs: 20, lineLossDb: -10 };

console.log('[the line, and the clocks]');
{
  const w = new ClockPair(twoWire(LINE));
  const imp = new Float32Array(400); imp[0] = 1;
  w.sent(imp);
  const heard = w.received(new Float32Array(400));
  const near = heard[8], far = heard[160];
  ok(Math.abs(near - Math.pow(10, -12 / 20)) < 1e-6 && Math.abs(far - Math.pow(10, -24 / 20)) < 1e-6,
     `an impulse comes back at 1 ms (${near.toFixed(3)}) and 20 ms (${far.toFixed(3)}), at −12 and −24 dB`);
  ok(heard.reduce((n, v, k) => n + (v !== 0 && k !== 8 && k !== 160 ? 1 : 0), 0) === 0, 'and nowhere else');
  // The clocks: received sample n waits for transmit sample n, then comes out.
  const early = w.received(Float32Array.from([1]));
  ok(early.length === 0, 'a sample received ahead of our transmit is held');
  const then = w.sent(new Float32Array(1));
  ok(then.length === 1 && Math.abs(then[0] - Math.pow(10, -10 / 20)) < 1e-6, 'and comes out when it is sent, the far end\'s signal 10 dB down');
  // A re-base: the next sample each way is sample 0 of a new frame.
  w.rebase();
  const imp2 = new Float32Array(20); imp2[0] = 1; w.sent(imp2);
  const h2 = w.received(new Float32Array(20));
  ok(Math.abs(h2[8] - Math.pow(10, -12 / 20)) < 1e-6, 're-based, the echo is at 1 ms in the new frame');
  // A re-base while receive is behind transmit (the far end's audio in flight):
  // sample 0 is the same instant both ways, so a receive sample that left with
  // transmit sample k is receive sample k of the new frame, not shifted by the lag.
  {
    const c = new ClockPair();
    c.sent(new Float32Array(100));
    c.received(new Float32Array(94));          // six samples still in flight
    c.rebase();
    c.sent(new Float32Array(20));               // the new frame's transmit 0..19
    const late = Float32Array.from({ length: 26 }, (_, i) => (i < 6 ? -1 : i - 6));
    const got = c.received(late);               // 6 from the old frame, then frame 0..19
    ok(got.length === 20 && got[0] === 0 && got[19] === 19,
       `re-based with receive 6 behind: receive sample k is transmit sample k's instant (${got.length} out, first ${got[0]})`);
  }
  // A 4-wire line: the clocks alone, the signal untouched.
  const four = new ClockPair(null);
  four.sent(new Float32Array(10));
  const s4 = four.received(Float32Array.from([0.5, 0.25]));
  ok(s4.length === 2 && s4[0] === 0.5 && s4[1] === 0.25, 'on 4-wire the line is untouched: only the clocks are paired');
}

function jitterDeliver(dst, f32) {
  let o = 0;
  while (o < f32.length) { const n = 1 + Math.floor(Math.random() * 60); dst.receiveAudio(f32.subarray(o, Math.min(f32.length, o + n))); o += n; }
}

/** One call, both ends in 2-wire mode; resolves with what came through and each end's canceller. */
function call(PROTO, secs, opts = {}) {
  return new Promise((resolve) => {
    config.modem.native.protocolPreference = [PROTO];
    config.modem.native.v8ModulationModes = [PROTO];
    config.modem.native.twoWire = { ...LINE, ...(opts.line || {}) };
    const A = new ModemDSP('originate'), B = new ModemDSP('answer');
    config.modem.native.twoWire = { ...LINE, enabled: false };
    if (opts.noCanceller) {
      for (const m of [A, B]) {
        const sel = m._handshake._selectProtocol.bind(m._handshake);
        m._handshake._selectProtocol = (...a) => { const r = sel(...a); const p = m._handshake._protocol; if (p && p.setEchoCanceller) p.setEchoCanceller(false); return r; };
      }
    }
    const rx = { A: '', B: '' };
    let up = 0, done = false;
    A.on('audioOut', (f) => jitterDeliver(B, f));
    B.on('audioOut', (f) => jitterDeliver(A, f));
    A.on('connected', () => { if (++up === 2) both(); });
    B.on('connected', () => { if (++up === 2) both(); });
    A.on('data', (d) => { rx.A += d.toString('latin1'); });
    B.on('data', (d) => { rx.B += d.toString('latin1'); });
    function both() {
      setTimeout(() => { if (done) return; A.write(Buffer.from('CALLER HELLO\r\n')); B.write(Buffer.from('ANSWER HELLO\r\n')); }, 1500);
      setTimeout(finish, 5000);
    }
    const ec = (m) => { const p = m._handshake._protocol; return p && p._ec ? { kept: p._ec.kept, db: p._ec.trainedDb, far: p._ec.farLag } : null; };
    function finish() {
      if (done) return; done = true;
      const r = { up, rx, ecA: ec(A), ecB: ec(B) };
      try { A.stop(); B.stop(); } catch (_) {}
      resolve(r);
    }
    setTimeout(finish, secs * 1000);
    A.start(); B.start();
  });
}

const only = process.env.ONLY ? process.env.ONLY.split(',') : null;
const want = (p) => !only || only.includes(p);

(async () => {
  console.log('[split-band: the filters are enough]');
  for (const P of ['V21', 'V22', 'V22bis']) {
    if (!want(P)) continue;
    const r = await call(P, P === 'V21' ? 30 : 20);
    ok(r.up === 2 && r.rx.A === 'ANSWER HELLO\r\n' && r.rx.B === 'CALLER HELLO\r\n',
       `${P}: both connected, text exact both ways under our own echo — ${JSON.stringify(r.rx)}`);
  }

  console.log('[full-duplex: the cancellers do it]');
  for (const P of ['V32', 'V32bis', 'V34']) {
    if (!want(P)) continue;
    const r = await call(P, 24);
    const fmt = (e) => (e ? `${e.kept ? 'kept' : 'cleared'} ${e.db == null ? '—' : e.db.toFixed(1)} dB, far run at ${e.far}` : 'none');
    ok(r.ecA && r.ecB && r.ecA.kept && r.ecB.kept && r.ecA.db > 20 && r.ecB.db > 20 && r.ecA.far != null && r.ecB.far != null,
       `${P}: both cancellers trained, near and far runs — caller ${fmt(r.ecA)}; answerer ${fmt(r.ecB)}`);
    ok(r.up === 2 && r.rx.A === 'ANSWER HELLO\r\n' && r.rx.B === 'CALLER HELLO\r\n',
       `${P}: both connected, text exact both ways — ${JSON.stringify(r.rx)}`);
  }

  // §4.4/V.22bis: circuit 109 ON above −43 dBm0. With the far end 31 dB down
  // (−41 dBm0) and no echo, and 25 dB down under the default 2-wire echo, a real
  // V.22bis modem still connects; ours missed both at the old hot thresholds.
  console.log('[the receive floor: V.22 and V.22bis far down the line]');
  for (const P of ['V22', 'V22bis']) {
    if (!want(P)) continue;
    for (const [what, line] of [['31 dB of loss, no echo', { lineLossDb: -31, nearLossDb: -90, farLossDb: -90 }], ['25 dB of loss under the 2-wire echo', { lineLossDb: -25 }]]) {
      const r = await call(P, 30, { line });
      ok(r.up === 2 && r.rx.A === 'ANSWER HELLO\r\n' && r.rx.B === 'CALLER HELLO\r\n', `${P}, ${what}: both connected, text exact both ways — ${JSON.stringify(r.rx)}`);
    }
  }

  if (want('control')) {
    console.log('[negative control: V.32bis with the canceller held off]');
    const r = await call('V32bis', 24, { noCanceller: true });
    ok(!(r.up === 2 && r.rx.A === 'ANSWER HELLO\r\n' && r.rx.B === 'CALLER HELLO\r\n'),
       `the same line defeats it, as it must — ${r.up} ends up, ${JSON.stringify(r.rx).slice(0, 60)}`);
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
