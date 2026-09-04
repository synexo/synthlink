'use strict';
// Protocol-unit loopback: two V32 instances wired generateAudio<->receiveAudio
// with Int16 quantization + RX jitter, no ModemDSP/Handshake. Verifies the pure
// DSP: 16-QAM constellation, differential encoding, role-asymmetric scrambler,
// UART framing, training/acquisition, continuous decode, and the rate exchange.
const { V32 } = require('../../vendor/src/dsp/protocols/V32');

function wire(f) { const o = new Float32Array(f.length); for (let n = 0; n < f.length; n++) { let s = Math.max(-1, Math.min(1, f[n])); o[n] = ((s * 32767) | 0) / 32768; } return o; }
function jitter(dst, f32) { let o = 0; while (o < f32.length) { const n = 1 + Math.floor(Math.random() * 50); dst.receiveAudio(f32.subarray(o, Math.min(f32.length, o + n))); o += n; } }

function run(label, payloadAB, payloadBA) {
  const A = new V32('originate'), B = new V32('answer');
  let rA = [], rB = [], readyA = false, readyB = false;
  A.on('ready', () => { readyA = true; });
  B.on('ready', () => { readyB = true; });
  A.on('data', d => { for (const x of d) rA.push(x); });
  B.on('data', d => { for (const x of d) rB.push(x); });

  const BLOCK = 160; let wroteAB = false, wroteBA = false;
  for (let iter = 0; iter < 4000; iter++) {
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
  console.log(`  ready A=${readyA} B=${readyB}   peerRate A=${A.peerRate} B=${B.peerRate}`);
  console.log(`  A->B ${okAB ? 'OK ✅' : 'FAIL ❌'} (${rB.length}B)  got=${JSON.stringify(gotAB.slice(0, 48))}`);
  console.log(`  B->A ${okBA ? 'OK ✅' : 'FAIL ❌'} (${rA.length}B)  got=${JSON.stringify(gotBA.slice(0, 48))}`);
  return okAB && okBA && readyA && readyB && A.peerRate === 9600 && B.peerRate === 9600;
}

let all = true;
all &= run('short', 'Hello, V.32!\r\n', 'BBS banner ready>\r\n');
all &= run('longer', 'The quick brown fox jumps over the lazy dog 0123456789 '.repeat(6),
                     'ANSI \x1b[2J\x1b[H terminal stream '.repeat(6));
console.log(`\n=== ${all ? 'ALL PASS ✅' : 'FAILURES ❌'} ===`);
process.exit(all ? 0 : 1);
