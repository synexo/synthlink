#!/usr/bin/env python3
"""
topazsubset.py — mint the shipped Amiga Topaz source asset from the upstream file.

    pip install fonttools brotli
    python3 tools/topazsubset.py AmigaTopazUnicodeNerdFont.ttf \
                                 tools/datasource/Topaz_a1200_Latin1.ttf
    python3 tools/mkwoff2.py tools/datasource/Topaz_a1200_Latin1.ttf \
                             public/fonts/Topaz_a1200_Latin1.woff2

BY HAND, like every other script in this directory, and on no test path. It runs
once per upstream release, which so far is once.

WHAT IT DOES, and why each part is not optional:

  1. SUBSETS to the codepoints fonts/latin1.js actually draws. The upstream file
     is a Nerd Font — 9645 glyphs, 1.8 MB — and the atlas has 256 cells, so
     everything past those is unreachable weight. mkwoff2.py refuses to subset,
     for the good reason in its docstring, so it happens here where the codepoint
     list is derived from the table rather than typed.

  2. STRETCHES Y BY 1.2, to the aspect an Amiga actually displayed.

     The upstream file is a faithful tracing of an 8x16 pixel grid on SQUARE
     units, so its cell is 2:1 and an 80x25 terminal built from it lands at
     1.600 — the widescreen shape flexi160 was cut for, and 20% wider than the
     machine this font came off. Amiga text is 640x200 (or 640x400 laced) on a
     4:3 display, which makes the pixel 2.4 times taller than it is wide, by
     both routes: 640/(200/0.75) and 640/(400/0.75) x 2. SAUCE says the same
     thing — 640x200, 4:3, for every Amiga font. Measured off a SyncTERM
     screenshot of the target board it comes out at ~2.44, against the 2.0 the
     unscaled file would give.

     So: advance stays 800, ascent becomes 1600 x 1.2 = 1920, and the glyphs are
     stretched to match. 80x25 then lands at 1.3333 — within 1% of the AST
     'Pixel' arm (1.3474), which is the company it should keep rather than
     flexi160's.

     1.2 is the clean factor. Every Y coordinate in the file is a multiple of
     100, so all of them land on multiples of 120 with nothing to round; two
     points on `acute` are the only exceptions, off by 0.6 of 1920. Matching
     Pixel's 2.375 EXACTLY would need 1.1875, which puts every Y coordinate on
     118.75-unit steps and rounds the pixel tracing this font exists to be.

     X IS UNTOUCHED ON PURPOSE. hmtx carries advances and left side bearings,
     which are X-only, so a pure Y-scale cannot desynchronise lsb from glyf's
     xMin — the mismatch that silently shifts a glyph in its cell and that
     ttftest section 10 exists to catch. Doing this on the other axis, the way
     fontaspect.py narrows Flexi, would have to move both.

     The registry cell is 15x36, not 8x16: 15 x 1920 == 36 x 800. It is the
     smallest of the legal pairs (5x12, 10x24, 15x36, 20x48) that reproduces the
     face through deriveOutlineBitmap — 10x24 misreads 6.8% of the source
     pixels because a one-column stem falls to 1.25 raster pixels and thresholds
     away, while 15x36 puts it at 1.875, the same figure flexi135's entry
     settles on, and misreads 0.26%.

     The ascent also absorbs the 1602 the upstream file declares. Those two
     stray units are a Nerd-icon overhang; every Latin-1 and ASCII glyph lives
     inside [0, 1600], so nothing that survives the subset is clipped.

  3. POINTS U+2010 AT THE SOFT-HYPHEN GLYPH. Byte 0xAD is U+00AD, which every
     text shaper draws as nothing — the glyph is in the file and fillText still
     yields an empty cell. fonts/latin1.js maps that byte to U+2010 HYPHEN
     instead, and this is the cmap entry that makes it resolve. Drop this and
     0xAD goes blank on every Amiga board, looking like a missing glyph.

SynthLink's own code, GPL-3.0-or-later. The font itself is not ours — see PROVENANCE.md
and public/about.html.
"""

import sys

from fontTools.ttLib import TTFont
from fontTools import subset

# The codepoints fonts/latin1.js draws: everything but the C0 range, DEL, the C1
# range and NBSP, which the atlas builder blanks and never calls fillText for.
KEEP = list(range(0x20, 0x7F)) + list(range(0xA1, 0x100))


def main(argv):
    if len(argv) != 2:
        raise SystemExit('usage: topazsubset.py <upstream.ttf> <datasource.ttf>')
    src, dst = argv

    font = TTFont(src, fontNumber=0)

    opts = subset.Options()
    opts.layout_features = []
    opts.name_IDs = list(range(15))          # keep the licence and credit strings
    opts.name_legacy = True
    opts.notdef_outline = False
    opts.recalc_bounds = True
    opts.glyph_names = True
    s = subset.Subsetter(options=opts)
    s.populate(unicodes=KEEP)
    s.subset(font)

    # Y x 1.2. recalcBounds per glyph and recalcBBoxes on head keep the stated
    # extents honest; nothing here touches an X coordinate or hmtx.
    glyf = font['glyf']
    for name in font.getGlyphOrder():
        glyph = glyf[name]
        if not glyph.numberOfContours:
            continue
        coords, _, _ = glyph.getCoordinates(glyf)
        for i, (x, y) in enumerate(coords):
            coords[i] = (x, int(round(y * 1.2)))
        glyph.coordinates = coords
        glyph.recalcBounds(glyf)
    font['head'].recalcBBoxes = True

    font['hhea'].ascent = 1920
    font['hhea'].descent = 0
    font['hhea'].lineGap = 0
    os2 = font['OS/2']
    os2.sTypoAscender, os2.sTypoDescender, os2.sTypoLineGap = 1920, 0, 0
    os2.usWinAscent, os2.usWinDescent = 1920, 0

    soft = font.getBestCmap().get(0x00AD)
    if soft is None:
        raise SystemExit('no glyph at U+00AD — the 0xAD remap cannot be built')
    for table in font['cmap'].tables:
        if table.isUnicode() and 0x00AD in table.cmap:
            table.cmap[0x2010] = soft

    font.save(dst)
    print(f'{dst}: {font["maxp"].numGlyphs} glyphs, '
          f'{len(font.getBestCmap())} cmap entries')


if __name__ == '__main__':
    main(sys.argv[1:])
