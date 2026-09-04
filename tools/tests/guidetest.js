#!/usr/bin/env node
// Unit tests for the Telnet BBS Guide tier's two halves: the APPEND-ONLY merge
// in lib/bbslist.js, and the sort the dropdown offers over the result in
// public/main.js.
//
// They are one feature and are tested together on purpose. "Sort by newest" can
// only mean anything because the merge records a first-seen date and never
// rewrites one; a merge that replaced the cache each month would leave the sort
// silently telling the user that every board arrived on the same day.
//
// lib/bbslist.js is a plain module and is required outright — mergeEntries
// touches no filesystem. The sort side uses the extraction trick from
// tools/tests/sharelinktest.js, since public/main.js cannot be required.
//
//   node tools/tests/guidetest.js

const fs = require('fs');
const path = require('path');
const bbslist = require('../../lib/bbslist');

const MAIN = path.join(__dirname, '..', '..', 'public', 'main.js');
const SRC = fs.readFileSync(MAIN, 'utf8');

function extract(name) {
  const c = SRC.match(new RegExp(`^const ${name} = .*?;$`, 'm'));
  if (c) return c[0];
  const cd = SRC.indexOf(`const ${name} = `);
  const fn = SRC.indexOf(`function ${name}(`);
  if (fn < 0 && cd < 0) throw new Error(`guidetest: ${name} not found in public/main.js`);
  // A multi-line `const NAME = {…};` — the two label tables.
  if (fn < 0 || (cd >= 0 && cd < fn)) {
    const open = SRC.slice(cd).search(/[{[]/) + cd;
    const oc = SRC[open], cc = oc === '{' ? '}' : ']';
    let depth = 0;
    for (let j = open; j < SRC.length; j++) {
      if (SRC[j] === oc) depth++;
      else if (SRC[j] === cc && --depth === 0) return SRC.slice(cd, j + 1) + ';';
    }
    throw new Error(`guidetest: unbalanced ${oc} reading ${name}`);
  }
  let depth = 0;
  for (let j = SRC.indexOf('{', SRC.indexOf(')', fn)); j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}' && --depth === 0) return SRC.slice(fn, j + 1);
  }
  throw new Error(`guidetest: unbalanced braces reading ${name}`);
}

// sortGuide calls dialCount(), which reads the page's bbsCounts. Supplied here
// rather than extracted, so a test can state the counts it is sorting by.
let counts = {};
const NAMES = ['SORT_VALUES', 'SORT_LABELS', 'byName', 'sortGuide'];
const { SORT_VALUES, SORT_LABELS, sortGuide } = new Function('dialCount', [
  ...NAMES.map(extract), `return { ${NAMES.join(', ')} };`,
].join('\n'))((h, p) => counts[`${h}:${p}`] || 0);

let pass = 0, fail = 0;
function eq(actual, expected, what) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  fail++;
  console.log(`  FAIL ${what}\n       expected ${e}\n       actual   ${a}`);
}

console.log('guidetest — the guide tier: append-only merge + sort\n');

// ── The merge ───────────────────────────────────────────────────────────────
const { mergeEntries, entryKey } = bbslist;
const E = (name, host, port, added) => ({ name, host, port, ...(added ? { added } : {}) });

console.log('append-only merge');
{
  const jan = [E('Alpha', 'a.org', 23), E('Bravo', 'b.org', 23)];
  const first = mergeEntries([], jan, '2026-01-15T00:00:00.000Z');
  eq(first.entries.map((e) => e.name), ['Alpha', 'Bravo'], 'first ingest takes everything');
  eq(first.added, 2, 'and reports how many were new');
  eq(first.entries.every((e) => e.added === '2026-01-15'), true,
     'every entry is dated the day it was first seen, to the day');

  // The month that matters: one board gone, one new. The one that LEFT must
  // still be there — this is the whole point of the merge.
  const feb = [E('Alpha', 'a.org', 23), E('Charlie', 'c.org', 23)];
  const second = mergeEntries(first.entries, feb, '2026-02-15T00:00:00.000Z');
  eq(second.entries.map((e) => e.name), ['Alpha', 'Bravo', 'Charlie'],
     'a board that left the edition is kept, not deleted');
  eq(second.added, 1, 'only the genuinely new one counts as added');
  eq(second.entries.find((e) => e.name === 'Alpha').added, '2026-01-15',
     'a board seen before keeps its ORIGINAL date — the record is never rewritten');
  eq(second.entries.find((e) => e.name === 'Charlie').added, '2026-02-15',
     'and a new one is dated this run');

  // Re-ingesting the same file (a re-download, a hand-dropped zip) must be a
  // no-op. If it were not, "newest" would reset to "whenever we last fetched".
  const again = mergeEntries(second.entries, feb, '2026-03-01T00:00:00.000Z');
  eq(again.added, 0, 're-ingesting a known edition adds nothing');
  eq(again.entries.map((e) => e.added), ['2026-01-15', '2026-01-15', '2026-02-15'],
     'and moves no dates');

  // A record written before `added` existed. All of them are equally old, and
  // one shared date says exactly that; a blank would sort as newest or oldest
  // depending on the comparator, and both would be a lie.
  const legacy = mergeEntries([{ name: 'Old', host: 'o.org', port: 23 }], [],
                              '2026-04-01T00:00:00.000Z');
  eq(legacy.entries[0].added, '2026-04-01', 'an undated legacy record is backfilled');

  // Identity is name + host:port. csvToEntries deliberately does not collapse
  // boards sharing an address, so the merge must not either.
  const shared = mergeEntries([], [E('Amis XE', 's.org', 23), E('Baudville', 's.org', 23)],
                              '2026-05-01T00:00:00.000Z');
  eq(shared.entries.length, 2, 'two listings on one address stay two listings');
  eq(entryKey(E('X', 'H.ORG', 23)), entryKey(E('x', 'h.org', '23')),
     'the key is case- and type-insensitive, so casing churn is not a new board');

  // Never sorts in place, and always comes back alphabetical.
  const src = [E('Zulu', 'z.org', 23), E('alpha', 'a.org', 23)];
  const out = mergeEntries([], src, '2026-06-01T00:00:00.000Z');
  eq(out.entries.map((e) => e.name), ['alpha', 'Zulu'], 'merged output is alphabetical');
  eq(src.map((e) => e.name), ['Zulu', 'alpha'], 'and the input array is untouched');
}

// ── The sort ────────────────────────────────────────────────────────────────
console.log('guide sort');
{
  eq(Object.values(SORT_VALUES).sort(), ['alpha', 'dialed', 'newest'],
     'three modes, and their sentinels map onto them');
  eq(Object.keys(SORT_VALUES).every((v) => v.startsWith('@')), true,
     'every sentinel starts with @, which cannot occur in a host:port');
  eq(Object.keys(SORT_VALUES).every((v) => !!SORT_LABELS[SORT_VALUES[v]]), true,
     'and every mode has a label');

  const list = [
    E('Charlie', 'c.org', 23, '2026-03-01'),
    E('alpha',   'a.org', 23, '2026-01-01'),
    E('Bravo',   'b.org', 23, '2026-02-01'),
    E('delta',   'd.org', 23, '2026-02-01'),
  ];
  counts = { 'c.org:23': 5, 'b.org:23': 5, 'a.org:23': 99 };

  eq(sortGuide(list, 'alpha').map((e) => e.name), ['alpha', 'Bravo', 'Charlie', 'delta'],
     'alphanumeric ignores case');
  eq(sortGuide(list, 'dialed').map((e) => e.name), ['alpha', 'Bravo', 'Charlie', 'delta'],
     'most dialed first, ties broken alphabetically (Bravo before Charlie at 5 each)');
  eq(sortGuide(list, 'newest').map((e) => e.name), ['Charlie', 'Bravo', 'delta', 'alpha'],
     'newest first, same-day arrivals alphabetical');

  // An unknown mode is the alphabetical default rather than an unsorted list:
  // a stored preference from a future build must not leave the dropdown in
  // whatever order the payload happened to arrive in.
  eq(sortGuide(list, 'nonsense').map((e) => e.name), sortGuide(list, 'alpha').map((e) => e.name),
     'an unrecognised mode falls back to alphanumeric');

  // A server too old to send `added` sorts last under newest — "we don't know"
  // is not "brand new".
  const mixed = [E('Dated', 'x.org', 23, '2026-01-01'), E('Undated', 'y.org', 23)];
  eq(sortGuide(mixed, 'newest').map((e) => e.name), ['Dated', 'Undated'],
     'an entry with no date sorts last, not first');

  // The list the pool is built from must survive being displayed in three
  // different orders; sorting in place would make each order depend on the last.
  const before = list.map((e) => e.name);
  sortGuide(list, 'dialed'); sortGuide(list, 'newest');
  eq(list.map((e) => e.name), before, 'sortGuide never sorts its input in place');

  // A board nobody has dialled must still appear.
  counts = {};
  eq(sortGuide(list, 'dialed').length, list.length, 'zero counts drop nothing');
}

console.log(`\n${fail === 0 ? 'OK' : 'FAILED'} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
