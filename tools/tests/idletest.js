'use strict';
/**
 * tools/tests/idletest.js — the server's idle disconnect (config/site.json:
 * idleDisconnectMinutes).
 *
 * Drives the REAL server.js session code with the same `ws` stub directtest.js
 * uses: WebSocketServer is replaced with an EventEmitter that never listens, so
 * no persistent WS server enters the process tree (CLAUDE.md — that is what
 * hangs the sandbox). The BBS end is a genuine TCP socket that banners once and
 * then says nothing, which is exactly the condition being measured.
 *
 * Three things are worth asserting, and they are the three ways this can be
 * wrong:
 *
 *   1. A silent call is dropped, with a reason that names it.
 *   2. Traffic POSTPONES it. A timer that fires on a schedule rather than on
 *      silence would disconnect people mid-session, which is far worse than not
 *      having the feature.
 *   3. 0 disables it outright. A `||` anywhere on this value would turn "no
 *      idle timeout" back into the 30-minute default, silently.
 *
 * lib/site.js caches its config on first read and server.js reads it at session
 * construction, so the two configurations cannot coexist in one process: the
 * file re-runs itself as a child per case. The scratch config/site.json is
 * written by the CHILD and restored on its exit — same pattern, and the same
 * caveat, as logtest.js and sitetest.js: if one dies mid-run, check that file.
 *
 *   node tools/tests/idletest.js
 */

const net = require('net');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const Module = require('module');

const CASE = process.env.IDLE_CASE || '';

// Short enough to test in seconds, long enough to clear the banner and the
// telnet negotiation that follow link-up. Expressed in minutes because that is
// what the setting is; lib/site.js takes a fraction for exactly this reason.
const IDLE_MIN = 0.03;               // 1.8 s
const IDLE_MS = IDLE_MIN * 60000;

// ─── Parent: run each case in its own process ───────────────────────────────
if (!CASE) {
  const { spawnSync } = require('child_process');
  let pass = 0, fail = 0;
  for (const c of ['on', 'off']) {
    // The mock BBS is on loopback and netguard's address policy is a constant
    // with no config key; the flag is how a harness reaches its own peer.
    const r = spawnSync(process.execPath, [__filename, '--allow-private-ips=127.0.0.0/8'], {
      env: { ...process.env, IDLE_CASE: c }, encoding: 'utf8',
    });
    process.stdout.write(r.stdout || '');
    if (r.stderr) process.stderr.write(r.stderr);
    const m = /(\d+) passed, (\d+) failed/.exec(r.stdout || '');
    if (m) { pass += +m[1]; fail += +m[2]; }
    else { fail++; console.log(`  FAIL case "${c}" produced no result (exit ${r.status})`); }
  }
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

// ─── Child ──────────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
function ok(cond, what, extra) {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${extra ? '\n       ' + extra : ''}`); }
}

// Scratch config, real one preserved.
const FILE = path.join(__dirname, '..', '..', 'config', 'site.json');
const REAL = fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8') : null;
function restore() {
  if (REAL === null) { try { fs.unlinkSync(FILE); } catch (_) {} }
  else fs.writeFileSync(FILE, REAL);
}
process.on('exit', restore);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { restore(); process.exit(1); });

const base = REAL ? JSON.parse(REAL) : {};
// This harness dials through telnet bypass, and its mock BBS is a loopback port
// that no directory lists — so the bypass gate is turned off for the run. The
// idle timer is what is under test here; gating it as well would test two
// things and diagnose neither. directtest.js covers the gate itself.
fs.writeFileSync(FILE, JSON.stringify({
  ...base, idleDisconnectMinutes: CASE === 'off' ? 0 : IDLE_MIN,
  directRequireListed: false,
}));

class FakeWSS extends EventEmitter { constructor(_opts) { super(); } }
const origLoad = Module._load;
process.env.BBSLIST_UPDATE = '0';
process.env.PORT = String(20000 + (process.pid % 10000));

class FakeWS extends EventEmitter {
  constructor() { super(); this.OPEN = 1; this.readyState = 1; this.binary = []; this.json = []; }
  send(data) {
    if (typeof data === 'string') this.json.push(JSON.parse(data));
    else this.binary.push(Buffer.from(data));
  }
  close() { this.readyState = 3; }
}

// Banners once, then silent — the state an abandoned tab leaves a board in.
const BANNER = 'Welcome, and then nothing.\r\n';
const bbs = net.createServer((s) => {
  s.setNoDelay(true);
  s.write(Buffer.from(BANNER, 'latin1'));
});

bbs.listen(0, '127.0.0.1', () => {
  const bbsPort = bbs.address().port;
  const wss = requireServerAndGetWSS();
  const ws = new FakeWS();
  wss.emit('connection', ws, { socket: { remoteAddress: 'test' } });
  // Direct mode: the link is up as soon as the TCP socket is, so the idle
  // timer's arming point is reached in milliseconds rather than after a
  // handshake. The timer itself is transport-independent.
  ws.emit('message', Buffer.from(JSON.stringify({
    type: 'dial', host: '127.0.0.1', port: bbsPort, link: 'direct',
  })), false);

  const closed = () => ws.json.find((m) => m.type === 'closed');
  console.log(`\n── idleDisconnectMinutes = ${CASE === 'off' ? 0 : IDLE_MIN}`);

  // Two thirds of the way through, type. If the timer is a fixed alarm rather
  // than an idle measure, this changes nothing and the call still dies below.
  setTimeout(() => {
    ok(!closed(), 'still connected part-way through the idle window');
    ws.emit('message', Buffer.from('x', 'latin1'), true);
  }, IDLE_MS * 0.66);

  // Past the ORIGINAL deadline but not past the postponed one.
  setTimeout(() => {
    ok(!closed(), 'a keystroke postponed the disconnect');
  }, IDLE_MS * 1.25);

  // Past the postponed deadline, with slack for the timer.
  setTimeout(() => {
    const c = closed();
    if (CASE === 'off') {
      ok(!c, '0 disables the idle disconnect entirely', JSON.stringify(ws.json));
    } else {
      ok(!!c && c.reason === 'idle', 'a silent call is dropped, reason "idle"',
         JSON.stringify(ws.json));
      ok(ws.json.some((m) => m.type === 'status' && /idle/i.test(m.text)),
         'and the terminal is told why before the link goes',
         JSON.stringify(ws.json.filter((m) => m.type === 'status')));
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
  }, IDLE_MS * 2.4);
});

function requireServerAndGetWSS() {
  let instance = null;
  const Patched = new Proxy(FakeWSS, {
    construct(target, args) { instance = new target(...args); return instance; },
  });
  Module._load = function (request, ...rest) {
    if (request === 'ws') return { WebSocketServer: Patched };
    return origLoad.call(this, request, ...rest);
  };
  require('../../server.js');
  if (!instance) throw new Error('WSS not captured');
  return instance;
}
