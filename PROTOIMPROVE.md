# SynthLink — Real-Modem Interop Queue

**The goal: every protocol SynthLink implements works against real modems.** 4-wire
stays the default transport; every protocol must also work on 2-wire. Shipped code
stays pure JavaScript, so each protocol can be backported to synthmodem's native
backend and ported onward to other languages.

**A work queue, not a reference.** Each item is meant to be done and struck out.
Done items leave this file: what a protocol now IS goes into PROTOCOLS.md, how to
work goes into CLAUDE.md, the story goes into DEVLOG.md. Nothing here should be
history.

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
| §8.2 Phase 2 signals; INFO DPSK modulation | V.90 | `pf14` | 12 |
| Table 10 — INFO1a; §8.2.4 line probing | V.90 | `pf18` | 16 |
| §8.3.1 Ja; Table 12 — DIL descriptor | V.90 | `pf19`–`pf1b` | 17–19 |
| §8.4.1 DIL construction | V.90 | `pf1c` | 20 |
| Table 13 — Jd; §8.4.3 J′d; §8.4.4 Sd | V.90 | `pf1d` | 21 |
| §8.4.5 TRN1d; §8.5 Phase 4 analogue | V.90 | `pf1e` | 22 |
| §8.6 Phase 4 digital; Table 17 | V.90 | `pf21`–`pf24` | 25–28 |
| §9.1.1 Use of bits in V.8 | V.90 | `pf24` | 28 |
| **Figure 4 — Phase 2 timeline, all durations** | V.90 | `pf26` | 30 |
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

## How the goal is reached

**The evidence ladder.** A change is not interop until it climbs this:

1. **BinModem, over the bridge** (`tools/tests/bm-*.js`; CLAUDE.md, PROVENANCE.md §4). An independent Rust softmodem, written
   from the same Recommendations, whose V.34, V.90 analogue modem and V.32bis have
   connected to real modems and ISP servers. Offline, scriptable, every state
   inspectable — the daily loop, and the real far end this project never had.
2. **D-Modem, through synthmodem** (item 6). Tested by hand against a real modem up
   to V.34. Per protocol, once that protocol passes rung 1.
3. **Real hardware, through synthmodem's SIP gateway.** Milestones, not iteration.

A loopback between our own two ends is not on the ladder. It cannot see a
transcription error both ends share, and this repo has shipped several (see the
method section, and the V.34 and V.90 entries in PROTOCOLS.md).

**Rules that still hold.**

- **Build so that interop ADDS, never replaces.** A transmitter that is the
  Recommendation's gets a measuring receiver behind it later; an invented one has to
  be thrown away.
- **Shorten a start-up with the knobs the Recommendations provide, never by
  omission** — and a short legal value must now ALSO survive a real peer. Re-check
  each against the bridge: V.32/V.32bis TRN is 1280T–8192T (§5.2.3; BinModem sends
  4096T when it has an echo canceller to train, per Note 3 to §5.4.2); V.34's L2
  reception allowance is 200 ms of §10.1.2.4's ≤500 ms; V.90's DIL is N = 32
  segments of 768 symbols (§8.4.1 leaves N to the analogue modem).
- **Single-protocol dialling is authentic**: a dial runs the full V.8 exchange
  advertising exactly the selected modulation, which is a real modem with one
  modulation. V.8 has now met BinModem's as both caller and answerer (`bm-v22`,
  `bm-fsk`). Still never read by anything but ours: the PSTN-access and
  V.90-availability category octets a V.90 dial sends — `bm-v90` starts at Phase 2,
  and a V.90 whole call over the bridge is what would exercise them.
- **No unsourced hardware numbers.** `node tools/connect-timing.js` measures our
  connects (ANSam onset to the later `connected`, in samples); compare against the
  Recommendation's minimum derived clause by clause, or against a recording. The one
  sourced figure is `tools/datasource/Conexant-HCF-smooth-crescendo.wav`, a real V.90
  call: 15.2 s ANSam to data mode against our 8.34 s.

### Where each protocol stands

The `bm-*` harnesses hold each row as a floor; raise it as an item lands.

| Protocol | Against BinModem | Next stop |
|---|---|---|
| V.22bis | **Both roles, whole call from V.8: V.8 agrees, both ends reach 2400, text crosses exactly both ways.** `bm-v22` | — |
| V.22 (1200) | **Both roles, from V.8: 1200 each way, text exact both ways.** `bm-v22` | — |
| V.21, Bell 103 | **Both roles, whole calls (V.21 from V.8): text exact both ways.** `bm-fsk` | — |
| V.23 | hardware-validated (answer role) in synthmodem; BinModem has no V.23 | D-Modem, item 6 |
| V.32, V.32bis | **Both roles, with and without V.8: §5.4's opening (AA/CC, AC/CA, NT/MT), V.32 at 9600 and V.32bis at 14 400 trellis-coded, text exact both ways — also with the far clock ±100 ppm off, both roles, our receive exact.** `bm-v32` | V.32bis's lower rates; Viterbi |
| V.34 | **Both roles, all three symbol rates (INFO1 chooses per call), every 3429 rate 19 200–33 600: text crosses exactly both ways, also with the far clock ±100 ppm off at every symbol rate.** Our encoder is bit-identical to its at all 17 ladder rates; our receiver runs Viterbi and tracks timing and carrier. `bm-v34`, `v34-encoder-vector-check`, `v34-viterbi-check`. **Retrain (§11.5) and rate renegotiation (§11.6) both roles, begun by either end or by our receiver on a degraded line** (`bm-v34` [9]/[10], `v34-retrain-check`), falling forward after | 2-wire |
| V.90 | **Two-way through BinModem's µ-law network: it connects `transmit 26400, receive 42666`, the upstream rate our receiver measured it can take with Viterbi, with text exact both ways.** `bm-v90`. **Retrain (§9.5) and rate renegotiation (§9.6) in place, both roles, begun by either end** (`bm-v90` [3]/[4], `v90-retrain-check`, `v90-reneg-check`) | an offset clock: BinModem's analogue receiver falls back at DIL |
| V.29 | not in the menu, not worked on | — |

---

## The queue

In order.

### 1. Receiver loops — the gap that is NOT about the line

The four components V.32 is missing get named together — adaptive equalizer,
continuous timing recovery, echo canceller, Viterbi — and that grouping is
misleading. Sort them by what removes the need for them and they fall into three
categories, only one of which is about channel quality:

| | | On a perfect line |
|---|---|---|
| **A** | Echo canceller, Viterbi, adaptive equalizer | **gone** — genuine no-ops |
| **B** | Symbol timing recovery, carrier recovery, AGC | **done** for V.32, V.32bis and V.34 (±100 ppm against BinModem); V.22bis had it from spandsp |
| **C** | §5.4's AA/CC and AC/CA segments, the 600/1800/3000 Hz detections, NT/MT | **still needed** |

**C is done** — V.32 and V.32bis connect against BinModem in both roles (see the table, and PROTOCOLS.md §5). **This item is B. It is not blocked on 2-wire and should not wait for it.**

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

**What C left to check.** NT and MT are measured — 127/64 T on the zero-delay
loopback, 146/109 T against BinModem — but nothing has seen them on a line with
delay. Run `bm-v32` with `delay` set and see both grow by the round trip. Also, the
turnaround is scheduled on one sample clock for both directions. ModemDSP's
real-time pump lets the two drift ±48 T, so through the server the turnaround
can go out late (recorded in `late`). The far end cannot tell that from a longer
line, but it is not 64 ± 2 as the clause means it.

**Decided: Viterbi is not a prerequisite.** V.32 defines 9600 both as non-redundant
16-point and as 32-point trellis-coded, and we implement only the former. §1 e)/V.32
settles which a real modem must accept: "modems providing the 9600 bit/s data
signalling rate shall be capable of interworking using the 16-state alternative."
TCM stays in item 2.

**References for B.** BinModem's `dsp/src/qam/*` with `shaping.rs`, and its
`docs/design/slow-modes/` and `v32-rebuild/`, which put measured numbers on every
loop. `bmpeer` now reports BinModem's V.32 receiver SNR, offset, drift and slips (`diag`
events), so its view of our signal can be read alongside ours. Done means V.32, V.32bis and
V.34 keep lock against a far end whose clock is off by 100 ppm (a resampler in the
bridge path), and V.90's upstream text arrives — the last two of which are below.

**The bridge is not a clean link in category A's sense.** BinModem's transmitter
shapes its pulses its own way and its network model filters, so an equalizer has a
target that is not a delta even in 4-wire. That is where A stops being unprovable;
A is still built and evaluated in item 2.

**B, as it stands.**

- **Done: the V.34 receive equaliser** (PROTOCOLS.md §7). BinModem → SynthLink
  V.34 data is byte for byte in both roles, and the same receiver, as V.90's
  upstream, now sees §9.3.2.7's S, which took V.90 through DIL and Phase 4 into
  data.
- **Done: the receiver chooses the rate it can receive** (PROTOCOLS.md §7). The
  V.34 rate is per call and per direction, on a ladder derived from §8.2's rules
  and held against the printed Table 10. The receiver measures its equaliser's
  error at a fine step and offers in MP the fastest rate it can slice, so V.90's
  upstream now decodes, at 24 000.
- **Done: the symbol rate per call**, from INFO1 (PROTOCOLS.md §7). All three
  symbol rates run against BinModem in both roles.
- **Done: the 2400 receive loss** — the matched filter's span (PROTOCOLS.md §7).
- **Done: Viterbi** for V.34's 16-state code (PROTOCOLS.md §7), about 3.2 dB.
  V.90's µ-law upstream runs a rung higher (26 400).
- **Done: Viterbi for V.32bis's 8-state code** (PROTOCOLS.md §6), from BinModem's
  `v32/trellis.rs`. Noise at 45 dB, which lost every byte to the slicer, is exact
  both ways, 4-wire and 2-wire (`bm-v32`).
- **Done for V.32 and V.32bis: timing and carrier tracking** (PROTOCOLS.md §5).
  The bridge resamples each direction (`call({ ppm })`). At ±100 ppm, both
  classes in both roles: our receive is exact, and BinModem gets our text whole.
  When BinModem is the call modem it can frame a few junk bytes coming out of its
  own training first. The sweep also caught two of our faults that were not
  tracking: the call modem's reversal test could reset its own precondition
  (V32Preface.js), and one corrupt rate group at the end of a burst could replace
  the agreed rates (`RateFramer`).
- **Done for V.34** (PROTOCOLS.md §7): Mueller–Müller timing and a
  second-order carrier rotator. `bm-v34` [5] holds every symbol rate at its
  ceiling at ±100 ppm, both roles, text exact.
- **V.90 at an offset is blocked on BinModem.** At ±100 ppm its analogue modem
  trains on our Phase 3, reaches DIL, and falls back to Phase 2 rather than enter
  Phase 4: its PCM downstream receiver does not follow the drift. That case is
  half-physical anyway. A real analogue modem must recover the network clock, and
  usually loop-times its upstream to it. Our upstream receiver is V.34's, which
  now tracks.

**To check, not yet a defect.** BinModem's notes read Figures 2-1 and 2-2/V.32bis as
drawing A B C D at (−6,−2), (2,−6), (6,2), (−2,6) — mean energy 40 against the data
constellation's 41 at 14 400 (+0.11 dB) and 42 at 12 000 (+0.21 dB), the only level
statement the Recommendation makes. `V32bis.js`'s `SU_GAIN` scales the states to 41.
Read the figure.

**What B buys, now that C is in.** V.32 to real hardware over a path with no echo — a digital leg
converted to analogue at the far end, say. That is a real interop claim, it is
demonstrable, and it is the natural stopping point before any canceller exists.

### 2. Then 2-wire, and what it unlocks

**Done: the echo canceller, in the rig.** `EchoCanceller.js` (ported from
BinModem's `echo.rs`: a near run, a far run placed by a search, BinModem's
adaptation and keep rules) in V.32, V.32bis and V.34, switched on by
its canceller (on every call). Through the bridge's 2-wire line, echo 10 dB down at 0 to 25 ms,
`bm-v32` and `bm-v34` [7] run both roles with text exact both ways, and with it
off the same line fails. PROTOCOLS.md §0 has the design. What it found or left:

- The line needs levels matched (`bmLevelDb`). BinModem transmits 11–17 dB
  hotter than we do, so on a symmetric line its own echo buried us in its receiver
  and it retrained.
- BinModem's openings have limits of their own on this line. As V.32's call modem
  under its own echo it misses our CA's reversal. With no noise it misses it at
  20 dB of loss, and at 30 dB never hears our AC. Its V.34 has no canceller at all.
  So the harness gives BinModem its echo only where it copes. Its sensitivity is
  set for its own hot levels, not for −40 dBm0.
- Our V.32 opening read noise as AA (fixed: TONE_STAND).
- **Done: in ModemDSP's real-time pump.** `ClockPair.js` pairs each end's two
  sample clocks on every call, and 2-wire mode (`TwoWire.js`) is the line alone,
  each end's echo and loss by that sample count (`twowire-check`, PROTOCOLS.md
  §0). What it does not do is pair a REAL echo path, a gateway's hybrid heard over RTP, whose
  echo is fixed in wall-clock time. That needs the transport's timestamps, and
  belongs to a telephony leg that does not exist yet.
- **Mostly done: split-band under deep echo** (PROTOCOLS.md §3). It was not the
  echo. With no echo at all, V.22 and V.22bis missed a far end 25 dB down (−35
  dBm0): their detectors' floors and the demodulator's carrier gate sat at −37 to
  −38, tuned at the old hot levels, where §4.4/V.22bis has −43. Now each detector's
  floor is what it reads of its own signal at −43, the gate is −43 on and −48 off
  on our scale, and the level detectors average over their 20 ms windows: both
  rates connect with LAPM and V.44 to −41 dBm0 with no echo, and at 25 dB of loss
  under the default echo (13 dB above the far end), which two BinModems do not
  cross (bmbm `echo`). V.22bis holds at 30 dB. **Done: V.22 and V.22bis at 30 dB
  under our own echo**, both roles with LAPM (`bm-v22` [3]); with BinModem's echo on
  too, 28–30 dB is past the reference (two BinModems fail at 25). What broke it was
  V.8's "two identical" JMs disagreeing on LAPM (PROTOCOLS.md §9). **Done: −42
  dBm0, 1 dB inside the floor**, both rates both roles with LAPM against SynthLink
  (`v22-level-check`), where V.22bis had fallen to 1200 and V.22 hung in SB1:
  two detector floors AT −43 and a carrier gate with no §3.2 OFF delay
  (PROTOCOLS.md §3, 4a). BinModem cannot be the far end at that level: its V.8
  signals are 9 dB under its data, so its CM and ANSam reach us under −48.
- **Done: a dispersive line, and an equaliser for V.32 and V.32bis.** The bridge
  has `disperse: { tiltDb, edgeDelayMs }` (`lineFilter`, held to its parameters
  by `bridge-line-check`). V.32 and V.32bis have `SymbolEqualizer.js`, and their S
  test no longer assumes a constant modulus. Both roles are exact through 12 dB of
  tilt and 2 ms of edge delay (`bm-v32`).
- **Done: V.34 on a dispersive line** (PROTOCOLS.md §7). BinModem against itself
  crosses every line in the bridge at 33 600 (`tools/bridge/bmbm.js`), so the line
  was fair and the gap was ours. Its receiver SOLVES the equaliser on PP by least
  squares, and ours now does too, with its hunt and wide search: 4/0.5 through
  12/2 both roles (`bm-v34` [8]).
- **Done: rate on a dispersive line** (PROTOCOLS.md §7). The "33 600 against
  itself" control was 13 dB unfair: `bmbm.js` runs both BinModems at their own
  +3 dBm0. At a modem's −10 dBm0 on both ends, BinModem against itself takes
  28 800, 26 400, 26 400 and 24 000 on 4/0.5 through 12/2. We now take the same,
  both roles (`bm-v34` [8], which now runs at that level with those floors).
  Getting there fixed a ±4 equaliser that was too short for 2 ms of delay (now
  ±6), a Phase 3 S hunt that never caught up once its onset fired early, and the
  call modem's training measure being lost before its MP.
  No transmitter gap either. With no line noise and no filter, BinModem reads our
  transmit at 53 dB, the same as its own, and our receiver measures 55 dB. The
  apparent 31 200-against-33 600 on a "flat" line came from `disperse: {tiltDb: 0}`,
  which still applies the bridge's 150–3800 Hz band. BinModem against itself
  takes 31 200 through that band too. With no filter, both take 33 600 (`bm-v34`
  [8]'s first line).
- **Done: V.34's retrain (§11.5)** (PROTOCOLS.md §7). Either end begins it, ours
  also on its own when its receiver cannot hold the rate, and either answers the
  other's tone. Text crosses after it both ways in both roles, against BinModem
  (`bm-v34` [9], `bm-whole` with V.42) and against ourselves (`v34-retrain-check`).
- **Done: §11.6 rate renegotiation**, either end, both roles, in about 400 ms
  (`bm-v34` [10], `v34-retrain-check`). Ours also renegotiates down on its own
  when its line worsens, retrains only when it is swamped, and falls forward again
  once the line has recovered. Phase 3 and 4's start-up bounds now retrain as
  their clauses say, and so do Phase 2's (§11.2.2.1.5 and the tone-detected
  halves of §11.2.2.1.6 / §11.2.2.2.4), all held by `v34-retrain-check`.
  V.32's §8 is set aside by decision: BinModem has none, so there is no far end
  to hold it against.
- Still open for item 2: V.90's upstream.

**Started: the line model.** The bridge now has BinModem's own test-line
conditions (its `v34/control/tests.rs` `Line`): loss each way (`lossDb`), white
noise at a voice-band level (`noiseDb`, seeded), each end's own transmit back
into its receiver (`line: '2wire'`, `echo`, `echoDelay`; bmpeer's `--echo` for
BinModem's side), and the far clock (`ppm`). `bridge-line-check` holds the model
to its options. The first survey against BinModem:

- 10 dB loss: everything that connects clean connects.
- Noise at 50 dB: V.34 came up at different rates at the two ends, because we
  read one of the peer's two MP maxima. Fixed (`bm-v34` [6]).
- Noise at 40 dB (about −37 dBm0, far worse than a real line): V.34's carrier
  detect never drops, because RX_LO is an absolute mean-|x| of 0.006 and the
  noise's is 0.007. Not fixed. A relative or adaptive floor is the fix if a line
  needs it.
- 2-wire echo 10 dB down: split-band protocols pass, and V.32, V.32bis and V.34
  fail, as expected without a canceller. V.21 with us answering garbles
  BinModem's receive. BinModem transmits 15 dB hotter than we do (−5 against
  −20 dBFS), so in its own receiver its echo is 16 dB above us. That is its level,
  not our bug.
- Levels: since resolved. Every transmitter is now at −10 dBm0 (`LineLevel.js`),
  V.22/V.22bis at −10.9.

2WIRE.md is the design and its key insight is that echo is your own transmit
returning, so every endpoint can synthesise its own 2-wire experience locally with
no transport change. Build it AFTER item 1, because a canceller cannot be developed
on a receiver that loses lock in four seconds from clock drift, and an equalizer
cannot be evaluated on a channel with nothing to equalise.

What it turns on:

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
- **NT/MT stop being degenerate**, per item 1.
- **Done: the clean-link relaxations** (PROTOCOLS.md §0). None is set; circuit
  109 counts received samples, and V.22's anti-AA test is dropped after V.8 only.
  What is left open: V.22 answering WITHOUT V.8 on a 2-wire line still hears its
  own guard tone in the anti-AA test, as a real automode answerer would need to
  filter. Was: `skipCdVerification`,
  `v22MagOnlyDetect` and the widened `cdStableMs`/`listenWindowMs` are the three
  settings PROTOCOLS.md's transport assumptions call invalid against a real line. An impaired
  channel is where they come off and the carrier-detect gate has to actually latch
  — the known-fragile part, because the gate measures stability in wall-clock time
  while carrier detect only advances when RX audio is processed.

The impairments belong in the TEST RIG, not in a shipping mode: a channel model
between the two ends costs far less than a user-facing 2-wire feature with config
and UI, and it is the half of 2WIRE.md that carries the value.

**The rig is the bridge.** Its 2-wire mode is the equation above with BinModem
at the far end — a modem built to expect its own echo, so the far end is not
confused by a line that carries it. Order: equalizer (measured against the bridge's
channel), then the echo canceller, then Viterbi. References: BinModem's
`dsp/src/equalizer.rs` and `qam/train.rs`; `dsp/src/echo.rs` for the canceller — a
near run of taps plus a far run placed by an `EchoFinder` search, and drift
following; `v32/trellis.rs` and `v34/trellis.rs` for the decoders, whose coding gain
needs the bridge's noise to be seen at all.

### 3. V.42 LAPM, V.42bis and V.44  *(done on V.22, V.22bis, V.32, V.32bis, V.34, V.90)*

**Done** (PROTOCOLS.md §13): BinModem's `crates/ec` ported whole to
`vendor/src/ec/` with its unit tests (`ec-check`), run inside the modem by
`ErrorControl.js` over each pump's bit stream, and held against BinModem's own
stack over its pump in both roles (`bm-whole`, `bm-v22`, `bm-v90`, bmpeer `--v42`).
V.21, Bell 103, V.23 and V.29 stay start-stop by decision: they predate V.42.

**Still open:**
- **Done: V.8's LAPM indication.** CM and JM carry Table 6's LAPM octet where
  the call runs V.42, and where both ends said it the stack takes it as declared
  (`declaredLapm()`; detection still runs, as BinModem's does). `v8-check`,
  and `bm-whole` against BinModem's V.8, which bmpeer now has offer LAPM with
  `--v42`.
- **Break (8.13), multi-frame SREJ (8.4.5.2), T402/T403** — BinModem has none either.
- **Done: V.90 under a retrain.** V.32, V.32bis, V.34 and V.90 all suspend V.42
  while retraining (7.10). V.90 retrains on a fresh instance and V.42 is
  re-linked to it (`v90-retrain-check`, `bm-v90` [3]). It found two V.90 faults
  BinModem's CPt had never asked us to show: the shaper's two differential codings
  (§5.4.5.2–.4) missing at both ends, and Ed's last lₐ frames left in the encoder.
- **Done: the connect reports.** `AT+ER=1` / `AT+DR=1` (V.250 6.5.5, 6.5.6) give
  `+ER: LAPM` and `+DR: V44` before CONNECT. Not done: the vendor forms that
  folded them into CONNECT itself (US Robotics' `CONNECT 28800/ARQ/V34/LAPM/V42BIS`). **Tabled by the owner** as a possible later item: which vendor
  styles, how selected, and the default are the owner's to decide.

### 4. V.32/V.32bis — rate renegotiation  *(every rate and mode, and retrain, done)*

**Done:** every rate is wired for data. Figures 2-2, 2-3 and 2-4 were read off the
drawings by position (the method reproduced Figure 2-1 128/128 first), checked for
each figure's lattice and 90° rotation structure at module load, and held point for
point against BinModem's `trellis.rs` (`v32bis-viterbi-check`): they agree. 4800 is
Table 2 on Figure 2-5's four states. `V32bisViterbi` takes the rate's table, and
`setMaxRate()` lowers this end's ceiling. V.32 has its 4800 and its 9600 trellis
mode too (`setTrellis`), on the same pieces. Against BinModem every rate connects in
both roles, clean and on a 2-wire line with noise at 45 dB (`bm-v32`), and our
receive was exact on every line tried, ±100 ppm and 12 dB of tilt included.

**§5.5/§7 retrain: done.** Both classes answer the far end's retrain signal and
start one on unsatisfactory reception, offering then only the rates the error
leaves room for (BinModem's measure, at 0.30 of a spacing rather than its 0.25;
PROTOCOLS.md has why). A retrain that stalls is begun again. `v32-retrain-check`
and `bm-v32` hold it.

**The first rate from the line: done.** R2 and R3 leave out the rates this end's
error on the far end's conditioning signal would be unsatisfactory at, unless that
error is still falling. `bm-v32` holds 44 and 39 dB (noise, below bmLevelDb −13) coming straight up at 12 000
and 7200. It is conservative at the edge: on a 2-wire line at 45 dB the answer
modem now comes up at 12 000, where 14 400 decoded exactly (its error is 0.88 of
14 400's threshold).

**Still open:**
- **§8, change of rate without a retrain.** Not implemented, either end.
- **V.32's trellis 9600 is judged too harshly.** Both the first-rate choice and
  the retrain measure judge it on its own 32 points, √2 closer than the uncoded
  grid's. So it gives up 9600 before the non-redundant mode does, although its
  8-state code reads more: at 37 dB it read text exactly where the other garbled.
  The measure that would fix it is distance from the Viterbi path's guess, not
  from the nearest point. That reads high on V.32bis at 45 dB, though, so it
  needs its own calibration.
- **BinModem's call modem frames junk at its E-to-data change** at the lower rates
  (one 0xFF against us at 7200, several bytes against itself at every rate:
  `MAX_RATE=7200 PROTO=v32bis SECS=16 node tools/bridge/bmbm.js`). Its receiver,
  not our transmitter; noted so it is not chased here again.

### 4a. Line level and reach  *(done)*

Every receive gate is now relative or at the Recommendations' carrier-detect
floors (PROTOCOLS.md §1), and `bm-whole` holds them at a real line's levels. What
was transmit level, and that is done too: every transmitter is at −10 dBm0, held
once in `LineLevel.js` (PROTOCOLS.md §1). V.32/V.32bis came down from −7.6, over
the usual ceiling; V.34 came up from −13.8, which buys it that much reach toward
a far end whose receiver, like BinModem's, gives out near −31 dBm0.

### 5. V.90 — the real-line receive gap  *(done for a SIP-delivered call)*

**Done:** the analogue modem measures the route from its DIL and chooses each
interval's constellation from it, inside the far end's Table 15 power, and slices
against what it measured: a robbed bit, a digital pad and A-law, alone and
together, against BinModem's digital modem (`bm-v90` [5]) and SynthLink's
(`v90-route-check`); the digital modem sends A-law when its network is (`bm-v90`
[6]). PROTOCOLS.md §8 has it. **Open:** a jitter buffer's slips and dropouts, which
belong with the telephony leg, and a codec waveform at our end (no SIP-delivered
call has one). The original list follows.

All of it is MEASUREMENT. The Phase 3 receivers that exist detect and demodulate;
none of them measures anything. Full analysis in PROTOCOLS.md, V.90's "For
real-modem interop". What is missing:

- Receivers that *measure* rather than detect: line probing analysis, ranging,
  and digital impairment learning from the DIL the digital modem now transmits.
  The DIL's REFc (Ucode 120, under "To fold" below) is a real design question
  here and only here.
- Robbed-bit signalling and digital-pad detection. The data frame is six symbols
  and each interval may carry its own constellation *for this reason* — the
  structure exists and is unused, so the mapper needs no change, only the
  detection and per-interval mask selection. CP already carries six constellation
  indices.
- A-law codebook. CP bit 35 already selects the codec and is parsed.
- Honour Table 15 power limits (on a real US line the FCC limit capped this at
  53 333, D = 40).

**References now in hand.** BinModem's `v90/mod.rs` carries Table 15 as
`POWER_LIMITS` and `v90/ucode.rs` both laws' tables — cross-checks for the power
limits and the A-law codebook, not substitutes for transcribing them. Its analogue
modem is the measuring receiver this item describes (`v90/dil.rs` for DIL analysis,
`v90/analogue.rs` for robbed-bit and pad handling), proven against real servers, and
the bridge's network model supplies the robbed bit, the pad and A-law to measure against.

### 6. Deferred: D-Modem, through synthmodem only

Once SynthLink is BinModem-compatible, test SynthLink ↔ synthmodem's D-Modem backend
and BinModem ↔ D-Modem, over SIP. D-Modem has been tested against a real modem up to
V.34; BinModem's own `run-dmodem.bat` already places calls to D-Modem at V.90, V.34,
V.92, V.32bis and V.22bis, so that leg is partly checked. Three independent
implementations agreeing, two with real hardware behind them, is as near a real-line
proof as exists without a line per change — and it de-risks the backport, since
synthmodem's transport will already have carried our protocols.

- **Not before.** Until a protocol passes against BinModem, a failure against D-Modem
  says nothing specific; after, it says either that the two references differ (go to
  the Recommendation) or that synthmodem's transport adds something.
- **Per protocol, not all at once.** V.34 is likely first, being both BinModem's best
  evidence and the ceiling of the D-Modem testing already done.
- **D-Modem lives only in synthmodem.** It is AGPL. Nothing of it enters this repo —
  not as code, not as a test dependency.

---

## Not doing (deliberately)

- **V.29 onto V.8.** `v29hd` exists as a mode bit so the cost is low, but V.29 is
  half-duplex ping-pong with its own audible connect script and was parked. It is
  not offered in the menu and is not worked on further.
- **V.8bis.** No protocol here needs it.
- **BinModem at run time.** Its datapump builds for wasm32 unchanged, and it is not
  used that way and will not be: shipped code stays JavaScript (see the top of this
  file). BinModem is a test peer and a reference to port from.
