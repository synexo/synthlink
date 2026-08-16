# SynthLink — V.90 pre-implementation notes

Status: **exploratory notes only — no spec read yet, no code written.** This
captures the architectural reasoning for whether/how V.90 (56k) could work over
the SynthLink WebSocket PCM transport, as a starting point for a future session.
The specifics below are reasoned from general knowledge of V.90 and **must be
confirmed against the ITU-T V.90 text and cross-checked with linmodem's `v90.c`**
before any implementation (exactly as the V.34 work started by fetching the spec).

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

## Open questions to confirm against the spec (do NOT trust memory on these)

- Exact **downstream frame length** and the mapping-frame structure.
- The **modulus-encoder** mechanics (how bits become legal codeword sequences).
- The **spectral-shaping** convolutional stage.
- The **per-rate legal-level sets** (which μ-law codes are used at each rate) and
  how the 56k cap is derived from the level spacing.
- The **startup sequence** (V.8/V.8bis + the V.90 digital-impairment-learning /
  ranging phases) and how much can be collapsed on a clean link, à la the other
  self-training protocols.
- How upstream V.34 and downstream PCM are framed together / rate-exchanged.

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
