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
import { ANSIMusic } from './music.js';

const { ModemDSP, config } = window.SynthModemDSP;

const COLS = 80, ROWS = 25;
const CW = COLS * 8, CH = ROWS * 16;   // 640 x 400
const SR = 8000;                       // DSP audio rate

// ─── DOM ────────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const canvas = $('terminal-canvas');
const wrap = $('wrap');
const hostEl = $('host'), portEl = $('port'), bbsEl = $('bbs');
const dialBtn = $('dial'), hangupBtn = $('hangup'), listenBtn = $('listen');
const protocolEl = $('protocol');
const led = $('led'), statusEl = $('status');
const scopeCanvas = $('scope'), scopeCtx = scopeCanvas.getContext('2d');

canvas.width = CW; canvas.height = CH;

// ─── Render stack (reused verbatim from synthdoor) ──────────────────────────
const term     = new Terminal(COLS, ROWS);
const renderer = new Renderer(canvas, COLS, ROWS);
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

// ─── Terminal fit-to-window (preserve 640:400 aspect) ───────────────────────
function fitTerminal() {
  const M = 3;                            // ~3px breathing room around the canvas
  const availW = wrap.clientWidth - 2 * M, availH = wrap.clientHeight - 2 * M;
  const aspect = CW / CH;                 // 1.6
  let w = availW, h = w / aspect;
  if (h > availH) { h = availH; w = h * aspect; }
  canvas.style.width = Math.floor(w) + 'px';
  canvas.style.height = Math.floor(h) + 'px';
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

// ─── Modem link ─────────────────────────────────────────────────────────────
let ws = null, dsp = null, carrier = false;
let dialing = false;          // true from Connect press until cleanup
let noCarrierEchoed = false;  // ensures a single NO CARRIER per call
// Speaker button reflects the tri-state mode; the icon reflects live audibility.
function updateListenUI() {
  const on = monitor.audible();
  const label = monitor.mode.charAt(0).toUpperCase() + monitor.mode.slice(1);
  listenBtn.classList.toggle('on', monitor.mode !== 'mute');
  listenBtn.querySelector('.spk').textContent = on ? '\u{1F50A}' : '\u{1F507}';
  listenBtn.querySelector('.lbl').textContent = label;
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
  dialBtn.disabled = true; hangupBtn.disabled = false; protocolEl.disabled = true;
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
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(floatToInt16(f32));
      monitor.feed('tx', f32);
    });
    dsp.on('connected', (info) => {
      carrier = true;
      console.log(`[modem] CARRIER UP ${info.protocol} @ ${info.bps} bps`);
      setStatus(`carrier ${info.protocol} @ ${info.bps} bps — connected`);
      setLed('up'); canvas.focus();
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
    if (dsp) dsp.receiveAudio(f32);
    monitor.feed('rx', f32);
  };

  ws.onclose = () => { if (carrier || dsp) setStatus('link closed'); cleanup(); };
  ws.onerror = () => setStatus('link error');
}

function hangup() { try { ws && ws.close(); } catch {} cleanup(); }

function cleanup() {
  carrier = false;
  if (dsp) { try { dsp.stop(); } catch {} dsp = null; }
  ws = null;
  monitor.cancelAutoFade();
  monitor.reset();
  monitor._stopKeepAlive();  // let the context auto-suspend between calls
  // A dropped carrier or failed dial prints NO CARRIER, once per call.
  if (dialing && !noCarrierEchoed) { termEcho('\r\nNO CARRIER\r\n'); noCarrierEchoed = true; }
  dialing = false;
  if (monitor.mode === 'auto') { monitor.autoOn = false; monitor._applyGain(); }
  updateListenUI();
  dialBtn.disabled = false; hangupBtn.disabled = true; protocolEl.disabled = false;
  setLed('');
}

// ─── BBS directory (config/bbs.json) ─────────────────────────────────────────
async function loadBBS() {
  try {
    const list = await (await fetch('/bbs.json')).json();
    bbsEl.innerHTML = '';
    if (!Array.isArray(list) || !list.length) {
      const o = document.createElement('option');
      o.textContent = '(no directory)'; bbsEl.appendChild(o); return;
    }
    for (const b of list) {
      const o = document.createElement('option');
      o.value = `${b.host}:${b.port || 23}`;
      o.textContent = b.name || `${b.host}:${b.port || 23}`;
      bbsEl.appendChild(o);
    }
    // Reflect the current host/port in the dropdown if it matches an entry.
    const cur = `${hostEl.value.trim()}:${portEl.value.trim()}`;
    if ([...bbsEl.options].some(o => o.value === cur)) bbsEl.value = cur;
    bbsEl.addEventListener('change', () => {
      const [h, p] = bbsEl.value.split(':');
      hostEl.value = h; portEl.value = p || '23';
    });
  } catch (e) {
    bbsEl.innerHTML = '<option>(directory unavailable)</option>';
  }
}
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
  // after a call too). PageUp/Down = one screen; Shift+Up/Down = a few lines;
  // Shift+Home/End = top / live.
  if (e.key === 'PageUp'   || (e.shiftKey && e.key === 'ArrowUp'))   { e.preventDefault(); term.scrollbackUp(e.key === 'PageUp' ? ROWS - 1 : 3);   afterScroll(); return; }
  if (e.key === 'PageDown' || (e.shiftKey && e.key === 'ArrowDown')) { e.preventDefault(); term.scrollbackDown(e.key === 'PageDown' ? ROWS - 1 : 3); afterScroll(); return; }
  if (e.shiftKey && e.key === 'Home') { e.preventDefault(); term.scrollbackHome(); afterScroll(); return; }
  if (e.shiftKey && e.key === 'End')  { e.preventDefault(); term.scrollbackEnd();  afterScroll(); return; }

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
  if (term.scrollbackLength === 0) return;
  e.preventDefault();
  const lines = Math.max(1, Math.ceil(Math.abs(e.deltaY) / 24));
  if (e.deltaY < 0) term.scrollbackUp(lines); else term.scrollbackDown(lines);
  afterScroll();
}, { passive: false });

// Touch swipe: scroll history on vertical drags.
let _touchY = 0;
canvas.addEventListener('touchstart', (e) => { _touchY = e.touches[0].clientY; }, { passive: true });
canvas.addEventListener('touchmove', (e) => {
  if (term.scrollbackLength === 0) return;
  const dy = _touchY - e.touches[0].clientY;
  if (Math.abs(dy) > 15) {
    e.preventDefault();
    if (dy > 0) term.scrollbackUp(1); else term.scrollbackDown(1);
    _touchY = e.touches[0].clientY;
    afterScroll();
  }
}, { passive: false });

// ─── Buttons ─────────────────────────────────────────────────────────────────
dialBtn.addEventListener('click', connect);
hangupBtn.addEventListener('click', hangup);
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
});
protocolEl.addEventListener('change', () => echoMSCommand(protocolEl.value));
hostEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') connect(); });
portEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') connect(); });

// Speaker defaults to Auto; the button reflects that. Audio actually starts on
// the first user gesture (Connect / speaker button), per browser autoplay rules.
updateListenUI();
setStatus('ready — press Connect to dial');

// Echo the modem init string + the initial modulation-select on startup, so the
// terminal opens looking like a freshly-initialised modem ready to dial.
termEcho(`${MODEM_INIT}\r\nOK\r\n`);
echoMSCommand(protocolEl.value);
