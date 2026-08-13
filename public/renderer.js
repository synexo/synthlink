/**
 * renderer.js — artifact-free Canvas terminal renderer
 *
 * ARTIFACT FIX
 * ============
 * Old design drew cursor/selection as overlays on the main canvas and relied
 * on dirty-cell skipping to avoid re-drawing them. This caused two bugs:
 *
 *   1. Cursor artifact: when the cursor moves or blinks off, the _lastDrawn
 *      cache thinks the old cursor cell is "clean" and skips it, leaving the
 *      inverted cursor pixels behind permanently.
 *
 *   2. Selection artifact / brightening: selection was drawn with
 *      source-over every frame onto cells that weren't re-drawn first.
 *      Each click re-applied the semi-transparent blue on top of itself,
 *      accumulating brightness.
 *
 * Fix: maintain _prevCursorCol/Row.  Every frame, force-redraw both the old
 * and new cursor cells from the cell buffer (clean pixel data), THEN draw the
 * cursor on top.  Selection cells are always force-redrawn before the overlay.
 *
 * TINTING PIPELINE
 * ================
 * One OffscreenCanvas per (fg, bg) colour pair, max 256 total.
 *   1. Fill with bgColor.
 *   2. Second canvas: fill with fgColor, then destination-in with font sheet
 *      (keeps fg pixels only where glyph bitmap is opaque).
 *   3. Composite fg-masked canvas over bg canvas.
 */

import { buildFontSheet } from './font.js';

export const VGA_PALETTE = [
  '#000000','#AA0000','#00AA00','#AA5500',
  '#0000AA','#AA00AA','#00AAAA','#AAAAAA',
  '#555555','#FF5555','#55FF55','#FFFF55',
  '#5555FF','#FF55FF','#55FFFF','#FFFFFF',
];

export const CHAR_W = 8;
export const CHAR_H = 16;

export class Renderer {
  constructor(canvas, cols, rows) {
    this.canvas = canvas;
    this.ctx    = canvas.getContext('2d');
    this.cols   = cols;
    this.rows   = rows;
    this.canvas.width  = cols * CHAR_W;
    this.canvas.height = rows * CHAR_H;

    this._fontSheet    = null;
    this._tintedSheets = new Map();

    // Packed per-cell "last drawn" cache. -1 = never drawn.
    // pack = ch | (fg<<8) | (bg<<12)
    this._lastDrawn = new Int32Array(cols * rows).fill(-1);

    // Previous cursor position — must be force-redrawn to erase cursor artifact
    this._prevCursorCol = -1;
    this._prevCursorRow = -1;

    this._built = false;
  }

  async init() {
    this._fontSheet = buildFontSheet(CHAR_W, CHAR_H);
    this._built = true;
  }

  /**
   * Draw one complete frame.
   * @param {Array}   cells
   * @param {number}  cursorCol
   * @param {number}  cursorRow
   * @param {boolean} cursorVisible
   * @param {boolean} cursorOn      blink phase
   * @param {boolean} blinkPhase
   * @param {object|null} selection { start:[r,c], end:[r,c] }
   */
  drawFrame(cells, cursorCol, cursorRow, cursorVisible, cursorOn,
            blinkPhase, selection) {
    if (!this._built) return;
    const { ctx, cols, rows } = this;

    // Build force-redraw set: cursor cells + selection cells
    const force = new Uint8Array(cols * rows);

    // Always redraw old and new cursor positions
    if (this._prevCursorRow >= 0) {
      force[this._prevCursorRow * cols + this._prevCursorCol] = 1;
    }
    if (cursorVisible && cursorOn && cursorRow >= 0 && cursorRow < rows) {
      force[cursorRow * cols + cursorCol] = 1;
    }

    // Always redraw selection cells (so overlay doesn't accumulate)
    if (selection) {
      this._markSelection(force, selection, cols, rows);
    }

    // Draw dirty / changed / forced cells
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const idx  = row * cols + col;
        const cell = cells[idx];

        let fg = cell.fg & 15;
        let bg = cell.bg & 15;
        if (cell.bold) fg = (fg | 8) & 15;
        if (cell.blink && !blinkPhase) fg = bg; // blink-off

        const pack = cell.ch | (fg << 8) | (bg << 12);
        if (!force[idx] && !cell.dirty && this._lastDrawn[idx] === pack) continue;

        this._blitCell(ctx, col, row, cell.ch, fg, bg);
        this._lastDrawn[idx] = pack;
        cell.dirty = false;
      }
    }

    // Draw cursor (inverted cell) — AFTER the regular cell pass
    if (cursorVisible && cursorOn && cursorRow >= 0 && cursorRow < rows &&
        cursorCol >= 0 && cursorCol < cols) {
      const cell = cells[cursorRow * cols + cursorCol];
      let fg = cell.fg & 15;
      let bg = cell.bg & 15;
      if (cell.bold) fg = (fg | 8) & 15;
      this._blitCell(ctx, cursorCol, cursorRow, cell.ch, bg, fg); // inverted
      this._prevCursorCol = cursorCol;
      this._prevCursorRow = cursorRow;
    } else {
      this._prevCursorCol = -1;
      this._prevCursorRow = -1;
    }

    // Draw selection overlay — cells were already redrawn cleanly above
    if (selection) {
      this._drawSelectionOverlay(ctx, selection, cols, rows);
    }
  }

  invalidateAll() {
    this._lastDrawn.fill(-1);
    this._prevCursorCol = -1;
    this._prevCursorRow = -1;
  }

  /**
   * Invalidate only the cells covered by a selection region so they are
   * redrawn cleanly on the next frame (erasing the selection overlay).
   * Called when the selection is cleared after mouseup.
   * @param {[number,number]|null} start  [row, col]
   * @param {[number,number]|null} end    [row, col]
   */
  invalidateSelection(start, end) {
    if (!start || !end) return;
    let [r1, c1] = start, [r2, c2] = end;
    if (r1 > r2 || (r1 === r2 && c1 > c2)) { [r1, c1, r2, c2] = [r2, c2, r1, c1]; }
    for (let r = Math.max(0, r1); r <= Math.min(this.rows - 1, r2); r++) {
      const cs = r === r1 ? c1 : 0;
      const ce = r === r2 ? c2 : this.cols - 1;
      for (let c = Math.max(0, cs); c <= Math.min(this.cols - 1, ce); c++) {
        this._lastDrawn[r * this.cols + c] = -1;
      }
    }
  }

  resize(cols, rows) {
    this.cols = cols; this.rows = rows;
    this.canvas.width  = cols * CHAR_W;
    this.canvas.height = rows * CHAR_H;
    this._lastDrawn = new Int32Array(cols * rows).fill(-1);
    this._tintedSheets.clear();
    this._prevCursorCol = -1;
    this._prevCursorRow = -1;
  }

  // ── Private ───────────────────────────────────────────────────────────────

  _blitCell(ctx, col, row, ch, fg, bg) {
    const sheet = this._sheet(fg & 15, bg & 15);
    ctx.drawImage(sheet, (ch & 255) * CHAR_W, 0, CHAR_W, CHAR_H,
                  col * CHAR_W, row * CHAR_H, CHAR_W, CHAR_H);
  }

  _sheet(fg, bg) {
    const key = (fg << 4) | bg;
    let s = this._tintedSheets.get(key);
    if (!s) { s = this._buildSheet(VGA_PALETTE[fg], VGA_PALETTE[bg]); this._tintedSheets.set(key, s); }
    return s;
  }

  _buildSheet(fgHex, bgHex) {
    const W = 256 * CHAR_W, H = CHAR_H;
    const bg = new OffscreenCanvas(W, H);
    const bc = bg.getContext('2d');
    bc.fillStyle = bgHex;
    bc.fillRect(0, 0, W, H);

    const fg = new OffscreenCanvas(W, H);
    const fc = fg.getContext('2d');
    fc.fillStyle = fgHex;
    fc.fillRect(0, 0, W, H);
    fc.globalCompositeOperation = 'destination-in';
    fc.drawImage(this._fontSheet, 0, 0);

    bc.drawImage(fg, 0, 0);
    return bg;
  }

  _markSelection(force, { start, end }, cols, rows) {
    let [r1, c1] = start, [r2, c2] = end;
    if (r1 > r2 || (r1 === r2 && c1 > c2)) { [r1,c1,r2,c2] = [r2,c2,r1,c1]; }
    for (let r = Math.max(0,r1); r <= Math.min(rows-1,r2); r++) {
      const cs = r===r1 ? c1 : 0, ce = r===r2 ? c2 : cols-1;
      for (let c = Math.max(0,cs); c <= Math.min(cols-1,ce); c++) {
        force[r * cols + c] = 1;
      }
    }
  }

  _drawSelectionOverlay(ctx, { start, end }, cols, rows) {
    let [r1, c1] = start, [r2, c2] = end;
    if (r1 > r2 || (r1 === r2 && c1 > c2)) { [r1,c1,r2,c2] = [r2,c2,r1,c1]; }
    ctx.save();
    ctx.fillStyle = 'rgba(80,140,255,0.35)';
    if (r1 === r2) {
      ctx.fillRect(c1*CHAR_W, r1*CHAR_H, (c2-c1+1)*CHAR_W, CHAR_H);
    } else {
      ctx.fillRect(c1*CHAR_W, r1*CHAR_H, (cols-c1)*CHAR_W, CHAR_H);
      if (r2-r1 > 1) ctx.fillRect(0, (r1+1)*CHAR_H, cols*CHAR_W, (r2-r1-1)*CHAR_H);
      ctx.fillRect(0, r2*CHAR_H, (c2+1)*CHAR_W, CHAR_H);
    }
    ctx.restore();
  }
}
