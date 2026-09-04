'use strict';
/*
 * lib/netguard.js — what this server is allowed to dial.
 *
 * SynthLink is a proxy: the browser names a destination and the server opens a
 * TCP connection to it. That is the product, so it cannot be removed — but
 * without bounds it is also an open relay pointed at the operator's own network
 * (127.0.0.1, RFC1918, and the cloud metadata service at 169.254.169.254, which
 * hands out credentials). This module is the bound.
 *
 * Two independent policies, applied at different moments:
 *
 *   ADDRESS  — the resolved IP must be publicly routable. Applied to the address
 *              the socket will actually connect to, never to the hostname,
 *              because a name and the address it resolves to are different data
 *              and a check on the first does not constrain the second (DNS
 *              rebinding). Listing a board in the directory does NOT exempt it:
 *              a board's DNS is controlled by its sysop, and the guide carries
 *              lapsed domains anyone may register.
 *
 *   PORT     — for a destination the directory does not offer, whatever
 *              config/site.json's `blockedPorts` says, and NOTHING else. This
 *              module holds no list of its own and has no default: a config that
 *              says nothing denies nothing. That is deliberate — the list used to
 *              live here, which left an operator reading site.json to conclude
 *              from `blockedPorts: null` that nothing was blocked while eighteen
 *              ports and the whole well-known range were refused out of code they
 *              never saw.
 *              A LISTED board is exempt: some boards answer on 80 or 443 to get
 *              through restrictive firewalls, and refusing those would break real
 *              boards to close a hole a listed destination does not open.
 *
 * The two are deliberately unalike. The port policy is an operator's judgement
 * about what their proxy should reach and belongs in their config. The address
 * policy is a CONSTANT. There is deliberately no config key for it:
 * a config value gets set once and outlives the reason for it, and a file is
 * copied between deployments. The only way past it is the command-line flag
 * --allow-private-ips, which has to be typed into the invocation on purpose.
 * It is what the test harnesses use — and note that moving the mock BBS
 * somewhere else could not have replaced it, because every address on a test
 * machine is either loopback or RFC1918, so there is nowhere a local peer could
 * listen that this policy would permit.
 *
 * The IP primitives (ipToBytes, parseCIDRList, matchBlocks) live here rather
 * than in lib/log.js, which had them first for trustedProxies: two copies of
 * address parsing is exactly the duplication that goes stale, and this is the
 * module about addresses. log.js re-exports these, so its own callers and
 * logtest.js see no change.
 *
 * SynthLink's own code, GPL-3.0-or-later.
 */

// ─── Address parsing ────────────────────────────────────────────────────────

/** An address → its bytes (4 or 16), or null if it is not one. */
function ipToBytes(input) {
  let s = String(input == null ? '' : input).trim();
  if (!s) return null;
  // A v4-mapped v6 address IS the v4 address, and must reduce to it before any
  // policy runs — ::ffff:127.0.0.1 is loopback however it is spelled.
  if (/^::ffff:\d{1,3}(\.\d{1,3}){3}$/i.test(s)) s = s.slice(7);

  if (s.indexOf(':') < 0) {
    const parts = s.split('.');
    if (parts.length !== 4) return null;
    const out = new Uint8Array(4);
    for (let i = 0; i < 4; i++) {
      if (!/^\d{1,3}$/.test(parts[i])) return null;    // rejects '', '+1', '0x0a'
      const n = Number(parts[i]);
      if (n > 255) return null;
      out[i] = n;
    }
    return out;
  }

  // IPv6. A trailing dotted quad is folded into the last two groups first, so
  // the '::' expansion below only ever counts 16-bit groups.
  if (s.indexOf('.') >= 0) {
    const cut = s.lastIndexOf(':');
    const v4 = ipToBytes(s.slice(cut + 1));
    if (!v4 || v4.length !== 4) return null;
    s = s.slice(0, cut + 1) +
        (((v4[0] << 8) | v4[1]).toString(16)) + ':' + (((v4[2] << 8) | v4[3]).toString(16));
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null;
  let groups;
  if (tail === null) groups = head;
  else {
    const gap = 8 - head.length - tail.length;
    if (gap < 1) return null;                // '::' must stand for a group or more
    groups = head.concat(new Array(gap).fill('0'), tail);
  }
  if (groups.length !== 8) return null;
  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    if (!/^[0-9a-f]{1,4}$/i.test(groups[i])) return null;
    const n = parseInt(groups[i], 16);
    out[i * 2] = n >> 8; out[i * 2 + 1] = n & 0xFF;
  }
  return out;
}

/**
 * A list of addresses and/or CIDR blocks → the blocks they mean. An
 * unparseable entry is reported and dropped rather than throwing.
 */
function parseCIDRList(list, warnFn) {
  const out = [];
  for (const raw of (Array.isArray(list) ? list : [])) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) continue;
    const slash = s.indexOf('/');
    const bytes = ipToBytes(slash < 0 ? s : s.slice(0, slash));
    if (!bytes) { if (warnFn) warnFn(s); continue; }
    const max = bytes.length * 8;
    let bits = max;
    if (slash >= 0) {
      const t = s.slice(slash + 1);
      if (!/^\d{1,3}$/.test(t) || Number(t) > max) { if (warnFn) warnFn(s); continue; }
      bits = Number(t);
    }
    out.push({ bytes, bits });
  }
  return out;
}

/** Is `ip` inside any of `blocks`? Families never cross — a v4 address is not
 *  in a v6 block, and the mapped form has already been reduced to v4. */
function matchBlocks(ip, blocks) {
  const a = ipToBytes(ip);
  if (!a) return false;
  return matchBytes(a, blocks);
}

function matchBytes(a, blocks) {
  for (const b of blocks) {
    if (b.bytes.length !== a.length) continue;
    let bits = b.bits, i = 0, ok = true;
    for (; bits >= 8; bits -= 8, i++) {
      if (a[i] !== b.bytes[i]) { ok = false; break; }
    }
    if (ok && bits > 0) {
      const mask = (0xFF << (8 - bits)) & 0xFF;
      if ((a[i] & mask) !== (b.bytes[i] & mask)) ok = false;
    }
    if (ok) return true;
  }
  return false;
}

// ─── The address policy ─────────────────────────────────────────────────────
// Everything that is not a public unicast destination. Each entry says what it
// is, because the next person to read this list will want to know why an
// address they typed was refused.
const DENIED_V4 = [
  ['0.0.0.0/8',        'this network / unspecified'],
  ['10.0.0.0/8',       'private (RFC1918)'],
  ['100.64.0.0/10',    'carrier-grade NAT'],
  ['127.0.0.0/8',      'loopback'],
  ['169.254.0.0/16',   'link-local — includes the cloud metadata service'],
  ['172.16.0.0/12',    'private (RFC1918)'],
  ['192.0.0.0/24',     'IETF protocol assignments'],
  ['192.0.2.0/24',     'documentation'],
  ['192.168.0.0/16',   'private (RFC1918)'],
  ['198.18.0.0/15',    'benchmarking'],
  ['198.51.100.0/24',  'documentation'],
  ['203.0.113.0/24',   'documentation'],
  ['224.0.0.0/4',      'multicast'],
  ['240.0.0.0/4',      'reserved / broadcast'],
];
const DENIED_V6 = [
  ['::/128',           'unspecified'],
  ['::1/128',          'loopback'],
  ['100::/64',         'discard-only'],
  ['2001:db8::/32',    'documentation'],
  ['2002::/16',        '6to4 — can carry a private v4 destination'],
  ['fc00::/7',         'unique local'],
  ['fe80::/10',        'link-local'],
  ['ff00::/8',         'multicast'],
];

const DENY_BLOCKS = parseCIDRList([...DENIED_V4, ...DENIED_V6].map((e) => e[0]));
const DENY_REASONS = [...DENIED_V4, ...DENIED_V6].map(([cidr, why]) => ({
  block: parseCIDRList([cidr])[0], why,
}));

/** Why this address is not public, or null if it is. */
function denialReason(ip) {
  const a = ipToBytes(ip);
  if (!a) return 'not an IP address';
  for (const { block, why } of DENY_REASONS) {
    if (matchBytes(a, [block])) return why;
  }
  return null;
}

// ─── --allow-private-ips ────────────────────────────────────────────────────
// Bare      → every denied range is permitted.
// =<blocks> → only the listed addresses/CIDRs are permitted, comma separated.
//
// Parsed ONCE, at module load, from the argv the process actually started with.
// Never re-read per dial: a policy that can change under a running server is a
// policy nobody can reason about.
let _flag = { enabled: false, blocks: [], spec: '' };

function parseFlag(argv) {
  const out = { enabled: false, blocks: [], spec: '' };
  for (const arg of (argv || [])) {
    if (arg === '--allow-private-ips') { out.enabled = true; out.spec = '(all private ranges)'; }
    else if (typeof arg === 'string' && arg.startsWith('--allow-private-ips=')) {
      const spec = arg.slice('--allow-private-ips='.length);
      const blocks = parseCIDRList(spec.split(',').map((s) => s.trim()).filter(Boolean));
      // A scope that parses to nothing is a typo, and the safe reading of a
      // typo is the narrower one: no exemption at all rather than a silent
      // widening to every private range.
      out.enabled = blocks.length > 0;
      out.blocks = blocks;
      out.spec = blocks.length ? spec : `${spec} (nothing parsed — flag ignored)`;
    }
  }
  return out;
}

function loadFlag(argv = process.argv.slice(2)) { _flag = parseFlag(argv); return _flag; }
loadFlag();

function flagState() { return _flag; }

/** True when the flag is exempting this specific address. */
function exemptedByFlag(ip) {
  if (!_flag.enabled) return false;
  if (!_flag.blocks.length) return true;          // bare flag: everything private
  return matchBlocks(ip, _flag.blocks);
}

/**
 * May the server connect to this resolved address?
 *
 * @param {string} ip a resolved address, never a hostname
 * @returns {{ok: boolean, why: string, viaFlag: boolean}}
 *   `viaFlag` is true when the address would have been refused and the
 *   command-line flag is what let it through — the server logs a warning on
 *   every one of those, because the danger of the flag is that it is forgotten.
 */
function addressAllowed(ip) {
  const why = denialReason(ip);
  if (!why) return { ok: true, why: '', viaFlag: false };
  if (exemptedByFlag(ip)) return { ok: true, why, viaFlag: true };
  return { ok: false, why, viaFlag: false };
}

// ─── The port policy ────────────────────────────────────────────────────────
// There is NO list here, and that is the point.
//
// This module used to carry the well-known ports itself and treat the config as
// an optional extra, which meant an operator reading config/site.json saw
// `blockedPorts: null` and reasonably concluded nothing was blocked — while
// eighteen ports and the whole sub-1024 range were refused from code they never
// looked at. A security control invisible in the file you would check is worse
// than a slightly redundant visible one.
//
// So config/site.json states the WHOLE policy and this module only enforces what
// it is handed. There is no fallback: a file that says nothing denies nothing.
// Removing it is a site's decision to make, and its consequence to own.
//
// Ranges are how the sub-1024 range is expressed without a rule hiding behind
// the list — "1-22", "24-1023" says both what is refused and that 23 is not,
// which no amount of commentary on a bare port list can.

/**
 * Config entries → the ranges they mean, and the ones that are not entries.
 *
 * Accepts a number, a numeric string, or "lo-hi". JSON has no range literal, so
 * a range has to arrive as a string; both forms are allowed for the plain ports
 * because an operator will write them unquoted and should not be punished.
 *
 * @returns {{ranges: Array<{lo:number,hi:number}>, bad: string[]}}
 */
function parsePortRules(list) {
  const ranges = [], bad = [];
  const ok = (n) => Number.isInteger(n) && n >= 1 && n <= 65535;
  for (const raw of (Array.isArray(list) ? list : [])) {
    if (typeof raw === 'number') {
      if (ok(raw)) ranges.push({ lo: raw, hi: raw }); else bad.push(String(raw));
      continue;
    }
    const s = String(raw == null ? '' : raw).trim();
    if (!s) { bad.push(String(raw)); continue; }
    const m = /^(\d{1,5})\s*-\s*(\d{1,5})$/.exec(s);
    if (m) {
      const lo = Number(m[1]), hi = Number(m[2]);
      // lo > hi is a typo that would silently match nothing, which is the worst
      // outcome for a denial rule: it reads as protection and is not.
      if (ok(lo) && ok(hi) && lo <= hi) ranges.push({ lo, hi }); else bad.push(s);
      continue;
    }
    if (/^\d{1,5}$/.test(s)) {
      const n = Number(s);
      if (ok(n)) ranges.push({ lo: n, hi: n }); else bad.push(s);
      continue;
    }
    bad.push(s);
  }
  return { ranges, bad };
}

/**
 * May the server connect to this port?
 *
 * @param {number} port
 * @param {boolean} listed destination is a board the directory offers
 * @param {Array<{lo:number,hi:number}>} rules parsed blockedPorts
 */
function portAllowed(port, listed, rules) {
  const p = parseInt(port, 10);
  if (!(p > 0 && p < 65536)) return { ok: false, why: 'not a port' };
  // A board the directory offers is exempt from the whole policy: some answer on
  // 80 or 443 to get through a restrictive firewall, and refusing those would
  // break real boards to close a hole a listed destination does not open.
  if (listed) return { ok: true, why: '' };
  for (const r of (Array.isArray(rules) ? rules : [])) {
    if (p >= r.lo && p <= r.hi) {
      return { ok: false, why: `port ${p} is blocked by config/site.json (blockedPorts)` };
    }
  }
  return { ok: true, why: '' };
}

// ─── Hostname validation ────────────────────────────────────────────────────
// Applied at the WebSocket boundary, before a client-supplied string reaches
// dns.lookup(), net.createConnection() or — the reason the length bound matters
// as much as the character set — a log line.
const MAX_HOST = 253;

/** A syntactically valid hostname or IP literal? */
function isValidHost(host) {
  if (typeof host !== 'string') return false;
  const s = host.trim();
  if (!s || s.length > MAX_HOST) return false;
  if (ipToBytes(s)) return true;                       // an IP literal is a host
  // Trailing dot is legal in a FQDN and is not worth rejecting over.
  const name = s.endsWith('.') ? s.slice(0, -1) : s;
  if (!name || name.length > MAX_HOST) return false;
  const labels = name.split('.');
  for (const label of labels) {
    if (label.length < 1 || label.length > 63) return false;
    // Underscore is not legal in a hostname per RFC 1123, but it appears in
    // real DNS and refusing it here would drop a board off the directory for a
    // purity that buys nothing: what this check is for is control characters,
    // whitespace and length, all of which are still refused.
    if (!/^[A-Za-z0-9_]([A-Za-z0-9_-]*[A-Za-z0-9_])?$/.test(label)) return false;
  }
  return true;
}

module.exports = {
  // primitives (lib/log.js re-exports these for trustedProxies)
  ipToBytes, parseCIDRList, matchBlocks,
  // address policy
  addressAllowed, denialReason, DENIED_V4, DENIED_V6, DENY_BLOCKS,
  // the flag
  parseFlag, loadFlag, flagState, exemptedByFlag,
  // port policy
  portAllowed, parsePortRules,
  // hostnames
  isValidHost, MAX_HOST,
};
