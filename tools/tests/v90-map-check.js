'use strict';
/**
 * v90-map-check — the whole downstream mapping chain, end to end, without DSP.
 *
 * bits → [parse §5.4.2 → modulus §5.4.3 → mapper §5.4.4 → shaper §5.4.6] →
 * six PCM codewords → the real Float32/Int16 transport quantisation → slice →
 * inverse chain → bits. Asserts bit-exact recovery.
 *
 * This is the V.90 equivalent of tools/tests/v34-map-check.js and is the last thing to
 * pass before the protocol class is worth writing: if the mapping frame does not
 * round-trip here, nothing downstream can work.
 *
 * Run: node tools/tests/v90-map-check.js        (SECS/frames tunable below)
 */
const {
  makeConfig, buildConstellation, defaultMask, V90Coder,
  toFloat, fromFloat, MAG, averagePower,
} = require('../../vendor/src/dsp/protocols/V90Mapper');

let fail = 0;
const ok = (cond, msg) => { if (!cond) { console.error('  FAIL:', msg); fail++; } };

// exactly the transport helpers in server.js / public/main.js
const f2i = f => { const s = Math.max(-1, Math.min(1, f)); return (s * 32767) | 0; };
const i2f = k => k / 32768;
const overWire = signed => fromFloat(i2f(f2i(toFloat(signed))));

const cfg = makeConfig(56000);
const C = Array.from({ length: 6 }, () => buildConstellation(defaultMask()));
const prod = C.reduce((a, c) => a * c.M, 1);
console.log(`config: ${cfg.bitRate} bit/s — D=${cfg.D} bits per ${cfg.symsPerFrame}-symbol frame ` +
            `(S=${cfg.S} signs + K=${cfg.K} modulus), Sr=${cfg.Sr} shaping frames`);
console.log(`constellation: Mᵢ=${C[0].M} per interval, ∏Mᵢ=${prod.toExponential(4)} ≥ 2^${cfg.K}=${(2 ** cfg.K).toExponential(4)}`);
console.log(`frame rate ${8000 / 6} Hz × ${cfg.D} bits = ${cfg.bitRate} bit/s\n`);

for (const lookahead of [0, 1, 2, 3]) {
  const tx = new V90Coder(cfg, C, { lookahead });
  const rx = new V90Coder(cfg, C, { lookahead });
  const FRAMES = 20000;

  let seed = 987654321;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

  const sent = [];
  const emitted = [];
  for (let f = 0; f < FRAMES; f++) {
    const bits = Array.from({ length: cfg.D }, () => (rnd() < 0.5 ? 0 : 1));
    sent.push(bits);
    const syms = tx.encodeFrame(bits);
    if (syms) emitted.push(syms);
  }
  for (const fr of tx.flush()) emitted.push(fr);

  ok(emitted.length === sent.length,
     `lookahead ${lookahead}: ${emitted.length} frames out for ${sent.length} in`);

  // every emitted value must be a legal codeword of its interval, in range
  let illegal = 0, peak = 0;
  for (const fr of emitted) for (let i = 0; i < 6; i++) {
    const mag = Math.abs(fr[i]);
    peak = Math.max(peak, mag);
    if (!C[i].members.some(u => MAG[u] === mag)) illegal++;
  }
  ok(illegal === 0, `lookahead ${lookahead}: ${illegal} emitted values are not legal codewords`);

  // through the wire, then decode
  let badBits = 0, badFrames = 0;
  for (let f = 0; f < emitted.length; f++) {
    const wire = emitted[f].map(overWire);
    const got = rx.decodeFrame(wire);
    let bad = 0;
    for (let b = 0; b < cfg.D; b++) if (got[b] !== sent[f][b]) bad++;
    if (bad) { badFrames++; badBits += bad; }
  }
  const totalBits = emitted.length * cfg.D;
  ok(badBits === 0, `lookahead ${lookahead}: ${badBits} bit errors in ${totalBits}`);
  console.log(`lookahead ${lookahead}: ${emitted.length} frames, ${totalBits} bits, ` +
              `${badBits} bit errors, ${badFrames} bad frames, peak |PCM| ${peak} ` +
              `(${(toFloat(peak)).toFixed(3)} full scale)`);
}

// ── honest note on power ────────────────────────────────────────────────────
// A real digital modem is bound by Table 15/V.90 and, in the US, the FCC −12 dBm
// limit that capped real connections at 53 333 bit/s (D=40). Ours is not.
const avg = averagePower(C[0]);
const peakPow = MAG[127] * MAG[127];
console.log(`\naverage constellation power ${avg.toExponential(3)} ` +
            `(${(10 * Math.log10(avg / peakPow)).toFixed(1)} dB below a full-scale tone) — ` +
            `above what a real digital modem may emit; see PROTOCOLS.md`);

console.log(fail ? `\nFAILED (${fail})` : '\nv90-map-check OK');
process.exit(fail ? 1 : 0);
