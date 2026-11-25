'use strict';

/*!
 * @license
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Copyright (C) 2026 Joseph Quinn
 *
 * Ported from BinModem <https://github.com/CasualArclamp/BinModem>,
 * crates/ec/src/frame.rs, at commit 623f935e28fe6de3a8a4f41492feb46e1bb86c3a of
 * <https://github.com/synexo/BinModem>. Copyright the BinModem authors;
 * GPL-3.0-or-later. See NOTICE.
 */

/**
 * Frame.js — LAPM address and control fields (V.42 8.2.1, 8.2.2, 8.2.4).
 *
 * Modulo 128 throughout: I and S frames carry a two-octet control field and
 * seven-bit sequence numbers. A frame is a plain object, { type, ... }:
 *   I { ns, nr, poll, info }   RR/RNR/REJ { nr, pf }   SREJ { nr }
 *   SABME/DISC { poll }        UA/DM { final }         FRMR { final, info }
 *   UI/XID/TEST { pf, info }
 */

const MODULUS = 128;
const DLCI_DATA = 0;       // DTE-to-DTE data, the only DLCI carried (Table 10)
const DLCI_CONTROL = 63;

const ORIGINATOR = 'originator', ANSWERER = 'answerer';
const COMMAND = 'command', RESPONSE = 'response';
const peerOf = (role) => (role === ORIGINATOR ? ANSWERER : ORIGINATOR);

/**
 * The C/R bit names an END, not a direction (8.2.1.2): a command carries the
 * address of the end it goes to, a response that of the end it came from. Set is
 * the answerer's, clear the originator's — Table 6 does not survive extraction,
 * so this was settled by a real answering modem's UA, which had it set.
 */
function encodeAddress(dlci, kind, sender) {
  const addressed = kind === COMMAND ? peerOf(sender) : sender;
  return ((dlci << 2) | ((addressed === ANSWERER ? 1 : 0) << 1) | 1) & 0xff;
}

/** { ok: { dlci, kind } } or { err } for an address octet received by `receiver`. */
function decodeAddress(octet, receiver) {
  // A clear EA promises a second octet, which V.42 leaves for further study.
  if ((octet & 1) === 0) return { err: 'ExtendedAddress' };
  const addressed = (octet & 2) ? ANSWERER : ORIGINATOR;
  // Our own address on the peer's frame is addressed to us: a command.
  return { ok: { dlci: octet >> 2, kind: addressed === receiver ? COMMAND : RESPONSE } };
}

// Table 8, P/F clear.
const U = { SABME: 0x6f, DM: 0x0f, UI: 0x03, DISC: 0x43, UA: 0x63, FRMR: 0x87, XID: 0xaf, TEST: 0xe3 };
const PF = 0x10;           // the poll/final bit, bit 5 of the unnumbered octet
const S = { RR: 0x01, RNR: 0x05, REJ: 0x09, SREJ: 0x0d };

/** The kind an entity sends this frame type as; for the two-way types the sender decides. */
function kindOf(f) {
  if (f.type === 'I' || f.type === 'SABME' || f.type === 'DISC') return COMMAND;
  if (f.type === 'UA' || f.type === 'DM' || f.type === 'FRMR') return RESPONSE;
  return COMMAND;
}

/** The poll or final bit. */
function pfOf(f) {
  switch (f.type) {
    case 'I': case 'SABME': case 'DISC': return !!f.poll;
    case 'UA': case 'DM': case 'FRMR': return !!f.final;
    case 'SREJ': return false;
    default: return !!f.pf;
  }
}

/** Address, control and information octets; the FCS is the HDLC layer's. */
function encodeFrame(f, dlci, sender, kind) {
  const out = [encodeAddress(dlci, kind, sender)];
  const u = (base, pf) => (pf ? base | PF : base);
  const s = (fn, nr, pf) => { out.push(fn, ((nr << 1) | (pf ? 1 : 0)) & 0xff); };
  const info = f.info || [];
  switch (f.type) {
    case 'I': out.push((f.ns << 1) & 0xff, ((f.nr << 1) | (f.poll ? 1 : 0)) & 0xff); out.push(...info); break;
    case 'RR': s(S.RR, f.nr, f.pf); break;
    case 'RNR': s(S.RNR, f.nr, f.pf); break;
    case 'REJ': s(S.REJ, f.nr, f.pf); break;
    case 'SREJ': s(S.SREJ, f.nr, false); break;             // Table 8: P/F is 0
    case 'SABME': out.push(u(U.SABME, f.poll)); break;
    case 'DISC': out.push(u(U.DISC, f.poll)); break;
    case 'UA': out.push(u(U.UA, f.final)); break;
    case 'DM': out.push(u(U.DM, f.final)); break;
    case 'FRMR': out.push(u(U.FRMR, f.final)); out.push(...info); break;
    case 'UI': out.push(u(U.UI, f.pf)); out.push(...info); break;
    case 'XID': out.push(u(U.XID, f.pf)); out.push(...info); break;
    case 'TEST': out.push(u(U.TEST, f.pf)); out.push(...info); break;
    default: throw new Error(`unknown frame type ${f.type}`);
  }
  return out;
}

/**
 * Decode a frame body (between the flags, FCS removed) received by `receiver`:
 * { ok: { address, frame } } or { err: 'Truncated' | 'ExtendedAddress' |
 * 'UnexpectedInfo' | 'UndefinedControl', control? }.
 */
function decodeFrame(body, receiver) {
  if (body.length < 2) return { err: 'Truncated' };
  const a = decodeAddress(body[0], receiver);
  if (a.err) return a;
  const address = a.ok, control = body[1];
  // Table 7: bit 1 clear is I, "01" is S, "11" is U.
  if ((control & 1) === 0) {
    if (body.length < 3) return { err: 'Truncated' };
    return { ok: { address, frame: { type: 'I', ns: control >> 1, nr: body[2] >> 1, poll: !!(body[2] & 1), info: body.slice(3) } } };
  }
  if ((control & 3) === 1) {
    if (body.length < 3) return { err: 'Truncated' };
    const nr = body[2] >> 1, pf = !!(body[2] & 1);
    if (body.length > 3) return { err: 'UnexpectedInfo' };   // S frames carry none
    let frame;
    switch (control) {
      case S.RR: frame = { type: 'RR', nr, pf }; break;
      case S.RNR: frame = { type: 'RNR', nr, pf }; break;
      case S.REJ: frame = { type: 'REJ', nr, pf }; break;
      case S.SREJ: frame = { type: 'SREJ', nr }; break;
      default: return { err: 'UndefinedControl', control };
    }
    return { ok: { address, frame } };
  }
  const pf = !!(control & PF), info = body.slice(2), hasInfo = info.length > 0;
  const c = control & ~PF & 0xff;
  let frame;
  switch (c) {
    case U.SABME: case U.DISC: case U.UA: case U.DM:
      // 8.2.4.3, 8.2.4.4 and 8.2.4.5 forbid an information field on these.
      if (hasInfo) return { err: 'UnexpectedInfo' };
      frame = c === U.SABME ? { type: 'SABME', poll: pf } : c === U.DISC ? { type: 'DISC', poll: pf }
        : c === U.UA ? { type: 'UA', final: pf } : { type: 'DM', final: pf };
      break;
    case U.FRMR: frame = { type: 'FRMR', final: pf, info }; break;
    case U.UI: frame = { type: 'UI', pf, info }; break;
    case U.XID: frame = { type: 'XID', pf, info }; break;
    case U.TEST: frame = { type: 'TEST', pf, info }; break;
    default: return { err: 'UndefinedControl', control: c };
  }
  return { ok: { address, frame } };
}

module.exports = {
  MODULUS, DLCI_DATA, DLCI_CONTROL, ORIGINATOR, ANSWERER, COMMAND, RESPONSE, peerOf,
  encodeAddress, decodeAddress, kindOf, pfOf, encodeFrame, decodeFrame,
};
