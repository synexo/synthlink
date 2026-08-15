# SynthLink — Provenance

Where the code and the protocol knowledge came from. Runtime needs none of these
external repos — everything required is vendored under `vendor/` and `public/`.

---

## 1. Fused source repositories

SynthLink was built by fusing two repos (both originally cloned under
`/root/repos`; not required at runtime):

### synthmodem — https://github.com/synexo/synthmodem
SIP↔telnet modem gateway. We took its **pure-JS native DSP** (`src/dsp/*`),
vendored under `vendor/src/dsp/`. Provides `ModemDSP`, `HandshakeEngine`, the V.8
sequencer, `Primitives`, and the protocol classes.

- `vendor/` mirrors synthmodem's original tree depth so the DSP's relative
  requires (`../../../config`, `../logger`, `../Primitives`) resolve unchanged.
- V.21/Bell103/V.23 FSK cores are synthmodem-native.
- V.32/V.32bis/V.34 were **removed from synthmodem's native tree** (only its
  unused slmodemd-pjsip backend ever covered them). So there is **no synthmodem
  reference** for our V.29/V.32/V.32bis — they were written fresh (see §3).

### synthdoor — https://github.com/synexo/synthdoor
BBS door-game engine. We reuse its **browser render stack** in `public/`:
`terminal.js` (ANSIParser + TelnetFilter + Terminal screen buffer), `renderer.js`
(canvas CP437 renderer), `font.js` (VGA 8×16 font), `music.js` (ANSI music).

- Copied **verbatim except `terminal.js`**, which adds telnet SGA
  (Suppress-Go-Ahead) client-side negotiation (see DEVLOG). ANSIParser / renderer
  / font / music are unmodified.
- Key enabler: synthdoor's browser `terminal.js` already contains a full
  client-side ANSI/CSI parser with `feed(bytes)`, so the browser can render a raw
  telnet stream once demodulated — we did **not** need synthdoor's server-side
  sbansi stack.

---

## 2. spandsp — the V.22/V.22bis/V.8 DSP origin

The **V.22 / V.22bis** DSP and the **V.8** sequencer are JavaScript ports of
**spandsp** by Steve Underwood:

- Files ported: `v22bis_rx.c`, `v22bis_tx.c`, `v8.c`.
- © 2003–2009 Steve Underwood, **LGPL-2.1**.
- Upstream: https://github.com/freeswitch/spandsp
- Full attribution: synthmodem's `COPYING` and `licenses/SPANDSP-NOTICE`.

**spandsp does not implement V.32/V.32bis/V.34** — this is why those had no
reference to port and were written from scratch.

---

## 3. ITU-T / Bell specifications used

Protocol implementations were written against these primary specs:

| Spec | Used for | Notes |
|---|---|---|
| **ITU-T V.32bis** (1991) | V.32bis 14400: Table 1 (differential), Figure 1 (conv encoder), Figure 2-1 (128-QAM), §4 (scramblers), §5.2.3 (TRN golden vector), Table 5 (rate signal), §5–8 (start-up/retrain/renegotiation) | Full PDF fetched and parsed this session. **Golden test:** §5.2.3 scrambled-ones sequence used to bit-verify the GPC scrambler. |
| **ITU-T V.32** | V.32 9600: non-redundant 16-QAM, §5 differential (mod-4), §7 scramblers GPC/GPA | Scrambler polynomials shared with V.32bis; verified. |
| **ITU-T V.29** | V.29 9600: 16-point constellation, differential-phase + absolute-amplitude encoding, scrambler `1+x⁻¹⁸+x⁻²³` | spandsp point ordering used for the constellation. |
| **ITU-T V.25** | 2100 Hz answer tone (audible connect handshakes) | Emitted by the answerer in V.29/V.32/V.32bis connect scripts. |
| **ITU-T V.22 / V.22bis** | 1200/2400: guard tone (§2.2), caller-lead training (§6.3.1.2.1), detection | Via the spandsp port + clean-link fixes (see PROTOCOLS.md §3). |

V.32bis PDF source URL (ITU public login redirect):
`https://www.itu.int/rec/dologin_pub.asp?lang=e&id=T-REC-V.32bis-199102-I!!PDF-E&type=items`

---

## 4. Reference implementations consulted

- **fisher-modem** — https://github.com/randyrossi/fisher-modem — a modem
  implementation with V.29 plus an experimental V.32. Cited as a reference port
  during the V.32 planning; our implementations were written from the ITU specs,
  not ported from it.

---

## 5. In-tree prototypes (reference scaffolds, not shipped protocols)

Kept in the repo root as development references:

- `v29-proto.js` — V.29 core **batch** prototype: genuine constellation /
  encoding / scrambler, whole-message modulate/demodulate. Reference.
- `v29-stream.js` — V.29 **streaming** prototype with preamble acquisition; the
  basis for `protocols/V29.js`'s fractional-SPS RRC + matched-filter machinery.
- `qam9600-proto.js` — a **64-QAM 9600 feasibility prototype** (1600 baud × 6
  bits, integer SPS=5, 1800 Hz). **NOT a real ITU protocol** — do not ship it as
  "V.something". It only proved a real 9600 QAM link survives the 8 kHz + Int16
  channel and served as a QAM TX/RX scaffold; V.29/V.32 were chosen over it
  precisely because the goal is genuine protocols.

---

## 6. License summary

- spandsp-derived code (V.22/V.22bis/V.8): **LGPL-2.1** (see synthmodem's
  `licenses/SPANDSP-NOTICE`).
- synthdoor render stack: per synthdoor's license.
- V.29/V.32/V.32bis classes: written for this project from ITU specs.
- Retain the spandsp attribution in any redistribution.
