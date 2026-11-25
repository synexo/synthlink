'use strict';

/*!
 * @license
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Copyright (C) 2026 Joseph Quinn
 *
 * Ported from BinModem <https://github.com/CasualArclamp/BinModem>,
 * crates/ec/src/v44/mod.rs and crates/ec/src/v44/length.rs, at commit
 * 623f935e28fe6de3a8a4f41492feb46e1bb86c3a of <https://github.com/synexo/BinModem>.
 * Copyright the BinModem authors; GPL-3.0-or-later. See NOTICE.
 */

/**
 * V44.js — V.44 (LZJH): constants, parameters and the string-extension length
 * code. V44Encoder.js and V44Decoder.js are the two halves over it.
 *
 * Better than V.42bis on what a modem carries: nodes hold string SEGMENTS
 * pointing into the history, and after the longest known match the encoder
 * carries on matching against the raw history and sends only how many more
 * characters matched (6.3.2). The dictionary is a root array, a node tree and the
 * history (6.2.1); there is no node recovery, only reinitialisation when the
 * tree or the history fills (7.11.3, 7.11.4).
 */

const N5 = 4;               // control codes, and the first codeword (Table 11)
const control = Object.freeze({ ETM: 0, FLUSH: 1, STEPUP: 2, REINIT: 3 });   // Table 8
const command = Object.freeze({ ECM: 0, EID: 1, EPM: 2 });                   // Table 9
const ALPHABET = 256;
const DEFAULT_N2 = 1024, DEFAULT_N7 = 255;      // Table 10
const OFFERED_N2 = 2048, OFFERED_N7 = 255;      // what this end proposes

const TRANSPARENT = 'transparent', COMPRESSED = 'compressed';

/** The negotiated parameters for one direction (Tables 10, 11). */
class Params {
  constructor(n2 = DEFAULT_N2, n7 = DEFAULT_N7, n8 = null) {
    this.n2 = n2; this.n7 = n7;
    this.n8 = n8 == null ? Math.min(0xffff, n2 * 3) : n8;    // Table 10: three times N2
  }
  /** The pair that is negotiated, with the history Table 10 pairs with them. */
  static of(n2, n7) { return new Params(n2, n7); }
  /** N1: enough bits to name every codeword up to N2 − 1. */
  maxCodeBits() { let b = 6; while ((1 << b) < this.n2) b++; return b; }
  /** 7.4: floors of 256 codewords, a string of 32, a history of 512. */
  valid() { return this.n2 >= 256 && this.n7 >= 32 && this.n8 >= 512; }
  /** 7.4: the lesser of two proposals. */
  resolve(theirs) { return new Params(Math.min(this.n2, theirs.n2), Math.min(this.n7, theirs.n7), Math.min(this.n8, theirs.n8)); }
  equals(o) { return !!o && this.n2 === o.n2 && this.n7 === o.n7 && this.n8 === o.n8; }
}

class V44Error extends Error {
  constructor(kind, detail) { super(`V.44: ${kind}${detail != null ? ` ${detail}` : ''}`); this.kind = kind; this.detail = detail; }
}

// ── String-extension lengths (6.6.2, Tables 3 and 4) ────────────────────────
// Each subfield goes low-order bit first like every other code (6.6), which is
// why Table 3's two columns look as if they disagree: the same bits twice.

const LENGTH_MOST = 253;    // Table 4 stops at 253: N7 − 2, a string being at least 2

function tailBits(n7) { return n7 <= 46 ? 5 : n7 <= 78 ? 6 : n7 <= 142 ? 7 : 8; }

/** The largest extension `n7` can express. */
function lengthMostFor(n7) {
  const byTable = 13 + (1 << tailBits(n7)) - 1;
  return Math.min(byTable, Math.max(0, n7 - 2), LENGTH_MOST);
}

function writeLength(length, n7, w, out) {
  if (length === 1) w.write(1, 1, out);                              // "1"
  else if (length <= 4) { w.write(0, 1, out); w.write(length - 1, 2, out); }
  else if (length <= 12) { w.write(0, 1, out); w.write(0, 2, out); w.write(0, 1, out); w.write(length - 5, 3, out); }
  else { w.write(0, 1, out); w.write(0, 2, out); w.write(1, 1, out); w.write(length - 13, tailBits(n7), out); }
}

/** One length, or null if its bits have not all arrived (then nothing is consumed). */
function readLength(r, n7) {
  const tail = tailBits(n7);
  if (r.available() < 1) return null;
  const peek = r.clone();
  const first = peek.read(1);
  if (first === null) return null;
  if (first === 1) { r.assign(peek); return 1; }
  const two = peek.read(2);
  if (two === null) return null;
  if (two !== 0) { r.assign(peek); return two + 1; }
  const which = peek.read(1);
  if (which === null) return null;
  const value = peek.read(which === 0 ? 3 : tail);
  if (value === null) return null;
  r.assign(peek);
  return value + (which === 0 ? 5 : 13);
}

module.exports = {
  N5, control, command, ALPHABET, DEFAULT_N2, DEFAULT_N7, OFFERED_N2, OFFERED_N7,
  TRANSPARENT, COMPRESSED, Params, V44Error,
  LENGTH_MOST, lengthMostFor, writeLength, readLength,
};
