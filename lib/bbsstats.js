'use strict';
/*
 * lib/bbsstats.js — per-board dial counters.
 *
 * A single JSON file, cache/bbsStats.json:
 *
 *   { "total": 1482,
 *     "boards": { "bbs.example.org:23": { "count": 91, "last": "2026-08-21T18:03:11.412Z" } } }
 *
 * `total` is every successful connect the server has ever made, across all
 * users — it is what the terminal's ready line reports. It is stored rather
 * than summed from `boards` so that pruning a board from the file (or
 * blacklisting one) doesn't quietly rewrite history.
 *
 * Writes are debounced and atomic (write-temp + rename), because this is
 * touched on every connect and the file is also read by the /bbs.json builder.
 * The counter lives in cache/ with the guide data: it is derived, machine-owned,
 * and not committed.
 *
 * Counting policy: a board is counted on a SUCCESSFUL connect, not on dial.
 * A dead board that a hundred people tried and none reached should not look
 * popular — the failures are already recorded in telnetFailLog.
 */

const fs   = require('fs');
const path = require('path');

const ROOT      = path.join(__dirname, '..');
const CACHE_DIR = path.join(ROOT, 'cache');
const STATS     = path.join(CACHE_DIR, 'bbsStats.json');

const FLUSH_MS = 5000;

let _data = null;
let _dirty = false;
let _timer = null;

function key(host, port) { return `${String(host).toLowerCase()}:${parseInt(port, 10) || 23}`; }

function load() {
  if (_data) return _data;
  try {
    const raw = JSON.parse(fs.readFileSync(STATS, 'utf8'));
    _data = {
      total: parseInt(raw.total, 10) || 0,
      boards: (raw.boards && typeof raw.boards === 'object') ? raw.boards : {},
    };
  } catch (_) {
    _data = { total: 0, boards: {} };
  }
  return _data;
}

function flush() {
  if (!_dirty) return;
  _dirty = false;
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const tmp = STATS + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(load()));
    fs.renameSync(tmp, STATS);
  } catch (_) { /* a stats file is not worth taking the server down for */ }
}

function schedule() {
  if (_timer) return;
  _timer = setTimeout(() => { _timer = null; flush(); }, FLUSH_MS);
  if (_timer.unref) _timer.unref();   // never hold the process open
}

/** Record one successful connect. */
function record(host, port) {
  const d = load();
  const k = key(host, port);
  const e = d.boards[k] || (d.boards[k] = { count: 0, last: null });
  e.count++;
  e.last = new Date().toISOString();
  d.total++;
  _dirty = true;
  schedule();
  return e.count;
}

/** Grand total of connects across all boards and users. */
function total() { return load().total; }

/**
 * Flat `{ 'host:port': count }` for the /bbs.json payload. Counts only — the
 * timestamps are for the operator, not the browser, and shipping them would
 * roughly double the size of this block for no visible gain.
 */
function counts() {
  const out = {};
  const { boards } = load();
  for (const k of Object.keys(boards)) {
    const n = boards[k] && boards[k].count;
    if (n) out[k] = n;
  }
  return out;
}

/** A cheap stamp for the /bbs.json cache: changes iff the numbers changed. */
function stamp() {
  const d = load();
  return `${d.total}:${Object.keys(d.boards).length}`;
}

function reset() { _data = { total: 0, boards: {} }; _dirty = true; }

module.exports = { record, total, counts, stamp, flush, load, reset, key, STATS };
