'use strict';

/*!
 * @license
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Copyright (C) 2026 Joseph Quinn
 *
 * Ported from BinModem <https://github.com/CasualArclamp/BinModem>,
 * crates/ec/src/stack.rs, at commit 623f935e28fe6de3a8a4f41492feb46e1bb86c3a of
 * <https://github.com/synexo/BinModem>. Copyright the BinModem authors;
 * GPL-3.0-or-later. See NOTICE.
 */

/**
 * Stack.js — a complete V.42 endpoint: compression over error control over
 * framing. Terminal data is compressed (V.42bis or V.44), carried in LAPM I
 * frames, wrapped in HDLC and handed to the data pump a bit at a time, and the
 * reverse coming back. The line side never runs dry: with nothing to say it
 * carries flags, which keep the far end's framing and whose absence is how a
 * modem notices the connection has gone.
 *
 * Phases: Detecting (7.2.1) → Negotiating (XID, 8.10) → Protocol (LAPM), or
 * Transparent where the far end does no error control (what arrived is kept for
 * the terminal, Appendix I.3). Time comes from tick(ms); bits are 0/1.
 */

const { DLCI_DATA, ORIGINATOR, ANSWERER, COMMAND, RESPONSE, encodeFrame, decodeFrame } = require('./Frame');
const { Encoder, Decoder, FCS16, FCS32 } = require('./Hdlc');
const L = require('./Lapm');
const { Lapm, State, Cause } = L;
const { Xid, Compression } = require('./Xid');
const D = require('./Detect');
const { Originator, Answerer, Answer, Outcome } = D;
const B = require('./V42bis');
const V44 = require('./V44');
const { Encoder: V44Encoder } = require('./V44Encoder');
const { Decoder: V44Decoder } = require('./V44Decoder');

// 8.10.2 Note: at least 16 flags before the first frame after detection, so an
// answerer still finishing its pattern cannot miss the change and the frame.
const LEADING_FLAGS = 16;
// N400 for the XID exchange: one retransmission. A failed XID costs compression,
// not the call, and every retry is dead time before CONNECT on a far end that
// simply does not negotiate.
const XID_N400 = 1;
// After the last XID, one round trip (the unmeasured allowance where none was
// measured), not a whole T401: there is nothing left to retransmit.
const XID_LAST_WAIT_MS = L.PROPAGATION_MS;
// Undecodable compressed streams answered by re-establishing (5.8, 7.15) before
// the next releases the link: a far end that fails the same way every time.
const UNDECODABLE_RESETS = 3;
const LOG_FRAMES = 4096;

const Phase = Object.freeze({ Detecting: 'Detecting', Negotiating: 'Negotiating', Protocol: 'Protocol', Transparent: 'Transparent' });

function startDetect(role, t400Ms, declining, late) {
  if (role === ORIGINATOR) return { origin: new Originator(t400Ms) };
  const a = new Answerer(t400Ms, declining ? Answer.None : Answer.ErrorControl);
  return { answer: late ? a : a.prompt() };     // ten T400s only where the far end may be late
}

/** The compression a link runs: V.42bis or V.44, exactly one (V.44 7.3). */
class Compressor {
  constructor(codec) { this.codec = codec; this.speculative = false; this.negotiated = true; }
  static v42bis(params) { return new Compressor({ kind: 'V.42bis', params, encoder: new B.Encoder(params), decoder: new B.Decoder(params) }); }
  static v44(transmit, receive) { return new Compressor({ kind: 'V.44', transmit, receive, encoder: new V44Encoder(transmit), decoder: new V44Decoder(receive) }); }
  /** 5.6's C-INIT (and V.44 7.5's): both dictionaries back to nothing. */
  reinitialize() {
    const c = this.codec;
    if (c.kind === 'V.42bis') { c.encoder = new B.Encoder(c.params); c.decoder = new B.Decoder(c.params); }
    else { c.encoder = new V44Encoder(c.transmit); c.decoder = new V44Decoder(c.receive); }
  }
  name() { return this.codec.kind; }
  /** Compress and flush: a coder holding the last characters back looks like a hung line. */
  encode(data) { const out = []; this.codec.encoder.encode(data, out); this.codec.encoder.flush(out); return out; }
  /** Decompress into `out`; false where it would not. */
  decode(data, out) { try { this.codec.decoder.decode(data, out); return true; } catch (e) { return false; } }
}

class Stack {
  constructor(role, params = new L.Params()) {
    this._role = role;
    this.lapm = new Lapm(role, DLCI_DATA, params);
    this.encoder = new Encoder(FCS16);
    this.decoder = new Decoder(FCS16);
    this.compression = null;
    this.delivered = [];
    this.damaged = 0;
    this.log = [];
    this._phase = Phase.Detecting;
    this.detect = startDetect(role, D.DEFAULT_T400_MS, false, false);
    this.offer = Compression.Neither;
    this.limits = [B.OFFERED_N2, B.OFFERED_N7];
    this.guessedWrong = false;
    this.declared = false;
    this.offerV44 = true; this.offerV42bis = true;
    this.v44Limits = null;
    this._declining = false;
    this.heardAdp = null; this.heardXid = null; this.heardAnswer = null;
    this.agreedFcs = FCS16;
    this.established = false;
    this.undecodable = 0;
    this.gaveUp = false;
    this.opened = false;
    this.xidDue = false; this.xidMs = 0; this.xidRetries = 0;
    this.roundTripMs = 0;
    this.heardText = false;
    this.unclaimed = [];
    this.watch = null;
    this._suspended = false;
    this.lateFarEnd = false;
    this.onTrace = null;          // optional (text) => void, diagnostics only
  }

  // ── builders ──
  /** V.8 has already settled LAPM: a silent detection phase then means a lost ADP, not no V.42. */
  declaredLapm() { this.declared = true; return this; }
  /** The originator's half of the bypass (7.2.1.2, V.92 9.3.1), with unconfirmed patience. */
  withoutDetection() { this._enterNegotiating(); this.lapm.setRetransmissions(L.UNCONFIRMED_N400); return this; }
  /**
   * The answerer's half (V.92 9.2.5): no wait for an ODP — but one that arrives
   * anyway is still answered (V.8 7.3's warning), by a detector kept running
   * beside the protocol phase until the far end proves it is past detection.
   */
  bypassingDetection() { this._enterNegotiating(); this.watch = new Answerer(this._t400Ms(), Answer.ErrorControl); return this; }
  /** Ten T400s for an answerer whose far end's data mode begins later (V.92). */
  waitingForALateFarEnd() { this.lateFarEnd = true; if (this.detect) this.detect = startDetect(this._role, this._t400Ms(), this._declining, true); return this; }
  /** Answer the detection phase with a refusal (Table 3). */
  declining() { this._declining = true; this.detect = startDetect(this._role, this._t400Ms(), true, this.lateFarEnd); return this; }
  /** Allow for a measured round trip: T400 waits that much longer (9.1.1). */
  overARoundTrip(ms) {
    this.roundTripMs = ms;
    if (this.detect) this.detect = startDetect(this._role, this._t400Ms(), this._declining, this.lateFarEnd);
    if (this.watch) this.watch = new Answerer(this._t400Ms(), Answer.ErrorControl);
    return this;
  }
  _t400Ms() { return D.DEFAULT_T400_MS + this.roundTripMs; }
  _xidLastWaitMs() { return Math.min(this.roundTripMs === 0 ? XID_LAST_WAIT_MS : this.roundTripMs, this.lapm.t401Ms()); }

  /** Offer compression in XID; what runs is the intersection. */
  offerCompression(c) { this.offer = c; }
  withoutV44() { this.offerV44 = false; }
  withoutV42bis() { this.offerV42bis = false; }
  /** V.250 Table 28's caps, each way. */
  offerV44Limits(transmit, receive) { this.v44Limits = [transmit, receive]; }
  /** V.250 Table 27's caps. */
  offerDictionary(codewords, maxString) { this.limits = [codewords, maxString]; }

  /** The standing proposal, capped by the terminal. */
  _proposal() {
    const x = Xid.proposal(this.offer);
    x.codewords = Math.min(this.limits[0], B.OFFERED_N2);
    x.maxString = Math.min(this.limits[1], B.OFFERED_N7);
    if (!this.offerV42bis) x.compression = Compression.Neither;
    if (!this.offerV44) x.v44 = null;
    else if (x.v44 && this.v44Limits) { x.v44.transmit = x.v44.transmit.resolve(this.v44Limits[0]); x.v44.receive = x.v44.receive.resolve(this.v44Limits[1]); }
    return x;
  }

  /** V.42bis directly, without XID: for tests and links configured elsewhere. */
  withCompression(params) { this._enableCompression(params); this.compression.negotiated = false; return this; }
  _enableCompression(params) { this.compression = Compressor.v42bis(params); }
  _enableV44(transmit, receive) { this.compression = Compressor.v44(transmit, receive); }

  compressionName() { return this.compression ? this.compression.name() : null; }

  /** Follow an unnegotiated switch only where this end offered to receive and the far end never answered (9.1). */
  _mayFollowEcm() {
    return !this.guessedWrong && !this.heardXid && !this.heardAnswer && (this.offer === Compression.Both || this.offer === Compression.ResponderToInitiator);
  }

  farAnswer() { return this.heardAdp; }
  farXid() { return this.heardXid; }
  farXidAnswer() { return this.heardAnswer; }
  agreedCompression() {
    const c = this.compression;
    if (!c) return null;
    return c.codec.kind === 'V.42bis' ? { kind: 'V.42bis', params: c.codec.params, inBand: c.speculative } : { kind: 'V.44', transmit: c.codec.transmit, receive: c.codec.receive };
  }
  farText() { return this.heardText; }
  /** The line's bits error control did not claim, for the terminal (Appendix I.3). */
  takeUnclaimed() { const u = this.unclaimed; this.unclaimed = []; return u; }

  /** Whether error control is settled, which a CONNECT waits for (V.250 6.5.5). */
  settled() {
    if (this._phase === Phase.Detecting || this._phase === Phase.Negotiating) return false;
    if (this._phase === Phase.Transparent) return true;
    return this.lapm.isConnected() || this.gaveUp;
  }

  phase() { return this._phase; }
  fcs() { return this.encoder.fcs(); }
  queued() { return this.lapm.queued(); }
  compressing() { return !!this.compression; }
  role() { return this._role; }
  state() { return this.lapm.state(); }
  isConnected() { return this.lapm.isConnected(); }
  damagedFrames() { return this.damaged; }
  undecodableStreams() { return this.undecodable; }
  takeLog() { const l = this.log; this.log = []; return l; }
  _note(outbound, intact, body) { if (this.log.length >= LOG_FRAMES) this.log.shift(); this.log.push({ outbound, intact, body: body.slice() }); }
  _trace(text) { if (this.onTrace) this.onTrace(`[${this._role} ${this._phase}] ${text}`); }

  /** Establish the link, once there is something to establish it with. */
  connect() { if (this._phase === Phase.Protocol) this.lapm.connect(); }
  disconnect() { this.lapm.disconnect(); }

  /** 7.10: freeze the timers (T400, T401, the XID exchange's) and change nothing else. */
  suspend() { this._suspended = true; this.lapm.suspend(); }
  /** 7.11. */
  resume() { this._suspended = false; this.lapm.resume(); }
  suspended() { return this._suspended; }

  /** Time passing, which drives every timer here. */
  tick(dtMs) {
    if (this._suspended) { this.lapm.tick(dtMs); this._drain(); return; }
    if (this._phase === Phase.Detecting) {
      const o = this.detect ? (this.detect.origin ? this.detect.origin.tick(dtMs) : this.detect.answer.tick(dtMs)) : Outcome.Pending;
      this._settleDetection(o);
    } else if (this._phase === Phase.Negotiating) {
      this.xidMs += dtMs;
      // T401 is LAPM's, and not while a copy is still due and unsent.
      if (!this.xidDue) {
        if (this.xidRetries < XID_N400) {
          if (this.xidMs >= this.lapm.t401Ms()) { this.xidRetries++; this.xidDue = true; }   // 8.10.3
        } else if (this.xidMs >= this._xidLastWaitMs()) this._beginProtocol();            // 8.10.3's other ending
      }
    }
    // 7.2.1.3's T400, still running behind a bypass.
    if (this.watch && this.watch.tick(dtMs) === Outcome.TimedOut) this._bypassFailed();
    this.lapm.tick(dtMs);
    this._drain();
  }

  /** Queue terminal data. */
  send(data) {
    if (!data || !data.length) return;
    const c = this.compression;
    if (c && !c.speculative) this.lapm.sendData(c.encode(Array.from(data)));
    else this.lapm.sendData(Array.from(data));        // speculative decodes only
  }

  takeReceived() { const d = this.delivered; this.delivered = []; return d; }

  /** One bit for the line; never nothing. */
  nextBit() {
    // Detection is async characters straight onto the stream, not framed.
    if (this._phase === Phase.Detecting) return this.detect ? (this.detect.origin ? this.detect.origin.transmit() : this.detect.answer.transmit()) : 1;
    if (this._phase === Phase.Transparent) return 1;
    if (this.encoder.isEmpty()) {
      // Table 3's answer to an ODP that should never have arrived, between frames.
      if (this.watch && this.watch.sending()) return this.watch.transmit();
      let queued = false;
      if (!this.opened) { this.opened = true; this.encoder.idle(LEADING_FLAGS); const b = this.encoder.nextBit(); return b === null ? 1 : b; }
      if (this._phase === Phase.Negotiating && this.xidDue) {
        // One, and then only when T401 says (8.10.2, 8.10.3). P is 0 (8.2.4.13).
        this.xidDue = false; this.xidMs = 0;
        const info = this._proposal().encode(COMMAND);
        this._trace(`XID sending Command (${info.length} octets)`);
        const body = encodeFrame({ type: 'XID', pf: false, info }, DLCI_DATA, this._role, COMMAND);
        this.encoder.frameWith(body, FCS16);
        this._note(true, true, body);
        queued = true;
      }
      let x;
      while ((x = this.lapm.pollTransmit())) {
        const body = encodeFrame(x[0], DLCI_DATA, this._role, x[1]);
        this.encoder.frame(body);
        this._note(true, true, body);
        queued = true;
      }
      if (!queued) this.encoder.idle(1);
    }
    const b = this.encoder.nextBit();
    return b === null ? 1 : b;
  }

  /** One bit from the line. */
  feedBit(bit) {
    bit = bit ? 1 : 0;
    if (this._phase === Phase.Detecting) {
      const o = this.detect ? (this.detect.origin ? this.detect.origin.receive(bit) : this.detect.answer.receive(bit)) : Outcome.Pending;
      this._settleDetection(o);
      return;
    }
    if (this._phase === Phase.Transparent) { this.unclaimed.push(bit); return; }
    this._watchBit(bit);
    if (this._phase === Phase.Transparent) return;
    const result = this.decoder.feed(bit);
    if (!result) return;
    if (result.err) {
      // Dropped and left to retransmission; counted, the measure of the line.
      const discarded = this.decoder.discarded().slice();
      this._note(false, false, discarded);
      this.damaged++;
      return;
    }
    const body = result.ok;
    this._note(false, true, body);
    const f = decodeFrame(body, this._role);
    if (f.err) { this.damaged++; return; }
    // 7.2.1.3: an LAPM frame ends detection, and it is the stronger sign.
    this.watch = null;
    this._dispatch(f.ok.address, f.ok.frame);
  }

  _watchBit(bit) {
    if (!this.watch) return;
    const o = this.watch.receive(bit);
    const sending = this.watch.sending();
    if (o === Outcome.ProtocolStarted) this.watch = null;                 // it skipped detection too
    else if (o === Outcome.OriginatorDetected && !sending) this.watch = null;   // answered; done
    else if (o === Outcome.Text) { this.heardText = true; this._bypassFailed(); }
  }

  /** 7.2.1.3's ending for a bypass taken on something untrue: no V.42 at all. */
  _bypassFailed() {
    if (this.watch) for (const b of this.watch.takeHeard()) this.unclaimed.push(b);
    this.watch = null;
    this._phase = Phase.Transparent;
  }

  _dispatch(address, frame) {
    if (frame.type === 'XID') { this._receiveXid(frame.info, address.kind); return; }   // not LAPM's
    // The set-mode command settles the width for good (8.10.2), and its answer.
    if (frame.type === 'SABME' || frame.type === 'UA') { const w = this.decoder.matchedFcs(); this.decoder.setFcs(w); this.encoder.setFcs(w); }
    this.lapm.receive(frame, address.kind);
    this._drain();
  }

  _receiveXid(info, kind) {
    let theirs;
    try { theirs = Xid.decode(info); } catch (e) { this._trace('XID recv DID NOT DECODE'); this.damaged++; return; }
    if (kind === COMMAND) this.heardXid = theirs; else this.heardAnswer = theirs;
    const agreed = this._proposal().resolve(theirs);
    // V.44 first where both offered it, V.42bis otherwise (7.3).
    if (agreed.v44) { this._trace('XID enabling V.44'); this._enableV44(agreed.v44.transmit, agreed.v44.receive); }
    else if (agreed.v42bisParams()) { this._trace('XID enabling V.42bis'); this._enableCompression(agreed.v42bisParams()); }
    else if (!this.lapm.isConnected()) {
      // An XID can take compression away again before the link is up (an Agere
      // SV92PP did, just before its SABME).
      if (this.compression && this.compression.negotiated) this.compression = null;
    }
    if (agreed.fcs32) {
      this.agreedFcs = FCS32;
      // Late: gone on to protocol before this XID came; its SABME may come at 32.
      if (this._phase === Phase.Protocol && !this.lapm.isConnected()) this.decoder.acceptEither();
    }
    // 8.4.5.1: only after both ends said so.
    this.lapm.setSelectiveReject(agreed.srejSingle);
    // Answer every command, never a response (8.10.2, 8.10.3), naming one algorithm, at 16 bits.
    if (kind === COMMAND) {
      const ans = this._proposal().answering(agreed).encode(RESPONSE);
      const body = encodeFrame({ type: 'XID', pf: false, info: ans }, DLCI_DATA, this._role, RESPONSE);
      this.encoder.frameWith(body, FCS16);
      this._note(true, true, body);
    }
    this._beginProtocol();
  }

  /** Act on how detection came out (7.2.1.2, 7.2.1.3). */
  _settleDetection(o) {
    if (o.kind === 'Answered') this.heardAdp = o.answer;
    const answererStillSaying = () => this.detect && this.detect.answer && !this.detect.answer.finishedSending();
    switch (o.kind) {
      case 'Pending': return;
      case 'Text': this.heardText = true; this._detectFailed(); return;
      case 'Answered':
        if (Answer.errorControlled(o.answer)) { if (answererStillSaying()) return; this._enterNegotiating(); }
        else this._detectFailed();
        return;
      case 'ProtocolStarted': this._enterNegotiating(); this.lapm.setRetransmissions(L.UNCONFIRMED_N400); return;
      case 'OriginatorDetected':
        if (answererStillSaying()) return;        // finish saying it
        if (this._declining) this._detectFailed(); else this._enterNegotiating();
        return;
      case 'TimedOut':
        // A far end that said LAPM in V.8 has not been contradicted by silence.
        if (this.declared) { this._enterNegotiating(); this.lapm.setRetransmissions(L.UNCONFIRMED_N400); }
        else this._detectFailed();
        return;
      default: return;
    }
  }

  /** One XID queued behind the opening flags (8.10.2). */
  _enterNegotiating() { this.detect = null; this._phase = Phase.Negotiating; this.xidDue = true; this.xidMs = 0; this.xidRetries = 0; }

  _detectFailed() {
    if (this.detect) for (const b of (this.detect.origin || this.detect.answer).takeHeard()) this.unclaimed.push(b);
    this.detect = null;
    this._phase = Phase.Transparent;
  }

  _beginProtocol() {
    if (this._phase === Phase.Protocol) return;
    this._phase = Phase.Protocol;
    if (this.agreedFcs === FCS32) {
      // 8.10.2: the width changes on the SABME; until then either may be read.
      this.decoder.acceptEither();
      if (this._role === ORIGINATOR) this.encoder.setFcs(FCS32);
    }
    if (this._role === ORIGINATOR) this.lapm.connect();
  }

  _drain() {
    const arrived = [];
    let e;
    while ((e = this.lapm.pollEvent())) {
      if (e.type === 'Data') { for (const b of e.data) arrived.push(b); }
      // 5.6 a): C-INIT on L-ESTABLISH; and a reset under us leaves a hole in both histories.
      else if (e.type === 'Connected') { this.established = true; if (this.compression) this.compression.reinitialize(); }
      else if (e.type === 'Reset') { if (this.compression) this.compression.reinitialize(); }
      // N400 SABMEs unanswered, or refused, before ever establishing: start-stop it is.
      else if (e.type === 'Released' && (e.cause === Cause.NoResponse || e.cause === Cause.Refused) && !this.established) { this.gaveUp = true; this._phase = Phase.Transparent; }
    }
    if (!arrived.length) return;
    // A decoder for a far end that may switch without asking, built on the first
    // octet (its encoder learns in transparent mode too).
    if (!this.compression && this._mayFollowEcm()) {
      const p = this._proposal();
      this._enableCompression(new B.Params(p.codewords ?? B.OFFERED_N2, p.maxString ?? B.OFFERED_N7));
      this.compression.speculative = true;
    }
    const c = this.compression;
    if (!c) { for (const b of arrived) this.delivered.push(b); return; }
    if (!c.decode(arrived, this.delivered)) {
      if (c.speculative) {
        // A guess that did not come off: back to raw, and stop guessing.
        this.compression = null; this.guessedWrong = true;
        for (const b of arrived) this.delivered.push(b);
        return;
      }
      // 5.8: recover by re-establishing (5.6's C-INIT at both ends), a few times.
      this.undecodable++;
      if (this.undecodable > UNDECODABLE_RESETS) this.lapm.disconnect(); else this.lapm.connect();
    }
  }
}

module.exports = { Stack, Phase, Compression, LEADING_FLAGS, XID_N400, UNDECODABLE_RESETS, ORIGINATOR, ANSWERER };
