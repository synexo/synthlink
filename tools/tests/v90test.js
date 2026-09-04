'use strict';
/**
 * v90test — protocol-unit loopback for V.90.
 *
 * Two V90 instances wired generateAudio↔receiveAudio with the real Int16
 * transport quantisation and RX chunk jitter, no ModemDSP/Handshake. Exercises
 * the whole asymmetric link:
 *
 *   originate (analogue modem) → answer (digital modem)   genuine V.34 @ 33600
 *   answer (digital modem) → originate (analogue modem)   PCM codewords @ 56000
 *
 * and, in particular, that Phase 4 is load-bearing: the digital modem stays
 * silent until CP arrives over the upstream and tells it which constellation,
 * shaper coefficients and lookahead depth to use.
 *
 * Run: node tools/tests/v90test.js
 */
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const { V90 } = require(path.join(ROOT, 'vendor/src/dsp/protocols/V90'));
const { ucodesFromMask } = require(path.join(ROOT, 'vendor/src/dsp/protocols/V90Mapper'));
const config = require(path.join(ROOT, 'vendor/config'));

function wire(f) {
  const o = new Float32Array(f.length);
  for (let n = 0; n < f.length; n++) { const s = Math.max(-1, Math.min(1, f[n])); o[n] = ((s * 32767) | 0) / 32768; }
  return o;
}
function jitter(dst, f32) {
  let o = 0;
  while (o < f32.length) {
    const n = 1 + Math.floor(Math.random() * 50);
    dst.receiveAudio(f32.subarray(o, Math.min(f32.length, o + n)));
    o += n;
  }
}

function run(label, payloadDown, payloadUp, opts = {}) {
  const A = new V90('originate');       // analogue modem — browser side
  const B = new V90('answer');          // digital modem — server side
  let rA = [], rB = [], readyA = false, readyB = false;
  let readyIterA = -1, readyIterB = -1;
  A.on('ready', () => { readyA = true; });
  B.on('ready', () => { readyB = true; });
  A.on('data', d => { for (const x of d) rA.push(x); });
  B.on('data', d => { for (const x of d) rB.push(x); });

  const BLOCK = 160;
  let wroteDown = false, wroteUp = false, iters = 0;
  for (let iter = 0; iter < 9000; iter++) {
    iters = iter;
    const a = wire(A.generateAudio(BLOCK));
    const b = wire(B.generateAudio(BLOCK));
    jitter(B, a); jitter(A, b);
    if (readyA && readyIterA < 0) readyIterA = iter;
    if (readyB && readyIterB < 0) readyIterB = iter;
    if (readyA && readyB && !wroteDown) { B.write(Buffer.from(payloadDown, 'latin1')); wroteDown = true; }
    if (readyA && readyB && !wroteUp) { A.write(Buffer.from(payloadUp, 'latin1')); wroteUp = true; }
    if (wroteDown && wroteUp && rA.length >= payloadDown.length && rB.length >= payloadUp.length) break;
  }
  const gotDown = Buffer.from(rA).toString('latin1');
  const gotUp = Buffer.from(rB).toString('latin1');
  const okDown = gotDown.startsWith(payloadDown);
  const okUp = gotUp.startsWith(payloadUp);

  console.log(`\n[${label}]`);
  console.log(`  ready: analogue=${readyA} (iter ${readyIterA}) digital=${readyB} (iter ${readyIterB})`);
  console.log(`  rates: downstream ${A.bps} / upstream ${A.bpsUpstream}   (digital reports ${B.bps})`);
  console.log(`  CP applied on digital modem: ${B._cpApplied}  ` +
              `constellation Mᵢ=${B.C ? B.C[0].M : '—'}  lₐ=${B.lookahead}  ` +
              `b₁=${B.coefs.b1}`);
  console.log(`  down (digital→analogue, PCM 56k) ${okDown ? 'OK ✅' : 'FAIL ❌'} ` +
              `(${rA.length}B) got=${JSON.stringify(gotDown.slice(0, 48))}`);
  console.log(`  up   (analogue→digital, V.34 33.6k) ${okUp ? 'OK ✅' : 'FAIL ❌'} ` +
              `(${rB.length}B) got=${JSON.stringify(gotUp.slice(0, 48))}`);
  return okDown && okUp && readyA && readyB;
}

let all = true;

console.log('──────── V.90 · 56000 down / 33600 up ────────');
// payloads stay inside latin1 — the byte path is 8-bit clean, but a multi-byte
// character would be mangled by Buffer.from(str,'latin1') before it ever reached
// the modem, and would look like a protocol failure when it is a test artifact.
all &= run('short', 'SynthLink BBS - V.90 at 56000 bit/s\r\n', 'user keystrokes\r\n');
all &= run('longer',
  'ANSI \x1b[2J\x1b[H downstream at fifty-six kilobits per second 0123456789 '.repeat(40),
  'The quick brown fox jumps over the lazy dog '.repeat(6));

// ── Phase 4 really is load-bearing ──────────────────────────────────────────
// Change the constellation the analogue modem asks for and confirm the digital
// modem adopts it. If CP were decorative this would either be ignored or break.
console.log('\n──────── CP negotiation: a different constellation ────────');
config.modem.native.v90UcodeMin = 30;          // 98 levels instead of 91
config.modem.native.v90Lookahead = 3;
config.modem.native.v90B1 = -0.5;
all &= run('CP: Ucode≥30, lₐ=3, b₁=−0.5',
           'renegotiated constellation carries data\r\n', 'ack\r\n');
delete config.modem.native.v90UcodeMin;
delete config.modem.native.v90Lookahead;
delete config.modem.native.v90B1;

// ── Rate ladder (Table 2/V.90) ──────────────────────────────────────────────
// The rate and the shaping redundancy are carried in CP as drn and Sr, which
// between them pin (K,S). Sr=0 is the interesting edge: no spectral shaping at
// all, all six sign bits carrying data.
console.log('\n──────── rate ladder ────────');
{
  const M = require(path.join(ROOT, 'vendor/src/dsp/protocols/V90Mapper'));
  const cases = [
    { rate: 56000, Sr: undefined, label: '56000 default' },
    { rate: 56000, Sr: 0, label: '56000 Sr=0 (no shaping)' },
    { rate: 56000, Sr: 1, label: '56000 Sr=1' },
    { rate: 44000, Sr: undefined, label: '44000' },
    { rate: 28000, Sr: 0, label: '28000 Sr=0' },
    { rate: M.legalRates()[5], Sr: undefined, label: 'a fractional rung' },
  ];
  for (const c of cases) {
    config.modem.native.v90Rate = c.rate;
    if (c.Sr == null) delete config.modem.native.v90Sr; else config.modem.native.v90Sr = c.Sr;
    const cfg = M.makeConfig(c.rate, c.Sr);
    const okRun = run(`${c.label} → K=${cfg.K} S=${cfg.S} drn=${cfg.drn}`,
                      `payload at ${Math.round(cfg.bitRate)}\r\n`, 'up\r\n');
    all &= okRun;
  }
  delete config.modem.native.v90Rate;
  delete config.modem.native.v90Sr;
}

// ── Acquisition phase sweep ─────────────────────────────────────────────────
// The Sd repetition {+W,+0,+W,-W,-0,-W} is antisymmetric under a three-symbol
// shift: shifting by 3 reproduces the sign-inverted pattern exactly. A hunt that
// accepts either polarity therefore pins the frame phase only mod 3 and can lock
// three symbols early, splitting every frame across the Sd/data boundary. That
// is a real bug this code had. Replay one captured downstream at every starting
// offset so any phase ambiguity shows up as a decode failure.
console.log('\n──────── acquisition: every starting phase ────────');
{
  const PAYLOAD = 'phase sweep payload 0123456789\r\n';
  const A0 = new V90('originate'), B0 = new V90('answer');
  const captured = [];
  let wrote = false, readyA0 = false, readyB0 = false;
  A0.on('ready', () => { readyA0 = true; }); B0.on('ready', () => { readyB0 = true; });
  for (let i = 0; i < 1500; i++) {
    const a = wire(A0.generateAudio(160));
    const b = wire(B0.generateAudio(160));
    B0.receiveAudio(a); A0.receiveAudio(b);
    captured.push(b);
    if (readyA0 && readyB0 && !wrote) { B0.write(Buffer.from(PAYLOAD, 'latin1')); wrote = true; }
  }
  const stream = new Float32Array(captured.reduce((n, c) => n + c.length, 0));
  { let o = 0; for (const c of captured) { stream.set(c, o); o += c.length; } }
  console.log(`captured ${stream.length} downstream samples carrying the payload`);

  let allPhases = true;
  for (let k = 0; k < 12; k++) {
    const R = new V90('originate');
    const got = [];
    R.on('data', d => { for (const x of d) got.push(x); });
    const shifted = stream.subarray(k);
    for (let o = 0; o < shifted.length; o += 160) {
      R.receiveAudio(shifted.subarray(o, Math.min(shifted.length, o + 160)));
    }
    const text = Buffer.from(got).toString('latin1');
    const good = text.includes(PAYLOAD);
    if (!good) allPhases = false;
    console.log(`  offset ${String(k).padStart(2)} (phase ${k % 6}): ` +
                `${good ? 'OK ✅' : 'FAIL ❌'}  dataStart=${R.dataStart} ${got.length}B`);
  }
  all &= allPhases;
}

// ── TX level sanity ─────────────────────────────────────────────────────────
{
  const M = new V90('answer');
  // drive it far enough to be in data mode — needs CP, so pair it with a peer
  const P = new V90('originate');
  for (let i = 0; i < 1200; i++) {
    const a = wire(P.generateAudio(160)); const b = wire(M.generateAudio(160));
    M.receiveAudio(a); P.receiveAudio(b);
  }
  M.write(Buffer.from('x'.repeat(20000)));
  let sum = 0, cnt = 0, peak = 0;
  for (let i = 0; i < 200; i++) {
    const a = M.generateAudio(160);
    for (const v of a) { sum += v * v; cnt++; peak = Math.max(peak, Math.abs(v)); }
  }
  console.log(`\ndownstream TX level: RMS ${Math.sqrt(sum / cnt).toFixed(4)}  peak ${peak.toFixed(4)}`);
  console.log('  (V.90 downstream is full-amplitude PCM, unlike the ~0.1 RMS of the');
  console.log('   modulated protocols — the codewords ARE the samples.)');
}

console.log(`\n=== ${all ? 'ALL PASS ✅' : 'FAILURES ❌'} ===`);
process.exit(all ? 0 : 1);
