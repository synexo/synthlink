/*
 * fonts/atascii.js - the ATASCII encoding: which glyph a byte draws, and which
 * character it copies as.
 *
 * TWO TABLES, BECAUSE THE TWO HALVES OF ATASCII ARE ONE SET TWICE. On an Atari
 * a byte with bit 7 set is the same character as the byte without it, drawn in
 * inverse video - the glyph IS the inversion, not an attribute - and SyncTERM's
 * Atari font carries it that way: its cells 128-255 are the bit-for-bit inverse
 * of 0-127. So:
 *
 *   ATASCII_DRAW   the codepoint the atlas builder hands fillText. 0-127 are
 *                  real characters; 128-255 are U+E000 + byte, private-use
 *                  glyphs that tools/atasciisubset.py mints as the inverse of
 *                  their low-half twin. fillText needs 256 distinct codepoints
 *                  to draw 256 distinct cells, which is the only reason the
 *                  private-use half exists.
 *   ATASCII_TEXT   the character a selection copies as - the low half's
 *                  character for both halves, so inverse text reaches the
 *                  clipboard as text rather than as private-use codepoints.
 *
 * The low half is CTerm's `atascii_ext_table` (SyncTERM's utf8_codepages.c),
 * the table SyncTERM itself renders and copies ATASCII through. Four of its
 * codepoints are not in the upstream face under that number and are aliased to
 * the glyph that is pixel-identical - see tools/atasciisubset.py.
 *
 * DRAW 128-255 IS NOT "LOW HALF + 0xE000". Byte 0x9B is EOL, and CTerm's table
 * gives it NO-BREAK SPACE rather than ESCAPE's symbol; it still draws the
 * inverse of 0x1B's cell, because that is what SyncTERM's font holds there.
 * Copy follows CTerm's table; drawing follows its font.
 *
 * SynthLink's own code, GPL-3.0-or-later.
 */

/** Low half, 0x00-0x7F: CTerm's atascii_ext_table. */
const LOW = [
  0x2665, 0x251C, 0x1FB87, 0x2518, 0x2524, 0x2510, 0x2571, 0x2572,
  0x25E2, 0x2597, 0x25E3, 0x259D, 0x2598, 0x1FB82, 0x2582, 0x2596,
  0x2663, 0x250C, 0x2500, 0x253C, 0x2022, 0x2584, 0x258E, 0x252C,
  0x2534, 0x258C, 0x2514, 0x241B, 0x2191, 0x2193, 0x2190, 0x2192,
  0x0020, 0x0021, 0x0022, 0x0023, 0x0024, 0x0025, 0x0026, 0x0027,
  0x0028, 0x0029, 0x002A, 0x002B, 0x002C, 0x002D, 0x002E, 0x002F,
  0x0030, 0x0031, 0x0032, 0x0033, 0x0034, 0x0035, 0x0036, 0x0037,
  0x0038, 0x0039, 0x003A, 0x003B, 0x003C, 0x003D, 0x003E, 0x003F,
  0x0040, 0x0041, 0x0042, 0x0043, 0x0044, 0x0045, 0x0046, 0x0047,
  0x0048, 0x0049, 0x004A, 0x004B, 0x004C, 0x004D, 0x004E, 0x004F,
  0x0050, 0x0051, 0x0052, 0x0053, 0x0054, 0x0055, 0x0056, 0x0057,
  0x0058, 0x0059, 0x005A, 0x005B, 0x005C, 0x005D, 0x005E, 0x005F,
  0x2666, 0x0061, 0x0062, 0x0063, 0x0064, 0x0065, 0x0066, 0x0067,
  0x0068, 0x0069, 0x006A, 0x006B, 0x006C, 0x006D, 0x006E, 0x006F,
  0x0070, 0x0071, 0x0072, 0x0073, 0x0074, 0x0075, 0x0076, 0x0077,
  0x0078, 0x0079, 0x007A, 0x2660, 0x2502, 0x1F8B0, 0x25C0, 0x25B6,
];

/** The first private-use codepoint of the inverse half: byte b >= 0x80 draws U+E000 + b. */
export const ATASCII_INVERSE_BASE = 0xE000;

/** Codepoint the atlas draws for each byte. */
export const ATASCII_DRAW = Array.from({ length: 256 }, (_, b) =>
  b < 0x80 ? LOW[b] : ATASCII_INVERSE_BASE + b);

/** Codepoint a selection copies as. The high half is the low half, except 0x9B. */
export const ATASCII_TEXT = Array.from({ length: 256 }, (_, b) =>
  b === 0x9B ? 0x00A0 : LOW[b & 0x7F]);

export const ATASCII_DRAW_CHARS = ATASCII_DRAW.map((c) => String.fromCodePoint(c));
export const ATASCII_TEXT_CHARS = ATASCII_TEXT.map((c) => String.fromCodePoint(c));

/**
 * Line graphics: the cells whose ink must MEET their neighbours.
 *
 * The box and block characters of the low control range, the bar at 0x7C, and
 * the WHOLE inverse half - an inverse cell is a filled background with a
 * letter cut out of it, so every one of them reaches all four edges, and a
 * seam between two inverse cells is a visible stripe through a highlighted
 * word. The fully-inked clause in classifyStretch() would catch most of them
 * anyway; stating it here means none depends on that.
 *
 * Deliberately NOT graphics: 0x14 (a disc), 0x1B-0x1F (ESC's symbol and the
 * arrows), 0x60 and 0x7B (diamond, spade), 0x10 (club), 0x00 (heart) and
 * 0x7D-0x7F - symbols with their own margins, which must stay inside the cell.
 */
const LOW_GRAPHICS = new Set([
  0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B, 0x0C,
  0x0D, 0x0E, 0x0F, 0x11, 0x12, 0x13, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1A,
  0x7C,
]);
export const atasciiIsGraphics = (b) => b >= 0x80 || LOW_GRAPHICS.has(b);

/** Only the space draws nothing. 0xA0 is its inverse - a full cell - and is ink. */
export const atasciiBlank = (b) => b === 0x20;
