# SynthLink — Protocol Implementations

Exact scope of every modulation SynthLink implements: what is genuine ITU/Bell,
what is simplified or non-standard, the handshake, and what each would need to
interwork with a **real modem**. Written with an eye to eventually backporting
the new protocols (V.29/V.32/V.32bis) into **synthmodem** for real-line use.

Source files: `vendor/src/dsp/protocols/*.js`. Registry + handshake wiring:
`vendor/src/dsp/Handshake.js`. Top-level pump: `vendor/src/dsp/ModemDSP.js`.

---

## 0. Transport assumptions (why "genuine minimal" is valid here)

Every protocol below runs over the SynthLink transport, **not** a phone line.
That transport is:

- **Lossless.** Modulated Int16 PCM @ 8 kHz crosses a WebSocket. No additive
  noise, no fading, no non-linear distortion (only Int16 quantisation).
- **A 4-wire equivalent.** The two WebSocket directions are independent. Each
  direction carries exactly one carrier; none of a modem's own transmit leaks
  into its receive. **This removes the need for an echo canceller** — the single
  hardest component of full-duplex V.32/V.32bis.
- **Shared, drift-free clock.** Both ends sample at a nominal 8 kHz with zero
  relative drift. A receiver that acquires symbol timing once can free-run
  forever without tracking.

These three facts are what let the newer receivers be **"genuine minimal"**:
real modulation / encoding / scrambler + a real-enough training handshake, but
**without** an adaptive equalizer, continuous timing tracking, echo canceller, or
Viterbi decoder. On a real line all four come back (see §9, Backporting).

**Clean-link config relaxations** (`vendor/synthlink-config.js`, applied to BOTH
server and browser bundle; defaults preserved for other consumers of the DSP):

| Flag | Effect | Why safe here / what it hides |
|---|---|---|
| `skipCdVerification=true` | Skips Handshake's post-training wall-clock carrier-detect stability gate | That gate is a phone-line-noise filter; it can't latch under browser main-thread contention on a lossless link. |
| `v22MagOnlyDetect=true` | V.22/V.22bis detect on matched-filter magnitude, dropping the answer-side anti-V.32-AA spectral test | That spectral test can never pass against a guard-tone-emitting peer; there are no V.32 automode signals to guard against here. |
| `cdStableMs=120`, `listenWindowMs=12000` | Relaxed CD-gate params | Only used if `skipCdVerification` were false; kept for reference. |
| `protocolPreference`/`v8ModulationModes` | Per-call protocol select | Default `['V21']`; server sets from the dial message, client from the dropdown, just before DSP construction. |

None of these are valid against real phone lines / real modems.

---

## 1. Common DSP machinery

- **Async start/stop (UART) framing** on all protocols. Each byte = start(0) +
  8 data bits LSB-first + stop(1); between bytes the line is mark (1). No V.42,
  no error correction, no compression — raw async, like a modem in direct mode
  (`AT\N0`). Idle (mark) therefore emits **no bytes**: this is what stops an idle
  scrambled carrier from flooding the peer with `0xFF`.
- **Fractional-SPS RRC + matched filter** (V.29/V.32/V.32bis). 2400 baud at 8 kHz
  = 3.333 samples/symbol, handled by continuous root-raised-cosine synthesis
  (rolloff 0.25, span 10) and a fractional matched filter that samples at the
  true (non-integer) symbol instants. First proven in `tools/v29-stream.js`.
- **Preamble acquisition** (V.29/V.32/V.32bis): energy onset → fractional
  symbol-timing lock (maximise alternating-segment energy) → alternating→constant
  frame-sync boundary → complex channel-gain (or gain+phase) seed → decode.
  Preamble = `SEG_A` alternating symbols (timing/AGC) + `SEG_B` constant symbols
  (the gain/phase reference and the frame-sync marker).

---

## 2. FSK protocols — V.21, Bell 103, V.23

| | V.21 | Bell 103 | V.23 |
|---|---|---|---|
| Rate | 300 bps | 300 bps | 1200/75 split |
| Modulation | FSK, split-band duplex | FSK | FSK, asymmetric split-speed |
| Source | `protocols/V21.js`, `FskCommon.js` | `protocols/Bell103.js` | `protocols/V23.js` |

Genuine FSK. These are the fastest and most robust to acquire on this link.
V.21 is the config default and the fallback when a requested protocol isn't in
the server whitelist. **V.21 is slow (300 bps):** a ~185-byte banner alone is
~6 s, so full banner+echo tests sit near the harness time budget and can flake —
see CLAUDE.md time-budget note.

Provenance: FSK cores are synthmodem native (not spandsp ports).

---

## 3. V.22 / V.22bis — 1200 / 2400 bps DPSK/QAM

- **V.22** 1200 bps DPSK; **V.22bis** 2400 bps 16-QAM (with a V.22 fallback path).
- Source: `protocols/V22.js` (both classes), `V22Common.js`, `V22Demodulator.js`,
  `V22RxRRC.js`. **These are JavaScript ports of spandsp** (`v22bis_rx.c`,
  `v22bis_tx.c`) — see PROVENANCE.md.
- V.22bis is the **UI default** (`index.html` `<select>` has it `selected`).

### Non-standard / clean-link adaptations (hard-won; don't regress)
The spandsp DSP was only ever exercised as the **answer** side against real
hardware. Making the **originate** side work JS↔JS required:

1. **Guard tone made answerer-only.** Per V.22bis §2.2 the 1800 Hz guard tone
   belongs to the answerer (high channel) only; it was hard-coded on for both
   roles, which defeated the peer's carrier detector. Fix: `guardTone: isAnswer`
   in both the `V22` and `V22bis` constructors.
2. **Mag-only remote detection** (`v22MagOnlyDetect`). The answer-side detector
   required carrier-bin energy > 3× the 1800 Hz ghost bin — impossible against a
   guard-tone-emitting peer. Fix drops the spectral test, detects on matched-
   filter magnitude. Applied in both `V22._trackRxDetection` and
   `V22bis._trackRxDetection`.
3. **Caller-lead training** (V.22bis §6.3.1.2.1). Originate (caller) training was
   never implemented in spandsp — it fell through to the answer flow. Fix: in
   `V22bis._advanceHandshake` case `U11`, for `role !== 'answer'`, once
   `_remoteDetected`, proactively call `_onS1Detected('originate-lead')`. The
   answerer stays reactive.

### For real-modem interop
These already interwork with real V.22/V.22bis hardware on the answer side (that
is what spandsp was built for). The originate-lead path (#3) and the mag-only
detect (#2) are clean-link shortcuts that would need re-checking against the full
spandsp detection logic on a noisy line.

---

## 4. V.29 — 9600 bps, half-duplex ping-pong

Source: `protocols/V29.js`. Prototypes: `tools/v29-proto.js` (batch),
`tools/v29-stream.js` (streaming, the basis for the class).

### Genuine
- Real V.29 **16-point constellation** (spandsp point ordering): two amplitude
  rings (3/5 on-axis, √2 / 3√2 diagonal).
- Real V.29 **encoding**: differential **phase** (Q2 Q3 Q4 → phase change per the
  §4 table) + absolute **amplitude** (Q1). 2400 baud × 4 bits = 9600 bps.
- Real V.29 **scrambler** `1 + x⁻¹⁸ + x⁻²³` (self-synchronising).
- **1700 Hz carrier**, 2400 baud, fractional-SPS RRC + matched filter (rolloff
  0.25).
- **Async start/stop UART framing** (genuine, in the DSP).

### Non-standard / deliberate design choices
- **Half-duplex ping-pong** (Hayes "Express 96" style), NOT full-duplex. V.29 is
  a half-duplex modem; full-duplex 9600 on 2-wire needed the echo cancellation
  that arrived with V.32. Consumer 9600-over-V.29 buffered locally, blasted a
  burst one way, then turned the line around. We emulate that: carrier present
  only during a data burst; receiver **re-acquires per burst**; idle is silence.
  (We *could* run full-duplex on our 4-wire transport — the previous version did
  — but a continuous full-duplex V.29 carrier with no framing floods the peer
  with descrambled idle `0xFF`; ping-pong is the honest consumer representation
  and the clean fix. V.32 later solved full-duplex properly, see §6.)
- **Burst/turnaround params:** `MAX_BURST_BYTES=256` (long transfer → train of
  bursts), `TURNAROUND_GUARD≈45 ms` silence after each burst (lets the peer
  squelch-reset and re-acquire — without it back-to-back bursts merge and only
  the first decodes), `KEEPALIVE_GAP≈1.2 s` (preamble-only keepalive so the peer
  RX and the ModemDSP silence-hangup timer never see a dead line).
- **Audible connect handshake** (`_buildConnectScript`): answerer emits a ~1 s
  2100 Hz V.25 answer tone → both emit a ~250 ms training burst (`longtrain`) →
  the short `lock` preamble the receiver actually acquires on. The tone and
  longtrain are **non-syncing** pre-roll: neither presents an alternating→constant
  frame-sync boundary, so the peer's squelch discards each on the `CONNECT_GAP`
  silence that follows and only `lock` syncs. This is why the tone lives in
  `V29.js`, not in the Handshake ANS path — a bare 2100 Hz run straight into
  training would trip the peer's energy-onset acquisition.
- **Receiver is "genuine minimal":** differential-coherent per-burst acquisition
  front-end, **no adaptive equalizer, no continuous timing tracking**. Fine for a
  burst receiver on a drift-free link (a clean burst to re-acquire every turn).

### Handshake wiring
`Handshake.start()` has a `wantV29` bypass (before the V.8 path) routing both
roles straight to `_selectProtocol('V29')` — V.29 isn't V.8-negotiable and the
Handshake layer must not emit its own ANS tone. `ready` == "acquired the peer's
carrier"; no wall-clock CD gate. Memory is naturally flat (short bursts, RX
buffer cleared per burst; carrier phase from a per-burst sample index).

### For real-modem interop
Add an adaptive equalizer + continuous timing tracking (the V.22bis spandsp T/2
equalizer is the reference). Untested against a real V.29 modem.

---

## 5. V.32 — 9600 bps, true full-duplex 16-QAM

Source: `protocols/V32.js`. Test: `tools/v32test.js`.

### Genuine (verified against ITU-T V.32)
- **1800 Hz** carrier, **2400 baud**, **non-redundant (uncoded) 16-QAM** on the
  `{±1,±3}²` grid, 4 bits/symbol = 9600 bps.
- **Differential encoding (§5):** Q1Q2 (the two MSBs of each 4-bit group)
  differentially encoded into Y1Y2 (quadrant) by modulo-4 recursive addition:
  `Yₙ = (Yₙ₋₁ + ((Q2<<1)|Q1)) mod 4`; Q3Q4 select the point within the quadrant
  (absolute). Rotationally invariant — a whole-constellation rotation by any
  multiple of 90° cancels in the differential decoder. Decoder inverts: slice to
  grid, quadrant from signs, un-rotate to quadrant-I for Q3Q4, `(Yₙ−Yₙ₋₁) mod 4`
  for Q1Q2.
- **Scramblers (§7), role-asymmetric, self-synchronising:** call-mode
  `GPC = 1+x⁻¹⁸+x⁻²³` (taps at register indices 17,22), answer-mode
  `GPA = 1+x⁻⁵+x⁻²³` (taps 4,22). Each end scrambles TX with its OWN polynomial,
  descrambles RX with the PEER's (`originate` TX=GPC/RX=GPA; `answer` mirror).
  Self-sync — descrambler converges within 23 bits (WARMUP_BITS covers it).
  **Bit-exact-verified against the V.32bis §5.2.3 golden vector** (shared
  scrambler): scrambling ones with GPC from zero → `11 11 11 11 11 11 11 11 11 00
  00 01…`, states `CCCCCCCCCAAACCC`.
- **R1/R2/R3-style rate-signal exchange** that round-trips (each end announces
  9600 and reads the peer's — verified `peerRate === 9600` both sides).
- **Audible startup:** 2100 Hz answer tone → harsh AA QAM training → acquirable
  timing/gain preamble (same non-syncing pre-roll pattern as V.29).

### The key architectural win: full-duplex without an echo canceller
Real V.32 is full-duplex on one shared 1800 Hz carrier per direction, which on
2-wire PSTN needs adaptive echo cancellation — the hardest part of a V.32 build.
Our 4-wire-equivalent transport removes it, so we keep **genuine full-duplex**.
The idle-`0xFF` flood that forced V.29 to ping-pong is avoided the honest V.32
way: V.32 is a **synchronous scrambled** modem (TX always emits scrambled bits;
idle = scrambled MARK), with async UART framing on top — so descrambled idle-mark
yields no start bit → no phantom bytes, while the carrier stays continuously up
(true full-duplex idle fill).

### Receiver (acquire-once, free-run)
Energy onset → maximise SEG_A energy for fractional symbol phase `base` → find
SEG_A→SEG_B alt→const boundary (frame sync) → estimate **complex channel gain g**
(mag+phase) from SEG_B (`received ≈ g·(3,3)`). Then free-run: sample each symbol
at `base + symIdx·SPS`, derotate/normalise by `conj(g)/|g|²`, slice, differential-
decode, descramble, UART-deframe. Valid because the shared 8 kHz clock has zero
drift — one estimate holds all session. **Bounded memory:** RX buffer trimmed
(front spliced, `rxBase` advanced); TX uses a monotonic sample/phase counter
`txN` (never decremented) with a separate `txSymBase`, so trimming never jumps
the carrier phase.

### Deliberately out of scope (documented, not hidden)
- **No TCM / trellis** (that is V.32bis, §6). Non-redundant 16-QAM only.
- **No adaptive equalizer / no timing tracking** — acquire-once/free-run, sound
  only on the zero-drift shared clock.
- **AC/CA echo-canceller-training segments omitted** (train the canceller the
  transport removes). Untested against real V.32 hardware.

---

## 6. V.32bis — 14400 bps, true full-duplex trellis-coded 128-QAM

Source: `protocols/V32bis.js`. Test: `tools/v32bistest.js`. Built directly on the
V.32 core — same 1800 Hz carrier, 2400 baud, scramblers, acquisition, continuous
full-duplex framing, RX/TX trimming, and audible connect script. Only the
per-symbol bit→point path and the rate signal differ.

### Genuine (verified against ITU-T V.32bis, 1991)
- **6 data bits/symbol at 2400 baud = 14400** (§2.3.1). Scrambled stream grouped
  Q1..Q6 (Q1 first in time).
- **Table 1/V.32bis differential** (exact, extracted from the spec — the
  trellis-coding variant, distinct from the 4800 Table 2):
  `din=(Q1<<1)|Q2`, `y=(Y1<<1)|Y2`,
  `TAB1[din][yPrev]=yNew` = `[[0,1,2,3],[1,0,3,2],[2,3,1,0],[3,2,0,1]]`.
  Decoder inverts it (`INV1`, built programmatically).
- **Convolutional encoder → Y0** (Figure 1): an 8-state systematic FSM driven by
  Y1,Y2 emits the redundant bit Y0 (see caveat below).
- **128-point cross constellation** (Figure 2-1): odd-integer grid
  `{±1,±3,±5,±7,±9,±11}²` minus the 16 outer corners (`|i|≥9 && |q|≥9`) = 128
  points. The 7 coded bits `Y0Y1Y2Q3Q4Q5Q6` index it.
- **Scramblers GPC/GPA** (§4): identical to V.32; **golden-verified** against
  §5.2.3 (see §5 above).
- **Rate signal (§5.3 / Table 5):** genuine Table 5 bit positions — `B5=4800,
  B6=9600, B9=7200, B10=12000, B12=14400` plus the B4/B7/B8/B11/B15 sync/framing
  bits, carried as a 16-bit word in the `DLE 'R' hi lo` control frame; receiver
  selects the highest advertised rate (`rateFromWord`) → 14400. Verified
  `peerRate === 14400` both sides.

### Per-symbol pipeline
- **TX** (`_dataSymbol`): six scrambled bits via `_txBit` → `din=(Q1<<1)|Q2` →
  `txPrevY=TAB1[din][txPrevY]` → `Y0=convEncode(Y1,Y2)` →
  `idx=(Y0<<6)|(Y1<<5)|(Y2<<4)|(Q3<<3)|(Q4<<2)|(Q5<<1)|Q6` → `C128[idx]`.
- **RX** (in `_process`): matched-filter symbol → derotate/normalise by `g` (from
  SEG_B, `REF=(7,7)`) → `slicePoint` to nearest 128-cross point → `IDX` → 7 bits
  → `din=INV1[rxPrevY][yNew]` → Q1Q2, plus Q3..Q6 → six scrambled bits →
  descramble → UART deframe. **Y0 is read and discarded.**

### Deliberately out of scope (documented, not hidden)
- **No Viterbi decoder.** Y0 is genuinely produced and on the wire (real
  trellis-coded modulation), but on a lossless link the ~4 dB coding gain is
  unused, so the RX **slices** and reads the bits back directly. **Consequence:**
  the exact Figure 2-1 set-partition/subset assignment isn't needed for
  correctness, so the 7-bit→point map is a **self-consistent bijection over the
  correct 128-cross set** (not a byte-for-byte copy of Figure 2-1), and
  `convEncode` is a **genuine 8-state FSM of the V.32 family** (not an
  independently golden-verified Wei code). Data integrity is unaffected — the RX
  reads back exactly the transmitted point.
- **No adaptive equalizer / no timing tracking** (as V.32).
- **Single operating rate (14400).** The rate signal genuinely advertises the
  full set and negotiates the max, but only 14400 is wired for data. The
  12000/9600/7200/4800 fallbacks (Figures 2-2..2-5) and §8 rate-renegotiation-
  without-retrain are the documented next step.
- **AC/CA echo-canceller-training omitted.** Untested against real V.32bis
  hardware.

---

## 7. V.34 — 28800 bps, true full-duplex shell-mapped trellis-coded QAM

Source: `protocols/V34.js` + `protocols/V34Mapper.js`. Tests: `tools/v34test.js`
(protocol-unit loopback), `tools/v34-{trellis,shell,map,eye}-check.js` (component
verification). Built on the V.32/V.32bis core; **clean-room from ITU-T V.34
(02/98)** — no linmodem (GPL-2.0) code ported, so the repo stays LGPL-3.0.
Config-driven (`makeConfig`/`CONFIGS`) with **four data-mode rates, all verified
end-to-end** (map-check + protocol-unit loopback + full-stack + shipped bundle):
**19200/2400, 28800/3200, 31200/3200, and 33600/3429**. The rate is selected per
call via `config.modem.native.v34Rate` (UI dropdown → dial → server), defaulting to
the max. 19200/28800/31200 share the constant-`b`, all-high-SWP path; **33600/3429
is the top rate** and exercises two pieces the lower rates don't: a **3429 symbol
rate** (2.33 SPS, 1959 Hz carrier) and **§8.2 frame switching** (SWP=14A5 ⇒ mapping
frames alternate `b`/`b−1` bits). See "Rates and 33600 frame switching" below.

### Genuine (from the ITU-T V.34 Recommendation)

- **Symbol rate + carrier (Tables 1–2):** genuine V.34 rates/carriers — 2400 baud
  / 1800 Hz (19200), 3200 baud / 1920 Hz (28800, 31200), and **3429 baud / 1959 Hz
  (33600)**. 8 kHz clock ⇒ 2.5 SPS at 3200, 2.33 SPS at 3429. The 3429 occupied
  band (1959 ± 0.5·3429·(1+0.14)) is razor-thin — lower edge ≈ 4 Hz — but sound on
  the lossless link; carrier 1800 would fold the lower sideband through DC and fails
  (verified in `v34-eye.js`).
- **Shell mapper (§9.4):** real constellation shaping — K scrambled bits →
  8 ring indices over M equal rings via the g2/g4/g8/z8 recursion. Encoder and
  inverse round-trip bit-exact (`v34-shell-check.js`), verified up to the M=11/12
  configs behind 33600/28800.
- **4D differential encoder (§9.5):** I(m)=I2+2·I3, Z(m)=(I(m)+Z(m−1)) mod 4.
- **16-state 4D trellis on the wire (§9.6.3, Figure 10 / Wei):** genuine systematic
  convolutional encoder; subset labels from Figure 9 + Table 13; U0 rotates the
  second 2D point of each 4D symbol. Verified well-formed (`v34-trellis-check.js`).
- **Mapper (§9.6.1):** quarter-superconstellation on the odd-integer lattice
  (§9.6.3.1); Q(n)=Qbits+2^q·ring; the two points of a 4D symbol rotated by
  Z(m)·90° and [Z(m)+2·I1+U0]·90° clockwise.
- **Scramblers (§7):** GPC/GPA — identical generators to V.32/V.32bis, the shared
  golden-verified implementation.
- Async UART framing; in-band rate exchange (`peerRate` = the agreed rate, verified
  equal both sides at each of 19200/28800/31200/33600).

### Genuine-minimal, documented (lossless-transport-justified, §0)

- **No precoder (§9.6.2).** Flat, ISI-free channel ⇒ h≈[1,0,0] ⇒ c(n)=0 ⇒ Y≈U;
  the Tomlinson-Harashima precoder degenerates to identity. Consequently the
  modulo encoder C0(m)=0 and **U0(m)=Y0(m)** (pure trellis output).
- **No Viterbi decoder.** Receiver slices to the odd-integer lattice and inverts
  algebraically: Z=rot0, (2·I1+U0)=rot1−rot0 ⇒ I1=value>>1 with U0 discarded. The
  trellis genuinely runs at the transmitter (shaping the emitted signal) but its
  coding gain is unused on the lossless link — exactly as V.32bis carries Y0.
- **No line probing / INFO exchange (Phase 1–2), no non-linear warping (§9.7),
  no adaptive equalizer / continuous timing tracking** (acquire-once/free-run on
  the shared drift-free clock), **simplified startup** (audible pre-roll +
  acquirable preamble instead of the S/Ŝ/PP/TRN/MP/E/J segment state machine),
  **no superframe bit-inversion sync (V0=0)** (UART framing carries sync),
  **no auxiliary channel** (AMP all-primary), **single rate per call** (selectable
  per call among 19200/28800/31200/33600; no in-call rate renegotiation).

### Rates and 33600 frame switching (§8.2 / §9.3.1)

Four `CONFIGS` entries, `bitRate = frameBits · sRate/8`:

| Rate | S (baud) | b | K | M | q | L | SWP | switching |
|---|---|---|---|---|---|---|---|---|
| 19200 | 2400 | 64 | 28 | 12 | 3 | 384 | FFFF | no |
| 28800 | 3200 | 72 | 28 | 12 | 4 | 768 | FFFF | no |
| 31200 | 3200 | 78 | 26 | 10 | 5 | 1280 | FFFF | no |
| 33600 | 3429 | 79 | 27 | 11 | 5 | 1408 | 14A5 | **yes** |

- **31200/3200** is a fully spec-correct real V.34 rate: same 3200 front-end as
  28800, constant `b` (all-high SWP), just a larger 1280-point constellation. The
  shell mapper already round-trips at M=10/q=5.
- **33600/3429 frame switching** is genuine V.34 §8.2: a 16-bit switching pattern
  (SWP) selects, per mapping frame, whether it carries `b`=79 (high) or `b−1`=78
  (low) data bits. A low frame draws K−1 real shell bits and **inserts a forced 0
  as the high-order shell-mapper bit** (§9.3.1), so the shell mapper always sees K
  bits and the I/Q parser is identical high vs low; only one fewer bit is taken from
  the data stream. The long-run average `b` (≈78.4 for 14A5's 6-of-16 high frames)
  produces the 33600 payload rate that no integer bits-per-frame at 3429 baud can
  reach. Both ends drive the pattern from a **frame counter reset at data-burst
  start**; acquisition lands on TX frame 0 (the alt→const preamble boundary), and
  on the drift-free clock the high/low parity stays in lockstep, so data round-trips
  exactly. The differential/trellis state advances per 4D symbol regardless of
  parity. The **acquisition timing search runs at SPS/64** (not SPS/16): the sharp
  3429 eye tips the slicer at a ~0.07-sample timing error, which the coarser grid
  couldn't resolve (≈99 % symbol errors → 0). This is a finer one-time search, not
  timing tracking, and leaves 2400/3200 unaffected.

### Notes

- The 2.5-SPS receiver needed only a **wider matched-filter span (24)** at the low
  roll-off (0.20) required to fit 3200 baud in-band — not a timing-recovery rewrite.
  `v34-eye.js` (perfect-timing loopback) proved the eye open at 2.5 SPS; the earlier
  garbage was residual ISI from a too-short span tipping the slicer, not acquisition.
  3429 extends the same approach (span 32, β 0.14) plus the SPS/64 acquisition grid.
- Untested against real V.34 hardware; the constellation labelling is a
  self-consistent bijection over the correct §9.1/§9.6.1 structure (as with the
  other new protocols) rather than byte-exact to Figure 5's exact point numbering.
- **33600 fidelity, stated honestly:** the 3429 front-end (carrier/rate/band) and
  the frame-switching *mechanism* are genuine, and `b=79/K=27/M=11/q=5` and the
  `SWP=0x14A5` value are the spec's. But the exact **SWP bit-indexing** (taken here
  LSB-first over a 16-frame period) and the **J=8/P=15 superframe frame-accounting**
  are a self-consistent construction: correct for data integrity on this lossless,
  single-rate, no-superframe-sync link (both ends agree by construction), but they
  would need checking against V.34 Tables 7–8/10 before interworking with real V.34
  framing. The advertised rate is the nominal 33600 (the 14A5 pattern averages
  ≈33594 payload bps; UART idle-fill absorbs the slack).

---

## 8. Handshake / registry integration (all protocols)

To add or wire a protocol (`Handshake.js`):
1. `require('./protocols/<Name>')`, add to the `PROTOCOLS` map.
2. Symmetric self-training protocols (V.29/V.32/V.32bis) get a `want<Name>` bypass
   in `start()` **before** the V.8 path — routes both roles straight to
   `_selectProtocol` and skips the Handshake-layer ANS tone. Add the name to the
   event-driven `ready` branch (alongside `V22`/`V22bis`/`V29`/`V32`/`V32bis`/`V34`).
3. Add the name to `server.js` `PROTOS` (whitelist — otherwise it silently falls
   back to V.21) **and** the `<select id="protocol">` in `public/index.html`.
4. `npm run build`, run the browser-path safety check (CLAUDE.md §bundle), test.

`ready`/`connected` semantics for the self-training protocols: connected ==
"acquired the peer's carrier" (event-driven, no wall-clock CD gate).

---

## 9. Rate / capability summary

| Protocol | Rate | Modulation | Duplex | Carrier | Genuine level | Real-HW gap |
|---|---|---|---|---|---|---|
| V.21 / Bell103 | 300 | FSK | split-band | — | full | — |
| V.22 | 1200 | DPSK | split-band | — | spandsp port | mag-only detect, caller-lead |
| V.22bis | 2400 | 16-QAM | split-band | — | spandsp port | caller-lead training |
| V.23 | 1200/75 | FSK | split-speed | — | full | — |
| V.29 | 9600 | 16-QAM | half-duplex ping-pong | 1700 Hz | genuine minimal | equalizer + timing tracking |
| V.32 | 9600 | uncoded 16-QAM | full-duplex | 1800 Hz | genuine minimal | equalizer, timing, echo cx |
| V.32bis | 14400 | trellis 128-QAM | full-duplex | 1800 Hz | genuine minimal | Viterbi, equalizer, timing, echo cx, exact Fig 2-1 map, multi-rate |
| V.34 | 19200–33600 | shell-mapped trellis QAM | full-duplex | 1920/1959 Hz | genuine minimal | precoder, Viterbi, equalizer, timing, line probing, exact Fig 5 map, exact §8.2 framing |

---

## 10. Backporting to synthmodem for real-modem use

The new protocols (V.29/V.32/V.32bis/V.34) were written against the SynthLink
lossless 4-wire transport. To interwork with a **real modem on a real line**,
each needs, roughly in order of importance:

1. **Adaptive equalizer + continuous timing recovery.** The acquire-once/free-run
   receiver assumes zero clock drift and a flat channel. Real lines need a
   fractional (T/2) adaptive equalizer and a timing-tracking loop. The V.22bis
   spandsp port already has both — that is the reference to lift.
2. **Echo canceller (V.32/V.32bis only).** On 2-wire the shared 1800 Hz carrier
   requires cancelling your own transmit from your receive. Omitted here because
   the transport is 4-wire-equivalent. This is the hardest single component; the
   real V.32 handshake's AC/CA phase-reversal segments (currently omitted) exist
   to train it.
3. **Full standard handshake segments.** The audible startup here keeps the
   recognizable shape (answer tone → training → preamble → rate signal) but omits
   the echo-canceller segments and uses an in-band control-byte rate exchange
   rather than the exact Figure 3/V.32bis segment timings (AA/CC, S/S̄, TRN with
   the §5.2.3 scrambled-ones sequence, R1/R2/R3 modulated as 4800-encoded dibits,
   E sequence). For real interop, implement the exact segment state machine.
4. **Viterbi decoder (V.32bis, and V.32 TCM mode).** Needed to realise the
   trellis coding gain on a noisy line. Here Y0 is transmitted but sliced away.
   Also requires the exact Figure 2-1/2-2/2-3 constellation subset assignment
   (set partitioning) so the decoder's parallel-transition structure matches.
5. **Multi-rate + rate renegotiation (V.32bis §8).** Wire the 12000/9600/7200/
   4800 constellations (Figures 2-2..2-5) and the change-rate-without-retrain
   procedure. The rate signal already advertises the full set.
6. **V.8 negotiation.** The self-training protocols bypass V.8 entirely. Real
   automode modems negotiate modulation via V.8/V.8bis first.
7. **V.34-specific real-line pieces.** Beyond the shared items above: the
   **precoder (§9.6.2)** with far-end coefficient exchange (degenerate to identity
   here), **line probing L1/L2 + INFO/MP exchange (Phase 1–4)** to pick symbol
   rate / carrier / pre-emphasis / power from channel measurements, the **32/64-
   state trellis options** (only 16-state is built), **non-linear encoding (§9.7)**,
   the **superframe bit-inversion sync (Table 12)**, the **auxiliary channel**, and
   a **shell-mapping-aware equalizer/decoder**. The shell mapper, 4D differential,
   16-state trellis, mapper, and scramblers are already spec-correct.
8. **Undo the clean-link flags** (§0): re-enable CD verification, the V.22
   spectral detect, etc.

The scramblers, differential coding tables, constellation shapes, carrier/baud,
and rate-signal bit layouts are already spec-correct and portable as-is.
