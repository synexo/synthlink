# TELNETREFACTOR.md — move telnet termination from the browser to the server

**STATUS: DONE — steps 1–5 implemented** (`lib/telnet.js`, `server.js`,
`public/main.js`, `public/terminal.js`, `public/index.html`; tests in
`tools/telnettest.js` and `tools/directtest.js`). Steps 1–4 were confirmed
against real BBSes and fixed the compatibility symptom this plan was written for.

Step 5 (modem bypass) is now built, not just left room for. The dial message
carries `link:'direct'`; the server skips the DSP entirely and binary WS frames
carry payload rather than PCM in both directions. `transportWrite()` in
`server.js` is the swap point, and `linkUp()` is shared by both modes — carrier
for the modem, TCP connect for direct. The UI home is a **"Telnet · modem
bypass"** entry in the speed dropdown, as anticipated. With no carrier to show,
the scope box becomes a **network throughput graph** (auto-ranging so it stays
vertically filled, same bps readout, spectrum's colour ramp rendered as blocky
LED-meter segments); the speaker control stays enabled and Auto is held open
rather than faded, since it still gates ANSI music.

One deviation from the plan as written: step 1 says keep `TelnetFilter` in the
browser tree, unused. It isn't — `lib/telnet.js` *is* the retained copy, and
`public/terminal.js` points at it. Step 4's "keep the class" and step 1's "one
implementation" pull against each other once the browser has no live consumer,
and a dormant second copy is exactly the drift step 1 warns about.

Read CLAUDE.md first for the testing rules (in particular:
**do not start `server.js`'s WS listener from a sandbox harness** — it hangs).

---

## Why

Today the server is a pure byte pipe. `sock.on('data') → dsp.write()` and
`dsp.on('data') → sock.write()`, with no telnet awareness anywhere in
`server.js`. Telnet is terminated in the **browser** by `TelnetFilter`
(`public/terminal.js`), which means every IAC negotiation byte is modulated
across the modem link in both directions.

Three reasons to move it:

1. **BBS compatibility.** The current filter refuses every option except
   Suppress-Go-Ahead — it answers `DONT`/`WONT` to everything else. So no
   TTYPE (terminal type) and no NAWS (window size). Plenty of BBSes probe TTYPE
   to decide whether to send ANSI, and fall back to plain ASCII, or misdetect
   the client entirely, when it is refused. This is the most likely cause of the
   "some BBSes misbehave" symptom.
2. **Modem bandwidth.** Negotiation currently costs carrier time. At V.21's
   300 bps a ~30-byte IAC exchange is a full second before the user sees
   anything.
3. **The planned modem-bypass / pure-telnet-proxy mode** (below) effectively
   requires it.

---

## Target data flow

```
BBS ⇄ [telnet, terminated at the server] ⇄ server ⇄ [raw bytes] ⇄ client
                                                  ↑
                                  optionally modulated as PCM audio
```

The modem becomes an *optional stage in the middle* of a clean byte pipe,
rather than something the telnet layer is entangled with.

---

## Steps

### 1. Extract `TelnetFilter` into a dual-usable module

The only structural work in the whole change. The class is already
dependency-free — plain `Uint8Array`, no DOM, no browser globals — but it lives
in an ESM file (`public/terminal.js`) while `server.js` is CommonJS and
`package.json` has no `"type"` field.

Extract it to something both sides can consume (e.g. `lib/telnet.js`), then have
`public/terminal.js` re-export it so the browser's import path is unchanged.
Whatever form is chosen, **one implementation, two consumers** — a copy-paste
duplicate will drift.

### 2. Server: one filter per WebSocket connection

State is per-connection, so the filter is constructed inside the
`wss.on('connection')` closure alongside `dsp`, `sock` and `pending`.

- `sock.on('data')` → `filter.process(buf)` instead of writing to the DSP.
- `filter.onData` → what now feeds `dsp.write()` (via the existing `pending`
  queue when the carrier isn't up yet).
- `filter.onSend` → `sock.write()` **directly**. Negotiation replies must never
  cross the modem link; that is the point of the exercise.
- **Call `negotiate()` on carrier up, not on TCP connect.** Tempting to do it
  earlier now that the server owns it, but don't: some BBSes expect a prompt
  keystroke (an ANSI probe, a "press a key" window, a menu timeout), and
  anything the BBS says before carrier is text the user cannot yet answer.
  Negotiating early only widens that gap. Keeping negotiation on carrier
  preserves today's behaviour and still keeps the IAC traffic off the modem
  link, which is the actual win here.

  The wider version of this problem **already exists and is out of scope for
  this refactor**: the TCP connect happens at dial, so the whole modem
  handshake — 2–3 s, far longer at 300 bps — runs while the BBS is already
  talking, and `pending` swallows it. Fixing that properly means deferring the
  TCP connect until carrier, so the session clock starts when the user can
  actually type. That is worth doing, but as its own change, and it has a real
  trade-off: connection errors (refused, DNS failure, host down) would surface
  only *after* a full handshake instead of immediately. A pre-flight connect to
  test reachability is not a fix — many BBSes count the dropped probe as a node
  session. Note it, leave it, keep the two changes separable.

Teardown already destroys the socket; the filter has no resources to release.

### 3. Answer negotiation with the terminal's real, fixed constants

This is the compatibility fix, and the reason it belongs on the server: the
server knows the terminal is **always 80×25, CP437, ANSI**, because the renderer
is fixed at that grid. So these are constants, not negotiated capabilities:

- **TTYPE (option 24).** Accept `DO TTYPE` with `WILL TTYPE`, and answer the
  `SEND` subnegotiation with `ANSI`. Consider the conventional cycle —
  `ANSI` → `ANSI-BBS` → `UNKNOWN` — since some BBSes probe repeatedly and expect
  the list to terminate by repeating the last entry.
- **NAWS (option 31).** Accept `DO NAWS` with `WILL NAWS` and send
  `IAC SB NAWS 0 80 0 25 IAC SE` once. No resize events exist, so it is sent
  once and never updated.
- **SGA (option 3).** Keep the existing behaviour; it already works.
- **Everything else:** keep refusing, as now.

Watch the IAC escaping rule in subnegotiation payloads (a literal `0xFF` doubles).
80 and 25 don't trip it, but a future variable size could.

### 4. Client: delete the layer, keep the class

In `public/main.js`, remove:

- `telnet.onData` / `telnet.onSend` wiring (around lines 106–107)
- the `telnet.negotiate()` call on carrier up (around line 726)
- `telnet.process()` in the DSP `data` handler (around line 736) — the DSP's
  bytes now feed `parser.feed()` directly

`term.onSend` already writes to the modem independently and does not move.

**Keep the `TelnetFilter` class in the tree, unused.** Do not delete it. It is
the only thing that would have to come back if a direct browser-to-BBS mode is
ever wanted, and it is small. Leave a comment at its definition saying it is
retained deliberately and that the live implementation is server-side, so a
future tidy-up doesn't remove it as dead code.

### 5. Leave room for the bypass filter

The planned **modem-bypass / pure telnet proxy** mode is the reason to keep the
server-side path modular. Once telnet terminates at the server, bypass is:
*skip the DSP and put the filtered bytes straight into binary WebSocket frames*,
with the client reading them into the ANSI parser exactly as it reads
demodulated bytes.

Structure step 2 so that stage is a swappable sink rather than a branch buried
in the socket handler — the filter's output goes to "the transport", which is
either the DSP or the WebSocket. Both directions need it:
client → (DSP demodulate | raw frame) → `sock.write()`.

Also decide, but do not necessarily implement now:

- How the client signals which mode it wants (most naturally a field on the
  existing JSON dial message, alongside `protocol`/`v34Rate`).
- What the UI calls it — a "direct" entry in the speed dropdown is the obvious
  home, since it is the same decision the user is already making there.
- What the scope, carrier light, and speaker do with no carrier to show. They
  should read as deliberately idle, not broken.

---

## Testing

Same constraint as everywhere else in this repo: **no WS listener in the
sandbox.** The realistic split:

- **Filter unit tests, in-process, no sockets.** Feed byte sequences through
  `TelnetFilter` and assert both the emitted data and the reply bytes: a TTYPE
  probe, a NAWS `DO`, the SGA exchange, an escaped `IAC IAC` in the data
  stream, and a subnegotiation split across two chunks (the state machine must
  survive arbitrary chunk boundaries — worth a fuzz loop with random splits).
- **Full stack** via `tools/dsptest2.js` for the modem path, which is unchanged
  by this work but must stay byte-exact.
- **Real BBSes**, from a genuine shell outside the sandbox. This is the part
  that actually validates the change: pick two or three boards that currently
  misbehave and confirm the ANSI now arrives. Note which ones in DEVLOG.md, so
  a later regression has a named test case.

## Risk notes

- Negotiation timing is deliberately unchanged (on carrier, see step 2). If a
  future session moves it earlier, expect BBSes with keystroke timeouts to
  regress, and expect more sitting in `pending` — that queue is unbounded, so a
  sanity cap is worth adding while this code is open either way.
- The filter's `onData`/`onSend` callbacks fire synchronously from `process()`.
  Writing to a destroyed socket during teardown is the obvious failure mode;
  the existing `sock && !sock.destroyed` guards should be mirrored.
- `public/dsp-bundle.js` does **not** need rebuilding for any of this unless
  something under `vendor/src/dsp/` changes — this work is `lib/`, `server.js`
  and `public/*.js` only. (If the extraction ends up inside the bundle's import
  graph, then it does: `npm run build`, then the browser-path safety check in
  CLAUDE.md.)
