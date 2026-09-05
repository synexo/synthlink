#!/usr/bin/env node
'use strict';
/*
 * tools/sysoppass.js — mint the sysopPasswordHash line for config/site.json.
 *
 *   node tools/sysoppass.js
 *
 * Prompts twice with the echo off and prints the two settings to paste. The
 * password itself is never stored, never echoed, and never written anywhere by
 * this script.
 *
 * It is NOT read from a command-line argument, and that is the whole reason this
 * file exists rather than a one-liner in the documentation: an argument is
 * visible in `ps` to every other user on the machine and is written verbatim
 * into the shell history file, where it outlives the terminal by months.
 *
 * Runs by hand. Nothing on any test path requires it — tools/tests/sysoptest.js
 * calls lib/sysop.js's hashPassword() directly.
 *
 * SynthLink's own code, GPL-3.0-or-later.
 */

const readline = require('readline');
const sysop = require('../lib/sysop');

// Minimum length. A short one is the case scrypt cannot save: the parameters
// buy roughly a factor of a hundred thousand over a bare hash, and a six-letter
// password is more than that far inside a wordlist.
const MIN = 10;

/** Prompt with the terminal's echo off, so the password is never on screen. */
function askHidden(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout,
                                          terminal: true });
    // muted output stream: readline writes the prompt, then nothing.
    let muted = false;
    const realWrite = rl._writeToOutput ? rl._writeToOutput.bind(rl) : null;
    rl._writeToOutput = (s) => { if (!muted && realWrite) realWrite(s); };
    rl.question(prompt, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    muted = true;
  });
}

(async () => {
  if (!process.stdin.isTTY) {
    console.error('sysoppass: run this in a terminal — it will not read a password from a pipe,\n' +
                  'because the point of it is that the password is never in a file, an argument\n' +
                  'or a shell history.');
    process.exit(2);
  }

  console.log('Minting a sysop password hash for config/site.json.\n');
  const a = await askHidden('Password: ');
  if (a.length < MIN) {
    console.error(`\nToo short — ${MIN} characters minimum. Nothing was written.`);
    process.exit(1);
  }
  const b = await askHidden('Again:    ');
  if (a !== b) {
    console.error('\nThey do not match. Nothing was written.');
    process.exit(1);
  }

  const hash = sysop.hashPassword(a);
  console.log('\nPaste these into config/site.json:\n');
  console.log('  "sysopEnabled": true,');
  console.log('  "sysopUser": "sysop",');
  console.log(`  "sysopPasswordHash": ${JSON.stringify(hash)},`);
  console.log('\nThen restart the server and open /sysop.\n');
  console.log('The hash carries its own scrypt parameters, so raising the cost later');
  console.log('will not invalidate this line.');
})();
