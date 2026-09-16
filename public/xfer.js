'use strict';

// SPDX-License-Identifier: GPL-3.0-or-later
//
// public/xfer.js — XMODEM / YMODEM / YMODEM-G / ZMODEM, as pure state machines.
//
// No DOM, no timers, no transport. Bytes arrive through feed(), leave through
// opts.send(), and every timeout is measured against the `now` the host passes
// to tick(). That is what makes this testable against a real peer (lrzsz) in a
// harness and against a live board in a browser without a second implementation
// — and it is the same seam lib/throttle.js and public/rxjitter.js use, for the
// same reason: a component whose job is timing cannot be tested on the clock it
// is trying to control.
//
// FLOW CONTROL IS THE HOST'S. The engine asks opts.ready() before every write
// and stops when the answer is false; the host calls pump() when its transport
// has drained. A streaming sender (YMODEM-G, ZMODEM) that ignored this would
// grow the DSP's transmit queue without bound, which is the crash server.js's
// modemFlow() exists to prevent, reproduced in the tab. See main.js.
//
// The protocols themselves are the published ones: Christensen's XMODEM with
// the CRC-16 and 1K extensions, Forsberg's YMODEM and YMODEM-g (ymodem.txt),
// and ZMODEM (zmodem.txt). PROVENANCE.md §3.1.
//
// Served to the browser as a classic script, like rxjitter.js, and required
// from tools/tests/xfertest.js off the same file on disk.

(function (root) {

// ─── Control bytes ──────────────────────────────────────────────────────────
const SOH = 0x01, STX = 0x02, EOT = 0x04, ACK = 0x06, NAK = 0x15,
      CAN = 0x18, SUB = 0x1A, CRCCHR = 0x43 /* 'C' */, GCHR = 0x47 /* 'G' */;

// ZMODEM. ZDLE is CAN — the two protocols share the byte, which is why a
// ZMODEM stream is recognisable at all: `**\x18B00` is ZPAD ZPAD ZDLE ZHEX.
const ZPAD = 0x2A, ZDLE = 0x18, ZBIN = 0x41, ZHEX = 0x42, ZBIN32 = 0x43;

const ZRQINIT = 0, ZRINIT = 1, ZSINIT = 2, ZACK = 3, ZFILE = 4, ZSKIP = 5,
      ZNAK = 6, ZABORT = 7, ZFIN = 8, ZRPOS = 9, ZDATA = 10, ZEOF = 11,
      ZFERR = 12, ZCRC = 13, ZCOMPL = 15, ZCAN = 16, ZFREECNT = 17;

// Subpacket terminators, and what each one obliges the receiver to do.
const ZCRCE = 0x68, ZCRCG = 0x69, ZCRCQ = 0x6A, ZCRCW = 0x6B;

// ZRINIT capability bits (byte 0 of the flags, i.e. f0 at index 3).
const CANFDX = 0x01, CANOVIO = 0x02, CANFC32 = 0x20;

// The announcement a ZMODEM sender puts in the terminal stream before its first
// header. Spotting this is what lets a download start itself. Deliberately the
// whole of `**\x18B00` rather than the two asterisks: CAN is rare in ANSI art
// and `B00` after it is a ZRQINIT/ZRINIT hex header, so the false-positive rate
// against a screenful of block graphics is nil.
const ZAUTO = Uint8Array.from([ZPAD, ZPAD, ZDLE, ZHEX, 0x30, 0x30]);

// ─── CRCs ───────────────────────────────────────────────────────────────────
// XMODEM's CRC-16 is MSB-first with polynomial 0x1021 and a zero preset.
//
// NOT BitFrame.crc16, which is the reflected 0x8408 form V.34's Figure 14 draws
// (see HANDOFF.md on the cycle that got that orientation the right way up).
// Both are "CRC-16-CCITT" in casual use and they are not the same function;
// sharing one would have been a wrong constant that round-trips perfectly,
// which is the failure this repo keeps finding.
const CRC16_TAB = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 8;
    for (let j = 0; j < 8; j++) c = (c & 0x8000) ? ((c << 1) ^ 0x1021) & 0xFFFF : (c << 1) & 0xFFFF;
    t[i] = c;
  }
  return t;
})();
function crc16(bytes, from, to) {
  let c = 0;
  for (let i = from; i < to; i++) c = ((c << 8) ^ CRC16_TAB[((c >> 8) ^ bytes[i]) & 0xFF]) & 0xFFFF;
  return c;
}

// ZMODEM's CRC-32 is the reflected 0xEDB88320 form with a 0xFFFFFFFF preset and
// a final inversion — the same function zlib and PNG use.
const CRC32_TAB = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();
function crc32(bytes, from, to, seed) {
  let c = (seed === undefined ? 0xFFFFFFFF : seed) >>> 0;
  for (let i = from; i < to; i++) c = (CRC32_TAB[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8)) >>> 0;
  return c >>> 0;
}
function crc16Seed(bytes, from, to, seed) {
  let c = (seed === undefined ? 0 : seed) & 0xFFFF;
  for (let i = from; i < to; i++) c = ((c << 8) ^ CRC16_TAB[((c >> 8) ^ bytes[i]) & 0xFF]) & 0xFFFF;
  return c;
}

function checksum(bytes, from, to) {
  let s = 0;
  for (let i = from; i < to; i++) s = (s + bytes[i]) & 0xFF;
  return s;
}

// ─── Byte-queue helper ──────────────────────────────────────────────────────
// A growable FIFO over Uint8Arrays. The receivers need arbitrary lookahead
// (a 1029-byte block can arrive in any number of chunks) and the obvious
// implementation — concat on every feed — is quadratic over a 10 MB download.
class ByteQ {
  constructor() { this._b = new Uint8Array(4096); this._r = 0; this._w = 0; }
  get length() { return this._w - this._r; }
  push(bytes) {
    if (this._w + bytes.length > this._b.length) {
      const live = this._w - this._r;
      let cap = this._b.length;
      while (cap < live + bytes.length) cap *= 2;
      const n = new Uint8Array(cap);
      n.set(this._b.subarray(this._r, this._w));
      this._b = n; this._r = 0; this._w = live;
    }
    this._b.set(bytes, this._w); this._w += bytes.length;
  }
  at(i) { return this._b[this._r + i]; }
  shift(n) { this._r += n; if (this._r === this._w) { this._r = this._w = 0; } }
  slice(from, to) { return this._b.slice(this._r + from, this._r + to); }
  clear() { this._r = this._w = 0; }
  // Index of `pat` at or after `from`, or -1. Used for the ZMODEM auto-start
  // sniff and for resynchronising on a ZPAD.
  find(pat, from) {
    outer: for (let i = (from || 0); i + pat.length <= this.length; i++) {
      for (let j = 0; j < pat.length; j++) if (this.at(i + j) !== pat[j]) continue outer;
      return i;
    }
    return -1;
  }
}

// ─── Growable output buffer for a received file ─────────────────────────────
class Sink {
  constructor() { this._b = new Uint8Array(65536); this._n = 0; }
  get length() { return this._n; }
  write(bytes, from, to) {
    const a = from || 0, z = (to === undefined ? bytes.length : to), len = z - a;
    if (this._n + len > this._b.length) {
      let cap = this._b.length;
      while (cap < this._n + len) cap *= 2;
      const n = new Uint8Array(cap); n.set(this._b.subarray(0, this._n));
      this._b = n;
    }
    this._b.set(bytes.subarray(a, z), this._n); this._n += len;
  }
  truncate(n) { if (n < this._n) this._n = n; }
  take() { return this._b.slice(0, this._n); }
}

const enc = (s) => Uint8Array.from(String(s), (c) => c.charCodeAt(0) & 0xFF);
const dec = (b) => Array.from(b, (c) => String.fromCharCode(c)).join('');

// ─── XMODEM / YMODEM / YMODEM-G ─────────────────────────────────────────────
//
// One class for all three because they ARE one protocol: YMODEM is XMODEM-1K
// with a block 0 carrying the filename and a batch terminator, and YMODEM-G is
// YMODEM with the per-block acknowledgement removed. Implementing them
// separately would have been three copies of the same block framing, and the
// CRC would have been transcribed three times.
//
// Timeouts are generous on purpose. A 1024-byte block at 300 bps is 34 seconds
// on the wire, so a timeout chosen for a LAN would abort every Bell 103
// transfer at the first block; the host paces, and a stalled link is better
// ended by the user's Cancel than by a constant nobody can pick for ten
// protocols at once.
const HS_INTERVAL_MS = 3000;     // how often a receiver re-offers C / NAK / G
const HS_TRIES = 20;             // ~60 s of offering before giving up
const ACK_TIMEOUT_MS = 60000;    // sender waiting for an ACK
const BLOCK_TIMEOUT_MS = 60000;  // receiver waiting for the next block
const MAX_RETRIES = 10;

class XYTransfer {
  constructor(opts) {
    this.opts = opts;
    this.proto = opts.protocol;                 // xmodem | xmodem1k | ymodem | ymodem-g
    this.mode = opts.mode;                      // send | receive
    this.batch = this.proto === 'ymodem' || this.proto === 'ymodem-g';
    this.streaming = this.proto === 'ymodem-g';
    this.q = new ByteQ();
    this.done = false;
    this.error = null;
    this.files = [];                            // receive: completed files
    this.cancelled = false;

    // Receive state
    this.sink = null;
    this.expect = 1;                            // next block number, mod 256
    // CRC first for everything. YMODEM has no choice; XMODEM offers 'C' and
    // drops to NAK/checksum only after several unanswered tries, which is what
    // every receiver written since the 1980s does — starting in checksum mode
    // would silently give up the error detection on the one protocol here that
    // has no header to verify against either.
    this.crcMode = true;
    this.wantBlock0 = this.batch;
    this.declaredSize = -1;
    this.name = '';
    this.tries = 0;
    this.nextOffer = 0;
    this.deadline = 0;
    this.eotSeen = 0;
    // Set the moment a block STARTS arriving, not when one finishes. See
    // _rxTick: the offer has to stop on the first sign of an answer, because a
    // block in flight can easily outlast the re-offer interval.
    this.answered = false;

    // Send state
    this.outFiles = (opts.files || []).slice();
    this.fileIdx = -1;
    this.data = null;
    this.pos = 0;
    this.seq = 1;
    this.lastBlock = null;
    this.retries = 0;
    this.sendState = 'wait-mode';
    this.canCount = 0;

    this.state = this.mode === 'receive' ? 'handshake' : 'wait-mode';
    if (this.mode === 'send') this._nextFile();
  }

  // ── plumbing ──────────────────────────────────────────────────────────────
  _send(bytes) { this.opts.send(bytes); }
  _ready() { return this.opts.ready ? this.opts.ready() : true; }
  _fail(msg) {
    if (this.done) return;
    this.error = msg; this.done = true;
    this._send(Uint8Array.from([CAN, CAN, CAN, CAN, CAN, 0x08, 0x08, 0x08, 0x08, 0x08]));
    if (this.opts.onError) this.opts.onError(msg);
  }
  _finish() {
    if (this.done) return;
    this.done = true;
    if (this.opts.onDone) this.opts.onDone(this.files);
  }
  _progress() {
    if (!this.opts.onProgress) return;
    this.opts.onProgress({
      name: this.name,
      bytes: this.mode === 'receive' ? (this.sink ? this.sink.length : 0) : this.pos,
      total: this.mode === 'receive' ? this.declaredSize : (this.data ? this.data.length : -1),
      file: this.mode === 'receive' ? this.files.length + 1 : this.fileIdx + 1,
      files: this.mode === 'receive' ? 0 : this.outFiles.length,
    });
  }
  cancel() {
    if (this.done) return;
    this.cancelled = true;
    this._fail('cancelled');
  }

  // ── public entry points ───────────────────────────────────────────────────
  feed(bytes) {
    if (this.done) return;
    this.deadline = 0;              // the board is talking; re-armed by _rxTick
    this.q.push(bytes);
    this._drain();
  }
  tick(now) {
    if (this.done) return;
    if (this.mode === 'receive') this._rxTick(now);
    else this._txTick(now);
  }
  pump() { if (!this.done && this.mode === 'send') this._txPump(); }

  _drain() {
    if (this.mode === 'receive') this._rxBytes();
    else this._txBytes();
  }

  // ── receive ───────────────────────────────────────────────────────────────
  _offerByte() {
    if (this.streaming) return GCHR;
    return this.crcMode ? CRCCHR : NAK;
  }
  _rxTick(now) {
    // THE OFFER STOPS ON THE FIRST SIGN OF AN ANSWER, not when a block has been
    // parsed. A real board prints a paragraph before it sends anything —
    // "Beginning YMODEM-g download of the 1 file matching…" — and the block
    // that follows can itself take longer than the re-offer interval at BBS
    // speeds. A receiver that kept offering would put a second 'C'/'G' into a
    // sender that has already started.
    //
    // For YMODEM-G that is fatal rather than untidy: a G sender expects nothing
    // from the receiver but CAN, and one observed answer is to resend block 0 —
    // which then fails this end's sequence check, sends five CANs back, and the
    // board reports an operator abort. Invisible over a pipe, where a block
    // lands in microseconds, which is why lrzsz never showed it.
    if (this.state === 'handshake' && !this.answered) {
      if (now < this.nextOffer) return;
      if (this.tries >= HS_TRIES) return this._fail('no response from the board');
      // XMODEM only: after a few unanswered 'C's the sender may be a checksum
      // implementation that has never heard of CRC, so drop to NAK. YMODEM has
      // no such fallback — CRC is not optional there.
      if (!this.batch && this.tries === 6 && this.crcMode) this.crcMode = false;
      this.tries++;
      this.nextOffer = now + HS_INTERVAL_MS;
      this._send(Uint8Array.of(this._offerByte()));
      return;
    }
    // Once something is coming, silence is the only thing left to bound. The
    // deadline is cleared by every feed(), so this is "the board has said
    // nothing at all for a minute" rather than "the transfer is slow" — a 1K
    // block at 300 bps is thirty-four seconds of legitimate quiet on the wire
    // but a steady stream of bytes here.
    if (!this.deadline) { this.deadline = now + BLOCK_TIMEOUT_MS; return; }
    if (now > this.deadline) this._fail('the board stopped sending');
  }

  _rxBytes() {
    for (;;) {
      if (this.done || this.q.length === 0) return;
      const b = this.q.at(0);

      if (b === CAN) {
        this.canCount++;
        this.q.shift(1);
        if (this.canCount >= 2) return this._fail('the board cancelled the transfer');
        continue;
      }
      this.canCount = 0;

      if (b === EOT) {
        this.q.shift(1);
        // The classic two-EOT dance: NAK the first, ACK the second. rz does
        // this and every sender is written to expect it, so a receiver that
        // ACKs the first is the one that has to be explained.
        this.eotSeen++;
        // The two-EOT dance — NAK the first, ACK the second — belongs to the
        // ACKNOWLEDGED protocols, and every sender is written to expect it
        // there. YMODEM-G removed the acknowledgement, so a NAK is a byte its
        // sender has no state for. lrzsz tolerating one is not evidence that a
        // board will.
        if (!this.streaming && this.eotSeen === 1) { this._send(Uint8Array.of(NAK)); continue; }
        this._send(Uint8Array.of(ACK));
        this._closeFile();
        this.eotSeen = 0;
        if (!this.batch) return this._finish();
        // YMODEM: another block 0 follows — either the next file or the empty
        // one that ends the batch.
        this.wantBlock0 = true;
        this.expect = 0;
        this.state = 'handshake';
        this.tries = 0; this.nextOffer = 0; this.deadline = 0;
        this.answered = false;     // the next file has to be asked for again
        continue;
      }

      if (b !== SOH && b !== STX) { this.q.shift(1); continue; }   // garbage between blocks

      // A block header is an answer even when the rest of it has not arrived —
      // this is what stops the handshake, and it must be set BEFORE the
      // length check below returns to wait for the remainder.
      this.answered = true;

      const dataLen = b === SOH ? 128 : 1024;
      const ckLen = this.crcMode ? 2 : 1;
      const need = 3 + dataLen + ckLen;
      if (this.q.length < need) return;                            // wait for the rest

      const blk = this.q.slice(0, need);
      this.q.shift(need);
      const seq = blk[1], inv = blk[2];
      const bodyOK = ((seq + inv) & 0xFF) === 0xFF;
      const ckOK = this.crcMode
        ? ((blk[3 + dataLen] << 8 | blk[4 + dataLen]) === crc16(blk, 3, 3 + dataLen))
        : (blk[3 + dataLen] === checksum(blk, 3, 3 + dataLen));

      if (!bodyOK || !ckOK) {
        if (this.streaming) return this._fail('block error (YMODEM-G cannot retry)');
        this.q.clear();
        this._send(Uint8Array.of(NAK));
        continue;
      }

      if (this.wantBlock0 && seq === 0) {
        this._block0(blk.subarray(3, 3 + dataLen));
        continue;
      }
      // A repeated block 0 mid-file: the sender missed our ACK, or a stray byte
      // made it restart. Acknowledge and discard. Treating it as a sequence
      // error is what turned one stray offer byte into a cancelled transfer.
      if (seq === 0 && this.batch && !this.wantBlock0) {
        if (!this.streaming) this._send(Uint8Array.of(ACK));
        continue;
      }
      if (seq === ((this.expect - 1) & 0xFF)) {
        // A block we already have: the sender never saw our ACK. Acknowledge
        // and discard — NOT an error, and NOT written twice into the file.
        if (!this.streaming) this._send(Uint8Array.of(ACK));
        continue;
      }
      if (seq !== this.expect) {
        if (this.streaming) return this._fail('block sequence error (YMODEM-G cannot retry)');
        this.q.clear();
        this._send(Uint8Array.of(NAK));
        continue;
      }

      if (!this.sink) this.sink = new Sink();
      let end = 3 + dataLen;
      // A declared size is the only thing that can strip the padding exactly.
      // Without one (XMODEM has no header) the trailing CPMEOF/NUL run is all
      // there is to go on, and trimming it would corrupt any binary file that
      // legitimately ends in 0x1A — so XMODEM keeps the padding, which is the
      // protocol's own well-known limitation rather than something to guess at.
      this.sink.write(blk, 3, end);
      if (this.declaredSize >= 0 && this.sink.length > this.declaredSize) {
        this.sink.truncate(this.declaredSize);
      }
      this.expect = (this.expect + 1) & 0xFF;
      // Blocks are arriving, so the periodic offer has done its job. XMODEM has
      // no block 0 to move it out of the handshake, so this is the only place
      // it can happen — without it the receiver keeps sending C into a live
      // data stream and eventually calls the transfer dead on its own tries.
      this.state = 'data';
      if (!this.streaming) this._send(Uint8Array.of(ACK));
      this.deadline = 0;
      this._progress();
    }
  }

  _block0(body) {
    // "name\0size mtime mode serial\0", NUL-padded. Only the name and the size
    // are load-bearing here; the rest is advisory and boards vary.
    let i = 0; while (i < body.length && body[i] !== 0) i++;
    const name = dec(body.subarray(0, i));
    if (!name) {                       // the empty block 0 that ends a batch
      this._send(Uint8Array.of(ACK));
      return this._finish();
    }
    let j = i + 1, k = j; while (k < body.length && body[k] !== 0) k++;
    const rest = dec(body.subarray(j, k)).trim().split(/\s+/);
    const size = rest.length ? parseInt(rest[0], 10) : NaN;
    this.name = name;
    this.declaredSize = Number.isFinite(size) && size >= 0 ? size : -1;
    this.sink = new Sink();
    this.expect = 1;
    this.wantBlock0 = false;
    if (this.opts.onFile) this.opts.onFile({ name, size: this.declaredSize });
    this._send(Uint8Array.of(ACK));
    // The second offer is what starts the data: block 0 is acknowledged, then
    // the receiver asks again, exactly as it did to start the file.
    this._send(Uint8Array.of(this._offerByte()));
    this.state = 'data';
    this._progress();
  }

  _closeFile() {
    if (!this.sink) return;
    let data = this.sink.take();
    if (this.declaredSize >= 0 && data.length > this.declaredSize) {
      data = data.subarray(0, this.declaredSize);
    }
    this.files.push({ name: this.name || '', data });
    this.sink = null; this.declaredSize = -1; this.name = '';
  }

  // ── send ──────────────────────────────────────────────────────────────────
  _nextFile() {
    this.fileIdx++;
    if (this.fileIdx >= this.outFiles.length) { this.data = null; return false; }
    const f = this.outFiles[this.fileIdx];
    this.name = f.name || 'FILE';
    this.data = f.data;
    this.mtime = f.mtime || 0;
    this.pos = 0; this.seq = 1;
    return true;
  }

  _mkBlock(seq, chunk, want1k) {
    const len = want1k ? 1024 : 128;
    const out = new Uint8Array(3 + len + (this.crcMode ? 2 : 1));
    out[0] = want1k ? STX : SOH;
    out[1] = seq & 0xFF;
    out[2] = (~seq) & 0xFF;
    out.fill(SUB, 3, 3 + len);                 // CPMEOF pad, as every sender does
    out.set(chunk, 3);
    if (this.crcMode) {
      const c = crc16(out, 3, 3 + len);
      out[3 + len] = (c >> 8) & 0xFF; out[4 + len] = c & 0xFF;
    } else {
      out[3 + len] = checksum(out, 3, 3 + len);
    }
    return out;
  }

  _mkBlock0(f) {
    const body = new Uint8Array(128);
    if (f) {
      const head = enc(`${f.name}\0${f.data.length} ${(f.mtime || 0).toString(8)}\0`);
      body.set(head.subarray(0, 128));
    }
    // An empty block 0 — all NULs — is the batch terminator, which is why the
    // `f` branch is the only difference between the two.
    const out = new Uint8Array(3 + 128 + 2);
    out[0] = SOH; out[1] = 0; out[2] = 0xFF;
    out.set(body, 3);
    const c = crc16(out, 3, 131);
    out[131] = (c >> 8) & 0xFF; out[132] = c & 0xFF;
    return out;
  }

  _txTick(now) {
    if (this.state === 'wait-mode') {
      if (!this.deadline) this.deadline = now + HS_INTERVAL_MS * HS_TRIES;
      if (now > this.deadline) this._fail('the board never asked for the file');
      return;
    }
    if (this.deadline && now > this.deadline) {
      if (this.retries++ >= MAX_RETRIES) return this._fail('too many retries');
      this.deadline = now + ACK_TIMEOUT_MS;
      if (this.state === 'eot') this._send(Uint8Array.of(EOT));
      else if (this.lastBlock) this._send(this.lastBlock);
    }
  }

  _txBytes() {
    for (;;) {
      if (this.done || this.q.length === 0) return;
      const b = this.q.at(0);
      this.q.shift(1);

      if (b === CAN) {
        if (++this.canCount >= 2) return this._fail('the board cancelled the transfer');
        continue;
      }
      this.canCount = 0;

      switch (this.state) {
        case 'wait-mode':
          if (b === CRCCHR || b === NAK || b === GCHR) {
            this.crcMode = b !== NAK;
            // The RECEIVER decides whether this is a G transfer. We may have
            // been asked for YMODEM-G and be talking to a board that only does
            // YMODEM — follow what it actually sent, or every block after the
            // first is unacknowledged into a peer that is waiting to ACK.
            this.streaming = b === GCHR;
            this.retries = 0;
            if (this.batch) {
              this.lastBlock = this._mkBlock0(this.outFiles[this.fileIdx]);
              this._send(this.lastBlock);
              this.state = 'block0-ack';
              this.deadline = 0;
            } else {
              this.state = 'data';
              this._txPump();
            }
          }
          continue;

        case 'block0-ack':
          if (b === ACK) { this.state = 'await-offer'; this.retries = 0; }
          else if (b === NAK) { this._send(this.lastBlock); }
          continue;

        case 'await-offer':
          // The receiver asks a second time; that offer is what starts the data
          // and is also where a G transfer is finally settled.
          if (b === CRCCHR || b === GCHR || b === NAK) {
            this.streaming = b === GCHR;
            this.state = 'data';
            this._progress();
            this._txPump();
          }
          continue;

        case 'data':
          if (this.streaming) continue;          // G: the receiver says nothing
          if (b === ACK) {
            // An ACK with nothing in flight is the ECHO of a block the receiver
            // already had — it acknowledges every copy it is sent, and a sender
            // that counted both would advance twice for one block and put the
            // rest of the file at the wrong offset. Nothing downstream can
            // catch that: every block still carries a valid CRC.
            if (!this.outstanding) continue;
            this.outstanding = false;
            this.pos += this.lastChunk;
            this.retries = 0;
            this.seq = (this.seq + 1) & 0xFF;
            this._progress();
            this._txPump();
          } else if (b === NAK) {
            if (this.retries++ >= MAX_RETRIES) return this._fail('too many retries');
            this._send(this.lastBlock);
            this.deadline = 0;
          }
          continue;

        case 'eot':
          // A NAK here is the first half of the receiver's two-EOT dance, not
          // an error: send the second one.
          if (b === NAK) { this._send(Uint8Array.of(EOT)); continue; }
          if (b === ACK) {
            this.retries = 0;
            if (!this.batch) return this._finish();
            this.state = 'batch-offer';
            this.deadline = 0;
          }
          continue;

        case 'batch-offer':
          if (b === CRCCHR || b === GCHR || b === NAK) {
            this.streaming = b === GCHR;
            if (this._nextFile()) {
              this.lastBlock = this._mkBlock0(this.outFiles[this.fileIdx]);
              this._send(this.lastBlock);
              this.state = 'block0-ack';
            } else {
              this.lastBlock = this._mkBlock0(null);
              this._send(this.lastBlock);
              this.state = 'batch-end';
            }
          }
          continue;

        case 'batch-end':
          if (b === ACK) return this._finish();
          if (b === NAK) this._send(this.lastBlock);
          continue;
      }
    }
  }

  // Emit as much as the transport will take. One block for a lock-step
  // protocol, everything that fits for a streaming one — the difference between
  // YMODEM and YMODEM-G in one branch.
  _txPump() {
    if (this.done || this.state !== 'data') return;
    // A lock-step protocol has at most ONE block in flight. pump() is called
    // whenever the transport drains, which is far more often than once per
    // block, so without this the same block goes out repeatedly — the receiver
    // ACKs each copy, the sender counts each ACK as progress, and the two ends
    // walk off the sequence together. It presents as a transfer that completes
    // and then hangs in the batch terminator.
    if (this.outstanding && !this.streaming) return;
    do {
      if (!this._ready()) return;
      const left = this.data.length - this.pos;
      if (left <= 0) {
        this.state = 'eot';
        this.lastBlock = null;
        this._send(Uint8Array.of(EOT));
        this.deadline = 0; this.retries = 0;
        return;
      }
      const want1k = (this.proto !== 'xmodem') && left > 128;
      const size = want1k ? 1024 : 128;
      const chunk = this.data.subarray(this.pos, Math.min(this.pos + size, this.data.length));
      this.lastChunk = chunk.length;
      this.lastBlock = this._mkBlock(this.seq, chunk, want1k);
      this._send(this.lastBlock);
      this.deadline = 0;
      this.outstanding = !this.streaming;
      if (this.streaming) {
        // Nothing will acknowledge this, so the sender advances itself.
        this.pos += chunk.length;
        this.seq = (this.seq + 1) & 0xFF;
        this._progress();
      }
    } while (this.streaming);
  }
}

// ─── ZMODEM ─────────────────────────────────────────────────────────────────
//
// The one protocol here that STREAMS by default and recovers without restarting
// the file, and the only one whose receiver can be started by the sender — the
// `**\x18B00` announcement is what makes a download begin by itself when the
// board's D command is typed.
//
// What is implemented is the transfer core: ZRQINIT/ZRINIT, ZFILE/ZRPOS/ZDATA/
// ZEOF/ZFIN, hex and binary headers, CRC-16 and CRC-32 subpackets, and ZDLE
// escaping. What is NOT: compression (never widely used), ZCOMMAND (a remote
// shell, which is not something a terminal should offer a board), and the
// crash-recovery half of ZRPOS beyond honouring a position the peer asks for.
//
// ZDLE escaping is the part that has to be exactly right in both directions: a
// missed escape does not corrupt a byte, it desynchronises the frame and the
// transfer dies several kilobytes later where the cause is invisible.
const ZDLE_ESC = [ZDLE, 0x10, 0x11, 0x13, 0x90, 0x91, 0x93];
function zNeedsEscape(b) {
  return ZDLE_ESC.indexOf(b) >= 0;
}
function zEscapeInto(out, b) {
  if (zNeedsEscape(b)) { out.push(ZDLE, b ^ 0x40); return; }
  out.push(b);
}
const HEXD = '0123456789abcdef';
function hexByte(out, b) { out.push(HEXD.charCodeAt((b >> 4) & 0xF), HEXD.charCodeAt(b & 0xF)); }
function unhex(a, b) {
  const h = (c) => (c >= 0x30 && c <= 0x39) ? c - 0x30
                 : (c >= 0x61 && c <= 0x66) ? c - 0x57
                 : (c >= 0x41 && c <= 0x46) ? c - 0x37 : -1;
  const x = h(a), y = h(b);
  return (x < 0 || y < 0) ? -1 : (x << 4) | y;
}

const ZM_TIMEOUT_MS = 60000;
const ZM_SUBPACKET = 1024;

class ZTransfer {
  constructor(opts) {
    this.opts = opts;
    this.proto = 'zmodem';
    this.mode = opts.mode;
    this.q = new ByteQ();
    this.done = false; this.error = null; this.cancelled = false;
    this.files = [];
    this.deadline = 0;

    // Receive
    this.sink = null; this.name = ''; this.declaredSize = -1; this.offset = 0;
    this.rxData = false;            // inside a ZDATA run
    this.use32 = true;

    // Send
    this.outFiles = (opts.files || []).slice();
    this.fileIdx = -1; this.data = null; this.pos = 0;
    this.peerCan32 = false; this.started = false;
    this.state = 'init';

    if (this.mode === 'send') {
      this._nextFile();
      this._hexHeader(ZRQINIT, [0, 0, 0, 0]);
      this.state = 'wait-zrinit';
    } else {
      // A receiver announces itself; a sender that is already talking will see
      // it, and one that has not started yet is prompted by it.
      this._sendZRINIT();
      this.state = 'wait-file';
    }
  }

  _send(b) { this.opts.send(b instanceof Uint8Array ? b : Uint8Array.from(b)); }
  _ready() { return this.opts.ready ? this.opts.ready() : true; }
  _fail(msg) {
    if (this.done) return;
    this.error = msg; this.done = true;
    this._send([ZDLE, ZDLE, ZDLE, ZDLE, CAN, CAN, CAN, CAN, CAN, 0x08, 0x08, 0x08, 0x08, 0x08]);
    if (this.opts.onError) this.opts.onError(msg);
  }
  _finish() {
    if (this.done) return;
    this.done = true;
    if (this.opts.onDone) this.opts.onDone(this.files);
  }
  cancel() { if (!this.done) { this.cancelled = true; this._fail('cancelled'); } }
  _progress() {
    if (!this.opts.onProgress) return;
    this.opts.onProgress({
      name: this.name,
      bytes: this.mode === 'receive' ? (this.sink ? this.sink.length : 0) : this.pos,
      total: this.mode === 'receive' ? this.declaredSize : (this.data ? this.data.length : -1),
      file: this.mode === 'receive' ? this.files.length + 1 : this.fileIdx + 1,
      files: this.mode === 'receive' ? 0 : this.outFiles.length,
    });
  }

  // ── header construction ───────────────────────────────────────────────────
  _hexHeader(type, f) {
    const out = [ZPAD, ZPAD, ZDLE, ZHEX];
    hexByte(out, type);
    for (let i = 0; i < 4; i++) hexByte(out, f[i] & 0xFF);
    const body = Uint8Array.from([type, f[0] & 0xFF, f[1] & 0xFF, f[2] & 0xFF, f[3] & 0xFF]);
    const c = crc16(body, 0, 5);
    hexByte(out, (c >> 8) & 0xFF); hexByte(out, c & 0xFF);
    out.push(0x0D, 0x0A);
    // XON after a hex header, as the protocol specifies, so a link with
    // software flow control in the middle is not left stopped.
    if (type !== ZFIN && type !== ZACK) out.push(0x11);
    this._send(out);
  }
  _binHeader(type, f) {
    const out = [ZPAD, ZDLE, this.peerCan32 ? ZBIN32 : ZBIN];
    const body = Uint8Array.from([type, f[0] & 0xFF, f[1] & 0xFF, f[2] & 0xFF, f[3] & 0xFF]);
    for (let i = 0; i < 5; i++) zEscapeInto(out, body[i]);
    if (this.peerCan32) {
      const c = (crc32(body, 0, 5) ^ 0xFFFFFFFF) >>> 0;
      for (let i = 0; i < 4; i++) zEscapeInto(out, (c >>> (8 * i)) & 0xFF);
    } else {
      const c = crc16(body, 0, 5);
      zEscapeInto(out, (c >> 8) & 0xFF); zEscapeInto(out, c & 0xFF);
    }
    this._send(out);
  }
  _subpacket(bytes, from, to, term) {
    const out = [];
    for (let i = from; i < to; i++) zEscapeInto(out, bytes[i]);
    out.push(ZDLE, term);
    if (this.peerCan32) {
      let c = crc32(bytes, from, to);
      c = crc32(Uint8Array.of(term), 0, 1, c);
      c = (c ^ 0xFFFFFFFF) >>> 0;
      for (let i = 0; i < 4; i++) zEscapeInto(out, (c >>> (8 * i)) & 0xFF);
    } else {
      let c = crc16Seed(bytes, from, to, 0);
      c = crc16Seed(Uint8Array.of(term), 0, 1, c);
      zEscapeInto(out, (c >> 8) & 0xFF); zEscapeInto(out, c & 0xFF);
    }
    this._send(out);
  }
  _sendZRINIT() {
    // CANFC32 is advertised because a 32-bit subpacket CRC is worth having on a
    // link with no error correction of its own — which is every modem path here.
    this._hexHeader(ZRINIT, [0, 0, 0, CANFDX | CANOVIO | CANFC32]);
  }
  static pos32(n) { return [n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF]; }

  // ── parsing ───────────────────────────────────────────────────────────────
  feed(bytes) { if (this.done) return; this.q.push(bytes); this._drain(); }
  tick(now) {
    if (this.done) return;
    if (!this.deadline) { this.deadline = now + ZM_TIMEOUT_MS; return; }
    if (now > this.deadline) this._fail('timed out waiting for the board');
  }
  pump() { if (!this.done && this.mode === 'send') this._txPump(); }

  _drain() {
    for (;;) {
      if (this.done) return;
      if (this.rxData) { if (!this._readSubpacket()) return; continue; }
      if (!this._readHeader()) return;
    }
  }

  // Find and parse one header. Returns false when more bytes are needed.
  _readHeader() {
    const i = this.q.find(Uint8Array.of(ZPAD), 0);
    if (i < 0) { if (this.q.length > 4096) this.q.clear(); return false; }
    if (i > 0) this.q.shift(i);
    if (this.q.length < 3) return false;
    let p = 1;
    if (this.q.at(p) === ZPAD) p++;
    if (this.q.at(p) !== ZDLE) { this.q.shift(1); return true; }
    p++;
    if (this.q.length <= p) return false;
    const kind = this.q.at(p); p++;

    if (kind === ZHEX) {
      const need = p + 14;
      if (this.q.length < need) return false;
      const raw = this.q.slice(p, p + 14);
      const b = [];
      for (let k = 0; k < 7; k++) {
        const v = unhex(raw[k * 2], raw[k * 2 + 1]);
        if (v < 0) { this.q.shift(1); return true; }
        b.push(v);
      }
      const body = Uint8Array.from(b.slice(0, 5));
      if (crc16(body, 0, 5) !== ((b[5] << 8) | b[6])) { this.q.shift(1); return true; }
      let end = need;
      // CR LF [XON] trailer, however much of it the peer sent.
      while (end < this.q.length && (this.q.at(end) === 0x0D || this.q.at(end) === 0x0A ||
                                     this.q.at(end) === 0x11 || this.q.at(end) === 0x8A ||
                                     this.q.at(end) === 0x8D)) end++;
      this.q.shift(end);
      this._header(body[0], body.subarray(1));
      return true;
    }

    if (kind === ZBIN || kind === ZBIN32) {
      const n = kind === ZBIN32 ? 9 : 7;      // 5 body + CRC
      const got = this._unescape(p, n);
      if (!got) return false;
      const body = got.bytes;
      let ok;
      if (kind === ZBIN32) {
        const want = (body[5] | (body[6] << 8) | (body[7] << 16) | (body[8] << 24)) >>> 0;
        ok = ((crc32(body, 0, 5) ^ 0xFFFFFFFF) >>> 0) === want;
      } else {
        ok = crc16(body, 0, 5) === ((body[5] << 8) | body[6]);
      }
      if (!ok) { this.q.shift(1); return true; }
      this.q.shift(p + got.consumed);
      this.use32 = kind === ZBIN32;
      this._header(body[0], body.subarray(1));
      return true;
    }

    this.q.shift(1);
    return true;
  }

  // Pull `n` unescaped bytes starting at queue offset `from`.
  _unescape(from, n) {
    const out = new Uint8Array(n);
    let got = 0, i = from;
    while (got < n) {
      if (i >= this.q.length) return null;
      let b = this.q.at(i++);
      if (b === ZDLE) {
        if (i >= this.q.length) return null;
        b = this.q.at(i++) ^ 0x40;
      }
      out[got++] = b;
    }
    return { bytes: out, consumed: i - from };
  }

  _header(type, f) {
    this.deadline = 0;
    switch (type) {
      case ZRQINIT:
        if (this.mode === 'receive') this._sendZRINIT();
        return;
      case ZRINIT:
        if (this.mode !== 'send') return;
        this.peerCan32 = !!(f[3] & CANFC32);
        if (this.state === 'wait-zrinit' || this.state === 'next-file') this._sendFile();
        return;
      case ZFILE:
        this.rxData = true; this.pendingFile = true;
        return;
      case ZDATA:
        if (this.mode !== 'receive') return;
        this.rxData = true;
        this.offset = (f[0] | (f[1] << 8) | (f[2] << 16) | (f[3] << 24)) >>> 0;
        if (this.sink && this.offset < this.sink.length) this.sink.truncate(this.offset);
        return;
      case ZEOF:
        if (this.mode !== 'receive') return;
        this._closeFile();
        this._sendZRINIT();
        return;
      case ZFIN:
        this._hexHeader(ZFIN, [0, 0, 0, 0]);
        this._send([0x4F, 0x4F]);              // "OO" — over and out
        if (this.mode === 'receive') this._finish();
        else this._finish();
        return;
      case ZRPOS:
        if (this.mode !== 'send') return;
        this.pos = (f[0] | (f[1] << 8) | (f[2] << 16) | (f[3] << 24)) >>> 0;
        this.state = 'data';
        this._binHeader(ZDATA, ZTransfer.pos32(this.pos));
        this._txPump();
        return;
      case ZACK:
        if (this.mode === 'send' && this.state === 'data') this._txPump();
        return;
      case ZSKIP:
        if (this.mode !== 'send') return;
        this._nextFileOrFinish();
        return;
      case ZNAK:
        return;
      case ZABORT: case ZCAN:
        this._fail('the board cancelled the transfer');
        return;
      default:
        return;
    }
  }

  // One data subpacket. Returns false when more bytes are needed.
  _readSubpacket() {
    // Scan for the ZDLE that introduces a terminator, unescaping as we go.
    const body = [];
    let i = 0;
    for (;;) {
      if (i >= this.q.length) return false;
      const b = this.q.at(i++);
      if (b !== ZDLE) { body.push(b); continue; }
      if (i >= this.q.length) return false;
      const e = this.q.at(i++);
      if (e === ZCRCE || e === ZCRCG || e === ZCRCQ || e === ZCRCW) {
        const nCRC = this.use32 ? 4 : 2;
        const got = this._unescape(i, nCRC);
        if (!got) return false;
        const data = Uint8Array.from(body);
        let ok;
        if (this.use32) {
          let c = crc32(data, 0, data.length);
          c = crc32(Uint8Array.of(e), 0, 1, c);
          c = (c ^ 0xFFFFFFFF) >>> 0;
          const want = (got.bytes[0] | (got.bytes[1] << 8) |
                        (got.bytes[2] << 16) | (got.bytes[3] << 24)) >>> 0;
          ok = c === want;
        } else {
          let c = crc16Seed(data, 0, data.length, 0);
          c = crc16Seed(Uint8Array.of(e), 0, 1, c);
          ok = c === ((got.bytes[0] << 8) | got.bytes[1]);
        }
        this.q.shift(i + got.consumed);
        if (!ok) {
          this.rxData = false;
          this._hexHeader(ZRPOS, ZTransfer.pos32(this.sink ? this.sink.length : 0));
          return true;
        }
        this._subpacketOK(data, e);
        return true;
      }
      body.push(e ^ 0x40);
    }
  }

  _subpacketOK(data, term) {
    if (this.pendingFile) {
      this.pendingFile = false;
      this.rxData = false;
      this._fileHeader(data);
      return;
    }
    if (!this.sink) this.sink = new Sink();
    this.sink.write(data, 0, data.length);
    this.offset += data.length;
    this._progress();
    if (term === ZCRCW) { this.rxData = false; this._hexHeader(ZACK, ZTransfer.pos32(this.sink.length)); }
    else if (term === ZCRCQ) { this._hexHeader(ZACK, ZTransfer.pos32(this.sink.length)); }
    else if (term === ZCRCE) { this.rxData = false; }
    // ZCRCG: keep streaming, say nothing. That is the fast path and the reason
    // ZMODEM outruns YMODEM on a link with any latency at all.
  }

  _fileHeader(data) {
    let i = 0; while (i < data.length && data[i] !== 0) i++;
    this.name = dec(data.subarray(0, i));
    const rest = dec(data.subarray(i + 1)).trim().split(/\s+/);
    const size = rest.length ? parseInt(rest[0], 10) : NaN;
    this.declaredSize = Number.isFinite(size) && size >= 0 ? size : -1;
    this.sink = new Sink();
    this.offset = 0;
    if (this.opts.onFile) this.opts.onFile({ name: this.name, size: this.declaredSize });
    this._progress();
    this._hexHeader(ZRPOS, [0, 0, 0, 0]);
  }

  _closeFile() {
    if (!this.sink) return;
    let data = this.sink.take();
    if (this.declaredSize >= 0 && data.length > this.declaredSize) {
      data = data.subarray(0, this.declaredSize);
    }
    this.files.push({ name: this.name, data });
    this.sink = null; this.declaredSize = -1; this.name = '';
  }

  // ── send side ─────────────────────────────────────────────────────────────
  _nextFile() {
    this.fileIdx++;
    if (this.fileIdx >= this.outFiles.length) { this.data = null; return false; }
    const f = this.outFiles[this.fileIdx];
    this.name = f.name || 'FILE';
    this.data = f.data; this.mtime = f.mtime || 0;
    this.pos = 0;
    return true;
  }
  _sendFile() {
    if (!this.data) { this._hexHeader(ZFIN, [0, 0, 0, 0]); this.state = 'fin'; return; }
    this.state = 'wait-zrpos';
    this._binHeader(ZFILE, [0, 0, 0, 0]);
    const info = enc(`${this.name}\0${this.data.length} ${(this.mtime || 0).toString(8)} 0 0 1 ${this.data.length}\0`);
    this._subpacket(info, 0, info.length, ZCRCW);
  }
  _nextFileOrFinish() {
    if (this._nextFile()) { this.state = 'next-file'; this._sendFile(); }
    else { this._hexHeader(ZFIN, [0, 0, 0, 0]); this.state = 'fin'; }
  }
  _txPump() {
    if (this.done || this.state !== 'data') return;
    while (this.pos < this.data.length) {
      if (!this._ready()) return;
      const end = Math.min(this.pos + ZM_SUBPACKET, this.data.length);
      const last = end >= this.data.length;
      this._subpacket(this.data, this.pos, end, last ? ZCRCE : ZCRCG);
      this.pos = end;
      this._progress();
    }
    if (this.pos >= this.data.length) {
      this._binHeader(ZEOF, ZTransfer.pos32(this.pos));
      this.state = 'eof';
      this._nextFilePending = true;
      // The peer answers ZEOF with a fresh ZRINIT, which is where the next file
      // (or ZFIN) goes out — see the ZRINIT case in _header().
      this.state = 'next-file';
      this._nextFileIndexAdvance();
    }
  }
  _nextFileIndexAdvance() {
    if (!this._nextFile()) { this.data = null; }
  }
}

// ─── Stream sniffing ────────────────────────────────────────────────────────
//
// What lets a download start itself, and what lets the panel pre-select a
// protocol instead of asking. Deliberately a passive observer over the terminal
// stream rather than anything that consumes bytes: it is wrong often enough
// (a board that prints `**` at the wrong moment) that it must never be able to
// eat a byte the terminal was going to draw.
//
// `C`/`NAK`/`G` polling is the other half. A receiver offering a transfer sends
// one of those about once every three seconds with nothing else in between, so
// three of them inside twenty seconds with no other traffic is a board waiting
// for an upload — and which one it sent says whether it wants CRC, checksum or
// G, which is exactly what the sender would otherwise have to be told.
class Sniffer {
  constructor() { this.reset(); }
  reset() {
    this.tail = [];
    this.polls = [];
    this.lastPoll = 0;
    this.zmodem = false;
    this.pollByte = 0;
  }
  /** @returns {null|{kind:'zmodem'}|{kind:'poll',byte:number}} */
  feed(bytes, now) {
    let hit = null;
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      this.tail.push(b);
      if (this.tail.length > ZAUTO.length) this.tail.shift();
      if (this.tail.length === ZAUTO.length) {
        let m = true;
        for (let j = 0; j < ZAUTO.length; j++) if (this.tail[j] !== ZAUTO[j]) { m = false; break; }
        if (m) { this.zmodem = true; hit = { kind: 'zmodem' }; }
      }
      if (b === CRCCHR || b === NAK || b === GCHR) {
        this.polls.push(now); this.pollByte = b;
      } else if (b !== 0x0D && b !== 0x0A && b !== 0x00) {
        // Any real output resets it: 'C' is a letter, and a board printing
        // "Choose:" is not offering a transfer.
        this.polls.length = 0;
      }
      while (this.polls.length && now - this.polls[0] > 20000) this.polls.shift();
      if (!hit && this.polls.length >= 3) hit = { kind: 'poll', byte: this.pollByte };
    }
    return hit;
  }
  /** The protocol a poll byte implies, for pre-selecting the picker. */
  static protoForPoll(b) {
    if (b === GCHR) return 'ymodem-g';
    if (b === NAK) return 'xmodem';
    return 'ymodem';
  }
}

// ─── Factory ────────────────────────────────────────────────────────────────
const PROTOCOLS = ['xmodem', 'xmodem1k', 'ymodem', 'ymodem-g', 'zmodem'];
const PROTOCOL_LABELS = {
  'xmodem':   'XMODEM',
  'xmodem1k': 'XMODEM-1K',
  'ymodem':   'YMODEM',
  'ymodem-g': 'YMODEM-G',
  'zmodem':   'ZMODEM',
};

/**
 * @param {object} opts
 *   protocol   one of PROTOCOLS
 *   mode       'send' | 'receive'
 *   files      [{name, data:Uint8Array, mtime}] — send only
 *   send(u8)   write bytes to the board
 *   ready()    does the transport want more right now?
 *   onFile     ({name,size}) a receive has started a file
 *   onProgress ({name,bytes,total,file,files})
 *   onDone     (files) — receive hands back [{name,data}]
 *   onError    (message)
 */
function createTransfer(opts) {
  if (PROTOCOLS.indexOf(opts.protocol) < 0) throw new Error(`unknown protocol ${opts.protocol}`);
  if (opts.mode !== 'send' && opts.mode !== 'receive') throw new Error('mode must be send or receive');
  return opts.protocol === 'zmodem' ? new ZTransfer(opts) : new XYTransfer(opts);
}

const API = {
  createTransfer, Sniffer, PROTOCOLS, PROTOCOL_LABELS,
  // Exported for the harness, which asserts them against the published tables
  // rather than against a round trip — a CRC both ends compute the same way is
  // not a checked CRC. → HANDOFF.md.
  crc16, crc32, crc16Seed, checksum, ZAUTO,
  XYTransfer, ZTransfer, ByteQ,
  SOH, STX, EOT, ACK, NAK, CAN, SUB, CRCCHR, GCHR,
  ZPAD, ZDLE, ZBIN, ZHEX, ZBIN32,
  ZRQINIT, ZRINIT, ZFILE, ZSKIP, ZNAK, ZABORT, ZFIN, ZRPOS, ZDATA, ZEOF, ZACK, ZCAN,
  ZCRCE, ZCRCG, ZCRCQ, ZCRCW,
};

// Classic script for the browser, the way rxjitter.js is; require()-able from
// the harness off the same file on disk.
if (typeof window !== 'undefined') window.Xfer = API;
if (typeof module !== 'undefined' && module.exports) module.exports = API;

})(typeof globalThis !== 'undefined' ? globalThis : this);
