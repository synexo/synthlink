'use strict';
/**
 * v90-dil-level-check — the LEVEL CHARACTER of the DIL this modem requests.
 *
 * §8.4.1/V.90 hands the whole descriptor to the analogue modem and states no
 * ordering and no power constraint, so nothing here is a transcription: every
 * bound below is OURS, and the harness exists because a free parameter with no
 * clause behind it is exactly the kind that drifts back.
 *
 * What it is protecting. The descriptor's REFc used to be the midpoint of the
 * chord being trained and the 32 segments used to be asked for in ascending
 * chord order. Both are legal. Together they made the downstream sweep 58 dB
 * monotonically for three seconds — a chord-1 segment has no symbol in it above
 * Ucode 14, a chord-8 segment none below 114, and a reference that tracks the
 * chord cannot anchor either of them. A real V.90 call's DIL is flat. So the
 * character asserted here is: a constant floor under every segment, and no long
 * climb across them.
 *
 * How it is asserted. The bounds are STATED NUMBERS, not the constants the
 * transmitter reads — a check that recomputes REFc from DIL_REF passes for any
 * value of DIL_REF and is worth nothing. The descriptor is taken off a real
 * V90 instance and put THROUGH buildDIL/parseDIL first, so what is measured is
 * what a receiver recovers from the wire rather than what the object held.
 *
 * The second half is TONALITY, and it is asserted structurally rather than as a
 * spectrum. Flattening the level left a signal that was still five times more
 * tonal than a real modem's Phase 3, because SP and TP were 11 and 7 bits and
 * repeated together 70 times inside every 768-symbol segment. What matters is
 * that the two lengths are coprime with each other and with the six-symbol data
 * frame, and that neither pattern is degenerate — a spectral-flatness threshold
 * would pin the FFT parameters it was measured with and say nothing about why.
 *
 * Revisited when the real-line receive gap closed. The analogue modem now LEARNS
 * the route from its DIL (V90Dil.js, after BinModem's): every codeword up to a
 * third of full scale but U_INFO, each in a segment of six frames, one of
 * references at U_INFO and five of the codeword. That answered the question this
 * file left open: the reference is anchored, at U_INFO, the codeword TRN1d and Jd
 * ride, so every segment carries Phase 3's own level as its floor. The order keeps
 * the old character, chords in turn so nothing climbs; the tonality rules on the
 * pattern lengths fell away, because §8.4.1 restarts SP and TP in every segment
 * and a segment is six frames, so only their first 36 bits ever play.
 *
 * Run: node tools/tests/v90-dil-level-check.js
 */
const P3 = require('../../vendor/src/dsp/protocols/V90Phase3');
const { V90 } = require('../../vendor/src/dsp/protocols/V90');

let fail = 0;
const ok = (cond, msg) => { if (!cond) { console.error('  FAIL:', msg); fail++; } };

// G.711's magnitude for a Ucode, on the 14-bit scale — Table 1/V.90, the same
// formula V90Mapper's MAG[] is built from. Restated rather than imported so a
// change there cannot silently redefine what "level" means here.
const mag = (u) => (((((u & 15) << 1) | 33) << ((u >> 4) & 7))) - 33;
const FULL = mag(127);

// ── The descriptor as a receiver gets it ────────────────────────────────────
const built = new V90('originate')._dil;
ok(built && built.n > 0, 'the analogue modem installs a DIL descriptor at construction');
const desc = P3.parseDIL(P3.buildDIL(built));
ok(desc.sync && desc.crcOk, 'the descriptor round-trips through Table 12 with a valid CRC');
ok(desc.n === built.n, `N survives the round trip (${desc.n})`);

// ── Segment levels ──────────────────────────────────────────────────────────
// RMS of a segment's own symbols, in dB relative to the full-scale codeword.
// Gain-invariant: every figure below is a difference between two of these, so
// nothing here depends on the transmitter's absolute output level, which §3.4
// leaves to the operator anyway.
const segs = P3.dilSegments(desc);
const levels = segs.map((s) => {
  let e = 0;
  for (const y of s.syms) e += mag(y.ucode) ** 2;
  return 10 * Math.log10(e / s.syms.length / FULL ** 2);
});
const lo = Math.min(...levels), hi = Math.max(...levels);
const spread = hi - lo;

// The bound. 12 dB is loose against the 6.9 dB a constant high reference
// actually produces and tight against the 58.1 dB that a per-chord one did;
// it is set to catch the failure, not to pin the current arithmetic.
ok(spread <= 12,
  `the DIL sequence spans ${spread.toFixed(1)} dB — a constant reference keeps it under 12`);

// No segment may be a hole. Same statement from the other side, and the one
// that fails first if a future descriptor probes a low chord with no anchor.
for (let i = 0; i < levels.length; i++) {
  ok(hi - levels[i] <= 12,
    `segment ${i} (chord ${segs[i].chord}, Ucode ${segs[i].ucode}) sits ` +
    `${(hi - levels[i]).toFixed(1)} dB under the loudest`);
}

// ── No crescendo ────────────────────────────────────────────────────────────
// The spread bound alone would pass a gentle ramp, and a ramp is what this is
// heard as. Bound the longest run of consecutive segments that each rise.
let run = 1, longest = 1;
for (let i = 1; i < levels.length; i++) {
  if (levels[i] > levels[i - 1]) { run++; if (run > longest) longest = run; } else run = 1;
}
ok(longest <= 4,
  `the longest run of rising segments is ${longest} of ${levels.length} — the order must not sort by level`);
ok(levels.some((v, i) => i > 0 && v < levels[i - 1]),
  'the sequence falls somewhere; a monotone DIL is a sweep, not a probe');

// ── The set that is being probed is unchanged by the ordering ───────────────
// The interleave moved the order and must not have moved the coverage: DIL
// exists to visit every chord, and an ordering bug that dropped or duplicated
// one would still pass every level bound above.
// Every codeword a constellation may use is learned, once: all up to a third of
// full scale (V90Dil's LOUDEST, 2457 on this scale) but U_INFO, which the
// references read.
const uRef = desc.ref[0];
const wanted = [];
for (let u = 0; u < 128; u++) if (u !== uRef && mag(u) * 4 <= 0.3 * 32768) wanted.push(u);
ok(JSON.stringify([...desc.ucodes].sort((a, b) => a - b)) === JSON.stringify(wanted),
  `every codeword up to a third of full scale but U_INFO is asked for, once (${desc.n} of ${wanted.length})`);
for (let i = 1; i < desc.ucodes.length; i++) {
  ok(Math.abs(desc.ucodes[i] - desc.ucodes[i - 1]) >= 3,
    `segments ${i - 1} and ${i} (Ucodes ${desc.ucodes[i - 1]}, ${desc.ucodes[i]}) are three or more apart, so a reader can tell them apart`);
}

// ── A reference must anchor, not follow ─────────────────────────────────────
ok(new Set(desc.ref).size === 1,
  `REFc is one value for all eight chords (got ${[...new Set(desc.ref)].join(',')})`);
ok(desc.ref.every((r) => r > 0),
  'REFc is non-zero — a zero-bearing DIL group would collide with the Sd discriminator');
for (const s of segs) {
  ok(s.ucode !== desc.ref[s.chord - 1],
    `segment ucode ${s.ucode} differs from its REFc — a segment where they coincide carries nothing`);
}

// ── The patterns: one frame of references, then five of the codeword ───────
// §8.4.1 restarts SP and TP at every segment, and a segment is 36 symbols, so a
// pattern longer than 36 plays only its first 36. TP is the structure itself;
// SP is the signs, and a pattern nearly all one way is a line in the spectrum.
const segLen = segs[0].length;
ok(segs.every((x) => x.length === 36), `every segment is six data frames (${segLen} symbols)`);
ok(desc.tp.length === 36 && desc.tp.every((b, n) => !!b === n >= 6), 'TP: the first frame references, the other five the codeword');
{
  const ones = desc.sp.slice(0, 36).reduce((t, b) => t + (b ? 1 : 0), 0);
  ok(ones >= 12 && ones <= 24, `SP is balanced over the 36 that play — ${ones} ones`);
}

// ── The rest of Phase 3 has to sit in the same band ─────────────────────────
// The DIL anchor and U_INFO are two ends of one choice: REFc sets where the DIL
// sits, and U_INFO sets where everything around it sits, because §8.4.5 puts
// TRN1d and Jd on the U_INFO codeword and §8.4.4 puts Sd on the codeword four
// Uchords above it (W = 16 + U_INFO, at 4 of every 6 symbols). Flattening the
// DIL without checking this would leave a flat DIL in a Phase 3 that still
// steps 45 dB on either side of it.
const analogue = new V90('originate');
const uInfo = analogue._uInfo;
ok(P3.uInfoValid(uInfo), `U_INFO ${uInfo} is inside Table 10's range`);
const trn1d = 10 * Math.log10(mag(uInfo) ** 2 / FULL ** 2);
const sd = 10 * Math.log10((4 / 6) * mag(P3.sdWUcode(uInfo)) ** 2 / FULL ** 2);
// The references ARE TRN1d's codeword, so TRN1d is the DIL's own floor carried
// through; what is bounded is the step from the DIL's loudest segment up to it,
// and up to Sd, §8.4.4's 4.3 dB above. The training codewords stop at a third of
// full scale, so the DIL sits a few dB under Phase 3: 6 and 10 dB catch a Phase 3
// that has drifted off it, where the old 45 dB steps would.
ok(uRef === uInfo, `the references are U_INFO (${uRef}), the codeword TRN1d and Jd ride`);
ok(trn1d >= lo - 3 && trn1d <= hi + 6,
  `TRN1d/Jd at ${trn1d.toFixed(1)} dB is within 6 dB above the DIL's band ${lo.toFixed(1)}…${hi.toFixed(1)}`);
ok(sd >= lo - 3 && sd <= hi + 10,
  `Sd at ${sd.toFixed(1)} dB is within 10 dB above the DIL's band ${lo.toFixed(1)}…${hi.toFixed(1)}`);

console.log(`Phase 3: TRN1d/Jd ${trn1d.toFixed(1)} dB, Sd ${sd.toFixed(1)} dB (U_INFO ${uInfo})`);
console.log(`DIL: ${desc.n} segments, ${lo.toFixed(1)} → ${hi.toFixed(1)} dB, ` +
  `spread ${spread.toFixed(1)} dB, longest rising run ${longest}`);
console.log(fail ? `\nFAILED (${fail})` : '\nv90-dil-level-check OK');
process.exit(fail ? 1 : 0);
