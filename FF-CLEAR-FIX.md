# Fix: treat form-feed (0x0C / ^L) as clear-screen, not line-feed

## Symptom
Renegade boards whose `%CL` clear-screen emits a bare form-feed (`0x0C`) don't
clear in SynthLink: the prior screen stays up and new content is pushed down,
leaving a gap (e.g. the "WHO IS ON" screen renders low with the "Scanning..."
line stranded above it). SyncTERM renders the same board correctly. ANSI
`ESC[2J` clears already work — only the `0x0C` path is wrong.

## Root cause
`public/terminal.js` groups `0x0C` with the line-feed controls:

```js
case 0x0A: case 0x0B: case 0x0C: t.lineFeed(); return;   // line ~210
```

SyncTERM (the terminal SynthLink targets) clears+homes on `0x0C`; SynthLink
line-feeds on it. Confirmed by replaying the sysop's wire capture through a
terminal model: only "FF = clear+home" reproduces SyncTERM's screen; "FF =
line-feed" reproduces SynthLink's gap.

FF handling is a known terminal-dependent split. Clear-on-FF is the expectation
in the DOS/ANSI-BBS terminal tradition; VT100-lineage terminals line-feed on it.
Sources:
- Clear-on-FF (BBS/DOS-era expectation): RealTerm treats `^L` (0x0C) as clear,
  same as `ESC[2J`; ANSI.SYS's own documented clear is `ESC[2J` (clear + home to
  0,0). SyncTERM/CTerm: clear+home on `0x0C` is observed behavior (capture),
  though not listed in the current CTerm manual's C0 section — match the behavior,
  not the doc.
- Line-feed-on-FF (VT100 lineage, for contrast): xterm ctlseqs — "FF ... same as
  LF"; Linux `console_codes(4)` — "LF, VT, FF all give a linefeed".

## Change
In `public/terminal.js`, split `0x0C` out of the line-feed case and route it to a
full-screen erase-and-home. Reuse the existing path that `ESC[2J` uses so the two
clears behave identically (that method already snapshots to scrollback, clears to
current attributes, and homes the cursor):

```js
case 0x0A: case 0x0B: t.lineFeed(); return;
case 0x0C: t.eraseDisplay(2); return;   // FF/^L = clear+home (SyncTERM/ANSI-BBS)
case 0x0D: t.carriageReturn(); return;
```

- Leave `0x0A` and `0x0B` as line-feed (unchanged).
- `eraseDisplay(2)` is the current `ESC[2J` handler; confirm it still homes the
  cursor (`cx=0; cy=0`) so `0x0C` and `ESC[2J` match exactly.

## Scope / safety
- Nothing in SynthLink emits `0x0C` expecting a line-feed (only site is this
  dispatch line; font-file `0x0c` bytes are glyph bitmap data).
- No test pins `0x0C -> lineFeed`, so no assertion is being weakened.
- `public/` change only — no bundle rebuild.

## Test to add
A terminal-behavior assertion: feeding `0x0C` clears the screen and homes the
cursor (same result as `ESC[2J`), while `0x0A` still line-feeds. Do not assert on
wording/labels — behavior only.

## Out of scope (do not bundle in)
`0x0B` (VT): SynthLink line-feeds it; CTerm draws it as a glyph (♂). A separate
latent divergence, not reported, not part of this fix. Leave for a separate call.
