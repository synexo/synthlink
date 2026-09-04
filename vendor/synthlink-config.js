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

// Clean-transport V.22 detection: drop the answer-side anti-V.32-AA spectral
// gate (which cannot pass against a guard-tone-emitting peer) and rely on the
// matched-filter magnitude, which works reliably in both directions. Safe here
// because a WebSocket link has no V.32 automode signals to guard against.
config.modem.native.v22MagOnlyDetect = true;

// Clean-transport tuning. On a lossless WebSocket link there is no line noise,
// but browser RX audio arrives in bursts on a shared event loop, which makes
// the wall-clock carrier-detect stability gate flicker and never latch. Relax
// the continuous-CD requirement and widen the deadline so the originate side
// completes training reliably in the browser.
config.modem.native.cdStableMs    = 120;    // was 500ms; enough on a noiseless link
config.modem.native.listenWindowMs = 12000; // generous deadline for browser jitter
// Decisive fix for the browser: skip the wall-clock carrier-detect stability
// gate entirely. It guards against phone-line noise after a failed V.8, which
// cannot occur on a lossless WebSocket link. The gate is fragile under browser
// main-thread contention and can prevent the originate side from ever latching
// even when the carrier is present. See Handshake.js for the full rationale.
config.modem.native.skipCdVerification = true;
config.logging = config.logging || {};
config.logging.level = 'warn';

module.exports = config;
