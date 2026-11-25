#!/usr/bin/env node
'use strict';
// tools/tests/ec-check.js — V.42 error control and V.42bis/V.44 compression
// (vendor/src/ec/), each layer on its own. The checks are BinModem's own unit
// tests for the same layers (crates/ec), carried over with the code.
//
//   node tools/tests/ec-check.js          ONLY=hdlc,bits to narrow it

const path = require('path');
const EC = path.join(__dirname, '..', '..', 'vendor', 'src', 'ec');
const only = process.env.ONLY ? process.env.ONLY.split(',') : null;
const want = (s) => !only || only.includes(s);

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.log(`  FAIL ${msg}`); } }
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const bytes = (s) => Array.from(Buffer.from(s, 'latin1'));
function section(name, fn) { if (!want(name)) return; const p0 = pass, f0 = fail; fn(); console.log(`[${name}] ${pass - p0} ok${fail - f0 ? `, ${fail - f0} FAILED` : ''}`); }

section('bits', () => {
  const { BitWriter, BitReader } = require(path.join(EC, 'Bits'));
  { const w = new BitWriter(), out = []; w.write(0b100000001, 9, out); ok(eq(out, [1]) && w.pending() === 1, 'a nine-bit codeword spans two octets'); }
  { const vals = Array.from({ length: 200 }, (_, i) => (i * 7) % 512); const w = new BitWriter(), out = [];
    for (const v of vals) w.write(v, 9, out); w.align(out);
    const r = new BitReader(); out.forEach((b) => r.pushOctet(b));
    ok(vals.every((v) => r.read(9) === v), 'codewords round-trip at a fixed width'); }
  { const w = new BitWriter(), out = []; w.write(300, 9, out); w.write(700, 10, out); w.write(1500, 11, out); w.align(out);
    const r = new BitReader(); out.forEach((b) => r.pushOctet(b));
    ok(r.read(9) === 300 && r.read(10) === 700 && r.read(11) === 1500, 'a changing codeword width round-trips'); }
  { const r = new BitReader(); r.pushOctet(0xff); const a = r.read(9); r.pushOctet(0x01);
    ok(a === null && r.read(9) === 0x1ff, 'reading more than has arrived yields nothing'); }
  { const r = new BitReader(); r.pushOctet(0xab); r.pushOctet(0xcd); r.read(3); r.align();
    ok(r.available() === 8 && r.read(8) === 0xcd, 'alignment discards only the partial octet'); }
  { const w = new BitWriter(), out = []; w.write(0b111, 3, out); const e = out.length === 0; w.align(out);
    ok(e && eq(out, [0b111]) && w.pending() === 0, 'writer alignment pads with zeroes'); }
});

section('hdlc', () => {
  const H = require(path.join(EC, 'Hdlc'));
  const { Encoder, Decoder, FCS16, FCS32, FLAG, FrameError } = H;
  const drain = (enc) => { const b = []; let x; while ((x = enc.nextBit()) !== null) b.push(x); return b; };
  const feedAll = (dec, bits) => { const out = []; for (const b of bits) { const r = dec.feed(b); if (r) out.push(r); } return out; };
  const roundTrip = (payload, fcs) => { const e = new Encoder(fcs); e.frame(payload); return feedAll(new Decoder(fcs), drain(e)); };
  const raw = (oct) => oct.flatMap((o) => [0, 1, 2, 3, 4, 5, 6, 7].map((i) => (o >> i) & 1));

  { const c = new H.Crc16(); c.updateAll(bytes('123456789')); ok(((~c.residue()) & 0xffff) === 0x906e, 'CRC-16 matches the X.25 vector'); }
  { const c = new H.Crc32(); c.updateAll(bytes('123456789')); ok(((~c.residue()) >>> 0) === 0xcbf43926, 'CRC-32 matches the known vector'); }
  { const f = H.appendFcs(bytes('\x03\x73hello'), FCS16); const c = new H.Crc16(); c.updateAll(f);
    ok(c.residue() === H.Crc16.GOOD && H.fcsOk(f, FCS16), 'a good frame leaves the expected residue'); }
  ok(H.fcsOk(H.appendFcs(bytes('\x03\x73hello'), FCS32), FCS32), 'the CRC-32 residue holds too');
  { const p = bytes('\x03\x73the quick brown fox'); const g = roundTrip(p, FCS16); ok(g.length === 1 && eq(g[0].ok, p), 'round-trips a frame'); }
  { const p = bytes('\x03\x73wide check sequence'); const g = roundTrip(p, FCS32); ok(eq(g[0].ok, p), 'round-trips with a 32-bit FCS'); }
  { const e = new Encoder(FCS32); const p = bytes('\x03\x73either width'); e.frame(p);
    const d = new Decoder(FCS16); d.acceptEither(); const seen = [];
    for (const b of drain(e)) { const r = d.feed(b); if (r) seen.push([r, d.discarded().slice()]); }
    ok(seen.length === 1 && eq(seen[0][0].ok, p) && d.matchedFcs() === FCS32 && seen[0][1].length === 0,
       'a frame the other width reads is not left among the damaged'); }
  { const p = new Array(32).fill(0xff); const g = roundTrip(p, FCS16); ok(g.length === 1 && eq(g[0].ok, p), 'bit stuffing survives a payload full of ones'); }
  { const p = bytes('\x03\x73\x7e\x7e\x7e ends with flags \x7e'); ok(eq(roundTrip(p, FCS16)[0].ok, p), 'a payload containing the flag pattern survives'); }
  { const e = new Encoder(FCS16); e.frame(new Array(16).fill(0xff)); const b = drain(e).slice(8, -8);
    let run = 0, worst = 0; for (const x of b) { run = x ? run + 1 : 0; worst = Math.max(worst, run); }
    ok(worst < 6, 'the encoder never emits six contiguous ones inside a frame'); }
  { const e = new Encoder(FCS16); for (const s of ['\x03\x73one', '\x03\x73two', '\x03\x73three']) e.frame(bytes(s));
    const g = feedAll(new Decoder(FCS16), drain(e)).filter((r) => r.ok).map((r) => r.ok);
    ok(g.length === 3 && eq(g[2], bytes('\x03\x73three')), 'several frames in one stream'); }
  { const e = new Encoder(FCS16); e.idle(6); e.frame(bytes('\x03\x73payload')); e.idle(6);
    const r = feedAll(new Decoder(FCS16), drain(e)); ok(r.length === 1 && eq(r[0].ok, bytes('\x03\x73payload')), 'interframe flags are not mistaken for frames'); }
  { const e = new Encoder(FCS16); e.frame(bytes('\x03\x73corrupt me')); const b = drain(e); b[40] ^= 1;
    const r = feedAll(new Decoder(FCS16), b); ok(r.length === 1 && r[0].err === FrameError.BadFcs, 'a corrupted frame is rejected'); }
  { const e = new Encoder(FCS16); e.idle(1); const b = drain(e).concat(new Array(16).fill(0), new Array(8).fill(1));
    const r = feedAll(new Decoder(FCS16), b); ok(r.length === 1 && r[0].err === FrameError.Aborted, 'an abort discards the partial frame'); }
  { const e = new Encoder(FCS16); e.frame(bytes('\x03\x73damaged')); const b = drain(e); b[40] ^= 1;
    const all = b.concat(raw([0x41, 0x42]), new Array(8).fill(1)); const d = new Decoder(FCS16); const seen = [];
    for (const x of all) { const r = d.feed(x); if (r) seen.push([r, d.discarded().slice()]); }
    ok(seen.length === 2 && seen[0][0].err === FrameError.BadFcs && seen[0][1].length === 11 && seen[1][0].err === FrameError.Aborted && eq(seen[1][1], [0x41, 0x42]),
       'an abort reports its own octets rather than the last bad frame\'s'); }
  { const all = raw([FLAG]).concat(raw([0x41, 0xe1]), new Array(8).fill(1)); const d = new Decoder(FCS16); const seen = [];
    for (const x of all) { const r = d.feed(x); if (r) seen.push([r, d.discarded().slice()]); }
    ok(seen.length === 1 && seen[0][0].err === FrameError.Aborted && eq(seen[0][1], [0x41, 0xe1]), 'an abort keeps the octets its own ones ran into'); }
  { const all = raw([FLAG]).concat([0, 1, 0], new Array(8).fill(1)); const d = new Decoder(FCS16); const seen = [];
    for (const x of all) { const r = d.feed(x); if (r) seen.push([r, d.discarded().slice()]); }
    ok(seen.length === 1 && seen[0][0].err === FrameError.Aborted && seen[0][1].length === 0, 'an abort before the first whole octet is still an abort'); }
  ok(feedAll(new Decoder(FCS16), raw([FLAG]).concat(new Array(64).fill(1))).length === 0, 'a flag followed by a line gone to marks aborts nothing');
  { const r = roundTrip([], FCS16); ok(r.length === 1 && r[0].err === FrameError.TooShort, 'a runt frame is rejected'); }
  { const e = new Encoder(FCS16); e.frame(new Array(64).fill(0x55)); const r = feedAll(new Decoder(FCS16).withMaxOctets(32), drain(e));
    ok(r.length === 1 && r[0].err === FrameError.TooLong, 'an over-long frame is rejected'); }
  { const e = new Encoder(FCS16); e.frame(bytes('\x03\x73found me')); const b = [1, 0, 1, 1, 0, 0, 1, 0, 1].concat(drain(e));
    const g = feedAll(new Decoder(FCS16), b).filter((r) => r.ok); ok(g.length === 1 && eq(g[0].ok, bytes('\x03\x73found me')), 'the decoder syncs mid-stream'); }
  { const a = H.appendFcs(bytes('\x03\x73aa'), FCS16), b = H.appendFcs(bytes('\x03\x73bb'), FCS16);
    const body = (o) => { const out = []; let ones = 0; for (const byte of o) for (let i = 0; i < 8; i++) { const x = (byte >> i) & 1; out.push(x); if (x) { if (++ones === 5) { out.push(0); ones = 0; } } else ones = 0; } return out; };
    const all = raw([FLAG]).concat(body(a), raw([FLAG]), body(b), raw([FLAG]));
    const g = feedAll(new Decoder(FCS16), all).filter((r) => r.ok).map((r) => r.ok);
    ok(g.length === 2 && eq(g[0], bytes('\x03\x73aa')) && eq(g[1], bytes('\x03\x73bb')), 'a shared flag delimits both neighbours'); }
  { let all = true; for (let n = 0; n < 64; n++) { const full = [0x03, 0x73].concat(Array.from({ length: n }, (_, i) => (i * 31 + 7) & 0xff));
      const g = roundTrip(full, FCS16); if (!(g.length === 1 && eq(g[0].ok, full))) all = false; }
    ok(all, 'every payload length round-trips'); }
});

section('frame', () => {
  const F = require(path.join(EC, 'Frame'));
  const { ORIGINATOR: O, ANSWERER: A, COMMAND: C, RESPONSE: R, DLCI_DATA } = F;
  const enc = (f, sender, kind) => F.encodeFrame(f, DLCI_DATA, sender, kind);
  ok(F.encodeAddress(0, C, O) === 0x03 && F.encodeAddress(0, C, A) === 0x01 && F.encodeAddress(0, R, O) === 0x01 && F.encodeAddress(0, R, A) === 0x03,
     'address encodes DLCI, C/R and EA');
  ok(F.decodeAddress(0x01, O).ok.kind === C && F.decodeAddress(0x01, A).ok.kind === R, 'the same octet means opposite things at each end');
  { const a = F.decodeFrame([0x03, 0x73], O).ok, b = F.decodeFrame([0x01, 0x01, 0x01], O).ok;
    ok(a.address.kind === R && eq(a.frame, { type: 'UA', final: true }) && b.address.kind === C && eq(b.frame, { type: 'RR', nr: 0, pf: true }),
       'a real answering modem addressed it this way'); }
  { let all = true; for (const s of [O, A]) for (const k of [C, R]) { const back = F.decodeAddress(F.encodeAddress(0, k, s), F.peerOf(s)).ok; if (!(back.dlci === 0 && back.kind === k)) all = false; }
    ok(all, 'address round-trips for both roles'); }
  ok(F.decodeAddress(0x00, O).err === 'ExtendedAddress', 'a clear extension bit is rejected');
  { const cases = [[{ type: 'SABME', poll: false }, 0x6f], [{ type: 'DISC', poll: false }, 0x43], [{ type: 'UA', final: false }, 0x63],
      [{ type: 'DM', final: false }, 0x0f], [{ type: 'UI', pf: false, info: [] }, 0x03], [{ type: 'XID', pf: false, info: [] }, 0xaf]];
    ok(cases.every(([f, w]) => enc(f, O, C)[1] === w) && enc({ type: 'FRMR', final: false, info: [] }, O, R)[1] === 0x87 && enc({ type: 'TEST', pf: false, info: [] }, O, C)[1] === 0xe3,
       'unnumbered encodings match Table 8'); }
  ok(enc({ type: 'SABME', poll: true }, O, C)[1] === 0x7f && enc({ type: 'UA', final: true }, A, R)[1] === 0x73, 'the poll bit sits in bit five');
  ok([[{ type: 'RR', nr: 0, pf: false }, 1], [{ type: 'RNR', nr: 0, pf: false }, 5], [{ type: 'REJ', nr: 0, pf: false }, 9], [{ type: 'SREJ', nr: 0 }, 0x0d]]
     .every(([f, w]) => { const b = enc(f, O, C); return b[1] === w && b.length === 3; }), 'supervisory encodings match Table 8');
  { const b = enc({ type: 'RR', nr: 127, pf: true }, O, C); ok(b[2] === 0xff && eq(F.decodeFrame(b, A).ok.frame, { type: 'RR', nr: 127, pf: true }), 'sequence numbers occupy seven bits'); }
  { const f = { type: 'I', ns: 5, nr: 9, poll: false, info: bytes('payload') }; const b = enc(f, O, C);
    ok((b[1] & 1) === 0 && b[1] >> 1 === 5 && b[2] >> 1 === 9 && eq(F.decodeFrame(b, A).ok.frame, f), 'information frames carry both sequence numbers'); }
  { const frames = [{ type: 'I', ns: 0, nr: 0, poll: false, info: [] }, { type: 'I', ns: 127, nr: 126, poll: true, info: bytes('data') },
      { type: 'RR', nr: 3, pf: true }, { type: 'RNR', nr: 4, pf: false }, { type: 'REJ', nr: 5, pf: true }, { type: 'SREJ', nr: 6 },
      { type: 'SABME', poll: true }, { type: 'DISC', poll: true }, { type: 'UA', final: true }, { type: 'DM', final: false },
      { type: 'FRMR', final: true, info: [1, 2, 3, 4, 5] }, { type: 'UI', pf: false, info: bytes('note') },
      { type: 'XID', pf: true, info: bytes('params') }, { type: 'TEST', pf: false, info: bytes('loop') }];
    ok(frames.every((f) => eq(F.decodeFrame(enc(f, O, C), A).ok.frame, f)), 'every frame type round-trips'); }
  ok((enc({ type: 'SREJ', nr: 7 }, O, C)[2] & 1) === 0, 'SREJ never sets the poll bit');
  ok(F.decodeFrame([0x01, 0x6f, 0xaa], A).err === 'UnexpectedInfo', 'frames that forbid an information field are rejected');
  ok(F.decodeFrame([0x01, 0x01, 0x00, 0xaa], A).err === 'UnexpectedInfo', 'supervisory frames reject an information field');
  ok(F.decodeFrame([0x01, 0x1b], A).err === 'UndefinedControl', 'undefined control fields are reported');
  ok(F.decodeFrame([], A).err === 'Truncated' && F.decodeFrame([1], A).err === 'Truncated' && F.decodeFrame([1, 0], A).err === 'Truncated', 'truncated frames are rejected');
});

section('v42bis-dictionary', () => {
  const V = require(path.join(EC, 'V42bisDictionary'));
  const { Dictionary, Params, N5 } = V;
  const A = (c) => c.charCodeAt(0);
  ok(Dictionary.rootCode(0) === 3 && Dictionary.rootCode(65) === 68 && Dictionary.rootCode(255) === 258 && N5 === 259, 'root codewords follow the Recommendation');
  { const d = new Dictionary(new Params()); let all = true; for (let c = 0; c < 256; c++) if (!d.inUse(Dictionary.rootCode(c)) || d.depth(Dictionary.rootCode(c)) !== 1) all = false;
    ok(all && !d.inUse(N5), 'a fresh dictionary holds only roots'); }
  { const d = new Dictionary(new Params()); const b = Dictionary.rootCode(A('B')); const ba = d.add(b, A('A')); const bag = d.add(ba, A('G'));
    ok(eq(d.string(b), bytes('B')) && eq(d.string(ba), bytes('BA')) && eq(d.string(bag), bytes('BAG')) && d.firstChar(bag) === A('B'), 'strings reconstruct from their codeword'); }
  { const d = new Dictionary(new Params()); const b = Dictionary.rootCode(A('B')); const first = d.add(b, A('A'));
    ok(d.add(b, A('A')) === null && d.findChild(b, A('A')) === first, 'a duplicate string is not added twice'); }
  { const d = new Dictionary(new Params(512, 6)); let code = Dictionary.rootCode(A('a')), good = true;
    for (let i = 1; i < 6; i++) { code = d.add(code, A('a') + i); if (code === null || d.depth(code) !== i + 1) good = false; }
    ok(good && d.depth(code) === 6 && d.add(code, A('z')) === null, 'the maximum string length is enforced'); }
  { const p = new Params(512, 250); const d = new Dictionary(p); let added = 0;
    outer: for (let a = 0; a < 256; a++) for (let b = 0; b < 256; b++) { if (d.add(Dictionary.rootCode(a), b) !== null) added++; if (added > 2000) break outer; }
    let consistent = true; for (let c = N5; c < p.n2; c++) if (d.inUse(c)) { const s = d.string(c); if (!s.length || s.length !== d.depth(c)) consistent = false; }
    ok(added > 512 && consistent, 'recovery reuses entries once the dictionary fills'); }
  { const p = new Params(512, 250); const d = new Dictionary(p); for (let a = 0; a < 256; a++) for (let b = 0; b < 4; b++) d.add(Dictionary.rootCode(a), b);
    let good = true; for (let c = N5; c < p.n2; c++) if (d.inUse(c) && d.parent[c] >= 0 && !d.inUse(d.parent[c])) good = false;
    ok(good, 'a parent is never recovered before its children'); }
  ok(new Params(512, 6).maxCodeBits() === 9 && new Params(1024, 6).maxCodeBits() === 10 && new Params(2048, 6).maxCodeBits() === 11 && new Params(4096, 6).maxCodeBits() === 12,
     'maximum codeword size covers the dictionary');
  ok(new Params(511, 6).validate() && new Params(512, 5).validate() && new Params(512, 251).validate() && new Params().validate() === null, 'out-of-range parameters are refused');
});

function xorshift(seed) { let x = seed >>> 0; return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; }; }
const cycle = (s, n) => { const b = typeof s === 'string' ? bytes(s) : s; return Array.from({ length: n }, (_, i) => b[i % b.length]); };

section('v42bis', () => {
  const V = require(path.join(EC, 'V42bis'));
  const P = (n2, n7) => new V.Params(n2, n7);
  const rt = (input, params = P()) => { const e = new V.Encoder(params), w = []; e.encode(input, w); e.flush(w); const d = new V.Decoder(params), o = []; d.decode(w, o); return o; };
  const size = (input) => { const e = new V.Encoder(P()), w = []; e.encode(input, w); e.flush(w); return w.length; };
  ok(eq(rt(bytes('Welcome to the board.')), bytes('Welcome to the board.')), 'short text round-trips');
  { const all = Array.from({ length: 256 }, (_, i) => i); ok(eq(rt(all), all), 'every byte value round-trips'); }
  ok(rt([]).length === 0, 'an empty input produces nothing');
  { const data = [0]; let esc = 0; for (let k = 0; k < 40; k++) { esc = (esc + 51) & 0xff; data.push(esc, ...bytes('filler')); }
    ok(eq(rt(data), data), 'the escape character in data round-trips'); }
  { const input = cycle('ABCABCABCABC', 20000); ok(eq(rt(input), input) && size(input) < input.length / 2, 'repetitive data round-trips and compresses'); }
  { const input = cycle('The quick brown fox jumps over the lazy dog. ', 30000); ok(eq(rt(input), input) && size(input) < input.length / 3, 'English-like text round-trips and compresses'); }
  { const input = Array.from({ length: 20000 }, (_, i) => (Math.imul(i, 2654435761) >>> 13) & 0xff);
    ok(eq(rt(input), input) && size(input) < input.length * 11 / 10, 'incompressible data does not expand much'); }
  { const e = new V.Encoder(P()); e.encode(cycle('abcabcabc', 10000), []); ok(e.mode() === V.COMPRESSED, 'the encoder reaches compressed mode on compressible data'); }
  { const input = Array.from({ length: 40000 }, (_, i) => i % 97); ok(eq(rt(input, P(2048, 32)), input), 'the codeword size grows and the decoder follows'); }
  { const input = cycle('the same data, arriving in pieces. ', 9000); const e = new V.Encoder(P()), w = [];
    for (let i = 0; i < input.length; i += 7) e.encode(input.slice(i, i + 7), w); e.flush(w);
    const d = new V.Decoder(P()), o = []; for (let i = 0; i < w.length; i += 5) d.decode(w.slice(i, i + 5), o);
    ok(eq(o, input), 'data split across calls decodes the same'); }
  { const e = new V.Encoder(P()), d = new V.Decoder(P()); const next = xorshift(0x12345678); const plain = [];
    for (let r = 0; r < 60; r++) { for (let i = 0; i < 40; i++) plain.push(...bytes(`GET /page/${i} HTTP/1.1\r\nHost: example.invalid\r\n\r\n`)); for (let k = 0; k < 600; k++) plain.push(next() & 0xff); }
    const back = []; let at = 0, good = true;
    try { while (at < plain.length) { const take = 1 + (next() % 900); const end = Math.min(at + take, plain.length); const out = []; e.encode(plain.slice(at, end), out); e.flush(out); d.decode(out, back); at = end; } }
    catch (x) { good = false; }
    ok(good && eq(back, plain), 'chunked traffic that changes its mind stays in step'); }
  { const e = new V.Encoder(P()), d = new V.Decoder(P()), w = [], o = []; const first = cycle('first stretch of data ', 5000);
    e.encode(first, w); e.flush(w); e.reset(w); const second = bytes('after the reset'); e.encode(second, w); e.flush(w); d.decode(w, o);
    ok(d.mode() === V.TRANSPARENT && eq(o, first.concat(second)), 'a reset returns both ends to the initial state'); }
  { const input = new Array(10000).fill(0x7a); ok(eq(rt(input), input), 'a long run of one byte round-trips'); }
  ok([512, 1024, 2048, 4096].every((n2) => { const input = cycle('mixed content 12345 ', 25000); return eq(rt(input, P(n2, 16)), input); }), 'larger dictionaries round-trip');
  { let kind = null; try { new V.Decoder(P()).decode([0, 200], []); } catch (x) { kind = x.kind + ':' + x.detail; } ok(kind === 'ReservedCommand:200', 'a reserved command code is reported'); }
  { const FROM_THE_LINE = [0x0d,0x41,0x72,0x6d,0x62,0x69,0x61,0x6e,0x20,0x32,0x33,0x2e,0x35,0x2e,0x31,0x20,0x42,0x6f,0x6f,0x6b,0x77,0x6f,0x72,0x6d,0x20,0x6c,0x20,0x0a,0x0d,0x0a,0x0d,0x2a,0x2a,0x45,0x4d,0x53,0x49,0x5f,0x52,0x45,0x51,0x41,0x37,0x37,0x45,0x0d,0x11,0x20,0x20,0x20,0x20,0x20,0x20,0x20,0x20,0x20,0x20,0x20,0x20,0x20,0x20,0x0d,0x0d,0x0a,0x00,0x00,0x5a,0xd0,0xbc,0x31,0x23,0x07,0x0e,0x9a,0x11,0x77,0xe4,0x8c,0x38,0x83,0xf0,0x0d,0x9e,0x39,0x31,0x2e,0xd6,0x79,0x13,0x00,0x67,0x48,0x8c,0xf0,0xc8,0x24,0xcd,0x08,0x3e,0x72,0xf0,0x8c,0x20,0x53,0x87,0x67,0x1c,0x39,0x77,0x46,0xac,0x41,0x63,0x75,0x44,0x1a,0x8c,0x23,0xd8,0xc4,0xb9,0xd3,0x35,0x0e,0x1a,0xad,0x64,0xcc,0x98,0x41,0x63,0xc7,0xce,0x8b,0x9e,0x75,0xf8,0xf4,0x18,0xe1,0x65,0xce,0x1a,0xab,0x64,0xdc,0x80,0xa9,0x0b,0xb6,0x4f,0x9f,0x00,0x7c,0xbd,0xf4,0xc1,0xb8,0xb7,0xef,0x58,0x32,0x6f,0x06,0x9f,0x0d,0x6c,0xd5,0x0c,0x19,0x38,0x73,0xf8,0x86,0xf5,0x62,0x07,0x0e,0x9b,0x3a,0x69,0xc0,0x78,0x7c,0x23,0x47,0xcd,0xd8,0x1e,0x1e,0x07,0x16,0x3c,0x98,0x70,0x61,0xc3,0x87,0x11,0x27,0x56,0x3c,0x0a,0x47,0x23,0xc7,0xd0,0x20,0x45,0x92,0x34,0x89,0x52,0x25,0x4b,0x97,0x32,0x65,0xe6,0x66,0x5a,0xf3,0x66,0xce,0x9d,0x3d,0x7f,0x06,0x0d,0x00,0x88,0x89,0x1a,0xc5,0x98,0x74,0x69,0xd3,0xa7,0x51,0xa7,0x56,0xbd,0x9a,0x75,0x6b,0x57,0x9e,0x60,0xeb,0x88,0x25,0x6b,0x16,0x2d,0xd5,0xb5,0x6d,0xdf,0xc6]; const d = new V.Decoder(P(2048, 250)), o = []; let text = '';
    try { d.decode(FROM_THE_LINE, o); text = Buffer.from(o).toString('latin1'); } catch (x) { text = 'threw ' + x.message; }
    ok(text.includes('Welcome to dialup.world!') && text.includes('If you are not here for internet access'), `a real encoder's stream decodes to what it said — ${JSON.stringify(text.slice(0, 80))}`); }
  { const e = new V.Encoder(P()), d = new V.Decoder(P()); const rand = xorshift(0x12345678); const sent = [], got = []; let good = true;
    for (let burst = 0; burst < 200; burst++) { const chunk = []; if (burst % 3 === 0) chunk.push(...bytes('GET /index.html HTTP/1.1\r\nHost: example\r\n\r\n'));
      const n = (rand() % 400) + 1; for (let k = 0; k < n; k++) chunk.push((rand() >>> 11) & 0xff);
      const w = []; e.encode(chunk, w); try { d.decode(w, got); } catch (x) { good = false; } sent.push(...chunk); }
    ok(good && eq(got, sent), 'high-entropy traffic survives the round trip'); }
});

section('v42bis-real', () => {
  // 1957 octets a real modem sent (BinModem's tests/vectors, off a call to
  // dialup.world): it answered no XID, announced compression in band, and crosses
  // modes about every hundred octets, so 7.8.1 a) and 7.8.2 b) run a dozen times.
  const fs = require('fs');
  const V = require(path.join(EC, 'V42bis'));
  const WIRE = Array.from(fs.readFileSync(path.join(__dirname, 'vectors', 'dialup-world.v42bis')));
  const PLAIN = fs.readFileSync(path.join(__dirname, 'vectors', 'dialup-world.txt')).toString('latin1');
  const offered = () => new V.Params(V.OFFERED_N2, V.OFFERED_N7);
  const d = new V.Decoder(offered()), o = []; d.decode(WIRE, o); const text = Buffer.from(o).toString('latin1');
  ok(text === PLAIN, 'a board that never answered XID still reads back exactly');
  ok(['Character set [ASCII]:', 'Running on an IWill KK266Plus KT133A', 'FozzTexx in Objective-C. The computer',
      'has no hard drive and boots using PXE', 'You are caller #137 for 07 Sep 2026', '-- Press a key --'].every((p) => text.includes(p)),
     'the words that used to come apart');
  const p = new V.Decoder(offered()), o2 = []; for (const b of WIRE) p.decode([b], o2);
  ok(eq(o2, o), 'arriving in pieces decodes the same');
});

section('v44-length', () => {
  const V = require(path.join(EC, 'V44'));
  const { BitWriter, BitReader } = require(path.join(EC, 'Bits'));
  const tx = (len, n7) => { const w = new BitWriter(), out = []; V.writeLength(len, n7, w, out); const pend = w.pending(); w.align(out);
    const total = out.length * 8 - (pend === 0 ? 0 : 8 - pend); let s = ''; for (let i = 0; i < total; i++) s += (out[i >> 3] >> (i % 8)) & 1; return s; };
  const rows = [[1, '1'], [2, '010'], [3, '001'], [4, '011'], [5, '0000000'], [6, '0000100'], [7, '0000010'], [8, '0000110'], [9, '0000001'], [10, '0000101'], [11, '0000011'], [12, '0000111']];
  ok(rows.every(([l, e]) => tx(l, 255) === e), 'lengths one to twelve are the bits Table 3 prints');
  ok(tx(13, 46) === '000100000' && tx(44, 46) === '000111111' && tx(13, 255) === '000100000000' && tx(253, 255) === '000100001111' && tx(13, 78).length === 10 && tx(13, 142).length === 11,
     'longer extensions carry the length less thirteen');
  { let all = true; for (const n7 of [32, 46, 47, 78, 79, 142, 143, 255]) for (let l = 1; l <= V.lengthMostFor(n7); l++) {
      const w = new BitWriter(), out = []; V.writeLength(l, n7, w, out); w.align(out); const r = new BitReader(); out.forEach((b) => r.pushOctet(b)); if (V.readLength(r, n7) !== l) all = false; }
    ok(all, 'every length round-trips at every width'); }
  ok(V.lengthMostFor(255) === 253 && V.lengthMostFor(32) === 30 && V.lengthMostFor(46) === 44 && V.lengthMostFor(47) === 45, 'the longest extension is two short of the longest string');
  { const w = new BitWriter(), out = []; V.writeLength(200, 255, w, out); w.align(out); const r = new BitReader(); r.pushOctet(out[0]); const half = V.readLength(r, 255); r.pushOctet(out[1]);
    ok(out.length === 2 && half === null && V.readLength(r, 255) === 200, 'a length that has not all arrived is not taken'); }
});

section('v44', () => {
  const V = require(path.join(EC, 'V44'));
  const { Encoder } = require(path.join(EC, 'V44Encoder'));
  const { Decoder } = require(path.join(EC, 'V44Decoder'));
  const { BitWriter } = require(path.join(EC, 'Bits'));
  const P = () => new V.Params();
  const rt = (input, params = P()) => { const e = new Encoder(params), w = []; e.encode(input, w); e.flush(w); const d = new Decoder(params), o = []; d.decode(w, o); return o; };
  const size = (input) => { const e = new Encoder(P()), w = []; e.encode(input, w); e.flush(w); return w.length; };
  const safe = (f) => { try { return f(); } catch (x) { return 'threw ' + x.message; } };
  ok(V.Params.of(256, 255).maxCodeBits() === 8 && V.Params.of(1024, 255).maxCodeBits() === 10 && V.Params.of(2048, 255).maxCodeBits() === 11 && V.Params.of(65535, 255).maxCodeBits() === 16 && V.Params.of(256, 32).maxCodeBits() === 8,
     'the codeword size is derived from the number of codewords');
  { const a = new V.Params(2048, 255, 6144).resolve(new V.Params(1024, 64, 8192)); ok(a.equals(new V.Params(1024, 64, 6144)) && a.valid(), 'negotiation takes the lower of each'); }
  ok(V.Params.of(256, 32).valid() && !new V.Params(255, 32, 765).valid() && !new V.Params(1024, 31, 3072).valid() && !new V.Params(1024, 32, 511).valid(), 'a proposal below the minimum is not valid');
  { const p = P(); ok(p.n2 === 1024 && p.n7 === 255 && p.n8 === 3072, 'the defaults are the document\'s own'); }
  ok(V.N5 === 4 && V.control.ETM === 0 && V.control.FLUSH === 1 && V.control.STEPUP === 2 && V.control.REINIT === 3, 'the control codes sit below the first codeword');
  ok(eq(safe(() => rt(bytes('Welcome to the board.'))), bytes('Welcome to the board.')), 'short text round-trips');
  { const all = Array.from({ length: 256 }, (_, i) => i); ok(eq(safe(() => rt(all)), all), 'every byte value round-trips'); }
  ok(eq(rt(bytes('x')), bytes('x')) && rt([]).length === 0, 'a single character round-trips');
  { const t = bytes('ABCDEXABCDEYABCDE\xffAC'); ok(eq(safe(() => rt(t)), t), 'the document\'s example string round-trips (II.1)'); }
  { const t = bytes('CCCCCCCCCCX'); const long = new Array(4000).fill(0x43).concat([0x58]); ok(eq(safe(() => rt(t)), t) && eq(safe(() => rt(long)), long), 'a run of one character round-trips (II.2)'); }
  { const t = cycle('the same line over and over\r\n', 20000); ok(eq(safe(() => rt(t)), t) && size(t) * 20 < t.length, `repetitive data round-trips and compresses (${size(t)})`); }
  { const t = cycle('It is a truth universally acknowledged, that a single man in possession of a good fortune, must be in want of a wife. However little known the feelings or views of such a man may be on his first entering a neighbourhood, this truth is so well fixed in the minds of the surrounding families. ', 40000);
    ok(eq(safe(() => rt(t)), t) && size(t) * 4 < t.length, `English-like text round-trips and compresses (${size(t)})`); }
  { const nx = xorshift(0x12345678); const noise = Array.from({ length: 20000 }, () => nx() & 0xff); ok(eq(safe(() => rt(noise)), noise), 'incompressible data round-trips'); }
  { const params = V.Params.of(512, 64); const e = new Encoder(params), d = new Decoder(params); const nx = xorshift(0x2545f491); const plain = [];
    for (let r = 0; r < 80; r++) { for (let i = 0; i < 20; i++) plain.push(...bytes(`GET /page/${i} HTTP/1.1\r\n`)); for (let k = 0; k < 200; k++) plain.push(nx() & 0xff); }
    const back = []; let at = 0; const err = safe(() => { while (at < plain.length) { const take = 1 + (nx() % 700); const end = Math.min(at + take, plain.length); const w = []; e.encode(plain.slice(at, end), w); e.flush(w); d.decode(w, back); at = end; } return null; });
    ok(err === null && eq(back, plain), `chunked traffic survives a full dictionary ${err || ''}`); }
  { const t = cycle('abcdefghij', 30000); ok(eq(safe(() => rt(t, new V.Params(256, 32, 512))), t), 'a dictionary that fills starts again without losing anything'); }
  { const t = []; for (let i = 0; i < 3000; i++) t.push(...bytes(String(i).padStart(5, '0') + '-')); ok(eq(safe(() => rt(t)), t), 'the codeword size grows and the decoder follows'); }
  { const t = cycle('a longer phrase repeated so that strings are found and extended, ', 9000); let all = true;
    for (const n2 of [256, 512, 1024, 2048, 8192]) for (const n7 of [32, 46, 47, 78, 142, 255]) if (!eq(safe(() => rt(t, V.Params.of(n2, n7))), t)) all = false;
    ok(all, 'the negotiable parameters all work'); }
  { const t = new Array(5000).fill(0x7a); ok(eq(safe(() => rt(t, V.Params.of(1024, 32))), t), 'a string stops at the agreed maximum length'); }
  { const e = new Encoder(P()), d = new Decoder(P()); const t = cycle('login: cactus\r\npassword: \r\nWelcome back.\r\n', 4000); const back = [];
    const err = safe(() => { for (const b of t) { const w = []; e.encode([b], w); e.flush(w); d.decode(w, back); } return null; });
    ok(err === null && eq(back, t), 'compression survives being handed data a byte at a time'); }
  { const e = new Encoder(P()), d = new Decoder(P()); let w = []; const back = [];
    e.encode(bytes('some ordinary text to begin with, ordinary text'), w); e.flush(w); d.decode(w, back);
    w = []; e.enterTransparentNow(w); const m1 = e.mode(); e.encode(bytes('straight through'), w); e.flush(w); d.decode(w, back); const m2 = d.mode();
    w = []; e.enterCompressed(w); e.encode(bytes('and compressed once more, compressed once more'), w); e.flush(w); d.decode(w, back);
    ok(m1 === V.TRANSPARENT && m2 === V.TRANSPARENT && d.mode() === V.COMPRESSED &&
       eq(back, bytes('some ordinary text to begin with, ordinary textstraight throughand compressed once more, compressed once more')),
       'transparent mode carries characters and restarts the dictionary'); }
  { const e = new Encoder(P()), d = new Decoder(P()), w = []; e.enterTransparentNow(w); const t = [0, 0, 51, 0, 102, 51, 7]; e.encode(t, w); e.flush(w); const back = []; d.decode(w, back);
    ok(eq(back, t), 'an escape in transparent data is announced and moves on'); }
  { const params = P(); const etm = (() => { const e = new Encoder(params), w = []; e.enterTransparentNow(w); return w; })();
    const stream = etm.concat([0x00, V.command.EID], [0x33, V.command.ECM], etm, [0x33, V.command.EID, 0x00, 0x62]);
    const d = new Decoder(params), out = []; const err = safe(() => { d.decode(stream, out); return null; });
    const e = new Encoder(params), w = []; e.enterTransparentNow(w); let mark = w.length; e.encode([0x00], w); e.enterCompressed(w); const a = w.slice(mark);
    e.enterTransparentNow(w); mark = w.length; e.encode([0x33, 0x00, 0x62], w); e.flush(w); const b = w.slice(mark);
    ok(err === null && eq(out, [0x00, 0x33, 0x00, 0x62]) && eq(a, [0x00, V.command.EID, 0x33, V.command.ECM]) && eq(b, [0x33, V.command.EID, 0x00, 0x62]),
       'the escape is not set back by entering compressed mode'); }
  { const d = new Decoder(P()); const bw = new BitWriter(), w = []; bw.write(1, 1, w); bw.write(60, 6, w); bw.align(w);
    let got = null; try { d.decode(w, []); } catch (x) { got = x.kind + ':' + x.detail; } ok(got === 'UnknownCodeword:60', 'a codeword nothing has created is refused'); }
  { const VB = require(path.join(EC, 'V42bis')); const t = cycle('The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs. How vexingly quick daft zebras jump! ', 60000);
    const v44 = size(t); const e = new VB.Encoder(new VB.Params()), old = []; e.encode(t, old); e.flush(old);
    ok(v44 < old.length, `it beats V.42bis on text — 60000 octets: V.42bis ${old.length}, V.44 ${v44}`); }
});

section('lapm', () => {
  const L = require(path.join(EC, 'Lapm'));
  const { ORIGINATOR: O, ANSWERER: A, COMMAND: C, RESPONSE: R, DLCI_DATA } = require(path.join(EC, 'Frame'));
  const mk = (role, o) => new L.Lapm(role, DLCI_DATA, new L.Params(o));
  const pair = (o) => [mk(O, o), mk(A, o)];
  const deliver = (from, to) => { let n = 0, x; while ((x = from.pollTransmit())) { to.receive(x[0], x[1]); n++; } return n; };
  const settle = (a, b) => { for (let k = 0; k < 64; k++) if (deliver(a, b) + deliver(b, a) === 0) return true; return false; };
  const events = (l) => { const v = []; let e; while ((e = l.pollEvent())) v.push(e); return v; };
  const dataFrom = (l) => events(l).filter((e) => e.type === 'Data').flatMap((e) => e.data);
  const has = (evs, t, cause) => evs.some((e) => e.type === t && (cause === undefined || e.cause === cause));
  const deliverLosing = (from, to, lose) => { const sent = []; let x; while ((x = from.pollTransmit())) { if (x[0].type === 'I') { sent.push(x[0].ns); if (x[0].ns === lose) continue; } to.receive(x[0], x[1]); } return sent; };
  const connected = (srej) => { const [a, b] = pair(); a.setSelectiveReject(srej); b.setSelectiveReject(srej); a.connect(); settle(a, b); return [a, b]; };
  const recover = (srej) => { const [a, b] = connected(srej); for (let i = 0; i < 5; i++) a.sendData([0x61 + i]); deliverLosing(a, b, 2); deliver(b, a); const again = deliverLosing(a, b, null); settle(a, b); return [again, dataFrom(b)]; };
  { const [again, data] = recover(false); ok(eq(again, [2, 3, 4]) && eq(data, bytes('abcde')), 'a reject asks for the lost frame and everything after it'); }
  { const [again, data] = recover(true); ok(eq(again, [2]) && eq(data, bytes('abcde')), 'a selective reject asks for the lost frame and no others'); }
  { const [a, b] = connected(true); for (let i = 0; i < 4; i++) a.sendData([0x61 + i]); deliverLosing(a, b, 1); deliver(b, a); ok(a.va === 1, 'a selective reject does not acknowledge anything'); }
  { const [a, b] = connected(true); for (let i = 0; i < 4; i++) a.sendData([0x61 + i]); deliverLosing(a, b, 0); const early = dataFrom(b); deliver(b, a); deliverLosing(a, b, null);
    ok(early.length === 0 && eq(dataFrom(b), bytes('abcd')), 'frames held behind a gap are not delivered early'); }
  ok(L.inWindow(0, 0, 0) && L.inWindow(0, 3, 5) && !L.inWindow(0, 6, 5) && L.inWindow(126, 1, 3) && !L.inWindow(126, 4, 3) && L.outstanding(126, 2) === 4, 'window arithmetic wraps at the modulus');
  { const [a, b] = pair(); a.connect(); settle(a, b); ok(a.isConnected() && b.isConnected() && has(events(a), 'Connected') && has(events(b), 'Connected'), 'SABME and UA establish a connection'); }
  { const [a, b] = pair(); a.connect(); settle(a, b); events(b); a.sendData(bytes('the quick brown fox')); settle(a, b); ok(eq(dataFrom(b), bytes('the quick brown fox')), 'data crosses in order'); }
  { const [a, b] = pair(); a.connect(); settle(a, b); events(a); events(b); a.sendData(bytes('from a')); b.sendData(bytes('from b')); settle(a, b);
    ok(eq(dataFrom(b), bytes('from a')) && eq(dataFrom(a), bytes('from b')), 'data flows in both directions'); }
  { const [a, b] = pair(); a.connect(); settle(a, b); events(b); const p = Array.from({ length: 1000 }, (_, i) => i % 251); a.sendData(p); settle(a, b); ok(eq(dataFrom(b), p), 'long data is split to N401 and reassembles'); }
  { const [a, b] = pair({ k: 3, n401: 1 }); a.connect(); settle(a, b); a.sendData(bytes('abcdefgh')); let sent = 0, x; while ((x = a.pollTransmit())) if (x[0].type === 'I') sent++;
    ok(sent === 3, 'the window limits frames in flight'); }
  { const [a, b] = pair({ n401: 1 }); a.connect(); settle(a, b); events(b); a.sendData(bytes('abcde')); let idx = 0, x;
    while ((x = a.pollTransmit())) { if (x[0].type === 'I' && ++idx === 2) continue; b.receive(x[0], x[1]); } settle(a, b);
    ok(eq(dataFrom(b), bytes('abcde')), 'a lost frame is recovered by reject'); }
  { const [a, b] = pair(); a.connect(); settle(a, b); a.receive({ type: 'RNR', nr: 0, pf: false }, C); a.sendData(bytes('blocked')); let i = 0, x; while ((x = a.pollTransmit())) if (x[0].type === 'I') i++;
    a.receive({ type: 'RR', nr: 0, pf: false }, C); settle(a, b); ok(i === 0 && dataFrom(b).length > 0, 'receive-not-ready stops the sender'); }
  { const [a, b] = pair(); a.connect(); settle(a, b); events(a); events(b); a.disconnect(); settle(a, b);
    ok(a.state() === L.State.Disconnected && b.state() === L.State.Disconnected && has(events(a), 'Released', L.Cause.Local) && has(events(b), 'Released', L.Cause.Peer), 'disconnect is confirmed by the peer'); }
  { const a = mk(A); a.receive({ type: 'DISC', poll: true }, C); const x = a.pollTransmit(); ok(x && eq(x[0], { type: 'DM', final: true }) && x[1] === R, 'DISC while disconnected is answered with DM'); }
  { const a = mk(O, { n400: 3, t401Ms: 1000 }); a.connect(); let sabmes = 0, x; while ((x = a.pollTransmit())) if (x[0].type === 'SABME') sabmes++;
    for (let k = 0; k < 3; k++) { a.tick(a.t401Ms()); while ((x = a.pollTransmit())) if (x[0].type === 'SABME') sabmes++; }
    ok(sabmes === 3 && a.state() === L.State.Disconnected && has(events(a), 'Released', L.Cause.NoResponse), 'establishment retries then gives up after N400'); }
  { const a = mk(O, { t401Ms: 966 }); a.connect(); a.pollTransmit(); a.tick(966); const grew = a.t401Ms() > 1280; a.tick(1280 - 966); const st = a.state(); a.receive({ type: 'UA', final: true }, R);
    ok(grew && st === L.State.AwaitingEstablishment && a.state() === L.State.Connected, 'a timer too short for the line grows until it is not'); }
  { const a = mk(O, { t401Ms: 4000 }); a.connect(); a.pollTransmit(); a.tick(3000); a.receive({ type: 'UA', final: true }, R); ok(a.t401Ms() === 4500, 'a slow answer on the first attempt lengthens the timer'); }
  { const a = mk(O, { t401Ms: 1000 }); a.connect(); a.pollTransmit(); a.tick(400); a.tick(400); const early = a.pollTransmit(); a.tick(400);
    ok(early === null && a.pollTransmit() !== null, 'the timer does not fire early'); }
  { const a = mk(O); a.connect(); a.receive({ type: 'DM', final: true }, R); ok(a.state() === L.State.Disconnected && has(events(a), 'Released', L.Cause.Refused), 'a refused connection is reported'); }
  { const a = mk(O); a.connect(); a.receive({ type: 'DM', final: false }, R); ok(a.state() === L.State.AwaitingEstablishment, 'an unsolicited DM during establishment is ignored'); }
  { const a = mk(O, { t401Ms: 1000 }); a.sendData(bytes('queued before the link')); a.connect(); while (a.pollTransmit()); a.receive({ type: 'RR', nr: 0, pf: true }, C);
    const st = a.state(), ev = events(a); const sent = []; let x; while ((x = a.pollTransmit())) sent.push(x);
    const answered = sent.some(([f, k]) => eq(f, { type: 'RR', nr: 0, pf: true }) && k === R);
    const fromZero = sent.some(([f, k]) => f.type === 'I' && f.ns === 0 && f.nr === 0 && eq(f.info, bytes('queued before the link')) && k === C);
    a.receive({ type: 'UA', final: true }, R); const st2 = a.state(), ev2 = events(a); a.receive({ type: 'RR', nr: 1, pf: false }, R); a.tick(10000);
    const later = []; while ((x = a.pollTransmit())) later.push(x);
    ok(st === L.State.Connected && ev.length === 1 && ev[0].type === 'Connected' && answered && fromZero && st2 === L.State.Connected && ev2.length === 0 && !later.some(([f]) => f.type === 'SABME'),
       'a poll that arrives before the UA establishes and is answered'); }
  { const a = mk(O); a.connect(); while (a.pollTransmit()); a.receive({ type: 'I', ns: 0, nr: 0, poll: false, info: bytes('login: ') }, C);
    ok(a.isConnected() && eq(dataFrom(a), bytes('login: ')), 'an I frame that arrives before the UA is delivered'); }
  { let good = true; for (const f of [{ type: 'UI', pf: false, info: [0x78] }, { type: 'XID', pf: false, info: [0x82] }, { type: 'TEST', pf: false, info: [] }, { type: 'UA', final: false }, { type: 'DM', final: false }]) {
      const a = mk(O); a.connect(); a.receive(f, R); if (a.state() !== L.State.AwaitingEstablishment) good = false; }
    const idle = mk(A); idle.receive({ type: 'RR', nr: 0, pf: true }, C);
    ok(good && idle.state() === L.State.Disconnected && idle.pollTransmit() === null, 'only I and supervisory frames stand in for a lost UA'); }
  { const [a, b] = pair(); a.connect(); settle(a, b); events(a); events(b); a.sendData(bytes('some data first')); settle(a, b); events(b); b.connect(); settle(a, b);
    const reset = has(events(a), 'Reset'); a.sendData(bytes('after reset')); settle(a, b); ok(reset && eq(dataFrom(b), bytes('after reset')), 're-establishment resets the sequence numbers'); }
  { const [a, b] = pair(); a.connect(); settle(a, b); b.receive({ type: 'RR', nr: 0, pf: true }, C); const r = []; let x; while ((x = b.pollTransmit())) r.push(x);
    ok(r.some(([f, k]) => f.type === 'RR' && f.pf && k === R), 'a poll is answered with a final'); }
  { const [a, b] = pair({ t401Ms: 1000 }); a.connect(); settle(a, b); events(b); a.sendData(bytes('the last frame goes missing')); while (a.pollTransmit()); const none = dataFrom(b).length === 0; a.tick(1000); settle(a, b);
    ok(none && eq(dataFrom(b), bytes('the last frame goes missing')), 'a lost final frame is recovered by the timer'); }
  { const [a, b] = pair({ t401Ms: 1000, n401: 4 }); a.connect(); settle(a, b); events(b); a.sendData(bytes('abcdefghijkl')); settle(a, b); const first = dataFrom(b); a.tick(1000); settle(a, b);
    ok(eq(first, bytes('abcdefghijkl')) && dataFrom(b).length === 0, 'timer recovery does not resend what was already acknowledged'); }
  { const [a, b] = pair({ n401: 1 }); a.connect(); settle(a, b); events(b); const p = Array.from({ length: 300 }, (_, i) => i % 251); a.sendData(p); settle(a, b);
    ok(eq(dataFrom(b), p), 'sequence numbers wrap past the modulus'); }
});

section('xid', () => {
  const X = require(path.join(EC, 'Xid'));
  const V44 = require(path.join(EC, 'V44'));
  const { COMMAND: C, RESPONSE: R } = require(path.join(EC, 'Frame'));
  const { Xid, Compression: K, V44Offer } = X;
  const P44 = (n2, n7, n8) => new V44.Params(n2, n7, n8);
  const xj = (x) => x && JSON.stringify({ ...x, v44: x.v44 && { c: x.v44.compression, t: { ...x.v44.transmit }, r: { ...x.v44.receive } } });
  const dec = (b) => { try { return Xid.decode(b); } catch (e) { return e; } };
  const pp = (out, pi, v) => out.push(pi, v.length, ...v);
  const sub = (out, gi, params) => out.push(gi, params.length >> 8, params.length & 0xff, ...params);
  { const x = Xid.proposal(K.Both); ok(xj(Xid.decode(x.encode(C))) === xj(x), 'a proposal round-trips'); }
  ok(Xid.proposal(K.Both).encode(C)[0] === 0b10000010, 'the format identifier is the general purpose one');
  { const b = Xid.proposal(K.Both).encode(C); ok(b.includes(0x80) && b.includes(0xf0), 'subfields carry the specified group identifiers'); }
  { const b = new Xid({ n401Transmit: 128 }).encode(C); let at = -1; for (let i = 0; i + 1 < b.length; i++) if (b[i] === 5 && b[i + 1] === 2) { at = i; break; }
    ok(at >= 0 && ((b[at + 2] << 8) | b[at + 3]) === 1024 && Xid.decode(b).n401Transmit === 128, 'N401 is carried in bits, not octets'); }
  { const b = new Xid({ compression: K.Both, codewords: 0x0400 }).encode(C); let at = -1; for (let i = 0; i + 1 < b.length; i++) if (b[i] === 2 && b[i + 1] === 2) { at = i; break; }
    ok(at >= 0 && b[at + 2] === 0x04 && b[at + 3] === 0, 'multi-octet values are high-order first'); }
  ok(eq(X.PARAMETER_SET_V42, bytes('V42')), 'the parameter set identifier spells V42');
  { const b = Xid.proposal(K.Both).encode(C); const gi = b.indexOf(0xf0); ok(b[gi + 3] === 0, 'the parameter set identifier comes first in the private subfield'); }
  { const m = new Xid({ testFrame: false })._hdlcMask(C); ok([2, 4, 8, 9, 12, 16].every((b) => m & (1 << (b - 1))), 'the HDLC mask sets the positions the encoding rules demand'); }
  { const w = new Xid({ fcs32: true }); const r = w._hdlcMask(R), c = w._hdlcMask(C), n = new Xid({ fcs32: false })._hdlcMask(R);
    ok((r & (1 << 16)) && !(r & (1 << 15)) && (c & (1 << 16)) && (c & (1 << 15)) && (n & (1 << 15)), 'only a response agreeing to 32 bits clears bit 16'); }
  { const x = Xid.proposal(K.Both); const c = x.encode(C), r = x.encode(R); const diff = c.map((v, i) => i).filter((i) => c[i] !== r[i]);
    ok(xj(Xid.decode(c)) === xj(Xid.decode(r)) && diff.length === 1 && (c[diff[0]] ^ r[diff[0]]) === 0x80, 'a command and its response agree on everything but bit 16'); }
  { const b = Xid.decode(new Xid({ fcs32: true, testFrame: true, srejMultiple: true }).encode(C)); ok(b.fcs32 && b.testFrame && b.srejMultiple, 'capabilities survive a round trip'); }
  { const a = new Xid({ n401Transmit: 256, windowTransmit: 15, compression: K.Both, codewords: 2048, maxString: 32 }).resolve(new Xid({ n401Transmit: 128, windowTransmit: 7, compression: K.Both, codewords: 512, maxString: 6 }));
    ok(a.n401Transmit === 128 && a.windowTransmit === 7 && a.codewords === 512 && a.maxString === 6, 'the lower value wins'); }
  { const a = new Xid({ fcs32: true, testFrame: true }).resolve(new Xid({ fcs32: false, testFrame: true })); ok(!a.fcs32 && a.testFrame, 'a capability needs both ends'); }
  { const one = new Xid({ compression: K.InitiatorToResponder }); ok(one.resolve(new Xid({ compression: K.Both })).compression === K.InitiatorToResponder && one.resolve(new Xid({ compression: K.ResponderToInitiator })).compression === K.Neither,
      'compression directions intersect'); }
  { const p = new Xid({ compression: K.Both, codewords: 1024, maxString: 16 }).v42bisParams(); ok(p.n2 === 1024 && p.n7 === 16 && new Xid({ compression: K.Neither }).v42bisParams() === null, 'settled parameters configure the compressor'); }
  { const b = [X.FI_GENERAL_PURPOSE, 0x55, 0, 3, 1, 2, 3]; const params = []; pp(params, 0x7f, [9, 9]); pp(params, 7, [15]); sub(b, 0x80, params);
    const user = []; pp(user, 0x40, X.PARAMETER_SET_V44); pp(user, 0x42, [3]); b.push(0xff, ...user); const d = dec(b);
    ok(!(d instanceof Error) && d.windowTransmit === 15 && d.v44, 'unrecognized groups and parameters are ignored'); }
  { const priv = []; pp(priv, 0, bytes('XYZ')); pp(priv, 2, [0x10, 0]); const b = [X.FI_GENERAL_PURPOSE]; sub(b, 0xf0, priv); ok(Xid.decode(b).codewords === null, 'a private subfield for another standard is ignored'); }
  ok(dec([]).kind === 'Truncated' && dec([0x82, 0x80, 0]).kind === 'Truncated' && dec([0x82, 0x80, 0, 40, 1]).kind === 'Truncated', 'truncated fields are rejected');
  ok(dec([0x01]).kind === 'UnknownFormat', 'a foreign format identifier is rejected');
  { const req = [2, 4, 8, 9, 12, 16].reduce((m, b) => m | (1 << (b - 1)), 0); ok((new Xid({ srejSingle: true })._hdlcMask(C) & ~req) === 4, 'selective reject sits at the bit position the note names'); }
  { const asking = Xid.proposal(K.Both), silent = Xid.proposal(K.Both); silent.srejSingle = false;
    ok(asking.srejSingle && asking.resolve(asking).srejSingle && !asking.resolve(silent).srejSingle && !silent.resolve(asking).srejSingle, 'selective reject is agreed and not announced'); }
  { const CALLER = [0x82,0x80,0x00,0x13,0x03,0x03,0x8a,0x89,0x00,0x05,0x02,0x04,0x00,0x06,0x02,0x04,0x00,0x07,0x01,0x0f,0x08,0x01,0x0f,0xf0,0x00,0x0f,0x00,0x03,0x56,0x34,0x32,0x01,0x01,0x03,0x02,0x02,0x08,0x00,0x03,0x01,0x20,0xff,0x40,0x03,0x56,0x34,0x34,0x41,0x01,0x00,0x42,0x01,0x03,0x43,0x02,0x08,0x00,0x44,0x02,0x08,0x00,0x45,0x01,0x8e,0x46,0x01,0x8e,0x47,0x02,0x20,0x00,0x48,0x02,0x20,0x00];
    const HOST = CALLER.slice(0, 41);
    const host = dec(HOST), caller = dec(CALLER);
    const wantHost = new Xid({ n401Transmit: 128, n401Receive: 128, windowTransmit: 15, windowReceive: 15, compression: K.Both, codewords: 2048, maxString: 32 });
    const wantCaller = new Xid({ ...wantHost, v44: new V44Offer(K.Both, P44(2048, 142, 8192), P44(2048, 142, 8192)) });
    ok(xj(host) === xj(wantHost) && xj(caller) === xj(wantCaller) && Xid.proposal(K.Both).resolve(caller).v44, 'the XIDs of a real call are read'); }
  { const field = (mask) => { const params = []; pp(params, 3, mask); const b = [X.FI_GENERAL_PURPOSE]; sub(b, 0x80, params); return Xid.decode(b); };
    ok(field([0x04]).srejSingle && field([0, 0, 0x80]).srejMultiple && xj(field([])) === xj(new Xid()), 'an option mask shorter than four octets is read as far as it goes');
    const heard = field([0x04, 0, 0x01, 0, 0xff, 0xff]); ok(heard.srejSingle && heard.fcs32 && !heard.srejMultiple && xj(heard) === xj(field([0x04, 0, 0x01, 0])), 'an option mask longer than four octets is read for the four'); }
  { const params = []; pp(params, 5, [0, 0, 4]); pp(params, 8, [0, 0, 0, 7]); pp(params, 6, [4, 0]); pp(params, 3, [0, 0, 1, 0]); const b = [X.FI_GENERAL_PURPOSE]; sub(b, 0x80, params);
    const h = dec(b); const a = Xid.proposal(K.Neither).resolve(h);
    ok(h.n401Transmit === null && h.windowReceive === null && h.n401Receive === 128 && h.fcs32 && a.n401Transmit === 128 && a.windowReceive === 15, 'a parameter too wide for its entry costs only itself'); }
  { const back = Xid.decode(new Xid({ windowReceive: 7 }).encode(C)); ok(back.windowReceive === 7 && back.windowTransmit === null && back.n401Transmit === null, 'an absent parameter stays absent'); }
  // V.44 negotiation
  { const b = Xid.proposal(K.Both).encode(C); let at = 1; const groups = []; while (at < b.length && b[at] !== 0xff) { const len = (b[at + 1] << 8) | b[at + 2]; groups.push(b[at]); at += 3 + len; }
    let field = b.slice(at + 1), last = 0, t; const { } = {}; while (field.length) { const pl = field[1]; last = field[0]; field = field.slice(2 + pl); }
    ok(eq(groups, [0x80, 0xf0]) && b[at] === 0xff && b[at + 1] === 0x40 && b[at + 2] === 3 && eq(b.slice(at + 3, at + 6), X.PARAMETER_SET_V44) && last === 0x48, 'the user data subfield names the Recommendation first'); }
  { const b = [X.FI_GENERAL_PURPOSE]; const params = []; pp(params, 7, [15]); sub(b, 0x80, params);
    b.push(0xff, 0x40, 3, 0x56, 0x34, 0x34, 0x41, 1, 0, 0x42, 1, 3, 0x43, 2, 8, 0, 0x44, 2, 4, 0, 0x45, 1, 0xff, 0x46, 1, 0x40, 0x47, 2, 0x18, 0, 0x48, 2, 0x0c, 0);
    const x = Xid.decode(b); ok(x.windowTransmit === 15 && x.v44 && x.v44.equals(new V44Offer(K.Both, P44(2048, 255, 6144), P44(1024, 64, 3072))), 'a V.44 offer laid out as Table A.1 is read'); }
  { const x = Xid.proposal(K.Both); const back = Xid.decode(x.encode(C)); ok(x.compression != null && x.v44 && back.v44.equals(x.v44) && back.compression === x.compression && back.codewords === x.codewords, 'one proposal offers both algorithms'); }
  { const x = Xid.proposal(K.Both); x.v44 = new V44Offer(K.InitiatorToResponder, P44(4096, 200, 9000), P44(1024, 64, 3072)); ok(Xid.decode(x.encode(C)).v44.equals(x.v44), 'the parameters come back as they went'); }
  { const one = V44Offer.proposal(K.InitiatorToResponder), other = V44Offer.proposal(K.ResponderToInitiator); const a = one.resolve(other);
    ok(a && a.compression === K.InitiatorToResponder && one.resolve(one) === null, 'the directions are read from each end\'s own point of view'); }
  { const a = new V44Offer(K.Both, P44(4096, 255, 12288), P44(4096, 255, 12288)).resolve(new V44Offer(K.Both, P44(512, 64, 1536), P44(1024, 100, 3072)));
    ok(a && a.transmit.equals(P44(1024, 100, 3072)) && a.receive.equals(P44(512, 64, 1536)), 'each direction is settled against the other end\'s opposite'); }
  { const theirs = Xid.proposal(K.Both); theirs.v44 = null; const a = Xid.proposal(K.Both).resolve(theirs); ok(a.v44 === null && a.v42bisParams(), 'a far end that does not know it is not pressed'); }
  { const user = []; pp(user, 0x40, bytes('XYZ')); pp(user, 0x42, [3]); pp(user, 0x45, [99]); ok(Xid.decode([X.FI_GENERAL_PURPOSE, 0xff, ...user]).v44 === null, 'a user data subfield for something else is ignored'); }
  ok(V44Offer.proposal(K.Both).resolve(new V44Offer(K.Both, P44(64, 8, 16), P44(64, 8, 16))) === null, 'a proposal below the minimum is declined rather than taken');
  { const mine = Xid.proposal(K.Both); let good = true;
    for (const [cw, ms] of [[0, 250], [258, 250], [259, 250], [511, 250], [2048, 5], [2048, 0]]) { const t = Xid.proposal(K.Both); t.v44 = null; t.codewords = cw; t.maxString = ms;
      const st = mine.resolve(t); const ans = mine.answering(st); if (st.v42bisParams() !== null || ans.compression !== K.Neither || ans.v44 !== null) good = false; }
    const t = Xid.proposal(K.Both); t.v44 = null; t.codewords = 512; t.maxString = 6; const st = mine.resolve(t); const pr = st.v42bisParams();
    ok(good && pr && pr.n2 === 512 && pr.n7 === 6 && mine.answering(st).compression === K.Both, 'a V.42bis proposal out of range is declined and the answer says so'); }
  { const b = Xid.proposal(K.Both).encode(C); let found = false; for (let i = 0; i + 2 < b.length; i++) if (b[i] === 0x41 && b[i + 1] === 1 && b[i + 2] === 0) found = true; ok(found, 'the capability byte says modem and XID'); }
});

section('detect', () => {
  const D = require(path.join(EC, 'Detect'));
  const { Originator, Answerer, Answer, Outcome, CharacterScanner, pushCharacter, DEFAULT_T400_MS: T400 } = D;
  const isAns = (o, kind, ch) => o.kind === 'Answered' && o.answer.kind === kind && (ch === undefined || o.answer.ch === ch);
  const exchange = (o, a, n) => { for (let k = 0; k < n; k++) { const x = o.transmit(), y = a.transmit(); a.receive(x); o.receive(y); } };
  const say = (o, second, times) => { for (let k = 0; k < times; k++) { const b = []; pushCharacter(b, D.ADP_E); pushCharacter(b, second); b.forEach((x) => o.receive(x)); } };
  const typed = (t) => { const b = []; for (const c of t) { b.push(0); for (let i = 0; i < 8; i++) b.push((c >> i) & 1); b.push(1); } return b; };
  const pop = (v) => v.toString(2).split('').filter((x) => x === '1').length;
  ok(D.ODP_EVEN === 0x11 && D.ODP_ODD === 0x91 && pop(D.ODP_EVEN) % 2 === 0 && pop(D.ODP_ODD) % 2 === 1, 'the ODP characters are DC1 with alternating parity');
  ok(D.ADP_E === 0x45 && D.ADP_C === 0x43, 'the supported ADP spells error control');
  { let all = true; for (let v = 0; v < 256; v++) { const b = []; pushCharacter(b, v); const sc = new CharacterScanner(); let got = null; for (const x of b) { const c = sc.feed(x); if (c !== null) got = c; } if (got !== v) all = false; }
    ok(all, 'every byte survives framing'); }
  { const o = new Originator(), a = new Answerer(); exchange(o, a, 4000); ok(a.outcome() === Outcome.OriginatorDetected && isAns(o.outcome(), 'ErrorControl'), 'two error-correcting modems find each other'); }
  { const o = new Originator(), a = new Answerer(T400, Answer.None); exchange(o, a, 4000); ok(isAns(o.outcome(), 'None'), 'an answerer can decline error control'); }
  ok(D.ADP_M === 0b01001101 && D.ADP_P === 0b01010000 && D.ADP_P % 16 === 0 && D.ADP_M % 16 !== 0, 'the extended patterns spell out their letters');
  { const o = new Originator(); say(o, D.ADP_M, 5); const pend = o.outcome() === Outcome.Pending; say(o, D.ADP_C, 10); ok(pend && isAns(o.outcome(), 'ErrorControl'), 'a cellular modem saying EM first still gets error control'); }
  { const o = new Originator(); say(o, D.ADP_P, 16); const pend = o.outcome() === Outcome.Pending; say(o, D.ADP_C, 10);
    ok(pend && isAns(o.outcome(), 'ErrorControl') && o.patterns().some(Answer.offersV44), 'a modem offering V.44 says EP sixteen times first'); }
  { const o = new Originator(); say(o, D.ADP_M, 5); const t = o.tick(T400); ok(isAns(t, 'Extended', D.ADP_M) && Answer.errorControlled(o.outcome().answer), 'an extended pattern alone is still error control'); }
  { const o = new Originator(); say(o, 0x20, 2); ok(isAns(o.outcome(), 'Reserved', 0x20), 'an unknown pattern is not listened past'); }
  const adpsSent = (a, n) => { const sc = new CharacterScanner(), seen = []; for (let k = 0; k < n; k++) { const c = sc.feed(a.transmit()); if (c !== null) seen.push(c); } let m = 0; for (let i = 0; i + 1 < seen.length; i++) if (seen[i] === D.ADP_E && seen[i + 1] === D.ADP_C) m++; return m; };
  { const a = new Answerer(), o = new Originator(); for (let k = 0; k < 400; k++) a.receive(o.transmit()); ok(a.outcome() === Outcome.OriginatorDetected && adpsSent(a, 20000) >= 10, 'the answerer sends the pattern at least ten times'); }
  const flags = (a) => { for (let k = 0; k < 4; k++) for (let i = 7; i >= 0; i--) a.receive((0x7e >> i) & 1); };
  { const a = new Answerer(), o = new Originator(); for (let k = 0; k < 400; k++) a.receive(o.transmit()); for (let k = 0; k < 20000; k++) a.transmit();
    const before = !a.heardFlags() && !a.finishedSending(); flags(a); const heard = a.heardFlags(); for (let k = 0; k < 2000; k++) a.transmit();
    let marks = true; for (let k = 0; k < 200; k++) if (a.transmit() !== 1) marks = false;
    ok(before && heard && a.finishedSending() && marks, 'the answerer stops when the protocol phase begins'); }
  { const a = new Answerer(); const idle = !a.sending(); const o = new Originator(); for (let k = 0; k < 400; k++) a.receive(o.transmit()); let held = a.sending();
    for (let k = 0; k < 20000; k++) { if (!a.sending()) held = false; a.transmit(); } flags(a); let tail = 0; while (a.sending() && tail < 1000) { a.transmit(); tail++; }
    ok(idle && held && tail < 1000 && a.finishedSending(), 'an answerer says whether its pattern still has bits to go'); }
  { const a = new Answerer(), o = new Originator(); for (let k = 0; k < 400; k++) a.receive(o.transmit()); for (let k = 0; k < 20000; k++) a.transmit();
    const a0 = !a.finishedSending(); a.tick(T400 * 2); for (let k = 0; k < 2000; k++) a.transmit(); const a1 = !a.finishedSending(); a.tick(T400 * 8); for (let k = 0; k < 2000; k++) a.transmit();
    ok(a0 && a1 && a.finishedSending(), 'an originator that never speaks does not hold the answerer for ever'); }
  { const a = new Answerer(), early = new Originator(); for (let k = 0; k < 400; k++) a.receive(early.transmit()); let held = true;
    for (let k = 0; k < 2000; k++) { if (!a.sending()) held = false; a.transmit(); a.tick(1); }
    const late = new Originator(); for (let k = 0; k < 4000; k++) { late.receive(a.transmit()); if (late.outcome() !== Outcome.Pending) break; }
    ok(held && a.outcome() === Outcome.OriginatorDetected && isAns(late.outcome(), 'ErrorControl'), 'an ADP waits for a far end that is not listening yet'); }
  { const o = new Originator(), a = new Answerer(T400, Answer.reserved(0x07)); exchange(o, a, 4000); ok(isAns(o.outcome(), 'Reserved', 0x07), 'a reserved answer is reported rather than guessed at'); }
  { const SV92PP_ODP = '0100010001111111111101000100111111111111'; const a = new Answerer(); let notText = true;
    for (let k = 0; k < 3; k++) { for (const ch of SV92PP_ODP) a.receive(ch === '1' ? 1 : 0); if (a.outcome() === Outcome.Text) notText = false; }
    const sc = new CharacterScanner(), sent = []; for (let k = 0; k < 200; k++) { const c = sc.feed(a.transmit()); if (c !== null) sent.push(c); }
    ok(notText && a.outcome() === Outcome.OriginatorDetected && sent[0] === D.ADP_E && sent[1] === D.ADP_C, 'the ODP a real Agere sends is recognised'); }
  { const o = new Originator(); for (let k = 0; k < 4000; k++) { o.transmit(); o.receive(1); } ok(o.outcome() === Outcome.Pending && o.tick(T400) === Outcome.TimedOut, 'a silent far end times out'); }
  { const a = new Answerer(); for (let k = 0; k < 4000; k++) { a.transmit(); a.receive(1); } ok(a.tick(T400) === Outcome.Pending && a.tick(T400 * 9) === Outcome.TimedOut, 'an answerer hearing nothing times out'); }
  { const o = new Originator(750); ok(o.tick(700) === Outcome.Pending && o.tick(50) === Outcome.TimedOut, 'the timer does not fire early'); }
  { const a = new Answerer(), b = []; for (let k = 0; k < 6; k++) pushCharacter(b, D.ODP_EVEN); b.forEach((x) => a.receive(x)); ok(a.outcome() === Outcome.Pending, 'four alternating DC1s are required'); }
  { const a = new Answerer(), b = []; for (const c of bytes('hello there, this is not a detection pattern')) pushCharacter(b, c); b.forEach((x) => a.receive(x)); ok(a.outcome() === Outcome.Pending, 'unrelated traffic does not trigger detection'); }
  { const o = new Originator(); const b = []; pushCharacter(b, D.ADP_E); pushCharacter(b, D.ADP_C); b.forEach((x) => o.receive(x)); const one = o.outcome() === Outcome.Pending; b.forEach((x) => o.receive(x));
    ok(one && isAns(o.outcome(), 'ErrorControl'), 'one ADP is not enough for the originator'); }
  { const a = new Answerer(); let m = true; for (let k = 0; k < 100; k++) if (a.transmit() !== 1) m = false; ok(m, 'the answerer idles at mark before detecting'); }
  { const banner = bytes('\rArmbian 23.5.1 Bookworm l \n\r\n\r**EMSI_REQA77E\r'); const o = new Originator(); const b = new Array(300).fill(1).concat(typed(banner)); b.forEach((x) => o.receive(x));
    const heard = o.takeHeard(); const sc = new CharacterScanner(); const text = heard.map((x) => sc.feed(x)).filter((c) => c !== null);
    ok(o.outcome() === Outcome.Text && o.patterns().length === 0 && eq(banner.slice(0, text.length), text) && text.length >= 16, 'a login banner is text and not two answers'); }
  { const o = new Originator(); typed(bytes('EQEQ')).forEach((x) => o.receive(x)); ok(o.outcome() === Outcome.Pending && o.patterns().length === 0, 'E twice in text is not an answer'); }
  { const o = new Originator(); new Array(300).fill(1).concat(typed(bytes('EC'.repeat(12)))).forEach((x) => o.receive(x)); ok(isAns(o.outcome(), 'ErrorControl'), 'an answer sent back to back is still an answer'); }
  { const o = new Originator(); new Array(300).fill(1).concat(typed(bytes('EP'.repeat(16) + 'EC'.repeat(10)))).forEach((x) => o.receive(x));
    ok(isAns(o.outcome(), 'ErrorControl') && o.patterns().some((a) => a.kind === 'Extended' && a.ch === D.ADP_P), 'an extended pattern sent back to back is listened past too'); }
  { const o = new Originator(); typed(bytes('EQ'.repeat(10))).forEach((x) => o.receive(x)); ok(o.outcome() === Outcome.Text && o.patterns().length === 0, 'a repeated pair with no meaning is still text'); }
  { const o = new Originator(); say(o, D.ADP_M, 1); say(o, 0x51, 1); ok(o.outcome() === Outcome.Pending, 'adjacent answers have to agree'); }
  { const o = new Originator(), a = new Answerer(); const nx = xorshift(0x2545f491); for (let k = 0; k < 2000000; k++) { const b = nx() & 1; o.receive(b); a.receive(b); }
    ok(o.outcome() === Outcome.Pending && a.outcome() === Outcome.Pending, 'random noise is neither text nor an answer'); }
  { const a = new Answerer(); typed(bytes('hello there, is this the BBS?\r')).forEach((x) => a.receive(x)); ok(a.outcome() === Outcome.Text, 'an answerer hears a caller typing'); }
  { const a = new Answerer(T400, Answer.ErrorControl), b = []; for (let k = 0; k < 6; k++) { pushCharacter(b, D.ODP_EVEN); pushCharacter(b, D.ODP_ODD); } let out = Outcome.Pending; for (const x of b) out = a.receive(x);
    ok(out === Outcome.OriginatorDetected, 'the originator\'s ODP is recognised'); }
  { const o = new Originator(), a = new Answerer(); exchange(o, a, 4000); let m = true; for (let k = 0; k < 50; k++) if (o.transmit() !== 1) m = false; ok(isAns(o.outcome(), 'ErrorControl') && m, 'the originator stops sending once answered'); }
});

section('stack', () => {
  const S = require(path.join(EC, 'Stack'));
  const L = require(path.join(EC, 'Lapm'));
  const B = require(path.join(EC, 'V42bis'));
  const F = require(path.join(EC, 'Frame'));
  const { Xid } = require(path.join(EC, 'Xid'));
  const { Decoder, FCS16 } = require(path.join(EC, 'Hdlc'));
  const { Stack, Phase, Compression: K, ORIGINATOR: O, ANSWERER: A } = S;
  const mk = (role) => new Stack(role, new L.Params());
  const settle = (a, b, bits, channel = (i, x) => x) => {
    for (let i = 0; i < bits; i++) { const toB = a.nextBit(), toA = b.nextBit(); b.feedBit(channel(i, toB)); a.feedBit(channel(i, toA)); if (i % 160 === 0) { a.tick(16); b.tick(16); } }
  };
  const negotiated = () => { const a = mk(O), b = mk(A); a.offerCompression(K.Both); b.offerCompression(K.Both); return [a, b]; };
  { const a = mk(O), b = mk(A); a.connect(); settle(a, b, 20000); const up = a.isConnected() && b.isConnected(); a.send(bytes('login: cactus\r\n')); settle(a, b, 20000);
    ok(up && eq(b.takeReceived(), bytes('login: cactus\r\n')), 'a link establishes and carries data'); }
  { const a = mk(O), b = mk(A); a.connect(); settle(a, b, 20000); const idle = Array.from({ length: 80 }, () => a.nextBit());
    let aligned = false; for (let off = 0; off < 8; off++) { let all = true; for (let k = 0; k < 8; k++) { let v = 0; for (let i = 0; i < 8; i++) v |= idle[off + k * 8 + i] << i; if (v !== 0x7e) all = false; } if (all) aligned = true; }
    ok(aligned, 'an idle link carries flags rather than nothing'); }
  { const a = mk(O), b = mk(A); a.connect(); settle(a, b, 20000); a.send(bytes('what the caller typed')); b.send(bytes('what the host answered')); settle(a, b, 40000);
    ok(eq(b.takeReceived(), bytes('what the caller typed')) && eq(a.takeReceived(), bytes('what the host answered')), 'data crosses in both directions at once'); }
  { const a = mk(O), b = mk(A); a.connect(); settle(a, b, 20000); const p = Array.from({ length: 400 }, (_, i) => i % 251); a.send(p);
    settle(a, b, 400000, (i, x) => (i % 4099 === 0 ? x ^ 1 : x)); ok(eq(b.takeReceived(), p) && a.damagedFrames() + b.damagedFrames() > 0, 'a line that damages frames still delivers'); }
  { const a = mk(O), b = mk(A); const d0 = a.phase() === Phase.Detecting && b.phase() === Phase.Detecting; a.connect(); settle(a, b, 20000);
    ok(d0 && a.phase() === Phase.Protocol && b.phase() === Phase.Protocol && a.isConnected() && b.isConnected(), 'the detection phase runs before anything else'); }
  { const a = mk(O); a.connect(); for (let i = 0; i < 40000; i++) { a.nextBit(); a.feedBit(1); if (i % 160 === 0) a.tick(16); }
    ok(a.phase() === Phase.Transparent && !a.isConnected(), 'a far end without error control is recognised rather than waited for'); }
  { const a = mk(O), b = mk(A).declining(); a.connect(); settle(a, b, 40000); ok(a.phase() === Phase.Transparent && !a.isConnected(), 'an answerer that declines is taken at its word'); }
  { let a = mk(O), b = mk(A); a.offerCompression(K.Both); a.connect(); settle(a, b, 40000); const one = a.isConnected() && b.isConnected() && !a.compressing() && !b.compressing();
    [a, b] = negotiated(); a.connect(); settle(a, b, 40000); const both = a.compressing() && b.compressing();
    const p = bytes('the same words over and over, the same words over and over'); a.send(p); settle(a, b, 80000);
    ok(one && both && eq(b.takeReceived(), p), 'compression is used only when both ends offer it'); }
  { const pr = new B.Params(); const a = mk(O).withCompression(pr), b = mk(A).withCompression(pr); a.connect(); settle(a, b, 20000);
    const p = bytes('the same words over and over, the same words over and over, the same words over and over, the same words over and over'); a.send(p); settle(a, b, 80000);
    ok(eq(b.takeReceived(), p), 'compression is carried through the same interface'); }
  { const pr = new B.Params(); const a = mk(O).withCompression(pr), b = mk(A).withCompression(pr); a.connect(); settle(a, b, 20000); const up = a.isConnected() && b.isConnected();
    const block = (from) => { const o = []; for (let i = from; i < from + 200; i++) o.push(...bytes(`the same words over and over, line ${i}\r\n`)); return o; };
    const warmed = block(0); a.send(warmed); settle(a, b, 200000); const w = a.compressing() && b.takeReceived().length === warmed.length;
    const lost = block(1000); a.send(lost); settle(a, b, 4000); const crossed = b.takeReceived().length;
    b.connect(); settle(a, b, 60000); const back = a.isConnected() && b.isConnected(); a.takeReceived(); b.takeReceived();
    const after = block(2000); a.send(after); settle(a, b, 200000); const r1 = eq(b.takeReceived(), after); b.send(after); settle(a, b, 200000);
    ok(up && w && crossed < lost.length && back && r1 && eq(a.takeReceived(), after), 'compression starts again when the link does'); }
  { const [a, b] = negotiated(); a.connect(); settle(a, b, 40000); const up = a.isConnected() && b.isConnected() && a.compressing() && b.compressing();
    const stream = (tag, n) => { const o = []; const nx = xorshift((0x2545f491 ^ tag) >>> 0); while (o.length < n) { o.push(...bytes('HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n')); for (let k = 0; k < 64; k++) o.push(nx() & 0xff); } return o.slice(0, n); };
    const upS = stream(1, 6000), down = stream(2, 6000); a.send(upS); b.send(down); settle(a, b, 2000000, (i, x) => (i % 8191 === 0 ? x ^ 1 : x));
    ok(up && a.damagedFrames() + b.damagedFrames() > 0 && a.isConnected() && b.isConnected() && eq(b.takeReceived(), upS) && eq(a.takeReceived(), down),
       'bulk traffic both ways survives a line that damages frames'); }
  { let [a, b] = negotiated(); a.connect(); settle(a, b, 40000); const n1 = a.compressionName() === 'V.44' && b.compressionName() === 'V.44';
    const text = cycle('the same line of text over and over and over\n', 24000); a.send(text); settle(a, b, 3000000); const r1 = eq(b.takeReceived(), text);
    [a, b] = negotiated(); b.withoutV44(); a.connect(); settle(a, b, 40000); const n2 = a.compressionName() === 'V.42bis' && b.compressionName() === 'V.42bis';
    a.send(bytes('and this still crosses')); settle(a, b, 200000);
    ok(n1 && r1 && n2 && eq(b.takeReceived(), bytes('and this still crosses')), 'two ends that know V.44 use it, and fall back when one does not'); }
  { const answers = (st, role) => st.takeLog().filter((f) => f.outbound).map((f) => F.decodeFrame(f.body, F.peerOf(role))).filter((r) => r.ok && r.ok.frame.type === 'XID' && r.ok.address.kind === F.RESPONSE).map((r) => Xid.decode(r.ok.frame.info));
    let [a, b] = negotiated(); a.connect(); settle(a, b, 40000); const both = answers(a, O).concat(answers(b, A));
    const g1 = a.compressionName() === 'V.44' && both.length > 0 && both.every((x) => x.v44 && x.compression === null);
    [a, b] = negotiated(); b.withoutV44(); a.connect(); settle(a, b, 40000); const ans = answers(a, O);
    ok(g1 && a.compressionName() === 'V.42bis' && ans.length > 0 && ans.every((x) => x.compression !== null && x.v44 === null), 'an XID response names one compression algorithm'); }
  { const [a, b] = negotiated(); a.withoutV42bis(); a.connect(); settle(a, b, 40000); const n = a.compressionName() === 'V.44' && b.compressionName() === 'V.44';
    a.send(bytes('through V.44 alone')); settle(a, b, 200000); ok(n && eq(b.takeReceived(), bytes('through V.44 alone')), 'V.44 alone is offered and used with a far end that has both'); }
  { const [a, b] = negotiated(); a.withoutV42bis(); b.withoutV44(); a.connect(); settle(a, b, 40000); const n = a.isConnected() && b.isConnected() && a.compressionName() === null && b.compressionName() === null;
    a.send(bytes('plain')); settle(a, b, 200000); ok(n && eq(b.takeReceived(), bytes('plain')), 'V.44 alone meets V.42bis alone and nothing is compressed'); }
  { let good = true; for (const role of [O, A]) { const st = new Stack(role, new L.Params()).withoutDetection(); const d = new Decoder(FCS16); let control = null;
      for (let k = 0; k < 4000; k++) { const r = d.feed(st.nextBit()); if (r && r.ok) { control = r.ok[1]; break; } } if (control !== 0xaf) good = false; }
    ok(good, 'an XID command goes out with its poll bit clear'); }
});

section('stack-far-ends', () => {
  const S = require(path.join(EC, 'Stack'));
  const L = require(path.join(EC, 'Lapm'));
  const B = require(path.join(EC, 'V42bis'));
  const F = require(path.join(EC, 'Frame'));
  const { Encoder, FCS16, FCS32 } = require(path.join(EC, 'Hdlc'));
  const { Xid } = require(path.join(EC, 'Xid'));
  const { Stack, Phase, Compression: K, ORIGINATOR: O, ANSWERER: A, LEADING_FLAGS, UNDECODABLE_RESETS } = S;
  const mk = (role) => new Stack(role, new L.Params());
  const hex = (t) => t.split(/\s+/).filter(Boolean).map((h) => parseInt(h, 16));
  const wire = (st, body, fcs = FCS16, lead = 0) => { const e = new Encoder(fcs); if (lead) e.idle(lead); e.frame(body); if (lead) e.idle(2); let b; while ((b = e.nextBit()) !== null) { st.nextBit(); st.feedBit(b); } st.tick(0); };
  const idle = (st, rounds = 4, per = 2000, dt = 10) => { for (let r = 0; r < rounds; r++) { for (let k = 0; k < per; k++) { st.nextBit(); st.feedBit(1); } st.tick(dt); } };
  const sentBodies = (st) => st.takeLog().filter((c) => c.outbound).map((c) => c.body);
  const has = (list, b) => list.some((x) => eq(x, b));
  const settle = (a, b, bits) => { const fa = [], fb = []; for (let i = 0; i < bits; i++) { const x = a.nextBit(), y = b.nextBit(); fa.push(x); fb.push(y); b.feedBit(x); a.feedBit(y); if (i % 160 === 0) { a.tick(16); b.tick(16); } } return [fa, fb]; };
  const longestOnes = (bits) => { let best = 0, run = 0; for (const x of bits) { run = x ? run + 1 : 0; best = Math.max(best, run); } return best; };
  { const st = mk(O).withoutDetection(); const e = new Encoder(FCS16); const rr = F.encodeFrame({ type: 'RR', nr: 0, pf: true }, 0, A, F.COMMAND); e.frame(rr);
    const bits = []; let b; while ((b = e.nextBit()) !== null) bits.push(b); bits[12] ^= 1; const oct = (o) => [0, 1, 2, 3, 4, 5, 6, 7].map((i) => (o >> i) & 1);
    bits.push(...oct(0x41), ...oct(0x42), ...new Array(8).fill(1), ...oct(0x7e), ...new Array(64).fill(1));
    for (const x of bits) { st.nextBit(); st.feedBit(x); } const heard = st.takeLog().filter((f) => !f.outbound);
    ok(heard.length === 2 && heard.every((f) => !f.intact) && heard[0].body.length === rr.length + 2 && eq(heard[1].body, [0x41, 0x42]) && st.damagedFrames() === 2, 'a damaged frame is logged and counted once'); }
  { const a = mk(O), b = mk(A); a.connect(); settle(a, b, 20000); const up = a.isConnected() && b.isConnected(); a.disconnect(); settle(a, b, 20000);
    ok(up && !a.isConnected() && !b.isConnected(), 'a release is seen at both ends'); }
  { const ans = mk(A).withoutDetection(); for (let r = 0; r < 80; r++) { for (let k = 0; k < 1000; k++) { ans.nextBit(); ans.feedBit(1); } ans.tick(100); }
    const inProto = ans.phase() === Phase.Protocol; const offer = Xid.proposal(K.Neither);
    wire(ans, F.encodeFrame({ type: 'XID', pf: false, info: offer.encode(F.COMMAND) }, 0, O, F.COMMAND), FCS16, LEADING_FLAGS);
    const answered = ans.takeLog().some((f) => f.outbound && (() => { const r = F.decodeFrame(f.body, O); return r.ok && r.ok.frame.type === 'XID'; })());
    wire(ans, F.encodeFrame({ type: 'SABME', poll: true }, 0, O, F.COMMAND), FCS32, LEADING_FLAGS);
    ok(inProto && offer.fcs32 && answered && ans.damagedFrames() === 0 && ans.isConnected() && ans.fcs() === FCS32, 'an XID that arrives after the wait still decides the check sequence'); }
  { let good = true; for (const cw of [0, 258, 259, 511]) { const ans = mk(A).withoutDetection(); ans.offerCompression(K.Both); const offer = Xid.proposal(K.Both); offer.v44 = null; offer.codewords = cw;
      wire(ans, F.encodeFrame({ type: 'XID', pf: false, info: offer.encode(F.COMMAND) }, 0, O, F.COMMAND), FCS16, LEADING_FLAGS);
      const answers = ans.takeLog().filter((f) => f.outbound).map((f) => F.decodeFrame(f.body, O)).filter((r) => r.ok && r.ok.frame.type === 'XID' && r.ok.address.kind === F.RESPONSE).map((r) => Xid.decode(r.ok.frame.info));
      if (ans.compressionName() !== null || answers.length !== 1 || answers[0].compression !== K.Neither) good = false; }
    ok(good, 'an XID with a P1 below the minimum is refused rather than built'); }
  { const params = new B.Params(B.OFFERED_N2, B.OFFERED_N7); const text = cycle('Welcome to the board. Please log in. ', 2000); const enc = new B.Encoder(params), stream = []; enc.encode(text, stream); enc.flush(stream);
    let ecm = false; for (let i = 0; i + 1 < stream.length; i++) if (stream[i] === 0 && stream[i + 1] === 0) ecm = true;
    const st = mk(O).withoutDetection(); st.offerCompression(K.Both); st.connect(); idle(st, 80, 4000, 100);
    wire(st, F.encodeFrame({ type: 'UA', final: true }, 0, A, F.RESPONSE)); const up = st.isConnected() && st.farXid() === null;
    for (let i = 0, ns = 0; i < stream.length; i += 64, ns++) wire(st, F.encodeFrame({ type: 'I', ns: ns % 128, nr: 0, poll: false, info: stream.slice(i, i + 64) }, 0, A, F.COMMAND));
    ok(ecm && up && eq(st.takeReceived(), text), 'a far end that compresses without asking is followed'); }
  const linked = () => { const st = mk(O).withoutDetection(); st.offerCompression(K.Both); st.connect(); idle(st);
    wire(st, hex('03 af 82 80 00 13 03 03 8e 89 00 05 02 04 00 06 02 04 00 07 01 0f 08 01 0f f0 00 0f 00 03 56 34 32 01 01 03 02 02 04 00 03 01 20')); idle(st);
    wire(st, hex('03 73')); const ok1 = st.isConnected() && st.compressionName() === 'V.42bis'; st.takeLog(); return [st, ok1]; };
  { const [st, up] = linked();
    for (const body of ['01 00 00 03 ad 7c 5f 23 9e 7c 5a 8a cf d3 8f 58 1f d7 7d dd f8 78 47 08 a0 b0 af 11 74 a2 41 3f c1 08 33', '01 02 00 0c c0 00 00', '01 04 00 02 32 d6 98 81',
      '01 06 00 92 25 78 19 83 75 70 b6 d0 83 11 96 d6 00 92 6b 58 d8 9a 53 19 ce 36 43 6d 45 dc 96 db 6e 47 fa 06 9c 70 27 1a 57 55 1c 2c 4e e4 e2 73 30 52 57 d5 75 d9 79', '01 08 00 b1 5d 00']) wire(st, hex(body));
    idle(st); const und = st.undecodableStreams() === 1; const sent = sentBodies(st); const sabme = has(sent, [0x03, 0x7f]), disc = has(sent, [0x03, 0x53]);
    wire(st, hex('03 73')); const back = st.isConnected(); st.takeReceived(); wire(st, F.encodeFrame({ type: 'I', ns: 0, nr: 0, poll: false, info: bytes('Login: ') }, 0, A, F.COMMAND));
    ok(up && und && sabme && !disc && back && eq(st.takeReceived(), bytes('Login: ')), 'a stream that will not decode starts the link again (live-1790041800)'); }
  { const [st, up] = linked(); let good = up;
    for (let round = 0; round <= UNDECODABLE_RESETS; round++) { for (const [ns, info] of [[0, '0c c0 00 00'], [1, '02 32 d6 98 81']]) wire(st, F.encodeFrame({ type: 'I', ns, nr: 0, poll: false, info: hex(info) }, 0, A, F.COMMAND));
      idle(st); if (st.undecodableStreams() !== round + 1) good = false; const sent = sentBodies(st);
      if (round < UNDECODABLE_RESETS) { if (!has(sent, [0x03, 0x7f])) good = false; wire(st, hex('03 73')); if (!st.isConnected()) good = false; } else if (!has(sent, [0x03, 0x53])) good = false; }
    ok(good, 'a far end that never starts again is released in the end'); }
  { const st = mk(O).withoutDetection(); st.offerCompression(K.Both); st.connect(); idle(st, 80, 4000, 100); wire(st, F.encodeFrame({ type: 'UA', final: true }, 0, A, F.RESPONSE)); const up = st.isConnected();
    let ns = 0; const send = (info) => { wire(st, F.encodeFrame({ type: 'I', ns, nr: 0, poll: false, info }, 0, A, F.COMMAND)); ns = (ns + 1) % 128; };
    send(bytes('login: \x00rest')); const still = st.isConnected(); st.takeReceived(); send(bytes('password: '));
    ok(up && still && eq(st.takeReceived(), bytes('password: ')), 'a guess that does not come off costs only the guess'); }
  { const a = mk(O).withoutDetection(), b = mk(A).bypassingDetection(); const neg = a.phase() === Phase.Negotiating && b.phase() === Phase.Negotiating; const [fa, fb] = settle(a, b, 20000);
    const up = a.isConnected() && b.isConnected(); a.send(bytes('login: cactus\r\n')); settle(a, b, 20000);
    ok(neg && up && longestOnes(fa) < 8 && longestOnes(fb) < 8 && a.farAnswer() === null && eq(b.takeReceived(), bytes('login: cactus\r\n')), 'two ends that both skip detection reach LAPM with no ODP or ADP on the wire'); }
  { const a = mk(O), b = mk(A).bypassingDetection(); const det = a.phase() === Phase.Detecting; const [, fb] = settle(a, b, 40000);
    const ans = a.farAnswer(); const up = a.isConnected() && b.isConnected(); a.send(bytes('login: cactus\r\n')); settle(a, b, 20000);
    ok(det && ans && ans.kind === 'ErrorControl' && up && longestOnes(fb) >= 8 && eq(b.takeReceived(), bytes('login: cactus\r\n')), 'an answerer that skips detection still answers an ODP'); }
  { const b = mk(A).bypassingDetection(); idle(b, 200, 4000, 100); ok(b.phase() === Phase.Transparent && b.settled(), 'a bypassed answerer still falls back when the far end does no V.42'); }
});

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
