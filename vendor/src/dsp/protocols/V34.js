'use strict';

/**
 * V.34 — ITU-T V.34 (1998), operated as TRUE FULL-DUPLEX continuous carrier over
 * the SynthLink WebSocket transport, in the project's "genuine minimal" style
 * (see PROTOCOLS.md §0). Built on the proven V.32/V.32bis DSP core: same
 * fractional-SPS root-raised-cosine synthesis + fractional matched filter,
 * acquire-once/free-run receiver, role-asymmetric self-synchronising scramblers,
 * async UART framing over an always-on scrambled stream, and an in-band
 * control-frame capability exchange.
 *
 * ── Genuine V.34 here ────────────────────────────────────────────────────────
 *   - A real V.34 symbol rate + carrier. STAGE A uses S = 2400 baud with a
 *     1800 Hz carrier — a genuine V.34 configuration (V.34 symbol rates are
 *     2400·a/c; for S=2400 the low/high carriers are 1600/1800 Hz) that also
 *     lets us reuse the proven 3.333-SPS V.32bis front-end unchanged. (Higher
 *     rates S=3200/1829 Hz are a later stage.)
 *   - The genuine V.34 **grid constellation**: the energy-ordered subset of the
 *     odd-integer lattice {(i,q): i,q ∈ ±1,±3,±5,…} (V.34 §9.6.1). The lattice is
 *     invariant under negation and 90° rotation, as the V.34 4D differential /
 *     trellis coding requires. STAGE A carries 8 data bits/symbol over the 256
 *     lowest-energy points → 8·2400 = 19 200 bit/s.
 *   - The real, role-asymmetric self-synchronising scramblers — **identical to
 *     V.32/V.32bis** — call-mode GPC = 1+x⁻¹⁸+x⁻²³, answer-mode GPA = 1+x⁻⁵+x⁻²³
 *     (V.34 uses the same generators). Each end scrambles TX with its own
 *     polynomial and descrambles RX with the peer's. Bit-exact to the §5.2.3
 *     golden vector already verified project-wide.
 *   - Async start/stop (UART) framing; a capability exchange carrying the agreed
 *     bit rate; an audible startup (2100 Hz answer tone → training → preamble).
 *
 * ── Genuine-minimal, documented (not hidden) ────────────────────────────────
 *   Justified by the lossless, 4-wire-equivalent, drift-free transport (§0):
 *   - **No line probing / INFO exchange** (V.34 Phase 1–2). The symbol rate and
 *     carrier are fixed rather than chosen from channel measurements.
 *   - **No precoder** (§9.6.2). V.34's Tomlinson-Harashima-style precoder cancels
 *     channel ISI using the far-end response h[]; on a flat, ISI-free channel
 *     h≈[1,0,0] so the precoder output is ≈0 and Y≈U (the constellation point).
 *     It degenerates to identity here, exactly as V.32bis's Viterbi is unused.
 *   - **No non-linear warping** (§9.7, itself optional in the spec).
 *   - **No Viterbi decoder.** (STAGE A′ adds the genuine 16-state 4D trellis and
 *     carries U0 on the wire; the receiver slices and discards it — the ~coding
 *     gain is unused on a lossless link, as with V.32bis's Y0.)
 *   - **No adaptive equalizer / no continuous timing tracking** — acquire-once on
 *     the preamble then free-run, sound only on the shared zero-drift 8 kHz clock.
 *   - **Simplified startup:** the recognizable audible pre-roll + acquirable
 *     preamble instead of V.34's exact S/Ŝ/PP/TRN/MP/E/J/JP segment state machine.
 *   - **Single rate for now** (19200/2400); multi-rate + higher symbol rates
 *     (3200 baud → 28800/33600) are later stages (see PROTOCOLS.md §7).
 *
 * The genuine encode chain — shell-mapping constellation shaping (§9.4), 4D
 * differential coding (§9.5), the Figure-10 16-state 4D trellis on the wire
 * (§9.6.3), and the quarter-superconstellation ring/point mapper (§9.6.1) — lives
 * in V34Mapper.js and is exercised bit-exact by tools/tests/v34-map-check.js.
 *
 * Interface matches the other protocol classes: constructor(role);
 * generateAudio(n)->Float32Array; receiveAudio(f32); write(buf); emits 'data'
 * (Buffer) and 'ready' ({bps, remoteDetected}); getters bps and carrierDetected.
 */

const { EventEmitter } = require('events');

// ── Genuine V.34 encode chain (shell map + 4D differential + 16-state trellis +
// mapper), §9.3–9.6, provided by V34Coder. A mapping frame is CFG.frameBits
// scrambled bits → CFG.symsPerFrame (8) constellation points, and back. See
// V34Mapper.js. Data-mode configuration (symbol rate + bit rate) is selected here.
const { V34Coder, makeConfig, CONFIGS, sliceOdd, invRot } = require('./V34Mapper');
// Phase 4's Modulation Parameter sequence, Table 20/V.34. It replaces what used
// to be a project-invented `DLE 'R' hi lo` rate frame: same DLE carriage, but the
// content is now the Recommendation's own bit layout and it is load-bearing —
// the peer's transmit rate, trellis, Θ and shaping selections are read from it
// and a disagreement is a hard failure rather than a silently wrong decode.
const V34Phase4 = require('./V34Phase4');
// Phase 3's segments, §10.1.3: S, S̄, MD, PP, TRN and the J / J′ sequences. It
// replaced `_buildAATrain`, which was 250 ms of alternating REF points standing in
// for the whole phase. V.90 §9.3.2 references V.34's segments rather than
// redefining them, and V90.js's analogue modem transmits through this class, so
// this serves both. See V34Phase3.js for the clause-by-clause order.
const P3 = require('./V34Phase3');
const config = require('../../../config');

// ── Per-symbol-rate RF front-end (genuine V.34 carrier, Table 2). Roll-off/span
// are the largest excess bandwidth that keeps the occupied band FC ± S/2·(1+β)
// inside (0, 4000) Hz at 8 kHz while opening the eye — each verified against a
// perfect-timing loopback before being wired. 3429 is razor-thin (lower edge
// ≈ 4 Hz) but sound on the lossless link (span 32 at β=0.14 → 0 slice errors).
const RF = {
  2400: { fc: 1800, rolloff: 0.25, span: 10 },
  3200: { fc: 1920, rolloff: 0.20, span: 24 },
  3429: { fc: 1959, rolloff: 0.14, span: 32 },
};
// ── Per-constellation amplitude (shaped mean symbol energy + preamble reference),
// measured from the shell-shaped point distribution (tools/tests/v34-map-check.js).
// meanE sets the TX gain (data-burst RMS ≈ 0.1); |REF| ≈ sqrt(meanE) so the
// preamble sits at the data level. Keyed by rate because two rates share sRate=3200
// but have different constellation sizes (28800 L=768 vs 31200 L=1280).
const AMP = {
  '19200/2400': { meanE: 214, ref: { i: 9,  q: 9  } },
  '28800/3200': { meanE: 427, ref: { i: 15, q: 15 } },
  '31200/3200': { meanE: 725, ref: { i: 19, q: 19 } },
  '33600/3429': { meanE: 725, ref: { i: 19, q: 19 } },
};

// Resolve the per-call rate from the shared config singleton (mutated by the
// server/client just before DSP construction, exactly like protocolPreference).
// Accepts a rate-name ('33600/3429') or a bps number (33600); defaults to the
// highest available. Unknown values fall back to the max.
const RATE_ALIASES = { 19200: '19200/2400', 28800: '28800/3200', 31200: '31200/3200', 33600: '33600/3429' };
const DEFAULT_RATE = '33600/3429';
function resolveRateName() {
  const sel = config.modem && config.modem.native && config.modem.native.v34Rate;
  if (typeof sel === 'string' && CONFIGS[sel]) return sel;
  if (typeof sel === 'number' && RATE_ALIASES[sel]) return RATE_ALIASES[sel];
  if (typeof sel === 'string' && RATE_ALIASES[+sel]) return RATE_ALIASES[+sel];
  return DEFAULT_RATE;
}

// ── Rate-dependent state, (re)built by configure(). Method bodies reference these
// module bindings; both ends of a link share the config singleton and select the
// same rate, so configure() runs once per process for the active rate (it re-runs
// only if a later construction selects a different rate — e.g. a test sweeping
// rates). This mirrors the shared-singleton contract in CLAUDE.md.
const SR = 8000;
const SYMS_PER_FRAME = 8;
const SEG_A = 48, SEG_B = 24, PRE = SEG_A + SEG_B;
const WARMUP_BITS = 48, UART_ARM_MARKS = 8;
const RX_A = 0.02, RX_HI = 0.015, RX_LO = 0.006, RX_HANG = 48;
const DLE = 0x10, CTL_MP = 0x4d /*M*/, CTL_DATA = 0x44 /*D*/;
const DATA_MARK = [DLE, CTL_DATA], MP_REPEATS = 3;
// Keep resending MP while waiting for the far end's rather than sending three and
// hoping, but cap it: a lost control frame must degrade to entering data mode, not
// to a hung link.
const MP_MAX_REPEATS = 12;
const ANS_TONE_FREQ = 2100, ANS_TONE_AMP = 0.15, ANS_TONE_SAMPLES = Math.round(1.0 * SR);
const CONNECT_GAP = Math.round(0.08 * SR);

// ── Phase 3 (§10.1.3 for the segments, §11.3 for the order) ─────────────────
// §11.3.1.2.1: the answer modem "shall transmit silence for 70 ± 5 ms" before its
// first S. The call modem has no corresponding constant — §11.3.1.1.1 makes it
// "initially silent" and gates it on DETECTING S and the subsequent S̄, which is
// what replaced ORIG_LEAD (a 0.60 s originate-side silence with no basis in the
// Recommendation). The V.8 sequencer hands the two ends their protocol at
// measurably different instants — the originate side leaves CJ when its transmit
// queue drains, the answer side only once it has DEMODULATED CJ — so a fixed lead
// was a guess at a skew a detector absorbs exactly.
const ANS_PHASE3_SILENCE = Math.round(0.070 * SR);

// §11.3.1.1.6 / §11.3.1.2.3: TRN "shall be transmitted for at least 512T". The
// minimum is the legal choice taken here, per the backlog's rule that a shorter
// start-up comes from the knobs the Recommendation provides rather than by
// omission.
const TRN_SYMBOLS = P3.TRN_MIN_SYMBOLS;

// §10.1.3.5: MD is OPTIONAL and its length is carried in INFO1 — "if the signal is
// not present, the MD length indication will be 0". There is no INFO exchange here
// until the line-probing item, so this modem declares no manufacturer-defined
// signal, which is what a modem without one does. The procedure branch that emits
// it (and the second S / S̄ pair that follows it) is present and is exercised by
// v34-phase3-check at a non-zero length.
const MD_SYMBOLS = 0;

// §10.1.3.3: J is "a whole number of repetitions" of Table 18's 16-bit pattern, and
// §11.3.1.2.4 / §11.3.1.1.7 repeat it until the far end's S — respectively S̄ — is
// detected. Phase 4 here begins with the data burst's own acquirable preamble
// rather than with V.34's signal S, so there is no S for J to terminate on and both
// ends read the same constant instead. That is the ONE place this pair's Phase 3
// agrees by constant rather than by signal; it is exactly the position V.90's
// JD_REPS is in, for the same reason, and putting Phase 4's S on the wire is what
// removes it. Four repetitions is 32 symbols — a sequence rather than a blip, and
// not what the start-up's length is made of.
const J_REPEATS = 4;

// §11.3.2.1.1's deadline, as the call modem's fallback when no S-to-S̄ arrives:
// "if ... sequence J is not received within 2800 ms plus two round trip delays".
// NOTE the DIVERGENCE, which is deliberate and stated rather than hidden: the
// Recommendation's action on expiry is a retrain (§11.5.1.1), and there is no
// retrain state machine in this implementation. On expiry this modem proceeds into
// its own Phase 3 regardless, because proceeding degrades to the previous
// behaviour — a call that trains anyway — where hanging does not. A retrain path is
// the thing to add here, not a different constant.
const S_GATE_TIMEOUT = Math.round(2.8 * SR);

// How many symbols of unbroken S (or S̄) alternation the receiver requires before it
// will call one. S is 128T and S̄ only 16T, so the confirmation has to fit inside the
// shorter of the two with margin; 12 does, and is long enough that TRN — whose
// rotations are random — reaches it with probability 2^-11 per position.
const P3_RUN_CONFIRM = 12;
// The Phase 3 bit stream is a ring, not a log: the longest thing read out of it is
// one DIL descriptor, and a consumer that has stopped reading must not be able to
// grow it without bound.
const P3_BIT_CAP = 4096;

let CURRENT_RATE = null;
let CFG, FE, labelOf, BAUD, FC, SPS, ROLLOFF, SPAN, RRC_G = 1;
let MEAN_E, TX_GAIN, REF, ACQ_MIN, RATE_BPS;
// §10.1.3's NOTE requires the average signal power in Phase 3 to be the power the
// data mode goes on to use. Every Phase 3 segment is drawn from a unit-scale point
// set — S, TRN and J from the four rotations of point 0 (energy 2), PP from the
// unit circle (energy 1) — so each is scaled to MEAN_E here rather than emitted at
// lattice scale, which would put Phase 3 tens of dB under the data burst and train
// the far end at a gain it will not see again.
let P3_GAIN_S, P3_GAIN_PP;
// Table 20/V.34 MP, built once per configured rate. `ack` is the only per-instance
// difference (an MP with the acknowledge bit set is MP′, §10.1.3.9), so both
// variants are pre-built here and picked by the transmitter.
let MP_FRAME, MPP_FRAME;

function rrcAt(t) {
  const b = ROLLOFF;
  if (Math.abs(t) < 1e-8) return 1 - b + 4 * b / Math.PI;
  if (Math.abs(Math.abs(4 * b * t) - 1) < 1e-6) {
    return (b / Math.SQRT2) *
      ((1 + 2 / Math.PI) * Math.sin(Math.PI / (4 * b)) +
       (1 - 2 / Math.PI) * Math.cos(Math.PI / (4 * b)));
  }
  const pt = Math.PI * t;
  return (Math.sin(pt * (1 - b)) + 4 * b * t * Math.cos(pt * (1 + b))) /
         (pt * (1 - (4 * b * t) * (4 * b * t)));
}
const rrc = t => rrcAt(t) * RRC_G;

function configure(rateName) {
  if (rateName === CURRENT_RATE) return;
  CFG = makeConfig(CONFIGS[rateName]);
  FE = RF[CFG.sRate];
  const amp = AMP[rateName];
  labelOf = CFG.labelOf;
  BAUD = CFG.sRate; FC = FE.fc; SPS = SR / BAUD; ROLLOFF = FE.rolloff; SPAN = FE.span;
  { let s = 0; for (let k = -SPAN * 4; k <= SPAN * 4; k++) s += rrcAt(k / 4) ** 2; RRC_G = 1 / Math.sqrt(s / 4); }
  MEAN_E = amp.meanE;
  TX_GAIN = 0.1 / Math.sqrt(MEAN_E) * Math.SQRT2 * 0.999;   // data-burst RMS ≈ 0.1
  REF = amp.ref;
  ACQ_MIN = Math.ceil((PRE + 10) * SPS);
  RATE_BPS = CFG.bitRate;                                   // advertised (nominal) rate
  // Both directions carry the same rate: this link is symmetric, so the
  // asymmetric-rate enable (bit 50) stays clear. Trellis 16 state, Θ = 0 and
  // minimum shaping are what V34Mapper actually implements — the (K, M, L) triples
  // in CONFIGS are Table 10's Minimum columns — so the peer reading them back and
  // disagreeing means it cannot decode us.
  const mp = {
    callToAnswer: RATE_BPS, answerToCall: RATE_BPS,
    aux: false, trellis: 16, theta: false, expandedShaping: false,
    asymmetric: false,
    rates: Object.values(CONFIGS).map(c => c.bitRate).sort((a, b) => a - b),
  };
  MP_FRAME  = [DLE, CTL_MP, ...V34Phase4.buildMPBytes({ ...mp, ack: false })];
  MPP_FRAME = [DLE, CTL_MP, ...V34Phase4.buildMPBytes({ ...mp, ack: true })];
  P3_GAIN_S  = Math.sqrt(MEAN_E / P3.meanEnergy(P3.buildS()));
  P3_GAIN_PP = Math.sqrt(MEAN_E / P3.meanEnergy(P3.buildPP()));
  CURRENT_RATE = rateName;
}
configure(DEFAULT_RATE);   // module-load default; re-resolved per construction below

class V34 extends EventEmitter {
  constructor(role) {
    super();
    configure(resolveRateName());   // pick this call's rate from the shared config singleton
    this.role = role === 'originate' ? 'originate' : 'answer';
    this._ready = false;
    if (this.role === 'originate') { this._txTap = 17; this._rxTap = 4; }
    else                           { this._txTap = 4;  this._rxTap = 17; }
    this._rate = RATE_BPS;

    // TX
    this.txByteQ = [];
    this.txCtrlQ = [];
    this.scr = new Array(23).fill(0);
    // Phase 3's own clause 7 register — see _buildPhase3 for why it is not `scr`.
    this.scr3 = new Array(23).fill(0);
    this.txCoder = new V34Coder(CFG);
    this.txState = 'idle';
    this.txMode = 'qam';
    this._connectQ = this._buildConnectScript(this.role);
    this._idleSamples = 0;
    this._resetTxBurst();

    // RX
    this.rxLevel = 0;
    this.rxOn = false;
    this.rxLow = 0;
    this.peerRate = 0;
    this.peerMP = null;         // parsed Table 20/V.34 MP from the far end
    this.mpMismatch = null;     // set if the peer selected coding we do not run
    this.rxCoder = new V34Coder(CFG);
    // Phase 3 reception state. These deliberately survive _resetRx(): the receiver
    // passes through Phase 3 exactly once per call, and the burst that follows the
    // silence at its end is Phase 4's, which acquires on the data preamble.
    this._sbarSeen = false;      // §11.3.1.1.1's gate — the S-to-S̄ transition
    this._sawPhase3 = false;     // set when the Phase 3 signal has ended
    this._sGateTimedOut = false;
    // How many S-to-S̄ transitions the far end's Phase 3 contains. Plain V.34 sends
    // one (§11.3.1.2.1). V.90's analogue modem sends three — the head's, §9.3.2.8's
    // after J′d, and §9.3.2.10's DIL terminator — so the digital modem's receiver
    // must not treat §9.3.2.4's intervening silence as the end of Phase 3.
    this._p3SbarTarget = 1;
    this.p3 = this._newP3();
    this._resetRx();
  }

  /**
   * Which of S's two points the timing lock landed on — and it matters, because the
   * two answers are not related by a rotation.
   *
   * The reference is taken from S by parity: one mean is "the even-index symbol",
   * the other "the odd-index one". Nothing in that says WHICH of S's two points is
   * which, and the two hypotheses differ by a REFLECTION (label = 3 − true), not by
   * a rotation. A reflection leaves S and S̄ perfectly recognisable — both are still
   * alternations, which is why the detector that item 1 needed never noticed — but
   * it NEGATES every differential decode, so J, J′ and Ja come out as In′ = −In and
   * no frame sync is ever found.
   *
   * §10.1.3.7 supplies the disambiguator: "Signal S̄ shall begin with the
   * transmission of point 0 rotated by 180 degrees." So the first symbol of a
   * confirmed S̄ run is rotation 2 by definition. Its LABEL is therefore 2 if the
   * lock was even and 1 if it was odd, and that single comparison settles the
   * labelling for the rest of Phase 3. The decoder is restarted at the same moment,
   * because everything it produced before this point was read off the wrong map.
   */
  _resolveP3Parity(p) {
    if (p.parityKnown) return;
    p.reflect = (p.runFirstRot === 1);
    p.parityKnown = true;
    p.dec.prev = null;
    p.des3.fill(0);
    p.bits.length = 0;
  }

  /** Phase 3 reception state. Survives _resetRx until Phase 3 genuinely ends. */
  _newP3() {
    return {
      runKind: null, runLen: 0, lastRot: -1, runFirstRot: -1, inS: false,
      sCount: 0, sbarCount: 0,
      reflect: false, parityKnown: false,
      dec: new P3.JDecoder(), des3: new Array(23).fill(0), bits: [],
    };
  }

  /** §9.3.1: how many S-to-S̄ transitions the peer's Phase 3 will contain. */
  setPhase3SbarTarget(n) { this._p3SbarTarget = n; }

  /**
   * Handshake tells us a genuine V.8 exchange (ANSam/CM/JM/CJ) already ran.
   * The answerer's ANSam has therefore been heard and this class must not emit
   * its own 2100 Hz answer tone on top of it — a second tone lands during the
   * peer's post-CJ training and trips its energy-onset acquisition.
   */
  setV8Complete(done) {
    if (!done) return;
    this._connectQ = this._connectQ.filter(step => step.kind !== 'tone');
  }

  /**
   * Which side of §11.3's Phase 3 this modem plays, independently of its V.34 role.
   *
   * V.34 gives the leading part to the answer modem (§11.3.1.2.1) and the gated part
   * to the call modem (§11.3.1.1.1). V.90 swaps it: §9.3.2.1 gives the ANALOGUE
   * modem — which is V.90's originate side, and the side that runs this class — the
   * same "silence for 70 ± 5 ms, signal S for 128T and signal S̄ for 16T" the V.34
   * answer modem has. The digital modem is not a V.34 transmitter at all; it answers
   * with Sd on the PCM side, so there is no S here for the analogue modem to wait
   * for and a gated originate would sit out its whole timeout.
   *
   * Call before the first generateAudio(); it rebuilds the connect script.
   */
  setPhase3Lead(lead) {
    const want = lead ? 'answer' : this.role;
    const hadTone = this._connectQ.some((s) => s.kind === 'tone');
    this._connectQ = this._buildConnectScript(want);
    if (!hadTone) this._connectQ = this._connectQ.filter((s) => s.kind !== 'tone');
  }

  get carrierDetected() { return this.rxOn || this.acq; }
  get bps() { return this._rate; }

  write(bytes) { for (const by of bytes) this.txByteQ.push(by & 0xff); }

  _scramble(bit) { const r = this.scr; const out = bit ^ r[this._txTap] ^ r[22]; r.unshift(out); r.pop(); return out; }

  /** Clause 7's scrambler again, on Phase 3's own register. */
  _scramble3(bit) { const r = this.scr3; const out = bit ^ r[this._txTap] ^ r[22]; r.unshift(out); r.pop(); return out; }

  // ─── TX ────────────────────────────────────────────────────────────────────
  _resetTxBurst() {
    this.txSyms = [];
    this.txSymBase = 0;
    this.txMode = 'qam';
    this.txN = 0;
    this.txFrame = null;
    this.txFramePos = 0;
    this.txWarmup = 0;
    this.txEndSample = -1;
    this.txContinuous = false;
    this._p3Active = false;   // Phase 3's tail is driving the continuous path
    this.txFrameIdx = 0;      // mapping-frame counter for §8.2 switching (reset per data burst)
  }

  _buildPreamble() {
    for (let k = 0; k < SEG_A; k++) this.txSyms.push((k & 1) ? { i: -REF.i, q: -REF.q } : { i: REF.i, q: REF.q });
    for (let k = 0; k < SEG_B; k++) this.txSyms.push({ i: REF.i, q: REF.q });
  }

  /**
   * §11.3's two roles. The answer modem leads on a timer the Recommendation gives
   * it (70 ± 5 ms, §11.3.1.2.1); the call modem leads on nothing, because
   * §11.3.1.1.1 makes it "initially silent" until it detects S and the subsequent
   * S̄ — `gate: 'sbar'`, satisfied by the receiver rather than by a sample count.
   */
  _buildConnectScript(role) {
    if (role === 'answer') {
      return [
        { kind: 'tone',   gap: 0 },
        { kind: 'phase3', gap: ANS_PHASE3_SILENCE },
        { kind: 'data',   gap: CONNECT_GAP },
      ];
    }
    return [
      { kind: 'phase3', gap: 0, gate: 'sbar' },
      { kind: 'data',   gap: CONNECT_GAP },
    ];
  }

  /**
   * Phase 3 in §11.3's order: S, S̄, [MD, S, S̄], PP, TRN, J × n, J′.
   *
   * J′ sits at the tail because §11.4.1.1.1 is where it belongs — "the call modem
   * shall stop sending J sequences, ... transmit one J′ sequence, and then transmit
   * signal TRN" — so J′ is the handoff out of Phase 3, and the data burst's
   * preamble is what follows it here.
   *
   * The scrambler is `scr3`, its own register. §10.1.3.8 requires it initialized to
   * zero before TRN specifically, and the data path resets `scr` when data begins;
   * sharing one register would make the data path's state depend on how many Phase
   * 3 symbols happened to be sent. Same split, for the same reason, as V90.js.
   */
  _buildPhase3() {
    const push = (syms, g) => { for (const p of syms) this.txSyms.push({ i: p.i * g, q: p.q * g }); };

    // §11.3.1.2.1 / §11.3.1.1.3 — S for 128T then S̄ for 16T.
    push(P3.buildS(), P3_GAIN_S);
    push(P3.buildSbar(), P3_GAIN_S);

    // §11.3.1.1.4 / §11.3.1.2.1 — MD, when its declared length is non-zero, then S
    // and S̄ again. MD_SYMBOLS is 0 here (§10.1.3.5); the branch is real.
    if (MD_SYMBOLS > 0) {
      push(this._buildMD(MD_SYMBOLS), P3_GAIN_S);
      push(P3.buildS(), P3_GAIN_S);
      push(P3.buildSbar(), P3_GAIN_S);
    }

    // §11.3.1.1.5 / §11.3.1.2.2 — PP, 288 symbols, equation (10-1).
    push(P3.buildPP(), P3_GAIN_PP);

    // §11.3.1.1.6 / §11.3.1.2.3 — TRN, four constellation points, ≥ 512T.
    this.scr3.fill(0);                                   // §10.1.3.8
    let lastTrn = null;
    for (let n = 0; n < TRN_SYMBOLS; n++) {
      lastTrn = P3.trnSymbol(() => this._scramble3(1));
      this.txSyms.push({ i: lastTrn.i * P3_GAIN_S, q: lastTrn.q * P3_GAIN_S });
    }

    // Everything up to here is fixed-length and can be built in one go. What
    // follows cannot: §11.3.1.2.4 repeats J "until" the far end's S̄, and V.90's
    // §9.3.2.4 repeats Ja until S̄d, so the tail's length is a SIGNAL and the
    // remaining symbols are produced one at a time by _p3Next().
    //
    // §10.1.3.3: the differential encoder "shall be initialized using the final
    // symbol of the transmitted TRN sequence".
    this._p3 = {
      enc: new P3.JEncoder(P3.rotationOf(lastTrn)),
      stage: this._p3Tail ? this._p3Tail.first : 'j',
      bits: null, bitPos: 0, reps: 0, count: 0, done: false,
    };
  }

  /**
   * One symbol of Phase 3's signal-gated tail, or null when the tail is finished.
   *
   * Plain V.34 runs the `j` / `jprime` stages and stops. V.90's analogue modem
   * replaces them through setPhase3Tail(): §8.3.1's Ja, then the S / S̄ / SCR
   * placement §9.3.2.7 to §9.3.2.10 defines. Both drive the same encoder and the
   * same scrambler, because §8.3.1 says Ja's modulation IS 10.1.3.3/V.34's and
   * §8.3.5 says SCR's differential encoder is not reinitialised.
   */
  _p3Next() {
    const p3 = this._p3;
    if (!p3 || p3.done) return null;
    const t = this._p3Tail;

    for (;;) {
      // A stage that is streaming bits emits the next symbol from them. Two bits per
      // 2D symbol interval, I1 first in time (§10.1.3.3).
      if (p3.bits && p3.bitPos < p3.bits.length) {
        const i1 = this._scramble3(p3.bits[p3.bitPos]);           // first in time
        const i2 = this._scramble3(p3.bits[p3.bitPos + 1]);
        p3.bitPos += 2;
        const p = p3.enc.symbol(i1, i2);
        return { i: p.i * P3_GAIN_S, q: p.q * P3_GAIN_S };
      }
      // A stage emitting a fixed run of symbols (S, S̄, one SCR symbol) counts down.
      if (p3.run && p3.count < p3.run.length) {
        const p = p3.run[p3.count++];
        return { i: p.i * P3_GAIN_S, q: p.q * P3_GAIN_S };
      }
      // Both cursors are cleared BEFORE advancing: a stage that re-arms the same bit
      // array (Ja repeats its descriptor) would otherwise re-enter with the cursor
      // still at the end and neither emit nor terminate.
      p3.bits = null; p3.bitPos = 0; p3.run = null; p3.count = 0;
      if (!this._p3Advance(p3, t)) { p3.done = true; return null; }
    }
  }

  /**
   * The tail's stage transitions. Returns false when the tail is over.
   *
   * Every gate here is a predicate the owner supplies, and each one names the
   * clause it implements. Where a gate is absent the stage falls through on its own
   * length, which is what plain V.34 does — its J count is the constant item 1 left
   * behind and V.90's tail is what retires.
   */
  _p3Advance(p3, t) {
    switch (p3.stage) {
      // ── Plain V.34: J × J_REPEATS then one J′ (§10.1.3.3, §10.1.3.4) ────────
      case 'j':
        if (p3.reps++ < J_REPEATS) { p3.bits = P3.jPattern(4); return true; }
        p3.stage = 'jprime'; return true;
      case 'jprime':
        p3.bits = P3.jPrimePattern(); p3.stage = 'end'; return true;

      // ── V.90 analogue modem (§9.3.2) ────────────────────────────────────────
      // §8.3.1: "Sequence Ja consists of repetitions of the DIL descriptor...
      // Transmission of sequence Ja may be terminated without completing the final
      // DIL descriptor." §9.3.2.4 terminates it on the Sd-to-S̄d transition.
      case 'ja':
        if (t.sbarD()) { p3.stage = 'ja-silence'; return true; }
        p3.bits = t.jaBits; return true;

      // §9.3.2.4: "After detecting the Sd-to-S̄d transition, the analogue modem
      // shall terminate Ja and transmit silence." The burst ends here and the
      // owner restarts Phase 3 at the 's-hold' stage once Jd has been received —
      // silence inside a continuous burst would be a gap the far end reads as the
      // end of the signal, which on this transport it is.
      case 'ja-silence':
        return false;

      // §9.3.2.7: "After receiving Jd ... shall then begin transmitting signal S
      // and condition its receiver to detect J′d." Open-ended: S until J′d.
      case 's-hold':
        if (t.jprimeD()) { p3.stage = 'sbar-after-jprime'; return true; }
        p3.run = P3.buildS(P3.S_SYMBOLS); return true;

      // §9.3.2.8: "After detecting J′d, the analogue modem shall transmit S̄ for
      // 16T." Then DIL is received, or Phase 4 if none was requested.
      case 'sbar-after-jprime':
        p3.run = P3.buildSbar();
        p3.stage = t.dilRequested ? 'scr' : 'end';
        return true;

      // §9.3.2.9: "During the reception of DIL the analogue modem shall transmit
      // either silence or SCR at its discretion." SCR is taken — the NOTE under
      // §8.3.1 recommends it ("to maintain line energy"), and silence here would
      // drop the far end's carrier detect on a link whose only energy is ours.
      case 'scr':
        if (t.dilDone()) { p3.stage = 's-terminate'; return true; }
        p3.run = [P3.scrSymbol((b) => this._scramble3(b), p3.enc)];
        return true;

      // §9.3.2.10: "the analogue modem shall again transmit signal S for 128T
      // followed by S̄ for 16T. This indicates to the digital modem that the
      // analogue modem has received enough of the DIL sequence."
      case 's-terminate':
        p3.run = P3.buildS(); p3.stage = 'sbar-terminate'; return true;
      case 'sbar-terminate':
        p3.run = P3.buildSbar(); p3.stage = 'end'; return true;

      default:
        return false;
    }
  }

  /**
   * V.90's analogue modem replaces V.34's J tail with §8.3.1's Ja and the S / S̄ /
   * SCR placement of §9.3.2.7 to §9.3.2.10. `first` names the stage a (re)started
   * Phase 3 burst begins its tail at, because §9.3.2.4's silence genuinely divides
   * the analogue modem's Phase 3 into two transmissions.
   */
  setPhase3Tail(tail) {
    this._p3Tail = tail;
    if (!tail || !tail.resumeAt) return;
    // §9.3.2.4's silence is a real division of the analogue modem's Phase 3, so it
    // is a real division of its connect script: Ja's burst, then §9.3.2.7's, which
    // waits on Jd having been received rather than on a sample count.
    this._p3Resume = tail.resumeAt;
    const at = this._connectQ.findIndex((s) => s.kind === 'phase3');
    if (at < 0) return;
    this._connectQ.splice(at + 1, 0, { kind: 'phase3-resume', gap: 0, gate: 'jd' });
  }

  /**
   * §10.1.3.5's MD. Its content is by definition manufacturer-defined, so what it
   * carries is this implementation's choice and only its LENGTH is on the wire in
   * INFO1. Scrambled ones through the Phase 3 scrambler, mapped exactly as TRN is,
   * makes it a signal a far end can train an echo canceller on — which is what the
   * clause says MD is for — without inventing a structure the Recommendation would
   * have specified if it wanted one.
   */
  _buildMD(count) {
    const out = new Array(count);
    for (let n = 0; n < count; n++) out[n] = P3.trnSymbol(() => this._scramble3(1));
    return out;
  }

  _startBurst(kind) {
    this._resetTxBurst();
    this.scr.fill(0);
    this.txCoder.reset();

    if (kind === 'tone') {
      this.txMode = 'tone';
      this.txEndSample = ANS_TONE_SAMPLES;
      this.txState = 'active';
      this._idleSamples = 0;
      return;
    }
    // Phase 3's head (S, S̄, MD, PP, TRN) is fixed-length and built in one go; its
    // tail is signal-gated, so the burst runs on the continuous path and _p3Next()
    // feeds it. It stops being continuous the moment the tail says it is done,
    // which is what lets the existing fixed-burst end condition finish the shaper.
    if (kind === 'phase3') {
      this._buildPhase3();
      this.txContinuous = true;
      this._p3Active = true;
      this.txState = 'active';
      this._idleSamples = 0;
      return;
    }
    // §9.3.2.4's silence splits the analogue modem's Phase 3 in two. The second
    // transmission has no head — it resumes the tail's stage machine, keeping the
    // differential encoder and the scrambler, which §8.3.5 requires for SCR.
    if (kind === 'phase3-resume') {
      this._p3.stage = this._p3Resume;
      this._p3.done = false; this._p3.bits = null; this._p3.bitPos = 0;
      this._p3.run = null; this._p3.count = 0;
      this.txContinuous = true;
      this._p3Active = true;
      this.txState = 'active';
      this._idleSamples = 0;
      return;
    }
    // 'data' — continuous full-duplex flow: preamble then framed bits forever
    this._buildPreamble();
    this.txWarmup = WARMUP_BITS;
    this.txContinuous = true;
    this.txCtrlQ = [];
    this._mpSent = 0;
    this._mpPhase = 'mp';
    for (let r = 0; r < MP_REPEATS; r++, this._mpSent++) this.txCtrlQ.push(...MP_FRAME);
    this.txState = 'active';
    this._idleSamples = 0;
  }

  /**
   * A step waits for its own gap, and a step carrying `gate` waits for a SIGNAL as
   * well. `gate: 'sbar'` is §11.3.1.1.1 — the call modem stays silent until it has
   * detected S and the subsequent S̄ — with S_GATE_TIMEOUT as the fallback described
   * where that constant is declared.
   */
  _maybeStartBurst() {
    if (!this._connectQ.length) return;
    const step = this._connectQ[0];
    if (this._idleSamples < step.gap) return;
    if (step.gate === 'sbar' && !this._sbarSeen) {
      if (this._idleSamples < S_GATE_TIMEOUT) return;
      this._sGateTimedOut = true;
    }
    // §9.3.2.7 — the analogue modem begins S only "after receiving Jd".
    if (step.gate === 'jd' && !(this._p3Tail && this._p3Tail.jdReceived())) {
      if (this._idleSamples < S_GATE_TIMEOUT) return;
      this._sGateTimedOut = true;
    }
    this._startBurst(this._connectQ.shift().kind);
  }

  /**
   * Phase 4's MP exchange, run over the DLE control channel: send MP until the
   * far end's arrives, answer it with MP′ (§10.1.3.9: "an MP sequence with the
   * acknowledge bit set to 1 is denoted by MP′"), then mark the start of data.
   * The acknowledge bit is therefore load-bearing here rather than decorative —
   * data mode is gated on having read and agreed with the peer's parameters.
   */
  _refillCtrl() {
    if (this.txCtrlQ.length || this._mpPhase !== 'mp') return;
    if (this.peerMP || this._mpSent >= MP_MAX_REPEATS) {
      if (this.peerMP) this.txCtrlQ.push(...MPP_FRAME);
      this.txCtrlQ.push(...DATA_MARK);
      this._mpPhase = 'done';
      return;
    }
    this.txCtrlQ.push(...MP_FRAME);
    this._mpSent++;
  }

  _txBit() {
    if (this.txWarmup > 0) { this.txWarmup--; return this._scramble(1); }
    if (this.txFrame) {
      const b = this.txFrame[this.txFramePos++];
      if (this.txFramePos >= this.txFrame.length) this.txFrame = null;
      return this._scramble(b);
    }
    let by = null;
    this._refillCtrl();
    if (this.txCtrlQ.length) by = this.txCtrlQ.shift();
    else if (this.txByteQ.length) by = this.txByteQ.shift();
    if (by !== null) {
      this.txFrame = [0, by & 1, (by >> 1) & 1, (by >> 2) & 1, (by >> 3) & 1,
                      (by >> 4) & 1, (by >> 5) & 1, (by >> 6) & 1, (by >> 7) & 1, 1];
      this.txFramePos = 1;
      return this._scramble(0);
    }
    return this._scramble(1);         // idle mark
  }

  // Encode one mapping frame: this frame's parity (high/low, §8.2) comes from the
  // SWP-driven frame counter; pull the matching bit count (b or b−1) of scrambled
  // bits, run the genuine V.34 chain (shell map + differential + trellis + mapper)
  // → SYMS_PER_FRAME points. For the all-high configs this is always b bits.
  _encodeFrameSymbols() {
    const idx = this.txFrameIdx++;
    const high = CFG.isHighFrame(idx);
    const nb = high ? CFG.frameBitsHigh : CFG.frameBitsLow;
    const bits = new Array(nb);
    for (let i = 0; i < nb; i++) bits[i] = this._txBit();
    return this.txCoder.encodeFrame(bits, high);
  }

  _ensureSymbols(k) {
    if (!this.txContinuous) return;
    if (this._p3Active) {
      while (this.txSymBase + this.txSyms.length <= k) {
        const p = this._p3Next();
        if (!p) {
          // The tail is over. Everything still to be pulsed is already in txSyms,
          // so the burst stops being continuous and ends on the fixed-burst
          // condition once the shaper has run its span out.
          this._p3Active = false;
          this.txContinuous = false;
          this.txEndSample =
            Math.ceil((this.txSymBase + this.txSyms.length + SPAN / 2) * SPS);
          return;
        }
        this.txSyms.push(p);
      }
      return;
    }
    while (this.txSymBase + this.txSyms.length <= k) {
      const pts = this._encodeFrameSymbols();
      for (const p of pts) this.txSyms.push(p);
    }
  }

  generateAudio(count) {
    const out = new Float32Array(count);
    if (this.txState !== 'active') {
      this._maybeStartBurst();
      if (this.txState !== 'active') { this._idleSamples += count; return out; }
    }
    if (this.txMode === 'tone') {
      for (let c = 0; c < count; c++) {
        const n = this.txN++;
        if (this.txEndSample >= 0 && n >= this.txEndSample) { this.txState = 'idle'; this._resetTxBurst(); break; }
        out[c] = Math.sin(2 * Math.PI * ANS_TONE_FREQ * n / SR) * ANS_TONE_AMP;
      }
      return out;
    }
    for (let c = 0; c < count; c++) {
      const n = this.txN++;
      if (!this.txContinuous && this.txEndSample >= 0 && n >= this.txEndSample) {
        this.txState = 'idle'; this._resetTxBurst(); break;
      }
      const st = n / SPS;
      const klo = Math.max(0, Math.ceil(st - SPAN / 2)), khi = Math.floor(st + SPAN / 2);
      this._ensureSymbols(khi);
      let ai = 0, aq = 0;
      for (let k = Math.max(klo, this.txSymBase); k <= khi; k++) {
        const s = this.txSyms[k - this.txSymBase];
        if (!s) break;
        const p = rrc(st - k); ai += s.i * p; aq += s.q * p;
      }
      const ph = 2 * Math.PI * FC * n / SR;
      out[c] = (ai * Math.cos(ph) - aq * Math.sin(ph)) * TX_GAIN;
    }
    if (this.txContinuous) {
      const oldest = Math.floor(this.txN / SPS - SPAN) - 1;
      const drop = oldest - this.txSymBase;
      if (drop > 512) { this.txSyms.splice(0, drop); this.txSymBase += drop; }
    }
    return out;
  }

  // ─── RX ────────────────────────────────────────────────────────────────────
  _resetRx() {
    this.rx = [];
    this.rxBase = 0;
    this.acq = false;
    this.base = 0;
    this.symIdx = 0;
    this.des = new Array(23).fill(0);
    this.gr = 1; this.gi = 0; this.g2 = 1;
    this.outbits = [];
    this.rxPts = [];                 // sliced points accumulating toward one mapping frame
    this.rxFrameIdx = 0;             // mapping-frame counter, aligned to TX frame 0 at acquisition
    this.rxCoder.reset();
    this.uState = 'hunt'; this.uArmed = false; this.uMarks = 0; this.uBit = 0; this.uByte = 0;
    this._rxData = false;
    this._cState = 'idle'; this._cHi = 0;
    // Which signal this burst is. Phase 3 comes first and exactly once; everything
    // after the silence that ends it is Phase 4, which is what the data preamble
    // acquisition below was written against.
    this.rxPhase = this._sawPhase3 ? 'data' : 'phase3';
    this._sHuntPos = 0;                // absolute scan position, forward-only
    this._sRef = null;                 // {a, b}: the two S symbols as received
    // The timing lock belongs to a burst and is re-acquired on the next one — but
    // the S / S̄ counts do not, because §9.3.2.4's silence divides ONE Phase 3 into
    // two transmissions and the transitions on either side of it are the same
    // procedure's. The differential decoder restarts (its predecessor is on the far
    // side of a gap); the descrambler is self-synchronising and needs no help.
    // The parity goes with the timing lock, so a re-acquired burst re-resolves it on
    // its own S-to-S̄ transition. §9.3.2.7's S and §9.3.2.8's S̄ are exactly that.
    if (this.p3) {
      this.p3.dec.prev = null; this.p3.runKind = null; this.p3.runLen = 0;
      this.p3.lastRot = -1; this.p3.parityKnown = false;
    }
  }

  _bb(n) { const ph = 2 * Math.PI * FC * n / SR; const s = this.rx[n - this.rxBase]; return [s * Math.cos(ph) * 2, -s * Math.sin(ph) * 2]; }
  _sym(pos) {
    const end = this.rxBase + this.rx.length - 1;
    const nlo = Math.max(this.rxBase, Math.ceil(pos - SPAN / 2 * SPS));
    const nhi = Math.min(end, Math.floor(pos + SPAN / 2 * SPS));
    let ai = 0, aq = 0;
    for (let n = nlo; n <= nhi; n++) { const b = this._bb(n); const p = rrc((n - pos) / SPS); ai += b[0] * p; aq += b[1] * p; }
    return [ai, aq];
  }

  receiveAudio(f32) {
    for (let i = 0; i < f32.length; i++) {
      const s = f32[i];
      this.rxLevel += RX_A * (Math.abs(s) - this.rxLevel);
      if (this.rxLevel > RX_HI) { this.rxOn = true; this.rxLow = 0; }
      else if (this.rxLevel < RX_LO && this.rxOn) { this.rxLow++; }
      if (this.rxOn) this.rx.push(s);
      if (this.rxOn && this.rxLow > RX_HANG) {
        this._process();
        // A silence ends Phase 3 only once the peer has sent every S-to-S̄ transition
        // its procedure contains. V.90's analogue modem falls silent MID-Phase 3
        // (§9.3.2.4) and resumes with S after Jd, so a receiver that took the first
        // silence for the end would hand §9.3.2.7's S to the data acquisition.
        // Recorded before _resetRx, which reads it to decide what comes next.
        if (this.rxPhase === 'phase3' && this.p3.sbarCount >= this._p3SbarTarget) {
          this._sawPhase3 = true;
        }
        this.rxOn = false;
        this._resetRx();
      }
    }
    if (this.rxOn) this._process();
  }

  /**
   * Find the S-to-S̄ transition, which is §11.3.1.1.1's gate.
   *
   * S and S̄ have the SAME differential signature — both alternate by ±90°, since S̄
   * is S rotated by 180° — so a differential detector cannot separate them and the
   * reference has to be absolute. The two-symbol reference `_sRef` is taken from the
   * head of S once its structure is confirmed, and the transition is then the point
   * at which both parities correlate NEGATIVELY against it. That is rotation- and
   * gain-invariant with respect to the channel, which is what lets it run before any
   * of the data path's acquisition exists.
   *
   * The scan is forward-only (`_sHuntPos` is an absolute index that only advances),
   * for the reason V90's `_huntSd` gives: rescanning the buffer on every chunk is
   * quadratic, and with a one-second answer tone in front of it that is slow enough
   * to look like a hang rather than like arithmetic.
   */
  _huntSbar() {
    const CONFIRM = 16;                 // symbols of S structure required before trusting it
    const need = Math.ceil((CONFIRM + 4) * SPS + SPAN * SPS);
    if (this.rx.length < need) return;

    if (!this._sRef) {
      // Onset, then the same fractional timing search the data path uses. S is
      // constant-modulus, so maximising summed symbol magnitude finds the ISI-free
      // instant exactly as it does on the preamble.
      let onset = -1, e = 0;
      for (let n = 0; n < this.rx.length; n++) {
        const b = this._bb(n); const m = Math.hypot(b[0], b[1]);
        e = 0.85 * e + 0.15 * m;
        if (e > 0.04) { onset = Math.max(0, n - 4); break; }
      }
      if (onset < 0) return;
      let best = onset, bestScore = -1;
      for (let bo = Math.max(0, onset - 2 * SPS); bo <= onset + 2 * SPS; bo += SPS / 64) {
        let sc = 0;
        for (let k = 0; k < 12; k++) { const s = this._sym(bo + k * SPS); sc += Math.hypot(s[0], s[1]); }
        if (sc > bestScore) { bestScore = sc; best = bo; }
      }
      // Confirm this really is S before adopting a reference from it: constant
      // modulus, and consecutive symbols 90° apart. Anything else — a V.21 tail, a
      // truncated tone — fails here rather than producing a reference that a later
      // 180° coincidence would fire against.
      const sIQ = [];
      for (let j = 0; j < CONFIRM; j++) sIQ.push(this._sym(best + j * SPS));
      const mags = sIQ.map((s) => Math.hypot(s[0], s[1]));
      const mAvg = mags.reduce((t, m) => t + m, 0) / mags.length;
      if (mAvg < 1e-6) return;
      for (const m of mags) if (Math.abs(m - mAvg) > 0.35 * mAvg) return;
      for (let j = 1; j < CONFIRM; j++) {
        let d = Math.atan2(sIQ[j][1], sIQ[j][0]) - Math.atan2(sIQ[j - 1][1], sIQ[j - 1][0]);
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        if (Math.abs(Math.abs(d) - Math.PI / 2) > 0.5) return;
      }
      // Average each parity: S alternates two fixed points, so the even-index mean
      // and the odd-index mean ARE the channel's view of them.
      const acc = [[0, 0], [0, 0]], cnt = [0, 0];
      for (let j = 0; j < CONFIRM; j++) {
        const p = j & 1; acc[p][0] += sIQ[j][0]; acc[p][1] += sIQ[j][1]; cnt[p]++;
      }
      this._sRef = {
        base: best, idx: CONFIRM,
        a: [acc[0][0] / cnt[0], acc[0][1] / cnt[0]],
        b: [acc[1][0] / cnt[1], acc[1][1] / cnt[1]],
      };
      this._sMag = mAvg;
    }

    // Walk forward, classifying every symbol against the FOUR rotations of point 0.
    // The reference gives rotation 0 and rotation 3 directly (S's two points), and
    // the other two are their negations, so one confirmed stretch of S calibrates
    // the whole constellation — which is what lets everything after it (S̄ runs, and
    // the differentially encoded bits of J, J′ and Ja) be read without any further
    // acquisition. On this transport the clock does not drift, so the timing found
    // on S is still the timing 1500 symbols later.
    const r = this._sRef;
    const end = this.rxBase + this.rx.length - 1;
    for (;;) {
      const pos = r.base + r.idx * SPS;
      if (pos + SPAN / 2 * SPS >= end) return;
      const s = this._sym(pos);
      r.idx++;

      // ref[0] and ref[3] are S's two points; S̄'s are their negations (§10.1.3.7).
      let bestRot = 0, bestDot = -Infinity;
      for (let rot = 0; rot < 4; rot++) {
        const ref = (rot === 0) ? r.a : (rot === 3) ? r.b
                  : (rot === 2) ? [-r.a[0], -r.a[1]] : [-r.b[0], -r.b[1]];
        const dot = s[0] * ref[0] + s[1] * ref[1];
        if (dot > bestDot) { bestDot = dot; bestRot = rot; }
      }
      this._p3Symbol(bestRot);
    }
  }

  /**
   * One classified Phase 3 symbol: track the S / S̄ alternation, and demodulate the
   * differential bit stream that J, J′ and Ja ride on.
   *
   * S is a strict alternation between rotations 0 and 3, S̄ between 2 and 1. PP, TRN
   * and Ja are none of those, so requiring an alternation of a minimum LENGTH is what
   * separates a signal from a run of training symbols that happens to land on two
   * values — and the run length is why a stray symbol cannot manufacture a
   * transition.
   */
  _p3Symbol(rot) {
    const p = this.p3;
    const isS = (rot === 0 || rot === 3), isSbar = (rot === 1 || rot === 2);
    const kind = isS ? 's' : isSbar ? 'sbar' : null;

    // An alternation continues only if the rotation CHANGED — two identical
    // rotations in a row are not S, however well each one classifies.
    if (kind && kind === p.runKind && rot !== p.lastRot) p.runLen++;
    else { p.runKind = kind; p.runLen = 1; p.runFirstRot = rot; }
    p.lastRot = rot;

    if (p.runLen === P3_RUN_CONFIRM) {
      if (p.runKind === 's') {
        p.sCount++;
        p.inS = true;
      } else if (p.runKind === 'sbar' && p.inS) {
        // §11.3.1.1.1 / §9.3.1.4's "S and the S-to-S̄ transition": a confirmed S̄ run
        // that follows a confirmed S run, which is the only reading of "transition"
        // that a receiver can act on.
        p.sbarCount++;
        p.inS = false;
        this._sbarSeen = true;
        this._resolveP3Parity(p);
      }
    }

    // §8.3.1's Ja and §10.1.3.3's J both ride the differential encoder, so both fall
    // out of the same decode. Differential DECODING needs no initial state, and the
    // clause 7 scrambler is self-synchronising, so neither the TRN symbol the encoder
    // was initialised from nor the scrambler's state has to be known here.
    const ib = p.dec.bits(p.reflect ? (3 - rot) & 3 : rot);
    if (ib) {
      for (const bit of ib) {
        const reg = p.des3;
        const ob = bit ^ reg[this._rxTap] ^ reg[22];
        reg.unshift(bit); reg.pop();
        p.bits.push(ob);
      }
      // Bounded: a consumer that is not reading is not a reason to grow without
      // limit, and nothing needs more history than one descriptor.
      if (p.bits.length > P3_BIT_CAP) p.bits.splice(0, p.bits.length - P3_BIT_CAP);
    }
  }

  _process() {
    // Phase 3 is not the data burst and must not be handed to the data burst's
    // acquisition. TRN is 512 symbols of random 90° rotations, which will sooner or
    // later present two consecutive 180° steps followed by three near-zero ones —
    // exactly the preamble predicate below — so letting acquisition run here does
    // not merely waste work, it false-locks on noise-shaped training.
    if (this.rxPhase === 'phase3') { this._huntSbar(); return; }

    if (!this.acq) {
      if (this.rx.length < ACQ_MIN) return;
      let onset = -1, e = 0;
      for (let n = 0; n < this.rx.length; n++) { const b = this._bb(n); const m = Math.hypot(b[0], b[1]); e = 0.85 * e + 0.15 * m; if (e > 0.04) { onset = Math.max(0, n - 4); break; } }
      if (onset < 0) return;
      let best = onset, bestScore = -1;
      // Fractional symbol-timing search. The step must resolve the ISI-free instant:
      // at the tightest rate (3429, 2.33 SPS, β=0.14) the eye is sharp enough that a
      // ~0.07-sample timing error tips the slicer (SPS/16 → ~99% symbol errors,
      // SPS/64 → 0, measured). SPS/64 is a one-time acquisition
      // cost and leaves the wider 2400/3200 eyes unaffected.
      for (let bo = Math.max(0, onset - 2 * SPS); bo <= onset + 2 * SPS; bo += SPS / 64) {
        let sc = 0; for (let k = 0; k < 12; k++) { const s = this._sym(bo + k * SPS); sc += Math.hypot(s[0], s[1]); }
        if (sc > bestScore) { bestScore = sc; best = bo; }
      }
      const nSy = PRE + 8, ang = [], mag = [], sIQ = [];
      for (let j = 0; j < nSy; j++) { const s = this._sym(best + j * SPS); ang.push(Math.atan2(s[1], s[0])); mag.push(Math.hypot(s[0], s[1])); sIQ.push(s); }
      const dphi = []; for (let j = 1; j < nSy; j++) { let d = ang[j] - ang[j - 1]; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; dphi.push(Math.abs(d)); }
      let jB = -1;
      for (let j = 3; j < dphi.length - 4; j++) {
        const preAlt = dphi[j - 1] > 2.0 && dphi[j - 2] > 2.0;
        const nowConst = dphi[j] < 0.6 && dphi[j + 1] < 0.6 && dphi[j + 2] < 0.6;
        if (preAlt && nowConst) { jB = j; break; }
      }
      if (jB < 0) return;
      let mI = 0, mQ = 0, cnt = 0;
      for (let j = jB + 1; j < jB + SEG_B - 1 && j < nSy; j++) { mI += sIQ[j][0]; mQ += sIQ[j][1]; cnt++; }
      mI /= Math.max(1, cnt); mQ /= Math.max(1, cnt);
      const R2 = REF.i * REF.i + REF.q * REF.q;
      this.gr = (mI * REF.i + mQ * REF.q) / R2;
      this.gi = (mQ * REF.i - mI * REF.q) / R2;
      this.g2 = this.gr * this.gr + this.gi * this.gi || 1e-9;
      this.base = best; this.symIdx = jB + SEG_B;
      this.acq = true;
      if (!this._ready) { this._ready = true; this.emit('ready', { bps: this._rate, remoteDetected: true }); }
    }

    while (true) {
      const pos = this.base + this.symIdx * SPS;
      const end = this.rxBase + this.rx.length - 1;
      if (pos + SPAN / 2 * SPS >= end) break;
      const s = this._sym(pos);
      const xI = (s[0] * this.gr + s[1] * this.gi) / this.g2;
      const xQ = (s[1] * this.gr - s[0] * this.gi) / this.g2;
      // slice to the nearest odd-integer lattice point (the transmitted point on
      // the lossless link); guard against a rep outside the quarter set.
      const pt = { i: sliceOdd(xI), q: sliceOdd(xQ) };
      this.symIdx++;
      if (labelOf(invRot(pt).rep) < 0) { this.rxPts = []; continue; }  // resync on stray point
      this.rxPts.push(pt);
      if (this.rxPts.length === SYMS_PER_FRAME) {
        // This frame's parity is fixed by the SWP-driven counter, aligned to the TX
        // because acquisition lands on TX frame 0 and both advance in lockstep on
        // the drift-free clock. decodeFrame returns b (high) or b−1 (low) bits.
        const high = CFG.isHighFrame(this.rxFrameIdx++);
        const fbits = this.rxCoder.decodeFrame(this.rxPts, high);
        this.rxPts = [];
        for (let b = 0; b < fbits.length; b++) {
          const bit = fbits[b];
          const r = this.des; const ob = bit ^ r[this._rxTap] ^ r[22]; r.unshift(bit); r.pop(); this.outbits.push(ob);
        }
        this._uartConsume();
      }

      const drop = Math.floor(this.base + (this.symIdx - SPAN) * SPS) - this.rxBase;
      if (drop > 512) { this.rx.splice(0, drop); this.rxBase += drop; }
    }
  }

  _uartConsume() {
    while (this.outbits.length) {
      const bit = this.outbits.shift();
      if (this.uState === 'hunt') {
        if (bit === 1) { if (!this.uArmed && this.uMarks < 255 && ++this.uMarks >= UART_ARM_MARKS) this.uArmed = true; }
        else if (this.uArmed) { this.uState = 'data'; this.uBit = 0; this.uByte = 0; }
      } else if (this.uState === 'data') {
        this.uByte |= (bit << this.uBit); this.uBit++;
        if (this.uBit === 8) this.uState = 'stop';
      } else {
        if (bit === 1) { this._rxByte(this.uByte & 0xff); this.uState = 'hunt'; }
        else { this.uState = 'hunt'; this.uArmed = false; this.uMarks = 0; }
      }
    }
  }

  _rxByte(b) {
    if (this._rxData) { this.emit('data', Buffer.from([b])); return; }
    switch (this._cState) {
      case 'idle': if (b === DLE) this._cState = 'esc'; break;
      case 'esc':
        if (b === CTL_MP) { this._cState = 'mp'; this._mpBuf = []; }
        else if (b === CTL_DATA) { this._rxData = true; this._cState = 'idle'; }
        else this._cState = 'idle';
        break;
      case 'mp': {
        // Fixed length, so a 0x10 inside the sequence needs no escaping.
        this._mpBuf.push(b);
        if (this._mpBuf.length < V34Phase4.MP_BYTES) break;
        this._cState = 'idle';
        this._acceptMP(V34Phase4.parseMPBytes(this._mpBuf));
        break;
      }
    }
  }

  /**
   * Take the far end's MP. The rate we read is the one for the direction the peer
   * transmits, which is the opposite field from the one we filled in.
   */
  _acceptMP(mp) {
    if (!mp.sync || !mp.crcOk || mp.type !== 0) return;
    const rate = this.role === 'answer' ? mp.callToAnswer : mp.answerToCall;
    // These three select the coding the REMOTE transmitter must use, so a
    // disagreement means the sequence we are about to receive is not one this
    // decoder can invert. Record it; the link still runs, but wrongly, and a
    // silent wrong decode is what this exchange exists to rule out.
    if (mp.trellis !== 16 || mp.theta !== 0 || mp.expandedShaping) {
      this.mpMismatch = { trellis: mp.trellis, theta: mp.theta, expandedShaping: mp.expandedShaping };
    }
    this.peerMP = mp;
    this.peerRate = rate;
    this._rate = Math.min(this._rate, rate) || this._rate;
  }
}

module.exports = { V34 };
