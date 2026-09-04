# SynthLink — Development Log

Historical record: session-by-session narrative, superseded designs, UI
implementation details, and the pre-implementation planning that shaped the
protocols. **Current** state lives in HANDOFF.md (latest sessions), PROTOCOLS.md
(implementation scope), and CLAUDE.md (how to work on it). This file is the
archive so nothing is lost — read it for *why* things are the way they are.

Most recent first.

---

## Session — the local audio bus

The oscilloscope used to read an AnalyserNode, which only advances while its
AudioContext does. `connect=auto` dials with no user gesture, so its context
never starts and the scope showed a flat line however loud the carrier was —
muting was never involved. Call-progress tones had a second version of the same
problem: they were OscillatorNodes, so they could be heard but never seen.

Both are gone. Everything that makes a sound is now PCM at `SR` mixed into one
ring; the scope, the spectrum and the speaker are three readers of it, and the
tones are rendered rather than oscillated. The scope's read position runs off
the wall clock, so the trace is a function of the signal rather than of
playback. `bustest` covers the whole visual chain in Node as a result — before
this it needed a real browser, and the case that broke was not reachable even
there, because headless Chromium does not enforce the autoplay policy.

The sink went through both alternatives before landing. Scheduled buffer
sources were the long-standing Chrome crackle: consecutive buffers slip a
sample at the boundary, and the cursor re-anchors whenever a flush runs late,
stepping the waveform mid-carrier. An AudioWorklet fixed that on desktop and
produced silence on every phone — it is secure-context only, so on a plain-http
origin `ctx.audioWorklet` is undefined, with no throw to catch. A
ScriptProcessor is one continuous pulled stream like the worklet, exists on any
origin, and reports its queue depth every buffer instead of eight times a
second, which keeps the trace tighter to the audio. Its callback runs on the
main thread; that has not been audible.

Two rules the design turns on. Nothing may be written at or below the post
frontier, so a writer that stalls resumes ahead of it and drops frames **for
listening only** — the demodulator is on the other side of the bus and gets
every sample, and the speaker can never affect the link. And nothing is handed
to the sink while the context is not running, so no backlog can build up to be
dumped on the visitor's first touch.

---

## Session — telnet-bypass gates, an append-only guide, connect=auto

Six items, none of them protocol work. Only what the diff does not say.

**The bypass gates exist because the modem paces itself and bypass does not.**
A V.21 call spends nine seconds handshaking before a byte moves; `link:'direct'`
opens a TCP socket the instant the dial message lands. So bypass — and only
bypass — now dials listed boards only, and one dial server-wide per ten seconds
(it was written per client first; see the follow-up below for why that changed).
The interval is a DELAY, not a refusal, and says nothing: a slower answer is
what a real line does, and an abuser gets no signal to calibrate against. The
reservation is taken when the dial arrives rather than when it completes, so
hanging up after three seconds still waits out the remaining seven.
`describeDest()` was already doing the directory lookup for the failure log, so
the listed check is that function read for its `tier`.

**The guide cache is now a record, not a copy.** It had been replaced wholesale
each month, which is fine for a list you only read alphabetically and useless
the moment "newest" means anything: the guide publishes no first-listed date, so
the only date available is ours, and ours survives only if the record is never
rebuilt. Editions are merged in, entries that leave are kept, and `added` is
written once. Identity is name + host:port rather than host:port, because
`csvToEntries` deliberately keeps ten same-address listings apart — the cost is
that a renamed board arrives beside its old entry, which is the trade that key
makes knowingly.

**The sort is three more acting options, the same trick the guide link uses.** A
native `<select>` cannot hold a control and the header cannot afford a second
row (`fitBar()`). The new sentinels made `isSentinel()` worth having: two places
must never treat one as a host:port, and renderBBS()'s "adopt what's displayed"
branch is one line away from putting `@sort-new` into `#host`.

**`connect=auto` mutes because it cannot do anything else.** The note above
`maybeAutoConnect` already argued that dialling from page load is wrong: with no
gesture the AudioContext stays suspended while the DSP's timer runs on, and the
whole handshake plays back later over a live session. `connect=1` solved that
with a prompt. `auto` is for the case where nobody will press anything, so the
audio is not deferred — it is dropped for that call, and the stored preference
is never touched (put back on the next dial, and by the next load anyway, since
it was never written).

**The mobile page-pause message: built, reverted, and not being pursued.** The
watchdog, both lifecycle listeners and `pausedDropMessage` are gone, and the
planning note with them.

The symptom is real and permanent. A modem link is a continuous real-time signal
in both directions and cannot be paused and resumed: `ModemDSP._txTick()` is a
`setInterval(…, 5)` generating audio against a `Date.now()` target, so a
throttled background timer stops the carrier immediately, and iOS suspends the
AudioContext outright — WebKit [237878](https://bugs.webkit.org/show_bug.cgi?id=237878),
with `navigator.audioSession.type = 'playback'` no help either
([261554](https://bugs.webkit.org/show_bug.cgi?id=261554)), so the silent-audio
keep-alive trick is unreliable there. Nothing in the app chooses to hang up; the
teardown is the socket closing. Confirmed on a real device: **telnet bypass
SURVIVES backgrounding**, because `link:'direct'` never constructs a DSP and so
has no real-time dependency. That one is in README.md now, where a user will find
it.

The idea was to detect the freeze and say so rather than engineer around it. A
stall watchdog recorded `Date.now()` each second, and a gap over ~2.5 s meant
timers had been frozen. It was proven both ways in a harness and was wrong in the
field in both directions: it fired on DESKTOP, at times having nothing to do with
a backgrounded page, and it never fired on a real Android backgrounding, so the
message simply never appeared. The lesson kills the approach rather than the
threshold — **a stall watchdog cannot tell a frozen page from a busy one**, and
no number fixes that. Anyone tempted again should start from a recorded `hidden`
timestamp on a real device, not from an inferred gap.

Two roads were considered and rejected, and only one would ever have helped iOS:
a server-side session hold with reattach, keeping the telnet socket alive past
`ws-closed` and buffering output behind a token — which needs a session identity
and security model, hold timeouts and resource caps, and touches logging and the
dial counters. Moving the DSP into an AudioWorklet was the other, and it does
nothing on iOS, where the whole context is suspended.

The `repaintAll` listeners on `visibilitychange`/`pageshow` are a DIFFERENT fix —
a blank terminal after backgrounding — and stay.

**Alt+C and Alt+X are one button between them.** `#dial` toggles, so each is
gated on `dialing` rather than clicking it blind — Alt+C during a call would
otherwise hang it up, which is the one thing that press cannot have meant. Both
still swallow the key when inert, so the browser's own Alt handling does not
get it half the time.

**The keyboard's `⇧#` is now `↑@#`, and view 1 has a `#`.** The old label read
as a shift key with a stray glyph after it; the key reaches capitals, symbols
and the numpad. The new one is a `goto` — a third view-changing kind beside
`cycle` and `mod` — with no long press, since the numpad view is already sticky
and a lock would add nothing. `kbdmodtest` needed telling that a `goto` key
sends nothing by design; that skip list is the one place a new key kind has to
be registered.

**Two harnesses dial loopback through bypass.** `directtest` wraps
`lib/bbslist` and `lib/site` at `Module._load` rather than writing the
operator's config — the trap CLAUDE.md names for `logtest` and `sitetest`;
`idletest` already writes a scratch `site.json` and just turns the gate off in
it.

### Follow-ups the same session

**The bypass limiter went from per-client to global.** Per-client is the shape
everyone reaches for and it is the weaker one here: the attack it has to survive
is somebody dialling in a loop, and addresses are the cheap thing for them to
vary. Global means one interval shared by everyone. That is a real cost — a
second visitor can wait behind a first — accepted deliberately, because this is
a small service and the modem path, which is the point of it, is not limited at
all. Under attack, telnet queues and every modem speed still works.

**`trustedProxies` gained CIDR matching, and stayed a logging setting.** It had
only ever compared literal addresses, which made it unusable for the deployment
`log.js` is written for: Cloudflare publishes ~15 IPv4 and ~7 IPv6 ranges and no
list of edge addresses exists. Parsing is its own function per family with no
regex-guessing, families never cross (`::/0` does not sweep in v4), and the
compiled blocks are built once per `loadConfig()`. The one judgement call:
a configured list where NOTHING parsed now trusts nobody rather than falling
back to "trust any peer", so a typo can only tighten spoofing, never reopen it.
It is still attribution only — it refuses no request — and the question of
whether to add a refusing mode was left alone rather than smuggled in here.

**`connectAuto` was only ever an internal field name, and it cost a round.** The
URL parameter has always been `connect=auto`; the parsed object called the flag
`connectAuto`, that name reached the docs, and it reads exactly like a parameter
you would try as `?connectAuto=1`. Renamed to `dialOnLoad`, which cannot be
mistaken for a URL key, and urltest now asserts that `?connectAuto`,
`?connectAuto=1` and `?connect=automatic` all do NOTHING — the negative case is
the one that would have caught the confusion by itself.

---

## Session — Chrome glyph rendering: two bugs, one shared shape

`public/renderer.js`, `public/fonts/index.js`. Only the parts not readable off
the diff.

**Both bugs were invisible to every harness, and that is structural.** Chromium
headless rasterizes canvas in software: it clamps `drawImage` to its source rect,
and it rasterizes these faces to a clean 0-or-255 at the design grid. Neither
defect can occur there, so `getImageData` reported clean pixels while the screen
showed the artifact — including inside a purpose-built probe, which produced a
confident CLEAN verdict that contradicted its own magnified strip. The probe was
deleted rather than kept. What actually worked was measuring the user's
screenshots and reasoning from **which glyphs were affected**.

**The hairline: the answer was in the wide/narrow split.** A one-pixel column at
the right edge of every wide cell, absent from narrow ones. The only difference
between them is that a wide cell blits `padW` and so ends its source rect exactly
on the atlas cell boundary, while a narrow cell blits `inkW` and stops a texel
short. The extension column exists for glyphs that must meet their neighbours; a
letterform's copy of its blank advance column was never doing anything, so
capping non-`STRETCH_X` glyphs at `inkW` costs nothing and removes the boundary.
Confirmed by instrumenting `drawImage`: `/` now requests only 23 source px where
`┼` and `█` still request 24.

**The glyph bug: the affected set was a definition, not a list.** `E G M N W w`
and the double-line box set — every one of them built around a gap exactly ONE
design pixel wide, and the single-line box glyphs, which have no such gap, were
fine. That mattered because the two groups take different paths: box drawing is
pass 1 from the thresholded bitmap, letterforms are pass 2 from `fillText`. One
cause had to explain both, which ruled out anything path-specific — and it ruled
out two wrong theories that had already been shipped and reverted (a transparent
atlas gutter, and `textRendering: 'geometricPrecision'`, neither of which changed
anything on the affected machine).

What is left is that the rasterizer lays down more ink, and the 50% threshold in
`deriveOutlineBitmap()` amplifies it into total loss: at the design grid a design
pixel is a device pixel, so a gap pixel at ~60% coverage crosses 128 and the gap
is baked shut. The measurement that settled the value: across the AST face's 256
glyphs a faithful rasterization is 29377 pixels at 0 and 9535 at 255, with **no
intermediate value at all**, so anything in between is error and the threshold
belongs far from 50%. `DERIVE_THRESHOLD` is 192.

**Do not read the second fix as license to tune the first.** They are
independent: the cap is about where a source rect ends, the threshold is about
what counts as ink. Rendering these two faces from the derived bitmap instead of
the outline was considered and rejected — it is browser-independent by
construction but reintroduces the uneven stems §5.5 records as the reason
outlines replaced replication.

---

## Session — protocol authenticity backlog (PROTOIMPROVE items 1, 2, 6)

`vendor/src/dsp/protocols/{BitFrame,V34Phase4}.js` (new),
`{V34,V34Mapper,V32bis,V90Phase4}.js`, `public/dsp-bundle.js` (rebuilt), new
harness `tools/tests/v34-phase4-check.js`. Only the parts not readable off the
diff.

**The retrieval technique has a sharp edge that §0 did not name.** Prose clauses
and gridded tables transcribe literally; *figures* refuse. §10.1.2.3.2 (CRC),
§10.1.3.9 (MP) and Tables 10 and 20 all came back word for word. Figure 14 (the
CRC shift register), Figure 2-1/V.32bis and Figure 5/V.34 all returned `CANNOT
READ TABLE`. That split is now the rule of thumb in §0, and it is what decided the
session's scope: items 1, 2 and 6 shipped, items 3 and 4 were attempted and left
alone rather than inferred.

**The CRC was wrong in a way both ends agreed on.** §10.1.2.3.2 fixes four things.
Three already matched — all-ones preset, no inversion, no reversal, LSB first. The
fourth did not: the CRC covers "all of the information bits in a sequence, except
the frame sync bits, the start bits, and the fill bits", and `crc16()` was running
over a flat slice that swept the start bits in with everything else. They are all
zero, so nothing ever failed; a real V.90 would simply have disagreed. Fixed in
`crcCoverage()`.

That change invalidated an assertion, and the assertion was the wrong one, not the
change. `v90-phase4-check` claimed 400/400 random single-bit corruptions caught
over a range that included start bits — under the spec's own coverage rule a
flipped start bit *must not* change the CRC. Replaced with an exhaustive sweep over
the information bits plus the opposite assertion for the start bits, rather than
softened.

**V.34's MP is now load-bearing, which was the point.** Table 20/V.34 Type 0 built
at literal bit positions, replacing the invented `DLE 'R' hi lo` frame. The
temptation was to keep sending three copies up front and call it done — that would
have made the acknowledge bit decorative in exactly the way the old rate frame was.
Instead data mode is gated: send MP until the peer's arrives, answer with MP′
(§10.1.3.9 defines MP′ as MP with bit 33 set), then send the data mark. The peer's
transmit rate is read from whichever directional field belongs to *its* direction,
which is what makes Table 20's two rate fields do work. `MP_MAX_REPEATS` is the
escape hatch: a lost control frame degrades to entering data mode, never to a hung
link. Both ends still resolve the rate from the config singleton, so this does not
yet *choose* the rate — but it now verifies the coding selections, and a peer
asking for a trellis, Θ or shaping this decoder does not run is recorded rather
than silently mis-decoded.

**Table 10 turned an assumption into a fact.** The four configs' (K, M, L) triples
match the Recommendation's **Minimum** shaping columns exactly — so MP's shaping
bit is genuinely 0, not a guess, and `makeConfig` now throws if a config drifts off
its row. L is derived from the quarter constellation rather than declared, so a
wrong `kShell` or `mRings` moves it and the row stops matching.

**`BitFrame.js` exists because there are two users now, not three.** V.90's Phase 4
was the template item 2 predicted it would be; the helpers moved out and
`V90Phase4` re-exports them under its old names so nothing downstream had to move.

**Verification.** `npm run build` + the browser-path safety check;
`v34-phase4-check`, `v90-phase4-check`, `v34-map-check`, `v34-{shell,trellis}-check`,
`v90-{map,modulus,shaper,ulaw}-check`, `v34test`, `v32test`, `v32bistest`, `v90test`,
`v29test`, `directtest`, `telnettest` all pass; `dsptest2` passes for V.34, V.32bis,
V.32, V.90, V.29, V.22bis, V.23, V.21, and V.22 at `SECS=12`. Bell 103 fails
`dsptest2` and `attest` fails 6 of 70 on `ATDT RANDOM` — both verified identical on
pristine HEAD.

---

## Session — six UI/server fixes

`public/{main,index,terminal}.js|html`, `server.js`, `lib/site.js`,
`config/site.json`. `vendor/` untouched, so **no rebuild**. New harness:
`tools/tests/idletest.js`.

Only the parts that are not readable off the diff.

**1. Hang up during the dial did not stop the dial.** Two independent causes,
and fixing either alone leaves the bug. (a) The dial sequence is ~3 s of audio
scheduled onto the audio clock in ONE call, so "stop dialling" cannot mean "stop
calling `tones.dual()`" — by then the tones already exist in the graph.
`tones._live` holds the nodes so `stopAll()` can silence them; `monitor.playing`
does the same for carrier buffers, which are scheduled a guard interval ahead.
(b) A `callGen` counter, bumped on every Connect *and* every teardown and
captured by everything `connect()` schedules; the dial-sequence promise, the
socket handlers and `startModem` all check it. The third bug it fixes was not
reported: `onclose` fires asynchronously, so a fast hang-up-and-redial had the
OLD socket's close running `cleanup()` over the NEW call. The socket is now also
held in a local `sock` — a stale handler that tested `live()` and then closed
the module-level `ws` would close the *current* call's socket.

**2. Zoom could never fire on desktop.** The magnifier was reachable only from
`touchstart`, so a mouse had no gesture that could open it: switching scrollback
off released the 2×/3× button, and then nothing could act on it. The
scrollback/zoom exclusivity is untouched and still arbitrated by that one
toggle on every device — what was missing was the gesture, not permission.
The press path is a LIST (`terminalPressActions`), not a handler: the terminal
will want select-and-copy and click-to-follow-URL later, and ordering is then
the only thing to think about. Touch is deliberately not routed through it — its
arbitration (keyboard-first, hold-to-zoom, swipe-to-scroll) is a different
problem with a different answer.

**3. The header grew a row on a dial to an unlisted board.** `fitBar()`'s
loop-safety comment claimed the measurement read "the browser's own natural
layout". It does not: with the override cleared, `#controls` (flex:0 1 auto)
takes its MAX-CONTENT width, which equals the space beside the scope only while
that max-content exceeds it. Switching the destination control from the
directory `<select>` (max-content = its longest board name) to the short manual
host:port field drops max-content below the available width, so the rows were
measured in a box narrower than the one they would be given: the button run
wrapped, `#dest` (the row's only flex-grow item) ate the slack, and the widest
line came back SHORTER than the space available and was pinned there. The
measurement now runs at `controlsAvail()` — bar content width less the gap and
the scope's reserved `min-width`. **The cap must be the unrounded value**: a row
that exactly fills a fractional `avail` measures a hair under it, and flooring
the cap by that hair re-wraps the button run. That cost a round of work.

**4. `ATDT RANDOM`.** The parser stays pure — it returns `{k:'dial',
random:true}` and never names a board — and `drawRandomBBS()` is shared with the
dropdown's Random entry. It draws via `applyDialDest()`, so a draw made while
the manual field is showing puts the user back on the control that can display
the name. The echo is NOT suppressed here (it is for a typed destination),
because `connect()`'s own `ATDT host:port` line is the only place the drawn
board's address is named.

**5. Desktop scroll rail.** Not a browser scrollbar and cannot be: the terminal
is a canvas painted from a ring buffer, so there is no overflowing element to
attach one to. Driven straight off the ring, and updated from the three paths
that can move either number (a scroll, `feedTerminal`, `termEcho`) rather than
polled. `term.scrollbackOffset` counts BACK from live, which is why every
mapping is written against `length - offset`.

**6. `idleDisconnectMinutes` + `scrollbackLines` in config/site.json.** Idle is
measured on PAYLOAD in either direction and deliberately not on the audio: a
carrier is sent continuously whether or not anyone is typing, so an audio-based
timer would never fire. Armed at link-up, not at dial, so a 300 bps handshake is
never counted as silence. It takes a FRACTION of a minute — genuinely useful,
and what lets `idletest.js` run in seconds. Scrollback size reaches the browser
as a `{{SCROLLBACK}}` meta tag, read synchronously before the startup echo so
the ring is never resized under a live session. Both values have a meaningful 0,
so nothing on either path may use `||`.

---

## Session — the re-flow's other half: where the page starts

`public/terminal.js` + `tools/tests/reflowtest.js`. `vendor/` untouched, so
**no rebuild**.

The wrap-flag fix below made the JOIN correct. It left the screen's ORIGIN
wrong, and the two are independent: rebuilding the right logical lines says
nothing about which row of the display the page begins on. Reported twice with
before/after screenshots, and the first fix attempt failed in exactly the same
way as the one before it, because both looked only at the live buffer.

Two faults, one after the other:

- **The screen took the tail of the stream** (`split = out.length - rows`). A
  page occupying fewer logical lines than the screen has rows — every BBS page
  that ends above the last row — made the tail reach back into the ring for the
  difference. The page slid DOWN by the rows borrowed, with history above it,
  jammed against the bottom margin. Fixed by giving each line a `live` flag that
  travels through the unwrap join, and taking only those.
- **...which then exposed the reverse.** An 80-column page roughly doubles at 40,
  so it no longer fits and the top spills into the ring. That spill was being
  treated as history, so the wide pass rebuilt the page from its MIDDLE: header
  gone, everything sitting high, blank rows at the bottom. Reads as "scrolled
  up", and is the fault the second screenshot shows.

`_reflowPushed` closes it: `reflow()` records how many rows it spilled and the
next one reads exactly that many rows back off the end of the ring as screen
rows. The rows are still what the user is looking at; only their storage moved.
The claim is voided by `_doScrollUp`, `_doScrollDown`, `eraseDisplay(2)` and
`reset()` — anything that moves the page on — which is what stops it from
reintroducing the first fault. An echoed keystroke does not move the page, so
toggling the font after typing at a prompt still round-trips.

Not obvious from the code: the narrow pass has NOWHERE else to put the overflow.
The ring is the only storage a screen-sized buffer has, so the spill is not
avoidable and the only question is whether the terminal remembers that it was a
spill. It did not, and both failed attempts were attempts to derive the answer
from state that no longer contained it.

`reflowtest` gained the borrowed-history case, an overflowing round trip with its
own "the narrow screen really did spill" control, and the two claim-lifetime
cases (keystroke survives, scroll voids). Three fail on the first attempt at
this, four on pre-fix HEAD.

---

## Session — the 40 ⇄ 80 re-flow was really broken

`public/terminal.js` + `tools/{reflowtest,uitest}.js`. `vendor/` untouched, so
**no rebuild**.

Reported with before/after screenshots of a Worldgroup board: switching back to
80 columns scattered the header — the right-hand column of each line stranded at
column 0 of a row of its own. And it is **the same defect that the "known 40→80
flake" had been attributed to the cursor blink for several sessions**. Two
independent bugs were wearing each other as cover.

### The heuristic read evidence the code had already destroyed

`reflow()` had to decide which rows were continuations of the row above. Nothing
in a cell grid records that, so it used the conventional rule — a row that filled
its width exactly is a continuation — evaluated like this:

```js
for (const row of this._scrollback) lines.push({cells:trim(row),full:trim(row).length>=oldCols});
```

`trim` drops trailing blanks. So the test for "did this row reach the margin" was
applied to a row that had just had its right-hand end deleted. A wrap point
landing inside a run of SPACES therefore looked exactly like the end of a line.

Reproduced in eleven lines, with the control that names the mechanism:

```
logical (len 51): "BirdEnuf BBS - channel 1                thx 4    /_"
at 40 cols:  0: "BirdEnuf BBS - channel 1"
             1: "thx 4    /_"
after reflow to 80:
             0: "BirdEnuf BBS - channel 1"      <-- stranded
             1: "thx 4    /_"
control, 45 solid X's, wrap point on a printing character:
             0: "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"   <-- rejoins
```

That is the whole screenshot. The lines that survived in the user's "after" image
are the ones whose 40-column break happened to fall on a printing character —
`... on MS-` / `DOS` rejoined, `BirdEnuf BBS - channel 1` / `thx 4` did not. It
looked arbitrary because it *was* arbitrary, in a way that correlates with
nothing a reader would think to check.

**And column-aligned art is mostly spaces**, so for a BBS this is the common case
rather than an edge case. The old comment called the failure mode "rare" and
costed it at "one wrongly joined pair, never lost text". It was neither.

### The fix: record it

`_wrapped[]`, one flag per screen row, set in `putChar` at the moment the eager
wrap fires. Rows move — so the flags move with them, in `_doScrollUp`,
`_doScrollDown`, `insertLines` and `deleteLines` — and a flag must not outlive
the text it describes, so `eraseLine(0|2)` and `eraseDisplay(0|2)` clear it.
Scrollback snapshots carry the same fact as a `wrapped` property on the row
array, which keeps every existing consumer (`getDisplayCells`, `reflowtest`)
working unchanged.

**The second half of the fix is easy to miss and just as important: a wrapped row
is no longer trimmed.** Its trailing blanks are *interior* to the logical line —
they are the column alignment. Join without them and `'one' + 9 spaces + 'two'`
comes back as `onetwo`, which looks even more like a re-flow bug than the
stranded row did. Only the row that ENDS a logical line is trimmed.

Two consequences worth recording. The re-wrap now sets the flag on the rows it
creates (every chunk but the last of a logical line), so re-flow is idempotent
and a second switch is as correct as the first — which is also why the rebuilt
scrollback rows are padded to full width, since `slice(0, oldCols)` on a short
row would silently drop those interior blanks next time round. And the
flush-line-then-CRLF case still works for the same structural reason as before:
eager wrap sets the flag, the CRLF leaves a blank row, and the blank row is
absorbed as the (empty) continuation. The old note about that blank row possibly
scrolling out of the ring was moot — the ring drops its oldest entry first, so
the flush row always leaves before the blank one.

`reflowtest` gained the space-run case, the printing-character control, the
interior-blanks case, an 80→40→80 round trip on a screen shaped like the reported
one, and cases for flag travel through scrollback and flag staleness after an
erase. Four of them fail on the pre-fix code; the control passes on both, which
is what says the join did not simply break in general.

### The flake was the harness failing to keep its own rule

With the re-flow fixed, `40 -> 80 restores the original screen exactly` still
failed about one run in three. The diagnostic was to print the numbers rather
than reason about them: `lit 3066 -> 2836, diff -230, px identical`. 230 lit
pixels is one cursor block.

The blink rule in the file is correct — three samples spanning 700 ms cannot all
fall inside a 500 ms on-window. But the sampling was driven from Node, one
`page.evaluate` per shot with `waitForTimeout(350)` between them, and **each shot
serialised a ~455,000-entry array across the CDP boundary**. That overhead is
large and variable, so the real spacing drifted to ~600–700 ms and the span could
exceed a full 1000 ms period — at which point all three samples can land in
on-windows and the cursor survives the intersection.

So the rule was never wrong and the re-flow was never the cause. The interval
simply was not the interval. The three samples now run inside one
`page.evaluate` on the page's own clock, and only `{lit, hash, px}` crosses the
boundary — three numbers instead of three bitmaps, which also makes
`settledInk()`'s retries cheap. 5/5 clean runs.

A second, unrelated intermittent failure in the same file: the font-cycle check
awaited `document.fonts.ready` before reading the family list, but `ready`
resolves when the loads pending *at that moment* have settled, and the cycle
handler registers its `FontFace` asynchronously — so the await could return
before the new face had joined the set. Now polls for the family, which is the
fact under test, with a bounded timeout so a real failure stays a failure.

---

## Session — mobile full width, and the weight the outline lost

`public/main.js` + `public/fonts/index.js`, plus new cases in
`tools/{uitest,scaletest,ttftest,scalerendertest}.js`. `vendor/` untouched, so
**no rebuild**.

Two reported symptoms. Neither was where it looked, and the second turned out to
be a complaint about the *old* font rather than the new one.

### 1. "On mobile we don't quite reach the full width, on the 80-column fonts"

Measured first, across five phone viewports and all three fonts: the gap was 1–2
CSS pixels, consistently, and the 40-column font sometimes had none. That last
detail is the tell — same code path, different arithmetic — and it is what made
the report read as being about 80 columns.

**The number that shortened the width was the height.** `fitTerminal()` computed
an aspect-preserving `h = w / aspect` for the width it wanted, floored both to
whole device pixels, and handed the pair to `layout()` as the available box. But
`layout()` derives the height itself — FONTS.md §2.1's `pitchX = min(availW / C,
(availH / R) / cellRatio)` — so the floored `h` came back as the second term and
won:

```
availW = 390 * 3 = 1170        →  1170 / 80          = 14.625
h      = 390 / 1.347 = 289.4   →  floor 289 * 3 = 867
availH = 867                   →  (867 / 25) / 2.375 = 14.600   ← min
Dw     = round(80 * 14.600)    =  1168, not 1170
```

Two device pixels of width, bought with a fraction of a device pixel of height
that was rounded away before `layout()` ever saw it. Passing the true available
height instead makes the clamp fire only when height genuinely binds.

The second pixel was on the way out: `canvas.style.width = Math.floor(w)`. At a
fractional dpr `Dw / dpr` is fractional by construction, so flooring hands the
browser a display box narrower than the backing store — §3.1's failure mode, a
resample of the whole canvas, *plus* another pixel of black at the edge. A
fractional CSS width resolves to whole physical pixels (one of the probe's two
load-bearing questions, answered on a device), so `cssPx()` writes it exactly,
trimming trailing zeros so a whole number still reads as `1400px`.

Result at 390@3: gap 0.00. At 412@2.625 and 393@2.75: 0.2–0.3 CSS px, which is
half a device pixel — the `floor(availW * dpr)` residue, below which the box does
not exist.

**The test is the interesting part.** `uitest` §11 asserts full width to within
one **device** pixel — one CSS pixel of tolerance would have passed the bug — at
three viewports including two fractional dprs, on all three fonts, plus that the
backing store still equals the displayed box. Run against the pre-fix code as a
negative control it produces 17 failures, up to 2.75 device px short. A check
that only ever passes is not evidence.

`scaletest` now extracts `cssPx` from `main.js` by name alongside `hybridFit`
rather than re-implementing it, so a change to the rounding cannot pass a harness
carrying its own copy.

### 2. "The outline font is cleaner but reads thinner and slightly smaller"

The size half is an illusion: `outlineMetrics()` sets `fontSize = inkW * upem /
advance`, so the advance maps exactly onto `inkW` and the ink box is identical on
both paths. Thin strokes read as small. Nothing shrank.

The weight half is real, with two causes — and the first is that **the bitmap was
too bold**. The AST's stems are exactly one design pixel; at `inkW` 14 the scale
is 1.75, so a stem wants 1.75 device pixels. `buildMask(8, 14)` cannot express
that — `0,0,1,1,2,2,3,4,4,5,5,6,6,7`, six of eight source columns duplicated — so
a stem came out **2 device pixels fully lit in six cell positions out of eight**.
Measured against the same design as an outline: +4.4% ink mass at `inkW` 14,
+5.4% at 13. That is the §3.2 non-uniformity this font was chosen to escape,
showing up as boldness.

The second cause is a true deficit. Canvas composites in sRGB, non-linearly, so
for light ink on a dark ground a partial-coverage pixel lands well below its
coverage in perceived luminance — and 42% of this font's ink pixels at `inkW` 14
are partial, carrying 27% of its mass.

Both are answered by a gamma curve over the atlas **alpha**, which is exactly the
channel `_fgSheet()` masks a solid palette fill with. Monotonic, endpoints pinned
— so unlike a threshold at ≥1 it cannot dilate: no counter fills, no glyph grows,
and pass 1's graphics glyphs (already 0-or-255) are provably untouched, which is
what puts the box-join work structurally out of reach.

**Picking the value took three tries, and the first two were wrong in an
instructive way.** 1.45 restores mass parity with the bitmap and read as nothing.
1.8, the cautious midpoint, read as very nearly nothing. Mass parity is not
weight parity: the bitmap's ink is *entirely* full-strength pixels, where a third
of the outline's mass sits in partial ones that are being under-rendered.
Matching the number does not match the eye. **2.2 — the sRGB transfer exponent,
full linear-light correction — was confirmed on a device as "the boldness we had
prior, without the character distortion."** It is also the last value with a
derivation rather than a preference behind it, which is why `ttftest` bounds the
field there.

| `g` | total ink | partial px | |
|---|---|---|---|
| 1.45 | +5.3% | +19% | mass parity — invisible |
| 1.8 | +8.0% | +29% | midpoint — nearly invisible |
| 2.2 | +10.4% | +38% | ships |
| ∞ | +27% | — | dilation ceiling |

**The check that the mechanism was identified correctly**, rather than a curve
that happens to look better: at `inkW` 24 — an exact 3x of the 8-px design grid —
a pixel trace rasterizes with no partial coverage at all, so the curve is inert
and the atlas is bit-identical. The replication excess measures 0.3% there.
**Both numbers go to zero at the same scales.** A taste adjustment would have had
no reason to.

Scoped to `astpx8x19` by decision: Flexi has real curves, so its grey describes
shape and not merely sub-pixel position, and the 9x14 sits at a 40-column cell
nearly twice as wide. Both carry no field and take a *skipped pass*, asserted as
atlases that do not change by a byte.

### Two things checked and deliberately not changed

`ctx.imageSmoothingEnabled = true` in `buildOutlineFontSheet()` is a **no-op**
with a comment claiming otherwise: that context only ever does `putImageData`
(unaffected) and `fillText` (unaffected), and smoothing is a property of a
destination, so it cannot reach the atlas used as a `drawImage` source later.
Documented in FONTS.md §9 rather than deleted.

And the question behind all of it — is the letterform antialiasing avoidable?
Canvas 2D genuinely has no aliased-text mode, and that will not change. But that
is a limit on `fillText`, not on the pipeline: `deriveOutlineBitmap()` already
thresholds a rasterization, and applying the same cut at the device cell would
take ten lines. It is not *wanted*, because at a 14 px cell with an unhinted face
an aliased 1-bit glyph is a bitmap font with extra steps — stems land on whole
pixels only by accident. The crisp look needs an integer cell, which 40 columns
can reach and 80 cannot. → FONTS.md §5.3, §9.

---

## Session — the shades, a TTF 9x14, and two docs folded into one

`public/fonts/index.js` + `public/about.html` + three regenerated font assets and
one new one, a new offline tool (`tools/shadefix.py`), and new cases in
`tools/{ttftest,boxsheet,boxjointest}.js`. `vendor/` untouched, so **no rebuild**.

Reported as: the shade characters showing a black gutter between cells — the
half of the previous session's report that was fixed for line graphics and
missed for blocks.

### It was in the font data, and only nine-wide fonts had it

Not a scaling artefact, not the renderer, and not TTF-specific. Measured from the
`glyf` tables directly, the right-edge extent of every glyph in `0xB0`-`0xDF`:

| font | advance | glyphs ending short of the advance |
|---|---|---|
| Px437 AST PremiumExec (8-dot) | 800 | B3-BF, D9, DD |
| Flexi False A160 (9-dot) | 800 | **B0, B1, B2** + B3-BF, D9, DD |
| Flexi True (9-dot) | 675 | **B0, B1, B2** + B3-BF, D9, DD |

B3-BF/D9/DD ending short is correct and identical across all three — those are
`│ ┤ ╡ ╢ ╖ ╕ ╣ ║ ╗ ╝ ╜ ╛ ┐ ┘ ▌`, whose right arm genuinely does not extend
right. **The only difference between the eight-wide font and the nine-wide ones
is `0xB0`-`0xB2`**, and it is exactly one design column.

It is authentic hardware behaviour, faithfully preserved: IBM's 9-dot text mode
duplicates column 8 into the ninth dot only for `0xC0`-`0xDF`. Box drawing is in
that range and tiles; the shades are not and were drawn with a blank ninth
column. The same thing is in the `vga-9x14.js` ROM bitmap — per-column ink counts
over its 14 rows are `7,7,7,7,7,7,7,7,0` for ▒ against `14,...,14` for █.

An eight-wide font has no ninth column, so it never had the problem — which is
the whole reason it took a font swap to notice.

### Why the harness said everything was fine

`tools/boxsheet.js` said so in a comment: section 6 was *"by eye only, because a
shade is periodic by design and continuous is not what it should be"*. True of
the measure it had (the `solid` case, which fails on any background pixel) and
false as a conclusion — and the eye that looked was looking at the eight-wide
AST.

### Filling the ninth column is not the fix

The ROM patterns have x-period 2 (▒) and 4 (░, ▓), and neither divides 9.
Continue them into column 8 and the gutter becomes a *doubled* column instead —
rendered both ways, ▒ survives it but ░ and ▓ come out with pronounced vertical
banding.

The periods that tile a nine-wide cell are 1, 3 and 9. **Period 3 cannot make a
50% field**: a row of three is 0, 1, 2 or 3 dots, so 50% needs alternating 1/3
and 2/3 rows, which is horizontal banding traded for vertical. That leaves 9 —
the cell itself is the tile. Patterns and densities: FONTS.md §7.

Two choices in there were made on the render rather than on the arithmetic, and
both went against the number:

- **The phase drifts 2 columns per row, not 1.** A drift of 1 makes the
  per-column ink counts flattest (3 or 4 dots per column against 2 to 4) and is
  still wrong, because it puts every dot on the same 45° line and reads as
  diagonal stripes at seven cells wide.
- **▒ keeps the ROM checkerboard**, merely extended into column 8. A checkerboard
  on an odd-width cell must dislocate somewhere; measured, that dislocation is
  invisible where a black column is not.

### Then it came back on exactly one glyph, and that is the part worth keeping

After the re-pitch, ░ alone still gutterred. The glyph data was right — a python
rasterization of the patched `.ttf` gave column counts `2,4,2,4,3,3,3,3,4`, no
zero — but the atlas the browser derived read `0,2,4,2,4,3,3,3,3`: the same
pattern shifted one design column right, its last column pushed out of the cell.

`▌ ▐ │ ─ █` all derived correctly, which is what made it look font-specific
rather than glyph-specific.

**`hmtx` carries the left side bearing independently of `glyf`'s `xMin`, and a
rasterizer may position the glyph by the lsb phantom point.** ░ is the one shade
whose original outline starts a column in from the cell edge, so it is the one
shipping with a non-zero lsb — 100 units on the 9x14, 75 on True, 89 on the
A160. Redrawing it to reach the edge and calling `recalcBounds()` moved `xMin`
and left `hmtx` alone. ▒ and ▓ start at 0 either way and showed nothing.

One line in `shadefix.py`. `tools/ttftest.js` now asserts `lsb == xMin` on every
glyph of every outline font, not just the shades — the property is not about
shades and any glyph edit can do this.

### Two shade checks, and a positive control

The lesson from the previous session was that an exemption hides a defect, so
neither new check is "by eye":

- **`tools/ttftest.js` §9** rasterizes ░▒▓ on the font's own ROM pixel grid — not
  the registry `cellW`/`cellH`, which for an outline entry state an aspect and
  are 27x64 on `flexi135` — and applies two measures. Laying the cell beside a
  copy of itself must create no longer blank run (universal; the eight-wide AST
  passes it as a control). And on a nine-wide cell, no blank column at all,
  which is *derived* rather than arbitrary: the periods a shade lattice can use
  are 2 and 4, neither divides 9, so a blank column there cannot be part of a
  tiling lattice.
- **`tools/boxjointest.js`** gains `shade` cases. ▒ and ▓ ink every column of
  their cell in every font here, so a fully blank device column in a rendered run
  is a gutter and nothing else. ░ is gated to nine-wide fonts via a new `romCols`
  on each subject, because at eight columns its lattice legitimately blanks whole
  columns and still tiles.

And `vga9x14hr` — the untouched ROM bitmap, which was told to stay untouched — is
now the **positive control**: the harness asserts it STILL gutters. A check that
only ever passes is not evidence. If someone fixes `vga-9x14.js` the harness
fails and tells them to remove the flag.

### The 40-column slot is an outline font now

`vga9x14px`, VileR's Px437 trace of the same IBM VGA 9x14 ROM, shipped as-is with
no aspect transform — 900 units of advance on 1400 of cell, square design pixels
on a 9x14 grid, so 40x25 lands at the 360x350 that ties the column count to this
font. Same call as the AST outline and for the same reason (FONTS.md §5.4), with
a larger margin: a 40-column cell is twice as wide, so the hybrid path's
replication error is twice the size.

`vga9x14hr` is hidden rather than deleted — it is the bitmap arm of that
comparison, the only 9-wide bitmap on the hybrid path, and now the shade control.

### Three font entries deleted

`prc8x19`, `ast8x19` and the orphaned `igs-vga-8x19.js`, with their data modules.
The test for whether a hidden entry earns its place is whether it has a **stated
job** — `vga8x16` is `FALLBACK_FONT_ID`, `vga9x14`/`vga9x14hr` are reference arms
and the stride/shade exercise. These three had none: PRC19 was never a reference
for anything (its `0xB2` is a diagonal rather than the classic checkerboard,
which is both what ruled it out and what would have made it a poor comparison
arm), the AST bitmap's A/B was long settled and written up, and the IGS module
was not even imported.

One consequence worth knowing: no 8x19 bitmap is left, so `tools/scaletest.js`'s
8x19 layout arithmetic now uses a **synthesised** cell rather than a registry
entry. `layout()` cannot be handed the surviving 8x19 *outline* in its place —
it probes glyph bytes to find the advance column, and an outline entry has none
until `deriveOutlineBitmap()` has run in a browser. Every expected number in that
file is unchanged, and the arithmetic is now independent of the registry, which
is what it should always have been: the layout maths is about a cell, not a
typeface.

Font preferences degrade gracefully, which is what made the deletions cheap:
persistence is a single `fontId` in localStorage and `fontById()` falls back to
`DEFAULT_FONT_ID` — not to `FONTS[0]`, and not to an error — so a stale id lands
on the font a new visitor would get.

### The last "unmeasured" item was mostly already answered

The forward list had been carrying "point `tools/probe.html` at the aspect-scaled
Flexi" as the one open question in the font work. Two corrections, both of which
downgrade it:

**The probe already ran on a real device, in an earlier session, and both of its
questions PASSED** — a fractional CSS width resolves to the intended physical
pixels, and canvas `fillText` does apply grid-fitting. That run is what led to
implementing the TTF path at all. The doc had been carrying it as open because
the *derivative* file did not exist yet when the probe ran.

**And hinting is not the thing that is load-bearing anyway.** The comparison that
chose the font lineup was won by files with **no hinting whatsoever**:
`astpx8x19` and `vga9x14px` are `gasp` = 2 with no `fpgm` and no `prep` and not
one off-curve point, and they beat both bitmap paths on a device. What an outline
buys here is *rasterized once at the target size*, not *hinted* — which is
exactly what the amended rule in FONTS.md §5.4 says, stated in terms of the path
rather than the file.

So the worst case for the 8/9 derivative is "hinted no better than a pixel
trace", and a pixel trace is already the winner. A headless A/B at matched pitch
(native False vs A160 vs True, horizontal scanline through `H` above the
crossbar, since X is the axis the transform touched) is consistent with a small
real cost and nothing more: the derivative is 89% and 92% solid across its stem
width at two pitches where both native variants reach 100%, and identical to them
at the other two. Worth confirming on a device; not worth carrying as a risk.
FONTS.md §6.3 and §9 say so now instead of calling it unmeasured.

### Slot order changed, and the default did not follow it — briefly

The Aa cycle was reordered to **Pixel, Modern, Squat** ("40 Column" renamed;
"Squat" names the cell rather than the column count, which the toast states
beside it anyway). `DEFAULT_FONT_ID` was left on Modern, and a `scaletest`
assertion that the default *is* slot 0 was **weakened** to "the default is
reachable from the cycle" to make the suite pass.

That was the wrong call twice over: it shipped a fresh visit that starts on the
middle slot, so the first press skips Pixel entirely and a three-press lap does
not return you to where you started — and the weakened assertion passes for
exactly that broken arrangement, which is what a test is supposed to prevent.
Caught on a fresh incognito load, not by the suite.

**The rule, now written down in FONTS.md §5.3 and enforced on both devices:**
`DEFAULT_FONT_ID` names slot 0, because the button cycles forward only.
Reordering the cycle *is* a decision to change the default; move both together.

Two consequences of the default becoming Pixel:

- **No entry carries `mobileDefault` any more.** It was on `flexi135`, from when
  "Modern" was slot 0 and the two devices therefore started on different files.
  Pixel is one file at one cell everywhere, so both devices start on the same
  font. The flag and `mobileDefaultFont()` survive for a future slot 0 that
  substitutes by width; nothing sets it, and `ttftest` asserts nothing does.
- **`uitest`'s "Modern is a different file on a phone" check needs a press
  first**, since a fresh visit no longer lands on that slot. That turned out to
  improve it: the check used to read the TOOLTIP, which was the one place both
  the slot label and the file name appeared. The tooltip now says exactly what
  the toast says — one name for the thing you just picked, not two — so the
  check reads `document.fonts` instead and asserts the browser actually
  registered `Flexi IBM VGA True 437` rather than `...False A160 437`. A tooltip
  proves a string was written; a registered family proves the file was fetched.

### TTF.md and HYBRIDRATIOFONTSCALE.md are gone; FONTS.md replaces both

Both were written as **designs for work that had not been done yet** — "Status:
design only. Nothing implements this" at the top of one, "a proposal, not
shipped code" in the other — and they had spent several sessions accreting
"update:" and "since resolved:" paragraphs on top of that framing. Two documents
describing an app that no longer existed, cross-referencing each other's section
numbers, with roughly a hundred references into them from code comments.

`FONTS.md` is one reference doc in the present tense, sitting in the doc map
where PROTOCOLS.md sits for modems: the layout arithmetic, the two render paths,
the classifier, the aspect policy, the nine-wide shade rule, the offline tools,
and a table of which harness owns what. The *narrative* — what was tried, what
was measured, what was wrong — stayed here, which is where narrative belongs and
is why those docs kept growing sideways in the first place.

All ~100 code references were rewritten to the new section numbers, and nothing
in the repo mentions either old file.

---

## Session — box-drawing characters did not join, and why nothing caught it

`public/{fontscale,renderer}.js` + `public/fonts/index.js`, plus a new harness
(`tools/{boxsheet,boxjointest}.js`); `vendor/` untouched, so **no rebuild**.

Reported as: line-graphics corners not lining up with the horizontals and
verticals they meet, and small gaps between block characters — on the outline
fonts, with no way to test it unscaled.

### The bug

`classifyStretch()` decided which glyphs get the hard-edged, grid-aligned path
and which get drawn as letterforms. Its predicate was **"the ink spans the whole
cell on this axis"**. That is true of `─`, `│`, `┼` and `█` — and false of
**every corner and every tee**, because `┌` inks half of one row and half of one
column and so spans neither axis.

Corners therefore classified as letterforms. On an outline font a letterform is
drawn with `fillText`: antialiased, and positioned by the rasterizer rather than
by the design grid. So every corner in CP437 was a *different rasterization of
the same stroke* from the `─` and `│` it had to meet, and the two did not land in
the same place. That is the misalignment. The soft seams beside it were the same
cause seen the other way — `fillText`'s grey edge pixels against the threshold's
hard ones.

Two things it was not, and both were ruled out by measurement rather than by
argument, because the report explicitly asked whether scaling was involved:

- **Not scaling.** It reproduces at a device width that is an exact multiple of
  the column count, where §1.3's residue is zero and every cell rect is exactly
  `inkW` wide. That size is now one of the three the harness runs, and it exists
  precisely to be the control.
- **Not TTF-specific**, though it presented that way. The 9x14 bitmap on the
  hybrid path had the identical misclassification and the identical gaps; with no
  antialiasing it produced a notch rather than a notch *and* a soft seam, which
  is less noticeable and was never reported.

### Why the existing tests passed throughout

`scalerendertest.js` asserted that `0xC4` is continuous across a row and that
`0xDB` tiles. Both are true, and both were true throughout the defect — they are
two of the four characters the old predicate handles correctly.
`scaletest.js` §1.4 asserted the classification of the same four. The sample WAS
the bug's blind spot: every character anyone had thought to test was in the set
the predicate got right.

The lesson worth keeping is not "add more codepoints". It is that a property
which depends on a glyph's NEIGHBOUR cannot be tested one glyph at a time, and
the four representatives were each tested alone. `tools/boxsheet.js` is built out
of adjacency for that reason — every junction character sits between the strokes
it has to meet.

### The fix, in two parts

**1. The predicate.** A glyph joins if it is in CP437's `0xB0`-`0xDF` graphics
range, or has a fully inked row or column; and then the per-axis flags come from
**edge contact** rather than from spanning.

Edge contact alone does not work, and this is worth recording because it is the
obvious first attempt: in a CP437 ROM font the advance space is the right-hand
column only, so letterforms routinely ink column 0. Measured, "touches either
edge" flags 199 of 256 glyphs on the AST 8x19 bitmap — `A`, `g` and `x` included.
Hence the two-part rule.

The full-row/full-column clause also has to be about a **row**, not a bounding
box. The bbox is the union of every row, and `J` in the AST bitmap inks column 7
on its top bar and column 0 on its tail: its bbox spans the cell though no row of
it is solid. It was the only letter in any of the repo's fonts to do it, and it
was enough to put `J` on the graphics path — caught by the new "not one A-Z or
a-z glyph is flagged" assertion, which is there for exactly this.

A codepoint range is a tabulated constant, which FONTS.md §-1's
reusability contract otherwise forbids. It earns the exception because it is a
property of CP437 — the encoding every font in the registry is in — rather than
of any font; the full-row clause beside it covers a face drawing outside it.

**2. Edge extension instead of stretching.** The residue (§1.3) makes a cell rect
`inkW` or `inkW+1` wide while an atlas cell was `inkW`, and the old scheme covered
the difference by *scaling* flagged glyphs to the cell rect. That covers the gap
but resamples the glyph, and nearest-neighbour from `inkW` to `inkW+1` duplicates
an arbitrary **interior** column — so a `┼` came out with its vertical bar a pixel
away from the `│` above it. The cure was a milder case of the disease.

The atlas is now built one column and one row larger, the extra one repeating the
glyph's own last, and the blit takes its source size from the destination rect. So
**every blit is 1:1 on both axes** — nothing is resampled anywhere on the hybrid
path any more. A glyph whose ink reaches the cell edge keeps reaching it because
the extension is more of the same ink; a letterform's extension is a copy of its
blank advance column, so the residue still reads as tracking, exactly as before.

`STRETCH_X`/`STRETCH_Y` survive with their meaning changed — they no longer say
"scale this axis", they say "this glyph joins on this axis", which is what decides
the hard path.

### The harness

`tools/boxsheet.js` builds the sheet: single, double and both mixed line families
as 3x3 grids of boxes sharing every edge (so every junction sits between its
strokes), long runs to catch anything that accumulates, block and half-block
fills, and the three shades. It also writes `tools/out/boxsheet.ans` as raw CP437
bytes, for looking at on a real board.

`tools/boxjointest.js` renders it through the real stack for all four shipping
fonts at three sizes and measures two things separately: **gaps** (a background
pixel inside a stroke) and **soft** (a partially-covered pixel where the glyph
should be solid — the `fillText` seam, which only an outline font can have).

One methodology trap, which cost a round of false positives: a double-line corner
has a **designed** hole in it — `╔` is two strokes meeting with an empty square
between them — so counting every background pixel between the first and last ink
of a stroke row condemns the entire double-line alphabet. The discriminator is the
cell boundary: a designed notch lives inside one glyph and contains no boundary,
while a join failure is by definition centred on one. So a background run counts
only if a cell edge falls inside it.

Verified as a regression test by reverting the predicate and watching it fail
(16-18 broken cases per font per size), then restoring it (0).

### Result

All four shipping fonts, all three sizes: zero gaps, zero soft pixels. Before and
after PNGs are in `tools/out/`.

---

## Session — three outline fonts, and the font lineup that came out of testing them

`public/fonts/index.js`, `public/{main,renderer,about}.{js,html}`, three new
`.woff2` assets, two new offline generators in `tools/`, and five harnesses;
`vendor/` untouched, so **no rebuild**.

Two halves. The first added Flexi IBM VGA True, an aspect-scaled Flexi False,
and an outline of the AST PremiumExec face, alongside a hybrid-path variant of
the 40-column 9x14. The second was the user testing all of them on a phone and
reorganising the lineup around what won — which included overturning a rule
FONTS.md had stated with some confidence.

### The AST outline beat both bitmap paths, and FONTS.md §5.4 was wrong

`Px437_AST_PremiumExec.ttf` is a pixel trace of `ast-premiumexec-8x19.js`: zero
off-curve points in 6,726, no `fpgm`, no `prep`, `gasp` = 2. FONTS.md §5.4's rule —
"an outline earns its place only if it carries information the bitmap does not"
— excludes it outright, and excludes VileR's IGS trace for the same reasons.

It shipped anyway, as the third arm of a controlled comparison: the same glyph
data on the legacy path (`ast8x19`), on the hybrid path (`ast8x19hr`), and as an
outline, so the only variable between the three was how the letterform reached
the screen. On a phone the outline won clearly — more consistent glyphs, more
readable — and the other two arms have since been hidden and removed.

The mechanism is FONTS.md §3.2, which accepted a cost it should have
flagged as decisive. The hybrid path upscales an 8-px source to the device pitch
by nearest-neighbour replication through a fixed mask; at `inkW` 13 that mask is
`2,2,2,1,2,2,1,1`, so a stem is 1 or 2 device pixels **depending on where in the
cell it falls**, and a letterform's internal proportions are distorted by up to a
whole pixel. An outline is rasterized once at the actual target size: every stem
gets the same treatment, and antialiasing spends grey pixels on sub-pixel
*position* even where there is no curve — exactly the information replication
throws away.

So the trace carries no extra information in the *file*; it carries it in the
*rasterizer*. §5 asked what the file contains when the question was what happens
on the way to the screen. The amended rule is in FONTS.md §5.4: an outline earns
its place if it carries information the bitmap does not, **or if it reaches the
screen by a better path than the bitmap can**. The next consequence is already
queued — the 9x14 backing 40-column mode is the remaining bitmap on the hybrid
path, and a 40-column cell is twice as wide, so the replication error is twice
the size.

### The cell-aspect invariant, which the second outline font exposed

For a `kind: 'ttf'` entry the registry's `cellW`/`cellH` are not pixels. They
state the cell's **aspect** and the resolution `deriveOutlineBitmap()` rasterizes
at. `layout()` sizes the atlas cell from `cellH/cellW`; `outlineMetrics()`
typesets into a cell of `(ascent + descent)/advance`. Unless those are equal
every glyph is mispositioned in its cell — undistorted, so it still looks like a
font, just wrong — and nothing throws.

Flexi False got 9x16 for free, because 900:1600 reduces to it and its design
pixels are square. The others do not:

| entry | design grid | why |
|---|---|---|
| Flexi False 1.60 | 16x32 | 1600:800 reduces to 1:2, far too coarse to rasterize on; 16x32 also keeps a one-column stem near 1.8 raster px, where 8x16 would put it at 0.89 and it could threshold away — for a box-drawing glyph that means it stops classifying as a full-cell stretch glyph and starts showing a seam |
| Flexi True | 27x64 | 675:1600 reduces **exactly** to 27:64 (675·64 == 27·1600) — three raster px per design column, four per row, the smallest square-pixel grid representing its 75-by-100-unit cell. 9x16 would present it at False's 1.800 and stretch the face |
| AST outline | 8x19 | 100 units per row *and* column — the only one whose required ratio is the face's own pixel grid, because that grid is square |

`ttftest` asserts it as exact integers for every outline entry;
`scalerendertest` observes the same fact on a real rasterizer by measuring where
the baseline falls in the cell. That second check was written weak at first — it
looked for ink spilling below the cell, which a wrong grid does not produce
because the atlas canvas clips it. Measuring the baseline *position* catches it;
verified by breaking True's `cellH` deliberately and watching it fail.

### The offline aspect transform

Flexi False at its native 1.800 is too wide to read at any size, and neither
shipped variant is 1.600. FONTS.md §6.2 says the aspect knob is the file, not the
renderer — so a file was made. `tools/fontaspect.py` scales every X coordinate
8/9, the `hmtx` advance and side bearings with it, and `cvt[32]`/`cvt[33]` (the
X-axis stem-width control, identified because VileR's own False/True pair differs
there by exactly the advance ratio) 200 → 178; every Y coordinate is left
bit-identical. A new family name is non-negotiable — the browser keys a loaded
`FontFace` by family string and two files sharing one collide in
`document.fonts`.

This is not the transform §6 rules out. That prohibition is on a non-uniform
transform at *draw* time, which grid-fits once and then stretches the result;
here the geometry is correct before the rasterizer sees it. The honest limit is
that `fpgm`/`prep`/per-glyph instructions are copied through unchanged, so the
file is hinted *approximately* — VileR re-authored the hinting for each of his
variants. Whether the stems still snap is a `tools/probe.html` measurement and
has not been made.

`ttftest` parses both files' `glyf` tables and compares them point for point:
18,952 points, every Y equal, every X the rounded 8/9, `cvt` 32/33 the only
control values that moved. That is why the native False `.ttf` has to stay in
`tools/datasource` even though the font no longer ships — it is both the
regeneration input and what the check compares against.

**A woff2 trap worth knowing.** woff2's header carries `totalSfntSize`, and
`ttftest` asserts it equals the source `.ttf`'s byte length — the tie that
catches a stale woff2. It does not hold automatically: the optional glyf/loca
transform is lossless in outline terms but not in table *padding*, and for a
`.ttf` fontTools itself recompiled the writer over-reports by 236 bytes.
`emit_woff2()` tries the transform, keeps it only if the tie holds, and otherwise
falls back to the untransformed encoding — ~10% larger, still under half the ttf.

### Three named slots, not a list of fonts

The Aa button now offers **Modern**, **Pixel** and **40 Column**. The first is a
different file per device: Flexi False 1.60 on a desktop, Flexi True on a phone.

That could have been two visible entries. It is one slot with a `mobileAltId`
because they are not alternatives a user picks between — they are one choice
whose right answer depends on the screen, and offering both would put a font on
each device that is known to be the worse one there. `cycleFonts(mobile)` is the
only reader.

The contract main.js depends on: **the cycle is the same length and order on
every device**, and only the font behind a slot changes. `fontIndex` is an index
into a *slot*, so it survives a rotation. Crossing the breakpoint therefore has
two behaviours, not one — with no preference expressed, re-pick the device
default outright; with a preference expressed, hold the index and re-resolve the
font behind it, because what the user chose was "Modern", not a file. The
re-resolved font is deliberately **not** persisted: which variant a rotation
lands on is our decision, and writing it would pin them to whichever was active
when they last turned the phone.

Three smaller consequences, each of which would have been a quiet bug:

- **`updateFontUI()` reads `activeFont`, not `currentFont()`.** They agree except
  when an outline font's file fails to load and the renderer falls back to a
  bitmap that is not in the cycle — exactly when the button most needs to name
  what is actually on screen. `fontIndex` is left pointing at the slot that
  failed, so the next press advances past it instead of retrying the bad file.
- **The lit state compares against the *device* default.** A single
  `DEFAULT_FONT_ID` comparison would have left every phone permanently lit.
- **`fontById()` falls back to the DEFAULT, not `FONTS[0]`.** Those used to be
  the same entry. Position 0 is now the hidden bitmap fallback, and a preference
  naming a removed font must land where a new visitor lands.

### FALLBACK_FONT_ID: the default is an outline font now

`renderer.js` used to fall back to `DEFAULT_FONT_ID` when a woff2 would not load,
which was safe only because the default was a bitmap. With an outline default
that is a regress — answering "a woff2 did not arrive" with another woff2 can
fail identically, and on a device where the network is the problem it ends in a
blank terminal. Hence a separate `FALLBACK_FONT_ID` pointing at a hidden bitmap
entry on the *legacy* path, so a broken hybrid layout still renders something.

This is what `hidden` now means in the registry: not dead code. The four legacy
bitmaps are all hidden, one of them is load-bearing, and `fonttest` asserts its
existence, that it is a bitmap, and that it is not the default — so deleting it
fails a test rather than shipping.

Note the accepted cost of an outline default: **first paint waits on a network
fetch.** A fresh visit draws backgrounds only until the woff2 lands. That is
FONTS.md §5.3's prescribed behaviour (a correctly-shaped blank terminal beats a
wrong-metric one) but it is a new characteristic of startup.

### The 600 ms blink-sampling rule was wrong

CLAUDE.md said any pixel-hash in `uitest` must sample twice ~600 ms apart and
intersect, to drop the blinking cursor. The 40→80 round-trip assertion was
recorded as "a known flake that predates the rule". It was not a flake; the rule
is arithmetically wrong. The cursor is lit 500 ms of every 1000, and 600 ms is
longer than the on-window but shorter than the period — a pair starting late in
an on-window (t=450, t=1050) catches **two lit frames** and the cursor survives
the intersection. Instrumented, it failed about one run in three, always as two
stable hashes exactly 276 lit pixels apart: one cursor block.

Three samples spanning 700 ms cannot all be lit, because the on-window is only
500 ms. The general rule is that **the span must exceed the ON time, not the
period**. Fixed, and four consecutive runs produced byte-identical hashes.

Separately and additionally: an outline font's atlas is built asynchronously and
rebuilt on a layout change, so a reading taken across a rebuild catches a
half-painted screen. `settledInk()` takes readings until two agree.

### Harness re-pointing

Removing IGS and the AST hybrid took the last 80-column bitmap off the hybrid
path, which several harnesses were built on:

- `scaletest` used IGS as its 8x19 arithmetic subject. Re-pointed at the AST
  bitmap — same cell, so every number is unchanged — and deliberately at a
  *hidden* font, which keeps the arithmetic independent of what is in the UI.
- `scalerendertest`'s bitmap-hybrid block now runs the 9x14 at 40 columns, the
  only bitmap left on that path. 1080/40 is an exact 3x, so the fractional-scale
  case moved to the 40-column A/B sweep and the outline block.
- The `ast8x19` / `ast8x19hr` A/B blocks are gone; the `vga9x14` / `vga9x14hr`
  pair replaces them and is the reference for judging the TTF 9x14 to come.
- `uitest`'s 40-column assertions read the column count from the toast instead of
  from a literal 360x350, which is a legacy-path number.

---

## Session — hybrid glyph scaling + outline (TTF) fonts

`public/{fontscale.js,renderer.js,main.js}`, `public/fonts/{index.js,cp437.js}`,
a shipped `.woff2`, and `tools/{scaletest,scalerendertest,ttftest,probe.html}`;
`vendor/` untouched, so **no rebuild**. Implements FONTS.md and
FONTS.md, which were design-only. Three fonts added: IGS VGA 8×19, AST
PremiumExec 8×19 (hybrid), Flexi IBM VGA False. Only the non-obvious is here.

### `document.fonts.check()` cannot tell you a font is loaded

It returns **true for a family that does not exist**, because it answers "would
every font needed to render this be ready" and the *fallback* is ready. Used as
an "already resident?" shortcut it skips the fetch entirely and hands the
terminal a system font — which is precisely the failure FONTS.md §5.3 exists to
prevent, arriving through the call meant to prevent it.

Symptom, if it ever comes back: Flexi's 9-unit advance measures **11.55 px at
fontSize 16** instead of 9, glyphs overflow into their neighbours' cells, and
*every* glyph therefore classifies as full-cell and renders through the stretch
path. The text still looks like text. Nothing throws.

`loadOutlineFont()` now gates on **measurement** — `measureText` on two
different characters must equal `fontSize * advance/upem` within 2%. That is the
only check that actually answers "is the browser typesetting with THIS font's
metrics", and it also catches a file that loads fine but whose metrics have
drifted from what the registry declares.

### Two paths, and the one branch that separates them

`scale: 'hybrid'` on a registry entry is the entire opt-in; `renderer.js`
checks it in exactly one place (`_blitCell`) and nothing else decides. The four
original fonts are byte-for-byte unaffected — verified by rendering a full frame
(all 256 glyphs, 16 colours, bold, cursor, selection) through both a pristine
checkout and this one and comparing pixel hashes. **Keep that property when
touching the renderer**: `git diff` on `renderer.js` should still show one
deleted line, the import.

The bitmap path pre-composites fg-over-bg into one tinted sheet per *colour
pair*; the hybrid path cannot, because a cell rect is `inkW` or `inkW+1` device
pixels and that 0-or-1 px residue is tracking the background must cover and the
glyph must not. So it fills the background and blits an **fg-only** atlas over
it — 16 tinted sheets instead of 256, which matters because these are
device-sized (an atlas is 6144 px wide at inkW 24).

### Aspect: the font owns it, and §3.4's derivation is deliberately unused

`PIXEL_ASPECT = 1.0`, hardcoded. §3.4 derives a correction from a global
`targetAspect`, but that machinery is for correcting an **uncorrected**
square-pixel bitmap at render time, and neither new font is uncorrected: IGS's
16→19 row resample *is* its 1.2× correction, and Flexi False is the square-pixel
variant (900×1600 units on a 9×16 grid). Applying §3.4 to either double-corrects
— and on a hinted outline it is ruled out outright by FONTS.md §6.2, because a
non-uniform transform grid-fits at one size and then scales the result, so stems
snapped to whole pixels stop being whole pixels. `pixelAspect()` is still
exported and tested; it is the tool a future uncorrected font would need.

**What §6 does and does not forbid**, since it is easy to over-read: it rules
out a non-uniform `setTransform` at DRAW time, because that grid-fits the glyph
at one size and then scales the raster, so stems snapped to whole pixels stop
being whole pixels. It does not rule out changing an outline font's aspect —
its own rule is *"the aspect knob on the TTF path is the file, not the
renderer."* Rewriting a font's X coordinates and advance OFFLINE and shipping
that file is operating the knob exactly as prescribed, and the pipeline needs no
change at all: `fontSize` is derived from `advance`/`upem`, so a correctly
re-metricked file simply works.

The arithmetic is trivial because `ascent + descent` equals `upem` (1600) for
this face, making the 80×25 terminal aspect just `80 · advance / (25 · 1600)`:
advance 900 → 1.800 (False), 800 → 1.600 (the IBM 8×16 ratio), 675 → 1.350
(True). The `cvt` stem-width entries 32/33 track the same ratio — 200 in False,
150 in True, exactly 0.75 — so they must be scaled alongside the coordinates or
the hinting will be asking for stem widths the outlines no longer have.

Two caveats if a variant is ever generated mechanically: VileR **re-fitted**
each variant rather than scaling it (only about half of True's points land on
0.75 × False's, and the per-glyph instruction streams differ in length), and a
scale like 8/9 lands the columns on a non-round unit grid where False and True
use round 100 and 75. Neither breaks anything by itself, but both mean the
result should go through `tools/probe.html` to confirm the stems still snap,
rather than being assumed equivalent to a hand-fitted variant.

### The resize debounce is not optional

An atlas rebuild is ~18 ms at a 1920-px terminal, ~110 ms including the re-tint
on the next frame, and `resize` fires dozens of times per second during a drag.
`hybridFit()` in `main.js` defers the rebuild 120 ms and lets CSS stretch the
existing atlas meanwhile — which is only what the legacy path does permanently.

**The load-bearing half is the snap-back after settling.** Deferring the rebuild
but forgetting to re-fit the CSS box leaves backing store and displayed box
disagreeing, the browser resamples, and the entire scheme goes inert with no
visible symptom (FONTS.md §1). First layout and font changes
deliberately do NOT wait — there is no atlas to stretch in either case.

### Outline stretch glyphs come from a thresholded bitmap, not from fillText

FONTS.md §5.3 requires blocks, shades and box drawing to bypass `fillText`: their
edges antialias at a fractional cell size and adjacent cells seam. Rather than
enumerate CP437 ranges, `deriveOutlineBitmap()` rasterizes the outline onto its
own 9×16 design grid, thresholds at 50 % coverage, and hands the result to the
**same derived `classifyStretch()` the bitmap path uses** — one definition of
"spans the cell", nothing checked in to drift. That thresholded bitmap is also
what those glyphs are drawn from, which is how they get hard edges that tile.

Atlas build order matters: stretch glyphs go in first as raw pixels via
`putImageData`, *then* letterforms via `fillText`. Reversing it erases the text —
`putImageData` overwrites rather than composites.

### Antialiasing is measured in RGB, never in alpha

The cell background is an opaque `fillRect`, so once a glyph is composited over
it **every pixel in the cell has alpha 255**. An alpha histogram reports "no
smoothing" for a fully antialiased glyph. Both the "bitmap path has no AA" and
the "outline path does have AA" assertions were passing/failing for this reason
before being switched to sample the colour channel. Any future pixel assertion
about smoothing must do the same.

### Harness notes

`tools/scaletest.js` extracts `hybridFit` from `main.js` **by name**, like
`attest.js` does — rename it and the extraction throws rather than testing a
stale copy. It also exercises the §3.2 blank-column guard against a *synthetic*
font: no shipped font has a font-wide blank column 7 (box drawing reaches it by
design), so the shipped data cannot reach that branch, and an unexercised guard
is not a guard.

`tools/uitest.js` must serve `.woff2` as `font/woff2`. Served as `text/plain`
the FontFace load fails, the §3.4 bitmap fallback correctly fires, and the
"40 → 80 restores the original screen" round trip then fails for a reason that
has nothing to do with re-flow. Two other uitest assertions were rewritten this
session: a literal `640` for "80 columns" stops being meaningful once a font
sizes its backing store in device pixels, and the round trip must cycle until
the *starting* font returns rather than assuming one press does it.

`tools/fonttest.js` is bitmap-only and skips `kind: 'ttf'`. `fontStride()`
**throws** for an outline entry rather than returning a plausible 1 — a wrong
stride renders convincing garbage instead of failing.

`tools/probe.html` is the §3.8 / §4 device probe. Run it over HTTP (a `file://`
URL blocks the `@font-face` load) before trusting either scheme on new hardware;
it includes a hand-drawn `fillRect` control so a mis-sized canvas can be told
from a genuine failure.

---

## Session — typed AT commands (offline command line)

`public/main.js` + new `tools/{attest,atuitest}.js`; `vendor/` untouched, so
**no rebuild**. Only the non-obvious parts are recorded.

### One input funnel, not two

Command mode is `!carrier && !dialing`, and the whole feature hangs off a single
branch at the top of `modemWrite()`. Both input paths already converge there —
the physical keyboard via `onKey`, the on-screen keyboard via `keySeq`, plus
`term.onSend` — so hooking `modemWrite` means the on-screen keyboard types AT
commands for free and the two paths cannot drift. Adding a second hook in the
keyboard code was the obvious route and would have been the bug: `namedSeq`/
`ctrlChar` stay the single source of truth for *what bytes a key sends*, and
this change only alters *where those bytes go*.

`dialing` is excluded deliberately. Between Connect and carrier the line is
neither idle nor up; keys are swallowed exactly as they were before.

### The key handler consumes only what the command line took

`onKey` used to `return` early with no carrier. It now calls `atInput(seq)` and
`preventDefault()`s **only if that returned true**. Otherwise every arrow key,
PageUp and F-key would be swallowed while idle and the browser's own scrolling
would stop working on a page that isn't even connected.

`atInput` drops any sequence starting with ESC outright rather than treating ESC
as line-cancel. F1 sends `ESC O P`; cancelling on the ESC leaves `OP` typed into
the line, which looks like the terminal inventing characters. CR/LF both end the
line, with an `atSawCR` flag so a CRLF pair is one ending and not two.

### Focus: the new path is guarded, the old one deliberately isn't

The window-level `keydown` forwards to `onKey` when focus is off-canvas. Command
mode is allowed through that route (so you can type `ATDT` without clicking the
terminal first) but only via `isFormField()` — otherwise typing in the manual
`host:port` field would run as commands and the field would be unusable. The
pre-existing behaviour for a **live carrier** is unchanged and still forwards
from a focused form field; that quirk predates this work and was left alone
rather than folded into the same guard, which would have been an unrelated
behaviour change smuggled in under a new feature.

### `MS_COMMANDS` is the only speed table, and that has a cost

`AT+MS=` is resolved by splitting the typed fields on commas and matching them
as a **prefix of an existing `MS_COMMANDS` value** — there is no second table of
accepted commands. That is what makes `AT+MS=V34`, `V34,0`, `V34,0,33600` and
the full form all mean one thing while `V32,0,4800` means nothing, without
anyone maintaining a list of legal abbreviations.

Two couplings fall out of it, both real:

- A prefix matching several entries (bare `V34`) resolves to **the last hit**,
  i.e. the fastest. That depends on `MS_COMMANDS` being written in menu order,
  ascending within a family. It is the same rule a bare `v34` follows in a
  shared link, so the two agree by construction — but reorder the object and
  `AT+MS=V34` silently starts meaning 28800.
- A menu entry with no `MS_COMMANDS` row now makes `AT+MS=<it>` answer `ERROR`,
  where before it only skipped a cosmetic echo. `tools/attest.js` asserts every
  `<option>` except `direct` has a row, so the omission fails a test instead of
  shipping. `direct` has no row on purpose: `+MS` selects a *modulation* and
  bypass has none — it gets `ATZ` instead.

### Dial, echo, and result codes

A typed `ATDT` calls `connect({ echoDial: false })`; `connect()` otherwise echoes
its own `ATDT host:port` line and the user's typed line would be duplicated. The
`dialBtn` listener is a zero-arg arrow, so no click event leaks into `opts`.

Destination display follows the shared-link rule already in `loadBBS()`: a board
in the directory selects there, one that isn't switches to the manual field,
which is the only control that can show it. The **destination** is persisted
(the user chose it); the **display mode** is not.

Every command answers a result code except a bare CR, which answers nothing —
what a real modem does, and it keeps Enter-mashing from filling the screen with
`OK`. The one asymmetry: the GUI bypass echo has no `OK` (unchanged from before),
the typed `ATZ` adds one, because a typed command with no result code reads as a
hung terminal.

### Harness traps

`tools/attest.js` is the grammar, `tools/atuitest.js` the wiring; both extract
from `public/main.js` by name, so a rename throws rather than testing a stale
copy. `attest.js` cross-checks `AT_NOOP_TOKENS` against `MODEM_INIT` — the
terminal must not advertise an init string containing a token it then rejects.

In `atuitest.js`, **dismiss the welcome panel before typing the first line.** It
opens over the terminal on a fresh visit and owns the keyboard; leave it up and
the first command or two vanish while everything downstream passes, which reads
as an intermittent wiring bug and is not one. It also deliberately asserts no
terminal echo — the page exposes no handle on its Terminal (and must not gain
one for a harness), so that would mean pixel-hashing glyphs; the echo strings
are asserted from source in `attest.js` instead.

`tools/uitest.js`'s "40 → 80 restores the original screen exactly" case failed
intermittently during this session. Re-confirmed on a pristine checkout, ~1 in 3
either way: still the known flake, not a regression.

## Session — site config + branding, welcome panel, page-pause detection, UI fixes

`public/` + `server.js` + new `lib/site.js` + new `tools/{sitetest,lifecycletest}.js`;
`vendor/` untouched, so **no rebuild**. Only the non-obvious parts are recorded.

### Branding is substituted server-side, not client-side

`config/site.json` holds brand/tagline/titleSuffix/favicon/port; `lib/site.js`
turns them into `{{BRAND}}` `{{TAGLINE}}` `{{TITLE}}` `{{FAVICON}}` and the
static handler substitutes them into **every** `.html` it serves. Doing it in
the browser instead was the obvious cheaper route and is wrong: the tab title
and both panels would paint the old name first and correct themselves, which is
worse than not being configurable. An unknown token is left as literal braces
rather than blanked — a visible `{{FOO}}` is a far easier bug to spot.

`main.js` is never templated, so it reads the name back from
`<meta name="app-brand">` synchronously at startup. `tools/sitetest.js` asserts
no served `.html` still contains a hard-coded product name **in its markup**
(comments stripped, since the files explain the scheme in prose and have to be
able to name the default) — that assertion is the thing that keeps a rebrand
from silently missing a file.

### Fonts a browser will refuse, and the "safe" fallback that is not

The UI stack named `"DejaVu Sans Mono"`. Both Firefox
(`privacy.resistFingerprinting`) and Chrome restrict which installed families a
page may name, and a refused family is not silently skipped — it is **logged on
every page load** (`Request for font 'DejaVu Sans Mono' blocked at visibility
level 2 (requires 3)`). Two non-obvious parts:

- A **canvas `ctx.font` is a font request too.** Two of the five occurrences
  were the scope's labels in `main.js`, not the stylesheet, and would have been
  left behind by a CSS-only fix. The stack now lives once in `--ui-mono` and
  `main.js` reads that property.
- **`"Courier New"` is not the safe universal fallback it looks like.** Adding
  it fixed desktop and shrank the whole UI on Android, which has no such font
  and aliases it to Cutive Mono — a small, light face nothing like its default
  monospace. Removed; `tools/sitetest.js` lists it as restricted with the
  reason, so it cannot come back.

The final stack is the original minus DejaVu: `ui-monospace, Menlo, Consolas,
monospace`. The generic terminator was always doing the work — a generic family
is resolved by the *system* rather than requested by the page, so it is never
subject to the policy, and what it resolves to on Linux is DejaVu Sans Mono
anyway. Naming it was redundant as well as refused. None of this touches the
terminal, which draws CP437 bitmaps to a canvas and asks for no system font.

### The favicon is XML, and XML has no forgiveness

The first `favicon.svg` documented the palette as `--panel`/`--green`/`--amber`
inside its comment. A double hyphen inside a comment is a hard XML parse error,
SVG is parsed strictly as XML, and the browser rejects **the whole file** rather
than the comment. `tools/sitetest.js` now parses it for well-formedness.

### The terminal loaded small: the header is not settled at first paint

Symptom: on a desktop first load the terminal came up smaller than the space
allowed, with dead margin around it, and snapped to the right size on the first
window resize. Cause: `fitTerminal()` sizes against the height `#wrap` has *at
that moment*, and the header is still moving — the status line only becomes
`ready — press Connect to dial (N dials total…)` once `/bbs.json` resolves, and
that can re-wrap the control rows and change the bar's height by a row. Nothing
re-ran the fit until a resize did.

Fix: a `ResizeObserver` on `#bar` re-fits terminal and scope when its height
changes. Two traps: observe **`{box:'border-box'}`** (the bar's padding and
bottom border are part of what the terminal loses, and a content-box observation
misses a change in either — this was caught by the test failing), and react to
**height only**, since `fitBar()` writes `#controls`' width and reacting to that
would be our own write feeding back. `document.fonts.ready` now runs the whole
fit rather than just `fitBar()`, for the same reason.

Worth knowing for the test: headless, the "loads at the size a resize would
give it" assertion passes even with the fix removed, because the header settles
inside the boot wait. The assertion with teeth is the mechanism one — force the
bar taller, the terminal must give the height back with no resize involved.

### Welcome panel: every visit until dismissed

Was once-only, keyed off a `welcomed` flag set merely by *opening* it. Now shows
every load until "Don't show this again", under a new key (`welcomeDismissed`) —
the old key is ignored rather than honoured, so browsers that were welcomed
under the old scheme get one more chance to opt out, since there was no opt-out
before. `prefs.firstVisit` existed only to drive the old behaviour and is gone.
The `?connect=` precedence is unchanged and still tested: that visitor gets the
Connect prompt instead, and counts as dismissed so the two never stack up.

Both browser harnesses (`uitest`, `urltest`) had to start templating the HTML
they serve from disk, or the panel's heading reads `{{BRAND}}`.

### Page-pause detection — implemented, not yet working

Watchdog + attribution are in (`pageLife`, `pausedDropMessage`, consulted from
`cleanup()`), the logic is proven both ways by `tools/lifecycletest.js`, and it
does **not** fire on a real Android backgrounding. **All of it was reverted in a
later session and the feature is not being pursued** — DEVLOG.md carries the
outcome and why the approach cannot work. Two design notes worth keeping either
way:

- The attribution is a **pure function** rather than a UI behaviour, so it can be
  tested exhaustively without simulating a freeze in a browser. A driven stall
  in Playwright is a simulation regardless, so the harness tests the decision
  and leaves the plumbing to a real device.
- `lastTick` is deliberately **not** reset on `visibilitychange`. Resetting it
  when the page becomes visible again would erase the very gap the watchdog
  exists to measure.

---

## Session — header layout, terminal gestures, scope collapse, keyboard escape

`public/{index.html,main.js}` + `tools/{uitest,kbdmodtest,bbslabeltest}.js`;
`vendor/` untouched, so **no rebuild**. Only the non-obvious parts are recorded.

### The header: three rules, and two of them fought back

The goal was that the oscilloscope never costs the terminal height, while still
using the width the header has. That took three separate mechanisms, and the
two failed attempts along the way are worth more than the final code.

**1. The scope's height must not be an input to the bar's height.** The old form
(`width:clamp(200px,20vw,320px)` + `aspect-ratio:3/1`) derived height from
width, so past ~1560px the derived height exceeded `#bar`'s `min-height` and
grew the header — height taken straight off the terminal.

The fix is that `#scope` is `position:absolute; inset:0` inside `#scope-wrap`.
An absolutely positioned child sizes from its positioned ancestor's padding box
and contributes nothing back, which is what breaks the circularity.
**`height:100%` does NOT work here** and was the first failed attempt: the
wrap's own height is stretch-resolved, a percentage against it falls back to
`auto`, and with `width:auto` the canvas goes right back to sizing itself from
its aspect ratio. It looked plausible and failed in exactly the way the original
did.

**2. `#bar` has no `min-height`.** The old 104px floor existed only to reserve
room for the viewport-sized scope. Once the scope takes its height *from* the
bar, the floor did nothing but hold the header open — visible as dead space
above the BBS row and below the status line.

**3. `#scope-wrap` reserves `clamp(200px, 20vw, 320px)` as BOTH `flex-basis`
and `min-width`, and grows past it.** The reservation is not really about the
scope — **it is what makes the control column wrap the way it does**, and that
wrap behaviour is long-settled and not up for redesign. Removing the floor was
the second failed attempt: with nothing reserved the controls take the whole
line at anything under ~1300px and the scope collapses to a 2px sliver. That in
turn prompted moving the stacking breakpoint to 1320px, which stacked the header
at desktop widths that had never stacked. Both were reverted. **The stacking
breakpoint is 640px and is the phone layout — it is not a "the scope got thin"
fallback.**

The check that should have caught both: measure the layout against pristine
HEAD, rather than against an assertion of what it ought to be. Bar height,
control width, row count and scope width now match HEAD exactly at every width
through 1280; only above ~1330 does anything differ, which is the intended fix.

### fitBar(): flexbox cannot give the scope what the controls did not use

The remaining defect after all that: `#controls` shrinks to *container −
scope*, and its rows wrap **inside** that box, but the box keeps the width it
was handed. At 1314px the column is given ~1006px, wraps the button run onto a
second line ending near 700px, and ~300px sits empty between the controls and
the scope. There is no CSS for "shrink to the widest line AFTER wrapping" —
wrapping depends on the width you give, so resolving it is inherently a second
pass.

`fitBar()` measures the wrapped result and pins `#controls` to its widest line.
Why it cannot oscillate, since measure-then-write-back is the shape of a
feedback loop:

- it **clears its own override before measuring**, so it always reads the
  browser's natural layout, never its own previous answer;
- the value is the widest line *that layout already produced*, so every row
  still fits at that width and re-applying it cannot cause further wrapping;
- nothing observes `#controls`' size, so the write has no listener to feed.

`tools/uitest.js` asserts the fixed point directly (repeated passes: same width,
same header height, same row count) and that shrinking the window re-measures
rather than keeping a stale pin.

Call sites matter as much as the function: resize, `document.fonts.ready` (web
fonts land after first paint and change every metric in the bar), and the four
places that change control content — `setStatus`, `setCallUI` ("Hang up" is
wider than "Connect"), `updateFavUI` (the heart replaces the "BBS" label) and
`renderBBS`/`relabelBBS`. Miss one and the bar keeps a stale pin until the next
resize. Coalesced to one pass per frame; it forces layout twice.

`#status` is measured with `max(rect.width, scrollWidth)` because it is nowrap
with an ellipsis — its box can be narrower than the text it wants, and taking
the box alone would squeeze a long status further than it already is.

Because the scope's size now follows control reflow rather than the viewport, a
`window.resize` hook can no longer see every change: `sizeScope()` is driven by
a **ResizeObserver on the canvas**.

### Gestures: touch-action has to be decided before the gesture starts

`#terminal-canvas` claimed every touch so the zoom-pan and the scrollback swipe
would work. With scrollback off AND zoom off nothing owns a drag, so that only
cost the user the browser's own pinch and pan.

Two halves, and the CSS half alone is not enough. `touch-action` must already be
in effect at `touchstart` — a style written once the touch has begun is too late
— hence a `body.gestures-free` class flipped by `updateZoomUI()` (the one place
both switches already pass through), not a style written onto the canvas. The JS
half is two `preventDefault()` calls in `touchstart` that were swallowing the
gesture independently of the CSS, including the keyboard-open nudge path.
`gesturesFree()` is `!scrollbackEnabled && zoomFactor() <= 0`.

### Collapsed scope (mobile long-press)

The collapse CSS lives **inside the 640px media query** while the stored flag is
per browser and width-independent. That is deliberate: a collapse made on a
phone must not hide the scope when the same browser is later wide, and rotating
back re-hides it with no JS re-checking. The consequence is that `drawScope()`
must test **`scopeCanvas.offsetParent === null`** (the rendered truth), not the
`scopeCollapsed` flag — a desktop window carrying a stored collapse still shows
the scope and must still draw it.

The strip's carrier colour is driven from `setLed()`, the single choke point for
carrier state in the header, so it cannot drift from the LED. Its green is
`--green-dim: #24b347` = `--green` at the 0.7 opacity Chromium gives a disabled
`<select>`, flattened against black — the shade the protocol box takes during a
call. Written as a literal rather than an opacity so it does not also fade the
glow.

### ⇧# escapes to view 0 when anything is locked

The decision moved out of the click handler into a pure `nextView(view, nViews,
st)` purely so `kbdmodtest` can drive it with no DOM. The case worth keeping in
mind is the negative one: an **armed** modifier must still cycle — only *locks*
escape — or the ordinary shift → capital → cycle-on flow stops advancing.

### The guide link is an option, not a link

A native `<select>` holds only option text, so "open telnetbbsguide.com" is a
`@guide` sentinel option (the same trick as `@random`) that acts on `change` and
then restores the previous selection. Both sentinels must be excluded from
`renderBBS()`'s adopt-what's-displayed fallback, or a literal `@guide` lands in
`#host`.

Testing it needs `window.open` **stubbed**: the harness dispatches `change`
programmatically, which is not a user gesture, so a real popup is blocked and
the test would be asserting the popup blocker rather than the page.

### Two harness traps found on the way

A long press cannot be driven by Playwright's touch helpers (no hold duration) —
dispatch `TouchEvent`s directly with a real `Touch` object and a `setTimeout`
between start and end.

`getComputedStyle` on a transitioning property returns the value it is currently
**at**, not the target. Reading a colour straight after a class flip reports the
old one; wait the transition out.

### Pre-existing, not from this session

`uitest`'s "40 → 80 restores the original screen exactly, pixel for pixel" is
flaky — it failed ~2 runs in 3 on pristine HEAD, before any of this work. It
takes a single pixel hash where the cursor blinks on a 500 ms timer; CLAUDE.md's
own rule is to sample twice ~600 ms apart and intersect. Left alone.

---

## Session — access logging, BBS blacklist, dial counters

`server.js` + `lib/{log,bbsstats,bbslist}.js` + `public/main.js` +
`config/{logging.json,blacklist.txt}` + `tools/logtest.js`; `vendor/` untouched,
so **no rebuild**. Only the non-obvious parts are recorded here.

### Why the logger writes with an fd, not a WriteStream

`createWriteStream` was the first implementation and it was wrong. A stream
buffers, so a line is not on disk when the call returns: `tail -f` lags, a crash
loses the tail, and anything that reads the file back a moment later — the tests
did exactly this and failed — sees nothing. It is now an `openSync` fd written
with `writeSync`. One syscall per line is affordable *because* the per-chunk
transfer logging that used to dominate is behind `debug`; if that were ever
promoted to always-on, this trade would have to be revisited.

### Rotation is lazy, the summary is not

Files are stamped with the **local** day and reopened on the first write whose
stamp differs — no timer, so an idle server does no filesystem work and nothing
holds the process open. Retention prunes on that same first-write-of-a-new-day.
The one thing that *cannot* be lazy is the end-of-day summary: on a quiet day
there is no write to trigger it, so it gets an `unref`'d `setTimeout` re-armed
from its own callback rather than a `setInterval` — the interval to midnight is
not constant across a DST boundary.

Pruning compares the **stamp in the filename**, not mtime: a file appended to all
day yesterday has a fresh mtime, and the stamp is what the operator reasons
about. It also ignores any file whose prefix is not one of the three known kinds,
so an unrelated `something-2020-01-01.log` in the directory survives.

### The client-IP header gate is a security boundary, not a preference

`CF-Connecting-IP` → leftmost `X-Forwarded-For` → socket address, but **only when
the immediate peer is trusted**. Ungated, any direct visitor could set
`CF-Connecting-IP` by hand and write whatever they liked into the access log.
`trustedProxies: []` means "trust any peer", which is correct only when the box
is reachable *solely* through the proxy — that is the deployment this was written
for, and it is the assumption to revisit first if the server is ever exposed
directly. `logtest.js` asserts the forged-header case in both directions.

### Blacklist filters at assembly, so it survives the monthly refresh

`config/blacklist.txt` is applied inside `directory()`, before the curated/guide
de-duplication — not by rewriting the cached guide. That is what makes it
survive every Telnet BBS Guide refresh with nothing to re-run, and it lets a
curated board be retired without editing `curated.txt`. Its mtime is folded into
`server.js`'s `_bbsCache` stamp alongside `curated.txt`, so an edit is live on
the next `/bbs.json` request rather than at some poll interval.

A line's trailing `:digits` is only treated as a port when the digits are a valid
port; `host:99999` is dropped entirely rather than degrading to a bare-host
block, so a typo cannot silently blacklist every port on a host. Bare `host`
blocks all ports deliberately.

**This only controls what the directory offers.** A hand-typed address or a
shared link still dials — by design.

### Dial counts are recorded on carrier, not on dial

A dead board a hundred people tried must not look popular in the dropdown; its
failures belong in `telnetFailLog` instead. `bbsstats.record()` is therefore
called from `linkUp()`, not `dial()`.

The counters live in `cache/bbsStats.json` (derived, gitignored) and ride inside
`/bbs.json` — one fetch, one ETag. **`total` is stored rather than summed from
`boards`**, so blacklisting or pruning a board doesn't rewrite history.

Known cost: the stats stamp is part of the `_bbsCache` key, so every connect
invalidates the payload and re-gzips ~65 KB. Fine at human pace; if this ever
gets busy, move the counters to their own endpoint rather than widening the
cache.

### An outgoing connect timeout had to be added for the fail log to work

There was none. A black-holed host never errors — the OS sits on the SYN for
minutes — so it would never have reached `telnetFailLog`, which defeats the point
of that log, and the user stares at a dead CONNECT meanwhile.
`connectTimeoutMs` (default 15 s) closes that. `noteFail()` is guarded because a
refused connect can fire both the timeout and an error.

### UI: `(0)` renders as nothing, and the idle line restores on a delay

A board nobody has dialled and a board the server has no record of are
indistinguishable to the user, and a column of `(0)` down a 1000-entry list is
noise — so only counts ≥ 1 render. `relabelBBS()` rebuilds the count from
`dataset.count`, never by re-parsing the label; re-parsing would append a second
`(12)` on every rotation, the same failure class as the old `' · '` split.

The ready line restores after `READY_RESTORE_MS` (5 s), not instantly, because
snapping back would eat `closed (remote-closed)` / `telnet proxy failed: …`. A
new call cancels the pending restore. `refreshDialStats()` re-fetches after
hangup so the total you just contributed to is the one you see; it is a 304 when
nothing changed.

### `tools/logtest.js`

Sockets-free, filesystem-only, instant. It writes a scratch `config/logging.json`
pointing at a temp dir and restores the real one on exit — so it exercises the
real config loader rather than poking internals, but **it does mutate a tracked
file mid-run**; a crash between the two leaves the scratch config in place.
Rotation is proved by planting files with past stamps rather than faking the
clock.

---

## Session — 40-column mode + IBM VGA 9×14, and three UI fixes

`public/` + `lib/telnet.js` + `server.js` + four harnesses; `vendor/` untouched,
so **no rebuild**. Two unrelated pieces of work: a batch of UI corrections, then
40-column mode. Only what constrains future work is recorded here.

### 40 columns rides on the font, and that is the design

Selecting the IBM VGA 9×14 font *is* how 40-column mode is entered, and there is
no other route in: `cols: 40` is a property of its `FONTS` entry, and `COLS` in
`main.js` is derived from the active font rather than being a constant.

The two are tied because neither half works alone. Terminal height at a fixed
width W is `W × (rows·cellH) / (cols·cellW)`:

| mode | canvas | height at width W | vs baseline |
|---|---|---|---|
| 8×16 at 80×25 | 640×400 | 0.625 W | 1.00× |
| 8×16 at **40**×25 | 320×400 | 1.250 W | **2.00×** |
| **9×14 at 40×25** | **360×350** | 0.972 W | **1.556×** |

Halving the column count doubles the cell's on-screen scale; a 9×14 cell is both
wider *and* shorter than 8×16, and claws most of that back out of the height.
Any 8-wide font at 40 columns simply doubles the terminal — which is what ruled
out reusing one. Measured in a real browser at 390 px wide: 379 px tall against
80-column's 243 px, i.e. 1.56×. **Square pixels are the repo's convention** (the
renderer scales both axes by one factor); it is already a simplification, since
neither 640×400 nor 720×350 was square on a 4:3 CRT, but keeping it consistent is
what makes the arithmetic above hold.

The payoff is that a phone in fullscreen fits the on-screen keyboard, the
terminal, the oscilloscope and the main controls at once, with text ~1.6× the
size — and 40 columns is what the older boards expected anyway.

Never a default: no `mobileDefault`, `DEFAULT_FONT_ID` points elsewhere, and the
breakpoint re-pick cannot select it. Cycle-only, by design.

### The font-module contract grew a stride (amends the entry further down)

The "Adding a terminal font" recipe in the fonts session below says a module
exports `256 * CELL_H` bytes, one byte per pixel row. **That is now the 8-wide
case.** A row occupies `ceil(cellW / 8)` bytes, big-endian, MSB of the first byte
= leftmost pixel, unused low bits of the last byte zero — so the 9×14 font is
`256 × 14 × 2 = 7168` bytes. `fontStride(font)` in `fonts/index.js` derives it
from `cellW`, the sheet builder assembles each row's bytes before testing bits
(at stride 1 that reduces to the original single byte, so the three 8-wide fonts
are unchanged), and `Renderer` needed no change at all — it delegates to
`buildFontSheet`. A `FONTS` entry may now also carry `cols`.

FNT v2.0 stores a glyph **column-major** — all `cellH` rows of byte-column 0,
then all of byte-column 1. Invisible while every font was 8 wide. The converter
re-interleaves to row-major; the bits are untouched.

### The 9-dot rule, and why the shades do not tile

This is a true 9-dot font and follows the VGA hardware rule: only `0xC0`–`0xDF`
have column 7 duplicated into column 8. That is exactly what makes box-drawing
join across cells (verified on `0xC4`, `0xB3`, `0xDA`, `0xDB`, `0xCD`). The shade
blocks `0xB0`–`0xB2` are **not** in that range, so they carry a blank 9th column
and a large fill shows a faint vertical gap every 9 px — as it did on real
hardware, and more visible at 40 columns. **Kept verbatim by choice.** Patching
those three glyphs would fix the tiling at the cost of no longer being the font
VileR converted; `tools/fonttest.js` asserts the rule both ways so a change to it
is deliberate.

Cell height 14 is **even**, so the two-phase `0xB0`/`0xB1` checkerboards keep
their phase across the cell boundary — the odd-height banding that ruled out
PRC19 does not arise. `0xB2` is the classic checkerboard, not PRC19's diagonal.

Measured ink: cap height 9, x-height 6, *below* the 8×16 baseline of 10/7. Not a
contradiction — at 40 columns the cell renders 1.78× larger, so on screen cap
height goes 10 → ~16 units. **Measure a font after the column halving it will be
used at, not before.**

### The window size reaches the server on the dial, and only there

`TelnetFilter` gained `setWindow(cols, rows)`; `server.js` applies it from the
dial message before opening the BBS socket, so NAWS carries the real width.

The dial message is the **only** moment it can be sent: once a carrier is up
nothing but modulated audio crosses the browser socket, so there is no side
channel for a live resize. `setWindow()` therefore refuses after NAWS has gone
out, and validates (rejects 0 — some boards read a zero width as "unknown" and
others hang up — plus negatives, non-finite and >65535). Changing columns
mid-call resizes this end only; the BBS learns on the next dial.

### Re-flow, not clear, on a column change

`Terminal.reflow(cols, rows)` re-wraps the screen **and** the scrollback to the
new width instead of reallocating a blank buffer the way `resize()` does. It
treats scrollback plus live screen as one stream, trims trailing blanks,
unwraps, re-wraps, and splits the result back into screen and scrollback.

Two things worth keeping:

- A space on a **non-default background is ink**, not padding. Trimming it would
  erase coloured bars, which is most of what BBS art is made of.
- Scrollback capture never stops. The 📜 toggle gates *navigation*, not capture,
  which is why a re-flow has history to work with even when scrollback is off.

**Unwrapping is a heuristic** — nothing in a cell grid records whether a line
ended from text running out or from hitting the margin. The rule is the
conventional one (xterm et al.): a row that filled its width continues into the
next. The usual objection, a line ending flush with the margin and then hard-
broken, mostly answers itself here because `putChar` wraps **eagerly**: the
cursor moves to column 0 the moment a character lands in the last column, so a
following CRLF feeds again and leaves a blank row, and that blank is the evidence
that keeps the break. What stays ambiguous is a flush line whose blank row has
scrolled out of the ring — rare, and the cost is one wrongly joined pair, never
lost text. `tools/reflowtest.js` pins both halves.

### UI fixes in the same session

- **Scrollback and zoom are mutually exclusive.** A pan and a scroll-swipe are
  the same motion, so only one may own a drag. `zoomEnabled()` is gated on
  `zoomSuppressed() = scrollbackEnabled`; `zoomLevel` itself is never mutated, so
  turning scrollback off restores the user's magnification rather than a default.
  The button shows the crossed-out magnifier and goes `disabled`. Turning
  scrollback on also calls `zoomOff()` — an open zoom would otherwise be stranded
  with no gesture left to pan or dismiss it.
- **Page-scroll grab bar** (`#pagegrab`). The canvas declares `touch-action:none`
  — which is what makes zoom-pan reliable — so it can never scroll the page, and
  in the layouts that *do* scroll (mobile with the keyboard open, short
  viewports) the page was unreachable by touch. A 10 px strip between terminal
  and keyboard with `touch-action:pan-y` is the handle; the browser scrolls it
  natively and only the mouse path needs code. Shown only when the page actually
  scrolls, measured live in `fitTerminal()`. Mobile bar padding and the scope
  (60→54 px) were trimmed to pay for its height.
- **Welcome panel**, `public/welcome.html`, same shell as the about panel (their
  shared typography is now the `.paneltext` class). First visit = no stored prefs
  at all, captured at load before anything writes. "Welcomed" is recorded on
  **open**, not on close, so a reload instead of a dismissal does not re-greet. A
  shared `?connect=` link suppresses it and still counts as welcomed.
- Font toasts have one shape: `Font: <name> — <n> columns`.

### Testing

`tools/fonttest.js` (registry + glyph data, no DOM — asserts the glyph bytes
against known bitmaps via a deliberately *independent* unpacking, since a wrong
stride renders plausible garbage rather than throwing), `tools/reflowtest.js`
(pure model), and `tools/uitest.js` (real browser, memory-served page, no
`server.js` — same pattern as `urltest.js`, so no WS-listener hang).

`uitest` reads the **rendered canvas** rather than a test-only global: the page
deliberately exposes no handle on its terminal and a harness is not a reason to
add one. Sample the canvas **twice ~600 ms apart and intersect** — the cursor
blinks on a 500 ms timer, so a single sample makes any pixel-hash assertion a
coin flip. `telnettest` gained the NAWS 40×25 cases.

---

## Session — Keyboard: control characters, missing keys, sticky modifiers

`public/` only (main.js, index.html, about.html) + `tools/kbdmodtest.js`; no
`vendor/` change, so **no rebuild**. Closed out a keyboard audit: the on-screen
keyboard could not send a single control character, and the physical path
returned `null` for F1–F12, Insert, PageUp and PageDown. Only the parts that
constrain future work are recorded here.

### One sequence table, two callers — keep it that way

`namedSeq(name, ctrl, shift)` and `ctrlChar(ch)` in `main.js` are the **only**
place that decides what bytes a key sends. `keyToSeq` (physical) and `keySeq`
(on-screen) both call them. That is the whole point: the audit's headline bug was
that the on-screen keyboard had F1–F12 while `keyToSeq` had no case for them —
two lists that disagreed. On-screen key defs therefore carry a **name** (`n:`)
for anything non-printing and literal bytes (`s:`) only for printable
characters. **Adding a key means adding it to `namedSeq`, not writing an escape
sequence into the layout data.**

Modifiers use xterm's encoding, `1 + Shift(1) + Alt(2) + Ctrl(4)`. Alt is spoken
for by scrollback, so only 2, 5 and 6 are ever produced. Deliberate exceptions:
Shift-Tab is `ESC [ Z` (the form BBS software recognises, not `ESC [ 1 ; 2 I`);
F1–F4 are SS3 unmodified and promote to CSI when modified, as xterm does; and
Home/End stay the VT220 `ESC [ 1 ~` / `ESC [ 4 ~` rather than `ESC [ H` / `ESC [ F`,
because that is what boards have been receiving since the beginning.

### Alt owns scrollback now (a user-visible behaviour change)

Was: bare PageUp/PageDown for a screen, Shift+arrows for a few lines,
Shift+Home/End for top/live. Each of those shadowed a sequence the BBS is
entitled to receive — bare PageUp/PageDown could not reach a board **by any
route** from a real keyboard. All of it moved to **Alt** (`Alt+PgUp/PgDn`,
`Alt+↑/↓`, `Alt+Home/End`), which `keyToSeq` returns `null` for, so the two can
never collide. Shift+arrows and the page keys now go to the board.

### Grid units: rows must sum to exactly 10

Key widths are grid units set inline from each key's `u`, one unit being a column
of the 10-wide letter rows: `calc((100% - 45px) * u / 10 + 5px * (u - 1))`.

This exists because **flex-grow alone cannot align rows of different key counts**.
A 5-key row has 5 fewer gaps to give away than a 10-key row, so the same grow
weights put the arrows ~7px adrift of the row above — and by an amount that
varied with keyboard width, which is why fudging the weights never fixed it.

Units are **fractional** because label length, not aesthetics, sets the floor:
a 4-character label ("Home", "PgUp", "Ctrl", "Shft") needs ~1.25 units at phone
width. A row may contain **one** unsized key, which flexes to fill the remainder
(space on view 1, Tab on view 2); everything else must be sized, and the sized
widths must total 10. `kbdmodtest` asserts this — it is easy to break by adding
a key and easy not to notice until you look at a phone.

The keyboard font is `clamp(.70rem, 2.45vw, .95rem)`. Unchanged at 360px and up;
it only eases down on 320px-class phones, where the 4-character labels otherwise
overflow their buttons even at 1.25 units.

### Two traps in the sticky-modifier implementation

**The long-press timer cannot live on the button.** Every press calls `render()`,
which rebuilds the entire keyboard, so the element that saw `pointerdown` is
destroyed before its own `pointerup` can fire — the hold always elapses and
**every tap locks**. The timer is on `window`, with `pointercancel` wired
alongside `pointerup` because a hold that turns into a page scroll (mobile,
`body.kbd-open`) fires cancel, not up.

**Locking a modifier must also lock the view** (`modHold` sets `viewLocked`).
Views 2 and 3 are one-shot; without the view lock the first keypress drops to
view 1 and strands the locked modifier on a panel that shows neither its key nor
the capitals/symbols it was locked for, so the lock appears to release itself
after one key. Corollary that turned out to be a feature: long-pressing Shft is
a second way to pin the capitals panel.

Releasing is all-or-nothing — tapping any *locked* modifier clears both
modifiers and the view lock (`modReleaseLocks`), but leaves an *armed* one alone,
since that belongs to the keystroke being composed. Cycling the view with ⇧#
clears everything, locked included: a panel change is a clean slate, so an
invisible modifier can never be carried onto a panel that doesn't show it.
Closing the keyboard clears them too.

### Things that look like bugs and are not

- **Shft on a printable character does nothing** (and is still consumed). A
  terminal never transmits shift separately — shift *selects* the character, and
  views 2/3 already show the shifted glyphs. Shft only modifies the arrows, Tab,
  F1–F12 and Ins/Del/Home/End/PgUp/PgDn. Same on the physical path, where `e.key`
  is already `'A'` rather than `'a'`. Expect this to be re-reported.
- **`Ctrl-a` and `Ctrl-A` are the same byte** (`0x01`). ASCII control codes are
  the letter with bits 5–6 cleared, so case cannot survive; this is not a
  simplification. `Ctrl+Shft+letter` likewise collapses to plain Ctrl.
- **`Ctrl-/` sends a literal `/`** while `Ctrl-?` sends `0x7F`. `/` has no control
  form, so an armed Ctrl falls through to the character — and is still consumed.
  The two keys are adjacent on view 3.

### Alt+numpad CP437 code entry (view 4)

The upper CP437 range — `░▒▓█`, the box-drawing and block characters people drew
ANSI with — is now reachable the period way: **Alt** in the numpad view's
free slot under Esc, then a three-digit decimal code. The renderer has had all
256 glyphs since the fonts session, so this only ever needed an input path.

**Always three digits, as it was on DOS: 065, not 65.** There is no Alt key being
physically held to signal the end of the code, so the third digit is what
commits — which is exactly why the fixed width matters. Alt is sticky instead:
tap to arm, tap again to cancel. Any non-digit cancels the entry *and then acts
normally*, so an accidental Alt costs one keystroke and never swallows it.
Cycling the view or closing the keyboard cancels too. Arming Alt clears Ctrl/Shft
— a code point is a literal byte, so a modifier waiting to transform it would
mean nothing.

Out-of-range codes (256–999) are **discarded, not wrapped**; a mistyped 300 sends
nothing rather than a stray comma. Codes 0–31 do send the control byte, which is
correct: `Alt 003` is `0x03`, the same as `^C`.

The Alt key doubles as the readout, showing `___` → `21_` → committed. There is
nowhere else to put it, and three blind digits with no feedback would be
guesswork. `altAccept()` is a pure accumulator so `kbdmodtest` can drive whole
entries with no DOM.

### BRK depends on `server.js` not escaping outbound IAC

The BRK key sends `0xFF 0xF3` (telnet IAC BRK). `server.js` proxies demodulated
user bytes straight to the socket (`toBBS`) **without** escaping IAC, so it
arrives as a genuine break. Nothing else can trip that path — no ASCII key
produces 0xFF — but **if outbound IAC escaping is ever added, BRK must become an
explicit control message instead of an in-band byte pair.**

### Testing

`node tools/kbdmodtest.js` — instant, no DOM, no sockets. Extracts the sequence
functions, the modifier state machine and the `views` layout data out of
`main.js` **by name**, the same technique `bbslabeltest.js` and `sharelinktest.js`
use; rename one and the extraction throws rather than testing a stale copy. It
asserts literal expected bytes (not a second copy of the table), the full
0x00–0x1F range being reachable, all 95 printable ASCII still on-screen, the
tap/hold/lock transitions, and the row-geometry invariants above.

Layout changes are worth eyeballing in a real browser at 320/360/390px — the
`views` data and the `#keyboard` CSS block can be pulled into a standalone page
and screenshotted with Playwright without starting `server.js` (same trick as
`urltest.js`; see CLAUDE.md for the install-on-demand line).

### Deferred, from the audit (`KEYBOARDAUDIT.txt`, since deleted)

- **Backspace stays 0x7F on both paths, by decision.** Some period boards and
  door games want 0x08 and will show `^?`. Not changed because the current
  behaviour works against the boards in use; `Ctrl-H` is the escape hatch, and it
  now works from the on-screen keyboard too. A per-BBS toggle is the real fix if
  it ever matters.
- **A CP437 fifth view** of the useful subset (`░▒▓█ ─│┌┐└┘├┤┬┴┼ ═║╔╗╚╝ ■●`) —
  the audit's suggested alternative to code entry. **Not needed**: Alt+numpad was
  implemented instead (above), which covers all 256 rather than a curated subset.
  A picker view would still be quicker for drawing on a phone if that ever
  matters; **view 3's row 5 has reserved slots for it.**
- **Key repeat on ⌫ and the arrows.** Not implemented; the press-timer helper is
  shaped to take it without restructuring.

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

> **Amended by the 40-column session at the top of this file.** Step 1 below is
> the 8-wide case: a pixel row now occupies `ceil(cellW / 8)` bytes, and a
> `FONTS` entry may also carry `cols`. Everything else here still holds.

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
the filename, and locate the FNT resource through the NE resource table rather
than a hardcoded offset. The glyph bitmaps then extract verbatim; no rasterising
— but note they are stored **column-major** (see the 40-column session). Any font
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
