'use strict';

/**
 * V34Phase2 — the Phase 2 signals of ITU-T V.34 (02/98) §10.1.2: tones A and B
 * with their 180° phase reversals, the INFO sequences and their 600 bit/s binary
 * DPSK modulation, and the L1 / L2 line probing signals of Table 17.
 *
 * Same division as V34Phase3.js: the SIGNALS live here, built to the clauses and
 * asserted at load; §11.2's procedure — who transmits what, and which signal each
 * end waits for before it does — stays in the protocol class. V.90 §9.2 runs the
 * same signals in a different order for a different pair of modems, which is
 * backlog item 3 and is why nothing here knows about roles beyond naming which
 * modem sends which carrier.
 *
 * ── §10.1.2 — power ─────────────────────────────────────────────────────────
 * "During Phase 2, all signals except L1 shall be transmitted at the nominal
 * transmit power level." L1 is 6 dB above it (§10.1.2.4); tone A is 1 dB below it
 * with its guard tone AT nominal (§10.1.2.1); an answer modem's INFO is 1 dB below
 * with a guard 7 dB below (§10.1.2.3.1). Those are the four exceptions and they are
 * the whole of the level structure, so they are held as amplitude factors here
 * rather than restated at each call site.
 *
 * ── §10.1.2.1 / §10.1.2.2 — tones A and B ───────────────────────────────────
 * "Tone A is a 2400 Hz tone transmitted by the answer modem. Transitions between A
 * and Ā, and similarly between Ā and A, are 180 degree phase reversals in the
 * 2400 Hz tone. During the transmission of A and Ā, the answer modem sends a
 * 1800 Hz guard tone without any phase reversals."
 *
 * "Tone B is a 1200 Hz tone transmitted by the call modem", with the same 180°
 * reversals and no guard tone.
 *
 * The reversals are not decoration: §11.2.1.1.4 and §11.2.1.2.4 measure the round
 * trip delay from them, and that is a measurement this transport can actually
 * make — unlike the line-probing analysis, which is why RTD is computed for real
 * below and the probing results are not.
 *
 * ── §10.1.2.3.1 — INFO modulation ───────────────────────────────────────────
 * "All INFO sequences are transmitted using binary DPSK modulation at 600 bit/s.
 * The transmit point is rotated 180 degrees from the previous point if the transmit
 * bit is a 1, and the transmit point is rotated 0 degrees from the previous point
 * if the transmit bit is a 0. Each INFO sequence is preceded by a point at an
 * arbitrary carrier phase. When multiple INFO sequences are transmitted as a group,
 * only the first sequence is preceded by a point at an arbitrary carrier phase."
 *
 * "INFO sequences are transmitted by the answer modem with a carrier frequency of
 * 2400 Hz, at 1 dB below the nominal transmit power, plus a 1800 Hz guard tone 7 dB
 * below the nominal transmit power. INFO sequences are transmitted by the call
 * modem with a carrier frequency of 1200 Hz at the nominal transmit power."
 *
 * Differential, so the arbitrary leading point costs a receiver nothing — which is
 * the same property that lets V34Phase3's JDecoder read J without having seen the
 * TRN symbol its encoder started from.
 *
 * ── §10.1.2.4 — line probing ────────────────────────────────────────────────
 * "L1 is a periodic signal with a repetition rate of 150 Hz which consists of a set
 * of tones (cosines) spaced 150 Hz apart at frequencies from 150 Hz to 3750 Hz.
 * Tones at 900 Hz, 1200 Hz, 1800 Hz, and 2400 Hz are omitted. The initial phase of
 * each cosine is given in Table 17. L1 is transmitted for 160 ms (24 repetitions)
 * at 6 dB above the nominal power level. L2 is the same as L1 but is transmitted
 * for no longer than 550 ms plus a round trip delay at the nominal power level."
 *
 * The four omitted tones are the carrier frequencies the data mode uses, which is
 * why they are omitted and why the omission is asserted rather than hard-coded as a
 * list of twenty-one numbers with no reason attached.
 *
 * ── What this does not do ───────────────────────────────────────────────────
 * L1 and L2 are transmitted faithfully and nothing is measured from them. This
 * transport has no amplitude distortion, no group delay and no noise, so a probing
 * analysis would be measuring a flat channel and reporting what the modem can
 * already run — so INFO1's probing-result fields are filled from the modem's own
 * capability rather than from a measurement, and say so. That is the same division
 * V90Phase3 makes for DIL, and it leaves a later interop receiver ADDING a
 * measurement behind a transmitter that is already the Recommendation's.
 *
 * The round trip delay is the exception: §11.2.1.1.4's and §11.2.1.2.4's estimates
 * come from the tone reversals and are genuinely measurable here, so they are
 * genuinely measured.
 */

const { putUInt, getUInt, crc16, crcCoverage, crcOf } = require('./BitFrame');
// One shared empty list, so BitFrame's skip-set cache has something to key on.
const NO_START_BITS = [];

// ── §10.1.2 — levels, as amplitude factors on the nominal ───────────────────
const dB = (x) => 10 ** (x / 20);
const LEVEL = {
  nominal: 1,
  toneA: dB(-1),          // §10.1.2.1 — 1 dB below nominal
  toneAGuard: dB(0),      // §10.1.2.1 — the guard tone is AT nominal
  toneB: dB(0),           // §10.1.2.2 — no exception stated, so §10.1.2's nominal
  infoAnswer: dB(-1),     // §10.1.2.3.1
  infoAnswerGuard: dB(-7),// §10.1.2.3.1
  infoCall: dB(0),        // §10.1.2.3.1 — "at the nominal transmit power"
  L1: dB(6),              // §10.1.2.4 — "6 dB above the nominal power level"
  L2: dB(0),              // §10.1.2.4 — "at the nominal power level"
};

// ── §10.1.2.1 / §10.1.2.2 — the tones ───────────────────────────────────────
const TONE_A_HZ = 2400, GUARD_HZ = 1800, TONE_B_HZ = 1200;

/** The carrier a modem uses for tones and INFO in Phase 2, by role. */
function toneOf(role) {
  return role === 'answer'
    ? { hz: TONE_A_HZ, level: LEVEL.toneA, guardHz: GUARD_HZ, guardLevel: LEVEL.toneAGuard, name: 'A' }
    : { hz: TONE_B_HZ, level: LEVEL.toneB, guardHz: null, guardLevel: 0, name: 'B' };
}
function infoCarrierOf(role) {
  return role === 'answer'
    ? { hz: TONE_A_HZ, level: LEVEL.infoAnswer, guardHz: GUARD_HZ, guardLevel: LEVEL.infoAnswerGuard }
    : { hz: TONE_B_HZ, level: LEVEL.infoCall, guardHz: null, guardLevel: 0 };
}

// ── §10.1.2.3.1 — 600 bit/s binary DPSK ─────────────────────────────────────
const INFO_BIT_RATE = 600;

/**
 * The absolute phase of each transmitted point, in half-turns, for one INFO
 * sequence. Entry 0 is §10.1.2.3.1's "point at an arbitrary carrier phase" that
 * precedes the sequence; `start` carries it in so that a group of sequences can
 * continue one chain, which is the clause's "only the first sequence is preceded by
 * a point at an arbitrary carrier phase".
 *
 * Returned in half-turns rather than radians so the transcription reads as the
 * clause does — 1 is its "rotated 180 degrees", 0 its "rotated 0 degrees" — and so
 * that a test can compare exactly.
 */
function dpskPhases(bits, start = 0) {
  const out = new Array(bits.length + 1);
  let p = start & 1;
  out[0] = p;
  for (let i = 0; i < bits.length; i++) {
    p = (p + (bits[i] & 1)) & 1;         // a 1 rotates 180°, a 0 rotates 0°
    out[i + 1] = p;
  }
  return out;
}

/** Its inverse: successive points → the bits they carry. No initial state needed. */
function dpskBits(phases) {
  const out = new Array(Math.max(0, phases.length - 1));
  for (let i = 1; i < phases.length; i++) out[i - 1] = (phases[i] ^ phases[i - 1]) & 1;
  return out;
}

// ── §10.1.2.3.3–.5 — the INFO sequences ─────────────────────────────────────
// Tables 14, 15 and 16, transcribed by their bit positions. "Bit 0 is transmitted
// first" in all three, and every multi-bit field is LSB:MSB, which is what putUInt
// writes.
const FILL = [1, 1, 1, 1];                       // "Fill bits: 1111"
const FRAME_SYNC = [0, 1, 1, 1, 0, 0, 1, 0];     // "01110010, left-most bit first in time"

// Table 14/V.34 — INFO0. Sent by both modems; "a" and "c" differ only in carrier.
const INFO0 = {
  name: 'INFO0',
  length: 49,
  fill: [[0, 3], [45, 48]],
  sync: [4, 11],
  crc: [29, 44],
  covers: [12, 28],
  fields: {
    rate2743: [12, 12], rate2800: [13, 13], rate3429: [14, 14],
    lowCarrier3000: [15, 15], highCarrier3000: [16, 16],
    lowCarrier3200: [17, 17], highCarrier3200: [18, 18],
    allow3429: [19, 19], canReducePower: [20, 20],
    maxRateDifference: [21, 23],
    cme: [24, 24], support1664: [25, 25],
    txClockSource: [26, 27],
    ackInfo0: [28, 28],
  },
};

// Table 15/V.34 — INFO1c, the call modem's probing results. Bits 25:33 are one
// nine-bit block per symbol rate and bits 34:78 repeat that block's coding for the
// other five, which is why they are generated rather than listed.
const RATE_BLOCK_BITS = 9;
const INFO1C_RATES = [2400, 2743, 2800, 3000, 3200, 3429];
const INFO1C = {
  name: 'INFO1c',
  length: 109,
  fill: [[0, 3], [105, 108]],
  sync: [4, 11],
  crc: [89, 104],
  covers: [12, 88],
  fields: {
    minPowerReduction: [12, 14],
    additionalPowerReduction: [15, 17],
    mdLength: [18, 24],
    frequencyOffset: [79, 88],
  },
};
// "Probing results pertaining to a final symbol rate selection of N symbols per
// second. The coding of these 9 bits is identical to that for bits 25-33."
for (let k = 0; k < INFO1C_RATES.length; k++) {
  const lo = 25 + k * RATE_BLOCK_BITS;
  const r = INFO1C_RATES[k];
  INFO1C.fields[`highCarrier${r}`] = [lo, lo];
  INFO1C.fields[`preEmphasis${r}`] = [lo + 1, lo + 4];
  INFO1C.fields[`maxDataRate${r}`] = [lo + 5, lo + 8];
}

// Table 16/V.34 — INFO1a, the answer modem's selections.
const INFO1A = {
  name: 'INFO1a',
  length: 70,
  fill: [[0, 3], [66, 69]],
  sync: [4, 11],
  crc: [50, 65],
  covers: [12, 49],
  fields: {
    minPowerReduction: [12, 14],
    additionalPowerReduction: [15, 17],
    mdLength: [18, 24],
    highCarrier: [25, 25],
    preEmphasis: [26, 29],
    maxDataRate: [30, 33],
    answerToCallSymbolRate: [34, 36],
    callToAnswerSymbolRate: [37, 39],
    frequencyOffset: [40, 49],
  },
};

// §10.1.2.3.3 bits 21:23 and Table 16 bits 34:39: "With the symbol rates labelled
// in increasing order, where 0 represents 2400 and 5 represents 3429".
const SYMBOL_RATES = [2400, 2743, 2800, 3000, 3200, 3429];

/** Two's complement over `n` bits, for Table 15's and Table 16's offset fields. */
function putSigned(bits, lo, hi, value) {
  const n = hi - lo + 1;
  putUInt(bits, lo, hi, ((value % (2 ** n)) + 2 ** n) % 2 ** n);
}
function getSigned(bits, lo, hi) {
  const n = hi - lo + 1;
  const v = getUInt(bits, lo, hi);
  return v >= 2 ** (n - 1) ? v - 2 ** n : v;
}
// "the integer shall be set to −512 indicating that this field is to be ignored"
const OFFSET_UNKNOWN = -512;

/** Build one INFO sequence from a spec and a field map. */
function buildInfo(spec, values) {
  const bits = new Array(spec.length).fill(0);
  for (const [lo, hi] of spec.fill) for (let i = lo; i <= hi; i++) bits[i] = FILL[(i - lo) % 4];
  for (let i = 0; i < FRAME_SYNC.length; i++) bits[spec.sync[0] + i] = FRAME_SYNC[i];
  for (const [name, v] of Object.entries(values)) {
    const at = spec.fields[name];
    if (!at) throw new Error(`${spec.name}: no field ${name}`);
    if (name.startsWith('frequencyOffset')) putSigned(bits, at[0], at[1], v);
    else putUInt(bits, at[0], at[1], v);
  }
  const crc = crcOf(bits, NO_START_BITS, spec.covers[0], spec.covers[1] + 1);
  putUInt(bits, spec.crc[0], spec.crc[1], crc);
  return bits;
}

/** Read one back. Returns null if the frame sync or the CRC does not check. */
function parseInfo(spec, bits) {
  if (!bits || bits.length !== spec.length) return null;
  for (let i = 0; i < FRAME_SYNC.length; i++) {
    if (bits[spec.sync[0] + i] !== FRAME_SYNC[i]) return null;
  }
  const want = crcOf(bits, NO_START_BITS, spec.covers[0], spec.covers[1] + 1);
  if (getUInt(bits, spec.crc[0], spec.crc[1]) !== want) return null;
  const out = {};
  for (const [name, at] of Object.entries(spec.fields)) {
    out[name] = name.startsWith('frequencyOffset')
      ? getSigned(bits, at[0], at[1])
      : getUInt(bits, at[0], at[1]);
  }
  return out;
}

// §10.1.2.3.6 — "INFOMARKSc is transmitted by the call modem by applying binary
// ones to the DPSK modulator described in 10.1.2.3.1", and likewise for the answer
// modem. It is the error-recovery signal of §11.2.2 and has no frame; a length is
// whatever the recovery procedure asks for.
function infomarks(count) { return new Array(count).fill(1); }

// ── §10.1.2.4 / Table 17 — the probing tones ────────────────────────────────
// Table 17/V.34, "Probing tones": cos(2πft + φ), transcribed as printed.
const PROBE_TONES = [
  [150, 0], [300, 180], [450, 0], [600, 0], [750, 0],
  [1050, 0], [1350, 0], [1500, 0], [1650, 180], [1950, 0],
  [2100, 0], [2250, 180], [2550, 0], [2700, 180], [2850, 0],
  [3000, 180], [3150, 180], [3300, 180], [3450, 180], [3600, 0], [3750, 0],
];
const PROBE_SPACING_HZ = 150;        // "spaced 150 Hz apart", and the repetition rate
const PROBE_FIRST_HZ = 150, PROBE_LAST_HZ = 3750;
const PROBE_OMITTED_HZ = [900, 1200, 1800, 2400];
const L1_MS = 160, L1_REPETITIONS = 24;
const L2_MAX_MS = 550;               // "no longer than 550 ms plus a round trip delay"

/**
 * The probing signal, evaluated at ABSOLUTE sample indices.
 *
 * Not a period buffer that the caller tiles: the repetition rate is 150 Hz and a
 * sample rate need not be a multiple of it — 8000/150 is 53.33 — so tiling a
 * rounded period walks the phase of every tone. Evaluating cos(2πft + φ) at
 * n/sr is exact at any rate and costs 21 cosines a sample, which for L1's 160 ms
 * is nothing.
 *
 * L1 and L2 are the same waveform at different levels and for different durations,
 * which is exactly what §10.1.2.4 says, so there is one builder and the caller
 * passes LEVEL.L1 or LEVEL.L2.
 */
// The peak of the sum over one continuous 150 Hz period, so that `level` is the
// amplitude the caller means rather than the sum of 21 unit cosines. Scanned finely
// in continuous time, which makes it independent of any sample rate — and that scan
// is 420 000 cosines, which is a fifth of a V.21 call's whole CPU budget spent at
// module load by every protocol, none of which has a probe. Computed on first use
// instead, from the same scan: the value is identical, it is simply not paid for by
// a call that never reaches Phase 2, nor by the page while it is still loading.
let _probePeak = 0;
function probePeak() {
  if (_probePeak) return _probePeak;
  const steps = 20000;
  // Every probe tone is a harmonic of the 150 Hz repetition rate — that is what
  // §10.1.2.4's "spaced 150 Hz apart" means — so at step j the tone at 150·h Hz is
  // at angle 2π·(h·j mod steps)/steps, and the whole scan reads one table of `steps`
  // cosines instead of evaluating 21 of them per step. Table, not approximation:
  // the same angles, each computed once. An initial phase of 180° is a negation,
  // which is why Table 17's phases only ever being 0 or 180 is asserted below.
  const cos = new Float64Array(steps);
  for (let j = 0; j < steps; j++) cos[j] = Math.cos(2 * Math.PI * j / steps);
  const harm = PROBE_TONES.map(([f]) => f / PROBE_SPACING_HZ);
  const sign = PROBE_TONES.map(([, phi]) => (phi === 180 ? -1 : 1));
  let peak = 0;
  for (let j = 0; j < steps; j++) {
    let s = 0;
    for (let i = 0; i < harm.length; i++) s += sign[i] * cos[(harm[i] * j) % steps];
    if (Math.abs(s) > peak) peak = Math.abs(s);
  }
  return (_probePeak = peak);
}

/**
 * The probe's exact period as a sample table, cached per rate.
 *
 * Every tone is a multiple of 150 Hz, so the SAMPLED sequence repeats after
 * sr / gcd(sr, 150) samples — 160 at 8 kHz, where one 150 Hz period is 53.33
 * samples and three of them are 160 exactly. The table is therefore not an
 * approximation of the waveform: it is the whole of it, and indexing it modulo its
 * length gives bit-identical samples to evaluating the 21 cosines directly.
 *
 * That matters for more than tidiness. Summing 21 cosines per sample, at 8000
 * samples a second, is heavy enough that a real-time audio pump falls behind and
 * the start-up appears to hang — which is exactly what it did before this table
 * existed, while every synchronous test passed.
 */
const _probeTables = new Map();
function probeTable(sr) {
  let t = _probeTables.get(sr);
  if (t) return t;
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const n = sr / gcd(sr, PROBE_SPACING_HZ);
  if (!Number.isInteger(n)) throw new Error(`V.34 Phase 2: no whole probe period at ${sr} Hz`);
  t = new Float32Array(n);
  const peak = probePeak();
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (const [f, phi] of PROBE_TONES) s += Math.cos(2 * Math.PI * f * i / sr + phi * Math.PI / 180);
    t[i] = s / peak;
  }
  _probeTables.set(sr, t);
  return t;
}

/** One sample of the probe at an absolute index. O(1), and the whole hot path. */
function probeSample(sr, index, level = 1) {
  const t = probeTable(sr), n = t.length;
  return t[((index % n) + n) % n] * level;
}

function probeSamples(sr, count, level = 1, startIndex = 0) {
  const t = probeTable(sr), n = t.length;
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) out[i] = t[((startIndex + i) % n + n) % n] * level;
  return out;
}

// ── Structure the Recommendation fixes, asserted at load ────────────────────
(function assertStructure() {
  const bad = (m) => { throw new Error(`V.34 Phase 2: ${m}`); };

  // §10.1.2.4: 150 Hz to 3750 Hz spaced 150 Hz, less the four omitted. Generating
  // the expected set and comparing is what makes the omission a stated property
  // rather than an accident of a hand-typed list.
  const expect = [];
  for (let f = PROBE_FIRST_HZ; f <= PROBE_LAST_HZ; f += PROBE_SPACING_HZ) {
    if (!PROBE_OMITTED_HZ.includes(f)) expect.push(f);
  }
  const got = PROBE_TONES.map(([f]) => f);
  if (got.join(',') !== expect.join(',')) bad(`Table 17 tones are ${got} — expected ${expect}`);
  for (const [f, phi] of PROBE_TONES) {
    if (phi !== 0 && phi !== 180) bad(`Table 17: ${f} Hz has initial phase ${phi}, not 0 or 180`);
  }
  // The omitted tones are the data mode's carrier frequencies, which is why they
  // are omitted; tone A, tone B and the guard are three of the four.
  for (const f of [TONE_A_HZ, TONE_B_HZ, GUARD_HZ]) {
    if (!PROBE_OMITTED_HZ.includes(f)) bad(`${f} Hz is a Phase 2 carrier but is not omitted from the probe`);
  }
  // "160 ms (24 repetitions)" at 150 Hz has to be self-consistent.
  if (Math.round(L1_REPETITIONS * 1000 / PROBE_SPACING_HZ) !== L1_MS) {
    bad(`${L1_REPETITIONS} repetitions at ${PROBE_SPACING_HZ} Hz is not ${L1_MS} ms`);
  }

  // §10.1.2.3.1: a 1 rotates 180°, a 0 does not; and the decode is its own inverse
  // whatever the arbitrary leading point was.
  const probe = [1, 0, 1, 1, 0, 0, 0, 1];
  for (const start of [0, 1]) {
    const ph = dpskPhases(probe, start);
    if (ph[0] !== start) bad('the leading point is not the arbitrary phase given');
    if (dpskBits(ph).join(',') !== probe.join(',')) bad('DPSK does not round-trip');
  }

  // Tables 14, 15 and 16: every field inside the sequence, no field overlapping the
  // fill, the sync or the CRC, and the CRC covering exactly what §10.1.2.3.2 says.
  for (const spec of [INFO0, INFO1C, INFO1A]) {
    const reserved = new Set();
    for (const [lo, hi] of spec.fill) for (let i = lo; i <= hi; i++) reserved.add(i);
    for (let i = spec.sync[0]; i <= spec.sync[1]; i++) reserved.add(i);
    for (let i = spec.crc[0]; i <= spec.crc[1]; i++) reserved.add(i);
    for (const [name, [lo, hi]] of Object.entries(spec.fields)) {
      if (lo < 0 || hi >= spec.length) bad(`${spec.name}.${name} is outside the sequence`);
      for (let i = lo; i <= hi; i++) {
        if (reserved.has(i)) bad(`${spec.name}.${name} overlaps a fill, sync or CRC bit at ${i}`);
      }
    }
    if (spec.covers[0] !== spec.sync[1] + 1 || spec.covers[1] !== spec.crc[0] - 1) {
      bad(`${spec.name}: the CRC does not cover exactly the information bits`);
    }
    // Round-trip an all-zero sequence and one with every field at its maximum.
    for (const fill of [0, 1]) {
      const values = {};
      for (const [name, [lo, hi]] of Object.entries(spec.fields)) {
        values[name] = fill ? (name.startsWith('frequencyOffset') ? 511 : 2 ** (hi - lo + 1) - 1) : 0;
      }
      const bits = buildInfo(spec, values);
      const back = parseInfo(spec, bits);
      if (!back) bad(`${spec.name} does not parse back at fill ${fill}`);
      for (const name of Object.keys(spec.fields)) {
        if (back[name] !== values[name]) bad(`${spec.name}.${name} round-trips as ${back[name]}, not ${values[name]}`);
      }
      // A single flipped information bit must fail the CRC, which is the whole
      // reason the CRC is here rather than decorative.
      const broken = bits.slice();
      broken[spec.covers[0]] ^= 1;
      if (parseInfo(spec, broken)) bad(`${spec.name}: a flipped information bit passes the CRC`);
    }
    // The frequency-offset "ignore this field" value must survive as itself.
    const offsetField = Object.keys(spec.fields).find((n) => n.startsWith('frequencyOffset'));
    if (offsetField) {
      const bits = buildInfo(spec, { [offsetField]: OFFSET_UNKNOWN });
      if (parseInfo(spec, bits)[offsetField] !== OFFSET_UNKNOWN) {
        bad(`${spec.name}: the −512 "ignore" offset does not round-trip`);
      }
    }
  }
  // Table 15's six nine-bit blocks must tile bits 25:78 exactly.
  const blocks = INFO1C_RATES.map((r) => INFO1C.fields[`highCarrier${r}`][0]);
  if (blocks[0] !== 25 || blocks[blocks.length - 1] + RATE_BLOCK_BITS - 1 !== 78) {
    bad('Table 15: the six probing-result blocks do not fill bits 25:78');
  }
  if (SYMBOL_RATES.length !== 6 || SYMBOL_RATES[0] !== 2400 || SYMBOL_RATES[5] !== 3429) {
    bad('the symbol rate ladder is not 0 = 2400 through 5 = 3429');
  }

  // "a periodic signal with a repetition rate of 150 Hz": the samples one period
  // apart must agree, which is what generating from an absolute index buys and
  // what tiling a rounded period would quietly lose. 8000/150 is 53.33, so this
  // fails on any implementation that rounds it.
  {
    const sr = 8000, period = sr / PROBE_SPACING_HZ;
    const a = probeSamples(sr, 64, 1, 0);
    const b = probeSamples(sr, 64, 1, period * 3);          // 3 periods = 160 samples
    for (let i = 0; i < 64; i++) {
      if (Math.abs(a[i] - b[i]) > 1e-9) bad(`the probe is not periodic at ${PROBE_SPACING_HZ} Hz`);
    }
    // Peak-normalised, so a caller's level is the amplitude it asked for.
    let peak = 0;
    const one = probeSamples(sr, 4000, 1, 0);
    for (const v of one) if (Math.abs(v) > peak) peak = Math.abs(v);
    if (peak > 1.0001) bad(`the probe overshoots its level: peak ${peak}`);
  }
})();

module.exports = {
  LEVEL, dB,
  TONE_A_HZ, TONE_B_HZ, GUARD_HZ, toneOf, infoCarrierOf,
  INFO_BIT_RATE, dpskPhases, dpskBits, infomarks,
  FILL, FRAME_SYNC, INFO0, INFO1C, INFO1A, INFO1C_RATES, RATE_BLOCK_BITS,
  SYMBOL_RATES, OFFSET_UNKNOWN, buildInfo, parseInfo, putSigned, getSigned,
  PROBE_TONES, PROBE_SPACING_HZ, PROBE_OMITTED_HZ,
  L1_MS, L1_REPETITIONS, L2_MAX_MS, probePeak, probeTable, probeSample, probeSamples,
};
