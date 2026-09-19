#!/usr/bin/env node
// server.js's name resolution: the IPv4 preference and the deadline.
//
//     node tools/tests/dnstest.js
//
// Why this exists and why in this shape. `lookupWithDeadline()` is the ONE
// place either half of the server turns a name into an address — the dial
// (`openSocket`) and the `resolve` message the browser shows both come through
// it — so what it picks is what gets dialled, quoted to the caller, and handed
// to netguard's address policy. It is also the kind of thing a round trip
// cannot check: a server that always took the AAAA would connect perfectly to
// every board that has one listening, and only fail on the ones that do not.
//
// The function is extracted from server.js BY NAME and given a stub `dns` and
// a stub `site`, the same technique txflowtest uses for the flow-control pair:
// server.js cannot be required for one function, and a copy of the logic here
// would be a test of the copy. Rename it and this throws rather than testing
// something that no longer runs.
//
// The ORDER the stub returns is always AAAA-first, because that is the case
// that matters: Node has passed the resolver's order through unchanged since
// v17 (`verbatim` defaults true), so a bare dns.lookup() on a dual-stacked
// board usually hands back the v6. Boards are old machines on home connections
// and the v4 is the one that answers.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function eq(a, e, what) {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { pass++; return; }
  fail++;
  console.log(`  FAIL ${what}\n       expected ${E}\n       actual   ${A}`);
}
function ok(cond, what) {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL ${what}`);
}

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
function grab(sig, what) {
  const start = SRC.indexOf(sig);
  if (start < 0) throw new Error(`dnstest: ${what} not found in server.js`);
  let depth = 0;
  for (let j = SRC.indexOf('{', start); j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}' && --depth === 0) return SRC.slice(start, j + 1);
  }
  throw new Error(`dnstest: unbalanced braces reading ${what}`);
}
const build = new Function('dns', 'site', [
  grab('function lookupWithDeadline(', 'lookupWithDeadline'),
  'return lookupWithDeadline;',
].join('\n'));

// A resolver that answers with whatever the case under test hands it, and
// records the options it was called with — `all` is not a detail here, it is
// the whole mechanism by which a preference can exist at all.
function resolver(answer) {
  const seen = { calls: 0, opts: null };
  const dns = {
    lookup(host, opts, cb) {
      seen.calls++;
      seen.opts = opts;
      if (typeof answer === 'function') return answer(cb);
      setImmediate(() => cb(null, answer));
    },
  };
  return { dns, seen };
}
const site = (ms) => ({ config: () => ({ resolveTimeoutMs: ms }) });

// Every case runs the callback and reports how many times it ran — a deadline
// and an answer racing is exactly the bug this shape can have.
function run(answer, ms, done) {
  const { dns, seen } = resolver(answer);
  const lookup = build(dns, site(ms));
  const calls = [];
  lookup('board.example', (err, addr, family) => calls.push({
    code: err ? (err.code || 'ERR') : null, addr: addr || null, family: family || null }));
  setTimeout(() => done(calls, seen), 60);
}

console.log('dnstest — server.js name resolution\n');

console.log('1. the address family it prefers');
run([{ address: '2001:db8::1', family: 6 }, { address: '198.51.100.7', family: 4 }], 0, (c, seen) => {
  eq(seen.opts, { all: true }, 'the resolver is asked for EVERY address, not just the first');
  eq(c.length, 1, 'the callback runs exactly once');
  eq(c[0], { code: null, addr: '198.51.100.7', family: 4 },
     'a dual-stacked board is dialled on its IPv4, though the AAAA came first');

  run([{ address: '2001:db8::1', family: 6 }, { address: '2001:db8::2', family: 6 }], 0, (c2) => {
    eq(c2[0], { code: null, addr: '2001:db8::1', family: 6 },
       'a board with no A record is dialled on IPv6 rather than refused');

    run([{ address: '203.0.113.9', family: 4 }], 0, (c3) => {
      eq(c3[0], { code: null, addr: '203.0.113.9', family: 4 },
         'and an IPv4-only board is unchanged');

      // Several A records: the first, so the resolver's own ordering (and any
      // round-robin it is doing) still decides between equals.
      run([{ address: '198.51.100.1', family: 4 }, { address: '198.51.100.2', family: 4 }], 0, (c4) => {
        eq(c4[0].addr, '198.51.100.1', 'between two A records the resolver still chooses');
        console.log('\n2. the failures, which must all reach the caller once');
        failures();
      });
    });
  });
});

function failures() {
  // An empty list is not an error from getaddrinfo's point of view and would
  // otherwise reach net.createConnection() as `undefined`, which connects to
  // localhost — the one outcome the address policy exists to prevent.
  run([], 0, (c) => {
    eq(c.length, 1, 'an empty answer calls back once');
    eq(c[0].code, 'ENOTFOUND', '...as a lookup failure, never as an undefined address');

    run((cb) => { const e = new Error('nope'); e.code = 'EAI_AGAIN'; setImmediate(() => cb(e)); }, 0, (c2) => {
      eq(c2[0].code, 'EAI_AGAIN', 'a resolver error is passed through as itself');

      // The deadline, which is the other half of this function and must not
      // have been broken by taking the answer apart.
      run((cb) => { setTimeout(() => cb(null, [{ address: '198.51.100.7', family: 4 }]), 400); }, 20, (c3) => {
        eq(c3.length, 1, 'a resolver that is too slow calls back once');
        eq(c3[0].code, 'ETIMEDOUT', '...and it is the deadline that answers');

        // ...and the late answer must not arrive on top of it.
        setTimeout(() => {
          ok(c3.length === 1, 'the answer that arrives after the deadline is dropped');
          console.log(`\n${fail ? 'FAILED' : 'OK'} — ${pass} passed, ${fail} failed`);
          process.exit(fail ? 1 : 0);
        }, 500);
      });
    });
  });
}
