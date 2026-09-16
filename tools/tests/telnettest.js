'use strict';
/**
 * tools/tests/telnettest.js — unit tests for lib/telnet.js
 *
 * In-process, no sockets, no WS listener (see CLAUDE.md: a persistent `ws`
 * server in the process tree hangs the sandbox). Runs in well under a second.
 *
 *   node tools/tests/telnettest.js
 */

const {
  TelnetFilter, escapeIAC,
  IAC, SE, SB, WILL, WONT, DO, DONT,
  OPT_SGA, OPT_TTYPE, OPT_NAWS, TTYPE_IS, TTYPE_SEND,
} = require('../../lib/telnet');

let pass = 0, fail = 0;

function hex(a) { return Array.from(a).map((b) => b.toString(16).padStart(2, '0')).join(' '); }
function eq(actual, expected, what) {
  const a = Array.from(actual), e = Array.from(expected);
  if (a.length === e.length && a.every((v, i) => v === e[i])) { pass++; return; }
  fail++;
  console.log(`  FAIL ${what}\n    expected: ${hex(e)}\n    actual:   ${hex(a)}`);
}
function section(name) { console.log(`\n── ${name}`); }

/** Build a filter that accumulates everything it emits. */
function mk(opts) {
  const f = new TelnetFilter(opts);
  const data = [], sent = [];
  f.onData = (b) => data.push(...b);
  f.onSend = (b) => sent.push(...b);
  return { f, data, sent };
}

const str = (s) => Array.from(s, (c) => c.charCodeAt(0));

// ─── 1. SGA ─────────────────────────────────────────────────────────────────
section('SGA');
{
  const { f, sent } = mk();
  f.process([IAC, DO, OPT_SGA]);
  eq(sent, [IAC, WILL, OPT_SGA], 'DO SGA → WILL SGA');
}
{
  const { f, sent } = mk();
  f.process([IAC, WILL, OPT_SGA]);
  eq(sent, [IAC, DO, OPT_SGA], 'WILL SGA → DO SGA');
}
{
  // negotiate() sets both flags, so the peer's confirmations must NOT loop.
  const { f, sent } = mk();
  f.negotiate();
  eq(sent, [IAC, WILL, OPT_SGA, IAC, DO, OPT_SGA], 'negotiate() sends WILL+DO SGA');
  sent.length = 0;
  f.process([IAC, DO, OPT_SGA, IAC, WILL, OPT_SGA]);
  eq(sent, [], 'confirmations after negotiate() are silent (no ping-pong)');
}
{
  const { f, sent } = mk();
  f.negotiate(); sent.length = 0;
  f.process([IAC, DONT, OPT_SGA, IAC, WONT, OPT_SGA]);
  eq(sent, [IAC, WONT, OPT_SGA, IAC, DONT, OPT_SGA], 'DONT/WONT SGA are honoured');
}

// ─── 2. TTYPE ───────────────────────────────────────────────────────────────
section('TTYPE');
{
  const { f, sent } = mk();
  f.process([IAC, DO, OPT_TTYPE]);
  eq(sent, [IAC, WILL, OPT_TTYPE], 'DO TTYPE → WILL TTYPE');

  sent.length = 0;
  f.process([IAC, SB, OPT_TTYPE, TTYPE_SEND, IAC, SE]);
  eq(sent, [IAC, SB, OPT_TTYPE, TTYPE_IS, ...str('ANSI'), IAC, SE], 'first SEND → ANSI');

  sent.length = 0;
  f.process([IAC, SB, OPT_TTYPE, TTYPE_SEND, IAC, SE]);
  eq(sent, [IAC, SB, OPT_TTYPE, TTYPE_IS, ...str('ANSI-BBS'), IAC, SE], 'second SEND → ANSI-BBS');

  sent.length = 0;
  f.process([IAC, SB, OPT_TTYPE, TTYPE_SEND, IAC, SE]);
  eq(sent, [IAC, SB, OPT_TTYPE, TTYPE_IS, ...str('UNKNOWN'), IAC, SE], 'third SEND → UNKNOWN');

  sent.length = 0;
  f.process([IAC, SB, OPT_TTYPE, TTYPE_SEND, IAC, SE]);
  eq(sent, [IAC, SB, OPT_TTYPE, TTYPE_IS, ...str('UNKNOWN'), IAC, SE],
     'list terminates by repeating the last entry');
}
{
  // A SEND probe before we ever agreed to WILL TTYPE gets no reply.
  const { f, sent } = mk();
  f.process([IAC, SB, OPT_TTYPE, TTYPE_SEND, IAC, SE]);
  eq(sent, [], 'unsolicited TTYPE SEND is ignored');
}

// ─── 3. NAWS ────────────────────────────────────────────────────────────────
section('NAWS');
{
  const { f, sent } = mk();
  f.process([IAC, DO, OPT_NAWS]);
  eq(sent, [IAC, WILL, OPT_NAWS, IAC, SB, OPT_NAWS, 0, 80, 0, 25, IAC, SE],
     'DO NAWS → WILL NAWS + 80×25 subnegotiation');

  sent.length = 0;
  f.process([IAC, DO, OPT_NAWS]);
  eq(sent, [], 'size is sent once, never repeated (no resize events exist)');
}
{
  // The escaping rule: a dimension byte of 0xFF must double. 80×25 never trips
  // it, but a future variable size could.
  const { f, sent } = mk({ cols: 255, rows: 25 });
  f.process([IAC, DO, OPT_NAWS]);
  eq(sent, [IAC, WILL, OPT_NAWS, IAC, SB, OPT_NAWS, 0, 0xFF, 0xFF, 0, 25, IAC, SE],
     '0xFF in a NAWS payload is escaped');
}
{
  // 40-column mode. The width now arrives with the dial message, so it reaches
  // the filter through setWindow() rather than the constructor — and it must be
  // what actually goes on the wire, because a BBS that honours NAWS is the only
  // thing that makes 40 columns useful.
  const { f, sent } = mk();
  eq(f.setWindow(40, 25), true, 'setWindow accepts 40x25 before negotiation');
  f.process([IAC, DO, OPT_NAWS]);
  eq(sent, [IAC, WILL, OPT_NAWS, IAC, SB, OPT_NAWS, 0, 40, 0, 25, IAC, SE],
     'DO NAWS → WILL NAWS + 40×25 subnegotiation');
}
{
  // Too late: once the size has gone out there is no way to revise it, which is
  // the deliberate consequence of only audio crossing the socket during a call.
  const { f, sent } = mk();
  f.process([IAC, DO, OPT_NAWS]);
  sent.length = 0;
  eq(f.setWindow(40, 25), false, 'setWindow is refused after NAWS has been sent');
  eq(f.cols, 80, 'and leaves the announced width alone');
  eq(sent, [], 'a refused resize puts nothing on the wire');
}
{
  // A malformed dial message must not reach the wire. Zero width in particular:
  // some BBSes read it as "unknown", others hang up.
  const { f } = mk();
  for (const [c, r] of [[0, 25], [40, 0], [-1, 25], [70000, 25], ['x', 25], [NaN, 25]]) {
    eq(f.setWindow(c, r), false, `setWindow rejects ${JSON.stringify([c, r])}`);
  }
  eq([f.cols, f.rows], [80, 25], 'rejected sizes leave the default intact');
}

// ─── 4. Data transparency ───────────────────────────────────────────────────
section('data transparency');
{
  const { f, data, sent } = mk();
  f.process([...str('HI'), IAC, IAC, ...str('OK')]);
  eq(data, [...str('HI'), 0xFF, ...str('OK')], 'IAC IAC → one literal 0xFF in the payload');
  eq(sent, [], 'no reply for escaped data');
}
{
  const { f, data, sent } = mk();
  f.process([...str('A'), IAC, DO, 0x2A, ...str('B')]);   // option 42, unknown
  eq(data, str('AB'), 'negotiation is stripped from the payload');
  eq(sent, [IAC, WONT, 0x2A], 'unknown DO → WONT');
}
{
  const { f, sent } = mk();
  f.process([IAC, WILL, 0x2A]);
  eq(sent, [IAC, DONT, 0x2A], 'unknown WILL → DONT');
}
{
  const { f, data } = mk();
  f.process([...str('X'), IAC, SB, 0x2A, 1, 2, 3, IAC, SE, ...str('Y')]);
  eq(data, str('XY'), 'unknown subnegotiation is swallowed whole');
}
{
  const { f, data } = mk();
  f.process([...str('A'), IAC, 0xF1, ...str('B')]);   // NOP, a bare 2-byte command
  eq(data, str('AB'), 'bare 2-byte commands are dropped');
}

// ─── 5. Chunk boundaries ────────────────────────────────────────────────────
section('chunk boundaries');
{
  // A subnegotiation split across two chunks must still be answered correctly.
  const { f, sent } = mk();
  f.process([IAC, DO, OPT_TTYPE]); sent.length = 0;
  f.process([IAC, SB, OPT_TTYPE]);
  eq(sent, [], 'partial subnegotiation produces nothing yet');
  f.process([TTYPE_SEND, IAC, SE]);
  eq(sent, [IAC, SB, OPT_TTYPE, TTYPE_IS, ...str('ANSI'), IAC, SE],
     'split subnegotiation completes across chunks');
}
{
  // Fuzz: the same stream, split at every possible pair of boundaries, must
  // always yield identical data and replies.
  const stream = [
    ...str('banner '), IAC, DO, OPT_TTYPE, IAC, SB, OPT_TTYPE, TTYPE_SEND, IAC, SE,
    IAC, DO, OPT_NAWS, ...str(' more'), IAC, IAC, IAC, WILL, OPT_SGA,
    IAC, SB, 0x2A, 0xFF, 0xFF, 0x01, IAC, SE, ...str(' tail'), IAC, DO, 0x2A,
  ];
  const whole = mk();
  whole.f.process(stream);
  const refData = whole.data.slice(), refSent = whole.sent.slice();

  let bad = 0;
  for (let trial = 0; trial < 500; trial++) {
    const { f, data, sent } = mk();
    let i = 0;
    while (i < stream.length) {
      const n = 1 + Math.floor(Math.random() * 7);
      f.process(stream.slice(i, i + n));
      i += n;
    }
    const same = (a, b) => a.length === b.length && a.every((v, k) => v === b[k]);
    if (!same(data, refData) || !same(sent, refSent)) bad++;
  }
  eq([bad], [0], 'fuzz: 500 random chunk splittings all match the whole-stream result');
  // Sanity-check the reference itself, so the fuzz isn't just self-consistently wrong.
  eq(refData, [...str('banner '), ...str(' more'), 0xFF, ...str(' tail')],
     'fuzz reference payload is correct');
}

// ─── 7. escapeIAC — outbound payload transparency ───────────────────────────
// The mirror of section 4. Section 4 asserts that a 0xFF the PEER doubled
// arrives here as one byte; this asserts that a 0xFF WE send leaves as two, so
// the peer's own filter does the same thing in reverse. Without it a binary
// upload — every X/Y/ZMODEM block is full of 0xFF — reads to the BBS as telnet
// commands.
section('escapeIAC');
{
  eq(escapeIAC(Uint8Array.from(str('hello'))), str('hello'), 'no IAC: unchanged');

  // Identity, not just equality: the common path must not copy. Every
  // keystroke and every byte of ANSI a board sends goes through here.
  const clean = Uint8Array.from(str('plain text'));
  if (escapeIAC(clean) === clean) pass++;
  else { fail++; console.log('  FAIL no IAC: should return the SAME object, not a copy'); }

  eq(escapeIAC(Uint8Array.of(IAC)), [IAC, IAC], 'lone IAC doubles');
  eq(escapeIAC(Uint8Array.of(0x41, IAC, 0x42)), [0x41, IAC, IAC, 0x42], 'IAC mid-stream doubles');
  eq(escapeIAC(Uint8Array.of(IAC, IAC)), [IAC, IAC, IAC, IAC], 'adjacent IACs each double');
  eq(escapeIAC(Uint8Array.of(IAC, 0x41, IAC)), [IAC, IAC, 0x41, IAC, IAC], 'leading and trailing');
  eq(escapeIAC(new Uint8Array(0)), [], 'empty input');

  // An all-0xFF block is the shape an XMODEM block of a compressed file takes,
  // and it is the worst case for the length arithmetic.
  const allFF = new Uint8Array(128).fill(IAC);
  eq([escapeIAC(allFF).length], [256], 'all-IAC block doubles in length');

  // Buffer in, Buffer out — server.js hands the result straight to a socket.
  const b = escapeIAC(Buffer.from([0x41, IAC]));
  if (Buffer.isBuffer(b)) pass++;
  else { fail++; console.log('  FAIL Buffer input should yield a Buffer'); }
  eq(b, [0x41, IAC, IAC], 'Buffer content escaped');
  const u = escapeIAC(Uint8Array.of(IAC));
  if (u instanceof Uint8Array && !Buffer.isBuffer(u)) pass++;
  else { fail++; console.log('  FAIL Uint8Array input should yield a Uint8Array'); }
}

// ─── 7b. Round trip through a real peer, with a negative control ────────────
// The assertion that actually matters: what escapeIAC produces must survive a
// telnet parser at the far end byte for byte. A BBS runs one of these, so this
// stands in for it.
//
// The negative control is the point of the section. A round trip cannot show
// that the escaping is NEEDED — only that our two halves agree — so the same
// payload is also sent RAW, and that case is asserted to come out WRONG. A
// check that cannot fail is not a check. → CLAUDE.md standing rule 5 and the
// four times a round trip hid a wrong constant in this repo.
{
  // Deliberately full of the bytes a transfer carries: IAC itself, and the
  // command bytes that follow one, so a parser reading them as commands
  // swallows real data rather than merely mangling it.
  const payload = [0x01, IAC, 0x02, IAC, IAC, 0x03, IAC, DO, OPT_SGA, 0x04,
                   IAC, SB, 0x05, IAC, SE, 0x06, ...new Array(64).fill(IAC), 0x07];

  {
    const { f, data, sent } = mk();
    f.process(escapeIAC(Uint8Array.from(payload)));
    eq(data, payload, 'escaped payload round-trips through a peer filter byte for byte');
    eq(sent, [], 'escaped payload provokes no negotiation reply');
  }

  // Negative control: the same bytes unescaped must NOT survive.
  {
    const { f, data } = mk();
    f.process(Uint8Array.from(payload));
    const same = data.length === payload.length && data.every((v, i) => v === payload[i]);
    if (!same) pass++;
    else {
      fail++;
      console.log('  FAIL negative control: raw payload survived a telnet parser intact.\n' +
                  '       If this passes, the round trip above proves nothing.');
    }
  }
}

// ─── 7c. Negotiation replies must NOT be escaped ────────────────────────────
// escapeIAC is for payload only. The filter's own output is COMMANDS, and the
// IAC that makes a command a command must stay single — doubling it would turn
// every negotiation reply into two literal 0xFF payload bytes. This is why the
// escape lives at server.js's toBBSPayload() and not inside toBBS(), which
// also carries filter.onSend.
{
  const { f, sent } = mk();
  f.negotiate();
  eq(sent, [IAC, WILL, OPT_SGA, IAC, DO, OPT_SGA], 'negotiate() emits single IACs');
  // What would happen if the wiring were wrong, stated explicitly so the
  // reason this must not be done is in the suite rather than only in a comment.
  eq(escapeIAC(Uint8Array.from(sent)),
     [IAC, IAC, WILL, OPT_SGA, IAC, IAC, DO, OPT_SGA],
     'escaping a negotiation reply would corrupt it — hence payload-only');
}

// ─── 6. Callback safety ─────────────────────────────────────────────────────
section('callback safety');
{
  const f = new TelnetFilter();   // onData/onSend left null
  f.process([...str('hi'), IAC, DO, OPT_SGA]);
  f.negotiate();
  pass++;   // reaching here without throwing is the assertion
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
