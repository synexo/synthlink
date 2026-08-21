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
//   • 40-column mode: entered ONLY by selecting the 9x14 font, resizing the
//     real canvas and riding out to the server on the dial message.

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
      // Records both the construction (did it dial?) and everything sent on
      // the socket (WHAT did it dial with?), and reports itself as open so the
      // page's onopen path actually runs. Nothing listens; no server exists.
      window.__dials = [];
      window.__sent = [];
      const RealWS = window.WebSocket;
      window.WebSocket = function (url) {
        window.__dials.push(url);
        const o = {
          readyState: 1, url, binaryType: 'arraybuffer',
          send(d) {
            window.__sent.push(d);
            // The page will not dial until the server answers its `resolve`, so
            // the recorder has to play that one part of the server. Everything
            // after the dial message is left unanswered — the point of these
            // tests is what goes OUT, not what a call does next.
            let m; try { m = JSON.parse(d); } catch (_) { return; }
            if (m && m.type === 'resolve') {
              setTimeout(() => o.onmessage && o.onmessage(
                { data: JSON.stringify({ type: 'resolved', ip: '203.0.113.7' }) }), 0);
            }
          },
          close() { o.readyState = 3; if (o.onclose) o.onclose({}); },
          onopen: null, onmessage: null, onclose: null, onerror: null,
        };
        setTimeout(() => { if (o.onopen) o.onopen({}); }, 0);
        return o;
      };
      window.WebSocket.OPEN = 1;
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

  // ── 5. 40-column mode (the 9x14 font) ────────────────────────────────────
  {
    // Start already on the 9x14 font, which is a legitimate stored state — it
    // is cycle-only, but a past choice persists like any other.
    const { page, ctx, errs } = await boot('', { prefs: { welcomed: true, fontId: 'vga9x14' } });
    eq(errs, [], '40-col load: no page errors');
    eq(await page.evaluate(() => {
      const c = document.getElementById('terminal-canvas');
      return [c.width, c.height];
    }), [360, 350], 'the backing canvas is 360x350, not 640x400');
    // Square pixels: the CSS box must carry the canvas's own aspect, or the
    // 1.556x height claim is not what the user actually gets.
    eq(await page.evaluate(() => {
      const c = document.getElementById('terminal-canvas');
      const w = parseFloat(c.style.width), h = parseFloat(c.style.height);
      return Math.abs((w / h) - (360 / 350)) < 0.02;
    }), true, 'the rendered box keeps the 360:350 aspect (square pixels)');
    await ctx.close();
  }
  {
    const { page, ctx } = await boot('', { prefs: { welcomed: true } });
    const canvasSize = () => page.evaluate(() => {
      const c = document.getElementById('terminal-canvas');
      return [c.width, c.height];
    });
    eq(await canvasSize(), [640, 400], 'starts at 80 columns / 8x16');
    // Cycle the Aa button until the 9x14 font comes up. It must be REACHABLE
    // this way and only this way, so a bounded search that finds it is the
    // assertion; the registry test pins that nothing else selects it.
    let found = false;
    for (let i = 0; i < 6 && !found; i++) {
      await page.click('#fonttoggle');
      found = (await page.evaluate(() =>
        JSON.parse(localStorage.getItem('synthlink.prefs.v1') || '{}').fontId)) === 'vga9x14';
    }
    eq(found, true, 'the Aa cycle reaches the 9x14 font');
    eq(await canvasSize(), [360, 350], 'selecting it switches the terminal to 40x25');

    // Cycling onward must come back out of 40-column mode.
    await page.click('#fonttoggle');
    eq((await canvasSize())[0], 640, 'cycling past it returns to 80 columns');
    await ctx.close();
  }
  {
    // The size has to reach the server, and the dial message is the only
    // carrier — so assert it on the actual dial, not on some internal.
    const { page, ctx } = await boot('', {
      prefs: { welcomed: true, fontId: 'vga9x14' },
    });
    // Telnet/modem-bypass, so the dial message goes out as soon as the socket
    // opens: no dial audio to wait through, no AudioContext to unblock, and the
    // window size rides the same message either way.
    await page.selectOption('#protocol', 'direct');
    await page.click('#dial');
    await page.waitForTimeout(1200);
    const dial = await page.evaluate(() => (window.__sent || [])
      .map((s) => { try { return JSON.parse(s); } catch (_) { return null; } })
      .filter((m) => m && m.type === 'dial')[0] || null);
    eq(dial && [dial.cols, dial.rows], [40, 25], 'the dial message carries cols:40, rows:25');
    await ctx.close();
  }

  // ── 6. Switching columns re-flows the screen instead of clearing it ──────
  {
    // Terminal.reflow() is proved at the model level by tools/reflowtest.js.
    // What can only be checked here is that the WIRING reaches it — a font
    // change used to blank the terminal, and a unit test of Terminal alone
    // cannot see that.
    //
    // Read through the rendered canvas rather than a test-only global: the
    // page deliberately exposes no handle on its terminal, and adding one just
    // for a harness would put test surface into the shipped app. Ink coverage
    // and a pixel hash are enough to tell "re-flowed" from "cleared".
    const { page, ctx } = await boot('', { prefs: { welcomed: true } });
    // The startup modem-init echo is already real content on screen, drawn by
    // the real render stack — no need to fabricate any.
    // Sampled twice ~600ms apart and intersected: the cursor blinks on a 500ms
    // timer, so it is dark in at least one of the two samples and drops out of
    // the intersection. Without that the hash is a coin flip and the round-trip
    // assertion below fails at random — which it did, the first time.
    const snap = () => page.evaluate(() => {
      const c = document.getElementById('terminal-canvas');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      const on = new Uint8Array(d.length / 4);
      for (let i = 0, p = 0; i < d.length; i += 4, p++) {
        on[p] = (d[i] | d[i + 1] | d[i + 2]) > 40 ? 1 : 0;
      }
      return { on: Array.from(on), px: c.width * c.height };
    });
    async function ink() {
      const a = await snap();
      await page.waitForTimeout(600);
      const b = await snap();
      let lit = 0, h = 2166136261;
      for (let i = 0; i < a.on.length; i++) {
        const v = (a.on[i] && b.on[i]) ? 1 : 0;    // steady ink only
        if (v) lit++;
        h = ((h ^ v) * 16777619) >>> 0;
      }
      return { lit, hash: h, px: a.px };
    }

    const at80 = await ink();
    eq(at80.lit > 200, true, '80 columns: the terminal has text on it');

    let found = false;
    for (let i = 0; i < 6 && !found; i++) {
      await page.click('#fonttoggle');
      found = (await page.evaluate(() =>
        JSON.parse(localStorage.getItem('synthlink.prefs.v1') || '{}').fontId)) === 'vga9x14';
    }
    eq(found, true, 'reached the 40-column font');
    await page.waitForTimeout(200);

    const at40 = await ink();
    eq(at40.px, 360 * 350, '40 columns: canvas really is 360x350');
    // The decisive assertion. A cleared terminal would leave only the cursor
    // block — a few hundred pixels at most. Re-flowed content keeps roughly the
    // ink it had, and cannot be near-empty.
    eq(at40.lit > at80.lit * 0.5, true,
       'the text is still there after the switch (re-flowed, not cleared)');

    // ...and the round trip is lossless, pixel for pixel.
    await page.click('#fonttoggle');
    await page.waitForTimeout(200);
    const back = await ink();
    eq([back.px, back.hash], [at80.px, at80.hash],
       '40 -> 80 restores the original screen exactly, pixel for pixel');
    await ctx.close();
  }
  {
    // The toast now has one shape for every font, column change or not.
    const { page, ctx } = await boot('', { prefs: { welcomed: true } });
    const toast = () => page.evaluate(() => document.getElementById('toast').textContent);
    const seen = [];
    for (let i = 0; i < 3; i++) { await page.click('#fonttoggle'); seen.push(await toast()); }
    eq(seen.every((t) => /^Font: .+ — (80|40) columns$/.test(t)), true,
       'every font toast reads "Font: <name> — <n> columns"');
    eq(seen.filter((t) => t.endsWith('— 40 columns')).length, 1,
       'exactly one font in the cycle reports 40 columns');
    await ctx.close();
  }

  await b.close();
  console.log(`\n${fail ? 'FAILED' : 'OK'} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
