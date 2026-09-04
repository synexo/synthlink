/*
 * fontscale.js — hybrid ratio glyph scaling. Pure arithmetic; no DOM, no canvas.
 *
 * The legacy path sizes the backing store from logical cell metrics and lets
 * CSS stretch it, so the resampling PHASE varies from cell to cell and stems
 * alternate 1 and 2 device pixels inside one letterform. That instability is
 * the defect. Here every glyph is prescaled ONCE into an atlas and the atlas
 * cells are blitted 1:1, which locks the phase to the glyph origin instead of
 * the screen origin.
 *
 * Opt-in: a registry entry carries `scale: 'hybrid'`. Fonts without it take the
 * untouched legacy path in renderer.js.
 *
 * Reusability contract: every function derives its numbers from its arguments.
 * No font-specific constants, no resolution-specific constants, no device
 * branches — a font added later is correct without editing this file.
 *
 * SynthLink's own code, GPL-3.0-or-later.
 */

import { CP437, charsetOf } from './fonts/charsets.js';

/*
 * pixelAspect is 1.0 here, always: every font that reaches this module carries
 * its intended aspect in the asset itself, so re-correcting at render time
 * would double it. `pixelAspect()` below is provided and tested but NOT used by
 * `layout()` — it is the tool an uncorrected square-pixel bitmap would need,
 * and no such font ships. The aspect policy and its worked table are in
 * FONTS.md.
 */
export const PIXEL_ASPECT = 1.0;

/** True if this font takes the hybrid path. Absent flag => legacy, unchanged. */
export const isHybrid = (font) => !!font && font.scale === 'hybrid';

// ── Glyph introspection ─────────────────────────────────────────────────────
// Both derived from the bitmap. Nothing is enumerated by codepoint, so the
// classification survives a font swap — which is why this measures rather than
// hardcoding the CP437 line-graphics range.

/**
 * Unpack one glyph row into a bit field, MSB = leftmost pixel.
 * Duplicated deliberately from buildFontSheet()'s unpacking rather than shared:
 * this module must stay DOM-free so the test harness can import it.
 */
function glyphRowBits(font, code, row) {
  const stride = (font.cellW + 7) >> 3;
  const base = code * font.cellH * stride + row * stride;
  let bits = 0;
  for (let b = 0; b < stride; b++) bits = (bits << 8) | font.glyphs[base + b];
  return bits;
}

/** Is source column `col` clear across every row of glyph `code`? */
export function glyphColumnBlank(font, code, col) {
  const msb = ((font.cellW + 7) >> 3) * 8 - 1;
  for (let r = 0; r < font.cellH; r++) {
    if ((glyphRowBits(font, code, r) >> (msb - col)) & 1) return false;
  }
  return true;
}

/** Is source row `row` clear across every column of glyph `code`? */
export function glyphRowBlank(font, code, row) {
  return glyphRowBits(font, code, row) === 0;
}

/**
 * Is source column `col` clear across EVERY glyph in the font?
 *
 * The blank-column test. It has to be font-wide rather than
 * per-glyph because the mask is font-wide: a column that some glyph inks is not
 * a safe column to sacrifice, even if the glyph being drawn leaves it clear.
 *
 * Note that on every 8-wide CP437 font in this repo column 7 is NOT universally
 * blank — box-drawing and block characters reach it, by design, so that they
 * join across cells. So this returns false for them and the guard below simply
 * does not fire. That is correct: the guard exists to preserve DESIGNED advance
 * space, and a font whose last column carries ink has none to preserve.
 */
export function fontColumnBlank(font, col) {
  for (let c = 0; c < 256; c++) if (!glyphColumnBlank(font, c, col)) return false;
  return true;
}

/** Font-wide equivalent on the vertical axis — blank leading / descender rows. */
export function fontRowBlank(font, row) {
  for (let c = 0; c < 256; c++) if (!glyphRowBlank(font, c, row)) return false;
  return true;
}

/**
 * Per-glyph, per-axis EDGE-CONTACT classification: which glyphs must meet their
 * neighbours, and on which axis.
 *
 * Two parts, and both are here because the obvious one-part versions shipped
 * bugs. The SET is "graphics glyph": CP437 0xB0-0xDF, or any glyph with a fully
 * inked row or column. Not a bounding box that spans the cell — that is the
 * predicate this replaced, and it excluded every corner and tee, which then
 * went down the antialiased fillText path and did not line up with the `─`
 * beside them. Not a bbox either, even for the fully-inked test: `J` inks
 * column 7 on its bar and column 0 on its tail, so its bbox spans the cell.
 * The AXES are then edge contact. Edge contact alone cannot pick the set — in a
 * CP437 ROM font the advance space is the right-hand column only, so letters
 * ink column 0 and "touches either edge" flags 199 of 256 glyphs.
 *
 * The codepoint range is the one tabulated constant here. It is a property of
 * CP437, not of any font, so it does not need revisiting when a face is added;
 * the fully-inked clause beside it handles a face drawing outside the range.
 *
 * The flag means "this glyph joins, so give it the hard-edged path and let its
 * ink run into the extension" — nothing is scaled to a cell rect any more.
 *
 * @returns {Uint8Array} 256 entries, bit 0 = touches an X edge, bit 1 = a Y edge.
 */
export const STRETCH_X = 1;
export const STRETCH_Y = 2;

/**
 * CP437's line-graphics block, re-exported. It moved to fonts/charsets.js when
 * a second encoding arrived, because "which codepoints are line graphics" is a
 * property of the ENCODING — which is what the classifier's header always said
 * it was, back when CP437 was the only one and the constant could live here.
 */
export { GRAPHICS_FIRST, GRAPHICS_LAST } from './fonts/charsets.js';
export const isGraphicsCode = (c) => CP437.isGraphics(c);

export function classifyStretch(font) {
  // Which codepoints must meet their neighbours is the charset's answer, not
  // this file's. A font with no charset is CP437, so this resolves to exactly
  // the predicate above for everything that shipped before charsets existed.
  const isGraphics = charsetOf(font).isGraphics;
  const out = new Uint8Array(256);
  const W = font.cellW, H = font.cellH;
  for (let c = 0; c < 256; c++) {
    // Ink bounding box. A glyph with no ink at all (space, NUL) leaves these
    // crossed, which is the guard that stops a blank cell being treated as a
    // full-cell fill — it must never be stretched, it must draw nothing.
    let minCol = W, maxCol = -1, minRow = H, maxRow = -1;
    // A row that is solid across the cell, and a column that is solid down it.
    // `colAll` is the AND of every row's bits, so a bit still set at the end
    // marks a column inked in EVERY row — computed in the same pass.
    const msb = ((W + 7) >> 3) * 8 - 1;
    let solidRow = false;
    let colAll = -1;                                    // all ones
    for (let r = 0; r < H; r++) {
      const bits = glyphRowBits(font, c, r);
      colAll &= bits;
      if (!bits) continue;
      if (r < minRow) minRow = r;
      maxRow = r;
      let inRow = 0;
      for (let col = 0; col < W; col++) {
        if ((bits >> (msb - col)) & 1) {
          if (col < minCol) minCol = col;
          if (col > maxCol) maxCol = col;
          inRow++;
        }
      }
      if (inRow === W) solidRow = true;
    }
    if (maxCol < 0) { out[c] = 0; continue; }          // no ink
    let solidCol = false;
    for (let col = 0; col < W; col++) if ((colAll >> (msb - col)) & 1) solidCol = true;

    // Part 1: is this a glyph that has to meet its neighbours at all?
    if (!isGraphics(c) && !solidRow && !solidCol) { out[c] = 0; continue; }

    // Part 2: on which axes does it reach an edge, and so have to keep
    // reaching it once placed?
    let flags = 0;
    if (minCol === 0 || maxCol === W - 1) flags |= STRETCH_X;
    if (minRow === 0 || maxRow === H - 1) flags |= STRETCH_Y;
    out[c] = flags;
  }
  return out;
}

// ── Duplication masks ───────────────────────────────────────────────────────

/**
 * Build the fixed nearest-neighbour selection mask for one axis.
 *
 *     src[j] = floor(j * srcN / dstN)      j in [0, dstN)
 *
 * Evaluated ONCE at atlas-build time and applied identically to all 256 glyphs.
 * That is the entire mechanism — the value of doing it here rather than letting
 * the browser resample is only that the result is fixed.
 *
 * Guard: on a DOWNSCALE the formula can drop the final source index
 * entirely, which deletes a font's designed advance space and makes adjacent
 * glyphs touch. When the final source index is blank font-wide (so it IS
 * advance space rather than ink) and the mask failed to select it, force it.
 * The cost is one duplicated interior sample; the alternative is glyphs with no
 * separation at all.
 *
 * @param {number} srcN     source extent (cellW or cellH)
 * @param {number} dstN     destination extent (inkW or inkH)
 * @param {boolean} lastBlank  is source index srcN-1 blank across the font?
 * @returns {Int32Array} dstN source indices, monotonic non-decreasing
 */
export function buildMask(srcN, dstN, lastBlank) {
  const mask = new Int32Array(dstN);
  for (let j = 0; j < dstN; j++) mask[j] = Math.floor((j * srcN) / dstN);
  if (dstN < srcN && lastBlank && mask[dstN - 1] !== srcN - 1) {
    mask[dstN - 1] = srcN - 1;
  }
  return mask;
}

/**
 * The same mask with ONE extra entry that repeats the last — the edge
 * extension.
 *
 * WHAT THIS IS FOR. Cell rects are `inkW` or `inkW + 1` device pixels wide,
 * because the residue is spread across the row rather than banked. A
 * glyph atlas cell is `inkW`. Something has to cover the extra pixel in a wide
 * cell, and for a letterform the answer is "nothing, it is tracking" — but for
 * a box-drawing character it is a hole in a table border.
 *
 * The original answer was to SCALE the glyph to the cell rect on any axis the
 * classifier flagged. That covers the residue, but nearest-neighbour scaling
 * from `inkW` to `inkW + 1` duplicates an arbitrary INTERIOR column, so a `┼`
 * came out with its vertical bar a pixel away from the `│` above it. The cure
 * introduced a second, subtler version of the disease.
 *
 * Extending instead of scaling fixes both. The atlas cell is built one column
 * and one row larger, and that extra column is a copy of the glyph's own last
 * column. A wide cell blits `inkW + 1` source pixels; a narrow one blits
 * `inkW`. Either way the blit is 1:1 — nothing is ever resampled, no interior
 * column is ever duplicated, and a glyph whose ink reaches the edge keeps
 * reaching it. For a letterform the extension is a copy of the blank advance
 * column, which is exactly the tracking it replaced.
 */
export function extendMask(mask) {
  const out = new Int32Array(mask.length + 1);
  out.set(mask);
  out[mask.length] = mask[mask.length - 1];
  return out;
}

// ── Cell rectangles ─────────────────────────────────────────────────────────

/**
 * Edge table for one axis: `edges[i] = round(i * D / n)`, length n + 1.
 *
 * Contiguous by construction — edges[i+1] of cell i IS edges[i+1] of cell i+1 —
 * so backgrounds tile with no seam, and edges[n] is exactly D, so the full
 * viewport is used with no letterbox. The 0-or-1 px residue per cell appears as
 * tracking spread across the row by the rounding, never banked at one end.
 */
export function cellEdges(n, D) {
  const e = new Int32Array(n + 1);
  for (let i = 0; i <= n; i++) e[i] = Math.round((i * D) / n);
  return e;
}

// ── Aspect and layout ───────────────────────────────────────────────────────

/**
 * The device height of one source pixel over its device width.
 *
 *     pixelAspect = (C * W) / (R * H) / targetAspect
 *
 * Derived from the cell grid, so no font carries an aspect field and no table
 * of faces is needed. Two consequences the doc flags as easy to get wrong, both
 * of which fall out of this formula rather than needing a special case:
 *
 *   - The often-quoted 1.35 correction is right only for a NINE-wide cell
 *     (720x400 at 4:3). An 8-wide cell is 640x400 = 1.6 and wants 1.2.
 *   - A font already corrected in its bitmap gets the factor for its ACTUAL
 *     grid, which is near 1.0 — not a second full correction.
 */
export function pixelAspect(cellW, cellH, cols, rows, targetAspect) {
  return ((cols * cellW) / (rows * cellH)) / targetAspect;
}

/**
 * Resolve a complete hybrid layout for one font at one device size.
 *
 * Width drives: C columns must fit, height is negotiable. But a
 * width-driven pitch can demand more rows of pixels than a height-constrained
 * desktop layout has, so the available height clamps it and letterboxes instead
 * of overflowing vertically.
 *
 * @param {object}  font     registry entry (cellW, cellH, glyphs)
 * @param {number}  cols
 * @param {number}  rows
 * @param {number}  availW   available width  in DEVICE pixels
 * @param {number}  availH   available height in DEVICE pixels
 * @param {object} [opts]    { pixelAspect, lastColBlank, lastRowBlank }
 * @returns {object} layout
 */
export function layout(font, cols, rows, availW, availH, opts = {}) {
  const W = font.cellW, H = font.cellH;
  // Square, per the aspect policy at the top of this file: the font already
  // carries its intended aspect, so the renderer must not apply a second one.
  // Overridable only so the harness can prove the arithmetic generalizes.
  const pa = opts.pixelAspect != null ? opts.pixelAspect : PIXEL_ASPECT;

  // Device pixels are whole pixels. A caller computing `cssPx * dpr` at a
  // fractional dpr (2.625 is common on Android) hands us a fraction, and a
  // fractional budget lets the rounding in `Dw` below land one pixel OUTSIDE
  // the box we were offered — which the browser then resamples away, silently
  // discarding the entire benefit of the snap. Floor once, here.
  availW = Math.max(1, Math.floor(availW));
  availH = Math.max(1, Math.floor(availH));

  // Height of one cell per unit of cell width. At pa = 1 this is just the
  // font's own H/W, so the terminal presents at the font's declared aspect.
  const cellRatio = (H / W) * pa;

  // Width-driven, clamped by the height the layout actually has.
  const pitchX = Math.min(availW / cols, (availH / rows) / cellRatio);
  const pitchY = pitchX * cellRatio;

  // Floor IS the snap to the next-smallest 1/W ratio scale.
  const inkW = Math.max(1, Math.floor(pitchX));
  const inkH = Math.max(1, Math.floor(pitchY));

  // The device-pixel box the terminal actually occupies. Derived from the
  // snapped ink extent, not from the fractional pitch, so the residue stays the
  // 0-or-1 px of residue rather than accumulating into a visible band.
  const Dw = Math.round(cols * pitchX);
  const Dh = Math.round(rows * pitchY);

  const lastColBlank = opts.lastColBlank != null
    ? opts.lastColBlank : fontColumnBlank(font, W - 1);
  const lastRowBlank = opts.lastRowBlank != null
    ? opts.lastRowBlank : fontRowBlank(font, H - 1);

  const srcCol = buildMask(W, inkW, lastColBlank);
  const srcRow = buildMask(H, inkH, lastRowBlank);

  return {
    cols, rows,
    cellW: W, cellH: H,
    pixelAspect: pa,
    pitchX, pitchY,
    inkW, inkH,
    // The ATLAS cell, one larger on each axis than the ink extent. A cell rect
    // is inkW or inkW+1 wide (the residue), and the blit is 1:1, so the
    // atlas has to be able to supply that extra pixel. See extendMask().
    padW: inkW + 1,
    padH: inkH + 1,
    Dw, Dh,
    srcCol,
    srcRow,
    srcColPad: extendMask(srcCol),
    srcRowPad: extendMask(srcRow),
    xEdges: cellEdges(cols, Dw),
    yEdges: cellEdges(rows, Dh),
  };
}
