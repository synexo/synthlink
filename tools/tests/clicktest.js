#!/usr/bin/env node
// Mouse selection and the click actions that share its press: the geometry that
// turns a pixel into a cell, the predicate that decides a cell is a menu key,
// the URL scan, and the charset the clipboard is decoded through.
//
//     node tools/tests/clicktest.js
//
// Three sources, three ways in, and the reason for each:
//
//   • renderer.cellAt() is called on a SYNTHETIC `this`. The method reads only
//     cols/rows/cellW/cellH/_layout, so a plain object exercises both the
//     constant-pitch and the edge-table paths without a canvas, a font file or
//     an atlas — and the edge-table path is the one that cannot be checked by
//     eye, since its columns are deliberately not all the same width.
//
//   • menuKeyAt/urlAt/isAlnum/rowByte are EXTRACTED FROM public/main.js BY
//     NAME, the trick sharelinktest, guidetest and altfonttest already use:
//     main.js runs against a live DOM and cannot be required, and extracting by
//     name means renaming one of these throws here rather than quietly leaving
//     a stale copy under test.
//
//   • Terminal.getSelectionText() is driven directly — it is pure model.
//
// What is NOT here: the listeners. Whether a mousedown reaches the selection
// action is arbitration between zoom, touch and this, which is live-DOM
// behaviour; uitest is where that belongs, and a real device is the only place
// the synthetic-tap question can actually be settled.

const fs = require('fs');
const path = require('path');

const MAIN = path.join(__dirname, '..', '..', 'public', 'main.js');
const SRC = fs.readFileSync(MAIN, 'utf8');

let pass = 0, fail = 0;
function eq(a, e, what) {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { pass++; return; }
  fail++;
  console.log(`  FAIL ${what}\n       expected ${E}\n       actual   ${A}`);
}
function ok(cond, what) {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL ${what}`);
}

// Lift a top-level `function name(...)` or `const name = ...;` out of main.js.
function extract(decl, name) {
  const needle = decl === 'fn' ? `function ${name}(` : `const ${name} =`;
  const at = SRC.indexOf(`\n${needle}`);
  if (at < 0) throw new Error(`clicktest: ${name} not found in public/main.js`);
  const start = at + 1;
  if (decl === 'const') {
    const end = SRC.indexOf(';\n', start);
    return SRC.slice(start, end + 1);
  }
  // Brace-match the body. Every one of these is plain code — no strings
  // containing braces, no regex literals with braces — so counting is enough,
  // and anything that stops being true fails loudly here rather than silently.
  let i = SRC.indexOf('{', start), depth = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}' && --depth === 0) break;
  }
  return SRC.slice(start, i + 1);
}

(async () => {
  // ── 1. renderer.cellAt: constant pitch ─────────────────────────────────────
  const { Renderer } = await import('../../public/renderer.js');
  const cellAt = Renderer.prototype.cellAt;
  ok(typeof cellAt === 'function', 'cellAt: exists on Renderer');

  const flat80 = { cols: 80, rows: 25, cellW: 8, cellH: 16, _layout: null };
  const at = (self, x, y) => cellAt.call(self, x, y);

  eq(at(flat80, 0, 0), [0, 0], '80col: origin is cell 0,0');
  eq(at(flat80, 7, 15), [0, 0], '80col: last pixel of cell 0,0 is still 0,0');
  eq(at(flat80, 8, 16), [1, 1], '80col: first pixel of the next cell steps both axes');
  eq(at(flat80, 639, 399), [79, 24], '80col: bottom-right pixel is the last cell');

  // Out of the box on every side. A drag that leaves the canvas keeps
  // extending the selection, so these are reached constantly and must clamp
  // rather than index past the grid.
  eq(at(flat80, -40, -40), [0, 0], '80col: above and left clamps to 0,0');
  eq(at(flat80, 9999, 9999), [79, 24], '80col: below and right clamps to the last cell');
  eq(at(flat80, 300, -5), [37, 0], '80col: off the top keeps the column');
  eq(at(flat80, -5, 200), [0, 12], '80col: off the left keeps the row');

  // 40-column mode is the same arithmetic against a different grid — the 9x14
  // font carries cols:40, and nothing else about the mapping changes.
  const flat40 = { cols: 40, rows: 25, cellW: 9, cellH: 14, _layout: null };
  eq(at(flat40, 0, 0), [0, 0], '40col: origin');
  eq(at(flat40, 8, 13), [0, 0], '40col: cell 0,0 is 9 wide and 14 tall');
  eq(at(flat40, 9, 14), [1, 1], '40col: and the next one starts right after it');
  eq(at(flat40, 359, 349), [39, 24], '40col: bottom-right');
  eq(at(flat40, 9999, 0), [39, 0], '40col: clamps to 39, not to 79');

  // ── 2. renderer.cellAt: the hybrid edge table ──────────────────────────────
  // The path that matters. A hybrid font's columns do NOT share a pitch — the
  // mask widens some cells by a pixel so a run of box-drawing meets — so
  // dividing by cellW lands on the wrong column wherever the table widened one.
  // Four columns at 8,9,8,9 and three rows at 16,17,16:
  const HY = {
    cols: 4, rows: 3, cellW: 8, cellH: 16,
    _layout: { xEdges: [0, 8, 17, 25, 34], yEdges: [0, 16, 33, 49] },
  };
  eq(at(HY, 0, 0), [0, 0], 'hybrid: origin');
  eq(at(HY, 7, 0), [0, 0], 'hybrid: last pixel of an 8-wide cell');
  eq(at(HY, 8, 0), [1, 0], 'hybrid: first pixel of the 9-wide cell after it');
  eq(at(HY, 16, 0), [1, 0], 'hybrid: last pixel of the 9-wide cell');
  eq(at(HY, 17, 0), [2, 0], 'hybrid: and the cell after THAT');
  eq(at(HY, 24, 0), [2, 0], 'hybrid: last pixel of column 2');
  eq(at(HY, 25, 0), [3, 0], 'hybrid: column 3');
  eq(at(HY, 33, 0), [3, 0], 'hybrid: past the last edge clamps to the last column');
  eq(at(HY, 0, 16), [0, 1], 'hybrid: rows use their own table too');
  eq(at(HY, 0, 32), [0, 1], 'hybrid: a 17-tall row really is 17 tall');
  eq(at(HY, 0, 33), [0, 2], 'hybrid: and the row after it');
  eq(at(HY, -9, -9), [0, 0], 'hybrid: clamps low');
  eq(at(HY, 9999, 9999), [3, 2], 'hybrid: clamps high');

  // The whole point of the method: the same pixel, the two paths, different
  // answers. If this ever comes out equal the edge table has stopped being
  // consulted and every click on a hybrid font is off by a column to the right.
  const flat4 = { cols: 4, rows: 3, cellW: 8, cellH: 16, _layout: null };
  ok(at(HY, 16, 0)[0] !== at(flat4, 16, 0)[0],
     'hybrid: a widened column maps differently than a constant pitch would');

  // ── 3. The menu-key predicate ──────────────────────────────────────────────
  // Rebuilt from main.js so a rename or an edit is caught here.
  const ctx = { COLS: 0 };
  const src = [
    extract('const', 'rowByte'),
    extract('fn', 'cellIsEmpty'),
    extract('const', 'isAlnum'),
    extract('fn', 'menuKeyAt'),
    extract('const', 'URL_RE'),
    extract('fn', 'urlAt'),
  ].join('\n');
  // COLS is a module-level binding in main.js. Here it is a getter onto the
  // case's own width, so each row below can be as wide as it needs to be.
  // cellIsEmpty asks the ACTIVE FONT's charset which positions draw nothing;
  // CP437's two are NUL and NBSP, and that descriptor is what every font
  // without an explicit charset resolves to.
  const scope = {
    get COLS() { return ctx.COLS; },
    activeFont: null,
    charsetOf: () => ({ blank: (i) => i === 0x00 || i === 0xFF }),
  };
  const M = new Function('scope', `with (scope) { ${src}
    return { rowByte, isAlnum, menuKeyAt, urlAt, cellIsEmpty }; }`)(scope);

  // Cells as main.js sees them: objects with a `.ch` byte, or null.
  function row(text, cols) {
    ctx.COLS = cols || text.length;
    const out = new Array(ctx.COLS).fill(null);
    for (let i = 0; i < text.length && i < ctx.COLS; i++) out[i] = { ch: text.charCodeAt(i) };
    return out;
  }
  const keyAt = (text, col) => {
    const cells = row(text);
    const b = M.menuKeyAt(cells, col);
    return b === null ? null : String.fromCharCode(b);
  };

  // Pattern 1 — an alphanumeric with non-alphanumeric neighbours, which is the
  // conventional BBS menu in all its spellings.
  eq(keyAt('[L]ogin', 1), 'L', 'menu key: [L]ogin');
  eq(keyAt('(A)bort', 1), 'A', 'menu key: (A)bort');
  eq(keyAt('1. New game', 0), '1', 'menu key: a leading digit');
  eq(keyAt('Q.uit', 0), 'Q', 'menu key: Q.uit');
  eq(keyAt('<G>oodbye', 1), 'G', 'menu key: angle brackets delimit too');
  eq(keyAt('X Y Z', 2), 'Y', 'menu key: spaces delimit');

  // ...and the neighbours really do have to be non-alphanumeric, or every
  // letter of every word on the screen becomes a click target.
  eq(keyAt('Login', 0), null, 'menu key: a word is not a menu key');
  eq(keyAt('Login', 2), null, 'menu key: nor is a letter inside one');
  eq(keyAt('[Login]', 1), null, 'menu key: a bracketed WORD is not one either');
  eq(keyAt('[L]ogin', 0), null, 'menu key: the bracket itself is not a target');
  eq(keyAt('[L]ogin', 2), null, 'menu key: nor the closing bracket');

  // Pattern 2 — punctuation, but only wrapped in literal square brackets.
  eq(keyAt('[%]', 1), '%', 'menu key: [%] is a target');
  eq(keyAt('[!]', 1), '!', 'menu key: [!]');
  eq(keyAt('[?]', 1), '?', 'menu key: [?]');
  eq(keyAt('the % symbol', 4), null, 'menu key: prose punctuation stays inert');
  eq(keyAt('(%)', 1), null, 'menu key: round brackets do NOT qualify punctuation');
  eq(keyAt('50% off', 2), null, 'menu key: nor does a bare percent');

  // Row edges. A menu key in column 0 or the last column has one neighbour off
  // the row, which reads as -1 and so is correctly not alphanumeric.
  eq(keyAt('A]', 0), 'A', 'menu key: column 0 with nothing to its left');
  {
    const cells = row('no.A', 4);
    eq(M.menuKeyAt(cells, 3), 65, 'menu key: last column with nothing to its right');
  }
  {
    // An unwritten cell is null, not a space, on a screen the BBS has not
    // filled — it must delimit exactly as a space does rather than throw.
    const cells = row('A', 4);
    eq(M.menuKeyAt(cells, 0), 65, 'menu key: a null neighbour delimits');
    eq(M.menuKeyAt(cells, 2), null, 'menu key: an empty cell is not a target');
  }

  // The byte is what is returned, and it is the RAW cell byte. Decoding it to a
  // character first and re-encoding would mangle anything above 0x7F — CP437's
  // 0xB0 is U+2591, which truncates to 0x91 on the way out.
  {
    const cells = [{ ch: 0x5B }, { ch: 0xB0 }, { ch: 0x5D }];
    ctx.COLS = 3;
    eq(M.menuKeyAt(cells, 1), 0xB0, 'menu key: returns the raw byte, not a decoded char');
  }

  // ── 3b. Blank cells, which are the only ones a bare click sends Enter for ──
  // The near-miss rule: clicking the 'o' of [L]ogin must send nothing, because
  // answering a miss with Enter hands the menu a choice the user did not make.
  {
    const cells = row('[L]ogin  x');
    ok(!M.cellIsEmpty(cells, 0), 'blank: a bracket is not blank');
    ok(!M.cellIsEmpty(cells, 1), 'blank: nor the menu key itself');
    ok(!M.cellIsEmpty(cells, 4), 'blank: nor the "o" beside it — the near miss');
    ok(M.cellIsEmpty(cells, 7), 'blank: a space is blank');
    ok(M.cellIsEmpty(cells, 8), 'blank: and the next space');
    ok(!M.cellIsEmpty(cells, 9), 'blank: and the character after those is not');
  }
  {
    const cells = row('a', 4);
    ok(M.cellIsEmpty(cells, 2), 'blank: an unwritten cell is blank');
    ok(M.cellIsEmpty(cells, 99), 'blank: so is one off the end of the row');
    ok(!M.cellIsEmpty(cells, 0), 'blank: a written one is not');
  }
  {
    // The charset decides. CP437 draws nothing for NUL and NBSP, so those are
    // blank however they got onto the screen; its shading blocks are not.
    ctx.COLS = 3;
    const cells = [{ ch: 0x00 }, { ch: 0xFF }, { ch: 0xB0 }];
    ok(M.cellIsEmpty(cells, 0), 'blank: NUL draws nothing');
    ok(M.cellIsEmpty(cells, 1), 'blank: NBSP draws nothing');
    ok(!M.cellIsEmpty(cells, 2), 'blank: a shading block very much does');
  }

  // ── 4. URL hit testing ─────────────────────────────────────────────────────
  const urlIn = (text, col) => { const c = row(text); return M.urlAt(c, col); };
  const U = 'Visit https://example.org/x now';
  eq(urlIn(U, 6), 'https://example.org/x', 'url: first character of the URL');
  eq(urlIn(U, 26), 'https://example.org/x', 'url: last character of the URL');
  eq(urlIn(U, 5), null, 'url: the space before it is not part of it');
  eq(urlIn(U, 27), null, 'url: nor the space after');
  eq(urlIn(U, 0), null, 'url: prose before it');
  eq(urlIn('http://a.b/', 0), 'http://a.b/', 'url: plain http counts');
  eq(urlIn('ftp://a.b/', 0), null, 'url: ftp does not');
  eq(urlIn('no links here', 3), null, 'url: a row with none');

  // Two on one row, which is a directory listing's normal state.
  {
    const two = 'http://a.org and http://b.org';
    eq(urlIn(two, 2), 'http://a.org', 'url: the first of two');
    eq(urlIn(two, 20), 'http://b.org', 'url: the second of two');
    eq(urlIn(two, 13), null, 'url: the gap between them');
  }

  // URL_RE is a module-level regex with /g, so lastIndex persists between
  // calls. urlAt resets it; if it ever stops doing so the SECOND call on the
  // same text silently misses, which is the kind of bug that only shows up
  // after a user clicks twice.
  {
    const c = row(U);
    M.urlAt(c, 6);
    eq(M.urlAt(c, 6), 'https://example.org/x', 'url: a repeat call finds it again');
  }

  // High bytes cannot be part of a URL and must not corrupt the scan. An Amiga
  // board's shading is 0xAF/0xB7 everywhere, so this row is what one looks like.
  {
    const cells = [];
    for (const b of [0xB0, 0xB0, 0x68, 0x74, 0x74, 0x70, 0x3A, 0x2F, 0x2F, 0x61,
                     0x2E, 0x62, 0x2F, 0xB0]) cells.push({ ch: b });
    ctx.COLS = cells.length;
    eq(M.urlAt(cells, 4), 'http://a.b/', 'url: shading around it does not break the scan');
    eq(M.urlAt(cells, 0), null, 'url: and the shading itself is not a hit');
  }

  // ── 5. Copy decodes through the ACTIVE FONT's charset ──────────────────────
  // The bug this parameter exists to stop: an Amiga board is Latin-1, so its
  // high bytes are punctuation used as shading. Read through CP437 they come
  // out as box drawing, and the clipboard gets mojibake for text that rendered
  // correctly on screen.
  const { Terminal } = await import('../../public/terminal.js');
  const { CP437, LATIN1 } = await import('../../public/fonts/charsets.js');

  const t = new Terminal(8, 2);
  const BYTES = [0xAF, 0xB7, 0xAC];      // macron, middle dot, not sign in Latin-1
  BYTES.forEach((b) => t.putChar(b));

  const asDefault = t.getSelectionText([0, 0], [0, 2]);
  const asCP437 = t.getSelectionText([0, 0], [0, 2], CP437.chars);
  const asLatin1 = t.getSelectionText([0, 0], [0, 2], LATIN1.chars);

  eq(asDefault, asCP437, 'copy: omitting the table is CP437, exactly as before');
  eq(asLatin1, '¯·¬', 'copy: Latin-1 gives the punctuation the board drew');
  eq(asCP437, '»╖¼', 'copy: CP437 gives » ╖ ¼ for the same bytes');
  ok(asLatin1 !== asCP437, 'copy: the two tables really do disagree here');

  // ASCII is identical in both, which is why the click predicates above can
  // ignore the charset entirely. Asserted rather than assumed.
  {
    let same = true;
    for (let b = 0x20; b < 0x7F; b++) if (CP437.chars[b] !== LATIN1.chars[b]) same = false;
    ok(same, 'copy: the two charsets agree across printable ASCII');
  }

  // A selection that runs past written text is trimmed, not padded with the
  // blanks the screen is full of — a BBS screen is mostly spaces.
  {
    const t2 = new Terminal(10, 1);
    for (const ch of 'hi') t2.putChar(ch.charCodeAt(0));
    eq(t2.getSelectionText([0, 0], [0, 9]), 'hi', 'copy: trailing blanks are trimmed');
  }

  // Backwards drags are normalised, since a user selecting right-to-left is the
  // same selection as left-to-right.
  {
    const t3 = new Terminal(10, 1);
    for (const ch of 'abcdef') t3.putChar(ch.charCodeAt(0));
    eq(t3.getSelectionText([0, 4], [0, 1]), t3.getSelectionText([0, 1], [0, 4]),
       'copy: a backwards drag selects the same text');
  }

  // ── 6. isTextEntry: who may keep a keystroke away from the BBS ─────────────
  // A live carrier used to claim every keydown on the page, so any field the
  // user clicked into stayed empty while what they typed went down the wire.
  // The fix turns on this predicate, and the trap it has to avoid is why it is
  // not isFormField(): that one counts a BUTTON, which is exactly what holds
  // focus straight after a toolbar press, so gating a carrier on it would cut
  // the BBS off from the keyboard at the first click of any button.
  // It compares against `canvas` — the terminal is not a text field, and a
  // stand-in object is all that identity check needs.
  const CANVAS = { tagName: 'CANVAS' };
  const isTextEntry = new Function('canvas', `${extract('fn', 'isTextEntry')}
    return isTextEntry;`)(CANVAS);
  const el = (tagName, extra) => Object.assign({ tagName, isContentEditable: false }, extra);

  ok(!isTextEntry(CANVAS), 'textEntry: the terminal canvas is not a text field');

  ok(isTextEntry(el('TEXTAREA')), 'textEntry: a textarea takes text');
  ok(isTextEntry(el('INPUT')), 'textEntry: a bare input takes text');
  ok(isTextEntry(el('INPUT', { type: 'text' })), 'textEntry: type=text');
  ok(isTextEntry(el('INPUT', { type: 'TEXT' })), 'textEntry: and the type is case-blind');
  ok(isTextEntry(el('DIV', { isContentEditable: true })), 'textEntry: contenteditable counts');

  ok(!isTextEntry(el('BUTTON')), 'textEntry: a BUTTON does not — the whole point');
  ok(!isTextEntry(el('SELECT')), 'textEntry: nor a select, which takes no text');
  ok(!isTextEntry(el('INPUT', { type: 'checkbox' })), 'textEntry: nor a checkbox');
  ok(!isTextEntry(el('INPUT', { type: 'radio' })), 'textEntry: nor a radio');
  ok(!isTextEntry(el('INPUT', { type: 'button' })), 'textEntry: nor an input button');
  ok(!isTextEntry(el('INPUT', { type: 'file' })), 'textEntry: nor a file picker');
  ok(!isTextEntry(el('DIV')), 'textEntry: nor a plain div');
  ok(!isTextEntry(null), 'textEntry: nor nothing at all');

  console.log(`\n${fail ? 'FAILED' : 'OK'} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
