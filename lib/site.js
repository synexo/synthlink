'use strict';
/*
 * lib/site.js — site identity and other whole-server settings.
 *
 * config/site.json only, same rule as config/logging.json: one file is the
 * configuration, no environment variables, with the single exception of PORT
 * (which the operator may already be setting from a service unit, and which
 * therefore still wins).
 *
 * The point of this file is that the front end carries NO hard-coded product
 * name. `public/*.html` writes `{{BRAND}}` / `{{TAGLINE}}` / `{{TITLE}}` /
 * `{{FAVICON}}` and the static handler substitutes them on the way out, so
 * rebranding is one edit here and a restart — no rebuild, and no flash of the
 * old name, because the browser never sees a token.
 *
 * Almost everything here is best-effort: a missing or malformed file degrades to
 * the defaults below rather than refusing to boot. A server that will not start
 * because its cosmetic config has a stray comma is a worse failure than one
 * running under its default name.
 *
 * ONE EXCEPTION, and it is deliberate. `blockedPorts` is the whole port policy —
 * lib/netguard.js holds no list and no default — so a malformed entry there does
 * NOT degrade: it sets `fatal()`, and server.js refuses to start. The reasoning
 * that protects the rest of this file inverts for a denial rule. A brand that
 * falls back to "SynthLink" is a cosmetic surprise; a port list that quietly
 * failed to parse leaves an operator believing in protection they do not have,
 * and the server keeps running as if nothing were wrong.
 */

const fs   = require('fs');
const path = require('path');
const netguard = require('./netguard');
const configload = require('./configload');

const ROOT = path.join(__dirname, '..');
const CONFIG_FILE = path.join(ROOT, 'config', 'site.json');

const DEFAULTS = {
  brand: 'SynthLink',
  tagline: 'A BBS terminal that dials over a real software modem.',
  titleSuffix: 'modem-carried web BBS terminal',
  favicon: '/favicon.svg',
  port: 8088,
  // Drop a call after this many minutes with no payload in either direction.
  // A modem link is a continuous signal, so an abandoned tab holds a socket to
  // the board open indefinitely — boards have their own idle timers precisely
  // because that is rude. 0 disables.
  idleDisconnectMinutes: 30,
  // Terminal scrollback ring, in lines. Served to the browser through the
  // {{SCROLLBACK}} token rather than being a constant in main.js, because how
  // much history is worth keeping is an operator's judgement about the machines
  // their visitors are on, not the app's.
  scrollbackLines: 5000,
  // Telnet bypass (link:'direct') has no handshake to pace it: a dial is a TCP
  // connection to an arbitrary host the instant the socket opens. These two are
  // what keep that from being an open proxy.
  directRequireListed: true,
  directMinIntervalSeconds: 10,

  // ── Dialling limits ───────────────────────────────────────────────────────
  // Note what is NOT here: the rule that a destination must be publicly
  // routable. That one is a constant in lib/netguard.js with no config key at
  // all, because a setting gets turned on once and outlives the reason for it.
  // The only way past it is the --allow-private-ips command-line flag.

  // Give up on an outgoing BBS connect after this long. Moved here from
  // config/logging.json, where it never belonged: how long to wait for a board
  // is call behaviour, not a logging preference. A failure now costs the caller
  // five seconds and a reorder tone rather than fifteen seconds of silence.
  connectTimeoutMs: 5000,

  // Give up on a name lookup after this long. dns.lookup() has no timeout of its
  // own and inherits the resolver's: with `options timeout:2 attempts:3` and a
  // couple of search domains, a name that does not exist can take fifteen
  // seconds to say so. That is a caller listening to silence, and — because
  // dns.lookup() runs getaddrinfo on the libuv threadpool, which is four threads
  // shared with every file write — it is also the cheapest way to stall the
  // whole server. 0 disables.
  resolveTimeoutMs: 5000,

  // Ports this server will not dial on a host the directory does not offer.
  //
  // THIS IS THE WHOLE PORT POLICY. lib/netguard.js keeps no list and has no
  // default: what the shipped config/site.json says is what is refused, and a
  // file that says nothing refuses nothing. Emptying or removing it is a site's
  // decision to make and its consequence to own.
  //
  // The default here is empty rather than a copy of the shipped list ON PURPOSE.
  // A default would be a second copy that drifts, and it would put the policy
  // back out of sight — which is the exact fault this replaced.
  //
  // Entries are ports or "lo-hi" ranges. A malformed one STOPS STARTUP (see
  // _fatal below): a denial rule that silently fails to parse reads as
  // protection and is not, and this is the one setting in this file where
  // degrading to a default is the wrong answer.
  blockedPorts: [],

  // Every dial must name a board the directory offers, not just telnet bypass.
  // OFF by default: turning it on removes manual host:port entry, ATDT to an
  // arbitrary address, and share or embed links to unlisted boards, which are
  // real features. It is the lever to pull when the server is being abused.
  requireListedForAllDials: false,

  // At most this many WebSocket sessions at once, server-wide. Each dialled
  // session owns a software modem and a 5 ms transmit timer, so this is the
  // ceiling on what a flood can cost. 0 disables.
  maxSessions: 50,

  // At most this many simultaneous connections to any ONE board (keyed on the
  // RESOLVED address and port, so two names for the same machine cannot double
  // the allowance). This is the limit that protects the boards rather than this
  // server: dial RATE is already paced by the modem handshake, and by
  // directMinIntervalSeconds for telnet bypass. Exceeding it answers with the
  // same reorder tone every other failed connect gets. 0 disables.
  maxPerBoardConcurrent: 10,

  // A socket that connects and never dials, and a dial that never reaches
  // carrier, are both abandoned calls holding resources the idle timer cannot
  // see (it is armed at link-up, so a handshake is never mistaken for silence).
  // Neither costs a visitor anything: the client opens a fresh WebSocket for
  // every Connect, so these can only ever close a call nobody is on.
  // 0 disables either.
  noDialTimeoutSeconds: 60,
  carrierTimeoutSeconds: 120,     // slowest real handshake is ~9 s at 300 bps

  // How long the pre-roll splash takes to fade out once the app is up, in
  // seconds. Served as {{SPLASHFADE}} into the transition on #splash in
  // index.html rather than being a constant there, because how long to hold a
  // brand moment is a site's judgement — a kiosk wants longer than a board
  // whose visitors dial three times a day. The controller reads the duration
  // back off the computed style, so this is the only place the number lives.
  // 0 removes the splash the moment the app is ready, with no fade at all.
  splashFadeSeconds: 5,

  // ── Sysop status page (lib/sysop.js) ──────────────────────────────────────
  // OFF by default, and absent means off, so a deployment upgrading onto this
  // version keeps starting with the config file it already has. All three must
  // be set for the routes to exist at all; with any of them missing, /sysop and
  // /sysop.json are 404 rather than 401 — an operator who has not turned this on
  // should look exactly like a build that never had it.
  sysopEnabled: false,
  sysopUser: '',
  // scrypt$N$r$p$salt$hash, from `node tools/sysoppass.js`. Never the password
  // itself: this file is on disk, in backups, and quite possibly in a private
  // repository, and a plaintext password there is a password the operator has
  // also used somewhere else.
  sysopPasswordHash: '',
  // How often the page re-polls /sysop.json. Each poll is one authenticated
  // request answered from counters already in memory; the credential check is
  // memoised so it does not re-run the password hash. → lib/sysop.js.
  sysopRefreshSeconds: 5,
};

// One rule per setting, and every setting has one. → lib/configload.js, which
// treats anything that fails as fatal.
//
// The old tables were three (numbers, booleans, lists) and each had its own
// branch, which is how `blockedPorts` came to be silently ignored when written
// as a string and how a boolean written as "no" was kept verbatim. A single
// table with no default branch cannot grow that hole again: a key with no rule
// is itself an error.
const RULES = {
  brand:                    { type: 'string' },
  tagline:                  { type: 'string' },
  titleSuffix:              { type: 'string' },
  favicon:                  { type: 'string' },
  port:                     { type: 'int',    min: 1, max: 65535 },
  idleDisconnectMinutes:    { type: 'number', min: 0, max: 1440 },
  scrollbackLines:          { type: 'int',    min: 0, max: 100000 },
  directRequireListed:      { type: 'bool' },
  directMinIntervalSeconds: { type: 'number', min: 0, max: 3600 },
  connectTimeoutMs:         { type: 'int',    min: 0, max: 120000 },
  resolveTimeoutMs:         { type: 'int',    min: 0, max: 60000 },
  requireListedForAllDials: { type: 'bool' },
  maxSessions:              { type: 'int',    min: 0, max: 10000 },
  maxPerBoardConcurrent:    { type: 'int',    min: 0, max: 1000 },
  noDialTimeoutSeconds:     { type: 'number', min: 0, max: 3600 },
  carrierTimeoutSeconds:    { type: 'number', min: 0, max: 3600 },
  splashFadeSeconds:        { type: 'number', min: 0, max: 30 },
  sysopEnabled:             { type: 'bool' },
  sysopUser:                { type: 'string' },
  sysopRefreshSeconds:      { type: 'int',    min: 1, max: 3600 },
  // Checked by the module that verifies it, so there is one definition of what a
  // hash is. A password pasted in here by hand instead of a hash is the mistake
  // worth catching at boot rather than at the login prompt.
  sysopPasswordHash: {
    type: 'string',
    check: (v) => (v === '' || require('./sysop').parseHash(v)) ? null
      : 'sysopPasswordHash is not a hash this server can read. It must be the ' +
        'scrypt$… line printed by `node tools/sysoppass.js` — not the password itself.',
  },
  // The whole port policy. Its entries are checked by the module that enforces
  // them, so there is one definition of what a rule is.
  blockedPorts: {
    type: 'array',
    check: (v) => {
      const { bad } = netguard.parsePortRules(v);
      return bad.length
        ? `blockedPorts has ${bad.length} entry/entries that are not a port or a "lo-hi" ` +
          `range: ${bad.map((b) => JSON.stringify(b)).join(', ')}`
        : null;
    },
  },
};

let _cfg = null;
// There is no _warning any more. Every way this file can be wrong now stops the
// server, so there is no category of "wrong but carry on" left to report.
let _fatal = null;        // surfaced by the server at boot, which then refuses to start
let _portRules = null;    // blockedPorts, parsed

function load() {
  if (_cfg) return _cfg;
  const { cfg, fatal } = configload.loadConfigFile(CONFIG_FILE, 'config/site.json',
                                                   DEFAULTS, RULES);
  _fatal = fatal;
  _cfg = cfg;
  // Parsed once, here, so nothing re-derives it per dial. On a fatal the rules
  // are empty rather than partial: half a denial rule is not a denial rule, and
  // the server is about to stop anyway.
  _portRules = fatal ? [] : netguard.parsePortRules(cfg.blockedPorts).ranges;
  return _cfg;
}

/**
 * The PORT environment variable still overrides the file when it is set.
 * 0 is allowed here (and only here): it is the conventional "give me any free
 * port", which a test harness may want and which the file has no business
 * specifying.
 */
function port() {
  const env = parseInt(process.env.PORT || '', 10);
  return (Number.isFinite(env) && env >= 0 && env < 65536) ? env : load().port;
}

function config() { return load(); }
/** A reason the server must not start, or null. → server.js's boot check. */
function fatal() { load(); return _fatal; }
/** blockedPorts as ranges, for netguard.portAllowed(). */
function portRules() { load(); return _portRules; }

/**
 * The token table. `title` is derived rather than configured directly so the
 * tab always leads with the brand, whatever the suffix says.
 */
function tokens() {
  const c = load();
  const suffix = (c.titleSuffix || '').trim();
  return {
    BRAND: c.brand,
    TAGLINE: c.tagline,
    TITLE: suffix ? `${c.brand} — ${suffix}` : c.brand,
    FAVICON: c.favicon,
    // Read back off a <meta> by main.js, the same way BRAND is: available
    // synchronously at parse time, so the ring is sized before the first byte
    // is echoed into it and can never be resized under a session.
    SCROLLBACK: String(c.scrollbackLines),
    // Written straight into a CSS transition, so it must be a plain number:
    // the RULES entry above is what guarantees that, since anything this file
    // cannot validate stops the server before it serves a page.
    SPLASHFADE: String(c.splashFadeSeconds),
  };
}

// HTML-escape everything substituted into markup. The values are operator-set,
// not user-set, so this is not a security boundary — it is so that a brand with
// an ampersand in it renders as itself rather than as a broken entity.
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const escapeHTML = (s) => String(s).replace(/[&<>"]/g, (c) => ESC[c]);

/**
 * Substitute {{TOKEN}} in an HTML string. An unknown token is left exactly as
 * written — a stray `{{FOO}}` is then visible on the page, which is a far
 * easier bug to spot than a silently blanked one.
 */
function apply(text) {
  const t = tokens();
  return String(text).replace(/\{\{([A-Z_]+)\}\}/g, (m, name) =>
    (Object.prototype.hasOwnProperty.call(t, name) ? escapeHTML(t[name]) : m));
}

module.exports = { config, port, tokens, apply, fatal, portRules,
                   CONFIG_FILE, DEFAULTS,
                   _reset() { _cfg = null; _fatal = null; _portRules = null; } };
