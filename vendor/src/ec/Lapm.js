'use strict';

/*!
 * @license
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Copyright (C) 2026 Joseph Quinn
 *
 * Ported from BinModem <https://github.com/CasualArclamp/BinModem>,
 * crates/ec/src/lapm.rs, at commit 623f935e28fe6de3a8a4f41492feb46e1bb86c3a of
 * <https://github.com/synexo/BinModem>. Copyright the BinModem authors;
 * GPL-3.0-or-later. See NOTICE.
 */

/**
 * Lapm.js — the LAPM state machine (V.42 8.3 to 8.9): establishment, release,
 * numbered information transfer with go-back-N, single-frame selective reject
 * (8.4.5.1) and timer recovery (8.5.3). Time comes from the caller through
 * tick(), never from a clock, so the protocol runs at whatever speed a test
 * wants. XID is the stack's (Stack.js): what it negotiates spans all the layers.
 *
 * Not covered: break (8.13), multi-frame SREJ (8.4.5.2), T402/T403.
 */

const { MODULUS, COMMAND, RESPONSE } = require('./Frame');

const DEFAULT_N401 = 128;          // octets in an information field (9.2.3)
const DEFAULT_K = 15;              // outstanding I frames (9.2.4)
// 9.2.1 gives T401 no default; three seconds suits 300 bps. t401For() is for real rates.
const DEFAULT_T401_MS = 3000;
// Ta + Tb + Te + Tf, unmeasured: a real SIP-trunk call put propagation and
// processing at 814 ms, so a second covers it with room.
const PROPAGATION_MS = 1000;
// 9.2.2 gives N400 no default; Appendix III.2 asks for ~16 after detection.
const DEFAULT_N400 = 16;
// The appendix's other half: small where detection confirmed nothing.
const UNCONFIRMED_N400 = 3;
// No ceiling in V.42; past this a line is not slow but gone.
const MAX_T401_MS = 6000;

/** Tc + Td: the longest frame already going out and the frame that acknowledges it. */
function transmissionMs(bps) {
  const FRAME_BITS = (DEFAULT_N401 + 6) * 8, ACK_BITS = 6 * 8;
  return Math.floor((FRAME_BITS + ACK_BITS) * 1000 / Math.max(1, bps));
}
/** T401 for a line rate (Appendix IV's sum). */
function t401For(bps) { return PROPAGATION_MS + transmissionMs(bps); }
/** T401 on a line whose round trip the pump measured (V.34 phase 2, V.32's counter): half as much again. */
function t401ForLine(bps, roundTripMs) {
  const measured = roundTripMs + Math.floor(roundTripMs / 2);
  return Math.min(MAX_T401_MS, Math.max(PROPAGATION_MS, measured) + transmissionMs(bps));
}

class Params {
  constructor(o = {}) {
    this.n401 = o.n401 != null ? o.n401 : DEFAULT_N401;
    this.k = o.k != null ? o.k : DEFAULT_K;
    this.t401Ms = o.t401Ms != null ? o.t401Ms : DEFAULT_T401_MS;
    this.n400 = o.n400 != null ? o.n400 : DEFAULT_N400;
  }
}

const State = Object.freeze({ Disconnected: 'Disconnected', AwaitingEstablishment: 'AwaitingEstablishment', AwaitingRelease: 'AwaitingRelease', Connected: 'Connected' });
const Cause = Object.freeze({ Local: 'Local', Peer: 'Peer', NoResponse: 'NoResponse', Refused: 'Refused' });
// Events: { type: 'Connected' } | { type: 'Released', cause } | { type: 'Data', data } | { type: 'Reset' }

const mod = (x) => ((x % MODULUS) + MODULUS) % MODULUS;
/** Outstanding I frames, modulo 128. */
const outstanding = (va, vs) => mod(vs - va);
/** n in [low, high] going forward modulo 128. */
const inWindow = (low, n, high) => mod(n - low) <= mod(high - low);

class Lapm {
  constructor(role, dlci, params = new Params()) {
    this._role = role; this._dlci = dlci; this.params = params;
    this._state = State.Disconnected;
    this.vs = 0; this.va = 0; this.vr = 0;     // 8.2.3.2.2, .3, .5
    this.pending = [];        // data from the DTE waiting to go out
    this.unacked = [];        // [ns, info] sent, not acknowledged, oldest first
    this.out = [];            // [frame, kind] queued for the HDLC layer
    this.events = [];
    this.peerBusy = false;    // RNR
    this.rejectSent = false;  // 8.4.4: one reject exception at a time
    this.srej = false;        // 8.4.5.1 agreed
    // I frames ahead of V(R), held until the gap closes: all selective reject buys
    // (8.2.4.8.1 has the frames after the missing one not sent again).
    this.held = new Map();
    this.ackPending = false;
    this.timerRecovery = false;   // 8.5.3
    this.timer = null;
    this.retries = 0;
    // Time since the oldest unacknowledged command, across retries: how long the
    // acknowledgement really took.
    this.awaitingMs = null;
    this.suspendedFlag = false;   // 7.10.2
  }

  /** Freeze T401 (7.10.2), keeping what it had left and its own measurement. */
  suspend() { this.suspendedFlag = true; }
  /** Unfreeze it (7.11). */
  resume() { this.suspendedFlag = false; }
  suspended() { return this.suspendedFlag; }

  /** The retransmission limit, settled after detection (9.2.2 lets the XID's differ). */
  setRetransmissions(n400) { this.params.n400 = n400; }
  /** Selective retransmission (8.4.5.1), only once both ends said so in XID. */
  setSelectiveReject(on) { this.srej = !!on; }
  selectiveReject() { return this.srej; }

  state() { return this._state; }
  isConnected() { return this._state === State.Connected; }

  /** The next [frame, kind] for the HDLC layer, or null. */
  pollTransmit() { this._pump(); return this.out.length ? this.out.shift() : null; }
  pollEvent() { return this.events.length ? this.events.shift() : null; }

  /** Ask for an error-corrected connection (8.3); connected, it re-establishes (8.6). */
  connect() {
    if (this._state === State.AwaitingEstablishment) return;
    this._resetVariables();
    this._state = State.AwaitingEstablishment;
    this.retries = 0;
    this._send({ type: 'SABME', poll: true }, COMMAND);   // P set so the UA can be matched
    this._startTimer();
  }

  /** Release (8.7.2); DISC always carries P (the note), so a DM cannot be misread. */
  disconnect() {
    if (this._state === State.Disconnected) return;
    this.pending = []; this.unacked = [];
    this._state = State.AwaitingRelease;
    this.retries = 0;
    this._send({ type: 'DISC', poll: true }, COMMAND);
    this._startTimer();
  }

  /** Bytes accepted and not yet framed: what a caller asks before handing over more. */
  queued() { let n = 0; for (const c of this.pending) n += c.length; return n; }

  /** Queue data, split to fit N401 (9.2.3). */
  sendData(data) {
    for (let i = 0; i < data.length; i += this.params.n401) this.pending.push(Array.from(data.slice(i, i + this.params.n401)));
  }

  /** Advance the timers by dtMs (8.3.2.2, 8.7.3, 8.4.8). */
  tick(dtMs) {
    if (this.suspendedFlag) return;       // 7.10.2: time not given is time frozen
    if (this.awaitingMs !== null) this.awaitingMs += dtMs;
    if (this.timer === null) return;
    if (this.timer > dtMs) { this.timer -= dtMs; return; }
    this.timer = null;
    // An expiry says T401 is too short without saying by how much: half again.
    this.params.t401Ms = Math.min(MAX_T401_MS, Math.floor(this.params.t401Ms * 3 / 2));
    this.retries++;
    if (this.retries >= this.params.n400) { this._fail(); return; }
    switch (this._state) {
      case State.AwaitingEstablishment: this._send({ type: 'SABME', poll: true }, COMMAND); this._startTimer(); break;
      case State.AwaitingRelease: this._send({ type: 'DISC', poll: true }, COMMAND); this._startTimer(); break;
      case State.Connected:
        // 8.5.3: poll rather than resend blindly; the reply says what is missing.
        // The only way a lost FINAL frame is recovered.
        this.timerRecovery = true;
        this._send({ type: 'RR', nr: this.vr, pf: true }, COMMAND);
        this.ackPending = false;
        this._startTimer();
        break;
      default: break;
    }
  }

  /** A frame from the peer. */
  receive(frame, kind) {
    // 8.3.2.1: an I or supervisory frame while awaiting the UA means the UA was lost.
    if (this._state === State.AwaitingEstablishment && ['I', 'RR', 'RNR', 'REJ', 'SREJ'].includes(frame.type)) this._establish();
    switch (frame.type) {
      case 'SABME': this._onSabme(frame.poll); return;     // in every state (8.8, 8.9)
      case 'DISC': this._onDisc(frame.poll); return;
      case 'UA': this._onUa(frame.final); return;
      case 'DM': this._onDm(frame.final); return;
      default: break;
    }
    if (this._state !== State.Connected) return;           // 8.8: discarded
    switch (frame.type) {
      case 'I': this._onI(frame.ns, frame.nr, frame.poll, frame.info); break;
      case 'RR': this._onRr(frame.nr, frame.pf, kind); break;
      case 'RNR': this._onRnr(frame.nr, frame.pf, kind); break;
      case 'REJ': this._onRej(frame.nr, frame.pf, kind); break;
      case 'SREJ': this._onSrej(frame.nr); break;
      default: break;          // UI, XID, TEST, FRMR: the peer's timers recover
    }
  }

  _onSabme(poll) {
    const was = this._state === State.Connected;
    this._resetVariables();      // 8.2.4.3: unacknowledged I frames discarded
    this._send({ type: 'UA', final: poll }, RESPONSE);
    this._state = State.Connected;
    this._stopTimer();
    this.events.push({ type: was ? 'Reset' : 'Connected' });
  }

  _onDisc(poll) {
    if (this._state === State.Disconnected) { this._send({ type: 'DM', final: poll }, RESPONSE); return; }   // 8.8
    this._send({ type: 'UA', final: poll }, RESPONSE);
    this._enterDisconnected(Cause.Peer);
  }

  _onUa(final) {
    if (this._state === State.AwaitingEstablishment && final) this._establish();
    else if (this._state === State.AwaitingRelease && final) this._enterDisconnected(Cause.Local);
  }

  /** The originator on its UA (8.3.2.1): that list and no more; connect() cleared the rest. */
  _establish() {
    this._stopTimer();
    this.vs = 0; this.va = 0; this.vr = 0;
    this._state = State.Connected;
    this.events.push({ type: 'Connected' });
  }

  _onDm(final) {
    // 8.9.3: a DM with F clear colliding with a set-mode command is ignored.
    if (this._state === State.AwaitingEstablishment && final) this._enterDisconnected(Cause.Refused);
    else if (this._state === State.AwaitingRelease && final) this._enterDisconnected(Cause.Local);
    else if (this._state === State.Connected) this._enterDisconnected(Cause.Refused);
  }

  _onI(ns, nr, poll, info) {
    this._acknowledge(nr);
    if (ns === this.vr) this._deliver(info);
    else if (this.srej) {
      // Keep what follows the missing one; bounded by the window.
      const top = mod(this.vr + Math.min(this.params.k, MODULUS - 1));
      if (inWindow(this.vr, ns, top)) this.held.set(ns, info);
      if (!this.rejectSent) { this.rejectSent = true; this._send({ type: 'SREJ', nr: this.vr }, COMMAND); }
    } else if (!this.rejectSent) {
      this.rejectSent = true;          // 8.4.4: everything from V(R) again
      this._send({ type: 'REJ', nr: this.vr, pf: false }, COMMAND);
    }
    if (poll) { this._send({ type: 'RR', nr: this.vr, pf: true }, RESPONSE); this.ackPending = false; }   // 8.4.2.1
  }

  /** An in-sequence frame and all it unblocks; the SREJ exception clears here (8.2.4.8.1). */
  _deliver(info) {
    this.vr = mod(this.vr + 1);
    this.rejectSent = false;
    this.ackPending = true;
    if (info.length) this.events.push({ type: 'Data', data: info });
    while (this.held.has(this.vr)) {
      const next = this.held.get(this.vr); this.held.delete(this.vr);
      this.vr = mod(this.vr + 1);
      if (next.length) this.events.push({ type: 'Data', data: next });
    }
  }

  /** 8.4.5.1: the one frame asked for; V(A) does not move. */
  _onSrej(nr) {
    this.peerBusy = false;
    const hit = this.unacked.find(([ns]) => ns === nr);
    if (!hit) return;
    this.out.push([{ type: 'I', ns: hit[0], nr: this.vr, poll: false, info: hit[1] }, COMMAND]);
    this.ackPending = false;
    this._startTimer();
  }

  _onRr(nr, pf, kind) { this.peerBusy = false; this._acknowledge(nr); this._resolveTimerRecovery(pf, kind); this._answerPoll(pf, kind); }
  _onRnr(nr, pf, kind) { this._acknowledge(nr); this.peerBusy = true; this._resolveTimerRecovery(pf, kind); this._answerPoll(pf, kind); }

  /** The reply to a timer-recovery poll (8.5.3): what is still unacknowledged never arrived. */
  _resolveTimerRecovery(pf, kind) {
    if (!this.timerRecovery || !pf || kind !== RESPONSE) return;
    this.timerRecovery = false;
    this.retries = 0;
    if (this.va !== this.vs) this._retransmitFrom(this.va);
  }

  _onRej(nr, pf, kind) { this.peerBusy = false; this._acknowledge(nr); this._retransmitFrom(nr); this._answerPoll(pf, kind); }

  /** 8.4.2.1: a command with P set needs a response with F set. */
  _answerPoll(pf, kind) {
    if (pf && kind === COMMAND) { this._send({ type: 'RR', nr: this.vr, pf: true }, RESPONSE); this.ackPending = false; }
  }

  /** Retire acknowledged frames; N(R) is valid when V(A) ≤ N(R) ≤ V(S) (8.2.3.2.3). */
  _acknowledge(nr) {
    if (!inWindow(this.va, nr, this.vs)) return;
    while (this.va !== nr) { this.unacked.shift(); this.va = mod(this.va + 1); }
    if (this.va === this.vs) { this._stopTimer(); this.retries = 0; }
    else { this.awaitingMs = null; this._startTimer(); }   // the oldest outstanding is a later one now
  }

  _retransmitFrom(nr) {
    if (!inWindow(this.va, nr, this.vs)) return;
    // From the buffer, V(S) undisturbed: the frames keep their numbers.
    for (const [ns, info] of this.unacked) if (inWindow(nr, ns, this.vs)) this.out.push([{ type: 'I', ns, nr: this.vr, poll: false, info }, COMMAND]);
    this.ackPending = false;
    this._startTimer();
  }

  /** What the window allows, then any outstanding acknowledgement. */
  _pump() {
    if (this._state !== State.Connected) return;
    while (!this.peerBusy && this.pending.length && outstanding(this.va, this.vs) < this.params.k) {
      const info = this.pending.shift();
      const ns = this.vs;
      this.unacked.push([ns, info]);
      this.vs = mod(this.vs + 1);
      this.out.push([{ type: 'I', ns, nr: this.vr, poll: false, info }, COMMAND]);   // N(R) rides along
      this.ackPending = false;
      this._startTimer();
    }
    if (this.ackPending) { this.ackPending = false; this._send({ type: 'RR', nr: this.vr, pf: false }, RESPONSE); }
  }

  _send(frame, kind) { this.out.push([frame, kind]); }

  _resetVariables() {
    this.vs = 0; this.va = 0; this.vr = 0;
    this.held.clear(); this.unacked = [];
    this.peerBusy = false; this.rejectSent = false; this.ackPending = false; this.timerRecovery = false;
  }

  _enterDisconnected(cause) {
    this._state = State.Disconnected;
    this._stopTimer();
    this.pending = []; this.unacked = [];
    this.events.push({ type: 'Released', cause });
  }

  _fail() { this._enterDisconnected(Cause.NoResponse); }

  _startTimer() {
    this.timer = this.params.t401Ms;
    if (this.awaitingMs === null) this.awaitingMs = 0;   // a retransmission is still the same wait
  }

  _stopTimer() {
    this.timer = null;
    const waited = this.awaitingMs; this.awaitingMs = null;
    // A clean answer is the round trip itself; half again for the terms that vary.
    if (waited !== null && this.retries === 0) this.params.t401Ms = Math.max(this.params.t401Ms, Math.min(MAX_T401_MS, waited + Math.floor(waited / 2)));
  }

  /** T401 as it stands; it only ever rises (9.2.1). */
  t401Ms() { return this.params.t401Ms; }
  role() { return this._role; }
  dlci() { return this._dlci; }
}

module.exports = {
  DEFAULT_N401, DEFAULT_K, DEFAULT_T401_MS, PROPAGATION_MS, DEFAULT_N400, UNCONFIRMED_N400, MAX_T401_MS,
  t401For, t401ForLine, Params, State, Cause, Lapm, outstanding, inWindow,
};
