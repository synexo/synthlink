'use strict';
// Shared config tuning applied by BOTH the server and the browser bundle
// before any ModemDSP is constructed. We pin the link to V.21 (300 bps FSK):
// it is the protocol whose native<->native loopback we validated as clean and
// fast (~3.5s handshake, zero corruption), and 300 bps is period-correct and
// makes the audible carrier pleasant to listen to. To experiment with other
// protocols, change the two arrays below (see synthmodem config.js for the
// full list; V22/V22bis/V23 did not establish a clean JS<->JS loopback).
const config = require('./config');

// Default protocol; overridden per-call by the server and client based on the
// UI selection. Working originate<->answer protocols over this clean link:
//   V21 (300 bps), V22 (1200 bps), V23 (1200/75 split). V22bis (2400) is not
//   yet supported on the originate side (calling-side training unimplemented).
config.modem.native.protocolPreference = ['V21'];
config.modem.native.v8ModulationModes  = ['V21'];

// Circuit 109 as a real modem runs it, on any transport (CLAUDE.md rule 8):
// cdStableMs stays at Handshake's 500 ms, inside V.21 Table 2's 300–700 ms OFF to
// ON time on the switched network, and is counted in received samples. The wait
// for the far carrier is the calling modem's timer: long enough for a whole V.25
// answer tone (up to 4 s) ahead of the far end's carrier, which a far end may send
// even after V.8 has agreed the modulation (BinModem's V.21 does); a real modem's
// S7 allows 30 s or more from dialling.
config.modem.native.listenWindowMs = 12000;

// Bell 103's mark idle before data, measured off tools/datasource/
// bell103-capture.wav: the originate carrier comes up as the answer tone ends
// and holds mark for exactly 1.00 s before the first data bit. The upstream
// table calls this a "training duration" and gives Bell 103 zero, on the
// reasonable grounds that FSK has nothing to train — but zero is falsy there and
// falls through to a 600 ms default, so the value was never what the comment
// said. Here it is neither a default nor training: it is the pause a real Bell
// 103 call has between carrier and dialogue, and it is why one does not sound
// instant. Handshake.js's Bell 103 bypass supplies the answer tone ahead of it.
config.logging = config.logging || {};
config.logging.level = 'warn';

module.exports = config;

config.modem.native.trainingDurationMs.Bell103 = 1000;
