'use strict';
/*
 * lib/log.js — SynthLink access logging.
 *
 * Three daily files under the configured log directory, all rotated at local
 * midnight and pruned after `retentionDays`:
 *
 *   accessLog-YYYY-MM-DD.log      HTTP requests in Apache *combined* format,
 *                                 plus modem/BBS session events in a parallel
 *                                 human-readable form (see EVENT LINES below).
 *   telnetFailLog-YYYY-MM-DD.log  one line per outgoing BBS connection that
 *                                 never came up. This is a worklist: the boards
 *                                 in it are candidates for config/blacklist.txt.
 *   summaryLog-YYYY-MM-DD.log     one end-of-day block: totals, top boards.
 *
 * Design notes
 * ------------
 * - Dependency-free and synchronous-free on the hot path: every write goes to an
 *   appending stream. Nothing here allocates per audio chunk.
 * - Rotation is checked lazily, on write, rather than from a timer. A timer
 *   would either hold the process open or need unref'ing, and a server with no
 *   traffic has nothing to rotate anyway. The one exception is the end-of-day
 *   summary, which must fire even on an idle day — that uses an unref'd timer.
 * - The date stamp is LOCAL, not UTC, because the operator reads these by day.
 * - Console output is an aggregate of all three streams (see `console` config).
 *   Per-chunk transfer logging is separate and lives behind `debug`.
 *
 * EVENT LINES (accessLog, alongside the combined-format HTTP lines)
 *   [21/Aug/2026:14:03:11 -0400] ip SESSION open  id=3 proto=- ua="..."
 *   [21/Aug/2026:14:03:12 -0400] ip DIAL    id=3 bbs.example.org:23 via V32bis
 *   [21/Aug/2026:14:03:16 -0400] ip CONNECT id=3 bbs.example.org:23 V32bis/14400
 *   [21/Aug/2026:14:09:02 -0400] ip END     id=3 bbs.example.org:23 dur=346.1s
 *                                    telnetIn=48210 telnetOut=1204 audioIn=... reason=remote-closed
 *   [21/Aug/2026:14:03:16 -0400] ip FAIL    id=3 bbs.example.org:23 ECONNREFUSED
 */

const fs   = require('fs');
const path = require('path');
// Address parsing lives in netguard, which is the module about addresses. It
// had two copies for a while — one here for trustedProxies and one there for
// the dial policy — and two copies of address parsing is the duplication that
// goes stale. The names below are re-exported so nothing that called them here
// (including logtest.js) has to change.
const netguard = require('./netguard');
const configload = require('./configload');
const { ipToBytes, parseCIDRList, matchBlocks } = netguard;

const ROOT = path.join(__dirname, '..');
const CONFIG_FILE = path.join(ROOT, 'config', 'logging.json');

// ── configuration ───────────────────────────────────────────────────────────
// config/logging.json only. Deliberately no environment variables: one file is
// the whole story, and the operator edits it with the same editor they use for
// curated.txt and blacklist.txt.
const DEFAULTS = {
  dir: 'logs',
  level: 'info',            // 'error' | 'warn' | 'info'
  debug: false,             // per-chunk transfer logging (very verbose)
  retentionDays: 30,
  console: 'aggregate',     // 'aggregate' | 'off'
  trustProxy: true,         // honour CF-Connecting-IP / X-Forwarded-For
  trustedProxies: [],       // [] = trust any peer when trustProxy is on
  trackBytes: true,         // per-session byte totals (four integer adds; free)
  // connectTimeoutMs used to live here. It is call behaviour, not a logging
  // preference, and it now lives in config/site.json — see the warning in
  // loadConfig() for a file that still carries the old key.
};

// How many distinct client addresses the daily summary will count before it
// stops adding new ones. The set is per day and reported as one number, but it
// is unbounded memory keyed on a value a client can influence (see clientIp and
// trustedProxies), so it gets a ceiling. Reaching it makes the count read as
// "at least N", which is the honest thing for a number that stopped counting.
const MAX_UNIQUE_IPS = 50000;

const LEVELS = { error: 0, warn: 1, info: 2 };

// One rule per setting. This file had NONE until now — it was
// `{ ...DEFAULTS, ...file }` and nothing else, which is how `trustProxy: "no"`
// came to be kept as a truthy string: the operator meant to stop believing
// forwarded headers, the check `if (!cfg.trustProxy)` stepped straight over it,
// and a spoofable header went on being trusted with nothing said. → configload.
const RULES = {
  dir:            { type: 'string' },
  level:          { type: 'enum', values: ['error', 'warn', 'info'] },
  debug:          { type: 'bool' },
  retentionDays:  { type: 'int', min: 0, max: 3650 },
  console:        { type: 'enum', values: ['aggregate', 'off'] },
  trustProxy:     { type: 'bool' },
  trackBytes:     { type: 'bool' },
  // Checked by the module that matches them, so there is one definition of what
  // an address is. A list that parses to nothing while LOOKING like a list is
  // the failure this catches: peerTrusted() would then trust nobody, which is
  // safe, but the operator asked for something else and would not know.
  trustedProxies: {
    type: 'array',
    check: (v) => {
      const bad = [];
      netguard.parseCIDRList(v, (b) => bad.push(b));
      return bad.length
        ? `trustedProxies has ${bad.length} entry/entries that are not an address or ` +
          `CIDR block: ${bad.map((b) => JSON.stringify(b)).join(', ')}`
        : null;
    },
  },
};

// Settings that used to live here. Named explicitly rather than reported as an
// unknown key, because "it moved, and here is where" is the answer the operator
// needs and "that is not a setting" is not.
const MOVED = {
  connectTimeoutMs: 'has moved to config/site.json, where the rest of the call behaviour lives',
};

let cfg = { ...DEFAULTS };
let _fatal = null;        // surfaced by the server at boot, which then refuses to start
// The compiled form of cfg.trustedProxies. Declared here, beside cfg, because
// loadConfig() below fills it in at module load — further down the file it
// would be in its own temporal dead zone.
let trustedBlocks = [];

function loadConfig() {
  const { cfg: loaded, fatal } = configload.loadConfigFile(
    CONFIG_FILE, 'config/logging.json', DEFAULTS, RULES, MOVED);
  _fatal = fatal;
  cfg = loaded;
  // Compiled here rather than per request. On a fatal this is empty, which
  // trusts nobody — the safe direction for the few moments before server.js
  // stops.
  trustedBlocks = fatal ? [] : netguard.parseCIDRList(cfg.trustedProxies);
  return cfg;
}

loadConfig();

function config() { return cfg; }
/** A reason the server must not start, or null. → server.js's boot check. */
function fatal() { return _fatal; }
function isDebug() { return !!cfg.debug; }

function logDir() {
  return path.isAbsolute(cfg.dir) ? cfg.dir : path.join(ROOT, cfg.dir);
}

// ── date helpers ────────────────────────────────────────────────────────────
function two(n) { return n < 10 ? '0' + n : '' + n; }

/** Local YYYY-MM-DD — the file stamp. Sorts correctly under `ls`. */
function dayStamp(d = new Date()) {
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Apache's `[10/Oct/2000:13:55:36 -0700]` inner text, without the brackets. */
function clfTime(d = new Date()) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `${two(d.getDate())}/${MONTHS[d.getMonth()]}/${d.getFullYear()}:` +
         `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())} ` +
         `${sign}${two(Math.floor(a / 60))}${two(a % 60)}`;
}

/** ms until the next local midnight (+1s of slack so we land inside the day). */
function msUntilMidnight(now = new Date()) {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1, 0);
  return next.getTime() - now.getTime();
}

// ── streams ─────────────────────────────────────────────────────────────────
// One appending stream per kind, reopened when the day stamp changes. Streams
// are unref'd: logging never keeps the process alive on its own account.
const KINDS = { access: 'accessLog', telnetFail: 'telnetFailLog', summary: 'summaryLog' };

// An open fd written with writeSync, NOT a WriteStream.
//
// A stream buffers, which means a line is not on disk when the call returns:
// `tail -f` lags, a crash loses the tail, and — the reason this was changed —
// anything reading the file back (the tests, an operator's grep a second later)
// sees nothing. One write syscall per line is the honest trade here: this
// server logs a handful of lines per request and per call, not per audio chunk
// (that is what `debug` is for), so the syscall rate is trivially low.
const streams = {};        // kind -> { day, fd }
let _dirReady = false;

function ensureDir() {
  if (_dirReady) return true;
  try { fs.mkdirSync(logDir(), { recursive: true }); _dirReady = true; }
  catch (e) {
    process.stderr.write(`[log] cannot create ${logDir()}: ${e.message}\n`);
    return false;
  }
  return true;
}

function streamFor(kind, now = new Date()) {
  const day = dayStamp(now);
  const cur = streams[kind];
  if (cur && cur.day === day) return cur.fd;
  if (cur) { try { fs.closeSync(cur.fd); } catch (_) {} delete streams[kind]; }
  if (!ensureDir()) return null;
  const file = path.join(logDir(), `${KINDS[kind]}-${day}.log`);
  let fd;
  try { fd = fs.openSync(file, 'a'); }
  catch (e) { process.stderr.write(`[log] ${file}: ${e.message}\n`); return null; }
  streams[kind] = { day, fd, file };
  // A new day's first write is the natural moment to prune. Doing it here rather
  // than on a timer means an idle server never wakes up to do filesystem work.
  if (cur) prune();
  return fd;
}

// Everything that reaches a log line goes through here first.
//
// Log lines are one per line by construction, and several fields on them come
// from the client: `msg.host` off the WebSocket is the direct one, and it is
// not a hostname until something checks it. A newline in that string forges
// whole records — a fabricated CONNECT, an END that never happened, a summary
// block — in the operator's only forensic record and in the worklist the
// blacklist is built from.
//
// server.js validates the host at the WebSocket boundary, which is the actual
// fix. This is the guarantee: the boundary check can be bypassed by a field
// nobody thought of, and a sink that cannot emit a newline cannot be made to
// forge a record whatever reaches it. Length is bounded here for the same
// reason — a multi-megabyte host would otherwise be a multi-megabyte writeSync
// on the request path.
const MAX_LINE = 2000;
function sanitize(line) {
  let s = String(line == null ? '' : line)
    // C0 controls, DEL, and the C1 range. Replaced rather than dropped so the
    // line still shows that something was there.
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '\uFFFD');
  if (s.length > MAX_LINE) s = s.slice(0, MAX_LINE) + '…[truncated]';
  return s;
}

function writeLine(kind, line, { consoleTag = null, level = 'info' } = {}) {
  line = sanitize(line);
  const fd = streamFor(kind);
  if (fd != null) {
    try { fs.writeSync(fd, line + '\n'); }
    catch (e) { process.stderr.write(`[log] write failed: ${e.message}\n`); }
  }
  if (cfg.console === 'aggregate' && LEVELS[level] <= LEVELS[cfg.level]) {
    process.stdout.write((consoleTag ? consoleTag + ' ' : '') + line + '\n');
  }
}

/** Delete stamped files older than retentionDays. 0 = keep forever. */
function prune() {
  if (!cfg.retentionDays) return [];
  const cutoff = Date.now() - cfg.retentionDays * 86400000;
  const removed = [];
  let names;
  try { names = fs.readdirSync(logDir()); } catch (_) { return removed; }
  const known = Object.values(KINDS);
  for (const name of names) {
    const m = /^([A-Za-z]+)-(\d{4})-(\d{2})-(\d{2})\.log$/.exec(name);
    if (!m || !known.includes(m[1])) continue;
    // Compare on the stamp, not mtime: an appended-to file from a week ago still
    // has a fresh mtime, and the stamp is what the operator reasons about.
    const when = new Date(+m[2], +m[3] - 1, +m[4], 23, 59, 59).getTime();
    if (when >= cutoff) continue;
    try { fs.unlinkSync(path.join(logDir(), name)); removed.push(name); } catch (_) {}
  }
  return removed;
}

// ── client IP resolution ────────────────────────────────────────────────────
// Most traffic arrives through Cloudflare, so the socket address is the edge,
// not the visitor. Precedence: CF-Connecting-IP, then the LEFTMOST
// X-Forwarded-For hop, then the socket.
//
// The headers are only honoured when the immediate peer is trusted. Without
// that gate a direct visitor could set CF-Connecting-IP by hand and write
// whatever they liked into the access log. `trustedProxies: []` means "trust
// any peer" — correct when the box is only reachable through the proxy, which
// is the deployment this is written for; list the edge addresses to tighten it.
function normalizeIp(ip) {
  if (!ip) return '-';
  // Node reports IPv4 over a dual-stack socket as ::ffff:1.2.3.4.
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

// `trustedProxies` entries are literal addresses OR CIDR blocks, v4 and v6.
// Ranges are the point: Cloudflare publishes ~15 IPv4 and ~7 IPv6 blocks and no
// list of literal edge addresses exists, so exact matching left this setting
// unusable for the deployment the file is written for.
//
// This gates ATTRIBUTION ONLY — whether an upstream header is believed over the
// socket address. Nothing here refuses a request, and it is not an access
// control list. Closing an origin to direct traffic is a firewall or a tunnel,
// not a logging setting.

/**
 * The configured list → the blocks it means. An unparseable entry is dropped
 * with a warning rather than taking the server down — and see peerTrusted():
 * a list where NOTHING parsed trusts nobody, so a typo here can only ever
 * tighten this, never loosen it.
 *
 * The parsing itself is netguard's (see the require at the top of this file);
 * this wrapper exists only to keep the warning wording that names the config
 * file the operator just edited.
 */
function parseTrustedList(list, warnFn) { return parseCIDRList(list, warnFn); }

/** Is `ip` inside any of `blocks`? Families never cross — a v4 address is not
 *  in a v6 block, and the mapped form has already been reduced to v4. */
function matchTrusted(ip, blocks) { return matchBlocks(ip, blocks); }

function peerTrusted(socketIp) {
  // A configuration this module could not read must not answer permissively.
  // server.js stops before listening, so in production this state does not serve
  // a request — but the fallback on a fatal is DEFAULTS, and the default here is
  // `trustedProxies: []`, which means "trust any peer". A module that cannot
  // read its config answering "yes, believe that header" is the wrong shape of
  // wrong, whatever is meant to stop first.
  if (_fatal) return false;
  if (!cfg.trustProxy) return false;
  const configured = Array.isArray(cfg.trustedProxies) ? cfg.trustedProxies.length : 0;
  if (!configured) return true;              // [] = trust any peer
  // Configured, but nothing usable parsed: trust NOBODY. Falling back to "trust
  // any peer" would mean one typo silently reopened header spoofing, which is
  // the opposite of what an operator filling this in was reaching for.
  if (!trustedBlocks.length) return false;
  return matchTrusted(socketIp, trustedBlocks);
}

function clientIp(req) {
  const socketIp = normalizeIp(req.socket && req.socket.remoteAddress);
  if (!peerTrusted(socketIp)) return socketIp;
  const h = req.headers || {};
  const cf = h['cf-connecting-ip'];
  if (cf) return normalizeIp(String(cf).trim());
  const xff = h['x-forwarded-for'];
  if (xff) {
    const first = String(xff).split(',')[0].trim();
    if (first) return normalizeIp(first);
  }
  return socketIp;
}

// ── counters (for the daily summary) ────────────────────────────────────────
function freshCounters() {
  return {
    day: dayStamp(),
    started: new Date().toISOString(),
    httpRequests: 0,
    httpStatus: {},          // '200' -> n
    httpBytes: 0,
    uniqueIps: new Set(),
    sessions: 0,
    dials: 0,
    connects: 0,
    failures: 0,
    failuresByCode: {},
    telnetIn: 0,             // BBS → user, payload bytes
    telnetOut: 0,            // user → BBS, payload bytes
    audioIn: 0,              // client → server PCM bytes
    audioOut: 0,             // server → client PCM bytes
    sessionSeconds: 0,
    boards: {},              // 'host:port' -> connects
  };
}
let counters = freshCounters();

function bump(obj, key, n = 1) { obj[key] = (obj[key] || 0) + n; }

/** Count a client address, up to MAX_UNIQUE_IPS distinct ones per day. */
function noteIp(ip) {
  if (counters.uniqueIps.size < MAX_UNIQUE_IPS) counters.uniqueIps.add(ip);
}

// ── public logging API ──────────────────────────────────────────────────────

/**
 * Apache combined:
 *   host ident authuser [date] "request" status bytes "referer" "user-agent"
 */
function httpRequest(req, res, bytes) {
  const ip = clientIp(req);
  const h = req.headers || {};
  const status = res.statusCode;
  const n = bytes == null ? '-' : bytes;
  const line = `${ip} - - [${clfTime()}] ` +
               `"${req.method} ${req.url} HTTP/${req.httpVersion}" ${status} ${n} ` +
               `"${h.referer || '-'}" "${h['user-agent'] || '-'}"`;
  counters.httpRequests++;
  bump(counters.httpStatus, String(status));
  if (typeof bytes === 'number') counters.httpBytes += bytes;
  noteIp(ip);
  writeLine('access', line, { level: 'info' });
}

function event(ip, kind, id, rest, level = 'info') {
  writeLine('access', `[${clfTime()}] ${ip} ${kind.padEnd(7)} id=${id}${rest ? ' ' + rest : ''}`,
            { level });
}

function sessionOpen(ip, id, ua) {
  counters.sessions++;
  noteIp(ip);
  event(ip, 'SESSION', id, `open ua="${ua || '-'}"`);
}

function sessionClose(ip, id, reason) {
  event(ip, 'SESSION', id, `close reason=${reason}`);
}

function dial(ip, id, host, port, how) {
  counters.dials++;
  event(ip, 'DIAL', id, `${host}:${port} via ${how}`);
}

function connect(ip, id, host, port, how) {
  counters.connects++;
  bump(counters.boards, `${host}:${port}`);
  event(ip, 'CONNECT', id, `${host}:${port} ${how}`);
}

/**
 * A BBS connection that never came up. Written to BOTH the access log (so the
 * session reads in one place) and the dedicated fail log (so it can be reviewed
 * as a blacklist worklist without wading through everything else).
 */
function telnetFail(ip, id, host, port, code, extra = {}) {
  counters.failures++;
  bump(counters.failuresByCode, code || 'UNKNOWN');
  event(ip, 'FAIL', id, `${host}:${port} ${code}`, 'warn');
  const name = extra.name ? ` name="${extra.name}"` : '';
  const tier = extra.tier ? ` tier=${extra.tier}` : '';
  writeLine('telnetFail',
            `[${clfTime()}] ${host}:${port} ${code}${name}${tier} client=${ip}`,
            { level: 'warn' });
}

/**
 * End of a call. `bytes` is optional — when `trackBytes` is off the totals are
 * simply absent rather than zero, so a summary can't quietly report zero
 * traffic as if it were measured.
 */
function sessionEnd(ip, id, host, port, ms, bytes, reason) {
  const secs = ms / 1000;
  counters.sessionSeconds += secs;
  let b = '';
  if (bytes) {
    counters.telnetIn  += bytes.telnetIn  || 0;
    counters.telnetOut += bytes.telnetOut || 0;
    counters.audioIn   += bytes.audioIn   || 0;
    counters.audioOut  += bytes.audioOut  || 0;
    b = ` telnetIn=${bytes.telnetIn || 0} telnetOut=${bytes.telnetOut || 0}` +
        ` audioIn=${bytes.audioIn || 0} audioOut=${bytes.audioOut || 0}`;
  }
  const where = host ? `${host}:${port} ` : '';
  event(ip, 'END', id, `${where}dur=${secs.toFixed(1)}s${b} reason=${reason}`);
}

/** Generic server-level note (startup, bbslist, config problems). */
function info(tag, msg)  { writeLine('access', `[${clfTime()}] - ${tag} ${msg}`, { level: 'info' }); }
function warn(tag, msg)  { writeLine('access', `[${clfTime()}] - ${tag} ${msg}`, { level: 'warn' }); }
function error(tag, msg) { writeLine('access', `[${clfTime()}] - ${tag} ${msg}`, { level: 'error' }); }

/**
 * Per-chunk transfer logging. THIS is what used to make the console unreadable —
 * a line per buffer in both directions. Behind `debug` and off by default.
 */
function debug(ip, id, msg) {
  if (!cfg.debug) return;
  writeLine('access', `[${clfTime()}] ${ip} DEBUG   id=${id} ${msg}`, { level: 'info' });
}

// ── daily summary ───────────────────────────────────────────────────────────
function human(n) {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${u[i]}`;
}

function summaryText(c = counters) {
  const boards = Object.entries(c.boards).sort((a, b) => b[1] - a[1]);
  const top = boards.slice(0, 10)
    .map(([hp, n]) => `    ${String(n).padStart(5)}  ${hp}`).join('\n');
  const status = Object.entries(c.httpStatus).sort()
    .map(([s, n]) => `${s}=${n}`).join(' ') || '-';
  const codes = Object.entries(c.failuresByCode).sort((a, b) => b[1] - a[1])
    .map(([s, n]) => `${s}=${n}`).join(' ') || '-';
  const avg = c.connects ? (c.sessionSeconds / c.connects) : 0;
  return [
    `── SynthLink daily summary — ${c.day} ─────────────────────────────`,
    `  HTTP requests     ${c.httpRequests}  (${status})`,
    `  HTTP bytes        ${human(c.httpBytes)}`,
    `  unique clients    ${c.uniqueIps.size >= MAX_UNIQUE_IPS ? '\u2265' : ''}${c.uniqueIps.size}`,
    `  sessions opened   ${c.sessions}`,
    `  BBS dials         ${c.dials}`,
    `  BBS connects      ${c.connects}`,
    `  BBS failures      ${c.failures}  (${codes})`,
    `  distinct boards   ${boards.length}`,
    `  telnet payload    in ${human(c.telnetIn)} / out ${human(c.telnetOut)}`,
    `  modem audio       in ${human(c.audioIn)} / out ${human(c.audioOut)}`,
    `  total call time   ${(c.sessionSeconds / 60).toFixed(1)} min` +
      (c.connects ? `  (avg ${avg.toFixed(1)}s)` : ''),
    boards.length ? `  top boards:\n${top}` : '  top boards:      -',
    '─'.repeat(62),
  ].join('\n');
}

/**
 * Write the summary for the day just ended and start a fresh set of counters.
 * The stream is selected with the ENDING day's stamp so the block lands in that
 * day's file, not tomorrow's.
 */
function writeSummary(endedAt = new Date(Date.now() - 60000)) {
  const c = counters;
  counters = freshCounters();
  const fd = streamFor('summary', endedAt);
  const text = summaryText(c);
  if (fd != null) { try { fs.writeSync(fd, text + '\n'); } catch (_) {} }
  if (cfg.console === 'aggregate') process.stdout.write(text + '\n');
  return text;
}

let _summaryTimer = null;
/**
 * Arm the end-of-day summary. Unref'd, so it never holds the process open, and
 * re-armed from the fired callback rather than with setInterval — the interval
 * to midnight is not constant across a DST boundary.
 */
function startDailySummary() {
  if (_summaryTimer) return;
  const arm = () => {
    _summaryTimer = setTimeout(() => {
      writeSummary();
      prune();
      _summaryTimer = null;
      arm();
    }, msUntilMidnight());
    if (_summaryTimer.unref) _summaryTimer.unref();
  };
  arm();
}

function stopDailySummary() {
  if (_summaryTimer) { clearTimeout(_summaryTimer); _summaryTimer = null; }
}

/**
 * Close every open log file. Every line is already on disk (writeSync), so this
 * releases descriptors rather than flushing — it is safe to call at any time,
 * and a later write simply reopens.
 */
function close() {
  stopDailySummary();
  for (const k of Object.keys(streams)) {
    try { fs.closeSync(streams[k].fd); } catch (_) {}
    delete streams[k];
  }
}

let _hooked = false;
function hookExit() {
  if (_hooked) return;
  _hooked = true;
  const bye = (sig) => { info('server', `shutting down (${sig})`); close(); process.exit(0); };
  process.on('SIGINT',  () => bye('SIGINT'));
  process.on('SIGTERM', () => bye('SIGTERM'));
  process.on('exit', () => { for (const k of Object.keys(streams)) { try { fs.closeSync(streams[k].fd); } catch (_) {} } });
}

module.exports = {
  loadConfig, config, fatal, isDebug, logDir,
  clientIp, normalizeIp, peerTrusted,
  httpRequest, sessionOpen, sessionClose, dial, connect, telnetFail, sessionEnd,
  info, warn, error, debug,
  prune, writeSummary, summaryText, startDailySummary, stopDailySummary,
  close, hookExit,
  // exposed for tools/tests/logtest.js
  _internals: { dayStamp, clfTime, msUntilMidnight, freshCounters, human, sanitize,
                ipToBytes, parseTrustedList, matchTrusted,
                get counters() { return counters; },
                set counters(v) { counters = v; } },
};
