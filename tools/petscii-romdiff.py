#!/usr/bin/env python3
"""
petscii-romdiff.py — how far is the shipped face from a real Commodore 64?

    pip install fonttools freetype-py
    git clone --depth 1 https://github.com/mist64/c64ref
    python3 tools/petscii-romdiff.py c64ref/src/charset/bin Bescii-Mono.ttf

BY HAND, like every other script in this directory, and on no test path.

WHY IT EXISTS

FONTS.md 11.3 step 3 pins a board font's FACE by diffing it glyph-by-glyph
against a known-good bitmap — that is how Topaz was pinned to 2+ rather than 2,
and the rule is "do not take the filename's word". BESCII cannot be pinned that
way, because it is not a tracing of the C64 character ROM and does not claim to
be: its author redrew parts of it for legibility. That is a deliberate choice,
and a deliberate choice still has a size. This measures it.

WHAT IT COMPARES

The Ultimate Commodore 64 Reference (mist64/c64ref) carries the character ROMs
as raw 8x8 bitmaps, one byte per row, MSB leftmost — c64_us_upper.bin for the
unshifted (upper/graphics) set and c64_us_lower.bin for the shifted
(lower/upper) one, 128 glyphs each. Each canonical PETSCII code is converted to
its screen code, that glyph is read out of the ROM, and it is compared with
BESCII's glyph for the codepoint fonts/petscii.js names.

The ROM files are inputs, not something this repo redistributes.

THE CANONICAL SET, which is smaller than 256

Per sta.c64.org's PETSCII table, 0x60-0x7F and 0xE0-0xFE are not distinct
characters at all: they are copies of 0xC0-0xDF and 0xA0-0xBE, and 0xFF is a
copy of 0xDE. So the codes worth measuring are 0x20-0x5F, 0xA0-0xBF and
0xC0-0xDF — 128 of them — and counting the copies would inflate the agreement by
padding it with positions that are the same glyph by definition. The aliasing
itself is asserted in tools/tests/petsciitest.js rather than here.

SynthLink's own code, GPL-3.0-or-later.
"""

import os
import re
import sys

import freetype
from fontTools.ttLib import TTFont

CANONICAL = list(range(0x20, 0x60)) + list(range(0xA0, 0xE0))


def screen_code(p):
    """PETSCII code -> C64 screen code. The standard four-range fold."""
    if 0x20 <= p <= 0x3F: return p
    if 0x40 <= p <= 0x5F: return p - 0x40
    if 0x60 <= p <= 0x7F: return p - 0x20
    if 0xA0 <= p <= 0xBF: return p - 0x40
    if 0xC0 <= p <= 0xDF: return p - 0x80
    if 0xE0 <= p <= 0xFE: return p - 0x80
    if p == 0xFF: return 0x5E
    return None


def rom_glyphs(path):
    data = open(path, 'rb').read()
    return [tuple(tuple((data[g * 8 + r] >> (7 - c)) & 1 for c in range(8))
                  for r in range(8))
            for g in range(len(data) // 8)]


def font_glyphs(path, ascent_px=7):
    """Every glyph as an 8x8 grid. Upstream BESCII is 8x8 on square units, so
    rasterizing the em at 8 pixels is a readback rather than a resampling — do
    NOT point this at the shipped tools/datasource asset, whose Y is stretched
    1.2 for the display aspect and which would compare as 8x9.6 squashed to 8x8.
    """
    face = freetype.Face(path)
    face.set_pixel_sizes(0, 8)
    out = {}
    for cp in TTFont(path).getBestCmap():
        gi = face.get_char_index(cp)
        if gi == 0:
            continue
        face.load_glyph(gi, freetype.FT_LOAD_RENDER | freetype.FT_LOAD_TARGET_MONO
                        | freetype.FT_LOAD_MONOCHROME)
        bm = face.glyph.bitmap
        left, top = face.glyph.bitmap_left, face.glyph.bitmap_top
        grid = [[0] * 8 for _ in range(8)]
        for r in range(bm.rows):
            for c in range(bm.width):
                if bm.buffer[r * bm.pitch + (c >> 3)] & (0x80 >> (c & 7)):
                    y, x = ascent_px - top + r, left + c
                    if 0 <= x < 8 and 0 <= y < 8:
                        grid[y][x] = 1
        out[cp] = tuple(tuple(row) for row in grid)
    return out


def table(src, name):
    m = re.search(r'export const %s = new Uint16Array\(\[(.*?)\]\);' % name, src, re.S)
    if not m:
        raise SystemExit(f'{name} not found in petscii.js')
    return [int(v, 16) for v in re.findall(r'0x([0-9A-Fa-f]{4})', m.group(1))]


def main(argv):
    if len(argv) != 2:
        raise SystemExit('usage: petscii-romdiff.py <c64ref/src/charset/bin> <upstream.ttf>')
    bindir, ttf = argv
    js = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                      '..', 'public', 'fonts', 'petscii.js')
    src = open(js).read()
    glyphs = font_glyphs(ttf)

    for rom_name, label, tbl in (
            ('c64_us_upper.bin', 'unshifted', table(src, 'PETSCII_UC_TO_UNICODE')),
            ('c64_us_lower.bin', 'shifted', table(src, 'PETSCII_LC_TO_UNICODE'))):
        rom = rom_glyphs(os.path.join(bindir, rom_name))
        same = 0
        rows = []
        pixels = 0
        for p in CANONICAL:
            cp = tbl[p]
            if not cp or cp not in glyphs:
                continue
            a, b = rom[screen_code(p)], glyphs[cp]
            n = sum(1 for r in range(8) for c in range(8) if a[r][c] != b[r][c])
            pixels += n
            if n:
                rows.append((n, p, cp))
            else:
                same += 1
        total = same + len(rows)
        rows.sort(reverse=True)
        print(f'{label}: {same}/{total} glyphs pixel-identical to the ROM '
              f'({100 * same / total:.1f}%), {len(rows)} differ, '
              f'{100 * pixels / (total * 64):.2f}% of pixels differ')
        print('  worst: ' + ', '.join(f'0x{p:02X} (U+{cp:04X}) {n}px'
                                      for n, p, cp in rows[:10]))


if __name__ == '__main__':
    main(sys.argv[1:])
