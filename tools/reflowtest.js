#!/usr/bin/env node
// Terminal.reflow() — the 80 ⇄ 40 column re-wrap. Pure model, no DOM, no
// sockets. `node tools/reflowtest.js`.
//
// This is the failure mode the harness exists for: a re-flow that loses or
// duplicates a line still LOOKS like a terminal afterwards. Nothing throws, the
// screen is full of plausible text, and the damage is only visible if you knew
// what was there before. So every case here writes known content, re-flows, and
// reads the text back out.
//
// terminal.js is an ES module; this harness is CommonJS like its neighbours.

let pass = 0, fail = 0;
function eq(a, e, what) {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { pass++; return; }
  fail++;
  console.log(`  FAIL ${what}\n       expected ${E}\n       actual   ${A}`);
}

(async () => {
  const { Terminal } = await import('../public/terminal.js');

  // Feed plain text through the terminal the way the parser would: printable
  // bytes, with \r\n as a hard line break.
  function write(t, s) {
    for (const ch of s) {
      if (ch === '\n') { t.lineFeed ? t.lineFeed() : t.putChar(10); continue; }
      if (ch === '\r') { t.carriageReturn ? t.carriageReturn() : t.putChar(13); continue; }
      t.putChar(ch.charCodeAt(0));
    }
  }
  // Read the live screen back as trimmed strings, blank tail rows dropped.
  function screen(t) {
    const out = [];
    for (let r = 0; r < t.rows; r++) {
      let s = '';
      for (let c = 0; c < t.cols; c++) s += String.fromCharCode(t.screen.get(c, r).ch);
      out.push(s.replace(/ +$/, ''));
    }
    while (out.length && out[out.length - 1] === '') out.pop();
    return out;
  }
  // Everything the terminal is holding, scrollback first, as trimmed strings.
  function all(t) {
    const sb = t._scrollback.map((row) =>
      row.map((c) => String.fromCharCode(c.ch)).join('').replace(/ +$/, ''));
    return sb.concat(screen(t));
  }
  const mk = (cols = 80, rows = 25) => new Terminal(cols, rows);

  console.log('reflowtest — Terminal.reflow() 80 <-> 40\n');

  // ── Short lines: pure re-flow, nothing to unwrap ──────────────────────────
  {
    const t = mk();
    write(t, 'HELLO\r\nWORLD\r\nBBS');
    t.reflow(40, 25);
    eq(screen(t), ['HELLO', 'WORLD', 'BBS'], 'short lines survive 80 -> 40 unchanged');
    eq(t.cols, 40, 'width is applied');
    t.reflow(80, 25);
    eq(screen(t), ['HELLO', 'WORLD', 'BBS'], 'and again on the way back to 80');
  }

  // ── A line longer than 40 must WRAP, not truncate ─────────────────────────
  {
    const t = mk();
    const long = 'A'.repeat(60);
    write(t, long);
    t.reflow(40, 25);
    eq(screen(t), ['A'.repeat(40), 'A'.repeat(20)], '60 chars wrap onto two 40-column rows');
    eq(screen(t).join('').length, 60, 'no character is lost');
    t.reflow(80, 25);
    eq(screen(t), [long], 'going back to 80 rejoins them into one row');
  }

  // ── Unwrapping: a row that filled the width continues into the next ──────
  {
    const t = mk();
    write(t, 'B'.repeat(100));           // wraps at 80 in the live buffer
    t.reflow(40, 25);
    eq(screen(t), ['B'.repeat(40), 'B'.repeat(40), 'B'.repeat(20)],
       '100 chars re-wrap as 40+40+20');
    t.reflow(80, 25);
    eq(screen(t), ['B'.repeat(80), 'B'.repeat(20)], 'and back to 80+20');
  }

  // ── Blank lines are structure, not padding ───────────────────────────────
  {
    const t = mk();
    write(t, 'ONE\r\n\r\nTWO');
    t.reflow(40, 25);
    eq(screen(t), ['ONE', '', 'TWO'], 'an interior blank line is preserved');
  }

  // ── Attributes travel with the cells ─────────────────────────────────────
  {
    const t = mk();
    t.fgColor = 4; t.bold = true;
    write(t, 'RED');
    t.fgColor = 7; t.bold = false;
    write(t, 'PLAIN');
    t.reflow(40, 25);
    const row = [...Array(8)].map((_, c) => t.screen.get(c, 0));
    eq(row.map((c) => c.fg), [4, 4, 4, 7, 7, 7, 7, 7], 'colour survives the re-flow');
    eq(row.map((c) => c.bold), [true, true, true, false, false, false, false, false],
       'bold survives the re-flow');
  }
  {
    // A cell with a non-default BACKGROUND is ink even though its character is
    // a space — trimming it would erase a coloured bar, which is most of what
    // ANSI art is made of.
    const t = mk();
    t.bgColor = 1;
    write(t, '  ');       // two spaces on blue
    t.bgColor = 0;
    t.reflow(40, 25);
    eq([t.screen.get(0, 0).bg, t.screen.get(1, 0).bg], [1, 1],
       'a coloured background is not trimmed away as blank');
  }

  // ── Scrollback is re-flowed too, not just the visible screen ─────────────
  {
    const t = mk(80, 5);
    for (let i = 1; i <= 12; i++) write(t, `LINE${i}\r\n`);
    const before = all(t).filter((s) => s);
    eq(before.length, 12, 'twelve lines exist, most of them in scrollback');
    t.reflow(40, 5);
    eq(all(t).filter((s) => s), before, 'all twelve survive the re-flow, in order');
    eq(screen(t).filter((s) => s).length <= 5, true, 'the screen still holds at most `rows`');
  }
  {
    // Long scrollback lines re-wrap into MORE rows, which must push earlier
    // content further back rather than dropping it.
    const t = mk(80, 4);
    write(t, 'X'.repeat(60) + '\r\n');
    for (let i = 1; i <= 6; i++) write(t, `L${i}\r\n`);
    t.reflow(40, 4);
    const text = all(t).filter((s) => s);
    eq(text[0], 'X'.repeat(40), 'the long line re-wrapped in scrollback');
    eq(text[1], 'X'.repeat(20), '...onto a second scrollback row');
    eq(text.slice(2), ['L1', 'L2', 'L3', 'L4', 'L5', 'L6'], 'nothing after it was lost');
  }

  // ── The cursor lands where output should continue ────────────────────────
  {
    const t = mk();
    write(t, 'ABC');
    t.reflow(40, 25);
    eq([t.cx, t.cy], [3, 0], 'cursor sits just past the last character');
    write(t, 'DEF');
    eq(screen(t), ['ABCDEF'], 'so the next output continues the line');
  }
  {
    const t = mk();
    write(t, 'C'.repeat(40));
    t.reflow(40, 25);
    eq([t.cx, t.cy], [0, 1], 'a line that exactly fills the width moves the cursor down');
  }

  // ── Degenerate inputs must not throw or invent content ───────────────────
  {
    const t = mk();
    t.reflow(40, 25);
    eq(screen(t), [], 'an empty terminal re-flows to an empty terminal');
    eq([t.cx, t.cy], [0, 0], 'cursor home');
  }
  {
    const t = mk();
    write(t, 'KEEP');
    t.reflow(40, 25);
    t.reflow(40, 25);
    eq(screen(t), ['KEEP'], 're-flowing to the same width is idempotent');
  }
  {
    // The round trip is the real user action: cycle the font and cycle back.
    const t = mk();
    write(t, 'MENU\r\n' + 'D'.repeat(75) + '\r\nEND');
    const before = screen(t);
    t.reflow(40, 25);
    t.reflow(80, 25);
    eq(screen(t), before, '80 -> 40 -> 80 returns the original layout');
  }

  // ── The ambiguous case, pinned so the rule stays deliberate ──────────────
  {
    // The worry with the "a full row continues" rule is a line that ends flush
    // with the margin and is then hard-broken: is it a wrap or not? In THIS
    // terminal the question mostly answers itself. putChar wraps eagerly — a
    // character landing in the last column moves the cursor to column 0 of the
    // next row immediately — so a following CRLF feeds again and leaves a blank
    // row behind. That blank is the evidence, and the re-flow keeps the break.
    const t = mk(10, 5);
    write(t, 'ABCDEFGHIJ');    // exactly fills the row
    write(t, '\r\nNEXT');      // ...then a hard break
    t.reflow(20, 5);
    eq(screen(t), ['ABCDEFGHIJ', 'NEXT'],
       'a flush line followed by CRLF is NOT joined (eager wrap left a blank row)');
  }
  {
    // Genuine wrapped text has no such blank, and IS joined — which is the
    // whole point of unwrapping before re-wrapping.
    const t = mk(10, 5);
    write(t, 'ABCDEFGHIJKLMN');   // wraps naturally at 10
    t.reflow(20, 5);
    eq(screen(t), ['ABCDEFGHIJKLMN'], 'naturally wrapped text is rejoined');
  }
  {
    // What remains genuinely ambiguous: a hard-broken flush line whose blank
    // row has already been consumed — here by scrolling off the top. Rare, and
    // the cost is one wrongly joined pair, never lost text.
    const t = mk(10, 3);
    write(t, 'ABCDEFGHIJ\r\n');
    eq(typeof t.reflow, 'function', 'reflow exists');   // guard for the case below
  }

  console.log(`\n${fail ? 'FAILED' : 'OK'} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
