#!/usr/bin/env node
// Update the Telnet BBS Guide tier of the dial directory.
//
//   npm run update-bbslist                     fetch if a new monthly list exists
//   npm run update-bbslist -- --force          fetch even if unchanged
//   npm run update-bbslist -- --file <zip>     ingest a zip you downloaded by
//                                              hand — no network at all
//
// You can also just drop the monthly zip into cache/ and restart the server;
// it is picked up automatically. The server runs the network check on its own
// daily schedule (lib/bbslist.js) — this script is for priming a fresh checkout
// or working around a site that can't be reached.
const path = require('path');
const bbslist = require('../lib/bbslist');
const log = (m) => console.log(`[bbslist] ${m}`);

const args = process.argv.slice(2);
const force = args.includes('--force');
const fi = args.indexOf('--file');
const file = fi >= 0 ? args[fi + 1] : null;

if (fi >= 0 && !file) {
  console.error('--file needs a path to a monthly zip (e.g. ibbs0826.zip)');
  process.exit(2);
}

const done = (r) => console.log(r.changed ? `done: ${r.count} entries from ${r.file}`
                                          : `no change (${r.reason})`);
const fail = (e) => {
  console.error(`failed: ${e.message}`);
  if (!file) {
    console.error('\nIf the site cannot be reached or its page layout changed, download');
    console.error('the MONTHLY zip from https://www.telnetbbsguide.com/lists/download-list/');
    console.error('and run:  npm run update-bbslist -- --file /path/to/ibbs0826.zip');
    console.error('(or drop it into cache/ and restart the server)');
  }
  process.exit(1);
};

try {
  if (file) done(bbslist.ingestZipFile(path.resolve(file), { log }));
  else bbslist.refresh({ force, log }).then(done).catch(fail);
} catch (e) { fail(e); }
