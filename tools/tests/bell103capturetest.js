'use strict';
// bell103capturetest — our Bell 103 demodulator against a REAL capture.
//
// Everything else that exercises Bell 103 here is a loopback: our modulator into
// our demodulator, which is the arrangement that cannot fail on a wrong constant
// because both ends read it. `tools/datasource/bell103-capture.wav` is not that.
// It is an outside recording of a Bell 103 call carrying a known sentence, so it
// can fail on a wrong mark frequency, a wrong space frequency, an inverted
// polarity, a wrong bit order, a wrong stop-bit count or a wrong baud — none of
// which a round trip can see.
//
// This is the only real-signal artefact for Bell 103 in the repo and it is worth
// more than its size. The whole receiver here is built for a lossless channel;
// this file is a small piece of evidence about what happens when the signal did
// not come from us.
//
// The capture: 5.43 s at 8 kHz, mono. 2100 Hz answer tone to 2.51 s, then the
// originate band's mark carrier, then 300 bps FSK from 3.52 s. The demodulator is
// constructed in the ANSWER role because that is the end that listens to the
// originate band (1070 space / 1270 mark).
//
//   node tools/tests/bell103capturetest.js
const fs = require('fs');
const path = require('path');
const { Bell103 } = require('../../vendor/src/dsp/protocols/Bell103');

const WAV = path.join(__dirname, '../../tools/datasource/bell103-capture.wav');
const EXPECT = 'This is a test. This is only a test. Do not be alarmed.';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log(`  FAIL ${m}`); } };

// Minimal RIFF reader: walk the chunks rather than assuming a 44-byte header,
// because a file written by a recorder often carries LIST/fact chunks first and
// a fixed offset would read those as samples.
function readWav(file) {
  const b = fs.readFileSync(file);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('bell103capturetest: not a RIFF/WAVE file');
  }
  let off = 12, fmt = null, data = null;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      fmt = { channels: b.readUInt16LE(off + 10), rate: b.readUInt32LE(off + 12),
              bits: b.readUInt16LE(off + 22) };
    } else if (id === 'data') {
      data = b.subarray(off + 8, off + 8 + size);
    }
    off += 8 + size + (size & 1);          // chunks are word-aligned
  }
  if (!fmt || !data) throw new Error('bell103capturetest: missing fmt or data chunk');
  return { fmt, data };
}

const { fmt, data } = readWav(WAV);
console.log('\nthe capture');
ok(fmt.rate === 8000, `8 kHz (got ${fmt.rate})`);
ok(fmt.channels === 1, `mono (got ${fmt.channels})`);
ok(fmt.bits === 16, `16-bit (got ${fmt.bits})`);

const n = Math.floor(data.length / 2);
const pcm = new Float32Array(n);
for (let i = 0; i < n; i++) pcm[i] = data.readInt16LE(i * 2) / 32768;
ok(n / fmt.rate > 4 && n / fmt.rate < 8, `about 5 s of audio (${(n / fmt.rate).toFixed(2)} s)`);

// ── decode it ───────────────────────────────────────────────────────────────
// Fed in 20 ms blocks, the size the transport actually delivers — a demodulator
// handed the whole file in one call can hide a state bug at a block boundary.
console.log('\ndecode');
const m = new Bell103('answer');
let out = '';
m.on('data', (b) => { out += b.toString('binary'); });
for (let i = 0; i < n; i += 160) m.receiveAudio(pcm.subarray(i, Math.min(i + 160, n)));

ok(out.length > 0, 'the demodulator produced bytes at all');
ok(out === EXPECT,
   `the sentence decodes byte for byte\n    want: ${JSON.stringify(EXPECT)}\n    got:  ${JSON.stringify(out)}`);
ok(out.length === EXPECT.length, `${EXPECT.length} bytes (got ${out.length})`);

// A negative control: the ORIGINATE role listens to the answer band, which this
// capture barely contains, so it must NOT produce the sentence. Without this the
// test above would pass on a demodulator that ignored its role entirely and
// listened to whatever was loudest.
console.log('\nnegative control');
const wrong = new Bell103('originate');
let wrongOut = '';
wrong.on('data', (b) => { wrongOut += b.toString('binary'); });
for (let i = 0; i < n; i += 160) wrong.receiveAudio(pcm.subarray(i, Math.min(i + 160, n)));
ok(wrongOut !== EXPECT,
   'the originate role does not decode the originate band — the roles are not symmetric');

console.log(`\n${fail === 0 ? 'OK' : 'FAILED'} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
