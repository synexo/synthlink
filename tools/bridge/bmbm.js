#!/usr/bin/env node
'use strict';
// tools/bridge/bmbm.js — BinModem against BinModem, through peer.js's own line
// model. DEVELOPMENT ONLY, like the rest of the bridge.
//
//   CONDS='[{"lossDb":10,"noiseDb":60,"disperse":{"tiltDb":8,"edgeDelayMs":1}}]' \
//     PROTO=v34 SECS=12 node tools/bridge/bmbm.js
//
// The control for any new line condition. When one of our receivers fails on a
// line, this says whether the LINE is fair: if two BinModems cross it, the gap is
// ours. It found that V.34 at 12 dB of tilt and 2 ms of delay is 33 600 both ways
// for BinModem, which is what put V.34's least-squares solve on PP in our receiver.
// Both ends run at BinModem's own +3 dBm0, 13 dB above a modem: to compare a RATE
// with a call() at bmOutDb −13, lower noiseDb by 13 (12/2 is then 24 000).
// Each condition is { lossDb, noiseDb, disperse }, as call()'s options.

const path = require('path');
const { spawn } = require('child_process');
const { available, BIN, BLOCK, lineDirection, lineFilter, firStream } = require(path.join(__dirname, 'peer'));
function peer(args) {
  const c = spawn(BIN, [...args, '--block', String(BLOCK)], { stdio: ['pipe','pipe','pipe'] });
  const st = { c, pending: Buffer.alloc(0), ev: [], err: '', waiter: null };
  c.stdout.on('data', b => { st.pending = Buffer.concat([st.pending, b]); if (st.waiter) st.waiter(); });
  c.stderr.on('data', b => { st.err += b; let nl; while ((nl = st.err.indexOf('\n')) >= 0) { const l = st.err.slice(0, nl); st.err = st.err.slice(nl+1); try { st.ev.push(JSON.parse(l)); } catch {} } });
  return st;
}
const read = st => new Promise(res => { const chk = () => { if (st.pending.length >= 4*BLOCK) { const b = st.pending.subarray(0, 4*BLOCK); st.pending = st.pending.subarray(4*BLOCK); st.waiter = null; const f = new Float32Array(BLOCK); for (let k=0;k<BLOCK;k++) f[k]=b.readFloatLE(4*k); res(f); } else st.waiter = chk; }; chk(); });
const write = (st, f) => { const b = Buffer.alloc(4*BLOCK); for (let k=0;k<BLOCK;k++) b.writeFloatLE(f[k], 4*k); st.c.stdin.write(b); };
(async () => {
  const av = available();
  if (!av.ok) { console.log(`SKIP bmbm: ${av.reason}`); process.exit(0); }
  const conds = JSON.parse(process.env.CONDS || '[{}]');
  const proto = process.env.PROTO || 'v34';
  // MAX_RATE caps what V.32bis offers at both ends, for a lower-rate call.
  const cap = process.env.MAX_RATE ? ['--max-rate', process.env.MAX_RATE] : [];
  const delay = process.env.SEND_DELAY || '1';
  for (const d of conds) {
    // `echo` (linear gain) and `echoDelay` (samples): a 2-wire line, each BinModem
    // hearing its own transmit back through its own hybrid (bmpeer --echo).
    const hyb = d.echo ? ['--echo', String(d.echo), '--echo-delay', String(d.echoDelay || 8)] : [];
    const A = peer(['--proto', proto, '--role', 'call', '--send', 'CALLER SAYS HI\r\n', '--send-delay', delay, ...cap, ...hyb]);
    const B = peer(['--proto', proto, '--role', 'answer', '--send', 'ANSWER SAYS HI\r\n', '--send-delay', delay, ...cap, ...hyb]);
    const fAB = d.disperse ? firStream(lineFilter(d.disperse)) : (x => x), fBA = d.disperse ? firStream(lineFilter(d.disperse)) : (x => x);
    const lAB = lineDirection({ lossDb: d.lossDb, noiseDb: d.noiseDb, seed: 1 }), lBA = lineDirection({ lossDb: d.lossDb, noiseDb: d.noiseDb, seed: 2 });
    let toA = new Float32Array(BLOCK), toB = new Float32Array(BLOCK);
    for (let b = 0; b < (+process.env.SECS || 12) * 8000 / BLOCK; b++) {
      write(A, toA); write(B, toB);
      const outA = await read(A), outB = await read(B);
      toB = lAB(fAB(outA)); toA = lBA(fBA(outB));
    }
    A.c.stdin.end(); B.c.stdin.end();
    await new Promise(r => setTimeout(r, 300));
    const rx = st => { const h = st.ev.filter(e => e.ev === 'rx').map(e => e.hex).join(''); return Buffer.from(h, 'hex').toString('latin1'); };
    const conn = st => (st.ev.find(e => e.ev === 'connected') || {}).status || 'no connect';
    console.log(JSON.stringify(d).padEnd(64), '| call:', conn(A).slice(0,40), JSON.stringify(rx(A).slice(0,20)), '| answer:', conn(B).slice(0,40), JSON.stringify(rx(B).slice(0,20)));
  }
})();
