#!/usr/bin/env python3
"""
besciisubset.py — mint the shipped BESCII PETSCII source asset from upstream.

    pip install fonttools brotli
    python3 tools/besciisubset.py Bescii-Mono.ttf \
                                  tools/datasource/Bescii_PETSCII.ttf
    python3 tools/mkwoff2.py tools/datasource/Bescii_PETSCII.ttf \
                             public/fonts/Bescii_PETSCII.woff2

BY HAND, like every other script in this directory, and on no test path. It runs
once per upstream release.

Upstream is BESCII v2.0 (Bescii-Mono.ttf), CC0, an 8x8 pixel font based on
PETSCII. It is NOT a tracing of the Commodore 64 character ROM and does not
claim to be — see PETSCII.md, which is where that choice is argued rather than
assumed.

WHAT THIS DOES, and why each part is not optional:

  1. SUBSETS to the codepoints fonts/petscii.js actually draws. Upstream is 911
     cmap entries — Greek, Cyrillic, Hebrew, kana, pixel art — and the atlas has
     256 cells per set. The list is read out of petscii.js rather than typed, for
     the reason topazsubset.py gives: mkwoff2.py refuses to subset, so it belongs
     where the codepoints come from the table.

     Both tables are kept, and they overlap heavily — 0x41 is `A` in one set and
     `a` in the other, so the union is what has to survive.

  2. CORRECTS THE ASPECT TO 1.2, which is what a Commodore 64 displayed.

     Upstream is a faithful tracing of an 8x8 pixel grid on SQUARE units: upem
     1024, advance 1024, ascent 896 + descent 128 = 1024, so one source pixel is
     128 units on both axes and the cell presents at 1.000. That is a statement
     about the tracing, not about the machine. C64 text is 320x200 in a 4:3
     raster, which makes the pixel 1.2 times taller than wide — 320/(200/0.75) —
     and puts a 40x25 terminal at 320x240, which is 4:3 exactly. That is the same
     shape Topaz presents and within 1% of the AST 'Pixel' arm, which is the
     company it should keep. FONTS.md section 6 is unambiguous that the FILE
     carries the aspect and PIXEL_ASPECT stays 1.0 so nothing corrects twice.

     Note the Amiga took 2.4 by the same route (640x200 in the same raster) and
     the C64 takes exactly half of it, because it is half the horizontal
     resolution on the same display. Two derivations, one consistent story.

  3. GETS THERE IN TWO STEPS, and the order matters.

     A straight Y x 1.2 at upem 1024 does not land on whole coordinates: the
     source pixel is 128 units, and 128 x 1.2 = 153.6. FONTS.md 11.3 step 4 says
     to take the factor that keeps coordinates whole, so the file is first scaled
     UNIFORMLY by 1.25 — upem 1024 -> 1280, every coordinate and every hmtx value
     together — and only then stretched on Y by 1.2. The source pixel ends up 160
     units wide and 192 tall, both exact, and every coordinate in the file is a
     multiple of one or the other with nothing to round.

     The uniform step is why touching X here is safe, where topazsubset.py's
     docstring warns against it. FONTS.md 7.1's hazard is a NON-uniform X change
     that leaves hmtx's lsb disagreeing with glyf's xMin; a uniform scale moves
     both by the same factor, so they cannot desynchronise. The Y step that
     follows touches no X value at all. besciisubset asserts the invariant at the
     end rather than relying on the argument.

  4. RESTATES THE VERTICAL METRICS. ascent 1344 (7 source pixels), descent 192
     (1), summing to 1536 = 1280 x 1.2. The registry's cell-aspect invariant is
     cellW x (ascent + descent) == cellH x advance, so this is what makes a
     design grid of 20x24 legal: 20 x 1536 == 24 x 1280.

     WHY 20x24 rather than a smaller legal pair. The pairs are 5x6, 10x12, 15x18,
     20x24 and 25x30, all inside the cellW <= 32 limit. Two things pick 20x24:
     deriveOutlineBitmap() reproduces the face at 2.5 raster pixels per source
     pixel there, and — uniquely among the legal pairs — outlineMetrics()'s
     baseline lands on a whole number (20 x 1344/1280 = 21 exactly), so the
     rasterizer is not asked to place a pixel grid on a half-pixel origin.
     tools/petscii-derive.js is the measurement; PETSCII.md carries the table.

     A grid exact on BOTH axes would need cellW to be a multiple of 8 and of 5 at
     once, so 40x48, which exceeds the 32 limit for the reason FONTS.md 11.3
     step 5 gives. Topaz hit the same wall at 40x96. This is not a new problem.

SynthLink's own code, GPL-3.0-or-later. The font itself is not ours — see
PROVENANCE.md and public/about.html.
"""

import os
import re
import sys

from fontTools.ttLib import TTFont
from fontTools import subset

UPEM_IN, UPEM_OUT = 1024, 1280          # the uniform step: x 1.25
Y_STRETCH = 1.2                         # the aspect step, on Y alone
ASCENT, DESCENT = 1344, 192             # 7 and 1 source pixels of 192 units


def keep_codepoints(petscii_js):
    """The codepoints fonts/petscii.js draws, read out of the file itself.

    Both tables, unioned, minus the blanks — which are emitted as 0x0000 by
    mkpetscii.py and are exactly the positions the atlas builder never calls
    fillText for.
    """
    src = open(petscii_js).read()
    keep = set()
    for match in re.finditer(r'export const PETSCII_\w+_TO_UNICODE = new Uint16Array\(\[(.*?)\]\);',
                             src, re.S):
        keep.update(int(v, 16) for v in re.findall(r'0x([0-9A-Fa-f]{4})', match.group(1)))
    keep.discard(0)
    if len(keep) < 128:
        raise SystemExit(f'{petscii_js}: only {len(keep)} codepoints parsed — table not found?')
    return sorted(keep)


def main(argv):
    if len(argv) != 2:
        raise SystemExit('usage: besciisubset.py <upstream.ttf> <datasource.ttf>')
    src, dst = argv

    here = os.path.dirname(os.path.abspath(__file__))
    keep = keep_codepoints(os.path.join(here, '..', 'public', 'fonts', 'petscii.js'))

    font = TTFont(src, fontNumber=0)
    if font['head'].unitsPerEm != UPEM_IN:
        raise SystemExit(f'{src}: upem is {font["head"].unitsPerEm}, expected {UPEM_IN} — '
                         'upstream changed, and the scale factors below are derived from it')

    opts = subset.Options()
    opts.layout_features = []
    opts.name_IDs = list(range(15))          # keep the licence and credit strings
    opts.name_legacy = True
    opts.notdef_outline = False
    opts.recalc_bounds = True
    opts.glyph_names = True
    s = subset.Subsetter(options=opts)
    s.populate(unicodes=keep)
    s.subset(font)

    missing = [cp for cp in keep if cp not in font.getBestCmap()]
    if missing:
        raise SystemExit('codepoints petscii.js names are absent upstream: '
                         + ', '.join('U+%04X' % c for c in missing))

    # X x 1.25 (the uniform step) and Y x 1.25 x 1.2 (uniform, then aspect).
    # Written as one pass because the two are commutative and doing it twice
    # would round twice; the factors are named separately so the arithmetic can
    # be read against the docstring.
    sx = UPEM_OUT / UPEM_IN
    sy = sx * Y_STRETCH
    glyf = font['glyf']
    for name in font.getGlyphOrder():
        glyph = glyf[name]
        if glyph.isComposite():
            raise SystemExit(f'{name}: composite glyph — this script only scales simple '
                             'outlines, and a composite would need its offsets scaled too')
        if not glyph.numberOfContours:
            continue
        coords, _, _ = glyph.getCoordinates(glyf)
        for i, (x, y) in enumerate(coords):
            coords[i] = (int(round(x * sx)), int(round(y * sy)))
        glyph.coordinates = coords
        glyph.recalcBounds(glyf)
    font['head'].recalcBBoxes = True
    font['head'].unitsPerEm = UPEM_OUT

    # hmtx moves with the UNIFORM factor, which is what keeps lsb and xMin in
    # step (FONTS.md 7.1). The Y stretch above contributes nothing here — hmtx
    # holds advances and side bearings, both X-only.
    hmtx = font['hmtx']
    for name in font.getGlyphOrder():
        adv, lsb = hmtx[name]
        hmtx[name] = (int(round(adv * sx)), int(round(lsb * sx)))

    font['hhea'].ascent, font['hhea'].descent, font['hhea'].lineGap = ASCENT, -DESCENT, 0
    os2 = font['OS/2']
    os2.sTypoAscender, os2.sTypoDescender, os2.sTypoLineGap = ASCENT, -DESCENT, 0
    os2.usWinAscent, os2.usWinDescent = ASCENT, DESCENT

    # The invariant the registry entry will declare, asserted here rather than
    # trusted: 20 x (1344 + 192) == 24 x 1280.
    advance = hmtx.metrics['space'][0] if 'space' in hmtx.metrics \
        else hmtx[font.getGlyphOrder()[1]][0]
    if 20 * (ASCENT + DESCENT) != 24 * advance:
        raise SystemExit(f'cell-aspect invariant fails: advance is {advance}, '
                         f'20 x {ASCENT + DESCENT} != 24 x {advance}')

    # lsb must equal glyf's xMin for every glyph with contours — FONTS.md 7.1,
    # and the whole reason the X scale above is uniform.
    for name in font.getGlyphOrder():
        glyph = glyf[name]
        if glyph.numberOfContours:
            if hmtx[name][1] != glyph.xMin:
                raise SystemExit(f'{name}: lsb {hmtx[name][1]} != xMin {glyph.xMin}')

    font.save(dst)
    print(f'{dst}: {font["maxp"].numGlyphs} glyphs, '
          f'{len(font.getBestCmap())} cmap entries, upem {UPEM_OUT}, '
          f'advance {advance}, ascent {ASCENT}, descent {DESCENT}, '
          f'aspect {(ASCENT + DESCENT) / advance:.4f}')


if __name__ == '__main__':
    main(sys.argv[1:])
