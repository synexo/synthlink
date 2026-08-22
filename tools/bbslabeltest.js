#!/usr/bin/env node
// Unit test for the breakpoint-dependent BBS dropdown labels in public/main.js.
//
// main.js is a browser module that runs top-to-bottom against a live DOM and an
// AudioContext, so it can't be required. Instead this extracts the three pure-ish
// functions under test (bbsLabelText / bbsOption / relabelBBS) plus the
// currentDest name lookup, and drives them against a tiny <option>/<select>
// stand-in with a settable isMobile(). No sockets, no DOM library, sub-second.
//
//   node tools/bbslabeltest.js

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'main.js'), 'utf8');

// ── Minimal DOM stand-in ────────────────────────────────────────────────────
// Enough of <option> and <select> for the functions under test: textContent,
// value, and a dataset object. Real browsers lower-case dataset keys into
// data-* attributes; nothing here depends on that.
class FakeOption {
  constructor() { this.textContent = ''; this.value = ''; this.dataset = {}; }
}
const document = { createElement: () => new FakeOption() };
const bbsEl = { options: [] };

let MOBILE = false;
const isMobile = () => MOBILE;

// ── Extract the functions from main.js rather than duplicating them ─────────
// Pull the three declarations out by name so this test tracks the real source;
// if any is renamed or removed, the extraction fails loudly instead of silently
// testing a stale copy.
function extract(name) {
  const start = SRC.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`bbslabeltest: function ${name}() not found in public/main.js`);
  // Walk the parameter list to its closing paren first, THEN brace-match the
  // body. Scanning from the first '{' would stop on a destructured parameter —
  // none of these three has one today, but the same helper in
  // tools/sharelinktest.js hit exactly that and produced a signature with no
  // body and a syntax error pointing at the harness instead of the source.
  let i = SRC.indexOf('(', start), pd = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '(') pd++;
    else if (SRC[i] === ')' && --pd === 0) break;
  }
  let depth = 0;
  for (let j = SRC.indexOf('{', i); j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}' && --depth === 0) return SRC.slice(start, j + 1);
  }
  throw new Error(`bbslabeltest: unbalanced braces reading ${name}()`);
}

// The dial-count map the label functions read. Injected as an object and
// mutated in place, so the extracted dialCount() closes over the same one the
// test edits — exactly how main.js's module-level `bbsCounts` behaves.
const counts = {};

const { bbsLabelText, bbsOption, relabelBBS, bbsCountText, dialCount } = new Function(
  'document', 'bbsEl', 'isMobile', 'bbsCounts',
  [extract('bbsCountText'), extract('bbsLabelText'), extract('dialCount'),
   extract('bbsOption'), extract('relabelBBS'),
   'return { bbsLabelText, bbsOption, relabelBBS, bbsCountText, dialCount };'].join('\n')
)(document, bbsEl, isMobile, counts);

// currentDest()'s name lookup, which must not parse the label.
function destName(host, port) {
  const opt = bbsEl.options.find((o) => o.value === `${host}:${port}`);
  return (opt && opt.dataset.name) || '';
}

// ── Assertions ──────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
function eq(actual, expected, what) {
  if (actual === expected) { pass++; return; }
  fail++;
  console.log(`  FAIL ${what}\n       expected ${JSON.stringify(expected)}\n       actual   ${JSON.stringify(actual)}`);
}

// A named board, a long guide entry, and a hand-typed favourite with no name.
const BOARDS = [
  { name: 'Level 29',      host: 'bbs.fozztexx.com',            port: 23 },
  { name: 'Particles BBS', host: 'particlesbbs.dyndns.org',     port: 6400 },
  { name: '',              host: 'someones.long.hostname.example.org', port: 2323 },
];

console.log('bbslabeltest — BBS dropdown label form\n');

// 1. Desktop: full "Name · host:port"; unnamed entries are bare host:port.
MOBILE = false;
bbsEl.options = BOARDS.map(bbsOption);
eq(bbsEl.options[0].textContent, 'Level 29 · bbs.fozztexx.com:23', 'desktop named label');
eq(bbsEl.options[1].textContent, 'Particles BBS · particlesbbs.dyndns.org:6400', 'desktop named label (non-default port)');
eq(bbsEl.options[2].textContent, 'someones.long.hostname.example.org:2323', 'desktop unnamed label');

// 2. Values are the canonical host:port regardless of label form — this is what
//    selection, the keep-across-rebuild logic and favourite matching key on.
eq(bbsEl.options[0].value, 'bbs.fozztexx.com:23', 'desktop value');
eq(bbsEl.options[1].value, 'particlesbbs.dyndns.org:6400', 'desktop value (non-default port)');

// 3. Mobile: name only. The unnamed entry has nothing else to show, so it is
//    unchanged.
MOBILE = true;
bbsEl.options = BOARDS.map(bbsOption);
eq(bbsEl.options[0].textContent, 'Level 29', 'mobile named label');
eq(bbsEl.options[1].textContent, 'Particles BBS', 'mobile named label (non-default port)');
eq(bbsEl.options[2].textContent, 'someones.long.hostname.example.org:2323', 'mobile unnamed label falls back to host:port');
eq(bbsEl.options[1].value, 'particlesbbs.dyndns.org:6400', 'mobile value unchanged');

// 4. The regression this change could have caused: currentDest() must recover
//    the name on mobile, where the label has no ' · ' to split on. The old
//    textContent.split(' · ')[0] returns '' here.
eq(destName('particlesbbs.dyndns.org', 6400), 'Particles BBS', 'mobile name lookup (dataset, not label)');
eq(destName('someones.long.hostname.example.org', 2323), '', 'unnamed entry has no name');
eq(destName('not.in.the.list', 23), '', 'unknown destination has no name');
{
  // Explicitly show the old parse would have failed, so the test documents why
  // the dataset exists rather than just asserting the new behaviour.
  const label = bbsEl.options[1].textContent;
  eq(label.includes(' · '), false, 'mobile label carries no separator to split on');
}

// 5. Rotation: relabel in place, both directions, without touching values or
//    the stored names.
MOBILE = false;
relabelBBS();
eq(bbsEl.options[0].textContent, 'Level 29 · bbs.fozztexx.com:23', 'relabel mobile→desktop');
eq(bbsEl.options[2].textContent, 'someones.long.hostname.example.org:2323', 'relabel mobile→desktop (unnamed)');
MOBILE = true;
relabelBBS();
eq(bbsEl.options[0].textContent, 'Level 29', 'relabel desktop→mobile');
eq(bbsEl.options[0].value, 'bbs.fozztexx.com:23', 'relabel leaves value alone');
eq(destName('bbs.fozztexx.com', 23), 'Level 29', 'relabel leaves the stored name alone');

// 6. Non-destination options (Random, the "(no directory)" placeholder) have no
//    dataset.hp and must survive relabelling untouched.
{
  const random = new FakeOption();
  random.value = '@random';
  random.textContent = 'Random BBS Selection';
  bbsEl.options.push(random);
  MOBILE = false; relabelBBS();
  eq(random.textContent, 'Random BBS Selection', 'Random option untouched (desktop)');
  MOBILE = true; relabelBBS();
  eq(random.textContent, 'Random BBS Selection', 'Random option untouched (mobile)');
}

// 7. Idempotence — relabelling twice at one breakpoint changes nothing, so a
//    stray resize event can't degrade a label.
{
  const before = bbsEl.options.map((o) => o.textContent);
  relabelBBS(); relabelBBS();
  eq(bbsEl.options.map((o) => o.textContent).join('|'), before.join('|'), 'relabel is idempotent');
}

// 8. The breakpoint itself is the one the rest of the UI uses.
eq(/const isMobile = \(\) => window\.matchMedia\('\(max-width: 640px\)'\)\.matches;/.test(SRC),
   true, 'shares the existing 640px isMobile() helper');

// ── Dial counts: the bare (##) suffix ───────────────────────────────────────
// 9. Zero and unknown both render as nothing. A list of "(0)" down the side is
//    noise, and a board the server has never heard of is indistinguishable from
//    one nobody has dialled.
eq(bbsCountText(0), '', 'zero renders as no suffix');
eq(bbsCountText(undefined), '', 'unknown renders as no suffix');
eq(bbsCountText(1), ' (1)', 'one dial');
eq(bbsCountText(1482), ' (1482)', 'large count is not abbreviated');

// 10. Placement: beside the name on mobile, after the whole entry on desktop.
Object.assign(counts, {
  'bbs.fozztexx.com:23': 12,
  'particlesbbs.dyndns.org:6400': 3,
});
MOBILE = false;
bbsEl.options = BOARDS.map(bbsOption);
eq(bbsEl.options[0].textContent, 'Level 29 · bbs.fozztexx.com:23 (12)', 'desktop count after the whole entry');
eq(bbsEl.options[2].textContent, 'someones.long.hostname.example.org:2323', 'uncounted entry unchanged (desktop)');
MOBILE = true;
bbsEl.options = BOARDS.map(bbsOption);
eq(bbsEl.options[0].textContent, 'Level 29 (12)', 'mobile count beside the name');
eq(bbsEl.options[1].textContent, 'Particles BBS (3)', 'mobile count beside the name (non-default port)');

// 11. The count must not break the value, the stored name, or the mobile name
//     lookup — the same regression class as the ' · ' split.
eq(bbsEl.options[0].value, 'bbs.fozztexx.com:23', 'value unaffected by the count');
eq(destName('bbs.fozztexx.com', 23), 'Level 29', 'name lookup unaffected by the count');
eq(bbsEl.options[0].dataset.name, 'Level 29', 'dataset.name carries no count');

// 12. Relabelling rebuilds the count from dataset, not by re-parsing the label —
//     otherwise a rotation would append a second "(12)".
MOBILE = false; relabelBBS();
eq(bbsEl.options[0].textContent, 'Level 29 · bbs.fozztexx.com:23 (12)', 'relabel mobile→desktop keeps one count');
MOBILE = true; relabelBBS(); relabelBBS();
eq(bbsEl.options[0].textContent, 'Level 29 (12)', 'repeated relabel does not accumulate counts');

// 13. Host lookup is case-insensitive and defaults the port, matching the
//     server's key form — a favourite stored with different casing still counts.
eq(dialCount('BBS.FoZzTeXX.com', 23), 12, 'count lookup is case-insensitive');
eq(dialCount('bbs.fozztexx.com', undefined), 12, 'count lookup defaults to port 23');
eq(dialCount('not.in.the.list', 23), 0, 'unknown board counts zero');

console.log(`\n${fail ? 'FAILED' : 'OK'} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
