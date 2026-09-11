'use strict';

// SPDX-License-Identifier: GPL-3.0-or-later
//
// Receive-side de-jitter buffer for the PCM link.
//
// Transmit on both ends is wall-clock paced — ModemDSP._txTick generates only as
// much audio as real time has advanced, in whole BLOCK units, however jittery the
// timer firing was. Receive was paced by nothing at all: every frame went from
// the socket handler straight into dsp.receiveAudio(), so the demodulator's
// notion of when a signal arrived was the packet's arrival instant. On a LAN
// that is indistinguishable from a paced feed. Across the internet — more so
// through a proxy hop, which schedules on its own terms — it is not, and the
// place it shows is V.34/V.90 Phase 2.
//
// Phase 2 mixes two clocks by design: a step's duration is counted in
// TRANSMITTED samples while the thing that ends it is an ARRIVAL. §11.2.1.2.4's
// round trip delay is genuinely measured between the two reversals and every
// bound that has to outlive a round trip is written as a constant plus that
// measurement — V34.js's L2 step is `P2_BOUND_L2_ANS + p2.rtd`. So a link that
// is merely SLOW is already handled: the delay lands in rtd and the bound grows
// with it. What is not handled is a link whose delay VARIES, because rtd is one
// measurement taken once, at the reversal, and a tone arriving on the far side
// of that spread is late against a bound that was sized on the near side.
//
// Which is the whole job here: convert variance into constant delay, because
// constant delay is the thing the procedure already absorbs.
//
// WHAT THIS DELIBERATELY DOES NOT DO, and why it is not a jitter buffer in the
// VoIP sense: the transport is a WebSocket, so it is TCP, so frames are never
// lost and never reordered — only delayed. The sample stream reaching the
// demodulator today is already gapless and correct. Therefore:
//
//   - NOTHING IS EVER DROPPED. Same rule as lib/throttle.js and for a stronger
//     reason: a discarded frame is a hole in a carrier the receiver is tracking,
//     and no amount of latency saved is worth one.
//   - NOTHING IS EVER INVENTED. An RTP buffer conceals a lost packet with
//     silence or an interpolation. Here a late frame is not lost — it is coming
//     — so manufacturing samples to cover it would inject audio that was never
//     on the wire and corrupt a stream that is currently perfect. On underrun
//     this buffer STALLS, which is exactly what the unbuffered path did.
//
// So it only ever delays. Total added latency is bounded by the depth, and the
// sample stream out is the sample stream in, to the sample, in order.
//
// On a stall the buffer un-primes and refills to depth before releasing again.
// That is what makes it self-healing: the alternative — carrying the debt and
// running permanently empty afterwards — would leave the rest of the call with
// no protection at all, silently, which is the failure mode worth avoiding.
//
// One file, served to the browser and required by the server, because the two
// ends must behave identically and this repo has been bitten more than once by
// a rule that lived in both halves separately.
//
// SynthLink's own code, GPL-3.0-or-later.

(function (root) {

// The PCM link's own units. Both pumps emit 20 ms of 8 kHz mono per frame; the
// arithmetic below is in SAMPLES throughout so an odd-sized frame still works.
const SR = 8000;
const BLOCK = 160;

// How often the release clock runs. Mirrors ModemDSP._txTick's 5 ms: the frames
// are 20 ms, so this is the residual quantisation on top of the depth, and it
// wants to stay well under the thing being smoothed. Note the cost is one timer
// per LIVE CALL on the server, alongside the transmit timer maxSessions is
// already sized against — 10 ms halves that and is a defensible trade.
const TICK_MS = 5;

// Frames per tick. A stalled event loop leaves real demand outstanding, and this
// is what stops the catch-up going out as one burst. Same reasoning and the same
// number as _txTick's own cap.
const CATCHUP_FRAMES = 3;

// Slack above the target depth before the queue is drained down rather than
// waited on. The two ends run off independent wall clocks, so over a long call
// the far end's 8 kHz and this one's differ by a few ppm and the queue creeps in
// whichever direction that lands. Creeping DOWN ends in a stall and re-primes
// itself; creeping UP is unbounded added latency and nothing would ever say so.
// Draining the excess costs nothing — the frames are real and they all go out.
const MAX_EXCESS_FRAMES = 3;

class RxJitter {
  /**
   * @param {object}   o
   * @param {number}   o.depthBlocks  frames to hold before releasing, at 20 ms
   *                                  each. 0 = pass straight through, which is
   *                                  byte-for-byte the behaviour that predates
   *                                  this file and is what it falls back to.
   * @param {function} o.deliver      called with one frame, in order. Whatever
   *                                  the unbuffered path did, this does.
   * @param {object}   [o.clock]      { now, setTimer, clearTimer } — the test
   *                                  seam, for the same reason lib/throttle.js
   *                                  has one: a real-clock test of a thing whose
   *                                  whole job is timing is a flake generator.
   */
  constructor({ depthBlocks, deliver, clock = null }) {
    this._deliver = deliver;
    this._depth = Math.max(0, Math.floor(depthBlocks || 0)) * BLOCK;   // samples
    this._clock = clock || {
      now: () => Date.now(),
      setTimer: (fn, ms) => setInterval(fn, ms),
      clearTimer: (t) => clearInterval(t),
    };
    this._q = [];
    this._queued = 0;            // samples held
    this._timer = null;
    this._primed = false;
    this._t0 = 0;
    this._released = 0;          // samples released since _t0
    this._stopped = false;
    // Diagnostics, read-only to everyone else. `stalls` is the number worth
    // watching on a real link: a buffer deep enough for the path it is on
    // reaches data mode without any.
    this.stalls = 0;
    this.frames = 0;
  }

  /** True when this buffer is doing nothing at all. */
  get passthrough() { return this._depth === 0; }

  /** Samples currently held. */
  queued() { return this._queued; }

  /** A frame off the wire. Never drops it, never waits on anything. */
  push(f32) {
    if (this._stopped || !f32 || !f32.length) return;
    if (this.passthrough) { this._out(f32); return; }
    this._q.push(f32);
    this._queued += f32.length;
    // Priming is what spends the depth: the first frame is not released until
    // the buffer holds the delay it exists to hold, and every frame after it
    // inherits that same offset from the release clock below.
    if (!this._primed && this._queued >= this._depth) this._prime();
  }

  /**
   * Stop and forget the tail. Teardown only, and the tail is dropped for the
   * same reason lib/throttle.js drops its queue: a call that has ended has no
   * demodulator left to hand these to, and holding them would keep a timer
   * alive on a session nobody is on.
   */
  stop() {
    this._stopped = true;
    if (this._timer) { this._clock.clearTimer(this._timer); this._timer = null; }
    this._q.length = 0;
    this._queued = 0;
    this._primed = false;
  }

  _prime() {
    this._primed = true;
    this._t0 = this._clock.now();
    this._released = 0;
    if (!this._timer) this._timer = this._clock.setTimer(() => this._tick(), TICK_MS);
    this._tick();                // frame 0 is due at once; the depth is already paid
  }

  _tick() {
    if (this._stopped || !this._primed) return;
    // Frame k is due at t0 + k*20 ms, so frame 0 is due on entry — the delay was
    // already taken by priming, and charging for it twice would make the buffer
    // one frame deeper than it says it is.
    const elapsed = this._clock.now() - this._t0;
    const due = Math.floor(elapsed * SR / 1000) + BLOCK;
    let want = due - this._released;
    // Creep upward is drained rather than carried. See MAX_EXCESS_FRAMES.
    const excess = this._queued - (this._depth + MAX_EXCESS_FRAMES * BLOCK);
    if (excess > 0 && excess > want) want = excess;

    // A WHOLE frame has to be due, not merely some demand: releasing on a
    // partial frame's worth hands the next one out early, every time, which
    // makes the buffer a frame shallower than the depth it was asked for and
    // gives back part of what it exists to hold.
    let frames = 0;
    while (this._q.length && frames < CATCHUP_FRAMES && want >= this._q[0].length) {
      const f = this._q.shift();
      this._queued -= f.length;
      this._released += f.length;
      want -= f.length;
      frames++;
      this._out(f);
    }

    // Underrun: the far end is late and its frames are still coming, so there is
    // nothing to release and nothing to invent. Un-prime, and the next arrivals
    // refill to depth before the clock restarts — which is what stops one late
    // burst from leaving the rest of the call unprotected.
    if (want >= BLOCK && this._q.length === 0) {
      this.stalls++;
      this._primed = false;
      if (this._timer) { this._clock.clearTimer(this._timer); this._timer = null; }
    }
  }

  _out(f32) {
    this.frames++;
    this._deliver(f32);
  }
}

// Served to the browser as a classic script — a global, exactly as
// dsp-bundle.js is consumed, and for the same reason: index.html loads it ahead
// of the module and the module reads it off the window.
if (typeof window !== 'undefined') window.RxJitter = RxJitter;
// And required by server.js off the same file on disk.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { RxJitter, SR, BLOCK, TICK_MS, CATCHUP_FRAMES, MAX_EXCESS_FRAMES };
}

})(typeof globalThis !== 'undefined' ? globalThis : this);
