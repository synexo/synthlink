'use strict';

/**
 * V.32 — 9600 bps, per ITU-T Recommendation V.32, "minimal 9600" profile:
 * the mandatory non-redundant (uncoded) 16-QAM mode every V.32 modem had to
 * support for interworking, operated as a TRUE FULL-DUPLEX continuous-carrier
 * modem (unlike our V.29, which is half-duplex ping-pong).
 *
 * ── Why full-duplex works here without an echo canceller ─────────────────────
 * Real V.32 is genuinely full-duplex: both modems transmit simultaneously in
 * the SAME voiceband using a single shared 1800 Hz carrier per direction, which
 * on a 2-wire PSTN line demands near/far adaptive ECHO CANCELLATION (each modem
 * must subtract its own 1800 Hz carrier from what it hears). That echo canceller
 * is the single hardest part of a V.32 implementation.
 *
 * Our transport is two independent WebSocket directions — a 4-wire equivalent.
 * Each direction carries exactly one carrier and nothing of our own transmit
 * leaks back into our receive, so the echo canceller is UNNECESSARY. This is the
 * same architectural payoff that let V.29 run clean; for V.32 it removes the
 * component that makes V.32 hard, so we get to keep genuine full-duplex.
 *
 * ── Why continuous full-duplex does NOT flood with idle bytes here ───────────
 * A continuous QAM carrier with a free-running receiver and no framing turns an
 * idle (all-ones) carrier into a flood of 0xFF bytes — the exact failure that
 * pushed V.29 to a burst design. V.32 avoids it the honest way: it is a
 * SYNCHRONOUS SCRAMBLED modem. The transmitter always emits a scrambled bit
 * stream; when there is no data it scrambles continuous MARK (all ones). We
 * carry the byte stream on top of that with async start/stop (UART) framing
 * exactly as a modem in direct async mode (AT\N0) does, so descrambled idle mark
 * produces NO start bit and therefore NO bytes. The carrier stays up (true
 * full-duplex idle fill), but the line is silent at the byte layer.
 *
 * ── What is genuine V.32 here ───────────────────────────────────────────────
 *   - Single carrier 1800 Hz, 2400 baud, 16-state non-redundant QAM,
 *     4 data bits/symbol = 9600 bps (ITU-T V.32 §5, non-redundant coding).
 *   - The two most-significant bits Q1,Q2 of each 4-bit group are DIFFERENTIALLY
 *     encoded into Y1,Y2 (quadrant) by **Table 1/V.32**, whose title names this
 *     exact mode — "for 4800 bit/s and for nonredundant coding at 9600 bit/s" —
 *     so the rate signals and the data carry the same differential coding. Note it
 *     is NOT a modulo-4 addition of the dibit: its phase quadrant change column is
 *     +90°, 0°, +180°, +270° for 00, 01, 10, 11, which transposes the first two.
 *     Q3,Q4 select the point within the quadrant (absolute), by **Table 3/V.32**'s
 *     non-redundant column. The 16 points sit on the {±1,±3}² grid (Figure 1), so
 *     a whole-constellation rotation by any multiple of 90° cancels in the
 *     differential decoder (rotational invariance).
 *   - The real, role-asymmetric self-synchronising V.32 scramblers (§7):
 *       Call-mode (originate)  GPC = 1 + x^-18 + x^-23
 *       Answer-mode            GPA = 1 + x^-5  + x^-23
 *     Each end scrambles its transmit with its OWN generating polynomial and
 *     descrambles the peer's receive with the PEER's polynomial.
 *   - 2400 baud at 8 kHz => 3.333 samples/symbol, handled by continuous
 *     root-raised-cosine synthesis + fractional matched filtering (rolloff 0.25),
 *     the same fractional-SPS machinery proven in V.29.
 *   - The Recommendation's own start-up, §§5.2–5.4: the receiver conditioning
 *     signal's three segments (S for 256T, S̄ for 16T, TRN for 1280T) and the
 *     R1/R2/R3 rate-signal exchange with the sequence E that ends it, all at the
 *     A/B/C/D states of Figure 1/V.32 with the rate signals differentially encoded
 *     by Table 1/V.32. The signals live in V32Startup.js; §5.4's procedure — who
 *     transmits what, and which SIGNAL each end waits for before it does — is the
 *     connect script and the start-up receiver below.
 *
 * ── What is deliberately "genuine minimal" (documented, not hidden) ─────────
 *   - The 32-state TRELLIS-CODED (TCM) 9600 mode is NOT implemented. Minimum
 *     interworking only requires the non-redundant 16-QAM mode; TCM (and the
 *     larger constellations) belong to V.32bis (12000/14400) and are the next
 *     step up. No convolutional encoder / Viterbi decoder here.
 *   - No adaptive equalizer and no continuous timing tracking. The receiver
 *     acquires symbol timing, carrier phase and gain ONCE — now on signal S, which
 *     is what §5.2.2 says that segment boundary is for — and then free-runs. This
 *     is sound on our transport specifically because both ends share the one
 *     lossless 8 kHz clock with zero drift (the same reason the clean-link flags
 *     are safe) — there is nothing to track. Against a real V.32 modem over a real
 *     line you would add the V.22bis-style T/2 fractional equalizer + timing
 *     recovery. Untested against real hardware.
 *   - The ECHO-CANCELLER half of §5.4 is omitted: the AA/CC and AC/CA segments,
 *     the 600/1800/3000 Hz tone detections and phase reversals, and the NT/MT
 *     round-trip estimates the counter/timer produces. All of it exists to train
 *     the echo canceller and to measure a round trip our 4-wire-equivalent
 *     transport does not have. What remains is every signal that carries
 *     information — which is the whole of §5.2 and §5.3.
 *
 * Interface (matches the other protocol classes so HandshakeEngine can drive it):
 * constructor(role); generateAudio(n)->Float32Array; receiveAudio(f32);
 * write(buf); emits 'data' (Buffer) and 'ready' ({bps, remoteDetected});
 * getters bps and carrierDetected.
 */

const { EventEmitter } = require('events');
// §§5.2–5.3's signals: S, S̄, TRN, Table 1's differential coding, and the 16-bit
// rate sequences of Table 6/V.32 and the E of Table 7/V.32. Shared with V32bis.js,
// whose §5.2 and §5.2.3 are word for word the same clauses.
const V32S = require('./V32Startup');

const SR = 8000, BAUD = 2400, FC = 1800, SPS = SR / BAUD; // 3.333…
const ROLLOFF = 0.25, SPAN = 10;

// ── V.32 non-redundant 16-QAM constellation (Figure 1/Table 3) ───────────────
// Points on the {±1,±3}² grid. Y1Y2 (quadrant, differentially encoded) chooses
// the quadrant by rotating the quadrant-I base point by Y*90° CCW; Q3Q4 (point
// within quadrant, absolute) chooses the base point. Table 3's labels are
// rotationally consistent — rotating a quadrant-I point by 90° lands on the same
// Q3Q4 in the next quadrant — which is what makes one base row plus a rotation
// the whole of the map, rather than the 16-entry lookup V.32bis needs.
//
// These are Table 3/V.32's four quadrant-I rows in the order the table prints
// them, indexed (Q3<<1)|Q4:
//   1100 -> ( 1, 1)   1101 -> ( 3, 1)   1110 -> ( 1, 3)   1111 -> ( 3, 3)
// Entries 01 and 10 were the other way round until this was checked against the
// table: an error that round-trips perfectly, because the receiver inverted it.
const BASE = [ { i: 1, q: 1 }, { i: 3, q: 1 }, { i: 1, q: 3 }, { i: 3, q: 3 } ];
// rotate (i,q) CCW by y quarter-turns: (i,q)->(-q,i)
function rotCCW(i, q, y) {
  switch (y & 3) {
    case 0: return { i, q };
    case 1: return { i: -q, q: i };
    case 2: return { i: -i, q: -q };
    default: return { i: q, q: -i };
  }
}
// rotate (i,q) CW by y quarter-turns (inverse of rotCCW): (i,q)->(q,-i)
function rotCW(i, q, y) {
  switch (y & 3) {
    case 0: return { i, q };
    case 1: return { i: q, q: -i };
    case 2: return { i: -i, q: -q };
    default: return { i: -q, q: i };
  }
}
// quadrant (0..3, CCW from +,+) of a sliced grid point
function quadOf(i, q) {
  if (i > 0 && q > 0) return 0;
  if (i < 0 && q > 0) return 1;
  if (i < 0 && q < 0) return 2;
  return 3;
}
// nearest odd grid level in {-3,-1,1,3}
function level(v) { return v >= 2 ? 3 : v >= 0 ? 1 : v >= -2 ? -1 : -3; }

/**
 * Table 3/V.32's non-redundant map, both directions, in one place.
 *
 * They are a pair on purpose. Divergence B below lived in BOTH of them — the
 * transmitter's base index and the receiver's bit extraction — which is exactly
 * how a wrong constellation map round-trips for years without a test noticing.
 * One definition and its stated inverse is what makes that impossible to have in
 * only one direction. tools/tests/v32-map-check.js drives these, not a copy.
 *
 * `rot` is the quadrant as CCW quarter-turns from quadrant I, which is what the
 * differential coding accumulates.
 */
function dataPoint(rot, Q3, Q4) {
  const b = BASE[(Q3 << 1) | Q4];
  return rotCCW(b.i, b.q, rot);
}
function dataBits(i, q) {
  const rot = quadOf(i, q);
  const b = rotCW(i, q, rot);                 // back to quadrant I
  return { rot, Q3: Math.abs(b.q) === 3 ? 1 : 0, Q4: Math.abs(b.i) === 3 ? 1 : 0 };
}

function rrcAt(t) {
  const b = ROLLOFF;
  if (Math.abs(t) < 1e-8) return 1 - b + 4 * b / Math.PI;
  if (Math.abs(Math.abs(4 * b * t) - 1) < 1e-6) {
    return (b / Math.SQRT2) *
      ((1 + 2 / Math.PI) * Math.sin(Math.PI / (4 * b)) +
       (1 - 2 / Math.PI) * Math.cos(Math.PI / (4 * b)));
  }
  const pt = Math.PI * t;
  return (Math.sin(pt * (1 - b)) + 4 * b * t * Math.cos(pt * (1 + b))) /
         (pt * (1 - (4 * b * t) * (4 * b * t)));
}
let RRC_G = 1;
{ let s = 0; for (let k = -SPAN * 4; k <= SPAN * 4; k++) s += rrcAt(k / 4) ** 2; RRC_G = 1 / Math.sqrt(s / 4); }
const rrc = t => rrcAt(t) * RRC_G;

// Amplitude of the transmitted passband (grid coords up to 3, |point| up to
// 3√2). Chosen so burst RMS ≈ 0.1 (matches the other protocols / the RX squelch).
const TX_GAIN = 0.09;

const UART_ARM_MARKS = 8;   // idle-mark run required before honouring a start bit

// ── RX carrier squelch (raw-sample |x| EWMA; carrier RMS ~0.1, gaps == exact 0).
// Gates the answer modem's §5.4.2 cease-and-resume, which is the one real silence
// in the start-up, and detects hangup; the continuous carrier keeps rxOn latched.
const RX_A = 0.02, RX_HI = 0.015, RX_LO = 0.006, RX_HANG = 48;

// ── §§5.2–5.4 start-up constants ────────────────────────────────────────────
// §5.2.3: "The duration of segment 3 shall be at least 1280 and not exceed 8192
// symbol intervals." The minimum is the legal choice taken here, per the backlog's
// rule that a shorter start-up comes from the knobs the Recommendation provides
// rather than by omission. It is 0.53 s at 2400 baud and is most of what the
// start-up now costs.
const TRN_SYMBOLS = V32S.TRN_MIN_SYMBOLS;

// §5.3.1 needs "two consecutive identical 16-bit sequences" to detect a rate
// signal, and the receiver reaches them through a descrambler that is only
// converging while TRN's dibits are still being differentially decoded as though
// they were a rate signal — 23 bits, so about a sequence and a half. Six is that
// with margin, and a rate signal repeats until the peer answers anyway.
const RATE_MIN_REPEATS = 6;

// §5.4.1: "After a delay of 128 symbol intervals, it shall apply an ON condition
// to circuit 109, and unclamp circuit 104", and §5.4.2's answer modem "shall
// transmit scrambled binary ones for 128 symbol intervals" before it is ready to
// transmit data. One constant, both ends.
const E_TO_DATA_SYMBOLS = 128;

// How many symbols of unbroken alternation the receiver requires before it will
// call an S or an S̄. S̄ is only 16T, so the confirmation has to fit inside it with
// margin; 12 does, and is long enough that TRN — whose states are scrambled —
// reaches it with probability 2^-11 per position.
const RUN_CONFIRM = 12;

// A gate here waits on a SIGNAL, not on a sample count, which is what retires
// ORIG_LEAD (a 0.60 s originate-side silence with no basis in the Recommendation).
// This is the fallback if the expected signal never comes. NOTE the DIVERGENCE,
// deliberate and stated rather than hidden: §5.4's recourse is to keep waiting and
// eventually clear the connection, and there is no cleardown state machine here.
// On expiry this modem proceeds anyway, because proceeding degrades to a call that
// trains against a peer that is not following the procedure, where hanging does
// not.
const GATE_TIMEOUT = Math.round(6.0 * SR);

// ── Audible startup (V.25 answer tone) ──────────────────────────────────────
const ANS_TONE_FREQ    = 2100;
const ANS_TONE_AMP     = 0.15;
const ANS_TONE_SAMPLES = Math.round(1.0 * SR);   // ~1.0 s answer tone (answerer)
const CONNECT_GAP      = Math.round(0.08 * SR);  // guard after the tone (>= squelch hangup)

// §5.2's states are Figure 1/V.32's own points, which is the same signal space the
// data constellation is drawn from — both have mean symbol energy 10 — so a V.32
// modem needs no scaling between the two. V.32bis does; see V32Startup.gainFor.
const SU_GAIN = V32S.gainFor(10);

// The data path tracks its differential state as a QUADRANT index (quadOf below),
// and the start-up tracks a rotation index. This is the join between them, used
// once, where E hands over to data.
const QUAD_OF_ROT = [2, 3, 0, 1];   // A(−3,−1) B(1,−3) C(3,1) D(−1,3)

// §5.4: this build implements the mandatory non-redundant 9600 mode and nothing
// else, so that is the whole of what its rate signals may claim (Table 6/V.32's B6,
// with B8 — trellis availability — left clear).
const RATE_SET = [9600];

class V32 extends EventEmitter {
  constructor(role) {
    super();
    this.role = role === 'originate' ? 'originate' : 'answer';
    this._ready = false;

    // Role-asymmetric scrambler taps (index a-1 for x^-a, plus x^-23 at 22).
    // originate transmits GPC(18) and receives GPA(5); answer is the mirror.
    if (this.role === 'originate') { this._txTap = 17; this._rxTap = 4; }
    else                           { this._txTap = 4;  this._rxTap = 17; }

    // ── TX ──
    this.txByteQ = [];            // user (BBS) bytes queued for transmission
    this.scr = new Array(23).fill(0);
    this.txState = 'idle';        // 'idle' | 'active'
    this.txMode = 'qam';          // 'qam' | 'tone'
    this._connectQ = this._buildConnectScript(this.role);
    this._idleSamples = 0;
    this._resetTxBurst();

    // ── RX ──
    this.rxLevel = 0;
    this.rxOn = false;
    this.rxLow = 0;
    this.peerRate = 0;            // rate the peer announced (R1/R2/R3), 0 until seen
    this.rateMismatch = null;     // set if the peer's R3 selects a rate we do not run

    // §5.4 progress. These deliberately survive _resetRx(): the answer modem's
    // §5.4.2 cease divides ONE procedure into two transmissions, and what was
    // detected before the silence is still detected after it. The timing lock, the
    // reference and the descrambler do not survive — they belong to a burst.
    this._sawPeerS = false;       // an S sequence has been detected (§5.4.1/§5.4.2)
    this._sawR1 = false;
    this._sawR3 = false;
    this._sawR2 = false;
    this._sawPeerE = false;
    // Which rate sequence the next detection is. R1 and R3 arrive in different
    // transmissions, so this advances on the carrier drop between them rather than
    // on the first detection — a rate signal repeats, and taking the second
    // repetition of R1 for R3 is exactly what that would do.
    this._rxStage = this.role === 'originate' ? 'r1' : 'r2';
    this._resetRx();
  }

  /**
   * Handshake tells us a genuine V.8 exchange (ANSam/CM/JM/CJ) already ran.
   * The answerer's ANSam has therefore been heard and this class must not emit
   * its own 2100 Hz answer tone on top of it — a second tone lands during the
   * peer's post-CJ training and trips its energy-onset acquisition.
   */
  setV8Complete(done) {
    if (!done) return;
    this._connectQ = this._connectQ.filter(step => step.kind !== 'tone');
  }

  get carrierDetected() { return this.rxOn || this.acq; }
  get bps() { return 9600; }

  write(bytes) { for (const by of bytes) this.txByteQ.push(by & 0xff); }

  // ─── scrambler / descrambler (self-synchronising, multiplicative) ──────────
  _scramble(bit) { const r = this.scr; const out = bit ^ r[this._txTap] ^ r[22]; r.unshift(out); r.pop(); return out; }

  // ─── TX ────────────────────────────────────────────────────────────────────
  _resetTxBurst() {
    this.txSyms = [];             // array of {i,q} constellation points
    this.txSymBase = 0;           // absolute symbol index of txSyms[0] (for trimming)
    this.txMode = 'qam';
    this.txN = 0;                 // monotonic sample index (carrier phase + RRC time)
    this.txPrevY = 0;             // differential quadrant state (reset per data flow)
    this.txFrame = null;          // current byte's framed bits, or null
    this.txFramePos = 0;
    this.txEndSample = -1;        // >=0 => finite burst; -1 => continuous
    this.txContinuous = false;    // the data flow: never ends, never turns the carrier off
    this._suActive = false;       // §5.2/§5.3's signal-gated tail is driving the flow
    this._suEnd = null;           // how that tail finished: 'data' or 'cease'
    this._dataSyms = 0;           // symbols since data began (§5.4's 128)
  }

  /**
   * §5.4's two roles, as a script of bursts. Each step waits for its own gap and,
   * where it carries `gate`, for a SIGNAL as well.
   *
   * §5.4.2's answer modem transmits the receiver conditioning signal and R1
   * unprompted, ceases on detecting the call modem's S, and transmits a second
   * conditioning signal and R3 on detecting R2. §5.4.1's call modem transmits
   * NOTHING until it "detects an incoming S sequence ... and then seek[s] to detect
   * at least two consecutive identical 16-bit rate sequences" — so its first
   * transmission is gated on R1, which is what replaced ORIG_LEAD's fixed 0.60 s.
   *
   * The echo-canceller half — AA/CC, AC/CA, the tone phase reversals and the NT/MT
   * round-trip periods — is omitted; see the header.
   */
  _buildConnectScript(role) {
    if (role === 'answer') {
      return [
        { kind: 'tone', gap: 0 },
        { kind: 'startup', gap: CONNECT_GAP, rate: 'r1' },
        { kind: 'startup', gap: 0, gate: 'r2', rate: 'r3' },
      ];
    }
    return [
      { kind: 'startup', gap: 0, gate: 'r1', rate: 'r2' },
    ];
  }

  /**
   * §5.2's receiver conditioning signal, built in one go because all three segments
   * are fixed-length: S for 256T, S̄ for 16T, then TRN.
   *
   * §5.2.3 initialises the scrambler to all zeros HERE and not before — S and S̄
   * carry no scrambled bits — and nothing in §5.3 re-initialises it, so the same
   * register runs on through the rate signals, through E and into the data mode
   * that follows. §8/V.32bis is the clause that does re-initialise it, and it does
   * so only for rate renegotiation; that it says so there is why the start-up must
   * not. The last TRN symbol is kept because §5.3 initialises the rate signal's
   * differential encoder from it.
   */
  _buildConditioning(rateWhich) {
    const push = (p) => this.txSyms.push({ i: p.i * SU_GAIN, q: p.q * SU_GAIN });
    for (const p of V32S.buildS()) push(p);
    for (const p of V32S.buildSbar()) push(p);

    this.scr.fill(0);                                   // §5.2.3
    let lastRot = V32S.A;
    for (let n = 0; n < TRN_SYMBOLS; n++) {
      lastRot = V32S.trnRotation(n, () => this._scramble(1));
      push(V32S.ROT[lastRot]);
    }

    // What follows cannot be built ahead: §5.4 repeats a rate signal UNTIL the peer
    // answers, so the tail's length is a signal and _suNext() produces it one
    // symbol at a time.
    // How much of the queue is §5.2's conditioning signal. Instrumentation only:
    // _su exists from here on, so without this describe() would report the rate
    // signal while S, S̄ and TRN are still going out.
    this._suHeadRemaining = this.txSyms.length;
    this._su = {
      enc: new V32S.DiffEncoder(lastRot),
      stage: 'rate',
      which: rateWhich,
      pending: [],
      reps: 0,
      lastRot,
    };
  }

  /** The 16 bits of one rate sequence, scrambled then differentially encoded. */
  /**
   * The start-up segment on the wire now, named as §§5.2-5.3 name it. Read-only.
   * The conditioning signal (S, S̄, TRN) is built as one burst with no per-segment
   * cursor, so it reports as TRN — the segment that is 1280 of its 1424 symbols.
   */
  describe() {
    if (this.txSyms.length >= this._suHeadRemaining && this._suHeadRemaining > 0) {
      return { phase: 3, signal: 'TRN' };
    }
    if (this._su) {
      const st = this._su.stage;
      if (st === 'rate') return { phase: 3, signal: { r1: 'R1', r2: 'R2', r3: 'R3' }[this._su.which] || 'R' };
      if (st === 'e') return { phase: 3, signal: 'E' };
      if (st === 'cease') return { phase: 3, signal: 'cease' };
      return { phase: 5, signal: 'data' };
    }
    if (this.txState === 'active') return { phase: 3, signal: 'TRN' };
    return null;
  }

  _suSequence(bits) {
    const out = [];
    for (let k = 0; k < bits.length; k += 2) {
      const q1 = this._scramble(bits[k]);               // first in time
      const q2 = this._scramble(bits[k + 1]);
      out.push(this._su.enc.symbol(q1, q2));
    }
    return out;
  }

  /** Whether the signal this rate stage waits for has arrived (§5.4). */
  _suRateGateOpen() {
    switch (this._su.which) {
      case 'r1': return this._sawPeerS;                 // §5.4.2 "cease transmitting"
      case 'r2': return this._sawR3;                    // §5.4.1 "until R3 is detected"
      default:   return this._sawPeerE;                 // §5.4.2, R3 ends on the peer's E
    }
  }

  /** One symbol of the signal-gated tail, or null when it is finished. */
  _suNext() {
    const su = this._su;
    for (;;) {
      if (su.pending.length) {
        su.lastRot = su.pending.shift();
        const p = V32S.ROT[su.lastRot];
        return { i: p.i * SU_GAIN, q: p.q * SU_GAIN };
      }
      if (!this._suAdvance(su)) return null;
    }
  }

  _suAdvance(su) {
    switch (su.stage) {
      case 'rate':
        // §5.3.2: whatever ends a rate signal, the modem "shall first complete the
        // transmission of the current 16-bit rate sequence" — which is why the gate
        // is tested only at a sequence boundary.
        if (su.reps >= RATE_MIN_REPEATS && this._suRateGateOpen()) {
          // §5.3.2 again: E marks the end of "any rate signal other than R1".
          // R1 is not ended by E — §5.4.2 ends it by ceasing to transmit.
          su.stage = su.which === 'r1' ? 'cease' : 'e';
          return true;
        }
        su.reps++;
        su.pending = this._suSequence(this._rateWord(su.which));
        return true;
      case 'e':
        su.pending = this._suSequence(this._eWord());
        su.stage = 'to-data';
        return true;
      case 'to-data':
        this._suEnd = 'data';
        return false;
      default:
        this._suEnd = 'cease';
        return false;
    }
  }

  /**
   * Table 6/V.32's 16 bits for one of the three rate signals.
   *
   * §5.4.1: "R2 shall exclude rates and operational modes not appearing in the
   * previously received rate signal R1." §5.4.2: "The data rate ... selected by R3
   * shall be within those indicated by R2." Both are honoured by intersecting with
   * what the peer advertised; with one implemented rate the intersection is either
   * that rate or empty, and an empty one is Table 6's call for a GSTN cleardown,
   * which is recorded rather than sent as a lie.
   */
  _rateWord(which) {
    let rates = RATE_SET;
    if (which !== 'r1') {
      const peer = this._peerRates || [];
      rates = RATE_SET.filter((r) => peer.includes(r));
      if (!rates.length) this.rateMismatch = `peer offered [${peer}], this modem runs [${RATE_SET}]`;
    }
    if (which === 'r3') rates = rates.slice(-1);        // §5.4.2: R3 names ONE rate
    return V32S.V32_RATES.build(rates);
  }

  /**
   * Table 7/V.32's sequence E. §5.3.2: its B4-B14 are Table 6's "except that the
   * only data rate and coding to be indicated shall relate to the transmission of
   * scrambled binary ones immediately following signal E" — so it names the single
   * agreed rate, which is what the peer's last rate signal called for.
   */
  _eWord() {
    return V32S.V32_RATES.build([this._rate()], { sequence: 'e' });
  }

  _rate() {
    const peer = this._peerRates || [];
    const common = RATE_SET.filter((r) => peer.includes(r));
    return common.length ? common[common.length - 1] : RATE_SET[RATE_SET.length - 1];
  }

  _startBurst(step) {
    this._resetTxBurst();

    if (step.kind === 'tone') {
      this.scr.fill(0);
      this.txMode = 'tone';
      this.txEndSample = ANS_TONE_SAMPLES;
      this.txState = 'active';
      this._idleSamples = 0;
      return;
    }
    // §5.2's conditioning signal is fixed-length and built here; §5.3's rate
    // signals are signal-gated and run on the continuous path, which is also what
    // lets E flow straight into data mode without the carrier ever dropping.
    this._buildConditioning(step.rate);
    this.txContinuous = true;
    this._suActive = true;
    this.txState = 'active';
    this._idleSamples = 0;
  }

  _maybeStartBurst() {
    if (!this._connectQ.length) return;
    const step = this._connectQ[0];
    if (this._idleSamples < step.gap) return;
    if (step.gate && !this._gateOpen(step.gate)) {
      if (this._idleSamples < GATE_TIMEOUT) return;
    }
    this._startBurst(this._connectQ.shift());
  }

  _gateOpen(gate) {
    if (gate === 'r1') return this._sawR1;              // §5.4.1
    if (gate === 'r2') return this._sawR2;              // §5.4.2
    return true;
  }

  /**
   * §5.4's handover out of E. Data mode continues the SAME carrier and the SAME
   * scrambler; only the number of bits per symbol changes. The differential
   * quadrant state carries over from E's final symbol, which is the same rule §5.3
   * states for the rate signal's own encoder ("initialized using the final symbol
   * of the transmitted TRN segment") applied at the next segment boundary — and it
   * costs the receiver nothing, since differential decoding needs no initial state.
   */
  _enterTxData() {
    this.txPrevY = QUAD_OF_ROT[this._su.lastRot];
    this._dataSyms = 0;
  }

  // Next framed+scrambled TX bit: user bytes, else idle mark — async start/stop
  // framed. §5.4's 128 symbol intervals of scrambled binary ones after E come out
  // of the idle-mark branch, which is what they already are on the wire.
  _txBit() {
    if (this.txFrame) {
      const b = this.txFrame[this.txFramePos++];
      if (this.txFramePos >= this.txFrame.length) this.txFrame = null;
      return this._scramble(b);
    }
    let by = null;
    if (this._dataSyms >= E_TO_DATA_SYMBOLS && this.txByteQ.length) by = this.txByteQ.shift();
    if (by !== null) {
      // start(0), d0..d7 LSB-first, stop(1)
      this.txFrame = [0, by & 1, (by >> 1) & 1, (by >> 2) & 1, (by >> 3) & 1,
                      (by >> 4) & 1, (by >> 5) & 1, (by >> 6) & 1, (by >> 7) & 1, 1];
      this.txFramePos = 1;
      return this._scramble(0);
    }
    return this._scramble(1);     // idle mark (fills the continuous carrier)
  }

  // Ensure txSyms covers through ABSOLUTE symbol index k (txSyms[0] == symbol
  // this.txSymBase). Only the continuous data flow generates via the bit path;
  // the finite pre-roll bursts pre-fill txSyms directly.
  _ensureSymbols(k) {
    if (!this.txContinuous) return;
    while (this.txSymBase + this.txSyms.length <= k) {
      if (this._suActive) {
        const p = this._suNext();
        if (p) { this.txSyms.push(p); continue; }
        this._suActive = false;
        if (this._suEnd === 'cease') {
          // §5.4.2's "cease transmitting". Stop being continuous and let the fixed-
          // burst end condition flush the shaper, so the carrier goes down cleanly.
          this.txContinuous = false;
          this.txEndSample = Math.ceil((this.txSyms.length + SPAN / 2) * SPS);
          return;
        }
        this._enterTxData();
      }
      const Q1 = this._txBit(), Q2 = this._txBit(), Q3 = this._txBit(), Q4 = this._txBit();
      // Table 1/V.32's phase quadrant change — the SAME table the rate signals
      // use, which is what its title says: "for 4800 bit/s and for nonredundant
      // coding at 9600 bit/s". It is not a mod-4 add of the dibit: 00 is +90° and
      // 01 is 0°, so the two are transposed relative to one.
      this.txPrevY = (this.txPrevY + V32S.PHASE_CHANGE[(Q1 << 1) | Q2]) & 3;
      this.txSyms.push(dataPoint(this.txPrevY, Q3, Q4));
      this._dataSyms++;
    }
  }

  generateAudio(count) {
    const out = new Float32Array(count);
    if (this.txState !== 'active') {
      this._maybeStartBurst();
      if (this.txState !== 'active') { this._idleSamples += count; return out; }
    }
    if (this.txMode === 'tone') {
      for (let c = 0; c < count; c++) {
        const n = this.txN++;
        if (this.txEndSample >= 0 && n >= this.txEndSample) { this.txState = 'idle'; this._resetTxBurst(); break; }
        out[c] = Math.sin(2 * Math.PI * ANS_TONE_FREQ * n / SR) * ANS_TONE_AMP;
      }
      return out;
    }
    for (let c = 0; c < count; c++) {
      const n = this.txN++;                       // monotonic: carrier phase never jumps
      if (!this.txContinuous && this.txEndSample >= 0 && n >= this.txEndSample) {
        this.txState = 'idle'; this._resetTxBurst(); break;
      }
      const st = n / SPS;                          // absolute symbol time
      const klo = Math.max(0, Math.ceil(st - SPAN / 2)), khi = Math.floor(st + SPAN / 2);
      this._ensureSymbols(khi);
      let ai = 0, aq = 0;
      for (let k = Math.max(klo, this.txSymBase); k <= khi; k++) {
        const s = this.txSyms[k - this.txSymBase];
        if (!s) break;
        const p = rrc(st - k); ai += s.i * p; aq += s.q * p;
      }
      const ph = 2 * Math.PI * FC * n / SR;
      out[c] = (ai * Math.cos(ph) - aq * Math.sin(ph)) * TX_GAIN;
    }
    // Continuous flow: drop shaped-out leading symbols so txSyms stays flat.
    // Only txSymBase moves; txN (carrier phase) is untouched.
    if (this.txContinuous) {
      const oldest = Math.floor(this.txN / SPS - SPAN) - 1;
      const drop = oldest - this.txSymBase;
      if (drop > 512) { this.txSyms.splice(0, drop); this.txSymBase += drop; }
    }
    return out;
  }

  // ─── RX ────────────────────────────────────────────────────────────────────
  _resetRx() {
    this.rx = [];
    this.rxBase = 0;              // flow-local absolute sample index of rx[0]
    this.acq = false;
    this.base = 0;                // fractional sample of symbol 0 of the flow
    this.symIdx = 0;
    this.des = new Array(23).fill(0);
    this.gr = 1; this.gi = 0; this.g2 = 1;   // complex channel estimate
    this.rxPrevY = 0;
    this.outbits = [];
    this.uState = 'hunt'; this.uArmed = false; this.uMarks = 0; this.uBit = 0; this.uByte = 0;
    // Which signal this burst is. Every burst in this procedure begins with §5.2's
    // conditioning signal, and the one that ends in E flows into data mode without
    // the carrier dropping — so the phase changes on E, not on a silence.
    this.rxPhase = this._sawPeerE ? 'data' : 'startup';
    this._sRef = null;            // {base, idx, refs[4]} — the timing lock and A/B/C/D
    this._suRx = {
      dec: new V32S.DiffDecoder(),
      framer: new V32S.RateFramer(V32S.V32_RATES),
      runKind: null, runLen: 0, lastRot: -1,
    };
  }

  _bb(n) { const ph = 2 * Math.PI * FC * n / SR; const s = this.rx[n - this.rxBase]; return [s * Math.cos(ph) * 2, -s * Math.sin(ph) * 2]; }
  _sym(pos) {
    const end = this.rxBase + this.rx.length - 1;
    const nlo = Math.max(this.rxBase, Math.ceil(pos - SPAN / 2 * SPS));
    const nhi = Math.min(end, Math.floor(pos + SPAN / 2 * SPS));
    let ai = 0, aq = 0;
    for (let n = nlo; n <= nhi; n++) { const b = this._bb(n); const p = rrc((n - pos) / SPS); ai += b[0] * p; aq += b[1] * p; }
    return [ai, aq];
  }

  receiveAudio(f32) {
    for (let i = 0; i < f32.length; i++) {
      const s = f32[i];
      this.rxLevel += RX_A * (Math.abs(s) - this.rxLevel);
      if (this.rxLevel > RX_HI) { this.rxOn = true; this.rxLow = 0; }
      else if (this.rxLevel < RX_LO && this.rxOn) { this.rxLow++; }
      if (this.rxOn) this.rx.push(s);
      if (this.rxOn && this.rxLow > RX_HANG) {
        // Carrier gone. In this procedure that is §5.4.2's "cease transmitting"
        // between R1 and the second conditioning signal; after data mode it is a
        // hangup. R1 and R3 arrive in those two different transmissions, so the
        // stage advances HERE — advancing on the first detection instead would take
        // the second repetition of R1 for R3.
        this._process();
        if (this.role === 'originate' && this._rxStage === 'r1' && this._sawR1) this._rxStage = 'r3';
        this.rxOn = false;
        this._resetRx();
      }
    }
    if (this.rxOn) this._process();
  }

  /**
   * §5.2's conditioning signal, received.
   *
   * S and S̄ have the SAME differential signature — both alternate by a quarter turn,
   * since C and D are A and B reversed — so a differential detector cannot separate
   * them and the reference has to be ABSOLUTE. Two reference points taken from S
   * give all four states, because A, B, C, D are one rotation orbit: C and D are the
   * negations of A and B.
   *
   * WHICH of the two the even-indexed samples landed on is the question §10.1.3.7
   * answers for V.34 and that V.32 answers differently: Table 1 makes A → B a +90°
   * step, so the SIGN of the step inside S names the parity. Getting it wrong is not
   * a harmless 90° error — it reflects the labelling rather than rotating it, which
   * negates every differential decode and would leave the rate signal never
   * conforming.
   *
   * The scan is forward-only (`_sRef.idx` only advances) for the reason V90's
   * `_huntSd` gives: rescanning the buffer on every chunk is quadratic, and with a
   * one-second answer tone in front of it that is slow enough to look like a hang.
   */
  _huntStartup() {
    const CONFIRM = 16;
    if (!this._sRef) {
      if (this.rx.length < Math.ceil((CONFIRM + 4) * SPS + SPAN * SPS)) return;
      let onset = -1, e = 0;
      for (let n = 0; n < this.rx.length; n++) {
        const b = this._bb(n); const m = Math.hypot(b[0], b[1]);
        e = 0.85 * e + 0.15 * m;
        if (e > 0.04) { onset = Math.max(0, n - 4); break; }
      }
      if (onset < 0) return;
      // S is constant-modulus, so maximising summed symbol magnitude finds the
      // ISI-free instant exactly as the old preamble search did.
      let best = onset, bestScore = -1;
      for (let bo = Math.max(0, onset - 2 * SPS); bo <= onset + 2 * SPS; bo += SPS / 64) {
        let sc = 0;
        for (let k = 0; k < 12; k++) { const s = this._sym(bo + k * SPS); sc += Math.hypot(s[0], s[1]); }
        if (sc > bestScore) { bestScore = sc; best = bo; }
      }
      // Confirm this really is S before adopting a reference from it: constant
      // modulus, and consecutive symbols a quarter turn apart. Anything else — a
      // truncated tone, a V.21 tail — fails here rather than producing a reference
      // that a later coincidence fires against.
      const sIQ = [];
      for (let j = 0; j < CONFIRM; j++) sIQ.push(this._sym(best + j * SPS));
      const mags = sIQ.map((s) => Math.hypot(s[0], s[1]));
      const mAvg = mags.reduce((t, m) => t + m, 0) / mags.length;
      if (mAvg < 1e-6) return;
      for (const m of mags) if (Math.abs(m - mAvg) > 0.35 * mAvg) return;
      for (let j = 1; j < CONFIRM; j++) {
        let d = Math.atan2(sIQ[j][1], sIQ[j][0]) - Math.atan2(sIQ[j - 1][1], sIQ[j - 1][0]);
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        if (Math.abs(Math.abs(d) - Math.PI / 2) > 0.5) return;
      }
      // Each parity averages to one of S's two states as the channel presents it.
      const acc = [[0, 0], [0, 0]], cnt = [0, 0];
      for (let j = 0; j < CONFIRM; j++) { const p = j & 1; acc[p][0] += sIQ[j][0]; acc[p][1] += sIQ[j][1]; cnt[p]++; }
      let a = [acc[0][0] / cnt[0], acc[0][1] / cnt[0]];
      let b = [acc[1][0] / cnt[1], acc[1][1] / cnt[1]];
      // Table 1: A to B is +90°. A negative cross product means the even samples
      // landed on B, so the two are the other way round.
      if (a[0] * b[1] - a[1] * b[0] < 0) { const t = a; a = b; b = t; }
      this._sRef = {
        base: best, idx: CONFIRM,
        refs: [a, b, [-a[0], -a[1]], [-b[0], -b[1]]],   // A, B, C, D
      };
    }

    // Walk forward, classifying every symbol against the four states. On this
    // transport the clock does not drift, so the timing found on S is still the
    // timing 1500 symbols later, which is what lets the whole conditioning signal,
    // the rate signals, E and then data mode run on this one lock.
    const r = this._sRef;
    const end = this.rxBase + this.rx.length - 1;
    while (this.rxPhase === 'startup') {
      const pos = r.base + r.idx * SPS;
      if (pos + SPAN / 2 * SPS >= end) return;
      const s = this._sym(pos);
      r.idx++;
      let bestRot = 0, bestDot = -Infinity;
      for (let rot = 0; rot < 4; rot++) {
        const ref = r.refs[rot];
        const dot = s[0] * ref[0] + s[1] * ref[1];
        if (dot > bestDot) { bestDot = dot; bestRot = rot; }
      }
      this._suSymbol(bestRot);
    }
  }

  /**
   * One classified start-up symbol: track the S / S̄ alternation §5.4 gates on, and
   * demodulate the differentially encoded bit stream the rate signals ride.
   *
   * S alternates between rotations 0 and 1 and S̄ between 2 and 3; TRN is scrambled
   * and reaches neither for long, which is why an alternation of a minimum LENGTH is
   * what separates a signal from training that happens to land on two values.
   *
   * The descrambler is fed from the differential decode throughout, including
   * across S, S̄ and TRN's first 256 symbols where those bits are not the
   * transmitter's scrambler output at all. That is sound and not sloppy: the
   * descrambler is MULTIPLICATIVE, so 23 correct received bits is all it needs, and
   * the last of those wrong bits is a thousand symbols before the first rate
   * sequence. §5.2.3's first 256 states carry only the first bit of each dibit, so
   * there is no other reading available.
   */
  _suSymbol(rot) {
    const p = this._suRx;
    const kind = (rot === V32S.A || rot === V32S.B) ? 's'
               : (rot === V32S.C || rot === V32S.D) ? 'sbar' : null;
    if (kind && kind === p.runKind && rot !== p.lastRot) p.runLen++;
    else { p.runKind = kind; p.runLen = 1; }
    p.lastRot = rot;
    if (p.runLen === RUN_CONFIRM && p.runKind === 's') this._sawPeerS = true;

    const ib = p.dec.bits(rot);
    if (!ib) return;
    for (const bit of ib) {
      const reg = this.des;
      const ob = bit ^ reg[this._rxTap] ^ reg[22];
      reg.unshift(bit); reg.pop();
      const hit = p.framer.push(ob);
      if (hit) this._suSequenceSeen(hit, rot);
    }
  }

  /** A conforming 16-bit sequence: §5.4's own dispatch, by which one is due. */
  _suSequenceSeen(hit, lastRot) {
    if (hit.kind === 'e') {
      this._sawPeerE = true;
      this._enterRxData(lastRot);
      return;
    }
    this._peerRates = hit.advertised;
    this.peerRate = hit.best;
    if (this.role === 'answer') { this._sawR2 = true; return; }
    if (this._rxStage === 'r1') this._sawR1 = true; else this._sawR3 = true;
  }

  /**
   * §5.4's handover out of E, the mirror of _enterTxData. Nothing is re-acquired:
   * the timing lock is S's, the channel estimate is S's state A as the channel
   * presented it, and the descrambler has been running on correct bits since the
   * first rate sequence. That is what makes the data burst's own preamble — 72
   * invented symbols of alternating and constant corner points — unnecessary, and
   * it is gone.
   */
  _enterRxData(lastRot) {
    const r = this._sRef;
    const a = r.refs[V32S.A];
    const A0 = V32S.ROT[V32S.A];
    const di = A0.i * SU_GAIN, dq = A0.q * SU_GAIN;
    const d2 = di * di + dq * dq;
    this.gr = (a[0] * di + a[1] * dq) / d2;
    this.gi = (a[1] * di - a[0] * dq) / d2;
    this.g2 = this.gr * this.gr + this.gi * this.gi || 1e-9;
    this.base = r.base;
    this.symIdx = r.idx;                       // r.idx is past E's final symbol
    this.rxPrevY = QUAD_OF_ROT[lastRot];
    this.acq = true;
    this.rxPhase = 'data';
    if (!this._ready) {
      this._ready = true;
      this.emit('ready', { bps: this.bps, remoteDetected: true });
    }
  }

  _process() {
    // §5.2's conditioning signal is not the data burst. TRN is over a thousand
    // symbols of scrambled states, so handing it to a data slicer produces bytes
    // out of training; the phase split is what keeps them apart.
    if (this.rxPhase === 'startup') {
      this._huntStartup();
      if (this.rxPhase === 'startup') return;
    }

    // Continuous decode of all fully-buffered symbols.
    while (true) {
      const pos = this.base + this.symIdx * SPS;
      const end = this.rxBase + this.rx.length - 1;
      if (pos + SPAN / 2 * SPS >= end) break;
      const s = this._sym(pos);
      // derotate + gain-normalise by the channel estimate: x = y·conj(g)/|g|²
      const xI = (s[0] * this.gr + s[1] * this.gi) / this.g2;
      const xQ = (s[1] * this.gr - s[0] * this.gi) / this.g2;
      const { rot, Q3, Q4 } = dataBits(level(xI), level(xQ));
      // The inverse of Table 1's phase quadrant change, which is not the same as
      // subtracting a dibit — see the transmitter.
      const d = V32S.CHANGE_TO_DIBIT[(rot - this.rxPrevY) & 3];
      this.rxPrevY = rot;
      const bits = [(d >> 1) & 1, d & 1, Q3, Q4];
      for (const bit of bits) { const r = this.des; const ob = bit ^ r[this._rxTap] ^ r[22]; r.unshift(bit); r.pop(); this.outbits.push(ob); }
      this.symIdx++;
      this._uartConsume();

      // Trim consumed samples to keep the continuous RX buffer flat. Preserve
      // rxBase so the carrier phase (derived from the flow-local index) is exact.
      const drop = Math.floor(this.base + (this.symIdx - SPAN) * SPS) - this.rxBase;
      if (drop > 512) { this.rx.splice(0, drop); this.rxBase += drop; }
    }
  }

  // Async start/stop deframer over the descrambled bit stream.
  _uartConsume() {
    while (this.outbits.length) {
      const bit = this.outbits.shift();
      if (this.uState === 'hunt') {
        if (bit === 1) { if (!this.uArmed && this.uMarks < 255 && ++this.uMarks >= UART_ARM_MARKS) this.uArmed = true; }
        else if (this.uArmed) { this.uState = 'data'; this.uBit = 0; this.uByte = 0; }
      } else if (this.uState === 'data') {
        this.uByte |= (bit << this.uBit); this.uBit++;
        if (this.uBit === 8) this.uState = 'stop';
      } else {
        if (bit === 1) { this._rxByte(this.uByte & 0xff); this.uState = 'hunt'; }
        else { this.uState = 'hunt'; this.uArmed = false; this.uMarks = 0; }
      }
    }
  }

  // One deframed byte. The rate signals are §5.3's own 16-bit sequences on the
  // wire now, not reserved bytes in this stream, so nothing here is stripped.
  _rxByte(b) { this.emit('data', Buffer.from([b])); }
}

// BASE, dataPoint and dataBits are exported for tools/tests/v32-map-check.js, so
// that the harness holds Table 1 and Table 3 against the map this class actually
// transmits rather than against a second copy of it.
module.exports = { V32, BASE, dataPoint, dataBits };
