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
const altfonts = require('./lib/altfonts');
const logger = require('./lib/log');
const site = require('./lib/site');
const netguard = require('./lib/netguard');
const { TelnetFilter } = require('./lib/telnet');

// Apply the shared V.21 pin BEFORE loading the DSP.
const config = require('./vendor/synthlink-config');
const { ModemDSP } = require('./vendor/src/dsp/ModemDSP');

// ─── Configuration must be valid, or this does not start ────────────────────
// Both files, every setting, uniformly: missing, unparseable, an unknown key, or
// a value of the wrong shape stops the server here — before anything binds a
// port, opens a socket, or writes a log line.
//
// This used to degrade to defaults and carry on, and the argument for that was
// about cosmetic settings: a brand name with a stray comma should not take a
// server down. What it actually did was broader and worse. A single misplaced
// comma is a JSON parse error, and the answer to that was to discard the
// operator's ENTIRE configuration — every security setting with it — and run on
// defaults without stopping. `trustProxy: "no"` was kept as a truthy string, so
// an operator turning off header trust turned off nothing. A key with a typo in
// it was ignored in silence, which is the cheapest way there is to end up with
// an unarmed control and a config file that reads as though it is armed.
//
// Every one of those leaves an operator believing in protection they do not
// have, and that is worse than any refusal to start. There is deliberately no
// cosmetic exemption: a carve-out for the harmless-looking settings is exactly
// the cover a security setting slips through under.
for (const [what, why] of [['site', site.fatal()], ['logging', logger.fatal()]]) {
  if (!why) continue;
  process.stderr.write(`[config] ${why}\n`);
  process.stderr.write(`[config] refusing to start: fix config/${what}.json and try again. ` +
                       'Running on defaults would mean running a configuration nobody wrote.\n');
  process.exit(1);
}

// config/site.json is the source of truth for the port; PORT still overrides it
// when set, so a one-off run needs no edit. → lib/site.js.
const PORT      = site.port();
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
  // Filtered to what this payload actually offers — a count for a board nobody
  // can see in the dropdown cannot be displayed, and serving it would publish
  // every address this server has ever reached, manual dials included.
  const offered = new Set([...dir.curated, ...dir.guide]
    .map((e) => `${String(e.host).toLowerCase()}:${parseInt(e.port, 10) || 23}`));
  dir.stats = { total: bbsstats.total(), counts: bbsstats.counts((k) => offered.has(k)) };
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
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.woff2': 'font/woff2',
};
// Extensions answered with byte ranges, for the splash video: Safari will not
// START a video the server cannot serve a range of — it asks for `bytes=0-1`
// first and treats a 200 as "ranges unsupported", which on iOS means the element
// never plays and nothing is logged anywhere.
//
// These carry NO Cache-Control. They used to go out `max-age=604800, immutable`,
// and that produced a splash stuck on its still frame in any browser that had
// been here before: a 206 cached under an immutable, validator-less entry can be
// reused as the whole file, and two bytes of MP4 never play. It cannot be
// revalidated or busted either, so the bad entry outlived the deploy. Caching
// media is the deployment's business (the CDN in front of this) rather than
// something to reproduce here badly.
const MEDIA_EXT = new Set(['.mp4', '.webm']);
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
  // decodeURIComponent throws URIError on a malformed escape, and a throw here
  // is synchronous inside the request handler: it reaches uncaughtException and
  // takes the whole server down, every call in progress with it. `GET /%` was a
  // one-line denial of service for anyone who found the port.
  let rel;
  try { rel = decodeURIComponent((req.url || '/').split('?')[0]); }
  catch (_) { res.writeHead(400); return res.end('bad request'); }
  // A NUL truncates the path for some syscalls but not for the checks below it.
  if (rel.indexOf('\0') >= 0) { res.writeHead(400); return res.end('bad request'); }
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
  // Board font overrides. A handful of lines, so it is served whole rather than
  // queried per dial: the page holds the map before it dials, which is what
  // lets an override settle the font — and therefore the column count — BEFORE
  // the window size rides out on the dial message. It also means a hand-typed
  // address and a shared link get the same answer a directory entry does.
  // Tiny, no-cache, no gzip: 304 on the ETag is the whole optimisation.
  if (rel === '/altfonts.json') {
    const body = Buffer.from(JSON.stringify(altfonts.current()), 'utf8');
    const etag = '"' + require('crypto').createHash('sha1')
      .update(body).digest('hex').slice(0, 16) + '"';
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8',
                         ETag: etag, 'Cache-Control': 'no-cache' });
    return res.end(req.method === 'HEAD' ? undefined : body);
  }
  const file = path.normalize(path.join(PUBLIC, rel));
  // The separator is load-bearing. A bare startsWith(PUBLIC) also accepts every
  // SIBLING directory whose name merely begins with "public" — public.bak,
  // public-old, public.orig, which are exactly what an operator leaves behind
  // before an upgrade — because "…/public.bak/x".startsWith("…/public") is true.
  if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403); return res.end('forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(file);
    // Branding is substituted on the way out, not baked into the files: every
    // .html under public/ (the page itself and the two injected fragments)
    // writes {{BRAND}} / {{TAGLINE}} / {{TITLE}} / {{FAVICON}} and gets the
    // configured values here. Doing it server-side rather than in the browser
    // is what keeps the tab title and the panels from ever painting the wrong
    // name. → lib/site.js, config/site.json.
    let body = data;
    if (ext === '.html') body = Buffer.from(site.apply(data.toString('utf8')), 'utf8');
    const type = MIME[ext] || 'application/octet-stream';
    if (MEDIA_EXT.has(ext)) {
      // Range is answered from the buffer already in hand rather than by a
      // second read: these files are small and read whole either way, so a
      // stream would add a code path for no memory saved.
      const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
      if (m && (m[1] || m[2])) {
        const len = body.length;
        // A suffix range ("bytes=-500") is the last N bytes, not a start.
        let start = m[1] ? parseInt(m[1], 10) : len - parseInt(m[2], 10);
        let end = m[1] ? (m[2] ? parseInt(m[2], 10) : len - 1) : len - 1;
        if (!(start >= 0) || !(end >= start) || start >= len) {
          res.writeHead(416, { 'Content-Range': `bytes */${len}`,
                               'Accept-Ranges': 'bytes' });
          return res.end();
        }
        if (end >= len) end = len - 1;
        res.writeHead(206, {
          'Content-Type': type, 'Accept-Ranges': 'bytes',
          'Content-Range': `bytes ${start}-${end}/${len}`,
          'Content-Length': end - start + 1,
        });
        return res.end(req.method === 'HEAD' ? undefined : body.slice(start, end + 1));
      }
      res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes',
                           'Content-Length': body.length });
      return res.end(req.method === 'HEAD' ? undefined : body);
    }
    res.writeHead(200, { 'Content-Type': type });
    res.end(body);
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
// maxPayload matters more than it looks. A modem frame is a few hundred bytes;
// `ws` defaults this to 100 MiB, and int16ToFloat() allocates a Float32Array of
// TWICE the byte count, so one frame could ask for 200 MB of live heap. 64 KB is
// four seconds of 8 kHz 16-bit audio in a single frame — generous for anything
// real, and nowhere near a number that can be used to exhaust memory.
//
// Note what this does NOT bound: the frame RATE. receiveAudio() is sample-driven
// with no limiter, so a client can still spend CPU on demodulation as fast as
// its socket carries frames. maxSessions below is what bounds that, this being
// a single-threaded process.
const WS_MAX_PAYLOAD = 64 * 1024;
const wss = new WebSocketServer({ server: httpServer, maxPayload: WS_MAX_PAYLOAD });

let _sessionSeq = 0;
let _sessions = 0;                      // live WebSocket sessions, for maxSessions

// ─── Per-board concurrency ──────────────────────────────────────────────────
// How many connections this server currently holds to each destination, keyed on
// the RESOLVED address and port. This is the limit that protects the boards
// rather than this server, and it is the only limit here a real visitor can
// meet: a popular board during a door-game tournament is exactly the case, which
// is why exceeding it SPEAKS (a reorder tone) instead of hanging silently, and
// why the number is generous.
//
// Keyed on the resolved address on purpose. A hostname key counts one board
// twice when it answers to two names, and a wildcard DNS record would multiply
// the allowance without limit.
//
// Rate is NOT limited here and does not need to be: a modem dial is paced by its
// own handshake (the answer side's transmit is wall-clocked, so a scripted
// client cannot fast-forward it), and telnet bypass has its own explicit
// interval. This is concurrency only.
const _perBoard = new Map();            // 'ip:port' -> count

function boardKey(ip, port) { return `${ip}:${port}`; }

function boardAcquire(key) {
  const cap = site.config().maxPerBoardConcurrent || 0;
  const n = _perBoard.get(key) || 0;
  if (cap && n >= cap) return false;
  _perBoard.set(key, n + 1);
  return true;
}

function boardRelease(key) {
  if (!key) return;
  const n = (_perBoard.get(key) || 0) - 1;
  if (n > 0) _perBoard.set(key, n);
  else _perBoard.delete(key);          // deleted, not left at zero: the map is
}                                      // keyed on client-influenced values

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

// ─── Name resolution, with a deadline ───────────────────────────────────────
// dns.lookup() has no timeout of its own. It inherits the system resolver's, and
// a name that does not exist can take a very long time to say so — `options
// timeout:2 attempts:3` with a search domain or two is fifteen seconds, and an
// unreachable resolver is longer. Two reasons that is not acceptable here:
//
//   - the caller is listening to a dial tone that has to end sometime. The
//     browser holds one for six seconds; past that it is silence, which is the
//     thing the tone was added to remove;
//   - getaddrinfo runs on the libuv THREADPOOL, four threads by default and
//     shared with every file write this process makes. Slow lookups are the
//     cheapest way to stall a server that otherwise never blocks.
//
// The callback runs exactly once either way.
function lookupWithDeadline(host, cb) {
  const ms = site.config().resolveTimeoutMs || 0;
  let done = false;
  const finish = (err, addr, family) => {
    if (done) return;
    done = true;
    if (timer) clearTimeout(timer);
    cb(err, addr, family);
  };
  const timer = ms > 0 ? setTimeout(() => {
    const e = new Error('name lookup timed out');
    e.code = 'ETIMEDOUT';
    finish(e);
  }, ms) : null;
  if (timer && timer.unref) timer.unref();
  // The lookup itself is NOT cancellable — the threadpool slot is held until
  // getaddrinfo returns whatever the resolver eventually says. This bounds what
  // the CALLER waits for, not what the pool does; keeping the deadline well
  // under the resolver's own is what keeps the two from diverging.
  dns.lookup(host, (err, addr, family) => finish(err, addr, family));
}

// ─── Telnet-bypass abuse gates ──────────────────────────────────────────────
// A modem call paces itself: V.8, a handshake and a 300–33600 bps link mean a
// visitor cannot turn this server into a fast connection machine even if they
// want to. Telnet bypass has none of that — the TCP connect happens the moment
// the dial arrives — so it carries the two limits the modem path gets for free:
//
//   1. the destination must be a board the directory actually offers (either
//      tier, after the blacklist), so bypass can never be pointed at an
//      arbitrary host;
//   2. one bypass dial SERVER-WIDE per `directMinIntervalSeconds`.
//
// The second is deliberately global rather than per client. Per-client is the
// usual shape and it is the wrong one here: the limiter's whole job is to make
// abuse unrewarding, and an abuser has more addresses than a real visitor has
// patience — a per-IP bucket is exactly what a rotating source defeats and a
// single user never notices. Global inverts that. This is a small service and
// the modem path, which is what it is for, is not limited at all, so the worst
// case is that telnet bypass queues up for a while under attack while every
// modem speed keeps working.
//
// It DELAYS rather than refuses, and says nothing: dialling again too soon
// simply takes longer to answer, the way a real line would, and gives an abuser
// no signal to calibrate against. The reservation is taken when the dial
// arrives rather than when it completes, so hanging up early buys back none of
// the interval.
let _directNextAt = 0;                  // earliest permitted bypass dial, ms

function directDialDelay() {
  const gap = Math.max(0, (site.config().directMinIntervalSeconds || 0) * 1000);
  if (!gap) return 0;
  const now = Date.now();
  const at = Math.max(now, _directNextAt);
  _directNextAt = at + gap;
  return at - now;
}

/** Is this destination one the directory offers? Bypass requires it. */
function isListed(host, port) { return describeDest(host, port).tier !== 'manual'; }

wss.on('connection', (ws, req) => {
  // Behind Cloudflare (or any proxy) the socket address is the edge, not the
  // visitor — logger.clientIp() resolves the real one, gated on trustProxy.
  const peer = logger.clientIp(req);
  const id = ++_sessionSeq;

  // Server-wide session ceiling. Every dialled session owns a software modem and
  // a 5 ms transmit timer, so this is what bounds the cost of a flood. Refused
  // with a message rather than a silent drop: the only people who will ever see
  // it are real visitors during a genuine crowd, and an abuser learns nothing
  // from it they could not learn by counting their own failures.
  const maxSessions = site.config().maxSessions || 0;
  if (maxSessions && _sessions >= maxSessions) {
    logger.warn('session', `id=${id} ${peer} refused: ${_sessions} sessions already open`);
    try {
      ws.send(JSON.stringify({ type: 'status', level: 'error', text: 'server is busy — try again shortly' }));
      ws.close(1013, 'busy');           // 1013 = Try Again Later
    } catch (_) {}
    return;
  }
  _sessions++;
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
  let heldBoard = null;      // per-board concurrency slot, released at teardown

  // Byte totals. Four integer adds on paths that already handle every buffer —
  // no allocation, no I/O, one line at teardown. Off via `trackBytes: false`.
  const track = logger.config().trackBytes !== false;
  // (named `count`, not `bytes` — toClient's parameter is already `bytes`)
  const count = { telnetIn: 0, telnetOut: 0, audioIn: 0, audioOut: 0 };

  // Per-chunk transfer logging. This is what used to fill the console; it is
  // now behind `debug` in config/logging.json and off by default.
  const log = (...a) => logger.debug(peer, id, a.join(' '));

  logger.sessionOpen(peer, id, req.headers && req.headers['user-agent']);

  // ── Idle disconnect ───────────────────────────────────────────────────────
  // A modem link is a continuous signal: an abandoned tab keeps both this
  // socket and a connection to someone else's BBS open for as long as the
  // browser is left running. Boards have had idle timers since the eighties for
  // exactly that reason, so this one is ours.
  //
  // "Idle" is measured on PAYLOAD, in either direction — a keystroke from the
  // user or a byte from the board — and deliberately NOT on the audio, which
  // never stops: a modem carrier is sent continuously whether or not anyone is
  // typing, so an audio-based timer would never fire. It is armed at link-up
  // rather than at connect, so the handshake (nine seconds at 300 bps) can
  // never be mistaken for silence.
  const IDLE_MS = Math.max(0, (site.config().idleDisconnectMinutes || 0) * 60000);
  let idleTimer = null;
  function idlePoke() {
    if (!IDLE_MS || !connected) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = null;
      logger.info('idle', `id=${id} ${dest.host}:${dest.port} idle ${IDLE_MS / 60000}m — disconnecting`);
      sendJSON({ type: 'status', level: 'info',
                 text: `idle for ${IDLE_MS / 60000} minutes — disconnecting` });
      teardown('idle');
    }, IDLE_MS);
    if (idleTimer.unref) idleTimer.unref();
  }

  // ── Abandoned calls ───────────────────────────────────────────────────────
  // Two states the idle timer above cannot see, because it is armed at link-up:
  // a socket that connects and never dials, and a dial whose carrier never comes
  // up. The second is the expensive one — it owns a live ModemDSP and its 5 ms
  // transmit timer for as long as the socket is held open.
  //
  // Neither costs a visitor anything. public/main.js opens a NEW WebSocket for
  // every Connect (and dial() below accepts one dial per socket, ever), so a
  // session in either state is one nobody is on: closing it can only ever
  // reclaim a modem, never interrupt a call.
  const NO_DIAL_MS  = Math.max(0, (site.config().noDialTimeoutSeconds || 0) * 1000);
  const CARRIER_MS  = Math.max(0, (site.config().carrierTimeoutSeconds || 0) * 1000);
  let noDialTimer = null, carrierTimer = null;

  function armTimer(ms, what, reason) {
    if (!ms) return null;
    const t = setTimeout(() => {
      if (torndown || connected) return;
      logger.info('session', `id=${id} ${what} after ${ms / 1000}s — closing`);
      teardown(reason);
    }, ms);
    if (t.unref) t.unref();
    return t;
  }
  noDialTimer = armTimer(NO_DIAL_MS, 'no dial', 'no-dial-timeout');

  // Telnet terminates here, one filter per connection (its state is per-session).
  // Payload goes toClient(); negotiation replies go straight back down the TCP
  // socket and never touch the modem.
  const filter = new TelnetFilter();

  function sendJSON(o) { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(o)); }

  // ── The one answer to "the call did not go through" ───────────────────────
  // Refused, timed out, unresolvable, an unlisted board, the per-board cap —
  // every one of them produces the SAME message, and the client answers it with
  // a reorder tone and BUSY.
  //
  // That uniformity is the point, twice over. For the visitor it is one honest
  // signal instead of four different failure strings. For everyone else it
  // closes an oracle: this used to ship `e.message` to the client, so a caller
  // could tell ECONNREFUSED from ETIMEDOUT from "not listed" — which is exactly
  // the distinction a port scanner needs, and it was being handed over for free.
  // The real code still goes to the logs, where the operator wants it.
  //
  // (Timing still distinguishes a refusal from a black hole. Closing that needs
  // a uniform delay on every failure, which would make the honest case worse for
  // no gain worth having now that the interesting destinations are refused
  // outright.)
  function noConnect(reason) {
    sendJSON({ type: 'busy', reason });
    teardown(reason);
  }

  let torndown = false;
  function teardown(reason) {
    if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (noDialTimer) { clearTimeout(noDialTimer); noDialTimer = null; }
    if (carrierTimer) { clearTimeout(carrierTimer); carrierTimer = null; }
    if (heldBoard) { boardRelease(heldBoard); heldBoard = null; }
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
    idlePoke();                       // the board said something: not idle
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
    // The call is up, so the two abandoned-call deadlines have done their job.
    // From here the idle timer is what watches this session.
    if (carrierTimer) { clearTimeout(carrierTimer); carrierTimer = null; }
    if (noDialTimer) { clearTimeout(noDialTimer); noDialTimer = null; }
    idlePoke();          // arm the idle timer only now — see IDLE_MS above
    // Counted here, on a link that actually came up, rather than at dial: a
    // dead board a hundred people tried shouldn't look popular. The failures
    // are in telnetFailLog instead.
    //
    // The per-board key is only minted for a board the DIRECTORY offers. It used
    // to be minted for every destination, which made cache/bbsStats.json an
    // ever-growing record of every address anyone ever reached — manual dials
    // and ATDT are real features, so that grew in normal use, not just under
    // abuse — and that map is rewritten whole every few seconds AND served to
    // every visitor inside /bbs.json. The counts are only ever displayed for
    // directory entries, so nothing is lost by not keeping the rest.
    //
    // `total` still counts EVERY connect: it is what the ready line means by
    // "dials total from all users", and that should not quietly become "dials to
    // boards we happen to list".
    bbsstats.record(dest.host, dest.port, { perBoard: isListed(dest.host, dest.port) });
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
    if (noDialTimer) { clearTimeout(noDialTimer); noDialTimer = null; }
    direct = link === 'direct';
    port = parseInt(port, 10) || 23;

    // The host is a string off the wire and nothing has looked at it yet. It is
    // about to reach dns.lookup(), net.createConnection() and — the reason the
    // length bound matters as much as the character set — several log lines,
    // where a newline in it would forge whole records in the operator's only
    // account of what happened. Checked before it is assigned to `dest`, so
    // nothing downstream can see an unvalidated one.
    if (!netguard.isValidHost(host)) {
      logger.warn('dial', `id=${id} ${peer} rejected a malformed host (${String(host).length} chars)`);
      return noConnect('bad-host');
    }
    host = String(host).trim();
    dest = { host, port };
    // Arm the carrier deadline as soon as we have dialled. Direct mode clears it
    // in linkUp() like everything else; it exists for a handshake that never
    // finishes, which is the state that holds a modem open indefinitely.
    carrierTimer = armTimer(CARRIER_MS, 'no carrier', 'carrier-timeout');
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
      return noConnect('host-not-allowed');
    }

    const listed = isListed(host, port);

    // The operator's lever, off by default. Turning it on removes manual
    // host:port entry, ATDT to an arbitrary address, and share links to boards
    // the directory has not caught up with — real features, which is why this is
    // a switch to pull under abuse rather than the shipped behaviour.
    if (site.config().requireListedForAllDials && !listed) {
      logger.warn('dial', `id=${id} ${peer} unlisted board refused (requireListedForAllDials): ${host}:${port}`);
      return noConnect('not-listed');
    }

    // Port policy. Only for a destination the directory does not offer: a listed
    // board is exempt, because some answer on 80 or 443 to get through a
    // restrictive firewall and refusing those would break real boards to close a
    // hole a listed destination does not open. → lib/netguard.js.
    const portCheck = netguard.portAllowed(port, listed, site.portRules());
    if (!portCheck.ok) {
      logger.warn('dial', `id=${id} ${peer} port refused: ${host}:${port} (${portCheck.why})`);
      return noConnect('port-not-allowed');
    }
    // ── Direct mode: no modem at all ────────────────────────────────────────
    // The DSP is skipped entirely; payload rides binary WS frames both ways.
    // Everything else — the telnet filter, the pending queue, teardown — is
    // identical, because the transport is the only thing that changed.
    if (direct) {
      // Gate 1: a board the directory offers, or nothing. → the note above.
      // Answered with the standard no-connect response rather than its own
      // message: a distinct refusal here told a caller which addresses are in
      // the directory and which are merely unreachable, which is the same oracle
      // the failure paths used to hand over.
      if (site.config().directRequireListed && !listed) {
        logger.warn('dial', `id=${id} ${peer} telnet bypass to an unlisted board: ${host}:${port}`);
        return noConnect('direct-not-listed');
      }
      // Gate 2: pace it. Silent by design — no message, just a later answer.
      const wait = directDialDelay();
      logger.dial(peer, id, host, port,
                  `direct ${filter.cols}x${filter.rows}${wait ? ` +${Math.round(wait / 1000)}s` : ''}`);
      log(`dial ${host}:${port} direct (modem bypassed)${wait ? `, held ${wait}ms` : ''}`);
      sendJSON({ type: 'status', level: 'info', text: 'connecting (modem bypassed)…' });
      const go = () => {
        if (torndown || ws.readyState !== ws.OPEN) return;   // gave up while held
        openSocket(host, port, () => {
          linkUp('direct');
          sendJSON({ type: 'connected', protocol: 'DIRECT', bps: 0, direct: true });
        });
      };
      if (!wait) go();
      else { const t = setTimeout(go, wait); if (t.unref) t.unref(); }
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
      idlePoke();                     // the user typed: not idle
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
  // surface AFTER the handshake rather than instantly. They are answered with a
  // reorder tone — see noConnect() — which is what a switchboard that could not
  // complete a call did, and is deliberately the SAME answer every other kind of
  // failure gets.
  //
  // The address is resolved HERE, once, and the socket is opened to the resolved
  // IP rather than to the name. That is not a tidy-up: isListed() and every other
  // check operate on a hostname, while net.createConnection() would perform its
  // OWN lookup, so the thing checked and the thing connected to were different
  // data and a short TTL could make them disagree. The directory holds thousands
  // of names whose DNS belongs to strangers — including lapsed domains anyone may
  // register — so "this name is in the guide" cannot be allowed to mean "this
  // address is safe to reach".
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
    // One lookup, and everything downstream uses its answer.
    lookupWithDeadline(host, (err, addr, family) => {
      if (torndown || ws.readyState !== ws.OPEN) return;
      if (err) {
        noteFail(host, port, err.code || 'EAI_FAIL');
        return noConnect('dns');
      }

      // The address policy. A constant in lib/netguard.js with no config key:
      // loopback, RFC1918, link-local (169.254.169.254 is the cloud metadata
      // service, which hands out credentials), CGNAT, multicast and the rest.
      // Being in the directory is NOT an exemption — a board's DNS belongs to
      // its sysop, and this is the check that makes that safe.
      const verdict = netguard.addressAllowed(addr);
      if (!verdict.ok) {
        logger.warn('dial', `id=${id} ${peer} refused ${host}:${port} → ${addr} (${verdict.why})`);
        noteFail(host, port, 'EBLOCKED');
        return noConnect('address-not-allowed');
      }
      if (verdict.viaFlag) {
        // Warned on EVERY dial it permits, not once at boot. The whole risk of
        // this flag is that somebody stops noticing it is set.
        logger.warn('dial', `id=${id} --allow-private-ips permitted ${host}:${port} → ${addr} (${verdict.why})`);
      }

      // Per-board concurrency, on the RESOLVED address. Taken here rather than
      // at dial on purpose: a slot reserved at dial would be held through the
      // whole handshake, and — more to the point — a check at dial would have
      // meant refusing the call before the board was ever contacted, which is
      // the design this function exists to preserve.
      const key = boardKey(addr, port);
      if (!boardAcquire(key)) {
        logger.warn('dial', `id=${id} ${peer} ${host}:${port} → ${addr} at the per-board limit ` +
                            `(${site.config().maxPerBoardConcurrent})`);
        return noConnect('board-busy');
      }
      heldBoard = key;

      connectTo(addr, host, port, family, onConnect);
    });
  }

  function connectTo(addr, host, port, family, onConnect) {
    sock = net.createConnection({ host: addr, port, family });
    sock.setNoDelay(true);
    // A black-holed host never errors — the OS sits on the SYN for minutes.
    // Without this, the board never reaches telnetFailLog and the user stares
    // at a dead CONNECT. Configurable in config/site.json; 0 disables.
    const tmo = site.config().connectTimeoutMs;
    if (tmo > 0) {
      connectTimer = setTimeout(() => {
        connectTimer = null;
        if (connected || !sock) return;
        noteFail(host, port, 'ETIMEDOUT');
        noConnect('telnet-timeout');
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
      // through a handshake and has a CONNECT on screen. It is answered with the
      // reorder tone rather than with the error text — the exact code told a
      // caller refused from filtered from unreachable, which is precisely what a
      // port scan needs. The operator still gets the real code, above.
      if (!connected) return noConnect('telnet-error');
      sendJSON({ type: 'status', level: 'error', text: `telnet error: ${e.message}` });
      teardown('telnet-error');
    });
  }

  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      let msg; try { msg = JSON.parse(data.toString()); } catch (_) { return; }
      // Resolve the destination host → IP so the browser can "dial" the numeric
      // address in DTMF before the carrier handshake. Cosmetic — openSocket()
      // does its own authoritative lookup and connects to THAT answer, never to
      // this one — but not therefore unchecked:
      //
      //   - the host is validated first, because unvalidated it reached
      //     getaddrinfo on the libuv threadpool (four threads, shared with fs),
      //     for any string, any number of times, before any dial;
      //   - the ANSWER is put through the same address policy as a dial, so this
      //     cannot be used to map the operator's internal DNS from outside.
      if (msg.type === 'resolve') {
        if (!netguard.isValidHost(msg.host)) {
          return sendJSON({ type: 'resolveError', host: '', error: 'invalid host' });
        }
        const want = String(msg.host).trim();
        lookupWithDeadline(want, (err, addr) => {
          if (err) return sendJSON({ type: 'resolveError', host: want, error: err.code || 'lookup failed' });
          if (!netguard.addressAllowed(addr).ok) {
            logger.warn('resolve', `id=${id} ${peer} refused ${want} → ${addr}`);
            return sendJSON({ type: 'resolveError', host: want, error: 'lookup failed' });
          }
          sendJSON({ type: 'resolved', host: want, ip: addr });
        });
        return;
      }
      if (msg.type === 'dial') dial(msg.host, msg.port, msg.protocol, msg.v34Rate, msg.link,
                                    msg.cols, msg.rows);
      return;
    }
    // Binary frames mean different things per transport: PCM audio for the
    // modem's RX, or raw payload straight to the BBS in direct mode.
    if (direct) { idlePoke(); toBBS(Buffer.from(data)); return; }
    const buf = Buffer.from(data);
    if (track) count.audioIn += buf.length;
    if (dsp) dsp.receiveAudio(int16ToFloat(buf));
  });

  // The session count must come back down exactly once, whichever event fires
  // first — a socket that errors and then closes would otherwise leak a slot per
  // failure, and a leaked slot is permanent until restart.
  let counted = true;
  const uncount = () => { if (counted) { counted = false; _sessions--; } };
  ws.on('close', () => {
    uncount();
    log('ws closed'); logger.sessionClose(peer, id, 'ws-closed'); teardown('ws-closed');
  });
  ws.on('error', () => { uncount(); teardown('ws-error'); });
});

httpServer.listen(PORT, () => {
  logger.hookExit();
  logger.startDailySummary();
  logger.prune();
  const c = logger.config();
  console.log(`${site.config().brand} server on http://localhost:${PORT}`);
  console.log(`Logging to ${logger.logDir()} (retain ${c.retentionDays || '∞'} days` +
              `${c.debug ? ', DEBUG ON' : ''})`);
  logger.info('server', `listening on ${PORT}; ${bbsstats.total()} total dials recorded`);
  if (ALLOW_HOSTS.length) logger.info('server', `allowed hosts: ${ALLOW_HOSTS.join(', ')}`);
  // What this server will and will not dial, said out loud at every boot. An
  // operator should be able to see the policy without reading the code, and the
  // flag line below is the one that must never be quietly true.
  const sc = site.config();
  const rules = site.portRules();
  logger.info('server', rules.length
    ? `port policy: ${rules.length} blocked range(s) from config/site.json, ` +
      'listed boards exempt'
    : 'port policy: NOTHING BLOCKED — config/site.json blockedPorts is empty');
  logger.info('server',
    `dial limits: max ${sc.maxSessions || '∞'} sessions, ` +
    `${sc.maxPerBoardConcurrent || '∞'} per board, connect timeout ${sc.connectTimeoutMs}ms` +
    `${sc.requireListedForAllDials ? ', LISTED BOARDS ONLY' : ''}`);
  const flag = netguard.flagState();
  if (flag.enabled) {
    logger.warn('server', `--allow-private-ips IS SET ${flag.spec} — this server will dial ` +
                          'non-public addresses. Do not run a public instance this way.');
  } else {
    logger.info('server', 'private, loopback and link-local destinations are refused');
  }
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
