'use strict';
/**
 * §11.2.2 — does Phase 2 complete without falling back on a recovery bound?
 *
 * Two things here have to be the way they are, and both were found by a harness
 * that was green while `bundle-smoke` was failing beside it.
 *
 * ONE: the pump must be REAL TIME. Phase 2's steps are counted on the transmit
 * sample clock while their end conditions arrive on the receive one, and a
 * synchronous loop keeps those two in lockstep — which is exactly the condition
 * under which this failure does not happen. So both modems are started and left to
 * their own timers, audio↔audio.
 *
 * TWO: each call runs in a COLD CHILD PROCESS, and that is the load. Twelve calls
 * in one process are twelve clean connects: by the second one V8 has optimised the
 * receiver and there is CPU to spare. A fresh process spends its first seconds in
 * unoptimised code, which is where the two ends' sample clocks separate — and a
 * fresh process is also what a real visitor gets, one per page load. Running the
 * calls in a loop in one process measures the wrong thing and says PASS.
 *
 * The originate end is the browser BUNDLE and the answer end the vendored source,
 * which is the arrangement that ships. `npm run build` first or this runs a stale
 * DSP against fresh source.
 *
 * What is asserted, per run and per end:
 *   - both ends reach data mode inside the deadline;
 *   - `phase2Incomplete` is false — INFO1 was received;
 *   - `phase2TimedOut` is empty. Every name in it is a §11.2.2 bound that expired
 *     and a recovery action that ran. On this transport there is no propagation
 *     delay and nothing for a bound to absorb, so a recovery here is a defect
 *     however well it recovered — which is why a run that fires one and still
 *     connects prints its list and fails.
 *
 * RUNS=<n> (default 12) and SECS=<n> (per-call deadline, default 20). It does not
 * prove a recovery WORKS; that wants a fault injected on purpose and is not here.
 *
 * PROTO=V90 runs the same assertions over §9.2/V.90, which is the same procedure
 * with the two modems renamed and runs on the same machine — so the same harness is
 * the right one, and a bound that fires there means what it means here. The V.34
 * instance it inspects is the one V90.js owns.
 */
const path = require('path');

// ── one call, in the child ──────────────────────────────────────────────────
if (process.env.V34P2_ONECALL) {
  const fs = require('fs');
  // The bundle is evaluated BEFORE the vendored source is required, which is the
  // order `bundle-smoke` uses and the order a cold process's optimiser sees.
  const bundlePath = path.join(__dirname, '..', '..', 'public', 'dsp-bundle.js');
  const Bundle = new Function(fs.readFileSync(bundlePath, 'utf8') + '\nreturn SynthModemDSP;')();
  const config = require('../../vendor/synthlink-config');
  const { ModemDSP } = require('../../vendor/src/dsp/ModemDSP');
  const PROTO = process.env.PROTO || 'V34';
  for (const c of [Bundle.config, config]) {
    c.modem.native.protocolPreference = [PROTO];
    c.modem.native.v8ModulationModes = [PROTO];
  }
  const SECS = parseInt(process.env.SECS || '20', 10);
  /**
   * The live V.34 instance behind a ModemDSP. Private, and a harness may look.
   * Under V.90 it is the upstream instance V90.js owns, which is where §9.2 runs.
   */
  const proto = (dsp) => {
    const p = (dsp._handshake && dsp._handshake._protocol) || {};
    return p.up || p;
  };
  const o = new Bundle.ModemDSP('originate');
  const a = new ModemDSP('answer');
  // How far each end's transmit clock has drifted from real time. Every duration in
  // Phase 2 is counted in transmitted samples, so an end whose pump falls behind is
  // late on the wire by exactly this much while its peer's bounds run on regardless.
  const sent = { originate: 0, answer: 0 };
  o.on('audioOut', (s) => { sent.originate += s.length; a.receiveAudio(s); });
  a.on('audioOut', (s) => { sent.answer += s.length; o.receiveAudio(s); });
  const t0 = Date.now();
  let oc = false, ac = false, ended = false;
  const finish = (why) => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    const rec = (dsp, role) => {
      const p = proto(dsp);
      // On a failure the interesting thing is where Phase 2 STOPPED, and only the
      // live state says that — `phase2TimedOut` does not exist until it settles.
      const p2 = p._p2;
      const at = p2 && p2.steps && p2.steps[p2.step];
      return {
        role, timedOut: p.phase2TimedOut || null, incomplete: !!p.phase2Incomplete,
        lagMs: Math.round(1000 * ((Date.now() - t0) / 1000 - sent[role] / 8000)),
        stuck: p2 && !p2.settled ? {
          step: at ? at.name : '(past the end)', ms: Math.round(1000 * p2.inStep / 8000),
          info0: !!p2.peerInfo0, info1: !!p2.peerInfo1, rev: p2.peerRev,
          toneOn: p2.toneOn, probeEnded: p2.probeEnded, so_far: p2.timedOut.slice(),
        } : null,
      };
    };
    process.stdout.write(JSON.stringify({
      why, secs: (Date.now() - t0) / 1000, oc, ac,
      ends: [rec(o, 'originate'), rec(a, 'answer')],
    }) + '\n');
    o.stop(); a.stop();
    process.exit(0);
  };
  const both = () => { if (oc && ac) setTimeout(() => finish('connected'), 150); };
  o.on('connected', () => { oc = true; both(); });
  a.on('connected', () => { ac = true; both(); });
  const timer = setTimeout(() => finish('timeout'), SECS * 1000);
  o.start(); a.start();
  return;
}

// ── the runner ──────────────────────────────────────────────────────────────
const { spawnSync } = require('child_process');
const RUNS = parseInt(process.env.RUNS || '12', 10);
const SECS = parseInt(process.env.SECS || '20', 10);
let bad = 0;
for (let i = 1; i <= RUNS; i++) {
  const child = spawnSync(process.execPath, [__filename], {
    env: { ...process.env, V34P2_ONECALL: '1', SECS: String(SECS) },
    encoding: 'utf8', timeout: (SECS + 15) * 1000,
  });
  const line = (child.stdout || '').trim().split('\n').pop();
  let r = null;
  try { r = JSON.parse(line); } catch (e) { /* reported below */ }
  const problems = [];
  if (!r) problems.push(`child produced no result${child.stderr ? `: ${child.stderr.trim().split('\n')[0]}` : ''}`);
  else {
    if (r.why === 'timeout') problems.push(`no connect in ${SECS}s (o=${r.oc} a=${r.ac})`);
    for (const e of r.ends) {
      if (e.timedOut === null) {
        problems.push(`${e.role}: Phase 2 never settled` +
          (e.stuck ? ` — stuck in ${JSON.stringify(e.stuck)}` : ''));
      }
      else if (e.timedOut.length) problems.push(`${e.role}: recovered at [${e.timedOut.join(', ')}] (clock ${e.lagMs > 0 ? '+' : ''}${e.lagMs} ms behind real time)`);
      if (e.incomplete) problems.push(`${e.role}: INFO1 never received`);
    }
  }
  if (problems.length) bad++;
  console.log(`run ${String(i).padStart(2)}/${RUNS}  ${r ? r.secs.toFixed(1) + 's' : '   -'}  ` +
    (problems.length ? `❌ ${problems.join(' | ')}` : '✅'));
}
const WHAT = `${process.env.PROTO || 'V34'} PHASE 2 RECOVERY`;
console.log(bad ? `\n${WHAT} FAIL ❌ — ${bad}/${RUNS} runs did not complete cleanly`
                : `\n${WHAT} PASS ✅ — ${RUNS}/${RUNS} clean`);
process.exit(bad ? 1 : 0);
