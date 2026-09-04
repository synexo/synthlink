'use strict';
// Bundles the synthmodem native DSP for the browser. The DSP is pure JS
// (the only Node dependencies in the core tree are `events` and `Buffer`,
// both shimmed here via npm polyfills). Output is an IIFE exposing the
// global `SynthModemDSP` = { ModemDSP, Buffer }.
const esbuild = require('esbuild');

esbuild.build({
  entryPoints: ['src/browser-dsp-entry.js'],
  bundle: true,
  outfile: 'public/dsp-bundle.js',
  platform: 'browser',
  format: 'iife',
  globalName: 'SynthModemDSP',
  target: ['es2019'],
  logLevel: 'info',
  // `events` and `buffer` resolve to the installed browser polyfills.
}).then(() => {
  console.log('Built public/dsp-bundle.js');
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
