'use strict';

/*!
 * @license
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Copyright (C) 2026 Joseph Quinn
 *
 * Ported from BinModem <https://github.com/CasualArclamp/BinModem>,
 * crates/ec/src/bits.rs, at commit 623f935e28fe6de3a8a4f41492feb46e1bb86c3a of
 * <https://github.com/synexo/BinModem>. Copyright the BinModem authors;
 * GPL-3.0-or-later. See NOTICE.
 */

/**
 * Bits.js — bit packing for compressed mode, shared by V.42bis and V.44.
 *
 * Both Recommendations give the same rule: V.42bis 7.5 (Figure 3) "the least
 * significant bit of a codeword immediately follows the most significant bit of
 * the preceding codeword", V.44 6.6 the same of its codes. So codes and the octets
 * holding them both run low-order bit first.
 */

/** Packs codewords into octets, low-order bit first. */
class BitWriter {
  constructor() { this.acc = 0; this.bits = 0; }

  /** Append `count` low-order bits of `value` (count ≤ 16) to `out`. */
  write(value, count, out) {
    this.acc = (this.acc | ((value & ((1 << count) - 1)) << this.bits)) >>> 0;
    this.bits += count;
    while (this.bits >= 8) { out.push(this.acc & 0xff); this.acc >>>= 8; this.bits -= 8; }
  }

  /** Bits held back short of a whole octet. */
  pending() { return this.bits; }

  /** Pad with zeroes to the next octet boundary (V.42bis 7.5, 7.8.2 d). */
  align(out) {
    if (this.bits > 0) { out.push(this.acc & 0xff); this.acc = 0; this.bits = 0; }
  }
}

/**
 * Reads codewords back out of octets, low-order bit first. Octets queue rather
 * than shifting straight in, so any number may be pushed before anything is read.
 */
class BitReader {
  constructor() { this.queue = []; this.head = 0; this.acc = 0; this.bits = 0; }

  clone() {
    const r = new BitReader();
    r.queue = this.queue.slice(this.head); r.acc = this.acc; r.bits = this.bits;
    return r;
  }

  /** Take another reader's state (what was read from a clone is then consumed here). */
  assign(other) { this.queue = other.queue; this.head = other.head; this.acc = other.acc; this.bits = other.bits; }

  pushOctet(byte) { this.queue.push(byte & 0xff); }

  _fill(count) {
    while (this.bits < count && this.head < this.queue.length) {
      this.acc = (this.acc | (this.queue[this.head++] << this.bits)) >>> 0;
      this.bits += 8;
    }
    if (this.head > 1024 && this.head * 2 > this.queue.length) { this.queue = this.queue.slice(this.head); this.head = 0; }
  }

  /** Take `count` bits (≤ 16) if that many have arrived, else null. */
  read(count) {
    this._fill(count);
    if (this.bits < count) return null;
    const v = this.acc & ((1 << count) - 1);
    this.acc >>>= count; this.bits -= count;
    return v;
  }

  /** Bits held, including octets still queued. */
  available() { return this.bits + (this.queue.length - this.head) * 8; }

  /** Drop the remainder of the current octet, as after ETM or FLUSH. */
  align() { const drop = this.bits % 8; this.acc >>>= drop; this.bits -= drop; }
}

module.exports = { BitWriter, BitReader };
