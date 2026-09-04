#!/usr/bin/env node
// Outline (TTF) font path — FONTS.md's parallel assertions.
//
// fonttest.js owns the bitmap invariants and skips `kind: 'ttf'` entries,
// because an outline font has no glyph bytes to assert against. This is its
// counterpart. It checks the things that can be wrong about an outline entry
// without anything throwing:
//
//   1. THE CP437 TABLE. Every one of its 256 entries must resolve to a real
//      glyph in the shipped file. A wrong entry does not crash — it draws the
//      wrong character, and it will be a box-drawing character nobody inspects
//      closely.
//
//   2. THE CELL-ASPECT INVARIANT, which arrived with the second outline font
//      and is the one that silently ruins a new entry. For a TTF the registry's
//      cellW/cellH are not pixels; they state the cell's ASPECT and the
//      resolution deriveOutlineBitmap() rasterizes at. layout() sizes the atlas
//      cell from cellH/cellW while outlineMetrics() typesets into a cell of
//      (ascent + descent)/advance — so unless those two ratios are equal, every
//      glyph overflows or underfills its cell by exactly the discrepancy. It is
//      also what stops a variant being declared at another variant's grid,
//      which would present it stretched. Asserted for every outline font.
//
// Reading the woff2 needs no font library: this parses the SFNT tables it needs
// directly, which also means the harness cannot be fooled by a stale cache in
// some toolchain. woff2's table data is brotli-compressed as a block, so the
// .ttf in tools/datasource is the file parsed for metrics, and the .woff2 is
// checked for identity against it by way of the registry.
//
// No DOM, no sockets, instant. `node tools/tests/ttftest.js`

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function eq(a, e, what) {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { pass++; return; }
  fail++;
  console.log(`  FAIL ${what}\n       expected ${E}\n       actual   ${A}`);
}
function ok(cond, what) { eq(!!cond, true, what); }

// ── A minimal SFNT reader: just the tables this harness needs ───────────────
function sfnt(buf) {
  const numTables = buf.readUInt16BE(4);
  const tables = {};
  for (let i = 0; i < numTables; i++) {
    const o = 12 + i * 16;
    tables[buf.toString('latin1', o, o + 4)] =
      { off: buf.readUInt32BE(o + 8), len: buf.readUInt32BE(o + 12) };
  }
  return tables;
}

function readMetrics(buf) {
  const t = sfnt(buf);
  const head = t.head.off, hhea = t.hhea.off, hmtx = t.hmtx.off;
  return {
    indexToLoc: buf.readInt16BE(head + 50),
    // The LEFT SIDE BEARINGS, interleaved with the advances in hmtx. hmtx
    // carries lsb independently of glyf's xMin, and a rasterizer may position a
    // glyph by the lsb phantom point — so when the two disagree the outline
    // moves by the difference, silently. §10 asserts they agree.
    lsbs: Array.from({ length: buf.readUInt16BE(hhea + 34) },
                     (_, i) => buf.readInt16BE(hmtx + i * 4 + 2)),
    numGlyphs: buf.readUInt16BE(t.maxp.off + 4),
    tables: t,
  };
}

/**
 * Decode every simple glyph's outline points: { x, y, onCurve }.
 *
 * Enough of the `glyf` format to rasterize and to read an xMin, and no more —
 * composites are reported as null rather than resolved, because neither font
 * here has any and a half-implemented composite would compare equal for the
 * wrong reason. Deliberately a second, independent implementation of nothing:
 * no other code in the repo reads glyf, so this has nothing to agree with by
 * accident.
 */
function readOutlines(buf) {
  const t = sfnt(buf);
  const m = readMetrics(buf);
  const n = m.numGlyphs;
  const longLoca = m.indexToLoc === 1;
  const loca = [];
  for (let i = 0; i <= n; i++) {
    loca.push(longLoca ? buf.readUInt32BE(t.loca.off + i * 4)
                       : buf.readUInt16BE(t.loca.off + i * 2) * 2);
  }

  const out = [];
  for (let g = 0; g < n; g++) {
    if (loca[g] === loca[g + 1]) { out.push([]); continue; }   // no outline
    let p = t.glyf.off + loca[g];
    const nc = buf.readInt16BE(p); p += 10;                    // + xMin..yMax
    if (nc < 0) { out.push(null); continue; }                  // composite
    const ends = [];
    for (let i = 0; i < nc; i++) { ends.push(buf.readUInt16BE(p)); p += 2; }
    const nPts = nc ? ends[nc - 1] + 1 : 0;
    p += 2 + buf.readUInt16BE(p);                             // skip instructions

    const flags = [];
    while (flags.length < nPts) {
      const f = buf.readUInt8(p++);
      flags.push(f);
      if (f & 8) { let r = buf.readUInt8(p++); while (r-- > 0) flags.push(f); }
    }
    const readAxis = (shortBit, sameBit) => {
      const v = []; let acc = 0;
      for (let i = 0; i < nPts; i++) {
        const f = flags[i];
        if (f & shortBit) {
          const d = buf.readUInt8(p++);
          acc += (f & sameBit) ? d : -d;
        } else if (!(f & sameBit)) {
          acc += buf.readInt16BE(p); p += 2;
        }
        v.push(acc);
      }
      return v;
    };
    const xs = readAxis(2, 16);
    const ys = readAxis(4, 32);
    // `ends` rides along on the point list for §9, which needs the CONTOUR
    // boundaries to rasterize. A property on the array rather than a second
    // return shape, so every existing caller is untouched.
    const pts = xs.map((x, i) => ({ x, y: ys[i], onCurve: !!(flags[i] & 1) }));
    pts.ends = ends;
    out.push(pts);
  }
  return out;
}

/** Every Unicode codepoint the font's cmap covers (formats 4 and 12). */
function cmapCoverage(buf) {
  const t = sfnt(buf);
  const base = t.cmap.off;
  const n = buf.readUInt16BE(base + 2);
  const covered = new Set();
  for (let i = 0; i < n; i++) {
    const rec = base + 4 + i * 8;
    const sub = base + buf.readUInt32BE(rec + 4);
    const fmt = buf.readUInt16BE(sub);
    if (fmt === 4) {
      const segX2 = buf.readUInt16BE(sub + 6), seg = segX2 / 2;
      const endO = sub + 14, startO = endO + segX2 + 2;
      for (let s = 0; s < seg; s++) {
        const end = buf.readUInt16BE(endO + s * 2);
        const start = buf.readUInt16BE(startO + s * 2);
        if (start === 0xFFFF) continue;
        for (let c = start; c <= end && c !== 0x10000; c++) covered.add(c);
      }
    } else if (fmt === 12) {
      const groups = buf.readUInt32BE(sub + 12);
      for (let g = 0; g < groups; g++) {
        const o = sub + 16 + g * 12;
        const start = buf.readUInt32BE(o), end = buf.readUInt32BE(o + 4);
        for (let c = start; c <= end; c++) covered.add(c);
      }
    }
  }
  return covered;
}

/**
 * codepoint -> glyph id, from the same two cmap formats cmapCoverage reads.
 *
 * cmapCoverage answers "is it there"; the shade check below needs "which glyph
 * is it", and resolving that by glyph NAME would go through `post`, which is
 * not guaranteed to carry names at all. Separate function rather than a flag on
 * cmapCoverage so that coverage keeps its one job.
 */
function cmapLookup(buf) {
  const t = sfnt(buf);
  const base = t.cmap.off;
  const n = buf.readUInt16BE(base + 2);
  const map = new Map();
  for (let i = 0; i < n; i++) {
    const rec = base + 4 + i * 8;
    const sub = base + buf.readUInt32BE(rec + 4);
    const fmt = buf.readUInt16BE(sub);
    if (fmt === 4) {
      const segX2 = buf.readUInt16BE(sub + 6), seg = segX2 / 2;
      const endO = sub + 14, startO = endO + segX2 + 2;
      const deltaO = startO + segX2, rangeO = deltaO + segX2;
      for (let s = 0; s < seg; s++) {
        const end = buf.readUInt16BE(endO + s * 2);
        const start = buf.readUInt16BE(startO + s * 2);
        const delta = buf.readInt16BE(deltaO + s * 2);
        const ro = buf.readUInt16BE(rangeO + s * 2);
        if (start === 0xFFFF) continue;
        for (let c = start; c <= end && c !== 0x10000; c++) {
          let g;
          if (ro === 0) g = (c + delta) & 0xFFFF;
          else {
            g = buf.readUInt16BE(rangeO + s * 2 + ro + (c - start) * 2);
            if (g) g = (g + delta) & 0xFFFF;
          }
          if (g) map.set(c, g);
        }
      }
    } else if (fmt === 12) {
      const groups = buf.readUInt32BE(sub + 12);
      for (let g = 0; g < groups; g++) {
        const o = sub + 16 + g * 12;
        const start = buf.readUInt32BE(o), end = buf.readUInt32BE(o + 4);
        const first = buf.readUInt32BE(o + 8);
        for (let c = start; c <= end; c++) map.set(c, first + (c - start));
      }
    }
  }
  return map;
}

/**
 * Rasterize a glyph onto its font's ROM PIXEL grid: `rows` x `cols` booleans.
 *
 * Even-odd crossing count at each pixel's CENTRE. That is enough because every
 * font on this path is a pixel trace — axis-aligned polygons on whole-pixel
 * boundaries — so a centre sample is exact rather than approximate, and it does
 * not care whether the tracer emitted one rectangle per pixel, per run, or one
 * L-shaped contour per region. (An earlier version of this assumed rectangles
 * and was wrong about the AST's ▓, which is merged into larger polygons.)
 *
 * Off-curve points would make it approximate, so they are refused instead.
 *
 * The grid is the font's own ROM cell — 9x14, 9x16, 8x19 — NOT the registry's
 * cellW/cellH, which for an outline entry state an aspect and a rasterization
 * resolution and are 27x64 on flexi135. See PIXEL_CELL.
 */
function pixelGrid(points, advance, ascent, descent, cols, rows) {
  if (!points || !points.ends || !points.length) return null;
  if (!points.every((p) => p.onCurve)) return null;
  const colw = advance / cols, rowh = (ascent + descent) / rows;
  const contours = [];
  let start = 0;
  for (const end of points.ends) { contours.push(points.slice(start, end + 1)); start = end + 1; }

  const grid = Array.from({ length: rows }, () => new Array(cols).fill(false));
  for (let r = 0; r < rows; r++) {
    const y = ascent - (r + 0.5) * rowh;
    for (let c = 0; c < cols; c++) {
      const x = (c + 0.5) * colw;
      let crossings = 0;
      for (const ring of contours) {
        for (let i = 0; i < ring.length; i++) {
          const a = ring[i], b = ring[(i + 1) % ring.length];
          if ((a.y > y) === (b.y > y)) continue;
          if (x < a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x)) crossings++;
        }
      }
      grid[r][c] = (crossings & 1) === 1;
    }
  }
  return grid;
}

const DATA = (f) => path.join(__dirname, '..', 'datasource', f);
const SHIP = (f) => path.join(__dirname, '..', '..', 'public', f);

// Registry id -> the source .ttf in tools/datasource it was minted from. The
// map is here rather than in the registry because it is a BUILD fact: nothing
// at runtime should be able to reach a source asset, and the shipped woff2 is
// the only file the browser ever sees.
const SOURCE = {
  flexi160:  'Flexi_IBM_VGA_False_A160_437.ttf',
  flexi135:  'Flexi_IBM_VGA_True_437.ttf',
  astpx8x19: 'Px437_AST_PremiumExec.ttf',
  vga9x14px: 'Px437_IBM_VGA_9x14.ttf',
  topaz1200: 'Topaz_a1200_Latin1.ttf',
};

// Registry id -> the font's own ROM cell in PIXELS, [cols, rows].
//
// Not the same thing as the registry's cellW/cellH, and the difference is the
// trap: for an outline entry those two state the cell ASPECT and the resolution
// deriveOutlineBitmap() rasterizes at, which on flexi135 is 27x64 for a face
// whose ROM cell is 9x16. §9 has to work on the ROM grid — "the ninth column"
// is only a thing there — so the real cell is recorded here, and asserted below
// against the file's own cell height.
const PIXEL_CELL = {
  flexi160:  [9, 16],
  flexi135:  [9, 16],
  astpx8x19: [8, 19],
  vga9x14px: [9, 14],
};

(async () => {
  const F = await import('../../public/fonts/index.js');
  const C = await import('../../public/fonts/cp437.js');
  const L = await import('../../public/fonts/latin1.js');
  const CS = await import('../../public/fonts/charsets.js');
  const { FONTS, isTTF } = F;
  const { CP437_TO_UNICODE } = C;
  const { LATIN1_TO_UNICODE } = L;
  const { charsetOf, CP437, LATIN1 } = CS;

  console.log('ttftest — outline font path\n');

  const outlines = FONTS.filter(isTTF);

  // ── 1. The CP437 table ───────────────────────────────────────────────────
  eq(CP437_TO_UNICODE.length, 256, 'the CP437 table has 256 entries');
  eq(new Set(CP437_TO_UNICODE).size, 256, '...and is a bijection onto 256 DISTINCT codepoints');

  // ASCII is identity, checked as the property rather than as a second copy.
  for (let i = 0; i < 128; i++) {
    if (CP437_TO_UNICODE[i] !== i) {
      fail++; console.log(`  FAIL CP437 0x${i.toString(16)}: ASCII range must be identity`);
      break;
    }
  }
  pass++;

  // ── 1b. The Latin-1 table, and the charset default ───────────────────────
  //
  // Same three properties as CP437's, re-derived here rather than trusted:
  // Latin-1 IS the identity map, so the table can be checked against
  // arithmetic instead of against a second transcription of itself.
  eq(LATIN1_TO_UNICODE.length, 256, 'the Latin-1 table has 256 entries');
  eq(new Set(LATIN1_TO_UNICODE).size, 256, '...and is a bijection onto 256 DISTINCT codepoints');
  {
    // The ONE position that is not the identity, and why it must not be. 0xAD
    // is U+00AD SOFT HYPHEN, which a text shaper draws as nothing at all — the
    // glyph exists in the file and fillText still produces an empty cell. It
    // maps to U+2010 HYPHEN, and the shipped face carries a cmap entry for that
    // codepoint pointing at the same glyph. Delete this and byte 0xAD goes
    // blank on every Amiga board, looking like a missing glyph.
    const off = [];
    for (let i = 0; i < 256; i++) if (LATIN1_TO_UNICODE[i] !== i) off.push(i);
    eq(off, [0xAD], 'Latin-1 is the identity map at every position but 0xAD');
    eq(LATIN1_TO_UNICODE[0xAD], 0x2010,
       '0xAD maps to U+2010 HYPHEN — U+00AD is invisible to every shaper');
  }

  // THE DEFAULT, which is the whole reason this feature cannot reach anything
  // that shipped before it. A registry entry with no `charset` resolves to
  // CP437 — whose members are the constants the code used when CP437 was the
  // only encoding — so the rasterizer is handed byte-for-byte what it always
  // was. If this ever fails, an existing font has silently changed encoding.
  for (const f of FONTS) {
    const named = f.charset ? f.charset.id : '(none)';
    eq(charsetOf(f) === (f.charset || CP437), true,
       `${f.id}: resolves to its declared charset ${named}, defaulting to CP437`);
  }
  eq(FONTS.filter((f) => f.charset && f.charset !== LATIN1).length, 0,
     'no font names a charset other than Latin-1 — CP437 fonts declare nothing');
  eq(CP437.chars === C.CP437_CHARS, true, 'the CP437 descriptor IS cp437.js\'s table');
  eq([CP437.isGraphics(0xAF), CP437.isGraphics(0xB0),
      CP437.isGraphics(0xDF), CP437.isGraphics(0xE0)], [false, true, true, false],
     'the CP437 descriptor\'s graphics range is still 0xB0-0xDF');
  eq([CP437.blank(0x00), CP437.blank(0xFF), CP437.blank(0x7F), CP437.blank(0x41)],
     [true, true, false, false],
     'the CP437 descriptor blanks NUL and NBSP, and nothing else');

  // ── 2. Per-font: coverage, the woff2 tie, and the cell-aspect invariant ──
  // Everything in this loop must hold for EVERY outline entry. A font added
  // later gets all of it for free; the only per-font work is one line in
  // SOURCE above.
  const parsed = {};
  for (const f of outlines) {
    const src = SOURCE[f.id];
    ok(!!src, `${f.id}: has a source .ttf recorded in SOURCE`);
    if (!src) continue;

    const buf = fs.readFileSync(DATA(src));
    const m = readMetrics(buf);
    parsed[f.id] = { buf, m };

    // THE CELL-ASPECT INVARIANT (§2 in the header). Exact integer arithmetic,
    // not a tolerance: cellW * (ascent + descent) === cellH * advance is the
    // same statement as cellH/cellW === (ascent + descent)/advance with no
    // rounding to argue about.
    eq(f.cellW * (f.ascent + f.descent), f.cellH * f.advance,
       `${f.id}: cellH/cellW == (ascent+descent)/advance — atlas cell and typeset cell agree`);

    // Coverage: nothing falls through to .notdef. Asserted against the font's
    // OWN charset, which for every CP437 entry is the same 256 codepoints this
    // always checked. The blanks are skipped because they are drawn by nobody:
    // the atlas builder never calls fillText for them, so a missing glyph there
    // is not a defect (CP437 skips NUL and NBSP, Latin-1 the C0/C1 ranges and
    // DEL — and DEL is a real absence in Topaz, recorded in fonts/latin1.js).
    const cs = charsetOf(f);
    const covered = cmapCoverage(buf);
    const missing = [];
    for (let i = 0; i < 256; i++) {
      if (cs.blank(i)) continue;
      if (!covered.has(cs.chars[i].codePointAt(0))) missing.push(i);
    }
    eq(missing, [],
       `${f.id}: every drawn codepoint of ${cs.id} resolves to a real glyph`);

    // The woff2 must actually be the same font, not a stale build. woff2
    // header: 0 signature, 4 flavor, 8 length, 12 numTables, 16 totalSfntSize.
    // totalSfntSize is the size the font decompresses back to, so it is the
    // field that ties the shipped woff2 to the ttf beside it — a stale woff2
    // left behind after the source was replaced would disagree.
    const w = fs.readFileSync(SHIP(f.file));
    eq(w.readUInt32BE(16), buf.length,
       `${f.id}: woff2 totalSfntSize matches the source ttf — it was built from THIS file`);
  }

  // The family string is the browser's key for a loaded FontFace, so two
  // entries sharing one would collide in document.fonts and one would silently
  // win — which for a pair of aspect variants is a wrong-shaped terminal with
  // nothing in the console. This is the assertion that makes that impossible.
  eq(new Set(outlines.map((f) => f.family)).size, outlines.length,
     'every outline font declares a DISTINCT family — no collision in document.fonts');
  eq(new Set(outlines.map((f) => f.file)).size, outlines.length,
     '...and points at a distinct file');

  // ── 9. THE SHADES TILE. 0xB0-0xB2, on every NINE-wide outline ────────────
  //
  // These three are the only glyphs in CP437 whose job is to be invisible at
  // the cell boundary: a run of them must read as one texture. In a nine-dot
  // font they did not, and it was in the DATA, not the renderer — IBM's 9-dot
  // text mode duplicates column 8 into the ninth dot only for 0xC0-0xDF, so a
  // faithful nine-wide font draws the shades with a blank ninth column and a
  // run of them comes out gutterred. tools/shadefix.py re-pitches them; this is
  // what says it worked, and what stops a future font asset re-introducing it.
  //
  // WHY IT IS HERE AND NOT IN boxjointest. That harness fails on a background
  // run crossing a cell boundary, which is exactly wrong for a dithered field —
  // background crossing the boundary is what a checkerboard DOES. Its shade
  // section was therefore marked "by eye only", and the eye that looked was
  // looking at the eight-wide AST, which never had the defect. A structural
  // check on the glyph is the right instrument: the gutter is a COLUMN WITH NO
  // INK IN IT, and that is a property of one glyph, statable exactly.
  //
  // TWO MEASURES, because one does not fit both cell widths.
  //
  // (a) NO BLANK RUN IS CREATED BY THE JOIN. Take the fully-blank columns of
  //     the cell; the longest RUN of them must not get longer when the cell is
  //     laid beside a copy of itself. This is the one that is true of every
  //     shade in every font: the eight-wide AST's ░ legitimately has six blank
  //     columns in runs of three, and still tiles, because its period-4 lattice
  //     divides eight. It is also what catches the nine-wide ░, whose blank
  //     column 0 and blank column 8 become a two-wide black gutter at the join.
  //
  // (b) ON A NINE-WIDE CELL, NO BLANK COLUMN AT ALL. Stronger, and it applies
  //     only there — but it is derived, not arbitrary. The periods a shade
  //     lattice can use are 2 and 4; neither divides 9, so on a nine-wide cell
  //     an empty column cannot be part of a tiling lattice. It is a dislocation
  //     by construction, and one column of solid black against a 50% field is
  //     the most visible form the defect takes. (b) is what the old ▒ and ▓
  //     fail — their single blank ninth column passes (a), because its
  //     neighbour across the join carries ink.
  //
  // The eight-wide AST is a CONTROL here rather than an exemption: it runs (a)
  // and passes, which is what says (a) is measuring tiling and not just width.
  {
    const SHADES = { 0xB0: '░ light', 0xB1: '▒ medium', 0xB2: '▓ dark' };
    const longestRun = (flags, wrap) => {
      const n = flags.length;
      let best = 0, run = 0;
      for (let i = 0; i < (wrap ? 2 * n : n); i++) {
        run = flags[i % n] ? run + 1 : 0;
        if (run > best) best = run;
      }
      return Math.min(best, n);
    };

    // CP437 fonts only, and that is a scope statement rather than an exemption:
    // 0xB0-0xB2 are the shades in CP437 and `°±²` in Latin-1, so on a font that
    // is not on CP437 this section would be measuring the tiling of three
    // punctuation marks. Nothing here is skipped for a CP437 face.
    for (const f of outlines.filter((f) => charsetOf(f) === CP437)) {
      ok(!!PIXEL_CELL[f.id], `${f.id}: has a ROM pixel cell recorded in PIXEL_CELL`);
      const [cols, rows] = PIXEL_CELL[f.id];
      // The recorded cell must agree with the file, or §9 measures a grid the
      // font does not have and every assertion below is vacuous. Only the ROWS
      // are asserted to divide exactly: flexi160's columns are 88.89 units
      // wide, because fontaspect.py narrowed a 900-unit advance by 8/9 and 800
      // is not nine whole anything. The rasterizer samples centres and does not
      // care; a whole-number check here would only be asserting that no font
      // was ever aspect-scaled.
      eq((f.ascent + f.descent) % rows, 0,
         `${f.id}: the ROM cell's ${rows} rows divide the file's cell height exactly`);

      const { buf } = parsed[f.id];
      const lookup = cmapLookup(buf);
      const outs = readOutlines(buf);
      const density = {};
      for (const [code, label] of Object.entries(SHADES)) {
        const gid = lookup.get(CP437_TO_UNICODE[code]);
        const grid = pixelGrid(outs[gid], f.advance, f.ascent, f.descent, cols, rows);
        ok(!!grid, `${f.id} ${label}: rasterizes on the ${cols}x${rows} ROM grid`);
        if (!grid) continue;

        const colInk = Array.from({ length: cols },
          (_, c) => grid.reduce((n, row) => n + (row[c] ? 1 : 0), 0));
        const blank = colInk.map((n) => n === 0);

        // (a)
        eq(longestRun(blank, true), longestRun(blank, false),
           `${f.id} ${label}: laying the cell beside itself creates no longer blank run`);
        // (b)
        if (cols === 9) {
          ok(Math.min(...colInk) > 0,
             `${f.id} ${label}: no blank column — on a nine-wide cell that is a gutter,`
             + ` since no shade period divides 9`);
        }

        // A blank ROW is the same defect turned ninety degrees. Cell heights
        // here are even, so it has never bitten, and this is the guard.
        const rowInk = grid.map((row) => row.reduce((n, on) => n + (on ? 1 : 0), 0));
        ok(Math.min(...rowInk) > 0, `${f.id} ${label}: no blank row`);
        ok(Math.max(...rowInk) - Math.min(...rowInk) <= 1,
           `${f.id} ${label}: row ink is even to within one column (no horizontal banding)`);

        density[code] = rowInk.reduce((a, b) => a + b, 0) / (cols * rows);
      }
      // The three must stay a ladder, or they stop being light/medium/dark.
      ok(density[0xB0] < density[0xB1] && density[0xB1] < density[0xB2],
         `${f.id}: ░ < ▒ < ▓ — the shades are still a monotonic ladder`);
      ok(Math.abs(density[0xB1] - 0.5) < 1e-9,
         `${f.id}: ▒ is exactly 50% — the shade used for fills and borders`);
    }
  }

  // ── 10. hmtx lsb agrees with glyf xMin, on every glyph ───────────────────
  //
  // These two say the same thing twice, and nothing forces them to agree. A
  // rasterizer is entitled to position a glyph by the lsb phantom point, so
  // when they disagree the outline is drawn shifted by the difference — with
  // no error, no missing glyph, and nothing obviously wrong on screen.
  //
  // THIS IS NOT HYPOTHETICAL. It is the bug that survived the first pass of the
  // shade re-pitch: ░ is the one shade whose original outline starts a column
  // in from the cell edge, so it is the one that ships with a non-zero lsb, and
  // re-drawing it to reach the edge without updating hmtx moved every ░ one
  // design column right and pushed its last column out of the cell. ▒ and ▓
  // start at 0 either way and looked perfect throughout. What it presented as
  // was a black gutter down one side of ░ and nothing else — "just one glyph".
  //
  // Asserted over the WHOLE font rather than the three shades, because the
  // property is not about shades: any future glyph edit can do this, and the
  // check costs nothing.
  {
    for (const f of outlines) {
      const { buf, m } = parsed[f.id];
      const outs = readOutlines(buf);
      const bad = [];
      for (let g = 0; g < outs.length && g < m.lsbs.length; g++) {
        const pts = outs[g];
        if (!pts || !pts.length) continue;              // blank or composite
        const xMin = Math.min(...pts.map((p) => p.x));
        if (m.lsbs[g] !== xMin) bad.push(`gid ${g}: lsb ${m.lsbs[g]} vs xMin ${xMin}`);
      }
      eq(bad.slice(0, 4), [],
         `${f.id}: every glyph's hmtx lsb equals its glyf xMin`
         + ` (${bad.length} disagree) — a mismatch SHIFTS the glyph in the cell`);
    }
  }

  console.log(`\n${fail ? 'FAILED' : 'OK'} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
