#!/usr/bin/env python3
"""
mkrainsplash.py - render the pre-roll splash loop: CP437 "digital rain" drawn
with the Pixel face (Px437 AST PremiumExec, the 8x19 cell), encoded for
instant start.

By hand, like the other tools here. Needs `pip install fonttools brotli
pillow numpy` and ffmpeg on PATH. Outputs into public/splash/.

Why a rendered video and not a canvas: the canvas cannot draw until the
bundle, the font file and the atlas builder are all in, which is the wait
this is covering. A video element paints from the first packet.

The loop is SEAMLESS by construction, not by cross-fade:
  - a column's fall speed is m*W/N rows per frame, so after N frames it has
    made exactly m whole passes of its wrap length W and is where it started;
  - a cell's glyph is table[(hash + t//hold) % len(table)], and every `hold`
    a column can be given divides N, so the churn has the same period.
Nothing is random per frame - every frame is a pure function of t, which is
also why frame N is bit-identical to frame 0.
"""

import os, subprocess, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from fontTools.ttLib import TTFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
WOFF2 = os.path.join(ROOT, 'public', 'fonts', 'Px437_AST_PremiumExec.woff2')
OUTDIR = os.path.join(ROOT, 'public', 'splash')

CELL_W, GLYPH_H = 8, 19         # the AST PremiumExec ROM cell
CELL_H = 20                     # ...in a 20-row box: one blank leading row, the
                                # way a text mode pads a ROM face to its scanline
                                # count. It is also what makes the grid divide a
                                # 16:9 frame exactly.
COLS, ROWS = 120, 27            # 120x27 of that cell is 960x540 ON THE NOSE, so
                                # the frame is NATIVE - no scale, no resample, no
                                # aspect correction, every glyph pixel-exact. The
                                # cell is the same size an 80x25 screen uses; this
                                # is a wider screen, not a smaller font.
W, H = COLS * CELL_W, ROWS * CELL_H     # 960 x 540
FPS = 24
N = 96                          # 4.0 s
# Frames a cell keeps its glyph. Per COLUMN now, off its depth plane - see
# HOLDS below. Every value there must divide N or that column will not close
# the loop.

# The tail is ANSI ATTRIBUTES, not a gradient - five colours off the 16-colour
# palette and then the cell is simply not written. A BBS had no alpha and no
# in-between greens, and stepping the trail through the palette is what makes
# this read as a terminal rather than as a shader.
WHITE  = (255, 255, 255)   # 1;37
GREY   = (170, 170, 170)   #   37
BGREEN = ( 85, 255,  85)   # 1;32
GREEN  = (  0, 170,   0)   #   32
DGREY  = ( 85,  85,  85)   # 1;30


def build_atlas():
    """256 CP437 glyphs x 4 orientations -> (1024, CELL_H, CELL_W) uint8 alpha."""
    ttf = os.path.join(OUTDIR, '.ast.ttf')
    os.makedirs(OUTDIR, exist_ok=True)
    f = TTFont(WOFF2)
    f.flavor = None
    f.save(ttf)
    font = ImageFont.truetype(ttf, GLYPH_H * 2)  # 2 px per unit cell; the face
    # rasterises exactly on the grid, so the advance is CELL_W*2 and the full
    # block 0xDB fills the cell edge to edge. Rendered at 2x and box-filtered
    # down, so the outline path's hinting cannot drop a one-pixel stem.
    sheet = np.zeros((1024, CELL_H, CELL_W), np.uint8)
    for b in range(256):
        if b in (0x00, 0xFF):        # NUL / NBSP are blank by policy, per cp437.js
            continue
        ch = bytes([b]).decode('cp437')
        im = Image.new('L', (CELL_W * 2, GLYPH_H * 2), 0)
        ImageDraw.Draw(im).text((0, 0), ch, font=font, fill=255)
        g = np.asarray(im.resize((CELL_W, GLYPH_H), Image.BOX), np.uint8)
        # The orientation is of the GLYPH; the leading row stays where it is, so
        # a flipped cell still sits on the same baseline grid as its neighbours.
        sheet[b, :GLYPH_H] = g                    # normal
        sheet[256 + b, :GLYPH_H] = g[:, ::-1]     # mirrored
        sheet[512 + b, :GLYPH_H] = g[::-1, :]     # flipped
        sheet[768 + b, :GLYPH_H] = g[::-1, ::-1]  # rotated 180
    os.remove(ttf)
    return sheet


def rng(*k):
    """Deterministic small hash - no numpy RNG, so a re-run is byte-identical."""
    h = 2166136261
    for v in k:
        h = ((h ^ (v & 0xFFFFFFFF)) * 16777619) & 0xFFFFFFFF
    return h


def main():
    atlas = build_atlas()

    # Glyphs that read as rain: no blanks, no full/half blocks (they smear into
    # a solid bar), no line-drawing runs. Digits, letters, punctuation, the
    # maths and Greek block and the shading characters.
    pool = [b for b in range(256)
            if b not in (0x00, 0x20, 0xFF)
            and not (0xB0 <= b <= 0xDF and b not in (0xB0, 0xB1, 0xB2))]
    pool = np.array(pool, np.int32)

    # DEPTH. A column is on one of five planes, and the plane sets four things
    # at once - that is what makes it read as parallax rather than as columns
    # that happen to run at different rates:
    #
    #   plane  passes/loop  rows/frame   tail   churn      attributes
    #     1        1        0.4 - 0.8    short  every 6f   dim: no white head
    #     5        5        1.9 - 4.2    long   every 2f   full: white head
    #
    # Distance is expressed in ANSI ATTRIBUTES, not opacity: a far column simply
    # starts further down the palette, so the whole field stays inside the
    # sixteen colours. Speed is still m*W/N, so every plane closes the loop.
    # The plane histogram is weighted - most columns are mid-field, and the
    # nearest plane is rare, because a screen of streaks has no depth either.
    PLANE = (1, 1, 1, 2, 2, 3, 3, 4, 4, 5)
    HOLDS = {1: 6, 2: 6, 3: 4, 4: 3, 5: 2}   # all divide N, so all close the loop
    wrap = np.empty(COLS, np.int32)
    speed = np.empty(COLS, np.float64)
    tail = np.empty(COLS, np.int32)
    phase = np.empty(COLS, np.float64)
    plane = np.empty(COLS, np.int32)
    hold = np.empty(COLS, np.int32)
    for c in range(COLS):
        r = rng(c, 7)
        m = PLANE[(r >> 17) % len(PLANE)]
        plane[c] = m
        hold[c] = HOLDS[m]
        tail[c] = 4 + 2 * m + (r >> 3) % 7              # 6..11 near plane 1, 14..20 at 5
        gap = 3 + (r >> 9) % 34
        wrap[c] = ROWS + int(tail[c]) + gap
        speed[c] = m * wrap[c] / N
        phase[c] = ((r >> 23) % 1000) / 1000.0 * wrap[c]
    # Columns that are simply absent, so the field is not a comb.
    live = np.array([(rng(c, 19) % 100) >= 12 for c in range(COLS)])

    # Per-cell churn: which entry of the pool, and which orientation.
    base = np.array([[rng(c, r, 3) for r in range(ROWS)] for c in range(COLS)], np.int64)
    orient = np.array([[(rng(c, r, 11) % 4) * 256 for r in range(ROWS)] for c in range(COLS)], np.int64)
    # A cell either churns with the loop clock or holds one glyph the whole way;
    # a field where everything flickers at one rate looks mechanical.
    churny = np.array([[(rng(c, r, 23) % 100) < 55 for r in range(ROWS)] for c in range(COLS)])

    # Five bands per plane, proportioned off the column's own tail length so a
    # long column is not five rows of white. Reading down a row is reading into
    # the distance: the near planes get the white head and the grey shoulder,
    # the far ones start at green and end in 1;30, which on a black screen is
    # the dimmest thing a terminal can put in a cell.
    BANDS = {
        5: (WHITE, GREY,   BGREEN, GREEN,  DGREY),
        4: (WHITE, GREY,   BGREEN, GREEN,  DGREY),
        3: (WHITE, BGREEN, GREEN,  GREEN,  DGREY),
        2: (GREY,  BGREEN, GREEN,  DGREY,  DGREY),
        1: (BGREEN, GREEN, GREEN,  DGREY,  DGREY),
    }
    EDGES = (0.10, 0.30, 0.70)

    def attr(d, tl, m):
        """Trail position -> one of the sixteen ANSI colours."""
        band = BANDS[m]
        if d == 0:
            return band[0]
        f = d / float(tl)
        for i, e in enumerate(EDGES):
            if f < e:
                return band[i + 1]
        return band[4]

    args = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
            '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}',
            '-r', str(FPS), '-i', '-']
    # No filter at all: the grid IS 960x540, both dimensions even for 4:2:0.
    # Anything that rescaled here would soften every stem in the face.
    common = ['-an']
    webm = args + common + ['-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0',
                            '-row-mt', '1', '-cpu-used', '1', '-g', str(N),
                            '-pix_fmt', 'yuv420p', '-auto-alt-ref', '1',
                            '-lag-in-frames', '25',
                            os.path.join(OUTDIR, 'rain.webm')]
    mp4 = args + common + ['-c:v', 'libx264', '-preset', 'veryslow', '-crf', '24',
                           '-profile:v', 'high', '-pix_fmt', 'yuv420p',
                           '-g', str(N), '-movflags', '+faststart',
                           os.path.join(OUTDIR, 'rain.mp4')]

    frames = []
    canvas_h = ROWS * CELL_H
    for t in range(N):
        cellcol = np.zeros((ROWS, COLS, 3), np.float64)
        idx = np.zeros((ROWS, COLS), np.int64)
        drawn = np.zeros((ROWS, COLS), bool)
        for c in range(COLS):
            if not live[c]:
                continue
            head = (phase[c] + speed[c] * t) % wrap[c]
            tl = int(tail[c])
            step = t // int(hold[c])   # a near column churns faster than a far one
            r0 = int(np.floor(head))
            for d in range(0, tl):
                r = r0 - d
                if r < 0 or r >= ROWS:
                    continue
                col = attr(d, tl, int(plane[c]))
                if col is None:
                    continue
                cellcol[r, c] = col
                s = base[c, r] + (step if churny[c, r] else 0)
                idx[r, c] = pool[s % len(pool)] + orient[c, r]
                drawn[r, c] = True
        rgb = np.zeros((canvas_h, COLS * CELL_W, 3), np.float64)
        rr, cc = np.nonzero(drawn)
        if len(rr):
            g = atlas[idx[rr, cc]].astype(np.float64) / 255.0   # (n, CELL_H, CELL_W)
            px = g[..., None] * cellcol[rr, cc][:, None, None, :]
            for n in range(len(rr)):
                y, x = rr[n] * CELL_H, cc[n] * CELL_W
                rgb[y:y + CELL_H, x:x + CELL_W] = px[n]
        frames.append(np.clip(rgb, 0, 255).astype(np.uint8).tobytes())
        print(f'\r  frame {t + 1}/{N}', end='', file=sys.stderr)
    print(file=sys.stderr)

    blob = b''.join(frames)
    for cmd in (webm, mp4):
        p = subprocess.run(cmd, input=blob)
        if p.returncode:
            sys.exit(f'ffmpeg failed: {cmd[-1]}')
    for f in ('rain.webm', 'rain.mp4'):
        p = os.path.join(OUTDIR, f)
        print(f'{f}: {os.path.getsize(p) / 1024:.0f} KiB')


if __name__ == '__main__':
    main()
