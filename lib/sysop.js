'use strict';
/*
 * lib/sysop.js — the operator's read-only status page.
 *
 * Two routes, both gated: `/sysop` is the page and `/sysop.json` is what it
 * polls. There is no third route and nothing here writes: every number this
 * module reports is already being kept somewhere else for its own reasons, and
 * this file only gathers them. A viewer that cannot hang up a call or edit a
 * list is a much smaller thing to get wrong than one that can, and it is the
 * whole brief.
 *
 * Disabled (the default) both routes 404. Not 401, not 403: an operator who has
 * not turned this on should be indistinguishable from a build that does not
 * have it, because the only visitors those paths ever see are scanners.
 *
 * ── Why HTTP Basic, and why the memo ────────────────────────────────────────
 *
 * Basic needs no cookie, no session store, no login form and no CSRF thinking,
 * and the browser's own prompt is the whole UI. What it does do is send the
 * credential on EVERY request, and the page polls — so the naive implementation
 * runs a password hash every few seconds, forever, in a single-threaded process
 * that is also servicing a 5 ms transmit timer for every call in progress.
 * scrypt is deliberately expensive; ~100 ms of it on a timer is audible on a
 * live modem link. So a header that has verified once is remembered for
 * MEMO_MS and costs a constant-time compare after that. Only SUCCESSFUL
 * verifications are remembered, so the map's size is bounded by the number of
 * correct credentials — an attacker sending a million wrong ones puts nothing
 * in it.
 *
 * The other half of the same problem is that an unauthenticated request would
 * otherwise be able to ask this process to run scrypt at will, which turns a
 * password hash into a CPU amplifier pointed at everybody's call. Hence one
 * verification in flight at a time: while scrypt is running, a second attempt is
 * refused WITHOUT hashing. That bounds the cost to one scrypt, and — unlike a
 * lockout after N failures — it cannot be used to keep the operator out, since
 * the slot frees itself in milliseconds.
 *
 * SynthLink's own code, GPL-3.0-or-later.
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const PAGE_FILE = path.join(__dirname, 'sysop.html');

// How long a verified Authorization header is trusted without re-hashing.
const MEMO_MS = 5 * 60 * 1000;

// Wrong answers wait this long before they are given. Not a lockout and not a
// real defence on its own — the in-flight slot below is that — but it takes
// online guessing from thousands of attempts a second to a handful.
const FAIL_DELAY_MS = 250;

const _memo = new Map();          // 'Basic …' -> expiry ms
let _verifying = false;           // one scrypt at a time, server-wide

// ── Password hashing ────────────────────────────────────────────────────────
// Format: scrypt$<N>$<r>$<p>$<salt b64>$<hash b64>. Self-describing on purpose:
// the parameters travel with the hash, so raising the cost later does not
// invalidate an operator's existing line — an old hash keeps verifying under
// the parameters it was made with.
//
// scrypt rather than a bare SHA: a single fast hash is a wordlist away from the
// password, and this one guards a page that names every caller's address.

const SCRYPT = { N: 16384, r: 8, p: 1, len: 32 };

/** Make a storable hash string for `password`. → tools/sysoppass.js */
function hashPassword(password, params = SCRYPT) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(String(password), salt, params.len,
                               { N: params.N, r: params.r, p: params.p,
                                 maxmem: 256 * 1024 * 1024 });
  return ['scrypt', params.N, params.r, params.p,
          salt.toString('base64'), dk.toString('base64')].join('$');
}

/** Parse a stored hash, or null if it is not one. */
function parseHash(stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const N = parseInt(parts[1], 10), r = parseInt(parts[2], 10), p = parseInt(parts[3], 10);
  if (!(N > 1) || !(r > 0) || !(p > 0)) return null;
  let salt, dk;
  try { salt = Buffer.from(parts[4], 'base64'); dk = Buffer.from(parts[5], 'base64'); }
  catch (_) { return null; }
  if (!salt.length || !dk.length) return null;
  return { N, r, p, salt, dk };
}

/**
 * Verify a password against a stored hash. Async because scrypt on the event
 * loop is exactly what this module is trying not to do.
 * @param {(ok:boolean)=>void} done
 */
function verifyPassword(password, stored, done) {
  const h = parseHash(stored);
  if (!h) return done(false);
  crypto.scrypt(String(password), h.salt, h.dk.length,
                { N: h.N, r: h.r, p: h.p, maxmem: 256 * 1024 * 1024 },
                (err, dk) => {
    if (err) return done(false);
    // Lengths are equal by construction (dk.length was asked for), but
    // timingSafeEqual throws on a mismatch rather than returning false.
    done(dk.length === h.dk.length && crypto.timingSafeEqual(dk, h.dk));
  });
}

// ── The gate ────────────────────────────────────────────────────────────────

function enabled(cfg) {
  return !!(cfg.sysopEnabled && cfg.sysopUser && cfg.sysopPasswordHash);
}

function unauthorized(res, brand) {
  // The realm is the brand rather than the path: it is what the browser's
  // prompt shows, and "sysop" alone tells a visitor more than it tells the
  // operator, who already knows what they typed.
  res.writeHead(401, {
    'WWW-Authenticate': `Basic realm="${String(brand).replace(/[^\x20-\x7e]|"/g, '')}", charset="UTF-8"`,
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end('unauthorized\n');
}

/**
 * Gate a request. Calls `next()` only for a request that authenticated; answers
 * it here otherwise.
 *
 * @param {object} cfg   site.config()
 * @param {() => void} next
 */
function guard(req, res, cfg, next) {
  const header = (req.headers && req.headers.authorization) || '';

  const memoUntil = _memo.get(header);
  if (memoUntil !== undefined) {
    if (memoUntil > Date.now()) return next();
    _memo.delete(header);
  }

  const m = /^Basic +([A-Za-z0-9+/=]+) *$/.exec(header);
  if (!m) return unauthorized(res, cfg.brand);

  let decoded;
  try { decoded = Buffer.from(m[1], 'base64').toString('utf8'); }
  catch (_) { return unauthorized(res, cfg.brand); }
  const cut = decoded.indexOf(':');
  if (cut < 0) return unauthorized(res, cfg.brand);
  const user = decoded.slice(0, cut);
  const pass = decoded.slice(cut + 1);

  // The username is compared in constant time too. It is not a secret, but a
  // fast reject on it would be a free oracle for which half was wrong.
  const want = Buffer.from(String(cfg.sysopUser), 'utf8');
  const got = Buffer.from(user, 'utf8');
  const userOk = want.length === got.length && crypto.timingSafeEqual(want, got);

  // One scrypt in flight, server-wide. See the header block: this is what stops
  // an unauthenticated request from spending the event loop everyone's call is
  // running on. It is deliberately not a per-IP counter — those are what a
  // rotating source defeats — and deliberately not a lockout, which would let
  // an attacker keep the operator out by failing on purpose.
  if (_verifying) return setTimeout(() => unauthorized(res, cfg.brand), FAIL_DELAY_MS);

  _verifying = true;
  verifyPassword(pass, cfg.sysopPasswordHash, (passOk) => {
    _verifying = false;
    if (!(userOk && passOk)) return setTimeout(() => unauthorized(res, cfg.brand), FAIL_DELAY_MS);
    _memo.set(header, Date.now() + MEMO_MS);
    next();
  });
}

/** Forget every memoised credential — for a config reload, and for tests. */
function forget() { _memo.clear(); _verifying = false; }

// ── The snapshot ────────────────────────────────────────────────────────────

/**
 * Build the JSON the page polls.
 *
 * Everything is passed in rather than required here: the live session registry
 * and the per-board map are server.js's, and reaching into them from a second
 * module is how two copies of the truth start.
 *
 * @param {object} src
 * @param {Iterable<object>} src.sessions  live session records
 * @param {Map<string,number>} src.perBoard
 * @param {(host:string, port:number) => {name:string, tier:string}} src.describe
 * @param {object} src.counters   logger.snapshot()
 * @param {object} src.stats      { total, boards } from bbsstats
 * @param {object} src.cfg        site.config()
 * @param {object} src.flag       netguard.flagState()
 * @param {number} src.portRules  how many blocked ranges are in force
 * @param {number} src.startedAt
 */
function snapshot(src) {
  const now = Date.now();
  const calls = [];
  for (const s of src.sessions) {
    // The name is a best-effort LABEL and the address is the fact, which is why
    // they are two fields rather than one string. A manual dial or an ATDT has
    // no name at all, and the guide lists several names on one address — so the
    // page shows what describeDest() resolves, deterministically (curated
    // first), and the address beside it is always exactly what was dialled.
    const d = s.host ? src.describe(s.host, s.port) : { name: '', tier: '' };
    calls.push({
      id: s.id,
      ip: s.ip,
      name: d.name || '',
      tier: d.tier || '',
      host: s.host || '',
      port: s.port || 0,
      // Before carrier this is what was ASKED for; after, what was agreed.
      proto: s.proto || '',
      bps: s.bps || 0,
      direct: !!s.direct,
      state: s.connected ? 'carrier' : (s.host ? 'dialing' : 'open'),
      openedSec: Math.round((now - s.openedAt) / 1000),
      // Session length as an operator means it: time on the board, which starts
      // at carrier and not when the tab opened.
      linkSec: s.linkAt ? Math.round((now - s.linkAt) / 1000) : 0,
      bytes: s.count ? { telnetIn: s.count.telnetIn, telnetOut: s.count.telnetOut,
                         audioIn: s.count.audioIn, audioOut: s.count.audioOut }
                     : null,
      ua: s.ua || '',
    });
  }
  calls.sort((a, b) => a.id - b.id);

  const boards = [];
  for (const [key, n] of src.perBoard) boards.push({ key, n });
  boards.sort((a, b) => b.n - a.n || a.key.localeCompare(b.key));

  const c = src.counters;
  return {
    now: new Date(now).toISOString(),
    uptimeSec: Math.round((now - src.startedAt) / 1000),
    brand: src.cfg.brand,
    calls,
    boards,
    today: {
      // `day` is the server's local date, and these reset with the daily
      // summary at midnight — not a rolling 24 hours.
      day: c.day,
      sessions: c.sessions,
      dials: c.dials,
      // Deliberately alongside `dials`: dials minus connects is the failure
      // rate, which is the number worth looking at.
      connects: c.connects,
      failures: c.failures,
      failuresByCode: c.failuresByCode,
      uniqueIps: c.uniqueIps,
      httpRequests: c.httpRequests,
      sessionSeconds: c.sessionSeconds,
      telnetIn: c.telnetIn,
      telnetOut: c.telnetOut,
    },
    // `total` counts every successful connect this server has ever made, so the
    // half beside it must be today's CONNECTS and not today's dials — two
    // different measurements either side of a slash would be a lie by layout.
    allTime: { connects: src.stats.total },
    limits: {
      maxSessions: src.cfg.maxSessions,
      maxPerBoardConcurrent: src.cfg.maxPerBoardConcurrent,
      idleDisconnectMinutes: src.cfg.idleDisconnectMinutes,
      directRequireListed: src.cfg.directRequireListed,
      directMinIntervalSeconds: src.cfg.directMinIntervalSeconds,
      requireListedForAllDials: src.cfg.requireListedForAllDials,
      blockedRanges: src.portRules,
      allowPrivateIps: !!(src.flag && src.flag.enabled),
      allowPrivateSpec: (src.flag && src.flag.spec) || '',
    },
    process: {
      node: process.version,
      pid: process.pid,
      rssMB: Math.round(process.memoryUsage().rss / 1048576),
    },
  };
}

// ── The page ────────────────────────────────────────────────────────────────
// It lives in lib/ rather than public/ for one reason: everything under public/
// is served to anyone who asks, so a status page there would be world-readable
// markup even with the data behind the gate. Read on every request — it is one
// small file behind an authenticated route, and an operator editing it should
// not have to restart the server to see the change.

function page(cfg) {
  return fs.readFileSync(PAGE_FILE, 'utf8')
    .replace(/\{\{REFRESH\}\}/g, String(cfg.sysopRefreshSeconds));
}

module.exports = { enabled, guard, snapshot, page, hashPassword, verifyPassword,
                   parseHash, forget, PAGE_FILE,
                   _internals: { MEMO_MS, FAIL_DELAY_MS, SCRYPT } };
