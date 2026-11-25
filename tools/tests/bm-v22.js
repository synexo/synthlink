#!/usr/bin/env node
'use strict';
// tools/tests/bm-v22.js — whole calls, V.8 first, against BinModem: V.22bis and
// V.22, each in both roles.
//
//   node tools/tests/bm-v22.js
//
// DEVELOPMENT ONLY, and SKIPs cleanly — not counted as a pass — when the Rust
// peer is not built (cargo build --release --manifest-path tools/bridge/Cargo.toml).
//
// SynthLink here is a whole ModemDSP — V.8, then the protocol — and BinModem is
// its V.8 offering only the V.22/V.22bis bit, then V.22bis's §6.3.1.1 handshake.
// The ANSWER role is synthmodem's, and hardware has seen it; the CALLING role is
// this repo's, and until this harness only SynthLink had: its §6.3.1.1.1 procedure
// did not exist (a "caller-lead" stand-in sent S1 on any carrier, inside the far
// end's answer tone), so a real answerer settled at 1200 and the caller's
// receiver, trained on that answer tone, decoded nothing.
//
// Each section asserts a FLOOR: raise it, never lower it.

const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const { available, call, wholeModem, bmPhases } = require(path.join(ROOT, 'tools', 'bridge', 'peer'));

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log(`  ok   ${msg}`); } else { fail++; console.log(`  FAIL ${msg}`); } }

const TO_BM = 'SYNTHLINK SAYS HI 0123456789\r\n';
const TO_SL = 'BINMODEM SAYS HI 0123456789\r\n';

async function run(role, proto, peerExtra = [], line = {}) {
  const synth = wholeModem(role, proto);
  return call({
    synth, secs: 14, send: TO_BM, ...line,
    // Both ends doing V.42, as two real modems of the period would: BinModem's own
    // stack over its pump (bmpeer --v42), ours over ours.
    peer: ['--proto', proto.toLowerCase(), '--role', role === 'originate' ? 'answer' : 'call', '--send', TO_SL, '--v42', 'both', ...peerExtra],
  });
}

async function main() {
  const av = available();
  if (!av.ok) { console.log(`SKIP bm-v22: ${av.reason}`); process.exit(0); }

  for (const [label, role] of [['SynthLink calls, BinModem answers', 'originate'],
                               ['BinModem calls, SynthLink answers', 'answer']]) {
    console.log(`\n[V.22bis] ${label}`);
    const res = await run(role, 'V22bis');
    const notes = res.bm.filter(e => e.ev === 'note').map(e => e.text);
    const bm = bmPhases(res);
    ok(notes.some(n => /V\.8 agreed V22bis/.test(n)), 'V.8: BinModem agreed V.22bis with our CM/JM (Phase 1)');
    // §6.3.1.1.2 b) / §6.3.1.1.1 c): the double dibit each way is what makes 2400.
    ok(bm.includes('V.22bis rising to 2400') || bm.includes('V.22bis offering 2400'),
       'BinModem heard our S1 and offered or rose to 2400');
    ok(res.bmConnected && /Bps2400/.test(res.bmConnected.status),
       `BinModem connected at 2400 — ${res.bmConnected ? res.bmConnected.status : 'no'}`);
    ok(res.slReady && res.slReady.info.bps === 2400, `SynthLink connected at 2400 — ${res.slReady ? res.slReady.info.bps : 'no'}`);
    ok(res.slReady && res.slReady.info.errorControl === 'LAPM' && res.slReady.info.compression === 'V.44' && notes.includes('V.42: LAPM compression=V.44'),
       `V.42 with V.44 at both ends — ${res.slReady ? `${res.slReady.info.errorControl}/${res.slReady.info.compression}` : 'no'}, ${notes.filter((n) => n.startsWith('V.42')).join(', ')}`);
    ok(res.bmRx.toString('latin1') === TO_BM, 'BinModem received our text exactly, nothing before it or after');
    ok(res.slRx.toString('latin1') === TO_SL,
       `we received BinModem's text exactly, first character included — ${JSON.stringify(res.slRx.toString('latin1').slice(0, 40))}`);
  }

  // V.22 (1200 only, the separate V22 class). BinModem's text waits a second after
  // it connects: at 1200 BinModem connects as soon as it has heard 270 ms of
  // scrambled ones, skipping the 765 ms §6.3.1.2.1 d) and §6.3.1.2.2 c) put between
  // that and data, so its first byte can reach a receiver that is, by the clause,
  // not yet ready. That is BinModem's deviation, and the wait is what a conformant
  // far end's timing would give.
  for (const [label, role] of [['SynthLink calls, BinModem answers', 'originate'],
                               ['BinModem calls, SynthLink answers', 'answer']]) {
    console.log(`\n[V.22] ${label}`);
    // And for V.42, the same deviation started BinModem's answering stack that
    // much early, so its one T400 ran out before our ODP could arrive at the
    // clause's time: --v42-late is BinModem's own allowance for a far end whose
    // data mode begins after its own.
    const res = await run(role, 'V22', ['--send-delay', '1', ...(role === 'originate' ? ['--v42-late'] : [])]);
    const notes = res.bm.filter(e => e.ev === 'note').map(e => e.text);
    ok(notes.some(n => /V\.8 agreed V22bis/.test(n)), 'V.8: BinModem agreed the V.22/V.22bis bit');
    ok(res.bmConnected && /Bps1200/.test(res.bmConnected.status),
       `BinModem connected at 1200 — ${res.bmConnected ? res.bmConnected.status : 'no'}`);
    ok(res.slReady && res.slReady.info.bps === 1200, `SynthLink connected at 1200 — ${res.slReady ? res.slReady.info.bps : 'no'}`);
    ok(res.slReady && res.slReady.info.errorControl === 'LAPM' && res.slReady.info.compression === 'V.44' && notes.includes('V.42: LAPM compression=V.44'),
       `V.42 with V.44 at both ends — ${res.slReady ? `${res.slReady.info.errorControl}/${res.slReady.info.compression}` : 'no'}, ${notes.filter((n) => n.startsWith('V.42')).join(', ')}`);
    ok(res.bmRx.toString('latin1') === TO_BM, 'BinModem received our text exactly, nothing before it or after');
    ok(res.slRx.toString('latin1') === TO_SL,
       `we received BinModem's text exactly — ${JSON.stringify(res.slRx.toString('latin1').slice(0, 40))}`);
  }

  // 30 dB of loss on a 2-wire line, our end hearing its own transmit back 12 dB
  // down (17 dB over the far end). BinModem's own echo is off: two BinModems
  // under it do not cross 25 dB (bmbm `echo`), so that line is past the
  // reference. Under it our caller read a JM that had lost its LAPM octet as
  // identical to one that had it, since §7.4's comparison stopped at modn2;
  // BinModem, told LAPM, skipped detection, and we fell to no error control.
  for (const proto of ['V22bis', 'V22']) for (const role of ['originate', 'answer']) {
    const bps = proto === 'V22bis' ? 2400 : 1200;
    console.log(`\n[${proto}, 30 dB under our own echo] ${role === 'originate' ? 'SynthLink calls' : 'BinModem calls'}`);
    const res = await run(role, proto, ['--send-delay', '1'], { line: '2wire', echo: 0.25, bmEcho: false, lossDb: 30, noiseDb: 70 });
    ok(res.slReady && res.slReady.info.bps === bps && res.slReady.info.errorControl === 'LAPM',
       `connected at ${bps} with LAPM — ${res.slReady ? `${res.slReady.info.bps} ${res.slReady.info.errorControl}` : 'no'}`);
    ok(res.bmRx.toString('latin1') === TO_BM && res.slRx.toString('latin1') === TO_SL,
       `text exact both ways — ${JSON.stringify(res.slRx.toString('latin1').slice(0, 40))}`);
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
