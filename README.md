# SynthLink

A web BBS terminal that talks to a JavaScript server over a **real software-modem
link** (real modem DSP — actual PCM audio carries the data), then proxies to
arbitrary telnet BBSes. The audio is real; the client has a speaker button to
hear the carrier in both directions.

```
browser: keystroke -> ModemDSP('originate').write -> PCM audio
   -> WebSocket -> server: ModemDSP('answer').receiveAudio -> demod bytes
   -> telnet filter -> telnet BBS
BBS bytes -> telnet filter -> answer.write -> PCM audio -> WebSocket
   -> browser: originate.receiveAudio -> demod bytes -> ANSIParser -> Terminal -> canvas
```

Nothing but modulated audio crosses the socket during a call. Telnet is
terminated at the *server*, so option negotiation never costs carrier time.

The one exception is the **Telnet - modem bypass** speed, which skips the modem
entirely: the same telnet-filtered bytes ride the WebSocket raw, with no audio
anywhere in the path.

Open the page, pick a BBS from the directory (or type a host/port), choose a
speed, and press **Connect**. The toolbar has a real-time oscilloscope showing
the actual carrier waveform (with a live bps throughput readout in its corner;
in modem-bypass mode, where there is no carrier, the same box becomes a scrolling
network throughput graph),
and the carrier is audible by default (audio starts on the Connect click per
browser autoplay rules). The speaker button cycles **Auto → Listen → Mute**: Auto
plays through the dial and handshake then fades to silence ~10 s after connect,
re-arming on each new connect; Listen and Mute stick.

The toolbar also has toggles for scrollback, the on-screen keyboard, the terminal
font, zoom magnification and fullscreen, plus an **ⓘ** button with a short note
about the project (its text is `public/about.html` — a plain HTML fragment you
can edit). On a touch screen, the first touch on the terminal brings up the
on-screen keyboard; touch again to magnify, and your finger pans until you
release. The magnification button cycles 2×, 3×, and off.

Defaults: `bbs.birdenuf.com:2003`, V.22bis (2400 bps), sound on. Narrow screens
start on a taller 8×19 font for legibility; the desktop default is IBM VGA 8×16.
Your settings — destination, speed, font, and the toggles — are remembered in the
browser between visits, along with your favorites.

### BBS directory

The **BBS** dropdown has two directory tiers, plus your own favorites. While a
call is up, the **BBS** label becomes a heart: click it to add the board you are
connected to (or remove it again), and favorites appear in their own group at the
top of the list. A **Random BBS Selection** entry picks a board at random from
across both tiers. Of the two tiers, a curated list comes first, from
`config/curated.txt` — one `Name, host:port` per line (port defaults to 23,
`#` comments ignored), served live so you can edit it without restarting. Below
it is the Telnet BBS Guide's monthly list, cached under `cache/` (gitignored)
and refreshed by a background check; see DEVLOG.md, and note the automatic pull
is not working yet. Prime or update it by hand with:

```
npm run update-bbslist -- --file /path/to/ibbs0826.zip
```

or by dropping the monthly zip into `cache/`. Selecting an entry fills the
host/port; the pencil button switches the field to manual `host:port` entry.

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
  V.34     28800 bps    shell-mapped trellis-coded QAM (also 19200)
  V.34     31200 bps    as above, 3200 baud
  V.34     33600 bps    as above, 3429 baud with §8.2 frame switching

Plus one entry that is not a modem at all:

  Telnet   network speed modem bypassed entirely; raw bytes over the WebSocket

The 9600-and-above protocols are genuine ITU modulation implementations written
for this project (there is no spandsp reference for them). V.29 runs half-duplex
ping-pong the way consumer 9600 modems did before V.32; V.32 and V.32bis are true
full-duplex — our two WebSocket directions are a 4-wire equivalent, so the echo
canceller real V.32 needs on a 2-wire line is unnecessary here. V.34 is a
clean-room implementation at four rates, selected per call. All carry the byte
stream with authentic async start/stop (UART) framing and play an audible
Hayes-style connect handshake (2100 Hz answer tone → training → connect).

For the exact scope of each implementation — what's genuine ITU, what's
simplified for this lossless link, and what real-modem interop would need — see
**PROTOCOLS.md**.

Both ends must use the same protocol; the client sends its choice in the dial
message and the server matches it. Selecting the bypass entry sends
`link:'direct'` instead, and no modem is constructed on either side.

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
synthmodem-native; V.29/V.32/V.32bis/V.34 were written for this project from the
ITU specs (spandsp has no V.32). The browser render stack is from **synthdoor**.
The 8×19 terminal fonts come from VileR's Ultimate Oldschool PC Font Pack and are
**CC BY-SA 4.0**, licensed separately from the rest of the repo. Full attribution,
spec references, and reference implementations: **PROVENANCE.md**.

## Run

```
npm install
npm run build          # bundles the browser DSP -> public/dsp-bundle.js
npm run echo-bbs &     # optional local test BBS on telnet :2323
npm start              # http://localhost:8088
```

Open the page, enter a telnet host/port, press **Connect**, wait a few seconds
for the carrier, and use the speaker button to hear the modem. Point host/port
at any real telnet BBS to use it for real.

The BBS is dialled once the carrier is up rather than the moment you press
Connect, so the board's own timers (a "press a key" prompt, a menu timeout) do
not run during the handshake. One consequence: an unreachable board is only
discovered after the handshake, and reports `TELNET PROXY CONNECT FAILED` in the
terminal. A bad hostname still fails immediately, since it is resolved up front.

Security: the server is an open telnet proxy. Set `ALLOW_HOSTS=host1,host2`
before exposing it publicly.

## Reuse
- synthmodem: src/dsp/* core (ModemDSP, Handshake, V8, protocols), bundled for
  the browser via esbuild (vendored under vendor/).
- synthdoor: browser terminal/renderer/font/music (public/*.js) reused nearly
  verbatim — telnet handling was lifted out of `terminal.js` to the server
  (`lib/telnet.js`), and `renderer.js` + the font data were reworked for
  selectable fonts (`public/fonts/`); ANSIParser and music are unmodified.

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
- public/{terminal,renderer,music}.js  synthdoor render stack (reused)
- public/about.html ........ text of the ⓘ panel (plain HTML fragment, editable)
- public/fonts/ ............ CP437 terminal fonts + registry (add fonts here)
- public/dsp-bundle.js ..... built browser DSP (run `npm run build`)
- vendor/ .................. vendored synthmodem DSP + config + universal logger
- lib/bbslist.js ........... BBS directory: curated tier + Telnet BBS Guide pull
- lib/telnet.js ............ telnet option negotiation (terminated server-side)
- config/curated.txt ....... the curated BBS list (hand-edited)
- cache/ ................... fetched BBS guide data (gitignored)
- tools/echo-bbs.js ........ local telnet test BBS
- tools/update-bbslist.js .. fetch/ingest the Telnet BBS Guide monthly list
- tools/sim-client.js ...... headless end-to-end test client
- tools/bundle-smoke.js .... loopback test of the built browser bundle
- tools/telnettest.js ...... unit tests for the telnet filter
- tools/directtest.js ...... end-to-end test of modem-bypass mode
