'use strict';

/*!
 * @license
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Copyright (C) 2026 Joseph Quinn
 *
 * Ported from BinModem <https://github.com/CasualArclamp/BinModem>,
 * crates/ec/src/v42bis/dictionary.rs, at commit
 * 623f935e28fe6de3a8a4f41492feb46e1bb86c3a of <https://github.com/synexo/BinModem>.
 * Copyright the BinModem authors; GPL-3.0-or-later. See NOTICE.
 */

/**
 * V42bisDictionary.js — the BTLZ dictionary (V.42bis clause 6), and the
 * parameters and constants the rest of V.42bis shares.
 *
 * 256 trees, one per character; a node's codeword names the string from its root
 * to it. Both ends build theirs by the same rules from the same data, so a
 * codeword is reversible.
 */

const N3 = 8;                 // character size in bits
const N4 = 256;               // characters in the alphabet
const N6 = 3;                 // control codewords: ETM, FLUSH, STEPUP
const N5 = N4 + N6;           // first codeword for a multi-character string
const ETM = 0, FLUSH = 1, STEPUP = 2;          // Table 2, compressed mode
const ECM = 0, EID = 1, RESET = 2;             // after the escape, transparent mode
const DEFAULT_N2 = 512;       // P1's default and minimum (5.1)
// Proposed, not the default: 6.4 takes the lower of the two, so proposing the
// minimum forces it on every far end. Appendix II.1 names 2048.
const OFFERED_N2 = 2048;
const DEFAULT_N7 = 6;         // P2 defaults to 6, ranges 6..250
const OFFERED_N7 = 250;

/** { n2, n7 } with V.42bis's derived values and checks. */
class Params {
  constructor(n2 = DEFAULT_N2, n7 = DEFAULT_N7) { this.n2 = n2; this.n7 = n7; }
  /** N1: enough bits to address N2 codewords. */
  maxCodeBits() { let b = N3 + 1; while ((1 << b) < this.n2) b++; return b; }
  /** null, or why 5.1 calls these a procedural error. */
  validate() {
    if (this.n2 < DEFAULT_N2) return 'N2 below the minimum of 512';
    if (this.n7 < 6 || this.n7 > 250) return 'N7 outside the permitted range of 6 to 250';
    return null;
  }
}

class Dictionary {
  constructor(params) {
    this.params = params;
    const n = params.n2;
    this.parent = new Int32Array(n);    // -1 for a root or a free slot
    this.ch = new Uint8Array(n);
    this.children = new Uint16Array(n); // zero is a leaf; only leaves are recovered (6.5)
    this.depthOf = new Uint8Array(n);
    this.used = new Uint8Array(n);
    this.index = new Map();             // parent * 256 + ch → codeword
    this.c1 = N5;
    this.reset();
  }

  /** The initial condition (6.2): every tree a bare root, C1 = N5. */
  reset() {
    this.parent.fill(-1); this.ch.fill(0); this.children.fill(0); this.depthOf.fill(0); this.used.fill(0);
    this.index.clear();
    for (let c = 0; c < N4; c++) {
      const code = Dictionary.rootCode(c);
      this.ch[code] = c; this.depthOf[code] = 1; this.used[code] = 1;
    }
    this.c1 = N5;
  }

  /** The codeword of the single character `ch`: N6 plus its ordinal (6.2). */
  static rootCode(ch) { return N6 + ch; }

  findChild(parent, ch) { const v = this.index.get(parent * 256 + ch); return v === undefined ? null : v; }
  depth(code) { return code >= 0 && code < this.params.n2 ? this.depthOf[code] : 0; }
  inUse(code) { return code >= 0 && code < this.params.n2 && this.used[code] === 1; }

  /** The string a codeword names, first character first. */
  string(code) {
    const out = [];
    let c = code;
    while (c >= 0 && c < this.params.n2 && this.used[c]) { out.push(this.ch[c]); c = this.parent[c]; }
    return out.reverse();
  }

  /** The first character of the string a codeword names, or null. */
  firstChar(code) {
    let c = code;
    for (;;) {
      if (c < 0 || c >= this.params.n2 || !this.used[c]) return null;
      if (this.parent[c] < 0) return this.ch[c];
      c = this.parent[c];
    }
  }

  /** Add parent + ch (6.4): the new codeword, or null if present or past N7. */
  add(parent, ch) {
    if (this.depth(parent) + 1 > this.params.n7) return null;
    if (this.findChild(parent, ch) !== null) return null;
    const code = this.c1;
    this._evict(code);                  // the slot may hold an entry recovered earlier
    this.parent[code] = parent; this.ch[code] = ch; this.children[code] = 0;
    this.depthOf[code] = this.depth(parent) + 1; this.used[code] = 1;
    this.index.set(parent * 256 + ch, code);
    this.children[parent]++;
    this._recover();                    // 6.4: recovery runs after every creation
    return code;
  }

  /** Free a single entry for re-use (6.5); bounded so it cannot spin. */
  _recover() {
    const span = this.params.n2 - N5;
    for (let k = 0; k < span; k++) {
      this.c1++;
      if (this.c1 > this.params.n2 - 1) this.c1 = N5;
      if (this.used[this.c1] && this.children[this.c1] > 0) continue;
      if (this.used[this.c1]) this._evict(this.c1);
      return;
    }
  }

  /** Detach a leaf from its parent and mark the slot free. */
  _evict(code) {
    if (!this.used[code]) return;
    const p = this.parent[code];
    if (p >= 0) { this.index.delete(p * 256 + this.ch[code]); if (this.children[p] > 0) this.children[p]--; }
    this.parent[code] = -1; this.ch[code] = 0; this.children[code] = 0; this.depthOf[code] = 0; this.used[code] = 0;
  }
}

module.exports = {
  N3, N4, N5, N6, ETM, FLUSH, STEPUP, ECM, EID, RESET,
  DEFAULT_N2, OFFERED_N2, DEFAULT_N7, OFFERED_N7, Params, Dictionary,
};
