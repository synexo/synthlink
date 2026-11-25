'use strict';

/**
 * ClockPair.js — this end's two sample clocks, paired.
 *
 * A modem's transmit and receive run on one crystal: receive sample n arrives
 * as transmit sample n leaves. Its echo canceller depends on that, to know which
 * of its own samples any echo came from. ModemDSP's real-time pump does not give
 * it: transmit is paced by the wall clock in bursts and receive by packet arrival,
 * so receive can run ahead of transmit. This puts the pairing back. Receive sample
 * n is held until transmit sample n exists, and both counts are re-based when a
 * protocol takes the line, so its own sample k is the same instant both ways.
 *
 * In the loop on every call: it is how a modem's clocks are, on any line, over
 * any transport, to any far end. What a line does to the signal is TwoWire.js's,
 * applied outside the modem, and only in 2-wire mode (which reuses this hold,
 * with its echo and loss as `line`).
 *
 * Without the hold the pump's bursts delivered the far end ahead of our own
 * transmit. The canceller, revisiting those samples once their transmit existed
 * (its training replays, its far-run search), trained to 8 dB where 39 was right.
 */

const RING = 16384;            // 2 s of transmit history, ample for any round trip

class ClockPair {
  /** @param {object} [line] what a line does: line(n, x, txAt) → sample heard (TwoWire) */
  constructor(line = null) {
    this.line = line;
    this.ring = new Float32Array(RING);
    this.T = 0;                  // transmit samples sent, ever
    this.R = 0;                  // receive samples released or dropped, ever
    this.origin = 0;             // the instant of this frame's sample 0, both ways
    this.held = [];              // received, waiting for our transmit to catch up
    this._rebase = false;
    this.txAt = (m) => (m >= 0 && m < this.T && m > this.T - RING ? this.ring[m % RING] : 0);
  }

  /**
   * A protocol takes the line: its next transmit sample is sample 0, and so is
   * the receive sample that arrives at that same instant. One origin both ways,
   * not one per direction: receive can be behind transmit when it happens (the far
   * end's audio still in flight), and counting receive from its own next sample
   * would skew every echo by that much. Received samples from before the origin
   * belong to the old frame and are dropped as they come.
   */
  rebase() { this._rebase = true; }

  /** This end transmitted `f32`. Returns the received samples that were waiting for it. */
  sent(f32) {
    if (this._rebase) { this._rebase = false; this.origin = this.T; }
    for (let i = 0; i < f32.length; i++) this.ring[(this.T++) % RING] = f32[i];
    return this._release();
  }

  /** This end received `f32`. Returns what of it can be heard yet, in order. */
  received(f32) {
    for (let i = 0; i < f32.length; i++) this.held.push(f32[i]);
    return this._release();
  }

  /** The held samples whose transmit instant has come, in this frame. */
  _release() {
    // A new frame's first transmit has not gone out yet: where it starts is not known.
    if (this._rebase) return new Float32Array(0);
    const ready = Math.min(this.held.length, Math.max(0, this.T - this.R));
    const skip = Math.min(ready, Math.max(0, this.origin - this.R));   // before the origin
    const out = new Float32Array(ready - skip);
    for (let i = 0; i < ready; i++) {
      const n = this.R++;
      if (i < skip) continue;
      out[i - skip] = this.line ? this.line(n, this.held[i], this.txAt) : this.held[i];
    }
    if (ready) this.held.splice(0, ready);
    return out;
  }
}

module.exports = { ClockPair };
