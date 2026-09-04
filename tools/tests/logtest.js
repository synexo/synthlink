#!/usr/bin/env node
// Unit tests for lib/log.js, lib/bbsstats.js and the blacklist in lib/bbslist.js.
//
// Sockets-free and filesystem-only: everything runs against a scratch directory
// under the OS temp dir, so it never touches the real logs/ or cache/. Instant.
//
//   node tools/tests/logtest.js

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'synthlink-logtest-'));

// Point the logger at the scratch directory by writing a config it will read.
// This also exercises the real config loader rather than poking internals.
const CFG = path.join(ROOT, 'config', 'logging.json');
const CFG_BACKUP = fs.existsSync(CFG) ? fs.readFileSync(CFG, 'utf8') : null;
fs.writeFileSync(CFG, JSON.stringify({
  dir: path.join(SCRATCH, 'logs'),
  level: 'info',
  debug: false,
  retentionDays: 3,
  console: 'off',
  trustProxy: true,
  trustedProxies: [],
  trackBytes: true,
}));

function restore() {
  if (CFG_BACKUP !== null) fs.writeFileSync(CFG, CFG_BACKUP);
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch (_) {}
}
process.on('exit', restore);

const log     = require('../../lib/log');
const bbslist = require('../../lib/bbslist');
log.loadConfig();

const LOGDIR = log.logDir();

// ── assertions ──────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
function eq(actual, expected, what) {
  if (actual === expected) { pass++; return; }
  fail++;
  console.log(`  FAIL ${what}\n       expected ${JSON.stringify(expected)}\n       actual   ${JSON.stringify(actual)}`);
}
function ok(cond, what) { eq(!!cond, true, what); }

console.log('logtest — access logging, retention, blacklist, stats\n');

// ── 1. config ───────────────────────────────────────────────────────────────
{
  const c = log.config();
  eq(c.retentionDays, 3, 'config: retentionDays read from file');
  eq(c.console, 'off', 'config: console read from file');
  eq(log.isDebug(), false, 'config: debug defaults off');
  // The knobs the server depends on must survive a file that omits them.
}

// ── 2. client IP resolution ─────────────────────────────────────────────────
// The reason this is gated: a visitor who reaches the box directly can set any
// header they like, and an unguarded logger would write it into the access log
// as fact.
function req(headers, remote = '203.0.113.9') {
  return { headers, socket: { remoteAddress: remote }, method: 'GET', url: '/', httpVersion: '1.1' };
}
{
  eq(log.clientIp(req({})), '203.0.113.9', 'ip: bare request uses the socket address');
  eq(log.clientIp(req({}, '::ffff:198.51.100.4')), '198.51.100.4', 'ip: IPv4-mapped IPv6 is unwrapped');
  eq(log.clientIp(req({ 'cf-connecting-ip': '198.51.100.7' })), '198.51.100.7',
     'ip: CF-Connecting-IP wins');
  eq(log.clientIp(req({ 'x-forwarded-for': '198.51.100.8, 10.0.0.1, 10.0.0.2' })), '198.51.100.8',
     'ip: leftmost X-Forwarded-For hop');
  eq(log.clientIp(req({ 'cf-connecting-ip': '198.51.100.7', 'x-forwarded-for': '198.51.100.8' })),
     '198.51.100.7', 'ip: CF-Connecting-IP outranks X-Forwarded-For');
  eq(log.clientIp(req({ 'x-forwarded-for': '   ' })), '203.0.113.9',
     'ip: an empty XFF falls through to the socket');
}
{
  // trustProxy off: headers are ignored outright.
  fs.writeFileSync(CFG, JSON.stringify({ ...log.config(), trustProxy: false }));
  log.loadConfig();
  eq(log.clientIp(req({ 'cf-connecting-ip': '1.2.3.4' })), '203.0.113.9',
     'ip: trustProxy=false ignores a forged CF-Connecting-IP');

  // trustedProxies set: only that peer may speak for someone else.
  fs.writeFileSync(CFG, JSON.stringify({ ...log.config(), trustProxy: true, trustedProxies: ['10.0.0.1'] }));
  log.loadConfig();
  eq(log.clientIp(req({ 'cf-connecting-ip': '1.2.3.4' }, '10.0.0.1')), '1.2.3.4',
     'ip: a listed proxy is believed');
  eq(log.clientIp(req({ 'cf-connecting-ip': '1.2.3.4' }, '203.0.113.9')), '203.0.113.9',
     'ip: an unlisted peer cannot forge the client IP');

  // CIDR blocks, which is the form this setting is actually usable in:
  // Cloudflare publishes ranges, and no list of literal edge addresses exists.
  fs.writeFileSync(CFG, JSON.stringify({ ...log.config(), trustProxy: true,
    trustedProxies: ['173.245.48.0/20', '2400:cb00::/32'] }));
  log.loadConfig();
  eq(log.clientIp(req({ 'cf-connecting-ip': '1.2.3.4' }, '173.245.48.1')), '1.2.3.4',
     'ip: a peer inside a v4 CIDR block is believed');
  eq(log.clientIp(req({ 'cf-connecting-ip': '1.2.3.4' }, '173.245.63.255')), '1.2.3.4',
     'ip: and at the top of the block');
  eq(log.clientIp(req({ 'cf-connecting-ip': '1.2.3.4' }, '173.245.64.0')), '173.245.64.0',
     'ip: one address past the block is not trusted');
  eq(log.clientIp(req({ 'cf-connecting-ip': '1.2.3.4' }, '2400:cb00:2049:1::a29f:1')), '1.2.3.4',
     'ip: a peer inside a v6 CIDR block is believed');
  eq(log.clientIp(req({ 'cf-connecting-ip': '1.2.3.4' }, '2400:cb01::1')), '2400:cb01::1',
     'ip: a v6 peer outside it is not');

  // Families must not cross: a v4 address is not inside a v6 block.
  fs.writeFileSync(CFG, JSON.stringify({ ...log.config(), trustedProxies: ['::/0'] }));
  log.loadConfig();
  eq(log.clientIp(req({ 'cf-connecting-ip': '1.2.3.4' }, '203.0.113.9')), '203.0.113.9',
     'ip: ::/0 does not sweep in IPv4 peers');

  // A typo can only ever TIGHTEN this, and it now also stops the server. Both
  // halves matter: the refusal to start is what an operator sees, and trusting
  // nobody in the meantime is what the module does while that is happening.
  // Falling back to the DEFAULT here would be `trustedProxies: []`, which means
  // "trust any peer" — one bad character silently reopening header spoofing.
  fs.writeFileSync(CFG, JSON.stringify({ ...log.config(), trustedProxies: ['10.0.0.0/33'] }));
  log.loadConfig();
  ok(/trustedProxies/.test(log.fatal() || ''), 'ip: an unparseable entry is fatal');
  eq(log.clientIp(req({ 'cf-connecting-ip': '1.2.3.4' }, '10.0.0.1')), '10.0.0.1',
     'ip: and a module that cannot read its config trusts nobody meanwhile');
  // This used to assert that a bad entry was DROPPED and the good ones still
  // applied. That behaviour is gone deliberately, and this asserts what replaced
  // it rather than a softened version of it: a list with one unreadable entry is
  // fatal, and none of it is applied. Half a trust list is not a trust list —
  // the operator wrote four ranges and would be running with three, with nothing
  // to tell them which.
  fs.writeFileSync(CFG, JSON.stringify({ ...log.config(), trustedProxies: ['nonsense', '10.0.0.1'] }));
  log.loadConfig();
  ok(/nonsense/.test(log.fatal() || ''),
     'ip: one bad entry among good ones is fatal, and names the entry');
  eq(log.clientIp(req({ 'cf-connecting-ip': '1.2.3.4' }, '10.0.0.1')), '10.0.0.1',
     'ip: and the good entries are NOT applied — no partial trust list');

  fs.writeFileSync(CFG, JSON.stringify({ ...log.config(), trustedProxies: [] }));
  log.loadConfig();
}

// ── 2b. The address parser behind trustedProxies ────────────────────────────
// Driven directly: the matcher above can only show a handful of cases, and the
// parser is where a malformed entry has to be REJECTED rather than guessed at.
{
  const { ipToBytes, parseTrustedList, matchTrusted } = log._internals;
  const hex = (b) => (b ? Buffer.from(b).toString('hex') : null);

  eq(hex(ipToBytes('1.2.3.4')), '01020304', 'parse: dotted quad');
  eq(hex(ipToBytes('::ffff:1.2.3.4')), '01020304', 'parse: v4-mapped v6 reduces to v4');
  eq(hex(ipToBytes('::')), '0'.repeat(32), 'parse: the all-zero v6 address');
  eq(hex(ipToBytes('2400:cb00::')), '2400cb00' + '0'.repeat(24), 'parse: v6 with a trailing ::');
  eq(hex(ipToBytes('::1')), '0'.repeat(31) + '1', 'parse: v6 loopback');
  eq(ipToBytes('2001:db8:0:1:2:3:4:5:6'), null, 'parse: too many groups');
  for (const bad of ['', '1.2.3', '1.2.3.4.5', '1.2.3.256', '1.2.3.-1', '1.2.3.+4',
                     'example.org', '1::2::3', 'zzzz::1', '1.2.3.4/8']) {
    eq(ipToBytes(bad), null, `parse: rejects ${JSON.stringify(bad)}`);
  }

  eq(parseTrustedList(['10.0.0.0/8'])[0].bits, 8, 'cidr: the prefix length is kept');
  eq(parseTrustedList(['10.0.0.1']).length, 1, 'cidr: a bare address is a block');
  eq(parseTrustedList(['10.0.0.1'])[0].bits, 32, 'cidr: and it is a /32');
  eq(parseTrustedList(['::1'])[0].bits, 128, 'cidr: a bare v6 address is a /128');
  eq(parseTrustedList(['10.0.0.0/33', '::/129', '10.0.0.0/x', 'junk', '']).length, 0,
     'cidr: every malformed form is dropped');
  const warned = [];
  parseTrustedList(['junk', '10.0.0.0/8'], (b) => warned.push(b));
  eq(warned.join(','), 'junk', 'cidr: a dropped entry is reported and a good one is not');

  // /0 matches everything of its own family, and only its own family.
  const any4 = parseTrustedList(['0.0.0.0/0']);
  eq(matchTrusted('203.0.113.9', any4), true, 'cidr: 0.0.0.0/0 matches any v4');
  eq(matchTrusted('::1', any4), false, 'cidr: and no v6');
  eq(matchTrusted('not-an-ip', any4), false, 'cidr: an unparseable peer never matches');
  eq(matchTrusted('1.2.3.4', []), false, 'cidr: an empty block list matches nothing');
}

// ── 3. Apache combined format ───────────────────────────────────────────────
{
  const r = { headers: { referer: 'https://example.org/x', 'user-agent': 'Mozilla/5.0 (X)' },
              socket: { remoteAddress: '198.51.100.4' },
              method: 'GET', url: '/bbs.json?v=2', httpVersion: '1.1' };
  log.httpRequest(r, { statusCode: 200 }, 17233);
  log.httpRequest({ ...r, method: 'HEAD', url: '/' }, { statusCode: 304 }, 0);
  log.close();

  const file = path.join(LOGDIR, `accessLog-${dayStamp()}.log`);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const first = lines.find((l) => l.includes('/bbs.json'));
  ok(first, 'combined: the request was written');
  ok(lines.some((l) => / 304 /.test(l)), 'combined: the 304 was logged too');
}

// ── 4. session / dial / connect / fail / end events ─────────────────────────
{
  log.sessionOpen('198.51.100.4', 7, 'Mozilla/5.0');
  log.dial('198.51.100.4', 7, 'bbs.example.org', 23, 'V32bis');
  log.connect('198.51.100.4', 7, 'bbs.example.org', 23, 'carrier V32bis @ 14400 bps');
  log.sessionEnd('198.51.100.4', 7, 'bbs.example.org', 23, 346100,
                 { telnetIn: 48210, telnetOut: 1204, audioIn: 5120000, audioOut: 5140000 },
                 'remote-closed');
  log.telnetFail('198.51.100.4', 8, 'dead.example.org', 2323, 'ECONNREFUSED',
                 { name: 'Dead Board', tier: 'guide' });
  log.close();

  // The dedicated fail log is the point of the exercise: a blacklist worklist.
  const failLog = fs.readFileSync(path.join(LOGDIR, `telnetFailLog-${dayStamp()}.log`), 'utf8').trim();
  eq(failLog.split('\n').length, 1, 'failLog: only failures, not successes');
}

// ── 5. an END with byte tracking off says nothing rather than zero ──────────
{
  log.sessionEnd('198.51.100.4', 9, 'x.example.org', 23, 1000, null, 'ws-closed');
  log.close();
  const access = fs.readFileSync(path.join(LOGDIR, `accessLog-${dayStamp()}.log`), 'utf8');
  const line = access.trim().split('\n').find((l) => l.includes('id=9'));
  ok(line && !/telnetIn=/.test(line), 'END: untracked bytes are absent, not zero');
}

// ── 6. debug gating ─────────────────────────────────────────────────────────
// This is the whole point of the change: the per-chunk lines that used to fill
// the console must not be written at all unless asked for.
{
  const before = fs.readFileSync(path.join(LOGDIR, `accessLog-${dayStamp()}.log`), 'utf8').length;
  for (let i = 0; i < 50; i++) log.debug('198.51.100.4', 7, `telnet→modem ${i}B`);
  log.close();
  const after = fs.readFileSync(path.join(LOGDIR, `accessLog-${dayStamp()}.log`), 'utf8').length;
  eq(after, before, 'debug: nothing written when debug is off');
}

// ── 7. rotation + retention ─────────────────────────────────────────────────
// Rotation is driven by the local day stamp, so it is provable by planting
// files with past stamps rather than by faking the clock.
function dayStamp(d = new Date()) {
  const two = (n) => (n < 10 ? '0' + n : '' + n);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}
function daysAgo(n) { return dayStamp(new Date(Date.now() - n * 86400000)); }
{
  const plant = (name) => { fs.writeFileSync(path.join(LOGDIR, name), 'old\n'); return name; };
  const keep1 = plant(`accessLog-${daysAgo(1)}.log`);
  const keep2 = plant(`telnetFailLog-${daysAgo(2)}.log`);
  const drop1 = plant(`accessLog-${daysAgo(9)}.log`);
  const drop2 = plant(`summaryLog-${daysAgo(4)}.log`);
  const alien = plant('someoneElses-2020-01-01.log');   // not ours; must survive
  const notLog = plant('notes.txt');

  const removed = log.prune();
  ok(fs.existsSync(path.join(LOGDIR, keep1)), 'retention: 1 day old kept (retention 3)');
  ok(fs.existsSync(path.join(LOGDIR, keep2)), 'retention: 2 days old kept');
  ok(!fs.existsSync(path.join(LOGDIR, drop1)), 'retention: 9 days old deleted');
  ok(!fs.existsSync(path.join(LOGDIR, drop2)), 'retention: 4 days old deleted');
  ok(fs.existsSync(path.join(LOGDIR, alien)), 'retention: an unrelated stamped file is left alone');
  ok(fs.existsSync(path.join(LOGDIR, notLog)), 'retention: a non-log file is left alone');
  eq(removed.length, 2, 'retention: reports what it deleted');

  // Today's file must never be a candidate, however it was written.
  ok(fs.existsSync(path.join(LOGDIR, `accessLog-${dayStamp()}.log`)), "retention: today's log survives");
}
{
  // retentionDays: 0 means keep forever — a foot-gun if it were read as "delete
  // everything", so it gets its own assertion.
  fs.writeFileSync(CFG, JSON.stringify({ ...log.config(), retentionDays: 0 }));
  log.loadConfig();
  const old = path.join(LOGDIR, `accessLog-${daysAgo(400)}.log`);
  fs.writeFileSync(old, 'ancient\n');
  log.prune();
  ok(fs.existsSync(old), 'retention: 0 keeps everything');
  fs.unlinkSync(old);
  fs.writeFileSync(CFG, JSON.stringify({ ...log.config(), retentionDays: 3 }));
  log.loadConfig();
}
{
  // Writing on a new day opens a new file rather than appending to yesterday's.
  const tomorrow = new Date(Date.now() + 86400000);
  const before = fs.readdirSync(LOGDIR).length;
  log._internals.counters = log._internals.freshCounters();
  // streamFor is exercised through writeSummary, which takes an explicit date.
  log.writeSummary(tomorrow);
  log.close();
  ok(fs.existsSync(path.join(LOGDIR, `summaryLog-${dayStamp(tomorrow)}.log`)),
     "rotation: a write dated tomorrow lands in tomorrow's file");
  ok(fs.readdirSync(LOGDIR).length > before, 'rotation: a new file was created');
  fs.unlinkSync(path.join(LOGDIR, `summaryLog-${dayStamp(tomorrow)}.log`));
}

// ── 8. daily summary ────────────────────────────────────────────────────────
{
  log._internals.counters = log._internals.freshCounters();
  log.httpRequest(req({}), { statusCode: 200 }, 1000);
  log.httpRequest(req({}, '198.51.100.5'), { statusCode: 404 }, 9);
  log.sessionOpen('198.51.100.4', 1, 'ua');
  log.dial('198.51.100.4', 1, 'a.example.org', 23, 'V34@33600');
  log.connect('198.51.100.4', 1, 'a.example.org', 23, 'carrier');
  log.connect('198.51.100.4', 2, 'a.example.org', 23, 'carrier');
  log.connect('198.51.100.4', 3, 'b.example.org', 23, 'carrier');
  log.telnetFail('198.51.100.4', 4, 'c.example.org', 23, 'ETIMEDOUT', {});
  log.sessionEnd('198.51.100.4', 1, 'a.example.org', 23, 60000,
                 { telnetIn: 2048, telnetOut: 64, audioIn: 10, audioOut: 20 }, 'remote-closed');

  const text = log.summaryText();
  ok(text.indexOf('a.example.org') < text.indexOf('b.example.org'),
     'summary: top boards sorted by count');

  // Writing the summary resets the counters, so a day never double-counts.
  log.writeSummary();
  const after = log.summaryText();
  ok(/HTTP requests\s+0/.test(after), 'summary: counters reset after writing');
  log.close();
}

// ── 9. blacklist parsing ────────────────────────────────────────────────────
{
  const bl = bbslist.parseBlacklist([
    '# a comment',
    '',
    'dead.example.org',
    'other.example.org:2323   ',
    '  MIXED.Case.Example.ORG  ',
    'trailing.example.org  # retired 2026-08',
    'bad.example.org:99999',        // out of range → ignored as a pair
  ].join('\n'));

  ok(bbslist.isBlacklisted('dead.example.org', 23, bl), 'blacklist: bare host blocks port 23');
  ok(bbslist.isBlacklisted('dead.example.org', 9999, bl), 'blacklist: bare host blocks every port');
  ok(bbslist.isBlacklisted('other.example.org', 2323, bl), 'blacklist: host:port blocks that port');
  ok(!bbslist.isBlacklisted('other.example.org', 23, bl), 'blacklist: host:port leaves other ports alone');
  ok(bbslist.isBlacklisted('mixed.case.example.org', 23, bl), 'blacklist: matching is case-insensitive');
  ok(bbslist.isBlacklisted('MIXED.case.EXAMPLE.org', 23, bl), 'blacklist: lookup is case-insensitive too');
  ok(bbslist.isBlacklisted('trailing.example.org', 23, bl), 'blacklist: trailing comment stripped');
  ok(!bbslist.isBlacklisted('live.example.org', 23, bl), 'blacklist: an unlisted board is not blocked');
  ok(!bbslist.isBlacklisted('', 23, bl), 'blacklist: an empty host is never blocked');
  eq(bl.hosts.has('# a comment'), false, 'blacklist: comments are not entries');
  // `bad.example.org:99999` is dropped outright rather than half-parsed into a
  // bare-host block — a typo'd port must not silently blacklist every port.
  ok(!bbslist.isBlacklisted('bad.example.org', 23, bl), 'blacklist: an out-of-range port is ignored, not widened');
  eq(bl.hosts.size, 3, 'blacklist: exactly the three bare hosts');
  eq(bl.pairs.size, 1, 'blacklist: exactly the one host:port pair');
}

// ── 9b. Invalid configuration is fatal ──────────────────────────────────────
// This file had NO validation before: `{ ...DEFAULTS, ...file }` and nothing
// else. `trustProxy: "no"` — which is what an operator writes when they mean to
// stop believing forwarded headers — was kept as a truthy string, the check
// `if (!cfg.trustProxy)` stepped over it, and the headers went on being trusted
// with nothing said.
{
  console.log('\n── logging config validation');
  const cases = [
    ['trustProxy', 'no',        'a boolean written as a string'],
    ['trustProxy', 1,           'a boolean written as a number'],
    ['level',      'verbose',   'a level that is not one of the three'],
    ['console',    'of',        'a typo in an enum'],
    ['retentionDays', 'abc',    'a number written as text'],
    ['retentionDays', -1,       'a negative retention'],
    ['dir',        42,          'a path that is not a string'],
    ['trackBytes', 'false',     'the other boolean, as a string'],
  ];
  for (const [key, value, what] of cases) {
    fs.writeFileSync(CFG, JSON.stringify({ dir: path.join(SCRATCH, 'logs'), [key]: value }));
    log.loadConfig();
    ok(new RegExp(key).test(log.fatal() || ''), `config: ${what} is fatal, naming ${key}`);
  }
  // A key that moved says where it went, rather than "that is not a setting".
  fs.writeFileSync(CFG, JSON.stringify({ dir: path.join(SCRATCH, 'logs'), connectTimeoutMs: 15000 }));
  log.loadConfig();
  ok(/site\.json/.test(log.fatal() || ''), 'config: a moved key names its new home');
  // A typo'd key is the cheapest way to end up with an unarmed setting.
  fs.writeFileSync(CFG, JSON.stringify({ dir: path.join(SCRATCH, 'logs'), trustProxies: [] }));
  log.loadConfig();
  ok(/trustProxies/.test(log.fatal() || ''), 'config: an unknown key is fatal');
  ok(/did you mean trustProxy/.test(log.fatal() || ''), 'config: and suggests the near miss');
  // Notes are allowed — the shipped file documents itself in "_comment".
  fs.writeFileSync(CFG, JSON.stringify({ dir: path.join(SCRATCH, 'logs'), _comment: ['x'] }));
  log.loadConfig();
  eq(log.fatal(), null, 'config: keys starting with _ are notes, not settings');
  // Not JSON at all. This used to discard every setting and carry on.
  fs.writeFileSync(CFG, '{ oops');
  log.loadConfig();
  ok(/not valid JSON/.test(log.fatal() || ''), 'config: a stray comma is fatal, not ignored');

  // Put a good config back for whatever runs after this.
  fs.writeFileSync(CFG, JSON.stringify({
    dir: path.join(SCRATCH, 'logs'), level: 'info', debug: false,
    retentionDays: 3, console: 'off', trustProxy: true, trustedProxies: [], trackBytes: true,
  }));
  log.loadConfig();
  eq(log.fatal(), null, 'config: and a good file is not fatal');
}

// ── 10. per-board stats ─────────────────────────────────────────────────────
{
  const stats = require('../../lib/bbsstats');
  stats.reset();
  eq(stats.total(), 0, 'stats: starts empty');
  stats.record('bbs.example.org', 23);
  stats.record('bbs.example.org', '23');
  stats.record('BBS.Example.ORG', 23);       // same board, different casing
  stats.record('other.example.org', 6400);
  eq(stats.total(), 4, 'stats: total counts every connect');
  eq(stats.counts()['bbs.example.org:23'], 3, 'stats: per-board count, case-folded');
  eq(stats.counts()['other.example.org:6400'], 1, 'stats: non-default port kept distinct');
  eq(stats.key('X.org', undefined), 'x.org:23', 'stats: key defaults to port 23');

  const s1 = stats.stamp();
  stats.record('third.example.org', 23);
  ok(s1 !== stats.stamp(), 'stats: the cache stamp changes when a count changes');

  // Round-trip through the file, since /bbs.json reads it back on restart.
  stats.flush();
  ok(fs.existsSync(stats.STATS), 'stats: flushed to disk');
  const raw = JSON.parse(fs.readFileSync(stats.STATS, 'utf8'));
  eq(raw.total, 5, 'stats: total survives the round-trip');
  eq(raw.boards['bbs.example.org:23'].count, 3, 'stats: counts survive the round-trip');
  ok(typeof raw.boards['bbs.example.org:23'].last === 'string', 'stats: last-connect timestamp recorded');
  fs.unlinkSync(stats.STATS);
}

console.log(`\n${fail ? 'FAILED' : 'OK'} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
