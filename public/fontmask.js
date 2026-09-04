/*
 * fontmask.js — the sharpening-mask tuning table.
 *
 * THIS FILE IS MEANT TO BE EDITED BY HAND. It is served straight out of
 * public/, outside the esbuild bundle, so a change here needs no rebuild and no
 * server restart — edit, reload the browser, look at the terminal. That is the
 * whole reason it is a file of its own rather than a field in the font
 * registry.
 *
 * WHAT THE NUMBER MEANS
 *
 * One unsharp-mask strength per font id, applied to the ALPHA channel of that
 * font's prescaled atlas when it is built:
 *
 *     a' = clamp(a + strength * (a - blur(a)))
 *
 * 0 (or a font absent from the table) means the pass never runs at all — not
 * "runs as an identity". A font left at 0 produces a byte-identical atlas to
 * one built with no mask code present, which is what makes an A/B while tuning
 * exact rather than approximate.
 *
 * Useful range is roughly 0.2 - 0.8. Below ~0.15 the effect is hard to see at
 * all; above ~1.0 the negative lobe starts eating the antialias skirt that
 * makes an outline font worth shipping, and letterforms read as ragged rather
 * than crisp. Start at 0.4 and move in steps of 0.1.
 *
 * WHERE IT DOES NOTHING, BY DESIGN
 *
 *   - BITMAP FONTS. Their atlases are pure 0-or-255; there is no antialias
 *     skirt to sharpen, and a uniform region is a fixed point of the transform.
 *     `vga8x16`, `vga9x14` and `vga9x14hr` will accept an entry here and
 *     correctly ignore it. Only `kind: 'ttf'` entries have anything to gain.
 *   - THE GRAPHICS GLYPHS of an outline font. The cells drawn from the
 *     thresholded bitmap (the shades and box-drawing characters) are skipped
 *     outright, because ringing on a hard edge is exactly what stops a run of
 *     them tiling. See pass 4 in fonts/index.js.
 *
 * The ids are the registry's own, from public/fonts/index.js.
 */

/**
 * font id -> unsharp strength. Everything ships at 0: the mask is inert until
 * somebody dials it in deliberately.
 */
export const MASK = {
  // ── Outline fonts: the ones this actually affects ──────────────────────
  astpx8x19: 0,        // "Pixel"  — AST PremiumExec. Already carries inkGamma 2.2.
  flexi160:  0,        // "Modern" — Flexi False 1.60, the desktop face.
  flexi135:  0,        // "Modern" — Flexi True, the mobile face.
  vga9x14px: 0,        // "Squat"  — IBM VGA 9x14 outline, i.e. 40-column mode.

  // ── Bitmap fonts: listed so the table is the full catalogue, but see above.
  vga8x16:   0,
  vga9x14:   0,
  vga9x14hr: 0,
};

/**
 * Strength for one font id, as a number that is safe to hand to the builder.
 *
 * Deliberately total and deliberately silent: an id with no entry, a typo'd
 * key, a string, a negative number or a NaN all resolve to 0. This file is
 * hand-edited during tuning, and the failure mode of a stray character in it
 * should be "the mask is off", visibly, and never a font that fails to build.
 *
 * @param {string} fontId  a FONTS entry's `id`
 * @returns {number} strength >= 0; 0 means "skip the pass entirely"
 */
export function maskFor(fontId) {
  const v = MASK[fontId];
  return (typeof v === 'number' && Number.isFinite(v) && v > 0) ? v : 0;
}
