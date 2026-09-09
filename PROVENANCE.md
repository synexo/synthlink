# SynthLink — Provenance

Where the code and the protocol knowledge came from. Runtime needs none of these
external repos — everything required is vendored under `vendor/` and `public/`.

---

## 1. Fused source repositories

### synthmodem — https://github.com/synexo/synthmodem

SIP↔telnet modem gateway. We took its **pure-JS native DSP** (`src/dsp/*`),
vendored under `vendor/src/dsp/`: `ModemDSP`, `HandshakeEngine`, the V.8
sequencer, `Primitives`, and the protocol classes.

- `vendor/` mirrors synthmodem's original tree depth so the DSP's relative
  requires resolve unchanged.
- The V.21 and Bell 103 FSK cores are synthmodem-native. V.23's is not: its
  `CoherentFskDemodulator` in `FskCommon.js` is a spandsp port (§2). The
  incoherent demodulator and the modulator beside it are native.
- V.32/V.32bis/V.34 were **removed from synthmodem's native tree**, so there is
  **no synthmodem reference** for our V.29/V.32/V.32bis/V.34/V.90 — they were
  written fresh (§3).
- The **V.8 sequencer is synthmodem's** (a spandsp port, §2) and already carried
  every modulation-mode bit needed: `modn0` b6 = V.34, b5 = "PCM avail" (V.90),
  `modn1` b0 = the V.32/V.32bis family. Wiring V.32/V.32bis/V.34/V.90 onto real
  V.8 required only the mappings.

### synthdoor — https://github.com/synexo/synthdoor

BBS door-game engine. We reuse its **browser render stack** in `public/`:
`terminal.js` (ANSIParser + Terminal screen buffer), `renderer.js` (canvas CP437
renderer), `font.js` (VGA 8×16 font), `music.js` (ANSI music). ANSIParser and
music are unmodified. `renderer.js` was modified for multi-font support (cell
metrics moved from module constants to per-instance), and `font.js` was split
into `public/fonts/` — `vga-8x16.js` (synthdoor's font data, unmodified) plus
`index.js` (SynthLink's own registry + sheet builder). Telnet handling was lifted
out of `terminal.js` to the server (`lib/telnet.js`).

The **desktop mouse path** in `public/main.js` is ported from synthdoor's
`app.js` — the drag-select, the URL and single-key click ladder, and
`_isLoneAlphaNum`, which is the menu-key predicate and survives here as
`menuKeyAt`. The supporting halves (`getSelectionText`, the renderer's selection
overlay) came across with the render stack at the original port and were unwired
until now. Changed on the way: the click helpers read `getDisplayCells()` rather
than the live screen, a menu key sends the raw cell byte rather than a decoded
character, Enter is limited to blank cells, and right-click opens a paste box
instead of calling `navigator.clipboard.readText()`.

Key enabler: synthdoor's `terminal.js` already contained a full client-side
ANSI/CSI parser with `feed(bytes)`, so the browser renders a raw telnet stream
once demodulated — synthdoor's server-side sbansi stack was not needed.

### 1.1 Terminal fonts — `public/fonts/`

| module | font | origin | licence |
|---|---|---|---|
| `vga-8x16.js` | IBM VGA 8×16 | synthdoor (above) | MIT upstream; **GPL-3.0-or-later** here |
| `vga-9x14.js` | IBM VGA 9×14 (40-column reference) | VileR, Ultimate Oldschool PC Font Pack (int10h.org) | **CC BY-SA 4.0** |
| `Flexi_IBM_VGA_False_A160_437.woff2` | Flexi IBM VGA False 1.60 (**outline**; an **adaptation** — aspect-scaled AND shade-repitched) | VileR, v2.2 (int10h.org) | **CC BY-SA 4.0** |
| `Flexi_IBM_VGA_True_437.woff2` | Flexi IBM VGA True 437 (**outline**; an **adaptation** — shade-repitched) | VileR, v2.2 (int10h.org) | **CC BY-SA 4.0** |
| `Px437_IBM_VGA_9x14.woff2` | IBM VGA 9×14 (**outline**; an **adaptation** — shade-repitched). 40-column mode. | VileR, v2.2 (int10h.org) | **CC BY-SA 4.0** |
| `Px437_AST_PremiumExec.woff2` | AST PremiumExec (**outline** trace of the 8×19 bitmap; unmodified) | VileR, v2.2 (int10h.org) | **CC BY-SA 4.0** |
| `Topaz_a1200_Latin1.woff2` | Amiga Topaz 2+ (**outline**; an **adaptation** — subsetted, and Y-scaled 1.2 to the aspect an Amiga displayed). Board-specific, never in the cycle. | dMG of Trueschool / Divine Stylers (TrueType, 2009); Unicode by breeze of fishbone crew (2010); | the zip's own LICENCE (ISC licence) |
| `cp437.js` | — (CP437 → Unicode table) | SynthLink-native, machine-generated | GPL-3.0-or-later |
| `latin1.js` | — (Latin-1 → Unicode table) | SynthLink-native, machine-generated | GPL-3.0-or-later |
| `charsets.js` | — (charset descriptors) | SynthLink-native | GPL-3.0-or-later |
| `index.js` | — | SynthLink-native | GPL-3.0-or-later |

**The VileR assets are licensed separately from the rest of the repo** and must
keep the attribution notices in their own file headers. This does **not** affect
SynthLink's GPL-3.0-or-later licence: the fonts are data assets, not linked code,
and GPL-3 §5 covers the aggregation. Attribution: VileR, https://int10h.org —
CC BY-SA 4.0. Full text and the ShareAlike grant: `public/fonts/LICENSE`.

**Every outline font is served to the browser**, so their attribution must be
reachable from the running app; it is in `public/about.html`. Bitmap modules
carry theirs in their own file headers. Deleting a *shipped* asset is a
licence-relevant act as well as a technical one — `public/about.html` names the
fonts actually served, so it has to be edited in the same change. **Topaz counts
even though it is `hidden`**: a board in `config/altfonts.txt` is sent the file,
and being unreachable from the Aa cycle is not the same as being unserved.

**Source assets stay in `tools/datasource/` even for fonts no longer shipped.**
`Flexi_IBM_VGA_False_437.ttf` **must not be deleted** — it is the input
`tools/fontaspect.py` needs to regenerate the 1.60 adaptation that replaced it,
and without it the shipped file is unreproducible; `tools/tests/ttftest.js` also
compares the two point for point, so deleting it silently removes a check. The
`.FON` files are what a deleted bitmap would be regenerated from.

Topaz's source asset is `Topaz_a1200_Latin1.ttf`, which is itself the
`tools/topazsubset.py` output rather than the upstream file — the upstream is a
1.8 MB Nerd Font and only its first 256 codepoints can ever be reached. Keep the
upstream if you have it; re-running the subset needs it.

The shipped fonts divide into three kinds, and the distinction is a licensing
one as much as a technical one:

- **Mechanical `.FON` conversion** — `vga-9x14.js`. The FNT resource's glyph
  bitmaps extracted verbatim, no shapes altered. FNT v2.0 stores a glyph
  column-major; the converter re-interleaves to row-major, leaving the bits
  untouched.
- **A verbatim outline font** — `Px437_AST_PremiumExec.woff2`. The shipped
  `.ttf` re-containered to woff2 with fontTools (`tools/mkwoff2.py`), which is
  lossless — outlines, `cmap` and any hinting survive byte-identical, as
  `tools/tests/ttftest.js` asserts by reading the metrics back out of the source.
  It is eight-wide, which is why it alone escaped the shade re-pitch.
- **Adaptations** — `Flexi_IBM_VGA_True_437.woff2`,
  `Px437_IBM_VGA_9x14.woff2`, `Flexi_IBM_VGA_False_A160_437.woff2` and
  `Topaz_a1200_Latin1.woff2`.

  *Subset and Y-scale* (Topaz only): `tools/topazsubset.py` keeps the codepoints
  `fonts/latin1.js` draws and drops 9000-odd Nerd icons the atlas cannot reach,
  multiplies every **Y** coordinate by 1.2, and points U+2010 at the
  soft-hyphen glyph. The Y-scale is the aspect correction — the upstream traces
  an 8×16 grid on square units and so presents at 1.600, while an Amiga's pixel
  is 2.4 times taller than wide. It is the mirror of `fontaspect.py`'s X-scale
  and safer for it: `hmtx` holds advances and side bearings, both X-only, so a
  pure Y-scale cannot desynchronise `lsb` from `glyf`'s `xMin`. Every Y in the
  file is a multiple of 100 and lands on a multiple of 120; two points on
  `acute` are the only rounding. FONTS.md §11 has the derivation.

  *Shade re-pitch*: `tools/shadefix.py` redraws `0xB0` ░, `0xB1` ▒ and `0xB2` ▓;
  every other glyph is the source's, untouched. IBM's 9-dot text mode duplicates
  column 8 into the ninth dot only for `0xC0`–`0xDF`, so a faithful nine-wide
  font draws the shades with a blank ninth column and a run of them shows a
  one-pixel gutter between every pair of cells. VileR's files are correct; the
  hardware behaviour they preserve is what the app cannot use. The replacements
  are period-9 so the cell itself tiles; densities move from the ROM's 25/50/75
  to 22.2/50/77.8. Derivation in FONTS.md.

  *Aspect scale* (the 1.60 only): `tools/fontaspect.py` scales every **X**
  coordinate, the `hmtx` advance and side bearings, and the X-axis stem-width
  control values `cvt[32]`/`cvt[33]` (200 → 178) by 8/9; every **Y** coordinate
  is bit-identical to the source, which is what makes it the same typeface at a
  different width rather than a new one. It ships under its own family name
  because the browser keys a loaded `FontFace` by family string and two files
  sharing one collide. `tools/tests/ttftest.js` parses both `glyf` tables and
  compares them point for point — 18,952 points, every Y equal, every X the
  rounded 8/9 — so the claim is checked rather than asserted.

  Honest limitation: `fpgm`, `prep` and the per-glyph instruction streams are
  copied through unchanged. VileR **re-authored** the hinting for each of his own
  variants, so this file is hinted *approximately* rather than natively. Scaling
  the `cvt` pair carries most of it; whether the stems still snap on a real
  device is a measurement (`tools/probe.html`), not something the generator can
  assert.

  Being derivative works these are Adapted Material under CC BY-SA 4.0 §3(b) and
  are **offered in turn under CC BY-SA 4.0**. The grant is made in
  `public/fonts/LICENSE`; §6 records it. The generators that produce them
  (`shadefix.py`, `fontaspect.py`, `topazsubset.py`) are SynthLink's own code and
  stay GPL — ShareAlike binds the adapted font, not the tool that cut it.
  **CC BY-SA 4.0 also requires
  that a modified version say it is modified**. `public/about.html` states that
  in the three nine-wide fonts "the shade characters have been redrawn so that a
  run of them meets across the cell boundary", and describes the 1.60 as
  "narrowed to eight-ninths of its original width". That wording is a licence
  obligation, not a courtesy.

**Metrics are transcribed from the files, not assumed.** Flexi False 1.60:
`unitsPerEm` 1600, `hmtx` advance 800 (single-valued — monospace), `usWinAscent`
1200 / `usWinDescent` 400, `sCapHeight` 1000, `sxHeight` 700. Flexi True: the
same but advance 675. AST PremiumExec outline: `unitsPerEm` 2000, advance 800,
ascent 1500 / descent 400, cap 1200, x 800 — ascent + descent is 1900, *not* the
em, which is why its cell is 8×19 at exactly 100 units per row and column. All
carry 288 `cmap` entries covering all 256 CP437 positions.
`tools/tests/ttftest.js` reads them back out of the shipped file and fails if the
registry and the file ever drift — a font replaced without its metrics updated
would typeset every glyph at the wrong size and still look like a font.

For the 9×14 bitmap: `dfVersion 0x0200`, `dfPixWidth 9`, `dfPixHeight 14`,
`dfAscent 11`, 28 bytes per glyph, located through the NE resource table rather
than a hardcoded offset. It is a **true 9-dot font**, following the VGA rule that
only `0xC0`–`0xDF` duplicate column 7 into column 8 — which is what makes
box-drawing join across cells. That is authentic and deliberately kept, and
`tools/tests/fonttest.js` asserts it so any future change is intentional.

---

## 2. spandsp — the V.22/V.22bis/V.8/FSK DSP origin

The **V.22 / V.22bis** DSP, the **V.8** sequencer and V.23's **coherent FSK
demodulator** are JavaScript ports of **spandsp** by Steve Underwood:

- Files ported: `v22bis_rx.c`, `v22bis_tx.c`, `v8.c`, `fsk.c`.
- © 2003–2009 Steve Underwood, **LGPL-2.1** upstream.
- Upstream: https://github.com/freeswitch/spandsp
- Full attribution: `NOTICE`, in this repo. It names the four derived files and
  must travel with any redistribution.

`fsk.c` covers **only** `CoherentFskDemodulator` in `FskCommon.js`, which V.23
uses at both baud rates. The incoherent `FskDemodulator` (V.21, Bell 103) and
`FskModulator` in the same file are independently authored; the modulator follows
`fsk_tx`'s fractional-accumulator approach, which is an approach and not a port.

**These files are distributed here under GPL-3.0-or-later**, as LGPL-2.1 §3
permits. That is a licence change on our copy only — upstream stays LGPL-2.1, and
Underwood's copyright and the LGPL-2.1 origin are recorded in every derived file
and in `NOTICE`. See §6.

**spandsp does not implement V.32/V.32bis/V.34** — this is why those had no
reference to port and were written from scratch.

---

## 3. ITU-T / Bell specifications used

| Spec | Used for | Notes |
|---|---|---|
| **ITU-T V.34** (02/98) | V.34 19200–33600: symbol rates (Table 1), carriers (Table 2), scramblers GPC/GPA (§7), framing J/P/N/b/SWP (§8.2, Tables 7–8), mapping params K/M/L (Table 10), shell mapper (§9.4), differential (§9.5), mapper/precoder/trellis (§9.6), subset labels (Fig 9 / Table 13), Figure 10 16-state conv encoder, odd-integer channel grid (§9.6.3.1), and Phase 3's segments — S/S̄ (§10.1.3.7), PP equation (10-1) (§10.1.3.6), TRN (§10.1.3.8), MD (§10.1.3.5), J and J′ (§10.1.3.3–.4, Tables 18–19) — with the procedure from §11.3. Also referenced by V.90 for the whole upstream (V.90 §6), for the CP/MP CRC (§10.1.2.3.2), and by §8.3/V.90 for every one of the analogue modem's Phase 3 signals. | Written **clean-room from the spec**. Tables 7 and 8 were transcribed verbatim and corrected the SWP bit-indexing and superframe accounting. Note the transcription returned Table 8's last two rows column-shifted; §8.2's own formulas (`N = R·0.28/J`, `b = ⌈N/P⌉`, `r = N−(b−1)P`, one-count of SWP = r) exposed it. §10.1.2.3.2 has since been transcribed from two editions and the CRC coverage corrected, and its Figure 14 — long recorded as one that would not transcribe — was read off the page image at `pf21`, which reversed the register: the information bit enters at stage 0 and the feedback reaches stages 15, 10 and 3. Tables 18 and 19 and the §10.1.3 clauses were transcribed from the converted source; §10.1.3.7's "S̄ shall begin with the transmission of point 0 rotated by 180 degrees" turned out to be a RECEIVER requirement — it is the only thing that resolves which of S's two points a timing lock landed on. |
| **ITU-T V.90** (09/98) | V.90 56000/33600: µ-law codebook (Table 1), data frame + parse (§5.4.2), modulus encoder (§5.4.3), constellation sets Cᵢ (§5.4.4), sign bits and spectral shaper with the 2-state trellis and rules A–D (§5.4.6, Figure 2), Table 3 shaping-frame partition, the Table 2 rate ladder, CP (Table 14), MP (Table 16), the Sd training signal (§8.4.4), Phase 3's TRN1d/Jd/J′d/DIL (§§8.4.1–8.4.5, Tables 12–13) and its procedure (§9.3.1, §9.3.2), Ja (§8.3.1), SCR (§8.3.5), the §8.3.2–.6 deferrals to V.34 for MD/PP/S/TRN, U_INFO (Table 10 bits 25:31), V.8 capability via `modn0` b5 plus the two categories §9.1.1 requires, Phase 2's INFO0d/INFO0a/INFO1d/INFO1a (Tables 7–10) with §9.2's procedure, the §8.2 deferrals to V.34 for tones A and B, the INFO modulation and the probing signals, the Phase 4 signals R/R̄, TRN2d, Ed and B1d (§8.6.1–.5) and Table 17, and the V.34-by-reference upstream (§6). | Written **clean-room from the spec**. Tables 2, 12, 13, 14 and 16 were transcribed verbatim rather than summarised. Table 14's 17-one frame sync independently matched the `v90.c` cross-check. For Phase 3's ORDER the prose of §9.3.1 was taken over Figure 5, whose left-to-right labels suggest TRN1d before Sd where the clause says the reverse. §9.2 was transcribed clause by clause and is §11.2/V.34 with the two modems renamed, which is why it runs on that machine rather than a second one; Tables 8 and 9 say in the Recommendation's own words that they are Tables 14 and 15/V.34, and that claim is checked rather than taken. The overlines do not survive the conversion, so R and R̄ read alike in the text layer — §8.6.4's "4 repetitions" against §9.4.1.2's "R̄i for 24T" is what settles which carries the bar. |
| **ITU-T V.8** (05/99) | The CM/JM category octets: Table 2 (information categories), Table 3 (call function), Table 5 (V.90 availability), Table 6 (protocols), Table 7 (PSTN access), and §§6.3/7.4's rules binding the V.90 and PSTN-access categories together. | Port from spandsp for the sequencer; the category octets were transcribed here. **Table 2 and Table 5 disagree on the V.90 availability category's tag.** Table 2 prints `0 1 1 0`; Table 5, the category's own table, prints `1 1 1 0` — which Table 2 assigns to "Defined in Recommendation T.66". Two categories cannot share a tag, and Tables 3, 6 and 7 each corroborate Table 2 for their own category, so Table 2 is taken and Table 5 read as a misprint. Both readings were made positionally from the PDF's text layer, not from a summarising retrieval. |
| **ITU-T V.32bis** (1991) | V.32bis 14400: Table 1 (differential), Figure 1 (conv encoder), Figure 2-1 (128-QAM), §4 (scramblers), §5.2.3 (TRN golden vector), Table 5 (rate signal), §5–8 (start-up/retrain/renegotiation). | **Golden test:** §5.2.3's scrambled-ones sequence bit-verifies the GPC scrambler. **Figure 2-1 was transcribed** from the PDF's text layer cross-checked against the rendered figure, replacing an invented 128-cross grid that shared no point with it. |
| **ITU-T V.32** | V.32 9600: non-redundant 16-QAM, §5 differential (mod-4), §7 scramblers GPC/GPA. | Scrambler polynomials shared with V.32bis; verified. |
| **ITU-T V.29** | V.29 9600: 16-point constellation, differential-phase + absolute-amplitude encoding, scrambler `1+x⁻¹⁸+x⁻²³`. | spandsp point ordering used for the constellation. |
| **ITU-T V.25** | 2100 Hz answer tone. | Emitted by the answerer in V.29's connect script. |
| **ITU-T V.22 / V.22bis** | 1200/2400: guard tone (§2.2), caller-lead training (§6.3.1.2.1), detection. | Via the spandsp port + clean-link fixes. |

PDF source URLs (ITU public login redirect):

```
https://www.itu.int/rec/dologin_pub.asp?lang=e&id=T-REC-V.32bis-199102-I!!PDF-E&type=items
https://www.itu.int/rec/dologin_pub.asp?lang=e&id=T-REC-V.34-199802-I!!PDF-E&type=items
https://www.itu.int/rec/dologin_pub.asp?lang=e&id=T-REC-V.90-199809-I!!PDF-E&type=items
```

---

## 4. Reference implementations consulted

- **fisher-modem** — https://github.com/randyrossi/fisher-modem — V.29 plus an
  experimental V.32. Cited during V.32 planning; our implementations were written
  from the ITU specs, not ported from it.
- **linmodem** (Fabrice Bellard) — https://github.com/synexo/linmodem
  (`v34.c`, `v90.c`) — clean-room V.34 and V.90 in C, **GPL-2.0**. Consulted
  **only as an algorithm cross-check** while reading the specs, and `v90.c`
  deliberately read in summary rather than in full so that no implementation
  detail could be copied even inadvertently. **No code was ported.** This is
  deliberate, **and the move to GPL-3.0 does not relax it**: linmodem is
  GPL-2.0-**only**, which is incompatible with GPL-3.0 exactly as it was with
  LGPL-3.0. Porting from it would still force a relicense, to GPL-2.0-only.
  Because the algorithms are normative ITU content
  rather than linmodem's IP, and our classes were written from the spec, **V.34
  and V.90 are clean-room from the Recommendations and no GPL code was ported.**

  Points it independently confirmed: V.34's scramblers are the same GPC/GPA
  polynomials as V.32; V.90's CP/MP frame sync is 17 consecutive ones; the
  sign-bit redundancy has the four settings S = 6/5/4/3 (Sr = 0/1/2/3); and the
  sign selection is a Viterbi-style search over the shaping trellis to a
  configurable depth, matching V.90's lₐ.
- **spandsp** — has partial/incomplete V.34-related files; skimmed but not used
  (it ships no working V.34 and no V.90).

---

## 5. In-tree prototypes (reference scaffolds, not shipped protocols)

- `tools/v29-proto.js` — V.29 core **batch** prototype: genuine constellation,
  encoding and scrambler, whole-message modulate/demodulate.
- `tools/v29-stream.js` — V.29 **streaming** prototype with preamble
  acquisition; the basis for `protocols/V29.js`'s fractional-SPS RRC and
  matched-filter machinery.

---

## 6. Licence summary

SynthLink is **GPL-3.0-or-later**, © 2026 Joseph Quinn. `LICENSE` carries the
text; `NOTICE` carries every third-party attribution and is the file that must
travel with a redistribution.

- spandsp-derived code — the four files in §2 — is **LGPL-2.1 upstream**,
  distributed here under GPL-3.0-or-later as LGPL-2.1 §3 permits. Underwood's
  copyright and the LGPL-2.1 origin stay in each file. Retain them.
- synthdoor render stack: **MIT** upstream (same copyright holder), incorporated
  here under GPL-3.0-or-later. §1 names the four files and their modifications.
- V.29/V.32/V.32bis/V.34/V.90 classes: written for this project from ITU specs
  (clean-room). **V.34 and V.90 port no code from linmodem (GPL-2.0-only), which
  is incompatible with GPL-3.0 and stays off-limits.** See §4.
- VileR font assets: **CC BY-SA 4.0**, separately licensed and not covered by the
  GPL. Four are adaptations — the three nine-wide VileR faces and Topaz — which
  must be declared as modified and are offered under CC BY-SA 4.0 in turn.
  Topaz is **ISC**, separate again. Grants and full texts: `public/fonts/LICENSE`.
  See §1.1.
