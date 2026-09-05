'use strict';

// SPDX-License-Identifier: GPL-3.0-or-later
//
// Rate pacing for a byte stream, as a token bucket with a queue.
//
// This exists for telnet bypass (link:'direct') and only for it. A modem call
// is paced by physics: the DSP hands the transport bytes at the protocol's own
// rate and nothing can go faster than the carrier. Bypass has no carrier, so a
// board and a browser are wired to each other at whatever speed the two TCP
// connections manage — which is fine for a menu and is not fine for an ANSI
// "movie", a ZMODEM send, or a client written to hold the pipe open at line
// rate. The cap is not an anti-abuse control so much as a shape: bypass should
// cost what the fastest modem in this project costs, and no more.
//
// A pacer NEVER drops a byte. Everything pushed is written, later if not now,
// and the caller is told when the queue is deep enough that it should stop
// reading its own source — which is what keeps a queue that is filled faster
// than it drains from being an unbounded buffer with the operator's memory in
// it. Both directions of a bypass call get one, so a paced sender is asked to
// slow down at its own socket rather than here.

// How long a silent link may bank. Keeps interactive traffic — a keystroke, a
// menu redraw — going out in the tick it arrives rather than waiting for the
// bucket, while still averaging out to the configured rate over any second.
const BURST_SECONDS = 0.125;

// Floor on how often the timer runs. A byte-accurate wake-up for a 128 kbps
// link would be every 62 µs; the queue is a byte stream, so releasing 320 bytes
// every 20 ms is the same rate and three orders of magnitude fewer timers.
const TICK_MS = 20;

class Pacer {
  /**
   * @param {object}   o
   * @param {number}   o.bps        cap in BITS per second. 0 (or less) = no cap
   *                                at all: push() writes through synchronously
   *                                and no timer is ever armed.
   * @param {function} o.write      called with a Buffer to actually send.
   * @param {number}   [o.highWater] queued bytes at which onFull(true) fires.
   * @param {function} [o.onFull]   told true when the queue passes highWater and
   *                                false when it drains back under half of it.
   *                                Called only on a CHANGE, so a caller can wire
   *                                it straight to pause()/resume().
   * @param {object}   [o.clock]    { now, setTimer, clearTimer } — the test seam.
   */
  constructor({ bps, write, highWater = 64 * 1024, onFull = null, clock = null }) {
    this._write = write;
    this._onFull = onFull;
    this._high = Math.max(1, highWater);
    this._low = Math.max(1, Math.floor(this._high / 2));
    this._clock = clock || {
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (t) => clearTimeout(t),
    };
    // Bits in, bytes out: everything below counts bytes, because that is what a
    // Buffer is measured in and dividing once here is the only place the two
    // units meet.
    this.bytesPerSec = bps > 0 ? Math.max(1, Math.floor(bps / 8)) : 0;
    this._cap = Math.max(1, Math.round(this.bytesPerSec * BURST_SECONDS));
    this._tokens = this._cap;          // a fresh link may spend its burst at once
    this._last = this._clock.now();
    this._q = [];
    this._queued = 0;
    this._timer = null;
    this._full = false;
    this._stopped = false;
  }

  get unlimited() { return this.bytesPerSec === 0; }
  queued() { return this._queued; }

  /** Queue bytes for sending. Never drops, never throws away. */
  push(buf) {
    if (this._stopped || !buf || !buf.length) return;
    if (this.unlimited) { this._write(buf); return; }
    this._q.push(buf);
    this._queued += buf.length;
    this._drain();
  }

  /**
   * Stop pacing and forget anything still queued. Teardown only: a session that
   * has ended has nowhere left to write, and holding the tail would keep a
   * timer alive on a socket nobody is on.
   */
  stop() {
    this._stopped = true;
    if (this._timer !== null) { this._clock.clearTimer(this._timer); this._timer = null; }
    this._q.length = 0;
    this._queued = 0;
    this._signal();
  }

  // Refill the bucket for however long has passed. Clamped to the capacity, so
  // an idle link banks a burst and not an afternoon — otherwise a call left
  // open for an hour would be entitled to send a megabyte at full speed the
  // moment somebody touched it, which is exactly the traffic the cap is for.
  _refill() {
    const now = this._clock.now();
    const dt = Math.max(0, now - this._last);
    this._last = now;
    this._tokens = Math.min(this._cap, this._tokens + (dt / 1000) * this.bytesPerSec);
  }

  _drain() {
    if (this._stopped) return;
    this._refill();
    while (this._q.length && this._tokens >= 1) {
      const head = this._q[0];
      const n = Math.min(head.length, Math.floor(this._tokens));
      // A partial write is correct here and not a compromise: this is a byte
      // stream in both directions, so a chunk boundary carries no meaning that
      // splitting it could lose.
      if (n === head.length) this._q.shift(); else this._q[0] = head.subarray(n);
      this._tokens -= n;
      this._queued -= n;
      this._write(n === head.length ? head : head.subarray(0, n));
    }
    if (this._q.length && this._timer === null) {
      // Wait for a tick, or for one byte's worth of tokens if that is longer —
      // which it only is on a cap slower than 400 bps, and a zero-delay timer
      // on such a link would spin.
      const perByte = 1000 / this.bytesPerSec;
      this._timer = this._clock.setTimer(() => {
        this._timer = null;
        this._drain();
      }, Math.max(TICK_MS, Math.ceil(perByte)));
    }
    this._signal();
  }

  // Edge-triggered, with hysteresis: a source resumed the instant it dipped
  // under the mark would be paused and resumed once per chunk forever.
  _signal() {
    if (!this._onFull) return;
    if (!this._full && this._queued > this._high) { this._full = true; this._onFull(true); }
    else if (this._full && this._queued <= this._low) { this._full = false; this._onFull(false); }
  }
}

module.exports = { Pacer, BURST_SECONDS, TICK_MS };
