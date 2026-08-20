'use strict';
/**
 * lib/telnet.js — telnet (RFC 854) option negotiation, terminated at the server.
 *
 * This is the *only* implementation of TelnetFilter in the tree. It used to live
 * in `public/terminal.js` and run in the browser, which meant every IAC byte was
 * modulated across the modem link in both directions. It now runs server-side:
 * negotiation replies go straight out the TCP socket and never cost carrier time.
 * See the telnet-termination session in DEVLOG.md.
 *
 * Deliberately dependency-free (plain Uint8Array, no Node built-ins, no DOM) so
 * it stays trivially testable in-process and could be loaded anywhere. CommonJS,
 * because `server.js` is CommonJS and `package.json` has no "type" field.
 *
 * Usage:
 *   const filter = new TelnetFilter();
 *   filter.onData = (bytes) => ...;   // payload, IAC sequences removed
 *   filter.onSend = (bytes) => ...;   // negotiation replies → write to the peer
 *   filter.process(chunk);            // both callbacks fire synchronously
 *   filter.negotiate();               // proactively request SGA (call on carrier up)
 *
 * State is per-connection: construct one per session, never share.
 */

// ─── Protocol constants ─────────────────────────────────────────────────────
const IAC  = 0xFF;  // Interpret As Command
const SE   = 0xF0;  // End of subnegotiation
const SB   = 0xFA;  // Begin subnegotiation
const WILL = 0xFB;
const WONT = 0xFC;
const DO   = 0xFD;
const DONT = 0xFE;

const OPT_SGA   = 0x03;  // Suppress Go Ahead (RFC 858)
const OPT_TTYPE = 0x18;  // Terminal Type     (RFC 1091) — 24
const OPT_NAWS  = 0x1F;  // Window Size       (RFC 1073) — 31

const TTYPE_IS   = 0x00;
const TTYPE_SEND = 0x01;

// The renderer is fixed at an 80×25 CP437 ANSI grid, so these are constants
// rather than negotiated capabilities — that is precisely why answering them
// belongs on the server, which knows the terminal it is speaking for.
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 25;

// Conventional TTYPE cycle. Many BBSes probe repeatedly, walking the client's
// list, and expect it to terminate by repeating the final entry.
const DEFAULT_TERM_TYPES = ['ANSI', 'ANSI-BBS', 'UNKNOWN'];

class TelnetFilter {
  /**
   * @param {object} [opts]
   * @param {number} [opts.cols=80]
   * @param {number} [opts.rows=25]
   * @param {string[]} [opts.termTypes] terminal-type cycle, last entry repeats
   */
  constructor(opts = {}) {
    this._state = 'DATA';
    this._cmd = 0;
    this._sbBuf = [];

    this.onData = null;
    this.onSend = null;

    this.cols = opts.cols || DEFAULT_COLS;
    this.rows = opts.rows || DEFAULT_ROWS;
    this.termTypes = (opts.termTypes && opts.termTypes.length)
      ? opts.termTypes.slice()
      : DEFAULT_TERM_TYPES.slice();
    this._ttypeIndex = 0;

    // Per-option agreement state. Flags make the proactive negotiate() and the
    // peer's replies loop-safe: we only answer on a genuine state change.
    this._sgaLocal   = false;  // we have agreed to WILL SGA (we suppress our GA)
    this._sgaRemote  = false;  // we have agreed to DO SGA   (peer suppresses its GA)
    this._ttypeLocal = false;  // we have agreed to WILL TTYPE
    this._nawsLocal  = false;  // we have agreed to WILL NAWS
    this._nawsSent   = false;  // the one-and-only size subnegotiation has gone out
  }

  /**
   * Proactively request Suppress Go Ahead in both directions, the way synthdoor's
   * server negotiated full-duplex with its clients.
   *
   * Call this on CARRIER UP, not on TCP connect. Tempting to do it earlier now
   * that the server owns it, but some BBSes expect a prompt keystroke (an ANSI
   * probe, a "press a key" window, a menu timeout), and anything the BBS says
   * before carrier is text the user cannot yet answer. See DEVLOG.md.
   */
  negotiate() {
    this._sgaLocal = true;
    this._sgaRemote = true;
    this._send([IAC, WILL, OPT_SGA, IAC, DO, OPT_SGA]);
  }

  /**
   * Feed received bytes. Payload goes to onData; replies go to onSend. Both fire
   * synchronously. Chunk boundaries are arbitrary — the state machine carries
   * across calls, including mid-subnegotiation.
   * @param {Uint8Array|Buffer|number[]} bytes
   */
  process(bytes) {
    const out = [];
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      switch (this._state) {
        case 'DATA':
          if (b === IAC) this._state = 'IAC';
          else out.push(b);
          break;

        case 'IAC':
          if (b === IAC) { out.push(IAC); this._state = 'DATA'; }   // escaped literal 0xFF
          else if (b >= WILL && b <= DONT) { this._cmd = b; this._state = 'CMD'; }
          else if (b === SB) { this._sbBuf = []; this._state = 'SB'; }
          else this._state = 'DATA';                                 // 2-byte command, ignored
          break;

        case 'CMD':
          this._handleCmd(this._cmd, b);
          this._state = 'DATA';
          break;

        case 'SB':
          if (b === IAC) this._state = 'SB_IAC';
          else this._sbBuf.push(b);
          break;

        case 'SB_IAC':
          if (b === SE) { this._handleSB(this._sbBuf); this._sbBuf = []; this._state = 'DATA'; }
          else if (b === IAC) { this._sbBuf.push(IAC); this._state = 'SB'; }  // escaped 0xFF in payload
          else this._state = 'DATA';                                          // malformed; resync
          break;
      }
    }
    if (out.length > 0 && this.onData) this.onData(new Uint8Array(out));
  }

  // ─── Option negotiation (WILL/WONT/DO/DONT) ───────────────────────────────
  _handleCmd(verb, opt) {
    switch (opt) {
      case OPT_SGA:
        // Agree to Suppress Go Ahead so the link runs full-duplex.
        if      (verb === DO)   { if (!this._sgaLocal)  { this._sgaLocal  = true;  this._send([IAC, WILL, OPT_SGA]); } }
        else if (verb === WILL) { if (!this._sgaRemote) { this._sgaRemote = true;  this._send([IAC, DO,   OPT_SGA]); } }
        else if (verb === DONT) { if (this._sgaLocal)   { this._sgaLocal  = false; this._send([IAC, WONT, OPT_SGA]); } }
        else if (verb === WONT) { if (this._sgaRemote)  { this._sgaRemote = false; this._send([IAC, DONT, OPT_SGA]); } }
        return;

      case OPT_TTYPE:
        // Accept DO TTYPE; the actual type arrives later via subnegotiation.
        // Plenty of BBSes probe TTYPE to decide whether to send ANSI, and fall
        // back to plain ASCII (or misdetect the client) when it is refused.
        if      (verb === DO)   { if (!this._ttypeLocal) { this._ttypeLocal = true;  this._send([IAC, WILL, OPT_TTYPE]); } }
        else if (verb === DONT) { if (this._ttypeLocal)  { this._ttypeLocal = false; this._send([IAC, WONT, OPT_TTYPE]); } }
        // WILL/WONT TTYPE from the peer is meaningless (we never ask the BBS for
        // its terminal type), so refuse to keep the exchange terminated.
        else if (verb === WILL) { this._send([IAC, DONT, OPT_TTYPE]); }
        return;

      case OPT_NAWS:
        if (verb === DO) {
          if (!this._nawsLocal) {
            this._nawsLocal = true;
            this._send([IAC, WILL, OPT_NAWS]);
            this._sendNAWS();
          }
        } else if (verb === DONT) {
          if (this._nawsLocal) { this._nawsLocal = false; this._nawsSent = false; this._send([IAC, WONT, OPT_NAWS]); }
        } else if (verb === WILL) {
          this._send([IAC, DONT, OPT_NAWS]);
        }
        return;

      default:
        // Every other option: refuse.
        if      (verb === DO)   this._send([IAC, WONT, opt]);
        else if (verb === WILL) this._send([IAC, DONT, opt]);
        return;
    }
  }

  // ─── Subnegotiation (IAC SB … IAC SE) ─────────────────────────────────────
  _handleSB(buf) {
    if (!buf.length) return;
    const opt = buf[0];
    if (opt === OPT_TTYPE && buf[1] === TTYPE_SEND && this._ttypeLocal) {
      this._sendTermType();
    }
    // Anything else: silently ignored. We never agreed to it, so a well-behaved
    // peer will not send it, and a badly-behaved one gets no reply rather than
    // an error it has no handler for.
  }

  _sendTermType() {
    const name = this.termTypes[this._ttypeIndex];
    // Walk the list on each probe and stick on the last entry, which is how a
    // client signals "that's all I have".
    if (this._ttypeIndex < this.termTypes.length - 1) this._ttypeIndex++;
    const reply = [IAC, SB, OPT_TTYPE, TTYPE_IS];
    for (let i = 0; i < name.length; i++) pushEscaped(reply, name.charCodeAt(i) & 0xFF);
    reply.push(IAC, SE);
    this._send(reply);
  }

  _sendNAWS() {
    if (this._nawsSent) return;   // no resize events exist; sent once, never updated
    this._nawsSent = true;
    const reply = [IAC, SB, OPT_NAWS];
    // 16-bit big-endian width then height. 80 and 25 never hit the escaping
    // rule, but a future variable size could, so escape properly regardless.
    for (const v of [this.cols, this.rows]) {
      pushEscaped(reply, (v >> 8) & 0xFF);
      pushEscaped(reply, v & 0xFF);
    }
    reply.push(IAC, SE);
    this._send(reply);
  }

  _send(arr) {
    if (this.onSend) this.onSend(Uint8Array.from(arr));
  }
}

// A literal 0xFF inside a subnegotiation payload must be doubled.
function pushEscaped(arr, b) {
  arr.push(b);
  if (b === IAC) arr.push(IAC);
}

module.exports = {
  TelnetFilter,
  IAC, SE, SB, WILL, WONT, DO, DONT,
  OPT_SGA, OPT_TTYPE, OPT_NAWS, TTYPE_IS, TTYPE_SEND,
};
