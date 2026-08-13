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
term.onANSIMusic = (s) => { if (monitor.enabled) music.play(s); };

let dirty = true, cursorOn = true, blinkPhase = true;
let rxBytes = 0;

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
  const availW = wrap.clientWidth, availH = wrap.clientHeight;
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
  ctx: null, analyser: null, gain: null, enabled: true,
  cursor: { tx: 0, rx: 0 },
  pending: { tx: [], rx: [] },
  flushTimer: null,
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
  _applyGain() { if (this.gain) this.gain.gain.value = this.enabled ? 0.25 : 0.0; },
  setEnabled(b) { this.enabled = b; this._applyGain(); },
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
    const at = Math.max(this.ctx.currentTime + 0.15, this.cursor[which]);
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
function sizeScope() {
  const dpr = window.devicePixelRatio || 1;
  scopeCanvas.width  = Math.round(scopeCanvas.clientWidth  * dpr);
  scopeCanvas.height = Math.round(scopeCanvas.clientHeight * dpr);
}
function drawScope() {
  requestAnimationFrame(drawScope);
  const w = scopeCanvas.width, h = scopeCanvas.height;
  if (!w || !h) return;
  scopeCtx.clearRect(0, 0, w, h);

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
  scopeCtx.lineWidth = Math.max(1, (window.devicePixelRatio || 1) * 1.2);
  scopeCtx.shadowColor = '#33ff66';
  scopeCtx.shadowBlur = (window.devicePixelRatio || 1) * 3;
  scopeCtx.beginPath();
  for (let i = 0; i < show; i++) {
    const x = (i / (show - 1)) * w;
    let y = h / 2 - scopeData[i] * vgain;
    if (y < 1) y = 1; else if (y > h - 1) y = h - 1;
    if (i === 0) scopeCtx.moveTo(x, y); else scopeCtx.lineTo(x, y);
  }
  scopeCtx.stroke();
  scopeCtx.shadowBlur = 0;
}
sizeScope();
requestAnimationFrame(drawScope);

// ─── Modem link ─────────────────────────────────────────────────────────────
let ws = null, dsp = null, carrier = false;

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
}

function connect() {
  const host = hostEl.value.trim(), port = portEl.value.trim() || '23';
  if (!host) return;
  const modemProto = protocolEl.value || 'V21';
  config.modem.native.protocolPreference = [modemProto];
  config.modem.native.v8ModulationModes  = [modemProto];
  monitor.ensure();          // Connect is a user gesture — unlocks/resumes audio
  monitor.reset();
  dialBtn.disabled = true; hangupBtn.disabled = false; protocolEl.disabled = true;
  setStatus('opening link…'); setLed('neg');

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'dial', host, port, protocol: modemProto }));
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
    });
    dsp.on('data', (buf) => {
      rxBytes += buf.length;
      telnet.process(new Uint8Array(buf));
    });
    dsp.on('silenceHangup', () => setStatus('carrier lost'));
    dsp.start();
  };

  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
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
  monitor.reset();
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
function onKey(e) {
  if (!carrier) return;
  const seq = keyToSeq(e);
  if (seq === null) return;
  e.preventDefault();
  modemWrite(seq);
}
canvas.addEventListener('keydown', onKey);
window.addEventListener('keydown', (e) => { if (document.activeElement !== canvas && carrier) onKey(e); });
canvas.addEventListener('click', () => canvas.focus());

// ─── Buttons ─────────────────────────────────────────────────────────────────
dialBtn.addEventListener('click', connect);
hangupBtn.addEventListener('click', hangup);
listenBtn.addEventListener('click', () => {
  monitor.ensure();
  monitor.setEnabled(!monitor.enabled);
  listenBtn.classList.toggle('on', monitor.enabled);
  listenBtn.querySelector('.spk').textContent = monitor.enabled ? '\u{1F50A}' : '\u{1F507}';
});
hostEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') connect(); });
portEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') connect(); });

// Listen defaults ON; the button reflects that. Audio actually starts on the
// first user gesture (Connect / Listen), per browser autoplay rules.
listenBtn.classList.toggle('on', monitor.enabled);
setStatus('ready — press Connect to dial');
