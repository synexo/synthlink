/*
 * fonts/charsets.js - what a byte MEANS, per font.
 *
 * A terminal font is a 256-cell atlas indexed by the raw byte, and terminal.js
 * never decodes anything: an encoding in this codebase is nothing more than the
 * table the ATLAS BUILDER consults to decide which character to draw into cell
 * i. Choose a different table and the same byte stream renders as a different
 * encoding, with no change to the draw path at all. That is the whole
 * mechanism; there is no decoder anywhere.
 *
 * SyncTERM works the same way, and states the reason in its manual: a font is
 * chosen "and by implication, a codepage". Its font table carries one codepage
 * per entry - every Amiga face is CIOLIB_ISO_8859_1, every IBM face CP437 - and
 * the received byte indexes the glyph directly either way.
 *
 * So a charset belongs to a FONT, not to a board and not to a session. A
 * registry entry with no `charset` field is CP437, which is every entry that
 * shipped before this file existed. That default is the whole compatibility
 * story: CP437.chars IS cp437.js's CP437_CHARS, CP437.isGraphics IS the
 * predicate fontscale.js has always used, and CP437.blank IS the two-position
 * test the atlas builder has always applied. Not equivalent - the same values.
 *
 * THE THREE FIELDS
 *
 * `chars`      256 single-character strings, for fillText.
 *
 * `isGraphics` which codepoints are line graphics, i.e. glyphs that must MEET
 *              their neighbours and so take the hard-edged blit path. This is a
 *              property of the encoding and not of any face - CP437 puts its
 *              shades, blocks and box drawing in one contiguous run at
 *              0xB0-0xDF, and Latin-1 has no such glyphs at all, only accented
 *              letters that must NOT be extended into their neighbours.
 *              classifyStretch()'s fully-inked clause still catches a face that
 *              draws outside whatever the encoding says.
 *
 * `blank`      positions with no printable character, which must come out empty
 *              rather than as .notdef boxes. CP437 has two (NUL and NBSP);
 *              Latin-1 has the C0 range, DEL, the C1 range and NBSP.
 *
 * SynthLink's own code, GPL-3.0-or-later.
 */

import { CP437_CHARS } from './cp437.js';
import { LATIN1_CHARS } from './latin1.js';

/**
 * CP437's line-graphics block: shades, blocks and every box-drawing character,
 * in one contiguous run. Lived in fontscale.js until there was more than one
 * encoding; its header there always said it was a property of CP437 rather than
 * of any font, which is why it is here now and re-exported from there.
 *
 * The dependency runs one way - charsets.js knows nothing about fontscale.js -
 * because fontscale.js has to ask which charset a font is on.
 */
export const GRAPHICS_FIRST = 0xB0;
export const GRAPHICS_LAST = 0xDF;

/**
 * CP437, and the DEFAULT for any font that does not name one.
 *
 * Every member here is the constant the code used before charsets existed, so
 * a font on this descriptor feeds the rasterizer byte-for-byte what it always
 * did.
 */
export const CP437 = {
  id: 'cp437',
  chars: CP437_CHARS,
  isGraphics: (c) => c >= GRAPHICS_FIRST && c <= GRAPHICS_LAST,
  // NUL and NBSP. The mapping itself stays a faithful transcription; the
  // blanking is policy and lives here. See cp437.js.
  blank: (i) => i === 0x00 || i === 0xFF,
};

/**
 * ISO-8859-1, the Amiga's set.
 *
 * `isGraphics` is constantly false, and deliberately: 0xB0-0xDF here is
 * `°±²³´µ¶·` through `ÀÁÂ…ß`, accented letters whose ink must stay inside its
 * own cell. Amiga art builds its rails and shading out of punctuation - the
 * macron, the middle dot, the not sign - which are letterform-shaped glyphs and
 * take the letterform path correctly. A face that does draw an edge-to-edge
 * glyph is still caught by the fully-inked clause in classifyStretch().
 */
export const LATIN1 = {
  id: 'latin1',
  chars: LATIN1_CHARS,
  isGraphics: () => false,
  blank: (i) => i < 0x20 || (i >= 0x7F && i <= 0xA0),
};

/**
 * The charset a font is drawn against.
 *
 * The `|| CP437` is load-bearing and is the reason this feature cannot reach
 * anything that shipped before it: no existing registry entry carries the
 * field, so every one of them resolves to the descriptor above, whose members
 * are the previous hardcoded constants. tools/tests/ttftest.js asserts that
 * resolution for every entry.
 */
export const charsetOf = (font) => (font && font.charset) || CP437;
