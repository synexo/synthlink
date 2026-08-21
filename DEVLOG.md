# SynthLink — Development Log

Historical record: session-by-session narrative, superseded designs, UI
implementation details, and the pre-implementation planning that shaped the
protocols. **Current** state lives in HANDOFF.md (latest sessions), PROTOCOLS.md
(implementation scope), and CLAUDE.md (how to work on it). This file is the
archive so nothing is lost — read it for *why* things are the way they are.

Most recent first.

---

## Session — Share panel + shareable-link query strings

`public/` only (index.html, main.js, about.html); no `vendor/` change, so **no
rebuild**. Three things that turned out to be one feature: a share button, URL
parameters for it to produce, and a default speed worth landing on.

### The speed label came off

`<label>speed</label>` is gone from the control bar. Every entry in that menu
already names its own speed — "V.34 · 33600 bps" — so the word in front bought
nothing and spent width the mobile bar hasn't got. `aria-label` on the `<select>`
keeps the accessible name; `title` was already there.

### Default speed is now V.34 33600

Was V.22bis 2400. Fast enough that a modern BBS feels responsive, while still
being a real handshake with something to listen to — `telnet` has no carrier at
all, so it makes a poor first impression of a project about modem sound. The
`selected` attribute in `index.html` and `DEFAULT_SPEED` in `main.js` must agree;
`sharelinktest` asserts they do, since they are what a link with no `speed=`
falls back to.

### Speeds are named by protocol, not by bit rate

This was the one real design decision. `?speed=9600` cannot be answered: 9600 is
V.29 *and* V.32. Nor can 300 (V.21, Bell 103) or 33600 (V.34's top rate, V.90's
upstream). So the token is the protocol — `v21`, `bell103`, … `v90`, `telnet` —
which is also what the menu shows, so a link is readable next to the UI.

V.34 is the only multi-rate entry. Bare `v34` means its top rate and keeps
meaning that if a faster one is ever added (`speedFromToken` takes the last
match in menu order, which is slowest-first). `v34-28800` picks a specific one.
The separator is a dash, not the `@` the `<option>` value uses: `@`
percent-encodes to `%40` in some clients and turns a tidy link ugly. `@` is still
accepted on the way in, along with any casing and the spec's `v.32bis` spelling.

### The bug this uncovered

`renderBBS()` ended with an "adopt what's displayed" fallback: when `#host`/`#port`
match no option, assume they're stale and overwrite them from the first option in
the list. Sound for its original case (a stored favourite that left the guide).
Fatal for a shared link: **a link to any board not in the directory would have
silently dialled a different board.** The Telnet BBS Guide list is re-scraped
monthly, so this is not a rare case.

Two changes fix it, and they belong together:

1. That branch is now `else if (!manualMode)`. In manual mode the host:port field
   is what's on screen and already agrees with the hidden inputs, so adopting an
   option the user cannot even see would silently redirect them.
2. `loadBBS()` checks whether the URL's destination is in either tier. If it
   isn't, it flips to manual mode so the field *shows* the destination — which is
   also what puts the guard in (1) into effect.

So an in-directory link selects the board by value and shows its name; an
off-directory link shows the bare host:port in the manual field. Either way the
user can see where Connect is going, which is the actual requirement.

### A shared link is a transient override

URL parameters drive the live controls and are **never written to
localStorage**. Someone who opens your link, tries the board, then comes back to
a plain SynthLink URL later still finds their own last destination. Their prefs
change only when they pick something themselves.

This works partly because `connect()` never called `saveDest()` — dialling has
never persisted a destination, only *choosing* one does. That was pre-existing
and is now load-bearing; there's a comment on `shared` saying so, because
"fixing" it would quietly break the guarantee.

Precedence is URL > stored > menu default, for both destination and speed. The
URL wins because a shared link is a specific invitation; losing to whatever the
visitor last picked would make one link behave differently for different people.

### Host validation

`host` is a bare hostname, never a URL: `/^[A-Za-z0-9._-]+$/`, ≤253 chars. Anything
else — a scheme, credentials, a path, whitespace, `<script>` — is dropped whole
rather than repaired, and takes its `port` and `connect` with it. A
half-applied destination is worse than none: it would dial somewhere nobody
chose. This is also the guard that stops a crafted link putting junk in `#host`.

A bad *port* is different: it falls back to 23 and leaves the host, because the
destination is still meaningful and 23 is what a bare host would have used.

### The share panel

Same shell as the about panel (centred, dimmed backdrop, Escape or backdrop to
dismiss). Both URLs are rebuilt each time it opens, so they always describe what
the controls say now.

- **This BBS & speed** — current destination and modulation, `connect=1`.

  A note under the field spells out what the link does in words.
- **SynthLink** — the bare page URL, no query.

The URLs live in readonly `<input>`s rather than `<div>`s so that a browser
refusing clipboard access still leaves a select-all-and-copy path — `copy()`
tries `navigator.clipboard`, falls back to `execCommand`, and relabels the button
`copied` or `select + copy` accordingly. Port is written out even when it's 23:
an explicit link survives being "tidied" by a chat client and shows the whole
destination without opening it.

The BBS row hides itself when there's no destination at all (directory down,
nothing typed) rather than offering a link that dials the empty string.

### The icon

CSS-drawn — three dots joined by two rotated 1px bars — for the same reasons
`#infobtn` beside it is: crisp at any size, takes the button's colour through
`currentColor`, and no platform can substitute a coloured emoji. The dots carry
`background:#1d1d1d` (matching `button`) to mask the line ends, so `box-sizing`
must stay `border-box` or they grow by their border and clip the bars.

### Tests

- `node tools/sharelinktest.js` — 93 assertions, instant, no browser. Same
  extract-from-source trick as `bbslabeltest`. Every menu entry round-trips
  build→parse; host/port validation; the collision cases (`v21` vs `bell103`,
  `v29` vs `v32`) that justify naming by protocol.
- `node tools/urltest.js` — 35 assertions in a **real browser** (Playwright,
  install-on-demand, never a repo dependency). This one needs a browser: the
  behaviour is startup *ordering* — `location.search` is read before the async
  `/bbs.json` resolves, and `renderBBS()` then runs against what the URL put in
  the hidden inputs. It never starts `server.js`, so it doesn't trip the
  WS-listener hang; the page is served from memory and `WebSocket` is replaced by
  a recorder, which is how "did it dial?" is asserted with nothing listening.
  The off-directory case is in there as a named regression test.

Two things worth knowing if you touch the harnesses: the by-name function
extractor must walk the **parameter list to its closing paren before**
brace-matching the body, or a destructured parameter like `buildShareURL`'s
`{ host, port, … }` ends the match at the signature and you get a syntax error
pointing at the harness rather than the source. And `?port=+23` is *not* a signed
port — `+` means a space in a query string, so it decodes to ` 23` and is an
ordinary port 23. `%2B23` is the real case.

---

## Session — Mobile BBS dropdown labels

`public/main.js` only; no `vendor/` change, so **no rebuild**.

The BBS dropdown labelled every entry `Name · host:port`. That reads well on
desktop but badly on a phone: the picker is a native full-width wheel (iOS) or
dialog (Android), the Telnet BBS Guide's ~1000 entries have long hostnames, and
the part anyone actually scans for — the name — is followed by an address that
pushes the useful text off the edge. **On mobile the label is now the name
only**; desktop is unchanged.

### Why this is JavaScript and not CSS

There is no CSS route. `<option>` content is not styleable to any useful degree
across browsers — no `text-overflow`, no pseudo-elements — and mobile renders the
picker from the raw string in a native widget the page has no reach into. The
label has to be built differently, which means `bbsOption()`, the single place
labels are made.

### The coupling that made this more than a one-liner

`currentDest()` recovered the selected board's name by **parsing the label back
apart** on `' · '`:

```js
if (opt && opt.textContent.includes(' · ')) name = opt.textContent.split(' · ')[0];
```

Drop the address and there is no separator, so the name silently comes back
empty — and `currentDest()` feeds the favourites heart. The failure would have
been quiet and mobile-only: hearting a board would store it with no name, and it
would then list forever as a bare host:port. The fix is to stop treating the
visible label as a data store: `bbsOption()` now writes `dataset.name` and
`dataset.hp`, and `currentDest()` reads the name from there. `tools/bbslabeltest.js`
asserts this case directly, including that the mobile label genuinely has no
separator left to split on, so the test documents why the dataset exists.

### Shape of the change (`public/main.js`)

- **`bbsLabelText(name, hp)`** — the whole policy, one function: mobile ⇒
  `name || hp`, desktop ⇒ `name ? "name · hp" : hp`. An entry with no name (a
  hand-typed favourite) has only its host:port to show and so renders identically
  either way.
- **`bbsOption()`** stores `dataset.name` / `dataset.hp` alongside the label.
- **`relabelBBS()`** rewrites labels in place from the dataset. Options with no
  `dataset.hp` — Random, the `(no directory)` placeholder — are skipped: they are
  not destinations. `value` is never touched.
- **Resize listener** on the 640px crossing, the same pattern as the mobile font
  default further down the file, calling `relabelBBS()`. Landscape gets the full
  labels back.

Nothing keys on the label text anywhere else — selection, the
keep-across-rebuild logic in `renderBBS()`, the favourites match and the `change`
handler all use `option.value`, which is still the canonical `host:port`.

### Where the address went

Nowhere it wasn't already. The pencil toggle (`#bbstoggle`) seeds its manual
`host:port` field from the hidden `#host` / `#port` inputs, which the `change`
handler sets — it never read the label. So switching to direct-entry mode on
mobile shows the selected board's full address unchanged, with no new UI and no
vertical space spent on a screen that has none to spare.

### Test

`node tools/bbslabeltest.js` (~0 s, no DOM library, no sockets). It **extracts
the three functions out of `public/main.js` by name** and runs them against a
tiny `<option>`/`<select>` stand-in with a settable `isMobile()`, rather than
duplicating them — `main.js` is a browser module that runs top-to-bottom against
a live DOM and an `AudioContext`, so it cannot be required, and a copied
implementation would drift. If a function is renamed the extraction throws
instead of silently testing a stale copy. 22 assertions: both label forms,
unnamed fallback, values untouched, the `currentDest()` regression, relabelling
both directions, non-destination options left alone, idempotence, and that the
640px breakpoint is the shared `isMobile()` helper.

---

## Session — V.90 (56k), real V.8 for the fast protocols, V.34 §8.2 correction

Biggest protocol session since V.34. Added V.90, moved four protocols onto genuine
V.8, and corrected a V.34 framing error that had been carried as a documented
"self-consistent construction". Scope detail is in PROTOCOLS.md §8 (V.90) and §7
(V.34); the forward backlog is PROTOIMPROVE.md. This entry is the narrative and
the things that are only interesting in hindsight.

### The retrieval discovery — the thing that actually unlocked the session

The session began intending to *document* V.90's unverifiable pieces and ended up
removing most of them, because of a method change rather than a coding insight.

`WebFetch` against an ITU PDF answers through a summarising model. Asked normally
for a table it **reconstructs** — returning confident, well-formatted, wrong
values. The first pass at Table 2/V.90 came back as plausible-looking rate rows
that were partly invented. Only the rate *formula* and the 56 000 endpoint were
trustworthy, which is why the initial V.90 implementation shipped single-rate with
a "Table 2 not verified" caveat.

Instructing it to transcribe literally **or reply `CANNOT READ TABLE`** changed the
outcome completely: Table 2 (all 25 rows), Table 14 (CP), Table 16 (MP), and
V.34's Tables 7 and 8 all came back readable. Full technique and cautions in
PROTOIMPROVE.md §0 — it applies to every remaining caveat in the repo.

The lesson worth keeping: *a summariser asked for data will invent data.* Give it
an explicit refusal option and cross-check what returns. Two independent checks
caught problems this session — see the V.34 subsection below.

### V.90 — why it fits this transport better than the analogue modems

Recorded here because it is the architectural point and it is easy to lose:
V.21…V.34 synthesise a voiceband waveform to ship over what is *already* a PCM
pipe. V.90 downstream does not modulate at all — it selects µ-law codewords, which
is exactly what an 8 kHz PCM WebSocket carries natively. So the entire DSP
front-end that made V.34 hard (carrier, RRC, matched filter, fractional timing
acquisition) simply does not exist for V.90. **The symbols are the samples.** On
this link the analogue protocols are the artificial ones.

Consequence for staging: the whole hard core of V.90 — µ-law codec, modulus
encoder, constellation builder, spectral shaper — is sockets-free, DSP-free pure
integer arithmetic, so all of it was unit-tested before anything touched
`Handshake.js`. A markedly better starting position than V.34 had, and the reason
the protocol came up byte-exact almost immediately.

The role mapping is forced and happens to be lucky: `answer` (server) is the
**digital** modem doing 56 000 downstream, `originate` (browser) is the
**analogue** modem doing 33 600 upstream. Fast direction where a BBS needs it. The
upstream is the existing V.34 class composed unmodified and driven one-way.

### The µ-law "quantiser" framing was wrong, and was corrected mid-session

The pre-implementation notes (V90NOTES.md, since deleted) described inserting "an
8-bit µ-law quantiser as the modelled network codec", and the first implementation
comments repeated it. Challenged on it, the claim did not survive: **there is no
quantiser in the path and nothing is companded.** V.90's transmitter is *defined*
as selecting G.711 codewords, which is precisely what the code does — that is
genuine V.90 behaviour, not a model of it.

The real differences are narrower and live elsewhere: nothing *enforces* the
codebook here (a real 64 kbit/s path does), we ship decoded 16-bit linear values
rather than 8-bit octets, and we therefore inherit none of the receive-side
impairments (RBS, digital pads, the loop D/A). Corrected wording is in
PROTOCOLS.md §8. Kept here because the wrong framing was in three files and a
commit message before it was caught.

### Two real bugs

**V.90 Sd acquisition — phase ambiguity.** `{+W,+0,+W,−W,−0,−W}` is antisymmetric
under a three-symbol shift: shifting by 3 reproduces the sign-inverted pattern
exactly. The hunt accepted either polarity, so it pinned frame phase only **mod 3**
and could lock three symbols early, splitting every frame across the Sd/data
boundary. It passed the protocol-unit test by luck and only surfaced when the V.8
work changed the timing — the symptom was a perfectly-descrambled all-ones stream
(TX appearing to send only idle) because RX frame one read
`[8031, 0, 8031, −5471, 1087, −7519]`: half Sd, half data. Fix: match the normal
polarity only, which pins phase mod 6. `tools/v90test.js` now sweeps all twelve
starting offsets so the class of bug cannot return.

**V.90 hunt was quadratic.** The first version rescanned the whole RX buffer on
every audio chunk. With a one-second answer tone sitting in front of Sd this was
slow enough to look like a hang (the test timed out at two minutes). Replaced with
a single forward pass over an only-advancing cursor. Worth remembering: *"appears
to hang"* in this codebase is not always the WS-listener sandbox trap.

### Real V.8 for V.32 / V.32bis / V.34 / V.90

V.90's Phase 1 **is** V.8 — the Recommendation signals V.90 capability through
`modn0` bit b5, "PCM avail". That bit was already being built *and* decoded by the
vendored V.8 sequencer; only the protocol mapping was missing. So V.90 went onto
real V.8 for a handful of lines.

That made the same move obvious for V.32/V.32bis/V.34, which had been bypassing
V.8 via `want<X>` blocks. Total cost: one line in `V8.selectProtocol`, one in
`V8Sequencer._buildModes`, deleting three bypass blocks, and a four-line
`setV8Complete()` on each class. No DSP changes at all.

`setV8Complete(done)` is the contract that makes it work: a protocol emitting its
own 2100 Hz answer tone must suppress it when V.8 already ran, because ANSam has
already played and a second tone lands during the peer's post-CJ training and
trips its energy-onset acquisition. `Handshake._selectProtocol` calls it on any
protocol defining it. This is exactly the collision the `want<X>` bypasses were
originally written to avoid — the bypasses were a reasonable answer before the
hook existed.

Connect-time effect: V.32 and V.32bis went 2.7 s → 3.8 s (a real negotiation now
happens). V.34 went 6.0 s → **4.0 s** — dropping its one-second answer tone more
than offsets V.8.

Note V.8 has a single bit for the **V.32/V.32bis family**, as it does for
V.22/V.22bis. Both ends resolve which from their own preference list. That is how
V.8 works, not a shortcut.

**V.29 was deliberately left bypassing V.8.** The mechanism is now proven and
`v29hd` already exists as a mode bit, so the cost would be low — but V.29 is
half-duplex ping-pong with its own audible connect script (2100 Hz answer tone →
longtrain → per-burst `lock` preamble), and its non-syncing pre-roll interacts with
squelch in a way the continuous-carrier protocols do not. Parked by decision, not
by difficulty. If picked up: the tone suppression is the same `setV8Complete`
filter, but the `_buildConnectScript` pre-roll needs checking against the post-CJ
handoff, since V.29's receiver re-acquires per burst.

### V.34 §8.2 — SWP indexing was wrong

Carried since the 33600 session as a documented self-consistent construction. With
Tables 7 and 8 transcribed it turned out to be wrong in **two** ways:

- The pattern period is **P** from Table 7, not 16. For 3429, P = 15.
- §8.2 says *"the left-most bit corresponds to the first mapping frame"* — i.e.
  **MSB-first**. The code indexed LSB-first.

So SWP 0x14A5 is `001010010100101` over 15 frames, not a 16-frame LSB-first walk.
Both ends agreed before, so data was byte-exact — it simply would not have
interworked with a real V.34.

The **values** the earlier session derived were all confirmed correct by §8.2's own
formulas (`N = R·0.28/J`, `b = ⌈N/P⌉`, `r = N − (b−1)P`). `makeConfig` now computes
them and **throws** unless the SWP one-count equals `r` and its right-most bit is 1.
It caught nothing when added, which is the point: a future rate entry cannot be
added wrong silently.

That guard also caught a transcription error. Table 8 came back with its last two
rows **column-shifted** — 33600 appearing under 3200 sym/s. Only 3429 satisfies the
formulas for 33600 (N = 1176, P = 15, b = 79, r = 6, and 0x14A5 has exactly six
ones). Verify transcriptions against the spec's own arithmetic.

Visible confirmation: `v34-map-check` now reports the 33600 high/low split as
8000/12000 — exactly r/P = 6/15.

### Phase 4: genuine bit layouts, and why V.90's CP is not decorative

V.90's CP/MP are built to Tables 14 and 16: 17-one frame sync, 17-bit groups of one
start bit plus 16 payload bits, fields at literal positions, signed Q1.6
coefficients, eight 16-bit Uchord masks, trailing CRC. `V90Phase4.js` places every
field by its printed bit index so the layout can be audited line by line against
the Recommendation.

`tools/v90-phase4-check.js` asserts **positions**, not just round-tripping — a
self-consistent encoder/decoder pair will happily agree on a wrong layout, which is
precisely the failure mode this session was cleaning up elsewhere.

The contrast worth recording: V.90's CP genuinely configures the downstream — the
digital modem sits silent in its `gap` stage until CP arrives because it does not
know which constellation, shaper coefficients or lookahead depth to use. V.34's
`DLE 'R' hi lo` rate frame, by contrast, is **decorative**: both ends resolve the
rate from the shared config singleton before construction, so it verifies agreement
rather than establishing it. That asymmetry is why V.90 got real field layouts
first. V.34's real MP/MP′ is PROTOIMPROVE.md item 2, and `V90Phase4.js` is the
template.

One ordering trap: CP must be queued at **construction**, not on the upstream
V.34's `ready` event. On the analogue side that event never fires — it means "my
receiver acquired the peer", and that side only transmits V.34; its receiver is the
downstream PCM decoder. Cost an hour of debugging a handshake that stalled with
`cpSent: false` forever.

### Rate ladder

Table 2 reproduces exactly from three constraints: `K ≥ 15`, `3 ≤ S ≤ 6`,
`21 ≤ K+S ≤ 42`. All 22 rungs (28 000 … 56 000 in 1333⅓ steps) are implemented and
selectable per call; 56 000 is the default.

Worth knowing: **56 000 has four legal (K,S) pairs** — (36,6), (37,5), (38,4),
(39,3) — differing only in how many sign bits go to shaping. We default to (39,3),
maximum shaping. This corrected an over-strong claim made earlier in the session
that "56k needs 91 of 128 levels": 91 is specific to (39,3); at (36,6), with no
shaping at all, 64 levels suffice. The real trade is shaping against constellation
size.

### Superseded

- **V90NOTES.md** — pre-implementation notes, deleted at the end of this session.
  Its architectural reasoning is in PROTOCOLS.md §8 (and the "why V.90 fits"
  subsection above), its sources in PROVENANCE.md §3/§4, and its open questions
  either answered in PROTOCOLS.md §8 or carried forward in PROTOIMPROVE.md. Its
  "insert a µ-law quantiser" framing was wrong and is corrected above.

---

## Session — Telnet server-side, deferred BBS connect, modem-bypass mode

Three changes: telnet moved out of the browser into `lib/telnet.js` on the
server; the BBS is dialled when the link comes up, so the board's own timers
don't run during the handshake; and a "Telnet · modem bypass" speed that skips
the DSP entirely. No `vendor/`
change in any of them, so no `npm run build`. This section absorbs the planning
document (TELNETREFACTOR.md) that drove the work; that file has been removed.

### Why telnet moved (the BBS-compatibility fix)

The browser's `TelnetFilter` refused **every** option except Suppress-Go-Ahead —
`DONT`/`WONT` to everything. So no TTYPE and no NAWS. Plenty of BBSes probe
TTYPE to decide whether to send ANSI and fall back to plain ASCII, or misdetect
the client entirely, when it is refused. **That was the cause of the long-standing
"some BBSes misbehave" symptom**, and answering TTYPE fixed it (confirmed against
real boards). Secondary wins: negotiation no longer costs carrier time (a ~30-byte
IAC exchange is a full second at V.21's 300 bps), and terminating server-side is
what makes modem bypass possible at all.

The reason it belongs on the *server* is that the server knows what the terminal
is: the renderer is fixed at an 80×25 CP437 ANSI grid, so TTYPE and NAWS are
**constants, not negotiated capabilities**.

### Non-obvious things about `lib/telnet.js`

- **TTYPE is a cycle, not a value.** Answer `ANSI` → `ANSI-BBS` → `UNKNOWN` on
  successive `SEND` subnegotiations and then repeat the last entry forever. Some
  BBSes probe repeatedly walking the client's list and expect it to terminate by
  repetition; returning one fixed string can leave them probing.
- **A literal `0xFF` inside a subnegotiation payload must be doubled.** 80 and 25
  never trip it so the NAWS reply looks fine either way — but a future variable
  window size would, silently. `pushEscaped()` handles it; the unit test covers
  it with a 255-column filter.
- **The state machine must survive arbitrary chunk boundaries.** TCP splits
  wherever it likes, including mid-subnegotiation. `tools/telnettest.js` has a
  fuzz loop that re-splits one stream 500 times at random boundaries and asserts
  an identical result against a whole-stream reference — that is the test that
  would catch a resync bug, not the hand-written cases.
- **`onData`/`onSend` fire synchronously from `process()`**, so a reply can be
  written to a socket that teardown is in the middle of destroying. Hence the
  `sock && !sock.destroyed` guard in `toBBS()`.
- The class is dependency-free CommonJS on purpose: `server.js` is CJS,
  `package.json` has no `"type"` field, and the browser has no live consumer any
  more, so no ESM bridge is needed. `public/terminal.js` keeps only a pointer
  comment where the class used to be — the original plan said to leave a dormant
  copy in the browser, but two copies drift, and there is no real intention to
  terminate telnet client-side again. It is in git history if ever wanted.

### The BBS is dialled when the link comes up, not at dial time

**This ordering is load-bearing; everything below depends on it.** In modem mode
the connect happens when the carrier trains; in direct mode, at dial (there is no
handshake to wait through). Both then negotiate from the socket's connect
callback.

**Do not move the connect back to dial time.** Dialling at dial means the board
is talking — and running any "press a key" window or menu timer — through the
entire 2–3 s handshake, far longer at 300 bps, with `pending` swallowing its
banner. A board waiting on input can time out or drop the node before the user is
able to type a single key. Losing the session outright is far worse than the cost
of the current design, which is this: connection failures (refused, host down)
surface *after* the handshake rather than instantly. They are reported explicitly
— the server sends `{type:'proxyError'}` and the terminal echoes `TELNET PROXY
CONNECT FAILED`, followed by the usual `NO CARRIER`. DNS failures still surface
immediately, because the client resolves at dial for the DTMF digits.

**A pre-flight connect to test reachability is not an acceptable substitute** —
many BBSes count the dropped probe as a node session.

Two ordering traps, both easy to get wrong:

- **`linkUp()` must run from the socket's connect callback, never earlier.** It
  calls `filter.negotiate()`, and negotiation replies need a socket to write to.
  Calling it on the carrier event and connecting afterwards silently drops the
  whole negotiation — presenting exactly like a board that refuses TTYPE.
- **The server's carrier fires slightly before the client's.** So the BBS is
  legitimately already dialled by the time the *originate* DSP emits `connected`
  — a test that samples state at that event will report a false failure.
  `tools/directtest.js` asserts on elapsed time instead (the dial lands >500 ms
  after the call begins, typically ~1 s for V.32bis).

Negotiation timing needs no separate rule: the socket does not exist until the
link is up, so the IAC exchange cannot happen before the user can respond.

`pending` is close to vestigial as a result — nothing can arrive before the link
is up. It is kept as a safety net for anything landing in the same tick as
connect, bounded at 256 KB so it can never grow without limit.

### Modem-bypass mode

`link:'direct'` on the dial message. The server constructs no DSP and binary WS
frames carry payload instead of PCM — **the frames are not self-describing; the
mode is what disambiguates them**, on both ends. Two seams make this cheap:

- `transportWrite()` is the only place that knows which transport is live. The
  socket handlers, the telnet filter and the pending queue are untouched.
- `linkUp()` is shared, and both modes now reach it from the same place — the
  socket's connect callback. What differs is *when the socket is opened*: at
  carrier for the modem, at dial for direct. Both negotiate and flush
  identically, so the two modes cannot drift apart.

Client-side, `modemWrite()` and `feedTerminal()` are the matching seams, so the
terminal, keyboard and AT layers never learn which transport is live.

UI decisions that are judgement calls, not accidents:

- **The dial audio is skipped** in direct mode. DTMF, ringback and answer tone all
  describe a modem placing a call, and there isn't one.
- **The speaker control stays enabled and Auto is held open** rather than fading
  out. It still gates ANSI music, which plays through its own AudioContext and
  works fine here. The box should read as deliberately idle, not broken.
- **No `+MS` entry.** `+MS` selects a *modulation* and bypass has none; a made-up
  token would be the one fake string in a table of real ones. The dropdown echoes
  `[Telnet - Modem Bypassed]` instead of an AT command.

### The throughput graph (scope box, direct mode only)

- It plots the **unsmoothed** rate. `flowBps` is smoothed so the numeric readout
  stays legible; feeding that to the graph would flatten exactly the bursts worth
  looking at. Both are computed in the same 250 ms tick.
- **Auto-range attacks instantly and decays slowly** (`if (winMax > tpScale)
  tpScale = winMax` else ease down). Instant attack means it never clips; slow
  decay means one download burst doesn't flatten the next minute of display.
- The **scale label is not decoration** — with auto-ranging, a quiet link and a
  busy one look identical without it.
- Blockiness is stacked fixed-height segments with a gap, coloured by *absolute*
  height through the spectrum's own `specColor()`, so it reads as an LED bar
  meter and sits in the same visual family as the spectrum it replaces.

### Testing inside `wss.on('connection')` without hanging the sandbox

The long-standing rule is that a persistent `ws` server hangs the sandbox (see
the sandbox note near the end of this file), which historically meant the
per-connection session code could not be tested at all. `tools/directtest.js`
gets around it: **stub the `ws` module via `Module._load` with an EventEmitter
that never listens**, then `require('../server.js')` and `emit('connection', …)`
a fake socket at it. The BBS end is a real TCP server (plain listeners are fine).
That exercises the genuine `server.js` session code — dial handling, the telnet
filter, both transports, teardown — with no WebSocket anywhere. `process.exit(0)`
at the end, since the static HTTP listener stays up.

This technique generalises to anything else in that closure.

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

### Telnet SGA restored (`public/terminal.js`) — SUPERSEDED
> Telnet no longer runs in the browser at all: `TelnetFilter` now lives in
> `lib/telnet.js` and terminates at the server, which also answers TTYPE and
> NAWS. See the telnet-termination session at the top of this file. The SGA
> logic below survives unchanged inside the moved class.

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
