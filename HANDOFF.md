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

**Received audio is de-jittered before the demodulator sees it** (`public/rxjitter.js`,
`RX_JITTER_BLOCKS` = 3 frames / 60 ms in both `public/main.js` and `server.js`, 0 = off):
it only delays, never drops or synthesises, and on a modelled 30 ms + 25 ms path it took
Phase 2 bound expiries from 4 runs in 5 to 0 in 5 — unmeasured on a real link.

**There is a "What's new" panel**, shown once per edition to the visitors the
welcome panel no longer greets and reachable any time from about.html's
`(what's new?)` link — the edition is `whatsnew-version: <n>` in
`public/whatsnew.html` itself, so publishing an update is bumping that integer.

**The sysop memo is a week, and a valid credential is no longer 401'd by a
verification already in flight** — the collision two polling tabs hit on every
expiry, which a browser reads as a wrong password and re-prompts for; today's
counters now survive a restart through a mirror in the log directory.

**PETSCII 40 is wired and a real Commodore board renders.** `petscii40` is a
hidden, board-specific outline font (BESCII, CC0) at 40 columns, served to boards
named in `config/altfonts.txt` — `wordbbs.hopto.org:64128` is the first. One id
settles five things now: typeface, encoding, column count, **emulation** and
**palette**. FONTS.md §11.5 is the reference.

The parts that were new rather than a second Topaz:

- **Two charset pages.** PETSCII switches set in band with `0x0E`/`0x8E`, so the
  atlas holds two 256-cell strips and `Cell.page` records which one a byte was
  written under. Every other font is one page and unmoved.
- **A second parser.** `public/petsciiterm.js`. A C64 board sends NO ANSI — the
  capture has not one ESC byte in 4350 — so colour, reverse, six cursor moves,
  insert/delete and the charset switch are the whole dialect. Written against
  SyncTERM's CTerm (`cterm.c`, `cterm_2.c`, `cterm_petscii.c`), not the C64:
  they diverge deliberately and CTerm is what boards are authored against.
- **Reverse video is the existing attribute.** CTerm's current source returns
  `(attr >> 4 | attr << 4)`, having previously drawn the ROM's pre-inverted glyph
  at screencode+128. Identical for a full cell, so the atlas does not double.
- **The Commodore palette**, Colodore, twelve of sixteen measured off a SyncTERM
  screenshot. The 40- and 80-column colour MAPS differ — same byte, different
  attribute — which is why `petscii80` will be its own entry, not a width.
- **The send direction.** PETSCII's letters are not ASCII's: typed `a` goes out
  as `0x41`, `A` as `0xC1`. `namedSeq()` is overridden for every named key, not
  only the ones PETSCII has, because every ANSI answer starts with ESC and
  PETSCII drops it and prints the rest.
- **`tools/datasource/wordbbs-petscii.bin`** is a full-session capture and a
  FIXTURE — `petsciitest` (103) decodes it to the printed screenshot. It is the
  PETSCII counterpart of `bell103-capture.wav` and is here for the same reason: a
  loopback cannot fail on a wrong control code.

`petsciitest` 103, `kbdmodtest` 258, `altfonttest` 33, `ttftest` 134. PETSCII.md
and the prework zip are deleted; what mattered is in FONTS.md §11.5, PROVENANCE.md
§1.1/§4.2 and the harnesses' own headers.

**PETSCII 40 is on the NTSC aspect, and the grid is now exact on both axes.**
Cell **4/3** on **24x32** — 3 device pixels per source pixel across, 4 down —
where it shipped at 1.2 on 20x24. `petscii-derive` measures 24x32 at **0.000%**
with a whole baseline (24 x 1792/1536 = 28), which is what the prework's
arithmetic predicted and no pair at 1.2 could reach. 40x25 goes 800x600 → 960x800
(h/w 0.75 → 0.8333), still shorter than `vga9x14px`'s 0.9722 and no longer the
4:3 box Topaz gives. It is a choice of MACHINE, not a correction: 1.2 assumes the
320x200 active area fills a 4:3 display and is where Topaz's 2.4 comes from, so
the two no longer share a derivation and **Topaz is deliberately untouched**.
FONTS.md §11.6. Upstream BESCII is not vendored, so `besciisubset.py` now also
accepts its own prior output — every coordinate and hmtx value in the 1.2 file is
a whole multiple of the source pixel, so the re-mint rounds nothing and the script
asserts that per coordinate. `petsciitest`'s five metric assertions moved to the
new literal values.


**The modem path has flow control, and its absence had crashed a production
instance.** `transportWrite` handed the board's bytes straight to `dsp.write()`
with nothing bounding the DSP's transmit queue — the pacer is built only in
direct mode — so a board outrunning Bell 103 by a factor of 100000 grew
`FskModulator._bits` until V8 refused the array: `RangeError: Invalid array
length` at 112,813,858 elements (11.28 MB of payload), thrown synchronously
inside the telnet socket's data handler, which reaches `uncaughtException` and
takes every concurrent call with it. `txPending` now reports payload bytes still
to send on every protocol, `Handshake` delegates to the live one and `ModemDSP`
surfaces it — `describe()`'s layering — and `server.js` pauses the board's socket
at **ten seconds of carrier** and resumes at five. No rate is configured: the
depth is measured, so a pacer at the bypass cap (426x Bell 103) or even at the
carrier rate (ten bits to the byte means a 300 bps pacer still leaks 7.5 B/s)
would only have moved the crash out. At ten bits to the byte the threshold is the
bps number itself — 300 B at Bell 103, 56 kB at V.90. Peak queue under a flood
262,800 → **1,610 B**, and 120 s of carrier delivers 3,600 B, which is 300 bps
exactly. `txflowtest` is 51 assertions and mutation-tested six ways. A board now
blocks on its own writes while a slow caller reads, which is what a real line
does to it.

**Bell 103 no longer runs V.8, and its start-up is paced from a real capture.**
Table 2/V.8 has no modulation bit for Bell 103 — it is a Bell System standard —
so every Bell 103 call reached the V.8 exchange, found an empty JM intersection
and fell back: five warnings, ~2.8 s, and the two ends seconds apart because the
answer side then waited for a CJ the caller had stopped sending. That desync is
what made `dsptest2`'s Bell 103 case unreliable for years. It takes V.29's shape
now — both roles straight to the protocol — and the pacing is measured off
`tools/datasource/bell103-capture.wav` rather than chosen: 2.51 s of 2100 Hz
answer tone, the originate carrier up as it ends, 1.00 s of mark idle, first data
bit at 3.50 s. Ours is 3.52 s with 0.01 s skew, against a bare bypass's 0.70 s,
which is a modem noise nobody ever heard. `dsptest2 ONLY=Bell103` 14225 → 6908 ms.

**That capture is now a fixture, and it is the only real-signal artefact for any
FSK protocol here.** Our demodulator decodes its 55 bytes exactly. It matters
because it is the only thing that can fail on a wrong FSK constant: with mark and
space swapped the loopback still connects and still passes data byte-perfect, and
only `bell103capturetest` goes red. That is the fifth instance of this repo's
recurring failure — a round trip cannot see a wrong constant, because both ends
read it.

**Nothing reaches the terminal before data mode now, and that was a live bug.**
`Handshake` forwarded the protocol's `data` event unconditionally, including
during training, so a demodulator framing a byte out of a carrier coming up —
start bit then eight marks, which is 0xFF — put a junk character on screen ahead
of the session. Latent while every FSK connect took 700 ms; Bell 103's answer
tone opened a window and two came through. Gated on `HS_STATE.DATA`.

**The status line names the handshake signal by signal.** `describe()` on
Handshake, V8Sequencer, V.34, V.90, V.32, V.32bis, V.21 and Bell 103 returns the
signal being transmitted, named as the clauses name it; `ModemDSP` polls it once
per block and emits `phase` on change. A V.34 dial now reads CI → ANSam → CM →
CJ → INFO0 → guard tone → L1 → L2 → INFO1 → TRN → J → MP → MP′. Polled rather
than hooked into the step lists deliberately: Phase 2's timing is load-sensitive
and a poll reads state without lengthening the path that builds it, at the cost
of 20 ms of resolution — below anything worth showing. `HANDSHAKE_LABELS` in
`public/main.js` is the curation: a signal with no entry is not shown, which is
how the 10 ms reversals and 40 ms turnarounds stay off a status line they would
only flicker on. V.21 and Bell 103 report an idling carrier rather than
"training", because neither has a training sequence.

**The local audio bus is two rings, and the two directions are panned apart.**
The transport is a 4-wire equivalent, so which modem is transmitting is real
information rather than an effect. The answering modem leans left, the calling
modem right, local call-progress audio stays centred. Panning is CONSTANT GAIN,
gL + gR = 1, so `busL + busR` is bit-identical to what the single ring held —
the scope, the spectrum and every mono device are unchanged to the sample, and a
device granting one output channel gets the sum rather than one direction. The
sink is 1-in 2-out on ONE queue and ONE cursor.

**DIL is flat and broadband, and it was neither.** Two separate faults, the
second only visible once the first was fixed. Its level swept 58 dB monotonically
for three seconds because `REFc` was the midpoint of the chord being trained — a
reference that tracked the thing it should anchor — and the 32 segments were
asked for in ascending chord order, which is ascending level order. One
chord-independent REFc of Ucode 120 and an interleaved order: **58.1 → 4.2 dB
spread, longest rising run 32 of 32 → 2.** Then flat turned out not to be enough,
because the probe was still a TONE: `L_SP` and `L_TP` were 11 and 7, which repeat
together every 77 symbols, ten times inside every 768-symbol segment. They are
127- and 125-bit maximal-length sequences from two different primitive degree-7
polynomials now — coprime with the six-symbol data frame as before, and now
coprime with **each other**, so the pair never repeats inside a segment.
**Spectral flatness 0.037 → 0.549**, against the reference capture's 0.369;
calibrated against each side's own data mode the reference runs DIL/data = 1.13
and so do we. §8.4.1 states no ordering and no power constraint, so none of this
was ever a divergence — it was three badly chosen free parameters. U_INFO stays
at 111, and the reasoning inverted once the DIL was flat: §8.4.4 fixes the ~4.3 dB
Sd-to-TRN1d step, so U_INFO moves the pair together and cannot close it, and 111
is the only value in range leaving both inside the DIL's band. Ja 512 → 750 bits,
so a V.90 connect is 8.12 → 8.34 s.

**CP and MP are on real Phase 4 signalling, and the DLE control channel is gone
from every direction.** The last stretch of any start-up here whose content was the
Recommendation's and whose carriage was not. V.34's MP rides §10.1.3.9's 4-point
form — J's own chain, so the receiver came free — in §11.4's order: TRN after J′
(§10.1.3.9 initialises MP's differential encoder from that TRN's final symbol),
MP until the peer's, MP′, then §10.1.3.2's E. Each end now reads the other's MP
*and* its MP′. V.90's §9.4.1 is Ri ≥192T → R̄i 24T → TRN2d ≥2040T → MP until CP →
MP′ until CP′ → one Ed → B1d; §9.4.2 is CPt until the R-to-R̄i transition → CP until
the peer's MP → CP′ until MP′ or Ed → E. Every transition is a signal, not a count.
Three things were wrong in the first build and were corrected against the
Recommendation itself: §8.6.3/§8.6.5 put MP, MP′, Ed and TRN2d through §5.4's
encoder on CPt's constellation rather than on a sign of U_INFO, so both ends build a
TRAINING encoder from CPt and the analogue modem demodulates MP on training
parameters — the new receive path this item always said was its risk; Table 16's
fill is to the next whole DATA FRAME, so `mpLength` takes that constellation's D;
and §9.4.1.4/§9.4.2.4 gate on the peer's sequences. `DLE 'D'` survives on the V.34
carrier alone as the data-mode mark. V.34 4.0 → 4.14 s, V.90 7.8 → 8.12 s
(8.34 s since the DIL descriptor grew).
`v34-phase4-signal-check` (30) and `v90-phase4-signal-check` (43) assert the
procedure on the wire against the clauses' own digits, and both were mutation-tested.

**The end of a V.90 handshake was 2.4 s of CPU in one 500 ms bin, and it is now
42 ms.** A hunt that rescanned its whole ring every frame and ran a full allocating
CRC at every position that opened a frame sync — and TRN2d descrambles to constant
ones, so EVERY position opens one. The fix is protocol-neutral and lives in
`BitFrame.js` where both protocols share it: `crcOf()` walks the source instead of
copying out of it and takes an offset, so a candidate is CRC'd in place; the
skip-set is cached by array identity; and `findSequence()` is one shared hunt —
frame sync, then the start bit 0 that every one of these tables puts after it (one
comparison that rejects an entire training signal), then the caller's CRC — with a
forward cursor. Whole-connect CPU for both ends: V.90 3.00 → 0.66 s, V.34 539 →
430 ms. Also: `_symBank` reuses its tap arrays rather than allocating three per
candidate position, and `probePeak` is lazy and table-driven (its 420 000 cosines
were paid at module load by every protocol and every page load — 56 → 34 ms).
Connect times and block counts unmoved.

**A real V.90 call is in the repo and we have been compared to it, phase by
phase.** `tools/datasource/Conexant-HCF-smooth-crescendo.wav` is 26.9 s, both
directions, one per channel (L answering, R calling — pinned from V.8 §7.3's V.21
band assignment, not assumed). It confirms two things we had only reasoned to: the
Phase 2 role MIRROR is real (the answering modem sends tone B at 1200, the calling
modem tone A at 2400 + 1800 guard, the reverse of V.34's own §10.1.2.1/.2), and the
V.90 asymmetry is visible in the statistics (downstream flatness 0.51 / kurtosis
1.41 — PCM codewords; upstream 0.15 / 4.5 — shaped QAM). ANSam onset to data is
**15.2 s** against our 8.12; ANSam is 2.42 s with 15.00 Hz AM and reversals at
450/450/450 ms, which our generator matches exactly; L1 is 180 ms both there and
here. Where we differ is not omission but short legal values. The one thing that was
neither — our DIL sweeping 58 dB where theirs is flat — has since been fixed, and
so has the tonality the level work exposed underneath it. Two smaller findings: their
analogue modem transmits SILENCE through DIL where we send SCR (§9.3.2.9 allows
either), and their Phase-4-to-data step is exactly §8.5.1's 3 dB bound where ours
is ~0 dB because CPt and CP carry the same constellation.

**V.34's symbol rate was 125 ppm out of tolerance, and fixing it is what made the
receiver exact.** §5.2 is `S = (a/c) x 2400 +/- 0.01%` and says Table 1 prints its
rates rounded; 3429 is a/c = 10/7, so S is 24000/7 = 3428.5714 and the shipped
3429 was outside §5.2's own 100 ppm. §5.3's carrier is (d/e) x S, d/e = 4/7, so
96000/49 = 1959.1837 against a shipped 1959. 2400 (1/1) and 3200 (4/3) were
already exact, so only 33600/3429 moved — the default rate and the one entry the
menu dials. Invisible to every suite because both ends read the same constant,
which is the fourth instance of that failure here. `RF` carries a/c and d/e now
and the printed integer is only the table KEY. Separately, INFO0 and INFO1c
declared the LOW carrier at 3200 while transmitting the high one; both derive from
`RF` now. All of it is wire content no hardware has seen.

**The V.34 receiver is 3.7x cheaper, and it is EXACT rather than approximated.**
With S the Recommendation's rational, SPS is exactly 7/3 at 3429 and FC/SR exactly
12/49 — so the carrier is a 49-entry table indexed by `(12n) mod 49`, and the
matched filter is a 3-phase polyphase bank built once per acquisition
(`_symBank`/`_symAt`), because advancing the symbol index by 3 advances the
position by the integer 7. Nothing is interpolated. TX carries the mirror, a
7-phase bank. The rounded 3429 is exactly what had made an exact bank impossible.
Also: the baseband is cached per sample rather than re-derived thirty-two times
(windows overlap by SPAN), `rx`/`rxI`/`rxQ` are growable `Float64Array`s, the
onset scan is forward-only carrying its EWMA, and `V90Mapper`'s `ShaperFilter.clone`
copies fields explicitly. Originate steady state 33-35 -> 8-9 ms of CPU per 500 ms
of audio; mean `receiveAudio` 1.64 -> 0.47 ms; p95 9.6 -> 2.2 ms; RTF 0.093 ->
0.032. V.90 answer 0.049 -> 0.023. Connect times unmoved.

**The intermittent V.34 connect failure is fixed, and §11.2.2's recovery ACTIONS
are implemented.** The trigger was a lost INFO0a: §11.2.2.1.2 leaves the call
modem's Tone B wait unbounded, so it sat there while the answer modem expired
three of its own bounds. Steps now carry `recover` (what a bound expiring does) and
`interrupt` (what an arriving signal does), with recovery-only steps at the end of
each list reached by a `goto`; §11.2.2.1.1, .1.3, .1.4, .1.6 and §11.2.2.2.1, .2.2,
.2.3, .2.4 all have their actions. Bit 28 is read off the receiver rather than
fixed at 0, which is what ends a repetition, and the call modem's §11.2.2.1.6
answers INFOMARKSa by resending INFO1c — the alternative the clause offers, and the
one that pairs with §11.2.2.2.4 without the §11.5 retrain this build lacks. Two of
§11.2.2 still only advance and say so where they are written: §11.2.2.1.5 and the
Tone-detected halves of .1.6 / .2.4, whose sole remedy is that retrain.
`tools/tests/v34-phase2-recovery.js` is the harness — 20/20 clean, and see the
watch-out about what it takes to make it fail.

**V.90 has a real Phase 2, and it runs on V.34's machine.** §9.2 is §11.2 clause
for clause with the two modems renamed — every duration, every recovery bound —
and §8.2 defines every signal by reference to §10.1.2/V.34, so the step list serves
both and `V90Phase2.js` holds only Tables 7 and 10. Tables 8 and 9 ARE Table
14/V.34 and Table 15/V.34; `v90-phase2-check` verifies that claim against the
printed definitions rather than taking it. `setPhase2Enabled(false)` is gone from
V90.js: the digital modem runs §9.2.1 through the V.34 class and then
`setPhase2Only(true)` stops it transmitting, because §9.3.1's part is PCM and not a
V.34 signal. U_INFO, the upstream symbol rate and MD's length are negotiated rather
than agreed by both ends reading the same constant. Connect 6.4 → 7.8 s.

**The CRC register was upside down, and Figure 14/V.34 transcribes after all.**
Recorded here for three cycles as the one unverified degree of freedom, on the
grounds that the figure would not transcribe. It does: `pf21`'s label layer gives
sixteen stages numbered 15 down to 0 left to right, the page image gives blocks of
five, seven and four, and "Information Bits In" arrives at the right-hand end — so
the feedback enters stages 15, 10 and 3, which is `0x8408`, the bit reversal of
`0x1021`. `BitFrame.crc16` had the MSB-first form. Every INFO, MP and CP sequence
is generated and checked by the same function at both ends, so nothing here could
ever have failed on it; Jd and the DIL descriptor ride it on the wire, so it was a
failed CRC in a real receiver rather than a latent one.

**Phase 4's signals are all on the wire now.** §10.1.3.2's E and §10.1.3.9's two
modulations in `V34Phase4.js` — the 16-point form is four bits a symbol with
`2·Q2n + Q1n` selecting from Figure 5's quarter points 0–3, built and unused because
this modem's J advertises the 4-point one — and §8.6.4's R and R̄, §8.6.5's TRN2d,
§8.6.1's B1d, §8.6.2's Ed and Table 17 in `V90Phase4.js`, every one of them
transmitted in §9.4's order.

**V.32 and V.32bis run the Recommendation's own start-up, and `ORIG_LEAD` is gone
from both.** §5.2's receiver conditioning signal — S for 256T, S̄ for 16T, TRN for
1280T — then §5.3's genuine 16-bit rate signals R1/R2/R3 and the sequence E that
ends them, all on Figure 1/V.32's A B C D states with Table 1's differential
coding. `V32Startup.js` holds the signals because §5.2 and §5.2.3 are word for word
the same in both Recommendations, down to the two printed scrambler golden vectors;
each class holds §5.4's / §6's procedure. It is a genuine four-way exchange now:
the answer modem leads, ceases on detecting the call modem's S (§5.4.2), resumes on
R2, and the call modem transmits nothing at all until it has detected S and then R1
(§5.4.1) — which is what a 0.60 s constant was standing in for. The invented `DLE
'R' hi lo` rate frame went with it, and so did the data burst's 72-symbol preamble:
the receiver carries S's timing lock and channel estimate through E into data mode
without the carrier ever dropping. Connect 3.1 → 4.2 s, both.

**V.32's data path disagreed with Table 1 AND Table 3, and had since it was
written.** Found while doing the above, fixed as its own change. The differential
increment was a plain modulo-4 add of the dibit where Table 1's phase quadrant
change is +90°, 0°, +180°, +270° for 00, 01, 10, 11 — 12 of 16 rows wrong — and
`BASE` had Q3 and Q4 transposed against Table 3's quadrant-I rows, 8 of 16. Both
round-tripped perfectly because the receiver inverted the transmitter. That is the
**third** instance of this exact failure here, after V.32bis Figure 2-1 and V.34
Figure 5, so the forward and inverse maps are now one stated pair
(`dataPoint`/`dataBits`) — the second divergence lived in both halves separately.
`v32-map-check` is 237 assertions and is deliberately not a round-trip test.

**V.34 has a real Phase 2.** §10.1.2's tones A and B with their 180° reversals, the
600 bit/s binary DPSK, Tables 14/15/16 (INFO0, INFO1c, INFO1a) at their literal bit
positions with §10.1.2.3.2's CRC, and Table 17's 21-tone L1/L2 probe.
`V34Phase2.js` holds the signals; §11.2.1's procedure is a step list in `V34.js`
carrying §11.2.2's **own** per-step recovery bounds. The turnarounds measure 40 ms
on the line (§11.2.1.1.3) and the round trip delay is genuinely measured from the
reversal timestamps — the one measurement in Phase 2 this transport can make.
`MD_SYMBOLS` is retired: the length is Tables 15/16 bits 18:24, each modem
declaring its own (§11.3.1.1.4), and the symbol rate is negotiated through Table 16
bits 34:39 rather than configured. Connect 2.5 → 4.6 s.

**V.90 does not run V.34's Phase 2**, and must not — but it now runs its OWN on
the same machine. §9.2 is a different procedure between a different pair of modems
and the same procedure with the parts renamed, which is why `setPhase2Profile`
exists and `setPhase2Enabled(false)` is no longer called anywhere.

**V.34 Phase 3 is real, and `ORIG_LEAD` no longer exists.** `_buildAATrain()` —
250 ms of alternating REF points standing in for the whole phase — is replaced by
§10.1.3's own segments in §11.3's order: S (128T), S̄ (16T), MD, PP (288 symbols,
equation 10-1), TRN (≥512T), then J and J′. `V34Phase3.js` holds them the way
`V90Phase3.js` holds Tables 12 and 13, with load-time assertions on the properties
the clauses fix; `v34-phase3-check` asserts equation (10-1) both branches, PP's
48-periodicity, S's end rule, S̄'s begin rule and Tables 18/19 at their literal
digits, and checks `POINT0` against `V34Mapper`'s own §9.1 generator so the two
cannot drift apart. §10.1.3's power NOTE is why each segment is scaled to the data
burst's mean symbol energy rather than emitted at lattice scale.

**The call modem is gated on a signal now, not on a constant.** §11.3.1.1.1 makes
it "initially silent" until it detects S and the subsequent S̄, which is what
replaced `ORIG_LEAD`'s 0.60 s. That constant was not arbitrary — the V.8 sequencer
hands the two ends their protocol at different instants, because the originate
side leaves CJ when its transmit QUEUE drains while the answer side must first
DEMODULATE CJ — but a detector absorbs that skew exactly where a fixed lead only
budgets for it. Measured: the detector fires at 0.140 s and transmit begins at
0.160 s, both directions, with §11.3.2.1.1's timeout never used.

**V.90's analogue modem gets all of it free, with the roles swapped.** §8.3.2–.6
define MD, PP, S, SCR and TRN as "as defined in 10.1.3.x/V.34", and the analogue
modem transmits through the V.34 class — but §9.3.2.1 gives IT the leading part
that V.34 §11.3.1.2.1 gives the answer modem. `setPhase3Lead()` is that, and
without it a V.34-gated originate would sit out its whole timeout waiting for an S
the digital modem never sends.

**Ja is on the wire, and both Phase 3 constants are retired.** §8.3.1's Ja — the
DIL descriptor's own bits through 10.1.3.3/V.34's modulation — replaces the DLE
byte carriage, followed by §9.3.2.7–.10's S / S̄ / SCR placement. So §9.3.1.5 now
genuinely repeats Jd until it detects the analogue modem's S, and §9.3.1.6 ends
DIL on its S-to-S̄ transition; `JD_REPS`, the one-repetition DIL and
`_phase3Symbols()` are gone. The analogue modem stopped counting through Phase 3
altogether — it detects the Sd-to-S̄d polarity flip inside Sd, hunts Jd's 17-one
frame sync, detects J′d's twelve zeroes, and finds the end of DIL by predicting
the probe it wrote the descriptor for.

**Phase 3 needed a real RECEIVER, which is what the item cost.** Item 2 said it
"changes only how it crosses the wire"; the descriptor is load-bearing, so the
digital modem has to demodulate it. `V34.js` now carries a Phase 3 receiver that
locks timing on S, classifies every symbol against the four rotations of point 0,
counts S / S̄ runs and differential-decodes the bit stream J, J′ and Ja ride on.
`rxPhase` keeps it away from the data burst's acquisition — see the watch-out.

**A V.90 connect is 7.8 s and a V.34 connect is 4.0 s.**
The digital modem now plays Sd, TRN1d, Jd, J′d and DIL in §9.3.1's order — which
is Sd FIRST and TRN1d after it, the reverse of what Figure 5's left-to-right
labels suggest, and the prose clause is why. `V90Phase3.js` holds Tables 12 and
13 the way `V90Phase4.js` holds 14 and 16; `v90-phase3-check` asserts both at
their literal bit positions before round-tripping anything, Table 12 at three
pattern lengths because its layout is variable — every field after SP and TP
moves with α and β. The DIL requested is N = 32 segments of 768 symbols, 3.07 s
in one pass, inside Figure 5's ≤5 s; its 32 training Ucodes sweep four per Uchord
and its sign and training patterns are 11 and 7 bits, coprime with six so the
probe walks all six data frame intervals — the impairments DIL exists to find are
per-interval. U_INFO is now explicit at 111, the top of the range Table 10 and
§8.4.4 leave, and Sd's W is derived from it rather than hardcoded to 127.

**The gate on Sd moved from CP to Ja, which is the Recommendation's phase order,
and that exposed a real coupling.** `coder.reset()` ran at the Sd transition and
the coder does not exist until CP builds it — with Ja able to arrive first, V.90
crashed. MP and the coder are now set up where data begins. The zero-bearing Sd
discriminator is still consulted only to find where Sd ends and never afterwards —
DIL deliberately probes the low Uchords, whose magnitudes (Ucode ≤ 22) sit inside
`SD_ZERO_TOL` — but what follows it is detection rather than a count.

**The off-hook gap plays, and it never did.** `generateAudio`'s `V8_NEGOTIATE`
branch scanned the drained block for a non-zero sample and threw it away when it
found none — which queued silence never contains — so `answerToneDelayMs` was
dead at any value and every call opened with ANSam already sounding. It now asks
whether the queue is empty, and hands a part-drained block's remainder to the
sequencer so ANSam starts on the sample the silence ends.

**A V.90 dial's V.8 now carries the two categories §9.1.1 requires** — a V.90
availability bit and a PSTN access type — plus the V.34 availability bit V.8 §6.3
requires alongside them, which is honest here because V.90's upstream *is* V.34.
JM conditions them per §7.4 rather than intersecting: the two ends declare
different halves of the analogue/digital pair, so intersecting would empty the
category exactly when it matters. Which half each declares is §9.1.1's own
tie-break, not a guess, and it is the role split `V90.js` already made.
`V8_TAG_PCM_AVAIL` was wrong — see the watch-out below.

**`tools/connect-timing.js` is new and is how any of this is checked.** Two
`ModemDSP`s audio↔audio, sample-counted, RMS per direction in 100 ms bins;
`GAPS=1` for the runs of silence, `BINS=1` for an amplitude trace. It is what the
baseline table in PROTOIMPROVE.md is measured with.

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

**The real-browser smoke test is done, but it PREDATES two cycles now.** V.90,
V.32bis, V.32, V.34 @ 28800 and Bell 103 were all confirmed over the literal
browser↔`server.js` WebSocket path — before V.32, V.32bis and V.34 had their
start-ups replaced, and before V.90 gained a Phase 2 at all. The DSP core, the data path and V.90 are unchanged and the
in-process full stack is green for all ten, but three protocols now put a
different start-up on the wire than the one that was confirmed in a browser, and
Phase 2 in particular is the first thing here whose timing depends on a real-time
pump keeping up. **Re-run it for V.32, V.32bis, V.34 and V.90 before trusting them on a
real link.** → `tools/jitter-repro.js`, and CLAUDE.md on why it needs a genuine
shell outside the sandbox.

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
therefore remembered for `sysopSessionHours` (default 168) and costs a
constant-time compare after that, and only SUCCESSFUL verifications are
memoised, so wrong guesses put nothing in the map. The key includes the
configured hash, so changing the password invalidates every memo on the spot.
Separately, one scrypt runs at a time server-wide: while one is in flight a
DIFFERENT credential is refused without hashing, so an unauthenticated request
cannot turn the password hash into a CPU amplifier. That is deliberately not a
lockout, which an attacker could use to keep the operator out. Requests carrying
the SAME credential join the verification in flight rather than being refused by
it — still one hash, and see the watch-out.

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

**PETSCII 40's aspect is done** — see the status entry above and FONTS.md §11.6.
What is left is the one thing a harness here cannot see: nobody has looked at a
real Commodore board at 24x32 on a real screen. `petsciitest` decodes the capture
fixture to the printed screenshot and `ttftest` re-derives the grid, but both
assert the FACE, not whether 0.8333 reads right beside the art a sysop cut at
0.75. Worth an eye on `wordbbs.hopto.org:64128` before it is called settled.

**Every audible-authenticity item is struck.** What is left is a missing rate
ladder and a missing receiver, in that order.

1. **V.32bis multi-rate + rate renegotiation — the backlog's item 1.** Its carrier
   is already built: §5.3's rate signals are on the wire at Table 5/V.32bis's own
   bit positions and `makeRateCodec` already advertises and decodes every rate in
   the table, so this is the fallback CONSTELLATIONS (Figures 2-2..2-5, for
   12000/9600/7200/4800) plus §8's change-rate-without-retrain — not the
   negotiation. `V32bis.js`'s `RATE_SET` is what restricts it to 14400 today. Do one
   rate at a time and assert each constellation's own rotational invariant against
   the printed figure, never a round trip.
2. **Then a discussion about real-hardware interop** before more code. The gap
   analysis is per-protocol in PROTOCOLS.md; the short version is that the
   negotiation would likely go through and the data would not, because the
   receivers assume a channel a phone line is not. Backlog item 2, the V.90
   real-line receive gap, is the same subject and is all MEASUREMENT.
3. **Two things hardware has NOT seen**, both new wire content: the two V.8
   category octets a V.90 dial sends, and Bell 103's answer side in its present
   shape — synthmodem validated Bell 103 with V.8 attempting and failing over
   first, which is no longer what happens.
4. **Pending, not started:** 2-wire mode (2WIRE.md) and V.92 (V92NOTES.md).
5. **The real-browser smoke test still predates the start-up rewrites.** → the
   watch-out below; `tools/jitter-repro.js`, from a genuine shell outside the
   sandbox.
6. **The blank-terminal repaint is a mitigation, not a diagnosis.** It assumes
   a backing store discarded while the page was hidden. If the symptom survives
   on a real device, the assumption is the thing to re-examine — a lost atlas
   would present identically and would need a rebuild, not an invalidate.

## Watch-outs when picking up

- **A board font must survive a mobile-breakpoint crossing.** `isMobile()` is
  `max-width: 640px`, so a rotation OR a narrowed desktop window crosses it, and
  the resize handler used to `applyFont()` over the override. That takes the
  board's encoding, column count AND emulation with the typeface: the parser
  changes under a live stream and every cell on screen holds bytes the new atlas
  cannot draw. `applyFontAcrossBreakpoint()` updates the user's font underneath
  instead. It was a bug for Topaz too and invisible there, because losing Topaz
  only changes the table.
- **A derive harness's TRUTH GRID carries the file's cell aspect and is not a
  constant.** `petscii-derive`'s 80x96 reference survived the move to 4/3 for one
  run — 80 x 4/3 is 106.67 — so it rasterized the face into the wrong box and
  every candidate misread ~6.4%. That flatness is the tell: a wrong truth cannot
  single out a grid, so a column with no winner is a bad reference and not a bad
  font. 96x128 is the 4/3 reference.
- **PETSCII's aspect and Topaz's no longer come from the same derivation**, and
  that is deliberate. Topaz's 2.4 is the fills-a-4:3-display route; PETSCII's 4/3
  is the NTSC pixel. Do not "restore consistency" by moving one to the other —
  they are different machines, and PAL is a third answer for the C64 alone.
- **`0x7F` is a PRINTABLE character in PETSCII.** CTerm marks only `0x00-0x1F`
  and `0x80-0x9F` as control. So the ANSI path's Backspace echoes as a filled
  corner; PETSCII's own destructive backspace is `0x14`.
- **A string reaching `modemWrite()` is TEXT and is encoded; a Uint8Array is
  BYTES and is not.** Two callers depend on the second — a menu-key click sends
  the cell's own byte, Alt+numpad names a byte by its number.
- **`0x60-0x7F` and `0xE0-0xFE` are ECHOES** of `0xC0-0xDF` and `0xA0-0xBE`
  (`0xFF` of `0xDE`); the canonical set is `0x20-0x5F`, `0xA0-0xBF`, `0xC0-0xDF`.
  `canonicalByte()` folds them at draw time. The echo range is on the wire — 11
  bytes in one session — so this is traffic, not theory.
- **`_fgSheet()` must size from the ATLAS, not from 256 cells.** It cost a
  debugging round: the atlas was correct and both pages populated, and the
  terminal still drew backgrounds with no glyphs, because every page-1 cell fell
  outside a tinted sheet half the width it should have been.
- **PETSCII's two pages are not interchangeable** — `0x62` is a graphic unshifted
  and a letter shifted, so one descriptor edge-extends letters into neighbours.
- **`public/fonts/petscii.js` is GENERATED** by `tools/mkpetscii.py` from BESCII's
  own two releases. Do not hand-edit. Its private-use entries tie the table to
  BESCII: a different PETSCII face needs its own regenerated table.
- **Do not use `cbmcodecs2` in anything that ships** — GPL-2.0-only, the same
  incompatibility linmodem has. Fine as a hand cross-check. PROVENANCE.md §1.1.
- **`termEcho()` renders our own text through the PETSCII parser**, so `NO
  CARRIER` draws lowercase on a PETSCII board. Cosmetic, unfixed, known.
  `scanURLs()` likewise decodes every cell through CP437 whatever the font —
  pre-existing, equally wrong for Topaz.

- **A transmit queue with no backpressure is bounded by V8, and the bound is a
  crash.** Not by memory: a fast-elements array refuses to grow past 112,813,858
  entries with `RangeError: Invalid array length`, and `FskModulator._bits` holds
  one element per BIT. Anything that feeds the DSP from a socket needs
  `modemFlow()` after it, or the queue is again the only record of the difference
  between a board and a carrier.
- **`txPending` is PAYLOAD BYTES, and each class divides by its own framing.**
  Ten bits to the byte for the FSK trio, **eleven** for V.22 and V.22bis (two
  stop bits), one for the `txByteQ` protocols. The transport compares one number
  against one threshold and must not learn which divisor applies; a class that
  reports bits is 10x deep and pauses nothing.
- **V.90's `txPending` follows `write()`'s role split, not `txByteQ`.** The
  analogue modem holds nothing locally — it hands bytes to its V.34 instance — so
  reading `txByteQ` for both roles reports the upstream, which is the slow half,
  as permanently empty. Same mirror as `setPhase2Profile` and `setPhase3Lead`.
- **The modem path is deliberately not rate-limited, and that is still true.** A
  carrier paces itself; what it lacked was backpressure. Do not reach for the
  bypass pacer here — 128 kbps is 426x Bell 103, so it caps nothing that matters,
  and a pacer at the carrier rate has to be exactly right forever against three
  different framings. Depth measured beats rate predicted.
- **`modemFlow()` must run on the DRAIN as well as the fill.** It is called after
  every `dsp.write()` and on every `audioOut` block. Drop the second and a paused
  board is never resumed, which is a call that goes silent and stays silent.
- **A protocol's `data` event is not payload until the handshake says so.** A
  demodulator frames 0xFF out of a carrier coming up — start bit, then eight
  marks — and `Handshake` used to forward that straight to the terminal. Gated on
  `HS_STATE.DATA` now. Anything that widens the window between a carrier
  appearing and data mode re-opens this, which is exactly what Bell 103's pacing
  did.
- **Bell 103's two ends are paced by the SAME constants, and that is why they
  arrive together.** It is a count rather than a signal, deliberately: Bell 103
  has no negotiation to gate on and `skipCdVerification` disables the
  carrier-detect gate that would serve instead. Change one side's constant and
  the caller types into a link the answerer has not finished bringing up.
- **A Bell 103 bypass must take V.29's shape, not the forced-protocol path.** The
  forced path prepends V.25 initial silence and a plain ANS on the answer side
  only: measured 0.70 s for the caller against 6.83 s for the answerer.
- **`bell103capturetest` is the only thing here that can fail on a wrong FSK
  constant.** With mark and space swapped the loopback connects cleanly and
  passes data byte-perfect. Do not "simplify" it to a round trip.
- **The status line's `describe()` is a POLL, not a hook, and must stay one.**
  Phase 2's timing is load-sensitive; a poll reads state after `generateAudio`
  has returned and cannot lengthen the path that builds a signal. It costs 20 ms
  of resolution, which is below anything the labels show.
- **`data` mode is the HANDSHAKE's answer, never a protocol's.** V.34's QAM burst
  is live through the gaps in Phase 3's signal-gated tail, so deciding it from
  `txMode` put a "data" between Ja and the S-hold on V.90.
- **V.90's calling side reports INFO0a, not INFO0c.** The analogue modem is the
  originate side but plays the ANSWER modem's part in §9.2 — the same mirror
  `setPhase2Profile` exists for, and the same mistake it prevents.
- **Bus panning is constant GAIN, not constant power.** gL + gR = 1 is what keeps
  `busL + busR` identical to the old single ring, so the scope and every mono
  device are unchanged to the sample. Constant power sums a centred clip 3 dB hot
  and moves the trace. `dropClip` must un-mix with the clip's own pan.
- **The sink's two channels share ONE cursor.** Two resamplers stepping
  independently accumulate different rounding and walk apart — the same class of
  fault as the re-anchoring that used to click.
- **A DIL descriptor's SP and TP must be coprime with each other, not just with
  six.** Coprime with the six-symbol data frame is what walks the probe across
  the frame intervals; coprime with each other is what stops the pair repeating
  inside a segment and turning the probe into a tone. Equal periods are the trap:
  127 and 127 from different polynomials still measured 0.28 flatness, because
  they repeat together whatever their content.
- **Comparing raw spectral flatness between our output and a recording is the
  wrong comparison.** The recording's path shifts the measurement — the reference
  reads 0.326 in data mode where we read 0.486. Calibrate each side against its
  own data mode; the ratio is the number that means something.
- **A parameter sequence sent ONCE is the one the descrambler eats.** TRN and TRN2d
  are not differentially encoded, so a receiver's self-synchronising descrambler
  spends its first 23 bits recovering after them; the first MP, MP′ or CP after one
  is corrupt however exact the transmitter was. That is why §10.1.3.3 makes J "a
  whole number of repetitions" and why the floor here is two. It cost a debugging
  round: a lone MP′ never parsed and looked like a mis-transcribed table.
- **A sequence hunt must CRC in place and carry a forward cursor.** TRN2d descrambles
  to constant ones, so every position in it opens a valid-looking 17-one frame sync;
  a hunt that slices and parses each candidate runs a full CRC per bit of a
  2040-symbol signal, per frame. That was 2.4 s of CPU in one 500 ms bin. `BitFrame`'s
  `findSequence` + `crcOf` are the shared answer — the cheap reject is the start bit 0
  that every one of these tables puts immediately after the sync.
- **A cursor into a bit ring must subtract `p3.trimmed`.** The ring is spliced from
  the front by its cap and by every consumer that takes a sequence out of it, so an
  absolute cursor goes stale. `trimmed` only ever goes UP — a full clear adds the
  discarded length rather than resetting to zero. Getting this wrong made V.34 miss
  its peer's MP and cost 25 extra blocks to connect, which is how it was caught.
- **CPt passes lₐ = 0 deliberately.** Table 14 bits 49:50 are the analogue modem's
  choice and §9.4.2.1 lets training differ from data mode. The shaper's lookahead is
  a pipeline DELAY, so a non-zero lₐ leaves the last frames of every Phase 4 signal
  inside the encoder — and the signal that ends Phase 4 is Ed, two frames long.
- **The DIL's free parameters are a settled CHOICE, not a derivation, and only
  ever a choice.** §8.4.1 states no ordering and no power constraint, so REFc, the
  Ucode order and the SP/TP lengths are ours. They are chosen so the probe is flat
  and broadband like a real one; nothing here measures a DIL, so if the real-line
  receive gap is ever closed, whether a reference belongs near the chord it trains
  or anchored away from it becomes a genuine design question and this is where to
  revisit it. Do not reach for a power constraint that is not in the
  Recommendation.
- **A round-trip test cannot see a wrong CONSTANT either, and that is now four
  instances.** V.34's 3429 symbol rate and 1959 carrier round-tripped perfectly for
  as long as they existed because both ends read the same `RF` entry — exactly as
  V.32bis Figure 2-1, V.34 Figure 5 and V.32's Tables 1 and 3 did. **Any value the
  Recommendation states as a formula must be carried as the formula.** §5.2 and
  §5.3 give a/c and d/e and say the tables print rounded values; the printed
  integer is a table KEY here and never the quantity.
- **The V.34 tables are keyed on the PRINTED rate, and that is deliberate.**
  `CONFIGS`, Table 7, Table 10, `RF` and INFO1c's rate ladder all say 3429; only
  the signal generation uses 24000/7. Replacing the key with the exact value breaks
  every lookup, and the Recommendation labels its own tables the same way.
- **`_symAt(base, idx)` is the only matched-filter entry point, and it takes an
  index rather than a position on purpose.** The exact bank works because
  advancing idx by SPS_Q advances the position by the INTEGER SPS_P; a caller that
  computes `base + idx*SPS` itself and passes a float both loses that exactness and
  accumulates rounding over thousands of symbols. `_symPos` exists for the bounds
  checks that still need a position.
- **The acquisition timing search is ~21 ms in one block and was left that way.**
  Coarse-to-fine would be ~5x cheaper and is a no-go: a real link's score surface
  is noisier and less unimodal than loopback's, so it is likeliest to pick a
  different peak exactly where that matters. `_huntSbar` also assumes outright that
  the clock does not drift, which is false against hardware — that area wants
  continuous timing tracking, not a cheaper one-shot search.
- **A Phase 2 harness that does not run each call in a COLD PROCESS says PASS.**
  Twelve calls in one process are twelve clean connects: by the second one V8 has
  optimised the receiver and there is CPU to spare, which is exactly the condition
  the failure does not happen under. A fresh process spends its first seconds in
  unoptimised code, and is also what a real visitor gets, one per page load.
  `v34-phase2-recovery` spawns a child per call for that reason and was green
  beside a failing `bundle-smoke` until it did. Load is the trigger; performance
  work makes it rarer and never fixes it.
- **A round-trip test cannot see a wrong constellation or a wrong coding table.**
  Three times now: V.32bis Figure 2-1, V.34 Figure 5, and V.32's data path against
  Tables 1 and 3. Each round-tripped perfectly for years because the receiver
  inverted whatever the transmitter did. Only the printed table can fail it, which
  is what `v32-map-check`, `v34-map-check` and `v32-startup-check` are for — and
  why `v32-map-check` says in its own header that it is deliberately NOT a
  round-trip test. Anything transcribed from here on gets the same treatment.
- **"The subset used for training" is not the outer corners.** Figure 1/V.32
  circles A B C D at Q3Q4 = 01 — (−3,−1), (1,−3), (3,1), (−1,3) — and their mean
  energy is 10, which is the whole constellation's. The corners would be 2.5 dB
  over the data burst. Rotational closure does not pin it: three of the four
  candidate sets are closed.
- **V.32 is a SCANNED Recommendation.** Its tables OCR into the text layer but its
  figures carry no positioned text at all, so PROTOIMPROVE.md's label-tracking
  method does not apply — extract the page's `<img>` data URI and read the image.
- **The INFO demodulator has no bit-timing recovery and needs FOUR sampling
  phases instead.** Its integration windows are one bit long and free-running from
  the receiver's own sample zero, while the transmitter's bits begin wherever
  §11.2's silence ends. Land half a bit out and every window straddles two bits,
  the differential decode is noise, and INFO0 never presents a frame sync with a
  passing CRC — a connect that fails outright rather than degrading. It failed
  about one run in three that way, and only under a real-time pump, because a
  synchronous loop happens to line the two up. Four interleaved phases plus the
  frame sync and the CRC pick the one that decoded. Do not "simplify" this back to
  one phase.
- **"Tone B is detected" is not "the peer's carrier is present."** During an INFO
  sequence the carrier is up and flipping, and between two repetitions of one it is
  briefly steady; a step that advances on presence alone leaves §11.2.1.2.3 on a
  few milliseconds of that, sends its reversal into a peer that is mid-recovery and
  not conditioned to count one, and the peer then sits in an UNBOUNDED wait until
  the other end's 2000 ms bound breaks it. `toneSeen()` is the predicate: present
  AND not modulated.
- **INFO's own 180° modulation will be counted as tone reversals unless something
  stops it.** `toneOn` collapses within a couple of 150 Hz windows once modulation
  starts, but "a couple" is 20 ms and a reversal confirms in 5. Raising
  `P2_REV_CONFIRM` does not work — §11.2 holds a tone only 10 ms after a real
  reversal, which is six points. The gate is flip DENSITY: one flip in sixteen
  points is a reversal, three is a carrier carrying INFO. Only reachable at all
  because §11.2.2's recovery sends INFO where the peer expects a tone.
- **A recovery must CONSUME the request that triggered it.** `info0Repeats` only
  rises; without clearing it on entry the step exits at its sequence boundary, the
  interrupt sees the same count and sends it straight back, and the two ends spend
  §11.2.1.2.3 doing 83 ms laps until the recovery cap stops them.
- **Steps are addressed by `id`, and two of them legitimately share a `name`.** The
  call modem transmits Tone B at §11.2.1.1.3 and again at §11.2.1.1.6 and both are
  "B", which is what `phase2TimedOut` should say. A `goto` that resolves by name
  lands on whichever came first — that is a cycle, and it cost a round. The build
  asserts ids are unique and an unresolved target throws rather than advancing.
- **A clause's MAXIMUM is not a value to take.** §11.2.1.1.5 and §11.2.1.2.8 bound
  the RECEPTION of L2 at 500 ms with no floor; at the full 500 the tone that ends
  the peer's L2 leaves at 660 ms and arrives after §11.2.2.2.3's 600 ms recovery
  bound has fired. 200 ms is taken instead. Where a short start-up is wanted, take
  it from a knob the Recommendation provides — but check what the peer's bounds do
  with the value.
- **Phase 2's DPSK rotation belongs in the carrier phase, not at the output.**
  Adding it at output time leaves a step of π wherever an INFO sequence ends and a
  tone begins, which the peer's reversal detector reads — correctly — as a phase
  reversal of that tone.
- **An INFO sequence must not leave its phase reference behind for the tone that
  follows it.** §11.2.1.1.2's "after receiving INFO0a, condition its receiver to
  detect Tone A" is the clause, and it is load-bearing: carried over, the tone
  disagrees with that reference half the time and is counted as a reversal that has
  not been sent. Before this was fixed the count came out right by accident, one
  spurious reversal standing in for the real first one.
- **A coherent presence window is blinded by the reversal it exists to qualify.**
  Phase 2's 150 Hz window nulls every other Phase 2 frequency exactly, which is why
  it is used — but a 180° reversal inside one averages it to nearly zero, so a tone
  is declared gone only after several consecutive quiet windows. That is required,
  not slack.
- **Phase 2 runs on ONE sample clock, and it has to.** Durations are counted in
  transmitted samples; a detection happens in the received stream. Anchoring a
  transmit duration to a receive-side index works only while the two advance in
  lockstep, which a synchronous test loop does and a real-time pump does not — it
  left a 40 ms step waiting ten seconds. `_p2Point` converts an arrival into the
  transmit clock before recording it.
- **A step list can deadlock two modems each waiting for the other's tone.**
  §11.2.1.1.5's "may then receive signal L2 for a period of time not to exceed
  500 ms" is not a safety net; it is what breaks that wait, because the peer's L2
  ends when it detects THIS modem's tone and this modem does not send it until it
  has finished receiving.
- **§11.2.2's recovery bounds are per step and are the Recommendation's own.** One
  blanket 3 s constant was too tight: under a loaded real-time pump the two ends'
  sample clocks separate, a step expired before its peer's signal arrived, and the
  procedure desynchronised into a cascade. One measured run came out 8 s long,
  which is three expiries. `phase2TimedOut` lists any that fired — empty is the
  error-free procedure, and a non-empty list is a thing to see rather than to infer
  from a slow connect. Note §11.2.2's ACTIONS (repeated INFO0, INFOMARKS, retrain)
  are not implemented; a step that expires simply advances.
- **V.90's Phase 2 is keyed on the PART, not on the role, and it is the mirror of
  V.34's.** The DIGITAL modem plays the part §11.2 gives the CALL modem — tone B,
  INFO0d — and the analogue modem, which is the originate side, plays the answer
  modem's. Getting that backwards puts both ends on the same tone, and it is the
  same shape of mistake `setPhase3Lead` exists to prevent one phase later.
  `setPhase2Enabled(false)` is no longer called anywhere; `setPhase2Profile`
  supplies the part and the four INFO specs, and `setPhase2Only(true)` is what
  stops the digital modem's V.34 instance transmitting once §9.2 is done, because
  §9.3.1's part is PCM.
- **`phase2Active` is not `!phase2Complete`, and V90.js's receive routing depends
  on the difference.** An instance that has never generated a sample has not
  completed Phase 2 either, so routing received audio on the negation starves a
  receiver that is only ever a receiver — `v90test`'s acquisition-from-every-phase
  section is exactly that, and it went red on it.
- **`dsptest2` is unreliable running many real-time protocols in one process.**
  V.21 failed in a five-protocol batch and passes every time alone; that is
  contention in the harness, not a protocol regression. Run in small batches before
  reading a red result as real. `connect-timing` takes its protocol list from
  ARGV, not from `ONLY` — `ONLY=V34 node tools/connect-timing.js` silently runs the
  whole menu.
- **Phase 3 must never reach the data burst's acquisition.** `_process`'s preamble
  predicate is "two consecutive |dφ| > 2.0 then three < 0.6", and TRN is hundreds
  of symbols of RANDOM 90° rotations, so that pattern turns up by chance roughly
  once per thousand positions — a ~40% false lock per TRN. `rxPhase` is the guard,
  and it clears only on the silence that ends Phase 3. Any new training signal on
  a shared receiver needs the same treatment.
- **The S timing lock has two parities and they differ by a REFLECTION, not a
  rotation.** The reference is taken from S by parity and nothing says which of
  S's two points is which. A rotation would be harmless — differential decoding is
  rotation-invariant — but `label = 3 − true` negates every `In`, so Ja decodes to
  noise and no frame sync is ever found. S and S̄ stay perfectly recognisable under
  it, which is why the presence detector never noticed and only the Ja demodulator
  did. §10.1.3.7's "S̄ shall begin with the transmission of point 0 rotated by 180
  degrees" is the disambiguator: that symbol labels as 2 under an even lock and 1
  under an odd one. `_resolveP3Parity` is one comparison, and the decoder restarts
  there because everything before it was read off the wrong map.
- **Silence inside the downstream is not merely quiet — it is a sample count that
  is not a multiple of six.** Waiting for CP by emitting zeros walks the whole
  downstream off the data frame phase Sd established. The `dil` stage tests
  termination and `_enterData()` TOGETHER at a segment boundary and sends another
  segment when either fails; §8.4.1 repeats the sequence until the analogue modem
  terminates it, so probing while waiting is the procedure rather than a stall.
- **A V.90 Phase 3 gate that reads `up.p3` is counting the ANALOGUE modem's
  signals, and there are three S-to-S̄ transitions.** §9.3.2.1's at the head,
  §9.3.2.8's after J′d, §9.3.2.10's terminator. `_dilTerminated` wants the third;
  `setPhase3SbarTarget(3)` is what stops §9.3.2.4's mid-Phase-3 silence being read
  as the end of Phase 3. The NOTE under §9.3.1.6 is about exactly this counting.
- **`_p3Next`'s cursors must be cleared BEFORE advancing a stage.** Ja re-arms the
  same bit array every repetition; a stage that re-enters with the cursor still at
  the end neither emits nor terminates, which is an infinite loop inside
  `generateAudio` and looks exactly like the sandbox WS hang.
- **`_installPhase3Tail()` runs at the END of V90's constructor.** It sets `_dil`,
  and the downstream-state block still assigns `_dil = null`. Called earlier, the
  descriptor is silently wiped and the analogue modem's DIL expectation is empty —
  which presents as the far end's DIL never matching and data starting early.
- **A V.8 category constant that has never been on a wire is not covered by the
  hardware validation.** `V8_TAG_PCM_AVAIL` read `0 0 1 1` in this repo and in
  synthmodem, and is `0 1 1 0` — Table 2/V.8's row taken one column early, with
  the start bit counted as b0. PSTN access escaped the same slip because its row
  begins `0 | 1`. Both constants were declared and referenced nowhere, so
  synthmodem's real-hardware interop says nothing about them; what it validates
  is the call-function octet, modn0/1/2 and the decoder, none of which moved. The
  two categories a V.90 dial now sends are new wire content and want a
  real-hardware check before they are trusted like the rest of V.8.
- **Table 5/V.8 contradicts Table 2/V.8** on that same tag, printing T.66's. The
  collision is what settles it. → PROVENANCE.md §3.
- **For a PROCEDURE, read the prose clause, not the figure.** Figure 5/V.90's
  labels run left to right across two interleaved modem rows and invite reading
  TRN1d before Sd; §9.3.1 says the reverse and is unambiguous. The figure is
  still the right source for durations.
- **`SD_ZERO_TOL` covers Ucodes 0–22**, whose magnitudes are all ≤ 57. That is
  fine only because the Sd discriminator is consulted before Phase 3 begins and
  never after — DIL probes exactly those codewords, and a receiver that kept
  testing would read chord-1 DIL as Sd and never find data.
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
- **Refusing a concurrent request is not free: a 401 answering a credential
  that was about to verify makes the browser re-prompt.** That was the sysop
  panel asking for the password several times a day — two tabs (or a phone
  beside a desktop) polling a 5 s page collide inside one scrypt on every memo
  expiry. Same credential joins the verification; only a different one is still
  refused. Do not "simplify" that back to one slot for all callers.
- **`dayCounters.json` is a MIRROR, not a store.** It is adopted only if the
  stamp inside it is today's, and nothing else reads it; a missing, unreadable
  or stale file leaves the counters fresh, which is what happened before it
  existed. It lives in the LOG directory, not `cache/`, because `dir` is how a
  harness isolates itself — `sysoptest`, `httptest` and `directtest` boot the
  real `server.js` against the real config and would otherwise overwrite the
  operator's live counters. `prune()` only deletes stamped `KIND-DATE.log`.
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
- **"That figure would not transcribe" is a claim to retest, not a finding.**
  Figure 14/V.34 was recorded as having refused retrieval for three cycles, and the
  CRC's register orientation was left unverified on that basis. It transcribes by
  the ordinary route and the register was upside down the whole time — MSB-first
  where the figure draws the information bit entering at stage 0 and the feedback
  at stages 15, 10 and 3. Both orientations round-trip perfectly against
  themselves, so only the figure could ever have said so.
- **A CRC both ends compute the same way is not a checked CRC.** `v34-phase2-check`
  simulates Figure 14 cell by cell and keeps the wrong orientation as a NEGATIVE
  control, because a section that cannot fail is not a check. Anything else
  transcribed from a figure gets the same treatment.
