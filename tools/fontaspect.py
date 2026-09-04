#!/usr/bin/env python3
"""
fontaspect.py — OFFLINE aspect transform for an outline (TTF) font.

FONTS.md: "the aspect knob on the TTF path is the file, not the renderer."
A `setTransform` stretch at draw time grid-fits the glyph at one size and then
scales the result, so stems the hinting snapped to whole pixels stop being whole
pixels — which forfeits the only reason to ship an outline font over the bitmap
it resembles. The supported way to change a face's aspect is therefore to
produce a NEW FILE whose horizontal geometry (and hinting controls) are scaled,
and ship that.

This is that generator. It is the ONLY Python in the repo and it is deliberately
not part of any test path: it runs once, by hand, to mint a checked-in source
asset into tools/datasource/, and `tools/tests/ttftest.js` then reads the shipped
metrics back out of that asset like it does for every other outline font. Nothing
at runtime, and nothing in `npm test`, depends on Python or on fontTools.

    pip install fonttools brotli
    python3 tools/fontaspect.py \
        --in  tools/datasource/Flexi_IBM_VGA_False_437.ttf \
        --out tools/datasource/Flexi_IBM_VGA_False_A160_437.ttf \
        --advance 800 \
        --family "Flexi IBM VGA False A160 (437)" \
        --woff2 public/fonts/Flexi_IBM_VGA_False_A160_437.woff2

WHAT IT TOUCHES, AND WHY EACH ONE MATTERS
  glyf coordinates   X only. Y is left bit-identical — that is what makes the
                     output the same typeface at a different width rather than a
                     new one. (VileR's own False/True pair differs in X only:
                     100% of Y coordinates are identical between them. FONTS.md)
  hmtx               advance and lsb, or the grid dissolves: the renderer derives
                     fontSize from `upem/advance` (fonts/index.js
                     outlineMetrics()), so an unscaled advance would typeset the
                     narrowed glyphs at the OLD pitch and leave a gap in every
                     cell.
  cvt                the X-axis control values. In Flexi these are entries 32/33,
                     a stem-width control reading 200 in False against 150 in
                     True — exactly the 0.75 of the advance ratio, which is how
                     they were identified. They are passed on --cvt (default:
                     Flexi's 32,33) because which entries are horizontal is a
                     property of the font's hinting program, not something that
                     can be inferred. Leave them unscaled and the hinting snaps
                     stems to the OLD width on the NEW body — heavier, and
                     unevenly so.
  head/hhea/OS/2     the derived bounds and xAvgCharWidth. Cosmetic to the
                     renderer, but a font whose declared bbox does not contain
                     its outlines is malformed and some rasterizers clip on it.
  name               family / full / PostScript / unique ID. REQUIRED: the
                     browser keys a loaded FontFace by family string, so a
                     variant shipped under the source's family name would
                     collide with it in `document.fonts` and one of the two
                     would silently win.

WHAT IT DOES NOT TOUCH
  fpgm / prep / per-glyph instructions. They are copied through verbatim. This
  is the honest limitation of the whole approach and it is why HANDOFF's plan
  asks for a `tools/probe.html` pass on the output: VileR RE-AUTHORED the hinting
  for each of his two variants (per-glyph instruction streams differ in length),
  so a mechanically scaled file is hinted *approximately*, not natively. Scaling
  the cvt entries carries most of it; confirming stems still snap is a
  measurement, not something this script can assert.

  Note also that 8/9 puts the columns of a 9-wide face on a non-round 88.89-unit
  grid, where False and True use round 100 and 75. Units are units and the
  rasterizer does not care, but it does mean the column edges no longer coincide
  with cvt-controlled round numbers.

SynthLink's own code, GPL-3.0-or-later. The FONTS it transforms are third-party assets
under their own licences — a derivative of a CC BY-SA 4.0 face is CC BY-SA 4.0
and must carry the attribution (see PROVENANCE.md and public/about.html).
"""

import argparse
import os
import sys


def emit_woff2(ttf_path, woff2_path):
    """
    Compress a .ttf to the .woff2 that ships, preserving `totalSfntSize`.

    woff2's header carries `totalSfntSize`, the byte size the font decompresses
    back to, and tools/tests/ttftest.js asserts it equals the length of the .ttf
    beside it. That equality is the whole tie between a shipped woff2 and its
    source — it is what catches a woff2 left behind after the source was
    replaced — so it must hold exactly.

    It does NOT hold automatically. woff2's optional glyf/loca transform is
    lossless in outline terms but not in table PADDING: the writer reports the
    size of the sfnt it would reconstruct, which for a file whose glyf was
    packed more tightly than the reconstruction packs it is a few hundred bytes
    larger than the file on disk. VileR's originals happen to agree; a .ttf that
    fontTools itself has recompiled (i.e. anything this script produces) does
    not, and was over-reporting by 236 bytes.

    So: try the transform, keep it only if the tie holds, and otherwise fall
    back to the untransformed encoding, which reports the true size by
    construction. The fallback costs about 10% of the compressed size and is
    still less than half the .ttf — it buys an assertion that can actually fail
    for the reason it was written to catch.
    """
    import struct
    from fontTools.ttLib import TTFont
    from fontTools.ttLib.woff2 import WOFF2FlavorData

    want = os.path.getsize(ttf_path)

    def write(transformed):
        f = TTFont(ttf_path)
        f.flavor = 'woff2'
        if not transformed:
            f.flavorData = WOFF2FlavorData(transformedTables=[])
        f.save(woff2_path)
        with open(woff2_path, 'rb') as fh:
            return struct.unpack('>I', fh.read(20)[16:20])[0]

    got = write(True)
    note = 'glyf-transformed'
    if got != want:
        got = write(False)
        note = 'untransformed (the transform mis-reports totalSfntSize here)'
    if got != want:
        raise SystemExit(f'{woff2_path}: totalSfntSize {got} != ttf size {want}')

    print(f'  wrote {woff2_path}  ({os.path.getsize(woff2_path)} bytes, {note})')


def scale_x(font, ratio, cvt_indices):
    glyf = font['glyf']
    hmtx = font['hmtx']

    # ── Outlines: X only ────────────────────────────────────────────────────
    for name in glyf.keys():
        g = glyf[name]
        if g.numberOfContours == 0:
            continue
        if g.isComposite():
            # Not reachable for Flexi (0 composites) and deliberately refused
            # rather than half-handled: a composite's component offsets scale,
            # but a component with a 2x2 transform needs the transform scaled
            # too, and getting that subtly wrong shifts accents by a pixel in a
            # way nobody notices until it ships.
            raise SystemExit(f'composite glyph {name!r}: not supported, see the header')
        coords = g.coordinates
        for i in range(len(coords)):
            x, y = coords[i]
            coords[i] = (round(x * ratio), y)
        g.recalcBounds(glyf)

    # ── Advances and side bearings ──────────────────────────────────────────
    for name in hmtx.metrics:
        adv, lsb = hmtx.metrics[name]
        hmtx.metrics[name] = (round(adv * ratio), round(lsb * ratio))

    # ── Hinting control values on the X axis ────────────────────────────────
    if 'cvt ' in font and cvt_indices:
        cvt = font['cvt ']
        for i in cvt_indices:
            if i < 0 or i >= len(cvt.values):
                raise SystemExit(f'--cvt {i} is out of range (cvt has {len(cvt.values)} entries)')
            cvt.values[i] = round(cvt.values[i] * ratio)

    # ── Derived bounds ──────────────────────────────────────────────────────
    inked = [glyf[n] for n in glyf.keys() if glyf[n].numberOfContours != 0]
    head = font['head']
    head.xMin = min(g.xMin for g in inked)
    head.xMax = max(g.xMax for g in inked)

    hhea = font['hhea']
    hhea.advanceWidthMax = max(a for a, _ in hmtx.metrics.values())
    hhea.minLeftSideBearing = min(hmtx.metrics[n][1] for n in glyf.keys()
                                  if glyf[n].numberOfContours != 0)
    hhea.xMaxExtent = max(hmtx.metrics[n][1] + (glyf[n].xMax - glyf[n].xMin)
                          for n in glyf.keys() if glyf[n].numberOfContours != 0)
    hhea.minRightSideBearing = min(hmtx.metrics[n][0] - hmtx.metrics[n][1] -
                                   (glyf[n].xMax - glyf[n].xMin)
                                   for n in glyf.keys() if glyf[n].numberOfContours != 0)

    os2 = font['OS/2']
    os2.xAvgCharWidth = round(os2.xAvgCharWidth * ratio)


def rename(font, family):
    """Family / full / PostScript / unique ID, across every name record."""
    ps = family.replace(' ', '_').replace('(', '').replace(')', '')
    name = font['name']
    for rec in name.names:
        if rec.nameID in (1, 4, 16):
            rec.string = family
        elif rec.nameID == 6:
            rec.string = ps
        elif rec.nameID == 3:
            rec.string = f'{ps}:synthlink-aspect'


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[1])
    ap.add_argument('--in', dest='src', required=True)
    ap.add_argument('--out', dest='dst', required=True, help='transformed .ttf (a source asset)')
    ap.add_argument('--advance', type=int, required=True,
                    help='target hmtx advance in font units; the ratio is derived from it')
    ap.add_argument('--family', required=True, help='new family name — MUST differ from the source')
    ap.add_argument('--woff2', help='also emit the shipped woff2 here')
    ap.add_argument('--cvt', default='32,33',
                    help="comma-separated cvt indices that control X (default Flexi's stem pair)")
    args = ap.parse_args(argv)

    try:
        from fontTools.ttLib import TTFont
    except ImportError:
        raise SystemExit('needs fontTools: pip install fonttools brotli')

    font = TTFont(args.src)
    src_advance = font['hmtx'].metrics[font.getGlyphOrder()[1]][0]
    # Read the advance off a real glyph rather than trusting .notdef, then
    # confirm the face is monospace: a proportional source has no single
    # advance to scale toward and the whole idea is meaningless for it.
    advances = {a for a, _ in font['hmtx'].metrics.values()}
    if len(advances) != 1:
        raise SystemExit(f'source is not monospace ({len(advances)} distinct advances)')
    src_advance = advances.pop()

    ratio = args.advance / src_advance
    upem = font['head'].unitsPerEm
    asc, desc = font['OS/2'].usWinAscent, font['OS/2'].usWinDescent
    print(f'{args.src}\n  advance {src_advance} -> {args.advance}  (x{ratio:.6f})')
    print(f'  upem {upem}, cell {asc + desc} units'
          f'  =>  80x25 terminal aspect '
          f'{80 * src_advance / (25 * (asc + desc)):.3f} -> {80 * args.advance / (25 * (asc + desc)):.3f}')

    cvt_indices = [int(x) for x in args.cvt.split(',') if x.strip() != '']
    if 'cvt ' in font:
        before = [font['cvt '].values[i] for i in cvt_indices]
    scale_x(font, ratio, cvt_indices)
    if 'cvt ' in font:
        after = [font['cvt '].values[i] for i in cvt_indices]
        print(f'  cvt {cvt_indices}: {before} -> {after}')

    rename(font, args.family)
    font.save(args.dst)
    print(f'  wrote {args.dst}')

    if args.woff2:
        emit_woff2(args.dst, args.woff2)


if __name__ == '__main__':
    main(sys.argv[1:])
