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
- **Differential encoding (§5):** Q1Q2 differentially encoded into Y1Y2
  (quadrant) by modulo-4 recursive addition, `Yₙ = (Yₙ₋₁ + ((Q2<<1)|Q1)) mod 4`;
  Q3Q4 select the point within the quadrant. Rotationally invariant. The decoder
  inverts: slice to grid, quadrant from signs, un-rotate for Q3Q4,
  `(Yₙ−Yₙ₋₁) mod 4` for Q1Q2.
- **Scramblers (§7), role-asymmetric, self-synchronising:** call-mode
  `GPC = 1+x⁻¹⁸+x⁻²³`, answer-mode `GPA = 1+x⁻⁵+x⁻²³`. Each end scrambles TX with
  its OWN polynomial and descrambles RX with the PEER's. **Bit-exact-verified
  against the V.32bis §5.2.3 golden vector.**
- **R1/R2/R3-style rate-signal exchange** that round-trips (`peerRate === 9600`
  both sides).
- **Audible startup:** answer tone → AA QAM training → acquirable timing/gain
  preamble. Since V.32 now negotiates through real V.8, **that answer tone is
  suppressed on the V.8 path** and kept only for the forced/legacy path.

**Full-duplex without an echo canceller** is the architectural win: real V.32 on
2-wire PSTN needs adaptive echo cancellation, and the 4-wire-equivalent transport
removes it. The idle-`0xFF` flood that forced V.29 to ping-pong is avoided the
honest V.32 way — V.32 is a **synchronous scrambled** modem (idle = scrambled
MARK) with async UART framing on top, so descrambled idle-mark yields no start
bit and therefore no phantom bytes while the carrier stays continuously up.

**Receiver is acquire-once, free-run:** one complex channel-gain estimate from
SEG_B holds all session, valid because the shared 8 kHz clock has zero drift.
Memory is bounded — the RX buffer is trimmed with `rxBase` advanced, and TX uses
a monotonic sample counter `txN` with a separate `txSymBase`, so trimming never
jumps the carrier phase.

### Deliberately out of scope (documented, not hidden)

- **No TCM / trellis** (that is V.32bis). Non-redundant 16-QAM only.
- **No adaptive equalizer / no timing tracking** — sound only on the zero-drift
  shared clock.
- **AC/CA echo-canceller-training segments omitted.** Untested against real V.32
  hardware.

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
- **Rate signal (§5.3 / Table 5):** genuine bit positions — `B5=4800, B6=9600,
  B9=7200, B10=12000, B12=14400` plus the sync/framing bits, carried as a 16-bit
  word in a `DLE 'R' hi lo` control frame; the receiver selects the highest
  advertised rate. Verified `peerRate === 14400` both sides.

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
- **AC/CA echo-canceller-training omitted.** Untested against real hardware.
- **Fallback constellations (Figures 2-2..2-5) not yet transcribed** — only
  Figure 2-1 (14400) has been. They are readable by the same route.
  → PROTOIMPROVE.md.

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

- **Symbol rate + carrier (Tables 1–2):** 2400 baud / 1800 Hz (19200), 3200 /
  1920 Hz (28800, 31200), 3429 / 1959 Hz (33600). 8 kHz clock ⇒ 2.5 SPS at 3200,
  2.33 at 3429. The 3429 occupied band is razor-thin — lower edge ≈ 4 Hz — but
  sound on a lossless link; carrier 1800 folds the lower sideband through DC and
  fails.
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
- **No line probing / INFO exchange (Phase 2), no non-linear warping (§9.7), no
  adaptive equalizer or timing tracking, simplified startup** (acquirable
  preamble instead of the S/Ŝ/PP/TRN/MP/E/J segment machine) — though **Phase 1
  is a real V.8 exchange** (§9) — **no superframe bit-inversion sync (V0=0)**,
  **no auxiliary channel**, **single rate per call**.

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
- **MP's carriage is not genuine.** A real MP is modulated by Phase 4 signalling
  (4- or 16-point constellation keyed to signal J). Here the 88-bit sequence is
  packed into 11 bytes and carried in the existing DLE control channel over the
  running link. Content bit-exact to Table 20, carriage not — the same honest gap
  V.90's CP/MP has, for the same reason. MP Type 1 (Table 21, precoder
  coefficients) is not built: there is no precoder on this link.
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

### Startup — Phases 1 and 4 are both genuine

Real V.90 has four phases: (1) V.8 CM/JM, (2) INFO0/INFO1 + line probing +
ranging, (3) equalizer training + digital impairment learning, (4) CP/MP exchange
+ TRN2d/B1d. Phases 2–3 measure a channel this transport does not have. The two
that carry information are implemented.

**Phase 1 is a real V.8 exchange.** V.90 signals capability through bit **b5 of
the V.8 modn0 octet** ("PCM avail"), which this repository's V.8 already built and
decoded — only the mapping was missing. When V.8 has run the class suppresses its
own answer tone (`setV8Complete`), because a second tone would land during the
peer's post-CJ training and trip its energy-onset acquisition.

**Phase 4 is functionally load-bearing, not decorative.** CP travels upstream over
the established V.34 link and genuinely determines the downstream: the digital
modem sits silent until it arrives because it does not know what to transmit.

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
`ready` event, because on the analogue side that event never fires.

### Data path over the downstream

Bytes ride the project's async UART framing over a continuously scrambled stream,
using the same role-asymmetric GPC/GPA scramblers as V.32/V.32bis/V.34 (V.90 §6.5
references V.34's). Idle is mark, so the descrambled idle stream yields no start
bit and no phantom bytes while the codeword stream runs continuously. Downstream
TX level is full-amplitude PCM (RMS ≈ 0.37, peak 0.98), unlike the ~0.1 RMS of
the modulated protocols — correct, because the codewords *are* the samples.

### Deliberately out of scope (documented, not hidden)

- **No INFO0/INFO1, no line probing, no ranging, no digital impairment learning**
  (Phases 2–3). All measure or repair a network segment this transport lacks.
- **No robbed-bit-signalling detection, no digital-pad detection, no PCM-law
  auto-detection.** CP selects the codec and we answer µ-law.
- **No analogue-loop equalizer, no timing tracking.** Symbols are samples.
- **CP/MP transport.** The bit layouts are genuine, but the finished sequences are
  packed into bytes and carried over the already-established link rather than
  being modulated by the Phase 4 signalling. The *content* is bit-exact to the
  tables; the way it crosses the wire is not.
- **CRC register orientation.** V.34 §10.1.2.3.2, which V.90 defers to, has now
  been transcribed: generator x¹⁶+x¹²+x⁵+1, register preset to all ones, covering
  every information bit *except* the frame sync, start and fill bits, remainder
  emitted as-is — neither inverted nor reversed — bit 0 (the LSB) first. All of
  that is honoured. The clause does not restate the register's shift direction,
  which lives only in its Figure 14. That figure refused the WebFetch route; it
  has not been retried by the PDF-to-HTML route that recovered Figure
  2-1/V.32bis. The MSB-first form is the one remaining unverified degree of
  freedom.
  → PROTOIMPROVE.md.
- **Power.** A real digital modem is bound by Table 15 and, in the US, by the FCC
  limit that capped real connections at **53 333 bit/s (D = 40)**. We run D = 42
  for a true 56 000 because this transport has no regulatory or hybrid constraint.

### For real-modem interop

Beyond undoing the scope-outs: implement the Phase 2–3 state machine, add RBS and
digital-pad detection, carry CP/MP in the real Phase 4 signalling rather than as
bytes, settle the CRC register orientation against V.34 Figure 14, honour the Table 15
power limits (which caps the achievable rate below 56 000 on a real US line), and
support A-law. Untested against real V.90 hardware.

---

## 9. Handshake / registry integration

### Which protocols negotiate via V.8

| Protocol | V.8 |
|---|---|
| V.21, V.22, V.22bis, V.23 | **Real V.8** — ANSam → CM → JM → CJ → 75 ms post-CJ silence |
| V.32, V.32bis, V.34, **V.90** | **Real V.8** |
| Bell 103 | Attempts V.8, times out at CJ, falls back via the V.25 legacy automode probe — correct, since Bell 103 predates V.8 |
| V.29 | Bypassed (`wantV29`) — half-duplex ping-pong with its own audible connect script |

V.8's modulation-mode octets already carried every bit needed: `modn0` b6 = V.34,
b5 = "PCM avail" (**this is how V.90 signals capability**), `modn1` b0 = the
V.32/V.32bis family.

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
| V.34 | 19200–33600 | shell-mapped trellis QAM | full-duplex | 1800/1920/1959 Hz | genuine minimal | precoder, Viterbi, equalizer, timing, line probing, MP carriage |
| **V.90** | **56000 down / 33600 up** | **PCM codeword selection down, V.34 up** | **asymmetric** | **none (symbols are samples)** | **genuine minimal** | **Phase 2–3, RBS + digital pad, CP/MP signalling transport, CRC register orientation, Table 15 power** |

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
3. **Full standard handshake segments.** The startup here keeps the recognizable
   shape but omits the echo-canceller segments and uses an in-band control-byte
   rate exchange rather than the exact Figure 3/V.32bis segment timings.
4. **Viterbi decoder (V.32bis, and V.32 TCM mode).** Here Y0 is transmitted but
   sliced away. At 14400 the subset assignment is now Figure 2-1's, so the
   decoder's parallel-transition structure has the map it needs; the other rates
   would need Figures 2-2/2-3 transcribed first.
5. **Multi-rate + rate renegotiation (V.32bis §8).** Wire the 12000/9600/7200/4800
   constellations and the change-rate-without-retrain procedure. The rate signal
   already advertises the full set.
6. **V.8 negotiation — largely done.** Only V.29 still bypasses.
