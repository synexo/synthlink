#!/usr/bin/env node
// Unit tests for SynthLink's shareable-link handling in public/main.js:
// the query-string parser, the protocol-name ⇄ <option> token mapping, and the
// link builder behind the share panel.
//
// Same extraction trick as tools/bbslabeltest.js — main.js is a browser module
// that runs top-to-bottom against a live DOM and an AudioContext, so it can't be
// required. The four pure functions are pulled out of the source by name and run
// here, so the test tracks the real implementation instead of a copy that drifts.
// Node supplies URLSearchParams globally, which is all they depend on.
//
//   node tools/sharelinktest.js

const fs = require('fs');
const path = require('path');

const MAIN = path.join(__dirname, '..', 'public', 'main.js');
const INDEX = path.join(__dirname, '..', 'public', 'index.html');
const SRC = fs.readFileSync(MAIN, 'utf8');
const HTML = fs.readFileSync(INDEX, 'utf8');

function extract(name) {
  // `const NAME = ...;` (single-line arrow) or `function NAME(...) { ... }`.
  const c = SRC.match(new RegExp(`^const ${name} = .*?;$`, 'm'));
  if (c) return c[0];
  const start = SRC.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`sharelinktest: ${name} not found in public/main.js`);
  // Walk the parameter list to its closing paren FIRST. Starting the brace scan
  // at the first '{' would stop on a destructured parameter — buildShareURL's
  // `(origin, pathname, { host, port, ... })` closes that brace before the body
  // is ever reached, yielding a signature with no body and a baffling syntax
  // error at the harness's own `return`.
  let i = SRC.indexOf('(', start), pd = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '(') pd++;
    else if (SRC[i] === ')' && --pd === 0) break;
  }
  let depth = 0;
  for (let j = SRC.indexOf('{', i); j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}' && --depth === 0) return SRC.slice(start, j + 1);
  }
  throw new Error(`sharelinktest: unbalanced braces reading ${name}`);
}

const NAMES = ['DEFAULT_SPEED', 'speedToken', 'speedFromToken', 'parseShareParams', 'buildShareURL'];
const { DEFAULT_SPEED, speedToken, speedFromToken, parseShareParams, buildShareURL } =
  new Function([...NAMES.map(extract), `return { ${NAMES.join(', ')} };`].join('\n'))();

// The real menu, read out of index.html so the tests can't drift from the UI.
const OPTS = [...HTML.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);

let pass = 0, fail = 0;
function eq(actual, expected, what) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  fail++;
  console.log(`  FAIL ${what}\n       expected ${e}\n       actual   ${a}`);
}

console.log('sharelinktest — shareable links\n');

// ── The menu itself ─────────────────────────────────────────────────────────
eq(OPTS.includes(DEFAULT_SPEED), true, 'DEFAULT_SPEED is a real menu entry');
eq(DEFAULT_SPEED, 'V34@33600', 'DEFAULT_SPEED is V.34 33600');
eq(/<option value="V34@33600" selected>/.test(HTML), true,
   'index.html marks the same option selected as DEFAULT_SPEED');
eq(OPTS.filter((v) => / selected/.test(v)).length, 0, 'option values carry no stray markup');

// ── Tokens ──────────────────────────────────────────────────────────────────
eq(speedToken('V34@33600'), 'v34-33600', 'token: V.34 rate uses a dash, not @');
eq(speedToken('V32bis'), 'v32bis', 'token: plain protocol');
eq(speedToken('direct'), 'direct', 'token: bypass');

// Every menu entry must round-trip through its own token, or a share link could
// name a speed the parser then fails to find.
for (const v of OPTS) {
  eq(speedFromToken(speedToken(v), OPTS), v, `round-trip ${v}`);
}

// ── Protocol names, which is the whole point: rates collide ─────────────────
// 300 is V.21 and Bell 103; 9600 is V.29 and V.32; 33600 is V.34's top rate and
// V.90's upstream. Names disambiguate where a bit rate could not.
eq(speedFromToken('v21', OPTS), 'V21', 'v21');
eq(speedFromToken('bell103', OPTS), 'Bell103', 'bell103 — the other 300 bps');
eq(speedFromToken('v29', OPTS), 'V29', 'v29');
eq(speedFromToken('v32', OPTS), 'V32', 'v32 — the other 9600');
eq(speedFromToken('v22bis', OPTS), 'V22bis', 'v22bis');
eq(speedFromToken('v32bis', OPTS), 'V32bis', 'v32bis');
eq(speedFromToken('v23', OPTS), 'V23', 'v23');
eq(speedFromToken('v90', OPTS), 'V90', 'v90');

// Casing, the spec's "V.32bis" spelling, and the '@' form all accepted.
eq(speedFromToken('V32BIS', OPTS), 'V32bis', 'uppercase');
eq(speedFromToken('v.32bis', OPTS), 'V32bis', 'spec spelling with a dot');
eq(speedFromToken('V34@31200', OPTS), 'V34@31200', "'@' form still accepted");
eq(speedFromToken('  v90  ', OPTS), 'V90', 'surrounding whitespace');

// V.34 is the multi-rate one: bare name means its top rate.
eq(speedFromToken('v34', OPTS), 'V34@33600', 'bare v34 means the top V.34 rate');
eq(speedFromToken('v34-28800', OPTS), 'V34@28800', 'explicit V.34 rate');
eq(speedFromToken('v34-31200', OPTS), 'V34@31200', 'explicit V.34 rate');

// The bypass entry is `direct` internally but "Telnet" in the UI, so accept both.
eq(speedFromToken('telnet', OPTS), 'direct', 'telnet → the modem-bypass entry');
eq(speedFromToken('direct', OPTS), 'direct', 'direct → the modem-bypass entry');

// Nonsense names nothing, so startup falls back rather than half-applying.
eq(speedFromToken('v99', OPTS), '', 'unknown protocol');
eq(speedFromToken('33600', OPTS), '', 'a bare bit rate is not a speed name');
eq(speedFromToken('', OPTS), '', 'empty');
eq(speedFromToken(null, OPTS), '', 'missing');

// ── Parsing ─────────────────────────────────────────────────────────────────
eq(parseShareParams('', OPTS), {}, 'no query at all');
eq(parseShareParams('?', OPTS), {}, 'empty query');

// Host alone works: port and speed default downstream.
eq(parseShareParams('?host=bbs.fozztexx.com', OPTS), { host: 'bbs.fozztexx.com' },
   'host alone — port and speed left to their defaults');
eq(parseShareParams('host=bbs.fozztexx.com', OPTS), { host: 'bbs.fozztexx.com' },
   'leading ? is optional');

eq(parseShareParams('?host=x.org&port=2323&speed=v32bis&autoconnect=1', OPTS),
   { host: 'x.org', port: '2323', speed: 'V32bis', autoconnect: true }, 'full link');

// Speed with no host is still honoured — it just sets the menu.
eq(parseShareParams('?speed=v90', OPTS), { speed: 'V90' }, 'speed without a host');

// autoconnect spellings, including the bare key some clients leave behind.
for (const q of ['autoconnect=1', 'autoconnect=true', 'autoconnect=yes', 'autoconnect=on', 'autoconnect']) {
  eq(parseShareParams(`?host=x.org&${q}`, OPTS).autoconnect, true, `autoconnect: ${q}`);
}
eq(parseShareParams('?host=x.org&autoconnect=0', OPTS).autoconnect, false, 'autoconnect=0');
eq(parseShareParams('?host=x.org&autoconnect=no', OPTS).autoconnect, false, 'autoconnect=no');
eq(parseShareParams('?autoconnect=1', OPTS).autoconnect, undefined,
   'autoconnect without a host is ignored — nothing to dial');

// ── Host validation: a crafted link must not reach #host ────────────────────
// The host is a bare hostname, never a URL. Anything else is dropped whole
// rather than repaired, so a bad link falls back to normal startup.
for (const bad of ['http://x.org', 'x.org/path', 'a b.org', 'user@x.org', 'x.org:23',
                   '<script>', 'javascript:alert(1)', '../etc', '']) {
  eq(parseShareParams(`?host=${encodeURIComponent(bad)}`, OPTS).host, undefined,
     `rejects host ${JSON.stringify(bad)}`);
}
eq(parseShareParams(`?host=${'a'.repeat(254)}`, OPTS).host, undefined, 'rejects an over-long host');
eq(parseShareParams('?host=bbs-1.example.co.uk', OPTS).host, 'bbs-1.example.co.uk',
   'accepts dots and hyphens');

// A rejected host takes its port with it — a half-applied destination is worse
// than none, and autoconnect must not survive either.
eq(parseShareParams('?host=http://x.org&port=2323&autoconnect=1', OPTS), {},
   'a rejected host drops the port and autoconnect too');

// Port validation.
eq(parseShareParams('?host=x.org&port=0', OPTS).port, undefined, 'rejects port 0');
eq(parseShareParams('?host=x.org&port=65536', OPTS).port, undefined, 'rejects port 65536');
eq(parseShareParams('?host=x.org&port=23abc', OPTS).port, undefined, 'rejects a non-numeric port');
// '%2B23' is a literal '+23'. (A bare '+23' is not: '+' means a space in a query
// string, so that decodes to ' 23' and trims to a perfectly ordinary port 23.)
eq(parseShareParams('?host=x.org&port=%2B23', OPTS).port, undefined, 'rejects a signed port');
eq(parseShareParams('?host=x.org&port=+23', OPTS).port, '23', "'+' decodes to a space, so +23 is port 23");
eq(parseShareParams('?host=x.org&port=65535', OPTS).port, '65535', 'accepts the top port');
eq(parseShareParams('?host=x.org&port=1', OPTS).port, '1', 'accepts port 1');
// A bad port falls back to 23 rather than voiding the host — the destination is
// still meaningful, and 23 is what a bare host would have used anyway.
eq(parseShareParams('?host=x.org&port=nope', OPTS).host, 'x.org',
   'a bad port leaves the host intact');

// ── Building ────────────────────────────────────────────────────────────────
eq(buildShareURL('https://synthlink.example', '/', { host: 'bbs.fozztexx.com', port: '23', speed: 'V34@33600', autoconnect: true }),
   'https://synthlink.example/?host=bbs.fozztexx.com&port=23&speed=v34-33600&autoconnect=1',
   'built link');
eq(buildShareURL('https://x.example', '/', { host: 'a.org', port: '23', speed: 'V32bis' }),
   'https://x.example/?host=a.org&port=23&speed=v32bis',
   'autoconnect omitted when not asked for');
eq(buildShareURL('https://x.example', '/', { host: 'a.org', speed: 'V22' }).includes('port=23'),
   true, 'port is written out even when it is the default');
eq(buildShareURL('https://x.example', '/', { host: 'a.org', port: '23' }).includes(`speed=${speedToken(DEFAULT_SPEED)}`),
   true, 'missing speed falls back to DEFAULT_SPEED');
// No '@' in a built link: it percent-encodes in some clients and looks broken.
eq(/@|%40/.test(buildShareURL('https://x.example', '/', { host: 'a.org', port: '23', speed: 'V34@33600' })),
   false, 'built link contains no @ or %40');

// ── The round trip that actually matters ────────────────────────────────────
// Build a link for every menu entry, parse it back, and confirm the controls
// would land exactly where they started.
for (const speed of OPTS) {
  const url = buildShareURL('https://x.example', '/', { host: 'bbs.fozztexx.com', port: '2003', speed, autoconnect: true });
  const back = parseShareParams(url.slice(url.indexOf('?')), OPTS);
  eq(back, { host: 'bbs.fozztexx.com', port: '2003', speed, autoconnect: true }, `full round-trip ${speed}`);
}

console.log(`\n${fail ? 'FAILED' : 'OK'} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
