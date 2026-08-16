# SynthLink — V.92 pre-implementation notes

Status: **exploratory notes only — spec not yet read in depth, no code written.**
Companion to `V90NOTES.md`. V.92 is titled *"Enhancements to Recommendation V.90"*,
so it is a **delta on V.90** and only makes sense once V.90 exists in the tree.
Specifics below are from the ITU abstract + secondary sources and **must be
confirmed against the ITU-T V.92 (and V.90) text** before implementation, the same
way the V.34 work began by fetching and parsing the spec.

## Sources
- **ITU-T V.92 (11/2000) PDF** (the normative source; "Enhancements to V.90"):
  https://www.itu.int/rec/dologin_pub.asp?lang=e&id=T-REC-V.92-200011-I!!PDF-E&type=items
- **No open-source V.92 implementation found.** linmodem (the V.34/V.90 cross-check
  we used) implements only V.34 + "the algebraic part of V.90" — no V.90 data pump
  finished, no V.92 at all. The only V.92 code that exists is **commercial DSP
  vendor libraries** (e.g. VOCAL, GAO Research) — not source-available, so there is
  nothing to cross-check against the way `v34.c`/`v90.c` served V.34/V.90. The spec
  is the sole reference; read `V90NOTES.md` alongside it.
- Depends on: **V.90 must be done first** (see `V90NOTES.md`) — the μ-law codec and
  the downstream PCM mapper are prerequisites.

---

## What V.92 adds over V.90 (four features)

1. **PCM upstream** — the headline. V.90 upstream was V.34 (≤ 33.6k) because that
   path crossed an analog loop with a full A/D. V.92 makes the **upstream** also
   PCM codeword selection, reaching **24k–48k** (in ~1.33 kbps steps, like V.90's
   downstream rate grid). Downstream is unchanged from V.90 (≤ 56k).
2. **Quick Connect (QC)** — shortens startup (~20 s → ~10 s) by training on the
   first call and caching analog/digital line characteristics for reuse, skipping
   most of the ranging/training on later calls.
3. **Modem on Hold (MOH)** — suspend the data session to take/make a voice call
   (call-waiting), then resume without dropping the connection.
4. **V.44 compression** — LZJH, replaces V.42bis (a separate recommendation, ITU-T
   V.44). A data-layer feature, orthogonal to the modulation.

---

## Which features matter for SynthLink (and which don't)

### PCM upstream — the big win, and a very natural fit
V.90's whole asymmetry (56 down / 33.6 up) exists **only** because the upstream
physically crossed an analog subscriber loop. **SynthLink has no analog loop in
either direction** — the WebSocket is a clean, symmetric PCM pipe. So V.92's PCM
upstream is essentially **the V.90 downstream mapper mirrored**: the same μ-law
codeword-selection technique, now client→server as well.

Two things that are *hard* about real PCM upstream are **free** here:
- Real PCM upstream needs the client's sample clock aligned to the CO's sampling
  instant ("the V.92 clock is set by the demodulation process and used in the
  upstream modulation"). SynthLink is already **sample-synchronous** — both ends
  share the 8 kHz WebSocket clock — so this timing alignment is automatic.
- Real upstream is limited by the upstream A/D and loop; here both directions are
  identical clean PCM pipes.

**Rate call (spec-faithful vs transport-max):** genuine V.92 is **56k down / 48k
up** — the 48k upstream cap comes from real-network upstream constraints modeled
by the μ-law codec's usable level subset. Because our transport is clean *both*
ways, we *could* run the full ~56k in both directions, but that is **not V.92**
(it's closer to "symmetric PCM"); staying spec-faithful means honoring the 48k
upstream structure. Same modeling judgment as V.90 (§ μ-law codec), just now
applied to the upstream too.

### Quick Connect — trivially already satisfied
QC exists to avoid re-training by remembering line conditions. On a clean,
deterministic link **there is nothing to learn or retrain** — startup is inherently
fast. This folds into the "simplified startup" scope-out the other self-training
protocols already use; there is no meaningful QC work to do beyond keeping startup
short. (If ever wanted for flavor, a cached-profile fast-path is easy but pointless
on a lossless channel.)

### Modem on Hold — not applicable on a WebSocket
MOH suspends the data session to service a **PSTN call-waiting / voice call**. There
is no PSTN voice path to switch to over a WebSocket, so MOH is **out of scope / N/A**.
The underlying *mechanism* (graceful suspend + resume of a live session) could in
principle be repurposed as a generic pause/resume, but that would not be V.92 MOH
and has no obvious SynthLink use. Note and move on.

### V.44 compression — orthogonal, optional, any-protocol
V.44 (LZJH) is a data-layer codec independent of the modulation; it could be bolted
onto **any** SynthLink protocol, not just V.92. Out of scope for a V.92 *data-pump*
effort; worth a separate note if compression is ever wanted. (Also: compressing a
BBS/telnet text stream over an already-fast clean link is marginal benefit.)

---

## μ-law codec — inherited from V.90, now bidirectional
Everything in `V90NOTES.md` about **inserting an 8-bit μ-law quantizer as the
modeled network codec** applies unchanged, and V.92 simply uses it in **both**
directions. Same honesty flag: this is *modeling the network* to create the
bottleneck V.9x targets (legitimate, like treating the WebSocket as a 4-wire line),
and it must be stated explicitly in PROTOCOLS.md. The usable-level subset is what
yields 56k down / 48k up rather than a raw 64k.

---

## What's simpler / genuine-minimal scope-outs
Inherits all of V.90's simplifications (no carrier/RRC/matched-filter/timing
recovery — the symbols *are* the PCM samples), plus V.92-specific drop-outs on the
clean link:
- **Quick Connect** collapses to "startup is already short" (nothing to cache).
- **MOH** omitted (no PSTN voice path).
- **V.44** omitted from the data-pump scope (orthogonal, optional).
- No digital-impairment-learning, no upstream analog-loop equalizer, no
  robbed-bit-signaling handling, no PCM-law auto-detect (we own the codec).

The real V.92-specific work over a finished V.90 is therefore **just the PCM
upstream mapper** — structurally the V.90 downstream mapper mirrored — plus the
rate-negotiation that advertises upstream PCM capability.

---

## Open questions to confirm against the spec (do NOT trust memory/secondary sources)
- Exact **PCM upstream frame structure** and how it differs from downstream (it is
  not a perfect mirror in real V.92 — there are upstream-specific constraints).
- The **upstream rate grid** and why it caps at 48k (which level subset / spectral
  constraints), so the modeled cap is spec-derived, not arbitrary.
- The **Quick Connect** phase structure (short phase 1–4) — how much is even present
  once the clean-link startup is collapsed.
- Whether **V.8/V.8bis** selection needs any V.92-specific capability bits.
- MOH signalling (confirm it is genuinely irrelevant to the transport before
  dismissing).
- How V.92 **falls back** to V.90 / V.34 upstream when PCM upstream isn't available
  (on a clean link it always is, but the negotiation still has to be represented).

---

## Suggested sequencing (mirrors the V.34/V.90 method)
1. **Do V.90 first** (`V90NOTES.md`): μ-law codec + downstream PCM mapper, each
   standalone round-trip-verified before wiring.
2. Fetch + read the ITU-T V.92 (and re-read V.90) PDFs; no source to cross-check,
   so lean harder on the spec and on standalone verification.
3. Build the **PCM upstream mapper** as a standalone, round-trip-verified component
   (bits→codewords→bits), mirroring the downstream mapper. Reuse the μ-law codec.
4. Wire upstream + downstream together; represent the rate negotiation (56/48).
5. Decide QC (trivial), MOH (omit), V.44 (separate/optional) explicitly in
   PROTOCOLS.md.
6. Wire the four integration points + bundle + browser test; update
   PROTOCOLS.md / PROVENANCE.md / HANDOFF.md / DEVLOG.md.

**Bottom line:** V.92 is the natural sequel to V.90 on this transport, not a
separate mountain. Its headline feature — **PCM upstream** — is exactly what a
clean, sample-synchronous, symmetric PCM channel makes easy (the analog-loop reason
for V.90's upstream cap is gone, and the clock-alignment requirement is free).
Genuine V.92 is **56k down / 48k up**; the transport could physically do 56/56, but
that would be non-standard. QC is trivially satisfied, MOH is N/A, V.44 is
orthogonal — so the real added work over V.90 is the upstream PCM mapper.
