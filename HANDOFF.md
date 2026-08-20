# SynthLink — Handoff

Pick-up point for the next session. Assumes no memory of how we got here.

- **What / architecture / run:** README.md
- **How to work on it efficiently (AI):** CLAUDE.md ← read this first
- **Protocol implementation scope (real vs simplified, per protocol):** PROTOCOLS.md
- **Scoped protocol authenticity backlog:** PROTOIMPROVE.md
- **Source & spec references:** PROVENANCE.md
- **Full history / superseded designs / UI internals:** DEVLOG.md

---

## Current status

**Working, wired end-to-end, verified:** V.21 (300), Bell 103 (300), V.22 (1200),
V.23 (1200/75), V.22bis (2400), V.29 (9600), V.32 (9600), V.32bis (14400),
V.34 (19200/28800/31200/33600), and **V.90 (56000 down / 33600 up)**. Selectable
per call. Speed ceiling is **56000**.

**V.90** is asymmetric and genuinely so: the server is the digital modem sending
PCM codewords downstream, the browser is the analogue modem sending V.34 upstream.
Its Phase 1 (V.8) and Phase 4 (CP/MP) are both real, the full Table 2 rate ladder
(28000–56000) is implemented, and the spectral shaper works. → PROTOCOLS.md §8.

**V.8 now runs for everything except V.29** — V.32/V.32bis/V.34/V.90 were moved
onto it. → PROTOCOLS.md §9.

**V.34's §8.2 SWP indexing was corrected** to the spec's P-wide MSB-first form, and
the configs now self-validate against §8.2. → PROTOCOLS.md §7.

All protocols pass the in-process full-stack test (`tools/dsptest2.js`) byte-exact
both directions. **Bell 103 fails the harness** (banner arrives, echo does not) —
verified identical on pristine HEAD, so pre-existing, not a regression; it is the
known 300 bps time-margin issue.

---

## Last sessions (summary; detail in PROTOCOLS.md / DEVLOG.md)

### V.90, real V.8, V.34 §8.2 correction (most recent)
Added **V.90** (56000 downstream PCM codewords + 33600 upstream V.34, the existing
V.34 composed unmodified). Moved **V.32/V.32bis/V.34/V.90 onto genuine V.8** — the
vendored sequencer already carried every mode bit needed, including `modn0` b5
("PCM avail") which is how V.90 signals capability; only the mappings were missing.
Corrected **V.34's §8.2 SWP indexing** (P-wide MSB-first, not 16-bit LSB-first)
after transcribing Tables 7/8, and made the configs self-validate against §8.2.
V.90's CP/MP use the real Table 14/16 bit layouts. Two bugs fixed: an Sd
acquisition phase ambiguity (the pattern is antisymmetric under a 3-symbol shift)
and a quadratic acquisition hunt. `vendor/` changed → rebuilt.
→ PROTOCOLS.md §7/§8/§9, DEVLOG.md, PROTOIMPROVE.md.

### Telnet server-side + modem bypass
Telnet now terminates on the server (`lib/telnet.js`), answering TTYPE and NAWS —
this fixed the "some BBSes misbehave" symptom — and a new **Telnet · modem
bypass** speed skips the DSP entirely, turning the scope box into a network
throughput graph. The BBS is dialled on carrier, so its timers don't run during
the handshake. No `vendor/` change, so no rebuild.
→ DEVLOG.md.

### UI: favorites, stored settings, about panel
Non-protocol session, `public/` only (no `vendor/` change, so no rebuild): first
terminal touch opens the on-screen keyboard instead of zooming, a third "off"
setting on the zoom button, PRC19 hidden from the font cycle, one-shot CAPS and
SYMBOL keyboard views, an ⓘ about panel fed from `public/about.html`, a Random
BBS Selection entry, per-browser stored settings, and a favorites tier with a
heart toggle in the BBS label slot. → DEVLOG.md.

### Fonts, mobile zoom, BBS directory
Non-protocol session: selectable terminal fonts (added AST PremiumExec 8×19 and
DOS/V re PRC19 8×19, the taller cell used for mobile legibility), a one-finger
zoom for mobile, a compacted control bar, and a two-tier BBS directory (curated
file + Telnet BBS Guide monthly list). The guide's automatic daily pull is
**not yet working** — the site answers with a JS anti-bot interstitial; the
manual paths work. Details, tunables and the how-to-extend notes: DEVLOG.md.

### UI + on-screen keyboard
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
Honesty: 31200 is fully spec-correct; 33600's front-end, switching mechanism and
b/K/M/q/SWP values are genuine. **The SWP bit-indexing and superframe accounting
were a self-consistent construction and have since been corrected to the spec**
(see the most recent session). → PROTOCOLS.md §7.

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

1. **Real browser smoke test.** V.34 @ 28800 and Bell 103 were confirmed in a real
   browser in an earlier session. **V.90, V.32bis and V.32 have not been** — all
   pass in-sandbox and through the shipped bundle, but the literal browser↔`server.js`
   WS path needs a pass in a real shell (WS-listener hang, see CLAUDE.md). V.90 is
   the interesting one: its downstream is full-amplitude PCM rather than a
   modulated carrier, so it should look and sound quite different on the scope.
2. **Protocol authenticity backlog → PROTOIMPROVE.md.** Scoped and ordered by
   effort. Cheapest first: the V.90 CRC convention (item 1), then V.34's real
   MP/MP′ (item 2, best value — `V90Phase4.js` is the template). PROTOIMPROVE §0
   documents the spec-retrieval technique that unblocked this session and applies
   to every remaining caveat in the repo.
3. **V.32bis multi-rate + rate renegotiation** (§8). The rate signal already
   advertises the full set. → PROTOIMPROVE.md item 3.
4. **Real-modem interop path** for the new protocols. Full gap analysis in
   **PROTOCOLS.md §10/§11**.

## Watch-outs when picking up
- After ANY change under `vendor/` → `npm run build`, then run the browser-path
  safety check (CLAUDE.md). A stale or Node-tainted bundle looks like "server
  connects, browser doesn't".
- Don't run `server.js`'s WS listener from a test harness in the sandbox — it
  hangs. Use `tools/dsptest2.js`. (CLAUDE.md has the full testing playbook.)
- Adding a protocol touches: the class, `Handshake.js` (require + `PROTOCOLS` +
  V.8 wiring *or* a `want<X>` bypass + `ready` branch), `server.js` `PROTOS`, and
  the `index.html` `<select>`. Miss the whitelist and it silently falls back to
  V.21. **Prefer real V.8 over a bypass** — it is now proven for both self-training
  and PCM protocols. → PROTOCOLS.md §9.
- A protocol that emits its own answer tone must implement `setV8Complete()` to
  suppress it on the V.8 path, or the second tone trips the peer's acquisition.
- **Don't trust a summarised spec table.** Asked normally, the retrieval
  *reconstructs* tables and returns confident wrong values. → PROTOIMPROVE.md §0.
