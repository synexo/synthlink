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

**"The figure would not transcribe" is a claim to retest, not a finding.**
Figure 14/V.34 was recorded here for three cycles as having refused retrieval, and
the CRC's register orientation was left unverified on that basis. It transcribes by
the ordinary route: the stage labels are positioned text at `pf21` and the block
boundaries are legible in the page image. The register was upside down the whole
time. Before believing a "does not transcribe" note in this file, try it.

**A scanned Recommendation has no text layer at all.** V.32 (1988) is a page-image
scan: its tables OCR into the layer but its FIGURES carry no positioned text, so
the label route does not exist and the page image is the only source. Extract the
page's `<img>` data URI, crop, and read it — Figure 1/V.32 is legible that way, and
its labels then cross-check cell for cell against Table 3/V.32.

| Figure / clause | Source | Div | Printed p. |
|---|---|---|---|
| **Figure 1/V.32 — 16-point map; A B C D circled** | V.32 | `pf5` (image) | 3 |
| **Table 1/V.32 — differential quadrant coding** | V.32 | `pf5` | 3 |
| **Table 3/V.32 — the two 9600 mappings** | V.32 | `pf7` | 5 |
| **§5.2 S / S̄ / TRN; §5.3 rate signal; Tables 5–7** | V.32 | `pfa`, `pfd`, `pfe` | 8, 11, 12 |
| **§5.4 start-up procedure, both modems** | V.32 | `pfe`–`pf10` | 12–14 |
| **Figure 2-5/V.32bis — 4800 map; Table 2/V.32bis** | V.32bis | `pf9` (image) | 7 |
| **§5.2–§5.3 + Tables 4–6/V.32bis; §6 procedure** | V.32bis | `pfc`–`pf12` | 10–16 |
| **§10.1.2.1–.3 tones A/B, INFO modulation** | V.34 | `pf20` | 26 |
| **Tables 14/15/16 — INFO0, INFO1c, INFO1a** | V.34 | `pf22`–`pf24` | 28–30 |
| **§11.2 Phase 2 procedure; Figure 16** | V.34 | `pf2f`–`pf31` | 41–43 |
| **§11.2.2 recovery bounds, both modems** | V.34 | `pf31`–`pf32` | 43–44 |
| 2-1/V.32bis — 14400 constellation | V.32bis | `pf6` | 4 |
| 2-2/V.32bis — 12000 | V.32bis | `pf7` | 5 |
| 2-3..2-5/V.32bis — 9600/7200/4800 | V.32bis | `pf8`+ | 7–8 |
| 5/V.34 — superconstellation quarter (done) | V.34 | `pf14` | 14 |
| §10.1.2.4 L1/L2; Table 17 — probing tones | V.34 | `pf25` | 31 |
| **§10.1.3.1–.5 B1, E, J, J′, MD; Tables 18/19** | V.34 | `pf26` | 32 |
| **§10.1.3.6–.9 PP, S, TRN, MP** | V.34 | `pf27` | 33 |
| Figure 19/V.34 — Phase 3 timeline; §11.3.1 | V.34 | `pf33` | 45 |
| §11.3.1.2.3–.2.6, §11.3.2 recovery | V.34 | `pf34` | 46 |
| §8.3.1 Ja; Table 11 — INFO1a when V.34 selected | V.90 | `pf19` | 17 |
| **§8.3.2–.6 MD, PP, S, SCR, TRN (all defer to V.34)** | V.90 | `pf1c` | 20 |
| §9.3.1.5–.6, §9.3.2 analogue modem procedure | V.90 | `pf2a` | 34 |
| ~~14/V.34 — CRC register~~ (done) | V.34 | `pf21` (image + labels) | 27 |
| §8.2 Phase 2 signals; INFO DPSK modulation | V.90 | `pf14` | 12 |
| Table 10 — INFO1a; §8.2.4 line probing | V.90 | `pf18` | 16 |
| §8.3.1 Ja; Table 12 — DIL descriptor | V.90 | `pf19`–`pf1b` | 17–19 |
| §8.4.1 DIL construction | V.90 | `pf1c` | 20 |
| Table 13 — Jd; §8.4.3 J′d; §8.4.4 Sd | V.90 | `pf1d` | 21 |
| §8.4.5 TRN1d; §8.5 Phase 4 analogue | V.90 | `pf1e` | 22 |
| §8.6 Phase 4 digital; Table 17 | V.90 | `pf21`–`pf24` | 25–28 |
| §9.1.1 Use of bits in V.8 | V.90 | `pf24` | 28 |
| **Figure 4 — Phase 2 timeline, all durations** | V.90 | `pf26` | 30 |
| ~~§9.2 Phase 2 procedures, both modems~~ (done) | V.90 | `pf26`–`pf28` | 30–32 |
| **§8.5 / §8.6 Phase 4 signals; Tables 14–17** | V.90 | `pf1e`–`pf24` | 22–28 |
| **§9.4 Phase 4 procedure, both modems** | V.90 | `pf2b`–`pf2c` | 35–36 |
| **§10.1.3.2 E; §10.1.3.9 MP modulation** | V.34 | `pf29`, `pf2a` | 33–34 |
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
   coding — a shuffled map passes a bijection check but fails those. For PP it is
   the 48-periodicity §10.1.3.6 claims but equation (10-1) has to SATISFY, which
   is what catches a dropped `k mod 3 = 1` branch.
5. **"The subset used for training" is not the outer corners.** Figure 1/V.32
   circles A B C D at Y1Y2Q3Q4 = 0001, 0101, 1101, 1001 — so Q3Q4 = 01 and the four
   points are (−3,−1), (1,−3), (3,1), (−1,3), not (±3,±3). Three things pin it and
   all three are needed: Table 3's own coordinates for those labels, Table 1's
   signal-state column for the quadrant, and the mean energy, which is 10 — the mean
   energy of the whole 16-point constellation, so the conditioning signal is already
   at the data burst's power where the corners would be 2.5 dB over it. A rotation-
   closure check does NOT pin it: three of the four candidate Q3Q4 sets are closed.
6. **A prose clause can carry a receiver requirement that reads like a
   transmitter one.** §10.1.3.7's "S̄ shall begin with the transmission of point 0
   rotated by 180 degrees" looks like a formatting rule for the transmitter. It is
   the only thing in the Recommendation that lets a RECEIVER tell which of S's two
   points its timing lock landed on — and the two answers differ by a reflection,
   which negates every differential decode. Transcribe the whole clause, including
   the sentences that look redundant.

---

## How this queue is ordered

**Audible authenticity is the priority, and it is the cheap half of interop.**
Sounding right needs only transmitters: each signal emitted with its real bit
content at its real duration, and each end waiting for the peer's before
advancing. Every measurement those signals feed is a no-op on this transport, so
receivers stay presence-and-end detectors — `V90.js`'s `_huntSd` already is
exactly that. Build each signal so that later interop work *adds* a measuring
receiver behind a real transmitter, rather than replacing an invented one.
Nothing in this queue should have to be undone to reach real-hardware interop, and
most of it is work that interop would have required anyway. The struck items all
followed this rule — the DIL is transmitted faithfully and measured not at all, so
a measuring receiver is an addition rather than a replacement.

Items are ordered by audible payoff per unit of effort, and by what each one
leaves in place for the next. **Every signal in every start-up here is now the
Recommendation's, on the wire, at its real duration, and the free parameters V.90
hands the analogue modem are filled the way a real modem fills them.** Nothing
audible is left; what remains is a missing rate ladder and a missing receiver.

**Phase 1 is already genuine, and single-protocol dialling is authentic.** A dial
sets `protocolPreference` and `v8ModulationModes` to the selected protocol and
runs the full V.8 exchange advertising exactly that one modulation — which is a
real modem that supports one modulation, dialling. It is not `forceProtocol`'s
V.8 bypass, which nothing in the shipping path sets. The V.8 implementation is a
faithful spandsp port, hardware-validated in synthmodem, and is not in question
here — note that the two category octets a V.90 dial now also sends had never
been on a wire in either repository, so they are the one part of V.8 here that
hardware has not seen. One row of the advertisement is
worth knowing: V.32/V.32bis and V.22/V.22bis each share one V.8 bit, which is
V.8's own design, disambiguated locally from `protocolPreference`. **Bell 103 no
longer runs V.8 at all** — Table 2/V.8 has no bit for it, so the exchange could
only ever no-deal and fall back, and a 1962 Bell modem had no V.8 to run.

**Where a shorter start-up is wanted, take it from the knobs the Recommendations
provide rather than by omission.** V.90 leaves DIL length to the analogue modem
(§8.4.1; N = 0 means DIL is not transmitted, and Figure 6 defines that case),
MD length to INFO1a bits 18:24, and states TRN, TRN1d, DIL and L2 as bounds
rather than values. Choosing a short legal value is authentic; dropping a
required signal is not. **Settled for DIL:** N = 32 segments of 768 symbols is
3.07 s in one pass, inside Figure 5's ≤5 s, which puts a V.90 connect at 6.4 s
against a real modem's 15–25 s. Recognisably a 56k handshake without the full
wait. One constant in `V90.js` moves it either way.

### Measured baseline

`node tools/connect-timing.js` is the instrument: two `ModemDSP`s wired
audio↔audio, RMS per direction in 100 ms bins, ANSam onset to the later of the
two `connected` events, counted in samples rather than wall clock. `GAPS=1` adds
the runs of near-silence per direction and `BINS=1` an amplitude trace. Re-measure
after each item; this is how you tell whether the audio actually moved.

| Protocol | Before this cycle | Now | Recommendation's minimum |
|---|---|---|---|
| V.21 | 3.0 s | 3.0 s | — |
| V.23 | 3.0 s | 3.0 s | — |
| V.22bis | 3.6 s | 3.6 s | — |
| V.22 | 4.6 s | 4.5 s | — |
| V.32 | 4.2 s | 4.2 s | not yet derived |
| V.32bis | 4.2 s | 4.2 s | not yet derived |
| V.34 | 4.0 s | **4.14 s** | not yet derived |
| V.90 | 7.8 s | **8.12 s** | not yet derived |

Both moved UP by the Phase 4 signalling now on the wire: V.34's TRN, MP, MP′ and E
where a byte frame used to be, V.90's Ri, R̄i, TRN2d, MP, MP′ and Ed likewise. The
other six are untouched by this cycle.

**There is no "real hardware" column and one must not be added back.** An earlier
edition of this table carried one marked "recollection, not transcription". It had
no provenance, and it was quoted as a baseline anyway — which is what an unsourced
number in a table gets used for whatever the label says. The comparison that means
something is against the Recommendation's own minimum, derived term by term from
the clauses, with a note on which knob accounts for the difference. Those cells say
"not yet derived" because they have not been; leave them saying that until they are,
rather than filling them with a figure from memory.

**One sourced hardware figure exists and is a measurement, not a recollection.**
`tools/datasource/Conexant-HCF-smooth-crescendo.wav` is a real V.90 call, both
directions, one per channel. ANSam onset to data mode is **15.2 s** against our
8.12 s, and every phase is shorter here by 1.3–3.5x — none of it by omission. It
is a single call between one pair of modems, so it is a data point and not a
target; where it is quoted below the clause is quoted with it.

The off-hook gap is excluded from every figure and is a real 1.00 s. Bell 103's
7.1 s is the V.8 no-deal fallback, which is what real hardware does and is not a
defect. V.29 is not in the menu and is not worked on.

**What the knobs are, for when those cells get filled.** V.32/V.32bis: §5.2.3 lets
TRN run 1280T to 8192T — 0.53 s to 3.41 s per conditioning signal, and the
procedure carries three of them — and Note 4 to §5.4 says 650 ms is needed to train
a G.165 network echo canceller, which is the component this transport removes.
V.34: §10.1.2.4 bounds L2 at 550 ms with no floor, and §11.3.1.1.6 caps only the
MD-to-TRN-end total. V.90: DIL's N is the analogue modem's choice (§8.4.1), here 32
segments of 768 symbols. Every one of those is a legal short value, not an omission.

**V.32 and V.32bis no longer land within 0.1 s of each other by accident.** They
still land close, but now because their start-ups are structurally the same signal
— §5.2 is word for word identical in the two Recommendations — rather than because
neither protocol's own complexity was reaching the wire.

---

## The queue

Every audible-authenticity item is struck. Items 1 and 2 were the queue's priority
before those took precedence and they are the queue again; item 3 is new and is a
different kind of item — it is the first one whose payoff is INTEROP rather than
sound, and it is here because it turns out to be mostly independent of the 2-wire
work everyone assumes has to come first.

### 1. V.32bis — multi-rate + rate renegotiation

Needs Figures 2-2..2-5 (12000/9600/7200/4800) by the same route, then the
fallback constellations and §8 change-rate-without-retrain. The rate signal
already advertises the full set and negotiates the max; only 14400 is wired for
data.

Do one rate at a time and assert each constellation's own rotational invariant —
same shape as 14400's, different bit positions, since the lower rates carry fewer
uncoded bits.

Its carrier is already built: the rate signals are on the wire as §5.3's own 16-bit
sequences, Table 5/V.32bis's bit positions and all, so this item is the fallback
CONSTELLATIONS plus §8's change-rate-without-retrain and not the negotiation.
`V32Startup.js`'s `makeRateCodec` already advertises and decodes every rate in the
table; `V32bis.js`'s `RATE_SET` is what restricts it to one.

### 2. V.90 — the real-line receive gap  *(high effort)*

What every struck item deliberately does not address, because all of it is
MEASUREMENT.
The Phase 3 receivers that now exist detect and demodulate; none of them measures
anything, which is the line this item is on the far side of. Full analysis in PROTOCOLS.md, V.90's "For real-modem
interop". What is missing:

- Receivers that *measure* rather than detect: line probing analysis, ranging,
  and digital impairment learning from the DIL the digital modem now transmits.
  The DIL REFc choice below is a real design question here and only here.
- Robbed-bit signalling and digital-pad detection. The data frame is six symbols
  and each interval may carry its own constellation *for this reason* — the
  structure exists and is unused, so the mapper needs no change, only the
  detection and per-interval mask selection. CP already carries six constellation
  indices.
- A-law codebook. CP bit 35 already selects the codec and is parsed.
- Honour Table 15 power limits (on a real US line the FCC limit capped this at
  53 333, D = 40).

### 3. V.32 — the two gaps that are NOT about the line

The four components V.32 is missing get named together — adaptive equalizer,
continuous timing recovery, echo canceller, Viterbi — and that grouping is
misleading. Sort them by what removes the need for them and they fall into three
categories, only one of which is about channel quality:

| | | On a perfect line |
|---|---|---|
| **A** | Echo canceller, Viterbi, adaptive equalizer | **gone** — genuine no-ops |
| **B** | Symbol timing recovery, carrier recovery, AGC | **still needed** |
| **C** | §5.4's AA/CC and AC/CA segments, the 600/1800/3000 Hz detections, NT/MT | **still needed** |

**This item is B and C. It is not blocked on 2-wire and should not wait for it.**

**Why A really is a no-op here, so that nobody implements it blind.** On a flat,
lossless, drift-free channel the optimal equalizer IS a delta and the LMS update is
zero, so it never moves; the echo canceller's reference has no correlation with a
received signal containing none of it, so its taps converge to zero; and a Viterbi
decoder returns bit-identical decisions to a hard slicer when there is no noise. All
three would be written, would interoperate perfectly, and would be *unproven* — a
worse trap than a wrong constant, because the green result comes from an independent
peer. That is the same failure this file already documents one level down: a round
trip cannot see a wrong constant, and a clean channel cannot see a broken equalizer.
Do not build A against a clean link.

**B is needed because the peer is a separate device, not because the line is bad.**
A real modem has its own crystal. §5.2 gives 2400 baud ±0.01%, so ±100 ppm against
ours regardless of how clean the path is; our receiver acquires timing once and
free-runs, and at 100 ppm a full symbol period of slip accumulates in ~10 000
symbols — about four seconds. Carrier is the same story: the far modem's carrier
comes off its own reference, and differential coding absorbs a STATIC phase offset,
not an accumulating one. The zero-drift shared clock in PROTOCOLS.md's transport
assumptions is an artifact of both ends running in one process and evaporates the moment the peer is
physical.

**The reference implementation is already in the tree, which is what makes B
tractable.** `V22Demodulator.js` is a port of spandsp's `v22bis_rx.c` and carries
exactly these three loops: carrier tracking, a complex T/2 LMS equalizer at 17 taps
with `EQUALIZER_DELTA = 0.25`, Gardner symbol timing, and AGC. It is hardware-proven
— it is *why* V.22bis interworks. `Primitives.js` additionally holds standalone
`AGC`, `CostasLoop`, `GardnerTiming` and `LMSEqualizer`. This is adaptation, not
invention. It is not a free port either: V.22bis is 600 baud on split-band carriers,
V.32 is 2400 baud with 1800 Hz in both directions and a different training
sequence, so the loop structures transfer and the constants and integration do not.
Note `V22.js`'s own header still claims the RX side is simple and that these loops
are a future pass — that text predates the port and is wrong; fix it while you are
there.

**C is the thing that would actually block a call.** §5.4's start-up is a procedure
both modems step through, and AA/CC, AC/CA, the tone detections and the NT/MT
periods are part of its grammar. Their PURPOSE is training an echo canceller and
measuring a round trip, but their PRESENCE is what the peer's state machine waits
for — so a real V.32 modem does not fail at data, it never finishes the handshake.
Emitting them correctly needs no canceller at all: it is signals at real durations
with each end gated on the peer's, which is the pattern every struck item in this
file already followed.

One degeneracy to expect rather than discover: NT/MT measure round-trip delay, and
on a zero-delay 4-wire link that measurement is ~0. Perform the exchange anyway —
V.34's Phase 2 round-trip sits in exactly the same position — and know that its
correctness only becomes checkable once there is delay in the path. A delay line is
the cheapest impairment there is.

**Decide before starting, do not assume.** V.32 defines 9600 both as non-redundant
16-point and as 32-point trellis-coded, and we implement only the former. Whether
real hardware will accept non-redundant 9600, or effectively insists on TCM because
it is ~4 dB better, is a one-clause check in §5/V.32 — and the answer moves Viterbi
out of category A and into a prerequisite. Check it first; it changes the shape of
this item.

**What B + C buys.** V.32 to real hardware over a path with no echo — a digital leg
converted to analogue at the far end, say. That is a real interop claim, it is
demonstrable, and it is the natural stopping point before any canceller exists.

### 4. Then 2-wire, and what it unlocks

2WIRE.md is the design and its key insight is that echo is your own transmit
returning, so every endpoint can synthesise its own 2-wire experience locally with
no transport change. Build it AFTER item 3, because a canceller cannot be developed
on a receiver that loses lock in four seconds from clock drift, and an equalizer
cannot be evaluated on a channel with nothing to equalise.

What it turns on, in order:

- **The echo canceller becomes real work rather than dead code.** On an actual
  2-wire loop the far modem's AC/CA arrives *while your own transmit comes back at
  you*, which is the condition category C's segments exist for. This is the single
  hardest component in modem design and it is reusable across V.32, V.32bis and
  V.34.
- **The adaptive equalizer becomes measurable.** Amplitude tilt and group-delay
  distortion give it something to converge to; the criterion is residual ISI in dB
  and convergence time, not pass/fail.
- **Viterbi becomes worth its complexity, and provably so.** Trellis coding
  EXPANDS the constellation, so at a given rate the minimum distance is smaller
  than uncoded — without the decoder, TCM is worse than no TCM. With additive noise
  in the path the criterion is concrete: ~3-4 dB of coding gain at the same BER.
  This is the only way to prove the decoder is doing anything.
- **NT/MT stop being degenerate**, per item 3.
- **The clean-link relaxations get their reckoning.** `skipCdVerification`,
  `v22MagOnlyDetect` and the widened `cdStableMs`/`listenWindowMs` are the three
  settings PROTOCOLS.md's transport assumptions call invalid against a real line. An impaired
  channel is where they come off and the carrier-detect gate has to actually latch
  — the known-fragile part, because the gate measures stability in wall-clock time
  while carrier detect only advances when RX audio is processed.

The impairments belong in the TEST RIG, not in a shipping mode: a channel model
between the two ends costs far less than a user-facing 2-wire feature with config
and UI, and it is the half of 2WIRE.md that carries the value.

---

## Done

One line each; the durable description of each lives in PROTOCOLS.md.

- **DIL's level character, and U_INFO with it.** The last free parameter a
  listener would have called wrong, and never a divergence: §8.4.1 states no
  ordering and no power constraint. Two of the three were badly chosen. `REFc` was
  the midpoint of the chord being trained, so a reference that should anchor a
  segment tracked it instead and a chord-1 segment held no symbol above Ucode 14;
  it is one chord-independent Ucode 120 now, which leaves 3.6 dB of headroom and
  can never collide with a training Ucode (≡ 8 vs ≡ 2, 6, 10, 14 mod 16). The 32
  segments were asked for in ascending chord order, which is ascending LEVEL order;
  they interleave now. Measured on the wire, the sequence went from −55.8 → −0.9
  dBFS strictly ascending to a flat bed: **58.1 dB spread → 4.2 dB, longest rising
  run 32 of 32 → 2.** Then the second half, which the level work exposed: flat is
  not enough if the probe is a TONE. `L_SP` and `L_TP` were 11 and 7, so the pair
  repeated together every 77 symbols — ten times inside every 768-symbol segment —
  and the signal measured ten times more tonal than a real modem's Phase 3
  (spectral flatness 0.037 against the reference capture's 0.369). They are now
  maximal-length sequences of 127 and 125 bits from two different primitive degree-7
  polynomials: coprime with the six-symbol data frame as before, and now coprime
  with **each other**, so the pair does not repeat inside a segment at all.
  **Flatness 0.037 → 0.549.** Equal periods are the trap — 127 and 127 from
  different polynomials still gives 0.28, because they repeat together regardless
  of content. Comparing raw flatness across a synthetic signal and a recording is
  the wrong comparison; calibrated against each side's own data mode, the reference
  runs DIL/data = 1.13 and so do we. U_INFO stays at 111 and the reasoning inverted
  once the DIL was flat: §8.4.4 fixes the ~4.3 dB Sd-to-TRN1d step, so U_INFO moves
  the pair together and cannot close it, and 111 is the only value in the range that
  leaves both inside the DIL's band. Ja grew 512 → 750 bits, so a V.90 connect is
  8.12 → 8.34 s. `v90-dil-level-check` asserts the character structurally — stated
  bounds, not recomputations of the constants — and was mutation-tested six ways.

- **CP and MP onto real Phase 4 signalling, and the DLE control channel is gone.**
  The last stretch of any start-up here whose CONTENT was the Recommendation's and
  whose carriage was not. V.34's MP now rides §10.1.3.9's 4-point form — the chain
  J already rides, which is why the receiver came free: the Phase 3 differential
  decode inverts it and frame sync plus CRC finds it, exactly as it finds Ja. The
  tail gained §11.4's order, `p4-trn` → `p4-mp` → `p4-mpprime` → `p4-e`, with
  §11.4.1.1.1's TRN before MP because §10.1.3.9 initialises MP's differential
  encoder from that TRN's final symbol. V.90's §9.4.1 is Ri (≥192T) → R̄i (24T) →
  TRN2d (≥2040T) → MP until CP → MP′ until CP′ → a single Ed → B1d; §9.4.2 is CPt
  until the R-to-R̄i transition → CP until the peer's MP → CP′ until MP′ or Ed →
  §8.5.3's E. Both ends are gated on the far end's SIGNALS now, not on repetition
  counts. **Three things were transcribed wrong from the in-repo notes and corrected
  against the Recommendation itself.** §8.6.3 transmits MP "using the constellation
  parameters used to send TRN2d" and §8.6.5 puts TRN2d through §5.4's encoder on the
  set CPt passes — not, as first built, a sign on the U_INFO codeword — so both ends
  build a TRAINING encoder from CPt and the analogue modem demodulates MP on
  training parameters before it knows anything about data mode, which is the new
  receive path this item always said was its risk. Table 16's fill is to the next
  whole DATA FRAME, so `mpLength` takes the training constellation's D. And
  §9.4.1.4/§9.4.2.4 gate on the peer's sequences where a count had stood in.
  Two things learned in the wiring: a sequence sent ONCE is eaten, because the
  receiver's descrambler spends 23 bits settling after any signal that is not
  differentially encoded — which is why §10.1.3.3 makes J "a whole number of
  repetitions" and why the floor here is two; and CPt passes **lₐ = 0** (Table 14
  bits 49:50, the analogue modem's choice, and §9.4.2.1 lets it differ from CP's)
  because the shaper's lookahead is a pipeline delay that otherwise leaves the last
  frames of Ed inside the encoder, and Ed is what ends Phase 4. `DLE 'D'` survives
  on the V.34 carrier alone, as the data-mode mark: §11.4 ends B1 on a frame count
  that a burst re-acquired after a silence cannot keep. Downstream it is genuinely
  retired — data begins after Ed and B1d's 48 frames of marks arm the UART.
  V.34 4.0 → 4.14 s, V.90 7.8 → 8.12 s.

- **§11.2.2's recovery ACTIONS, and the connect that failed one time in ten.**
  The bounds were already the Recommendation's; what was missing was what to DO
  when one fired. Steps now carry `recover` (a bound expiring) and `interrupt` (a
  signal arriving), with recovery-only steps at the end of each list reached by a
  `goto`. §11.2.2.1.1, .1.3, .1.4, .1.6 and §11.2.2.2.1, .2.2, .2.3, .2.4 all have
  their actions, INFOMARKS included, so the call modem's §11.2.2.1.6 and the answer
  modem's §11.2.2.2.4 close the loop without the §11.5 retrain this build does not
  have. Bit 28 is read off the receiver instead of being fixed at 0, which is what
  ends a repetition. **The trigger was a lost INFO0a**: the call modem's unbounded
  Tone B wait (§11.2.2.1.2) sat there while the answer modem expired three of its
  own bounds. Three defects surfaced in the wiring — INFO's own 180° modulation was
  being counted as tone reversals (fixed with a flip-density gate: one flip in
  sixteen points is a reversal, three is a carrier carrying INFO); the L2 reception
  allowance was the clause's 500 ms MAXIMUM, which put the answering tone on the
  line after the peer's §11.2.2.2.3 bound had already fired; and a sticky repeat
  counter made a modem ping-pong in and out of the recovery until the cap stopped
  it. `v34-phase2-recovery` is the harness, and it has to run each call in a COLD
  CHILD PROCESS under a real-time pump — twelve calls in one process are twelve
  clean connects, because by the second one V8 has optimised the receiver.

- **V.90 Phase 2 (§9.2) is real, and it is §11.2's machine.** §9.2 is §11.2 clause
  for clause with the two modems renamed — every duration, every recovery bound —
  and §8.2 defines every signal by reference to §10.1.2/V.34, so the step list runs
  both procedures and `V90Phase2.js` holds only what is V.90's: Tables 7 and 10.
  Tables 8 and 9 ARE Table 14/V.34 and Table 15/V.34, which the Recommendation
  states and the check verifies rather than assumes. **The role split is the
  mirror of V.34's** and is the trap: the DIGITAL modem plays the part §11.2 gives
  the call modem (tone B, INFO0d) and the ANALOGUE modem — the originate side —
  plays the answer modem's. Steps, carriers and the peer's tone are keyed on the
  PART now, not on `role`. Retires U_INFO, the upstream symbol rate and MD's length
  as locally-chosen constants: the check runs a full §9.2 with a non-default U_INFO
  and reads §8.4.4's W back out of the peer, which is the only thing that can tell
  a negotiated value from a shared one. Connect 6.4 → 7.8 s.

- **The CRC register was upside down, and Figure 14 transcribes after all.**
  Sixteen stages labelled 15 down to 0 left to right in blocks of five, seven and
  four, with the third adder at the right-hand end where "Information Bits In"
  arrives — so the information bit is summed with the bit leaving stage 0 and the
  feedback enters stages 15, 10 and 3. That is `0x8408`, the bit reversal of
  `0x1021`: the LSB-first register, where `BitFrame.crc16` had the MSB-first one.
  Every INFO, MP and CP sequence is generated and checked by the same function at
  both ends, so both orientations round-trip perfectly and nothing here could ever
  have failed on it — the fifth instance of that failure, and the first where a
  FIGURE was the only witness. Jd and the DIL descriptor ride this generator on the
  wire, so it was a failed CRC in a real receiver rather than a latent one.
  `v34-phase2-check` now simulates the figure cell by cell and keeps the old
  orientation as a negative control, so the section can fail.

- **V.34's L2 reception allowance was the clause's maximum and that was wrong.**
  §11.2.1.1.5 and §11.2.1.2.8 bound the reception of L2 at "not to exceed 500 ms"
  with no floor. At the full 500 the tone that ends the peer's L2 leaves at 660 ms
  and arrives after §11.2.2.2.3's 600 ms recovery bound has fired — about one run
  in twenty, presenting as the peer restarting §11.2.1.2.3 for no visible reason.
  200 ms is the legal short value taken instead. V.34 connect 4.6 → 4.0 s.

- **V.34's symbol rate and carrier are the Recommendation's rationals, and 3429
  had been out of tolerance.** §5.2 is `S = (a/c) x 2400 +/- 0.01%` and says Table 1
  prints its rates "rounded to the nearest integer"; 3429 is a/c = 10/7, so S is
  24000/7 = 3428.5714 and the shipped 3429 was **+125 ppm against a 100 ppm
  tolerance**. §5.3 is `(d/e) x S`, d/e = 4/7, so the carrier is 96000/49 =
  1959.1837 against a shipped 1959. 2400 (1/1) and 3200 (4/3) were already exact,
  so only 33600/3429 moved — the default rate and the only one the menu dials.
  Invisible to every suite because both ends read the same constant, which is the
  same shape as the three constellation failures. `RF` now carries a/c and d/e and
  the printed integer stays only as the table KEY, which is what CONFIGS, Table 7,
  Table 10 and INFO1c's rate ladder are keyed on. Also **INFO0 and INFO1c declared
  the low carrier at 3200 while transmitting the high one** (1920 Hz, d/e = 3/5);
  both now derive the declaration from `RF`. All four are wire content no hardware
  has seen — they belong with the two V.8 category octets in that respect.

- **V.32 / V.32bis start-up, segments 1–4.** §5.2's receiver conditioning signal
  (S 256T, S̄ 16T, TRN ≥1280T) and §5.3's R1/R2/R3 rate signals with the sequence E
  that ends them, on Figure 1/V.32's A B C D states with Table 1's differential
  coding. `V32Startup.js` holds the signals — §5.2 and §5.2.3 are word for word the
  same in both Recommendations, down to the two printed golden vectors — and each
  class holds §5.4's / §6's procedure. `_buildAATrain` and the invented `DLE 'R' hi
  lo` rate frame are both gone, and so is the 72-symbol data preamble: the receiver
  carries S's timing lock and channel estimate through E into data mode without the
  carrier dropping, which is what a real V.32 does. `ORIG_LEAD` deleted — §5.4.1's
  call modem is silent until it detects S and then R1. **A B C D are NOT the outer
  corners**; see the method section. `v32-startup-check` holds the transcription.
  Connect 3.1 → 4.2 s, both.
- **V.32's data path against Table 1 and Table 3.** Found while doing the above and
  fixed as its own change: the differential increment was a plain modulo-4 add of
  the dibit where Table 1 transposes 00 and 01 (12 of 16 rows wrong), and `BASE` had
  Q3 and Q4 the wrong way round against Table 3 (8 of 16 rows). Both round-tripped
  perfectly because the receiver inverted the transmitter — the third instance of
  that failure in this repository after Figure 2-1 and Figure 5. The forward and
  inverse maps are now one stated pair, `dataPoint`/`dataBits`, because the second
  divergence lived in both halves. `v32-map-check` is deliberately not a round-trip
  test; a round trip passes on a shuffled map.
- **V.34 Phase 2 — probing and ranging.** §10.1.2's tones A and B with their 180°
  reversals, the 600 bit/s binary DPSK, Tables 14/15/16 (INFO0, INFO1c, INFO1a) with
  §10.1.2.3.2's CRC, and Table 17's L1/L2. `V34Phase2.js` holds them;
  `v34-phase2-check` asserts every field at its printed bits and reads the probe's
  spectrum back out of the samples, because a correct table synthesised wrongly
  looks identical to a wrong one. §11.2.1's procedure is a step list in `V34.js`
  with §11.2.2's own per-step recovery bounds. Turnarounds measure 40 ms on the
  line (§11.2.1.1.3) and the round trip delay is genuinely measured from the
  reversal timestamps. `MD_SYMBOLS` retired: the length is Tables 15/16 bits 18:24,
  each modem declaring its own (§11.3.1.1.4), and the symbol rate is negotiated
  through Table 16 bits 34:39. V.90's V.34 instance ran `setPhase2Enabled(false)` at
  the time — §9.2/V.90 is a different procedure and was struck separately, below.
  Connect 2.5 → 4.6 s.

- **V.34 Phase 3 segments.** S, S̄, MD, PP, TRN, J and J′ to §10.1.3, in §11.3's
  order, replacing `_buildAATrain`'s 250 ms alternation. `V34Phase3.js` holds
  them; `v34-phase3-check` asserts equation (10-1) both branches, PP's
  48-periodicity, S's end rule, S̄'s begin rule and Tables 18/19 at their literal
  digits. §8.3/V.90 adopts the same segments, so V.90's analogue modem gets them
  through the V.34 class — but with the LEADING role (§9.3.2.1), not V.34's gated
  one. `ORIG_LEAD` deleted: the call modem now waits for the S-to-S̄ transition
  (§11.3.1.1.1). Connect 3.0 → 2.5 s (V.34), 6.6 → 6.1 s (V.90).
- **V.90 upstream Phase 3 — Ja on the wire.** §8.3.1's Ja replaces the DLE byte
  carriage: the descriptor's own bits through 10.1.3.3/V.34's modulation, plus
  §9.3.2.7–.10's S / S̄ / SCR placement. Both constants retired — Jd now repeats
  until the analogue modem's S (§9.3.1.5) and DIL ends on its S-to-S̄ transition
  (§9.3.1.6), counted to the THIRD because §9.3.2 sends three. The analogue modem
  stopped counting through Phase 3 entirely: it detects the Sd-to-S̄d polarity
  flip, hunts Jd's frame sync, detects J′d's twelve zeroes, and finds the end of
  DIL by predicting the probe it asked for. `_phase3Symbols()` and `CTL_JA` gone.
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
- **Viterbi decoders — MOVED to item 4, no longer "not doing".** The reasoning
  that parked them still holds and is now the reason they are sequenced rather
  than dropped: on a lossless link the coding gain is unused and a decoder is
  bit-identical to a hard slicer, so there is nothing to prove it works. Item 4's
  impaired channel is what changes that. Not *blocked* either way for V.32bis at
  14400 — the Recommendation's set partition is on the wire, so a decoder has the
  map its parallel-transition structure needs; V.34 is gated on the decoder work
  and not on the map, its constellation being the Recommendation's.
