# CLAUDE.md — working guide for AI assistants on SynthLink

Read this first. It's the operational playbook: how to test, build, debug, and
where to find everything else. Terse, hard-won.

## Documentation map (don't duplicate — cross-reference)
- **HANDOFF.md** — current status + last two sessions + next steps. Start there.
- **PROTOCOLS.md** — exact per-protocol scope: what's genuine vs simplified, the
  handshakes, and the real-modem gap. The authority on any modem question.
- **PROVENANCE.md** — where code/specs came from (spandsp, synthdoor, ITU specs).
- **DEVLOG.md** — history, superseded designs, UI internals, planning archives.
- **README.md** — human-facing front page (what it is, how to run).

Keep docs from drifting from code. When status changes, update HANDOFF.md (and
PROTOCOLS.md if implementation scope changed); move anything historical to DEVLOG.

## What this is (one paragraph)
A web BBS terminal that talks to a Node server over a **real software-modem link**:
the browser modulates keystrokes to PCM audio, ships it over a WebSocket, the
server demodulates and proxies to a telnet BBS, and back. Nothing but modulated
audio crosses the socket during a call. Data path diagram in README.md; provenance
in PROVENANCE.md.

## Repo layout (essentials)
```
server.js                     WS + telnet proxy + answer-side modem; static server; /bbs.json
build.js                      esbuild bundler → public/dsp-bundle.js
src/browser-dsp-entry.js      browser bundle entry (exposes {ModemDSP,Buffer,config})
public/index.html, main.js    UI: scope, BBS dropdown, terminal; modem/audio/keyboard wiring
public/{terminal,renderer,font,music}.js   synthdoor render stack (terminal.js +telnet SGA)
public/dsp-bundle.js          BUILT artifact — regenerate with `npm run build`
vendor/synthlink-config.js    config overrides (protocol + clean-link flags); used by BOTH server & bundle
vendor/src/dsp/               DSP core: ModemDSP, Handshake, V8, V8Sequencer, Primitives
vendor/src/dsp/protocols/     V21, V22 (V22+V22bis), V23, V29, V32, V32bis, Bell103, FskCommon, ...
tools/                        test harnesses (see Testing below)
v29-proto.js v29-stream.js qam9600-proto.js   root prototypes (reference; not shipped)
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
- A real browser↔`server.js` WS check must run from a genuine shell **outside** the
  sandbox, then point `tools/jitter-repro.js PROTO=<name>` at it.

Harnesses may use absolute require paths (`/home/claude/synthlink/...`) — adjust
per machine or switch to relative paths from the repo root.

## Time budget
The harness has a wall-clock limit of tens of seconds. Slow protocols need long
windows: **V.21 @ 300 bps** — a ~185 B banner alone is ~6 s, full banner+echo ~9 s
and it can flake at the margin (pre-existing; not a regression). The QAM protocols
(V.29/V.32/V.32bis) connect in ~2–3 s. **Split protocols across calls** and
**early-exit on success**; don't batch all of them into one timed run.

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
silence / idle carrier as data.

Useful golden test for scramblers: V.32bis §5.2.3 — scrambling ones with GPC from
the zero state must yield `11 11 11 11 11 11 11 11 11 00 00 01 …` (states
`CCCCCCCCCAAACCC`). See PROTOCOLS.md §5.

## Adding a protocol (checklist)
1. Get it working originate↔answer in a protocol-unit loopback first. Watch for
   answer-side-only assumptions (guard tone, detection heuristics, wall-clock
   gates); for symmetric self-training protocols, decide whether to bypass V.8/ANS
   entirely (as V.29/V.32/V.32bis do).
2. Wire four places: the class, `Handshake.js` (require + `PROTOCOLS` + `want<X>`
   bypass + `ready` branch), `server.js` `PROTOS` (miss this → silent V.21
   fallback), `index.html` `<select>`. Details: PROTOCOLS.md §7.
3. `npm run build`; run the browser-path safety check; full-stack test with
   `ONLY=<X>`; regression the others; confirm through the bundle.
4. Update HANDOFF.md + PROTOCOLS.md; move history to DEVLOG.md.
