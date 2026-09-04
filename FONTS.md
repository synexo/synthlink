# FONTS.md — how a glyph gets to the screen

The authority on any font or terminal-rendering question. Current state, not a
proposal: everything here is implemented in `public/{fontscale,renderer}.js` and
`public/fonts/index.js`, and almost all of it is asserted by a harness.

- **Registry, and which font is which:** the header block in
  `public/fonts/index.js`. Read it first.
- **Provenance and licence obligations:** PROVENANCE.md.
- **Narrative — what was tried and what was measured:** DEVLOG.md.

---

## 0. The rule that generates the others

**No font-specific constants, no resolution-specific constants, no
device-specific branches.** Cell metrics, ink extents, blank-column detection,
glyph classification and aspect factors are all *derived* — from the glyph bytes
for a bitmap font, from `head`/`OS/2`/`hmtx` for an outline one. A font added
later is correct without touching the renderer. If an implementation ever needs a
table of known devices or a per-font tweak, the generalization has failed.

The one licensed exception is the line-graphics range `classifyStretch()` reads.
It is a property of the *encoding*, not of any font — which is why it lives on
the charset descriptor (§11) rather than in the renderer: CP437's is
`0xB0`-`0xDF`, Latin-1's is empty.

---

## 1. Two paths, one atlas

Both paths produce the same artifact — **a glyph atlas of 256 fixed-size cells** —
so the render stack downstream is indifferent to which produced it. A bitmap font
fills atlas cells by ratio-masked pixel replication; an outline font fills them by
rasterizing the outline. Nothing else differs.

That convergence is where the consistency property comes from: the atlas is
rasterized **once per glyph at an integer cell origin**, so every instance of a
glyph is byte-identical wherever it lands on screen.

`_layout` being non-null is the one condition that selects the hybrid path.

**The problem it solved.** `renderer.js` used to size the backing store from
logical cell metrics alone (`cols * cellW` = 640 at 80x25) and let CSS stretch it.
On a 1080-wide phone the scale is 1.6875, so the resampling *phase* differed from
cell to cell: the same glyph rasterized two ways depending on the parity of its
column, stems alternating 1 and 2 device pixels inside one letterform. That
inconsistency, not the glyph resolution, was the defect. Scaling cannot add
letterform detail — the goal is **consistency at full screen utilisation**, not
resolution.

**A device-pixel backing store is a hard prerequisite.** `Dw`/`Dh` below are real
device pixels, `round(cssSize * devicePixelRatio)`. Prescale into a 640-px canvas
that CSS then stretches and every bit of the snapping is destroyed.

---

## 2. Layout — the part both paths share

Source cell `W x H`, terminal grid `C` columns by `R` rows, viewport `Dw x Dh`
device pixels. `layout()` in `public/fontscale.js`.

### 2.1 Width drives, height clamps

```
pitchX = min(Dw / C, (Dh / R) / ((H / W) * pixelAspect))
pitchY = pitchX * (H / W) * pixelAspect
```

The `min` is the clamp: take the width-driven pitch unless the height-driven one
is smaller, then letterbox horizontally rather than overflow vertically.

**Hand `layout()` the box you actually have, not an aspect-fitted one.** It does
the aspect arithmetic itself — that is what the second term *is* — so a caller
that pre-fits the height and passes the result has converted a rounding error
into a width constraint. `fitTerminal()` did exactly that, and the floored height
came back as a height constraint and narrowed the terminal to preserve aspect. At
390 CSS px and dpr 3 a fraction of a device pixel of height cost two device
pixels of width, on every 80-column font — a hairline of page background down the
edge of a phone screen, produced by the *height*.

The corollary is the mobile rule: **a phone uses the full width, and there is no
margin on mobile precisely so it can.** `tools/tests/uitest.js` asserts it to
within one *device* pixel, across three viewports and all three fonts. One CSS
pixel of tolerance would have passed the bug.

The CSS box must then be written **exactly, not floored**. `Dw / dpr` is
fractional whenever the dpr is (2.625 is the common Android case), and flooring
it hands the browser a display box narrower than the backing store — a resample
of the whole canvas, on top of another pixel given away at the edge. A fractional
CSS width does resolve to whole physical pixels; that was one of the probe's two
load-bearing questions and it passed on a real device. `cssPx()` in
`public/main.js` is the single formatter.

### 2.2 Ink extent — floor is the snap

```
inkW = max(1, floor(pitchX))
inkH = max(1, floor(pitchY))
```

`inkW / W` is a multiple of `1/W` by construction, so "snap to the next-smallest
ratio" needs no separate step.

### 2.3 Cell rectangles — residue distributed, never banked

```
x0 = round(c * Dw / C)      x1 = round((c + 1) * Dw / C)
```

Cell edges are contiguous by construction and `x0` of column `C` is exactly `Dw`,
so **the full viewport is used**. The residue `(x1 - x0) - inkW` is 0 or 1 and
appears as extra tracking between glyphs, spread across the row by the rounding,
never banked into a letterbox. Same vertically as extra leading.

### 2.4 Edge extension — the atlas cell is one larger than the ink

A cell rect is `inkW` or `inkW + 1` wide; an atlas cell is `inkW`. Something has
to cover the extra pixel. For a letterform the answer is "nothing, it is
tracking"; for a box-drawing character it is a hole in a table border.

So the atlas is built `inkW + 1` by `inkH + 1`, the extra column a copy of the
glyph's own last column and the extra row a copy of its last row
(`extendMask()`). The blit takes its source size from the destination rect:

```
dw = min(x1 - x0, flags & STRETCH_X ? padW : inkW)
drawImage(sheet, code * padW, 0, dw, dh, x0, y0, dw, dh)
```

**Source size equals destination size, always. Nothing is ever resampled.**

**Only a glyph that joins may read the extension column**, and the cap is what
enforces it. A letterform's extension is a copy of its blank advance column, so
taking it never changed a pixel — but it put the source rect's right edge
exactly on the atlas cell boundary, and a rasterizer that overreaches by a
fraction of a texel finds the *next glyph's first column* there. That shipped as
a one-device-pixel hairline down the right edge of every wide cell in Chrome,
absent in Firefox, and absent on narrow cells because those already stop a texel
short. Capping letterforms at `inkW` gives them the narrow cell's safety; the
background rect had already covered the residue, which is what it is for.

Y needs no cap: the atlas is one row of cells tall, so a vertical overreach
leaves the image and clamps to the edge, repeating this glyph's own last row
rather than borrowing a neighbour's.

This replaced *scaling* flagged glyphs to the cell rect. That covered the residue
but nearest-neighbour from `inkW` to `inkW + 1` duplicates an arbitrary
**interior** column, which put a `┼`'s vertical bar a pixel off the `│` above it.

### 2.5 Draw order, per cell

1. **Background** — `fillRect(x0, y0, x1-x0, y1-y0)`. Contiguous, no seams.
2. **Glyph** — one 1:1 blit from the padded atlas cell.

There is no separate "stretch" step and step 2 is never a scale.

---

## 3. The bitmap path's masks

```
srcCol[j] = floor(j * W / inkW)      j in [0, inkW)
srcRow[k] = floor(k * H / inkH)
```

Nearest-neighbour selection evaluated **once at atlas-build time** and applied
identically to all 256 glyphs, so the resampling phase is locked to the glyph
origin rather than the screen origin. For `W = 8, inkW = 13` the mask is
`0 0 1 1 2 3 3 4 4 5 6 6 7`.

**Downscale can delete the designed advance space.** Every 8-wide CP437 font
carries its advance as a blank column 7, which survives whenever `inkW >= W` but
not below: at `inkW = 7`, `floor(j * 8 / 7)` yields `0 1 2 3 4 5 6` and adjacent
glyphs touch. Hence the guard in `buildMask()` — when the final source index is
blank font-wide and the mask failed to select it, force it.

**Do not crop the mask to the ink bounding box.** Deriving `W` from the measured
ink extent would improve stem uniformity, but it scales ink alone to fill the
pitch, so the only surviving separation is the 0-or-1 px residue, which can be
zero. Guaranteed spacing is worth more than uniform stems.

**Stem width is not uniform, and that is what killed this path.** With `W = 8,
inkW = 13`, five of eight source columns double, so a stem is 1 or 2 device pixels
depending on where in the cell it falls, and two stems inside one glyph can
differ. That cost was accepted on the reasoning that a bitmap source leaves no
alternative — see §5.4. **Exactly one entry still uses these masks**, the hidden
`vga9x14hr`, kept as the reference arm of that comparison and as the only thing
exercising the 2-byte glyph-row stride.

---

## 4. Classification — which glyphs must meet their neighbours

`classifyStretch()` in `public/fontscale.js`, run on the glyph bytes (bitmap) or
on the thresholded design-grid rasterization (outline). Two parts, in order:

1. **Is this a graphics glyph?** True for the charset's line-graphics range
   (§11) — CP437 `0xB0`-`0xDF`, and nothing at all in Latin-1 — or for any glyph
   with a fully inked row or a fully inked column, which keeps a font that draws
   full-cell shapes outside that range classifying correctly.
2. **If so, which axes?** Edge contact, per axis.

A fully inked ROW, not a bounding box that reaches both sides: a bbox is the
union of every row, and in the AST 8x19 bitmap `J` inks column 7 on its top bar
and column 0 on its tail, so its bbox spanned the cell though no row of it was
solid. That was enough to put `J` on the graphics path.

**The predicate this replaced, and why it shipped a bug.** The original was "the
ink bounding box spans the whole cell on this axis" — true of `─`, `│`, `┼` and
`█`, and false of **every corner and every tee**. Corners therefore classified as
letterforms and went down the antialiased `fillText` path, positioned by the
rasterizer rather than the design grid: a different rasterization of the same
stroke from the `─` beside them. Two things it was **not**, both ruled out by
measurement: not a scaling artefact (it reproduces at a device width that is an
exact multiple of the column count, where §2.3's residue is zero), and not
TTF-specific (the bitmap path had the same misclassification).

Edge contact **alone** does not work either, and it is the obvious first attempt:
in a ROM font the advance space is the right-hand column only, so letterforms
routinely ink column 0 — "touches either edge" flags 199 of 256 glyphs.

`tools/tests/boxjointest.js` is the regression. It renders a sheet built out of
adjacency — every junction character sitting between the strokes it must meet —
and fails on a single background pixel that crosses a cell boundary.

---

## 5. The outline (TTF) path

### 5.1 Registry fields

```js
{
  id: 'flexi135', kind: 'ttf',
  cellW: 27, cellH: 64,          // DESIGN GRID — see 5.2, and it is not pixels
  file: 'fonts/Flexi_IBM_VGA_True_437.woff2',
  family: 'Flexi IBM VGA True 437',   // MUST be unique across entries
  upem: 1600, advance: 675,      // head.unitsPerEm, hmtx
  ascent: 1200, descent: 400,    // OS/2 usWinAscent / usWinDescent
  capHeight: 1000, xHeight: 700, // OS/2 sCapHeight / sxHeight
  scale: 'hybrid',
  // inkGamma: 2.2,             // OPTIONAL — stem darkening, §5.5. ABSENT means
                                // the pass is SKIPPED, not applied as identity.
  // charset: LATIN1,           // OPTIONAL — what a byte MEANS, §11. ABSENT is
                                // CP437: every entry but Topaz.
  // cols: 40,                  // OPTIONAL — the columns this font implies.
                                // ABSENT is 80. Selecting the font IS the choice.
  // hidden: true,              // OPTIONAL — out of the Aa cycle. Only ever
                                // with a STATED JOB, §11.
}
```

Every metric is transcribed from the file, and `tools/tests/ttftest.js` reads
them back out of the shipped asset and fails on drift — a stale number does not
crash, it typesets every glyph at the wrong size and still looks like a font.

`family` must be unique because the browser keys a loaded `FontFace` by family
string; two files sharing one collide in `document.fonts` and one silently wins.

`fontStride()` is bitmap-only and **throws** for an outline entry rather than
returning a plausible number, because every caller is about to index into
`undefined`.

### 5.2 Sizing, and the cell-aspect invariant

```
fontSize = inkW * upem / advance
baseline = round(fontSize * ascent / upem)      // from the atlas cell's top edge
```

`cellW`/`cellH` on an outline entry are **not pixels**. They state the cell's
aspect and set the resolution `deriveOutlineBitmap()` rasterizes at. The
invariant is exact integer equality:

```
cellW * (ascent + descent) == cellH * advance
```

`layout()` sizes the atlas cell from `cellH/cellW` while `outlineMetrics()`
typesets into `(ascent + descent)/advance`, so a mismatch overflows or underfills
every glyph by exactly the discrepancy, with nothing throwing.

Pick the grid as the smallest square-pixel one that represents the cell exactly.
`flexi135` is **27x64**, not 9x16, because its 675:1600 reduces to 64:27 — its
design pixels are not square, so three raster pixels per design column and four
per design row is the smallest exact representation. Declaring it at 9x16 would
present it at False's 1.800 and stretch the face. Where the design pixels *are*
square the grid is the ROM cell itself: `astpx8x19` is 8x19, `vga9x14px` is 9x14.
`flexi160` is 16x32 for a different reason — 1600:800 reduces to 1:2, too coarse
a grid to rasterize on. That also keeps a one-column stem near 1.8 raster pixels;
at 8x16 it would land at 0.89 and could threshold away, which for a box-drawing
character means a seam.

### 5.3 Rules that must not be broken

- **Never lay out a string.** `fillText` is called once per glyph, into its own
  atlas cell, at an integer origin — never on a run of text at draw time. Browser
  text layout applies kerning, ligatures, shaping and fractional advances, every
  one of which destroys the fixed grid a terminal depends on. The atlas is the
  boundary; past it the renderer only blits.
- **Full-cell glyphs come from the thresholded bitmap, not from `fillText`.**
  `deriveOutlineBitmap()` rasterizes the outline onto its own design grid,
  thresholds at `DERIVE_THRESHOLD`, and hands *that* to the same classifier the
  bitmap path uses. A correct CP437 coverage removes the *availability* problem, not the
  *tiling* problem: rasterized with antialiasing at a fractional cell size, `█`'s
  edges are grey and adjacent cells show a seam.
- **Antialiasing is on here, and only here — by omission, not by a switch.** The
  argument against smoothing an 8-px source does not apply to an outline with
  real curves. Three things get conflated and one does nothing:
  `imageSmoothingEnabled = false` on the **display** context is belt-and-braces
  (the blit is 1:1, so there is nothing to interpolate) and earns its place as a
  guard against someone reintroducing a scale; `image-rendering: pixelated` on
  the canvas element is *not* redundant — it governs the frames where a hybrid
  rebuild is deferred and the browser is stretching a stale atlas, and it governs
  zoom; and pass 1's graphics glyphs are not antialiased at all, coming from
  `putImageData` of the thresholded bitmap, which is what lets `─` meet `┌`. What
  is left is pass 2: `fillText` is antialiased and **cannot be otherwise** —
  Canvas 2D exposes no switch for text rasterization, and `imageSmoothingEnabled`
  governs `drawImage` and patterns only, so any assignment of it on an *atlas*
  context is a no-op whatever its comment says.
- **Never fall back to a system font.** A system fallback substitutes different
  advance widths and cell metrics, so the failure presents as a terminal whose
  grid is subtly wrong rather than as an obvious error. Fall back to
  `FALLBACK_FONT_ID`, a hidden **bitmap** entry on the **legacy** path — an
  outline font cannot be the fallback for an outline font, because the failure
  being handled is "a woff2 did not arrive" and answering it with another woff2
  can fail identically. `document.fonts.check()` after `load()` is the gate.
- **The derive threshold is 192, not 128, and the reason is arithmetic.** At the
  design grid one design pixel IS one device pixel, and these faces are unions of
  axis-aligned rectangles on that grid, so a faithful rasterization returns 0 or
  255 and nothing else — measured over the AST face's 256 glyphs, 29377 at 0 and
  9535 at 255, no intermediate value anywhere. An in-between value is therefore
  rasterizer error, and the threshold's job is to reject it, not to split it. At
  50% a rasterizer laying down a little extra ink gives a gap pixel ~60% coverage
  and closes it permanently in the derived bitmap; that is fatal to the glyphs
  built from **one-pixel gaps** — `═`, `║` and the rest of the double-line set,
  which then draw as a single thick stem. 192 sits in the empty span between the
  two legitimate values, so it is not tuned against a screenshot.
- **`pixelAspect` is 1.0 on this path, always.** See §6.

Consequence to expect: with an outline default, a fresh visit draws backgrounds
only until the woff2 lands — a correctly-shaped blank terminal for a few frames.

### 5.4 When an outline earns its place

The rule was originally: *an outline font earns its place only if it carries
information the bitmap does not* — curves, or a hinting program, or both.

**That was tested on a phone and it lost.** `Px437_AST_PremiumExec.ttf` is a
pixel trace: zero off-curve points in 6,726, no `fpgm`, no `prep`, `gasp` = 2. By
the rule it should not have shipped. It was added as the third arm of a
controlled comparison against the identical glyph data on the legacy and hybrid
bitmap paths, so the only variable was how the letterform reached the screen —
and it beat both, most clearly on mobile. The mechanism is §3's replication
distortion: an outline is rasterized once at the target size, so every stem gets
the same treatment and the proportions are the designer's rather than the mask's.

> **The amended rule: an outline font earns its place if it carries information
> the bitmap does not, OR if it reaches the screen by a better path than the
> bitmap can.**

The second clause is what put a Px437 outline in the 40-column slot too, and with
more force: a 40-column cell is twice as wide, so the replication error is twice
the size.

What the rule still forbids: shipping a trace *beside* the bitmap it traces as
though it were a different typeface. Only one of the two belongs in the UI.

### 5.5 Ink gamma — the weight replication used to add

§5.4's A/B was won on shape and lost a little on **weight**, and two causes stack.

**The bitmap was too bold, not the outline too thin.** This face's stems are
exactly one design pixel. At `inkW` 14 the scale is 1.75, so a stem wants 1.75
device pixels. Replication cannot express that: `buildMask(8, 14)` duplicates six
of the eight source columns, so a stem came out **2 device pixels fully lit in
six cell positions out of eight** — measured as +4.4% ink mass at `inkW` 14,
heavier than the design asks and heavier *inconsistently*.

**Then sRGB takes a second bite, and this one is a true deficit.** Canvas
composites in the encoded space, non-linearly, which for **light ink on a dark
ground** systematically under-weights partial coverage: a 0.4-alpha pixel does
not read as 40% of the foreground's luminance. At `inkW` 14 roughly 42% of this
font's ink pixels are partial-coverage, carrying 27% of its mass.

The correction is a gamma curve over the atlas **alpha**:

```
a' = 255 * (a / 255) ^ (1 / g)
```

`inkGammaLUT(g)` in `public/fonts/index.js` is the whole of it, returned as a
256-entry table so `ttftest` can assert its properties without a browser.

**Why a gamma and not the two things it is confused with.** A *sharpen* pushes
partial coverage toward both ends, so it lightens as much as it darkens. A
*threshold at ≥1* is a dilation: it fattens the fully-covered geometry too,
closes the counters of **a e o 8 9** at a 14 px cell, and leaves letterforms
visibly bolder than the 50%-thresholded box drawing beside them. Gamma is
monotonic with both endpoints pinned, so it moves only the pixels where the
deficit lives. Three properties follow from the pinning, all asserted:

- **It cannot grow a glyph.** A pixel at 0 stays 0, so no counter fills and
  nothing reaches into a neighbouring cell.
- **It cannot disturb the graphics glyphs.** Pass 1's output is already 0-or-255
  and the curve pins both, so §4's box joins are structurally out of reach.
- **It self-disables where it is not needed.** A pixel trace at an **integer**
  scale has no partial coverage at all, and the replication excess vanishes at
  the same scales. **Both numbers going to zero together is the check that the
  mechanism was identified correctly**, rather than a curve that looks better.

**Choosing `g`.** 1.45 is mass parity with the old bitmap and reads as nothing —
the bitmap's ink is entirely full-strength pixels where a third of the outline's
mass sits in partial ones, so matching the number does not match the perception.
1.8, the cautious midpoint, also read as almost nothing on a device. **2.2 ships**:
the sRGB transfer exponent, the exact factor that makes a coverage of *a*
composite as *a* of the foreground's luminance instead of *a* of its encoded
value, and the only value here with a derivation rather than a judgement behind
it. The usual caution that full stem darkening over-darkens is an argument about
black text on white, the opposite of this terminal. `ttftest` bounds the field at
2.2; going higher is a decision to stop correcting and start emboldening.

**On this font alone**, and the omissions are decisions: Flexi has real curves,
so its grey pixels describe *shape* rather than sub-pixel position, and darkening
them muddies information; the 9x14 is a trace like the AST but sits at a cell
nearly twice as wide, where the deficit is proportionally smaller. Both take a
*skipped pass*, not an identity curve — asserted as atlases that do not change by
a byte.

### 5.6 Sharpening mask — the other knob, and why it is a separate one

§5.5 rejects a sharpen as a way to add WEIGHT, and that stands. Pass 4 is a
sharpen for what a sharpen is for: **edge definition**, on a face whose
antialias skirt reads soft at a given size. It is a second curve over the same
alpha channel, run after the gamma and sharing its read-back.

```
a' = clamp(a + strength * (a - blur(a)))   blur = separable 1-2-1, edge-replicated
```

`unsharpAlpha()` in `public/fonts/index.js` is the whole of it, taking a bare
alpha plane so `tools/tests/masktest.js` can drive it with no canvas and no font
file. Three properties, all asserted; the first two are what make it safe to run
over an atlas at all:

- **The taps are clamped to the CELL, not the strip.** The atlas is 256 cells
  side by side, so a kernel at a cell's column 0 would otherwise read the
  previous glyph's last column — invisible on most character pairs, wrong on
  some.
- **Ink never grows.** Where `a = 0` the result is `-strength * blur ≤ 0` and
  clamps to 0, so a letterform can be sharpened but never widened or bled, and
  §2.4's pad column stays blank.
- **A uniform region is a fixed point**, since `blur(uniform) = uniform`.

Unlike the gamma it is **not** safe over the whole strip. That curve pinned 0
and 255, which is what put §4's box joins structurally out of reach; a sharpen
*rings* instead, and a halo on a shade or a box-drawing edge is precisely what
stops a run of them tiling. Pass 1's cells are therefore skipped by handing the
kernel `stretch[]` — pass 1's own answer about which cells those are, rather
than a second classification free to disagree with it.

**Strength lives in `public/fontmask.js`**, one number per font id, and that file
exists to be hand-edited: it is served out of `public/`, outside the bundle, so a
change is edit-and-reload — no rebuild, no restart. Useful range is about
0.2–0.8; past ~1.0 the negative lobe eats the skirt and letterforms read ragged
rather than crisp. `maskFor()` is total — unknown id, typo, string, negative and
NaN all resolve to 0 — because the failure mode of a stray character in a tuning
file must be a mask that is off, not an atlas that will not build.

**Everything ships at 0**, so the pass never runs and every atlas is
byte-identical to one built with none of this code present. The bitmap path takes
no strength at all: its atlases are 0-or-255, with no skirt to sharpen.

---

## 6. Aspect

### 6.1 The bitmap path derives it

`pixelAspect` is the device height of one source pixel over its device width, and
it follows from the terminal aspect you want:

```
pixelAspect = (C * W) / (R * H) / targetAspect
```

Two things easy to get wrong: **the correction is a property of the cell, not of
"VGA"** — the often-quoted 1.35 is right only for a 9-wide cell (720x400 at 4:3),
where an 8-wide cell is 640x400 = 1.6 and needs 1.2. And **a font that bakes the
correction into its rows takes the uncorrected factor for its actual grid** — an
8x19 cell is 640x475 = 1.347, within 1% of 4:3 with square pixels, so it takes
1.011, not 1.2. Applying both double-corrects.

In practice the derivation is unused: every shipping font is on the outline path
where `pixelAspect` is fixed at 1.0, and the one surviving hybrid bitmap is
square-pixel data.

### 6.2 The outline path chooses the file instead

> **Pick the variant whose native aspect you want and set `pixelAspect = 1.0`.
> Never apply a non-uniform transform to a hinted outline font.**

A `setTransform` stretch grid-fits the glyph at one size and then scales the
result, so stems snapped to whole pixels stop being whole pixels — forfeiting
precisely the property that makes an outline worth shipping. **The aspect knob on
this path is the file, not the renderer.**

The evidence is VileR's own pair. Diffing False against True: Y coordinates are
identical in every glyph, only X differs; X is *not* a mechanical 0.75 scale, so
the narrow variant was re-fitted to its own 75-unit column grid rather than
squeezed; and the hinting was re-authored per variant (`cvt` 32/33, a stem-width
control, reads 200 in False against 150 in True). Both variants are correctly
hinted for their own geometry.

### 6.3 A third variant, minted offline

Neither shipped variant is 1.600 and the desktop wanted 1.600 — False at 1.800 is
too wide to read comfortably at any size. The rule says the knob is the file, so
a file was made. `tools/fontaspect.py` produces
`Flexi_IBM_VGA_False_A160_437.ttf` from the False source:

- every **X** coordinate scaled 8/9 and rounded; every **Y** untouched;
- `hmtx` advance **and side bearings** scaled with it — the renderer derives
  `fontSize` from `upem/advance`, so an unscaled advance would typeset narrowed
  glyphs at the old pitch;
- `cvt[32]`/`cvt[33]` scaled 200 → 178;
- a new family name, non-negotiably.

| variant | advance | 80x25 aspect | scale vs False | cvt 32/33 | shipped |
|---|---|---|---|---|---|
| False (native) | 900 | 1.800 | — | 200 | no — too wide at any size |
| **False 1.60** | **800** | **1.600** | **8/9** | **178** | **yes — desktop** |
| True | 675 | 1.350 | 0.75 | 150 | **yes — mobile** |

This is **not** the transform §6.2 rules out. That prohibition is on a non-uniform
transform at *draw* time, which grid-fits once and then stretches the result; here
the geometry is correct before the rasterizer ever sees it. VileR built True from
False the same way.

Its honest limitation: `fpgm`, `prep` and the per-glyph instruction streams are
copied through unchanged, so the file is hinted **approximately** rather than
natively. **The bound is the important part**: the comparison that decided the
font lineup was won by files with *no hinting whatsoever*, so hinting is not what
makes an outline worth shipping here — rasterizing once at the target size is.
The worst case is "hinted no better than a pixel trace", and a pixel trace is
already the thing that won. Confirming it on a device is a refinement, not a risk.

The native False `.ttf` therefore stays in `tools/datasource/` even though it no
longer ships: it is both the regeneration input and what `ttftest` compares the
derivative against, point for point.

### 6.4 What the shipping faces present

| font | 80x25 terminal | at Dw = 1080 | fontSize | cap | x-height |
|---|---|---|---|---|---|
| Flexi False 1.60 (desktop "Modern") | 1.600 | 1080 x 675 | 27.0 px | 16.9 | 11.8 |
| Flexi True (mobile "Modern") | 1.350 | 1080 x 800 | 32.0 px | 20.0 | 14.0 |
| AST PremiumExec outline ("Pixel") | 1.347 | 1080 x 802 | — | 20.0 | 14.0 |
| Amiga Topaz 2+ (board-specific, §11) | 1.333 | 1080 x 810 | — | 20.2 | 13.5 |

At a fixed terminal width False produces a shorter cell and therefore a smaller
letterform — 15 px caps natively against True's 20. On a desktop with vertical
room that is a fair price for the wider, squarer terminal; on a phone it is why
False reads as too fine. They are one UI slot, "Modern", resolved by screen width.

Topaz's 1.333 is 4:3 exactly, and it is the only one of the four that is a
property of the machine the font came off rather than a choice — see §11.3. It
lands within 1% of Pixel, which is the company it should keep: a phone has
vertical room and no horizontal room, so 1.600 is the wrong shape there.

The 40-column font is separate and its column count is part of the choice: a 9x14
cell is wider *and* shorter, which is what keeps 40 columns from doubling the
terminal's height (360x350 = 1.56x, not 2x). Selecting that font **is** how
40-column mode is entered; there is no other route.

---

## 7. Nine-wide fonts and the shades

`0xB0` ░, `0xB1` ▒ and `0xB2` ▓ are the only glyphs in CP437 whose job is to be
invisible at the cell boundary: a run of them must read as one texture.

IBM's 9-dot text mode duplicates column 8 into the ninth dot **only for
`0xC0`-`0xDF`**. Box drawing lives in that range and tiles; the shades do not, so
every faithful nine-wide font draws them with a blank ninth column and a run of
them shows a one-pixel gutter between every pair of cells. An eight-wide font has
never had the problem — which is why it took a font swap to notice, and why an
eight-wide font is the control rather than the subject in any test of this.

`tools/shadefix.py` re-pitches them offline. Filling the ninth column is not
enough: the ROM patterns have x-period 2 (▒) and 4 (░, ▓) and neither divides 9,
so the gutter would become a *doubled* column instead. The only periods that tile
a nine-wide cell are 1, 3 and 9, and period 3 cannot make a 50% field — a row of
three is 0, 1, 2 or 3 dots, so 50% needs alternating rows, which is horizontal
banding instead of vertical. That leaves 9: the **cell itself is the tile**.

```
░ 0xB0    ink where (x + 2y) mod 9 in {3, 7}          2/9 = 22.2%
▒ 0xB1    ink where (x + y)  mod 2 == 1               1/2 = 50.0%
▓ 0xB2    ink EXCEPT where (x + 2y) mod 9 in {2, 6}   7/9 = 77.8%
```

Row 0 of each is byte-identical to the ROM glyph; the per-row drift is what is
new. ▒ is the ROM checkerboard merely extended into column 8. Densities move from
25/50/75 to 22.2/50/77.8 — the price of nine columns; the ordering and spacing
survive and ▒, the one used for fills and borders, is exact. The drift is 2
columns per row and not 1 because 1 puts every dot on the same 45° line, which
renders as diagonal stripes. The choice was made on the render, not the histogram.

### 7.1 `hmtx` lsb must equal `glyf` xMin

**The trap that cost a round of this work.** `hmtx` carries a glyph's left side
bearing independently of `glyf`'s `xMin`, and a rasterizer is entitled to position
the glyph by the lsb phantom point — so when the two disagree the outline is drawn
shifted by the difference, with no error and nothing obviously wrong.

░ is the one shade whose original outline starts a column in from the cell edge,
so it is the one shipping with a non-zero lsb. Re-drawing it to reach the edge
without updating `hmtx` moved **every ░ one design column right and pushed its
last column out of the cell** — a black gutter down one side of exactly one glyph,
while ▒ and ▓ (lsb 0 either way) looked perfect throughout.

`ttftest` asserts `lsb == xMin` on every glyph of every outline font. The property
is not about shades; any glyph edit can do this.

---

## 8. Offline tools

None of these run on a test path. They are run by hand and their outputs are
checked in. All need `pip install fonttools brotli`.

| tool | what it does |
|---|---|
| `tools/fontaspect.py` | mints the 8/9-narrowed Flexi variant (§6.3) |
| `tools/shadefix.py` | re-pitches ░ ▒ ▓ in a nine-wide font (§7) |
| `tools/mkwoff2.py` | converts a source `.ttf` to the shipped `.woff2` |
| `tools/tests/boxsheet.js` | writes the box-join sheet when run directly |
| `tools/probe.html` | device probe: fractional CSS width → physical pixels, and whether `fillText` grid-fits. Both PASSED on a real device; it is the instrument for any future rasterizer question. |

Sources live in `tools/datasource/`; nothing at runtime may reach one. The
shipped `.woff2` is the only file the browser ever sees.

**The woff2 `totalSfntSize` trap.** woff2's header carries the source's byte
length, and `ttftest` asserts it equals the `.ttf` — that equality is what catches
a stale woff2 left behind after its source was replaced. It does not hold
automatically: woff2's optional glyf/loca transform is lossless in outline terms
but not in table *padding*, and for a `.ttf` that fontTools itself recompiled the
writer over-reports by a few hundred bytes. The converter tries the transform,
keeps it only if the tie holds, and otherwise falls back to the untransformed
encoding.

---

## 9. Accepted costs, and the one open question

- **Atlas rebuild on every metric change** — `Dw`, `Dh`, `devicePixelRatio`, the
  active font, the column count. Debounced against resize, with the tint cache
  invalidated alongside. The debounce is not optional.
- **Stem width is not uniform on the bitmap path** (§3). Per-glyph masks would
  fix it, but that is hand-rolled hinting with a cost function and a build step.
  Out of scope, and now nearly moot.
- **The shade densities moved** on nine-wide fonts (§7). Deliberate.
- **The 8/9 transform's hinting is approximate** (§6.3). Bounded below by "no
  worse than an unhinted pixel trace", which is the thing that won the comparison.
- **Letterforms are antialiased and cannot be otherwise** (§5.3). A real
  constraint on `fillText`, *not* on the pipeline — thresholding at the device
  cell would produce aliased letterforms with the technique
  `deriveOutlineBitmap()` already uses — but at these cell sizes, with unhinted
  faces, an aliased 1-bit glyph is a bitmap font with extra steps and stems would
  land on whole pixels only by accident. The crisp look needs an *integer* cell,
  reachable at 40 columns and not at 80. §5.5's gamma answers the weight half of
  that trade; **the hardness half is the open question**, and the tool for it
  would be a contrast curve about a midpoint, not more gamma.
- **One dead line.** `ctx.imageSmoothingEnabled = true` in
  `buildOutlineFontSheet()` is a no-op with a comment claiming otherwise. Left in
  place; documented here so it is not read as evidence that a switch exists.

---

## 10. Which harness owns what

| harness | owns |
|---|---|
| `tools/tests/fonttest.js` | the 9x14 glyph bytes against known bitmaps via an independent unpacking — a wrong stride renders convincing garbage rather than throwing. Bitmap-only; it skips `kind: 'ttf'`. |
| `tools/tests/ttftest.js` | the outline entries' parallel assertions: the CP437 and Latin-1 tables as bijections, metrics against the file, monospace, distinct families and files, the §5.2 cell-aspect invariant, the woff2 ↔ ttf tie, the §6.3 derivation point-for-point, the §7 shade tiling, and §7.1's lsb. Coverage is asserted against **each font's own charset** (§11), and it also pins the default: every entry resolves to CP437 unless it says otherwise, and the CP437 descriptor still *is* `cp437.js`'s table and the 0xB0–0xDF range. |
| `tools/tests/altfonttest.js` | §11's config layer — the `config/altfonts.txt` parser and the page's lookup, driven against each other so they cannot drift on case, on the default port, or on which line form wins. Also that every id the shipped config names is a real font, and that Topaz carries the charset, the columns and the `hidden` flag one id is supposed to settle. |
| `tools/tests/masktest.js` | both curves over the atlas alpha, as pure arithmetic — no canvas, no font file. §5.5's gamma: monotonic, endpoints pinned, `g = 1` the exact identity, a larger `g` darker everywhere (which catches the exponent applied as `^g` instead of `^(1/g)`). §5.6's mask: amount 0 bit-identical, uniform regions fixed, no tap across a cell edge, ink that cannot grow, the skip list honoured, and every key in `fontmask.js` a real font id — a mistyped one is otherwise a knob that reads as set and does nothing. |
| `tools/tests/boxjointest.js` | §4 — does every junction character actually meet the strokes beside it, at three device sizes, plus §7's shade cases. `vga9x14hr` is its positive control and is asserted to **still** gutter, which is what gives the shade check teeth. |
| `tools/tests/uitest.js` | the font cycle end-to-end, 40-column mode, persistence by font id, and §2.1's mobile full-width rule — to within one device pixel, at three viewports including two fractional dprs. |

Two traps in the browser harnesses, both learned the expensive way:

- **The cursor blinks on a 500 ms timer**, so a pixel hash must sample **three
  times ~350 ms apart and intersect all three**, and **the gaps must be timed
  inside the page**. The old "twice ~600 ms apart" rule was wrong and was the
  known 40→80 flake: 600 ms exceeds the 500 ms on-window but not the 1000 ms
  period, so a pair starting late in an on-window catches two lit frames and the
  cursor survives the intersection. The span must exceed the ON time, not the
  period.
- **An outline font's atlas is built asynchronously and rebuilt on a layout
  change**, so a reading taken across a rebuild catches a half-painted screen.
  Take readings until two agree (`settledInk()` in `uitest`).

---

## 11. Board-specific fonts and charsets

A handful of boards are not drawn against CP437. An Amiga board's art is cut
against Topaz and its high bytes are ISO-8859-1, so the byte stream that is a
logo there is a hail of guillemets and fractions here. The operator names such a
board in `config/altfonts.txt` and it is served a different font for that call.

### 11.1 One id settles three things

The config file names a FONT and nothing else, because a registry entry already
carries the typeface, the encoding and the column count together. SyncTERM
resolves it the same way and says so in its manual — a font is chosen "and by
implication, a codepage"; its own table declares every Amiga face
`CIOLIB_ISO_8859_1` against `CIOLIB_CP437` for the IBM ones.

So there is no charset field in the config and no width field. Adding either
would be a second place for the answer to live.

### 11.2 A charset is a table, not a decoder

`terminal.js` never decodes anything: a byte is stored raw and the atlas is
indexed by it. The ONLY place a byte becomes a character is the atlas builder's
`fillText`. An encoding here is therefore just **which 256-entry table that call
consults** — `fonts/charsets.js`, three fields:

| field | what it answers |
|---|---|
| `chars` | 256 single-character strings, for `fillText` |
| `isGraphics` | which codepoints are line graphics, i.e. must MEET their neighbours (§4). A property of the ENCODING: CP437 puts shades, blocks and box drawing in one run at 0xB0–0xDF; Latin-1 has none, only accented letters that must NOT be extended. `classifyStretch`'s fully-inked clause still catches a face that draws outside whatever the encoding says. |
| `blank` | positions with no printable character, which must come out empty rather than as `.notdef` boxes. CP437 has two (NUL, NBSP); Latin-1 has C0, DEL, C1 and NBSP. |

`charsetOf(font)` is `font.charset || CP437`, and the `|| CP437` is load-bearing:
no entry that predates charsets carries the field, so every one resolves to a
descriptor whose members ARE the constants the code used before — not equivalent
to them, the same objects. That is what makes the mechanism unreachable from any
font a user can select, and `ttftest` asserts it per entry.

The draw path never sees a charset. `renderer.js` and `terminal.js` have no
knowledge of this at all, and a change that needs a line in either is the wrong
change.

### 11.3 Adding an alternate font

1. **Get the byte stream, not a screenshot.** SyncTERM's `Alt-C` capture in
   ANSI/raw mode writes the wire bytes with escapes intact (`CTERM_LOG_RAW`);
   the ASCII option strips them. It opens the file with `"ab"`, so use a fresh
   name. Capture is taken after telnet processing, which is where our own
   terminal sits, so the file is directly comparable. Everything below is
   guesswork without one.

2. **Identify the charset from the high bytes.** Decode the capture both ways
   and read the columns. A wrong table is not subtly wrong: aBSiNTHE's rails are
   `¯ · ¬` in Latin-1 and `» ╖ ¼` in CP437, and only one of those is a
   vocabulary. If the table is new, generate it mechanically the way `cp437.js`
   and `latin1.js` were, and have `ttftest` re-derive it independently.

3. **Identify the FACE the same way.** SyncTERM's `src/conio/allfonts.c` holds
   every font it ships as raw 8×16 bitmaps; extract the candidate and diff it
   glyph-by-glyph against the file you were given. That is how Topaz was pinned
   to 2+ rather than 2 — 184 of 190 glyphs pixel-identical to `Topaz Plus
   (Amiga)` against 167 for `Topaz (Amiga)`. Do not take the filename's word.

4. **Derive the aspect from the machine, not from the file.** A faithful pixel
   tracing is on SQUARE units and will present at whatever `cellH/cellW` its
   grid implies, which is a statement about the tracing and not about the
   display. Amiga text is 640x200 (or 640x400 laced) on 4:3, so the pixel is 2.4
   times taller than wide — `640/(200/0.75)`, and the same by the laced route.
   SAUCE agrees, and a SyncTERM screenshot measures ~2.44. Correct it OFFLINE in
   the asset, never at render time: §6 is unambiguous that the file carries the
   aspect, and `PIXEL_ASPECT` is 1.0 precisely so nothing corrects twice.

   Prefer scaling **Y**. `hmtx` holds advances and side bearings, both X-only,
   so a Y-scale cannot desynchronise `lsb` from `glyf`'s `xMin` (§7.1) — the
   mistake that shifts a glyph in its cell silently. `fontaspect.py` scales X
   and has to move both; `topazsubset.py` scales Y and does not.

   Take the factor that keeps coordinates whole. Topaz's are multiples of 100,
   so ×1.2 lands on 120s exactly; matching Pixel's 1.347 instead would need
   ×1.1875, which puts every coordinate on 118.75-unit steps and rounds away the
   pixel tracing the font exists to be. 1% of aspect is not worth that.

5. **Pick the design grid by measuring, not by taste.** §5.2's invariant pins
   the RATIO — `cellW * (ascent + descent) == cellH * advance` — leaving only
   the resolution. Take the smallest legal pair that still reproduces the face:
   derive it and sample each source pixel at its block centre. At ratio 2.4 the
   pairs are 5x12, 10x24, 15x36, 20x48; 10x24 misreads 6.8% of Topaz because a
   one-column stem falls to 1.25 raster pixels and thresholds away, 15x36 puts
   it at 1.875 — flexi135's figure — and misreads 0.12% through the real
   rasterizer, all of it on glyphs that already differed from SyncTERM's bitmap.

   **`cellW` cannot exceed 32.** `glyphRowBits` packs `stride * 8` bits with
   `(bits << 8) | byte` and JS bitwise is 32-bit, so at stride 5 the top byte is
   silently lost and the classifier reads garbage for the left columns. Nothing
   throws. 40x96 is the only grid exact on both axes for Topaz and this is why
   it is not used.

6. **Subset to the 256 codepoints the table names.** `mkwoff2.py` refuses to
   subset, for the reason in its docstring, so it belongs in the font's own
   offline script where the list comes from the table rather than being typed.
   Then `mkwoff2.py` for the shipped woff2 — it handles the `totalSfntSize` tie
   that `ttftest` checks.

7. **`hidden: true`, with a stated job.** A board-specific font is not a
   typeface choice, so it must not be in the Aa cycle; the rule that a hidden
   entry needs a stated job is what stops the registry accumulating dead ones.
   "Served to boards listed in `config/altfonts.txt`" is that job.

8. **Credit it.** `public/about.html` names the fonts actually SERVED and that
   is a licence obligation, not a courtesy — `hidden` does not mean unserved.
   PROVENANCE.md takes the origin and the adaptation.

### 11.4 Traps found the hard way

- **U+00AD is invisible to every shaper.** Byte 0xAD in Latin-1 is SOFT HYPHEN;
  the glyph is in the file and `fillText` still draws an empty cell, which reads
  as a missing glyph rather than as deliberate. `latin1.js` maps that byte to
  U+2010 HYPHEN and `topazsubset.py` adds the cmap entry pointing it at the same
  glyph. Any new table should be checked for characters a shaper treats as
  formatting rather than as ink.

- **A blank slot is policy, not lookup.** Keep the table a faithful
  transcription and blank at the atlas builder, exactly as CP437 does for NUL
  and NBSP. Topaz draws a real diagonal glyph at DEL and Amiga artists used it;
  the shipped file has no codepoint for it, so 0x7F is blank and that is
  recorded rather than hidden.

- **The graphics range is the encoding's, not the file's.** Left as CP437's
  0xB0–0xDF, a Latin-1 font would edge-extend `°±²³…ÀÁÂ` into their neighbours.

- **A board that names a font settles the COLUMN COUNT with it**, and the window
  size rides out on the dial message with no side channel afterwards
  (`windowSize()`). So the override has to be applied before the dial, which is
  why the map is fetched at load rather than queried per call.
