'use strict';

/**
 * SymbolEqualizer.js — a fractionally spaced (T/2) complex adaptive equaliser.
 *
 * A telephone line is not flat: its loss rises toward the top of the band and its
 * group delay rises toward both edges, so each symbol arrives smeared across its
 * neighbours. The equaliser is an FIR over the matched filter's outputs, at the
 * symbol instant and half a symbol after it, from `L` symbols before to `L` after,
 * that learns the line's inverse by normalised LMS. T/2 spacing makes it
 * insensitive to where in the symbol the timing loop has put the instant.
 *
 * The caller supplies the inputs through `get(m, half)`, the matched filter's
 * output m symbols from the one being decided (half a symbol later when `half`),
 * and decides what each output should have been: `update(target)` after `run()`.
 * It starts as the identity, which is the right answer on a flat line, so a call
 * that never trains it is a call without one.
 *
 * The same structure as V34.js's receive equaliser, which caches its inputs per
 * polyphase bank. V.32's timing loop moves the instant every symbol, so this one
 * reads them afresh each time: 4L + 1 short filters a symbol.
 */
class SymbolEqualizer {
  /** @param {number} L  symbols either side; 4L + 1 taps */
  constructor(L = 8) {
    this.L = L;
    this.N = 4 * L + 1;
    this.w = new Float64Array(2 * this.N);
    this.x = new Float64Array(2 * this.N);
    this.w[2 * 2 * L] = 1;                     // the centre tap: the identity
    this.y = [0, 0];
  }

  /** The equalised symbol, from inputs `get(m, half)` → [i, q]. */
  run(get) {
    const x = this.x, w = this.w, L = this.L;
    let j = 0;
    for (let m = -L; m <= L; m++) {
      const a = get(m, false); x[j++] = a[0]; x[j++] = a[1];
      if (m < L) { const b = get(m, true); x[j++] = b[0]; x[j++] = b[1]; }
    }
    let yi = 0, yq = 0;
    for (let k = 0; k < 2 * this.N; k += 2) {
      yi += w[k] * x[k] - w[k + 1] * x[k + 1];
      yq += w[k] * x[k + 1] + w[k + 1] * x[k];
    }
    this.y[0] = yi; this.y[1] = yq;
    return this.y;
  }

  /** One normalised-LMS step toward (ti, tq) for the symbol run() last produced. */
  update(ti, tq, mu) {
    const x = this.x, w = this.w;
    const ei = ti - this.y[0], eq = tq - this.y[1];
    let p = 1e-12;
    for (let k = 0; k < 2 * this.N; k++) p += x[k] * x[k];
    const g = mu / p;
    for (let k = 0; k < 2 * this.N; k += 2) {
      // w += mu · e · conj(x) / |x|²
      w[k] += g * (ei * x[k] + eq * x[k + 1]);
      w[k + 1] += g * (eq * x[k] - ei * x[k + 1]);
    }
  }
}

module.exports = { SymbolEqualizer };
