'use strict';
// SynthLink server.
//
// Per browser connection it runs an *answer*-role software modem (synthmodem's
// native V.21 DSP). The browser runs the *originate* side. The two negotiate a
// real modem handshake by exchanging PCM audio over the WebSocket; once the
// carrier is up, the demodulated byte stream is proxied to an arbitrary telnet
// BBS. Nothing but audio crosses the socket during the call.
//
// Telnet is terminated HERE, not in the browser (see TELNETREFACTOR.md): IAC
// negotiation never crosses the modem link, and the server answers TTYPE/NAWS
// with the terminal's real fixed constants (80×25, ANSI) because the renderer
// is fixed at that grid.
//
//   browser (originate DSP) ⇄ [PCM audio over WS] ⇄ server (answer DSP + telnet) ⇄ telnet BBS
//
// Wire protocol:
//   client → server : first a JSON text frame {type:'dial', host, port}
//                      thereafter binary frames = Int16LE PCM @ 8 kHz (client TX audio)
//   server → client : JSON text frames  {type:'status'|'connected'|'carrier'|'closed', ...}
//                      binary frames = Int16LE PCM @ 8 kHz (server TX audio)

const http = require('http');
const net  = require('net');
const dns  = require('dns');
const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');
const { WebSocketServer } = require('ws');
const bbslist = require('./lib/bbslist');
const { TelnetFilter } = require('./lib/telnet');

// Apply the shared V.21 pin BEFORE loading the DSP.
const config = require('./vendor/synthlink-config');
const { ModemDSP } = require('./vendor/src/dsp/ModemDSP');

const PORT      = parseInt(process.env.PORT || '8088', 10);
const PUBLIC    = path.join(__dirname, 'public');

// Optional allow-list. Empty = allow anything (it's your box; be careful when
// exposing this publicly — an open telnet proxy can be abused).
const ALLOW_HOSTS = (process.env.ALLOW_HOSTS || '').split(',').map(s => s.trim()).filter(Boolean);

// ─── Static file server ─────────────────────────────────────────────────────
// ── BBS directory payload cache ─────────────────────────────────────────────
// Serialised + gzipped once and reused. Rebuilt when the curated file is edited
// (its mtime is checked by bbslist.directory()) or when the daily update lands.
let _bbsCache = null;
function bbsPayload() {
  const dir = bbslist.directory();
  const stamp = `${dir.curated.length}:${dir.guide.length}:${dir.guideFile}:` +
                dir.curated.map((e) => `${e.name}|${e.host}:${e.port}`).join(',');
  if (_bbsCache && _bbsCache.stamp === stamp) return _bbsCache;
  const body = Buffer.from(JSON.stringify(dir));
  _bbsCache = {
    stamp, body,
    gzip: zlib.gzipSync(body, { level: 9 }),
    etag: '"' + require('crypto').createHash('sha1').update(body).digest('hex').slice(0, 16) + '"',
  };
  return _bbsCache;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.ico': 'image/x-icon',
};
const httpServer = http.createServer((req, res) => {
  let rel = decodeURIComponent((req.url || '/').split('?')[0]);
  if (rel === '/') rel = '/index.html';
  // BBS directory: curated tier + the cached Telnet BBS Guide list. Built in
  // memory and only rebuilt when something actually changes, so a request never
  // parses a 1000-entry list (and never triggers a network fetch — see
  // lib/bbslist.js). Served gzipped with an ETag; the body is ~65 KB raw and
  // ~17 KB compressed, and revalidates to a 304 for repeat visitors.
  if (rel === '/bbs.json') {
    const { body, gzip, etag } = bbsPayload();
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
      return res.end();
    }
    const wantGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    const head = { 'Content-Type': 'application/json; charset=utf-8',
                   ETag: etag, 'Cache-Control': 'no-cache' };
    if (wantGzip) head['Content-Encoding'] = 'gzip';
    res.writeHead(200, head);
    return res.end(req.method === 'HEAD' ? undefined : (wantGzip ? gzip : body));
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
  const pending = [];      // payload bytes waiting for carrier
  let pendingBytes = 0;
  const log = (...a) => console.log(`[${peer}]`, ...a);

  // Telnet terminates here, one filter per connection (its state is per-session).
  // Payload goes toClient(); negotiation replies go straight back down the TCP
  // socket and never touch the modem.
  const filter = new TelnetFilter();

  function sendJSON(o) { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(o)); }

  function teardown(reason) {
    if (dsp) { try { dsp.stop(); } catch (_) {} dsp = null; }
    if (sock) { try { sock.destroy(); } catch (_) {} sock = null; }
    pending.length = 0; pendingBytes = 0;
    if (ws.readyState === ws.OPEN) { sendJSON({ type: 'closed', reason }); }
  }

  // ── The transport, as a swappable sink ────────────────────────────────────
  // Everything BBS→client goes through toClient(), and everything client→BBS
  // arrives via toBBS(). Today the client-facing side is always the modem; the
  // planned pure-telnet-proxy mode swaps it for a raw binary WebSocket frame
  // without the socket handlers below knowing the difference.
  // TELNETREFACTOR.md §5.
  const PENDING_CAP = 256 * 1024;   // sanity bound; the queue used to be unbounded

  function toClient(bytes) {
    const buf = Buffer.from(bytes);   // Uint8Array → Buffer (copy; payload-sized)
    if (connected && dsp) { log(`telnet→modem ${buf.length}B (modulating)`); dsp.write(buf); return; }
    // Pre-carrier: the BBS is already talking (the TCP connect happens at dial,
    // so the whole handshake runs while it does). Buffer, but bounded — dropping
    // the oldest banner text beats growing without limit on a chatty board.
    pending.push(buf); pendingBytes += buf.length;
    while (pendingBytes > PENDING_CAP && pending.length > 1) {
      pendingBytes -= pending.shift().length;
    }
    log(`telnet→buffer ${buf.length}B (pre-carrier, ${pending.length} chunks / ${pendingBytes}B queued)`);
  }

  function toBBS(buf) {
    // Guard against a write racing teardown; the filter's callbacks fire
    // synchronously from process(), so this can be reached mid-destroy.
    if (sock && !sock.destroyed) sock.write(buf);
  }

  filter.onData = (bytes) => toClient(bytes);
  filter.onSend = (bytes) => toBBS(Buffer.from(bytes));   // never via the modem

  function dial(host, port, protocol, v34Rate) {
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
    const PROTOS = ['V21', 'V22', 'V23', 'V22bis', 'V29', 'V32', 'V32bis', 'V34', 'Bell103'];
    const proto = PROTOS.includes(protocol) ? protocol : 'V21';
    config.modem.native.protocolPreference = [proto];
    config.modem.native.v8ModulationModes  = [proto];
    // V.34 sub-rate (28800/31200/33600); default to the max when unspecified.
    if (proto === 'V34') {
      const V34_RATES = [28800, 31200, 33600];
      config.modem.native.v34Rate = V34_RATES.includes(v34Rate) ? v34Rate : 33600;
    }
    log(`dial ${host}:${port} via ${proto}${proto === 'V34' ? ' @ ' + config.modem.native.v34Rate : ''}`);
    sendJSON({ type: 'status', level: 'info', text: `answering modem (${proto})… negotiating carrier` });

    // Answer-side modem.
    dsp = new ModemDSP('answer');
    dsp.on('audioOut', (f32) => { if (ws.readyState === ws.OPEN) ws.send(floatToInt16(f32)); });
    dsp.on('connected', (info) => {
      connected = true;
      log(`carrier up: ${info.protocol} @ ${info.bps} bps`);
      sendJSON({ type: 'connected', protocol: info.protocol, bps: info.bps });
      // Negotiate on CARRIER, not on TCP connect. Some BBSes expect a prompt
      // keystroke (ANSI probe, "press a key", menu timeout), and anything said
      // before carrier is text the user cannot yet answer — negotiating early
      // only widens that gap. TELNETREFACTOR.md §2.
      filter.negotiate();
      // Flush payload bytes that arrived before carrier.
      let flushed = 0;
      while (pending.length) { const b = pending.shift(); flushed += b.length; dsp.write(b); }
      pendingBytes = 0;
      if (flushed) log(`flushed ${flushed}B of buffered BBS data into modem`);
    });
    // Bytes demodulated FROM the client (the user's keystrokes) → telnet BBS.
    dsp.on('data', (buf) => {
      log(`modem→telnet ${buf.length}B`);
      toBBS(buf);
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
    // Bytes FROM the BBS → strip/answer telnet, then on to the client.
    sock.on('data', (buf) => filter.process(buf));
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
      // Resolve the destination host → IP so the browser can "dial" the numeric
      // address in DTMF before the carrier handshake. Purely cosmetic (the actual
      // telnet connect below resolves again); a literal IP passes straight through.
      if (msg.type === 'resolve') {
        dns.lookup(msg.host, (err, addr) => {
          if (err) sendJSON({ type: 'resolveError', host: msg.host, error: err.message });
          else     sendJSON({ type: 'resolved', host: msg.host, ip: addr });
        });
        return;
      }
      if (msg.type === 'dial') dial(msg.host, msg.port, msg.protocol, msg.v34Rate);
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
  // Serve whatever is cached immediately, then arm the ~daily update. The check
  // is scheduled off a persisted timestamp, so restarts don't re-fetch, and it
  // only downloads when a new monthly list is actually published.
  // Set BBSLIST_UPDATE=0 to disable all outbound update traffic.
  if (process.env.BBSLIST_UPDATE !== '0') {
    bbslist.start({
      log: (m) => console.log(`[bbslist] ${m}`),
      onChange: () => { _bbsCache = null; },
    });
  } else {
    bbslist.loadGuide();
    console.log('[bbslist] updates disabled (BBSLIST_UPDATE=0); serving cache only');
  }
});
