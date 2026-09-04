# SynthLink — Protocol Authenticity Backlog

**A work queue, not a reference.** Each item is meant to be done and struck out.
When nothing is left but the "Not doing" list, fold that into PROTOCOLS.md and
delete this file. Anything that must outlive it belongs in PROTOCOLS.md (what a
protocol is) or CLAUDE.md (how to work here) — do not grow this document.

Read PROTOCOLS.md first for what each protocol currently is.

---

## Reading a spec table or figure

Both routes are needed; they fail in different places.

**Tables and prose clauses — `WebFetch` the ITU PDF.** Asked normally the
retrieval *reconstructs* tables and returns confident wrong values. Forbid that
explicitly, one table per call:

> Do not summarise or reconstruct. Transcribe literally **Table N/V.xx** exactly
> as printed, preserving every cell. If you cannot read the table's cells
> directly, reply with exactly `CANNOT READ TABLE` and nothing else. Do not infer
> values from any formula.

Then cross-check against the spec's own formulas or a second edition. This has
returned Tables 2/14/16 of V.90, Tables 7/8/10/20 of V.34, and §10.1.2.3.2
verbatim. It catches real errors: Table 8's last two rows came back
column-shifted, and §8.2's arithmetic (`N = R·0.28/J`, `b = ⌈N/P⌉`,
`r = N − (b−1)P`, one-count of SWP = r) exposed it.

**Figures — the same call returns `CANNOT READ TABLE`, so use the converted
sources instead.** `tools/datasource/` holds the Recommendations converted to
HTML by `pdf2htmlEX`, which preserves the figure's text layer: point labels are
ordinary positioned text. Read the labels there and the geometry from a
screenshot of the same page, then check the two against each other. Neither half
is a transcription on its own.

Page anchors in the converted files (`<div id="pfN">`, N in hex):

| Figure | Source | Div | Printed p. |
|---|---|---|---|
| 2-1/V.32bis — 14400 constellation | V.32bis | `pf6` | 4 |
| 2-2/V.32bis — 12000 | V.32bis | `pf7` | 5 |
| 2-3..2-5/V.32bis — 9600/7200/4800 | V.32bis | `pf8`+ | 7–8 |
| 5/V.34 — superconstellation quarter (done) | V.34 | `pf14` | 14 |
| 14/V.34 — CRC register | V.34 | not located yet | — |

Method, with the traps that cost time:

1. **Labels — track the pen, not the document order.** Each `<div class="t ...">`
   carries a true `x` from its CSS class; inside it, glyphs advance and `<span
   class="_ _N">` elements reposition. Those spans are `._N{width:…}` **or**
   `._N{margin-left:−…}`, and the negative ones move the pen BACKWARDS: on
   Figure 5 the row at Im = −43 prints 393 second and draws it last. So document
   order is not reading order either — accumulate the pen across widths, negative
   margins and glyph advances, multiply by `.m0`'s transform scale, add the div's
   `x`, and sort by that. A wide span also ends a number; a hair-width one is
   intra-number kerning, so split on the width.
2. **Geometry.** Read the axis ticks for scale and the row's own pen `x` for its
   first column; screenshot, threshold and find the marks as connected components
   where the labels are absent or the axis is ambiguous. On Figure 2-1 the ticks
   are 2 units apart and the dots 1 — measuring that is what showed the lattice
   was `Re+Im odd`, not the odd-integer grid that had been assumed. On Figure 5
   the ticks are 4 apart on both axes, which is what showed the quarter is a
   mod-4 sublattice and not a quadrant.
3. **Cross-check.** Each row's labels from the text layer must equal the row read
   off the image, in order and starting at the same column. Reading the image
   alone misplaced `1101110`; a mis-scaled column pitch on Figure 5 put 15 of 23
   rows at the wrong offset while every label was correct.
4. **Assert the structure the spec fixes**, at module load, and check it in with
   the table. For V.32bis that is the rotational invariants of the differential
   coding — a shuffled map passes a bijection check but fails those.

---

## 1. V.32bis — multi-rate + rate renegotiation  *(next)*

Needs Figures 2-2..2-5 (12000/9600/7200/4800) by the same route, then the
fallback constellations and §8 change-rate-without-retrain. The rate signal
already advertises the full set and negotiates the max; only 14400 is wired for
data.

Do one rate at a time and assert each constellation's own rotational invariant —
same shape as 14400's, different bit positions, since the lower rates carry fewer
uncoded bits.

## 2. V.90 — CRC register shift direction

The one unverified degree of freedom left in the CRC. §10.1.2.3.2 fixes
everything else and is honoured; the direction lives only in Figure 14, which
refused `WebFetch` and has **not** been retried against the converted V.34
source. Locate it there first — it is the cheapest item in this file. MSB-first
is the current assumption, and no test vector is printed in the clause.

## 3. V.90 — Phase 2–3 and the rest of the real-line gap  *(high effort)*

Only worth doing if real-hardware interop becomes a goal. Full analysis in
PROTOCOLS.md, V.90's "For real-modem interop". What is missing:

- Phase 2–3 state machine: INFO0/INFO1, line probing, ranging, digital impairment
  learning.
- Robbed-bit signalling and digital-pad detection. The data frame is six symbols
  and each interval may carry its own constellation *for this reason* — the
  structure exists and is unused, so the mapper needs no change, only the
  detection and per-interval mask selection. CP already carries six constellation
  indices.
- A-law codebook. CP bit 35 already selects the codec and is parsed.
- Carry CP/MP in real Phase 4 signalling rather than as bytes.
- Honour Table 15 power limits (on a real US line the FCC limit capped this at
  53 333, D = 40).

---

## Done

One line each; the durable description of each lives in PROTOCOLS.md.

- **V.90 CRC convention.** §10.1.2.3.2 transcribed from two editions. The
  coverage was wrong — the CRC must exclude frame sync, start and fill bits.
  `crcCoverage()` in `BitFrame.js`; `v90-phase4-check` asserts both halves.
- **V.34 genuine MP/MP′.** Table 20 at its literal bit positions, load-bearing
  exchange, `V34Phase4.js`. MP Type 1 (precoder coefficients) not done: there is
  no precoder on this link.
- **V.34 Figure 5 point numbering.** Transcribed and shipped, all 416 labels. Like
  Figure 2-1 it *replaced* the point set: the quarter is the Re ≡ Im ≡ 1 (mod 4)
  sublattice, not the first quadrant the code assumed, and the two share no
  points. The harness holds the figure row by row.
- **V.32bis Figure 2-1.** Transcribed and shipped. It *replaced* the
  constellation rather than relabelling it — the old map shared **zero** points
  with the Recommendation's — and moved `REF` off (7,7), which is not a point of
  the real constellation.
- **Self-validating configs.** V.34 `makeConfig` (Table 10 Minimum row,
  constant-`b` arithmetic), V.32bis (constellation lattice, rotational
  invariants, Table 5 word), V.90 (`∏Mᵢ ≥ 2^K`, Table 2 bounds). Do the same for
  anything transcribed from here on: it is what makes a mis-transcription fail at
  `require()` instead of producing a link that works only against itself.

---

## Not doing (deliberately)

- **V.29 onto V.8.** `v29hd` exists as a mode bit so the cost is low, but V.29 is
  half-duplex ping-pong with its own audible connect script and was parked.
- **V.8bis.** No protocol here needs it.
- **Viterbi decoders.** On a lossless link the coding gain is unused; only
  worthwhile as part of a real backport. No longer *blocked* for V.32bis at
  14400 — the Recommendation's set partition is now on the wire, so a decoder
  would have the map its parallel-transition structure needs. V.34 stays gated on
  the same decoder work, not on the map — its constellation is now the
  Recommendation's.
