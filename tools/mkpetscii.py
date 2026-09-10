#!/usr/bin/env python3
"""
mkpetscii.py — generate public/fonts/petscii.js from the BESCII font files.

    pip install fonttools freetype-py
    python3 tools/mkpetscii.py bescii-v1.2.ttf Bescii-Mono-v2.0.ttf \
                               public/fonts/petscii.js

BY HAND, like every other script in this directory, and on no test path. It runs
once per upstream BESCII release.

WHY THIS IS GENERATED RATHER THAN TYPED
---------------------------------------

FONTS.md 11.3 step 2: "If the table is new, generate it mechanically the way
cp437.js and latin1.js were, and have ttftest re-derive it independently."
Latin-1 was one line of Python because it is the identity map. PETSCII is not:
it is two 256-entry tables whose entries are scattered across box drawing, block
elements, geometric shapes and a private-use area, and typing 512 codepoints by
hand is exactly how a wrong box-drawing character nobody inspects closely ships.

THE INPUT IS BESCII ITSELF, AND THAT IS THE POINT
-------------------------------------------------

BESCII v1.2 carries the style64.org "Direct PETSCII" mapping in its own cmap:
PETSCII code N appears at U+E000+N for the unshifted (upper/graphics) set and at
U+E100+N for the shifted (lower/upper) set. v2.0 dropped almost all of that block
in favour of real Unicode — box drawing, block elements, Symbols for Legacy
Computing — keeping the private-use area only for the ~20 PETSCII glyphs that
have no Unicode equivalent at all.

So v1.2 answers "which glyph is PETSCII code N" and v2.0 answers "where does that
glyph live now". Resolution runs in that order:

  1. Look up U+E000+N (or U+E100+N) in v1.2's cmap to get a GLYPH NAME.
  2. Ask v1.2's own cmap which OTHER codepoints map to that same glyph, and take
     the first non-private one that v2.0 also has. This is the author stating the
     Unicode equivalence himself, and it is exact — no shape comparison, and
     immune to a glyph being redrawn between the two releases.
  3. Only if there is no such alias — the genuinely Unicode-less graphics — fall
     back to matching the 8x8 rasterized bitmap against v2.0's glyphs, preferring
     a non-private codepoint. That resolves the remaining handful into v2.0's own
     private-use slots.

Both files are CC0, so the table this produces is derived from nothing but the
font it is drawn against. That matters here: the obvious alternative source, the
`cbmcodecs2` Python package, is GPL-2.0-ONLY, which HANDOFF.md already names as
incompatible with this repo's GPL-3.0 — the same trap as linmodem. It is a fine
CROSS-CHECK to run by hand and a bad thing to derive a shipped table from.

Run against cbmcodecs2 anyway, this table agrees at 146 of the comparable
unshifted positions and 172 of the shifted ones, and differs at three glyphs —
0x71/0xD1, 0xA5/0xE5 and 0xA7/0xE7 — in every case because step 2 recovers the
glyph BESCII actually draws where the general-purpose table picks a near miss.
0xA5 is the clearest: the C64's left-edge bar is TWO pixels wide, which is
U+258E LEFT ONE QUARTER BLOCK, and the general table says U+258F LEFT ONE EIGHTH
BLOCK, which BESCII v2.0 correctly draws one pixel wide. PETSCII.md has the
detail.

THE STRUCTURAL RULES, which are facts about the machine and not a table
----------------------------------------------------------------------

  - 0x00-0x1F and 0x80-0x9F are CONTROL CODES in PETSCII, not characters. They
    are blanked, exactly as Latin-1's C0/C1 ranges are, and blanking is policy
    applied at the atlas builder rather than a lookup (FONTS.md 11.4).
  - 0xC0 displays as 0x60 and 0xE0 as 0xA0. v1.2 omits those two private
    codepoints for that reason; the alias is applied here.
  - The SHIFTED set is the unshifted set with the letter positions swapped —
    0x41-0x5A become lowercase, 0x61-0x7A and 0xC1-0xDA uppercase — plus the
    handful of graphics positions that genuinely differ. Which positions those
    are is not guessed: it is exactly the set of U+E1xx codepoints v1.2 defines,
    because a shifted position that matched the unshifted one needed no entry.

SynthLink's own code, GPL-3.0-or-later. The font itself is not ours — see
PROVENANCE.md and public/about.html.
"""

import collections
import sys

import freetype
from fontTools.ttLib import TTFont

# Codepoint ranges whose glyphs must MEET their neighbours — the `isGraphics`
# answer, which FONTS.md 11.2 insists is a property of the ENCODING. Box drawing
# and block elements are edge-to-edge by construction; 0x25E2-0x25E6 are the
# filled corner triangles PETSCII shades with, which tile diagonally; and the
# private-use range is where BESCII keeps the PETSCII-only bars and corners,
# every one of which is a block shape. Deliberately NOT here: the card suits, pi,
# the arrows, the bullet and the circles, which are letterform-shaped and whose
# ink must stay inside its own cell.
GRAPHICS_RANGES = ((0x2500, 0x259F), (0x25E2, 0x25E6), (0xE000, 0xF8FF))


def is_graphics(cp):
    return cp is not None and any(lo <= cp <= hi for lo, hi in GRAPHICS_RANGES)


def cellgrid(path, ascent_px=7):
    """Every glyph in `path` as an 8x8 monochrome grid, keyed by codepoint.

    The em is rasterized at 8 pixels, which for these files is one device pixel
    per source pixel — BESCII is an 8x8 pixel font on square units, so this is a
    faithful readback rather than a resampling.
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


def build(v12_path, v20_path):
    cm12 = TTFont(v12_path).getBestCmap()
    cm20 = set(TTFont(v20_path).getBestCmap())
    bm12, bm20 = cellgrid(v12_path), cellgrid(v20_path)

    alias = collections.defaultdict(list)                 # glyph name -> codepoints
    for cp, name in cm12.items():
        alias[name].append(cp)
    by_shape = collections.defaultdict(list)              # 8x8 bitmap -> codepoints
    for cp, grid in bm20.items():
        by_shape[grid].append(cp)

    def resolve(pua):
        """A v1.2 Direct-PETSCII codepoint -> the v2.0 codepoint for that glyph."""
        name = cm12.get(pua)
        if name is None:
            return None, 'absent in v1.2'
        for cp in sorted(c for c in alias[name] if not 0xE000 <= c <= 0xF8FF):
            if cp in cm20:
                return cp, 'v1.2 cmap alias'
        cands = by_shape.get(bm12.get(pua), [])
        real = [c for c in cands if not 0xE000 <= c <= 0xF8FF]
        if cands:
            return min(real or cands), 'bitmap match'
        return None, 'UNRESOLVED'

    def control(i):
        return i < 0x20 or 0x80 <= i <= 0x9F

    notes = {}
    unshifted = {}
    for i in range(256):
        if control(i):
            unshifted[i], notes[(0, i)] = None, 'control code'
        elif i == 0x40:
            unshifted[i], notes[(0, i)] = 0x0040, 'ASCII, no Direct-PETSCII entry'
        elif i in (0xA0, 0xE0):
            unshifted[i], notes[(0, i)] = 0x00A0, 'shifted space'
        else:
            src = 0xE000 + (0x60 if i == 0xC0 else i)
            cp, why = resolve(src)
            unshifted[i], notes[(0, i)] = cp, why

    shifted = dict(unshifted)
    for i in range(256):
        notes[(1, i)] = notes[(0, i)]                     # shared with the unshifted set
    for i in range(0x41, 0x5B):
        shifted[i], notes[(1, i)] = i + 0x20, 'shifted set: lowercase'
    for i in range(0x61, 0x7B):
        shifted[i], notes[(1, i)] = i - 0x20, 'shifted set: uppercase'
    for i in range(0xC1, 0xDB):
        shifted[i], notes[(1, i)] = i - 0x80, 'shifted set: uppercase (alias of 0x61)'
    for pua in sorted(c for c in cm12 if 0xE100 <= c <= 0xE1FF):
        i = pua - 0xE100
        cp, why = resolve(pua)
        shifted[i], notes[(1, i)] = cp, f'shifted set: own glyph ({why})'

    return unshifted, shifted, notes


def emit_table(name, table, comment):
    lines = [f'/** {comment} */',
             f'export const {name} = new Uint16Array([']
    for row in range(0, 256, 8):
        cells = ', '.join('0x%04X' % (table[i] or 0) for i in range(row, row + 8))
        lines.append(f'  {cells},   // 0x{row:02X}')
    lines.append(']);')
    return '\n'.join(lines)


def ranges_of(codes):
    """Contiguous runs, as (lo, hi) pairs — for a compact predicate."""
    out = []
    for c in sorted(codes):
        if out and c == out[-1][1] + 1:
            out[-1][1] = c
        else:
            out.append([c, c])
    return [tuple(r) for r in out]


def main(argv):
    if len(argv) != 3:
        raise SystemExit('usage: mkpetscii.py <bescii-v1.2.ttf> <bescii-v2.0.ttf> <out.js>')
    v12, v20, out = argv
    unshifted, shifted, notes = build(v12, v20)

    bad = [f'0x{i:02X} ({notes[(k, i)]})'
           for k, t in ((0, unshifted), (1, shifted))
           for i, v in t.items() if v is None and not notes[(k, i)].startswith('control')]
    if bad:
        raise SystemExit('unresolved positions: ' + ', '.join(bad))

    gfx_uc = ranges_of(i for i, v in unshifted.items() if is_graphics(v))
    gfx_lc = ranges_of(i for i, v in shifted.items() if is_graphics(v))

    def rng(rs):
        return ', '.join(f'[0x{a:02X}, 0x{b:02X}]' for a, b in rs)

    body = f'''/*
 * fonts/petscii.js - PETSCII to Unicode, both character sets, all 256 positions.
 *
 * The Commodore 64's character set, and so the one a PETSCII board's art is
 * drawn against. Same job as cp437.js and latin1.js and the same shape: the
 * OUTLINE path needs the character a byte MEANS before fillText can draw it.
 * See FONTS.md and PETSCII.md.
 *
 * TWO TABLES, WHICH IS WHAT MAKES THIS DIFFERENT. A C64 has two character sets
 * and switches between them IN BAND, mid-screen: 0x0E selects the shifted
 * (lower/upper) set and 0x8E the unshifted (upper/graphics) one. The same byte
 * is a different character on either side of that switch - 0x41 is `A` unshifted
 * and `a` shifted, and 0x61-0x7A are graphics unshifted and uppercase letters
 * shifted. So a charset descriptor built on either table alone is only half of
 * PETSCII, and the atlas has to be able to hold both. PETSCII.md is the design
 * note for that; this file is only the tables, and nothing imports it yet.
 *
 * GENERATED MECHANICALLY by tools/mkpetscii.py, not hand-typed - 512 codepoints
 * scattered across box drawing, block elements, geometric shapes and a
 * private-use area is not something to type. That script's docstring is the
 * authority on how each position was resolved; the short version is that BESCII
 * v1.2 carries style64.org's "Direct PETSCII" mapping in its own cmap and v2.0
 * carries the Unicode equivalences, so the font states both halves itself.
 *
 * THE PRIVATE-USE ENTRIES ARE NOT A HACK. Around twenty PETSCII graphics have no
 * Unicode equivalent at any codepoint - two-pixel-wide edge bars, the quarter
 * corner pieces - and BESCII keeps exactly those in the private-use area. An
 * entry in 0xE000-0xF8FF here means "this glyph exists only in this font", and
 * it is why the table and the face cannot be separated: a different PETSCII face
 * would need its own table. FONTS.md 11.1's "one id settles three things" is the
 * same argument.
 *
 * The blank positions are policy rather than lookup, handled at the atlas
 * builder exactly as CP437's two and Latin-1's C0/C1 are: 0x00-0x1F and
 * 0x80-0x9F are PETSCII CONTROL CODES - colour, cursor movement, reverse video,
 * the charset switch itself - and have no printable character in either set.
 * They must come out blank rather than as .notdef boxes. 0xA0 and 0xE0 are the
 * shifted space and blank for the same reason CP437 blanks its NBSP.
 *
 * SynthLink's own code, GPL-3.0-or-later.
 */

{emit_table('PETSCII_UC_TO_UNICODE', unshifted,
            'Unshifted (upper/graphics) set. PETSCII byte -> Unicode codepoint; 0 = blank.')}

{emit_table('PETSCII_LC_TO_UNICODE', shifted,
            'Shifted (lower/upper) set. PETSCII byte -> Unicode codepoint; 0 = blank.')}

/**
 * The PETSCII byte as a JS string, ready for fillText. One per set.
 * Cached, for the same reason CP437_CHARS is.
 *
 * A blank position yields '' rather than U+0000: the atlas builder skips it on
 * the `blank` predicate and never calls fillText, so the value is unreachable,
 * and an empty string is the honest thing to leave there.
 */
const chars = (t) => Array.from(t, (c) => (c ? String.fromCharCode(c) : ''));
export const PETSCII_UC_CHARS = chars(PETSCII_UC_TO_UNICODE);
export const PETSCII_LC_CHARS = chars(PETSCII_LC_TO_UNICODE);

/**
 * Which positions are line graphics, i.e. must MEET their neighbours.
 *
 * Unlike CP437's single 0xB0-0xDF run this is not contiguous, and unlike
 * Latin-1's constant false it is not empty - PETSCII interleaves letters and
 * graphics, and does so DIFFERENTLY in the two sets, because 0x61-0x7A are
 * graphics unshifted and letters shifted. That is the second reason the two
 * tables cannot be collapsed into one descriptor.
 *
 * Derived by tools/mkpetscii.py from the codepoint each position resolves to:
 * box drawing and block elements (U+2500-U+259F), the filled corner triangles
 * PETSCII shades with (U+25E2-U+25E6), and the private-use range, which is
 * entirely block shapes. The card suits, pi, the arrows, the bullet and the
 * circles are deliberately excluded - they are letterform-shaped and their ink
 * must stay inside its own cell.
 */
export const PETSCII_UC_GRAPHICS = [{rng(gfx_uc)}];
export const PETSCII_LC_GRAPHICS = [{rng(gfx_lc)}];

/** True if `i` falls in one of `ranges`. */
export const inRanges = (ranges, i) => ranges.some(([lo, hi]) => i >= lo && i <= hi);

/**
 * PETSCII's control codes: 0x00-0x1F and 0x80-0x9F, plus the two spaces.
 *
 * The C64 spends these on colour, cursor movement, reverse video, HOME, CLR,
 * insert/delete and the charset switch - none of which is a character, and all
 * of which a PETSCII terminal has to ACT on rather than draw. Blanking them here
 * is only the atlas half of that; PETSCII.md has the other half.
 */
export const petsciiBlank = (i) =>
  i < 0x20 || (i >= 0x80 && i <= 0x9F) || i === 0xA0 || i === 0xE0;
'''
    with open(out, 'w') as f:
        f.write(body)
    print(f'{out}: 2 x 256 positions, '
          f'{sum(1 for v in unshifted.values() if v)} / '
          f'{sum(1 for v in shifted.values() if v)} printable, '
          f'{len(gfx_uc)} / {len(gfx_lc)} graphics runs')


if __name__ == '__main__':
    main(sys.argv[1:])
