# SynthLink — Protocol Authenticity Backlog

Scoped, ready-to-implement upgrades that move implementations closer to the
Recommendations. Everything here was identified during the V.90 session and is
listed because it became **cheap**, not merely because it is desirable.

Read PROTOCOLS.md first for what each protocol currently is. HANDOFF.md has the
current status; DEVLOG.md has the history.

---

## 0. The retrieval technique that unblocked all of this

**This is the most reusable thing in the document. Read it before attempting any
item below.**

Every "self-consistent construction" caveat in this repo exists for one reason: a
spec table could not be read, so a plausible structure was invented and both ends
were made to agree on it. That is honest but not interoperable.

`WebFetch` against an ITU PDF answers through a summarising model. Asked normally,
it **reconstructs** tables — it returns confident, well-formatted, *wrong* values,
which is worse than failing because the output looks like data. The fix is to
forbid that explicitly:

> Do not summarise or reconstruct. Transcribe literally **Table N/V.xx** exactly
> as printed, preserving every cell. If you cannot read the table's cells
> directly, reply with exactly `CANNOT READ TABLE` and nothing else. Do not infer
> values from any formula.

With that phrasing the V.90 session recovered Table 2 (all 25 rows), Table 14
(CP), Table 16 (MP), and V.34's Tables 7 and 8 — after the same source had earlier
produced invented rate rows. Ask for **one table per call**; broad requests
degrade back into summary.

**Always cross-check what comes back.** Two independent confirmations caught a
transcription error this session:

- Table 14's "17-one frame sync" matched the `v90.c` summary's independent
  mention of the same thing → trustworthy.
- Table 8's last two rows came back **column-shifted** (33600 appeared under
  3200 sym/s). The §8.2 formulas exposed it: `N = R·0.28/J`, `b = ⌈N/P⌉`,
  `r = N − (b−1)P`, and the SWP one-count must equal `r`. Only 3429 satisfies
  them for 33600.

So: transcribe, then verify against the spec's own formulas or a second source
before trusting a single cell.

---

## 1. V.90 CRC convention  — *effort: lowest*

**Status:** the only unverified item left in V.90.

V.90 defers the CP/MP CRC to **§10.1.2.3.2/V.34** and does not restate it. That
clause is in the *other* document and was never fetched, so `V90Phase4.crc16()`
currently uses the CCITT generator `x¹⁶ + x¹² + x⁵ + 1` computed over the bits
from the first start bit up to (not including) the CRC's own start bit. Both ends
agree, so it is a real integrity check here — 400/400 single-bit corruptions are
caught — but the convention is inferred.

**Do this:**

1. Apply §0's technique to the V.34 PDF for clause 10.1.2.3.2: generator
   polynomial, the exact bit range covered, initial register value, and whether
   the remainder is transmitted inverted or reversed.
   `https://www.itu.int/rec/dologin_pub.asp?lang=e&id=T-REC-V.34-199802-I!!PDF-E&type=items`
2. Adjust `crc16()` in `vendor/src/dsp/protocols/V90Phase4.js`. It is one function
   with no callers outside CP/MP build/parse.
3. If the spec gives a worked example or test vector, add it to
   `tools/v90-phase4-check.js` as a golden test — the same way the V.32bis §5.2.3
   scrambled-ones vector golden-verifies the scrambler.
4. Update PROTOCOLS.md §8 ("CRC convention inferred") and the header comment in
   `V90Phase4.js`.

**Risk:** none. Both ends change together; `v90-phase4-check` and `v90test` cover
it.

---

## 2. V.34 genuine MP/MP′ (real Phase 4)  — *effort: low-to-medium; best value*

**Status:** V.34's "Phase 4" is a project-invented `DLE 'R' hi lo` control frame
carrying a bit rate. It is not V.34's MP/MP′ sequences.

It is also **decorative**: both ends resolve the rate from the shared config
singleton *before* the DSP is constructed, so the exchange verifies agreement
rather than establishing it. Deleting it would not change the rate selected.
Contrast V.90's CP, which is load-bearing — pull it and nothing decodes.

This is the best-value item because `V90Phase4.js` is now a working template for
exactly this shape of problem: literal bit-position placement, fixed-point field
encoders, CRC, pack-to-bytes, and a check tool that asserts **positions** rather
than only round-tripping.

**Do this:**

1. Transcribe **Table 10/V.34** (MP bit definitions) and the MP′ variant per §0.
   Expect the same structure V.90 inherited: a frame sync, 17-bit groups of one
   start bit plus 16 payload bits, fields at literal positions, trailing CRC.
2. Add `vendor/src/dsp/protocols/V34Phase4.js` modelled on `V90Phase4.js`. Reuse
   its `putUInt/getUInt`, the fixed-point helpers, `crc16`, and `bitsToBytes` —
   consider factoring those into a shared `BitFrame.js` rather than copying, since
   there would then be two users.
3. Replace `RATE_FRAME` / `CTL_RATE` handling in `V34.js` with the MP sequence,
   keeping the existing `DLE`-delimited byte transport (same honest gap V.90 has:
   genuine content, non-genuine carriage).
4. Add `tools/v34-phase4-check.js` following `v90-phase4-check.js` —
   **assert start bits at their literal positions and that documented fields decode
   what was encoded**, not just that it round-trips. A self-consistent
   encoder/decoder pair will happily agree on a wrong layout.
5. Make MP carry something real so it stops being decorative: the symbol rate,
   trellis selection and pre-emphasis are genuine MP fields, and asserting the peer
   agrees on them is a real check.
6. Update PROTOCOLS.md §7 and the §10 summary row.

**Risk:** low. Contained to V.34's control-frame path; the DSP is untouched.
Re-verify with `v34test`, `v34-map-check`, `dsptest2 ONLY=V34`, and the bundle.

**Note:** this does *not* buy real-modem interop on its own — real MP is modulated
by the Phase 4 signalling, not carried as bytes over an established link. It
removes the "made-up exchange" caveat and gets the field layout right, which is the
part that would otherwise have to be redone later.

---

## 3. V.32bis multi-rate + exact Figure 2-1  — *effort: medium, newly unblocked*

**Status:** already HANDOFF's long-standing next step, described there as small and
well-scoped. Two separate things, both previously blocked on unreadable figures.

**3a. Multi-rate (§8).** The Table 5 rate signal *already advertises* the full set
(4800/7200/9600/12000/14400) and `rateFromWord` selects the max. Only 14400 is
wired for data. Needs the fallback constellations (Figures 2-2..2-5) and the
change-rate-without-retrain procedure.

**3b. Exact Figure 2-1.** The 7-bit→point map is currently a self-consistent
bijection over the correct 128-cross set, not byte-exact to the spec's
set-partitioning. That is harmless while the receiver slices (§6), but it is a hard
prerequisite for a Viterbi decoder, whose parallel-transition structure must match
the spec's subset assignment.

**Do this:**

1. Try §0's technique on the V.32bis PDF for Figures 2-1..2-5. **Figures may
   transcribe worse than tables** — they are graphical constellation diagrams, not
   grids of cells. If the point numbering does not come back cleanly, say so and
   stop; do not infer a mapping and call it Figure 2-1.
   `https://www.itu.int/rec/dologin_pub.asp?lang=e&id=T-REC-V.32bis-199102-I!!PDF-E&type=items`
2. If 2-1 is recovered, replace the constellation index map in `V32bis.js` and
   re-verify byte-exactness — the round trip must still be exact, since TX and RX
   change together.
3. If 2-2..2-5 are recovered, add them as configs and wire rate selection, keeping
   the existing Table 5 signal.
4. Add a validating constructor in the style of V.34's `makeConfig`: **throw** if
   the constellation size does not match the advertised rate's bits/symbol. See §6
   below.
5. Update PROTOCOLS.md §6 and the §10 summary row.

**Risk:** medium. Touches the live constellation map. Do 3b before 3a — a wrong
map is easier to spot on one rate than five.

---

## 4. V.34 exact Figure 5 point numbering  — *effort: medium*

**Status:** same class of caveat as 3b. V.34's constellation labelling is a
self-consistent bijection over the correct §9.1/§9.6.1 quarter-superconstellation
structure rather than byte-exact to Figure 5's numbering.

Harmless while the receiver slices and inverts algebraically, but a prerequisite
for a real Viterbi decoder and for interop.

**Do this:** as item 3b, against the V.34 PDF, for Figure 5. Re-verify with
`v34-map-check` across all four rates. Same caution: if the numbering does not
transcribe cleanly, leave it and record the attempt.

---

## 5. V.90 Phase 2–3, and the rest of the real-line gap  — *effort: high*

Only worth doing if real-hardware interop becomes a goal. Listed for completeness;
PROTOCOLS.md §11 item 8 has the full analysis.

- Phase 2–3 state machine: INFO0/INFO1, line probing, ranging, digital impairment
  learning.
- Robbed-bit-signalling and digital-pad detection. **This is why the data frame is
  six symbols and why each interval may carry its own constellation** — the
  structure is already there and unused, so the mapper needs no change, only the
  detection and per-interval mask selection. CP already carries six independent
  constellation indices.
- PCM-law auto-detection and A-law support. CP bit 35 already selects the codec and
  is parsed; only the A-law codebook is missing.
- Carry CP/MP in real Phase 4 signalling rather than as bytes.
- Honour Table 15 power limits — which on a real US line caps the rate below
  56 000 (the FCC limit put it at 53 333, D = 40).

---

## 6. Cross-cutting: make configs self-validating  — *effort: trivial, do alongside*

`V34Mapper.makeConfig` now computes §8.2's `N`, `b` and `r` and **throws** unless
the SWP one-count equals `r` and its right-most bit is 1. It caught nothing when
added — the values were already right — but it means a future rate entry cannot be
added wrong silently, and it independently confirmed the transcription.

Apply the same idea where a spec gives a checkable relation:

- **V.32bis:** assert the constellation size matches the advertised rate's
  bits/symbol, and that the Table 5 word's bit positions round-trip.
- **V.90:** `V90Coder` already throws when `∏Mᵢ < 2^K`. Also assert that a
  requested `(K,S)` satisfies Table 2's `K ≥ 15`, `3 ≤ S ≤ 6`, `21 ≤ K+S ≤ 42` —
  `makeConfig` does this; keep it if the ladder is ever hand-edited.
- **V.34:** assert `bitRate == frameBits · sRate / 8` for constant-`b` configs.

The cost is a few lines per config builder and the payoff is that a
mis-transcribed table fails loudly at construction rather than silently producing
a link that works only against itself.

---

## Not doing (deliberately)

- **V.29 onto V.8.** Same mechanism as the others and `v29hd` already exists as a
  mode bit, so the cost is low — but V.29 is half-duplex ping-pong with its own
  audible connect script and was explicitly parked. See DEVLOG.md.
- **V.8bis.** No protocol here needs it.
- **Viterbi decoders.** On a lossless link the coding gain is unused. Only
  worthwhile as part of a real backport, and gated on items 3b and 4.
