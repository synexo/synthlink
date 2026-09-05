# SynthLink — Development Log

Historical record: session-by-session narrative, superseded designs, UI
implementation details, and the pre-implementation planning that shaped the
protocols. **Current** state lives in HANDOFF.md (latest sessions), PROTOCOLS.md
(implementation scope), and CLAUDE.md (how to work on it). This file is the
archive so nothing is lost — read it for *why* things are the way they are.

Most recent first.
**Older sessions moved to DEVLOG_HISTORICAL.md to conserve context, as it has
grown quite large. Only explore that file when required information has not been
 found elsewhere.**
---

## Session — the heart opens the panel, and bypass is rate-capped

**The favourite heart was a toggle in the one slot a second control could not
fit.** During a call it replaces the "BBS" label, and the label is what opens the
directory panel — so from Connect to hang-up the panel, and with it the Telnet
BBS Guide search, was unreachable. The heart now opens the same panel. Nothing
visual changed: it appears at dial, it is filled or outline for whether the board
is already kept, and the fill is still the whole hint that favouriting exists.
Favouriting moved one press away, and a call gained two actions it never had.

Random is the exception, and it is withdrawn rather than disabled. It draws a
board AND dials it, and mid-call the destination is locked, so it could only be a
no-op or an unasked-for hang-up-and-redial. The condition is `favBtn.hidden` —
the heart's own visibility, which is where "a call is up" is already recorded —
and not `dialing`/`carrier`, so there is no second answer to drift.

`uitest` §10 asserted that clicking the heart stored a favourite. That was the
behaviour the change deliberately replaced, so the assertion was rewritten rather
than softened: it now drives heart → panel → favourite and pins the same thing
that section was always about, that the board being DIALLED is the one kept. §12b
is new and holds what changed — the press writes nothing on its own, the guide
search is offered mid-call, Random is not.

**Telnet bypass had no speed at all, and that was the omission.** Every other
property of a bypass call was thought about — which boards it may reach, how
often it may dial — but a modem call's rate is set by physics and bypass has no
physics. Two TCP connections ran at whatever loopback and the board could manage.
The traffic that finds that is not even hostile: telnet ANSI "movie" sites exist,
a ZMODEM send exists, and a client that simply reads as fast as it can exists.

`lib/throttle.js` is a token bucket with a queue. `directMaxBitsPerSecond`
defaults to 128000 — deliberately twice V.90's 56000, so the answer to "why is
bypass slower than the modem" is that it is not, by a factor of two. One pacer
per direction, built in the direct branch of `dial()` and stopped in `teardown()`.

Three decisions inside it are worth keeping:

*It never drops.* A rate limiter that discards bytes turns a slow BBS session
into a corrupt one, and the corruption would present as a telnet bug. Everything
pushed is written, later if not now.

*It pauses the source instead of growing.* A queue filled faster than it drains
is otherwise an unbounded buffer with the operator's memory in it. Past the high
water mark the downstream pacer calls `sock.pause()` on the board and the
upstream pacer calls `ws.pause()` on the browser; both resume at half the mark,
so a source is not paused and resumed once per chunk. That turns a cap into real
backpressure on whoever is sending too fast.

*It banks a burst, and only a burst.* 0.125 s of allowance, capped there, so a
keystroke and a full 80×25 redraw go out in the tick they arrive and a call left
idle for a minute is not entitled to a minute's worth of instant traffic.

Both directions are capped. No human types at 128 kbps, but the upstream is how a
paste, an upload and a hostile client all arrive, and there was no reason for the
two directions to have different rules.

Nothing is announced — no message, no status line, no distinct close reason —
for the same reason the dial interval is silent: what a report buys an ordinary
visitor is nothing, and what it buys an abuser is calibration.

`throttletest` drives the pacer on a clock it owns, because a real-clock test of
a rate limiter is a flake generator that also takes as long as the traffic it is
pacing. `directtest` §4c does the half a unit test cannot see: that the thing is
attached to both ends of a real session, 24 KB each way arriving whole, in order
and late. Its first payload was a counter mod 256, which contains 0xFF, and the
telnet filter ate 319 of them exactly as it should — the harness was wrong, not
the pacer, and the payload is mod 251 now.

---

## Session — the repo is GPL-3.0, and a fourth spandsp port

**LGPL-3.0 was never available to this repo.** spandsp's headers version-lock to
LGPL-2.1 — "version 2.1, as published by the Free Software Foundation", no "or
later" — and LGPL-2.1 has no upgrade path to LGPL-3.0: LGPLv3 is GPLv3 plus
additional permissions, and GPLv3 §7 only lets you add permissions to material
you added, not to Underwood's. What LGPL-2.1 §3 *does* offer is conversion to the
ordinary GPL, v2 or any later, so GPL-3.0-or-later is the route and the repo now
takes it. Two of the derived files had already stamped themselves "distributed
under the terms of the GPL" with no version and no basis; that election is now
the repo's, stated once, with the §3 route named.

Three documents had disagreed about the same code — `LICENSE` said LGPL-3.0,
PROVENANCE §6 said LGPL-2.1, the files said GPL. They now agree.

**`FskCommon.js`'s `CoherentFskDemodulator` is a port of spandsp's `fsk.c`**, and
nothing outside the file said so — PROVENANCE §1 claimed every FSK core was
synthmodem-native, and §2 listed three ported files where there are four. V.23
uses it at both baud rates, so V.23's receive path is spandsp-derived and was
credited as native. The file is genuinely mixed, which is why the header is
scoped rather than blanket: the incoherent demodulator and the modulator beside
it are native, and following `fsk_tx`'s fractional-accumulator approach is an
approach, not a port. No behaviour changed. The attribution did, which is the one
obligation LGPL and GPL both insist on absolutely.

**GPL-3.0 does not make linmodem available**, and the inference is inviting
enough to be worth writing down twice: it is GPL-2.0-**only**, incompatible with
GPL-3.0 exactly as it was with LGPL-3.0. §4's clean-room reasoning keeps its
practice and loses only its licence conclusion.

New files: `NOTICE` (every third-party attribution, and the one that must travel
with a redistribution — it replaces a pointer at synthmodem's `COPYING`, in
another repo, which a clone of this one never had) and `public/fonts/LICENSE`
(CC BY-SA 4.0 and ISC in full, plus the ShareAlike grant for the four adapted
fonts — PROVENANCE had stated their status as a fact but never actually offered
them). `LICENSE` is the GPL-3 text; the LGPL-3 text it held was also incomplete,
since LGPLv3 incorporates GPLv3 by reference and does not restate it.

Nine files gained SPDX headers: the four spandsp ports, the four synthdoor-derived
files in `public/`, and `fonts/vga-9x14.js`, which stays CC BY-SA rather than
going GPL. `V22.js` did not — it is the pre-spandsp pure-JS reinstatement, and
its only spandsp references are empirical level-matching against `-14 dBm0`,
which is measurement. Comment blocks only, no logic touched, but they reach the
browser through the bundle, so `npm run build` was rerun.

---

## Session — V.34's Figure 5 constellation, and a config step that was never written down

**The quarter superconstellation was the wrong point set, not the wrong
labelling** — the second time a figure has landed that way, after Figure
2-1/V.32bis. The code took the quarter to be the first quadrant of the
odd-integer grid: `a, b ≥ 1` odd, one point per 90° orbit, ordered by magnitude.
§9.1's ordering rule was right and only orders a *set*; the set is what the figure
fixes, and Figure 5's axes are ticked every 4 units over −43 … +45 on **both**,
which no quadrant is. The quarter is the Re ≡ Im ≡ 1 (mod 4) sublattice, spanning
all four quadrants. Old and new share zero points.

It is a better representative set than a quadrant, and the reason is worth
keeping: 90° rotation permutes the four residue classes in a single cycle,
(1,1)→(1,3)→(3,3)→(3,1)→(1,1), so the class alone names the rotation and `invRot`
became a lookup with no boundary cases at all. The old quadrant version needed
sign tests and an axis convention.

**Nothing else moved, which is the tell that this was invisible.** Mean symbol
energy came out 214/427/724/727 against the shipped 214/427/725/725 — the two
lattices have the same density — so `AMP` was left alone and all four `REF`
points are still genuine constellation points at about the data level. The shell
mapper, trellis, slicer and Phase 4 never saw the difference. A link with the
wrong constellation works perfectly as long as both ends agree, which is exactly
what the authenticity backlog exists to catch.

**The harness had asserted the bug.** `v34-map-check` checked `firstQuad` — every
quarter point in the first quadrant. That is a wrong assertion, not a weak one,
so it was deleted rather than softened, replaced by the mod-4 lattice check plus
module-load assertions in `makeConfig` for the §9.1 quarter→full expansion (four
rotations disjoint, totalling L, `invRot` inverting them) and the §9.2 ring
ordering. The generator also refuses a search box that does not strictly contain
the points it selected — an off-by-a-ring in the tail of the numbering is
otherwise undetectable by the ordering rule alone.

**Reading the figure needed a correction to the recorded method.** Step 1 of it
said document order within a div is reliable and accumulated x is not.
That is backwards for this page: the repositioning spans come in two flavours,
`width` and **negative `margin-left`**, and the negative ones move the pen
backwards — the row at Im = −43 prints 393 second and draws it last. Accumulating
the pen (widths, negative margins, glyph advances, times `.m0`'s 0.375 transform
scale, plus the div's own `x`) put every row in true reading order, and the same
pen position against the axis gave each row's first column. Both halves are now
in the harness: all 23 rows, all 416 labels, order and starting column. The first
attempt used a column pitch of half the real value and put 15 of 23 rows at the
wrong offset while every label was correct — which is why the cross-check has to
include the offset and not just the multiset.

**Separately: `config/` ships only `*.example`, and nothing said to copy them.**
Two suites failed on a fresh clone for want of `config/site.json`. The sharper
problem was upstream of that: `logtest` swaps in a scratch config and restores the
real one on exit, and with no real one to restore it left `config/logging.json`
pointing at `/tmp/synthlink-logtest-…/logs` — which then *was* the config every
later suite read. That is the trap CLAUDE.md names for a harness that dies
mid-run, except it happens on a clean exit. CLAUDE.md now opens its testing
section with the copy loop as step one, and keeps the existing prohibition intact
by drawing the line explicitly: copying the examples is setup, editing
`site.json` or `curated.txt` to get a test through is still the trap.

With the config in place and Playwright pointed at the preinstalled Chromium, the
whole suite ran green for the first time in this environment — all ten protocols
through `dsptest2` (split across calls; V.21 fails only when batched and passes
alone), `attest` 70/70, and the browser suites including `sinktest`'s
non-loopback arm.

## Session — a shorter speed menu, a rearranged README, and the embed dialogue on a phone

**Three speeds left the menu and nothing left the code.** V.29 and V.34's 28800
and 31200 entries are gone from the `<select>`, and 33600 became `value="V34"` —
one V.34 entry, dialling its default rate. `V29.js`, the four-rate `CONFIGS`
ladder, `server.js`'s `PROTOS` and every DSP harness are untouched, which was the
point: the sub-rates are the material the authenticity backlog works on.

The half worth recording is `MS_COMMANDS`. The obvious reading of "UI only" is to
leave that table alone, and it is wrong in the dangerous direction: `AT+MS=` is
resolved against the table and the result is assigned to the `<select>`, so a row
whose option no longer exists blanks the control rather than erroring. The table
tracks the menu in both directions, so the V.29 and sub-rate rows went with their
options and `AT+MS=V29` is now `ERROR`. CLAUDE.md's five-place checklist says so
explicitly now; it previously warned only about the missing-row direction.

`DEFAULT_SPEED` became `'V34'`, which is what makes an embed say `speed=v34`. The
`<proto>-<rate>` token form is still parsed and still built — the machinery behind
it is intact, so a re-offered rate needs no parser change. Three suites pinned the
old menu and were updated to the new intent: `urltest` (default speed, a stored
`V29` preference, a `v34-28800` link), `sharelinktest` (the selected option) and
`embedtest` (the snippet's token). Their counts moved only because two of those
loops iterate the menu.

**The README was rearranged so the top of it is enough to deploy and to use.**
Description → Run → Using it → Configuration → Protocols → Provenance → docs. Run
is four commands plus the two things that stop a deployer cold: both config files
are fatal-if-invalid, and a destination must be public. The address and port
policies, the bypass gates, the limits and logging all moved down into one
Configuration section. Protocols kept what explains the dropdown and handed the
clean-link flag list and the genuine-vs-simplified breakdown to PROTOCOLS.md;
Provenance kept the licence-bearing facts and handed the rest to PROVENANCE.md.
Two behaviours that were in the code but had never been written down — the mouse
path and the typed AT command line — are now in "Using it".

**The embed dialogue was too wide on a phone, and the pulldowns were the wrong
suspect.** Measured at 360×740 the panel was not overflowing at all: at two
columns each control was 141px and both selects were TRUNCATING — "V.34 · 33600
bp", "show a Connect". The fix is room, not narrowing. `Speed` and `On load` span
the full row; host/port and width/height stay paired; the on-load options were
shortened to `Connect prompt` / `dial on load` / `wait`, because a `<select>`'s
intrinsic width is its longest option and that is what pushes on a grid. The
values are unchanged — they are `embedConnectValue`'s contract.

`min-width:0` also moved onto the LABEL. It was already on the control, and that
is the version that does nothing: the grid item is the label, and a grid item's
automatic minimum is its min-content width. Chromium shrinks it anyway, which is
why the negative control did not reproduce in the harness — Safari is the browser
that does not, and a phone is where the report came from.

Both explanatory paragraphs are gone from the view. They were correct, and they
were the tallest thing in it; README.md carries the same rules for the person who
is about to paste a snippet into their own page.

---

## Session — the keyboard's phantom long press, and the splash waits for either box

**STICKYFIX shipped on the second attempt, and the first attempt is the lesson.**
Cap/symbol, Ctrl and Shft latched on a single tap, on a phone, embedded only —
the three keys that arm a long press, while `#`, which does not, was never
affected. Attempt one tracked pressed pointer ids in a Set and cleared them from
the release events: a guard built out of the very events the bug is about not
receiving. Each touch gets a new id, so one missed release left a stale id in the
set for good and every later tap then promoted — latch-on-every-tap-after-the-
first-miss, which is what "haphazard" was. §3b's "clear on every cancel source"
was implemented literally rather than at the assumption underneath it.

**The fix is capture on the keyboard ROOT, plus one hold at a time.** Touch
implicitly captures to the button and `render()` destroys that button inside the
same handler, so the release was routed to a removed element — §2's named cause.
`kbdEl` is emptied and refilled but never replaced, so a capture there survives
the rebuild, and `hasPointerCapture()` is LIVE state: at `LOCK_MS` the timer asks
whether the finger is still down instead of trusting that a cancel arrived. A
`pointerdown` listener on the root in the CAPTURE phase then ends the previous
hold before the key's own handler arms a new one, so a press whose release never
came cannot poison its successor; a release for another pointer id is ignored
rather than cancelling. Confirmed by hand on the phone, embedded. `kbdmodtest` is
240, and the two assertions that would have caught attempt one are the promote
after capture lapses *with no event at all*, and the stale press not promoting
the next one.

**The splash now waits on the Connect prompt as well as the welcome panel.**
`dialSettled` is a sibling of `welcomeSettled` in the same `Promise.all`; a
shared `?connect=` link raises that box INSTEAD of the greeting, so it is the
same rule for the same reason, and every route out of the prompt resolves it from
the single `close()`. The half worth recording is where it settles when no box
opens: for a visitor with no shared link, right after `shared` is parsed and NOT
in `maybeAutoConnect`, which runs only once `/bbs.json` is back. A visitor with
no link has nothing to do with that fetch, and gating on it would hold the splash
over an already-up page whenever the directory was slow.

**Then the splash stopped playing for anyone who had been here before, and its
own cache header was why.** Incognito played it; an existing window showed the
still frame and nothing else. Nothing in the reveal had changed, which is what
made it look like the session's own doing. `.mp4`/`.webm` went out
`max-age=604800, immutable` with no ETag and no Last-Modified, and Safari's
`bytes=0-1` probe means the FIRST thing a browser stores for that URL is a
two-byte 206. An immutable entry with no validator cannot be revalidated,
stitched or busted, so a browser that reused it as the whole file had a video
with no frames in it and no way back — the bad entry outlives the deploy that
caused it, and a rename is the only exit. The header is gone; the byte-range
answer stays, because Safari still will not start a video without it. Caching
media belongs to the CDN in front of this, which is doing it anyway.

## Session — a pre-roll splash, and keeping the script out of it

**The problem is the seconds before the app exists.** Behind Cloudflare's bot
check the HTML can land well before the bundle, the fonts and `/bbs.json` do, and
the header and terminal assemble visibly over that gap. `public/splash/` now
fills it: a video on the lowest layer from the first paint, the app on the layer
above, and a fade once the terminal has drawn, the fonts have settled and the
welcome panel — if it showed — has been closed. Waiting for the panel is not
politeness: the greeting is what the visitor is actually looking at while it is
up, so fading behind it spends the effect on nobody.

**`z-index: 0`, not `-1`.** A negative layer paints behind the body's own
background and this body has an opaque one, so the first attempt was invisible.
The body is transparent now — the canvas colour comes from `html`, which still
carries it — and the four top-level blocks say `z-index: 1`, because a
non-positioned block paints below a positioned one whatever the source order.

**Two bugs, and the second is the interesting one.** The fade was coded at 3s and
ran for 338 ms: `transitionend` bubbles, the video had an opacity transition of
its own, and the removal listener on the container was woken by the CHILD
finishing its fade IN. It checks `e.target` now. Then the reveal itself was
rebuilt, because it was a `playing` listener adding a class — which makes the one
thing this feature exists for depend on our script running on time. It fires
once. A listener attached after an injected script has held the main thread
misses it for good, and the symptom is the worst available: a splash stuck on its
still frame while a perfectly good video plays invisibly underneath, in exactly
the slow load the splash is there to cover. The reveal is a CSS animation over
the element's own `poster` now, playback is the `autoplay` attribute, and the
still is inlined as a data URI, so the whole showing of it is the document's own
doing. Verified with page scripting disabled outright: video at opacity 1,
playing, 960x540. Only the fade-out is JavaScript, and a late fade-out is the
harmless direction — which is why `main.js` calls `hold()` synchronously on
arrival to cancel the controller's blind fallbacks, one of which would otherwise
have cut the splash off under an open welcome panel.

**A poster earns its place by removing a decision.** Revealing a video that has
no frames yet paints an opaque black rectangle; with a poster the browser shows
frame 1 until it has something better, natively. So the reveal can run on a
declared timer that knows nothing about how the download is going. The poster is
the video's own frame 1, which is why the handover inside the fade is invisible.
Scripting-disabled browsers are required by the spec to expose media controls
whatever the markup says, so those are suppressed; Firefox offers no selector for
it, which is accepted — that is the no-JS case, not the slow-JS one.

**Serving.** `.mp4`/`.webm` MIME, byte ranges, and — at the time —
`max-age=604800, immutable`. The ranges are not a nicety: Safari probes
`bytes=0-1` and reads a 200 as ranges-unsupported, which on iOS is a video that
never plays with nothing logged anywhere. The cache header did not survive: it is
what stopped the video playing for returning visitors, and the session above
removed it.
`splashFadeSeconds` joins `config/site.json` under the same strict rules as
everything else there, and the controller reads the duration back off the
computed style so the number is written once.

**`sitetest`'s product-name assertion was over-broad and is now structural.** It
had been red since a `Powered by SynthLink` link was added to `about.html`. Two
different things are spelled the same: the deployment's brand, which must be a
token so a rebrand reaches it, and the open-source project's name, which must
NOT change on rebrand or the attribution becomes wrong. The exemption is the text
inside a link to the project's repository and nothing else, so the name in a
heading, a paragraph or a `title=` still fails.

---

## Session — what may be dialled, and configuration that refuses to be wrong

A review pass, instructed and answered through a temporary document that is
deleted now the work has shipped. What outlived it is here, in HANDOFF.md's
watch-outs, in README.md and in the headers of the two new modules.

**Two policies, deliberately in different places.** `lib/netguard.js` decides
what may be dialled. The ADDRESS half — a destination must resolve to a public
address — is a constant with no config key, because a setting gets turned on once
and outlives the reason for it, and a config file is copied between deployments.
The only way past it is a command-line flag, which has to be typed at invocation
on purpose. The PORT half is the opposite: it is entirely `config/site.json`'s
`blockedPorts`, and netguard holds no list and no default. It carried one for a
while and that was wrong — an operator reading their config saw a setting that
looked unset while the enforcement happened out of sight in code they had no
reason to open. A control invisible in the file you would check is worse than a
slightly redundant visible one. Ranges (`"1-22"`, `"24-1023"`) are what let the
config state the whole policy rather than leaving a rule hiding behind a list.

**The name is resolved once and the socket opens to that address.** Everything
that decides — listing, the address policy, the per-board key — now operates on
the same answer the connection uses, rather than on a hostname that is looked up
again later.

**Configuration is strict, and this file's own loader used to be lenient.** Both
config files now refuse anything missing, unparseable, unknown or the wrong
shape, and `server.js` exits before it listens. The lenient version was defended
on the grounds that a server which will not start over a stray comma in a
cosmetic setting is the worse failure, and that argument does not survive
contact with what it actually did: a stray comma is a parse error, and the answer
to one was to discard the operator's entire file and run on defaults without
stopping. A boolean written as `"no"` was kept as a truthy string, so the setting
did nothing and nothing said so. A key with a typo in it was ignored entirely.
Each of those leaves an operator believing the file they wrote is in force. There
is no cosmetic exemption now, because a carve-out for the harmless-looking
settings is the cover everything else slips through under. The cost is that any
future rename or removal of a setting needs a `MOVED` entry or an existing
deployment fails on upgrade; that is cheap and it is worth it.

**A call that does not come up now sounds like one.** Dial tone runs from the
moment Connect is pressed — it used to begin only once the server answered the
name lookup, so the socket opening and the lookup were silent — and is cut when
there are digits to send. Every way a call can fail then gets the same answer:
reorder, `BUSY`, silence. Identical on purpose; a distinct message per cause is
useful to exactly one kind of caller. Three constants are coupled and the
ordering is load-bearing: `resolveTimeoutMs` < the browser's own deadline <
`DIALTONE_S`, and `DIALTONE_S` under `BUS_LEN`.

**The bus fix is the one worth reading twice.** `_pump()` hands the ring to the
sink, and the ring is only zeroed by `_reserve()`, which only runs from `_mix()`.
While something is writing — a carrier, a clip — the span ahead is always freshly
zeroed and nothing is wrong. The moment nothing is writing, `busCleared` stops
advancing and the pump reads back what was there one lap ago and sounds it again,
every `BUS_LEN`. Nothing had ever left the bus unattended, because every hang-up
reset it in the same tick the carrier stopped; a tone that has to outlive the
call that caused it was the first thing to open that gap. One line —
`this._reserve(end)` before reading — and `bustest` covers both directions.

**Whichever destination control is on screen is the one that gets dialled.**
`connect()` reconciles to it before reading the canonical host and port. That was
half true already (`commitHostPort` for the manual field) and the missing half
was worse than it looked: re-picking the option a `<select>` is already sitting on
fires no `change`, so a dropdown left displaying a board that was not the
destination kept displaying it however many times it was chosen. Picking a
*different* board worked, which is what made the report look arbitrary. Assert on
the dial message rather than on the controls — and note that Playwright's
`selectOption()` fires `change` where a browser does not, which made the first
version of that test pass against the broken code.

## Session — embedding, which turned out to be a wrapper

The embedding plan was a temporary document, written to instruct the work and
answered as one; it is deleted now that this has shipped, and what outlived it is
here, in README.md and in the header of embed.js. Implementing it moved almost
nothing: `parseShareParams` has accepted `connect=auto` since `#shareauto`
shipped, so the frame's URL needed no new vocabulary, and the server needed no
change at all — `server.js` sends no framing header and already serves `.js`. The
work was two new files and a second view inside one modal.

`buildShareURL` was the one place a decision was owed. It emits `connect=1` and
nothing else, and the obvious move — teach it `auto` — would have altered the
function `sharelinktest`'s 79 assertions run through, for a caller that did not
exist when they were written. `buildEmbedURL` went beside it instead. The two
want different things from the same key: a share link is a prompt or nothing, an
embed is auto, prompt or none, and `none` writes no key at all rather than
falling back to something. `sharelinktest` was not edited, and neither was
`uitest`.

The wizard's speed menu is cloned from the header's `<select>` at open rather
than restated, minus `direct`, and `embedtest` reads that same menu out of
`index.html` — so adding a protocol exercises the wizard without touching either
file. Leaving bypass out is not tidiness: it is gated one dial server-wide and
the delay is silent, so an embed dialling through it would queue behind every
other embed anywhere, with nothing said.

Two things the harness had to be talked out of. Its first extractor hunted the
terminating `;` with a character scan and ran off the end of the file on
`embedAttr`, whose `/"/g` reads as the start of a string; it now grows the slice
a line at a time until the parser accepts it, which is asking the authority
rather than reimplementing it. And two assertions about what `embed.js` does
failed on `embed.js`'s own comments explaining what it deliberately does not do —
they read the file with comments stripped now, because naming a thing in prose is
not shipping it.

That last failure mode — correct as text, wrong as markup — got its own harness
rather than a note. `embedhosttest` reads the snippet out of the running wizard,
pastes it into a stub third-party page and asserts a terminal boots in the frame
at the chosen destination AND the chosen speed. The speed is the interesting
half: a mis-escaped `&` between query keys would leave the host intact and drop
everything after it, so a destination check alone would pass a broken snippet.

Three decisions were taken, and are recorded here because that planning document
is gone. **No `frame-ancestors` allowlist** — anyone may embed, which is why this
needed no server change; the lever, if it is ever wanted, belongs in
`config/site.json`. **Embedded dials merge into the public `bbsstats` totals** —
they are dials. **Attributes are the entire API** —
no `connect()` method, no carrier events, no `postMessage`, because the whole
page is framed and the functional surface is the query parameters that already
existed.

### The defaults, revised

The first cut shipped `height="600"`, and a 600px frame turned out to be exactly
the wrong number: the on-screen keyboard gave the frame its own scrollbar instead
of shrinking the terminal. It looked like an iframe bug and was not one. A
standalone 600px-tall WINDOW does the same thing — measured side by side, canvas
444→444px and the page scrolling in both — because `@media (max-height: 600px)`
in index.html deliberately lets a short viewport scroll rather than squeezing the
terminal to nothing, and a frame IS the viewport for the document inside it. The
CSS was right; the default was wrong.

So the box is now `90%` × `90vh`, centred, and the two units are chosen for
different reasons. Width is a percentage because width percentages always
resolve, and 90% keeps the frame inside the embedder's column instead of
overhanging it. Height is NOT a percentage, which is the instinctive choice and
the broken one: a percentage height resolves only against a containing block with
a definite height, and a frame dropped into an article has a parent of `auto`, so
it computes to `auto` and the frame collapses to the CSS default of 150px. `vh`
always resolves, and 90 of them clears the 600px rule on anything but a very
short screen — where the scrolling layout is the right answer anyway.
`embedhosttest` now pins all of it, including that the keyboard shrinks the
terminal, which is the report that started it.

The default mode became `connect="1"`, a Connect prompt. An embed that dialled
when somebody scrolled past would open a socket nobody asked for, and the press
is also the gesture that lets the AudioContext start.

### The module tag, which only failed where it mattered

The first embed reached a real page and did not run: "Access-Control-Allow-Origin
missing" in Chromium, "Module source URI is not allowed" in Firefox, both against
a 200 response for a file that was plainly there. The cause is a rule that only
applies to the form we had chosen: **a `type="module"` script is always fetched
in CORS mode**, so a cross-origin module needs an `Access-Control-Allow-Origin`
header, while a classic script is fetched in no-cors mode and needs nothing. An
embed is cross-origin by definition, so the module form could never have worked
for anybody. It is why third-party widgets have always been classic scripts.

Two fixes existed and only one is right. Adding the header to `server.js` keeps
the module syntax but makes embedding depend on operator configuration — and on
every reverse proxy in front of it not stripping the header. Dropping the module
keeps embedding zero-configuration, which is what "no server change" was supposed
to mean in the first place. So `embed.js` is a classic script, the frame origin
comes from `document.currentScript` rather than `import.meta.url`, and the file
now carries an explicit prohibition on `import`, `export` and `import.meta`,
asserted rather than commented, because any of the three silently makes it a
module again.

The harness deserves the sharper lesson. Every suite was green, including one
built specifically to catch snippets that are correct as text and wrong as
markup — because it served the host page from the app's own origin, where the
CORS rule never engages. A same-origin embed test is not an embed test.
`embedhosttest` now serves `embedder.test` and `bbsdial.test`, which are two
origins to a browser, so the script fetch, the frame and the storage partition
all behave as they do in the field. It reproduces the failure and confirms the
fix.

The switch to a prompt default also surfaced a real bug. The element copies its
attributes VERBATIM into the query — that is what "no second parameter
vocabulary" means — so the wizard's mode NAME was going straight through:
`connect="prompt"` reaches `parseShareParams` as an unrecognised value, which is
falsy, and the prompt the embedder asked for would simply never have appeared,
with nothing to say so. Only `auto` happened to be spelled the same in both. The
names are mapped in one place now, `embedConnectValue`, and `none` is spelled by
the attribute's absence rather than by an empty one somebody would later fill in
with the word.

## Session — the mouse, and a keystroke nobody could type

The terminal never answered a mouse. It turned out most of the machinery was
already in the tree: `terminal.js` carried `getSelectionText()` and `getURLAt()`,
`renderer.js` carried `_markSelection`, `_drawSelectionOverlay` and
`invalidateSelection`, and `drawFrame()` took a `selection` argument that
`main.js` passed `null` to, permanently. Both files came across whole at the
original port; what did not come was synthdoor's `app.js`, where the listeners
lived, because `main.js` is a ground-up rewrite rather than a port of that class.
So the orphans were exactly the public API of those two files and nothing else.

The renderer needed no editing at all. `_drawSelectionOverlay` already branched
on the hybrid layout and drew from `xEdges`/`yEdges` — its own comment says "same
three rectangles either way, only the coordinate source differs" — so 40 ⇄ 80,
the Aa cycle and Topaz were solved on the draw side before this started. The one
addition is `cellAt()`, the inverse of that same branch, and it lives in the
renderer because the edge table does: a copy of the arithmetic in `main.js` would
go stale at the next font change.

**The menu-key rule is better than its name suggests.** synthdoor's
`_isLoneAlphaNum` parses no bracket convention: it asks whether an alphanumeric
has non-alphanumeric neighbours, which catches `[L]ogin`, `(A)bort`, `1. New
game` and `Q.uit` in one predicate, with a second narrow clause for punctuation
wrapped in literal square brackets. Both read ASCII, which CP437 and Latin-1
share, so a board on Topaz classifies identically — asserted rather than assumed.

Four things were changed on the way over. Clicks read `getDisplayCells()`, so
scrolled back they act on what is on screen rather than on the live row of the
same number; anything that sends calls `snapToLive()` first, exactly as a
keystroke does. A menu key sends the RAW cell byte — synthdoor decoded to a
character and let `charCodeAt & 0xff` truncate it, which is silently wrong above
0x7F. Copy takes the active font's charset table, or an Amiga board reaches the
clipboard through the wrong one. And Enter is limited to BLANK cells: a click on
a character that is not a menu key is a near miss on the key beside it, and
answering a miss with Enter hands the menu a choice nobody made.

**Paste, and why it is a panel rather than an API call.**
`navigator.clipboard.readText()` is effectively Chromium-only, and Ctrl+V could
not be taken because BBS editors use 0x16. A real `<textarea>` solves both at
once: it takes the browser's own paste with no permission and no per-browser
divergence, so right-click opens a small panel holding one. It works offline too,
for free — `atInput()` already accepts a whole string a character at a time, so a
pasted `host:port` reaches the command line by the same path a message body
reaches a BBS. Nothing pasted is stripped. With a carrier the panel says what the
send will cost, which lets the user decide with the number in front of them
instead of meeting a silent cap.

**The bug the paste box exposed was not the paste box.** Typing into it did
nothing while a call was up. The window-level keydown handler read `if (nav ||
carrier || cmd)` and the form-field exemption was on `cmd` alone, so a live
carrier claimed every keystroke on the page — the manual host:port field had been
shut the same way, by the same line, for as long as it had existed. The fix turns
on a new `isTextEntry()`, and the trap it exists to avoid is why it is not
`isFormField()`: that predicate counts a BUTTON, which is exactly what holds
focus straight after a toolbar press, so gating a carrier on it would have cut
the BBS off from the keyboard at the first button click.

**Two of the harnesses' own assertions were wrong, and both taught something.**
A uitest check that a synthetic tap on a phone "claims nothing" was false: a
phone defaults to scrollback off, which leaves zoom enabled, and zoom
legitimately claims the press. It now switches zoom off first, which is the state
in which a desktop DOES claim it — same state, different viewport, opposite
answer, which is the mobile gate itself. And the first paste-box test passed
against the reverted fix, because it ran with no carrier and the bug is
carrier-only. A test that cannot fail is not a test; `boot()` grew an opt-in
`answerConnected` that answers the dial and echoes what is sent, bringing up a
real carrier through the modem-bypass path — the only route to one that needs no
DSP. Every section above it still gets the deliberate silence it was written
against. The near-miss test then failed for a third reason worth recording: a
live call has already printed its connect banner, so text typed onto "row 0"
lands somewhere unpredictable, and the test now clears and homes the screen with
`ESC[2J ESC[H` sent through the paste box before it clicks at anything.

## Session — Amiga boards, and what a byte means

Two things, and the second is the interesting one.

**The stale canvas on Android.** The terminal came back blank after a spell in
the background — a new connect gave audio, a moving cursor and no text. The
existing mitigation invalidated the per-cell cache on `visibilitychange`, on the
assumption that the visible canvas had been discarded. It had, but so had the
GLYPH ATLAS, which is a canvas too and comes back present, correctly sized and
entirely transparent. Every cell was redrawn, every blit read an empty atlas, and
the cursor kept moving because a cursor is a `fillRect` and needs no atlas.
HANDOFF.md had already written down that this would present identically and need
a rebuild rather than an invalidate, which is the note that saved a session.
`restore()` records one opaque pixel per sheet at build time and reads it back to
tell a live sheet from an emptied one. `atlastest` keeps the old behaviour as its
negative control, so the thing that was wrong stays visible.

**Amiga boards.** aBSiNTHE renders as static here and correctly in SyncTERM, and
the first guess — that Amiga art is 7-bit and only the letterforms differ — came
from a standalone `.ans` file and was wrong about the live board. A raw capture
settled it: eleven distinct high bytes, all coherent as Latin-1 punctuation used
for shading and incoherent as CP437. 1,929 macrons, 214 middle dots, 48 not
signs. The underline rail beneath the logo is `¯¯¯¯¯¯¯¬~·` in one reading and
`»»»»»»»¼~╖` in the other.

The mechanism turned out to be almost free, because `terminal.js` never decodes
anything: a byte is stored raw and only becomes a character at the atlas
builder's `fillText`. So an encoding is a table, and a charset descriptor with
three fields covers it. The load-bearing line is `font.charset || CP437` — every
font that predates this resolves to a descriptor holding the constants the code
already used, so the rasterizer is handed byte-for-byte what it always was.

That was the brief, in fact: this could not be allowed to touch what already
renders, given how much work the CP437 path had taken across three browsers. The
answer was a throwaway characterization snapshot rather than care — codepoint
tables, layout numbers, pad masks, edge tables, stretch flags, derived bitmaps
and atlas PIXEL HASHES for every font at three device sizes, taken from untouched
code and compared after every step. 72 values, zero movement, throughout. It was
deleted with the work: a golden of internal numbers is a change detector, and one
that survives its change becomes a thing people regenerate.

Three findings worth keeping:

- **The face was identified by diffing, not by filename.** SyncTERM ships every
  font it supports as raw bitmaps in `src/conio/allfonts.c`. Against those, the
  supplied file is 184/190 glyphs identical to `Topaz Plus (Amiga)` and 167/190
  to `Topaz (Amiga)` — it is the MODIFIED 2+, which is also what the SAUCE record
  in the board's own art declares. The glyphs that separated them were `( ) < >`,
  exactly the ones the plus variants redraw so ASCII art tiles.

- **The aspect was wrong first time, and the file could not have told us.** A
  faithful pixel tracing sits on square units, so it presented at 1.600 —
  flexi160's widescreen shape on a font from a 4:3 machine. SyncTERM has no Amiga
  screen mode at all; the Amiga fonts run in ordinary 4:3 text modes, and
  measuring the row pitch and column pitch off a SyncTERM screenshot of the board
  gives a cell ratio of ~2.44 against the 2.0 the file implies. Both hardware
  routes give 2.4 exactly. Corrected offline with a Y-scale, which is the safe
  axis: `hmtx` is X-only, so it cannot desynchronise from `glyf`'s `xMin`.

- **U+00AD is invisible to every shaper.** Byte 0xAD in Latin-1 is SOFT HYPHEN;
  the glyph is in the file and `fillText` still draws nothing. It would have
  looked like a missing glyph. `latin1.js` maps that byte to U+2010 and the
  subset script points that codepoint at the same glyph.

Also learned, and unrelated to any of it: `cellW` cannot exceed 32, because
`glyphRowBits` packs `stride * 8` bits with 32-bit shifts and silently loses the
top byte at stride 5. It is why the grid that is exact on both axes for Topaz
(40x96) is not the one that ships; 15x36 is, and measures 0.12% against
SyncTERM's bitmap through the real rasterizer.

---

