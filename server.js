'use strict';
// SynthLink server.
//
// Per browser connection it runs an *answer*-role software modem (synthmodem's
// native V.21 DSP). The browser runs the *originate* side. The two negotiate a
// real modem handshake by exchanging PCM audio over the WebSocket; once the
// carrier is up, the demodulated byte stream is proxied to an arbitrary telnet
// BBS. Nothing but audio crosses the socket during the call.
//
// Telnet is terminated HERE, not in the browser (see DEVLOG.md): IAC
// negotiation never crosses the modem link, and the server answers TTYPE/NAWS
// with the terminal's real fixed constants (80×25, ANSI) because the renderer
// is fixed at that grid.
//
//   browser (originate DSP) ⇄ [PCM audio over WS] ⇄ server (answer DSP + telnet) ⇄ telnet BBS
//
// Wire protocol:
//   client → server : first a JSON text frame {type:'dial', host, port, link}
//                      thereafter binary frames = Int16LE PCM @ 8 kHz (client TX audio)
//   server → client : JSON text frames  {type:'status'|'connected'|'carrier'|'closed', ...}
//                      binary frames = Int16LE PCM @ 8 kHz (server TX audio)
//
// With {link:'direct'} the modem is bypassed entirely: no DSP is constructed and
// binary frames carry raw payload bytes in both directions instead of PCM. The
// telnet filter, the pending queue and teardown are unchanged — only the
// transport differs. See DEVLOG.md.

const http = require('http');
const net  = require('net');
const dns  = require('dns');
const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');
const { WebSocketServer } = require('ws');
const bbslist = require('./lib/bbslist');
const bbsstats = require('./lib/bbsstats');
const logger = require('./lib/log');
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
  // The stamp now also covers the blacklist file and the dial counters, so an
  // edit to config/blacklist.txt goes live on the next request and the (##)
  // counts in the dropdown don't go stale. Connects are human-paced, so the
  // rebuild+gzip this costs happens at most a few times a minute.
  const stamp = `${dir.curated.length}:${dir.guide.length}:${dir.guideFile}:` +
                `${bbslist.blacklistStamp()}:${bbsstats.stamp()}:` +
                dir.curated.map((e) => `${e.name}|${e.host}:${e.port}`).join(',');
  if (_bbsCache && _bbsCache.stamp === stamp) return _bbsCache;
  // Dial counts ride along with the directory: one fetch, one cache, one ETag.
  dir.stats = { total: bbsstats.total(), counts: bbsstats.counts() };
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
// Access logging wrapper. res.end is patched once per request so the combined
// line can carry the real byte count and final status, whichever branch below
// answered — including the 304s and the 404 from the readFile callback. The
// alternative, a log call in every branch, drifts the moment a branch is added.
function withAccessLog(handler) {
  return (req, res) => {
    let bytes = 0;
    const end = res.end.bind(res);
    const write = res.write.bind(res);
    res.write = (chunk, ...rest) => { if (chunk) bytes += Buffer.byteLength(chunk); return write(chunk, ...rest); };
    res.end = (chunk, ...rest) => {
      if (chunk && typeof chunk !== 'function') bytes += Buffer.byteLength(chunk);
      logger.httpRequest(req, res, bytes);
      return end(chunk, ...rest);
    };
    handler(req, res);
  };
}

const httpServer = http.createServer(withAccessLog((req, res) => {
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
}));

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

let _sessionSeq = 0;

// Name + tier for a destination, so a failed connect can be reviewed as
// "which board was that?" rather than a bare address. Directory lookups are
// cheap (the list is already in memory) and only happen on failure.
function describeDest(host, port) {
  const hp = `${String(host).toLowerCase()}:${parseInt(port, 10) || 23}`;
  try {
    const dir = bbslist.directory();
    for (const e of dir.curated) {
      if (`${e.host.toLowerCase()}:${e.port}` === hp) return { name: e.name, tier: 'curated' };
    }
    for (const e of dir.guide) {
      if (`${e.host.toLowerCase()}:${e.port}` === hp) return { name: e.name, tier: 'guide' };
    }
  } catch (_) {}
  return { name: '', tier: 'manual' };
}

wss.on('connection', (ws, req) => {
  // Behind Cloudflare (or any proxy) the socket address is the edge, not the
  // visitor — logger.clientIp() resolves the real one, gated on trustProxy.
  const peer = logger.clientIp(req);
  const id = ++_sessionSeq;
  let dsp = null;
  let sock = null;
  let connected = false;
  let dialed = false;
  let direct = false;      // true = modem bypassed, payload rides raw WS frames
  const pending = [];      // payload bytes waiting for carrier
  let pendingBytes = 0;

  // Where this call went and how it went, for the END line.
  let dest = { host: null, port: null };
  let howConnected = null;
  let connectTimer = null;
  let failLogged = false;
  const openedAt = Date.now();
  let linkAt = 0;

  // Byte totals. Four integer adds on paths that already handle every buffer —
  // no allocation, no I/O, one line at teardown. Off via `trackBytes: false`.
  const track = logger.config().trackBytes !== false;
  // (named `count`, not `bytes` — toClient's parameter is already `bytes`)
  const count = { telnetIn: 0, telnetOut: 0, audioIn: 0, audioOut: 0 };

  // Per-chunk transfer logging. This is what used to fill the console; it is
  // now behind `debug` in config/logging.json and off by default.
  const log = (...a) => logger.debug(peer, id, a.join(' '));

  logger.sessionOpen(peer, id, req.headers && req.headers['user-agent']);

  // Telnet terminates here, one filter per connection (its state is per-session).
  // Payload goes toClient(); negotiation replies go straight back down the TCP
  // socket and never touch the modem.
  const filter = new TelnetFilter();

  function sendJSON(o) { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(o)); }

  let torndown = false;
  function teardown(reason) {
    if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
    if (dsp) { try { dsp.stop(); } catch (_) {} dsp = null; }
    if (sock) { try { sock.destroy(); } catch (_) {} sock = null; }
    pending.length = 0; pendingBytes = 0;
    if (ws.readyState === ws.OPEN) { sendJSON({ type: 'closed', reason }); }
    // One END line per session, whichever path got here first (remote close,
    // telnet error, silence hangup, browser gone).
    if (!torndown) {
      torndown = true;
      logger.sessionEnd(peer, id, dest.host, dest.port,
                        Date.now() - (linkAt || openedAt),
                        track ? count : null, reason);
    }
  }

  // ── The transport, as a swappable sink ────────────────────────────────────
  // Everything BBS→client goes through toClient(), and everything client→BBS
  // arrives via toBBS(). The client-facing side is either the modem (payload is
  // modulated to PCM) or, in direct mode, a raw binary WebSocket frame — the
  // socket handlers below don't know the difference. See DEVLOG.md.
  const PENDING_CAP = 256 * 1024;   // sanity bound on the pre-link queue

  // The swap point. In direct mode there is no DSP at all: binary frames on this
  // socket carry payload bytes rather than PCM audio, in both directions.
  function transportWrite(buf) {
    if (direct) { if (ws.readyState === ws.OPEN) ws.send(buf); return; }
    if (dsp) dsp.write(buf);
  }

  function toClient(bytes) {
    const buf = Buffer.from(bytes);   // Uint8Array → Buffer (copy; payload-sized)
    if (track) count.telnetIn += buf.length;
    if (connected) { log(`telnet→${direct ? 'ws' : 'modem'} ${buf.length}B`); transportWrite(buf); return; }
    // Almost nothing should land here: the BBS is not dialled until the link is
    // up (see openSocket), so it cannot speak before then. Kept as a safety net
    // for anything arriving in the same tick as connect, bounded so it can never
    // grow without limit.
    pending.push(buf); pendingBytes += buf.length;
    while (pendingBytes > PENDING_CAP && pending.length > 1) {
      pendingBytes -= pending.shift().length;
    }
    log(`telnet→buffer ${buf.length}B (pre-carrier, ${pending.length} chunks / ${pendingBytes}B queued)`);
  }

  function toBBS(buf) {
    // Guard against a write racing teardown; the filter's callbacks fire
    // synchronously from process(), so this can be reached mid-destroy.
    if (sock && !sock.destroyed) { if (track) count.telnetOut += buf.length; sock.write(buf); }
  }

  filter.onData = (bytes) => toClient(bytes);
  filter.onSend = (bytes) => toBBS(Buffer.from(bytes));   // never via the modem

  // Shared by both transports: the moment the client can actually be spoken to.
  // Both modes now reach it from the socket's connect callback — the modem only
  // dials the BBS once its carrier is up, so the board's clock starts when the
  // user can type. See openSocket() and DEVLOG.md.
  function linkUp(what) {
    if (connected) return;
    connected = true;
    linkAt = Date.now();
    howConnected = what;
    // Counted here, on a link that actually came up, rather than at dial: a
    // dead board a hundred people tried shouldn't look popular. The failures
    // are in telnetFailLog instead.
    bbsstats.record(dest.host, dest.port);
    logger.connect(peer, id, dest.host, dest.port, what);
    log(`link up: ${what}`);
    filter.negotiate();
    let flushed = 0;
    while (pending.length) { const b = pending.shift(); flushed += b.length; transportWrite(b); }
    pendingBytes = 0;
    if (flushed) log(`flushed ${flushed}B of buffered BBS data to the client`);
  }

  function dial(host, port, protocol, v34Rate, link, cols, rows) {
    if (dialed) return;
    dialed = true;
    direct = link === 'direct';
    port = parseInt(port, 10) || 23;
    dest = { host, port };
    // The browser's window size rides the dial message, and this is the only
    // moment it can: NAWS goes out during telnet negotiation, and once a
    // carrier is up nothing but modulated audio crosses this socket. 40 columns
    // means the 9×14 font is active (public/fonts/index.js). setWindow()
    // validates; a missing or nonsense value leaves the 80×25 default.
    if (cols !== undefined && filter.setWindow(cols, rows)) {
      log(`window ${filter.cols}x${filter.rows}`);
    }
    if (ALLOW_HOSTS.length && !ALLOW_HOSTS.includes(host)) {
      logger.warn('dial', `id=${id} ${peer} host not allowed: ${host}`);
      sendJSON({ type: 'status', level: 'error', text: `host not allowed: ${host}` });
      return teardown('host-not-allowed');
    }
    // ── Direct mode: no modem at all ────────────────────────────────────────
    // The DSP is skipped entirely; payload rides binary WS frames both ways.
    // Everything else — the telnet filter, the pending queue, teardown — is
    // identical, because the transport is the only thing that changed.
    if (direct) {
      logger.dial(peer, id, host, port, `direct ${filter.cols}x${filter.rows}`);
      log(`dial ${host}:${port} direct (modem bypassed)`);
      sendJSON({ type: 'status', level: 'info', text: 'connecting (modem bypassed)…' });
      openSocket(host, port, () => {
        linkUp('direct');
        sendJSON({ type: 'connected', protocol: 'DIRECT', bps: 0, direct: true });
      });
      return;
    }

    // Per-call protocol selection. Both ends must agree; the client sends the
    // same choice and sets it on its originate modem. (Shared-config mutation
    // is fine for this local single-user tool; it's applied immediately before
    // the DSP is constructed.)
    const PROTOS = ['V21', 'V22', 'V23', 'V22bis', 'V29', 'V32', 'V32bis', 'V34', 'V90', 'Bell103'];
    const proto = PROTOS.includes(protocol) ? protocol : 'V21';
    config.modem.native.protocolPreference = [proto];
    config.modem.native.v8ModulationModes  = [proto];
    // V.34 sub-rate (28800/31200/33600); default to the max when unspecified.
    if (proto === 'V34') {
      const V34_RATES = [28800, 31200, 33600];
      config.modem.native.v34Rate = V34_RATES.includes(v34Rate) ? v34Rate : 33600;
    }
    // V.90 is asymmetric and single-rate: 56000 downstream (PCM codewords) and
    // 33600 upstream (genuine V.34, set by the protocol class itself).
    if (proto === 'V90') config.modem.native.v90Rate = 56000;
    const how = `${proto}${proto === 'V34' ? '@' + config.modem.native.v34Rate : ''}` +
                `${proto === 'V90' ? '@56000/33600' : ''}`;
    // The window size is worth having in the log now that it varies: 40 columns
    // means the visitor is on the 9×14 font, which is a different reflow path.
    logger.dial(peer, id, host, port, `${how} ${filter.cols}x${filter.rows}`);
    log(`dial ${host}:${port} via ${proto}${proto === 'V34' ? ' @ ' + config.modem.native.v34Rate : ''}` +
        `${proto === 'V90' ? ' @ 56000 down / 33600 up' : ''}`);
    sendJSON({ type: 'status', level: 'info', text: `answering modem (${proto})… negotiating carrier` });

    // Answer-side modem.
    dsp = new ModemDSP('answer');
    dsp.on('audioOut', (f32) => {
      if (ws.readyState !== ws.OPEN) return;
      const pcm = floatToInt16(f32);
      if (track) count.audioOut += pcm.length;
      ws.send(pcm);
    });
    dsp.on('connected', (info) => {
      sendJSON({ type: 'connected', protocol: info.protocol, bps: info.bps });
      // The TCP connect is deferred to HERE, not done at dial — see the comment
      // on openSocket(). linkUp() runs on the socket's connect callback because
      // it negotiates, and negotiation replies need a socket to be written to.
      openSocket(host, port, () => linkUp(`carrier ${info.protocol} @ ${info.bps} bps`));
    });
    // Bytes demodulated FROM the client (the user's keystrokes) → telnet BBS.
    dsp.on('data', (buf) => {
      log(`modem→telnet ${buf.length}B`);
      toBBS(buf);
    });
    dsp.on('silenceHangup', () => { log('silence hangup'); teardown('silence'); });
    dsp.start();

  }

  // Connect to the telnet BBS.
  //
  // **Called when the link is ready** — at carrier for the modem, at dial for
  // direct mode — NOT at dial time in both cases. Dialling the board early means
  // it is talking, and running any "press a key" window or menu timeout, through
  // the whole 2–3 s handshake (far longer at 300 bps) with `pending` swallowing
  // its banner; a board waiting on input can drop the node before the user can
  // type at all.
  //
  // The cost of doing it this way: connection failures (refused, host down)
  // surface AFTER the handshake rather than instantly, so they are reported
  // explicitly — see the `proxyError` message below. DNS failures still surface
  // early, because the client resolves at dial for the DTMF digits.
  //
  // `onConnect` is where the link comes up, and it must be the socket's connect
  // callback rather than anything earlier: linkUp() negotiates, and negotiation
  // replies need a socket to be written to.
  // One FAIL line per call, to both the access log and telnetFailLog. Guarded
  // because a refused connect can fire both the timeout and an error.
  function noteFail(host, port, code) {
    if (failLogged) return;
    failLogged = true;
    logger.telnetFail(peer, id, host, port, code, describeDest(host, port));
  }

  function openSocket(host, port, onConnect) {
    sock = net.createConnection(port, host);
    sock.setNoDelay(true);
    // A black-holed host never errors — the OS sits on the SYN for minutes.
    // Without this, the board never reaches telnetFailLog and the user stares
    // at a dead CONNECT. Configurable; 0 disables.
    const tmo = logger.config().connectTimeoutMs;
    if (tmo > 0) {
      connectTimer = setTimeout(() => {
        connectTimer = null;
        if (connected || !sock) return;
        noteFail(host, port, 'ETIMEDOUT');
        sendJSON({ type: 'proxyError', text: `no answer from ${host}:${port} (timed out)` });
        teardown('telnet-timeout');
      }, tmo);
      if (connectTimer.unref) connectTimer.unref();
    }
    sock.on('connect', () => {
      if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
      log('telnet connected');
      sendJSON({ type: 'status', level: 'info', text: `connected to ${host}:${port}` });
      if (onConnect) onConnect();
    });
    // Bytes FROM the BBS → strip/answer telnet, then on to the client.
    sock.on('data', (buf) => filter.process(buf));
    sock.on('close', () => { log('telnet closed'); teardown('remote-closed'); });
    sock.on('error', (e) => {
      if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
      if (!connected) noteFail(host, port, e.code || e.message);
      else logger.warn('telnet', `id=${id} ${host}:${port} ${e.code || e.message} (mid-session)`);
      log('telnet error', e.message);
      // Failing before the link is up is the interesting case: the user has sat
      // through a handshake and has a CONNECT on screen, so the terminal needs
      // to say plainly that the proxy could not reach the board.
      if (!connected) sendJSON({ type: 'proxyError', text: e.message });
      else sendJSON({ type: 'status', level: 'error', text: `telnet error: ${e.message}` });
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
      if (msg.type === 'dial') dial(msg.host, msg.port, msg.protocol, msg.v34Rate, msg.link,
                                    msg.cols, msg.rows);
      return;
    }
    // Binary frames mean different things per transport: PCM audio for the
    // modem's RX, or raw payload straight to the BBS in direct mode.
    if (direct) { toBBS(Buffer.from(data)); return; }
    const buf = Buffer.from(data);
    if (track) count.audioIn += buf.length;
    if (dsp) dsp.receiveAudio(int16ToFloat(buf));
  });

  ws.on('close', () => { log('ws closed'); logger.sessionClose(peer, id, 'ws-closed'); teardown('ws-closed'); });
  ws.on('error', () => teardown('ws-error'));
});

httpServer.listen(PORT, () => {
  logger.hookExit();
  logger.startDailySummary();
  logger.prune();
  const c = logger.config();
  console.log(`SynthLink server on http://localhost:${PORT}`);
  console.log(`Logging to ${logger.logDir()} (retain ${c.retentionDays || '∞'} days` +
              `${c.debug ? ', DEBUG ON' : ''})`);
  logger.info('server', `listening on ${PORT}; ${bbsstats.total()} total dials recorded`);
  if (ALLOW_HOSTS.length) logger.info('server', `allowed hosts: ${ALLOW_HOSTS.join(', ')}`);
  // Serve whatever is cached immediately, then arm the ~daily update. The check
  // is scheduled off a persisted timestamp, so restarts don't re-fetch, and it
  // only downloads when a new monthly list is actually published.
  // Set BBSLIST_UPDATE=0 to disable all outbound update traffic.
  if (process.env.BBSLIST_UPDATE !== '0') {
    bbslist.start({
      log: (m) => logger.info('bbslist', m),
      onChange: () => { _bbsCache = null; },
    });
  } else {
    bbslist.loadGuide();
    logger.info('bbslist', 'updates disabled (BBSLIST_UPDATE=0); serving cache only');
  }
});
