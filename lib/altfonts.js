/*
 * altfonts.js — config/altfonts.txt: which boards are drawn against something
 * other than CP437.
 *
 * ONE id per board, because a font entry carries the typeface, the encoding and
 * the column count together (public/fonts/index.js). So this file has nothing
 * to say about charsets or widths — naming the font settles all three, which is
 * also how SyncTERM does it.
 *
 * Shape and lifecycle are deliberately the blacklist's: two line forms, hosts
 * lower-cased, re-read on mtime so an edit is live on the next request with
 * nothing to restart. The map is served whole at /altfonts.json rather than
 * looked up per dial, so a hand-typed address and a shared link get the same
 * answer a directory entry does — the client already holds it before it dials,
 * which is what lets the font (and therefore the column count) be settled
 * BEFORE the window size rides out on the dial message.
 *
 * An id no font answers to is not validated here: this module has no view of
 * the browser's font registry, and inventing a second copy of it server-side to
 * check against is exactly the duplication that goes stale. The client ignores
 * an unknown id and leaves the user's own font alone.
 *
 * SynthLink's own code, GPL-3.0-or-later.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'config', 'altfonts.txt');

/**
 * → { 'host:port': fontId, 'host': fontId }
 *
 * Both shapes live in one map. A bare host is stored under the host alone and
 * a host:port pair under both parts joined, so a lookup is two probes with the
 * more specific one first, and there is nothing to iterate.
 */
function parse(text) {
  const map = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/^﻿/, '').replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = line.match(/^(\S+)\s+(\S+)$/);
    if (!m) continue;                         // not two fields — ignore, silently
    const dest = m[1].toLowerCase();
    const font = m[2];
    const colon = dest.lastIndexOf(':');
    // Only a trailing `:digits` is a port. An IPv6 literal or a stray colon in
    // a hostname must not be shredded into a bogus pair — the same rule the
    // blacklist parser follows, for the same reason.
    if (colon > 0 && /^\d+$/.test(dest.slice(colon + 1))) {
      const port = parseInt(dest.slice(colon + 1), 10);
      if (port > 0 && port < 65536) map[dest] = font;
      continue;
    }
    map[dest] = font;
  }
  return map;
}

let _map = {};
let _mtime = 0;

/** The current map, re-read if the file changed. Missing file → empty map. */
function current() {
  let mtime = 0;
  try { mtime = fs.statSync(FILE).mtimeMs; } catch (_) { mtime = -1; }
  if (mtime !== _mtime) {
    _mtime = mtime;
    try { _map = parse(fs.readFileSync(FILE, 'utf8')); }
    catch (_) { _map = {}; }
  }
  return _map;
}

/**
 * The font id for a destination, or null.
 *
 * host:port beats a bare host, so a board on one port of a shared host can be
 * called out without claiming the rest of it.
 */
function fontFor(host, port) {
  const h = String(host || '').toLowerCase();
  if (!h) return null;
  const map = current();
  return map[`${h}:${parseInt(port, 10) || 23}`] || map[h] || null;
}

/** Cheap change-detector for the /altfonts.json payload cache. */
function stamp() {
  current();
  return `${_mtime}:${Object.keys(_map).length}`;
}

module.exports = { parse, current, fontFor, stamp };
