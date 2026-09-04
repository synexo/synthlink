#!/usr/bin/env node
// The embed snippet as MARKUP, in a REAL browser: a stub third-party page that
// contains nothing but what the share panel's embed view hands out, loaded to
// see whether a terminal actually boots inside the frame.
//
// This is the one failure mode tools/tests/embedtest.js cannot reach. That
// harness asserts the snippet as a STRING — the right attributes, the escaping,
// the connect spelling — and a snippet can satisfy every one of those and still
// render nothing: a mis-escaped attribute, a script URL that 404s, an element
// that never upgrades, a frame the browser refuses. Correct as text, wrong as
// markup. So the snippet under test here is not written out again; it is READ
// OUT OF THE WIZARD and pasted into the host page exactly as an embedder would.
//
// It does NOT start server.js, so it does not trip the WS-listener sandbox hang
// (CLAUDE.md): the pages are served from memory by Playwright's request router,
// and WebSocket is replaced with a recorder so "did it dial?" is observable with
// nothing listening.
//
// Playwright is deliberately not a repo dependency — install it just for a run:
//
//     npm install --no-save playwright-core
//     node tools/tests/embedhosttest.js
//
// If the browser binary is somewhere Playwright will not find on its own, point
// at it: PW_CHROMIUM=/path/to/chrome node tools/tests/embedhosttest.js

const BROWSER_PKG = (() => {
  for (const p of ['playwright', 'playwright-core']) {
    try { require.resolve(p); return p; } catch (_) {}
  }
  console.error('embedhosttest: needs Playwright. Run:  npm install --no-save playwright-core');
  process.exit(2);
})();

const LAUNCH = process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {};
const { chromium } = require(BROWSER_PKG);
const fs = require('fs');
const dir = require('path').join(__dirname, '..', '..', 'public');

const DIRECTORY = {
  curated: [
    { name: 'Level 29', host: 'bbs.fozztexx.com', port: 23 },
    { name: 'Birdenuf', host: 'bbs.birdenuf.com', port: 2003 },
  ],
  guide: [],
};

let pass = 0, fail = 0;
function eq(a, e, what) {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { pass++; return; }
  fail++;
  console.log(`  FAIL ${what}\n       expected ${E}\n       actual   ${A}`);
}
const ok = (cond, what) => eq(!!cond, true, what);

// The host page. Deliberately bare: a heading, a column of a stated width, and
// the snippet. Anything more would be testing the fixture's own CSS.
const hostPage = (snippet) => `<!doctype html><html><head><meta charset="utf-8">
<title>Somebody else's site</title></head><body style="margin:0;font:16px sans-serif">
<h1>A page that is not SynthLink</h1>
<div id="col" style="width:800px">${snippet}</div>
</body></html>`;

(async () => {
  const b = await chromium.launch(LAUNCH);
  let HOST_HTML = '';

  // THE HOST PAGE IS ON A DIFFERENT ORIGIN, and that is the point rather than a
  // detail. A real embed always is, and same-origin testing hides an entire
  // class of failure: the first cut of embed.js shipped as `type="module"`,
  // which is always fetched in CORS mode, so every real embedder got
  // "Access-Control-Allow-Origin missing" against a 200 response while every
  // harness here stayed green. `embedder.test` and `bbsdial.test` are two
  // origins to a browser, so the script fetch, the frame and the storage
  // partition all behave as they do in the field.
  const APP_ORIGIN = 'http://bbsdial.test';
  const HOST_ORIGIN = 'http://embedder.test';

  async function ctxWith(snippet) {
    HOST_HTML = hostPage(snippet);
    const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.route('**/*', async (route) => {
      const u = new URL(route.request().url());
      if (u.pathname === '/host.html') {
        return route.fulfill({ contentType: 'text/html', body: HOST_HTML });
      }
      if (u.pathname === '/bbs.json') {
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(DIRECTORY) });
      }
      if (u.pathname.endsWith('dsp-bundle.js')) {
        return route.fulfill({ contentType: 'application/javascript',
          body: 'window.SynthModemDSP={ModemDSP:function(){this.on=()=>{};this.start=()=>{};this.stop=()=>{};},config:{modem:{native:{}}}};' });
      }
      const p = dir + (u.pathname === '/' ? '/index.html' : u.pathname);
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        const ext = p.split('.').pop();
        const type = { html: 'text/html', js: 'text/javascript', json: 'application/json',
                       svg: 'image/svg+xml', woff2: 'font/woff2' }[ext] || 'text/plain';
        const body = ext === 'html' ? require('../../lib/site').apply(fs.readFileSync(p, 'utf8'))
                                    : fs.readFileSync(p);
        return route.fulfill({ contentType: type, body });
      }
      return route.fulfill({ status: 404, body: '' });
    });
    // Applies to every frame in the context, which is the point: the recorder
    // has to be inside the embed, not beside it.
    await ctx.addInitScript(() => {
      window.__dials = [];
      const RealWS = window.WebSocket;
      window.WebSocket = function (url) {
        window.__dials.push(url);
        return { readyState: 0, url, send() {}, close() {} };
      };
      window.WebSocket.OPEN = RealWS.OPEN;
    });
    return ctx;
  }

  console.log('embedhosttest — the snippet as markup, in a browser\n');

  // ── Get the snippets from the wizard, not from this file ──────────────────
  let snippet = '', iframeSnippet = '', autoSnippet = '';
  {
    const ctx = await ctxWith('');
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e)));
    await page.goto(`${APP_ORIGIN}/index.html?host=bbs.fozztexx.com&port=23&speed=v32bis`);
    await page.waitForTimeout(700);
    await page.evaluate(() => {
      const w = document.getElementById('welcomeclose');
      if (w) w.click();
    });
    await page.click('#sharebtn');
    await page.click('#shareembedbtn');
    await page.waitForTimeout(150);
    snippet = await page.inputValue('#embedsnippet');
    iframeSnippet = await page.inputValue('#embediframe');
    await page.selectOption('#embedconnect', 'auto');
    await page.waitForTimeout(100);
    autoSnippet = await page.inputValue('#embedsnippet');
    eq(errs, [], 'the wizard itself raises no page errors');
    ok(snippet.includes('<synthlink-terminal'), 'the wizard produced an element snippet');
    ok(iframeSnippet.includes('<iframe'), 'and an iframe fallback');
    ok(!snippet.includes('type="module"'),
       'and the script tag is classic — a module cannot be fetched cross-origin without a CORS header');
    await ctx.close();
  }

  // What the embedder pastes carries entities, and a browser is the only honest
  // reader of them. If `&amp;` were wrong, the frame would load with the host
  // alone and the speed would be the default — which the destination checks
  // below would not catch, so the speed is checked explicitly.
  async function mount(snip) {
    const ctx = await ctxWith(snip);
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e)));
    await page.goto(`${HOST_ORIGIN}/host.html`);
    await page.waitForTimeout(1600);
    const frame = page.frames().find((f) => f.url().includes('host='));
    const inner = frame ? await frame.evaluate(() => ({
      canvasW: document.getElementById('terminal-canvas').getBoundingClientRect().width | 0,
      canvasH: document.getElementById('terminal-canvas').getBoundingClientRect().height | 0,
      host: document.getElementById('host').value,
      port: document.getElementById('port').value,
      speed: document.getElementById('protocol').value,
      prompt: !document.getElementById('dialmodal').hasAttribute('hidden'),
      dials: window.__dials.length,
      scrolls: document.documentElement.scrollHeight > document.documentElement.clientHeight,
    })) : null;
    const box = await page.evaluate(() => {
      const f = document.querySelector('iframe');
      if (!f) return null;
      const r = f.getBoundingClientRect(), col = document.getElementById('col').getBoundingClientRect();
      return { w: r.width | 0, h: r.height | 0, allow: f.getAttribute('allow'),
               colW: col.width | 0, leftGap: (r.left - col.left) | 0,
               rightGap: (col.right - r.right) | 0 };
    });
    await ctx.close();
    return { inner, box, errs, framed: !!frame };
  }

  // ── 1. The element snippet ────────────────────────────────────────────────
  {
    const { inner, box, errs, framed } = await mount(snippet);
    eq(errs, [], 'host page: no page errors');
    // The whole reason this harness serves two origins: as a module, the script
    // never even executed here and nothing but the console said so.
    ok(framed, 'the element upgraded and built a frame that loaded the app, CROSS-ORIGIN');
    ok(box && box.allow === 'autoplay; fullscreen', 'the frame carries allow — without it the speaker stays gated');
    ok(inner && inner.canvasW > 200 && inner.canvasH > 100, 'a terminal is drawn inside it');
    eq(inner && inner.host, 'bbs.fozztexx.com', 'at the destination the wizard was pointed at');
    eq(inner && inner.port, '23', 'on the right port');
    // The proof the entity-escaped separators survived a real HTML parser: a
    // swallowed `&` would leave the speed at the default.
    eq(inner && inner.speed, 'V32bis', 'and at the chosen speed, so the escaped & parsed as a separator');
    eq(inner && inner.prompt, true, 'the default mode raises a Connect prompt');
    eq(inner && inner.dials, 0, 'and dials nothing until somebody presses it');
  }

  // ── 2. The box ────────────────────────────────────────────────────────────
  {
    const { box, inner } = await mount(snippet);
    // 90% of an 800px column, centred in it.
    eq(box && box.w, 720, 'the frame is 90% of the column it was put in, not of the window');
    eq(box && box.leftGap, box && box.rightGap, 'and is centred there');
    ok(box && box.h > 600, 'the frame is taller than the short-viewport threshold');
    // 90vh of a 900px viewport is 810. A percentage height would have collapsed
    // the frame to 150px here, because #col has no height of its own.
    eq(box && box.h, 810, 'the height resolved — a percentage would not have, in a parent with no height');
    eq(inner && inner.scrolls, false, 'so the page inside is not scrolling before anything is opened');
  }

  // ── 3. The keyboard resizes the terminal rather than scrolling the frame ──
  // The report this default was chosen against. At or under 600px the app's own
  // short-viewport rule takes the page scrolling instead, in a frame exactly as
  // in a window — so the check is that the default box stays clear of it.
  {
    const ctx = await ctxWith(snippet);
    const page = await ctx.newPage();
    await page.goto(`${HOST_ORIGIN}/host.html`);
    await page.waitForTimeout(1600);
    const frame = page.frames().find((f) => f.url().includes('host='));
    const before = await frame.evaluate(() =>
      document.getElementById('terminal-canvas').getBoundingClientRect().height | 0);
    await frame.evaluate(() => document.getElementById('kbdtoggle').click());
    await page.waitForTimeout(600);
    const after = await frame.evaluate(() => ({
      h: document.getElementById('terminal-canvas').getBoundingClientRect().height | 0,
      scrolls: document.documentElement.scrollHeight > document.documentElement.clientHeight,
    }));
    ok(after.h < before, 'opening the keyboard SHRINKS the terminal');
    eq(after.scrolls, false, 'rather than giving the frame its own scrollbar');
    await ctx.close();
  }

  // ── 4. The iframe fallback ────────────────────────────────────────────────
  {
    const { inner, box, errs, framed } = await mount(iframeSnippet);
    eq(errs, [], 'fallback: no page errors');
    ok(framed, 'the hand-written frame loads the app with no script at all');
    ok(box && box.allow === 'autoplay; fullscreen', 'fallback: allow survives');
    eq(box && box.w, 720, 'fallback: same box, stated in style because the attributes are pixels');
    eq(box && box.h, 810, 'fallback: and the same height');
    eq(box && box.leftGap, box && box.rightGap, 'fallback: centred too');
    eq(inner && inner.speed, 'V32bis', 'fallback: the escaped separators parsed');
    eq(inner && inner.dials, 0, 'fallback: dials nothing');
  }

  // ── 5. connect=auto really does dial, unprompted ──────────────────────────
  // The one mode that acts on its own. If the wizard's mode name reached the
  // frame instead of the query value, this would silently do nothing.
  {
    const { inner } = await mount(autoSnippet);
    eq(inner && inner.prompt, false, 'auto: no prompt');
    eq(inner && inner.dials, 1, 'auto: it dialled on load');
  }

  await b.close();
  console.log(`\n${fail ? 'FAILED' : 'OK'} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
