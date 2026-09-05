# SynthLink — Handoff

Pick-up point for the next session. Assumes no memory of how we got here.

- **What / architecture / run:** README.md
- **How to work on it (AI):** CLAUDE.md ← read this first
- **Protocol scope, real vs simplified:** PROTOCOLS.md
- **Authenticity backlog:** PROTOIMPROVE.md
- **Font & terminal rendering:** FONTS.md
- **Source & spec references:** PROVENANCE.md
- **History:** DEVLOG.md, then DEVLOG_HISTORICAL.md

---

## Current status

**The heart opens the directory panel rather than favouriting on the spot.** It
still appears the moment dialling starts, still replaces the "BBS" label, and is
still filled or outline for whether the board is already a favourite — the hint
that favouriting exists is unchanged. What the press does is now the same thing
the label does: it opens the panel, where favouriting is one of the buttons. That
makes the guide search reachable during a call, which it never was. Random is
withdrawn while the heart is up — it DIALS, and the destination is locked for the
duration of a call — read off `favBtn.hidden` rather than off `dialing`/`carrier`,
so the two answers cannot disagree. `uitest` §10's "the heart stores a favourite"
assertion was for the behaviour that was deliberately replaced; it now asserts
the press-then-favourite path, which is what that section was ever about.

**Telnet bypass is rate-capped at 128 kbps, both directions, and says nothing.**
`config/site.json`'s `directMaxBitsPerSecond` — twice V.90, so bypass stays
comfortably the fastest way to reach a board. A modem call is paced by its
carrier and cannot be made to go faster; bypass has no carrier, so the two TCP
connections ran at whatever they managed, and an ANSI "movie" or a file send took
all of it. `lib/throttle.js` is a token bucket with a queue, one per direction,
built only in direct mode. It NEVER drops: what it cannot send yet it queues, and
when the queue gets deep it pauses the source — the board's socket downstream,
the WebSocket upstream — so a fast peer buffers at its own end rather than in
this server's memory. A 0.125 s burst allowance is why a keystroke and an 80×25
redraw still go out in the tick they arrive. The upstream is capped too: nobody
types at 128 kbps, but a paste, an upload and a client written to flood all
arrive the same way. 0 disables. `throttletest` covers the pacer, `directtest`
§4c the wiring.

**The repo is GPL-3.0-or-later.** It was LGPL-3.0, which it could not be: the
spandsp-derived files are LGPL-2.1-**only** upstream, and LGPL-2.1 does not
upgrade to LGPL-3.0. It converts to the GPL under LGPL-2.1 §3, so that is the
route taken. `LICENSE` is the GPL-3 text, `NOTICE` is new and carries every
third-party attribution, `public/fonts/LICENSE` carries the CC BY-SA 4.0 and ISC
texts and the ShareAlike grant for the four adapted fonts. Derived files now
carry SPDX headers. PROVENANCE.md §6 is the summary.

**A fourth spandsp port was found and is now attributed.** `FskCommon.js`'s
`CoherentFskDemodulator` is a port of `fsk.c`, which PROVENANCE had not recorded
— §1 claimed all the FSK cores were synthmodem-native. V.23 uses it at both baud
rates. No code changed; the attribution did.

**Working, wired end-to-end, verified:** V.21 (300), Bell 103 (300), V.22
(1200), V.23 (1200/75), V.22bis (2400), V.29 (9600), V.32 (9600), V.32bis
(14400), V.34 (19200/28800/31200/33600), and **V.90 (56000 down / 33600 up)**.
Speed ceiling is **56000**.

**The menu offers a subset of that, and only the menu changed.** V.29 and V.34's
sub-rate entries are no longer in the `<select>`: V.34 is one entry, `value="V34"`,
which dials 33600. Nothing was deleted from the DSP — `V29.js`, the V.34 rate
ladder, `server.js`'s `PROTOS` and `v29test`/`dsptest2` are all untouched, and
re-offering a rate is one `<option>` plus one `MS_COMMANDS` row. `DEFAULT_SPEED`
is `'V34'`, so a share link and an embed now say `speed=v34` rather than
`speed=v34-33600`; the `<proto>-<rate>` token form is still parsed on the way in.

**All ten protocols pass `tools/tests/dsptest2.js`** byte-exact both directions,
in one batch, with no `SECS` override. Bell 103's long-standing failure there was
the harness, not the protocol: it typed 1200 ms after the *originate* side
connected, and when V.8 no-deals the two ends can reach data mode seconds apart,
so the keystrokes went into a half-open link. It now waits for both.

**The real-browser smoke test is done.** V.90, V.32bis, V.32, V.34 @ 28800 and
Bell 103 have all been confirmed over the literal browser↔`server.js` WebSocket
path. Nothing is waiting on a real shell.

**V.34 now runs the real Phase 4 MP exchange.** The invented `DLE 'R' hi lo` rate
frame is gone; V.34 builds Table 20/V.34's MP Type 0 at its literal bit positions,
waits for the far end's MP, answers with MP′, and only then enters data mode — so
the exchange establishes agreement rather than decorating it. `V34Phase4.js`, with
the bit framing shared with V.90 through `BitFrame.js`.

**V.34's constellation is now Figure 5's, and the old one was the wrong point set
rather than the wrong labelling.** The shipped quarter superconstellation was the
first quadrant of the odd-integer grid; §9.1's quarter is the Re ≡ Im ≡ 1 (mod 4)
sublattice, spanning all four quadrants, and the two share **zero** points. The
four residue classes are one orbit under 90° rotation, so the class alone names
the rotation — `invRot` is that lookup now, with no quadrant boundary cases. All
416 printed labels were transcribed and match. Mean symbol energy barely moved
(the two lattices have the same density), so `AMP`'s `meanE` and `REF` are
untouched and every `REF` is still a real constellation point. `makeConfig`
asserts the §9.1 expansion and the ring ordering at load; `v34-map-check` holds
the figure itself.

**The V.90 CRC convention is no longer inferred.** §10.1.2.3.2/V.34 transcribed
from two editions: the preset and output convention already matched, the coverage
did not — the CRC must exclude the frame sync, start and fill bits, and now does.
Only the register's shift direction (Figure 14) is still unverified — it refused
the summarising retrieval and has not been retried by the conversion route that
has since worked on other figures.

**V.32bis now maps Figure 2-1 point for point — and the old map was the wrong
point set, not just the wrong labelling.** The shipped constellation was an
odd-integer grid `{±1,…,±11}²` minus 16 corners; the Recommendation's points lie
on the checkerboard lattice Re+Im odd, |Re|,|Im| ≤ 9. **Zero points in common.**
It worked only because both ends agreed. New slicer, `TX_GAIN` rescaled for the
halved mean energy (82 → 41), and `REF` moved from (7,7) — which is not a point
of this constellation — to (7,4).

**Configs self-validate.** V.34's `makeConfig` checks its Table 10 Minimum row and
the constant-`b` rate arithmetic; V.32bis asserts its constellation size, index
bijection and Table 5 word at module load, plus — new with Figure 2-1 — that every
point is on the Re+Im-odd lattice and that the 90°/180° rotational invariants the
differential coding requires hold for all 128.

**V.8 runs for everything except V.29.** **V.90** is genuinely asymmetric: the
server is the digital modem sending PCM codewords downstream, the browser the
analogue modem sending V.34 upstream, with real Phase 1 and Phase 4 and the full
Table 2 rate ladder.

**The 40 ⇄ 80 re-flow now round-trips.** A column change rebuilds the screen
from its own lines rather than the tail of the stream, and claims back the rows a
narrower width had to spill, so switching there and back returns the page intact.

**Local audio is one PCM bus, and the oscilloscope reads it rather than the
audio graph.** Carrier both directions, dial tone, DTMF, ringback and the
handset clip are all mixed into one ring at `SR`; the scope, the spectrum and
the speaker are three readers of it. The AnalyserNode is gone. `playPos()` runs
off the wall clock, so the trace is a function of the signal and not of
playback: it works muted, suspended, or with an AudioContext that never
started — which is what `connect=auto` gets, having no gesture to resume one.
The sink is a ScriptProcessor pulling one continuous stream. That fixed the
Chrome crackle: scheduled buffer sources slip a sample at every boundary, and
the cursor re-anchored whenever a refill ran late. Verified on Firefox, Chrome
and Android. CLAUDE.md has the rules.

**Chrome's glyph rendering is fixed, and it was two independent bugs.** A
one-device-pixel hairline down the right edge of every wide cell was the blit
reading the atlas cell's extension column on glyphs that do not join, which put
its source rect on the cell boundary for an overreaching sampler to cross;
letterforms are now capped at `inkW`. Separately, `E G M N W w` filled their
counters and the double-line box set drew as one thick stem — both are glyphs
built from ONE-PIXEL gaps, and the 50% derive threshold was closing those gaps
whenever the rasterizer laid down a little extra ink. The threshold is now 192.
Neither reproduces on a software rasterizer, so neither is visible to any
harness here; FONTS.md §2.4 and §5.3 carry the arithmetic.

**A board can now be served its own font, and that font carries its encoding.**
`config/altfonts.txt` maps `host:port` to a font id; `lib/altfonts.js` serves the
map at `/altfonts.json`; the page holds it and applies the override in
`connect()`, before the dial message — the font settles the column count and
`windowSize()` rides out with it, so anything later would tell the BBS the wrong
width. Reverted in `cleanup()`, so a drop and a dead dial are covered too, and
nothing is written to the user's stored font. The Aa button is HELD rather than
disabled: it keeps its click so it can say why.

**The first such font is Amiga Topaz 2+, and the encoding half is the point.**
AmigaOS is ISO-8859-1, so an Amiga board's high bytes are punctuation used as
shading — 0xAF a macron capping a letter, 0xB7 a middle dot, 0xAC a not sign. Read
as CP437 those are `»`, `╖` and `¼`, which is why aBSiNTHE looked like static. A
raw capture of that board has 1,929 macrons in it. An encoding here is only ever
the table the atlas builder consults, so `fonts/charsets.js` holds three fields
per charset and `charsetOf(font)` is `font.charset || CP437` — every font that
predates this resolves to the constants the code already used, and `ttftest`
asserts that per entry. `renderer.js` and `terminal.js` have NO diff.

**Topaz is 4:3 because an Amiga was, not because the file said so.** The upstream
traces an 8x16 grid on square units and so presents at 1.600 — 20% wider than the
machine. `tools/topazsubset.py` stretches Y by 1.2 (X untouched, so `hmtx` cannot
desynchronise from `glyf`), which puts 80x25 at 1.3333, within 1% of Pixel. The
face was pinned to the *modified* 2+ by diffing against SyncTERM's own bitmaps:
184 of 190 glyphs identical to `Topaz Plus (Amiga)`, 167 to `Topaz (Amiga)`.
FONTS.md §11 is the whole method, written to be followed for the next one.

**A per-font sharpening mask is wired and shipping OFF.** One strength per font
id in `public/fontmask.js`, hand-edited and served raw (edit, reload — no
rebuild, no restart); every entry is 0, so no atlas changes by a byte until one
is dialled in. FONTS.md §5.6.

**There is a sysop status page at `/sysop`, it is read-only, and it is off until
an operator turns it on.** Calls in progress — client address, the board's name
and address as two fields, speed or telnet bypass, state, time on carrier, bytes
— with today's and all-time dial counts and the limits in force. It polls
`/sysop.json` every `sysopRefreshSeconds`; there is no WebSocket, which is what
keeps it out of the `maxSessions` accounting. `lib/sysop.js` holds the gate and
the snapshot builder, `lib/sysop.html` is the page, and `node tools/sysoppass.js`
mints the hash. Nothing behind either route writes.

**The live session registry is new, and `_sessions` was deliberately left
alone.** `_live` in server.js is a Map of id → a record the session was already
keeping (dest, openedAt, linkAt, proto, the byte counters, held by reference),
created on connection, mutated where the log lines are already written, and
deleted in `uncount()` — the one path guaranteed to run exactly once per socket.
`_sessions` remains the counter the dialling limit reads: a limit that depended
on the size of a map kept for a table would be trading a correct control for a
display convenience.

**The sysop gate is Basic, and the memo is not an optimisation.** scrypt is
~100 ms of blocking CPU by design; on a polling page that is a hundred
milliseconds of the event loop every few seconds, in the process running a 5 ms
transmit timer for every live call. A verified `Authorization` header is
therefore remembered for five minutes and costs a constant-time compare after
that, and only SUCCESSFUL verifications are memoised, so wrong guesses put
nothing in the map. Separately, one scrypt runs at a time server-wide: while one
is in flight a second attempt is refused without hashing, so an unauthenticated
request cannot turn the password hash into a CPU amplifier. That is deliberately
not a lockout, which an attacker could use to keep the operator out.

**What may be dialled is now two policies, and they live in different places on
purpose.** The ADDRESS policy — a destination must resolve to a public address —
is a constant in `lib/netguard.js` with no config key at all; the only way past
it is the command-line flag `--allow-private-ips`, optionally scoped
(`=127.0.0.0/8`), which warns at boot and again on every dial it permits. The
PORT policy is entirely `config/site.json`'s `blockedPorts`: netguard holds no
list and no default, so what that file says is what is refused and nothing else
is. Entries are a port or a `"lo-hi"` range, which is how the well-known range is
expressed while leaving 23 dialable. A LISTED board is exempt from the port
policy and never from the address one — a board's DNS belongs to its sysop. The
name is resolved once and the socket opens to that address, so the thing checked
and the thing connected to cannot differ.

**Both config files are strict, and invalid configuration stops the server.**
Missing, unparseable, an unknown key, or a value of the wrong type, in either
file, in any setting: `lib/configload.js` reports every problem at once and
`server.js` exits before it listens. Keys beginning with `_` are notes. A setting
that is renamed or removed in future needs an entry in that module's `MOVED` map,
or an existing deployment's file fails on upgrade — that is the maintenance cost
of the rule and it is worth paying.

**A call that does not come up sounds like one that did not come up.** Dial tone
runs from the moment Connect is pressed, covering the socket opening and the name
lookup, and is cut when there are digits to send. Anything that stops the call —
refused, timed out, unresolvable, unlisted under bypass, or the per-board limit —
gets the same answer: reorder (fast busy), `BUSY` on screen, then silence. The
answers are identical on purpose. `DIALTONE_S` must stay under `BUS_LEN`, and
under it `resolveTimeoutMs` < the browser's own deadline < the tone, or the tone
runs out before the answer arrives.

**Session and per-board limits.** `maxSessions` caps concurrent calls
server-wide; `maxPerBoardConcurrent` caps calls to any one board, keyed on its
RESOLVED address so two names for one machine cannot double the allowance.
`noDialTimeoutSeconds` and `carrierTimeoutSeconds` close a socket that never
dials and a dial that never trains — neither is reachable by a caller, because
the page opens a fresh WebSocket for every Connect.

**Telnet bypass is now gated, and only telnet bypass.** A modem call is paced by
its own handshake; `link:'direct'` connects the instant the dial lands, so it
carries the two limits the modem path gets for free: the board must be one the
directory offers (either tier, after the blacklist), and one dial **server-wide**
per `directMinIntervalSeconds` (10). Global, not per client, on purpose: an
abuser has more addresses than a real visitor has patience, so a per-IP bucket is
what a rotating source defeats and a single user never notices. The modem path is
not limited at all, so the worst case under attack is that bypass queues while
every modem speed keeps working. The interval is a **silent delay** — nothing is
said, and hanging up early buys none of it back. Both are `config/site.json`;
`directRequireListed: false` turns the first off.

**The guide cache is append-only, and every entry carries a first-seen date.**
Each monthly edition is merged in rather than replacing the cache: a board that
leaves the guide is kept, `added` is written once and never rewritten, and the
blacklist stays the only thing that removes a board. Identity is name +
host:port (`entryKey`), so the ten same-address listings the guide publishes
stay distinct — at the cost of a renamed board appearing beside its old entry.

**The guide tier sorts three ways** — alphanumeric, most dialed, newly added — from
three acting options under the `↗ Open telnetbbsguide.com` entry, in the same
style. The choice persists; the second key is always alphabetical; only the
guide moves, because Favorites and Featured are in an order somebody chose.
"Newly added" is the date THIS instance first saw the board, which is why the
merge above has to be append-only for it to mean anything. The three read
`[Sorting by …]` for the one in force and `[Sort by …]` for the other two.

**`connect=auto` dials on load with no prompt, speaker muted for that call.**
For a kiosk or a board embedding its own link. `connect=1` still prompts, and
for the reason in main.js: without a gesture the AudioContext stays suspended
while the DSP runs on, so the handshake would play back over an already-live
session. `auto` drops that audio rather than deferring it. The stored speaker
preference is never written — it comes back on the next dial, and on the next
load regardless.

**`trustedProxies` takes CIDR blocks.** v4 and v6, alongside literal addresses,
because Cloudflare publishes ranges and exact matching left the setting with no
usable value. It gates ATTRIBUTION only — which peers may speak for someone else
through `CF-Connecting-IP`/`X-Forwarded-For` — and refuses nobody; closing an
origin to direct traffic is a firewall or a tunnel. A configured list where
nothing parses now trusts NOBODY, so a typo can only tighten it.

**The blank-terminal-after-backgrounding fix now REBUILDS rather than
invalidates.** The old `repaintAll` assumed only the visible canvas was
discarded; Android discards the glyph atlas too, and an atlas that comes back
empty makes every blit draw nothing — the screen stays black through a redraw
while the cursor, a `fillRect`, still moves. `renderer.restore()` reads one
recorded opaque pixel to tell a live sheet from an emptied one, rebuilds the base
sheet from data already in hand (never the network), and drops only the tinted
sheets that were actually lost. `tools/tests/atlastest.js` covers both draw
paths, with the old invalidate-only behaviour as the negative control.

**The terminal answers the mouse, and it is desktop-only.** Drag to select and
copy, click a URL to open it, click a menu key — `[L]ogin`, `(A)bort`, `1. New
game` — to send that character, click it again without moving off to send Enter,
and click BLANK screen for Enter. A click that lands on a character which is not
a menu key sends nothing: that is a near miss on the key beside it, and answering
a miss with Enter hands the menu a choice nobody made. The click that brings the
window back from another application only focuses. Selection sits after zoom in
`terminalPressActions`, so `zoomEnabled()` stays the single gesture arbiter, and
touch never reaches any of it. Ported from synthdoor's `app.js`, which is where
the predicate came from; `terminal.js` and `renderer.js` had carried the other
half since the port with nothing wired to it.

**Right-click opens a paste box.** A panel with a real `<textarea>`, which IS the
mechanism: it takes the browser's own paste, so nothing asks for clipboard
permission and nothing depends on `navigator.clipboard.readText()`, which
browsers refuse. Ctrl+V is untouched and still sends 0x16, because BBS editors
use it. Nothing pasted is stripped or rewritten. It works with no carrier too —
`modemWrite()` routes to the AT command line, so a pasted `host:port` dials — and
with one it says what the send will cost (`4,812 characters · ≈ 2m 41s at 300
bps`), which is a better answer than a length cap.

**A live carrier no longer claims every keystroke on the page.** The window-level
handler ran `if (nav || carrier || cmd)`, with the form-field exemption on `cmd`
alone, so a field the user had deliberately clicked into stayed empty while what
they typed went down the wire — the paste box, and the manual host:port field
before it. The new `isTextEntry()` gates the carrier branch. It is deliberately
NOT `isFormField()`: that one counts a BUTTON, which is what holds focus straight
after any toolbar press.

**Copy decodes through the active font's charset.** `getSelectionText()` takes an
optional table; omitted it is CP437 and byte-for-byte what it was, supplied it is
`charsetOf(activeFont).chars`, so an Amiga board reaches the clipboard as the
Latin-1 punctuation it drew rather than as box drawing.

**A third party can now put a live terminal on their own page, and the share
panel builds the code.** `public/embed.js` is a new served file defining
`<synthlink-terminal>`, which is an iframe of this page and nothing more: its
attributes are the query keys `parseShareParams` already reads, and it takes the
frame's origin off its own script URL (`document.currentScript`) so the embedder
states it once. The share panel grew a second view — `#shareview-embed`, swapped in
place of the link view rather than stacked as a dialog — that prefills from the
current selection and hands back the element snippet and an `<iframe>` fallback,
both carrying `allow="autoplay; fullscreen"`. Its speed menu is CLONED from the
header's each time it opens, minus `direct`. **`buildShareURL` is untouched**:
`buildEmbedURL` is a sibling, because a share link is always a prompt or nothing
while an embed has three modes, and `sharelinktest`'s assertions had no reason to
move. No server change — `server.js` sends no framing header and already
serves `.js`. README.md is the embedder-facing half; `embed.js`'s own header
block is the reference for the rest.

**The embed view is now fields and snippets only.** Its two explanatory
paragraphs are gone — the box rules, the `allow` attribute and the muted-start
under `connect="auto"` live in README.md, which is where an embedder reads them
without the dialogue paying for it in height. The `Speed` and `On load` selects
span the full row (`label.wide`) and the on-load options read `Connect prompt` /
`dial on load` / `wait`: a `<select>`'s intrinsic width is its longest option,
and at two columns on a phone both menus truncated mid-word. The option VALUES
(`prompt`/`auto`/`none`) are the contract and did not move.

**`public/embed.js` is a CLASSIC script, and must stay one.** It shipped as
`type="module"` for one revision and failed for every real embedder: a module is
always fetched in CORS mode, so a cross-origin one needs
`Access-Control-Allow-Origin`, and the server sends none — Chromium said the
header was missing, Firefox said "Module source URI is not allowed", both against
a 200 response. Every harness stayed green because they all served the host page
from the app's own origin. `embedhosttest` now uses two origins, and the file has
no `import`, no `export` and no `import.meta` — any of the three makes it a
module again. The frame origin comes from `document.currentScript` instead.
Fixing it in the file rather than adding a CORS header keeps embedding a
zero-configuration thing for the operator, which is worth more than the module
syntax.

**The default embed box is 90% × 90vh, centred, and both units are load-bearing.**
A percentage HEIGHT resolves only against a containing block with a definite
height — a frame in an article has a parent of `auto`, so it would compute to
`auto` and collapse the frame to 150px. Width percentages always resolve, so the
width is one, and it keeps the frame inside the embedder's column rather than
overhanging it. The height was 600px for one revision and that was wrong for a
different reason: at 600 or under, the app's own `@media (max-height: 600px)`
short-viewport rule takes over and the page scrolls instead of the on-screen
keyboard shrinking the terminal. **A frame IS the viewport for the document
inside it**, so that rule fires on a 600px frame in a tall window exactly as it
does in a 600px window — measured both ways, they are identical, and the CSS was
not touched.

**An embed opens with a Connect prompt, not a dial.** `connect="1"`. An embed
that dialled the moment somebody scrolled past would open a socket nobody asked
for, and the press is also the gesture that lets the AudioContext start, so the
handshake is heard from its first tone rather than muted for that call.
`connect="auto"` is still there for a kiosk.

**UI additions this cycle.** `Alt+C` connects and `Alt+X` hangs up — one button
between them, so each is gated on the call state rather than toggling `#dial`
blind. The on-screen keyboard's cycle key is relabelled `↑@#` on all four views,
and view 1 gains an amber `#` that jumps straight to the numpad.

**Earlier UI additions.** The "BBS" label opens a directory panel — add or
remove the favourite, search the Telnet BBS Guide for it, or draw a random board
and dial it on the spot (`ATDT RANDOM`, in effect). Alt+K/A/Z/M/Enter drive the
keyboard, font, zoom, speaker and fullscreen toggles on desktop. The scrollback
button carries the same crossed-out sign the zoom button does when it is off.
The on-screen keyboard has a width floor, so 40-column mobile landscape cannot
shrink the keys past their own labels. The header no longer gains a control row
for a manual host:port entry or a dial — `fitBar()` was measuring at the control
column's max-content width, which understates the row (see the watch-outs); the
regression is covered at three desktop widths in `uitest` §6d. The terminal
repaints on
`visibilitychange`/`pageshow`, which is the blank-screen-after-backgrounding
report.

**The on-screen keyboard's phantom long press is fixed.** Cap/symbol, Ctrl and
Shft latched on a single tap on a phone, embedded. The hold is now captured by
the keyboard ROOT — `render()` empties `kbdEl` but never replaces it, where touch
implicitly captures to the BUTTON that same `render()` destroys — so the timer
consults `hasPointerCapture()`, live state, rather than trusting that a cancel
event was delivered. A capture-phase `pointerdown` on the root ends the previous
hold before the next one is armed. Confirmed by hand, embedded; STICKYFIX.md
shipped and is deleted.

**A pre-roll splash covers the gap before the app is up, and nothing in the
showing of it is scripted.** `public/splash/` plays on the lowest layer from the
first paint; the app assembles over it; it fades out when the terminal has drawn,
the fonts have settled and the welcome panel — if it showed — has been closed.
The still frame is the video's frame 1 inlined as a data URI (so it paints with
the HTML, no round trip), the video is revealed by a CSS ANIMATION over the
element's own `poster`, and playback is the `autoplay` attribute. That division
is the whole design: behind a bot check an injected script can hold the main
thread, and the reveal used to be a `playing` listener — an event that fires
once and is lost for good if the listener is late. Only the fade-out is
JavaScript, and a late fade-out is the harmless direction. Duration is
`config/site.json`'s `splashFadeSeconds` (default 5, 0 = no fade), read back off
the computed style so the number lives in one place. It waits on **either**
greeting: `welcomeSettled` for the panel, `dialSettled` for the Connect prompt a
shared `?connect=` link raises in its place.

**Fonts are closed out and FONTS.md is the reference.** Every shipping font is
an outline font. The Aa button's three slots, in cycle order, are the AST
PremiumExec outline (**Pixel**), Flexi False 1.60 / True (**Modern**, by screen
width) and the IBM VGA 9×14 outline (**Squat**, which is 40-column mode). The
default is Pixel on both devices. Two bitmaps remain in the registry, both
hidden and both with a stated job.

---

## Forward — next steps

1. **Protocol authenticity backlog → PROTOIMPROVE.md. Nothing there is blocked.**
   Constellation figures used to refuse; that was the summarising retrieval, not
   the figures. The converted Recommendations in `tools/datasource/` carry the
   labels as text, and PROTOIMPROVE.md names the page each figure is on.
2. **V.32bis multi-rate + rate renegotiation — the next piece of work**, and the
   V.90 CRC register direction, which is the cheapest item left.
3. **Real-modem interop path** for the new protocols. Gap analysis in
   PROTOCOLS.md.
4. **Pending, not started:** 2-wire mode (2WIRE.md) and V.92 (V92NOTES.md).
5. **The blank-terminal repaint is a mitigation, not a diagnosis.** It assumes
   a backing store discarded while the page was hidden. If the symptom survives
   on a real device, the assumption is the thing to re-examine — a lost atlas
   would present identically and would need a rebuild, not an invalidate.

## Watch-outs when picking up

- **The heart is a STATE INDICATOR that opens a panel, not a toggle.** Wiring it
  back to `toggleFavorite` would take the guide search away from anyone on a
  call, which is the one place it could not be reached before. And the panel's
  Random must stay withdrawn while a call is up: it dials, and the destination is
  locked for the duration.
- **The bypass rate cap must never drop a byte.** A dropped byte in a BBS session
  is a corrupted screen, and it would read as a telnet bug rather than as this. A
  pacer that cannot keep up pauses its SOURCE; anything that trims a queue
  instead is wrong however deep the queue got.
- **The rate cap is as silent as the dial interval.** No message, no status line,
  no close reason, nothing in the UI. `directtest` §4c asserts the absence.
  Telling a caller they are being paced hands them the calibration.
- **A test payload that crosses the telnet filter must avoid 0xFF.** It is an
  IAC, and the filter consuming it is correct — a counter mod 256 in `directtest`
  §4c looked like the pacer losing 319 bytes.
- **The sysop routes are 404 when disabled, and that is the assertion.** Not 401:
  a 401 tells a scanner the route exists and is worth a wordlist, and the only
  visitors `/sysop` will ever have on an instance that has not enabled it are
  scanners. `sysoptest` pins it in both directions.
- **The sysop page is in `lib/`, not `public/`.** Everything under `public/` is
  served to anyone who asks, so a status page there would be world-readable
  markup however well the data route were gated. Moving it "where the other HTML
  lives" un-gates it.
- **The four `sysop*` keys default to off and absent means off**, which is the
  only reason an existing deployment upgrades onto this version without editing
  its config file first — `configload.js` is strict, and a required new key would
  stop every server that has not been touched. Any further setting here has to
  keep that property.
- **`sysopPasswordHash` is validated by `lib/sysop.js`'s own parser at boot**, so
  a password pasted in where the hash goes stops the server with a message rather
  than producing one that starts and then refuses the operator's own password.
- **Basic is worth what the transport is worth.** The credential goes up on every
  poll. Behind TLS or Cloudflare that is fine; on a plain-http origin it is in the
  clear on the LAN, and that is a deployment fact rather than something the code
  can fix.
- **A directtest section must set the overrides it needs.** The registry section
  lifts `maxPerBoardConcurrent` because the section above it leaves its cap in
  force and the sections before that leave live calls to the mock BBS open on
  purpose — without that the new call is refused at the limit, which looks like a
  broken registry and is the limit working. It also waits out `THROTTLE_S`, since
  a bypass dial read too early is legitimately still `dialing`.
- **GPL-3.0 did NOT make linmodem available.** It is GPL-2.0-**only**, which is
  incompatible with GPL-3.0 exactly as it was with LGPL-3.0 — the clean-room
  discipline on V.34 and V.90 is unchanged, and "we're GPL now so linmodem is
  fine" is the wrong inference. PROVENANCE.md §4.
- **Licence headers are load-bearing.** The SPDX and attribution blocks on the
  spandsp- and synthdoor-derived files are notices, not commentary. Do not strip
  them in a refactor; they reach the browser through the bundle.
- **Copy `config/*.example` into place before running any suite.** The repo ships
  only the examples; a fresh clone has no `config/site.json`, `configload.js` is
  strict, and `httptest`/`altfonttest` fail outright. Worse, the harnesses that
  swap in a scratch config have nothing to restore, so `logtest` leaves
  `config/logging.json` pointing at its own `/tmp` directory and every later suite
  reads it. → CLAUDE.md.
- **A quarter constellation is a set of rotation representatives, and "first
  quadrant" is the wrong guess.** V.34's Figure 5 quarter is a mod-4 sublattice
  spanning all four quadrants; the quadrant assumption round-tripped perfectly for
  years because both ends agreed, and the harness *asserted* it. Neither a
  round-trip nor a bijection check can see this — only the printed figure can.
- After ANY change under `vendor/` → `npm run build`, then the browser-path
  safety check (CLAUDE.md). A stale or Node-tainted bundle looks like "server
  connects, browser doesn't".
- Don't run `server.js`'s WS listener from a harness in the sandbox — it hangs.
- **The audio sink is a ScriptProcessor on purpose.** Scheduled buffer sources
  were the Chrome crackle; AudioWorklet is secure-context only, so it does not
  exist on a plain-http origin — a phone reaching the server by LAN address got
  silence with a working scope, and nothing threw. Neither is a step forward.
- **A browser audio harness must load a NON-loopback address too.** Loopback is
  a secure origin by exception, so a suite that only loads 127.0.0.1 passes on a
  build with no audio on any phone. `sinktest` runs both.
- **Never weaken an assertion to make a suite green** — delete it or fix the
  code. The cleanup exists because a "the default is reachable from the cycle"
  rewrite passed for exactly the broken arrangement a user then hit. The rule it
  was protecting ("the default must be slot 0") turned out to be **fictional**:
  the Aa cycle is modular (`(fontIndex + 1) % cycle().length`), so from any
  starting slot every slot is visited and a full lap returns to the start. The
  assertion should never have existed. It has been deleted, along with the three
  documents that repeated it.
- **`renderer.cellAt()` is the ONLY pixel→cell mapping, and it lives there for a
  reason.** A hybrid font's columns do not share a pitch, so dividing by `cellW`
  lands on the wrong one wherever the edge table widened a cell; the table is
  rebuilt on every resize and font change, and a second copy of that arithmetic
  would go stale at the next Aa press. It is the inverse of what the selection
  overlay already draws from.
- **Anything a click acts on comes from `getDisplayCells()`, and anything that
  sends calls `snapToLive()` first.** Scrolled back, the live screen holds
  different text at the same row number, so a click reading it acts on something
  the user cannot see.
- **A menu key sends the RAW cell byte.** Decoding it to a character and
  re-encoding truncates anything above 0x7F — CP437's 0xB0 is U+2591, which
  leaves as 0x91.
- **A selection is dropped on any re-flow.** `fitTerminal()` does it: a re-flow
  rebuilds the screen from its own lines, so held coordinates stop meaning what
  they meant. Any other answer is subtly wrong.
- **A uitest section that needs a live CARRIER opts in with
  `boot(..., { answerConnected: true })`**, which answers the dial and echoes
  what is sent. Everything else gets the deliberate silence it was written
  against. Modem bypass is the only route to a carrier here — a real one needs a
  DSP. And a live call has already printed its banner, so a test that wants known
  text at a known row must CLEAR the screen first rather than assume row 0.
- **Fonts: read FONTS.md before touching any of it**, and the registry header
  block in `public/fonts/index.js` before touching an entry. §11 is the method
  for a board-specific font, and CLAUDE.md has the checklist.
- **`config/altfonts.txt` ships with NO live entry.** aBSiNTHE is what the
  feature was built for and its address is not in this repo — put the real
  `host:port` on the line the file already holds and it goes live on the next
  request. Until then the map is empty and every board keeps the user's font,
  which is exactly the behaviour that predates the feature.
- **`cellW` cannot exceed 32.** `glyphRowBits` packs `stride * 8` bits with
  32-bit shifts, so a wider font silently loses its top byte and the classifier
  reads garbage for the left columns. Nothing throws. Largest shipping is 27.
- **A charset belongs to a FONT.** Adding a per-board charset field would put
  the answer in two places; a registry entry already carries the face, the
  encoding and the column count, which is why `altfonts.txt` names one id and
  says nothing else. SyncTERM resolves it the same way.
- **A glyph artifact that only one browser shows will not reproduce in a
  harness.** Chromium headless rasterizes canvas in software, which clamps
  `drawImage` to its source rect and rasterizes these faces to a clean 0-or-255;
  both of the Chrome bugs above were invisible to it and to `getImageData`, and
  were pinned down by measuring the user's screenshots instead. Reason from which
  glyphs are affected — the answer both times was a property they shared, not a
  property of the browser.
- **`hidden` is load-bearing, and the default is an outline font.** `vga8x16` is
  `FALLBACK_FONT_ID` (an outline font cannot be its own fallback); `vga9x14hr`
  is the 40-column reference arm, the only 9-wide bitmap exercising the 2-byte
  stride, and `boxjointest`'s positive control. A hidden entry stays if it has a
  **stated job**. Expect first paint to draw backgrounds only until the font
  file lands.
- **Editing a glyph in a font asset? Move its `hmtx` lsb with it.** A mismatch
  against `glyf`'s `xMin` shifts the glyph in its cell, silently.
- **Never hand `layout()` a height you derived from the width.** It does the
  aspect arithmetic itself, so a pre-fitted, floored height comes back as a
  height constraint and silently narrows the terminal. That is a width bug whose
  cause is a rounding on the other axis, and it shipped.
- **Line continuation is RECORDED, not inferred.** `Terminal._wrapped[]` is set
  when `putChar` runs off the right margin. Anything that moves rows must move
  the flags; anything that erases a row's tail must clear them. Do not
  reintroduce the "a full-width row is a continuation" heuristic — it cannot see
  a wrap landing in a run of spaces, which in a BBS is most of them. And a
  **wrapped row is never trimmed**.
- **A browser harness that intersects samples across the cursor blink must time
  the gaps INSIDE the page.** Driving them from Node produced a flake blamed on
  the re-flow code for several sessions.
- Adding a protocol touches five places, and a missed `server.js` `PROTOS`
  whitelist falls back to V.21 silently. → CLAUDE.md.
- **`MS_COMMANDS` must name only options the menu offers.** A resolved `AT+MS=`
  sets the `<select>`, so a row with no `<option>` leaves the control blank and
  the next dial reads whatever it fell back to. That is why dropping V.29 and the
  V.34 sub-rates from the menu dropped their rows too, and why `AT+MS=V29,…` is
  now `ERROR`. The protocol code is untouched either way.
- **A `<select>` in a narrow grid is as wide as its longest option**, and
  `min-width:0` on the control does not help: the grid item is the LABEL, and a
  grid item's automatic minimum is its min-content width. Chromium happened to
  shrink it anyway; Safari does not. The two embed selects span the full row and
  the label carries `min-width:0`.
- **A harness that dials loopback in bypass mode must deal with the gate.**
  `directtest` wraps `lib/bbslist` and `lib/site` at `Module._load`; `idletest`
  turns `directRequireListed` off in the scratch `site.json` it already writes.
  Do NOT edit the operator's `config/site.json` or `config/curated.txt` to get a
  test through — that is the trap CLAUDE.md names for `logtest`/`sitetest`.
- **The bypass rate limit delays and never speaks, and it is GLOBAL.** Anything
  that reports it to the user — a toast, a status line, a different close reason
  — hands an abuser the calibration the silence is there to deny. Making it
  per-client would look more correct and be weaker: rotating addresses is the
  cheap half of the attack.
- **`trustedProxies` is attribution, not access control.** It decides which
  peers may speak for someone else through `CF-Connecting-IP`/`X-Forwarded-For`;
  it refuses nobody. Entries are addresses or CIDR blocks (v4/v6). A list where
  nothing parses trusts nobody, deliberately — a typo must not reopen spoofing.
- **A long press promotes only while the browser says a pointer is still
  captured**, and the capture is held by `kbdEl`, not the key. Do not move it
  back to the button: touch captures there implicitly and `render()` destroys
  that button in the same handler, which is how a press nobody held got
  promoted. Absence of a cancel event is not evidence of a finger still down —
  a Set of pressed ids cleared from those events was tried and made it worse,
  because one missed release poisoned every tap after it.
- **A splash gate must settle when its box never opens, and settle where the box
  is DECIDED on.** `dialSettled` resolves right after `shared` is parsed for a
  visitor with no `?connect=` link, not inside `maybeAutoConnect` — that runs
  only once `/bbs.json` is back, so gating there holds the splash over an
  already-up page whenever the directory is slow. With a shared link and a fetch
  that never settles, the prompt never opens and the splash stays: accepted, the
  page cannot dial in that state either.
- **A new on-screen key KIND must be added to `kbdmodtest`'s skip list.** Every
  key is asserted to send bytes; `cycle`, `mod`, `alt` and now `goto` are the
  exceptions, and a fifth kind fails there rather than at the keyboard.
- **An embed must never be handed telnet bypass.** Bypass is one dial
  server-wide per interval and the delay is silent, so an embed dialling through
  it would queue behind every other embed anywhere with nothing said. The
  wizard's speed menu clones the header's and drops `direct`; `embedtest`
  asserts the omission against the real menu in `index.html`.
- **The embed snippets are MARKUP, not links.** `embedAttr` escapes them, so the
  query separator is `&amp;`. A raw `&` is invalid in an attribute and some
  parsers swallow what follows, which loses the speed and the connect mode
  silently — and correct-as-text, wrong-as-markup is exactly what a unit test
  cannot see.
- **A harness that serves the host page from the app's own origin is not testing
  an embed.** Same-origin hid the module/CORS failure completely: the snippet was
  correct, the file was 200, and the script simply never executed anywhere but
  the harness. `embedhosttest` serves `embedder.test` and `bbsdial.test` for that
  reason, and anything added there should keep the two apart.
- **The element copies its attribute VALUES into the query verbatim**, which is
  what "no second parameter vocabulary" buys and also its one trap: the wizard's
  mode names (`prompt`, `none`) are NOT query values, and `connect="prompt"`
  would reach `parseShareParams` as an unrecognised — therefore falsy — value and
  silently never prompt. `embedConnectValue` is the one mapping; it shipped wrong
  for a day and `embedtest` now pins it.
- **`<synthlink-terminal>` has no method and no event, deliberately.** Both mean
  `postMessage` and a message contract to version, and no embedder has asked. The
  attribute surface is the whole product; `embedtest` asserts the absence.
- **Backgrounding a mobile browser ends a modem call, and this is NOT being
  fixed.** A stall watchdog that named the cause was built, fired on desktop at
  times unrelated to a backgrounded page, never fired on a real Android
  backgrounding, and has been reverted — a watchdog cannot tell a frozen page
  from a busy one, and no threshold changes that. Not a bug to re-open, and not
  an oversight: README.md states the behaviour for users, DEVLOG.md has the
  attempt. The `repaintAll` handlers on `visibilitychange`/`pageshow` are a
  DIFFERENT fix (a blank terminal after backgrounding) and stay.
- **Anyone may embed, and that is a decision rather than an omission.** Nothing
  sends `X-Frame-Options` or a CSP `frame-ancestors`, which is why embedding
  needed no server change at all. If an operator ever wants to restrict it to
  named partners, `frame-ancestors` is the single lever — and adding it silently
  breaks every existing embed, so it belongs in `config/site.json` beside the
  other operator choices, never hard-coded.
- **Embedded dials merge into the public `bbsstats` totals**, per-board counts
  and the idle status's "dials total from all users" alike. They are dials, so
  that is defensible — but it changes what those numbers mean once an embed sees
  real traffic, and nothing separates them after the fact.
- **`isSentinel()` is the one predicate for an option that is not a
  destination.** Adding a `@`-value without it puts that string into `#host` by
  way of renderBBS()'s "adopt what's displayed" branch.
- **A harness that dials loopback needs `--allow-private-ips=127.0.0.0/8`.**
  `directtest` and `idletest` carry it themselves; `tools/echo-bbs.js` prints the
  invocation. Do NOT relax the address policy to make a local test pass — that is
  what the flag is for, and moving the mock BBS cannot help, because every
  address on the machine is loopback or RFC1918.
- **`config/site.json`'s `blockedPorts` is the whole port policy.** There is no
  list in code to fall back on, so emptying it blocks nothing — and `directtest`
  reads the real file, so emptying it fails that suite.
- **A scratch config a harness writes must be complete and valid**, or the server
  it drives will not start.
- **`connectTimeoutMs` moved from `config/logging.json` to `config/site.json`.**
  A value left in the old file names the new one and stops the server.
- **The bus must never be left unattended with a sound in it.** `_pump()` zeroes
  the span ahead before reading it out; without that, a ring with nothing writing
  to it replays its own contents every `BUS_LEN`. Any clip must also be shorter
  than `BUS_LEN` or it wraps and overwrites its own head in `_mix`.
- **Whichever destination control is on screen is the one that gets dialled.**
  `connect()` reconciles to it first — `commitHostPort()` in manual mode,
  `commitBBSSelection()` in directory mode. The second is not optional: re-picking
  the option a `<select>` already sits on fires no `change`, so a dropdown left
  showing a board that is not the destination will keep showing it. Assert on the
  DIAL MESSAGE, never on the controls, and note that Playwright's
  `selectOption()` fires `change` where a browser would not.
- **Per-board dial counts are only kept for boards the directory offers.** The
  grand total counts every connect; a per-board key is minted only for a listed
  destination, and `counts()` is filtered again when served.
- **Every suite is expected to be green.** `attest.js` is 70/70. If a suite comes
  up red, CLAUDE.md standing rule 2 says what to do — and the short version is
  that you may not leave it red because it was red before you got here.
- **`dsptest2` sizes its budget per protocol.** Adding a protocol slower than
  9600 means adding it to that map, or it will look broken when it is only slow.
- **A spec figure is not a spec table.** Prose clauses and gridded tables
  transcribe; constellation figures refuse. Take the refusal — an invented map
  that both ends agree on is exactly the caveat this backlog exists to remove.
- **Gesture ownership is ONE predicate, and splitting it has been tried.**
  `gesturesFree()` — both switches off — is the whole rule. Handing the pinch
  back on the zoom setting alone (`touch-action:pinch-zoom` while scrollback is
  on) was implemented, passed in the harness, and did nothing on a device; it
  was reverted rather than left in. Anyone attacking this again should start
  from a real device, not from the predicate.
- **`fitBar()` measures at the width the column WILL GET, never at its
  max-content.** A wrapping flex container's max-content width is not the width
  its row needs on one line: `#dest`'s children are sized in percentages, which
  contribute nothing to intrinsic width, so clearing the override measured the
  column ~140 px short, the row wrapped *inside the measurement*, and that
  wrapped line became the pin. The header then kept a second row on a window
  with hundreds of spare pixels beside the scope. Any small width change could
  cross the threshold — a manual host:port field in place of the dropdown,
  Connect widening to Hang up. The measurement width is now the bar's content
  box less the gap and the scope's reserved min-width.
- **An Alt shortcut CLICKS the real button.** Not the handler behind it: each of
  those buttons owns state only its own click handler maintains (toast,
  persisted pref, cycle position), and a disabled button must stay inert from
  the keyboard too.
- **Don't reach for `isFormField()` to gate a keyboard shortcut.** It counts a
  BUTTON as a form control, which is what has focus right after you press one —
  a shortcut gated on it is dead from the first toolbar click onward.
- **The splash's reveal must stay script-free.** Poster + CSS animation +
  `autoplay`, with the still inlined in the document. Anything that makes the
  video's appearance depend on an event, a class or a fetch puts it back behind
  the delay it exists to hide — and a missed one-shot event leaves the splash
  stuck on its still frame with a good video playing invisibly beneath it.
- **`transitionend` BUBBLES, and the splash has two opacity transitions.** A
  removal listener on the container that does not check `e.target` is woken by
  the video's own fade and removes the splash on the spot: measured at 338 ms,
  with the 3s fade never running. The child fade is now an animation, so the
  hazard is dormant rather than gone.
- **The splash video is served with NO Cache-Control, and putting one back
  needs more care than it looks.** It went out `max-age=604800, immutable` for
  one revision and any browser that had been to the site before then showed the
  still frame and never played: a 206 cached under an immutable entry with no
  validator can be reused as though it were the whole file, and two bytes of MP4
  never play. Incognito was fine throughout, which is what made it look like a
  code change rather than a cache. Nothing could revalidate or bust it either,
  so the bad entry outlived the deploy that caused it and a rename was the only
  way out. Media caching belongs to the CDN in front of this. The byte-range
  answer is unrelated and NOT optional: Safari probes `bytes=0-1` and treats a
  200 as ranges-unsupported, which on iOS is a video that never plays and
  nothing logged.
- **"SynthLink" inside a link to the project's repository is not a hard-coded
  brand.** `sitetest` exempts it structurally — upstream attribution must
  survive a rebrand, while the tab title and panel copy must not. The name
  anywhere else in a served `.html` still fails, which is the point.
- **Don't trust a summarised spec table.** Asked normally, the retrieval
  *reconstructs* tables and returns confident wrong values. → PROTOIMPROVE.md.
