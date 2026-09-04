#!/usr/bin/env node
// Terminal.reflow() — the 80 ⇄ 40 column re-wrap. Pure model, no DOM, no
// sockets. `node tools/tests/reflowtest.js`.
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
  const { Terminal } = await import('../../public/terminal.js');

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
  // ── The wrap point lands inside a run of SPACES ───────────────────────────
  //
  // THE BUG THIS FILE DID NOT CATCH, reported from a real board. The old rule
  // was "a row with no trailing blank is a continuation", read off the row
  // AFTER trimming — so a wrap falling in the gap between two columns of an
  // aligned layout looked like the end of a line, and the second half was
  // stranded at column 0 of a row of its own. Every line that DID survive was
  // one whose wrap point happened to land on a printing character, which is
  // what made the damage look arbitrary on screen.
  //
  // Column-aligned art is mostly spaces, so in a BBS this is the common case,
  // not the edge case.
  {
    const t = mk(40, 10);
    // 51 characters: the break at 40 falls in the middle of the gap.
    const line = 'BirdEnuf BBS - channel 1' + ' '.repeat(16) + 'thx 4    /_';
    write(t, line);
    eq(screen(t), ['BirdEnuf BBS - channel 1', 'thx 4    /_'],
       'a space-run wrap looks like two lines at 40 columns (trailing blanks trimmed)');
    t.reflow(80, 10);
    eq(screen(t), [line],
       'THE FIX: it rejoins at 80 — the flag is recorded, not inferred from the trim');
  }
  {
    // The control that isolates the mechanism: identical shape, but the wrap
    // point lands on a printing character. This passed before the fix too, and
    // it must keep passing — if it ever fails, the join has broken in general
    // rather than for spaces.
    const t = mk(40, 10);
    const line = 'X'.repeat(45);
    write(t, line);
    t.reflow(80, 10);
    eq(screen(t), [line], 'CONTROL: a wrap point on a printing character rejoins (it always did)');
  }
  {
    // The other half of the fix, and it is easy to miss: a wrapped row must NOT
    // be trimmed, because its trailing blanks are interior to the logical line.
    // Rejoining without this gives 'onetwo' — the two columns jammed together,
    // which looks even more like a re-flow bug than the stranded row did.
    const t = mk(10, 6);
    write(t, 'one' + ' '.repeat(9) + 'two');     // 15 chars, wraps at 10
    t.reflow(20, 6);
    eq(screen(t), ['one         two'],
       'the interior blanks of a wrapped row survive — column alignment is content');
  }
  {
    // Full round trip on a screen shaped like the board that reported it.
    // Re-flow is reversible or it is lossy; there is no third option.
    const art = [
      'BirdEnuf BBS - channel 1                thx 4    /_',
      '   online at        baud                visit   >\' )',
      '',
      'Running Worldgroup 2.0 by Galacticomm',
      '                              ... on MS-DOS',
      'Users online: 0                              ... on Ubuntu',
      'Total callers: 2843',
    ];
    const t = mk(80, 25);
    write(t, art.join('\r\n'));
    const before = all(t);
    t.reflow(40, 25);
    t.reflow(80, 25);
    eq(all(t), before, '80 -> 40 -> 80 returns the screen unchanged, line for line');
  }
  {
    // The flag has to travel with its row. Scroll the content off the screen
    // into scrollback first, then re-flow: a flag left behind in the live
    // buffer would strand exactly the lines that scrolled.
    const t = mk(40, 3);
    // 52 chars, and the 40-column break falls inside the space run — the same
    // shape as the case above, so this really is testing the flag's travel and
    // not just re-wrapping a short line.
    const line = 'left column here' + ' '.repeat(24) + 'right column';
    write(t, line + '\r\n');
    write(t, 'A\r\nB\r\nC\r\nD\r\n');          // push it into the ring
    t.reflow(80, 3);
    eq(all(t).includes(line), true,
       'a wrapped line that scrolled into the ring still rejoins (the flag moved with it)');
  }
  {
    // ...and a flag must not outlive the text it describes. Erasing to end of
    // line removes the row's right-hand end, which is the thing the flag is a
    // statement about; a stale one would join a live line to whatever follows.
    const t = mk(10, 5);
    write(t, 'ABCDEFGHIJKLMN');    // row 0 wraps
    t.cursorPos(0, 3);
    t.eraseLine(0);                // ...and now row 0 ends at column 3
    t.reflow(20, 5);
    eq(screen(t)[0], 'ABC', "erasing a row's tail clears its continuation flag");
  }

  {
    // The screen keeps its own rows. With history in the ring and a page that
    // ends above the last row, a re-flow must not borrow scrollback lines to
    // fill the screen: doing that slides the whole page down the display and
    // parks stale history above it.
    const t = mk(80, 25);
    write(t, Array.from({ length: 30 }, (_, i) => 'history ' + i).join('\r\n'));
    t.eraseDisplay(2);                       // the board clears and draws a page
    const page = [
      'HEADER ONE' + ' '.repeat(30) + 'RIGHT ONE',
      'HEADER TWO' + ' '.repeat(30) + 'RIGHT TWO',
      '',
      'Otherwise type "new": ',
    ];
    write(t, page.join('\r\n'));
    t.reflow(40, 25);
    t.reflow(80, 25);
    const s = screen(t);
    eq(s[0], page[0].replace(/ +$/, ''), 'the page starts at row 0 after a re-flow');
    eq(s.length, 4, 'the rows the page does not use stay blank');
    eq(s.some((r) => r.startsWith('history')), false,
       'no scrollback line is dragged onto the screen');
    eq(t.cy, 3, 'the cursor stays on the page\'s last line');
  }

  {
    // A page that does not fit at the narrow width has to spill off the top —
    // the ring is the only place for it. Coming back wide must claim it back,
    // or the round trip quietly eats the header.
    const page = [];
    for (let i = 0; i < 20; i++) {
      page.push('LINE ' + i + ' LEFT' + ' '.repeat(30) + 'RIGHT ' + i);
    }
    const t = mk(80, 25);
    write(t, page.join('\r\n'));
    const before = screen(t);
    t.reflow(40, 25);
    eq(screen(t)[0] === page[0].replace(/ +$/, ''), false,
       'the narrow screen really did spill (otherwise this proves nothing)');
    t.reflow(80, 25);
    eq(screen(t), before, '80 -> 40 -> 80 restores the page it started with');
    eq(t.cy, 19, 'and the cursor with it');
  }
  {
    // Typing at a prompt does not move the page, so the claim survives it.
    const page = [];
    for (let i = 0; i < 20; i++) page.push('ROW ' + i + ' ' + 'x'.repeat(60));
    const t = mk(80, 25);
    write(t, page.join('\r\n'));
    t.reflow(40, 25);
    write(t, 'ab');
    t.reflow(80, 25);
    eq(screen(t)[0], page[0], 'an echoed keystroke does not void the claim');
  }
  {
    // ...but a scroll does: the page has moved on, and claiming rows back would
    // drag history down onto the screen.
    const page = [];
    for (let i = 0; i < 20; i++) page.push('ROW ' + i + ' ' + 'x'.repeat(60));
    const t = mk(80, 25);
    write(t, page.join('\r\n'));
    t.reflow(40, 25);
    for (let i = 0; i < 30; i++) write(t, '\r\nnew output ' + i);
    t.reflow(80, 25);
    eq(screen(t).some((r) => r.startsWith('ROW 0 ')), false,
       'a scroll voids the claim — nothing is dragged back onto the screen');
  }

  console.log(`\n${fail ? 'FAILED' : 'OK'} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
