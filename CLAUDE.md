# CLAUDE.md — working guide for AI assistants on SynthLink

Read this first. How to test, build, debug, and where everything else is.

## Standing rules

**0. HARD RULE — the only git command you may run is the initial clone.** No
`log`, `show`, `diff`, `blame`, `checkout`, `stash`, `revert`, `reset`, `add`,
`commit` or `push`. Not to inspect, not to "just read" an old version, not to
recover something. The working tree you were given is the entire world; if
something is missing from it, re-implement it from the documents and the code in
front of you. Committing and pushing are the user's, always. Reaching into
history to answer a question is how you end up reasoning about code that is not
running, and asking "when did this break?" is nearly always the wrong question —
see rule 3.

**1. A failing test after an intentional change means fix the code or delete the
test.** Never rewrite an assertion to accommodate the change. If the assertion
was wrong, say so out loud and explain why — do not quietly soften it.

**2. Do not remove or change working behaviour you were not asked to touch.**
Not while refactoring, not while restructuring a file, not because a new control
seems to supersede an old one. If you believe something should go, say so and
ask. `ATDT RANDOM` was parsed and dialled correctly until a UI refactor deleted
it, unasked; its six tests went red immediately and were explained away for
several sessions.

**3. A red test means something is broken RIGHT NOW — either the code or the
test.** Decide which by reading the code and running it, not by asking how long
it has been failing. "It was already failing" is not a finding. Two real
examples, and note that they resolved opposite ways: `ATDT RANDOM` was a deleted
feature, and Bell 103's `dsptest2` failure was a broken harness testing a
protocol that had always worked in the browser. Never record an expected-failure
count; every suite is expected to be green.

**4. Where the code and a document disagree, the code is what actually runs —
and neither is automatically right.** The document may record intent the code
lost, which is a bug in the code; or it may be stale, which is a bug in the
document. You usually cannot tell alone. Say plainly which two things disagree
and ask, rather than picking the one that lets you continue.

**5. Tests assert behaviour.** Not wording, labels, tooltips, toast strings,
comments or documentation references. If the only way it can break is someone
editing prose, it is not a test.

**6. Code comments state *why*, in one or two lines, and never cite a section of
one of this repo's own documents.** If a rule needs a document, the document is
the only place it lives. ITU spec citations in `vendor/src/dsp/` are the
exception and are kept: they cite Recommendations, which do not get renumbered,
and they are what makes a clean-room implementation auditable.

**7. A licence header is a notice, not a comment, and rule 6 does not reach it.**
The SPDX and attribution blocks on the spandsp- and synthdoor-derived files, and
on `fonts/vga-9x14.js`, stay where they are through any refactor. They cite
upstream projects rather than this repo's documents, and they reach the browser
through the bundle. PROVENANCE.md §6 says which file carries what.

## Documentation map (don't duplicate — cross-reference by name, not section)

- **HANDOFF.md** — current status and next steps. Start there.
- **PROTOCOLS.md** — per-protocol scope: what's genuine vs simplified, the
  handshakes, the real-modem gap. The authority on any modem question.
- **PROTOIMPROVE.md** — authenticity backlog and work queue; deleted when empty.
  Its "Reading a spec table or figure" section is the authority on getting values
  out of a Recommendation — read it before fetching any ITU table or figure.
- **FONTS.md** — how a glyph gets to the screen. The authority on any font or
  terminal-rendering question.
- **PROVENANCE.md** — where code and specs came from.
- **DEVLOG.md** — current session narrative; rolled into DEVLOG_HISTORICAL.md
  when it gets long.
- **README.md** — human-facing front page.
- **2WIRE.md / V92NOTES.md** — pending future work.

## What this is

A web BBS terminal that talks to a Node server over a **real software-modem
link**: the browser modulates keystrokes to PCM audio, ships it over a
WebSocket, the server demodulates and proxies to a telnet BBS, and back. Nothing
but modulated audio crosses the socket during a call — except in `link:'direct'`
modem-bypass mode, where the DSP is skipped and payload rides the socket raw.
Telnet terminates on the server either way.

## Repo layout

```
server.js                     WS + telnet proxy + answer-side modem; static server; /bbs.json
                              `link:'direct'` bypasses the modem; BBS is dialled on
                              carrier, not at dial (openSocket). Bypass is gated:
                              listed boards only, and one dial SERVER-WIDE per
                              interval (a silent delay — never told to the user)
build.js                      esbuild bundler → public/dsp-bundle.js
src/browser-dsp-entry.js      browser bundle entry
public/index.html, main.js    UI: scope, BBS dropdown, terminal, keyboard, share
                              panel, `?host=&port=&speed=&connect=`, the typed
                              AT command line (MS_COMMANDS is its table), the
                              local audio bus, and the desktop mouse path
                              (terminalPressActions, select/copy, URL and
                              menu-key clicks, the right-click paste box)
public/embed.js               <synthlink-terminal>: the app in an iframe, for a
                              third party's page. Served RAW — no bundle, no
                              {{TOKEN}} substitution, so nothing brand-shaped in
                              it. Attribute VALUES are the query values main.js
                              already parses, copied verbatim — no second
                              vocabulary, so a wizard mode name must be mapped
                              (embedConnectValue) and never passed through. Its
                              header block is the reference; README.md is the
                              embedder-facing half
public/about.html             ⓘ panel text — names the SERVED fonts, so it is
                              licence-bearing
public/welcome.html           welcome panel text
public/splash/                pre-roll splash video (ansirain.mp4 / ansirain.webm),
                              served with byte ranges (Safari) and NO
                              Cache-Control — see the header block in
                              server.js before adding one back. The still
                              frame, the reveal and the layer rules are in
                              index.html; only the fade-out is scripted
public/{terminal,renderer,music}.js   render stack
public/fonts/                 fonts + registry. Read the header block in
                              index.js before touching an entry. charsets.js is
                              what a byte MEANS per font (cp437.js / latin1.js);
                              a font with no `charset` is CP437, which is all
                              but one. FONTS.md §11 to add another.
public/fontmask.js            per-font sharpening strengths. HAND-EDITED, served
                              raw — edit and reload, no rebuild. FONTS.md §5.6
public/fontscale.js           hybrid layout + the edge-contact classifier
public/dsp-bundle.js          BUILT artifact — regenerate with `npm run build`
lib/site.js                   config/site.json: brand, favicon, port, the dial
                              limits; {{TOKEN}} substitution into every served
                              .html. portRules() is the parsed blockedPorts
lib/netguard.js               what may be dialled: the address policy (a
                              constant, no config key — see --allow-private-ips)
                              and the port policy (entirely config/site.json's
                              blockedPorts; this module holds no list). Also the
                              IP/CIDR primitives lib/log.js uses
lib/configload.js             reads + validates both config files. Anything
                              missing, unparseable, unknown or the wrong type is
                              FATAL and server.js exits before it listens
lib/bbslist.js                BBS directory; config/blacklist.txt filters both
                              tiers. The guide tier is APPEND-ONLY (mergeEntries)
                              and every entry carries its first-seen date
lib/altfonts.js               config/altfonts.txt: boards not drawn against
                              CP437, served at /altfonts.json. ONE font id per
                              board — the registry entry carries the face, the
                              encoding and the columns. FONTS.md §11
lib/log.js                    access / telnetFail / summary logs.
                              NEVER console.log from server.js — use this
lib/bbsstats.js               per-board dial counts
lib/telnet.js                 TelnetFilter — telnet terminates HERE, not the browser
vendor/synthlink-config.js    config overrides; used by BOTH server & bundle
vendor/src/dsp/               DSP core: ModemDSP, Handshake, V8, V8Sequencer, Primitives
vendor/src/dsp/protocols/     V21, V22, V23, V29, V32, V32bis, V34, V90, Bell103, ...
tools/tests/                  every test harness
tools/                        build and asset tooling (see below)
```

`vendor/` mirrors synthmodem's tree depth so the DSP's relative requires resolve
unchanged.

## Testing: put the config in place first

`config/` ships only `*.example` files — the operator's real ones are not in the
repo. A fresh clone therefore has no `config/site.json`, and `configload.js` is
strict, so anything that starts the server refuses to run. **Copy every example
into place before running any suite**, explicitly and as the first step:

```bash
cd config && for f in *.example; do cp "$f" "${f%.example}"; done
```

The examples are complete and valid, `httptest` and `altfonttest` need them, and
without a real file the harnesses that swap in a scratch config have nothing to
restore — `logtest` leaves `config/logging.json` pointing at its own `/tmp`
directory, which is then the config every later suite reads.

This is the setup step, not a licence to edit. Once the files are in place they
are the operator's: a harness that needs different settings writes its own
scratch copy and restores it, and reaching into `site.json` or `curated.txt` to
get a test through is still the trap named below.

## Testing: the sandbox hangs on long-lived WS listeners

**Do NOT** start `server.js`'s WebSocket listener from a test harness — `node
server.js &`, `setsid`/`nohup`, and `require('./server.js')` in-process **all
hang the sandbox**. (A plain listener that exits cleanly, or `require` +
`process.exit(0)`, are fine — the trigger is a persistent `ws` server in the
process tree.) `tools/tests/directtest.js` stubs `ws` and is the way to test
anything inside `wss.on('connection')`.

Note "appears to hang" is not always this — a quadratic acquisition loop in a new
protocol looks identical. Check the algorithm before blaming the sandbox.

Every harness lives in `tools/tests/` and states its own purpose in its header.
The ones with traps worth knowing before you touch them:

- **`dsptest2.js`** — full-stack, two `ModemDSP`s wired audio↔audio with jitter.
  `ONLY=<proto[,proto]> SECS=<n> node tools/tests/dsptest2.js`.
- **`uitest.js`, `boxjointest.js`, `urltest.js`** — need Playwright
  (`npm install --no-save playwright-core`, `PW_CHROMIUM=` to point at a
  binary). They serve `public/` from memory, so no WS-listener hang.
- **A browser harness that intersects samples across the cursor blink must time
  the gaps INSIDE the page.** Driving them from Node adds CDP serialisation cost
  to every interval, which turned a correct 350 ms rule into a 600 ms one and
  produced a flake blamed on the re-flow code for several sessions. The span
  must exceed the 500 ms ON time, not the 1000 ms period.
- **`clicktest.js`** — the mouse path without a browser: `cellAt` on a synthetic
  `this` (both the constant-pitch and the edge-table paths), and the menu-key,
  URL, blank-cell and text-entry predicates extracted from `public/main.js` by
  name. Rename one and it throws rather than testing a stale copy.
- **`embedtest.js`** — the embed builders and the share panel's embed view, no
  browser. Extracts `buildEmbedURL`, `embedConnectValue`, the two snippet
  builders and `fillSpeeds` from `public/main.js` by name, and reads the header's
  speed menu out of `index.html` rather than restating it, so a protocol added
  there is exercised without touching the harness. It asserts the snippets as
  STRINGS, which is why the next one exists.
- **`embedhosttest.js`** — the snippet as MARKUP, needs Playwright. It reads the
  snippet out of the running wizard rather than restating it, pastes it into a
  stub third-party page and checks a terminal boots in the frame at the right
  destination and speed. A snippet can pass every string assertion and still
  render nothing; only a browser parses entities. It also pins the default box,
  including that the on-screen keyboard shrinks the terminal rather than giving
  the frame a scrollbar — see the watch-out in HANDOFF.md.
- **`bustest.js`** — the audio bus in Node, no browser, on a clock it controls.
  Extracts `monitor` and `tones` from `public/main.js` by name, so renaming
  either throws rather than testing a stale copy.
- **`sinktest.js`** — the sink in a real browser, needs Playwright. It loads the
  page from BOTH a loopback and a non-loopback address of the machine, because
  browsers treat those as secure and insecure origins and audio APIs differ
  across that line. A harness that only loads 127.0.0.1 cannot see a failure
  every phone on the LAN would hit. No non-loopback address → it reports SKIP.
- **`logtest.js`, `sitetest.js` and `idletest.js` write a scratch `config/*.json`
  and restore the real one on exit.** If one dies mid-run — or if it ran before
  the examples were copied into place, so there was nothing to restore — check
  that file before wondering why the server logs somewhere odd.
- **A harness that dials ANY loopback address needs
  `--allow-private-ips=127.0.0.0/8`.** Non-public destinations are refused as a
  constant in `lib/netguard.js`; there is no config key, and the flag is the only
  way past it. `directtest.js` pushes it onto `process.argv` before requiring
  `server.js` (netguard reads argv once, at load); `idletest.js` passes it to the
  child it spawns; `tools/echo-bbs.js` prints the invocation it needs. Moving a
  mock BBS elsewhere cannot substitute — every address on this machine is
  loopback or RFC1918.
- **A scratch config a harness writes must be COMPLETE and valid.** An unknown
  key, a missing file, a boolean written as a string: all fatal, both files. A
  harness that writes a partial `logging.json` gets a server that will not start
  rather than one running on defaults.
- **A harness that dials loopback through telnet bypass hits the gates.** Bypass
  only dials boards the directory offers, and only once server-wide per interval
  (config/site.json) — so back-to-back bypass dials in a harness are SLOW, not
  broken, however many fake clients they come from. `directtest.js` wraps `lib/bbslist` and `lib/site` at
  `Module._load` to supply both; `idletest.js` turns the gate off in the scratch
  config it already writes. Never reach for the operator's real config or
  `curated.txt` to get a test through. Note `directtest.js` DOES read the real
  `config/site.json` for the port policy, so emptying `blockedPorts` fails it.
- Several harnesses **extract functions from `public/main.js` by name** — it
  can't be required, it runs against a live DOM. Rename one of those functions
  and the extraction throws rather than testing a stale copy.
- **A real browser↔`server.js` WS check must run from a genuine shell outside
  the sandbox**, then point `tools/jitter-repro.js PROTO=<name>` at it.

### Time budget

`dsptest2` sizes its own budget per protocol, so all ten pass in one batch with
no `SECS` — 300 bps genuinely needs ~13 s for banner+echo and that is not a
flake. Set `SECS` only to squeeze deliberately. Sandbox wall-clock is still tens
of seconds, so **split the ten across a few calls**.

## Tooling outside tools/tests/

`fontaspect.py` mints an aspect-scaled `.ttf` into `tools/datasource`;
`shadefix.py` re-pitches ░▒▓ in a nine-wide font so a run of them tiles;
`topazsubset.py` cuts the Amiga face down to its 256 codepoints and stretches Y
to the aspect an Amiga displayed; `mkwoff2.py` makes the shipped `.woff2`. All run BY HAND, none on any test path,
and all need `pip install fonttools brotli`. **If you edit a glyph, move its
`hmtx` lsb with it** — a mismatch against `glyf`'s `xMin` silently shifts the
glyph in its cell, and it cost a round of work.

`probe.html` is the device probe. `v29-proto.js` / `v29-stream.js` are the
scaffolds a next protocol starts from. `echo-bbs.js` is an offline telnet peer;
`update-bbslist.js` and `blacklist-probe.js` maintain the directory.

## Building the browser bundle

`npm run build` (esbuild) needs the **native binary for this OS**. The repo's
`node_modules` may ship a win32 esbuild. Fix without touching `package.json`:

```bash
npm install --no-save @esbuild/linux-x64@0.23.1   # match the installed version
npm run build
```

Output: `public/dsp-bundle.js`, IIFE global `SynthModemDSP = { ModemDSP, Buffer,
config }`. **Rebuild after ANY change under `vendor/src/dsp/` or the browser
gets stale DSP.** The bundle is NOT minified — comments and names survive — but
esbuild rewrites `class Foo extends Bar` into `var Foo = class extends Bar`, so
confirm a class is present by driving it, not by grepping for its declaration.

## Browser-path safety: NO Node-only refs in the DSP

Anything reachable from the browser (originate side) must have **no**
`process.*`, `fs`, `os`, `path`. Such a ref works in Node and silently crashes
the browser bundle — looks like "server connects, browser doesn't". After any
`vendor/` change, rebuild, then run:

```bash
node -e "const fs=require('fs');const B=new Function('process',fs.readFileSync('public/dsp-bundle.js','utf8')+'\nreturn SynthModemDSP;')(undefined);const {ModemDSP,config}=B;config.modem.native.protocolPreference=['V32bis'];config.modem.native.v8ModulationModes=['V32bis'];const o=new ModemDSP('originate');o.start();for(let i=0;i<200;i++)o.receiveAudio(new Float32Array(160).fill(0.05));o.stop();console.log('browser path OK');"
```

## Config is a shared singleton

`vendor/synthlink-config.js` (and the bundle's `config`) is mutated per-call
(`config.modem.native.protocolPreference = ['V32bis']`) just before DSP
construction. Both ends in an in-process test share it — set once per test, in
the same tick you construct the DSP.

## Local audio: one bus, one sink

Everything the page can make a sound with — carrier both directions, dial tone,
DTMF, ringback, the handset clip — is PCM at `SR`, mixed into one ring in
`monitor` (`public/main.js`). The oscilloscope and spectrum read that ring; so
does the speaker. There is no second path and no AnalyserNode.

- Positions are ABSOLUTE sample indices from the start of the call, `% BUS_LEN`
  to index the ring. `playPos()` is the sample being heard, run off the wall
  clock, so it advances whether or not the AudioContext does — which is why the
  scope works with the speaker muted, suspended, or never started.
- The sink is a **ScriptProcessor** pulling one continuous stream, resampling
  `SR` into the context's rate. Do not go back to scheduling buffer sources:
  boundaries between them slip a sample, and a cursor that re-anchors when a
  refill runs late steps the waveform mid-carrier. That was the Chrome crackle.
  AudioWorklet was tried and dropped — it is secure-context only, so it does not
  exist on a plain-http origin, and its position reports lagged the trace behind
  the audio.
- Nothing may be written at or below the post frontier: those samples are gone.
  A writer that falls behind resumes ahead of it, dropping frames **for
  listening only** — the demodulator is on the other side of the bus and gets
  every sample. The speaker can never affect the link.
- Nothing is handed to the sink while the context is not running, so no backlog
  can accumulate to be dumped on the visitor's first touch.

## Debugging DSP: instrument the bit chain, not the audio

Isolate layers rather than staring at samples:

1. Pure scrambler+framing+descrambler+UART chain, no DSP — verifies bit logic.
2. TX-scrambled vs RX-recovered bits, aligned by best-offset, with **per-symbol
   (mod N) error rate** — a periodic error points at a bit position; a broadband
   error means the receiver is decoding noise or silence.

Add temporary `this._dbg`-gated hooks, then remove them (`grep _dbg`).

Known symptom→cause: a repeating single-byte flood = receiver decoding trailing
silence as data. **A perfectly clean all-ones descrambled stream** usually means
the receiver is frame-misaligned, not that the peer is idle — descrambling
constant-1 input yields constant 1. Dump transmitted vs received symbol vectors
for one frame; a half-preamble/half-data vector names the bug immediately.

Golden test for scramblers: V.32bis §5.2.3 — scrambling ones with GPC from the
zero state must yield `11 11 11 11 11 11 11 11 11 00 00 01 …`.

## Adding a protocol (checklist)

1. **Read the spec properly first.** PROTOIMPROVE.md — asked normally, the
   retrieval *reconstructs* tables and returns confident wrong values. Demand a
   literal transcription or an explicit refusal, one table per call, and
   cross-check against the spec's own formulas.
2. Build the spec-defined blocks as **standalone, round-trip-verified
   components** before wiring anything (`v34-*-check`, `v90-*-check` are the
   pattern).
3. Get it working originate↔answer in a protocol-unit loopback. Watch for
   answer-side-only assumptions (guard tone, detection heuristics, wall-clock
   gates).
4. Wire it — **five** places: the class, `Handshake.js` (require + `PROTOCOLS` +
   V.8 wiring + `ready` branch), `server.js` `PROTOS` (miss this → silent V.21
   fallback), `index.html` `<select>`, and **`MS_COMMANDS` in `public/main.js`**
   (a menu entry with no row there makes `AT+MS=<yours>` answer `ERROR`; a row
   with no menu entry is worse — it resolves and blanks the `<select>`, so the
   two move together in both directions, including when one is REMOVED). **Prefer real V.8 to a `want<X>`
   bypass** — map the name in `V8.selectProtocol`, advertise its bit in
   `V8Sequencer._buildModes`, and add `setV8Complete()` if the class emits its
   own answer tone, or the second tone trips the peer's acquisition. Only V.29
   still bypasses.
5. `npm run build`; run the browser-path safety check; `node
   tools/tests/attest.js`; full-stack with `ONLY=<X>`; regression the others;
   confirm through the bundle (`PROTO=<X> node tools/tests/bundle-smoke.js`).
6. Update HANDOFF.md and PROTOCOLS.md; move history to DEVLOG.md; add anything
   left unverified to PROTOIMPROVE.md rather than leaving it in a code comment.

## Adding a board-specific font (checklist)

For a board not drawn against CP437 — an Amiga board, say. **FONTS.md §11 is the
authority**; this is the shape of it.

1. **Capture the wire bytes** (SyncTERM `Alt-C`, ANSI/raw). A screenshot cannot
   tell you the encoding and a guess at it is silently wrong.
2. Identify the charset and the FACE from that capture — the face by diffing
   against the bitmaps in SyncTERM's `src/conio/allfonts.c`, not by filename.
3. Derive the ASPECT from the machine, correct it offline in the asset, and
   prefer scaling Y (X-only `hmtx` cannot then desynchronise from `glyf`).
4. Subset, `tools/mkwoff2.py`, registry entry with `charset` and `hidden: true`.
5. `node tools/tests/ttftest.js` and `altfonttest.js`; `boxjointest` for the
   fonts already there. A new font must move NOTHING for the existing ones.
6. Credit it in `public/about.html` — served is served, `hidden` or not — and
   PROVENANCE.md. Then HANDOFF.md and FONTS.md.
