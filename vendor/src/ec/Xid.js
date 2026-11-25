'use strict';

/*!
 * @license
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Copyright (C) 2026 Joseph Quinn
 *
 * Ported from BinModem <https://github.com/CasualArclamp/BinModem>,
 * crates/ec/src/xid.rs, at commit 623f935e28fe6de3a8a4f41492feb46e1bb86c3a of
 * <https://github.com/synexo/BinModem>. Copyright the BinModem authors;
 * GPL-3.0-or-later. See NOTICE.
 */

/**
 * Xid.js — XID parameter negotiation (V.42 8.10 and 12.2, V.42bis Annex A,
 * V.44 Annex A).
 *
 * A format identifier, then subfields: a group identifier, a two-octet group
 * length and PI/PL/PV triples — except the user data subfield (V.44), last, with
 * no group length, running to the FCS (12.2.1.3). This is how N401, k, the FCS
 * width, selective reject and the compression parameters are agreed.
 */

const { COMMAND, RESPONSE } = require('./Frame');
const B = require('./V42bisDictionary');
const V44 = require('./V44');
const { DEFAULT_N401, DEFAULT_K } = require('./Lapm');

const FI_GENERAL_PURPOSE = 0b10000010;   // 12.2.2
const GI_PARAMETER = 0b10000000;
const GI_PRIVATE = 0b11110000;
const GI_USER_DATA = 0b11111111;         // V.44 7.3: no group length, last
const PI = { HDLC_OPTIONAL: 3, N401_TRANSMIT: 5, N401_RECEIVE: 6, WINDOW_TRANSMIT: 7, WINDOW_RECEIVE: 8 };   // Table 11a
const PRIVATE_PI = { PARAMETER_SET: 0, COMPRESSION_REQUEST: 1, CODEWORDS: 2, MAX_STRING: 3 };            // Table 11b
const USER_PI = {                                                                                          // V.44 Table A.1
  PARAMETER_SET: 0x40, CAPABILITY: 0x41, REQUEST: 0x42, CODEWORDS_TRANSMIT: 0x43, CODEWORDS_RECEIVE: 0x44,
  MAX_STRING_TRANSMIT: 0x45, MAX_STRING_RECEIVE: 0x46, HISTORY_TRANSMIT: 0x47, HISTORY_RECEIVE: 0x48,
};
const PARAMETER_SET_V44 = [0x56, 0x34, 0x34];   // "V44"
// 12.2.2 Note 2 prints 00101010 ("*"); V.42bis Table A-1 gives "V", which is right.
const PARAMETER_SET_V42 = [0x56, 0x34, 0x32];   // "V42"
const CAPABILITY_MODEM = 0;                     // no packet methods, negotiated here (Table A.1)

// HDLC optional functions mask bit positions (Table 11a Note 1); bit 1 goes first.
const HDLC_BIT = { SREJ_SINGLE: 3, TEST_FRAME: 14, FCS32: 17, SREJ_MULTIPLE: 24, CLEARED_BY_FCS32: 16 };
const HDLC_REQUIRED = [2, 4, 8, 9, 12, 16];     // set whatever is supported; receivers ignore them

/**
 * The mask's octets on the wire: three unless a bit past 24 is set. Note 1 says
 * PL = 4, but one real far end (Agere SV92PP) abandons the whole field on anything
 * but 3, and every real modem sends three.
 */
function maskOctets(mask) {
  const o = [mask & 0xff, (mask >>> 8) & 0xff, (mask >>> 16) & 0xff, (mask >>> 24) & 0xff];
  return o[3] ? o : o.slice(0, 3);
}

// Compression directions (Table 11b P0): 0 neither, 1 initiator→responder, 2 responder→initiator, 3 both.
const Compression = Object.freeze({ Neither: 0, InitiatorToResponder: 1, ResponderToInitiator: 2, Both: 3 });
/** V.44's P0 is relative to its sender (7.4), so an answer turns it round. */
const flipped = (c) => (c === 1 ? 2 : c === 2 ? 1 : c);
const intersect = (a, b) => a & b & 3;

/** What one end proposes for V.44: P0, and P1/P2/P3 each way (Table A.1). */
class V44Offer {
  constructor(compression, transmit, receive) { this.compression = compression; this.transmit = transmit; this.receive = receive; }
  static proposal(compression) { const p = V44.Params.of(V44.OFFERED_N2, V44.OFFERED_N7); return new V44Offer(compression, p, V44.Params.of(V44.OFFERED_N2, V44.OFFERED_N7)); }
  /** Settled crosswise (7.4): this end's transmit against what the far end can receive. */
  resolve(other) {
    const compression = intersect(this.compression, flipped(other.compression));
    if (compression === Compression.Neither) return null;
    const transmit = this.transmit.resolve(other.receive), receive = this.receive.resolve(other.transmit);
    // 7.4 calls below-minimum a procedural error; refusing V.44 is kinder.
    if (!transmit.valid() || !receive.valid()) return null;
    return new V44Offer(compression, transmit, receive);
  }
  equals(o) { return !!o && this.compression === o.compression && this.transmit.equals(o.transmit) && this.receive.equals(o.receive); }
}

class XidError extends Error {
  constructor(kind, detail) { super(`XID: ${kind}${detail != null ? ` ${detail}` : ''}`); this.kind = kind; this.detail = detail; }
}

/** A parameter value in one or two octets, high-order first (Note 4); null otherwise (the default stands). */
function beU16(v) { return v.length === 1 ? v[0] : v.length === 2 ? (v[0] << 8) | v[1] : null; }
/** The lower of two proposals, an absent one being its default (9.2.3, 9.2.4, V.42bis 6.4), not silence. */
const lower = (a, b, def) => Math.min(a == null ? def : a, b == null ? def : b);

function pushParam(out, pi, value) { out.push(pi, value.length, ...value); }
function pushSubfield(out, gi, params) { out.push(gi, (params.length >> 8) & 0xff, params.length & 0xff, ...params); }

/** One parameter off the front: [pi, value, rest], null at the end; throws if it runs past. */
function takeParam(field) {
  if (!field.length) return null;
  if (field.length < 2) throw new XidError('Truncated');
  const pi = field[0], pl = field[1], end = 2 + pl;
  if (end > field.length) throw new XidError('Truncated');
  return [pi, field.slice(2, end), field.slice(end)];
}

/**
 * What an XID proposes or reports. Absent (null/undefined) means not mentioned,
 * which leaves a negotiated value unchanged (Note 3).
 */
class Xid {
  constructor(o = {}) {
    this.n401Transmit = o.n401Transmit ?? null; this.n401Receive = o.n401Receive ?? null;
    this.windowTransmit = o.windowTransmit ?? null; this.windowReceive = o.windowReceive ?? null;
    this.fcs32 = !!o.fcs32; this.srejSingle = !!o.srejSingle; this.testFrame = !!o.testFrame; this.srejMultiple = !!o.srejMultiple;
    this.compression = o.compression ?? null;     // V.42bis P0, only with the private subfield
    this.codewords = o.codewords ?? null;         // P1
    this.maxString = o.maxString ?? null;         // P2
    this.v44 = o.v44 ?? null;                     // V44Offer, only with the user data subfield
  }

  /** Everything this end supports, as an opening proposal. */
  static proposal(compression) {
    return new Xid({
      n401Transmit: DEFAULT_N401, n401Receive: DEFAULT_N401, windowTransmit: DEFAULT_K, windowReceive: DEFAULT_K,
      // Offered: a 16-bit FCS lets about one damaged frame in 65536 through, and
      // what runs is the intersection.
      fcs32: true,
      // Offered: go-back-N resends a whole window to recover one frame.
      srejSingle: true, testFrame: true, srejMultiple: false,
      compression, codewords: B.OFFERED_N2, maxString: B.OFFERED_N7,
      // Both in the one XID, which only a command may do; the far end picks (7.3).
      v44: V44Offer.proposal(compression),
    });
  }

  clone() { return new Xid(this); }

  /** The information field of an XID command or response (only the mask's bit 16 differs). */
  encode(kind) {
    const out = [FI_GENERAL_PURPOSE];
    const params = [];
    pushParam(params, PI.HDLC_OPTIONAL, maskOctets(this._hdlcMask(kind)));
    // Note 3: N401 is in octets, negotiated in bits.
    if (this.n401Transmit != null) { const n = this.n401Transmit * 8; pushParam(params, PI.N401_TRANSMIT, [(n >> 8) & 0xff, n & 0xff]); }
    if (this.n401Receive != null) { const n = this.n401Receive * 8; pushParam(params, PI.N401_RECEIVE, [(n >> 8) & 0xff, n & 0xff]); }
    if (this.windowTransmit != null) pushParam(params, PI.WINDOW_TRANSMIT, [this.windowTransmit]);
    if (this.windowReceive != null) pushParam(params, PI.WINDOW_RECEIVE, [this.windowReceive]);
    pushSubfield(out, GI_PARAMETER, params);

    if (this.compression != null) {
      const priv = [];
      pushParam(priv, PRIVATE_PI.PARAMETER_SET, PARAMETER_SET_V42);        // Note 2: always first
      pushParam(priv, PRIVATE_PI.COMPRESSION_REQUEST, [this.compression]);
      if (this.codewords != null) pushParam(priv, PRIVATE_PI.CODEWORDS, [(this.codewords >> 8) & 0xff, this.codewords & 0xff]);
      if (this.maxString != null) pushParam(priv, PRIVATE_PI.MAX_STRING, [this.maxString]);
      pushSubfield(out, GI_PRIVATE, priv);
    }

    if (this.v44) {
      const u = [], v = this.v44, be = (n) => [(n >> 8) & 0xff, n & 0xff];
      pushParam(u, USER_PI.PARAMETER_SET, PARAMETER_SET_V44);
      pushParam(u, USER_PI.CAPABILITY, [CAPABILITY_MODEM]);
      pushParam(u, USER_PI.REQUEST, [v.compression]);
      pushParam(u, USER_PI.CODEWORDS_TRANSMIT, be(v.transmit.n2));
      pushParam(u, USER_PI.CODEWORDS_RECEIVE, be(v.receive.n2));
      pushParam(u, USER_PI.MAX_STRING_TRANSMIT, [v.transmit.n7]);
      pushParam(u, USER_PI.MAX_STRING_RECEIVE, [v.receive.n7]);
      pushParam(u, USER_PI.HISTORY_TRANSMIT, be(v.transmit.n8));
      pushParam(u, USER_PI.HISTORY_RECEIVE, be(v.receive.n8));
      // No group length: with one, a far end reading it as V.42 describes never
      // learnt V.44 was offered.
      out.push(GI_USER_DATA, ...u);
    }
    return out;
  }

  /**
   * Note 1: a command sets 2, 4, 8, 9, 12 and 16; a response clears 16 if it sets
   * 17. So a command asking for 32 bits still sets 16, and only an agreeing answer
   * clears it — this end once cleared it in commands too, and was never answered.
   */
  _hdlcMask(kind) {
    let m = 0;
    for (const b of HDLC_REQUIRED) m |= 1 << (b - 1);
    if (this.srejSingle) m |= 1 << (HDLC_BIT.SREJ_SINGLE - 1);
    if (this.testFrame) m |= 1 << (HDLC_BIT.TEST_FRAME - 1);
    if (this.fcs32) { m |= 1 << (HDLC_BIT.FCS32 - 1); if (kind === RESPONSE) m &= ~(1 << (HDLC_BIT.CLEARED_BY_FCS32 - 1)); }
    if (this.srejMultiple) m |= 1 << (HDLC_BIT.SREJ_MULTIPLE - 1);
    return m >>> 0;
  }

  /**
   * Decode an information field. 12.2.2: unrecognised fields are ignored, and so
   * are recognised ones of a length their entry does not allow (the default
   * stands). What throws is a field that cannot be walked: a length running past
   * the end, no format identifier, or a format other than the general purpose one.
   */
  static decode(body) {
    const xid = new Xid();
    if (!body.length) throw new XidError('Truncated');
    if (body[0] !== FI_GENERAL_PURPOSE) throw new XidError('UnknownFormat', body[0]);
    let pos = 1;
    while (pos < body.length) {
      const gi = body[pos];
      if (gi === GI_USER_DATA) { xid._readUserData(body.slice(pos + 1)); break; }   // no group length (12.2.1.3)
      if (pos + 3 > body.length) throw new XidError('Truncated');
      const gl = (body[pos + 1] << 8) | body[pos + 2];
      const start = pos + 3, end = start + gl;
      if (end > body.length) throw new XidError('Truncated');
      if (gi === GI_PARAMETER) xid._readParameters(body.slice(start, end));
      else if (gi === GI_PRIVATE) xid._readPrivate(body.slice(start, end));
      pos = end;                 // an unrecognised group is skipped whole
    }
    return xid;
  }

  _readParameters(field) {
    let t;
    while ((t = takeParam(field))) {
      const [pi, value, rest] = t; field = rest;
      if (pi === PI.HDLC_OPTIONAL) {
        // Real modems send three octets; read up to four, the rest as zero. None
        // is nothing to read, which leaves every option off.
        if (!value.length) continue;
        let mask = 0;
        for (let i = 0; i < Math.min(4, value.length); i++) mask |= value[i] << (8 * i);
        mask >>>= 0;
        const bit = (b) => ((mask >>> (b - 1)) & 1) === 1;
        this.srejSingle = bit(HDLC_BIT.SREJ_SINGLE); this.testFrame = bit(HDLC_BIT.TEST_FRAME);
        this.fcs32 = bit(HDLC_BIT.FCS32); this.srejMultiple = bit(HDLC_BIT.SREJ_MULTIPLE);
      } else if (pi === PI.N401_TRANSMIT) { const v = beU16(value); this.n401Transmit = v == null ? null : Math.floor(v / 8); }
      else if (pi === PI.N401_RECEIVE) { const v = beU16(value); this.n401Receive = v == null ? null : Math.floor(v / 8); }
      else if (pi === PI.WINDOW_TRANSMIT) { const v = beU16(value); this.windowTransmit = v == null ? null : v & 0xff; }
      else if (pi === PI.WINDOW_RECEIVE) { const v = beU16(value); this.windowReceive = v == null ? null : v & 0xff; }
    }
  }

  _readPrivate(field) {
    let isV42bis = false, t;
    while ((t = takeParam(field))) {
      const [pi, value, rest] = t; field = rest;
      if (pi === PRIVATE_PI.PARAMETER_SET) isV42bis = value.length === 3 && value.every((b, i) => b === PARAMETER_SET_V42[i]);
      else if (!isV42bis) continue;     // everything after belongs to the set it named
      else if (pi === PRIVATE_PI.COMPRESSION_REQUEST) this.compression = value.length ? value[0] & 3 : null;
      else if (pi === PRIVATE_PI.CODEWORDS) this.codewords = beU16(value);
      else if (pi === PRIVATE_PI.MAX_STRING) this.maxString = value.length ? value[0] : null;
    }
  }

  /** The V.44 half of the user data subfield (Table A.1). */
  _readUserData(field) {
    let isV44 = false, saidAnything = false, t;
    const offer = V44Offer.proposal(Compression.Neither);    // unreadable parameters leave these
    while ((t = takeParam(field))) {
      const [pi, value, rest] = t; field = rest;
      if (pi === USER_PI.PARAMETER_SET) { isV44 = value.length === 3 && value.every((b, i) => b === PARAMETER_SET_V44[i]); continue; }
      if (!isV44) continue;
      const u16 = beU16(value), u8 = value.length ? value[0] : null;
      switch (pi) {
        case USER_PI.REQUEST: if (u8 != null) { offer.compression = u8 & 3; saidAnything = true; } break;
        case USER_PI.CODEWORDS_TRANSMIT: if (u16 != null) offer.transmit.n2 = u16; break;
        case USER_PI.CODEWORDS_RECEIVE: if (u16 != null) offer.receive.n2 = u16; break;
        case USER_PI.MAX_STRING_TRANSMIT: if (u8 != null) offer.transmit.n7 = u8; break;
        case USER_PI.MAX_STRING_RECEIVE: if (u8 != null) offer.receive.n7 = u8; break;
        case USER_PI.HISTORY_TRANSMIT: if (u16 != null) offer.transmit.n8 = u16; break;
        case USER_PI.HISTORY_RECEIVE: if (u16 != null) offer.receive.n8 = u16; break;
        default: break;         // C0's packet bits are "ignored for modem connections"
      }
    }
    if (isV44 && saidAnything) this.v44 = offer;
  }

  /** What the two ends settled on for V.44, or null (then V.42bis or nothing). */
  v44Params(other) { return this.v44 && other.v44 ? this.v44.resolve(other.v44) : null; }

  /** A proposal settled against a reply: the lower value where they differ (9.2.3, 9.2.4, V.42bis 5.1). */
  resolve(other) {
    const codewords = lower(this.codewords, other.codewords, B.DEFAULT_N2);
    const maxString = lower(this.maxString, other.maxString, B.DEFAULT_N7);
    let compression = this.compression != null && other.compression != null ? intersect(this.compression, other.compression) : null;
    // 5.1's procedural errors (a P1 below 512, a P2 outside 6–250) refuse
    // compression rather than build a dictionary from the far end's number.
    if (compression != null && compression !== Compression.Neither && new B.Params(codewords, maxString).validate()) compression = Compression.Neither;
    return new Xid({
      n401Transmit: lower(this.n401Transmit, other.n401Transmit, DEFAULT_N401),
      n401Receive: lower(this.n401Receive, other.n401Receive, DEFAULT_N401),
      windowTransmit: lower(this.windowTransmit, other.windowTransmit, DEFAULT_K),
      windowReceive: lower(this.windowReceive, other.windowReceive, DEFAULT_K),
      fcs32: this.fcs32 && other.fcs32, srejSingle: this.srejSingle && other.srejSingle,
      testFrame: this.testFrame && other.testFrame, srejMultiple: this.srejMultiple && other.srejMultiple,
      compression, codewords, maxString,
      v44: this.v44Params(other),
    });
  }

  /**
   * This proposal as an answer naming one algorithm at most (V.44 7.3 NOTE): V.44
   * exactly when `settled` (this proposal met against the command) has it, else
   * V.42bis — and a P0 of zero where none was agreed, so a far end whose P1 was
   * refused does not turn compression on at a decoder that is not there.
   */
  answering(settled) {
    const x = this.clone();
    if (settled.v44) x.compression = null;
    else { x.v44 = null; if (settled.compression === Compression.Neither) x.compression = Compression.Neither; }
    return x;
  }

  /** V.42bis parameters implied by a settled negotiation, or null. */
  v42bisParams() {
    if (this.compression == null || this.compression === Compression.Neither) return null;
    return new B.Params(this.codewords ?? B.DEFAULT_N2, this.maxString ?? B.DEFAULT_N7);
  }
}

module.exports = { Xid, XidError, V44Offer, Compression, flipped, intersect, FI_GENERAL_PURPOSE, GI_PARAMETER, GI_PRIVATE, GI_USER_DATA, PARAMETER_SET_V42, PARAMETER_SET_V44 };
