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
128-QAM)**, **V.34 (28800 / 31200 / 33600, shell-mapped trellis-coded QAM)**.
Selectable per call. Speed ceiling is **33600**.

V.34 now runs at four rates, each verified byte-exact end-to-end (map-check +
protocol-unit loopback + full-stack `dsptest2` + through the shipped bundle):
**19200/2400, 28800/3200, 31200/3200** (constant `b`), and **33600/3429** (the top
rate, using §8.2 frame switching on a genuine 3429-baud / 1959 Hz front-end). The
rate is chosen per call via `config.modem.native.v34Rate` (UI dropdown → dial
message → server), defaulting to the max (33600). The bundle
(`public/dsp-bundle.js`) is built and current.

All protocols pass the in-process full-stack test (`tools/dsptest2.js`) byte-exact
both directions (banner B→A, keystroke+echo A→B). V.21 / Bell 103 (both 300 bps)
flake at the *harness* time margin — not a regression, just slow (banner alone
≈ 6 s at 300 bps).

---

## Last sessions (summary; detail in PROTOCOLS.md / DEVLOG.md)

### UI + on-screen keyboard (most recent)
UI improvements last session, including keyboard support. See DEVLOG.md if details are needed.

### V.34 · 31200 + 33600
Raised the V.34 ceiling from 28800 to **33600**, adding two rates on the existing
clean-room coder. **31200/3200** is a real V.34 rate and a near drop-in: same 3200
front-end, constant `b` (all-high SWP), new `CONFIGS` entry (b=78, K=26, M=10, q=5,
1280-pt constellation). **33600/3429** needed the two genuinely-missing pieces:
(a) a new **3429-baud front-end** (2.33 SPS, 1959 Hz carrier, β=0.14, span 32) —
eye proven open first (`v34-eye.js`, tighter slice error than 3200; carrier 1800
fails, folding the lower sideband through DC); and (b) genuine **§8.2 frame
switching** — SWP=0x14A5 selects per-frame `b`(79)/`b−1`(78), a low frame inserting
a forced-0 high-order shell bit (§9.3.1) so the shell mapper still sees K bits.
Both ends drive the SWP pattern off a frame counter reset at data-burst start;
acquisition lands on TX frame 0, so parity stays in lockstep on the drift-free
clock. One real fix beyond the plan: the sharp 3429 eye needs a finer acquisition
timing grid (**SPS/64**, was SPS/16 → ~99 % symbol errors) — a one-time cost that
leaves 2400/3200 unaffected. The V34.js front-end was refactored so rate is
resolved per call from `config.modem.native.v34Rate` (amplitude params are now
per-constellation, not per-symbol-rate, since 28800 and 31200 share 3200 baud).
Verified byte-exact both ways at all three rates in `v34-map-check`, `v34test`,
`dsptest2`, and through the shipped bundle; other protocols regression-clean.
Honesty: 31200 is fully spec-correct; 33600's front-end and switching *mechanism*
and its b/K/M/q/SWP values are genuine, but the exact SWP bit-indexing (and the
J=8/P=15 superframe accounting) is a self-consistent construction — correct for
data integrity here, unverified against real-HW framing. → PROTOCOLS.md §7.

### V.34 · 28800 (prior)
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
2. **V.34 higher rates → 33600 — DONE this session.** Ceiling is now **33600**;
   19200/28800/31200/33600 all verified end-to-end and selectable per call. See the
   session summary above and PROTOCOLS.md §7. Remaining V.34 polish, if wanted:
   - **Scope the shaped constellation / spectrum on a real scope** in-browser at
     33600 (the 3429 band is razor-thin — lower edge ≈ 4 Hz — so it's worth an
     eyeball even though the loopback and bundle tests are byte-exact).
   - **If real-HW interop is ever a goal:** verify the exact SWP bit-indexing and
     the J=8/P=15 superframe frame-accounting against V.34 Tables 7–8/10 (the
     mechanism is genuine; only the precise frame↔SWP-bit mapping is a
     self-consistent choice here), and add the superframe bit-inversion sync.
3. **V.32bis multi-rate + rate renegotiation (V.32bis spec §8).** The rate signal
   already advertises 4800/7200/9600/12000/14400; wire the fallback constellations
   (Figures 2-2..2-5) and the change-rate-without-retrain procedure. Small,
   well-scoped. → PROTOCOLS.md §6.
4. **Real-modem interop path** for the new protocols (if ever backporting to
   synthmodem for real-line use): adaptive equalizer + timing tracking, echo
   canceller (V.32/bis), full standard handshake segments, Viterbi decoder for
   V.32bis, and for V.34 the precoder + line-probing + exact framing (§8.2 Tables
   7–8/10) and superframe sync. Full gap analysis in **PROTOCOLS.md §9/§10**.

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
