/*
 * fonts/index.js — font registry + glyph-sheet builder.
 *
 * Every font here is a CP437 (Code Page 437) ROM bitmap: 256 glyphs, fixed
 * pitch, stored row-major with the MSB of the first byte as the leftmost pixel.
 * A row occupies ceil(cellW / 8) bytes — one for every 8-wide font, two for the
 * 9-wide one, big-endian, with the unused low bits of the last byte zero.
 *
 * Adding a font:
 *   1. Drop a module beside this one exporting CELL_W, CELL_H and a
 *      Uint8Array of 256 * CELL_H * ceil(CELL_W / 8) bytes
 *      (see vga-8x16.js for the 8-wide case, vga-9x14.js for the 9-wide one).
 *   2. Add one FONTS entry below.
 * Nothing else in the render stack needs touching — Renderer reads its cell
 * metrics from the active font, and main.js drives the cycle off this table.
 *
 * Licence note: the font assets are third-party works under their own licences
 * (vga-9x14.js and every .woff2 in this directory are CC BY-SA 4.0 works by
 * VileR; the bitmap modules say so in their own headers, and the outline fonts'
 * attribution is in public/about.html because they are SERVED). Three of them
 * are ADAPTATIONS and the licence requires that to be stated — see PROVENANCE.md.
 * This registry is SynthLink's own code, GPL-3.0-or-later like the rest.
 */

import { VGA_FONT_8x16 } from './vga-8x16.js';
import { VGA_FONT_9x14 } from './vga-9x14.js';
import { CP437_CHARS } from './cp437.js';
import { charsetOf, LATIN1 } from './charsets.js';
import { maskFor } from '../fontmask.js';

/**
 * The font catalogue. NOT the cycle order — see CYCLE_FONTS and cycleFonts().
 *
 * The Aa button offers three SLOTS, not N fonts: "Pixel" (the AST outline),
 * "Modern" (Flexi False 1.60 on desktop, Flexi True on mobile via `mobileAltId`)
 * and "Squat" (the 9x14 outline, whose selection IS 40-column mode). Slot order
 * is registry order for visible entries, so moving an entry here moves it in
 * the cycle — and the default must stay slot 0, because the button only cycles
 * forward. `uiName` is the only name the UI shows; `name` is the technical one.
 *
 * `hidden` is load-bearing. Four entries carry it and each has a stated job:
 * `vga8x16` is FALLBACK_FONT_ID (an outline font cannot be its own fallback),
 * `vga9x14` and `vga9x14hr` are the two arms of the 40-column comparison and
 * the only 9-wide bitmap data left, and `flexi135` is the "Modern" slot's
 * mobile face. A hidden entry with no stated job should be deleted instead;
 * three were. What was removed and why is in DEVLOG_HISTORICAL.md — but note
 * that tools/datasource keeps the source .ttf of any derivative, without which
 * the shipped file is unreproducible.
 */
export const FONTS = [
  {
    // ── THE OUTLINE PATH'S FALLBACK. Hidden, never deleted. ───────────────
    // renderer.js reaches for this by FALLBACK_FONT_ID when an outline font's
    // file will not load. It has to be a BITMAP (a system-font
    // fallback substitutes different advance widths and cell metrics, so the
    // failure presents as a subtly wrong grid instead of an obvious error) and
    // it has to be on the LEGACY path, so that a device where the hybrid
    // layout is what went wrong still gets a terminal.
    //
    // It was the desktop default until the outline fonts arrived. Anyone who
    // explicitly chose it still resolves to it by id.
    id: 'vga8x16',
    name: 'IBM VGA 8×16',
    cellW: 8,
    cellH: 16,
    glyphs: VGA_FONT_8x16,
    hidden: true,
  },
  {
    // 40-COLUMN MODE. `cols` is what carries it: the font and the column count
    // are one choice, so selecting this font IS how 40 columns is entered and
    // there is no other route to it. Every other entry omits `cols` and gets
    // the default 80.
    //
    // Why they are tied: at 40 columns each cell renders twice as wide, and an
    // 8-wide font would therefore double the terminal's HEIGHT. A 9x14 cell is
    // wider *and* shorter, which brings that back to 1.56x — see the arithmetic
    // in vga-9x14.js. The pairing is the whole point; either half alone is bad.
    //
    // Hidden, kept: `vga9x14hr` is this font on the hybrid path and is what
    // the "Squat" slot now offers. This entry stays as the legacy-path
    // reference — and because a saved preference may name it.
    hidden: true,
    id: 'vga9x14',
    // No '40 col' in the name: every place the name is shown now states the
    // column count beside it, and saying it twice reads like a stutter.
    name: 'IBM VGA 9×14',
    cellW: 9,
    cellH: 14,
    cols: 40,
    glyphs: VGA_FONT_9x14,
  },
  {
    // ── SLOT 1: "Pixel" ──────────────────────────────────────────────────
    //
    // A pixel trace of the AST PremiumExec ROM bitmap: no off-curve points, no
    // fpgm, no prep. It carries no information the bitmap did not, and it still
    // beat both bitmap arms on a device — because what separates them is the
    // path to the screen, not the file. The bitmap path replicates an 8-px
    // source through a fixed mask, so a stem is 1 or 2 device pixels depending
    // on where in the cell it falls; an outline is rasterized once at the
    // target size and every stem gets the same treatment.
    //
    // Aspect is 4:3 natively: 100 x 100 units per cell on an 8x19 grid, so
    // 80x25 lands at 1.347. The same number the bitmap presents, which is what
    // made the comparison fair. pixelAspect stays 1.0.
    id: 'astpx8x19',
    uiName: 'Pixel',
    name: 'AST PremiumExec (outline)',
    kind: 'ttf',
    cellW: 8,
    cellH: 19,
    file: 'fonts/Px437_AST_PremiumExec.woff2',
    family: 'Px437 AST PremiumExec',
    upem: 2000,
    advance: 800,
    ascent: 1500,
    descent: 400,
    capHeight: 1200,
    xHeight: 800,
    scale: 'hybrid',
    // ── INK GAMMA ────────────────────────────────────────────────────────
    //
    // Stem darkening. Two things made this face read thin: the bitmap it
    // replaced was itself too bold (replication rounded a 1.75-px stem up to a
    // lit 2 in six cell positions of eight), and canvas composites in sRGB, so
    // a partial-coverage pixel of light ink on a dark ground lands below its
    // coverage in perceived luminance.
    //
    // a' = (a/255)^(1/g), partial coverage only, both endpoints pinned. NOT a
    // threshold and NOT a dilation: a pixel at 0 stays 0, so no glyph grows and
    // the full-cell graphics glyphs (already 0-or-255) are untouched — which is
    // what keeps this structurally unable to reopen the box-join work. It also
    // self-disables at an integer scale, where there is no partial coverage to
    // correct.
    //
    // 2.2 is the sRGB transfer exponent — the one value here with a derivation
    // rather than a judgement behind it. On this face only: Flexi's grey pixels
    // describe curves rather than position, and the 9x14's cell is nearly twice
    // as wide. The derivation and the rejected anchors are in FONTS.md.
    inkGamma: 1.0,
  },
  {
    // ── SLOT 2 (desktop): "Modern" ────────────────────────────────────────
    //
    // Flexi False, aspect-scaled to 1.600 by an offline transform: the native
    // face narrowed 8/9 so 80x25 presents at the IBM VGA 8x16 terminal aspect
    // instead of Flexi's native 1.800. The native file is too wide to use at
    // any size, which is what motivated the transform.
    //
    // The knob is the FILE, not the renderer: a setTransform stretch grid-fits
    // at one size and then scales the result, so snapped stems stop being whole
    // pixels. tools/fontaspect.py scaled X coordinates, the advance and the
    // stem-width cvt entries, leaving Y untouched; the source asset sits in
    // tools/datasource beside the original. The hinting is therefore fitted
    // APPROXIMATELY rather than natively — checkable with tools/probe.html on a
    // real device, and nothing here claims it has been.
    //
    // DESIGN GRID 16x32, not 9x16: cellH/cellW must equal
    // (ascent + descent)/advance or the atlas cell disagrees with the cell
    // outlineMetrics() typesets into. That ratio is 2, whose lowest terms are
    // far too coarse to rasterize on. 16x32 also keeps a one-column stem near
    // 1.8 raster pixels; at 8x16 it would land at 0.89 and could threshold
    // away, which for a box-drawing character means a seam.
    id: 'flexi160',
    uiName: 'Modern',
    name: 'Flexi IBM VGA False 1.60',
    // THE SLOT SUBSTITUTION. On a narrow screen the "Modern" slot resolves to
    // this id instead of to this entry — same slot, same label, same position
    // in the cycle, different file. It is expressed here rather than as a
    // second visible entry because the two are not alternatives the user picks
    // between: they are one choice whose right answer depends on the screen,
    // and offering both would put a font on each device that is known to be
    // the worse one there. cycleFonts() below is the only reader.
    mobileAltId: 'flexi135',
    kind: 'ttf',
    cellW: 16,
    cellH: 32,
    file: 'fonts/Flexi_IBM_VGA_False_A160_437.woff2',
    // MUST differ from the source's family: the browser keys a loaded FontFace
    // by family string, so two files sharing one would collide in
    // document.fonts and one of them would silently win.
    family: 'Flexi IBM VGA False A160 437',
    upem: 1600,
    advance: 800,      // 900 * 8/9 — the transform's whole point
    ascent: 1200,
    descent: 400,
    capHeight: 1000,   // unchanged: the transform touches X only
    xHeight: 700,
    scale: 'hybrid',
  },
  {
    // ── Flexi True — VileR's OTHER variant, shipped as itself ──────────────
    //
    // Not a replacement for False and not a scaled copy of it: the same
    // typeface with the horizontal geometry rebuilt and the hinting
    // re-authored for that geometry (only about half of True's points land on
    // 0.75 x False's, and cvt 32/33 read 150 against False's 200). Both ship.
    // This is the one variant on the TTF path that needs no transform at all —
    // it is a native file at its own aspect, which is exactly what FONTS.md
    // prefers over what `flexi160` above had to do.
    //
    // WHAT IT IS FOR: at a 1.350 terminal aspect it is within 0.2% of the AST
    // and IGS 8x19 bitmaps (1.347) and renders identical cap and x-height at
    // the same pitch — so it is the outline font for a portrait phone, where
    // False's short cell and 15-px caps read too fine. FONTS.md has the table.
    //
    // DESIGN GRID: 27x64. See the note on `flexi160` for why the pair must
    // satisfy cellH/cellW == (ascent + descent)/advance; here that is
    // 1600/675, which reduces EXACTLY to 64/27 (675 x 64 == 27 x 1600). Unlike
    // every entry above it, this font's cell is not made of square design
    // pixels — 75 units per column against 100 per row is the 1.333 aspect
    // correction baked into the file — so the grid is instead the smallest
    // square-pixel one that represents that cell exactly: 3 raster pixels per
    // design column, 4 per design row. Not a coincidence and not a fudge; a
    // 9x16 grid would present it at False's 1.800 and stretch the face.
    //
    // Metrics read from the shipped file, like every other entry;
    // tools/tests/ttftest.js re-reads them and fails if they drift.
    id: 'flexi135',
    // SAME LABEL as flexi160 on purpose: this is the mobile face of the
    // "Modern" slot, not a fourth choice. It carries `hidden` for the same
    // reason — cycleFonts() substitutes it INTO that slot rather than
    // appending it, so it must not also stand on its own.
    uiName: 'Modern',
    hidden: true,
    name: 'Flexi IBM VGA True',
    kind: 'ttf',
    cellW: 27,
    cellH: 64,
    file: 'fonts/Flexi_IBM_VGA_True_437.woff2',
    family: 'Flexi IBM VGA True 437',
    upem: 1600,
    advance: 675,
    ascent: 1200,
    descent: 400,
    capHeight: 1000,
    xHeight: 700,
    scale: 'hybrid',
  },
  {
    // ── The 40-column REFERENCE. Hidden, never deleted. ───────────────────
    //
    // `vga9x14`'s glyph array — literally the same imported object, not a copy
    // — on the hybrid path instead of the legacy one. It began as a controlled
    // comparison against `vga9x14`, held the "Squat" slot for a session,
    // and has now been replaced in that slot by `vga9x14px` below.
    //
    // WHY IT STAYS. Two reasons, both load-bearing:
    //   1. It is the bitmap arm of the comparison `vga9x14px` won, exactly as
    //      `ast8x19` was for `astpx8x19` before that comparison was settled and
    //      its bitmap arm deleted. Removing this one makes the next font
    //      decision unmeasurable while it is still open.
    //   2. It is the ONLY 9-wide bitmap on the hybrid path, and so the only
    //      entry that exercises fontscale.js's 2-byte glyph-row stride. The
    //      code is not 8-wide-specific, but nothing else proves it.
    // A saved preference naming it also still has to resolve.
    //
    // Why 40 columns deserves its own instrument rather than inheriting the
    // 80-column verdict: the defect the hybrid path exists to remove is a
    // resampling PHASE error, and its size depends on how far the backing
    // store is from the device grid. At 40 columns the backing store is 360 px
    // against 640, so a 1080-px device is an exact 3x (asserted
    // that inkW is 27 there) and the legacy path has nothing to fix — while at
    // 1170 or 1284, both common phone widths, the ratio is fractional and the
    // stems alternate exactly as they do at 80 columns. It is also the case
    // where the cost of being wrong is highest: each cell is twice as wide, so
    // a one-device-pixel stem error is a far larger fraction of the stroke.
    //
    // `cols: 40` rides along, necessarily: the column count is a property of
    // the font (see the entry above), so a hybrid variant of the 40-column
    // font is a 40-column font. It is the second entry in the registry to
    // carry `cols`, which is why tools/tests/fonttest.js no longer asserts that
    // exactly one does — it asserts that every entry carrying it is a 9x14.
    hidden: true,
    id: 'vga9x14hr',
    uiName: 'Squat',
    name: 'IBM VGA 9×14 (hybrid)',
    cellW: 9,
    cellH: 14,
    cols: 40,
    glyphs: VGA_FONT_9x14,
    scale: 'hybrid',
  },
  {
    // ── SLOT 3: "Squat" ──────────────────────────────────────────────────
    //
    // VileR's Px437 outline of the same 9x14 ROM the two entries above carry as
    // bitmaps: a pixel trace, no curves, no hinting, no aspect transform. It
    // carries no information the bitmap does not; it reaches the screen by the
    // better path, and by a wider margin than the AST did, because at 40
    // columns each cell is twice as wide so the replication mask misplaces a
    // stem by twice as much. `vga9x14hr` is kept as the reference that says so.
    //
    // No aspect correction, deliberately: 100 x 100 units per cell on a 9x14
    // grid is the ROM's own geometry, and 40x25 then lands at 360x350 — the
    // 1.56x that ties the column count to this font. pixelAspect stays 1.0.
    //
    // Design grid 9x14: 9 x 1400 == 14 x 900, so the required
    // (ascent + descent)/advance ratio reduces to the face's own square pixel
    // grid. tools/tests/ttftest.js re-derives it and fails on drift.
    id: 'vga9x14px',
    uiName: 'Squat',
    name: 'IBM VGA 9×14 (outline)',
    kind: 'ttf',
    cellW: 9,
    cellH: 14,
    cols: 40,
    file: 'fonts/Px437_IBM_VGA_9x14.woff2',
    family: 'Px437 IBM VGA 9x14',
    upem: 1600,
    advance: 900,
    ascent: 1100,
    descent: 300,
    capHeight: 900,
    xHeight: 600,
    scale: 'hybrid',
  },
  {
    // ── BOARD-SPECIFIC. Not in the cycle, and there is no route to it from the
    //    UI: an Amiga board is served this font because config/altfonts.txt
    //    names it, and for no other reason. That is its stated job.
    //
    // A handful of boards run on Amiga hardware (CNet, Ami-Express) and cut
    // their art against Topaz, the Workbench font. Two things are different
    // about them and both are carried by this ONE entry, which is why the
    // config file names a font and nothing else:
    //
    //   THE FACE. Amiga ASCII leans on Topaz's letterforms the way PC ANSI
    //   leans on CP437's box drawing — the shapes are the art.
    //
    //   THE CHARSET. AmigaOS is ISO-8859-1, so a board's high bytes are
    //   punctuation used as shading: 0xAF is a macron capping a letter, 0xB7 a
    //   middle dot, 0xAC a not sign. Read as CP437 those are `»`, `╖` and `¼`,
    //   which is why an Amiga board looks like static in a PC terminal.
    //   SyncTERM does the same thing the same way and says so in its manual: a
    //   font is chosen "and by implication, a codepage".
    //
    // WHICH TOPAZ. This is Topaz 2+ — the MODIFIED Kickstart 2.x font, SAUCE's
    // `Amiga Topaz 2+`. Not a guess: 184 of its 190 glyphs are pixel-identical
    // to the 8x16 `Topaz Plus (Amiga)` bitmap SyncTERM ships, against 167 for
    // the unmodified `Topaz (Amiga)`. The art files declare the same thing in
    // their SAUCE records.
    //
    // ASPECT IS 4:3, and the file did not arrive that way. The upstream tracing
    // is an 8x16 grid on SQUARE units, so it presents at 1.600 — flexi160's
    // widescreen shape, and 20% wider than an Amiga. That machine's text is
    // 640x200 (or 640x400 laced) on a 4:3 display, which makes the pixel 2.4
    // times taller than wide; SAUCE says the same, and a SyncTERM screenshot of
    // the target board measures ~2.44. tools/topazsubset.py stretches Y by 1.2
    // to put it there, so 80x25 lands at 1.3333 — within 1% of the AST 'Pixel'
    // arm, which is the company this font should keep. FONTS.md has the table.
    //
    // Design grid 15x36: 15 x 1920 == 36 x 800, so (ascent + descent)/advance is
    // exactly cellH/cellW. It is the SMALLEST legal pair that survives the
    // derive — at 10x24 a one-column stem falls to 1.25 raster pixels and 6.8%
    // of the face thresholds away; 15x36 puts it at 1.875, the figure flexi135
    // settles on, and misreads 0.26%.
    //
    // The shipped file is subsetted to the codepoints the Latin-1 table names —
    // tools/topazsubset.py, which is also where the ascent absorbed the 1602 the
    // upstream declares (a Nerd-icon overhang) and where U+2010 was pointed at
    // the soft-hyphen glyph. See fonts/latin1.js for why that last one is not
    // optional.
    hidden: true,
    id: 'topaz1200',
    uiName: 'Topaz',
    name: 'Amiga Topaz 2+ (outline)',
    kind: 'ttf',
    cellW: 15,
    cellH: 36,
    file: 'fonts/Topaz_a1200_Latin1.woff2',
    family: 'AmigaTopazUnicodeRus Nerd Font',
    upem: 1600,
    advance: 800,
    ascent: 1920,
    descent: 0,
    capHeight: 1440,
    xHeight: 960,
    scale: 'hybrid',
    charset: LATIN1,
  },
];

/** True for an outline (TTF) entry. Absent `kind` => bitmap, as it always was. */
export const isTTF = (font) => !!font && font.kind === 'ttf';

/** Columns this font implies. Only the 40-column font overrides it. */
export const fontCols = (font) => font.cols || 80;

/**
 * Bytes per pixel row in a font's glyph array — 1 for 8-wide, 2 for 9-wide.
 *
 * Bitmap-only, and it THROWS for an outline entry rather than returning a
 * plausible number. An outline font has no glyph array, so every caller of this
 * is about to index into `undefined`; failing here names the bug, while
 * returning 1 would produce a stride that renders convincing garbage.
 */
export const fontStride = (font) => {
  if (isTTF(font)) throw new Error(`fontStride(): ${font.id} is an outline font and has no stride`);
  return (font.cellW + 7) >> 3;
};

/**
 * The three slots the Aa button cycles, on a WIDE screen — FONTS minus
 * anything flagged `hidden`. Hidden fonts stay loadable by id (so a saved
 * preference or an explicit call still works); they're just not reachable from
 * the UI.
 *
 * Prefer `cycleFonts(mobile)` in app code. This export is the desktop case of
 * it and stays because it is the stable thing to assert a slot ORDER against.
 */
export const CYCLE_FONTS = FONTS.filter((f) => !f.hidden);

/**
 * The cycle as it exists on a given screen, with each slot's device variant
 * substituted in.
 *
 * The list is the same LENGTH and the same ORDER on every device — that is the
 * contract, and it is what lets an index into it survive a rotation. Only the
 * font behind a slot changes. Today exactly one slot ("Modern") carries a
 * variant; the mechanism is general so that the next one costs a field rather
 * than a branch in main.js.
 *
 * @param {boolean} mobile  true on a narrow screen (main.js owns the breakpoint)
 */
export function cycleFonts(mobile) {
  return CYCLE_FONTS.map((f) => (mobile && f.mobileAltId ? fontById(f.mobileAltId) : f));
}

/** What the Aa button calls a font. Falls back to the technical name. */
export const fontLabel = (font) => (font && font.uiName) || (font && font.name) || '';

/**
 * The font a new visitor gets. The same on every device: `Pixel` is one file at
 * one cell, unlike the "Modern" slot which substitutes by screen width.
 *
 * It is an OUTLINE font, so the first paint of a fresh visit waits on a network
 * fetch — see FALLBACK_FONT_ID.
 */
export const DEFAULT_FONT_ID = 'astpx8x19';

/**
 * Where the renderer goes when an outline font's file will not load.
 *
 * Separate from DEFAULT_FONT_ID because the default is itself an outline font
 * now, and an outline font cannot be the fallback for an outline font: the
 * whole failure being handled is "a woff2 did not arrive", and answering it
 * with a different woff2 can fail the same way. FONTS.md also forbids
 * falling through to a system font, so the fallback must be a BITMAP entry in
 * this registry — which is the reason `vga8x16` is hidden rather than deleted.
 */
export const FALLBACK_FONT_ID = 'vga8x16';

/**
 * Resolve a font id, falling back to the DEFAULT rather than to FONTS[0].
 *
 * FONTS[0] used to be the default, so the two were the same answer. They are
 * not any more — position 0 is now the hidden bitmap fallback — and an
 * unrecognised id (a preference saved before a font was removed, say) must
 * land on the font a new visitor would get, not on one the UI cannot reach.
 */
export function fontById(id) {
  return FONTS.find((f) => f.id === id)
      || FONTS.find((f) => f.id === DEFAULT_FONT_ID)
      || FONTS[0];
}

export function fontIndexById(id) {
  const i = FONTS.findIndex((f) => f.id === id);
  return i < 0 ? 0 : i;
}

/**
 * Position of `id` within the visible cycle (0 if it isn't in it).
 *
 * Device-aware, because a slot's mobile variant is not in CYCLE_FONTS: asking
 * for `flexi135`'s position on a phone must answer 0 (the "Modern" slot), not
 * "not found". Passing `mobile` is optional so the many callers that only care
 * about the desktop order are unchanged.
 */
export function cycleIndexById(id, mobile = false) {
  const i = cycleFonts(mobile).findIndex((f) => f.id === id);
  return i < 0 ? 0 : i;
}

/**
 * The font auto-selected on narrow screens.
 *
 * `mobileDefault` currently sits on NO entry, so this resolves to
 * DEFAULT_FONT_ID — the default is the same font on both devices, because slot
 * 0 is "Pixel" and Pixel is one file at one cell. The flag and this lookup stay
 * because the mechanism is still wanted: a future slot 0 that substitutes by
 * screen width (the way "Modern" does) would need it, and re-deriving it then
 * is worse than leaving four working lines here.
 *
 * It is NOT the same mechanism as `mobileAltId`. That substitutes a file INTO a
 * slot, keeping the cycle the same length and order on both devices; this picks
 * which SLOT a device starts on. Slot 0 either way, at present.
 */
export function mobileDefaultFont() {
  return FONTS.find((f) => f.mobileDefault) || fontById(DEFAULT_FONT_ID);
}

/** The font a device gets before the user has expressed any preference. */
export const deviceDefaultFont = (mobile) =>
  (mobile ? mobileDefaultFont() : fontById(DEFAULT_FONT_ID));

/**
 * Build a pre-rendered sprite sheet of all 256 glyphs of `font`.
 *
 * The sheet is 256 * cellW wide and cellH tall. Each glyph is rendered in pure
 * white on transparent, ready to be tinted at draw time via
 * globalCompositeOperation.
 *
 * @param {object} font  a FONTS entry
 * @returns {OffscreenCanvas}
 */
export function buildFontSheet(font) {
  const { cellW, cellH, glyphs } = font;
  // Bytes per pixel row. Was implicitly 1 until a 9-wide font arrived; reading
  // it from cellW keeps every existing 8-wide font byte-for-byte unchanged.
  const stride = fontStride(font);
  const totalW = 256 * cellW;
  const canvas = new OffscreenCanvas(totalW, cellH);
  const ctx = canvas.getContext('2d');

  ctx.clearRect(0, 0, totalW, cellH);

  const imgData = ctx.createImageData(totalW, cellH);
  const pixels = imgData.data; // RGBA Uint8ClampedArray

  for (let glyph = 0; glyph < 256; glyph++) {
    const glyphBase = glyph * cellH * stride;   // offset into the glyph array
    const xBase = glyph * cellW;                // pixel x of this glyph's left edge

    for (let row = 0; row < cellH; row++) {
      // Assemble the row's bytes big-endian into one integer, so the bit test
      // below is the same for any width. At stride 1 this is the original byte.
      let bits = 0;
      for (let b = 0; b < stride; b++) bits = (bits << 8) | glyphs[glyphBase + row * stride + b];
      if (!bits) continue;             // blank row — leave it transparent
      const msb = stride * 8 - 1;
      for (let col = 0; col < cellW; col++) {
        // MSB of the first byte = leftmost pixel
        if ((bits >> (msb - col)) & 1) {
          const p = ((row * totalW) + xBase + col) * 4;
          pixels[p + 0] = 255; // R
          pixels[p + 1] = 255; // G
          pixels[p + 2] = 255; // B
          pixels[p + 3] = 255; // A
        }
      }
    }
  }

  ctx.putImageData(imgData, 0, 0);
  return canvas;
}

/**
 * Build a PRESCALED sprite sheet for the hybrid path.
 *
 * Same contract as buildFontSheet() — 256 glyphs, pure white on transparent,
 * tinted downstream — but every glyph is already at its device-pixel size, so
 * the renderer blits 1:1 instead of asking drawImage to scale.
 *
 * The scaling is plain nearest-neighbour selection through the two masks in
 * `layout`, and the masks are the SAME for all 256 glyphs. That is the entire
 * mechanism, and the fact that it is fixed is the whole point: the resampling
 * phase is locked to the glyph origin rather than to the screen origin, so two
 * instances of one character are byte-identical however their columns fall.
 *
 * No smoothing anywhere. Interpolating an 8-px-wide source invents no
 * letterform detail and costs contrast, and the chunky low-resolution shape is
 * doing real legibility work at small sizes. (The TTF path is the exception —
 * because there the grey pixels carry genuine sub-pixel
 * curve information. That does not apply to a bitmap.)
 *
 * @param {object} font    a FONTS entry
 * @param {object} layout  from fontscale.layout() — supplies inkW/inkH/masks
 * @returns {OffscreenCanvas} 256 * inkW wide, inkH tall
 */
export function buildScaledFontSheet(font, layout) {
  const { cellW, cellH, glyphs } = font;
  // The PADDED masks and the PADDED cell — one column and one row larger than
  // the ink extent, the extra one repeating the last. That extension is what
  // covers the residue in a wide cell, and it replaced scaling the glyph to
  // the cell rect: see extendMask() in fontscale.js for why scaling was worse.
  const { padW, padH, srcColPad: srcCol, srcRowPad: srcRow } = layout;
  const stride = fontStride(font);
  const totalW = 256 * padW;
  const canvas = new OffscreenCanvas(totalW, padH);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, totalW, padH);

  const imgData = ctx.createImageData(totalW, padH);
  const pixels = imgData.data;
  const msb = stride * 8 - 1;

  // Unpack each source row ONCE per glyph into a bit field, then let the row
  // mask select from those. A duplicated source row costs a re-read of an
  // integer rather than a re-unpack of its bytes.
  const rowBits = new Int32Array(cellH);

  for (let glyph = 0; glyph < 256; glyph++) {
    const glyphBase = glyph * cellH * stride;
    for (let row = 0; row < cellH; row++) {
      let bits = 0;
      for (let b = 0; b < stride; b++) bits = (bits << 8) | glyphs[glyphBase + row * stride + b];
      rowBits[row] = bits;
    }

    const xBase = glyph * padW;
    for (let k = 0; k < padH; k++) {
      const bits = rowBits[srcRow[k]];
      if (!bits) continue;                       // blank row — stays transparent
      const rowOff = (k * totalW + xBase) * 4;
      for (let j = 0; j < padW; j++) {
        if ((bits >> (msb - srcCol[j])) & 1) {
          const p = rowOff + j * 4;
          pixels[p + 0] = 255;
          pixels[p + 1] = 255;
          pixels[p + 2] = 255;
          pixels[p + 3] = 255;
        }
      }
    }
  }

  ctx.putImageData(imgData, 0, 0);
  return canvas;
}

// ── Outline (TTF) path ──────────────────────────────────────────────────────
//
// Both paths produce the SAME artifact — a glyph atlas of 256
// fixed-size cells — so everything downstream of the atlas is indifferent to
// which produced it. A bitmap font fills atlas cells by ratio-masked pixel
// replication; an outline font fills them with fillText. Nothing else differs.
//
// That convergence is also why the outline path inherits the consistency
// property for free: the atlas is rasterized ONCE per glyph at an integer cell
// origin, so every instance of a glyph is byte-identical wherever it lands —
// the same guarantee the bitmap masks provide, obtained differently.

/**
 * Load an outline font's file and confirm the browser will actually use it.
 *
 * The check after the load is the gate, and a failure must NEVER
 * fall through to a system font. A system fallback would silently substitute
 * different advance widths and cell metrics, and the failure mode would be a
 * terminal whose grid is subtly wrong rather than an obvious error. The caller
 * is expected to fall back to a BITMAP font from this registry instead.
 *
 * @returns {Promise<boolean>} true if the family is loaded and usable
 */
export async function loadOutlineFont(font) {
  if (!isTTF(font)) return false;
  try {
    if (!self.FontFace || !self.document || !document.fonts) return false;
    if (!outlineFaceResident(font.family)) {
      const face = new FontFace(font.family, `url(${font.file})`);
      await face.load();
      document.fonts.add(face);
    }
    return outlineMetricsAgree(font);
  } catch (_) {
    return false;                                        // caller falls back
  }
}

/**
 * Is a FontFace for this family actually registered and loaded?
 *
 * DO NOT use `document.fonts.check()` for this. It answers "would every font
 * needed to render this text be ready", and for a family with NO registered
 * faces the answer is YES — because the fallback is ready. So `check()` returns
 * true for a family that does not exist, and using it as an "already resident"
 * shortcut skips the fetch and hands the terminal a system font.
 *
 * That is not a hypothetical: it is the bug this function was written to fix.
 * The symptom was Flexi's 9-unit advance measuring 11.55 px at fontSize 16,
 * glyphs overflowing into their neighbours' cells, and every glyph therefore
 * classifying as full-cell. It is also precisely the failure FONTS.md
 * describes — "a terminal whose grid is subtly wrong rather than an obvious
 * error" — arriving through the very call meant to prevent it.
 *
 * The face set is small (one entry here), so iterating it is free.
 */
function outlineFaceResident(family) {
  for (const face of document.fonts) {
    // FontFace.family round-trips with the quoting stripped.
    if (face.family.replace(/^["']|["']$/g, '') === family && face.status === 'loaded') {
      return true;
    }
  }
  return false;
}

/**
 * Confirm the browser is really typesetting with THIS font's metrics.
 *
 * The honest gate. A monospace outline
 * font has exactly one advance width, and it is a fixed fraction of the point
 * size: `advance / upem`. Measure it. If what comes back is that fraction, the
 * declared metrics and the rendered ones agree and the grid will hold; if it is
 * anything else, some other font is being used no matter what any API said, and
 * the caller must fall back to a bitmap.
 *
 * This also catches a case a load check never could: a font file that loads
 * perfectly but whose metrics have drifted from what the registry declares.
 */
function outlineMetricsAgree(font) {
  const probeSize = 64;                       // big enough that rounding is noise
  const expected = probeSize * font.advance / font.upem;
  const c = new OffscreenCanvas(8, 8);
  const g = c.getContext('2d');
  g.font = `${probeSize}px "${font.family}"`;
  // Two different characters: a proportional fallback would almost certainly
  // disagree between them, and any single glyph could coincide by chance.
  const a = g.measureText(CP437_CHARS[0x41]).width;   // 'A'
  const b = g.measureText(CP437_CHARS[0x69]).width;   // 'i'
  const tol = 0.02 * expected;                // 2% — subpixel rounding only
  return Math.abs(a - expected) < tol && Math.abs(b - expected) < tol;
}

/**
 * The atlas cell's type-setting metrics, all derived from the font file.
 *
 * `fontSize` is chosen so ONE advance width equals the ink extent
 * the layout picked, which is what keeps an outline font on the same fixed grid
 * a terminal needs. Nothing here is hardcoded — for Flexi False the factor
 * works out to inkW * 1.7778, so a 13.5-px pitch gives 24.0px exactly.
 */
export function outlineMetrics(font, inkW) {
  const fontSize = inkW * font.upem / font.advance;
  return {
    fontSize,
    baseline: Math.round(fontSize * font.ascent / font.upem),
    cellPx: fontSize * (font.ascent + font.descent) / font.upem,
  };
}

/**
 * Rasterize an outline font onto its own DESIGN GRID and threshold to 1 bit,
 * producing a bitmap in the exact format the rest of this file already speaks.
 *
 * Why this exists: full-cell glyphs — blocks, shades
 * and box drawing — do NOT come from fillText. Flexi's `█` has a bounding box
 * of exactly the full design cell, so in principle it tiles, but it rasterizes
 * with antialiasing at a fractional cell size, so its edges are grey and
 * adjacent cells show a seam. A correct CP437 coverage removes the availability
 * problem, not the tiling problem.
 *
 * There are two ways to classify which glyphs those are: the outline's
 * bounding box against the design cell, or the fixed CP437 ranges. This takes a
 * third that is equivalent to the first and needs no data checked in beside the
 * font — rasterize, threshold, and hand the result to the SAME derived
 * classifier the bitmap path uses. One classifier, one definition of "spans the
 * cell", and a font added later is correct without an edit. tools/tests/ttftest.js
 * cross-checks the result against the outline bounding boxes read straight out
 * of the file, so a rasterization that misclassified would fail rather than
 * quietly seam.
 *
 * The thresholded bitmap is also what those glyphs are DRAWN from, which is how
 * they get hard edges that tile.
 *
 * @returns {object} a bitmap-font-shaped { cellW, cellH, glyphs }
 */
/**
 * Alpha at or above which a design-grid pixel counts as ink.
 *
 * At the design grid one design pixel IS one device pixel — `outlineMetrics`
 * sizes it so — and every glyph in these faces is a union of axis-aligned
 * rectangles on that grid. A faithful rasterization therefore returns 0 or 255
 * and NOTHING ELSE; measured over all 256 glyphs of the AST face it does
 * exactly that, 29377 pixels at 0 and 9535 at 255, with no intermediate value.
 *
 * So an in-between value here is not shape, it is rasterizer error, and the
 * threshold's job is to reject it rather than to split it down the middle. At
 * 50% a rasterizer that lays down a little extra ink — enough to give a gap
 * pixel ~60% coverage — closes that gap permanently in the derived bitmap.
 * That is fatal for the glyphs built from ONE-PIXEL gaps: `═` and `║` and the
 * rest of the double-line box set, which then draw as a single thick stem.
 *
 * 192 is three quarters: far above any plausible spill into a gap that should
 * be empty, and far below the 255 a genuinely covered pixel returns. It is not
 * tuned against a screenshot — the gap between "0 or 255" and "anything else"
 * is wide enough that any value well inside it behaves identically on a
 * faithful rasterizer.
 */
export const DERIVE_THRESHOLD = 192;

export function deriveOutlineBitmap(font) {
  const W = font.cellW, H = font.cellH;
  const stride = (W + 7) >> 3;
  const glyphs = new Uint8Array(256 * H * stride);

  // Rasterize the whole set in one strip at the design grid.
  const totalW = 256 * W;
  const c = new OffscreenCanvas(totalW, H);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.clearRect(0, 0, totalW, H);
  const m = outlineMetrics(font, W);
  const cs = charsetOf(font);
  g.font = `${m.fontSize}px "${font.family}"`;
  g.textBaseline = 'alphabetic';
  g.fillStyle = '#fff';
  for (let i = 0; i < 256; i++) {
    if (cs.blank(i)) continue;                           // no printable character
    g.fillText(cs.chars[i], i * W, m.baseline);          // one glyph, integer origin
  }

  const d = g.getImageData(0, 0, totalW, H).data;
  for (let i = 0; i < 256; i++) {
    for (let row = 0; row < H; row++) {
      for (let col = 0; col < W; col++) {
        if (d[((row * totalW) + i * W + col) * 4 + 3] >= DERIVE_THRESHOLD) {
          const byte = i * H * stride + row * stride + (col >> 3);
          glyphs[byte] |= 0x80 >> (col & 7);
        }
      }
    }
  }
  // The charset rides along because classifyStretch() is handed THIS object,
  // not the registry entry — the outline path classifies the thresholded
  // bitmap. Undefined for every font that names no charset, which resolves to
  // CP437 exactly as before.
  return { id: `${font.id}:derived`, cellW: W, cellH: H, glyphs, charset: font.charset };
}

/**
 * The ink-gamma curve, as a 256-entry lookup table over the ALPHA channel.
 *
 *     a' = 255 * (a / 255) ^ (1 / g)
 *
 * Separated from the atlas build, and returned as a table rather than applied
 * as a function, for two reasons: it is the whole of the arithmetic, so
 * tools/tests/ttftest.js can assert its properties without a browser or a font file;
 * and the atlas build then costs one array lookup per pixel instead of a
 * `Math.pow` per pixel, which at 256 cells of a device-sized atlas is the
 * difference between free and not.
 *
 * The three properties the tests hold it to, all of which the registry comment
 * on `inkGamma` leans on:
 *
 *   - MONOTONIC NON-DECREASING. It redistributes weight; it never reorders it.
 *   - ENDPOINTS PINNED: 0 -> 0 and 255 -> 255. This is what makes the curve
 *     unable to grow a glyph or to touch a fully-covered pixel, and therefore
 *     unable to disturb pass 1's graphics glyphs, which are already 0-or-255.
 *   - g = 1 IS THE IDENTITY, exactly, at every entry — so a font with no
 *     `inkGamma` is not merely "approximately unchanged", it is bit-identical,
 *     and the two fonts that opted out can be asserted so.
 *
 * @param {number} g  gamma; 1 (or absent) means no change
 * @returns {Uint8Array} 256 entries mapping source alpha to adjusted alpha
 */
export function inkGammaLUT(g) {
  const lut = new Uint8Array(256);
  for (let a = 0; a < 256; a++) {
    // g === 1 short-circuits rather than relying on Math.pow(x, 1) — it does
    // return x exactly, but the identity is load-bearing enough to state.
    lut[a] = g === 1 ? a : Math.round(255 * Math.pow(a / 255, 1 / g));
  }
  return lut;
}

/**
 * Unsharp mask over an ALPHA PLANE, per atlas cell.
 *
 *     a' = clamp(a + amount * (a - blur(a)))
 *
 * with `blur` a separable 1-2-1 tent, edge-replicated. A tent rather than a box
 * because a box blur of a diagonal is visibly blocky, and the diagonals are
 * most of what there is to sharpen.
 *
 * Separated from the atlas build, and written over a bare plane rather than
 * over ImageData, so it can be asserted in Node with no browser and no font
 * file — the same reason inkGammaLUT() returns a table.
 *
 * THE TAPS ARE CLAMPED TO THE CELL, NOT TO THE STRIP. The atlas is 256 cells
 * side by side in one image, so a kernel at a cell's column 0 would otherwise
 * reach into the PREVIOUS GLYPH's last column and smear one character's ink
 * into its neighbour. It would be invisible on most pairs and wrong on some,
 * which is the worst way for it to be wrong.
 *
 * Three properties fall out of the arithmetic, and the tests hold it to them:
 *
 *   - amount 0 IS THE IDENTITY, exactly. Callers are expected to skip the pass
 *     instead, but the function must not need them to.
 *   - A UNIFORM REGION IS A FIXED POINT. blur(uniform) === uniform, so the
 *     difference is zero: the interior of a solid glyph and the empty space
 *     around it both come back untouched, whatever the amount.
 *   - INK NEVER GROWS. Where a === 0 the result is -amount * blur, which is
 *     <= 0 and clamps to 0. A transparent pixel cannot be made to carry ink,
 *     so the mask can sharpen a letterform but never widen or bleed one.
 *
 * @param {Uint8Array|Uint8ClampedArray} a  alpha plane, w * h, row-major
 * @param {number} w        plane width in px (256 * cellW for a full atlas)
 * @param {number} h        plane height in px
 * @param {number} cellW    one cell's width; taps never cross a multiple of it
 * @param {number} amount   strength; 0 means no change
 * @param {Uint8Array} [skip]  per-cell flags; a truthy entry leaves that cell
 *                             byte-identical (used for the graphics glyphs)
 * @returns {Uint8Array} a NEW plane; the input is not modified
 */
export function unsharpAlpha(a, w, h, cellW, amount, skip) {
  const out = new Uint8Array(a);            // copy: amount 0 returns it as-is
  if (!(amount > 0)) return out;

  const cells = Math.floor(w / cellW);

  for (let c = 0; c < cells; c++) {
    if (skip && skip[c]) continue;
    const x0 = c * cellW, x1 = x0 + cellW - 1;

    for (let y = 0; y < h; y++) {
      // Row-clamped neighbours, computed once per row rather than per pixel.
      const yUp = (y > 0 ? y - 1 : 0) * w;
      const yMid = y * w;
      const yDn = (y < h - 1 ? y + 1 : h - 1) * w;

      for (let x = x0; x <= x1; x++) {
        const xL = x > x0 ? x - 1 : x0;     // CELL edges, not image edges
        const xR = x < x1 ? x + 1 : x1;

        // Separable 1-2-1 both ways == this 3x3 / 16.
        const blur = (
          a[yUp + xL] + 2 * a[yUp + x] + a[yUp + xR] +
          2 * (a[yMid + xL] + 2 * a[yMid + x] + a[yMid + xR]) +
          a[yDn + xL] + 2 * a[yDn + x] + a[yDn + xR]
        ) / 16;

        const v = Math.round(a[yMid + x] + amount * (a[yMid + x] - blur));
        out[yMid + x] = v < 0 ? 0 : (v > 255 ? 255 : v);
      }
    }
  }
  return out;
}

/**
 * Build the prescaled atlas for an outline font.
 *
 * Two passes into one canvas, in this order because they use incompatible
 * drawing primitives and the second must not be erased by the first:
 *
 *   1. STRETCH GLYPHS, as raw pixels through the ratio masks (putImageData).
 *      Hard edges, so they tile into the cell rect with no seam.
 *   2. LETTERFORMS, via fillText, ANTIALIASED. The argument
 *      against smoothing a bitmap does not apply here: the grey pixels on
 *      Flexi's bowls and diagonals carry genuine sub-pixel shape information,
 *      which is the whole reason an outline is worth shipping.
 *
 * @param {object} font     a FONTS entry with kind 'ttf'
 * @param {object} layout   from fontscale.layout()
 * @param {object} derived  from deriveOutlineBitmap()
 * @param {Uint8Array} stretch  per-glyph axis flags, from classifyStretch(derived)
 * @returns {OffscreenCanvas} 256 * inkW wide, inkH tall, white on transparent
 */
export function buildOutlineFontSheet(font, layout, derived, stretch) {
  // Padded cell and padded masks, exactly as on the bitmap path — the
  // edge-extension column and row that let the blit stay 1:1 while still
  // covering the residue. See extendMask() in fontscale.js.
  const { inkW, padW, padH, srcColPad: srcCol, srcRowPad: srcRow } = layout;
  const totalW = 256 * padW;
  const canvas = new OffscreenCanvas(totalW, padH);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, totalW, padH);

  // ── Pass 1: stretch glyphs, from the thresholded design-grid bitmap ──────
  const stride = (derived.cellW + 7) >> 3;
  const msb = stride * 8 - 1;
  const img = ctx.createImageData(totalW, padH);
  const px = img.data;
  let anyStretch = false;

  for (let i = 0; i < 256; i++) {
    if (!stretch[i]) continue;
    anyStretch = true;
    const base = i * derived.cellH * stride;
    const xBase = i * padW;
    for (let k = 0; k < padH; k++) {
      const r = srcRow[k];
      let bits = 0;
      for (let b = 0; b < stride; b++) bits = (bits << 8) | derived.glyphs[base + r * stride + b];
      if (!bits) continue;
      const rowOff = (k * totalW + xBase) * 4;
      for (let j = 0; j < padW; j++) {
        if ((bits >> (msb - srcCol[j])) & 1) {
          const p = rowOff + j * 4;
          px[p] = px[p + 1] = px[p + 2] = px[p + 3] = 255;
        }
      }
    }
  }
  if (anyStretch) ctx.putImageData(img, 0, 0);

  // ── Pass 2: letterforms, via fillText ────────────────────────────────────
  const m = outlineMetrics(font, inkW);
  const cs = charsetOf(font);
  ctx.font = `${m.fontSize}px "${font.family}"`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#fff';                       // white on transparent; tinted downstream
  ctx.imageSmoothingEnabled = true;             // outline path only

  for (let i = 0; i < 256; i++) {
    if (stretch[i]) continue;                   // drawn in pass 1
    if (cs.blank(i)) continue;                  // no printable character, never .notdef
    // ONE glyph, into its own atlas cell, at an integer origin. fillText
    // is never called on a run of text — browser layout applies kerning,
    // ligatures, shaping and fractional advances, every one of which destroys
    // the fixed grid a terminal depends on. The atlas is the boundary.
    //
    // Origin is `i * padW`, the padded cell's left edge, while the type size
    // still comes from `inkW`: the pad column is spare room at the RIGHT of the
    // cell, not a wider cell. A letterform never reaches it (that is what
    // classifyStretch() having left it unflagged means), so it stays blank and
    // the extra pixel of a wide cell reads as tracking — which is what it is.
    ctx.fillText(cs.chars[i], i * padW, m.baseline);
  }

  // ── Pass 3: ink gamma — stem darkening on the alpha channel ──────────────
  // See the `inkGamma` block on the AST entry in the registry above for why
  // this exists and why it is on that font alone. Mechanically it is one curve
  // over alpha and nothing else:
  //
  //   - ALPHA ONLY. `fillStyle` is white, so every pixel here is (255,255,255,a)
  //     and the coverage lives entirely in `a`. Downstream, _fgSheet() fills a
  //     solid palette colour and masks it with this alpha via `destination-in`,
  //     so adjusting `a` IS adjusting how much of the character's colour lands.
  //     Touching RGB would do nothing at all.
  //   - AFTER PASS 1, HARMLESSLY. The graphics glyphs written by putImageData
  //     are 0-or-255, both of which the curve pins, so running over the whole
  //     strip rather than skipping their cells costs a lookup and changes
  //     nothing. Keeping it unconditional is worth more than the lookup: a
  //     version that skipped cells would have to agree with `stretch[]` about
  //     which ones, and that is a second place to get the classification wrong.
  //   - ONLY WHEN ASKED. No field, or 1, and the whole pass is skipped — not
  //     "applied as an identity". A font that opted out never has its pixels
  //     read back at all.
  //
  // ── Pass 4: sharpening mask — see public/fontmask.js ─────────────────────
  // The same alpha channel and the same argument for why alpha is the right
  // place, so the two share ONE read-back: getImageData over a device-sized
  // strip is the expensive part and there is no reason to pay it twice.
  //
  // Ordering is gamma THEN sharpen, and it matters: gamma redistributes the
  // weight within the skirt, so sharpening after it works on the coverage that
  // will actually be drawn. The reverse order sharpens values the gamma then
  // moves, and the strength stops meaning the same thing from one font to the
  // next.
  //
  // Unlike gamma, this pass is NOT safe to run over the whole strip. The curve
  // pins 0 and 255, so pass 1's graphics glyphs were immune to it; an unsharp
  // mask rings instead, and a halo on the edge of a shade or a box-drawing
  // character is precisely what stops a run of them tiling. So the cells pass 1
  // drew are skipped — by handing the function `stretch[]`, pass 1's own answer
  // about which cells those are, rather than by classifying them a second time.
  const g = font.inkGamma;
  const sharpen = maskFor(font.id);
  if ((g && g !== 1) || sharpen > 0) {
    const sheet = ctx.getImageData(0, 0, totalW, padH);
    const sp = sheet.data;

    if (g && g !== 1) {
      const lut = inkGammaLUT(g);
      for (let p = 3; p < sp.length; p += 4) sp[p] = lut[sp[p]];
    }

    if (sharpen > 0) {
      // De-interleave to a bare alpha plane and back. The copy is one pass over
      // a quarter of the buffer; keeping the kernel off ImageData is what lets
      // it be tested without a canvas at all.
      const plane = new Uint8Array(totalW * padH);
      for (let i = 0, p = 3; i < plane.length; i++, p += 4) plane[i] = sp[p];
      const sharp = unsharpAlpha(plane, totalW, padH, padW, sharpen, stretch);
      for (let i = 0, p = 3; i < sharp.length; i++, p += 4) sp[p] = sharp[i];
    }

    ctx.putImageData(sheet, 0, 0);
  }

  return canvas;
}
