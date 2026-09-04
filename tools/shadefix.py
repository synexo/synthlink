#!/usr/bin/env python3
"""
shadefix.py — re-pitch the three CP437 shade glyphs of a NINE-wide font so they
tile across the cell boundary.

    pip install fonttools brotli
    python3 tools/shadefix.py tools/datasource/Px437_IBM_VGA_9x14.ttf

Offline, run by hand, on no test path — the same standing as fontaspect.py and
mkwoff2.py beside it. It rewrites the source .ttf in place; regenerate the
shipped .woff2 with mkwoff2.py afterwards.

WHY THIS EXISTS
===============
0xB0 ░, 0xB1 ▒ and 0xB2 ▓ are the only glyphs in CP437 whose job is to be
INVISIBLE at the cell boundary: a run of them has to read as one continuous
texture, not as a row of characters. In a nine-dot VGA font they do not, and it
is not a rendering bug — it is in the glyph data, faithfully:

  IBM's 9-dot text mode duplicates column 8 into the ninth dot ONLY for
  characters 0xC0-0xDF. The box-drawing set lives in that range and so tiles;
  the shades at 0xB0-0xB2 do not, and were drawn with a blank ninth column.

On real hardware that produced a one-pixel black gutter between adjacent shade
cells, and every faithful nine-wide font — VileR's Flexi pair, the IBM VGA 9x14,
and the ROM bitmap in public/fonts/vga-9x14.js — reproduces it. An eight-wide
font (Px437 AST PremiumExec) has no ninth column and so has never had the
problem, which is why it took a font swap to notice.

WHY NOT SIMPLY FILL THE NINTH COLUMN
====================================
Because the ROM patterns have x-period 2 (▒) and 4 (░, ▓), and neither divides
9. Continue the pattern into column 8 and the gutter becomes a DOUBLED column
instead of a blank one — the seam changes colour, it does not go away. Measured
by rendering both: ▒ survives it (a checkerboard's dislocation is nearly
invisible) but ░ and ▓ come out with pronounced vertical banding.

The only periods that tile a 9-wide cell are 1, 3 and 9. Period 3 cannot make a
50% field — a row of 3 is 0, 1, 2 or 3 dots, so 50% needs alternating 1/3 and
2/3 rows, which is horizontal banding instead of vertical. That leaves period 9:
the CELL ITSELF is the tile, and the pattern is defined so that it repeats
exactly at the cell boundary in both axes.

THE PATTERNS
============
Each is a fixed number of dots per row of nine, spread as evenly as nine allows,
with the phase advancing 2 columns per row so the field reads as a lattice
rather than as stripes:

    ░ 0xB0    ink where (x + 2y) mod 9 in {3, 7}          2/9 = 22.2%
    ▒ 0xB1    ink where (x + y)  mod 2 == 1               1/2 = 50.0%
    ▓ 0xB2    ink EXCEPT where (x + 2y) mod 9 in {2, 6}   7/9 = 77.8%

Row 0 of each is byte-identical to the ROM glyph's row 0 (░ inks 3 and 7, ▒ inks
the odd columns, ▓ blanks 2 and 6); it is the per-row drift that is new, and it
is what breaks the 4-periodicity that banded. ▒ is left as the ROM checkerboard
and merely extended into column 8, because a checkerboard is already the best
50% field there is and its boundary dislocation measured invisible.

The densities move from the ROM's 25/50/75 to 22.2/50/77.8. That is the price of
nine columns; the ordering and the spacing between the three are preserved, and
▒ — the one used for fills and borders, and the one that showed the defect worst
— is exact.

WHY THE PHASE ADVANCES BY 2 AND NOT BY 1. A drift of 1 column per row is the
one that makes the per-column ink counts flattest — over 14 rows it holds every
column to 3 or 4 dots, where a drift of 2 lets them range 2 to 4 — and it is
still the wrong answer, because it puts every dot in the field on the same 45°
line. Rendered seven cells wide it reads as diagonal stripes, which is a worse
artefact than the imbalance it fixes; a drift of 2 renders as an even lattice.
So the choice was made on the render, not on the histogram. For scale: the ROM
glyph this replaces has column counts 0,7,0,7,0,7,0,7,0 — the imbalance being
traded away here is between 2 and 4, and no column is ever empty. That last
property is the one tools/tests/ttftest.js asserts, because an empty column IS the
gutter.

VERTICAL TILING. The phase is (x + 2y) mod 9 with y counted from the top of the
cell, so a cell of H rows hands the next one down a phase of 0 rather than 2H.
For H = 14 and H = 16 that discontinuity is a single column of drift, which is
smaller than the drift between two adjacent rows and does not read as a seam.
Both were rendered four cells deep before this was settled.

SynthLink's own code, GPL-3.0-or-later.
"""

import sys

from fontTools.ttLib import TTFont
from fontTools.pens.ttGlyphPen import TTGlyphPen

W = 9                                   # this tool is nine-wide-only, by design

LIGHT, MEDIUM, DARK = 0xB0, 0xB1, 0xB2

CP437 = bytes(range(256)).decode('cp437')


def ink(code, x, y):
    """Is cell (x, y) of glyph `code` inked? y counts DOWN from the cell top."""
    if code == LIGHT:
        return (x + 2 * y) % W in (3, 7)
    if code == MEDIUM:
        return (x + y) % 2 == 1
    if code == DARK:
        return (x + 2 * y) % W not in (2, 6)
    raise ValueError(f'{code:#04x} is not a shade glyph')


def runs(code, y):
    """Inked column runs [start, end) on row y — merged, so a solid row is one."""
    out = []
    x = 0
    while x < W:
        if not ink(code, x, y):
            x += 1
            continue
        start = x
        while x < W and ink(code, x, y):
            x += 1
        out.append((start, x))
    return out


def draw(code, rows, colw, rowh, ascent):
    """One closed rectangle contour per inked run, in font units."""
    pen = TTGlyphPen(None)
    for y in range(rows):
        top = ascent - y * rowh
        bot = top - rowh
        for x0, x1 in runs(code, y):
            pen.moveTo((x0 * colw, bot))
            pen.lineTo((x0 * colw, top))
            pen.lineTo((x1 * colw, top))
            pen.lineTo((x1 * colw, bot))
            pen.closePath()
    return pen.glyph()


def main(argv):
    if len(argv) != 1:
        raise SystemExit('usage: shadefix.py <source.ttf>')
    path, = argv
    font = TTFont(path)
    glyf, hmtx, cmap = font['glyf'], font['hmtx'], font.getBestCmap()
    hhea = font['hhea']
    ascent, descent = hhea.ascent, -hhea.descent

    names = {c: cmap[ord(CP437[c])] for c in (LIGHT, MEDIUM, DARK)}
    advance = hmtx[names[MEDIUM]][0]
    if advance % W:
        raise SystemExit(f'{path}: advance {advance} is not a whole nine columns')
    colw = advance // W

    # ROW height is NOT column width. Flexi True carries its 1.333 aspect
    # correction in the design grid itself — 75 units across a column against
    # 100 down a row — so the row pitch has to be measured rather than assumed.
    # 0xC4 is the horizontal rule: exactly one row tall, by construction.
    rule = glyf[cmap[ord(CP437[0xC4])]]
    rowh = rule.yMax - rule.yMin
    height = ascent + descent
    if rowh <= 0 or height % rowh:
        raise SystemExit(f'{path}: cell height {height} is not whole rows of {rowh}')
    rows = height // rowh

    print(f'{path}: {W}x{rows} cell, {colw}x{rowh} units/cell, advance {advance}')
    for code, name in names.items():
        glyph = draw(code, rows, colw, rowh, ascent)
        glyph.program = glyf[name].program if hasattr(glyf[name], 'program') else None
        if glyph.program is not None and glyph.program.getBytecode():
            raise SystemExit(f'{path}: {code:#04x} carries hinting this tool would drop')
        glyf[name] = glyph
        glyph.recalcBounds(glyf)
        # THE LEFT SIDE BEARING HAS TO MOVE WITH THE OUTLINE, and forgetting it
        # is silent. hmtx carries lsb separately from glyf's xMin; a rasterizer
        # is entitled to position the glyph by the lsb phantom point, so when
        # the two disagree it shifts the outline by the difference. Only ░ is
        # ever affected — it is the one shade whose ORIGINAL xMin was not 0 (its
        # lattice starts one column in), so it is the one that arrives carrying
        # a non-zero lsb, and re-pitching it to reach the left edge without
        # updating hmtx moved the whole glyph one design column right and pushed
        # its last column off the cell. ▒ and ▓ start at 0 either way and showed
        # nothing. Measured in a real browser through deriveOutlineBitmap();
        # tools/tests/ttftest.js now asserts lsb == xMin so it cannot come back.
        hmtx[name] = (advance, glyph.xMin)
        dots = sum(1 for y in range(rows) for x in range(W) if ink(code, x, y))
        print(f'  {code:#04x} {name:<12} {glyph.numberOfContours:>3} contours'
              f'  xMin {glyph.xMin:>4} xMax {glyph.xMax:>4} (advance {advance})'
              f'  {100.0 * dots / (W * rows):.1f}%')

    font.save(path)
    print(f'{path}: written')


if __name__ == '__main__':
    main(sys.argv[1:])
