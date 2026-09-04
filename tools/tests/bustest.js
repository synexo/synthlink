// bustest — the local mix bus, in Node, with no browser and no AudioContext.
//
// The bus is the one place carrier audio, call-progress tones and the handset
// clip are mixed, and it is what the oscilloscope and the spectrum read. That
// makes the whole visual chain a pure function of PCM, which is the point of
// this file: before the bus existed the scope read an AnalyserNode, so it could
// only be tested through a real browser — and the case that actually broke
// (`connect=auto`, where the AudioContext never starts) was not reachable even
// there, because headless Chromium does not enforce the autoplay policy.
//
// monitor and tones are extracted from public/main.js by name; main.js cannot be
// required, it runs against a live DOM. Renaming either throws here rather than
// testing a stale copy.
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '../../public/main.js'), 'utf8');
const SR = 8000;

function grab(re, what) {
  const m = SRC.match(re);
  if (!m) throw new Error(`bustest: could not find ${what} in public/main.js`);
  return m[0];
}

// Constants and the two objects under test, evaluated in a scope that supplies
// the handful of globals they close over.
const consts = grab(/const BUS_LEN = [\s\S]*?const BUS_PUMP_MS = \d+;/, 'the bus constants');
const dialToneConsts = grab(/const DIALTONE_S = [\s\S]*?const DIALTONE_BUSY_GAP_MS = \d+;/,
                            'the dial-tone constants');
const fft = grab(/function fftInPlace[\s\S]*?\n\}\n/, 'fftInPlace');
const monSrc = grab(/const monitor = \{[\s\S]*?\n\};/, 'the monitor object');
const tonesSrc = grab(/const tones = \{[\s\S]*?\n\};/, 'the tones object');

const SCOPE_FFT = 2048;
let clock = 0;                                  // a clock we control, in ms
const performanceStub = { now: () => clock };
const prefs = { get: () => 'auto' };

const sandbox = new Function('SR', 'SCOPE_FFT', 'performance', 'prefs', `
  ${consts}
  ${dialToneConsts}
  ${fft}
  ${monSrc}
  ${tonesSrc}
  return { monitor, tones, BUS_LEN, BUS_WRITE_LEAD, BUS_POST_LEAD,
           DIALTONE_S, DIALTONE_MIN_MS, DIALTONE_BUSY_GAP_MS };
`);
const { monitor, tones, BUS_LEN, BUS_WRITE_LEAD, BUS_POST_LEAD,
        DIALTONE_S, DIALTONE_MIN_MS, DIALTONE_BUSY_GAP_MS } =
  sandbox(SR, SCOPE_FFT, performanceStub, prefs);

// The sink is absent throughout: monitor.node stays null, which is exactly the
// state a suspended AudioContext leaves it in. Everything below therefore
// exercises the connect=auto path.
monitor._startPump = function () {};             // no timers in a test

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; } else { fail++; console.log(`  FAIL ${msg}`); }
}
function near(a, b, tol, msg) { ok(Math.abs(a - b) <= tol, `${msg} (got ${a}, want ~${b})`); }
function advance(ms) { clock += ms; monitor._pump(); }
// A clip still sounding is deliberately carried across reset(), so a block that
// wants an empty bus has to drop them — otherwise the previous block's dial tone
// turns up underneath this one's arithmetic. That is the code being right.
function fresh() {
  monitor.stopClips('progress'); monitor.stopClips('handset');
  clock = 0; monitor.reset();
}

function peak(a) { let p = 0; for (const v of a) p = Math.max(p, Math.abs(v)); return p; }

// ── the play position runs on the wall clock, with or without audio ──────────
console.log('\nplay position');
monitor.reset();
ok(monitor.playPos() === 0, 'starts at zero');
clock += 1000;
near(monitor.playPos(), SR, 1, 'advances at the sample rate with no sink at all');

// ── carrier: what is fed is what the scope reads, at the right moment ────────
console.log('\ncarrier through the bus');
clock = 0; monitor.reset();
const frame = new Float32Array(160);
for (let i = 0; i < frame.length; i++) frame[i] = Math.sin(2 * Math.PI * 1800 * i / SR);
// One second of carrier, fed in real time the way the DSP feeds it.
for (let k = 0; k < 50; k++) { monitor.feed('tx', frame); advance(20); }

const win = new Float32Array(SCOPE_FFT);
monitor.readTimeDomain(win);
ok(peak(win) > 0.5, 'the scope sees the carrier with no AudioContext in existence');

// The lead is real: samples are written ahead of what is being heard.
ok(monitor.wcur.tx - monitor.playPos() > BUS_POST_LEAD,
   'writers stay ahead of the play position');

// ── the spectrum finds the tone the carrier is actually made of ──────────────
console.log('\nspectrum');
const bins = new Uint8Array(SCOPE_FFT / 2);
for (let i = 0; i < 20; i++) monitor.readSpectrum(bins);   // let the smoothing settle
let top = 0;
for (let k = 1; k < bins.length; k++) if (bins[k] > bins[top]) top = k;
near(top * (SR / 2) / bins.length, 1800, 20, 'peak bin is the carrier frequency');

// ── tones are on the bus, so they are on the scope ───────────────────────────
console.log('\ncall-progress tones');
clock = 0; monitor.reset();
const dial = new Float32Array(SR);
tones.renderDual(dial, 0, 350, 440, 1.0, 0.20);
near(peak(dial), 0.40, 0.02, 'two sines into one level is the loudness it replaced');
monitor.playClip(dial);
advance(Math.round((BUS_WRITE_LEAD / SR) * 1000) + 100);
monitor.readTimeDomain(win);
ok(peak(win) > 0.2, 'the dial tone reaches the scope with no audio path at all');

for (let i = 0; i < 20; i++) monitor.readSpectrum(bins);
const peaks = [];
for (let k = 2; k < bins.length - 1; k++) {
  if (bins[k] > bins[k - 1] && bins[k] > bins[k + 1] && bins[k] > 200) {
    peaks.push(Math.round(k * (SR / 2) / bins.length));
  }
}
ok(peaks.some((f) => Math.abs(f - 350) < 25) && peaks.some((f) => Math.abs(f - 440) < 25),
   `both dial-tone frequencies are in the spectrum (found ${peaks.join(', ')})`);

// ── a clip and the carrier are summed, not one or the other ──────────────────
console.log('\nmixing');
fresh();
monitor.playClip(dial);
for (let k = 0; k < 30; k++) { monitor.feed('tx', frame); advance(20); }
advance(Math.round((BUS_WRITE_LEAD / SR) * 1000));
monitor.readTimeDomain(win);
ok(peak(win) > 0.5, 'carrier and tone are both present at once');

// ── cancelling a clip removes the clip and leaves the carrier ────────────────
console.log('\ncancelling a clip');
fresh();
const flat = new Float32Array(SR).fill(0.5);      // a clip we can identify by value
monitor.feed('tx', new Float32Array(SR).fill(0.25));
const clip = monitor.playClip(flat, 0, 'progress');
let probe = monitor.bus[(BUS_WRITE_LEAD + 100) % BUS_LEN];
near(probe, 0.75, 1e-6, 'clip sums onto the carrier already there');
monitor.stopClips('progress');
probe = monitor.bus[(BUS_WRITE_LEAD + 100) % BUS_LEN];
near(probe, 0.25, 1e-6, 'cancelling subtracts the clip and leaves the carrier intact');

// ── a handset clip survives the hang-up that ends the call ───────────────────
console.log('\nreset carries a sounding clip');
fresh();
monitor.playClip(new Float32Array(SR * 2).fill(0.3), 0, 'handset');
advance(500);
monitor.stopClips('progress');                    // what cleanup() does first
monitor.reset();
ok(monitor.clips.length === 1, 'the handset clip is carried across the reset');
// Everything already handed to the sink is gone, which is more than wall-clock
// playback alone — the post frontier leads the play position by design. So the
// remainder is shorter than the clip and no shorter than what is still unheard.
const rem = monitor.clips[0].pcm.length / SR;
ok(rem < 2 && rem >= 1.5, `carried with only its unplayed remainder (got ${rem.toFixed(2)}s)`);
advance(Math.round((BUS_POST_LEAD / SR) * 1000) + 50);
monitor.readTimeDomain(win);
ok(peak(win) > 0.2, 'and it is still sounding afterwards');

fresh();
monitor.playClip(dial, 0, 'progress');
monitor.stopClips('progress');
monitor.reset();
ok(monitor.clips.length === 0, 'a cancelled dial sequence is not carried');

// ── late frames are dropped for listening, never for the link ────────────────
console.log('\nlate frames');
fresh();
monitor.feed('tx', frame);
const before = monitor.wcur.tx;
clock += 5000;                                    // a five-second stall
monitor._pump();
monitor.feed('tx', frame);
ok(monitor.wcur.tx > monitor.playPos(),
   'a writer that fell behind resumes ahead of the play position rather than in the past');
ok(monitor.wcur.tx > before + frame.length,
   'and does not try to write into samples that are already gone');

// ── the ring cannot be overrun by a long call ────────────────────────────────
console.log('\nring');
fresh();
for (let k = 0; k < 1000; k++) { monitor.feed('tx', frame); advance(20); }
monitor.readTimeDomain(win);
ok(peak(win) > 0.5, 'still reading carrier after twenty seconds, well past one lap');
ok(Number.isFinite(monitor.busCleared) && monitor.busCleared > monitor.playPos(),
   'the clear frontier stays ahead of the play position');

// ── a tone that outlives its call must STOP ─────────────────────────────────
// The bug this pins: the ring is only zeroed by _reserve(), and _reserve() only
// runs from _mix(). While anything is writing — a carrier, a clip — the span
// ahead of the play position is always freshly zeroed. When NOTHING is writing,
// busCleared stops advancing and the pump reads back what was in the ring one
// lap ago and sounds it again, and again, every BUS_LEN samples.
//
// It could not happen until something had to make a sound after the call that
// caused it had ended: every hang-up before that reset the bus in the same tick
// the carrier stopped. The reorder tone on a failed connect is exactly that, and
// the symptom was a busy signal that never stopped — through the end of the
// call, and audible under the NEXT one.
console.log('\nan unattended bus goes quiet');
fresh();
// A sink and a running context, so the pump actually hands samples out and we
// can look at what a listener would have heard.
const heard = [];
monitor.sink = { push: (pcm) => heard.push(pcm), flush: () => { heard.length = 0; } };
monitor.ctx = { state: 'running', currentTime: 0 };

const beep = new Float32Array(SR);                 // one second of tone
tones.renderDual(beep, 0, 480, 620, 1.0, 0.2);
monitor.playClip(beep, 0, 'reorder');
// Play it out, then let the bus run on with NOTHING writing to it — well past a
// full lap of the ring, which is where the repeat used to arrive.
for (let k = 0; k < 100; k++) advance(20);         // 2 s: the clip finishes
heard.length = 0;                                  // everything from here is after it
const lapMs = (BUS_LEN / SR) * 1000;
for (let k = 0; k < (lapMs * 2) / 20; k++) advance(20);

let loudest = 0;
for (const chunk of heard) loudest = Math.max(loudest, peak(chunk));
ok(heard.length > 0, 'the pump is still handing samples to the sink');
ok(loudest < 1e-9,
   `silence once the clip has finished and nothing is writing (loudest ${loudest})`);
ok(monitor.busCleared >= monitor.postFrontier,
   'the clear frontier keeps up with the pump even with no writers');

// And the carrier case still works: a writer that IS writing must not be zeroed
// out from under itself by the same line that fixed the above.
console.log('\nand a live writer is not zeroed by the pump');
fresh();
monitor.sink = { push: (pcm) => heard.push(pcm), flush: () => { heard.length = 0; } };
monitor.ctx = { state: 'running', currentTime: 0 };
heard.length = 0;
for (let k = 0; k < 50; k++) { monitor.feed('tx', frame); advance(20); }
let carrierPeak = 0;
for (const chunk of heard) carrierPeak = Math.max(carrierPeak, peak(chunk));
ok(carrierPeak > 0.5, `a live carrier still reaches the sink (peak ${carrierPeak.toFixed(3)})`);
monitor.sink = null; monitor.ctx = null;

// ── the dial tone that covers the lookup ────────────────────────────────────
// The destination is resolved by the server, and until it answers there is
// nothing to DTMF. That used to be silence — the user pressed Connect and heard
// nothing at all, and on a name that did not resolve, nothing until the reorder
// tone. The tone now runs from the start of the call and is CUT when there is
// something to dial, so what matters here is that it is continuous while it
// lasts and that cutting it actually stops it.
console.log('\ndial tone across the lookup');
ok(tones.secs(DIALTONE_S) < BUS_LEN,
   `the dial tone fits the ring (${DIALTONE_S}s of ${BUS_LEN / SR}s) — a longer ` +
   'clip would wrap in _mix and overwrite its own head');

fresh();
const ear = [];
monitor.sink = { push: (pcm) => ear.push(pcm), flush: () => { ear.length = 0; } };
monitor.ctx = { state: 'running', currentTime: 0 };

const dt = new Float32Array(tones.secs(DIALTONE_S) + 1);
const dtLen = tones.renderDual(dt, 0, 350, 440, DIALTONE_S, 0.20);
const dtClip = monitor.playClip(dt.subarray(0, dtLen), 0, 'progress');

// Hold it for its minimum beat, the way afterDialTone() does, and check the
// listener hears tone for the whole of it rather than a blip.
ear.length = 0;
for (let k = 0; k < DIALTONE_MIN_MS / 20; k++) advance(20);
const loud = ear.map((c) => peak(c) > 0.05);
const onset = loud.indexOf(true);
ok(onset >= 0, 'the dial tone is sounding while the lookup is outstanding');
// Everything before onset is BUS_WRITE_LEAD — the quarter second every clip is
// scheduled ahead by, which the old fixed lead paid too. What must not happen is
// a gap AFTER it starts.
ok(onset * 20 <= (BUS_WRITE_LEAD / SR) * 1000 + 40,
   `and starts within the bus write lead (${onset * 20}ms)`);
const gaps = loud.slice(onset).filter((v) => !v).length;
ok(gaps === 0,
   `then runs unbroken for the whole wait (${gaps} silent chunks after onset)`);

// Now the answer arrives and the tone is cut, the way stopDialTone() does it.
monitor.dropClip(dtClip);
ear.length = 0;
for (let k = 0; k < 40; k++) advance(20);          // 800 ms, well past the cut
let after = 0;
for (const chunk of ear) after = Math.max(after, peak(chunk));
ok(after < 1e-9, `cutting the dial tone actually silences it (loudest ${after})`);
ok(!monitor.clips.includes(dtClip), 'and the clip is no longer held');

// A cut tone must not come back on the next lap either — the same ring-repeat
// the pump fix covers, reached by the path the dial tone actually takes.
ear.length = 0;
for (let k = 0; k < ((BUS_LEN / SR) * 1000 * 1.5) / 20; k++) advance(20);
let lap = 0;
for (const chunk of ear) lap = Math.max(lap, peak(chunk));
ok(lap < 1e-9, `and does not return a lap later (loudest ${lap})`);
monitor.sink = null; monitor.ctx = null;

console.log(`\n${fail === 0 ? 'OK' : 'FAILED'} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
