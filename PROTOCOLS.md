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

**A simulated call has no server modem at all** (HANDOFF.md, high-traffic mode):
the browser runs both ends of the pair locally and payload crosses the socket as
bytes. Nothing in this document changes for it — the same classes, the same
handshake, the same rates — but the transport under that pair is memory rather
than a WebSocket, so it is even more of the clean channel §0 assumes, and the
rate a caller sees is the server's pacer set to the figure in §10.

These facts are what let the newer receivers be **"genuine minimal"**: real
modulation, encoding, scrambler and a real-enough training handshake, but
**without** an adaptive equalizer, continuous timing tracking, echo canceller or
Viterbi decoder. On a real line all four come back (§11). Several now have: V.34 has
an equalizer and Viterbi; V.32, V.32bis and V.34 track timing and carrier; and those
three carry an echo canceller, running on every call as a real modem's does.

**The echo canceller** (`vendor/src/dsp/EchoCanceller.js`, ported from BinModem's
`dsp/src/echo.rs`) is NLMS on the passband samples, driven by the modem's own
transmit. It has a near run of 64 taps at lag 0 and a far run of 64 placed by a
search out to 256 ms. The search scores what the near run LEAVES, because a near
echo of a periodic signal (V.34's PP) correlates again a period later.
- It adapts only in this end's training segment, which the far end must be silent
  through: V.32's first TRN (§5.4.2 note 3), V.34's Phase 3 PP and TRN, the call
  modem's TRN only. The search runs over TRN alone.
- A training that removed under 1 dB is undone, so taps that learnt only noise are
  not added back.
- The receiver idles through this end's own conditioning signal and 160 samples
  after it.
- It runs on EVERY call, as a real modem's does, since a modem cannot tell a
  2-wire line from a 4-wire one. On the 4-wire WebSocket it trains on no echo,
  removes nothing and is undone (the 1 dB rule): measured, 0.00 dB, cleared, every
  call. Only the line differs between the modes, never the modem.
  (`setEchoCanceller(false)` turns it off, for a negative control only.)
- **Its two clocks are paired, as a modem's are** (`vendor/src/dsp/ClockPair.js`,
  in Handshake on every call). It assumes receive sample n arrived as transmit
  sample n left. The bridge's lockstep line gives that; ModemDSP's real-time pump
  does not (transmit is wall-clock paced, receive comes as packets arrive), so
  ClockPair holds receive sample n until transmit sample n exists, about 16 ms at
  most. When a protocol takes the line it re-bases both directions to ONE origin,
  the instant of its first transmit sample; receive is often behind transmit then
  (the far end's audio in flight), and counting each direction from its own next
  sample skewed every echo by that lag. Without the
  hold the pump's bursts let receive run ahead of transmit, and the canceller
  trained to 8 dB where 39 was right; unpaired altogether it took the far end's
  TRN, the same scrambled sequence as ours, for an echo.
- **2-wire mode** (`config.modem.native.twoWire`, off by default;
  `vendor/src/dsp/TwoWire.js`) is the line and nothing else: each end hears its
  own echo, as a real local loop returns it (near −12 dB at 1 ms, far −24 dB at
  20 ms), and the far end 10 dB down. ModemDSP applies it at the modem's edge,
  outside Handshake, in real time (its own hold, as a line has one clock), so the
  echo is physical and lands at its delays only if the modem's frame is right.
  The modems do not know it is there. Over the real-time pump, with dsptest2's jitter (`twowire-check`): V.32,
  V.32bis and V.34 each train both cancellers to 38–43 dB, with the far run on the
  20 ms reflection, and carry text exactly both ways. With the canceller held off
  the same line defeats V.32bis. V.21, V.22 and V.22bis survive on their filters.
  V.22 needed its carrier-detect floor moved to −43 dBm0 first (it was −20, so 10 dB
  of loss alone lost it).
- Against BinModem through the bridge's 2-wire line (echo 10 dB down, delays 0 to
  25 ms, levels matched): V.32 and V.32bis both roles (`bm-v32`), V.34 both roles
  with our echo only, since BinModem's V.34 has no canceller (`bm-v34` [7]). At the
  end of training the whole segment is replayed through the update 8 times
  before what it removes is measured. V.34's PP and TRN alone left 23–27 dB, too
  little for 33 600 once our echo arrived as loud as the far end; with the
  replays it removes 31–36 dB. `echo-check` holds the canceller alone: 40–60 dB on a clean
  echo, the far run placed for 25 and 100 ms, noise-only training undone, and held
  taps unmoved under double talk.

**Config** (`vendor/synthlink-config.js`, applied to BOTH server and browser
bundle). There are no clean-link relaxations: the modem runs as it would on a real
line, whatever the transport (CLAUDE.md rule 8).

| Setting | Effect | Why |
|---|---|---|
| `listenWindowMs=12000` | How long a calling modem waits after training for the far carrier | A whole V.25 answer tone (up to 4 s) can come first, even after V.8 (BinModem's V.21 sends one); a real modem's S7 allows 30 s or more |
| `protocolPreference` / `v8ModulationModes` | Per-call protocol select | Default `['V21']`; set just before DSP construction. |
| `trainingDurationMs.Bell103=1000` | Bell 103's mark idle before data | Measured off the capture (§2) |

**Circuit 109 after training** (Handshake, for the protocols with `carrierDetected`:
V.21, Bell 103, V.22, V.22bis, V.23). The link comes up once the far carrier has
held for `cdStableMs`, 500 ms, inside V.21 Table 2's 300–700 ms OFF-to-ON time on
the switched network. It is counted in RECEIVED SAMPLES from the carrier's arrival,
not in wall-clock time from our own training's end, so a busy browser main thread
cannot stretch or shrink it (`CONTEND=1 bundle-smoke`). The settings that once
skipped it (`skipCdVerification`), shortened it (`cdStableMs=120`) and dropped
V.22's anti-AA test (`v22MagOnlyDetect`) still exist for other consumers and are
not set.

---

## 1. Common DSP machinery

- **Async start/stop (UART) framing** on every protocol without V.42 (§13):
  start(0) + 8 data bits LSB-first + stop(1), line idles mark. Idle therefore
  emits **no bytes**, which is what stops an idle scrambled carrier flooding the
  peer with `0xFF`. V.22, V.22bis, V.32, V.32bis, V.34 and V.90 run V.42 over a
  synchronous bit stream instead, and go back to start-stop characters when the
  far end does no error control.
- **Fractional-SPS RRC + matched filter** (V.29/V.32/V.32bis): 2400 baud at 8 kHz
  is 3.333 samples/symbol, handled by continuous root-raised-cosine synthesis
  (rolloff 0.25, span 10) and a fractional matched filter sampling at the true
  non-integer symbol instants.
- **Preamble acquisition** (V.29): energy onset → fractional symbol-timing lock →
  alternating→constant frame-sync boundary → complex channel-gain seed → decode.
  Preamble is `SEG_A` alternating symbols (timing/AGC) plus `SEG_B` constant
  symbols (gain/phase reference and frame-sync marker). V.32/V.32bis no longer use
  one: they acquire on §5.2's signal S and run on that lock into data (§5).
- **Transmit level is a real modem's: −10 dBm0**, the customary setting, inside the
  usual −9 ceiling, on G.711 μ-law's scale (full-scale sine +3.17 dBm0).
  `vendor/src/dsp/LineLevel.js` holds it once and every transmitter takes its gain
  from it: V.8's CI/CM/JM/CJ and ANSam, the FSK protocols, V.29, V.32, V.32bis,
  V.34 and V.90's upstream. So what a user hears on the WebSocket is what a real
  line carries. They ranged from −7.6 (V.32/V.32bis, over the ceiling) to −14.8
  (ANSam). The exception is V.22/V.22bis at −10.9, synthmodem's, level-matched to
  a real-modem capture and hardware-validated, and left as it is. V.90's
  downstream is PCM codewords, whose level is the Recommendation's.
- **Receive levels are a real line's.** A line loses 10 to 30 dB, so a far end can
  arrive near −40 dBm0. Every level gate in the receive path is either relative to what is
  being received or at the Recommendations' carrier-detect floor:
  - V.8's ANSam: Goertzel at 2100 Hz over half the block's RMS, above −47 dBm0
    (V.25's detector responds above −43 and not below −48).
  - V.21's carrier detect, for V.8's CM/JM and V.21/Bell 103 data: ON −46,
    OFF −48 dBm0 (V.21: ON above −43, OFF below −48), on the SUM of the mark and
    space envelopes, which holds through FSK's tone switching where their
    larger dipped at every transition.
  - V.32/V.32bis's squelch: ON −43, OFF −48 dBm0; S's onset half the level received.
  - V.34: a front-end AGC through Phase 2, brought to our own level (every Phase
    2 detector is a fraction of it), adapting only within 6 dB of its recent
    peak so it never chases a signal into a gap, and held from Phase 2's end.
  Each was a fixed level set at our own and failed after 20 dB of loss; `bm-whole`
  holds them against BinModem at a modem's level. Our reach is now past
  BinModem's own: it does not connect to itself where ours fails toward it.

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
banner alone is ~6 s, so full banner+echo tests sit near the harness time budget.

### The receiver re-times on every transition inside a character

`FskDemodulator` takes its votes at mid-bit, and each mark/space transition inside
a character pulls its timer half the error toward a boundary there (a DPLL, as
spandsp's fsk.c has; a transition more than 0.35 of a bit from where a boundary
should be is ignored). Timed from the start edge alone, the first character after
a long mark idle came out late, its edge detected against filters the mark had
charged, and with one stop bit and the next start bit straight after, the stop
vote ran into it and the frame was dropped: V.21 lost a caller's first keystroke
one call in four (`dsptest2`'s "hi" echoed as "i"). `fsk-timing-check` holds the
real call's audio that did it (`tools/tests/vectors/v21-first-char.s16`), which
the old receiver read as "i\r".

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
gate on. Circuit 109 (§0) then holds the link until the far carrier has been up
for 500 ms, which it has long been by the end of the count. The mark idle is `trainingDurationMs.Bell103`, set in
`vendor/synthlink-config.js` — the upstream table gives it 0 with the comment
"FSK — no training needed", and 0 is falsy at the read site, so the value was
never what the comment said.

Neither V.21 nor Bell 103 has a training sequence at all — 300 baud on two tones
has nothing to equalise — so both report their start-up as an idling carrier
rather than as training.

### V.21 waits for the far end's MARK, not for energy

A V.21 answerer may send a V.25 answer tone before its mark — BinModem's does even
after V.8 — and the high channel's space filter (1850 Hz) passes 2100 Hz, so carrier
detect read the tone as carrier and the caller called the link up three seconds
early and sent into it. `V21.farEndIdle` is the condition now: mark energy above both
the space tone and 2100 Hz for 200 ms (BinModem uses the same 200 ms for the same
reason). Handshake.js's circuit 109 counts only while it holds, so the 500 ms run
(§0) starts at the far end's mark, and a call whose far end never idles fails at
the listen window rather than coming up on its tone.

**Against BinModem** (`bm-fsk.js`, whole calls, real time): Bell 103 and V.21 in BOTH
roles, text exact both ways; V.21's V.8 agrees as caller and answerer. V.23 has no
BinModem counterpart.

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
2. **The anti-AA test only where AA can be.** The answer-side detector requires
   carrier-bin energy > 3× the 1800 Hz bin, to tell a V.32 caller's AA from a V.22
   caller. It cannot pass on a 2-wire line, where the answerer hears its own guard
   tone's echo at 1800 Hz. After V.8 has agreed V.22 or V.22bis no V.32 caller is
   on the line, so `setV8Complete` drops it, as a negotiated modem would; without
   V.8 it stands. (`v22MagOnlyDetect` dropped it always; it is no longer set.)
3. **V.22bis's calling modem is §6.3.1.1.1's**, which spandsp never had — its
   originate side fell through to the answer flow, and a "caller-lead" stand-in
   sent S1 on the first sign of carrier. Against a real answerer that S1 landed
   inside its answer tone, the answerer settled at 1200, and the caller's
   receiver, having trained on that answer tone, decoded nothing. Now: silent;
   155 ms of the answerer's unscrambled binary 1 (a line at carrier − baud/4,
   2250 Hz, clear of the 2100 Hz answer tone); a further 456 ms of silence, with
   the demodulator restarted, because what it made of the line before that was
   not V.22bis; S1 for 100 ms; scrambled ones at 1200 until the answerer's S1
   (circuit 112 ON) or 270 ms of its scrambled ones (V.22, §6.3.1.2.1 c, d); 2400
   600 ms after circuit 112; data 200 ms later. The caller listens for the
   answerer's S1 from the start of its own: §6.3.1.1.2 b) has the answerer reply
   "at the end of receipt", BinModem replies as soon as it recognises S1, and the
   two are in different channels.
4. **Received bytes are held, not dropped, until this end's DATA phase** (V.22bis
   and V.22). The demodulator's readiness is the clause's receive condition; a far
   end ready to send a little before this end's transmitter finishes lost its first
   characters — a BBS banner's. Under V.42 (§13) those characters are bits the
   stack hears, handed to it as they were framed.
   V.22's answerer sends SB1 for §6.3.1.2.2 c)'s 765 ms. It sent 2000 "for
   safety" until V.42: that 1.2 s let a V.42 caller's T400 run out before this
   end listened for its ODP, so error control never came up with any V.42 caller.
4a. **The receive floor is §4.4's −43 dBm0, on our scale.** Each detector's floor is
   what it reads of its own signal at −43 (USB1's line 0.0854 at −10, S1's carrier
   0.0702, both measured and scaled), and the demodulator's carrier gate is set
   from its own reading (0.0595 at −10): ON at −43, OFF at −48. spandsp's constants
   put that gate at −38 on our front end, and the 0.005 floors were tones at −37.
   The magnitude detectors read a 20 ms average (`symbolLevel`), since the 4 ms
   meter follows scrambled data's envelope. Both rates connect with LAPM to −41
   dBm0 with no echo and at 25 dB of loss under 2-wire mode's echo
   (`twowire-check`).
   The floors of the two detectors that must hold a run of windows (V.22bis's S1,
   80 ms of it, and V.22's caller's 270 ms of scrambled binary 1) are at −46, not
   −43: a −42 signal read a dB either side of its level and missed S1 or hung in
   SB1. −46 is inside −43, where they must respond, and above −48, as V.21's
   carrier detector is. And the gate goes OFF only after 40 ms under −48, §3.2/
   V.22bis's "40 to 65 ms after the level ... falls below the relevant
   threshold"; it had dropped on the first sample, which at −42 restarted the
   receiver on scrambled data's dips. Both rates now hold to −42 dBm0 in both
   roles with LAPM, and connect at none under −48 (`v22-level-check`).
5. **V.22's calling modem is §6.3.1.2.1's** — the same silence, 155 ms of
   unscrambled binary 1 and 456 ms pause as V.22bis, then scrambled binary 1 (no
   S1); 270 ms of the answerer's scrambled ones (carrier without the unscrambled
   line) is circuit 109, and data 765 ms later. It had been running the answerer's
   flow.
6. **The demodulator's last 1200 training stage decodes through the UART** and
   holds what it gets until NORMAL_OPERATION. spandsp counts that stage as 270 +
   765 ms from the start of the far end's scrambled ones and decoded nothing in
   it; a far end that starts its data inside it lost the data.

### For real-modem interop

These interwork with real hardware on the answer side (that is what spandsp was
built for and what synthmodem has tested). **Against BinModem** (`bm-v22.js`,
whole calls from V.8): V.22bis and V.22, BOTH roles — V.8 agrees, both ends reach
2400 (V.22bis) or 1200 (V.22), and text crosses exactly in both directions.
**BinModem deviates once here:** at 1200 it connects as soon as it has heard 270
ms of scrambled ones, without the 765 ms §6.3.1.2.1 d) and §6.3.1.2.2 c) put
before data, so its first byte can precede a conformant receiver's readiness;
`bm-v22` holds BinModem's V.22 text a second for that reason.

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

## 5. V.32 — 9600 and 4800 bps, true full-duplex QAM

Source: `V32.js`, `V32Preface.js` (shared with V.32bis). Tests:
`tools/tests/v32test.js`; against BinModem, `tools/tests/bm-v32.js` (both roles,
every mode, with and without V.8; development only, SKIPs without Rust).

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
- **§5.4's half-duplex opening, both roles (`V32Preface.js`).** Before either
  conditioning signal, the answer modem alternates A and C (AC — lines at 600 and
  3000 Hz, nothing at 1800) and the call modem repeats A (AA — a bare 1800 Hz).
  - Call modem: silent until 1 s of answer tone or the 600/3000 tones (note 1),
    or straight to AA after V.8, whose ANSam was the answer tone. AA → first
    reversal in 600/3000 → CC 64 ± 2 T later → second reversal → NT, cease. On R1:
    S for NT, then the conditioning signal.
  - Answer modem: 75 ms after the answer tone, AC for an even count ≥ 128 T with
    1800 Hz heard 64 T → CA → reversal at 1800 → MT, and after an A, AC 64 ± 2 T
    later → amplitude drop → silent 16 T → conditioning signal and R1.
  - Each listens where its own signal is not, so its own 2-wire echo cannot be
    taken for the far end. Tone measurement is a 20-sample moving average at
    baseband (nulls every 400 Hz, so each of the three frequencies removes the
    other two exactly); a reversal is timed to the sample from the zero crossing
    of the phasor's projection, less the filter's constant delay.
  - The turnaround is scheduled on one sample clock for both directions (received
    sample n arrived when transmitted sample n left); if the transmitter has
    already generated past it, it goes out at the first free symbol and `late`
    records it. A reply is looked for from the moment our own turn was
    *generated*, plus an 8 T echo guard on the receive clock — **not** in a
    RESPONSE-wide window. ModemDSP's real-time pump sends in catch-up bursts, so
    the two clocks wander ±48 T, and a RESPONSE-wide window on either one missed
    the reply often enough to deadlock dsptest2.
  - The start-up receiver is gated until the opening hands over: the call modem
    hunts S once 1800 Hz stands beside 600/3000 (S is the first signal with all
    three), the answer modem once the call modem's CC drops. The S hunt now scans
    forward past a failed candidate — a buffer opening inside S failed its
    truncated first symbol for ever.
  - It was omitted as "echo-canceller only". BinModem showed why it is not: a
    real answer modem does not leave AC until it hears AA, and a call modem that
    is silent until R1 never gets one. The echo canceller is in now (§0); it trains
    on the first TRN, which this procedure is what makes quiet.
  - **The tone detections need a tone, not a level.** The answer modem's AA and the
    call modem's answer tone stand at 0.8 of the line's mean |x| (TONE_STAND). At
    STAND's 0.3, white noise (0.55) passed for AA: the answer modem counted 64 T
    before the call modem had sent anything, and its CA came too early for
    BinModem to see the reversal. A 2100 Hz tone on the 1800 watch reads 0.47,
    which the old bar also passed.
- **Circuit 109, ready, and the first data come 128 T after the FAR end's E**
  (§5.4.1: "On detecting an incoming 16-bit E sequence ... After a delay of 128
  symbol intervals ... ON condition to circuit 109 ... be ready to transmit
  data"). The call modem sends its own E first, so counting from that one put its
  first characters into the answer modem's own 128 — BinModem dropped them. Until
  then the UART is held off the received bits: the far end is sending only
  scrambled ones, and a decode error at the E-to-data change otherwise surfaces
  through the descrambler as a false start bit.
- **`ORIG_LEAD` is gone**, and so is the "silent until R1" call modem that
  replaced it: the opening above is what the call modem does first. The V.25
  answer tone is suppressed on the V.8 path and kept only for the forced/legacy
  path.
- **Against BinModem: both roles connect at 9600 and carry text exactly each
  way**, with and without V.8 in front (`bm-v32.js`). SynthLink answering
  connects in 2.4 s; SynthLink calling in 5.6 s, of which 3.3 s is BinModem's full
  V.25 answer tone.

**Full-duplex without an echo canceller** is the architectural win: real V.32 on
2-wire PSTN needs adaptive echo cancellation, and the 4-wire-equivalent transport
removes it. The idle-`0xFF` flood that forced V.29 to ping-pong is avoided the
honest V.32 way — V.32 is a **synchronous scrambled** modem (idle = scrambled
MARK) with async UART framing on top, so descrambled idle-mark yields no start
bit and therefore no phantom bytes while the carrier stays continuously up.

**Receiver acquires on S, then tracks:** timing and one complex channel-gain
estimate are taken from **signal S** — §5.2.2's "well-defined event" — and carried
through E into data mode without the carrier dropping, which is what removed the
invented 72-symbol preamble the data burst used to open with. From there they are
followed, not assumed: Gardner timing (no decisions, so start-up and data alike),
a decision-directed phase loop against S's four states in start-up, and a
complex-gain LMS against the sliced point in data. All are second-order. A far
clock off by §2's 0.01% turns the carrier 4.7·10⁻⁴ rad a symbol, and a first-order
loop answers that with a standing lag of a fifth of a V.32bis grid step. Gardner's
proportional step is small (0.005) because its pattern jitter on 128 points cost
4 dB at 0.04; the integrator carries the drift. `bm-v32` holds ±100 ppm both roles,
through the bridge's resampler. Which of S's two states the even samples landed
on is resolved from Table 1's +90° A-to-B step: the two answers differ by a
REFLECTION, not a rotation, so getting it wrong negates every differential decode
— the same hazard §10.1.3.7 answers for V.34.
Memory is bounded — the RX buffer is trimmed with `rxBase` advanced, and TX uses
a monotonic sample counter `txN` with a separate `txSymBase`, so trimming never
jumps the carrier phase.

### Deliberately out of scope (documented, not hidden)

- **Trellis coding at 9600 (§2.4.1.2), when both ends offer it.** Off unless
  `setTrellis(true)`, and then claimed as Table 6's B8 and used only if the far
  end's rate signal sets B8 too (BinModem's `agreed_coding` reads the same rule);
  otherwise 9600 is non-redundant, the mode 1 e) makes mandatory. Its pieces are
  V.32bis's 9600: Table 2/V.32 is Table 1/V.32bis, Figure 2's encoder is Figure
  1/V.32bis's, and Figure 3's 32 points are Figure 2-3/V.32bis, at Figure 1's
  energy. Decoded by `V32bisViterbi`. Against BinModem at 35 dB of noise the
  non-redundant mode garbles its text and the trellis reads it exactly.
- **4800 (§2.4.2)**: Table 1's quadrant change on Figure 1's four states, the
  start-up's own. Advertised beside 9600 (B5); `setMaxRate(4800)` forces it.
- **E is credible or ignored.** It must arrive after the rate exchange it ends
  (the call modem has heard R3, the answer modem R2) and name the rate R3
  settled on. At 36 dB of noise BinModem never left its own S̄, and a noise group
  that passed E's sync cells took this end into data alone. V.32bis has the same
  gate.
- **§5.5's retrain, both ways.** In data each end listens for the far end's
  retrain signal (`RetrainWatch`: the call modem for AC, 600 and 3000 Hz with
  nothing at 1800, the answer modem for AA, a bare 1800) held for more than 128 T,
  and answers it: AA straight away, or AC for 256 T (§5.5.2 asks at least 128;
  BinModem's call modem missed a reversal at 128), then §5.4 from its third
  paragraph. The UART stops taking bits once the cue has stood for 16 T, before
  any of it is decoded: without that BinModem's AA arrived as thousands of bytes.
  Circuits 107 and 109 stay ON, so the class stays ready, emits `retrain` and
  `retrained`, and queued bytes wait. This end starts one itself on
  unsatisfactory reception, BinModem's measure: the mean distance of each symbol
  from the nearest point above 0.30 of the closest spacing for a second (BinModem
  uses 0.25, tuned on its own receiver; ours reads 0.26 at 14 400 on a 2-wire
  line at 45 dB that it decodes exactly). Its rate signals then offer only the
  rates that error leaves room for, 4800 always. A retrain not back in data
  within 5 s is begun again: its own S can be lost in the noise that caused it.
  The call modem also ends R1's transmission when R1's sequences stop, where
  noise hides the carrier drop. Held by `v32-retrain-check` (SynthLink against
  SynthLink) and `bm-v32` (BinModem's retrain, and a noise burst both roles).
- **The first rate from the line** (§5.4.1: R2 "should also take account of the
  likely receiver performance"; §5.4.2 says it of R3). Through the far end's
  conditioning signal, past its first 512 symbols, this end measures each
  equalised symbol's distance from its state: four states far apart, so the
  line's own noise, in data units. Taken as each of the far end's rate signals
  arrives and frozen when this end first builds R2 or R3. A rate is offered if
  that error is under 0.85 of its retrain threshold; 4800 always is. While the
  error is still falling (by over 15% across 256 symbols) the equaliser is still
  learning and nothing is restricted: on a 12 dB tilt it read 9600's error just
  before R1, at a line that carries 14 400. Against BinModem the error in data
  comes within a few percent of it. V.32bis at 42 dB now comes up at 12 000 and at
  38 dB at 7200, both roles, where it came up at 14 400 and retrained.
- **An adaptive equalizer** (`SymbolEqualizer.js`): complex, T/2, ±8 symbols
  (±3.3 ms at 2400 baud), starting as the identity. It trains in start-up toward
  IDEAL states (S's received A turned by quarter turns; B as received is not A
  turned on a dispersive line) within a gate of 0.5. The gate is wide because the
  four states are a quarter turn apart, and at 0.15 a 12 dB tilt put TRN's first
  symbols outside it, so the equaliser never started. In data it runs
  decision-directed at a tenth of the step. S is confirmed by what a linear line
  leaves of it: a two-symbol period, two distinct states, and a mean beside their
  half-difference (AC has no mean). The constant-modulus test it replaced failed
  on any tilt, which weights S's 600 and 3000 Hz lines unequally. `bm-v32` holds
  the bridge's dispersive line (`disperse`, `lineFilter`) at 8 dB/1 ms and
  12 dB/2 ms, both roles, where our receive was garbage without it.
- **An echo canceller** (§0), on every call. NT and MT are
  measured but not used: the canceller places its far run by searching, not from
  the round trip. Tested against BinModem; not yet against hardware.
- **TRN at its minimum, 1280T.** §5.2.3 allows up to 8192T; the minimum is a legal
  choice, not an omission.

---

## 6. V.32bis — 14400 to 4800 bps, true full-duplex trellis-coded QAM

Source: `V32bis.js`. Tests: `tools/tests/v32bistest.js`; against BinModem,
`tools/tests/bm-v32.js` (every rate, both roles). Built directly on the
V.32 core — same carrier, baud, scramblers, acquisition, framing and connect
script. Only the per-symbol bit→point path and the rate signal differ.

### Genuine (verified against ITU-T V.32bis, 1991)

- **Five rates** (§2.3, §2.4): 14400, 12000, 9600 and 7200 at 6, 5, 4 and 3 data
  bits a symbol, trellis-coded, grouped Q1..Qn; 4800 at 2, uncoded.
- **Table 1/V.32bis differential** (exact, the trellis-coding variant, distinct
  from the 4800 Table 2): `TAB1[din][yPrev]=yNew` =
  `[[0,1,2,3],[1,0,3,2],[2,3,1,0],[3,2,0,1]]`. The decoder inverts it.
- **Convolutional encoder → Y0 — Figure 1/V.32bis's**, ported from BinModem's
  `trellis.rs` (read off the drawing, and read back by its Viterbi decoder): Y0 is
  T3's current contents; T1 ← T3, T2 ← T1⊕Y1⊕Y2⊕(T3·w), T3 ← w⊕(Y1·T3), with
  w = T2⊕Y2. The encoder it replaced was an invented 8-state FSM. Any deterministic
  FSM puts a valid-looking point set on the line, and this repo's receiver slices
  without Viterbi, so loopback read it perfectly; BinModem's Viterbi decoder
  followed the wrong trellis path on every symbol and turned 14 400 bit/s of idle
  marks into a flood of bytes.
- **Line level −10 dBm0** (§1, `LineLevel.js`), V.32's. It was −20 dBFS, and
  BinModem's V.32 tone detectors did not hear the AC/CA reversal at it. Then
  −14 dBFS, which this file called −10.7 dBm0 by leaving out μ-law's +3.17 dB
  offset; it was −7.6, over the usual −9 ceiling.
- **128-point constellation — Figure 2-1, point for point.** Transcribed from
  the Recommendation and indexed by the figure's own bit order Y0Y1Y2Q3Q4Q5Q6.
  The points lie on the checkerboard lattice **Re+Im odd**, |Re|,|Im| ≤ 9, mean
  energy exactly 41 — not an odd-integer grid. Asserted at module load: 128
  distinct points on the lattice, and the rotational structure the differential
  coding requires (90° preserves Q3..Q6, flips Y0, advances Y1Y2 by one
  quadrant; 180° preserves Y0 and Q3..Q6), all 128/128.
- **The lower rates' constellations — Figures 2-2, 2-3 and 2-4, point for point.**
  Read off the Recommendation's drawn figures by the position of each label on the
  page (the method reproduces Figure 2-1 128/128 first), indexed the same way:
  2-2 is the odd 8×8 square (64 points, mean energy 42), 2-3 the 32-point cross on
  the checkerboard (10, Figure 3/V.32's), 2-4 the odd 4×4 square (16 points, 10).
  `v32bis-viterbi-check` holds each against BinModem's `trellis.rs` table of it
  (POINTS_64, POINTS_32, POINTS_16), all agree. Each is scaled to Figure 2-1's
  mean energy, 41, so a change of rate is not a change of line level (BinModem
  does the same). The module-load checks run on every figure: distinct points, on
  the figure's lattice, and the 90° rotation structure, per rate.
- **4800 — Table 2/V.32bis on Figure 2-5's four states**, no trellis: the dibit
  turns the quadrant (00 +90°, 01 0°, 10 180°, 11 270°), the same coding the rate
  signals use.
- **Scramblers GPC/GPA** (§4): identical to V.32, golden-verified.
- **The Recommendation's own start-up, §§5.2–5.3 and §6** — the same clauses as
  V.32, word for word, so the signals come from `V32Startup.js`: S 256T, S̄ 16T,
  TRN ≥1280T on Figure 2-5's A B C D states (which are Figure 1/V.32's four
  points), then R1/R2/R3 with **Table 5/V.32bis**'s genuine bit positions —
  `B5=4800, B6=9600, B9=7200, B10=12000, B12=14400` plus the sync cells — ended by
  Table 6/V.32bis's sequence E. On the wire as §5.3's 16-bit sequences, scrambled
  and differentially encoded, not as a `DLE 'R' hi lo` control frame. §6's
  procedure is in `V32bis.js`. R3 and E name the highest rate both ends
  advertise; the receiver codes at the rate the far end's E names.
  `setMaxRate(bps)` lowers this end's ceiling, before start-up.
- **Figure 2-5's states are scaled to Figure 2-1's energy.** The two are separate
  signal-space diagrams at different scales — mean energy 10 and 41 — and one modem
  has one line power, so the conditioning signal and the rate signals are scaled by
  `sqrt(41/10)`. V.32 needs no such factor: there both come from Figure 1.
- **§6's opening and the 109 timing are V.32's** — `V32Preface.js`, and ready /
  first data 128 T after the far end's E. See §5.
- **Against BinModem: both roles connect at every rate and carry text each way**
  (`bm-v32.js`), clean and on a 2-wire line with noise at 45 dB. Our receive is
  exact at every rate on every line tried (±100 ppm, 12 dB tilt with 2 ms of
  delay). BinModem as the CALL modem frames a byte or more of its own at its
  E-to-data change at the lower rates: it does the same against itself
  (`MAX_RATE=7200 PROTO=v32bis SECS=16 node tools/bridge/bmbm.js`).

### Deliberately out of scope (documented, not hidden)

- **Viterbi, 8 states** (`V32bisViterbi`, ported from BinModem's `v32/trellis.rs`
  `Decoder`), depth 24 symbols. Its trellis table is built from `convEncode`
  itself, so the two cannot drift apart. Table 1's differential decode runs on its
  decided Y1 Y2. The tracking loops steer by the best path's guess at the newest
  symbol (BinModem's `tentative`), because they cannot wait 24 symbols.
  `v32bis-viterbi-check`: at σ 0.35 per dimension, 0.025% of symbols in error
  against the slicer's 13%. Points from another 8-state code err on 37%. Against
  BinModem, noise at 45 dB is exact both ways, 4-wire and 2-wire, where the
  slicer lost every byte. At 42 dB BinModem retrains on its own view of our
  signal.
- **The adaptive equalizer, and timing, phase and gain track** (as V.32). In
  data the equaliser follows the Viterbi path's guess at the newest symbol. Its
  step is geared to the error it measures: up to ×3 in training and ×4 in data,
  back to the fine step as it settles. On a 12 dB tilt the call modem's one TRN
  had left it at 0.45 of a spacing going into data.
- **E names one rate.** A group of E's shape naming several is a corrupted rate
  sequence and is read past (`RateFramer`). On a dispersive line, before the
  equaliser had settled, one took the call modem into data while BinModem waited
  for our E.
- **§7's retrain is V.32's §5.5, and the first rate comes from the line,** as in
  §5. §8's change of rate without a retrain is not implemented.
- **An echo canceller, for a 2-wire line** (as V.32). Tested against BinModem; not
  yet against hardware.
- **TRN at its minimum, 1280T** (§5.2.3 allows 8192T).

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
  rotates the second 2D point of each 4D symbol. **Figure 9's Im = +1 row had its
  middle two labels swapped** until BinModem's encoder disagreed with ours on the
  third 4D symbol of a frame. The receiver discards U0, so no loopback could see
  it. `V34Mapper.js` now asserts at load the two properties the figure has to
  satisfy — every point of Figure 5's quarter has low label bits 00, and a quarter
  turn clockwise adds one to the low two bits and keeps the high one — and the old
  row fails both.
- **Superframe synchronisation (§9.6.3, Table 12, eq. 9-32):** U0 = Y0 ⊕ C0 ⊕ V0,
  V0 the bit-inversion pattern at the first 4D interval of each half data frame,
  counted from B1 as "the last data frame in a superframe" (§10.1.3.1).
  `v34-superframe-check` holds the pattern at its printed digits and reads the
  inversions back off transmitted points with an independent Figure 10 encoder.
- **The data-mode encoder is bit-identical to BinModem's** — §9's parser, shell
  mapper, differential encoder, mapper, trellis and superframe inversions, from B1,
  both scramblers, all four rates. `v34-encoder-vector-check` holds it against a
  committed vector written by BinModem's encoder, and needs no Rust.
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
- **A Viterbi decoder** (`V34Viterbi`, §9.6's 16-state code). It is built from
  the transmitter's own definitions, nothing restated: Figure 9's labels, Table
  13's 4D subsets, and Figure 10's encoder. The redundant bit lives in the label
  pair, (s0 ⊕ s1) & 1 = Y0 ⊕ V0, which is equation (9-32)'s U0 with the
  superframe inversion. I measured that on every 4D symbol our encoder makes
  before relying on it.
  - From state s the allowed pairs have parity (s & 1) ⊕ V0, and branch metrics
    depend on the state only through it: 64 pair evaluations and 64
    add-compare-selects per 4D symbol.
  - Traceback is 40 4D symbols (80 2D symbols late). The decision-directed loops
    still use the immediate hard slice, and a decision off the constellation's
    edge falls back to it.
  - Against our encoder with Gaussian noise (`v34-viterbi-check`): no errors in
    12 000 symbols at σ = 0.42, where the hard slicer errs on 3.3%, about 3.2 dB.
    A decoder with V0 one 4D symbol out errs on 2.5%.
  - Cost: 0.4 ms of receive per 20 ms block in data mode.
  - The rate rule's bound rose to σ² ≤ 0.25 with it. V.90's µ-law upstream now
    runs 26 400 (was 24 000); forced to 28 800 it still errs, which is what the
    bound predicts.
- **A receive equaliser** (`_eqReset`): T/2-spaced, complex, 25 taps over ±6
  symbols on the matched filter's output, starting as the identity. Six because
  2 ms of edge delay is seven symbols at 3429 baud. At ±4 the 12/2 line trained
  at ε 9.8·10⁻³, 10 dB under BinModem's own receiver on the same line at the same
  SNR; at ±6 it trains at 1.7·10⁻³ and takes the same rate as BinModem does.
  - It trains normalised-LMS on every Phase 3/4 symbol that sits clearly on one of
    S's four points, gated by the size of its error so that PP is skipped. It runs
    decision-directed in data mode at a tenth of the step.
  - Its training targets are the IDEAL points: S's first point turned by quarter
    turns, not S's second point as measured. On a filtered path S itself is read
    with ISI, and aiming at both points floors the error at 0.012 where least
    squares reaches 0.0003.
  - Measured first. BinModem's Phase 4 TRN reached our slicer with 6.4% rms
    scatter, because its pulse shaping is not our RRC. The 33 600 lattice's
    half-step in those units is 0.037. Least squares on that TRN gave 1 tap 0.091,
    9 taps at T/2 0.0031, 17 taps 0.0022. The earlier reading of "30 dB SNR" came
    from fitting on data, where decisions from garbage have nothing to converge to.
- **Timing and carrier tracking** (`TRK_*`, `_trkTiming`, `_trkPhase`). The far
  end's clock is its own. At ±100 ppm the carrier turns 0.2 Hz, out of Phase 3's
  decision regions in 0.6 s, and the instant walks a sample a second.
  - Carrier: a second-order rotator after the equaliser. The equaliser's targets
    are turned back by the same angle, so the equaliser never learns the rotation.
    It is the only loop that turns phase: data mode's gain now follows the level
    alone, because a complex gain update was a third phase loop and the split
    wandered. In Phase 3 it has its own gate (0.5 rad), looser than the
    equaliser's, or a turning carrier leaves the gate and nothing brings it back.
  - Timing: Mueller–Müller on the derotated output and its decision (Phase 3's
    ideal point, data's slice), second-order. Gardner was biased on V.34's narrow
    pulse and learnt a drift at 0 ppm. The equaliser's tap centroid is too slow in
    data mode to steer by. The burst's base moves in 1/256-sample steps, because
    the polyphase banks are exact per base and 1/32 was the whole of 33 600's error
    budget.
  - `bm-v34` [5]: ±100 ppm, each symbol rate, both roles, each at its ceiling with
    text exact both ways. A SLOW far clock still costs ε (2·10⁻⁴ against 5·10⁻⁵) and
    is not explained; the resampler is symmetric to −75 dB at 3400 Hz.
- **The equaliser is SOLVED on PP, not only adapted** (`_p3Solve`, ported from
  BinModem's `receiver.rs`). PP is known from its first symbol, so at the far
  end's first S-to-S̄ the receiver takes 200 of PP's symbols, after 48 while the
  line's memory fills, and least-squares fits the 17 taps outright at each
  alignment within ±4 symbols of where S̄ put PP.
  - Among fits within twice the least error it keeps the most centred one.
    Fits at several shifts are nearly equal, and the least error alone took one
    with its taps at an end.
  - A second pass measures the constellation's turn from the residual phase early
    and late, refits with it, and hands the turn to the carrier loop. At −100 ppm
    the loop's half-learnt turn had left 1.5·10⁻³ where 10⁻⁴ is usual.
  - Kept only if its error is under 0.01. A misplaced PP fitted at 0.04, and
    taken, it cost a rung.
  - S's references are then read again through it, and the S̄ direction the J
    decoder uses is resolved again against them, by scanning for the first S̄-like
    symbol. The equaliser's delay can sit at half a symbol, so no parity rule names
    A and B reliably; re-resolving makes any naming consistent.
  - The timing detector's power average restarts, because the output domain
    changed (the transmitted level, about 40 times the received one).
  - The next burst (Phase 4) starts from the solved taps, since the line has not
    changed, and trains from there as usual, coarse step first. Begun from the
    identity it fought the loops; begun at the fine step it measured a worse ε.
- **S is confirmed by what a linear line leaves of it**, as in V.32: a two-symbol
  period, two states, and a mean beside their half-difference. The
  constant-modulus test failed on any tilt. **S̄ is also found raw**
  (`_rawSbar`): a symbol against the one two before it is +1 through S and
  through S̄, and the opposite only across the change. On a badly dispersive line
  the rotation detector never sees twelve clean S̄ alternations; this places PP
  there, and the rotation detector's position overrules it where it has one. The
  change's edge is smeared: a shallow value before the dip must not reset the
  count of S behind it, and S̄ is confirmed by 4 of the next 6 back above +0.5.
- **A wide search where the narrow one fails** (BinModem's): every alignment
  within ±40 symbols scored by correlating the raw samples with PP, and the best
  three solved. Under heavy smear the dip can put PP a dozen symbols out.
- **The S hunt keeps going after a rejected candidate.** A rejected onset is
  stepped 4 symbols on and the next one is tried at once. It used to be tried on
  the next block, which brings 68 new symbols. So an onset that fired early, on
  the line's tail before S, fell further behind every block and never reached S.
  BinModem gave up waiting for our S (12/2, call modem).
- **The training measure outlives its burst.** The call modem measures ε on the
  answer modem's Phase 3, and its MP goes out after the silence that ends it,
  which resets the equaliser. The measure used to be lost with the reset, so the
  call modem always offered its configured rate and only the far end's receiver
  limited it. It is now kept (`_eqMeasured`), and each end caps the rate from
  what it measured.
- `bm-v34` [8]: 4/0.5, 8/1, 10/1.5 and 12/2 (dB, ms), both roles, text exact, with
  BinModem at a modem's −10 dBm0 (`bmOutDb: −13`). Each case must reach at least
  what BinModem reaches against itself on the same line at the same SNR: 28 800,
  26 400, 26 400 and 24 000. We take exactly those. `bmbm.js` runs both
  BinModems at their own +3 dBm0, 13 dB hotter than any modem. At that level they
  cross every one of these lines at 33 600. Run fair (`noiseDb` 13 dB lower),
  they take the rates above. Section [8] used to run at BinModem's +3, and that
  hid both faults above.
- **An echo canceller** (§0), on every call. It trains on Phase 3's
  PP and TRN: the answer modem's are sent before it has heard the call modem's S,
  and the call modem's after the answer modem must have fallen silent on our S̄.
  For the call modem that is TRN only, because the answer modem stops its J a round
  trip after our S̄, so the start of our PP is under it; training through it left
  9.6 dB. The search skips PP, which repeats every 48 symbols. `bm-v34` [7] runs
  both roles at 28 800 through our own echo at 0 and 25 ms.
- **No probing ANALYSIS**, though the probing signals and the INFO exchange that
  carries their results are real (Phase 2, below): L1 and L2 are transmitted to
  Table 17 and nothing is measured from them. **No non-linear warping** (§9.7),
  **no auxiliary channel**, though **§11.5's retrain and §11.6's renegotiation
  are implemented** (below), and with them a rate per training, not per call —
  and **Phase 1 is a real V.8 exchange** (§9), and
  **Phases 2, 3 and 4 are §11's own procedures, signal-gated at both ends**
  (below).

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
- **L2 is RECEIVED for 200 ms**, a legal short value of §11.2.1.1.5 /
  §11.2.1.2.8's "not to exceed 500 ms", which has no floor. At the full 500 the
  tone that ends the peer's L2 arrives after §11.2.2.2.3's 600 ms bound has fired —
  about one run in twenty, seen as the peer restarting §11.2.1.2.3.
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

**The procedure is §11.3's and §11.4's, and every step waits on a SIGNAL.** The two
modems' procedures are different sequences:

| | Phase 3 | Phase 4 |
|---|---|---|
| **Answer** | 70 ± 5 ms silence, S, S̄, [MD, S, S̄], PP, TRN, J until the call modem's S-to-S̄ (§11.3.1.2.1–.4), then silence | on the call modem's J: S 128T, S̄ 16T, TRN ≥ 512T, MP until its MP, MP′ until its MP′ or E, E (§11.4.1.2) |
| **Call** | silent; S, S̄, PP and TRN received, then **on the answer modem's J** (§11.3.1.1.3) S, S̄, [MD, S, S̄], PP, TRN, J until the answer modem's Phase 4 S followed by S̄ (§11.3.1.1.7) | continuing: one J′, TRN ≥ 512T, MP until its MP, MP′ until its MP′ or E, E (§11.4.1.1) |

Each end's data mode then follows its E in the same transmission, B1 first. J is
read off the receiver as two consecutive repetitions of one of Table 18's two
patterns, and which one it is sets the size this end sends TRN, MP, MP′ and E in:
4 or 16 points (§10.1.3.8, §10.1.3.9). This modem's own J asks for 4; BinModem's
asks for 16, "as both real modems asked of theirs", and gets it. E is the first
twenty ones after the far end's acknowledgement (MP′, or V.90's CP′), and B1
starts on the symbol after it.

The receiver locks timing on S, classifies each symbol against the four rotations
of point 0, counts S / S̄ runs and differential-decodes the bit stream J, J′, MP, E
and V.90's Ja ride on, across any silence between them; it re-acquires on the next
S after one. It measures nothing — PP trains an equaliser and TRN refines one — so
an interop receiver adds a measurement behind a transmitter that is already the
Recommendation's.

**Divergences, stated:** every recovery deadline is the clause's — §11.3.2.1.1's
2800 ms for J, §11.4.2.1.1's 600 ms + RTD for the answer modem's Phase 4 S,
§11.4.2's 2500 ms + RTD for E — and the action on expiry is the clause's, a
retrain (§11.5, below; `_startupTimeout`). It is scheduled for the next block,
only once Phase 2 has run (its INFO0s are what a retrain keeps), and at most twice
in a row; past that the modem proceeds as it used to, a call that may still train
where hanging does not. The far end's retrain tone is watched for from Phase 3 on,
not only in data mode, so ours answers one begun in start-up. None of these bounds
fires in any call of the suites; `v34-retrain-check` swamps the line early in
Phase 3 and in Phase 4 to make §11.3.2.1.1 and §11.4.2.1.1 fire, and both calls
come up. BinModem's own start-up bounds end its call rather than retrain, so the
bridge cannot hold this against it.

### Phase 4 — the MP exchange (§11.4), and data mode from B1

MP, MP′ and E ride §10.1.3.9's 4- or 16-point form, differentially encoded from the
final symbol of the TRN before them. The receiver is the Phase 3 decoder unchanged
— frame sync plus CRC finds MP in the same bit stream J and Ja arrive in. Each end
reads the other's MP *and* its MP′, so the exchange establishes agreement rather
than decorating it, and a disagreement on trellis, Θ or shaping is recorded rather
than silently decoded wrongly.

**A sequence is sent at least twice, and that is not padding.** TRN is not
differentially encoded, so the receiver's self-synchronising descrambler spends its
first 23 bits recovering after it; a sequence sent once is the sequence that gets
eaten. It is the same reason §10.1.3.3 makes J "a whole number of repetitions".

**Data mode is entered at B1, from the training, in the same transmission.**
§10.1.3.1: B1 is "one data frame of scrambled ones", sent with the scrambler,
trellis encoder, differential encoder and precoder at zero, and its first mapping
frame is time index i = 0 (§8), which the switching pattern and the superframe
inversions count from. The receiver keeps S's timing and gain — §10.1.3's NOTE has
the power of Phases 3 and 4 "maintained in segment B1 and the subsequent data
mode" — so it reads data with no acquisition of its own, and keeps B1 away from the
UART, which is armed as B1 ends because B1 is an idle line. **Gone:** the invented
data preamble (alternating and constant REF points), the 80 ms gap before it, and
the `DLE 'D'` data-mode mark. A real V.34 sends none of them.

### Retrain (§11.5)

From data mode, in either role, begun by this end or answered:
- **Beginning one** (`retrain()`, or on its own, below): circuit 106 off, 70 ms
  of silence, then this modem's tone and Phase 2 from §11.2.1.1.3 (call modem,
  tone B) or §11.2.1.2.3 (answer modem, tone A). The INFO0s stand from the call's
  start. Phases 3 and 4 run again in full, a new PP solve and a new MP, so the
  rate is chosen again from the new training.
- **Answering one**: the far end's tone, held more than 50 ms, read by a one-pole
  resonator at that tone against the total power (`_retrainWatch`). Data leaves
  about 2% of its power in the 30 Hz slot. Tone B is all of its own, and tone A
  under half, because §10.1.2.1 sends it 1 dB under its 1800 Hz guard. The
  threshold is 0.3. Then the same entry as beginning one: §11.5.1.2 and §11.5.2.2
  name the same steps.
- **On its own**: when the receiver can no longer hold the rate. That is the
  slicer's error per dimension over 512 symbols above 0.29 for a second of
  symbols. A slicer's error saturates: noise that has swamped the lattice lands
  uniformly in a cell and reads 1/3, while a line at the rate bound (σ² 0.25)
  reads about 0.235.
- **Circuit 104 clamped**: while the same error over 16 symbols is above 0.5
  (silence reads near 1), the receiver passes marks. The far end's 70 ms of
  silence before its tone used to reach the terminal as a few random characters.
- `carrying` is false from the retrain's start to the far end's B1, and V.42
  suspends its timers meanwhile (ErrorControl.js). The status line shows the
  retrain's own steps (Handshake defers to the protocol while it is not carrying).
- Not done: V.90's retrain, which is §9's (an instance on another Recommendation's
  Phase 2 never retrains).
- `bm-v34` [9]: BinModem retrains and we answer; we retrain and BinModem follows;
  our direction degrades to 48 dB and we retrain on our own and come back lower.
  Each in both roles, with text exact both ways after. `v34-retrain-check` holds
  the watcher alone and the same calls SynthLink against SynthLink, and `bm-whole`
  holds V.42 through one. The slicer-error figures above are per dimension: a line
  at the rate's own bound (σ² 0.25 over both) reads about 0.125.

### Rate renegotiation (§11.6)

S for 128T, S̄ for 16T, TRN, MP, MP′, E and B1 from data mode: Phase 4 again,
without Phase 2, PP or a silence, in the 4-point form whatever J asked.
- **Beginning one** (`renegotiate(maxBps)`, or on its own, below): Phase 4's tail
  is taken up INSIDE the data burst. The carrier and the symbol clock carry on,
  because the far end's data receiver is what has to find S. A burst begun
  afresh moved both, and BinModem decoded our S as data.
- **Answering one**: the far end's S found inside data mode, as a two-symbol
  alternation over 24 symbols (`_sInData`), which scrambled data cannot hold. By
  then most of S's 128 symbols are gone, so the receiver rewinds 56 symbols in the
  buffer it keeps and takes them as a new burst's, from the equaliser it has. Our
  own S follows the far end's S-to-S̄ (§11.6.1.2.2).
- **Received data is held 56 symbols** (about 16 ms at 3429 baud) before the
  UART. That is how late S is found, and what was decoded of it is dropped.
- **The rate**: each end's MP offers what its data-mode error allows, capped by
  `maxBps` for the one that begins.
- **On its own**: a line worsened past the rate's bound (the slow error above
  0.16 per dimension, against the 0.125 a rate is chosen at) for a second is
  renegotiated down. Past 0.29 it is a full retrain instead.
- **Falling forward**: below the configured rate, and only where this end's own
  receiver stepped it down, a data-mode error that has left room for a higher
  rung for 5 s (its error at most 0.7 of that rung's bound) is renegotiated up,
  no sooner than 10 s after the last change. A step up the far end's MP held back
  doubles the wait before the next. Under noise that stays, the rate stays.
- §11.6.2: a renegotiation not back in data by 6 s is a retrain.
- `bm-v34` [10]: BinModem renegotiates and we follow; we renegotiate and it
  follows; our line worsens to 55 dB and we step down in place; it worsens for
  five seconds and we step down, then back up to 33 600. Each in both roles, in about 400 ms, with text exact both ways after. `v34-retrain-check`
  runs either end beginning, SynthLink against SynthLink.

### Rates, the ladder, and 33600 frame switching (§8.2 / §9.3.1)

**The ladder.** Every rate is derived from the rules printed beside Tables 7–10,
not read from the tables, by `V34Mapper.framingFor`:
- N = R·0.28/J, b = ⌈N/P⌉, r = N − (b−1)P;
- SWP is the counter (add r at each of P frames, mark the frame at P, first frame
  most significant);
- K = b − 12 − 8q, with q the least that brings K under 32;
- M = ⌈2^(K/8)⌉.

Each result is held against a row TRANSCRIBED from the printed Table 10 (`T10_MIN`),
so a wrong rule fails at load. The rows: 2400 → 14 400–21 600; 3200 → 19 200–31 200;
3429 → 19 200–33 600 (b > 12 only). Our encoder is point-for-point identical to
BinModem's at all 17, both scramblers (`v34-encoder-vector-check`, 34 cases).

| Rate | S (baud) | b | K | M | q | L | SWP | switching |
|---|---|---|---|---|---|---|---|---|
| 19200 | 2400 | 64 | 28 | 12 | 3 | 384 | FFFF | no |
| 28800 | 3200 | 72 | 28 | 12 | 4 | 768 | FFFF | no |
| 31200 | 3200 | 78 | 26 | 10 | 5 | 1280 | FFFF | no |
| 24000 | 3429 | 56 | 28 | 12 | 2 | 192 | FFFF | no |
| 26400 | 3429 | 62 | 26 | 10 | 3 | 320 | 2D6B | yes |
| 28800 | 3429 | 68 | 24 | 8 | 4 | 512 | 0421 | yes |
| 31200 | 3429 | 73 | 29 | 13 | 4 | 832 | 3DEF | yes |
| 33600 | 3429 | 79 | 27 | 11 | 5 | 1408 | 14A5 | **yes** |

(A selection; the full ladder is in `V34Mapper`.) The constant-b check is §8.2's
own, bP = N, because b·3429/8 is not the bit rate: 3429 is 24000/7 rounded.

**Mean energy is computed, not measured** (`meanEnergy`). The K shell bits are
uniform over [0, 2^K) in a high frame and [0, 2^(K−1)) in a low one, so a
stratified pass gives every ring's frequency; within a ring the labels are
uniform; and r of P frames are high. It agrees with BinModem's analytic figure to
1·10⁻⁴ at every rate. Under §10.1.3's NOTE this is what ties training power to the
data lattice, so a RECEIVER needs it for the rate it receives.

**The rate is per call and per direction.**
- The symbol-rate front end stays module-level: filters, carrier, Phase 3/4 gains.
- Each instance carries its data-rate configuration (`dataCfg`): coders, framing,
  labels, the transmit scale that keeps data at training power, and the receive
  normalisation. It also captures its line gains at construction, because a later
  construction re-sets the module globals under a running call.
- **The receiver chooses.** Its equaliser trains EQ_COARSE symbols at a coarse
  step, then at a fine one, and ε = err²/|point|² is measured in the fine stage.
  At the coarse step a clean link's error is the equaliser's own adaptation noise
  (BinModem's V.34: 3·10⁻⁴ coarse, 5·10⁻⁵ fine), while a noise floor does not
  move.
- In lattice units the noise is σ² = ε·meanE(rate). The MP offers the fastest
  rate with σ per dimension at most a quarter of the half-step (z ≥ 4, σ² ≤ 2/16),
  latched at the first MP.
- The agreed rate is the highest ladder rung within both MPs (symmetric, bit 50
  clear): the lowest of all FOUR maxima, both of the peer's fields as well as
  ours. Taking only the field for the direction we receive ran us at 33 600
  against BinModem's 28 800 on a noisy line (`bm-v34` [6]). A call modem whose MP goes out before enough fine training offers the
  configured rate, as before.
- **The symbol rate is per call too, from INFO1.** Each front end (SPS, carrier
  table, RRC banks, rolloff, span, line gains) is built once per rate and kept.
  An instance installs its own at every public entry, and again after every
  emit, since a listener can build another call. JavaScript runs one method at a
  time, so the module bindings act per call. `_p2Settle` swaps to INFO1's choice
  before Phase 3, at the fastest ladder rate there within the ceiling, and resets
  the receive buffer, whose baseband was mixed with the old carrier.
- **The configured key is a ceiling in both halves.** INFO0's 3429 bit, INFO1c's
  per-rate maxima (Table 15's 0 = "cannot be used") and our INFO1a choice offer
  nothing above it.
- **Two bugs this exposed, both invisible at 3429.**
  - Our INFO1a said `highCarrier: 0`, the low carrier at 3200 (1829 Hz), while
    our front end demodulates the high one (1920 Hz). At 3429 Table 2's two
    carriers are the same.
  - The S hunt retried a rejected onset for ever, so a buffer opening on the far
    end's start-up transient never acquired. It now steps past the candidate, as
    V.32's does.
- **Against BinModem, all three symbol rates in both roles carry text exactly**
  (`bm-v34` §4). A 3200 call stays exact while a 3429 instance is built and
  stepped mid-call.
- **2400's matched filter spans 24 symbols, as 3200's does.** At 10, the
  truncated filter left 2400's receiver at ε ≈ 1·10⁻³ against BinModem, ten times
  the other rates. Its rate rule correctly read that as two rungs of noise: the
  answer role ran 16 800. A longer equaliser made it worse (1.6·10⁻³), which is
  what pointed at the filter rather than the channel. At 24 it measures 1.2·10⁻⁴
  and runs 19 200 in both roles.

**31200/3200** is fully spec-correct: the same 3200 front-end as 28800, constant
`b`, just a larger 1280-point constellation.

**33600/3429 frame switching** is genuine §8.2: the switching pattern selects,
per mapping frame, whether it carries `b`=79 or `b−1`=78 data bits. A low frame
draws K−1 real shell bits and **inserts a forced 0 as the high-order
shell-mapper bit** (§9.3.1), so the shell mapper always sees K bits and the I/Q
parser is identical either way. Both ends drive the pattern from a **frame
counter that is 0 at B1's first mapping frame** (§8), and on the drift-free clock
the high/low parity stays in lockstep. The differential/trellis
state advances per 4D symbol regardless of parity. The **timing search on S
runs at SPS/64**, not SPS/16: the sharp 3429 eye tips the slicer at a ~0.07-sample
timing error, which the coarser grid could not resolve (≈99 % symbol errors → 0).
That is a finer one-time search, not timing tracking, and leaves 2400/3200
unaffected.

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
right-most bit is 1: 33600/3429 → N 1176, P 15, b 79, r 6, long-run average b =
78.4. **Against BinModem** every 3429 rung from 19 200 to 33 600 connects with
text exact both ways, in both roles (`bm-v34` §3).

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
  halves of .1.6 and .2.4, whose remedy is a §11.5 retrain, and now get one:
  the call modem's L2 bound, its INFO1a bound where no INFOMARKSa was heard, and
  tone B arriving during the answer modem's INFOMARKSa. A step holds (`stay`)
  until the scheduled retrain takes the line at the next block. A burst over the
  INFO1 exchange sets off both modems' (`v34-retrain-check`), and the call comes
  up.
- **Against BinModem** (`tools/tests/bm-v34.js`, a peer that has connected to
  real modems): in both roles, Phase 2, Phase 3 and Phase 4 complete and BinModem
  reports `Connected { transmit: 33600, receive: 33600 }`; SynthLink enters data
  mode at BinModem's B1; and **text crosses exactly in both directions at 33 600**.
  With the equaliser frozen at the identity, BinModem → SynthLink is garbage in
  both roles. Untested against real V.34 hardware.

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

**Before the rules, two differential codings (§5.4.5.2–.4).** Table 4's odd-bit
chain: each odd-numbered bit is added to the odd bit before it, the previous
shaping frame's last where this one has none. Then t_j(k) = p′_j(k) ⊕ t_(j−1)(k),
position by position against the shaping frame before. Both chains run for the
whole connection. **These were missing at both of our ends**, so a loopback
agreed, and with shaping on BinModem's decoder read our signs wrong from the second
frame on. It surfaced on a V.90 retrain, where BinModem's CPt asked for Sr 1, and
our MP was never found. `v90-encoder-vector-check` now holds V90Coder against
BinModem's encoder codeword for codeword at Sr 0 to 3 and lₐ 0 to 3, and decodes
BinModem's frames back to their source. The pre-fix coder fails 24 of 48.

**The shaper costs no data.** Undoing the second differential leaves a frame off
by two consecutive rules' difference, which the trellis keeps to nothing, all, the
even bits or the odd bits. Position 0 was sent as 0 and reads what the even bits
are off by, and the odd bits come out by the same once Table 4's chain is undone
across the frame boundary. The receiver never needs the rule (after BinModem's
`SignDecoder`). lₐ is an **encoder-side choice only**: it changes which legal
rule sequence is chosen, never how it is decoded. But it delays each frame by lₐ,
so a Phase 4 signal's last lₐ frames are still in the encoder when its bits run
out. The digital modem flushes them after Ed, before B1d starts the coding afresh,
as BinModem's does. Without the flush, an analogue modem whose CPt asks for lₐ 1
(BinModem's does) never sees Ed. Our own analogue modem asks for lₐ 0 in CPt for
that reason. Measured effect with the default b₁ = −1: **−23.2 dB** in
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
  probe, and are INTERLEAVED across chords rather than ascending, so the level
  does not climb through the DIL. Every segment shares one chord-independent
  REFc, Ucode 120: 3.6 dB of headroom, and never a training Ucode (≡ 8 mod 16
  against 2, 6, 10, 14). L_SP and L_TP are maximal-length sequences of 127 and
  125 bits from two different primitive degree-7 polynomials — coprime with the
  six-symbol data frame, so the probe walks all six intervals (the impairments
  DIL exists to find are per-interval), and coprime with EACH OTHER, so the pair
  never repeats inside a 768-symbol segment. Equal periods are the trap: 127 and
  127 from different polynomials repeat together regardless of content. Measured
  on the wire: level spread 58.1 → 4.2 dB and spectral flatness 0.037 → 0.549,
  where a real modem's Phase 3 (the Conexant capture) is 0.369 — and calibrated
  against each side's own data mode, DIL/data is 1.13 in both. U_INFO stays 111:
  §8.4.4 fixes the Sd-to-TRN1d step, so U_INFO moves the pair together and cannot
  close it, and 111 is the only value that leaves both inside the DIL's band.
  `v90-dil-level-check` asserts the character structurally.

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
until MP′ or Ed → §8.5.3's 20-bit **E** → **B1** (§8.5.1 is §10.1.3.1/V.34) and the
upstream's data mode, in the same transmission. Every transition is the far end's
signal. The digital modem's upstream receiver reads the analogue modem's Phases 3
and 4 as one procedure across §9.3.2.4's silence and enters data mode on its E,
which follows CP′ — so its CP′ hunt runs on past its own Phase 4 until CP′ has been
read.

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

**CPt's rate is coded (drn + 8)·8000/6, not CP's (drn + 20)** (Table 14, bits 20:24),
with Table 17's K from 6 to 24 (`trainingConfig`). Both ends here read +20 once, so
loopback agreed; BinModem's CPt at drn 22 (40 000, K 24) showed it. This modem's
analogue side writes CPt at data mode's S with K capped at 24.

**Sr = 0 signs are differentially coded** (§5.4.5.1: "$0 = s0 ⊕ ($5 of the previous
data frame); $i = si ⊕ $i−1"; §5.4.6, 1 is positive), starting at zero wherever
TRN2d and B1d restart the coding. Both ends here put the sign bits on the wire as
they stood, so loopback agreed and BinModem's decoder read no MP.

**The CP hunt waits for a whole candidate.** CP is one to six constellations long,
so a frame sync cannot be judged until its longest form has arrived.
`BitFrame.findSequence`'s predicate may return null ("not yet"), and the scan then
resumes at that candidate. It used to return false, which rejected every
six-constellation CP as its sync went by, 800 bits before its CRC arrived.

- **CP (Table 14)** — 292 bits for one constellation: a 17-one frame sync, then
  17-bit groups (start bit 0 plus 16 payload bits). Fields at their literal
  positions: `19` CP/CPt, `20:24` drn (rate = (drn+20)·8000/6 in CP, (drn+8)·8000/6 in CPt), `31:32` Sr, `33`
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

### Retrain (§9.5)

From data mode, either modem, begun by this end (`retrain()`) or on the far end's
tone held more than 50 ms. In V.90 the analogue modem plays tone A's part and the
digital modem tone B's (§9.2), so each watches for the other's. V.90's start-up
holds too much of the call to wind back in place, so the handshake answers the
`retrain` event with a fresh V90 that continues the call (`resumeFrom`). It enters
Phase 2 at §9.2.1.1.3 / §9.2.2.1.3 after the 70 ms silence, keeps the INFO0s, and
takes over any bytes still queued. The clocks are rebased, and V.42 is re-linked
to the new instance (`ErrorControl.relink`), suspended until `carrying` is true
again. BinModem's modem goes back to its phase 2 the same way. `bm-v90` [3] holds
both directions against BinModem's analogue modem; `v90-retrain-check` holds both
whole modems through Handshake with LAPM.

### Rate renegotiation (§9.6)

In place, from data mode, either modem, the data frames kept in step: no fresh
instance, and V.42 suspended through it (`carrying`). About 0.4 s.
- **The digital modem** (§9.6.1). Its upstream V.34 receiver watches data mode
  for the analogue modem's S (`setRenegInData`, V.34's §11.6 detector and rewind),
  and on the S-to-S̄ transition, or at once when it asks itself (`renegotiate(maxUp)`,
  which caps the upstream its MP asks for), it sends Rd for 384T and R̄d for 24T on
  a frame boundary. Rd is §8.6.4's R on the highest-power codeword of each
  interval's data constellation. TRN2d, MP until CP, MP′ until CP′, Ed, B1d and
  data follow at CP's new rate. Training runs on CPt's mapping with the data CP's
  redundancy, look-ahead and shaping, as BinModem's digital modem trains one.
- **The analogue modem** (§9.6.2). Asking (`renegotiate(maxDown)`, a rung the
  far end's Jd offers), it sends S for 128T and S̄ for 16T inside its V.34 burst and
  then CP at the new rate (`sendRenegV90`); answering, it does so on Rd's turn to
  R̄d. Its downstream receiver watches data mode for Rd (all six intervals at their
  top codeword, either polarity) and reads what follows with start-up's Phase 4
  receiver; B1d is data again.
- **No E (digital) or Ed (analogue) within 5000 ms plus two round trips** of the
  R̄d or S̄ it sent is a §9.5 retrain.
Two things this surfaced. The CP hunt, restarted, re-read the start-up's CP′
still in the upstream's buffer and ran the renegotiation on the old parameters:
the buffer is now dropped at the start, and the scan follows the upstream's new
Phase 3 receiver. And MP′ no longer goes on start-up's repetition cap before CP
has come (§9.6.1.2.3); the 5 s timeout bounds the wait instead. A CP with six
constellations is about 1000 bits, so the first, cut by the receiver's lock, costs
one repetition (~150 ms). Not done: CPs's silence and echo-canceller retrain
(Figure 10), and a policy for stepping down on its own. `bm-v90` [4] holds the
digital modem's half against BinModem's analogue modem, both directions;
`v90-reneg-check` both halves SynthLink to SynthLink with LAPM, and the timeout.

### Data path over the downstream

Bytes ride the project's async UART framing over a continuously scrambled stream.
**The scramblers go by modem type, not by role:** §5.3/V.90 gives the digital
modem GPC and §6.5/V.90 the analogue modem GPA — clause 7/V.34's two polynomials,
assigned the other way round from V.34, where the CALLER is GPC. They were swapped
in both directions (the upstream V.34 instance took V.34's role taps) until
BinModem's analogue modem could not read our Sd and we could not read its Ja; both
ends of a loopback shared the mistake. `V34.setScramblers()` now names them. Idle is mark, so the descrambled idle stream yields no start
bit and no phantom bytes while the codeword stream runs continuously. Downstream
TX level is full-amplitude PCM (RMS ≈ 0.37, peak 0.98), unlike the 0.155 RMS
(−10 dBm0) of the modulated protocols — correct, because the codewords *are* the samples.

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

**The analogue modem learns the route** (`V90Dil.js`, ported from BinModem's
`v90/dil.rs`). What a SIP gateway hands it is the codewords the network carried,
exactly, but not necessarily the ones sent: the nearest of the network's law, a
T1's robbed bit in one octet of six, a digital pad scaling every level. So:
- **Its DIL** asks for every codeword up to a third of full scale but U_INFO, each
  in a segment of six frames: one of references at U_INFO, five of the codeword.
  The chords are walked in turn, three codewords apart inside each, so nothing
  climbs (`v90-dil-level-check`) and neighbouring segments differ.
- **It reads the DIL by position.** The signs survive every impairment, and a pad
  is a gain common to the whole probe, so the group's place is the candidate whose
  signs agree and whose gain holds steadiest over two segments. Each symbol, as sent
  and as received, goes to the analysis: per interval and codeword, the mean level
  and its spread.
- **It chooses** each interval's constellation from what arrived: levels ten
  spreads apart, a robbed bit's twin levels as one, the quietest set carrying K
  bits inside the far end's Table 15 power (INFO0d bits 33:37), the widest spacing
  that still fits, at the fastest rate Jd offers; a training set twice as widely
  spaced for CPt. The spread has a floor of two LSBs, since exact codewords read none.
- **It slices against the measured levels** from there on: Ri, TRN2d, MP, Ed, data
  and a renegotiation's Rd; and renegotiating, it chooses the new rate's sets from
  the same route.
- **Sd is matched against its own first symbol**, so a pad does not hide it.
- **The law** is the digital modem's: INFO0d bit 39 tells the analogue modem, which
  sets CP's bit 35 to match; our digital modem sends A-law's levels for the same
  Ucodes when configured to (`modem.native.v90Law: 'a'`, µ-law otherwise).
Between two SynthLinks over tools/bridge/v90net.js: 56 000 clean, with a robbed
bit and on A-law; 54 667 through a 6 dB pad and through A-law, a 3 dB pad and a
robbed bit together (`v90-route-check`). Against BinModem's DIGITAL modem
(`bm-v90` [5], bmpeer `--role answer`, a server's −12 dBm0 INFO0d) the same, and
our digital modem on an A-law network now gets 46 666 from BinModem's analogue
modem, where requantised µ-law got 36 000 (`bm-v90` [6]). Not done: slips and
dropouts from a jitter buffer, and a codec waveform in place of exact codewords
(a loop at our end, which a SIP-delivered call does not have).

**Against BinModem's analogue modem** (`tools/tests/bm-v90.js`; it has connected
to real ISP servers), through BinModem's own G.711 network model: §9.2 completes;
our upstream receiver detects its S and S̄ through µ-law at −12 dB and parses its
Ja; BinModem trains on our Sd and TRN1d and reads our Jd; our receiver (with the
V.34 equaliser) detects its §9.3.2.7 S, so J′d and DIL follow; it reads our DIL and
chooses a rate from our Jd, which now enables every rung up to ours (§9.3.1.5 — one
rung left it nothing to choose); we read its CPt and CP; it decodes our TRN2d, MP and
Ed; and **BinModem connects (`transmit 33600, receive 42666`) and receives our
downstream text exactly.**

**The upstream decodes too, at the rate our receiver measured it can take.**
Through BinModem's µ-law network the upstream has a noise floor (0.013 rms in TRN
units at any equaliser length) that leaves 33 600 at about 3σ per dimension. So
the digital modem's MP takes its upstream rate from the upstream V.34 receiver's
measurement (§9.4.1.3; see §7's rate rule), and offers every ladder rate below it.
BinModem runs what we asked for: `Connected { transmit: 26400, receive: 42666 }`,
with text exact in both directions (`bm-v90`), and 1 122 bytes upstream without an
error. It was 24 000 before the Viterbi decoder; forced to 28 800, the upstream
still errs. Our analogue modem's
upstream transmitter runs whatever rate the digital modem's MP names.

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

**The off-hook gap is a real 1.00 s** before ANSam (`answerToneDelayMs`), and
ANSam starts on the sample the silence ends. Every connect figure excludes it.

**`farEndIdle` is an optional contract** for protocols that connect on Handshake's
timer rather than on a `ready` event: a getter that is `false` until the far end's
line is at its idle state (V.21: mark). Handshake does not call the link up while it
is `false`, on either the permissive or the CD-stable path. Undefined means no
opinion, which is every protocol but V.21.

**`setV8Complete(done)` is the contract.** A protocol that emits its own 2100 Hz
answer tone must suppress it when V.8 already ran — the ANSam has been heard, and
a second tone lands during the peer's post-CJ training and trips its energy-onset
acquisition. `Handshake._selectProtocol` calls it on any protocol that defines it,
passing whether the V.8 path was taken.

**CJ is read as it lands.** A caller stops repeating CM mid-sequence to send CJ,
and BinModem's stops after the sync. Our parser held that sync waiting for four
bytes, so the CJ behind it sat unread until line noise brought a fourth, 200 ms
later. By then V.34's caller had sent its INFO0c, and our answerer repeated
INFO0a for the rest of the call. That happened on a tilted line, the moment V.8's
LAPM octet shifted the timing 27 ms. A sync whose next octet is not a call
function is now dropped at once.

**CJ sent and missed, as §8 has them.** Our caller used to start CJ on a fresh
modulator, cutting the CM octet in flight and the carrier's phase with it. §8.2
says it "shall complete the current octet and associated start and stop bits and
then signal CJ shall be transmitted", and now it does, on the same carrier. Under
the 2-wire echo the answerer still loses CJ's almost all-space octets at 25 dB of
loss, so it also takes §8's alternative, "the absence of CM for a suitably long
period of time": 200 ms with no CM octet in JM_ON (CM is continuous, one every
33 ms). And "a minimum of 2 identical" CMs or JMs is now any two received, not
two in a row, so one corrupted on the line between two good ones does not start
the count again. These showed up when the LAPM octet lengthened CM and JM by one
byte, and V.22 at 25 dB under the echo stopped connecting.

**Identical means identical in LAPM too.** §7.4's comparison used the bytes up to
modn2, and the LAPM octet follows modn2 in a JM with three modulation octets, so a
copy that lost it on the line matched one that had it. At 30 dB under the echo
our caller took LAPM as unsaid while BinModem, told it, skipped V.42 detection.
The compared bytes now carry the LAPM octet wherever the parser read it.

**`setLeadSilence(ms)` takes the line at CJ.** §11.2.1/V.34 has each modem listen
for the far INFO0 "during the 75 ± 5 ms silent period ending Phase 1", so a
protocol whose factory carries `leadSilence` (V.34) is handed the line when the
sequencer agrees (`agreed`, at CJ). It transmits V.8's silence itself, ahead of
its own, and its receiver is on throughout. The transmit timing is unchanged:
INFO0 still goes out 150 ms after CJ. One protocol takes both clocks at one
instant, so the echo canceller's pairing is unaffected. Every other protocol is
still handed the line after the silence (`result`).

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
| V.32 | 4800/9600 | 16-QAM or trellis 32-QAM | full-duplex | 1800 Hz | genuine minimal | not yet on hardware |
| V.32bis | 4800–14400 | trellis QAM (4800 uncoded) | full-duplex | 1800 Hz | genuine minimal | §8 renegotiation; not yet on hardware |
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
   sliced away. Done for V.32bis at every coded rate and for V.32's trellis mode
   (V32bisViterbi).
5. **Rate renegotiation (V.32bis §8).** Every rate is wired and chosen at
   start-up; the change-rate-without-retrain procedure, and choosing a rate from
   the line, are what remain.
6. **V.8 negotiation — done.** V.29 and Bell 103 bypass, both deliberately and
   for different reasons: V.29 is half-duplex with its own connect script, and
   V.8 has no modulation bit for Bell 103 to advertise. Note Bell 103's answer
   side has NOT been seen by hardware in this shape — synthmodem validated it
   with V.8 attempting and failing over first.

---

## 12. File transfer — XMODEM / YMODEM / YMODEM-G / ZMODEM

**Not modem protocols.** Everything above is a carrier; these ride on top of one
as payload, and they run in the browser (`public/xfer.js`) rather than in the
DSP or the server. The engines see bytes in and bytes out and never learn which
transport is under them, so the same code serves a 300 bps Bell 103 call and
telnet bypass.

| Protocol | Blocks | Integrity | Filename | Exact length | Recovers |
|---|---|---|---|---|---|
| XMODEM | 128 | checksum or CRC-16 | no | no | yes |
| XMODEM-1K | 128 / 1024 | CRC-16 | no | no | yes |
| YMODEM | 128 / 1024 | CRC-16 | yes | yes | yes |
| YMODEM-G | 128 / 1024 | CRC-16 | yes | yes | **no** |
| ZMODEM | ≤1024 subpackets | CRC-16 or CRC-32 | yes | yes | yes |

**What is genuine.** All of it, and verified against the reference
implementations rather than against ourselves: `xfertest` drives every engine
against `lrzsz`'s `sz` and `rz` in both directions. The CRCs are pinned to their
published check values, and the block framing and ZDLE escape set are asserted
at literal bytes before anything round-trips — a receiver inverts whatever a
transmitter does, so only the printed definition can fail a wrong constant.

**What is not implemented.** ZMODEM compression (never widely used) and
ZCOMMAND, which is a remote shell and is not something a terminal should offer a
board. Crash recovery is honoured where the peer asks for a position (ZRPOS) but
is not initiated.

**The YMODEM-G gap, which is real.** G removes the per-block acknowledgement, so
there is nothing to retry with and any error ends the transfer. It was designed
for a modem doing error correction underneath — V.42/LAPM or MNP. **This modem
now does V.42 (§13) on V.22, V.22bis, V.32, V.32bis, V.34 and V.90**, and there
G is as safe as it was meant to be. It does none on V.21, Bell 103, V.23 or V.29,
and there the rest of this paragraph applies. Over `link:'direct'` that does not matter: the
path is TCP end to end and cannot corrupt. Over a carrier it will usually work
and then fail completely the first time anything jitters the audio, because a
late or dropped frame gives the demodulator a discontinuity and a burst of bit
errors. It is offered anyway, with the caveat beside the choice rather than a
disabled control. See `public/rxjitter.js` on why that jitter exists at all.

**The IAC gap this closed.** A binary block is full of `0xFF`, which is telnet's
IAC. The inbound path had always unescaped a doubled one; the outbound payload
path never escaped, so anything the user sent containing `0xFF` reached the
board as a command. `lib/telnet.js`'s `escapeIAC()` is the mirror, applied at
`server.js`'s `toBBSPayload()` and never to `filter.onSend`, whose IACs are
meant to be read as commands.

---

## 13. V.42 error control, V.42bis and V.44 compression

Source: `vendor/src/ec/` — `Bits.js`, `Hdlc.js`, `Frame.js`, `Lapm.js`, `Xid.js`,
`Detect.js`, `Stack.js`, `V42bisDictionary.js`, `V42bis.js`, `V44.js`,
`V44Encoder.js`, `V44Decoder.js`, **ported from BinModem's `crates/ec`** (each file
names its source; PROVENANCE.md), and `ErrorControl.js`, ours, which runs the
stack inside the modem.

**What it is.** A real modem's error control, run once the data pump is up: the
detection phase (7.2.1: the caller's ODP, DC1 with alternating parity; the
answerer's ADP, `EC`), the XID exchange (8.10: N401, k, a 32-bit FCS, single-frame
SREJ, and V.42bis's private and V.44's user-data subfields in one command),
LAPM (8.3–8.9: SABME/UA, go-back-N and SREJ recovery, timer recovery, T401 from
the line rate per Appendix IV), and then V.44 where both ends offer it, else
V.42bis, else none. The terminal is told it has connected only once that has
settled (V.250 6.5.5): Handshake's `connected` waits, and carries
`errorControl` (`LAPM`/`NONE`) and `compression` (`V.44`/`V.42bis`/null).

**Where it runs.** Over every protocol whose class takes a bit link
(`setBitLink`): V.22, V.22bis, V.32, V.32bis, V.34, V.90. While the link is set the
protocol's data-mode bits go to the stack and its transmit bits come from it,
in place of start-stop characters; the pump, the scrambler and everything
under them are untouched. V.90 too, whose two directions are two pumps: the
digital modem sends downstream PCM and hears the upstream V.34, the analogue
modem the reverse, and `V90.setBitLink` routes each half of the link to its
own. Not on V.21, Bell 103, V.23 or V.29, deliberately: they predate V.42 and
period modems ran them without it. Config:
`config.modem.native.errorControl` — `enabled` (true) and `compression`
(`both`, `v44`, `v42bis`, `none`).

**What the caller sees.** The status line names V.42's stages between the pump
and CONNECT — `ODP/ADP`, `XID`, `SABME/UA` (`v42-detect`, `v42-xid`,
`v42-sabme`, from `Handshake.describe()` through `ErrorControl.stage()`) — which
at V.22 is two seconds and at V.34 a blink. With `AT+ER=1` / `AT+DR=1` the
terminal gets V.250 6.5.5's and 6.5.6's reports before CONNECT, as a period modem
gave them: `+ER: LAPM` or `NONE`, `+DR: V44`, `V42B` or `NONE`. Both are off until
set, as V.250 has them, and kept in the browser's prefs.

**A far end without V.42** is found by the detection phase itself, as a real
modem finds it: the caller's T400 runs out with no ADP, the answerer's with no
ODP, or the far end's terminal is heard typing (16 characters of text back to
back). The bit stream then carries start-stop characters, framed and deframed
in `ErrorControl.js` by ONE deframer from the detection phase's own bits onward,
so a far end that started typing at once loses nothing at the change. Called
that way, the far end's terminal sees our ODP's DC1s before our text, which is
what a real V.42 modem does to a non-V.42 one.

**Timers are the modem's own**, counted in samples generated (`tick` from
Handshake's data-mode generate), and frozen while the pump is not carrying data
(V.42 7.10): V.32 and V.32bis report `carrying` false during a retrain, and the
stack is suspended until it is back, with its link and dictionaries intact.

**Against BinModem** (`bm-whole`, `bm-v22`, `bm-v90`, bmpeer `--v42`, which
puts BinModem's own `ec::Stack` over its pump): LAPM with V.44 in both roles on
V.22, V.22bis, V.32, V.32bis and V.34, and over V.90 with BinModem's analogue
modem; V.42bis and no compression when that is
what BinModem offers; through a V.32bis retrain; and the fallback against
BinModem's bare pump. `ec-check` holds every layer alone with BinModem's own unit
tests, including a real modem's 260-octet and 1957-octet V.42bis streams, real
XIDs from two calls, and a real Agere's ODP.

**What it buys.** On repetitive text, 2700 octets crossed SynthLink to SynthLink
in 0.10 s at V.32bis with V.44, 0.52 s with V.42bis and 1.74 s with LAPM alone,
against about 1.9 s of start-stop characters; at V.22's 1200 bit/s, 0.5 s
against about 25 s.

**V.8's LAPM indication** (Table 6's protocols octet, 0x2A, after the modulation
modes): our CM says it where the call can run V.42 over its pump (V.22, V.22bis,
V.32, V.32bis, V.34, V.90) and error control is on. Our JM says it only if the CM
did (§7.4). Where both said it, the detection phase still runs, as BinModem's and
most answerers' do (V.42 Appendix VI.2; V.8 §7.3 warns of ends that say LAPM and
want the exchange anyway). What changes is the reading of a silence:
`declaredLapm()` takes an ADP that never comes as lost on the line, not as a far
end without V.42. `v8-check` holds the octet, the parser and the §7.4 rule,
and `bm-whole` holds both ends settling it against BinModem's V.8.

**Not done.** Break (8.13), multi-frame SREJ (8.4.5.2), T402/T403.

