#!/usr/bin/env node
/*
 * boxsheet.js — the CP437 line/block joining test sheet.
 *
 * One place that knows what the sheet contains, used three ways:
 *   - tools/tests/boxjointest.js imports it, renders it through the real render
 *     stack, and MEASURES the joins.
 *   - run directly, it writes tools/out/boxsheet.ans — the same sheet as a
 *     plain CP437 byte stream, to look at in a terminal or upload to a board.
 *   - the CASES table below is the machine-checkable part: each case names a
 *     stroke that MUST be continuous, so a failure says which join broke
 *     rather than "the picture looks wrong".
 *
 * WHAT IT IS FOR
 * ==============
 * Box-drawing characters are the one part of a CP437 font where a glyph's
 * correctness depends on its NEIGHBOUR. A letterform that is a pixel narrow
 * looks fine; a `─` that is a pixel narrow leaves a hole in a table border, and
 * a `┌` whose arm stops early leaves a notch at every corner of every menu on
 * every BBS. Those are exactly the defects that do not show up in a
 * single-glyph test, so this sheet is built out of ADJACENCY: every junction
 * character sits between the strokes it has to meet.
 *
 * COVERAGE
 *   1. single-line, all 11 characters and all junctions
 *   2. double-line, all 11
 *   3. mixed single-vertical / double-horizontal (the ╒╤╕ ╞╪╡ ╘╧╛ family)
 *   4. mixed double-vertical / single-horizontal (the ╓╥╖ ╟╫╢ ╙╨╜ family)
 *   5. solid and half blocks — █ ▄ ▀ ▌ ▐ — as fills and as runs
 *   6. the three shades ░ ▒ ▓ as fills
 *
 * Sections 1-4 are the ones that catch corner misalignment; 5 catches gaps
 * between block characters; 6 catches the cell-boundary GUTTER.
 *
 * SECTION 6 USED TO SAY "by eye only, because a shade is periodic by design and
 * continuous is not what it should be". That was true of the measure it had —
 * the `solid` case, which fails on any background pixel — and false as a
 * conclusion, and the exemption is how a real defect shipped: every nine-wide
 * font in the repo drew ░ ▒ ▓ with a blank ninth column (IBM's 9-dot text mode
 * duplicates column 8 only for 0xC0-0xDF), so a run of them came out with a
 * one-pixel black gutter between every pair of cells. The eye that looked was
 * looking at the eight-wide AST, which has no ninth column and never had it.
 *
 * The measure that works on a dithered field is the `shade` case below: a
 * periodic field may have background anywhere, but ▒ and ▓ have ink in EVERY
 * column of their cell in every font here, so a fully blank device column in a
 * rendered run of them is the gutter and nothing else. ░ is deliberately not
 * asserted — its lattice legitimately leaves whole columns blank in an
 * eight-wide cell — and is covered instead by tools/tests/ttftest.js §9, which can
 * ask the sharper question of the glyph outline directly.
 *
 * CP437 code points, not Unicode. The renderer indexes glyphs by CP437 byte;
 * fonts/cp437.js maps those to Unicode for the outline path. Writing the sheet
 * in bytes keeps it in the same alphabet as everything it tests.
 *
 * SynthLink's own code, GPL-3.0-or-later.
 */

'use strict';

// ── CP437 bytes, named ──────────────────────────────────────────────────────
const S = {                                    // single line
  h: 0xC4, v: 0xB3,
  tl: 0xDA, tm: 0xC2, tr: 0xBF,
  ml: 0xC3, mm: 0xC5, mr: 0xB4,
  bl: 0xC0, bm: 0xC1, br: 0xD9,
};
const D = {                                    // double line
  h: 0xCD, v: 0xBA,
  tl: 0xC9, tm: 0xCB, tr: 0xBB,
  ml: 0xCC, mm: 0xCE, mr: 0xB9,
  bl: 0xC8, bm: 0xCA, br: 0xBC,
};
const SV = {                                   // single vertical, double horizontal
  h: 0xCD, v: 0xB3,
  tl: 0xD5, tm: 0xD1, tr: 0xB8,
  ml: 0xC6, mm: 0xD8, mr: 0xB5,
  bl: 0xD4, bm: 0xCF, br: 0xBE,
};
const DV = {                                   // double vertical, single horizontal
  h: 0xC4, v: 0xBA,
  tl: 0xD6, tm: 0xD2, tr: 0xB7,
  ml: 0xC7, mm: 0xD7, mr: 0xB6,
  bl: 0xD3, bm: 0xD0, br: 0xBD,
};

const BLOCK = 0xDB, LOWER = 0xDC, UPPER = 0xDF, LEFT = 0xDD, RIGHT = 0xDE;
const LIGHT = 0xB0, MEDIUM = 0xB1, DARK = 0xB2;
const SPACE = 0x20;

const COLS = 80, ROWS = 25;

/** A blank ROWS x COLS byte grid. */
function blank() {
  return Array.from({ length: ROWS }, () => new Array(COLS).fill(SPACE));
}

function put(g, r, c, byte) {
  if (r >= 0 && r < ROWS && c >= 0 && c < COLS) g[r][c] = byte;
}

/**
 * A 3-column-wide, 3-row-tall grid of boxes sharing every edge — which is what
 * puts each junction character between the four strokes it must meet.
 *
 * `w` is the interior width of one cell and `h` its interior height, so the
 * whole figure is 2w+3 wide. Interiors are left blank: this is about edges.
 */
function grid(g, row, col, set, w, h) {
  const xs = [col, col + w + 1, col + 2 * (w + 1)];
  const ys = [row, row + h + 1, row + 2 * (h + 1)];
  for (const y of ys) for (let i = 0; i < 2 * (w + 1) + 1; i++) put(g, y, col + i, set.h);
  for (const x of xs) for (let i = 0; i < 2 * (h + 1) + 1; i++) put(g, row + i, x, set.v);
  const corner = [[set.tl, set.tm, set.tr], [set.ml, set.mm, set.mr], [set.bl, set.bm, set.br]];
  ys.forEach((y, yi) => xs.forEach((x, xi) => put(g, y, x, corner[yi][xi])));
  return { xs, ys, w: 2 * (w + 1) + 1, h: 2 * (h + 1) + 1 };
}

function fill(g, row, col, w, h, byte) {
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) put(g, row + r, col + c, byte);
}

function text(g, row, col, str) {
  for (let i = 0; i < str.length; i++) put(g, row, col + i, str.charCodeAt(i) & 0xFF);
}

/**
 * Build the sheet.
 *
 * Returns { grid, cases }. `cases` is the machine-checkable part — see the
 * CASE SHAPES note below.
 *
 * CASE SHAPES
 *   { kind: 'hrun', row, col0, col1 }
 *       A horizontal stroke that must be continuous from the middle of the
 *       cell at col0 to the middle of the cell at col1. Corners are included
 *       at the ends deliberately: a corner's arm reaches the cell edge, so the
 *       run through it must not notch.
 *   { kind: 'vrun', col, row0, row1 }   the same, transposed.
 *   { kind: 'solid', row, col, w, h }
 *       A region that must be 100% foreground — no background pixel, and no
 *       partially-covered pixel either. Both failures are gaps; the second is
 *       the antialiased kind that comes from drawing a full-cell glyph with
 *       fillText instead of from the thresholded bitmap.
 *   { kind: 'shade', row, col, w, h, nineWide? }
 *       A region filled with ONE periodic shade character. Background is
 *       expected everywhere; what must not exist is a device column, or row,
 *       that is blank all the way across the region AND SITS ON A CELL
 *       BOUNDARY. That is the gutter — see the header — and it is the only
 *       thing this case looks for.
 *
 *       The boundary clause is load-bearing, not a tolerance. A blank column
 *       in the INTERIOR of a cell is the dither's own lattice failing to align
 *       with the device grid, which tiles perfectly and is invisible; a blank
 *       column at the seam is one cell's edge showing through. Counting both
 *       assumes the glyph inks every column of its cell, which is true of some
 *       faces and not others.
 *
 *       `nineWide` restricts a case to fonts whose ROM cell is nine columns.
 *       ░ needs it: at eight columns its lattice legitimately leaves whole
 *       columns blank and still tiles, because its period divides eight. At
 *       nine no shade period divides the cell, so a blank column there can only
 *       be a dislocation. The harness supplies the width — see `romCols` in
 *       boxjointest.js — because a font's ROM cell is not its registry cellW.
 */
function build() {
  const g = blank();
  const cases = [];

  // ── 1 & 2: single and double line grids, side by side ───────────────────
  text(g, 0, 0, 'SINGLE');
  const a = grid(g, 1, 0, S, 4, 2);
  text(g, 0, 20, 'DOUBLE');
  const b = grid(g, 1, 20, D, 4, 2);
  // ── 3 & 4: the two mixed families ───────────────────────────────────────
  text(g, 0, 40, 'S-V/D-H');
  const c = grid(g, 1, 40, SV, 4, 2);
  text(g, 0, 60, 'D-V/S-H');
  const d = grid(g, 1, 60, DV, 4, 2);

  // Every horizontal edge of every grid must be continuous corner to corner,
  // and every vertical edge likewise. That is 4 figures x 3 rows + 4 x 3 cols.
  for (const fig of [a, b, c, d]) {
    for (const y of fig.ys) {
      cases.push({ kind: 'hrun', row: y, col0: fig.xs[0], col1: fig.xs[2],
                   what: `horizontal edge at row ${y}` });
    }
    for (const x of fig.xs) {
      cases.push({ kind: 'vrun', col: x, row0: fig.ys[0], row1: fig.ys[2],
                   what: `vertical edge at col ${x}` });
    }
  }

  // ── A LONG run of each, to catch anything that accumulates ──────────────
  // 78 cells is wide enough that a per-cell rounding error of even a third of
  // a pixel has somewhere to show up.
  const longRows = [
    [10, S, 'single'], [11, D, 'double'], [12, SV, 'mixed s/d'], [13, DV, 'mixed d/s'],
  ];
  for (const [row, set, name] of longRows) {
    put(g, row, 0, set.ml);
    for (let x = 1; x < 78; x++) put(g, row, x, set.h);
    put(g, row, 78, set.mr);
    cases.push({ kind: 'hrun', row, col0: 0, col1: 78, what: `long ${name} horizontal` });
  }
  // ...and a long vertical, in the same spirit.
  for (const [i, [set, name]] of [[S, 'single'], [D, 'double']].entries()) {
    const col = 74 + i * 2;
    put(g, 15, col, set.tm);
    for (let y = 16; y < 24; y++) put(g, y, col, set.v);
    put(g, 24, col, set.bm);
    cases.push({ kind: 'vrun', col, row0: 15, row1: 24, what: `long ${name} vertical` });
  }

  // ── 5: blocks ───────────────────────────────────────────────────────────
  text(g, 15, 0, 'BLOCKS');
  fill(g, 16, 0, 10, 4, BLOCK);
  cases.push({ kind: 'solid', row: 16, col: 0, w: 10, h: 4, what: 'solid block fill' });

  // Half blocks, each as a run: ▄▄▄▄ must join into one unbroken bar, and so
  // must ▌▌▌▌ — the left half block is the one that tiles horizontally only if
  // its neighbour's cell starts exactly where its own ends.
  fill(g, 21, 0, 10, 1, LOWER);
  cases.push({ kind: 'hrun', row: 21, col0: 0, col1: 9, what: 'lower half-block run' });
  fill(g, 22, 0, 10, 1, UPPER);
  cases.push({ kind: 'hrun', row: 22, col0: 0, col1: 9, what: 'upper half-block run' });
  fill(g, 16, 12, 1, 8, LEFT);
  cases.push({ kind: 'vrun', col: 12, row0: 16, row1: 23, what: 'left half-block column' });
  fill(g, 16, 14, 1, 8, RIGHT);
  cases.push({ kind: 'vrun', col: 14, row0: 16, row1: 23, what: 'right half-block column' });
  // ▌ beside ▐ is a solid block made of two halves — it exposes any error in
  // where the cell boundary falls, which a single character cannot.
  for (let r = 16; r < 24; r++) { put(g, r, 16, RIGHT); put(g, r, 17, LEFT); }
  cases.push({ kind: 'solid', row: 16, col: 16, w: 2, h: 8,
               what: '▐▌ pair — one solid block spanning a cell boundary',
               inset: true });

  // ── 6: shades — the gutter cases. See the header for why ░ is not one. ──
  text(g, 15, 20, 'SHADES');
  fill(g, 16, 20, 8, 8, LIGHT);
  fill(g, 16, 29, 8, 8, MEDIUM);
  fill(g, 16, 38, 8, 8, DARK);
  // ░ is the LOW-density case, and it only makes sense on a nine-wide cell —
  // see `nineWide` in the CASE SHAPES note. It is here because it is the shade
  // that actually regressed: ░ is the one whose original outline starts a
  // column in from the cell edge, so it is the one carrying a non-zero hmtx
  // lsb, and re-drawing it to reach the edge without moving the lsb shifted
  // every ░ one design column right. ▒ and ▓ were clean throughout and this
  // sheet said everything was fine.
  cases.push({ kind: 'shade', row: 16, col: 20, w: 8, h: 8, nineWide: true,
               what: '░ light-shade fill (9-wide only) — no blank column at a cell boundary' });
  cases.push({ kind: 'shade', row: 16, col: 29, w: 8, h: 8,
               what: '▒ medium-shade fill — no blank column at a cell boundary' });
  cases.push({ kind: 'shade', row: 16, col: 38, w: 8, h: 8,
               what: '▓ dark-shade fill — no blank column at a cell boundary' });

  // A frame around the whole sheet would double as a 4-corner case, but the
  // grids above already cover every corner character; leaving the margin empty
  // keeps the PNGs easy to read.
  return { grid: g, cases, cols: COLS, rows: ROWS };
}

/** The sheet as raw CP437 bytes, CRLF-terminated — a file a DOS box can TYPE. */
function toANS(sheet) {
  const lines = sheet.grid.map((row) => {
    let end = row.length;
    while (end > 0 && row[end - 1] === SPACE) end--;         // trim trailing blanks
    return Buffer.from(row.slice(0, end));
  });
  return Buffer.concat(lines.flatMap((l) => [l, Buffer.from('\r\n', 'latin1')]));
}

module.exports = { build, toANS, COLS, ROWS, S, D, SV, DV };

if (require.main === module) {
  const fs = require('fs');
  const path = require('path');
  const out = path.join(__dirname, 'out');
  fs.mkdirSync(out, { recursive: true });
  const sheet = build();
  const file = path.join(out, 'boxsheet.ans');
  fs.writeFileSync(file, toANS(sheet));
  console.log(`wrote ${file}  (${sheet.cols}x${sheet.rows}, ${sheet.cases.length} checkable cases)`);
}
