#!/usr/bin/env node
// ATASCII — the Atari 8-bit board font, its tables, its dialect and a real board.
//
//   1. THE TABLES. The low half is CTerm's atascii_ext_table at literal
//      positions; the high half draws private-use inverse glyphs and COPIES as
//      the low half, except EOL.
//   2. THE FACE. Read out of tools/datasource/Atari_ATASCII.ttf with no font
//      library: every glyph is sampled on the 8x8 source grid, the high half
//      must be the exact inversion of the low half, and a few cells are held
//      to their literal Atari bitmaps. A round trip cannot see a wrong glyph;
//      a literal can.
//   3. THE BOX. atascii40 presents in the same box as petscii40 — the owner's
//      requirement, asserted as numbers rather than trusted.
//   4. THE CONTROL CODES, each against CTerm's cterm_atascii.c.
//   5. ESC MODE, including CTerm's screen-code translation.
//   6. THE SEND DIRECTION.
//   7. A REAL BOARD. tools/datasource/nebbs-atascii.bin is the ATASCII tail of
//      a SyncTERM Alt-C capture (NE BBS, nebbs.servehttp.com:9223), decoded to
//      its screens. It is the only thing here that can fail on a wrong control
//      code rather than on a disagreement with ourselves.
//
// No DOM, no sockets. `node tools/tests/atasciitest.js`

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const TTF = path.join(ROOT, 'tools', 'datasource', 'Atari_ATASCII.ttf');
const CAP = path.join(ROOT, 'tools', 'datasource', 'nebbs-atascii.bin');

let pass = 0, fail = 0;
function eq(a, e, what) {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { pass++; return; }
  fail++;
  console.log(`  FAIL ${what}\n       expected ${E}\n       actual   ${A}`);
}
const ok = (cond, what) => eq(!!cond, true, what);

// ── A minimal SFNT reader: cmap 4 + 12, hmtx, glyf/loca ─────────────────────
function tables(buf) {
  const n = buf.readUInt16BE(4), t = {};
  for (let i = 0; i < n; i++) {
    const o = 12 + i * 16;
    t[buf.toString('latin1', o, o + 4)] = { off: buf.readUInt32BE(o + 8), len: buf.readUInt32BE(o + 12) };
  }
  return t;
}

function cmap(buf, t) {
  const base = t.cmap.off, n = buf.readUInt16BE(base + 2), map = new Map();
  for (let i = 0; i < n; i++) {
    const sub = base + buf.readUInt32BE(base + 4 + i * 8 + 4);
    const fmt = buf.readUInt16BE(sub);
    if (fmt === 4) {
      const segX2 = buf.readUInt16BE(sub + 6), seg = segX2 / 2;
      const ends = sub + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2;
      for (let s = 0; s < seg; s++) {
        const end = buf.readUInt16BE(ends + s * 2), start = buf.readUInt16BE(starts + s * 2);
        const delta = buf.readInt16BE(deltas + s * 2), ro = buf.readUInt16BE(ranges + s * 2);
        for (let c = start; c <= end && c !== 0xFFFF; c++) {
          let g;
          if (ro === 0) g = (c + delta) & 0xFFFF;
          else {
            g = buf.readUInt16BE(ranges + s * 2 + ro + (c - start) * 2);
            if (g) g = (g + delta) & 0xFFFF;
          }
          if (g) map.set(c, g);
        }
      }
    } else if (fmt === 12) {
      const groups = buf.readUInt32BE(sub + 12);
      for (let gI = 0; gI < groups; gI++) {
        const o = sub + 16 + gI * 12;
        const s = buf.readUInt32BE(o), e = buf.readUInt32BE(o + 4), g0 = buf.readUInt32BE(o + 8);
        for (let c = s; c <= e; c++) map.set(c, g0 + (c - s));
      }
    }
  }
  return map;
}

function contours(buf, t, gid) {
  const longLoca = buf.readInt16BE(t.head.off + 50) === 1;
  const at = (i) => longLoca ? buf.readUInt32BE(t.loca.off + i * 4) : buf.readUInt16BE(t.loca.off + i * 2) * 2;
  const s = at(gid), e = at(gid + 1);
  if (s === e) return { pts: [], curves: false };
  const g = t.glyf.off + s;
  const n = buf.readInt16BE(g);
  if (n < 0) throw new Error(`glyph ${gid} is composite`);
  const endPts = []; for (let i = 0; i < n; i++) endPts.push(buf.readUInt16BE(g + 10 + i * 2));
  const count = endPts[n - 1] + 1;
  let p = g + 10 + n * 2; p += 2 + buf.readUInt16BE(p);
  const flags = [];
  while (flags.length < count) {
    const f = buf[p++]; flags.push(f);
    if (f & 8) { const r = buf[p++]; for (let k = 0; k < r; k++) flags.push(f); }
  }
  const read = (short, same) => {
    const out = []; let v = 0;
    for (const f of flags) {
      if (f & short) { const d = buf[p++]; v += (f & same) ? d : -d; }
      else if (!(f & same)) { v += buf.readInt16BE(p); p += 2; }
      out.push(v);
    }
    return out;
  };
  const xs = read(2, 16), ys = read(4, 32);
  const pts = []; let st = 0;
  for (const en of endPts) { pts.push(xs.slice(st, en + 1).map((x, i) => [x, ys[st + i]])); st = en + 1; }
  return { pts, curves: flags.some((f) => !(f & 1)) };
}

// Nonzero winding at a point, straight edges only.
function inside(polys, x, y) {
  let w = 0;
  for (const poly of polys) {
    for (let i = 0; i < poly.length; i++) {
      const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % poly.length];
      if (y0 <= y) { if (y1 > y && (x1 - x0) * (y - y0) - (x - x0) * (y1 - y0) > 0) w++; }
      else if (y1 <= y && (x1 - x0) * (y - y0) - (x - x0) * (y1 - y0) < 0) w--;
    }
  }
  return w !== 0;
}

const PX = 300, PY = 400, TOP = 2800;
function bitmap(polys) {
  const rows = [];
  for (let r = 0; r < 8; r++) {
    let b = 0;
    for (let c = 0; c < 8; c++) if (inside(polys, c * PX + PX / 2, TOP - r * PY - PY / 2)) b |= 0x80 >> c;
    rows.push(b);
  }
  return rows;
}

(async () => {
  const A = await import('../../public/fonts/atascii.js');
  const CS = await import('../../public/fonts/charsets.js');
  const F = await import('../../public/fonts/index.js');
  const T = await import('../../public/terminal.js');
  const X = await import('../../public/atasciiterm.js');

  // ── 1. Tables ─────────────────────────────────────────────────────────────
  const D = A.ATASCII_DRAW, TX = A.ATASCII_TEXT;
  eq([D[0x00], D[0x01], D[0x14], D[0x1B], D[0x1C], D[0x60], D[0x7B], D[0x7C], D[0x7D], D[0x7E], D[0x7F]],
     [0x2665, 0x251C, 0x2022, 0x241B, 0x2191, 0x2666, 0x2660, 0x2502, 0x1F8B0, 0x25C0, 0x25B6],
     '1. the low half carries CTerm\'s codepoints at their literal positions');
  eq([D[0x20], D[0x41], D[0x7A]], [0x20, 0x41, 0x7A], '1. ...and ASCII where ATASCII is ASCII');
  eq(D.slice(0x80).every((c, i) => c === 0xE080 + i), true, '1. byte b >= 0x80 draws U+E000 + b');
  eq(TX.slice(0x80).every((c, i) => c === (i + 0x80 === 0x9B ? 0xA0 : D[i])), true,
     '1. the high half copies as the low half, and EOL as NO-BREAK SPACE');
  eq(new Set(D).size, 256, '1. 256 distinct drawn codepoints — one per atlas cell');
  eq(A.ATASCII_DRAW_CHARS.every((s, i) => s.codePointAt(0) === D[i] && [...s].length === 1), true,
     '1. each drawn character is one codepoint, astral ones included');
  const cs = CS.ATASCII;
  eq([cs.blank(0x20), cs.blank(0xA0), cs.blank(0x00), cs.blank(0x9B)], [true, false, false, false],
     '1. only the space is blank; its inverse is a full cell');
  eq([cs.isGraphics(0x12), cs.isGraphics(0x14), cs.isGraphics(0x41), cs.isGraphics(0xC1), cs.isGraphics(0x7C)],
     [true, false, false, true, true], '1. box pieces and every inverse cell meet their neighbours; the disc does not');
  eq(CS.textOf(cs), A.ATASCII_TEXT_CHARS, '1. a selection copies through the text table');
  eq(CS.textOf(CS.CP437), CS.CP437.chars, '1. ...and a charset without one copies through its chars, as before');

  // ── 2. The face ───────────────────────────────────────────────────────────
  const buf = fs.readFileSync(TTF);
  const t = tables(buf);
  const map = cmap(buf, t);
  eq(buf.readUInt16BE(t.head.off + 18), 2400, '2. upem 2400');
  const cells = [];
  let curves = false, missing = [];
  for (let b = 0; b < 256; b++) {
    const gid = map.get(D[b]);
    if (!gid) { missing.push(b); cells.push(null); continue; }
    const c = contours(buf, t, gid);
    curves = curves || c.curves;
    cells.push(bitmap(c.pts));
  }
  eq(missing, [], '2. every byte\'s drawn codepoint is in the file');
  eq(curves, false, '2. every outline is straight lines — a pixel tracing');
  eq(cells.slice(0x80).every((rows, i) => rows && rows.every((r, k) => r === (0xFF ^ cells[i][k]))), true,
     '2. every high-half cell is the exact inversion of its low-half twin');
  const hex = (rows) => rows.map((r) => r.toString(16).padStart(2, '0')).join('');
  // Literal Atari cells, rows top to bottom.
  eq(hex(cells[0x00]), '00367f7f3e1c0800', '2. 0x00 is the heart');
  eq(hex(cells[0x14]), '00003c7e7e7e3c00', '2. 0x14 is the six-wide disc, not upstream\'s bullet');
  eq(hex(cells[0x41]), '00183c66667e6600', '2. 0x41 is the Atari A');
  eq(hex(cells[0x20]), '0000000000000000', '2. 0x20 is empty');
  eq(hex(cells[0xA0]), 'ffffffffffffffff', '2. 0xA0 is a full cell');
  eq(hex(cells[0x12]), '000000ffff000000', '2. 0x12 is the two-row horizontal line');
  eq(hex(cells[0x02]), '0303030303030303', '2. 0x02 is the right-edge bar (U+1FB87, aliased)');

  // ── 3. The box ────────────────────────────────────────────────────────────
  const at = F.fontById('atascii40'), pet = F.fontById('petscii40');
  eq([at.cellW, at.cellH, F.fontCols(at)], [pet.cellW, pet.cellH, F.fontCols(pet)],
     '3. atascii40 has petscii40\'s cell and columns — the same 960x800 box at 40x25');
  eq([at.hidden, at.charset === CS.ATASCII, at.emulation, at.palette], [true, true, 'atascii', 'atari'],
     '3. a hidden board font carrying the charset, the emulation and the palette');
  eq(at.cellW * (at.ascent + at.descent), at.cellH * at.advance, '3. cell-aspect invariant');
  eq((at.cellW * at.ascent) % at.advance, 0, '3. the baseline lands on a whole pixel');
  eq(X.ATARI_PALETTE.length, 16, '3. the palette has sixteen entries');
  eq([X.ATARI_PALETTE[0], X.ATARI_PALETTE[1], X.ATARI_PALETTE[7], X.ATARI_PALETTE[15]],
     ['#005181', '#60B7E7', '#60B7E7', '#60B7E7'],
     '3. index 0 is the dark blue screen and every other index the light blue ink');

  // ── 4. Control codes ──────────────────────────────────────────────────────
  const mk = () => { const tm = new T.Terminal(40, 25); const p = new X.ATASCIIParser(tm); p.enter(); return { tm, p }; };
  const put = (p, s) => p.feed(Uint8Array.from(s, (c) => c.charCodeAt(0)));
  const row = (tm, r) => { let s = ''; for (let c = 0; c < tm.cols; c++) s += String.fromCharCode(tm.screen.get(c, r).ch); return s.trimEnd(); };
  {
    const { tm, p } = mk();
    eq([tm.fgColor, tm.bgColor], [7, 0], '4. entering ATASCII puts attribute 7 up');
    p.feed([0x1C]); eq([tm.cx, tm.cy], [0, 24], '4. 0x1C up wraps to the bottom of the same column');
    p.feed([0x1D]); eq([tm.cx, tm.cy], [0, 0], '4. 0x1D down wraps to the top');
    p.feed([0x1E]); eq([tm.cx, tm.cy], [39, 0], '4. 0x1E left wraps to the right of the same row');
    p.feed([0x1F]); eq([tm.cx, tm.cy], [0, 0], '4. 0x1F right wraps to the left of the same row');
    tm.cy = 24; p.feed([0x1D]); eq(tm.cy, 0, '4. down at the bottom does not scroll');
    put(p, 'AB'); p.feed([0x7E]);
    eq([row(tm, 0), tm.cx], ['A', 1], '4. 0x7E erases left');
    p.feed([0x7E, 0x7E, 0x7E]); eq(tm.cx, 0, '4. ...and sticks at the margin');
    put(p, 'X'); p.feed([0x7F]); eq(tm.cx, 8, '4. 0x7F tabs to the next default stop');
    tm.cx = 33; p.feed([0x7F]); eq([tm.cx, tm.cy], [0, 1], '4. ...and past the last stop to column 0 of the next row');
    tm.cx = 5; p.feed([0x9F]); tm.cx = 1; p.feed([0x7F]); eq(tm.cx, 5, '4. 0x9F sets a stop at the cursor');
    tm.cx = 8; p.feed([0x9E]); tm.cx = 6; p.feed([0x7F]); eq(tm.cx, 16, '4. 0x9E clears the stop at the cursor');
    tm.cx = 7; tm.cy = 24; p.feed([0x9B]); eq([tm.cx, tm.cy], [0, 24], '4. 0x9B at the bottom returns and scrolls');
    eq(row(tm, 0), '', '4. ...moving the top row off the screen');
  }
  {
    const { tm, p } = mk();
    put(p, 'ONE'); p.feed([0x9B]); put(p, 'TWO'); p.feed([0x9B]); put(p, 'THREE');
    tm.cy = 0; tm.cx = 2; p.feed([0x9C]);
    eq([row(tm, 0), row(tm, 1), tm.cx, tm.cy], ['TWO', 'THREE', 0, 0], '4. 0x9C deletes the line; the rest shift up, cursor to column 0');
    tm.cx = 2; p.feed([0x9D]);
    eq([row(tm, 0), row(tm, 1), row(tm, 2), tm.cx], ['', 'TWO', 'THREE', 0], '4. 0x9D inserts a blank line at the cursor row');
    tm.cy = 1; tm.cx = 0; p.feed([0xFE]); eq(row(tm, 1), 'WO', '4. 0xFE deletes the character under the cursor');
    p.feed([0xFF]); eq([row(tm, 1), tm.cx], [' WO', 0], '4. 0xFF inserts a blank there, cursor unmoved');
    tm.cx = 39; put(p, 'Z'); eq([tm.cx, tm.cy], [0, 2], '4. printing in the last column wraps at once');
    p.feed([0x7D]); eq([row(tm, 1), tm.cx, tm.cy], ['', 0, 0], '4. 0x7D clears the screen and homes');
    let rang = 0; tm.bell = () => { rang++; }; p.feed([0xFD]); eq([rang, tm.cx], [1, 0], '4. 0xFD rings and prints nothing');
    p.feed([0x00, 0x0D, 0x0A, 0x80, 0xFC]);
    eq([0, 1, 2, 3, 4].map((c) => tm.screen.get(c, 0).ch), [0x00, 0x0D, 0x0A, 0x80, 0xFC],
       '4. every other byte, CR and LF included, is a printable cell stored raw');
  }

  // ── 5. ESC mode ───────────────────────────────────────────────────────────
  {
    eq([0x00, 0x1F, 0x20, 0x41, 0x5F, 0x60, 0x7F, 0x80, 0x9F, 0xA0, 0xDF, 0xE0, 0xFF].map(X.atasciiEscTranslate),
       [0x40, 0x5F, 0x00, 0x21, 0x3F, 0x60, 0x7F, 0xC0, 0xDF, 0x80, 0xBF, 0xE0, 0xFF],
       '5. the screen-code translation, at every range boundary');
    const { tm, p } = mk();
    const seen = [];
    const orig = tm.putChar.bind(tm);
    tm.putChar = (b) => { seen.push([b, tm.fgColor]); orig(b); };
    p.feed([0x1B]); eq(tm.fgColor, 1, '5. ESC switches to attribute 1');
    p.feed([0x41]); eq(seen, [[0x21, 1]], '5. ESC A stores screen code 0x21 under attribute 1, as CTerm does');
    eq(tm.fgColor, 7, '5. ...and the next byte is back at attribute 7');
    p.feed([0x1B, 0x1C]); eq([tm.screen.get(1, 0).ch, tm.cy], [0x5C, 0], '5. ESC quotes a control code instead of acting on it');
    p.feed([0x1B, 0x9B]); eq([tm.cx, tm.cy, seen.length], [0, 1, 2], '5. ESC EOL is still a return');
    p.feed([0x1B, 0x1B]); eq([tm.screen.get(0, 1).ch, tm.fgColor], [0x5B, 7], '5. ESC ESC prints and ends ESC mode');
    p.feed([0x1B]); p.reset(); p.feed([0x41]); eq(tm.screen.get(1, 1).ch, 0x41, '5. reset() drops a pending ESC');
  }

  // ── 6. The send direction ─────────────────────────────────────────────────
  {
    const seq = (n) => X.atasciiNamedSeq(n);
    // Named sequences go through the same encoder as typing, as main.js sends them.
    const wire = (n) => [...new X.ATASCIIKeys().encode(seq(n))];
    eq(['Enter', 'Backspace', 'Delete', 'Insert', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].map(wire),
       [[0x9B], [0x7E], [0x7E], [0xFF], [0x7F], [0x1B], [0x1C], [0x1D], [0x1E], [0x1F]],
       '6. named keys reach the wire as CTerm\'s ATASCII bytes');
    eq(['Home', 'End', 'PageUp', 'PageDown', 'F1', 'F12'].map(seq), [null, null, null, null, null, null],
       '6. keys an Atari lacks send nothing, rather than the tail of an ANSI sequence');
    eq(seq('Break'), undefined, '6. Break is left to the telnet path');
    const k = new X.ATASCIIKeys();
    eq([...k.encode('Ab1 \r\b\t\x7f\x07')], [0x41, 0x62, 0x31, 0x20, 0x9B, 0x7E, 0x7F, 0xFE, 0xFD],
       '6. typed text is ASCII, with CR, BS, TAB, DEL and BEL mapped as ciolib maps them');
    eq([...k.encode('€é')], [0x3F, 0xE9], '6. a character above 0xFF goes out as ?, and one below as its byte');
    eq([...k.encode('a`bc`d')], [0x61, 0xE2, 0xE3, 0x64], '6. the backtick toggles inverse typing and is not sent');
    eq([...k.encode('`\r')], [0x9B], '6. inverse typing leaves EOL alone');
    k.reset(); eq([...k.encode('e')], [0x65], '6. reset() turns inverse typing off');
  }

  // ── 7. A real board ───────────────────────────────────────────────────────
  if (!fs.existsSync(CAP)) {
    console.log('  SKIP 7: no capture at tools/datasource/nebbs-atascii.bin');
  } else {
    const cap = fs.readFileSync(CAP);
    eq(cap.includes(0x1B), false, '7. the capture has no ESC — the board uses single-byte controls only');
    const clears = [];
    for (let i = 0; i < cap.length; i++) if (cap[i] === 0x7D) clears.push(i);
    eq(clears.length, 4, '7. the board clears the screen four times');
    const screenAt = (n) => {
      const { tm, p } = mk();
      p.feed(cap.subarray(0, n));
      const text = [];
      for (let r = 0; r < 25; r++) {
        let s = '';
        for (let c = 0; c < 40; c++) s += A.ATASCII_TEXT_CHARS[tm.screen.get(c, r).ch];
        text.push(s.trimEnd());
      }
      return { tm, text };
    };

    // The front end's banner, before ATASCII art: 80-column text wrapped at 40.
    {
      const { tm, text } = screenAt(clears[0]);
      eq(text.slice(0, 6), ['Connected to NE BBS!', '',
        "Press ENTER/RETURN for ANSI or ATASCII.", "Press 'A' for 40 column ASCII...", '',
        'Welcome user from 185.213.154.210!'], '7. the banner wraps and returns where EOL puts it');
      eq([tm.cx, tm.cy], [0, 7], '7. ...cursor two EOLs below it');
    }
    // The login screen.
    {
      const { tm, text } = screenAt(clears[1]);
      eq(text[1], ' ──────┤NEBBS.SERVEHTTP.COM:9223├──────', '7. the title bar draws its box pieces around the address');
      const inv = [];
      for (let c = 8; c < 32; c++) inv.push(tm.screen.get(c, 1).ch >= 0x80);
      eq(inv.every(Boolean), true, '7. ...and the address is inverse text');
      eq(text[10], " ◢  Login or 'new' for a new account  ◢", '7. the prompt line');
      eq(text[12], ' username: new', '7. the echoed login');
      eq(text[9].startsWith(' 🮂🮂🮂  🮂🮂  🮂🮂🮂🮂🮂🮂'), true, '7. the logo\'s bottom edge uses the aliased U+1FB82');
      eq([tm.cx, tm.cy], [0, 13], '7. cursor below the echoed login');
    }
    // The new-account screen: a closed box, every row ending in column 38.
    {
      const { tm, text } = screenAt(clears[3]);
      eq(text[0], ' ┌────────────────────────────────────┐', '7. the box top');
      eq(text[7], ' └───────────┤NEW ACCOUNT├────────────┘', '7. the box bottom, with its title');
      eq([1, 2, 3, 4, 5, 6].every((r) => text[r].length === 39 && text[r][1] === '│' && text[r][38] === '│'), true,
         '7. every row between them opens in column 1 and closes in column 38');
      eq(text.slice(8, 19), ['Enter login you would like below.', '',
        'NOTE: Usernames are a max of 12 chars', 'and may contain letters, numbers,',
        'underscores, plus, minus, and a', 'space.', '',
        'You can press ^D at any point to cancel', 'and disconnect.', '', 'New username:'],
         '7. the instructions, line for line');
      eq([tm.screen.get(0, 10).ch >= 0x80, tm.screen.get(5, 10).ch >= 0x80], [true, false],
         '7. "NOTE:" is inverse and the text after it is not');
      eq([tm.cx, tm.cy], [14, 18], '7. cursor after the prompt');
    }
    // The end of the session.
    {
      const { tm, text } = screenAt(cap.length);
      eq([text[0], text[1], text.slice(2).every((s) => s === '')], ['', 'Disconnecting... Bye!', true],
         '7. the last screen');
      eq([tm.cx, tm.cy], [0, 3], '7. ...with the cursor two EOLs below it');
    }
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
