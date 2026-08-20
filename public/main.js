// SynthLink browser client.
//
// Reuses synthdoor's browser render stack (ANSI/CP437 terminal + canvas
// renderer) and drives it from a synthmodem *originate* software modem running
// in the page. Keystrokes are modulated to PCM audio and sent to the server
// over a WebSocket; the server's answer modem demodulates them and forwards to
// a telnet BBS. The BBS's bytes come back as modulated audio, which this page
// demodulates and renders. A Web Audio graph plays the carrier (both
// directions) and feeds a real-time oscilloscope.

import { Terminal, ANSIParser, TelnetFilter } from './terminal.js';
import { Renderer } from './renderer.js';
import { CYCLE_FONTS, fontById, cycleIndexById, mobileDefaultFont,
         DEFAULT_FONT_ID } from './fonts/index.js';
import { ANSIMusic } from './music.js';

const { ModemDSP, config } = window.SynthModemDSP;

const COLS = 80, ROWS = 25;
const SR = 8000;                       // DSP audio rate

// Active terminal font. The grid is always 80x25, so the canvas is always 640
// wide, but its HEIGHT (and therefore the aspect fitTerminal preserves) follows
// the font's cell height: 8x16 -> 640x400, 8x19 -> 640x475 (+18.75% height).
// Pixels stay square either way, since fitTerminal scales width and height by
// the same factor. Narrow screens start on the taller font — they're
// width-constrained with vertical room to spare, so the extra rows are free
// there, whereas a height-constrained desktop would just get a narrower
// terminal. See fonts/index.js.
const startMobile = window.matchMedia('(max-width: 640px)').matches;
let activeFont = startMobile ? mobileDefaultFont() : fontById(DEFAULT_FONT_ID);
const cw = () => COLS * activeFont.cellW;    // 640
const ch = () => ROWS * activeFont.cellH;    // 400 or 475

// ─── DOM ────────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const canvas = $('terminal-canvas');
const wrap = $('wrap');
const hostEl = $('host'), portEl = $('port'), bbsEl = $('bbs');
const hostportEl = $('hostport'), bbsToggle = $('bbstoggle');
const dialBtn = $('dial'), extBtn = $('extension'), listenBtn = $('listen');
const protocolEl = $('protocol');
const led = $('led'), statusEl = $('status');
const scopeCanvas = $('scope'), scopeCtx = scopeCanvas.getContext('2d');

canvas.width = cw(); canvas.height = ch();

// ─── Render stack (reused verbatim from synthdoor) ──────────────────────────
const term     = new Terminal(COLS, ROWS);
const renderer = new Renderer(canvas, COLS, ROWS, activeFont);
const telnet   = new TelnetFilter();
const parser   = new ANSIParser(term);
const music    = new ANSIMusic();

telnet.onData = (bytes) => { parser.feed(bytes); term.scanURLs(); dirty = true; };
telnet.onSend = (b) => modemWrite(b);
term.onSend   = (s) => modemWrite(s);
term.onANSIMusic = (s) => { if (monitor.audible()) music.play(s); };

let dirty = true, cursorOn = true, blinkPhase = true;
let rxBytes = 0, txBytes = 0;            // payload bytes through the modem (both dirs)
let flowBps = 0;                         // smoothed live throughput, shown on the scope

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
  mode: 'auto', autoOn: false,
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

function drawScope() {
  requestAnimationFrame(drawScope);
  const w = scopeCanvas.width, h = scopeCanvas.height;
  if (!w || !h) return;
  scopeCtx.clearRect(0, 0, w, h);

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

  // Live throughput readout — small, bright white, bottom-right justified,
  // superimposed on the trace. Shown only while a carrier is up.
  if (carrier) {
    const dpr = window.devicePixelRatio || 1;
    scopeCtx.font = `${Math.round(11 * dpr)}px ui-monospace, "DejaVu Sans Mono", monospace`;
    scopeCtx.textAlign = 'right'; scopeCtx.textBaseline = 'bottom';
    scopeCtx.shadowColor = '#000'; scopeCtx.shadowBlur = Math.round(2 * dpr);
    scopeCtx.fillStyle = '#ffffff';
    scopeCtx.fillText(`${Math.max(0, Math.round(flowBps))} bps`,
      w - Math.round(6 * dpr), h - Math.round(4 * dpr));
    scopeCtx.shadowBlur = 0;
  }
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
};
function echoMSCommand(sel) {
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

function modemWrite(strOrBytes) {
  if (!dsp || !carrier) return;
  const bytes = (typeof strOrBytes === 'string')
    ? Uint8Array.from(strOrBytes, (c) => c.charCodeAt(0) & 0xff)
    : strOrBytes;
  dsp.write(window.SynthModemDSP.Buffer.from(bytes));
  txBytes += bytes.length;
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
  config.modem.native.protocolPreference = [modemProto];
  config.modem.native.v8ModulationModes  = [modemProto];
  if (modemProto === 'V34') config.modem.native.v34Rate = v34Rate || 33600;

  dialing = true; noCarrierEchoed = false;
  monitor.reset();
  monitor.prime();           // Connect is a user gesture — resume + warm the output device now
  if (monitor.mode === 'auto') { monitor.autoOn = true; monitor._applyGain(); }
  updateListenUI();
  setCallUI(true); extBtn.disabled = true; protocolEl.disabled = true;
  setStatus('opening link…'); setLed('neg');

  // ATDT dial line to the terminal (the human-readable destination).
  termEcho(`\r\nATDT ${host}:${port}\r\n`);

  // Build + start the originate modem. Deferred until the dial audio has played
  // so the DTMF/ringback don't overlap the carrier handshake tones.
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
      extBtn.disabled = false;     // extension pickup only makes sense on a live call
      termEcho(`\r\nCONNECT ${info.bps}\r\n`);
      telnet.negotiate();          // request full-duplex (Suppress Go Ahead)
      // Auto: hold full volume through the handshake, then fade to silence over
      // 10 s like a modem speaker cutting out once the carrier is established.
      if (monitor.mode === 'auto') {
        monitor.autoOn = true; monitor._applyGain(); updateListenUI();
        monitor.startAutoFade(10, () => { monitor.autoOn = false; updateListenUI(); });
      }
    });
    dsp.on('data', (buf) => {
      rxBytes += buf.length;
      telnet.process(new Uint8Array(buf));
    });
    dsp.on('silenceHangup', () => setStatus('carrier lost'));
    dsp.start();
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
        playDialSequence(m.ip).then(startModem);          // dial tone → DTMF → ring → answer, then handshake
        return;
      }
      if (m.type === 'resolveError') {
        setStatus(`no answer (${m.error})`);
        termEcho('\r\nNO CARRIER\r\n'); noCarrierEchoed = true;
        hangup();
        return;
      }
      if (m.type === 'status') setStatus(m.text);
      if (m.type === 'closed') { setStatus(`closed (${m.reason})`); hangup(); }
      return;
    }
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
  setLed('');
}

// ─── Destination: BBS directory (config/bbs.json) + manual host:port ─────────
// One control in two modes. The hidden #host/#port inputs remain the canonical
// state everything else reads; the dropdown and the manual field are just two
// ways to write them. The toggle's glyph always names where it will take you:
// pencil (edit by hand) in directory mode, list (back to the directory) in manual.
let manualMode = false;

function commitHostPort() {
  const [h, p] = hostportEl.value.trim().split(':');
  if (!h) return;
  hostEl.value = h.trim();
  portEl.value = (p || '').trim() || '23';
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
  updateDestUI();
  showToast(manualMode ? 'Manual host:port' : 'BBS directory');
  (manualMode ? hostportEl : bbsEl).focus();
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

function bbsOption(b) {
  const o = document.createElement('option');
  const hp = `${b.host}:${b.port || 23}`;
  o.value = hp;
  // "Name · host:port" — same dot separator the speed menu uses.
  o.textContent = b.name ? `${b.name} · ${hp}` : hp;
  return o;
}

async function loadBBS() {
  try {
    const dir = await (await fetch('/bbs.json')).json();
    // Tolerate the old flat-array format from a stale server.
    const curated = Array.isArray(dir) ? dir : (dir.curated || []);
    const guide   = Array.isArray(dir) ? []  : (dir.guide   || []);
    bbsEl.innerHTML = '';
    if (!curated.length && !guide.length) {
      const o = document.createElement('option');
      o.textContent = '(no directory)'; bbsEl.appendChild(o); return;
    }
    if (curated.length) {
      const g = document.createElement('optgroup');
      g.label = 'Featured';
      for (const b of curated) g.appendChild(bbsOption(b));
      bbsEl.appendChild(g);
    }
    // Drawn from across both tiers, unweighted — with ~1000 guide entries to a
    // handful of featured ones, this is in practice a random guide board.
    const pool = [...curated, ...guide];
    if (pool.length > 1) {
      const g = document.createElement('optgroup');
      g.label = 'Random';
      const o = document.createElement('option');
      o.value = RANDOM_VALUE;
      o.textContent = `Random BBS · ${pool.length} listed`;
      g.appendChild(o);
      bbsEl.appendChild(g);
    }
    if (guide.length) {
      const g = document.createElement('optgroup');
      g.label = `Telnet BBS Guide (${guide.length})`;
      for (const b of guide) g.appendChild(bbsOption(b));
      bbsEl.appendChild(g);
    }
    bbsEl.title = guide.length
      ? `${curated.length} featured + ${guide.length} from telnetbbsguide.com`
      : 'BBS directory (config/curated.txt)';
    syncBBSSelection();
    bbsEl.addEventListener('change', () => {
      if (bbsEl.value === RANDOM_VALUE) {
        const pick = pool[Math.floor(Math.random() * pool.length)];
        const hp = `${pick.host}:${pick.port || 23}`;
        hostEl.value = pick.host; portEl.value = String(pick.port || 23);
        bbsEl.value = hp;         // snap to the drawn entry — never left on Random
        showToast(pick.name ? `Random: ${pick.name}` : `Random: ${hp}`);
        return;
      }
      const [h, p] = bbsEl.value.split(':');
      hostEl.value = h; portEl.value = p || '23';
    });
  } catch (e) {
    bbsEl.innerHTML = '<option>(directory unavailable)</option>';
  }
}
updateDestUI();
loadBBS();

// ─── Keyboard ────────────────────────────────────────────────────────────────
function keyToSeq(e) {
  if (e.ctrlKey && !e.altKey && !e.metaKey) {
    const k = e.key.toUpperCase();
    if (k.length === 1 && k >= 'A' && k <= 'Z') return String.fromCharCode(k.charCodeAt(0) - 64);
    if (e.key === '[') return '\x1B';
    if (e.key === '\\') return '\x1C';
    if (e.key === ']') return '\x1D';
  }
  switch (e.key) {
    case 'Enter': return '\r';       case 'Backspace': return '\x7F';
    case 'Delete': return '\x1B[3~'; case 'Tab': return e.shiftKey ? '\x1B[Z' : '\t';
    case 'Escape': return '\x1B';
    case 'ArrowUp': return '\x1B[A'; case 'ArrowDown': return '\x1B[B';
    case 'ArrowRight': return '\x1B[C'; case 'ArrowLeft': return '\x1B[D';
    case 'Home': return '\x1B[1~';   case 'End': return '\x1B[4~';
  }
  if (!e.ctrlKey && !e.altKey && !e.metaKey && e.key.length === 1) return e.key;
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
let scrollbackEnabled = !isMobile();

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
  // after a call too), but only when scrollback is enabled. PageUp/Down = one
  // screen; Shift+Up/Down = a few lines; Shift+Home/End = top / live.
  if (scrollbackEnabled) {
  if (e.key === 'PageUp'   || (e.shiftKey && e.key === 'ArrowUp'))   { e.preventDefault(); term.scrollbackUp(e.key === 'PageUp' ? ROWS - 1 : 3);   afterScroll(); return; }
  if (e.key === 'PageDown' || (e.shiftKey && e.key === 'ArrowDown')) { e.preventDefault(); term.scrollbackDown(e.key === 'PageDown' ? ROWS - 1 : 3); afterScroll(); return; }
  if (e.shiftKey && e.key === 'Home') { e.preventDefault(); term.scrollbackHome(); afterScroll(); return; }
  if (e.shiftKey && e.key === 'End')  { e.preventDefault(); term.scrollbackEnd();  afterScroll(); return; }
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
  // Allow scrollback keys and (with carrier) typing even when the canvas isn't focused.
  const nav = e.key === 'PageUp' || e.key === 'PageDown' ||
    (e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Home' || e.key === 'End'));
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
let zoomLevel = 0;            // index into ZOOM_LEVELS
const zoomFactor = () => ZOOM_LEVELS[zoomLevel];
const zoomEnabled = () => zoomFactor() > 0;
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

// Swipe owns vertical drags only when there is history to scroll through.
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
  showToast(scrollbackEnabled ? 'Scrollback ON' : 'Scrollback OFF');
});
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
let fontChosenByUser = false;   // once true, resize stops overriding the choice
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
  zoomToggle.classList.toggle('on', zoomLevel === 1);
  icon.classList.toggle('off', !zoomEnabled());
  icon.textContent = zoomEnabled() ? `${z}×` : '\u{1F50D}';
  zoomToggle.title = zoomEnabled() ? `Zoom magnification: ${z}×` : 'Zoom disabled';
}

zoomToggle.addEventListener('click', () => {
  zoomLevel = (zoomLevel + 1) % ZOOM_LEVELS.length;
  zoomOff();                      // any in-flight zoom used the old factor
  updateZoomUI();
  showToast(zoomEnabled()
    ? `Zoom ${zoomFactor()}× when you touch the terminal`
    : 'Zoom disabled');
});
updateZoomUI();

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
  showToast(`Speaker: ${LISTEN_LABEL[monitor.mode]}`);
});
protocolEl.addEventListener('change', () => echoMSCommand(protocolEl.value));
hostportEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { commitHostPort(); connect(); } });
hostportEl.addEventListener('change', commitHostPort);

// ─── On-screen keyboard (mostly for mobile) ──────────────────────────────────
// Data-driven so it's easy to maintain: each view is rows (or, for the numpad
// view, two pads + a foot) of key defs. A key is { t:label, s:bytesToSend,
// c:cssClass, w:flexGrow }; `cycle:true` advances the view; `{blank:true}` is an
// explicit empty slot — kept in the data so a missing key can simply replace it
// later without reflowing anything. One ⇧# key cycles the four views.
const kbdEl = $('keyboard'), kbdToggle = $('kbdtoggle');
(function buildKeyboard() {
  const chr   = (ch, c) => ({ t: ch, s: ch, c });           // a key that sends itself
  const chars = (s) => [...s].map((ch) => chr(ch));
  const fn    = (n, seq) => ({ t: 'F' + n, s: seq, c: 'fn' });
  const nav   = (t, seq) => ({ t, s: seq, c: 'mod' });
  const BLANK = { blank: true };
  const CYCLE = { t: '⇧#', c: 'mod', cycle: true };
  const SP  = { t: 'space', s: ' ', c: 'acc', w: 6 };
  const ENT = { t: '⏎', s: '\r', c: 'acc' };
  const BK  = { t: '⌫', s: '\x7F', c: 'mod' };
  const UP = { t: '↑', s: '\x1B[A' }, DN = { t: '↓', s: '\x1B[B' },
        LF = { t: '←', s: '\x1B[D' }, RT = { t: '→', s: '\x1B[C' };
  const ESC = { t: 'Esc', s: '\x1B', c: 'mod' }, TAB = { t: 'Tab', s: '\t', c: 'mod' };
  const F = [null, fn(1,'\x1BOP'), fn(2,'\x1BOQ'), fn(3,'\x1BOR'), fn(4,'\x1BOS'),
    fn(5,'\x1B[15~'), fn(6,'\x1B[17~'), fn(7,'\x1B[18~'), fn(8,'\x1B[19~'),
    fn(9,'\x1B[20~'), fn(10,'\x1B[21~'), fn(11,'\x1B[23~'), fn(12,'\x1B[24~')];
  const INS = nav('Ins','\x1B[2~'), DEL = nav('Del','\x1B[3~'), HOME = nav('Home','\x1B[1~'),
        END = nav('End','\x1B[4~'), PGUP = nav('PgUp','\x1B[5~'), PGDN = nav('PgDn','\x1B[6~');

  const views = [
    // View 1 — letters (lowercase) + digits
    { kind: 'rows', rows: [
      chars('1234567890'),
      chars('qwertyuiop'),
      chars('asdfghjkl'),
      [BK, ...chars('zxcvbnm'), UP, ENT],
      [CYCLE, SP, LF, DN, RT],
    ]},
    // View 2 — letters (UPPERCASE) + function keys
    { kind: 'rows', rows: [
      [F[1],F[2],F[3],F[4],F[5],F[6],F[7],F[8],F[9],F[10]],
      chars('QWERTYUIOP'),
      chars('ASDFGHJKL'),
      [BK, ...chars('ZXCVBNM'), UP, ENT],
      [CYCLE, SP, LF, DN, RT],
    ]},
    // View 3 — symbols (F11/F12 as overflow; blanks reserved for future keys)
    { kind: 'rows', rows: [
      chars('!@#$%^&*()'),
      chars('`~-_=+[]{}'),
      chars('\\|;:\'",.<>'),
      [BK, chr('/'), chr('?'), BLANK, BLANK, BLANK, F[11], F[12], UP, ENT],
      [CYCLE, SP, LF, DN, RT],
    ]},
    // View 4 — numeric keypad + navigation
    { kind: 'pads',
      num: [ chr('7'), chr('8'), chr('9'), chr('/','mod'),
             chr('4'), chr('5'), chr('6'), chr('*','mod'),
             chr('1'), chr('2'), chr('3'), chr('-','mod'),
             BLANK,    chr('0'), chr('.'), chr('+','mod') ],   // 0 centered under 2
      nav: [ INS, HOME, PGUP,  DEL, END, PGDN,  ESC, UP, TAB,  LF, DN, RT ],
      foot: [ CYCLE, SP, ENT, BK ],
    },
  ];
  let view = 0;
  // Views that revert to view 0 (lowercase) after a keypress — the shift-like
  // ones. The numpad (3) is absent on purpose: it stays until you cycle out.
  const ONE_SHOT_VIEWS = [1, 2];

  function keyEl(k) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'kbk';
    if (k.blank) { b.className += ' blank'; b.tabIndex = -1; return b; }
    if (k.c) b.className += ' ' + k.c;
    if (k.w) b.style.flex = k.w + ' 1 0';
    b.textContent = k.t;
    // pointerdown (not click) so it fires without stealing focus and doesn't
    // double-fire on touch; preventDefault keeps the terminal/page from scrolling.
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (k.cycle) { view = (view + 1) % views.length; render(); return; }
      if (k.s != null) modemWrite(k.s);
      // CAPS and SYMBOLS are one-shot, like a shift key: after any keypress
      // drop back to lowercase, which is what you want next far more often than
      // a second capital. The NUMPAD is deliberately sticky — you go there to
      // type a run of digits or to navigate, not for a single key.
      if (ONE_SHOT_VIEWS.indexOf(view) >= 0) { view = 0; render(); }
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
      pads.appendChild(num); pads.appendChild(navp);
      kbdEl.appendChild(pads);
      kbdEl.appendChild(rowEl(v.foot, 'foot'));
    }
  }

  function setOpen(show) {
    if (show === !kbdEl.hasAttribute('hidden')) return;   // already there
    if (show) { kbdEl.removeAttribute('hidden'); render(); }
    else kbdEl.setAttribute('hidden', '');
    kbdToggle.classList.toggle('on', show);
    document.body.classList.toggle('kbd-open', show);   // enables mobile page-scroll layout
    fitTerminal();                                       // reflow terminal + keyboard width
    if (show) kbdEl.scrollIntoView({ block: 'nearest' });
  }
  kbdToggle.addEventListener('click', () => setOpen(kbdEl.hasAttribute('hidden')));

  // Published for the terminal touch handler (first-touch-opens-keyboard).
  keyboardIsOpen = () => !kbdEl.hasAttribute('hidden');
  openKeyboard = () => setOpen(true);
})();

// Speaker defaults to Auto; the button reflects that. Audio actually starts on
// the first user gesture (Connect / speaker button), per browser autoplay rules.
updateListenUI();
setStatus('ready — press Connect to dial');

// Echo the modem init string + the initial modulation-select on startup, so the
// terminal opens looking like a freshly-initialised modem ready to dial.
termEcho(`${MODEM_INIT}\r\nOK\r\n`);
echoMSCommand(protocolEl.value);
