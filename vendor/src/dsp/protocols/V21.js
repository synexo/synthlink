'use strict';

/**
 * V.21 — 300 bps full-duplex FSK, per ITU-T Recommendation V.21.
 *
 * Spec frequencies (V.21 §2):
 *   Channel 1 (originating/call modem):   Mark = 980 Hz, Space = 1180 Hz
 *   Channel 2 (answering modem):          Mark = 1650 Hz, Space = 1850 Hz
 *
 * UART framing: start (0) + 8 data LSB-first + stop (1) — also the
 * format used by V.8 §5 for CI/CM/JM octets on the V.21(L) channel.
 *
 * The modulation, demodulation, carrier-detect, and UART framing are
 * shared with Bell 103 (and V.23's forward channel). All of that
 * lives in FskCommon.js. This file is a thin wrapper supplying the
 * V.21-specific frequencies and the conventional class names that
 * the rest of the codebase imports.
 *
 * History note: this file used to contain a near-line-for-line copy
 * of Bell103.js (or vice-versa). The shared base classes were
 * extracted in April 2026 along with two demodulator improvements
 * (majority-of-3 mid-bit and stop-bit sampling) targeted at the
 * "very occasional garbage characters" failure mode users had
 * observed under noisy line conditions.
 */

const { EventEmitter }                  = require('events');
const { FskModulator, FskDemodulator }  = require('./FskCommon');

// V.21 carrier frequencies (Hz) per ITU-T V.21.
const V21_CH1_MARK  = 980;
const V21_CH1_SPACE = 1180;
const V21_CH2_MARK  = 1650;
const V21_CH2_SPACE = 1850;

const V21_BAUD = 300;

// The far end's line at idle mark, before this end calls the link up: mark energy
// dominating both the space tone and a V.25 answer tone (2100 Hz, which the high
// channel's space filter at 1850 Hz otherwise reads as carrier) for 200 ms. A
// V.21 answerer may send a V.25 answer tone before its mark — some do so even
// after V.8 — and a caller that took the tone for carrier would start sending into
// it. Twenty-millisecond Goertzel windows, ten of them.
const MARK_WIN = 160, MARK_WINDOWS = 10, MARK_RATIO = 3;

class V21Modulator extends FskModulator {
  /** @param {1|2} channel — 1 for originate, 2 for answer */
  constructor(channel) {
    const isCh2 = channel === 2;
    super({
      markFreq:  isCh2 ? V21_CH2_MARK  : V21_CH1_MARK,
      spaceFreq: isCh2 ? V21_CH2_SPACE : V21_CH1_SPACE,
      baud:      V21_BAUD,
    });
  }
}

class V21Demodulator extends FskDemodulator {
  /** @param {1|2} channel — TX channel; we receive from the OTHER channel */
  constructor(channel) {
    const rxCh = channel === 2 ? 1 : 2;
    const isCh2 = rxCh === 2;
    super({
      markFreq:  isCh2 ? V21_CH2_MARK  : V21_CH1_MARK,
      spaceFreq: isCh2 ? V21_CH2_SPACE : V21_CH1_SPACE,
      baud:      V21_BAUD,
    });
  }
}

class V21 extends EventEmitter {
  constructor(role) {
    super();
    const txCh = role === 'answer' ? 2 : 1;
    this.modulator   = new V21Modulator(txCh);
    this.demodulator = new V21Demodulator(txCh);

    this.demodulator.on('data', buf => this.emit('data', buf));
    this.demodulator.on('bit',  bit => this.emit('bit', bit));
    const rxCh2 = txCh === 1;
    this._rxMark  = rxCh2 ? V21_CH2_MARK  : V21_CH1_MARK;
    this._rxSpace = rxCh2 ? V21_CH2_SPACE : V21_CH1_SPACE;
    this._win = new Float32Array(MARK_WIN); this._winFill = 0;
    this._markRun = 0; this._farEndIdle = false;
  }

  _trackMark(samples) {
    if (this._farEndIdle) return;
    const W = this._win;
    for (let i = 0; i < samples.length; i++) {
      W[this._winFill++] = samples[i];
      if (this._winFill < W.length) continue;
      this._winFill = 0;
      const g = (f) => {
        const c = 2 * Math.cos(2 * Math.PI * f / 8000); let s1 = 0, s2 = 0;
        for (let j = 0; j < W.length; j++) { const nw = W[j] + c * s1 - s2; s2 = s1; s1 = nw; }
        return Math.sqrt(s1 * s1 + s2 * s2 - c * s1 * s2) / W.length;
      };
      const m = g(this._rxMark), other = g(this._rxSpace) + g(2100);
      this._markRun = (m > 0.002 && m > MARK_RATIO * other) ? this._markRun + 1 : 0;
      if (this._markRun >= MARK_WINDOWS) { this._farEndIdle = true; return; }
    }
  }

  /** Write data bytes to be transmitted (UART-framed). */
  write(data)              { this.modulator.write(data); }

  /** Payload bytes still queued for transmission. Transport flow control. */
  get txPending()          { return this.modulator.txPending; }

  /** Write raw bits (no UART framing). For V.8 preamble. */
  writeBits(bits)          { this.modulator.writeBits(bits); }

  /** Generate n samples of transmit audio. */
  generateAudio(n)         { return this.modulator.generate(n); }

  /** Process received audio samples. */
  receiveAudio(samples)    { this.demodulator.process(samples); this._trackMark(samples); }

  /** The far end has held its line at mark for 200 ms; see MARK_WINDOWS. */
  get farEndIdle()         { return this._farEndIdle; }

  /** True if RX carrier is currently detected. */
  get carrierDetected()    { return this.demodulator.carrierDetected; }

  /**
   * Read-only, for the status line. Like Bell 103, V.21 has NO training
   * sequence — 300 baud on two tones has nothing to equalise — so both ends
   * simply bring up their carrier and idle mark. The generic fallback reported
   * "training", which names a phase this protocol does not have.
   */
  describe() {
    return { phase: 3, signal: 'mark' };
  }

  get name() { return 'V21'; }
  get bps()  { return V21_BAUD; }
}

module.exports = { V21, V21Modulator, V21Demodulator };
