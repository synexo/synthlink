#!/usr/bin/env node
'use strict';
// tools/tests/bm-v34.js — V.34 against BinModem, both roles.
//
//   node tools/tests/bm-v34.js
//
// DEVELOPMENT ONLY, and SKIPs cleanly — not counted as a pass — when the Rust
// peer is not built (cargo build --release --manifest-path tools/bridge/Cargo.toml).
//
// The peer is not ours. BinModem's V.34 has connected to real modems, so every
// assertion here is one a loopback cannot make: a transcription error both of our
// ends share fails here and nowhere else.
//
// What is asserted is how far a call gets, and it is a FLOOR: everything below it
// works against an independent receiver today. Raise it as the start-up is fixed;
// never lower it. Where the call stops is printed after the assertions.

const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const { available, call, bmPhases, timeline } = require(path.join(ROOT, 'tools', 'bridge', 'peer'));

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log(`  ok   ${msg}`); } else { fail++; console.log(`  FAIL ${msg}`); } }

function fresh(role) {
  const { V34 } = require(path.join(ROOT, 'vendor', 'src', 'dsp', 'protocols', 'V34'));
  const m = new V34(role);
  if (m.setV8Complete) m.setV8Complete(true);
  return m;
}

// The phases SynthLink's own status line reported, by describe().phase.
const slPhases = res => res.sl.map(e => { try { return JSON.parse(e.describe); } catch { return null; } })
  .filter(Boolean).map(d => d.phase);

// Phases 3 and 4 to data mode, in either role. §11.3 and §11.4 are signal-gated at
// both ends, so BinModem reaching data mode at all means every gate on our side
// fired on its signals and every one on its side on ours.
function phase34(res, bm, payload) {
  ok(bm.includes('V.34 phase 4: MP'), 'BinModem trained on our Phase 4 TRN and reached MP (§11.4)');
  ok(!!res.bmConnected, `BinModem read our MP, MP′ and E and entered data mode — ${res.bmConnected ? res.bmConnected.status : 'no'}`);
  ok(!!res.slReady, "SynthLink read BinModem's MP′ and E and entered data mode at its B1");
  // Data, this way round: our B1, superframe sync, shell mapping, trellis and
  // mapper, decoded by a receiver that has decoded real modems.
  ok(res.bmRx.toString('latin1').includes(payload),
     `BinModem received our payload exactly — got ${JSON.stringify(res.bmRx.toString('latin1').slice(0, 48))}`);
  // And the other way, which needs our receive equaliser: BinModem's pulse
  // shaping is not ours, and its data reached our slicer 6.4% off the points —
  // below the 33 600 lattice — until the equaliser trained on its Phase 4.
  ok(res.slRx.toString('latin1') === 'BINMODEM SAYS HI\r\n',
     `we received BinModem's text exactly, nothing else — got ${JSON.stringify(res.slRx.toString('latin1').slice(0, 48))}`);
  console.log(`  -- last phases: ${bm.slice(-3).join(' > ')}`);
}

async function main() {
  const av = available();
  if (!av.ok) { console.log(`SKIP bm-v34: ${av.reason}`); process.exit(0); }

  // ── SynthLink calls, BinModem answers ────────────────────────────────────
  console.log('\n[1] SynthLink call modem → BinModem answer modem');
  const PAYLOAD = 'SYNTHLINK TO BINMODEM 0123456789\r\n';
  let res = await call({ synth: fresh('originate'), peer: ['--proto', 'v34', '--role', 'answer', '--send', 'BINMODEM SAYS HI\r\n'], secs: 8, send: PAYLOAD });
  let bm = bmPhases(res);
  // §11.2: each of these is BinModem's procedure advancing on a signal of ours.
  ok(bm.includes('V.34 tones'), 'BinModem heard INFO0c and moved on to the tones (§11.2.1.2)');
  ok(bm.includes('V.34 reading the probe'), "BinModem heard tone B's reversals and read our L1/L2 (§11.2.1.2.5)");
  ok(bm.includes('V.34 INFO1'), 'BinModem reached the INFO1 exchange');
  ok(bm.some(p => p.startsWith('V.34 phase 3')), 'BinModem accepted INFO1c and left Phase 2');
  ok(slPhases(res).includes(3), "SynthLink accepted BinModem's INFO0a, probe and INFO1a and left Phase 2");
  phase34(res, bm, PAYLOAD);

  // ── BinModem calls, SynthLink answers ────────────────────────────────────
  console.log('\n[2] BinModem call modem → SynthLink answer modem');
  res = await call({ synth: fresh('answer'), peer: ['--proto', 'v34', '--role', 'call', '--send', 'BINMODEM SAYS HI\r\n'], secs: 8, send: PAYLOAD });
  bm = bmPhases(res);
  ok(bm.includes('V.34 reading the probe'), 'BinModem read our L1/L2 (§11.2.1.1.5)');
  ok(bm.includes('V.34 phase 3: training'), "BinModem detected our S and S̄ and began training on our PP (§11.3.1.1.2)");
  ok(bm.includes('V.34 phase 3: listening for J'), 'BinModem trained on our TRN (§11.3.1.1.3)');
  ok(bm.includes('V.34 phase 3: sending PP and TRN'), 'BinModem read our J and began its own Phase 3 transmission');
  ok(slPhases(res).includes(3), "SynthLink accepted BinModem's INFO0c, probe and INFO1c and left Phase 2");
  phase34(res, bm, PAYLOAD);

  // ── Every 3429 ladder rate, both roles, in ONE process ──────────────────
  // The rate is per call now (V34Mapper's ladder, framing from §8.2's rules), and
  // a rate's state must not leak into the next call: descending order reuses
  // configurations an earlier call cached, which is how a per-rate scale baked at
  // the wrong level once put 24 000 two decibels hot and garbled it.
  console.log('\n[3] Configured below 33 600 — every 3429 rate, both roles');
  const cfgMod = require(path.join(ROOT, 'vendor', 'config'));
  const saved = cfgMod.modem.native.v34Rate;
  for (const rate of [31200, 28800, 26400, 24000, 21600, 19200]) {
    for (const role of ['originate', 'answer']) {
      cfgMod.modem.native.v34Rate = `${rate}/3429`;
      const m = fresh(role);
      const r = await call({ synth: m, secs: 8, send: PAYLOAD,
        peer: ['--proto', 'v34', '--role', role === 'originate' ? 'answer' : 'call', '--send', 'BINMODEM SAYS HI\r\n'] });
      ok(r.bmConnected && new RegExp(`transmit: ${rate}, receive: ${rate}`).test(r.bmConnected.status) &&
         r.bmRx.toString('latin1') === PAYLOAD && r.slRx.toString('latin1') === 'BINMODEM SAYS HI\r\n',
         `${rate}/3429 ${role}: both ends at ${rate}, text exact both ways — ${r.bmConnected ? r.bmConnected.status : 'no connect'}`);
    }
  }

  // ── Every symbol rate: INFO1 chooses it per call now ─────────────────────
  // The configured key is a ceiling in both halves: INFO0/INFO1 offer no symbol
  // rate above it, and INFO1's choice becomes this call's front end. 3200 needs
  // the carrier INFO1a names to be the one our front end runs (Table 16 bit 23);
  // 2400's Phase 4 needs the S hunt to step past BinModem's start-up transient.
  // And the RATE is the ceiling: each receiver measures a clean path here. 2400's
  // answer modem settled at 16 800 until its matched filter's span went from 10 to
  // 24 — a truncated filter it read as noise.
  console.log('\n[4] Configured at 3200 and 2400 baud — both roles');
  for (const [key, S, top] of [['31200/3200', 3200, 31200], ['19200/2400', 2400, 19200]]) {
    for (const role of ['originate', 'answer']) {
      cfgMod.modem.native.v34Rate = key;
      const m = fresh(role);
      const r = await call({ synth: m, secs: 9, send: PAYLOAD,
        peer: ['--proto', 'v34', '--role', role === 'originate' ? 'answer' : 'call', '--send', 'BINMODEM SAYS HI\r\n'] });
      ok(m.negotiatedSymbolRate === S && r.bmConnected && new RegExp(`transmit: ${top}, receive: ${top}`).test(r.bmConnected.status) &&
         r.bmRx.toString('latin1') === PAYLOAD && r.slRx.toString('latin1') === 'BINMODEM SAYS HI\r\n',
         `${key} ${role}: INFO1 chose ${m.negotiatedSymbolRate} baud, text exact both ways — ${r.bmConnected ? r.bmConnected.status : 'no connect'}`);
    }
  }
  cfgMod.modem.native.v34Rate = saved;

  // A far clock with its own crystal: ±100 ppm through the bridge's resampler, at
  // each symbol rate, both roles. Before the receiver tracked (V34.js, TRK_*), no
  // call connected at all: 0.2 Hz of carrier offset turned Phase 3's four points
  // out of their decision regions before J, and the symbol instant walked a sample
  // a second. Both ends must still reach the symbol rate's ceiling.
  console.log('\n[5] Far clock ±100 ppm — each symbol rate, both roles');
  for (const [key, S, top] of [[null, 3429, 33600], ['31200/3200', 3200, 31200], ['19200/2400', 2400, 19200]]) {
    for (const ppm of [100, -100]) {
      for (const role of ['originate', 'answer']) {
        if (key) cfgMod.modem.native.v34Rate = key;
        const m = fresh(role);
        const r = await call({ synth: m, secs: 9, send: PAYLOAD, ppm,
          peer: ['--proto', 'v34', '--role', role === 'originate' ? 'answer' : 'call', '--send', 'BINMODEM SAYS HI\r\n'] });
        cfgMod.modem.native.v34Rate = saved;
        ok(m.negotiatedSymbolRate === S && r.bmConnected && new RegExp(`transmit: ${top}, receive: ${top}`).test(r.bmConnected.status) &&
           r.bmRx.toString('latin1') === PAYLOAD && r.slRx.toString('latin1') === 'BINMODEM SAYS HI\r\n',
           `${S} baud, ${ppm > 0 ? '+' : ''}${ppm} ppm, ${role}: ${top} both ways, text exact — ${r.bmConnected ? r.bmConnected.status : 'no connect'}` +
           ` (us: ${JSON.stringify(r.slRx.toString('latin1').slice(0, 20))})`);
      }
    }
  }

  // Line noise (the bridge's lineDirection, 50 dB under a full-scale sine). It
  // takes BinModem's view of our signal under ours, so ITS MP offers less than
  // ours. Both directions run one rate, the lowest of the four MP maxima. We once
  // took only the field for the direction we receive and ran 33 600 against
  // BinModem's 28 800, which is garbage both ways.
  console.log('\n[6] A noisy line — the far end offers less than we do');
  for (const role of ['originate', 'answer']) {
    const m = fresh(role);
    const r = await call({ synth: m, secs: 9, send: PAYLOAD, noiseDb: 50,
      peer: ['--proto', 'v34', '--role', role === 'originate' ? 'answer' : 'call', '--send', 'BINMODEM SAYS HI\r\n'] });
    const st = r.bmConnected ? r.bmConnected.status : 'no connect';
    const tx = /transmit: (\d+)/.exec(st);
    ok(tx && +tx[1] === m._rate && r.bmRx.toString('latin1') === PAYLOAD && r.slRx.toString('latin1') === 'BINMODEM SAYS HI\r\n',
       `${role}: both ends at ${m._rate}, text exact both ways — ${st}`);
  }

  // A 2-wire line on OUR side only: our own transmit back into our receiver 10 dB
  // down, immediately or 25 ms later (the far run of taps), under 10 dB of loss
  // and noise at 60 dB, levels matched. BinModem's V.34 has no echo canceller, so
  // it gets none. Ours trains on Phase 3's PP and TRN, the call modem's on TRN only.
  console.log('\n[7] 2-wire: our own echo, cancelled');
  for (const echoDelay of [0, 200]) {
    for (const role of ['originate', 'answer']) {
      const m = fresh(role);
      m.setEchoCanceller(true);
      const r = await call({ synth: m, secs: 9, send: PAYLOAD, line: '2wire', echo: 0.316, echoDelay, bmEcho: false,
        lossDb: 10, noiseDb: 60, bmLevelDb: -13,
        peer: ['--proto', 'v34', '--role', role === 'originate' ? 'answer' : 'call', '--send', 'BINMODEM SAYS HI\r\n'] });
      const st = r.bmConnected ? r.bmConnected.status : 'no connect';
      ok(m._ec.kept && (echoDelay === 0 ? m._ec.farLag === null : m._ec.farLag !== null),
         `echo at ${echoDelay}, ${role}: canceller kept, ${m._ec.trainedDb.toFixed(1)} dB, far run ${m._ec.farLag}`);
      ok(r.bmConnected && r.bmRx.toString('latin1') === PAYLOAD && r.slRx.toString('latin1') === 'BINMODEM SAYS HI\r\n',
         `echo at ${echoDelay}, ${role}: text exact both ways — ${st}`);
    }
  }

  // A dispersive line (peer.js lineFilter), 10 dB loss, noise at 60 dB, with
  // BinModem at a modem's −10 dBm0 (bmOutDb), as we are. Each end must reach at
  // least the rate tools/bridge/bmbm.js gives BinModem against itself on the same
  // line at the same SNR (both at −10 dBm0 is noise at 47 dB there, since bmbm
  // runs both at +3), and carry the text exactly. At BinModem's own +3 this
  // section hid two faults: a ±4 equaliser that read the 12/2 line 10 dB under
  // BinModem, and a Phase 3 S hunt that, started early, never caught up with S.
  console.log('\n[8] A dispersive line, at a modem\'s level');
  // The first line has no filter at all: the bridge's band (150–3800 Hz), on even
  // at 0 dB of tilt, is what costs BinModem against itself 33 600 there.
  for (const [disperse, floor] of [[undefined, 33600], [{ tiltDb: 4, edgeDelayMs: 0.5 }, 28800], [{ tiltDb: 8, edgeDelayMs: 1 }, 26400],
                                   [{ tiltDb: 10, edgeDelayMs: 1.5 }, 26400], [{ tiltDb: 12, edgeDelayMs: 2 }, 24000]]) {
    for (const role of ['originate', 'answer']) {
      const m = fresh(role);
      const r = await call({ synth: m, secs: 10, send: PAYLOAD, lossDb: 10, noiseDb: 60, disperse, bmOutDb: -13,
        peer: ['--proto', 'v34', '--role', role === 'originate' ? 'answer' : 'call', '--send', 'BINMODEM SAYS HI\r\n'] });
      const st = r.bmConnected ? r.bmConnected.status : 'no connect';
      const rate = Math.min(...[/transmit: (\d+)/, /receive: (\d+)/].map(re => +((st.match(re) || [])[1] || 0)));
      ok(r.bmConnected && rate >= floor && r.bmRx.toString('latin1') === PAYLOAD && r.slRx.toString('latin1') === 'BINMODEM SAYS HI\r\n',
         `${disperse ? `${disperse.tiltDb} dB tilt, ${disperse.edgeDelayMs} ms delay` : 'no filter'}, ${role}: at least ${floor}, text exact both ways — ${st}`);
    }
  }

  // §11.5's retrain, at a modem's level. Each case has text cross after it both
  // ways. BinModem's own receiver has no clamp, so what it decodes of our 70 ms of
  // silence reaches its terminal; ours is clamped (circuit 104), so the far end's
  // silence before its tone does not reach ours. Before §11.5 we never answered
  // BinModem's tone: it ran its Phase 2 against our data and never came back.
  console.log('\n[9] Retrain (§11.5)');
  const AFTER_BM = 'AFTER RETRAIN\r\n', AFTER_SL = 'SYNTHLINK AFTER\r\n';
  const rtCall = async (role, o) => {
    const m = fresh(role);
    let retrains = 0, why = [];
    m.on('retrain', (e) => { retrains++; why.push(e.why); });
    const r = await call({ synth: m, secs: o.secs || 18, send: PAYLOAD, lossDb: 10, noiseDb: 60, bmOutDb: -13, worse: o.worse,
      at: [...(o.at || []), [o.slAfter, (S) => S.write(Buffer.from(AFTER_SL, 'latin1'))]],
      peer: ['--proto', 'v34', '--role', role === 'originate' ? 'answer' : 'call', '--send', 'BINMODEM SAYS HI\r\n',
             '--send-again', `${o.bmAfter}:${AFTER_BM.replace('\r\n', '\\r\\n')}`, ...(o.peer || [])] });
    const conns = r.bm.filter((e) => e.ev === 'phase' && /^Connected/.test(e.status)).map((e) => e.status);
    return { r, m, retrains, why, conns, sl: r.slRx.toString('latin1'), bmTxt: r.bmRx.toString('latin1') };
  };
  for (const role of ['originate', 'answer']) {
    // BinModem asks for the retrain (its API, bmpeer --retrain-at), and we answer it.
    let c = await rtCall(role, { peer: ['--retrain-at', '2'], bmAfter: 9, slAfter: 15 });
    ok(c.retrains === 1 && c.why[0] === 'far end' && c.conns.length >= 2 &&
       c.sl === 'BINMODEM SAYS HI\r\n' + AFTER_BM && c.bmTxt === PAYLOAD + AFTER_SL,
       `BinModem retrains, SynthLink ${role === 'originate' ? 'calls' : 'answers'}: we answered its tone, and text is exact both ways after — ${c.why.join(',')} ${c.conns.slice(-1)[0] || 'no reconnect'} ${JSON.stringify(c.sl)} / ${JSON.stringify(c.bmTxt)}`);
    // We ask, and BinModem follows.
    c = await rtCall(role, { at: [[7, (S) => S.retrain()]], bmAfter: 9, slAfter: 15 });
    ok(c.retrains === 1 && c.conns.length >= 2 && c.sl === 'BINMODEM SAYS HI\r\n' + AFTER_BM &&
       c.bmTxt.startsWith(PAYLOAD) && c.bmTxt.endsWith(AFTER_SL),
       `SynthLink ${role === 'originate' ? 'calls' : 'answers'} and retrains: BinModem followed, text exact after — ${c.conns.slice(-1)[0] || 'no reconnect'} ${JSON.stringify(c.sl)}`);
    // Our direction degrades for good (noise to 48 dB at our receiver only): ours
    // cannot hold the rate, retrains unasked, and comes back lower. What the line
    // delivered in the second before is the line's.
    c = await rtCall(role, { worse: { at: 7, noiseDb: 48, only: 'sl' }, bmAfter: 13, slAfter: 17, secs: 19 });
    const rate = +((c.conns.slice(-1)[0] || '').match(/receive: (\d+)/) || [0, 0])[1];
    ok(c.retrains === 1 && c.why[0] === 'unsatisfactory' && rate > 0 && rate < 33600 &&
       c.sl.endsWith(AFTER_BM) && c.bmTxt.endsWith(AFTER_SL),
       `SynthLink ${role === 'originate' ? 'calls' : 'answers'}, its line degrades: it retrained on its own and came back lower, text exact after — ${c.why.join(',')} ${c.conns.slice(-1)[0] || 'no reconnect'}`);
  }

  // §11.6's rate renegotiation, at a modem's level: S, S̄, TRN, MP, MP′, E and B1
  // from data mode, with no Phase 2 and no silence. Found inside data, the far
  // end's S is what each end answers. Before §11.6 BinModem's went unanswered and
  // its §11.6.2 bound fell back to a full retrain three seconds on.
  console.log('\n[10] Rate renegotiation (§11.6)');
  const rate = (c) => +((c.conns.slice(-1)[0] || '').match(/receive: (\d+)/) || [0, 0])[1];
  for (const role of ['originate', 'answer']) {
    const who = role === 'originate' ? 'calls' : 'answers';
    let c = await rtCall(role, { peer: ['--renegotiate-at', '2:24000'], bmAfter: 6, slAfter: 12, secs: 15 });
    ok(c.why.join(',') === 'far end renegotiates' && rate(c) === 24000 &&
       !c.r.bm.some((e) => e.ev === 'phase' && /tones/.test(e.phase) && e.t > 6) &&
       c.sl === 'BINMODEM SAYS HI\r\n' + AFTER_BM && c.bmTxt === PAYLOAD + AFTER_SL,
       `BinModem renegotiates to 24 000, SynthLink ${who}: followed without a retrain, text exact both ways after — ${c.why.join(',')} ${c.conns.slice(-1)[0]} ${JSON.stringify(c.sl)}`);
    c = await rtCall(role, { at: [[7, (S) => S.renegotiate(24000)]], bmAfter: 9, slAfter: 12, secs: 15 });
    ok(c.why.join(',') === 'renegotiate' && rate(c) === 24000 &&
       c.sl === 'BINMODEM SAYS HI\r\n' + AFTER_BM && c.bmTxt === PAYLOAD + AFTER_SL,
       `SynthLink ${who} and renegotiates to 24 000: BinModem followed, text exact both ways after — ${c.conns.slice(-1)[0]} ${JSON.stringify(c.sl)} / ${JSON.stringify(c.bmTxt)}`);
    // Our direction worsens (noise to 55 dB at our receiver) without being swamped:
    // ours steps down in place rather than retraining.
    c = await rtCall(role, { worse: { at: 7, noiseDb: 55, only: 'sl' }, bmAfter: 13, slAfter: 16, secs: 20 });
    ok(c.why[0] === 'renegotiate' && rate(c) > 0 && rate(c) < 33600 && c.sl.endsWith(AFTER_BM) && c.bmTxt.endsWith(AFTER_SL),
       `SynthLink ${who}, its line worsens: it renegotiated down on its own, text exact after — ${c.why.join(',')} ${c.conns.slice(-1)[0]}`);
    // The same, for five seconds: down, and once the line has been good again for
    // five seconds and ten have passed since, back up (falling forward).
    c = await rtCall(role, { worse: { at: 7, until: 12, noiseDb: 55, only: 'sl' }, bmAfter: 20, slAfter: 26, secs: 30 });
    const rates = c.conns.map((st) => +((st.match(/receive: (\d+)/) || [0, 0])[1]));
    ok(c.why.join(',') === 'renegotiate,renegotiate' && rates.some((r) => r < 33600) && rate(c) === 33600 &&
       c.sl.endsWith(AFTER_BM) && c.bmTxt.endsWith(AFTER_SL),
       `SynthLink ${who}, its line worsens and recovers: down, then forward again, text exact after — ${rates.join(' > ')}`);
  }

  if (fail && process.env.VERBOSE) console.log('\n' + timeline(res));
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
