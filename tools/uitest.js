#!/usr/bin/env node
// UI-behaviour checks that need a REAL browser, in the same shape as
// tools/urltest.js: the page is served from memory by Playwright's request
// router and WebSocket is a recorder, so server.js is never started and the
// WS-listener sandbox hang (CLAUDE.md) is never tripped.
//
//     npm install --no-save playwright-core
//     node tools/uitest.js
//     PW_CHROMIUM=/path/to/chrome node tools/uitest.js   # if the binary needs pointing at
//
// Covers three things that are all live-DOM behaviour and cannot be stubbed:
//
//   • Scrollback and zoom are mutually exclusive, the zoom button says so, and
//     the user's magnification survives the round trip.
//   • The page-scroll grab bar appears exactly when the page can scroll.
//   • The first-visit welcome panel: shown once, never again, and suppressed by
//     a shared ?connect= link (which counts as welcomed).

const BROWSER_PKG = (() => {
  for (const p of ['playwright', 'playwright-core']) {
    try { require.resolve(p); return p; } catch (_) {}
  }
  console.error('uitest: needs Playwright. Run:  npm install --no-save playwright-core');
  process.exit(2);
})();

const LAUNCH = process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {};
const { chromium } = require(BROWSER_PKG);
const fs = require('fs');
const dir = require('path').join(__dirname, '..', 'public');

const DIRECTORY = {
  curated: [
    { name: 'Level 29', host: 'bbs.fozztexx.com', port: 23 },
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

const PREFS_KEY = 'synthlink.prefs.v1';

(async () => {
  const b = await chromium.launch(LAUNCH);

  // viewport is a parameter here (unlike urltest) because two of the three
  // features under test are layout-dependent: the mobile breakpoint is 640px
  // and the grab bar keys off whether the page actually scrolls.
  async function boot(query, { prefs, viewport } = {}) {
    const ctx = await b.newContext({ viewport: viewport || { width: 1100, height: 700 } });
    const page = await ctx.newPage();
    await page.route('**/*', async (route) => {
      const u = new URL(route.request().url());
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
        const type = { html: 'text/html', js: 'text/javascript', json: 'application/json' }[ext] || 'text/plain';
        return route.fulfill({ contentType: type, body: fs.readFileSync(p) });
      }
      return route.fulfill({ status: 404, body: '' });
    });
    await page.addInitScript(([key, prefsJSON]) => {
      window.__dials = [];
      const RealWS = window.WebSocket;
      window.WebSocket = function (url) {
        window.__dials.push(url);
        return { readyState: 0, url, send() {}, close() {} };
      };
      window.WebSocket.OPEN = RealWS.OPEN;
      if (prefsJSON) localStorage.setItem(key, prefsJSON);
    }, [PREFS_KEY, prefs ? JSON.stringify(prefs) : '']);

    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e)));
    await page.goto(`http://localhost/index.html${query}`);
    await page.waitForTimeout(500);
    return { page, ctx, errs };
  }

  // Reads the whole zoom/scrollback surface at once — button state is the point
  // of the feature, so it is asserted alongside the internal effect.
  const zoomState = (page) => page.evaluate(() => ({
    scrollOn: document.getElementById('scrolltoggle').classList.contains('on'),
    zoomDisabled: document.getElementById('zoomtoggle').disabled,
    zoomLit: document.getElementById('zoomtoggle').classList.contains('on'),
    zoomIconOff: document.getElementById('zoomtoggle').querySelector('.zoomicon').classList.contains('off'),
    zoomIconText: document.getElementById('zoomtoggle').querySelector('.zoomicon').textContent,
    zoomTitle: document.getElementById('zoomtoggle').title,
    storedZoom: JSON.parse(localStorage.getItem('synthlink.prefs.v1') || '{}').zoomLevel,
    storedScroll: JSON.parse(localStorage.getItem('synthlink.prefs.v1') || '{}').scrollback,
  }));

  console.log('uitest — scroll/zoom exclusivity, grab bar, welcome panel\n');

  // ── 1. Desktop: scrollback defaults on, so zoom starts suppressed ─────────
  {
    const { page, ctx, errs } = await boot('', { prefs: { welcomed: true } });
    eq(errs, [], 'desktop load: no page errors');
    let s = await zoomState(page);
    eq(s.scrollOn, true, 'desktop: scrollback defaults ON');
    eq(s.zoomDisabled, true, 'desktop: zoom button disabled while scrollback is on');
    eq(s.zoomIconOff, true, 'desktop: zoom icon shows the crossed-out magnifier');
    eq(s.zoomTitle, 'Zoom disabled while scrollback is on', 'desktop: title explains why');

    // Turning scrollback off releases zoom at its default 2x.
    await page.click('#scrolltoggle');
    s = await zoomState(page);
    eq(s.scrollOn, false, 'scrollback off');
    eq(s.zoomDisabled, false, 'zoom button enabled again');
    eq(s.zoomIconOff, false, 'zoom icon back to a magnification');
    eq(s.zoomIconText, '2×', 'zoom at its default 2x');

    // Choose 3x, then bounce scrollback: the choice must come back unchanged.
    await page.click('#zoomtoggle');
    s = await zoomState(page);
    eq(s.zoomIconText, '3×', 'zoom cycled to 3x');
    eq(s.zoomLit, true, '3x lights the button');
    eq(s.storedZoom, 1, '3x is persisted');

    await page.click('#scrolltoggle');
    s = await zoomState(page);
    eq(s.zoomDisabled, true, 'scrollback back on: zoom suppressed again');
    eq(s.zoomLit, false, 'suppressed zoom is not lit');
    eq(s.storedZoom, 1, 'the 3x choice is NOT overwritten while suppressed');

    await page.click('#scrolltoggle');
    s = await zoomState(page);
    eq(s.zoomDisabled, false, 'scrollback off again: zoom released');
    eq(s.zoomIconText, '3×', 'zoom returns to the PRIOR level, not the default');

    // A disabled button must not cycle even if something clicks it anyway.
    await page.click('#scrolltoggle');
    await page.evaluate(() => document.getElementById('zoomtoggle').dispatchEvent(new MouseEvent('click')));
    eq((await zoomState(page)).storedZoom, 1, 'a click on the suppressed button changes nothing');
    await ctx.close();
  }

  // ── 2. Mobile default is still scrollback OFF (so zoom is live there) ─────
  {
    const { page, ctx, errs } = await boot('', {
      viewport: { width: 390, height: 800 }, prefs: { welcomed: true },
    });
    eq(errs, [], 'mobile load: no page errors');
    const s = await zoomState(page);
    eq(s.scrollOn, false, 'mobile: scrollback defaults OFF');
    eq(s.zoomDisabled, false, 'mobile: zoom is available by default');
    eq(s.zoomIconText, '2×', 'mobile: zoom at 2x');
    eq(s.storedScroll, undefined, 'the per-device default is not written to storage');
    await ctx.close();
  }

  // A stored choice still wins over the per-device default.
  {
    const { page, ctx } = await boot('', {
      viewport: { width: 390, height: 800 },
      prefs: { scrollback: true, welcomed: true },
    });
    const s = await zoomState(page);
    eq(s.scrollOn, true, 'mobile: a stored scrollback=true wins over the default');
    eq(s.zoomDisabled, true, 'mobile: and suppresses zoom accordingly');
    await ctx.close();
  }

  // ── 3. Page-scroll grab bar ──────────────────────────────────────────────
  {
    // Tall desktop viewport: nothing scrolls, so the bar stays out of the way.
    const { page, ctx } = await boot('', { prefs: { welcomed: true } });
    eq(await page.locator('#pagegrab').isVisible(), false,
       'grab bar hidden when the page does not scroll');

    // Opening the keyboard on a phone-sized viewport is what makes the page
    // scroll — and is exactly when a handle is needed.
    await ctx.close();
  }
  {
    const { page, ctx } = await boot('', {
      viewport: { width: 390, height: 700 },
      prefs: { welcomed: true },
    });
    await page.click('#kbdtoggle');
    await page.waitForTimeout(250);
    eq(await page.evaluate(() => {
      const s = document.scrollingElement;
      return s.scrollHeight - s.clientHeight > 2;
    }), true, 'keyboard open on mobile: the page scrolls');
    eq(await page.locator('#pagegrab').isVisible(), true,
       'grab bar appears when the page scrolls');
    // It must sit between the terminal and the keyboard, not somewhere else.
    eq(await page.evaluate(() => {
      const t = document.getElementById('wrap').getBoundingClientRect();
      const g = document.getElementById('pagegrab').getBoundingClientRect();
      const k = document.getElementById('keyboard').getBoundingClientRect();
      return g.top >= t.bottom - 1 && g.bottom <= k.top + 1;
    }), true, 'grab bar sits between the terminal and the keyboard');
    eq(await page.evaluate(() =>
      Math.round(document.getElementById('pagegrab').getBoundingClientRect().height)), 10,
      'grab bar is 10px tall');
    // The browser must own the touch gesture, or it cannot scroll natively.
    eq(await page.evaluate(() =>
      getComputedStyle(document.getElementById('pagegrab')).touchAction), 'pan-y',
      'grab bar keeps the native pan-y gesture');

    // Mouse drag scrolls the page.
    const box = await page.locator('#pagegrab').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y - 120, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(100);
    eq(await page.evaluate(() => document.scrollingElement.scrollTop > 20), true,
       'dragging the grab bar upwards scrolls the page down');
    await ctx.close();
  }

  // ── 4. Welcome panel ─────────────────────────────────────────────────────
  {
    const { page, ctx, errs } = await boot('');
    eq(errs, [], 'first visit: no page errors');
    eq(await page.locator('#welcomemodal').isVisible(), true, 'first visit: welcome panel shown');
    eq(await page.locator('#welcomebody h1').textContent(), 'Welcome to SynthLink',
       'welcome text comes from welcome.html');
    eq(await page.evaluate(() =>
      JSON.parse(localStorage.getItem('synthlink.prefs.v1') || '{}').welcomed), true,
      'welcomed is recorded on open, not on close');
    await page.click('#welcomego');
    eq(await page.locator('#welcomemodal').isVisible(), false, 'the button dismisses it');
    await ctx.close();
  }
  {
    // Any stored preference at all means this is not a first visit.
    const { page, ctx } = await boot('', { prefs: { zoomLevel: 0 } });
    eq(await page.locator('#welcomemodal').isVisible(), false,
       'a returning browser never sees it, even with `welcomed` absent');
    await ctx.close();
  }
  {
    const { page, ctx } = await boot('?host=bbs.fozztexx.com&connect=1');
    eq(await page.locator('#welcomemodal').isVisible(), false,
       'a shared connect link suppresses the welcome panel');
    eq(await page.locator('#dialmodal').isVisible(), true, 'and shows the Connect prompt instead');
    eq(await page.evaluate(() =>
      JSON.parse(localStorage.getItem('synthlink.prefs.v1') || '{}').welcomed), true,
      'that visitor still counts as welcomed');
    await ctx.close();
  }
  {
    // A shared link WITHOUT connect= is an ordinary first visit.
    const { page, ctx } = await boot('?host=bbs.fozztexx.com');
    eq(await page.locator('#welcomemodal').isVisible(), true,
       'a shared link with no connect= still greets a new visitor');
    await ctx.close();
  }

  await b.close();
  console.log(`\n${fail ? 'FAILED' : 'OK'} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
