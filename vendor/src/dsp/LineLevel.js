'use strict';

/**
 * LineLevel.js — the one transmit level every protocol puts on the line.
 *
 * A modem transmits at about −9 to −15 dBm0, customarily −10, and −9 is the usual
 * regulatory ceiling. Every transmitter here derives its gain from LINE_DBM0, so
 * what a user hears on the WebSocket is a real modem's level, and a far end on a
 * real line receives what it would from one.
 *
 * The scale is G.711 μ-law's: a full-scale sine is +3.17 dBm0. So a signal of RMS r
 * is 3.17 + 20·log10(r / 0.7071) dBm0.
 */

const FULL_SCALE_DBM0 = 3.17;
const LINE_DBM0 = -10;

/** RMS of a signal at `dbm0`, on this scale. */
const rmsAt = (dbm0) => Math.SQRT1_2 * Math.pow(10, (dbm0 - FULL_SCALE_DBM0) / 20);

/** RMS of any signal at the line level: 0.155. */
const LINE_RMS = rmsAt(LINE_DBM0);
/** Amplitude of a single tone at the line level: 0.2195. */
const TONE_AMP = LINE_RMS * Math.SQRT2;

module.exports = { FULL_SCALE_DBM0, LINE_DBM0, LINE_RMS, TONE_AMP, rmsAt };
