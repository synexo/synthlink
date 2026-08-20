'use strict';
/**
 * tools/directtest.js — end-to-end test of Telnet direct (modem-bypass) mode.
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
 *   4. an unreachable board reports proxyError,
 *   5. a full V.32bis call through server.js with a real originate ModemDSP.
 *
 *   node tools/directtest.js
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

process.env.BBSLIST_UPDATE = '0';                       // no outbound update traffic
process.env.PORT = String(20000 + (process.pid % 10000)); // static server only; never connected to

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
class FakeWS extends EventEmitter {
  constructor() { super(); this.OPEN = 1; this.readyState = 1; this.binary = []; this.json = []; this.onBinary = null; }
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
  const wss = requireServerAndGetWSS();
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
      proxyError();
    }, 500);
  }

  // Deferring the connect means failures land after the handshake, so they must
  // be reported explicitly rather than as a bare NO CARRIER.
  function proxyError() {
    const ws4 = new FakeWS();
    wss.emit('connection', ws4, { socket: { remoteAddress: 'test4' } });
    // Port 1 on loopback: nothing listens, connection refused immediately.
    ws4.emit('message', Buffer.from(JSON.stringify({
      type: 'dial', host: '127.0.0.1', port: 1, link: 'direct',
    })), false);

    setTimeout(() => {
      console.log('\n── unreachable BBS');
      const err = ws4.json.find((m) => m.type === 'proxyError');
      ok(!!err, 'server reports proxyError when the BBS cannot be reached',
         JSON.stringify(ws4.json));
      ok(!ws4.json.some((m) => m.type === 'connected'),
         'no connected message for a failed dial');

      fullModemCall();
    }, 300);
  }

  // The only place the whole ordering is proven with a REAL carrier: a genuine
  // originate ModemDSP wired to the fake socket, exactly as the browser is.
  // Proves carrier → TCP connect → negotiate → banner, in that order.
  function fullModemCall() {
    console.log('\n── full modem call (real carrier through server.js)');
    const { ModemDSP } = require('../vendor/src/dsp/ModemDSP');
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

        console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
        process.exit(fail === 0 ? 0 : 1);
      }
    }, 100);
  }
});

function requireServerAndGetWSS() {
  const before = FakeWSS.prototype;   // identity check only
  let instance = null;
  const OrigCtor = FakeWSS;
  // Capture the instance server.js constructs.
  const Patched = new Proxy(OrigCtor, {
    construct(target, args) { instance = new target(...args); return instance; },
  });
  Module._load = function (request, ...rest) {
    if (request === 'ws') return { WebSocketServer: Patched };
    return origLoad.call(this, request, ...rest);
  };
  require('../server.js');
  if (!instance || Object.getPrototypeOf(instance) !== before) throw new Error('WSS not captured');
  return instance;
}
