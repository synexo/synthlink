'use strict';

/*!
 * @license
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Copyright (C) 2026 Joseph Quinn
 *
 * Ported from BinModem <https://github.com/CasualArclamp/BinModem>,
 * crates/ec/src/v44/decoder.rs, at commit 623f935e28fe6de3a8a4f41492feb46e1bb86c3a
 * of <https://github.com/synexo/BinModem>. Copyright the BinModem authors;
 * GPL-3.0-or-later. See NOTICE.
 */

/**
 * V44Decoder.js — the V.44 decoder (6.4).
 *
 * A string is created from the code BEFORE the current one (Table 2), so the
 * decoder is a code behind, and the encoder may send a codeword not yet built
 * here: 6.4.1 items 3 and 4 say what that must mean. decode() throws V44Error
 * where the far end's stream cannot be read.
 */

const { BitReader } = require('./Bits');
const V = require('./V44');
const { N5, control, command, TRANSPARENT, COMPRESSED, V44Error, readLength } = V;

// What went immediately before, which Table 2 keys on.
const START = 0, ORDINAL = 1, CODEWORD = 2, EXTENSION = 3;
// One code off the line: { t, v }.
const C_CONTROL = 0, C_CODEWORD = 1, C_ORDINAL = 2, C_EXTENSION = 3;

class Decoder {
  constructor(params) {
    this.params = params;
    this._mode = COMPRESSED;
    this.history = [];
    this.strings = [];          // entry i is codeword N5 + i: { end, len } (6.2.2)
    this.reader = new BitReader();
    this.c2 = 6; this.c5 = 7;
    this.prev = START; this.prevV = 0;
    // 6.6.3's prefix widths key on a codeword immediately before, which a STEPUP
    // between forgets; Table 2's string creation does not (a STEPUP or FLUSH does
    // not affect it), so the two are kept apart.
    this.afterCodeword = false;
    this.steppingUp = false;    // 7.11: the code after a STEPUP says which size grew
    this.escape = 0;
    this.awaitingCommand = false;
  }

  mode() { return this._mode; }
  c1() { return N5 + this.strings.length; }

  /** 7.5.2. */
  _reinitialize() {
    this.history = []; this.strings = [];
    this.c2 = 6; this.c5 = 7;
    this.prev = START; this.afterCodeword = false; this.steppingUp = false;
  }

  decode(input, out) {
    for (const b of input) {
      if (this._mode === TRANSPARENT) this._transparent(b & 0xff, out);
      else { this.reader.pushOctet(b); this._drain(out); }
    }
  }

  /** One octet while transparent (6.5, 7.14); the history is not touched (6.5). */
  _transparent(byte, out) {
    if (this.awaitingCommand) {
      this.awaitingCommand = false;
      if (byte === command.ECM) { this._reinitialize(); this._mode = COMPRESSED; }   // the ESCAPE carries on
      else if (byte === command.EID) { out.push(this.escape); this.escape = (this.escape + 51) & 0xff; }
      else throw new V44Error('ReservedCommand', byte);
      return;
    }
    if (byte === this.escape) { this.awaitingCommand = true; return; }
    out.push(byte);
  }

  _drain(out) {
    while (this._mode === COMPRESSED) {
      const code = this._takeCode();
      if (!code) break;
      this._apply(code, out);
    }
  }

  /** One code, or null if it has not all arrived (then the reader is untouched) (6.6.3). */
  _takeCode() {
    const peek = this.reader.clone();
    const first = peek.read(1);
    if (first === null) return null;
    if (first === 1) {
      // 7.11.2: a STEPUP goes before the codeword that needed it.
      let c2 = this.c2;
      if (this.steppingUp) { if (c2 + 1 > this.params.maxCodeBits()) throw new V44Error('CodewordTooLarge'); c2++; }
      const value = peek.read(c2);
      if (value === null) return null;
      this.reader.assign(peek); this.c2 = c2; this.steppingUp = false;
      return value < N5 ? { t: C_CONTROL, v: value } : { t: C_CODEWORD, v: value };
    }
    // After a codeword an ordinal is "0" "0" and an extension "0" "1"; elsewhere a bare "0".
    let extension = false;
    if (this.afterCodeword) {
      const second = peek.read(1);
      if (second === null) return null;
      extension = second === 1;
    }
    if (extension) {
      const len = readLength(peek, this.params.n7);
      if (len === null) return null;
      this.reader.assign(peek);
      return { t: C_EXTENSION, v: len };
    }
    // 7.11.1: a STEPUP before an ordinal grows it, once, from seven to eight.
    let c5 = this.c5;
    if (this.steppingUp) { if (c5 + 1 > 8) throw new V44Error('OrdinalTooLarge'); c5 = 8; }
    const value = peek.read(c5);
    if (value === null) return null;
    this.reader.assign(peek); this.c5 = c5; this.steppingUp = false;
    return { t: C_ORDINAL, v: value };
  }

  /** [start, len] of a codeword's string in the history, or null. */
  _string(code) {
    const s = this.strings[code - N5];
    if (code < N5 || !s) return null;
    const start = s.end - (s.len - 1);
    return start < 0 ? null : [start, s.len];
  }

  _apply(code, out) {
    // Every control code narrows the next prefix (6.6.3's note).
    if (code.t === C_CONTROL) { this.afterCodeword = false; this._control(code.v); return; }
    this.afterCodeword = code.t === C_CODEWORD;
    this._data(code, out);
  }

  /** Table 8. */
  _control(v) {
    if (v === control.ETM) { this.reader.align(); this._mode = TRANSPARENT; this.awaitingCommand = false; }   // 6.5.1
    else if (v === control.FLUSH) this.reader.align();      // 7.13: string creation untouched
    else if (v === control.STEPUP) this.steppingUp = true;
    else this._reinitialize();                               // REINIT (7.12)
  }

  _data(code, out) {
    const at = this.history.length;
    let produced;
    if (code.t === C_ORDINAL) {
      out.push(code.v); this.history.push(code.v); produced = 1;
    } else if (code.t === C_CODEWORD && code.v < this.c1()) {
      const s = this._string(code.v);
      if (!s) throw new V44Error('UnknownCodeword', code.v);
      this._copy(s[0], s[1], out); produced = s[1];
    } else if (code.t === C_CODEWORD && code.v === this.c1()) {
      // 6.4.1 items 3 and 4: not built yet, so the previous string followed by
      // its own first character, the only string the encoder can have made since.
      let s;
      if (this.prev === CODEWORD) { s = this._string(this.prevV); if (!s) throw new V44Error('UnknownCodeword', code.v); }
      else if (this.prev === ORDINAL) s = [this.history.length - 1, 1];     // "as if a string of length one"
      else throw new V44Error('UnknownCodeword', code.v);
      this._copy(s[0], s[1], out);
      const first = this.history[s[0]];
      out.push(first); this.history.push(first);
      produced = s[1] + 1;
    } else if (code.t === C_CODEWORD) {
      throw new V44Error('UnknownCodeword', code.v);
    } else {
      // Item 5: the characters in the history right after the preceding codeword's
      // string. Only the first need be there; the rest may be this copy's own.
      if (this.prev !== CODEWORD) throw new V44Error('BadExtension');
      const s = this._string(this.prevV);
      if (!s) throw new V44Error('BadExtension');
      const after = s[0] + s[1];
      if (after >= this.history.length) throw new V44Error('BadExtension');
      this._copy(after, code.v, out); produced = code.v;
    }
    this._create(code, at, produced);
    this.prev = code.t === C_ORDINAL ? ORDINAL : code.t === C_CODEWORD ? CODEWORD : EXTENSION;
    this.prevV = code.v;
  }

  /** One at a time: 6.4.1 item 3 can read characters as they are written. */
  _copy(start, len, out) {
    for (let i = 0; i < len; i++) { const c = this.history[start + i]; out.push(c); this.history.push(c); }
  }

  /** Table 2: the string this code and the one before make. */
  _create(code, at, produced) {
    if (this.c1() >= this.params.n2) return;       // full; the far end will REINIT
    let made = null;
    if (code.t === C_ORDINAL && this.prev === ORDINAL) made = { end: at, len: 2 };
    else if (code.t === C_ORDINAL && this.prev === CODEWORD) made = this._longer(this.prevV, at, 1);
    else if (code.t === C_CODEWORD && this.prev === ORDINAL) made = { end: at, len: 2 };
    else if (code.t === C_CODEWORD && this.prev === CODEWORD) made = this._longer(this.prevV, at, 1);
    else if (code.t === C_EXTENSION && this.prev === CODEWORD) made = this._longer(this.prevV, at + produced - 1, produced);
    // The note under Table 2: none longer than N7R.
    if (made && made.len <= this.params.n7) this.strings.push(made);
  }

  _longer(previous, end, more) {
    const s = this.strings[previous - N5];
    return previous < N5 || !s ? null : { end, len: s.len + more };
  }
}

module.exports = { Decoder };
