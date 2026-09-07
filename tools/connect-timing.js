#!/usr/bin/env node
// connect-timing.js — how long a connect takes, and where its energy is.
//
//     node tools/connect-timing.js                    # every menu protocol
//     node tools/connect-timing.js V90 V34            # just these
//     BINS=1 node tools/connect-timing.js V90         # + the 100 ms RMS trace
//
// BY HAND, like tools/jitter-repro.js, and on no test path. It asserts nothing:
// it reports how long a connect takes and where the energy is, so that "the
// audio actually moved" is a measurement rather than an impression.
//
// WHAT IT MEASURES, and why it is defined this way
//
// Two ModemDSPs wired audio↔audio, originate↔answer, exactly as dsptest2 does —
// this is the same rig with the assertions taken out and a clock put in. The
// span reported is **ANSam onset to the later of the two `connected` events**,
// because that is the interval a caller experiences as "the modem noises": it
// starts when the answer side first puts energy on the line and ends when both
// ends are in data mode. Anything before ANSam is the off-hook gap, reported
// separately rather than folded in, since a longer gap is not a longer
// handshake.
//
// Sample counts, not wall clock. The rig runs as fast as the event loop allows,
// so Date.now() would measure this machine and not the protocol; every figure
// here is derived from samples emitted at SR.
//
// The per-direction RMS trace in 100 ms bins is what tells silence from signal:
// a phase that exists but is inaudible and a phase that does not exist both
// take zero seconds on a stopwatch and look different in the trace. `GAPS=1`
// summarises it as the runs of near-silence per direction. A missing phase is a
// gap in that summary, which is the point: it is meant to show up, get filled,
// and stop showing up.
//
// SynthLink's own code, GPL-3.0-or-later.

'use strict';

const config = require('../vendor/synthlink-config');
const { ModemDSP } = require('../vendor/src/dsp/ModemDSP');

const SR = config.modem.sampleRate || 8000;
const BIN_MS = 100;
const BIN = Math.round(SR * BIN_MS / 1000);
// Below this RMS a bin is "silence". Well under the ~0.1 RMS of the modulated
// protocols and far under V.90 downstream's ~0.37, and above the numerical
// noise an all-zero block leaves behind.
const FLOOR = 0.002;

const MENU = ['V21', 'Bell103', 'V22', 'V23', 'V22bis', 'V32', 'V32bis', 'V34', 'V90'];
// Wall-clock ceiling per protocol, in emitted seconds. Not a budget for the
// connect — a stop so a protocol that never comes up cannot run forever.
const CEILING = { V21: 30, Bell103: 30, V23: 20, V22: 20 };

function measure(PROTO) {
  return new Promise((resolve) => {
    config.modem.native.protocolPreference = [PROTO];
    config.modem.native.v8ModulationModes = [PROTO];
    const A = new ModemDSP('originate');
    const B = new ModemDSP('answer');

    // Sample position per direction, and the bins.
    const pos = { a: 0, b: 0 };
    const bins = { a: [], b: [] };
    let ansamAt = null;                       // first answer-side energy
    let upA = null, upB = null, done = false;
    const limit = SR * (CEILING[PROTO] || 20);

    const account = (dir, f) => {
      let p = pos[dir];
      for (let i = 0; i < f.length; i++) {
        const b = Math.floor((p + i) / BIN);
        bins[dir][b] = (bins[dir][b] || 0) + f[i] * f[i];
      }
      if (dir === 'b' && ansamAt === null) {
        for (let i = 0; i < f.length; i++) {
          if (Math.abs(f[i]) > FLOOR) { ansamAt = p + i; break; }
        }
      }
      pos[dir] = p + f.length;
    };

    const finish = () => {
      if (done) return; done = true;
      try { A.stop(); B.stop(); } catch (_) { /* already stopped */ }
      const rms = (dir) => Array.from(bins[dir], (s, i) =>
        Math.sqrt((s || 0) / Math.min(BIN, Math.max(1, pos[dir] - i * BIN))));
      const both = (upA !== null && upB !== null) ? Math.max(upA, upB) : null;
      resolve({
        PROTO,
        offHookS: ansamAt === null ? null : ansamAt / SR,
        connectS: (both === null || ansamAt === null) ? null : (both - ansamAt) / SR,
        totalS: both === null ? null : both / SR,
        upA: upA === null ? null : upA / SR,
        upB: upB === null ? null : upB / SR,
        rms: { a: rms('a'), b: rms('b') },
      });
    };

    A.on('audioOut', (f) => { account('a', f); B.receiveAudio(f); if (pos.a > limit) finish(); });
    B.on('audioOut', (f) => { account('b', f); A.receiveAudio(f); if (pos.b > limit) finish(); });
    // The sample position at the moment each end reports data mode. Taken from
    // that end's OWN emitted count, which is the only clock the rig has.
    A.on('connected', () => { upA = pos.a; if (upB !== null) setTimeout(finish, 0); });
    B.on('connected', () => { upB = pos.b; if (upA !== null) setTimeout(finish, 0); });

    A.start(); B.start();
  });
}

// Runs of consecutive silent bins, as [startSeconds, lengthSeconds].
function gaps(rms, untilBin) {
  const out = [];
  let run = -1;
  for (let i = 0; i <= untilBin; i++) {
    const quiet = !(rms[i] > FLOOR);
    if (quiet && run < 0) run = i;
    if (!quiet && run >= 0) { out.push([run * BIN_MS / 1000, (i - run) * BIN_MS / 1000]); run = -1; }
  }
  if (run >= 0) out.push([run * BIN_MS / 1000, (untilBin + 1 - run) * BIN_MS / 1000]);
  return out;
}

(async () => {
  const want = process.argv.slice(2).filter((a) => !a.includes('='));
  const list = want.length ? want : MENU;
  console.log(`connect timing — ANSam onset to both ends in data mode, ${BIN_MS} ms bins\n`);
  console.log('  protocol   off-hook   connect    total     originate  answer');
  for (const p of list) {
    const r = await measure(p);
    const f = (v) => (v === null ? '   —   ' : (v.toFixed(2) + ' s').padStart(7));
    console.log(`  ${p.padEnd(10)} ${f(r.offHookS)}   ${f(r.connectS)}   ${f(r.totalS)}` +
      `   ${f(r.upA)}    ${f(r.upB)}`);
    if (r.connectS === null) { console.log('    (no connect — nothing to trace)'); continue; }
    const untilBin = Math.ceil(r.totalS * 1000 / BIN_MS);
    if (process.env.GAPS || process.env.BINS) {
      for (const dir of ['a', 'b']) {
        const label = dir === 'a' ? 'originate' : 'answer   ';
        const g = gaps(r.rms[dir], untilBin).filter(([, len]) => len >= 0.2);
        console.log(`    ${label} silence ≥0.2 s: ` +
          (g.length ? g.map(([s, l]) => `${s.toFixed(1)}–${(s + l).toFixed(1)} s`).join(', ') : 'none'));
      }
    }
    if (process.env.BINS) {
      for (const dir of ['a', 'b']) {
        const label = dir === 'a' ? 'originate' : 'answer   ';
        console.log(`    ${label} ` + Array.from({ length: untilBin + 1 },
          (_, i) => ' .:-=+*#%@'[Math.min(9, Math.round((r.rms[dir][i] || 0) * 25))]).join(''));
      }
    }
  }
  process.exit(0);
})();
