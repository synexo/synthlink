'use strict';
// Full-stack in-process regression: two real ModemDSP instances wired
// audio<->audio (originate<->answer, exactly as browser<->server), with a
// line-buffering mock BBS on the answer side. Tests the real Handshake +
// ModemDSP pump + protocol DSP end-to-end, no sockets.
const config = require('/home/claude/synthlink/vendor/synthlink-config');
const { ModemDSP } = require('/home/claude/synthlink/vendor/src/dsp/ModemDSP');

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

    A.on('connected', () => { upA = true; setTimeout(() => { if (!done) A.write(Buffer.from('hi\r')); }, 1200); });
    B.on('connected', () => { upB = true; B.write(BANNER); });
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

(async () => {
  const list = (process.env.ONLY || 'V29').split(',');
  for (const p of list) {
    const r = await testProto(p, parseInt(process.env.SECS||"6",10));
    console.log(`RESULT(${r.PROTO}): ${r.ok ? 'PASS ✅' : 'FAIL ❌ ' + r.why}` +
      `  connect[A=${r.upA} B=${r.upB}] banner=${r.banner} echo=${r.echo} rx=${r.rxlen}B ${r.ms}ms`);
  }
  process.exit(0);
})();
