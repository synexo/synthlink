'use strict';

/**
 * BitFrame — the bit-level machinery shared by the V.34 and V.90 parameter
 * sequences (MP, CP). Both are built the same way: a run of ones for frame sync,
 * then 17-bit groups of a start bit 0 plus 16 payload bits, fields written at
 * literal bit positions, a CRC group, and fill.
 *
 * Factored out when V34Phase4 became the second user; V90Phase4 was the first and
 * still re-exports these under its own names so its callers did not have to move.
 *
 * The CRC is §10.1.2.3.2/V.34, which V.90 defers to: generator x¹⁶ + x¹² + x⁵ + 1,
 * shift register preset to all ones, covering every information bit of the sequence
 * except the frame sync bits, the start bits and the fill bits, remainder emitted
 * as-is — neither inverted nor reversed — bit 0 first, bit 0 being the LSB. The one
 * thing that clause does not restate is the register's shift direction, which lives
 * only in its Figure 14; that figure would not transcribe, so the MSB-first form
 * here is the single unverified degree of freedom in the convention.
 */

const SYNC_BITS = 17;                 // frame sync: seventeen ones
const GROUP = 17;                     // one start bit + 16 payload bits

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

/** CRC-16, generator x¹⁶+x¹²+x⁵+1, register preset to all ones. */
function crc16(bits) {
  let reg = 0xffff;
  for (const b of bits) {
    const msb = (reg >> 15) & 1;
    reg = (reg << 1) & 0xffff;
    if (msb ^ (b & 1)) reg ^= 0x1021;
  }
  return reg;
}

/**
 * The bits the CRC covers: everything in [from, to) that is not a start bit. The
 * frame sync precedes `from` and the fill follows the CRC, so excluding the start
 * bits here is the whole of the clause's "except the frame sync bits, the start
 * bits, and the fill bits". Structural bits are outside the check by design — a
 * corrupted start bit is a framing failure, not a CRC failure.
 */
function crcCoverage(bits, startBits, from, to) {
  const skip = startBits instanceof Set ? startBits : new Set(startBits);
  const out = [];
  for (let i = from; i < to; i++) if (!skip.has(i)) out.push(bits[i]);
  return out;
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
  for (let i = 0; i < SYNC_BITS; i++) bits[i] = 1;
  for (const p of startBits) bits[p] = 0;
  return bits;
}

module.exports = {
  SYNC_BITS, GROUP,
  putUInt, getUInt, putQ1_6, getQ1_6, putQ3_13, getQ3_13,
  crc16, crcCoverage, bitsToBytes, bytesToBits, newSequence,
};
