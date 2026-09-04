'use strict';
// Standalone verification of the genuine V.34 mapping-frame coder (V34Mapper.js):
// random frames -> constellation points -> back to bits, with coder state
// persisting across frames (differential + trellis are stateful). No audio, no
// scrambler — isolates the encode/decode chain (shell + differential + trellis +
// mapper) across all provided configs before it is wired into the audio path.
const { V34Coder, makeConfig, CONFIGS, SYMS_PER_FRAME, sliceOdd, invRot, quarterPoints } =
  require('../../vendor/src/dsp/protocols/V34Mapper');

// ── Figure 5/V.34, transcribed ───────────────────────────────────────────────
// The point numbers as printed, by row, read out of the text layer of the
// converted Recommendation (tools/datasource, page div pf14): every label of all
// 23 rows, 416 in total. Keyed by imaginary component; the second element is the
// row's leftmost real component and the columns step by 4, as the printed axis
// does. Both halves are measured, not inferred — the reading order comes from the
// glyph pen position (document order alone interleaves, some runs are placed with
// a negative margin), and the leftmost column from the row's own x against the
// axis. This is what makes the constellation a transcription rather than a
// convention: a generator is free to be self-consistent and still disagree.
const FIG5 = {
  45: [-7, [408, 396, 394, 400, 414]],
  41: [-19, [398, 375, 349, 339, 329, 326, 335, 347, 359, 386]],
  37: [-27, [412, 371, 340, 314, 290, 279, 269, 265, 273, 281, 302, 322, 353, 390]],
  33: [-31, [401, 357, 318, 282, 257, 236, 224, 216, 212, 218, 228, 247, 270, 298, 337, 378]],
  29: [-35, [406, 350, 306, 266, 234, 206, 185, 173, 164, 162, 170, 181, 197, 220, 253, 288, 327, 379]],
  25: [-35, [360, 310, 263, 226, 193, 165, 146, 133, 123, 121, 125, 137, 154, 179, 207, 242, 289, 338, 391]],
  21: [-39, [384, 324, 277, 229, 189, 156, 131, 110, 96, 87, 83, 92, 100, 117, 140, 172, 208, 254, 299, 354]],
  17: [-39, [355, 294, 243, 201, 160, 126, 98, 79, 64, 58, 54, 62, 71, 90, 112, 141, 180, 221, 271, 323, 387]],
  13: [-43, [392, 330, 274, 222, 177, 135, 102, 77, 55, 41, 35, 31, 37, 48, 65, 91, 118, 155, 198, 248, 303, 361]],
  9: [-43, [380, 316, 255, 203, 158, 119, 84, 60, 39, 24, 17, 15, 20, 30, 49, 72, 101, 138, 182, 230, 283, 348, 415]],
  5: [-43, [367, 304, 244, 194, 148, 108, 75, 50, 28, 13, 6, 4, 8, 21, 38, 63, 93, 127, 171, 219, 275, 336, 402]],
  1: [-43, [362, 296, 238, 186, 142, 103, 69, 43, 22, 9, 1, 0, 5, 16, 32, 56, 85, 122, 163, 213, 267, 328, 395]],
  '-3': [-43, [365, 300, 240, 190, 144, 106, 73, 45, 25, 11, 3, 2, 7, 18, 36, 59, 88, 124, 166, 217, 272, 331, 397]],
  '-7': [-43, [372, 307, 251, 199, 152, 113, 80, 52, 33, 19, 12, 10, 14, 26, 42, 66, 97, 134, 174, 225, 280, 341, 409]],
  '-11': [-43, [388, 320, 261, 210, 167, 128, 94, 67, 47, 34, 27, 23, 29, 40, 57, 81, 111, 147, 187, 237, 291, 351]],
  '-15': [-43, [410, 343, 284, 232, 183, 149, 115, 89, 68, 53, 46, 44, 51, 61, 78, 99, 132, 168, 209, 258, 315, 376]],
  '-19': [-39, [369, 311, 259, 214, 175, 139, 116, 95, 82, 74, 70, 76, 86, 104, 129, 157, 195, 235, 285, 342, 399]],
  '-23': [-39, [403, 345, 292, 249, 205, 176, 150, 130, 114, 107, 105, 109, 120, 136, 161, 191, 227, 268, 319, 373]],
  '-27': [-35, [382, 332, 287, 250, 215, 184, 169, 153, 145, 143, 151, 159, 178, 202, 231, 264, 308, 358, 413]],
  '-31': [-31, [377, 333, 293, 260, 233, 211, 200, 192, 188, 196, 204, 223, 245, 278, 312, 352, 404]],
  '-35': [-27, [383, 346, 313, 286, 262, 252, 241, 239, 246, 256, 276, 295, 325, 363, 407]],
  '-39': [-23, [405, 370, 344, 321, 309, 301, 297, 305, 317, 334, 356, 385]],
  '-43': [-15, [411, 389, 374, 366, 364, 368, 381, 393]],
};

function checkFigure5() {
  const quarter = quarterPoints(416);
  const printed = new Map();                       // label -> "re,im"
  let n = 0;
  for (const im of Object.keys(FIG5)) {
    const [re0, labels] = FIG5[im];
    labels.forEach((label, k) => { printed.set(label, `${re0 + 4 * k},${im}`); n++; });
  }
  if (n !== 416) { console.log(`  Figure 5: transcription has ${n} labels, not 416 ❌`); return false; }
  const wrong = [];
  for (let label = 0; label < 416; label++) {
    const got = `${quarter[label].i},${quarter[label].q}`;
    if (printed.get(label) !== got) wrong.push(`${label}: figure ${printed.get(label)} vs generated ${got}`);
  }
  if (wrong.length) {
    console.log(`  Figure 5: ${wrong.length} of 416 points disagree with the printed figure ❌`);
    wrong.slice(0, 5).forEach(w => console.log(`    ${w}`));
    return false;
  }
  console.log('  Figure 5/V.34: all 416 printed point numbers match  OK ✅');
  return true;
}

function testConfig(name) {
  const cfg = makeConfig(CONFIGS[name]);
  const uniq = new Set(cfg.quarter.map(p => p.i * 10000 + p.q));
  // Figure 5/V.34 is NOT a quadrant — it is the Re ≡ Im ≡ 1 (mod 4) sublattice of
  // the odd-integer grid, and it spans all four quadrants. The four residue classes
  // are one orbit under 90° rotation, which is what makes the quarter a system of
  // representatives; asserting a quadrant instead asserted the wrong point set.
  const onLattice = cfg.quarter.every(p => (((p.i % 4) + 4) % 4) === 1 && (((p.q % 4) + 4) % 4) === 1);
  const maxE = Math.max(...cfg.quarter.map(p => p.i * p.i + p.q * p.q));

  const tx = new V34Coder(cfg), rx = new V34Coder(cfg);
  tx.reset(); rx.reset();
  let rng = 0x1234abcd; const bit = () => { rng ^= rng << 13; rng ^= rng >>> 17; rng ^= rng << 5; rng >>>= 0; return rng & 1; };

  const FRAMES = 20000;
  let bad = 0, sliceBad = 0, eSum = 0, eN = 0, hi = 0, lo = 0;
  for (let f = 0; f < FRAMES; f++) {
    const high = cfg.isHighFrame(f); if (high) hi++; else lo++;
    const nb = cfg.bitsForFrame(f);
    const bits = new Array(nb); for (let i = 0; i < nb; i++) bits[i] = bit();
    const pts = tx.encodeFrame(bits, high);
    if (pts.length !== SYMS_PER_FRAME) { console.log('bad frame length'); process.exit(1); }
    const sliced = pts.map(p => {
      const s = { i: sliceOdd(p.i + 0.001), q: sliceOdd(p.q + 0.001) };
      if (s.i !== p.i || s.q !== p.q) sliceBad++;
      if (cfg.labelOf(invRot(p).rep) < 0) sliceBad++;
      eSum += p.i * p.i + p.q * p.q; eN++;
      return s;
    });
    const out = rx.decodeFrame(sliced, high);
    if (out.length !== nb) { bad++; continue; }
    for (let i = 0; i < nb; i++) if (out[i] !== bits[i]) { bad++; break; }
  }
  const sw = cfg.switching ? ` swp=${cfg.swp.toString(16)} hi/lo=${hi}/${lo}` : '';
  const ok = bad === 0 && sliceBad === 0 && uniq.size === cfg.quarterPts && onLattice;
  console.log(`  ${name}: quarter=${cfg.quarterPts} q=${cfg.qBits} b=${cfg.frameBits}${sw}  meanE=${(eSum/eN).toFixed(0)} perimE=${maxE}  bitErr=${bad} sliceErr=${sliceBad}  ${ok ? 'OK ✅' : 'FAIL ❌'}`);
  return ok;
}

console.log('V.34 quarter superconstellation against Figure 5/V.34:');
let all = checkFigure5();

console.log('\nV.34 mapping-frame codec — stateful round-trip (20000 frames each):');
all &= testConfig('19200/2400');
all &= testConfig('28800/3200');
all &= testConfig('31200/3200');
all &= testConfig('33600/3429');
console.log(`\n=== ${all ? 'MAPPING-FRAME CODEC OK ✅' : 'MAPPING-FRAME CODEC FAIL ❌'} ===`);
process.exit(all ? 0 : 1);
