#!/usr/bin/env node
// Unit tests for SynthLink's typed AT command line (public/main.js): the
// no-op/`+MS`/`ATZ`/`ATDT` grammar and the modulation table it resolves against.
//
// Same extraction trick as tools/tests/sharelinktest.js — main.js runs top-to-bottom
// against a live DOM and an AudioContext, so it can't be required. The pure
// pieces (MS_COMMANDS and parseATCommand with its closed-over helpers) are
// pulled out of the source by name and driven here, so the test tracks the real
// implementation rather than a copy that drifts. Rename one and the extraction
// throws instead of quietly testing nothing.
//
// The negative cases are the point: the brief for this feature is that only the
// exact strings (and comma-boundary prefixes of them) are honoured and that
// EVERYTHING else answers ERROR. A parser that "helpfully" accepted
// AT+MS=V32,0,4800 would pass a positive-only test.
//
//   node tools/tests/attest.js

const fs = require('fs');
const path = require('path');

const MAIN = path.join(__dirname, '..', '..', 'public', 'main.js');
const SRC = fs.readFileSync(MAIN, 'utf8');

// Handles a single-line `const NAME = ...;`, a multi-line `const NAME = {...};`
// or `[...]`, and `function NAME(...) {...}`.
function extract(name) {
  const one = SRC.match(new RegExp(`^const ${name} = .*?;$`, 'm'));
  if (one) return one[0];
  const cd = SRC.indexOf(`const ${name} = `);
  if (cd >= 0) {
    const open = SRC.slice(cd).search(/[{[]/) + cd;
    const oc = SRC[open], cc = oc === '{' ? '}' : ']';
    let depth = 0;
    for (let j = open; j < SRC.length; j++) {
      if (SRC[j] === oc) depth++;
      else if (SRC[j] === cc && --depth === 0) return SRC.slice(cd, j + 1) + ';';
    }
    throw new Error(`attest: unbalanced ${oc} reading ${name}`);
  }
  const start = SRC.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`attest: ${name} not found in public/main.js`);
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
  throw new Error(`attest: unbalanced braces reading ${name}`);
}

// AT_NOOP_TOKENS and speedFromMSFields are pulled in because parseATCommand
// closes over them, not to be asserted against.
const NAMES = ['MS_COMMANDS', 'AT_NOOP_TOKENS', 'speedFromMSFields', 'parseATCommand'];
const { MS_COMMANDS, parseATCommand } =
  new Function([...NAMES.map(extract), `return { ${NAMES.join(', ')} };`].join('\n'))();

let pass = 0, fail = 0;
function eq(actual, expected, what) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  fail++;
  console.log(`  FAIL ${what}\n       expected ${e}\n       actual   ${a}`);
}
const P = (line) => parseATCommand(line, MS_COMMANDS);
const err   = (line) => eq(P(line).k, 'error', `ERROR: ${JSON.stringify(line)}`);
const dial  = (line, h, p) => eq(P(line), { k: 'dial', host: h, port: p },
                                 `${line} → ${h}:${p}`);

console.log('attest — typed AT commands\n');

// ── No-ops and the variants we deliberately do NOT emulate ──────────────────
eq(P('').k, 'none', 'a blank line is not a command and answers nothing');
eq(P('   ').k, 'none', 'whitespace only answers nothing');

// Variants we deliberately do NOT emulate.
err('ATM0'); err('ATQ1'); err('ATE0'); err('ATX3'); err('AT&C0');
err('ATM');  err('ATS0=1'); err('ATH'); err('ATA'); err('ATI'); err('AT&F');
err('M1');            // no AT prefix
err('ATM1 ATQ0');     // one AT per line

// ── +MS: only exact strings and comma-boundary prefixes are honoured ────────
// Not a prefix of anything: automode on, a rate we don't offer, a rate belonging
// to another family, a modulation we don't implement.
err('AT+MS=V32,1');
err('AT+MS=V32,0,4800');
err('AT+MS=V32,0,9600,14400');
err('AT+MS=V34,0,33600,28800');
err('AT+MS=V34,0,14400,14400');
err('AT+MS=V22BIS');            // the menu's word, not the +MS token
err('AT+MS=V92');
err('AT+MS=');
err('AT+MS=V34,');              // trailing comma is malformed, not shorter
err('AT+MS=V34,,33600');
err('AT+MS=,0');
err('AT+MS');                   // no '=' at all
err('AT+MS=DIRECT');
err('AT+MS=TELNET');

// ── ATZ ─────────────────────────────────────────────────────────────────────
eq(P('ATZ').k, 'direct', 'ATZ selects modem bypass');
eq(P('atz').k, 'direct', 'atz — casing is free');
eq(P(' ATZ ').k, 'direct', 'ATZ — surrounding whitespace');
err('ATZ0');                    // a real reset variant, not one we emulate
err('ATZZ');
err('ATM1Z');

// ── ATDT ────────────────────────────────────────────────────────────────────
dial('ATDT host.com', 'host.com', '23');            // port defaults to 23
dial('ATDT host.com:23', 'host.com', '23');
dial('ATDT bbs.birdenuf.com:2003', 'bbs.birdenuf.com', '2003');
dial('ATDT 1.2.3.4', '1.2.3.4', '23');
dial('ATDT 1.2.3.4:2003', '1.2.3.4', '2003');
dial('ATDT1.2.3.4:2003', '1.2.3.4', '2003');        // no space, as a real modem
dial('atdt host.com', 'host.com', '23');
dial('ATDT  host.com  ', 'host.com', '23');
dial('ATDT host.com;', 'host.com', '23');           // ';' = return to command mode
dial('ATDT a-b_c.example.org:65535', 'a-b_c.example.org', '65535');

// A crafted line must not be able to put junk in #host — the same guard the
// shared-link parser applies, for the same reason.
err('ATDT');
err('ATDT ');
err('ATDT http://host.com');
err('ATDT host.com/path');
err('ATDT user@host.com');
err('ATDT host com');
err('ATDT host.com:');
err('ATDT host.com:0');
err('ATDT host.com:65536');
err('ATDT host.com:23:23');
err('ATDT host.com:2a');
err('ATDT <script>');
err('ATDT ' + 'a'.repeat(254));
eq(P('ATDT ' + 'a'.repeat(253)).k, 'dial', 'a 253-character host is still legal');
err('ATDP host.com');            // pulse dialling is not emulated
err('ATD host.com');

// ── ATDT RANDOM ─────────────────────────────────────────────────────────────
// The typed form of the directory's Random entry. The parser is pure and owns
// no directory, so all it may report is that a draw was asked for — the caller
// makes it. Asserted as the WHOLE result, so a `host:'random'` leaking through
// alongside the flag fails here rather than silently dialling a board that does
// not exist.
const rnd = (line) => eq(P(line), { k: 'dial', random: true }, `${line} asks for a draw`);
rnd('ATDT RANDOM');
rnd('atdt random');
rnd('ATDT Random');
rnd('ATDTRANDOM');                // no space, as a real modem
rnd('ATDT  random  ');
rnd('ATDT random;');              // ';' is swallowed before the word is read
// Only the bare word is the sentinel, so a board whose name merely contains it
// stays reachable, and a port makes the intent explicit either way.
dial('ATDT random.example.org', 'random.example.org', '23');
dial('ATDT random:2003', 'random', '2003');
dial('ATDT notrandom', 'notrandom', '23');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
