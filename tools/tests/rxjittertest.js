#!/usr/bin/env node
// tools/tests/rxjittertest.js — public/rxjitter.js on a clock the harness owns.
//
//   node tools/tests/rxjittertest.js
//
// Same reasoning as throttletest.js: a real-clock test of a component whose
// entire job is timing is a flake generator and takes as long as the audio it
// paces. The `clock` option is the seam and exists for this.
//
// What is actually worth asserting here is not "does it delay things" — that is
// the easy half and a wrong implementation passes it. It is the two properties
// the transport makes non-negotiable, both of which follow from the link being
// TCP:
//
//   CONSERVATION — every sample pushed comes out, in order, exactly once. A
//   buffer that dropped a late frame would leave a hole in a carrier the
//   receiver is tracking, and the round trip would still complete, and nothing
//   anywhere would say so.
//
//   NO INVENTION — nothing comes out that did not go in. An RTP buffer conceals
//   a lost packet with silence; here a late frame is not lost, so manufactured
//   samples would corrupt a stream that is currently perfect. §6 below is the
//   one that fails a buffer written from VoIP habit, and it is deliberately an
//   IDENTITY check rather than a count: silence inserted in the right quantity
//   passes a count.
//
// The wiring — that a call actually builds one of these and tears it down with
// the modem — is not asserted here and cannot be: a buffer proved in isolation
// says nothing about which sockets it was attached to. That lives with the
// paths that own it, exactly as throttletest leaves the Pacer's wiring to
// directtest §4c.

const path = require('path');
const { RxJitter, SR, BLOCK, TICK_MS, CATCHUP_FRAMES, MAX_EXCESS_FRAMES } =
  require(path.join(__dirname, '..', '..', 'public', 'rxjitter.js'));

let pass = 0, fail = 0;
function ok(cond, what) {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${what}`);
}
function eq(got, want, what) { ok(got === want, `${what} (got ${got}, want ${want})`); }
function section(n) { console.log(n); }

// ─── A clock the harness owns ───────────────────────────────────────────────
// setTimer is setInterval-shaped, because that is what the module asks for.
function makeClock() {
  let t = 0, seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { fn, ms, due: t + ms }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    // Step time in 1 ms increments so every interval that falls due inside the
    // span fires, in order, at the instant it was due rather than at the end.
    advance(ms) {
      for (let i = 0; i < ms; i++) {
        t++;
        for (const [id, e] of [...timers]) {
          if (!timers.has(id)) continue;
          while (e.due <= t) { e.due += e.ms; e.fn(); }
        }
      }
    },
    live: () => timers.size,
  };
}

// A frame whose every sample names it, so a delivered frame can be traced back
// to the push that made it — which is what §6's identity check needs.
function frame(id, n = BLOCK) { return new Float32Array(n).fill(id); }
function idOf(f) { return f[0]; }

function build(depthBlocks) {
  const clock = makeClock();
  const out = [];
  const b = new RxJitter({ depthBlocks, deliver: (f) => out.push(f), clock });
  return { b, out, clock };
}

// ─── 1. Passthrough is the unbuffered path, exactly ─────────────────────────
section('1. depth 0 — passthrough');
{
  const { b, out, clock } = build(0);
  ok(b.passthrough, 'depth 0 reports passthrough');
  for (let i = 1; i <= 5; i++) b.push(frame(i));
  eq(out.length, 5, 'every frame is delivered on arrival');
  eq(out.map(idOf).join(','), '1,2,3,4,5', 'in order');
  eq(clock.live(), 0, 'and no timer is ever armed');
  // The fallback matters as much as the feature: this is what a deployment gets
  // by setting the constant to 0, and it has to be the behaviour that predates
  // the file rather than an approximation of it.
  eq(b.stalls, 0, 'passthrough cannot stall');
}

// ─── 2. Priming spends the depth, once, up front ────────────────────────────
section('2. priming');
{
  const { b, out, clock } = build(3);
  b.push(frame(1));
  eq(out.length, 0, 'one frame held: nothing released');
  b.push(frame(2));
  eq(out.length, 0, 'two frames held: nothing released');
  eq(b.queued(), 2 * BLOCK, 'both are still queued');
  b.push(frame(3));
  eq(out.length, 1, 'the third primes it and frame 1 goes out at once');
  eq(idOf(out[0]), 1, 'and it is the FIRST frame, not the newest');
  // Charging for the depth twice would make the buffer a frame deeper than it
  // says. Frame 0 is due on entry; frame 1 is due 20 ms later.
  clock.advance(19);
  eq(out.length, 1, 'nothing more before the frame interval is up');
  clock.advance(1);
  eq(out.length, 2, 'the next frame at 20 ms');
  eq(b.queued(), BLOCK, 'steady state holds the depth, less what is in flight');
}

// ─── 3. Clumped arrivals come out isochronous ───────────────────────────────
// The whole point. Ten frames arriving in one instant is what a proxy hop hands
// over after it has been holding them, and the release has to be a 20 ms grid
// regardless — that is what turns variance into the constant delay Phase 2's
// bounds already absorb.
section('3. a burst in is a grid out');
{
  const { b, out, clock } = build(3);
  for (let i = 1; i <= 10; i++) b.push(frame(i));
  eq(out.length, 1, 'a ten-frame burst releases ONE frame, not ten');
  clock.advance(100);
  eq(out.length, 6, '100 ms later, five more — one per 20 ms');
  clock.advance(80);
  eq(out.length, 10, 'and the rest on the same grid');
  eq(out.map(idOf).join(','), '1,2,3,4,5,6,7,8,9,10', 'order is arrival order throughout');
}

// ─── 4. Conservation ────────────────────────────────────────────────────────
section('4. nothing is dropped');
{
  const { b, out, clock } = build(3);
  let pushed = 0;
  // Arrival pattern with deliberate clumps and gaps — the thing being modelled.
  const pattern = [3, 0, 0, 1, 1, 5, 0, 0, 0, 2, 1, 1, 4, 0, 1, 1];
  let id = 0;
  for (const n of pattern) {
    for (let i = 0; i < n; i++) { b.push(frame(++id)); pushed++; }
    clock.advance(20);
  }
  clock.advance(2000);                       // let it finish
  eq(out.length, pushed, 'every frame pushed is a frame delivered');
  eq(out.map(idOf).join(','), Array.from({ length: pushed }, (_, i) => i + 1).join(','),
     'in arrival order, exactly once each');
  const samples = out.reduce((a, f) => a + f.length, 0);
  eq(samples, pushed * BLOCK, 'and the sample count is conserved');
  eq(b.queued(), 0, 'nothing is left holding');
}

// ─── 5. Underrun stalls, and re-primes rather than running empty ────────────
// The self-healing half. Carrying the debt instead would drain the queue to
// nothing and leave the whole rest of the call unprotected, silently — which is
// a worse failure than the stall, because nothing would ever say so.
section('5. underrun');
{
  const { b, out, clock } = build(3);
  for (let i = 1; i <= 3; i++) b.push(frame(i));
  // 50 ms, not 60: the third frame leaves at 40 ms and a fourth falls due at
  // exactly 60, so a stall AT 60 is correct behaviour and checking for its
  // absence there tests the clock boundary rather than the intent.
  clock.advance(50);
  eq(out.length, 3, 'the three frames go out on the grid');
  eq(b.stalls, 0, 'no stall while it had frames to release');
  clock.advance(110);                        // demand, with nothing to meet it
  eq(out.length, 3, 'nothing is delivered from an empty queue');
  eq(b.stalls, 1, 'and that is recorded as a stall');
  eq(clock.live(), 0, 'the timer is released while un-primed');
  // Re-prime: it holds the depth again before releasing, so the protection is
  // back rather than spent.
  b.push(frame(4));
  eq(out.length, 3, 'one frame back is not enough to resume');
  b.push(frame(5)); b.push(frame(6));
  eq(out.length, 4, 'depth reached: it primes again and releases one');
  eq(idOf(out[3]), 4, 'and resumes at the right frame');
  eq(clock.live(), 1, 'with the clock running again');
}

// ─── 6. Nothing is invented ─────────────────────────────────────────────────
// The section that fails a buffer written from VoIP habit. Identity, not count:
// concealment silence inserted in the right quantity passes a count check and
// would put samples on the demodulator's input that were never on the wire.
section('6. no manufactured audio');
{
  const { b, out, clock } = build(3);
  const pushedIds = [];
  for (let i = 1; i <= 4; i++) { b.push(frame(i)); pushedIds.push(i); }
  clock.advance(500);                        // long starvation, many stalls' worth
  for (let i = 5; i <= 8; i++) { b.push(frame(i)); pushedIds.push(i); }
  clock.advance(500);
  ok(b.stalls > 0, 'the run genuinely starved');
  eq(out.length, pushedIds.length, 'no extra frames appeared');
  const ids = out.map(idOf);
  ok(ids.every((v) => pushedIds.includes(v)), 'every delivered frame is one that was pushed');
  ok(!out.some((f) => f.every((s) => s === 0)), 'no all-zero frame was ever synthesised');
}

// ─── 7. Upward creep is drained, not carried ────────────────────────────────
// Two independent wall clocks a few ppm apart walk the queue in whichever
// direction that lands. Downward ends in a stall and fixes itself; upward is
// unbounded added latency that nothing would report.
section('7. excess drain');
{
  const { b, out, clock } = build(3);
  const total = 3 + MAX_EXCESS_FRAMES + 10;
  for (let i = 1; i <= total; i++) b.push(frame(i));
  clock.advance(20);
  ok(b.queued() <= (3 + MAX_EXCESS_FRAMES) * BLOCK,
     `the queue is pulled back to the target band (${b.queued() / BLOCK} frames held)`);
  ok(out.length > 2, 'by releasing faster, not by discarding');
  clock.advance(2000);
  eq(out.length, total, 'and the excess frames were all delivered');
}

// ─── 8. Catch-up is capped ──────────────────────────────────────────────────
// A stalled event loop leaves real demand outstanding; releasing it as one
// burst would hand the demodulator exactly the clump this exists to remove.
section('8. catch-up cap');
{
  const { b, out, clock } = build(3);
  for (let i = 1; i <= 30; i++) b.push(frame(i));
  const before = out.length;
  // TICK_MS, not 1 ms: advancing less than one tick fires no timer at all, and
  // an assertion that nothing left in a span where nothing could leave is a
  // section that cannot fail. This deliberately lands on exactly one tick, with
  // a queue deep enough that the excess drain is asking for all of it.
  clock.advance(TICK_MS);
  const released = out.length - before;
  ok(released > 0, 'the tick did release something — the section is live');
  ok(released <= CATCHUP_FRAMES,
     `at most ${CATCHUP_FRAMES} frames leave in one tick (saw ${released})`);
}

// ─── 9. stop() is teardown ──────────────────────────────────────────────────
section('9. stop');
{
  const { b, out, clock } = build(3);
  for (let i = 1; i <= 6; i++) b.push(frame(i));
  const delivered = out.length;
  b.stop();
  eq(clock.live(), 0, 'the timer is cleared');
  eq(b.queued(), 0, 'the tail is dropped — the demodulator it was for has gone');
  clock.advance(1000);
  eq(out.length, delivered, 'and nothing is delivered after a stop');
  b.push(frame(99));
  eq(out.length, delivered, 'a push after a stop is ignored');
}

// ─── 10. The module's own constants ─────────────────────────────────────────
// Not wording — these are the units the arithmetic above depends on, and a
// change to any of them changes what a depth of 3 MEANS.
section('10. units');
{
  eq(SR, 8000, 'the link is 8 kHz');
  eq(BLOCK, 160, 'a frame is 160 samples');
  eq(BLOCK / (SR / 1000), 20, 'which is 20 ms');
  ok(TICK_MS < BLOCK / (SR / 1000), 'the release clock runs finer than one frame');
}

console.log(`\n${pass}/${pass + fail} assertions passed`);
process.exit(fail ? 1 : 0);
