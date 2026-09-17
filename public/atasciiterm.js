/*
 * atasciiterm.js — the ATASCII terminal DIALECT: parser, key encoding, palette.
 *
 * fonts/atascii.js is the ENCODING — which glyph a byte draws. This file is what
 * an Atari board's control bytes DO. The authority is SyncTERM's CTerm
 * (cterm_atascii.c and the ATASCII rows of cterm.c / utf8_codepages.c), because
 * CTerm is what a BBS is tested against, and it is followed here where it
 * departs from the hardware — most visibly in ESC mode, below.
 *
 * NO ESCAPE SEQUENCES. Every operation is one byte, so this is a flat
 * dispatcher like petsciiterm.js, and a separate parser for the reason that
 * file gives: a board is in ATASCII mode or it is not, settled by the font id
 * before the dial.
 *
 * SynthLink's own code, GPL-3.0-or-later.
 */

/**
 * CTerm's ATARI_PALETTE: attribute 0 is the screen, every other index is the
 * ink. So the normal attribute (7) and ESC mode's "inverse" attribute (1) draw
 * the SAME two colours — inverse video on an Atari is in the glyph, never in the
 * colour, and bytes 0x80-0xFF already carry it.
 */
const ATARI_BG = '#005181';
const ATARI_FG = '#60B7E7';
export const ATARI_PALETTE = [ATARI_BG, ...Array(15).fill(ATARI_FG)];

export const ATASCII_ATTR = 7;
export const ATASCII_ESC_ATTR = 1;

export const EOL = 0x9B;

/**
 * ESC mode's translation: ATASCII to the Atari's internal screen code.
 *
 * CTerm stores the TRANSLATED value in the cell, and the cell indexes a font
 * laid out in ATASCII order — so ESC + 'A' (0x41) draws cell 0x21, '!'. A real
 * Atari's ESC shows the next byte's own glyph instead. The owner chose CTerm's
 * behaviour; this function is that choice, verbatim.
 */
export function atasciiEscTranslate(b) {
  if (b < 32) return b + 64;
  if (b < 96) return b - 32;
  if (b < 128) return b;
  if (b < 160) return b + 64;
  if (b < 224) return b - 32;
  return b;
}

/** CTerm's default tab stops, 1,9,17…145 one-based, here zero-based. */
const DEFAULT_TABS = Array.from({ length: 19 }, (_, i) => i * 8);

export class ATASCIIParser {
  constructor(terminal) {
    this.term = terminal;
    this.reset();
  }

  /**
   * The dialect's own state back to power-on. Called on construction and at
   * cleanup, so it leaves the shared Terminal alone — that belongs to whichever
   * emulation is active.
   */
  reset() {
    this._esc = false;
    this.tabs = new Set(DEFAULT_TABS);
  }

  /** Becoming the active emulation: the Atari's attribute and a single page. */
  enter() {
    this.reset();
    this._attr(ATASCII_ATTR);
    this.term.charPage = 0;
  }

  feed(bytes) { for (let i = 0; i < bytes.length; i++) this._consume(bytes[i]); }

  _attr(a) { this.term.fgColor = a; this.term.bgColor = 0; }

  _consume(b) {
    const t = this.term;

    // ESC quotes the next byte. EOL alone keeps its meaning, as in CTerm.
    if (this._esc) {
      this._esc = false;
      if (b === EOL) this._eol();
      else t.putChar(atasciiEscTranslate(b));
      this._attr(ATASCII_ATTR);
      return;
    }

    switch (b) {
      case 0x1B: this._esc = true; this._attr(ATASCII_ESC_ATTR); return;
      case 0x1C: t.cy = t.cy > 0 ? t.cy - 1 : t.rows - 1; return;          // up, wraps
      case 0x1D: t.cy = t.cy < t.rows - 1 ? t.cy + 1 : 0; return;          // down, wraps
      case 0x1E: t.cx = t.cx > 0 ? t.cx - 1 : t.cols - 1; return;          // left, wraps in row
      case 0x1F: t.cx = t.cx < t.cols - 1 ? t.cx + 1 : 0; return;          // right, wraps in row
      case 0x7D: t.eraseDisplay(2); t.cx = 0; t.cy = 0; return;            // clear + home
      case 0x7E: this._backspace(); return;
      case 0x7F: this._tab(); return;
      case EOL:  this._eol(); return;
      case 0x9C: t.deleteLines(1); t.cx = 0; return;
      case 0x9D: t.insertLines(1); t.cx = 0; return;
      case 0x9E: this.tabs.delete(t.cx); return;
      case 0x9F: this.tabs.add(t.cx); return;
      case 0xFD: t.bell(); return;
      case 0xFE: t.deleteChars(1); t._wrapped[t.cy] = false; return;
      case 0xFF: t.insertChars(1); t._wrapped[t.cy] = false; return;
      default:   t.putChar(b);
    }
  }

  /** EOL: column 0 of the next row, scrolling at the bottom. */
  _eol() {
    const t = this.term;
    t.cx = 0;
    if (t.cy >= t.rows - 1) t.scrollUp(1);
    else t.cy++;
    t._wrapPending = false;
  }

  /** 0x7E: left one and erase there. Sticks at the margin rather than wrapping. */
  _backspace() {
    const t = this.term;
    if (t.cx === 0) return;
    t.cx--;
    t.screen.get(t.cx, t.cy).clear(t.fgColor, t.bgColor);
  }

  /** 0x7F: the next stop to the right, or column 0 of the next row if none is left. */
  _tab() {
    const t = this.term;
    let next = -1;
    for (const s of this.tabs) if (s > t.cx && (next < 0 || s < next)) next = s;
    if (next < 0 || next > t.cols - 1) this._eol();
    else t.cx = next;
  }
}

/**
 * What a named key SENDS on an ATASCII board: CTerm's `atascii_keys` plus the
 * ciolib codepage rows for Backspace, Tab and Enter. `null` sends nothing — a
 * key above 255 has no raw byte in CTerm, and the ANSI answer would print its
 * tail into the board's input. `undefined` defers to the ANSI table (Break,
 * which is telnet). Modifiers are ignored, as CTerm ignores them.
 *
 * The values are TEXT, because main.js sends a key's sequence through the same
 * encoder as typing: Enter is CR and Tab is TAB, and ATASCIIKeys.encode() turns
 * them into EOL and 0x7F exactly as ciolib does for a typed one.
 */
const ATASCII_KEYS = {
  Backspace:  '\b',      // -> 0x7E
  Delete:     '\b',      // CTerm's CIO_KEY_DC row is 0x7E too
  Insert:     '\xFF',    // raw
  Enter:      '\r',      // -> 0x9B
  Tab:        '\t',      // -> 0x7F
  Escape:     '\x1B',
  ArrowUp:    '\x1C',
  ArrowDown:  '\x1D',
  ArrowLeft:  '\x1E',
  ArrowRight: '\x1F',
  Home: null, End: null, PageUp: null, PageDown: null,
  F1: null, F2: null, F3: null, F4: null, F5: null, F6: null,
  F7: null, F8: null, F9: null, F10: null, F11: null, F12: null,
};

export function atasciiNamedSeq(name) {
  return Object.prototype.hasOwnProperty.call(ATASCII_KEYS, name)
    ? ATASCII_KEYS[name] : undefined;
}

export const ATASCII_KEY_TABLE = ATASCII_KEYS;

/** ciolib's Unicode → ATASCII rows for the control characters a string can carry. */
const TYPED = { 0x07: 0xFD, 0x08: 0x7E, 0x09: 0x7F, 0x0D: 0x9B, 0x7F: 0xFE };

/**
 * Typed text → bytes, with SyncTERM's inverse-typing toggle.
 *
 * The backtick is the Atari's inverse key in CTerm: it toggles a flag and sends
 * nothing. With the flag set, a printable character goes out with bit 7 set —
 * the inverse glyph, which is what that key does on the machine.
 *
 * A code unit from 0x80 to 0xFF goes out as that byte, as it does on the ANSI
 * path; Insert's 0xFF depends on it. Anything above 0xFF has no byte and is '?'.
 */
export class ATASCIIKeys {
  constructor() { this.inverse = false; }
  reset() { this.inverse = false; }

  encode(str) {
    const out = [];
    for (const ch of str) {
      const c = ch.codePointAt(0);
      if (c === 0x60) { this.inverse = !this.inverse; continue; }
      if (Object.prototype.hasOwnProperty.call(TYPED, c)) { out.push(TYPED[c]); continue; }
      let b = c <= 0xFF ? c : 0x3F;
      if (this.inverse && b >= 0x20 && b < 0x7D) b |= 0x80;
      out.push(b);
    }
    return Uint8Array.from(out);
  }
}
