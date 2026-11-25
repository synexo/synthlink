#!/usr/bin/env node
'use strict';
// tools/tests/v90-encoder-vector-check.js — V90Mapper's V90Coder against
// BinModem's V.90 encoder (§5.4), codeword for codeword and sign for sign, from a
// committed vector (tools/tests/vectors/bm-v90-encoder.json), so no Rust.
//
//   node tools/tests/v90-encoder-vector-check.js
//
// Each case is a CP or CPt as our analogue modem builds it, at Sr 0 to 3 and
// look-ahead 0 to 3; the same bit source goes through both encoders. Then the
// other way: BinModem's frames through our decoder must give the source back.
// Sr 0 matched before; with shaping on, our signs differed from the second frame
// on, because §5.4.5.2–.4's two differential codings (Table 4's odd-bit chain and
// t_j(k) = p′_j(k) ⊕ t_(j−1)(k)) were missing at both of our ends, so a loopback
// agreed. Regenerate with tools/bridge/examples/v90_encoder_frames.rs only when
// the pinned rev moves, and read the diff.

const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..', '..');
const M = require(path.join(ROOT, 'vendor', 'src', 'dsp', 'protocols', 'V90Mapper'));
const P4 = require(path.join(ROOT, 'vendor', 'src', 'dsp', 'protocols', 'V90Phase4'));
const V = JSON.parse(fs.readFileSync(path.join(__dirname, 'vectors', 'bm-v90-encoder.json'), 'utf8'));

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log(`  ok   ${msg}`); } else { fail++; console.log(`  FAIL ${msg}`); } }

// xorshift32 from the vector's seed, low bit — the Rust side's source.
const source = () => { let x = 0x2545f491 >>> 0; return () => { x = (x ^ (x << 13)) >>> 0; x = (x ^ (x >>> 17)) >>> 0; x = (x ^ (x << 5)) >>> 0; return x & 1; }; };
const ucodeOf = (v) => { const u = M.MAG.indexOf(Math.abs(v)); return v > 0 ? u : -u - 1000; };
const valueOf = (c) => (c >= 0 ? M.MAG[c] : -M.MAG[-c - 1000]);

for (const c of V.cases) {
  const cp = P4.parseCP(c.cp.split('').map(Number), 1);
  const cfg = c.training ? M.trainingConfig(cp.drn, cp.Sr) : M.configFromCP(cp.drn, cp.Sr);
  const built = cp.constellations.map((m) => M.buildConstellation(m));
  const C = cp.intervalIndex.map((i) => built[i] || built[0]);
  const tag = `${c.training ? 'CPt' : 'CP '} drn ${cp.drn} Sr ${cp.Sr} ld ${cp.ld}`;
  ok(cfg.D === c.frameBits, `${tag}: ${cfg.D} bits a frame, as BinModem's mapping`);

  // Encode: the same bits, the same frames out.
  const enc = new M.V90Coder(cfg, C, { coefs: cp.coefs, lookahead: cp.ld });
  const src = source(), sent = [], ours = [];
  for (let f = 0; f < c.frames.length + 8 && ours.length < c.frames.length; f++) {
    const bits = []; for (let i = 0; i < cfg.D; i++) bits.push(src());
    sent.push(bits);
    const s = enc.encodeFrame(bits);
    if (s) ours.push(s.map(ucodeOf));
  }
  let mags = 0, signs = 0;
  for (let k = 0; k < c.frames.length; k++) for (let i = 0; i < 6; i++) {
    const p = ours[k][i], q = c.frames[k][i];
    if (p === q) continue;
    if ((p < 0 ? -p - 1000 : p) !== (q < 0 ? -q - 1000 : q)) mags++; else signs++;
  }
  ok(mags === 0 && signs === 0, `${tag}: ${c.frames.length} frames identical (${mags} magnitudes, ${signs} signs differ)`);

  // Decode: BinModem's frames back to the bits it was given.
  const dec = new M.V90Coder(cfg, C, { coefs: cp.coefs, lookahead: cp.ld });
  let wrong = 0;
  c.frames.forEach((fr, k) => { const got = dec.decodeFrame(fr.map(valueOf)); for (let i = 0; i < cfg.D; i++) if (got[i] !== sent[k][i]) wrong++; });
  ok(wrong === 0, `${tag}: BinModem's frames decode to the source bits (${wrong} wrong)`);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
