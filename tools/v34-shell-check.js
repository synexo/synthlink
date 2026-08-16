'use strict';
// Standalone check of the genuine V.34 shell mapper (ITU-T V.34 §9.4), clean-room
// from the §9.4 equations (9-3 … 9-24). The shell mapper is V.34's constellation-
// shaping stage: it maps K input bits to 8 ring indices m[j][k] ∈ [0,M) drawn
// from M equal-size rings, biasing the 4D constellation toward lower-energy points
// (shaping gain). The spec requires any implementation to reproduce this exact
// mapping (§9.4 NOTE). We verify the encoder (bits→rings, §9.4 algorithm) and its
// inverse (rings→bits) round-trip to the identity, and that all ring indices are
// valid — proving the mapping is a correct bijection ready to wire into V34.js.

function buildTables(M) {
  const n = 8 * (M - 1) + 1;
  const g2 = new Array(n).fill(0);
  for (let p = 0; p < n; p++) g2[p] = (p >= 0 && p <= 2 * (M - 1)) ? (M - Math.abs(p - (M - 1))) : 0;
  const g4 = new Array(n).fill(0);
  for (let p = 0; p < n; p++) { let s = 0; if (p <= 4 * (M - 1)) for (let i = 0; i <= p; i++) s += g2[i] * g2[p - i]; g4[p] = s; }
  const g8 = new Array(n).fill(0);
  for (let p = 0; p < n; p++) { let s = 0; if (p <= 8 * (M - 1)) for (let i = 0; i <= p; i++) s += g4[i] * g4[p - i]; g8[p] = s; }
  const z8 = new Array(n + 1).fill(0);
  for (let p = 1; p <= n; p++) z8[p] = z8[p - 1] + (g8[p - 1] || 0);
  return { g2, g4, g8, z8, M };
}

// Encoder: R0 (K-bit integer) -> 8 ring indices m[4][2]  (§9.4, eqs 9-7 … 9-24)
function indexToRings(T, R0) {
  const { g2, g4, z8, M } = T;
  // 2) largest A with z8(A) ≤ R0
  let A = 0; while (z8[A + 1] !== undefined && z8[A + 1] <= R0) A++;
  // 3) largest B with R1 ≥ 0
  let B = 0, R1;
  for (;;) {
    let sub = 0; for (let p = 0; p < B; p++) sub += g4[p] * g4[A - p];
    R1 = R0 - z8[A] - sub;
    let subN = 0; for (let p = 0; p < B + 1; p++) subN += g4[p] * g4[A - p];
    if (R0 - z8[A] - subN < 0) break;
    B++;
  }
  // 4)
  const gB = g4[B];
  const R2 = R1 % gB, R3 = (R1 - R2) / gB;
  // 5.1) largest C with R4 ≥ 0
  let C = 0, R4;
  for (;;) {
    let sub = 0; for (let p = 0; p < C + 1; p++) sub += g2[p] * g2[B - p];
    if (R2 - sub < 0) break;
    C++;
  }
  { let sub = 0; for (let p = 0; p < C; p++) sub += g2[p] * g2[B - p]; R4 = R2 - sub; }
  // 5.2) largest D with R5 ≥ 0
  let D = 0, R5;
  for (;;) {
    let sub = 0; for (let p = 0; p < D + 1; p++) sub += g2[p] * g2[A - B - p];
    if (R3 - sub < 0) break;
    D++;
  }
  { let sub = 0; for (let p = 0; p < D; p++) sub += g2[p] * g2[A - B - p]; R5 = R3 - sub; }
  // 6)
  const E = R4 % g2[C], F = (R4 - E) / g2[C];
  const G = R5 % g2[D], H = (R5 - G) / g2[D];
  // ring indices (9-17 … 9-24)
  const m = [[0, 0], [0, 0], [0, 0], [0, 0]];
  if (C < M) { m[0][0] = E; m[0][1] = C - E; } else { m[0][1] = M - 1 - E; m[0][0] = C - m[0][1]; }
  if (B - C < M) { m[1][0] = F; m[1][1] = B - C - F; } else { m[1][1] = M - 1 - F; m[1][0] = B - C - m[1][1]; }
  if (D < M) { m[2][0] = G; m[2][1] = D - G; } else { m[2][1] = M - 1 - G; m[2][0] = D - m[2][1]; }
  if (A - B - D < M) { m[3][0] = H; m[3][1] = A - B - D - H; } else { m[3][1] = M - 1 - H; m[3][0] = A - B - D - m[3][1]; }
  return m;
}

// Decoder: 8 ring indices -> R0   (inverse of §9.4, for the clean-link receiver)
function ringsToIndex(T, m) {
  const { g2, g4, z8, M } = T;
  const C = m[0][0] + m[0][1]; const E = (C < M) ? m[0][0] : M - 1 - m[0][1];
  const BmC = m[1][0] + m[1][1]; const F = (BmC < M) ? m[1][0] : M - 1 - m[1][1];
  const B = C + BmC;
  const D = m[2][0] + m[2][1]; const G = (D < M) ? m[2][0] : M - 1 - m[2][1];
  const AmBmD = m[3][0] + m[3][1]; const H = (AmBmD < M) ? m[3][0] : M - 1 - m[3][1];
  const A = B + D + AmBmD;
  const R4 = F * g2[C] + E;
  const R5 = H * g2[D] + G;
  let s2 = 0; for (let p = 0; p < C; p++) s2 += g2[p] * g2[B - p]; const R2 = R4 + s2;
  let s3 = 0; for (let p = 0; p < D; p++) s3 += g2[p] * g2[A - B - p]; const R3 = R5 + s3;
  const R1 = R3 * g4[B] + R2;
  let s1 = 0; for (let p = 0; p < B; p++) s1 += g4[p] * g4[A - p];
  return R1 + z8[A] + s1;
}

function testM(M, K, samples) {
  const T = buildTables(M);
  const total = T.z8[T.z8.length - 1];            // total representable combinations
  const cap = Math.min(2 ** K, total);
  let bad = 0, ringBad = 0, checked = 0;
  const step = samples && cap > samples ? Math.floor(cap / samples) : 1;
  for (let R0 = 0; R0 < cap; R0 += step) {
    const m = indexToRings(T, R0);
    for (let j = 0; j < 4; j++) for (let k = 0; k < 2; k++) if (m[j][k] < 0 || m[j][k] >= M) ringBad++;
    const back = ringsToIndex(T, m);
    if (back !== R0) bad++;
    checked++;
  }
  const ok = bad === 0 && ringBad === 0;
  console.log(`  M=${String(M).padStart(2)} K=${String(K).padStart(2)}  2^K=${2 ** K}  z8_total=${total}  checked=${checked}  roundtrip_err=${bad}  ring_range_err=${ringBad}  ${ok ? 'OK ✅' : 'FAIL ❌'}`);
  return ok;
}

console.log('V.34 shell mapper (§9.4) — encoder→decoder round-trip:');
let all = true;
all &= testM(1, 0, null);      // trivial (K=0): rings always 0
all &= testM(2, 4, null);      // 4800/2400  — exhaustive
all &= testM(2, 5, null);      // 5000/2400  — exhaustive
all &= testM(4, 12, null);     // 7200/2400  — exhaustive-ish
all &= testM(7, 20, 200000);   // 9600/2400  — sampled
all &= testM(12, 28, 200000);  // 28800/3200 — sampled (headline config)
all &= testM(14, 28, 200000);  // 28800/3200 expanded-shaping M
all &= testM(11, 27, 200000);  // 33600/3200 — sampled
console.log(`\n=== ${all ? 'SHELL MAPPER OK ✅' : 'SHELL MAPPER FAIL ❌'} ===`);
process.exit(all ? 0 : 1);
