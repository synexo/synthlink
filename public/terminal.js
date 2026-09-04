// SPDX-License-Identifier: GPL-3.0-or-later
//
// Copyright (C) 2026 Joseph Quinn
//
// Originates in synthdoor <https://github.com/synexo/synthdoor>, distributed
// under the MIT License. ANSIParser unmodified; telnet handling
// lifted out to lib/telnet.js.
// Incorporated here by the copyright holder under the GNU General Public
// License version 3 or later.
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU General Public License as published by the Free Software
// Foundation, either version 3 of the License, or (at your option) any later
// version. Distributed WITHOUT ANY WARRANTY; without even the implied warranty
// of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.

/**
 * terminal.js
 *
 * Terminal emulator core:
 *   - ScreenBuffer  — 2-D array of Cell objects
 *   - ANSIParser    — state-machine CSI/SGR/escape parser
 *   - Terminal      — screen buffer + cursor + attribute state
 *
 * Encoding: ALL bytes treated as raw CP437 (0-255). Never UTF-8 decode.
 */

/* ═══════════════════════════════════════════════════════════════
   CP437 → Unicode (for copy/paste only)
   ═══════════════════════════════════════════════════════════════ */
export const CP437 = [
  '\u0000','\u263A','\u263B','\u2665','\u2666','\u2663','\u2660','\u2022',
  '\u25D8','\u25CB','\u25D9','\u2642','\u2640','\u266A','\u266B','\u263C',
  '\u25BA','\u25C4','\u2195','\u203C','\u00B6','\u00A7','\u25AC','\u21A8',
  '\u2191','\u2193','\u2192','\u2190','\u221F','\u2194','\u25B2','\u25BC',
  ' ','!','"','#','$','%','&',"'",'(',')','*','+',',','-','.','/',
  '0','1','2','3','4','5','6','7','8','9',':',';','<','=','>','?',
  '@','A','B','C','D','E','F','G','H','I','J','K','L','M','N','O',
  'P','Q','R','S','T','U','V','W','X','Y','Z','[','\\',']','^','_',
  '`','a','b','c','d','e','f','g','h','i','j','k','l','m','n','o',
  'p','q','r','s','t','u','v','w','x','y','z','{','|','}','~','\u2302',
  '\u00C7','\u00FC','\u00E9','\u00E2','\u00E4','\u00E0','\u00E5','\u00E7',
  '\u00EA','\u00EB','\u00E8','\u00EF','\u00EE','\u00EC','\u00C4','\u00C5',
  '\u00C9','\u00E6','\u00C6','\u00F4','\u00F6','\u00F2','\u00FB','\u00F9',
  '\u00FF','\u00D6','\u00DC','\u00A2','\u00A3','\u00A5','\u20A7','\u0192',
  '\u00E1','\u00ED','\u00F3','\u00FA','\u00F1','\u00D1','\u00AA','\u00BA',
  '\u00BF','\u2310','\u00AC','\u00BD','\u00BC','\u00A1','\u00AB','\u00BB',
  '\u2591','\u2592','\u2593','\u2502','\u2524','\u2561','\u2562','\u2556',
  '\u2555','\u2563','\u2551','\u2557','\u255D','\u255C','\u255B','\u2510',
  '\u2514','\u2534','\u252C','\u251C','\u2500','\u253C','\u255E','\u255F',
  '\u255A','\u2554','\u2569','\u2566','\u2560','\u2550','\u256C','\u2567',
  '\u2568','\u2564','\u2565','\u2559','\u2558','\u2552','\u2553','\u256B',
  '\u256A','\u2518','\u250C','\u2588','\u2584','\u258C','\u2590','\u2580',
  '\u03B1','\u00DF','\u0393','\u03C0','\u03A3','\u03C3','\u00B5','\u03C4',
  '\u03A6','\u0398','\u03A9','\u03B4','\u221E','\u03C6','\u03B5','\u2229',
  '\u2261','\u00B1','\u2265','\u2264','\u2320','\u2321','\u00F7','\u2248',
  '\u00B0','\u2219','\u00B7','\u221A','\u207F','\u00B2','\u25A0','\u00A0',
];

/* ═══════════════════════════════════════════════════════════════
   Cell
   ═══════════════════════════════════════════════════════════════ */
export class Cell {
  constructor() {
    this.ch    = 32;
    this.fg    = 7;
    this.bg    = 0;
    this.bold  = false;
    this.blink = false;
    this.dirty = true;
  }
  set(ch, fg, bg, bold, blink) {
    if (this.ch!==ch||this.fg!==fg||this.bg!==bg||this.bold!==bold||this.blink!==blink) {
      this.ch=ch; this.fg=fg; this.bg=bg; this.bold=bold; this.blink=blink; this.dirty=true;
    }
  }
  copyFrom(s) { this.set(s.ch,s.fg,s.bg,s.bold,s.blink); }
  clear(fg=7,bg=0) { this.set(32,fg,bg,false,false); }
}

/* ═══════════════════════════════════════════════════════════════
   ScreenBuffer
   ═══════════════════════════════════════════════════════════════ */
export class ScreenBuffer {
  constructor(cols, rows) {
    this.cols=cols; this.rows=rows;
    this.cells=[];
    for (let i=0;i<cols*rows;i++) this.cells.push(new Cell());
  }
  get(col,row) { return this.cells[row*this.cols+col]; }
  clearAll(fg=7,bg=0) { for (const c of this.cells) c.clear(fg,bg); }
  markAllDirty() { for (const c of this.cells) c.dirty=true; }
  snapshotRow(row) {
    const s=[];
    for (let c=0;c<this.cols;c++) {
      const cell=this.get(c,row);
      s.push({ch:cell.ch,fg:cell.fg,bg:cell.bg,bold:cell.bold,blink:cell.blink});
    }
    return s;
  }
}

/* ═══════════════════════════════════════════════════════════════
   TelnetFilter — MOVED
   ═══════════════════════════════════════════════════════════════
   Telnet is no longer terminated in the browser. It is terminated at the
   server, which keeps every IAC negotiation byte off the modem link and lets
   the server answer TTYPE/NAWS on this terminal's behalf (CP437/ANSI, and the
   real window size — 25 rows by 80 or 40 columns, the latter when the 9×14 font
   is active; it rides the dial message, see server.js). The single
   implementation now lives in `lib/telnet.js`.
   If a direct browser-to-BBS mode is ever wanted, import it from there rather
   than reintroducing a copy here — two copies would drift.
   See the telnet-termination session in DEVLOG.md.
   ═══════════════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════════════
   ANSIParser  — state machine
   States: NORMAL | ESC | CSI | MUSIC

   BUG FIX: ANSI music state (ESC [ M with no params)
   ===================================================
   Previously _dispatchCSI set this._state='MUSIC' then returned, but
   the caller in the CSI branch immediately overwrote: this._state='NORMAL'.
   Fix: _dispatchCSI returns true when it sets a new state that must not
   be overwritten.  The CSI branch only resets to NORMAL when false is
   returned.

   BUG FIX: 0x0E (♫) and 0x0F (☼) silently dropped
   ==================================================
   The original code had:
     case 0x0E: case 0x0F: return; // charset switch — ignore
   These are valid CP437 glyphs (♫ and ☼) and have no control-code
   meaning in this protocol. They are now allowed to fall through to
   putChar. Bytes 0x07–0x0D remain as control codes because they are
   legitimately used by scroll-mode output (CR, LF) and readline echo
   (backspace, tab).
   ═══════════════════════════════════════════════════════════════ */
export class ANSIParser {
  constructor(terminal) {
    this.term=terminal;
    this._state='NORMAL';
    this._csiParams='';
    this._csiIntermed='';
    this._musicBuf='';
  }

  feed(bytes) { for (let i=0;i<bytes.length;i++) this._consume(bytes[i]); }

  _consume(b) {
    const t=this.term;

    // ── MUSIC accumulation ─────────────────────────────────────────────
    if (this._state==='MUSIC') {
      // ANSI music string is terminated by 0x0E (SO), 0x1E (RS), NUL, or BEL
      if (b===0x0E||b===0x1E||b===0x00||b===0x07) {
        if (t.onANSIMusic) t.onANSIMusic(this._musicBuf);
        this._musicBuf=''; this._state='NORMAL';
      } else {
        this._musicBuf+=String.fromCharCode(b);
      }
      return;
    }

    // ── ESC received ───────────────────────────────────────────────────
    if (this._state==='ESC') {
      if (b===0x5B) { this._state='CSI'; this._csiParams=''; this._csiIntermed=''; return; }
      if (b===0x4D) { t.reverseIndex(); this._state='NORMAL'; return; }   // RI
      if (b===0x37) { t.saveCursor();   this._state='NORMAL'; return; }   // DECSC
      if (b===0x38) { t.restoreCursor();this._state='NORMAL'; return; }   // DECRC
      if (b===0x63) { t.reset();        this._state='NORMAL'; return; }   // RIS
      if (b===0x44) { t.lineFeed();     this._state='NORMAL'; return; }   // IND
      if (b===0x45) { t.carriageReturn(); t.lineFeed(); this._state='NORMAL'; return; } // NEL
      this._state='NORMAL'; return;
    }

    // ── CSI parameter accumulation ─────────────────────────────────────
    if (this._state==='CSI') {
      if (b>=0x30&&b<=0x3F) { this._csiParams+=String.fromCharCode(b); return; }
      if (b>=0x20&&b<=0x2F) { this._csiIntermed+=String.fromCharCode(b); return; }
      if (b>=0x40&&b<=0x7E) {
        // _dispatchCSI returns true if it set a new state (MUSIC)
        const stateChanged = this._dispatchCSI(b, this._csiParams, this._csiIntermed);
        if (!stateChanged) this._state='NORMAL';
        return;
      }
      this._state='NORMAL'; return;
    }

    // ── NORMAL ─────────────────────────────────────────────────────────
    if (b===0x1B) { this._state='ESC'; return; }

    switch(b) {
      case 0x07: t.bell(); return;
      case 0x08: t.cursorLeft(1); return;
      case 0x09: t.tab(); return;
      case 0x0A: case 0x0B: case 0x0C: t.lineFeed(); return;
      case 0x0D: t.carriageReturn(); return;
      // 0x0E (♫) and 0x0F (☼): no case here — fall through to putChar below.
      // These are valid CP437 glyphs with no control-code meaning in this
      // protocol. The original silent-drop was the bug.
    }

    // CP437 printable bytes 0x01-0x1F (including 0x0E ♫ and 0x0F ☼ which
    // were not caught by the switch above), plus all bytes 0x20-0xFF.
    if (b>0x00&&b<0x20) { t.putChar(b); return; }
    if (b>=0x20) t.putChar(b);
  }

  /**
   * Dispatch a completed CSI sequence.
   * Returns true if this handler changed _state (caller must NOT overwrite).
   */
  _dispatchCSI(final, params, intermed) {
    const t=this.term;

    // ESC [ M with NO params = ANSI music start (not Delete Lines)
    if (final===0x4D && params==='') {
      this._state='MUSIC'; this._musicBuf='';
      return true;  // ← state changed, do not reset to NORMAL
    }

    const nums = params
      ? params.split(';').map(s=>{ const n=parseInt(s,10); return isNaN(n)?0:n; })
      : [];
    const p1=nums[0]??0, p2=nums[1]??0;

    switch(final) {
      case 0x41: t.cursorUp(p1||1); break;
      case 0x42: t.cursorDown(p1||1); break;
      case 0x43: t.cursorRight(p1||1); break;
      case 0x44: t.cursorLeft(p1||1); break;
      case 0x45: t.cursorDown(p1||1); t.carriageReturn(); break;
      case 0x46: t.cursorUp(p1||1); t.carriageReturn(); break;
      case 0x47: t.cursorCol((p1||1)-1); break;
      case 0x48: t.cursorPos((p1||1)-1,(p2||1)-1); break;
      case 0x66: t.cursorPos((p1||1)-1,(p2||1)-1); break;
      case 0x4A: t.eraseDisplay(p1); break;
      case 0x4B: t.eraseLine(p1); break;
      case 0x58: t.eraseChars(p1||1); break;
      case 0x40: t.insertChars(p1||1); break;
      case 0x4C: t.insertLines(p1||1); break;
      case 0x4D: t.deleteLines(p1||1); break; // ESC[<n>M — only reached when params!==''
      case 0x50: t.deleteChars(p1||1); break;
      case 0x53: t.scrollUp(p1||1); break;
      case 0x54: t.scrollDown(p1||1); break;
      case 0x6D: t.sgr(nums); break;
      case 0x73: t.saveCursor(); break;
      case 0x75: t.restoreCursor(); break;
      case 0x72: t.setScrollRegion((p1||1)-1,(p2||t.rows)-1); break;
      case 0x6E: t.deviceStatus(p1); break;
      case 0x63: // DA1 — Primary Device Attributes
        // Respond as a VT100 with no options: ESC [ ? 1 ; 0 c
        if (t.onSend) t.onSend('\x1B[?1;0c');
        break;
      case 0x68: t.setMode(params,true); break;
      case 0x6C: t.setMode(params,false); break;
      case 0x5A: t.cursorBackTab(p1||1); break;
    }
    return false;
  }
}

/* ═══════════════════════════════════════════════════════════════
   Terminal
   ═══════════════════════════════════════════════════════════════ */
export class Terminal {
  constructor(cols=80,rows=25) {
    this.cols=cols; this.rows=rows;
    this.screen=new ScreenBuffer(cols,rows);
    this._scrollback=[];
    this.MAX_SCROLLBACK=2000;
    this._scrollOffset=0;
    this.cx=0; this.cy=0;
    this._savedCX=0; this._savedCY=0;
    this.fgColor=7; this.bgColor=0;
    this.bold=false; this.blink=false; this.reverse=false;
    this._scrollTop=0; this._scrollBottom=rows-1;
    this.cursorVisible=true;
    this._autoWrap=true;
    this._insertMode=false;
    this._wrapPending=false;
    // Per-row: did this row's content run off the right margin and continue on
    // the next one? Recorded at the moment putChar auto-wraps, because it
    // cannot be recovered from the grid afterwards — see reflow(). Travels with
    // rows through every scroll and insert/delete, and is cleared when a row's
    // tail is erased. Scrollback rows carry the same fact as a `wrapped`
    // property on the snapshot array.
    this._wrapped=new Array(rows).fill(false);
    // How many rows the LAST re-flow had to push off the top of the screen
    // because the page no longer fitted at the new width. They are the top of
    // the page the user is still looking at, so the next re-flow claims them
    // back — see reflow(). Any scroll or clear moves the page on and the claim
    // is void, so those paths zero it.
    this._reflowPushed=0;
    this.onSend=null;
    this.onANSIMusic=null;
    this._urls=[];
  }

  resize(cols,rows) {
    this.cols=cols; this.rows=rows;
    this.screen=new ScreenBuffer(cols,rows);
    this._wrapped=new Array(rows).fill(false);
    this._reflowPushed=0;
    this._scrollTop=0; this._scrollBottom=rows-1;
    this.cx=Math.min(this.cx,cols-1); this.cy=Math.min(this.cy,rows-1);
  }

  /** A scrollback snapshot of row `r`, carrying its continuation flag. */
  _snapRow(r) {
    const row=this.screen.snapshotRow(r);
    row.wrapped=!!this._wrapped[r];
    return row;
  }

  /**
   * Resize AND re-flow everything already on screen (and in scrollback) to the
   * new width, instead of throwing it away like resize() does. This is what a
   * font change that also changes the column count uses, so switching 80 ⇄ 40
   * keeps the session readable rather than blanking it.
   *
   * The whole history is one stream: scrollback rows followed by the live
   * screen. Each stored row is trimmed of its trailing blanks, unwrapped, and
   * re-wrapped at the new width. The SCREEN THEN KEEPS ITS OWN LINES, from row 0
   * down, and the rest goes back into scrollback — it does not take the tail of
   * the stream, which would borrow history to fill rows the page does not use.
   *
   * A page that no longer fits at a narrower width has to spill off the top, and
   * the ring is the only place for it. `_reflowPushed` counts what was spilled
   * so the next re-flow can claim it back as screen rows, which is what makes
   * 80 -> 40 -> 80 a round trip. The claim is void once the page has moved on:
   * a scroll, a clear or a reset zeroes it.
   *
   * UNWRAPPING IS RECORDED, NOT INFERRED. `_wrapped[r]` is set at the moment
   * putChar runs off the right margin, so a row that continues into the next
   * one says so. Nothing here guesses.
   *
   * IT USED TO GUESS, AND THE GUESS WAS WRONG IN THE COMMON CASE. The rule was
   * "a row with no trailing blank — one that filled its width exactly — is a
   * continuation", which is what xterm and iTerm use. It fails whenever the
   * wrap point lands inside a run of SPACES, because the trim two steps below
   * deletes the very evidence the rule reads. That is not an edge case in a BBS:
   * column-aligned art is mostly spaces, and an 80-column header wrapped at 40
   * routinely breaks in the gap between two columns of text. The reported
   * symptom was a 40 -> 80 switch scattering the header of a Worldgroup board —
   * the second half of each line stranded at column 0 on a row of its own,
   * because its first half had been trimmed to 24 characters and no longer
   * looked "full". Every joined-up line was one whose wrap point happened to
   * land on a printing character.
   *
   * TWO CONSEQUENCES OF USING THE FLAG, both load-bearing:
   *
   *   - A WRAPPED ROW IS NOT TRIMMED. Its trailing blanks are interior to the
   *     logical line, and dropping them would close the gap between two columns
   *     of an aligned layout. Only the row that ENDS a logical line is trimmed.
   *     Fixing the join without this turns the stranded text into text jammed
   *     against the line above it, which looks even more like a re-flow bug.
   *   - A line that ends flush with the margin and is then hard-broken still
   *     works, by the same mechanism as before. Eager wrapping means such a line
   *     sets the flag, but the CRLF that follows feeds again and leaves a blank
   *     row, and that blank row is absorbed as the (empty) continuation — the
   *     join stops there because a blank row is not itself wrapped. The
   *     evidence is structural, not a heuristic, and it cannot be separated
   *     from its line: the ring drops its oldest entry first, so the flush row
   *     always leaves before the blank one that follows it.
   *
   * The re-wrap sets the flag on the rows it creates, so the FLAGS are
   * idempotent and a second switch reads the same evidence as the first. The
   * screen's ORIGIN is not carried by them and never was — that is what
   * `_reflowPushed` is for, and assuming otherwise is what made two fixes to
   * this method look finished while the header was still being eaten.
   *
   * `tools/tests/reflowtest.js` pins all of it, including the space-run case with a
   * printing-character control beside it.
   *
   * Attributes travel with each cell, so colour and bold survive the move.
   *
   * @param {number} cols new width
   * @param {number} rows new height
   */
  reflow(cols,rows) {
    const oldCols=this.cols;
    // 1. The stream. Live rows come from the screen buffer; scrollback rows are
    //    already plain snapshots. Trailing blanks are dropped so a mostly-empty
    //    row does not re-wrap into a screenful of nothing — but a cell with a
    //    non-default background is INK, not blank: trimming it would erase a
    //    coloured bar, which is most of what BBS art is made of.
    const blank=(c)=>c.ch===32&&c.bg===0&&!c.bold&&!c.blink;
    const trim=(row)=>{ let e=row.length; while(e>0&&blank(row[e-1])) e--; return row.slice(0,e); };
    // A wrapped row keeps its full width — its trailing blanks sit INSIDE the
    // logical line and are the column alignment of the layout. Only a row that
    // ends a logical line is trimmed.
    const take=(row,wrapped)=>wrapped?row.slice(0,oldCols):trim(row);
    // The page did not start at the top of the screen if a previous re-flow
    // spilled it: those rows are sitting at the end of the ring, and they are
    // STILL PART OF WHAT IS BEING LOOKED AT. Reading them back as screen rows
    // is what makes 80 -> 40 -> 80 a round trip instead of a one-way trim — the
    // narrow pass has nowhere to put the overflow but the ring, and without
    // this the wide pass rebuilds the page from its middle and the header is
    // gone. Only rows this terminal itself spilled, and only while the page has
    // not moved since: a scroll or a clear zeroes the count.
    const claim=Math.min(this._reflowPushed,this._scrollback.length);
    const lines=[];
    for (let i=0;i<this._scrollback.length;i++) {
      const row=this._scrollback[i];
      const w=!!row.wrapped;
      const live=i>=this._scrollback.length-claim;
      lines.push(live?{cells:take(row,w),wrapped:w,live:true}
                     :{cells:take(row,w),wrapped:w});
    }
    for (let r=0;r<this.rows;r++) {
      const w=!!this._wrapped[r];
      lines.push({cells:take(this.screen.snapshotRow(r),w),wrapped:w,live:true});
    }
    // The last live row holding content decides where the cursor lands. Rows
    // below it are trailing blanks that should not become scrollback.
    let lastInk=lines.length-1;
    while (lastInk>=0&&lines[lastInk].live&&lines[lastInk].cells.length===0) lastInk--;
    lines.length=lastInk+1;

    // 2. Unwrap: join each run of rows that ran off the right margin.
    //
    //    `live` travels with the joined line. A logical line any part of which
    //    was ON SCREEN is a screen line: it cannot be half in the scrollback ring
    //    and half on the display once it is one row again. Step 4 needs that
    //    boundary.
    const logical=[];
    for (let i=0;i<lines.length;i++) {
      let cells=lines[i].cells,live=!!lines[i].live;
      while (lines[i].wrapped&&i+1<lines.length) {
        i++; cells=cells.concat(lines[i].cells); live=live||!!lines[i].live;
      }
      logical.push({cells,live});
    }

    // 3. Re-wrap at the new width, recording the flag for the rows we create:
    //    every chunk but the last of a logical line continues into the next.
    //    An empty logical line stays one empty row.
    const out=[];
    for (const {cells,live} of logical) {
      if (!cells.length) { out.push({cells:[],wrapped:false,live}); continue; }
      for (let i=0;i<cells.length;i+=cols) {
        out.push({cells:cells.slice(i,i+cols),wrapped:i+cols<cells.length,live});
      }
    }

    // 4. Rebuild — and the screen keeps its OWN lines, starting at row 0. What
    //    was on screen goes back on screen; what was scrollback stays
    //    scrollback, and the rows the screen does not need stay BLANK.
    //
    //    This used to fill the screen with the last `rows` lines of the whole
    //    stream, which is a different thing whenever the screen holds fewer
    //    logical lines than it has rows — which is every BBS page that ends
    //    above the last row. The tail then reached back into the ring for the
    //    difference and dragged history onto the display: everything the board
    //    had drawn slid DOWN by the number of rows borrowed, with old lines
    //    above it and the page jammed against the bottom margin. Content
    //    correct, position wrong.
    //
    //    Overflow still behaves like a terminal: if the screen's own lines no
    //    longer fit (80 -> 40 roughly doubles them) the ones off the TOP scroll
    //    into scrollback, which is where they would have gone anyway.
    this.cols=cols; this.rows=rows;
    this.screen=new ScreenBuffer(cols,rows);
    this._wrapped=new Array(rows).fill(false);
    this._scrollTop=0; this._scrollBottom=rows-1;
    let split=out.findIndex((o)=>o.live);
    if (split<0) split=out.length;                 // nothing was on screen
    const firstLive=split;
    if (out.length-split>rows) split=out.length-rows;  // ...and it must still fit
    this._reflowPushed=split-firstLive;             // what the page lost off the top
    const screenLines=out.slice(split);
    this._scrollback=out.slice(0,split).map((o)=>{
      // Padded to full width, and this is REQUIRED rather than tidiness: on a
      // SECOND re-flow `take()` reads a wrapped row as `slice(0, oldCols)`, so
      // a short row would silently drop the interior blanks that carry the
      // layout's column alignment. Scrollback rows are full-width snapshots
      // everywhere else for the same reason.
      const row=o.cells.slice();
      while (row.length<cols) row.push({ch:32,fg:7,bg:0,bold:false,blink:false});
      row.wrapped=o.wrapped;
      return row;
    });
    while (this._scrollback.length>this.MAX_SCROLLBACK) this._scrollback.shift();
    for (let r=0;r<screenLines.length;r++) {
      const line=screenLines[r].cells;
      this._wrapped[r]=screenLines[r].wrapped;
      for (let c=0;c<line.length&&c<cols;c++) this.screen.get(c,r).copyFrom(line[c]);
    }
    this.screen.markAllDirty();

    // 5. Cursor: just past the end of the last line, wrapping if that filled the
    //    row. Output continues where it left off rather than overwriting.
    const lastRow=screenLines.length-1;
    if (lastRow<0) { this.cx=0; this.cy=0; }
    else {
      const len=screenLines[lastRow].cells.length;
      if (len>=cols&&lastRow+1<rows) { this.cx=0; this.cy=lastRow+1; }
      else { this.cx=Math.min(len,cols-1); this.cy=lastRow; }
    }
    this._wrapPending=false;
    this._scrollOffset=0;
  }

  // ── Character output ──────────────────────────────────────────
  putChar(byte) {
    const cell=this.screen.get(this.cx,this.cy);
    if (this._insertMode) {
      for (let c=this.cols-1;c>this.cx;c--) this.screen.get(c,this.cy).copyFrom(this.screen.get(c-1,this.cy));
    }
    cell.set(byte,this.fgColor,this.bgColor,this.bold,this.blink);
    if (this.cx>=this.cols-1) {
      // Eager wrap: advance to column 0 of the next line immediately.
      // Respect DECAWM (auto-wrap mode) — when off, the cursor stays
      // in place and further characters overwrite the last column.
      if (this._autoWrap) {
        // THE RECORD reflow() depends on. Set before the move, because
        // _doScrollUp() shifts the flags along with the rows.
        this._wrapped[this.cy]=true;
        this.cx=0;
        if (this.cy===this._scrollBottom) this._doScrollUp();
        else if (this.cy<this.rows-1) this.cy++;
      }
      // _wrapPending stays false; the eager model does not use it.
      this._wrapPending=false;
    } else {
      this.cx++;
    }
  }
  carriageReturn() { this.cx=0; this._wrapPending=false; }
  lineFeed() {
    this._wrapPending=false;
    if (this.cy===this._scrollBottom) this._doScrollUp();
    else if (this.cy<this.rows-1) this.cy++;
  }
  tab() { this.cx=Math.min(((this.cx>>3)+1)<<3,this.cols-1); this._wrapPending=false; }
  bell() {}

  // ── Cursor movement ───────────────────────────────────────────
  cursorUp(n)    { this.cy=Math.max(this._scrollTop,this.cy-n); this._wrapPending=false; }
  cursorDown(n)  { this.cy=Math.min(this._scrollBottom,this.cy+n); this._wrapPending=false; }
  cursorRight(n) { this.cx=Math.min(this.cols-1,this.cx+n); this._wrapPending=false; }
  cursorLeft(n)  { this.cx=Math.max(0,this.cx-n); this._wrapPending=false; }
  cursorCol(c)   { this.cx=Math.max(0,Math.min(this.cols-1,c)); this._wrapPending=false; }
  cursorPos(row,col) {
    this.cy=Math.max(0,Math.min(this.rows-1,row));
    this.cx=Math.max(0,Math.min(this.cols-1,col));
    this._wrapPending=false;
  }
  cursorBackTab(n) { for(let i=0;i<n;i++) this.cx=Math.max(0,((this.cx-1)>>3)<<3); }
  saveCursor()    { this._savedCX=this.cx; this._savedCY=this.cy; }
  restoreCursor() { this.cx=this._savedCX; this.cy=this._savedCY; this._wrapPending=false; }
  reverseIndex() {
    if (this.cy===this._scrollTop) this._doScrollDown();
    else if (this.cy>0) this.cy--;
  }

  // ── Erase ─────────────────────────────────────────────────────
  _clr(col,row) { this.screen.get(col,row).clear(this.fgColor,this.bgColor); }
  eraseDisplay(mode) {
    const {cols,rows,cx,cy}=this;
    if (mode===0) {
      for(let c=cx;c<cols;c++) this._clr(c,cy);
      for(let r=cy+1;r<rows;r++) for(let c=0;c<cols;c++) this._clr(c,r);
      // This row's tail is gone, so it no longer continues anywhere; the rows
      // below it are now empty. A stale flag here would join a live line to a
      // blank one on the next re-flow.
      for(let r=cy;r<rows;r++) this._wrapped[r]=false;
    } else if (mode===1) {
      for(let r=0;r<cy;r++) for(let c=0;c<cols;c++) this._clr(c,r);
      for(let c=0;c<=cx;c++) this._clr(c,cy);
      // Only the rows erased in full. Row `cy` keeps its tail, so it keeps its
      // flag.
      for(let r=0;r<cy;r++) this._wrapped[r]=false;
    } else if (mode===3) {
      // ESC[3J — xterm extension for "erase saved lines" (clear
      // scrollback).  Intentionally a no-op here.  Scrollback in this
      // client is a single-session continuous log: SCROLL-mode output
      // scrolls into it naturally, FIXED-mode apps don't (they redraw
      // in place), and on FIXED→SCROLL transition the post-FIXED final
      // frame scrolls into the ring as the next SCROLL output pushes
      // it off the top.  Honouring 3J would erase the SCROLL history
      // every time the engine entered FIXED mode (screen.setMode emits
      // ESC[2J ESC[3J as part of its enter sequence) — losing exactly
      // the content the user most wants to scroll back to.  SyncTerm
      // takes the same position against the same byte stream and the
      // history survives there, so we match that behaviour.
    } else {
      // mode 2 (full screen erase, the common case) and any unhandled
      // mode value fall here.  For mode 2: snapshot every visible row
      // into scrollback BEFORE clearing, so the content that was on
      // display at the moment of the clear can still be reviewed.
      // SyncTerm preserves this content; the natural-scroll-into-
      // scrollback machinery alone doesn't (rows that hadn't scrolled
      // off the top aren't anywhere except the live screen, and the
      // clear would wipe them).  Snapshotting here closes that gap.
      //
      // BBS games drawing fixed-mode animation typically don't issue
      // 2J between frames (they reposition with CUP and overwrite
      // cells in place), so this doesn't flood scrollback with redraw
      // frames in practice — the SynthDoor engine's setMode(FIXED)
      // path emits 2J exactly once on entry, and external BBSes emit
      // it at coarse-grained transitions.
      if (mode===2) {
        for(let r=0;r<rows;r++) this._scrollback.push(this._snapRow(r));
        while (this._scrollback.length>this.MAX_SCROLLBACK) this._scrollback.shift();
      }
      for(let r=0;r<rows;r++) for(let c=0;c<cols;c++) this._clr(c,r);
      if (mode===2) { this._wrapped.fill(false); this.cx=0; this.cy=0; this._reflowPushed=0; }
    }
  }
  eraseLine(mode) {
    const {cols,cx,cy}=this;
    // Modes 0 and 2 remove the right-hand end of the row, which is the thing
    // the continuation flag is a statement about. Mode 1 leaves it.
    if (mode===0) { for(let c=cx;c<cols;c++) this._clr(c,cy); this._wrapped[cy]=false; }
    else if (mode===1) for(let c=0;c<=cx;c++) this._clr(c,cy);
    else { for(let c=0;c<cols;c++) this._clr(c,cy); this._wrapped[cy]=false; }
  }
  eraseChars(n) { for(let i=0;i<n&&this.cx+i<this.cols;i++) this._clr(this.cx+i,this.cy); }
  insertChars(n) {
    const row=this.cy;
    for(let c=this.cols-1;c>=this.cx+n;c--) this.screen.get(c,row).copyFrom(this.screen.get(c-n,row));
    for(let c=this.cx;c<this.cx+n&&c<this.cols;c++) this.screen.get(c,row).clear(this.fgColor,this.bgColor);
  }
  deleteChars(n) {
    const row=this.cy;
    for(let c=this.cx;c<this.cols-n;c++) this.screen.get(c,row).copyFrom(this.screen.get(c+n,row));
    for(let c=this.cols-n;c<this.cols;c++) this.screen.get(c,row).clear(this.fgColor,this.bgColor);
  }
  insertLines(n) {
    const top=this.cy,bot=this._scrollBottom;
    for(let i=0;i<n;i++) {
      for(let r=bot;r>top;r--) for(let c=0;c<this.cols;c++) this.screen.get(c,r).copyFrom(this.screen.get(c,r-1));
      for(let c=0;c<this.cols;c++) this.screen.get(c,top).clear(this.fgColor,this.bgColor);
      for(let r=bot;r>top;r--) this._wrapped[r]=this._wrapped[r-1];
      this._wrapped[top]=false;
    }
  }
  deleteLines(n) {
    const top=this.cy,bot=this._scrollBottom;
    for(let i=0;i<n;i++) {
      for(let r=top;r<bot;r++) for(let c=0;c<this.cols;c++) this.screen.get(c,r).copyFrom(this.screen.get(c,r+1));
      for(let c=0;c<this.cols;c++) this.screen.get(c,bot).clear(this.fgColor,this.bgColor);
      for(let r=top;r<bot;r++) this._wrapped[r]=this._wrapped[r+1];
      this._wrapped[bot]=false;
    }
  }

  // ── Scroll ────────────────────────────────────────────────────
  _doScrollUp() {
    this._reflowPushed=0;
    if (this._scrollTop===0) {
      this._scrollback.push(this._snapRow(0));
      if (this._scrollback.length>this.MAX_SCROLLBACK) this._scrollback.shift();
    }
    const top=this._scrollTop,bot=this._scrollBottom;
    for(let r=top;r<bot;r++) for(let c=0;c<this.cols;c++) this.screen.get(c,r).copyFrom(this.screen.get(c,r+1));
    for(let c=0;c<this.cols;c++) this.screen.get(c,bot).clear(this.fgColor,this.bgColor);
    // The flags are part of the rows, so they move with them.
    for(let r=top;r<bot;r++) this._wrapped[r]=this._wrapped[r+1];
    this._wrapped[bot]=false;
  }
  _doScrollDown() {
    this._reflowPushed=0;
    const top=this._scrollTop,bot=this._scrollBottom;
    for(let r=bot;r>top;r--) for(let c=0;c<this.cols;c++) this.screen.get(c,r).copyFrom(this.screen.get(c,r-1));
    for(let c=0;c<this.cols;c++) this.screen.get(c,top).clear(this.fgColor,this.bgColor);
    for(let r=bot;r>top;r--) this._wrapped[r]=this._wrapped[r-1];
    this._wrapped[top]=false;
  }
  scrollUp(n)   { for(let i=0;i<n;i++) this._doScrollUp(); }
  scrollDown(n) { for(let i=0;i<n;i++) this._doScrollDown(); }
  setScrollRegion(top,bottom) {
    this._scrollTop=Math.max(0,top);
    this._scrollBottom=Math.min(this.rows-1,bottom);
    if (this._scrollBottom<this._scrollTop) this._scrollBottom=this._scrollTop;
    this.cx=0; this.cy=this._scrollTop; this._wrapPending=false;
  }

  // ── SGR ───────────────────────────────────────────────────────
  sgr(params) {
    if (!params.length) params=[0];
    let i=0;
    while(i<params.length) {
      const p=params[i++];
      switch(p) {
        case 0: this.fgColor=7; this.bgColor=0; this.bold=false; this.blink=false; this.reverse=false; break;
        case 1: this.bold=true; break;
        case 2: this.bold=false; break;
        case 5: case 6: this.blink=true; break;
        case 7:
          // Reverse video — swap fg/bg in active state (BBS swap-on-set semantics)
          if (!this.reverse) {
            const tmp = this.fgColor;
            this.fgColor = this.bgColor;
            this.bgColor = tmp;
            this.reverse = true;
          }
          break;
        case 22: this.bold=false; break;
        case 25: this.blink=false; break;
        case 27:
          // Reverse video off — un-swap fg/bg
          if (this.reverse) {
            const tmp = this.fgColor;
            this.fgColor = this.bgColor;
            this.bgColor = tmp;
            this.reverse = false;
          }
          break;
        default:
          if (p>=30&&p<=37) { this.fgColor=p-30; break; }
          if (p===39) { this.fgColor=7; break; }
          if (p>=40&&p<=47) { this.bgColor=p-40; break; }
          if (p===49) { this.bgColor=0; break; }
          if (p>=90&&p<=97) { this.fgColor=(p-90)+8; break; }
          if (p>=100&&p<=107) { this.bgColor=(p-100)+8; break; }
          if (p===38||p===48) {
            const mode=params[i++];
            if (mode===5) { const idx=(params[i++]??0)&15; if(p===38) this.fgColor=idx; else this.bgColor=idx; }
            else if (mode===2) i+=3;
          }
          break;
      }
    }
  }

  setMode(params,on) {
    if (params.startsWith('?')) {
      const n=parseInt(params.slice(1),10);
      if (n===25) this.cursorVisible=on;
      if (n===7)  this._autoWrap=on;
    } else {
      if (parseInt(params,10)===4) this._insertMode=on;
    }
  }

  deviceStatus(n) {
    if (!this.onSend) return;
    if (n === 5) this.onSend('\x1B[0n');                          // ready, no malfunction
    if (n === 6) this.onSend(`\x1B[${this.cy+1};${this.cx+1}R`); // cursor position report
  }

  reset() {
    this.screen.clearAll(); this.cx=0; this.cy=0;
    this._savedCX=0; this._savedCY=0;
    this.fgColor=7; this.bgColor=0; this.bold=false; this.blink=false; this.reverse=false;
    this._scrollTop=0; this._scrollBottom=this.rows-1;
    this._wrapPending=false; this._insertMode=false; this._autoWrap=true;
    this.cursorVisible=true; this._reflowPushed=0;
  }

  // ── Scrollback navigation ─────────────────────────────────────
  get scrollbackLength() { return this._scrollback.length; }
  scrollbackUp(n)   { this._scrollOffset=Math.min(this._scrollOffset+n,this._scrollback.length); }
  scrollbackDown(n) { this._scrollOffset=Math.max(0,this._scrollOffset-n); }
  /** Jump straight to an offset (0 = live, scrollbackLength = top). */
  scrollbackTo(n)   { this._scrollOffset=Math.max(0,Math.min(Math.round(n)||0,this._scrollback.length)); }
  /** Where the view sits, 0 = live. Read by the desktop scroll rail. */
  get scrollbackOffset() { return this._scrollOffset; }
  scrollbackHome()  { this._scrollOffset=this._scrollback.length; }
  scrollbackEnd()   { this._scrollOffset=0; }
  isLive()          { return this._scrollOffset===0; }
  clearScrollback() { this._scrollback=[]; this._scrollOffset=0; }

  getDisplayCells() {
    if (this._scrollOffset===0) return this.screen.cells;
    const sbLen=this._scrollback.length;
    const startSB=sbLen-this._scrollOffset;
    const result=[];
    for (let r=0;r<this.rows;r++) {
      const sbIdx=startSB+r;
      if (sbIdx>=0&&sbIdx<sbLen) {
        const sbRow=this._scrollback[sbIdx];
        for (let c=0;c<this.cols;c++) {
          const s=sbRow[c]||{ch:32,fg:7,bg:0,bold:false,blink:false};
          result.push({ch:s.ch,fg:s.fg,bg:s.bg,bold:s.bold,blink:s.blink,dirty:true});
        }
      } else if (sbIdx>=sbLen) {
        const liveRow=sbIdx-sbLen;
        if (liveRow<this.rows) {
          for(let c=0;c<this.cols;c++) result.push(this.screen.get(c,liveRow));
        } else {
          for(let c=0;c<this.cols;c++) result.push({ch:32,fg:7,bg:0,bold:false,blink:false,dirty:true});
        }
      } else {
        for(let c=0;c<this.cols;c++) result.push({ch:32,fg:7,bg:0,bold:false,blink:false,dirty:true});
      }
    }
    return result;
  }

  // ── URL scanning ─────────────────────────────────────────────
  scanURLs() {
    this._urls=[];
    for(let r=0;r<this.rows;r++) {
      let line='';
      for(let c=0;c<this.cols;c++) line+=CP437[this.screen.get(c,r).ch]||' ';
      const re=/https?:\/\/[^\s\x00-\x1F\x7F]*/g; let m;
      while((m=re.exec(line))!==null) this._urls.push({row:r,col:m.index,len:m[0].length,url:m[0]});
    }
  }
  getURLAt(col,row) { return this._urls.find(u=>u.row===row&&col>=u.col&&col<u.col+u.len)||null; }

  /**
   * Text of a selection, for the clipboard.
   *
   * `chars` is the 256-entry table of the ACTIVE FONT's charset. A byte only
   * means a character once an encoding says so, and the encoding belongs to the
   * font (fonts/charsets.js), which this class has no business knowing about —
   * so the caller supplies it. Omitted, it is CP437, which is what every font
   * that predates altfonts resolves to and exactly what this returned before.
   * Supplied, an Amiga board on Topaz copies as Latin-1 rather than as the
   * CP437 mojibake reading its high bytes through the wrong table produces.
   */
  getSelectionText(start,end,chars) {
    const tbl = chars || CP437;
    let [r1,c1]=start,[r2,c2]=end;
    if (r1>r2||(r1===r2&&c1>c2)) { [r1,c1,r2,c2]=[r2,c2,r1,c1]; }
    // Selection coordinates from app.js are viewport-relative — the row
    // number is "what the user sees at the top of the canvas" + offset
    // down. When scrollback is active that's a mixture of scrollback
    // rows (top of viewport) and possibly live rows (bottom). The
    // renderer pulls its cells from getDisplayCells() to honour that;
    // we have to do the same here or copy would silently pull from the
    // live screen and produce content the user did not select.
    const cells = this.getDisplayCells();
    let text='';
    for(let r=r1;r<=r2;r++) {
      const cs=r===r1?c1:0,ce=r===r2?c2:this.cols-1;
      let line='';
      for(let c=cs;c<=ce;c++) {
        const cell = cells[r*this.cols+c];
        line += (cell ? tbl[cell.ch] : null) || ' ';
      }
      text+=line.trimEnd()+(r<r2?'\n':'');
    }
    return text;
  }
}
