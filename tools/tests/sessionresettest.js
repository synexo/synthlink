#!/usr/bin/env node
// A call must not inherit the last call's terminal state. resetEmulation() is
// extracted from public/main.js by name and run against the real Terminal and
// the real ANSI, PETSCII and ATASCII parsers: each is left dirty the way a board
// leaves it, and the next call's first bytes must draw from that font's own
// start state. `node tools/tests/sessionresettest.js`.

const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '../../public/main.js'), 'utf8');

let pass = 0, fail = 0;
function eq(a, e, what) {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { pass++; console.log(`  ok   ${what}`); return; }
  fail++;
  console.log(`  FAIL ${what}\n       expected ${E}\n       actual   ${A}`);
}

function extractFn(name) {
  const at = SRC.indexOf(`\nfunction ${name}(`);
  if (at < 0) throw new Error(`main.js: function ${name} not found`);
  const open = SRC.indexOf('{', at);
  let depth = 0, i = open;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}' && --depth === 0) break;
  }
  return SRC.slice(at + 1, i + 1);
}

(async () => {
  const { Terminal, ANSIParser } = await import('../../public/terminal.js');
  const { PETSCIIParser, START_ATTRS } = await import('../../public/petsciiterm.js');
  const { ATASCIIParser, ATASCIIKeys, ATASCII_ATTR } = await import('../../public/atasciiterm.js');
  const { ANSIMusic } = await import('../../public/music.js');
  const enc = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));

  // One session's worth of the objects main.js holds, and its resetEmulation().
  function rig(activeFont, colours = 'c40') {
    const term = new Terminal(80, 25);
    const env = {
      term,
      parser: new ANSIParser(term),
      petscii: new PETSCIIParser(term, { colours }),
      atascii: new ATASCIIParser(term),
      atasciiKeys: new ATASCIIKeys(),
      music: new ANSIMusic(),
      activeFont,
      dirty: false,
    };
    const body = extractFn('resetEmulation');
    env.reset = new Function('env', `with (env) { ${body}; resetEmulation(); }`).bind(null, env);
    // `dirty = true` inside `with` writes env.dirty, which is the point.
    return env;
  }
  const attrs = (t) => ({ fg: t.fgColor, bg: t.bgColor, bold: t.bold, blink: t.blink,
                          reverse: t.reverse, page: t.charPage });
  const modes = (t) => ({ top: t._scrollTop, bottom: t._scrollBottom, wrap: t._autoWrap,
                          insert: t._insertMode, cursor: t.cursorVisible,
                          saved: [t._savedCX, t._savedCY] });
  const ANSI_START = { fg: 7, bg: 0, bold: false, blink: false, reverse: false, page: 0 };
  const MODES_START = { top: 0, bottom: 24, wrap: true, insert: false, cursor: true, saved: [0, 0] };
  const DIRTY_ANSI = '\x1B[1;5;7;31;44m\x1B[3;10r\x1B[?7l\x1B[4h\x1B[?25l\x1B[5;5H\x1B7';

  console.log('sessionresettest — nothing carries from one call to the next\n');

  // ── ANSI board, then ANSI board ───────────────────────────────────────────
  {
    const e = rig(null);
    e.parser.feed(enc('HELLO' + DIRTY_ANSI));
    e.reset();
    eq(attrs(e.term), ANSI_START, 'ANSI: bold, blink, reverse and colour are back to 7 on 0');
    eq(modes(e.term), MODES_START, 'ANSI: scroll region, autowrap, insert, cursor and saved cursor are back');
    eq(String.fromCharCode(e.term.screen.get(0, 0).ch), 'H', 'ANSI: the last board\'s screen is left readable');
  }

  // ── a call that dies mid-sequence ─────────────────────────────────────────
  for (const [what, tail] of [['in a music string', '\x1B[MFT120O4C'], ['in a CSI', '\x1B[1;3'],
                              ['after ESC', '\x1B']]) {
    const e = rig(null);
    e.parser.feed(enc(tail));
    e.reset();
    e.term.cx = 0; e.term.cy = 0;
    e.parser.feed(enc('NO CARRIER'));
    eq(String.fromCharCode(...[0, 1, 2].map((c) => e.term.screen.get(c, 0).ch)), 'NO ',
       `a call that dropped ${what} does not swallow what is drawn next`);
  }

  // ── music queued at hang-up ───────────────────────────────────────────────
  {
    const e = rig(null);
    let stopped = 0;
    e.music._queue = [{ freq: 440 }];
    e.music._voices.add({ stop: () => stopped++ });
    e.music._playing = true;
    e.reset();
    eq([e.music._queue.length, stopped, e.music._playing], [0, 1, false],
       'ANSI music: the queue is emptied and a sounding note is stopped');
  }

  // ── PETSCII board, then ANSI board ────────────────────────────────────────
  {
    const e = rig(null);
    e.petscii.feed(Uint8Array.of(0x1C, 0x12, 0x0E));   // red, reverse on, shifted set
    e.parser.feed(enc('\x1B[1m'));
    e.reset();
    eq(attrs(e.term), ANSI_START,
       'PETSCII then ANSI: the next ANSI board draws in 7, not PETSCII\'s 15 or its colour');
  }

  // ── ANSI board, then PETSCII board (40 and 80) ────────────────────────────
  for (const colours of ['c40', 'c80']) {
    const e = rig({ emulation: 'petscii' }, colours);
    e.parser.feed(enc('\x1B[1;5;7;31m'));
    e.petscii.feed(Uint8Array.of(0x1C, 0x12, 0x0E));
    e.reset();
    eq(attrs(e.term), { ...ANSI_START, fg: START_ATTRS[colours] },
       `ANSI then PETSCII ${colours}: PETSCII's start attribute, no bold, no reverse, unshifted`);
    e.petscii.feed(Uint8Array.of(0x41));
    const c = e.term.screen.get(0, 0);
    eq([c.fg, c.bold, c.blink], [START_ATTRS[colours], false, false],
       `ANSI then PETSCII ${colours}: the first cell the board draws carries only that`);
  }

  // ── ANSI board, then ATASCII board ────────────────────────────────────────
  {
    const e = rig({ emulation: 'atascii' });
    e.parser.feed(enc('\x1B[1;5;44m'));
    e.atascii.feed(Uint8Array.of(0x1B));                // a board that left ESC mode armed
    e.atasciiKeys.encode('`');                          // and the typed inverse toggle on
    e.reset();
    eq(attrs(e.term), { ...ANSI_START, fg: ATASCII_ATTR }, 'ANSI then ATASCII: the Atari attribute and nothing else');
    eq([e.atascii._esc, e.atasciiKeys.inverse], [false, false], 'ANSI then ATASCII: ESC mode and inverse typing are off');
    // Every Atari index is the same ink, so a stray bold is invisible there — and
    // still makes a space non-blank to the re-flow trim.
    e.atascii.feed(enc('A   '));
    const bolds = [0, 1, 2, 3].map((c) => e.term.screen.get(c, 0).bold);
    eq(bolds, [false, false, false, false], 'ANSI then ATASCII: no bold on the cells, so trailing spaces stay blank');
  }

  // ── Topaz: an ANSI board with an Amiga face ───────────────────────────────
  {
    const e = rig({ emulation: undefined, charset: 'amiga' });
    e.petscii.feed(Uint8Array.of(0x1C, 0x0E));
    e.parser.feed(enc(DIRTY_ANSI));
    e.reset();
    eq([attrs(e.term), modes(e.term)], [ANSI_START, MODES_START], 'Topaz: ANSI defaults, like any ANSI font');
  }

  // ── the bold that changes re-flow ─────────────────────────────────────────
  {
    const e = rig(null);
    e.parser.feed(enc('\x1B[1m'));
    e.reset();
    e.parser.feed(enc('AB   \r\n'));
    e.term.reflow(40, 25);
    let n = 0; while (n < 40 && e.term.screen.get(n, 0).ch !== 32) n++;
    eq([n, e.term.screen.get(2, 0).bold], [2, false], 'a stale bold does not reach the next board\'s spaces');
  }

  console.log(`\n${fail ? 'FAILED' : 'OK'} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
