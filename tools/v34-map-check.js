'use strict';
// Standalone verification of the genuine V.34 mapping-frame coder (V34Mapper.js):
// random frames -> constellation points -> back to bits, with coder state
// persisting across frames (differential + trellis are stateful). No audio, no
// scrambler — isolates the encode/decode chain (shell + differential + trellis +
// mapper) across all provided configs before it is wired into the audio path.
const { V34Coder, makeConfig, CONFIGS, SYMS_PER_FRAME, sliceOdd, invRot } = require('/home/claude/synthlink/vendor/src/dsp/protocols/V34Mapper');

function testConfig(name) {
  const cfg = makeConfig(CONFIGS[name]);
  const uniq = new Set(cfg.quarter.map(p => p.i * 10000 + p.q));
  const firstQuad = cfg.quarter.every(p => p.i > 0 && p.q > 0);
  const maxE = Math.max(...cfg.quarter.map(p => p.i * p.i + p.q * p.q));

  const tx = new V34Coder(cfg), rx = new V34Coder(cfg);
  tx.reset(); rx.reset();
  let rng = 0x1234abcd; const bit = () => { rng ^= rng << 13; rng ^= rng >>> 17; rng ^= rng << 5; rng >>>= 0; return rng & 1; };

  const FRAMES = 20000;
  let bad = 0, sliceBad = 0, eSum = 0, eN = 0;
  for (let f = 0; f < FRAMES; f++) {
    const bits = new Array(cfg.frameBits); for (let i = 0; i < cfg.frameBits; i++) bits[i] = bit();
    const pts = tx.encodeFrame(bits);
    if (pts.length !== SYMS_PER_FRAME) { console.log('bad frame length'); process.exit(1); }
    const sliced = pts.map(p => {
      const s = { i: sliceOdd(p.i + 0.001), q: sliceOdd(p.q + 0.001) };
      if (s.i !== p.i || s.q !== p.q) sliceBad++;
      if (cfg.labelOf(invRot(p).rep) < 0) sliceBad++;
      eSum += p.i * p.i + p.q * p.q; eN++;
      return s;
    });
    const out = rx.decodeFrame(sliced);
    for (let i = 0; i < cfg.frameBits; i++) if (out[i] !== bits[i]) { bad++; break; }
  }
  const ok = bad === 0 && sliceBad === 0 && uniq.size === cfg.quarterPts && firstQuad;
  console.log(`  ${name}: quarter=${cfg.quarterPts} q=${cfg.qBits} b=${cfg.frameBits}  meanE=${(eSum/eN).toFixed(0)} perimE=${maxE}  bitErr=${bad} sliceErr=${sliceBad}  ${ok ? 'OK ✅' : 'FAIL ❌'}`);
  return ok;
}

console.log('V.34 mapping-frame codec — stateful round-trip (20000 frames each):');
let all = true;
all &= testConfig('19200/2400');
all &= testConfig('28800/3200');
console.log(`\n=== ${all ? 'MAPPING-FRAME CODEC OK ✅' : 'MAPPING-FRAME CODEC FAIL ❌'} ===`);
process.exit(all ? 0 : 1);
