'use strict';
// SPDX-License-Identifier: GPL-3.0-or-later — after BinModem's crates/datapump
// v90/network.rs and v90/ucode.rs at 623f935e (see NOTICE); development only.
// tools/bridge/v90net.js — V.90's digital route as codewords, for tests between two
// SynthLink modems. DEVELOPMENT ONLY, like the rest of the bridge, and pure JS.
//
// What a SIP gateway hands an analogue modem is the G.711 codewords the network
// carried, so this is the route without a loop: every downstream level is taken to
// the nearest codeword of the network's law, a T1 can rob the low bit of every
// sixth octet, and a digital pad scales every level and requantises it. The
// upstream is the analogue modem's waveform sampled by the same codec. It follows
// BinModem's datapump::v90::network (carry, quantise) and ucode (Table 1/V.90),
// so the two models agree codeword for codeword; nothing here is a claim about any
// real network.

const LAWS = ['mu', 'a'];

/** Table 1/V.90's linear value of a Ucode, on the sixteen-bit scale. */
function linear(law, u) {
  const chord = u >> 4, step = u & 15;
  if (law === 'mu') return 4 * (((2 * step + 33) << chord) - 33);
  return u < 32 ? 16 * u + 8 : ((2 * step + 33) << (chord - 1)) * 8;
}
const TABLE = { mu: Int32Array.from({ length: 128 }, (_, u) => linear('mu', u)), a: Int32Array.from({ length: 128 }, (_, u) => linear('a', u)) };

/** The nearest Ucode to a sixteen-bit value, and its sign. */
function nearest(law, v) {
  const t = TABLE[law], want = Math.abs(v);
  let best = 0, gap = Infinity;
  for (let u = 0; u < 128; u++) { const d = Math.abs(t[u] - want); if (d < gap) { gap = d; best = u; } }
  return { u: best, negative: v < 0 };
}

/** G.711's octet for a Ucode, inversions included (3.6/V.90), and back. */
function octet(law, u, negative) {
  if (law === 'mu') return negative ? 0x7f - u : 0xff - u;
  return ((negative ? u : 0x80 | u) ^ 0x55) & 0xff;
}
function fromOctet(law, o) {
  if (law === 'mu') { const negative = o < 0x80; return { u: negative ? 0x7f - o : 0xff - o, negative }; }
  const raw = o ^ 0x55;
  return { u: raw & 0x7f, negative: (raw & 0x80) === 0 };
}

const level = (law, u, negative) => (negative ? -1 : 1) * TABLE[law][u] / 32768;

class V90Net {
  /**
   * @param {object} [o]
   * @param {string} [o.law]  'mu' (default) or 'a'
   * @param {number} [o.rbs]  the octet of six whose low bit a T1 robs (set to 1)
   * @param {number} [o.padDb] a digital pad on the downstream, dB of loss
   */
  constructor({ law = 'mu', rbs = null, padDb = 0 } = {}) {
    if (!LAWS.includes(law)) throw new Error(`v90net: law ${law}`);
    this.law = law; this.rbs = rbs == null ? null : rbs % 6; this.pad = Math.pow(10, -padDb / 20);
    this.octets = 0;
  }

  /** One downstream sample (a float as the digital modem sent it) through the route. */
  downSample(f) {
    const { u, negative } = nearest(this.law, Math.round(f * 32768));
    let o = octet(this.law, u, negative);
    if (this.rbs !== null && this.octets % 6 === this.rbs) o |= 1;
    this.octets++;
    const back = fromOctet(this.law, o);
    let x = level(this.law, back.u, back.negative);
    if (this.pad !== 1) { const q = nearest(this.law, Math.round(x * this.pad * 32768)); x = level(this.law, q.u, q.negative); }
    return x;
  }
  down(f32) { const out = new Float32Array(f32.length); for (let i = 0; i < f32.length; i++) out[i] = this.downSample(f32[i]); return out; }

  /** The upstream: the analogue modem's waveform, sampled and quantised by the codec. */
  up(f32) {
    const out = new Float32Array(f32.length);
    for (let i = 0; i < f32.length; i++) { const q = nearest(this.law, Math.round(f32[i] * 32768)); out[i] = level(this.law, q.u, q.negative); }
    return out;
  }
}

module.exports = { V90Net, linear, nearest, octet, fromOctet };
