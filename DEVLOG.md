# SynthLink — Development Log

Historical record: session-by-session narrative, superseded designs, UI
implementation details, and the pre-implementation planning that shaped the
protocols. **Current** state lives in HANDOFF.md (latest sessions), PROTOCOLS.md
(implementation scope), and CLAUDE.md (how to work on it). This file is the
archive so nothing is lost — read it for *why* things are the way they are.

Most recent first.

---

## Session — Favorites, stored settings, about panel

No protocol or DSP work: `vendor/` untouched, nothing here needs `npm run build`.
Only the non-obvious bits are recorded; the rest is plain code in `public/`.

**PRC19 is hidden, not removed.** `public/fonts/dosv-prc19-8x19.js` and its
`FONTS` entry are intact — the entry just carries `hidden: true`, which keeps it
out of the new `CYCLE_FONTS` export (`FONTS` minus hidden) that the Aa button
cycles. Drop the flag to bring it back; nothing else needs touching, and
`fontById()` still resolves it by id, so a stored preference naming it works.

**Stored settings** live in one JSON blob under `synthlink.prefs.v1` in
localStorage, via the small `prefs` object at the top of `main.js`. To persist a
new control: read `prefs.get(key, fallback)` where its initial value is computed,
and `prefs.set(key, v)` in its handler. Two traps. `prefs.get()` returning
`undefined` is meaningful — it's how "the user has never touched this" stays
distinguishable from a stored value, which is what lets a stored font or
scrollback setting override the automatic mobile default while an untouched one
doesn't. And the whole thing is deliberately failure-tolerant: unavailable
storage (private mode) or a corrupt blob falls back to defaults silently, since a
preference is never worth breaking startup over. Bump the key's version suffix if
the schema ever changes incompatibly.

**Favorites store whole records** (`{name, host, port}`), not references into the
directory, because the Telnet BBS Guide tier is re-scraped monthly — a favorite
pointing at a guide entry would rot when that entry moved or vanished. Same
reason a hand-typed destination can be favorited: it stores an empty name and
renders as a bare `host:port`. A favorite that also appears in Featured or the
Guide is shown in both places by design.

**The BBS dropdown is rebuilt, not patched.** `renderBBS()` regenerates every
optgroup from `bbsDir` (the cached fetch) plus `prefs.favorites`, so toggling a
favorite just calls it again. It holds the current destination across the rebuild
by value, and — the non-obvious part — if nothing matches, it adopts whatever
option the `<select>` is displaying. Without that, a fresh profile shows one BBS
in the dropdown while `#host`/`#port` hold the page defaults, and the heart
favorites a board the user never picked. The `change` listener is attached once,
outside the render, since replacing the options doesn't disturb a listener on the
`<select>` itself.

**Random** is an option whose value is the sentinel `@random` (`@` can't occur in
a host:port). The change handler draws from `bbsDir.pool`, then snaps the select
to the drawn entry — so the selection always names a real destination, and
picking Random again is a genuine value change that re-rolls with no extra
plumbing.

**The favorite heart shares the BBS label slot**, swapping in on carrier and out
on hangup (`showFavButton()`, called from the `connected` handler and
`cleanup()`). It is CSS min-width matched to the "BBS" text so the row doesn't
shift. The pencil is untouched — manual host:port entry stays where it was.

**`public/about.html` is a fragment, not a page**: fetched once and injected into
`#aboutbody`, which supplies all the styling. Edit it freely, no rebuild. It is
sized to fit a 390×844 phone without scrolling, so more than a line or two of
extra text will start it scrolling internally.

**One-shot keyboard views:** `ONE_SHOT_VIEWS = [1, 2]` in the keyboard IIFE makes
CAPS and SYMBOLS revert to lowercase after any keypress, shift-key style. The
numpad (3) is absent from that list on purpose.

---

## Session — Terminal fonts, mobile zoom, two-tier BBS directory

No protocol or DSP work: `vendor/` was untouched, so nothing here needs
`npm run build`. Three things a future session needs to know how to change.

### Adding a terminal font

Fonts live in `public/fonts/`: one module per font plus `index.js`, which is the
registry and the glyph-sheet builder. To add one:

1. Drop a module beside the others exporting `CELL_W`, `CELL_H`, and a
   `Uint8Array` of `256 * CELL_H` bytes — one byte per pixel row, MSB = leftmost
   pixel, CP437 order. This is the same encoding every font here uses.
2. Add one `FONTS` entry: `{ id, name, cellW, cellH, glyphs }`, plus
   `mobileDefault: true` if it should be auto-selected on narrow screens.

Nothing else changes. `Renderer` takes its cell metrics from the active font
(`this.cellW/cellH`, not module constants — that refactor is why they are no
longer `CHAR_W`/`CHAR_H` everywhere), `main.js` derives the canvas size and the
fit aspect from it, and the Aa button cycles the table. `Renderer.setFont()`
resizes the backing canvas, rebuilds the glyph sheet and drops **both** caches —
the tinted colour-pair sheets are sized to the old cell, so a stale one blits at
the wrong height. Switching between two fonts of the *same* height is the case
that hides a missed cache invalidation, since the canvas dimensions do not
change; pixel-hash the canvas to test it.

Converting a `.FON`: it is an NE executable holding an FNT resource. Read
`dfPixWidth`/`dfPixHeight` at 0x56/0x58 and the per-glyph offsets from the char
table at 0x76 (v2.0 format, 4 bytes/entry) — **do not** assume dimensions from
the filename. The glyph bitmaps then extract verbatim; no rasterising. Any font
from VileR's Ultimate Oldschool PC Font Pack is CC BY-SA 4.0, which is share-alike
and must carry its attribution in its own file header as well as PROVENANCE.md.

Two things measurement settles that eyeballing does not:

- **A taller cell does not imply bigger letters.** Compare cap height (ink rows
  in `A`) and x-height (ink rows in `x`) against the 8x16 baseline of 10 and 7.
  `DOS-V TWN19` is 8x19 but measures 10 and 7 — every extra row is leading, so it
  costs 18.75% of canvas height and buys nothing. It was rejected for exactly that.
- **Odd cell heights break shade tiling.** `0xB0`/`0xB1` are 2-phase
  checkerboards; at 19 rows the phase repeats across the cell boundary, putting
  two identical pixel rows adjacent every 19px, which reads as faint banding in
  large fills. Intrinsic to any odd height, not a defect in a particular font.
  Also check `0xB2` — `PRC19` draws it as a diagonal rather than the classic
  checkerboard, so ANSI art shades differently.

### Mobile one-finger zoom — where the feel lives

All of it is the "One-finger zoom (touch)" section of `main.js`. It is a
**display-only** CSS transform on the canvas: the renderer keeps drawing the same
backing store, so there is no repaint, no cache churn, panning is composited on
the GPU, and it is automatically correct for whatever font is active.

Tunables, all independent:

| constant | what it does |
|---|---|
| `ZOOM_LEVELS` | magnifications the `2×` button cycles |
| `PAN_SWEEP_X/Y` | finger travel, as a fraction of the terminal, to pan from the middle to an edge. **Lower = more sensitive.** `1/6` matches the original fixed gain of 1.5 at 2x |
| `PAN_SLOP` | px of travel before panning engages — kills touchdown wobble |
| `PAN_SMOOTH_MS` | transform transition once panning; low-passes tracking jitter. 0 disables |
| `HOLD_MS` / `HOLD_SLOP` | press-and-hold to zoom when the scrollback swipe owns the drag |

Three non-obvious points:

- Sensitivity is expressed as a **sweep**, not a gain, and the gain is derived
  from the real viewport geometry rather than assuming the viewport shows `1/Z`
  of the canvas. That assumption is true on the axis where the terminal fills the
  viewport and false on the letterboxed one, which made the two axes sweep
  differently. Deriving it also makes a magnification change need the *same*
  sweep instead of more.
- Mapping is **relative from the middle**: any press opens on the centre of the
  terminal, so the press point is the user's choice of where to stand. An earlier
  absolute mapping tied press position to content position, which meant corners
  could only be reached with the finger sitting on the text it was uncovering.
- `touch-action: none` on `#terminal-canvas` must be declared **in CSS**. Setting
  it once a touch has begun is too late — the browser has already claimed the
  gesture. This is what stops the page scrolling under a pan in the layouts that
  scroll (`kbd-open`, short viewports), not just in fullscreen.

Gesture ownership is decided by the scrollback toggle, because a pan and a
scroll-swipe are the same motion: scrollback off (the mobile default) means touch
zooms instantly; scrollback on means a drag scrolls history and zoom needs a hold.

### BBS directory — two tiers, and why the auto-pull does not work yet

`lib/bbslist.js` owns it; `server.js` only schedules it and serves the result.

- **Tier 1** `config/curated.txt` — `Name, host:port` per line, `#` comments,
  port defaults to 23, file order is display order. Committed, re-read on mtime
  change so it stays live-editable.
- **Tier 2** the Telnet BBS Guide monthly list, cached under `cache/`
  (gitignored), sorted alphabetically, with curated entries removed from it.

Flow: a daily conditional `GET` of the download page (normally `304`, a few
hundred bytes) → scrape the monthly link → **only if the filename changed**,
download the zip → pull `bbslist.csv` out of it with the minimal reader in
`unzipEntry()` (central-directory based; local headers can carry zeroed sizes) →
parse → atomic-swap `cache/guide.json`. That is ~29 tiny requests and one real
download a month. Client requests never trigger a fetch; `/bbs.json` is
serialised and gzipped once into memory (66KB → 17KB) with an ETag.

CSV specifics that matter: the published header has **leading spaces**
(`" bbsPort"`), so match columns by trimmed name, never by position; about a
third of rows have **no port**, so the default-to-23 rule carries real weight;
and the guide tier is deliberately **not** de-duplicated by `host:port` — ten
pairs in the 08/26 edition share an address but are distinct listings
("Amis XE"/"Baudville"), so collapsing them silently drops real boards.

**The automatic pull does not currently work.** The site intermittently answers
with a JavaScript anti-bot interstitial ("Please wait while your request is being
verified...") instead of the page. It runs headless-detection checks in obfuscated
JS, submits a computed `wsidchk` token to a one-off endpoint, and reloads after
5s. A plain HTTPS `GET` cannot pass it: it needs JS execution, and the updater
keeps no cookie jar, so even a passed challenge would not persist. When discovery
fails the response body is written to `cache/last-page.html` and the error names
the likely cause, so this is diagnosable from the logs.

Until that is addressed, the manual paths are the supported ones and both work:

```
npm run update-bbslist -- --file /path/to/ibbs0826.zip
```

or drop the monthly zip into `cache/` — it is ingested on the next start or check,
no network involved. Whatever the eventual fix, note that the updater sends an
honest identifying `User-Agent` on purpose; spoofing a browser to defeat an
operator's bot protection is not the direction to take. Asking the operator for a
stable URL is the better first move.

---

## Session — UI improvements + on-screen keyboard

Mostly presentation work (header layout, oscilloscope sizing, scrollback controls)
plus a new data-driven on-screen keyboard for mobile. No DSP changes. The parts
worth remembering are below; the rest is self-evident in `public/index.html` +
`public/main.js`.

### Non-obvious UI decisions (the ones we learned the hard way)

- **Oscilloscope sizing is viewport-width-driven, deliberately.** `#scope` is
  `width:clamp(200px,20vw,320px); aspect-ratio:3/1` — its size depends only on the
  viewport, *never* on the control-column height. An earlier attempt tied the scope
  to the bar/controls height (`height:100%` / stretch, or measuring controls height
  in JS) so it would "fill" vertically. That creates a feedback loop: the canvas
  backing-store size feeds back into the flex line height, so the box **ratchets
  taller on resize and never shrinks back**. Don't reintroduce that coupling.
- **The status bar does not wrap and is top-justified** (`align-items:flex-start`).
  Controls grow to fill the left; `#scope-wrap` reserves real width so the scope
  can't be starved to zero. The bar only switches to a vertical stack (and the
  scope flattens full-width) at the **`max-width:640px`** breakpoint.
- **"Mobile mode" = `matchMedia('(max-width:640px)')`** everywhere — it's the same
  signal that flattens the scope, and it also drives zero terminal margin
  (`fitTerminal` uses `M=0`) and the keyboard's page-scroll behaviour. Keep using
  this one signal rather than sniffing the user agent.
- **Keyboard-open on mobile** sets `body.kbd-open`, which switches the body to
  document scroll so the terminal keeps its full size and the page scrolls to reveal
  the keyboard (instead of squashing the terminal).
- **Reverted experiment — don't redo it naively.** We tried a proper "app shell"
  (`#shell` at `100dvh`, internal `overflow-y:auto`, `overscroll-behavior:contain`,
  `viewport-fit=cover`, plus a ⛶ fullscreen button) to stop the mobile address bar
  popping in/out during scroll. It **broke sizing** — most visibly it severely shrank
  the terminal in mobile landscape, plus other desktop quirks — and was reverted
  (backup was taken in `public/_backup_viewport/`). If the address-bar issue is
  revisited, do it behind careful per-orientation testing, not as a blanket shell.
- **Scrollback already existed** in the render stack (`terminal.js`, inherited from
  synthdoor: `scrollbackUp/Down/Home/End`, `getDisplayCells`, `isLive`). This session
  only added the *input* wiring (wheel / swipe / Page keys), the position indicator,
  and a **📜 enable/disable toggle** (default on for desktop, off for mobile, so an
  accidental swipe can't scroll) with a fading **toast** that doubles as the
  touch-device tooltip (native `title` only shows on desktop hover).

### On-screen keyboard — how it works and how to change it

This is the part most likely to be revisited (and is a strong candidate to backport
into synthdoor). It lives entirely in the `buildKeyboard()` IIFE in `public/main.js`,
is **fully data-driven**, and renders into `#keyboard`. The `⌨` button (`#kbdtoggle`)
shows/hides it; one `⇧#` key cycles the views.

**Key def format** — every key is a plain object:

```
{ t: 'a',  s: 'a' }                       // label 't', bytes-to-send 's'
{ t: 'F1', s: '\x1BOP', c: 'fn' }         // 'c' = extra CSS class (fn/mod/acc)
{ t: 'space', s: ' ', c: 'acc', w: 6 }    // 'w' = flex-grow (wider key)
{ blank: true }                           // explicit empty slot (reserved space)
{ t: '⇧#', c: 'mod', cycle: true }        // advances to the next view
```

Helpers build these: `chr(ch, cls)` (a key that sends itself), `chars('qwe…')`
(array of `chr` per character), `fn(n, seq)` (blue function key), `nav(t, seq)`
(amber nav key). Named constants exist for the common ones: `SP ENT BK` (space,
enter=`\r`, backspace=`\x7F`), `UP DN LF RT` (arrows), `ESC TAB`, `CYCLE`,
`INS DEL HOME END PGUP PGDN`, and `F[1]…F[12]`.

**Views** — the `views` array holds four entries, cycled 0→1→2→3→0 by `CYCLE`:

1. letters (lowercase) + digits — `{ kind:'rows', rows:[…] }`
2. UPPERCASE + F1–F10
3. symbols (+ F11/F12)
4. numeric keypad + navigation — `{ kind:'pads', num:[…], nav:[…], foot:[…] }`

`kind:'rows'` renders each row as a flex row (`.krow`); every key is `flex:1` unless
it has a `w`. `kind:'pads'` renders two CSS grids side by side — `num` (4 columns)
and `nav` (3 columns) — plus a `foot` flex row.

**CSS classes / colours:** `acc` = green (space/enter), `mod` = amber (modifiers,
nav, backspace, cycle), `fn` = blue (function keys), `blank` = invisible.

**To add or change a key:** edit the relevant view's array — that's the whole job.
- Replace a `{blank:true}` with a real key def to fill a reserved slot (view 3 keeps
  three blanks between `?` and `F11/F12` for exactly this).
- Add a key to a row; keep row lengths consistent so the split arrow cluster stays
  aligned across views (the arrows are: `↑` immediately right of `m`/`M`, `Enter`
  right of `↑`, and `← ↓ →` on the bottom row right of the space bar; `⌫` left of
  `z`; `⇧#` left of space; `Esc`/`Tab` only appear on view 4, above `←`/`→`).
- To add a whole new view, append another entry to `views` — the cycle length is
  `views.length`, so `⇧#` picks it up automatically.

**How keys send:** `keyEl()` attaches a `pointerdown` handler (not `click`, so it
fires without stealing focus and doesn't double-fire on touch) that calls
`modemWrite(k.s)` — the same path the physical keyboard uses, so it only sends when
a carrier is up. Control keys use standard xterm/VT sequences: F1–F4 = `ESC O
P/Q/R/S`, F5–F12 = `ESC [ 15~/17~/18~/19~/20~/21~/23~/24~`, Home/End/Ins/Del/PgUp/
PgDn = `ESC [ 1~/4~/2~/3~/5~/6~`, arrows = `ESC [ A/B/C/D`, Esc = `\x1B`, Tab = `\t`.

**Important distinction:** the PgUp/PgDn/arrow keys on view 4 send those sequences to
the *BBS*. Local scrollback (reviewing history) is a separate client feature driven
by the wheel/swipe/Page-key handlers and gated by the 📜 toggle — it never calls
`modemWrite`. Keep the two straight.

**Width safety:** `syncKeyboardWidth()` (called from `fitTerminal`) caps the
keyboard's `max-width` to the terminal canvas width so it's never wider than the
terminal, centered.

---

## Session — V.34 · 31200 + 33600 (raising the ceiling to 33600)

Added two rates to the existing clean-room V.34 coder, taking the ceiling from
28800 to **33600**. Full scope in PROTOCOLS.md §7 ("Rates and 33600 frame
switching"). Highlights and the road actually travelled:

- **31200/3200 — near drop-in, as predicted.** New `CONFIGS` entry (b=78, K=26,
  M=10, q=5 ⇒ 1280-pt constellation), constant `b`, all-high SWP. Round-tripped in
  `v34-map-check` first try; passed the audio loopback and full-stack immediately.

- **33600/3429 — the two genuinely-missing pieces, plus one surprise.**
  - *Front-end feasibility first.* Before touching the coder, ran the perfect-timing
    eye test at 3429: carrier **1959, β=0.14, span 32 → 0 symbol errors**, slice
    error *tighter* than the working 3200 config. Carrier 1800 fails (band
    [−155, 3755] Hz folds through DC, 440 errors), confirming 1959. Band at 1959 is
    razor-thin (lower edge ≈ 4 Hz) but clean on the lossless link.
  - *Frame switching (§8.2).* Extended `makeConfig` with `swp`/`switching`/
    `isHighFrame`/`bitsForFrame`, and gave `V34Coder.encodeFrame`/`decodeFrame` a
    `high` flag: a low frame draws K−1 real shell bits and forces the top shell bit
    (2^(K−1)) to 0 (§9.3.1), so the shell mapper always sees K bits and the I/Q
    parser is identical. TX and RX each keep a mapping-frame counter reset at
    data-burst start; acquisition lands on TX frame 0, so parity stays aligned on
    the drift-free clock. `v34-map-check` confirmed bit-exact round-trip with
    hi/lo = 6/16 : 10/16 frames (SWP=14A5).
  - *The surprise — acquisition timing precision.* Coder round-tripped perfectly,
    but the first audio loopback at 33600 was **total garbage** (even the rate word),
    while 28800/31200 were flawless. Isolation showed the frames were *aligned*
    (RX frame 0 = TX frame 0) but individual points mis-sliced by ±2, 99.7 % of
    them — and worsening across the burst. Built an offline RX replica and swept the
    acquisition timing grid: **SPS/16 → 99.9 % symbol errors, SPS/64 → 0.0 %**. The
    sharp 3429 eye tips the slicer at a ~0.07-sample timing error that the coarse
    grid couldn't resolve. One-line fix (finer search), no timing-tracking loop, and
    2400/3200 unaffected. This was the whole bug — the switching logic and 3429
    front-end were correct all along.

- **Refactor for per-call rate selection.** V34.js hard-coded 28800 at module load.
  Reworked the rate-dependent constants into a `configure(rateName)` resolver read
  per construction from `config.modem.native.v34Rate` (idempotent; re-runs only if a
  later call picks a different rate — the shared-singleton contract). Amplitude
  params (shaped meanE + preamble REF) moved from per-symbol-rate to
  per-constellation, since 28800 and 31200 share 3200 baud but differ in size;
  measured meanE reproduced the old hand-tuned values (427, {15,15}) exactly, so
  28800 is byte-identical. UI now offers V.34 · 28800/31200/33600; the rate rides
  the dial message (`main.js`) to the server (`server.js`).

- **Verification.** Byte-exact both directions at all three new-path rates in
  `v34-map-check`, `v34test` (protocol-unit loopback), `dsptest2` (full-stack), and
  **through the shipped `dsp-bundle.js`** (browser path, `process` shadowed).
  Other protocols regression-clean. `v34-eye.js` now carries the 3429 row.

- **Honesty (per project convention).** 31200 is fully spec-correct. 33600's 3429
  front-end and the frame-switching *mechanism* are genuine, and b/K/M/q and
  SWP=0x14A5 are the spec's values; the exact SWP **bit-indexing** (LSB-first,
  16-frame period) and the **J=8/P=15 superframe accounting** are a self-consistent
  construction — correct for data integrity here (both ends agree by construction,
  single rate, no superframe sync), but to be checked against V.34 Tables 7–8/10
  before real-HW interop. Advertised rate is the nominal 33600 (14A5 averages
  ≈33594 payload bps; UART idle-fill covers the slack).

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
