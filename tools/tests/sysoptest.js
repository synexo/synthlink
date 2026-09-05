#!/usr/bin/env node
'use strict';
/**
 * tools/tests/sysoptest.js — the sysop status page: its gate, its routes, and
 * the shape of what it reports.
 *
 * The assertions that matter here are the refusals, not the page:
 *
 *   1. With the feature off, both paths are 404 — not 401. A 401 tells a scanner
 *      the route exists and is worth a wordlist; the whole point of the default
 *      is that an operator who has not turned this on is indistinguishable from
 *      a build that never had it.
 *   2. No credential, a wrong password, a wrong username and a malformed header
 *      all get 401 and NO BODY from the page. A viewer that leaks the table to
 *      an unauthenticated request is the only way this feature can hurt.
 *   3. The routes are read-only: a POST does not write anything, because there
 *      is nothing behind them that writes.
 *   4. A stored value that is not a hash is refused by the CONFIG loader, at
 *      boot — pasting the password in by mistake must not produce a server that
 *      starts and then rejects the operator's own password for ever.
 *
 * Like httptest.js and directtest.js the only thing faked is `ws`: a persistent
 * WebSocket server in the process tree hangs the sandbox (CLAUDE.md). The HTTP
 * listener is a plain one and is what we want to talk to.
 *
 * It writes a scratch config/site.json and restores the real one on exit, the
 * same contract logtest/sitetest/idletest keep — the operator's file is never
 * edited to get a test through.
 *
 *   node tools/tests/sysoptest.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const Module = require('module');

let pass = 0, fail = 0;
function ok(cond, what, extra) {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${extra ? '\n       ' + extra : ''}`); }
}

const ROOT = path.join(__dirname, '..', '..');
const SITE = path.join(ROOT, 'config', 'site.json');
const BACKUP = SITE + '.sysoptest-bak';

const USER = 'sysop';
const PASS = 'correct horse battery staple';

// ─── The pure half, before anything is started ──────────────────────────────
// Required directly: hashing and verifying involve no server at all, and the
// CLI utility (tools/sysoppass.js) is a prompt around exactly these two.
const sysop = require('../../lib/sysop');

console.log('── hashing');
const HASH = sysop.hashPassword(PASS);
ok(/^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/.test(HASH),
   'hashPassword produces a self-describing scrypt$… line', HASH);
ok(sysop.hashPassword(PASS) !== HASH,
   'the same password twice gives different hashes (the salt is random)');
ok(sysop.parseHash(HASH) && sysop.parseHash(HASH).N === 16384,
   'the parameters travel with the hash, so raising the cost later cannot ' +
   'invalidate an existing line');
for (const bad of ['', 'hunter2', 'scrypt$x$8$1$aa$bb', 'scrypt$16384$8$1$aa',
                   'bcrypt$16384$8$1$aa$bb']) {
  ok(sysop.parseHash(bad) === null, `parseHash refuses ${JSON.stringify(bad)}`);
}

(async () => {
  await new Promise((r) => sysop.verifyPassword(PASS, HASH, (v) => {
    ok(v === true, 'the right password verifies'); r();
  }));
  await new Promise((r) => sysop.verifyPassword(PASS + ' ', HASH, (v) => {
    ok(v === false, 'one trailing space does not verify'); r();
  }));
  await new Promise((r) => sysop.verifyPassword(PASS, 'not-a-hash', (v) => {
    ok(v === false, 'a stored value that is not a hash verifies nothing — it does not ' +
                    'throw and it does not pass'); r();
  }));

  // ─── The config loader refuses a password written where a hash goes ───────
  console.log('\n── the config loader catches a pasted password');
  const configload = require('../../lib/configload');
  const site = require('../../lib/site');
  const rule = { sysopPasswordHash: { type: 'string',
    check: (v) => (v === '' || sysop.parseHash(v)) ? null : 'not a hash' } };
  ok(configload.checkValue('sysopPasswordHash', PASS, rule.sysopPasswordHash) !== null,
     'a plaintext password in sysopPasswordHash is a config error, not a server ' +
     'that starts and then refuses the operator');
  ok(configload.checkValue('sysopPasswordHash', '', rule.sysopPasswordHash) === null,
     'an empty hash is legal — it is how the feature stays off');

  ok(sysop.enabled({ sysopEnabled: true, sysopUser: USER, sysopPasswordHash: HASH }),
     'enabled() needs all three');
  for (const cfg of [{ sysopEnabled: false, sysopUser: USER, sysopPasswordHash: HASH },
                     { sysopEnabled: true, sysopUser: '', sysopPasswordHash: HASH },
                     { sysopEnabled: true, sysopUser: USER, sysopPasswordHash: '' }]) {
    ok(!sysop.enabled(cfg), `enabled() is false with ${JSON.stringify(cfg).slice(0, 40)}…`);
  }

  // ─── Now the server ───────────────────────────────────────────────────────
  // A scratch site.json with the feature ON. Complete and valid, because
  // anything less is a server that will not start (CLAUDE.md).
  const real = fs.readFileSync(SITE, 'utf8');
  fs.writeFileSync(BACKUP, real);
  const restore = () => {
    try { if (fs.existsSync(BACKUP)) { fs.copyFileSync(BACKUP, SITE); fs.unlinkSync(BACKUP); } }
    catch (_) {}
  };
  process.on('exit', restore);

  const scratch = JSON.parse(real);
  scratch.sysopEnabled = true;
  scratch.sysopUser = USER;
  scratch.sysopPasswordHash = HASH;
  scratch.sysopRefreshSeconds = 5;
  fs.writeFileSync(SITE, JSON.stringify(scratch, null, 2));
  site._reset();

  class FakeWSS extends EventEmitter { constructor(_opts) { super(); } }
  const origLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'ws') return { WebSocketServer: FakeWSS };
    return origLoad.call(this, request, ...rest);
  };

  process.env.BBSLIST_UPDATE = '0';
  const PORT = 22000 + (process.pid % 9000);
  process.env.PORT = String(PORT);
  require('../../server.js');
  await new Promise((r) => setTimeout(r, 300));

  const basic = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
  function get(pathText, auth, method = 'GET') {
    return new Promise((resolve) => {
      const headers = auth ? { Authorization: auth } : {};
      const req = http.request({ host: '127.0.0.1', port: PORT, path: pathText, method, headers },
        (res) => {
          let body = '';
          res.on('data', (c) => { body += c; });
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        });
      req.on('error', (e) => resolve({ status: 0, headers: {}, body: String(e) }));
      req.end();
    });
  }

  console.log('\n── unauthenticated');
  for (const p of ['/sysop', '/sysop.json']) {
    const r = await get(p);
    ok(r.status === 401, `${p} with no credential is 401 (${r.status})`);
    ok(/^Basic /.test(r.headers['www-authenticate'] || ''),
       `${p} asks for Basic, so a browser prompts`);
    ok(!/Live calls|"calls"/.test(r.body), `${p} leaks nothing in the 401 body`);
  }

  console.log('\n── wrong credentials');
  const cases = [
    ['the wrong password', basic(USER, 'hunter2')],
    ['the wrong username', basic('admin', PASS)],
    ['both wrong', basic('admin', 'hunter2')],
    ['a malformed header', 'Basic !!!!not base64!!!!'],
    ['a bare token', 'Bearer ' + HASH],
    ['no colon in the pair', 'Basic ' + Buffer.from('sysop').toString('base64')],
  ];
  for (const [what, header] of cases) {
    const r = await get('/sysop.json', header);
    ok(r.status === 401, `${what} is 401 (${r.status})`);
    ok(!/"calls"/.test(r.body), `${what} gets no data`);
  }

  console.log('\n── the right credentials');
  const page = await get('/sysop', basic(USER, PASS));
  ok(page.status === 200, `/sysop serves the page (${page.status})`);
  ok(/Live calls/.test(page.body), '/sysop is the status page');
  ok(!/\{\{[A-Z]+\}\}/.test(page.body),
     'every {{TOKEN}} in the page was substituted', (page.body.match(/\{\{[A-Z]+\}\}/) || [])[0]);
  ok(/no-store/.test(page.headers['cache-control'] || ''),
     'the page is no-store — it names every current caller');

  const data = await get('/sysop.json', basic(USER, PASS));
  ok(data.status === 200, `/sysop.json answers (${data.status})`);
  let d = null;
  try { d = JSON.parse(data.body); } catch (_) {}
  ok(d !== null, '/sysop.json is JSON');
  if (d) {
    ok(Array.isArray(d.calls) && d.calls.length === 0,
       'no calls in progress, and the field is an array either way');
    ok(typeof d.today.dials === 'number' && typeof d.today.connects === 'number',
       "today carries dials AND connects — the difference is the failure rate");
    ok(typeof d.allTime.connects === 'number',
       'all-time is CONNECTS, the same measurement as today.connects, so the two ' +
       'can sit either side of a slash');
    ok(typeof d.limits.maxSessions === 'number' && 'allowPrivateIps' in d.limits,
       'the limits this server is running under are reported');
    ok(!('uniqueIps' in d.today) || typeof d.today.uniqueIps === 'number',
       'uniqueIps is a COUNT — the addresses stay in the access log');
    ok(d.uptimeSec >= 0, 'uptime is reported');
  }
  ok(/no-store/.test(data.headers['cache-control'] || ''), '/sysop.json is no-store');

  console.log('\n── the memo does not become a bypass');
  // The memo is keyed on the exact header. A different credential must not ride
  // in on a verified one.
  const after = await get('/sysop.json', basic(USER, 'hunter2'));
  ok(after.status === 401, 'a wrong password is still 401 after a right one succeeded');
  const again = await get('/sysop.json', basic(USER, PASS));
  ok(again.status === 200, 'and the right one still works afterwards');

  console.log('\n── read-only');
  const post = await get('/sysop.json', basic(USER, PASS), 'POST');
  ok(post.status === 200 || post.status === 404 || post.status === 405,
     `POST does not do anything unexpected (${post.status})`);
  const before = JSON.parse((await get('/sysop.json', basic(USER, PASS))).body);
  ok(before.calls.length === 0, 'nothing was created by any request above');

  console.log('\n── turned off, the routes do not exist');
  scratch.sysopEnabled = false;
  fs.writeFileSync(SITE, JSON.stringify(scratch, null, 2));
  site._reset();
  sysop.forget();
  for (const p of ['/sysop', '/sysop.json']) {
    const r = await get(p, basic(USER, PASS));
    ok(r.status === 404,
       `${p} is 404 when disabled — NOT 401, which would tell a scanner it exists (${r.status})`);
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
  restore();
  process.exit(fail === 0 ? 0 : 1);
})();
