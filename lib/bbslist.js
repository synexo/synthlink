/*
 * lib/bbslist.js — the two-tier BBS directory.
 *
 *   Tier 1  config/curated.txt   hand-maintained, committed, shown first in the
 *                                order written. This is where most users go.
 *   Tier 2  the Telnet BBS Guide monthly list, fetched and cached under cache/,
 *                                sorted alphabetically. Never committed.
 *
 * Being a good citizen of telnetbbsguide.com
 * ------------------------------------------
 * The guide's list changes MONTHLY, so downloading it daily would be ~30x more
 * traffic than the data justifies. Instead the daily job does one conditional
 * GET of the download page (a few hundred bytes, normally answered 304) and
 * only downloads the zip when the monthly filename actually changes — roughly
 * once a month. On top of that:
 *   - a descriptive User-Agent, so the operator can see who is calling;
 *   - the next check time is PERSISTED, so restarting the server does not
 *     re-fetch, and instances don't converge on the same moment;
 *   - randomised jitter on every schedule;
 *   - exponential backoff on failure, capped at the normal interval;
 *   - client requests NEVER trigger a fetch. Upstream traffic is completely
 *     decoupled from user traffic.
 *
 * Only the MONTHLY list is used. The site offers a daily list too, but states
 * it "is NOT intended to be distributed to other websites or BBS systems, only
 * for personal use", where the monthly "is intended for distribution to other
 * websites and BBS systems".
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const https = require('https');
const { URL } = require('url');

const ROOT       = path.join(__dirname, '..');
const CACHE_DIR  = path.join(ROOT, 'cache');
const CURATED    = path.join(ROOT, 'config', 'curated.txt');
const BLACKLIST  = path.join(ROOT, 'config', 'blacklist.txt');
const LEGACY_JSON= path.join(ROOT, 'config', 'bbs.json');
const GUIDE_JSON = path.join(CACHE_DIR, 'guide.json');
const META_JSON  = path.join(CACHE_DIR, 'meta.json');

const LIST_PAGE  = 'https://www.telnetbbsguide.com/lists/download-list/';
const UA = 'SynthLink/1.0 (+https://github.com/synexo/synthlink) BBS directory updater';

const DAY        = 24 * 60 * 60 * 1000;
const JITTER     = 0.15;                 // +/-15%, so instances spread out
const BOOT_DELAY = [5000, 60000];        // random delay before a due-at-boot check
const MIN_ROWS   = 100;                  // sanity floor; below this we keep the old cache

// ── tiny helpers ────────────────────────────────────────────────────────────
// Proportional, so it can never invert a short backoff. (A fixed +/-2h window
// applied to a 30-minute retry produced negative delays.)
const jitter = (ms) => Math.max(60000, ms * (1 + (Math.random() * 2 - 1) * JITTER));
const rnd = ([lo, hi]) => lo + Math.random() * (hi - lo);

function readJSON(f, fallback) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return fallback; }
}
function writeJSONAtomic(f, obj) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 0));
  fs.renameSync(tmp, f);                 // atomic: readers never see a half file
}

// ── minimal ZIP reader ──────────────────────────────────────────────────────
// Enough of the format to pull one file out of an archive, with no dependency.
// Parses the central directory rather than scanning for local headers, because
// local headers may carry zeroed sizes when a data descriptor is used.
function unzipEntry(buf, wanted) {
  // End of Central Directory record, searched backwards (comment may follow it).
  let eocd = -1;
  const from = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip (no end-of-central-directory)');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);          // central directory offset

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory');
    const method   = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen  = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commLen  = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name     = buf.toString('utf8', p + 46, p + 46 + nameLen);

    if (name.toLowerCase() === wanted.toLowerCase()) {
      if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error('bad local header');
      // The local header's own name/extra lengths are authoritative for finding
      // where the data starts — they can differ from the central directory's.
      const lNameLen  = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lNameLen + lExtraLen;
      const data  = buf.subarray(start, start + compSize);
      if (method === 0) return Buffer.from(data);          // stored
      if (method === 8) return zlib.inflateRawSync(data);  // deflate
      throw new Error(`unsupported zip compression method ${method}`);
    }
    p += 46 + nameLen + extraLen + commLen;
  }
  throw new Error(`${wanted} not found in archive`);
}

// ── CSV ─────────────────────────────────────────────────────────────────────
// Fields are quoted where they contain commas (location, software), so a naive
// split() would corrupt the row. "" inside a quoted field is a literal quote.
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);   // strip BOM
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// The published header is "bbsName, bbsSysop, ... " — note the leading spaces,
// so columns are matched by trimmed, case-insensitive name rather than position.
function csvToEntries(text) {
  const rows = parseCSV(text);
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const col = (n) => head.indexOf(n.toLowerCase());
  const iName = col('bbsName'), iHost = col('TelnetAddress'), iPort = col('bbsPort');
  if (iName < 0 || iHost < 0) throw new Error('bbslist.csv: missing bbsName/TelnetAddress columns');

  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const rec = rows[r];
    if (!rec || rec.length <= iHost) continue;
    const name = (rec[iName] || '').trim();
    const host = (rec[iHost] || '').trim();
    let port = iPort >= 0 ? (rec[iPort] || '').trim() : '';
    if (!name || !host) continue;
    if (!/^\d+$/.test(port)) port = '23';          // ~a third of rows have none
    const p = parseInt(port, 10);
    if (!(p > 0 && p < 65536)) continue;
    out.push({ name, host, port: p });
  }
  // NOTE: deliberately NOT de-duplicated by host:port. Ten pairs in the current
  // edition share an address but are distinct listings (e.g. "Amis XE" and
  // "Baudville"), so collapsing them would silently drop real boards.
  out.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
  return out;
}

// ── curated tier ────────────────────────────────────────────────────────────
// "Name, host:port" per line; # comments and blank lines ignored; port
// defaults to 23. File order is display order.
function parseCurated(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^﻿/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const comma = line.lastIndexOf(',');
    if (comma < 0) continue;
    const name = line.slice(0, comma).trim();
    const addr = line.slice(comma + 1).trim();
    if (!name || !addr) continue;
    const colon = addr.lastIndexOf(':');
    const host = colon > 0 ? addr.slice(0, colon).trim() : addr;
    const portS = colon > 0 ? addr.slice(colon + 1).trim() : '23';
    const port = /^\d+$/.test(portS) ? parseInt(portS, 10) : 23;
    if (!host || !(port > 0 && port < 65536)) continue;
    out.push({ name, host, port });
  }
  return out;
}

function loadCurated() {
  try {
    return parseCurated(fs.readFileSync(CURATED, 'utf8'));
  } catch (_) {
    // Fall back to the pre-curated-file format so an old checkout still works.
    const legacy = readJSON(LEGACY_JSON, null);
    if (Array.isArray(legacy)) {
      return legacy.filter((b) => b && b.host)
        .map((b) => ({ name: b.name || `${b.host}:${b.port || 23}`,
                       host: b.host, port: b.port || 23 }));
    }
    return [];
  }
}

// ── HTTP ────────────────────────────────────────────────────────────────────
function get(url, headers = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 4) return reject(new Error('too many redirects'));
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/zip,*/*',
        'Accept-Encoding': 'identity',
        ...headers,
      },
      timeout: 30000,
    }, (res) => {
      const { statusCode: status, headers: h } = res;
      if (status >= 300 && status < 400 && h.location) {
        res.resume();
        return resolve(get(new URL(h.location, url).toString(), headers, redirects + 1));
      }
      if (status === 304) { res.resume(); return resolve({ status, headers: h, body: null }); }
      if (status !== 200) { res.resume(); return reject(new Error(`HTTP ${status} for ${url}`)); }
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve({ status, headers: h, body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

// Pick the MONTHLY zip off the download page. Current filenames are
// ibbsMMYY.zip (monthly) and ibbsMMDDYY.zip (daily) — 4 digits vs 6 — but that
// is not promised to hold, so fall back to link text mentioning "monthly", and
// finally to the first zip that is clearly not the daily one.
function findMonthlyZip(html, pageUrl) {
  const abs = (u) => { try { return new URL(u, pageUrl).toString(); } catch (_) { return null; } };
  const cand = new Map();   // href -> surrounding text

  // (a) Anchors whose href ends in .zip, with or without a query string, and
  //     with or without quotes.
  const aRe = /<a\b[^>]*?href\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = aRe.exec(html))) {
    const href = m[1] || m[2] || m[3] || '';
    if (!/\.zip(\?|#|$)/i.test(href)) continue;
    const u = abs(href);
    if (u) cand.set(u, (m[4] || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
  }

  // (b) Fallback: any ibbs<digits>.zip token anywhere in the body, however it
  //     is marked up (JSON blob, data attribute, inline script, plain text).
  if (!cand.size) {
    const tRe = /(https?:\/\/[^\s"'<>()]+|\/[^\s"'<>()]*)?ibbs(\d+)\.zip/gi;
    while ((m = tRe.exec(html))) {
      const u = abs((m[1] || '/bbslist/') + `ibbs${m[2]}.zip`);
      if (u) cand.set(u, '');
    }
  }

  if (!cand.size) {
    // Say something useful instead of just "no links" — the usual causes are a
    // bot-challenge page or a JS-rendered listing, and both are visible here.
    const head = html.slice(0, 4000).toLowerCase();
    let why = `${html.length} bytes`;
    if (/just a moment|cloudflare|cf-browser-verification|captcha/.test(head)) why += ', looks like a bot challenge';
    else if (/<html/.test(head) && !/\.zip/.test(html.toLowerCase())) why += ', page has no .zip anywhere';
    else if (!/<html/.test(head)) why += ', response is not HTML';
    throw new Error(`no monthly zip link found (${why}); saved to cache/last-page.html`);
  }

  const links = [...cand.entries()].map(([href, text]) => ({ href, text }));
  const file = (l) => { try { return decodeURIComponent(l.href.split('?')[0].split('/').pop()); }
                        catch (_) { return ''; } };
  // Monthly is ibbsMMYY (4 digits); daily is ibbsMMDDYY (6). Not promised to
  // hold, hence the fallbacks below it.
  const byDigits = links.find((l) => /^ibbs\d{4}\.zip$/i.test(file(l)));
  if (byDigits) return byDigits.href;

  const context = (l) => (l.text + ' ' + file(l)).toLowerCase();
  const monthly = links.find((l) => /month/.test(context(l)) && !/dai?ly/.test(context(l)));
  if (monthly) return monthly.href;

  const notDaily = links.find((l) => !/dai?ly/.test(context(l)) && !/^ibbs\d{6}\.zip$/i.test(file(l)));
  if (notDaily) return notDaily.href;
  throw new Error('could not tell the monthly list from the daily one');
}

// ── refresh ─────────────────────────────────────────────────────────────────
// Returns { changed, reason }. Never throws for network reasons — the caller
// keeps serving whatever is cached.
async function refresh({ force = false, log = () => {} } = {}) {
  const meta = readJSON(META_JSON, {});
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  // 1. Conditional GET of the listing page. Normally a 304.
  const cond = {};
  if (!force && meta.pageETag) cond['If-None-Match'] = meta.pageETag;
  if (!force && meta.pageModified) cond['If-Modified-Since'] = meta.pageModified;

  const page = await get(LIST_PAGE, cond);
  if (page.status === 304 && meta.file && fs.existsSync(GUIDE_JSON)) {
    log('listing page unchanged (304)');
    return { changed: false, reason: 'page-304' };
  }
  meta.pageETag = page.headers.etag || meta.pageETag;
  meta.pageModified = page.headers['last-modified'] || meta.pageModified;

  const html = page.body.toString('utf8');
  let zipUrl;
  try {
    zipUrl = findMonthlyZip(html, LIST_PAGE);
  } catch (e) {
    try { fs.writeFileSync(path.join(CACHE_DIR, 'last-page.html'), html); } catch (_) {}
    throw e;
  }
  const file = decodeURIComponent(zipUrl.split('/').pop());

  // 2. Same monthly file we already ingested? Then there is nothing to fetch.
  if (!force && meta.file === file && fs.existsSync(GUIDE_JSON)) {
    log(`monthly list unchanged (${file})`);
    writeJSONAtomic(META_JSON, meta);
    return { changed: false, reason: 'same-file' };
  }

  // 3. New month (or no usable cache) — download it. Deliberately NOT a
  // conditional request: we only get here once we've established we actually
  // need the bytes, and a 304 here would leave us with nothing to serve if the
  // cache had been deleted.
  log(`fetching ${file}`);
  const zip = await get(zipUrl);

  const csv = unzipEntry(zip.body, 'bbslist.csv').toString('utf8');
  const entries = csvToEntries(csv);
  if (entries.length < MIN_ROWS) {
    throw new Error(`only ${entries.length} rows parsed — refusing to replace the cache`);
  }

  // 4. Commit: keep the artefacts for inspection, then swap in the parsed list.
  fs.writeFileSync(path.join(CACHE_DIR, file), zip.body);
  fs.writeFileSync(path.join(CACHE_DIR, 'bbslist.csv'), csv);
  writeJSONAtomic(GUIDE_JSON, { source: LIST_PAGE, file, fetched: new Date().toISOString(),
                                entries });
  meta.file = file;
  meta.zipETag = zip.headers.etag || null;
  meta.zipModified = zip.headers['last-modified'] || null;
  meta.count = entries.length;
  writeJSONAtomic(META_JSON, meta);

  // Drop older monthly archives so cache/ doesn't grow without bound.
  for (const f of fs.readdirSync(CACHE_DIR)) {
    if (/\.zip$/i.test(f) && f !== file) {
      try { fs.unlinkSync(path.join(CACHE_DIR, f)); } catch (_) {}
    }
  }
  log(`updated: ${entries.length} entries from ${file}`);
  return { changed: true, reason: 'updated', count: entries.length, file };
}

/**
 * Ingest a monthly zip already on disk — no network at all.
 *
 * Two ways in:
 *   npm run update-bbslist -- --file ~/Downloads/ibbs0826.zip
 *   drop the zip into cache/ and restart (or wait for the next check)
 *
 * Useful when the site can't be reached, blocks the updater, or changes its
 * page layout — the data is the same file either way.
 */
function ingestZipFile(zipPath, { log = () => {} } = {}) {
  const buf = fs.readFileSync(zipPath);
  const csv = unzipEntry(buf, 'bbslist.csv').toString('utf8');
  const entries = csvToEntries(csv);
  if (entries.length < MIN_ROWS) {
    throw new Error(`only ${entries.length} rows parsed — refusing to replace the cache`);
  }
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const file = path.basename(zipPath);
  const dest = path.join(CACHE_DIR, file);
  if (path.resolve(zipPath) !== path.resolve(dest)) fs.copyFileSync(zipPath, dest);
  fs.writeFileSync(path.join(CACHE_DIR, 'bbslist.csv'), csv);
  writeJSONAtomic(GUIDE_JSON, { source: 'manual', file,
                                fetched: new Date().toISOString(), entries });
  const meta = readJSON(META_JSON, {});
  meta.file = file; meta.count = entries.length; meta.manual = true;
  meta.zipETag = null; meta.zipModified = null;
  writeJSONAtomic(META_JSON, meta);
  loadGuide();
  log(`ingested ${file}: ${entries.length} entries`);
  return { changed: true, reason: 'manual', count: entries.length, file };
}

/**
 * Pick up a zip dropped into cache/ by hand. Ingests the newest one whose name
 * differs from what's already loaded (or anything at all, if we have no list).
 */
function ingestDropped({ log = () => {} } = {}) {
  let names;
  try { names = fs.readdirSync(CACHE_DIR).filter((f) => /\.zip$/i.test(f)); }
  catch (_) { return false; }
  if (!names.length) return false;
  const meta = readJSON(META_JSON, {});
  const haveList = !!_guide;
  const newest = names
    .map((f) => ({ f, m: fs.statSync(path.join(CACHE_DIR, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)[0];
  if (haveList && newest.f === meta.file) return false;   // already ingested
  try {
    log(`found ${newest.f} in cache/, ingesting without network`);
    ingestZipFile(path.join(CACHE_DIR, newest.f), { log });
    return true;
  } catch (e) {
    log(`could not ingest ${newest.f}: ${e.message}`);
    return false;
  }
}

// ── blacklist ───────────────────────────────────────────────────────────────
// config/blacklist.txt removes boards from what the directory OFFERS. Applied
// at directory-assembly time rather than by rewriting the cached guide, so it
// survives every monthly refresh with nothing to re-run; and re-read on mtime
// like curated.txt, so an edit is live on the next /bbs.json request.
//
// Two shapes per line: `host` blocks every port on that host, `host:port` just
// the one. Hosts are compared lower-cased.

/** → { hosts:Set<string>, pairs:Set<'host:port'> } */
function parseBlacklist(text) {
  const hosts = new Set(), pairs = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^﻿/, '').replace(/#.*$/, '').trim();
    if (!line) continue;
    const colon = line.lastIndexOf(':');
    // Only treat a trailing `:digits` as a port — an IPv6 literal or a stray
    // colon in a hostname must not be shredded into a bogus host/port pair.
    if (colon > 0 && /^\d+$/.test(line.slice(colon + 1))) {
      const host = line.slice(0, colon).trim().toLowerCase();
      const port = parseInt(line.slice(colon + 1), 10);
      if (host && port > 0 && port < 65536) pairs.add(`${host}:${port}`);
      continue;
    }
    hosts.add(line.toLowerCase());
  }
  return { hosts, pairs };
}

let _blacklist = { hosts: new Set(), pairs: new Set() };
let _blacklistMtime = 0;

function blacklistCurrent() {
  let mtime = 0;
  try { mtime = fs.statSync(BLACKLIST).mtimeMs; } catch (_) { mtime = -1; }
  if (mtime !== _blacklistMtime) {
    _blacklistMtime = mtime;
    try { _blacklist = parseBlacklist(fs.readFileSync(BLACKLIST, 'utf8')); }
    catch (_) { _blacklist = { hosts: new Set(), pairs: new Set() }; }
  }
  return _blacklist;
}

function isBlacklisted(host, port, bl = blacklistCurrent()) {
  const h = String(host || '').toLowerCase();
  if (!h) return false;
  return bl.hosts.has(h) || bl.pairs.has(`${h}:${parseInt(port, 10) || 23}`);
}

/** Cheap change-detector for the /bbs.json payload cache. */
function blacklistStamp() {
  blacklistCurrent();
  return `${_blacklistMtime}:${_blacklist.hosts.size + _blacklist.pairs.size}`;
}

// ── directory assembly + scheduling ─────────────────────────────────────────
let _curated = [], _curatedMtime = 0, _guide = null, _onChange = null;

function curatedCurrent() {
  // Re-read on change so the file stays live-editable, as config/bbs.json was.
  let mtime = 0;
  try { mtime = fs.statSync(CURATED).mtimeMs; } catch (_) { mtime = -1; }
  if (mtime !== _curatedMtime) { _curatedMtime = mtime; _curated = loadCurated(); }
  return _curated;
}

function loadGuide() {
  const g = readJSON(GUIDE_JSON, null);
  _guide = g && Array.isArray(g.entries) ? g : null;
}

/** The payload served at /bbs.json. */
function directory() {
  // Blacklisted boards are dropped from BOTH tiers, before the de-duplication
  // below, so a curated entry can be retired without editing curated.txt.
  const bl = blacklistCurrent();
  const curated = curatedCurrent().filter((e) => !isBlacklisted(e.host, e.port, bl));
  // A curated board shouldn't also appear in the long list below it.
  const seen = new Set(curated.map((e) => `${e.host.toLowerCase()}:${e.port}`));
  const guide = (_guide ? _guide.entries : [])
    .filter((e) => !seen.has(`${e.host.toLowerCase()}:${e.port}`))
    .filter((e) => !isBlacklisted(e.host, e.port, bl));
  return {
    curated,
    guide,
    guideFile: _guide ? _guide.file : null,
    guideFetched: _guide ? _guide.fetched : null,
    guideSource: LIST_PAGE,
  };
}

function scheduleNext(meta, ms, log) {
  ms = Math.min(Math.max(60000, ms || 0), 2 ** 31 - 1);   // always sane and positive
  meta.nextCheck = Date.now() + ms;
  writeJSONAtomic(META_JSON, meta);
  const t = setTimeout(() => tick(log), ms);
  if (t.unref) t.unref();     // never hold the process open on our account
  log(`next check in ${(ms / 3600000).toFixed(1)}h`);
}

async function tick(log) {
  const meta = readJSON(META_JSON, {});
  // A zip dropped in by hand wins — no reason to call out if it's already here.
  if (ingestDropped({ log })) { if (_onChange) _onChange(); }
  try {
    const r = await refresh({ log });
    meta.fails = 0;
    if (r.changed) { loadGuide(); if (_onChange) _onChange(); }
    const m2 = readJSON(META_JSON, {});
    m2.fails = 0;
    scheduleNext(m2, jitter(DAY), log);
  } catch (e) {
    meta.fails = (meta.fails || 0) + 1;
    // Back off, but never slower than the normal daily cadence.
    const backoff = Math.min(DAY, 30 * 60 * 1000 * 2 ** (meta.fails - 1));
    log(`update failed (${e.message}); serving cache`);
    scheduleNext(meta, jitter(backoff), log);
  }
}

/**
 * Load what's cached, serve immediately, and arm the daily check.
 * Nothing here blocks startup or a client request.
 */
function start({ log = () => {}, onChange = null } = {}) {
  _onChange = onChange;
  loadGuide();
  ingestDropped({ log });          // honour a hand-dropped zip on boot
  curatedCurrent();
  log(`directory: ${_curated.length} curated, ${_guide ? _guide.entries.length : 0} from the guide`
      + (_guide ? ` (${_guide.file})` : ' (no cache yet)'));

  const meta = readJSON(META_JSON, {});
  const due = !meta.nextCheck || Date.now() >= meta.nextCheck || !_guide;
  const delay = Math.min(Math.max(1000, due ? rnd(BOOT_DELAY) : meta.nextCheck - Date.now()),
                         2 ** 31 - 1);
  const t = setTimeout(() => tick(log), delay);
  if (t.unref) t.unref();
}

module.exports = { start, refresh, directory, loadGuide, loadCurated,
                   ingestZipFile, ingestDropped,
                   unzipEntry, csvToEntries, parseCurated, CACHE_DIR,
                   parseBlacklist, isBlacklisted, blacklistStamp, BLACKLIST };
