# SynthLink

A web BBS terminal that talks to a JavaScript server over a **real software-modem
link** — actual PCM audio carries the data — then proxies to arbitrary telnet
BBSes. The audio is real; a speaker button hears the carrier both directions.

```
browser: keystroke -> ModemDSP('originate').write -> PCM audio
   -> WebSocket -> server: ModemDSP('answer').receiveAudio -> demod bytes
   -> telnet filter -> telnet BBS
BBS bytes -> telnet filter -> answer.write -> PCM audio -> WebSocket
   -> browser: originate.receiveAudio -> demod bytes -> ANSIParser -> Terminal -> canvas
```

Nothing but modulated audio crosses the socket during a call, and telnet
terminates at the *server*, so option negotiation never costs carrier time. Two
exceptions: V.90's downstream carries PCM codewords rather than a modulated
carrier (still audio), and **Telnet · max speed** skips the modem entirely,
riding raw bytes over the WebSocket.

## Run

```
npm install
cp config/site.json.example    config/site.json
cp config/logging.json.example config/logging.json
npm run build          # bundles the browser DSP -> public/dsp-bundle.js
npm start              # http://localhost:8088 (port: config/site.json)
```

That is a working public instance, on the shipped defaults. `config/` holds only
`.example` files; the two copied above are the ones the server requires, and the
three optional lists beside them — your boards, the blacklist, board fonts — are
under **Configuration**.

Two things to know before you deploy:

- **Both JSON files must be present and valid or the server will not start.** A
  missing file, a stray comma, an unknown key or a wrong type prints every
  problem and exits.
- **A destination must resolve to a public address.** To dial the test BBS above,
  or anything else on your machine or LAN, start with
  `--allow-private-ips=127.0.0.0/8`. A public instance should never run with it.

## Using it

Pick a BBS or type a host/port, choose a speed, press **Connect**. The board is
dialled once the carrier is up rather than when you press Connect, so its own
timers do not run during the handshake — one consequence is that an unreachable
board is only discovered after the handshake. Dial tone plays throughout, and any
call that does not come up answers the same way: a reorder tone and `BUSY`.

The toolbar carries a real-time oscilloscope of the carrier with a live bps
readout (a network throughput graph in bypass mode), toggles for scrollback, the
on-screen keyboard, font, magnification and fullscreen, and an **ⓘ** panel. The
speaker cycles **Auto → Listen → Mute**; Auto plays through the handshake then
fades ~10 s after connect.

Defaults: `bbs.birdenuf.com:2003`, V.34, sound on. Destination, speed, font,
toggles and favorites persist per browser. A `connect=` share link overrides them
transiently without writing anything; `connect=auto` dials on load with no
prompt, speaker muted for that call only — there is no gesture to start audio
with, so the handshake could not be heard on time.

**Switching away from the browser on a phone ends a modem call**, and there is no
way around it: a modem link is a continuous real-time signal that cannot be
paused and resumed. The carrier runs on a timer, which a backgrounded browser
throttles or freezes, and iOS suspends the audio context outright. **Telnet · max
speed** builds no modem at all and survives it — worth choosing for a long
session you expect to leave and come back to.

**Touch.** The first touch opens the keyboard, the next magnifies, and your
finger pans until you release. Scrollback and magnification are **mutually
exclusive** — a pan and a scroll-swipe are the same gesture — and while either
owns the terminal a thin ribbed bar between it and the keyboard scrolls the page.
Turn both off and the browser's own pinch-zoom works over the terminal again. A
long press folds the oscilloscope to a thin line.

**Mouse.** Switch scrollback off, then click and hold to magnify, dragging to
pan. Scroll back with the wheel, the Alt keys (`Alt+PgUp/PgDn`, `Alt+↑/↓`,
`Alt+Home/End`) or the rail down the right of the terminal. Drag to select and
copy; click a URL to open it; click a menu key — `[L]ogin`, `(A)bort`, `1. New
game` — to send it, again to send Enter, and click blank screen for Enter.
Right-click opens a paste box.

**Keyboard.** `Alt+K` keyboard, `Alt+A` font, `Alt+Z` magnification, `Alt+M`
speaker, `Alt+Enter` fullscreen, `Alt+C` connect, `Alt+X` hang up.

**Typed commands.** Offline the terminal is a modem command line: `AT+MS=<mod>`
picks the speed, `ATZ` selects bypass, `ATDT host[:port]` dials, and `ATDT
RANDOM` draws a board from the directory.

### Fonts and 40-column mode

The font button offers **Pixel** (an AST PremiumExec letterform), **Modern** (an
outline face, a different file on a phone than a desktop) and **Squat**.

**Squat** also switches the terminal to **40×25**, and is the only way to reach
it. It is a 9×14 cell, and the name is the cell rather than the column count: a
9-wide, 14-tall cell is both wider and shorter than the 8×16, so 40 columns makes
the terminal 1.56× taller where any 8-wide font would make it exactly 2× and
unusable. The width is sent as the telnet window size when the call is placed, so
**switch before you dial** — changing it mid-call resizes your end only. Whatever
is on screen is re-wrapped rather than cleared.

Some boards are served their own font and character set automatically (an Amiga
board's art is Topaz and ISO-8859-1, not CP437). The button says so and goes
inert for that call; your own choice is back on hang-up and nothing is written to
your stored preference. Configuring it: **Board fonts**, below.

### BBS directory

The dropdown has a curated tier, the Telnet BBS Guide's list, and your favorites.
From the moment you press Connect the **BBS** label becomes a heart that adds or
removes the board being dialled. A **Random BBS Selection** entry picks from
across both tiers. Three entries under the guide's link sort that tier
alphanumerically, by most dialed, or by newly added — the choice persists, and
each entry shows its dial count as a bare `(##)`.

### Putting a terminal on your own page

The share panel's **embed** button builds the code: pick the board, the speed, a
size and what the frame does on load, then copy either the custom element or the
plain iframe offered beside it.

```html
<script src="https://YOUR-HOST/embed.js"></script>
<synthlink-terminal host="bbs.example.org" port="23"
                    speed="v32bis" connect="1" width="90%" height="90vh">
</synthlink-terminal>
```

It is an iframe underneath, and the attribute values are the query parameters a
share link already uses — `connect="1"` is a Connect prompt, `connect="auto"`
dials on load, and leaving it out is a terminal that waits. Nothing to configure
on the server: anyone may embed, and no CORS header is needed, because `embed.js`
is a plain script rather than a module. **Do not add `type="module"` to that
script tag** — a module is always fetched under CORS rules, and an embed is
cross-origin by definition, so it would be blocked outright.

Any CSS length works for the box; the defaults are 90% wide, centred, and 90vh
tall.

- **Height in `vh`, not `%`.** A percentage height needs a parent with a height of
  its own, and in an ordinary page it collapses the frame to 150px. Keep it
  comfortably above 600px too: below that the terminal switches to its
  short-viewport layout, where the page scrolls rather than the on-screen keyboard
  shrinking the terminal. A frame is its own viewport, so that happens in a short
  frame on a tall screen exactly as in a short window.
- **Keep `allow="autoplay; fullscreen"`.** A nested page is gated harder than a
  top-level one; without it a visitor's click cannot ungate the speaker and
  fullscreen is refused.
- **Under `connect="auto"` the speaker starts muted for that call**, deliberately:
  the cycle is Auto → Listen → Mute, so a muted start makes the visitor's first
  press give Auto, and the next dial is heard from its first tone and then fades.
- **Use a modem speed.** The builder does not offer bypass, which is rate limited
  server-wide with a silent delay, so an embed dialling through it would queue
  behind every other embed anywhere.

Stored preferences — speaker, font, favourites — are per origin, so an embed
shares them with the standalone site. For mobile, the embedding page needs:

```html
<meta name="viewport" content="width=device-width, initial-scale=1">
```

## Configuration

**`config/` ships only `.example` files.** Nothing else there is committed, so a
`git pull` can never write over the settings, board list or blacklist a running
instance is using. Copy an example, drop the suffix, edit it; each is the shipped
default and is safe to run as-is. Keys beginning with `_` are notes, which is how
a file documents itself and still validates once renamed.

Two are required — `site.json` and `logging.json`, both strict, both fatal if
missing or wrong. The three plain-text lists are optional and read live, edit and
reload, no restart; with none of them you get no favourites tier, nothing
blacklisted, and every board drawn against CP437.

A renamed or removed setting fails an existing deployment's file at boot rather
than being ignored, so after a pull that changes an example, diff yours against
it.

### What may be dialled

Two policies, deliberately in different places.

**Address** — a destination must resolve to a public address; loopback, private
and link-local ranges are refused. This is a constant with no config key. The
only way past it is `--allow-private-ips`, optionally scoped
(`=127.0.0.0/8`), which warns at boot and on every dial it permits.

**Port** — entirely `blockedPorts` in `config/site.json`: a port or a `"lo-hi"`
range, and the shipped list refuses the well-known range except 23. It applies to
hosts the directory does not list; a listed board is exempt, since some answer on
80 or 443 to get through a firewall. There is no list in code to fall back on.

**Telnet bypass is gated further**, because it has no handshake to pace it: it
dials only boards the directory offers (`directRequireListed`, default true), and
one dial **server-wide** per `directMinIntervalSeconds` (10) — shared by everyone
rather than per client, since an abuser has more addresses than a real visitor has
patience. It is a silent delay. The modem speeds are unaffected, so the worst case
under attack is that bypass queues while every modem speed keeps working.

`requireListedForAllDials` (default false) makes *every* dial name a directory
board, which also removes manual host:port entry and `ATDT`.

### Site settings

`config/site.json`:

| Key | Default | |
| --- | --- | --- |
| `brand` | — | substituted into every served page wherever it writes `{{BRAND}}`, server-side as the file is served — renaming the front end is this one value and a restart |
| `tagline`, `titleSuffix`, `favicon` | — | the rest of the branding |
| `port` | 8088 | `PORT` still overrides for a one-off run |
| `idleDisconnectMinutes` | 30 | drop a call after this long with no payload either way |
| `scrollbackLines` | 5000 | the terminal's history ring |
| `connectTimeoutMs`, `resolveTimeoutMs` | 5000 | give up on a board, and on a name |
| `maxSessions` | 50 | concurrent calls server-wide |
| `maxPerBoardConcurrent` | 10 | calls to one board, keyed on its resolved address |
| `noDialTimeoutSeconds` / `carrierTimeoutSeconds` | 60 / 120 | close a socket that never dials, and a dial that never reaches carrier |
| `splashFadeSeconds` | 5 | pre-roll splash fade, range 0..30 |

0 disables any of them.

The splash video in `public/splash/` plays on the lowest layer from the first
paint, the page assembles over it, and it fades once the terminal has drawn and
the welcome panel has been closed — cover for the seconds a slow edge or a bot
check spends before the app is up. It is served with no cache headers of its own;
that is the CDN's to set.

### Board lists

`config/curated.txt` — `Name, host:port` per line, port defaults to 23, `#`
comments ignored.

Below it is the Telnet BBS Guide's monthly list, cached under `cache/` and
refreshed by a background check. To prime a fresh install by hand:

```
npm run update-bbslist -- --file /path/to/ibbs0826.zip
```

or by dropping the monthly zip into `cache/`. Each edition is **merged** into the
cache, never substituted for it: a board that leaves the guide stays, and every
entry keeps the date we first saw it — which is what "newly added" sorts on.

`config/blacklist.txt` (one `host` or `host:port` per line) drops a dead board the
guide keeps re-publishing. It survives every refresh and removes the board from
*both* tiers, but only controls what the list offers — a hand-typed address or a
shared link still dials. `telnetFailLog` is the worklist for it.

### Board fonts

`config/altfonts.txt` — one `host:port  fontid` per line — serves that board its
own font for the call. Naming the font is the whole setting: the registry entry
carries the typeface, the character set and the column count together. Ships with
no live entry. **FONTS.md §11** is the method for adding a face.

### Logging

`config/logging.json`, no environment variables. Three daily files rotate at local
midnight under `logs/` (set `dir` to move them) and are deleted after
`retentionDays`, default 30:

- `accessLog-*.log` — HTTP requests in Apache *combined* format, plus a line each
  for a session opening, a board being dialled, carrier up, and the call ending
  with duration and byte totals.
- `telnetFailLog-*.log` — every failed outgoing connection with the board's name
  and tier.
- `summaryLog-*.log` — one end-of-day block.

All three echo to the console. `debug: true` adds a line per buffer, for chasing a
stall.

`trustProxy` decides whether `CF-Connecting-IP` / `X-Forwarded-For` are believed
over the socket address, and `trustedProxies` limits that to given peers —
addresses or CIDR blocks, v4 or v6 (`173.245.48.0/20`, `2400:cb00::/32`), since
Cloudflare publishes ranges. It is **attribution only**: nothing here refuses a
request, so closing an origin to direct traffic is a firewall or a tunnel. An
entry that is not an address or a CIDR block stops the server rather than being
skipped. **Set `trustProxy: false` if the server is reachable directly**, or a
visitor can forge the address in the log.

## Protocols

```
V.21     300 bps      FSK; fastest handshake
Bell 103 300 bps      FSK
V.22     1200 bps     DPSK
V.22bis  2400 bps     16-QAM (with V.22 fallback path)
V.23     1200/75 bps  split-speed FSK
V.29     9600 bps     16-QAM, half-duplex ping-pong (Hayes "Express 96" style)
V.32     9600 bps     uncoded 16-QAM, true full-duplex
V.32bis  14400 bps    trellis-coded 128-QAM, true full-duplex
V.34     19200-33600  shell-mapped trellis-coded QAM
V.90     56000/33600  PCM codewords downstream, V.34 upstream (asymmetric)
Telnet   network      modem bypassed entirely; raw bytes over the WebSocket
```

The speed menu offers all of these except V.29, and V.34 as a single entry at
33600. Both are implemented and tested; only the menu is shorter.

Both ends must use the same protocol: the client sends its choice in the dial
message and the server matches it. Everything except V.29 negotiates through a
real **V.8** exchange (ANSam → CM → JM → CJ) before training; V.29 keeps its own
audible Hayes-style connect script. Bypass sends `link:'direct'` and constructs no
modem on either side.

**V.90 is the odd one, deliberately.** The server acts as the *digital* modem and
puts µ-law PCM codewords straight onto the wire while the browser acts as the
*analogue* modem and talks V.34 back — there is no modulation downstream at all,
the symbols **are** the 8 kHz samples. It sounds unlike the others: full-amplitude
PCM noise rather than a tonal carrier.

The 9600-and-above protocols are genuine ITU implementations written for this
project, all carrying the byte stream with authentic async start/stop (UART)
framing. A few answer-centric assumptions in the inherited DSP were relaxed for
JS↔JS use, gated behind flags in `vendor/synthlink-config.js`; they are safe only
because the WebSocket link is lossless and are **not** valid against real phone
lines.

**PROTOCOLS.md** is the authority on any of this: what is genuine versus
simplified, the handshakes, the relaxed flags one by one, and the real-modem gap.

## Provenance

SynthLink is **GPL-3.0-or-later**, © 2026 Joseph Quinn. `LICENSE` has the text,
`NOTICE` the third-party attributions — it travels with any redistribution.

The V.22/V.22bis DSP, the V.8 sequencer and V.23's coherent FSK demodulator are
JavaScript ports of **spandsp** by Steve Underwood, © 2003-2009, LGPL-2.1
upstream and distributed here under the GPL as LGPL-2.1 §3 permits. The V.21 and
Bell 103 FSK cores are synthmodem-native, and V.29/V.32/V.32bis/V.34/V.90 were
written for this project from the ITU specs. The browser render stack is from
**synthdoor**, MIT upstream. The terminal fonts are from VileR's Ultimate
Oldschool PC Font Pack and are **CC BY-SA 4.0**, licensed separately from the
rest of the repo and not covered by the GPL; **Amiga Topaz** is ISC, separate
again — `public/fonts/LICENSE` has both. The BBS directory is the Telnet BBS
Guide's monthly list, used by permission. Full attribution and spec references:
**PROVENANCE.md**.

## Documentation

**PROTOCOLS.md** per-protocol scope · **PROTOIMPROVE.md** authenticity backlog ·
**FONTS.md** rendering · **PROVENANCE.md** sources · **HANDOFF.md** status ·
**CLAUDE.md** working guide · **DEVLOG.md** history.
