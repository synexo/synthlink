'use strict';
/**
 * v90-modulus-check — the modulus encoder (§5.4.3/V.90) in isolation.
 *
 * This is the piece that makes V.90's fractional bits-per-symbol work: K bits
 * become one integer R0, which is decomposed mixed-radix across the six data
 * frame intervals against their constellation sizes Mᵢ. It is the structural
 * analogue of the V.34 shell mapper — pure integer arithmetic, no DSP — so it can
 * be proven exhaustively before anything else exists.
 *
 * Checks:
 *   1. The legality constraint ∏Mᵢ ≥ 2^K, and that K=39 really does force Mᵢ ≥ 91
 *      for six equal intervals (the reason the default constellation is 91 wide).
 *   2. Exact round trip over random R0 with random legal radices, including the
 *      full K=39 range and both extremes.
 *   3. Every Kᵢ stays inside its constellation, i.e. the mapper can always index.
 *   4. Injectivity over a dense sweep (no two R0 share a codeword vector).
 *
 * Run: node tools/tests/v90-modulus-check.js
 */
const { modulusEncode, modulusDecode, makeConfig } = require('../../vendor/src/dsp/protocols/V90Mapper');

let fail = 0;
const ok = (cond, msg) => { if (!cond) { console.error('  FAIL:', msg); fail++; } };

// ── 1. the constraint, and why M=91 ─────────────────────────────────────────
const cfg = makeConfig(56000);
console.log(`config 56000: K=${cfg.K} S=${cfg.S} D=${cfg.D} Sr=${cfg.Sr} ` +
            `→ ${cfg.D}·8000/6 = ${cfg.bitRate} bit/s`);
const need = 2 ** cfg.K;
console.log(`K=${cfg.K} ⇒ ∏Mᵢ must be ≥ 2^${cfg.K} = ${need}`);
ok(90 ** 6 < need, `90 per interval is NOT enough (90⁶ = ${90 ** 6})`);
ok(91 ** 6 >= need, `91 per interval IS enough (91⁶ = ${91 ** 6})`);
console.log(`  90⁶ = ${(90 ** 6).toExponential(4)} < 2^39   →  too small`);
console.log(`  91⁶ = ${(91 ** 6).toExponential(4)} ≥ 2^39   →  the 91-level default`);

// ── 2/3. round trip over random radices ─────────────────────────────────────
function trial(M, R0) {
  const K = modulusEncode(R0, M);
  for (let i = 0; i < M.length; i++) {
    if (!(Number.isInteger(K[i]) && K[i] >= 0 && K[i] < M[i])) {
      ok(false, `index K${i}=${K[i]} outside [0,${M[i]}) for R0=${R0}`);
      return false;
    }
  }
  const back = modulusDecode(K, M);
  if (back !== R0) { ok(false, `round trip ${R0} → ${back} with M=[${M}]`); return false; }
  return true;
}

let trials = 0;
// the real configuration, all-equal radices
const M91 = [91, 91, 91, 91, 91, 91];
for (const R0 of [0, 1, 2, need - 1, need - 2, Math.floor(need / 2)]) { trial(M91, R0); trials++; }
for (let t = 0; t < 200000; t++) { trial(M91, Math.floor(Math.random() * need)); trials++; }

// unequal radices (what a real analogue modem sends when RBS hits one interval)
for (let t = 0; t < 50000; t++) {
  const M = Array.from({ length: 6 }, () => 60 + Math.floor(Math.random() * 69));   // 60..128
  const prod = M.reduce((a, b) => a * b, 1);
  const K = Math.floor(Math.log2(prod));
  trial(M, Math.floor(Math.random() * 2 ** K));
  trials++;
}
console.log(`round trip: ${trials} trials exact (K=39 full range + random unequal radices)`);

// ── 4. injectivity ──────────────────────────────────────────────────────────
const seen = new Set();
let collisions = 0;
for (let R0 = 0; R0 < 300000; R0++) {
  const key = modulusEncode(R0, M91).join(',');
  if (seen.has(key)) collisions++;
  seen.add(key);
}
ok(collisions === 0, `injective over the swept range (${collisions} collisions)`);
console.log(`injectivity: 300000 consecutive R0 → 300000 distinct codeword vectors`);

// exactness guard: R0 must stay inside the double's exact-integer range
ok(need < Number.MAX_SAFE_INTEGER, '2^K is inside the exact-integer range of a double');
console.log(`exactness: 2^${cfg.K} = ${need} < 2^53 = ${Number.MAX_SAFE_INTEGER + 1}, ` +
            `so Number arithmetic is exact (bitwise ops would NOT be — they are 32-bit)`);

console.log(fail ? `\nFAILED (${fail})` : '\nv90-modulus-check OK');
process.exit(fail ? 1 : 0);
