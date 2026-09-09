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
 * only in its Figure 14 — and that figure has now been read: see crc16 below. The
 * convention has no unverified degree of freedom left.
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

/**
 * CRC-16, generator x¹⁶ + x¹² + x⁵ + 1, register preset to all ones, as Figure
 * 14/V.34 draws it.
 *
 * The FIGURE is the whole of this function's content, and it is the one thing
 * §10.1.2.3.2's prose does not restate. It draws sixteen stages labelled 15 down
 * to 0 from left to right, in three blocks of five, seven and four, with an adder
 * between each pair and a third adder at the right-hand end where "Information
 * Bits In" arrives. So the information bit is combined with the bit leaving stage
 * 0, that sum is the feedback, and the feedback enters stage 15 and the two
 * adders — which is to say the taps are stages 15, 10 and 3.
 *
 * 0x8408 is exactly those three stages, and it is the bit reversal of 0x1021: the
 * register shifts DOWN in stage number, so the polynomial appears reversed. This
 * file carried the other orientation — MSB-first, `reg << 1` with 0x1021 — for as
 * long as it has existed, on the stated grounds that the figure would not
 * transcribe. It does transcribe: the block boundaries are 5, 7 and 4, which puts
 * the adders at 15, 10 and 3 and can be read off the page image directly.
 *
 * Both orientations round-trip perfectly against themselves, and every INFO, MP
 * and CP sequence in this repository is checked by the same generator at both
 * ends, so nothing here could ever have failed on it. `v34-phase2-check` holds
 * the figure itself rather than a round trip, which is the only thing that can.
 */
const CRC_TAPS = 0x8408;             // stages 15, 10 and 3 — Figure 14's adders

function crc16(bits) {
  let reg = 0xffff;
  // Indexed rather than for..of: this runs at every candidate position of every
  // sequence hunt, and the iterator protocol allocates on each call.
  for (let i = 0; i < bits.length; i++) {
    // The bit leaving stage 0, plus the information bit: Figure 14's right-hand
    // adder, whose output is the feedback.
    const fb = (reg & 1) ^ (bits[i] & 1);
    reg >>= 1;                       // every stage takes its left neighbour's
    if (fb) reg ^= CRC_TAPS;         // and 15, 10 and 3 take the feedback with it
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
  const skip = skipSet(startBits);
  const out = [];
  for (let i = from; i < to; i++) if (!skip.has(i)) out.push(bits[i]);
  return out;
}

// The start-bit lists are fixed per sequence TYPE and were being turned into a Set
// on every call — once per candidate position of every hunt. Keyed on the array
// identity, so a caller that memoises its list (V90Phase4's cpStartBits does) pays
// for the Set once per process.
const SKIP_CACHE = new WeakMap();
function skipSet(startBits) {
  if (startBits instanceof Set) return startBits;
  let s = SKIP_CACHE.get(startBits);
  if (!s) { s = new Set(startBits); SKIP_CACHE.set(startBits, s); }
  return s;
}

/**
 * crc16 over crcCoverage's bits, without building them.
 *
 * Identical arithmetic to `crc16(crcCoverage(...))` — the same bits in the same
 * order — but it walks the source instead of copying out of it, and it takes an
 * `at` so a candidate sequence inside a receive buffer can be checked in place.
 * Both matter: a hunt tests one position per bit received, and the array the old
 * pair allocated was the largest single source of garbage in a connect.
 */
function crcOf(bits, startBits, from, to, at = 0) {
  const skip = skipSet(startBits);
  let reg = 0xffff;
  for (let i = from; i < to; i++) {
    if (skip.has(i)) continue;
    const fb = (reg & 1) ^ (bits[at + i] & 1);
    reg >>= 1;
    if (fb) reg ^= CRC_TAPS;
  }
  return reg;
}

/**
 * The next parameter sequence at or after `from`: a run of `sync` ones, the start
 * bit 0 that every one of these tables puts immediately after it, then whatever
 * `accept(at)` makes of the candidate.
 *
 * Returns `{ at, scanned }` — `at` is -1 when none was found, and `scanned` is the
 * first position not yet fully testable, which the caller keeps as its cursor. A
 * position that has been tested against a complete window can never become valid
 * later, because bits already received do not change, so resuming there is exact
 * and not an approximation.
 *
 * The start-bit test is what makes this cheap, and it is not an optimisation of
 * convenience: a training signal descrambles to constant ones, so EVERY position in
 * it opens a valid-looking frame sync and the CRC alone would run at all of them.
 * One comparison rejects the lot.
 */
function findSequence(bits, from, len, sync, accept) {
  let i = Math.max(0, from);
  for (; i + len <= bits.length; i++) {
    if (bits[i + sync] !== 0) continue;
    let ones = true;
    for (let k = 0; k < sync; k++) if (bits[i + k] !== 1) { ones = false; break; }
    if (!ones) continue;
    if (accept(i)) return { at: i, scanned: i };
  }
  return { at: -1, scanned: i };
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
  crc16, crcCoverage, crcOf, findSequence, bitsToBytes, bytesToBits, newSequence,
};
