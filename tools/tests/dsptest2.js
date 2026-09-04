'use strict';
// Full-stack in-process regression: two real ModemDSP instances wired
// audio<->audio (originate<->answer, exactly as browser<->server), with a
// line-buffering mock BBS on the answer side. Tests the real Handshake +
// ModemDSP pump + protocol DSP end-to-end, no sockets.
const config = require('../../vendor/synthlink-config');
const { ModemDSP } = require('../../vendor/src/dsp/ModemDSP');

const BANNER = Buffer.from(
  '\x1b[2J\x1b[H  +======================================+\r\n' +
  '  |  SYNTHLINK TEST BBS                  |\r\n' +
  '  +======================================+\r\n' +
  'Type anything; I echo it.\r\nBBS> ', 'latin1');

function jitterDeliver(dst, f32) {
  let o = 0;
  while (o < f32.length) { const n = 1 + Math.floor(Math.random() * 60); dst.receiveAudio(f32.subarray(o, Math.min(f32.length, o + n))); o += n; }
}

function testProto(PROTO, seconds) {
  return new Promise((resolve) => {
    config.modem.native.protocolPreference = [PROTO];
    config.modem.native.v8ModulationModes  = [PROTO];
    const A = new ModemDSP('originate');   // browser
    const B = new ModemDSP('answer');      // server + mock BBS
    const rxA = []; let upA = false, upB = false, done = false;
    let line = '';
    const t0 = Date.now();

    A.on('audioOut', f => jitterDeliver(B, f));
    B.on('audioOut', f => jitterDeliver(A, f));

    // Type only once BOTH ends are in data mode. The two do not arrive together:
    // when V.8 no-deals and each side falls back on its own timeout they can be
    // seconds apart, and anything sent in that window goes into a half-open link
    // and is lost. A person typing in a browser never sees this.
    let typed = false;
    const typeWhenBothUp = () => {
      if (typed || !upA || !upB) return;
      typed = true;
      setTimeout(() => { if (!done) A.write(Buffer.from('hi\r')); }, 1200);
    };
    A.on('connected', () => { upA = true; typeWhenBothUp(); });
    B.on('connected', () => { upB = true; B.write(BANNER); typeWhenBothUp(); });
    B.on('data', d => {                    // line-buffered echo, like echo-bbs.js
      for (const b of d) {
        if (b === 0x0d || b === 0x0a) { B.write(Buffer.from('\r\nyou said: ' + line + '\r\nBBS> ', 'latin1')); line = ''; }
        else if (b >= 0x20) line += String.fromCharCode(b);
      }
    });
    A.on('data', d => { for (const x of d) rxA.push(x); });

    const strip = () => Buffer.from(rxA).toString('latin1').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    const finish = (ok, why) => {
      if (done) return; done = true;
      try { A.stop(); B.stop(); } catch (_) {}
      const s = strip();
      resolve({ PROTO, ok, why, upA, upB, banner: /SYNTHLINK TEST BBS/.test(s), echo: /you said: hi/.test(s), rxlen: rxA.length, ms: Date.now() - t0 });
    };

    A.start(); B.start();
    const iv = setInterval(() => {
      const s = strip();
      if (/SYNTHLINK TEST BBS/.test(s) && /you said: hi/.test(s)) { clearInterval(iv); finish(true, 'banner+echo'); }
    }, 100);
    setTimeout(() => { clearInterval(iv); finish(false, upA && upB ? 'incomplete' : 'no-connect'); }, seconds * 1000);
  });
}

// The budget is a property of the protocol's bit rate, not a preference: the
// banner plus the echo is ~220 bytes, which at 300 bps cannot arrive in under
// ~13 s however healthy the link. SECS still overrides for a deliberate squeeze.
// A generous budget costs nothing on a pass — the run ends as soon as the echo
// lands — so these are ceilings sized to the rate, not expected durations.
const BUDGET = { Bell103: 25, V21: 25, V23: 15, V22: 15 };
const budgetFor = p => parseInt(process.env.SECS || String(BUDGET[p] || 6), 10);

(async () => {
  const list = (process.env.ONLY || 'V29').split(',');
  for (const p of list) {
    const r = await testProto(p, budgetFor(p));
    console.log(`RESULT(${r.PROTO}): ${r.ok ? 'PASS ✅' : 'FAIL ❌ ' + r.why}` +
      `  connect[A=${r.upA} B=${r.upB}] banner=${r.banner} echo=${r.echo} rx=${r.rxlen}B ${r.ms}ms`);
  }
  process.exit(0);
})();
