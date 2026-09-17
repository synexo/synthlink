#!/usr/bin/env python3
"""
atasciisubset.py — mint the shipped ATASCII source asset from upstream.

    pip install fonttools brotli skia-pathops
    python3 tools/atasciisubset.py tools/datasource/atascii.ttf \
                                   tools/datasource/Atari_ATASCII.ttf \
                                   [--check path/to/syncterm/src/conio/allfonts.c]
    python3 tools/mkwoff2.py tools/datasource/Atari_ATASCII.ttf \
                             public/fonts/Atari_ATASCII.woff2

BY HAND, like every other script in this directory, and on no test path.
skia-pathops is needed here and nowhere else.

UPSTREAM is `atascii.ttf` v1.100 from github.com/damianvila/font-atascii, CC0
1.0, vendored beside this script as tools/datasource/atascii.ttf. That
repository is archived and says it moved elsewhere; the moved copy is a
different version under a different licence and was deliberately NOT used.
Upstream is an 8x8 pixel tracing on square units: upem 800, advance 800,
ascent 700 + descent 100, so one source pixel is 100 units on both axes.

WHAT THIS DOES:

  1. SUBSETS to the codepoints fonts/atascii.js draws for bytes 0-127, read out
     of that file rather than typed. Upstream has 385 cmap entries (Mac Roman,
     Windows-1252, Greek, Hebrew, Atari ST symbols); the atlas needs 128.

  2. ALIASES four codepoints. CTerm's table names U+1FB87, U+1FB82, U+2582 and
     U+258E for bytes 2, 13, 14 and 22; upstream draws those four shapes under
     U+2595, U+2594, U+2581 and U+258F. The glyphs are pixel-identical to
     SyncTERM's cells, so the cmap gains the table's codepoints pointing at them.

  3. REDRAWS BYTE 0x14. Upstream's U+2022 is a 2x4-pixel bullet; the Atari's
     cell 0x14 is a filled disc 6 pixels across. It is the ONLY one of the 128
     that upstream does not have somewhere, so it is drawn here from DISC below.

  4. MINTS THE INVERSE HALF. Bytes 0x80-0xFF draw U+E000 + byte, and each is the
     cell rectangle less its low-half twin's pixels — SyncTERM's own font holds
     exactly that. Built from the twin's BITMAP (sampled at pixel centres), so
     the result is on the pixel lattice by construction.

  5. SCALES X by 3 and Y by 4, so the source pixel is 300 x 400 at upem 2400:
     the SAME cell aspect as petscii40 (4/3), which is the owner's choice — an
     Atari board and a C64 board present in the same 960x800 box at 40x25.
     SyncTERM's own ATARI_40X24 is 4:3 on 320x192, a 1.25 pixel; 4/3 is taken
     instead so the two 8-bit modes look alike. Grid 24x32 is then exact on
     both axes (3 and 4 device pixels per source pixel) and the baseline lands
     whole: 24 x 2800 / 2400 = 28.

  6. VERIFIES. Every one of the 256 glyphs is rasterized at pixel centres and
     checked: the low half against upstream's own bitmap (and DISC for 0x14),
     the high half against the inversion of the low half. With --check, the
     whole set is also compared to SyncTERM's `Atari` 8x8 font in allfonts.c,
     which at the time of writing matches 256 of 256. SyncTERM's bitmaps are not
     vendored; the comparison is a by-hand cross-check, like cbmcodecs2 was.

SynthLink's own code, GPL-3.0-or-later. The font itself is not ours — CC0, see
PROVENANCE.md.
"""

import os
import re
import sys
import codecs

from fontTools.ttLib import TTFont
from fontTools import subset
from fontTools.pens.pointInsidePen import PointInsidePen
from fontTools.pens.ttGlyphPen import TTGlyphPen

UPEM_IN, PIX_IN = 800, 100
SX, SY = 3, 4
UPEM_OUT = UPEM_IN * SX                  # 2400; advance 2400
PIX_X, PIX_Y = PIX_IN * SX, PIX_IN * SY  # 300 x 400
ASCENT, DESCENT = 7 * PIX_Y, 1 * PIX_Y   # 2800, 400
GRID_W, GRID_H = 24, 32
INVERSE_BASE = 0xE000

ALIASES = {0x1FB87: 0x2595, 0x1FB82: 0x2594, 0x2582: 0x2581, 0x258E: 0x258F}

# Cell 0x14 of the Atari set: a filled disc. Rows top to bottom, MSB left.
DISC = [0x00, 0x00, 0x3C, 0x7E, 0x7E, 0x7E, 0x3C, 0x00]
DISC_BYTE = 0x14


def low_codepoints(atascii_js):
    """Bytes 0-127's codepoints, read out of the LOW table in fonts/atascii.js."""
    src = open(atascii_js).read()
    m = re.search(r'const LOW = \[(.*?)\];', src, re.S)
    if not m:
        raise SystemExit(f'{atascii_js}: LOW table not found')
    cps = [int(v, 16) for v in re.findall(r'0x([0-9A-Fa-f]+)', m.group(1))]
    if len(cps) != 128:
        raise SystemExit(f'{atascii_js}: LOW has {len(cps)} entries, expected 128')
    return cps


def bitmap(glyphset, name, pix_x, pix_y, top):
    """8x8 bitmap of a glyph, sampled at each pixel's centre."""
    rows = []
    for r in range(8):
        y = top - pix_y * r - pix_y // 2
        b = 0
        for c in range(8):
            pen = PointInsidePen(glyphset, (pix_x * c + pix_x // 2, y))
            glyphset[name].draw(pen)
            if pen.getResult():
                b |= 0x80 >> c
        rows.append(b)
    return rows


def glyph_from_bitmap(rows, glyf):
    """A simple glyph that is the union of the set pixels, at output scale."""
    import pathops
    path = pathops.Path()
    for r, bits in enumerate(rows):
        c = 0
        while c < 8:
            if not (bits >> (7 - c)) & 1:
                c += 1
                continue
            start = c
            while c < 8 and (bits >> (7 - c)) & 1:
                c += 1
            x0, x1 = start * PIX_X, c * PIX_X
            y1 = ASCENT - r * PIX_Y
            y0 = y1 - PIX_Y
            run = pathops.Path()
            run.moveTo(x0, y0); run.lineTo(x0, y1); run.lineTo(x1, y1); run.lineTo(x1, y0)
            run.close()
            path = pathops.op(path, run, pathops.PathOp.UNION)
    pen = TTGlyphPen(None)
    path.draw(pen)
    g = pen.glyph()
    g.recalcBounds(glyf)
    return g


def syncterm_atari(allfonts_c):
    """SyncTERM's Atari 8x8 set, 256 cells, from allfonts.c (by-hand check only)."""
    lines = open(allfonts_c, encoding='latin-1').read().split('\n')
    end = next(i for i, l in enumerate(lines) if '"Atari", CIOLIB_ATASCII' in l and 'NULL, NULL, NULL' not in l)
    # The 8x8 field is the run of literals after the previous `,	NULL` line.
    start = max(i for i in range(end) if re.match(r'^\s*,\s*NULL\s*$', lines[i]))
    data = b''
    for l in lines[start + 1:end]:
        for lit in re.findall(r'"((?:[^"\\]|\\.)*)"', l.split('//')[0]):
            data += codecs.escape_decode(lit.encode())[0]
    if len(data) != 2048:
        raise SystemExit(f'{allfonts_c}: Atari 8x8 field is {len(data)} bytes, expected 2048')
    return [list(data[i * 8:i * 8 + 8]) for i in range(256)]


def main(argv):
    check = None
    if '--check' in argv:
        i = argv.index('--check')
        check = argv[i + 1]
        argv = argv[:i] + argv[i + 2:]
    if len(argv) != 2:
        raise SystemExit('usage: atasciisubset.py <upstream.ttf> <datasource.ttf> [--check allfonts.c]')
    src, dst = argv
    here = os.path.dirname(os.path.abspath(__file__))
    low = low_codepoints(os.path.join(here, '..', 'public', 'fonts', 'atascii.js'))

    font = TTFont(src)
    if font['head'].unitsPerEm != UPEM_IN:
        raise SystemExit(f'{src}: upem {font["head"].unitsPerEm}, expected {UPEM_IN}')

    # Upstream bitmaps, before anything moves, for the verification at the end.
    up_cmap = font.getBestCmap()
    up_gs = font.getGlyphSet()
    want_up = {}
    for b, cp in enumerate(low):
        name = up_cmap.get(ALIASES.get(cp, cp))
        if name is None:
            raise SystemExit(f'byte 0x{b:02X}: U+{cp:04X} absent upstream')
        want_up[b] = bitmap(up_gs, name, PIX_IN, PIX_IN, 700)
    want_up[DISC_BYTE] = DISC

    keep = sorted(set(ALIASES.get(cp, cp) for cp in low))
    opts = subset.Options()
    opts.layout_features = []
    opts.name_IDs = list(range(15))
    opts.name_legacy = True
    opts.notdef_outline = False
    opts.recalc_bounds = True
    opts.glyph_names = True
    s = subset.Subsetter(options=opts)
    s.populate(unicodes=keep)
    s.subset(font)
    # Upstream carries vertical metrics this file does not use and would
    # otherwise have to scale; nothing here reads them.
    for tag in ('vhea', 'vmtx', 'FFTM'):
        if tag in font:
            del font[tag]

    glyf, hmtx = font['glyf'], font['hmtx']
    for name in font.getGlyphOrder():
        g = glyf[name]
        if g.isComposite():
            raise SystemExit(f'{name}: composite glyph')
        if not g.numberOfContours:
            continue
        coords, _, _ = g.getCoordinates(glyf)
        for i, (x, y) in enumerate(coords):
            if x % PIX_IN or y % PIX_IN:
                raise SystemExit(f'{name}: ({x}, {y}) is off the source-pixel lattice')
            coords[i] = (x * SX, y * SY)
        g.coordinates = coords
        g.recalcBounds(glyf)
    for name in font.getGlyphOrder():
        adv, lsb = hmtx[name]
        hmtx[name] = (adv * SX, lsb * SX)
    font['head'].unitsPerEm = UPEM_OUT

    order = font.getGlyphOrder()
    cmap_tables = [t for t in font['cmap'].tables if t.isUnicode()]

    def add(name, glyph, cps):
        if name not in order:
            order.append(name)
        glyf.glyphs[name] = glyph
        hmtx[name] = (UPEM_OUT, getattr(glyph, 'xMin', 0) if glyph.numberOfContours else 0)
        for t in cmap_tables:
            for cp in cps:
                if cp > 0xFFFF and t.format != 12:
                    continue
                t.cmap[cp] = name

    # A format 12 subtable, so the astral codepoints CTerm names can be mapped.
    from fontTools.ttLib.tables._c_m_a_p import CmapSubtable
    if not any(t.format == 12 for t in cmap_tables):
        t12 = CmapSubtable.newSubtable(12)
        t12.platformID, t12.platEncID, t12.language = 3, 10, 0
        t12.cmap = dict(cmap_tables[0].cmap)
        font['cmap'].tables.append(t12)
        cmap_tables.append(t12)

    base = font.getBestCmap()
    for cp, target in ALIASES.items():
        for t in cmap_tables:
            if cp <= 0xFFFF or t.format == 12:
                t.cmap[cp] = base[target]

    add('atariDisc', glyph_from_bitmap(DISC, glyf), [low[DISC_BYTE]])

    gs = font.getGlyphSet()
    cmap = font.getBestCmap()
    have_low = {}
    for b, cp in enumerate(low):
        rows = bitmap(gs, cmap[cp], PIX_X, PIX_Y, ASCENT)
        have_low[b] = rows
        inv = [0xFF ^ r for r in rows]
        add(f'inv{b:02X}', glyph_from_bitmap(inv, glyf), [INVERSE_BASE + 0x80 + b])
    font.setGlyphOrder(order)
    font['maxp'].numGlyphs = len(order)
    font['head'].recalcBBoxes = True

    font['hhea'].ascent, font['hhea'].descent, font['hhea'].lineGap = ASCENT, -DESCENT, 0
    font['hhea'].numberOfHMetrics = len(order)
    os2 = font['OS/2']
    os2.sTypoAscender, os2.sTypoDescender, os2.sTypoLineGap = ASCENT, -DESCENT, 0
    os2.usWinAscent, os2.usWinDescent = ASCENT, DESCENT
    os2.sCapHeight, os2.sxHeight = 7 * PIX_Y, 5 * PIX_Y

    font.save(dst)

    # ── Verification, on the file as written ─────────────────────────────────
    out = TTFont(dst)
    gs, cmap, hm, gl = out.getGlyphSet(), out.getBestCmap(), out['hmtx'], out['glyf']
    cells = []
    for b in range(256):
        cp = low[b] if b < 0x80 else INVERSE_BASE + b
        name = cmap.get(cp)
        if name is None:
            raise SystemExit(f'byte 0x{b:02X}: U+{cp:04X} not in the output cmap')
        rows = bitmap(gs, name, PIX_X, PIX_Y, ASCENT)
        want = want_up[b] if b < 0x80 else [0xFF ^ r for r in want_up[b - 0x80]]
        if rows != want:
            raise SystemExit(f'byte 0x{b:02X} ({name}): {rows} != {want}')
        adv, lsb = hm[name]
        if adv != UPEM_OUT:
            raise SystemExit(f'{name}: advance {adv} != {UPEM_OUT}')
        if gl[name].numberOfContours and lsb != gl[name].xMin:
            raise SystemExit(f'{name}: lsb {lsb} != xMin {gl[name].xMin}')
        cells.append(rows)
    if GRID_W * (ASCENT + DESCENT) != GRID_H * UPEM_OUT:
        raise SystemExit('cell-aspect invariant fails')
    if (GRID_W * ASCENT) % UPEM_OUT:
        raise SystemExit('baseline is not whole')

    msg = ''
    if check:
        ref = syncterm_atari(check)
        diff = [b for b in range(256) if ref[b] != cells[b]]
        if diff:
            raise SystemExit('differs from SyncTERM at ' + ', '.join(f'0x{b:02X}' for b in diff))
        msg = ', 256/256 identical to SyncTERM'

    print(f'{dst}: {out["maxp"].numGlyphs} glyphs, {len(cmap)} cmap entries, '
          f'upem {UPEM_OUT}, pixel {PIX_X}x{PIX_Y}, ascent {ASCENT}, descent {DESCENT}'
          f'{msg}')


if __name__ == '__main__':
    main(sys.argv[1:])
