'use strict';

/**
 * V90Phase4 — the CP and MP parameter-exchange sequences of ITU-T V.90 (09/98),
 * built to the Recommendation's own bit layouts (Table 14/V.90 for CP, Table
 * 16/V.90 for MP) rather than to an invented framing.
 *
 * CP travels analogue→digital and is what actually configures the downstream:
 * the selected rate, the shaping redundancy Sr, the lookahead depth lₐ, the
 * spectral shaper coefficients, the µ-law/A-law codec selection, the
 * constellations themselves and which constellation each of the six data frame
 * intervals uses. MP travels digital→analogue and reports the upstream rate the
 * digital modem will accept plus the analogue transmitter's coding parameters.
 *
 * ── Sequence structure ──────────────────────────────────────────────────────
 * Both sequences are a run of 17 ones (frame sync) followed by 17-bit groups,
 * each group being a start bit 0 plus 16 payload bits, and ending with a CRC
 * group and fill. Every field below is placed at the literal bit position the
 * table gives, so the layout can be audited against the printed Recommendation
 * line by line.
 *
 *   CP (Table 14):
 *     0:16    frame sync, 17 ones          17      start bit 0
 *     18      reserved (0)                 19      0 = CPt, 1 = CP
 *     20:24   drn, rate = (drn+20)·8000/6  25:29   reserved (0)
 *     30      silent-period request        31:32   Sr, shaping redundancy
 *     33      acknowledge (MP seen)        34      start bit 0
 *     35      codec: 0 = µ-law, 1 = A-law  36:48   upstream rate capability mask
 *     49:50   lₐ lookahead frames          51      start bit 0
 *     52:67   TRN1d RMS ratio, uQ3.13      68      start bit 0
 *     69:76   a₁, signed Q1.6              77:84   a₂, signed Q1.6
 *     85      start bit 0                  86:93   b₁, signed Q1.6
 *     94:101  b₂, signed Q1.6              102     start bit 0
 *     103:127 six 4-bit constellation indices (one per data frame interval,
 *             with a start bit 0 at 119 splitting intervals 3 and 4)
 *     128     transmitter constellations differ from codec output
 *     129:135 reserved (0)
 *     136…271 constellation 0: eight 17-bit groups, each a start bit 0 plus a
 *             16-bit Uchord mask (chord 1 = Ucodes 0..15, … chord 8 = 112..127)
 *     …       up to six constellations, then optional codec constellations
 *     then    start bit 0, 16-bit CRC, fill 000
 *
 *   MP (Table 16), Type 0 (no precoder coefficients):
 *     0:16    frame sync, 17 ones          17      start bit 0
 *     18      MP type (0 = no precoder)    19:23   reserved (0)
 *     24:27   drn, upstream rate = drn·2400 (drn 2..14 ⇒ 4800..33600)
 *     28      reserved (0)                 29:30   trellis select (0 = 16 state)
 *     31      nonlinear encoder Θ select   32      shaping select
 *     33      acknowledge (CP seen)        34      start bit 0
 *     35      reserved (0)                 36:49   upstream rate capability mask
 *     50      reserved (0)                 51      start bit 0
 *     52:67   reserved (0)                 68      start bit 0
 *     69:84   CRC                          85…     fill to a multiple of 6
 *
 * ── The two honest gaps ─────────────────────────────────────────────────────
 *   1. **Transport.** Real CP/MP are modulated by the Phase 4 signalling of the
 *      startup sequence. Here the finished bit sequence is packed into bytes and
 *      carried over the already-established link (CP over the upstream V.34, MP
 *      in the downstream data stream). The CONTENT is bit-exact to the tables;
 *      the way it crosses the wire is not. This matters for real-modem interop
 *      and is recorded in PROTOCOLS.md.
 *   2. **CRC convention.** V.90 defers the CRC to §10.1.2.3.2/V.34 and does not
 *      restate it, and that clause was not recoverable. We use the CCITT
 *      generator x¹⁶ + x¹² + x⁵ + 1 over the bits from the first start bit up to
 *      (not including) the CRC's own start bit. Both ends agree, so it is a
 *      genuine integrity check here, but the exact convention is unverified.
 */

const CP_SYNC_BITS = 17;
const GROUP = 17;                     // one start bit + 16 payload bits
const CHORDS = 8, CHORD_BITS = 16;    // 8 × 16 = the 128 Ucodes
const CP_CONST_BITS = CHORDS * GROUP; // 136 bits per constellation
const CP_FIXED_END = 136;             // first constellation starts here
const UCODES = 128;

// Upstream capability mask: 13 rates, 4800..33600 in 2400 steps (CP bits 36:48).
const UPSTREAM_RATES = [4800, 7200, 9600, 12000, 14400, 16800, 19200,
                        21600, 24000, 26400, 28800, 31200, 33600];

// ─── bit helpers ────────────────────────────────────────────────────────────
/** Write an unsigned integer LSB-first into bits[lo..hi]. */
function putUInt(bits, lo, hi, value) {
  const n = hi - lo + 1;
  for (let i = 0; i < n; i++) bits[lo + i] = (Math.floor(value / 2 ** i)) % 2;
}
function getUInt(bits, lo, hi) {
  let v = 0;
  for (let i = hi - lo; i >= 0; i--) v = v * 2 + (bits[lo + i] ? 1 : 0);
  return v;
}
/** Signed Q1.6 (sx.xxxxxx): 8 bits, two's complement, 6 fractional bits. */
function putQ1_6(bits, lo, value) {
  let q = Math.round(value * 64);
  if (q > 127) q = 127; if (q < -128) q = -128;
  putUInt(bits, lo, lo + 7, q & 0xff);
}
function getQ1_6(bits, lo) {
  let v = getUInt(bits, lo, lo + 7);
  if (v > 127) v -= 256;
  return v / 64;
}
/** Unsigned Q3.13 (xxx.xxxxxxxxxxxxx): 16 bits, 13 fractional bits. */
function putQ3_13(bits, lo, value) {
  let q = Math.round(value * 8192);
  if (q > 65535) q = 65535; if (q < 0) q = 0;
  putUInt(bits, lo, lo + 15, q);
}
function getQ3_13(bits, lo) { return getUInt(bits, lo, lo + 15) / 8192; }

/** CRC-16, CCITT generator x¹⁶+x¹²+x⁵+1, over a bit array. See gap (2) above. */
function crc16(bits) {
  let reg = 0xffff;
  for (const b of bits) {
    const msb = (reg >> 15) & 1;
    reg = (reg << 1) & 0xffff;
    if (msb ^ (b & 1)) reg ^= 0x1021;
  }
  return reg;
}

/** Pack a bit array into bytes, LSB-first within each byte. */
function bitsToBytes(bits) {
  const out = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let k = 0; k < 8 && i + k < bits.length; k++) if (bits[i + k]) b |= 1 << k;
    out.push(b);
  }
  return out;
}
function bytesToBits(bytes, count) {
  const bits = new Array(count).fill(0);
  for (let i = 0; i < count; i++) bits[i] = (bytes[i >> 3] >> (i & 7)) & 1;
  return bits;
}

/** Frame sync + start bits, applied to a freshly allocated sequence. */
function newSequence(length, startBits) {
  const bits = new Array(length).fill(0);
  for (let i = 0; i < CP_SYNC_BITS; i++) bits[i] = 1;
  for (const p of startBits) bits[p] = 0;
  return bits;
}

// ─── CP ─────────────────────────────────────────────────────────────────────
function cpLength(nConstellations) {
  return CP_FIXED_END + nConstellations * CP_CONST_BITS + GROUP + 3;
}
function cpStartBits(nConstellations) {
  const s = [17, 34, 51, 68, 85, 102, 119, 136];
  for (let c = 0; c < nConstellations; c++) {
    for (let ch = 0; ch < CHORDS; ch++) s.push(CP_FIXED_END + c * CP_CONST_BITS + ch * GROUP);
  }
  s.push(CP_FIXED_END + nConstellations * CP_CONST_BITS);   // CRC group's start bit
  return [...new Set(s)];
}

/**
 * Build a CP sequence. `constellations` is an array of 1..6 masks (Uint8Array(16),
 * bit u = Ucode u); `intervalIndex` is six integers selecting one per interval.
 */
function buildCP(o) {
  const cons = o.constellations;
  if (!cons.length || cons.length > 6) throw new Error('V.90 CP: 1..6 constellations');
  const n = cons.length;
  const bits = newSequence(cpLength(n), cpStartBits(n));

  bits[19] = o.cpt ? 0 : 1;                                  // 1 = CP, 0 = CPt
  putUInt(bits, 20, 24, o.drn);                              // rate = (drn+20)·8000/6
  bits[30] = o.silent ? 1 : 0;
  putUInt(bits, 31, 32, o.Sr);
  bits[33] = o.ack ? 1 : 0;
  bits[35] = o.aLaw ? 1 : 0;                                 // 0 = µ-law
  for (let i = 0; i < UPSTREAM_RATES.length; i++) {
    bits[36 + i] = (o.upstreamRates || []).includes(UPSTREAM_RATES[i]) ? 1 : 0;
  }
  putUInt(bits, 49, 50, o.ld);
  putQ3_13(bits, 52, o.trnRatio == null ? 1 : o.trnRatio);
  putQ1_6(bits, 69, o.coefs.a1);
  putQ1_6(bits, 77, o.coefs.a2);
  putQ1_6(bits, 86, o.coefs.b1);
  putQ1_6(bits, 94, o.coefs.b2);
  // six 4-bit interval→constellation indices, with the start bit at 119 between
  // intervals 3 and 4 (hence the 103/120 split rather than a flat run).
  const idx = o.intervalIndex;
  for (let i = 0; i < 4; i++) putUInt(bits, 103 + i * 4, 106 + i * 4, idx[i]);
  for (let i = 0; i < 2; i++) putUInt(bits, 120 + i * 4, 123 + i * 4, idx[4 + i]);
  bits[128] = o.constellationsDiffer ? 1 : 0;

  for (let c = 0; c < n; c++) {
    const mask = cons[c];
    for (let ch = 0; ch < CHORDS; ch++) {
      const base = CP_FIXED_END + c * CP_CONST_BITS + ch * GROUP + 1;
      for (let k = 0; k < CHORD_BITS; k++) {
        const u = ch * CHORD_BITS + k;
        bits[base + k] = (mask[u >> 3] >> (u & 7)) & 1;
      }
    }
  }

  const crcStart = CP_FIXED_END + n * CP_CONST_BITS;
  putUInt(bits, crcStart + 1, crcStart + 16, crc16(bits.slice(17, crcStart)));
  return bits;
}

function parseCP(bits, nConstellations) {
  const n = nConstellations;
  const crcStart = CP_FIXED_END + n * CP_CONST_BITS;
  const want = crc16(bits.slice(17, crcStart));
  const got = getUInt(bits, crcStart + 1, crcStart + 16);
  const upstreamRates = [];
  for (let i = 0; i < UPSTREAM_RATES.length; i++) if (bits[36 + i]) upstreamRates.push(UPSTREAM_RATES[i]);
  const intervalIndex = [];
  for (let i = 0; i < 4; i++) intervalIndex.push(getUInt(bits, 103 + i * 4, 106 + i * 4));
  for (let i = 0; i < 2; i++) intervalIndex.push(getUInt(bits, 120 + i * 4, 123 + i * 4));
  const constellations = [];
  for (let c = 0; c < n; c++) {
    const mask = new Uint8Array(16);
    for (let ch = 0; ch < CHORDS; ch++) {
      const base = CP_FIXED_END + c * CP_CONST_BITS + ch * GROUP + 1;
      for (let k = 0; k < CHORD_BITS; k++) {
        if (bits[base + k]) { const u = ch * CHORD_BITS + k; mask[u >> 3] |= 1 << (u & 7); }
      }
    }
    constellations.push(mask);
  }
  return {
    crcOk: want === got, sync: bits.slice(0, 17).every(b => b === 1),
    isCP: bits[19] === 1, drn: getUInt(bits, 20, 24), silent: !!bits[30],
    Sr: getUInt(bits, 31, 32), ack: !!bits[33], aLaw: !!bits[35],
    upstreamRates, ld: getUInt(bits, 49, 50), trnRatio: getQ3_13(bits, 52),
    coefs: { a1: getQ1_6(bits, 69), a2: getQ1_6(bits, 77), b1: getQ1_6(bits, 86), b2: getQ1_6(bits, 94) },
    intervalIndex, constellationsDiffer: !!bits[128], constellations,
  };
}

// ─── MP (Type 0) ────────────────────────────────────────────────────────────
const MP_START_BITS = [17, 34, 51, 68];
const MP_CRC_START = 68;
function mpLength() {
  const end = 85;                                   // last defined bit before fill
  return Math.ceil((end + 1) / 6) * 6;              // fill to a multiple of 6
}
function buildMP(o) {
  const bits = newSequence(mpLength(), MP_START_BITS);
  bits[18] = 0;                                     // Type 0 — no precoder coefficients
  putUInt(bits, 24, 27, o.drn);                     // upstream rate = drn·2400
  putUInt(bits, 29, 30, o.trellis == null ? 0 : o.trellis);   // 0 = 16 state
  bits[31] = o.nonlinear ? 1 : 0;
  bits[32] = o.expandedShaping ? 1 : 0;
  bits[33] = o.ack ? 1 : 0;
  for (let i = 0; i < UPSTREAM_RATES.length; i++) {
    bits[36 + i] = (o.upstreamRates || []).includes(UPSTREAM_RATES[i]) ? 1 : 0;
  }
  putUInt(bits, MP_CRC_START + 1, MP_CRC_START + 16, crc16(bits.slice(17, MP_CRC_START)));
  return bits;
}
function parseMP(bits) {
  const want = crc16(bits.slice(17, MP_CRC_START));
  const got = getUInt(bits, MP_CRC_START + 1, MP_CRC_START + 16);
  const upstreamRates = [];
  for (let i = 0; i < UPSTREAM_RATES.length; i++) if (bits[36 + i]) upstreamRates.push(UPSTREAM_RATES[i]);
  return {
    crcOk: want === got, sync: bits.slice(0, 17).every(b => b === 1),
    type: bits[18], drn: getUInt(bits, 24, 27), trellis: getUInt(bits, 29, 30),
    nonlinear: !!bits[31], expandedShaping: !!bits[32], ack: !!bits[33], upstreamRates,
  };
}

module.exports = {
  CP_SYNC_BITS, GROUP, CHORDS, CHORD_BITS, CP_CONST_BITS, CP_FIXED_END, UPSTREAM_RATES,
  cpLength, cpStartBits, buildCP, parseCP, mpLength, buildMP, parseMP,
  crc16, bitsToBytes, bytesToBits, putUInt, getUInt, putQ1_6, getQ1_6, putQ3_13, getQ3_13,
};
