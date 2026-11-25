#!/usr/bin/env node
'use strict';
// tools/tests/bm-v90.js — V.90's digital modem against BinModem's analogue modem.
//
//   node tools/tests/bm-v90.js
//
// DEVELOPMENT ONLY, and SKIPs cleanly — not counted as a pass — when the Rust
// peer is not built (cargo build --release --manifest-path tools/bridge/Cargo.toml).
//
// BinModem's analogue modem has connected to real ISP servers, which makes it the
// nearest thing to a real V.90 far end this repo can reach. bmpeer puts BinModem's
// own G.711 network model between us: µ-law, an upstream at -12 dB, a 10 ms delay
// and a little noise. So this is also the first time our upstream V.34 receiver
// has heard a transmitter that is not ours, through a path that is not lossless.
//
// What is asserted is how far a call gets, and it is a FLOOR: everything below it
// works against an independent modem today. Raise it as the start-up is fixed;
// never lower it. Where the call stops is printed after the assertions.

const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const { available, call, bmPhases, timeline } = require(path.join(ROOT, 'tools', 'bridge', 'peer'));

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log(`  ok   ${msg}`); } else { fail++; console.log(`  FAIL ${msg}`); } }

async function main() {
  const av = available();
  if (!av.ok) { console.log(`SKIP bm-v90: ${av.reason}`); process.exit(0); }

  const { V90 } = require(path.join(ROOT, 'vendor', 'src', 'dsp', 'protocols', 'V90'));
  console.log('\n[1] BinModem analogue modem (calls) → SynthLink digital modem (answers)');
  const synth = new V90('answer');
  if (synth.setV8Complete) synth.setV8Complete(true);
  // The upstream receiver's Phase 3 counters, read without touching the class.
  const probe = s => {
    const p = s.up && s.up.p3;
    return p ? `S=${p.sCount} Sbar=${p.sbarCount}` : '';
  };
  const TO_BM = 'SYNTHLINK SAYS HI 0123456789\r\n';
  const res = await call({ synth, peer: ['--proto', 'v90', '--role', 'call', '--send', 'BINMODEM SAYS HI\r\n'], secs: 8, probe, send: TO_BM });
  const bm = bmPhases(res);
  const last = res.probe.length ? res.probe[res.probe.length - 1].v : '';
  const counts = /S=(\d+) Sbar=(\d+)/.exec(last) || [0, 0, 0];

  // §9.2 is §11.2/V.34 with the parts renamed, so this is our INFO0d, tones,
  // probe and INFO1d accepted by a receiver that has accepted real servers'.
  ok(bm.includes('V.90 phase 3: training'), 'BinModem completed §9.2 against us and began its Phase 3');
  // §9.3.1.1: the digital modem's first job in Phase 3 is to detect S and the
  // S-to-S̄ transition. That it does, through µ-law at -12 dB, is the upstream
  // V.34 receiver acquiring a transmitter that is not ours.
  ok(+counts[1] >= 1 && +counts[2] >= 1,
     `our upstream receiver detected BinModem's S and the S-to-S̄ transition (§9.3.1.1) [${last}]`);
  // §9.3.1.3: Sd follows the RECEIPT of Ja. Ja rides the upstream scrambled with
  // GPA (§6.5/V.90); a digital modem descrambling with GPC reads nothing.
  ok(synth._jaSeen === true, "we parsed BinModem's Ja, CRC and all, and sent Sd (§9.3.1.3)");
  // BinModem's analogue modem leaves its training stage only once our TRN1d has
  // trained it — TRN1d's signs are GPC-scrambled ones (§8.4.5).
  ok(bm.includes('V.90 phase 3: Jd'), 'BinModem trained on our Sd and TRN1d (§8.4.4, §8.4.5)');
  const jd = res.bm.find(e => e.ev === 'jd');
  // Table 13: rate bit n is drn n + 1, 28 000 + n × 8000/6 bit/s.
  const ourBit = Math.round((synth._rate - 28000) / (8000 / 6));
  ok(!!jd && ((jd.jd.rates >>> ourBit) & 1) === 1,
     `BinModem read our Jd and it enables our ${synth._rate} bit/s (§8.4.2, Table 13) [${jd ? JSON.stringify(jd.jd) : 'no Jd'}]`);
  // §9.3.1.5: the Jd rate list is every rung up to ours, not ours alone — the
  // analogue modem chooses from it after DIL, and with one rung it could only fail.
  ok(!!jd && ((jd.jd.rates >>> 0) & 1) === 1, 'our Jd also enables 28 000, so the analogue modem has a ladder to choose from');
  const notes0 = res.bm.filter(e => e.ev === 'note').map(e => e.text);
  // §9.3.1.5: our receiver saw §9.3.2.7's S after Jd, sent J′d and DIL, and
  // BinModem's route analysis accepted it.
  ok(bm.includes('V.90 phase 4'), 'BinModem read our DIL and chose a rate: Phase 4 (§9.3.2.10)');
  // §9.4.1.1: Ri until CPt — CPt read from the upstream, six constellations long.
  ok(synth._cptSeen === true, "we read BinModem's CPt (Table 14: rate (drn + 8)·8000/6) and left Ri");
  // §8.6: TRN2d, MP and Ed on CPt's constellation, §5.4.5.1's differential signs.
  ok(notes0.some(n => /^found MP/.test(n)) && notes0.some(n => /^found Ed/.test(n)),
     'BinModem decoded our MP and Ed on the training constellation (§8.6, §5.4.5.1)');
  ok(res.bmConnected && /Connected/.test(res.bmConnected.status),
     `BinModem entered data mode — ${res.bmConnected ? res.bmConnected.status : 'no'}`);
  ok(res.bmRx.toString('latin1') === TO_BM,
     `BinModem received our downstream text exactly — ${JSON.stringify(res.bmRx.toString('latin1').slice(0, 40))}`);
  // The upstream: our receiver measures the noise in training and asks, in our MP,
  // for what it can take (V34._rxCap), and BinModem's E then names that rate. This
  // used to assert the rate was under 33 600, which was true while our Phase 2 went
  // out at −13.8 dBm0; at a modem's −10 BinModem's upstream trains to 33 600, which
  // our receiver measures it can take and reads exactly (the next two assertions).
  ok(synth._rateUp === synth.up._rxCap() && res.bm.some(e => e.ev === 'note' && e.text.includes(`up at ${synth._rateUp} bit/s`)),
     `our MP asked for the upstream our receiver measured it can take, and BinModem runs it (${synth._rateUp} bit/s)`);
  // With §9.6's trellis decoded (V34Viterbi) that is 26 400; the hard slicer it
  // replaced managed 24 000. Forced to 28 800 the line errs even with Viterbi, which
  // is what the rate rule's bound predicts.
  ok(synth._rateUp >= 26400, `the upstream is at least 26 400 — Viterbi's rung (${synth._rateUp} bit/s)`);
  ok(res.slRx.toString('latin1') === 'BINMODEM SAYS HI\r\n',
     `we received BinModem's upstream text exactly, nothing else — ${JSON.stringify(res.slRx.toString('latin1').slice(0, 40))}`);
  console.log(`  -- last phases: ${bm.slice(-3).join(" > ")}`);
  const notes = res.bm.filter(e => e.ev === 'note').map(e => e.text);
  if (notes.length) console.log(`  -- BinModem: ${notes.join(' | ')}`);

  // ── V.42 over V.90: both modems doing error control, as real ones did ──
  // The class under ErrorControl as Handshake runs it in the modem: attached when
  // the pump is ready, timed by the samples generated, `ready` once V.42 settles.
  // BinModem runs its own stack over its analogue modem (bmpeer --v42).
  {
    console.log('\n[2] V.42 over V.90: BinModem analogue (calls) → SynthLink digital (answers)');
    const { EventEmitter } = require('events');
    const { ErrorControl } = require(path.join(ROOT, 'vendor', 'src', 'ec', 'ErrorControl'));
    const v90 = new V90('answer');
    if (v90.setV8Complete) v90.setV8Complete(true);
    const modem = new EventEmitter();
    let ec = null;
    v90.on('ready', (info) => {
      ec = new ErrorControl({ role: 'answer', protocol: v90, bps: info.bps || 28000, compression: 'both' });
      ec.on('data', (d) => modem.emit('data', d));
      ec.on('settled', (r) => modem.emit('ready', { ...info, ...r }));
    });
    v90.on('data', (d) => { if (!ec) modem.emit('data', d); });
    modem.generateAudio = (n) => { const out = v90.generateAudio(n); if (ec) ec.tick(n / 8); return out; };
    modem.receiveAudio = (x) => v90.receiveAudio(x);
    modem.write = (d) => (ec ? ec.write(d) : v90.write(d));
    const res2 = await call({ synth: modem, peer: ['--proto', 'v90', '--role', 'call', '--send', 'BINMODEM SAYS HI\r\n', '--v42', 'both'], secs: 12, send: TO_BM });
    const info = res2.slReady ? res2.slReady.info : {};
    const notes2 = res2.bm.filter((e) => e.ev === 'note' && e.text.startsWith('V.42')).map((e) => e.text);
    ok(info.errorControl === 'LAPM' && info.compression === 'V.44' && notes2.includes('V.42: LAPM compression=V.44'),
       `V.42 with V.44 at both ends — ours ${info.errorControl}/${info.compression}, BinModem's ${notes2.join(', ') || 'none'}`);
    ok(res2.bmRx.toString('latin1') === TO_BM && res2.slRx.toString('latin1') === 'BINMODEM SAYS HI\r\n',
       `text exact both ways through it — ${JSON.stringify(res2.slRx.toString('latin1'))} / ${JSON.stringify(res2.bmRx.toString('latin1'))}`);
  }

  // ── [3] §9.5's retrain, against BinModem's analogue modem ────────────────
  // What Handshake does on a V.90 `retrain` (a fresh instance that continues the
  // call, resumeFrom), without the V.8 bmpeer's V.90 does not run. BinModem asks
  // first (its API: --retrain-at), then we do. BinModem's own receiver has no
  // clamp, so what it decodes of our silence before the tone reaches its terminal.
  console.log('\n[3] Retrain (§9.5)');
  {
    const { EventEmitter } = require('events');
    const swapper = () => {
      const s = new EventEmitter(); s.log = [];
      const wire = (m) => {
        m.on('ready', (i) => { s.log.push(`ready ${Math.round(i.bps)}`); s.emit('ready', i); });
        m.on('data', (d) => s.emit('data', d));
        m.on('retrain', (e) => {
          s.log.push(`retrain ${e.why}`);
          const f = new V90('answer'); f.setV8Complete(true); f.resumeFrom(m);
          m.removeAllListeners(); s.cur = f; wire(f);
        });
      };
      s.cur = new V90('answer'); s.cur.setV8Complete(true); wire(s.cur);
      s.generateAudio = (n) => s.cur.generateAudio(n); s.receiveAudio = (f) => s.cur.receiveAudio(f);
      s.write = (b) => s.cur.write(b); s.describe = () => s.cur.describe && s.cur.describe();
      return s;
    };
    for (const [who, extra, at] of [['BinModem', ['--retrain-at', '2'], null], ['SynthLink', [], 6]]) {
      const s = swapper();
      const r = await call({ synth: s, secs: 26, send: 'BEFORE\r\n',
        at: [[22, (S) => S.write(Buffer.from('SL AFTER\r\n'))], ...(at ? [[at, (S) => S.cur.retrain()]] : [])],
        peer: ['--proto', 'v90', '--role', 'call', '--send', 'BINMODEM SAYS HI\r\n', '--send-again', '18:BM AFTER\\r\\n', ...extra] });
      const conns = r.bm.filter((e) => e.ev === 'phase' && /^Connected/.test(e.status));
      const sl = r.slRx.toString('latin1'), bmt = r.bmRx.toString('latin1');
      ok(s.log.filter((l) => l.startsWith('ready')).length === 2 && conns.length >= 2 &&
         sl === 'BINMODEM SAYS HI\r\nBM AFTER\r\n' && bmt.startsWith('BEFORE\r\n') && bmt.endsWith('SL AFTER\r\n'),
         `${who} retrains: both back in data, text exact both ways after — ${s.log.join(', ')}; ${conns.slice(-1)[0] ? conns.slice(-1)[0].status : 'no reconnect'}`);
    }
  }

  // ── [4] §9.6's rate renegotiation, against BinModem's analogue modem ─────
  // In place, the data frames kept in step: BinModem asks first (--renegotiate-at,
  // its API, for 40 000 down), and we answer its S with Rd (§9.6.1.2); then we ask
  // (§9.6.1.1), upstream at most 26 400, and it answers our Rd with S, S̄ and CP.
  // No retrain either way, and the text after crosses at the new rates.
  console.log('\n[4] Rate renegotiation (§9.6)');
  for (const [who, extra, at, up, want] of [
    ['BinModem', ['--renegotiate-at', '3:40000'], null, null, /transmit: 33600, receive: 40000/],
    ['SynthLink', [], 8, 26400, /transmit: 26400, receive: 42666/],
  ]) {
    const s = new V90('answer'); s.setV8Complete(true);
    const log = [];
    for (const e of ['renegotiate', 'renegotiated', 'retrain']) s.on(e, (x) => log.push(`${e} ${x.why || Math.round(x.bps) + '/' + x.bpsUpstream}`));
    const r = await call({ synth: s, secs: 16, send: 'BEFORE\r\n',
      at: [[12, (S) => S.write(Buffer.from('SL AFTER\r\n'))], ...(at ? [[at, (S) => S.renegotiate(up)]] : [])],
      peer: ['--proto', 'v90', '--role', 'call', '--send', 'BINMODEM SAYS HI\r\n', '--send-again', '6:BM AFTER\\r\\n', ...extra] });
    const conns = r.bm.filter((e) => e.ev === 'phase' && /^Connected/.test(e.status));
    const last = conns.length ? conns[conns.length - 1].status : 'none';
    ok(log.some((l) => l.startsWith('renegotiated')) && !log.some((l) => l.startsWith('retrain')) && want.test(last) &&
       r.slRx.toString('latin1') === 'BINMODEM SAYS HI\r\nBM AFTER\r\n' && r.bmRx.toString('latin1') === 'BEFORE\r\nSL AFTER\r\n',
       `${who} renegotiates, in place: ${last}, text exact both ways after — ${log.join(', ')}`);
  }

  // ── [5] Our ANALOGUE modem against BinModem's DIGITAL modem ──────────────
  // bmpeer --role answer: BinModem's digital modem with a server's INFO0d (a −12
  // dBm0 ceiling), its codewords handed to us exactly as a SIP gateway hands them,
  // through the law, a T1's robbed bit and a digital pad. Our analogue modem
  // learns the route from its DIL (V90Dil.js) and chooses each interval's
  // constellation; BinModem's digital modem is held to whatever CP asks.
  console.log('\n[5] SynthLink analogue modem (calls) → BinModem digital modem, over the route');
  for (const [name, extra, least] of [
    ['clean µ-law', [], 56000],
    ['a robbed bit in interval 2', ['--rbs', '2'], 50000],
    ['a 6 dB pad', ['--pad', '6'], 50000],
    ['A-law', ['--alaw'], 56000],
    ['A-law, a 3 dB pad, a robbed bit in interval 5', ['--alaw', '--pad', '3', '--rbs', '5'], 50000],
  ]) {
    const s = new V90('originate'); s.setV8Complete(true);
    let up = null; s.on('ready', (i) => { up = i; });
    const r = await call({ synth: s, secs: 14, send: TO_BM, peer: ['--proto', 'v90', '--role', 'answer', '--send', 'BINMODEM SAYS HI\r\n', ...extra] });
    const conns = r.bm.filter((e) => e.ev === 'phase' && /^Connected/.test(e.status));
    const last = conns.length ? conns[conns.length - 1].status : 'none';
    const m = /transmit: (\d+)/.exec(last);
    ok(up && m && Math.abs(+m[1] - up.bps) < 2 && up.bps >= least - 1 &&
       r.slRx.toString('latin1') === 'BINMODEM SAYS HI\r\n' && r.bmRx.toString('latin1') === TO_BM,
       `${name}: ${last}, ours ${up ? Math.round(up.bps) : 'no'}, text exact both ways`);
  }

  // ── [6] Our digital modem on an A-law network ────────────────────────────
  // config v90Law 'a': INFO0d says A-law and every codeword is A-law's level, so
  // BinModem's analogue modem reads an A-law server, not a µ-law one requantised.
  console.log('\n[6] SynthLink digital modem on an A-law network');
  {
    const config = require(path.join(ROOT, 'vendor', 'config'));
    config.modem.native.v90Law = 'a';
    const s = new V90('answer'); s.setV8Complete(true);
    config.modem.native.v90Law = undefined;
    const r = await call({ synth: s, secs: 10, send: TO_BM, peer: ['--proto', 'v90', '--role', 'call', '--send', 'BINMODEM SAYS HI\r\n', '--alaw'] });
    const conns = r.bm.filter((e) => e.ev === 'phase' && /^Connected/.test(e.status));
    const last = conns.length ? conns[conns.length - 1].status : 'none';
    ok(/receive: (4[4-9]|5\d)\d{3}/.test(last) && r.slRx.toString('latin1') === 'BINMODEM SAYS HI\r\n' && r.bmRx.toString('latin1') === TO_BM,
       `A-law both ends: ${last} (it was 36 000 with our µ-law requantised), text exact both ways`);
  }

  if (fail && process.env.VERBOSE) console.log('\n' + timeline(res));
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
