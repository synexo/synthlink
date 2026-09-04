#!/usr/bin/env node
// Font registry + 9x14 glyph-data checks. Pure arithmetic over the shipped
// modules — no DOM, no sockets, no browser. `node tools/tests/fonttest.js`.
//
// Why this exists: the 9x14 font is the first 9-pixel-wide font in the repo, so
// it is the first one whose glyph rows do not fit in a byte. That introduced a
// per-font stride, and a stride is exactly the kind of thing that can be wrong
// in a way which still *renders* — off-by-one interleaving produces plausible
// garbage, not an exception. So the glyphs are asserted against known bitmaps
// rather than merely against a length.
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

(async () => {
  const F = await import('../../public/fonts/index.js');
  const { FONTS, fontById, fontStride, isTTF } = F;

  console.log('fonttest — font registry + 9x14 glyph data\n');

  // Everything in this file is about GLYPH BYTES — strides, bitmaps, ink rows.
  // An outline font has none of those: its glyphs are curves in a file, and
  // fontStride() throws for it rather than inventing a number. So the bitmap
  // invariants below run over the bitmap fonts, and the outline entries get
  // their own parallel assertions in tools/tests/ttftest.js.
  const BITMAP = FONTS.filter((f) => !isTTF(f));

  // ── Registry invariants ──────────────────────────────────────────────────
  for (const f of BITMAP) {
    eq(f.glyphs.length, 256 * f.cellH * fontStride(f), `${f.id}: glyph array is 256 x cellH x stride`);
  }
  // The guard that stops an outline entry being read as bytes. A stride of 1
  // returned here would index into `undefined` and render plausible garbage,
  // so it must throw rather than answer.
  for (const f of FONTS.filter(isTTF)) {
    let threw = false;
    try { fontStride(f); } catch (_) { threw = true; }
    ok(threw, `${f.id}: fontStride() refuses an outline font instead of guessing`);
    ok(f.glyphs === undefined, `${f.id}: carries no glyph array at all`);
  }

  // The twin must be the same bytes, not a copy — otherwise the A/B it exists
  // for compares two typefaces rather than two render paths.
  ok(fontById('vga9x14').glyphs === fontById('vga9x14hr').glyphs,
     'the hybrid 9x14 shares the legacy one\'s glyph array object');

  const f9 = fontById('vga9x14');

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

  // Even cell height ⇒ the two-phase shades keep their phase across the cell
  // boundary. This is the check that ruled out the 8x19 PRC19 font.
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

  console.log(`\n${fail ? 'FAILED' : 'OK'} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
