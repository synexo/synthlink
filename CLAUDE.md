# CLAUDE.md — working guide for AI assistants on SynthLink

Read this first. It's the operational playbook: how to test, build, debug, and
where to find everything else. Terse, hard-won.

## Documentation map (don't duplicate — cross-reference)
- **HANDOFF.md** — current status + last two sessions + next steps. Start there.
- **PROTOCOLS.md** — exact per-protocol scope: what's genuine vs simplified, the
  handshakes, and the real-modem gap. The authority on any modem question.
- **PROTOIMPROVE.md** — scoped authenticity backlog: what is still not spec-exact,
  why, and how to fix it. **§0 documents the spec-retrieval technique** — read it
  before fetching any ITU table.
- **PROVENANCE.md** — where code/specs came from (spandsp, synthdoor, ITU specs).
- **DEVLOG.md** — history, superseded designs, UI internals, planning archives.
- **README.md** — human-facing front page (what it is, how to run).

Keep docs from drifting from code. When status changes, update HANDOFF.md (and
PROTOCOLS.md if implementation scope changed); move anything historical to DEVLOG.

## What this is (one paragraph)
A web BBS terminal that talks to a Node server over a **real software-modem link**:
the browser modulates keystrokes to PCM audio, ships it over a WebSocket, the
server demodulates and proxies to a telnet BBS, and back. Nothing but modulated
audio crosses the socket during a call — except in the `link:'direct'`
modem-bypass mode, where the DSP is skipped and payload rides the socket raw.
Telnet terminates on the server either way. Data path diagram in README.md;
provenance in PROVENANCE.md.

## Repo layout (essentials)
```
server.js                     WS + telnet proxy + answer-side modem; static server; /bbs.json
                              `link:'direct'` on the dial message bypasses the modem:
                              binary frames carry payload, not PCM (transportWrite)
                              BBS is dialled on carrier, not at dial (openSocket)
build.js                      esbuild bundler → public/dsp-bundle.js
src/browser-dsp-entry.js      browser bundle entry (exposes {ModemDSP,Buffer,config})
public/index.html, main.js    UI: scope, BBS dropdown, terminal; modem/audio/keyboard wiring
public/about.html             text of the ⓘ panel — HTML fragment injected into #aboutbody
public/{terminal,renderer,music}.js   synthdoor render stack (telnet moved to lib/telnet.js)
public/fonts/                 CP437 terminal fonts + registry (add a font here; DEVLOG)
                              `hidden: true` on an entry keeps it out of the UI cycle
lib/bbslist.js                BBS directory: curated tier + Telnet BBS Guide pull
lib/telnet.js                 TelnetFilter — telnet terminates HERE, not the browser
                              (SGA + TTYPE→ANSI + NAWS 80×25); dependency-free CJS
public/dsp-bundle.js          BUILT artifact — regenerate with `npm run build`
vendor/synthlink-config.js    config overrides (protocol + clean-link flags); used by BOTH server & bundle
vendor/src/dsp/               DSP core: ModemDSP, Handshake, V8, V8Sequencer, Primitives
vendor/src/dsp/protocols/     V21, V22 (V22+V22bis), V23, V29, V32, V32bis, V34, V90, Bell103, ...
                              V34.js + V34Mapper.js   (mapper = shell/differential/trellis)
                              V90.js + V90Mapper.js   (mapper = µ-law/modulus/shaper)
                                    + V90Phase4.js    (CP/MP bit sequences, Tables 14/16)
vendor/src/dsp/V8.js, V8Sequencer.js   V.8 negotiation — used by every protocol
                              except V.29 (PROTOCOLS.md §9)
tools/                        test harnesses (see Testing below)
tools/{v29-proto,v29-stream,qam9600-proto}.js   prototype scaffolds (reference; not shipped)
```
`vendor/` mirrors synthmodem's tree depth so the DSP's relative requires resolve
unchanged.

## Testing: the sandbox hangs on long-lived WS listeners
**Do NOT** start `server.js`'s WebSocket listener from a test harness — `node
server.js &`, `setsid`/`nohup`, and `require('./server.js')` in-process **all hang
the sandbox**. (A plain listener that exits cleanly, or `require` + `process.exit(0)`,
are fine — the trigger is a persistent `ws` server in the process tree.)

Instead, test in-process with no sockets:
- **Full-stack** (`tools/dsptest2.js`): two `ModemDSP`s wired
  `audioOut→receiveAudio` with random-chunk jitter + a line-buffering mock BBS;
  asserts byte-exact `data` both directions. Covers the real Handshake + ModemDSP
  pump + protocol DSP — the only layers that change. Env: `ONLY=<proto[,proto]>`,
  `SECS=<n>`. Example: `ONLY=V32bis SECS=16 node tools/dsptest2.js`.
- **Protocol-unit** (`tools/v32test.js`, `tools/v32bistest.js`, `tools/v29test.js`):
  two protocol classes wired directly, pumped in 160-sample blocks. Fastest way to
  isolate a constellation/scrambler/framing/acquisition bug.
- **V.90 components** (`tools/v90-{ulaw,modulus,shaper,map,phase4}-check.js`): the
  whole downstream chain is sockets-free, DSP-free integer arithmetic, so each block
  is provable standalone and all five run in seconds. `phase4` asserts CP/MP field
  **positions** against Tables 14/16, not merely that they round-trip — a
  self-consistent encoder/decoder pair will agree on a wrong layout.
- **V.34 components** (`tools/v34-{trellis,shell,map,eye}-check.js`): same pattern.
- **Telnet filter** (`tools/telnettest.js`): pure byte-in/byte-out unit tests for
  `lib/telnet.js` — SGA/TTYPE/NAWS exchanges, IAC escaping, and a fuzz loop that
  re-splits one stream at random chunk boundaries and asserts an identical result.
  No sockets, sub-second. `node tools/telnettest.js`.
- **BBS dropdown labels** (`tools/bbslabeltest.js`): the breakpoint-dependent
  option labels in `public/main.js` (desktop `Name · host:port`, mobile name only).
  `main.js` can't be required — it runs top-to-bottom against a live DOM and an
  `AudioContext` — so the harness **extracts `bbsLabelText`/`bbsOption`/`relabelBBS`
  from the source by name** and drives them against a stub `<select>` with a
  settable `isMobile()`. Rename one of those and the extraction throws rather than
  testing a stale copy. Instant, no DOM library. `node tools/bbslabeltest.js`.
  **Never recover data by parsing an option's label** — it is lossy on mobile;
  `dataset.name`/`dataset.hp` carry it (DEVLOG).
- **Direct mode / server session** (`tools/directtest.js`): drives the *real*
  `server.js` session code with only the `ws` module stubbed (an EventEmitter
  that never listens — so no persistent WS server enters the process tree), a
  genuine TCP mock BBS on one side and a recording fake socket on the other.
  Asserts direct mode carries payload not PCM, that telnet still terminates
  server-side, that the BBS is dialled only *after* carrier, and that an
  unreachable board reports `proxyError`. The last stage wires a real originate
  `ModemDSP` to the fake socket for a full V.32bis call through `server.js`.
  **This stub is the way to test anything inside `wss.on('connection')` without
  tripping the hang.** `node tools/directtest.js` (~10 s).
- **Shipped bundle** (`tools/bundle-smoke.js`): runs the built browser bundle's
  ModemDSP (originate) against the vendored one (answer). `PROTO=<name>` selects the
  protocol — it must set it on **both** configs, because the bundle carries its own
  config instance. `V34RATE=` / `V90RATE=` pick a sub-rate.
- A real browser↔`server.js` WS check must run from a genuine shell **outside** the
  sandbox, then point `tools/jitter-repro.js PROTO=<name>` at it.

Harnesses may use absolute require paths (`/home/claude/synthlink/...`) — adjust
per machine or switch to relative paths from the repo root.

## Time budget
The harness has a wall-clock limit of tens of seconds. Slow protocols need long
windows: **V.21 @ 300 bps** — a ~185 B banner alone is ~6 s, full banner+echo ~9 s
and it can flake at the margin (pre-existing; not a regression). **Bell 103 fails
`dsptest2` outright** (banner yes, echo no) — verified identical on pristine HEAD,
so don't chase it as a regression. V.29 connects in ~2–3 s; V.32/V.32bis ~3.8 s and
V.34 ~4–6 s now that they run a real V.8 exchange; V.90 ~4.8 s. **Split protocols
across calls** and **early-exit on success**; don't batch all of them into one
timed run.

Note "appears to hang" is not always the WS-listener trap below — a quadratic
acquisition loop in a new protocol looks identical. Check the algorithm before
blaming the sandbox.

## Building the browser bundle
`npm run build` (esbuild) needs the **native binary for this OS**. The repo's
`node_modules` may ship a win32 esbuild; on Linux it throws "installed esbuild for
another platform". Fix without touching `package.json`:
```bash
npm install --no-save @esbuild/linux-x64@0.23.1   # match the installed esbuild version
node build.js                                      # or: npm run build
```
Output: `public/dsp-bundle.js`, IIFE global `SynthModemDSP = { ModemDSP, Buffer,
config }`, built from `src/browser-dsp-entry.js`. **Rebuild after ANY change under
`vendor/src/dsp/` or the browser gets stale DSP.** The bundle minifies (comments
stripped, classes renamed), so verify presence by driving it, not by grepping the
class name — load it and construct/run the protocol (see the bundle test below).

## Browser-path safety: NO Node-only refs in the DSP
Anything reachable from the browser (originate side) must have **no** `process.*`,
`fs`, `os`, `path`, etc. Such a ref works in Node (server) and silently crashes the
browser bundle — looks like "server connects, browser doesn't". After any `vendor/`
change, rebuild, then run the `process`-shadowed check:
```bash
node -e "const fs=require('fs');const B=new Function('process',fs.readFileSync('public/dsp-bundle.js','utf8')+'\nreturn SynthModemDSP;')(undefined);const {ModemDSP,config}=B;config.modem.native.protocolPreference=['V32bis'];config.modem.native.v8ModulationModes=['V32bis'];const o=new ModemDSP('originate');o.start();for(let i=0;i<200;i++)o.receiveAudio(new Float32Array(160).fill(0.05));o.stop();console.log('browser path OK');"
```
To confirm a new protocol works through the shipped bundle end-to-end, load the
IIFE, set `config.modem.native.protocolPreference`/`v8ModulationModes` to it, wire
two bundle `ModemDSP`s audio↔audio with jitter, and assert byte-exact both ways.

## Config is a shared singleton
`vendor/synthlink-config.js` (and the bundle's `config`) is mutated per-call
(`config.modem.native.protocolPreference = ['V32bis']`) just before DSP
construction. Both ends in an in-process test share it — set once per test, in the
same tick you construct the DSP. Clean-link flags and their meaning: PROTOCOLS.md §0.

## Debugging DSP: instrument the bit chain, not the audio
When bytes come out wrong, don't stare at samples — isolate layers:
1. Pure scrambler+framing+descrambler+UART chain, no DSP — verifies bit logic.
2. TX-scrambled vs RX-recovered bits, aligned by best-offset, with **per-symbol
   (mod N) error rate** — a periodic error points at a specific bit position; a
   broadband error means the receiver is decoding noise/silence.
Add temporary `this._dbg`-gated capture hooks, then remove them (`grep _dbg`).
Known symptom→cause: a repeating single-byte flood = receiver decoding trailing
silence / idle carrier as data. Another: **a perfectly clean all-ones descrambled
stream** (i.e. "the peer is only sending idle") usually means the receiver is
frame-misaligned, not that the transmitter is idle — descrambling constant-1 input
yields constant 1, so a wrong alignment can look like a silent peer. Dump the
transmitted vs received symbol vectors for one frame; a half-preamble/half-data
vector names the bug immediately.

Useful golden test for scramblers: V.32bis §5.2.3 — scrambling ones with GPC from
the zero state must yield `11 11 11 11 11 11 11 11 11 00 00 01 …` (states
`CCCCCCCCCAAACCC`). See PROTOCOLS.md §5.

## Adding a protocol (checklist)
1. **Read the spec properly first.** PROTOIMPROVE.md §0 — asked normally, the
   retrieval *reconstructs* tables and returns confident wrong values. Demand a
   literal transcription or an explicit refusal, one table per call, and
   cross-check what returns against the spec's own formulas. Several caveats in
   this repo exist only because that step was skipped.
2. Build the spec-defined blocks as **standalone, round-trip-verified components**
   before wiring anything (`v34-*-check`, `v90-*-check` are the pattern). For
   V.90 the entire mapper was provable with no DSP and no sockets.
3. Get it working originate↔answer in a protocol-unit loopback. Watch for
   answer-side-only assumptions (guard tone, detection heuristics, wall-clock
   gates).
4. Wire it: the class, `Handshake.js` (require + `PROTOCOLS` + **V.8 wiring** +
   `ready` branch), `server.js` `PROTOS` (miss this → silent V.21 fallback),
   `index.html` `<select>`. **Prefer real V.8 to a `want<X>` bypass** — map the
   name in `V8.selectProtocol`, advertise its bit in `V8Sequencer._buildModes`,
   and add `setV8Complete()` if the class emits its own answer tone. Only V.29
   still bypasses. Details: PROTOCOLS.md §9.
5. `npm run build`; run the browser-path safety check; full-stack test with
   `ONLY=<X>`; regression the others; confirm through the bundle
   (`PROTO=<X> node tools/bundle-smoke.js`).
6. Update HANDOFF.md + PROTOCOLS.md; move history to DEVLOG.md; add anything left
   unverified to PROTOIMPROVE.md rather than leaving it only in a code comment.
