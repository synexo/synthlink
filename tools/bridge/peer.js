'use strict';
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The SynthLink half of the BinModem bridge. Runs one SynthLink protocol class
// against `bmpeer` (BinModem's datapump behind a pipe) in lockstep blocks, and
// returns both ends' timelines.
//
// DEVELOPMENT ONLY. `available()` says whether the Rust peer has been built;
// every caller must SKIP when it has not, so a clone without Rust loses this tier
// and nothing else. Build it with:
//
//     cargo build --release --manifest-path tools/bridge/Cargo.toml
//
// The line between the two ends is one of:
//   '4wire'  each end hears only the other, after `delay` samples each way
//   '2wire'  each end hears the other after `delay`, plus its OWN transmit
//            returned at `echo` (linear gain) after `echoDelay` samples, which is
//            what a hybrid does. bmpeer adds BinModem's own return sample-exactly;
//            this file adds SynthLink's. BinModem cancels its own; SynthLink has
//            nothing to cancel with yet
// V.90 ignores both: bmpeer puts BinModem's own G.711 network model in the path.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const BIN = path.join(__dirname, 'target', 'release', process.platform === 'win32' ? 'bmpeer.exe' : 'bmpeer');
const SR = 8000;
const BLOCK = 160;

function available() {
  if (fs.existsSync(BIN)) return { ok: true };
  return { ok: false, reason: `bmpeer not built (cargo build --release --manifest-path tools/bridge/Cargo.toml)` };
}

/**
 * A far end on its own clock: a stream resampled by `ratio` (output samples per
 * input sample is 1/ratio — ratio 1 + 1e-4 is a far clock 100 ppm fast, whose
 * samples arrive here slightly compressed). Windowed-sinc interpolation, 16 taps
 * each side, so what it adds is far below anything a modem should notice: the
 * point is to test clock drift, not to add noise that looks like it. Keeps a
 * short FIFO so each call still returns exactly as many samples as it is given.
 */
function resampler(ratio) {
  if (ratio === 1) return x => x;
  const H = 16, buf = [], frac = { t: H };
  const sinc = v => (v === 0 ? 1 : Math.sin(Math.PI * v) / (Math.PI * v));
  const win = v => (Math.abs(v) >= H ? 0 : 0.5 + 0.5 * Math.cos(Math.PI * v / H));
  // One output per input, so a ratio above 1 reads faster than samples arrive and
  // the read point gains on the newest sample by (ratio − 1) a sample. Starting it
  // with only H of lookahead lost a tap of the interpolator every 1.25 s at
  // +100 ppm, which fed the receiver a filter missing a third of its right side by
  // six seconds in. So the lookahead starts at H plus the drift of two minutes.
  const ahead = ratio > 1 ? Math.ceil((ratio - 1) * 8000 * 120) : 0;
  for (let i = 0; i < 2 * H + ahead; i++) buf.push(0);   // primed, so output starts at once
  return (block) => {
    for (const x of block) buf.push(x);
    const out = new Float32Array(block.length);
    for (let k = 0; k < block.length; k++) {
      const t = frac.t, n0 = Math.floor(t);
      let y = 0;
      for (let j = n0 - H + 1; j <= n0 + H; j++) {
        if (j < 0 || j >= buf.length) continue;
        const d = t - j; y += buf[j] * sinc(d) * win(d);
      }
      out[k] = y;
      frac.t += ratio;
    }
    // Drop what no later output can reach, keeping the time base continuous.
    const keep = Math.floor(frac.t) - H - 1;
    if (keep > 0) { buf.splice(0, keep); frac.t -= keep; }
    return out;
  };
}

/** A delay line of `n` samples; n = 0 passes straight through. */
function delayLine(n) {
  const ring = new Float32Array(Math.max(1, n));
  let at = 0;
  return x => {
    if (n === 0) return x;
    const y = ring[at]; ring[at] = x; at = (at + 1) % n; return y;
  };
}

/**
 * The line's loss and noise, one direction. BinModem's own test line
 * (datapump/src/v34/control/tests.rs, `Line`) is the model: a gain, and white
 * noise from a xorshift uniform at a fixed power. Noise is ABSOLUTE, as on a
 * telephone line, quoted as `noiseDb` under a full-scale sine (0.707 rms) across
 * the voice band 300–3400 Hz; at 8 kHz the whole band holds 10·log10(4000/3100)
 * = 1.1 dB more. Deterministic: the same seed is the same noise.
 *
 * @param {object} c  { lossDb = 0, noiseDb = Infinity (none), seed }
 * @returns {function(Float32Array): Float32Array}
 */
const VOICE_BAND_DB = 10 * Math.log10(4000 / 3100);
function lineDirection(c = {}) {
  const gain = Math.pow(10, -(c.lossDb || 0) / 20);
  const nd = c.noiseDb == null ? Infinity : c.noiseDb;
  // Uniform on ±1 has rms 1/√3, so this is the rms the dB names, whole band.
  const amp = Number.isFinite(nd) ? Math.SQRT1_2 * Math.pow(10, -(nd - VOICE_BAND_DB) / 20) * Math.sqrt(3) : 0;
  let seed = (c.seed || 0x12345678) >>> 0;
  const uniform = () => {
    seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0;
    return 2 * (seed / 0xffffffff - 0.5);
  };
  return (x) => {
    const y = new Float32Array(x.length);
    for (let k = 0; k < x.length; k++) y[k] = x[k] * gain + (amp ? amp * uniform() : 0);
    return y;
  };
}

/**
 * A dispersive line: the FIR of a voice-band channel with amplitude tilt and
 * group-delay distortion. A parametric model, not a standard's test line.
 * `tiltDb` more loss at 3400 Hz than at 300 (linear in dB between, constant
 * outside), and group delay rising as a parabola from its minimum at 1700 Hz to
 * `edgeDelayMs` more at 300 and 3400 Hz: what a loaded loop and a carrier channel
 * do to a modem. The passband's half-amplitude points are `lowHz` and `highHz`
 * (raised-cosine edges 200 Hz wide), 150 and 3800 by default. That is a good line
 * deliberately: V.34's S at 3429 baud puts its energy at 245 and 3673 Hz, and a
 * 300–3400 band makes it invisible, which only a probe analysis choosing a lower
 * symbol rate can answer. Built by frequency sampling on an N-point grid and
 * windowed; the bulk delay is N/2 samples.
 *
 * @param {object} c  { tiltDb = 0, edgeDelayMs = 0, lowHz = 150, highHz = 3800, N = 256 }
 * @returns {Float64Array} taps
 */
function lineFilter(c = {}) {
  const N = c.N || 256, tilt = c.tiltDb || 0, edge = (c.edgeDelayMs || 0) / 1000;
  const SRf = 8000, f0 = 300, f1 = 3400, fm = (f0 + f1) / 2, half = (f1 - f0) / 2;
  const lo = c.lowHz || 150, hi = c.highHz || 3800;
  const mag = f => {
    let edgeW = 1;
    if (f < lo - 100 || f > hi + 100) edgeW = 0;
    else if (f < lo + 100) edgeW = 0.5 - 0.5 * Math.cos(Math.PI * (f - (lo - 100)) / 200);
    else if (f > hi - 100) edgeW = 0.5 + 0.5 * Math.cos(Math.PI * (f - (hi - 100)) / 200);
    const fc = Math.min(f1, Math.max(f0, f));
    return edgeW * Math.pow(10, -tilt * (fc - f0) / (f1 - f0) / 20);
  };
  // Group delay τ(f) = edge·((f − fm)/half)²; phase is −2π∫τ df, from 0 at DC.
  // The parabola's integral from fm: edge·(f−fm)³/(3·half²); offset so φ(0) = 0.
  const phi = f => -2 * Math.PI * edge * (Math.pow(f - fm, 3) + Math.pow(fm, 3)) / (3 * half * half);
  const h = new Float64Array(N);
  for (let n = 0; n < N; n++) {
    let acc = 0;
    for (let k = 0; k <= N / 2; k++) {
      const f = k * SRf / N, w = (k === 0 || k === N / 2) ? 1 : 2;
      acc += w * mag(f) * Math.cos(2 * Math.PI * k * (n - N / 2) / N + phi(f));
    }
    // Hann window: the response's tails are what the distortion spreads.
    h[n] = acc / N * (0.5 - 0.5 * Math.cos(2 * Math.PI * (n + 0.5) / N));
  }
  return h;
}

/** A running FIR, one block at a time. */
function firStream(taps) {
  const L = taps.length, hist = new Float64Array(L);
  let at = 0;
  return (x) => {
    const y = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) {
      hist[at] = x[i];
      let acc = 0, j = at;
      for (let k = 0; k < L; k++) { acc += taps[k] * hist[j]; j = j === 0 ? L - 1 : j - 1; }
      y[i] = acc; at = (at + 1) % L;
    }
    return y;
  };
}

/**
 * Run one call.
 *
 * @param {object} o
 * @param {object} o.synth     a SynthLink protocol instance (generateAudio /
 *                             receiveAudio / write, emits 'ready' and 'data')
 * @param {string[]} o.peer    bmpeer arguments (--proto, --role, ...)
 * @param {number} o.secs      how long to run, in seconds of line
 * @param {string} [o.line]    '4wire' (default) or '2wire'
 * @param {number} [o.delay]   samples each way
 * @param {number} [o.echo]    2-wire: own-transmit return gain
 * @param {number} [o.echoDelay] 2-wire: samples before it returns
 * @param {boolean} [o.bmEcho] 2-wire: false keeps BinModem's own echo off, so
 *                             only SynthLink hears itself. For a protocol whose
 *                             BinModem side has no canceller (its V.34)
 * @param {number} [o.lossDb]  line loss each way, dB (lineDirection)
 * @param {number} [o.bmLevelDb] BinModem's transmit level, relative to its own
 *                             (it drives near full scale, about −3 dBFS, against
 *                             our −14 to −20). bmpeer cannot set it, so its output
 *                             is scaled by this on the way to us and ours by the
 *                             inverse on the way to it. Since its echo is relative
 *                             to its own transmit, every ratio either receiver
 *                             sees is then a BinModem that much quieter
 * @param {object} [o.disperse] { tiltDb, edgeDelayMs }: both directions through
 *                             lineFilter, as a carrier channel does to each
 * @param {number} [o.noiseDb] white noise at each receiver, dB under a full-scale
 *                             sine in the voice band (lineDirection); added after
 *                             the loss, so a lossy line is also a noisier one
 * @param {number} [o.bmOutDb] BinModem's output alone, in dB (−13 puts it at a
 *                             modem's −10 dBm0); our level toward it is unchanged
 * @param {object} [o.worse]   { at, until, noiseDb, only }: from `at` seconds (to
 *                             `until`, if given) the noise is noiseDb instead, both
 *                             ways or `only` toward 'bm' or 'sl' — a line that
 *                             degrades mid-call, which is what makes a modem
 *                             retrain, and one end rather than the other
 * @param {Array}  [o.at]      [[seconds, fn(synth)], ...]: each run once, at that
 *                             time from the call's start (a retrain asked for, a
 *                             second write)
 * @param {string} [o.send]    text SynthLink writes once it is ready
 * @param {number} [o.sendDelay] seconds of line after ready before writing it
 *                             (default 0) — the pause a person at a terminal
 *                             gives, and what bmpeer's --send-delay gives BinModem
 * @param {function} [o.stopWhen] (result) => bool, checked every block
 * @param {function} [o.probe] (synth) => string, recorded on change, for
 *                             instrumenting receiver state without editing it
 * @param {number} [o.ppm]    far-end clock offset: BinModem's samples reach SynthLink
 *                             resampled by 1 + ppm·1e-6 and ours reach it by the
 *                             inverse, as a modem on its own crystal is heard
 * @param {boolean} [o.realtime] never run ahead of the wall clock. Needed where
 *                             the SynthLink side times something with timers
 *                             rather than samples — Handshake.js ends FSK training
 *                             on a setTimeout — which a faster-than-real-time
 *                             lockstep would outrun
 * @returns {Promise<object>} { bm: [events], sl: [{t, describe}], probe: [{t, v}],
 *                              slReady: {t, info}|null, slRx: Buffer, bmRx: Buffer,
 *                              bmConnected: event|null, exit: code }
 */
function call(o) {
  const av = available();
  if (!av.ok) return Promise.reject(new Error(av.reason));
  const line = o.line || '4wire';
  const res = { bm: [], sl: [], probe: [], slReady: null, slRx: [], bmRx: [], bmConnected: null, exit: null };
  const echo = line === '2wire' ? (o.echo == null ? 0.25 : o.echo) : 0;
  const echoDelay = o.echoDelay || 0;
  const peerArgs = [...o.peer, '--block', String(BLOCK)];
  if (echo && o.bmEcho !== false) peerArgs.push('--echo', String(echo), '--echo-delay', String(echoDelay));
  const child = spawn(BIN, peerArgs, { stdio: ['pipe', 'pipe', 'pipe'] });

  let errBuf = '';
  child.stderr.on('data', b => {
    errBuf += b.toString('utf8');
    let nl;
    while ((nl = errBuf.indexOf('\n')) >= 0) {
      const ln = errBuf.slice(0, nl); errBuf = errBuf.slice(nl + 1);
      if (!ln.trim()) continue;
      let ev; try { ev = JSON.parse(ln); } catch { ev = { ev: 'raw', text: ln }; }
      res.bm.push(ev);
      if (ev.ev === 'connected' && !res.bmConnected) res.bmConnected = ev;
      if (ev.ev === 'rx') for (let i = 0; i < ev.hex.length; i += 2) res.bmRx.push(parseInt(ev.hex.slice(i, i + 2), 16));
    }
  });
  let pending = Buffer.alloc(0), waiter = null;
  child.stdout.on('data', b => { pending = Buffer.concat([pending, b]); if (waiter) waiter(); });
  const exited = new Promise(r => child.on('close', code => { res.exit = code; if (waiter) waiter(); r(); }));
  const need = bytes => new Promise((resolve, reject) => {
    const chk = () => {
      if (pending.length >= bytes) { waiter = null; resolve(); }
      else if (res.exit !== null) { waiter = null; reject(new Error(`bmpeer exited (${res.exit}): ${JSON.stringify(res.bm.slice(-3))}`)); }
    };
    waiter = chk; chk();
  });

  const S = o.synth;
  let t = 0, last;
  S.on('ready', info => {
    if (res.slReady) return;
    res.slReady = { t, info };
    if (o.send) sendAt = t + (o.sendDelay || 0);
  });
  let sendAt = null;
  S.on('data', d => { for (const x of d) res.slRx.push(x); });

  const toBM = delayLine(o.delay || 0), toSL = delayLine(o.delay || 0);
  const ppm = o.ppm || 0;
  const rsToSL = resampler(1 + ppm * 1e-6), rsToBM = resampler(1 / (1 + ppm * 1e-6));
  const slEcho = delayLine(echoDelay);
  const bmL = o.bmLevelDb || 0;
  // BinModem's output alone, in dB: bmpeer passes its internal scale straight
  // through, about +3 dBm0, where a modem transmits at −9 to −14. Unlike
  // bmLevelDb this leaves our signal toward it alone, so absolute thresholds see
  // what a real line gives them.
  const bmOut = Math.pow(10, (o.bmOutDb || 0) / 20);
  const dispToSL = o.disperse ? firStream(lineFilter(o.disperse)) : (x => x);
  const dispToBM = o.disperse ? firStream(lineFilter(o.disperse)) : (x => x);
  const lineToSL = lineDirection({ lossDb: (o.lossDb || 0) - bmL, noiseDb: o.noiseDb, seed: 0x1234_5678 });
  // Noise at BinModem scaled with our signal, so its SNR is a quieter BinModem's.
  const lineToBM = lineDirection({ lossDb: (o.lossDb || 0) + bmL, noiseDb: o.noiseDb == null ? null : o.noiseDb + bmL, seed: 0x9e37_79b9 });
  // A line that gets worse part-way through, for a retrain: the same loss, more noise.
  const w = o.worse;
  const worseToSL = w && lineDirection({ lossDb: (o.lossDb || 0) - bmL, noiseDb: w.noiseDb, seed: 0x2468_ace1 });
  const worseToBM = w && lineDirection({ lossDb: (o.lossDb || 0) + bmL, noiseDb: w.noiseDb + bmL, seed: 0x1357_9bdf });
  const worseNow = (b) => w && b * BLOCK / SR >= w.at && (w.until == null || b * BLOCK / SR < w.until);

  return (async () => {
    const blocks = Math.ceil(o.secs * SR / BLOCK);
    const out = Buffer.alloc(4 * BLOCK);
    const started = Date.now();
    for (let b = 0; b < blocks; b++) {
      if (o.realtime) {
        const ahead = b * BLOCK / SR * 1000 - (Date.now() - started);
        if (ahead > 0) await new Promise(r => setTimeout(r, ahead));
      }
      const a = S.generateAudio(BLOCK);
      const aBM = (worseNow(b) && w.only !== 'sl' ? worseToBM : lineToBM)(dispToBM(rsToBM(a)));
      for (let k = 0; k < BLOCK; k++) out.writeFloatLE(toBM(aBM[k]), 4 * k);
      child.stdin.write(out);
      await need(4 * BLOCK);
      const got = pending.subarray(0, 4 * BLOCK); pending = pending.subarray(4 * BLOCK);
      const raw = new Float32Array(BLOCK);
      for (let k = 0; k < BLOCK; k++) raw[k] = got.readFloatLE(4 * k) * bmOut;
      const rs = (worseNow(b) && w.only !== 'bm' ? worseToSL : lineToSL)(dispToSL(rsToSL(raw)));
      const back = new Float32Array(BLOCK);
      for (let k = 0; k < BLOCK; k++) {
        back[k] = toSL(rs[k]) + echo * slEcho(a[k]);
      }
      S.receiveAudio(back);
      t = (b + 1) * BLOCK / SR;
      if (sendAt !== null && t >= sendAt) { S.write(Buffer.from(o.send, 'latin1')); sendAt = null; }
      if (o.at) for (const a of o.at) if (!a.done && t >= a[0]) { a.done = true; a[1](S); }
      const d = S.describe ? JSON.stringify(S.describe()) : '';
      if (d !== last) { res.sl.push({ t, describe: d }); last = d; }
      if (o.probe) {
        const v = o.probe(S);
        const pv = res.probe.length ? res.probe[res.probe.length - 1].v : undefined;
        if (v !== pv) res.probe.push({ t, v });
      }
      if (o.stopWhen && o.stopWhen(res)) break;
    }
    child.stdin.end();
    await exited;
    res.slRx = Buffer.from(res.slRx);
    res.bmRx = Buffer.from(res.bmRx);
    return res;
  })();
}

/**
 * A whole SynthLink modem — V.8 and all — in the shape `call` drives: the
 * handshake engine ModemDSP wraps, stepped in lockstep instead of by ModemDSP's
 * wall-clock timer, which a lockstep peer cannot follow. `protocol` is set as a
 * dial sets it: one protocol, advertised alone in V.8.
 */
function wholeModem(role, protocol) {
  const path = require('path');
  const ROOT = path.join(__dirname, '..', '..');
  // What the server and the browser bundle load — the shipped settings, the
  // clean-link relaxations included — so the harness tests what ships.
  const config = require(path.join(ROOT, 'vendor', 'synthlink-config'));
  config.modem.native.protocolPreference = [protocol];
  config.modem.native.v8ModulationModes = [protocol];
  const { ModemDSP } = require(path.join(ROOT, 'vendor', 'src', 'dsp', 'ModemDSP'));
  const md = new ModemDSP(role);
  const { EventEmitter } = require('events');
  const w = new EventEmitter();
  md.on('connected', info => w.emit('ready', info));
  md.on('data', d => w.emit('data', d));
  md._handshake.start();
  md._started = true;
  w.generateAudio = n => md._handshake.generateAudio(n);
  w.receiveAudio = f => md.receiveAudio(f);
  w.write = b => md.write(b);
  w.describe = () => { try { return md._handshake.describe(); } catch { return null; } };
  w.dsp = md;
  return w;
}

/** The phases BinModem passed through, in order, each once. */
function bmPhases(res) {
  return res.bm.filter(e => e.ev === 'phase').map(e => e.phase).filter((p, i, a) => i === 0 || a[i - 1] !== p);
}

/** A human-readable merged timeline, for a failure message or `node tools/bridge/call.js`. */
function timeline(res) {
  const rows = [];
  for (const e of res.bm) {
    if (e.ev === 'phase') rows.push([e.t, `BM  ${e.phase}  ${e.status}`]);
    else if (e.ev === 'end') rows.push([e.t, `BM  end: ${e.phase}  ${e.status}`]);
    else if (e.ev === 'rx') rows.push([e.t, `BM  rx ${JSON.stringify(Buffer.from(e.hex, 'hex').toString('latin1'))}`]);
    else if (e.ev === 'jd') rows.push([e.t, `BM  read Jd ${JSON.stringify(e.jd)}`]);
    else if (e.ev === "diag") rows.push([e.t, `BM  diag ${JSON.stringify(e.diag)}`]);
    else if (e.t != null) rows.push([e.t, `BM  ${e.ev} ${e.text || e.bits || e.status || ''}`]);
    else rows.push([0, `BM  ${e.ev} ${e.text || ''}`]);
  }
  for (const e of res.sl) rows.push([e.t, `SL  ${e.describe}`]);
  for (const e of res.probe) rows.push([e.t, `SL  probe ${e.v}`]);
  if (res.slReady) {
    const i = res.slReady.info || {};
    rows.push([res.slReady.t, `SL  READY ${JSON.stringify({ protocol: i.protocol, bps: i.bps })}`]);
  }
  rows.sort((x, y) => x[0] - y[0]);
  return rows.map(([t, s]) => `${t.toFixed(3).padStart(8)}s  ${s}`).join('\n');
}

module.exports = { available, call, wholeModem, bmPhases, timeline, lineDirection, lineFilter, firStream, resampler, VOICE_BAND_DB, SR, BLOCK, BIN };
