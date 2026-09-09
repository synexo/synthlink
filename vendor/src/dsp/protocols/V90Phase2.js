'use strict';
/**
 * §8.2 and §9.2/V.90 — Phase 2's INFO sequences, and what makes them V.90's.
 *
 * The SIGNALS of V.90's Phase 2 are not V.90's. §8.2.1 defines tone A as
 * "10.1.2.1/V.34", §8.2.2 tone B as "10.1.2.2/V.34", §8.2.4 the probing signals as
 * "10.1.2.4/V.34", and §8.2.3.1's DPSK modulator, its 600 bit/s, its carriers and
 * its levels are §10.1.2.3.1/V.34 word for word — so every one of them comes from
 * `V34Phase2.js` here rather than being written again. §8.2.3.2's CRC is
 * "10.1.2.3.2/V.34" likewise.
 *
 * §9.2's PROCEDURE is also §11.2/V.34's, clause for clause, with the two modems
 * renamed: the digital modem plays the part V.34 gives the call modem (INFO0d,
 * tone B) and the analogue modem the part V.34 gives the answer modem (INFO0a,
 * tone A). Every duration matches — 75 ± 5 ms of silence, ≥ 50 ms of tone A,
 * 40 ± 1 ms turnarounds with 10 ms after each reversal, L1's 160 ms, L2's ≤ 500 ms
 * received and ≤ 550 ms transmitted — and so does every recovery bound in §9.2.1.2
 * and §9.2.2.2: 2000 ms, 900 ms + RTD, 650 ms + RTD, 700 ms + RTD, 600 ms + RTD,
 * 2000 ms + 2 RTD. That is why V.34's step machine runs this procedure and this
 * file adds no second one.
 *
 * What IS V.90's, and all this module holds:
 *   Table 7  — INFO0d, the digital modem's INFO0. Twelve bits longer than any V.34
 *              INFO0: it declares transmit power, which codec law is in use, and
 *              whether 3429 is available upstream.
 *   Table 8  — INFO0a. Laid out exactly as Table 14/V.34's INFO0, and asserted
 *              against it below rather than restated.
 *   Table 9  — INFO1d. "The bit definitions are identical to those of INFO1c in
 *              Recommendation V.34", and asserted against Table 15/V.34 likewise.
 *   Table 10 — INFO1a when V.90 is selected. This one is V.90's own: it carries
 *              UINFO, the upstream symbol rate, and the integer 6 in bits 37:39
 *              that chooses V.90 over V.34.
 *
 * The mode field is the hinge of the whole Recommendation. §9.2.1.1.8: bits 37:39
 * of INFO1a indicating 6 sends the digital modem to V.90's Phase 3; an integer
 * between 0 and 5 sends it to §11.3.1.1/V.34 "assuming the role of a call modem",
 * and that integer is then a V.34 symbol rate rather than a mode — which is why
 * Table 10 and Table 11 are two tables and not one with a flag.
 */
const P2 = require('./V34Phase2');

// ── Table 7/V.90 — INFO0d ───────────────────────────────────────────────────
// "Bit 0 is transmitted first in time", and every multi-bit field is LSB:MSB, as
// in V.34. Bits 12 to 25 are Table 14/V.34's capability bits unchanged — they
// describe V.34 MODE, which is what a V.90 digital modem falls back to — so they
// carry the same field names here and a check asserts the positions agree.
const INFO0D = {
  name: 'INFO0d',
  length: 62,
  fill: [[0, 3], [58, 61]],
  sync: [4, 11],
  crc: [42, 57],
  covers: [12, 41],
  fields: {
    rate2743: [12, 12], rate2800: [13, 13], rate3429: [14, 14],
    lowCarrier3000: [15, 15], highCarrier3000: [16, 16],
    lowCarrier3200: [17, 17], highCarrier3200: [18, 18],
    allow3429: [19, 19], canReducePower: [20, 20],
    maxRateDifference: [21, 23],
    cme: [24, 24], support1664: [25, 25],
    // 26:27 — "Reserved for the ITU: These bits are set to 0 by the digital modem
    // and are not interpreted by the analogue modem". Table 14/V.34 has the
    // transmit clock source at these two positions; V.90 reserves them instead, so
    // the name changes with the meaning even though the position does not.
    reserved26: [26, 27],
    ackInfo0: [28, 28],
    // 29:32 — "Digital modem nominal transmit power for Phase 2 ... in −1 dBm0
    // steps where 0 represents −6 dBm0 and 15 represents −21 dBm0".
    nominalPower: [29, 32],
    // 33:37 — "Maximum digital modem transmit power ... in −0.5 dBm0 steps where 0
    // represents −0.5 dBm0 and 31 represents −16 dBm0".
    maxPower: [33, 37],
    // 38 — "power shall be measured at the output of the codec. Otherwise ... at
    // its terminals".
    powerAtCodec: [38, 38],
    // 39 — "PCM coding in use by digital modem: 0 = µ-law, 1 = A-law".
    aLaw: [39, 39],
    // 40 — "ability to operate V.90 with an upstream symbol rate of 3429".
    upstream3429: [40, 40],
    reserved41: [41, 41],
  },
};

// ── Table 8/V.90 — INFO0a ───────────────────────────────────────────────────
// Table 8 prints Table 14/V.34's layout again for the analogue modem, so INFO0a IS
// V.34's INFO0 and is taken from there rather than transcribed twice. The one
// difference is in the prose and not in the layout: bits 26:27 are reserved here
// where V.34 carries the transmit clock source, and both are zero on this link.
const INFO0A = P2.INFO0;

// ── Table 9/V.90 — INFO1d ───────────────────────────────────────────────────
// "The bit definitions are identical to those of INFO1c in Recommendation V.34 and
// are given here for convenience" — so it is INFO1c, under the digital modem's
// name for it, and the assertions below hold that claim to the printed table.
const INFO1D = P2.INFO1C;

// ── Table 10/V.90 — INFO1a when V.90 is selected ────────────────────────────
const INFO1A_V90 = {
  name: 'INFO1a(V.90)',
  length: 70,
  fill: [[0, 3], [66, 69]],
  sync: [4, 11],
  crc: [50, 65],
  covers: [12, 49],
  fields: {
    reserved12: [12, 17],
    // 18:24 — "Length of MD to be transmitted by the analogue modem during Phase 3
    // ... in 35 ms increments", which is Table 16/V.34's field at the same place.
    mdLength: [18, 24],
    // 25:31 — "UINFO: Ucode of the PCM codeword to be used by the digital modem for
    // the 2 point train ... UINFO shall be greater than 66".
    uinfo: [25, 31],
    reserved32: [32, 33],
    // 34:36 — "Symbol rate to be used in transmitting from the analogue modem to
    // the digital modem. An integer between 3 and 5 gives the symbol rate, where 3
    // represents 3000 and 5 represents 3429" — the same labelling as Table 16/V.34
    // and §10.1.2.3.3, restricted to its top three entries.
    upstreamSymbolRate: [34, 36],
    // 37:39 — "Symbol rate of 8000 to be used by the digital modem: The integer 6".
    // §9.2.1.1.8 reads this field as the MODE: 6 is V.90, 0 to 5 is V.34 at that
    // symbol rate.
    mode: [37, 39],
    // 40:49 — the same two's complement 1050 Hz offset Table 15/V.34 carries at
    // 79:88. Table 10 says "Bit 9 is the sign bit", numbering within the FIELD
    // where Table 9 numbers within the sequence; both mean the field's top bit.
    frequencyOffset: [40, 49],
  },
};

// §9.2.1.1.8 / §9.2.2.1.9 — the integer in bits 37:39 that asks for V.90 rather
// than for V.34 at one of symbol rates 0 to 5.
const MODE_V90 = 6;
// Table 10 — "UINFO shall be greater than 66", so 67 is the floor and the field's
// own seven bits are the ceiling.
const UINFO_MIN = 67, UINFO_MAX = 127;
// Table 10 bits 34:36 — "an integer between 3 and 5", indices into V.34's own
// symbol rate labelling.
const UPSTREAM_RATE_INDEX_MIN = 3, UPSTREAM_RATE_INDEX_MAX = 5;

// ── What the tables must be, checked at load ────────────────────────────────
// The same discipline as V34Phase2's own assertions and V90Phase3's: a claim the
// Recommendation makes about a table is checked here, so a transcription error
// fails at require time rather than on the wire. Two of these tables are claimed
// by V.90 to BE V.34's, and that claim is the thing being checked.
(function assertTables() {
  const bad = (m) => { throw new Error(`V90Phase2: ${m}`); };
  const layout = (s) => JSON.stringify([s.length, s.fill, s.sync, s.crc, s.covers]);

  // Table 8 against Table 14/V.34, and Table 9 against Table 15/V.34.
  if (INFO0A !== P2.INFO0) bad('INFO0a must be Table 14/V.34 itself');
  if (INFO1D !== P2.INFO1C) bad('INFO1d must be Table 15/V.34 itself');

  // Table 10's frame furniture is Table 16/V.34's — same length, same fill, sync
  // and CRC placement — with different fields between. Worth pinning: it is what
  // makes one parser serve both, and a drift would present as a CRC failure.
  if (layout(INFO1A_V90) !== layout(P2.INFO1A)) {
    bad('Table 10 should share Table 16/V.34\'s frame layout');
  }

  for (const spec of [INFO0D, INFO1A_V90]) {
    // Every bit of the sequence is accounted for exactly once: the fill runs, the
    // frame sync, the CRC, and the fields. A field that overlaps another, or a gap
    // the transcription dropped, fails here rather than silently on the line.
    const owner = new Array(spec.length).fill(null);
    const claim = (lo, hi, what) => {
      if (hi >= spec.length) bad(`${spec.name}: ${what} runs past bit ${spec.length - 1}`);
      for (let i = lo; i <= hi; i++) {
        if (owner[i]) bad(`${spec.name}: bit ${i} is both ${owner[i]} and ${what}`);
        owner[i] = what;
      }
    };
    for (const [lo, hi] of spec.fill) claim(lo, hi, 'fill');
    claim(spec.sync[0], spec.sync[0] + 7, 'sync');
    claim(spec.crc[0], spec.crc[1], 'CRC');
    for (const [name, at] of Object.entries(spec.fields)) claim(at[0], at[1], name);
    const gap = owner.indexOf(null);
    if (gap >= 0) bad(`${spec.name}: bit ${gap} belongs to nothing`);
    // §8.2.3.2's CRC covers the information bits: everything from the end of the
    // frame sync to the bit before the CRC.
    if (spec.covers[0] !== spec.sync[0] + 8 || spec.covers[1] !== spec.crc[0] - 1) {
      bad(`${spec.name}: CRC coverage does not meet the frame sync and the CRC`);
    }
  }

  // Table 10's own stated values.
  if (MODE_V90 !== 6) bad('bits 37:39 select V.90 with the integer 6');
  if (UINFO_MIN <= 66) bad('UINFO shall be greater than 66');
  if (P2.SYMBOL_RATES[UPSTREAM_RATE_INDEX_MIN] !== 3000
      || P2.SYMBOL_RATES[UPSTREAM_RATE_INDEX_MAX] !== 3429) {
    bad('bits 34:36 run 3 = 3000 to 5 = 3429');
  }
})();

module.exports = {
  INFO0D, INFO0A, INFO1D, INFO1A_V90,
  MODE_V90, UINFO_MIN, UINFO_MAX,
  UPSTREAM_RATE_INDEX_MIN, UPSTREAM_RATE_INDEX_MAX,
};
