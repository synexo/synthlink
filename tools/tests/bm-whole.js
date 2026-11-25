#!/usr/bin/env node
'use strict';
// tools/tests/bm-whole.js — whole calls against BinModem for V.32, V.32bis and
// V.34: SynthLink as a ModemDSP, V.8 and all, exactly what the web client and the
// server run, and BinModem's V.8 in front of its pump (bmpeer --v8), as its own
// modem does. Then the line levels a real line gives.
//
//   node tools/tests/bm-whole.js
//
// DEVELOPMENT ONLY, and SKIPs cleanly — not counted as a pass — when the Rust
// peer is not built (cargo build --release --manifest-path tools/bridge/Cargo.toml).
//
// bm-v32 and bm-v34 test the protocol classes with V.8 assumed done; this is the
// handover from V.8 into them, against a far end that is not ours.
//
// LEVELS. bmpeer puts BinModem on the line at its internal scale, about +3 dBm0,
// where a modem transmits at −9 to −14; ours run −8 to −14. `bmOutDb: −13` puts it
// at a modem's −10, and `bmLevelDb` then moves loss between the two directions.
// BinModem's own V.8 signals sit 9 dB under its data. What these hold down, each
// once failing: ANSam heard at a fixed 0.03 (−24 dBm0); V.21's carrier detect at
// −35 dBm0 and dropping at every FSK transition; V.32's squelch at −29 dBm0 and
// S's onset at a fixed level; V.34's Phase 2 detectors at fixed fractions of our
// own level, which a front-end AGC now brings the far end up to. At 20 dB of loss
// each way, nothing but V.22bis had connected.
// Each assertion is a FLOOR: raise it, never lower it.

const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const { available, call, wholeModem } = require(path.join(ROOT, 'tools', 'bridge', 'peer'));

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log(`  ok   ${msg}`); } else { fail++; console.log(`  FAIL ${msg}`); } }

const TO_BM = 'SYNTHLINK SAYS HI 0123456789\r\n';
const TO_SL = 'BINMODEM SAYS HI 0123456789\r\n';
const BITS = { V32: 'V32bis', V32bis: 'V32bis', V34: 'V34Duplex', V22bis: 'V22bis' };

// The protocols whose data pump carries V.42 here (setBitLink); BinModem runs its
// own V.42 over the same ones, as two real modems both doing it would.
const V42 = new Set(['V22bis', 'V32', 'V32bis', 'V34']);

async function whole(proto, role, line = {}, secs = 16, v42 = V42.has(proto) ? 'both' : null, extra = []) {
  const synth = wholeModem(role, proto);
  const v8 = proto === 'V22bis' ? [] : ['--v8'];      // V.22bis's bmpeer runs its own V.8
  const ec = v42 ? ['--v42', v42] : [];
  const res = await call({ synth, secs, send: TO_BM, ...line,
    peer: ['--proto', proto.toLowerCase(), '--role', role === 'originate' ? 'answer' : 'call', '--send', TO_SL, ...v8, ...ec, ...extra] });
  res.notes = res.bm.filter((e) => e.ev === 'note').map((e) => e.text);
  res.lapmSaid = !!synth.dsp._handshake._v8Lapm;      // ours: both CM and JM said LAPM
  return res;
}
const who = (role) => (role === 'originate' ? 'SynthLink calls' : 'SynthLink answers');
const status = (res) => (res.bmConnected ? res.bmConnected.status : 'no connect');

async function main() {
  const av = available();
  if (!av.ok) { console.log(`SKIP bm-whole: ${av.reason}`); process.exit(0); }

  // ── V.8, then the pump, at the levels bmpeer gives ────────────────────────
  for (const [proto, bps] of [['V32', 9600], ['V32bis', 14400], ['V34', 33600]]) {
    for (const role of ['originate', 'answer']) {
      const tag = `[${proto}, ${who(role)}]`;
      const res = await whole(proto, role);
      ok(res.notes.some((n) => n.includes(`V.8 agreed ${BITS[proto]}`)), `${tag} BinModem's V.8 agreed ${BITS[proto]} with ours`);
      ok(res.slReady && res.slReady.info.bps === bps && new RegExp(`${bps}`).test(status(res)),
         `${tag} both ends at ${bps} — ${status(res)} / ${res.slReady ? res.slReady.info.bps : 'no'}`);
      ok(res.slRx.toString('latin1') === TO_SL && res.bmRx.toString('latin1') === TO_BM, `${tag} text exact both ways`);
      const info = res.slReady ? res.slReady.info : {};
      ok(info.errorControl === 'LAPM' && info.compression === 'V.44' && res.notes.some((n) => n === 'V.42: LAPM compression=V.44'),
         `${tag} V.42 with V.44 at both ends — ours ${info.errorControl}/${info.compression}, BinModem's ${res.notes.filter((n) => n.startsWith('V.42')).join(', ')}`);
      // V.8 Table 6: each end said LAPM in its CM or JM, and each read the other's.
      ok(res.lapmSaid && res.notes.includes('V.8: both said LAPM'), `${tag} V.8 settled LAPM at both ends (Table 6's protocols octet)`);
    }
  }

  // ── V.42 against BinModem offering each compression, and none ────────────
  for (const [mode, want] of [['v42bis', 'V.42bis'], ['none', null]]) {
    for (const role of ['originate', 'answer']) {
      const tag = `[V32bis, BinModem's V.42 offering ${mode}, ${who(role)}]`;
      const res = await whole('V32bis', role, {}, 16, mode);
      const info = res.slReady ? res.slReady.info : {};
      ok(info.errorControl === 'LAPM' && info.compression === want && res.slRx.toString('latin1') === TO_SL && res.bmRx.toString('latin1') === TO_BM,
         `${tag} LAPM, ${want || 'no compression'}, text exact both ways — ${info.errorControl}/${info.compression}`);
    }
  }

  // ── V.42 through a retrain ──────────────────────────────────────────────
  // A second of noise at 25 dB once the link is up: both pumps retrain, V.42 is
  // suspended meanwhile (7.10) and carries on after with the same link, and the
  // text each end sends afterwards crosses exactly.
  for (const role of ['originate', 'answer']) {
    const tag = `[V32bis, V.42 through a retrain, ${who(role)}]`;
    const at = role === 'originate' ? 9 : 7;
    const res = await whole('V32bis', role, { lossDb: 10, noiseDb: 60, bmLevelDb: -13, worse: { at, until: at + 1, noiseDb: 25 }, sendDelay: 5 }, 22, 'both', ['--send-delay', '5']);
    const info = res.slReady ? res.slReady.info : {};
    const retrained = res.bm.filter((e) => e.ev === 'phase' && e.phase === 'connected').length >= 2;
    ok(info.errorControl === 'LAPM' && retrained && res.slRx.toString('latin1') === TO_SL && res.bmRx.toString('latin1') === TO_BM,
       `${tag} LAPM, retrained, text exact both ways after — ${info.errorControl}/${info.compression}, retrained ${retrained}, ${JSON.stringify(res.slRx.toString('latin1'))} / ${JSON.stringify(res.bmRx.toString('latin1'))}`);
  }

  // And V.34's (§11.5): the same second of noise, which only our end acts on
  // (BinModem's modem retrains when asked, never by itself). Ours retrains, BinModem
  // answers its tone, LAPM is suspended through it and carries on.
  for (const role of ['originate', 'answer']) {
    const tag = `[V34, V.42 through a retrain, ${who(role)}]`;
    const res = await whole('V34', role, { lossDb: 10, noiseDb: 60, bmOutDb: -13, worse: { at: 10, until: 11, noiseDb: 25 }, sendDelay: 5 }, 24, 'both', ['--send-delay', '5']);
    const info = res.slReady ? res.slReady.info : {};
    const retrained = res.bm.some((e) => e.ev === 'phase' && e.status === 'Retraining') &&
      res.bm.filter((e) => e.ev === 'phase').slice(-1)[0].status.startsWith('Connected');
    ok(info.errorControl === 'LAPM' && retrained && res.slRx.toString('latin1') === TO_SL && res.bmRx.toString('latin1') === TO_BM,
       `${tag} LAPM, retrained, text exact both ways after — ${info.errorControl}/${info.compression}, retrained ${retrained}, ${JSON.stringify(res.slRx.toString('latin1'))} / ${JSON.stringify(res.bmRx.toString('latin1'))}`);
  }

  // ── A far end with no V.42: the detection phase finds that out ────────────
  // BinModem's pump bare. Called, it hears our ODP as characters, as a real
  // modem without V.42 would pass them to its terminal, and then our text;
  // answering, ours waits out the detection phase and gives up. Either way the
  // link is reported up without error control and the text crosses as itself.
  for (const role of ['originate', 'answer']) {
    const tag = `[V32bis, BinModem without V.42, ${who(role)}]`;
    const res = await whole('V32bis', role, {}, 16, null);
    const info = res.slReady ? res.slReady.info : {};
    const bm = res.bmRx.toString('latin1');
    const before = bm.endsWith(TO_BM) ? bm.slice(0, bm.length - TO_BM.length) : null;
    ok(!res.lapmSaid, `${tag} BinModem's V.8 said no LAPM, so ours did not take it as settled`);
    ok(info.errorControl === 'NONE' && res.slRx.toString('latin1') === TO_SL && before !== null && /^[\x11\x91\xf9]*$/.test(before),
       `${tag} no error control, our receive exact, ours reached BinModem after only ODP — ${info.errorControl}, ${JSON.stringify(before)}`);
  }

  // ── The far clock 100 ppm off, and a tilted line, through V.8 ─────────────
  for (const [name, line] of [['+100 ppm', { ppm: 100 }], ['8 dB tilt, 1 ms', { lossDb: 10, noiseDb: 60, disperse: { tiltDb: 8, edgeDelayMs: 1 } }]]) {
    for (const proto of ['V32bis', 'V34']) {
      for (const role of ['originate', 'answer']) {
        const tag = `[${proto}, ${name}, ${who(role)}]`;
        const res = await whole(proto, role, line);
        // BinModem as the V.32bis CALL modem frames junk at its E-to-data change
        // on some lines (bm-v32), so on its side our text must arrive whole.
        ok(res.slReady && res.bmConnected && res.slRx.toString('latin1') === TO_SL && res.bmRx.toString('latin1').endsWith(TO_BM),
           `${tag} connected, our receive exact, ours reached BinModem whole — ${status(res)}`);
      }
    }
  }

  // ── Real line levels: BinModem at a modem's −10 dBm0, then loss ───────────
  for (const [name, line] of [
    ['20 dB of loss each way', { lossDb: 20, bmOutDb: -13, noiseDb: 70 }],
    ['22 dB toward us, 14 toward BinModem', { lossDb: 18, bmLevelDb: -4, bmOutDb: -13, noiseDb: 70 }],
  ]) {
    for (const proto of ['V22bis', 'V32bis', 'V34']) {
      // V.34 at 20 dB each way puts us under BinModem's own V.34 floor (it does
      // not connect to itself there either: bmbm.js), so that line is V.34's
      // second one only.
      if (proto === 'V34' && name.startsWith('20')) continue;
      for (const role of ['originate', 'answer']) {
        const tag = `[${proto}, ${name}, ${who(role)}]`;
        const res = await whole(proto, role, line);
        ok(res.notes.some((n) => n.includes('V.8 agreed')) && res.slReady && res.bmConnected,
           `${tag} V.8 agreed and both connected — ${status(res)} / ${res.slReady ? res.slReady.info.bps : 'no'}`);
        ok(res.slRx.toString('latin1') === TO_SL && res.bmRx.toString('latin1') === TO_BM, `${tag} text exact both ways`);
      }
    }
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
