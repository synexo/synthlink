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

**A timeline figure is not a constellation figure.** Figures 4 and 5/V.90 are
sequence diagrams whose signal names and durations are ordinary text in the
layer; they transcribe by the normal route and need no screenshot. Only figures
whose content is a *point set* refuse.

Page anchors in the converted files (`<div id="pfN">`, N in hex):

All five Recommendations are now in `tools/datasource/` as `pdf2htmlEX` output;
V.90's was added when the Phase 3 work needed §§8.3–8.4 and 9.3. **For a procedure,
prefer the prose clause to the figure**: §9.3.1 states Phase 3's order
unambiguously where Figure 5's label layer interleaves the two modems' rows and
its duration marks do not attach to a signal.

| Figure / clause | Source | Div | Printed p. |
|---|---|---|---|
| 2-1/V.32bis — 14400 constellation | V.32bis | `pf6` | 4 |
| 2-2/V.32bis — 12000 | V.32bis | `pf7` | 5 |
| 2-3..2-5/V.32bis — 9600/7200/4800 | V.32bis | `pf8`+ | 7–8 |
| 5/V.34 — superconstellation quarter (done) | V.34 | `pf14` | 14 |
| 14/V.34 — CRC register | V.34 | not located yet | — |
| §8.2 Phase 2 signals; INFO DPSK modulation | V.90 | `pf14` | 12 |
| Table 10 — INFO1a; §8.2.4 line probing | V.90 | `pf18` | 16 |
| §8.3.1 Ja; Table 12 — DIL descriptor | V.90 | `pf19`–`pf1b` | 17–19 |
| §8.4.1 DIL construction | V.90 | `pf1c` | 20 |
| Table 13 — Jd; §8.4.3 J′d; §8.4.4 Sd | V.90 | `pf1d` | 21 |
| §8.4.5 TRN1d; §8.5 Phase 4 analogue | V.90 | `pf1e` | 22 |
| §8.6 Phase 4 digital; Table 17 | V.90 | `pf21`–`pf24` | 25–28 |
| §9.1.1 Use of bits in V.8 | V.90 | `pf24` | 28 |
| **Figure 4 — Phase 2 timeline, all durations** | V.90 | `pf26` | 30 |
| §9.2 Phase 2 procedures, both modems | V.90 | `pf26`–`pf28` | 30–32 |
| **Figures 5 and 6 — Phase 3 timelines, all durations** | V.90 | `pf29` | 33 |

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

## How this queue is ordered

**Audible authenticity is the priority, and it is the cheap half of interop.**
Sounding right needs only transmitters: each signal emitted with its real bit
content at its real duration, and each end waiting for the peer's before
advancing. Every measurement those signals feed is a no-op on this transport, so
receivers stay presence-and-end detectors — `V90.js`'s `_huntSd` already is
exactly that. Build each signal so that later interop work *adds* a measuring
receiver behind a real transmitter, rather than replacing an invented one.
Nothing in items 1–6 should have to be undone to reach real-hardware interop, and
most of it is work that interop would have required anyway. The struck items
already followed this rule — the DIL below is transmitted faithfully and measured
not at all, so a measuring receiver is an addition rather than a replacement.

Items are ordered by audible payoff per unit of effort, and by what each one
leaves in place for the next. The two large signal-machine items (1 and 3) are
now at the top because everything additive has been done.

**Phase 1 is already genuine, and single-protocol dialling is authentic.** A dial
sets `protocolPreference` and `v8ModulationModes` to the selected protocol and
runs the full V.8 exchange advertising exactly that one modulation — which is a
real modem that supports one modulation, dialling. It is not `forceProtocol`'s
V.8 bypass, which nothing in the shipping path sets. The V.8 implementation is a
faithful spandsp port, hardware-validated in synthmodem, and is not in question
here — note that the two category octets a V.90 dial now also sends had never
been on a wire in either repository, so they are the one part of V.8 here that
hardware has not seen. Two rows of the advertisement
are worth knowing: Bell 103 advertises an empty mode set (V.8 has no bit for it),
which reaches the right outcome by a different route than a real Bell-103-only
modem would; and V.32/V.32bis and V.22/V.22bis each share one V.8 bit, which is
V.8's own design, disambiguated locally from `protocolPreference`.

**Where a shorter start-up is wanted, take it from the knobs the Recommendations
provide rather than by omission.** V.90 leaves DIL length to the analogue modem
(§8.4.1; N = 0 means DIL is not transmitted, and Figure 6 defines that case),
MD length to INFO1a bits 18:24, and states TRN, TRN1d, DIL and L2 as bounds
rather than values. Choosing a short legal value is authentic; dropping a
required signal is not. **Settled for DIL:** N = 32 segments of 768 symbols is
3.07 s in one pass, inside Figure 5's ≤5 s, which puts a V.90 connect at 6.6 s
against a real modem's 15–25 s. Recognisably a 56k handshake without the full
wait. One constant in `V90.js` moves it either way.

### Measured baseline

`node tools/connect-timing.js` is the instrument: two `ModemDSP`s wired
audio↔audio, RMS per direction in 100 ms bins, ANSam onset to the later of the
two `connected` events, counted in samples rather than wall clock. `GAPS=1` adds
the runs of near-silence per direction and `BINS=1` an amplitude trace. Re-measure
after each item; this is how you tell whether the audio actually moved.

| Protocol | Now | Real, approx |
|---|---|---|
| V.21 | 3.0 s | ~3 s |
| V.23 | 3.0 s | ~3 s |
| V.22bis | 3.6 s | ~5–7 s |
| V.22 | 4.6 s | ~5–6 s |
| V.32 | 3.1 s | ~8–10 s |
| V.32bis | 3.1 s | ~10–12 s |
| V.34 | 3.0 s | ~12–20 s |
| V.90 | **6.6 s** | ~15–25 s |

The "real" column is recollection, not transcription — replace each figure with
one derived from the Recommendation as that protocol's item is done. Bell 103 is
absent deliberately: its ~7 s is the V.8 no-deal fallback, which is what real
hardware does and is not a defect. V.29 is not in the menu and is not worked on.
The off-hook gap is excluded from every figure and is now a real 1.00 s.

V.32, V.32bis and V.34 still landing within 0.1 s of each other is the tell: that
duration is the shared V.8 front end plus one 250 ms house training burst, and the
protocol's own complexity contributes nothing. V.90 has left the cluster because
its Phase 3 is real; the others leave it at item 1.

**Two gaps to watch shrink.** With `GAPS=1` a V.90 connect still shows the answer
side silent 3.1–4.1 s and the originate side 3.1–3.7 s. The first is the window
where the analogue modem's Phase 3 belongs (items 1–2); the second is `ORIG_LEAD`,
which item 1 absorbs.

---

## 1. V.34 Phase 3 segments — S, S̄, PP, TRN, MD, SCR

`_buildAATrain()` is 250 ms of alternating REF points standing in for the whole
of V.34 Phase 3, and V.32, V.32bis and V.90 inherit it. Replacing it once serves
four protocols. V.34 §10.1.3 defines each segment; V.90 §8.3 references them
rather than redefining, so this serves both. Figure 5/V.90 (`pf29`) gives the
order and durations for the V.90 case: S(128T) S̄(16T) MD S(128T) S̄(16T) PP(48T)
TRN(≥512T).

This absorbs `ORIG_LEAD`. That constant — `V34.js`, 0.60 s of originate-side
silence before training, with no spec basis — is the dead air heard on a V.90
call. It is not a V.90 defect: V.34 has it too, hidden because the answer side
fills the window with its own tone. Phase 3 begins straight after CJ, so the
constant stops existing rather than being tuned.

Bigger and more regression-prone than anything above it: four protocols share the
path and `dsptest2` must stay green for all of them. Do one protocol at a time.

## 2. V.90 upstream Phase 3 — Ja on the wire

With item 1 in place, move the DIL descriptor from the DLE byte channel onto real
Ja (§8.3.1, modulation per 10.1.3.3/V.34), and add the analogue side's MD/PP/S/
SCR/TRN placement from Figure 5. The descriptor content is already built and
asserted; this changes only how it crosses the wire.

It also retires the two places Phase 3 currently agrees by constant instead of by
signal, both for want of the analogue modem's S: §9.3.1.5 repeats Jd until S is
detected, so the repetition count is a constant both ends read
(`_phase3Symbols()`); and §9.3.1.6 ends DIL on an S-to-S̄ transition, so DIL plays
exactly one repetition. Neither is a shortcut past the clause — one repetition
ends on a segment boundary, which is all §8.4.1 requires — but neither is the
procedure either.

## 3. V.34 Phase 2 — INFO0/INFO1, tone A/B, L1/L2 probing

The line probe: audibly the most recognisable part of a V.34-family connect after
DIL. Needs a 600 bit/s binary DPSK modulator for the INFO sequences (§8.2.3.1:
2400 Hz from the analogue modem with an 1800 Hz guard tone, 1200 Hz from the
digital modem), which is new modulation and the reason this sits below item 1.
L1/L2 are defined in 10.1.2.4/V.34.

## 4. V.90 Phase 2 — probing/ranging

Figure 4 (`pf26`) for the timeline — INFO0d, Tone B, INFO0a, Tone A reversal,
Tone B reversal at 40 ± 1 ms, L1 for 160 ms, L2 for ≤500 ms, the same again in
the other direction, INFO1d, INFO1a. §9.2.1 and §9.2.2 are the two state
machines; Table 10 (`pf18`) is INFO1a.

Depends on item 3 for the tones and probing signals. Retires the locally-chosen
parameters Phase 3 leaves behind: U_INFO (fixed at 111, its legal maximum), the
upstream symbol rate, MD length and the DIL descriptor all become negotiated
values. Table 10 is where U_INFO comes from — bits 25:31.

## 5. V.90 — CRC register shift direction

The one unverified degree of freedom left in the CRC. §10.1.2.3.2 fixes
everything else and is honoured; the direction lives only in Figure 14, which
refused `WebFetch` and has **not** been retried against the converted V.34
source. Locate it there first — it remains the cheapest item in this file, and Jd
and the DIL descriptor are now two more consumers of the same generator, so four
sequences ride on it rather than two. MSB-first is the current assumption, and no
test vector is printed in the clause.

## 6. CP and MP onto real Phase 4 signalling

The bit layouts of Tables 14 and 16 are genuine and asserted; the finished
sequences are packed into bytes and carried over the established link rather than
modulated by the Phase 4 signalling. Move them onto B1/B1d, E/Ed, R and TRN2d
(§8.5, §8.6, Table 17 — `pf1e`–`pf24`). Last of the audio items because by then
it is the only stretch of the start-up that still sounds wrong.

---

## Back-burner

Not abandoned. Each was the queue's priority before audible authenticity took
precedence, and each returns to the top when the audio items are struck out.

### 7. V.32bis — multi-rate + rate renegotiation

Needs Figures 2-2..2-5 (12000/9600/7200/4800) by the same route, then the
fallback constellations and §8 change-rate-without-retrain. The rate signal
already advertises the full set and negotiates the max; only 14400 is wired for
data.

Do one rate at a time and assert each constellation's own rotational invariant —
same shape as 14400's, different bit positions, since the lower rates carry fewer
uncoded bits.

Note the interaction with item 1: both touch `V32bis.js`'s start-up. Doing item 1
first means the fallback rates are wired against the Recommendation's segment
machine rather than against the AA train, which is the cheaper order.

### 8. V.90 — the real-line receive gap  *(high effort)*

What items 1–6 deliberately do not address, because all of it is receive-side
and none of it is audible. Full analysis in PROTOCOLS.md, V.90's "For real-modem
interop". What is missing:

- Receivers that *measure* rather than detect: line probing analysis, ranging,
  and digital impairment learning from the DIL the digital modem now transmits.
- Robbed-bit signalling and digital-pad detection. The data frame is six symbols
  and each interval may carry its own constellation *for this reason* — the
  structure exists and is unused, so the mapper needs no change, only the
  detection and per-interval mask selection. CP already carries six constellation
  indices.
- A-law codebook. CP bit 35 already selects the codec and is parsed.
- Honour Table 15 power limits (on a real US line the FCC limit capped this at
  53 333, D = 40).

---

## Done

One line each; the durable description of each lives in PROTOCOLS.md.

- **The off-hook gap plays.** `generateAudio`'s `V8_NEGOTIATE` branch scanned the
  drained block for a non-zero sample and discarded it when it found none, which
  queued silence never contains — so `answerToneDelayMs` was dead at any value
  and ANSam began at t = 0. It now asks whether the QUEUE is empty, and hands a
  part-drained block's remainder to the sequencer so ANSam starts on the sample
  the silence ends. Measured 0.00 s → 1.00 s.
- **V.90's V.8 carries the two required categories.** §9.1.1 needs a V.90
  availability bit and a PSTN access type alongside modn0 b5; V.8 §6.3 needs the
  V.34 bit as well. All three now go out, conditioned in JM per §7.4 rather than
  intersected — the two ends declare different halves of the pair, so
  intersecting would empty the category exactly when it matters. `V8_TAG_PCM_AVAIL`
  was wrong (`0 0 1 1`) and had never been on a wire in either repository.
- **V.90 downstream Phase 3.** TRN1d, Jd, J′d and DIL, in §9.3.1's order —
  which is Sd first, then TRN1d, not the order Figure 5's labels suggest.
  `V90Phase3.js` holds Tables 12 and 13; `v90-phase3-check` asserts both at
  literal positions, Table 12 at three pattern lengths because α and β move every
  field after SP and TP. U_INFO is explicit at 111 and Sd's W derived from it.
  Connect 3.2 s → 6.6 s.
- **Phase ordering.** Sd is gated on Ja rather than on CP, which is the
  Recommendation's phase order and exposed a real coupling: `coder.reset()` ran
  at the Sd transition and the coder does not exist until CP builds it. MP and
  the coder moved to where data begins. The analogue receiver counts through
  Phase 3 rather than inferring, and must — DIL probes the low Uchords, whose
  magnitudes sit inside `SD_ZERO_TOL`, so the Sd discriminator is consulted only
  to find where Sd ends.
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
  half-duplex ping-pong with its own audible connect script and was parked. It is
  not offered in the menu and is not worked on further.
- **V.8bis.** No protocol here needs it.
- **Viterbi decoders.** On a lossless link the coding gain is unused; only
  worthwhile as part of a real backport. No longer *blocked* for V.32bis at
  14400 — the Recommendation's set partition is now on the wire, so a decoder
  would have the map its parallel-transition structure needs. V.34 stays gated on
  the same decoder work, not on the map — its constellation is now the
  Recommendation's.
