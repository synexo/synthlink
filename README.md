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
  V.22     1200 bps     DPSK
  V.22bis  2400 bps     16-QAM (with V.22 fallback path)
  V.23     1200/75 bps  split-speed FSK
  V.29     9600 bps     16-QAM, half-duplex ping-pong (Hayes "Express 96" style)

V.29 is a half-duplex modem: full-duplex 9600 on a 2-wire line needed echo
cancellation (that arrived with V.32). So, like the consumer 9600 modems that
used V.29 modulation before V.32, our V.29 runs half-duplex ping-pong — it
buffers data and sends it in bursts, turning the line around between bursts —
and carries the byte stream with authentic async start/stop (UART) framing.
On connect it plays an audible Hayes-style handshake — the answerer's 2100 Hz
V.25 answer tone, then a short V.29 training burst, then CONNECT 9600. These
pre-roll bursts never present a frame-sync boundary, so the receiver's squelch
discards each on the turnaround-guard silence that follows it and byte sync is
unaffected. See vendor/src/dsp/protocols/V29.js for the full rationale.

Both ends must use the same protocol; the client sends its choice in the dial
message and the server matches it.

### Clean-link DSP adjustments

synthmodem's DSP was only ever exercised as the ANSWER side against real
hardware, so a few answer-centric assumptions had to be relaxed for JS<->JS use
(all gated behind config flags in vendor/synthlink-config.js; defaults
preserved for other consumers of the DSP):

- skipCdVerification - skips the wall-clock carrier-detect stability gate (a
  phone-line-noise filter) that can't latch under browser main-thread
  contention on a lossless link.
- v22MagOnlyDetect - for V.22, drops the answer-side anti-V.32-Signal-AA
  spectral test (which can never pass against a guard-tone-emitting peer) and
  detects on the matched-filter magnitude instead.
- V.22 guard tone (1800 Hz) is now emitted only by the answerer, per V.22bis
  2.2 - previously hard-coded on for both roles, which defeated originate-side
  carrier detection. (Same fix applied to the V.22bis class.)
- V.22bis originate (calling-side) training was never implemented in
  synthmodem - only the answer side. The caller-leads S1 exchange is now
  wired: once the caller confirms the answerer's carrier it proactively sends
  the S1 rate signal and commits to 2400, and each side's demodulator rates up
  on its own. Validated originate<->answer in loopback and over the WebSocket.

## Provenance

The V.22/V.22bis DSP and the V.8 sequencer are JavaScript ports of spandsp
(v22bis_rx.c, v22bis_tx.c, v8.c) by Steve Underwood, (C) 2003-2009, LGPL-2.1 -
https://github.com/freeswitch/spandsp . See synthmodem's COPYING and
licenses/SPANDSP-NOTICE for the full attribution.

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
