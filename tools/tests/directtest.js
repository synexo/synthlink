'use strict';
/**
 * tools/tests/directtest.js — end-to-end test of Telnet direct (modem-bypass) mode.
 *
 * Drives the REAL server.js session code. The only thing faked is the `ws`
 * module: WebSocketServer is replaced with an EventEmitter that never listens,
 * so no persistent WS server ever enters the process tree (CLAUDE.md: that is
 * what hangs the sandbox). The BBS end is a genuine TCP socket, and the client
 * end is a fake `ws` object that records every frame the server sends.
 *
 * Covers:
 *   1. direct mode — no PCM, payload both ways, byte-exact,
 *   2. telnet still terminated at the server (IAC answered on the TCP side),
 *   3. the BBS is dialled only AFTER carrier, not at dial time,
 *   4. an unreachable board is answered with the uniform no-connect message,
 *   4b. the two telnet-bypass dial gates: unlisted boards refused, and one
 *       bypass dial server-wide per interval (delayed, never announced),
 *   4c. the telnet-bypass RATE cap, both directions: paced, never dropped,
 *       never announced. lib/throttle.js's own suite proves the pacer; this
 *       proves it is wired to both ends of a real session,
 *   5. a full V.32bis call through server.js with a real originate ModemDSP.
 *
 *   node tools/tests/directtest.js
 */

const net = require('net');
const { EventEmitter } = require('events');
const Module = require('module');

let pass = 0, fail = 0;
function ok(cond, what, extra) {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fail++; console.log(`  FAIL ${what}${extra ? '\n       ' + extra : ''}`); }
}

// ─── Stub the `ws` module before server.js loads it ─────────────────────────
class FakeWSS extends EventEmitter { constructor(_opts) { super(); } }
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'ws') return { WebSocketServer: FakeWSS };
  return origLoad.call(this, request, ...rest);
};

// The server-wide bypass interval, in seconds, for this run. The shipped value
// is 10 (config/site.json); this is the same code path with the clock turned
// down, so the spacing can be asserted in under a second.
const THROTTLE_S = 0.5;

// Settings the later sections turn down so a limit can be reached in a test
// rather than only under a real flood. Read on every config() call, so a section
// can set one just before it needs it.
const siteOverrides = {};

// The fake directory the server sees, assigned when server.js is loaded. Held at
// module scope so a section can list a board of its own — the per-board cap test
// needs a destination nothing else has already taken slots on.
let fakeDir = null;

// The mock BBS below listens on loopback, and lib/netguard refuses every
// non-public destination as a CONSTANT — there is no config key to turn it off,
// which is the point of it. The command-line flag is the seam, and it has to be
// in argv before netguard is first required (it reads argv once, at load).
// Scoped to loopback rather than bare, so this harness cannot mask a bug that
// would let some other private range through.
if (!process.argv.includes('--allow-private-ips=127.0.0.0/8')) {
  process.argv.push('--allow-private-ips=127.0.0.0/8');
}

process.env.BBSLIST_UPDATE = '0';                       // no outbound update traffic
// The HTTP listener's port. It was only ever the static server here and nothing
// connected to it; the sysop registry section below is the first thing in this
// file that does, and it reads this constant rather than restating the sum.
const HTTP_PORT = 20000 + (process.pid % 10000);
process.env.PORT = String(HTTP_PORT);

// ─── A mock BBS that negotiates telnet, banners, then echoes ────────────────
const IAC = 0xFF, SB = 0xFA, SE = 0xF0, WILL = 0xFB, WONT = 0xFC, DO = 0xFD, DONT = 0xFE;
const OPT_SGA = 0x03, OPT_TTYPE = 0x18, OPT_NAWS = 0x1F, OPT_ECHO = 0x01;
const BANNER = 'Welcome to Mock BBS!\r\n';

const fromClientAtBBS = [];   // payload the BBS received (negotiation stripped)
const iacAtBBS = [];          // raw negotiation bytes the BBS received
let ttypeReported = null, nawsReported = null;
let bbsConnections = 0;         // how many times anything has dialled the mock BBS
const bbsConnectTimes = [];     // when each of those dials landed

const bbs = net.createServer((s) => {
  bbsConnections++; bbsConnectTimes.push(Date.now());
  s.setNoDelay(true);
  // Probe exactly what a real board probes, then send the banner.
  s.write(Buffer.from([IAC, DO, OPT_TTYPE, IAC, DO, OPT_NAWS, IAC, WILL, OPT_SGA, IAC, WILL, OPT_ECHO]));
  s.write(Buffer.from(BANNER, 'latin1'));
  setTimeout(() => s.write(Buffer.from([IAC, SB, OPT_TTYPE, 1, IAC, SE])), 40);  // TTYPE SEND

  // Minimal IAC-aware receiver so we can separate keystrokes from negotiation.
  let st = 'DATA', sb = [];
  s.on('data', (buf) => {
    for (const b of buf) {
      switch (st) {
        case 'DATA':
          if (b === IAC) { st = 'IAC'; iacAtBBS.push(b); } else fromClientAtBBS.push(b);
          break;
        case 'IAC':
          iacAtBBS.push(b);
          if (b === SB) { sb = []; st = 'SB'; }
          else if (b >= WILL && b <= DONT) st = 'CMD';
          else st = 'DATA';
          break;
        case 'CMD': iacAtBBS.push(b); st = 'DATA'; break;
        case 'SB':
          iacAtBBS.push(b);
          if (b === IAC) st = 'SB_IAC'; else sb.push(b);
          break;
        case 'SB_IAC':
          iacAtBBS.push(b);
          if (b === SE) {
            if (sb[0] === OPT_TTYPE && sb[1] === 0) ttypeReported = Buffer.from(sb.slice(2)).toString('latin1');
            if (sb[0] === OPT_NAWS) nawsReported = [(sb[1] << 8) | sb[2], (sb[3] << 8) | sb[4]];
            st = 'DATA';
          } else { sb.push(b); st = 'SB'; }
          break;
      }
    }
  });
});

// ─── The fake browser end ───────────────────────────────────────────────────
// Every fake client this file makes, so the last section can close them all and
// work from a known session count instead of guessing what the earlier ones left
// open. A real browser socket closes on its own; these only close when told.
const allSockets = [];

class FakeWS extends EventEmitter {
  constructor() {
    super(); this.OPEN = 1; this.readyState = 1; this.binary = []; this.json = []; this.onBinary = null;
    allSockets.push(this);
  }
  send(data) {
    if (typeof data === 'string') { this.json.push(JSON.parse(data)); return; }
    const buf = Buffer.from(data);
    this.binary.push(buf);
    if (this.onBinary) this.onBinary(buf);   // used to drive a real originate DSP
  }
  close() { this.readyState = 3; }
}

bbs.listen(0, '127.0.0.1', () => {
  const bbsPort = bbs.address().port;
  const wss = requireServerAndGetWSS(bbsPort);
  const ws = new FakeWS();
  wss.emit('connection', ws, { socket: { remoteAddress: 'test' } });

  // Dial in direct mode.
  ws.emit('message', Buffer.from(JSON.stringify({
    type: 'dial', host: '127.0.0.1', port: bbsPort, link: 'direct',
  })), false);

  setTimeout(() => {
    // The user types once the link is up.
    ws.emit('message', Buffer.from('HELLO\r', 'latin1'), true);
    setTimeout(finish, 150);
  }, 200);

  function finish() {
    const payload = Buffer.concat(ws.binary).toString('latin1');
    const connected = ws.json.find((m) => m.type === 'connected');

    console.log('\n── direct mode');
    ok(!!connected && connected.direct === true && connected.protocol === 'DIRECT',
       'server reports a DIRECT connection', JSON.stringify(connected));
    ok(payload === BANNER, 'banner arrives byte-exact as raw WS frames',
       `got ${JSON.stringify(payload)}`);
    ok(!/ÿ/.test(payload), 'no IAC byte reaches the client');
    ok(ws.binary.every((b) => b.length > 0), 'no empty frames');

    console.log('\n── telnet still terminated at the server');
    ok(iacAtBBS.length > 0, 'the BBS received negotiation replies');
    ok(ttypeReported === 'ANSI', 'terminal type answered as ANSI', `got ${ttypeReported}`);
    ok(nawsReported && nawsReported[0] === 80 && nawsReported[1] === 25,
       'window size answered as 80×25', `got ${JSON.stringify(nawsReported)}`);
    const iac = Buffer.from(iacAtBBS).toString('hex');
    ok(iac.includes('fffb03') && iac.includes('fffd03'), 'SGA negotiated (WILL + DO)');
    ok(iac.includes('fffe01') || iac.includes('fffc01'), 'unsupported option (ECHO) still refused');

    console.log('\n── client → BBS');
    ok(Buffer.from(fromClientAtBBS).toString('latin1') === 'HELLO\r',
       'keystrokes arrive byte-exact, no PCM in between',
       JSON.stringify(Buffer.from(fromClientAtBBS).toString('latin1')));

    modemRegression();
  }

  // The modem branch of the same session code must be untouched: a dial with a
  // protocol still builds a DSP, still emits PCM, and still says nothing until
  // a carrier trains (which needs a real originate peer, so is out of scope
  // here — dsptest2 covers the handshake itself).
  function modemRegression() {
    const ws2 = new FakeWS();
    wss.emit('connection', ws2, { socket: { remoteAddress: 'test2' } });
    ws2.emit('message', Buffer.from(JSON.stringify({
      type: 'dial', host: '127.0.0.1', port: bbsPort, protocol: 'V22bis',
    })), false);

    setTimeout(() => {
      console.log('\n── modem mode unaffected');
      const pcm = Buffer.concat(ws2.binary);
      ok(pcm.length > 0, 'modem mode still emits PCM audio frames');
      ok(pcm.length % 2 === 0, 'PCM frames are Int16LE-aligned');
      ok(!ws2.json.some((m) => m.type === 'connected'),
         'no premature connect before carrier');
      ok(ws2.json.some((m) => m.type === 'status' && /answering modem/.test(m.text)),
         'answer-modem status still sent');

      deferredConnect();
    }, 400);
  }

  // The TCP connect must NOT happen at dial in modem mode: the BBS should not
  // be able to start talking (or start any "press a key" timeout) until the
  // carrier is up. The dial above never trains a carrier, so a connection
  // reaching the mock BBS at all proves the deferral is broken.
  function deferredConnect() {
    const ws3 = new FakeWS();
    wss.emit('connection', ws3, { socket: { remoteAddress: 'test3' } });
    ws3.emit('message', Buffer.from(JSON.stringify({
      type: 'dial', host: '127.0.0.1', port: bbsPort, protocol: 'V22bis',
    })), false);

    setTimeout(() => {
      console.log('\n── TCP connect deferred until carrier');
      // Absolute count, not a delta: exactly one dial has ever reached the BBS
      // — the direct-mode one at the top. Neither modem dial may have connected.
      ok(bbsConnections === 1,
         'no connection reaches the BBS while the modem is still handshaking',
         `${bbsConnections} total connection(s); expected 1 (the direct-mode dial)`);
      noConnectMessage();
    }, 500);
  }

  // Deferring the connect means failures land after the handshake, so they must
  // be reported explicitly rather than as a bare NO CARRIER.
  //
  // The message used to be `proxyError`, carrying the errno text. It is now a
  // bare `busy`, identical for every cause, because the errno told a caller
  // refused from filtered from unreachable — which is what a port scan needs.
  // The client answers this with a reorder tone and BUSY.
  function noConnectMessage() {
    const ws4 = new FakeWS();
    wss.emit('connection', ws4, { socket: { remoteAddress: 'test4' } });
    // Port 1 on loopback: nothing listens, connection refused immediately.
    ws4.emit('message', Buffer.from(JSON.stringify({
      type: 'dial', host: '127.0.0.1', port: 1, link: 'direct',
    })), false);

    setTimeout(() => {
      console.log('\n── unreachable BBS');
      const err = ws4.json.find((m) => m.type === 'busy');
      ok(!!err, 'server reports busy when the BBS cannot be reached',
         JSON.stringify(ws4.json));
      ok(!ws4.json.some((m) => JSON.stringify(m).includes('ECONNREFUSED')),
         'and never names the errno — that distinction is the scanning oracle',
         JSON.stringify(ws4.json));
      ok(!ws4.json.some((m) => m.type === 'connected'),
         'no connected message for a failed dial');

      bypassGate();
    }, 300);
  }

  // Gate 1: telnet bypass only reaches boards the directory offers. A modem
  // call is paced by its own handshake; bypass is a TCP connect the instant the
  // dial lands, so without this the server is an open proxy to anywhere.
  //
  // The assertion that matters is the CONNECTION COUNT, not the message: a
  // refusal that still dialled the board would satisfy any check on what the
  // client was told.
  function bypassGate() {
    console.log('\n── telnet bypass: unlisted boards refused');
    const before = bbsConnections;
    const ws6 = new FakeWS();
    wss.emit('connection', ws6, { socket: { remoteAddress: 'test6' } });
    ws6.emit('message', Buffer.from(JSON.stringify({
      type: 'dial', host: '127.0.0.1', port: 2323, link: 'direct',  // not in the directory
    })), false);

    setTimeout(() => {
      ok(bbsConnections === before, 'an unlisted board is never dialled',
         `${bbsConnections - before} connection(s) reached the BBS`);
      ok(!ws6.json.some((m) => m.type === 'connected'), 'and no link comes up');
      ok(ws6.json.some((m) => m.type === 'closed' && m.reason === 'direct-not-listed'),
         'the session is closed with the reason named',
         JSON.stringify(ws6.json));
      // The modem path is deliberately NOT gated — its own handshake is the
      // throttle, and a hand-typed host at 300 bps is not an abuse vector.
      const ws7 = new FakeWS();
      wss.emit('connection', ws7, { socket: { remoteAddress: 'test7' } });
      ws7.emit('message', Buffer.from(JSON.stringify({
        type: 'dial', host: '127.0.0.1', port: 2323, protocol: 'V22bis',
      })), false);
      setTimeout(() => {
        ok(ws7.json.some((m) => m.type === 'status' && /answering modem/.test(m.text)),
           'a modem dial to the same unlisted board is still accepted');
        portPolicy();
      }, 200);
    }, 200);
  }

  // The port policy: on a host the directory does NOT offer, port 23 and
  // anything from 1024 up, and nothing else. One clause covers the whole
  // well-known range without keeping a copy of /etc/services, and it is the
  // right shape because a board avoids low ports precisely so it need not run as
  // root. A LISTED board is exempt — some answer on 80 or 443 to get through a
  // restrictive firewall.
  function portPolicy() {
    console.log('\n── port policy on unlisted hosts');
    const before = bbsConnections;
    let done = 0;
    const dial = (tag, port, expectDialled, what) => {
      const w = new FakeWS();
      wss.emit('connection', w, { socket: { remoteAddress: tag } });
      w.emit('message', Buffer.from(JSON.stringify({
        type: 'dial', host: '127.0.0.1', port, link: 'direct',
      })), false);
      setTimeout(() => {
        const refused = w.json.some((m) => m.type === 'busy' && m.reason === 'port-not-allowed');
        ok(expectDialled ? !refused : refused, what, JSON.stringify(w.json));
        if (++done === 3) {
          ok(bbsConnections === before, 'and nothing on a refused port was ever dialled',
             `${bbsConnections - before} connection(s) reached the BBS`);
          bypassThrottle();
        }
      }, 200);
    };
    dial('port-smtp', 25,   false, 'port 25 on an unlisted host is refused');
    dial('port-http', 80,   false, 'port 80 on an unlisted host is refused');
    dial('port-redis', 6379, false, 'a blocked service port above 1024 is refused');
  }

  // Gate 2: one bypass dial SERVER-WIDE per interval, applied as a DELAY and
  // never announced. Two dials back to back; the second must reach the board a
  // full interval after the first.
  //
  // The two come from DIFFERENT addresses on purpose. That is the assertion: a
  // per-client limiter is what a rotating source defeats, so this one is global
  // and two unrelated visitors share the interval. Driving both from one address
  // would pass either way and prove nothing.
  function bypassThrottle() {
    console.log('\n── telnet bypass: one dial server-wide per interval');
    const dial = (ws) => ws.emit('message', Buffer.from(JSON.stringify({
      type: 'dial', host: '127.0.0.1', port: bbsPort, link: 'direct',
    })), false);

    const a = new FakeWS(), b = new FakeWS();
    wss.emit('connection', a, { socket: { remoteAddress: 'visitor-one' } });
    wss.emit('connection', b, { socket: { remoteAddress: 'visitor-two' } });
    dial(a); dial(b);

    setTimeout(() => {
      const conns = ws1Connected(a) + ws1Connected(b);
      ok(conns === 2, 'both dials do eventually connect — this delays, never refuses',
         `${conns} of 2 connected`);
      // The second connect, not the first: the interval is measured from the
      // dial that was allowed through immediately.
      const gap = lastConnectTimes(2);
      ok(gap >= THROTTLE_S * 1000 * 0.8,
         `a second visitor's dial waits out the interval too (+${gap}ms)`,
         `only ${gap}ms apart; expected about ${THROTTLE_S * 1000}ms`);
      ok(!a.json.concat(b.json).some((m) => /wait|slow|limit|too (many|fast)/i.test(m.text || '')),
         'and nothing tells the client it was throttled');
      fullModemCall();
    }, THROTTLE_S * 1000 + 700);

    function ws1Connected(w) { return w.json.some((m) => m.type === 'connected') ? 1 : 0; }
    function lastConnectTimes(n) {
      const t = bbsConnectTimes.slice(-n);
      return t.length === n ? t[n - 1] - t[0] : -1;
    }
  }

  // The only place the whole ordering is proven with a REAL carrier: a genuine
  // originate ModemDSP wired to the fake socket, exactly as the browser is.
  // Proves carrier → TCP connect → negotiate → banner, in that order.
  function fullModemCall() {
    console.log('\n── full modem call (real carrier through server.js)');
    const { ModemDSP } = require('../../vendor/src/dsp/ModemDSP');
    const connectionsBefore = bbsConnections;
    const ws5 = new FakeWS();
    wss.emit('connection', ws5, { socket: { remoteAddress: 'test5' } });

    // The server sets the shared config singleton while handling this message,
    // so the originate DSP must be constructed after it.
    ws5.emit('message', Buffer.from(JSON.stringify({
      type: 'dial', host: '127.0.0.1', port: bbsPort, protocol: 'V32bis',
    })), false);

    const dialAt = Date.now();
    const A = new ModemDSP('originate');
    const rx = [];
    let carrierAt = 0;

    ws5.onBinary = (buf) => {                    // server TX audio → browser RX
      const n = buf.length >> 1, f = new Float32Array(n);
      for (let i = 0; i < n; i++) f[i] = buf.readInt16LE(i * 2) / 32768;
      A.receiveAudio(f);
    };
    A.on('audioOut', (f32) => {                  // browser TX audio → server RX
      const b = Buffer.allocUnsafe(f32.length * 2);
      for (let i = 0; i < f32.length; i++) {
        b.writeInt16LE((Math.max(-1, Math.min(1, f32[i])) * 32767) | 0, i * 2);
      }
      ws5.emit('message', b, true);
    });
    A.on('connected', () => { carrierAt = Date.now(); });
    A.on('data', (d) => { for (const b of d) rx.push(b); });
    A.start();

    const deadline = Date.now() + 20000;
    const iv = setInterval(() => {
      const got = Buffer.from(rx).toString('latin1');
      if (got.includes('Mock BBS') || Date.now() > deadline) {
        clearInterval(iv);
        try { A.stop(); } catch (_) {}

        ok(carrierAt > 0, 'carrier trained through the fake socket');
        ok(bbsConnections === connectionsBefore + 1,
           'the BBS was dialled exactly once',
           `${bbsConnections - connectionsBefore} connection(s)`);
        // The real proof of deferral: the dial landed a whole handshake after
        // the call began, not in the first milliseconds. (Note the server's
        // carrier fires slightly BEFORE the originate's, so comparing against
        // the client's own carrier event would be a false negative.)
        const dialDelay = bbsConnectTimes[bbsConnectTimes.length - 1] - dialAt;
        ok(dialDelay > 500,
           `the BBS was dialled only after the handshake (+${dialDelay}ms)`,
           `dialled just ${dialDelay}ms after the call started — not deferred`);
        ok(got.includes('Welcome to Mock BBS!'),
           'banner arrives demodulated, after the deferred connect',
           JSON.stringify(got.slice(0, 80)));
        ok(!got.includes('\xFF'), 'still no IAC bytes over the modem link');

        perBoardCap();
      }
    }, 100);
  }

  // The per-board concurrency cap: no more than N connections to any one
  // destination, server-wide, keyed on the RESOLVED address and port. This is
  // the limit that protects the BOARDS rather than this server, and it is the
  // only one a real visitor can meet — so unlike the bypass interval it SPEAKS,
  // and the client answers it with the same reorder tone every other failed
  // connect gets.
  function perBoardCap() {
    console.log('\n── per-board concurrency cap');
    // Its OWN board, on its own port. The mock BBS above is already carrying the
    // calls the earlier sections left up, and those hold real slots — the cap is
    // per destination, so a test of it needs a destination at a known count of
    // zero rather than one it has to guess the baseline of.
    const quiet = net.createServer((c) => c.write('quiet board\r\n'));
    quiet.listen(0, '127.0.0.1', () => {
      const port = quiet.address().port;
      fakeDir.curated.push({ name: 'Quiet BBS', host: '127.0.0.1', port });
      runCap(port, () => quiet.close());
    });
  }

  function runCap(bbsPort, done) {
    siteOverrides.maxPerBoardConcurrent = 2;
    siteOverrides.directMinIntervalSeconds = 0;      // pacing is not what is under test
    const socks = [];
    const dial = (tag) => {
      const w = new FakeWS();
      socks.push(w);
      wss.emit('connection', w, { socket: { remoteAddress: tag } });
      w.emit('message', Buffer.from(JSON.stringify({
        type: 'dial', host: '127.0.0.1', port: bbsPort, link: 'direct',
      })), false);
      return w;
    };
    const a = dial('board-1'), b = dial('board-2'), c = dial('board-3');

    setTimeout(() => {
      const up = (w) => w.json.some((m) => m.type === 'connected');
      const busy = (w) => w.json.some((m) => m.type === 'busy' && m.reason === 'board-busy');
      ok(up(a) && up(b), 'callers up to the cap connect normally',
         JSON.stringify([a.json, b.json]));
      ok(busy(c), 'the one past it is refused', JSON.stringify(c.json));
      ok(!up(c), 'and never reaches the board');
      // The refusal must be the SAME message every other failure sends: a
      // distinct one here would tell a caller which boards are busy from here,
      // which is the oracle the uniform answer exists to close.
      ok(!c.json.some((m) => /limit|cap|concurrent|busy board/i.test(m.text || '')),
         'with nothing that names the limit');

      // A slot comes back when a call ends, or the cap is a one-way ratchet.
      a.emit('close');
      setTimeout(() => {
        const d = dial('board-4');
        setTimeout(() => {
          ok(d.json.some((m) => m.type === 'connected'),
             'and a slot is released when a call ends', JSON.stringify(d.json));
          for (const w of socks.concat([d])) { try { w.emit('close'); } catch (_) {} }
          if (done) done();
          rateCap();
        }, 400);
      }, 200);
    }, 600);
  }

  // The bypass RATE cap, through the real session code. lib/throttle.js's own
  // suite (throttletest.js) proves the pacer on a clock it owns; what is left
  // to prove here is the wiring, and there are only two claims worth making
  // about it.
  //
  // The first is that the payload survives. A rate limiter in a BBS session is
  // only acceptable if it delays — a dropped byte is a corrupted screen, and
  // the corruption would look like a telnet bug rather than like this.
  //
  // The second is that it actually delays, in BOTH directions. The cap is
  // turned right down for the section so the delay is a fraction of a second
  // rather than the eight seconds the shipped 128 kbps would take on a payload
  // this size; the ratio is what is asserted, not the wall clock.
  //
  // Note what is NOT asserted: any message to the client. The cap is silent by
  // design, exactly as the dial interval is — see the note on the gates above.
  function rateCap() {
    console.log('\n── telnet bypass: the rate cap');
    const SIZE = 24 * 1024;
    const BPS = 96000;                          // 12000 B/s, so SIZE takes ~2 s
    // A counter, so a lost or reordered middle fails on CONTENT rather than on
    // length alone — mod 251 rather than mod 256 because telnet terminates at
    // the server and an 0xFF in the payload is an IAC, not a byte. That is the
    // filter working, and a test payload that trips it would be measuring the
    // wrong thing in both directions.
    const blob = Buffer.alloc(SIZE);
    for (let i = 0; i < SIZE; i++) blob[i] = i % 251;

    const fromLoud = [];
    const loud = net.createServer((c) => {
      c.on('data', (d) => fromLoud.push(d));
      c.write(blob);                            // the ANSI "movie" case, in one write
    });
    loud.listen(0, '127.0.0.1', () => {
      const port = loud.address().port;
      fakeDir.curated.push({ name: 'Loud BBS', host: '127.0.0.1', port });
      siteOverrides.maxPerBoardConcurrent = 0;
      siteOverrides.directMinIntervalSeconds = 0;
      siteOverrides.directMaxBitsPerSecond = BPS;

      const w = new FakeWS();
      wss.emit('connection', w, { socket: { remoteAddress: 'rate-1' } });
      w.emit('message', Buffer.from(JSON.stringify({
        type: 'dial', host: '127.0.0.1', port, link: 'direct',
      })), false);

      const got = () => w.binary.reduce((n, b) => n + b.length, 0);
      // Early enough that an unpaced link would have delivered all of it — the
      // whole blob crosses loopback in a millisecond — and late enough that a
      // paced one has delivered a real fraction.
      setTimeout(() => {
        const part = got();
        ok(part > 0, 'downstream starts immediately rather than waiting out the queue',
           `${part} bytes at 400 ms`);
        ok(part < SIZE, 'and a 24 KB burst is NOT delivered at loopback speed',
           `${part} of ${SIZE} bytes had arrived at 400 ms`);

        // The client sends the same volume back the other way, to show the
        // upstream is capped too. A human cannot type this fast; a paste, an
        // upload and a hostile client all can.
        // Everything the board has received SO FAR is the client's negotiation
        // block, which is not payload and must not be counted as any of it.
        const negotiated = fromLoud.reduce((n, b) => n + b.length, 0);
        w.emit('message', blob, true);
        setTimeout(() => {
          const upPart = fromLoud.reduce((n, b) => n + b.length, 0) - negotiated;
          ok(upPart > 0 && upPart < SIZE, 'the upstream is capped as well, not just the board',
             `${upPart} of ${SIZE} bytes had reached the BBS at 400 ms`);

          // Now let both run to completion. Nothing may be missing and nothing
          // may be out of order, in either direction.
          setTimeout(() => {
            const down = Buffer.concat(w.binary);
            const up = Buffer.concat(fromLoud).subarray(negotiated);
            ok(down.length === SIZE, 'every downstream byte arrives, given time',
               `${down.length} of ${SIZE}`);
            ok(down.equals(blob), 'byte-for-byte and in order');
            ok(up.length === SIZE, 'and every upstream byte reaches the BBS',
               `${up.length} of ${SIZE}`);
            ok(up.equals(blob), 'byte-for-byte and in order');
            ok(!w.json.some((m) => /rate|throttl|slow|limit/i.test(m.text || '')),
               'and the client is never told it is being paced');
            try { w.emit('close'); } catch (_) {}
            loud.close();
            delete siteOverrides.directMaxBitsPerSecond;
            liveRegistry();
          }, 5000);
        }, 400);
      }, 400);
    });
  }

  // The live session registry, seen the only way it is ever read: through
  // /sysop.json, with a real call in progress.
  //
  // It is asserted HERE rather than in sysoptest.js because this is the only
  // harness that can put a call on the wire — the registry's whole job is to
  // describe a session, and a suite with no sessions can only check that the
  // list is empty. The BBS NAME is the half worth pinning: the address comes
  // straight off the dial, but the name is a lookup that can silently start
  // returning nothing, and a dashboard of unnamed addresses would look like a
  // directory problem rather than a broken join.
  function liveRegistry() {
    console.log('\n── the live session registry, through /sysop.json');
    const sysop = require('../../lib/sysop');
    // Enabling it here rather than in the operator's config, the same way every
    // other limit in this file is set. The password never leaves this process.
    const PW = 'directtest-only-password';
    Object.assign(siteOverrides, {
      // The section above leaves its per-board cap in force, and the sections
      // before that leave live calls to the mock BBS open on purpose — so this
      // call is refused at the limit unless the cap is lifted first. That is the
      // limit working; it is not what this section is about.
      maxPerBoardConcurrent: 0,
      sysopEnabled: true, sysopUser: 'sysop',
      sysopPasswordHash: sysop.hashPassword(PW),
      sysopRefreshSeconds: 5,
    });
    sysop.forget();

    const w = new FakeWS();
    wss.emit('connection', w, { socket: { remoteAddress: '203.0.113.9' } });
    w.emit('message', Buffer.from(JSON.stringify({
      type: 'dial', host: '127.0.0.1', port: bbsPort, link: 'direct',
    })), false);

    setTimeout(() => {
      const auth = 'Basic ' + Buffer.from(`sysop:${PW}`).toString('base64');
      require('http').get(
        { host: '127.0.0.1', port: HTTP_PORT, path: '/sysop.json', headers: { Authorization: auth } },
        (res) => {
          let body = '';
          res.on('data', (c) => { body += c; });
          res.on('end', () => {
            let d = null;
            try { d = JSON.parse(body); } catch (_) {}
            ok(d !== null, `/sysop.json answered (${res.statusCode})`, body.slice(0, 120));
            const call = d && d.calls.find((c) => c.ip === '203.0.113.9');
            ok(!!call, 'the call in progress is in the registry',
               JSON.stringify(d && d.calls));
            if (call) {
              ok(call.host === '127.0.0.1' && call.port === bbsPort,
                 'the address is exactly what was dialled');
              ok(call.name === 'Mock BBS',
                 'and the directory NAME is resolved beside it', JSON.stringify(call.name));
              ok(call.tier === 'curated', 'with the tier it came from');
              ok(call.direct === true, 'telnet bypass is shown as bypass, not as a modem speed');
              ok(call.state === 'carrier', `state is carrier (${call.state})`);
              ok(call.linkSec >= 0 && call.openedSec >= 0,
                 'session length is measured from CARRIER, with the socket age beside it');
              ok(call.bytes && call.bytes.telnetIn > 0,
                 'the byte totals are the live ones — the banner is already counted',
                 JSON.stringify(call.bytes));
            }
            // A session that ends leaves the registry, or the page grows for ever.
            w.emit('close');
            setTimeout(() => {
              require('http').get(
                { host: '127.0.0.1', port: HTTP_PORT, path: '/sysop.json',
                  headers: { Authorization: auth } },
                (r2) => {
                  let b2 = '';
                  r2.on('data', (c) => { b2 += c; });
                  r2.on('end', () => {
                    let d2 = null;
                    try { d2 = JSON.parse(b2); } catch (_) {}
                    ok(d2 && !d2.calls.some((c) => c.ip === '203.0.113.9'),
                       'and it is gone from the registry once the socket closes');
                    sessionCap();
                  });
                });
            }, 100);
          });
        }).on('error', (e) => { ok(false, 'GET /sysop.json', String(e)); sessionCap(); });
      // Long enough to clear the bypass gate. This is a telnet-bypass dial, so
      // it is held for up to THROTTLE_S server-wide before it connects — a
      // shorter wait here reads the registry mid-dial and asserts 'dialing',
      // which is the gate working rather than the registry failing.
    }, THROTTLE_S * 1000 + 400);
  }

  // The server-wide session ceiling. Every dialled session owns a software modem
  // and a 5 ms transmit timer, so this is what bounds the cost of a flood.
  //
  // Asserted RELATIVELY — open sockets until one is refused — because earlier
  // sections in this file have already opened some and the absolute count is not
  // this test's business.
  function sessionCap() {
    console.log('\n── server-wide session ceiling');
    // Close every call this file has opened, so the count starts from zero. The
    // earlier sections leave live sessions behind on purpose — that is what a
    // browser tab does — and a ceiling test that had to guess how many would be
    // asserting arithmetic rather than behaviour.
    for (const w of allSockets.slice()) { try { w.emit('close'); } catch (_) {} }

    const CAP = 3;
    siteOverrides.maxSessions = CAP;
    const opened = [];
    for (let i = 0; i < CAP; i++) {
      const w = new FakeWS();
      wss.emit('connection', w, { socket: { remoteAddress: `flood-${i}` } });
      opened.push(w);
    }
    ok(opened.every((w) => w.readyState !== 3), 'sessions up to the ceiling are accepted',
       opened.map((w) => w.readyState).join(','));

    const refused = new FakeWS();
    wss.emit('connection', refused, { socket: { remoteAddress: 'one-too-many' } });
    ok(refused.readyState === 3, 'the one past it is refused rather than accepted');
    ok(refused.json.some((m) => m.type === 'status' && /busy/i.test(m.text || '')),
       'and is told the server is busy rather than dropped silently',
       JSON.stringify(refused.json));

    // Refusing forever would be worse than the flood it prevents.
    opened[0].emit('close');
    const after = new FakeWS();
    wss.emit('connection', after, { socket: { remoteAddress: 'after-close' } });
    ok(after.readyState !== 3, 'and closing a session frees a slot again');

    console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
  }
});

// Both telnet-bypass gates are a configuration value and a directory lookup, so
// the harness supplies both rather than editing the operator's files:
// config/site.json and config/curated.txt belong to whoever is running this, and
// a harness that dies mid-run must not leave them rewritten (CLAUDE.md names
// that trap for logtest and sitetest). The two modules are WRAPPED, not
// replaced — everything server.js uses is the real implementation except the
// two answers this test has to control.
function requireServerAndGetWSS(bbsPort) {
  const before = FakeWSS.prototype;   // identity check only
  let instance = null;
  const OrigCtor = FakeWSS;
  // Capture the instance server.js constructs.
  const Patched = new Proxy(OrigCtor, {
    construct(target, args) { instance = new target(...args); return instance; },
  });
  const realList = require('../../lib/bbslist');
  const realSite = require('../../lib/site');
  // The mock BBS and the dead port 1 are BOTH listed: the proxyError case is
  // about a board that does not answer, not one the directory refuses, and
  // conflating the two would leave the refusal untested and the failure path
  // only apparently covered.
  fakeDir = {
    curated: [{ name: 'Mock BBS', host: '127.0.0.1', port: bbsPort },
              { name: 'Dead BBS', host: '127.0.0.1', port: 1 }],
    guide: [], guideFile: null, guideFetched: null, guideSource: '',
  };
  Module._load = function (request, ...rest) {
    if (request === 'ws') return { WebSocketServer: Patched };
    if (request === './lib/bbslist') return { ...realList, directory: () => ({ ...fakeDir }) };
    if (request === './lib/site') {
      return { ...realSite,
               config: () => ({ ...realSite.config(),
                                directMinIntervalSeconds: THROTTLE_S,
                                ...siteOverrides }) };
    }
    return origLoad.call(this, request, ...rest);
  };
  require('../../server.js');
  if (!instance || Object.getPrototypeOf(instance) !== before) throw new Error('WSS not captured');
  return instance;
}
