'use strict';

/*!
 * @license
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Copyright (C) 2026 Joseph Quinn
 *
 * The canceller's structure and constants (a near run of taps, a far run placed
 * by a search of what the near run leaves, adaptation only while told, a training
 * that removed under a decibel undone, the quarter step) are ported from BinModem
 * <https://github.com/CasualArclamp/BinModem>, crates/dsp/src/echo.rs and
 * crates/datapump/src/v32/startup.rs, at commit
 * 623f935e28fe6de3a8a4f41492feb46e1bb86c3a of <https://github.com/synexo/BinModem>.
 * Copyright the BinModem authors; GPL-3.0-or-later. See NOTICE.
 */

/**
 * EchoCanceller.js — subtracts this modem's own transmit from what it receives.
 *
 * On a 2-wire line a modem hears itself. The hybrid that joins the line's one pair
 * to separate transmit and receive paths is never perfectly balanced, so part of
 * what goes out comes straight back; and the network beyond reflects again from
 * wherever its impedance changes, tens of milliseconds later. V.21, V.22 and
 * V.22bis escape this by putting the two directions in different bands. V.32,
 * V.32bis and V.34 put both in the same band at the same time: no filter can
 * separate them, and the echo has to be subtracted.
 *
 * Subtracting it is possible because the echo is of a signal we know exactly: we
 * sent it. What is unknown is only what the line did to it, which is a filter, and
 * a filter can be learned. The structure is BinModem's `dsp/src/echo.rs`, the
 * reference it is ported from: runs of NLMS taps on the passband
 * samples, driven by our own transmit history.
 *   - A NEAR run at lag 0, always: the hybrid, which reflects at once.
 *   - A FAR run, placed by a search (BinModem's EchoFinder), because the network's
 *     reflection is nowhere near the hybrid's and one filter spanning both would
 *     be hundreds of taps modelling nothing. The first FIND_SAMPLES of training
 *     cross-correlate what arrived against what we sent at every lag out to
 *     MAX_LAG. A peak beyond the near run that clears FAINTEST gets FAR_TAPS
 *     around it. Both runs then train through the rest.
 *
 * Its rules are BinModem's, each measured there:
 *   - It adapts ONLY when told to. The caller says when: during this end's
 *     training segment, the one stretch of the start-up the far end is required
 *     to be silent through (V.32 §5.4.2 note 3). Adapting through the far end has
 *     the canceller try to explain the far signal as an echo of us, which unlearns
 *     what it knew.
 *   - A training that removed less than KEEP_DB is undone (`endTraining`). On a
 *     line with no echo the taps learn the line's noise, and once held they add it
 *     back as a copy of our own signal, in the far end's band.
 *   - The step is a quarter (BinModem's ECHO_STEP, chosen against a 100 ppm cable
 *     and a noisy hybrid).
 *
 * Indexed by absolute sample counts: `sent(n, x)` records transmit sample n, and
 * `process(n, x)` takes receive sample n and returns what is left. A transmit
 * sample not yet generated reads as zero.
 *
 * Not ported, and not needed by the bridge's line: BinModem's drift following
 * (an echo that moves on a sound card's two clocks) and its jump detection.
 */

const KEEP_DB = 1.0;          // BinModem's NOTHING_CANCELLED_DB
const FLOOR = 1e-9;
const NEAR_TAPS = 64;         // 8 ms at 8 kHz, BinModem's ECHO_SPAN_MS
const FAR_TAPS = 64;          // BinModem's FAR_SPAN_MS is 4 ms; wider here for a smeared line
const MAX_LAG = 2048;         // 256 ms: the furthest reflection searched for
// Of training spent finding, before the far run exists. V.34's PP and TRN are
// 1867 samples at 3429 baud, so this has to leave most of a short window to adapt.
const FIND_SAMPLES = 800;
// Training samples after the last run is placed before what it removes is counted:
// fresh taps start at zero, and an average over their convergence reads 13 dB on
// a canceller that ends at 40.
const SETTLE_SAMPLES = 400;
const REPLAYS = 6;            // passes of the search's samples once the far run is placed
// Passes of the WHOLE training segment, at its end, before what it removes is
// measured. V.34's PP and TRN are short: the taps finished it at 23–27 dB, and an
// echo as loud as the far end (a 2-wire line whose far end is 10 dB away) then
// left 33 600 too little. The samples and their transmit history are still to
// hand. Four passes reached 31–35 dB and left one case a byte short; eight, 33–36.
const END_REPLAYS = 8;
const KEEP_MAX = 16384;       // training samples kept for them (2 s)
// The weakest far reflection worth a run: a squared normalised correlation. With
// nothing there, the largest of ~2000 candidates over 800 samples of a band-
// limited signal reads about 0.02; a lone reflection reads near 1.
const FAINTEST = 0.05;

class EchoCanceller {
  /**
   * @param {object} [o]
   * @param {number} [o.mu=0.25]   normalised step
   * @param {boolean} [o.find=true] search for a far reflection during training
   */
  constructor(o = {}) {
    this.mu = o.mu == null ? 0.25 : o.mu;
    this.find = o.find !== false;
    this.ring = new Float64Array(8192);      // transmit history, by sample count
    this.mask = this.ring.length - 1;
    this.txCount = 0;
    this.runs = [{ lag: 0, w: new Float64Array(NEAR_TAPS) }];
    this.adapting = false;
    this.heard = 0; this.left = 0; this._settled = 0;
    this.trainedDb = null;                     // what the settled half of training removed
    this.kept = false;
    this.farLag = null;                        // where the far run was placed, or null
    this.farScore = null;                      // and what the search read there
    this._found = null;                        // the search's buffers while it runs
  }

  /** Transmit sample n is x. Samples must be recorded in order. */
  sent(n, x) {
    this.ring[n & this.mask] = x;
    this.txCount = n + 1;
  }

  _tx(m) {
    return (m >= 0 && m < this.txCount && m > this.txCount - this.ring.length) ? this.ring[m & this.mask] : 0;
  }

  /** One NLMS step on receive sample n = x, without counting it. */
  _update(n, x) {
    let y = 0, p = FLOOR;
    for (const r of this.runs) {
      const w = r.w, base = n - r.lag;
      for (let k = 0; k < w.length; k++) { const t = this._tx(base - k); y += w[k] * t; p += t * t; }
    }
    const g = this.mu * (x - y) / p;
    for (const r of this.runs) {
      const w = r.w, base = n - r.lag;
      for (let k = 0; k < w.length; k++) w[k] += g * this._tx(base - k);
    }
  }

  /** Receive sample n is x: what is left once our own echo is taken out. */
  process(n, x) {
    let y = 0, p = FLOOR;
    for (const r of this.runs) {
      const w = r.w, base = n - r.lag;
      for (let k = 0; k < w.length; k++) { const t = this._tx(base - k); y += w[k] * t; p += t * t; }
    }
    const e = x - y;
    if (this.adapting) {
      if (this._kept && this._kept.n.length < KEEP_MAX) { this._kept.n.push(n); this._kept.x.push(x); }
      const g = this.mu * e / p;
      for (const r of this.runs) {
        const w = r.w, base = n - r.lag;
        for (let k = 0; k < w.length; k++) w[k] += g * this._tx(base - k);
      }
      const f = this._found;
      if (f) {
        const from = typeof f.from === 'function' ? f.from() : f.from;
        if (from != null && n >= from) {
          f.rx.push(x); f.e.push(e); f.n.push(n);
          if (f.rx.length >= FIND_SAMPLES) this._placeFar();
        }
      } else {
        // Everything after the search, and separately what comes once settled:
        // the second is the measure, the first stands in for a window too short.
        this.postHeard += x * x; this.postLeft += e * e;
        if (++this._settled > SETTLE_SAMPLES) { this.heard += x * x; this.left += e * e; }
      }
    }
    return e;
  }

  /**
   * The search: the lag beyond the near run where what the near taps LEFT
   * correlates best with what we sent. Squared and normalised, so it reads 1 for a
   * lone copy. What is left, not what arrived (BinModem's finder does the same):
   * a near echo of a periodic signal correlates again a period later, and V.34's
   * PP repeats every 112 samples, which placed a far run at 96 on a line with none.
   */
  _placeFar() {
    const f = this._found;
    this._found = null;
    const N = f.rx.length, n0 = f.n[0];
    let rxE = 0;
    for (const v of f.e) rxE += v * v;
    let best = -1, bestS = 0;
    for (let L = NEAR_TAPS; L < MAX_LAG; L++) {
      let c = 0, te = 0;
      for (let j = 0; j < N; j++) { const t = this._tx(n0 + j - L); c += f.e[j] * t; te += t * t; }
      const sc = te > 1e-12 && rxE > 1e-12 ? (c * c) / (te * rxE) : 0;
      if (sc > bestS) { bestS = sc; best = L; }
    }
    this.farScore = bestS;
    if (best < 0 || bestS < FAINTEST) return;
    // Centre the run a little behind the peak: a reflection is smeared by the
    // pulse shape on both sides, and a filter's causal half is the longer.
    const lag = Math.max(NEAR_TAPS, best - FAR_TAPS / 4);
    this.farLag = lag;
    this.runs.push({ lag, w: new Float64Array(FAR_TAPS) });
    this._settled = 0;
    // The new taps start at zero with a training segment already part spent. The
    // search's own samples are still to hand, and their transmit history is still in
    // the ring, so they are replayed through the update first. Six passes over
    // 800 samples take a 25 ms reflection from 29 dB held to 40, the near run's own.
    for (let pass = 0; pass < REPLAYS; pass++) {
      for (let j = 0; j < N; j++) this._update(f.n[j], f.rx[j]);
    }
  }

  /**
   * Begin a training segment: adapt, search, and count what the settled part
   * removes. The search takes samples from receive sample `searchFrom` on (a
   * number, or a function returning one once it is known, null until then), so a
   * caller whose segment opens on a periodic signal (V.34's PP) can keep it out:
   * a periodic echo correlates again a period later, however well the near run is
   * doing.
   */
  beginTraining(searchFrom = -Infinity) {
    this.adapting = true;
    this.heard = 0; this.left = 0; this._settled = 0; this.postHeard = 0; this.postLeft = 0;
    this._kept = { n: [], x: [] };
    if (this.find && this.runs.length === 1) this._found = { rx: [], e: [], n: [], from: searchFrom };
  }

  /**
   * End it. Keeps the taps only if the settled part of training (SETTLE_SAMPLES
   * after the last run was placed) removed more than
   * KEEP_DB of what was heard; otherwise they modelled nothing but noise and are
   * cleared.
   * @returns {number} dB removed
   */
  endTraining() {
    this.adapting = false;
    if (this._found) this._found = null;      // too short to have searched
    const k = this._kept;
    this._kept = null;
    if (k && k.n.length > SETTLE_SAMPLES) {
      // The replays, then what the taps now remove over the same samples: the
      // measure is of the taps that will be held, not of their convergence.
      for (let pass = 0; pass < END_REPLAYS; pass++) for (let j = 0; j < k.n.length; j++) this._update(k.n[j], k.x[j]);
      let h = 0, l = 0;
      for (let j = 0; j < k.n.length; j++) {
        const x = k.x[j]; let y = 0;
        for (const r of this.runs) { const w = r.w, base = k.n[j] - r.lag; for (let t = 0; t < w.length; t++) y += w[t] * this._tx(base - t); }
        h += x * x; l += (x - y) * (x - y);
      }
      this.heard = h; this.left = l;
    }
    const [h, l] = this.heard > 1e-12 ? [this.heard, this.left] : [this.postHeard, this.postLeft];
    const db = h > 1e-12 ? 10 * Math.log10(h / Math.max(l, 1e-30)) : 0;
    this.trainedDb = db;
    this.kept = db > KEEP_DB;
    if (!this.kept) { for (const r of this.runs) r.w.fill(0); this.runs.length = 1; this.farLag = null; }
    return db;
  }

  reset() {
    this.runs = [{ lag: 0, w: new Float64Array(NEAR_TAPS) }];
    this.adapting = false; this.kept = false; this.trainedDb = null; this.farLag = null; this._found = null;
  }
}

module.exports = { EchoCanceller, KEEP_DB, NEAR_TAPS, FAR_TAPS, MAX_LAG };
