'use strict';

/*!
 * @license
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Copyright (C) 2026 Joseph Quinn
 *
 * `convEncode` (Figure 1/V.32bis's convolutional encoder) and `V32bisViterbi`
 * (its decoder) are ported from BinModem <https://github.com/CasualArclamp/BinModem>,
 * crates/datapump/src/v32/trellis.rs `advance` and `Decoder`, and the measure of
 * unsatisfactory reception and the rates a retrain then offers are ported from
 * crates/datapump/src/v32/startup.rs (`UNSATISFACTORY_GAP`, `stop_offering`), at
 * commit 623f935e28fe6de3a8a4f41492feb46e1bb86c3a of
 * <https://github.com/synexo/BinModem>. Copyright the BinModem authors;
 * GPL-3.0-or-later. See NOTICE.
 */

/**
 * V.32bis — 14 400 down to 4800 bit/s, per ITU-T Recommendation V.32bis (1991), operated as
 * TRUE FULL-DUPLEX continuous carrier over our WebSocket transport, building
 * directly on the proven V.32 DSP core (`protocols/V32.js`). Same carrier
 * (1800 Hz), same symbol rate (2400 baud), same role-asymmetric scramblers —
 * V.32bis is the trellis-coded speed step up from V.32, at five rates.
 *
 * ── Why full-duplex works here without an echo canceller ─────────────────────
 * Identical to V.32: real V.32bis is full-duplex on one shared 1800 Hz carrier
 * per direction and uses adaptive ECHO CANCELLATION (§1b) to separate the two
 * directions on a 2-wire line. Our two WebSocket directions are a 4-wire
 * equivalent — no self-carrier leaks into our receive — so the echo canceller
 * (EchoCanceller.js), which runs on every call as a real modem's does, finds
 * nothing there and is undone. As in V.32, the idle-`0xFF` flood
 * is avoided by carrying bytes with async start/stop (UART) framing over the
 * always-on scrambled synchronous stream: descrambled idle-mark yields no start
 * bit, hence no phantom bytes, while the carrier stays continuously up.
 *
 * ── What is genuine V.32bis here ────────────────────────────────────────────
 *   - 1800 Hz carrier, 2400 baud; **14 400, 12 000, 9600 and 7200 bit/s at 6, 5,
 *     4 and 3 data bits a symbol**, trellis-coded (§2.3), and **4800 at 2**,
 *     uncoded (§2.4).
 *   - At the coded rates the scrambled stream is grouped into Q1..Qn. Q1Q2 are
 *     DIFFERENTIALLY encoded into Y1Y2 by the exact **Table 1/V.32bis** (the
 *     trellis-coding variant, distinct from the 4800 Table 2). Y1Y2 drive a
 *     **systematic convolutional encoder** producing the redundant bit Y0
 *     (Figure 1/V.32bis). Y0Y1Y2Q3..Qn map to a point of the rate's figure: the
 *     **128-point cross** (Figure 2-1), the 64-point square (2-2), the 32-point
 *     cross (2-3) or the 16-point square (2-4), each brought to Figure 2-1's mean
 *     energy so the line level does not change with the rate (CODED).
 *   - At 4800 the dibit turns the quadrant by Table 2/V.32bis and the symbol is
 *     one of Figure 2-5's four states, the start-up's own.
 *   - The real, role-asymmetric self-synchronising scramblers (§4) — call-mode
 *     `GPC = 1+x⁻¹⁸+x⁻²³`, answer-mode `GPA = 1+x⁻⁵+x⁻²³` — each end scrambles TX
 *     with its own polynomial and descrambles RX with the peer's. This
 *     implementation is bit-exact to the §5.2.3 golden vector (scrambling ones
 *     with GPC from the zero state yields 11 11 11 11 11 11 11 11 11 00 00 01…).
 *   - The Recommendation's own start-up, §§5.2–5.3 and §6: the receiver
 *     conditioning signal's three segments (S for 256T, S̄ for 16T, TRN for 1280T)
 *     at the A/B/C/D states of Figure 2-5/V.32bis, and the R1/R2/R3 rate-signal
 *     exchange with the sequence E that ends it — the genuine **Table 5/V.32bis**
 *     bit positions (B5=4800, B6=9600, B9=7200, B10=12000, B12=14400), scrambled
 *     and differentially encoded as in Table 2/V.32bis and carried on those four
 *     states rather than as reserved bytes in the data stream. §5.2 and §5.2.3 are
 *     word for word V.32's, down to the two printed scrambler golden vectors, so
 *     the signals are shared through V32Startup.js; §6's procedure is here.
 *
 * ── Genuine-minimal, documented (not hidden) ────────────────────────────────
 *   - **Trellis-coded both ways.** Each label→point mapping IS its figure's,
 *     point for point: Figures 2-2 to 2-4 were read off the drawings by the
 *     position of each label and agree with BinModem's tables, which
 *     v32bis-viterbi-check holds. The convolutional encoder is Figure 1/V.32bis's,
 *     and the receiver decodes the code at every coded rate (V32bisViterbi,
 *     ported from BinModem with the encoder). Its loops steer by the best path's
 *     guess at the newest symbol, not the nearest point. At 45 dB of line noise the slicer it replaced
 *     lost every byte; bm-v32 holds that line, 4-wire and 2-wire.
 *   - **An adaptive equalizer, and the receiver tracks.** As in V.32: the
 *     SymbolEqualizer, symbol timing and complex channel gain acquired on S, then
 *     followed by Gardner timing, a start-up phase loop and a data-mode gain LMS,
 *     all second-order. bm-v32 holds ±100 ppm and a dispersive line, both roles.
 *   - **Every rate, chosen at start-up.** R1/R2/R3 advertise the rate set and E
 *     names the highest both ends hold; the receiver codes at the rate the far
 *     end's E names. setMaxRate() lowers this end's ceiling. §8's renegotiation
 *     without a retrain is not implemented, and nothing yet picks a rate from
 *     the line's quality: a call runs at the highest common rate or fails.
 *   - §6's half-duplex opening — AA/CC, AC/CA, the reversals, NT and MT — IS
 *     implemented, shared with V32.js through V32Preface.js, and so is the echo
 *     canceller it exists for, which runs on every call. Tested against BinModem at every rate, both roles
 *     (tools/tests/bm-v32.js), not yet against hardware.
 *   Reuses V.32's fractional-SPS (3.333) RRC synthesis + fractional matched
 *   filter (rolloff 0.25) at 1800 Hz.
 *
 * Interface matches the other protocol classes: constructor(role);
 * generateAudio(n)->Float32Array; receiveAudio(f32); write(buf); emits 'data'
 * (Buffer) and 'ready' ({bps, remoteDetected}); getters bps and carrierDetected.
 */

const { TONE_AMP, LINE_RMS, rmsAt } = require('../LineLevel');
const { EventEmitter } = require('events');
// §§5.2–5.3's signals, shared with V32.js: S, S̄, TRN, Table 2/V.32bis's
// differential coding (which is Table 1/V.32's), and the 16-bit sequences of
// Table 5/V.32bis and the E of Table 6/V.32bis.
const V32S = require('./V32Startup');
// §6's half-duplex opening — §5.4/V.32's, word for word; see V32Preface.js.
const V32P = require('./V32Preface');
const { EchoCanceller } = require('../EchoCanceller');
const { SymbolEqualizer } = require('../SymbolEqualizer');

const SR = 8000, BAUD = 2400, FC = 1800, SPS = SR / BAUD; // 3.333…
const ROLLOFF = 0.25, SPAN = 10;

// ── 128-point constellation — Table of Figure 2-1/V.32bis ───────────────────
// Transcribed from the Recommendation, indexed by the figure's own bit order
// Y0 Y1 Y2 Q3 Q4 Q5 Q6, so C128[idx] IS the figure's point for that label. The
// points lie on the checkerboard lattice Re+Im odd, |Re|,|Im| ≤ 9 — not an
// odd-integer grid, and the mapping is not free: the trellis subsets and the
// differential quadrant rotation are properties of these exact assignments.
const C128 = [
  { i:  -8, q:  -3 },   // 0000000
  { i:   8, q:  -3 },   // 0000001
  { i:   4, q:  -3 },   // 0000010
  { i:   4, q:  -7 },   // 0000011
  { i:  -4, q:  -3 },   // 0000100
  { i:  -4, q:  -7 },   // 0000101
  { i:   0, q:  -3 },   // 0000110
  { i:   0, q:  -7 },   // 0000111
  { i:  -8, q:   1 },   // 0001000
  { i:   8, q:   1 },   // 0001001
  { i:   4, q:   1 },   // 0001010
  { i:   4, q:   5 },   // 0001011
  { i:  -4, q:   1 },   // 0001100
  { i:  -4, q:   5 },   // 0001101
  { i:   0, q:   1 },   // 0001110
  { i:   0, q:   5 },   // 0001111
  { i:   8, q:   3 },   // 0010000
  { i:  -8, q:   3 },   // 0010001
  { i:  -4, q:   3 },   // 0010010
  { i:  -4, q:   7 },   // 0010011
  { i:   4, q:   3 },   // 0010100
  { i:   4, q:   7 },   // 0010101
  { i:   0, q:   3 },   // 0010110
  { i:   0, q:   7 },   // 0010111
  { i:   8, q:  -1 },   // 0011000
  { i:  -8, q:  -1 },   // 0011001
  { i:  -4, q:  -1 },   // 0011010
  { i:  -4, q:  -5 },   // 0011011
  { i:   4, q:  -1 },   // 0011100
  { i:   4, q:  -5 },   // 0011101
  { i:   0, q:  -1 },   // 0011110
  { i:   0, q:  -5 },   // 0011111
  { i:   2, q:  -9 },   // 0100000
  { i:   2, q:   7 },   // 0100001
  { i:   2, q:   3 },   // 0100010
  { i:   6, q:   3 },   // 0100011
  { i:   2, q:  -5 },   // 0100100
  { i:   6, q:  -5 },   // 0100101
  { i:   2, q:  -1 },   // 0100110
  { i:   6, q:  -1 },   // 0100111
  { i:  -2, q:  -9 },   // 0101000
  { i:  -2, q:   7 },   // 0101001
  { i:  -2, q:   3 },   // 0101010
  { i:  -6, q:   3 },   // 0101011
  { i:  -2, q:  -5 },   // 0101100
  { i:  -6, q:  -5 },   // 0101101
  { i:  -2, q:  -1 },   // 0101110
  { i:  -6, q:  -1 },   // 0101111
  { i:  -2, q:   9 },   // 0110000
  { i:  -2, q:  -7 },   // 0110001
  { i:  -2, q:  -3 },   // 0110010
  { i:  -6, q:  -3 },   // 0110011
  { i:  -2, q:   5 },   // 0110100
  { i:  -6, q:   5 },   // 0110101
  { i:  -2, q:   1 },   // 0110110
  { i:  -6, q:   1 },   // 0110111
  { i:   2, q:   9 },   // 0111000
  { i:   2, q:  -7 },   // 0111001
  { i:   2, q:  -3 },   // 0111010
  { i:   6, q:  -3 },   // 0111011
  { i:   2, q:   5 },   // 0111100
  { i:   6, q:   5 },   // 0111101
  { i:   2, q:   1 },   // 0111110
  { i:   6, q:   1 },   // 0111111
  { i:   9, q:   2 },   // 1000000
  { i:  -7, q:   2 },   // 1000001
  { i:  -3, q:   2 },   // 1000010
  { i:  -3, q:   6 },   // 1000011
  { i:   5, q:   2 },   // 1000100
  { i:   5, q:   6 },   // 1000101
  { i:   1, q:   2 },   // 1000110
  { i:   1, q:   6 },   // 1000111
  { i:   9, q:  -2 },   // 1001000
  { i:  -7, q:  -2 },   // 1001001
  { i:  -3, q:  -2 },   // 1001010
  { i:  -3, q:  -6 },   // 1001011
  { i:   5, q:  -2 },   // 1001100
  { i:   5, q:  -6 },   // 1001101
  { i:   1, q:  -2 },   // 1001110
  { i:   1, q:  -6 },   // 1001111
  { i:  -9, q:  -2 },   // 1010000
  { i:   7, q:  -2 },   // 1010001
  { i:   3, q:  -2 },   // 1010010
  { i:   3, q:  -6 },   // 1010011
  { i:  -5, q:  -2 },   // 1010100
  { i:  -5, q:  -6 },   // 1010101
  { i:  -1, q:  -2 },   // 1010110
  { i:  -1, q:  -6 },   // 1010111
  { i:  -9, q:   2 },   // 1011000
  { i:   7, q:   2 },   // 1011001
  { i:   3, q:   2 },   // 1011010
  { i:   3, q:   6 },   // 1011011
  { i:  -5, q:   2 },   // 1011100
  { i:  -5, q:   6 },   // 1011101
  { i:  -1, q:   2 },   // 1011110
  { i:  -1, q:   6 },   // 1011111
  { i:  -3, q:   8 },   // 1100000
  { i:  -3, q:  -8 },   // 1100001
  { i:  -3, q:  -4 },   // 1100010
  { i:  -7, q:  -4 },   // 1100011
  { i:  -3, q:   4 },   // 1100100
  { i:  -7, q:   4 },   // 1100101
  { i:  -3, q:   0 },   // 1100110
  { i:  -7, q:   0 },   // 1100111
  { i:   1, q:   8 },   // 1101000
  { i:   1, q:  -8 },   // 1101001
  { i:   1, q:  -4 },   // 1101010
  { i:   5, q:  -4 },   // 1101011
  { i:   1, q:   4 },   // 1101100
  { i:   5, q:   4 },   // 1101101
  { i:   1, q:   0 },   // 1101110
  { i:   5, q:   0 },   // 1101111
  { i:   3, q:  -8 },   // 1110000
  { i:   3, q:   8 },   // 1110001
  { i:   3, q:   4 },   // 1110010
  { i:   7, q:   4 },   // 1110011
  { i:   3, q:  -4 },   // 1110100
  { i:   7, q:  -4 },   // 1110101
  { i:   3, q:   0 },   // 1110110
  { i:   7, q:   0 },   // 1110111
  { i:  -1, q:  -8 },   // 1111000
  { i:  -1, q:   8 },   // 1111001
  { i:  -1, q:   4 },   // 1111010
  { i:  -5, q:   4 },   // 1111011
  { i:  -1, q:  -4 },   // 1111100
  { i:  -5, q:  -4 },   // 1111101
  { i:  -1, q:   0 },   // 1111110
  { i:  -5, q:   0 },   // 1111111
];

// ── Figures 2-2, 2-3 and 2-4/V.32bis — the 12 000, 9600 and 7200 constellations ─
// Extracted from the Recommendation's drawn figures by the position of each label
// on the page, indexed as C128 is (Y0 Y1 Y2 then the uncoded Q bits), and checked
// point for point against BinModem's trellis.rs POINTS_64, POINTS_32 and
// POINTS_16. Figure 2-2 is the odd 8×8 square (mean energy 42), 2-3 the cross of
// 32 on the checkerboard (10; Figure 3/V.32's own), 2-4 the odd 4×4 square (10).
// Each is drawn to its own scale; CODED below brings them to Figure 2-1's.
const C64 = [
  { i:  7, q:  1 },   // 000000
  { i:  3, q:  5 },   // 000001
  { i:  7, q: -7 },   // 000010
  { i: -5, q:  5 },   // 000011
  { i:  3, q: -3 },   // 000100
  { i: -1, q:  1 },   // 000101
  { i: -1, q: -7 },   // 000110
  { i: -5, q: -3 },   // 000111
  { i: -7, q: -1 },   // 001000
  { i: -3, q: -5 },   // 001001
  { i: -7, q:  7 },   // 001010
  { i:  5, q: -5 },   // 001011
  { i: -3, q:  3 },   // 001100
  { i:  1, q: -1 },   // 001101
  { i:  1, q:  7 },   // 001110
  { i:  5, q:  3 },   // 001111
  { i: -1, q:  5 },   // 010000
  { i: -5, q:  1 },   // 010001
  { i:  7, q:  5 },   // 010010
  { i: -5, q: -7 },   // 010011
  { i:  3, q:  1 },   // 010100
  { i: -1, q: -3 },   // 010101
  { i:  7, q: -3 },   // 010110
  { i:  3, q: -7 },   // 010111
  { i:  1, q: -5 },   // 011000
  { i:  5, q: -1 },   // 011001
  { i: -7, q: -5 },   // 011010
  { i:  5, q:  7 },   // 011011
  { i: -3, q: -1 },   // 011100
  { i:  1, q:  3 },   // 011101
  { i: -7, q:  3 },   // 011110
  { i: -3, q:  7 },   // 011111
  { i: -5, q: -1 },   // 100000
  { i: -1, q: -5 },   // 100001
  { i: -5, q:  7 },   // 100010
  { i:  7, q: -5 },   // 100011
  { i: -1, q:  3 },   // 100100
  { i:  3, q: -1 },   // 100101
  { i:  3, q:  7 },   // 100110
  { i:  7, q:  3 },   // 100111
  { i:  5, q:  1 },   // 101000
  { i:  1, q:  5 },   // 101001
  { i:  5, q: -7 },   // 101010
  { i: -7, q:  5 },   // 101011
  { i:  1, q: -3 },   // 101100
  { i: -3, q:  1 },   // 101101
  { i: -3, q: -7 },   // 101110
  { i: -7, q: -3 },   // 101111
  { i:  1, q: -7 },   // 110000
  { i:  5, q: -3 },   // 110001
  { i: -7, q: -7 },   // 110010
  { i:  5, q:  5 },   // 110011
  { i: -3, q: -3 },   // 110100
  { i:  1, q:  1 },   // 110101
  { i: -7, q:  1 },   // 110110
  { i: -3, q:  5 },   // 110111
  { i: -1, q:  7 },   // 111000
  { i: -5, q:  3 },   // 111001
  { i:  7, q:  7 },   // 111010
  { i: -5, q: -5 },   // 111011
  { i:  3, q:  3 },   // 111100
  { i: -1, q: -1 },   // 111101
  { i:  7, q: -1 },   // 111110
  { i:  3, q: -5 },   // 111111
];

const C32 = [
  { i: -4, q:  1 },   // 00000
  { i:  0, q: -3 },   // 00001
  { i:  0, q:  1 },   // 00010
  { i:  4, q:  1 },   // 00011
  { i:  4, q: -1 },   // 00100
  { i:  0, q:  3 },   // 00101
  { i:  0, q: -1 },   // 00110
  { i: -4, q: -1 },   // 00111
  { i: -2, q:  3 },   // 01000
  { i: -2, q: -1 },   // 01001
  { i:  2, q:  3 },   // 01010
  { i:  2, q: -1 },   // 01011
  { i:  2, q: -3 },   // 01100
  { i:  2, q:  1 },   // 01101
  { i: -2, q: -3 },   // 01110
  { i: -2, q:  1 },   // 01111
  { i: -3, q: -2 },   // 10000
  { i:  1, q: -2 },   // 10001
  { i: -3, q:  2 },   // 10010
  { i:  1, q:  2 },   // 10011
  { i:  3, q:  2 },   // 10100
  { i: -1, q:  2 },   // 10101
  { i:  3, q: -2 },   // 10110
  { i: -1, q: -2 },   // 10111
  { i:  1, q:  4 },   // 11000
  { i: -3, q:  0 },   // 11001
  { i:  1, q:  0 },   // 11010
  { i:  1, q: -4 },   // 11011
  { i: -1, q: -4 },   // 11100
  { i:  3, q:  0 },   // 11101
  { i: -1, q:  0 },   // 11110
  { i: -1, q:  4 },   // 11111
];

const C16 = [
  { i:  3, q: -3 },   // 0000
  { i: -1, q:  1 },   // 0001
  { i: -3, q:  3 },   // 0010
  { i:  1, q: -1 },   // 0011
  { i:  3, q:  1 },   // 0100
  { i: -1, q: -3 },   // 0101
  { i: -3, q: -1 },   // 0110
  { i:  1, q:  3 },   // 0111
  { i: -1, q:  3 },   // 1000
  { i:  3, q: -1 },   // 1001
  { i:  1, q: -3 },   // 1010
  { i: -3, q:  1 },   // 1011
  { i: -3, q: -3 },   // 1100
  { i:  1, q:  1 },   // 1101
  { i:  3, q:  3 },   // 1110
  { i: -1, q: -1 },   // 1111
];

// Per coded rate: data bits a symbol and the figure. The four figures are drawn at
// mean energies 41, 42, 10 and 10, and a modem does not change its line level with
// its rate, so each is scaled to C128's 41 (BinModem's `scaled` does the same,
// to Figure 1/V.32's 10): the receiver and the start-up states stay at one scale.
function scaledTable(pts) {
  const e = pts.reduce((t, p) => t + p.i * p.i + p.q * p.q, 0) / pts.length;
  const g = Math.sqrt(41 / e);
  return { figureE: e, pts: pts.map((p) => ({ i: p.i * g, q: p.q * g })) };
}
const CODED = {
  7200:  { bits: 3, figure: C16,  ...scaledTable(C16) },
  9600:  { bits: 4, figure: C32,  ...scaledTable(C32) },
  12000: { bits: 5, figure: C64,  ...scaledTable(C64) },
  14400: { bits: 6, figure: C128, ...scaledTable(C128) },
};

const ckey = (i, q) => i * 100 + q;
// point -> index (0..127) for bit recovery
const IDX = new Map();
for (let k = 0; k < C128.length; k++) IDX.set(ckey(C128[k].i, C128[k].q), k);

// Slice a derotated point to the nearest constellation point. Rounding lands on
// the integer grid; half of it is off-lattice (Re+Im even), so the coordinate
// with the larger rounding residual moves one step. A point outside the figure's
// boundary falls through to an exhaustive nearest search over the 128.
function slicePoint(xI, xQ) {
  let i = Math.round(xI), q = Math.round(xQ);
  if (((i + q) & 1) === 0) {
    const di = xI - i, dq = xQ - q;
    if (Math.abs(di) >= Math.abs(dq)) i += di >= 0 ? 1 : -1;
    else q += dq >= 0 ? 1 : -1;
  }
  if (IDX.has(ckey(i, q))) return { i, q };
  let best = C128[0], bd = Infinity;
  for (const p of C128) {
    const d = (xI - p.i) ** 2 + (xQ - p.q) ** 2;
    if (d < bd) { bd = d; best = p; }
  }
  return { i: best.i, q: best.q };
}

// ── Table 1/V.32bis — differential quadrant coding WITH trellis coding ───────
// din = (Q1<<1)|Q2 ; y = (Y1<<1)|Y2. TAB1[din][yPrev] = yNew.
const TAB1 = [
  [0, 1, 2, 3],   // Q1Q2 = 00
  [1, 0, 3, 2],   // Q1Q2 = 01
  [2, 3, 1, 0],   // Q1Q2 = 10
  [3, 2, 0, 1],   // Q1Q2 = 11
];
// inverse: INV1[yPrev][yNew] = din
const INV1 = [[], [], [], []];
for (let din = 0; din < 4; din++) for (let yp = 0; yp < 4; yp++) INV1[yp][TAB1[din][yp]] = din;

// Figure 1/V.32bis's 8-state convolutional encoder (Figure 2/V.32's, and V.17's),
// which produces the redundant bit Y0 from Y1 Y2. State {a, b, c} is the three
// delay elements T1, T2, T3: Y0 is T3's CURRENT contents, and the two curved
// gates in the drawing are ANDs, which is why the code is not linear.
//
// Ported from BinModem's trellis.rs `advance`, which is read off the drawing and
// checked by its Viterbi decoder. What this replaced was an invented FSM — any
// deterministic FSM puts a valid-LOOKING point set on the line, and a receiver
// that slices without Viterbi (this repo's) reads it perfectly — so a real V.32bis
// receiver decoded every symbol on the wrong trellis path: BinModem turned
// 14 400 bit/s of idle marks into a flood of bytes.
function convEncode(st, Y1, Y2) {
  const Y0 = st.c;
  const w = st.b ^ Y2;                    // the node one AND gate reads
  const na = st.c;
  const nb = st.a ^ Y1 ^ Y2 ^ (st.c & w);
  const nc = w ^ (Y1 & st.c);
  st.a = na; st.b = nb; st.c = nc;
  return Y0;
}

// The trellis as a table: from state (a b c packed high to low) and Y1 Y2, the
// state that follows and the subset Y0 Y1 Y2 the branch carries. Built from
// convEncode itself, so the decoder cannot drift from what is transmitted.
const TRELLIS = [];
for (let from = 0; from < 8; from++) {
  TRELLIS.push([]);
  for (let y = 0; y < 4; y++) {
    const st = { a: (from >> 2) & 1, b: (from >> 1) & 1, c: from & 1 };
    const y0 = convEncode(st, (y >> 1) & 1, y & 1);
    TRELLIS[from].push({ to: (st.a << 2) | (st.b << 1) | st.c, k: (y0 << 2) | y });
  }
}
const VIT_DEPTH = 24;      // BinModem's: the eight paths have merged long before this

/**
 * The receiver's decoder for Figure 1's code: V.32bis §2.3 run backwards, since
 * the Recommendation specifies only the encoder. A slicer takes the nearest of
 * 128 points and errs once noise passes half their spacing; this considers only
 * sequences the encoder could have produced. Ported from BinModem's `Decoder`.
 *
 * Every state starts equally likely: the encoder starts at zero, but a receiver
 * joins a connection already running. The differential decode (Table 1) is done
 * on the decided Y1 Y2, VIT_DEPTH symbols late, against the previous decision.
 *
 * One decoder for every coded rate: `table` is a CODED entry, whose bits − 2
 * uncoded bits choose among the 2^(bits−2) points of each of the eight subsets.
 */
class V32bisViterbi {
  constructor(prevY = 0, table = CODED[14400]) {
    this.pts = table.pts;
    this.u = table.bits - 2;
    this.bitsOut = table.bits;
    this.metrics = new Float64Array(8);
    this.history = [];
    this.previous = prevY;
    this.cost = new Float64Array(8);
    this.pick = new Uint8Array(8);
  }

  /** One received point (C128 units); the bits Q1..Qn of the symbol VIT_DEPTH back, or null. */
  push(x, y) {
    const U = this.u, M = 1 << U, pts = this.pts;
    // What each subset costs, and which of its points it is.
    for (let k = 0; k < 8; k++) {
      let best = Infinity, q = 0;
      for (let u = 0; u < M; u++) {
        const p = pts[(k << U) | u];
        const d = (x - p.i) * (x - p.i) + (y - p.q) * (y - p.q);
        if (d < best) { best = d; q = u; }
      }
      this.cost[k] = best; this.pick[k] = q;
    }
    const next = new Float64Array(8).fill(Infinity);
    const from = new Uint8Array(8), bits = new Uint16Array(8);
    for (let f = 0; f < 8; f++) {
      const m = this.metrics[f];
      for (let yy = 0; yy < 4; yy++) {
        const t = TRELLIS[f][yy];
        const v = m + this.cost[t.k];
        if (v < next[t.to]) { next[t.to] = v; from[t.to] = f; bits[t.to] = (yy << U) | this.pick[t.k]; }
      }
    }
    let floor = Infinity, bestState = 0;
    for (let k = 0; k < 8; k++) if (next[k] < floor) { floor = next[k]; bestState = k; }
    for (let k = 0; k < 8; k++) next[k] -= floor;
    this.metrics = next;
    this.history.push({ from, bits });
    // The best path's point for the symbol just offered (BinModem's `tentative`):
    // what the receiver's loops steer by. They cannot wait VIT_DEPTH symbols, and
    // the nearest of 128 points is the worst guess available. Y0 is the delay
    // element the path came from, so the path already knows it.
    {
      const b = bits[bestState], y0 = from[bestState] & 1;
      this.tentative = pts[(y0 << this.bitsOut) | b];
    }
    if (this.history.length <= VIT_DEPTH) return null;
    // Back along the best path to the oldest symbol held.
    let st = bestState;
    for (let h = this.history.length - 1; h > 0; h--) st = this.history[h].from[st];
    const held = this.history.shift().bits[st];
    const yNew = (held >> U) & 3;
    const din = INV1[this.previous][yNew];
    this.previous = yNew;
    const out = [(din >> 1) & 1, din & 1];
    for (let b = U - 1; b >= 0; b--) out.push((held >> b) & 1);
    return out;
  }
}

function rrcAt(t) {
  const b = ROLLOFF;
  if (Math.abs(t) < 1e-8) return 1 - b + 4 * b / Math.PI;
  if (Math.abs(Math.abs(4 * b * t) - 1) < 1e-6) {
    return (b / Math.SQRT2) *
      ((1 + 2 / Math.PI) * Math.sin(Math.PI / (4 * b)) +
       (1 - 2 / Math.PI) * Math.cos(Math.PI / (4 * b)));
  }
  const pt = Math.PI * t;
  return (Math.sin(pt * (1 - b)) + 4 * b * t * Math.cos(pt * (1 + b))) /
         (pt * (1 - (4 * b * t) * (4 * b * t)));
}
let RRC_G = 1;
{ let s = 0; for (let k = -SPAN * 4; k <= SPAN * 4; k++) s += rrcAt(k / 4) ** 2; RRC_G = 1 / Math.sqrt(s / 4); }
const rrc = t => rrcAt(t) * RRC_G;

// Passband amplitude. Figure 2-1's points have mean energy exactly 41 (RMS
// 6.403), scaled to V32.js's line level: about 0.2 RMS, −14 dBFS, which is
// −10.7 dBm0 on a G.711 line (full scale +3.17 dBm0) — the customary modem
// transmit level. This was half that (−20 dBFS) and BinModem's V.32 start-up,
// whose tone detectors stop at −42 dBFS, did not hear the AC/CA reversal at it;
// a real line's 10–30 dB of loss on top would have lost it anywhere.
// −10 dBm0 (LineLevel.js). 0.04526 measured −7.6, rescaled by that.
const TX_GAIN = 0.04526 * LINE_RMS / rmsAt(-7.6);

const UART_ARM_MARKS = 8;

// ON above −43 dBm0 and OFF below −48, V.32's circuit 109 thresholds as V.21's:
// mean |x| is about 0.8 of a QAM signal's RMS, and full scale is +3.17 dBm0. They
// were 0.015 and 0.006 (−29 and −37), and a far end after 20 dB of loss, at −30,
// was never heard at all.
const RX_A = 0.02, RX_HI = 0.0028, RX_LO = 0.00157, RX_HANG = 48;
// S's onset in the hunt: the baseband magnitude against the level being received,
// half of it, which is what the absolute 0.04 was at our own level.
const ONSET_FRAC = 0.5;

// ── §5.3 / Table 5/V.32bis — what this build may advertise ─────────────────
// The full V.32bis rate set, every one wired for data: the four trellis rates on
// CODED's figures and 4800 on Figure 2-5's four states. R3 and E name the highest
// both ends advertise; setMaxRate() lowers this end's ceiling.
const RATE_SET = [4800, 7200, 9600, 12000, 14400];

// Figure 2-5/V.32bis's four states are drawn on their OWN signal-space diagram —
// mean symbol energy 10 — while the data points come from Figure 2-1, whose mean
// energy is 41. Two diagrams at two scales for one modem's line power, so the
// conditioning signal and the rate signals are scaled to the data burst's energy.
// V.32 needs no such factor: there, both come from Figure 1.
const SU_GAIN = V32S.gainFor(41);
const STATE_R = Math.sqrt(V32S.STATE_MEAN_E) * SU_GAIN;   // the four states' radius, data units
// Closest spacing of each rate's points, in the units the receiver decides in.
const SPACING = { 4800: closest(V32S.ROT.map((p) => ({ i: p.i * SU_GAIN, q: p.q * SU_GAIN }))) };
for (const r in CODED) SPACING[r] = closest(CODED[r].pts);

// The echo canceller trains on this end's first TRN and the receiver idles through
// the first conditioning signal and EC_GUARD after it, as in V32.js: §6.2's
// procedure is §5.4.2's, and its note 3 is what puts the training there.
const EC_GUARD = 160;

// §7, retrain, as V32.js (§5.5/V.32): the far end's retrain signal is answered
// after 128 T, and the UART stops taking bits once it has stood for RETRAIN_MUTE,
// before any of it is decoded. This end retrains on BinModem's measure of
// unsatisfactory reception, offering then only the rates the error leaves room for.
const RETRAIN_MUTE = 16;
const UNSAT_AVG = 100;
// BinModem's is 0.25, tuned on its own receiver. Ours reads 0.26 at 14 400 on a
// 2-wire line at 45 dB that it decodes exactly, and 0.37–0.44 under noise it
// cannot read, so 0.30 is between: at 0.25 it retrained a call that was working.
const UNSAT_GAP = 0.30;
const UNSAT_HOLD = 2400;
const RETRAIN_PATIENCE = 5.0;
const R1_ENDED = 8;
// Start-up symbols of a burst before its error counts: S's 256 and the first of
// TRN, while the equaliser is still learning the line.
const SU_MEASURE_FROM = 512;
// How much of the retrain threshold the start-up's error may reach for a rate to
// be offered. Data runs a little above it: at 0.537 of 12 000's 0.593 a call came
// up at 12 000 and retrained to 9600; 14 400 at 45 dB reads 0.34 of its 0.42.
const TRN_MARGIN = 0.85;
// An error still falling says the equaliser is still learning, not what the line
// is: on a 12 dB tilt it fell from 3.3 to 0.6 in the last 0.4 s before R1, and 14 400
// read as 9600. Compared with its value TREND_SPAN·2 symbols before; falling faster
// than TREND_FALL, nothing is restricted and a retrain is left to judge.
const TREND_SPAN = 128;
const TREND_FALL = 1.15;
function closest(pts) {
  let d = Infinity;
  for (const a of pts) for (const b of pts) if (a !== b) d = Math.min(d, Math.hypot(a.i - b.i, a.q - b.q));
  return d;
}

// The receive equaliser, as V32.js: ±EQ_L symbols at T/2, trained on start-up
// symbols within EQ_GATE of S's four states, decision-directed in data, the
// decision being the Viterbi path's guess at the newest symbol.
const EQ_L = 8;
const EQ_MU_TRAIN = 0.03;
const EQ_MU_DATA = 0.003;
const EQ_GATE = 0.5;
// The data-mode step's gear: ×1 at or under EQ_GEAR_FROM of the constellation's
// spacing, rising with the error to ×EQ_GEAR_MAX.
const EQ_GEAR_FROM = 0.07;
const EQ_GEAR_MAX = 4;
const EQ_GEAR_TRN = 3;               // training's ceiling: its step is ten times data's

// Tracking, as V32.js: Gardner timing through start-up and data, the start-up
// phase against S's four states, and a complex-gain LMS against the sliced point
// in data. See V32.js for why (±100 ppm on the far clock) and the sizes.
const TRK_TIMING = 0.005;
const TRK_TFREQ = 2e-5;
const TRK_PHASE = 0.03;
const TRK_GAIN = 0.02;
const TRK_FREQ = 3e-4;

// Self-validation, at module load. There is no config builder here to hang these
// off, so the relations the Recommendation fixes are
// asserted directly, and a hand-edit that breaks one fails loudly at require()
// instead of producing a link that works only against itself.
(function validate() {
  const bad = m => { throw new Error(`V.32bis config: ${m}`); };
  // §2.3.1 and Figures 2-1 to 2-4, for each coded rate: bits a symbol make the
  // rate, and the coded symbol carries one more bit (Y0), so the figure is
  // 2^(bits+1) points.
  for (const [rate, t] of Object.entries(CODED)) {
    const fig = t.figure, n = fig.length, U = t.bits - 2, at = `${rate}:`;
    if (t.bits * BAUD !== +rate) bad(`${at} ${t.bits} bits × ${BAUD} baud ≠ ${rate} bit/s`);
    if (n !== 1 << (t.bits + 1)) bad(`${at} figure has ${n} points; ${t.bits} data bits + Y0 needs ${1 << (t.bits + 1)}`);
    const idx = new Map(fig.map((p, k) => [ckey(p.i, p.q), k]));
    if (idx.size !== n) bad(`${at} the figure's points are not distinct`);
    // Each figure on its lattice: the crosses (2-1, 2-3) on the checkerboard
    // Re+Im odd, the squares (2-2, 2-4) on the odd integers. A transcription slip
    // off the lattice fails here.
    const cross = rate === '14400' || rate === '9600';
    for (const p of fig) {
      const ok = cross ? ((p.i + p.q) & 1) === 1 : (p.i & 1) === 1 && (p.q & 1) === 1;
      if (!ok) bad(`${at} point (${p.i},${p.q}) is off the figure's lattice`);
    }
    // §2.3.1 differential quadrant coding: rotating the plane by 90° must carry a
    // point to another point that keeps Q3 upwards, flips the trellis bit Y0 and
    // advances Y1Y2 by one quadrant. This is what pins the labelling — a shuffled
    // map satisfies the bijection above but not this.
    for (let k = 0; k < n; k++) {
      const p = fig[k], r = idx.get(ckey(-p.q, p.i));
      if (r === undefined) bad(`${at} 90° rotation of (${p.i},${p.q}) is not a point`);
      const qm = (1 << U) - 1;
      if ((r & qm) !== (k & qm)) bad(`${at} 90° rotation of index ${k} changes Q3 upwards`);
      if ((r >> t.bits) === (k >> t.bits)) bad(`${at} 90° rotation of index ${k} does not flip Y0`);
      const y = (k >> U) & 3, ry = (r >> U) & 3;
      if (ry !== [3, 2, 0, 1][y]) bad(`${at} 90° rotation of index ${k} misrotates Y1Y2`);
    }
    // And scaled to Figure 2-1's mean energy, so a change of rate is not a change
    // of level.
    const e = t.pts.reduce((m, p) => m + p.i * p.i + p.q * p.q, 0) / n;
    if (Math.abs(e - 41) > 1e-9) bad(`${at} scaled mean energy is ${e}, not 41`);
  }
  if (CODED[14400].figure !== C128 || CODED[14400].pts.some((p, k) => p.i !== C128[k].i || p.q !== C128[k].q)) {
    bad('14 400 is not Figure 2-1 at its own scale');
  }
  const figE = { 14400: 41, 12000: 42, 9600: 10, 7200: 10 };
  for (const r in figE) if (CODED[r].figureE !== figE[r]) bad(`Figure for ${r} has mean energy ${CODED[r].figureE}, not ${figE[r]}`);
  if (IDX.size !== C128.length) bad('constellation index map is not a bijection');
  // Figure 2-5's four states must scale to Figure 2-1's mean symbol energy, which
  // is what SU_GAIN is for and what keeps the start-up and the data at one power.
  if (Math.abs(V32S.STATE_MEAN_E * SU_GAIN * SU_GAIN - 41) > 1e-9) {
    bad('the start-up states do not scale to the data constellation energy');
  }
  // Table 5/V.32bis: this build's rate set must be exactly what the codec can
  // advertise, every one of them coded (4800 by the four states, the rest by CODED).
  const codecRates = V32S.V32BIS_RATES.rates.join(',');
  if (RATE_SET.slice().sort((a, b) => a - b).join(',') !== codecRates) {
    bad(`rate set [${RATE_SET}] is not Table 5/V.32bis's [${codecRates}]`);
  }
  for (const r of RATE_SET) if (r !== 4800 && !CODED[r]) bad(`rate ${r} has no constellation`);
})();

// ── §§5.2–5.3 start-up constants; see V32.js for the clause each one is ─────
const TRN_SYMBOLS = V32S.TRN_MIN_SYMBOLS;     // §5.2.3's "at least 1280"
const RATE_MIN_REPEATS = 6;                   // §5.3.1 needs two, after convergence
const E_TO_DATA_SYMBOLS = 128;                // §6.1 / §6.2
const RUN_CONFIRM = 12;
const GATE_TIMEOUT = Math.round(6.0 * SR);

// ── Audible startup (V.25 answer tone) ──────────────────────────────────────
const ANS_TONE_FREQ    = 2100;
const ANS_TONE_AMP     = TONE_AMP;           // −10 dBm0 (LineLevel.js)
const ANS_TONE_SAMPLES = Math.round(1.0 * SR);
const ANS_SILENCE      = Math.round(0.075 * SR);  // V.25 §2.2's 75 ms after the tone
const PREFACE_GAP      = Math.ceil(16 * SPS);       // §6.2: silent 16 T after the drop

class V32bis extends EventEmitter {
  constructor(role) {
    super();
    this.role = role === 'originate' ? 'originate' : 'answer';
    this._ready = false;
    if (this.role === 'originate') { this._txTap = 17; this._rxTap = 4; }
    else                           { this._txTap = 4;  this._rxTap = 17; }
    this._rate = 14400;
    this._rates = RATE_SET;

    // TX
    this.txByteQ = [];
    this.scr = new Array(23).fill(0);
    this.txState = 'idle';
    this.txMode = 'qam';
    // One sample clock both ways, for §6's 64 ± 2 T turnarounds; see V32.js.
    this._clockTx = 0;
    this._clockRx = 0;
    this._ec = new EchoCanceller();
    // On, as in a real modem, which cannot tell a 2-wire line from a 4-wire one: on
    // no echo it learns nothing, and a training that removed nothing is undone.
    this._ecOn = true;
    this._ecSpan = { start: null, trnStart: null, searchFrom: null, trnEnd: null, end: null };
    this._ecState = 'before';     // before → training → held
    this._pre = this.role === 'originate' ? new V32P.CallPreface(SPS) : new V32P.AnswerPreface(SPS);
    this._preActive = false;
    this._rxGated = true;
    this._connectQ = this._buildConnectScript(this.role);
    this._idleSamples = 0;
    this._resetTxBurst();

    // RX
    this.rxLevel = 0;
    this.rxOn = false;
    this.rxLow = 0;
    this.peerRate = 0;
    this.rateMismatch = null;

    // §6 progress; see V32.js for why these survive _resetRx().
    this._sawPeerS = false;
    this._sawR1 = false;
    this._sawR2 = false;
    this._sawR3 = false;
    this._sawPeerE = false;
    this._rxStage = this.role === 'originate' ? 'r1' : 'r2';
    this._resetRx();
  }

  /**
   * The echo canceller, and the receiver idling through this end's own training.
   * ON by default, whatever the line: a real modem runs both on every call. The
   * canceller needs receive sample n to have arrived as transmit sample n left; a
   * lockstep line gives that, and in ModemDSP ClockPair.js does. Off only for a
   * negative control.
   */
  setEchoCanceller(on) { this._ecOn = !!on; }

  /**
   * Advertise no rate above `bps` (one of Table 5's). Every rate is wired, so
   * this is the user's choice of a ceiling, a line too poor for the top rate, or a
   * test making a peer that would take 14 400 run a lower one. Call before start-up.
   */
  setMaxRate(bps) {
    const rates = RATE_SET.filter((r) => r <= bps);
    if (!rates.length) throw new Error(`V.32bis has no rate at or below ${bps}`);
    this._rates = rates;
    this._rate = rates[rates.length - 1];
  }

  /**
   * Handshake tells us a genuine V.8 exchange (ANSam/CM/JM/CJ) already ran.
   * The answerer's ANSam has therefore been heard and this class must not emit
   * its own 2100 Hz answer tone on top of it — a second tone lands during the
   * peer's post-CJ training and trips its energy-onset acquisition.
   */
  setV8Complete(done) {
    if (!done) return;
    this._connectQ = this._connectQ.filter(step => step.kind !== 'tone');
    if (this._pre.skipListen) this._pre.skipListen();   // ANSam was the answer tone
  }

  /** §6's round-trip counts once measured (symbols): NT at the call modem, MT at the answer modem. */
  get roundTrip() { return this.role === 'originate' ? this._pre.nt : this._pre.mt; }

  get carrierDetected() { return this.rxOn || this.acq; }
  get bps() { return this._rate; }

  /**
   * V.42 (vendor/src/ec): while a link is set, data-mode bits come from and go to
   * it — the error-control stack's synchronous stream — in place of start-stop
   * characters; null puts the characters back.
   */
  setBitLink(link) { this._link = link || null; }
  /** Whether data bits are crossing the line now: not during a retrain (V.42 7.10 suspends then). */
  get carrying() { return !!this._rxOpen && this._dataSyms >= E_TO_DATA_SYMBOLS; }

  write(bytes) { for (const by of bytes) this.txByteQ.push(by & 0xff); }

  /** Payload bytes still queued for transmission. Transport flow control. */
  get txPending() { return this.txByteQ.length; }

  _scramble(bit) { const r = this.scr; const out = bit ^ r[this._txTap] ^ r[22]; r.unshift(out); r.pop(); return out; }

  // ─── TX ────────────────────────────────────────────────────────────────────
  _resetTxBurst() {
    this.txSyms = [];
    this.txSymBase = 0;
    this.txMode = 'qam';
    this.txN = 0;
    this.txPrevY = 0;                 // differential quadrant state (Table 2/V.32bis)
    this.txConv = { a: 0, b: 0, c: 0 }; // convolutional encoder state
    this.txFrame = null;
    this.txFramePos = 0;
    this.txEndSample = -1;
    this.txContinuous = false;
    this._suActive = false;
    this._suEnd = null;
    this._dataSyms = 0;
  }

  /**
   * §6's two roles, as a script of bursts. §6.2's answer modem transmits the
   * conditioning signal and R1 unprompted, ceases on detecting the call modem's S,
   * and transmits a second conditioning signal and R3 on detecting R2. §6.1's call
   * modem transmits nothing until it "detects an incoming S sequence ... and then
   * seek[s] to detect at least two consecutive identical 16-bit rate sequences", so
   * its first transmission is gated on R1 — which is what retired ORIG_LEAD.
   */
  _buildConnectScript(role) {
    if (role === 'answer') {
      return [
        { kind: 'tone', gap: 0 },
        { kind: 'preface', gap: ANS_SILENCE },
        { kind: 'startup', gap: PREFACE_GAP, rate: 'r1' },
        { kind: 'startup', gap: 0, gate: 'r2', rate: 'r3' },
      ];
    }
    // Ahead of both, the AA/CC and AC/CA opening — one 'preface' burst per role;
    // see V32.js's connect script.
    return [
      { kind: 'preface', gap: 0, gate: 'preface' },
      { kind: 'startup', gap: 0, gate: 'r1', rate: 'r2', preS: true },
    ];
  }

  /**
   * §5.2's receiver conditioning signal: S for 256T, S̄ for 16T, then TRN. §5.2.3
   * initialises the scrambler to all zeros here and nothing in §5.3 re-initialises
   * it, so the same register runs on through the rate signals, through E and into
   * data mode — §8's rate renegotiation is the clause that DOES re-initialise it,
   * and that it says so there is why the start-up must not.
   */
  _buildConditioning(rateWhich, preS = 0) {
    // The first conditioning signal is tagged for the echo canceller: 1 for S and
    // S̄, 3 for TRN, which it trains on and searches. The answer modem's second one overlaps the call modem's R2.
    const first = !this._condTagged;
    this._condTagged = true;
    let tag = first ? 1 : 0;
    const push = (p) => this.txSyms.push(tag ? { i: p.i * SU_GAIN, q: p.q * SU_GAIN, cond: tag } : { i: p.i * SU_GAIN, q: p.q * SU_GAIN });
    // §6.1: the call modem's S "for a period NT" ahead of the conditioning signal.
    if (preS > 0) for (const p of V32S.buildS(preS + (preS & 1))) push(p);
    for (const p of V32S.buildS()) push(p);
    for (const p of V32S.buildSbar()) push(p);
    this.scr.fill(0);                                   // §5.2.3
    if (first) tag = 3;
    let lastRot = V32S.A;
    for (let n = 0; n < TRN_SYMBOLS; n++) {
      lastRot = V32S.trnRotation(n, () => this._scramble(1));
      push(V32S.ROT[lastRot]);
    }
    // How much of the queue is §5.2's conditioning signal. Instrumentation only:
    // _su exists from here on, so without this describe() would report the rate
    // signal while S, S̄ and TRN are still going out.
    this._suHeadRemaining = this.txSyms.length;
    this._su = {
      enc: new V32S.DiffEncoder(lastRot),               // §5.3's initialisation
      stage: 'rate', which: rateWhich, pending: [], reps: 0, lastRot,
    };
  }

  /**
   * The start-up segment on the wire now, named as §§5.2-5.3 name it. Read-only.
   * The conditioning signal (S, S̄, TRN) is built as one burst with no per-segment
   * cursor, so it reports as TRN — the segment that is 1280 of its 1424 symbols.
   */
  describe() {
    if (this._preActive) return { phase: 2, signal: this._pre.signal };
    if (this.txSyms.length >= this._suHeadRemaining && this._suHeadRemaining > 0) {
      return { phase: 3, signal: 'TRN' };
    }
    if (this._su) {
      const st = this._su.stage;
      if (st === 'rate') return { phase: 3, signal: { r1: 'R1', r2: 'R2', r3: 'R3' }[this._su.which] || 'R' };
      if (st === 'e') return { phase: 3, signal: 'E' };
      if (st === 'cease') return { phase: 3, signal: 'cease' };
      return { phase: 5, signal: 'data' };
    }
    if (this.txState === 'active') return { phase: 3, signal: 'TRN' };
    return null;
  }

  _suSequence(bits) {
    const out = [];
    for (let k = 0; k < bits.length; k += 2) {
      const q1 = this._scramble(bits[k]);
      const q2 = this._scramble(bits[k + 1]);
      out.push(this._su.enc.symbol(q1, q2));
    }
    return out;
  }

  _suRateGateOpen() {
    switch (this._su.which) {
      case 'r1': return this._sawPeerS;                 // §6.2 "cease transmitting"
      case 'r2': return this._sawR3;                    // §6.1 "until R3 is detected"
      default:   return this._sawPeerE;                 // §6.2, R3 ends on the peer's E
    }
  }

  _suNext() {
    const su = this._su;
    for (;;) {
      if (su.pending.length) {
        su.lastRot = su.pending.shift();
        const p = V32S.ROT[su.lastRot];
        return { i: p.i * SU_GAIN, q: p.q * SU_GAIN };
      }
      if (!this._suAdvance(su)) return null;
    }
  }

  _suAdvance(su) {
    switch (su.stage) {
      case 'rate':
        // §5.3.2: complete the current 16-bit sequence first, which is why the gate
        // is tested only at a sequence boundary. E ends "any rate signal other than
        // R1"; §6.2 ends R1 by ceasing to transmit instead.
        if (su.reps >= RATE_MIN_REPEATS && this._suRateGateOpen()) {
          su.stage = su.which === 'r1' ? 'cease' : 'e';
          return true;
        }
        su.reps++;
        su.pending = this._suSequence(this._rateWord(su.which));
        return true;
      case 'e':
        su.pending = this._suSequence(this._eWord());
        su.stage = 'to-data';
        return true;
      case 'to-data': this._suEnd = 'data'; return false;
      default:        this._suEnd = 'cease'; return false;
    }
  }

  /**
   * Table 5/V.32bis's 16 bits. §6.1: "R2 shall exclude rates not appearing in the
   * previously received rate signal R1." §6.2: "The data rate selected by R3 shall
   * be within those indicated by R2." Both are the intersection; R3 names one rate.
   */
  _rateWord(which) {
    let rates = this._rates;
    if (which !== 'r1') {
      const peer = this._peerRates || [];
      rates = this._rates.filter((r) => peer.includes(r));
      if (!rates.length) this.rateMismatch = `peer offered [${peer}], this modem runs [${this._rates}]`;
    }
    if (which !== 'r1') { this._lineFrozen = true; rates = rates.filter((r) => this._lineRoom(r)); }
    if (which === 'r3') rates = rates.slice(-1);
    return V32S.V32BIS_RATES.build(rates);
  }

  /**
   * Table 6/V.32bis's sequence E: B4-B12 as Table 5 "except the only data rate to
   * be indicated shall relate to the transmission of scrambled binary ones
   * immediately following signal E".
   */
  _eWord() { return V32S.V32BIS_RATES.build([this._selectedRate()], { sequence: 'e' }); }

  /**
   * §6.1/§6.2 (as §5.4/V.32): the rate signals "take account of the likely
   * receiver performance". A rate this end's error on the far end's conditioning
   * signal would leave it unsatisfactory at is not offered; 4800 always is.
   */
  _lineRoom(r) {
    if (r === 4800 || this._lineErr == null) return true;
    if (this._lineWas != null && this._lineWas > TREND_FALL * this._lineErr) return true;
    return this._lineErr < TRN_MARGIN * UNSAT_GAP * SPACING[r];
  }

  _selectedRate() {
    const peer = this._peerRates || [];
    const common = this._rates.filter((r) => peer.includes(r) && this._lineRoom(r));
    return common.length ? common[common.length - 1] : this._rates[this._rates.length - 1];
  }

  _startBurst(step) {
    this._resetTxBurst();
    if (step.kind === 'tone') {
      this.scr.fill(0);
      this.txMode = 'tone';
      this.txEndSample = ANS_TONE_SAMPLES;
      this.txState = 'active';
      this._idleSamples = 0;
      return;
    }
    if (step.kind === 'preface') {
      this._pre.begin(this._clockTx);
      this.txContinuous = true;
      this._preActive = true;
      this.txState = 'active';
      this._idleSamples = 0;
      return;
    }
    this._buildConditioning(step.rate, step.preS ? this._pre.nt : 0);
    this.txContinuous = true;
    this._suActive = true;
    this.txState = 'active';
    this._idleSamples = 0;
  }

  _maybeStartBurst() {
    if (!this._connectQ.length) return;
    const step = this._connectQ[0];
    if (this._idleSamples < step.gap) return;
    if (step.gate && !this._gateOpen(step.gate)) {
      if (this._idleSamples < GATE_TIMEOUT) return;
    }
    this._startBurst(this._connectQ.shift());
  }

  _gateOpen(gate) {
    if (gate === 'preface') return this._pre.wantsTx;
    if (gate === 'r1') return this._sawR1;
    if (gate === 'r2') return this._sawR2;
    return true;
  }

  /**
   * §6's handover out of E. Same carrier, same scrambler; the differential quadrant
   * state carries over from E's final symbol. §6.1 and §6.2 both say the
   * convolutional encoder's delay elements "shall be set to zero" here, which is
   * the one part of this transition the Recommendation states outright.
   */
  _enterTxData() {
    this.txPrevY = V32S.Y_OF_ROT[this._su.lastRot];
    this.txRot = this._su.lastRot;                    // 4800's state: the rotation itself
    this.txConv = { a: 0, b: 0, c: 0 };
    this._rate = this._selectedRate();
    this._txCoded = CODED[this._rate] || null;
    this._dataSyms = 0;
  }

  // §6's 128 symbol intervals of scrambled binary ones after E come out of the
  // idle-mark branch, which is what they already are on the wire.
  _txBit() {
    if (this.txFrame) {
      const b = this.txFrame[this.txFramePos++];
      if (this.txFramePos >= this.txFrame.length) this.txFrame = null;
      return this._scramble(b);
    }
    if (this._link) return this._scramble(this._rxOpen && this._dataSyms >= E_TO_DATA_SYMBOLS ? this._link.nextBit() : 1);
    let by = null;
    if (this._rxOpen && this._dataSyms >= E_TO_DATA_SYMBOLS && this.txByteQ.length) by = this.txByteQ.shift();
    if (by !== null) {
      this._txByte = by;          // put back if a retrain cuts it off
      this.txFrame = [0, by & 1, (by >> 1) & 1, (by >> 2) & 1, (by >> 3) & 1,
                      (by >> 4) & 1, (by >> 5) & 1, (by >> 6) & 1, (by >> 7) & 1, 1];
      this.txFramePos = 1;
      return this._scramble(0);
    }
    return this._scramble(1);         // idle mark
  }

  // One data symbol from the rate's scrambled bits: rate / 2400 of them.
  _dataSymbol() {
    const Q1 = this._txBit(), Q2 = this._txBit();
    const din = (Q1 << 1) | Q2;
    const t = this._txCoded;
    if (!t) {
      // §2.4.2 at 4800 (Table 2/V.32bis): no trellis, the dibit turns the quadrant,
      // and the symbol is one of Figure 2-5's four states, the start-up's own.
      this.txRot = (this.txRot + V32S.PHASE_CHANGE[din]) & 3;
      const p = V32S.ROT[this.txRot];
      return { i: p.i * SU_GAIN, q: p.q * SU_GAIN };
    }
    this.txPrevY = TAB1[din][this.txPrevY];          // differential (Table 1)
    const Y1 = (this.txPrevY >> 1) & 1, Y2 = this.txPrevY & 1;
    const Y0 = convEncode(this.txConv, Y1, Y2);       // redundant trellis bit
    let idx = (Y0 << 2) | (Y1 << 1) | Y2;
    for (let b = 2; b < t.bits; b++) idx = (idx << 1) | this._txBit();   // Q3 upwards
    return t.pts[idx];
  }

  _ensureSymbols(k) {
    if (!this.txContinuous) return;
    while (this.txSymBase + this.txSyms.length <= k) {
      if (this._preActive) {
        const at = this.txSymBase + this.txSyms.length;
        const rot = this._pre.rot(at);
        if (rot !== null) {
          const p = V32S.ROT[rot];
          this.txSyms.push({ i: p.i * SU_GAIN, q: p.q * SU_GAIN });
          continue;
        }
        // The preface's cease: flush the shaper and go idle, as R1's cease does.
        this._preActive = false;
        this.txContinuous = false;
        this.txEndSample = Math.ceil((at + SPAN / 2) * SPS);
        return;
      }
      if (this._suActive) {
        const p = this._suNext();
        if (p) { this.txSyms.push(p); continue; }
        this._suActive = false;
        if (this._suEnd === 'cease') {
          // §6.2's "cease transmitting": stop being continuous and let the fixed-
          // burst end condition flush the shaper so the carrier goes down cleanly.
          this.txContinuous = false;
          this.txEndSample = Math.ceil((this.txSymBase + this.txSyms.length + SPAN / 2) * SPS);
          return;
        }
        this._enterTxData();
      }
      this.txSyms.push(this._dataSymbol());
      this._dataSyms++;
    }
  }

  generateAudio(count) {
    const out = new Float32Array(count);
    const n0 = this._clockTx;
    let c = 0;
    while (c < count) {
      if (this.txState !== 'active') {
        this._maybeStartBurst();
        if (this.txState !== 'active') { this._idleSamples++; this._clockTx++; c++; continue; }
      }
      c = this.txMode === 'tone' ? this._genTone(out, c) : this._genQam(out, c);
    }
    // Continuous flow: drop shaped-out leading symbols so txSyms stays flat.
    // Only txSymBase moves; txN (carrier phase) is untouched.
    if (this.txContinuous) {
      const oldest = Math.floor(this.txN / SPS - SPAN) - 1;
      const drop = oldest - this.txSymBase;
      if (drop > 512) { this.txSyms.splice(0, drop); this.txSymBase += drop; }
    }
    if (this._ecOn) for (let k = 0; k < count; k++) this._ec.sent(n0 + k, out[k]);
    return out;
  }

  /** Where transmit sample n falls in the first conditioning signal — V32.js. */
  _ecTag(n, st) {
    const e = this._ecSpan;
    if (e.end != null) return;
    const sym = this.txSyms[Math.round(st) - this.txSymBase];
    const tag = (sym && sym.cond) || 0;
    // 1: nothing to hear. 2: the canceller trains. 3: it trains and searches.
    if (tag && e.start == null) e.start = n;
    if (tag >= 2 && e.trnStart == null) e.trnStart = n;
    if (tag === 3 && e.searchFrom == null) e.searchFrom = n;
    if (!tag && e.start != null) { e.end = n; if (e.trnEnd == null) e.trnEnd = n; }
    else if (tag < 2 && e.trnStart != null && e.trnEnd == null) e.trnEnd = n;
  }

  _genTone(out, c) {
    for (; c < out.length; c++) {
      const n = this.txN++;
      if (this.txEndSample >= 0 && n >= this.txEndSample) { this.txState = 'idle'; this._resetTxBurst(); return c; }
      this._clockTx++;
      out[c] = Math.sin(2 * Math.PI * ANS_TONE_FREQ * n / SR) * ANS_TONE_AMP;
    }
    return c;
  }

  _genQam(out, c) {
    for (; c < out.length; c++) {
      const n = this.txN++;                       // monotonic: carrier phase never jumps
      if (!this.txContinuous && this.txEndSample >= 0 && n >= this.txEndSample) {
        this.txState = 'idle'; this._resetTxBurst(); return c;
      }
      this._clockTx++;
      const st = n / SPS;                          // absolute symbol time
      const klo = Math.max(0, Math.ceil(st - SPAN / 2)), khi = Math.floor(st + SPAN / 2);
      this._ensureSymbols(khi);
      let ai = 0, aq = 0;
      for (let k = Math.max(klo, this.txSymBase); k <= khi; k++) {
        const s = this.txSyms[k - this.txSymBase];
        if (!s) break;
        const p = rrc(st - k); ai += s.i * p; aq += s.q * p;
      }
      const ph = 2 * Math.PI * FC * n / SR;
      out[c] = (ai * Math.cos(ph) - aq * Math.sin(ph)) * TX_GAIN;
      this._ecTag(this._clockTx - 1, st);
    }
    return c;
  }

  // ─── RX ────────────────────────────────────────────────────────────────────
  _resetRx() {
    this.rx = [];
    this.rxBase = 0;
    this.acq = false;
    this.base = 0;
    this.symIdx = 0;
    this.des = new Array(23).fill(0);
    this.gr = 1; this.gi = 0; this.g2 = 1;
    this.rxPrevY = 0;
    this.outbits = [];
    this.uState = 'hunt'; this.uArmed = false; this.uMarks = 0; this.uBit = 0; this.uByte = 0;
    // Which signal this burst is; see V32.js. The burst that ends in E flows into
    // data mode without the carrier dropping, so the phase changes on E.
    this.rxPhase = this._sawPeerE ? 'data' : 'startup';
    this._sRef = null;
    this._huntFrom = Math.ceil(SPAN / 2 * SPS);   // _huntStartup's forward-only scan
    this._suRx = {
      dec: new V32S.DiffDecoder(),
      framer: new V32S.RateFramer(V32S.V32BIS_RATES),
      runKind: null, runLen: 0, lastRot: -1,
    };
    this._tPrev = null;           // Gardner: the previous symbol
    this._tPow = 0;               // and the power it normalises by
    this._dphi = 0;               // the carrier's turn per symbol, learnt
    this._tDrift = 0;             // and the symbol instant's drift per symbol
  }

  /** Gardner's timing correction in samples for the symbol s at pos — V32.js. */
  _timing(pos, s) {
    const prev = this._tPrev;
    this._tPrev = s;
    const p = s[0] * s[0] + s[1] * s[1];
    this._tPow += (this._tPow ? 0.02 : 1) * (p - this._tPow);
    if (!prev || this._tPow < 1e-12) return 0;
    const m = this._sym(pos - SPS / 2);
    const e = (s[0] - prev[0]) * m[0] + (s[1] - prev[1]) * m[1];
    const en = e / this._tPow;
    this._tDrift -= TRK_TFREQ * en;
    let d = -TRK_TIMING * en + this._tDrift;
    if (d > 0.1) d = 0.1; else if (d < -0.1) d = -0.1;
    return d;
  }

  _bb(n) { const ph = 2 * Math.PI * FC * n / SR; const s = this.rx[n - this.rxBase]; return [s * Math.cos(ph) * 2, -s * Math.sin(ph) * 2]; }
  _sym(pos) {
    const end = this.rxBase + this.rx.length - 1;
    const nlo = Math.max(this.rxBase, Math.ceil(pos - SPAN / 2 * SPS));
    const nhi = Math.min(end, Math.floor(pos + SPAN / 2 * SPS));
    let ai = 0, aq = 0;
    for (let n = nlo; n <= nhi; n++) { const b = this._bb(n); const p = rrc((n - pos) / SPS); ai += b[0] * p; aq += b[1] * p; }
    return [ai, aq];
  }

  receiveAudio(f32) {
    const e = this._ecSpan;
    for (let i = 0; i < f32.length; i++) {
      const n = this._clockRx++;
      let s = f32[i];
      if (this._ecOn) {
        if (this._ecState === 'before' && e.trnStart != null && n >= e.trnStart) { this._ec.beginTraining(() => e.searchFrom); this._ecState = 'training'; }
        if (this._ecState === 'training' && e.trnEnd != null && n >= e.trnEnd) { this._ec.endTraining(); this._ecState = 'held'; }
        s = this._ec.process(n, s);
        if (e.start != null && n >= e.start && (e.end == null || n < e.end + EC_GUARD)) s = 0;
      }
      if (this._rxGated) {
        // §6's opening; the start-up receiver waits for it (see V32.js).
        this._pre.rx(s, n);
        this.rxLevel += RX_A * (Math.abs(s) - this.rxLevel);
        if (!this._pre.huntArmed) continue;
        this._rxGated = false;
        this.rxOn = false; this.rxLow = 0;
        this._resetRx();
      }
      if (this._rtWatch && this.rxPhase === 'data' && this._rtWatch.push(s, n)) {
        this._beginRetrain('far end');
        continue;
      }
      this.rxLevel += RX_A * (Math.abs(s) - this.rxLevel);
      if (this.rxLevel > RX_HI) { this.rxOn = true; this.rxLow = 0; }
      else if (this.rxLevel < RX_LO && this.rxOn) { this.rxLow++; }
      if (this.rxOn) this.rx.push(s);
      if (this.rxOn && this.rxLow > RX_HANG) {
        // §6.2's "cease transmitting" between R1 and the second conditioning
        // signal, or a hangup once data is up. R1 and R3 arrive in those two
        // different transmissions, so the stage advances HERE — advancing on the
        // first detection would take the second repetition of R1 for R3.
        this._process();
        if (this.role === 'originate' && this._rxStage === 'r1' && this._sawR1) this._rxStage = 'r3';
        this.rxOn = false;
        this._resetRx();
      }
    }
    if (this.rxOn) this._process();
    if (this._retrainAt != null && this._clockRx - this._retrainAt > RETRAIN_PATIENCE * SR) this._beginRetrain('stalled');
  }

  /**
   * §5.2's conditioning signal, received. The whole method — the S confirmation,
   * the parity resolution from Table 2/V.32bis's +90° A-to-B step, and the
   * forward-only walk — is V32.js's, because §5.2 is the same clause and Figure
   * 2-5's four states are Figure 1/V.32's four states. See V32.js for why the
   * parity matters: getting it wrong reflects the labelling rather than rotating
   * it, and negates every differential decode.
   */
  _huntStartup() {
    const CONFIRM = 16;
    if (!this._sRef) {
      // The scan only moves forward. A candidate that fails the confirmation below
      // is stepped past rather than retried — retried, a buffer that opens INSIDE
      // a signal (as it does when §5.4's opening hands over to the hunt mid-S)
      // fails on its truncated first symbol for ever.
      const edge = Math.ceil(SPAN / 2 * SPS);
      let sIQ = null, best = 0;
      while (!sIQ) {
        let onset = -1, e = 0;
        for (let n = this._huntFrom; n < this.rx.length; n++) {
          const b = this._bb(n); const m = Math.hypot(b[0], b[1]);
          e = 0.85 * e + 0.15 * m;
          if (e > ONSET_FRAC * Math.max(this.rxLevel, RX_LO)) { onset = Math.max(this._huntFrom, n - 4); break; }
        }
        if (onset < 0) { this._huntFrom = Math.max(this._huntFrom, this.rx.length - 8); return; }
        if (onset + (CONFIRM + 3) * SPS + edge >= this.rx.length) return;
        // S is constant-modulus, so maximising summed symbol magnitude finds the
        // ISI-free instant exactly as the old preamble search did.
        let bestScore = -1;
        best = onset;
        for (let bo = Math.max(edge, onset - 2 * SPS); bo <= onset + 2 * SPS; bo += SPS / 64) {
          let sc = 0;
          for (let k = 0; k < 12; k++) { const s = this._sym(bo + k * SPS); sc += Math.hypot(s[0], s[1]); }
          if (sc > bestScore) { bestScore = sc; best = bo; }
        }
        sIQ = this._confirmS(best, CONFIRM);
        if (!sIQ) this._huntFrom = Math.ceil(onset + 4 * SPS);
      }
      const acc = [[0, 0], [0, 0]], cnt = [0, 0];
      for (let j = 0; j < CONFIRM; j++) { const pp = j & 1; acc[pp][0] += sIQ[j][0]; acc[pp][1] += sIQ[j][1]; cnt[pp]++; }
      let a = [acc[0][0] / cnt[0], acc[0][1] / cnt[0]];
      let b = [acc[1][0] / cnt[1], acc[1][1] / cnt[1]];
      if (a[0] * b[1] - a[1] * b[0] < 0) { const t = a; a = b; b = t; }
      // IDEAL references, A turned by quarter turns (V32.js).
      const bi = [-a[1], a[0]];
      this._sRef = { base: best, idx: CONFIRM, refs: [a, bi, [-a[0], -a[1]], [-bi[0], -bi[1]]] };
      this._eq = new SymbolEqualizer(EQ_L);
      this._suResid = null; this._suResidMid = null; this._suResidOld = null;
    }

    const r = this._sRef;
    const end = this.rxBase + this.rx.length - 1;
    while (this.rxPhase === 'startup') {
      const pos = r.base + r.idx * SPS;
      if (pos + (EQ_L + 1) * SPS + SPAN / 2 * SPS >= end) return;
      const raw = this._sym(pos);
      const s = this._eqRun(pos);
      r.idx++;
      let bestRot = 0, bestDot = -Infinity;
      for (let rot = 0; rot < 4; rot++) {
        const ref = r.refs[rot];
        const dot = s[0] * ref[0] + s[1] * ref[1];
        if (dot > bestDot) { bestDot = dot; bestRot = rot; }
      }
      {
        const t = r.refs[bestRot], e2 = (s[0] - t[0]) ** 2 + (s[1] - t[1]) ** 2, r2 = t[0] * t[0] + t[1] * t[1];
        // Geared as in data: TRN is 1280 symbols, and on a 12 dB tilt the error was
        // still falling fast when it ended.
        const gearT = Math.min(EQ_GEAR_TRN, Math.max(1, (this._suResid || 0) / (EQ_GEAR_FROM * STATE_R * 2)));
        if (e2 < EQ_GATE * r2) this._eq.update(t[0], t[1], EQ_MU_TRAIN * gearT);
        // The line's error on four states far apart, in data units: the measure
        // the rate signals are chosen by (_lineRoom).
        if (r.idx > SU_MEASURE_FROM) {
          const d = Math.sqrt(e2 / r2) * STATE_R;
          this._suResid = this._suResid == null ? d : this._suResid + (d - this._suResid) / UNSAT_AVG;
          if (r.idx % TREND_SPAN === 0) { this._suResidOld = this._suResidMid; this._suResidMid = this._suResid; }
        }
      }
      const ref = r.refs[bestRot];
      const pe = Math.atan2(ref[0] * s[1] - ref[1] * s[0], bestDot);
      this._dphi += TRK_FREQ * pe;
      const ph = TRK_PHASE * pe + this._dphi;
      const c = Math.cos(ph), sn = Math.sin(ph);
      for (const q of r.refs) { const i = q[0] * c - q[1] * sn; q[1] = q[0] * sn + q[1] * c; q[0] = i; }
      r.base += this._timing(pos, raw);
      this._suSymbol(bestRot);
      // R1's sequences stopping ends its transmission where noise hides the drop.
      if (this.role === 'originate' && this._rxStage === 'r1' && this._sawR1 &&
          this._suRx && this._suRx.framer.misses >= R1_ENDED) {
        this._rxStage = 'r3';
        this._resetRx();
        return;
      }
    }
  }

  /** The equalised symbol at pos, from the matched filter at T/2 around it. */
  _eqRun(pos) {
    return this._eq.run((m, half) => this._sym(pos + (m + (half ? 0.5 : 0)) * SPS));
  }

  /**
   * Confirm this really is S, by what a linear line leaves of it — V32.js: a
   * two-symbol period, two distinct states, and a mean (the carrier's line)
   * beside their half-difference, which AC does not have. The symbols, or null.
   */
  _confirmS(best, count) {
    const sIQ = [];
    for (let j = 0; j < count; j++) sIQ.push(this._sym(best + j * SPS));
    let p = 0;
    for (const v of sIQ) p += v[0] * v[0] + v[1] * v[1];
    p /= count;
    if (p < 1e-12) return null;
    let rep = 0;
    for (let j = 2; j < count; j++) rep += (sIQ[j][0] - sIQ[j - 2][0]) ** 2 + (sIQ[j][1] - sIQ[j - 2][1]) ** 2;
    if (rep / (count - 2) > 0.05 * p) return null;
    const acc = [[0, 0], [0, 0]];
    for (let j = 0; j < count; j++) { acc[j & 1][0] += sIQ[j][0]; acc[j & 1][1] += sIQ[j][1]; }
    const a = acc[0].map(v => v / (count / 2)), b = acc[1].map(v => v / (count / 2));
    const mean = Math.hypot(a[0] + b[0], a[1] + b[1]) / 2, diff = Math.hypot(a[0] - b[0], a[1] - b[1]) / 2;
    if (diff * diff < 0.1 * p || mean < 0.25 * diff || mean > 4 * diff) return null;
    return sIQ;
  }

  /** One classified start-up symbol; see V32.js for the descrambler's convergence. */
  _suSymbol(rot) {
    const p = this._suRx;
    const kind = (rot === V32S.A || rot === V32S.B) ? 's'
               : (rot === V32S.C || rot === V32S.D) ? 'sbar' : null;
    if (kind && kind === p.runKind && rot !== p.lastRot) p.runLen++;
    else { p.runKind = kind; p.runLen = 1; }
    p.lastRot = rot;
    if (p.runLen === RUN_CONFIRM && p.runKind === 's') this._sawPeerS = true;

    const ib = p.dec.bits(rot);
    if (!ib) return;
    for (const bit of ib) {
      const reg = this.des;
      const ob = bit ^ reg[this._rxTap] ^ reg[22];
      reg.unshift(bit); reg.pop();
      const hit = p.framer.push(ob);
      if (hit) this._suSequenceSeen(hit, rot);
    }
  }

  _suSequenceSeen(hit, lastRot) {
    if (hit.kind === 'e') {
      // §5.4: E comes only after the rate exchange it ends: the call modem has
      // heard R3, the answer modem R2, and it names the rate R3 settled on. A
      // group that passes the sync cells anywhere else is noise. At 36 dB one
      // took this end into data while the far end was still in its S̄.
      const exchanged = this.role === 'originate' ? this._sawR3 : this._sawR2;
      if (!exchanged || hit.best !== this._selectedRate()) { this.falseE = (this.falseE || 0) + 1; return; }
      this._sawPeerE = true;
      this._enterRxData(lastRot, hit.best);
      return;
    }
    this._peerRates = hit.advertised;
    this.peerRate = hit.best;
    // The line's error as each of the far end's rate signals arrives, until this
    // end first builds its own R2 or R3, which freezes it. Not later: by then the
    // far end may have ceased and the measure be reading silence, and R3 must not
    // change between repetitions. Not the first: on a dispersive line the equaliser
    // is still converging, and 14 400 read as 9600.
    if (!this._lineFrozen && this._suResid != null) { this._lineErr = this._suResid; this._lineWas = this._suResidOld; }
    if (this.role === 'answer') { this._sawR2 = true; return; }
    if (this._rxStage === 'r1') this._sawR1 = true; else this._sawR3 = true;
  }

  /**
   * §6's handover out of E, the mirror of _enterTxData. Nothing is re-acquired: the
   * timing lock is S's and the channel estimate is S's state A as the channel
   * presented it, which is what makes the data burst's invented 72-symbol preamble
   * unnecessary — it is gone.
   */
  _enterRxData(lastRot, eRate) {
    const r = this._sRef;
    const a = r.refs[V32S.A];
    const A0 = V32S.ROT[V32S.A];
    const di = A0.i * SU_GAIN, dq = A0.q * SU_GAIN;
    const d2 = di * di + dq * dq;
    this.gr = (a[0] * di + a[1] * dq) / d2;
    this.gi = (a[1] * di - a[0] * dq) / d2;
    this.g2 = this.gr * this.gr + this.gi * this.gi || 1e-9;
    this.base = r.base;
    this.symIdx = r.idx;
    this.rxPrevY = V32S.Y_OF_ROT[lastRot];
    this.rxRot = lastRot;
    // The rate is the one the far end's E names (Table 6): what follows E is coded
    // at it, whatever this end would have chosen.
    this._rate = eRate && RATE_SET.includes(eRate) ? eRate : this._selectedRate();
    this._rxCoded = CODED[this._rate] || null;
    this._vit = this._rxCoded ? new V32bisViterbi(this.rxPrevY, this._rxCoded) : null;
    this.acq = true;
    this.rxPhase = 'data';
    // Circuit 109 comes on 128 symbol intervals after the incoming E (§5.4.1, and
    // §5.4.2 by reference), not at it — see _process().
    this._rxDataSyms = 0;
    this._rxOpen = false;
    this._resid = 0; this._unsat = 0;
    this._rtWatch = new V32P.RetrainWatch(this.role, SPS);
  }

  /**
   * §5.4.1: "On detecting an incoming 16-bit E sequence ... After a delay of 128
   * symbol intervals, it shall apply an ON condition to circuit 109 ... [and] be
   * ready to transmit data." Ready, and the transmitter's data with it, wait for
   * that — counted from the FAR end's E. The call modem sends its own E first, so
   * counting from that one put its first characters on the line while the answer
   * modem was still in its own 128, which BinModem drops.
   */
  _rxDataSymbol() {
    if (this._rxOpen || ++this._rxDataSyms < E_TO_DATA_SYMBOLS) return;
    this._rxOpen = true;
    this._retrainAt = null;
    if (this._ready) { this.emit('retrained', { bps: this._rate }); return; }
    this._ready = true;
    this.emit('ready', { bps: this._rate, remoteDetected: true });
  }

  _spacingNow() { return SPACING[this._rate]; }

  /**
   * One data symbol's distance from the NEAREST point, which is BinModem's measure
   * and what its threshold is a fraction of a spacing for: the Viterbi path's guess
   * is often not the nearest, and measured from it a 45 dB line that decoded
   * exactly read as unsatisfactory. True once a retrain has begun.
   */
  _unsatisfactory(xI, xQ, pts, dec) {
    let d = Math.hypot(xI - dec.i, xQ - dec.q);
    if (pts) for (const q of pts) { const e = Math.hypot(xI - q.i, xQ - q.q); if (e < d) d = e; }
    this._resid += (d - this._resid) / UNSAT_AVG;
    this._unsat = this._resid > UNSAT_GAP * SPACING[this._rate] ? this._unsat + 1 : 0;
    if (this._unsat <= UNSAT_HOLD) return false;
    const err = this._resid;
    this._rates = this._rates.filter((r) => r === 4800 || (r < this._rate && err < UNSAT_GAP * SPACING[r]));
    if (!this._rates.includes(4800)) this._rates = [4800, ...this._rates];
    this._beginRetrain('unsatisfactory');
    return true;
  }

  /**
   * §7: a retrain, §6's opening from its third paragraph, both roles. Circuits 107
   * and 109 stay ON (V.32 §5.5.2's note), so this class stays ready and bytes
   * written meanwhile wait. See V32.js, whose procedure this is.
   */
  _beginRetrain(why) {
    this.retrains = (this.retrains || 0) + 1;
    this._retrainAt = this._clockRx;
    this.emit('retrain', { why });
    if (this.txFrame && this._txByte != null) this.txByteQ.unshift(this._txByte);
    this.txState = 'idle';
    this._resetTxBurst();
    this._connectQ = this._buildConnectScript(this.role)
      .filter((step) => step.kind !== 'tone')
      .map((step, k) => (k === 0 ? { ...step, gap: 0 } : step));
    this._pre = this.role === 'originate' ? new V32P.CallPreface(SPS) : new V32P.AnswerPreface(SPS, V32P.RETRAIN_AC);
    if (this._pre.skipListen) this._pre.skipListen();
    this._rxGated = true;
    this._sawPeerS = false; this._sawR1 = false; this._sawR2 = false; this._sawR3 = false; this._sawPeerE = false;
    this._lineErr = null; this._lineFrozen = false;
    this._rxStage = this.role === 'originate' ? 'r1' : 'r2';
    this._rxOpen = false;
    this._rtWatch = null;
    this.rxOn = false; this.rxLow = 0;
    this._resetRx();
    this._ec.reset();
    this._ecState = 'before';
    this._ecSpan = { start: null, trnStart: null, searchFrom: null, trnEnd: null, end: null };
  }

  _process() {
    // TRN is over a thousand symbols of scrambled states; handing it to a data
    // slicer produces bytes out of training, which is what this split prevents.
    if (this.rxPhase === 'startup') {
      this._huntStartup();
      if (this.rxPhase === 'startup') return;
    }

    while (true) {
      const pos = this.base + this.symIdx * SPS;
      const end = this.rxBase + this.rx.length - 1;
      if (pos + (EQ_L + 1) * SPS + SPAN / 2 * SPS >= end) break;
      const raw = this._sym(pos);
      const s = this._eqRun(pos);
      const xI = (s[0] * this.gr + s[1] * this.gi) / this.g2;
      const xQ = (s[1] * this.gr - s[0] * this.gi) / this.g2;
      // The bits come from the Viterbi decoder, VIT_DEPTH symbols late. The loops
      // steer by its best path's guess at THIS symbol, which they need now.
      let bits, p;
      if (this._vit) { bits = this._vit.push(xI, xQ); p = this._vit.tentative; }
      else [bits, p] = this._slice4800(xI, xQ);
      if (this._unsatisfactory(xI, xQ, this._rxCoded ? this._rxCoded.pts : null, p)) return;
      {
        const dI = p.i, dQ = p.q;
        const eI = s[0] - (this.gr * dI - this.gi * dQ), eQ = s[1] - (this.gr * dQ + this.gi * dI);
        const k = TRK_GAIN / (dI * dI + dQ * dQ);
        this.gr += k * (eI * dI + eQ * dQ);
        this.gi += k * (eQ * dI - eI * dQ);
        // Second order: the phase part of the same error, into the turn per symbol,
        // which then turns g ahead of the next one.
        const pr = this.gr * dI - this.gi * dQ, pq = this.gr * dQ + this.gi * dI;
        this._dphi += TRK_FREQ * (eQ * pr - eI * pq) / (pr * pr + pq * pq || 1e-9);
        const c = Math.cos(this._dphi), sn = Math.sin(this._dphi);
        const gr = this.gr * c - this.gi * sn; this.gi = this.gr * sn + this.gi * c; this.gr = gr;
        this.g2 = this.gr * this.gr + this.gi * this.gi || 1e-9;
        // Geared: a larger step while the error is large, the fine one as it settles.
        // The call modem enters data with its equaliser trained on one TRN, and on a
        // 12 dB tilt it came in at 0.45 of a spacing and took 8 s to reach 0.12.
        const gear = Math.min(EQ_GEAR_MAX, Math.max(1, (this._resid || 0) / (EQ_GEAR_FROM * this._spacingNow())));
        this._eq.update(this.gr * dI - this.gi * dQ, this.gr * dQ + this.gi * dI, EQ_MU_DATA * gear);
        this.base += this._timing(pos, raw);
      }
      if (bits) for (const bit of bits) { const r = this.des; const ob = bit ^ r[this._rxTap] ^ r[22]; r.unshift(bit); r.pop(); this.outbits.push(ob); }
      this.symIdx++;
      this._rxDataSymbol();
      // Before 109 comes on the far end sends only scrambled ones (§5.4), so the
      // UART is held off them: a decode error at the E-to-data change runs on
      // through the descrambler's taps and arrives as a false start bit — the
      // junk first byte BinModem's 14 400 start produced.
      if (!this._rxOpen || (this._rtWatch && this._rtWatch.held > RETRAIN_MUTE * SPS)) this.outbits.length = 0;
      this._uartConsume();

      const drop = Math.floor(this.base + (this.symIdx - SPAN - EQ_L) * SPS) - this.rxBase;
      if (drop > 512) { this.rx.splice(0, drop); this.rxBase += drop; }
    }
  }

  /**
   * 4800's decision: the nearest of the four states, and the dibit its quadrant
   * change from the last one names (Table 2/V.32bis read backwards). No trellis, so
   * nothing to wait for.
   */
  _slice4800(xI, xQ) {
    let r = 0, bd = Infinity;
    for (let k = 0; k < 4; k++) {
      const q = V32S.ROT[k], d = (xI - q.i * SU_GAIN) ** 2 + (xQ - q.q * SU_GAIN) ** 2;
      if (d < bd) { bd = d; r = k; }
    }
    const d = V32S.CHANGE_TO_DIBIT[(r - this.rxRot) & 3];
    this.rxRot = r;
    const q = V32S.ROT[r];
    return [[(d >> 1) & 1, d & 1], { i: q.i * SU_GAIN, q: q.q * SU_GAIN }];
  }

  _uartConsume() {
    if (this._link) { while (this.outbits.length) this._link.feedBit(this.outbits.shift()); return; }
    while (this.outbits.length) {
      const bit = this.outbits.shift();
      if (this.uState === 'hunt') {
        if (bit === 1) { if (!this.uArmed && this.uMarks < 255 && ++this.uMarks >= UART_ARM_MARKS) this.uArmed = true; }
        else if (this.uArmed) { this.uState = 'data'; this.uBit = 0; this.uByte = 0; }
      } else if (this.uState === 'data') {
        this.uByte |= (bit << this.uBit); this.uBit++;
        if (this.uBit === 8) this.uState = 'stop';
      } else {
        if (bit === 1) { this._rxByte(this.uByte & 0xff); this.uState = 'hunt'; }
        else { this.uState = 'hunt'; this.uArmed = false; this.uMarks = 0; }
      }
    }
  }

  // The rate signals are §5.3's own 16-bit sequences on the wire now, not
  // reserved bytes in this stream, so nothing here is stripped.
  _rxByte(b) { this.emit('data', Buffer.from([b])); }
}

// The decoder and the pieces it inverts, for tools/tests/v32bis-viterbi-check.js.
module.exports = { V32bis, V32bisViterbi, CODED, RATE_SET, C128, TAB1, convEncode, slicePoint, IDX, INV1, VIT_DEPTH };
