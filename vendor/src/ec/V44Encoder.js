'use strict';

/*!
 * @license
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Copyright (C) 2026 Joseph Quinn
 *
 * Ported from BinModem <https://github.com/CasualArclamp/BinModem>,
 * crates/ec/src/v44/encoder.rs, at commit 623f935e28fe6de3a8a4f41492feb46e1bb86c3a
 * of <https://github.com/synexo/BinModem>. Copyright the BinModem authors;
 * GPL-3.0-or-later. See NOTICE.
 */

/**
 * V44Encoder.js — the V.44 encoder (6.3) and the transfer rules that put its
 * codes on the line (6.6).
 *
 * Table 1 is the whole loop: match the longest string the dictionary holds, send
 * the codeword of its last segment, carry on matching against the raw history and
 * send how many more characters matched, then learn from whichever failed. Every
 * path creates at most one node. A node made by extension points at "the first of
 * the most recent input characters used to extend the string" (6.3.2): the new
 * copy, not the old one, which a loopback cannot tell apart and a far end can.
 */

const { BitWriter } = require('./Bits');
const V = require('./V44');
const { N5, control, command, TRANSPARENT, COMPRESSED, writeLength } = V;

// 7.11.5 requires a compressibility test and leaves it open: these are ours.
const TEST_WINDOW = 512;
const GIVE_UP_PERCENT = 100;

const OWED_NOTHING = 0, OWED_ROOT = 1, OWED_UNDER = 2;

class Encoder {
  constructor(params) {
    this.params = params;
    this._mode = COMPRESSED;
    this.history = [];          // every character since the dictionary last started (6.2.1 3)
    this.root = new Int32Array(256).fill(-1);   // a down-index per character (6.2.1 1)
    this.nodes = [];            // node i is codeword N5 + i: { at, len, total, down, side }
    // C4: how far along the history the encoder has got. 6.3 puts input in the
    // history as it arrives, so a node may point at a character not yet sent.
    this.at = 0;
    this.writer = new BitWriter();
    this.c2 = 6; this.c5 = 7; this.c3 = 64;      // codeword size, ordinal size, threshold (7.5.1)
    this.afterCodeword = false;                  // 6.6.3: prefixes depend on it
    this.owedKind = OWED_NOTHING; this.owedArg = 0;
    this.escape = 0;                             // 7.14, transparent mode only
    this.charsIn = 0; this.bitsOut = 0;
    this._reinitialize();
  }

  mode() { return this._mode; }
  /** C1, the codeword of the next node. */
  c1() { return N5 + this.nodes.length; }

  /** 7.5.1. 7.11.4: what has arrived and not been encoded moves to the front. */
  _reinitialize() {
    this.history.splice(0, this.at);
    this.at = 0;
    this.root.fill(-1);
    this.nodes = [];
    this.c2 = 6; this.c3 = 64; this.c5 = 7;
    this.afterCodeword = false;
    this.owedKind = OWED_NOTHING;
  }

  encode(input, out) {
    for (const c of input) this.history.push(c & 0xff);
    this.charsIn += input.length;
    this._run(false, out);
  }

  _waiting() { return this.history.length - this.at; }

  /** 7.13: end what is part-done, put it on the line, and align. */
  flush(out) {
    this._run(true, out);
    if (this._mode === COMPRESSED && this.writer.pending() > 0) { this._putControl(control.FLUSH, out); this.writer.align(out); }
  }

  /** Work through what is pending; with `all`, nothing waits for more characters. */
  _run(all, out) {
    for (;;) {
      if (this._mode === TRANSPARENT) {
        this._transparently(out);
        this._considerMode(out);
        if (this._mode === TRANSPARENT) return;
        continue;
      }
      if (this._waiting() === 0 || (!all && !this._enough())) return;
      this._settleOwed();
      this._step(out);
      this._considerMode(out);
    }
  }

  /** 6.5: everything waiting, as itself, with 7.14's ESCAPE. */
  _transparently(out) {
    while (this.at < this.history.length) {
      const c = this.history[this.at++];
      out.push(c);
      if (c === this.escape) { out.push(command.EID); this.escape = (this.escape + 51) & 0xff; }
    }
  }

  /** A match can always be extended: sure only with the longest string in hand. */
  _enough() { return this._waiting() > this.params.n7; }

  /** The node the last step could not make, now its character is here. */
  _settleOwed() {
    const kind = this.owedKind; this.owedKind = OWED_NOTHING;
    if (kind === OWED_ROOT) this._appendToRoot(this.owedArg, this.at);
    else if (kind === OWED_UNDER) this._addChild(this.owedArg, this.at, 1);
  }

  /** One pass of Table 1. */
  _step(out) {
    // 7.11.3, 7.11.4: no room for a codeword, or the history at its end.
    if (this.at >= this.params.n8 || !this._room()) this._restart(out);
    if (this.at >= this.history.length) return;
    const first = this.history[this.at];
    const found = this._find();
    if (!found) {
      // String-matching failure: the ordinal, and a 1-character segment off this
      // root from the next character (6.3.3), owed until it is here.
      this.at++;
      this._putOrdinal(first, out);
      this.owedKind = OWED_ROOT; this.owedArg = first;
      return;
    }
    this.at += found.used;
    this._putCodeword(N5 + found.node, out);
    const room = Math.max(0, this.params.n7 - found.used);
    const extension = this._extension(found, room);
    if (extension > 0) {
      const at = this.at;                       // 6.3.2: the copy just matched
      this.at += extension;
      this._putExtension(extension, out);
      this._addChild(found.node, at, extension);
    } else {
      // String-extension failure: nothing sent; the unmatched character appends.
      this.owedKind = OWED_UNDER; this.owedArg = found.node;
    }
  }

  /**
   * How far the match carries on against the history (6.3.2), by the literal
   * rule the decoder follows (6.4.1 item 5). The runs may overlap: a repeated
   * character matches itself one place along.
   */
  _extension(found, room) {
    const node = this.nodes[found.node];
    const after = node.at + node.len;
    const h = this.history;
    let n = 0;
    while (n < room && this.at + n < h.length && after + n < h.length && h[after + n] === h[this.at + n]) n++;
    return n;
  }

  /** The longest string match from the first pending character (6.3.1), or null. */
  _find() {
    const h = this.history;
    const first = h[this.at];
    let level = this.root[first];
    if (level < 0) return null;
    let used = 1, last = -1;
    for (;;) {
      let best = -1;
      for (let index = level; index >= 0; index = this.nodes[index].side) {
        const n = this.nodes[index];
        let same = 0;
        const base = this.at + used;
        while (same < n.len && base + same < h.length && h[n.at + same] === h[base + same]) same++;
        if (same === n.len && same > 0) { best = index; break; }
      }
      if (best < 0) break;
      const n = this.nodes[best];
      used += n.len;
      last = best;
      if (n.down >= 0 && this.at + used < h.length) level = n.down; else break;
    }
    // 6.3.1: no second-level node matched, which is a match that never left the root.
    return last >= 0 ? { node: last, used } : null;
  }

  _room() { return this.c1() < this.params.n2; }

  _newNode(at, len, total) {
    if (!this._room() || total > this.params.n7) return -1;
    this.nodes.push({ at, len, total, down: -1, side: -1 });
    return this.nodes.length - 1;           // the index, the codeword less N5
  }

  /** A one-character segment under a root (6.3.3, "Append"). */
  _appendToRoot(first, at) {
    const node = this._newNode(at, 1, 2);
    if (node < 0) return;
    if (this.root[first] < 0) this.root[first] = node; else this._linkSide(this.root[first], node);
  }

  /** The extension under the matched segment (6.3.3, "Extend"). */
  _addChild(parent, at, len) {
    const node = this._newNode(at, len, this.nodes[parent].total + len);
    if (node < 0) return;
    if (this.nodes[parent].down < 0) this.nodes[parent].down = node; else this._linkSide(this.nodes[parent].down, node);
  }

  _linkSide(head, node) {
    let at = head;
    while (this.nodes[at].side >= 0) at = this.nodes[at].side;
    this.nodes[at].side = node;
  }

  // ── transfer (6.6) ──
  _write(value, bits, out) { this.writer.write(value, bits, out); this.bitsOut += bits; }
  // Control codes are not measured: a FLUSH per keystroke would make typing look incompressible.
  _writeControl(value, bits, out) { this.writer.write(value, bits, out); }

  /** 6.6.3: a control code takes the prefix "1". */
  _putControl(code, out) { this._writeControl(1, 1, out); this._writeControl(code, this.c2, out); this.afterCodeword = false; }

  /** 7.11.1: ordinals start at seven bits and step up once, for one above 127. */
  _putOrdinal(value, out) {
    if (value > 127 && this.c5 === 7) { this._putControl(control.STEPUP, out); this.c5 = 8; }
    this._write(0, this.afterCodeword ? 2 : 1, out);   // "0", or "00" after a codeword
    this._write(value, this.c5, out);
    this.afterCodeword = false;
  }

  /** 7.11.2: widen the codeword until the value fits, announcing each step. */
  _putCodeword(code, out) {
    while (code >= this.c3 && this.c2 < this.params.maxCodeBits()) { this._putControl(control.STEPUP, out); this.c2++; this.c3 *= 2; }
    this._write(1, 1, out);
    this._write(code, this.c2, out);
    this.afterCodeword = true;
  }

  /** An extension only follows a codeword: prefix "0" "1". */
  _putExtension(len, out) {
    this._write(0, 1, out); this._write(1, 1, out);
    writeLength(len, this.params.n7, this.writer, out);    // not counted, as BinModem's is not
    this.afterCodeword = false;
  }

  /** 7.12: start again, telling the far end if it listens in compressed mode. */
  _restart(out) { if (this._mode === COMPRESSED) this._putControl(control.REINIT, out); this._reinitialize(); }

  /** 7.11.5's test, "not specified in this Recommendation". */
  _considerMode(out) {
    if (this.charsIn < TEST_WINDOW) return;
    const plain = this.charsIn * 8;
    if (this._mode === COMPRESSED) { if (this.bitsOut * 100 >= plain * GIVE_UP_PERCENT) this._enterTransparent(out); }
    else this.enterCompressed(out);          // another go every window (6.5.2 restarts the dictionary anyway)
    this.charsIn = 0; this.bitsOut = 0;
  }

  /** 6.5.1 on demand, for a test that wants to watch the transition. */
  enterTransparentNow(out) { this._run(true, out); if (this._mode === COMPRESSED) this._enterTransparent(out); }

  _enterTransparent(out) { this._putControl(control.ETM, out); this.writer.align(out); this._mode = TRANSPARENT; }

  /**
   * 6.5.2: reinitialise, then the ESCAPE, then ECM, in that order. The ESCAPE is
   * not part of the dictionary (7.14 sets it at C-INIT only) and stays where it is.
   */
  enterCompressed(out) {
    if (this._mode === COMPRESSED) return;
    this._reinitialize();
    out.push(this.escape, command.ECM);
    this._mode = COMPRESSED;
  }
}

module.exports = { Encoder };
