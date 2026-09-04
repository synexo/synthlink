#!/usr/bin/env node
// Unit test for lib/site.js — the branding/port configuration and the {{TOKEN}}
// substitution the static handler applies to every .html under public/.
//
// Two things are worth asserting and neither needs a socket:
//   1. The config itself: defaults when the file is absent or broken, the file's
//      values when it is good, PORT still winning over the file.
//   2. The substitution: every token replaced, an unknown token left visibly
//      alone, and — the one that matters — that no .html in public/ still
//      carries a hard-coded product name that a rebrand would miss.
//
// It writes a scratch config/site.json and restores the real one on exit, the
// same pattern (and the same caveat) as tools/tests/logtest.js: if this dies mid-run,
// check that file before wondering why the server is serving odd branding.
//
//   node tools/tests/sitetest.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const FILE = path.join(ROOT, 'config', 'site.json');
const PUBLIC = path.join(ROOT, 'public');

let pass = 0, fail = 0;
function ok(cond, what) {
  if (cond) { pass++; }
  else { fail++; console.error(`  FAIL  ${what}`); }
}
function eq(got, want, what) {
  ok(got === want, `${what}\n        got:  ${JSON.stringify(got)}\n        want: ${JSON.stringify(want)}`);
}

// ── Scratch config, with the real one preserved ─────────────────────────────
const REAL = fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8') : null;
function restore() {
  if (REAL === null) { try { fs.unlinkSync(FILE); } catch (_) {} }
  else fs.writeFileSync(FILE, REAL);
}
process.on('exit', restore);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { restore(); process.exit(1); });

// Fresh module instance per scenario: lib/site.js caches its config on first
// read, exactly as the running server does.
function withConfig(text, fn) {
  if (text === null) { try { fs.unlinkSync(FILE); } catch (_) {} }
  else fs.writeFileSync(FILE, text);
  delete require.cache[require.resolve('../../lib/site')];
  const site = require('../../lib/site');
  site._reset();
  return fn(site);
}

console.log('lib/site.js\n');

// ── 1. Defaults ─────────────────────────────────────────────────────────────
// A file that is PRESENT but says nothing: every setting takes its default, and
// that is not an error — the operator wrote a file and left the defaults alone.
withConfig('{}', (site) => {
  eq(site.fatal(), null, 'an empty but present file is fine');
  eq(site.config().brand, 'SynthLink', 'and every setting takes its default');
});
// A file that is ABSENT is a different thing, and is fatal.
withConfig(null, (site) => {
  ok(/missing/.test(site.fatal() || ''),
     'a missing file is FATAL — this server does not run on a configuration nobody wrote');
});

withConfig('{ this is not json', (site) => {
  ok(/not valid JSON/.test(site.fatal() || ''),
     'a malformed file is fatal, rather than discarding every setting in it and carrying on');
});

withConfig('[1,2,3]', (site) => {
  ok(site.fatal() !== null, 'a file that is not an object is fatal');
});

// ── 2. Values from the file ─────────────────────────────────────────────────
const CUSTOM = JSON.stringify({
  brand: 'Nodeline', tagline: 'Dial it up.', titleSuffix: 'a BBS terminal',
  favicon: '/brand.png', port: 9100,
});
withConfig(CUSTOM, (site) => {
  const t = site.tokens();
  eq(t.TITLE, 'Nodeline — a BBS terminal', 'title is brand + suffix');
  delete process.env.PORT;
  eq(site.port(), 9100, 'port from file');
  process.env.PORT = '7000';
  eq(site.port(), 7000, 'PORT env overrides the file');
  process.env.PORT = '0';
  eq(site.port(), 0, 'PORT=0 is honoured — "any free port", for a harness');
  process.env.PORT = 'not-a-port';
  eq(site.port(), 9100, 'an unusable PORT falls back to the file');
  delete process.env.PORT;
});

withConfig(JSON.stringify({ brand: 'Solo', titleSuffix: '' }), (site) => {
  eq(site.tokens().TITLE, 'Solo', 'empty suffix → the brand alone, no dash');
});

withConfig(JSON.stringify({ brand: 'X', port: 99999 }), (site) => {
  eq(site.config().port, 8088, 'out-of-range port falls back to the default');
  ok(site.fatal() !== null, 'an out-of-range port is fatal');
});

// ── 2b. The two operational settings ────────────────────────────────────────
// Both are numbers with a meaningful 0, which is the trap: `||` on either would
// quietly turn "no idle timeout" and "no scrollback" back into the defaults, so
// the 0 cases are asserted explicitly rather than assumed.
withConfig('{}', (site) => {
  eq(site.config().idleDisconnectMinutes, 30, 'idle disconnect defaults to 30 minutes');
  eq(site.config().scrollbackLines, 5000, 'scrollback defaults to 5000 lines');
  eq(site.tokens().SCROLLBACK, '5000', 'the default reaches the page as a token');
});
withConfig(JSON.stringify({ idleDisconnectMinutes: 5, scrollbackLines: 250 }), (site) => {
  eq(site.config().idleDisconnectMinutes, 5, 'idle disconnect from the file');
  eq(site.config().scrollbackLines, 250, 'scrollback from the file');
  eq(site.tokens().SCROLLBACK, '250', 'and the token follows it');
});
withConfig(JSON.stringify({ idleDisconnectMinutes: 0, scrollbackLines: 0 }), (site) => {
  eq(site.config().idleDisconnectMinutes, 0, '0 minutes means disabled, not "use the default"');
  eq(site.config().scrollbackLines, 0, '0 lines means no scrollback, not "use the default"');
  eq(site.fatal(), null, 'and neither 0 is an error');
});
withConfig(JSON.stringify({ idleDisconnectMinutes: -1 }), (site) => {
  eq(site.config().idleDisconnectMinutes, 30, 'a negative idle timeout falls back');
  ok(/idleDisconnectMinutes/.test(site.fatal() || ''), 'and is fatal, naming the setting');
});
// ── 2c. The telnet-bypass gates ─────────────────────────────────────────────
// The listed-boards gate is the first boolean this file carries, and a security
// gate that cannot be read out of the file is as bad as one that silently turns
// itself off — so both directions are asserted, and so is a value of the wrong
// type, which must warn rather than be taken as truthy.
withConfig('{}', (site) => {
  eq(site.config().directRequireListed, true, 'telnet bypass is gated on the directory by default');
  eq(site.config().directMinIntervalSeconds, 10, 'and paced at one dial per 10s by default');
});
withConfig(JSON.stringify({ directRequireListed: false, directMinIntervalSeconds: 0 }), (site) => {
  eq(site.config().directRequireListed, false, 'the gate can be turned off deliberately');
  eq(site.config().directMinIntervalSeconds, 0, '0 seconds means no pacing, not "use the default"');
  eq(site.fatal(), null, 'and neither is an error');
});
withConfig(JSON.stringify({ directRequireListed: 'no' }), (site) => {
  eq(site.config().directRequireListed, true, 'a non-boolean gate keeps the safe default');
  ok(/directRequireListed/.test(site.fatal() || ''), 'and is fatal, naming the setting');
});
withConfig(JSON.stringify({ directMinIntervalSeconds: -5 }), (site) => {
  eq(site.config().directMinIntervalSeconds, 10, 'a negative interval falls back');
  ok(/directMinIntervalSeconds/.test(site.fatal() || ''), 'and is fatal, naming the setting');
});

// ── 2b-bis. Every way a config can be wrong is fatal ────────────────────────
// This file used to degrade to defaults and warn, on the reasoning that a server
// which will not start over a stray comma in a cosmetic setting is the worse
// failure. What that actually did was broader: a stray comma IS a JSON parse
// error, and the answer to it was to discard the operator's entire
// configuration — security settings included — and run on defaults without
// stopping. There is no cosmetic exemption now, because a carve-out for the
// harmless-looking settings is the cover a security setting slips through under.
console.log('\n── invalid configuration stops the server');

// A typo'd key name is the cheapest way to end up with an unarmed control and a
// file that reads as though it is armed. It used to be ignored in silence.
withConfig(JSON.stringify({ blockedPort: [25] }), (site) => {
  ok(/blockedPort/.test(site.fatal() || ''), 'an unknown key is fatal');
  ok(/did you mean blockedPorts/.test(site.fatal() || ''),
     'and the message names the setting it was probably meant to be');
});
withConfig(JSON.stringify({ maxSession: 5 }), (site) => {
  ok(site.fatal() !== null, 'a near-miss on any other key is fatal too');
});
// Notes are allowed: the shipped file documents itself in "_comment".
withConfig(JSON.stringify({ _comment: ['a note'], _note: 1, brand: 'X' }), (site) => {
  eq(site.fatal(), null, 'keys starting with _ are notes, not settings');
  eq(site.config().brand, 'X', 'and the real settings still load');
});
// The one that made this necessary. "no"/"false"/"off" are all truthy strings,
// and every one of them is what somebody writes when they mean the opposite.
for (const v of ['true', 'false', 'no', 'yes', 1, 0]) {
  withConfig(JSON.stringify({ directRequireListed: v }), (site) => {
    ok(site.fatal() !== null, `a boolean written as ${JSON.stringify(v)} is fatal`);
  });
}
withConfig(JSON.stringify({ maxSessions: '50' }), (site) => {
  ok(site.fatal() !== null, 'a number written as a string is fatal');
});
withConfig(JSON.stringify({ maxSessions: 2.5 }), (site) => {
  ok(/whole number/.test(site.fatal() || ''), 'a fraction where an integer belongs is fatal');
});
withConfig(JSON.stringify({ brand: 42 }), (site) => {
  ok(site.fatal() !== null, 'even a cosmetic setting of the wrong type is fatal');
});
// Several at once: the operator should see all of them, not fix one and rerun.
withConfig(JSON.stringify({ brand: 42, maxSessions: '5', nonsense: true }), (site) => {
  const f = site.fatal() || '';
  ok(/brand/.test(f) && /maxSessions/.test(f) && /nonsense/.test(f),
     'every problem in the file is reported at once');
});

// ── 2d. Dialling limits ─────────────────────────────────────────────────────
// connectTimeoutMs MOVED here from config/logging.json: how long to wait for a
// board is call behaviour, not a logging preference. The default also dropped
// from 15s to 5s, because a failed connect is now answered with a reorder tone
// and fifteen seconds of nothing is a long time to hold a caller for that.
withConfig('{}', (site) => {
  eq(site.config().connectTimeoutMs, 5000, 'connect timeout defaults to 5s');
  eq(site.config().maxSessions, 50, 'session ceiling has a default');
  eq(site.config().maxPerBoardConcurrent, 10, 'per-board concurrency has a default');
  eq(site.config().requireListedForAllDials, false,
     'listed-only mode is OFF by default — it removes real features');
  // EMPTY, not a copy of the shipped list. A default here would be a second
  // copy that drifts, and it would put the policy back out of the operator's
  // sight — which is the fault this replaced.
  eq(JSON.stringify(site.config().blockedPorts), '[]',
     'blockedPorts has no built-in default — config/site.json is the whole policy');
  eq(JSON.stringify(site.portRules()), '[]', 'so an absent setting parses to no rules');
  eq(site.fatal(), null, 'and an omitted setting is not an error — it is a site decision');
  eq(site.config().noDialTimeoutSeconds, 60, 'an undialled socket is closed after 60s');
  eq(site.config().carrierTimeoutSeconds, 120, 'a dial that never trains is closed after 120s');
});
withConfig(JSON.stringify({ connectTimeoutMs: 999999 }), (site) => {
  eq(site.config().connectTimeoutMs, 5000, 'an out-of-range connect timeout falls back');
  ok(/connectTimeoutMs/.test(site.fatal() || ''), 'and is fatal, naming the setting');
});
withConfig(JSON.stringify({ maxSessions: 0, maxPerBoardConcurrent: 0 }), (site) => {
  eq(site.config().maxSessions, 0, '0 sessions means unlimited, not "use the default"');
  eq(site.config().maxPerBoardConcurrent, 0, 'and so does 0 per board');
  eq(site.fatal(), null, 'and neither is an error');
});
// blockedPorts is the whole port policy, so it gets its own shape AND its own
// failure mode. Everything else in this file degrades to a default and warns; a
// denial rule that quietly failed to parse reads as protection and is not, so
// this one stops the server instead. → server.js's boot check on site.fatal().
withConfig(JSON.stringify({ blockedPorts: ['1-22', '24-1023', 3306] }), (site) => {
  eq(JSON.stringify(site.config().blockedPorts), '["1-22","24-1023",3306]',
     'the list is kept verbatim, ranges as written');
  eq(site.portRules().length, 3, 'and parses to one rule per entry');
  eq(site.fatal(), null, 'a well-formed list is not fatal');
  eq(site.fatal(), null, 'and is not an error');
});
// The entries are not coerced. A parseInt over the list would turn "1-22" into
// 1 — blocking a single port while reading as though it blocked a thousand.
withConfig(JSON.stringify({ blockedPorts: ['1-22'] }), (site) => {
  const r = site.portRules();
  eq(JSON.stringify(r), '[{"lo":1,"hi":22}]', 'a range is a range, not its first number');
});
withConfig(JSON.stringify({ blockedPorts: [] }), (site) => {
  eq(JSON.stringify(site.portRules()), '[]', 'an empty list blocks nothing, deliberately');
  eq(site.fatal(), null, 'and that is a site decision, not an error');
});
withConfig(JSON.stringify({ blockedPorts: ['1-22', 'nonsense'] }), (site) => {
  ok(/blockedPorts/.test(site.fatal() || ''), 'a malformed entry is FATAL, naming the setting');
  ok(/nonsense/.test(site.fatal() || ''), 'and names the entry that could not be read');
  eq(JSON.stringify(site.portRules()), '[]',
     'and no partial policy is left behind — half a denial rule is not a denial rule');
});
withConfig(JSON.stringify({ blockedPorts: ['9-2'] }), (site) => {
  ok(!!site.fatal(), 'a backwards range is fatal too — it would match nothing silently');
});
withConfig(JSON.stringify({ blockedPorts: 'nope' }), (site) => {
  ok(/blockedPorts/.test(site.fatal() || ''), 'and so is a value that is not a list at all');
});

withConfig(JSON.stringify({ requireListedForAllDials: 'yes' }), (site) => {
  eq(site.config().requireListedForAllDials, false, 'a non-boolean keeps the safe default');
  ok(/requireListedForAllDials/.test(site.fatal() || ''), 'and is fatal, naming the setting');
});

withConfig(JSON.stringify({ scrollbackLines: 999999 }), (site) => {
  eq(site.config().scrollbackLines, 5000, 'an absurd ring size falls back');
  ok(/scrollbackLines/.test(site.fatal() || ''), 'and is fatal, naming the setting');
});
withConfig(JSON.stringify({ scrollbackLines: 'lots' }), (site) => {
  eq(site.config().scrollbackLines, 5000, 'a non-numeric ring size falls back');
});

// ── 3. Substitution ─────────────────────────────────────────────────────────
withConfig(JSON.stringify({ brand: 'Ma & Pa', tagline: 'Tag', titleSuffix: 's' }), (site) => {
  eq(site.apply('<h1>{{BRAND}}</h1>'), '<h1>Ma &amp; Pa</h1>',
     'a brand with an ampersand is escaped, not left to break the markup');
  eq(site.apply('{{BRAND}} {{BRAND}}'), 'Ma &amp; Pa Ma &amp; Pa', 'every occurrence replaced');
  eq(site.apply('{{NOPE}}'), '{{NOPE}}',
     'an unknown token is left visible rather than silently blanked');
  eq(site.apply('no tokens here'), 'no tokens here', 'plain text is untouched');
  eq(site.apply('<title>{{TITLE}}</title>'), '<title>Ma &amp; Pa — s</title>', 'derived title token');
});

// ── 4. The front end carries no hard-coded product name ─────────────────────
// The point of all of the above is that one edit rebrands the whole page. A
// literal "SynthLink" left in a served .html would quietly survive that edit —
// so this asserts it is not there, in the markup itself. Comments are stripped
// first: the files explain the scheme in prose, and that prose is allowed to
// name the default.
//
// UPSTREAM ATTRIBUTION IS EXEMPT, and it is a different thing that happens to
// be spelled the same. "Powered by SynthLink", linked to the project's own
// repository, names the OPEN-SOURCE PROJECT rather than this deployment: it
// must NOT change when an operator rebrands, because renaming it would
// misattribute the project. The brand in the tab title and the panel copy must
// change, and still has to be a token.
//
// The exemption is therefore structural, not a hole in the pattern: only the
// text inside a link to the repository is stripped, so the name pasted into a
// heading, a paragraph or a title= attribute still fails here.
const NAME = /SynthLink/;
const UPSTREAM = /<a\b[^>]*href="https:\/\/github\.com\/synexo\/synthlink"[^>]*>[\s\S]*?<\/a>/gi;
for (const f of ['index.html', 'welcome.html', 'about.html']) {
  const raw = fs.readFileSync(path.join(PUBLIC, f), 'utf8');
  const markup = raw.replace(/<!--[\s\S]*?-->/g, '').replace(UPSTREAM, '');
  ok(!NAME.test(markup), `public/${f} has no hard-coded product name in its markup`);
}
ok(fs.existsSync(path.join(PUBLIC, 'favicon.svg')), 'the default favicon file ships');
// SVG is parsed as XML, not as HTML: it is well-formedness or nothing, and a
// browser rejects the whole file rather than the offending part. The trap that
// actually bit here was a double hyphen inside a comment (writing a CSS custom
// property name, "- -" joined), which is a hard XML parse error. Checked with a
// real strict parse rather than a regex, so anything else ill-formed — an
// unclosed tag, a bare & — is caught too.
{
  const svg = fs.readFileSync(path.join(PUBLIC, 'favicon.svg'), 'utf8');
  let wellFormed = true, why = '';
  try {
    // sax-free: Node has no XML parser, so use the one every browser agrees
    // with — DOMParser is not available here either, hence a hand check of the
    // two things that are actually easy to get wrong, plus a structural pass.
    for (const m of svg.matchAll(/<!--([\s\S]*?)-->/g)) {
      if (m[1].includes('--')) { wellFormed = false; why = 'double hyphen inside a comment'; }
    }
    const stripped = svg.replace(/<!--[\s\S]*?-->/g, '');
    if (/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(stripped)) {
      wellFormed = false; why = 'unescaped ampersand';
    }
    // Tag balance, ignoring self-closing tags.
    const stack = [];
    for (const m of stripped.matchAll(/<(\/?)([a-zA-Z][\w:-]*)[^>]*?(\/?)>/g)) {
      if (m[3] === '/') continue;
      if (m[1] === '/') { if (stack.pop() !== m[2]) { wellFormed = false; why = `unbalanced </${m[2]}>`; } }
      else stack.push(m[2]);
    }
    if (stack.length) { wellFormed = false; why = `unclosed <${stack[stack.length - 1]}>`; }
  } catch (e) { wellFormed = false; why = e.message; }
  ok(wellFormed, `public/favicon.svg is well-formed XML${why ? ` (${why})` : ''}`);
}
// main.js reads the meta rather than hard-coding a name in anything it renders.
const mainjs = fs.readFileSync(path.join(PUBLIC, 'main.js'), 'utf8');
ok(/meta\[name="app-brand"\]/.test(mainjs), 'main.js reads the brand from the meta tag');

// ── 5. No font a browser's font-visibility policy will refuse ───────────────
// Firefox (privacy.resistFingerprinting) and Chrome both restrict which
// installed families a page may name, to stop it fingerprinting a machine by
// its font list. A refused family is not silently skipped — it is logged on
// every single page load ("Request for font 'DejaVu Sans Mono' blocked at
// visibility level 2 (requires 3)"), which is how this was noticed.
//
// So the page names only families every policy allows. This checks BOTH places
// a font can be requested from: the stylesheet, and the canvas ctx.font strings
// in main.js, which are font requests too and were the half easy to forget.
{
  // Distro/optional faces that these policies class as user-installed. Not
  // exhaustive — it is the set that plausibly gets typed into a monospace
  // stack by someone working on Linux.
  const RESTRICTED = [
    'DejaVu Sans Mono', 'DejaVu Sans', 'Liberation Mono', 'Ubuntu Mono',
    'Noto Sans Mono', 'Fira Code', 'Fira Mono', 'JetBrains Mono',
    'Source Code Pro', 'Cascadia Code', 'Inconsolata', 'Hack', 'Roboto Mono',
    // Not restricted — worse. Android has no Courier New and aliases it to
    // Cutive Mono, a small light face nothing like its default monospace, so
    // naming it shrinks the whole UI on a phone while looking like the safe
    // universal fallback. The generic `monospace` covers that platform (and
    // every other) correctly, so this must stay out of the stack.
    'Courier New', 'Courier',
  ];
  const files = ['index.html', 'main.js', 'terminal.js', 'renderer.js', 'music.js']
    .filter((f) => fs.existsSync(path.join(PUBLIC, f)));
  for (const f of files) {
    const raw = fs.readFileSync(path.join(PUBLIC, f), 'utf8');
    // Strip comments first: the stylesheet explains this rule in prose and has
    // to be able to name the font that prompted it.
    const code = raw.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
                    .replace(/^\s*\/\/.*$/gm, '');
    for (const font of RESTRICTED) {
      ok(!code.includes(font), `public/${f} does not request the restricted family "${font}"`);
    }
  }
}

// Every token any served .html writes must be one lib/site.js knows, or it will
// reach the browser as literal braces.
withConfig(REAL, (site) => {
  const known = Object.keys(site.tokens());
  for (const f of ['index.html', 'welcome.html', 'about.html']) {
    const raw = fs.readFileSync(path.join(PUBLIC, f), 'utf8');
    for (const m of raw.matchAll(/\{\{([A-Z_]+)\}\}/g)) {
      ok(known.includes(m[1]), `public/${f} uses {{${m[1]}}}, which lib/site.js defines`);
    }
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
