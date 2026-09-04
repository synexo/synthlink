'use strict';
// Protocol-unit loopback: two V34 instances wired generateAudio<->receiveAudio
// with Int16 quantization + RX jitter, no ModemDSP/Handshake. Verifies the pure
// V.34 DSP: genuine grid constellation, role-asymmetric scrambler, UART framing,
// acquire-once/free-run receiver, continuous decode, and the rate exchange.
const { V34 } = require('../../vendor/src/dsp/protocols/V34');
const config = require('../../vendor/config');

// Rate is selected per-call via the shared config singleton (as the server/client
// do). Sweep all four: both ends read the same rate and must agree end-to-end.
function setRate(bps) { config.modem.native.v34Rate = bps; }
let EXP_BPS = 33600;

function wire(f) { const o = new Float32Array(f.length); for (let n = 0; n < f.length; n++) { let s = Math.max(-1, Math.min(1, f[n])); o[n] = ((s * 32767) | 0) / 32768; } return o; }
function jitter(dst, f32) { let o = 0; while (o < f32.length) { const n = 1 + Math.floor(Math.random() * 50); dst.receiveAudio(f32.subarray(o, Math.min(f32.length, o + n))); o += n; } }

function run(label, payloadAB, payloadBA) {
  const A = new V34('originate'), B = new V34('answer');
  let rA = [], rB = [], readyA = false, readyB = false;
  A.on('ready', () => { readyA = true; });
  B.on('ready', () => { readyB = true; });
  A.on('data', d => { for (const x of d) rA.push(x); });
  B.on('data', d => { for (const x of d) rB.push(x); });

  const BLOCK = 160; let wroteAB = false, wroteBA = false;
  for (let iter = 0; iter < 6000; iter++) {
    const a = wire(A.generateAudio(BLOCK));
    const b = wire(B.generateAudio(BLOCK));
    jitter(B, a); jitter(A, b);
    if (readyA && readyB && !wroteAB) { A.write(Buffer.from(payloadAB, 'latin1')); wroteAB = true; }
    if (readyA && readyB && !wroteBA) { B.write(Buffer.from(payloadBA, 'latin1')); wroteBA = true; }
    if (wroteAB && wroteBA && rB.length >= payloadAB.length && rA.length >= payloadBA.length) break;
  }
  const gotAB = Buffer.from(rB).toString('latin1');
  const gotBA = Buffer.from(rA).toString('latin1');
  const okAB = gotAB.startsWith(payloadAB), okBA = gotBA.startsWith(payloadBA);
  console.log(`\n[${label}]`);
  console.log(`  ready A=${readyA} B=${readyB}   peerRate A=${A.peerRate} B=${B.peerRate}   bps A=${A.bps} B=${B.bps}`);
  console.log(`  A->B ${okAB ? 'OK ✅' : 'FAIL ❌'} (${rB.length}B)  got=${JSON.stringify(gotAB.slice(0, 48))}`);
  console.log(`  B->A ${okBA ? 'OK ✅' : 'FAIL ❌'} (${rA.length}B)  got=${JSON.stringify(gotBA.slice(0, 48))}`);
  return okAB && okBA && readyA && readyB && A.peerRate === EXP_BPS && B.peerRate === EXP_BPS;
}

// measure TX data-burst RMS at a given rate (sanity for squelch/gain tuning)
function measureRMS(bps) {
  setRate(bps);
  const M = new V34('originate');
  for (let i = 0; i < 400; i++) M.generateAudio(160);          // run past handshake into data
  M.write(Buffer.from('x'.repeat(8000)));
  let sum = 0, cnt = 0;
  for (let i = 0; i < 200; i++) { const a = M.generateAudio(160); for (const v of a) { sum += v * v; cnt++; } }
  console.log(`  ${bps}: TX data RMS ≈ ${Math.sqrt(sum / cnt).toFixed(4)} (target ~0.1)`);
}
console.log('TX level check:');
for (const bps of [28800, 31200, 33600]) measureRMS(bps);

let all = true;
for (const bps of [28800, 31200, 33600]) {
  setRate(bps); EXP_BPS = bps;
  console.log(`\n──────── V.34 @ ${bps} ────────`);
  all &= run(`${bps} short`, 'Hello, V.34 speed test!\r\n', 'BBS banner ready>\r\n');
  all &= run(`${bps} longer`, 'The quick brown fox jumps over the lazy dog 0123456789 '.repeat(8),
                              'ANSI \x1b[2J\x1b[H terminal stream at high speed '.repeat(8));
}
console.log(`\n=== ${all ? 'ALL PASS ✅' : 'FAILURES ❌'} ===`);
process.exit(all ? 0 : 1);
