'use strict';

// SPDX-License-Identifier: GPL-3.0-or-later
//
// public/gdrive.js — optional preference sync through the user's OWN Google Drive.
//
// THIS SERVER STORES NOTHING. There is no account record, no user table, no
// session cookie and no database; the only server-side trace of this feature is
// `googleClientId` in config/site.json, which is a public value substituted into
// a served page. The browser talks to Google directly and writes one JSON file
// into `appDataFolder` — a hidden per-application folder inside the visitor's
// own Drive, which they cannot see in the Drive UI and no other application can
// read. Revoking the app in their Google account deletes it, and the operator is
// not in that loop and cannot be.
//
// The scope is `drive.appdata` and NOTHING else. No `email`, no `profile`, no
// `openid`: the page never learns who the visitor is, because it has no reason
// to and every scope asked for is one more thing to account for. That scope is
// also classified NON-SENSITIVE by Google, which is what keeps the operator out
// of app verification entirely. → GOOGLE-SYNC-SETUP.txt.
//
// THE GOOGLE SCRIPT IS LOADED ON DEMAND, not at page load. A visitor who never
// presses the control is never contacted by Google on this site's behalf. There
// is no One Tap and no auto-select — nothing happens without a deliberate press
// — which is also what keeps the one thing stored locally (a flag saying the
// user chose this) a strictly-necessary preference rather than tracking.
//
// Served as a classic script like rxjitter.js and xfer.js, and required off the
// same file by tools/tests/gdrivetest.js.

(function (root) {

const GIS_SRC = 'https://accounts.google.com/gsi/client';
const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const FILES = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FILENAME = 'synthlink-prefs.json';

/**
 * A thin promise over the Google Identity Services token client.
 *
 * The TOKEN model, not the code model. The code model is the one Google
 * recommends in general and it requires a backend to exchange the code with a
 * client secret — which would mean this server holding credentials and running
 * an OAuth endpoint, i.e. exactly the thing this design exists to avoid. The
 * token model is the supported flow for a page with no backend: no secret, no
 * redirect URI, an access token that lives about an hour and is held in memory
 * and never written anywhere.
 */
class GDrive {
  constructor(opts) {
    opts = opts || {};
    this.clientId = opts.clientId || '';
    this.token = null;
    this.tokenExp = 0;
    this._client = null;
    // Seams for the harness. Nothing below reaches for a global directly, so
    // the whole of this file is drivable in Node with no browser and no
    // network — which is the only way to test the merge rules at all.
    this._loadScript = opts.loadScript || defaultLoadScript;
    this._fetch = opts.fetch || ((...a) => root.fetch(...a));
    this._now = opts.now || (() => Date.now());
    this._gis = opts.gis || null;          // injected google.accounts.oauth2
  }

  get configured() { return !!this.clientId; }
  get signedIn() { return !!this.token && this._now() < this.tokenExp; }

  async _tokenClient() {
    if (this._client) return this._client;
    const gis = this._gis || (await this._loadScript(GIS_SRC),
                              root.google && root.google.accounts && root.google.accounts.oauth2);
    if (!gis) throw new Error('Google sign-in is unavailable');
    this._client = gis;
    return gis;
  }

  /**
   * Ask for an access token.
   *
   * `interactive` false is the silent path taken on page load for somebody who
   * has already opted in: Google returns a token with no UI when the grant is
   * still current, and an error when it is not — at which point the control
   * goes back to saying "sign in" rather than putting a dialog in front of
   * somebody who did not ask for one.
   */
  authorize(interactive) {
    return this._tokenClient().then((gis) => new Promise((resolve, reject) => {
      const client = gis.initTokenClient({
        client_id: this.clientId,
        scope: SCOPE,
        prompt: interactive ? '' : 'none',
        callback: (resp) => {
          if (!resp || !resp.access_token) return reject(new Error(resp && resp.error || 'no token'));
          this.token = resp.access_token;
          // A minute of slack so a request started just under the wire does not
          // land just over it.
          this.tokenExp = this._now() + ((Number(resp.expires_in) || 3600) - 60) * 1000;
          resolve(this.token);
        },
        error_callback: (err) => reject(new Error((err && err.type) || 'sign-in failed')),
      });
      client.requestAccessToken();
    }));
  }

  signOut() {
    this.token = null; this.tokenExp = 0;
  }

  _headers(extra) {
    return Object.assign({ Authorization: `Bearer ${this.token}` }, extra || {});
  }

  /** The prefs file's id, or null. Created lazily by save(). */
  async _findId() {
    if (this._id) return this._id;
    const url = `${FILES}?spaces=appDataFolder&fields=files(id,name)`
              + `&q=${encodeURIComponent(`name='${FILENAME}'`)}`;
    const r = await this._fetch(url, { headers: this._headers() });
    if (!r.ok) throw new Error(`Drive list failed (${r.status})`);
    const j = await r.json();
    this._id = (j.files && j.files[0] && j.files[0].id) || null;
    return this._id;
  }

  /** @returns {Promise<object|null>} the stored blob, or null if there is none. */
  async load() {
    const id = await this._findId();
    if (!id) return null;
    const r = await this._fetch(`${FILES}/${id}?alt=media`, { headers: this._headers() });
    if (r.status === 404) { this._id = null; return null; }
    if (!r.ok) throw new Error(`Drive read failed (${r.status})`);
    // The etag is what makes a concurrent write from another device detectable
    // rather than silently overwritten.
    this._etag = r.headers && r.headers.get ? r.headers.get('etag') : null;
    return r.json();
  }

  async save(blob) {
    const body = JSON.stringify(blob);
    const id = await this._findId();
    if (id) {
      const r = await this._fetch(`${UPLOAD}/${id}?uploadType=media`, {
        method: 'PATCH',
        headers: this._headers(Object.assign(
          { 'Content-Type': 'application/json' },
          this._etag ? { 'If-Match': this._etag } : {})),
        body,
      });
      // 412: another device wrote since we read. Not an error to report — the
      // caller re-reads, re-merges and writes again, which is the whole of the
      // conflict handling and is why the merge has to be a pure function.
      if (r.status === 412) return { conflict: true };
      if (!r.ok) throw new Error(`Drive write failed (${r.status})`);
      this._etag = r.headers && r.headers.get ? r.headers.get('etag') : null;
      return { ok: true };
    }
    const meta = { name: FILENAME, parents: ['appDataFolder'] };
    const boundary = 'sl' + Math.random().toString(36).slice(2);
    const multipart =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify(meta)}\r\n--${boundary}\r\n` +
      `Content-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
    const r = await this._fetch(`${UPLOAD}?uploadType=multipart&fields=id`, {
      method: 'POST',
      headers: this._headers({ 'Content-Type': `multipart/related; boundary=${boundary}` }),
      body: multipart,
    });
    if (!r.ok) throw new Error(`Drive create failed (${r.status})`);
    const j = await r.json();
    this._id = j.id;
    this._etag = null;
    return { ok: true, created: true };
  }
}

function defaultLoadScript(src) {
  return new Promise((resolve, reject) => {
    const have = root.document.querySelector(`script[src="${src}"]`);
    if (have) { if (have.dataset.loaded) resolve(); else have.addEventListener('load', () => resolve()); return; }
    const el = root.document.createElement('script');
    el.src = src; el.async = true; el.defer = true;
    el.addEventListener('load', () => { el.dataset.loaded = '1'; resolve(); });
    el.addEventListener('error', () => reject(new Error('could not reach Google')));
    root.document.head.appendChild(el);
  });
}

// ─── The merge ──────────────────────────────────────────────────────────────
//
// A pure function of three arguments, which is what lets it be tested properly
// and re-run after a conflict without touching anything.
//
// `base` is the set of favourite keys as of the last successful sync, and it is
// what turns an ambiguous two-way comparison into an unambiguous three-way one:
//
//   in local, not in base   → added here since the last sync    → keep
//   in base, not in local   → deleted here since the last sync  → remove
//   in remote, not in base  → another device added it           → keep
//
// Without a base, "absent from local" cannot be told apart from "never seen
// here", and the only safe reading is the additive one — which is exactly what
// happens when `base` is missing, so the SAFE behaviour is the failure mode
// rather than the design. A cleared localStorage, a private window or a first
// run all land there and nothing is ever lost; the cost is that a favourite
// deleted on one device can come back, which is the behaviour a user can undo
// and the opposite one is not.
//
// Scalar preferences are last-writer-wins on a timestamp, because two devices
// disagreeing about the speaker toggle has one obvious answer and it is not
// worth a vector clock.
function mergePrefs(local, remote, baseKeys) {
  local = local || {}; remote = remote || {};
  const out = {};
  const lTime = Number(local.syncedAt) || 0;
  const rTime = Number(remote.syncedAt) || 0;
  const newer = rTime > lTime ? remote : local;
  const older = rTime > lTime ? local : remote;
  for (const k of Object.keys(older)) if (k !== 'favorites') out[k] = older[k];
  for (const k of Object.keys(newer)) if (k !== 'favorites') out[k] = newer[k];

  const lf = Array.isArray(local.favorites) ? local.favorites : [];
  const rf = Array.isArray(remote.favorites) ? remote.favorites : [];
  const key = (f) => `${String(f.host || '').trim().toLowerCase()}:${f.port || 23}`;
  const base = baseKeys && baseKeys.length ? new Set(baseKeys) : null;

  const merged = new Map();
  for (const f of rf) merged.set(key(f), f);
  for (const f of lf) {
    const k = key(f);
    // An entry present locally is kept whatever else is true: a favourite is
    // never lost by syncing. Earliest `added` wins so "newly added" keeps
    // meaning what it means.
    const have = merged.get(k);
    if (!have) merged.set(k, f);
    else if (f.added && (!have.added || f.added < have.added)) merged.set(k, Object.assign({}, have, { added: f.added }));
  }
  if (base) {
    const here = new Set(lf.map(key));
    for (const k of base) if (!here.has(k)) merged.delete(k);
  }
  out.favorites = Array.from(merged.values());
  return out;
}

const API = { GDrive, mergePrefs, SCOPE, FILENAME, GIS_SRC };
if (typeof window !== 'undefined') window.GDrive = API;
if (typeof module !== 'undefined' && module.exports) module.exports = API;

})(typeof globalThis !== 'undefined' ? globalThis : this);
