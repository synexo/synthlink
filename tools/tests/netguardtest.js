'use strict';
/**
 * tools/tests/netguardtest.js — the dial policy: which addresses and ports this
 * server will open a socket to.
 *
 * This is the module that stops SynthLink being an open proxy into the network
 * it is hosted on, so what is asserted here is the SHAPE of the policy, not its
 * wording: which addresses are refused, which ports are refused on a host the
 * directory does not offer, that a listed board is exempt from the port rule and
 * NOT from the address rule, and that the command-line flag can only ever widen
 * things deliberately.
 *
 * No network, no server, no browser — netguard is pure functions over strings.
 *
 *   node tools/tests/netguardtest.js
 */

const g = require('../../lib/netguard');

let pass = 0, fail = 0;
function ok(cond, what, extra) {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${extra ? '\n       ' + extra : ''}`); }
}
const eq = (a, b, what) => ok(a === b, what, `got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)}`);

// ─── 1. The address policy ──────────────────────────────────────────────────
// The whole point of the module. Each of these is a real place a proxy gets
// pointed at: the metadata service hands out cloud credentials, loopback and
// RFC1918 are the operator's own machine and network.
console.log('\n── addresses refused');
g.loadFlag([]);                       // no flag: the shipped production policy

for (const [ip, what] of [
  ['127.0.0.1',       'IPv4 loopback'],
  ['127.10.20.30',    'the rest of 127/8, not just .0.1'],
  ['::1',             'IPv6 loopback'],
  ['::ffff:127.0.0.1','a v4-mapped loopback — the same address, spelled differently'],
  ['10.0.0.5',        'RFC1918 10/8'],
  ['172.16.0.1',      'RFC1918 172.16/12'],
  ['172.31.255.254',  'the top of 172.16/12'],
  ['192.168.1.1',     'RFC1918 192.168/16'],
  ['169.254.169.254', 'the cloud metadata service'],
  ['169.254.0.1',     'the rest of link-local'],
  ['fe80::1',         'IPv6 link-local'],
  ['fd00::1',         'IPv6 unique-local'],
  ['100.64.0.1',      'carrier-grade NAT'],
  ['0.0.0.0',         'the unspecified address'],
  ['224.0.0.1',       'multicast'],
  ['255.255.255.255', 'broadcast'],
  ['2002:a00:1::1',   '6to4, which can carry a private v4 destination'],
]) {
  ok(!g.addressAllowed(ip).ok, `${what} (${ip})`);
}

console.log('\n── addresses allowed');
for (const ip of ['8.8.8.8', '1.1.1.1', '203.0.113.1'.replace('203.0.113.1', '198.41.0.4'),
                  '172.32.0.1', '172.15.255.255', '128.0.0.1', '2600:3c00::1']) {
  ok(g.addressAllowed(ip).ok, `a public address is allowed (${ip})`);
}
// The boundaries either side of 172.16/12 are worth pinning: an off-by-one in a
// /12 is the classic way a private range leaks through a hand-written check.
ok(!g.addressAllowed('172.16.0.0').ok, '172.16.0.0 is the bottom of the private block');
ok(!g.addressAllowed('172.31.255.255').ok, '172.31.255.255 is the top of it');
ok(g.addressAllowed('172.15.255.255').ok, 'and 172.15.x is outside it');
ok(g.addressAllowed('172.32.0.0').ok, 'as is 172.32.x');

ok(!g.addressAllowed('not-an-ip').ok, 'a string that is not an address is refused, not assumed');
ok(!g.addressAllowed('').ok, 'and so is an empty one');

// ─── 2. The flag ────────────────────────────────────────────────────────────
// The only way past the address policy, and it is a command-line flag rather
// than a config key on purpose: a config value gets set once and outlives the
// reason for it. A typo in the scope must NARROW the exemption, never widen it.
console.log('\n── --allow-private-ips');

g.loadFlag(['--allow-private-ips']);
ok(g.addressAllowed('127.0.0.1').ok, 'the bare flag permits loopback');
ok(g.addressAllowed('10.0.0.1').ok, 'and every other private range');
eq(g.addressAllowed('127.0.0.1').viaFlag, true,
   'and says the flag is what permitted it, so every such dial can be warned about');
eq(g.addressAllowed('8.8.8.8').viaFlag, false,
   'a public address is not "permitted by the flag" — it never needed it');

g.loadFlag(['--allow-private-ips=127.0.0.0/8']);
ok(g.addressAllowed('127.0.0.1').ok, 'a scoped flag permits what it names');
ok(!g.addressAllowed('10.0.0.1').ok, 'and NOT what it does not — this is the harness case');
ok(!g.addressAllowed('169.254.169.254').ok, 'the metadata service stays refused under a loopback scope');

g.loadFlag(['--allow-private-ips=junk']);
ok(!g.addressAllowed('127.0.0.1').ok,
   'a scope where nothing parses exempts NOTHING — a typo must not widen this');
g.loadFlag(['--allow-private-ips=127.0.0.0/8', '--other-flag']);
ok(g.addressAllowed('127.0.0.1').ok, 'unrelated arguments are ignored');

g.loadFlag([]);
ok(!g.addressAllowed('127.0.0.1').ok, 'and with no flag at all, loopback is refused again');

// ─── 3. The port policy ─────────────────────────────────────────────────────
// netguard holds NO list and NO default. What config/site.json says is what is
// refused, and nothing else is — which is the point: the list used to live in
// code, so an operator reading `blockedPorts: null` in their config reasonably
// concluded nothing was blocked while eighteen ports and the whole well-known
// range were being refused out of sight.
console.log('\n── parsing what the config says');
{
  const { ranges, bad } = g.parsePortRules(['1-22', '24-1023', 3306, '6379']);
  eq(ranges.length, 4, 'ports and ranges both parse');
  eq(bad.length, 0, 'and nothing is rejected');
  eq(JSON.stringify(ranges[0]), '{"lo":1,"hi":22}', 'a range keeps both ends');
  eq(JSON.stringify(ranges[2]), '{"lo":3306,"hi":3306}', 'a bare port is a range of one');
}
{
  // Every one of these must be REPORTED rather than skipped: site.js turns a
  // non-empty `bad` into a refusal to start, because a denial rule that quietly
  // failed to parse reads as protection and is not.
  const { bad } = g.parsePortRules(['nonsense', '9-2', '0', '70000', '', null, '1-', '-5', {}]);
  eq(bad.length, 9, 'every malformed entry is reported, none silently dropped');
  ok(g.parsePortRules(['9-2']).bad.length === 1,
     'a backwards range is malformed — it would match nothing while reading as a rule');
  ok(g.parsePortRules(['0']).bad.length === 1, 'port 0 is not a port');
  ok(g.parsePortRules(['70000']).bad.length === 1, 'nor is 70000');
}

console.log('\n── enforcing what the config says');
// The shipped policy, written out here rather than imported: this asserts the
// SHAPE the config is expected to take, and a test that read the same file the
// code reads would agree with itself no matter what either said.
const SHIPPED = g.parsePortRules([
  '1-22', '24-1023',
  1433, 1521, 2049, 2375, 2376, 2379, 3306, 3389, 5432,
  5900, 5901, 5984, 6379, 6443, 9200, 9300, 11211, 27017,
]).ranges;
const unlisted = (p) => g.portAllowed(p, false, SHIPPED).ok;

ok(unlisted(23), 'port 23 is allowed — it is what a BBS is on, and the ranges skip it');
ok(unlisted(1024), '1024 is the first port above the well-known range');
ok(unlisted(2323) && unlisted(1337) && unlisted(2003),
   'the ports real boards actually use are allowed');
ok(unlisted(8080), 'a high port with no rule against it is allowed');

for (const [p, what] of [
  [22,   'SSH, immediately below the carve-out'],
  [24,   'immediately above it'],
  [25,   'SMTP — the one that gets a host suspended'],
  [587,  'mail submission'],
  [80,   'HTTP'],
  [443,  'HTTPS'],
  [53,   'DNS'],
  [445,  'SMB'],
  [1,    'the bottom of the range'],
  [1023, 'the top of it'],
  [3306, 'MySQL, above 1024 and named'],
  [6379, 'Redis'],
  [27017,'MongoDB'],
  [6443, 'the Kubernetes API'],
]) {
  ok(!unlisted(p), `port ${p} is refused (${what})`);
}

console.log('\n── ports on a listed board');
// A listed board is exempt from the whole policy: some answer on 80 or 443 to
// get through a restrictive firewall, and refusing those would break real boards
// to close a hole a listed destination does not open.
for (const p of [80, 443, 25, 22, 6379, 1]) {
  ok(g.portAllowed(p, true, SHIPPED).ok, `a directory board is reachable on port ${p}`);
}
// But being listed is NOT an exemption from the ADDRESS policy — a board's DNS
// belongs to its sysop, and lapsed domains in an append-only guide are
// registrable by anyone. The two policies are deliberately independent.
ok(!g.addressAllowed('127.0.0.1').ok,
   'and a listed board still cannot resolve to a refused address');

ok(!g.portAllowed(0, false, SHIPPED).ok, 'port 0 is not a port');
ok(!g.portAllowed(65536, false, SHIPPED).ok, 'nor is 65536');
ok(!g.portAllowed('nonsense', false, SHIPPED).ok, 'nor is a non-number');

console.log('\n── an empty policy is an empty policy');
// No hidden floor. A config that says nothing refuses nothing, which is the
// whole reason the list is in the config and not in here.
for (const p of [22, 25, 80, 443, 6379, 3306]) {
  ok(g.portAllowed(p, false, []).ok, `nothing blocks port ${p} when the list is empty`);
}
ok(g.portAllowed(80, false, undefined).ok, 'and an absent list blocks nothing either');

// ─── 4. Hostnames ───────────────────────────────────────────────────────────
// Applied at the WebSocket boundary, before a client string reaches
// getaddrinfo, net.createConnection, or a log line — where a newline in it
// forges whole records in the operator's only account of what happened.
console.log('\n── hostnames');
for (const h of ['bbs.example.org', 'a-net.online', 'telehack.com', 'x.co', 'host.',
                 '1.2.3.4', '::1', 'my_bbs.example.com', 'xn--bcher-kva.example']) {
  ok(g.isValidHost(h), `accepted: ${JSON.stringify(h)}`);
}
for (const [h, what] of [
  ['bbs.example.org\nDIAL forged', 'a newline — this is the log-forging case'],
  ['bbs\r\nexample.org', 'a CRLF'],
  ['bbs example.org', 'a space'],
  ['-leading.example', 'a label starting with a hyphen'],
  ['trailing-.example', 'a label ending with one'],
  ['', 'the empty string'],
  ['.', 'a bare dot'],
  ['a..b', 'an empty label'],
  ['a'.repeat(300), 'anything past 253 characters'],
  ['a'.repeat(64) + '.example', 'a label past 63 characters'],
  [null, 'null'],
  [undefined, 'undefined'],
  [{}, 'an object — a JSON frame can carry one'],
  [['bbs.example.org'], 'an array'],
  [42, 'a number'],
]) {
  ok(!g.isValidHost(h), `refused: ${what}`);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
