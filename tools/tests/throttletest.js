#!/usr/bin/env node
// Unit tests for lib/throttle.js — the rate pacing on a telnet-bypass call.
//
//   node tools/tests/throttletest.js
//
// The pacer is driven on a clock this harness owns, so nothing here sleeps and
// nothing here is timing-sensitive: a real-clock test of a rate limiter is a
// flake generator, and one that passed by waiting would take as long as the
// traffic it is pacing. The clock seam is the `clock` option, which is the only
// reason it exists.
//
// What is actually asserted, in the order it matters:
//
//   • Nothing is DROPPED. Every byte pushed comes out the other side, in order,
//     however far ahead of the cap it arrived. A rate limiter that discards is
//     a corrupted BBS session, not a slow one.
//   • The sustained rate is the configured one, measured over a window long
//     enough that the burst allowance cannot pay for it.
//   • Interactive traffic is not delayed. A keystroke on an idle link goes out
//     in the same tick; the whole point of the burst is that a cap on a file
//     send must not become latency on a menu.
//   • Backpressure is edge-triggered with hysteresis. A source told to pause
//     once per chunk, or resumed the instant it dipped under the mark, is worse
//     than no backpressure at all.
//   • 0 means no cap, and means it synchronously — the disabled path must not
//     arm a timer or the operator who turned it off is still paying for it.

const { Pacer } = require('../../lib/throttle');

let pass = 0, fail = 0;
function eq(a, e, what) {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { pass++; return; }
  fail++;
  console.log(`  FAIL ${what}\n       expected ${E}\n       actual   ${A}`);
}
function ok(c, what) { if (c) { pass++; return; } fail++; console.log(`  FAIL ${what}`); }

// A clock with a queue of timers, advanced by hand. `advance` fires everything
// due in the span, in time order, so a pacer that re-arms its timer keeps
// running exactly as it would on a real one.
function fakeClock() {
  let t = 0, seq = 0;
  const timers = [];
  return {
    now: () => t,
    setTimer: (fn, ms) => { const h = { at: t + ms, fn, id: ++seq }; timers.push(h); return h; },
    clearTimer: (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); },
    advance(ms) {
      const until = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at || a.id - b.id);
        if (!timers.length || timers[0].at > until) break;
        const h = timers.shift();
        t = h.at;
        h.fn();
      }
      t = until;
    },
    pending: () => timers.length,
  };
}

// A pacer plus a recorder of everything it wrote.
function rig(bps, opts = {}) {
  const clock = fakeClock();
  const out = [];
  const events = [];
  const p = new Pacer({
    bps, clock,
    write: (b) => out.push(Buffer.from(b)),
    onFull: (on) => events.push(on),
    ...opts,
  });
  return { p, clock, out, events, sent: () => Buffer.concat(out) };
}

const BPS = 128000;                 // the shipped cap
const BYTES = BPS / 8;              // 16000 bytes/s

console.log('throttletest — bypass rate pacing\n');

// ── Nothing is dropped, and order is preserved ──────────────────────────────
// One second of traffic pushed in a single instant, then a generous wait. Every
// byte must arrive, and the payload is a counter so a reordering or a lost
// middle chunk fails on content rather than on length alone.
{
  const { p, clock, sent } = rig(BPS);
  const chunks = [];
  for (let i = 0; i < 40; i++) chunks.push(Buffer.alloc(1000, i & 0xff));
  for (const c of chunks) p.push(c);
  clock.advance(60000);
  const all = Buffer.concat(chunks);
  eq(sent().length, all.length, '40 KB pushed at once is 40 KB delivered');
  ok(sent().equals(all), 'and byte-for-byte in the order it was pushed');
  eq(p.queued(), 0, 'with nothing left queued');
}

// ── The sustained rate is the configured one ────────────────────────────────
// Measured over five seconds, which is forty times the burst window, so the
// banked allowance cannot account for more than a couple of percent of it. The
// tolerance is one burst either way and not a percentage: that is the actual
// bound the algorithm promises.
{
  const { p, clock, sent } = rig(BPS);
  p.push(Buffer.alloc(BYTES * 20));         // far more than five seconds' worth
  clock.advance(5000);
  const expect = BYTES * 5;
  const burst = BYTES * 0.125;
  ok(Math.abs(sent().length - expect) <= burst + 1,
     `five seconds delivers ~5 s of bytes (got ${sent().length}, expected ~${expect})`);
  ok(sent().length < BYTES * 20, 'and the rest is still queued rather than sent');
}

// A second cap, to show the number is read and not baked in.
{
  const { p, clock, sent } = rig(9600);
  p.push(Buffer.alloc(1000000));
  clock.advance(5000);
  ok(Math.abs(sent().length - 1200 * 5) <= 1200 * 0.125 + 1,
     `a 9600 bps cap delivers ~6000 bytes in five seconds (got ${sent().length})`);
}

// ── A keystroke is not delayed ──────────────────────────────────────────────
// The burst allowance exists for exactly this. On an idle link a small write
// must complete inside push(), with no timer armed at all — a menu that
// answered a tick late everywhere would be the cap being paid for by the
// traffic it was never meant to touch.
{
  const { p, clock, out } = rig(BPS);
  p.push(Buffer.from('A'));
  eq(out.length, 1, 'a single keystroke on an idle link goes out immediately');
  eq(clock.pending(), 0, 'and arms no timer');
  // A whole 80x25 screen redraw is inside the burst too.
  const { p: p2, clock: c2, sent } = rig(BPS);
  p2.push(Buffer.alloc(2000, 0x2e));
  eq(sent().length, 2000, 'and so does a 2 KB screen redraw');
  eq(c2.pending(), 0, 'still with no timer');
}

// ── The burst is banked, not accumulated without limit ──────────────────────
// An idle call must not become an entitlement. After a minute of silence the
// immediate allowance is still one burst, not a minute's worth — otherwise the
// cap would be trivially defeated by waiting.
{
  const { p, clock, sent } = rig(BPS);
  clock.advance(60000);
  p.push(Buffer.alloc(BYTES * 10));
  const burst = BYTES * 0.125;
  ok(sent().length <= burst + 1,
     `a minute idle still buys only one burst (got ${sent().length}, cap ${burst})`);
}

// ── Backpressure: edge-triggered, with hysteresis ───────────────────────────
// The queue is filled well past the mark in one go and then allowed to drain.
// Exactly one pause and one resume — a pacer that signalled per chunk would
// report four of each here, and one with no hysteresis would chatter as the
// queue crossed the mark on the way down.
{
  const { p, clock, events } = rig(BPS, { highWater: 8 * 1024 });
  for (let i = 0; i < 4; i++) p.push(Buffer.alloc(8 * 1024));
  eq(events, [true], 'a deep queue pauses the source exactly once');
  clock.advance(10000);
  eq(events, [true, false], 'and draining resumes it exactly once');
  eq(p.queued(), 0, 'with the queue empty');
}

// Under the mark, the source is never touched. A call that never outruns the
// cap must look to its sockets exactly as it did before this feature existed.
{
  const { p, clock, events } = rig(BPS, { highWater: 8 * 1024 });
  for (let i = 0; i < 20; i++) { p.push(Buffer.alloc(200)); clock.advance(50); }
  eq(events, [], 'traffic inside the cap never pauses anything');
}

// ── stop() ──────────────────────────────────────────────────────────────────
// Teardown, so the tail is dropped on purpose — but the timer must go with it,
// or a closed session keeps a wake-up alive on a socket nobody is on.
{
  const { p, clock, out } = rig(BPS);
  p.push(Buffer.alloc(BYTES * 4));
  const before = out.length;
  p.stop();
  eq(p.queued(), 0, 'stop() forgets the queue');
  eq(clock.pending(), 0, 'and clears its timer');
  clock.advance(10000);
  eq(out.length, before, 'and writes nothing after it');
  p.push(Buffer.alloc(100));
  eq(out.length, before, 'a push after stop() is ignored rather than throwing');
}

// ── 0 disables, synchronously ───────────────────────────────────────────────
// The disabled path is a straight write-through: no queue, no timer, no clock
// reads. An operator who turned this off must be back to the behaviour that
// predates it, not to a pacer with a very large number in it.
{
  const { p, clock, out, events, sent } = rig(0);
  const big = Buffer.alloc(10 * 1024 * 1024, 7);
  p.push(big);
  ok(p.unlimited, '0 bps is reported as no cap');
  eq(out.length, 1, '10 MB goes out in one write');
  eq(sent().length, big.length, 'whole');
  eq(clock.pending(), 0, 'with no timer armed');
  eq(events, [], 'and no backpressure signalled');
  eq(p.queued(), 0, 'and nothing queued');
}

// A negative cap is the disabled case too, not an inverted one: lib/site.js
// refuses it at boot, and a pacer reached with one anyway must fail safe open
// rather than block the call forever.
{
  const { p, out } = rig(-5);
  p.push(Buffer.from('hello'));
  eq(out.length, 1, 'a negative cap writes through rather than stalling the call');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
