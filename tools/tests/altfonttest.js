#!/usr/bin/env node
// Board font overrides, both halves: the parser in lib/altfonts.js and the
// lookup in public/main.js that consumes what it serves.
//
// They are tested together because they have to agree about ONE thing and
// nothing else — the shape of a key. The server flattens `host:port` and bare
// `host` into a single map and the page probes it with the specific key first;
// if the two ever disagree about case, about the default port, or about which
// form wins, an override silently does not fire and the board just looks wrong.
// That failure has no error and no log line, which is exactly why it is
// asserted rather than left to reading.
//
// The parser touches the filesystem only through current(), so parse() is
// driven directly and the real config/altfonts.txt is never read.
// public/main.js cannot be required (it runs against a live DOM), so the lookup
// is extracted by name, the same trick sharelinktest and guidetest use — rename
// altFontFor and this throws rather than testing a stale copy.
//
//   node tools/tests/altfonttest.js

const fs = require('fs');
const path = require('path');
const altfonts = require('../../lib/altfonts');

const MAIN = path.join(__dirname, '..', '..', 'public', 'main.js');
const SRC = fs.readFileSync(MAIN, 'utf8');

function extract(name) {
  const fn = SRC.indexOf(`function ${name}(`);
  if (fn < 0) throw new Error(`altfonttest: ${name} not found in public/main.js`);
  let depth = 0;
  for (let j = SRC.indexOf('{', SRC.indexOf(')', fn)); j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}' && --depth === 0) return SRC.slice(fn, j + 1);
  }
  throw new Error(`altfonttest: unbalanced braces reading ${name}`);
}

let pass = 0, fail = 0;
function eq(actual, expected, what) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  fail++;
  console.log(`  FAIL ${what}\n       expected ${e}\n       actual   ${a}`);
}
function ok(cond, what) { eq(!!cond, true, what); }

(async () => {
  const { FONTS } = await import('../../public/fonts/index.js');
  const CS = await import('../../public/fonts/charsets.js');

  console.log('altfonttest — board font overrides\n');

  // ── 1. The parser ────────────────────────────────────────────────────────
  {
    const map = altfonts.parse([
      '# a comment',
      '',
      'bbs.example.org:2003   topaz1200',
      'AMIGA.EXAMPLE.NET      topaz1200',      // bare host, mixed case
      '   spaced.example.org:23\ttopaz1200 ',
      'not-two-fields',
      'three fields here',
      '[2001:db8::1]:23       topaz1200',      // IPv6 literal with a port
      'bad.example.org:99999  topaz1200',      // port out of range
    ].join('\n'));

    eq(map['bbs.example.org:2003'], 'topaz1200', 'host:port line');
    eq(map['amiga.example.net'], 'topaz1200', 'a bare host is lower-cased');
    eq(map['spaced.example.org:23'], 'topaz1200', 'leading/trailing/tab whitespace');
    eq(map['not-two-fields'], undefined, 'a one-field line is ignored');
    eq(map['three fields here'], undefined, 'a three-field line is ignored');
    // An IPv6 literal must not be shredded at its own colons — the same rule
    // the blacklist parser follows, and the same reason.
    eq(map['[2001:db8::1]:23'], 'topaz1200', 'an IPv6 literal keeps its brackets and port');
    eq(map['bad.example.org:99999'], undefined, 'a port outside 1-65535 is not a pair');
    eq(altfonts.parse(''), {}, 'an empty file is an empty map');
    eq(altfonts.parse('# only comments\n\n'), {}, 'comments and blanks alone are an empty map');
  }

  // ── 2. The lookup, on both sides ─────────────────────────────────────────
  //
  // The page's altFontFor() is driven against a map the SERVER's parser
  // produced, so the two are checked against each other rather than against a
  // hand-written fixture that could agree with neither.
  {
    const map = altfonts.parse([
      'specific.example.org:2003  topaz1200',
      'whole.example.org          topaz1200',
      'typo.example.org           no-such-font',
    ].join('\n'));

    const altFontFor = new Function('altFontMap', 'FONTS', [
      extract('altFontFor'), 'return altFontFor;',
    ].join('\n'))(map, FONTS);

    const id = (f) => (f ? f.id : null);
    eq(id(altFontFor('specific.example.org', 2003)), 'topaz1200', 'host:port matches');
    eq(id(altFontFor('SPECIFIC.EXAMPLE.ORG', 2003)), 'topaz1200', '...case-insensitively');
    eq(id(altFontFor('specific.example.org', 23)), null, '...and only on that port');
    eq(id(altFontFor('whole.example.org', 2003)), 'topaz1200', 'a bare host matches any port');
    eq(id(altFontFor('whole.example.org', 23)), 'topaz1200', '...including the default');
    eq(id(altFontFor('other.example.org', 23)), null, 'an unlisted board gets nothing');
    eq(id(altFontFor('', 23)), null, 'an empty host gets nothing');
    // The server has no view of the font registry and deliberately does not
    // validate ids, so a typo lands here — and must leave the user's own font
    // alone rather than resolving to the default, which is what fontById()
    // would do and why this does not use it.
    eq(id(altFontFor('typo.example.org', 23)), null, 'an id no font answers to is ignored');

    // The default port the two sides assume has to be the SAME 23, or a bare
    // `host:23` line would never match a dial that omitted the port.
    const withPort = altfonts.parse('p.example.org:23  topaz1200');
    const lookup23 = new Function('altFontMap', 'FONTS', [
      extract('altFontFor'), 'return altFontFor;',
    ].join('\n'))(withPort, FONTS);
    eq(id(lookup23('p.example.org', undefined)), 'topaz1200',
       'both sides default a missing port to 23');
    eq(altfonts.fontFor === undefined, false, 'lib/altfonts exposes fontFor for server-side use');
  }

  // ── 3. The font an override can actually name ────────────────────────────
  //
  // An override names ONE id and that id carries the typeface, the encoding and
  // the column count together. This is what makes the config file a single
  // word per board, so it is asserted rather than assumed.
  {
    const topaz = FONTS.find((f) => f.id === 'topaz1200');
    ok(!!topaz, 'the registry has topaz1200');
    if (topaz) {
      eq(topaz.charset === CS.LATIN1, true, 'topaz1200 carries the Latin-1 charset');
      eq(topaz.cols === undefined ? 80 : topaz.cols, 80, 'topaz1200 implies 80 columns');
      eq(topaz.hidden, true,
         'topaz1200 is hidden — an override is the only route to it, never the Aa cycle');
    }
    // The shipped config must not name a font that does not exist. It is the
    // one place a typo is silent: the override simply never fires.
    const shipped = altfonts.parse(
      fs.readFileSync(path.join(__dirname, '..', '..', 'config', 'altfonts.txt'), 'utf8'));
    const ids = new Set(FONTS.map((f) => f.id));
    const unknown = Object.entries(shipped).filter(([, v]) => !ids.has(v));
    eq(unknown, [], 'every font named in config/altfonts.txt is a real font id');
  }

  console.log(fail ? `\nFAILED — ${pass} passed, ${fail} failed`
                   : `\nOK — ${pass} passed, 0 failed`);
  process.exit(fail ? 1 : 0);
})();
