#!/usr/bin/env node
'use strict';
// tools/tests/bm-fsk.js — the 300 bit/s FSK protocols against BinModem, whole
// calls, both roles: Bell 103 (no V.8 — Table 2/V.8 has no bit for it) and V.21
// (V.8 first, offering only V.21).
//
//   node tools/tests/bm-fsk.js
//
// DEVELOPMENT ONLY, and SKIPs cleanly — not counted as a pass — when the Rust
// peer is not built (cargo build --release --manifest-path tools/bridge/Cargo.toml).
//
// Runs in REAL TIME (about a minute): Handshake.js ends FSK training on a
// setTimeout, which a faster-than-real-time lockstep would outrun.
//
// The case this exists for: BinModem's V.21 answerer sends a V.25 answer tone
// before its mark, even after V.8, and a caller that took that 2100 Hz tone for
// carrier — the high channel's space filter at 1850 Hz passes it — declared data
// three seconds early and sent into it. V21.farEndIdle (200 ms of mark) is what
// the handshake now waits for. Each assertion is a FLOOR: raise it, never lower it.

const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const { available, call, wholeModem } = require(path.join(ROOT, 'tools', 'bridge', 'peer'));

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log(`  ok   ${msg}`); } else { fail++; console.log(`  FAIL ${msg}`); } }

const TO_BM = 'SYNTHLINK SAYS HI 0123456789\r\n';
const TO_SL = 'BINMODEM SAYS HI 0123456789\r\n';

async function main() {
  const av = available();
  if (!av.ok) { console.log(`SKIP bm-fsk: ${av.reason}`); process.exit(0); }

  for (const [proto, peer] of [['Bell103', 'bell103'], ['V21', 'v21']]) {
    for (const [label, role] of [['SynthLink calls, BinModem answers', 'originate'],
                                 ['BinModem calls, SynthLink answers', 'answer']]) {
      console.log(`\n[${proto}] ${label}`);
      const res = await call({
        synth: wholeModem(role, proto), realtime: true, secs: 14, send: TO_BM,
        // A second's wait after each end connects, as a person at a terminal
        // gives. Without SynthLink's, its text raced BinModem's V.21 answerer:
        // that connects on 200 ms of our idle mark counted from its own mark, and
        // we go ready on 200 ms of ITS mark from the same instant, so a start bit
        // sent at ready landed inside its count one run in two and the text went
        // by before it connected.
        sendDelay: 1,
        peer: ['--proto', peer, '--role', role === 'originate' ? 'answer' : 'call', '--send', TO_SL, '--send-delay', '1'],
      });
      if (proto === 'V21') {
        const notes = res.bm.filter(e => e.ev === 'note').map(e => e.text);
        ok(notes.some(n => /V\.8 agreed V21/.test(n)), 'V.8: BinModem agreed V.21 with our CM/JM');
      }
      ok(!!res.bmConnected, `BinModem connected — ${res.bmConnected ? res.bmConnected.status : 'no'}`);
      ok(!!res.slReady, 'SynthLink connected');
      // Calling up the link while the far end is still in its answer tone sends
      // the first characters into it; BinModem's own connect is the reference.
      ok(res.slReady && res.bmConnected && res.slReady.t >= res.bmConnected.t - 0.5,
         `SynthLink did not call the link up before BinModem was on its mark (SL ${res.slReady && res.slReady.t}s, BM ${res.bmConnected && res.bmConnected.t}s)`);
      ok(res.bmRx.toString('latin1') === TO_BM, `BinModem received our text exactly, nothing before it or after — ${JSON.stringify(res.bmRx.toString('latin1').slice(0, 50))}`);
      ok(res.slRx.toString('latin1') === TO_SL, 'we received BinModem\'s text exactly');
    }
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
