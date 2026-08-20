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

A fourth fact matters only for V.90 (§8): the transport is not merely *like* a
clean line, it **is a PCM-sample channel** — 8 kHz linear PCM over a WebSocket.
That is the medium V.90's downstream was designed to exploit, so V.90 maps onto it
directly rather than by analogy, and needs no carrier, pulse shaping, matched
filter or timing recovery at all.

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
  timing/gain preamble (same non-syncing pre-roll pattern as V.29). **Since V.32
  and V.32bis now negotiate through real V.8 (§9), that answer tone is suppressed
  on the V.8 path** — V.8's own ANSam has already played — and is kept only for the
  forced/legacy path. The training and preamble are unchanged either way.

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
- **No line probing / INFO exchange (Phase 2), no non-linear warping (§9.7),
  no adaptive equalizer / continuous timing tracking** (acquire-once/free-run on
  the shared drift-free clock), **simplified startup** (acquirable preamble instead
  of the S/Ŝ/PP/TRN/MP/E/J segment state machine) — though **Phase 1 is now a real
  V.8 exchange**, see §9,
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
- **33600/3429 frame switching** is genuine V.34 §8.2: a switching pattern (SWP)
  selects, per mapping frame, whether it carries `b`=79 (high) or `b−1`=78 (low)
  data bits. A low frame draws K−1 real shell bits and **inserts a forced 0 as the
  high-order shell-mapper bit** (§9.3.1), so the shell mapper always sees K bits and
  the I/Q parser is identical high vs low; only one fewer bit is taken from the data
  stream. Both ends drive the pattern from a **frame counter reset at data-burst
  start**; acquisition lands on TX frame 0 (the alt→const preamble boundary), and on
  the drift-free clock the high/low parity stays in lockstep, so data round-trips
  exactly. The differential/trellis state advances per 4D symbol regardless of
  parity. The **acquisition timing search runs at SPS/64** (not SPS/16): the sharp
  3429 eye tips the slicer at a ~0.07-sample timing error, which the coarser grid
  couldn't resolve (≈99 % symbol errors → 0). This is a finer one-time search, not
  timing tracking, and leaves 2400/3200 unaffected.

- **SWP indexing is now spec-correct** (it was not, before the tables were
  transcribed). §8.2 states: *"SWP is represented by 12- to 16-bit binary numbers
  where 0 and 1 represent low and high frames, respectively. The left-most bit
  corresponds to the first mapping frame in a data frame. The right-most bit is
  always 1."* The pattern is therefore **P bits wide and indexed MSB-first**, where
  P comes from Table 7 — not 16 bits LSB-first, which is what this code did. For
  3429, P = 15 and SWP = 0x14A5 is `001010010100101`. Framing parameters
  (Table 7/V.34): a superframe is 280 ms and holds J data frames, each of P mapping
  frames — 2400 → J 7/P 12, 2743 → 8/12, 2800 → 7/14, 3000 → 7/15, 3200 → 7/16,
  3429 → 8/15.

- **The configs now self-validate against §8.2.** `makeConfig` computes
  `N = R·0.28/J` and `r = N − (b−1)P` and **throws** unless the SWP's one-count
  equals r and its right-most bit is 1. All four configs pass, which independently
  confirms the b/K/M/q values the earlier session derived: 19200/2400 → N 768,
  P 12, b 64, all-high; 28800/3200 → N 1152, P 16, b 72, all-high; 31200/3200 →
  N 1248, P 16, b 78, all-high; 33600/3429 → N 1176, P 15, b 79, r 6 (0x14A5 has
  exactly six ones), long-run average b = 78.4. `v34-map-check` now shows the
  33600 high/low split as 8000/12000 = exactly r/P = 6/15.

### Notes

- The 2.5-SPS receiver needed only a **wider matched-filter span (24)** at the low
  roll-off (0.20) required to fit 3200 baud in-band — not a timing-recovery rewrite.
  `v34-eye.js` (perfect-timing loopback) proved the eye open at 2.5 SPS; the earlier
  garbage was residual ISI from a too-short span tipping the slicer, not acquisition.
  3429 extends the same approach (span 32, β 0.14) plus the SPS/64 acquisition grid.
- Untested against real V.34 hardware; the constellation labelling is a
  self-consistent bijection over the correct §9.1/§9.6.1 structure (as with the
  other new protocols) rather than byte-exact to Figure 5's exact point numbering.
- **33600 fidelity:** the 3429 front-end (carrier/rate/band), the frame-switching
  mechanism, the `b=79/K=27/M=11/q=5` values and `SWP=0x14A5` are all the spec's,
  and since Tables 7/8 were transcribed the **SWP bit-indexing and the J=8/P=15
  superframe accounting are spec-correct too** (see above) — this is no longer a
  self-consistent construction. The advertised rate is the nominal 33600; the
  long-run average is 78.4 bits per mapping frame and UART idle-fill absorbs the
  fractional slack.

- **Still a self-consistent construction:** the constellation labelling is a
  bijection over the correct §9.1/§9.6.1 structure rather than byte-exact to
  Figure 5's point numbering (see Notes above), and **V.34's Phase 4 is not
  implemented** — the rate exchange is a project-specific `DLE 'R' hi lo` control
  frame, not V.34's MP/MP′ sequences. Because both ends resolve the rate from the
  shared config singleton before construction, that exchange verifies agreement
  rather than establishing it; removing it would not change the rate selected.
  Contrast V.90's CP (§8), which is genuinely load-bearing. → PROTOIMPROVE.md.

---

## 8. V.90 — 56 000 downstream PCM + 33 600 upstream V.34

Source: `protocols/V90.js`, `protocols/V90Mapper.js` (the downstream coder),
`protocols/V90Phase4.js` (the CP/MP parameter sequences). Component checks:
`tools/v90-{ulaw,modulus,shaper,map,phase4}-check.js`. Protocol-unit test:
`tools/v90test.js`. Clean-room from **ITU-T V.90 (09/98)**; linmodem's `v90.c`
(GPL-2.0) was consulted only in summary as an algorithm cross-check and no code
was ported — see PROVENANCE §4.

### Why V.90 fits this transport better than the analogue modems

V.21…V.34 are symmetric analogue modems: both ends synthesise a voiceband
waveform and the channel is treated as an ideal analogue line. V.90 is a
different animal, and the difference works in our favour.

V.90 does **not** modulate downstream at all. It exploits the fact that the 1990s
PSTN core was already digital — 64 kbit/s µ-law PCM at 8000 samples/s — with the
ISP sitting on the digital side. The digital modem places PCM **codewords**
directly onto that digital path; they travel digitally to the subscriber's
central office, hit a single D/A there, and cross the analogue last mile. The
analogue modem reads back which codeword was sent by measuring the level.

**Our transport is a PCM-sample channel.** The browser and server already exchange
8 kHz PCM over the WebSocket, which is precisely the medium V.90 downstream was
designed to exploit. So the entire DSP front-end that made V.34 hard — carrier,
RRC synthesis, matched filter, fractional symbol-timing acquisition — simply does
not exist here. **The symbols are the samples.** In a sense the analogue protocols
are the artificial ones on this link, synthesising waveforms to ship over a PCM
pipe; V.90 downstream maps onto it directly.

### Roles — asymmetric, and the mapping is forced

| | role here | direction | rate | carries |
|---|---|---|---|---|
| **digital modem** | `answer` (server) | downstream | 56 000 | PCM codewords |
| **analogue modem** | `originate` (browser) | upstream | 33 600 | genuine V.34 |

That is the only V.90-true mapping, and it happens to put the fast direction
where a BBS needs it. The upstream is **this repository's V.34 at its top rate,
composed unmodified and driven in one direction only** — V.90 §6 references V.34's
symbol rates, carriers, pre-emphasis, scrambler, framing and encoder clauses
directly, so this is not an approximation of the upstream, it *is* the upstream.
V.90 §6.1 makes 4800–28800 mandatory and 31200/33600 optional; we have 33600.

Note that the analogue modem's V.34 instance never fires its own `ready` event:
that event means "my receiver acquired the peer", and this side only transmits
V.34 — its receiver is the downstream PCM decoder.

### The µ-law codebook is honoured, not simulated

This deserves stating precisely, because it is easy to describe wrongly.

V.90's downstream transmitter is **defined** as selecting G.711 µ-law codewords,
and that is exactly what this code does: it emits the linear values those
codewords decode to, drawn from the Table 1 codebook. There is no quantiser
anywhere in the path and nothing is companded. The transmit behaviour is genuine
V.90 rather than a model of it.

What differs from a real link is narrower:

- On the PSTN the 64 kbit/s digital path **enforces** the codebook. Here nothing
  does — the restriction is self-imposed. We could ship arbitrary 16-bit levels
  and the transport would carry them.
- A real digital modem hands **8-bit octets** to the network; we ship the decoded
  **16-bit linear values**. The mapping is bijective, but our "network" is wider
  than a real one.
- Consequently we inherit none of the impairments — robbed-bit signalling, digital
  pads, the analogue loop's own D/A — that make a real V.90 **receiver** hard.
  That is the real simplification, and it is on the receive side.

Transport fidelity was measured rather than assumed (`tools/v90-ulaw-check.js`).
G.711's 14-bit scale is shifted ×4 into the transport's 16-bit linear PCM: peak
8031·4 = 32124 (0.980 of full scale, no clipping), and the minimum µ-law step
becomes 8 LSB against a Float32→Int16→Float32 round-trip error of 0. Every legal
codeword slices back exactly.

### Frame structure and the rate ladder (Table 2)

A **data frame** is six symbols (intervals i = 0..5) carrying D = S + K bits:

```
    rate = (S + K) · 8000 / 6         D ∈ [21, 42]  ⇒  28 000 … 56 000
```

in 8000/6 = 1333⅓ bit/s steps — 22 rates. The six-symbol frame is not arbitrary:
on a T1 the robbed-bit-signalling pattern repeats every six frames, which is why
V.90 lets each interval carry its own constellation. We have no RBS, so all six
are equal.

Table 2/V.90 was transcribed in full (K = 15..39) and every printed row is
reproduced exactly by three constraints:

```
    K ≥ 15        3 ≤ S ≤ 6        21 ≤ K + S ≤ 42
```

equivalently Smin = max(3, 21−K), Smax = min(6, 42−K). Spot checks against the
printed table: K=15 → S 6..6 (28 000 only); K=16 → S 5..6; K=17 → S 4..6;
K=18..36 → S 3..6; K=37 → S 3..5; K=38 → S 3..4; K=39 → S 3..3 (56 000 only).

**56 000 has four legal (K,S) pairs** — (36,6), (37,5), (38,4), (39,3) — differing
only in how many sign bits go to spectral shaping. We default to the largest legal
Sr, i.e. **(39,3)**, so the shaper is always exercised. Any rung is selectable per
call via `config.modem.native.v90Rate`, with `v90Sr` optionally pinning the pair.

### Genuine, verified against the Recommendation

- **µ-law codebook (Table 1).** Ucode u ∈ 0..127, magnitude
  `(2·(u&15) + 33)·2^(u>>4) − 33`, 0 … 8031, checked against an independent G.711
  expansion for all 128 and against per-segment step doubling.
- **Parse (§5.4.2).** `d0..d(S−1)` → sign bits; `dS..d(D−1)` → modulus bits with
  `R0 = b0 + b1·2¹ + … + b(K−1)·2^(K−1)`, b0 the LSB.
- **Modulus encoder (§5.4.3).** `Kᵢ = Rᵢ mod Mᵢ`, `Rᵢ₊₁ = (Rᵢ − Kᵢ)/Mᵢ`, subject to
  `∏Mᵢ ≥ 2^K`. This is what makes V.90's fractional bits-per-symbol work, and it
  is the structural cousin of the V.34 shell mapper: pure mixed-radix integer
  arithmetic, no DSP. Verified over 250 000 round trips including the full K=39
  range and random unequal radices, plus injectivity over a dense sweep. At K=39,
  `R0 < 2³⁹ < 2⁵³`, so Number arithmetic is exact — but **bitwise operators are
  32-bit and must never be used on these values**.
- **Mapper (§5.4.4).** `Kᵢ` labels a member of `Cᵢ`, labelled **descending** by
  magnitude: label 0 is the largest PCM code, label `Mᵢ−1` the smallest.
- **Signs (§5.4.6).** Sign bit 1 = positive voltage, 0 = negative.
- **Spectral shaper (§5.4.6 / Figure 2).** See below — genuine and load-bearing.
- **CP/MP (Tables 14 and 16).** Genuine bit layouts — see below.
- **Sd training signal.** Genuine, and it is the whole acquisition — see below.

### The spectral shaper

Of the six sign bits, S carry data and **Sr = 6 − S are redundant** and spent on
shaping. Table 3 partitions the six sign positions into Sr shaping frames of 6/Sr
positions each; position 0 of every shaping frame is the redundant one, initialised
to 0, and the rest take s0, s1, … in order. That general form reproduces Table 3
exactly for Sr = 1 (one 6-position frame), 2 (two 3-position) and 3 (three
2-position).

The shaper then picks, per shaping frame, one of four sign-inversion rules,
constrained to a **2-state trellis**:

| rule | action | transition |
|---|---|---|
| A | leave the signs alone | state 0 → 0 |
| B | invert every sign in the frame | state 0 → 1 |
| C | invert the even-numbered signs | state 1 → 0 |
| D | invert the odd-numbered signs | state 1 → 1 |

From state 0 only A and B are allowed; from state 1 only C and D. The choice
minimises a spectral metric computed from the emitted linear PCM values:

```
    y[n] = x[n] − b₁·x[n−1] + a₁·y[n−1]
    v[n] = y[n] − b₂·y[n−1] + a₂·v[n−1]
    w[n] = v²[n] + w[n−1]
```

with a₁, a₂, b₁, b₂ chosen by the analogue modem and carried in CP as signed
Q1.6, and lookahead depth lₐ ∈ 0..3 (0 and 1 mandatory).

**The shaper costs no data, and that is provable rather than assumed.** Position 0
of every shaping frame starts at 0 and each rule acts on it distinguishably: from
state 0, A leaves it 0 and B makes it 1; from state 1, C makes it 1 (it is an
even-numbered position) and D leaves it 0. So a receiver tracking the trellis
state deterministically reads position 0, infers the rule, un-inverts the rest and
recovers the data signs. `tools/v90-shaper-check.js` verifies this exhaustively
over every state × rule × data combination for Sr = 1, 2 and 3, and separately
confirms the rules are involutions.

lₐ is an **encoder-side choice only** — it changes which legal rule sequence is
chosen, never how it is decoded, so the receiver is independent of it. Measured
effect with the default b₁ = −1 (⇒ y[n] = x[n] + x[n−1], so minimising w suppresses
DC): **−23.2 dB** in 0–200 Hz against an unshaped control on identical data, with
+4.3 dB pushed into 3–3.8 kHz. It genuinely shapes.

### Constellations and what CP actually decides

`Cᵢ` is a set of Ucodes given as a 128-bit mask — exactly the form CP carries.
CP sends a **set** of up to six constellations plus a 4-bit index per data frame
interval selecting among them (Table 14, bits 103:127). With no RBS we send one
and index it six times.

The default is the **91 largest Ucodes (37..127)**. That size is forced: 56 000 at
(39,3) needs `∏Mᵢ ≥ 2³⁹ = 549 755 813 888`, and with six equal intervals
90⁶ = 5.314e11 < 2³⁹ ≤ 5.679e11 = 91⁶. Dropping the finely-spaced near-zero codes
is what a real analogue modem does; the smallest surviving step is 32 LSB at
16-bit scale.

**91 is specific to (39,3).** The same 56 000 at (36,6) — no spectral shaping —
needs only `∏Mᵢ ≥ 2³⁶`, i.e. 64 levels per interval. So the real-world trade is
shaping against constellation size, not simply "56k needs 91 levels".

### Acquisition — the Sd signal does all of it

The `Sd` training signal is 64 repetitions of `{+W, +0, +W, −W, −0, −W}` followed
by 8 repetitions of the sign-inverted pattern, where W is the largest Ucode (127)
and "0" is Ucode 0. **Its first symbol is defined to be data frame interval 0**, so
locking the pattern's phase *is* frame alignment. On the drift-free 8 kHz clock
that is the entire receiver acquisition problem: no timing recovery, no equalizer,
nothing fractional.

Two details make it robust:

1. **Polarity must be matched, not ignored.** `{+W,+0,+W,−W,−0,−W}` is
   antisymmetric under a three-symbol shift — shifting by 3 reproduces the
   sign-inverted pattern exactly. Accepting either polarity therefore pins the
   phase only mod 3 and can lock three symbols early, splitting every frame across
   the Sd/data boundary. Matching the normal polarity only pins it mod 6. This was
   a real bug, found when the V.8 work changed the timing; `tools/v90test.js` now
   sweeps all twelve starting offsets.
2. **Where training ends is exact, not heuristic.** An Sd repetition carries the
   zero symbol at intervals 1 and 4. A data frame never can — the working
   constellation starts at Ucode 37 (magnitude 139). So "the first aligned group
   without zeros" is a collision-free discriminator for the start of data.

The hunt is a single forward pass over an only-advancing cursor: rescanning the
whole buffer per chunk is quadratic and, with a one-second answer tone in front of
Sd, slow enough to look like a hang.

### Startup — Phase 1 and Phase 4 are both genuine

Real V.90 has four phases: (1) V.8 CM/JM, (2) INFO0/INFO1 + line probing +
ranging, (3) equalizer training + digital impairment learning, (4) CP/MP parameter
exchange + TRN2d/B1d. Phases 2–3 measure a channel this transport does not have.
The two that carry information are implemented.

**Phase 1 is a real V.8 exchange.** V.90 signals its capability through bit **b5
of the V.8 modn0 octet** ("PCM avail"), which this repository's V.8 implementation
already built and decoded — only the protocol mapping was missing. V.90 therefore
negotiates through genuine ANSam → CM → JM → CJ → 75 ms post-CJ silence, alongside
V.21 and V.22bis. When V.8 has run, the class suppresses its own answer tone
(`setV8Complete`), because a second tone would land during the peer's post-CJ
training and trip its energy-onset acquisition. The ANSam-shaped 2100 Hz tone is
retained for the forced/legacy path where no V.8 ran.

**Phase 4 is functionally load-bearing, not decorative.** CP travels upstream over
the established V.34 link and genuinely determines the downstream: the digital
modem sits silent until it arrives because it does not know what to transmit. CP
and MP use the Recommendation's own bit layouts:

- **CP (Table 14)** — 292 bits for one constellation: a 17-one frame sync, then
  17-bit groups (a start bit 0 plus 16 payload bits). Fields at their literal
  positions: `19` CP/CPt, `20:24` drn (rate = (drn+20)·8000/6), `31:32` Sr, `33`
  acknowledge, `35` codec (0 = µ-law), `36:48` upstream rate capability mask,
  `49:50` lₐ, `52:67` TRN1d RMS ratio as unsigned Q3.13, `69:76`/`77:84`/`86:93`/
  `94:101` a₁/a₂/b₁/b₂ as signed Q1.6, `103:127` six 4-bit constellation indices
  (with a start bit at 119 splitting intervals 3 and 4), `128` constellations-differ,
  then eight 17-bit groups per constellation carrying the Uchord masks (chord 1 ↔
  Ucodes 0..15 at bits 137:152 … chord 8 ↔ 112..127 at 256:271), then a CRC group
  and fill.
- **MP (Table 16), Type 0** — 90 bits: sync, `18` MP type, `24:27` drn (upstream
  rate = drn·2400, drn 2..14), `29:30` trellis select (0 = 16-state), `31`
  nonlinear encoder, `32` shaping select, `33` acknowledge, `36:49` capability
  mask, CRC, fill to a multiple of 6.

`tools/v90-phase4-check.js` asserts the frame sync and every table-named start bit
at its literal position, and that the documented field positions decode what was
encoded — **not** merely that the sequence round-trips, since a self-consistent
encoder/decoder pair will happily agree on a wrong layout. It also confirms all
400 single-bit corruptions are caught by the CRC.

Ordering note: CP must be queued at construction, not on the upstream V.34's
`ready` event, because on the analogue side that event never fires (see Roles).
`V34.write()` parks the bytes behind its own control frames, so CP goes out as the
first thing on the upstream the instant data mode opens.

### Data path over the downstream

The downstream carries bytes with the project's async start/stop (UART) framing
over a continuously scrambled stream, using the same role-asymmetric GPC/GPA
scramblers as V.32/V.32bis/V.34 (V.90 §6.5 references V.34's). Idle is mark, so
the descrambled idle stream yields no start bit and therefore no phantom bytes,
while the codeword stream — and the carrier — runs continuously.

Downstream TX level is full-amplitude PCM (RMS ≈ 0.37, peak 0.98), unlike the
~0.1 RMS of the modulated protocols. That is correct: the codewords *are* the
samples.

### Deliberately out of scope (documented, not hidden)

- **No INFO0/INFO1, no line probing, no ranging, no digital impairment learning**
  (Phases 2–3). All measure or repair a network segment this transport lacks.
- **No robbed-bit-signalling detection, no digital-pad detection, no PCM-law
  auto-detection.** CP selects the codec and we answer µ-law.
- **No analogue-loop equalizer, no timing tracking.** Symbols are samples.
- **CP/MP transport.** The bit layouts are genuine, but the finished sequences are
  packed into bytes and carried over the already-established link (CP over the
  upstream V.34, MP in the downstream data stream) rather than being modulated by
  the Phase 4 signalling. The *content* is bit-exact to the tables; the way it
  crosses the wire is not. This matters for real-modem interop.
- **CRC convention inferred.** V.90 defers the CRC to §10.1.2.3.2/V.34 and does not
  restate it, and that clause was not recovered. We use the CCITT generator
  x¹⁶+x¹²+x⁵+1 over the bits from the first start bit up to the CRC's own start
  bit. Both ends agree, so it is a genuine integrity check here, but the exact
  convention is unverified. → PROTOIMPROVE.md.
- **Power.** A real digital modem is bound by Table 15/V.90 and, in the US, by the
  FCC limit that capped real connections at **53 333 bit/s (D = 40)**. We run
  D = 42 for a true 56 000 because this transport has no regulatory or hybrid
  constraint.

### For real-modem interop

Beyond undoing the scope-outs above: implement the Phase 2–3 state machine
(INFO0/INFO1, line probing, ranging, DIL), add RBS and digital-pad detection,
carry CP/MP in the real Phase 4 signalling rather than as bytes, confirm the CRC
convention against V.34 §10.1.2.3.2, honour the Table 15 power limits (which caps
the achievable rate below 56 000 on a real US line), and support A-law. Untested
against real V.90 hardware.

---

## 9. Handshake / registry integration (all protocols)

### Which protocols negotiate via V.8

| Protocol | V.8 |
|---|---|
| V.21, V.22, V.22bis, V.23 | **Real V.8** — ANSam → CM → JM → CJ → 75 ms post-CJ silence |
| V.32, V.32bis, V.34, **V.90** | **Real V.8** (moved this session) |
| Bell 103 | Attempts V.8, times out at CJ, falls back via the V.25 legacy automode probe — correct, since Bell 103 predates V.8 |
| V.29 | Bypassed (`wantV29`) — half-duplex ping-pong with its own audible connect script |

V.8's modulation-mode octets already carried every bit needed: `modn0` b6 = V.34,
b5 = "PCM avail" (**this is how V.90 signals capability**), `modn1` b0 = the
V.32/V.32bis family. Moving V.32/V.32bis/V.34/V.90 onto real V.8 needed only the
`selectProtocol` mappings, advertising the bits in `V8Sequencer`, deleting the
`want<X>` bypasses, and a `setV8Complete()` on each class.

**`setV8Complete(done)` is the contract.** A protocol that emits its own 2100 Hz
answer tone must suppress it when V.8 already ran — the ANSam has been heard, and a
second tone lands during the peer's post-CJ training and trips its energy-onset
acquisition. `Handshake._selectProtocol` calls it on any protocol that defines it,
passing whether the V.8 path was taken. V.32/V.32bis/V.34 implement it by filtering
the `tone` step out of `_connectQ`; V.90 does it by skipping its `tone` TX stage.

Note V.8 has a single bit for the **V.32/V.32bis family**, exactly as it has one
for V.22/V.22bis. Both ends resolve which of the two to use from their own
preference list, so they agree; a real V.8 peer advertising `v32bis` would get
whichever we prefer. That is how V.8 works, not a shortcut.

### To add or wire a protocol (`Handshake.js`)

1. `require('./protocols/<Name>')`, add to the `PROTOCOLS` map.
2. Decide V.8 or bypass. **Prefer V.8** — it is the authentic path and is now
   proven for both self-training and PCM protocols. Map the name in
   `V8.selectProtocol`, advertise its bit in `V8Sequencer._buildModes`, and add a
   `setV8Complete()` if the class emits its own answer tone. Only take a
   `want<Name>` bypass if the protocol genuinely has no V.8 representation.
3. Add the name to the event-driven `ready` branch (alongside
   `V22`/`V22bis`/`V29`/`V32`/`V32bis`/`V34`/`V90`).
4. Add the name to `server.js` `PROTOS` (whitelist — otherwise it silently falls
   back to V.21) **and** the `<select id="protocol">` in `public/index.html`.
5. `npm run build`, run the browser-path safety check (CLAUDE.md §bundle), test.

`ready`/`connected` semantics for the self-training protocols: connected ==
"acquired the peer's carrier" (event-driven, no wall-clock CD gate). For V.90 the
digital modem is ready only once CP has arrived **and** the upstream carries data —
it genuinely cannot transmit before that.

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
| V.32bis | 14400 | trellis 128-QAM | full-duplex | 1800 Hz | genuine minimal | Viterbi, equalizer, timing, echo cx, exact Fig 2-1 map, multi-rate |
| V.34 | 19200–33600 | shell-mapped trellis QAM | full-duplex | 1920/1959 Hz | genuine minimal | precoder, Viterbi, equalizer, timing, line probing, exact Fig 5 map, real MP/MP′ |
| **V.90** | **56000 down / 33600 up** | **PCM codeword selection down, V.34 up** | **asymmetric** | **none (symbols are samples)** | **genuine minimal** | **Phase 2–3 (probing/ranging/DIL), RBS + digital pad, CP/MP signalling transport, CRC convention, Table 15 power** |

Note V.90's row has no carrier because it has no modulation downstream: the PCM
codewords are the samples. Its "genuine minimal" is a different shape from the
others — the hard part is the mapper, not the receiver.

---

## 11. Backporting to synthmodem for real-modem use

The new protocols (V.29/V.32/V.32bis/V.34/V.90) were written against the SynthLink
lossless transport — 4-wire-equivalent for the analogue ones, and a PCM-sample
channel for V.90. To interwork with a **real modem on a real line**, each needs,
roughly in order of importance:

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
6. **V.8 negotiation — largely DONE.** V.21/V.22/V.22bis/V.23 always used real
   V.8; V.32/V.32bis/V.34/V.90 were moved onto it this session (§9). Only V.29
   still bypasses. V.8bis is not implemented.
7. **V.34-specific real-line pieces.** Beyond the shared items above: the
   **precoder (§9.6.2)** with far-end coefficient exchange (degenerate to identity
   here), **line probing L1/L2 + INFO/MP exchange (Phase 1–4)** to pick symbol
   rate / carrier / pre-emphasis / power from channel measurements, the **32/64-
   state trellis options** (only 16-state is built), **non-linear encoding (§9.7)**,
   the **superframe bit-inversion sync (Table 12)**, the **auxiliary channel**, and
   a **shell-mapping-aware equalizer/decoder**. The shell mapper, 4D differential,
   16-state trellis, mapper, and scramblers are already spec-correct.
8. **V.90-specific real-line pieces.** Beyond the shared items: the Phase 2–3
   state machine (INFO0/INFO1, line probing, ranging, and the digital-impairment-
   learning phase), **robbed-bit-signalling and digital-pad detection** (the reason
   the data frame is six symbols and the reason each interval may carry its own
   constellation), PCM-law auto-detection and A-law support, carrying CP/MP in the
   real Phase 4 signalling rather than as bytes on an established link, the
   §10.1.2.3.2/V.34 CRC convention, and honouring the Table 15 power limits — which
   on a real US line caps the achievable rate below 56 000 (the FCC limit put it at
   53 333). The µ-law codebook, modulus encoder, spectral shaper, Table 2 ladder and
   the CP/MP bit layouts are already spec-correct and portable as-is.

9. **Undo the clean-link flags** (§0): re-enable CD verification, the V.22
   spectral detect, etc.

The scramblers, differential coding tables, constellation shapes, carrier/baud,
rate-signal bit layouts, V.34's §8.2 framing, and V.90's mapper and Phase 4
sequences are already spec-correct and portable as-is.

Concrete, scoped work items for the remaining gaps — with the spec references and
the retrieval technique that unblocked them — are in **PROTOIMPROVE.md**.
