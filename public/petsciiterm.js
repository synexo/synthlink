/*
 * petsciiterm.js — the PETSCII terminal DIALECT: parser, colour maps, palette.
 *
 * fonts/petscii.js is the ENCODING — which character a byte means, in each of
 * the two sets. This file is the other half: what a C64 board's control bytes
 * DO. They are different questions and they have different authorities, which
 * is why they are different files. The encoding's authority is the C64
 * character ROM; this file's is SyncTERM's CTerm, because CTerm is what BBS
 * authors write against and it diverges from the hardware deliberately in
 * places. PETSCII.md has the argument at length.
 *
 * THERE IS NO ANSI HERE, AND THAT IS THE POINT. A capture of a full session on
 * a real PETSCII board (WORD BBS, 4350 bytes, connect to logoff) contains not
 * one ESC byte. Colour, reverse video, six cursor movements, insert/delete and
 * the charset switch are the entire vocabulary — there are no escape sequences
 * and no cursor addressing at all. So this is a flat byte dispatcher rather
 * than a state machine, and it does not share ANSIParser's shape because it has
 * no state to be in.
 *
 * WHY A SECOND PARSER RATHER THAN A BRANCH IN ANSIParser. A board is in PETSCII
 * mode or it is not — the mode is settled by the config/altfonts.txt entry
 * before the dial, the same entry that settles the font and the column count —
 * so the two never interleave and there is nothing for a shared state machine
 * to arbitrate. Branching inside ANSIParser would put a test on every byte of
 * every ANSI call to serve boards that never send one, and would make the
 * ANSI path's behaviour depend on a flag it has no other reason to read.
 *
 * SynthLink's own code, GPL-3.0-or-later.
 */

/**
 * The sixteen Commodore colours, in CTerm's own attribute order.
 *
 * NOT the C64's hardware order and NOT ANSI's. CTerm assigns its own attribute
 * numbers — white is 1, red 2, cyan 3 — and the PETSCII colour byte is mapped
 * into them by the tables below. This array is indexed by that attribute.
 *
 * The values are the COLODORE palette, and they were measured rather than
 * looked up: twelve of the sixteen appear on a SyncTERM screenshot of the
 * target board and every one of the twelve matches Colodore exactly. The four
 * that do not appear on that screen — yellow, orange, brown and light red — are
 * Colodore's own, taken on the strength of the twelve.
 */
export const C64_PALETTE = [
  '#000000',   //  0 black
  '#FFFFFF',   //  1 white
  '#813338',   //  2 red
  '#75CEC8',   //  3 cyan
  '#8E3C97',   //  4 purple
  '#56AC4D',   //  5 green
  '#2E2C9B',   //  6 blue
  '#EDF171',   //  7 yellow
  '#8E5029',   //  8 orange
  '#553800',   //  9 brown
  '#C46C71',   // 10 light red
  '#4A4A4A',   // 11 dark grey
  '#7B7B7B',   // 12 grey
  '#A9FF9F',   // 13 light green
  '#706DEB',   // 14 light blue
  '#B2B2B2',   // 15 light grey
];

/**
 * PETSCII colour byte -> CTerm attribute, and there are TWO of these.
 *
 * The same colour byte produces a different attribute in 40-column mode
 * (C64 / C128-40) than in 80-column mode (C128-80): white is 1 at forty columns
 * and 15 at eighty, red is 2 then 4, cyan 3 then 11. That is not a quirk to
 * normalise away — it is the machines' own difference, and it is the strongest
 * reason the registry carries `petscii40` and will carry `petscii80` as
 * separate entries rather than one entry with a width.
 *
 * Only `c40` is reachable today; `c80` is here because it is the same table
 * from the same source and splitting them across two sessions is how the second
 * one gets transcribed differently.
 *
 * A byte with no entry is not a colour byte and is never looked up — the
 * dispatcher tests membership first.
 */
const COLOUR_C40 = {
  5: 1, 28: 2, 30: 5, 31: 6, 129: 8, 144: 0, 149: 9, 150: 10,
  151: 11, 152: 12, 153: 13, 154: 14, 155: 15, 156: 4, 158: 7, 159: 3,
};

const COLOUR_C80 = {
  5: 15, 28: 4, 30: 2, 31: 1, 129: 5, 144: 0, 149: 6, 150: 12,
  151: 3, 152: 8, 153: 10, 154: 9, 155: 7, 156: 13, 158: 14, 159: 11,
};

export const COLOUR_MAPS = { c40: COLOUR_C40, c80: COLOUR_C80 };

/**
 * The attribute a Commodore mode starts in: 15, light grey at forty columns.
 *
 * CTerm sets this explicitly for every Commodore mode rather than inheriting
 * the terminal's normal attribute, so a board that draws before it sends a
 * colour byte gets the machine's own default rather than ours.
 */
export const C64_START_ATTR = 15;

/** The charset pages, in the order fonts/index.js lists them for a PETSCII font. */
export const PAGE_UNSHIFTED = 0;
export const PAGE_SHIFTED = 1;

/**
 * Fold a PETSCII byte onto its SCREEN CODE, then back to the canonical byte
 * that names the same glyph.
 *
 * PETSCII has two ECHO ranges: 0x60-0x7F and 0xE0-0xFE are copies of 0xC0-0xDF
 * and 0xA0-0xBE, and 0xFF is a copy of 0xDE. CTerm resolves them by folding to
 * a screen code before it draws. We keep the raw byte in the cell — that is
 * what a menu-key click sends and what copy decodes — so the fold happens at
 * the moment of drawing instead, and this returns the byte the atlas is indexed
 * by rather than the screen code itself.
 *
 * The capture proves this is load-bearing rather than theoretical: the echo
 * range appears eleven times in one session.
 */
export function canonicalByte(b) {
  if (b >= 0x60 && b <= 0x7F) return b + 0x60;        // -> 0xC0-0xDF
  if (b >= 0xE0 && b <= 0xFE) return b - 0x40;        // -> 0xA0-0xBE
  if (b === 0xFF) return 0xDE;
  return b;
}

/**
 * What a named non-printing key SENDS on a PETSCII board.
 *
 * The send direction, and it is not symmetrical with the receive one: CTerm
 * carries a small key table (`petscii_keys`) and passes everything not in it
 * through RAW and unchanged — `raw_lo = 0, raw_hi = 256` — with no case
 * swapping. So this answers for the named keys and nothing else; an ordinary
 * character never reaches here.
 *
 * THREE RETURN VALUES, and the third is the reason this is a function rather
 * than a table:
 *
 *   a string   these bytes, which is CTerm's table
 *   null       this key sends NOTHING. A C64 has no Page Up and no F9, and the
 *              ANSI answer for one is an escape sequence — `ESC [ 5 ~`. PETSCII
 *              drops the ESC and then PRINTS `[ 5 ~` into the board's input,
 *              which is worse than silence. CTerm reaches the same place by a
 *              different route: those keys are above 255 and its raw passthrough
 *              only covers 0-255.
 *   undefined  not this dialect's business — let the ANSI table answer. Only
 *              `Break` takes it, because IAC BRK is telnet and terminates at the
 *              server; it is not a character in any encoding.
 *
 * MODIFIERS ARE IGNORED, deliberately. CTerm looks its table up on the key
 * alone, so Shift+Left is Left. The ANSI path's modifier encoding would put
 * `ESC [ 1 ; 2 D` on the wire, and the paragraph above applies to that too.
 *
 * Backspace is the one that shows: it is `0x7F` on the ANSI path (deliberate,
 * and right there), but `0x7F` is a PRINTABLE character in PETSCII — CTerm
 * marks only 0x00-0x1F and 0x80-0x9F as control — so a board echoes it and the
 * terminal correctly draws a filled corner. `0x14` is PETSCII's own destructive
 * backspace and is what the receive half already implements.
 */
const PETSCII_KEYS = {
  Backspace:  '\x14',    // DEL — the wrapping backspace, not ASCII BS
  Delete:     '\x14',    // CIO_KEY_DC maps to the same byte
  Insert:     '\x94',
  Enter:      '\x0D',    // stated rather than inherited: the ANSI path's '\r'
                         // happens to be the same byte, which is not a reason
  Home:       '\x13',
  End:        '\x93',    // CLR — the C64's shifted HOME
  ArrowUp:    '\x91',
  ArrowDown:  '\x11',
  ArrowLeft:  '\x9D',
  ArrowRight: '\x1D',
  F1: '\x85', F2: '\x89', F3: '\x86', F4: '\x8A',
  F5: '\x87', F6: '\x8B', F7: '\x88', F8: '\x8C',
  // Raw passthrough, which is what CTerm does with any key value under 256.
  // Named here so the ANSI path's MODIFIED forms cannot leak through: Shift+Tab
  // is `ESC [ Z` there, and on a C64 board that prints `[ Z`.
  Tab:        '\t',
  Escape:     '\x1B',
  // No PETSCII meaning and no raw byte: a C64 keyboard has none of these.
  PageUp: null, PageDown: null,
  F9: null, F10: null, F11: null, F12: null,
};

export function petsciiNamedSeq(name) {
  return Object.prototype.hasOwnProperty.call(PETSCII_KEYS, name)
    ? PETSCII_KEYS[name] : undefined;
}

/** The table itself, for the harness. Read-only by convention. */
export const PETSCII_KEY_TABLE = PETSCII_KEYS;

/**
 * A typed character -> the byte a C64 KEYBOARD would have produced for it.
 *
 * PETSCII does not put its letters where ASCII does, and this is the whole of
 * the difference. In the shifted (lower/upper) set — the one a board selects
 * with 0x0E and the one nearly all of them run in — 0x41-0x5A is LOWERCASE and
 * 0xC1-0xDA is UPPERCASE. A real C64 keyboard sends 0x41 for the unshifted A key
 * and 0xC1 for SHIFT+A. A PC keyboard hands us ASCII: 0x61 unshifted, 0x41
 * shifted. Sent raw, every letter arrives one case out — type `a`, the board
 * echoes `A`.
 *
 * So: a-z -> 0x41-0x5A, A-Z -> 0xC1-0xDA. Everything else is left alone,
 * because PETSCII agrees with ASCII across 0x20-0x3F and the digits.
 *
 * IT IS RIGHT IN BOTH SETS, which is what makes it a mapping rather than a
 * guess, and is why it does not consult the shift state the board is in — a
 * real keyboard cannot see that either. In the shifted set 0x41 draws `a` and
 * 0xC1 draws `A`. In the UNSHIFTED (upper/graphics) set 0x41 draws `A`, the only
 * case that set has, and 0xC1 draws the spade — which is exactly what SHIFT+A
 * puts on the screen of a C64 in uppercase mode.
 *
 * A DELIBERATE DIVERGENCE FROM OUR REFERENCE. CTerm's `cterm_encode_key_ex`
 * passes any key value under 256 through raw, with no case handling at all, so
 * either SyncTERM does this in a keyboard layer below cterm.c or it has the same
 * inversion. Taking the hardware's behaviour regardless: it is what the board is
 * written against, it is what makes a login name match, and it is what SyncTERM
 * is observed to do in practice.
 */
export function petsciiEncodeByte(b) {
  if (b >= 0x61 && b <= 0x7A) return b - 0x20;        // a-z -> 0x41-0x5A
  if (b >= 0x41 && b <= 0x5A) return b + 0x80;        // A-Z -> 0xC1-0xDA
  return b;
}

/** petsciiEncodeByte over a whole string, to the bytes that go on the wire. */
export function petsciiEncode(str) {
  return Uint8Array.from(str, (c) => petsciiEncodeByte(c.charCodeAt(0) & 0xFF));
}

/**
 * PETSCII parser. Same surface as ANSIParser — construct with a Terminal,
 * call feed(bytes) — so main.js can hold one of each and route to it.
 *
 * @param {object} terminal  a Terminal
 * @param {object} [opts]    { colours: 'c40' | 'c80' }
 */
export class PETSCIIParser {
  constructor(terminal, opts = {}) {
    this.term = terminal;
    this.colours = COLOUR_MAPS[opts.colours] || COLOUR_C40;
    // Reverse video is an ATTRIBUTE here, not a glyph. CTerm's current source
    // returns `(attr >> 4 | attr << 4)` — foreground and background exchanged —
    // having previously drawn the ROM's pre-inverted glyph at screencode+128.
    // The two are identical for a fully-painted 8x8 cell, and the attribute
    // form is what this terminal already has, so the atlas does not double for
    // it and BESCII needs no reversed glyphs.
    this.reverse = false;
    this.reset();
  }

  /** Put the dialect's own state back. Called on construction and at cleanup. */
  reset() {
    this.reverse = false;
    this._fg = C64_START_ATTR;
    this.term.charPage = PAGE_UNSHIFTED;
    this._push();
  }

  feed(bytes) { for (let i = 0; i < bytes.length; i++) this._consume(bytes[i]); }

  _consume(b) {
    const t = this.term;

    // The control ranges. CTerm marks EVERY byte of 0x00-0x1F and 0x80-0x9F as
    // a control, and silently drops the ones it has no handler for — so a
    // reserved byte is swallowed rather than drawn as garbage. The capture has
    // 0x08 twice and 0x09 three times, which is exactly that case arriving in
    // practice.
    if (b < 0x20 || (b >= 0x80 && b <= 0x9F)) {
      const c = this.colours[b];
      if (c !== undefined) { this._setColour(c); return; }

      switch (b) {
        case 0x07: t.bell(); return;                          // beep

        // 0x0D clears reverse and 0x8D does not, and that difference is
        // deliberate: CTerm's older source ran both through one case whose
        // comment said reverse was cleared while its body did not, and the
        // current source splits them with the comment's behaviour. Hardware
        // agrees with the comment.
        case 0x0D: this._setReverse(false); this._cr(); return;
        case 0x8D: this._cr(); return;

        case 0x11: this._down(); return;                      // cursor down, scrolls
        case 0x91: if (t.cy > 0) t.cy--; return;              // cursor up, never scrolls
        case 0x1D: this._right(); return;                     // cursor right, wraps
        case 0x9D: this._left(); return;                      // cursor left, wraps
        case 0x13: t.cx = 0; t.cy = 0; return;                // home
        case 0x93: t.eraseDisplay(2); t.cx = 0; t.cy = 0; return;   // clear + home
        case 0x14: this._delete(); return;                    // wrapping backspace
        case 0x94: this._insert(); return;                    // insert, erase under
        case 0x12: this._setReverse(true); return;
        case 0x92: this._setReverse(false); return;
        case 0x0E: t.charPage = PAGE_SHIFTED; return;         // lower-case set
        case 0x8E: t.charPage = PAGE_UNSHIFTED; return;       // upper/graphics set
        default: return;                                      // reserved: dropped
      }
    }

    // Printable. The byte stored is the CANONICAL one, so the two echo ranges
    // land on the glyph they are copies of; `_wrapped[]` and the page flag are
    // maintained by putChar as they are for any other font.
    t.putChar(canonicalByte(b));
  }

  // ── Attributes ────────────────────────────────────────────────────────────

  _setColour(attr) {
    this._fg = attr;
    this._push();
  }

  _setReverse(on) {
    this.reverse = !!on;
    this._push();
  }

  /**
   * Push the dialect's colour state into the Terminal's fg/bg.
   *
   * Reverse is the swap, and the background is otherwise always 0: a C64 has
   * ONE screen background and reverse video is how a cell comes out filled. So
   * `fg` is the colour byte's attribute and `bg` is the screen — exchanged when
   * reverse is on, which is bit-for-bit what drawing the ROM's inverted glyph
   * produced.
   */
  _push() {
    const t = this.term;
    const fg = this._fg;
    if (this.reverse) { t.fgColor = 0; t.bgColor = fg; }
    else { t.fgColor = fg; t.bgColor = 0; }
  }

  // ── Movement ──────────────────────────────────────────────────────────────
  // Written against CTerm's own handlers rather than against this terminal's
  // ANSI equivalents, because the two disagree in ways that matter: PETSCII's
  // cursor-right WRAPS and scrolls where ANSI's clamps at the margin, and
  // PETSCII's cursor-up never scrolls where ANSI's is bounded by the scroll
  // region. Reaching for cursorRight()/cursorUp() here would look tidier and be
  // wrong.

  _cr() { const t = this.term; t.cx = 0; this._down(); }

  _down() {
    const t = this.term;
    if (t.cy >= t.rows - 1) t.scrollUp(1);
    else t.cy++;
    t._wrapPending = false;
  }

  _right() {
    const t = this.term;
    if (t.cx >= t.cols - 1) { t.cx = 0; this._down(); }
    else t.cx++;
  }

  _left() {
    const t = this.term;
    if (t.cx > 0) { t.cx--; return; }
    if (t.cy > 0) { t.cx = t.cols - 1; t.cy--; }
  }

  /** 0x14 — a wrapping backspace that pulls the rest of the row left. */
  _delete() {
    const t = this.term;
    if (t.cx === 0) {
      if (t.cy === 0) return;
      t.cy--; t.cx = t.cols - 1;
    } else {
      t.cx--;
    }
    for (let c = t.cx; c < t.cols - 1; c++) {
      t.screen.get(c, t.cy).copyFrom(t.screen.get(c + 1, t.cy));
    }
    t.screen.get(t.cols - 1, t.cy).clear(t.fgColor, 0);
    // A row whose tail has been pulled left is no longer a continuation of
    // itself — the same rule every erase path here follows.
    t._wrapped[t.cy] = false;
  }

  /** 0x94 — push the row right and blank the cell under the cursor. */
  _insert() {
    const t = this.term;
    for (let c = t.cols - 1; c > t.cx; c--) {
      t.screen.get(c, t.cy).copyFrom(t.screen.get(c - 1, t.cy));
    }
    t.screen.get(t.cx, t.cy).clear(t.fgColor, 0);
    t._wrapped[t.cy] = false;
  }
}
