# SynthLink

A web BBS terminal that talks to a JavaScript server over a **real software-modem
link** (synthmodem's native V.21 FSK DSP — actual PCM audio carries the data),
then proxies to arbitrary telnet BBSes. The audio is real; the client has a
**Listen** button to hear the carrier in both directions.

```
browser: keystroke -> ModemDSP('originate').write -> PCM audio
   -> WebSocket -> server: ModemDSP('answer').receiveAudio -> demod bytes -> telnet BBS
BBS bytes -> answer.write -> PCM audio -> WebSocket
   -> browser: originate.receiveAudio -> demod bytes -> TelnetFilter -> ANSIParser -> Terminal -> canvas
```

Nothing but modulated audio crosses the socket during a call.

Open the page, pick a BBS from the directory (or type a host/port), choose a
speed, and press **Connect**. The toolbar has a real-time oscilloscope showing
the actual carrier waveform (with a live bps throughput readout in its corner),
and the carrier is audible by default (Listen is on; audio starts on the Connect
click per browser autoplay rules). Listen stays on through the handshake, then
fades to silence ~10 s after connect and switches off — re-arming on each new
connect until you touch the button, after which your setting sticks.

Defaults: `bbs.birdenuf.com:2003`, V.22bis (2400 bps), sound on.

### BBS directory

The **BBS** dropdown is populated from `config/bbs.json` (served live, so you
can edit it without restarting). Each entry is `{ "name", "host", "port" }`.
Selecting one fills the host/port fields; you can still type any host/port.

## Protocols (speed pulldown)

The toolbar has a **speed** selector. Working originate<->answer protocols over
this lossless link:

  V.21     300 bps      FSK; fastest handshake
  Bell 103 300 bps      FSK
  V.22     1200 bps     DPSK
  V.22bis  2400 bps     16-QAM (default; with V.22 fallback path)
  V.23     1200/75 bps  split-speed FSK
  V.29     9600 bps     16-QAM, half-duplex ping-pong (Hayes "Express 96" style)
  V.32     9600 bps     uncoded 16-QAM, true full-duplex
  V.32bis  14400 bps    trellis-coded 128-QAM, true full-duplex

The three 9600+ protocols are genuine ITU modulation implementations written for
this project (there is no spandsp reference for them). V.29 runs half-duplex
ping-pong the way consumer 9600 modems did before V.32; V.32 and V.32bis are true
full-duplex — our two WebSocket directions are a 4-wire equivalent, so the echo
canceller real V.32 needs on a 2-wire line is unnecessary here. All carry the byte
stream with authentic async start/stop (UART) framing and play an audible
Hayes-style connect handshake (2100 Hz answer tone → training → connect).

For the exact scope of each implementation — what's genuine ITU, what's
simplified for this lossless link, and what real-modem interop would need — see
**PROTOCOLS.md**.

Both ends must use the same protocol; the client sends its choice in the dial
message and the server matches it.

### Clean-link DSP adjustments

synthmodem's DSP was only ever exercised as the ANSWER side against real
hardware, so a few answer-centric assumptions were relaxed for JS<->JS use (all
gated behind config flags in `vendor/synthlink-config.js`, defaults preserved for
other consumers): skip the wall-clock carrier-detect stability gate, V.22
magnitude-only detection, answerer-only guard tone, and caller-lead V.22bis
training. These are safe only because the WebSocket link is lossless and has no
V.32 automode signals — **not** valid against real phone lines. Full rationale
and per-protocol detail in **PROTOCOLS.md**.

## Provenance

The V.22/V.22bis DSP and the V.8 sequencer are JavaScript ports of **spandsp**
(`v22bis_rx.c`, `v22bis_tx.c`, `v8.c`) by Steve Underwood, © 2003-2009, LGPL-2.1
(https://github.com/freeswitch/spandsp). The FSK cores (V.21/Bell103/V.23) are
synthmodem-native; V.29/V.32/V.32bis were written for this project from the ITU
specs (spandsp has no V.32). The browser render stack is from **synthdoor**. Full
attribution, spec references, and reference implementations: **PROVENANCE.md**.

## Run

```
npm install
npm run build          # bundles the browser DSP -> public/dsp-bundle.js
npm run echo-bbs &     # optional local test BBS on telnet :2323
npm start              # http://localhost:8088
```

Open the page, enter a telnet host/port, press **Connect**, wait a few seconds
for the carrier, and click the Listen button to hear the modem. Point host/port
at any real telnet BBS to use it for real.

Security: the server is an open telnet proxy. Set `ALLOW_HOSTS=host1,host2`
before exposing it publicly.

## Reuse
- synthmodem: src/dsp/* core (ModemDSP, Handshake, V8, protocols), bundled for
  the browser via esbuild (vendored under vendor/).
- synthdoor: browser terminal/renderer/font/music (public/*.js) reused nearly
  verbatim — `terminal.js` adds telnet SGA (Suppress-Go-Ahead) negotiation so the
  link runs full-duplex; the rest is unmodified.

## Documentation
- **README.md** — this file (what it is, how to run).
- **PROTOCOLS.md** — per-protocol implementation scope: genuine vs simplified,
  handshakes, and the real-modem gap.
- **PROVENANCE.md** — source code and specification references.
- **HANDOFF.md** — current status and next steps.
- **CLAUDE.md** — working guide for AI assistants.
- **DEVLOG.md** — development history and superseded designs.

## Layout
- server.js ................ WS + telnet proxy + answer-side modem
- build.js ................. esbuild bundler for the browser DSP
- src/browser-dsp-entry.js . browser bundle entry
- public/index.html, main.js client UI + modem/audio/keyboard wiring
- public/{terminal,renderer,font,music}.js  synthdoor render stack (reused)
- public/dsp-bundle.js ..... built browser DSP (run `npm run build`)
- vendor/ .................. vendored synthmodem DSP + config + universal logger
- tools/echo-bbs.js ........ local telnet test BBS
- tools/sim-client.js ...... headless end-to-end test client
- tools/bundle-smoke.js .... loopback test of the built browser bundle
