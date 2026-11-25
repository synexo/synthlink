'use strict';

/**
 * TwoWire.js — a 2-wire local loop, as this end hears it: its own echo, and the
 * line's loss on the far end's signal.
 *
 * Echo is this end's own transmit coming back: through its own hybrid at once
 * (near) and off the far hybrid a round trip later (far). Both are functions of a
 * signal this end already has, so each end builds its own 2-wire line locally
 * and the transport stays 4-wire:
 *
 *   rx[n] = far[n]·line + near·tx[n − dNear] + far·tx[n − dFar]
 *
 * Only the line, and outside the modem: ModemDSP applies it where the transport
 * meets the modem, and Handshake and the protocols never see it. They run exactly
 * as on 4-wire, as real modems do, not knowing which line they are on.
 *
 * A line is real time: what arrives at instant n carries the echo of what left
 * at n − d. The transport does not give that (transmit is paced by the wall
 * clock, receive by packet arrival), so the line holds receive sample n until
 * transmit sample n has gone, the same hold ClockPair.js is. A transmit sample
 * that does not exist reads as zero.
 */

const { ClockPair } = require('./ClockPair');

const SR = 8000;

const gainOf = (db) => Math.pow(10, db / 20);

/**
 * @param {object} c
 * @param {number} [c.nearLossDb=-12]  trans-hybrid loss at this end
 * @param {number} [c.nearDelayMs=1]
 * @param {number} [c.farLossDb=-24]   return loss off the far end's hybrid
 * @param {number} [c.farDelayMs=20]   the round trip
 * @param {number} [c.lineLossDb=-10]  what the line does to the far end's signal
 * @returns {function(number, number, function(number): number): number}
 *   line(n, x, txAt): receive sample n, given the far end's x and our transmit history
 */
function twoWire(c = {}) {
  const gNear = gainOf(c.nearLossDb == null ? -12 : c.nearLossDb);
  const gFar = gainOf(c.farLossDb == null ? -24 : c.farLossDb);
  const gLine = gainOf(c.lineLossDb == null ? -10 : c.lineLossDb);
  const dNear = Math.round((c.nearDelayMs == null ? 1 : c.nearDelayMs) * SR / 1000);
  const dFar = Math.round((c.farDelayMs == null ? 20 : c.farDelayMs) * SR / 1000);
  const line = (n, x, txAt) => x * gLine + gNear * txAt(n - dNear) + gFar * txAt(n - dFar);
  line.dNear = dNear; line.dFar = dFar;
  return line;
}

/** The line as ModemDSP uses it: sent(f32) and received(f32) each return what
 *  this end now hears, in order. Never re-based: a line has no protocols. */
class TwoWireLine {
  constructor(c = {}) { this._clock = new ClockPair(twoWire(c)); }
  sent(f32) { return this._clock.sent(f32); }
  received(f32) { return this._clock.received(f32); }
}

module.exports = { twoWire, TwoWireLine };
