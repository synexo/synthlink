#!/usr/bin/env node
/*
 * tools/blacklist-probe.js — dial every board in the Telnet BBS Guide tier and
 * append the ones that don't answer to config/blacklist.txt.
 *
 *   node tools/blacklist-probe.js                 probe + append failures
 *   node tools/blacklist-probe.js --dry-run       probe + report, write nothing
 *
 * A board FAILS when either half of a real call fails:
 *   (a) the TCP connect fails    — DNS miss, refused, unreachable, timeout, reset
 *   (b) it connects but stays silent — no byte at all within the banner window
 * (b) is included deliberately: a listener that accepts and says nothing is,
 * from the terminal's point of view, exactly as dead as one that refuses.
 *
 * This is a BLUNT instrument by design — it is meant to produce a candidate
 * list for a human to prune, not a verdict. Expect false positives from slow
 * boards, boards that only answer at certain hours, node-limited boards, and
 * anything sitting behind a residential connection that was simply down when
 * the probe ran. REVIEW THE APPENDED BLOCK before trusting it; every failure
 * gets its reason written beside it as a comment to make that review possible.
 *
 * Nothing is ever removed or rewritten: the run appends one commented block,
 * fenced by a BEGIN/END header and footer carrying the tool name and the run's
 * start and end times, so a bad run can be undone by deleting its block.
 *
 * Being a good citizen: one connection per board, a bounded concurrency pool,
 * and no reconnect except the retry pass over failures (which is what keeps a
 * transient blip from blacklisting a live board). The probe reads the banner
 * and disconnects — it never negotiates telnet, never logs in, never speaks.
 *
 * Options:
 *   --dry-run                report only; do not touch config/blacklist.txt
 *   --concurrency <n>        parallel probes            (default 24)
 *   --connect-timeout <ms>   TCP connect window         (default 12000)
 *   --banner-timeout <ms>    silence window after connect (default 12000)
 *   --retries <n>            extra passes over failures (default 1)
 *   --retry-delay <ms>       pause before each retry pass (default 20000)
 *   --limit <n>              probe only the first n entries (testing)
 *   --json <path>            also write a machine-readable report
 *   --quiet                  suppress the per-board progress lines
 */

const fs   = require('fs');
const net  = require('net');
const path = require('path');
const bbslist = require('../lib/bbslist');

const ROOT      = path.join(__dirname, '..');
const GUIDE_JSON = path.join(ROOT, 'cache', 'guide.json');
const BLACKLIST  = bbslist.BLACKLIST;
const TOOL = 'tools/blacklist-probe.js';

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
function num(flag, dflt) {
  const i = argv.indexOf(flag);
  if (i < 0) return dflt;
  const v = parseInt(argv[i + 1], 10);
  if (!Number.isFinite(v) || v <= 0) {
    console.error(`${flag} needs a positive number`);
    process.exit(2);
  }
  return v;
}
function str(flag, dflt) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
}

const OPT = {
  dryRun:         has('--dry-run'),
  quiet:          has('--quiet'),
  concurrency:    num('--concurrency', 24),
  connectTimeout: num('--connect-timeout', 12000),
  bannerTimeout:  num('--banner-timeout', 12000),
  retries:        argv.includes('--retries') ? num('--retries', 1) : 1,
  retryDelay:     num('--retry-delay', 20000),
  limit:          num('--limit', 0),
  json:           str('--json', null),
};

const unknown = argv.filter((a, i) =>
  a.startsWith('--') && !['--dry-run', '--quiet', '--concurrency', '--connect-timeout',
    '--banner-timeout', '--retries', '--retry-delay', '--limit', '--json'].includes(a));
if (unknown.length) {
  console.error(`unknown option(s): ${unknown.join(' ')}`);
  process.exit(2);
}

// ── one probe ───────────────────────────────────────────────────────────────
// Resolves { ok, reason, ms }. Never rejects — a probe result is data, not an
// error, and one unreachable board must not take the run down with it.
function probe(host, port) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let settled = false;
    let connected = false;
    let timer = null;

    const done = (ok, reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // destroy() rather than end(): we owe the board nothing and a half-open
      // socket would sit in the pool holding a slot.
      try { sock.destroy(); } catch (_) {}
      resolve({ ok, reason, ms: Date.now() - t0 });
    };

    const sock = new net.Socket();
    sock.setNoDelay(true);

    // Node's own connect timeout is unreliable across platforms for a host that
    // blackholes SYNs, so the window is enforced here.
    timer = setTimeout(() => done(false, 'connect timeout'), OPT.connectTimeout);

    sock.on('connect', () => {
      connected = true;
      clearTimeout(timer);
      timer = setTimeout(() => done(false, 'no banner'), OPT.bannerTimeout);
    });

    // ANY byte counts, including a bare telnet IAC negotiation — a board that
    // negotiates is alive even if its banner is still being drawn.
    sock.on('data', () => done(true, 'answered'));

    sock.on('error', (e) => {
      const code = e && e.code ? e.code : (e && e.message) || 'error';
      // A reset AFTER data would already have resolved ok above; a reset before
      // it means the listener dropped us — node limit, tarpit, or dead service.
      done(false, connected ? `reset before banner (${code})` : errText(code));
    });

    sock.on('close', () => done(false, connected ? 'closed before banner' : 'closed'));

    sock.connect({ host, port });
  });
}

function errText(code) {
  switch (code) {
    case 'ENOTFOUND':    return 'DNS: host not found';
    case 'EAI_AGAIN':    return 'DNS: lookup failed';
    case 'ECONNREFUSED': return 'connection refused';
    case 'EHOSTUNREACH': return 'host unreachable';
    case 'ENETUNREACH':  return 'network unreachable';
    case 'ETIMEDOUT':    return 'connect timeout';
    case 'ECONNRESET':   return 'reset on connect';
    default:             return String(code);
  }
}

// ── bounded pool ────────────────────────────────────────────────────────────
async function runPool(items, worker, concurrency) {
  const out = new Array(items.length);
  let next = 0;
  const lane = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, lane));
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = (d) => d.toISOString().replace('T', ' ').replace(/\..*$/, ' UTC');

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  const started = new Date();

  let guide;
  try { guide = JSON.parse(fs.readFileSync(GUIDE_JSON, 'utf8')); }
  catch (_) { guide = null; }
  if (!guide || !Array.isArray(guide.entries) || !guide.entries.length) {
    console.error(`no guide list cached at ${path.relative(ROOT, GUIDE_JSON)}.`);
    console.error('Prime it first:  npm run update-bbslist');
    process.exit(1);
  }

  // Already-blacklisted boards are skipped: re-probing them cannot change the
  // outcome and would only duplicate lines in the file.
  const bl = bbslist.parseBlacklist(
    (() => { try { return fs.readFileSync(BLACKLIST, 'utf8'); } catch (_) { return ''; } })());
  let entries = guide.entries.filter((e) => !bbslist.isBlacklisted(e.host, e.port, bl));
  const skipped = guide.entries.length - entries.length;

  // The guide keeps distinct listings that share an address (see lib/bbslist.js),
  // but there is no reason to dial the same socket twice in one run.
  const byAddr = new Map();
  for (const e of entries) {
    const key = `${e.host.toLowerCase()}:${e.port}`;
    if (!byAddr.has(key)) byAddr.set(key, { ...e, key, names: [e.name] });
    else byAddr.get(key).names.push(e.name);
  }
  let targets = [...byAddr.values()];
  if (OPT.limit) targets = targets.slice(0, OPT.limit);

  console.log(`[probe] ${guide.file || 'guide'}: ${guide.entries.length} entries, `
    + `${skipped} already blacklisted, ${targets.length} addresses to probe`);
  console.log(`[probe] concurrency ${OPT.concurrency}, connect ${OPT.connectTimeout}ms, `
    + `banner ${OPT.bannerTimeout}ms, ${OPT.retries} retry pass(es)`
    + (OPT.dryRun ? ' — DRY RUN, nothing will be written' : ''));

  let done = 0;
  const total = targets.length;
  const attempt = async (t) => {
    const r = await probe(t.host, t.port);
    done++;
    if (!OPT.quiet) {
      const tag = r.ok ? 'ok  ' : 'FAIL';
      console.log(`[${String(done).padStart(String(total).length)}/${total}] `
        + `${tag} ${t.host}:${t.port}  ${r.reason} (${r.ms}ms)  ${t.names[0]}`);
    }
    return { ...t, ...r };
  };

  let results = await runPool(targets, attempt, OPT.concurrency);
  let failures = results.filter((r) => !r.ok);
  const okByKey = new Map(results.filter((r) => r.ok).map((r) => [r.key, r]));

  // Retry passes. A board that answers on ANY pass is live — the point of the
  // retry is to keep a momentary blip (or our own outbound congestion) from
  // condemning a working board.
  for (let pass = 1; pass <= OPT.retries && failures.length; pass++) {
    console.log(`[probe] retry pass ${pass}: ${failures.length} address(es) in `
      + `${Math.round(OPT.retryDelay / 1000)}s`);
    await sleep(OPT.retryDelay);
    done = 0;
    const retryTargets = failures;
    const n = retryTargets.length;
    const retried = await runPool(retryTargets, async (t) => {
      const r = await probe(t.host, t.port);
      done++;
      if (!OPT.quiet) {
        console.log(`[retry ${pass} ${done}/${n}] ${r.ok ? 'ok  ' : 'FAIL'} `
          + `${t.host}:${t.port}  ${r.reason} (${r.ms}ms)`);
      }
      return { ...t, ...r };
    }, OPT.concurrency);
    for (const r of retried) if (r.ok) okByKey.set(r.key, r);
    failures = retried.filter((r) => !r.ok);
  }

  const finished = new Date();
  const live = okByKey.size;
  console.log(`\n[probe] ${live} answered, ${failures.length} failed, `
    + `${Math.round((finished - started) / 1000)}s elapsed`);

  if (OPT.json) {
    const report = {
      tool: TOOL,
      guideFile: guide.file || null,
      started: started.toISOString(),
      finished: finished.toISOString(),
      options: OPT,
      probed: targets.length,
      live,
      failures: failures.map((f) => ({ name: f.names[0], names: f.names, host: f.host,
                                       port: f.port, reason: f.reason, ms: f.ms })),
    };
    fs.writeFileSync(path.resolve(OPT.json), JSON.stringify(report, null, 2));
    console.log(`[probe] report written to ${OPT.json}`);
  }

  if (!failures.length) {
    console.log('[probe] nothing to add.');
    return;
  }

  // Sort by name so the appended block reads like the directory does.
  failures.sort((a, b) => a.names[0].localeCompare(b.names[0], 'en', { sensitivity: 'base' }));

  const lines = [];
  lines.push('');
  lines.push(`# ── BEGIN automatic block — added by ${TOOL} ──────────────────`);
  lines.push(`# Source list : ${guide.file || 'unknown'}`);
  lines.push(`# Run started : ${stamp(started)}`);
  lines.push(`# Run finished: ${stamp(finished)}`);
  lines.push(`# Probed ${targets.length} address(es): ${live} answered, ${failures.length} did not.`);
  lines.push(`# Criteria    : TCP connect within ${OPT.connectTimeout}ms AND at least one`);
  lines.push(`#               byte within ${OPT.bannerTimeout}ms of connecting, over`);
  lines.push(`#               ${1 + OPT.retries} attempt(s).`);
  lines.push('# These are CANDIDATES, not verdicts — a board can be down for the hour,');
  lines.push('# node-limited, or simply slower than the window. Review and delete any');
  lines.push('# line that should stay in the directory; the whole block can be removed.');
  lines.push('#');
  for (const f of failures) {
    const alias = f.names.length > 1 ? ` (also: ${f.names.slice(1).join(', ')})` : '';
    lines.push(`${f.host}:${f.port}    # ${f.names[0]}${alias} — ${f.reason}`);
  }
  lines.push(`# ── END automatic block — ${stamp(finished)} ${'─'.repeat(10)}`);
  lines.push('');
  const block = lines.join('\n');

  if (OPT.dryRun) {
    console.log('\n[probe] --dry-run; would append:\n');
    console.log(block);
    return;
  }

  fs.appendFileSync(BLACKLIST, block);
  console.log(`[probe] appended ${failures.length} entr${failures.length === 1 ? 'y' : 'ies'} `
    + `to ${path.relative(ROOT, BLACKLIST)} — review before trusting it.`);
  console.log('[probe] the server picks the edit up on the next /bbs.json request; no restart.');
}

main().catch((e) => { console.error(`failed: ${e.message}`); process.exit(1); });
