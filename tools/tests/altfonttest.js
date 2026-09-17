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

// applyFontAcrossBreakpoint is a const arrow, not a function declaration.
function extractArrow(name) {
  const at = SRC.indexOf(`const ${name} = (`);
  if (at < 0) throw new Error(`altfonttest: const ${name} not found in public/main.js`);
  let depth = 0;
  for (let j = SRC.indexOf('{', SRC.indexOf(')', at)); j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}' && --depth === 0) return SRC.slice(at, j + 1) + ';';
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
  const IDX = await import('../../public/fonts/index.js');

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

  // ── Crossing the mobile breakpoint must not drop a board font ────────────
  //
  // A rotation, or narrowing a desktop window past 640px, re-picks the font for
  // the new screen. That re-pick is about the USER's font; a board font is not a
  // preference and must survive it. Dropping one mid-call takes the board's
  // ENCODING and column count with the typeface — and for a PETSCII board the
  // EMULATION too, which swaps the parser out from under a live stream and
  // leaves every cell on screen holding bytes the new atlas cannot draw. The
  // whole screen turns to garbage, which is how this was found.
  //
  // Driven through the REAL applyFontAcrossBreakpoint, extracted by name.
  console.log('\ncrossing the mobile breakpoint');
  {
    const mk = (over, pending = false) => {
      const calls = { applyFont: [], updateFontUI: 0 };
      const env = {
        activeFont: { id: 'astpx8x19' },
        altFontActive: over || null,
        altFontApplied: over ? !pending : false,
        altFontPrev: over ? { id: 'astpx8x19' } : null,
        applyFont: (f) => { calls.applyFont.push(f.id); env.activeFont = f; },
        updateFontUI: () => { calls.updateFontUI++; },
      };
      const fn = new Function('env', [
        'let { activeFont, altFontActive, altFontApplied, altFontPrev, applyFont,'
        + ' updateFontUI } = env;',
        extractArrow('applyFontAcrossBreakpoint'),
        'return (want) => { applyFontAcrossBreakpoint(want);'
        + ' env.altFontPrev = altFontPrev; env.activeFont = activeFont; };',
      ].join('\n'))(env);
      return { env, calls, run: fn };
    };

    // No override in force: the breakpoint behaves exactly as it always did.
    {
      const { calls, run } = mk(null);
      run({ id: 'flexi135' });
      eq(calls.applyFont, ['flexi135'], 'with no board font, the new font is applied');
      eq(calls.updateFontUI, 1, '...and the button is updated');
    }
    // Same font on both sides of the breakpoint: nothing happens, as before.
    {
      const { calls, run } = mk(null);
      run({ id: 'astpx8x19' });
      eq(calls.applyFont, [], 'the same font on both sides applies nothing');
      eq(calls.updateFontUI, 0, '...and does not touch the button');
    }
    // A board font IS in force: the screen must not change.
    {
      const { env, calls, run } = mk({ id: 'petscii40' });
      run({ id: 'flexi135' });
      eq(calls.applyFont, [], 'a board font is NOT replaced when the breakpoint is crossed');
      eq(calls.updateFontUI, 0, '...and the button is left alone with it');
      eq(env.altFontPrev.id, 'flexi135',
         '...but the font to restore at hang-up IS re-pointed at this screen\'s variant');
    }
    // The same holds for Topaz — this is the altfonts feature's rule, not
    // PETSCII's. The bug predates PETSCII and was simply invisible there,
    // because an Amiga board losing Topaz only changes the table.
    {
      const { env, calls, run } = mk({ id: 'topaz1200' });
      run({ id: 'flexi160' });
      eq(calls.applyFont, [], 'a Topaz board keeps its font across the breakpoint too');
      eq(env.altFontPrev.id, 'flexi160', '...with the same deferred restore');
    }
    // Still dialling: the board font is not on screen yet, so the user's font
    // follows the screen as it would on any other call.
    {
      const { env, calls, run } = mk({ id: 'petscii40' }, true);
      run({ id: 'flexi135' });
      eq(calls.applyFont, ['flexi135'], 'while dialling, the user\'s font still follows the breakpoint');
      eq(env.altFontPrev.id, 'flexi135', '...and is what comes back at hang-up');
    }
  }

  // ── The call's font: default at dial, applied at carrier, picker after ───
  //
  // The REAL beginAltFont / applyAltFont / pickAltFont / endAltFont /
  // windowSize / pickerFonts, extracted by name and run against one shared
  // state, so the sequence a call goes through is what is asserted.
  console.log('\nthe call\'s font');
  {
    const byId = (id) => FONTS.find((f) => f.id === id);
    const mk = (map, start) => {
      const env = { applied: [], toasts: [], ui: 0 };
      const body = [
        'let activeFont = env.start, COLS = env.fontCols(env.start), ROWS = 25;',
        'let altFontActive = null, altFontPick = null, altFontApplied = false, altFontPrev = null;',
        'const altFontMap = env.map, FONTS = env.FONTS, fontCols = env.fontCols, fontLabel = env.fontLabel;',
        'const cycle = () => env.cycle;',
        'const applyFont = (f) => { env.applied.push(f.id); activeFont = f; COLS = fontCols(f); };',
        'const updateFontUI = () => { env.ui++; };',
        'const showToast = (m) => { env.toasts.push(m); };',
        ...['altFontFor', 'beginAltFont', 'applyAltFont', 'pickAltFont', 'endAltFont',
            'windowSize', 'pickerFonts'].map(extract),
        'return { beginAltFont, applyAltFont, pickAltFont, endAltFont, windowSize, pickerFonts,',
        '  state: () => ({ active: altFontActive && altFontActive.id, pick: altFontPick && altFontPick.id,',
        '                  applied: altFontApplied, font: activeFont.id }) };',
      ].join('\n');
      Object.assign(env, { start, map, FONTS, fontCols: IDX.fontCols, fontLabel: IDX.fontLabel,
                           cycle: IDX.cycleFonts(false) });
      return { env, api: new Function('env', body)(env) };
    };
    const map = altfonts.parse([
      'c64.example.org   petscii40',
      'pc.example.org    astpx8x19',
    ].join('\n'));
    const pixel = byId('astpx8x19');

    // Dial: nothing on screen changes, but the board is told the board's width.
    {
      const { env, api } = mk(map, pixel);
      api.beginAltFont('c64.example.org', 23);
      eq(env.applied, [], 'at dial, the board font is NOT applied');
      eq(api.state().active, 'petscii40', '...but the call is marked as a board-font call');
      eq(api.windowSize(), { cols: 40, rows: 25 },
         '...and the dial message carries the board font\'s 40 columns');
      api.applyAltFont();
      eq(env.applied, ['petscii40'], 'at carrier, the board font goes on');
      eq(api.windowSize().cols, 40, '...and the width is now the screen\'s own');
      api.applyAltFont();
      eq(env.applied, ['petscii40'], 'a second carrier event applies nothing more');
      api.pickAltFont(byId('petscii80'));
      eq(api.state(), { active: 'petscii40', pick: 'petscii80', applied: true, font: 'petscii80' },
         'a pick mid-call applies at once and keeps the default recorded');
      api.endAltFont();
      eq(env.applied, ['petscii40', 'petscii80', 'astpx8x19'], 'hang-up puts the user\'s font back');
      eq(api.state().active, null, '...and ends the board-font call');
    }
    // A pick while still dialling waits for carrier, and sets the dial width.
    {
      const { env, api } = mk(map, pixel);
      api.beginAltFont('c64.example.org', 23);
      api.pickAltFont(byId('petscii80'));
      eq(env.applied, [], 'a pick while dialling applies nothing yet');
      eq(api.windowSize().cols, 80, '...but the width follows the pick');
      api.applyAltFont();
      eq(env.applied, ['petscii80'], '...and the pick is what goes on at carrier');
    }
    // A failed dial restores nothing, because nothing was applied.
    {
      const { env, api } = mk(map, pixel);
      api.beginAltFont('c64.example.org', 23);
      api.endAltFont();
      eq(env.applied, [], 'a dial that never connects applies and restores nothing');
    }
    // THE LISTED-BOARD RULE: a board naming the font already on screen is still
    // a board-font call, which is what gets it the picker.
    {
      const { env, api } = mk(map, pixel);
      api.beginAltFont('pc.example.org', 23);
      eq(api.state().active, 'astpx8x19',
         'a board naming the font already on screen is still a board-font call');
      api.applyAltFont();
      eq(env.applied, [], '...and applying it changes nothing');
      api.pickAltFont(byId('petscii40'));
      api.endAltFont();
      eq(env.applied, ['petscii40', 'astpx8x19'], '...while a pick from it is undone at hang-up');
    }
    // Unlisted: nothing at all.
    {
      const { env, api } = mk(map, pixel);
      api.beginAltFont('other.example.org', 23);
      eq([api.state().active, env.ui, api.windowSize().cols], [null, 0, 80],
         'an unlisted board is not a board-font call');
    }
    // The list the picker offers.
    {
      const { api } = mk(map, pixel);
      api.beginAltFont('c64.example.org', 23);
      eq(api.pickerFonts().map((f) => f.id),
         ['astpx8x19', 'flexi160', 'vga9x14px', 'topaz1200', 'petscii40', 'petscii80',
          'atascii40'],
         'the picker offers the Aa slots, then every board-specific font');
    }
    {
      const { api } = mk(altfonts.parse('x.example.org flexi135'), pixel);
      api.beginAltFont('x.example.org', 23);
      eq(api.pickerFonts().map((f) => f.id).pop(), 'flexi135',
         'a default outside that list is added to it');
    }
  }

  console.log(fail ? `\nFAILED — ${pass} passed, ${fail} failed`
                   : `\nOK — ${pass} passed, 0 failed`);
  process.exit(fail ? 1 : 0);
})();
