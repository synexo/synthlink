'use strict';

/*!
 * @license
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Copyright (C) 2026 Joseph Quinn
 *
 * Ported from BinModem <https://github.com/CasualArclamp/BinModem>,
 * crates/ec/src/detect.rs, at commit 623f935e28fe6de3a8a4f41492feb46e1bb86c3a of
 * <https://github.com/synexo/BinModem>. Copyright the BinModem authors;
 * GPL-3.0-or-later. See NOTICE.
 */

/**
 * Detect.js — the V.42 detection phase (7.2.1): async-framed characters over the
 * synchronous bit stream. The originator sends DC1 with alternating even and odd
 * parity; the answerer replies E then C for error control, or E then NUL to
 * decline. Bits are 0/1.
 */

const DEFAULT_T400_MS = 750;      // 9.1.1
const ODP_EVEN = 0x11, ODP_ODD = 0x91;
const ADP_E = 0x45, ADP_C = 0x43, ADP_NULL = 0x00;
const ADP_M = 0x4d;               // a cellular protocol and V.42 (Appendix VI.1), then EC
const ADP_P = 0x50;               // V.42 and V.44 in the XID user data subfield, then EC
const FILL_ONES = 12;             // 8 to 16 permitted
const FILL_MIN = 8, FILL_MAX = 16;
// Plain text in a row (framed, printable, back to back) after which the far end
// is its terminal talking, not V.42: a real login banner's "**EMSI_REQ" read as
// two answer patterns. Sixteen at random is a few in a trillion.
const TEXT_RUN = 16;
// Identical answers back to back, without Table 3's fill, before they count: the
// board BinModem calls most answers ECECEC... with no fill at all.
const UNFILLED_PAIRS = 4;
const HEARD_LIMIT = 1 << 16;      // kept for the terminal if detection fails (Appendix I.3)
const ADP_REPEATS = 10;           // 7.2.1.3's floor; Appendix III.1 says go on past it
const FLAG = 0x7e;
// "Continuous flags": one turns up at random every 256 bits, three on one grid once in 16 million.
const FLAG_RUN = 3;

// Answers (Table 3): { kind: 'ErrorControl' | 'None' | 'Extended' | 'Reserved', ch }
const Answer = Object.freeze({
  ErrorControl: Object.freeze({ kind: 'ErrorControl' }),
  None: Object.freeze({ kind: 'None' }),
  extended: (ch) => ({ kind: 'Extended', ch }),
  reserved: (ch) => ({ kind: 'Reserved', ch }),
  fromChar(c) { return c === ADP_C ? Answer.ErrorControl : c === ADP_NULL ? Answer.None : (c === ADP_M || c === ADP_P) ? Answer.extended(c) : Answer.reserved(c); },
  /** The extended patterns say V.42 as plainly as EC does. */
  errorControlled(a) { return a.kind === 'ErrorControl' || a.kind === 'Extended'; },
  offersV44(a) { return a.kind === 'Extended' && a.ch === ADP_P; },
  same(a, b) { return a.kind === b.kind && (a.ch ?? null) === (b.ch ?? null); },
});

// Outcomes: { kind: 'Pending' | 'Answered' (answer) | 'OriginatorDetected' | 'ProtocolStarted' | 'TimedOut' | 'Text' }
const Outcome = Object.freeze({
  Pending: Object.freeze({ kind: 'Pending' }),
  OriginatorDetected: Object.freeze({ kind: 'OriginatorDetected' }),
  // 7.2.1.3's third case: the originator skipped detection (7.2.1.2, V.92 9.3.1).
  ProtocolStarted: Object.freeze({ kind: 'ProtocolStarted' }),
  TimedOut: Object.freeze({ kind: 'TimedOut' }),
  Text: Object.freeze({ kind: 'Text' }),            // Appendix I.3: its terminal is typing
  answered: (answer) => ({ kind: 'Answered', answer }),
});

/** Async-framed characters out of a synchronous bit stream. */
class CharacterScanner {
  constructor() { this.collecting = null; this.idle = Infinity; }   // idle for as long as anyone knows
  /** null, or { value, gap } for a character, or { framingError: true }. */
  scan(bit) {
    if (this.collecting === null) {
      if (bit) this.idle = this.idle + 1; else this.collecting = [0, 0];   // a space on idle is a start bit
      return null;
    }
    const [value, count] = this.collecting;
    if (count < 8) { this.collecting = [value | ((bit ? 1 : 0) << count), count + 1]; return null; }   // low-order first
    this.collecting = null;
    const gap = this.idle; this.idle = 0;
    return bit ? { value, gap } : { framingError: true };
  }
  feed(bit) { const s = this.scan(bit); return s && !s.framingError ? s.value : null; }
}

const fill = (gap) => gap >= FILL_MIN && gap <= FILL_MAX;

/** Two adjacent patterns as Table 3 draws them, fill and all, at the end of what was seen. */
function filledAnswer(seen) {
  if (seen.length < 4) return null;
  const [a, b, c, d] = seen.slice(-4);
  const filled = [b[1], c[1], d[1]].every(fill);
  return filled && a[0] === ADP_E && c[0] === ADP_E && b[0] === d[0] ? Answer.fromChar(b[0]) : null;
}

/** The same pattern back to back, as a real modem sends it; only the four meant answers. */
function unfilledAnswer(seen) {
  if (seen.length < 2 * UNFILLED_PAIRS) return null;
  const run = seen.slice(-2 * UNFILLED_PAIRS);
  const kind = run[1][0];
  const meant = [ADP_C, ADP_NULL, ADP_M, ADP_P].includes(kind);
  let repeated = true;
  for (let i = 0; i < run.length; i += 2) if (run[i][0] !== ADP_E || run[i + 1][0] !== kind) repeated = false;
  const backToBack = run.slice(1).every(([, gap]) => gap < FILL_MIN);
  return meant && repeated && backToBack ? Answer.fromChar(kind) : null;
}

const texty = (c) => (c >= 0x20 && c <= 0x7e) || c === 0x0d || c === 0x0a || c === 0x09;

/** One character as start bit, eight data bits, stop bit, then the fill. */
function pushCharacter(bits, value) {
  bits.push(0);
  for (let i = 0; i < 8; i++) bits.push((value >> i) & 1);
  bits.push(1);
  for (let i = 0; i < FILL_ONES; i++) bits.push(1);
}

/** The originator's side (7.2.1.2). */
class Originator {
  constructor(t400Ms = DEFAULT_T400_MS) {
    this.out = []; this.scanner = new CharacterScanner();
    this.seen = [];       // the last few [char, gap]
    this.adps = [];       // adjacent pairs observed, by what they said
    this.text = 0; this.heard = []; this.elapsed = 0; this.t400Ms = t400Ms;
    this._outcome = Outcome.Pending;
    this._queueOdp();
  }
  _queueOdp() { pushCharacter(this.out, ODP_EVEN); pushCharacter(this.out, ODP_ODD); }

  /** The next bit to send; the ODP repeats until detection ends, then mark. */
  transmit() {
    if (this._outcome !== Outcome.Pending) return 1;
    if (!this.out.length) this._queueOdp();
    return this.out.length ? this.out.shift() : 1;
  }

  receive(bit) {
    if (this._outcome !== Outcome.Pending) return this._outcome;
    if (this.heard.length < HEARD_LIMIT) this.heard.push(bit ? 1 : 0);
    const s = this.scanner.scan(bit);
    if (s && !s.framingError) {
      this.text = texty(s.value) && s.gap < FILL_MIN ? this.text + 1 : 0;
      if (this.text >= TEXT_RUN) { this._outcome = Outcome.Text; return this._outcome; }
      this.seen.push([s.value, s.gap]);
      if (this.seen.length > 2 * UNFILLED_PAIRS) this.seen.shift();
      this._classify();
    } else if (s) this.text = 0;
    return this._outcome;
  }

  takeHeard() { const h = this.heard; this.heard = []; return h; }

  /** Adjacent ADPs saying the same thing; an extended one is listened past (Appendix VI.1). */
  _classify() {
    const answer = filledAnswer(this.seen) || unfilledAnswer(this.seen);
    if (!answer) return;
    this.adps.push(answer);
    this.text = 0;            // a pattern is not text, however printable
    if (answer.kind !== 'Extended') this._outcome = Outcome.answered(answer);   // 7.2.1.2: two adjacent
  }

  patterns() { return this.adps; }

  /** 9.1.1. A V.42-saying pattern heard before an EC lost to the line is not nothing. */
  tick(dtMs) {
    if (this._outcome !== Outcome.Pending) return this._outcome;
    this.elapsed += dtMs;
    if (this.elapsed >= this.t400Ms) {
      const last = this.adps[this.adps.length - 1];
      this._outcome = last && Answer.errorControlled(last) ? Outcome.answered(last) : Outcome.TimedOut;
    }
    return this._outcome;
  }

  outcome() { return this._outcome; }
}

/** The answerer's side (7.2.1.3). */
class Answerer {
  constructor(t400Ms = DEFAULT_T400_MS, answer = Answer.ErrorControl) {
    this.out = []; this.scanner = new CharacterScanner();
    this.dc1Run = 0; this.lastParity = null;
    this.elapsed = 0; this.t400Ms = t400Ms;
    this._outcome = Outcome.Pending; this.answer = answer;
    this.repeats = 0;
    this.history = 0; this.sinceFlag = Infinity; this.flagRun = 0;
    this.flags = false;       // the originator has begun the protocol phase
    this.text = 0; this.heard = [];
    // Whether anything has looked like a detection pattern (a partial DC1 run is
    // not evidence: a V.92 line before the far end's data mode frames DC1s at random).
    this.detecting = false;
    this.expired = false;
    // Ten T400s of patience, for a far end not yet listening (V.92); prompt() for one.
    this.wide = true;
  }

  /** One T400 of patience, for a call whose two directions reach data mode together. */
  prompt() { this.wide = false; return this; }

  takeHeard() { const h = this.heard; this.heard = []; return h; }

  /** Marks until the ODP, then the ADP until the originator's flags say it was heard (7.2.1.3). */
  transmit() {
    if (!this.out.length && this._outcome === Outcome.OriginatorDetected && !this._saidEnough()) this._queueAdp();
    return this.out.length ? this.out.shift() : 1;
  }

  /** Ten repetitions is the floor; past it, until the flags come (Appendix III.1). */
  _saidEnough() {
    return this._outcome === Outcome.ProtocolStarted || this._outcome === Outcome.TimedOut || this.expired || (this.repeats >= ADP_REPEATS && this.flags);
  }

  _queueAdp() {
    const a = this.answer;
    const second = a.kind === 'ErrorControl' ? ADP_C : a.kind === 'None' ? ADP_NULL : a.ch;
    pushCharacter(this.out, ADP_E); pushCharacter(this.out, second);
    this.repeats++;
  }

  _someoneIsDetecting() { return this.detecting || this.flags; }

  receive(bit) {
    bit = bit ? 1 : 0;
    // Watched past detection: the flags that stop the ADP come after the ODP.
    this.history = ((this.history << 1) | bit) & 0xff;
    this.sinceFlag = this.sinceFlag + 1;
    if (this.history === FLAG) {
      this.flagRun = this.sinceFlag === 8 ? this.flagRun + 1 : 1;   // eight apart a run, nine a coincidence
      this.sinceFlag = 0;
      if (this.flagRun >= FLAG_RUN) {
        this.flags = true;
        if (this._outcome === Outcome.Pending) { this._outcome = Outcome.ProtocolStarted; return this._outcome; }
      }
    }
    if (this._outcome !== Outcome.Pending) return this._outcome;
    if (this.heard.length < HEARD_LIMIT) this.heard.push(bit);
    const s = this.scanner.scan(bit);
    if (!s) return this._outcome;
    if (s.framingError) { this.text = 0; return this._outcome; }
    this.text = texty(s.value) && s.gap < FILL_MIN ? this.text + 1 : 0;
    if (this.text >= TEXT_RUN) { this._outcome = Outcome.Text; return this._outcome; }
    const c = s.value;
    if (c === ODP_EVEN || c === ODP_ODD) {
      // 7.2.1.3: four DC1s of alternating parity; the same parity twice breaks it.
      this.dc1Run = this.lastParity === c ? 1 : this.dc1Run + 1;
      this.lastParity = c;
      if (this.dc1Run >= 4) {
        this.detecting = true;
        this._outcome = Outcome.OriginatorDetected;
        this.elapsed = 0;        // the bound is on the repeating, not what was left
        this._queueAdp();
      }
    } else { this.dc1Run = 0; this.lastParity = null; }
    return this._outcome;
  }

  /**
   * 7.2.1.3 gives no deadline for the ODP; a silent line is given up on at ten
   * T400s (one with prompt()), and a refusal being given waits only one.
   */
  tick(dtMs) {
    this.elapsed += dtMs;
    if (this._outcome !== Outcome.Pending && this._outcome !== Outcome.OriginatorDetected) return this._outcome;
    const patience = this.answer.kind === 'None' && this._someoneIsDetecting() ? this.t400Ms : this.wide ? this.t400Ms * 10 : this.t400Ms;
    if (this.elapsed >= patience) {
      // An originator was heard: that is still what happened, flags or not.
      if (this._outcome === Outcome.OriginatorDetected) this.expired = true;
      else this._outcome = Outcome.TimedOut;
    }
    return this._outcome;
  }

  outcome() { return this._outcome; }
  /** The answer has been sent for as long as it should be, its last repetition out. */
  finishedSending() { return this._outcome !== Outcome.Pending && !this.out.length && this._saidEnough(); }
  /** Whether the ADP still has bits to send (a mark from transmit() cannot say so). */
  sending() { return this.out.length > 0 || (this._outcome === Outcome.OriginatorDetected && !this._saidEnough()); }
  heardFlags() { return this.flags; }
}

module.exports = {
  DEFAULT_T400_MS, ODP_EVEN, ODP_ODD, ADP_E, ADP_C, ADP_NULL, ADP_M, ADP_P,
  Answer, Outcome, CharacterScanner, Originator, Answerer, pushCharacter, filledAnswer, unfilledAnswer,
};
