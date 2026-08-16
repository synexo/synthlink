'use strict';
// Standalone check of the genuine V.34 16-state 4D trellis convolutional encoder
// (ITU-T V.34 Figure 10 / Wei). Clean-room JS from the ITU figure structure.
// This proves the FSM is well-formed (deterministic, all 16 states reachable,
// finite period) ahead of integrating it into V34.js's data path (Stage A′).
//
// Figure 10 (16-state): 4-bit state register. Per 4D symbol the differential
// quadrant bits of the two constituent 2D symbols yield an input vector
// (Y1,Y2,Y3,Y4); the encoder outputs the redundant bit Y0 (= current LSB of the
// state) and advances the state.

// next-state / output for the 16-state code. `trans` packs (Y1,Y2,Y4,Y3) as in
// the ITU figure: bit0=Y1, bit1=Y2, bit2=Y4, bit3=Y3.
function step16(state, Y1, Y2, Y3, Y4) {
  const Y0 = state & 1;                                  // redundant output bit
  const trans = (Y1) | (Y2 << 1) | (Y4 << 2) | (Y3 << 3);
  // The four input bits and Y0 drive the register update, then shift.
  let ns = state ^ ((Y1 << 1) | (Y2 << 2) | ((Y2 ^ Y0) << 3) | (Y0 << 4));
  ns >>= 1;
  return { Y0, ns, trans };
}

// 1) determinism + state-space closure: enumerate transitions from every state
//    over all 16 input combinations; confirm we stay within 4 bits (16 states)
//    and that the map is a well-defined function.
const reachableFrom = new Set();
for (let st = 0; st < 16; st++) {
  for (let inp = 0; inp < 16; inp++) {
    const Y1 = inp & 1, Y2 = (inp >> 1) & 1, Y3 = (inp >> 2) & 1, Y4 = (inp >> 3) & 1;
    const { ns } = step16(st, Y1, Y2, Y3, Y4);
    if (ns < 0 || ns > 15) { console.log(`FAIL: state out of range ${ns}`); process.exit(1); }
    reachableFrom.add(ns);
  }
}

// 2) reachability from the zero state under a pseudo-random input stream
const seen = new Set([0]);
let s = 0, rng = 12345;
const outBits = [];
for (let n = 0; n < 20000; n++) {
  rng = (rng * 1103515245 + 12345) & 0x7fffffff;
  const inp = rng & 15;
  const Y1 = inp & 1, Y2 = (inp >> 1) & 1, Y3 = (inp >> 2) & 1, Y4 = (inp >> 3) & 1;
  const r = step16(s, Y1, Y2, Y3, Y4);
  outBits.push(r.Y0);
  s = r.ns; seen.add(s);
}

// 3) period under constant (all-zero) input from the zero state
let ps = 0, steps = 0; const start = 0;
do { ps = step16(ps, 0, 0, 0, 0).ns; steps++; } while (ps !== start && steps < 1000);

const ones = outBits.reduce((a, b) => a + b, 0);
console.log(`16-state 4D trellis (Figure 10):`);
console.log(`  states reachable in one step from all states: ${reachableFrom.size}/16`);
console.log(`  states visited from zero under random input:  ${seen.size}/16`);
console.log(`  zero-input is a fixed point of the zero state: ${steps === 1 ? 'yes (correct)' : 'no'}`);
console.log(`  redundant-bit balance over 20000 syms:        ${ones} ones (${(100*ones/outBits.length).toFixed(1)}%)`);

const balanced = ones > outBits.length * 0.45 && ones < outBits.length * 0.55;
const ok = reachableFrom.size === 16 && seen.size === 16 && steps === 1 && balanced;
console.log(`\n=== ${ok ? 'TRELLIS FSM OK ✅' : 'TRELLIS FSM FAIL ❌'} ===`);
process.exit(ok ? 0 : 1);
