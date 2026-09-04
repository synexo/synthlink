'use strict';
// Browser entry: polyfill Buffer, apply shared config, expose ModemDSP.
// Bundled by build.js into public/dsp-bundle.js as global `SynthModemDSP`.
const { Buffer } = require('buffer');
if (typeof globalThis.Buffer === 'undefined') globalThis.Buffer = Buffer;

// Apply shared config (mutates the shared config object in place).
const config = require('../vendor/synthlink-config');

const { ModemDSP } = require('../vendor/src/dsp/ModemDSP');

// Expose config so the client can pick a protocol before constructing a DSP.
module.exports = { ModemDSP, Buffer, config };
