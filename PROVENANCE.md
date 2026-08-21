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
  reference** for our V.29/V.32/V.32bis/V.34/V.90 — they were written fresh (§3).
- The **V.8 sequencer is synthmodem's** (a spandsp port, §2) and already carried
  every modulation-mode bit needed: `modn0` b6 = V.34, b5 = "PCM avail" (V.90),
  `modn1` b0 = the V.32/V.32bis family. Wiring V.32/V.32bis/V.34/V.90 onto real
  V.8 required no new V.8 protocol work — only the mappings.

### synthdoor — https://github.com/synexo/synthdoor
BBS door-game engine. We reuse its **browser render stack** in `public/`:
`terminal.js` (ANSIParser + TelnetFilter + Terminal screen buffer), `renderer.js`
(canvas CP437 renderer), `font.js` (VGA 8×16 font), `music.js` (ANSI music).

- Copied **verbatim except `terminal.js`**, which adds telnet SGA
  (Suppress-Go-Ahead) client-side negotiation (see DEVLOG). ANSIParser / music
  are unmodified.
- `renderer.js` and `font.js` have since been **modified for multi-font support**
  (see §1.1): renderer cell metrics moved from module constants to per-instance
  (`this.cellW/cellH`) so cell height can vary, and `font.js` was split into
  `public/fonts/` — `vga-8x16.js` (the synthdoor font data, unmodified) plus
  `index.js` (SynthLink's own registry + sheet builder).

### 1.1 Terminal fonts — `public/fonts/`

All four fonts are CP437 ROM bitmaps, 256 glyphs, fixed pitch, stored row-major
with the MSB of the first byte leftmost. A pixel row occupies `ceil(cellW / 8)`
bytes — one for the 8-wide fonts, **two for the 9-wide one**. Cell metrics are
why the terminal canvas is 640×400 on one font, 640×475 on another, and 360×350
in 40-column mode.

| module | font | origin | licence |
|---|---|---|---|
| `vga-8x16.js` | IBM VGA 8×16 | synthdoor (above) | as synthdoor |
| `ast-premiumexec-8x19.js` | AST PremiumExec 8×19 | VileR, Ultimate Oldschool PC Font Pack (int10h.org) | **CC BY-SA 4.0** |
| `dosv-prc19-8x19.js` | DOS/V re. PRC19 8×19 | VileR, Ultimate Oldschool PC Font Pack (int10h.org) | **CC BY-SA 4.0** |
| `vga-9x14.js` | IBM VGA 9×14 (40-column mode) | VileR, Ultimate Oldschool PC Font Pack (int10h.org) | **CC BY-SA 4.0** |
| `index.js` | — | SynthLink-native | LGPL-3.0 |

**The three VileR modules are licensed separately from the rest of the repo.**
Each is a mechanical conversion of its `.FON` — the FNT resource's glyph
bitmaps extracted verbatim, no shapes altered — and as adaptations of CC BY-SA
4.0 works they stay under CC BY-SA 4.0 and must keep the attribution notice in
their own file headers. This does **not** affect SynthLink's LGPL-3.0 licence:
the fonts are data assets, not linked code. Attribution for all three: VileR,
FON conversion 2020, https://int10h.org — CC BY-SA 4.0 (the 9×14 source is
v2.2, Nov 2020). Source `.FON` files are kept in `tools/datasource/`.

Source metrics were read from each FNT header rather than assumed — for the
8×19 pair `dfPixWidth 8`, `dfPixHeight 19`; for the 9×14, `dfVersion 0x0200`,
`dfPixWidth 9`, `dfPixHeight 14`, `dfAscent 11`, 28 bytes per glyph. All are
fixed pitch, `dfCharSet 255` (OEM/CP437), `dfFirstChar 0`, `dfLastChar 255`.
The 9×14 resource was located through the NE resource table rather than a
hardcoded file offset.

Measured comparison of the 8×19 candidates evaluated (`tools/*.FON`), against
the IBM VGA 8×16 baseline of cap 10 / x-height 7 / ink 22.8 %:

| candidate | cap | x-height | ink | note |
|---|---|---|---|---|
| AST PremiumExec | 12 (+20 %) | 8 (+14 %) | 22.2 % | **shipped** — weight closest to VGA, classic shades |
| DOS/V re. PRC19 | 12 (+20 %) | **9 (+29 %)** | 13.2 % | **shipped** — largest lowercase; light stroke, diagonal 0xB2 |
| CL Stingray (regular / bold) | 12 (+20 %) | 8 (+14 %) | 22.9 / 31.9 % | two FNT resources in one .FON (dfWeight 400/700) |
| DOS/V TWN19 | 10 (+0 %) | 7 (+0 %) | 19.0 % | rejected — extra rows are pure leading, no letterform gain |

Note that 19 is odd, so the checkerboard shade blocks (0xB0/0xB1) cannot tile
vertically: the phase repeats across the cell boundary, putting two identical
pixel rows adjacent every 19 px, which reads as faint banding in large fills.
This is intrinsic to any odd cell height and affects all 8×19 fonts equally;
the 8×16 font tiles cleanly.

### The 9×14 font and 40-column mode

Converted for 40-column mode, and paired with it: selecting this font is the only
way into 40 columns (`cols: 40` on its registry entry). At a fixed width, 40×25
on a 9×14 cell is a 360×350 canvas — **1.556×** the height of 80×25 at 8×16 —
where any 8-wide font at 40 columns would be exactly 2×. Design rationale and the
full arithmetic: DEVLOG.md, top entry.

Two conversion facts specific to it. FNT v2.0 stores a glyph **column-major**
(all 14 rows of byte-column 0, then byte-column 1); the converter re-interleaves
to row-major, leaving the bits untouched. And it is a **true 9-dot font**,
following the VGA hardware rule that only `0xC0`–`0xDF` duplicate column 7 into
column 8 — which is what makes box-drawing join across cells, and why `0xB0`–
`0xB2` carry a blank 9th column that shows as a faint vertical gap every 9 px in
large shaded fills. That is authentic, was a deliberate choice to keep, and is
asserted in `tools/fonttest.js` so any future change to it is intentional.

Measured against the IBM VGA 8×16 baseline (cap 10 / x-height 7): cap 9,
x-height 6 — *smaller in raw pixels*, but the cell renders 1.78× larger at 40
columns, so on screen cap height goes 10 → ~16 units. Cell height 14 is even, so
the `0xB0`/`0xB1` checkerboards tile vertically (unlike the 8×19 fonts below),
and `0xB2` is the classic checkerboard rather than PRC19's diagonal.

Why the 8×19 fonts: at a fixed 80×25 the canvas is 640 px wide regardless of
font, so mobile portrait is width-constrained with vertical room to spare. The
8×19 cell spends that spare height on real letterform — measured cap height
10→12 rows (+20 %), x-height 7→8 (+14 %) — rather than on interpolating an
8×16 up. Desktop is usually height-constrained, where the same trade makes the
terminal ~16 % narrower, so 8×16 stays the desktop default. Verified: box-drawing
and block glyphs reach the cell edges in both 8×19 fonts (no seams in ANSI art), and
`0xDB` is solid across all 19 rows.
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
| **ITU-T V.34** (02/98) | V.34 19200–33600: symbol rates (Table 1), carriers (Table 2), scramblers GPC/GPA (§7), framing J/P/N/b/SWP (§8.2, Tables 7–8), mapping params K/M/L (Table 10), shell mapper (§9.4), differential (§9.5), mapper/precoder/trellis (§9.6), subset labels (Fig 9 / Table 13), Figure 10 16-state conv encoder, odd-integer channel grid (§9.6.3.1). Also referenced by V.90 for the whole upstream (V.90 §6) and for the CP/MP CRC (§10.1.2.3.2). | Written **clean-room from the spec**; scramblers confirmed identical to V.32/V.32bis and reuse the golden-verified implementation. **Tables 7 and 8 were transcribed verbatim in the V.90 session** and corrected the SWP bit-indexing and superframe accounting — see PROTOCOLS.md §7. Note the transcription returned Table 8's last two rows column-shifted; §8.2's own formulas (`N = R·0.28/J`, `b = ⌈N/P⌉`, `r = N−(b−1)P`, one-count of SWP = r) exposed it. §10.1.2.3.2 has **not** been fetched — see PROTOIMPROVE.md item 1. |
| **ITU-T V.90** (09/98) | V.90 56000/33600: µ-law codebook (Table 1), data frame + parse (§5.4.2), modulus encoder (§5.4.3), constellation sets Cᵢ (§5.4.4), sign bits and spectral shaper with the 2-state trellis and rules A–D (§5.4.6, Figure 2), Table 3 shaping-frame partition, the Table 2 rate ladder, CP (Table 14), MP (Table 16), the Sd training signal, V.8 capability via `modn0` b5, and the V.34-by-reference upstream (§6) | Written **clean-room from the spec**. Tables 2, 14 and 16 were **transcribed verbatim** rather than summarised (see PROTOIMPROVE.md §0 for the technique — asked normally the retrieval *reconstructs* tables and returns confident wrong values). Table 14's 17-one frame sync independently matched the `v90.c` cross-check. |
| **ITU-T V.32bis** (1991) | V.32bis 14400: Table 1 (differential), Figure 1 (conv encoder), Figure 2-1 (128-QAM), §4 (scramblers), §5.2.3 (TRN golden vector), Table 5 (rate signal), §5–8 (start-up/retrain/renegotiation) | Full PDF fetched and parsed this session. **Golden test:** §5.2.3 scrambled-ones sequence used to bit-verify the GPC scrambler. |
| **ITU-T V.32** | V.32 9600: non-redundant 16-QAM, §5 differential (mod-4), §7 scramblers GPC/GPA | Scrambler polynomials shared with V.32bis; verified. |
| **ITU-T V.29** | V.29 9600: 16-point constellation, differential-phase + absolute-amplitude encoding, scrambler `1+x⁻¹⁸+x⁻²³` | spandsp point ordering used for the constellation. |
| **ITU-T V.25** | 2100 Hz answer tone (audible connect handshakes) | Emitted by the answerer in V.29/V.32/V.32bis connect scripts. |
| **ITU-T V.22 / V.22bis** | 1200/2400: guard tone (§2.2), caller-lead training (§6.3.1.2.1), detection | Via the spandsp port + clean-link fixes (see PROTOCOLS.md §3). |

V.32bis PDF source URL (ITU public login redirect):
`https://www.itu.int/rec/dologin_pub.asp?lang=e&id=T-REC-V.32bis-199102-I!!PDF-E&type=items`

V.34 (02/98) PDF source URL (ITU public login redirect):
`https://www.itu.int/rec/dologin_pub.asp?lang=e&id=T-REC-V.34-199802-I!!PDF-E&type=items`

V.90 (09/98) PDF source URL (ITU public login redirect):
`https://www.itu.int/rec/dologin_pub.asp?lang=e&id=T-REC-V.90-199809-I!!PDF-E&type=items`

---

## 4. Reference implementations consulted

- **fisher-modem** — https://github.com/randyrossi/fisher-modem — a modem
  implementation with V.29 plus an experimental V.32. Cited as a reference port
  during the V.32 planning; our implementations were written from the ITU specs,
  not ported from it.
- **linmodem** (Fabrice Bellard) — https://github.com/synexo/linmodem
  (`v34.c`, `v34priv.h`) — a clean-room V.34 in C, **GPL-2.0**. Consulted **only
  as an algorithm cross-check** while reading the ITU-T V.34 spec (e.g. to
  disambiguate the shell-mapping recursion and the Figure-10 trellis). **No code
  was ported.** This is deliberate: GPL-2.0-only is incompatible with this repo's
  LGPL-3.0, so porting would force a relicense. Because the algorithms are
  normative ITU content (not linmodem's IP) and V.34.js was written from the spec,
  the repo stays LGPL-3.0. (linmodem's `v34.c` also matched our finding that V.34's
  scramblers are the same GPC/GPA polynomials as V.32.)
- **linmodem `v90.c`** (Fabrice Bellard) — https://github.com/synexo/linmodem —
  a V.90 implementation in C, **GPL-2.0**. Consulted **only as an algorithm
  cross-check** while reading ITU-T V.90, and deliberately **read in summary
  rather than in full** so that no implementation detail could be copied even
  inadvertently. **No code was ported.** Same reasoning as `v34.c` above: GPL-2.0
  is incompatible with this repo's LGPL-3.0, the algorithms are normative ITU
  content rather than linmodem's IP, and `V90.js`/`V90Mapper.js`/`V90Phase4.js`
  were written from the spec — so the repo stays LGPL-3.0.

  Two points it independently confirmed, both of which matched the spec text and
  raised confidence in the transcription: the CP/MP frame sync is **17 consecutive
  ones**, and the sign-bit redundancy has the four settings S = 6/5/4/3
  (Sr = 0/1/2/3). It also describes the sign selection as a Viterbi-style search
  over the shaping trellis to a configurable depth, matching V.90's lₐ.

- **spandsp** — https://github.com/freeswitch/spandsp — has partial/incomplete
  V.34-related files; skimmed but not used (spandsp ships no working V.34, and no
  V.90).

---

## 5. In-tree prototypes (reference scaffolds, not shipped protocols)

Kept in `tools/` as development references:

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
- V.29/V.32/V.32bis/V.34/V.90 classes: written for this project from ITU specs
  (clean-room). **V.34 and V.90 in particular port no code from linmodem
  (GPL-2.0);** both are spec-derived so the repo remains **LGPL-3.0**. See §4.
- Retain the spandsp attribution in any redistribution.
