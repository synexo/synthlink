# CLEANUP.md

**Temporary. Written to instruct one session, and deleted when that session
ships.** If you are reading this and the work below is done, delete the file.
(STICKYFIX.md said the same thing and is still here. That is the disease.)

The tree is 100% Claude-written. Every excess below was added by a session that
believed it was being helpful, including the one that wrote this document.

---

## Measured, so you don't re-derive it

| | files | lines | bytes | comment |
|---|---|---|---|---|
| Runtime (server, lib, public, src) | 18 | 10,955 | 521,805 | **48.8%** |
| `tools/tests/` | 42 | 10,623 | 534,694 | 31.5% |
| `tools/` non-test | 10 | 1,373 | 64,560 | — |
| Docs (.md, DEVLOG\* excluded) | 12 | 3,913 | 225,275 | — |

**Code comments are 2.21× the documentation by volume.** Roughly half of every
runtime source file is prose. The test suite is larger than the application it
tests, in files by more than 2:1.

Worst runtime files: `fontmask.js` 88%, `embed.js` 73%, `fontscale.js` 68%,
`site.js` 66%, `altfonts.js` 59%, `bbsstats.js` 55%, `main.js` 54% (136 KB of
comment in one file), `renderer.js` 53%, `configload.js` 51%, `server.js` 50%,
`netguard.js` 49%.

HANDOFF.md: 309 lines of "Current status", 49 watch-out bullets.

Reproduce with a throwaway scanner; **do not add a tool for this.**

---

## Why it happens — read this before deciding what to cut

**Claude calibrates on the tree, not on the rules.** CLAUDE.md rule 6 says
comments are one or two lines. The last session read `telnet.js`, `site.js` and
`main.js` — all ~50% comment — then wrote `configload.js` at 51% and `site.js`
up to 66%, having read the rule that morning. The surrounding code is a louder
instruction than the document, every time. The same mechanism produced the 43rd
test harness: standalone harnesses are what the directory models, so that is
what gets written.

**This means cleanup is not a tidy-up, it is the prevention.** No wording in
CLAUDE.md will hold while the tree teaches the opposite.

**Rules decay unless something fails.** The rules that get followed here have
scars attached and a failing suite behind them. Rule 6 has neither.

**But scars expire, and nobody retires them.** Standing rule 3 still narrates
Bell 103's `dsptest2` failure — settled dozens of sessions ago. The story earned
its place when the mistake was live; it is now 9 of the 48 lines of standing
rules, teaching a lesson nobody is at risk of repeating. Every document here
accretes and nothing is ever removed.

---

## The work, in order. Run the full suite between phases.

### 1. Delete spent documents

- **MOBILESESSIONFIX.md** — first line: "IMPLEMENTED, DID NOT WORK, AND HAS BEEN
  REVERTED." A document describing code that no longer exists. The file has been
  deleted, check for errant references.
- **CLEANUP.md** — this file, when you are done.

Anything genuinely worth keeping from the first two moves to DEVLOG.md as one
paragraph. Do not move it to HANDOFF.

### 2. HANDOFF.md — triage against one question

**"Would a session that did not know this re-break something?"**

- Yes → keep, one or two lines.
- No → it is history. DEVLOG.md, or nothing.

"Current status" is 309 lines because every session appended its announcement.
Most of it is settled and reads as news. Rewrite it as *what is true now*, not
*what changed recently*. Target ≤ 100 lines.

The 49 watch-outs are the genuinely valuable part of this repo's documentation —
several would have cost a session each to rediscover. But several are also
settled history. Apply the same question. Target ~25.

### 3. CLAUDE.md standing rules

Keep all seven rules. **Retire the war stories whose subject is settled**, Bell
103 first. The principle survives in one line; the story goes to DEVLOG.

Then add the anti-bloat rules in section 6 below.

### 4. Comments — the bulk of the work

**Targets: runtime files ≤ 10%, test harnesses ≤ 20%.** `vendor/src/dsp/` is
untouched — its ITU citations are rule 6's stated exemption and they make the
clean-room implementation auditable.

Expect to remove roughly 200 KB. Work worst-first; the top five files are a
third of it.

What to cut, in order of confidence:

- **Counterfactuals.** "The alternative was X, which fails because Y." Design
  record. → DEVLOG.
- **History.** "This used to be Z and that was wrong." → DEVLOG.
- **Restatement of the code.** If the line below says it, delete the comment.
- **Reasoning repeated in a document.** The same argument now appears in a module
  header, a HANDOFF watch-out, README and DEVLOG. One copy. The doc map already
  says "don't duplicate — cross-reference by name."

What to keep:

- The one-line *why* for anything non-obvious.
- Anything whose absence would let a future session undo a deliberate decision —
  compressed to a sentence, not a paragraph. `renderer.cellAt()` being the only
  pixel→cell mapping is worth a line. Why the other approach was rejected is not.
- ITU citations in `vendor/`.

Do not delete a comment you do not understand. Leave it and note it.

### 5. Tooling

**Add exactly one thing: `npm test`.** A runner that discovers and runs
`tools/tests/*.js` and reports totals. It is a net reduction — it replaces a
hand-maintained list of 42 names that the last session could not hold and
therefore ran in ad-hoc batches. Without it, "every suite is expected to be
green" is unenforceable. Playwright harnesses need `PW_CHROMIUM`; let the runner
skip and report them rather than fail.

**Consolidate the nine protocol scaffolds.** `v34-*-check.js` and `v90-*-check.js`
are 9 files and 889 lines of development scaffolding for protocols that shipped.
CLAUDE.md keeps them as "the pattern" for the next protocol — that is a real
reason, but it does not need nine files. Fold each family into one, or into
`v34test.js` / `v90test.js`. **Do not delete the assertions.**

**Do not big-bang the harness duplication.** 26 of 42 declare their own pass/fail
counters, 20 their own `eq()`, 15 their own `ok()`. The fix is a shared
`tools/tests/_assert.js`, used by *new* harnesses and adopted opportunistically
when a file is being edited anyway. Migrating 42 files at once is exactly the
churn that breaks a green suite for no behavioural gain.

### 6. Rules to leave behind in CLAUDE.md

Short, numeric, and placed where the temptation is — not appended to a list read
once at the start of a session.

- **Sizes and counts, stated with the current numbers, and named as the problem:**
  *"The tree was ~49% comment with 42 harnesses; both were the thing being fixed,
  not the standard to match. No runtime file over 10% comment. A 43rd harness
  needs a reason a section in an existing one cannot serve."* Numbers, not
  adjectives — "one or two lines" is adjudicated per comment, where each one
  feels special.
- **An outlet for the impulse:** *long-form reasoning, counterfactuals and
  history go in DEVLOG.md; the code gets the one-line why.* Sessions over-comment
  mainly to stop a future session undoing a decision. Denied a legitimate home,
  that lands in the comments anyway.
- **A retirement policy:** *a war story earns its place while the mistake is
  live. Once the thing is settled, the rule keeps the principle and the story
  goes to DEVLOG.* Nothing here is ever retired, which is why the rules grew.
- **Verification:** *check claims about the repo's state by running the check,
  not from memory.* The last session asserted a deploy step was needed when it
  was not, and that a fresh clone could not start when the config files were
  tracked all along. Both were reasoning from memory.
- **Scope:** *change the files you were asked to change.* Rule 0 covers git;
  nothing covers this.

---

## Rules of engagement for the cleanup session itself

A cleanup session is the most likely session to make a mess.

- **Run the full suite before and after every phase. Green both times.**
- **Never delete a test, or weaken an assertion, to reduce the count.** Standing
  rule 1 applies with full force. The goal is less prose and fewer files, not
  less coverage.
- **Do not write a document about the cleanup.** One DEVLOG paragraph with the
  before/after numbers. Then delete this file.
- **Measure at the start and the end**, and put both numbers in that paragraph so
  the next session can see the direction of travel.
- **When unsure whether something is load-bearing, keep it and say so** in the
  final summary rather than deleting it quietly.

## What success looks like

- Runtime comment share under 10%; no file over it.
- HANDOFF status ≤ 100 lines, watch-outs ~25, every one of them load-bearing.
- `npm test` exists; nine scaffolds become two or fewer.
- Every suite green, with no assertion removed.
- This file deleted.
