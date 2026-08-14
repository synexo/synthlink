# CLAUDE.md — working notes for developing SynthLink

Terse, hard-won operational notes. Read before testing or building.

## Testing: the sandbox hangs on long-lived listeners
The test harness **hangs / returns failure** whenever a long-lived `ws` server
stays alive in its process tree — this includes `node server.js &` (backgrounded),
`setsid`/`nohup` detachment, **and** `require('./server.js')` in-process. What
works fine: a plain `net`/HTTP listener that exits cleanly, `require('./server.js');
process.exit(0)` (synchronous exit), and backgrounding a plain `sleep`. The
trigger is specifically an open WebSocket server persisting past the command.

**Do not** try to run `server.js` + `echo-bbs.js` as background processes and
probe them over WS from the harness. Instead:

- **Full-stack test = two `ModemDSP`s wired directly, no sockets.** Instantiate
  `ModemDSP('originate')` and `ModemDSP('answer')`, cross-wire `audioOut ->
  receiveAudio` (add jitter by slicing into random sub-chunks), simulate the BBS
  on the answer side (`connected` -> write banner; `data` -> line-buffer + echo),
  and assert byte-exact `data` on both ends. This covers the real Handshake +
  ModemDSP pump + protocol DSP — the only layers that ever change. See
  `dsptest2.js` for the template. The WS transport is lossless and already proven.
- **Protocol-unit test = two protocol classes** (e.g. `V29`) wired the same way,
  pumped in 160-sample blocks with a start offset. See `v29test.js`.
- A real browser<->`server.js` WS check must be run from a genuine shell
  **outside** the sandbox, then point `tools/jitter-repro.js` at it.

Keep both harness patterns; recreate if deleted. They use **absolute** require
paths (`/home/claude/synthlink/...`) — adjust per machine, or switch to relative
paths run from the repo root.

## Time budget
The harness has a wall-clock limit around a few tens of seconds. Slow protocols
need long windows (V.21 @ 300 bps: a ~140 B banner alone is ~4.7 s; full
banner+echo ~9 s). Budget per test and **early-exit on success** rather than
waiting out a fixed timeout. Don't batch all five protocols into one call —
split them, or the call times out.

## Building the browser bundle
`npm run build` (esbuild) needs the **native binary for this OS**. The repo's
`node_modules` may ship a win32 esbuild; on Linux that throws
"installed esbuild for another platform". Fix without touching `package.json`:

    npm install --no-save @esbuild/linux-x64@<esbuild version>   # 0.23.1 here
    node build.js

Output: `public/dsp-bundle.js`, IIFE global `SynthModemDSP = { ModemDSP, Buffer,
config }`, built from `src/browser-dsp-entry.js`. **Rebuild after any change under
`vendor/src/dsp/` or the browser gets stale DSP.** Confirm the change made it in,
e.g. `grep -c <new-symbol> public/dsp-bundle.js`.

## Browser-path safety check
Anything reachable from the browser must have **no Node-only refs**. Quick check
(shadows `process`): load the bundle with `process=undefined`, construct
`ModemDSP('originate')`, feed some silence, `stop()`. See HANDOFF §5.

## Debugging DSP: instrument the bit chain, not the audio
When bytes come out wrong, don't stare at samples. Isolate layers:
1. Pure scrambler+framing+descrambler+UART chain, no DSP — verifies bit logic.
2. TX-scrambled vs RX-recovered bits, aligned by best-offset, with **per-symbol-
   position (mod 4) error rate** — a period-4 error points at the amplitude bit
   `Q1`; broadband error means the receiver is decoding noise/silence.
Add temporary `this._dbg`-gated capture hooks, then remove them (verify with
`grep _dbg`). Symptoms→cause seen on V.29: repeating `0x77` flood = receiver
decoding trailing silence and/or idle carrier as data.

## Config is a shared singleton
`vendor/synthlink-config.js` (and the bundle's `config`) is mutated per-call
(`config.modem.native.protocolPreference = ['V29']`) just before DSP
construction. Fine for single-user local tools; set it in the same tick you
construct the DSP. Both ends in an in-process test share it — set once per test.

## Ground truth
`HANDOFF.md` is the authoritative pick-up doc (architecture, protocol status,
V.29 ping-pong internals, add-a-protocol checklist). Update it when status
changes; don't let claims drift from code (e.g. the "UART framing" claim was
aspirational for V.29 until it was actually implemented).
