# SynthLink — Protocol Implementations

Exact scope of every modulation SynthLink implements: what is genuine ITU/Bell,
what is simplified, the handshake, and what each would need to interwork with a
**real modem**.

Source files: `vendor/src/dsp/protocols/*.js`. Registry + handshake wiring:
`vendor/src/dsp/Handshake.js`. Top-level pump: `vendor/src/dsp/ModemDSP.js`.

---

## 0. Transport assumptions (why "genuine minimal" is valid here)

Every protocol below runs over the SynthLink transport, **not** a phone line:

- **Lossless.** Modulated Int16 PCM @ 8 kHz over a WebSocket. No additive noise,
  no fading, no non-linear distortion (only Int16 quantisation).
- **A 4-wire equivalent.** The two WebSocket directions are independent; none of
  a modem's own transmit leaks into its receive. **This removes the need for an
  echo canceller** — the single hardest component of full-duplex V.32/V.32bis.
- **Shared, drift-free clock.** Both ends sample at a nominal 8 kHz with zero
  relative drift, so a receiver that acquires symbol timing once can free-run.

A fourth fact matters only for V.90: the transport is not merely *like* a clean
line, it **is a PCM-sample channel**. That is the medium V.90's downstream was
designed to exploit, so V.90 maps onto it directly rather than by analogy, and
needs no carrier, pulse shaping, matched filter or timing recovery at all.

These facts are what let the newer receivers be **"genuine minimal"**: real
modulation, encoding, scrambler and a real-enough training handshake, but
**without** an adaptive equalizer, continuous timing tracking, echo canceller or
Viterbi decoder. On a real line all four come back (§11).

**Clean-link config relaxations** (`vendor/synthlink-config.js`, applied to BOTH
server and browser bundle; defaults preserved for other consumers):

| Flag | Effect | Why safe here |
|---|---|---|
| `skipCdVerification=true` | Skips Handshake's post-training wall-clock carrier-detect stability gate | That gate is a phone-line-noise filter; it cannot latch under browser main-thread contention on a lossless link. |
| `v22MagOnlyDetect=true` | V.22/V.22bis detect on matched-filter magnitude, dropping the answer-side anti-V.32-AA spectral test | That test can never pass against a guard-tone-emitting peer, and there are no V.32 automode signals to guard against here. |
| `cdStableMs=120`, `listenWindowMs=12000` | Relaxed CD-gate params | Only used if `skipCdVerification` were false; kept for reference. |
| `protocolPreference` / `v8ModulationModes` | Per-call protocol select | Default `['V21']`; set just before DSP construction. |

**None of these are valid against real phone lines or real modems.**

---

## 1. Common DSP machinery

- **Async start/stop (UART) framing** on all protocols: start(0) + 8 data bits
  LSB-first + stop(1), line idles mark. No V.42, no error correction, no
  compression — raw async, like a modem in direct mode. Idle therefore emits
  **no bytes**, which is what stops an idle scrambled carrier flooding the peer
  with `0xFF`.
- **Fractional-SPS RRC + matched filter** (V.29/V.32/V.32bis): 2400 baud at 8 kHz
  is 3.333 samples/symbol, handled by continuous root-raised-cosine synthesis
  (rolloff 0.25, span 10) and a fractional matched filter sampling at the true
  non-integer symbol instants.
- **Preamble acquisition** (V.29/V.32/V.32bis): energy onset → fractional
  symbol-timing lock → alternating→constant frame-sync boundary → complex
  channel-gain seed → decode. Preamble is `SEG_A` alternating symbols
  (timing/AGC) plus `SEG_B` constant symbols (gain/phase reference and frame-sync
  marker).

---

## 2. FSK — V.21, Bell 103, V.23

| | V.21 | Bell 103 | V.23 |
|---|---|---|---|
| Rate | 300 bps | 300 bps | 1200/75 split |
| Modulation | FSK, split-band duplex | FSK | FSK, asymmetric split-speed |
| Source | `V21.js`, `FskCommon.js` | `Bell103.js` | `V23.js` |

Genuine FSK, synthmodem-native (not spandsp ports). Fastest and most robust to
acquire on this link. V.21 is the config default and the fallback when a
requested protocol is not in the server whitelist. **V.21 is slow**: a ~185-byte
banner alone is ~6 s, so full banner+echo tests sit near the harness time budget
and can flake.

### Bell 103 does not run V.8, and its start-up is paced from a capture

Bell 103 (1962) is a Bell System standard, so **Table 2/V.8 has no modulation bit
for it**. A Bell 103 call could therefore only ever reach the V.8 exchange, find
an empty JM intersection and fall back — five warnings and ~2.8 s per call, with
the two ends reaching data mode seconds apart because the answer side then sat
waiting for a CJ the caller had already stopped sending. It takes V.29's shape
now: both roles go straight to the protocol, and the answer modem idles its
2225 Hz mark.

It must NOT take the forced-protocol path, which prepends V.25 initial silence and
a plain ANS: the caller reaches data mode long before that finishes. Measured,
0.70 s against the answerer's 6.83 s.

**The pacing is measured off `tools/datasource/bell103-capture.wav`**, not chosen:
2.51 s of 2100 Hz answer tone, the originate carrier up as it ends, then exactly
1.00 s of mark idle before the first data bit — 3.50 s in total, and ours is
3.52 s. Both roles count the same constants, which is why they arrive together.
That is a count and not a signal, deliberately: Bell 103 has no negotiation to
gate on, and the carrier-detect gate that would serve instead is disabled here by
`skipCdVerification`. The mark idle is `trainingDurationMs.Bell103`, set in
`vendor/synthlink-config.js` — the upstream table gives it 0 with the comment
"FSK — no training needed", and 0 is falsy at the read site, so the value was
never what the comment said.

Neither V.21 nor Bell 103 has a training sequence at all — 300 baud on two tones
has nothing to equalise — so both report their start-up as an idling carrier
rather than as training.

**The capture is the only real-signal artefact for either FSK protocol here**, and
it earns its place: our demodulator decodes its 55 bytes exactly, and
`bell103capturetest` fails on an inverted mark/space polarity, a 30 Hz frequency
error or a wrong baud — none of which a loopback can see, because both ends read
the same constant. With mark and space swapped the loopback still connects and
still passes data. → PROVENANCE.md for where the file came from.

---

## 3. V.22 / V.22bis — 1200 / 2400 bps DPSK / 16-QAM

Source: `V22.js` (both classes), `V22Common.js`, `V22Demodulator.js`,
`V22RxRRC.js`. **JavaScript ports of spandsp** — see PROVENANCE.md.

### Non-standard / clean-link adaptations (hard-won; don't regress)

The spandsp DSP was only ever exercised as the **answer** side against real
hardware. Making the **originate** side work JS↔JS required:

1. **Guard tone made answerer-only.** Per V.22bis §2.2 the 1800 Hz guard tone
   belongs to the answerer only; it was hard-coded on for both roles, which
   defeated the peer's carrier detector. Fix: `guardTone: isAnswer` in both
   constructors.
2. **Mag-only remote detection** (`v22MagOnlyDetect`). The answer-side detector
   required carrier-bin energy > 3× the 1800 Hz ghost bin — impossible against a
   guard-tone-emitting peer. The fix drops the spectral test and detects on
   matched-filter magnitude.
3. **Caller-lead training** (V.22bis §6.3.1.2.1). Originate training was never
   implemented in spandsp — it fell through to the answer flow. Fix: in
   `V22bis._advanceHandshake` case `U11`, for `role !== 'answer'`, once
   `_remoteDetected`, proactively call `_onS1Detected('originate-lead')`. The
   answerer stays reactive.

### For real-modem interop

These already interwork with real hardware on the answer side (that is what
spandsp was built for). The originate-lead path and the mag-only detect are
clean-link shortcuts needing re-checking against the full spandsp detection logic
on a noisy line.

---

## 4. V.29 — 9600 bps, half-duplex ping-pong

Source: `V29.js`. Prototypes: `tools/v29-proto.js`, `tools/v29-stream.js`.

**Not offered in the speed menu.** The class, its `server.js` `PROTOS` entry and
its tests are all live; only the `<option>` and its `MS_COMMANDS` row went, so
`AT+MS=V29` now answers `ERROR`. Nothing below is affected.

### Genuine

- Real **16-point constellation** (spandsp point ordering): two amplitude rings.
- Real **encoding**: differential **phase** (Q2 Q3 Q4 → phase change per the §4
  table) plus absolute **amplitude** (Q1). 2400 baud × 4 bits = 9600 bps.
- Real **scrambler** `1 + x⁻¹⁸ + x⁻²³` (self-synchronising).
- **1700 Hz carrier**, 2400 baud, fractional-SPS RRC + matched filter.
- Async start/stop UART framing.

### Non-standard / deliberate design choices

- **Half-duplex ping-pong** (Hayes "Express 96" style), not full-duplex. V.29 is
  a half-duplex modem; full-duplex 9600 on 2-wire needed the echo cancellation
  that arrived with V.32. Carrier is present only during a data burst, the
  receiver **re-acquires per burst**, and idle is silence. We *could* run
  full-duplex on this 4-wire transport, but a continuous V.29 carrier with no
  framing floods the peer with descrambled idle `0xFF`; ping-pong is the honest
  consumer representation.
- **Burst/turnaround params:** `MAX_BURST_BYTES=256`, `TURNAROUND_GUARD≈45 ms`
  of silence after each burst (lets the peer squelch-reset and re-acquire —
  without it back-to-back bursts merge and only the first decodes),
  `KEEPALIVE_GAP≈1.2 s` preamble-only keepalive so neither the peer RX nor the
  silence-hangup timer sees a dead line.
- **Audible connect handshake** (`_buildConnectScript`): answerer emits a ~1 s
  2100 Hz V.25 answer tone → both emit a ~250 ms training burst → the short
  `lock` preamble the receiver actually acquires on. The tone and longtrain are
  **non-syncing** pre-roll: neither presents an alternating→constant boundary, so
  the peer's squelch discards each on the following silence and only `lock`
  syncs. This is why the tone lives in `V29.js` rather than the Handshake ANS
  path — a bare 2100 Hz run straight into training would trip the peer's
  energy-onset acquisition.
- **Receiver is genuine minimal:** differential-coherent per-burst acquisition,
  no adaptive equalizer, no continuous timing tracking.

### Handshake wiring

`Handshake.start()` has a `wantV29` bypass routing both roles straight to
`_selectProtocol('V29')` — V.29 is not V.8-negotiable and the Handshake layer
must not emit its own ANS tone. `ready` means "acquired the peer's carrier".

### For real-modem interop

Add an adaptive equalizer and continuous timing tracking (the V.22bis spandsp T/2
equalizer is the reference). Untested against real V.29 hardware.

---

## 5. V.32 — 9600 bps, true full-duplex 16-QAM

Source: `V32.js`. Test: `tools/tests/v32test.js`.

### Genuine (verified against ITU-T V.32)

- **1800 Hz** carrier, **2400 baud**, **non-redundant (uncoded) 16-QAM** on the
  `{±1,±3}²` grid, 4 bits/symbol.
- **Differential encoding — Table 1/V.32, exactly.** Its title names this mode:
  "for 4800 bit/s and for nonredundant coding at 9600 bit/s", so the data and the
  rate signals carry the same coding. The phase quadrant change is **+90°, 0°,
  +180°, +270°** for dibits 00, 01, 10, 11 — *not* a modulo-4 addition of the
  dibit, which transposes the first two. Q3Q4 select the point within the quadrant
  by **Table 3/V.32**'s non-redundant column; Table 3's labels are rotationally
  consistent, so one quadrant-I base row plus a rotation is the whole map.
  Rotationally invariant. `dataPoint`/`dataBits` are the forward and inverse as one
  stated pair. Held against both tables by `tools/tests/v32-map-check.js`.
- **Scramblers (§7), role-asymmetric, self-synchronising:** call-mode
  `GPC = 1+x⁻¹⁸+x⁻²³`, answer-mode `GPA = 1+x⁻⁵+x⁻²³`. Each end scrambles TX with
  its OWN polynomial and descrambles RX with the PEER's. **Bit-exact-verified
  against the V.32bis §5.2.3 golden vector.**
- **The Recommendation's own start-up, §§5.2–5.4.** The receiver conditioning
  signal's three segments — S for 256T, S̄ for 16T, TRN for ≥1280T — on the A B C D
  states of Figure 1/V.32, then §5.3's genuine 16-bit rate signals R1/R2/R3 with
  Table 6's bit positions, ended by Table 7's sequence E. Signals in
  `V32Startup.js`; §5.4's procedure — who transmits what and which SIGNAL each end
  waits for — is the connect script and the start-up receiver in `V32.js`.
  `tools/tests/v32-startup-check.js` holds the transcription, including §5.2.3's
  two printed scrambler golden vectors.
- **A B C D are (−3,−1), (1,−3), (3,1), (−1,3)** — Figure 1's circled subset, at
  Q3Q4 = 01. **Not the outer corners.** Their mean energy is 10, which is the mean
  energy of the whole 16-point constellation, so the conditioning signal already
  sits at the data burst's power.
- **`ORIG_LEAD` is gone.** §5.4.1's call modem transmits nothing until it detects
  an incoming S sequence and then a rate signal; the 0.60 s originate-side silence
  had no basis in the Recommendation. Since V.32 negotiates through real V.8, the
  V.25 answer tone is suppressed on the V.8 path and kept only for the
  forced/legacy path.

**Full-duplex without an echo canceller** is the architectural win: real V.32 on
2-wire PSTN needs adaptive echo cancellation, and the 4-wire-equivalent transport
removes it. The idle-`0xFF` flood that forced V.29 to ping-pong is avoided the
honest V.32 way — V.32 is a **synchronous scrambled** modem (idle = scrambled
MARK) with async UART framing on top, so descrambled idle-mark yields no start
bit and therefore no phantom bytes while the carrier stays continuously up.

**Receiver is acquire-once, free-run:** timing and one complex channel-gain
estimate are taken from **signal S** — §5.2.2's "well-defined event" — and carried
through E into data mode without the carrier dropping, which is what removed the
invented 72-symbol preamble the data burst used to open with. Valid because the
shared 8 kHz clock has zero drift. Which of S's two states the even samples landed
on is resolved from Table 1's +90° A-to-B step: the two answers differ by a
REFLECTION, not a rotation, so getting it wrong negates every differential decode
— the same hazard §10.1.3.7 answers for V.34.
Memory is bounded — the RX buffer is trimmed with `rxBase` advanced, and TX uses
a monotonic sample counter `txN` with a separate `txSymBase`, so trimming never
jumps the carrier phase.

### Deliberately out of scope (documented, not hidden)

- **No TCM / trellis** (that is V.32bis). Non-redundant 16-QAM only.
- **No adaptive equalizer / no timing tracking** — sound only on the zero-drift
  shared clock.
- **The echo-canceller half of §5.4 omitted:** the AA/CC and AC/CA segments, the
  600/1800/3000 Hz tone detections and phase reversals, and the NT/MT round-trip
  periods. All of it trains an echo canceller and measures a round trip the
  4-wire-equivalent transport does not have. What remains is every signal that
  carries information. Untested against real V.32 hardware.
- **TRN at its minimum, 1280T.** §5.2.3 allows up to 8192T; the minimum is a legal
  choice, not an omission.

---

## 6. V.32bis — 14400 bps, true full-duplex trellis-coded 128-QAM

Source: `V32bis.js`. Test: `tools/tests/v32bistest.js`. Built directly on the
V.32 core — same carrier, baud, scramblers, acquisition, framing and connect
script. Only the per-symbol bit→point path and the rate signal differ.

### Genuine (verified against ITU-T V.32bis, 1991)

- **6 data bits/symbol at 2400 baud = 14400** (§2.3.1), grouped Q1..Q6.
- **Table 1/V.32bis differential** (exact, the trellis-coding variant, distinct
  from the 4800 Table 2): `TAB1[din][yPrev]=yNew` =
  `[[0,1,2,3],[1,0,3,2],[2,3,1,0],[3,2,0,1]]`. The decoder inverts it.
- **Convolutional encoder → Y0** (Figure 1): an 8-state systematic FSM driven by
  Y1,Y2 emits the redundant bit Y0.
- **128-point constellation — Figure 2-1, point for point.** Transcribed from
  the Recommendation and indexed by the figure's own bit order Y0Y1Y2Q3Q4Q5Q6.
  The points lie on the checkerboard lattice **Re+Im odd**, |Re|,|Im| ≤ 9, mean
  energy exactly 41 — not an odd-integer grid. Asserted at module load: 128
  distinct points on the lattice, and the rotational structure the differential
  coding requires (90° preserves Q3..Q6, flips Y0, advances Y1Y2 by one
  quadrant; 180° preserves Y0 and Q3..Q6), all 128/128.
- **Scramblers GPC/GPA** (§4): identical to V.32, golden-verified.
- **The Recommendation's own start-up, §§5.2–5.3 and §6** — the same clauses as
  V.32, word for word, so the signals come from `V32Startup.js`: S 256T, S̄ 16T,
  TRN ≥1280T on Figure 2-5's A B C D states (which are Figure 1/V.32's four
  points), then R1/R2/R3 with **Table 5/V.32bis**'s genuine bit positions —
  `B5=4800, B6=9600, B9=7200, B10=12000, B12=14400` plus the sync cells — ended by
  Table 6/V.32bis's sequence E. On the wire as §5.3's 16-bit sequences, scrambled
  and differentially encoded, not as a `DLE 'R' hi lo` control frame. §6's
  procedure is in `V32bis.js`. Verified `peerRate === 14400` both sides.
- **Figure 2-5's states are scaled to Figure 2-1's energy.** The two are separate
  signal-space diagrams at different scales — mean energy 10 and 41 — and one modem
  has one line power, so the conditioning signal and the rate signals are scaled by
  `sqrt(41/10)`. V.32 needs no such factor: there both come from Figure 1.
- **`ORIG_LEAD` is gone**, as in V.32: §6.1's call modem is silent until it detects
  S and then R1.

### Deliberately out of scope (documented, not hidden)

- **No Viterbi decoder.** Y0 is genuinely produced and on the wire (real
  trellis-coded modulation), but on a lossless link the ~4 dB coding gain is
  unused, so the RX **slices** and reads the bits back directly. The set
  partition on the wire is now the Recommendation's, so adding a Viterbi decoder
  no longer needs the map fixed first — it is the one remaining piece.
  `convEncode` is still a genuine 8-state FSM of the V.32 family rather than an
  independently golden-verified Wei code.
- **No adaptive equalizer / no timing tracking** (as V.32).
- **Single operating rate (14400).** The rate signal genuinely advertises the
  full set and negotiates the max, but only 14400 is wired for data. The
  12000/9600/7200/4800 fallbacks and §8 rate-renegotiation-without-retrain are
  the documented next step.
- **The echo-canceller half of §6 omitted:** AA/CC, AC/CA, the tone detections and
  reversals, and the NT/MT round-trip periods — as V.32, and for the same reason.
  Untested against real hardware.
- **TRN at its minimum, 1280T** (§5.2.3 allows 8192T).
- **Fallback constellations (Figures 2-2..2-4) not yet transcribed** — only
  Figure 2-1 (14400) has been, and Figure 2-5 (4800) for the training states.
  They are readable by the same route.

---

## 7. V.34 — 19200–33600 bps, shell-mapped trellis-coded QAM

Source: `V34.js` + `V34Mapper.js` + `V34Phase4.js` (Table 20 MP; bit-framing
shared with V.90 via `BitFrame.js`). Tests: `tools/tests/v34test.js` and
`tools/tests/v34-{trellis,shell,map,phase4}-check.js`. Built on the V.32/V.32bis core;
**clean-room from ITU-T V.34 (02/98)** — no linmodem (GPL-2.0) code ported.
Config-driven (`makeConfig`/`CONFIGS`) with **four data-mode rates, all verified
end-to-end**: 19200/2400, 28800/3200, 31200/3200 and 33600/3429. Selected per
call via `config.modem.native.v34Rate`, defaulting to the max.

**The menu offers one V.34 entry**, `value="V34"`, which takes that default —
33600. The other three rates are reached by setting `v34Rate` directly, which is
what `dsptest2` and `v34test` do, so all four stay covered.

### Genuine (from the Recommendation)

- **Symbol rate + carrier (Tables 1–2), as the rationals the clauses give.**
  §5.2 is `S = (a/c) × 2400 ± 0.01%` and §5.3 is `(d/e) × S`; both tables PRINT
  their values rounded, and `RF` carries a/c and d/e instead, keeping the printed
  integer only as the key CONFIGS, Table 7, Table 10 and INFO1c's rate ladder are
  keyed on. So 2400 baud / 1800 Hz (19200), 3200 / 1920 Hz (28800, 31200), and
  **24000/7 = 3428.5714 baud / 96000/49 = 1959.1837 Hz** (33600) — the last was
  3429 / 1959 and 125 ppm outside §5.2's own 100 ppm. 8 kHz clock ⇒ exactly 10/3
  SPS at 2400, 5/2 at 3200, 7/3 at 3429. The 3429 occupied band is razor-thin —
  lower edge ≈ 4 Hz — but sound on a lossless link; carrier 1800 folds the lower
  sideband through DC and fails.
- **Which of the two carriers is declared (§5.3).** Table 2 offers a low and a
  high carrier per symbol rate. `RF` names one, and INFO0's `lowCarrier*` /
  `highCarrier*` bits and INFO1c's `highCarrier*` are derived from it rather than
  stated — 3200 transmitted the high carrier and advertised the low, which costs
  nothing where both ends read the same table and is 91 Hz of disagreement with a
  modem that believes it.
- **Shell mapper (§9.4):** real constellation shaping — K scrambled bits → 8 ring
  indices over M equal rings via the g2/g4/g8/z8 recursion. Encoder and inverse
  round-trip bit-exact.
- **4D differential encoder (§9.5):** I(m)=I2+2·I3, Z(m)=(I(m)+Z(m−1)) mod 4.
- **16-state 4D trellis on the wire (§9.6.3, Figure 10 / Wei):** genuine
  systematic convolutional encoder; subset labels from Figure 9 + Table 13; U0
  rotates the second 2D point of each 4D symbol.
- **Mapper (§9.6.1) and the Figure 5 constellation (§9.1):** the quarter
  superconstellation is the Recommendation's own point set and numbering, all 416
  labels transcribed. It is **not** a quadrant — the quarter is the Re ≡ Im ≡ 1
  (mod 4) sublattice of the odd-integer grid, spanning all four quadrants, and the
  four residue classes form one orbit under 90° rotation, which is what makes it a
  system of orbit representatives and lets the class alone name the rotation.
  Labels rise with magnitude, ties to the greater imaginary component, so the M
  equal rings are consecutive blocks of 2^q labels. Q(n)=Qbits+2^q·ring; the two
  points of a 4D symbol rotated by Z(m)·90° and [Z(m)+2·I1+U0]·90° clockwise.
- **Scramblers (§7):** GPC/GPA, identical generators to V.32/V.32bis.
- **MP sequence (§10.1.3.9, Table 20, Type 0):** the Phase 4 Modulation Parameter
  sequence at its literal bit positions — frame sync, start bits, both directional
  rate maxima (N·2400), auxiliary-channel select, trellis select, Θ, shaping
  select, acknowledge, the bits 35:48 capability mask, and the §10.1.2.3.2 CRC.
  MP′ is MP with the acknowledge bit set, and the exchange is load-bearing: data
  mode waits on the far end's MP, answers it with MP′, and reads the peer's rate
  and coding selections from it. `tools/tests/v34-phase4-check.js` asserts the
  positions, not just the round trip.
- **Mapping parameters (Table 10):** the K/M/L triples are the Recommendation's
  Minimum-shaping rows, checked in `makeConfig` — which is also what makes MP's
  shaping bit genuinely 0 rather than a guess.
- Async UART framing; `peerRate` verified equal both sides at every rate.

### Genuine-minimal, documented (lossless-transport-justified)

- **No precoder (§9.6.2).** A flat, ISI-free channel gives h≈[1,0,0] ⇒ c(n)=0 ⇒
  Y≈U, so the Tomlinson-Harashima precoder degenerates to identity. Consequently
  C0(m)=0 and **U0(m)=Y0(m)**.
- **No Viterbi decoder.** The receiver slices to the odd-integer lattice and
  inverts algebraically, discarding U0. The trellis genuinely runs at the
  transmitter but its coding gain is unused — exactly as V.32bis carries Y0.
- **No probing ANALYSIS**, though the probing signals and the INFO exchange that
  carries their results are real (Phase 2, below): L1 and L2 are transmitted to
  Table 17 and nothing is measured from them. **No non-linear warping** (§9.7),
  **no adaptive equalizer or timing tracking**, **no superframe bit-inversion sync
  (V0=0)**, **no auxiliary channel**, **single rate per call** — though **Phase 1
  is a real V.8 exchange** (§9), **Phase 2 is §11.2's own procedure** and **Phase 3
  is the Recommendation's own segment machine** (both below).

### Phase 2 — probing and ranging (§10.1.2, ordered by §11.2)

`V34Phase2.js` holds the signals; §11.2.1's procedure is a step list in `V34.js`.

- **Tones A and B** (§10.1.2.1/.2): 2400 Hz from the answer modem with an 1800 Hz
  guard tone, 1200 Hz from the call modem, with genuine 180° phase reversals — and
  §11.2.1.1.3's turnaround is honoured, so a reversal appears on the line 40 ± 1 ms
  after the peer's arrives on it.
- **INFO sequences** (§10.1.2.3): binary DPSK at 600 bit/s on those same carriers,
  a 1 rotating the transmit point 180° and a 0 rotating it 0°, each sequence
  preceded by a point at an arbitrary carrier phase. **Tables 14, 15 and 16** —
  INFO0, INFO1c, INFO1a — at their literal bit positions, with §10.1.2.3.2's CRC
  over the information bits only.
- **L1 and L2** (§10.1.2.4): the 21 probing tones of **Table 17** at their printed
  initial phases, 150 Hz apart from 150 to 3750 Hz with 900, 1200, 1800 and 2400
  omitted — the four the data mode and Phase 2 itself use. L1 for 160 ms at +6 dB,
  L2 at nominal.
- **The round trip delay is genuinely measured**, from the recorded reversal
  timestamps (§11.2.1.1.4, §11.2.1.2.4). It is the one measurement in Phase 2 this
  transport can actually make.
- **§11.2.2's recovery bounds are the Recommendation's own**, per step — 2000 ms
  for a second reversal, 900 ms + RTD for a third, 700 ms + RTD for INFO1a, and
  §11.2.2.1.2's *no bound at all* while waiting for the first.
- **What INFO1 settles is load-bearing:** MD's length (Tables 15/16 bits 18:24,
  each modem declaring its own per §11.3.1.1.4) and the symbol rate for both
  directions (Table 16 bits 34:39). `MD_SYMBOLS` as a constant is retired.
- **The probing RESULTS are not measured.** This transport has no amplitude
  distortion, group delay or noise, so an analysis of L1 and L2 would report a flat
  channel; INFO1c's projected data rates are filled from what each configuration
  actually achieves, and a rate with no config reports 0, which Table 15 defines as
  "the symbol rate cannot be used". Same division `V90Phase3` makes for DIL: a
  later interop receiver adds a measurement behind a transmitter that is already
  the Recommendation's.
- **V.90 does not run this, but it runs §9.2 on the same machine.** §9.2/V.90 is
  its own procedure between the analogue and the digital modem, and it is this
  procedure with the two modems renamed — clause for clause, every duration and
  every §11.2.2 bound. `V90.js` supplies a Phase 2 profile instead: the part (the
  digital modem takes the call modem's, the analogue modem the answer modem's) and
  the four INFO sequences.

### Phase 3 — the real segments (§10.1.3, ordered by §11.3)

`V34Phase3.js`. S (128T) and S̄ (16T) as §10.1.3.7's alternations of point 0 and
its rotations; MD (§10.1.3.5, length 0 — the clause makes it optional and its
length an INFO1 field, so a modem without one declares none); PP as equation
(10-1)'s 288 symbols; TRN (§10.1.3.8) as scrambled ones on the 4-point set at the
§11.3 minimum of 512T; then J (Table 18's 4-point pattern) and one J′ (Table 19),
both differentially encoded per §10.1.3.3 from TRN's final symbol. Each segment is
scaled to the data burst's mean symbol energy, which §10.1.3's NOTE requires.

The order is §11.3's, not Figure 19's: the answer modem leads after 70 ± 5 ms of
silence (§11.3.1.2.1) and the call modem is "initially silent" until it detects S
and the subsequent S̄ (§11.3.1.1.1). That detection replaced `ORIG_LEAD`, a 0.60 s
originate-side silence with no basis in the Recommendation.

The receiver locks timing on S, classifies each symbol against the four rotations
of point 0, counts S / S̄ runs and differential-decodes the bit stream J, J′ and
V.90's Ja ride on. It measures nothing — PP trains an equaliser and TRN refines
one, and there is neither ISI nor drift here — so a later interop receiver adds a
measurement behind a transmitter that is already the Recommendation's.

**Still a constant:** J's repetition count. §11.3.1.2.4 repeats J until the far
end's S̄, and §11.4 has no S for it to terminate on, so both ends read the same
number. V.90's analogue modem does not have this problem — its Ja is terminated by
a real signal.

**Divergence, stated:** §11.3.2.1.1's 2800 ms deadline is honoured, but its action
on expiry is a retrain (§11.5.1.1) and there is no retrain state machine here. On
expiry the modem proceeds into its own Phase 3 anyway, because proceeding degrades
to a call that trains where hanging does not.

### Phase 4 — the MP exchange (§11.4)

§11.4.1.1.1's TRN follows J′, then MP repeats until the far end's arrives, then MP′
(Table 20 bit 33), then §10.1.3.2's E — twenty binary ones, ten symbol intervals.
All of it on §10.1.3.9's **4-point form**, which is §10.1.3.3's chain and is what
this modem's J advertises: two scrambled bits a 2D symbol interval, differentially
encoded, the encoder initialised from TRN's final symbol as the clause requires.
The receiver is the Phase 3 decoder unchanged — frame sync plus CRC finds MP in the
same bit stream J and Ja arrive in. Each end reads the other's MP *and* its MP′, so
the exchange establishes agreement rather than decorating it, and a disagreement on
trellis, Θ or shaping is recorded rather than silently decoded wrongly.

**A sequence is sent at least twice, and that is not padding.** TRN is not
differentially encoded, so the receiver's self-synchronising descrambler spends its
first 23 bits recovering after it; a sequence sent once is the sequence that gets
eaten. It is the same reason §10.1.3.3 makes J "a whole number of repetitions".

**Still on the byte channel:** `DLE 'D'`, the data-mode mark. §11.4 ends B1 and
begins data on a frame count both modems keep, which a burst re-acquired after a
silence cannot; the mark stands in for that count. Nothing else crosses it.

### Rates and 33600 frame switching (§8.2 / §9.3.1)

`bitRate = frameBits · sRate/8`:

| Rate | S (baud) | b | K | M | q | L | SWP | switching |
|---|---|---|---|---|---|---|---|---|
| 19200 | 2400 | 64 | 28 | 12 | 3 | 384 | FFFF | no |
| 28800 | 3200 | 72 | 28 | 12 | 4 | 768 | FFFF | no |
| 31200 | 3200 | 78 | 26 | 10 | 5 | 1280 | FFFF | no |
| 33600 | 3429 | 79 | 27 | 11 | 5 | 1408 | 14A5 | **yes** |

**31200/3200** is fully spec-correct: the same 3200 front-end as 28800, constant
`b`, just a larger 1280-point constellation.

**33600/3429 frame switching** is genuine §8.2: the switching pattern selects,
per mapping frame, whether it carries `b`=79 or `b−1`=78 data bits. A low frame
draws K−1 real shell bits and **inserts a forced 0 as the high-order
shell-mapper bit** (§9.3.1), so the shell mapper always sees K bits and the I/Q
parser is identical either way. Both ends drive the pattern from a **frame
counter reset at data-burst start**; acquisition lands on TX frame 0, and on the
drift-free clock the high/low parity stays in lockstep. The differential/trellis
state advances per 4D symbol regardless of parity. The **acquisition timing
search runs at SPS/64**, not SPS/16: the sharp 3429 eye tips the slicer at a
~0.07-sample timing error, which the coarser grid could not resolve (≈99 % symbol
errors → 0). That is a finer one-time search, not timing tracking, and leaves
2400/3200 unaffected.

**SWP indexing is spec-correct** (it was not, before Tables 7/8 were transcribed).
§8.2: *"SWP is represented by 12- to 16-bit binary numbers where 0 and 1 represent
low and high frames... The left-most bit corresponds to the first mapping frame in
a data frame. The right-most bit is always 1."* So the pattern is **P bits wide
and indexed MSB-first**, where P comes from Table 7 — not 16 bits LSB-first, which
is what this code did. For 3429, P = 15 and SWP = 0x14A5 is `001010010100101`.
Table 7 framing: a superframe is 280 ms holding J data frames of P mapping frames
— 2400 → J 7/P 12, 2743 → 8/12, 2800 → 7/14, 3000 → 7/15, 3200 → 7/16, 3429 →
8/15.

**The configs self-validate against §8.2.** `makeConfig` computes `N = R·0.28/J`
and `r = N − (b−1)P` and **throws** unless the SWP's one-count equals r and its
right-most bit is 1. All four pass, which independently confirms the b/K/M/q
values: 33600/3429 → N 1176, P 15, b 79, r 6, long-run average b = 78.4.

### Notes

- The 2.5-SPS receiver needed only a **wider matched-filter span (24)** at the low
  roll-off required to fit 3200 baud in-band — not a timing-recovery rewrite. The
  earlier garbage was residual ISI from a too-short span tipping the slicer, not
  acquisition. 3429 extends the same approach (span 32, β 0.14).
- **The constellation self-validates**, like V.32bis's. `makeConfig` throws unless
  the four rotations of the quarter are disjoint and total L, `invRot` inverts
  them, the labels are in §9.1 order and the rings are concentric in label order;
  the generator also refuses a search box that does not contain the points it
  selected. `v34-map-check` holds the transcribed figure — every label of all 23
  rows — so a regeneration is checked against the Recommendation and not only
  against itself.
- **MP Type 1** (Table 21, precoder coefficients) is not built: there is no
  precoder on this link. Type 0 is what an implementation without one sends.
- **Phase 3's segments are transmitted faithfully and measured not at all**, the
  same division V.90's DIL makes. `v34-phase3-check` holds the clauses.
- **The receiver is an exact polyphase bank, and the conformance above is what
  makes it possible.** With S the Recommendation's rational, SPS is exactly
  SPS_P/SPS_Q (7/3 at 3429, 5/2 at 3200, 10/3 at 2400) and FC/SR is exactly
  CAR_R/CAR_S (12/49, 6/25, 9/40). So the carrier is a CAR_S-entry table indexed by
  `(CAR_R·n) mod CAR_S` — no rounding, and no argument growth over a long call —
  and the matched filter is SPS_Q tap vectors built once per acquisition
  (`_symBank`/`_symAt`), because advancing the symbol index by SPS_Q advances the
  position by the *integer* SPS_P. Nothing is interpolated: the taps are the
  doubles `rrc()` returns. With the rounded 3429 the timing phase repeated only
  every 3429 symbols and no exact bank existed. TX carries the mirror of it, a
  SPS_P-phase bank. Cost: 33–35 → 8–9 ms of CPU per 500 ms of audio, originate.
- **§11.2.2's recovery ACTIONS are implemented.** Steps carry `recover` (a bound
  expiring) and `interrupt` (a signal arriving), with recovery-only steps reached
  by a `goto` and skipped by the error-free procedure. §11.2.2.1.1, .1.3, .1.4,
  .1.6 and §11.2.2.2.1, .2.2, .2.3, .2.4 all have theirs, INFOMARKS included, and
  bit 28 is read off the receiver — it is what ends a repetition. Two still only
  advance, and say so where they are written: §11.2.2.1.5 and the Tone-detected
  halves of .1.6 and .2.4, whose only remedy is a §11.5 retrain this build has no
  implementation of.
- Untested against real V.34 hardware.

---

## 8. V.90 — 56 000 downstream PCM + 33 600 upstream V.34

Source: `V90.js`, `V90Mapper.js` (downstream coder), `V90Phase4.js` (CP/MP
sequences). Component checks: `tools/tests/v90-{ulaw,modulus,shaper,map,phase4}-check.js`.
Protocol-unit test: `tools/tests/v90test.js`. Clean-room from **ITU-T V.90
(09/98)**.

V.90 does not modulate downstream at all: the digital modem places PCM
**codewords** directly onto a digital path and the analogue modem reads back
which codeword was sent by measuring the level. **Our transport is a PCM-sample
channel**, which is precisely that medium — so the entire DSP front-end that made
V.34 hard does not exist here. **The symbols are the samples.**

### Roles — asymmetric, and the mapping is forced

| | role here | direction | rate | carries |
|---|---|---|---|---|
| **digital modem** | `answer` (server) | downstream | 56 000 | PCM codewords |
| **analogue modem** | `originate` (browser) | upstream | 33 600 | genuine V.34 |

That is the only V.90-true mapping, and it happens to put the fast direction
where a BBS needs it. The upstream is **this repository's V.34 at its top rate,
composed unmodified and driven in one direction only** — V.90 §6 references
V.34's clauses directly, so this is not an approximation of the upstream, it *is*
the upstream. §6.1 makes 4800–28800 mandatory and 31200/33600 optional.

Note the analogue modem's V.34 instance never fires its own `ready` event: that
event means "my receiver acquired the peer", and this side only transmits V.34 —
its receiver is the downstream PCM decoder.

### The µ-law codebook is honoured, not simulated

V.90's downstream transmitter is **defined** as selecting G.711 µ-law codewords,
and that is what this code does: it emits the linear values those codewords decode
to, drawn from the Table 1 codebook. There is no quantiser in the path and nothing
is companded. What differs from a real link is narrower:

- On the PSTN the 64 kbit/s digital path **enforces** the codebook. Here nothing
  does — the restriction is self-imposed.
- A real digital modem hands 8-bit octets to the network; we ship the decoded
  16-bit linear values. Bijective, but our "network" is wider.
- Consequently we inherit none of the impairments — robbed-bit signalling,
  digital pads, the loop's own D/A — that make a real V.90 **receiver** hard.
  **That is the real simplification, and it is on the receive side.**

Transport fidelity was measured, not assumed: G.711's 14-bit scale is shifted ×4
into 16-bit linear PCM (peak 32124, 0.980 of full scale, no clipping), the minimum
µ-law step becomes 8 LSB against a Float32→Int16→Float32 round-trip error of 0,
and every legal codeword slices back exactly.

### Frame structure and the rate ladder (Table 2)

A **data frame** is six symbols (i = 0..5) carrying D = S + K bits:

```
    rate = (S + K) · 8000 / 6         D ∈ [21, 42]  ⇒  28 000 … 56 000
```

in 1333⅓ bit/s steps — 22 rates. The six-symbol frame is not arbitrary: on a T1
the robbed-bit-signalling pattern repeats every six frames, which is why V.90 lets
each interval carry its own constellation. We have no RBS, so all six are equal.

Table 2 was transcribed in full (K = 15..39) and every printed row is reproduced
by three constraints: `K ≥ 15`, `3 ≤ S ≤ 6`, `21 ≤ K + S ≤ 42`.

**56 000 has four legal (K,S) pairs** — (36,6), (37,5), (38,4), (39,3) — differing
only in how many sign bits go to spectral shaping. We default to the largest legal
Sr, **(39,3)**, so the shaper is always exercised. Any rung is selectable via
`config.modem.native.v90Rate`, with `v90Sr` optionally pinning the pair.

### Genuine, verified against the Recommendation

- **µ-law codebook (Table 1).** Magnitude `(2·(u&15) + 33)·2^(u>>4) − 33`,
  0 … 8031, checked against an independent G.711 expansion for all 128.
- **Parse (§5.4.2).** `d0..d(S−1)` → sign bits; `dS..d(D−1)` → modulus bits with
  `R0 = b0 + b1·2¹ + … + b(K−1)·2^(K−1)`, b0 the LSB.
- **Modulus encoder (§5.4.3).** `Kᵢ = Rᵢ mod Mᵢ`, `Rᵢ₊₁ = (Rᵢ − Kᵢ)/Mᵢ`, subject
  to `∏Mᵢ ≥ 2^K`. This is what makes V.90's fractional bits-per-symbol work — the
  structural cousin of the V.34 shell mapper, pure mixed-radix integer arithmetic.
  Verified over 250 000 round trips including the full K=39 range. At K=39,
  `R0 < 2³⁹ < 2⁵³`, so Number arithmetic is exact — but **bitwise operators are
  32-bit and must never be used on these values**.
- **Mapper (§5.4.4).** `Kᵢ` labels a member of `Cᵢ`, labelled **descending** by
  magnitude: label 0 is the largest PCM code.
- **Signs (§5.4.6).** Sign bit 1 = positive voltage, 0 = negative.
- **Spectral shaper, CP/MP layouts, and the Sd training signal** — below.

### The spectral shaper

Of the six sign bits, S carry data and **Sr = 6 − S are redundant** and spent on
shaping. Table 3 partitions the six sign positions into Sr shaping frames of 6/Sr
positions; position 0 of every frame is the redundant one, initialised to 0. The
shaper picks, per shaping frame, one of four sign-inversion rules constrained to a
**2-state trellis**:

| rule | action | transition |
|---|---|---|
| A | leave the signs alone | 0 → 0 |
| B | invert every sign in the frame | 0 → 1 |
| C | invert the even-numbered signs | 1 → 0 |
| D | invert the odd-numbered signs | 1 → 1 |

The choice minimises a spectral metric over the emitted linear PCM:

```
    y[n] = x[n] − b₁·x[n−1] + a₁·y[n−1]
    v[n] = y[n] − b₂·y[n−1] + a₂·v[n−1]
    w[n] = v²[n] + w[n−1]
```

with a₁, a₂, b₁, b₂ chosen by the analogue modem and carried in CP as signed
Q1.6, and lookahead depth lₐ ∈ 0..3.

**The shaper costs no data, and that is provable rather than assumed.** Position 0
of every shaping frame starts at 0 and each rule acts on it distinguishably, so a
receiver tracking the trellis state deterministically reads position 0, infers the
rule, un-inverts the rest and recovers the data signs. Verified exhaustively over
every state × rule × data combination for Sr = 1, 2 and 3. lₐ is an
**encoder-side choice only** — it changes which legal rule sequence is chosen,
never how it is decoded. Measured effect with the default b₁ = −1: **−23.2 dB** in
0–200 Hz against an unshaped control on identical data, with +4.3 dB pushed into
3–3.8 kHz. It genuinely shapes.

### Constellations and what CP decides

`Cᵢ` is a set of Ucodes given as a 128-bit mask — exactly the form CP carries. CP
sends a set of up to six constellations plus a 4-bit index per interval; with no
RBS we send one and index it six times.

The default is the **91 largest Ucodes (37..127)**, and that size is forced:
56 000 at (39,3) needs `∏Mᵢ ≥ 2³⁹`, and 90⁶ < 2³⁹ ≤ 91⁶. Dropping the finely-spaced
near-zero codes is what a real analogue modem does. **91 is specific to (39,3)** —
the same 56 000 at (36,6), with no shaping, needs only 64 levels per interval. So
the real trade is shaping against constellation size, not "56k needs 91 levels".

### Acquisition — the Sd signal does all of it

`Sd` is 64 repetitions of `{+W, +0, +W, −W, −0, −W}` followed by 8 of the
sign-inverted pattern, where W is Ucode 127. **Its first symbol is defined to be
data frame interval 0**, so locking the pattern's phase *is* frame alignment. On
the drift-free clock that is the entire receiver acquisition problem.

Two details make it robust:

1. **Polarity must be matched, not ignored.** The pattern is antisymmetric under a
   three-symbol shift, so accepting either polarity pins the phase only mod 3 and
   can lock three symbols early, splitting every frame across the Sd/data
   boundary. Matching the normal polarity only pins it mod 6. This was a real bug;
   `v90test` now sweeps all twelve starting offsets.
2. **Where training ends is exact, not heuristic.** An Sd repetition carries the
   zero symbol at intervals 1 and 4, and a data frame never can — the working
   constellation starts at Ucode 37. So "the first aligned group without zeros" is
   a collision-free discriminator for the start of data.

The hunt is a single forward pass over an only-advancing cursor: rescanning the
whole buffer per chunk is quadratic and, with a one-second answer tone in front of
Sd, slow enough to look like a hang.

### Startup — Phases 1, 3 and 4

Real V.90 has four phases: (1) V.8 CM/JM, (2) INFO0/INFO1 + line probing +
ranging, (3) equalizer training + digital impairment learning, (4) CP/MP exchange
+ TRN2d/B1d. All four are implemented. §9.2 is §11.2/V.34 with the two modems
renamed — clause for clause, every duration and every recovery bound — and §8.2
defines every signal by reference to §10.1.2/V.34, so it runs on V.34's step
machine and `V90Phase2.js` holds only what is V.90's: Table 7 (INFO0d) and Table 10
(INFO1a when V.90 is selected). Tables 8 and 9 ARE Table 14/V.34 and Table 15/V.34,
which the Recommendation states and `v90-phase2-check` verifies. The digital modem
plays the part §11.2 gives the CALL modem and the analogue modem the answer
modem's, which is the reverse of the V.34 roles — a real V.90 call confirms the
swap on the wire (`tools/datasource/Conexant-HCF-smooth-crescendo.wav`: the
answering modem sends tone B at 1200 Hz, the calling modem tone A at 2400 with the
1800 guard). Every phase's signals are now the Recommendation's, Phase 4 included.

**Phase 1 is a real V.8 exchange.** V.90 signals capability through bit **b5 of
the V.8 modn0 octet** ("PCM avail"), and §9.1.1/V.90 requires two more things
alongside it: "at least one bit shall be set in the V.90 availability category"
and "a modem that indicates V.90 capability shall indicate its PSTN access type
using a bit in the PSTN access category". Both are now sent. The originate side
declares analogue availability on an analogue access and the answer side digital
availability on a digital one — not a guess, but §9.1.1's own tie-break ("the
call modem shall become the analogue modem and the answer modem shall become the
digital modem"), which is the role split this class already made. V.8 §6.3 also
requires the V.34 availability bit whenever a V.90 availability bit is set, which
is honest here because V.90's upstream *is* V.34. When V.8 has run the class
suppresses its own answer tone (`setV8Complete`), because a second tone would land
during the peer's post-CJ training and trip its energy-onset acquisition.

**Phase 3 is transmitted in full, and measured not at all.** The digital modem
plays Sd, TRN1d, Jd, J′d and DIL in §9.3.1's order — which is Sd FIRST and TRN1d
after it, the reverse of what Figure 5's left-to-right labels suggest. Signals and
their sources:

- **TRN1d (§8.4.5)** — the U_INFO codeword with signs from binary ones through
  the GPC scrambler, zeroed first; 2040T, which is §9.3.1.4's minimum and already
  a whole number of six-symbol frames.
- **Jd (Table 13)** — 72 bits: 17-one sync, start bits at 17/34/51, a rate
  capability mask at 18:33 and 35:46 (one 4000/3 ladder from 28 000 at bit 18 to
  56 000 at bit 40, split by the start bit at 34; 41:46 reserved),
  constellation selects at 47/48, lookahead at 49:50, CRC at 52:67, fill 68:71.
  Scrambled, differentially encoded, carried as the *sign* of the U_INFO
  codeword, the encoder initialized from TRN1d's final symbol.
- **J′d (§8.4.3)** — twelve zeroes, same encoding, initialized from Jd's final
  symbol.
- **DIL (§8.4.1, descriptor Table 12)** — N segments, Lc = (Hc+1)×6 symbols,
  eight REFc reference codewords, a sign pattern and a training pattern of 1–128
  bits each restarted per segment, and the N training Ucodes. This modem requests
  N = 32 with every Hc = 127: 3.07 s in one pass, inside Figure 5's ≤5 s. The
  32 Ucodes sweep four per Uchord, because a probe that visits one chord is not a
  probe. L_SP = 11 and L_TP = 7 are coprime with six so the probe walks all six
  data frame intervals — the impairments DIL exists to find are per-interval.

**The analogue modem's Phase 3 is on the wire too, and §8.3 is why it was cheap.**
§8.3.2–.6 define MD, PP, S, SCR and TRN as "as defined in 10.1.3.x/V.34", so the
V.34 class's own Phase 3 segments serve directly — with the roles swapped, because
§9.3.2.1 gives the ANALOGUE modem the leading part that V.34 §11.3.1.2.1 gives the
answer modem (`setPhase3Lead`). Ja (§8.3.1) is the DIL descriptor's bits through
10.1.3.3/V.34's modulation, repeated; SCR (§8.3.5) is binary ones through the same
chain with neither scrambler nor differential encoder reinitialised, sent while
DIL is received to hold line energy up (the NOTE under §8.3.1). The placement is
§9.3.2.7 to §9.3.2.10: S until J′d, S̄ for 16T, SCR through DIL, then S for 128T
and S̄ for 16T to terminate it.

**Both ends now stop on signals rather than on shared constants.** §9.3.1.5
repeats Jd until it detects the analogue modem's §9.3.2.7 S; §9.3.1.6 ends DIL on
§9.3.2.10's S-to-S̄ transition, which is the THIRD the analogue modem sends and is
what the NOTE under §9.3.1.6 warns about counting. Going the other way, the
analogue modem detects the Sd-to-S̄d polarity flip inside Sd, hunts Jd's 17-one
frame sync, detects J′d's twelve zeroes, and locates the end of DIL by predicting
the probe it wrote the descriptor for. Nothing in Phase 3 is counted any more.

**U_INFO is Table 10/V.90 bits 25:31**, bounded greater than 66 there and at most
111 by §8.4.4 needing 16 + U_INFO to be a Ucode. The analogue modem chooses it —
Table 10 is its sequence — and sends it in INFO1a; the digital modem reads it and
derives §8.4.4's W from it, refusing a value outside the clause's range. 111 is
the choice, and 16 + 111 = 127 is the value Sd's W was hardcoded to before, so Sd
is unchanged while both ends now carry the number rather than share it.

`v90-phase3-check` asserts Tables 12 and 13 the way `v90-phase4-check` asserts 14
and 16 — literal positions before any round-trip. Table 12 gets extra scrutiny
because its layout is variable: every field after SP and TP moves with
α = ⌈L_SP/16⌉×17 and β = α + ⌈L_TP/16⌉×17, so it is checked at three pattern
lengths including the clause's maximum.

**Phase 4 is functionally load-bearing, not decorative.** CP genuinely determines
the downstream: the digital modem cannot encode a data frame until it arrives.

§9.4.1, the digital modem: **Ri** (≥192T, ending on a data frame boundary) until a
CPt is read → **R̄i** for exactly 24T → **TRN2d** (≥2040T) → **MP** until CP arrives
→ **MP′** until CP′ → a single **Ed** (§9.4.1.5) → **B1d**, 48 data frames of
scrambled ones, which is what arms the far end's UART → data. §9.4.2, the analogue
modem, on the upstream V.34's own Phase 4 stages: **CPt** until the R-to-R̄i
transition → optional SCR (not taken) → **CP** until the digital modem's MP → **CP′**
until MP′ or Ed → §8.5.3's 20-bit **E**. Every transition is the far end's signal.

**§8.6.4's NOTE is the design of the R detector**, not a footnote: "Neither R nor R̄
are differentially encoded. This imposes a requirement on the receiver to be able to
detect these sequences regardless of their polarity." R̄ inverts R at every position,
so what is tracked is the POLARITY of the period-6 pattern and the transition is a
change in it. A receiver keyed on absolute sign finds it at one polarity and misses
it at the other.

**TRN2d, MP, MP′ and Ed go through §5.4's encoder on CPt's constellation** (§8.6.5,
§8.6.3, §8.6.2) — not as a sign on one codeword — so both ends build a *training*
encoder from CPt and the analogue modem demodulates MP on training parameters
before it knows anything about data mode. Table 16's fill is "to the next multiple
of 6 symbols", which is one data frame, so the MP sequence length follows that
constellation's D. **CPt passes lₐ = 0** (Table 14 bits 49:50 are the analogue
modem's choice and §9.4.2.1 lets training differ from data): the shaper's lookahead
is a pipeline delay, and a non-zero one leaves Ed's last frames inside the encoder —
Ed being the signal that ends the phase. §8.5.1's "not greater than 3 dB" is
satisfied trivially here because CPt and CP carry the same constellation set.

- **CP (Table 14)** — 292 bits for one constellation: a 17-one frame sync, then
  17-bit groups (start bit 0 plus 16 payload bits). Fields at their literal
  positions: `19` CP/CPt, `20:24` drn (rate = (drn+20)·8000/6), `31:32` Sr, `33`
  acknowledge, `35` codec (0 = µ-law), `36:48` upstream rate capability mask,
  `49:50` lₐ, `52:67` TRN1d RMS ratio as unsigned Q3.13,
  `69:76`/`77:84`/`86:93`/`94:101` a₁/a₂/b₁/b₂ as signed Q1.6, `103:127` six
  4-bit constellation indices (with a start bit at 119 splitting intervals 3 and
  4), `128` constellations-differ, then eight 17-bit groups per constellation
  carrying the Uchord masks, then a CRC group and fill.
- **MP (Table 16), Type 0** — 90 bits: sync, `18` MP type, `24:27` drn (upstream
  rate = drn·2400, drn 2..14), `29:30` trellis select (0 = 16-state), `31`
  nonlinear encoder, `32` shaping select, `33` acknowledge, `36:49` capability
  mask, CRC, fill to a multiple of 6.

`v90-phase4-check` asserts the frame sync and every table-named start bit at its
literal position, and that the documented field positions decode what was encoded
— **not** merely that the sequence round-trips, since a self-consistent
encoder/decoder pair will happily agree on a wrong layout. It also confirms all
400 single-bit corruptions are caught by the CRC.

Ordering note: CP must be queued at construction, not on the upstream V.34's
`ready` event, because on the analogue side that event never fires. Ja no longer
shares that channel — §9.3.1.3 makes the digital modem's whole Phase 3 conditional
on having received the descriptor, and it now arrives as a Phase 3 signal, before
the byte channel exists at all. That ordering is still why MP and the coder are
set up where data begins rather than at the Sd transition: the coder does not
exist until CP builds it, and Ja arrives first. `_installPhase3Tail()` runs at the
END of V90's constructor, because it sets `_dil` and the downstream-state block
still clears it.

### Data path over the downstream

Bytes ride the project's async UART framing over a continuously scrambled stream,
using the same role-asymmetric GPC/GPA scramblers as V.32/V.32bis/V.34 (V.90 §6.5
references V.34's). Idle is mark, so the descrambled idle stream yields no start
bit and no phantom bytes while the codeword stream runs continuously. Downstream
TX level is full-amplitude PCM (RMS ≈ 0.37, peak 0.98), unlike the ~0.1 RMS of
the modulated protocols — correct, because the codewords *are* the samples.

### Deliberately out of scope (documented, not hidden)

- **No INFO0d/INFO1d, no line probing, no ranging** (§9.2). U_INFO, the upstream
  symbol rate and the MD length are negotiated now, and the DIL descriptor is the
  analogue modem's own choice as §8.4.1 leaves it. The measurements those signals
  feed are still a no-op on this transport: INFO1d's projected rates and INFO1a's
  frequency offset are declared from what each end can run rather than from
  anything measured, which is the same division Phase 3 makes for DIL.
- **DIL is transmitted but nothing is learned from it.** The probe is faithful;
  the receiver that would measure a digital impairment from it does not exist,
  because on this transport there is none to measure. A later interop receiver
  adds a measurement behind a transmitter that is already real.
- **No robbed-bit-signalling detection, no digital-pad detection, no PCM-law
  auto-detection.** CP selects the codec and we answer µ-law.
- **No analogue-loop equalizer, no timing tracking.** Symbols are samples.
- **The DIL descriptor's free parameters are ours and are audibly wrong.** §8.4.1
  states no ordering and no power constraint, so the ascending Uchord order and the
  per-chord REFc are legal — but together they make the downstream sweep 58 dB
  monotonically across DIL where a real call's is flat. Content and format are the
  Recommendation's; the choice is not the one a real modem makes.
- **The CRC is fully transcribed, Figure 14 included.** V.34 §10.1.2.3.2, which
  V.90 defers to: generator x¹⁶+x¹²+x⁵+1, register preset to all ones, covering
  every information bit *except* the frame sync, start and fill bits, remainder
  emitted as-is — neither inverted nor reversed — bit 0 (the LSB) first. Figure 14
  gives the orientation the clause does not restate: sixteen stages numbered 15
  down to 0 with the information bit entering at stage 0 and the feedback reaching
  stages 15, 10 and 3, which is the LSB-first register and `0x8408`, the bit
  reversal of `0x1021`. It had been the MSB-first form, which no round trip could
  see because both ends compute with the same generator.
- **Power.** A real digital modem is bound by Table 15 and, in the US, by the FCC
  limit that capped real connections at **53 333 bit/s (D = 40)**. We run D = 42
  for a true 56 000 because this transport has no regulatory or hybrid constraint.

### For real-modem interop

Beyond undoing the scope-outs: add RBS and digital-pad detection, honour the Table
15 power limits (which caps the achievable rate below 56 000 on a real US line),
and support A-law. Every phase's signals are now on the wire in the Recommendation's
order, so what is left is MEASUREMENT rather than transmission — line probing
analysis, ranging, and impairment learning from the DIL the digital modem already
sends. Untested against real V.90 hardware.

---

## 9. Handshake / registry integration

### Which protocols negotiate via V.8

| Protocol | V.8 |
|---|---|
| V.21, V.22, V.22bis, V.23 | **Real V.8** — ANSam → CM → JM → CJ → 75 ms post-CJ silence |
| V.32, V.32bis, V.34, **V.90** | **Real V.8** |
| Bell 103 | Bypassed (`wantBell103`) — Table 2/V.8 has no bit for it, so the exchange could only ever no-deal; see §2 |
| V.29 | Bypassed (`wantV29`) — half-duplex ping-pong with its own audible connect script |

V.8's modulation-mode octets already carried every bit needed: `modn0` b6 = V.34,
b5 = "PCM avail" (**this is how V.90 signals capability**), `modn1` b0 = the
V.32/V.32bis family. A V.90 dial additionally sends the **PSTN access** and
**V.90 availability** category octets, which §9.1.1/V.90 requires alongside b5 —
see §8's startup notes. Note the tag for the V.90 availability category is Table
2/V.8's `0 1 1 0`; Table 5/V.8 prints `1 1 1 0`, which is T.66's tag, and two
categories cannot share one. → PROVENANCE.md §3.

**`setV8Complete(done)` is the contract.** A protocol that emits its own 2100 Hz
answer tone must suppress it when V.8 already ran — the ANSam has been heard, and
a second tone lands during the peer's post-CJ training and trips its energy-onset
acquisition. `Handshake._selectProtocol` calls it on any protocol that defines it,
passing whether the V.8 path was taken.

Note V.8 has a single bit for the **V.32/V.32bis family**, exactly as it has one
for V.22/V.22bis. Both ends resolve which of the two from their own preference
list, so they agree. That is how V.8 works, not a shortcut.

### To add or wire a protocol (`Handshake.js`)

1. `require('./protocols/<Name>')`, add to the `PROTOCOLS` map.
2. Decide V.8 or bypass. **Prefer V.8** — it is the authentic path and is proven
   for both self-training and PCM protocols. Map the name in
   `V8.selectProtocol`, advertise its bit in `V8Sequencer._buildModes`, and add a
   `setV8Complete()` if the class emits its own answer tone.
3. Add the name to the event-driven `ready` branch.
4. Add the name to `server.js` `PROTOS` (whitelist — otherwise it silently falls
   back to V.21), the `<select id="protocol">` in `public/index.html`, and
   `MS_COMMANDS` in `public/main.js`.
5. `npm run build`, run the browser-path safety check, test.

`ready`/`connected` for the self-training protocols means "acquired the peer's
carrier" — event-driven, no wall-clock CD gate. For V.90 the digital modem is
ready only once CP has arrived **and** the upstream carries data.

---

## 10. Rate / capability summary

| Protocol | Rate | Modulation | Duplex | Carrier | Genuine level | Real-HW gap |
|---|---|---|---|---|---|---|
| V.21 / Bell103 | 300 | FSK | split-band | — | full | — |
| V.22 | 1200 | DPSK | split-band | — | spandsp port | mag-only detect, caller-lead |
| V.22bis | 2400 | 16-QAM | split-band | — | spandsp port | caller-lead training |
| V.23 | 1200/75 | FSK | split-speed | — | full | — |
| V.29 | 9600 | 16-QAM | half-duplex ping-pong | 1700 Hz | genuine minimal | equalizer + timing tracking |
| V.32 | 9600 | uncoded 16-QAM | full-duplex | 1800 Hz | genuine minimal | equalizer, timing, echo cx |
| V.32bis | 14400 | trellis 128-QAM | full-duplex | 1800 Hz | genuine minimal | Viterbi, equalizer, timing, echo cx, multi-rate |
| V.34 | 19200–33600 | shell-mapped trellis QAM | full-duplex | 1800/1920/1959 Hz | genuine minimal | precoder, Viterbi, equalizer, timing, line probing |
| **V.90** | **56000 down / 33600 up** | **PCM codeword selection down, V.34 up** | **asymmetric** | **none (symbols are samples)** | **genuine minimal** | **RBS + digital pad, Table 15 power, DIL measurement** |

V.90's row has no carrier because it has no modulation downstream. Its "genuine
minimal" is a different shape from the others — the hard part is the mapper, not
the receiver.

---

## 11. Backporting to synthmodem for real-modem use

Each of V.29/V.32/V.32bis/V.34/V.90 needs, roughly in order of importance:

1. **Adaptive equalizer + continuous timing recovery.** The acquire-once/free-run
   receiver assumes zero clock drift and a flat channel. Real lines need a
   fractional (T/2) adaptive equalizer and a timing-tracking loop. The V.22bis
   spandsp port already has both — that is the reference to lift.
2. **Echo canceller (V.32/V.32bis only).** On 2-wire the shared 1800 Hz carrier
   requires cancelling your own transmit from your receive. This is the hardest
   single component; the AC/CA phase-reversal segments exist to train it.
3. **The echo-canceller segments.** The rest of the start-up is no longer a gap:
   V.32/V.32bis run §5.2's conditioning signal and §5.3's own 16-bit rate signals,
   and the invented `DLE 'R' hi lo` rate frame that used to stand in for them is
   gone. What a 2-wire line still needs is the AC/CA phase-reversal segments that
   train the canceller in item 2.
4. **Viterbi decoder (V.32bis, and V.32 TCM mode).** Here Y0 is transmitted but
   sliced away. At 14400 the subset assignment is now Figure 2-1's, so the
   decoder's parallel-transition structure has the map it needs; the other rates
   would need Figures 2-2/2-3 transcribed first.
5. **Multi-rate + rate renegotiation (V.32bis §8).** Wire the 12000/9600/7200/4800
   constellations and the change-rate-without-retrain procedure. The rate signal
   already advertises the full set.
6. **V.8 negotiation — done.** V.29 and Bell 103 bypass, both deliberately and
   for different reasons: V.29 is half-duplex with its own connect script, and
   V.8 has no modulation bit for Bell 103 to advertise. Note Bell 103's answer
   side has NOT been seen by hardware in this shape — synthmodem validated it
   with V.8 attempting and failing over first.
