/*
 * fonts/index.js — font registry + glyph-sheet builder.
 *
 * Every font here is a CP437 (Code Page 437) ROM bitmap: 256 glyphs, fixed
 * pitch, stored one byte per pixel row with the MSB as the leftmost pixel.
 * Fonts differ only in CELL_H, so a single sheet builder serves them all.
 *
 * Adding a font:
 *   1. Drop a module beside this one exporting CELL_W, CELL_H and a
 *      Uint8Array of 256 * CELL_H bytes (see ast-premiumexec-8x19.js).
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

/**
 * The cycle order of the Aa button. `mobileDefault` marks the font chosen
 * automatically on narrow screens.
 *
 * Why two: at 80x25 the terminal is 640 px wide whatever the font, so mobile
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
];

export const DEFAULT_FONT_ID = 'vga8x16';

export function fontById(id) {
  return FONTS.find((f) => f.id === id) || FONTS[0];
}

export function fontIndexById(id) {
  const i = FONTS.findIndex((f) => f.id === id);
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
  const totalW = 256 * cellW;
  const canvas = new OffscreenCanvas(totalW, cellH);
  const ctx = canvas.getContext('2d');

  ctx.clearRect(0, 0, totalW, cellH);

  const imgData = ctx.createImageData(totalW, cellH);
  const pixels = imgData.data; // RGBA Uint8ClampedArray

  for (let glyph = 0; glyph < 256; glyph++) {
    const glyphBase = glyph * cellH;   // offset into the glyph array
    const xBase = glyph * cellW;       // pixel x of this glyph's left edge

    for (let row = 0; row < cellH; row++) {
      const rowByte = glyphs[glyphBase + row];
      if (!rowByte) continue;          // blank row — leave it transparent
      for (let col = 0; col < cellW; col++) {
        // MSB = leftmost pixel
        if ((rowByte >> (7 - col)) & 1) {
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
