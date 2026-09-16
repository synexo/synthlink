#!/usr/bin/env node
// tools/tests/xfertest.js — public/xfer.js: XMODEM / YMODEM / YMODEM-G / ZMODEM.
//
//   node tools/tests/xfertest.js
//
// Three kinds of assertion, and the order matters:
//
//   TABLES FIRST. The CRCs, the block framing and the ZDLE escaping are checked
//   against their published check values and against literal byte sequences,
//   before anything round-trips. A round trip cannot see a wrong constant — the
//   receiver inverts whatever the transmitter did — and this repo has found
//   that four times (V.32bis Figure 2-1, V.34 Figure 5, V.32's Tables 1 and 3,
//   V.34's symbol rate). XMODEM's CRC-16 is the MSB-first 0x1021 form and
//   BitFrame's is the reflected 0x8408 one; both are called "CRC-16-CCITT" and
//   they are different functions, so §1 pins ours to the published check value
//   and keeps the other orientation as a NEGATIVE control.
//
//   THEN ROUND TRIPS, for the state machines — retries, duplicate blocks, the
//   batch terminator, flow control.
//
//   THEN LRZSZ. The only sections here that can fail on a misread of the
//   protocol rather than a disagreement with ourselves, because the peer is not
//   ours: sz and rb are the reference implementations every BBS was tested
//   against. Same role bell103capturetest plays for FSK. They SKIP cleanly when
//   lrzsz is not installed, and are not counted as passes when they do.
//
// No DOM and no sockets: xfer.js is a classic script with a module.exports
// tail, exactly as rxjitter.js is, so it is required off the file the browser
// is served.

const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const X = require('../../public/xfer.js');
const { createTransfer, Sniffer, crc16, crc32, checksum,
        SOH, STX, EOT, ACK, NAK, CAN, SUB, CRCCHR, GCHR,
        ZPAD, ZDLE, ZHEX, ZBIN32 } = X;

let pass = 0, fail = 0, skip = 0;
function ok(cond, what, detail) {
  if (cond) { pass++; console.log(`  ok   ${what}`); return true; }
  fail++; console.log(`  FAIL ${what}${detail ? `\n       ${detail}` : ''}`);
  return false;
}
function eq(actual, expected, what) {
  const a = Array.from(actual), e = Array.from(expected);
  const same = a.length === e.length && a.every((v, i) => v === e[i]);
  return ok(same, what, same ? '' :
    `expected ${e.map(hx).join(' ')}\n       actual   ${a.map(hx).join(' ')}`);
}
const hx = (b) => b.toString(16).padStart(2, '0');
function section(n) { console.log(`\n── ${n}`); }
const bytes = (s) => Uint8Array.from(String(s), (c) => c.charCodeAt(0) & 0xFF);

// ─── 1. CRCs against their published check values ───────────────────────────
section('CRCs — published check values, not a round trip');
{
  const CHECK = bytes('123456789');

  // CRC-16/XMODEM: the catalogued check value for "123456789" is 0x31C3.
  ok(crc16(CHECK, 0, CHECK.length) === 0x31C3,
     'CRC-16/XMODEM("123456789") === 0x31C3',
     `got 0x${crc16(CHECK, 0, CHECK.length).toString(16)}`);

  // CRC-32: the catalogued check value is 0xCBF43926 (zlib/PNG form).
  const c32 = (crc32(CHECK, 0, CHECK.length) ^ 0xFFFFFFFF) >>> 0;
  ok(c32 === 0xCBF43926, 'CRC-32("123456789") === 0xCBF43926',
     `got 0x${c32.toString(16)}`);

  // NEGATIVE CONTROL. The reflected 0x8408 form is what lib BitFrame carries for
  // V.34, and it is NOT this one. If these ever agree, one of them is wrong and
  // the check above has stopped meaning anything.
  const reflected = (() => {
    let c = 0;
    for (const b of CHECK) {
      c ^= b;
      for (let i = 0; i < 8; i++) c = (c & 1) ? ((c >>> 1) ^ 0x8408) : (c >>> 1);
    }
    return c & 0xFFFF;
  })();
  ok(reflected !== 0x31C3,
     'the reflected 0x8408 form gives a DIFFERENT answer — the two are not interchangeable',
     `both came out 0x${reflected.toString(16)}`);

  ok(crc16(new Uint8Array(0), 0, 0) === 0, 'CRC-16 of nothing is the zero preset');
  ok(checksum(Uint8Array.of(0xFF, 0x02), 0, 2) === 0x01, 'the 8-bit checksum wraps');
}

// ─── 2. Block framing, at literal bytes ─────────────────────────────────────
section('block framing');
{
  // Drive a sender far enough to emit one block, with a payload short enough to
  // read by eye, and assert the whole thing rather than its length.
  const out = [];
  const t = createTransfer({
    protocol: 'xmodem', mode: 'send',
    files: [{ name: 'A', data: bytes('HI'), mtime: 0 }],
    send: (b) => out.push(...b), ready: () => true,
  });
  t.feed(Uint8Array.of(CRCCHR));            // receiver offers CRC mode
  const blk = Uint8Array.from(out);
  ok(blk.length === 133, 'a 128-byte CRC block is 3 + 128 + 2 bytes', `got ${blk.length}`);
  eq(blk.subarray(0, 5), [SOH, 0x01, 0xFE, 0x48, 0x49], 'SOH, seq 1, ~seq, then the data');
  ok(blk[5] === SUB && blk[130] === SUB, 'short data is padded with CPMEOF (0x1A)');
  const want = crc16(blk, 3, 131);
  eq(blk.subarray(131, 133), [(want >> 8) & 0xFF, want & 0xFF], 'CRC-16 is big-endian at the tail');

  // Checksum mode is chosen by the RECEIVER's NAK, and changes the tail.
  const out2 = [];
  const t2 = createTransfer({
    protocol: 'xmodem', mode: 'send', files: [{ name: 'A', data: bytes('HI'), mtime: 0 }],
    send: (b) => out2.push(...b), ready: () => true,
  });
  t2.feed(Uint8Array.of(NAK));
  const b2 = Uint8Array.from(out2);
  ok(b2.length === 132, 'a checksum block is one byte shorter', `got ${b2.length}`);
  ok(b2[131] === checksum(b2, 3, 131), 'and carries an 8-bit checksum');

  // 1K blocks are STX, and XMODEM proper must never send one.
  const big = new Uint8Array(1024).fill(0x41);
  const o3 = [];
  const t3 = createTransfer({ protocol: 'ymodem', mode: 'send',
    files: [{ name: 'B', data: big, mtime: 0 }], send: (b) => o3.push(...b), ready: () => true });
  t3.feed(Uint8Array.of(CRCCHR));           // block 0
  o3.length = 0;
  t3.feed(Uint8Array.of(ACK)); t3.feed(Uint8Array.of(CRCCHR));
  ok(o3[0] === STX, 'YMODEM uses STX for a 1024-byte block', `got 0x${hx(o3[0] || 0)}`);

  const o4 = [];
  const t4 = createTransfer({ protocol: 'xmodem', mode: 'send',
    files: [{ name: 'B', data: big, mtime: 0 }], send: (b) => o4.push(...b), ready: () => true });
  t4.feed(Uint8Array.of(CRCCHR));
  ok(o4[0] === SOH, 'plain XMODEM never sends STX, however much data is left');
}

// ─── 3. YMODEM block 0 ──────────────────────────────────────────────────────
section('YMODEM block 0');
{
  const out = [];
  const t = createTransfer({ protocol: 'ymodem', mode: 'send',
    files: [{ name: 'READ.ME', data: new Uint8Array(4242), mtime: 0 }],
    send: (b) => out.push(...b), ready: () => true });
  t.feed(Uint8Array.of(CRCCHR));
  const blk = Uint8Array.from(out);
  eq(blk.subarray(0, 3), [SOH, 0x00, 0xFF], 'block 0 is SOH with sequence zero');
  const body = Array.from(blk.subarray(3, 131));
  const nul = body.indexOf(0);
  const name = body.slice(0, nul).map((c) => String.fromCharCode(c)).join('');
  ok(name === 'READ.ME', 'the filename is NUL-terminated at the front', `got ${JSON.stringify(name)}`);
  const rest = body.slice(nul + 1, body.indexOf(0, nul + 1)).map((c) => String.fromCharCode(c)).join('');
  ok(rest.split(' ')[0] === '4242', 'the length follows it in decimal', `got ${JSON.stringify(rest)}`);
  ok(body.slice(nul + 1 + rest.length + 1).every((b) => b === 0),
     'and the rest of the block is NUL, not CPMEOF — block 0 is a header, not data');
}

// ─── 4. ZDLE escaping, at literal bytes ─────────────────────────────────────
section('ZMODEM ZDLE escaping');
{
  const out = [];
  const t = createTransfer({ protocol: 'zmodem', mode: 'send', files: [], send: (b) => out.push(...b) });
  out.length = 0;
  // Reach into the subpacket builder directly: what is being asserted is the
  // escaping rule, and driving a whole session to observe it would bury it.
  t.peerCan32 = false;
  const payload = Uint8Array.of(0x41, ZDLE, 0x10, 0x11, 0x13, 0x90, 0x91, 0x93, 0x42);
  t._subpacket(payload, 0, payload.length, X.ZCRCE);
  const got = Uint8Array.from(out);
  // Every one of the seven must appear as ZDLE, byte^0x40 — and 'A'/'B' must not.
  const want = [0x41,
    ZDLE, ZDLE ^ 0x40, ZDLE, 0x10 ^ 0x40, ZDLE, 0x11 ^ 0x40, ZDLE, 0x13 ^ 0x40,
    ZDLE, 0x90 ^ 0x40, ZDLE, 0x91 ^ 0x40, ZDLE, 0x93 ^ 0x40, 0x42,
    ZDLE, X.ZCRCE];
  eq(got.subarray(0, want.length), want, 'all seven escaped bytes, and only those');
  ok(got.length === want.length + 2, 'followed by a 16-bit CRC', `got ${got.length}`);

  // A hex header is the form that has to survive a terminal, so it is ASCII
  // with a CR LF tail. Assert the shape at its literal bytes.
  const o2 = [];
  const t2 = createTransfer({ protocol: 'zmodem', mode: 'receive', send: (b) => o2.push(...b) });
  const h = Uint8Array.from(o2);
  eq(h.subarray(0, 4), [ZPAD, ZPAD, ZDLE, ZHEX], 'a hex header opens with ** ZDLE B');
  ok(h[4] === 0x30 && h[5] === 0x31, 'and names its type in ASCII hex (ZRINIT = 01)',
     `got ${String.fromCharCode(h[4], h[5])}`);
  ok(h[h.length - 1] === 0x11 || h[h.length - 1] === 0x0A,
     'and ends with CR LF, optionally XON');
}

// ─── 5. The auto-start announcement ─────────────────────────────────────────
section('ZMODEM auto-start sniffing');
{
  const s = new Sniffer();
  ok(!s.feed(bytes('Welcome to the board! ** stars ** here'), 1000),
     'asterisks in ordinary output do not arm it');
  const hit = s.feed(Uint8Array.from([...bytes('rz\r'), ZPAD, ZPAD, ZDLE, ZHEX, 0x30, 0x30]), 2000);
  ok(hit && hit.kind === 'zmodem', 'the full **\\x18B00 announcement does');

  // The poll detector: three offers with nothing between them is a board
  // waiting for an upload, and which byte it sent says which protocol.
  const p = new Sniffer();
  let got = null;
  got = p.feed(Uint8Array.of(CRCCHR), 0) || got;
  got = p.feed(Uint8Array.of(CRCCHR), 3000) || got;
  ok(!got, 'two offers are not yet a conclusion');
  got = p.feed(Uint8Array.of(CRCCHR), 6000) || got;
  ok(got && got.kind === 'poll' && got.byte === CRCCHR, 'three are');
  ok(Sniffer.protoForPoll(CRCCHR) === 'ymodem', "'C' means CRC — YMODEM");
  ok(Sniffer.protoForPoll(NAK) === 'xmodem', 'NAK means checksum XMODEM');
  ok(Sniffer.protoForPoll(GCHR) === 'ymodem-g', "'G' means YMODEM-G");

  const q = new Sniffer();
  q.feed(Uint8Array.of(CRCCHR), 0); q.feed(Uint8Array.of(CRCCHR), 1000);
  q.feed(bytes('hoose one:'), 1100);
  ok(!q.feed(Uint8Array.of(CRCCHR), 2000),
     'real output between the offers resets it — "Choose:" is not a transfer');
}

// ─── 6. Round trips, and what each protocol promises about length ───────────
section('round trips');
function pair(proto, files, opts) {
  opts = opts || {};
  const qa = [], qb = [];
  let t = 0;
  const A = createTransfer({ protocol: proto, mode: 'send', files,
    send: (b) => qa.push(Uint8Array.from(b)),
    ready: () => (opts.ready ? opts.ready() : true),
    onError: (e) => { A.errMsg = e; } });
  const B = createTransfer({ protocol: proto, mode: 'receive',
    send: (b) => qb.push(Uint8Array.from(b)), ready: () => true,
    onDone: (f) => { B.result = f; }, onError: (e) => { B.errMsg = e; } });
  for (let i = 0; i < 200000 && !(A.done && B.done); i++) {
    t += 5;
    while (qa.length) {
      let b = qa.shift();
      const twice = opts.duplicate && opts.duplicate(b);
      if (opts.corrupt) b = opts.corrupt(b, i);
      if (b) B.feed(b);
      if (twice && b) B.feed(b);
    }
    while (qb.length) A.feed(qb.shift());
    A.tick(t); B.tick(t); A.pump(); B.pump && B.pump();
    if (A.errMsg || B.errMsg) break;
  }
  return { A, B, ticks: t };
}
{
  const data = new Uint8Array(5000);
  for (let i = 0; i < data.length; i++) data[i] = (i * 7) & 0xFF;
  const files = [{ name: 'TEST.BIN', data, mtime: 0 }];

  for (const proto of ['ymodem', 'ymodem-g', 'zmodem']) {
    const { A, B } = pair(proto, files);
    const g = B.result && B.result[0];
    ok(!!g, `${proto}: the file arrives`, `A=${A.errMsg} B=${B.errMsg}`);
    if (!g) continue;
    ok(g.name === 'TEST.BIN', `${proto}: with its name`, `got ${JSON.stringify(g.name)}`);
    ok(g.data.length === data.length,
       `${proto}: at its EXACT length — the header carries one`, `got ${g.data.length}`);
    ok(g.data.every((v, i) => v === data[i]), `${proto}: byte for byte`);
  }

  // XMODEM has no header, so it cannot know the length. The padding is the
  // protocol's own well-known limitation and is asserted rather than trimmed:
  // a trimmer would corrupt any binary file legitimately ending in 0x1A.
  for (const proto of ['xmodem', 'xmodem1k']) {
    const { B } = pair(proto, files);
    const g = B.result && B.result[0];
    ok(!!g, `${proto}: the file arrives`);
    if (!g) continue;
    const unit = proto === 'xmodem' ? 128 : 1024;
    ok(g.data.length >= data.length && g.data.length % 128 === 0,
       `${proto}: length is rounded UP to a whole block — no header to say otherwise`,
       `got ${g.data.length} for ${data.length}`);
    ok(g.data.subarray(0, data.length).every((v, i) => v === data[i]),
       `${proto}: and every real byte is intact`);
    ok(g.name === '', `${proto}: carries no filename — the host must name it`);
    void unit;
  }
}

// ─── 7. A batch of files, and the terminator that ends it ───────────────────
section('YMODEM batch');
{
  const f1 = { name: 'ONE.TXT', data: bytes('first file'), mtime: 0 };
  const f2 = { name: 'TWO.BIN', data: new Uint8Array(2000).fill(0xAB), mtime: 0 };
  const { A, B } = pair('ymodem', [f1, f2]);
  ok(B.result && B.result.length === 2, 'both files arrive in one session',
     `got ${B.result ? B.result.length : 'none'} — A=${A.errMsg} B=${B.errMsg}`);
  if (B.result && B.result.length === 2) {
    ok(B.result[0].name === 'ONE.TXT' && B.result[1].name === 'TWO.BIN', 'in order, named');
    ok(B.result[1].data.length === 2000, 'the second at its declared length');
  }
}

// ─── 8. Retry, and the one protocol that must NOT retry ─────────────────────
section('errors and retries');
{
  const data = new Uint8Array(3000); data.fill(0x5A);
  const files = [{ name: 'R.BIN', data, mtime: 0 }];

  // Flip a byte inside the third block the sender emits. A lock-step protocol
  // must NAK it and recover; the file must still arrive byte-exact.
  let n = 0;
  const { B } = pair('ymodem', files, {
    corrupt: (b) => {
      if (b.length > 100 && ++n === 3) { const c = Uint8Array.from(b); c[10] ^= 0xFF; return c; }
      return b;
    },
  });
  const g = B.result && B.result[0];
  ok(!!g && g.data.length === data.length && g.data.every((v, i) => v === data[i]),
     'YMODEM recovers from a corrupted block and the file is still exact',
     `errMsg=${B.errMsg} len=${g ? g.data.length : 'none'}`);

  // The same corruption under YMODEM-G must END the transfer. That is the
  // protocol working as designed: G removes the acknowledgement, so there is
  // nothing to retry with. A G implementation that quietly recovered would be
  // a different protocol.
  let m = 0;
  const gg = pair('ymodem-g', files, {
    corrupt: (b) => {
      if (b.length > 100 && ++m === 3) { const c = Uint8Array.from(b); c[10] ^= 0xFF; return c; }
      return b;
    },
  });
  ok(!!gg.B.errMsg && !gg.B.result,
     'YMODEM-G aborts on a corrupted block rather than retrying',
     `errMsg=${gg.B.errMsg} result=${gg.B.result ? 'delivered' : 'none'}`);

  // A duplicate block is not an error: it means the sender never saw the ACK
  // and sent the block again. The receiver must acknowledge it and NOT append
  // it — a receiver that did would produce a file that is too long and whose
  // every later byte is displaced, and nothing downstream could catch that,
  // because each copy carries a perfectly valid CRC.
  //
  // Driven against the RECEIVER directly rather than through a sender. A
  // lock-step sender only repeats a block after its own timeout, so wiring two
  // engines together and duplicating a frame models something the protocol
  // cannot actually produce — and the sender would then see two ACKs for one
  // block, which is a different fault with a different answer.
  {
    const mk = (seq, fill) => {
      const b = new Uint8Array(133);
      b[0] = SOH; b[1] = seq & 0xFF; b[2] = (~seq) & 0xFF;
      b.fill(fill, 3, 131);
      const c = crc16(b, 3, 131);
      b[131] = (c >> 8) & 0xFF; b[132] = c & 0xFF;
      return b;
    };
    const acks = [];
    const R = createTransfer({ protocol: 'xmodem', mode: 'receive',
      send: (b) => acks.push(...b), ready: () => true,
      onDone: (f) => { R.result = f; }, onError: (e) => { R.errMsg = e; } });
    R.tick(0);                                   // offer 'C', selecting CRC mode
    acks.length = 0;
    R.feed(mk(1, 0x41));
    R.feed(mk(1, 0x41));                         // the repeat
    R.feed(mk(2, 0x42));
    R.feed(Uint8Array.of(EOT)); R.feed(Uint8Array.of(EOT));
    const g = R.result && R.result[0];
    ok(!!g && g.data.length === 256,
       'a repeated block is discarded, not appended',
       `got ${g ? g.data.length : 'nothing'} bytes, expected 256`);
    ok(!!g && g.data[0] === 0x41 && g.data[128] === 0x42,
       'and the block that followed it lands at the right offset');
    ok(acks.filter((b) => b === ACK).length >= 3,
       'while still being acknowledged — the sender is waiting for that ACK',
       `saw ${acks.filter((b) => b === ACK).length} ACKs`);
  }
}

// ─── 8b. The handshake must stop when the board starts answering ────────────
// A real board prints a paragraph — "Beginning YMODEM-g download of the 1 file
// matching…" — and only THEN sends block 0. That easily crosses the three-second
// re-offer interval, so a receiver that keeps offering until it has parsed a
// COMPLETE block 0 sends a second 'C'/'G' into a sender that has already begun.
//
// A YMODEM-G sender expects nothing from the receiver but CAN. The observed
// result on a live board was a resent block 0, a sequence error here, five CANs
// back, and "Operator CTRL-X abort" on the board.
//
// Invisible over a pipe, where block 0 lands in microseconds — which is why
// lrzsz never caught it and this section is driven on the clock instead.
section('the offer stops when the board answers');
{
  const mk = (seq, fill, stx) => {
    const len = stx ? 1024 : 128;
    const b = new Uint8Array(3 + len + 2);
    b[0] = stx ? STX : SOH; b[1] = seq & 0xFF; b[2] = (~seq) & 0xFF;
    b.fill(fill, 3, 3 + len);
    const c = crc16(b, 3, 3 + len);
    b[3 + len] = (c >> 8) & 0xFF; b[4 + len] = c & 0xFF;
    return b;
  };
  const mkBlock0 = (name, size) => {
    const b = new Uint8Array(133);
    b[0] = SOH; b[1] = 0; b[2] = 0xFF;
    const head = bytes(`${name}\0${size} 0\0`);
    b.set(head.subarray(0, 128), 3);
    const c = crc16(b, 3, 131);
    b[131] = (c >> 8) & 0xFF; b[132] = c & 0xFF;
    return b;
  };

  for (const proto of ['ymodem-g', 'ymodem']) {
    const sent = [];
    const R = createTransfer({ protocol: proto, mode: 'receive',
      send: (b) => sent.push(...b), ready: () => true,
      onDone: (f) => { R.result = f; }, onError: (e) => { R.errMsg = e; } });
    R.tick(0);
    const first = sent.length;
    ok(first === 1, `${proto}: one offer goes out to start with`, `sent ${first}`);

    // The board's banner text, then the first byte of block 0 and nothing more
    // yet — the block is genuinely in flight and split across the interval.
    R.feed(bytes('Beginning download of 1 file...\r\n'));
    R.feed(mkBlock0('T.BIN', 128).subarray(0, 40));
    R.tick(4000);
    R.tick(8000);
    ok(sent.length === first,
       `${proto}: and NO further offer once a block has started arriving`,
       `${sent.length - first} extra byte(s) sent into a live sender`);

    // The rest of block 0, then data, then EOT — it must still complete.
    R.feed(mkBlock0('T.BIN', 128).subarray(40));
    R.feed(mk(1, 0x41));
    R.feed(Uint8Array.of(EOT));
    R.feed(Uint8Array.of(EOT));
    R.feed(mkBlock0('', 0));
    ok(!R.errMsg, `${proto}: and the transfer still completes`, R.errMsg);
    const g = R.result && R.result[0];
    ok(!!g && g.data.length === 128, `${proto}: at the declared length`,
       g ? `${g.data.length}` : 'nothing');
  }

  // YMODEM-G must ACK the EOT, never NAK it. The two-EOT dance belongs to the
  // acknowledged protocols; G removed the acknowledgement, and lrzsz tolerating
  // a NAK is not evidence that a board will.
  {
    const sent = [];
    const R = createTransfer({ protocol: 'ymodem-g', mode: 'receive',
      send: (b) => sent.push(...b), ready: () => true,
      onDone: (f) => { R.result = f; }, onError: (e) => { R.errMsg = e; } });
    R.tick(0);
    R.feed(mkBlock0('T.BIN', 128));
    R.feed(mk(1, 0x42));
    sent.length = 0;
    R.feed(Uint8Array.of(EOT));
    ok(sent.indexOf(NAK) < 0, 'YMODEM-G never NAKs an EOT',
       `sent ${sent.map(hx).join(' ')}`);
    ok(sent.indexOf(ACK) >= 0, 'it acknowledges it on the first one');
  }

  // A sender that repeats block 0 — because it missed an ACK, or because a
  // stray byte made it restart — must not be a fatal sequence error.
  {
    const R = createTransfer({ protocol: 'ymodem-g', mode: 'receive',
      send: () => {}, ready: () => true,
      onDone: (f) => { R.result = f; }, onError: (e) => { R.errMsg = e; } });
    R.tick(0);
    R.feed(mkBlock0('T.BIN', 128));
    R.feed(mkBlock0('T.BIN', 128));      // the repeat
    R.feed(mk(1, 0x43));
    ok(!R.errMsg, 'a repeated block 0 is tolerated rather than aborting the transfer',
       R.errMsg);
  }
}

// ─── 9. Flow control ────────────────────────────────────────────────────────
section('flow control');
{
  // The streaming protocols are the ones that can run away, and this is wired
  // to a REAL peer rather than poked: what has to hold is that a sender whose
  // transport is full stops mid-file and finishes correctly once it drains —
  // not merely that one pump() returned early.
  //
  // Without this, a 10 MB upload feeds the DSP faster than a carrier can empty
  // it and FskModulator._bits grows until V8 refuses the array. That is the
  // crash server.js's modemFlow() was written for, reproduced in the tab, and
  // the queue is again the only record of the difference between a file and a
  // carrier. → HANDOFF.md.
  for (const proto of ['ymodem-g', 'zmodem']) {
    const data = new Uint8Array(120000);
    for (let i = 0; i < data.length; i++) data[i] = (i * 13) & 0xFF;
    let cap = 8192, sent = 0, t = 0;
    const qa = [], qb = [];
    const A = createTransfer({ protocol: proto, mode: 'send',
      files: [{ name: 'BIG.BIN', data, mtime: 0 }],
      send: (b) => { sent += b.length; qa.push(Uint8Array.from(b)); },
      ready: () => sent < cap,
      onError: (e) => { A.errMsg = e; } });
    const B = createTransfer({ protocol: proto, mode: 'receive',
      send: (b) => qb.push(Uint8Array.from(b)), ready: () => true,
      onDone: (f) => { B.result = f; }, onError: (e) => { B.errMsg = e; } });
    const spin = (n) => {
      for (let i = 0; i < n && !(A.done && B.done); i++) {
        t += 5;
        while (qa.length) B.feed(qa.shift());
        while (qb.length) A.feed(qb.shift());
        A.tick(t); B.tick(t); A.pump();
      }
    };
    spin(4000);
    ok(sent < data.length, `${proto}: a full transport stops the sender mid-file`,
       `sent ${sent} of ${data.length} with a ${cap}-byte window`);
    ok(!B.result, `${proto}: and the transfer has not completed`);
    cap = Infinity;                      // the transport drains
    spin(200000);
    const g = B.result && B.result[0];
    ok(!!g && g.data.length === data.length && g.data.every((v, i) => v === data[i]),
       `${proto}: it resumes and the file is still byte-exact`,
       `errA=${A.errMsg} errB=${B.errMsg} len=${g ? g.data.length : 'none'}`);
  }
}

// ─── 10. lrzsz — the only peer here that is not ours ────────────────────────
section('lrzsz interop');
let haveLrzsz = false;
try { execFileSync('sz', ['--help'], { stdio: 'ignore' }); haveLrzsz = true; }
catch (_) { try { execFileSync('sz', ['-h'], { stdio: 'ignore' }); haveLrzsz = true; } catch (__) {} }

if (!haveLrzsz) {
  skip++;
  console.log('  SKIP lrzsz (sz/rz) not installed — apt-get install lrzsz');
  report();
} else {
  const PROBE = (() => {
    // Deliberately full of the bytes that break a naive implementation: 0xFF
    // (an IAC on the wire), 0x18 (CAN, and ZMODEM's own ZDLE), 0x11/0x13
    // (XON/XOFF) and 0x1A (CPMEOF, which a padding-trimmer would eat).
    const d = new Uint8Array(4096);
    for (let i = 0; i < d.length; i++) d[i] = (i * 31) & 0xFF;
    d.set([0xFF, 0xFF, 0x18, 0x11, 0x13, 0x1A, 0x1A, 0x00], 100);
    d[d.length - 1] = 0x1A;
    return d;
  })();

  const recvCases = [
    ['xmodem',   ['-X', '-b']],
    ['ymodem',   ['--ymodem', '-b']],
    ['ymodem-g', ['--ymodem', '-b']],
    ['zmodem',   ['-b']],
  ];
  const sendCases = [
    ['xmodem', ['-X', '-b', 'PROBE.BIN']],
    ['ymodem', ['--ymodem', '-b']],
    ['zmodem', ['-b']],
  ];

  function recvFromSz([proto, args], next) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xfer-r-'));
    const f = path.join(dir, 'PROBE.BIN');
    fs.writeFileSync(f, Buffer.from(PROBE));
    const p = spawn('sz', [...args, f], { stdio: ['pipe', 'pipe', 'pipe'] });
    let done = false, err = '';
    p.stdin.on('error', () => {});
    p.stderr.on('data', (d) => { err += d; });
    const T = createTransfer({
      protocol: proto, mode: 'receive',
      send: (b) => { try { p.stdin.write(Buffer.from(b)); } catch (_) {} },
      ready: () => true,
      onDone: (files) => {
        done = true;
        const g = files[0];
        const body = g ? g.data.subarray(0, PROBE.length) : null;
        ok(!!body && body.length === PROBE.length && body.every((v, i) => v === PROBE[i]),
           `${proto}: our RECEIVER takes a file from real sz, byte for byte`,
           g ? `got ${g.data.length}B for ${PROBE.length}` : 'nothing delivered');
        if (proto !== 'xmodem') {
          ok(g && g.name === 'PROBE.BIN', `${proto}: and sz's own filename comes through`,
             g ? JSON.stringify(g.name) : '');
        }
        finish();
      },
      onError: (e) => { done = true; ok(false, `${proto}: receiver against sz`, `${e} / ${err.slice(0, 160)}`); finish(); },
    });
    p.stdout.on('data', (d) => T.feed(new Uint8Array(d)));
    let t = 0;
    const iv = setInterval(() => { t += 100; T.tick(t); }, 20);
    const bail = setTimeout(() => {
      if (!done) { ok(false, `${proto}: receiver against sz`, `timed out — ${err.slice(0, 160)}`); finish(); }
    }, 25000);
    function finish() {
      clearInterval(iv); clearTimeout(bail);
      try { p.kill(); } catch (_) {}
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
      setImmediate(next);
    }
  }

  function sendToRz([proto, args], next) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xfer-s-'));
    const p = spawn('rz', args, { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
    let err = '', settled = false;
    // rz closes its input the moment it is satisfied; a write still in flight
    // then raises EPIPE on the stream itself, which no try/catch around
    // write() can see.
    p.stdin.on('error', () => {});
    p.stderr.on('data', (d) => { err += d; });
    const T = createTransfer({
      protocol: proto, mode: 'send', files: [{ name: 'PROBE.BIN', data: PROBE, mtime: 0 }],
      send: (b) => { try { p.stdin.write(Buffer.from(b)); } catch (_) {} },
      ready: () => true,
      onError: (e) => { if (!settled) { settled = true; ok(false, `${proto}: sender against rz`, `${e} / ${err.slice(0, 160)}`); } },
    });
    p.stdout.on('data', (d) => T.feed(new Uint8Array(d)));
    let t = 0;
    const iv = setInterval(() => { t += 100; T.tick(t); T.pump(); }, 20);
    p.on('close', () => {
      clearInterval(iv); clearTimeout(bail);
      if (!settled) {
        settled = true;
        let best = null;
        for (const name of fs.readdirSync(dir)) {
          const b = fs.readFileSync(path.join(dir, name));
          if (b.length >= PROBE.length && Buffer.from(PROBE).equals(b.subarray(0, PROBE.length))) best = { name, len: b.length };
        }
        ok(!!best, `${proto}: our SENDER hands a file to real rz, byte for byte`,
           `dir=${fs.readdirSync(dir).join(',')} err=${err.slice(0, 160)}`);
      }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
      setImmediate(next);
    });
    const bail = setTimeout(() => { try { p.kill(); } catch (_) {} }, 25000);
  }

  const queue = [
    ...recvCases.map((c) => (next) => recvFromSz(c, next)),
    ...sendCases.map((c) => (next) => sendToRz(c, next)),
  ];
  (function step(i) {
    if (i >= queue.length) return report();
    queue[i](() => step(i + 1));
  })(0);
}

function report() {
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed` +
              (skip ? `, ${skip} skipped` : ''));
  process.exit(fail === 0 ? 0 : 1);
}
