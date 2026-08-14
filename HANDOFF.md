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

### Most recent session (V.29 audible handshake + UI)
- **V.29 now has an audible connect handshake** (Hayes "Express 96" flavour),
  implemented entirely in `protocols/V29.js` (§13.6). On connect the answerer
  emits a ~1 s **2100 Hz V.25 answer tone**, then both ends emit a ~250 ms
  **V.29 training burst**, then the short 'lock' preamble the receiver actually
  acquires on. These are modelled as a per-role *connect script* of NON-syncing
  pre-roll bursts: none presents an alternating->constant frame-sync boundary, so
  the RX squelch discards each on the turnaround-guard silence that follows it and
  the proven per-burst acquisition path is **untouched**. Connect now takes ~1.5 s
  (was near-instant). **Verified** byte-exact both directions + audio content
  (2100 Hz tone leads, 1700 Hz training, originator silent during the tone) via
  `tools/v29-handshake-test.js`. Tunable at the top of `V29.js`:
  `ANS_TONE_SAMPLES`, `LONGTRAIN_SEG1`/`LONGTRAIN_ALT`, `CONNECT_GAP`, `ORIG_LEAD`.
- **Telnet SGA restored** (`public/terminal.js`, §8): the browser TelnetFilter now
  proactively negotiates and agrees to Suppress-Go-Ahead (full-duplex), loop-safe
  via `_sgaLocal`/`_sgaRemote` flags; `negotiate()` is called on carrier-up in
  `main.js`. **`terminal.js` is therefore no longer a verbatim synthdoor copy.**
- **UI (`main.js` / `index.html`):** oscilloscope centered in the header with a
  live white **bps throughput readout** superimposed bottom-right (§9); ~3 px
  terminal margin; **Listen auto-fade** — full volume through the handshake, then a
  10 s fade to silence and Listen toggles off, re-arming on each new connect until
  the user sets it manually, after which the choice sticks (§9).

### NEXT SESSION GOAL: Minimal V.32 (9600 bps)
16-QAM **uncoded**, 2400 baud @ **1800 Hz**, per the target profile in **§12.5**.
Key transport payoff (same one that made V.29 clean): our two WebSocket directions
are a **4-wire equivalent**, so the near/far echo canceller the profile mandates
for 2-wire PSTN is **unnecessary**. Only **9600 is required** (no 4800 fallback),
and — as with V.29 — the receiver may be "genuine minimal" (real V.32 modulation /
differential top-two-bit encoding / scrambler + a real-enough training handshake)
without a full adaptive equalizer if that matches the authenticity bar. The V.32
handshake state machine (AA/CA/AC/CC -> TRN -> R1/R2/R3) is the from-scratch part
with no spandsp reference — budget for it (§12.1). Reference port with V.29 + an
experimental V.32: https://github.com/randyrossi/fisher-modem .

### Prior session (V.29 ping-pong reimplementation) — retained for context
- **V.29 · 9600 bps was reimplemented [that session] as a HALF-DUPLEX PING-PONG
  burst modem** (Hayes "Express 96" style), replacing the previous continuous
  full-duplex design. It is wired end-to-end (protocol class + handshake +
  server whitelist + UI dropdown + rebuilt bundle). See §13 for the full detail.
- **Why the change:** the previous V.29 ran a continuous full-duplex carrier
  with a free-running receiver and no framing, so an *idle* carrier descrambled
  into a flood of `0xFF` bytes (= telnet IAC) in both directions — the "connects
  but shows garbage, never really connects" symptom seen in the browser. That is
  architectural, not a tuning bug: a continuous full-duplex V.29 carrier cannot
  tell idle from data. The honest fix is also the simple one — real consumer
  9600 modems used V.29 *half-duplex* (full-duplex 9600 on 2-wire needed the echo
  cancellation that arrived with V.32). So V.29 now: carrier is present only
  during a data burst; the receiver re-acquires per burst (exactly what the
  preamble acquisition front-end is built for); idle is silence; and the byte
  stream is carried with authentic async start/stop (UART) framing. Bursts are
  capped (256 B) so a long transfer is a train of bursts with turnaround gaps,
  and a periodic keepalive burst keeps the link alive during quiet reading.
- **Verification done this session (full DSP + Handshake path, in-process):**
  two real `ModemDSP` instances wired originate<->answer with jittered delivery
  and a line-buffering mock BBS pass byte-exact **both directions** (banner
  B->A, keystroke + echo A->B) for **V.29** *and* the regression set
  **V.21/V.22/V.23/V.22bis** (all five green — the V.29 changes are isolated to
  `protocols/V29.js` and did not disturb the others). Harness: `/tmp/dsptest2.js`
  (pattern worth keeping — it avoids the sandbox's WS-listener problem entirely).
- **NOT re-confirmed this session:** the literal browser<->`server.js` path over
  a live WebSocket. The sandbox blocks running `server.js`'s WS listener (and
  any long-lived listening node process) from the test harness — `require()`ing
  or backgrounding it makes the harness hang. The WS transport is lossless and
  already proven for the other four protocols, and the full DSP+Handshake pump
  (which is what actually changed) is verified above; but a real browser smoke
  test is still the recommended first step next session.
- **First things to do next session:** open the app in a browser, select
  **V.29 · 9600 bps**, dial the echo BBS (or a real one), and confirm a clean
  banner + typing with no glyph garbage. If you want a headless WS check, run
  `server.js` / `echo-bbs.js` as genuinely independent OS processes (a terminal
  outside the sandbox), then point `tools/jitter-repro.js` at them.

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
  copied into `public/` unmodified — **except** `terminal.js`, which now adds
  telnet SGA (Suppress-Go-Ahead) negotiation to its `TelnetFilter` (see §8); the
  ANSIParser / renderer / font / music remain verbatim.

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
    terminal.js renderer.js font.js music.js   synthdoor render stack (verbatim,
                                                except terminal.js +telnet SGA, §8)
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
    v29-handshake-test.js   in-process full-stack V.29 (two ModemDSPs, jitter, mock
                            BBS); byte-exact both dirs incl. the audible handshake
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
   negotiable modulation) and the **Handshake layer** must not emit the V.25 ANS
   tone (a bare 2100 Hz run straight into training would trip the peer's
   energy-onset acquisition as a false carrier). V.29 then uses the same
   event-driven `ready` path as V.22/V.22bis — "connected" == "acquired the
   peer's carrier" — with NO wall-clock CD gate.
   **Update (audible handshake):** a 2100 Hz answer tone IS now heard on connect,
   but it is emitted by the **V29 class itself** as an isolated pre-roll burst in
   its connect script (§13.6), separated from the acquirable preamble by the
   turnaround-guard silence — so it is audible *without* tripping acquisition.
   That is why the tone lives in `V29.js`, not in the Handshake ANS path.

## 8. Renderer gotcha

`renderer.js`'s `drawFrame` early-returns until `await renderer.init()` builds the
glyph sheet (`_built`). If you forget `init()`, the canvas is pure black.
`main.js` gates the render loop on `renderer.init().then(...)`. Also:
`renderer.js` imports `./font.js` (repointed from the original `./font.min.js`).

**Telnet SGA (most recent session).** `terminal.js`'s `TelnetFilter` previously
refused every option (`DO`->`WONT`, `WILL`->`DONT`), which dropped Suppress-Go-Ahead
and left the link in line/half-duplex mode. synthdoor did SGA on its *server* side;
here the browser is a telnet *client* to a remote BBS (the server is a telnet-blind
raw byte pipe — it just relays the demodulated stream to `net.createConnection`), so
the fix is client-side: `TelnetFilter` now agrees to `DO/WILL SGA` and, via
`negotiate()` (called on carrier-up in `main.js`), proactively offers `WILL SGA` +
`DO SGA`. `_sgaLocal`/`_sgaRemote` flags make it reply only on a real state change,
so the proactive offer and the peer's echoed confirmation can't loop. Every other
option is still refused; ECHO was intentionally left refused. IAC parsing (incl.
escaped `0xFF` and SB blocks) is unchanged.

## 9. Audio / oscilloscope (main.js `monitor`)

Web Audio graph: `bufferSource(s) → analyser → gain → destination`. Analyser is
BEFORE the gain, so the scope shows the real waveform even when muted. Frames
from both directions (`feed('tx'|'rx', f32)`) are batched (~12 nodes/sec — this
batching matters; per-frame node creation starved the DSP). Scope:
`getFloatTimeDomainData`, ~5 ms window, auto-scaled green trace. Audio requires a
user gesture (Connect/Listen click). Default is sound-on.

**Live bps readout (most recent session):** `drawScope` prints a small bright-white
`<N> bps` bottom-right on the scope while a carrier is up — measured throughput,
not the nominal line rate: `(rxBytes+txBytes)` sampled every 250 ms, ×8, lightly
smoothed (`flowBps`). With V.29 ping-pong it spikes during bursts and falls toward
0 while idle. The scope is also centred in the header now (`#controls` shrink-wraps,
`#scope-wrap` fills+centres); `fitTerminal` reserves ~3 px around the canvas.

**Listen auto-fade (most recent session):** a `listenUserSet` flag governs it. Until
the user clicks Listen, each `connected` forces Listen on (full volume through the
handshake) then `monitor.startAutoFade(10, …)` ramps the gain node 0.25->0 over 10 s
and toggles Listen off; it re-arms on every new connect. Any manual click sets
`listenUserSet` (sticky across connects), cancels any in-flight fade, and applies
the user's toggle. `cleanup()` calls `cancelAutoFade()` so a hangup mid-fade can't
fire the off-toggle later.

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
V.22bis 5/5 under jitter, ~3.6 s handshake; V.21 ~3 s; V.22 ~4.6 s. V.29 now
takes ~1.5 s to connect because of the audible handshake (tone + training; §13.6)
— still no V.8. In-process full-stack (no sockets, byte-exact both dirs incl. the
handshake): `node tools/v29-handshake-test.js`.

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
  a differential-coherent, per-burst acquisition front-end but WITHOUT the
  adaptive equalizer + continuous timing-tracking a real-hardware receiver would
  have. This is a much better fit now than under the old continuous-carrier
  design: the receiver is a *burst* receiver (energy-onset -> preamble ->
  frame-sync -> decode), and half-duplex ping-pong gives it a clean burst to
  re-acquire every turn, so it never has to free-run or track for long. For
  real-hardware V.29 interop you'd still add an equalizer + timing tracking (the
  T/2-equalizer in the V.22bis spandsp port is the reference). Untested against a
  real V.29 modem.
- **V.29 async framing is real (start/8/stop UART), and idle is silence.** Data
  bytes carry a start bit, 8 data bits LSB-first, and a stop bit; between bytes
  and during burst turn-on/trailer the line is mark, so idle-within-a-burst emits
  nothing, and between bursts there is no carrier at all. This is what makes the
  §0 idle-`0xFF` flood impossible now. (See the async framing note below — this
  is the "start/8/stop UART framing" the direct-mode bullet refers to, and for
  V.29 it is now genuinely in the DSP, not just an aspiration.)
- **No V.42 / no error correction or compression** on ANY protocol. We carry raw
  async data (start/8/stop UART framing), like a modem in direct mode (AT\N0).
- **Concurrency:** per-call protocol selection mutates the shared `config`
  singleton just before DSP construction. Fine for a local single-user tool;
  concurrent connections requesting different protocols could race. For
  multi-user, thread the protocol through as a per-instance option.
- **Clean-link flags** (§6) are not valid against real phone lines.
- V.29's bounded-buffer trimming (§13) keeps memory flat on long sessions; carrier
  phase uses the absolute sample index and is unaffected by trimming.

## 12. V.32 — NEXT TARGET (minimal 9600); V.32bis later

Minimal **9600 (pure V.32)** is the next session's goal — see the target profile
in **§12.5**. **14400 (V.32bis)** remains a later step. The prior analysis and
assets, all still applicable, kept intact:

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

### 12.5 Minimal V.32 target profile (NEXT SESSION)
Target = the absolute-minimum 9600 bps V.32, which every V.32 modem was required
to support for interworking. Only 9600 is required here — **no 4800 fallback** —
and it "can be reduced to match the other protocols' level of authenticity if
required" (i.e. genuine minimal, like V.29: real modulation/encoding/scrambler +
a real-enough training handshake, without necessarily a full adaptive equalizer).

- **Duplex / bandwidth:** true full-duplex, both directions using the full
  voiceband simultaneously (NOT split-band like V.21/V.22). On a real 2-wire PSTN
  line this demands near/far adaptive **echo cancellation** (cancelling your own
  1800 Hz carrier). **On our transport it does not:** the two WebSocket directions
  are a 4-wire equivalent, one carrier per direction, so the echo canceller — the
  hardest V.32 component — is **unnecessary** (same payoff that made V.29 clean).
- **Physical signal:** single carrier **1800 Hz (±1 Hz)**, **2400 baud**.
- **Modulation:** **16-state non-redundant (uncoded) QAM**, 4 data bits/symbol ×
  2400 = 9600 bps. (The optional 32-state **TCM** trellis scheme is NOT required
  for minimum 9600 interworking — skip it; add later for V.32bis 12000/14400.)
- **Differential encoding:** the first two bits of each 4-bit group (Q1,Q2) are
  differentially encoded to resolve the 90° phase ambiguity.
- **Line coding / sync:** synchronous binary data stream (async-to-sync V.14 is
  optional — skip). Self-synchronising **V.32 scrambler/descrambler** (standard
  V.32 generator polynomial) for spectral dispersion + clock recovery.
- **Handshake:** the standard V.32 startup training at 2400 baud (line probing,
  rate-sequence exchange, train equalizers / — normally — echo cancellers). This
  is the **from-scratch** part: no spandsp reference exists for the V.32 handshake
  (AA/CA/AC/CC segments -> TRN -> R1/R2/R3 rate signals). Where the prior attempt
  died was "failing at R1"; budget accordingly. Because our channel is echo-free
  and per-direction, running the handshake symmetrically per direction (as V.29
  does) and skipping echo cancellation is the recommended simplification — verify
  the R1/R2/R3 rate-signal exchange still round-trips.

Reusable assets already in-tree: V.29's fractional-SPS RRC synthesis + matched
filter (`protocols/V29.js`) as the 2400-baud/1800 Hz RX foundation; the V.22bis
spandsp T/2 equalizer + timing recovery as the equalizer reference;
`qam9600-proto.js` as a QAM TX/RX scaffold (integer-SPS, not a real ITU protocol);
and the V.29 burst/preamble machinery as a model for the training front-end.
Reference port with V.29 + an **experimental V.32**:
https://github.com/randyrossi/fisher-modem .

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
- **Half-duplex ping-pong operation** (Hayes "Express 96" style). V.29 is a
  half-duplex modem; full-duplex 9600 on 2-wire needed the echo cancellation
  that came with V.32, so consumer 9600-over-V.29 was ping-pong: buffer locally,
  blast a burst one way, turn the line around. We emulate that. NOTE: our two
  WebSocket directions are a 4-wire equivalent, so we *could* run full-duplex —
  and the previous version did — but a continuous full-duplex V.29 carrier has
  no way to tell idle from data and floods the peer with descrambled idle bytes
  (see §0). Ping-pong is both the honest consumer representation and the clean
  fix. Genuinely honest framing note lives in the class docstring.

### 13.2 Acquisition front-end (the "genuine minimal" receiver)
Over the wire the two ends are NOT sample-aligned, so the receiver does real
preamble-based acquisition, now **per burst**:
`energy onset → fractional symbol-phase lock (maximise SEG_A energy) →
alternating→constant transition = frame sync → gain/phase seed → differential
decode → descramble.` Preamble = 32 alternating symbols (SEG_A) + 16 constant
symbols (SEG_B). The RX also has an energy squelch (carrier up/down) and an
amplitude-floor in the decode loop, so it decodes only real signal and resets
cleanly between bursts. Basis proven in `v29-stream.js`; the burst/squelch layer
is new this session.

### 13.2b Burst / framing / turnaround layer (new this session)
- **Async start/stop (UART) framing.** Each byte = start(0) + 8 data LSB-first +
  stop(1); idle within a burst is mark (1). So idle emits no bytes and byte
  boundaries are self-delimiting. A per-burst scrambler warm-up (`WARMUP_BITS`)
  lets the self-sync descrambler converge on mark before the first start bit;
  the UART only arms after a run of idle marks (`UART_ARM_MARKS`) so convergence
  noise can't fake a leading byte.
- **Burst engine.** TX is silent when idle. On `write()` (data queued) and the
  line free, it emits preamble + framed data + a mark trailer (`TRAILER_SYMS`,
  ≥ RRC span, to shape the last byte) then drops carrier. Each end sends one
  initial training burst on start so the peer acquires and fires `ready`
  (== connected); training/keepalive bursts ignore the "line free" gate so mutual
  training can't deadlock.
- **Turnaround.** Bursts are capped at `MAX_BURST_BYTES` (256) so a long transfer
  is a train of bursts; a mandatory `TURNAROUND_GUARD` (~45 ms) of silence after
  every burst gives the peer time to squelch-reset and re-acquire the next
  preamble (without it, back-to-back bursts merge and only the first is decoded —
  that was a real bug found and fixed this session). A `KEEPALIVE_GAP` (~1.2 s)
  idle timer sends a preamble-only keepalive so the peer RX and the ModemDSP
  silence-hangup timer never see a dead line during quiet reading.

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

### 13.4 Memory: bounded by the burst model
The old continuous design needed offset-indexed trimming to keep RX/TX buffers
from growing over a long session. The ping-pong model makes that unnecessary:
each burst is short (data capped at 256 B ≈ ~1300 symbols / ~4300 samples), and
the RX buffer is cleared on every burst reset, so memory is naturally flat. The
carrier phase is still derived from a per-burst sample index (reset each burst);
the receiver re-acquires per burst, so absolute cross-burst continuity isn't
needed.

### 13.5 Verified this session / still to confirm
- **Verified (full DSP + Handshake path, in-process, jittered):** V.29 passes
  byte-exact both directions (banner B->A, keystroke + echo A->B), and the
  regression set V.21/V.22/V.23/V.22bis all still pass, via two real `ModemDSP`
  instances wired originate<->answer against a line-buffering mock BBS. Harness
  pattern: `/tmp/dsptest2.js` (recreate it — it sidesteps the sandbox WS problem).
  Protocol-class loopback (`/tmp/v29test.js`: short/offset/banner/bidir/600 B/
  jittered) is 7/7, stable across repeats.
- **Still to confirm:** the literal browser<->`server.js` path over a live
  WebSocket (a browser smoke test with V.29 selected is the quickest). The DSP
  and Handshake — the only things that changed — are verified above; the WS
  transport is lossless and already proven for the other four.

### 13.6 Audible connect handshake (most recent session)
Pure V.29 barely makes a sound on connect (it just starts training on carrier
detect), which read as "less authentic" next to the V.8/ANS protocols. We added
a Hayes "Express 96"-flavour connect **without disturbing acquisition**:
- **`_buildConnectScript(role)`** returns an ordered list of pre-roll bursts,
  each with a required preceding idle (`gap`):
  - answer:  `tone` (gap 0) -> `longtrain` (gap `CONNECT_GAP`) -> `lock` (gap `CONNECT_GAP`)
  - originate: `longtrain` (gap `ORIG_LEAD`) -> `lock` (gap `CONNECT_GAP`)
  The originator's `ORIG_LEAD` (~0.6 s) holds it silent so the answerer's tone
  clearly leads. `_maybeStartBurst` plays the script once, then normal
  data/keepalive bursts resume.
- **Burst kinds** (in `_startBurst` / `generateAudio`):
  - `tone` — a pure 2100 Hz sine (`ANS_TONE_FREQ`/`ANS_TONE_AMP`,
    `ANS_TONE_SAMPLES` long), rendered by a dedicated `txMode==='tone'` branch.
  - `longtrain` (`_buildLongTrain`) — a short unmodulated 1700 Hz carrier
    (`LONGTRAIN_SEG1`) then a run of 0°/180° reversals (`LONGTRAIN_ALT`): the
    audible "harsh static". It goes const->alternating then alternating->silence,
    so it NEVER yields the alternating->constant boundary the frame-sync scanner
    looks for.
  - `lock` — the normal SEG_A+SEG_B preamble + mark; the ONLY burst the receiver
    frame-syncs on and fires `ready` from (== connected).
- **Why it can't break sync:** tone and longtrain never sync, so the peer RX
  buffers them, fails to acquire, and the `CONNECT_GAP` (~80 ms, > squelch
  hangup) silence that follows makes the squelch hang up and `_resetRx()`,
  discarding the pre-roll before the fresh `lock` preamble arrives. This directly
  neutralises the §7.6 "ANS tone trips acquisition" failure mode (that mode was a
  tone running *straight into* training with no separating silence).
- **Verification:** `tools/v29-handshake-test.js` (full DSP+Handshake, jittered,
  mock BBS) passes byte-exact both directions; a Goertzel capture confirms 2100 Hz
  leads for ~1 s, then 1700 Hz-centred training, with the originator silent during
  the tone. Change is isolated to `protocols/V29.js` (regression set unaffected).

**Sandbox note:** this session's environment made the test harness hang whenever
it started `server.js`'s WebSocket listener — whether backgrounded, `setsid`-
detached, *or* `require()`d in-process — even though a plain `net`/HTTP listener
that exits cleanly worked, a bare `require('server.js'); process.exit(0)` worked,
and backgrounding a plain `sleep` worked. The trigger is a long-lived `ws` server
staying up in the harness's process tree. Workaround used: test the whole stack
in one node process with no listening server (two `ModemDSP`s wired directly, as
in §13.5). For a real WS check, run `server.js` / `echo-bbs.js` from a genuine
independent shell outside the sandbox and point `tools/jitter-repro.js` at them.

## 14. Quick "add a protocol" checklist

1. Get it working originate↔answer in loopback (watch for answer-side-only
   assumptions: guard tone, detection heuristics, wall-clock gates; and for
   symmetric protocols, whether V.8/ANS should be bypassed entirely as with V.29).
2. Ensure no Node-only refs reachable in the browser path (§5).
3. Add to `server.js` `PROTOS` and the `<select id="protocol">` in index.html.
4. `npm run build`, run the §5 `process`-shadowed check, then test with
   `tools/jitter-repro.js PROTO=<name>` over the real WS.
