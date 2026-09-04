# SynthLink — 2-Wire Mode

A plan for simulating a real 2-wire local loop, and what each implemented
protocol would need in order to survive it.

**Why this is worth doing.** Every "genuine minimal" claim in PROTOCOLS.md rests
on §0's transport assumptions, and the load-bearing one is that our two WebSocket
directions are a **4-wire equivalent** — no hybrid, so no echo. That is a
historically legitimate line type (V.29 and V.33 are literally specified for
point-to-point 4-wire leased circuits), but it means the single hardest component
in modem design, the **echo canceller**, is not merely omitted — it is
*unnecessary*, and therefore untestable.

A 2-wire mode changes that. It turns "we skip the echo canceller because the
transport doesn't need one" from a documented claim into something demonstrable:
flip a flag and watch V.32/V.32bis/V.34 fail, then watch them come back as the
canceller converges. It also makes several existing clean-link shortcuts
re-testable — some may turn out to be unnecessary once a realistic channel exists,
which would be a straight authenticity win at no cost.

Keep 4-wire the default. 2-wire is opt-in hard mode.

Related: PROTOCOLS.md §0 (transport assumptions) and §11 (backporting);
PROTOIMPROVE.md for the orthogonal spec-fidelity backlog.

---

## 1. The simulation — and why it needs no transport changes

The instinct is that 2-wire means merging the two directions into one shared
stream, which would mean reworking the WebSocket path. It does not.

**Echo is, by definition, your own transmitted signal returning to you.** Both
echo paths on a real loop are therefore functions of *your own* transmit, which
every endpoint already has locally:

```
    near-end echo   your TX leaking through YOUR hybrid          short delay
    far-end echo    your TX reflecting off the FAR hybrid        round-trip delay
```

The far end's signal already arrives over the WebSocket. So each endpoint can
synthesise its own 2-wire experience entirely locally:

```
    rx_2wire[n] =  farSignal[n] · lossLine
                 + hNear ⊛ myTx[n − dNear]
                 + hFar  ⊛ myTx[n − dFar]
```

No second connection, no shared bus, no change to `server.js`'s
`floatToInt16`/`int16ToFloat` path or to `public/main.js`. **This is the key
insight that makes the whole thing cheap.**

### Where it goes

`ModemDSP` already has both halves: it emits `audioOut` and consumes
`receiveAudio`. A hybrid model sits between them:

```
vendor/src/dsp/TwoWire.js       hybrid + delay lines + optional impairments
vendor/src/dsp/ModemDSP.js      tap audioOut into it; filter receiveAudio through it
```

Because it lives in `ModemDSP`, every protocol inherits it with no per-protocol
change, and the protocol classes never learn the channel changed — which is
exactly the point. Note this is under `vendor/`, so it needs `npm run build` and
the browser-path safety check (CLAUDE.md).

### Parameters

Config-driven under `config.modem.native.twoWire`, defaults off:

| key | meaning | realistic default |
|---|---|---|
| `enabled` | master switch | `false` |
| `nearLoss` | trans-hybrid loss, near end | −12 dB |
| `nearDelayMs` | hybrid/codec delay | 1–2 ms |
| `farLoss` | far hybrid return loss | −24 dB |
| `farDelayMs` | round-trip delay | 10–40 ms |
| `hybridTaps` | impulse response of the hybrid mismatch | short FIR, a few taps |
| `lineLoss` | far-end signal attenuation | −10 dB |

Real trans-hybrid loss is typically **10–20 dB**, which is the uncomfortable part:
after line attenuation your own echo is often *stronger than the far-end signal
you are trying to receive*. That is what makes the canceller hard, and the
defaults should reflect it rather than being gentle.

### Deliberately staged: echo first, dispersion later

Start with a **pure echo** channel — flat, no added noise, no dispersion. That
isolates one variable: everything that breaks, breaks because of echo.

Only afterwards add optional `dispersion` (a channel impulse response) and
`noise` (AWGN at a settable SNR). Those are what would additionally require
adaptive equalizers, timing tracking, Viterbi decoding and V.34's precoder — a
much larger programme, and one worth keeping behind separate flags so failures
stay attributable.

### Measurement harness — build this first

`tools/twowire-check.js`, before touching any protocol:

- Verify the hybrid model itself: inject a known signal, confirm the echo appears
  at the configured delays and levels.
- Report **ERLE** (echo return loss enhancement) once a canceller exists —
  `10·log10(echo power / residual power)`. This is the number that says whether a
  canceller works, and without it "it seems to connect" is not evidence.
- Convergence time to a target ERLE, from cold start.
- A double-talk case: both ends transmitting, confirming the canceller does not
  diverge while trying to cancel the far-end signal.

---

## 2. What each protocol needs

The protocols split cleanly into three groups, and the split is not arbitrary —
it is the actual history of modem design. Split-band and half-duplex designs exist
*precisely* because echo cancellation was not feasible when they were written.

### Group A — split-band: should already work

**V.21, Bell 103, V.23, V.22, V.22bis**

Each direction occupies a different frequency band, so your own echo lands outside
your receive filter and is rejected by the filtering that already exists:

| | originate band | answer band |
|---|---|---|
| V.21 | 980 / 1180 Hz | 1650 / 1850 Hz |
| Bell 103 | 1070 / 1270 Hz | 2025 / 2225 Hz |
| V.22 / V.22bis | 1200 Hz carrier | 2400 Hz carrier |
| V.23 | 1300 / 2100 Hz (1200 bps) | 390 / 450 Hz (75 bps back channel) |

**Expected work: none — but this is a hypothesis to test, not an assumption.**
The valuable part is what it re-opens:

1. **`v22MagOnlyDetect` may become unnecessary.** This flag exists because the
   original spandsp answer-side detector required carrier-bin energy > 3× the
   1800 Hz guard-tone bin, which *cannot* pass against a guard-tone-emitting peer
   on our clean link. With a realistic channel the original spectral test may
   become meaningful again. Re-test with the flag **off**; if it passes, that is a
   clean-link shortcut removed rather than merely documented.
2. **V.22bis caller-lead training may become unnecessary.** Currently the
   originate side proactively calls `_onS1Detected('originate-lead')` because
   spandsp's answer-oriented flow never implemented caller training. Re-test the
   reactive path on a 2-wire channel — this is much closer to what spandsp was
   built and validated against.
3. **`skipCdVerification` may become unnecessary.** The wall-clock carrier-detect
   stability gate is a phone-line-noise filter; it never latched on a lossless
   link. It may behave correctly once there is something to filter.
4. **V.23 deserves specific attention.** Its 75 bps back channel sits at 390/450 Hz
   while the forward channel is 1300/2100 Hz. Echo of your own *forward* signal
   into your *back-channel* receiver is a genuine real-world problem for split-speed
   modems, and the low-frequency receiver has very little processing gain.

If any of items 1–3 pass with the flag off, update PROTOCOLS.md §0's clean-link
table — those rows exist only because the link was too clean.

### Group B — half-duplex: structural immunity, timing details

**V.29**

V.29 ping-pongs: while you transmit you are not receiving, so echo cannot corrupt
data. That is exactly why consumer 9600 worked this way before V.32. Three things
still need attention:

- **`TURNAROUND_GUARD` (currently ≈45 ms) must exceed the echo tail.** With
  `farDelayMs` at 10–40 ms plus the hybrid response, 45 ms is marginal. Make the
  guard derive from the configured echo delay rather than being a constant.
- **Receiver squelch must ignore your own echo.** The receiver re-acquires per
  burst on **energy onset**, and your own echo is an energy onset. Real half-duplex
  modems inhibit the receiver while transmitting plus a guard interval; add an
  explicit TX-active RX inhibit rather than relying on level thresholds.
- **The keepalive preamble** (`KEEPALIVE_GAP` ≈1.2 s) is a transmission, so it
  produces echo too. Confirm it does not trigger a spurious acquisition.

Expected work: small, and localised to `V29.js`. **This is the cheapest real
demonstration** that the 2-wire model is behaving, because V.29 should survive with
only timing adjustments — no canceller.

### Group C — full-duplex, same band: the real work

**V.32, V.32bis, V.34, and V.90's upstream**

These put both directions on the same carrier in the same band simultaneously.
There is no filter that separates them. **Without cancellation they fail
completely** — not degrade, fail — because the echo is comparable to or larger
than the wanted signal.

Needed, roughly in order:

1. **An adaptive echo canceller.** NLMS is the sensible starting point: an
   adaptive FIR driven by your own TX as reference, subtracted from your RX.
   - Near-end section: ~64–256 taps at 8 kHz (8–32 ms).
   - Far-end section: a second, delayed adaptive block; a sparse/delayed structure
     is far cheaper than one long filter spanning the whole round trip.
   - **Leakage and a conservative step size.** With little or no echo the taps
     random-walk around zero and inject noise into an otherwise clean signal; this
     matters here because our receivers have no equalizer and no error correction.
   - **Double-talk handling.** Freeze adaptation when the far end is talking, or
     the canceller will try to cancel the far-end signal.
2. **AC/CA training segments.** Currently omitted (PROTOCOLS.md §5). The
   phase-reversal segments of the real V.32/V.32bis startup exist *specifically* to
   give the canceller a quiet, known signal to converge against. Re-adding them is
   part of the canceller, not separate from it — and it makes the startup sequence
   more authentic as a side effect.
3. **Re-check the acquisition front-end.** The receivers use energy onset →
   fractional symbol timing → complex gain, then free-run. Residual echo perturbs
   all three. Acquisition should happen *after* the canceller has converged, which
   is precisely what the real segment ordering arranges.
4. **Then, only if dispersion/noise are enabled:** adaptive equalizer, continuous
   timing tracking, Viterbi decoding, and V.34's precoder — the full PROTOCOLS.md
   §11 list. Keep these behind the separate flags so failures remain attributable
   to one cause.

Suggested order: **V.32 first** (uncoded 16-QAM, simplest constellation, easiest
to see errors), then V.32bis (same core), then V.34 (widest band — at 3429 baud the
occupied band runs to nearly 3.9 kHz, so echo overlaps essentially everything).

### Group D — V.90: the most echo-sensitive protocol here

V.90 deserves its own treatment, and counter-intuitively it is the **hardest**
case despite having the simplest receiver.

**Why it is worst.** Downstream carries PCM codewords recovered by *measuring
sample levels*. There is no carrier, no matched filter, no pulse shaping — and
therefore **no processing gain whatsoever**. Every other protocol integrates energy
over a symbol and enjoys some rejection of uncorrelated interference. V.90's
receiver reads one sample and slices it to the nearest legal level. Echo from the
analogue modem's own V.34 upstream transmitter lands directly on top of those
samples, and our current constellation has a minimum level spacing of 8 (14-bit
scale). Modest echo destroys codeword recovery outright.

**What is needed:**

1. **Echo cancellation on the analogue side specifically.** In real V.90 the
   echo problem is *asymmetric*: the digital modem sits on the digital side of the
   network and does not face a hybrid, while the analogue modem must cancel its own
   V.34 transmit out of the received PCM. Our role mapping already matches this —
   `originate` is the analogue modem. So the canceller belongs in the browser side
   only, which is authentic and also halves the work.
2. **The constellation must shrink, and the rate must fall.** This is the most
   valuable outcome of the whole exercise. Our default constellation uses 91 of 128
   Ucodes, including levels only 8 apart — attainable only because the transport is
   pristine. Under residual echo the closely-spaced levels become unusable, `Mᵢ`
   drops, `∏Mᵢ ≥ 2^K` forces a smaller K, and the achievable rate falls below
   56 000. **That is exactly why real-world 56k links so rarely reached 56 000**,
   and the 2-wire mode would demonstrate it rather than asserting it in a comment.
3. **The rate ladder already supports this.** All 22 rungs (28 000 … 56 000) are
   implemented, and CP already carries `drn` and `Sr`. So the analogue modem
   choosing a smaller constellation and a lower rate is **already the designed
   mechanism** — CP is genuinely load-bearing, not decorative. Nothing new is
   needed beyond the level-selection logic.
4. **Level selection becomes real.** Today `defaultMask()` takes the largest 91
   Ucodes as a fixed configuration. Under 2-wire it should become a *measurement*:
   estimate the residual echo/noise floor, keep only levels separated by more than
   a slicing margin, and advertise that mask in CP. That is precisely what a real
   analogue modem does during Phase 2–3, and it turns our biggest documented
   deviation — the power/level shortcut — into working code.
5. **Upstream V.34 needs Group C's canceller anyway**, since it is V.34.

V.90 is therefore both the hardest target and the best demonstration: it is the one
protocol where the 2-wire channel would force genuinely different, more authentic
behaviour rather than just more DSP.

---

## 3. Suggested sequencing

1. **`TwoWire.js` + `tools/twowire-check.js`.** Model and measurement only, no
   protocol changes. Verify echo appears at the configured delays and levels.
2. **Wire it into `ModemDSP` behind `twoWire.enabled`.** Rebuild, run the
   browser-path safety check. Default off — confirm every existing test is
   bit-identical with the flag off.
3. **Add `TWOWIRE=1` to `dsptest2`** and run the whole protocol set. Expect:
   Group A passes, V.29 passes or needs timing tweaks, Group C fails completely,
   V.90 fails. **Record that baseline** — the failures are the deliverable at this
   stage, and they are the evidence that the model is real.
4. **Group A follow-up:** re-test `v22MagOnlyDetect`, V.22bis caller-lead and
   `skipCdVerification` with their flags off. Remove whatever is no longer needed
   and update PROTOCOLS.md §0/§3.
5. **V.29 timing:** derive `TURNAROUND_GUARD` from the echo delay; add explicit
   TX-active RX inhibit.
6. **Echo canceller + AC/CA on V.32**, measured by ERLE and convergence time, then
   V.32bis, then V.34.
7. **V.90:** analogue-side canceller, then measurement-driven level selection and
   the honest rate reduction that follows.
8. Optional: `dispersion` and `noise` flags, opening the equalizer / timing-tracking
   / Viterbi / precoder programme in PROTOCOLS.md §11.

Steps 1–3 are self-contained and produce a useful result on their own: a
demonstrated, measured statement of which protocols are genuinely 2-wire-capable
and which depend on our 4-wire transport.

---

## 4. What this does *not* address

- **Spec-fidelity gaps** (CRC conventions, exact constellation figures, real MP/MP′
  layouts) are orthogonal — see PROTOIMPROVE.md. A protocol can be bit-perfect
  against the Recommendation and still fail on 2-wire, and vice versa.
- **Robbed-bit signalling and digital pads** (V.90) are network-side impairments,
  not echo. Separate work, PROTOCOLS.md §11 item 8.
- **V.8 negotiation** is unaffected: it runs at 300 bps split-band FSK, which is
  Group A.
- **Modem-bypass mode** has no audio at all and is untouched.

---

## 5. The honest framing to keep

4-wire operation is **not** a cheat. V.29 is specified for point-to-point 4-wire
leased circuits, and V.33 is 14400 on 4-wire leased lines — running V.32bis-class
modulation without an echo canceller over separated directions is essentially what
V.33 was *for*. Our default configuration is a legitimate line type, not a
convenient fiction.

What 2-wire mode adds is the ability to say which claims survive contact with the
harder channel — and to stop describing the echo canceller as "omitted because the
transport removes the need", which is true but unfalsifiable, in favour of showing
it working.
