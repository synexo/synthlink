'use strict';
// SPDX-License-Identifier: GPL-3.0-or-later
//
// One call between a SynthLink protocol class and BinModem, printed as a merged
// timeline. Exploration, not a test — the assertions live in tools/tests/bm-*.js.
//
//   node tools/bridge/call.js <V32|V32bis|V34|V90|V22bis|V22> <originate|answer> [secs]
//        [--2wire] [--delay N] [--echo G] [--echo-delay N] [--send TEXT]
//        [--rate BPS]   (V.34: the rate SynthLink is configured for)
//
// SynthLink's role is given; BinModem takes the other. V22bis and V22 are whole
// calls, V.8 first, through SynthLink's ModemDSP; the rest start at the protocol. V.90 is SynthLink's
// DIGITAL modem (answer) against BinModem's analogue modem through BinModem's own
// G.711 network model.

const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const { available, call, wholeModem, timeline } = require('./peer');

const PROTOS = {
  V32:    { file: 'V32',    cls: 'V32',    peer: 'v32' },
  V32bis: { file: 'V32bis', cls: 'V32bis', peer: 'v32bis' },
  V34:    { file: 'V34',    cls: 'V34',    peer: 'v34' },
  V90:    { file: 'V90',    cls: 'V90',    peer: 'v90' },
  // Whole calls, V.8 included: SynthLink's ModemDSP against BinModem's V.8 and pump.
  V22bis: { whole: 'V22bis', peer: 'v22bis' },
  V22:    { whole: 'V22',    peer: 'v22' },
};

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : dflt;
}

(async () => {
  const [proto, role = 'originate', secsS = '20'] = process.argv.slice(2).filter(a => !a.startsWith('--') &&
    !['--delay', '--echo', '--echo-delay', '--send', '--rate'].includes(process.argv[process.argv.indexOf(a) - 1]));
  const p = PROTOS[proto];
  if (!p || !['originate', 'answer'].includes(role)) {
    console.error('usage: node tools/bridge/call.js <V32|V32bis|V34|V90> <originate|answer> [secs] [--2wire] ...');
    process.exit(2);
  }
  const av = available();
  if (!av.ok) { console.error(av.reason); process.exit(2); }
  const rate = arg('--rate');
  // A ladder key ('26400/3429') or a bit rate (33600).
  if (rate) require(path.join(ROOT, 'vendor', 'config')).modem.native.v34Rate = /\//.test(rate) ? rate : +rate;
  let synth;
  if (p.whole) synth = wholeModem(role, p.whole);
  else {
    const Cls = require(path.join(ROOT, 'vendor', 'src', 'dsp', 'protocols', p.file))[p.cls];
    synth = new Cls(role);
    if (synth.setV8Complete) synth.setV8Complete(true);
  }
  const res = await call({
    synth,
    peer: ['--proto', p.peer, '--role', role === 'originate' ? 'answer' : 'call', '--send', 'BINMODEM SAYS HI\r\n'],
    secs: +secsS,
    line: process.argv.includes('--2wire') ? '2wire' : '4wire',
    delay: +arg('--delay', 0),
    echo: arg('--echo') == null ? undefined : +arg('--echo'),
    echoDelay: +arg('--echo-delay', 8),
    send: arg('--send', 'SYNTHLINK SAYS HI\r\n'),
  });
  console.log(timeline(res));
  console.log(`\nSynthLink received: ${JSON.stringify(res.slRx.toString('latin1'))}`);
  console.log(`BinModem  received: ${JSON.stringify(res.bmRx.toString('latin1'))}`);
})().catch(e => { console.error(e); process.exit(1); });
