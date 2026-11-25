'use strict';

/**
 * V32Preface — the half-duplex opening of ITU-T V.32 (11/88) §5.4, shared by
 * V32.js and V32bis.js (whose §6 repeats it word for word).
 *
 * Before either modem sends its receiver conditioning signal, the two exchange
 * tones. The answer modem alternates carrier states A and C (AC), which puts lines
 * at 600 and 3000 Hz and nothing at 1800. The call modem repeats state A (AA),
 * which is a bare 1800 Hz carrier. Each turns its signal over (a phase reversal)
 * in answer to the other's, 64 ± 2 symbol periods after hearing it, and each times
 * the exchange:
 *
 *   §5.4.1 call modem   silent → answer tone 1 s (or the tones, note 1) → AA.
 *                       First reversal in 600/3000 → start the counter/timer, and
 *                       64 ± 2 T later CC. Second reversal → stop it (NT), cease.
 *                       On R1, S for NT, then the conditioning signal.
 *   §5.4.2 answer modem V.25 answer sequence → AC for an even count ≥ 128 T with
 *                       1800 Hz heard for 64 T → start the timer, CA. Reversal at
 *                       1800 → stop it (MT), and after a state A, 64 ± 2 T later,
 *                       AC. Amplitude drop at 1800 → silent 16 T, then the
 *                       conditioning signal and R1.
 *
 * Each modem listens where its own signal is NOT — the call modem at 600/3000
 * while it sends 1800, the answer modem at 1800 while it sends 600/3000 — so its
 * own echo on a 2-wire line cannot be taken for the far end. That is the
 * Recommendation's design, and BinModem relies on it the same way.
 *
 * The tone measurement is a 20-sample moving average of the signal mixed down to
 * baseband at the tone. 20 samples is 2.5 ms, whose nulls fall every 400 Hz — so
 * at each of the three frequencies the other two (1200 and 2400 Hz away) are
 * removed exactly. It is FIR, so its delay is a constant (L-1)/2 samples, which is
 * what lets a reversal be timed to the sample rather than to the detector.
 *
 * Timing. A modem's TX and RX run on one sample clock here: received sample n
 * arrived when transmitted sample n left. Symbol k of a burst that began at
 * sample S0 is centred at S0 + k·SPS, so the boundary before it is at
 * S0 + (k − ½)·SPS, and a reversal heard at sample r is answered at the boundary
 * nearest r + 64·SPS. The transmitter generates ahead of the receiver by up to a
 * block, which on the 20 ms blocks this repo uses is 48 symbols — inside the 64.
 * If it is ever later than that, the turnaround goes out at the first symbol not
 * yet generated and `late` records by how many symbols — which the far end cannot
 * tell from a longer line.
 *
 * Arming. A reversal is looked for only once our own turn has been generated,
 * and not within ECHO_GUARD symbols of received signal after that: on a 2-wire
 * line our own turn comes back off the hybrid, and its transient splashes into
 * the band we listen in. That is all the guard is for, and it is counted on the
 * receive clock FROM THE MOMENT THE TURN WAS GENERATED (`_armAt`), not from the
 * turn's place on the transmit clock. The two clocks each count from their own
 * start and ModemDSP's real-time pump sends in catch-up bursts, so between them
 * they wander by ±48 T; BinModem's RESPONSE-wide window, or any window placed on
 * the transmit grid, missed the reply often enough to deadlock dsptest2 one run
 * in three. In processing order the reply always follows the turn.
 */

const SR = 8000;
const A = 0, C = 2;                  // V32Startup's rotation indices for states A and C

const MA_LEN = 20;                   // 2.5 ms: nulls every 400 Hz (see header)
const LAG = 24;                      // reversal comparison distance, samples
const LEVEL_A = 0.02;                // line level one-pole (mean |x|)
const FLOOR = 1e-3;                  // below this the line is silent
const STAND = 0.3;                   // a line "stands" at this fraction of the level
const SIDE_STAND = 0.2;              // the weaker of 600/3000, for the call modem
// A pure TONE stands at this, for the two detections that look for one alone (the
// answer modem's AA, the call modem's answer tone). On the line's mean |x| a tone
// reads 1.57, one under an equal echo of our 600/3000 reads 1.16, white noise reads
// 0.55, and a 2100 Hz tone on the 1800 watch 0.47. At STAND's 0.3, line noise
// passed for AA, the answer modem counted 64 T before the call modem had sent any,
// and its CA came early enough that BinModem never saw the reversal.
const TONE_STAND = 0.8;
const RESPONSE = 64;                 // §5.4.1/§5.4.2: 64 ± 2 symbol periods
const ECHO_GUARD = 8;                // symbols after our own turn before a reversal counts
const HEARD = 64;                    // §5.4.2's "for 64 symbol periods"
// The answer modem's hold on AA before its CA: §5.4.2's 64 symbol periods is the
// least it may hear the tone for, and BinModem's call modem needs more. It starts
// its own reversal detector afresh once it is in AA and counts 64 T of our tones
// standing before it will believe a reversal; and it counts them standing only
// once they stand above its decaying envelope of our answer tone. A CA at 64 T was
// missed between 3 and 8 dB of loss; at 96, with our answer tone at −10 dBm0 and
// no V.8 before it, at 0 and 3 dB. 160 is the least that makes every loss from 0
// to 14 dB work both ways through the bridge, and 192 leaves room above it.
const AA_HEARD = 192;
const MIN_AC = 128;                  // §5.4.2's "greater than or equal to 128"
const ANSWER_TONE_S = 1.0;           // §5.4.1's "at least 1 s"
const REFRACTORY = 16;               // symbols after a reversal before another
const DROP = 4;                      // §5.4.2's amplitude drop: below peak / DROP
const DROP_HOLD = 8;                 // ... for this many symbols

/** One tone, measured at baseband: amplitude, and reversals with their instants. */
class ToneWatch {
  constructor(freq) {
    this.w = 2 * Math.PI * freq / SR;
    this.br = new Float64Array(MA_LEN); this.bi = new Float64Array(MA_LEN);
    this.sr = 0; this.si = 0; this.at = 0;
    this.hr = new Float64Array(LAG + 1); this.hi = new Float64Array(LAG + 1);
    this.zr = 0; this.zi = 0; this.n = -1; this.filled = 0;
  }

  push(x, n) {
    const ph = this.w * n;
    const mr = x * Math.cos(ph), mi = -x * Math.sin(ph);
    this.sr += mr - this.br[this.at]; this.si += mi - this.bi[this.at];
    this.br[this.at] = mr; this.bi[this.at] = mi;
    this.at = (this.at + 1) % MA_LEN;
    // ×2: a tone a·cos(ωn+φ) reads as amplitude a.
    this.zr = 2 * this.sr / MA_LEN; this.zi = 2 * this.si / MA_LEN;
    this.n = n;
    const h = n % (LAG + 1);
    this.hr[h] = this.zr; this.hi[h] = this.zi;
    if (this.filled < LAG + 1) this.filled++;
  }

  get amp() { return Math.hypot(this.zr, this.zi); }

  /**
   * The line instant of a reversal completing now, or null. A reversal is the
   * phasor now pointing against the phasor LAG samples ago; its instant is where
   * the projection onto the earlier phasor crossed zero, less the moving
   * average's (L−1)/2 delay.
   */
  reversal(minAmp) {
    if (this.filled < LAG + 1) return null;
    const p = (this.n - LAG) % (LAG + 1);
    const pr = this.hr[p], pi = this.hi[p];
    const pm = Math.hypot(pr, pi), zm = this.amp;
    if (pm < minAmp || zm < minAmp) return null;
    if (this.zr * pr + this.zi * pi > -0.5 * pm * zm) return null;
    let prev = pm * pm;
    for (let m = this.n - LAG + 1; m <= this.n; m++) {
      const h = m % (LAG + 1);
      const proj = this.hr[h] * pr + this.hi[h] * pi;
      if (proj <= 0) return m - 1 + prev / (prev - proj) - (MA_LEN - 1) / 2;
      prev = proj;
    }
    return this.n - (MA_LEN - 1) / 2;
  }
}

/** What both roles share: the level, the sample clock, and the burst's symbol grid. */
class Preface {
  constructor(sps) {
    this.sps = sps;
    this.level = 0;
    this.n = -1;                  // last received sample
    this.s0 = null;               // absolute sample of burst symbol 0
    this.lastK = -1;              // last symbol handed to the transmitter
    this.late = 0;                // worst turnaround lateness, symbols
    this.huntArmed = false;       // the receiver may start hunting the far end's S
    this.signal = 'silent';
    this.events = [];             // [{n, what}] for instrumentation and tests
    this._refractory = -Infinity;
    this._armAt = Infinity;       // receive sample from which a reply may count
  }

  /** The TX burst carrying the tones began at absolute sample `s0`. */
  begin(s0) { this.s0 = s0; }

  _level(x) {
    this.level += LEVEL_A * (Math.abs(x) - this.level);
    return this.level;
  }

  _stands(w, frac = STAND) { return this.level > FLOOR && w.amp > frac * this.level; }

  _note(what) { this.events.push({ n: this.n, what }); }

  /** The symbol boundary nearest `target` (an absolute sample), never one already sent. */
  _boundaryAt(target, even = false) {
    let k = Math.round((target - this.s0) / this.sps + 0.5);
    if (even && (k & 1)) k++;
    const first = this.lastK + 1 + (even && ((this.lastK + 1) & 1) ? 1 : 0);
    if (k < first) { this.late = Math.max(this.late, first - k); k = first; }
    return k;
  }

  /** Our turn has just been generated: a reply may count ECHO_GUARD received symbols from now. */
  _arm() { this._armAt = this.n + ECHO_GUARD * this.sps; }

  /** Absolute sample of the boundary before burst symbol k. */
  _lineTime(k) { return this.s0 + (k - 0.5) * this.sps; }

  _reversalOf(watches, minAmp) {
    if (this.n < this._refractory) return null;
    for (const w of watches) {
      const r = w.reversal(minAmp);
      if (r !== null) { this._refractory = this.n + REFRACTORY * this.sps; return r; }
    }
    return null;
  }
}

/** §5.4.1 (V.32bis §6.1): the call modem. */
class CallPreface extends Preface {
  constructor(sps) {
    super(sps);
    this.low = new ToneWatch(600);
    this.high = new ToneWatch(3000);
    this.carrier = new ToneWatch(1800);
    this.answer = new ToneWatch(2100);
    this.state = 'listen';        // listen → AA → CC → wait → done
    this.wantsTx = false;
    this._answerHeld = 0;
    this._toneHeld = 0;
    this._tonesHeard = false;     // 600/3000 held for HEARD symbols, latched
    this._r1 = null;              // the first reversal's line instant
    this._ccAt = null;            // CC's first symbol
    this.nt = 0;                  // §5.4.1's counter/timer, symbols
  }

  /** V.8 ran first: its ANSam was the answer tone, heard in full. */
  skipListen() { if (this.state === 'listen') { this.state = 'AA'; this.wantsTx = true; this._note('V.8 — straight to AA'); } }

  rx(x, n) {
    this.n = n;
    this._level(x);
    for (const w of [this.low, this.high, this.carrier, this.answer]) w.push(x, n);
    const tones = this.level > FLOOR &&
      Math.min(this.low.amp, this.high.amp) > SIDE_STAND * this.level &&
      Math.min(this.low.amp, this.high.amp) > this.answer.amp;
    this._toneHeld = tones ? this._toneHeld + 1 : 0;
    if (this._toneHeld >= HEARD * this.sps) this._tonesHeard = true;

    switch (this.state) {
      case 'listen': {
        this._answerHeld = this._stands(this.answer, TONE_STAND) ? this._answerHeld + 1 : 0;
        // §5.4.1, or note 1: the tones alone, where the answer tone was truncated.
        if (this._answerHeld >= ANSWER_TONE_S * SR || this._toneHeld >= HEARD * this.sps) {
          this.state = 'AA'; this.wantsTx = true;
          this._note(this._toneHeld ? 'heard 600/3000 — AA' : 'heard the answer tone — AA');
        }
        break;
      }
      case 'AA': {
        // "conditioned to detect one of two incoming tones ... and subsequently to
        // detect a phase reversal in that tone": a tone first, then its reversal.
        // Heard for 64 T at some point — not unbroken up to now. The reversal itself
        // takes the moving-average phasor through zero, and at some sub-sample
        // alignments that dips the tone under SIDE_STAND for a few samples, which
        // reset the hold just before reversal() could report: a far clock 100 ppm
        // fast made our own answer modem's reversal invisible. reversal() still
        // insists both phasors stand.
        if (this.s0 === null || !this._tonesHeard) break;
        const r = this._reversalOf([this.low, this.high], SIDE_STAND * this.level);
        if (r === null) break;
        this._r1 = r;
        this._ccAt = this._boundaryAt(r + RESPONSE * this.sps);
        this.state = 'AA→CC';
        this._note('first reversal');
        break;
      }
      case 'AA→CC':
      case 'CC': {
        // The second reversal answers our CC: looked for once CC is out, past the
        // echo guard (see the header).
        if (this.state !== 'CC' || n < this._armAt) break;
        const r = this._reversalOf([this.low, this.high], SIDE_STAND * this.level);
        if (r === null) break;
        this.nt = Math.max(2, Math.round((r - this._r1) / this.sps));
        this.state = 'cease';
        this._note(`second reversal — NT ${this.nt}`);
        break;
      }
      case 'wait':
        // The answer modem goes on alternating until it hears us stop, is silent
        // for 16 T, then sends S — and S is the first signal of the exchange with
        // a line at 1800 alongside 600 and 3000.
        if (this._stands(this.carrier)) { this.state = 'done'; this.huntArmed = true; this._note('S — hunting'); }
        break;
      default:
    }
  }

  /** Rotation for burst symbol k, or null to cease. */
  rot(k) {
    this.lastK = k;
    if (this.state === 'AA→CC' && k >= this._ccAt) { this.state = 'CC'; this._arm(); }
    if (this.state === 'cease') { this.state = 'wait'; this.signal = 'silent'; return null; }
    if (this.state === 'wait' || this.state === 'done') return null;
    this.signal = this.state === 'CC' ? 'CC' : 'AA';
    return this.state === 'CC' ? C : A;
  }
}

/** §5.4.2 (V.32bis §6.2): the answer modem. */
class AnswerPreface extends Preface {
  /** @param {number} [minAc] AC's least length, symbols: MIN_AC, or RETRAIN_AC in a retrain */
  constructor(sps, minAc = MIN_AC) {
    super(sps);
    this.minAc = minAc;
    this.carrier = new ToneWatch(1800);
    this.state = 'AC';            // AC → CA → AC2 → done
    this.wantsTx = true;
    this._held = 0;
    this._peak = 0;
    this._caAt = null;
    this._acAt = null;
    this._dropHeld = 0;
    this.mt = 0;                  // §5.4.2's counter/timer, symbols
  }

  rx(x, n) {
    this.n = n;
    this._level(x);
    this.carrier.push(x, n);
    const tone = this._stands(this.carrier, TONE_STAND);
    this._held = tone ? this._held + 1 : 0;
    if (this.state !== 'done') this._peak = Math.max(this._peak, this.carrier.amp);

    if (this.state === 'CA' && n >= this._armAt) {
      const r = this._reversalOf([this.carrier], STAND * this.level);
      if (r !== null) {
        this.mt = Math.max(2, Math.round((r - this._lineTime(this._caAt)) / this.sps));
        // "after transmitting a state A": CA's pairs are C,A, so the turn back to
        // AC falls on a pair boundary — an even symbol, given CA began on one.
        this._acAt = this._boundaryAt(r + RESPONSE * this.sps, true);
        this.state = 'CA→AC';
        this._note(`reversal — MT ${this.mt}`);
      }
    } else if (this.state === 'AC2') {
      this._dropHeld = this.carrier.amp < this._peak / DROP ? this._dropHeld + 1 : 0;
      if (this._dropHeld >= DROP_HOLD * this.sps) {
        this.state = 'cease'; this.huntArmed = true;
        this._note('amplitude drop');
      }
    }
  }

  rot(k) {
    this.lastK = k;
    switch (this.state) {
      case 'AC':
        if (k >= this.minAc && !(k & 1) && this._held >= AA_HEARD * this.sps) {
          this.state = 'CA'; this._caAt = k; this._arm(); this._note('CA');
        }
        break;
      case 'CA→AC':
        if (k >= this._acAt) this.state = 'AC2';
        break;
      case 'cease':
        this.state = 'done'; this.signal = 'silent';
        return null;
      case 'done':
        return null;
      default:
    }
    // AC: A on even symbols. CA (from an even symbol): C on even. AC2 (from an
    // even symbol, after CA's A): A on even again.
    const ca = this.state === 'CA' || this.state === 'CA→AC';
    this.signal = ca ? 'CA' : 'AC';
    return ((k & 1) === 0) !== ca ? A : C;
  }
}

// §5.5.1 / §5.5.2: the far end's retrain signal must be heard "for more than 128
// symbol intervals" before this end answers it.
const RETRAIN_HELD = 128;
// The answer modem's AC in a retrain. §5.5.2 asks "not less than 128"; the call
// modem has only just turned to AA and has to hear our tones stand before it will
// take a reversal in them, and at 128 BinModem's never did.
const RETRAIN_AC = 256;
// What is left at the frequency the retrain signal does NOT use, as a fraction of
// what it does use. Data is a band and puts energy at all three; AC has none at
// 1800 and AA none at 600 or 3000.
const RETRAIN_CLEAR = 0.3;

/**
 * §5.5's cue, watched for in data. The call modem retrains on the answer modem's
 * AC (600 and 3000 Hz, nothing at 1800), the answer modem on the call modem's AA
 * (a bare 1800). Each listens where its own data is not a tone, so neither its
 * own echo nor the far end's data reads as the cue.
 */
class RetrainWatch {
  constructor(role, sps) {
    this.role = role;
    this.sps = sps;
    this.level = 0;
    this.low = new ToneWatch(600); this.high = new ToneWatch(3000); this.carrier = new ToneWatch(1800);
    this.held = 0;
  }

  /** One received sample; true once the cue has been held for RETRAIN_HELD symbols. */
  push(x, n) {
    this.level += LEVEL_A * (Math.abs(x) - this.level);
    for (const w of [this.low, this.high, this.carrier]) w.push(x, n);
    const side = Math.min(this.low.amp, this.high.amp), mid = this.carrier.amp;
    const cue = this.level > FLOOR && (this.role === 'originate'
      ? side > SIDE_STAND * this.level && mid < RETRAIN_CLEAR * side
      : mid > TONE_STAND * this.level && Math.max(this.low.amp, this.high.amp) < RETRAIN_CLEAR * mid);
    this.held = cue ? this.held + 1 : 0;
    return this.held > RETRAIN_HELD * this.sps;
  }
}

module.exports = { ToneWatch, CallPreface, AnswerPreface, RetrainWatch, RESPONSE, MIN_AC, RETRAIN_HELD, RETRAIN_AC };
