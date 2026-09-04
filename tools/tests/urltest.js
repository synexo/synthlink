#!/usr/bin/env node
// End-to-end check of shareable-link startup, in a REAL browser.
//
// Unlike the other harnesses this one needs a browser, because the behaviour
// under test is startup ordering across a live DOM: location.search is read
// before the async /bbs.json fetch resolves, and renderBBS() then runs against
// whatever the URL put in #host/#port. That interaction is the whole feature and
// it cannot be reproduced with stubs.
//
// It does NOT start server.js, so it does not trip the WS-listener sandbox hang
// (CLAUDE.md): the page is served from memory by Playwright's request router and
// WebSocket is replaced with a recorder, so "did it dial?" is observable without
// anything listening.
//
// Playwright is deliberately not a repo dependency — install it just for a run:
//
//     npm install --no-save playwright-core
//     node tools/tests/urltest.js
//
// If the browser binary is somewhere Playwright will not find on its own, point
// at it: PW_CHROMIUM=/path/to/chrome node tools/tests/urltest.js
//
// Covers: host-alone defaulting, full links, the off-directory destination that
// renderBBS() used to overwrite, URL-beats-stored precedence, stored prefs left
// untouched, malformed links falling back cleanly, the directory being down, and
// the share panel reproducing the state a link created.

const BROWSER_PKG = (() => {
  for (const p of ['playwright', 'playwright-core']) {
    try { require.resolve(p); return p; } catch (_) {}
  }
  console.error('urltest: needs Playwright. Run:  npm install --no-save playwright-core');
  process.exit(2);
})();

// Playwright finds its own browser unless told otherwise.
const LAUNCH = process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {};
const { chromium } = require(BROWSER_PKG);
const fs = require('fs');
const dir = require('path').join(__dirname, '..', '..', 'public');

const DIRECTORY = {
  curated: [
    { name: 'Level 29', host: 'bbs.fozztexx.com', port: 23 },
    { name: 'Particles BBS', host: 'particlesbbs.dyndns.org', port: 6400 },
    { name: 'Birdenuf', host: 'bbs.birdenuf.com', port: 2003 },
  ],
  guide: [{ name: 'Absinthe', host: 'absinthe.example.org', port: 23 }],
};

let pass = 0, fail = 0;
function eq(a, e, what) {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { pass++; return; }
  fail++;
  console.log(`  FAIL ${what}\n       expected ${E}\n       actual   ${A}`);
}

(async () => {
  const b = await chromium.launch(LAUNCH);

  async function boot(query, { prefs, dirFails } = {}) {
    const ctx = await b.newContext({ viewport: { width: 1100, height: 700 } });
    const page = await ctx.newPage();
    await page.route('**/*', async (route) => {
      const u = new URL(route.request().url());
      if (u.pathname === '/bbs.json') {
        return dirFails ? route.fulfill({ status: 500, body: 'nope' })
                        : route.fulfill({ contentType: 'application/json', body: JSON.stringify(DIRECTORY) });
      }
      if (u.pathname.endsWith('dsp-bundle.js')) {
        return route.fulfill({ contentType: 'application/javascript',
          body: 'window.SynthModemDSP={ModemDSP:function(){this.on=()=>{};this.start=()=>{};this.stop=()=>{};},config:{modem:{native:{}}}};' });
      }
      const p = dir + (u.pathname === '/' ? '/index.html' : u.pathname);
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        const ext = p.split('.').pop();
        const type = { html: 'text/html', js: 'text/javascript', json: 'application/json',
                       svg: 'image/svg+xml' }[ext] || 'text/plain';
        // .html is templated on the way out, exactly as server.js does it.
        const body = ext === 'html' ? require('../../lib/site').apply(fs.readFileSync(p, 'utf8'))
                                    : fs.readFileSync(p);
        return route.fulfill({ contentType: type, body });
      }
      return route.fulfill({ status: 404, body: '' });
    });
    // Record WebSocket construction instead of opening one, so dialling is
    // observable without a server.
    await page.addInitScript(([prefsJSON]) => {
      window.__dials = [];
      const RealWS = window.WebSocket;
      window.WebSocket = function (url) {
        window.__dials.push(url);
        const o = { readyState: 0, url, send() {}, close() {} };
        return o;
      };
      window.WebSocket.OPEN = RealWS.OPEN;
      if (prefsJSON) localStorage.setItem('synthlink.prefs.v1', prefsJSON);
    }, [prefs ? JSON.stringify(prefs) : '']);

    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e)));
    await page.goto(`http://localhost/index.html${query}`);
    await page.waitForTimeout(700);
    const state = await page.evaluate(() => ({
      host: document.getElementById('host').value,
      port: document.getElementById('port').value,
      speed: document.getElementById('protocol').value,
      bbsHidden: document.getElementById('bbs').hidden,
      hostportHidden: document.getElementById('hostport').hidden,
      hostport: document.getElementById('hostport').value,
      dials: window.__dials.length,
      prompt: !document.getElementById('dialmodal').hasAttribute('hidden'),
      promptWhere: document.getElementById('dialwhere').textContent,
      storedDest: JSON.parse(localStorage.getItem('synthlink.prefs.v1') || '{}').dest || null,
      storedProto: JSON.parse(localStorage.getItem('synthlink.prefs.v1') || '{}').protocol || null,
      // The speaker as the CONTROL reports it — the class its own handler sets,
      // not a label — and the stored preference beside it, because the
      // connect=auto mute must never be written down.
      speakerOn: document.getElementById('listen').classList.contains('on'),
      storedSpeaker: JSON.parse(localStorage.getItem('synthlink.prefs.v1') || '{}').speaker || null,
    }));
    await ctx.close();
    return { state, errs };
  }

  console.log('urltest — shared-link startup (real browser)\n');

  // 1. No query: the built-in default destination and the new default speed.
  {
    const { state, errs } = await boot('');
    eq(errs, [], 'plain load: no page errors');
    eq(state.speed, 'V34', 'plain load: default speed is V.34 33600');
    eq(state.dials, 0, 'plain load: does not dial');
    eq(state.prompt, false, 'plain load: no Connect prompt');
  }

  // 2. Host alone — port defaults to 23, speed to the default, no connect= parameter.
  {
    const { state, errs } = await boot('?host=bbs.fozztexx.com');
    eq(errs, [], 'host alone: no page errors');
    eq([state.host, state.port], ['bbs.fozztexx.com', '23'], 'host alone: port defaults to 23');
    eq(state.speed, 'V34', 'host alone: default speed');
    eq(state.bbsHidden, false, 'host alone: stays in directory mode');
    eq(state.dials, 0, 'host alone: no connect= parameter, no prompt');
    eq(state.prompt, false, 'host alone: no Connect prompt');
  }

  // 3. Full link, in-directory board.
  {
    const { state, errs } = await boot('?host=particlesbbs.dyndns.org&port=6400&speed=v32bis&connect=1');
    eq(errs, [], 'full link: no page errors');
    eq([state.host, state.port, state.speed], ['particlesbbs.dyndns.org', '6400', 'V32bis'], 'full link: destination + speed');
    eq(state.dials, 0, 'full link: connect= prompts, it does not dial by itself');
    eq(state.prompt, true, 'full link: Connect prompt shown');
  }

  // 4. THE BUG CASE. A board that is not in the directory. Before the guard,
  //    renderBBS()'s "adopt what's displayed" branch overwrote #host/#port from
  //    the first option — the link would have silently dialled another board.
  {
    const { state, errs } = await boot('?host=offlist.example.org&port=2323&speed=v90&connect=1');
    eq(errs, [], 'off-directory: no page errors');
    eq([state.host, state.port], ['offlist.example.org', '2323'], 'off-directory: destination survives renderBBS');
    eq(state.speed, 'V90', 'off-directory: speed applied');
    eq(state.hostportHidden, false, 'off-directory: manual field is the visible control');
    eq(state.bbsHidden, true, 'off-directory: dropdown hidden');
    eq(state.hostport, 'offlist.example.org:2323', 'off-directory: field shows the destination');
    eq(state.dials, 0, 'off-directory: prompts rather than dialling');
    eq(state.prompt, true, 'off-directory: Connect prompt shown');
    eq(state.promptWhere, 'offlist.example.org:2323',
       'off-directory: prompt names the bare destination');
  }

  // 4b. connect=auto — the no-gesture case. Dials on load with no prompt, and
  //     the speaker is held quiet for that call because there is no gesture to
  //     start audio with: the dial and handshake could not be played on time,
  //     so they are not played at all (see the note in main.js).
  {
    const { state, errs } = await boot('?host=particlesbbs.dyndns.org&port=6400&speed=v32bis&connect=auto');
    eq(errs, [], 'connect=auto: no page errors');
    eq(state.dials, 1, 'connect=auto: dials on load');
    eq(state.prompt, false, 'connect=auto: and does not raise the prompt');
    eq(state.speakerOn, false, 'connect=auto: the speaker is muted for the call');
    eq(state.storedSpeaker, null, 'connect=auto: and the stored preference is not touched');
  }

  // 4b-ii. The parameter is `connect=auto` and nothing else. `connectAuto` is
  //     not a parameter — it is only what the parser calls the result — and a
  //     link written that way must fall through to an ordinary no-connect load
  //     rather than half-working.
  {
    const { state } = await boot('?host=bbs.birdenuf.com&port=2003&speed=v90&connect=auto');
    eq([state.host, state.port, state.speed], ['bbs.birdenuf.com', '2003', 'V90'],
       'connect=auto: the whole link applies');
    eq(state.dials, 1, 'connect=auto: dials with a port and a speed alongside it');
  }
  for (const q of ['connectAuto', 'connectAuto=1', 'connect=automatic']) {
    const { state } = await boot(`?host=bbs.birdenuf.com&port=2003&speed=v90&${q}`);
    eq(state.dials, 0, `?${q} does not dial — it is not the parameter`);
    eq(state.prompt, false, `?${q} does not prompt either`);
  }

  // 4c. The mute is per-call, not a preference. A visitor who had the speaker
  //     on gets it back on the next dial; one who had already muted it sees no
  //     change at all. The stored value must be intact either way — this is the
  //     failure that would be invisible until the NEXT visit.
  {
    const stored = { speaker: 'listen', favorites: [] };
    const { state } = await boot('?host=bbs.fozztexx.com&connect=auto', { prefs: stored });
    eq(state.speakerOn, false, 'connect=auto over speaker-on: muted for the call');
    eq(state.storedSpeaker, 'listen', 'connect=auto over speaker-on: preference kept for next time');
  }
  {
    const stored = { speaker: 'mute', favorites: [] };
    const { state } = await boot('?host=bbs.fozztexx.com&connect=auto', { prefs: stored });
    eq(state.speakerOn, false, 'connect=auto over speaker-muted: still muted');
    eq(state.storedSpeaker, 'mute', 'connect=auto over speaker-muted: preference kept');
  }

  // 5. Transient override: a shared link must not rewrite stored prefs.
  {
    const stored = { dest: { host: 'mine.example.org', port: '23' }, protocol: 'V22bis', favorites: [] };
    const { state } = await boot('?host=bbs.fozztexx.com&speed=v90&connect=1', { prefs: stored });
    eq(state.host, 'bbs.fozztexx.com', 'override: URL beats stored destination');
    eq(state.speed, 'V90', 'override: URL beats stored speed');
    eq(state.storedDest, { host: 'mine.example.org', port: '23' }, 'override: stored destination untouched');
    eq(state.storedProto, 'V22bis', 'override: stored speed untouched');
  }

  // 6. Stored prefs still win when the URL says nothing.
  {
    const stored = { dest: { host: 'bbs.fozztexx.com', port: '23' }, protocol: 'V32', favorites: [] };
    const { state } = await boot('', { prefs: stored });
    eq([state.host, state.speed], ['bbs.fozztexx.com', 'V32'], 'no query: stored prefs still apply');
  }

  // 7. A malformed link falls back to normal startup rather than half-applying.
  {
    const { state, errs } = await boot('?host=http://evil.example/x&speed=v999&connect=1');
    eq(errs, [], 'bad link: no page errors');
    eq(state.host, 'bbs.birdenuf.com', 'bad link: rejected host ignored, default kept');
    eq(state.speed, 'V34', 'bad link: unknown speed ignored');
    eq(state.dials, 0, 'bad link: no prompt off a rejected host');
    eq(state.prompt, false, 'bad link: no Connect prompt');
  }

  // 8. Directory unavailable: a shared link is still dialable.
  {
    const { state, errs } = await boot('?host=offlist.example.org&port=2323&connect=1', { dirFails: true });
    eq(errs, [], 'no directory: no page errors');
    eq([state.host, state.port], ['offlist.example.org', '2323'], 'no directory: destination applied');
    eq(state.hostportHidden, false, 'no directory: manual field shown');
    eq(state.dials, 0, 'no directory: prompts rather than dialling');
    eq(state.prompt, true, 'no directory: Connect prompt still shown');
  }

  // 8b. The prompt is the gesture: pressing Connect dials, closing it does not.
  //     This is the whole reason `connect=1` prompts rather than dialling — the
  //     press is what lets the browser start audio, so the handshake is heard as
  //     it happens instead of replaying over an already-connected session.
  for (const [action, label, expectDials] of [
    ['#dialgo', 'pressing Connect', 1],
    ['#dialclose', 'closing the prompt', 0],
  ]) {
    const ctx = await b.newContext({ viewport: { width: 1100, height: 700 } });
    const page = await ctx.newPage();
    await page.route('**/*', async (route) => {
      const u = new URL(route.request().url());
      if (u.pathname === '/bbs.json') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(DIRECTORY) });
      if (u.pathname.endsWith('dsp-bundle.js')) return route.fulfill({ contentType: 'application/javascript',
        body: 'window.SynthModemDSP={ModemDSP:function(){this.on=()=>{};this.start=()=>{};this.stop=()=>{};},config:{modem:{native:{}}}};' });
      const p = dir + (u.pathname === '/' ? '/index.html' : u.pathname);
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        const ext = p.split('.').pop();
        // .html is templated on the way out, exactly as server.js does it.
        const body = ext === 'html' ? require('../../lib/site').apply(fs.readFileSync(p, 'utf8'))
                                    : fs.readFileSync(p);
        return route.fulfill({ contentType: { html: 'text/html', js: 'text/javascript' }[ext] || 'text/plain', body });
      }
      return route.fulfill({ status: 404, body: '' });
    });
    await page.addInitScript(() => {
      window.__dials = [];
      const RealWS = window.WebSocket;
      window.WebSocket = function (url) { window.__dials.push(url); return { readyState: 0, url, send() {}, close() {} }; };
      window.WebSocket.OPEN = RealWS.OPEN;
    });
    await page.goto('http://localhost/index.html?host=bbs.fozztexx.com&speed=v32bis&connect=1');
    await page.waitForTimeout(600);
    eq(await page.isVisible('#dialgo'), true, `${label}: prompt is up first`);
    await page.click(action);
    await page.waitForTimeout(300);
    eq(await page.evaluate(() => window.__dials.length), expectDials, `${label}: dials ${expectDials}`);
    eq(await page.isHidden('#dialmodal'), true, `${label}: prompt disappears`);
    // Either way the controls keep the shared destination.
    eq(await page.inputValue('#host'), 'bbs.fozztexx.com', `${label}: destination retained`);
    await ctx.close();
  }

  // 9. The share link built from a URL-driven state reproduces that state.
  {
    const ctx = await b.newContext({ viewport: { width: 1100, height: 700 } });
    const page = await ctx.newPage();
    await page.route('**/*', async (route) => {
      const u = new URL(route.request().url());
      if (u.pathname === '/bbs.json') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(DIRECTORY) });
      if (u.pathname.endsWith('dsp-bundle.js')) return route.fulfill({ contentType: 'application/javascript', body: 'window.SynthModemDSP={ModemDSP:function(){},config:{modem:{native:{}}}};' });
      const p = dir + (u.pathname === '/' ? '/index.html' : u.pathname);
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        const ext = p.split('.').pop();
        // .html is templated on the way out, exactly as server.js does it.
        const body = ext === 'html' ? require('../../lib/site').apply(fs.readFileSync(p, 'utf8'))
                                    : fs.readFileSync(p);
        return route.fulfill({ contentType: { html: 'text/html', js: 'text/javascript' }[ext] || 'text/plain', body });
      }
      return route.fulfill({ status: 404, body: '' });
    });
    // Opted out of the welcome panel: this case drives the share panel, and the
    // panel (which now shows on every visit until dismissed for good) would
    // otherwise sit over the button. The welcome panel has its own harness
    // (tools/tests/uitest.js).
    await page.addInitScript(() =>
      localStorage.setItem('synthlink.prefs.v1', JSON.stringify({ welcomeDismissed: true })));
    await page.goto('http://localhost/index.html?host=particlesbbs.dyndns.org&port=6400&speed=v34');
    await page.waitForTimeout(600);
    await page.click('#sharebtn');
    eq(await page.isChecked('#shareauto'), true, 'the Connect-prompt box is on by default');
    eq(await page.inputValue('#sharebbs'),
       'http://localhost/index.html?host=particlesbbs.dyndns.org&port=6400&speed=v34&connect=1',
       'share link reproduces the URL-driven state, with connect=1 by default');
    await page.uncheck('#shareauto');
    eq(await page.inputValue('#sharebbs'),
       'http://localhost/index.html?host=particlesbbs.dyndns.org&port=6400&speed=v34',
       'unticking drops connect=, live');
    await page.check('#shareauto');
    eq(await page.inputValue('#sharebbs').then((v) => v.includes('connect=1')), true,
       'reticking adds it again');
    eq(await page.inputValue('#sharehome'), 'http://localhost/index.html', 'home link carries no query');
    await ctx.close();
  }

  await b.close();
  console.log(`\n${fail ? 'FAILED' : 'OK'} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
