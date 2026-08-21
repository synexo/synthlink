#!/usr/bin/env node
// Font registry + 9x14 glyph-data checks. Pure arithmetic over the shipped
// modules — no DOM, no sockets, no browser. `node tools/fonttest.js`.
//
// Why this exists: the 9x14 font is the first 9-pixel-wide font in the repo, so
// it is the first one whose glyph rows do not fit in a byte. That introduced a
// per-font stride, and a stride is exactly the kind of thing that can be wrong
// in a way which still *renders* — off-by-one interleaving produces plausible
// garbage, not an exception. So the glyphs are asserted against known bitmaps
// rather than merely against a length.
//
// It also pins the things that make 40-column mode worth having at all: the
// column count riding on the font, the geometry that keeps the terminal 1.56x
// tall instead of 2x, and the measured ink metrics the DEVLOG asks for.
//
// fonts/index.js is an ES module and this harness is CommonJS like its
// neighbours, hence the dynamic import.

let pass = 0, fail = 0;
function eq(a, e, what) {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { pass++; return; }
  fail++;
  console.log(`  FAIL ${what}\n       expected ${E}\n       actual   ${A}`);
}
function ok(cond, what) { eq(!!cond, true, what); }

// Render one glyph as an array of '#'/'.' strings, straight from the shipped
// bytes — deliberately a second, independent implementation of the unpacking in
// buildFontSheet(), so a bug in one does not hide in the other.
function glyphRows(font, code) {
  const stride = (font.cellW + 7) >> 3;
  const base = code * font.cellH * stride;
  const rows = [];
  for (let r = 0; r < font.cellH; r++) {
    let bits = 0;
    for (let b = 0; b < stride; b++) bits = (bits << 8) | font.glyphs[base + r * stride + b];
    const msb = stride * 8 - 1;
    let s = '';
    for (let c = 0; c < font.cellW; c++) s += ((bits >> (msb - c)) & 1) ? '#' : '.';
    rows.push(s);
  }
  return rows;
}
const inkRows = (rows) => rows.filter((r) => r.includes('#')).length;

(async () => {
  const F = await import('../public/fonts/index.js');
  const { FONTS, CYCLE_FONTS, DEFAULT_FONT_ID, fontById, fontCols, fontStride,
          mobileDefaultFont } = F;

  console.log('fonttest — font registry + 9x14 glyph data\n');

  // ── Registry invariants ──────────────────────────────────────────────────
  for (const f of FONTS) {
    eq(f.glyphs.length, 256 * f.cellH * fontStride(f), `${f.id}: glyph array is 256 x cellH x stride`);
    ok(f.cellW > 0 && f.cellH > 0, `${f.id}: has cell metrics`);
  }
  eq(FONTS.filter((f) => fontStride(f) === 2).map((f) => f.id), ['vga9x14'],
     'only the 9-wide font has a 2-byte stride');
  eq(FONTS.filter((f) => fontCols(f) !== 80).map((f) => f.id), ['vga9x14'],
     '40-column mode is reachable through exactly one font');

  const f9 = fontById('vga9x14');
  eq([f9.cellW, f9.cellH, fontCols(f9)], [9, 14, 40], '9x14 is 9x14 at 40 columns');

  // Never a default, on any screen — the whole point of it being cycle-only.
  ok(DEFAULT_FONT_ID !== 'vga9x14', '9x14 is not the desktop default');
  ok(mobileDefaultFont().id !== 'vga9x14', '9x14 is not the mobile default');
  ok(!f9.mobileDefault, '9x14 carries no mobileDefault flag');
  ok(CYCLE_FONTS.some((f) => f.id === 'vga9x14'), 'but it IS in the Aa cycle');

  // ── Geometry: the reason the font and the column count are paired ────────
  // Terminal height at a fixed width W is W * (rows*cellH)/(cols*cellW).
  const h = (font) => (25 * font.cellH) / (fontCols(font) * font.cellW);
  const base = h(fontById('vga8x16'));                        // 400/640 = 0.625
  eq([fontCols(f9) * f9.cellW, 25 * f9.cellH], [360, 350], '40x25 at 9x14 is a 360x350 canvas');
  eq(Math.round(h(f9) / base * 1000) / 1000, 1.556, '...which is 1.556x the height of 80x25 at 8x16');
  // The counterfactual that rules out reusing an 8-wide font at 40 columns.
  const eight = fontById('vga8x16');
  eq(Math.round(((25 * eight.cellH) / (40 * eight.cellW)) / base * 1000) / 1000, 2,
     'an 8x16 font at 40 columns would be exactly 2x — why it was not reused');

  // ── Glyph data ───────────────────────────────────────────────────────────
  // 'A', verbatim from the source FNT. If the column re-interleaving were
  // wrong this is where it shows: the two byte-columns would swap or shear.
  eq(glyphRows(f9, 0x41), [
    '.........', '.........', '...#.....', '..###....', '.##.##...',
    '##...##..', '##...##..', '#######..', '##...##..', '##...##..',
    '##...##..', '.........', '.........', '.........',
  ], "9x14 'A' matches the source bitmap");

  // Pixel 8 lives alone in the second byte, so anything that reaches column 8
  // proves the high byte is being read at all. 0xDB (full block) is all 9 wide.
  eq(glyphRows(f9, 0xDB), Array(14).fill('#########'), '0xDB fills all NINE columns');
  ok(glyphRows(f9, 0x41).every((r) => r[8] === '.'), "'A' leaves column 8 clear");

  // Ink metrics the DEVLOG asks for, against the 8x16 baseline of cap 10 / x 7.
  eq(inkRows(glyphRows(f9, 0x41)), 9, '9x14 cap height is 9 rows');
  eq(inkRows(glyphRows(f9, 0x78)), 6, '9x14 x-height is 6 rows');
  eq(inkRows(glyphRows(fontById('vga8x16'), 0x41)), 10, '8x16 cap height is 10 rows (baseline)');
  eq(inkRows(glyphRows(fontById('vga8x16'), 0x78)), 7, '8x16 x-height is 7 rows (baseline)');
  // Raw ink is smaller, but the cell renders 1.78x larger at 40 columns, so on
  // screen the cap height goes 10 -> ~16 units. That product is the real claim.
  const scale = (fontCols(fontById('vga8x16')) * 8) / (fontCols(f9) * f9.cellW);   // 640/360
  ok(inkRows(glyphRows(f9, 0x41)) * scale > 15.5, 'on-screen cap height beats the 8x16 baseline of 10');

  // Even cell height ⇒ the two-phase shades keep their phase across the cell
  // boundary. This is the check that ruled out the 8x19 PRC19 font.
  eq(f9.cellH % 2, 0, 'cell height is even, so 0xB0/0xB1 do not band vertically');
  for (const c of [0xB0, 0xB1]) {
    const rows = glyphRows(f9, c);
    eq(rows[0], rows[2], `0x${c.toString(16).toUpperCase()}: row 0 and row 2 are in phase`);
    eq(rows[13], rows[1], `0x${c.toString(16).toUpperCase()}: last row continues into row 1`);
  }
  // 0xB2 must be a checkerboard, not PRC19's diagonal.
  ok(glyphRows(f9, 0xB2)[0] !== glyphRows(f9, 0xB2)[1], '0xB2 alternates by row (checkerboard)');

  // ── The 9-dot rule, asserted rather than assumed ─────────────────────────
  // Real VGA duplicates column 7 into column 8 only for 0xC0-0xDF. That is what
  // makes box-drawing join across cells, and it is why the shades DON'T tile.
  const dup = (c) => glyphRows(f9, c).every((r) => r[8] === r[7]);
  ok(dup(0xC4), '0xC4 (horizontal line) duplicates column 7 — joins across cells');
  ok(dup(0xDB), '0xDB (full block) duplicates column 7');
  ok(dup(0xCD), '0xCD (double horizontal) duplicates column 7');
  for (const c of [0xB0, 0xB1, 0xB2]) {
    ok(glyphRows(f9, c).every((r) => r[8] === '.'),
       `0x${c.toString(16).toUpperCase()} has a blank 9th column (known, deliberate — see the font header)`);
  }
  // 0xB3/0xDA meet in the same columns, so a box actually closes.
  const vbar = glyphRows(f9, 0xB3)[0].indexOf('#');
  eq(glyphRows(f9, 0xDA)[8].indexOf('#'), vbar, '0xDA drops its vertical in the same column as 0xB3');

  // ── The sheet builder agrees with the reference unpacking above ──────────
  // buildFontSheet needs a DOM (OffscreenCanvas), so instead of running it we
  // assert the property it depends on: every font's stride is derivable from
  // cellW alone, which is the assumption the builder makes.
  for (const f of FONTS) eq(fontStride(f), Math.ceil(f.cellW / 8), `${f.id}: stride follows from cellW`);

  console.log(`\n${fail ? 'FAILED' : 'OK'} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
