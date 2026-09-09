'use strict';

/**
 * V34Phase4 — the Modulation Parameter (MP) sequence of ITU-T V.34 §10.1.3.9,
 * built to Table 20/V.34 (Type 0) rather than to an invented control frame.
 *
 * §10.1.3.9: "Modulation Parameter (MP) sequences are exchanged between modems
 * during start-up and rate renegotiation and contain modulation parameters to be
 * used for data mode transmission." Type 0 carries the two directional rate
 * maxima, the shaping and trellis selections, the non-linear encoder parameter,
 * the auxiliary-channel enable and the rate capability mask; Type 1 adds precoder
 * coefficients (Table 21) and is not built here — there is no precoder on this
 * link (V34Mapper's clean-link simplifications), so Type 0 is the honest one.
 * "An MP sequence with the acknowledge bit set to 1 is denoted by MP′", which is
 * why `ack` is the only difference between the two directions' second exchange.
 *
 * ── Table 20/V.34, Type 0 ───────────────────────────────────────────────────
 *   0:16   frame sync, 11111111111111111    17     start bit 0
 *   18     type = 0                         19     reserved (0)
 *   20:23  max call→answer rate,  N·2400, N a 4-bit integer 1..14
 *   24:27  max answer→call rate,  N·2400, N a 4-bit integer 1..14
 *   28     auxiliary channel select (used only if BOTH modems set it)
 *   29:30  trellis encoder select: 0 = 16 state, 1 = 32, 2 = 64, 3 reserved
 *   31     non-linear encoder Θ for the remote transmitter: 0 = 0, 1 = 0.3125
 *   32     constellation shaping for the remote transmitter: 0 = minimum,
 *          1 = expanded (Table 10)
 *   33     acknowledge: 1 = MP received from the far end (this is MP′)
 *   34     start bit 0
 *   35:49  rate capability mask, bit 35 = 2400 … bit 48 = 33 600,
 *          bit 49 reserved
 *   50     asymmetric data signalling rate enable
 *   51     start bit 0
 *   52:67  reserved (0)                     68     start bit 0
 *   69:84  CRC                              85:87  fill bits 000
 *
 * ── The honest gap ──────────────────────────────────────────────────────────
 * **Transport.** A real MP is modulated by the Phase 4 signalling — symbols from
 * a 4- or 16-point constellation keyed to signal J (§10.1.3.9). Here the finished
 * 88-bit sequence is packed into 11 bytes and carried over the already-running
 * link inside the existing DLE-delimited control channel. The CONTENT is bit-exact
 * to Table 20; the carriage is not. Same shape of gap as V.90's CP/MP, and the
 * same reason: Phase 4 signalling has no counterpart on a lossless socket.
 * Recorded in PROTOCOLS.md.
 *
 * The CRC convention is BitFrame's — §10.1.2.3.2/V.34, which is this document's
 * own clause rather than a deferred one.
 */

const {
  SYNC_BITS, putUInt, getUInt, crc16, crcCoverage,
  bitsToBytes, bytesToBits, newSequence,
} = require('./BitFrame');

const MP_BITS = 88;                       // 0:84 defined + 85:87 fill
const MP_BYTES = MP_BITS / 8;             // 11
const MP_START_BITS = [17, 34, 51, 68];
const MP_CRC_START = 68;                  // CRC occupies 69:84

// Table 20 bits 35:48 — fourteen rates, N·2400 for N = 1..14. Bit 49 is reserved.
const RATES = Array.from({ length: 14 }, (_, i) => (i + 1) * 2400);
const MASK_LO = 35;

const TRELLIS_STATES = [16, 32, 64];      // bits 29:30; 3 is reserved for ITU
const THETA = [0, 0.3125];                // bit 31

function rateToN(bitRate) {
  const n = bitRate / 2400;
  if (!Number.isInteger(n) || n < 1 || n > 14) {
    throw new Error(`V.34 MP: ${bitRate} bit/s is not N·2400 for a 4-bit N in 1..14`);
  }
  return n;
}

function mpCrcBits(bits) {
  return crc16(crcCoverage(bits, MP_START_BITS, SYNC_BITS, MP_CRC_START));
}

/**
 * Build an MP Type 0 sequence. `callToAnswer` / `answerToCall` are bit rates;
 * `rates` is the capability mask's rate list; `ack` true makes this MP′.
 */
function buildMP(o) {
  const bits = newSequence(MP_BITS, MP_START_BITS);
  bits[18] = 0;                                          // Type 0
  putUInt(bits, 20, 23, rateToN(o.callToAnswer));
  putUInt(bits, 24, 27, rateToN(o.answerToCall));
  bits[28] = o.aux ? 1 : 0;
  const t = TRELLIS_STATES.indexOf(o.trellis == null ? 16 : o.trellis);
  if (t < 0) throw new Error(`V.34 MP: trellis must be one of ${TRELLIS_STATES.join('/')} states`);
  putUInt(bits, 29, 30, t);
  bits[31] = o.theta ? 1 : 0;                            // 0 ⇒ Θ = 0
  bits[32] = o.expandedShaping ? 1 : 0;                  // 0 ⇒ minimum shaping
  bits[33] = o.ack ? 1 : 0;                              // 1 ⇒ this is MP′
  for (let i = 0; i < RATES.length; i++) {
    bits[MASK_LO + i] = (o.rates || []).includes(RATES[i]) ? 1 : 0;
  }
  bits[50] = o.asymmetric ? 1 : 0;
  putUInt(bits, MP_CRC_START + 1, MP_CRC_START + 16, mpCrcBits(bits));
  return bits;
}

function parseMP(bits) {
  const rates = [];
  for (let i = 0; i < RATES.length; i++) if (bits[MASK_LO + i]) rates.push(RATES[i]);
  return {
    sync: bits.slice(0, SYNC_BITS).every(b => b === 1),
    crcOk: mpCrcBits(bits) === getUInt(bits, MP_CRC_START + 1, MP_CRC_START + 16),
    type: bits[18],
    callToAnswer: getUInt(bits, 20, 23) * 2400,
    answerToCall: getUInt(bits, 24, 27) * 2400,
    aux: !!bits[28],
    trellis: TRELLIS_STATES[getUInt(bits, 29, 30)] || null,
    theta: THETA[bits[31]],
    expandedShaping: !!bits[32],
    ack: !!bits[33],
    rates,
    asymmetric: !!bits[50],
  };
}


// ── §10.1.3.2 and §10.1.3.9 — how MP, E and CP actually cross the wire ───────
//
// The bit layouts above are the CONTENT of a parameter sequence; this is the
// modulation that carries it, and until now nothing here had it — MP travelled as
// a DLE-framed byte payload on the established link, which is bit-exact content
// arriving by the wrong means. §10.1.3.9 defines two forms and the peer's signal J
// chooses between them:
//
//   4-point.  "The 4-point MP sequence is generated as described in 10.1.3.3",
//             which is J's own chain: two scrambled bits I1n, I2n per 2D symbol
//             interval with I1n first in time, In = 2·I2n + I1n differentially
//             encoded to Zn = (In + Zn−1) mod 4, and the transmitted point is
//             point 0 of Figure 5's quarter rotated CLOCKWISE by Zn·90°.
//
//   16-point. Four scrambled bits I1n, I2n, Q1n, Q2n per 2D symbol interval, I1n
//             first in time. "Integer 2 * Q2n + Q1n selects the point from the
//             quarter-superconstellation of Figure 5" — points 0 to 3 of §9.1's
//             own numbering — and In = 2 * I2n + I1n is differentially encoded to
//             Zn exactly as above, the selected point then being rotated clockwise
//             by Zn·90°.
//
// "The differential encoder shall be initialized using the final symbol of the
// transmitted TRN sequence", which is why both encoders take a starting Z rather
// than assuming zero. §10.1.3.2's E rides the same two forms: "E is a 20-bit
// sequence of binary ones used to signal the end of MP ... The 4-point E sequence
// is generated as described in 10.1.3.3. The 16-point E sequence is generated as
// described in 10.1.3.9."
//
// §8.5.2/V.90 points CP at this same clause ("CP sequences are modulated according
// to 10.1.3.9/V.34"), and §8.5.3 points E at §10.1.3.2, so one implementation
// serves V.34's MP and V.90's CP and E alike. Nothing is wired to any of it yet:
// these are the spec-defined blocks, built and round-trip verified on their own
// before anything is wired to them.
const P3 = require('./V34Phase3');
const { quarterPoints } = require('./V34Mapper');

/** §10.1.3.2 — "E is a 20-bit sequence of binary ones". */
const E_BITS = 20;
function eBits() { return new Array(E_BITS).fill(1); }

/**
 * §10.1.3.9's point set for the 16-point form: points 0 to 3 of Figure 5's
 * quarter, in §9.1's numbering, each of which the differential rotation then takes
 * to four — 4 × 4 = the sixteen points the clause names.
 */
const MP16_POINTS = quarterPoints(4);

/** Bits per 2D symbol interval, by form. §10.1.3.9: two, or four. */
const MP_BITS_PER_SYMBOL = { 4: 2, 16: 4 };

/**
 * One parameter sequence, modulated. `points` is 4 or 16; `z0` is the differential
 * encoder's starting state, which §10.1.3.9 takes from TRN's final symbol.
 *
 * The bits are consumed in the clause's order — I1n first in time, then I2n, then
 * (16-point only) Q1n and Q2n — and a sequence whose length is not a whole number
 * of symbol intervals is a caller error rather than something to pad over: MP's own
 * fill bits exist to make it come out even, and V.90's Table 16 says so explicitly
 * ("Fill bits: 0s to extend the MP sequence length to the next multiple of 6
 * symbols").
 */
function modulateParams(bits, points = 4, z0 = 0) {
  const per = MP_BITS_PER_SYMBOL[points];
  if (!per) throw new Error(`V.34 §10.1.3.9: no ${points}-point form`);
  if (bits.length % per) {
    throw new Error(`V.34 §10.1.3.9: ${bits.length} bits is not a whole number of ${points}-point symbols`);
  }
  const out = [];
  let z = z0 & 3;
  for (let n = 0; n < bits.length; n += per) {
    const i1 = bits[n] & 1, i2 = bits[n + 1] & 1;
    z = (z + ((i2 << 1) | i1)) & 3;                // In = 2·I2n + I1n, mod-4 sum
    const base = points === 4
      ? MP16_POINTS[0]                             // §10.1.3.3 rotates point 0
      : MP16_POINTS[((bits[n + 3] & 1) << 1) | (bits[n + 2] & 1)];  // 2·Q2n + Q1n
    out.push(P3.rotCW(base, z));
  }
  return out;
}

/**
 * Its inverse. Rotation-differential, so it needs no absolute phase reference —
 * but it does need a PREDECESSOR for the first symbol's In, and the clause says
 * where that comes from: "the differential encoder shall be initialized using the
 * final symbol of the transmitted TRN sequence". Pass that rotation as `z0`.
 * Omitted, the first symbol's two I bits are unrecoverable and come back as zeros,
 * which is the honest answer rather than a guess.
 */
function demodulateParams(symbols, points = 4, z0 = null) {
  const per = MP_BITS_PER_SYMBOL[points];
  if (!per) throw new Error(`V.34 §10.1.3.9: no ${points}-point form`);
  const bits = [];
  let prev = z0 === null ? null : (z0 & 3);
  for (const s of symbols) {
    // Which quarter point this is, and by how much it was rotated. For the 4-point
    // form the answer is always point 0, which is what makes that form's symbols a
    // pure rotation sequence.
    let sel = -1, rot = -1;
    for (let k = 0; k < (points === 4 ? 1 : 4); k++) {
      for (let r = 0; r < 4; r++) {
        const p = P3.rotCW(MP16_POINTS[k], r);
        if (p.i === s.i && p.q === s.q) { sel = k; rot = r; }
      }
    }
    if (sel < 0) throw new Error(`V.34 §10.1.3.9: (${s.i},${s.q}) is not a point of the ${points}-point set`);
    if (prev === null) { prev = rot; bits.push(0, 0); }   // no predecessor: In is undefined
    else {
      const In = (rot - prev + 4) & 3;
      prev = rot;
      bits.push(In & 1, (In >> 1) & 1);                   // I1 first in time
    }
    if (points === 16) bits.push(sel & 1, (sel >> 1) & 1);
  }
  return bits;
}

const buildMPBytes = o => bitsToBytes(buildMP(o));
const parseMPBytes = bytes => parseMP(bytesToBits(bytes, MP_BITS));

module.exports = {
  MP_BITS, MP_BYTES, MP_START_BITS, MP_CRC_START, RATES, MASK_LO,
  TRELLIS_STATES, THETA,
  buildMP, parseMP, buildMPBytes, parseMPBytes, rateToN,
  E_BITS, eBits, MP16_POINTS, MP_BITS_PER_SYMBOL, modulateParams, demodulateParams,
  putUInt, getUInt, bitsToBytes, bytesToBits,
};
