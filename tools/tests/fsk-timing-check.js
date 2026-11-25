#!/usr/bin/env node
'use strict';
// tools/tests/fsk-timing-check.js — the FSK receivers' bit timing, with nothing
// else running: characters sent back to back after a long mark idle, at every
// phase of the transmitter's bit grid against the receiver's samples.
//
//   node tools/tests/fsk-timing-check.js        FSK_DIR=<dir> to test another tree
//
// Back to back is the hard case: one stop bit, then the next start bit, so a stop
// vote that runs late lands in it and the frame is dropped. The first character
// after an idle is the late one, its start edge detected against filters charged
// by the mark. A synthetic signal does not reproduce it (a written byte starts on
// the modulator's own grid, so only three phases exist), so the second half is
// the real thing: what our V.21 answerer heard in a dsptest2 call that lost the
// caller's first character, one second of mark and then "hi\r" back to back
// (tools/tests/vectors/v21-first-char.s16, 16-bit at 8 kHz). Timed from the
// start edge alone, the old receiver read it as "i\r", one call in four.

const path = require('path');
const DIR = process.env.FSK_DIR || path.join(__dirname, '..', '..');
const P = (f) => path.join(DIR, 'vendor', 'src', 'dsp', 'protocols', f);
const { V21Modulator, V21Demodulator } = require(P('V21'));
const B103 = require(P('Bell103'));

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log(`  ok   ${msg}`); } else { fail++; console.log(`  FAIL ${msg}`); } }

const TEXT = Buffer.from('hi\r\nyou said: hi\r\n');

/** One run: `lead` samples of mark, the text back to back, mark after; what decodes. */
function run(Mod, Dem, txCh, rxCh, lead) {
  const mod = new Mod(txCh), dem = new Dem(rxCh);
  const got = [];
  dem.on('data', (d) => got.push(...d));
  dem.process(mod.generate(16000 + lead));          // two seconds of idle, and the phase
  mod.write(TEXT);
  for (let k = 0; k < 40; k++) dem.process(mod.generate(160));
  return Buffer.from(got);
}

for (const [name, Mod, Dem, txCh, rxCh] of [
  ['V.21 channel 1 (caller)', V21Modulator, V21Demodulator, 1, 2],
  ['V.21 channel 2 (answerer)', V21Modulator, V21Demodulator, 2, 1],
  ['Bell 103 originate', B103.Bell103Modulator, B103.Bell103Demodulator, 1, 2],
  ['Bell 103 answer', B103.Bell103Modulator, B103.Bell103Demodulator, 2, 1],
]) {
  if (!Mod || !Dem) { ok(false, `${name}: classes not found`); continue; }
  const bad = [];
  for (let lead = 0; lead < 27; lead++) {
    const got = run(Mod, Dem, txCh, rxCh, lead);
    if (!got.equals(TEXT)) bad.push(`${lead}:${JSON.stringify(got.toString('latin1').slice(0, 8))}`);
  }
  ok(bad.length === 0, `${name}: every phase of the bit grid decodes exactly${bad.length ? ` — failed at ${bad.slice(0, 6).join(' ')}` : ''}`);
}

{
  const fs = require('fs');
  const b = fs.readFileSync(path.join(__dirname, 'vectors', 'v21-first-char.s16'));
  const pcm = new Int16Array(b.buffer, b.byteOffset, b.length / 2);
  const x = Float32Array.from(pcm, (v) => v / 32768);
  const dem = new V21Demodulator(2); const got = [];
  dem.on('data', (d) => got.push(...d));
  for (let i = 0; i < x.length; i += 160) dem.process(x.subarray(i, i + 160));
  const text = Buffer.from(got).toString('latin1');
  ok(text === 'hi\r', `a real call's first character after an idle is not lost — ${JSON.stringify(text)}`);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
