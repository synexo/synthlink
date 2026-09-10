'use strict';
// phasetest — the handshake `phase` event, and the labels the status line shows.
//
// Two halves that fail for different reasons.
//
// The DSP half drives a real connect for each protocol and asserts the SEQUENCE
// of reported signals. It is a behaviour test: `describe()` reads state the
// transmitter already keeps, so a step list or a stage machine that is rewired
// shows up here as a changed sequence rather than as a silent gap in the UI.
//
// The label half extracts HANDSHAKE_LABELS from public/main.js by name — main.js
// runs against a live DOM and cannot be required, the same trick bustest and
// attest use — and holds it against what the DSP actually emits. The two drift
// apart in both directions and each is a real defect: a signal the DSP reports
// with no label is a status line that goes quiet mid-handshake, and a label for
// a signal nothing emits is a dead entry that will be believed later.
//
// Note the labels are deliberately a SUBSET. Several Phase 2 steps are 10-40 ms
// and the waits are not signals, so they are not shown; the test asserts that
// the subset is the intended one rather than that it is complete.
//
//   node tools/tests/phasetest.js
const fs = require('fs');
const path = require('path');

const cfg = require('../../vendor/synthlink-config');
const { ModemDSP } = require('../../vendor/src/dsp/ModemDSP');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log(`  FAIL ${m}`); } };

// ── the label table, out of main.js ─────────────────────────────────────────
const SRC = fs.readFileSync(path.join(__dirname, '../../public/main.js'), 'utf8');
const m = SRC.match(/const HANDSHAKE_LABELS = \{[\s\S]*?\n\};/);
if (!m) throw new Error('phasetest: could not find HANDSHAKE_LABELS in public/main.js');
const LABELS = new Function(`${m[0]}\nreturn HANDSHAKE_LABELS;`)();

console.log('\nlabels');
ok(Object.keys(LABELS).length > 20, `the table has entries (${Object.keys(LABELS).length})`);
for (const [sig, text] of Object.entries(LABELS)) {
  // "spec name — terse gloss", and terse is the point: #status is nowrap with an
  // ellipsis, so a long label is a truncated one.
  ok(typeof text === 'string' && text.length > 0 && text.length <= 32,
     `${sig} label is present and short (${text.length} chars: "${text}")`);
}

// ── a real connect per protocol ─────────────────────────────────────────────
function trace(proto, ms = 25000) {
  return new Promise((resolve) => {
    cfg.modem.native.protocolPreference = [proto];
    cfg.modem.native.v8ModulationModes = [proto];
    const A = new ModemDSP('originate'), B = new ModemDSP('answer');
    const seen = [];
    const t0 = Date.now();
    let junk = 0, upA = null, upB = null;
    A.on('phase', (d) => seen.push(d));
    // Anything the calling side decodes BEFORE it is connected. A demodulator
    // frames 0xFF out of a carrier coming up — start bit, then eight marks — and
    // that byte used to reach the terminal ahead of the session.
    A.on('data', (b) => { if (upA === null) junk += b.length; });
    A.on('audioOut', (f) => B.receiveAudio(f));
    B.on('audioOut', (f) => A.receiveAudio(f));
    let up = 0, done = false;
    const finish = () => {
      if (done) return; done = true;
      try { A.stop(); B.stop(); } catch (_) { /* already stopped */ }
      resolve({ seen, junk, upA, upB });
    };
    const upped = () => { if (++up === 2) setTimeout(finish, 400); };
    A.on('connected', () => { upA = (Date.now() - t0) / 1000; upped(); });
    B.on('connected', () => { upB = (Date.now() - t0) / 1000; upped(); });
    A.start(); B.start();
    setTimeout(finish, ms);
  });
}

(async () => {
  const emitted = new Set();

  for (const [proto, wanted] of Object.entries({
    // The signals each protocol's calling side must report, in order. Not the
    // whole sequence — the ones whose absence would mean a phase stopped being
    // reported at all.
    V34:    ['ANSam', 'CM', 'CJ', 'INFO0c', 'L1', 'L2', 'INFO1c', 'TRN', 'data'],
    // V.90's calling side is the ANALOGUE modem, and §9.2 gives it the part §11.2
    // gives the ANSWER modem — so its INFO is INFO0a/INFO1a and its tone is A, the
    // mirror of V.34's. Expecting INFO0c here is the same mistake setPhase2Profile
    // exists to prevent.
    V90:    ['ANSam', 'CM', 'CJ', 'INFO0a', 'L1', 'L2', 'INFO1a', 'TRN', 'data'],
    V32bis: ['ANSam', 'CM', 'CJ', 'TRN', 'data'],
    V22bis: ['ANSam', 'CM', 'CJ', 'data'],
    // Bell 103 bypasses V.8 entirely — V.8 has no modulation bit for it — so
    // there is no CI/ANSam/CM to report at all. It goes straight to carrier.
    Bell103: ['mark', 'data'],
  })) {
    console.log(`\n${proto}`);
    const r = await trace(proto);
    const { seen, junk, upA, upB } = r;
    for (const d of seen) emitted.add(d.signal);
    const names = seen.map((d) => d.signal);
    ok(names.length > 0, `${proto} reported something (${names.length} transitions)`);

    // In order, allowing anything in between: the procedure may insert recovery
    // steps and this is not a test of which.
    let i = 0;
    for (const w of wanted) {
      const at = names.indexOf(w, i);
      ok(at >= 0, `${proto} reports ${w}${at < 0 ? ` (got: ${names.join(' ')})` : ''}`);
      if (at >= 0) i = at + 1;
    }
    // Every signal this protocol is EXPECTED to reach must have a label, or the
    // status line silently stops updating at that point in the handshake. The
    // reverse direction is checked at the end; this is the one that matters more,
    // because a missing label looks like a working UI that has simply stalled.
    for (const w of wanted) {
      if (w === 'data') continue;            // deliberately unlabelled, see the table
      ok(!!LABELS[w], `${proto}'s ${w} has a status-line label`);
    }

    // Phases only ever advance to data, and data is TERMINAL. Reporting it once
    // and then reporting something else means the status line was overwritten
    // after the terminal went live — and the way that happened before was a
    // generic "training" in the gap between two bursts, which is not adjacent to
    // the data reports it sits between and so is invisible to the repeat check.
    const last = seen[seen.length - 1];
    ok(last && last.signal === 'data', `${proto} ends on data (got ${last && last.signal})`);
    const firstData = names.indexOf('data');
    ok(firstData < 0 || firstData === names.length - 1,
       `${proto} reports data once, at the end (first at ${firstData} of ${names.length - 1}` +
       `${firstData >= 0 && firstData !== names.length - 1 ? `; after it: ${names.slice(firstData + 1).join(' ')}` : ''})`);
    // A protocol with its own describe() never falls back to the generic label.
    // That fallback firing mid-handshake is the same defect seen from the front.
    const genericAt = names.indexOf('train');
    ok(genericAt < 0 || proto === 'V22bis',
       `${proto} names its own signals rather than falling back to "train"`);
    // Every report names the protocol once V.8 has settled.
    ok(seen.some((d) => d.protocol), `${proto} reports carry a protocol name`);
    // No repeats back to back — the event is a CHANGE, and one that fires every
    // block would be a status line rewritten 50 times a second.
    let repeats = 0;
    for (let k = 1; k < seen.length; k++) {
      if (seen[k].signal === seen[k - 1].signal && seen[k].phase === seen[k - 1].phase) repeats++;
    }
    ok(repeats === 0, `${proto} emits on change only (${repeats} consecutive repeats)`);

    // Nothing reaches the terminal before the session does.
    ok(junk === 0, `${proto} delivers no bytes before data mode (${junk} junk bytes)`);
    // Both ends arrive together. A protocol whose two halves are paced by
    // different constants drifts apart, and the caller then types into a link
    // the answerer has not finished bringing up.
    ok(upA !== null && upB !== null && Math.abs(upA - upB) < 0.5,
       `${proto} brings both ends up together (originate ${upA}s, answer ${upB}s)`);
  }

  // ── Bell 103 is paced off the capture, not off a default ──────────────────
  // tools/datasource/bell103-capture.wav: 2.51 s of answer tone, the originate
  // carrier up as it ends, then exactly 1.00 s of mark idle before the first
  // data bit — 3.50 s in total. A Bell 103 call that connects in 0.70 s, which
  // is what the bare V.8 bypass did, is a modem noise nobody ever heard.
  console.log('\nBell 103 pacing');
  {
    const r = await trace('Bell103');
    ok(r.upA > 2.8 && r.upA < 4.2,
       `a Bell 103 call takes about as long as the capture's 3.50 s (got ${r.upA}s)`);
  }

  // ── the two halves against each other ─────────────────────────────────────
  console.log('\nlabels against what the DSP emits');
  const labelled = [...emitted].filter((s) => LABELS[s]);
  ok(labelled.length >= 8, `the connects exercised ${labelled.length} labelled signals`);
  // Every label must be for something reachable. A dead entry is a claim about
  // the protocol that nothing checks.
  const REACHED_ELSEWHERE = new Set([
    // Answer-side and V.90-digital-side names, plus the V.32 family's rate
    // signals: real states this rig's CALLING side does not enter.
    'INFO0a', 'INFO0d', 'INFO1a', 'A', 'ANS', 'JM', 'sd', 'trn1d', 'jd', 'jprimed',
    'dil', 'p4', 'R1', 'R2', 'R3', 'E', 'p4-cpt', 'p4-cp', 'p4-cpprime', 'p4-e',
    'p4-trn', 'jprime', 'train',
  ]);
  for (const sig of Object.keys(LABELS)) {
    ok(emitted.has(sig) || REACHED_ELSEWHERE.has(sig),
       `label "${sig}" is for a signal something reports`);
  }

  console.log(`\n${fail === 0 ? 'OK' : 'FAILED'} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
