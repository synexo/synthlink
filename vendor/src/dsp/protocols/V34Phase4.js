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

const buildMPBytes = o => bitsToBytes(buildMP(o));
const parseMPBytes = bytes => parseMP(bytesToBits(bytes, MP_BITS));

module.exports = {
  MP_BITS, MP_BYTES, MP_START_BITS, MP_CRC_START, RATES, MASK_LO,
  TRELLIS_STATES, THETA,
  buildMP, parseMP, buildMPBytes, parseMPBytes, rateToN,
  putUInt, getUInt, bitsToBytes, bytesToBits,
};
