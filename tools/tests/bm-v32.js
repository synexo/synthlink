#!/usr/bin/env node
'use strict';
// tools/tests/bm-v32.js — V.32 (9600 both codings, 4800) and V.32bis (14 400 to 4800)
// against BinModem, both roles, at the protocol class.
//
//   node tools/tests/bm-v32.js
//
// DEVELOPMENT ONLY, and SKIPs cleanly — not counted as a pass — when the Rust
// peer is not built (cargo build --release --manifest-path tools/bridge/Cargo.toml).
//
// bmpeer's V.32 has no V.8 in front of it, so this is the class with
// setV8Complete(true) — what Handshake.js does after a real V.8 — and, for V.32,
// once without it, where the call modem has to hear the answer tone or the AC
// tones itself (§5.4.1 and its note 1). BinModem's answerer sends V.25's full
// 3.3 s tone, which is why SynthLink-calls runs connect later.
//
// What it holds down, each once missing:
//   §5.4's AA/CC and AC/CA opening, with the reversals answered 64 ± 2 T later
//     and NT / MT measured (V32Preface.js);
//   circuit 109 and the first data 128 T after the FAR end's E, not our own —
//     the call modem's first characters were going into BinModem's settling;
//   Figure 1/V.32bis's convolutional encoder — an invented one slices perfectly
//     without Viterbi and decodes as a flood of bytes with it;
//   V.32bis's line level, which was 6 dB under V.32's and under BinModem's tone
//     detectors;
//   V.32bis's trellis, decoded: noise at 45 dB, where the slicer lost every byte;
//   V.32bis's lower rates, 12 000 to 4800, each on its own figure;
//   V.32's trellis mode and 4800, and a false E taken out of noise;
//   §5.5's retrain, BinModem's and ours, where its AA came out as a byte flood;
//   the first rate chosen from the line, where a noisy one came up and retrained;
//   the answer modem's CA, which BinModem missed at 3 to 6 dB of loss;
//   a dispersive line, which needs an equaliser and an S test a tilt cannot fool;
//   a far clock ±100 ppm off (§2's symbol-rate tolerance, 0.01%), through the
//   bridge's resampler — our receiver once locked timing, phase and gain on S and
//   free-ran, and BinModem's text came out as garbage; and the call modem's
//   reversal test, which a clock 100 ppm fast made blind (V32Preface.js).
// Each assertion is a FLOOR: raise it, never lower it.

const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const { available, call } = require(path.join(ROOT, 'tools', 'bridge', 'peer'));

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log(`  ok   ${msg}`); } else { fail++; console.log(`  FAIL ${msg}`); } }

const TO_BM = 'SYNTHLINK SAYS HI 0123456789\r\n';
const TO_SL = 'BINMODEM SAYS HI 0123456789\r\n';

async function run(cls, role, v8, ppm = 0, line = {}, prep, peerArgs = []) {
  const M = require(path.join(ROOT, 'vendor', 'src', 'dsp', 'protocols', cls))[cls];
  const synth = new M(role);
  if (v8) synth.setV8Complete(true);
  if (prep) prep(synth);
  const res = await call({
    synth, secs: (ppm || line.disperse) ? 11 : 8, send: TO_BM, ppm, ...line,
    peer: ['--proto', cls.toLowerCase(), '--role', role === 'originate' ? 'answer' : 'call', '--send', TO_SL, ...peerArgs],
  });
  res.synthObj = synth;
  return res;
}

async function main() {
  const av = available();
  if (!av.ok) { console.log(`SKIP bm-v32: ${av.reason}`); process.exit(0); }

  const cases = [
    ['V32', 9600, 'Uncoded', true], ['V32bis', 14400, 'Trellis', true],
    ['V32', 9600, 'Uncoded', false],
  ];
  for (const [cls, bps, coding, v8] of cases) {
    for (const [label, role] of [['SynthLink calls, BinModem answers', 'originate'],
                                 ['BinModem calls, SynthLink answers', 'answer']]) {
      console.log(`\n[${cls}${v8 ? '' : ', no V.8'}] ${label}`);
      const res = await run(cls, role, v8);
      const s = res.synthObj;
      const phases = res.bm.filter(e => e.ev === 'phase').map(e => e.phase);
      const ev = s._pre.events.map(e => e.what).join(' | ');
      // BinModem's own states are the far end's view of our opening.
      const opening = role === 'originate' ? ['CA', 'CA to AC', 'AC again'] : ['AA to CC', 'CC', 'awaiting R1'];
      ok(opening.every(p => phases.includes(p)), `BinModem went ${opening.join(' → ')} on our tones — ${[...new Set(phases)].slice(0, 8).join(' > ')}`);
      // Promptly: a modem that sends nothing until its own fallback timer still
      // gets BinModem there eventually, on the carrier in its S.
      const at = name => (res.bm.find(e => e.ev === 'phase' && e.phase === name) || {}).t;
      const [from, to] = role === 'originate' ? ['AC', 'CA'] : ['AA', 'AA to CC'];
      ok(at(to) != null && at(to) - at(from) < 1.0, `BinModem left ${from} within 1 s of entering it (${from} ${at(from)}s, ${to} ${at(to)}s)`);
      const rt = role === 'originate' ? s._pre.nt : s._pre.mt;
      ok(rt >= 64, `${role === 'originate' ? 'NT' : 'MT'} measured (${rt} T) — ${ev}`);
      ok(s._pre.late === 0, `every turnaround made 64 ± 2 T (late by ${s._pre.late})`);
      ok(res.bmConnected && new RegExp(`Connected\\(${bps}\\).*${coding}`).test(res.bmConnected.status),
         `BinModem connected at ${bps} ${coding} — ${res.bmConnected ? res.bmConnected.status : 'no'}`);
      ok(res.slReady && res.slReady.info.bps === bps, `SynthLink connected at ${bps} — ${res.slReady ? res.slReady.info.bps : 'no'}`);
      ok(res.bmRx.toString('latin1') === TO_BM,
         `BinModem received our text exactly, nothing else — ${JSON.stringify(res.bmRx.toString('latin1').slice(0, 40))}`);
      ok(res.slRx.toString('latin1') === TO_SL,
         `we received BinModem's text exactly, nothing else — ${JSON.stringify(res.slRx.toString('latin1').slice(0, 40))}`);
    }
  }

  // The far clock off by the tolerance, both ways. Our receive must be exact. Far
  // from 0 ppm, BinModem in the CALL role can frame a few junk bytes coming out of
  // its own training before our text arrives; that is its receiver, so the
  // assertion on its side is that our text arrives whole, in order. BinModem's
  // answer modem stretches its TRN to 1.7 s when the far clock is off (§5.2.3
  // allows it), so these calls run longer.
  for (const cls of ['V32', 'V32bis']) {
    for (const ppm of [100, -100]) {
      for (const role of ['originate', 'answer']) {
        const res = await run(cls, role, true, ppm);
        const bps = cls === 'V32' ? 9600 : 14400;
        const tag = `[${cls} ${ppm > 0 ? '+' : ''}${ppm} ppm, SynthLink ${role === 'originate' ? 'calls' : 'answers'}]`;
        const bm = res.bmRx.toString('latin1');
        ok(res.bmConnected && new RegExp(`Connected\\(${bps}\\)`).test(res.bmConnected.status) && res.slReady && res.slReady.info.bps === bps,
           `${tag} both ends at ${bps} — ${res.bmConnected ? res.bmConnected.status : 'no'} / ${res.slReady ? res.slReady.info.bps : 'no'}`);
        ok(res.slRx.toString('latin1') === TO_SL, `${tag} we received BinModem's text exactly — ${JSON.stringify(res.slRx.toString('latin1').slice(0, 40))}`);
        ok(bm.endsWith(TO_BM), `${tag} BinModem received our text whole${bm === TO_BM ? '' : ` (after ${bm.length - TO_BM.length} of its own)`}`);
      }
    }
  }

  // A 2-wire line: each end's own transmit back into its receiver 10 dB down,
  // immediately or 5 ms later, under 10 dB of loss and noise at 60 dB. BinModem
  // cancels its own once trained (see below for when it cannot). With levels matched (it drives
  // 13 dB hotter than our −10 dBm0), our echo sits 10 dB above the far end in our own
  // receiver. EchoCanceller.js trains on our first TRN.
  const TWO = { line: '2wire', echo: 0.316, lossDb: 10, noiseDb: 60, bmLevelDb: -13 };
  for (const cls of ['V32', 'V32bis']) {
    for (const echoDelay of [0, 40]) {
      for (const role of ['originate', 'answer']) {
        // BinModem as the CALL modem misses our CA's reversal under its own echo,
        // even 20 dB down: its canceller is not trained until its TRN. So when we
        // answer, only we hear ourselves.
        const res = await run(cls, role, true, 0, { ...TWO, echoDelay, bmEcho: role === 'originate' }, x => x.setEchoCanceller(true));
        const bps = cls === 'V32' ? 9600 : 14400;
        const tag = `[${cls} 2-wire, echo at ${echoDelay}, SynthLink ${role === 'originate' ? 'calls' : 'answers'}]`;
        const ec = res.synthObj._ec;
        ok(ec.kept && ec.trainedDb > 15, `${tag} our canceller kept, ${ec.trainedDb.toFixed(1)} dB removed`);
        ok(res.slReady && res.slReady.info.bps === bps && res.bmConnected && new RegExp(`Connected\\(${bps}\\)`).test(res.bmConnected.status),
           `${tag} both ends at ${bps}`);
        ok(res.slRx.toString('latin1') === TO_SL && res.bmRx.toString('latin1') === TO_BM,
           `${tag} text exact both ways — ${JSON.stringify(res.slRx.toString('latin1').slice(0, 30))}`);
      }
    }
  }
  // Noise at 45 dB, 4-wire and then 2-wire. At 14 400 that is about where the
  // nearest of 128 points is wrong on a symbol in seven: the slicer this replaced
  // lost every byte here, and only V32bisViterbi reads the code. (At 42 dB it is
  // BinModem that gives out: it retrains on its own view of our signal.)
  for (const line of [{ lossDb: 10, noiseDb: 45, bmLevelDb: -13 }, { ...TWO, noiseDb: 45 }]) {
    for (const role of ['originate', 'answer']) {
      const two = !!line.line;
      const res = await run('V32bis', role, true, 0, { ...line, bmEcho: role === 'originate' }, two ? (x => x.setEchoCanceller(true)) : null);
      ok(res.slRx.toString('latin1') === TO_SL && res.bmRx.toString('latin1') === TO_BM,
         `[V32bis, noise at 45 dB${two ? ', 2-wire' : ''}, SynthLink ${role === 'originate' ? 'calls' : 'answers'}] text exact both ways — ${JSON.stringify(res.slRx.toString('latin1').slice(0, 30))}`);
    }
  }

  // A dispersive line (peer.js lineFilter): loss rising across the band and group
  // delay rising toward its edges, under 10 dB of loss and noise at 60 dB. Without
  // an equaliser our receivers turned BinModem's text into garbage at the mildest
  // of these; and S itself, two tones the tilt weights unequally, failed the
  // constant-modulus test that used to confirm it. BinModem as the call modem
  // frames a few bytes of its own ahead of ours on this line, so on its side the
  // assertion is that our text arrives whole.
  for (const cls of ['V32', 'V32bis']) {
    for (const disperse of [{ tiltDb: 8, edgeDelayMs: 1 }, { tiltDb: 12, edgeDelayMs: 2 }]) {
      for (const role of ['originate', 'answer']) {
        const res = await run(cls, role, true, 0, { lossDb: 10, noiseDb: 60, disperse });
        const tag = `[${cls}, ${disperse.tiltDb} dB tilt and ${disperse.edgeDelayMs} ms of delay, SynthLink ${role === 'originate' ? 'calls' : 'answers'}]`;
        ok(res.slRx.toString('latin1') === TO_SL && res.bmRx.toString('latin1').endsWith(TO_BM),
           `${tag} we received BinModem's text exactly; it received ours whole — ${JSON.stringify(res.slRx.toString('latin1').slice(0, 30))}`);
      }
    }
  }

  // Every V.32bis rate, forced from our side by setMaxRate (bmpeer offers them all):
  // 12 000, 9600 and 7200 on Figures 2-2 to 2-4 through the trellis, 4800 on
  // Figure 2-5's four states without it. Clean, then 2-wire with the far echo 5 ms
  // out and noise at 45 dB. Our receive must be exact. BinModem as the CALL modem
  // frames a byte or more of its own at its E-to-data change (it does the same
  // against itself, at every rate: tools/bridge/bmbm.js with MAX_RATE), so on
  // that side our text must arrive whole.
  for (const rate of [12000, 9600, 7200, 4800]) {
    for (const line of [{}, { ...TWO, noiseDb: 45, echoDelay: 40 }]) {
      for (const role of ['originate', 'answer']) {
        const two = !!line.line;
        const res = await run('V32bis', role, true, 0, two ? { ...line, bmEcho: role === 'originate' } : line,
                              (x) => { x.setMaxRate(rate); if (two) x.setEchoCanceller(true); });
        const tag = `[V32bis at ${rate}${two ? ', 2-wire, noise at 45 dB' : ''}, SynthLink ${role === 'originate' ? 'calls' : 'answers'}]`;
        const coding = rate === 4800 ? 'Uncoded' : 'Trellis';
        const bm = res.bmRx.toString('latin1');
        ok(res.bmConnected && new RegExp(`Connected\\(${rate}\\).*${coding}`).test(res.bmConnected.status) && res.slReady && res.slReady.info.bps === rate,
           `${tag} both ends at ${rate} ${coding} — ${res.bmConnected ? res.bmConnected.status : 'no'} / ${res.slReady ? res.slReady.info.bps : 'no'}`);
        ok(res.slRx.toString('latin1') === TO_SL, `${tag} we received BinModem's text exactly — ${JSON.stringify(res.slRx.toString('latin1').slice(0, 30))}`);
        ok(role === 'originate' ? bm === TO_BM : bm.endsWith(TO_BM),
           `${tag} BinModem received our text ${role === 'originate' ? 'exactly' : 'whole'}${bm === TO_BM ? '' : ` (after ${bm.length - TO_BM.length} of its own)`}`);
      }
    }
  }

  // V.32's other modes. §2.4.1.2's trellis coding at 9600 when both ends set
  // Table 6's B8 (bmpeer's --v32-trellis), the non-redundant mode when only one
  // does, and 4800 (§2.4.2) on Figure 1's four states.
  for (const [what, max, ours, theirs, coding, bps] of [
    ['9600 trellis', 9600, true, true, 'Trellis', 9600],
    ['trellis offered by us alone', 9600, true, false, 'Uncoded', 9600],
    ['4800', 4800, false, false, 'Uncoded', 4800],
  ]) {
    for (const line of [{}, { ...TWO, noiseDb: 45, echoDelay: 40 }]) {
      for (const role of ['originate', 'answer']) {
        const two = !!line.line;
        const res = await run('V32', role, true, 0, two ? { ...line, bmEcho: role === 'originate' } : line,
                              (x) => { x.setMaxRate(max); x.setTrellis(ours); if (two) x.setEchoCanceller(true); },
                              theirs ? ['--v32-trellis'] : []);
        const tag = `[V32 ${what}${two ? ', 2-wire, noise at 45 dB' : ''}, SynthLink ${role === 'originate' ? 'calls' : 'answers'}]`;
        ok(res.bmConnected && new RegExp(`Connected\\(${bps}\\).*${coding}`).test(res.bmConnected.status) && res.slReady && res.slReady.info.bps === bps
           && res.synthObj._dataTcm === (coding === 'Trellis'),
           `${tag} both ends at ${bps} ${coding} — ${res.bmConnected ? res.bmConnected.status : 'no'} / ${res.slReady ? res.slReady.info.bps : 'no'}`);
        ok(res.slRx.toString('latin1') === TO_SL && res.bmRx.toString('latin1') === TO_BM,
           `${tag} text exact both ways — ${JSON.stringify(res.slRx.toString('latin1').slice(0, 30))}`);
      }
    }
  }
  // What the code is for: at 37 dB the non-redundant mode garbles BinModem's text
  // and the trellis reads it. Both are held at 9600 by turning off this call's
  // rate choice from the line (_lineRoom), which on this line rightly offers 4800
  // and so would hide the difference this measures. (BinModem then retrains on its
  // own view of us; the retrain sections below hold what follows.)
  for (const tcm of [true, false]) {
    // 37 here is the 35 dB this was written at: bmLevelDb moved from −11 to −13
    // when our transmitters went to −10 dBm0, which puts 2 dB more loss on
    // BinModem's side, so the same SNR at our receiver is 2 dB less noise.
    const res = await run('V32', 'answer', true, 0, { lossDb: 10, noiseDb: 37, bmLevelDb: -13 },
                          (x) => { x.setTrellis(tcm); x._lineRoom = () => true; }, tcm ? ['--v32-trellis'] : []);
    const got = res.slRx.toString('latin1').startsWith(TO_SL);
    ok(tcm ? got : !got, `[V32 ${tcm ? 'trellis' : 'non-redundant'}, noise at 37 dB, SynthLink answers] BinModem's text ${tcm ? 'read exactly' : 'garbled, as it must be'} — ${JSON.stringify(res.slRx.toString('latin1').slice(0, 30))}`);
  }
  // A false E. At 36 dB BinModem never leaves its own S̄, and a noise group that
  // passed E's sync cells took this end into data at a rate never agreed.
  for (const cls of ['V32', 'V32bis']) {
    const res = await run(cls, 'originate', true, 0, { lossDb: 10, noiseDb: 36, bmLevelDb: -13 });
    ok(!!res.bmConnected === !!res.slReady,
       `[${cls}, noise at 36 dB, SynthLink calls] we are in data only if BinModem is — ${res.bmConnected ? 'both' : res.slReady ? 'we went ready alone' : 'neither'} (${res.synthObj.falseE || 0} false E read past)`);
  }

  // §5.5 / §7, retrain. Each end writes AFTER once it is retrained.
  const AFTER = 'AFTER THE RETRAIN\r\n';
  async function retrainCall(cls, role, line, prep, peerArgs = [], secs = 12) {
    const M = require(path.join(ROOT, 'vendor', 'src', 'dsp', 'protocols', cls))[cls];
    const synth = new M(role);
    synth.setV8Complete(true);
    if (prep) prep(synth);
    const log = [];
    synth.on('retrain', (e) => log.push({ why: e.why, t: synth._clockRx / 8000 }));
    synth.on('retrained', (e) => { log.push({ bps: e.bps, t: synth._clockRx / 8000 }); synth.write(Buffer.from(AFTER)); });
    const res = await call({ synth, secs, send: TO_BM, ...line,
      peer: ['--proto', cls.toLowerCase(), '--role', role === 'originate' ? 'answer' : 'call', '--send', TO_SL, ...peerArgs] });
    const phases = res.bm.filter((e) => e.ev === 'phase').map((e) => e.phase);
    return { res, log, reconnected: phases.filter((p) => p === 'connected').length >= 2 };
  }
  // BinModem retrains and we follow: noise at 25 dB on its side of the
  // line only for two seconds, so ours is clean and it is BinModem that finds reception
  // unsatisfactory. Without §5.5 our receiver decoded its AA as a flood of bytes.
  for (const role of ['answer', 'originate']) {
    const { res, log, reconnected } = await retrainCall('V32', role,
      { lossDb: 10, noiseDb: 60, bmLevelDb: -13, worse: { at: role === 'answer' ? 4 : 7, until: role === 'answer' ? 6 : 9, noiseDb: 25, only: 'bm' } },
      (x) => x.setTrellis(true), ['--v32-trellis'], 14);
    const tag = `[V32 trellis, noise toward BinModem only, SynthLink ${role === 'originate' ? 'calls' : 'answers'}, BinModem retrains]`;
    const began = log.find((e) => e.why), done = log.find((e) => e.bps);
    ok(began && began.why === 'far end' && done && reconnected,
       `${tag} we followed its retrain and both came back — ${began ? `${began.why} at ${began.t.toFixed(2)} s` : 'no retrain'}, ${done ? `at ${done.bps}` : 'not retrained'}`);
    ok(res.slRx.toString('latin1') === TO_SL, `${tag} nothing of its retrain reached our receive — ${res.slRx.length} bytes`);
    ok(res.bmRx.toString('latin1').endsWith(AFTER), `${tag} our text after the retrain reached BinModem`);
  }
  // A second of noise at 25 dB in the middle of a call, both roles. BinModem sends
  // its text 8 s after its first connect, which is after the retrain.
  for (const role of ['originate', 'answer']) {
    const { res, log, reconnected } = await retrainCall('V32bis', role,
      { lossDb: 10, noiseDb: 60, bmLevelDb: -13, worse: { at: 6.5, until: 7.5, noiseDb: 25 } }, null, ['--send-delay', '8'], 16);
    const tag = `[V32bis, a second of noise at 25 dB, SynthLink ${role === 'originate' ? 'calls' : 'answers'}]`;
    const done = log.find((e) => e.bps);
    ok(log.some((e) => e.why) && done && reconnected,
       `${tag} retrained, both ends — ${log.map((e) => e.why || e.bps).join(', ')}`);
    ok(res.slRx.toString('latin1').endsWith(TO_SL), `${tag} BinModem's text, sent after the retrain, read exactly`);
    ok(res.bmRx.toString('latin1').endsWith(AFTER), `${tag} ours after the retrain reached BinModem`);
  }

  // The first rate from the line. Our error on the far end's conditioning signal
  // (four states far apart, the line's own noise) leaves out of R2/R3 the rates it
  // would be unsatisfactory at, so a noisy line comes up at what it can carry
  // rather than at 14 400 and retraining a second later.
  // 44 and 40 were the 42 and 38 these were written at, before bmLevelDb went
  // from −11 to −13 (see the 37 dB section above): the same SNR at our receiver.
  // 39, not 40: at 40 the caller's error sat at 0.72–0.75 against 9600's 0.75, on
  // the edge, and which side it fell depended on the canceller training (and being
  // undone) beside the equaliser. Both rates came up there with text exact.
  for (const [noiseDb, want] of [[44, 12000], [39, 7200]]) {
    for (const role of ['originate', 'answer']) {
      const res = await run('V32bis', role, true, 0, { lossDb: 10, noiseDb, bmLevelDb: -13 });
      const s = res.synthObj;
      const tag = `[V32bis, noise at ${noiseDb} dB, SynthLink ${role === 'originate' ? 'calls' : 'answers'}]`;
      ok(res.slReady && res.slReady.info.bps === want && res.bmConnected && new RegExp(`Connected\\(${want}\\)`).test(res.bmConnected.status) && !s.retrains,
         `${tag} both ends straight to ${want}, no retrain — ${res.slReady ? res.slReady.info.bps : 'no'} / ${res.bmConnected ? res.bmConnected.status : 'no'}, line error ${s._lineErr != null ? s._lineErr.toFixed(3) : '—'}`);
      ok(res.slRx.toString('latin1') === TO_SL && res.bmRx.toString('latin1').endsWith(TO_BM), `${tag} text through both ways`);
    }
  }

  // Loss alone, SynthLink answering: BinModem's call modem missed a CA sent at
  // exactly §5.4.2's 64 T of AA between 3 and 8 dB (V32Preface.js AA_HEARD).
  for (const cls of ['V32', 'V32bis']) {
    for (const lossDb of [3, 6]) {
      const res = await run(cls, 'answer', true, 0, { lossDb });
      ok(res.slRx.toString('latin1') === TO_SL && res.bmRx.toString('latin1').endsWith(TO_BM),
         `[${cls}, ${lossDb} dB of loss, SynthLink answers] connected, text through both ways — ${res.bmConnected ? res.bmConnected.status : 'no connect'}`);
    }
  }

  // The control: the same line with the canceller held off. It runs on every call
  // by default, as a real modem's does, so the control has to turn it off. If this
  // passes, the line is not testing the canceller.
  {
    const res = await run('V32', 'originate', true, 0, TWO, (x) => x.setEchoCanceller(false));
    ok(res.slRx.toString('latin1') !== TO_SL, `[V32 2-wire, no canceller] our receive fails, as it must — ${res.slRx.length} bytes`);
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
