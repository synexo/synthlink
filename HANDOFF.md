# SynthLink — Engineering Handoff

A web BBS terminal that talks to a JavaScript server over a **real software-modem
link** (synthmodem's native DSP — actual PCM audio carries the data), then
proxies to arbitrary telnet BBSes. The carrier is real and audible, with a
live oscilloscope. Protocols: V.21 (300), V.22 (1200), V.22bis (2400),
V.23 (1200/75), and **V.29 (9600)**, selectable per call.

This document is the pick-up point for a future session. It assumes no memory of
how we got here.

---

## 0. Status at this handoff (READ FIRST)

- **V.29 · 9600 bps was added this session** and is wired end-to-end
  (protocol class + handshake + server whitelist + UI dropdown + rebuilt
  bundle). See §13 for exactly what was done and **what has NOT yet been
  confirmed**.
- **V.29 is integrated and loopback-proven, but NOT yet confirmed over the real
  WebSocket**, and the V21/V22/V23/V22bis regression pass was NOT re-run this
  session (a sandbox quirk blocked running `server.js`'s WS listener inside the
  test harness). First real confirmation is expected to come from a browser
  test. If anything is off, the other four protocols' working paths were not
  touched — the V.29 changes are additive (new registry entry + a V29-only
  branch *before* the V.8 path).
- **First things to do next session:** run the §10 tests for real
  (get a green `RESULT(V29): PASS` over the WS **and** re-confirm the other four
  still pass), launching `server.js` / `echo-bbs.js` *outside* the test harness
  and pointing a probe at them.

---

## 1. What this is / data path

```
browser (originate modem)                         server (answer modem)
  keystroke → ModemDSP('originate').write          ModemDSP('answer').receiveAudio
           → PCM audio ──[WebSocket, Int16]──────→ → demod bytes → telnet socket → BBS
  render ← ANSIParser ← TelnetFilter ← demod bytes ← ──[WebSocket, Int16]── PCM audio ←
           ModemDSP('originate').receiveAudio        telnet bytes → ModemDSP('answer').write → audioOut
```

- The modem link is between the **browser** (originate/caller) and the **server**
  (answer). Actual modulated audio crosses the WebSocket in both directions as
  Int16 PCM @ 8 kHz. Nothing but audio crosses during a call.
- The server demodulates the caller's keystrokes and writes them to a raw TCP
  (telnet) socket to the chosen BBS; the BBS's bytes are modulated back to audio.
- The browser demodulates the incoming audio, runs it through telnet IAC
  filtering + an ANSI/CP437 parser, and renders to a canvas.
- The Web Audio graph plays the carrier and drives a real oscilloscope.

## 2. Provenance / origins

Built by fusing two repos (both cloned under `/root/repos` in the original
session; not required at runtime — everything needed is vendored):

- **synthmodem** (https://github.com/synexo/synthmodem) — SIP↔telnet modem
  gateway. We took its pure-JS native DSP (`src/dsp/*`). The V.22/V.22bis DSP and
  V.8 sequencer are JavaScript ports of **spandsp** (`v22bis_rx.c`,
  `v22bis_tx.c`, `v8.c`) by Steve Underwood, © 2003–2009, LGPL-2.1
  (https://github.com/freeswitch/spandsp). See synthmodem `COPYING` /
  `licenses/SPANDSP-NOTICE`.
- **synthdoor** (https://github.com/synexo/synthdoor) — BBS door-game engine. We
  reuse its **browser** render stack verbatim: `terminal.js` (ANSIParser +
  TelnetFilter + Terminal screen buffer), `renderer.js` (canvas CP437 renderer),
  `font.js` (VGA 8x16 font), `music.js` (ANSI music). These are pure ES modules,
  copied into `public/` unmodified.

Key architectural fact that made this possible: synthdoor's **browser**
`terminal.js` already contains a full client-side ANSI/CSI parser with
`feed(bytes)`. So the browser can render a raw telnet stream once demodulated —
we did NOT need synthdoor's server-side sbansi stack.

## 3. Layout

```
synthlink/
  server.js                 WS + telnet proxy + answer-side modem; static server; /bbs.json
  build.js                  esbuild bundler → public/dsp-bundle.js
  package.json              scripts: start, build, echo-bbs
  config/bbs.json           BBS directory (served live at /bbs.json)
  src/browser-dsp-entry.js  browser bundle entry (polyfills Buffer, exposes {ModemDSP,Buffer,config})
  public/
    index.html              UI: status bar, scope, BBS dropdown, terminal canvas
    main.js                 client logic: modem wiring, Web Audio + scope, terminal fit, keyboard
    dsp-bundle.js           BUILT artifact (esbuild IIFE, global SynthModemDSP) — regenerate with npm run build
    terminal.js renderer.js font.js music.js   synthdoor render stack (reused verbatim)
  vendor/
    config.js               synthmodem's config (pure object)
    synthlink-config.js     our config overrides (protocol + clean-link flags); required by BOTH server & bundle
    src/logger.js           universal (browser+node safe) logger shim
    src/dsp/                 synthmodem DSP core: ModemDSP, Handshake, V8, V8Sequencer, Primitives
    src/dsp/protocols/       V21, V22 (V22+V22bis), V23, V29, Bell103, FskCommon, V22Demodulator, ...
  tools/
    echo-bbs.js             local telnet test BBS (ANSI banner + line echo), port arg (default 2323)
    sim-client.js           headless originate over WS → full end-to-end (uses vendored DSP)
    jitter-repro.js         headless originate using the BUILT BUNDLE over WS, injects RX jitter; PROTO/BBS_PORT env
    ws-steady.js            like jitter-repro but steady RX delivery; PROTO env
    bundle-smoke.js         loads the bundle, loopbacks bundle-originate ↔ node-answer
  v29-proto.js              V.29 core (batch) prototype — genuine constellation/encoding/scrambler (reference)
  v29-stream.js             V.29 streaming prototype with acquisition — the basis for protocols/V29.js (reference)
  qam9600-proto.js          64-QAM 9600 feasibility prototype (NOT a real ITU protocol) — kept for V.32 work (see §12)
```

Note: `vendor/` mirrors synthmodem's original tree depth so the DSP's relative
requires (`../../../config`, `../logger`, `../Primitives`) resolve unchanged.

## 4. Run / build

```bash
npm install
npm run build            # regenerate public/dsp-bundle.js (already committed; rebuild after DSP/config edits)
npm run echo-bbs &       # optional local test BBS on telnet :2323
npm start                # http://localhost:8088  (PORT env overrides)
```

Defaults in the UI: host `bbs.birdenuf.com`, port `2003`, speed V.22bis, sound on.

Security: the server is an **open telnet proxy**. Set `ALLOW_HOSTS=h1,h2` env to
restrict before exposing publicly.

## 5. The browser DSP bundle (critical mechanism)

`src/browser-dsp-entry.js` → esbuild → `public/dsp-bundle.js` (IIFE global
`SynthModemDSP = { ModemDSP, Buffer, config }`). The DSP core needs only Node's
`events` + `Buffer`, provided by the `events`/`buffer` npm polyfills. `index.html`
loads the bundle via `<script src>`, then `main.js` (ES module) uses
`window.SynthModemDSP`.

**RULE: any `process.*`, `fs`, `os`, `path`, or other Node-only reference reachable
in the DSP will silently crash the browser bundle** (it works in Node = server,
fails in browser = originate, which looks like "server connects, browser
doesn't"). We already hit this twice:
- `logger.js` used `process.stdout` → replaced with universal `vendor/src/logger.js`.
- `V22.js` `_trackRxDetection` used `process.env.V32_DEBUG` → guarded behind a
  `V32_DEBUG` constant computed with `typeof process !== 'undefined'`.
- (V.29 was written clean — no Node-only refs — and verified with the check below.)

After ANY change under `vendor/` or `src/browser-dsp-entry.js`, run `npm run build`,
then sanity-check the browser path with `process` shadowed:
```bash
node -e "const fs=require('fs');const B=new Function('process',fs.readFileSync('public/dsp-bundle.js','utf8')+'\nreturn SynthModemDSP;')(undefined);const {ModemDSP,config}=B;config.modem.native.protocolPreference=['V29'];config.modem.native.v8ModulationModes=['V29'];const o=new ModemDSP('originate');o.start();for(let i=0;i<200;i++)o.receiveAudio(new Float32Array(160).fill(0.05));o.stop();console.log('browser path OK');"
```

## 6. Config flags (vendor/synthlink-config.js)

Applied by BOTH server and browser bundle (mutates the shared config object).
Per-call protocol is set by the server (from the dial message) and the client
(from the dropdown) just before constructing the DSP.

- `protocolPreference` / `v8ModulationModes` — default `['V21']`; overridden per call.
- `v22MagOnlyDetect = true` — clean-link V.22/V.22bis carrier detection (see §7).
- `skipCdVerification = true` — skip the wall-clock carrier-detect stability gate
  in Handshake (see §7).
- `cdStableMs = 120`, `listenWindowMs = 12000` — relaxed CD-gate params (only used
  if skipCdVerification were false; kept for reference).

These are all **clean-transport** relaxations. Safe here because a WebSocket link
has zero line noise and no V.32 automode signals. Do NOT assume they are correct
against real phone lines / real modems. (V.29 does not depend on any of these —
it self-acquires and connects on carrier acquisition; see §7.6.)

## 7. Hard-won DSP fixes (WHY they exist — don't regress)

The synthmodem DSP was only ever exercised as the **answer** side against real
hardware. Making the **originate** side work JS↔JS required:

1. **Handshake CD-stability gate is wall-clock, fragile in browser.**
   `Handshake.js` after training requires `carrierDetected` true for 500 ms of
   `Date.now()` time, polled on a timer. But CD only advances when RX audio is
   processed; under browser main-thread contention (esp. Web Audio when
   listening) the two decouple and it never latches → "server connects, browser
   doesn't". Fix: `cfg.skipCdVerification` takes the permissive "connect at
   train-end" path (answerer holds continuous mark-idle, so it's safe).

2. **V.22/V.22bis guard tone was emitted by BOTH roles.** Per V.22bis §2.2 the
   1800 Hz guard tone belongs to the answerer (high channel) only. Emitting it as
   caller defeats the peer's carrier detector. Fix in `V22.js`: `guardTone: isAnswer`
   in BOTH the `V22` and `V22bis` class constructors.

3. **V.22 remote-detection used an answer-side anti-V.32-AA spectral test.** It
   required carrier-bin energy > 3× the 1800 Hz ghost bin — which can NEVER pass
   against a guard-tone-emitting peer. Fix: `cfg.v22MagOnlyDetect` drops the
   spectral test and detects on the matched-filter magnitude. Applied in both
   `V22._trackRxDetection` and `V22bis._trackRxDetection`.

4. **V.22bis originate (caller) training was never implemented** — it fell through
   to the answer flow. Fix: the **caller leads** (V.22bis §6.3.1.2.1). In
   `V22bis._advanceHandshake`, case `U11`, for `role !== 'answer'`: once
   `_remoteDetected`, proactively call `_onS1Detected('originate-lead')`. The
   answerer stays reactive (unchanged).

5. **Server protocol whitelist must include every selectable protocol.** It was
   `['V21','V22','V23']` so `V22bis` silently fell back to V.21. Now
   `['V21','V22','V23','V22bis','V29']` in `server.js`. (If you add a protocol,
   update BOTH this list and the `<select>` in index.html.)

6. **V.29 bypasses V.8 and the answer tone entirely (new this session).** V.29 is
   symmetric and self-acquiring (see §13). In `Handshake.start()` a `wantV29`
   check runs *before* the V.8 path and routes both roles straight to
   `_selectProtocol('V29')`. It must NOT go through V.8 (V.29 isn't a V.8-
   negotiable modulation) and must NOT emit the answer-side ANS tone (2100 Hz
   would trip the peer's energy-onset acquisition as a false carrier). V.29 then
   uses the same event-driven `ready` path as V.22/V.22bis — "connected" ==
   "acquired the peer's carrier" — with NO wall-clock CD gate.

## 8. Renderer gotcha

`renderer.js`'s `drawFrame` early-returns until `await renderer.init()` builds the
glyph sheet (`_built`). If you forget `init()`, the canvas is pure black.
`main.js` gates the render loop on `renderer.init().then(...)`. Also:
`renderer.js` imports `./font.js` (repointed from the original `./font.min.js`).

## 9. Audio / oscilloscope (main.js `monitor`)

Web Audio graph: `bufferSource(s) → analyser → gain → destination`. Analyser is
BEFORE the gain, so the scope shows the real waveform even when muted. Frames
from both directions (`feed('tx'|'rx', f32)`) are batched (~12 nodes/sec — this
batching matters; per-frame node creation starved the DSP). Scope:
`getFloatTimeDomainData`, ~5 ms window, auto-scaled green trace. Audio requires a
user gesture (Connect/Listen click). Default is sound-on.

## 10. Testing (all headless, no browser needed for DSP)

```bash
# start deps (launch OUTSIDE any auto-killed test harness; see §13 sandbox note)
node tools/echo-bbs.js 2323 &
node server.js &

# each protocol end-to-end over the real WS, using the BUILT bundle as originate:
PROTO=V21    BBS_PORT=2323 node tools/jitter-repro.js   # expect PASS
PROTO=V22    BBS_PORT=2323 node tools/jitter-repro.js
PROTO=V23    BBS_PORT=2323 node tools/jitter-repro.js
PROTO=V22bis BBS_PORT=2323 node tools/jitter-repro.js
PROTO=V29    BBS_PORT=2323 node tools/jitter-repro.js   # NEW — confirm this

# full end-to-end incl. banner + typed echo (default V21):
node tools/sim-client.js
```

Reliability previously observed (pre-V.29): all four passed over WS+jitter;
V.22bis 5/5 under jitter, ~3.6 s handshake; V.21 ~3 s; V.22 ~4.6 s. V.29 handshake
should be near-instant (no V.8, no ANS — connects on first acquisition).

Standalone V.29 checks that DID pass this session:
- `node v29-stream.js` — the streaming prototype loopback (PASS).
- V.29 protocol-class loopback (int16 + jitter + random offset, ~30 KB/direction,
  5/5, zero byte errors, bounded buffers). The scratch harness was deleted before
  packaging; recreate from `v29-stream.js`'s `test()` if needed.
- Browser-path `process`-shadowed check with V.29 selected (PASS) — see §5.

## 11. Known limitations / next targets

- **Speed ceiling is now 9600 (V.29).** Next genuine step up would be V.32bis
  (14400) / V.34 (28800+) — large efforts; see §12 for the V.32 plan and assets.
- **V.29 receiver is "genuine minimal":** genuine V.29 modulation/encoding, with
  a differential-coherent acquisition front-end but WITHOUT the adaptive
  equalizer + continuous timing-tracking a real-hardware receiver would have.
  Fine on our clean deterministic channel; for real-hardware V.29 interop you'd
  add those (the T/2-equalizer architecture in the V.22bis spandsp port is the
  reference). It is also untested against a real V.29 modem.
- **No V.42 / no error correction or compression** on ANY protocol. We carry raw
  async data (start/8/stop UART framing), like a modem in direct mode (AT\N0).
- **Concurrency:** per-call protocol selection mutates the shared `config`
  singleton just before DSP construction. Fine for a local single-user tool;
  concurrent connections requesting different protocols could race. For
  multi-user, thread the protocol through as a per-instance option.
- **Clean-link flags** (§6) are not valid against real phone lines.
- V.29's bounded-buffer trimming (§13) keeps memory flat on long sessions; carrier
  phase uses the absolute sample index and is unaffected by trimming.

## 12. V.32 — deferred, but wanted later (preserve all of this)

We may still develop a genuine **9600 (pure V.32) / 14400 (V.32bis)** later. The
prior analysis and assets, kept intact:

### 12.1 Why V.32 was hard / abandoned in synthmodem
- V.32/V.32bis/V.34 were **removed from synthmodem's native tree** along with the
  spandsp C addon. Only the slmodemd-pjsip backend (which we do NOT use) ever
  covered them. **spandsp does not implement V.32**, so — unlike V.22bis and V.29
  — there is **no reference C to port**. This is the core reason V.32 is a big
  lift: the full V.32 handshake (AA/CA/AC/CC segments, TRN equalizer training,
  R1/R2/R3 rate signals) has to be written from scratch, and **that handshake is
  exactly where the prior attempt died** (the "failing at R1" pain).
- V.32 also carries the hardest real-world piece — an **echo canceller** for its
  shared-carrier full-duplex (cancelling your own 1800 Hz carrier).

### 12.2 What makes V.32 *more tractable here* than on a phone line
- Our **separate WebSocket directions are a 4-wire equivalent**, so we run one
  carrier per direction and the **echo canceller is unnecessary** — its hardest
  component is eliminated by our transport (same architectural payoff that made
  V.29 clean).
- Pure V.32 tops out at 9600 (bis adds 12000/14400). Its **uncoded 16-QAM 9600
  mode skips the trellis/Viterbi**, so that part simplifies. (V.32bis rates need
  TCM.)
- 2400-baud RX (3.33 samples/symbol at 8 kHz) is the **same awkward rate as
  V.29**, and V.29's fractional-SPS RRC synthesis/matched-filter machinery
  (now in `protocols/V29.js`) is directly reusable as the starting point for a
  V.32 receiver. The V.22bis spandsp port's T/2 equalizer + timing recovery is
  the other reusable reference.
- **Still owed from scratch:** the V.32 handshake state machine (AA/CA/AC/CC,
  TRN, R1/R2/R3) and 2400-baud timing/equalization. No spandsp reference exists
  for it. This is the bulk of the work and the main risk.

### 12.3 `qam9600-proto.js` — the pragmatic-but-inauthentic fallback
- A **feasibility prototype** proving a REAL 9600 bps QAM link survives our 8 kHz
  + Int16 channel. Params chosen for an **integer** samples-per-symbol so timing
  is trivial on a shared clock: **1600 baud × 6 bits/symbol (64-QAM) = 9600 bps,
  sps = 5, carrier 1800 Hz, RRC rolloff 0.35**. Constellation is a plain 8×8 grid
  (levels −7..7).
- **It is NOT a real ITU protocol** — do not ship it as "V.something". It exists
  only to (a) prove 9600 is reachable on our channel and (b) serve as a working
  QAM TX/RX scaffold. We chose **V.29 over this** precisely because the user
  wants protocols to be genuine. Keep `qam9600-proto.js` as a reference sandbox
  if hand-rolling V.32's data-mode QAM before the handshake exists.

### 12.4 Recommended order if/when doing V.32
1. Reuse `protocols/V29.js` fractional-SPS RRC + V.22bis T/2 equalizer as the
   2400-baud RX foundation; get uncoded 16-QAM 9600 data-mode working in loopback
   (the `qam9600-proto.js` scaffold shows the TX/RX shape).
2. Build the V.32 handshake state machine (AA/CA/AC/CC → TRN → R1/R2/R3 → data).
   This is the from-scratch part with no spandsp reference — budget accordingly.
3. Because our channel is echo-free and per-direction, you can likely run the
   handshake symmetrically per direction (as V.29 does) and skip echo
   cancellation; verify the rate-signal exchange still round-trips.
4. Then V.32bis (add TCM/trellis for 12000/14400).

## 13. V.29 integration details (done this session)

### 13.1 The genuine V.29 elements (in `vendor/src/dsp/protocols/V29.js`)
- Real V.29 **16-point constellation**: two amplitude rings (radius 3/5 on the
  on-axis phases, √2 / 3√2 on the diagonal phases), spandsp point ordering.
- Real V.29 **encoding**: differential PHASE (Q2 Q3 Q4 → phase change per the §4
  table) + absolute AMPLITUDE (Q1). 2400 baud × 4 bits/symbol = 9600 bps.
- Real V.29 **scrambler** 1 + x⁻¹⁸ + x⁻²³ (self-synchronizing).
- **1700 Hz carrier**, 2400 baud → 3.333 samples/symbol handled by continuous
  RRC synthesis and matched filtering at the true fractional symbol instants
  (rolloff 0.25).
- **4-wire full-duplex** per V.29 §1.1: our two WebSocket directions are the
  4-wire equivalent, so we run one independent V.29 carrier per direction. Both
  roles do the identical thing — this is literally the spec's 4-wire mode, not a
  workaround.

### 13.2 Acquisition front-end (the "genuine minimal" receiver)
Over the wire the two ends are NOT sample-aligned, so the receiver does real
preamble-based acquisition:
`energy onset → fractional symbol-phase lock (maximise SEG_A energy) →
alternating→constant transition = frame sync → gain/phase seed → differential
decode → descramble.` Preamble = 32 alternating symbols (SEG_A) + 16 constant
symbols (SEG_B). Basis proven in `v29-stream.js`.

### 13.3 Interface + handshake wiring
- `protocols/V29.js` matches the other protocol classes: `constructor(role)`
  (role stored for parity; V.29 is symmetric), `generateAudio(n)→Float32Array`,
  `receiveAudio(f32)`, `write(buf)`; emits `data` (Buffer) and `ready`
  (`{bps:9600, remoteDetected:true}`); getters `bps` (9600) and `carrierDetected`.
- `Handshake.js`: requires `./protocols/V29`, registers `V29` in `PROTOCOLS`,
  adds a `wantV29` bypass in `start()` (before the V.8 path; both roles →
  `_selectProtocol('V29')`), and includes `'V29'` in the event-driven `ready`
  branch alongside `'V22'`/`'V22bis'`. No CD gate, no training-burst timer.
- `server.js` `PROTOS` includes `'V29'`; `index.html` `<select>` has
  `V.29 · 9600 bps`.

### 13.4 Improvement over the prototype: bounded buffers
The `v29-stream.js` prototype retained all RX samples and TX symbols forever
(fine for a 220-block test, a memory leak over a multi-minute BBS session).
`protocols/V29.js` adds **offset-indexed trimming** (`rxBase` / `txSymBase`):
consumed samples/symbols are spliced off in chunks, while all indexing stays in
absolute terms. **Carrier phase is derived from the absolute sample index and is
therefore unchanged by trimming** — trimming is pure storage compaction. Loopback
confirmed buffers stay bounded (RX ≤ ~4000 samples, TX ≤ ~1253 symbols) with zero
byte errors over ~30 KB/direction.

### 13.5 NOT yet confirmed (do next)
- A green `RESULT(V29): PASS` **over the real WebSocket** (`jitter-repro.js`
  PROTO=V29). Only loopback + the browser-path check were run this session.
- **Regression:** re-run V21/V22/V23/V22bis over the WS to confirm the handshake
  edits didn't disturb them (expected clean — changes are additive/before the V.8
  path — but unverified this session).
- Real first confirmation is likely to be the browser test.

**Sandbox note:** this session's environment reaped/interrupted any process that
started `server.js`'s WebSocket listener from inside the test harness (a minimal
`ws` server+client and plain HTTP-listen on 8088 both worked, so it was narrower
than "no listeners allowed"). Launch `server.js` / `echo-bbs.js` as independent
processes (or a real shell) and point the probe at them, rather than spawning
them from within the test script.

## 14. Quick "add a protocol" checklist

1. Get it working originate↔answer in loopback (watch for answer-side-only
   assumptions: guard tone, detection heuristics, wall-clock gates; and for
   symmetric protocols, whether V.8/ANS should be bypassed entirely as with V.29).
2. Ensure no Node-only refs reachable in the browser path (§5).
3. Add to `server.js` `PROTOS` and the `<select id="protocol">` in index.html.
4. `npm run build`, run the §5 `process`-shadowed check, then test with
   `tools/jitter-repro.js PROTO=<name>` over the real WS.
