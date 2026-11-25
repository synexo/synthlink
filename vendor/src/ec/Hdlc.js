'use strict';

/*!
 * @license
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Copyright (C) 2026 Joseph Quinn
 *
 * Ported from BinModem <https://github.com/CasualArclamp/BinModem>,
 * crates/ec/src/hdlc.rs, at commit 623f935e28fe6de3a8a4f41492feb46e1bb86c3a of
 * <https://github.com/synexo/BinModem>. Copyright the BinModem authors;
 * GPL-3.0-or-later. See NOTICE.
 */

/**
 * Hdlc.js — HDLC framing for LAPM (V.42 8.1).
 *
 * Frames are delimited by the flag 01111110, and transparency is kept by a zero
 * after any five contiguous ones (8.1.1.2). Bits go out low-order first within
 * each octet (8.1.2.2), which is why the CRCs are the reflected forms. Octet
 * strings are plain arrays of numbers; an FCS width is 16 or 32.
 */

const FLAG = 0x7e;
const FCS16 = 16, FCS32 = 32;
const fcsOctets = (fcs) => (fcs === FCS32 ? 4 : 2);

/** CRC-16, x^16 + x^12 + x^5 + 1, reflected, preset to ones (8.1.1.6.1). */
class Crc16 {
  constructor() { this.v = 0xffff; }
  update(b) {
    this.v ^= b & 0xff;
    for (let i = 0; i < 8; i++) this.v = (this.v & 1) ? ((this.v >>> 1) ^ 0x8408) : (this.v >>> 1);
  }
  updateAll(bytes) { for (const b of bytes) this.update(b); }
  residue() { return this.v; }
  /** The two octets to transmit, low-order first: the ones complement. */
  toBytes() { const v = (~this.v) & 0xffff; return [v & 0xff, v >>> 8]; }
}
/** The register over a good frame including its FCS (V.42's 0001 1101 0000 1111). */
Crc16.GOOD = 0xf0b8;

/** CRC-32 for the optional 32-bit FCS (8.1.1.6.2). */
class Crc32 {
  constructor() { this.v = 0xffffffff; }
  update(b) {
    this.v = (this.v ^ (b & 0xff)) >>> 0;
    for (let i = 0; i < 8; i++) this.v = (this.v & 1) ? (((this.v >>> 1) ^ 0xedb88320) >>> 0) : (this.v >>> 1);
  }
  updateAll(bytes) { for (const b of bytes) this.update(b); }
  residue() { return this.v; }
  toBytes() { const v = (~this.v) >>> 0; return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24]; }
}
Crc32.GOOD = 0xdebb20e3;

function appendFcs(payload, fcs) {
  const c = fcs === FCS32 ? new Crc32() : new Crc16();
  c.updateAll(payload);
  return payload.concat(c.toBytes());
}

/** True when `frame` (payload plus its FCS) checks out. */
function fcsOk(frame, fcs) {
  if (frame.length <= fcsOctets(fcs)) return false;
  const c = fcs === FCS32 ? new Crc32() : new Crc16();
  c.updateAll(frame);
  return c.residue() === (fcs === FCS32 ? Crc32.GOOD : Crc16.GOOD);
}

/** Turns frames into a stuffed bit stream (bits are 0/1). */
class Encoder {
  constructor(fcs = FCS16) { this.fcsWidth = fcs; this.bits = []; this.head = 0; }

  /**
   * Change the width for frames queued from now on. 8.10.2 changes it
   * mid-connection: XID goes at 16 whatever is agreed, the SABME at the agreed
   * width. Frames already queued keep the width they were built with.
   */
  setFcs(fcs) { this.fcsWidth = fcs; }
  fcs() { return this.fcsWidth; }

  /** Queue one frame: opening flag, stuffed payload and FCS, closing flag. */
  frame(payload) { this.frameWith(payload, this.fcsWidth); }

  /** One frame at a width of its own (8.10.2: an XID response at 16, always). */
  frameWith(payload, fcs) {
    this._rawFlag();
    const body = appendFcs(payload, fcs);
    let ones = 0;
    for (const byte of body) {
      for (let i = 0; i < 8; i++) {
        const bit = (byte >> i) & 1;               // low-order bit first
        this.bits.push(bit);
        if (bit) {
          if (++ones === 5) { this.bits.push(0); ones = 0; }   // transparency
        } else ones = 0;
      }
    }
    this._rawFlag();
  }

  /** `n` flags of interframe time fill (8.1.5). */
  idle(n) { for (let k = 0; k < n; k++) this._rawFlag(); }

  /** An abort: at least seven contiguous ones (8.1.4). */
  abort() { for (let k = 0; k < 8; k++) this.bits.push(1); }

  _rawFlag() { for (let i = 0; i < 8; i++) this.bits.push((FLAG >> i) & 1); }

  /** The next bit, or null when the queue is empty. */
  nextBit() {
    if (this.head >= this.bits.length) return null;
    const b = this.bits[this.head++];
    if (this.head > 4096 && this.head * 2 > this.bits.length) { this.bits = this.bits.slice(this.head); this.head = 0; }
    return b;
  }
  isEmpty() { return this.head >= this.bits.length; }
  pendingBits() { return this.bits.length - this.head; }
}

/** Why a received frame was discarded (8.1.3). */
const FrameError = Object.freeze({
  TooShort: 'TooShort', NotOctetAligned: 'NotOctetAligned', BadFcs: 'BadFcs', Aborted: 'Aborted', TooLong: 'TooLong',
});

const HUNT = 0, FRAME = 1, TERMINATOR = 2;

/** Whole octets from received bits, low-order first; a partial octet at the end is dropped. */
function octets(bits, n = bits.length) {
  const out = [];
  for (let k = 0; k + 8 <= n; k += 8) {
    let v = 0;
    for (let i = 0; i < 8; i++) v |= bits[k + i] << i;
    out.push(v);
  }
  return out;
}

/**
 * Turns a stuffed bit stream back into frames. feed(bit) returns null, or
 * { ok: octets } for a good frame, or { err: FrameError } for a discarded one.
 */
class Decoder {
  constructor(fcs = FCS16) {
    this.fcsWidth = fcs;
    // 8.10.2: with 32-bit agreed, a called DCE checks frames at both widths until
    // the SABME says which the rest of the connection uses.
    this.either = false;
    this.matched = fcs;
    this.state = HUNT;
    this.history = 0;
    this.bits = [];
    this.ones = 0;
    this.maxOctets = 2048;     // N401 is 128 by default; generous headroom
    this.overlong = false;
    // The octets of the frame just discarded: the only evidence of what a far end
    // that cannot be read is sending.
    this._discarded = [];
  }

  withMaxOctets(max) { this.maxOctets = max; return this; }
  acceptEither() { this.either = true; }
  setFcs(fcs) { this.fcsWidth = fcs; this.matched = fcs; this.either = false; }
  matchedFcs() { return this.matched; }
  discarded() { return this._discarded; }

  feed(bit) {
    bit = bit ? 1 : 0;
    switch (this.state) {
      case HUNT:
        // Low-order first, so a completed flag reads as 0x7E.
        this.history = (this.history >> 1) | (bit ? 0x80 : 0);
        if (this.history === FLAG) this._enterFrame();
        return null;
      case FRAME:
        if (this.ones === 5) {
          this.ones = 0;
          if (!bit) return null;               // a stuffed zero
          this.state = TERMINATOR;             // a sixth one: flag or abort
          return null;
        }
        if (bit) this.ones++; else this.ones = 0;
        if (this.bits.length >= this.maxOctets * 8) this.overlong = true;
        else this.bits.push(bit);
        return null;
      default: {
        if (bit) {
          // Seven ones: an abort (8.1.4). Five are in the buffer already and some
          // may be the frame's own; 8.1.1.2 means at most four are, and 8.1.3 c)
          // wants whole octets, so the one reading that comes to whole octets is
          // the frame (and a guess, generous, where none does).
          const len = this.bits.length;
          const certain = Math.max(0, len - 5);
          let content = certain;
          for (let n = certain; n < len; n++) if (n % 8 === 0) { content = n; break; }
          this._discarded = octets(this.bits, content);
          this._resetToHunt();
          // A flag with only marks behind it is an idle line, not damage.
          return len > 5 ? { err: FrameError.Aborted } : null;
        }
        // A complete flag: drop the six bits it put in the buffer.
        const keep = Math.max(0, this.bits.length - 6);
        const bits = this.bits.slice(0, keep);
        const overlong = this.overlong;
        this._enterFrame();                    // a closing flag may open the next frame
        const done = Decoder._finish(bits, this.fcsWidth, overlong);
        this.matched = this.fcsWidth;
        this._discarded = done && done.err ? octets(bits) : [];
        if (this.either && done && done.err === FrameError.BadFcs) {
          const other = this.fcsWidth === FCS16 ? FCS32 : FCS16;
          const again = Decoder._finish(bits, other, overlong);
          if (again && again.ok) { this.matched = other; this._discarded = []; return again; }
        }
        return done;
      }
    }
  }

  feedBytesLsbFirst(bytes) {
    const out = [];
    for (const byte of bytes) for (let i = 0; i < 8; i++) { const r = this.feed((byte >> i) & 1); if (r) out.push(r); }
    return out;
  }

  _enterFrame() { this.state = FRAME; this.bits = []; this.ones = 0; this.overlong = false; }
  _resetToHunt() { this.state = HUNT; this.history = 0; this.bits = []; this.ones = 0; this.overlong = false; }

  static _finish(bits, fcs, overlong) {
    if (!bits.length) return null;            // back-to-back flags: idle fill
    if (overlong) return { err: FrameError.TooLong };
    if (bits.length % 8) return { err: FrameError.NotOctetAligned };
    const frame = octets(bits);
    if (frame.length < 2 + fcsOctets(fcs)) return { err: FrameError.TooShort };
    if (!fcsOk(frame, fcs)) return { err: FrameError.BadFcs };
    return { ok: frame.slice(0, frame.length - fcsOctets(fcs)) };
  }
}

module.exports = { FLAG, FCS16, FCS32, fcsOctets, Crc16, Crc32, appendFcs, fcsOk, Encoder, Decoder, FrameError, octets };
