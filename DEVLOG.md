# SynthLink — Development Log

Historical record: session-by-session narrative, superseded designs, UI
implementation details, and the pre-implementation planning that shaped the
protocols. **Current** state lives in HANDOFF.md (latest sessions), PROTOCOLS.md
(implementation scope), and CLAUDE.md (how to work on it). This file is the
archive so nothing is lost — read it for *why* things are the way they are.

Most recent first.

---

## Session — V.34 · 28800 bps (full-duplex shell-mapped trellis-coded QAM)

Implemented `protocols/V34.js` + `protocols/V34Mapper.js` on top of the V.32/
V.32bis core. Full detail in PROTOCOLS.md §7. Highlights:

- **Fetched and parsed the full ITU-T V.34 (02/98) PDF** (the user supplied the ITU
  URL; the earlier `file:///C:/…` link was unreachable). Confirmed from the spec:
  scramblers GPC/GPA (§7) = the V.32 generators (reused, golden-verified); symbol
  rates (Table 1); carriers (Table 2); odd-integer channel grid (§9.6.3.1); framing
  J/P/N/b/SWP (Tables 7–8); K/M/L (Table 10); shell mapper (§9.4); differential
  (§9.5); mapper/precoder/trellis (§9.6); subset labels (Fig 9 / Table 13);
  Figure-10 16-state conv encoder.
- **Licensing:** with the ITU spec in hand, written **clean-room** — no code ported
  from linmodem (GPL-2.0), which would have forced a relicense. Repo stays LGPL-3.0.
  The user offered to switch to GPL; declined as unnecessary. (See PROVENANCE §4/§6.)
- **Method — each hard block verified standalone before integration:** the 16-state
  4D trellis FSM (`v34-trellis-check.js`: full reachability, balanced redundant
  bit), the shell mapper (`v34-shell-check.js`: encoder↔decoder round-trip exact
  across M=1..14 incl. the 28800 M=12 and 33600 M=11 cases), then the whole
  mapping-frame codec (`v34-map-check.js`: 20000 stateful frames, 0 bit errors).
  This staging meant the audio-path integration worked without a debug spiral.
- **Clean-link inversion (the elegant part):** no precoder ⇒ c(n)=0 ⇒ C0=0 ⇒
  U0=Y0; the receiver slices to the odd lattice and recovers Z=rot0,
  I1=(rot1−rot0)>>1 with U0 discarded — the trellis genuinely runs on TX and shapes
  the signal but needs **no Viterbi** on RX, exactly as V.32bis carries Y0.
- **Stages:** A (transport + genuine constellation, uncoded, 19200) → A′+B (full
  shell + differential + trellis + mapper wired into the audio path, byte-exact
  19200/2400) → C (config-driven coder; **28800/3200** working).
- **The 2.5-SPS scare that wasn't:** switching to 3200 baud first produced garbage.
  An isolation test (`v34-eye.js`, perfect-timing loopback) showed the eye **wide
  open** at 2.5 SPS (0 symbol errors) — proving the failure was residual ISI from a
  too-short matched-filter span at the low roll-off (span 16 left ~0.34 residual,
  right at the 0.5 slice edge), not acquisition or timing recovery. Fix: per-rate
  `FRONTEND` table, 3200 uses fc=1920 / roll-off 0.20 / **span 24**. No timing-
  recovery rewrite. (An earlier "needs a scope" call was too pessimistic; the eye
  test is the right in-sandbox instrument.)
- **Verified:** protocol-unit loopback byte-exact both directions @ 28800 (5/5
  runs), `peerRate=28800` both sides, TX RMS ≈ 0.10; full-stack (`dsptest2.js`)
  connect + banner + echo ~2.7 s; regression V.29/V.32/V.32bis all pass; both files
  browser-clean; bundle rebuilt (installed the Linux esbuild binary — repo ships
  win32 only, per CLAUDE.md) with V.34 included. All four wiring points done
  (Handshake require/PROTOCOLS/wantV34/ready-list; server PROTOS; index.html
  select; bundle). 19200/2400 also retained (one-line config switch).
- **Scoped out (documented, lossless-link-justified):** no precoder, no non-linear
  warping, no Viterbi, no line probing / INFO exchange, no adaptive equalizer /
  timing tracking, simplified startup, no superframe bit-inversion sync (V0=0), no
  auxiliary channel, single rate per call.
- **Not done / next session — 33600:** needs the **3429 symbol rate** (2.33 SPS,
  1959 Hz — new FRONTEND row + span tuning; 3200 tops out at 31200) **and frame
  switching** (§8.2, SWP≠all-high, low-frame zero-bit insertion) which the constant-
  `b` coder doesn't have. 31200/3200 is a nearer drop-in. Full roadmap in
  HANDOFF.md next-steps §2.

---

## Session — V.32bis · 14400 bps (full-duplex trellis-coded 128-QAM)

Implemented `protocols/V32bis.js` on top of the proven V.32 core. Full detail in
PROTOCOLS.md §6. Highlights:
- Fetched and parsed the full ITU-T V.32bis (1991) PDF. Extracted Table 1
  (differential), Figure 2-1 (128-QAM cross), §4 scramblers, §5.2.3 TRN golden
  vector, Table 5 rate signal.
- **Scrambler golden test:** scrambling ones with GPC from the zero state
  produced `11 11 11 11 11 11 11 11 11 00 00 01 11 11 11` and states
  `CCCCCCCCCAAACCC`, matching §5.2.3 exactly — bit-verifying the GPC scrambler
  (and by the role mirror, GPA) and the tap indices (17,22)/(4,22).
- Verified: protocol-unit loopback byte-exact both directions, `peerRate=14400`
  both sides, TX RMS ≈ 0.10; full-stack (`dsptest2.js`) connect + banner + echo
  ~2.8 s; regression V22/V23/V22bis/V29/V32 all pass; browser-clean; bundle
  rebuilt; bundle-smoke 3/3; V.32bis end-to-end through the shipped bundle.
- **V21 flake noted:** V.21 (300 bps) times out at the harness SECS margin in
  `dsptest2.js`/`bundle-smoke.js` (banner alone ≈ 6 s at 300 bps); reproduces
  running V21 alone → pre-existing, independent of V.32bis.
- Scoped out (documented, not hidden): no Viterbi (Y0 transmitted then sliced
  away), self-consistent 128-point mapping rather than byte-exact Figure 2-1,
  8-state FSM conv encoder rather than golden-verified Wei code, single rate
  14400, echo-canceller segments omitted.

---

## Session — V.32 · 9600 bps (full-duplex uncoded 16-QAM)

Implemented `protocols/V32.js`. Full detail in PROTOCOLS.md §5. This was the
first **true full-duplex continuous carrier** protocol — the 4-wire-equivalent
transport made the echo canceller (the hardest V.32 component) unnecessary, and
the idle-`0xFF` flood was avoided by the synchronous-scrambled-MARK + async-UART
approach. Verified genuine 16-QAM / mod-4 differential / role-asymmetric
scramblers + audible training + an R1/R2/R3 rate exchange that round-trips. TCM,
adaptive equalizer, and echo-canceller segments deliberately scoped out.

### Pre-implementation planning (V.32 was expected to be hard — kept for context)
Why V.32 looked like a big lift before we started:
- V.32/V.32bis/V.34 were removed from synthmodem's native tree; **spandsp does
  not implement V.32**, so there was **no reference C to port** (unlike V.22bis
  and V.29). The full handshake (AA/CA/AC/CC → TRN → R1/R2/R3) had to be written
  from scratch, and "failing at R1" was where a prior attempt reportedly died.
- V.32 carries the echo canceller for shared-carrier full-duplex.

Why it turned out more tractable here:
- The 4-wire-equivalent transport eliminates the echo canceller.
- Uncoded 16-QAM 9600 skips trellis/Viterbi.
- 2400-baud RX (3.33 SPS) is the same rate as V.29, so V.29's fractional-SPS RRC
  + matched filter dropped straight in.
- The recommended shortcut (used): run the handshake symmetrically per direction
  (as V.29 does), skip echo cancellation, verify the rate exchange still
  round-trips. It did.

`qam9600-proto.js` (64-QAM, integer SPS, NOT a real ITU protocol) was kept as a
feasibility scaffold but not shipped — V.29/V.32 were chosen for genuineness.

---

## Session — V.29 audible connect handshake + UI polish

### Audible handshake (Hayes "Express 96" flavour), in `protocols/V29.js`
Pure V.29 barely makes a sound on connect (it just starts training on carrier
detect), which read as "less authentic" next to the V.8/ANS protocols. Added a
connect **without disturbing acquisition** — see PROTOCOLS.md §4 for the current
mechanism. The design:
- `_buildConnectScript(role)` returns an ordered list of pre-roll bursts, each
  with a required preceding idle (`gap`):
  - answer: `tone` (gap 0) → `longtrain` (gap `CONNECT_GAP`) → `lock` (gap `CONNECT_GAP`)
  - originate: `longtrain` (gap `ORIG_LEAD`) → `lock` (gap `CONNECT_GAP`)
  - `ORIG_LEAD` (~0.6 s) holds the originator silent so the answerer's tone leads.
- Burst kinds: `tone` (pure 2100 Hz sine, `txMode==='tone'`), `longtrain`
  (unmodulated 1700 Hz then 0°/180° reversals — the "harsh static"; goes
  const→alt then alt→silence so it never yields the alt→const frame-sync
  boundary), `lock` (the SEG_A+SEG_B preamble the receiver actually syncs on).
- Why it can't break sync: tone/longtrain never sync; the `CONNECT_GAP` (~80 ms,
  > squelch hangup) silence after each makes the peer squelch hang up and
  `_resetRx()`, discarding the pre-roll before the fresh `lock`. This neutralised
  the "ANS tone trips acquisition" failure mode (a tone running straight into
  training with no separating silence).
- Verified byte-exact both directions; a Goertzel capture confirmed 2100 Hz leads
  ~1 s, then 1700 Hz-centred training, originator silent during the tone.

### Telnet SGA restored (`public/terminal.js`)
`TelnetFilter` previously refused every option (`DO`→`WONT`, `WILL`→`DONT`), which
dropped Suppress-Go-Ahead and left the link in line/half-duplex mode. synthdoor
did SGA on its *server* side; here the browser is a telnet *client* to a remote
BBS (the SynthLink server is a telnet-blind raw byte pipe — it just relays the
demodulated stream to `net.createConnection`), so the fix is client-side:
`TelnetFilter` now agrees to `DO/WILL SGA` and, via `negotiate()` (called on
carrier-up in `main.js`), proactively offers `WILL SGA` + `DO SGA`.
`_sgaLocal`/`_sgaRemote` flags make it reply only on a real state change so the
proactive offer and the peer's echoed confirmation can't loop. Every other option
is still refused; ECHO intentionally left refused. IAC parsing (incl. escaped
`0xFF` and SB blocks) unchanged. **`terminal.js` is therefore no longer a verbatim
synthdoor copy.**

### UI (`main.js` / `index.html`)
- **Oscilloscope** centred in the header (`#controls` shrink-wraps, `#scope-wrap`
  fills+centres); `fitTerminal` reserves ~3 px around the canvas.
- **Live bps readout:** `drawScope` prints a small bright-white `<N> bps`
  bottom-right while a carrier is up — measured throughput, not nominal line rate:
  `(rxBytes+txBytes)` sampled every 250 ms, ×8, lightly smoothed (`flowBps`).
  With V.29 ping-pong it spikes during bursts and falls toward 0 while idle.
- **Listen auto-fade:** a `listenUserSet` flag governs it. Until the user clicks
  Listen, each `connected` forces Listen on (full volume through the handshake)
  then `monitor.startAutoFade(10, …)` ramps the gain node 0.25→0 over 10 s and
  toggles Listen off; re-arms on every new connect. Any manual click sets
  `listenUserSet` (sticky across connects), cancels any in-flight fade, applies
  the user's toggle. `cleanup()` calls `cancelAutoFade()` so a hangup mid-fade
  can't fire the off-toggle later.
- **Web Audio graph:** `bufferSource(s) → analyser → gain → destination`. Analyser
  is BEFORE the gain, so the scope shows the real waveform even when muted. Frames
  from both directions (`feed('tx'|'rx', f32)`) are batched (~12 nodes/sec —
  per-frame node creation starved the DSP). Scope: `getFloatTimeDomainData`,
  ~5 ms window, auto-scaled green trace. Audio needs a user gesture; default is
  sound-on.

---

## Session — V.29 ping-pong reimplementation

V.29 was reimplemented as a **half-duplex ping-pong burst modem** (Hayes "Express
96" style), replacing an earlier continuous full-duplex design. Current mechanism
in PROTOCOLS.md §4. The story:

- **Why the change:** the previous V.29 ran a continuous full-duplex carrier with
  a free-running receiver and **no framing**, so an *idle* carrier descrambled
  into a flood of `0xFF` bytes (= telnet IAC) in both directions — "connects but
  shows garbage, never really connects" in the browser. Architectural, not a
  tuning bug: a continuous full-duplex V.29 carrier can't tell idle from data.
- **The fix:** consumer 9600-over-V.29 was half-duplex ping-pong (full-duplex 9600
  on 2-wire needed the echo cancellation that came with V.32). So V.29 now:
  carrier only during a burst; receiver re-acquires per burst; idle is silence;
  bytes carried with authentic async start/stop UART framing. (Later, V.32 solved
  full-duplex properly on our transport — see that session.)
- **Burst engine / turnaround / memory:** `MAX_BURST_BYTES=256`,
  `TURNAROUND_GUARD≈45 ms` (a real bug: without it back-to-back bursts merge and
  only the first decodes), `KEEPALIVE_GAP≈1.2 s`. Ping-pong made memory naturally
  flat (short bursts, RX buffer cleared per burst), so the earlier continuous
  design's offset-indexed trimming became unnecessary for V.29 (it returned for
  the full-duplex V.32/V.32bis).
- **Acquisition front-end** (proven in `v29-stream.js`, burst/squelch layer added
  this session): energy onset → fractional symbol-phase lock → alt→const frame
  sync → gain/phase seed → differential decode → descramble. Preamble = 32
  alternating (SEG_A) + 16 constant (SEG_B).
- **Handshake wiring:** `wantV29` bypass before the V.8 path; both roles →
  `_selectProtocol('V29')`; event-driven `ready` (== connected); no CD gate.
- Verified in-process (two `ModemDSP`s + jitter + mock BBS) byte-exact both
  directions; regression V.21/V.22/V.23/V.22bis all still passed.

---

## Browser-bundle Node-only-ref history (why the safety check exists)

Anything reachable in the DSP from the browser path must have **no** Node-only
refs (`process.*`, `fs`, `os`, `path`). Such a ref works in Node (= server) and
silently crashes the browser bundle (= originate) — which looks like "server
connects, browser doesn't". We hit this twice:
- `logger.js` used `process.stdout` → replaced with the universal
  `vendor/src/logger.js` shim.
- `V22.js` `_trackRxDetection` used `process.env.V32_DEBUG` → guarded behind a
  `V32_DEBUG` constant computed with `typeof process !== 'undefined'`.
- V.29/V.32/V.32bis were written clean and verified with the `process`-shadowed
  check (CLAUDE.md).

---

## Renderer gotcha (persistent)

`renderer.js`'s `drawFrame` early-returns until `await renderer.init()` builds the
glyph sheet (`_built`). Forget `init()` → the canvas is pure black. `main.js`
gates the render loop on `renderer.init().then(...)`. Also `renderer.js` imports
`./font.js` (repointed from the original `./font.min.js`).

---

## Sandbox note (test environment history)

The development sandbox **hangs / returns failure** whenever a long-lived `ws`
server stays alive in its process tree — `node server.js &`, `setsid`/`nohup`
detachment, **and** `require('./server.js')` in-process all trigger it. What works:
a plain `net`/HTTP listener that exits cleanly, `require('./server.js');
process.exit(0)`, backgrounding a plain `sleep`. Workaround (now the standard test
pattern): test the whole stack in one node process with **no listening server** —
two `ModemDSP`s wired directly (`tools/dsptest2.js`). For a real WS check, run
`server.js` / `echo-bbs.js` from a genuine shell **outside** the sandbox and point
`tools/jitter-repro.js` at them. See CLAUDE.md for the current testing playbook.

---

## Not re-confirmed across these sessions

The literal browser↔`server.js` path over a live WebSocket was not re-run in the
sandbox (the WS-listener hang above). The WS transport is lossless and already
proven for the FSK/V.22 protocols; the DSP + Handshake pump — the only layers that
change when adding a protocol — is verified in-process every session. A real
browser smoke test remains the recommended first step when picking up in a real
environment.
