'use strict';

/**
 * ErrorControl.js — V.42 in the modem: the error-control stack (Stack.js) run
 * over a data pump's synchronous bit stream, as a real modem runs it once its
 * data mode begins.
 *
 * The protocol hands its data-mode bits to this and takes this one's in place of
 * its own start-stop characters (setBitLink). Time is the modem's own, counted in
 * samples generated. The terminal is told it has connected only once error
 * control is settled, with what was negotiated (V.250 6.5.5): LAPM with or
 * without V.42bis or V.44, or none. With none the bit stream carries start-stop
 * characters, framed and deframed here (V.14) by one deframer from the detection
 * phase's own bits onward, so a far end that began typing at once — which is how
 * detection knew it does no V.42 — loses no character at the change (V.42
 * Appendix I.3).
 *
 * Nothing here knows what is at the far end or how the audio travels: V.42's own
 * detection phase finds out whether the far end does error control.
 */

const { EventEmitter } = require('events');
const { Stack, Phase, Compression, ORIGINATOR, ANSWERER } = require('./Stack');
const L = require('./Lapm');

/** Start-stop characters out of a bit stream: what a modem without V.42 would read. */
class AsyncDeframer {
  constructor() { this.state = 'hunt'; this.bit = 0; this.byte = 0; }
  feed(b) {
    if (this.state === 'hunt') { if (!b) { this.state = 'data'; this.bit = 0; this.byte = 0; } return null; }
    if (this.state === 'data') { this.byte |= (b ? 1 : 0) << this.bit; if (++this.bit === 8) this.state = 'stop'; return null; }
    this.state = 'hunt';
    return b ? this.byte : null;
  }
}

const COMPRESSION = { none: null, v42bis: 'v42bis', v44: 'v44', both: 'both' };

class ErrorControl extends EventEmitter {
  /**
   * @param {object} o
   * @param {'originate'|'answer'} o.role
   * @param {object} o.protocol  the data pump, with setBitLink(), write(), txPending
   * @param {number} o.bps       the line rate, for T401 (V.42 Appendix IV)
   * @param {string} [o.compression='both']  'both' | 'v44' | 'v42bis' | 'none'
   */
  constructor({ role, protocol, bps, compression = 'both', declaredLapm = false }) {
    super();
    this.protocol = protocol;
    this.stack = new Stack(role === 'originate' ? ORIGINATOR : ANSWERER, new L.Params({ t401Ms: L.t401For(bps || 2400) }));
    // Both ends said LAPM in V.8: detection still runs, but an ADP that does not
    // come is taken as lost on the line, not as a far end without V.42.
    if (declaredLapm) this.stack.declaredLapm();
    if (compression in COMPRESSION && COMPRESSION[compression] !== null) {
      this.stack.offerCompression(Compression.Both);
      if (compression === 'v44') this.stack.withoutV42bis();
      if (compression === 'v42bis') this.stack.withoutV44();
    }
    this._settled = false;
    this._held = [];          // written before error control settled
    this._plain = false;      // no error control: start-stop characters on the link
    this._deframe = new AsyncDeframer();
    this._txBits = [];        // framed characters waiting to go
    this._rxPlain = [];
    this._link = {
      nextBit: () => (this._plain ? (this._txBits.length ? this._txBits.shift() : 1) : this.stack.nextBit()),
      feedBit: (b) => this._feed(b),
    };
    protocol.setBitLink(this._link);
  }

  /**
   * The same link, carried on by another pump instance: V.90's retrain runs on a
   * fresh one. LAPM is suspended while it trains (`carrying`), as for any retrain.
   */
  relink(protocol) {
    this.protocol = protocol;
    protocol.setBitLink(this._link);
  }

  /**
   * Characters the protocol framed before the link was set (held from before its
   * data phase): put back as the bits they were, start, data and stop.
   */
  heard(buf) {
    for (const by of buf) {
      const bits = [0];
      for (let i = 0; i < 8; i++) bits.push((by >> i) & 1);
      bits.push(1);
      for (const b of bits) this._feed(b);
    }
  }

  /** Time passing, in milliseconds of the modem's own audio. */
  tick(ms) {
    if (!this._plain) {
      // 7.10: a retrain takes the line away for a second or two, and every timer
      // here would count a silence that means nothing: suspended until it is back.
      const carrying = this.protocol.carrying;
      if (carrying === false && !this.stack.suspended()) this.stack.suspend();
      else if (carrying !== false && this.stack.suspended()) this.stack.resume();
      this.stack.tick(ms);
      if (this.stack.phase() === Phase.Transparent) this._goPlain();
    }
    this._collect();
  }

  _feed(b) {
    if (this._plain) { const c = this._deframe.feed(b); if (c !== null) this._rxPlain.push(c); return; }
    this.stack.feedBit(b);
    if (this.stack.phase() === Phase.Transparent) this._goPlain();
  }

  /** No error control: everything the stack did not claim, through the one deframer. */
  _goPlain() {
    this._plain = true;
    for (const b of this.stack.takeUnclaimed()) { const c = this._deframe.feed(b); if (c !== null) this._rxPlain.push(c); }
  }

  _collect() {
    const got = this._plain ? [] : this.stack.takeReceived();
    if (this._rxPlain.length) got.push(...this._rxPlain.splice(0));
    if (got.length) this.emit('data', Buffer.from(got));
    if (!this._settled && (this._plain || this.stack.settled())) {
      this._settled = true;
      const lapm = !this._plain && this.stack.isConnected();
      this.emit('settled', { errorControl: lapm ? 'LAPM' : 'NONE', compression: lapm ? this.stack.compressionName() : null });
      const held = this._held; this._held = [];
      for (const d of held) this.write(d);
    }
  }

  write(data) {
    if (!this._settled) { this._held.push(Buffer.from(data)); return; }
    if (!this._plain) { this.stack.send(data); return; }
    for (const by of data) {        // V.14: start bit, eight data bits low first, stop bit
      this._txBits.push(0);
      for (let i = 0; i < 8; i++) this._txBits.push((by >> i) & 1);
      this._txBits.push(1);
    }
  }

  get txPending() {
    const held = this._held.reduce((n, d) => n + d.length, 0);
    return held + (this._plain ? Math.ceil(this._txBits.length / 10) : this.stack.queued());
  }

  /**
   * Where V.42 has got to, for the status line: the detection phase (7.2.1), the
   * XID exchange (8.10), or LAPM's establishment (8.3); null once settled.
   */
  stage() {
    if (this._settled) return null;
    switch (this.stack.phase()) {
      case Phase.Detecting: return 'v42-detect';
      case Phase.Negotiating: return 'v42-xid';
      case Phase.Protocol: return this.stack.isConnected() ? null : 'v42-sabme';
      default: return null;
    }
  }

  get settled() { return this._settled; }
  get plain() { return this._plain; }
  describe() {
    return { phase: this.stack.phase(), connected: this.stack.isConnected(), compression: this.stack.compressionName(), damaged: this.stack.damagedFrames() };
  }
}

module.exports = { ErrorControl, AsyncDeframer };
