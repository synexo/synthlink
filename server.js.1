'use strict';
// SynthLink server.
//
// Per browser connection it runs an *answer*-role software modem (synthmodem's
// native V.21 DSP). The browser runs the *originate* side. The two negotiate a
// real modem handshake by exchanging PCM audio over the WebSocket; once the
// carrier is up, the demodulated byte stream is proxied to an arbitrary telnet
// BBS. Nothing but audio crosses the socket during the call.
//
//   browser (originate DSP) ⇄ [PCM audio over WS] ⇄ server (answer DSP) ⇄ telnet BBS
//
// Wire protocol:
//   client → server : first a JSON text frame {type:'dial', host, port}
//                      thereafter binary frames = Int16LE PCM @ 8 kHz (client TX audio)
//   server → client : JSON text frames  {type:'status'|'connected'|'carrier'|'closed', ...}
//                      binary frames = Int16LE PCM @ 8 kHz (server TX audio)

const http = require('http');
const net  = require('net');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

// Apply the shared V.21 pin BEFORE loading the DSP.
const config = require('./vendor/synthlink-config');
const { ModemDSP } = require('./vendor/src/dsp/ModemDSP');

const PORT      = parseInt(process.env.PORT || '8088', 10);
const PUBLIC    = path.join(__dirname, 'public');

// Optional allow-list. Empty = allow anything (it's your box; be careful when
// exposing this publicly — an open telnet proxy can be abused).
const ALLOW_HOSTS = (process.env.ALLOW_HOSTS || '').split(',').map(s => s.trim()).filter(Boolean);

// ─── Static file server ─────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.ico': 'image/x-icon',
};
const httpServer = http.createServer((req, res) => {
  let rel = decodeURIComponent((req.url || '/').split('?')[0]);
  if (rel === '/') rel = '/index.html';
  // BBS directory, read fresh from config/bbs.json so users can edit it live.
  if (rel === '/bbs.json') {
    fs.readFile(path.join(__dirname, 'config', 'bbs.json'), (err, data) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(err ? '[]' : data);
    });
    return;
  }
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ─── Audio conversion helpers ───────────────────────────────────────────────
function floatToInt16(f32) {
  const out = Buffer.allocUnsafe(f32.length * 2);
  for (let i = 0; i < f32.length; i++) {
    let s = Math.max(-1, Math.min(1, f32[i]));
    out.writeInt16LE((s * 32767) | 0, i * 2);
  }
  return out;
}
function int16ToFloat(buf) {
  const n = buf.length >> 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
  return out;
}

// ─── WebSocket / per-call session ───────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws, req) => {
  const peer = req.socket.remoteAddress;
  let dsp = null;
  let sock = null;
  let connected = false;
  let dialed = false;
  const pending = [];      // telnet bytes waiting for carrier
  const log = (...a) => console.log(`[${peer}]`, ...a);

  function sendJSON(o) { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(o)); }

  function teardown(reason) {
    if (dsp) { try { dsp.stop(); } catch (_) {} dsp = null; }
    if (sock) { try { sock.destroy(); } catch (_) {} sock = null; }
    if (ws.readyState === ws.OPEN) { sendJSON({ type: 'closed', reason }); }
  }

  function dial(host, port, protocol) {
    if (dialed) return;
    dialed = true;
    port = parseInt(port, 10) || 23;
    if (ALLOW_HOSTS.length && !ALLOW_HOSTS.includes(host)) {
      sendJSON({ type: 'status', level: 'error', text: `host not allowed: ${host}` });
      return teardown('host-not-allowed');
    }
    // Per-call protocol selection. Both ends must agree; the client sends the
    // same choice and sets it on its originate modem. (Shared-config mutation
    // is fine for this local single-user tool; it's applied immediately before
    // the DSP is constructed.)
    const PROTOS = ['V21', 'V22', 'V23', 'V22bis', 'V29'];
    const proto = PROTOS.includes(protocol) ? protocol : 'V21';
    config.modem.native.protocolPreference = [proto];
    config.modem.native.v8ModulationModes  = [proto];
    log(`dial ${host}:${port} via ${proto}`);
    sendJSON({ type: 'status', level: 'info', text: `answering modem (${proto})… negotiating carrier` });

    // Answer-side modem.
    dsp = new ModemDSP('answer');
    dsp.on('audioOut', (f32) => { if (ws.readyState === ws.OPEN) ws.send(floatToInt16(f32)); });
    dsp.on('connected', (info) => {
      connected = true;
      log(`carrier up: ${info.protocol} @ ${info.bps} bps`);
      sendJSON({ type: 'connected', protocol: info.protocol, bps: info.bps });
      // Flush telnet bytes that arrived before carrier.
      let flushed = 0;
      while (pending.length) { const b = pending.shift(); flushed += b.length; dsp.write(b); }
      if (flushed) log(`flushed ${flushed}B of buffered BBS data into modem`);
    });
    // Bytes demodulated FROM the client (the user's keystrokes) → telnet BBS.
    dsp.on('data', (buf) => {
      log(`modem→telnet ${buf.length}B`);
      if (sock && !sock.destroyed) sock.write(buf);
    });
    dsp.on('silenceHangup', () => { log('silence hangup'); teardown('silence'); });
    dsp.start();

    // Connect to the telnet BBS.
    sock = net.createConnection(port, host);
    sock.setNoDelay(true);
    sock.on('connect', () => {
      log('telnet connected');
      sendJSON({ type: 'status', level: 'info', text: `connected to ${host}:${port}` });
    });
    // Bytes FROM the BBS → modulate to the client (buffer until carrier).
    sock.on('data', (buf) => {
      if (connected && dsp) { log(`telnet→modem ${buf.length}B (modulating)`); dsp.write(buf); }
      else { pending.push(buf); log(`telnet→buffer ${buf.length}B (pre-carrier, ${pending.length} chunks queued)`); }
    });
    sock.on('close', () => { log('telnet closed'); teardown('remote-closed'); });
    sock.on('error', (e) => {
      log('telnet error', e.message);
      sendJSON({ type: 'status', level: 'error', text: `telnet error: ${e.message}` });
      teardown('telnet-error');
    });
  }

  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      let msg; try { msg = JSON.parse(data.toString()); } catch (_) { return; }
      if (msg.type === 'dial') dial(msg.host, msg.port, msg.protocol);
      return;
    }
    // Binary = client TX audio (Int16LE PCM) → feed the answer modem's RX.
    if (dsp) dsp.receiveAudio(int16ToFloat(Buffer.from(data)));
  });

  ws.on('close', () => { log('ws closed'); teardown('ws-closed'); });
  ws.on('error', () => teardown('ws-error'));
});

httpServer.listen(PORT, () => {
  console.log(`SynthLink server on http://localhost:${PORT}`);
  if (ALLOW_HOSTS.length) console.log('Allowed hosts:', ALLOW_HOSTS.join(', '));
});
