// SPDX-License-Identifier: GPL-3.0-or-later
//
// Copyright (C) 2026 Joseph Quinn
//
// Originates in synthdoor <https://github.com/synexo/synthdoor>, distributed
// under the MIT License. Modified for multi-font support: cell
// metrics moved from module constants to per-instance.
// Incorporated here by the copyright holder under the GNU General Public
// License version 3 or later.
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU General Public License as published by the Free Software
// Foundation, either version 3 of the License, or (at your option) any later
// version. Distributed WITHOUT ANY WARRANTY; without even the implied warranty
// of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.

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
 *
 * HYBRID SCALING PATH (fonts flagged `scale: 'hybrid'`)
 * =====================================================
 * A second, parallel draw path. It is entered only when the ACTIVE FONT carries
 * the flag AND main.js has supplied device metrics; otherwise every line below
 * behaves exactly as it always has. See fontscale.js for the arithmetic and
 * FONTS.md for the rationale.
 *
 * The two paths differ in three places and nowhere else:
 *
 *   backing store  legacy: cols*cellW x rows*cellH, CSS-stretched to the device
 *                  hybrid: real device pixels, so the snap survives to the glass
 *   glyph sheet    legacy: source-resolution, tinted per (fg,bg) PAIR
 *                  hybrid: prescaled to inkW x inkH, tinted per FG ONLY
 *   per cell       legacy: one drawImage of a pre-composited fg-over-bg sheet
 *                  hybrid: fillRect(bg) then a 1:1 blit of the fg glyph
 *
 * Why the hybrid path splits bg from fg: cell rects come from a rounded edge
 * table, so a cell is inkW or inkW+1 device pixels wide. The 0-or-1 px residue
 * is inter-glyph tracking that the background must cover but the glyph must
 * not, which a single pre-composited blit cannot express. At an exact 1x the
 * residue is always 0 and the two paths produce identical pixels.
 */

import { buildFontSheet, buildScaledFontSheet, fontById, DEFAULT_FONT_ID,
         FALLBACK_FONT_ID, isTTF, loadOutlineFont, deriveOutlineBitmap,
         buildOutlineFontSheet } from './fonts/index.js';
// STRETCH_X is imported again: the blit is still 1:1 on both axes, but WHICH
// axis may consume the atlas cell's extension column is now a per-glyph
// decision, and that bit is the decision. See _blitCellHybrid.
import { isHybrid, layout as scaleLayout, classifyStretch,
         STRETCH_X } from './fontscale.js';

export const VGA_PALETTE = [
  '#000000','#AA0000','#00AA00','#AA5500',
  '#0000AA','#AA00AA','#00AAAA','#AAAAAA',
  '#555555','#FF5555','#55FF55','#FFFF55',
  '#5555FF','#FF55FF','#55FFFF','#FFFFFF',
];

// Default cell metrics. The active font's own metrics live on the Renderer
// instance (this.cellW / this.cellH) — fonts differ in height, so anything
// that positions a cell must read the instance, not these.
export const CHAR_W = 8;
export const CHAR_H = 16;

export class Renderer {
  constructor(canvas, cols, rows, font = fontById(DEFAULT_FONT_ID)) {
    this.canvas = canvas;
    this.ctx    = canvas.getContext('2d');
    this.cols   = cols;
    this.rows   = rows;
    this.font   = font;
    this.cellW  = font.cellW;
    this.cellH  = font.cellH;
    this.canvas.width  = cols * this.cellW;
    this.canvas.height = rows * this.cellH;

    this._fontSheet    = null;
    this._tintedSheets = new Map();

    // ── Hybrid path state (null on the legacy path, always) ────────────────
    // `_layout` non-null is the ONE condition that selects the hybrid path, so
    // a font without the flag, or a hybrid font before main.js has measured the
    // device, runs the legacy code untouched.
    this._layout      = null;   // fontscale.layout() result
    this._stretch     = null;   // Uint8Array(256) per-glyph axis flags
    this._scaledSheet = null;   // prescaled white-on-transparent atlas
    this._fgSheets    = new Map();   // fg index -> tinted prescaled atlas
    this._deviceW     = 0;      // last device box handed to setDeviceMetrics
    this._deviceH     = 0;

    // ── Outline (TTF) path state ──────────────────────────────────────────
    this._derived     = null;   // thresholded design-grid bitmap, for stretch glyphs
    this._blankCache  = null;
    this._atlasToken  = 0;      // guards an async build against a newer one
    this._outlineFailed = null; // id of a font whose file would not load
    // One pixel the CURRENT base sheet inked. It is the witness restore()
    // reads to tell a live sheet from one the browser emptied while hidden.
    this._probe       = null;
    /** Called with (font, fallback) when an outline font's file will not load. */
    this.onFontUnavailable = null;
    /** Called with (font) when an async outline atlas becomes available. */
    this.onAtlasReady = null;

    // Packed per-cell "last drawn" cache. -1 = never drawn.
    // pack = ch | (fg<<8) | (bg<<12)
    this._lastDrawn = new Int32Array(cols * rows).fill(-1);

    // Previous cursor position — must be force-redrawn to erase cursor artifact
    this._prevCursorCol = -1;
    this._prevCursorRow = -1;

    this._built = false;
  }

  async init() {
    // An outline font has no glyph bytes, so there is no legacy sheet to build.
    // It is always on the hybrid path, where the atlas is built by
    // _rebuildHybrid() once main.js has measured the device.
    if (!isTTF(this.font)) {
      this._fontSheet = buildFontSheet(this.font);
      this._probe = this._findProbe(this._fontSheet, this.cellW, this.cellH);
    }
    this._built = true;
  }

  // ── Hybrid path ───────────────────────────────────────────────────────────

  /** True when this frame will be drawn through the hybrid path. */
  get hybrid() { return this._layout !== null; }

  /**
   * The device-pixel box the terminal occupies, or null on the legacy path.
   * main.js reads this back to set the canvas's CSS size, so the backing store
   * and the displayed box agree exactly and the browser adds no resampling of
   * its own (without this the whole scheme is
   * inert, because a CSS stretch destroys the snap the atlas just bought).
   */
  deviceBox() {
    return this._layout ? { w: this._layout.Dw, h: this._layout.Dh } : null;
  }

  /**
   * Would setDeviceMetrics(availW, availH) actually rebuild anything?
   *
   * Exists so a caller can decide to DEFER an expensive rebuild without having
   * to guess whether one is needed. setDeviceMetrics answers the same question
   * internally, but only by doing the work — and at desktop sizes the work is
   * ~18 ms for the atlas plus a full re-tint on the next frame, which is more
   * than a frame budget and far too much to run on every event of a drag.
   */
  deviceMetricsMatch(availW, availH) {
    return !!this._layout
        && Math.max(1, Math.round(availW)) === this._deviceW
        && Math.max(1, Math.round(availH)) === this._deviceH;
  }

  /**
   * Hand the renderer the device-pixel space it may use, and rebuild.
   *
   * No-op — and specifically NOT a fallback — for a font without the flag: such
   * a font must keep its existing backing store and CSS stretch, which is what
   * "no effect on current font presentation" means. Returns true if anything
   * changed, so callers can skip a re-fit.
   *
   * @param {number} availW available width  in device pixels
   * @param {number} availH available height in device pixels
   */
  setDeviceMetrics(availW, availH) {
    if (!isHybrid(this.font)) return this._clearHybrid();
    availW = Math.max(1, Math.round(availW));
    availH = Math.max(1, Math.round(availH));
    if (this._layout && availW === this._deviceW && availH === this._deviceH) return false;
    this._deviceW = availW;
    this._deviceH = availH;
    this._rebuildHybrid();
    return true;
  }

  /** Drop hybrid state and restore the legacy backing store. */
  _clearHybrid() {
    if (!this._layout) return false;
    this._layout = null;
    this._stretch = null;
    this._scaledSheet = null;
    this._fgSheets.clear();
    this._deviceW = this._deviceH = 0;
    this.canvas.width  = this.cols * this.cellW;
    this.canvas.height = this.rows * this.cellH;
    this.invalidateAll();
    return true;
  }

  _rebuildHybrid() {
    // The GEOMETRY is always resolved synchronously — layout, edge tables,
    // backing store — because fitTerminal() needs the device box back in the
    // same tick to size the CSS. Only the atlas CONTENT can be async, and only
    // for an outline font, which has a file to fetch.
    const L = scaleLayout(this.font, this.cols, this.rows, this._deviceW, this._deviceH, {
      // An outline font has no glyph bytes for the blank-column probe, and
      // needs none: its advance space is in the metrics, and the masks it uses
      // apply only to the thresholded stretch glyphs.
      lastColBlank: isTTF(this.font) ? false : undefined,
      lastRowBlank: isTTF(this.font) ? false : undefined,
    });
    this._layout = L;
    this.canvas.width  = L.Dw;
    this.canvas.height = L.Dh;
    this._fgSheets.clear();
    // Nearest-neighbour for the stretch blits. Set once here: the 2d context
    // keeps it across draws, and every hybrid draw wants it off.
    this.ctx.imageSmoothingEnabled = false;

    if (isTTF(this.font)) { this._rebuildOutlineAtlas(L); return; }

    // Derived from the bitmap, so it is recomputed with the font rather than
    // cached against a codepoint table. 256 glyphs of a few hundred bits is
    // nothing beside the atlas rebuild it accompanies.
    this._stretch = classifyStretch(this.font);
    this._installScaled(buildScaledFontSheet(this.font, L));
    this.invalidateAll();
  }

  /**
   * Outline atlas: asynchronous, because the font file has to arrive first.
   *
   * Until it resolves, `_scaledSheet` stays null and _blitCellHybrid paints
   * backgrounds only — a correctly-shaped blank terminal for a few frames
   * rather than a wrong-metric one. `_atlasToken` guards against a resize
   * landing mid-build: a stale build that resolves after a newer one started
   * must not install its now-wrong-sized sheet.
   *
   * A load failure falls back to a BITMAP font from the registry,
   * never to a system font. A system fallback would substitute different
   * advance widths and cell metrics, so the failure would present as a terminal
   * whose grid is subtly wrong rather than as an obvious error.
   */
  _rebuildOutlineAtlas(L) {
    this._scaledSheet = null;
    this._derived = null;
    this._stretch = new Uint8Array(256);          // nothing stretches until known
    this.invalidateAll();

    const token = ++this._atlasToken;
    const font = this.font;

    loadOutlineFont(font).then((okLoad) => {
      if (token !== this._atlasToken || this.font !== font) return;   // superseded
      if (!okLoad) {
        // FALLBACK_FONT_ID, not DEFAULT_FONT_ID. The default is itself an
        // outline font now, so falling back to it would answer "a woff2 did
        // not arrive" with another woff2 that can fail exactly the same way —
        // and on a device where the failure is the network rather than one
        // file, that is an infinite regress with a blank terminal at the end
        // of it. The fallback is a BITMAP entry, deliberately hidden from the
        // UI but never deleted. (FONTS.md rules out the other option, a
        // system font, for a different reason: wrong metrics, silently.)
        const fallback = fontById(font.fallbackId || FALLBACK_FONT_ID);
        this._outlineFailed = font.id;
        if (this.onFontUnavailable) this.onFontUnavailable(font, fallback);
        return;
      }
      // Threshold the outline onto its own design grid, and classify stretch
      // from THAT with the same derived classifier the bitmap path uses.
      const derived = deriveOutlineBitmap(font);
      const stretch = classifyStretch(derived);
      if (token !== this._atlasToken || this.font !== font) return;
      this._derived = derived;
      this._stretch = stretch;
      this._blankCache = null;
      this._installScaled(buildOutlineFontSheet(font, L, derived, stretch));
      this.invalidateAll();
      if (this.onAtlasReady) this.onAtlasReady(font);
    });
  }

  /**
   * Tinted prescaled atlas for one FOREGROUND colour.
   *
   * Keyed on fg alone, not on the (fg, bg) pair the legacy path uses, because
   * the background is a fillRect here rather than part of the sheet. 16 sheets
   * instead of up to 256 — which matters more than it looks, since these sheets
   * are device-sized: at inkW 24 an atlas is 6144 px wide.
   */
  _fgSheet(fg) {
    let s = this._fgSheets.get(fg);
    if (s) return s;
    const W = 256 * this._layout.padW, H = this._layout.padH;
    const c = new OffscreenCanvas(W, H);
    const cc = c.getContext('2d');
    cc.fillStyle = VGA_PALETTE[fg];
    cc.fillRect(0, 0, W, H);
    cc.globalCompositeOperation = 'destination-in';
    cc.drawImage(this._scaledSheet, 0, 0);
    this._fgSheets.set(fg, c);
    return c;
  }

  /**
   * One cell, hybrid path — three steps.
   *
   * EVERY blit is 1:1. The source rect is the destination rect's size, taken
   * straight from the cell edges, and the atlas cell is one pixel larger than
   * the ink extent on each axis to make that possible — the extension column
   * repeats the glyph's own last column (fontscale.js extendMask()).
   *
   * That is what makes box-drawing and block glyphs meet their neighbours: a
   * glyph whose ink reaches the cell edge keeps reaching it in a wide cell,
   * because the extension is more of the same ink.
   *
   * ONLY A GLYPH THAT JOINS READS THAT COLUMN. A letterform's extension is a
   * copy of its blank advance column, so taking it changed nothing on screen —
   * but it put the source rect's right edge on the atlas cell boundary, which
   * is where a sampler that overreaches finds the next glyph. Letterforms are
   * therefore capped at inkW and the background covers the residue instead.
   *
   * It replaced scaling the glyph to the cell rect on any axis the classifier
   * flagged. Scaling covered the residue but resampled the glyph: at inkW ->
   * inkW+1 nearest-neighbour duplicates an arbitrary INTERIOR column, so a `┼`
   * came out with its vertical bar a pixel off the `│` above it. Extension
   * moves nothing and duplicates nothing but the edge.
   */
  _blitCellHybrid(ctx, col, row, ch, fg, bg) {
    const L = this._layout;
    const x0 = L.xEdges[col], x1 = L.xEdges[col + 1];
    const y0 = L.yEdges[row], y1 = L.yEdges[row + 1];

    // 1. Background — contiguous by construction, so no seams.
    ctx.fillStyle = VGA_PALETTE[bg];
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);

    // A glyph drawn in its own background colour is invisible; skip the blit.
    // (This is also the blink-off case, which sets fg = bg.)
    if (fg === bg) return;

    // An outline atlas is built asynchronously. Until the font file lands there
    // is nothing to blit, so the frame is backgrounds only — a correctly-shaped
    // blank terminal, which is the right thing to show for the few frames it
    // takes. The cells are invalidated when the atlas installs, so they repaint.
    if (!this._scaledSheet) return;

    const code = ch & 255;
    const flags = this._stretch[code];
    if (!flags && this._isBlank(code)) return;

    // The cell rect's own size, clamped to what the atlas may supply — and on
    // X the cap depends on whether this glyph actually joins.
    //
    // A glyph the classifier did not flag has a BLANK extension column, so
    // reaching for it gains nothing; and reaching for it puts the source
    // rect's right edge exactly on the atlas cell boundary, where a sampler
    // that overreaches by a fraction of a texel picks up the next glyph's
    // first column. That is the reported one-pixel hairline: it appears only
    // on cells that took the +1 px residue, because a cell without it stops a
    // texel short and has nothing to overrun into. Capping at inkW gives every
    // letterform the narrow cell's safety; the background fillRect above has
    // already covered the residue, which is what it was always for.
    //
    // Y needs no such cap. The atlas is ONE row of cells tall, so a vertical
    // overreach leaves the image entirely and is clamped to the edge, which
    // repeats this glyph's own last row rather than borrowing a neighbour's.
    const dw = Math.min(x1 - x0, (flags & STRETCH_X) ? L.padW : L.inkW);
    const dh = Math.min(y1 - y0, L.padH);

    // Source size == destination size: no resampling, on either axis, ever.
    ctx.drawImage(this._fgSheet(fg),
                  code * L.padW, 0, dw, dh,
                  x0, y0, dw, dh);
  }

  /**
   * Glyphs with no ink at all — cached, since the test walks the bitmap.
   *
   * For an outline font the bitmap consulted is the thresholded design-grid
   * rasterization, which is the only bitmap such a font has. Before it exists
   * nothing can be classified, so nothing is skipped — the atlas is empty then
   * anyway and _blitCellHybrid has already returned.
   */
  _isBlank(code) {
    const src = this._derived || (isTTF(this.font) ? null : this.font);
    if (!src) return false;
    if (!this._blankCache) this._blankCache = new Map();
    let b = this._blankCache.get(code);
    if (b === undefined) {
      const { cellH, glyphs } = src;
      const stride = (src.cellW + 7) >> 3;
      const base = code * cellH * stride;
      b = true;
      for (let i = 0; i < cellH * stride && b; i++) if (glyphs[base + i]) b = false;
      this._blankCache.set(code, b);
    }
    return b;
  }

  /**
   * Swap the active font. Cell height changes with it, so the backing canvas is
   * re-sized, the glyph sheet rebuilt, and both caches (tinted sheets, keyed on
   * colour pair but sized to the old cell; per-cell last-drawn) dropped — a
   * stale tinted sheet would blit at the previous cell height.
   *
   * Callers must re-fit the canvas afterwards, since the aspect ratio changed.
   */
  setFont(font) {
    if (!font || font.id === this.font.id) return false;
    this.font  = font;
    this.cellW = font.cellW;
    this.cellH = font.cellH;
    this.canvas.width  = this.cols * this.cellW;
    this.canvas.height = this.rows * this.cellH;
    // An outline font has no glyph bytes and so no legacy sheet — its atlas is
    // built on the hybrid path once the file has loaded.
    this._fontSheet = isTTF(font) ? null : buildFontSheet(font);
    this._probe = this._fontSheet
      ? this._findProbe(this._fontSheet, this.cellW, this.cellH) : null;
    this._tintedSheets.clear();
    this._lastDrawn.fill(-1);
    this._prevCursorCol = -1;
    this._prevCursorRow = -1;

    // Hybrid state belongs to the OUTGOING font — its masks, its atlas, its
    // stretch table — so it is always dropped here. If the incoming font wants
    // the hybrid path, main.js re-measures and calls setDeviceMetrics() as part
    // of the re-fit it already has to do (the aspect changed), which rebuilds
    // it. Dropping unconditionally is what guarantees that switching AWAY from
    // a hybrid font restores the legacy backing store exactly.
    this._blankCache = null;
    this._layout = null;
    this._stretch = null;
    this._scaledSheet = null;
    this._derived = null;
    this._fgSheets.clear();
    this._deviceW = this._deviceH = 0;
    // Invalidate any outline atlas build still in flight for the old font, so
    // it cannot install its sheet over the new one when it resolves.
    this._atlasToken++;
    return true;
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
   * Come back from a page that was hidden: re-ink anything the browser emptied
   * while it was, then invalidate so the next frame redraws the model.
   *
   * A canvas backing store is a discardable resource, and the browser does not
   * only discard the one on screen — the glyph sheet and every tinted sheet
   * are canvases too, and they come back present, correctly sized, and fully
   * transparent. Invalidating cannot repair that: the cells are redrawn, each
   * blit reads an empty atlas, and the terminal stays blank while the cursor —
   * a fillRect, needing no atlas — still moves. That is the Android report.
   *
   * The base sheet is rebuilt from data still in hand (glyph bytes, or the
   * thresholded outline bitmap plus a face that is still resident), so nothing
   * here goes back to the network. Tinted sheets are derived from the base one
   * and are simply dropped, to be rebuilt on demand by the frame that wants
   * them.
   *
   * @returns {boolean} true if a sheet had actually been lost
   */
  restore() {
    const lost = this._sheetLost(this._layout ? this._scaledSheet : this._fontSheet);
    if (lost) this._rebuildSheets();
    else this._dropLostTints();
    this.invalidateAll();
    return lost;
  }

  /**
   * Device-pixel point → [col, row], clamped to the grid.
   *
   * The inverse of the geometry _drawSelectionOverlay draws from, and it has to
   * read the same source for the same reason: on the hybrid path the columns do
   * not share a pitch, so dividing by cellW lands on the wrong one wherever the
   * edge table widened a cell. Living here rather than in the caller is the
   * point — the table is rebuilt on every resize and font change, and a copy of
   * this arithmetic anywhere else would go stale at the next Aa press.
   *
   * @param {number} dx  x in device pixels, from the canvas's top-left
   * @param {number} dy  y in device pixels
   * @returns {[number, number]} [col, row]
   */
  cellAt(dx, dy) {
    const { cols, rows } = this;
    let col, row;
    if (this._layout) {
      const X = this._layout.xEdges, Y = this._layout.yEdges;
      col = 0; while (col < cols - 1 && dx >= X[col + 1]) col++;
      row = 0; while (row < rows - 1 && dy >= Y[row + 1]) row++;
    } else {
      col = Math.floor(dx / this.cellW);
      row = Math.floor(dy / this.cellH);
    }
    return [Math.max(0, Math.min(cols - 1, col)),
            Math.max(0, Math.min(rows - 1, row))];
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
    this.canvas.width  = cols * this.cellW;
    this.canvas.height = rows * this.cellH;
    this._lastDrawn = new Int32Array(cols * rows).fill(-1);
    this._tintedSheets.clear();
    this._prevCursorCol = -1;
    this._prevCursorRow = -1;
    // The edge tables and masks are computed FROM the column count, so a resize
    // invalidates them. Recompute against the device box we already hold rather
    // than waiting for the next setDeviceMetrics, so the frame drawn between
    // here and the re-fit is not blitted through a stale table.
    if (this._layout) this._rebuildHybrid();
  }

  // ── Private ───────────────────────────────────────────────────────────────

  _blitCell(ctx, col, row, ch, fg, bg) {
    // The single branch that selects the path. Everything below it is the
    // original code, unchanged, and is what every non-hybrid font still runs.
    if (this._layout) return this._blitCellHybrid(ctx, col, row, ch, fg & 15, bg & 15);
    const sheet = this._sheet(fg & 15, bg & 15);
    const { cellW: cw, cellH: chh } = this;
    ctx.drawImage(sheet, (ch & 255) * cw, 0, cw, chh,
                  col * cw, row * chh, cw, chh);
  }

  _sheet(fg, bg) {
    const key = (fg << 4) | bg;
    let s = this._tintedSheets.get(key);
    if (!s) { s = this._buildSheet(VGA_PALETTE[fg], VGA_PALETTE[bg]); this._tintedSheets.set(key, s); }
    return s;
  }

  _buildSheet(fgHex, bgHex) {
    const W = 256 * this.cellW, H = this.cellH;
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

  /** Install a freshly built base atlas, with the probe and tints it implies. */
  _installScaled(sheet) {
    this._scaledSheet = sheet;
    this._fgSheets.clear();
    this._probe = sheet && this._layout
      ? this._findProbe(sheet, this._layout.padW, this._layout.padH) : null;
  }

  /**
   * Coordinates of one pixel `sheet` definitely inked, or null if none was
   * found. Three candidate glyphs, because a font need not have all of them:
   * the full block, X, and the lower-case o.
   *
   * Read once per build, so a per-frame check never has to scan.
   */
  _findProbe(sheet, cellW, cellH) {
    let cx;
    try { cx = sheet.getContext('2d'); } catch (_) { return null; }
    for (const ch of [0xDB, 0x58, 0x6F]) {
      let d;
      try { d = cx.getImageData(ch * cellW, 0, cellW, cellH); } catch (_) { return null; }
      for (let p = 0; p * 4 + 3 < d.data.length; p++) {
        // Opaque, not merely inked: an outline glyph's edge pixels are partly
        // transparent, and a probe on one of those cannot distinguish a live
        // sheet from an empty one by alpha.
        if (d.data[p * 4 + 3] === 255) {
          return { x: ch * cellW + (p % cellW), y: (p / cellW) | 0 };
        }
      }
    }
    return null;
  }

  /**
   * Has this sheet's content been thrown away? Answered by reading the one
   * pixel the build recorded as opaque. With no probe the answer is no — a
   * false yes would rebuild an intact atlas on every return to the page.
   */
  _sheetLost(sheet) {
    const p = this._probe;
    if (!p || !sheet) return false;
    try {
      return sheet.getContext('2d').getImageData(p.x, p.y, 1, 1).data[3] === 0;
    } catch (_) { return false; }
  }

  /** Rebuild the base sheet for whichever path is active. */
  _rebuildSheets() {
    if (!this._layout) {
      this._tintedSheets.clear();
      this._fontSheet = buildFontSheet(this.font);
      this._probe = this._findProbe(this._fontSheet, this.cellW, this.cellH);
      return;
    }
    if (!isTTF(this.font)) {
      this._installScaled(buildScaledFontSheet(this.font, this._layout));
      return;
    }
    // The thresholded bitmap is plain data and the FontFace stays registered,
    // so the outline atlas rebuilds here synchronously. Only a font whose first
    // build never completed has to go round the async path again.
    if (this._derived) {
      this._installScaled(
        buildOutlineFontSheet(this.font, this._layout, this._derived, this._stretch));
    } else {
      this._rebuildOutlineAtlas(this._layout);
    }
  }

  /**
   * A tinted sheet can be discarded on its own, with the base sheet left
   * intact. Each is checked at the same probe — tinting preserves alpha — and
   * the lost ones are dropped rather than all of them, so an ordinary return
   * to the page costs no re-tint at all.
   */
  _dropLostTints() {
    if (!this._probe) return;
    const cache = this._layout ? this._fgSheets : this._tintedSheets;
    for (const [key, sheet] of cache) if (this._sheetLost(sheet)) cache.delete(key);
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
    // Cell geometry on the hybrid path is the edge table, not a constant pitch,
    // so the overlay is drawn from it directly. Same three rectangles either
    // way — only the coordinate source differs.
    if (this._layout) {
      const L = this._layout, X = L.xEdges, Y = L.yEdges;
      const span = (ra, ca, cb) =>
        ctx.fillRect(X[ca], Y[ra], X[cb + 1] - X[ca], Y[ra + 1] - Y[ra]);
      if (r1 === r2) span(r1, c1, c2);
      else {
        span(r1, c1, cols - 1);
        if (r2 - r1 > 1) ctx.fillRect(X[0], Y[r1 + 1], X[cols] - X[0], Y[r2] - Y[r1 + 1]);
        span(r2, 0, c2);
      }
      ctx.restore();
      return;
    }
    const cw = this.cellW, chh = this.cellH;
    if (r1 === r2) {
      ctx.fillRect(c1*cw, r1*chh, (c2-c1+1)*cw, chh);
    } else {
      ctx.fillRect(c1*cw, r1*chh, (cols-c1)*cw, chh);
      if (r2-r1 > 1) ctx.fillRect(0, (r1+1)*chh, cols*cw, (r2-r1-1)*chh);
      ctx.fillRect(0, r2*chh, (c2+1)*cw, chh);
    }
    ctx.restore();
  }
}
