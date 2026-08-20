# SynthLink — V.90 pre-implementation notes

Status: **spec research pass done; no code written.** The architectural reasoning
below (why V.90 fits this transport) was written before reading the spec and has
held up. §"Spec findings" at the end records what the ITU-T V.90 (09/98) text
actually says, and corrects the one place the pre-read reasoning was loose (the
derivation of the 56k cap). `v90.c` was consulted only as an algorithm
cross-check — read in summary, never copied (GPL-2.0; repo stays LGPL-3.0).

## Sources to read next session
- **linmodem `v90.c`** (Fabrice Bellard, GPL-2.0 — algorithm cross-check only, do
  NOT port; repo is LGPL-3.0, see PROVENANCE §4/§6):
  https://github.com/synexo/linmodem/blob/master/v90.c
- **ITU-T V.90 (09/98) PDF** (the normative source):
  https://www.itu.int/rec/dologin_pub.asp?lang=e&id=T-REC-V.90-199809-I!!PDF-E&type=items

---

## Why V.90 is a *more* natural fit than the analog modems

V.21…V.34 are symmetric analog modems: both ends modulate a voiceband waveform and
the channel is treated as an ideal analog line. V.90 is a different animal.

- It does **not** do QAM downstream at all. It exploits the fact that the 1990s
  PSTN core was already digital (64 kbit/s μ-law/A-law PCM, 8000 samples/s), with
  the ISP sitting on the digital side.
- **Downstream** (server→client): the server's "digital modem" places PCM
  codewords *directly* onto the network. They travel digitally to the subscriber's
  central office, hit a **single D/A** there, and cross the analog last mile. The
  client reads back which codeword was sent by measuring the level. Downstream
  V.90 is **PCM codeword selection, not modulation.**

**Key insight for SynthLink:** our transport *is* a PCM-sample channel — the
browser and server already exchange 8 kHz PCM samples over the WebSocket. That is
precisely the medium V.90 downstream was designed to exploit. We are much closer to
V.90's "digital network segment" than to an analog voiceband line. In a sense the
analog modems are the slightly artificial ones here (synthesizing waveforms to ship
over a PCM pipe); V.90 downstream maps onto a PCM pipe directly.

---

## What must be ADDED — the μ-law codec as a modeled bottleneck

This is the crucial caveat. Our transport is 16-bit **linear** PCM and essentially
lossless. V.90's entire structure — which levels are legal, bits/symbol, the
sign/segment layout, spectral shaping — is built around the **G.711 μ-law (or
A-law) companded codebook**. Without a μ-law codec in the path, "V.90" is
meaningless (you'd just be shipping linear PCM).

So we would deliberately **insert an 8-bit μ-law quantizer as the modeled network
codec**. 16-bit linear represents all μ-law decode levels exactly, so it ships
losslessly over our channel. That codec is what makes 56k both possible and
bounded: μ-law spaces levels very finely near zero, so V.90 uses only a
distinguishable *subset* of the 256 codes — roughly **7 usable bits × 8000 ≈
56 kbit/s**. On our noiseless channel we *could* use all 8 bits (64k), but that
would not be V.90; staying spec-faithful means honoring the level-subset structure
and capping at 56k.

> **Corrected by the spec read** (see §"Spec findings"): the arithmetic lands in
> the right place but by the wrong route. V.90 does not carry an integer 7 bits
> per symbol. It carries **D = K + S bits per six-symbol frame**, so the rate is
> `(K+S)·8000/6` — 28000…56000 in 1333⅓ bit/s steps. 56k is `K=39, S=3` ⇒ 42 bits
> / 6 symbols, which *averages* 7 bits/symbol without any symbol carrying an
> integer number of bits. The fractional-bit machinery is the **modulus encoder**,
> and it is the whole point: it is what lets a constellation of arbitrary size
> `Mᵢ` per interval carry a non-power-of-two bit count. Also: the legal level
> subset is **not fixed by the spec** — the analogue modem chooses it and ships it
> as a 128-bit mask. Both facts change the shape of the build.

Note this is **modeling the network** rather than a physical constraint of our
transport — the same kind of modeling we already do by treating the WebSocket as a
4-wire line. Legitimate, but a judgment call to state explicitly in PROTOCOLS.md
alongside the other scope decisions.

---

## Rates and the honest asymmetry

- **Downstream (server→client): up to 56k.** PCM codeword selection.
- **Upstream (client→server): V.34, ≤ 33.6k.** V.90 mandates V.34 upstream because
  in reality that path still crosses an analog loop with a full A/D.

So genuine V.90 is **56k down / 33.6k up** — and the happy part is **we already
built the upstream**: V.90's upstream *is* the V.34 just completed. That makes V.90
a natural continuation, not a from-scratch effort.

(One could go symmetric-PCM for ~56k both ways since our transport is clean in both
directions, but that is no longer V.90 — it is closer to V.92's PCM-upstream idea,
or simply non-standard. Worth noting as an option, not as "V.90".)

---

## What gets DRAMATICALLY simpler (the pleasant surprise)

V.90 downstream needs **no carrier, no RRC pulse-shaping, no matched filter, and no
symbol-timing recovery** — the symbols *are* the PCM samples, one per sample
period, already locked to the 8 kHz clock. The entire 2.5-SPS acquisition headache
from V.34 simply does not exist. The receiver reads sample values and maps them
back to codewords.

All the complexity moves into the **mapper** — the modulus / spectral-shaping
encoder that turns bits into legal codeword sequences. That is exactly the kind of
self-contained, standalone-verifiable component we already have a proven pattern
for (structurally a cousin of the V.34 shell mapper: bits→symbols→bits, round-trip
testable in isolation, like `tools/v34-shell-check.js`).

---

## Genuine-minimal scope-outs (same philosophy; clean transport justifies more)

The clean, known-codec channel makes most of what makes a *real* V.90 receiver hard
evaporate — just as the Viterbi / echo-canceller / equalizer did for V.32/V.34:

- No analog-loop equalizer.
- No robbed-bit-signaling (RBS) handling.
- No digital-pad / attenuation detection.
- No PCM-law auto-detection (we own the codec — μ-law by choice).
- No digital-impairment-learning phase.

---

## Spec findings — the six open questions, answered

Source: ITU-T V.90 (09/98), read this session; `v90.c` consulted in summary as an
independent cross-check on the same structures. Confidence is marked per item.

### 1. Downstream frame structure — **confirmed**
Six-symbol **data frame**, intervals `i = 0..5`, at 8000 symbols/s locked to the
network clock. Each frame carries `D = S + K` bits: `K` into the modulus encoder,
`S` as data-bearing sign bits.

**Rate `= (K+S)·8000/6`.** Endpoints check out: `K=15,S=6` → 21 bits → 28000;
`K=39,S=3` → 42 bits → 56000. Every rate is a multiple of 8000/6 = 1333⅓ bit/s,
which is exactly the well-known V.90 rate ladder (28000, 29333, 30667, … 56000).
The formula is solid. The specific per-rate `(K,S)` pairing table is **not** yet
trustworthy — see "Still open" below.

### 2. Modulus encoder — **confirmed** (spec and `v90.c` agree)
The K data bits are one integer `R₀`; then for `i = 0..5`:

```
Kᵢ    = Rᵢ mod Mᵢ
Rᵢ₊₁  = (Rᵢ − Kᵢ) / Mᵢ
```

with the legality constraint `∏ᵢ Mᵢ ≥ 2^K`. Each `Kᵢ` labels a point in
constellation `Cᵢ`, yielding unsigned magnitude `Uᵢ`. Labels run **descending by
magnitude** — label 0 is the largest PCM code in `Cᵢ`, label `Mᵢ−1` the smallest.
Decoding is the inverse mixed-radix accumulation (`v90.c` recovers it by binary
search per symbol, then reassembles).

This is a mixed-radix / modulus decomposition — structurally the same *kind* of
component as the V.34 shell mapper: pure bits→indices→bits, no DSP, trivially
round-trip testable standalone. The V.34 staging pattern applies directly.

### 3. Spectral shaping — **confirmed**
Each frame has six sign bits; `S` of them carry data and `Sᵣ = 6 − S` are
**redundant**, spent on shaping. `Sᵣ = 0` ⇒ no shaping (S=6); 1/2/3 ⇒ one/two/three
shaping frames per data frame (S=5/4/3).

Shaping picks, per shaping frame, one of four sign-inversion rules on a **2-state
trellis**: **A** leave signs alone, **B** invert all, **C** invert even-indexed
signs, **D** invert odd-indexed. The choice minimises a spectral metric computed
by two cascaded first-order sections plus an accumulator:

```
y[n] = x[n] − b₁·x[n−1] + a₁·y[n−1]
v[n] = y[n] − b₂·y[n−1] + a₂·v[n−1]
w[n] = v²[n] + w[n−1]
```

`x[n]` is the signed linear value of the emitted PCM symbol. The analogue modem
chooses `a₁,a₂,b₁,b₂` (8-bit two's complement, 6 fractional bits, |·| ≤ 1) and
sends them in CP, along with lookahead depth `lₐ ∈ 0..3` (0 and 1 mandatory, 2–3
optional). `v90.c` implements the rule choice as a Viterbi search over the
2-state trellis to depth `lₐ` — which is why its test harness accounts for a
decode delay equal to the lookahead.

**Scope call for us:** shaping exists to keep transmit spectrum inside regulatory
and hybrid-friendly limits on a real loop. On a lossless WebSocket it buys
nothing. But `Sᵣ = 0` (S=6) is a legal spec configuration meaning "no shaping",
so we can be **fully spec-conformant while skipping the shaper entirely** — a
nicer position than our usual "documented omission". That does, however, constrain
which `(K,S)` rows we can use, and 56k is `S=3`, i.e. it *requires* `Sᵣ=3`. So
either we implement the shaper (rules A–D and the metric are small — maybe 60
lines) or we cap below 56k. **Implementing it is the right call**; it is cheap and
it is the difference between "V.90 at 56k" and "V.90-ish".

### 4. Per-rate legal level sets — **confirmed, and it inverts an assumption**
There is **no fixed per-rate level table.** The eligible set is chosen at runtime
by the *analogue* modem and transmitted to the digital modem as part of **CP**: a
**128-bit constellation mask**, one bit per Ucode 0–127, per interval. `Mᵢ` is
simply the population count of mask `i`. The spec constrains the choice only by
average-power limits (Table 15, and a rule that data-mode constellation power may
not exceed the Phase-4 constellation power by more than 3 dB) — not by any
minimum-distance rule.

The 56k ceiling therefore is **not** derived from level spacing arithmetic in the
spec at all; it is the `D ≤ 42` bits/frame cap, which in turn reflects that the
μ-law codebook's dense near-zero levels are not separably usable over a real loop,
plus the regulatory power limit. On our channel every level *is* separable, which
is precisely why the 56k cap must be imposed **by choice**, as the notes above
already argued. Good news for us: because the constellation is negotiated, picking
our own clean-link mask and announcing it is the *spec-sanctioned* mechanism, not
a shortcut.

### 5. Startup — **confirmed in outline**
Four phases: **1** V.8 negotiation (CM/JM, then CJ + 75 ± 5 ms silence); **2**
INFO0/INFO1 exchange, line probing, and tone A/B phase reversals for round-trip
delay; **3** equalizer training and **digital impairment learning** (DIL
descriptor, `Ja`, `MD`, `TRN` from the analogue side; DIL, `Jd`, `TRN1d` from the
digital side); **4** **CP** from the analogue modem and **MP** from the digital
modem, then `TRN2d` / `B1d` into data mode.

Nearly all of Phases 2–3 is channel measurement that a lossless link makes vacuous
— same argument that retired line probing for V.34. What we **cannot** skip is the
CP/MP exchange, because that is where the constellation masks, shaping
coefficients, `lₐ`, and the rate selection are actually communicated. That maps
neatly onto our existing in-band control-frame rate exchange (`DLE 'R' hi lo` in
V.32bis, the V.34 equivalent) — we extend it to carry the CP payload instead of
inventing a mechanism.

One genuinely pleasant find: **frame alignment is already in the spec in a shape
we've built before.** The `Sd` training signal is 64 repetitions of
`{+W, +0, +W, −W, −0, −W}` followed by 8 repetitions of the sign-inverted
`{−W, −0, −W, +W, +0, +W}` — a constant run followed by a polarity flip, i.e. the
same alt→const boundary trick our V.29/V.32/V.34 acquisition already keys on. Its
first symbol is defined to be data frame interval 0, and alignment is held from
there. On a drift-free clock that is the *entire* receiver acquisition problem,
and it is genuine spec.

### 6. Upstream / downstream combination — **confirmed**
Upstream is V.34 by direct reference (V.90 §6 cites V.34's symbol rates, carriers,
pre-emphasis, scrambler, framing, and encoder clauses): **4800–28800 mandatory,
31200/33600 optional**. Downstream is PCM at 8000 sym/s, 28000–56000. The two
directions are independent and asynchronous; there is no joint framing. Rates are
exchanged in Phase 4 — CP carries the selected digital→analogue rate (`drn`, an
integer 0–22), MP the maximum analogue→digital rate.

**We already have the optional top of the upstream.** Our V.34 does 33600, so the
upstream side of a maximal V.90 connection is finished code.

---

## Still open (do not treat as settled)

- **The exact Table 2 `(K,S)` pairs.** The rate *formula* is verified from both
  endpoints; the individual row pairings I pulled back are a summarisation of the
  PDF and read partly reconstructed. Before coding the rate table, get these off
  the PDF text directly. (For a single-rate first cut this doesn't block us: 56k
  is `K=39, S=3`, and that one is solid.)
- **CP and MP exact bit layouts** (Tables 14 and 16). Needed to frame the
  parameter exchange, even in a collapsed form.
- **RBS / digital-pad handling and what DIL actually measures.** One retrieval
  claimed V.90 doesn't cover robbed-bit signalling, which contradicts Phase 3
  carrying a DIL phase whose purpose is exactly that. The retrieval is wrong or
  the summariser dropped it; resolve against the PDF text. Low priority — we scope
  all of it out regardless — but the notes shouldn't record a contradiction.
- **Table 15 power limits**, if we want the constellation-choice justification to
  cite real numbers.
- **Whether `Mᵢ` may differ across intervals in practice**, and how our chosen
  mask interacts with the `∏Mᵢ ≥ 2^K` constraint at `K=39`.

---

## Revised build order (supersedes the sketch below)

The spec read doesn't change the staging, but it sharpens what "component 1" is:

1. **μ-law codec** (linear ↔ 8-bit μ-law, the full Table 1 Ucode set) — standalone,
   round-trip exact. Smallest possible first block.
2. **Modulus encoder/decoder** — bits → `K₀..K₅` → bits, mixed-radix, verified
   round-trip over random `K` and random legal `Mᵢ` sets. Pure integer arithmetic;
   this is the `v34-shell-check.js` analogue and should be as clean.
3. **Constellation builder** — 128-bit mask → `Cᵢ` tables (descending magnitude) →
   `Mᵢ`; pick and document our clean-link mask; assert `∏Mᵢ ≥ 2^39`.
4. **Spectral shaper** — rules A–D over the 2-state trellis with the `w[n]` metric,
   at `lₐ = 1`. Verify signs round-trip and that the shaper is bit-transparent to
   the data-bearing sign bits.
5. **Frame assembly + `Sd`-based acquisition**, then the collapsed CP/MP exchange.
6. Reuse **V.34 @ 33600 as upstream**, unchanged.
7. Wire the four integration points, `npm run build`, browser-path safety check,
   `dsptest2`, bundle test; then update PROTOCOLS.md / PROVENANCE.md / HANDOFF.md /
   DEVLOG.md.

Steps 1–4 are all sockets-free, DSP-free pure functions — the entire hard core of
V.90 downstream is unit-testable before anything touches `Handshake.js`. That is a
markedly better starting position than V.34 had.

---

## Suggested next-session approach (mirrors the V.34 method)

1. Fetch + read the ITU-T V.90 PDF; cross-check `v90.c` as an algorithm reference
   only (clean-room; no GPL port — keep LGPL-3.0).
2. Decide and document the **μ-law-codec-as-modeled-bottleneck** scope call.
3. Build the **μ-law quantizer** + the **downstream PCM mapper** as standalone,
   round-trip-verified components first (bits→codewords→bits), before any wiring —
   the same "verify each hard block standalone" staging that made V.34 smooth.
4. Reuse the finished **V.34 as the upstream** direction.
5. Wire the four integration points + bundle + browser test; update
   PROTOCOLS.md / PROVENANCE.md / HANDOFF.md / DEVLOG.md.

**Bottom line:** very doable, fits the transport more cleanly than the analog
protocols, downstream 56k is real, upstream is already done via V.34, and the
feared DSP front-end is *easier* here, not harder. The real work is the μ-law codec
plus the downstream PCM mapper.
