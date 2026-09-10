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

IT ALSO ACCEPTS ITS OWN PRIOR OUTPUT, and that is not a convenience. The 1.2
asset (upem 1280) was minted before the aspect moved to NTSC and is the only
BESCII in this repo; upstream is not vendored. Re-minting from it is exact
rather than approximate — see SOURCES below — so the shipped file is
reproducible from something checked in, which is the property that matters.

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

  2. CORRECTS THE ASPECT TO 4/3, which is the pixel an NTSC Commodore 64 drew.

     Upstream is a faithful tracing of an 8x8 pixel grid on SQUARE units: upem
     1024, advance 1024, ascent 896 + descent 128 = 1024, so one source pixel is
     128 units on both axes and the cell presents at 1.000. That is a statement
     about the tracing, not about the machine. The machine's pixel is 0.75 as
     wide as it is tall, so the cell is 4/3 — SyncTERM measures the same face at
     1.330, which is the same number carrying NTSC's 0.752 rather than the
     nominal 0.75. FONTS.md section 6 is unambiguous that the FILE carries the
     aspect and PIXEL_ASPECT stays 1.0 so nothing corrects twice.

     THIS IS A CHOICE OF MACHINE, NOT A DERIVATION, and it replaced a different
     one. The 1.2 this shipped with came from assuming the 320x200 active area
     exactly FILLS a 4:3 display; that is where Topaz's 2.4 comes from too, and
     under it the C64 was exactly half the Amiga because it is half the
     horizontal resolution on the same display. NTSC breaks that symmetry: the
     same route would put the Amiga at 8/3, not 2.4, so PETSCII and Topaz no
     longer derive their aspects the same way. PAL is a third answer again
     (~0.9365). There is no correct value here, only which machine — and for a
     C64 board it is the C64's own pixel. Topaz is untouched and keeps its own.

     What moves with it: a 40x25 terminal was 800x600 (4:3, the same box Topaz
     gives) and is now 960x800, which is 1.2 — still shorter than the 1.029 the
     existing 40-column mode accepts, by less than it was.

  3. GETS THERE IN TWO STEPS, and the order matters.

     A straight Y x 4/3 at upem 1024 does not land on whole coordinates: the
     source pixel is 128 units, and 128 x 4/3 = 170.67. FONTS.md 11.3 step 4 says
     to take the factor that keeps coordinates whole, so the file is first scaled
     UNIFORMLY by 1.5 — upem 1024 -> 1536, every coordinate and every hmtx value
     together — and only then stretched on Y by 4/3. The source pixel ends up 192
     units wide and 256 tall, both exact, and every coordinate in the file is a
     multiple of one or the other with nothing to round.

     The uniform step is why touching X here is safe, where topazsubset.py's
     docstring warns against it. FONTS.md 7.1's hazard is a NON-uniform X change
     that leaves hmtx's lsb disagreeing with glyf's xMin; a uniform scale moves
     both by the same factor, so they cannot desynchronise. The Y step that
     follows touches no X value at all. besciisubset asserts the invariant at the
     end rather than relying on the argument.

     RE-MINTING FROM THE 1.2 ASSET is the same arithmetic reached from further
     along: that file already carries the uniform 1.25 and a Y x 1.2, so its
     source pixel is 160 x 192 and what remains is X x 1.2 and Y x 4/3. The X
     factor is not uniform with the Y one there, so the lsb/xMin hazard is real
     — and it does not fire, because every coordinate and every hmtx value in
     that file is a whole multiple of 160, so x 1.2 rounds nothing and moves lsb
     and xMin by the same exact amount. The assertion at the end is what says so
     rather than this paragraph.

  4. RESTATES THE VERTICAL METRICS. ascent 1792 (7 source pixels), descent 256
     (1), summing to 2048 = 1536 x 4/3. The registry's cell-aspect invariant is
     cellW x (ascent + descent) == cellH x advance, so this is what makes a
     design grid of 24x32 legal: 24 x 2048 == 32 x 1536.

     WHY 24x32. At 4/3 the grid can be EXACT ON BOTH AXES — 24/8 is 3 device
     pixels per source pixel across and 32/8 is 4 down — which no legal pair at
     1.2 could be, because cellW would have had to be a multiple of 8 and of 5 at
     once (40x48, past the cellW <= 32 limit; Topaz hit the same wall at 40x96).
     outlineMetrics()'s baseline also lands whole (24 x 1792/1536 = 28 exactly),
     so the rasterizer is not asked to place a pixel grid on a half-pixel origin.
     The smaller legal pairs are 3x4, 6x8, 9x12, 12x16, 15x20, 18x24 and 21x28,
     and only 24x32 is exact on both axes under the limit.
     tools/petscii-derive.js is the measurement and is what has to agree.

SynthLink's own code, GPL-3.0-or-later. The font itself is not ours — see
PROVENANCE.md and public/about.html.
"""

import os
import re
import sys

from fontTools.ttLib import TTFont
from fontTools import subset

UPEM_OUT = 1536                         # 8 source pixels of 192 units across
PIX_X, PIX_Y = 192, 256                 # one source pixel out, x and y: 4/3
ASCENT, DESCENT = 1792, 256             # 7 and 1 source pixels of 256 units
GRID_W, GRID_H = 24, 32                 # the design grid this file is minted for

# The source pixel, x and y, of each input this accepts, keyed by its upem. Both
# are exact lattices, so the two factors below round nothing whichever is used.
#
#   1024  upstream Bescii-Mono: an 8x8 tracing on square units
#   1280  this script's own 1.2 output, which carried a uniform 1.25 and a Y 1.2
SOURCES = {1024: (128, 128), 1280: (160, 192)}


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
    upem_in = font['head'].unitsPerEm
    if upem_in not in SOURCES:
        raise SystemExit(f'{src}: upem is {upem_in}, expected one of '
                         f'{sorted(SOURCES)} — upstream changed, and the scale '
                         'factors below are derived from the source pixel')
    pix_x_in, pix_y_in = SOURCES[upem_in]

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

    # Each axis is scaled so the SOURCE PIXEL lands on its target size, which is
    # the one statement that holds for both accepted inputs — the uniform step
    # and the Y stretch of the docstring are these two factors from upem 1024.
    # One pass rather than two: doing it in stages would round twice.
    sx = PIX_X / pix_x_in
    sy = PIX_Y / pix_y_in
    if int(round(upem_in * sx)) != UPEM_OUT:
        raise SystemExit(f'{src}: upem {upem_in} x {sx} is not {UPEM_OUT} — the '
                         'source pixel and the upem disagree about this file')
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
            nx, ny = x * sx, y * sy
            # Nothing here may round. A pixel font's coordinates are whole
            # multiples of the source pixel, so both products are exact — and if
            # one is not, this is not the lattice the factors were derived from
            # and the outline is being resampled rather than scaled.
            if nx != int(nx) or ny != int(ny):
                raise SystemExit(f'{name}: ({x}, {y}) x ({sx}, {sy}) is not whole — '
                                 'this file is not on the source-pixel lattice')
            coords[i] = (int(nx), int(ny))
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
    # trusted: 24 x (1792 + 256) == 32 x 1536.
    advance = hmtx.metrics['space'][0] if 'space' in hmtx.metrics \
        else hmtx[font.getGlyphOrder()[1]][0]
    if GRID_W * (ASCENT + DESCENT) != GRID_H * advance:
        raise SystemExit(f'cell-aspect invariant fails: advance is {advance}, '
                         f'{GRID_W} x {ASCENT + DESCENT} != {GRID_H} x {advance}')

    # And the baseline, which is why 24x32 was picked over the smaller pairs.
    if (GRID_W * ASCENT) % advance:
        raise SystemExit(f'baseline is not whole: {GRID_W} x {ASCENT} / {advance} '
                         f'= {GRID_W * ASCENT / advance}')

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
