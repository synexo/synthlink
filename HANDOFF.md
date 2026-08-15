# SynthLink — Handoff

Pick-up point for the next session. Assumes no memory of how we got here.

- **What / architecture / run:** README.md
- **How to work on it efficiently (AI):** CLAUDE.md ← read this first
- **Protocol implementation scope (real vs simplified, per protocol):** PROTOCOLS.md
- **Source & spec references:** PROVENANCE.md
- **Full history / superseded designs / UI internals:** DEVLOG.md

---

## Current status

**Working, wired end-to-end, verified this project:** V.21 (300), Bell 103 (300),
V.22 (1200), V.23 (1200/75), V.22bis (2400), **V.29 (9600, half-duplex ping-pong)**,
**V.32 (9600, full-duplex 16-QAM)**, **V.32bis (14400, full-duplex trellis-coded
128-QAM)**. Selectable per call. Speed ceiling is **14400**.

The bundle (`public/dsp-bundle.js`) is built and current. All protocols pass the
in-process full-stack test (`tools/dsptest2.js`) byte-exact both directions
(banner B→A, keystroke+echo A→B). V.21's 300-bps slowness makes it flake at the
harness time margin — pre-existing, not a regression (see CLAUDE.md time budget).

---

## Last two sessions (summary; detail in PROTOCOLS.md / DEVLOG.md)

### V.32bis · 14400 (most recent)
`protocols/V32bis.js`, built on the V.32 core. Genuine: 1800 Hz / 2400 baud /
6 bits-per-symbol trellis-coded 128-QAM; exact Table 1/V.32bis differential;
convolutional encoder emitting the redundant Y0; 128-point cross constellation;
role-asymmetric scramblers **bit-exact-verified against the §5.2.3 golden vector**;
Table 5 rate signal advertising the full rate set, selecting 14400 (`peerRate`
verified both sides). Scoped out (documented, not hidden): no Viterbi (Y0 sliced
away), self-consistent 128-point mapping vs byte-exact Figure 2-1, single rate
14400, no adaptive equalizer, echo-canceller segments omitted. → PROTOCOLS.md §6.

### V.32 · 9600 (prior)
`protocols/V32.js`. First **true full-duplex continuous carrier** protocol — the
4-wire-equivalent transport removes the echo canceller; the idle-`0xFF` flood is
avoided via synchronous scrambled MARK + async UART framing. Genuine uncoded
16-QAM, mod-4 differential, role-asymmetric GPC/GPA scramblers, audible training,
R1/R2/R3 rate exchange that round-trips. → PROTOCOLS.md §5.

---

## Forward — next steps (in rough priority order)

1. **Real browser smoke test.** The literal browser↔`server.js` WS path hasn't
   been re-run in-sandbox (WS-listener hang, see CLAUDE.md). In a real shell:
   open the app, pick **V.32bis · 14400** (and **V.32**), dial the echo BBS or a
   real one, confirm a clean banner + typing with no glyph garbage.
2. **V.32bis multi-rate + rate renegotiation (V.32bis spec §8).** The rate signal
   already advertises 4800/7200/9600/12000/14400; wire the fallback constellations
   (Figures 2-2..2-5) and the change-rate-without-retrain procedure. Small,
   well-scoped. → PROTOCOLS.md §6, §9.
3. **Real-modem interop path** for the new protocols (if ever backporting to
   synthmodem for real-line use): adaptive equalizer + timing tracking, echo
   canceller (V.32/bis), full standard handshake segments, Viterbi decoder for
   V.32bis. Full gap analysis in **PROTOCOLS.md §9**.
4. **Beyond:** V.34 (28800+) — a large effort.

## Watch-outs when picking up
- After ANY change under `vendor/` → `npm run build`, then run the browser-path
  safety check (CLAUDE.md). A stale or Node-tainted bundle looks like "server
  connects, browser doesn't".
- Don't run `server.js`'s WS listener from a test harness in the sandbox — it
  hangs. Use `tools/dsptest2.js`. (CLAUDE.md has the full testing playbook.)
- Adding a protocol touches four places: the class, `Handshake.js` (require +
  `PROTOCOLS` + `want<X>` bypass + `ready` branch), `server.js` `PROTOS`, and the
  `index.html` `<select>`. Miss the whitelist and it silently falls back to V.21.
  → PROTOCOLS.md §7.
