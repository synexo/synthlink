'use strict';
/**
 * tools/tests/httptest.js — the static handler's two refusals.
 *
 * Both of these were live bugs, and both are the kind that come back the next
 * time someone tidies the top of the request handler:
 *
 *   1. `GET /%` — decodeURIComponent throws URIError on a malformed escape, the
 *      throw is synchronous inside the request handler, and an unhandled one
 *      there reaches uncaughtException and EXITS THE PROCESS. One unauthenticated
 *      request, no rate limit in front of it, every call in progress lost. The
 *      assertion that matters is not the status code — it is that the process is
 *      still running afterwards.
 *
 *   2. `startsWith(PUBLIC)` with no separator also accepts every SIBLING
 *      directory whose name merely begins with "public": public.bak, public-old,
 *      public.orig, which is exactly what an operator leaves behind before an
 *      upgrade.
 *
 * Drives the REAL server.js. Like directtest.js, the only thing faked is the
 * `ws` module — a persistent WS server in the process tree hangs the sandbox
 * (CLAUDE.md). The HTTP listener is a plain one that exits cleanly, which is
 * fine, and is what we actually want to talk to here.
 *
 *   node tools/tests/httptest.js
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

// ─── Stub `ws` before server.js loads it ────────────────────────────────────
class FakeWSS extends EventEmitter { constructor(_opts) { super(); } }
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'ws') return { WebSocketServer: FakeWSS };
  return origLoad.call(this, request, ...rest);
};

process.env.BBSLIST_UPDATE = '0';
const PORT = 21000 + (process.pid % 9000);
process.env.PORT = String(PORT);

// The sibling directory the prefix check used to let through. Created beside
// public/ exactly as a pre-upgrade backup would be, and removed on the way out.
const ROOT = path.join(__dirname, '..', '..');
const SIBLING = path.join(ROOT, 'public.httptest-bak');
const SECRET = 'this file is outside public/ and must not be served\n';
fs.mkdirSync(SIBLING, { recursive: true });
fs.writeFileSync(path.join(SIBLING, 'secret.txt'), SECRET);
const cleanupFiles = () => { try { fs.rmSync(SIBLING, { recursive: true, force: true }); } catch (_) {} };
process.on('exit', cleanupFiles);

require('../../server.js');

// ─── A request that does not go through Node's URL sanitising ───────────────
// http.get() would reject or rewrite some of these paths before they left, and
// the point is what the SERVER does with them, so the request line is written
// onto the socket by hand.
const net = require('net');
function raw(pathText) {
  return new Promise((resolve) => {
    const sock = net.createConnection(PORT, '127.0.0.1');
    let buf = '';
    sock.on('connect', () => sock.write(`GET ${pathText} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`));
    sock.on('data', (d) => { buf += d.toString('latin1'); });
    sock.on('close', () => {
      const status = parseInt((buf.split('\r\n')[0] || '').split(' ')[1], 10) || 0;
      const body = buf.split('\r\n\r\n').slice(1).join('\r\n\r\n');
      resolve({ status, body });
    });
    sock.on('error', () => resolve({ status: 0, body: '' }));
  });
}

(async () => {
  // Give the listener a moment to bind.
  await new Promise((r) => setTimeout(r, 300));

  console.log('\n── malformed percent-escapes do not take the server down');
  const bad = ['/%', '/%zz', '/%e0%a4%a', '/index.html%', '/%%', '/%c0%80'];
  for (const p of bad) {
    const r = await raw(p);
    ok(r.status === 400 || r.status === 404,
       `${p} is answered (${r.status}), not fatal`, JSON.stringify(r));
  }
  // THE assertion. If the decode had thrown, nothing would answer this.
  const alive = await raw('/index.html');
  ok(alive.status === 200, 'and the server is still serving afterwards',
     `status ${alive.status} — the process died on one of the requests above`);

  console.log('\n── a NUL in the path is refused');
  const nul = await raw('/index.html%00.txt');
  ok(nul.status === 400, `a percent-encoded NUL is refused (${nul.status})`);

  console.log('\n── the prefix check does not admit sibling directories');
  for (const p of ['/../public.httptest-bak/secret.txt',
                   '/..%2fpublic.httptest-bak%2fsecret.txt',
                   '/%2e%2e/public.httptest-bak/secret.txt']) {
    const r = await raw(p);
    ok(!r.body.includes('must not be served'),
       `${p} does not serve a file outside public/ (${r.status})`);
  }
  // Traversal above the parent was already refused; assert it stays refused.
  for (const p of ['/../package.json', '/../../etc/passwd', '/..%2f..%2fetc%2fpasswd']) {
    const r = await raw(p);
    ok(r.status === 403 || r.status === 404, `${p} is refused (${r.status})`);
  }

  console.log('\n── and the ordinary case still works');
  const idx = await raw('/');
  ok(idx.status === 200 && /<html/i.test(idx.body), 'GET / serves the page');
  const enc = await raw('/index.html');
  ok(enc.status === 200, 'GET /index.html serves the page');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
  cleanupFiles();
  process.exit(fail === 0 ? 0 : 1);
})();
