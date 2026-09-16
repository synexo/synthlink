#!/usr/bin/env node
// tools/tests/gdrivetest.js — public/gdrive.js: the optional Google Drive sync.
//
//   node tools/tests/gdrivetest.js
//
// No browser and no network. GDrive takes its script loader, its fetch, its
// clock and the Google identity object as OPTIONS, which is the seam that makes
// this testable at all — and the reason none of the module reaches for a global
// directly.
//
// What is worth asserting here is not "does it store a file". It is the three
// properties the design rests on:
//
//   THE MERGE NEVER LOSES AN ADD. A favourite made on a device that was signed
//   out must survive the next sync, whatever the other device did. That is the
//   single rule the whole three-way merge exists to keep, and §2 attacks it
//   from both sides.
//
//   NO BASE MEANS ADDITIVE. A cleared localStorage, a private window or a first
//   run leaves no record of what was last synced, and the only safe reading is
//   then the additive one. The SAFE behaviour has to be the FAILURE MODE, not
//   something the code has to remember to do — §3.
//
//   A CONFLICT IS RE-MERGED, NOT FORCED. Another device writing between our read
//   and our write must not be overwritten; §5 drives a real 412 through the
//   save path.
//
// The one thing this file cannot check is that the feature is optional, because
// that is a property of the whole page rather than of this module. uitest
// asserts the control is absent with no client id configured, and sitetest that
// the token is empty by default.

const path = require('path');
const G = require('../../public/gdrive.js');
const { GDrive, mergePrefs } = G;

let pass = 0, fail = 0;
function ok(cond, what, detail) {
  if (cond) { pass++; console.log(`  ok   ${what}`); return true; }
  fail++; console.log(`  FAIL ${what}${detail ? `\n       ${detail}` : ''}`);
  return false;
}
function section(n) { console.log(`\n── ${n}`); }
const fav = (host, port, added) => ({ name: host, host, port: port || 23, added });
const keys = (blob) => (blob.favorites || []).map((f) => `${f.host}:${f.port}`).sort();

// ─── 1. Scalars ─────────────────────────────────────────────────────────────
section('scalar preferences');
{
  const local = { syncedAt: 200, fontId: 'pixel', speaker: true };
  const remote = { syncedAt: 100, fontId: 'topaz', scrollback: 9 };
  const m = mergePrefs(local, remote, []);
  ok(m.fontId === 'pixel', 'the newer side wins a disagreement');
  ok(m.speaker === true, 'a key only the newer side has is kept');
  ok(m.scrollback === 9, 'and a key only the older side has is NOT dropped',
     `got ${m.scrollback}`);

  const m2 = mergePrefs({ syncedAt: 100, fontId: 'pixel' }, { syncedAt: 200, fontId: 'topaz' }, []);
  ok(m2.fontId === 'topaz', 'and it is genuinely the timestamp deciding, not the argument order');
}

// ─── 2. The rule the whole design rests on ──────────────────────────────────
section('favourites — an add is never lost');
{
  // Signed out on this device, added two boards. The other device has one this
  // one has never seen. Nothing may be lost in either direction.
  const local = { syncedAt: 300, favorites: [fav('a.org'), fav('b.org'), fav('new.org')] };
  const remote = { syncedAt: 200, favorites: [fav('a.org'), fav('b.org'), fav('other.org')] };
  const m = mergePrefs(local, remote, ['a.org:23', 'b.org:23']);
  ok(keys(m).join(',') === 'a.org:23,b.org:23,new.org:23,other.org:23',
     'a local add and a remote add both survive', keys(m).join(','));

  // A delete made here, WITH a base to prove it was a delete rather than a
  // board this device has simply never seen.
  const m2 = mergePrefs(
    { syncedAt: 300, favorites: [fav('a.org')] },
    { syncedAt: 200, favorites: [fav('a.org'), fav('b.org')] },
    ['a.org:23', 'b.org:23']);
  ok(keys(m2).join(',') === 'a.org:23',
     'a delete made here propagates, because the base says it was here before',
     keys(m2).join(','));

  // The same shape WITHOUT the base entry — the board is new to this device, so
  // its absence means nothing and it must be kept. This is the distinction the
  // base exists to draw, and getting it backwards is how a sync eats data.
  const m3 = mergePrefs(
    { syncedAt: 300, favorites: [fav('a.org')] },
    { syncedAt: 200, favorites: [fav('a.org'), fav('b.org')] },
    ['a.org:23']);
  ok(keys(m3).join(',') === 'a.org:23,b.org:23',
     'a board this device has never seen is kept, not deleted', keys(m3).join(','));

  // Identity is host:port, case-insensitively, exactly as favKey() has it.
  const m4 = mergePrefs(
    { syncedAt: 2, favorites: [fav('BBS.Example.Org', 2323)] },
    { syncedAt: 1, favorites: [fav('bbs.example.org', 2323)] }, []);
  ok((m4.favorites || []).length === 1, 'one board is one entry whatever its case',
     JSON.stringify(m4.favorites));

  // "Newly added" only means anything if the first-seen date survives a merge.
  const m5 = mergePrefs(
    { syncedAt: 2, favorites: [fav('a.org', 23, '2026-05-01')] },
    { syncedAt: 1, favorites: [fav('a.org', 23, '2024-01-01')] }, []);
  ok(m5.favorites[0].added === '2024-01-01',
     'the EARLIEST first-seen date wins, so "newly added" keeps its meaning',
     m5.favorites[0].added);
}

// ─── 3. No base — the safe behaviour is the failure mode ────────────────────
section('a missing base degrades to additive-only');
{
  const local = { syncedAt: 300, favorites: [fav('a.org')] };
  const remote = { syncedAt: 200, favorites: [fav('a.org'), fav('b.org')] };
  for (const base of [null, undefined, []]) {
    const m = mergePrefs(local, remote, base);
    ok(keys(m).join(',') === 'a.org:23,b.org:23',
       `base ${JSON.stringify(base)}: nothing is removed`, keys(m).join(','));
  }
  ok(keys(mergePrefs(local, null, null)).join(',') === 'a.org:23',
     'and an empty remote is the first run, which keeps everything local');
  ok(keys(mergePrefs(null, remote, null)).join(',') === 'a.org:23,b.org:23',
     'while an empty local takes everything remote');
  const m = mergePrefs({}, {}, null);
  ok(Array.isArray(m.favorites) && m.favorites.length === 0,
     'two empty sides merge to an empty list rather than throwing');
}

// ─── 4. The scope, which is the whole compliance position ───────────────────
section('scope');
{
  ok(G.SCOPE === 'https://www.googleapis.com/auth/drive.appdata',
     'the only scope requested is drive.appdata');
  ok(!/email|profile|openid/.test(G.SCOPE),
     'no email, no profile, no openid — the page never learns who the user is');
  const src = require('fs').readFileSync(
    path.join(__dirname, '..', '..', 'public', 'gdrive.js'), 'utf8');
  ok(!/client_secret/.test(src), 'and no client secret anywhere in the module');
  ok(/prompt: interactive \? '' : 'none'/.test(src),
     'the silent path is a real prompt:none, not an unattended interactive call');
}

// ─── 5. Drive I/O against a stub transport ──────────────────────────────────
section('Drive I/O');
function stub(handlers) {
  const calls = [];
  const fetch = async (url, opts) => {
    calls.push({ url, opts: opts || {} });
    for (const [re, fn] of handlers) if (re.test(url)) return fn(url, opts || {});
    throw new Error(`unstubbed ${url}`);
  };
  return { fetch, calls };
}
const res = (status, body, etag) => ({
  ok: status >= 200 && status < 300, status,
  json: async () => body,
  headers: { get: (h) => (h.toLowerCase() === 'etag' ? (etag || null) : null) },
});

(async () => {
  {
    const { fetch, calls } = stub([
      [/drive\/v3\/files\?/, async () => res(200, { files: [{ id: 'F1' }] })],
      [/files\/F1\?alt=media/, async () => res(200, { fontId: 'topaz' }, 'W/"7"')],
    ]);
    const d = new GDrive({ clientId: 'x.apps.googleusercontent.com', fetch, gis: {} });
    d.token = 'tok'; d.tokenExp = Date.now() + 1e6;
    const blob = await d.load();
    ok(blob && blob.fontId === 'topaz', 'load() returns the stored blob');
    ok(/spaces=appDataFolder/.test(calls[0].url),
       'and looks in appDataFolder — never the user\'s real Drive', calls[0].url);
    ok(calls[0].opts.headers.Authorization === 'Bearer tok', 'with a bearer token');

    // A 412 must be reported as a conflict for the caller to re-merge, NOT
    // forced through. This is the only thing standing between two devices and
    // one of them silently losing an edit.
    const { fetch: f2 } = stub([
      [/drive\/v3\/files\?/, async () => res(200, { files: [{ id: 'F1' }] })],
      [/upload.*F1/, async () => res(412, {})],
    ]);
    const d2 = new GDrive({ clientId: 'x', fetch: f2, gis: {} });
    d2.token = 'tok'; d2.tokenExp = Date.now() + 1e6; d2._etag = 'W/"7"';
    const r = await d2.save({ a: 1 });
    ok(r && r.conflict === true, 'a 412 comes back as a conflict, not an error and not a force',
       JSON.stringify(r));
  }

  {
    // No file yet: the first save must CREATE it in appDataFolder.
    const { fetch, calls } = stub([
      [/drive\/v3\/files\?/, async () => res(200, { files: [] })],
      [/upload.*multipart/, async () => res(200, { id: 'NEW' })],
    ]);
    const d = new GDrive({ clientId: 'x', fetch, gis: {} });
    d.token = 'tok'; d.tokenExp = Date.now() + 1e6;
    const r = await d.save({ favorites: [] });
    ok(r && r.created === true, 'the first save creates the file');
    const body = calls[calls.length - 1].opts.body;
    ok(/"parents":\["appDataFolder"\]/.test(body),
       'with appDataFolder as its parent — the hidden folder, not My Drive');
  }

  {
    // Expiry is a real check, not a hope: a stale token must not read as
    // signed in, or the page offers a sync that will 401.
    const now = { t: 1000 };
    const d = new GDrive({ clientId: 'x', gis: {}, now: () => now.t });
    ok(!d.signedIn, 'no token means signed out');
    d.token = 'tok'; d.tokenExp = 2000;
    ok(d.signedIn, 'a live token means signed in');
    now.t = 3000;
    ok(!d.signedIn, 'and an expired one does not');
  }

  {
    const d = new GDrive({});
    ok(!d.configured, 'an unconfigured instance says so');
    ok(new GDrive({ clientId: 'x' }).configured, 'and a configured one says so too');
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
