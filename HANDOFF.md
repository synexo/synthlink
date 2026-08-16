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
128-QAM)**, **V.34 (28800, 3200-baud shell-mapped trellis-coded QAM)**. Selectable
per call. Speed ceiling is **28800**.

The bundle (`public/dsp-bundle.js`) is built and current (includes V.34). All
protocols pass the in-process full-stack test (`tools/dsptest2.js`) byte-exact both
directions (banner B→A, keystroke+echo A→B). **V.34 @ 28800 confirmed working in a
real browser this session** (browser↔`server.js` WS path). V.21 / Bell 103 (both
300 bps) flake at the *harness* time margin — **not a regression: Bell 103 is
confirmed working in-browser, just slow to start** (banner alone ≈ 6 s at 300 bps).

---

## Last two sessions (summary; detail in PROTOCOLS.md / DEVLOG.md)

### V.34 · 28800 (most recent)
`protocols/V34.js` + `protocols/V34Mapper.js`, built on the V.32/V.32bis core,
clean-room from ITU-T V.34 (02/98) — no GPL/linmodem code ported, repo stays
LGPL-3.0. Genuine: real V.34 3200-baud / 1920 Hz signal (also a 19200/2400 config);
the full encode chain **shell mapper (§9.4) + 4D differential (§9.5) + 16-state 4D
trellis on the wire (§9.6.3, Fig 10) + quarter-superconstellation ring/point mapper
(§9.6.1)**; GPC/GPA scramblers (shared, golden-verified); async UART framing;
in-band rate exchange (peerRate 28800 both sides). Config-driven (`makeConfig`/
`CONFIGS`) so 31200/3200 and 33600/3429 are further entries. Scoped out (documented,
lossless-link-justified): no precoder (c(n)=0 ⇒ C0=0 ⇒ U0=Y0), no non-linear
warping, no Viterbi (slice + algebraic invert; U0 discarded), no line probing /
INFO exchange, no adaptive equalizer, simplified startup. Each block verified
standalone (`tools/v34-{trellis,shell,map,eye}-check.js`) before integration; the
2.5-SPS jump needed only a wider matched-filter span (24) at the low roll-off, not
a timing-recovery rewrite — the eye test proved the eye open. Byte-exact both
directions in protocol-unit and full-stack tests. → PROTOCOLS.md §7.

### V.32bis · 14400 (prior)
`protocols/V32bis.js`, built on the V.32 core. Genuine: 1800 Hz / 2400 baud /
6 bits-per-symbol trellis-coded 128-QAM; exact Table 1/V.32bis differential;
convolutional encoder emitting the redundant Y0; 128-point cross constellation;
role-asymmetric scramblers **bit-exact-verified against the §5.2.3 golden vector**;
Table 5 rate signal advertising the full rate set, selecting 14400 (`peerRate`
verified both sides). Scoped out (documented, not hidden): no Viterbi (Y0 sliced
away), self-consistent 128-point mapping vs byte-exact Figure 2-1, single rate
14400, no adaptive equalizer, echo-canceller segments omitted. → PROTOCOLS.md §6.

---

## Forward — next steps (in rough priority order)

1. **Real browser smoke test (V.34 done; others pending).** **V.34 @ 28800 was
   confirmed in a real browser this session** (clean banner + echo over the
   browser↔`server.js` WS path), and Bell 103 too (slow-start only). The literal
   WS path still hasn't been re-run in-sandbox for the *other* self-training
   protocols (WS-listener hang, see CLAUDE.md) — worth a pass on **V.32bis · 14400**
   and **V.32** in a real shell when convenient. V.34's shaped constellation is
   worth eyeballing on a scope.
2. **V.34 higher rates → 33600 (next session's target).** Current tested ceiling
   is **28800/3200**; only `28800/3200` and `19200/2400` are verified. Adding rates
   is **not** a uniform config flip:
   - **31200/3200 — near drop-in, do this first.** Same 3200 front-end (already
     working), all-high switching pattern (SWP=FFFF, constant `b`). Just add a
     `CONFIGS` entry (K=26, M=10, q=5 per Table 10; 1280-pt constellation) and
     re-check the slicing margin at the larger constellation (may want a touch more
     matched-filter span). Verify with `v34-map-check.js` then the audio loopback.
   - **33600 needs TWO new pieces, not just a config:**
     a) **3429 symbol rate (2.33 SPS, 1959 Hz carrier).** 33600 exists *only* at
        3429 baud (b=79) per Tables 8/10 — 3200 tops out at 31200. Add a `FRONTEND`
        row for 3429: check the band fit (1959 ± 0.5·3429·(1+β) inside (0,4000) —
        β is tight, ~≤0.16) and tune the matched-filter span the way 3200 needed.
        Use `tools/v34-eye.js` first (perfect-timing loopback) to confirm the eye is
        open at 2.33 SPS before wrestling with acquisition — that isolation test is
        what made 3200 quick.
     b) **Frame switching (§8.2) — genuinely missing code.** 33600/3429 has
        SWP=14A5, so mapping frames alternate `b−1`/`b` bits on a periodic pattern,
        with a zero bit inserted after the first K−1 shell bits in low frames
        (§9.3.1). The shipped coder assumes constant `b` (both current configs are
        all-high, chosen for exactly that reason). Add: the SWP generator (the
        counter algorithm in §8.2), and low/high-frame handling in
        `V34Coder.encodeFrame`/`decodeFrame` + the parser bit-splitting. Both ends
        must agree on frame parity across the burst (reset at burst start; the frame
        index rides the same continuous stream as the differential/trellis state).
   - Note J: 3429 uses J=8 (not 7) and P=15 — matters only if superframe structure
     is ever added (currently V0=0, no superframe sync; likely fine to keep).
   The encoder core (shell mapper, 4D differential, 16-state trellis, mapper) is
   rate-independent and already generalizes; `v34-shell-check.js` covers M=11 (a
   33600 ingredient). → PROTOCOLS.md §7.
3. **V.32bis multi-rate + rate renegotiation (V.32bis spec §8).** The rate signal
   already advertises 4800/7200/9600/12000/14400; wire the fallback constellations
   (Figures 2-2..2-5) and the change-rate-without-retrain procedure. Small,
   well-scoped. → PROTOCOLS.md §6.
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
