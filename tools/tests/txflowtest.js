#!/usr/bin/env node
// Unit tests for the modem path's transmit-queue flow control:
// `txPending` on every protocol, and the pause/resume rule in server.js.
//
//   node tools/tests/txflowtest.js
//
// Why this exists. The modem path had no backpressure at all: `transportWrite`
// handed the board's bytes straight to `dsp.write()`, and the DSP's transmit
// queue was the only record of the difference between what a board sends and
// what a carrier can carry. A board outruns Bell 103 by a factor of 100000, so
// that queue grew until V8 refused to grow the array — `RangeError: Invalid
// array length` at 112.8M elements, thrown synchronously inside the telnet
// socket's data handler, which reaches uncaughtException and takes down every
// call on the server. See DEVLOG.md.
//
// What is asserted, and why in this shape:
//
//   • `txPending` is in PAYLOAD BYTES for every protocol, which means each
//     class divides by its own framing. Three different divisors are in play
//     (10 for the FSK trio, 11 for V.22's two stop bits, 1 for the byte-queue
//     protocols) and the caller must not need to know which. A test that only
//     checked "depth goes up" would pass on all three being wrong.
//   • V.90 reports through the role split its own `write()` makes. The analogue
//     modem queues nothing locally — it hands bytes to its V.34 instance — so
//     reading `txByteQ` for both roles reports an upstream that is never
//     draining as permanently empty. That is the same mirror `setPhase3Lead`
//     and `setPhase2Profile` exist for, and it is asserted per role rather than
//     inferred.
//   • The depth FALLS as audio is generated. A depth that only ever rises would
//     satisfy every assertion above and still pause a board forever.
//   • The pause/resume rule is edge-triggered with hysteresis, and is driven
//     here on synthetic state rather than through a socket. `modemFlow` and
//     `setModemWindow` are extracted from server.js BY NAME, so renaming one
//     throws instead of testing a stale copy — the same trick clicktest and
//     embedtest use on public/main.js.
//
// Deliberately NOT a round trip. Whether the two ends agree says nothing about
// whether the queue is measured in the unit the transport compares against a
// threshold, which is the only thing here that can be wrong.

const fs   = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function eq(a, e, what) {
  if (Object.is(a, e)) { pass++; return; }
  fail++;
  console.log(`  FAIL ${what}\n       expected ${e}\n       actual   ${a}`);
}
function ok(c, what) { if (c) { pass++; return; } fail++; console.log(`  FAIL ${what}`); }

const P = (f) => path.join(__dirname, '..', '..', 'vendor', 'src', 'dsp', 'protocols', f);

// ─── 1. txPending is payload bytes, per protocol ────────────────────────────
// The expected value is the framing arithmetic written out, not a number copied
// from a run: N bytes at 10 bits each is ceil(10N/10), which is N — the point
// being that the DIVISOR matches the framing the class transmits, so a class
// that forgot to divide reports 10x and fails here.

console.log('1. txPending reports payload bytes');

const N = 100;
const bytes = Buffer.alloc(N, 0x41);

// The FSK trio: start + 8 data + stop = 10 bits to the byte.
for (const [file, cls] of [['V21.js', 'V21'], ['V23.js', 'V23'], ['Bell103.js', 'Bell103']]) {
  const C = require(P(file))[cls];
  for (const role of ['originate', 'answer']) {
    const p = new C(role);
    eq(p.txPending, 0, `${cls}/${role} starts empty`);
    p.write(bytes);
    eq(p.txPending, N, `${cls}/${role} reports ${N} bytes for ${N} written (10-bit framing)`);
  }
}

// V.22 and V.22bis: start + 8 data + TWO stop bits = 11 bits to the byte. The
// divisor differs from the trio above and this is the only thing that says so.
{
  const V22mod = require(P('V22.js'));
  for (const cls of ['V22', 'V22bis']) {
    const p = new V22mod[cls]('answer');
    eq(p.txPending, 0, `${cls} starts empty`);
    p.write(bytes);
    eq(p.txPending, N, `${cls} reports ${N} bytes for ${N} written (11-bit framing)`);
    // The raw queue is the cross-check: 11 bits per byte, so a class that
    // divided by 10 would report 110 and one that forgot would report 1100.
    eq(p.modulator._bitQueue.length, N * 11, `${cls} queued 11 bits per byte`);
  }
}

// The byte-queue protocols: txByteQ holds payload bytes already.
for (const [file, cls] of [['V29.js', 'V29'], ['V32.js', 'V32'],
                           ['V32bis.js', 'V32bis'], ['V34.js', 'V34']]) {
  const C = require(P(file))[cls];
  const p = new C('answer');
  eq(p.txPending, 0, `${cls} starts empty`);
  p.write(bytes);
  eq(p.txPending, N, `${cls} reports ${N} bytes for ${N} written`);
}

// ─── 2. V.90 reports through its own role split ─────────────────────────────
// §9's asymmetry is real: the digital modem queues codewords locally, the
// analogue modem hands its bytes to a V.34 instance. `txPending` has to follow
// `write()` into the same branch or one of the two roles reports zero forever
// — and it is the ANALOGUE side, whose upstream is the slow half.

console.log('2. V.90 reports for both roles');
{
  const { V90 } = require(P('V90.js'));
  const digital = new V90('answer');
  const analogue = new V90('originate');
  ok(digital.isDigital, 'the answer side is the digital modem');
  ok(!analogue.isDigital, 'the originate side is the analogue modem');

  digital.write(bytes);
  eq(digital.txPending, N, 'V90 digital reports its own queue');

  analogue.write(bytes);
  eq(analogue.txPending, N, 'V90 analogue reports its V.34 upstream, not an empty local queue');
  eq(analogue.txByteQ.length, 0, 'V90 analogue queues nothing locally (the trap this guards)');
}

// ─── 3. The depth falls as audio is generated ───────────────────────────────
// Every assertion above is satisfied by a counter that only rises. The
// transport resumes a paused board on this number coming down, so a queue that
// reports its high-water mark rather than its depth pauses a board for good.

console.log('3. txPending falls as the carrier drains it');
{
  const { Bell103 } = require(P('Bell103.js'));
  const p = new Bell103('answer');
  p.write(Buffer.alloc(50, 0x41));
  const before = p.txPending;
  // 300 baud at 8 kHz is 26.67 samples a bit: 8000 samples is 300 bits, which
  // is 30 bytes of the 50 queued. Asserted as a fall rather than at an exact
  // value — the fractional-accumulator timing means the boundary lands where
  // it lands, and pinning it would be testing the accumulator, not this.
  p.generateAudio(8000);
  const after = p.txPending;
  ok(after < before, `depth falls with audio generated (${before} → ${after})`);
  ok(after > 0, 'and one second of 300 bps has not drained 50 bytes');
  p.generateAudio(8000 * 4);
  eq(p.txPending, 0, 'the queue empties once there has been carrier enough for it');
}

// ─── 4. The server's pause/resume rule ──────────────────────────────────────
// Extracted from server.js by name and driven on a synthetic dsp/sock. The two
// functions close over `dsp`, `sock` and the three flow variables, so they are
// lifted together with those declarations and handed test doubles.

console.log('4. server.js pauses and resumes the board');
{
  const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');

  function grab(sig, what) {
    const start = SRC.indexOf(sig);
    if (start < 0) throw new Error(`txflowtest: ${what} not found in server.js`);
    let depth = 0;
    for (let j = SRC.indexOf('{', start); j < SRC.length; j++) {
      if (SRC[j] === '{') depth++;
      else if (SRC[j] === '}' && --depth === 0) return SRC.slice(start, j + 1);
    }
    throw new Error(`txflowtest: unbalanced braces reading ${what}`);
  }
  const secs = SRC.match(/^  const MODEM_QUEUE_SECONDS = .*?;$/m);
  if (!secs) throw new Error('txflowtest: MODEM_QUEUE_SECONDS not found in server.js');

  const build = new Function('dsp', 'sock', [
    secs[0],
    'let modemHigh = 0, modemLow = 0, modemFull = false;',
    grab('function setModemWindow(', 'setModemWindow'),
    grab('function modemFlow(', 'modemFlow'),
    'return { setModemWindow, modemFlow, window: () => [modemHigh, modemLow], full: () => modemFull };',
  ].join('\n'));

  // Ten seconds of carrier in payload bytes. At ten bits to the byte the
  // threshold is the bps number itself, which is what makes these readable.
  for (const [bps, high] of [[300, 300], [1200, 1200], [14400, 14400], [56000, 56000]]) {
    const f = build({ txPending: 0 }, null);
    f.setModemWindow(bps);
    eq(f.window()[0], high, `${bps} bps gives a ${high}-byte high-water (10 s of carrier)`);
    eq(f.window()[1], Math.floor(high / 2), `${bps} bps resumes at half of it`);
  }

  // The hysteresis, on a Bell 103 window. A source told to pause once per chunk
  // — or resumed the instant it dipped under the mark — is worse than none.
  const log = [];
  const dsp  = { txPending: 0 };
  const sock = { destroyed: false, pause: () => log.push('pause'), resume: () => log.push('resume') };
  const f = build(dsp, sock);
  f.setModemWindow(300);                       // high 300, low 150

  dsp.txPending = 299; f.modemFlow();
  eq(log.length, 0, 'nothing said one byte under the high-water');
  dsp.txPending = 300; f.modemFlow();
  eq(log.join(','), 'pause', 'the board is paused AT the high-water');
  dsp.txPending = 900; f.modemFlow();
  dsp.txPending = 400; f.modemFlow();
  eq(log.join(','), 'pause', 'and is not paused again while it stays deep');
  dsp.txPending = 151; f.modemFlow();
  eq(log.join(','), 'pause', 'nor resumed one byte above the low-water');
  dsp.txPending = 150; f.modemFlow();
  eq(log.join(','), 'pause,resume', 'the board resumes AT the low-water');
  dsp.txPending = 149; f.modemFlow();
  eq(log.join(','), 'pause,resume', 'and is not resumed again while it stays shallow');
  ok(!f.full(), 'and the flag follows');

  // A window that was never set is a call that never connected. Gating on it is
  // what keeps this off the direct path, which has a pacer of its own.
  const log2 = [];
  const g = build({ txPending: 1e9 },
                  { destroyed: false, pause: () => log2.push('pause'), resume: () => {} });
  g.modemFlow();
  eq(log2.length, 0, 'no window set (never connected) → nothing is paused');

  // Teardown races the drain: the audio callback fires on a block that was
  // already queued, and the socket may be gone by then.
  const h = build({ txPending: 1e9 }, { destroyed: true, pause: () => { throw new Error('paused a dead socket'); } });
  h.setModemWindow(300);
  h.modemFlow();
  pass++;   // reaching here without throwing is the assertion
}

console.log(`\ntxflowtest: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
