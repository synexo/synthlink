// SynthLink browser client.
//
// Reuses synthdoor's browser render stack (ANSI/CP437 terminal + canvas
// renderer) and drives it from a synthmodem *originate* software modem running
// in the page. Keystrokes are modulated to PCM audio and sent to the server
// over a WebSocket; the server's answer modem demodulates them and forwards to
// a telnet BBS. The BBS's bytes come back as modulated audio, which this page
// demodulates and renders. A Web Audio graph plays the carrier (both
// directions) and feeds a real-time oscilloscope.

import { Terminal, ANSIParser } from './terminal.js';
import { Renderer } from './renderer.js';
import { FONTS, cycleFonts, fontById, cycleIndexById, deviceDefaultFont,
         fontLabel, fontCols } from './fonts/index.js';
import { isHybrid } from './fontscale.js';
import { charsetOf } from './fonts/charsets.js';
import { ANSIMusic } from './music.js';

const { ModemDSP, config } = window.SynthModemDSP;

const ROWS = 25;
// Columns are a property of the ACTIVE FONT, not a constant: the 9x14 font
// carries `cols: 40` and selecting it is the only way into 40-column mode
// (fonts/index.js says why the two are tied). Resolved once activeFont exists,
// below, and again on every font change in applyFont().
let COLS = 80;
const SR = 8000;                       // DSP audio rate

// ─── Shareable links: query-string ⇄ controls ───────────────────────────────
// A SynthLink URL can carry a destination and a modulation, so a board can be
// linked to directly:
//
//     ?host=bbs.fozztexx.com&port=23&speed=v34&connect=1
//
// `host` alone is enough — port defaults to 23 and speed to DEFAULT_SPEED.
//
// **Speed is named by protocol, not by bit rate**, because rates collide: 300 is
// both V.21 and Bell 103, 9600 is both V.29 and V.32, and 33600 is both V.34's
// top rate and V.90's upstream. A number would have to guess. The names are the
// <select> values lower-cased, which makes them self-documenting next to the
// menu: v21, bell103, v22, v22bis, v23, v32, v32bis, v34, v90, telnet.
//
// No menu entry names a sub-rate today, so every token is a bare protocol name
// and V.34 is `v34`. The "<proto>-<rate>" form (matching an option value's
// "@rate" suffix) is still parsed and still built, because the rate machinery
// behind it is intact and a rate may be offered again. The separator is a dash
// rather than the '@' an option value would use, because '@' percent-encodes to
// %40 in some clients and turns a tidy link ugly — '@' is still accepted on the
// way in.
//
// Everything here is pure string work, exercised by tools/tests/sharelinktest.js.

// The modulation a fresh visitor gets: V.34, which dials its top rate. Fast
// enough that a modern BBS feels responsive, while still being a real modem
// handshake with something to listen to — unlike `telnet`, which has no
// carrier at all.
const DEFAULT_SPEED = 'V34';

/** <option> value ⇒ URL token.  "V34" → "v34", "V34@33600" → "v34-33600" */
const speedToken = (optValue) => String(optValue).toLowerCase().replace('@', '-');

/**
 * URL token ⇒ <option> value, or '' if it names nothing in the menu.
 *
 * Generous on input, canonical on output: accepts the dash or the '@' form, any
 * casing, an optional "v." prefix (v.32bis, the way the spec writes it), and
 * `telnet`/`direct` for the modem-bypass entry. A bare protocol with no rate
 * matches the highest-rate option for that protocol, so `v34` means 33600 and
 * keeps meaning "the fastest V.34" if a rate is ever added above it.
 *
 * @param {string} token           value of the `speed` query parameter
 * @param {string[]} optionValues  the <select>'s option values, menu order
 */
function speedFromToken(token, optionValues) {
  const t = String(token || '').trim().toLowerCase().replace('@', '-').replace(/^v\./, 'v');
  if (!t) return '';
  if (t === 'telnet' || t === 'direct') return optionValues.includes('direct') ? 'direct' : '';
  // Exact match on the canonical token, e.g. "v34" or "v32bis".
  const exact = optionValues.find((v) => speedToken(v) === t);
  if (exact) return exact;
  // Bare protocol name: take the highest rate offered for it. Menu order is
  // slowest-first, so the last match is the fastest.
  const family = optionValues.filter((v) => speedToken(v).split('-')[0] === t);
  return family.length ? family[family.length - 1] : '';
}

/**
 * Read the destination/modulation a URL is asking for. Absent and malformed are
 * the same answer — a missing key: a link someone hand-edited into nonsense
 * should fall back to normal startup, never to a half-applied state.
 *
 * `connect` accepts the usual truthy spellings, plus a bare `?connect` with no
 * value (some clients strip `=1`). It is ignored without a host, since there
 * would be nothing to dial. Note it does NOT dial on its own — it raises a
 * Connect prompt, which is why it is no longer called `autoconnect`.
 *
 * @param {string} search   location.search, with or without the leading '?'
 * @param {string[]} optionValues  the speed <select>'s option values
 * @returns {{host?:string, port?:string, speed?:string, connect?:boolean}}
 */
function parseShareParams(search, optionValues) {
  const q = new URLSearchParams(String(search || '').replace(/^\?/, ''));
  const out = {};
  // A host is a bare hostname here, never a URL: reject anything with a scheme,
  // credentials, a path or whitespace rather than trying to repair it. This is
  // also the guard that stops a crafted link from putting junk in #host.
  const host = (q.get('host') || '').trim();
  if (host && /^[A-Za-z0-9._-]+$/.test(host) && host.length <= 253) {
    out.host = host;
    // "host:port" in the host param is a natural thing to write, so honour it.
    const port = (q.get('port') || '').trim();
    const n = parseInt(port, 10);
    if (port && n >= 1 && n <= 65535 && String(n) === port) out.port = port;
  }
  const speed = speedFromToken(q.get('speed'), optionValues);
  if (speed) out.speed = speed;
  if (out.host && q.has('connect')) {
    const v = (q.get('connect') || '').trim().toLowerCase();
    out.connect = v === '' || v === '1' || v === 'true' || v === 'yes' || v === 'on'
               || v === 'auto';
    // The URL parameter is `connect=auto`: one parameter with three useful
    // values (1, 0, auto), never a second parameter. `dialOnLoad` is only what
    // this parser calls the result internally, and is deliberately NOT named
    // after a URL key — a field called `connectAuto` reads like
    // `?connectAuto=1`, which is not a thing and has been tried as one.
    //
    // It is a separate flag rather than a third value of `connect` so that
    // everything asking only "does this link dial?" keeps working unchanged,
    // and it is set only when true, so a plain `connect=1` link still parses to
    // exactly the object it always did.
    if (v === 'auto') out.dialOnLoad = true;
  }
  return out;
}

/**
 * Build the link the share panel offers for the current selection. Port is
 * always written out, even the default 23: a link that says what it means
 * survives being pasted into a chat client that helpfully "tidies" it, and the
 * recipient can see the whole destination without opening the page.
 */
function buildShareURL(origin, pathname, { host, port, speed, connect: connectOnOpen }) {
  const q = new URLSearchParams();
  q.set('host', host);
  q.set('port', String(port || 23));
  q.set('speed', speedToken(speed || DEFAULT_SPEED));
  if (connectOnOpen) q.set('connect', '1');
  return `${origin}${pathname}?${q}`;
}

// ─── Embedding ───────────────────────────────────────────────────────────────
// An embed is this page in an iframe and nothing more: the frame's URL uses the
// query vocabulary parseShareParams already reads, so there is no second
// parameter language and no message contract across the frame boundary.
//
// `allow` is not decoration. A nested browsing context is gated harder than a
// top-level one, so without `autoplay` a visitor's click inside the frame cannot
// ungate the speaker, and without `fullscreen` the toggle is refused.
const EMBED_ALLOW = 'autoplay; fullscreen';

// The default box, and both halves are load-bearing.
//
// HEIGHT is a viewport unit, not a percentage and not pixels. A percentage
// height resolves against the containing block only when that block's height is
// definite; in the ordinary case — a frame dropped into an article — the parent
// is `auto`, the percentage computes to `auto` too, and the frame collapses to
// the CSS default of 150px. A `vh` always resolves. Pixels resolve as well but
// pick a number blind: at 600 or below the app's own short-viewport rule takes
// over (`@media (max-height: 600px)` in index.html), the page scrolls and the
// on-screen keyboard stops shrinking the terminal. A frame IS the viewport for
// the document inside it, so that rule fires on a 600px frame in a tall window
// exactly as it does in a 600px window. 90vh clears it on anything but a very
// short screen, where the scrolling layout is the right answer anyway.
//
// WIDTH is a percentage, because width percentages resolve against a block's
// width, which is always definite. 90% keeps the frame inside whatever column
// the embedder put it in rather than overhanging their layout, and the element
// centres what is left over.
const EMBED_WIDTH = '90%';
const EMBED_HEIGHT = '90vh';

/**
 * Build the URL an embed frame loads.
 *
 * A sibling of buildShareURL rather than an argument on it: a share link is
 * always a Connect prompt or nothing, an embed has three modes, and folding them
 * together would change the function the share field's own output is asserted
 * through for the sake of a caller that did not exist when those assertions were
 * written.
 *
 * @param {'auto'|'prompt'|'none'} mode  what the frame does on load
 */
function buildEmbedURL(origin, pathname, { host, port, speed, connect: mode }) {
  const q = new URLSearchParams();
  q.set('host', host);
  q.set('port', String(port || 23));
  q.set('speed', speedToken(speed || DEFAULT_SPEED));
  const c = embedConnectValue(mode);
  if (c) q.set('connect', c);
  return `${origin}${pathname}?${q}`;
}

/**
 * The wizard's three modes ⇒ what the `connect` key is actually spelled as.
 *
 * The element copies its attributes VERBATIM into the query string — that is
 * what "no second parameter vocabulary" means — so a mode name must be
 * translated here and not passed through. `connect="prompt"` would reach
 * parseShareParams as an unrecognised value, which is falsy, and the prompt the
 * embedder asked for would simply never appear.
 *
 * `none` is the empty string: one key, and its absence is the third value.
 */
const embedConnectValue = (mode) =>
  (mode === 'auto' ? 'auto' : mode === 'prompt' ? '1' : '');

/** Attribute-value escape. What these builders return is markup, not a link. */
const embedAttr = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The documented integration: the custom element and the module script defining
 * it. The element builds the frame URL itself, so the embedder states the origin
 * once — in the script src — and cannot state it inconsistently.
 */
function buildEmbedSnippet(scriptSrc, { host, port, speed, connect: mode, width, height }) {
  const c = embedConnectValue(mode);
  const a = [
    `host="${embedAttr(host)}"`,
    `port="${embedAttr(port || 23)}"`,
    `speed="${embedAttr(speedToken(speed || DEFAULT_SPEED))}"`,
    // Omitted rather than empty when the frame is to wait: an attribute that is
    // present and blank invites someone to fill it with a mode name, which is
    // the one thing the query does not accept.
    ...(c ? [`connect="${embedAttr(c)}"`] : []),
    `width="${embedAttr(width || EMBED_WIDTH)}"`,
    `height="${embedAttr(height || EMBED_HEIGHT)}"`,
  ];
  // A CLASSIC script tag. `type="module"` would be fetched in CORS mode, and an
  // embed is cross-origin by definition, so the module form fails on every real
  // embedder with an Access-Control-Allow-Origin error against a 200 response —
  // and never fails in same-origin testing. embed.js's header has the detail.
  return `<script src="${embedAttr(scriptSrc)}"></script>\n`
       + `<synthlink-terminal ${a.join(' ')}></synthlink-terminal>`;
}

/**
 * The fallback for a page that cannot run the script — same frame, stated by
 * hand, which is why the `allow` list is spelled out rather than left to the
 * element.
 */
function buildIframeSnippet(url, { width, height, title }) {
  // The box goes in `style`, not in the width/height attributes: those are
  // pixel counts and cannot carry `90%` or `90vh`. `margin:0 auto` is the
  // centring the element does for itself.
  const box = `border:0; display:block; margin:0 auto;`
            + ` width:${width || EMBED_WIDTH}; height:${height || EMBED_HEIGHT}`;
  return `<iframe src="${embedAttr(url)}"`
       + ` style="${embedAttr(box)}" allow="${EMBED_ALLOW}"`
       + ` title="${embedAttr(title || 'Terminal')}"></iframe>`;
}

// ─── Stored preferences (localStorage, no account) ──────────────────────────
// One JSON blob under one key: last destination, the control states, and the
// favourites list. localStorage rather than cookies — this never needs to reach
// the server, and cookies would ride along on every request for nothing.
//
// Everything here is best-effort. A private-mode browser that refuses storage,
// a corrupt value, a key written by an older build: all degrade to defaults
// rather than throwing, because a preference is never worth breaking the app
// over. Read with prefs.get(key, fallback) so a missing key is normal, not an
// error, and note that `undefined` is a real answer — it's how "the user has
// never touched this control" stays distinguishable from a stored value.
//
// Favourites store the whole record ({name, host, port}), not a pointer into the
// directory: the Telnet BBS Guide list is re-scraped monthly, so a favourite
// that merely referenced a guide entry would rot when that entry moved or went
// away. Self-contained records also let a manually-typed host:port be
// favourited, with an empty name.
const PREFS_KEY = 'synthlink.prefs.v1';
const prefs = {
  _d: {},
  load() {
    try {
      const raw = localStorage.getItem(PREFS_KEY);
      const o = raw ? JSON.parse(raw) : null;
      this._d = (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
      // There used to be a `firstVisit` flag here, captured before anything
      // wrote, to drive a one-time welcome panel. The panel now shows on every
      // visit until it is explicitly dismissed, so nothing needs it and it is
      // gone rather than left to rot. → the welcome panel section below.
    } catch (_) { this._d = {}; }   // unavailable — run stateless
    if (!Array.isArray(this._d.favorites)) this._d.favorites = [];
    return this;
  },
  save() {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(this._d)); } catch (_) {}
  },
  get(k, fallback) { return this._d[k] === undefined ? fallback : this._d[k]; },
  set(k, v) { this._d[k] = v; this.save(); },
  get favorites() { return this._d.favorites; },
  set favorites(list) { this._d.favorites = list; this.save(); },
}.load();

/** Favourites are identified by destination, so this is their primary key. */
const favKey = (host, port) => `${String(host).trim().toLowerCase()}:${port || 23}`;
const favIndex = (host, port) =>
  prefs.favorites.findIndex((f) => favKey(f.host, f.port) === favKey(host, port));
const isFavorite = (host, port) => favIndex(host, port) >= 0;

// Active terminal font. The grid is always 80x25, so the canvas is always 640
// wide, but its HEIGHT (and therefore the aspect fitTerminal preserves) follows
// the font's cell height: 8x16 -> 640x400, 8x19 -> 640x475 (+18.75% height).
// Pixels stay square either way, since fitTerminal scales width and height by
// the same factor. Narrow screens start on the taller font — they're
// width-constrained with vertical room to spare, so the extra rows are free
// there, whereas a height-constrained desktop would just get a narrower
// terminal. See fonts/index.js.
// A stored font is an explicit past choice, so it wins over the automatic pick
// (and, below, suppresses the re-pick on crossing the breakpoint) — the same
// rule the Aa button has always followed within a session, now surviving a
// reload.
const startMobile = window.matchMedia('(max-width: 640px)').matches;
const storedFontId = prefs.get('fontId');
let activeFont = storedFontId ? fontById(storedFontId)
                              : deviceDefaultFont(startMobile);
COLS = fontCols(activeFont);
const cw = () => COLS * activeFont.cellW;    // 640, or 360 at 40 columns
const ch = () => ROWS * activeFont.cellH;    // 400 / 475, or 350 at 40 columns

// ─── DOM ────────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

// The product name. Set in config/site.json and substituted into index.html's
// <meta name="app-brand"> server-side (lib/site.js), so this file — which is
// never templated — carries no hard-coded name either. Read from the DOM rather
// than fetched, so it is available synchronously and cannot paint late.
// Everything user-visible that names the product should go through it.
const BRAND = (document.querySelector('meta[name="app-brand"]') || {}).content || 'SynthLink';

// The UI font stack, read from the --ui-mono custom property in index.html so
// the canvas labels below use the same one the page does — and, more to the
// point, so there is ONE place that decides which font families this page is
// allowed to name. A canvas ctx.font is a font request like any other, and a
// family the browser's font-visibility policy refuses (Firefox's
// resistFingerprinting, Chrome's equivalent) is logged on every load, from here
// just as from a stylesheet. Read once: it never changes, and getComputedStyle
// forces layout.
const UI_MONO = (() => {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--ui-mono').trim();
    if (v) return v;
  } catch (_) {}
  return 'ui-monospace, Menlo, Consolas, monospace';   // property missing
})();
const canvas = $('terminal-canvas');
const wrap = $('wrap');
const hostEl = $('host'), portEl = $('port'), bbsEl = $('bbs');
const hostportEl = $('hostport'), bbsToggle = $('bbstoggle');
const bbsLabel = $('bbslabel'), favBtn = $('favbtn');
const dialBtn = $('dial'), extBtn = $('extension'), listenBtn = $('listen');
const protocolEl = $('protocol');
const led = $('led'), statusEl = $('status');
const scopeCanvas = $('scope'), scopeCtx = scopeCanvas.getContext('2d');
const scopeCollapsedEl = $('scope-collapsed');

canvas.width = cw(); canvas.height = ch();

// ─── Render stack (reused verbatim from synthdoor) ──────────────────────────
const term     = new Terminal(COLS, ROWS);
const renderer = new Renderer(canvas, COLS, ROWS, activeFont);
const parser   = new ANSIParser(term);
const music    = new ANSIMusic();

// Telnet is terminated at the SERVER (lib/telnet.js), so the modem's bytes are
// already plain payload — they go straight into the ANSI parser. See
// DEVLOG.md.
term.onSend   = (s) => modemWrite(s);
term.onANSIMusic = (s) => { if (monitor.audible()) music.play(s); };

let dirty = true, cursorOn = true, blinkPhase = true;
// The live mouse selection, or null. Read by the render loop and drawn by the
// renderer's overlay; the wiring that maintains it is down with the press path.
let selection = null;
let rxBytes = 0, txBytes = 0;            // payload bytes through the modem (both dirs)
let flowBps = 0;                         // smoothed live throughput, shown on the scope
// 'modem' = payload is modulated to PCM and carried as audio; 'direct' = the
// modem is bypassed and payload rides raw binary WS frames. Set per call from
// the speed dropdown. In direct mode the scope box becomes a throughput graph,
// since there is no waveform to show.
let linkMode = 'modem';

// Kept as a handle because the splash dismissal waits on it — a terminal that
// has not drawn its first frame is exactly what the splash is covering.
const rendererReady = renderer.init().then(() => {
  fitTerminal();
  (function renderLoop() {
    if (dirty || !term.isLive()) {
      renderer.drawFrame(term.getDisplayCells(), term.cx, term.cy,
        term.cursorVisible && term.isLive(), cursorOn, blinkPhase, selection);
      dirty = false;
    }
    requestAnimationFrame(renderLoop);
  })();
});
setInterval(() => { cursorOn = !cursorOn; dirty = true; }, 500);
setInterval(() => { blinkPhase = !blinkPhase; dirty = true; }, 300);

// ─── Repaint after the page comes back ──────────────────────────────────────
// The terminal going blank after a spell in the background is a CACHE
// disagreement, not lost text: the model still holds every cell, but the
// renderer only redraws cells that changed, and a mobile browser is free to
// throw away a backing store while the page is hidden. It comes back cleared,
// the per-cell cache still says every cell is already correct, and so nothing
// is ever drawn again — the screen stays empty until something happens to
// touch each cell.
//
// Dropping that cache is half the fix, and on Android it was the half that
// does not matter: the browser discards the GLYPH ATLAS too, and an atlas that
// comes back empty makes every blit draw nothing. The terminal then stays black
// through a redraw while the cursor — a fillRect that needs no atlas — moves
// around it, which is exactly what the device reports show. renderer.restore()
// invalidates AND re-inks whatever was actually lost; it rebuilds from data
// already in hand, never from the network, and does nothing beyond the
// invalidate when nothing was lost. Still NOT a refit — the layout did not
// change.
//
// Both events are listened for because they are not the same event: an app
// switch or screen lock fires visibilitychange, while a page restored from the
// bfcache fires only pageshow. Running it when nothing was lost costs one
// frame.
function repaintAll() {
  if (renderer.restore) renderer.restore();
  else if (renderer.invalidateAll) renderer.invalidateAll();
  else return;
  dirty = true;
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) repaintAll(); });
window.addEventListener('pageshow', repaintAll);

// ─── Terminal fit-to-window (preserves the active font's aspect) ────────────
const isMobile = () => window.matchMedia('(max-width: 640px)').matches;
// Set by the page-grab IIFE further down (same stub pattern as keyboardIsOpen).
// fitTerminal is where every layout change lands, so it is also where the grab
// bar's visibility is re-decided.
let updatePageGrab = () => {};
/**
 * A CSS length in px, kept EXACT rather than rounded to a whole CSS pixel.
 *
 * The hybrid path's whole point is that the backing store and the displayed box
 * agree exactly — disagree by so much as a fraction and the browser
 * resamples the canvas, which is the resampling the atlas exists to remove. At
 * a fractional dpr (2.625 is the common Android case) `deviceBox().w / dpr` is
 * fractional by construction, so rounding it is not a tidy-up: it is up to a
 * whole CSS pixel of the screen given away, at both the right edge and the
 * bottom. Three decimals is finer than any device's pixel and the trailing
 * zeros are trimmed, so a whole number still writes as `1400px`.
 */
const cssPx = (v) => `${Math.round(v * 1000) / 1000}px`;
function fitTerminal() {
  if (typeof zoomOff === 'function') zoomOff();   // base box is about to move
  // A selection is a pair of cell coordinates, and this is about to change what
  // a cell coordinate means — a re-flow rebuilds the screen from its own lines.
  // Dropping it is the only answer that cannot be subtly wrong.
  if (typeof clearSelection === 'function') clearSelection();
  const kbdOpen = document.body.classList.contains('kbd-open');
  const mobile = isMobile();
  const M = mobile ? 0 : 3;               // no breathing room on mobile — maximize pixels
  const aspect = cw() / ch();             // 1.60 at 8x16, 1.347 at 8x19
  const availW = wrap.clientWidth - 2 * M;
  // On mobile with the keyboard open the whole page scrolls, so size the terminal
  // by width only (keep it full-size instead of shrinking to share the height).
  const heightBinds = !(mobile && kbdOpen);
  const availH = heightBinds ? wrap.clientHeight - 2 * M : Infinity;
  let w = availW, h = w / aspect;
  if (h > availH) { h = availH; w = h * aspect; }
  // ── Hybrid-scaled fonts: size the BACKING STORE in device pixels ─────────
  // On the legacy path the backing store is a fixed
  // 640x400 (or 640x475, or 360x350) and the browser stretches it to the CSS
  // box — which is precisely the resampling this path exists to remove. So a
  // hybrid font owns its backing store instead.
  //
  // The renderer is handed the device-pixel box it MAY use and reports back the
  // slightly smaller box it actually chose (the snap rounds the pitch down).
  // The CSS size is then derived from THAT, so backing store and display box
  // agree and the browser resamples nothing. Getting this backwards leaves the
  // whole scheme inert, which is the failure above.
  //
  // A font without the flag skips this entirely — setDeviceMetrics() returns
  // having done nothing, deviceBox() is null, and the two writes below are the
  // same two writes they have always been.
  //
  // HAND IT THE REAL BOX, NOT THE ASPECT-FITTED ONE. `layout()` does its own
  // aspect arithmetic (width drives, the height it has clamps), so
  // passing the `h` computed above is not merely redundant — it is lossy. `h`
  // is a fraction, flooring it to whole device pixels shaves up to a device
  // pixel of height off the budget, and layout() then reads that shortfall as a
  // height constraint and narrows the terminal to keep the aspect. On a 390 CSS
  // px phone at dpr 3 that cost 2 device pixels of width, every time, on every
  // 80-column font: the terminal stopped one CSS pixel short of the screen edge
  // and no amount of width was ever going to reach it, because the number that
  // shortened it was the HEIGHT. The 40-column font escaped it only by landing
  // on kinder arithmetic. Pass the true available box and the clamp fires only
  // when the height genuinely binds.
  if (isHybrid(activeFont)) {
    const dpr = window.devicePixelRatio || 1;
    // Infinity (keyboard open) has to become a number layout() can compare
    // against; the width-driven height plus a pixel of slack never binds.
    const budgetW = Math.floor(availW * dpr);
    const budgetH = heightBinds ? Math.floor(availH * dpr)
                                : Math.ceil(budgetW / aspect) + 1;
    const box = hybridFit(budgetW, budgetH);
    // A null box means the rebuild was deferred (see hybridFit): keep the CSS
    // size this function already computed and let the browser stretch the
    // existing atlas for a few frames.
    if (box) { w = box.w / dpr; h = box.h / dpr; dirty = true; }
  }

  // Not floored. `Dw / dpr` is fractional at a fractional dpr, and flooring it
  // gives the browser a CSS box up to a whole CSS pixel narrower than the
  // backing store it is displaying — a resample of the entire canvas,
  // and another pixel of black at the screen edge. A fractional CSS width
  // resolves to whole physical pixels; that was one of the probe's two
  // load-bearing questions and it PASSED on a real device. Trimmed rather
  // than fixed-precision so a whole number still
  // writes as `1400px`.
  canvas.style.width = cssPx(w);
  canvas.style.height = cssPx(h);
  syncKeyboardWidth(w);                   // keyboard never wider than the terminal
  updatePageGrab();                       // the page may have become (un)scrollable
}
// ─── Hybrid atlas rebuild, debounced against resize ─────────────────────────
// Re-laying out the hybrid path is not free: the
// atlas is 256 glyphs at the DEVICE cell size (1.4 MB at a 24x57 cell), and
// dropping it also drops the per-colour tinted sheets built from it, so the
// next frame re-tints every colour the screen is using. Measured at a 1920-px
// terminal that is ~18 ms for the atlas and ~110 ms including the repaint —
// more than a frame, on an event that fires dozens of times per second while a
// desktop window is being dragged.
//
// So the rebuild waits for the drag to STOP. In the meantime the canvas keeps
// the atlas it has and the browser stretches it to the new CSS box, which is
// precisely what the legacy path does permanently — a few frames of ordinary
// resampling during a drag is not a defect, and it is invisible next to the
// jank of rebuilding on every event.
//
// Two cases deliberately do NOT wait:
//   - the FIRST layout, where there is no atlas to stretch in the meantime;
//   - a font change, because setFont() drops the hybrid state, which puts us
//     back in the first-layout case and makes the switch feel instant.
//
// A rotate is a single discrete change, so it simply pays the delay once.
const HYBRID_SETTLE_MS = 120;
let _hybridWant = null, _hybridTimer = 0;

function hybridFit(availW, availH) {
  _hybridWant = [availW, availH];

  // Nothing to stretch yet — build now, and let fitTerminal size the CSS box
  // from the result.
  if (!renderer.deviceBox()) {
    renderer.setDeviceMetrics(availW, availH);
    return renderer.deviceBox();
  }
  // Already exact for this box. The common case by far: fitAll() runs on
  // several triggers that are not resizes at all.
  if (renderer.deviceMetricsMatch(availW, availH)) return renderer.deviceBox();

  if (_hybridTimer) clearTimeout(_hybridTimer);
  _hybridTimer = setTimeout(() => {
    _hybridTimer = 0;
    // The font may have changed to a legacy one while we waited, in which case
    // there is nothing to rebuild and the canvas is already sized for it.
    if (!isHybrid(activeFont) || !_hybridWant) return;
    renderer.setDeviceMetrics(_hybridWant[0], _hybridWant[1]);
    const box = renderer.deviceBox();
    if (box) {
      // Snap the CSS box to the exact device box. Skipping this would leave the
      // backing store and the displayed box disagreeing by up to a pixel, and
      // the browser would resample the whole thing — the failure mode above, which
      // silently discards everything the atlas just bought.
      const dpr = window.devicePixelRatio || 1;
      canvas.style.width = cssPx(box.w / dpr);
      canvas.style.height = cssPx(box.h / dpr);
      syncKeyboardWidth(box.w / dpr);
      updatePageGrab();
    }
    dirty = true;
  }, HYBRID_SETTLE_MS);

  return null;             // defer: stretch what we have for now
}

// The keyboard is capped at the terminal's width so the two read as one object.
// That cap is a MAXIMUM in both senses: `#keyboard` is `width:100%` of the bar
// below the terminal, so raising the cap can never widen it past the viewport —
// which is what makes the floor below safe to apply unconditionally.
//
// The floor exists because a narrow terminal drags ten keys per row down with
// it. 40-column mode in mobile landscape is the case that reaches it: height
// binds, the terminal comes out far narrower than the screen, and the keys
// collapse until a 4-character label no longer fits the button drawn under it.
// The keyboard is then allowed to be wider than the terminal rather than
// illegible — the alignment is a nicety, being able to read the keys is not.
const KBD_MIN_KEY = 30;   // px per key at the floor; a "Home"/"Ctrl" label fits
const KBD_MIN_W = 10 * KBD_MIN_KEY + 9 * 5 + 12;   // ten keys, nine 5px gaps, 6px padding a side
function syncKeyboardWidth(termW) {
  const kb = document.getElementById('keyboard');
  if (!kb || kb.hasAttribute('hidden')) return;
  const w = (termW != null) ? termW : document.getElementById('terminal-canvas').getBoundingClientRect().width;
  kb.style.maxWidth = Math.round(Math.max(w, KBD_MIN_W)) + 'px';
}
// ─── Header width balancing ──────────────────────────────────────────────────
// Flexbox cannot give the scope the width the controls did not use, and this is
// the one place in the layout where that matters.
//
// The bar is [ #controls | #scope-wrap ]. #controls shrinks from its max-content
// basis to whatever is left beside the scope's reserved width, and its ROWS then
// wrap inside that box. But the box keeps the width it was given, even when the
// wrapped rows come nowhere near filling it: at 1314px the column is handed
// ~1006px, wraps the button run onto a second line that ends around 700px, and
// the remaining ~300px sits empty between the controls and the scope. There is
// no CSS expression for "shrink to the widest line AFTER wrapping" — wrapping
// depends on the width, so resolving it is inherently a second pass.
//
// So: measure the wrapped result and pin #controls to it. The scope, which
// grows, then takes everything that frees up.
//
// Loop-safe by construction. The measurement runs with the width override
// CLEARED, so it always reads the browser's own natural layout, and the value
// it produces is the widest line that layout already produced — every row still
// fits at that width, so re-applying it cannot cause further wrapping and the
// second pass is stable. Nothing observes #controls' size, so our own write
// never feeds back.
//
// MEASURE AT THE WIDTH THE COLUMN WILL ACTUALLY GET, not at its max-content.
// Clearing the override looks like the way to "read the natural layout" and is
// wrong: a wrapping flex container's max-content width is NOT the width its
// children need on one line. `#dest`'s own children are sized in percentages,
// which contribute nothing to intrinsic width, so the column resolves ~140 px
// narrower than the row it then has to lay out. The row wraps at that width,
// `needed` comes back as the wrapped line, and the header keeps a second row it
// never needed — on a window with hundreds of spare pixels beside the scope.
// It presents as "a manual entry grows the header", because swapping the
// dropdown for the host:port field is one of the small width changes that
// crosses the threshold; Connect widening to Hang up is another.
//
// The width the column will actually get is the bar's content box, less the gap
// and the scope's RESERVED width (its min-width — the clamp that stops the
// scope collapsing). Measuring there wraps exactly when a wrap is genuinely
// needed, and `needed` is then the widest line of a layout that still fits once
// pinned — which is what keeps the second pass stable.
const controlsEl = $('controls');
const scopeWrapEl = $('scope-wrap');
function controlsAvailable() {
  const bar = $('bar');
  if (!bar || !scopeWrapEl) return 0;
  const cs = getComputedStyle(bar);
  const inner = bar.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
  const gap = parseFloat(cs.columnGap) || parseFloat(cs.gap) || 0;
  const reserve = parseFloat(getComputedStyle(scopeWrapEl).minWidth) || 0;
  return Math.max(0, inner - gap - reserve);
}
function fitBar() {
  // Stacked layout: the scope has its own full-width row and the controls have
  // the whole bar. Nothing to balance, and an override would only fight it.
  if (isMobile()) { controlsEl.style.width = ''; return; }
  // 0 means there is no usable box yet (pre-layout, display:none). Fall back to
  // clearing rather than pinning the column to nothing.
  const avail = controlsAvailable();
  controlsEl.style.width = avail > 0 ? `${avail}px` : '';
  let needed = 0;
  for (const row of controlsEl.querySelectorAll('.row')) {
    const rr = row.getBoundingClientRect();
    for (const el of row.children) {
      const r = el.getBoundingClientRect();
      // scrollWidth covers a child that is CLIPPING its content rather than
      // sizing to it — #status is nowrap with an ellipsis, so its box can be
      // narrower than the text it wants. Taking the larger of the two keeps a
      // long status from being squeezed further than it already is.
      const w = Math.max(r.width, el.scrollWidth);
      needed = Math.max(needed, (r.left - rr.left) + w);
    }
  }
  if (needed > 0) controlsEl.style.width = `${Math.ceil(needed)}px`;
}
// Coalesced to one pass per frame: several of the callers below can fire
// together (a resize that also relabels the dropdown, say), and fitBar forces
// layout twice, so it is worth doing once.
let _barFitPending = false;
function scheduleBarFit() {
  if (_barFitPending) return;
  _barFitPending = true;
  requestAnimationFrame(() => { _barFitPending = false; fitBar(); });
}

function fitAll() { fitBar(); fitTerminal(); sizeScope(); }
window.addEventListener('resize', fitAll);
window.addEventListener('load', fitAll);
// Web fonts land after first paint and change every text metric in the bar, so
// the first measurement would otherwise be of the fallback font's layout.
// This re-runs the WHOLE fit rather than just fitBar(): a bar whose height
// changes takes that height from the terminal, which is sized against whatever
// height #wrap has at the moment fitTerminal() runs.
if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(fitAll).catch(() => {});
}

// The header's height is not settled at first paint, and the terminal is sized
// from what the header leaves. Several things land after fitTerminal() has
// already run: the web font's metrics, the status line's real text (a
// placeholder until /bbs.json resolves and it becomes "ready — press Connect to
// dial (N dials total…)"), and the dropdown's width once the directory
// populates it. Any of them can re-wrap the control rows and change the bar's
// height by a row. That was the symptom: the terminal loaded a little small
// with dead space around it and snapped to the right size on the first window
// resize — because a resize is what re-ran the fit.
//
// So observe the bar and re-fit when its height actually changes. HEIGHT only:
// fitBar() writes #controls' width, and reacting to a width change would be our
// own write feeding back. Guarded because the extraction-based harnesses run
// this file in environments with no ResizeObserver.
if (typeof ResizeObserver === 'function') {
  const barEl = $('bar');
  if (barEl) {
    let lastBarH = -1;
    new ResizeObserver(() => {
      const h = Math.round(barEl.getBoundingClientRect().height);
      if (h === lastBarH) return;
      lastBarH = h;
      fitTerminal();
      sizeScope();
      // border-box, because that is the height the terminal actually loses: the
      // bar's padding and bottom border are part of what it takes from #wrap,
      // and a content-box observation would miss a change in either.
    }).observe(barEl, { box: 'border-box' });
  }
}

// Resolved once the welcome panel is out of the way: it decided not to open,
// its text could not be fetched, or the visitor closed it. Declared here rather
// than down with the panel because the splash below waits on it, and a promise
// somebody waits on must exist before the wait is set up.
let _welcomeSettle;
const welcomeSettled = new Promise(r => { _welcomeSettle = r; });

// The same for the Connect prompt, and for the same reason. A shared ?connect=
// link raises that box INSTEAD of the welcome panel — the two are never on
// screen together — so whichever greeting this visitor got, the splash waits
// for it rather than fading out behind one of them.
let _dialSettle;
const dialSettled = new Promise(r => { _dialSettle = r; });

// Splash dismissal. The controller is inline in index.html and owns the fade;
// this is the one call that says the app is up, and it is made from here rather
// than from `load` because `load` fires before the three things that visibly
// move: the terminal's first frame, the web font's metrics (which re-fit the
// bar and therefore the terminal), and the directory landing in the dropdown.
// The controller dismisses itself on its own fallbacks if this never runs, so
// nothing here may throw and nothing downstream may wait on it.
//
// hold() first, synchronously: this file running is itself the evidence that
// the controller's blind fallbacks are not needed, and one of them (load +
// 1.5s) would otherwise cut the splash off under an open welcome panel.
if (window.SplashScreen) window.SplashScreen.hold();
Promise.all([
  rendererReady,
  (document.fonts && document.fonts.ready) || Promise.resolve(),
  document.readyState === 'complete'
    ? Promise.resolve()
    : new Promise(r => window.addEventListener('load', r, { once: true })),
  // The greeting is the thing the visitor is actually looking at while it is
  // up, so fading the splash behind it would spend the whole effect on nobody.
  // → welcomeSettled, resolved by the welcome panel section below whether it
  // opens or not, and dialSettled for the Connect prompt a shared link raises
  // in its place. Both resolve when their box never opens at all.
  welcomeSettled,
  dialSettled,
]).catch(() => {}).then(() => {
  // One frame past the last fit, so the fade starts over a settled layout
  // rather than over the reflow it was hiding.
  requestAnimationFrame(() => {
    if (window.SplashScreen) window.SplashScreen.ready();
  });
});

// In-place iterative radix-2 FFT, used only when the AnalyserNode cannot run
// (see monitor.readSpectrum). Length must be a power of two.
function fftInPlace(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k],           ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr;            im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;  im[i + k + len / 2] = ui - vi;
        const nr = cr * wr - ci * wi;   ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

// ─── Audio monitor + oscilloscope (Web Audio) ───────────────────────────────
// Graph:  bufferSource(s) → analyser → gain → destination
// The analyser sits BEFORE the gain, so the oscilloscope sees the real carrier
// waveform even when the gain is muted. Audio is always scheduled during a call
// (so the scope runs regardless of the Listen state); gain controls audibility.
//
// That covers muting, but not the case where the AudioContext itself is not
// RUNNING: an AnalyserNode only advances with its context, so a suspended one
// hands the scope a flat line however loud the carrier is. `connect=auto` has
// no gesture to resume a context with, so the display was riding on playback
// rather than on the modem. The rings below carry the same frames the monitor
// is fed and are the scope's source whenever the context cannot run, which
// makes the trace a function of the carrier alone.
const SCOPE_FFT = 2048;                  // scope/spectrum window, in samples
// Bus geometry, all at SR. The ring holds comfortably more than the longest
// clip (a ~4.6 s dial sequence) plus its lead. BUS_WRITE_LEAD is the jitter
// budget: writers aim this far ahead of what is being heard, and BUS_POST_LEAD
// of it is already queued inside the sink.
const BUS_LEN = SR * 8;
const BUS_WRITE_LEAD = Math.round(SR * 0.25);
const BUS_POST_LEAD  = Math.round(SR * 0.10);
const BUS_PUMP_MS = 40;
const monitor = {
  ctx: null, gain: null, sink: null,
  // Speaker mode: 'auto' (audible through dial + handshake, then fade to silence
  // on connect), 'listen' (always audible), 'mute' (always silent). `autoOn`
  // tracks whether Auto is currently in its audible phase.
  mode: ['auto', 'listen', 'mute'].includes(prefs.get('speaker')) ? prefs.get('speaker') : 'auto',
  autoOn: false,
  _fadeTimer: null,

  // ── The bus ───────────────────────────────────────────────────────────────
  // One ring of PCM at the DSP's own rate, holding the local mix: carrier both
  // directions, call-progress tones, the handset clip. Positions are ABSOLUTE
  // sample indices from the start of the call (`% BUS_LEN` to index the ring),
  // so a cursor can be compared against another without wrap arithmetic.
  //
  //      writers ──▶ [ ............ bus ............ ] ──▶ scope + spectrum
  //                                    └──▶ sink ──▶ gain ──▶ speaker
  //
  // `playPos()` is the sample being heard right now. It runs off the wall clock
  // so it advances whether or not the context does — which is the whole point:
  // the scope reads the signal, not the playback. When audio IS running the sink
  // reports what it still holds unplayed and the epoch is nudged to match, so the
  // trace stays locked to the speaker rather than drifting away from it.
  bus: new Float32Array(BUS_LEN),
  busEpoch: 0,          // wall-clock ms at absolute sample 0
  busCleared: 0,        // slots below this are written; above, not yet zeroed
  postFrontier: 0,      // handed to the sink; nothing may be written below it
  wcur: { tx: -1, rx: -1 },
  clips: [],
  pumpTimer: null,

  playPos() { return Math.floor((performance.now() - this.busEpoch) / 1000 * SR); },

  // Zero the ring forward to `end` so writers can sum into it. Clearing is
  // monotonic and always ahead of the post frontier, so it can never wipe a
  // sample that is still to be played or still inside the scope's window.
  _reserve(end) {
    if (end <= this.busCleared) return;
    const from = Math.max(this.busCleared, end - BUS_LEN);
    for (let i = from; i < end; i++) this.bus[((i % BUS_LEN) + BUS_LEN) % BUS_LEN] = 0;
    this.busCleared = end;
  },

  _mix(at, pcm, sign = 1) {
    this._reserve(at + pcm.length);
    for (let i = 0; i < pcm.length; i++) {
      const k = ((at + i) % BUS_LEN + BUS_LEN) % BUS_LEN;
      this.bus[k] += sign * pcm[i];
    }
  },

  // Carrier frames, one direction at a time. Each direction keeps its own write
  // cursor and simply continues from it; the only rule is that nothing may be
  // written at or below the post frontier, because those samples are already
  // gone. Falling behind it means a stall long enough that the audio is past —
  // the frames are dropped for LISTENING only. The demodulator is on the other
  // side of this and receives every sample regardless: the speaker can never
  // affect the link.
  feed(which, f32) {
    const floor = Math.max(this.postFrontier, this.playPos());
    let w = this.wcur[which];
    if (w < floor) w = floor + BUS_WRITE_LEAD;      // first frame, or after a stall
    this._mix(w, f32);
    this.wcur[which] = w + f32.length;
    this._startPump();
  },

  // Call-progress tones and the handset pickup: finished PCM, mixed in at a
  // position rather than scheduled as its own node. `kind` is what a hang-up
  // selects on — it silences the dial sequence and leaves the handset alone.
  playClip(pcm, delaySecs = 0, kind = 'progress') {
    const at = Math.max(this.postFrontier, this.playPos())
             + BUS_WRITE_LEAD + Math.round(delaySecs * SR);
    const clip = { pcm, at, kind };
    this._mix(at, pcm);
    this.clips.push(clip);
    this._startPump();
    return clip;
  },
  // Un-mix whatever of the clip has not been handed to the sink yet. Subtracting
  // exactly what was added is what makes this safe with a carrier underneath it;
  // zeroing the span would take the carrier with it.
  dropClip(clip) {
    const i = this.clips.indexOf(clip);
    if (i < 0) return;
    this.clips.splice(i, 1);
    const from = Math.max(clip.at, this.postFrontier);
    const off = from - clip.at;
    if (off < clip.pcm.length) this._mix(from, clip.pcm.subarray(off), -1);
  },
  stopClips(kind) {
    for (const c of this.clips.filter((c) => c.kind === kind)) this.dropClip(c);
  },
  clipsPlaying(kind) {
    const now = Math.max(this.postFrontier, this.playPos());
    return this.clips.some((c) => c.kind === kind && c.at + c.pcm.length > now);
  },

  // ── The sink ──────────────────────────────────────────────────────────────
  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      // At the DSP's own rate the sink's resample ratio is 1. Not every device
      // grants the rate — a phone's audio unit runs at its hardware rate — hence
      // the fallback, and the sink resamples whenever they differ.
      try { this.ctx = new AC({ sampleRate: SR }); } catch (_) { this.ctx = new AC(); }
      this.gain = this.ctx.createGain();
      this.gain.connect(this.ctx.destination);
      this._applyGain();
      this.busEpoch = performance.now();
      this._makeSink();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  },
  // One ScriptProcessor pulling the bus as a continuous stream. Not scheduled
  // buffers: there is no boundary between them to slip a sample at, and no
  // cursor to re-anchor when a refill runs late, which is what used to click.
  // `step` resamples the DSP's rate into the context's; at a ratio of 1 the
  // interpolation degenerates to a copy. Underrun holds the last sample rather
  // than dropping to zero — at 8 kHz a stall is over in a block or two, and a
  // click is worse than a briefly frozen tone.
  _makeSink() {
    if (this.sink || !this.ctx.createScriptProcessor) return;
    const step = SR / this.ctx.sampleRate;
    const q = [];
    let pos = 0, last = 0;
    const next = () => {
      while (q.length) {
        const cur = q[0], i = Math.floor(pos);
        if (i < cur.length) {
          const a = cur[i];
          const b = (i + 1 < cur.length) ? cur[i + 1]
                  : (q.length > 1 && q[1].length) ? q[1][0] : a;
          last = a + (b - a) * (pos - i);
          pos += step;
          return last;
        }
        pos -= cur.length;
        q.shift();
      }
      return last;
    };
    const n = this.ctx.createScriptProcessor(1024, 1, 1);
    n.onaudioprocess = (e) => {
      const out = e.outputBuffer.getChannelData(0);
      for (let i = 0; i < out.length; i++) out[i] = next();
      let queued = -pos;
      for (const sl of q) queued += sl.length;
      this._heard(Math.max(0, queued));
    };
    n.connect(this.gain);
    this.sink = { node: n, push: (pcm) => q.push(pcm),
                  flush: () => { q.length = 0; pos = 0; } };
    this.postFrontier = Math.max(this.postFrontier, this.playPos());
  },
  // What the sink is actually sounding, translated back into an epoch. Small,
  // continuous corrections — the clock tracks, this only removes drift.
  _heard(queued) {
    const want = performance.now() - ((this.postFrontier - queued) / SR) * 1000;
    this.busEpoch += (want - this.busEpoch) * 0.25;
  },
  _startPump() {
    if (!this.pumpTimer) this.pumpTimer = setInterval(() => this._pump(), BUS_PUMP_MS);
  },
  // Hand the sink everything up to a short lead ahead of the play position. When
  // there is nothing to hand it to — no sink yet, or a context the autoplay
  // policy will not start — the frontier still advances, so the bus stays
  // coherent for the scope and no backlog can build up to be dumped on the
  // visitor's first touch later.
  _pump() {
    const end = this.playPos() + BUS_POST_LEAD;
    if (end <= this.postFrontier) return;
    // Zero anything no writer has claimed, before reading it out.
    //
    // The ring is only cleared by _reserve(), and _reserve() only runs from
    // _mix() — so while SOMETHING is writing (a carrier, a clip) the span ahead
    // is always freshly zeroed and this line is a no-op. The moment nothing is
    // writing it stops being one: busCleared stops advancing, and the pump reads
    // back whatever was in the ring the last time round and sounds it again,
    // looping every BUS_LEN. Nothing ever left the bus unattended before — a
    // hang-up reset it in the same tick the carrier stopped — so this could not
    // show until a tone had to outlive the call that caused it.
    //
    // Safe against a writer that is ahead: _mix() reserves before it writes, so
    // busCleared is always >= the end of anything written, and _reserve() is an
    // early return whenever that is past `end`.
    this._reserve(end);
    if (this.sink && this.ctx && this.ctx.state === 'running') {
      const n = Math.min(end - this.postFrontier, BUS_LEN);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        out[i] = this.bus[((this.postFrontier + i) % BUS_LEN + BUS_LEN) % BUS_LEN];
      }
      this.sink.push(out);
    }
    this.postFrontier = end;
  },

  // Prime the output pipeline on the connect gesture. The sink holds the output
  // device open for as long as it is connected, so all that is left here is the
  // resume, which must happen on the gesture itself.
  prime() { this.ensure(); },

  // Is the speaker currently audible? Drives both the gain and the button icon.
  audible() {
    if (this.mode === 'listen') return true;
    if (this.mode === 'mute')   return false;
    return this.autoOn;                       // auto
  },
  _applyGain() { if (this.gain) this.gain.gain.value = this.audible() ? 0.25 : 0.0; },
  // Fade the monitor to silence over `seconds`, then run onDone. Used on connect
  // when the user hasn't expressed a Listen preference: they hear the handshake
  // at full volume, then it gracefully mutes like a modem speaker cutting out.
  startAutoFade(seconds, onDone) {
    if (!this.gain) return;
    const g = this.gain.gain, now = this.ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(0.25, now);
    g.linearRampToValueAtTime(0.0, now + seconds);
    if (this._fadeTimer) clearTimeout(this._fadeTimer);
    this._fadeTimer = setTimeout(() => { this._fadeTimer = null; onDone && onDone(); }, seconds * 1000);
  },
  cancelAutoFade() {
    if (this._fadeTimer) { clearTimeout(this._fadeTimer); this._fadeTimer = null; }
    if (this.gain) this.gain.gain.cancelScheduledValues(this.ctx.currentTime);
    this._applyGain();          // snap back to the current enabled/muted level
  },

  // A call's worth of bus. Absolute positions restart from zero, so everything
  // holding one is rebased with it — including a clip that is still sounding.
  // A hang-up ends the call but must NOT cut an extension clip mid-playback;
  // that used to come free from the clip owning a separate graph node, and now
  // has to be said. What is already inside the sink bridges the rebase, so the
  // queue is only flushed when there is nothing being carried across.
  reset() {
    const now = Math.max(this.postFrontier, this.playPos());
    const carry = [];
    for (const c of this.clips) {
      const off = Math.max(0, now - c.at);
      if (off < c.pcm.length) carry.push([c, c.pcm.subarray(off)]);
    }
    this.bus.fill(0);
    this.busEpoch = performance.now();
    this.busCleared = 0; this.postFrontier = 0;
    this.wcur.tx = this.wcur.rx = -1;
    this.clips.length = 0;
    if (!carry.length && this.sink) this.sink.flush();
    for (const [c, rest] of carry) {
      c.pcm = rest; c.at = BUS_POST_LEAD;      // resumes where the sink's queue ends
      this._mix(c.at, c.pcm);
      this.clips.push(c);
    }
  },

  // ── What the scope reads ──────────────────────────────────────────────────
  // The window ending at the play position: exactly the samples leaving the
  // speaker now, carrier and tones together, because the bus is where they were
  // mixed. There is no second source and no branch — muted, suspended or
  // playing, this is the same read.
  readTimeDomain(out) {
    const start = this.playPos() - out.length;
    for (let i = 0; i < out.length; i++) {
      out[i] = this.bus[(((start + i) % BUS_LEN) + BUS_LEN) % BUS_LEN];
    }
  },
  _spec: null,
  /** Frequency bins, 0..255 — the mapping getByteFrequencyData used to publish. */
  readSpectrum(out) {
    const N = SCOPE_FFT;
    if (!this._spec) {
      this._spec = { td: new Float32Array(N), re: new Float32Array(N),
                     im: new Float32Array(N), sm: new Float32Array(N / 2) };
    }
    const s = this._spec;
    this.readTimeDomain(s.td);
    // Blackman window and the scale the AnalyserNode published: magnitude
    // normalised by N, smoothed by 0.8, then [-100, -30] dB across 0..255. Kept
    // identical so the band arithmetic that draws the bars did not have to change.
    for (let i = 0; i < N; i++) {
      const a = 2 * Math.PI * i / (N - 1);
      s.re[i] = s.td[i] * (0.42 - 0.5 * Math.cos(a) + 0.08 * Math.cos(2 * a));
      s.im[i] = 0;
    }
    fftInPlace(s.re, s.im);
    for (let k = 0; k < N / 2; k++) {
      const m = Math.sqrt(s.re[k] * s.re[k] + s.im[k] * s.im[k]) / N;
      s.sm[k] = s.sm[k] * 0.8 + m * 0.2;
      const db = 20 * Math.log10(s.sm[k] || 1e-12);
      out[k] = Math.max(0, Math.min(255, Math.round((db + 100) / 70 * 255)));
    }
  },
};

// Oscilloscope rendering — genuine time-domain trace from the AnalyserNode.
let scopeData = new Float32Array(2048);
let scopeSmoothPeak = 0.2;

// Spectrum analyser — frequency-domain bars drawn behind the scope trace.
// Reuses the same AnalyserNode (fftSize 2048 → 1024 frequency bins). Bars are
// grouped into a fixed set of bands, log-spaced across the useful band, with
// per-band peak-hold caps that decay slowly (the little floating ticks in the
// reference images). Colour ramps dim-yellow → orange → red by height only, so
// it never competes with the green trace superimposed on top.
const SPEC_BANDS = 48;
let specData = new Uint8Array(1024);   // sized properly once the analyser exists
let specPeaks = new Float32Array(SPEC_BANDS);   // 0..1 peak-hold per band
let specVals  = new Float32Array(SPEC_BANDS);   // 0..1 smoothed level per band
function sizeScope() {
  // The scope's display size is set purely in CSS, so this only matches the
  // canvas backing store to it.
  //
  // That size is no longer a pure function of the viewport: on desktop the
  // scope now fills the header's height and derives its width from that (see
  // #scope in index.html), so it also changes whenever the control column
  // reflows — a wrapped button row, a longer BBS name, a font that loads late.
  // A window-resize hook cannot see any of those, hence the ResizeObserver
  // below; this stays idempotent so both paths can call it freely.
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(scopeCanvas.clientWidth  * dpr);
  const h = Math.round(scopeCanvas.clientHeight * dpr);
  if (!w || !h) return;              // collapsed / display:none — nothing to size
  if (scopeCanvas.width === w && scopeCanvas.height === h) return;
  scopeCanvas.width = w; scopeCanvas.height = h;
}
// Track the canvas box itself rather than the window. Guarded because the
// harnesses run this file under environments without ResizeObserver.
if (typeof ResizeObserver === 'function') {
  new ResizeObserver(sizeScope).observe(scopeCanvas);
}
// Map a 0..1 band height to a dim-yellow → orange → red colour. Kept
// deliberately muted (never full-brightness) so it reads as a backdrop to the
// bright-green oscilloscope trace laid over it.
function specColor(t) {
  // t: 0 (low) .. 1 (high)
  // low  → dim yellow  (~rgb 150,130,20)
  // mid  → orange      (~rgb 190,90,15)
  // high → red         (~rgb 200,40,25)
  let r, g, b;
  if (t < 0.5) {
    const k = t / 0.5;                 // yellow → orange
    r = 150 + k * 40; g = 130 - k * 40; b = 20 - k * 5;
  } else {
    const k = (t - 0.5) / 0.5;         // orange → red
    r = 190 + k * 10; g = 90 - k * 50; b = 15 + k * 10;
  }
  return `rgb(${r|0},${g|0},${b|0})`;
}

// Frequency-domain bars. Log-spaced bands across the useful voiceband, each with
// a slow-decay peak-hold cap (the floating ticks in the reference images).
function drawSpectrum(w, h) {
  if (!monitor.ctx) return;
  const bins = SCOPE_FFT / 2;
  if (specData.length !== bins) specData = new Uint8Array(bins);
  monitor.readSpectrum(specData);

  const sr = SR;
  const nyq = sr / 2;
  // Concentrate the display on where modem energy lives: ~200 Hz .. ~3.6 kHz,
  // log-spaced so low tones don't dominate the width.
  const fLo = 200, fHi = 3600;
  const binOf = (f) => Math.min(bins - 1, Math.max(0, Math.round(f / nyq * bins)));

  const gap = Math.max(1, Math.round(w / SPEC_BANDS * 0.18));
  const bw  = w / SPEC_BANDS;

  for (let b = 0; b < SPEC_BANDS; b++) {
    // log-spaced band edges
    const f0 = fLo * Math.pow(fHi / fLo, b / SPEC_BANDS);
    const f1 = fLo * Math.pow(fHi / fLo, (b + 1) / SPEC_BANDS);
    let i0 = binOf(f0), i1 = Math.max(binOf(f1), i0 + 1);
    let m = 0;
    for (let i = i0; i < i1; i++) if (specData[i] > m) m = specData[i];
    let level = m / 255;                       // 0..1

    // attack fast, release slow — reads like a real bar meter
    if (level > specVals[b]) specVals[b] = level;
    else specVals[b] = specVals[b] * 0.80 + level * 0.20;

    // peak-hold cap with slow gravity
    if (specVals[b] >= specPeaks[b]) specPeaks[b] = specVals[b];
    else specPeaks[b] = Math.max(specVals[b], specPeaks[b] - 0.012);

    const v = specVals[b];
    const x = Math.round(b * bw);
    const barW = Math.max(1, Math.round(bw - gap));
    const barH = Math.round(v * (h - 2));
    const y = h - barH;

    if (barH > 0) {
      // vertical dim→hot gradient within the bar, keyed to absolute height
      const grad = scopeCtx.createLinearGradient(0, h, 0, y);
      grad.addColorStop(0, specColor(0));
      grad.addColorStop(1, specColor(v));
      scopeCtx.fillStyle = grad;
      scopeCtx.fillRect(x, y, barW, barH);
    }

    // peak-hold tick
    const pk = specPeaks[b];
    if (pk > 0.02) {
      const py = h - Math.round(pk * (h - 2));
      scopeCtx.fillStyle = specColor(pk);
      scopeCtx.fillRect(x, Math.max(0, py - 1), barW, 2);
    }
  }
}

/* ═══════════════════════════════════════════════════════════════
   Network throughput graph — the scope box in modem-bypass mode
   ═══════════════════════════════════════════════════════════════
   With no carrier there is no waveform and no spectrum to draw, so the box is
   repurposed as a scrolling bits-per-second history. It deliberately borrows the
   spectrum's visual language — the same dim-yellow → orange → red ramp keyed to
   absolute height, the same bar width and gap — but each bar is drawn as stacked
   discrete segments rather than a smooth fill, so it reads as a retro LED bar
   meter rather than a modern area chart. The bps readout is the same one the
   modem modes show, in the same corner. */
const TP_COLS = 56;                  // ≈14 s of history at the 250 ms sample tick
const tpHist = new Float32Array(TP_COLS);   // bits/sec, oldest → newest
let tpScale = 1200;                  // auto-ranging full-scale, bps

function tpPush(bps) {
  tpHist.copyWithin(0, 1);
  tpHist[TP_COLS - 1] = Math.max(0, bps);
}
function tpReset() { tpHist.fill(0); tpScale = 1200; }

// Compact bps for the scale label: 480, 9.6k, 240k, 1.5M.
function fmtBps(v) {
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(v >= 1e4 ? 0 : 1) + 'k';
  return String(Math.round(v));
}

function drawThroughput(w, h) {
  const dpr = window.devicePixelRatio || 1;

  // Auto-range so the graph stays vertically filled whatever the link is doing:
  // jump instantly to a new peak (never clip), then ease back down when traffic
  // quietens so a burst doesn't flatten the next minute of the display.
  let winMax = 0;
  for (let i = 0; i < TP_COLS; i++) if (tpHist[i] > winMax) winMax = tpHist[i];
  if (winMax > tpScale) tpScale = winMax;
  else tpScale = Math.max(300, tpScale * 0.94 + winMax * 0.06);

  // Blocky geometry: fixed-height segments with a gap, like an LED bar meter.
  const seg    = Math.max(2, Math.round(3 * dpr));
  const segGap = Math.max(1, Math.round(dpr));
  const cell   = seg + segGap;
  const usable = h - 2;
  const rows   = Math.max(1, Math.floor(usable / cell));
  const bw     = w / TP_COLS;
  const gap    = Math.max(1, Math.round(bw * 0.18));

  // Faint graticule at the quarter marks — a scale reference, not decoration.
  scopeCtx.fillStyle = 'rgba(51,255,102,0.10)';
  for (let g = 1; g <= 4; g++) scopeCtx.fillRect(0, Math.round(h - usable * g / 4), w, 1);

  for (let i = 0; i < TP_COLS; i++) {
    const v = Math.min(1, tpHist[i] / tpScale);
    const n = Math.round(v * rows);
    if (n <= 0) continue;
    const x = Math.round(i * bw);
    const barW = Math.max(1, Math.round(bw - gap));
    for (let k = 0; k < n; k++) {
      // Colour by absolute height, exactly as the spectrum bars do, so a tall
      // bar is red at the top regardless of how tall its neighbours are.
      scopeCtx.fillStyle = specColor(rows > 1 ? k / (rows - 1) : 1);
      scopeCtx.fillRect(x, h - 1 - (k + 1) * cell + segGap, barW, seg);
    }
  }

  // Current full-scale, dim, top-left — without it the auto-ranging would make
  // a quiet link and a busy one look identical.
  scopeCtx.font = `${Math.round(9 * dpr)}px ${UI_MONO}`;
  scopeCtx.textAlign = 'left'; scopeCtx.textBaseline = 'top';
  scopeCtx.fillStyle = 'rgba(190,140,40,0.85)';
  scopeCtx.fillText(`▲ ${fmtBps(tpScale)}bps`, Math.round(5 * dpr), Math.round(4 * dpr));
}

// Live throughput readout — small, bright white, bottom-right justified.
// Identical in both link modes; shown only once the link is up.
function drawBpsReadout(w, h) {
  const dpr = window.devicePixelRatio || 1;
  scopeCtx.font = `${Math.round(11 * dpr)}px ${UI_MONO}`;
  scopeCtx.textAlign = 'right'; scopeCtx.textBaseline = 'bottom';
  scopeCtx.shadowColor = '#000'; scopeCtx.shadowBlur = Math.round(2 * dpr);
  scopeCtx.fillStyle = '#ffffff';
  scopeCtx.fillText(`${Math.max(0, Math.round(flowBps))} bps`,
    w - Math.round(6 * dpr), h - Math.round(4 * dpr));
  scopeCtx.shadowBlur = 0;
}

function drawScope() {
  requestAnimationFrame(drawScope);
  // Hidden by a collapse, the canvas is display:none but keeps its backing
  // store, so the dimension check below would not catch it — bail rather than
  // spend a frame drawing into something nobody can see. The test is the
  // rendered truth (offsetParent) rather than the `scopeCollapsed` flag,
  // because the collapse is a mobile-only CSS rule while the flag is stored
  // per browser: a desktop window carrying a stored collapse still SHOWS the
  // scope, and must therefore still draw it.
  if (scopeCanvas.offsetParent === null) return;
  const w = scopeCanvas.width, h = scopeCanvas.height;
  if (!w || !h) return;
  scopeCtx.clearRect(0, 0, w, h);

  // Modem bypassed: no carrier, so no trace and no spectrum — the box shows
  // network throughput instead. Held for the whole call so it doesn't flicker
  // back to an empty scope between the dial and the link coming up.
  if (linkMode === 'direct' && dialing) {
    drawThroughput(w, h);
    if (carrier) drawBpsReadout(w, h);
    return;
  }

  // ── Spectrum analyser (drawn FIRST, so the green scope trace sits on top) ──
  drawSpectrum(w, h);

  // faint center line
  scopeCtx.strokeStyle = 'rgba(51,255,102,0.15)';
  scopeCtx.lineWidth = 1;
  scopeCtx.beginPath(); scopeCtx.moveTo(0, h / 2); scopeCtx.lineTo(w, h / 2); scopeCtx.stroke();

  if (!monitor.ctx) return;
  monitor.readTimeDomain(scopeData);

  // Show ~5 ms so individual carrier cycles read as clean sine waves.
  const show = Math.min(scopeData.length, Math.round(SR * 0.005));
  let peak = 0;
  for (let i = 0; i < show; i++) { const a = Math.abs(scopeData[i]); if (a > peak) peak = a; }
  // Smooth the auto-scale so the trace fills vertically without jitter.
  scopeSmoothPeak = Math.max(0.03, scopeSmoothPeak * 0.9 + peak * 0.1);
  const vgain = (h * 0.45) / scopeSmoothPeak;

  scopeCtx.strokeStyle = '#33ff66';
  scopeCtx.lineWidth = Math.max(1, (window.devicePixelRatio || 1) * 1.4);
  scopeCtx.shadowColor = '#33ff66';
  scopeCtx.shadowBlur = (window.devicePixelRatio || 1) * 4;
  scopeCtx.beginPath();
  for (let i = 0; i < show; i++) {
    const x = (i / (show - 1)) * w;
    let y = h / 2 - scopeData[i] * vgain;
    if (y < 1) y = 1; else if (y > h - 1) y = h - 1;
    if (i === 0) scopeCtx.moveTo(x, y); else scopeCtx.lineTo(x, y);
  }
  scopeCtx.stroke();
  scopeCtx.shadowBlur = 0;

  // Superimposed on the trace, once a carrier is up.
  if (carrier) drawBpsReadout(w, h);
}
sizeScope();
requestAnimationFrame(drawScope);

// ─── Collapsing the scope (mobile) ───────────────────────────────────────────
// On a phone the scope owns a full-width row of the header, which is real
// estate the terminal would rather have. A long press folds it away to a thin
// strip that still reports carrier — green up, grey down — deliberately shaped
// like the page-grab bar under the terminal, since it is the same kind of
// object. A tap on the strip brings the scope back: the strip has no other
// purpose, so requiring a second long press would only be symmetry for its own
// sake, and it is a small target to hold steady.
//
// Touch only, and only below the mobile breakpoint. On desktop the header has
// height the terminal does not want (that is the point of the sizing rework
// above), so there is nothing to reclaim, and a mouse has no long press.
//
// The state is persisted and applied at startup, but is NOT re-applied on a
// breakpoint crossing — the CSS simply stops hiding the scope above 640px, so
// a rotated phone or a resized window shows the scope again and remembers the
// collapse for when it goes back to narrow.
const SCOPE_HOLD_MS = 500;
let scopeCollapsed = prefs.get('scopeCollapsed') === true;
function applyScopeCollapsed() {
  document.body.classList.toggle('scope-collapsed', scopeCollapsed);
  // Coming back from collapsed, the canvas has just regained a box; the
  // observer will fire, but sizing here too keeps the first drawn frame right.
  if (!scopeCollapsed) sizeScope();
}
// Mirrors the LED's carrier state onto the strip. Called from setLed() so the
// two can never disagree.
function updateScopeCollapsedState(cls) {
  scopeCollapsedEl.classList.toggle('up', cls === 'up');
}
function setScopeCollapsed(v) {
  if (scopeCollapsed === v) return;
  scopeCollapsed = v;
  prefs.set('scopeCollapsed', scopeCollapsed);
  applyScopeCollapsed();
  showToast(scopeCollapsed ? 'Oscilloscope hidden — tap the line to show'
                           : 'Oscilloscope shown');
}
{
  let holdTimer = null, hx = 0, hy = 0;
  const HOLD_SLOP = 10;      // px of movement that says this was a scroll
  const cancel = () => { if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; } };
  scopeCanvas.addEventListener('touchstart', (e) => {
    if (!isMobile() || e.touches.length !== 1) return;
    const t = e.touches[0]; hx = t.clientX; hy = t.clientY;
    holdTimer = setTimeout(() => { holdTimer = null; setScopeCollapsed(true); }, SCOPE_HOLD_MS);
  }, { passive: true });
  scopeCanvas.addEventListener('touchmove', (e) => {
    const t = e.touches[0];
    if (!t || Math.hypot(t.clientX - hx, t.clientY - hy) > HOLD_SLOP) cancel();
  }, { passive: true });
  scopeCanvas.addEventListener('touchend', cancel);
  scopeCanvas.addEventListener('touchcancel', cancel);
  // Restore. `click` rather than a touch handler so the strip also works with a
  // mouse in a narrow desktop window, where the mobile layout is in force.
  scopeCollapsedEl.addEventListener('click', () => setScopeCollapsed(false));
}
applyScopeCollapsed();

// Live "flowing bps": sample payload bytes (both directions) over a short
// window, ×8 for bits, lightly smoothed so the on-scope readout is legible.
let _flowLastBytes = 0, _flowLastT = performance.now();
setInterval(() => {
  const now = performance.now(), dt = (now - _flowLastT) / 1000;
  const tot = rxBytes + txBytes;
  const inst = dt > 0 ? (tot - _flowLastBytes) * 8 / dt : 0;
  _flowLastBytes = tot; _flowLastT = now;
  flowBps = flowBps * 0.6 + inst * 0.4;
  // The throughput graph plots the *unsmoothed* rate: the smoothing that keeps
  // the numeric readout legible would flatten exactly the bursts worth seeing.
  tpPush(dialing ? inst : 0);
}, 250);

// ─── AT command emulation (cosmetic terminal echoes) ─────────────────────────
// Echo authentic Hayes/AT strings to the terminal to mirror a real modem
// session. `termEcho` renders locally through the same ANSI parser the BBS feeds.
function termEcho(str) {
  parser.feed(Uint8Array.from(str, (c) => c.charCodeAt(0) & 0xff));
  term.scanURLs();
  dirty = true;
  updateScrollRail();      // local echo lengthens the ring too
}

// Modem init string, echoed once on startup. M1 speaker-on-until-carrier,
// Q0 show result codes, E1 command echo, X4 full result codes + dial-tone/busy
// detection, &C1 DCD follows carrier.
const MODEM_INIT = 'AT M1 Q0 E1 X4 &C1';

// Per-protocol modulation-select command, keyed by the exact <select> option
// value (an option may carry a sub-rate as "<proto>@<rate>"; none does today).
// Uses the standard Conexant/Rockwell +MS=<carrier>,<automode>,<minRate>,
// <maxRate> syntax with automode 0 to force the single modulation. To
// add/adjust a protocol, edit or add one line here — nothing else in this file
// needs to change.
//   This table must name only options the menu offers: a resolved command sets
//   the <select>, and a key with no <option> would leave the control blank. So a
//   protocol dropped from the menu is dropped here too, which is why there is no
//   V.29 row and no V.34 sub-rate rows — the protocol code for both is intact.
const MS_COMMANDS = {
  'Bell103':    'AT+MS=B103,0,300,300',
  'V21':        'AT+MS=V21,0,300,300',
  'V22':        'AT+MS=V22,0,1200,1200',
  'V22bis':     'AT+MS=V22B,0,2400,2400',
  'V23':        'AT+MS=V23,0,1200,1200',
  'V32':        'AT+MS=V32,0,9600,9600',
  'V32bis':     'AT+MS=V32B,0,14400,14400',
  'V34':        'AT+MS=V34,0,33600,33600',
  // V.90 is asymmetric: the AT+MS rate pair is upstream,downstream.
  'V90':        'AT+MS=V90,0,33600,56000',
  // 'direct' deliberately has no entry: +MS selects a *modulation*, and
  // modem-bypass mode has none. Inventing a token would be the one fake string
  // in a table of real ones, so it gets a plain-language line instead.
};
const DIRECT_ECHO = '[Telnet - Modem Bypassed]';
// Modem-bypass has no +MS token, but it does have a command the user can type:
// ATZ. Echoing it before the plain-language line keeps the GUI path and the
// typed path showing the same two lines, so the terminal reads as one session
// whichever way the mode was chosen. (Typed ATZ adds an OK — see runATCommand.)
const DIRECT_COMMAND = 'ATZ';
function echoMSCommand(sel) {
  if (sel === 'direct') return termEcho(`\r\n${DIRECT_COMMAND}\r\n${DIRECT_ECHO}\r\n`);
  const cmd = MS_COMMANDS[sel];
  if (cmd) termEcho(`\r\n${cmd}\r\nOK\r\n`);
}

// ─── AT command parsing (pure) ───────────────────────────────────────────────
// Offline, the terminal is a modem command line. What it accepts is deliberately
// narrow — this is period *show*, not an emulator — and everything outside that
// set gets the same answer a real modem gives: ERROR.
//
// Four shapes are recognised, and nothing else:
//
//   1. `AT` plus any run of the cosmetic no-op tokens below, spaced or not
//      (`AT`, `ATM1`, `AT M1 Q0`, `ATM1Q0E1X4&C1`) → OK, nothing changes.
//      Only these exact tokens: no other value of any of them (`M0`, `X3`) and
//      no other register. They are decoration, so a table of five is honest and
//      a parser that pretended to accept variants would not be.
//   2. `AT+MS=<fields>` → selects the modulation, if the fields are a
//      comma-boundary PREFIX of one of MS_COMMANDS' canonical strings. So
//      `AT+MS=V34`, `AT+MS=V34,0`, `AT+MS=V34,0,33600` and the full
//      `AT+MS=V34,0,33600,33600` all mean the same thing; `AT+MS=V32,1` and
//      `AT+MS=V32,0,4800` mean nothing and are an ERROR rather than a
//      quietly-approximated something. A prefix matching several menu entries
//      (bare `AT+MS=V34`) resolves to the fastest, exactly as a bare `v34` does
//      in a shared link.
//   3. `ATZ` → the modem-bypass entry (Telnet · max speed).
//   4. `ATDT <host>[:<port>]` → set the destination and dial it. Port defaults
//      to 23. The host is validated with the same rule the share link uses: a
//      bare hostname or IP literal, never a URL.
//
// Pure string work over an MS table passed in, so tools/tests/attest.js can drive it.
const AT_NOOP_TOKENS = ['&C1', 'M1', 'Q0', 'E1', 'X4'];

/**
 * Resolve the argument list of an `AT+MS=` command to a <select> option value.
 * @param {string} fields   everything after the '=', e.g. "V34,0,33600"
 * @param {Object<string,string>} msCommands  option value ⇒ canonical AT string
 * @returns {string} the option value, or '' if the fields name nothing
 */
function speedFromMSFields(fields, msCommands) {
  const given = String(fields == null ? '' : fields).trim().toUpperCase().split(',')
    .map((f) => f.trim());
  // A trailing or doubled comma is not a shorter command, it is a malformed one.
  if (given.some((f) => f === '')) return '';
  const hits = Object.keys(msCommands).filter((opt) => {
    const canon = String(msCommands[opt]).toUpperCase().replace(/^AT\+MS=/, '').split(',');
    return given.length <= canon.length && given.every((f, i) => f === canon[i]);
  });
  // Several hits means a bare (or half-given) family name: take the fastest.
  // MS_COMMANDS is written in menu order, so that is the last one.
  return hits.length ? hits[hits.length - 1] : '';
}

/**
 * Parse one typed command line.
 * @param {string} line  the line as typed, without its terminating CR
 * @param {Object<string,string>} msCommands  the MS_COMMANDS table
 * @returns {{k:string, speed?:string, host?:string, port?:string}}
 *   k is 'none' (blank line — a real modem says nothing), 'ok' (a no-op),
 *   'speed', 'direct', 'dial', or 'error'.
 */
function parseATCommand(line, msCommands) {
  const raw = String(line == null ? '' : line).trim();
  if (!raw) return { k: 'none' };
  if (!/^at/i.test(raw)) return { k: 'error' };
  const body = raw.slice(2);

  // ATZ — modem bypass.
  if (/^\s*z\s*$/i.test(body)) return { k: 'direct' };

  // ATDT <host>[:<port>]. A trailing ';' (return to command mode after dialling)
  // is the one dial modifier worth swallowing rather than erroring on.
  const dial = body.match(/^\s*d\s*t\s*(.+)$/i);
  if (dial) {
    const dest = dial[1].trim().replace(/;$/, '').trim();
    // `ATDT RANDOM` is the typed form of the directory's Random entry: it draws
    // a board and dials it. It shadows a host literally called "random", which
    // is not a real destination anyone can reach — a bare label with no dot is
    // not a routable name on the public internet — so nothing is lost. The
    // parser stays pure: it only reports that a draw was asked for, and the
    // caller (which owns the directory) makes it.
    if (/^random$/i.test(dest)) return { k: 'dial', random: true };
    const m = dest.match(/^([A-Za-z0-9._-]+)(?::(\d{1,5}))?$/);
    if (!m || m[1].length > 253) return { k: 'error' };
    if (m[2] === undefined) return { k: 'dial', host: m[1], port: '23' };
    const n = parseInt(m[2], 10);
    if (!(n >= 1 && n <= 65535) || String(n) !== m[2]) return { k: 'error' };
    return { k: 'dial', host: m[1], port: String(n) };
  }

  // AT+MS=...
  const ms = body.match(/^\s*\+\s*ms\s*=\s*(.*)$/i);
  if (ms) {
    const speed = speedFromMSFields(ms[1], msCommands);
    return speed ? { k: 'speed', speed } : { k: 'error' };
  }

  // AT + cosmetic no-ops only. Spaces anywhere, any casing, any order.
  let rest = body.replace(/\s+/g, '').toUpperCase();
  while (rest) {
    const tok = AT_NOOP_TOKENS.find((t) => rest.startsWith(t));
    if (!tok) return { k: 'error' };
    rest = rest.slice(tok.length);
  }
  return { k: 'ok' };
}

// ─── Call-progress audio (dial tone, DTMF, ringback, answer click) ───────────
// Every tone is mixed onto the same bus as the modem carrier, so it shows on
// the oscilloscope + spectrum and is gated by the Auto/Listen/Mute speaker
// control. US-standard frequencies throughout.
const DTMF = {
  '1': [697, 1209], '2': [697, 1336], '3': [697, 1477],
  '4': [770, 1209], '5': [770, 1336], '6': [770, 1477],
  '7': [852, 1209], '8': [852, 1336], '9': [852, 1477],
  '*': [941, 1209], '0': [941, 1336], '#': [941, 1477],
};
// Tones are RENDERED to PCM rather than built from OscillatorNodes, so the call
// progress audio is samples like everything else and monitor.playClip() can be
// the one way anything reaches both the speaker and the oscilloscope. An
// oscillator exists only inside a running AudioContext and can therefore be
// heard but never seen; a rendered buffer is available to the scope whether the
// context is running or not. The sequence is still handed to the graph in ONE
// pre-scheduled buffer, so "stop dialling" still cannot mean "stop scheduling"
// and nothing about the audible timing changes.
const tones = {
  // Write a two-frequency tone into `out` at `off` samples, for `dur` seconds.
  // Short attack/release envelope avoids clicks. Returns the sample index after
  // the tone. Envelope shape mirrors the gain ramps this replaced.
  renderDual(out, off, f1, f2, dur, level = 0.22) {
    const n = Math.round(dur * SR), a = Math.round(0.006 * SR), r = Math.round(0.010 * SR);
    const w1 = 2 * Math.PI * f1 / SR, w2 = f2 ? 2 * Math.PI * f2 / SR : 0;
    for (let i = 0; i < n && off + i < out.length; i++) {
      let env = 1;
      if (i < a) env = i / a;
      else if (i > n - r) env = Math.max(0, (n - i) / r);
      let v = Math.sin(w1 * i);
      if (f2) v += Math.sin(w2 * i);
      // Two oscillators summed into one gain of `level` is what this replaced,
      // so two sines at unity times `level` is the same loudness, not half it.
      out[off + i] += v * level * env;
    }
    return off + n;
  },
  secs(s) { return Math.round(s * SR); },
};

// ─── Dial tone while the destination is being resolved ───────────────────────
//
// The name is resolved by the server, and until that answers there is nothing to
// DTMF — no IP, no digits. That used to mean SILENCE: the user pressed Connect
// and heard nothing at all until the answer came back, and on a name that does
// not resolve, nothing until the reorder tone. A phone does not behave that way.
// You lift the handset and the exchange gives you dial tone immediately; it is
// what tells you the line is alive while you have not dialled yet.
//
// So the tone now starts when the call does, and the digits follow when there is
// something to dial. On the ordinary fast lookup this sounds exactly as it
// always did — the tone is simply held for the same second the sequence used to
// begin with (DIALTONE_MIN_MS), then cut for the DTMF. On a slow lookup it keeps
// going for as long as the wait lasts, which is the feedback that was missing.
//
// One clip, not a chained loop: the ring is BUS_LEN (8 s) and a clip longer than
// that would wrap and overwrite itself in _mix. Six seconds covers any lookup
// worth waiting for, and past that the tone ends on its own release rather than
// being cut — a lookup still running at six seconds is about to fail anyway.
const DIALTONE_S = 6.0;          // the longest wait this covers, under BUS_LEN
const DIALTONE_MIN_MS = 1000;    // the beat the sequence always opened with
const DIALTONE_BUSY_GAP_MS = 250;// silence between a cut dial tone and reorder

let dialToneClip = null;
let dialToneAt = 0;
let resolveDeadline = null;

// The browser's own deadline on the lookup, and it is a BACKSTOP rather than the
// mechanism: config/site.json's resolveTimeoutMs is what actually bounds it, and
// is meant to be well under this. This exists so that the caller can never be
// left listening to nothing whatever the server does — if no answer has arrived
// while there is still dial tone to cover it, the call is over as far as this
// page is concerned. Deliberately shorter than DIALTONE_S: the tone must still
// be playing when this fires, or the silence it exists to prevent has already
// happened.
const RESOLVE_DEADLINE_MS = 5500;

function startDialTone() {
  monitor.ensure();
  const pcm = new Float32Array(tones.secs(DIALTONE_S) + 1);
  const n = tones.renderDual(pcm, 0, 350, 440, DIALTONE_S, 0.20);   // US dial tone
  dialToneAt = performance.now();
  dialToneClip = monitor.playClip(pcm.subarray(0, n), 0, 'progress');
}

// Cut it. Abrupt on purpose: a real dial tone stops the instant the first digit
// goes out, and what follows here — DTMF, or a pause and then reorder — is the
// same thing the exchange would have done.
function stopDialTone() {
  if (dialToneClip) monitor.dropClip(dialToneClip);
  dialToneClip = null;
  if (resolveDeadline) { clearTimeout(resolveDeadline); resolveDeadline = null; }
}

/**
 * Run `fn` once the dial tone has had its minimum beat.
 *
 * A lookup that answers in 20 ms would otherwise clip the tone to a blip, which
 * reads as a fault rather than as a dial tone. Waiting out the remainder makes
 * the common case sound exactly like the fixed one-second lead the sequence used
 * to carry, and costs nothing on a slow lookup, where the time is long past.
 */
function afterDialTone(gen, fn) {
  const held = dialToneClip ? performance.now() - dialToneAt : DIALTONE_MIN_MS;
  const wait = Math.max(0, DIALTONE_MIN_MS - held);
  if (!wait) return fn();
  setTimeout(() => { if (callLive(gen)) fn(); }, wait);
}

// Play the full US dial sequence for the resolved IP, then resolve the returned
// promise so the caller can start the modem handshake. Sequence: dial tone (now
// played by the caller while the name was being resolved, hence `leadSecs`) →
// DTMF for each IP digit (fast) → ~500ms pause → ~1s single ringback → ~250ms
// pause → answer click → ~250ms pause. All audio-clock scheduled.
function playDialSequence(ip, leadSecs = 1.0) {
  monitor.ensure();
  const digits = String(ip).replace(/\D/g, '');
  // Length first, so the whole sequence is one buffer. Same numbers as before.
  const total = tones.secs(leadSecs + 0.15 + digits.length * (0.075 + 0.055) + 0.5 + 1.0 + 0.4) + SR;
  const pcm = new Float32Array(total);
  let i = leadSecs > 0 ? tones.renderDual(pcm, 0, 350, 440, leadSecs, 0.20) : 0;
  i += tones.secs(0.15);
  for (const ch of digits) {                               // DTMF each digit of the IP
    const pair = DTMF[ch];
    if (pair) { i = tones.renderDual(pcm, i, pair[0], pair[1], 0.075, 0.26); i += tones.secs(0.055); }
  }
  i += tones.secs(0.5);                                    // pause before ringing
  i = tones.renderDual(pcm, i, 440, 480, 1.0, 0.20);       // US ringback (single, short)
  i += tones.secs(0.4);                                    // pause, then the far end answers
  monitor.playClip(pcm.subarray(0, i));
  // The bus applies its own lead; the caller only has to outlast the sequence.
  return new Promise((res) => setTimeout(res, (i / SR + BUS_WRITE_LEAD / SR) * 1000));
}

// Reorder — "fast busy" — 480+620 Hz, 0.25 s on, 0.25 s off.
//
// This is the ONE answer to a call that did not go through, whatever the reason:
// the board refused, timed out, could not be resolved, was not in the directory
// when bypass required it, or was already carrying as many callers from here as
// this server will hold. The server does not say which, deliberately — a
// different message per cause is a scanning oracle, and the operator's log still
// records the real one.
//
// Reorder rather than true busy (0.5 s cadence): busy means "that line is
// engaged", reorder meant "the network could not complete your call", and it is
// the one people recognise as something-went-wrong.
//
// Hearing it after CONNECT is slightly unrealistic, because the modem has
// already answered by the time the proxy tries the board — the BBS is not
// dialled until carrier is up, so that a board's own "press a key" timeout does
// not run through the whole handshake. Switchboards did exactly this, and it is
// a better trade than dialling the board early.
//
// Its own clip kind, not 'progress': a hang-up silences the dial sequence, and
// this tone has to outlive the hang-up that follows it.
const REORDER_CYCLES = 4;                       // 4 × (0.25 on + 0.25 off) = 2 s
function playReorder() {
  monitor.ensure();
  const total = tones.secs(REORDER_CYCLES * 0.5) + SR;
  const pcm = new Float32Array(total);
  let i = 0;
  for (let c = 0; c < REORDER_CYCLES; c++) {
    i = tones.renderDual(pcm, i, 480, 620, 0.25, 0.20);
    i += tones.secs(0.25);
  }
  monitor.playClip(pcm.subarray(0, i), 0, 'reorder');
  return (i / SR + BUS_WRITE_LEAD / SR) * 1000;
}

// ─── Extension pickup ────────────────────────────────────────────────────────
// Simulates someone lifting an extension phone on the same line mid-call: a
// pre-baked voiceband clip (8 kHz mono, public/extension.pcm) is mixed onto the
// PCM in BOTH directions, exactly as room audio would couple onto the shared
// pair. Because it's added to the samples each demodulator sees, the carrier
// disruption, scope/spectrum reaction, speaker noise, and any resulting carrier
// loss all emerge naturally from the DSP — nothing special-cased — so this keeps
// behaving realistically as the protocols improve. Offset is derived from the
// wall clock so both directions sample the same instant of the clip.
const extension = {
  buf: null, loading: null,
  active: false,   // disruption in progress: mix into the DSP sample streams
  _endTimer: null, // the clip's own length is what ends it
  _clip: null,     // the bus clip (survives carrier loss)
  startT: 0,
  load() {
    if (this.buf) return Promise.resolve(this.buf);
    if (!this.loading) {
      this.loading = fetch('/extension.pcm').then((r) => r.arrayBuffer()).then((ab) => {
        const dv = new DataView(ab), n = ab.byteLength >> 1, o = new Float32Array(n);
        for (let i = 0; i < n; i++) o[i] = dv.getInt16(i * 2, true) / 32768;
        this.buf = o; return o;
      }).catch(() => null);
    }
    return this.loading;
  },
  trigger() {
    if (this.active || this._clip) return;
    this.load().then((b) => {
      if (!b) return;
      this.active = true; this.startT = performance.now();
      extBtn.classList.add('on');
      // Make sure the clip is heard unless the user has explicitly Muted: cancel
      // any post-connect Auto fade and turn Auto's speaker back on for the clip.
      if (monitor.mode !== 'mute') {
        monitor.cancelAutoFade();
        if (monitor.mode === 'auto') monitor.autoOn = true;
        monitor._applyGain(); updateListenUI();
      }
      this._play(b);
    });
  },
  // Mixed onto the bus as its own clip, so it is audible + on the scope on its
  // own and survives a carrier drop (and never double-counts, since the modem's
  // own audio feeds the bus clean). Its length is what ends it: a clip is
  // samples, not a node, so there is nothing to wait for an `ended` event from
  // and nothing that stops arriving when the context cannot run.
  _play(b) {
    monitor.ensure();
    const clip = monitor.playClip(b, 0, 'handset');
    this._clip = clip;
    this._endTimer = setTimeout(() => {
      if (this._clip === clip) { this._clip = null; monitor.dropClip(clip); this._finish(); }
    }, ((b.length + BUS_WRITE_LEAD) / SR) * 1000);
  },
  // End of clip: drop the disruption and, in Auto, return to the faded/off state.
  _finish() {
    if (this._endTimer) { clearTimeout(this._endTimer); this._endTimer = null; }
    this._clip = null;
    this.active = false;
    extBtn.classList.remove('on');
    if (monitor.mode === 'auto') { monitor.autoOn = false; monitor._applyGain(); updateListenUI(); }
  },
  // Carrier lost: stop disrupting the (now-gone) DSP streams, but let the audible
  // clip keep playing to the end via its own graph node.
  stop() { this.active = false; },
  playing() { return !!this._clip; },
  // Add the time-aligned slice of the clip into f32 (in place), for the DSP
  // demodulators only. Same wall-clock offset for TX and RX → both see the same
  // interference on the shared line.
  mix(f32) {
    if (!this.active || !this.buf) return;
    const b = this.buf;
    let idx = Math.floor((performance.now() - this.startT) / 1000 * SR);
    if (idx >= b.length) { this.active = false; return; }
    for (let i = 0; i < f32.length; i++, idx++) {
      if (idx >= b.length) break;
      const v = f32[i] + b[idx];
      f32[i] = v > 1 ? 1 : v < -1 ? -1 : v;
    }
  },
};
extension.load();   // preload the clip so the first pickup is instant

// Connect/Hang up is a single toggle; label + highlight track the call state.
function setCallUI(active) {
  dialBtn.textContent = active ? 'Hang up' : 'Connect';
  dialBtn.classList.toggle('on', active);
  scheduleBarFit();   // "Hang up" is wider than "Connect" — the run may re-wrap
}

// ─── Modem link ─────────────────────────────────────────────────────────────
let ws = null, dsp = null, carrier = false;
// Negotiated line rate of the call in progress, 0 when there is none. Only the
// paste box reads it, to say how long what you are about to send will take.
let carrierBps = 0;
let dialing = false;          // true from Connect press until cleanup
let noCarrierEchoed = false;  // ensures a single NO CARRIER per call
// A call that never came up prints BUSY, not NO CARRIER — Hayes' own split, and
// the honest one: NO CARRIER is a link that failed or dropped, BUSY is a busy
// signal heard. Its own flag rather than reusing noCarrierEchoed, so cleanup()
// can suppress the other message without the name lying about why.
let busyEchoed = false;
// Speaker button reflects the tri-state mode; the glyph reflects live audibility
// (so Auto visibly goes quiet after the connect fade), while the small "A" badge
// marks Auto apart from a deliberate Mute. Label lives in the title/toast only.
const LISTEN_LABEL = { auto: 'Auto', listen: 'Listen', mute: 'Muted' };
function updateListenUI() {
  const on = monitor.audible();
  const spk = listenBtn.querySelector('.spk');
  listenBtn.classList.toggle('on', monitor.mode !== 'mute');
  spk.textContent = on ? '\u{1F50A}' : '\u{1F507}';
  if (monitor.mode === 'auto') {
    const b = document.createElement('span');
    b.className = 'badge'; b.textContent = 'A';
    spk.appendChild(b);
  }
  listenBtn.title = `Speaker: ${LISTEN_LABEL[monitor.mode]}`;
}

// The status line is one of the two rows fitBar() measures, and it is the one
// whose width changes most often, so every write re-balances the bar.
function setStatus(t) { statusEl.textContent = t; scheduleBarFit(); }

// ── the idle status line ────────────────────────────────────────────────────
// "ready — press Connect to dial (1482 dials from all users)". The total comes
// from /bbs.json, which resolves after this first runs, so readyStatus() is
// called again once it lands.
let totalDials = 0;
let _readyTimer = null;

function readyText() {
  const n = totalDials > 0 ? ` (${totalDials.toLocaleString()} dials total from all users)` : '';
  return `ready — press Connect to dial${n}`;
}

function readyStatus() {
  if (_readyTimer) { clearTimeout(_readyTimer); _readyTimer = null; }
  setStatus(readyText());
}

// A call ends with something worth reading — "closed (remote-closed)", "no
// answer (…)", "telnet proxy failed: …". Snapping straight back to ready would
// eat it, so the reason holds for a few seconds and then the line settles. Any
// new status (including the next dial) cancels the pending restore.
const READY_RESTORE_MS = 5000;
function scheduleReadyStatus() {
  if (_readyTimer) clearTimeout(_readyTimer);
  _readyTimer = setTimeout(() => { _readyTimer = null; setStatus(readyText()); }, READY_RESTORE_MS);
}
function cancelReadyStatus() {
  if (_readyTimer) { clearTimeout(_readyTimer); _readyTimer = null; }
}
// Single choke point for carrier state in the header — the collapsed scope
// strip rides along here so it can never drift out of step with the LED.
function setLed(cls) { led.className = cls || ''; updateScopeCollapsedState(cls); }

function floatToInt16(f32) {
  const b = new ArrayBuffer(f32.length * 2), dv = new DataView(b);
  for (let i = 0; i < f32.length; i++) {
    let s = Math.max(-1, Math.min(1, f32[i]));
    dv.setInt16(i * 2, (s * 32767) | 0, true);
  }
  return b;
}
function int16ToFloat(ab) {
  const dv = new DataView(ab), n = ab.byteLength >> 1, o = new Float32Array(n);
  for (let i = 0; i < n; i++) o[i] = dv.getInt16(i * 2, true) / 32768;
  return o;
}

// User → BBS. Both link modes go through here; only the transport differs, so
// the terminal, keyboard and AT layers never learn which one is live.
function modemWrite(strOrBytes) {
  // No carrier: the modem is in command mode, so keystrokes are a typed AT
  // line rather than payload. Both input paths (physical keys and the on-screen
  // keyboard) arrive here, so this one branch covers them. During a dial the
  // line is neither up nor idle — swallow keys as before.
  if (!carrier) { if (!dialing) atInput(strOrBytes); return; }
  const bytes = (typeof strOrBytes === 'string')
    ? Uint8Array.from(strOrBytes, (c) => c.charCodeAt(0) & 0xff)
    : strOrBytes;
  if (linkMode === 'direct') {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(bytes.buffer.byteLength === bytes.length ? bytes.buffer : bytes.slice().buffer);
  } else {
    if (!dsp) return;
    dsp.write(window.SynthModemDSP.Buffer.from(bytes));
  }
  txBytes += bytes.length;
}

// BBS → user. Shared by the DSP's demodulated output and direct mode's raw
// frames, so the render path is identical either way.
function feedTerminal(bytes) {
  rxBytes += bytes.length;
  parser.feed(bytes);
  term.scanURLs();
  dirty = true;
  updateScrollRail();      // new output lengthens the ring
}

// ─── AT command line (command mode) ──────────────────────────────────────────
// E1 is in the init string, so what you type is echoed as you type it. The line
// is edited locally and only acted on at CR — the terminal has no other input
// consumer while the modem is idle.
let atLine = '';
let atSawCR = false;    // so a CRLF pair is one line ending, not two

function atCommandMode() { return !carrier && !dialing; }

/**
 * Feed typed bytes to the command line. Returns true if anything was consumed,
 * which is what tells the key handler whether to preventDefault.
 */
function atInput(strOrBytes) {
  let s = (typeof strOrBytes === 'string')
    ? strOrBytes
    : Array.from(strOrBytes, (b) => String.fromCharCode(b)).join('');
  // Function/arrow keys arrive as escape sequences. There is nothing for them to
  // do on a command line, and letting ESC through would leave the rest of the
  // sequence ("OP") typed into it — so drop the whole thing.
  if (!s || s.charCodeAt(0) === 27) return false;
  let used = false;
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (c === 13 || c === 10) {
      if (c === 10 && atSawCR) { atSawCR = false; continue; }
      atSawCR = (c === 13);
      const line = atLine; atLine = '';
      termEcho('\r\n');
      runATCommand(line);
      used = true;
      continue;
    }
    atSawCR = false;
    if (c === 8 || c === 127) {
      if (atLine) { atLine = atLine.slice(0, -1); termEcho('\b \b'); }
      used = true;
    } else if (c >= 32 && c < 127) {
      // A command line no real modem would have accepted either — 40 characters
      // was a common buffer; 120 is generous and still bounded.
      if (atLine.length < 120) { atLine += ch; termEcho(ch); }
      used = true;
    }
  }
  return used;
}

// Point the canonical #host/#port at a typed destination and make the control
// show it. Same reasoning as the shared-link path: if the directory has the
// board, select it there; if it doesn't, the manual field is the only control
// that can display it. The destination is stored (the user chose it), the
// display mode is not.
function applyDialDest(host, port) {
  hostEl.value = host; portEl.value = port;
  saveDest();
  const inDirectory = [...bbsEl.options].some((o) => o.value === `${host}:${port}`);
  if (inDirectory) {
    if (manualMode) { manualMode = false; updateDestUI(); }
    syncBBSSelection();
  } else if (!manualMode) {
    manualMode = true; updateDestUI();
  }
  if (manualMode) hostportEl.value = `${host}:${port}`;
}

// Act on one parsed line. Every branch ends in a result code, because a command
// that answered nothing would look like the terminal had stopped responding.
function runATCommand(line) {
  const r = parseATCommand(line, MS_COMMANDS);
  switch (r.k) {
    case 'none':                       // bare CR: a real modem says nothing
      return;
    case 'ok':
      return termEcho('OK\r\n');
    case 'speed':
      protocolEl.value = r.speed;
      prefs.set('protocol', r.speed);
      return termEcho('OK\r\n');
    case 'direct':
      protocolEl.value = 'direct';
      prefs.set('protocol', 'direct');
      return termEcho(`${DIRECT_ECHO}\r\nOK\r\n`);
    case 'dial': {
      if (r.random) {
        // Nothing to draw from — the directory never loaded. ERROR is the
        // honest answer; inventing a destination would be worse.
        if (!drawRandomBBS()) return termEcho('ERROR\r\n');
        // connect() echoes its own `ATDT host:port`, which is the only place
        // the drawn board's address is named. That is why the echo is NOT
        // suppressed here as it is for a typed destination.
        return connect();
      }
      applyDialDest(r.host, r.port);
      // The typed line IS the ATDT echo, so suppress connect()'s own.
      return connect({ echoDial: false });
    }
    default:
      return termEcho('ERROR\r\n');
  }
}

// Bumped on every Connect AND every teardown, and captured by everything
// connect() schedules. Anything that comes back late — the dial-sequence
// promise, a socket handler, startModem — compares its captured value and does
// nothing if the call it belongs to is over. Without it a hang-up mid-dial
// leaves ~3 s of scheduled audio and a pending promise that still starts a
// modem, and a fast hang-up-and-redial has the OLD socket's onclose running
// cleanup() over the NEW call.
let callGen = 0;
const callLive = (gen) => gen === callGen;

function connect(opts) {
  // Whichever control is on screen is the one that says where this call goes, so
  // reconcile the canonical host/port to it before reading them. In manual mode
  // the field may not have blurred (its `change` never fired); in directory mode
  // the select may be displaying a board that nothing has told #host/#port
  // about, because re-picking the option it already sits on fires no event.
  if (manualMode) commitHostPort(); else commitBBSSelection();
  const host = hostEl.value.trim(), port = portEl.value.trim() || '23';
  if (!host) return;
  // Protocol dropdown values may carry a sub-rate as "V34@33600"; split it off.
  const sel = protocolEl.value || 'V21';
  const at = sel.indexOf('@');
  const modemProto = at >= 0 ? sel.slice(0, at) : sel;
  const v34Rate = at >= 0 ? parseInt(sel.slice(at + 1), 10) : undefined;
  linkMode = sel === 'direct' ? 'direct' : 'modem';
  if (linkMode === 'modem') {
    config.modem.native.protocolPreference = [modemProto];
    config.modem.native.v8ModulationModes  = [modemProto];
    if (modemProto === 'V34') config.modem.native.v34Rate = v34Rate || 33600;
    // V.90 is asymmetric and single-rate here: 56000 down (PCM codewords from
    // the server, which is the digital modem) and 33600 up (genuine V.34, which
    // this browser side transmits). The upstream rate is pinned by the protocol
    // class itself, so only the downstream rate is set here.
    if (modemProto === 'V90') config.modem.native.v90Rate = 56000;
  }

  // The speaker, for a connect=auto call and for the ordinary dial after one.
  // Before monitor.prime() below, so the muted call never opens its gain.
  if (autoMutePending) applyAutoMute(); else releaseAutoMute();

  // A board that names its own font gets it now, BEFORE the dial message is
  // built: applyFont() sets COLS, and windowSize() reads COLS. Anything later
  // would tell the BBS the wrong width — there is no side channel once a
  // carrier is up. A destination with no entry does nothing here at all.
  beginAltFont(host, port);

  const gen = ++callGen;           // this call's identity, captured by everything below
  dialing = true; noCarrierEchoed = false; busyEchoed = false;
  tpReset();
  monitor.reset();
  if (linkMode === 'modem') {
    monitor.prime();         // Connect is a user gesture — resume + warm the output device now
    if (monitor.mode === 'auto') { monitor.autoOn = true; monitor._applyGain(); }
  } else {
    // No carrier means nothing for the speaker to carry. Leave the control
    // enabled and Auto held open rather than fading it out — it still gates ANSI
    // music, which plays through its own context and works fine here. The box
    // should read as deliberately idle, not broken.
    if (monitor.mode === 'auto') monitor.autoOn = true;
  }
  updateListenUI();
  setCallUI(true); extBtn.disabled = true; protocolEl.disabled = true;
  // The heart appears as soon as dialling starts, not on carrier. The
  // destination is already fixed by this point (the controls are locked for the
  // duration of the call), so there is nothing ambiguous about what it would
  // favourite — and a board worth keeping is often one you decide about while
  // waiting for it to answer, or one that never answers at all.
  showFavButton(true);
  cancelReadyStatus();             // a new call outranks a pending idle restore
  setStatus('opening link…'); setLed('neg');

  // ATDT dial line to the terminal (the human-readable destination). Skipped
  // when the call came from a typed ATDT — the user's own line is already there.
  if (!opts || opts.echoDial !== false) termEcho(`\r\nATDT ${host}:${port}\r\n`);

  // Build + start the originate modem. Deferred until the dial audio has played
  // so the DTMF/ringback don't overlap the carrier handshake tones.
  // Modem bypassed: dial and wait for the server's `connected`. No DSP, no
  // handshake, no audio — the link is up as soon as the TCP socket is.
  function startDirect() {
    if (!callLive(gen) || !sock || sock.readyState !== WebSocket.OPEN) return;
    sock.send(JSON.stringify({ type: 'dial', host, port, link: 'direct', ...windowSize() }));
  }

  function startModem() {
    if (!callLive(gen) || !sock || sock.readyState !== WebSocket.OPEN) return;
    sock.send(JSON.stringify({ type: 'dial', host, port, protocol: modemProto,
                            v34Rate: config.modem.native.v34Rate, ...windowSize() }));
    dsp = new ModemDSP('originate');
    dsp.on('audioOut', (f32) => {
      // Inject extension audio into the outgoing stream (corrupts user→BBS at the
      // server's demod). Copy first so we never mutate the DSP's own buffer; the
      // monitor gets the clean carrier (the clip is heard via its own node).
      let out = f32;
      if (extension.active) { out = f32.slice(); extension.mix(out); }
      if (callLive(gen) && sock && sock.readyState === WebSocket.OPEN) sock.send(floatToInt16(out));
      monitor.feed('tx', f32);
    });
    dsp.on('connected', (info) => {
      carrier = true;
      carrierBps = info.bps || 0;
      console.log(`[modem] CARRIER UP ${info.protocol} @ ${info.bps} bps`);
      setStatus(`carrier ${info.protocol} @ ${info.bps} bps — connected`);
      setLed('up'); canvas.focus();
      extBtn.disabled = false;     // extension pickup only makes sense on a live call
      termEcho(`\r\nCONNECT ${info.bps}\r\n`);
      // Auto: hold full volume through the handshake, then fade to silence over
      // 10 s like a modem speaker cutting out once the carrier is established.
      if (monitor.mode === 'auto') {
        monitor.autoOn = true; monitor._applyGain(); updateListenUI();
        monitor.startAutoFade(10, () => { monitor.autoOn = false; updateListenUI(); });
      }
    });
    dsp.on('data', (buf) => feedTerminal(new Uint8Array(buf)));
    dsp.on('silenceHangup', () => setStatus('carrier lost'));
    dsp.start();
  }

  // Direct mode's equivalent of the DSP's `connected` event.
  function directLinkUp() {
    carrier = true;
    carrierBps = 0;              // no carrier, so no rate to pace anything by
    console.log('[link] DIRECT — modem bypassed');
    setStatus('telnet direct — connected (modem bypassed)');
    setLed('up'); canvas.focus();
    termEcho('\r\nCONNECT\r\n');    // no speed to report; there is no carrier
  }

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  // Held locally as well as module-wide: a stale handler that tested the call
  // generation and then closed the module-level `ws` would close the CURRENT
  // call's socket, because onclose fires asynchronously.
  // Dial tone from the moment the handset is lifted, not from the moment the
  // answer comes back. This covers the WebSocket opening as well as the lookup —
  // both were silent before. Bypass places no call and so gets no tone, the same
  // reason it has no DTMF and no ringback.
  dialToneClip = null;
  if (linkMode === 'modem') startDialTone();

  const sock = new WebSocket(`${proto}://${location.host}`);
  ws = sock;
  sock.binaryType = 'arraybuffer';

  sock.onopen = () => {
    if (!callLive(gen)) { try { sock.close(); } catch {} return; }
    setStatus('dialing…');
    sock.send(JSON.stringify({ type: 'resolve', host }));   // ask the server for the IP to "dial"
    // See RESOLVE_DEADLINE_MS: the tone has to outlast the wait, so if the wait
    // is going to outlast the tone, the call ends instead.
    if (resolveDeadline) clearTimeout(resolveDeadline);
    resolveDeadline = setTimeout(() => {
      resolveDeadline = null;
      if (!callLive(gen)) return;
      stopDialTone();
      setTimeout(() => { if (callLive(gen)) noConnect(); }, DIALTONE_BUSY_GAP_MS);
    }, RESOLVE_DEADLINE_MS);
  };

  sock.onmessage = (ev) => {
    if (!callLive(gen)) return;
    if (typeof ev.data === 'string') {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'resolved') {
        // The answer arrived, so the lookup backstop has done its job. Cleared
        // for every link mode: the modem path also clears it in stopDialTone(),
        // but bypass plays no dial tone and never reached that call, so the
        // timer stayed armed and ended a live call with BUSY 5.5 s in.
        if (resolveDeadline) { clearTimeout(resolveDeadline); resolveDeadline = null; }
        setStatus(`dialing ${m.ip}…`);
        // Direct mode skips the dial audio entirely — DTMF, ringback and answer
        // tone all describe a modem placing a call, and there isn't one.
        if (linkMode === 'direct') { startDirect(); return; }
        afterDialTone(gen, () => {
          stopDialTone();
          // leadSecs 0: the dial tone this sequence used to open with has
          // already been playing since the call started.
          playDialSequence(m.ip, 0).then(() => { if (callLive(gen)) startModem(); });
        });
        return;
      }
      // In modem mode the DSP's own `connected` event drives the UI; in direct
      // mode the server's message is the only signal there is.
      if (m.type === 'connected' && linkMode === 'direct') { directLinkUp(); return; }
      // Every way a call can fail to come up arrives here, and they are
      // deliberately indistinguishable: refused, timed out, unresolvable, not in
      // the directory, or the board already at this server's per-board limit.
      // The server knows which and logs it; telling the CLIENT which is what
      // makes a proxy useful for scanning, so it does not.
      if (m.type === 'resolveError' || m.type === 'busy') {
        // A lookup that fails is the case this matters for: it is the one that
        // can answer before the dial tone has been heard at all. Hold the beat,
        // cut the tone, leave the pause an exchange leaves, then reorder.
        // A failure AFTER carrier has no dial tone running, so afterDialTone
        // runs straight through and this is unchanged for it.
        if (dialToneClip) {
          afterDialTone(gen, () => {
            stopDialTone();
            setTimeout(() => { if (callLive(gen)) noConnect(); }, DIALTONE_BUSY_GAP_MS);
          });
        } else {
          noConnect();
        }
        return;
      }
      if (m.type === 'status') setStatus(m.text);
      if (m.type === 'closed') { setStatus(`closed (${m.reason})`); hangup(); }
      return;
    }
    // Direct mode: binary frames are payload bytes, not PCM.
    if (linkMode === 'direct') { feedTerminal(new Uint8Array(ev.data)); return; }
    const f32 = int16ToFloat(ev.data);
    // Inject extension audio into the incoming stream the demod sees (corrupts
    // BBS→user and can trip the carrier-loss path). Mix into a copy so the
    // monitor still shows the clean carrier; the clip is heard via its own node.
    if (dsp) {
      if (extension.active) { const d = f32.slice(); extension.mix(d); dsp.receiveAudio(d); }
      else dsp.receiveAudio(f32);
    }
    monitor.feed('rx', f32);
  };

  // A close belonging to a call that is already over must not tear down the one
  // that replaced it.
  sock.onclose = () => {
    if (!callLive(gen)) return;
    if (carrier || dsp) setStatus('link closed');
    cleanup();
  };
  sock.onerror = () => { if (callLive(gen)) setStatus('link error'); };
}

// A shared link with `connect` doesn't dial on its own — it puts a Connect
// prompt over the terminal and waits for one press.
//
// `connect=auto` is for the case where nobody is going to press anything: a
// kiosk, a display, a board embedding its own link. It dials immediately and
// MUTES the speaker for that call, which is the only honest way to have it —
// the audio cannot be played on time, so it is not played at all.
//
// The mute is per-call and does not touch the stored preference: prefs.set() is
// never called here, and the mode is put back on the next dial or the next page
// load. A visitor who touches the speaker button mid-call has said what they
// want, so the restore is dropped (see the listen handler) rather than
// overruling them on the following dial.
let autoMuteRestore = null;      // the mode to go back to, or null
let autoMutePending = false;     // set by maybeAutoConnect, consumed by connect()

function applyAutoMute() {
  autoMutePending = false;
  if (monitor.mode === 'mute') return;     // already where we want it: nothing to undo
  autoMuteRestore = monitor.mode;
  monitor.mode = 'mute';
  monitor._applyGain();
  updateListenUI();
}

/** Put the speaker back after a connect=auto call. Idempotent. */
function releaseAutoMute() {
  if (autoMuteRestore === null) return;
  monitor.mode = autoMuteRestore;
  autoMuteRestore = null;
  monitor._applyGain();
  updateListenUI();
}

let autoPrompted = false;
function maybeAutoConnect() {
  // Every exit that leaves no box on screen releases the splash, the same way
  // the welcome panel does — a prompt that never opens must not hold the fade.
  if (autoPrompted || !shared.connect || !shared.host || dialing) { _dialSettle(); return; }
  autoPrompted = true;
  if (shared.dialOnLoad) {
    if (typeof markWelcomed === 'function') markWelcomed();
    autoMutePending = true;
    _dialSettle();
    connect();
    return;
  }
  // This visitor gets the Connect prompt instead of the welcome panel, and is
  // counted as welcomed — being greeted twice on two different first impressions
  // is worse than not being greeted at all.
  if (typeof markWelcomed === 'function') markWelcomed();
  const modal = $('dialmodal'), yes = $('dialgo'), no = $('dialclose');
  if (!modal || !yes) { _dialSettle(); connect(); return; }   // markup missing — old behaviour

  const dest = currentDest();
  const where = $('dialwhere'), speed = $('dialspeed');
  if (where) where.textContent = dest.name || `${dest.host}:${dest.port}`;
  if (speed) {
    const opt = protocolEl.selectedOptions[0];
    speed.textContent = opt ? opt.textContent : '';
  }

  function close() {
    modal.setAttribute('hidden', '');
    document.removeEventListener('keydown', onKey, true);
    // Releases the splash. Every route out of the prompt goes through here —
    // dismissed, Escaped, backdrop, or Connect — so there is one place that
    // says the box is done with.
    _dialSettle();
  }
  function onKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    // Enter/Space anywhere is the same as pressing the button, so a keyboard
    // user never has to find it first.
    else if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); go(); }
  }
  function go() { close(); connect(); }

  yes.addEventListener('click', go);
  no && no.addEventListener('click', close);
  // Backdrop dismisses, like the other panels.
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  document.addEventListener('keydown', onKey, true);

  modal.removeAttribute('hidden');
  yes.focus();
}

function hangup() { try { ws && ws.close(); } catch {} cleanup(); }

/**
 * The call did not go through: BUSY on screen, a reorder tone, then hang up.
 *
 * Order matters. The carrier is live when this arrives on the modem path — the
 * board is not dialled until the handshake finishes — so the DSP is stopped
 * FIRST, or the tone is mixed underneath a carrier and is mush. The hang-up then
 * waits out the clip rather than racing it; monitor.reset() carries an
 * unfinished clip across a teardown, but cleanup() would turn the Auto speaker
 * off underneath it, and the tone is the whole point of the exercise.
 */
function noConnect() {
  // linkMode is read BEFORE the hang-up, which resets it to 'modem'.
  const wasDirect = linkMode === 'direct';
  setStatus('no answer');
  if (!busyEchoed) { termEcho('\r\nBUSY\r\n'); busyEchoed = true; }

  // End the call FIRST, then sound the tone into the quiet bus it leaves.
  //
  // The other order was tried and is wrong twice over. It has to leave the
  // hang-up on a timer, so the socket close that follows the server's message
  // races the tone, and every path that ends a call has to learn to wait for it;
  // and it plays the tone into a bus that still has a carrier on it and a
  // speaker gain that is part-way through the ten-second fade Auto starts at
  // CONNECT — which, since a failure by design arrives after carrier, is often
  // already at zero. Hanging up first stops the carrier, resets the bus and
  // settles the gain, and leaves exactly one thing making sound.
  hangup();

  // Telnet bypass places no call, which is why it has no dial tone and no
  // ringback either. A reorder tone would be the only sound in the session.
  if (wasDirect) return;

  // cleanup() has just put Auto's speaker back to off, and a tone nobody can
  // hear is not a signal. Held up for the tone, then released — a fresh call
  // started in the meantime owns the speaker instead, hence the generation
  // check.
  const toneGen = callGen;
  monitor.cancelAutoFade();
  if (monitor.mode === 'auto') { monitor.autoOn = true; monitor._applyGain(); updateListenUI(); }
  const ms = playReorder();
  setTimeout(() => {
    if (callGen !== toneGen) return;          // another call has the speaker now
    if (monitor.mode === 'auto') { monitor.autoOn = false; monitor._applyGain(); updateListenUI(); }
  }, ms);
}

function cleanup() {
  callGen++;                 // orphan every callback the finished call scheduled
  monitor.stopClips('progress');   // silence a dial sequence already on the audio clock
  dialToneClip = null;             // dropped by the line above; don't hold a stale handle
  if (resolveDeadline) { clearTimeout(resolveDeadline); resolveDeadline = null; }
  carrier = false;
  carrierBps = 0;
  extension.stop();
  if (dsp) { try { dsp.stop(); } catch {} dsp = null; }
  ws = null;
  monitor.cancelAutoFade();
  monitor.reset();
  // A dropped carrier or failed dial prints NO CARRIER, once per call.
  if (dialing && !noCarrierEchoed && !busyEchoed) { termEcho('\r\nNO CARRIER\r\n'); noCarrierEchoed = true; }
  dialing = false;
  // Keep Auto's speaker on if an extension clip is still finishing; _finish()
  // returns it to the faded/off state when the clip ends.
  if (monitor.mode === 'auto' && !extension.playing()) { monitor.autoOn = false; monitor._applyGain(); }
  updateListenUI();
  setCallUI(false); extBtn.disabled = true; protocolEl.disabled = false;
  // The user's own font back. Here rather than in hangup() so it also covers a
  // dropped carrier and a dial that never answered.
  endAltFont();
  showFavButton(false);            // heart out, "BBS" label back
  setLed('');
  linkMode = 'modem';              // scope box returns to the waveform view
  tpReset();
  // Back to the idle line — after a beat, so the reason the call ended stays
  // readable. Also refresh the dial totals: this call just changed them.
  scheduleReadyStatus();
  refreshDialStats();
}

// Re-fetch just the counters after a call, so the total and the (##) beside
// each entry reflect the dial that just happened. The response is the same
// cached, ETagged /bbs.json the page already loaded, so a no-change refresh is
// a 304 and costs nothing.
async function refreshDialStats() {
  try {
    const dir = await (await fetch('/bbs.json')).json();
    if (Array.isArray(dir) || !dir.stats) return;
    bbsCounts = dir.stats.counts || {};
    totalDials = dir.stats.total || 0;
    // Sorting by dial count makes the counts part of the ORDER, not just the
    // labels, so that mode has to rebuild — a list sorted by a number that has
    // since changed is worse than a moment's rebuild. renderBBS() re-selects by
    // value, so the destination survives it.
    if (guideSort() === 'dialed' && bbsDir) renderBBS();
    // Otherwise update the labels in place: a rebuild would disturb the
    // selection, and the counts are all that changed.
    else for (const o of bbsEl.options) {
      if (!o.dataset.hp) continue;
      const [h, p] = o.dataset.hp.split(':');
      o.dataset.count = String(dialCount(h, p));
      o.textContent = bbsLabelText(o.dataset.name, o.dataset.hp, +o.dataset.count);
    }
    // If the line is already idle, show the new total now rather than at the
    // next hangup.
    if (!_readyTimer && statusEl.textContent.startsWith('ready —')) setStatus(readyText());
  } catch (_) { /* counters are decoration; a failed refresh changes nothing */ }
}

// ─── Destination: BBS directory (config/bbs.json) + manual host:port ─────────
// One control in two modes. The hidden #host/#port inputs remain the canonical
// state everything else reads; the dropdown and the manual field are just two
// ways to write them. The toggle's glyph always names where it will take you:
// pencil (edit by hand) in directory mode, list (back to the directory) in manual.
let manualMode = !!prefs.get('manualMode');

// What this page load's URL asked for, if anything. Read once, here, so every
// consumer below sees the same answer.
//
// A shared link is a **transient override**: it drives the live controls but is
// never written to localStorage. Someone who opens your link, tries the board
// and comes back to a plain SynthLink URL later still finds their own last
// destination — their stored prefs only change when they pick something
// themselves. (`connect()` doesn't call saveDest(), so dialling a shared link
// doesn't persist it either. That is deliberate; don't "fix" it.)
const shared = parseShareParams(location.search, [...protocolEl.options].map((o) => o.value));

// No shared link means no Connect prompt, and the splash must not wait on a box
// that cannot open. Settled HERE rather than in maybeAutoConnect, which runs
// only once the directory fetch has come back: a visitor with no ?connect= has
// nothing to do with that fetch, and a slow or hanging one would otherwise hold
// the splash over a page that is already up.
if (!(shared.connect && shared.host)) _dialSettle();

// The canonical destination lives in the hidden #host/#port inputs, so every
// path that writes them funnels through here to persist the result and refresh
// the favourite heart.
function saveDest() {
  prefs.set('dest', { host: hostEl.value.trim(), port: portEl.value.trim() || '23' });
  // The manual field is a DISPLAY of the destination, never a second copy of it.
  //
  // connect() folds that field back into #host/#port first (commitHostPort), so
  // whenever the two disagree the FIELD wins — silently, and after the user has
  // already pressed Connect. Every control that moves the canonical destination
  // therefore has to move the field with it, and doing that here rather than at
  // each of them is what stops the next control added from reintroducing it.
  //
  // The case that found this: `ATDT some.host` to an address the directory does
  // not carry flips the page into manual mode and leaves the typed host in the
  // field. Picking a board from the directory afterwards updated #host/#port
  // correctly — and then Connect overwrote them from the stale field and
  // dialled the typed address again.
  if (manualMode) hostportEl.value = `${hostEl.value.trim()}:${portEl.value.trim() || '23'}`;
  updateFavUI();
}

function commitHostPort() {
  const [h, p] = hostportEl.value.trim().split(':');
  if (!h) return;
  hostEl.value = h.trim();
  portEl.value = (p || '').trim() || '23';
  saveDest();
}

function updateDestUI() {
  bbsEl.hidden = manualMode;
  hostportEl.hidden = !manualMode;
  bbsToggle.classList.toggle('on', manualMode);
  bbsToggle.querySelector('.kbdicon').innerHTML = manualMode ? '&#9776;' : '&#9998;';
  bbsToggle.title = manualMode ? 'Back to the BBS directory' : 'Enter host:port manually';
}

bbsToggle.addEventListener('click', () => {
  if (!manualMode) {
    // Into manual: seed the field from whatever is currently selected.
    hostportEl.value = `${hostEl.value.trim()}:${portEl.value.trim() || '23'}`;
  } else {
    // Back to the directory: keep the typed destination if the directory can
    // actually SHOW it, and otherwise take the board the dropdown is displaying.
    //
    // It used to keep the typed destination unconditionally, which left the
    // dropdown naming one board while Connect went to another — and because
    // re-picking the option a <select> already sits on fires no `change` event,
    // picking the displayed board did not correct it. `ATDT` to an address the
    // directory does not carry, then back to the directory, then Connect, and
    // the typed address was dialled again with a different board on screen.
    //
    // Adopting is the same answer renderBBS() gives when the list cannot show
    // the destination, and for the same stated reason: a control that lies
    // about where Connect goes is worse than losing a typed address the user
    // has just navigated away from.
    commitHostPort();
    if (!syncBBSSelection()) commitBBSSelection();
  }
  manualMode = !manualMode;
  prefs.set('manualMode', manualMode);
  updateDestUI();
  showToast(manualMode ? 'Manual host:port' : 'BBS directory');
  (manualMode ? hostportEl : bbsEl).focus();
});

// ─── Favourites (♡ / ♥ in the BBS label slot) ────────────────────────────────
// The heart only exists during a call: from the moment Connect is pressed the
// "BBS" label is replaced by it, and on hangup the label comes back. Clicking adds the current destination
// to the favourites list or removes it again — including a hand-typed one, which
// is stored with an empty name and so lists as a bare host:port.
function currentDest() {
  const host = hostEl.value.trim();
  const port = portEl.value.trim() || '23';
  // Prefer the directory's name for this destination; a manual entry has none.
  // Read it from the option's dataset rather than by splitting the visible text:
  // on mobile the label is short-form (name only) and carries no separator.
  const opt = [...bbsEl.options].find((o) => o.value === `${host}:${port}`);
  const name = (opt && opt.dataset.name) || '';
  return { name, host, port };
}

function updateFavUI() {
  if (!favBtn) return;
  const { name, host, port } = currentDest();
  const on = isFavorite(host, port);
  const who = name || `${host}:${port}`;
  favBtn.classList.toggle('is', on);
  favBtn.innerHTML = on ? '&#9829;' : '&#9825;';   // ♥ filled / ♡ outline
  favBtn.title = on ? `Remove ${who} from favorites` : `Add ${who} to favorites`;
  favBtn.setAttribute('aria-label', favBtn.title);
  scheduleBarFit();   // the heart replaces the "BBS" label at a different width
}

// The heart swaps in for the label, never sits beside it.
function showFavButton(show) {
  bbsLabel.hidden = show;
  favBtn.hidden = !show;
  if (show) updateFavUI();
}

// Named rather than inline because the directory panel offers the same action
// from a second control. One implementation, so the two cannot disagree about
// what "favourite" does to the list, the dropdown or the heart.
function toggleFavorite() {
  const dest = currentDest();
  if (!dest.host) return;
  const list = prefs.favorites.slice();
  const i = favIndex(dest.host, dest.port);
  if (i >= 0) list.splice(i, 1); else list.push(dest);
  prefs.favorites = list;
  renderBBS();      // the Favorites group appears / updates / disappears
  updateFavUI();
  showToast(i >= 0 ? 'Removed from favorites' : 'Added to favorites');
}

favBtn.addEventListener('click', toggleFavorite);

// ─── Directory panel (click the "BBS" label) ────────────────────────────────
// Three things you might want to do ABOUT the selected board, as opposed to
// dialling it: favourite it, read its entry in the Telnet BBS Guide, or give up
// on choosing and take a random one. None of them earns a permanent control in
// a bar that is already full, and all three are one press from the label that
// names the dropdown they act on.
//
// No open/close guard is needed for the call case: during a call the heart
// REPLACES this label (showFavButton), so there is no element left to click.
// That is also why the panel can assume it is safe to change the destination.
//
// The guide button is a SEARCH, and is offered unconditionally. The monthly CSV
// the directory is built from carries name/host/port and nothing else — no URL,
// no id — so there is no per-listing link to construct, and the site's own
// search is the honest target: a stable entry point rather than a slug guessed
// from the name, whose failure mode is an empty result page rather than a 404.
//
// Unconditional because the search is the thing that decides, not us. Gating it
// on "did this board come from the guide tier" was wrong in the direction that
// matters: a guide-listed board reached through Favorites or Featured is the
// SAME board, and hiding the button there withheld a search that would have
// worked. Offering it for a board the guide has never heard of costs a search
// page that says so.
const guideSearchURL = (name) => `${GUIDE_URL}?s=${encodeURIComponent(name)}`;

(function bbsPanel() {
  const modal = $('bbsmodal'), where = $('bbswhere');
  const favB = $('bbsfav'), guideB = $('bbsguide'), randB = $('bbsrandom');
  const closeB = $('bbsclose');
  // All or nothing: with any piece missing the label stays inert rather than
  // opening a panel with a hole in it — and nothing below has to null-check.
  if (!modal || !where || !favB || !guideB || !randB || !closeB) return;

  function close() {
    modal.setAttribute('hidden', '');
    document.removeEventListener('keydown', onKey, true);
  }
  function onKey(e) {
    // Escape only. Enter/Space are deliberately NOT bound the way the connect
    // prompt binds them: that panel has one obvious action and this one has
    // three, so there is nothing for a blind Enter to mean.
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
  }
  function open() {
    const { name, host, port } = currentDest();
    if (!host) return;
    // The board is named ONCE, in the panel's own heading. The buttons say what
    // they do and nothing else: repeating the name in every label made three
    // long, near-identical lines out of three unrelated actions.
    where.textContent = name || `${host}:${port}`;
    favB.textContent = isFavorite(host, port)
      ? 'Remove from favorites' : 'Add to favorites';
    modal.removeAttribute('hidden');
    document.addEventListener('keydown', onKey, true);
    favB.focus();
  }

  bbsLabel.addEventListener('click', open);
  closeB.addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

  // Every action closes the panel: each one is a complete answer to the
  // question it was opened to ask, and the two that change the destination
  // would leave a panel on screen describing the board you just left.
  favB.addEventListener('click', () => { toggleFavorite(); close(); });
  guideB.addEventListener('click', () => {
    const { name, host } = currentDest();
    // The name is what the guide indexes; a hand-typed entry has none, and its
    // host is the only thing there is to search for.
    window.open(guideSearchURL(name || host), '_blank', 'noopener,noreferrer');
    close();
  });
  // Draw AND dial, which is what makes this different from the dropdown's
  // Random option: that one is a way of choosing, this is `ATDT RANDOM`. Guarded
  // on the draw having actually landed somewhere — with no directory loaded
  // drawRandomBBS() leaves the destination alone, and dialling the previous
  // board would be the one outcome nobody pressing this button asked for.
  randB.addEventListener('click', () => {
    const drew = drawRandomBBS();
    close();
    if (!drew) return;
    // Echo the command this button is the shortcut for, so the terminal shows
    // `ATDT RANDOM` above connect()'s own `ATDT host:port` exactly as it would
    // had it been typed. Teaching the typed form by example is the point.
    termEcho('\r\nATDT RANDOM');
    connect();
  });
})();

// Point the dropdown at the current host:port when the directory lists it.
function syncBBSSelection() {
  const cur = `${hostEl.value.trim()}:${portEl.value.trim()}`;
  if (![...bbsEl.options].some((o) => o.value === cur)) return false;
  bbsEl.value = cur;
  return true;
}

/**
 * Make the destination match what the dropdown is SHOWING.
 *
 * The counterpart to commitHostPort(), and for the same reason: whichever
 * control the user is looking at is the one that names where Connect goes, so
 * the canonical destination has to be reconciled to it before dialling. In
 * manual mode that control is the host:port field; in directory mode it is this
 * dropdown.
 *
 * It only ever does anything when the two have drifted apart, which the select
 * cannot fix on its own: re-picking the option a <select> is ALREADY sitting on
 * fires no `change` event, so a dropdown left displaying a board that is not the
 * destination will keep displaying it however many times the user picks it.
 *
 * A sentinel is never adopted — none of them names a destination, and putting
 * '@random' or '@sort-…' into #host is the bug isSentinel() exists to prevent.
 */
function commitBBSSelection() {
  const shown = bbsEl.selectedOptions[0];
  if (!shown || !shown.value || isSentinel(shown.value)) return;
  const cur = `${hostEl.value.trim()}:${portEl.value.trim() || '23'}`;
  if (shown.value === cur) return;
  const [h, p] = shown.value.split(':');
  hostEl.value = h; portEl.value = p || '23';
  saveDest();
}

// Three groups, as <optgroup>s: the curated list first (config/curated.txt, in
// the order written — where most users go), then Random, then the Telnet BBS
// Guide's monthly list alphabetically. The server merges and caches the two real
// tiers; see lib/bbslist.js.
//
// Random is an option whose value is a sentinel rather than a host:port. The
// change handler spots it, draws uniformly from every entry in both tiers, and
// snaps the dropdown to whatever it drew — so the selection always names a real
// destination and the rest of the app never learns a draw happened. Picking
// Random again is a genuine change of value (the select is sitting on the drawn
// BBS by then), so it re-rolls with no extra plumbing.
const RANDOM_VALUE = '@random';   // '@' can't occur in a host:port
// Same trick, for the "open telnetbbsguide.com" entry that heads the guide
// group. A native <select> can only hold option text — no anchor, no icon — so
// the link has to be an option that acts on selection and then puts the
// dropdown back where it was. The ↗ carries the external-link sense that the
// CSS mark (--exticon) gives the about panel's real links.
const GUIDE_LINK_VALUE = '@guide';
const GUIDE_URL = 'https://www.telnetbbsguide.com/';

// ── Guide sort order ────────────────────────────────────────────────────────
// The same trick again, for the three sort entries that sit under the link: an
// option that acts on selection and then puts the dropdown back where it was. A
// native <select> cannot hold a control, and the alternative — a second widget
// in the header — is exactly the row `fitBar()` exists to avoid.
//
// Only the guide tier is sorted. Favourites are in the order they were added
// and Featured is the order config/curated.txt is written in; both are
// somebody's deliberate choice. The guide's ~1000 rows are the ones nobody
// arranged.
//
// Every mode's SECOND key is alphabetical, so equal counts and same-day
// arrivals have a stable order rather than whatever the merge left behind.
// `added` is the date THIS INSTANCE first saw the board (lib/bbslist.js), not
// anything the guide publishes; an entry from a server too old to send one
// sorts last under `newest`, which is the honest place for "we don't know".
const SORT_VALUES = { '@sort-alpha': 'alpha', '@sort-dialed': 'dialed', '@sort-new': 'newest' };
const SORT_LABELS = { alpha: 'alphabet', dialed: 'most dialed', newest: 'newly added' };
const SORT_KEY = 'guideSort';

// `[Sorting by …]` for the one in force, `[Sort by …]` for the two that would
// change it — the verb says which is a description and which is an action. The
// brackets mark all three as entries that do something rather than boards you
// can dial, which is the same job the ↗ does on the guide link above them.
function sortOptionText(mode, active) {
  return `[${active ? 'Sorting' : 'Sort'} by ${SORT_LABELS[mode]}]`;
}
const guideSort = () => (SORT_LABELS[prefs.get(SORT_KEY)] ? prefs.get(SORT_KEY) : 'alpha');

// `numeric` so "BBS 2" comes before "BBS 10", which is what "alphanumeric"
// means to anyone reading a list of board names.
function byName(a, b) {
  return String(a.name || '').localeCompare(String(b.name || ''), 'en',
                                            { sensitivity: 'base', numeric: true });
}

/**
 * A COPY of `list` in the given order. Never sorts in place: bbsDir holds the
 * fetched list, and re-sorting the array the pool is built from would make each
 * order depend on the one before it.
 */
function sortGuide(list, mode) {
  const out = [...list];
  if (mode === 'dialed') {
    out.sort((a, b) => dialCount(b.host, b.port) - dialCount(a.host, a.port) || byName(a, b));
  } else if (mode === 'newest') {
    // Descending by first-seen date; ISO dates compare as strings. '' sorts last.
    out.sort((a, b) => String(b.added || '').localeCompare(String(a.added || '')) || byName(a, b));
  } else {
    out.sort(byName);
  }
  return out;
}

// Draw one entry from both tiers and adopt it. Named because the directory
// panel offers the same action; the dropdown's Random option is the other
// caller. Snapping the <select> to the drawn entry is what keeps the sentinel
// from ever being the visible selection.
//
// Returns whether a draw actually happened, because the panel's button dials
// straight afterwards: with no directory loaded this leaves the destination
// untouched, and dialling then would call the PREVIOUS board — the one outcome
// nobody pressing Random asked for.
function drawRandomBBS() {
  const pool = (bbsDir && bbsDir.pool) || [];
  if (!pool.length) return false;
  const pick = pool[Math.floor(Math.random() * pool.length)];
  const hp = `${pick.host}:${pick.port || 23}`;
  hostEl.value = pick.host; portEl.value = String(pick.port || 23);
  saveDest();
  bbsEl.value = hp;         // snap to the drawn entry — never left on Random
  showToast(pick.name ? `Random: ${pick.name}` : `Random: ${hp}`);
  return true;
}

// Label form is breakpoint-dependent. Desktop shows "Name · host:port" — the
// same dot separator the speed menu uses. On mobile the address is dropped: the
// native picker (iOS wheel, Android dialog) is narrow, the guide's entries are
// long, and the name is the only part anyone scans for. Nothing is lost — the
// pencil toggle switches to a manual host:port field seeded from #host/#port,
// so the address of whatever is selected is always one tap away.
//
// An entry with no name (a hand-typed favourite) has only its host:port to show,
// so it renders the same either way.
// The dial count rides in the label as a bare `(##)` — beside the name on
// mobile, after the whole entry on desktop. Zero and unknown are both rendered
// as nothing rather than "(0)": a board nobody has dialled yet and a board the
// server has no record of look the same to the user, and neither is worth a
// column of zeroes down the list.
function bbsCountText(n) {
  return n > 0 ? ` (${n})` : '';
}

function bbsLabelText(name, hp, count) {
  const c = bbsCountText(count);
  if (isMobile()) return `${name || hp}${c}`;
  return name ? `${name} · ${hp}${c}` : `${hp}${c}`;
}

// host:port → dial count, from /bbs.json. Kept flat and lower-cased so a
// favourite's stored casing still matches the server's key.
let bbsCounts = {};
function dialCount(host, port) {
  return bbsCounts[`${String(host).toLowerCase()}:${parseInt(port, 10) || 23}`] || 0;
}

function bbsOption(b) {
  const o = document.createElement('option');
  const hp = `${b.host}:${b.port || 23}`;
  o.value = hp;
  // Kept as data, not parsed back out of the label: the label is lossy on mobile
  // and currentDest() needs the name verbatim. The count joins it for the same
  // reason — relabelBBS() rebuilds from these, never from the previous text.
  o.dataset.name = b.name || '';
  o.dataset.hp = hp;
  o.dataset.count = String(dialCount(b.host, b.port));
  o.textContent = bbsLabelText(b.name, hp, +o.dataset.count);
  return o;
}

// Rewrite every directory label in place after a breakpoint crossing. Options
// without a dataset.hp (Random, the "(no directory)" placeholder) aren't
// destinations and are left alone; values are untouched, so the current
// selection, the favourites match and #host/#port all survive unchanged.
function relabelBBS() {
  for (const o of bbsEl.options) {
    if (!o.dataset.hp) continue;
    o.textContent = bbsLabelText(o.dataset.name, o.dataset.hp, +(o.dataset.count || 0));
  }
}

// Rotation or a window resize across 640px re-picks the label form. Same
// crossing-detection pattern as the mobile font default further down.
let wasMobileBBS = isMobile();
window.addEventListener('resize', () => {
  const nowMobile = isMobile();
  if (nowMobile === wasMobileBBS) return;
  wasMobileBBS = nowMobile;
  relabelBBS();
  scheduleBarFit();
});

// The fetched directory, kept so the list can be rebuilt without re-fetching
// when the favourites change.
let bbsDir = null;

// An option value that is an action rather than a destination. One predicate,
// so a new sentinel can never be added to the list and forgotten by the two
// places that must not treat one as a host:port.
const isSentinel = (v) =>
  v === RANDOM_VALUE || v === GUIDE_LINK_VALUE ||
  Object.prototype.hasOwnProperty.call(SORT_VALUES, v);

function renderBBS() {
  if (!bbsDir) return;
  const { curated, guide, pool } = bbsDir;
  // Hold the current destination across the rebuild: re-selecting by value only
  // works once the new options exist.
  const keep = `${hostEl.value.trim()}:${portEl.value.trim() || '23'}`;
  bbsEl.innerHTML = '';
  {
    // Favourites first, and only when there are any. They're stored records
    // rather than references, so they render whether or not the board still
    // appears in either tier below (and a favourite that also appears below is
    // deliberately shown in both places).
    if (prefs.favorites.length) {
      const g = document.createElement('optgroup');
      g.label = 'Favorites';
      for (const b of prefs.favorites) g.appendChild(bbsOption(b));
      bbsEl.appendChild(g);
    }
    if (curated.length) {
      const g = document.createElement('optgroup');
      g.label = 'Featured';
      for (const b of curated) g.appendChild(bbsOption(b));
      bbsEl.appendChild(g);
    }
    if (pool.length > 1) {
      const g = document.createElement('optgroup');
      g.label = 'Random';
      const o = document.createElement('option');
      o.value = RANDOM_VALUE;
      o.textContent = 'Random BBS Selection';
      g.appendChild(o);
      bbsEl.appendChild(g);
    }
    if (guide.length) {
      const g = document.createElement('optgroup');
      g.label = `Telnet BBS Guide (${guide.length})`;
      // Credit where the tier comes from, and a way to go read it: the guide
      // has descriptions, software and uptime that this dropdown cannot. First
      // in the group so it reads as that group's header rather than as a board.
      const link = document.createElement('option');
      link.value = GUIDE_LINK_VALUE;
      link.textContent = '↗ Open telnetbbsguide.com';
      g.appendChild(link);
      // The three sort entries, directly under the link and above the boards
      // they reorder. The one in force says so in its own words rather than
      // being marked or hidden: all three stay selectable, so the current mode
      // is a no-op instead of a gap in the run.
      const mode = guideSort();
      for (const [value, m] of Object.entries(SORT_VALUES)) {
        const o = document.createElement('option');
        o.value = value;
        o.textContent = sortOptionText(m, m === mode);
        g.appendChild(o);
      }
      for (const b of sortGuide(guide, mode)) g.appendChild(bbsOption(b));
      bbsEl.appendChild(g);
    }
  }
  bbsEl.title = guide.length
    ? `${curated.length} featured + ${guide.length} from telnetbbsguide.com`
    : 'BBS directory (config/curated.txt)';
  if ([...bbsEl.options].some((o) => o.value === keep)) {
    bbsEl.value = keep;
  } else if (!manualMode) {
    // Nothing in the list matches the canonical destination, so the <select> is
    // showing its first option while #host/#port hold something else — the
    // dropdown would be lying about where Connect goes, and the heart would
    // favourite a board the user never picked. Adopt what's displayed. Not
    // persisted: the user hasn't chosen anything yet.
    //
    // Only in directory mode. In manual mode the host:port field is what's on
    // screen and the hidden inputs already agree with it, so adopting an option
    // the user can't even see would silently redirect them. That is exactly the
    // case a shared link to an off-directory board lands in: loadBBS() flips to
    // manual precisely so this branch leaves the destination alone.
    const shown = bbsEl.selectedOptions[0];
    // Every sentinel is excluded: none of them names a destination, and
    // adopting one would put '@random'/'@guide'/'@sort-…' into #host.
    if (shown && shown.value && !isSentinel(shown.value)) {
      const [h, p] = shown.value.split(':');
      hostEl.value = h; portEl.value = p || '23';
    }
  }
  updateFavUI();
  scheduleBarFit();   // a new label set can change the dropdown's width
}

// One change handler for the life of the page — renderBBS() replaces the
// options underneath it, which doesn't disturb a listener on the <select>.
bbsEl.addEventListener('change', () => {
  if (bbsEl.value === GUIDE_LINK_VALUE) {
    // Not a destination — open the guide and put the dropdown back. The
    // restore reads #host/#port rather than a remembered option, because those
    // are canonical and survive a renderBBS() in between.
    //
    // The no-match branch should be unreachable: the select is only visible in
    // directory mode, and renderBBS() guarantees its value agrees with
    // #host/#port there. It is handled anyway because the alternative — the
    // dropdown left sitting on the link entry — would then be a control naming
    // a destination that does not exist. Falling back adopts a real board, so
    // #host/#port move with it rather than being left contradicting the label.
    window.open(GUIDE_URL, '_blank', 'noopener,noreferrer');
    const hp = `${hostEl.value.trim()}:${portEl.value.trim() || '23'}`;
    bbsEl.value = hp;
    if (bbsEl.value !== hp) {
      const first = [...bbsEl.options].find((o) => o.value && !isSentinel(o.value));
      if (first) {
        bbsEl.value = first.value;
        const [fh, fp] = first.value.split(':');
        hostEl.value = fh; portEl.value = fp || '23';
        saveDest();
      }
    }
    return;
  }
  if (bbsEl.value === RANDOM_VALUE) { drawRandomBBS(); return; }
  if (Object.prototype.hasOwnProperty.call(SORT_VALUES, bbsEl.value)) {
    // Not a destination either. Persist the choice and rebuild: renderBBS()
    // re-selects by value from #host/#port, so the destination the user was
    // sitting on comes back selected in its new position, which is the whole
    // point of being able to reorder the list at all.
    prefs.set(SORT_KEY, SORT_VALUES[bbsEl.value]);
    renderBBS();
    showToast(`Sorting by ${SORT_LABELS[guideSort()]}`);
    return;
  }
  const [h, p] = bbsEl.value.split(':');
  hostEl.value = h; portEl.value = p || '23';
  saveDest();
});

async function loadBBS() {
  try {
    const dir = await (await fetch('/bbs.json')).json();
    // Tolerate the old flat-array format from a stale server.
    const curated = Array.isArray(dir) ? dir : (dir.curated || []);
    const guide   = Array.isArray(dir) ? []  : (dir.guide   || []);
    if (!curated.length && !guide.length) {
      bbsEl.innerHTML = '';
      const o = document.createElement('option');
      o.textContent = '(no directory)'; bbsEl.appendChild(o); return;
    }
    // The random draw is unweighted across both tiers — with ~1000 guide entries
    // to a handful of featured ones, that's in practice a random guide board.
    // Dial counts ship inside the same payload — one fetch, one ETag. An older
    // server that doesn't send them leaves every count at zero, which renders
    // as no suffix at all.
    const stats = (!Array.isArray(dir) && dir.stats) || null;
    bbsCounts = (stats && stats.counts) || {};
    totalDials = (stats && stats.total) || 0;
    bbsDir = { curated, guide, pool: [...curated, ...guide] };
    // Restore the last destination before the first render, so the rebuild's
    // re-selection lands on it. A stored value is authoritative even if it's no
    // longer in any list (a favourite that left the guide, or a hand-typed
    // host) — the re-selection simply won't find a match.
    const dest = prefs.get('dest');
    if (dest && dest.host) {
      hostEl.value = dest.host; portEl.value = String(dest.port || 23);
    }
    // A URL-supplied destination outranks the stored one, and is applied after
    // it so it wins outright rather than being merged with it.
    if (shared.host) {
      hostEl.value = shared.host; portEl.value = shared.port || '23';
      // Show it where the user will actually look. If the board is in the
      // directory the dropdown selects it by value and displays its name; if it
      // isn't — a guide entry that rotated out, a hand-typed host someone
      // shared — the dropdown has nothing to show, so switch to the manual
      // host:port field, which can display any destination. Not persisted: this
      // is the shared link's mode, not a preference the visitor expressed.
      const inDirectory = [...curated, ...guide]
        .some((b) => `${b.host}:${b.port || 23}` === `${shared.host}:${shared.port || '23'}`);
      if (!inDirectory && !manualMode) {
        manualMode = true;
        hostportEl.value = `${shared.host}:${shared.port || '23'}`;
        updateDestUI();
      }
    }
    renderBBS();
    // The ready line was drawn before this fetch resolved, so it has no total
    // in it yet. Redraw it — but only if the page is still idle: an autoconnect
    // or a fast Connect press may already have moved it on.
    if (statusEl.textContent.startsWith('ready —')) setStatus(readyText());
    if (manualMode) hostportEl.value = `${hostEl.value}:${portEl.value || '23'}`;
    maybeAutoConnect();
  } catch (e) {
    bbsEl.innerHTML = '<option>(directory unavailable)</option>';
    // The directory is only how you *pick* a board. A shared link already names
    // one, so it can still be dialled with the list unavailable — but only from
    // the manual field, which is the only control that can show it.
    if (shared.host) {
      hostEl.value = shared.host; portEl.value = shared.port || '23';
      if (!manualMode) { manualMode = true; updateDestUI(); }
      hostportEl.value = `${hostEl.value}:${portEl.value}`;
    }
    maybeAutoConnect();
  }
}
updateDestUI();
loadBBS();
// Alongside the directory, not chained to it: an override has to be in hand
// before the first dial, and the two have nothing to say to each other. If it
// never arrives the map stays empty and every board keeps the user's font.
loadAltFonts();

// ─── Key sequences (shared by the physical and on-screen paths) ──────────────
// One source of truth for "what bytes does this key send", so a physical F5 and
// the on-screen F5 cannot drift apart. Both paths call namedSeq()/ctrlChar();
// the on-screen keyboard supplies its modifier state from its own sticky Ctrl
// and Shft keys, the physical path from the event.
//
// Modifiers use xterm's encoding: 1 + Shift(1) + Alt(2) + Ctrl(4). Alt is spoken
// for by scrollback here (see onKey), so only 2 (shift), 5 (ctrl) and 6 (both)
// are ever produced. An unmodified key keeps the exact form this app has always
// sent — in particular Home/End stay the VT220 `ESC [ 1 ~` / `ESC [ 4 ~` rather
// than `ESC [ H` / `ESC [ F`, because that is what the BBSes have been seeing.
const CSI_TILDE = { Insert:2, Delete:3, PageUp:5, PageDown:6, Home:1, End:4,
  F5:15, F6:17, F7:18, F8:19, F9:20, F10:21, F11:23, F12:24 };
const SS3_FN    = { F1:'P', F2:'Q', F3:'R', F4:'S' };
const CSI_ARROW = { ArrowUp:'A', ArrowDown:'B', ArrowRight:'C', ArrowLeft:'D' };

function modCode(ctrl, shift) { return 1 + (shift ? 1 : 0) + (ctrl ? 4 : 0); }

// A named non-printing key under the given modifiers → its byte sequence.
// Returns null if `name` is not one of them (i.e. it is an ordinary character).
function namedSeq(name, ctrl, shift) {
  const m = modCode(ctrl, shift);
  if (Object.prototype.hasOwnProperty.call(CSI_TILDE, name)) {
    const n = CSI_TILDE[name];
    return m === 1 ? `\x1B[${n}~` : `\x1B[${n};${m}~`;
  }
  if (Object.prototype.hasOwnProperty.call(SS3_FN, name)) {
    // F1–F4 are SS3 when unmodified and promote to CSI when modified. That
    // asymmetry is xterm's, not ours, and it is what terminfo consumers expect.
    return m === 1 ? `\x1BO${SS3_FN[name]}` : `\x1B[1;${m}${SS3_FN[name]}`;
  }
  if (Object.prototype.hasOwnProperty.call(CSI_ARROW, name)) {
    const c = CSI_ARROW[name];
    return m === 1 ? `\x1B[${c}` : `\x1B[1;${m}${c}`;
  }
  switch (name) {
    // Shift-Tab is `ESC [ Z` by long convention rather than the modifier form;
    // that is the sequence BBS software actually recognises.
    case 'Tab':       return shift ? '\x1B[Z' : (ctrl ? '\x1B[1;5I' : '\t');
    case 'Enter':     return '\r';
    case 'Escape':    return '\x1B';
    // Backspace stays 0x7F on both paths — deliberate, see KEYBOARDAUDIT.txt.
    // Ctrl-H remains the way to send 0x08 to a board that wants it.
    case 'Backspace': return '\x7F';
    // Telnet IAC BRK — the conventional escape from a hung door. server.js
    // proxies demodulated user bytes to the socket unescaped (toBBS), so this
    // reaches the BBS as a real break. Nothing else can trip that path: no
    // ASCII key produces 0xFF.
    case 'Break':     return '\xFF\xF3';
  }
  return null;
}

// A printable character under Ctrl → its control byte. Between this and the
// letters, every code point in 0x00–0x1F plus DEL is reachable.
function ctrlChar(ch) {
  if (typeof ch !== 'string' || ch.length !== 1) return null;
  const u = ch.toUpperCase();
  if (u >= 'A' && u <= 'Z') return String.fromCharCode(u.charCodeAt(0) - 64);
  switch (ch) {
    case '@': case ' ': return '\x00';
    case '[':  return '\x1B';  case '\\': return '\x1C';  case ']': return '\x1D';
    case '^':  return '\x1E';  case '_':  return '\x1F';  case '?': return '\x7F';
  }
  return null;
}

// ─── Keyboard ────────────────────────────────────────────────────────────────
// Physical keydown → bytes. Alt is reserved for scrollback and never reaches
// here (onKey consumes it first), so an Alt-modified key falls through to null.
function keyToSeq(e) {
  if (e.altKey || e.metaKey) return null;
  // Ctrl+Pause is the only physical key left for BRK; nothing else is free.
  if (e.ctrlKey && e.key === 'Pause') return namedSeq('Break', false, false);
  const named = namedSeq(e.key, e.ctrlKey, e.shiftKey);
  if (named !== null) return named;
  if (e.ctrlKey) {
    const c = ctrlChar(e.key);
    if (c !== null) return c;
    return null;   // Ctrl+<something with no control form> sends nothing
  }
  if (e.key.length === 1) return e.key;
  return null;
}
// ─── Scrollback ──────────────────────────────────────────────────────────────
// The Terminal model keeps a scrollback ring (see terminal.js); here we wire the
// navigation (wheel, Page keys, Shift+arrows, touch swipe) and a brief on-screen
// position indicator. The render loop already draws term.getDisplayCells() and
// respects term.isLive(), so scrolling just moves the terminal's view offset.
// Read from the served meta tag, not hardcoded. 0 is meaningful (no scrollback
// at all), so this may not use `||` anywhere on the path.
{
  const raw = (document.querySelector('meta[name="app-scrollback"]') || {}).content;
  const n = parseInt(raw, 10);
  term.MAX_SCROLLBACK = Number.isFinite(n) && n >= 0 ? n : 5000;
}
const sbIndicator = $('scrollback-indicator');
let _sbIndTimer = null;

// Scrollback can be switched off so an accidental swipe (mobile) or wheel doesn't
// trigger it. Default: on for desktop, off for mobile (where mis-swipes happen).
// Stored value wins; with none, the per-device default (on for desktop, off for
// mobile, where mis-swipes happen) applies as before.
let scrollbackEnabled = typeof prefs.get('scrollback') === 'boolean'
  ? prefs.get('scrollback') : !isMobile();

// Small transient on-screen message — the touch-device counterpart to the hover
// tooltip (a `title` only shows on desktop hover).
let _toastTimer = null;
function showToast(msg) {
  const t = $('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.remove('show'), 1500);
}
function showSbIndicator() {
  if (!sbIndicator) return;
  if (!term.isLive()) {
    sbIndicator.textContent = `↑ SCROLLBACK  −${term._scrollOffset}`;
    sbIndicator.classList.add('visible');
  } else {
    sbIndicator.classList.remove('visible');
  }
  clearTimeout(_sbIndTimer);
  _sbIndTimer = setTimeout(() => { if (term.isLive()) sbIndicator.classList.remove('visible'); }, 2500);
}
// ─── Desktop scroll rail ─────────────────────────────────────────────────────
// Not a browser scrollbar and cannot be: the terminal is a canvas painted from a
// ring buffer, so there is no overflowing element to attach one to. Driven
// straight off the ring, and UPDATED FROM THE THREE PATHS that can move either
// number — a scroll, feedTerminal() and termEcho() — rather than polled.
//
// `term.scrollbackOffset` counts BACK from live, which is why every mapping here
// is written against `length - offset`.
const scrollRail = $('scrollrail'), scrollThumb = $('scrollthumb');
let _railDrag = null;

function updateScrollRail() {
  if (!scrollRail || !scrollThumb) return;
  const total = term.scrollbackLength;
  if (!scrollbackEnabled || total === 0) { scrollRail.classList.remove('active'); return; }
  scrollRail.classList.add('active');
  const railH = scrollRail.clientHeight;
  const rows = term.rows || 24;
  // The thumb is the live screen's share of everything the ring can show.
  const span = total + rows;
  const thumbH = Math.max(18, Math.round(railH * (rows / span)));
  // offset === 0 is live, which is the BOTTOM of the rail.
  const frac = total === 0 ? 1 : (total - term.scrollbackOffset) / total;
  scrollThumb.style.height = `${thumbH}px`;
  scrollThumb.style.top = `${Math.round((railH - thumbH) * frac)}px`;
}

// Drag maps the thumb's travel back onto the ring. Pointer events so a drag that
// leaves the rail keeps tracking, and the capture releases on its own.
if (scrollRail) {
  scrollRail.addEventListener('pointerdown', (e) => {
    if (!scrollbackEnabled || term.scrollbackLength === 0) return;
    const r = scrollRail.getBoundingClientRect();
    const th = scrollThumb.getBoundingClientRect();
    const inThumb = e.clientY >= th.top && e.clientY <= th.bottom;
    _railDrag = { grab: inThumb ? e.clientY - th.top : th.height / 2, h: th.height, top: r.top };
    scrollRail.classList.add('dragging');
    scrollRail.setPointerCapture(e.pointerId);
    railDragTo(e.clientY);
    e.preventDefault();
  });
  scrollRail.addEventListener('pointermove', (e) => { if (_railDrag) railDragTo(e.clientY); });
  const endDrag = (e) => {
    if (!_railDrag) return;
    _railDrag = null; scrollRail.classList.remove('dragging');
    try { scrollRail.releasePointerCapture(e.pointerId); } catch {}
  };
  scrollRail.addEventListener('pointerup', endDrag);
  scrollRail.addEventListener('pointercancel', endDrag);
}

function railDragTo(clientY) {
  const total = term.scrollbackLength;
  if (total === 0) return;
  const railH = scrollRail.clientHeight;
  const travel = Math.max(1, railH - _railDrag.h);
  const frac = Math.max(0, Math.min(1, (clientY - _railDrag.top - _railDrag.grab) / travel));
  term.scrollbackTo(total - frac * total);   // frac 1 = live = offset 0
  afterScroll();
}

function afterScroll() { renderer.invalidateAll(); dirty = true; showSbIndicator(); updateScrollRail(); }
function snapToLive() {
  if (term.isLive()) return;
  term.scrollbackEnd(); renderer.invalidateAll(); dirty = true; showSbIndicator();
  updateScrollRail();
}

// Is focus in something the user is TYPING INTO? Narrower than isFormField()
// on purpose and not a variant of it: that one counts a BUTTON, which is what
// holds focus straight after any toolbar press, so gating a live carrier on it
// would stop keystrokes reaching the BBS from the first button click onward.
// This asks only whether the element takes text, which is the actual question.
function isTextEntry(el) {
  if (!el || el === canvas) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === 'TEXTAREA') return true;
  if (el.tagName !== 'INPUT') return false;
  const t = String(el.type || 'text').toLowerCase();
  return t !== 'button' && t !== 'submit' && t !== 'reset' &&
         t !== 'checkbox' && t !== 'radio' && t !== 'file';
}

// Is focus somewhere that owns the keyboard in its own right?
function isFormField(el) {
  if (!el || el === canvas) return false;
  if (el.isContentEditable) return true;
  return ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].indexOf(el.tagName) >= 0;
}

function onKey(e) {
  // Scrollback navigation works whether or not a carrier is up (review history
  // after a call too), but only when scrollback is enabled.
  //
  // Everything here is on ALT, which used to be Shift for the arrows and
  // Home/End and bare PageUp/PageDown for a screen. Those bindings each shadowed
  // a sequence the BBS is entitled to receive: bare PageUp/PageDown never
  // reached a board by any route from a real keyboard, and Shift+arrows had no
  // way to send `ESC [ 1 ; 2 A`. Alt is free — keyToSeq returns null for it —
  // so moving the whole set here frees Shift and the page keys outright.
  //   Alt+PgUp/PgDn = one screen · Alt+Up/Down = three lines · Alt+Home/End = top / live
  if (scrollbackEnabled && e.altKey && !e.ctrlKey && !e.metaKey) {
    if (e.key === 'PageUp')    { e.preventDefault(); term.scrollbackUp(ROWS - 1);   afterScroll(); return; }
    if (e.key === 'PageDown')  { e.preventDefault(); term.scrollbackDown(ROWS - 1); afterScroll(); return; }
    if (e.key === 'ArrowUp')   { e.preventDefault(); term.scrollbackUp(3);          afterScroll(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); term.scrollbackDown(3);        afterScroll(); return; }
    if (e.key === 'Home')      { e.preventDefault(); term.scrollbackHome();         afterScroll(); return; }
    if (e.key === 'End')       { e.preventDefault(); term.scrollbackEnd();          afterScroll(); return; }
  }

  const seq = keyToSeq(e);
  if (seq === null) return;
  // Offline the same keystrokes edit the AT command line instead of going down
  // the wire. Only consume the key if the command line actually took it, so the
  // arrow/function keys it ignores still do whatever the browser does with them.
  if (!carrier) {
    if (dialing || !atInput(seq)) return;
    e.preventDefault();
    snapToLive();
    return;
  }
  e.preventDefault();
  snapToLive();          // any real keystroke returns to the live view
  modemWrite(seq);
}
canvas.addEventListener('keydown', onKey);
window.addEventListener('keydown', (e) => {
  if (document.activeElement === canvas) return;
  // Allow scrollback keys and (with carrier) typing even when the canvas isn't
  // focused. Scrollback is Alt-modified now, so this is the same set as onKey's.
  const nav = e.altKey && !e.ctrlKey && !e.metaKey &&
    (e.key === 'PageUp' || e.key === 'PageDown' || e.key === 'ArrowUp' ||
     e.key === 'ArrowDown' || e.key === 'Home' || e.key === 'End');
  // Command mode gets the same courtesy as a live carrier — you can type ATDT
  // without clicking the terminal first — but never out of a form control the
  // user is actually typing into (the manual host:port field, the BBS select).
  const cmd = atCommandMode() && !isFormField(document.activeElement);
  // A carrier used to claim every keystroke on the page outright, so a field the
  // user had deliberately clicked into stayed empty while what they typed went
  // down the wire — the paste box, and the manual host:port field before it.
  // Typing into a text field is never meant for the BBS.
  if (nav || (carrier && !isTextEntry(document.activeElement)) || cmd) onKey(e);
});
canvas.addEventListener('click', () => canvas.focus());

// Mouse wheel: scroll through history when there's any; otherwise ignore.
canvas.addEventListener('wheel', (e) => {
  if (!scrollbackEnabled || term.scrollbackLength === 0) return;
  e.preventDefault();
  const lines = Math.max(1, Math.ceil(Math.abs(e.deltaY) / 24));
  if (e.deltaY < 0) term.scrollbackUp(lines); else term.scrollbackDown(lines);
  afterScroll();
}, { passive: false });

// ─── One-finger zoom (touch) ────────────────────────────────────────────────
// A magnifier for mobile: touch the terminal, it jumps to 2x centred on the
// terminal's middle, then tracks your finger; lift to return. DISPLAY-only — a
// CSS transform on the canvas, so no repaint and no cache churn, and it is
// automatically correct for whatever font is active.
//
// Mapping is RELATIVE from the middle, so the press point is yours to choose:
// press bottom-right to read top-left and your finger stays clear of the text.
// An absolute mapping tied the press point to the content, which meant corners
// could only be reached with the finger sitting on them.
//
// Sensitivity is expressed as SWEEP — the fraction of the terminal a finger
// must travel to pan from middle to edge — because that is magnification-
// independent, where a fixed gain would need more travel at a higher zoom:
//
//   gain = (0.5 - visibleFraction/2) / SWEEP
//
// visibleFraction comes from the real viewport rather than 1/Z: the terminal
// fills the viewport on one axis and letterboxes on the other, so the two axes
// hide different amounts and would otherwise sweep differently.
//
// Steadiness is two problems: touchdown wobble, held off by PAN_SLOP until the
// drag is deliberate, and tracking jitter, low-passed by a short CSS transition
// on the compositor. A dead zone would fix neither — it would only make
// tracking move in steps.
//
// Gesture ownership follows the scrollback toggle, since a pan and a
// scroll-swipe are the same motion: scrollback off, touch zooms; scrollback on,
// a drag scrolls and zoom needs a press-and-hold. 0 is the OFF setting.
const ZOOM_LEVELS = [2, 3, 0];
let zoomLevel = Number.isInteger(prefs.get('zoomLevel'))
  && prefs.get('zoomLevel') >= 0 && prefs.get('zoomLevel') < 3
  ? prefs.get('zoomLevel') : 0;   // index into ZOOM_LEVELS
const zoomFactor = () => ZOOM_LEVELS[zoomLevel];
// Zoom and scrollback are mutually exclusive: a pan and a scroll-swipe are the
// same motion, so only one of them may own a drag. Scrollback wins while it is
// on, and `zoomLevel` is left untouched underneath — turning scrollback back off
// restores whatever magnification the user had chosen, rather than resetting it.
const zoomSuppressed = () => scrollbackEnabled;
const zoomEnabled = () => !zoomSuppressed() && zoomFactor() > 0;
// With scrollback off AND zoom off, nothing on the terminal claims a gesture,
// so the canvas has no business swallowing them: `touch-action:none` and the
// touchstart preventDefault below exist to protect the zoom-pan and the
// scrollback swipe, and with both gone they only cost the user the browser's
// own pinch-zoom and pan. This predicate hands those back — see the
// `body.gestures-free` rule in index.html for why the CSS half has to be a
// class set ahead of time rather than a style written at gesture time.
const gesturesFree = () => !scrollbackEnabled && zoomFactor() <= 0;
const HOLD_MS = 300;     // press-and-hold to zoom when swipe owns the drag
const HOLD_SLOP = 10;    // px of movement that cancels the hold (it's a swipe)
// Pan feel — tune these three freely, they don't interact with anything else.
const PAN_SWEEP_X = 1 / 6;  // finger travel, as a fraction of the terminal,
const PAN_SWEEP_Y = 1 / 6;  // to pan from the middle to an edge (see above)
const PAN_SLOP = 8;      // px of travel before panning engages (touchdown wobble)
const PAN_SMOOTH_MS = 90;// transform transition once panning; 0 disables smoothing

// Hooks into the on-screen keyboard, which is built further down (its state
// lives in that IIFE). Set there; the stubs keep the touch handler safe if the
// keyboard is ever removed.
let keyboardIsOpen = () => true;   // "already open" ⇒ touch behaves as before
let openKeyboard = () => {};

let zoomActive = false, zoomBase = null, zoomHinted = false;
let _holdTimer = null, _holdX = 0, _holdY = 0;
let _panEngaged = false, _panAnchorX = 0, _panAnchorY = 0;

// Scrollback and zoom are mutually exclusive (see updateZoomUI), so whenever
// scrollback is on the drag is a scroll and zoom is unreachable — no press-and-
// hold arbitration is needed. Kept as a named predicate because the touch
// handler reads better for it, and because `scrollbackLength === 0` still means
// there is nothing to scroll, so a touch may as well do nothing rather than
// wait out the hold timer.
const swipeOwnsDrag = () => scrollbackEnabled && term.scrollbackLength > 0;

function cancelHold() { if (_holdTimer) { clearTimeout(_holdTimer); _holdTimer = null; } }

function zoomOn(px, py) {
  if (zoomActive || !zoomEnabled()) return;
  // Measure BEFORE transforming — this is the untransformed layout box that all
  // the pan maths is expressed in.
  const r = canvas.getBoundingClientRect();
  zoomBase = { l: r.left, t: r.top, w: r.width, h: r.height };
  zoomActive = true;
  _panEngaged = false; _panAnchorX = px; _panAnchorY = py;
  canvas.style.transition = 'none';   // the initial placement must be instant
  zoomTo(0.5, 0.5);                   // open on the middle, whatever was pressed
  if (!zoomHinted) { zoomHinted = true; showToast(`Zoom ${zoomFactor()}× — drag to pan`); }
}

// u, v are the fraction of the terminal to show centred (0..1).
function zoomTo(uRaw, vRaw) {
  if (!zoomActive) return;
  const b = zoomBase, wr = wrap.getBoundingClientRect();
  const u = Math.min(1, Math.max(0, uRaw));
  const v = Math.min(1, Math.max(0, vRaw));
  const Z = zoomFactor();
  const sw = b.w * Z, sh = b.h * Z;
  // Put that point at the centre of the viewport. transform-origin is 0 0, so
  // a local point p lands at (b.l + t + Z * p).
  let tx = (wr.left + wr.width  / 2) - b.l - Z * u * b.w;
  let ty = (wr.top  + wr.height / 2) - b.t - Z * v * b.h;
  // Clamp so the scaled canvas always covers the viewport — without this the
  // edges pull inward and you get black gutters at the extremes.
  if (sw >= wr.width) {
    tx = Math.min(wr.left - b.l, Math.max(wr.right - b.l - sw, tx));
  } else {
    tx = (wr.left + (wr.width - sw) / 2) - b.l;   // narrower than the box: centre it
  }
  if (sh >= wr.height) {
    ty = Math.min(wr.top - b.t, Math.max(wr.bottom - b.t - sh, ty));
  } else {
    ty = (wr.top + (wr.height - sh) / 2) - b.t;
  }
  canvas.style.transform = `translate(${tx}px, ${ty}px) scale(${Z})`;
}

function zoomOff() {
  cancelHold();
  if (!zoomActive) return;
  zoomActive = false; zoomBase = null; _panEngaged = false;
  canvas.style.transition = 'none';
  canvas.style.transform = '';
}

// Pan updates, gated on the finger having actually moved. Until it has, the
// view stays exactly where it was placed on touchdown.
function zoomPan(px, py) {
  if (!_panEngaged) {
    if (Math.hypot(px - _panAnchorX, py - _panAnchorY) <= PAN_SLOP) return;
    _panEngaged = true;
    // Smoothing goes on only now, so touchdown stays snappy and the drag is
    // filtered. Setting it here also eases the small step at engage.
    if (PAN_SMOOTH_MS > 0) canvas.style.transition = `transform ${PAN_SMOOTH_MS}ms linear`;
  }
  // Relative to the press point, starting from the middle of the terminal.
  // kx/ky are how far from centre the pan can actually travel before it clamps,
  // measured against this viewport — 0 when the axis has nothing hidden to pan.
  const b = zoomBase, wr = wrap.getBoundingClientRect(), Z = zoomFactor();
  const kx = Math.max(0, 0.5 - wr.width  / (2 * Z * b.w));
  const ky = Math.max(0, 0.5 - wr.height / (2 * Z * b.h));
  zoomTo(0.5 + ((px - _panAnchorX) / b.w) * (kx / PAN_SWEEP_X),
         0.5 + ((py - _panAnchorY) / b.h) * (ky / PAN_SWEEP_Y));
}

// Touch: zoom-pan, and/or scroll history on vertical drags.
let _touchY = 0;
canvas.addEventListener('touchstart', (e) => {
  if (e.touches.length !== 1) { zoomOff(); return; }   // second finger: bail out
  const t = e.touches[0];
  _touchY = t.clientY; _holdX = t.clientX; _holdY = t.clientY;
  // First touch with the on-screen keyboard closed opens it instead of zooming.
  // On a phone that's overwhelmingly what a tap on the terminal means — you want
  // to type — and the magnifier firing instead was the surprising outcome. Touch
  // again (keyboard now open) and you get the zoom as usual.
  //
  // The preventDefault is skipped when no gesture is owned (gesturesFree) —
  // there the touch belongs to the browser, and swallowing it would block the
  // very pan/pinch the free mode exists to allow. Opening the keyboard still
  // happens either way; only the suppression of the synthetic click is given up.
  if (!keyboardIsOpen()) {
    if (!gesturesFree()) e.preventDefault();
    openKeyboard();
    showToast(zoomEnabled() ? 'Keyboard enabled. Touch again to zoom'
                            : 'Keyboard enabled');
    return;
  }
  // Nothing owns this gesture: leave it entirely to the browser. zoomOn() would
  // no-op anyway (zoomEnabled() is false), so the only thing to undo is the
  // preventDefault, which is what was blocking the native pan and pinch.
  if (gesturesFree()) return;
  if (!swipeOwnsDrag()) {
    e.preventDefault();          // also suppresses the synthetic click/focus
    zoomOn(t.clientX, t.clientY);
  } else {
    _holdTimer = setTimeout(() => { _holdTimer = null; zoomOn(_holdX, _holdY); }, HOLD_MS);
  }
}, { passive: false });

canvas.addEventListener('touchmove', (e) => {
  if (e.touches.length !== 1) { zoomOff(); return; }
  const t = e.touches[0];
  if (zoomActive) { e.preventDefault(); zoomPan(t.clientX, t.clientY); return; }
  // Moving before the hold fires means this is a swipe, not a press.
  if (_holdTimer && Math.hypot(t.clientX - _holdX, t.clientY - _holdY) > HOLD_SLOP) cancelHold();
  if (!scrollbackEnabled || term.scrollbackLength === 0) return;
  const dy = _touchY - t.clientY;
  if (Math.abs(dy) > 15) {
    e.preventDefault();
    if (dy > 0) term.scrollbackUp(1); else term.scrollbackDown(1);
    _touchY = t.clientY;
    afterScroll();
  }
}, { passive: false });

canvas.addEventListener('touchend', zoomOff);
canvas.addEventListener('touchcancel', zoomOff);

// ─── Mouse selection, URL and menu-key clicks ────────────────────────────────
// terminal.js has always carried getSelectionText() and renderer.js the
// selection overlay; nothing wired them, so both sat unreachable from the port
// onwards. This is that wiring.
//
// DESKTOP AND MOUSE ONLY, structurally rather than by filtering: everything
// below is reached from the mouse path, and touch has its own (keyboard-first,
// hold-to-zoom, swipe-to-scroll) which is not touched. isMobile() still guards
// the entry, because a tap synthesises a mousedown and gesturesFree() is a
// reachable state on a phone, so the synthetic press really can arrive here.
//
// There is no second gesture arbiter. Zoom sits ahead of this in
// terminalPressActions, so while the magnifier is enabled it claims the drag
// and selection never sees one; zoomEnabled() remains the single rule.

const SEL_HOLD_MS = 350;   // how long a copied selection stays lit before clearing

let selecting = false;                  // a button is down and a drag may be forming
let selClearTimer = null;
let lastKeyCol = -1, lastKeyRow = -1;   // the menu key clicked without moving off it

const mouseSelectable = () => !isMobile() && !zoomEnabled();

// The click that brings the window back from somewhere else means "I am looking
// at this again", not "press Enter" — alt-tabbing back should not cost the BBS
// a keystroke. The window's focus event lands before the mousedown that caused
// it, so a flag set there and consumed by that release is enough. It expires so
// an unrelated click a minute later is a real click again, and only the
// fallback Enter honours it: clicking a URL or a menu key is unambiguous
// whatever the window was doing beforehand.
const REFOCUS_MS = 700;
let refocusPress = false, refocusTimer = null;
window.addEventListener('focus', () => {
  refocusPress = true;
  clearTimeout(refocusTimer);
  refocusTimer = setTimeout(() => { refocusPress = false; }, REFOCUS_MS);
});

// Client point → [col, row]. The CSS box and the backing store are different
// sizes on the hybrid path (fitTerminal sizes them separately and deliberately),
// so the point is normalised into device pixels before the renderer maps it —
// and the renderer maps it, because the per-column edge table lives there.
function cellFromEvent(e) {
  const r = canvas.getBoundingClientRect();
  if (!r.width || !r.height) return [0, 0];
  return renderer.cellAt((e.clientX - r.left) * (canvas.width  / r.width),
                         (e.clientY - r.top)  * (canvas.height / r.height));
}

// The row under the pointer AS DISPLAYED. Scrolled back, the live screen holds
// different text at the same row number, so a click that reads the live screen
// acts on something the user cannot see. getSelectionText() already resolved
// this for copy; these two resolve it for clicking.
function displayRow(row) {
  const cells = term.getDisplayCells();
  const out = new Array(COLS);
  for (let c = 0; c < COLS; c++) out[c] = cells[row * COLS + c] || null;
  return out;
}
const rowByte = (cells, c) => (c >= 0 && c < COLS && cells[c]) ? cells[c].ch : -1;

// Is this cell blank — nothing drawn in it? A space is not in the charset's
// blank() predicate, which is about positions with no CHARACTER at all
// (.notdef), so it is named alongside it here. An unwritten cell counts too:
// most of a BBS screen has never been written to.
function cellIsEmpty(cells, col) {
  const b = rowByte(cells, col);
  return b < 0 || b === 0x20 || charsetOf(activeFont).blank(b);
}

// URLs are read as raw bytes rather than through a charset table: both shipped
// encodings agree below 0x80 and neither can spell a URL above it, so this is
// correct on a CP437 board and on an Amiga board without asking which it is.
const URL_RE = /https?:\/\/[^\s\x00-\x1F\x7F]+/g;
function urlAt(cells, col) {
  let line = '';
  for (let c = 0; c < COLS; c++) {
    const b = rowByte(cells, c);
    line += (b >= 32 && b < 127) ? String.fromCharCode(b) : ' ';
  }
  URL_RE.lastIndex = 0;
  let m;
  while ((m = URL_RE.exec(line)) !== null) {
    if (col >= m.index && col < m.index + m[0].length) return m[0];
  }
  return null;
}

// Is this cell a single-key click target? Two patterns, and the first is the
// whole trick:
//
//   1. an alphanumeric whose horizontal neighbours are NOT alphanumeric —
//      [L]ogin, (A)bort, 1. New game, Q.uit. The neighbours need only be
//      something else, so brackets, punctuation, spaces and box drawing all
//      delimit, and no bracket convention is parsed at all.
//   2. a non-alphanumeric wrapped in literal square brackets — [%] [!] [?].
//      Deliberately narrow, so prose ("the % symbol") stays inert.
//
// It classifies ASCII, which both charsets share, so a board served Topaz
// classifies identically to one on CP437.
const isAlnum = (b) => (b >= 48 && b <= 57) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122);
function menuKeyAt(cells, col) {
  const b = rowByte(cells, col);
  if (b < 0) return null;
  const l = rowByte(cells, col - 1), r = rowByte(cells, col + 1);
  if (isAlnum(b)) return (!isAlnum(l) && !isAlnum(r)) ? b : null;
  return (l === 0x5B && r === 0x5D) ? b : null;     // '[' ']'
}

function clearSelection() {
  if (selClearTimer) { clearTimeout(selClearTimer); selClearTimer = null; }
  if (!selection) return;
  renderer.invalidateSelection(selection.start, selection.end);
  selection = null;
  dirty = true;
}

// Selection tracks on the window so a drag that leaves the canvas keeps
// extending, which is the same reason zoom's pan and release do.
window.addEventListener('mousemove', (e) => {
  if (!selecting || !selection) return;
  const [col, row] = cellFromEvent(e);
  if (selection.end[0] === row && selection.end[1] === col) return;
  selection = { start: selection.start, end: [row, col] };
  dirty = true;
});

// Pointer shape says what a click would do. Held still mid-drag, where the
// answer is "extend the selection" and a changing cursor is only noise.
canvas.addEventListener('mousemove', (e) => {
  if (!mouseSelectable()) { canvas.style.cursor = ''; return; }
  if (selecting) return;
  const [col, row] = cellFromEvent(e);
  // Moving off the last-clicked key forgets it, so the click-again-for-Enter
  // shortcut only fires for a genuine second press on the same character.
  if (col !== lastKeyCol || row !== lastKeyRow) { lastKeyCol = -1; lastKeyRow = -1; }
  const cells = displayRow(row);
  canvas.style.cursor = (urlAt(cells, col) || menuKeyAt(cells, col) !== null)
    ? 'pointer' : '';
});

window.addEventListener('mouseup', () => {
  if (!selecting) return;
  selecting = false;
  const start = selection && selection.start, end = selection && selection.end;
  if (!start || !end) { clearSelection(); return; }

  if (start[0] !== end[0] || start[1] !== end[1]) {
    // A real drag. Copy, hold the highlight briefly as the confirmation that it
    // happened, then drop it. Nothing is sent — a selection is not a click.
    // The charset comes from the active font, or an Amiga board's high bytes
    // reach the clipboard read through the wrong table.
    const text = term.getSelectionText(start, end, charsetOf(activeFont).chars);
    if (text.trim() && navigator.clipboard) {
      navigator.clipboard.writeText(text).catch(() => {});
    }
    dirty = true;
    selClearTimer = setTimeout(() => { selClearTimer = null; clearSelection(); }, SEL_HOLD_MS);
    return;
  }

  // Not a drag, so it is a click, and it acts on where the press LANDED.
  clearSelection();
  const refocus = refocusPress;      // consumed by this release either way
  refocusPress = false;
  const [row, col] = start;
  const cells = displayRow(row);

  const url = urlAt(cells, col);
  if (url) { lastKeyCol = -1; lastKeyRow = -1; window.open(url, '_blank', 'noopener,noreferrer'); return; }

  // Everything from here sends, so it returns to the live view first — exactly
  // what a keystroke does, and for the same reason.
  const key = menuKeyAt(cells, col);
  const repeatKey = key !== null && col === lastKeyCol && row === lastKeyRow;
  if (key !== null && !repeatKey) {
    lastKeyCol = col; lastKeyRow = row;
    snapToLive();
    modemWrite(Uint8Array.of(key));   // the RAW byte: decoding it first would
    return;                           // mangle anything above 0x7F
  }

  lastKeyCol = -1; lastKeyRow = -1;
  if (refocus) return;                // the click that brought the window back

  // Clicking the same key twice without moving off it confirms it, and a click
  // on BLANK screen is Enter as well: much of a BBS takes one to proceed and a
  // mouse has no other way to give it one. A click that landed on a character
  // which is not a menu key sends nothing at all — it is a near miss on the key
  // beside it, and answering a miss with Enter is how a menu gets a choice its
  // user did not make.
  if (!repeatKey && !cellIsEmpty(cells, col)) return;
  snapToLive();
  modemWrite('\r');
});

// ─── Desktop press path ──────────────────────────────────────────────────────
// A LIST, not a handler. The terminal will want select-and-copy and
// click-to-follow-URL later, and once there is more than one thing a press can
// mean, ordering is the only thing to think about — so the ordering is the data
// structure. Each entry claims the press by returning true.
//
// Touch is deliberately NOT routed through here: its arbitration
// (keyboard-first, hold-to-zoom, swipe-to-scroll) is a different problem with a
// different answer, and merging them would make both harder to reason about.
const terminalPressActions = [
  {
    // The magnifier. Without a press path a mouse had no gesture that could
    // open it: switching scrollback off releases the 2x/3x button, and then
    // nothing could act on it. The exclusivity rule is untouched — zoomEnabled()
    // is still the one arbiter, on every device.
    name: 'zoom',
    test: () => zoomEnabled(),
    press: (e) => { zoomOn(e.clientX, e.clientY); return true; },
  },
  {
    // Select-and-copy, and the click actions that share its press. AFTER zoom,
    // so the magnifier keeps the drag wherever it is enabled and this only ever
    // runs in its absence. Claims every press it is offered — which is what
    // gives the canvas focus on any terminal click, so typing goes straight
    // through the canvas keydown path rather than the window-level fallback.
    name: 'select',
    test: () => mouseSelectable(),
    press: (e) => {
      clearSelection();
      const [col, row] = cellFromEvent(e);
      selection = { start: [row, col], end: [row, col] };
      selecting = true;
      dirty = true;
      return true;
    },
  },
];

canvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  for (const a of terminalPressActions) {
    if (a.test() && a.press(e)) { e.preventDefault(); canvas.focus(); return; }
  }
});
// Pan and release track on the window: a drag that leaves the canvas must still
// pan, and a mouseup outside it must still close the magnifier.
window.addEventListener('mousemove', (e) => { if (zoomActive) zoomPan(e.clientX, e.clientY); });
window.addEventListener('mouseup', () => { if (zoomActive) zoomOff(); });

// Scrollback enable/disable toggle (📜). When off, wheel/swipe/Page keys are
// ignored so an accidental swipe won't scroll. State shown on the button + a toast.
const scrollToggle = $('scrolltoggle');
function updateScrollbackUI() {
  scrollToggle.classList.toggle('on', scrollbackEnabled);
  // Off gets the same crossed-out sign the zoom button uses, for the same
  // reason: an unlit button says only "not active", which is what this one
  // looked like whether scrollback was switched off or merely had nothing to
  // scroll yet. The sign says the gesture is not available at all. Both icons
  // share one rule set in index.html.
  const icon = scrollToggle.querySelector('.kbdicon');
  if (icon) icon.classList.toggle('off', !scrollbackEnabled);
  scrollToggle.title = scrollbackEnabled
    ? 'Scrollback ON — reviewing terminal history (mouse wheel, swipe, Page keys)'
    : 'Scrollback OFF — wheel, swipe and Page keys are ignored';
  updateScrollRail();          // the rail belongs to scrollback; it goes with it
}
scrollToggle.addEventListener('click', () => {
  scrollbackEnabled = !scrollbackEnabled;
  if (!scrollbackEnabled) snapToLive();       // return to the live view when turning it off
  updateScrollbackUI();
  // Zoom is disabled for as long as scrollback is on, and comes back at the
  // user's chosen magnification when it goes off. Turning scrollback on with a
  // zoom already open must also drop that zoom, or the terminal stays magnified
  // with no gesture left that can pan or dismiss it.
  if (scrollbackEnabled) zoomOff();
  updateZoomUI();
  prefs.set('scrollback', scrollbackEnabled);
  showToast(scrollbackEnabled ? 'Scrollback ON — zoom disabled'
                              : (zoomFactor() > 0 ? `Scrollback OFF — zoom ${zoomFactor()}×`
                                                  : 'Scrollback OFF'));
});
// updateZoomUI() is deliberately NOT called here: it runs once further down,
// after `zoomToggle` exists, and reads scrollbackEnabled at that point.
updateScrollbackUI();

// ─── Fullscreen toggle (⛶) ───────────────────────────────────────────────────
// Hides the browser chrome — the reliable way to reclaim address-bar space,
// especially in mobile landscape. Needs a user gesture (this click). Not every
// mobile browser supports element fullscreen (iOS Safari notably), so degrade
// gracefully with a toast.
const fsToggle = $('fstoggle');
const fsActive = () => !!(document.fullscreenElement || document.webkitFullscreenElement);
function updateFsUI() { fsToggle.classList.toggle('on', fsActive()); }
fsToggle.addEventListener('click', async () => {
  try {
    if (!fsActive()) {
      const el = document.documentElement;
      const req = el.requestFullscreen || el.webkitRequestFullscreen;
      if (!req) throw new Error('unsupported');
      await req.call(el);
    } else {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit) await exit.call(document);
    }
  } catch (_) {
    showToast('Fullscreen unavailable');
  }
});
document.addEventListener('fullscreenchange', () => { updateFsUI(); fitTerminal(); });
document.addEventListener('webkitfullscreenchange', () => { updateFsUI(); fitTerminal(); });
updateFsUI();

// ─── Terminal font cycle (Aa) ────────────────────────────────────────────────
// Cell height differs per font, so a switch re-sizes the backing canvas and
// changes the aspect ratio — hence the fitTerminal() after each change.
//
// THE CYCLE IS THREE SLOTS, NOT A LIST OF FONTS. cycleFonts(mobile) resolves
// the registry's visible entries against the current screen, substituting a
// slot's device variant where it has one ("Modern" is Flexi False 1.60 wide
// and Flexi True narrow). Read the block at the top of fonts/index.js before
// changing anything here.
//
// The list is the same LENGTH and ORDER on every device, which is the property
// this file depends on: `fontIndex` is an index into a SLOT, so it stays valid
// across a rotation and only the font behind it changes. Nothing here needs to
// know which slots have variants.
let fontIndex = cycleIndexById(activeFont.id, isMobile());
// A stored font counts as a past choice, so a reload doesn't undo it on the next
// breakpoint crossing.
let fontChosenByUser = !!storedFontId;
const fontToggle = $('fonttoggle');

/** The fonts behind the three slots, for THIS screen. Re-read, never cached. */
function cycle() { return cycleFonts(isMobile()); }
function currentFont() { return cycle()[fontIndex]; }

function applyFont(font) {
  if (!renderer.setFont(font)) return;   // no-op if it's already active
  const prevCols = COLS;
  activeFont = font;
  COLS = fontCols(font);
  if (COLS !== prevCols) {
    // A column change is a different terminal, not just a different typeface —
    // but the session survives it. term.reflow() re-wraps the screen AND the
    // scrollback to the new width rather than reallocating a blank buffer the
    // way resize() does, so switching 80 ⇄ 40 keeps what is on screen readable.
    //
    // Scrollback carries this even when the UI toggle is off: the toggle gates
    // *navigation*, not capture — the ring is always filling — so the history a
    // re-flow needs is there whether or not the user can scroll to it.
    term.reflow(COLS, ROWS);
    renderer.resize(COLS, ROWS);   // also re-drops the caches setFont just dropped
    snapToLive();
  }
  fitTerminal();        // aspect changed with the cell metrics
  dirty = true;         // force a full repaint: setFont dropped the cell cache
}

// What the server needs to be told about the window. Sent with the dial
// message, which is the ONLY moment it can be sent: once a carrier is up
// nothing but modulated audio crosses the socket (README / PROTOCOLS.md), so
// there is no side channel for a live resize. Changing columns mid-call
// therefore resizes this end only, and the BBS learns on the next dial.
function windowSize() { return { cols: COLS, rows: ROWS }; }

// Reads `activeFont`, NOT currentFont(). They are the same thing except in one
// case that matters: when an outline font's file fails to load the renderer
// falls back to a bitmap that is deliberately NOT in the cycle, and the button
// must then describe what is actually on screen rather than the slot the user
// last pressed.
// ─── Board font overrides (config/altfonts.txt) ─────────────────────────────
//
// A few boards are not drawn against CP437. An Amiga board's art is cut against
// Topaz and its high bytes are ISO-8859-1, so the same stream that is a logo
// there is a hail of guillemets and fractions here. The operator names such a
// board in config/altfonts.txt and the server serves the map at /altfonts.json;
// one font id settles the typeface, the encoding AND the column count, because
// a registry entry carries all three.
//
// WHY THE MAP IS HELD RATHER THAN QUERIED. The column count has to be known
// before the dial message goes out — windowSize() rides along with it and there
// is no side channel once a carrier is up. Holding the map means the font is
// already applied by the time connect() builds that message.
//
// It is NOT a preference and nothing here writes one. The user's own font comes
// back when the call ends, and on the next load regardless — the same rule
// `connect=auto` follows for the speaker.
let altFontMap = {};
let altFontActive = null;    // the override in force, or null
let altFontPrev = null;      // the font to put back when the call ends

async function loadAltFonts() {
  try {
    const m = await (await fetch('/altfonts.json')).json();
    if (m && typeof m === 'object') altFontMap = m;
  } catch (_) { /* no map, no overrides — every board keeps the user's font */ }
}

/** The override for a destination, or null. host:port beats a bare host. */
function altFontFor(host, port) {
  const h = String(host || '').trim().toLowerCase();
  if (!h) return null;
  const id = altFontMap[`${h}:${parseInt(port, 10) || 23}`] || altFontMap[h];
  // An id no font answers to leaves the board on the user's own font. The
  // server deliberately does not validate ids — it has no view of this registry
  // — so a typo in the config lands here, and landing here must be harmless.
  return id ? (FONTS.find((f) => f.id === id) || null) : null;
}

/** Called from connect(), before the dial message is built. */
function beginAltFont(host, port) {
  const f = altFontFor(host, port);
  if (!f || f === activeFont) return;
  altFontPrev = activeFont;          // the font actually on screen, not the slot
  altFontActive = f;
  applyFont(f);
  updateFontUI();
  showToast(`${fontLabel(f)} font — this board is drawn for it`);
}

/** Called from cleanup(), so it runs for a hang-up, a drop and a failed dial. */
function endAltFont() {
  if (!altFontActive) return;
  const back = altFontPrev;
  altFontActive = altFontPrev = null;
  if (back) applyFont(back);
  updateFontUI();
}

function updateFontUI() {
  const f = activeFont;
  // Lit whenever we're off THIS DEVICE's default. Comparing against a single
  // DEFAULT_FONT_ID stopped working when the default became device-dependent:
  // a phone on its own default would have shown as "changed" forever.
  fontToggle.classList.toggle('on', f.id !== deviceDefaultFont(isMobile()).id);
  // SAME WORDING AS THE TOAST. The tooltip used to append the technical name —
  // `Font: Modern (Flexi IBM VGA False 1.60)` — on the reasoning that it is the
  // only way to tell the two "Modern" variants apart. That is true and it is
  // not the user's problem: the slot label is the whole vocabulary the UI
  // offers, and showing a second, different name for the same thing invites the
  // question "which of these did I pick?". The technical name is still on the
  // registry entry for anyone debugging, and the toast and the tooltip now
  // agree word for word.
  fontToggle.title = altFontActive
    ? `Font: ${fontLabel(f)} — set by this board, back to yours when the call ends`
    : `Font: ${fontLabel(f)} — ${fontCols(f)} columns`;
  // Held, not disabled: a disabled button cannot explain itself, and "why is
  // this dead?" is the whole question a locked control raises.
  fontToggle.classList.toggle('held', !!altFontActive);
}

fontToggle.addEventListener('click', () => {
  // An override owns the font for the duration of the call. Say so rather than
  // cycling: the board's art is unreadable in anything else, which is why the
  // operator listed it, and a user who changed it here would see the damage
  // and blame the terminal.
  if (altFontActive) {
    showToast(`${fontLabel(activeFont)} is set by this board — yours is back on hang-up`);
    return;
  }
  fontIndex = (fontIndex + 1) % cycle().length;
  fontChosenByUser = true;
  const f = currentFont();
  applyFont(f);
  updateFontUI();
  // The FONT id is persisted, not the slot index. A slot is a position in a
  // list that may be reordered by a future release, while an id names a
  // specific file — and cycleIndexById() maps it back to a slot on load,
  // device-awarely, so a preference saved on a phone still resolves on a
  // desktop and vice versa.
  prefs.set('fontId', f.id);
  // One shape for every font, whether or not the column count moved: the slot
  // label, then the width it implies. The width is a property of the font
  // here, so it belongs in the same line rather than in an occasional extra
  // message.
  showToast(`Font: ${fontLabel(f)} — ${COLS} columns`);
});

// Crossing the mobile breakpoint (rotation, window resize) re-picks the
// automatic default — but never after the user has touched the button.
let wasMobile = isMobile();
window.addEventListener('resize', () => {
  const nowMobile = isMobile();
  if (nowMobile === wasMobile) return;
  wasMobile = nowMobile;
  if (!fontChosenByUser) {
    // No preference expressed: re-pick this device's default outright.
    const want = deviceDefaultFont(nowMobile);
    fontIndex = cycleIndexById(want.id, nowMobile);
    applyFont(want);
    updateFontUI();
    return;
  }
  // A preference HAS been expressed — but what was chosen is a SLOT, not a
  // file. If that slot has a different font on this screen, honouring the
  // choice means switching to it, not staying on the variant meant for the
  // other screen. So the index is held and the font behind it re-resolved.
  //
  // This is why the cycle's length and order must not vary by device: the held
  // index is only meaningful if it names the same slot on both sides of the
  // breakpoint.
  const want = currentFont();
  if (want.id === activeFont.id) return;
  applyFont(want);
  updateFontUI();
  // NOT persisted, and not treated as a new choice. The user picked "Modern";
  // which of its two files a rotation lands on is our decision, and writing it
  // to prefs would silently pin them to the variant that happened to be active
  // when they last turned the phone.
});
updateFontUI();

// ─── Outline (TTF) font wiring ──────────────────────────────────────────────
// An outline font's atlas cannot be built until its file arrives, so the
// renderer builds it asynchronously and calls back. Two callbacks, two cases:
//
//   onAtlasReady      the file landed. Repaint, and re-fit — the atlas is the
//                     first thing that can confirm the metrics are usable.
//
//   onFontUnavailable the file did NOT load. FONTS.md is emphatic that this
//                     falls back to a BITMAP font from the registry and NEVER
//                     to a system font: a system fallback silently substitutes
//                     different advance widths and cell metrics, so the failure
//                     presents as a terminal whose grid is subtly wrong rather
//                     than as an obvious error. Failing VISIBLY — moving the
//                     control and saying so — is the entire point.
//
// Placed here, after the font cycle, because the fallback has to drive the same
// state the Aa button drives. Reaching backwards for those from the render
// stack above would work (they hoist) but would hide the coupling.
renderer.onAtlasReady = () => { dirty = true; fitTerminal(); };
renderer.onFontUnavailable = (font, fallback) => {
  showToast(`${font.name} unavailable — using ${fallback.name}`);
  // fontIndex is deliberately LEFT ALONE, pointing at the slot that just
  // failed, so the next Aa press advances past it instead of retrying the file
  // that would not load. cycleIndexById() cannot help here — the fallback is
  // hidden and has no slot — and updateFontUI() reads activeFont, so the
  // button still names what is on screen.
  fontChosenByUser = true;          // don't let a breakpoint re-pick over this
  applyFont(fallback);
  updateFontUI();
  // Deliberately NOT persisted. The file may have been unreachable once, and
  // writing the fallback to prefs would turn a transient network failure into
  // a permanent change to the user's saved choice.
};

// ─── Zoom magnification toggle (2× / 3×) ────────────────────────────────────
// Sets how far the one-finger zoom above magnifies. Nothing else in the UI
// changes size — this only takes effect while zooming.
// Third setting (factor 0) disables the touch magnifier entirely. Its icon is a
// magnifier with a red prohibition sign drawn over it in CSS (see #zoomtoggle
// .zoomicon.off in index.html) — the emoji underneath doesn't follow the amber /
// green button colours, but the off state is never lit, so that costs nothing.
const zoomToggle = $('zoomtoggle');

function updateZoomUI() {
  const z = zoomFactor();
  const icon = zoomToggle.querySelector('.zoomicon');
  // Lit when above the default magnification, matching the other toggles. The
  // off state is deliberately unlit.
  zoomToggle.classList.toggle('on', zoomLevel === 1 && !zoomSuppressed());
  icon.classList.toggle('off', !zoomEnabled());
  icon.textContent = zoomEnabled() ? `${z}×` : '\u{1F50D}';
  // Suppressed by scrollback: the button goes to the same crossed-out magnifier
  // as the user's own off setting AND becomes unclickable, because cycling the
  // magnification while it can't fire would be a control that visibly does
  // nothing. The title says which switch to throw to get it back.
  // The one place the gesture-ownership class is written. Both switches that
  // can change the answer (this button and the scrollback toggle) already come
  // through here, so it cannot fall out of step with zoomEnabled().
  document.body.classList.toggle('gestures-free', gesturesFree());
  zoomToggle.disabled = zoomSuppressed();
  zoomToggle.title = zoomSuppressed()
    ? 'Zoom disabled while scrollback is on'
    : (zoomEnabled() ? `Zoom magnification: ${z}×` : 'Zoom disabled');
}

zoomToggle.addEventListener('click', () => {
  if (zoomSuppressed()) return;   // belt and braces; the button is disabled too
  zoomLevel = (zoomLevel + 1) % ZOOM_LEVELS.length;
  zoomOff();                      // any in-flight zoom used the old factor
  updateZoomUI();
  prefs.set('zoomLevel', zoomLevel);
  showToast(zoomEnabled()
    ? `Zoom ${zoomFactor()}× when you touch the terminal`
    : 'Zoom disabled');
});
updateZoomUI();

// ─── Page-scroll grab bar ────────────────────────────────────────────────────
// The terminal canvas sets touch-action:none (deliberately — see index.html), so
// a drag anywhere on it belongs to the zoom-pan or the scrollback swipe and can
// never scroll the page. In the two layouts that DO scroll — mobile with the
// on-screen keyboard open, and short viewports — that left the page unreachable
// by touch once the keyboard was up. This strip is the handle for it: a few
// pixels between the terminal and the keyboard, outside the canvas, with
// touch-action:pan-y so the browser scrolls natively from a drag starting here.
//
// Only the mouse needs code. It is shown only when there is actually something
// to scroll, so it doesn't take height (or invite a drag that does nothing) in
// the ordinary full-height desktop layout.
(function pageGrab() {
  const bar = $('pagegrab');
  if (!bar) return;
  const scroller = () => document.scrollingElement || document.documentElement;

  function scrollable() {
    const s = scroller();
    return s.scrollHeight - s.clientHeight > 2;
  }
  // Called from fitTerminal (every layout change) and on resize/scroll. Reads
  // the live layout rather than guessing from the breakpoint, so the short-
  // viewport case is covered by the same test as the keyboard-open one.
  updatePageGrab = () => {
    if (scrollable()) bar.removeAttribute('hidden');
    else bar.setAttribute('hidden', '');
  };
  window.addEventListener('resize', updatePageGrab);
  window.addEventListener('scroll', updatePageGrab, { passive: true });

  // Mouse drag: 1:1 with the pointer, which is what a grab handle should feel
  // like. Pointer capture keeps the drag alive when the cursor leaves the strip
  // (it is 10px tall — it will).
  let dragging = false, lastY = 0;
  bar.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') return;    // touch scrolls natively, hands off
    dragging = true; lastY = e.clientY;
    bar.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  bar.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    scroller().scrollTop -= (e.clientY - lastY);   // drag down = page moves down
    lastY = e.clientY;
  });
  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    try { bar.releasePointerCapture(e.pointerId); } catch (_) {}
  };
  bar.addEventListener('pointerup', end);
  bar.addEventListener('pointercancel', end);

  updatePageGrab();
})();

// ─── About panel (ⓘ) ─────────────────────────────────────────────────────────
// Content lives in about.html as a plain HTML fragment, fetched once on first
// open and cached. Keeping it out of index.html means the project blurb can be
// edited without going near the app markup.
(function aboutPanel() {
  const btn = $('infobtn'), modal = $('aboutmodal'), body = $('aboutbody');
  const closeBtn = $('aboutclose');
  if (!btn || !modal) return;
  let loaded = false;

  async function load() {
    if (loaded) return;
    try {
      const r = await fetch('about.html', { cache: 'no-cache' });
      if (!r.ok) throw new Error(r.status);
      body.innerHTML = await r.text();
      loaded = true;
    } catch (_) {
      body.innerHTML = `<h1>${BRAND}</h1><p>Could not load about.html.</p>`;
    }
  }
  function open() { modal.removeAttribute('hidden'); btn.classList.add('on'); load(); }
  function close() { modal.setAttribute('hidden', ''); btn.classList.remove('on'); }

  btn.addEventListener('click', () => (modal.hasAttribute('hidden') ? open() : close()));
  closeBtn.addEventListener('click', close);
  // Click the backdrop (but not the panel) to dismiss.
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hasAttribute('hidden')) { e.stopPropagation(); close(); }
  }, true);
})();

// ─── Welcome panel (every visit, until dismissed for good) ───────────────────
// The same shell as the about panel, with its text coming from welcome.html as
// a plain HTML fragment so the greeting can be reworded without touching the
// app.
//
// It shows on EVERY load, not just the first, and keeps showing until the
// visitor clicks "Don't show this again". That is the one thing that suppresses
// it permanently — closing it, pressing Get started, reloading, or dialling a
// board all leave it armed for next time, because a greeting nobody chose to
// silence is the greeting a returning visitor still wants to be able to reach.
// (The old behaviour keyed off `welcomed`, which was set merely by *opening*
// the panel; that key is now ignored, so a browser that has been here before
// sees the panel again until it opts out — deliberate, since there was no way
// to opt out before.)
//
// Precedence is unchanged and load-bearing: a shared ?connect= link suppresses
// the panel outright for that visit — that visitor gets the Connect prompt,
// which is the louder and more useful of the two — and the two are never on
// screen together. See maybeAutoConnect, which calls markWelcomed() for the
// same reason.
const WELCOMED_KEY = 'welcomeDismissed';
/** Suppress the panel from here on. The only thing that does. */
function markWelcomed() { prefs.set(WELCOMED_KEY, true); }

(function welcomePanel() {
  const modal = $('welcomemodal'), body = $('welcomebody'), closeBtn = $('welcomeclose');
  const goBtn = $('welcomego'), neverBtn = $('welcomenever');
  if (!modal || !body) { _welcomeSettle(); return; }

  function close() {
    modal.setAttribute('hidden', '');
    document.removeEventListener('keydown', onKey, true);
    // Releases the splash. Every route out of the panel goes through here, so
    // there is one place that says the greeting is done with.
    _welcomeSettle();
  }
  function onKey(e) {
    if (e.key === 'Escape' || e.key === 'Enter') { e.stopPropagation(); close(); }
  }

  async function open() {
    try {
      const r = await fetch('welcome.html', { cache: 'no-cache' });
      if (!r.ok) throw new Error(r.status);
      body.innerHTML = await r.text();
    } catch (_) {
      // The panel is a greeting, not a dependency: if its text can't be
      // fetched, say nothing at all rather than showing an error to someone on
      // their very first visit. Nothing is on screen to wait for, so release
      // the splash as if it had been closed.
      _welcomeSettle();
      return;
    }
    modal.removeAttribute('hidden');
    document.addEventListener('keydown', onKey, true);
    if (goBtn) goBtn.focus();
  }

  closeBtn && closeBtn.addEventListener('click', close);
  goBtn && goBtn.addEventListener('click', close);
  // The opt-out. Records first, then closes, so a browser that refuses storage
  // still gets the dismissal it asked for this visit.
  neverBtn && neverBtn.addEventListener('click', () => {
    markWelcomed();
    close();
    showToast('Welcome panel hidden');
  });
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

  // Every visit until dismissed for good. A shared link that will raise the
  // Connect prompt still takes precedence.
  if (!prefs.get(WELCOMED_KEY) && !(shared.connect && shared.host)) open();
  else _welcomeSettle();
})();

// ─── Share panel (⤳) ─────────────────────────────────────────────────────────
// Two links, built fresh each time the panel opens so they always describe what
// the controls say right now:
//
//   • This BBS — the current destination and modulation, with connect=1 so
//     the recipient lands in a dialling terminal rather than on a form. Anyone
//     who'd rather they didn't can delete that one parameter; it's plainly named.
//   • SynthLink — the bare page URL, no query at all, which is the "here's this
//     project" link and deliberately dials nothing.
//
// Copy uses the async clipboard API where it exists and falls back to selecting
// the field, which is also why the URL lives in a readonly <input> rather than a
// <div>: on a browser that refuses clipboard access the user can still select-all
// and copy by hand, and on mobile a tap selects the whole thing.
(function sharePanel() {
  const btn = $('sharebtn'), modal = $('sharemodal'), closeBtn = $('shareclose');
  const bbsField = $('sharebbs'), homeField = $('sharehome');
  const bbsCopy = $('sharebbscopy'), homeCopy = $('sharehomecopy');
  const bbsRow = $('sharebbsrow'), bbsNote = $('sharebbsnote');
  const autoBox = $('shareauto');
  const linkView = $('shareview-link'), embedView = $('shareview-embed');
  const embedBtn = $('shareembedbtn'), embedBack = $('embedback');
  const eHost = $('embedhost'), ePort = $('embedport'), eSpeed = $('embedspeed');
  const eConnect = $('embedconnect'), eWidth = $('embedwidth'), eHeight = $('embedheight');
  const eSnippet = $('embedsnippet'), eIframe = $('embediframe');
  const eSnippetCopy = $('embedsnippetcopy'), eIframeCopy = $('embediframecopy');
  if (!btn || !modal) return;

  function refresh() {
    const { origin, pathname } = location;
    homeField.value = `${origin}${pathname}`;
    const host = hostEl.value.trim();
    // No destination yet (the directory failed and nothing was typed) — offer the
    // home link alone rather than a link that dials the empty string.
    bbsRow.hidden = !host;
    if (!host) return;
    const port = portEl.value.trim() || '23';
    // On by default (the checkbox's `checked` attribute in index.html): someone
    // sharing a board almost always means "go and see this", and the prompt makes
    // that safe to assume — the recipient still chooses, and closing it leaves
    // them on a terminal already pointed at the board. Unticking drops the
    // parameter for a link that just sets the controls.
    const connectOnOpen = !!(autoBox && autoBox.checked);
    bbsField.value = buildShareURL(origin, pathname, {
      host, port, speed: protocolEl.value, connect: connectOnOpen,
    });
    // Names the destination only — the checkbox label above says what the link
    // does, so repeating it here would just be the same sentence twice.
    const { name } = currentDest();
    const speedLabel = (protocolEl.selectedOptions[0] || {}).textContent || '';
    bbsNote.textContent = `${name || `${host}:${port}`} · ${speedLabel}`;
  }

  async function copy(field, button) {
    field.select();
    field.setSelectionRange(0, field.value.length);   // iOS needs the explicit range
    let ok = false;
    try {
      await navigator.clipboard.writeText(field.value);
      ok = true;
    } catch (_) {
      // Clipboard API blocked (insecure origin, permission, older browser) — the
      // deprecated path still works in exactly those places.
      try { ok = document.execCommand('copy'); } catch (__) { ok = false; }
    }
    const was = button.textContent;
    button.textContent = ok ? 'copied' : 'select + copy';
    button.classList.toggle('ok', ok);
    setTimeout(() => { button.textContent = was; button.classList.remove('ok'); }, 1600);
    if (ok) showToast('Link copied');
  }

  // ── Embed builder ─────────────────────────────────────────────────────────
  // A sub-view of this modal, not a second dialog: Escape keeps meaning "close
  // the share panel" and never has to remember which layer it is on.
  const embedReady = !!(embedView && embedBtn);

  function showView(which) {
    if (!embedReady) return;
    linkView.hidden = which === 'embed';
    embedView.hidden = which !== 'embed';
  }

  // The speed menu is CLONED from the header's every time the builder opens, so
  // a protocol added to index.html reaches the wizard with nothing to update
  // here. `direct` is the one omission: telnet bypass is gated to one dial
  // server-wide per interval, so an embed dialling through it would queue behind
  // every other embed anywhere, and the queue is a silent delay.
  function fillSpeeds(selected) {
    eSpeed.textContent = '';
    for (const o of protocolEl.options) {
      if (o.value === 'direct') continue;
      const opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.textContent;
      eSpeed.appendChild(opt);
    }
    const want = selected === 'direct' ? DEFAULT_SPEED : selected;
    eSpeed.value = [...eSpeed.options].some((o) => o.value === want) ? want : DEFAULT_SPEED;
  }

  function refreshEmbed() {
    if (!embedReady) return;
    const { origin, pathname } = location;
    const opts = {
      host: eHost.value.trim(),
      port: ePort.value.trim() || '23',
      speed: eSpeed.value,
      connect: eConnect.value,
      width: eWidth.value.trim() || EMBED_WIDTH,
      height: eHeight.value.trim() || EMBED_HEIGHT,
    };
    // The element and the frame it builds come from the same origin as this
    // page — the embedder never states it, and embed.js reads it back off its
    // own URL rather than being told twice.
    const scriptSrc = `${origin}${pathname.replace(/[^/]*$/, '')}embed.js`;
    eSnippet.value = buildEmbedSnippet(scriptSrc, opts);
    eIframe.value = buildIframeSnippet(
      buildEmbedURL(origin, pathname, opts),
      { ...opts, title: document.title || 'Terminal' });
  }

  function openEmbed() {
    const { host, port } = currentDest();
    eHost.value = host;
    ePort.value = port;
    fillSpeeds(protocolEl.value);
    // A press, not an automatic dial. An embed that dialled the moment someone
    // scrolled past it would open a socket nobody asked for — and the press is
    // also the gesture that lets the AudioContext start, so the handshake is
    // heard from its first tone instead of being muted for that call.
    eConnect.value = 'prompt';
    if (!eWidth.value.trim()) eWidth.value = EMBED_WIDTH;
    if (!eHeight.value.trim()) eHeight.value = EMBED_HEIGHT;
    refreshEmbed();
    showView('embed');
  }

  function open() {
    refresh();
    showView('link');
    modal.removeAttribute('hidden');
    btn.classList.add('on');
  }
  function close() { modal.setAttribute('hidden', ''); btn.classList.remove('on'); }

  btn.addEventListener('click', () => (modal.hasAttribute('hidden') ? open() : close()));
  closeBtn.addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  bbsCopy.addEventListener('click', () => copy(bbsField, bbsCopy));
  homeCopy.addEventListener('click', () => copy(homeField, homeCopy));
  // Rebuild in place so the field shows what will be copied, without reopening.
  autoBox && autoBox.addEventListener('change', refresh);
  if (embedReady) {
    embedBtn.addEventListener('click', openEmbed);
    embedBack.addEventListener('click', () => { refresh(); showView('link'); });
    eSnippetCopy.addEventListener('click', () => copy(eSnippet, eSnippetCopy));
    eIframeCopy.addEventListener('click', () => copy(eIframe, eIframeCopy));
    for (const el of [eHost, ePort, eSpeed, eConnect, eWidth, eHeight]) {
      el.addEventListener('input', refreshEmbed);
      el.addEventListener('change', refreshEmbed);
    }
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hasAttribute('hidden')) { e.stopPropagation(); close(); }
  }, true);
})();

// ─── Paste box ───────────────────────────────────────────────────────────────
// Right-click over the terminal opens a small panel holding a real textarea.
// That textarea IS the mechanism: it takes the browser's own paste, so nothing
// here asks for clipboard permission and nothing depends on
// navigator.clipboard.readText(), which is refused outright by browsers this
// has to work on. Ctrl+V is deliberately untouched and still sends 0x16 down
// the wire, because BBS editors use it.
//
// It works with no carrier too, and that is a feature rather than an oversight:
// modemWrite() routes to the AT command line then, and atInput() already takes
// a whole string a character at a time, so pasting a host:port to dial is the
// same code path as pasting into a message editor. What is typed here goes to
// the modem VERBATIM — nothing is stripped, rewritten or normalised.
//
// The context menu is claimed on the canvas alone and only on desktop; a
// long-press on a phone keeps whatever the browser already does with it.
(function pasteBox() {
  const modal = $('pastemodal'), box = $('pastetext'), note = $('pastenote');
  const sendBtn = $('pastesend'), cancelBtn = $('pastecancel'), closeBtn = $('pasteclose');
  if (!modal || !box) return;

  // What it will cost to send. With a carrier we know the negotiated rate, so
  // say how long it will take — at 300 bps a casual paste is minutes of
  // transmission with no way to call it back, and the number is a better answer
  // than a length cap because it lets the user decide with the figure in front
  // of them. Ten bits per character is the start and stop bits included.
  function describe() {
    const n = box.value.length;
    if (!n) { note.textContent = carrier ? '' : 'No carrier — this goes to the command line.'; return; }
    const chars = `${n.toLocaleString()} character${n === 1 ? '' : 's'}`;
    if (!carrier)    { note.textContent = `${chars} · to the command line.`; return; }
    if (!carrierBps) { note.textContent = chars; return; }
    const secs = (n * 10) / carrierBps;
    const t = secs < 1 ? 'under a second'
            : secs < 60 ? `${Math.round(secs)}s`
            : `${Math.floor(secs / 60)}m ${Math.round(secs % 60)}s`;
    note.textContent = `${chars} · ≈ ${t} at ${carrierBps} bps`;
  }

  function open() {
    box.value = '';
    describe();
    modal.removeAttribute('hidden');
    box.focus();
  }
  function close() {
    modal.setAttribute('hidden', '');
    canvas.focus();          // hand the keyboard back to the terminal
  }
  function send() {
    const text = box.value;
    close();
    if (!text) return;
    snapToLive();
    modemWrite(text);
  }

  canvas.addEventListener('contextmenu', (e) => {
    if (isMobile()) return;              // no clipboard gesture to reach it with
    e.preventDefault();
    open();
  });

  sendBtn.addEventListener('click', send);
  cancelBtn.addEventListener('click', close);
  closeBtn.addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  box.addEventListener('input', describe);
  // paste fires before the value updates, so the count is read on the next tick.
  box.addEventListener('paste', () => setTimeout(describe, 0));
  // Enter sends, Shift+Enter is a newline — the textarea is multi-line on
  // purpose, since a message body is the other thing people paste into a BBS.
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); send(); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hasAttribute('hidden')) { e.stopPropagation(); close(); }
  }, true);
})();

// ─── Buttons ─────────────────────────────────────────────────────────────────
dialBtn.addEventListener('click', () => { if (dialing) hangup(); else connect(); });
extBtn.addEventListener('click', () => {
  if (!carrier) return;
  extension.trigger();
  showToast('Handset off-hook');
});
listenBtn.addEventListener('click', () => {
  monitor.ensure();
  monitor.cancelAutoFade();       // stop any in-progress connect fade
  // Touching this control during a connect=auto call is the user saying what
  // they want the speaker to do; the pending restore would overrule them on the
  // next dial, so it is dropped rather than applied.
  autoMuteRestore = null;
  const order = ['auto', 'listen', 'mute'];
  monitor.mode = order[(order.indexOf(monitor.mode) + 1) % order.length];
  // In Auto, audibility depends on call phase: audible while dialing/handshaking
  // (before the post-connect fade), silent once connected or idle.
  if (monitor.mode === 'auto') monitor.autoOn = dialing && !carrier;
  monitor._applyGain();
  updateListenUI();
  prefs.set('speaker', monitor.mode);
  showToast(`Speaker: ${LISTEN_LABEL[monitor.mode]}`);
});
protocolEl.addEventListener('change', () => {
  prefs.set('protocol', protocolEl.value);
  echoMSCommand(protocolEl.value);
});
hostportEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { commitHostPort(); connect(); } });
hostportEl.addEventListener('change', commitHostPort);

// ─── On-screen keyboard (mostly for mobile) ──────────────────────────────────
// Data-driven so it's easy to maintain: each view is rows (or, for the numpad
// view, two pads + a foot) of key defs. A key is { t:label, s:bytesToSend,
// n:namedKey, c:cssClass, u:gridUnits }; `cycle:true` advances the view,
// `mod:'ctrl'|'shift'` is a sticky modifier, and `{blank:true}` is an explicit
// empty slot — kept in the data so a missing key can simply replace it later
// without reflowing anything. One ⇧# key cycles the four views.
//
// A key carries EITHER `s` (literal bytes, used for the printable characters)
// or `n` (a name that namedSeq() resolves against the current modifier state).
// Everything non-printing uses `n`, so the on-screen and physical paths emit
// identical sequences by construction rather than by two lists agreeing.
//
// Widths are in grid units (`u`), one unit being a column of the 10-wide letter
// rows; see the .u1/.u2 rules in index.html for why that matters.
const kbdEl = $('keyboard'), kbdToggle = $('kbdtoggle');
(function buildKeyboard() {
  const chr   = (ch, c) => ({ t: ch, s: ch, c });           // a key that sends itself
  const chars = (s) => [...s].map((ch) => chr(ch));
  const fn    = (i) => ({ t: 'F' + i, n: 'F' + i, c: 'fn' });
  const nav   = (t, name) => ({ t, n: name, c: 'mod' });
  const BLANK = { blank: true };
  // Labelled for what it actually reaches — capitals, symbols, the numpad —
  // rather than for the shift key it resembles. It cycles all four views, and
  // '⇧#' read as a shift key with a stray glyph after it.
  const CYCLE = { t: '↑@#', c: 'mod', cycle: true };
  // Straight to the numpad from view 1, without three presses of ↑@#. Same
  // amber as the cycle key it sits beside, because it does the same KIND of
  // thing — it changes the panel, it does not send anything.
  const NUMPAD = { t: '#', c: 'mod', goto: 3 };
  const CTRL  = { t: 'Ctrl', c: 'ctl', mod: 'ctrl' };
  const SHFT  = { t: 'Shft', c: 'sft', mod: 'shift' };
  const SP  = { t: 'space', s: ' ', c: 'acc' };
  const ENT = { t: '⏎', n: 'Enter', c: 'acc' };
  const BK  = { t: '⌫', n: 'Backspace', c: 'mod' };
  const UP = { t: '↑', n: 'ArrowUp' }, DN = { t: '↓', n: 'ArrowDown' },
        LF = { t: '←', n: 'ArrowLeft' }, RT = { t: '→', n: 'ArrowRight' };
  const ESC = nav('Esc', 'Escape'), TAB = nav('Tab', 'Tab'), BRK = nav('BRK', 'Break');
  // Alt+numpad code entry — the period way to reach the upper CP437 range
  // (box drawing, block shading) that the renderer has always had glyphs for.
  const ALT = { t: 'Alt', c: 'alt', alt: true };
  const F = [null, fn(1), fn(2), fn(3), fn(4), fn(5), fn(6),
             fn(7), fn(8), fn(9), fn(10), fn(11), fn(12)];
  const INS = nav('Ins','Insert'), DEL = nav('Del','Delete'), HOME = nav('Home','Home'),
        END = nav('End','End'), PGUP = nav('PgUp','PageUp'), PGDN = nav('PgDn','PageDown');
  // Width variants. Every explicitly-sized row must sum to exactly 10 units.
  // The named widths exist because label length, not aesthetics, sets the floor:
  // NARROW fits a single glyph, WIDE fits a 4-character label ("Home", "Ctrl")
  // at the smallest phone width, and MID fits three ("F11", "Tab").
  const u  = (k, n) => ({ ...k, u: n });
  const u1 = (k) => u(k, 1);
  const WIDE = 1.25, MID = 1.1, NARROW = 0.9;

  const views = [
    // View 1 — letters (lowercase) + digits. Unchanged apart from the bottom
    // row now being sized in grid units so ← ↓ → land under n / m / ↑.
    { kind: 'rows', rows: [
      chars('1234567890'),
      chars('qwertyuiop'),
      chars('asdfghjkl'),
      [BK, ...chars('zxcvbnm'), UP, ENT],
      // ↑@# matches its width on the other views; the numpad shortcut is one
      // glyph, so it takes NARROW, and space takes what is left of the row.
      [u(CYCLE, WIDE), u(NUMPAD, NARROW), SP, u1(LF), u1(DN), u1(RT)],
    ]},
    // View 2 — letters (UPPERCASE) + function keys + modifiers.
    // One-shot, so space / arrows / ⏎ / ⌫ are redundant here (view 1 has them a
    // single tap away) and that freed real estate pays for Ctrl, Shft, Esc, Tab
    // and the nav cluster. Ctrl sits in view 1's ⌫ slot on purpose.
    { kind: 'rows', rows: [
      [F[1],F[2],F[3],F[4],F[5],F[6],F[7],F[8],F[9],F[10]],
      chars('QWERTYUIOP'),
      chars('ASDFGHJKL'),
      [u(CTRL, 1.5), ...chars('ZXCVBNM').map(u1), u(ESC, 1.5)],
      // Ins/Del/Home/End are not repeated here — they are on views 3 and 4, and
      // the space buys ⇧# and Shft a full WIDE each. Tab is left unsized so it
      // soaks up the remainder, the way space does on view 1.
      [u(CYCLE, WIDE), u(SHFT, WIDE), u(F[11], MID), u(F[12], MID), TAB],
    ]},
    // View 3 — symbols + modifiers + the full nav/arrow cluster. The arrows are
    // repeated here (same positions as view 1) because this is the only view
    // carrying both Ctrl and Shft, so it is where Ctrl+← (word-left) and
    // Shift+↑ can be composed. It also holds @ [ \ ] ^ _ ? — with its own Ctrl
    // that covers NUL, ESC, FS, GS, RS, US and DEL without the modifier having
    // to survive a view change. Cols 6–7 of both rows are reserved.
    { kind: 'rows', rows: [
      chars('!@#$%^&*()'),
      chars('`~-_=+[]{}'),
      chars('\\|;:\'",.<>'),
      // Eight keys per row at WIDE. The two reserved slots this row used to
      // carry are spent on width rather than left empty: at one unit the
      // 4-character labels overflowed their buttons on a phone. Column order is
      // unchanged, so PgUp still sits above ← and PgDn above →.
      [u(CTRL, WIDE), u(chr('/'), WIDE), u(chr('?'), WIDE), u(INS, WIDE),
       u(HOME, WIDE), u(PGUP, WIDE), u(UP, WIDE), u(PGDN, WIDE)],
      [u(CYCLE, WIDE), u(SHFT, WIDE), u(ESC, WIDE), u(DEL, WIDE),
       u(END, WIDE), u(LF, WIDE), u(DN, WIDE), u(RT, WIDE)],
    ]},
    // View 4 — navigation + numeric keypad. Sticky, so it keeps its own
    // space / ⏎ / ⌫ in the foot. Arrows dropped (view 3 has them with the
    // modifiers); ↑'s slot becomes BRK.
    //
    // The nav pad is rendered FIRST and the number pad second, so the digits
    // land under the thumb of a right hand holding the phone one-handed — the
    // digits are what you come to this view to type, the nav keys are the
    // occasional press.
    { kind: 'pads',
      num: [ chr('7'), chr('8'), chr('9'), chr('/','mod'),
             chr('4'), chr('5'), chr('6'), chr('*','mod'),
             chr('1'), chr('2'), chr('3'), chr('-','mod'),
             chr('='), chr('0'), chr('.'), chr('+','mod') ],   // 0 centered under 2
      nav: [ INS, HOME, PGUP,  DEL, END, PGDN,  ESC, BRK, TAB,  ALT, CTRL, SHFT ],
      foot: [ CYCLE, SP, ENT, BK ],
    },
  ];
  let view = 0;
  // Views that revert to view 0 (lowercase) after a keypress — the shift-like
  // ones. The numpad (3) is absent on purpose: it stays until you cycle out.
  const ONE_SHOT_VIEWS = [1, 2];

  // ── Sticky modifier + view-lock state machine ──────────────────────────────
  // Each modifier is 'off' | 'armed' | 'locked'. A tap toggles off↔armed; a long
  // press (see LOCK_MS) promotes to locked; a tap on either armed or locked
  // returns to off. An armed modifier is consumed by the next key, a locked one
  // survives it. Changing view clears both regardless — a panel change is a
  // clean slate, which is the least surprising rule and the one that means you
  // can never carry an invisible modifier into a view where you can't see it.
  //
  // `viewLocked` is the same idea for the shift-like views: long-press ⇧# and
  // the view you land on stops being one-shot. Kept as pure functions over an
  // explicit state object so the transitions are testable without a DOM
  // (tools/tests/kbdmodtest.js drives exactly these).
  const LOCK_MS = 550;      // hold time to promote armed → locked
  const LOCK_SLOP = 10;     // px of movement that cancels the hold

  function newModState() { return { ctrl: 'off', shift: 'off', viewLocked: false }; }
  const mods = newModState();

  // Tap: off → armed, armed → off. Tapping a LOCKED modifier releases every
  // lock at once, view lock included — one deliberate gesture to get into the
  // locked mode, one to get out of all of it.
  function modTap(st, which) {
    if (st[which] === 'locked') { modReleaseLocks(st); return; }
    st[which] = st[which] === 'off' ? 'armed' : 'off';
  }
  // Hold: promote to locked (the tap already ran on pointerdown, so by now it is
  // 'armed' — unless the tap turned it off, in which case the hold still means
  // "lock it", which is what a user holding the key wants).
  //
  // Locking a modifier MUST also lock the view. On the shift-like views a
  // keypress otherwise falls back to view 1, which strands the locked modifier
  // on a panel that neither shows its key nor offers the capitals or symbols it
  // was locked for — the lock would appear to release itself after one key.
  function modHold(st, which) { st[which] = 'locked'; st.viewLocked = true; }
  // Releasing: locks come off together, but an armed modifier is left alone —
  // it belongs to the keystroke the user is part-way through composing.
  function modReleaseLocks(st) {
    if (st.ctrl === 'locked')  st.ctrl = 'off';
    if (st.shift === 'locked') st.shift = 'off';
    st.viewLocked = false;
  }
  // Consumed by an ordinary keypress: armed modifiers fall away, locked stay.
  function modConsume(st) {
    if (st.ctrl === 'armed')  st.ctrl = 'off';
    if (st.shift === 'armed') st.shift = 'off';
  }
  // A view change is a clean slate.
  function modClear(st) { st.ctrl = 'off'; st.shift = 'off'; }

  // Where ⇧# goes. Normally it advances through the views in order, but with
  // ANYTHING locked — a locked view, a locked Ctrl or a locked Shift — it
  // becomes an escape hatch back to view 0 instead.
  //
  // The reasoning: locking is a deliberate gesture you make to type a run of
  // something, and ⇧# afterwards is how you say you are done. Advancing then
  // is doubly wrong — it lands you on a further panel you did not ask for AND
  // silently drops the lock on the way (the caller clears it either way), so
  // one press produces two surprises. Going to view 0 is what a user wants
  // after a locked run essentially every time, and it gives every lock one
  // obvious way out, which is the same key that got them into it.
  //
  // Pure, and named, so tools/tests/kbdmodtest.js can drive it without a DOM.
  function nextView(view, nViews, st) {
    const locked = st.viewLocked || st.ctrl === 'locked' || st.shift === 'locked';
    return locked ? 0 : (view + 1) % nViews;
  }
  const modActive = (st, which) => st[which] !== 'off';

  // ── Alt+numpad code entry ──────────────────────────────────────────────────
  // A period PC reached the whole upper CP437 range — ░▒▓█, the box-drawing and
  // block characters people drew ANSI with — by holding Alt and typing a decimal
  // code on the numpad. The renderer has had all 256 glyphs from the start, so
  // this only ever needed an input path; the numpad view is the natural home.
  //
  // Always THREE digits, as it was on DOS: 065, not 65. That makes the entry
  // self-terminating, which matters here because there is no Alt key being
  // physically held to release — Alt is sticky instead, and the third digit is
  // what commits. Anything that is not a digit cancels the entry and then acts
  // normally, so an accidental Alt costs one keystroke and never swallows it.
  //
  // `altDigits` is null when not armed, otherwise the digits so far ('' when
  // freshly armed). Kept as a pure accumulator so kbdmodtest can drive it.
  let altDigits = null;
  const altArmed = () => altDigits !== null;

  // Feed one digit. Returns the next accumulator state and, once three digits
  // are in, the byte to send — or null for an out-of-range code, which is
  // discarded rather than wrapped, so a mistyped 300 sends nothing at all.
  function altAccept(digits, ch) {
    const next = digits + ch;
    if (next.length < 3) return { digits: next, byte: null };
    const n = parseInt(next, 10);
    return { digits: null, byte: (n >= 0 && n <= 255) ? n : null };
  }

  // ── Long-press plumbing ────────────────────────────────────────────────────
  // The timer CANNOT live on the button: every press calls render(), which
  // rebuilds the whole keyboard, so the element that saw pointerdown is gone
  // before its own pointerup could ever fire — the hold would then always
  // elapse and every tap would lock. Watching the window instead survives the
  // rebuild. pointercancel matters as much as pointerup: with the keyboard open
  // the page itself scrolls on mobile (body.kbd-open), and a hold that turns
  // into a scroll fires cancel, not up.
  let holdTimer = null, holdX = 0, holdY = 0;
  // The pointer this hold belongs to, and whether it is still down. ONE hold at
  // a time: a fresh press supersedes whatever the last one left behind, so a
  // release that never arrived cannot poison the presses after it.
  let holdId = null, holdDown = false;
  function cancelKeyHold() { clearTimeout(holdTimer); holdTimer = null; }
  function releaseKeyPointer(e) {
    // A release for some other pointer is not this hold's business; anything
    // without an id (touchend, blur) ends it unconditionally.
    if (e && e.pointerId != null && holdId != null && e.pointerId !== holdId) return;
    holdDown = false; holdId = null;
    cancelKeyHold();
  }
  // Capture to the keyboard ROOT, which render() empties but never replaces.
  // Touch implicitly captures to the BUTTON, and render() destroys that button
  // inside the very handler that armed the timer — the release is then routed
  // to a removed element and reaches nothing, which is how a press nobody held
  // was promoted. Held by the root, the release arrives whatever the embedding
  // page does with the gesture; and hasPointerCapture() is live state, so the
  // timer can ask whether the finger is still down rather than trust that a
  // cancel event was delivered.
  function startHold(e, promote) {
    cancelKeyHold();
    holdId = (e && e.pointerId != null) ? e.pointerId : null;
    holdDown = true;
    if (holdId != null && kbdEl.setPointerCapture) {
      try { kbdEl.setPointerCapture(holdId); } catch (_) { holdId = null; }
    }
    holdX = e.clientX; holdY = e.clientY;
    holdTimer = setTimeout(() => {
      holdTimer = null;
      if (!holdDown) return;
      if (holdId != null && kbdEl.hasPointerCapture && !kbdEl.hasPointerCapture(holdId)) return;
      promote();
      if (navigator.vibrate) navigator.vibrate(15);   // Android; iOS ignores it
      render();
    }, LOCK_MS);
  }
  // The root sees the captured pointer's own events; the window listeners stay
  // for the uncaptured case and for the separate touch stream, which still
  // arrives when the pointer stream is the thing that went wrong. blur is the
  // tap that moves focus out of the frame.
  // Capture phase, so it runs BEFORE the key's own handler arms a new hold: any
  // press ends the previous one even if that one's release was never delivered.
  kbdEl.addEventListener('pointerdown', () => releaseKeyPointer(), true);
  kbdEl.addEventListener('pointerup', releaseKeyPointer);
  kbdEl.addEventListener('pointercancel', releaseKeyPointer);
  kbdEl.addEventListener('lostpointercapture', releaseKeyPointer);
  window.addEventListener('pointerup', releaseKeyPointer);
  window.addEventListener('pointercancel', releaseKeyPointer);
  window.addEventListener('lostpointercapture', releaseKeyPointer);
  window.addEventListener('touchend', () => releaseKeyPointer());
  window.addEventListener('touchcancel', () => releaseKeyPointer());
  window.addEventListener('blur', () => releaseKeyPointer());
  window.addEventListener('pointermove', (e) => {
    if (!holdTimer) return;
    if (Math.abs(e.clientX - holdX) > LOCK_SLOP ||
        Math.abs(e.clientY - holdY) > LOCK_SLOP) cancelKeyHold();
  }, { passive: true });

  // What a key def actually sends, given the modifier state.
  function keySeq(k, st) {
    const ctrl = modActive(st, 'ctrl'), shift = modActive(st, 'shift');
    if (k.n) return namedSeq(k.n, ctrl, shift);
    if (k.s == null) return null;
    if (ctrl) {
      const c = ctrlChar(k.s);
      if (c !== null) return c;
    }
    // Shift alone on a printable is a no-op: views 2 and 3 already show the
    // shifted glyphs, so there is no unshifted state for it to flip.
    return k.s;
  }

  function keyEl(k) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'kbk';
    // Width in grid units. One unit is a column of the 10-wide letter rows;
    // fractional values are normal here because a 4-character label needs about
    // 1¼ columns. The 5px term re-adds the gaps a multi-unit key spans.
    if (k.u) b.style.flex = `0 0 calc((100% - 45px) * ${k.u} / 10 + 5px * ${k.u - 1})`;
    if (k.blank) { b.className += ' blank'; b.tabIndex = -1; return b; }
    if (k.c) b.className += ' ' + k.c;
    if (k.mod && mods[k.mod] !== 'off') b.className += ' ' + mods[k.mod];
    if (k.cycle && mods.viewLocked) b.className += ' viewlock';
    if (k.alt && altArmed()) b.className += ' armed';
    // The Alt key doubles as the readout for a code in progress — there is
    // nowhere else to show it, and without feedback three blind digits would be
    // pure guesswork. Underscores keep the width steady as they fill in.
    b.textContent = (k.alt && altArmed())
      ? (altDigits + '___'.slice(altDigits.length)) : k.t;

    // pointerdown (not click) so it fires without stealing focus and doesn't
    // double-fire on touch; preventDefault keeps the terminal/page from
    // scrolling. The long-press timer is layered on top WITHOUT delaying the
    // press: the tap acts immediately as it always has, and the hold merely
    // upgrades the result at LOCK_MS. Releasing early therefore costs nothing.
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();

      if (k.alt) {
        // Toggle. Arming clears Ctrl/Shft: a CP437 code point is a literal byte,
        // so a modifier waiting to transform it would be meaningless here.
        altDigits = altArmed() ? null : '';
        if (altArmed()) modClear(mods);
        render();
        return;
      }
      if (altArmed()) {
        // Only the digits feed the code. Everything else cancels the entry and
        // then falls through to do its own job.
        if (k.s != null && k.s.length === 1 && k.s >= '0' && k.s <= '9') {
          const r = altAccept(altDigits, k.s);
          altDigits = r.digits;
          if (r.byte !== null) modemWrite(String.fromCharCode(r.byte));
          render();
          return;
        }
        altDigits = null;
      }

      if (k.mod) {
        modTap(mods, k.mod);
        render();
        startHold(e, () => modHold(mods, k.mod));
        return;
      }
      if (k.goto != null) {
        // A named destination rather than a step through the cycle. No long
        // press: the view it goes to (the numpad) is already sticky, so there
        // would be nothing for a lock to add.
        view = k.goto;
        mods.viewLocked = false;
        modClear(mods);            // a panel change is a clean slate, as above
        render();
        return;
      }
      if (k.cycle) {
        view = nextView(view, views.length, mods);
        mods.viewLocked = false;
        modClear(mods);            // a panel change is a clean slate
        render();
        // The view you land on stops being one-shot.
        startHold(e, () => { mods.viewLocked = true; });
        return;
      }

      const seq = keySeq(k, mods);
      if (seq != null) modemWrite(seq);
      modConsume(mods);
      // CAPS and SYMBOLS are one-shot, like a shift key: after any keypress
      // drop back to lowercase, which is what you want next far more often than
      // a second capital. The NUMPAD is deliberately sticky — you go there to
      // type a run of digits or to navigate, not for a single key. A long press
      // on ⇧# suppresses the drop-back for as long as you stay on that view.
      if (!mods.viewLocked && ONE_SHOT_VIEWS.indexOf(view) >= 0) view = 0;
      render();
    });
    return b;
  }
  function rowEl(row, cls) {
    const r = document.createElement('div'); r.className = cls || 'krow';
    for (const k of row) r.appendChild(keyEl(k));
    return r;
  }
  function render() {
    const v = views[view];
    kbdEl.innerHTML = '';
    if (v.kind === 'rows') {
      for (const row of v.rows) kbdEl.appendChild(rowEl(row));
    } else {
      const pads = document.createElement('div'); pads.className = 'pads';
      const num = document.createElement('div'); num.className = 'pad num';
      for (const k of v.num) num.appendChild(keyEl(k));
      const navp = document.createElement('div'); navp.className = 'pad nav';
      for (const k of v.nav) navp.appendChild(keyEl(k));
      // Nav on the left, digits on the right — see the view 4 comment above.
      pads.appendChild(navp); pads.appendChild(num);
      kbdEl.appendChild(pads);
      kbdEl.appendChild(rowEl(v.foot, 'foot'));
    }
  }

  function setOpen(show) {
    if (show === !kbdEl.hasAttribute('hidden')) return;   // already there
    // Closing drops any pending hold and every sticky modifier: a locked Ctrl
    // is invisible while the keyboard is hidden, and finding one still latched
    // on reopening would be the worst kind of surprise.
    cancelKeyHold();
    if (!show) { modClear(mods); mods.viewLocked = false; altDigits = null; }
    if (show) { kbdEl.removeAttribute('hidden'); render(); }
    else kbdEl.setAttribute('hidden', '');
    kbdToggle.classList.toggle('on', show);
    document.body.classList.toggle('kbd-open', show);   // enables mobile page-scroll layout
    fitTerminal();                                       // reflow terminal + keyboard width
    if (show) kbdEl.scrollIntoView({ block: 'nearest' });
  }
  kbdToggle.addEventListener('click', () => {
    const show = kbdEl.hasAttribute('hidden');
    setOpen(show);
    prefs.set('kbdOpen', show);
  });
  if (prefs.get('kbdOpen')) setOpen(true);

  // Published for the terminal touch handler (first-touch-opens-keyboard).
  keyboardIsOpen = () => !kbdEl.hasAttribute('hidden');
  openKeyboard = () => setOpen(true);
})();

// ─── Desktop keyboard shortcuts (Alt) ───────────────────────────────────────
// Alt is the modifier the terminal never sends — keyToSeq() returns null for it
// — which is why scrollback navigation already lives there. These are the rest
// of it: the toggles in the button run, on the initial of what they do.
//
//   Alt+K keyboard · Alt+A font (Aa) · Alt+Z zoom · Alt+M speaker · Alt+Enter fullscreen
//   Alt+C connect · Alt+X hang up
//
// C and X are one button between them — #dial is a toggle — so each is gated on
// the call state rather than both clicking it blind. That way Alt+C during a
// call does nothing instead of hanging it up, which is the one thing a user
// pressing "connect" cannot have meant. The gate is `dialing`, the same flag
// the button's own handler branches on, so there is no second idea of what
// state the call is in.
//
// EACH ONE CLICKS THE REAL BUTTON rather than calling the handler behind it. A
// second call path would be a second place for the toast, the persisted pref
// and the cycle order to drift, and every one of these buttons owns state that
// only its own click handler maintains. It also means a disabled button (zoom,
// while scrollback is on) correctly does nothing here too, with no second copy
// of the rule that disabled it.
//
// Placed last so every button it names already exists.
//
// Not bound on mobile: there is no Alt key, and the toggles are all one tap
// away. Skipped while a TEXT ENTRY has focus, so Alt+<letter> still belongs to
// the browser (on macOS it composes characters) in the host:port field.
// Alt+Enter is exempt from that — it composes nothing anywhere, and wanting
// fullscreen while the cursor sits in a field is ordinary.
//
// Deliberately NOT isFormField(): that counts a BUTTON as a form control, and
// a button is exactly what has focus after you press one. Using it here left
// every shortcut dead from the first toolbar click until you clicked away —
// which is the state a user is in most of the time.
const altTypingTarget = (el) => !!el && (el.isContentEditable
  || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
const ALT_SHORTCUTS = {
  k: 'kbdtoggle', a: 'fonttoggle', z: 'zoomtoggle', m: 'listen', enter: 'fstoggle',
  c: 'dial', x: 'dial',
};
// Which call state each shortcut is for; absent = any. `dialing` is read at the
// moment of the press, not captured.
const ALT_WHEN = { c: () => !dialing, x: () => dialing };
window.addEventListener('keydown', (e) => {
  if (isMobile()) return;
  if (!e.altKey || e.ctrlKey || e.metaKey) return;
  // `e.key` under Alt is the COMPOSED character on some platforms (macOS gives
  // Alt+K as '˚'), so the physical key is the only reliable identity. `e.code`
  // is 'KeyK' / 'Enter'.
  const code = String(e.code || '');
  const name = code.startsWith('Key') ? code.slice(3).toLowerCase()
             : code === 'Enter' || code === 'NumpadEnter' ? 'enter' : '';
  const id = ALT_SHORTCUTS[name];
  if (!id) return;
  if (name !== 'enter' && altTypingTarget(document.activeElement)) return;
  const btn = $(id);
  if (!btn) return;
  // Swallowed either way: a shortcut that is inert in this state must not fall
  // through to the browser's own Alt+<letter> handling half the time.
  e.preventDefault();
  if (ALT_WHEN[name] && !ALT_WHEN[name]()) return;
  btn.click();
});

// Speaker defaults to Auto; the button reflects that. Audio actually starts on
// the first user gesture (Connect / speaker button), per browser autoplay rules.
updateListenUI();
readyStatus();

// Restore the last protocol before the startup echo, so the terminal opens
// showing the modulation the user actually left it on.
// Precedence: a URL's `speed` beats a stored choice beats the menu default.
// The URL wins because a shared link is a specific invitation — "hear this board
// at 33600" — and losing to whatever the visitor last picked would make the same
// link behave differently for different people. Like the destination, it is not
// persisted (see `shared`).
const storedProto = prefs.get('protocol');
if (storedProto && [...protocolEl.options].some((o) => o.value === storedProto)) {
  protocolEl.value = storedProto;
}
if (shared.speed) protocolEl.value = shared.speed;

// Echo the modem init string + the initial modulation-select on startup, so the
// terminal opens looking like a freshly-initialised modem ready to dial.
termEcho(`${MODEM_INIT}\r\nOK\r\n`);
echoMSCommand(protocolEl.value);
