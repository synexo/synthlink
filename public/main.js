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
import { CYCLE_FONTS, fontById, cycleIndexById, mobileDefaultFont,
         DEFAULT_FONT_ID } from './fonts/index.js';
import { ANSIMusic } from './music.js';

const { ModemDSP, config } = window.SynthModemDSP;

const COLS = 80, ROWS = 25;
const SR = 8000;                       // DSP audio rate

// ─── Shareable links: query-string ⇄ controls ───────────────────────────────
// A SynthLink URL can carry a destination and a modulation, so a board can be
// linked to directly:
//
//     ?host=bbs.fozztexx.com&port=23&speed=v34-33600&connect=1
//
// `host` alone is enough — port defaults to 23 and speed to DEFAULT_SPEED.
//
// **Speed is named by protocol, not by bit rate**, because rates collide: 300 is
// both V.21 and Bell 103, 9600 is both V.29 and V.32, and 33600 is both V.34's
// top rate and V.90's upstream. A number would have to guess. The names are the
// <select> values lower-cased, which makes them self-documenting next to the
// menu: v21, bell103, v22, v22bis, v23, v29, v32, v32bis, v34, v90, telnet.
//
// V.34 is the one protocol with several rates in the menu. Bare `v34` means its
// top rate; a specific one is `v34-31200`. The separator is a dash rather than
// the '@' the <option> value uses, because '@' percent-encodes to %40 in some
// clients and turns a tidy link ugly — '@' is still accepted on the way in.
//
// Everything here is pure string work, exercised by tools/sharelinktest.js.

// The modulation a fresh visitor gets: V.34's top rate. Fast enough that a
// modern BBS feels responsive, while still being a real modem handshake with
// something to listen to — unlike `telnet`, which has no carrier at all.
const DEFAULT_SPEED = 'V34@33600';

/** <option> value ⇒ URL token.  "V34@33600" → "v34-33600" */
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
  // Exact match on the canonical token, e.g. "v34-33600" or "v32bis".
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
    out.connect = v === '' || v === '1' || v === 'true' || v === 'yes' || v === 'on';
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
  firstVisit: false,
  load() {
    try {
      const raw = localStorage.getItem(PREFS_KEY);
      const o = raw ? JSON.parse(raw) : null;
      this._d = (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
      // Nothing stored at all ⇒ this browser has never been here. Captured at
      // load, before anything writes, because the first stored preference would
      // otherwise erase the evidence. Drives the one-time welcome panel.
      this.firstVisit = !raw;
    } catch (_) { this._d = {}; this.firstVisit = false; }   // unavailable — run stateless
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
               : startMobile ? mobileDefaultFont() : fontById(DEFAULT_FONT_ID);
const cw = () => COLS * activeFont.cellW;    // 640
const ch = () => ROWS * activeFont.cellH;    // 400 or 475

// ─── DOM ────────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const canvas = $('terminal-canvas');
const wrap = $('wrap');
const hostEl = $('host'), portEl = $('port'), bbsEl = $('bbs');
const hostportEl = $('hostport'), bbsToggle = $('bbstoggle');
const bbsLabel = $('bbslabel'), favBtn = $('favbtn');
const dialBtn = $('dial'), extBtn = $('extension'), listenBtn = $('listen');
const protocolEl = $('protocol');
const led = $('led'), statusEl = $('status');
const scopeCanvas = $('scope'), scopeCtx = scopeCanvas.getContext('2d');

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
let rxBytes = 0, txBytes = 0;            // payload bytes through the modem (both dirs)
let flowBps = 0;                         // smoothed live throughput, shown on the scope
// 'modem' = payload is modulated to PCM and carried as audio; 'direct' = the
// modem is bypassed and payload rides raw binary WS frames. Set per call from
// the speed dropdown. In direct mode the scope box becomes a throughput graph,
// since there is no waveform to show.
let linkMode = 'modem';

renderer.init().then(() => {
  fitTerminal();
  (function renderLoop() {
    if (dirty || !term.isLive()) {
      renderer.drawFrame(term.getDisplayCells(), term.cx, term.cy,
        term.cursorVisible && term.isLive(), cursorOn, blinkPhase, null);
      dirty = false;
    }
    requestAnimationFrame(renderLoop);
  })();
});
setInterval(() => { cursorOn = !cursorOn; dirty = true; }, 500);
setInterval(() => { blinkPhase = !blinkPhase; dirty = true; }, 300);

// ─── Terminal fit-to-window (preserves the active font's aspect) ────────────
const isMobile = () => window.matchMedia('(max-width: 640px)').matches;
// Set by the page-grab IIFE further down (same stub pattern as keyboardIsOpen).
// fitTerminal is where every layout change lands, so it is also where the grab
// bar's visibility is re-decided.
let updatePageGrab = () => {};
function fitTerminal() {
  if (typeof zoomOff === 'function') zoomOff();   // base box is about to move
  const kbdOpen = document.body.classList.contains('kbd-open');
  const mobile = isMobile();
  const M = mobile ? 0 : 3;               // no breathing room on mobile — maximize pixels
  const aspect = cw() / ch();             // 1.60 at 8x16, 1.347 at 8x19
  const availW = wrap.clientWidth - 2 * M;
  let w = availW, h = w / aspect;
  // On mobile with the keyboard open the whole page scrolls, so size the terminal
  // by width only (keep it full-size instead of shrinking to share the height).
  if (!(mobile && kbdOpen)) {
    const availH = wrap.clientHeight - 2 * M;
    if (h > availH) { h = availH; w = h * aspect; }
  }
  canvas.style.width = Math.floor(w) + 'px';
  canvas.style.height = Math.floor(h) + 'px';
  syncKeyboardWidth(w);                   // keyboard never wider than the terminal
  updatePageGrab();                       // the page may have become (un)scrollable
}
function syncKeyboardWidth(termW) {
  const kb = document.getElementById('keyboard');
  if (!kb || kb.hasAttribute('hidden')) return;
  const w = (termW != null) ? termW : document.getElementById('terminal-canvas').getBoundingClientRect().width;
  kb.style.maxWidth = Math.round(w) + 'px';
}
window.addEventListener('resize', () => { fitTerminal(); sizeScope(); });
window.addEventListener('load', () => { fitTerminal(); sizeScope(); });

// ─── Audio monitor + oscilloscope (Web Audio) ───────────────────────────────
// Graph:  bufferSource(s) → analyser → gain → destination
// The analyser sits BEFORE the gain, so the oscilloscope sees the real carrier
// waveform even when the gain is muted. Audio is always scheduled during a call
// (so the scope runs regardless of the Listen state); gain controls audibility.
const monitor = {
  ctx: null, analyser: null, gain: null,
  // Speaker mode: 'auto' (audible through dial + handshake, then fade to silence
  // on connect), 'listen' (always audible), 'mute' (always silent). `autoOn`
  // tracks whether Auto is currently in its audible phase.
  mode: ['auto', 'listen', 'mute'].includes(prefs.get('speaker')) ? prefs.get('speaker') : 'auto',
  autoOn: false,
  cursor: { tx: 0, rx: 0 },
  pending: { tx: [], rx: [] },
  flushTimer: null,
  _fadeTimer: null,
  _keepAlive: null,
  ensure() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.gain = this.ctx.createGain();
      this.analyser.connect(this.gain);
      this.gain.connect(this.ctx.destination);
      this._applyGain();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  },
  // Prime the output pipeline on the connect gesture. Browsers advance
  // ctx.currentTime the instant resume() resolves, but the audio output DEVICE
  // can take up to ~1–2s (intermittently — worst on a cold context or after the
  // browser has auto-suspended it between calls) to actually start emitting
  // sound. Buffers scheduled during that warmup are timed correctly against the
  // clock yet play into a device that isn't producing output, which silently
  // swallows the start of the handshake. Holding the device open with a silent
  // keep-alive here overlaps that warmup with WebSocket-open + dial (both of
  // which precede any handshake audio), so the first tone is heard.
  prime() {
    this.ensure();
    const warm = () => {
      if (this._keepAlive || !this.ctx) return;
      try {
        const ka = this.ctx.createConstantSource();
        ka.offset.value = 0;                 // silent — only keeps the device live
        ka.connect(this.ctx.destination);
        ka.start();
        this._keepAlive = ka;
      } catch (_) {
        try {                                // fallback: a silent buffer still opens the device
          const b = this.ctx.createBuffer(1, Math.ceil(SR * 0.2), SR);
          const s = this.ctx.createBufferSource();
          s.buffer = b; s.connect(this.ctx.destination); s.start();
        } catch (__) {}
      }
    };
    if (this.ctx.state === 'running') warm();
    else this.ctx.resume().then(warm).catch(warm);
  },
  _stopKeepAlive() {
    if (this._keepAlive) {
      try { this._keepAlive.stop(); } catch (_) {}
      try { this._keepAlive.disconnect(); } catch (_) {}
      this._keepAlive = null;
    }
  },
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
  // Queue frames; a timer batches them into larger buffers (≈12 nodes/sec
  // instead of ~100) to keep main-thread churn low.
  feed(which, f32) {
    if (!this.ctx) return;
    this.pending[which].push(f32);
    if (!this.flushTimer) this.flushTimer = setInterval(() => this._flush(), 80);
  },
  _flushOne(which) {
    const chunks = this.pending[which];
    if (!chunks.length) return;
    let total = 0; for (const c of chunks) total += c.length;
    const merged = new Float32Array(total);
    let off = 0; for (const c of chunks) { merged.set(c, off); off += c.length; }
    chunks.length = 0;
    const buf = this.ctx.createBuffer(1, merged.length, SR);
    buf.copyToChannel(merged, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = buf; src.connect(this.analyser);
    // Guard accounts for the output pipeline latency so the first buffer clears
    // any residual device warmup rather than being scheduled into it.
    const guard = 0.15 + (this.ctx.outputLatency || this.ctx.baseLatency || 0);
    const at = Math.max(this.ctx.currentTime + guard, this.cursor[which]);
    src.start(at);
    this.cursor[which] = at + buf.duration;
  },
  _flush() { this._flushOne('tx'); this._flushOne('rx'); },
  reset() {
    this.pending.tx.length = 0; this.pending.rx.length = 0;
    this.cursor.tx = this.cursor.rx = 0;
    if (this.flushTimer) { clearInterval(this.flushTimer); this.flushTimer = null; }
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
  // The scope's display size is set purely in CSS (viewport-width based), so this
  // only matches the canvas backing store to it. Deterministic on load + resize.
  const dpr = window.devicePixelRatio || 1;
  scopeCanvas.width  = Math.round(scopeCanvas.clientWidth  * dpr);
  scopeCanvas.height = Math.round(scopeCanvas.clientHeight * dpr);
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
  if (!monitor.analyser) return;
  const bins = monitor.analyser.frequencyBinCount;
  if (specData.length !== bins) specData = new Uint8Array(bins);
  monitor.analyser.getByteFrequencyData(specData);

  const sr = monitor.ctx.sampleRate || 48000;
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
  scopeCtx.font = `${Math.round(9 * dpr)}px ui-monospace, "DejaVu Sans Mono", monospace`;
  scopeCtx.textAlign = 'left'; scopeCtx.textBaseline = 'top';
  scopeCtx.fillStyle = 'rgba(190,140,40,0.85)';
  scopeCtx.fillText(`▲ ${fmtBps(tpScale)}bps`, Math.round(5 * dpr), Math.round(4 * dpr));
}

// Live throughput readout — small, bright white, bottom-right justified.
// Identical in both link modes; shown only once the link is up.
function drawBpsReadout(w, h) {
  const dpr = window.devicePixelRatio || 1;
  scopeCtx.font = `${Math.round(11 * dpr)}px ui-monospace, "DejaVu Sans Mono", monospace`;
  scopeCtx.textAlign = 'right'; scopeCtx.textBaseline = 'bottom';
  scopeCtx.shadowColor = '#000'; scopeCtx.shadowBlur = Math.round(2 * dpr);
  scopeCtx.fillStyle = '#ffffff';
  scopeCtx.fillText(`${Math.max(0, Math.round(flowBps))} bps`,
    w - Math.round(6 * dpr), h - Math.round(4 * dpr));
  scopeCtx.shadowBlur = 0;
}

function drawScope() {
  requestAnimationFrame(drawScope);
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

  if (!monitor.analyser) return;
  monitor.analyser.getFloatTimeDomainData(scopeData);

  // Show ~5 ms so individual carrier cycles read as clean sine waves.
  const show = Math.min(scopeData.length, Math.round((monitor.ctx.sampleRate || 48000) * 0.005));
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
}

// Modem init string, echoed once on startup. M1 speaker-on-until-carrier,
// Q0 show result codes, E1 command echo, X4 full result codes + dial-tone/busy
// detection, &C1 DCD follows carrier.
const MODEM_INIT = 'AT M1 Q0 E1 X4 &C1';

// Per-protocol modulation-select command, keyed by the exact <select> option
// value (V.34 carries its sub-rate as "V34@<rate>"). Uses the standard
// Conexant/Rockwell +MS=<carrier>,<automode>,<minRate>,<maxRate> syntax with
// automode 0 to force the single modulation. To add/adjust a protocol, edit or
// add one line here — nothing else in this file needs to change.
//   Note on V29: V.29 was a half-duplex fax carrier, not a duplex data-modem
//   modulation, so there's no canonical consumer AT string. This project's V.29
//   is a Hayes "Express 96"-style ping-pong (see PROTOCOLS.md §4); +MS=V29 keeps
//   the uniform look and is accepted by fax-capable chipsets. Swap this one line
//   if you prefer a different representation.
const MS_COMMANDS = {
  'Bell103':    'AT+MS=B103,0,300,300',
  'V21':        'AT+MS=V21,0,300,300',
  'V22':        'AT+MS=V22,0,1200,1200',
  'V22bis':     'AT+MS=V22B,0,2400,2400',
  'V23':        'AT+MS=V23,0,1200,1200',
  'V29':        'AT+MS=V29,0,9600,9600',
  'V32':        'AT+MS=V32,0,9600,9600',
  'V32bis':     'AT+MS=V32B,0,14400,14400',
  'V34@28800':  'AT+MS=V34,0,28800,28800',
  'V34@31200':  'AT+MS=V34,0,31200,31200',
  'V34@33600':  'AT+MS=V34,0,33600,33600',
  // V.90 is asymmetric: the AT+MS rate pair is upstream,downstream.
  'V90':        'AT+MS=V90,0,33600,56000',
  // 'direct' deliberately has no entry: +MS selects a *modulation*, and
  // modem-bypass mode has none. Inventing a token would be the one fake string
  // in a table of real ones, so it gets a plain-language line instead.
};
const DIRECT_ECHO = '[Telnet - Modem Bypassed]';
function echoMSCommand(sel) {
  if (sel === 'direct') return termEcho(`\r\n${DIRECT_ECHO}\r\n`);
  const cmd = MS_COMMANDS[sel];
  if (cmd) termEcho(`\r\n${cmd}\r\nOK\r\n`);
}

// ─── Call-progress audio (dial tone, DTMF, ringback, answer click) ───────────
// Every tone is routed to monitor.analyser → gain → destination, exactly like
// the modem carrier, so it shows on the oscilloscope + spectrum and is gated by
// the Auto/Listen/Mute speaker control. US-standard frequencies throughout.
const DTMF = {
  '1': [697, 1209], '2': [697, 1336], '3': [697, 1477],
  '4': [770, 1209], '5': [770, 1336], '6': [770, 1477],
  '7': [852, 1209], '8': [852, 1336], '9': [852, 1477],
  '*': [941, 1209], '0': [941, 1336], '#': [941, 1477],
};
const tones = {
  // Schedule a two-frequency tone from audio-clock time t for dur seconds.
  // Short attack/release envelope avoids clicks. Returns the end time.
  dual(f1, f2, t, dur, level = 0.22) {
    const ctx = monitor.ctx;
    const g = ctx.createGain();
    g.connect(monitor.analyser);
    const a = 0.006, r = 0.010;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(level, t + a);
    g.gain.setValueAtTime(level, Math.max(t + a, t + dur - r));
    g.gain.linearRampToValueAtTime(0.0001, t + dur);
    for (const f of [f1, f2]) {
      if (!f) continue;
      const o = ctx.createOscillator();
      o.type = 'sine'; o.frequency.value = f;
      o.connect(g); o.start(t); o.stop(t + dur + 0.02);
    }
    return t + dur;
  },
};

// Play the full US dial sequence for the resolved IP, then resolve the returned
// promise so the caller can start the modem handshake. Sequence: ~1s dial tone
// → DTMF for each IP digit (fast) → ~500ms pause → ~1s single ringback →
// ~250ms pause → answer click → ~250ms pause. All audio-clock scheduled.
function playDialSequence(ip) {
  monitor.ensure();
  const ctx = monitor.ctx;
  const lead = 0.2 + (ctx.outputLatency || ctx.baseLatency || 0);
  let t = ctx.currentTime + lead;
  t = tones.dual(350, 440, t, 1.0, 0.20);           // US dial tone
  t += 0.15;
  for (const ch of String(ip).replace(/\D/g, '')) { // DTMF each digit of the IP
    const pair = DTMF[ch];
    if (pair) { t = tones.dual(pair[0], pair[1], t, 0.075, 0.26); t += 0.055; }
  }
  t += 0.5;                                          // pause before ringing
  t = tones.dual(440, 480, t, 1.0, 0.20);           // US ringback (single, short)
  t += 0.4;                                          // brief pause, then the far end answers
  const waitMs = Math.max(0, (t - ctx.currentTime) * 1000);
  return new Promise((res) => setTimeout(res, waitMs));
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
  _src: null,      // the independent audio-graph playback (survives carrier loss)
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
    if (this.active || this._src) return;
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
  // Independent playback through the monitor graph: it's audible + on the
  // scope/spectrum on its own, so it always finishes even if the carrier drops
  // (and never double-counts, since the modem's own audio feeds the scope clean).
  _play(b) {
    monitor.ensure();
    const ctx = monitor.ctx;
    const buf = ctx.createBuffer(1, b.length, SR);
    buf.copyToChannel(b, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf; src.connect(monitor.analyser);
    src.onended = () => { if (this._src === src) { this._src = null; this._finish(); } };
    this._src = src; src.start();
  },
  // End of clip: drop the disruption and, in Auto, return to the faded/off state.
  _finish() {
    this.active = false;
    extBtn.classList.remove('on');
    if (monitor.mode === 'auto') { monitor.autoOn = false; monitor._applyGain(); updateListenUI(); }
  },
  // Carrier lost: stop disrupting the (now-gone) DSP streams, but let the audible
  // clip keep playing to the end via its own graph node.
  stop() { this.active = false; },
  playing() { return !!this._src; },
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
}

// ─── Modem link ─────────────────────────────────────────────────────────────
let ws = null, dsp = null, carrier = false;
let dialing = false;          // true from Connect press until cleanup
let noCarrierEchoed = false;  // ensures a single NO CARRIER per call
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

function setStatus(t) { statusEl.textContent = t; }
function setLed(cls) { led.className = cls || ''; }

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
  if (!carrier) return;
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
}

function connect() {
  // In manual mode the field may not have blurred (its `change` never fired),
  // so fold any pending edit into the canonical host/port first.
  if (manualMode) commitHostPort();
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

  dialing = true; noCarrierEchoed = false;
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
  setStatus('opening link…'); setLed('neg');

  // ATDT dial line to the terminal (the human-readable destination).
  termEcho(`\r\nATDT ${host}:${port}\r\n`);

  // Build + start the originate modem. Deferred until the dial audio has played
  // so the DTMF/ringback don't overlap the carrier handshake tones.
  // Modem bypassed: dial and wait for the server's `connected`. No DSP, no
  // handshake, no audio — the link is up as soon as the TCP socket is.
  function startDirect() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'dial', host, port, link: 'direct' }));
  }

  function startModem() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'dial', host, port, protocol: modemProto, v34Rate: config.modem.native.v34Rate }));
    dsp = new ModemDSP('originate');
    dsp.on('audioOut', (f32) => {
      // Inject extension audio into the outgoing stream (corrupts user→BBS at the
      // server's demod). Copy first so we never mutate the DSP's own buffer; the
      // monitor gets the clean carrier (the clip is heard via its own node).
      let out = f32;
      if (extension.active) { out = f32.slice(); extension.mix(out); }
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(floatToInt16(out));
      monitor.feed('tx', f32);
    });
    dsp.on('connected', (info) => {
      carrier = true;
      console.log(`[modem] CARRIER UP ${info.protocol} @ ${info.bps} bps`);
      setStatus(`carrier ${info.protocol} @ ${info.bps} bps — connected`);
      setLed('up'); canvas.focus();
      showFavButton(true);         // the BBS label becomes the favourite heart
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
    console.log('[link] DIRECT — modem bypassed');
    setStatus('telnet direct — connected (modem bypassed)');
    setLed('up'); canvas.focus();
    showFavButton(true);
    termEcho('\r\nCONNECT\r\n');    // no speed to report; there is no carrier
  }

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    setStatus('dialing…');
    ws.send(JSON.stringify({ type: 'resolve', host }));   // ask the server for the IP to "dial"
  };

  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'resolved') {
        setStatus(`dialing ${m.ip}…`);
        // Direct mode skips the dial audio entirely — DTMF, ringback and answer
        // tone all describe a modem placing a call, and there isn't one.
        if (linkMode === 'direct') startDirect();
        else playDialSequence(m.ip).then(startModem);     // dial tone → DTMF → ring → answer, then handshake
        return;
      }
      // In modem mode the DSP's own `connected` event drives the UI; in direct
      // mode the server's message is the only signal there is.
      if (m.type === 'connected' && linkMode === 'direct') { directLinkUp(); return; }
      if (m.type === 'resolveError') {
        setStatus(`no answer (${m.error})`);
        termEcho('\r\nNO CARRIER\r\n'); noCarrierEchoed = true;
        hangup();
        return;
      }
      // The proxy could not reach the BBS. Because the TCP connect is deferred
      // until carrier (so the board's timeouts don't run during the handshake),
      // this arrives *after* CONNECT is already on screen — so say plainly what
      // failed rather than leaving a bare NO CARRIER to explain it.
      if (m.type === 'proxyError') {
        setStatus(`telnet proxy failed: ${m.text}`);
        termEcho('\r\nTELNET PROXY CONNECT FAILED\r\n');
        hangup();
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

  ws.onclose = () => { if (carrier || dsp) setStatus('link closed'); cleanup(); };
  ws.onerror = () => setStatus('link error');
}

// A shared link with `connect` doesn't dial on its own — it puts a Connect
// prompt over the terminal and waits for one press.
//
// Dialling straight from page load was tried and is wrong here. Autoplay policy
// leaves the AudioContext suspended until a gesture, but the DSP runs on its own
// timer regardless, so the call proceeds while the handshake audio is queued
// rather than heard. Whenever the visitor first touches the page the context
// resumes and that backlog plays — dialling and handshake tones arriving over an
// already-connected session. A modem you hear after you're online is worse than
// no sound at all.
//
// The press fixes it at the source: it is the gesture, so `monitor.prime()`
// inside connect() resumes the context before the first tone is generated, and
// the call is heard from the start exactly as a Connect press always has been.
// Closing the prompt just leaves the controls set to the shared destination.
let autoPrompted = false;
function maybeAutoConnect() {
  if (autoPrompted || !shared.connect || !shared.host || dialing) return;
  autoPrompted = true;
  // This visitor gets the Connect prompt instead of the welcome panel, and is
  // counted as welcomed — being greeted twice on two different first impressions
  // is worse than not being greeted at all.
  if (typeof markWelcomed === 'function') markWelcomed();
  const modal = $('dialmodal'), yes = $('dialgo'), no = $('dialclose');
  if (!modal || !yes) { connect(); return; }        // markup missing — old behaviour

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

function cleanup() {
  carrier = false;
  extension.stop();
  if (dsp) { try { dsp.stop(); } catch {} dsp = null; }
  ws = null;
  monitor.cancelAutoFade();
  monitor.reset();
  monitor._stopKeepAlive();  // let the context auto-suspend between calls
  // A dropped carrier or failed dial prints NO CARRIER, once per call.
  if (dialing && !noCarrierEchoed) { termEcho('\r\nNO CARRIER\r\n'); noCarrierEchoed = true; }
  dialing = false;
  // Keep Auto's speaker on if an extension clip is still finishing; _finish()
  // returns it to the faded/off state when the clip ends.
  if (monitor.mode === 'auto' && !extension.playing()) { monitor.autoOn = false; monitor._applyGain(); }
  updateListenUI();
  setCallUI(false); extBtn.disabled = true; protocolEl.disabled = false;
  showFavButton(false);            // heart out, "BBS" label back
  setLed('');
  linkMode = 'modem';              // scope box returns to the waveform view
  tpReset();
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

// The canonical destination lives in the hidden #host/#port inputs, so every
// path that writes them funnels through here to persist the result and refresh
// the favourite heart.
function saveDest() {
  prefs.set('dest', { host: hostEl.value.trim(), port: portEl.value.trim() || '23' });
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
    // Back to the directory: keep the typed destination, and re-select the
    // matching entry if the directory happens to contain it.
    commitHostPort();
    syncBBSSelection();
  }
  manualMode = !manualMode;
  prefs.set('manualMode', manualMode);
  updateDestUI();
  showToast(manualMode ? 'Manual host:port' : 'BBS directory');
  (manualMode ? hostportEl : bbsEl).focus();
});

// ─── Favourites (♡ / ♥ in the BBS label slot) ────────────────────────────────
// The heart only exists during a call: on carrier the "BBS" label is replaced by
// it, and on hangup the label comes back. Clicking adds the current destination
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
}

// The heart swaps in for the label, never sits beside it.
function showFavButton(show) {
  bbsLabel.hidden = show;
  favBtn.hidden = !show;
  if (show) updateFavUI();
}

favBtn.addEventListener('click', () => {
  const dest = currentDest();
  if (!dest.host) return;
  const list = prefs.favorites.slice();
  const i = favIndex(dest.host, dest.port);
  if (i >= 0) list.splice(i, 1); else list.push(dest);
  prefs.favorites = list;
  renderBBS();      // the Favorites group appears / updates / disappears
  updateFavUI();
  showToast(i >= 0 ? 'Removed from favorites' : 'Added to favorites');
});

// Point the dropdown at the current host:port when the directory lists it.
function syncBBSSelection() {
  const cur = `${hostEl.value.trim()}:${portEl.value.trim()}`;
  if ([...bbsEl.options].some((o) => o.value === cur)) bbsEl.value = cur;
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

// Label form is breakpoint-dependent. Desktop shows "Name · host:port" — the
// same dot separator the speed menu uses. On mobile the address is dropped: the
// native picker (iOS wheel, Android dialog) is narrow, the guide's entries are
// long, and the name is the only part anyone scans for. Nothing is lost — the
// pencil toggle switches to a manual host:port field seeded from #host/#port,
// so the address of whatever is selected is always one tap away.
//
// An entry with no name (a hand-typed favourite) has only its host:port to show,
// so it renders the same either way.
function bbsLabelText(name, hp) {
  if (isMobile()) return name || hp;
  return name ? `${name} · ${hp}` : hp;
}

function bbsOption(b) {
  const o = document.createElement('option');
  const hp = `${b.host}:${b.port || 23}`;
  o.value = hp;
  // Kept as data, not parsed back out of the label: the label is lossy on mobile
  // and currentDest() needs the name verbatim.
  o.dataset.name = b.name || '';
  o.dataset.hp = hp;
  o.textContent = bbsLabelText(b.name, hp);
  return o;
}

// Rewrite every directory label in place after a breakpoint crossing. Options
// without a dataset.hp (Random, the "(no directory)" placeholder) aren't
// destinations and are left alone; values are untouched, so the current
// selection, the favourites match and #host/#port all survive unchanged.
function relabelBBS() {
  for (const o of bbsEl.options) {
    if (!o.dataset.hp) continue;
    o.textContent = bbsLabelText(o.dataset.name, o.dataset.hp);
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
});

// The fetched directory, kept so the list can be rebuilt without re-fetching
// when the favourites change.
let bbsDir = null;

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
      for (const b of guide) g.appendChild(bbsOption(b));
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
    if (shown && shown.value && shown.value !== RANDOM_VALUE) {
      const [h, p] = shown.value.split(':');
      hostEl.value = h; portEl.value = p || '23';
    }
  }
  updateFavUI();
}

// One change handler for the life of the page — renderBBS() replaces the
// options underneath it, which doesn't disturb a listener on the <select>.
bbsEl.addEventListener('change', () => {
  if (bbsEl.value === RANDOM_VALUE) {
    const pool = (bbsDir && bbsDir.pool) || [];
    if (!pool.length) return;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    const hp = `${pick.host}:${pick.port || 23}`;
    hostEl.value = pick.host; portEl.value = String(pick.port || 23);
    saveDest();
    bbsEl.value = hp;         // snap to the drawn entry — never left on Random
    showToast(pick.name ? `Random: ${pick.name}` : `Random: ${hp}`);
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
term.MAX_SCROLLBACK = 5000;
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
function afterScroll() { renderer.invalidateAll(); dirty = true; showSbIndicator(); }
function snapToLive() {
  if (term.isLive()) return;
  term.scrollbackEnd(); renderer.invalidateAll(); dirty = true; showSbIndicator();
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

  if (!carrier) return;
  const seq = keyToSeq(e);
  if (seq === null) return;
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
  if (nav || carrier) onKey(e);
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
// A magnifier for mobile: touch the terminal and it jumps to 2x centred on the
// point you touched, then tracks your finger; lift to return to the full view.
//
// This is a DISPLAY-only effect — a CSS transform on the canvas. The renderer
// keeps drawing the same 640x475 backing store at native resolution, so there
// is no repaint, no cache churn, and panning is composited on the GPU. It also
// means zoom is automatically correct for whatever font is active.
//
// Mapping is RELATIVE from the middle. Wherever you press, the view opens on
// the centre of the terminal and your finger pans out from there, so the press
// point is yours to choose: press bottom-right when you want to read the
// top-left, and your finger ends up far from the text it's uncovering. (The
// earlier absolute mapping tied the press point to the content, which meant the
// corners could only be reached with the finger sitting on them.)
//
// Sensitivity is expressed as SWEEP: the fraction of the terminal your finger
// must travel to pan from the middle out to an edge. This is the number that
// actually describes the feel, and it is magnification-independent — which
// matters, because the amount of hidden content grows with the zoom factor.
// At a fixed gain a higher magnification would need MORE finger travel for the
// same job (~65 px at 2x vs ~87 px at 3x on a 390 px-wide screen); deriving the
// gain from SWEEP instead keeps the sweep identical at every magnification.
//
//   gain = (0.5 - visibleFraction/2) / SWEEP
//
// where visibleFraction is how much of the canvas the viewport shows on that
// axis at the current magnification. Deriving it from the real viewport rather
// than assuming 1/Z matters: the terminal fills the viewport exactly on one
// axis but is usually letterboxed on the other, so the two axes have different
// amounts of hidden content and would otherwise sweep differently.
//
// SWEEP 1/6 reproduces the old fixed gain of 1.5 exactly at 2x. LOWER it for a
// more sensitive pan (less finger travel per screenful), raise it for a calmer,
// more precise one. Beyond the sweep the pan is clamped and further movement
// does nothing, so a small sweep also means a larger dead area — that trade is
// the whole tuning question.
//
// Steadiness is two separate problems with two different fixes:
//   - Touchdown wobble: the finger settles over the first fraction of a
//     second. PAN_SLOP holds the initial point locked until the drag is clearly
//     deliberate.
//   - Tracking jitter: at ZOOM x GAIN, one pixel of finger noise becomes ~3 px
//     of content movement. A short CSS transition low-passes that on the
//     compositor. A dead zone would NOT fix this — it would only make tracking
//     move in steps.
//
// Gesture ownership is decided by the scrollback toggle, since a pan and a
// scroll-swipe are the same motion:
//   scrollback OFF (the mobile default) - touch zooms instantly.
//   scrollback ON                       - a drag scrolls history, and zoom
//                                         needs a short press-and-hold first.
// Cycled by the magnification button. 0 is the OFF setting: touching the
// terminal then does nothing (beyond the keyboard nudge below), which is what
// you want if you keep triggering the magnifier by accident.
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
  if (!keyboardIsOpen()) {
    e.preventDefault();
    openKeyboard();
    showToast(zoomEnabled() ? 'Keyboard enabled. Touch again to zoom'
                            : 'Keyboard enabled');
    return;
  }
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

// Scrollback enable/disable toggle (📜). When off, wheel/swipe/Page keys are
// ignored so an accidental swipe won't scroll. State shown on the button + a toast.
const scrollToggle = $('scrolltoggle');
function updateScrollbackUI() { scrollToggle.classList.toggle('on', scrollbackEnabled); }
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
// Cycles the FONTS table in fonts/index.js. Cell height differs per font, so a
// switch re-sizes the backing canvas and changes the aspect ratio — hence the
// fitTerminal() after each change. Adding a third font needs nothing here.
// The cycle runs over CYCLE_FONTS (FONTS minus anything flagged `hidden` in the
// registry), so hiding a font from the UI is a one-line change there.
let fontIndex = cycleIndexById(activeFont.id);
// A stored font counts as a past choice, so a reload doesn't undo it on the next
// breakpoint crossing.
let fontChosenByUser = !!storedFontId;
const fontToggle = $('fonttoggle');

function currentFont() { return CYCLE_FONTS[fontIndex]; }

function applyFont(font) {
  if (!renderer.setFont(font)) return;   // no-op if it's already active
  activeFont = font;
  fitTerminal();        // aspect changed with the cell height
  dirty = true;         // force a full repaint: setFont dropped the cell cache
}

function updateFontUI() {
  // Lit whenever we're off the default font, matching the other toggles.
  fontToggle.classList.toggle('on', currentFont().id !== DEFAULT_FONT_ID);
  fontToggle.title = `Font: ${currentFont().name}`;
}

fontToggle.addEventListener('click', () => {
  fontIndex = (fontIndex + 1) % CYCLE_FONTS.length;
  fontChosenByUser = true;
  applyFont(currentFont());
  updateFontUI();
  prefs.set('fontId', currentFont().id);
  showToast(`Font: ${currentFont().name}`);
});

// Crossing the mobile breakpoint (rotation, window resize) re-picks the
// automatic default — but never after the user has touched the button.
let wasMobile = isMobile();
window.addEventListener('resize', () => {
  const nowMobile = isMobile();
  if (nowMobile === wasMobile) return;
  wasMobile = nowMobile;
  if (fontChosenByUser) return;
  const want = nowMobile ? mobileDefaultFont() : fontById(DEFAULT_FONT_ID);
  fontIndex = cycleIndexById(want.id);
  applyFont(want);
  updateFontUI();
});
updateFontUI();

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
      body.innerHTML = '<h1>SynthLink</h1><p>Could not load about.html.</p>';
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

// ─── Welcome panel (first visit only) ────────────────────────────────────────
// Shown once, to a browser with no stored preferences at all — the same shell as
// the about panel, and its text comes from welcome.html as a plain HTML
// fragment, so the greeting can be reworded without touching the app.
//
// "Seen it" is recorded the moment it opens, not when it closes: a visitor who
// reloads instead of dismissing has still seen it, and a greeting that keeps
// coming back is worse than one missed. A shared ?connect= link suppresses it
// outright — that visitor gets the Connect prompt, which is the louder and more
// useful of the two — and still counts as welcomed (see maybeAutoConnect).
const WELCOMED_KEY = 'welcomed';
function markWelcomed() { prefs.set(WELCOMED_KEY, true); }

(function welcomePanel() {
  const modal = $('welcomemodal'), body = $('welcomebody'), closeBtn = $('welcomeclose');
  const goBtn = $('welcomego');
  if (!modal || !body) return;

  function close() {
    modal.setAttribute('hidden', '');
    document.removeEventListener('keydown', onKey, true);
  }
  function onKey(e) {
    if (e.key === 'Escape' || e.key === 'Enter') { e.stopPropagation(); close(); }
  }

  async function open() {
    markWelcomed();
    try {
      const r = await fetch('welcome.html', { cache: 'no-cache' });
      if (!r.ok) throw new Error(r.status);
      body.innerHTML = await r.text();
    } catch (_) {
      // The panel is a greeting, not a dependency: if its text can't be
      // fetched, say nothing at all rather than showing an error to someone on
      // their very first visit.
      return;
    }
    modal.removeAttribute('hidden');
    document.addEventListener('keydown', onKey, true);
    if (goBtn) goBtn.focus();
  }

  closeBtn && closeBtn.addEventListener('click', close);
  goBtn && goBtn.addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

  // A shared link that will raise the Connect prompt takes precedence.
  if (prefs.firstVisit && !prefs.get(WELCOMED_KEY) && !(shared.connect && shared.host)) open();
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

  function open() { refresh(); modal.removeAttribute('hidden'); btn.classList.add('on'); }
  function close() { modal.setAttribute('hidden', ''); btn.classList.remove('on'); }

  btn.addEventListener('click', () => (modal.hasAttribute('hidden') ? open() : close()));
  closeBtn.addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  bbsCopy.addEventListener('click', () => copy(bbsField, bbsCopy));
  homeCopy.addEventListener('click', () => copy(homeField, homeCopy));
  // Rebuild in place so the field shows what will be copied, without reopening.
  autoBox && autoBox.addEventListener('change', refresh);
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
  const CYCLE = { t: '⇧#', c: 'mod', cycle: true };
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
      // ⇧# matches its width on the other views; space takes the remainder.
      [u(CYCLE, WIDE), SP, u1(LF), u1(DN), u1(RT)],
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
  // (tools/kbdmodtest.js drives exactly these).
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
  function cancelHold() { clearTimeout(holdTimer); holdTimer = null; }
  function startHold(e, promote) {
    cancelHold();
    holdX = e.clientX; holdY = e.clientY;
    holdTimer = setTimeout(() => {
      holdTimer = null;
      promote();
      if (navigator.vibrate) navigator.vibrate(15);   // Android; iOS ignores it
      render();
    }, LOCK_MS);
  }
  window.addEventListener('pointerup', cancelHold);
  window.addEventListener('pointercancel', cancelHold);
  window.addEventListener('pointermove', (e) => {
    if (!holdTimer) return;
    if (Math.abs(e.clientX - holdX) > LOCK_SLOP ||
        Math.abs(e.clientY - holdY) > LOCK_SLOP) cancelHold();
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
      if (k.cycle) {
        view = (view + 1) % views.length;
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
    cancelHold();
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

// Speaker defaults to Auto; the button reflects that. Audio actually starts on
// the first user gesture (Connect / speaker button), per browser autoplay rules.
updateListenUI();
setStatus('ready — press Connect to dial');

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
