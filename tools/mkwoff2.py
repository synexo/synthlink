#!/usr/bin/env python3
"""
mkwoff2.py — convert a source .ttf in tools/datasource/ to the .woff2 that ships.

FONTS.md: "Flexi is 82 KB as .ttf; woff2 typically cuts that 60-70%. Convert
before shipping." This is that conversion, and nothing more — no transform, no
subsetting, no renaming. The .ttf stays in tools/datasource as the source asset
tools/tests/ttftest.js reads metrics from; the .woff2 goes in public/fonts and is what
the registry's `file` field points at.

    pip install fonttools brotli
    python3 tools/mkwoff2.py tools/datasource/Flexi_IBM_VGA_True_437.ttf \
                             public/fonts/Flexi_IBM_VGA_True_437.woff2

Subsetting is deliberately NOT offered. The registry declares 256 CP437
codepoints and ttftest asserts every one resolves to a real glyph; a subsetter
invoked with a wrong codepoint list would silently drop box-drawing characters
nobody inspects closely, and 27 KB is not worth that risk.

The totalSfntSize tie that makes a stale woff2 detectable is handled in
fontaspect.emit_woff2() — see its docstring for why it is not automatic.

SynthLink's own code, GPL-3.0-or-later.
"""

import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fontaspect import emit_woff2                                # noqa: E402


def main(argv):
    if len(argv) != 2:
        raise SystemExit('usage: mkwoff2.py <source.ttf> <shipped.woff2>')
    src, dst = argv
    if not src.lower().endswith('.ttf'):
        raise SystemExit(f'{src}: expected a .ttf source asset')
    print(src)
    emit_woff2(src, dst)


if __name__ == '__main__':
    main(sys.argv[1:])
