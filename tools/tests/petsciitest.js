#!/usr/bin/env node
// PETSCII tables and the BESCII face — the assertions that can be made before
// anything is wired up.
//
// ttftest.js owns the outline-font invariants for every entry in the registry.
// This is its counterpart for a font and a charset that are NOT in the registry
// yet: fonts/petscii.js and tools/datasource/Bescii_PETSCII.ttf exist, nothing
// imports them, and PETSCII.md is the plan for the part that does. Everything
// here holds regardless of how that lands, so it is worth having now — a table
// with a wrong codepoint does not crash, it draws the wrong box-drawing
// character on a board nobody here can dial.
//
//   1. EVERY POSITION RESOLVES. All 192 printable positions of both sets must
//      name a codepoint the shipped file actually has a glyph for. This is the
//      same assertion ttftest section 1 makes about CP437, and the same reason:
//      a missing glyph is a .notdef box in the middle of somebody's art.
//
//   2. THE STRUCTURAL RULES HOLD. The shifted set must differ from the unshifted
//      one only where PETSCII says it does — the three letter runs and the
//      positions BESCII v1.2 defines a separate glyph for. A generator bug that
//      shifted a run by one would otherwise be invisible.
//
//   3. THE CONTROL RANGES ARE BLANK. 0x00-0x1F and 0x80-0x9F are PETSCII control
//      codes in both sets. If one of them ever resolves to a character, some
//      board's colour change is about to be drawn as a glyph.
//
//   4. THE CELL-ASPECT INVARIANT, for the entry PETSCII.md proposes. cellW *
//      (ascent + descent) == cellH * advance, read out of the FILE rather than
//      restated, so a re-minted asset that lost the aspect correction fails here
//      rather than presenting stretched.
//
//   5. lsb == xMin FOR EVERY GLYPH. FONTS.md 7.1. besciisubset.py scales X
//      uniformly precisely so this cannot break, which is the kind of claim that
//      should be checked rather than believed.
//
// Reading the .ttf needs no font library, for the reason ttftest gives: this
// parses the tables it needs directly and so cannot be fooled by a stale cache
// in some toolchain.
//
// No DOM, no sockets, instant. `node tools/tests/petsciitest.js`

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const TTF = path.join(ROOT, 'tools', 'datasource', 'Bescii_PETSCII.ttf');
const JS = path.join(ROOT, 'public', 'fonts', 'petscii.js');

// The design grid PETSCII.md proposes, and the measurement behind it is in
// tools/petscii-derive.js. Restated here because this harness is asserting that
// the FILE can carry it, which is a property of the file.
const CELL_W = 20, CELL_H = 24;

let pass = 0, fail = 0;
function eq(a, e, what) {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { pass++; return; }
  fail++;
  console.log(`  FAIL ${what}\n       expected ${E}\n       actual   ${A}`);
}
const ok = (cond, what) => eq(!!cond, true, what);

// ── A minimal SFNT reader: cmap format 4, hmtx, glyf/loca ───────────────────
function sfnt(buf) {
  const n = buf.readUInt16BE(4), t = {};
  for (let i = 0; i < n; i++) {
    const o = 12 + i * 16;
    t[buf.toString('latin1', o, o + 4)] =
      { off: buf.readUInt32BE(o + 8), len: buf.readUInt32BE(o + 12) };
  }
  return t;
}

function cmap4(buf, t) {
  const base = t.cmap.off, n = buf.readUInt16BE(base + 2);
  let sub = -1;
  for (let i = 0; i < n; i++) {
    const o = base + 4 + i * 8;
    const pid = buf.readUInt16BE(o), eid = buf.readUInt16BE(o + 2);
    if ((pid === 3 && eid === 1) || (pid === 0)) sub = base + buf.readUInt32BE(o + 4);
  }
  if (sub < 0) throw new Error('no unicode cmap subtable');
  if (buf.readUInt16BE(sub) !== 4) throw new Error('cmap subtable is not format 4');
  const segX2 = buf.readUInt16BE(sub + 6), seg = segX2 >> 1;
  const ends = sub + 14, starts = ends + segX2 + 2;
  const deltas = starts + segX2, ranges = deltas + segX2;
  const map = new Map();
  for (let s = 0; s < seg; s++) {
    const end = buf.readUInt16BE(ends + s * 2), start = buf.readUInt16BE(starts + s * 2);
    const delta = buf.readInt16BE(deltas + s * 2), ro = buf.readUInt16BE(ranges + s * 2);
    if (start === 0xFFFF) continue;
    for (let c = start; c <= end; c++) {
      let g;
      if (ro === 0) g = (c + delta) & 0xFFFF;
      else {
        const at = ranges + s * 2 + ro + (c - start) * 2;
        g = buf.readUInt16BE(at);
        if (g) g = (g + delta) & 0xFFFF;
      }
      if (g) map.set(c, g);
    }
  }
  return map;
}

// ── The tables, parsed out of the module rather than imported ───────────────
// fonts/petscii.js is an ES module in the browser tree; ttftest reads main.js
// the same way and for the same reason. Parsing by NAME means renaming an
// export throws here rather than testing a stale copy.
function table(src, name) {
  const m = src.match(
    new RegExp(`export const ${name} = new Uint16Array\\(\\[([\\s\\S]*?)\\]\\);`));
  if (!m) throw new Error(`${name} not found in petscii.js`);
  const vals = [...m[1].matchAll(/0x([0-9A-Fa-f]{4})/g)].map((x) => parseInt(x[1], 16));
  if (vals.length !== 256) throw new Error(`${name} has ${vals.length} entries, expected 256`);
  return vals;
}

const src = fs.readFileSync(JS, 'utf8');
const UC = table(src, 'PETSCII_UC_TO_UNICODE');
const LC = table(src, 'PETSCII_LC_TO_UNICODE');
const buf = fs.readFileSync(TTF);
const t = sfnt(buf);
const cmap = cmap4(buf, t);

console.log('PETSCII tables + BESCII face');

// ── 1. Every printable position resolves to a real glyph ────────────────────
{
  const missing = [];
  for (const [name, tbl] of [['unshifted', UC], ['shifted', LC]]) {
    for (let i = 0; i < 256; i++) {
      if (!tbl[i]) continue;
      if (!cmap.has(tbl[i])) missing.push(`${name} 0x${i.toString(16)} -> U+${tbl[i].toString(16)}`);
    }
  }
  eq(missing, [], '1. every printable position has a glyph in the shipped face');
  ok(UC.filter((v) => v).length === 192, '1. unshifted has 192 printable positions');
  ok(LC.filter((v) => v).length === 192, '1. shifted has 192 printable positions');
}

// ── 2. The shifted set differs only where PETSCII says it does ──────────────
{
  // The three letter runs, plus the positions BESCII v1.2 gives the shifted set
  // its own glyph for. Both halves are structural: the letter swap is what
  // "shifted" MEANS, and the override list is upstream's, not ours.
  const letters = new Set();
  for (let i = 0x41; i <= 0x5A; i++) letters.add(i);
  for (let i = 0x61; i <= 0x7A; i++) letters.add(i);
  for (let i = 0xC1; i <= 0xDA; i++) letters.add(i);
  const overrides = new Set([0x7E, 0x7F, 0xA9, 0xBA, 0xDE, 0xDF, 0xE9, 0xFA, 0xFF]);

  const unexpected = [];
  for (let i = 0; i < 256; i++) {
    if (UC[i] === LC[i]) continue;
    if (!letters.has(i) && !overrides.has(i)) unexpected.push('0x' + i.toString(16));
  }
  eq(unexpected, [], '2. the two sets differ only at the letter runs and the overrides');

  // and the letter runs are the swap they claim to be
  const bad = [];
  for (let i = 0x41; i <= 0x5A; i++) if (LC[i] !== i + 0x20) bad.push('0x' + i.toString(16));
  for (let i = 0x61; i <= 0x7A; i++) if (LC[i] !== i - 0x20) bad.push('0x' + i.toString(16));
  for (let i = 0xC1; i <= 0xDA; i++) if (LC[i] !== i - 0x80) bad.push('0x' + i.toString(16));
  eq(bad, [], '2. shifted letter positions are the case swap');

  // THE ALIASING RULE, in full and in both sets. sta.c64.org's PETSCII table:
  // "Codes $60-$7F and $E0-$FE are not used. Although you can print them, these
  // are, actually, copies of codes $C0-$DF and $A0-$BE." $FF copies $DE.
  //
  // So 0xC0-0xDF and 0xA0-0xBF are the CANONICAL positions and the other two
  // runs are echoes of them. Worth asserting rather than assuming: the table is
  // generated from a font's cmap, and a font that gave one of the copies its
  // own glyph would put a character on screen that no C64 can produce.
  const echoes = [];
  for (let i = 0x60; i <= 0x7F; i++) {
    if (UC[i] !== UC[i + 0x60] || LC[i] !== LC[i + 0x60]) echoes.push(`0x${i.toString(16)}`);
  }
  for (let i = 0xE0; i <= 0xFE; i++) {
    if (UC[i] !== UC[i - 0x40] || LC[i] !== LC[i - 0x40]) echoes.push(`0x${i.toString(16)}`);
  }
  eq(echoes, [], '2. 0x60-0x7F copies 0xC0-0xDF and 0xE0-0xFE copies 0xA0-0xBE');
  eq([UC[0xFF], LC[0xFF]], [UC[0xDE], LC[0xDE]], '2. 0xFF copies 0xDE');
}

// ── 3. The control ranges are blank in both sets ────────────────────────────
{
  const live = [];
  for (let i = 0; i < 256; i++) {
    const ctrl = i < 0x20 || (i >= 0x80 && i <= 0x9F);
    if (!ctrl) continue;
    if (UC[i] || LC[i]) live.push('0x' + i.toString(16));
  }
  eq(live, [], '3. 0x00-0x1F and 0x80-0x9F are blank in both sets');
  eq([UC[0xA0], LC[0xA0]], [0x00A0, 0x00A0], '3. 0xA0 is the shifted space');
}

// ── 4. The cell-aspect invariant, from the file ─────────────────────────────
{
  const head = t.head.off, hhea = t.hhea.off, hmtx = t.hmtx.off;
  const upem = buf.readUInt16BE(head + 18);
  const ascent = buf.readInt16BE(hhea + 4), descent = buf.readInt16BE(hhea + 6);
  const advance = buf.readUInt16BE(hmtx);            // first hMetric's advance
  eq(upem, 1280, '4. upem is the uniform-scaled 1280');
  eq([ascent, descent], [1344, -192], '4. vertical metrics are 7 and 1 source pixels');
  eq(CELL_W * (ascent - descent), CELL_H * advance,
    `4. cell-aspect invariant: ${CELL_W} x ${ascent - descent} == ${CELL_H} x ${advance}`);
  eq((ascent - descent) / advance, 1.2, '4. the cell presents at the C64 pixel aspect 1.2');
}

// ── 5. lsb == xMin for every glyph with contours ────────────────────────────
{
  const head = t.head.off, maxp = t.maxp.off, hhea = t.hhea.off;
  const longFmt = buf.readInt16BE(head + 50) === 1;
  const numGlyphs = buf.readUInt16BE(maxp + 4);
  const numH = buf.readUInt16BE(hhea + 34);
  const loca = t.loca.off, glyf = t.glyf.off, hmtx = t.hmtx.off;
  const at = (i) => (longFmt ? buf.readUInt32BE(loca + i * 4) : buf.readUInt16BE(loca + i * 2) * 2);
  const lsbOf = (i) => (i < numH ? buf.readInt16BE(hmtx + i * 4 + 2)
    : buf.readInt16BE(hmtx + numH * 4 + (i - numH) * 2));
  const bad = [];
  for (let g = 0; g < numGlyphs; g++) {
    const start = at(g), end = at(g + 1);
    if (end <= start) continue;                       // empty glyph, no xMin
    const xMin = buf.readInt16BE(glyf + start + 2);
    if (lsbOf(g) !== xMin) bad.push(`glyph ${g}: lsb ${lsbOf(g)} != xMin ${xMin}`);
  }
  eq(bad, [], '5. lsb == xMin for every glyph with contours');
}



// ── 6-11: the WIRED surface ─────────────────────────────────────────────────
//
// Sections 1-5 above hold whether or not any of this is plumbed in, which is
// why they were written first and why they stand alone. Everything below needs
// the registry, the charset descriptors, the dialect and a Terminal, all of
// which are ES modules — hence the async import, the same shape ttftest uses.
(async () => {
  const CS = await import('../../public/fonts/charsets.js');
  const IDX = await import('../../public/fonts/index.js');
  const PT = await import('../../public/petsciiterm.js');
  const TERM = await import('../../public/terminal.js');
  const P = await import('../../public/fonts/petscii.js');

  const { charsetOf, pagesOf, pageCount, CP437, PETSCII_UC, PETSCII_LC } = CS;
  const { FONTS, cycleFonts } = IDX;
  const { PETSCIIParser, C64_PALETTE, COLOUR_MAPS, canonicalByte,
          C64_START_ATTR, PAGE_UNSHIFTED, PAGE_SHIFTED } = PT;
  const { Terminal } = TERM;

  const font = FONTS.find((f) => f.id === 'petscii40');

  // ── 6. The registry entry ────────────────────────────────────────────────
  ok(!!font, '6. the registry carries petscii40');
  eq(font.uiName, 'PETSCII 40', '6. ...labelled PETSCII 40');
  eq(font.cols, 40, '6. ...at 40 columns, which is a C64 screen');
  eq([font.cellW, font.cellH], [CELL_W, CELL_H], '6. ...on the measured design grid');
  eq(font.hidden, true, '6. ...hidden: a board-specific font is not a typeface choice');
  // The Aa cycle is what `hidden` exists to keep it out of. Asserted against
  // the real cycle rather than against the flag, because the flag is only the
  // mechanism and this is the property.
  eq(cycleFonts().some((f) => f.id === 'petscii40'), false,
     '6. ...and is NOT in the Aa cycle');
  eq(font.emulation, 'petscii', '6. ...declares the PETSCII emulation');
  eq(font.palette, 'c64', '6. ...and the Commodore palette');

  // ── 7. Two charset pages, and one everywhere else ────────────────────────
  eq(pageCount(font), 2, '7. petscii40 has two charset pages');
  eq(pagesOf(font), [PETSCII_UC, PETSCII_LC],
     '7. ...unshifted first, which is the set a call opens on');
  eq(charsetOf(font) === PETSCII_UC, true,
     '7. charsetOf() resolves a multi-page font to page 0');
  // THE COMPATIBILITY PROPERTY, and it is the whole reason pages are safe:
  // every font that predates them has exactly one, and it is the one it always
  // had. A regression here is every other font quietly changing encoding.
  const multi = FONTS.filter((f) => pageCount(f) !== 1).map((f) => f.id);
  eq(multi, ['petscii40'], '7. ...and no other font has more than one page');
  for (const f of FONTS) {
    if (f.charset || f.charsets) continue;
    eq(pagesOf(f)[0] === CP437, true,
       `7. ${f.id}: declares nothing and so its single page IS CP437`);
  }
  // The two pages must genuinely differ on the question the atlas asks them,
  // or one descriptor would have done. 0x61 is a graphic unshifted and the
  // letter `a` shifted, which is the case that edge-extends a letter into its
  // neighbour if the wrong descriptor is used.
  eq([PETSCII_UC.isGraphics(0x62), PETSCII_LC.isGraphics(0x62)], [true, false],
     '7. the two pages disagree about 0x62 — graphics unshifted, a letter shifted');
  eq(PETSCII_UC.blank === PETSCII_LC.blank, true,
     '7. ...but share one blank policy: the control ranges are control in both');

  // ── 8. The echo fold ─────────────────────────────────────────────────────
  //
  // 0x60-0x7F and 0xE0-0xFE are COPIES of 0xC0-0xDF and 0xA0-0xBE, and 0xFF
  // copies 0xDE. The capture has eleven bytes in the first echo range, so this
  // is traffic rather than theory.
  //
  // The assertion that matters is not the arithmetic — it is that the fold
  // lands on a byte naming the SAME CHARACTER, in BOTH sets. A fold that were
  // off by one would still look like a fold.
  {
    const badU = [], badL = [];
    for (let b = 0; b < 256; b++) {
      const c = canonicalByte(b);
      if (P.PETSCII_UC_TO_UNICODE[c] !== P.PETSCII_UC_TO_UNICODE[b]) badU.push(b);
      if (P.PETSCII_LC_TO_UNICODE[c] !== P.PETSCII_LC_TO_UNICODE[b]) badL.push(b);
    }
    eq(badU, [], '8. the fold preserves the character in the unshifted set');
    eq(badL, [], '8. ...and in the shifted set');
  }
  // The canonical set is a set of FIXED POINTS: fold it and nothing moves.
  {
    const moved = [];
    for (const [lo, hi] of [[0x20, 0x5F], [0xA0, 0xBF], [0xC0, 0xDF]]) {
      for (let b = lo; b <= hi; b++) if (canonicalByte(b) !== b) moved.push(b);
    }
    eq(moved, [], '8. every byte of the canonical set folds to itself');
  }
  eq([canonicalByte(0x60), canonicalByte(0x7F), canonicalByte(0xE0),
      canonicalByte(0xFE), canonicalByte(0xFF)],
     [0xC0, 0xDF, 0xA0, 0xBE, 0xDE],
     '8. ...and both echo ranges land where sta.c64.org says they do');

  // ── 9. The palette ───────────────────────────────────────────────────────
  eq(C64_PALETTE.length, 16, '9. the Commodore palette has sixteen colours');
  eq(new Set(C64_PALETTE).size, 16, '9. ...all distinct');
  eq(C64_PALETTE.filter((c) => /^#[0-9A-F]{6}$/.test(c)).length, 16,
     '9. ...each a six-digit hex colour');
  // The twelve MEASURED off a SyncTERM screenshot of the target board, at the
  // attribute indices CTerm's own colour map puts them at. Pinned literally
  // because they are evidence rather than a choice: a palette edit that moved
  // one of these is a departure from what the board was authored against. The
  // other four (yellow, orange, brown, light red) do not appear on that screen
  // and are Colodore's own, so they are deliberately NOT asserted here.
  eq([C64_PALETTE[0], C64_PALETTE[1], C64_PALETTE[2], C64_PALETTE[3],
      C64_PALETTE[4], C64_PALETTE[5], C64_PALETTE[6], C64_PALETTE[11],
      C64_PALETTE[12], C64_PALETTE[13], C64_PALETTE[14], C64_PALETTE[15]],
     ['#000000', '#FFFFFF', '#813338', '#75CEC8', '#8E3C97', '#56AC4D',
      '#2E2C9B', '#4A4A4A', '#7B7B7B', '#A9FF9F', '#706DEB', '#B2B2B2'],
     '9. the twelve colours measured off the reference screenshot are exact');

  // ── 10. The colour maps ──────────────────────────────────────────────────
  const COLOUR_BYTES = [5, 28, 30, 31, 129, 144, 149, 150, 151, 152, 153, 154,
                        155, 156, 158, 159];
  eq(Object.keys(COLOUR_MAPS.c40).map(Number).sort((a, b) => a - b), COLOUR_BYTES,
     '10. the 40-column map names exactly the sixteen colour bytes');
  eq(Object.keys(COLOUR_MAPS.c80).map(Number).sort((a, b) => a - b), COLOUR_BYTES,
     '10. ...and so does the 80-column map');
  // THE TRAP THE C64's OWN TABLE INVITES. Written as the contiguous run
  // `0x95-0x9F` the colour set swallows 157 and 147, which are cursor-left and
  // clear-screen. A map that accepted either would eat a movement.
  eq([COLOUR_MAPS.c40[157], COLOUR_MAPS.c40[147], COLOUR_MAPS.c80[157]],
     [undefined, undefined, undefined],
     '10. 157 and 147 are NOT colours — they are cursor-left and clear');
  eq([COLOUR_MAPS.c40[5], COLOUR_MAPS.c40[28], COLOUR_MAPS.c40[159]], [1, 2, 3],
     '10. 40-column: white 1, red 2, cyan 3');
  eq([COLOUR_MAPS.c80[5], COLOUR_MAPS.c80[28], COLOUR_MAPS.c80[159]], [15, 4, 11],
     '10. 80-column: white 15, red 4, cyan 11');
  // The two must actually DIFFER. They are transcribed from adjacent tables in
  // one source file, which is exactly the shape a copy-paste error takes.
  eq(COLOUR_BYTES.some((b) => COLOUR_MAPS.c40[b] !== COLOUR_MAPS.c80[b]), true,
     '10. ...and the two maps are not copies of each other');
  eq(C64_START_ATTR, 15, '10. a Commodore mode starts on light grey, set explicitly');

  // ── 11. The dialect, against a real board ────────────────────────────────
  //
  // tools/datasource/wordbbs-petscii.bin is a SyncTERM Alt-C capture of a full
  // session on WORD BBS (wordbbs.hopto.org:64128) — connect to logoff, 4350
  // bytes, and NOT ONE ESC byte in it. It is the PETSCII counterpart of
  // bell103-capture.wav and it is here for the same reason: it is the only
  // thing that can fail on a wrong control code. A loopback cannot — feed this
  // parser its own output and any self-consistent dialect passes.
  //
  // What is asserted is the SCREEN, against the printed screenshot the capture
  // was taken beside. Deliberately not a round trip.
  const CAP = path.join(ROOT, 'tools', 'datasource', 'wordbbs-petscii.bin');
  if (!fs.existsSync(CAP)) {
    console.log('  SKIP 11: no capture at tools/datasource/wordbbs-petscii.bin');
  } else {
    const cap = fs.readFileSync(CAP);
    eq(cap.includes(0x1B), false,
       '11. the capture contains no ESC at all — a PETSCII board sends no ANSI');

    const t = new Terminal(40, 25);
    const p = new PETSCIIParser(t, { colours: 'c40' });
    // The pre-login screen, fed up to — and NOT including — the clear that wipes
    // it. The board clears three times in this session and the second one is
    // what ends this screen; feeding through it leaves 25 blank rows, which is
    // the terminal working correctly and asserting nothing.
    const clears = [];
    for (let i = 0; i < cap.length; i++) if (cap[i] === 0x93) clears.push(i);
    eq(clears.length >= 2, true, '11. the capture clears the screen at least twice');
    p.feed(cap.subarray(0, clears[1]));

    const line = (r) => {
      let s = '';
      for (let c = 0; c < 40; c++) {
        const cell = t.screen.get(c, r);
        const tbl = cell.page ? P.PETSCII_LC_TO_UNICODE : P.PETSCII_UC_TO_UNICODE;
        const cp = tbl[cell.ch];
        s += cp ? String.fromCharCode(cp) : ' ';
      }
      return s.trimEnd();
    };
    const screen = [];
    for (let r = 0; r < 25; r++) screen.push(line(r));

    // The three lines the screenshot shows, at the rows it shows them. Note the
    // MIXED CASE: the board sends 0x0E before them, so these bytes decode
    // through the SHIFTED table. Read through the unshifted one the same bytes
    // are `gET READY, ENTERING word bbs!` — which is what makes this a real
    // check of the page flag rather than of the tables alone.
    eq(screen.includes('Get ready, entering WORD BBS!'), true,
       '11. the pre-login screen decodes to the printed screenshot');
    eq(screen.includes('Press any key to continue...'), true,
       '11. ...including its second line');
    eq(screen.includes('(auto launch in 7 seconds)'), true,
       '11. ...and its third');

    // The page flag is what the mixed case rides on, so assert it directly.
    const row = screen.findIndex((l) => l === 'Get ready, entering WORD BBS!');
    eq(t.screen.get(0, row).page, PAGE_SHIFTED,
       '11. those cells are recorded on the shifted page');
    // Column 1 is the demonstrator, not column 0: the board sends 0xC7 for that
    // capital G, and 0xC7 is `G` in BOTH sets, so it proves nothing. 0x45 is
    // `E` unshifted and `e` shifted, which is the difference the page carries.
    eq(t.screen.get(1, row).ch, 0x45,
       '11. ...holding the RAW byte 0x45 for its second character');
    eq([P.PETSCII_UC_TO_UNICODE[0x45], P.PETSCII_LC_TO_UNICODE[0x45]], [0x45, 0x65],
       '11. ...which is `E` unshifted and `e` shifted — the page is what picks');

    // Reverse video is an attribute swap, not a glyph. It is the workhorse of
    // that board's art — 159 on and 158 off in one session.
    const t2 = new Terminal(40, 25);
    const p2 = new PETSCIIParser(t2, { colours: 'c40' });
    p2.feed(Uint8Array.from([0x9F]));                   // cyan
    eq([t2.fgColor, t2.bgColor], [3, 0], '11. a colour byte sets fg and leaves bg alone');
    p2.feed(Uint8Array.from([0x12]));                   // reverse on
    eq([t2.fgColor, t2.bgColor], [0, 3], '11. reverse swaps the pair — the C64 has no per-cell bg');
    p2.feed(Uint8Array.from([0x92]));                   // reverse off
    eq([t2.fgColor, t2.bgColor], [3, 0], '11. ...and swaps it back');
    // 0x0D clears reverse and 0x8D does not. CTerm's older source ran both
    // through one case whose comment said reverse was cleared while its body
    // did not; the current source splits them, and hardware agrees.
    p2.feed(Uint8Array.from([0x12, 0x0D]));
    eq(p2.reverse, false, '11. CR clears reverse');
    p2.feed(Uint8Array.from([0x12, 0x8D]));
    eq(p2.reverse, true, '11. ...and shift-CR does not');

    // The reserved bytes. 0x08 and 0x09 are both in the capture and both have
    // no handler, so they must be DROPPED — printed, they are garbage in the
    // middle of somebody's art.
    const t3 = new Terminal(40, 25);
    const p3 = new PETSCIIParser(t3, { colours: 'c40' });
    p3.feed(Uint8Array.from([0x08, 0x09, 0x80, 0x9A]));
    eq([t3.cx, t3.cy], [0, 0], '11. reserved control bytes draw nothing and move nothing');
    eq(cap.includes(0x08) && cap.includes(0x09), true,
       '11. ...and the capture proves they arrive in practice');
  }

  // ── 12. The send direction ───────────────────────────────────────────────
  //
  // CTerm's petscii_keys table, and the rule around it: a key NOT in the table
  // is sent raw and unchanged (raw_lo 0, raw_hi 256), with no case swapping.
  // This is the half that was missing when the font first went in, and the
  // symptom was Backspace PRINTING a character — see the note on Backspace in
  // petsciiterm.js.
  {
    const K = PT.petsciiNamedSeq;
    const b = (name) => { const s = K(name); return s == null ? s : s.charCodeAt(0); };

    eq([b('Backspace'), b('Delete')], [0x14, 0x14],
       '12. Backspace and Delete both send 0x14, PETSCII\'s destructive delete');
    // THE BUG THIS SLICE EXISTS FOR. 0x7F is the ANSI path's Backspace and is a
    // PRINTABLE character in PETSCII — it is outside both control ranges, folds
    // to 0xDF and draws a filled corner. A regression here is a board echoing
    // a glyph every time somebody corrects a typo.
    eq(K('Backspace') === '\x7F', false,
       '12. ...and NOT 0x7F, which PETSCII prints rather than acts on');
    eq(CS.PETSCII_UC.blank(0x7F), false,
       '12. ...0x7F really is printable in PETSCII, which is why it printed');

    eq(b('Insert'), 0x94, '12. Insert sends 0x94');
    eq(b('Home'), 0x13, '12. Home sends 0x13');
    eq(b('End'), 0x93, '12. End sends 0x93 — the C64\'s shifted HOME, which is CLR');
    eq([b('ArrowUp'), b('ArrowDown'), b('ArrowLeft'), b('ArrowRight')],
       [0x91, 0x11, 0x9D, 0x1D], '12. the four arrows send the four cursor bytes');
    eq(b('Enter'), 0x0D, '12. Enter sends 0x0D');
    eq(['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8'].map(b),
       [0x85, 0x89, 0x86, 0x8A, 0x87, 0x8B, 0x88, 0x8C],
       '12. F1-F8 send Table petscii_keys\'s own eight bytes, in ITS order');

    // A key a C64 does not have must send NOTHING. The ANSI answer is an escape
    // sequence; PETSCII drops the ESC and prints the remainder into the board's
    // input, so `ESC [ 5 ~` arrives as `[ 5 ~`. Silence is the correct answer
    // and null is how it is said.
    for (const n of ['PageUp', 'PageDown', 'F9', 'F10', 'F11', 'F12']) {
      eq(K(n), null, `12. ${n} sends nothing — a C64 keyboard has no such key`);
    }
    // Raw passthrough, named explicitly so the ANSI path's MODIFIED forms
    // cannot leak: Shift+Tab is `ESC [ Z` there.
    eq([b('Tab'), b('Escape')], [0x09, 0x1B],
       '12. Tab and Escape pass through raw, which is what CTerm does under 256');
    // The one deferral. IAC BRK is telnet and terminates at the server; it is
    // not a character in any encoding, so the dialect has no opinion.
    eq(K('Break'), undefined, '12. Break is deferred to the ANSI table — it is telnet');
    // Anything neither table knows is likewise not this dialect's business.
    eq(K('ScrollLock'), undefined, '12. an unknown key name is deferred, not swallowed');

    // EVERY name the ANSI path answers to must have an answer here, or it
    // leaks a sequence. Asserted against main.js's own tables rather than a
    // restatement, so a key added there fails HERE rather than on a board.
    const src = fs.readFileSync(path.join(ROOT, 'public', 'main.js'), 'utf8');
    const names = new Set();
    for (const decl of ['CSI_TILDE', 'SS3_FN', 'CSI_ARROW']) {
      const m = src.match(new RegExp(`const ${decl}\\s*=\\s*\\{([\\s\\S]*?)\\};`));
      ok(!!m, `12. main.js still declares ${decl}`);
      if (m) for (const k of m[1].matchAll(/([A-Za-z][A-Za-z0-9]*)\s*:/g)) names.add(k[1]);
    }
    // The four the switch handles by name, and Break, which is the deferral.
    for (const n of ['Tab', 'Enter', 'Escape', 'Backspace']) names.add(n);
    const leaks = [...names].filter((n) => K(n) === undefined);
    eq(leaks, [],
       '12. every named key the ANSI path answers has a PETSCII answer too'
       + ' — one without it puts an escape sequence on a C64 board');
    ok(names.size >= 20, `12. ...and that is ${names.size} names, read out of main.js`);
  }

  // ── 13. The letter map on send ───────────────────────────────────────────
  //
  // PETSCII does not put its letters where ASCII does. In the shifted set —
  // the one a board selects with 0x0E and the one nearly all of them run in —
  // 0x41-0x5A is LOWERCASE and 0xC1-0xDA is UPPERCASE. A C64 keyboard sends
  // 0x41 unshifted and 0xC1 shifted; a PC keyboard hands us ASCII. Sent raw,
  // every letter arrives one case out.
  {
    const enc = PT.petsciiEncodeByte;
    const chr = (c) => enc(c.charCodeAt(0));

    eq([chr('a'), chr('z')], [0x41, 0x5A], '13. a-z map to 0x41-0x5A');
    eq([chr('A'), chr('Z')], [0xC1, 0xDA], '13. A-Z map to 0xC1-0xDA');

    // THE PROPERTY, not the arithmetic: what the board DRAWS must match the key
    // that was pressed. Asserted through the shipped table for all 52 letters,
    // in the set a board actually runs in, so a wrong offset cannot pass.
    const badL = [], badU = [];
    for (let i = 0; i < 26; i++) {
      const lo = String.fromCharCode(0x61 + i), up = String.fromCharCode(0x41 + i);
      if (String.fromCharCode(P.PETSCII_LC_TO_UNICODE[chr(lo)]) !== lo) badL.push(lo);
      if (String.fromCharCode(P.PETSCII_LC_TO_UNICODE[chr(up)]) !== up) badU.push(up);
    }
    eq(badL, [], '13. every lowercase key DRAWS lowercase in the shifted set');
    eq(badU, [], '13. every uppercase key DRAWS uppercase in the shifted set');

    // And it is right in the OTHER set too, which is what makes it a mapping
    // rather than a guess — a real keyboard cannot see which set is in force
    // either. Unshifted: 0x41 is `A`, the only case that set has, and 0xC1 is
    // the spade, which is what SHIFT+A draws on a C64 in uppercase mode.
    eq(P.PETSCII_UC_TO_UNICODE[chr('a')], 0x41,
       '13. in the UNSHIFTED set a lowercase key still draws `A`');
    eq(P.PETSCII_UC_TO_UNICODE[chr('A')], 0x2660,
       '13. ...and a shifted one draws the spade, as SHIFT+A does on the machine');

    // Nothing else moves. PETSCII agrees with ASCII across the digits and
    // punctuation, so a map that touched them would break what already worked.
    const moved = [];
    for (let b = 0; b < 256; b++) {
      const isLetter = (b >= 0x41 && b <= 0x5A) || (b >= 0x61 && b <= 0x7A);
      if (!isLetter && enc(b) !== b) moved.push(b);
    }
    eq(moved, [], '13. no byte outside the two letter runs is touched');
    eq(Array.from(PT.petsciiEncode('Hi 42!')),
       [0xC8, 0x49, 0x20, 0x34, 0x32, 0x21],
       '13. petsciiEncode over a string: letters mapped, the rest verbatim');
  }

  // ── 14. ...and it is WIRED, which is a different claim ───────────────────
  //
  // Section 13 proves the map in isolation. The bug it fixes was in neither the
  // map nor the keyboard but in the byte path between them, and it hit the
  // physical keyboard, the on-screen keyboard and the paste box alike — because
  // all three arrive at modemWrite(). That is what is driven here, extracted by
  // name from main.js so a rename throws rather than testing a stale copy.
  {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'main.js'), 'utf8');
    const at = src.indexOf('function modemWrite(');
    ok(at >= 0, '14. main.js still declares modemWrite()');
    let depth = 0, end = -1;
    for (let j = src.indexOf('{', src.indexOf(')', at)); j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}' && --depth === 0) { end = j + 1; break; }
    }
    const body = src.slice(at, end);

    const make = (font) => {
      const sent = [];
      const env = {
        carrier: true, dialing: false, linkMode: 'direct', txBytes: 0,
        activeFont: font,
        atInput: () => { throw new Error('atInput reached with a carrier up'); },
        ws: { readyState: 1, send: (buf) => sent.push([...new Uint8Array(buf)]) },
        WebSocket: { OPEN: 1 },
        petsciiEncode: PT.petsciiEncode,
      };
      const fn = new Function('env', [
        'const { carrier, dialing, linkMode, activeFont, atInput, ws, WebSocket,'
        + ' petsciiEncode } = env;',
        'let txBytes = env.txBytes;',
        body,
        'return modemWrite;',
      ].join('\n'))(env);
      return { sent, fn };
    };

    // ANSI board: unchanged, byte for byte. This is the regression guard — the
    // encoder must be unreachable from every font that predates PETSCII.
    {
      const { sent, fn } = make({ id: 'astpx8x19' });
      fn('aA');
      eq(sent, [[0x61, 0x41]], '14. an ANSI board still gets raw ASCII');
    }
    // PETSCII board: text is encoded.
    {
      const { sent, fn } = make({ id: 'petscii40', emulation: 'petscii' });
      fn('aA');
      eq(sent, [[0x41, 0xC1]], '14. a PETSCII board gets the C64 keyboard\'s bytes');
    }
    // A Uint8Array is BYTES and must go out untouched. Two callers depend on
    // this and both mean it: a menu-key click sends the cell's own byte, and
    // Alt+numpad is somebody naming a byte by its number. Encoding either would
    // silently corrupt it.
    {
      const { sent, fn } = make({ id: 'petscii40', emulation: 'petscii' });
      fn(Uint8Array.of(0x61, 0x41));
      eq(sent, [[0x61, 0x41]], '14. a raw Uint8Array is NOT encoded, on any font');
    }
    // The two raw-byte callers really do pass a Uint8Array. Read out of main.js
    // rather than asserted about: one of them was a string until this landed.
    ok(/modemWrite\(Uint8Array\.of\(key\)\)/.test(src),
       '14. the menu-key click passes raw bytes');
    ok(/modemWrite\(Uint8Array\.of\(r\.byte\)\)/.test(src),
       '14. Alt+numpad code entry passes raw bytes');
    // And the AT command line is above the encoder, so it stays ASCII.
    ok(body.indexOf('atInput') < body.indexOf('petsciiEncode'),
       '14. the !carrier branch runs BEFORE the encoder — the AT line is ours');
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
