'use strict';
// Universal logger shim (browser + node safe). Mirrors synthmodem's logger API
// surface used by the DSP: makeLogger(tag) -> {error,warn,info,debug,trace}.
const config = require('../config');
const LEVELS = { error:0, warn:1, info:2, debug:3, trace:4 };
function activeLevel() {
  const l = (config.logging && config.logging.level) || 'warn';
  return LEVELS[l] == null ? 1 : LEVELS[l];
}
function makeLogger(tag) {
  const emit = (lvl, args) => {
    if (LEVELS[lvl] > activeLevel()) return;
    const line = `[${lvl.toUpperCase()}] [${tag}] ` + args.join(' ');
    if (typeof process !== 'undefined' && process.stdout && process.stdout.write) {
      process.stdout.write(line + '\n');
    } else if (typeof console !== 'undefined') {
      (console[lvl] || console.log)(line);
    }
  };
  return {
    error: (...a) => emit('error', a),
    warn:  (...a) => emit('warn',  a),
    info:  (...a) => emit('info',  a),
    debug: (...a) => emit('debug', a),
    trace: (...a) => emit('trace', a),
  };
}
module.exports = { makeLogger };
