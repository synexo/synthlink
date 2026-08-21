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
 *      (see ast-premiumexec-8x19.js for the 8-wide case, vga-9x14.js for 9).
 *   2. Add one FONTS entry below.
 * Nothing else in the render stack needs touching — Renderer reads its cell
 * metrics from the active font, and main.js drives the cycle off this table.
 *
 * Licence note: the font DATA modules are third-party assets under their own
 * licences (ast-premiumexec-8x19.js is CC BY-SA 4.0, and says so in its own
 * header). This registry is SynthLink's own code, LGPL-3.0 like the rest.
 * See PROVENANCE.md.
 */

import { VGA_FONT_8x16 } from './vga-8x16.js';
import { AST_PREMIUMEXEC_8x19 } from './ast-premiumexec-8x19.js';
import { DOSV_PRC19_8x19 } from './dosv-prc19-8x19.js';
import { VGA_FONT_9x14 } from './vga-9x14.js';

/**
 * The cycle order of the Aa button. `mobileDefault` marks the font chosen
 * automatically on narrow screens.
 *
 * Why the 8x19 pair: at 80x25 the terminal is 640 px wide whatever the font, so mobile
 * portrait is width-constrained with vertical room to spare — a taller cell
 * spends that spare height on real letterform (cap height +20%, x-height +14%)
 * rather than on interpolation. Desktop is usually height-constrained, where
 * the same trade makes the terminal ~16% NARROWER, so 8x16 stays the default
 * there. Cells stay square in both cases: main.js derives the canvas aspect
 * from the active font.
 */
export const FONTS = [
  {
    id: 'vga8x16',
    name: 'IBM VGA 8×16',
    cellW: 8,
    cellH: 16,
    glyphs: VGA_FONT_8x16,
  },
  {
    id: 'ast8x19',
    name: 'AST PremiumExec 8×19',
    cellW: 8,
    cellH: 19,
    glyphs: AST_PREMIUMEXEC_8x19,
    mobileDefault: true,
  },
  {
    // Largest lowercase of the 8x19 candidates (x-height 9 vs AST's 8), but a
    // much lighter stroke and a diagonal 0xB2 shade — see its file header.
    //
    // `hidden` keeps it out of the Aa cycle (and so out of the UI entirely)
    // while leaving the font and its data module fully wired: drop the flag and
    // it's back. Nothing else needs changing — the cycle is driven by
    // CYCLE_FONTS below, everything else still resolves it by id.
    id: 'prc8x19',
    name: 'DOS/V re PRC19 8×19',
    cellW: 8,
    cellH: 19,
    glyphs: DOSV_PRC19_8x19,
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
    // Never a default, on any screen: no `mobileDefault`, and DEFAULT_FONT_ID
    // points elsewhere. It is reachable only by cycling the Aa button.
    id: 'vga9x14',
    // No '40 col' in the name: every place the name is shown now states the
    // column count beside it, and saying it twice reads like a stutter.
    name: 'IBM VGA 9×14',
    cellW: 9,
    cellH: 14,
    cols: 40,
    glyphs: VGA_FONT_9x14,
  },
];

/** Columns this font implies. Only the 40-column font overrides it. */
export const fontCols = (font) => font.cols || 80;

/** Bytes per pixel row in a font's glyph array — 1 for 8-wide, 2 for 9-wide. */
export const fontStride = (font) => (font.cellW + 7) >> 3;

/**
 * The fonts the Aa button actually cycles through — FONTS minus anything
 * flagged `hidden`. Hidden fonts stay loadable by id (so a saved preference or
 * an explicit call still works); they're just not reachable from the UI.
 */
export const CYCLE_FONTS = FONTS.filter((f) => !f.hidden);

export const DEFAULT_FONT_ID = 'vga8x16';

export function fontById(id) {
  return FONTS.find((f) => f.id === id) || FONTS[0];
}

export function fontIndexById(id) {
  const i = FONTS.findIndex((f) => f.id === id);
  return i < 0 ? 0 : i;
}

/** Position of `id` within the visible cycle (0 if it isn't in it). */
export function cycleIndexById(id) {
  const i = CYCLE_FONTS.findIndex((f) => f.id === id);
  return i < 0 ? 0 : i;
}

/** The font auto-selected on narrow screens, falling back to the default. */
export function mobileDefaultFont() {
  return FONTS.find((f) => f.mobileDefault) || fontById(DEFAULT_FONT_ID);
}

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
