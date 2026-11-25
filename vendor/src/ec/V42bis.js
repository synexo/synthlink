'use strict';

/*!
 * @license
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Copyright (C) 2026 Joseph Quinn
 *
 * Ported from BinModem <https://github.com/CasualArclamp/BinModem>,
 * crates/ec/src/v42bis/codec.rs, at commit 623f935e28fe6de3a8a4f41492feb46e1bb86c3a
 * of <https://github.com/synexo/BinModem>. Copyright the BinModem authors;
 * GPL-3.0-or-later. See NOTICE.
 */

/**
 * V42bis.js — the V.42bis encoder and decoder (clauses 7, 8 and 9), over
 * V42bisDictionary.js. Octet strings are arrays of numbers.
 */

const { BitReader, BitWriter } = require('./Bits');
const D = require('./V42bisDictionary');
const { Dictionary, ECM, EID, ETM, FLUSH, N4, RESET, STEPUP } = D;

const TRANSPARENT = 'transparent', COMPRESSED = 'compressed';

// 7.8 requires a compressibility test and leaves its nature open: these are ours.
const TEST_WINDOW = 256;          // characters between reconsiderations
const COMPRESS_AT_PERCENT = 90;   // compress once the estimate is this of transparent

class V42bisError extends Error {
  constructor(kind, detail) { super(`V.42bis: ${kind}${detail != null ? ` ${detail}` : ''}`); this.kind = kind; this.detail = detail; }
}

class Common {
  constructor(params) {
    this.dict = new Dictionary(params);
    this.maxBits = params.maxCodeBits();
    this._init();
  }
  // 7.2: transparent, C2 = N3 + 1, C3 = N4 × 2, escape 0.
  _init() { this.mode = TRANSPARENT; this.c2 = 9; this.c3 = N4 * 2; this.escape = 0; }
  reset() { this.dict.reset(); this._init(); }
}

/** Compresses a character stream. */
class Encoder {
  constructor(params) {
    this.inner = new Common(params);
    this.writer = new BitWriter();
    this.matched = null;     // codeword of the string matched so far
    // A codeword sent whose dictionary entry is not made yet: only a flush (or a
    // mode change) leaves one, the extending character not yet known. The
    // decoder is in the same position and calls it `previous`.
    this.owed = null;
    // The entry the last match created, which 6.3 b) forbids extending into, so
    // the decoder never meets a codeword it has not built.
    this.lastAdded = null;
    this.charsIn = 0; this.codewordsOut = 0; this.bitsOut = 0;
  }

  mode() { return this.inner.mode; }

  /** Compress `input`, appending octets to `out`. */
  encode(input, out) { for (const c of input) this._feed(c & 0xff, out); }

  _feed(c, out) {
    this.charsIn++;
    // 9.2: the escape character in data is announced in transparent mode, and in
    // either mode the escape moves on afterwards.
    const isEscape = c === this.inner.escape;
    if (this.inner.mode === TRANSPARENT) { out.push(c); if (isEscape) out.push(EID); }
    if (isEscape) this.inner.escape = (this.inner.escape + 51) & 0xff;

    // String matching (6.3).
    const current = this.matched;
    if (current === null) {
      // The entry a string that ended at a flush owes: clause 8's "previous string
      // extended by this one's first character".
      if (this.owed !== null) { this.lastAdded = this.inner.dict.add(this.owed, c); this.owed = null; }
      this.matched = Dictionary.rootCode(c);
      return;
    }
    const next = this.inner.dict.findChild(current, c);
    if (next !== null && next !== this.lastAdded) { this.matched = next; return; }

    // The match ends: emit it, extend the dictionary, restart.
    if (this.inner.mode === COMPRESSED) this._emit(current, out);
    this.codewordsOut++;
    this.lastAdded = this.inner.dict.add(current, c);
    this.matched = Dictionary.rootCode(c);
    this._considerMode(out);
  }

  /** One codeword, the size grown first if needed (7.4). */
  _emit(code, out) {
    while (code >= this.inner.c3 && this.inner.c2 < this.inner.maxBits) {
      this._write(STEPUP, out); this.inner.c2++; this.inner.c3 *= 2;
    }
    this._write(code, out);
  }

  _write(code, out) { this.writer.write(code, this.inner.c2, out); this.bitsOut += this.inner.c2; }

  /** The compressibility test (7.8); the heuristic is ours. */
  _considerMode(out) {
    if (this.charsIn < TEST_WINDOW) return;
    const transparentBits = this.charsIn * 8;
    if (this.inner.mode === TRANSPARENT) {
      if (this.codewordsOut * this.inner.c2 * 100 < transparentBits * COMPRESS_AT_PERCENT) this._enterCompressed(out);
    } else if (this.bitsOut >= transparentBits) this._enterTransparent(out);
    this.charsIn = 0; this.codewordsOut = 0; this.bitsOut = 0;
  }

  /**
   * 7.8.1. a) is the whole of it: one dictionary update with the accumulated
   * string and the next character, at the transition and no other time. Skipping
   * it leaves every later codeword naming the wrong string against a real modem.
   * The character is not known yet, so the update is owed.
   */
  _enterCompressed(out) {
    out.push(this.inner.escape, ECM);
    this.inner.mode = COMPRESSED;
    this.owed = this.matched; this.matched = null; this.lastAdded = null;
  }

  /** 7.8.2: b) is the same debt, owed at the other transition. */
  _enterTransparent(out) {
    const accumulated = this.matched;
    this._emitPending(out);
    this._write(ETM, out);
    this.writer.align(out);
    this.inner.mode = TRANSPARENT;
    this.matched = null;
    if (accumulated !== null) this.owed = accumulated;
    this.lastAdded = null;
  }

  _emitPending(out) {
    const current = this.matched; this.matched = null;
    if (current !== null && this.inner.mode === COMPRESSED) this._emit(current, out);
  }

  /**
   * Send everything outstanding (7.9). A flush puts bits on the line and forgets
   * nothing: the dictionary is a history both ends share, and an encoder dropping
   * its context here walks away from a state the far end still holds.
   */
  flush(out) {
    if (this.inner.mode !== COMPRESSED) return;   // transparent has sent every character
    const current = this.matched;
    if (current !== null) { this.matched = null; this._emit(current, out); this.owed = current; }
    if (this.writer.pending() > 0) { this._write(FLUSH, out); this.writer.align(out); }
  }

  /** Re-initialise and tell the peer (7.8.3). */
  reset(out) {
    if (this.inner.mode === COMPRESSED) this._enterTransparent(out);
    out.push(this.inner.escape, RESET);
    this.inner.reset();
    this.matched = null; this.owed = null; this.lastAdded = null;
    this.charsIn = 0; this.codewordsOut = 0; this.bitsOut = 0;
  }
}

/** Decompresses a character stream. decode() throws V42bisError where the far end's stream cannot be read. */
class Decoder {
  constructor(params) {
    this.inner = new Common(params);
    this.reader = new BitReader();
    this.previous = null;        // the codeword the next entry extends
    this.lastAdded = null;
    this.awaitingCommand = false;
    this.matched = null;         // transparent-mode matching, tracking the encoder
    this.owed = null;            // the encoder's `owed`, mirrored
  }

  mode() { return this.inner.mode; }

  decode(input, out) {
    for (const b of input) {
      if (this.inner.mode === TRANSPARENT) this._transparentOctet(b & 0xff, out);
      else { this.reader.pushOctet(b); this._drainCodewords(out); }
    }
  }

  _transparentOctet(byte, out) {
    if (this.awaitingCommand) {
      this.awaitingCommand = false;
      switch (byte) {
        case ECM:
          this.inner.mode = COMPRESSED;
          this.owed = null;
          // 7.8.1 a) from this side: the far end extended its accumulated string by
          // the first character of its first codeword's string.
          this.previous = this.matched; this.lastAdded = null; this.matched = null;
          break;
        case EID: {                    // the escape was literal data (9.2)
          const literal = this.inner.escape;
          out.push(literal);
          this._matchStep(literal);
          this.inner.escape = (this.inner.escape + 51) & 0xff;
          break;
        }
        case RESET:
          this.inner.reset();
          this.previous = null; this.lastAdded = null; this.matched = null; this.owed = null;
          break;
        default: throw new V42bisError('ReservedCommand', byte);
      }
      return;
    }
    if (byte === this.inner.escape) { this.awaitingCommand = true; return; }
    out.push(byte);
    this._matchStep(byte);
  }

  /** Keep the dictionary while transparent, as the far end's encoder does (clause 8). */
  _matchStep(c) {
    const current = this.matched;
    if (current === null) {
      if (this.owed !== null) { this.lastAdded = this.inner.dict.add(this.owed, c); this.owed = null; }
      this.matched = Dictionary.rootCode(c);
      return;
    }
    const next = this.inner.dict.findChild(current, c);
    if (next !== null && next !== this.lastAdded) { this.matched = next; return; }
    this.lastAdded = this.inner.dict.add(current, c);
    this.matched = Dictionary.rootCode(c);
  }

  _drainCodewords(out) {
    while (this.inner.mode === COMPRESSED && this.reader.available() >= this.inner.c2) {
      const code = this.reader.read(this.inner.c2);
      if (code === null) break;
      if (code === STEPUP) {
        if (this.inner.c2 + 1 > this.inner.maxBits) throw new V42bisError('CodewordTooLarge');
        this.inner.c2++; this.inner.c3 *= 2;
      } else if (code === ETM) {
        this.reader.align();
        this.inner.mode = TRANSPARENT;
        // 7.8.2 b) from this side: the entry for the last codeword and the first
        // transparent character, made when that character arrives.
        this.owed = this.previous; this.previous = null; this.lastAdded = null; this.matched = null;
      } else if (code === FLUSH) this.reader.align();
      else this._decodeString(code, out);
    }
  }

  _decodeString(code, out) {
    // 6.3 b) keeps the encoder from sending a codeword it has just made, so an
    // unknown one means the dictionaries have diverged.
    if (!this.inner.dict.inUse(code)) throw new V42bisError('UnknownCodeword', code);
    const s = this.inner.dict.string(code);
    // 9.2 b) and 2.13: the escape moves on at each appearance in the data, in
    // compressed mode too, so these characters move it here as well.
    for (const c of s) if (c === this.inner.escape) this.inner.escape = (this.inner.escape + 51) & 0xff;
    for (const c of s) out.push(c);
    // The new entry: the previous string extended by this one's first character.
    if (this.previous !== null && s.length) this.lastAdded = this.inner.dict.add(this.previous, s[0]);
    this.previous = code;
  }
}

module.exports = { Encoder, Decoder, V42bisError, TRANSPARENT, COMPRESSED, ...D };
