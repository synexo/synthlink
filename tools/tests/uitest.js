#!/usr/bin/env node
// UI-behaviour checks that need a REAL browser, in the same shape as
// tools/tests/urltest.js: the page is served from memory by Playwright's request
// router and WebSocket is a recorder, so server.js is never started and the
// WS-listener sandbox hang (CLAUDE.md) is never tripped.
//
//     npm install --no-save playwright-core
//     node tools/tests/uitest.js
//     PW_CHROMIUM=/path/to/chrome node tools/tests/uitest.js   # if the binary needs pointing at
//
// Covers three things that are all live-DOM behaviour and cannot be stubbed:
//
//   • Scrollback and zoom are mutually exclusive, the zoom button says so, and
//     the user's magnification survives the round trip.
//   • The page-scroll grab bar appears exactly when the page can scroll.
//   • The welcome panel: shown on EVERY visit until "Don't show this again" is
//     clicked, and suppressed by a shared ?connect= link (which counts as
//     dismissed).
//   • 40-column mode: entered ONLY by selecting the 9x14 font, resizing the
//     real canvas and riding out to the server on the dial message.
//   • The font cycle is three NAMED SLOTS, and the "Modern" slot resolves to a
//     different file on a phone than on a desktop — which only a real viewport
//     can show.

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
const dir = require('path').join(__dirname, '..', '..', 'public');
// The real server substitutes {{BRAND}} & co. into every .html it serves
// (lib/site.js). The router below does the same, so these tests see the page a
// browser sees — otherwise the welcome panel's heading would read "{{BRAND}}"
// and every assertion about visible text would be testing the wrong thing.
const site = require('../../lib/site');

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

function ok(cond, what) {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL ${what}`);
}

const PREFS_KEY = 'synthlink.prefs.v1';

(async () => {
  const b = await chromium.launch(LAUNCH);

  // viewport is a parameter here (unlike urltest) because two of the three
  // features under test are layout-dependent: the mobile breakpoint is 640px
  // and the grab bar keys off whether the page actually scrolls.
  // `dpr` is a parameter for §11 only: the full-width check below is arithmetic
  // on device pixels, and a fractional device pixel ratio (2.625 is the common
  // Android case) is where the rounding it guards actually goes wrong. At the
  // default dpr 1 every quantity in it is a whole number and the test would
  // pass against code that gives a CSS pixel away.
  async function boot(query, { prefs, viewport, dpr, directory, answerConnected } = {}) {
    const ctx = await b.newContext({ viewport: viewport || { width: 1100, height: 700 },
                                     ...(dpr ? { deviceScaleFactor: dpr } : {}) });
    const page = await ctx.newPage();
    await page.route('**/*', async (route) => {
      const u = new URL(route.request().url());
      if (u.pathname === '/bbs.json') {
        return route.fulfill({ contentType: 'application/json',
                               body: JSON.stringify(directory || DIRECTORY) });
      }
      if (u.pathname.endsWith('dsp-bundle.js')) {
        return route.fulfill({ contentType: 'application/javascript',
          body: 'window.SynthModemDSP={ModemDSP:function(){this.on=()=>{};this.start=()=>{};this.stop=()=>{};},config:{modem:{native:{}}}};' });
      }
      const p = dir + (u.pathname === '/' ? '/index.html' : u.pathname);
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        const ext = p.split('.').pop();
        // woff2 must be served with a font MIME type: the outline font path
        // loads it through FontFace, and a wrong type makes the load fail —
        // which the app handles correctly (it falls back to a bitmap font and
        // says so), but which is not what this harness means to exercise.
        const type = { html: 'text/html', js: 'text/javascript', json: 'application/json',
                       svg: 'image/svg+xml', woff2: 'font/woff2',
                       ttf: 'font/ttf' }[ext] || 'text/plain';
        const body = ext === 'html' ? site.apply(fs.readFileSync(p, 'utf8')) : fs.readFileSync(p);
        return route.fulfill({ contentType: type, body });
      }
      return route.fulfill({ status: 404, body: '' });
    });
    await page.addInitScript(([key, prefsJSON, wantConnected]) => {
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
            // A live call echoes: the bytes sent come back as terminal output,
            // which is the only way a test can get KNOWN TEXT onto the screen to
            // click at. Opt-in with the same flag, so nothing above sees it.
            if (typeof d !== 'string') {
              if (wantConnected) {
                setTimeout(() => o.onmessage && o.onmessage({ data: d }), 0);
              }
              return;
            }
            let m; try { m = JSON.parse(d); } catch (_) { return; }
            if (m && m.type === 'resolve') {
              setTimeout(() => o.onmessage && o.onmessage(
                { data: JSON.stringify({ type: 'resolved', ip: '203.0.113.7' }) }), 0);
            }
            // Opt-in, so every section above still gets the silence it was
            // written against. A test that needs a LIVE call rather than a dial
            // asks for this and answers the dial too; only the modem-bypass path
            // can be brought up here at all, since a real one needs a DSP.
            if (wantConnected && m && m.type === 'dial' && m.link === 'direct') {
              setTimeout(() => o.onmessage && o.onmessage(
                { data: JSON.stringify({ type: 'connected' }) }), 0);
            }
          },
          // Asynchronous, like a real WebSocket: a close scheduled by one call
          // can land after the next call has already started. Making this
          // synchronous hides the stale-handler class of bug entirely.
          close() { o.readyState = 3; setTimeout(() => { if (o.onclose) o.onclose({}); }, 0); },
          onopen: null, onmessage: null, onclose: null, onerror: null,
        };
        setTimeout(() => { if (o.onopen) o.onopen({}); }, 0);
        return o;
      };
      window.WebSocket.OPEN = 1;
      if (prefsJSON) localStorage.setItem(key, prefsJSON);
    }, [PREFS_KEY, prefs ? JSON.stringify(prefs) : '', !!answerConnected]);

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
    storedZoom: JSON.parse(localStorage.getItem('synthlink.prefs.v1') || '{}').zoomLevel,
    storedScroll: JSON.parse(localStorage.getItem('synthlink.prefs.v1') || '{}').scrollback,
  }));

  console.log('uitest — scroll/zoom exclusivity, grab bar, welcome panel\n');

  // ── 1. Desktop: scrollback defaults on, so zoom starts suppressed ─────────
  {
    const { page, ctx, errs } = await boot('', { prefs: { welcomeDismissed: true } });
    eq(errs, [], 'desktop load: no page errors');
    let s = await zoomState(page);
    eq(s.scrollOn, true, 'desktop: scrollback defaults ON');
    eq(s.zoomDisabled, true, 'desktop: zoom button disabled while scrollback is on');
    eq(s.zoomIconOff, true, 'desktop: zoom icon shows the crossed-out magnifier');

    // Turning scrollback off releases zoom at its default 2x.
    await page.click('#scrolltoggle');
    s = await zoomState(page);
    eq(s.scrollOn, false, 'scrollback off');
    eq(s.zoomDisabled, false, 'zoom button enabled again');
    eq(s.zoomIconOff, false, 'zoom icon back to a magnification');

    // Choose 3x, then bounce scrollback: the choice must come back unchanged.
    await page.click('#zoomtoggle');
    s = await zoomState(page);
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
      viewport: { width: 390, height: 800 }, prefs: { welcomeDismissed: true },
    });
    eq(errs, [], 'mobile load: no page errors');
    const s = await zoomState(page);
    eq(s.scrollOn, false, 'mobile: scrollback defaults OFF');
    eq(s.zoomDisabled, false, 'mobile: zoom is available by default');
    eq(s.storedScroll, undefined, 'the per-device default is not written to storage');
    await ctx.close();
  }

  // A stored choice still wins over the per-device default.
  {
    const { page, ctx } = await boot('', {
      viewport: { width: 390, height: 800 },
      prefs: { scrollback: true, welcomeDismissed: true },
    });
    const s = await zoomState(page);
    eq(s.scrollOn, true, 'mobile: a stored scrollback=true wins over the default');
    eq(s.zoomDisabled, true, 'mobile: and suppresses zoom accordingly');
    await ctx.close();
  }

  // ── 3. Page-scroll grab bar ──────────────────────────────────────────────
  {
    // Tall desktop viewport: nothing scrolls, so the bar stays out of the way.
    const { page, ctx } = await boot('', { prefs: { welcomeDismissed: true } });
    eq(await page.locator('#pagegrab').isVisible(), false,
       'grab bar hidden when the page does not scroll');

    // Opening the keyboard on a phone-sized viewport is what makes the page
    // scroll — and is exactly when a handle is needed.
    await ctx.close();
  }
  {
    const { page, ctx } = await boot('', {
      viewport: { width: 390, height: 700 },
      prefs: { welcomeDismissed: true },
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
  // It is no longer once-only: it returns on every load until the visitor opts
  // out, and opting out is the ONLY thing that silences it. The negative cases
  // below (reload after Get started; reload after the opt-out) are the whole
  // feature.
  {
    const { page, ctx, errs } = await boot('');
    eq(errs, [], 'first visit: no page errors');
    eq(await page.locator('#welcomemodal').isVisible(), true, 'welcome panel shown');
    eq(await page.evaluate(() =>
      JSON.parse(localStorage.getItem('synthlink.prefs.v1') || '{}').welcomeDismissed), undefined,
      'merely opening it does NOT dismiss it');
    await page.click('#welcomego');
    eq(await page.locator('#welcomemodal').isVisible(), false, 'Get started dismisses it');
    eq(await page.evaluate(() =>
      JSON.parse(localStorage.getItem('synthlink.prefs.v1') || '{}').welcomeDismissed), undefined,
      'Get started does not silence it either');
    // Reload in the same context: the stored prefs (and their absence of the
    // opt-out) survive, which is exactly the case that used to fail.
    await page.reload();
    await page.waitForTimeout(400);
    eq(await page.locator('#welcomemodal').isVisible(), true,
       'it comes back on the next load');
    // Now opt out, and check it stays gone.
    await page.click('#welcomenever');
    eq(await page.locator('#welcomemodal').isVisible(), false, "Don't show this again dismisses it");
    eq(await page.evaluate(() =>
      JSON.parse(localStorage.getItem('synthlink.prefs.v1') || '{}').welcomeDismissed), true,
      'and records the opt-out');
    await page.reload();
    await page.waitForTimeout(400);
    eq(await page.locator('#welcomemodal').isVisible(), false,
       'after the opt-out it never returns');
    await ctx.close();
  }
  {
    // A returning browser that never opted out is greeted again — the old
    // "any stored preference means not a first visit" rule is gone.
    const { page, ctx } = await boot('', { prefs: { zoomLevel: 0 } });
    eq(await page.locator('#welcomemodal').isVisible(), true,
       'a returning browser is greeted again unless it opted out');
    await ctx.close();
  }
  {
    const { page, ctx } = await boot('?host=bbs.fozztexx.com&connect=1');
    eq(await page.locator('#welcomemodal').isVisible(), false,
       'a shared connect link suppresses the welcome panel');
    eq(await page.locator('#dialmodal').isVisible(), true, 'and shows the Connect prompt instead');
    eq(await page.evaluate(() =>
      JSON.parse(localStorage.getItem('synthlink.prefs.v1') || '{}').welcomeDismissed), true,
      'that visitor counts as dismissed, so the two never stack up');
    await ctx.close();
  }
  {
    // A shared link WITHOUT connect= is an ordinary visit.
    const { page, ctx } = await boot('?host=bbs.fozztexx.com');
    eq(await page.locator('#welcomemodal').isVisible(), true,
       'a shared link with no connect= still greets the visitor');
    await ctx.close();
  }

  // ── 4b. The tab and the icon carry the configured brand ──────────────────
  {
    const { page, ctx } = await boot('', { prefs: { welcomeDismissed: true } });
    eq(await page.evaluate(() => /\{\{[A-Z_]+\}\}/.test(document.documentElement.outerHTML)),
       false, 'no unsubstituted token reaches the browser');
    await ctx.close();
  }

  // ── 5. 40-column mode (the 9x14 font) ────────────────────────────────────
  {
    // Start already on the 9x14 font, which is a legitimate stored state — it
    // is cycle-only, but a past choice persists like any other.
    const { page, ctx, errs } = await boot('', { prefs: { welcomeDismissed: true, fontId: 'vga9x14' } });
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
    const { page, ctx } = await boot('', { prefs: { welcomeDismissed: true } });
    const canvasSize = () => page.evaluate(() => {
      const c = document.getElementById('terminal-canvas');
      return [c.width, c.height];
    });
    const toastText = () => page.evaluate(
      () => document.getElementById('toast').textContent);
    const storedFont = () => page.evaluate(() =>
      JSON.parse(localStorage.getItem('synthlink.prefs.v1') || '{}').fontId);

    // A fresh visit starts on the DEFAULT, which is now an outline font on the
    // hybrid path. So there is no 640x400 to assert any more: a hybrid font
    // sizes its backing store in DEVICE pixels, and 640 was only ever a
    // legacy-path number. What is still true, and is what this was about, is
    // that it is not the 40-column geometry.
    eq((await canvasSize())[0] !== 360, true, 'starts at 80 columns');

    // Cycle the Aa button until 40-column mode comes up. It must be REACHABLE
    // this way and only this way, so a bounded search that finds it is the
    // assertion; the registry test pins that nothing else selects it.
    //
    // Driven off the TOAST, not off a font id or a canvas width. The cycle is
    // three named slots now and the font behind the "Modern" one depends on
    // the screen, so an id is the wrong thing to search for; and a hybrid
    // font's canvas is whatever the device works out to, so a width cannot
    // distinguish 80 columns from 40. The toast states the column count
    // directly, which is what these assertions were always about.
    // FONTS.md flags exactly this coupling.
    let found = false;
    for (let i = 0; i < 6 && !found; i++) {
      await page.click('#fonttoggle');
      found = /— 40 columns$/.test(await toastText());
    }
    eq(found, true, 'the Aa cycle reaches 40-column mode');
    eq(await storedFont(), 'vga9x14px',
       '...backed by the OUTLINE 9x14, and persisted by FONT ID rather than by slot');
    // On the hybrid path the backing store is in device pixels, so 360x350 —
    // the number 40-column mode is defined by on the legacy path — is exactly
    // what it must NOT be.
    eq((await canvasSize())[0] !== 360, true,
       '...whose backing store is in device pixels, not the legacy 360x350');

    // Cycling onward must come back out of 40-column mode.
    let out80 = false;
    for (let i = 0; i < 8 && !out80; i++) {
      await page.click('#fonttoggle');
      out80 = /— 80 columns$/.test(await toastText());
    }
    eq(out80, true, 'cycling onward returns to 80 columns');
    eq((await canvasSize())[0] !== 360, true,
       '...and the canvas is no longer the 40-column geometry');
    await ctx.close();
  }
  {
    // The size has to reach the server, and the dial message is the only
    // carrier — so assert it on the actual dial, not on some internal.
    const { page, ctx } = await boot('', {
      prefs: { welcomeDismissed: true, fontId: 'vga9x14' },
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

  // ── 5b. The "Modern" slot is a different file on a phone ────────────────
  //
  // One slot, one label, one position in the cycle — two files, chosen by
  // screen width. Only a real viewport can demonstrate it, which is why it is
  // here rather than in a unit harness: arithmetic can prove cycleFonts(true)
  // returns Flexi True, but not that the page asks it the right question.
  //
  // THE ASSERTION IS WHICH FONT FILE LOADED, not what any label says. It used
  // to be the tooltip, on the reasoning that it was the one place both names
  // were visible — the slot the user picked and the file actually rendering.
  // The tooltip now shows only the slot label (it says the same thing as the
  // toast, deliberately), so that observation point is gone.
  //
  // Reading `document.fonts` is a better test than the one it replaces, and
  // would have been the right one all along: a tooltip only proves a STRING was
  // written, while an @font-face family in document.fonts proves the browser
  // actually fetched and registered that file. A test that checked the toast
  // would pass even if the substitution never happened, since the toast says
  // "Modern" on either device.
  for (const [label, viewport, want] of [
    ['desktop', { width: 1100, height: 700 }, 'Flexi IBM VGA False A160 437'],
    ['mobile',  { width: 390, height: 844 },  'Flexi IBM VGA True 437'],
  ]) {
    const { page, ctx, errs } = await boot('', {
      prefs: { welcomeDismissed: true }, viewport,
    });
    eq(errs, [], `${label}: no page errors on the default font`);
    // A fresh visit starts on slot 0, "Pixel", which is the same file on both
    // devices — so getting to the substituting slot takes one press. That is
    // the point of the press, not an incidental setup step: it is what proves
    // the SLOT resolves per device rather than the default doing so.
    // UNLIT WHILE UNTOUCHED — the button means "you have changed this". Asserted
    // here, before any press, because that is the only moment it is true; the
    // presses below deliberately leave the default. Comparing against a single
    // DEFAULT_FONT_ID would have left every phone permanently lit back when the
    // default was device-dependent, which is why the check is against
    // deviceDefaultFont() rather than the constant.
    eq(await page.evaluate(
         () => document.getElementById('fonttoggle').classList.contains('on')), false,
       `${label}: the Aa button is unlit on this device's own default`);
    await page.click('#fonttoggle');
    // `document.fonts.ready` is NOT enough, and this was an intermittent
    // failure until it was: it resolves when the loads pending AT THAT MOMENT
    // have settled, and the font-cycle handler registers its FontFace
    // asynchronously — so the await can return before the new face has even
    // joined the set, leaving only the previous font's family in it. Poll for
    // the family instead, which is the fact under test; the timeout keeps a
    // genuine failure a failure rather than a hang.
    const families = await page.evaluate(async (wanted) => {
      const read = () => { const o = []; document.fonts.forEach((f) => o.push(f.family)); return o; };
      for (let i = 0; i < 40; i++) {
        await document.fonts.ready;
        if (read().includes(wanted)) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      return read();
    }, want);
    eq(families.includes(want), true,
       `${label}: ...but it LOADED ${want} (families: ${families.join(', ')})`);
    await ctx.close();
  }

  // ── 6. Switching columns re-flows the screen instead of clearing it ──────
  {
    // Terminal.reflow() is proved at the model level by tools/tests/reflowtest.js.
    // What can only be checked here is that the WIRING reaches it — a font
    // change used to blank the terminal, and a unit test of Terminal alone
    // cannot see that.
    //
    // Read through the rendered canvas rather than a test-only global: the
    // page deliberately exposes no handle on its terminal, and adding one just
    // for a harness would put test surface into the shipped app. Ink coverage
    // and a pixel hash are enough to tell "re-flowed" from "cleared".
    const { page, ctx } = await boot('', { prefs: { welcomeDismissed: true } });
    // The startup modem-init echo is already real content on screen, drawn by
    // the real render stack — no need to fabricate any.
    // Sampled THREE times ~350ms apart and intersected, not twice at ~600ms.
    //
    // The cursor blinks on a 500 ms timer, so it is lit for 500 ms out of every
    // 1000 and any single sample is a coin flip. Two samples 600 ms apart do
    // NOT fix that: 600 is longer than the on-window but shorter than the
    // period, so a pair starting late in an on-window (t=450, t=1050) lands on
    // TWO lit samples and the cursor survives the intersection. That is the
    // known 40 -> 80 flake CLAUDE.md records, and measuring it here showed it
    // at roughly one run in three — two stable hashes, 276 lit pixels apart,
    // which is exactly one cursor block.
    //
    // Three samples spanning 700 ms cannot all be lit, because the on-window is
    // only 500 ms: whatever the phase, at least one sample falls outside it and
    // the intersection drops the cursor. The rule generalises — the span must
    // exceed the ON time, not the period — and CLAUDE.md's "sample twice ~600 ms
    // apart" should be read as superseded by it.
    // THE WHOLE INTERSECTION RUNS INSIDE THE PAGE, and that is not an
    // optimisation — it is what makes the rule above true. Sampling used to be
    // driven from here: one `page.evaluate` per shot with
    // `page.waitForTimeout(350)` between them. The gap that actually resulted
    // was 350 ms PLUS the cost of serialising a ~455,000-entry array across the
    // CDP boundary — large, and variable — so the real spacing drifted to
    // roughly 600-700 ms and the three-sample span could exceed a full 1000 ms
    // period. At that point all three samples CAN land in an on-window, the
    // cursor survives the intersection, and the round-trip hash differs by
    // exactly one cursor block.
    //
    // THAT is the "40 -> 80 flake" this file carried for several sessions: ~1
    // run in 3, measured delta 230 lit pixels, px identical. It was never the
    // re-flow — and it was not the blink rule either. It was the harness
    // failing to keep to the interval the blink rule specifies.
    //
    // With the timing on the page's own clock the gaps are the gaps, and only
    // the finished {lit, hash, px} crosses the boundary — three numbers instead
    // of three bitmaps, which also makes settledInk()'s retries cheap.
    const ink = () => page.evaluate(async () => {
      const c = document.getElementById('terminal-canvas');
      const g = c.getContext('2d');
      const snap = () => {
        const d = g.getImageData(0, 0, c.width, c.height).data;
        const on = new Uint8Array(d.length / 4);
        for (let i = 0, p = 0; i < d.length; i += 4, p++) {
          on[p] = (d[i] | d[i + 1] | d[i + 2]) > 40 ? 1 : 0;
        }
        return on;
      };
      const shots = [snap()];
      for (let k = 0; k < 2; k++) {
        await new Promise((r) => setTimeout(r, 350));
        shots.push(snap());
      }
      const [a, b, cc] = shots;
      let lit = 0, h = 2166136261;
      for (let i = 0; i < a.length; i++) {
        const v = (a[i] && b[i] && cc[i]) ? 1 : 0;             // steady ink only
        if (v) lit++;
        h = ((h ^ v) * 16777619) >>> 0;
      }
      return { lit, hash: h, px: c.width * c.height };
    });

    // ...and then repeated until two whole ink() readings AGREE.
    //
    // ink() already handles the 500 ms cursor blink by intersecting two
    // samples. What it cannot handle is an ASYNCHRONOUS ATLAS: the default font
    // is an outline font now, so its glyph atlas is built only once the woff2
    // has loaded and is REBUILT whenever the layout changes — including on the
    // way back from the 40-column font. A reading taken across that rebuild
    // catches a half-painted screen, and the round-trip hash below then differs
    // for a reason that has nothing to do with re-flow. This made the known
    // 40 -> 80 flake (CLAUDE.md) reproducible rather than rare.
    //
    // Two agreeing readings mean nothing repainted between them, which is the
    // honest definition of "the screen has settled" from outside the page.
    async function settledInk() {
      let prev = null;
      for (let i = 0; i < 6; i++) {
        const cur = await ink();
        if (prev && cur.hash === prev.hash && cur.px === prev.px) return cur;
        prev = cur;
      }
      return prev;                                   // caller's assertion reports it
    }

    const at80 = await settledInk();
    eq(at80.lit > 200, true, '80 columns: the terminal has text on it');

    let found = false;
    for (let i = 0; i < 6 && !found; i++) {
      await page.click('#fonttoggle');
      found = /— 40 columns$/.test(await page.evaluate(
        () => document.getElementById('toast').textContent));
    }
    eq(found, true, 'reached the 40-column font');
    await page.waitForTimeout(200);

    const at40 = await settledInk();
    // The canvas really did change shape. Not asserted as 360x350 any more —
    // the 40-column font is on the hybrid path, so its backing store is in
    // device pixels — but a column change must still resize the store, and
    // that is the part this was checking.
    eq(at40.px !== at80.px, true, '40 columns: the backing store changed shape');
    // The decisive assertion. A cleared terminal would leave only the cursor
    // block — a few hundred pixels at most. Re-flowed content keeps roughly the
    // ink it had, and cannot be near-empty.
    eq(at40.lit > at80.lit * 0.5, true,
       'the text is still there after the switch (re-flowed, not cleared)');

    // ...and the round trip is lossless, pixel for pixel.
    //
    // Cycle until the STARTING font comes back round, rather than assuming one
    // more click does it. The comparison is against `at80`, which was captured
    // on the default font, so it is only meaningful once that same font is
    // active again. The id is read from the REGISTRY rather than written in
    // here, so this stays honest however the cycle is reordered and whichever
    // font the default happens to be.
    const defaultId = await page.evaluate(async () =>
      (await import('/fonts/index.js')).DEFAULT_FONT_ID);
    let home = false;
    for (let i = 0; i < 16 && !home; i++) {
      await page.click('#fonttoggle');
      home = (await page.evaluate(() =>
        JSON.parse(localStorage.getItem('synthlink.prefs.v1') || '{}').fontId)) === defaultId;
    }
    eq(home, true, 'the cycle comes back round to the font it started on');
    await page.waitForTimeout(200);
    const back = await settledInk();
    eq([back.px, back.hash], [at80.px, at80.hash],
       `40 -> 80 restores the original screen exactly, pixel for pixel `
       + `[lit ${at80.lit} -> ${back.lit}, diff ${back.lit - at80.lit}, px ${at80.px} -> ${back.px}]`);
    await ctx.close();
  }
  // ── 5. Gesture ownership: the terminal releases touch when it owns nothing ─
  // touch-action is the assertion because it is the part that actually decides
  // whether the browser will pan or pinch. Reading the COMPUTED value rather
  // than the class also catches a CSS rule that has stopped matching.
  {
    const { page, ctx } = await boot('', {
      viewport: { width: 390, height: 800 }, prefs: { welcomeDismissed: true },
    });
    const ta = () => page.evaluate(() => ({
      touchAction: getComputedStyle(document.getElementById('terminal-canvas')).touchAction,
      cls: document.body.classList.contains('gestures-free'),
      scrollOn: document.getElementById('scrolltoggle').classList.contains('on'),
    }));

    // Mobile default: scrollback off, zoom 2x — zoom owns the drag, so the
    // canvas must still claim every gesture.
    let s = await ta();
    eq(s.touchAction, 'none', 'zoom on: canvas still claims the gesture');
    eq(s.cls, false, 'and the page is not in gestures-free');

    // Cycle zoom to its OFF setting (2x -> 3x -> off). Now nothing owns a drag.
    await page.click('#zoomtoggle');
    await page.click('#zoomtoggle');
    s = await ta();
    eq(s.cls, true, 'scrollback off + zoom off: page goes gestures-free');
    eq(s.touchAction, 'auto', 'and the canvas hands touch back to the browser');

    // Turning scrollback back on takes ownership again — either switch alone is
    // enough to reclaim the gesture.
    //
    // Ownership is ONE switch pair, deliberately. Handing the pinch back on the
    // zoom setting alone (`touch-action:pinch-zoom` while scrollback is on) was
    // tried and did not work on a device, so it was reverted rather than left
    // in as a plausible-looking rule nothing exercised. `none` here is the
    // whole of it: if either switch is on, the canvas claims every gesture.
    await page.click('#scrolltoggle');
    s = await ta();
    eq([s.scrollOn, s.cls], [true, false], 'scrollback on: gestures-free released');
    eq(s.touchAction, 'none', 'and the canvas claims the gesture again');

    await page.click('#scrolltoggle');
    eq((await ta()).touchAction, 'auto', 'scrollback off again: free once more');

    // Zoom alone is also enough, in both scrollback states.
    await page.click('#zoomtoggle');                  // off -> 2x
    s = await ta();
    eq([s.touchAction, s.cls], ['none', false], 'zoom on: claimed again');
    await page.click('#scrolltoggle');                // ...and with scrollback on
    s = await ta();
    eq([s.touchAction, s.cls], ['none', false], 'zoom on + scrollback on: still claimed');
    await ctx.close();
  }

  // ── 6. Scope sizing: the header must never grow to fit the oscilloscope ────
  // This is the regression the sizing rework exists to prevent, and it only
  // showed at width — the old viewport-derived height crossed #bar's floor past
  // ~1560px and pushed the terminal down. Checked at three widths so a fix that
  // merely moved the crossover point would still fail here.
  //
  // All three are above the 1320px stacking breakpoint, because this section is
  // about the INLINE layout. The stacked one is section 6b.
  {
    for (const width of [1400, 1680, 1920]) {
      const { page, ctx } = await boot('', {
        viewport: { width, height: 800 }, prefs: { welcomeDismissed: true },
      });
      const m = await page.evaluate(() => {
        const barEl = document.getElementById('bar');
        const bar = barEl.getBoundingClientRect();
        const cs = getComputedStyle(barEl);
        const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
        const ctrl = document.getElementById('controls').getBoundingClientRect();
        const sc = document.getElementById('scope');
        const r = sc.getBoundingClientRect();
        return { barH: bar.height, pad, ctrlH: ctrl.height,
                 scopeH: r.height, scopeW: r.width,
                 clientW: sc.clientWidth, clientH: sc.clientHeight,
                 backingW: sc.width, backingH: sc.height,
                 dpr: window.devicePixelRatio || 1 };
      });
      // THE assertion. The header's height must be decided by the control
      // column alone; the scope contributes nothing to it. Under the old
      // viewport-derived sizing this failed above ~1560px, where the scope's
      // computed height exceeded what the controls needed and grew the bar,
      // taking that height straight off the terminal.
      eq(Math.abs(m.barH - (m.ctrlH + m.pad)) < 1, true,
         `${width}px: header height is set by the controls, not the scope`);
      eq(m.scopeH <= m.ctrlH + 0.5, true, `${width}px: scope fits inside the header`);
      // And it USES that height rather than shrinking away from it — the other
      // half of the complaint. Within a pixel of the control column.
      eq(Math.abs(m.scopeH - m.ctrlH) < 1, true, `${width}px: scope fills the header height`);
      // No dead space. The header is the controls plus padding and nothing
      // else — this is the "empty space above BBS, below ready…" complaint,
      // and it is what removing #bar's 104px floor bought. 1px of tolerance
      // for the border.
      eq(m.barH - m.ctrlH - m.pad <= 1.5, true,
         `${width}px: no slack between the controls and the header edge`);
      // The scope takes the whole remainder of the line rather than stopping
      // at a cap: what is left over after the controls, minus the bar's gap.
      eq(m.scopeW > 150, true, `${width}px: the inline scope is worth having`);
      // The backing store tracks the CSS box — the ResizeObserver's job.
      // clientWidth/Height, not the bounding rect: the rect includes the 1px
      // border the backing store has no business covering.
      eq(Math.abs(m.backingW - m.clientW * m.dpr) <= 1, true, `${width}px: backing width matches`);
      eq(Math.abs(m.backingH - m.clientH * m.dpr) <= 1, true, `${width}px: backing height matches`);
      await ctx.close();
    }
  }
  {
    // The positive half of the feature: extra window width goes to the scope,
    // and extra window width never goes to the header. Measured as a monotonic
    // sweep rather than against fixed numbers, so the comfort caps in the CSS
    // can be retuned without rewriting the test.
    const at = async (w) => {
      const { page, ctx } = await boot('', {
        viewport: { width: w, height: 800 }, prefs: { welcomeDismissed: true },
      });
      const r = await page.evaluate(() => ({
        scopeW: document.getElementById('scope').getBoundingClientRect().width,
        barH: document.getElementById('bar').getBoundingClientRect().height,
        termH: document.getElementById('wrap').getBoundingClientRect().height,
      }));
      await ctx.close();
      return r;
    };
    // Inline widths only — the sweep is about how free space is distributed
    // within one layout. Crossing the stacking breakpoint is a change OF
    // layout, and the scope is legitimately wider on the stacked side (it has
    // the whole row), so a sweep spanning it would compare two different things.
    const seq = [];
    for (const w of [1400, 1560, 1680, 1920]) seq.push(await at(w));
    for (let i = 1; i < seq.length; i++) {
      eq(seq[i].scopeW >= seq[i - 1].scopeW, true,
         `a wider window never shrinks the scope (step ${i})`);
      eq(seq[i].barH <= seq[i - 1].barH, true,
         `a wider window never grows the header (step ${i})`);
      eq(seq[i].termH >= seq[i - 1].termH, true,
         `a wider window never shrinks the terminal (step ${i})`);
    }
    // And the scope genuinely uses the room, rather than sitting at its floor.
    eq(seq[seq.length - 1].scopeW > seq[0].scopeW, true,
       'the scope is wider at 1920 than at 1400');
  }

  // ── 6b. The control column's own flow is NOT the scope's business ─────────
  // The header flow below the wide widths — how the control rows wrap, how tall
  // that makes the bar, how wide the scope is beside them — was settled long
  // before this rework and must come through it unchanged. It did not, twice:
  // once by removing the scope's reserved width (the controls then took the
  // whole line), and once by moving the stacking breakpoint to 1320px (which
  // stacked the header at desktop widths that had never stacked).
  //
  // So this pins the width RESERVATION, which is what the control wrap keys
  // off: the scope holds exactly the original clamp — 20vw between 200 and
  // 320 — at every width where the controls still need room, and only grows
  // once they are satisfied.
  {
    for (const width of [700, 900, 1100, 1200, 1280]) {
      const { page, ctx } = await boot('', {
        viewport: { width, height: 800 }, prefs: { welcomeDismissed: true },
      });
      const m = await page.evaluate(() => {
        const ctrlEl = document.getElementById('controls');
        const ctrl = ctrlEl.getBoundingClientRect();
        const scWrap = document.getElementById('scope-wrap').getBoundingClientRect();
        const sc = document.getElementById('scope').getBoundingClientRect();
        const barEl = document.getElementById('bar');
        const bar = barEl.getBoundingClientRect();
        const cs = getComputedStyle(barEl);
        // The widest line the control rows actually occupy — what fitBar()
        // measures. Anything between this and the scope is wasted header.
        let widest = 0;
        for (const row of ctrlEl.querySelectorAll('.row')) {
          const rr = row.getBoundingClientRect();
          for (const el of row.children) {
            const r = el.getBoundingClientRect();
            widest = Math.max(widest, (r.left - rr.left) + Math.max(r.width, el.scrollWidth));
          }
        }
        return { stacked: sc.top >= ctrl.bottom, scopeW: sc.width,
                 gap: scWrap.left - (ctrl.left + widest),
                 barH: bar.height, ctrlH: ctrl.height,
                 barRight: bar.right, scopeRight: sc.right,
                 pad: parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom),
                 padRight: parseFloat(cs.paddingRight),
                 barGap: parseFloat(getComputedStyle(barEl).columnGap) || 16 };
      });
      const clamp = Math.min(320, Math.max(200, width * 0.2));
      eq(m.stacked, false, `${width}px: the scope stays INLINE (no stacking above 640)`);
      // The floor still holds — the reservation is what makes the control rows
      // wrap the way they always have.
      eq(m.scopeW >= clamp - 1.5, true,
         `${width}px: scope is never below the reserved clamp (${Math.round(clamp)}px)`);
      // THE new assertion: no dead space between where the control rows
      // actually end and where the scope begins. Before fitBar() this gap ran
      // to ~300px at some widths — the control column holding width its
      // wrapped rows were not using, which the scope could not reach.
      eq(m.gap <= m.barGap + 1.5, true,
         `${width}px: no wasted width between the controls and the scope`);
      // ...and the scope reaches the far edge, so nothing is stranded there.
      eq(Math.abs(m.barRight - m.padRight - m.scopeRight) <= 1.5, true,
         `${width}px: scope runs to the header's right edge`);
      // Whatever the controls did with the room, the header is still only as
      // tall as they made it.
      eq(m.barH - m.ctrlH - m.pad <= 1.5, true, `${width}px: no slack in the header`);
      await ctx.close();
    }
  }
  {
    // The stacking breakpoint is 640px and stays there — it is the phone
    // layout, not a "the scope got thin" fallback. Pinned in both directions.
    const layoutAt = async (w) => {
      const { page, ctx } = await boot('', {
        viewport: { width: w, height: 800 }, prefs: { welcomeDismissed: true },
      });
      const r = await page.evaluate(() => {
        const ctrl = document.getElementById('controls').getBoundingClientRect();
        const sc = document.getElementById('scope').getBoundingClientRect();
        return sc.top >= ctrl.bottom ? 'stacked' : 'inline';
      });
      await ctx.close();
      return r;
    };
    eq(await layoutAt(640), 'stacked', 'at 640px the scope is stacked');
    eq(await layoutAt(641), 'inline', 'at 641px the scope is inline');
    eq(await layoutAt(1000), 'inline', 'a narrow desktop window is NOT stacked');
  }

  // ── 6c. fitBar() must converge, not oscillate ─────────────────────────────
  // Measuring a wrapped layout and then writing a width back into it is the
  // shape of a feedback loop, so the fixed point is asserted directly: running
  // it repeatedly must not move the number, and the width it settles on must
  // still be one where every row fits (no extra wrapping, so the bar cannot
  // grow taller on a later pass).
  {
    const { page, ctx } = await boot('', {
      viewport: { width: 1200, height: 800 }, prefs: { welcomeDismissed: true },
    });
    const run = () => page.evaluate(() => {
      // fitBar is module-scoped, so drive it the way the app does.
      window.dispatchEvent(new Event('resize'));
      const c = document.getElementById('controls');
      const bar = document.getElementById('bar').getBoundingClientRect();
      return { w: c.style.width, barH: bar.height,
               rows: new Set([...c.querySelectorAll('.row > *')]
                 .map((e) => Math.round(e.getBoundingClientRect().top))).size };
    });
    const a = await run(), b = await run(), c = await run();
    eq(a.w !== '' , true, 'fitBar pins an explicit controls width');
    eq([b.w, c.w], [a.w, a.w], 'repeated passes settle on the same width');
    eq([b.barH, c.barH], [a.barH, a.barH], 'and the header height does not drift');
    eq([b.rows, c.rows], [a.rows, a.rows], 'and no extra row appears on a later pass');
    await ctx.close();
  }
  {
    // Shrinking the window must not leave the previous (wider) pin in place.
    // fitBar overwrites its own override with the width the column gets on THIS
    // pass before it measures, and this is what proves the stale value is not
    // simply measured again.
    const { page, ctx } = await boot('', {
      viewport: { width: 1600, height: 800 }, prefs: { welcomeDismissed: true },
    });
    const wide = await page.evaluate(() =>
      parseFloat(document.getElementById('controls').style.width) || 0);
    await page.setViewportSize({ width: 900, height: 800 });
    await page.waitForTimeout(200);
    const narrow = await page.evaluate(() => ({
      w: parseFloat(document.getElementById('controls').style.width) || 0,
      overflows: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    }));
    eq(narrow.w < wide, true, 'shrinking the window re-measures rather than keeping the old pin');
    eq(narrow.overflows, false, 'and the bar does not overflow the page');
    await ctx.close();
  }

  // ── 6d. The header must not gain a row for a manual entry, or for a dial ──
  // Every pixel the header takes comes off the terminal, so a second control
  // row on a window with hundreds of spare pixels beside the scope is a real
  // cost, not a cosmetic one.
  //
  // The cause was fitBar measuring at the column's MAX-CONTENT width. That is
  // not the width the row needs on one line — `#dest`'s children are sized in
  // percentages, which contribute nothing to intrinsic width — so the column
  // measured ~140px short, the row wrapped inside the measurement, and the
  // wrapped line became the pin. Any small width change could cross the
  // threshold; the two below are the ones a user actually hits.
  //
  // Asserted as the HEADER HEIGHT before and after, at several wide widths.
  // Height is the thing that matters and the thing that was wrong; row counts
  // and pinned widths are implementation.
  {
    for (const width of [1400, 1600, 1860]) {
      const { page, ctx } = await boot('', {
        viewport: { width, height: 900 }, prefs: { welcomeDismissed: true },
      });
      const barH = () => page.evaluate(() =>
        Math.round(document.getElementById('bar').getBoundingClientRect().height));
      await page.waitForTimeout(250);
      const base = await barH();

      // 1. Swap the dropdown for the manual host:port field.
      await page.click('#bbstoggle');
      await page.waitForTimeout(200);
      eq(await barH(), base, `${width}px: manual entry does not grow the header`);

      // 2. Type into it, then dial — Connect becomes the wider Hang up, and the
      //    heart replaces the "BBS" label. Both move the row's width.
      await page.fill('#hostport', 'test.com:23');
      await page.waitForTimeout(150);
      eq(await barH(), base, `${width}px: typing a destination does not grow it`);
      await page.click('#dial');
      await page.waitForTimeout(400);
      eq(await barH(), base, `${width}px: dialling does not grow it`);

      // 3. A long status line is the one thing that legitimately may — but it
      //    must come back down when the status does.
      await page.evaluate(() => {
        document.getElementById('status').textContent =
          'no answer (getaddrinfo ENOTFOUND test.com)';
        window.dispatchEvent(new Event('resize'));
      });
      await page.waitForTimeout(200);
      eq(await barH(), base, `${width}px: a long status line does not grow it either`);
      await ctx.close();
    }
  }

  // ── 7. Collapsing the scope (mobile long-press) ───────────────────────────
  {
    const { page, ctx } = await boot('', {
      viewport: { width: 390, height: 800 }, prefs: { welcomeDismissed: true },
    });
    const state = () => page.evaluate(() => ({
      collapsed: document.body.classList.contains('scope-collapsed'),
      scopeShown: getComputedStyle(document.getElementById('scope')).display !== 'none',
      stripShown: getComputedStyle(document.getElementById('scope-collapsed')).display !== 'none',
      stored: JSON.parse(localStorage.getItem('synthlink.prefs.v1') || '{}').scopeCollapsed,
      up: document.getElementById('scope-collapsed').classList.contains('up'),
    }));
    let s = await state();
    eq([s.collapsed, s.scopeShown, s.stripShown], [false, true, false], 'scope starts expanded');

    // A short press must NOT collapse — otherwise every stray tap near the
    // scope would hide it. Events are dispatched directly because Playwright's
    // touch helpers cannot hold for a chosen duration.
    const touch = async (ms) => {
      await page.evaluate((hold) => new Promise((done) => {
        const el = document.getElementById('scope');
        const r = el.getBoundingClientRect();
        const t = new Touch({ identifier: 1, target: el,
          clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 });
        const ev = (type, touches) => el.dispatchEvent(
          new TouchEvent(type, { bubbles: true, cancelable: true, touches }));
        ev('touchstart', [t]);
        setTimeout(() => { ev('touchend', []); done(); }, hold);
      }), ms);
      await page.waitForTimeout(80);
    };
    await touch(150);
    eq((await state()).collapsed, false, 'a short press does not collapse');

    await touch(700);   // > SCOPE_HOLD_MS
    s = await state();
    eq(s.collapsed, true, 'a long press collapses the scope');
    eq([s.scopeShown, s.stripShown], [false, true], 'canvas gives way to the strip');
    eq(s.stored, true, 'the collapse is persisted');
    eq(s.up, false, 'with no carrier the strip is grey, not green');

    // Carrier colour. Driven through setLed() rather than a real call, because
    // that is the choke point the strip actually rides on — if someone adds a
    // second place that writes the LED, this stops covering it, which is the
    // point. The shade is the dim green, NOT the bright --green: the strip is a
    // status line, not the thing the eye should go to.
    // The strip transitions its colour, and getComputedStyle mid-transition
    // returns the value it is currently AT, not the target — reading straight
    // after the class flip reports the old grey. Wait the transition out.
    const strip = await page.evaluate(async () => {
      const el = document.getElementById('scope-collapsed');
      const bar = el.querySelector('i');
      const settle = () => new Promise((r) => setTimeout(r, 350));
      await settle();
      const grey = getComputedStyle(bar).backgroundColor;
      el.classList.add('up');
      await settle();
      const green = getComputedStyle(bar).backgroundColor;
      el.classList.remove('up');
      await settle();
      const root = getComputedStyle(document.documentElement);
      return { grey, green,
               bright: root.getPropertyValue('--green').trim() };
    });
    eq(strip.green === strip.bright, false, 'and is not the bright terminal green');
    eq(strip.grey !== strip.green, true, 'no-carrier grey is a different colour');
    // The height matches the page-grab bar's pill, which it is modelled on.
    const pill = await page.evaluate(() =>
      getComputedStyle(document.querySelector('#pagegrab i')).height);
    const stripH = await page.evaluate(() =>
      getComputedStyle(document.querySelector('#scope-collapsed i')).height);
    eq(stripH, pill, 'the strip is drawn at the page-grab bar’s weight');

    // Tap the strip to bring it back.
    await page.click('#scope-collapsed');
    s = await state();
    eq(s.collapsed, false, 'tapping the strip restores the scope');
    eq([s.scopeShown, s.stripShown], [true, false], 'and swaps the two back');
    eq(s.stored, false, 'the restore is persisted too');
    await ctx.close();
  }
  {
    // Persisted collapse is honoured at startup, and the canvas is display:none
    // rather than merely small — the draw loop keys off the same state.
    const { page, ctx, errs } = await boot('', {
      viewport: { width: 390, height: 800 },
      prefs: { welcomed: true, scopeCollapsed: true },
    });
    eq(errs, [], 'collapsed startup: no page errors');
    const s = await page.evaluate(() => ({
      collapsed: document.body.classList.contains('scope-collapsed'),
      scopeDisplay: getComputedStyle(document.getElementById('scope')).display,
    }));
    eq(s.collapsed, true, 'a stored collapse is applied on load');
    eq(s.scopeDisplay, 'none', 'and the canvas is not rendered at all');
    await ctx.close();
  }
  {
    // Desktop keeps its scope: the gesture is mobile-only, and a stored
    // collapse carried over from a phone must not hide it in a desktop window.
    const { page, ctx } = await boot('', {
      viewport: { width: 1440, height: 800 },
      prefs: { welcomed: true, scopeCollapsed: true },
    });
    const shown = await page.evaluate(() =>
      getComputedStyle(document.getElementById('scope')).display !== 'none');
    eq(shown, true, 'desktop shows the scope even with a stored collapse');
    await ctx.close();
  }

  // ── 8. The guide-link entry in the BBS dropdown ───────────────────────────
  {
    const { page, ctx } = await boot('', { prefs: { welcomeDismissed: true } });
    const info = await page.evaluate(() => {
      const sel = document.getElementById('bbs');
      const g = [...sel.querySelectorAll('optgroup')]
        .find((x) => /Telnet BBS Guide/.test(x.label));
      const first = g && g.querySelector('option');
      return {
        hasGroup: !!g,
        firstValue: first && first.value,
        // It must not end up selected, or the page would open naming a
        // destination that does not exist.
        isSelected: sel.value === '@guide',
        host: document.getElementById('host').value,
      };
    });
    eq(info.hasGroup, true, '(precondition) the guide group is rendered');
    eq(info.firstValue, '@guide', 'the link entry heads the guide group');
    eq(info.isSelected, false, 'it is never the selected entry');
    eq(/^@/.test(info.host), false, 'and no sentinel leaked into #host');

    // Selecting it opens the guide and puts the dropdown back on a real board.
    //
    // window.open is stubbed rather than letting a real tab open: the change is
    // dispatched programmatically here, which browsers do not treat as a user
    // gesture, so a genuine popup would be blocked and the test would be
    // asserting the popup blocker rather than the page. The arguments are
    // checked instead — including the noopener, which is what keeps the opened
    // tab from reaching back into this one through window.opener.
    const before = await page.evaluate(() => document.getElementById('bbs').value);
    const after = await page.evaluate(() => {
      const calls = [];
      const realOpen = window.open;
      window.open = (...a) => { calls.push(a); return null; };
      const sel = document.getElementById('bbs');
      sel.value = '@guide';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      window.open = realOpen;
      return {
        calls,
        value: sel.value,
        host: document.getElementById('host').value,
        port: document.getElementById('port').value,
      };
    });
    eq(after.calls.length, 1, 'selecting it opens exactly one window');
    eq(/^https:\/\/(www\.)?telnetbbsguide\.com\//.test(after.calls[0][0] || ''), true,
       'pointed at the guide over https');
    eq(after.calls[0][1], '_blank', 'in a separate tab');
    eq(/noopener/.test(after.calls[0][2] || ''), true, 'with noopener set');
    eq(after.value, before, 'the dropdown returns to the previous destination');
    eq(after.value, `${after.host}:${after.port}`, 'and still agrees with #host/#port');
    await ctx.close();
  }

  // ── 9. The terminal is re-fitted when the header's height settles ────────
  // The bug: on a desktop landscape first load the terminal came up smaller
  // than the space allowed, with dead margin around it, and snapped to the
  // right size on the first window resize. The header is not at its final
  // height when fitTerminal() first runs — the status line, the dropdown and
  // the font metrics all land later and can re-wrap the control rows — and a
  // resize was the only thing that re-ran the fit.
  //
  // Asserted two ways. The first — the loaded size equals the size a resize
  // would produce — is the symptom as the user sees it, but it is a weak guard
  // here: headless, the header settles inside the boot wait, so it passes even
  // with the fix removed. The second is the one with teeth: force the bar
  // taller and the terminal must give the height back with no window resize
  // involved. Verified by removing the fix and watching only that one fail.
  {
    const { page, ctx } = await boot('', { prefs: { welcomeDismissed: true } });
    const box = () => page.evaluate(() => {
      const r = document.getElementById('terminal-canvas').getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    });
    const onLoad = await box();
    // A no-op "resize": same viewport, but the resize handler runs. Whatever it
    // computes is by definition the correct fit for this layout.
    await page.setViewportSize({ width: 1101, height: 700 });
    await page.setViewportSize({ width: 1100, height: 700 });
    await page.waitForTimeout(200);
    const afterResize = await box();
    eq(onLoad, afterResize, 'the terminal loads at the size a resize would give it');
    eq(onLoad.w > 0 && onLoad.h > 0, true, 'and it is actually laid out');

    // Mechanism: grow the header and the terminal must give height back.
    const grew = await page.evaluate(async () => {
      const bar = document.getElementById('bar');
      const c = document.getElementById('terminal-canvas');
      const before = c.getBoundingClientRect().height;
      const beforeBar = bar.getBoundingClientRect().height;
      bar.style.paddingBottom = '80px';
      await new Promise((r) => setTimeout(r, 250));
      return { before, beforeBar,
               after: c.getBoundingClientRect().height,
               afterBar: bar.getBoundingClientRect().height };
    });
    eq(grew.afterBar > grew.beforeBar, true, 'the header really did grow');
    eq(grew.after < grew.before, true,
       'the terminal shrank to fit it, with no window resize involved');
    await ctx.close();
  }

  // ── 10. The favourite heart is live from the moment dialling starts ──────
  // It used to appear on carrier, which meant a board that never answered — or
  // one you decided about while listening to it ring — could not be kept.
  {
    const { page, ctx } = await boot('', { prefs: { welcomeDismissed: true } });
    const shown = () => page.evaluate(() => ({
      heart: !document.getElementById('favbtn').hidden,
      label: !document.getElementById('bbslabel').hidden,
    }));
    eq(await shown(), { heart: false, label: true }, 'idle: the "BBS" label, no heart');
    await page.click('#dial');                 // dials into the WebSocket recorder
    await page.waitForTimeout(200);
    eq(await shown(), { heart: true, label: false },
       'dialling: the heart replaces the label before any carrier');
    // And it still favourites the right destination.
    const stored = await page.evaluate(() => {
      document.getElementById('favbtn').click();
      return JSON.parse(localStorage.getItem('synthlink.prefs.v1') || '{}').favorites;
    });
    eq(Array.isArray(stored) && stored.length, 1, 'clicking it stores one favourite');
    eq(stored[0].host, await page.evaluate(() => document.getElementById('host').value),
       'and it is the board being dialled');
    await ctx.close();
  }

  // ── 11. Mobile uses the FULL width, on every font ─────────────────────────
  // A phone has no width to spare, so the terminal takes all of it: fitTerminal
  // sets no margin on mobile precisely so that it can. It did not, and the
  // reason is worth keeping because nothing about it looks like a width bug.
  //
  // fitTerminal computed an aspect-preserving height for the width it wanted,
  // floored that height to whole device pixels, and handed the pair to
  // `layout()` as the available box. But layout() derives the height itself
  // (§3.4/§3.4a: width drives, the available height clamps) — so the floored
  // height came back as a height CONSTRAINT, and layout narrowed the terminal
  // to keep the aspect against it. A fraction of a device pixel of height,
  // rounded away, cost two device pixels of width. Then the CSS box was floored
  // again on the way out, which at a fractional dpr gave away up to a whole CSS
  // pixel more and made the browser resample the canvas on top of it (§3.1).
  //
  // Both errors are sub-pixel per step and neither is visible in a screenshot;
  // what shows is a hairline of page background down the screen edge. So this
  // asserts the ARITHMETIC, at the tightest bound the snap allows: the terminal
  // must reach within one DEVICE pixel of the available width. One CSS pixel of
  // slack would have passed the bug.
  {
    // The 80-column fonts are the subject — 40-column mode is the same code but
    // kinder arithmetic, and it happened to land on the full width already,
    // which is exactly why the defect read as "the 80-column fonts are short".
    // It is in the list as the control.
    const FONTS = ['astpx8x19', 'flexi135', 'vga9x14px'];
    // A whole dpr and two fractional ones. 390x844 is an iPhone 14; 412x915 at
    // 2.625 is a Pixel, and is the case the old code lost two pixels on.
    const DEVICES = [
      { width: 390, height: 844, dpr: 3 },
      { width: 412, height: 915, dpr: 2.625 },
      { width: 393, height: 852, dpr: 2.75 },
    ];
    for (const d of DEVICES) {
      for (const fontId of FONTS) {
        const { page, ctx } = await boot('', {
          prefs: { welcomeDismissed: true, fontId },
          viewport: { width: d.width, height: d.height },
          dpr: d.dpr,
        });
        // The outline atlas is built asynchronously and the fit re-runs when it
        // lands, so read after it has.
        await page.waitForTimeout(400);
        const m = await page.evaluate(() => {
          const c = document.getElementById('terminal-canvas');
          const wrap = document.getElementById('wrap');
          return {
            cssW: c.getBoundingClientRect().width,
            availW: wrap.clientWidth,
            backingW: c.width,
            dpr: window.devicePixelRatio,
          };
        });
        const tag = `${d.width}@${d.dpr} ${fontId}`;
        ok(m.availW === d.width, `${tag}: the terminal's box is the full viewport width`);
        ok((m.availW - m.cssW) * m.dpr < 1,
           `${tag}: the terminal fills it to within a device pixel ` +
           `(short by ${((m.availW - m.cssW) * m.dpr).toFixed(2)} device px)`);
        // And the backing store still matches what is displayed — the snap is
        // only worth having if the browser is not resampling it away (§3.1).
        // Half a device pixel, not zero: a CSS length is quantised twice on the
        // way to this reading (main.js writes it to three decimals, the engine
        // then snaps to its own 1/64 px layout unit), so an exact equality here
        // would be asserting the engine's arithmetic rather than ours. The
        // failure this guards is a WHOLE pixel of disagreement, which is what a
        // floor on either side produces.
        const skew = Math.abs(m.backingW - m.cssW * m.dpr);
        ok(skew < 0.5,
           `${tag}: backing store still equals the displayed box ` +
           `(off by ${skew.toFixed(3)} device px)`);
        await ctx.close();
      }
    }
  }

  // ── 12. The directory panel behind the "BBS" label ───────────────────────
  // Three actions, all asserted by what they change elsewhere: favouriting
  // writes the same list the heart writes, and Random both moves the
  // destination AND dials it. The guide button opens a search and is offered
  // unconditionally, so there is no condition left to assert about it — the
  // label is prose and deliberately not tested.
  {
    const { page, ctx } = await boot('', { prefs: { welcomeDismissed: true } });
    const open = async () => { await page.click('#bbslabel'); await page.waitForTimeout(50); };
    const vis = (id) => page.evaluate((i) => !document.getElementById(i).hidden, id);

    eq(await vis('bbsmodal'), false, 'the panel starts closed');
    await open();
    eq(await vis('bbsmodal'), true, 'clicking the "BBS" label opens it');

    // Offered for a curated board too — a guide-listed board reached through
    // Favorites or Featured is the same board, and the search is what decides
    // whether it is listed, not the tier it was picked from.
    eq(await vis('bbsguide'), true, 'the guide search is offered for any board');

    // Escape closes, like the other panels.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(50);
    eq(await vis('bbsmodal'), false, 'Escape closes it');

    // Favourite through the panel: same stored list as the heart writes.
    await open();
    await page.click('#bbsfav');
    await page.waitForTimeout(50);
    const host = await page.evaluate(() => document.getElementById('host').value);
    const favs = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('synthlink.prefs.v1') || '{}').favorites);
    eq(Array.isArray(favs) && favs.length, 1, 'the panel favourites the board');
    eq(favs[0].host, host, 'and it stores the destination that was selected');
    eq(await vis('bbsmodal'), false, 'acting on it closes it');
    // Re-opening offers the inverse, so the one button is a true toggle.
    await open();
    await page.click('#bbsfav');
    await page.waitForTimeout(50);
    eq((await page.evaluate(() =>
      JSON.parse(localStorage.getItem('synthlink.prefs.v1') || '{}').favorites)).length, 0,
       'and a second press removes it again');

    // Random adopts a real destination — never the sentinel, which is the bug
    // the dropdown's own Random path exists to avoid too — and then DIALS it,
    // which is the whole difference between this button and that option. The
    // dial is read from the WebSocket recorder, so what is asserted is that a
    // call was actually placed to the board that was drawn.
    await open();
    await page.click('#bbsrandom');
    await page.waitForTimeout(250);
    const after = await page.evaluate(() => ({
      host: document.getElementById('host').value,
      port: document.getElementById('port').value,
      sel: document.getElementById('bbs').value,
      dials: window.__dials.length,
      sent: window.__sent.map((d) => { try { return JSON.parse(d); } catch (_) { return null; } })
                          .filter(Boolean),
    }));
    ok(after.host && after.host !== '@random', 'Random adopts a real host');
    eq(after.sel, `${after.host}:${after.port}`,
       'and the dropdown is left naming it, not the sentinel');
    eq(after.dials, 1, 'and it dials straight away, without a second press');
    const dialled = after.sent.find((m) => m.host);
    eq(dialled && dialled.host, after.host, 'the call goes to the board that was drawn');
    await ctx.close();
  }

  // ── 13. Alt shortcuts drive the real buttons ─────────────────────────────
  // Asserted through the STATE each toggle owns, not through the button's
  // classes: the point of routing these through .click() is that a shortcut
  // and a press are indistinguishable afterwards, and only the state each
  // handler persists can show that.
  {
    const { page, ctx } = await boot('', { prefs: { welcomeDismissed: true, zoomLevel: 0 } });
    const prefs = () => page.evaluate(() =>
      JSON.parse(localStorage.getItem('synthlink.prefs.v1') || '{}'));
    const kbdOpen = () => page.evaluate(() => !document.getElementById('keyboard').hidden);

    eq(await kbdOpen(), false, 'the on-screen keyboard starts closed');
    await page.keyboard.press('Alt+KeyK');
    await page.waitForTimeout(80);
    eq(await kbdOpen(), true, 'Alt+K opens it');
    await page.keyboard.press('Alt+KeyK');
    await page.waitForTimeout(80);
    eq(await kbdOpen(), false, 'and Alt+K closes it again');

    const font0 = (await prefs()).fontId;
    await page.keyboard.press('Alt+KeyA');
    await page.waitForTimeout(120);
    ok((await prefs()).fontId !== font0, 'Alt+A advances the font cycle');

    // Desktop boots with scrollback ON, which SUPPRESSES zoom and disables its
    // button — so Alt+Z must do nothing, exactly as a press does nothing. This
    // is the case that would break if the shortcut called the handler directly
    // instead of clicking the control.
    const zoom0 = (await prefs()).zoomLevel;
    await page.keyboard.press('Alt+KeyZ');
    await page.waitForTimeout(80);
    eq((await prefs()).zoomLevel, zoom0, 'Alt+Z is inert while the button is disabled');
    // Turn scrollback off and it works.
    await page.click('#scrolltoggle');
    await page.keyboard.press('Alt+KeyZ');
    await page.waitForTimeout(80);
    ok((await prefs()).zoomLevel !== zoom0, 'and it cycles once zoom is reachable');

    const spk0 = (await prefs()).speaker;
    await page.keyboard.press('Alt+KeyM');
    await page.waitForTimeout(80);
    ok((await prefs()).speaker !== spk0, 'Alt+M cycles the speaker');

    // Alt+C and Alt+X are one button between them — #dial is a toggle — so each
    // is gated on the call state. The gate is the point: Alt+C during a call
    // must NOT hang it up, which is what a second click of that button does.
    const dials = () => page.evaluate(() => window.__dials.length);
    eq(await dials(), 0, 'no call has been placed yet');
    await page.keyboard.press('Alt+KeyX');
    await page.waitForTimeout(120);
    eq(await dials(), 0, 'Alt+X is inert with no call up');
    await page.keyboard.press('Alt+KeyC');
    await page.waitForTimeout(250);
    eq(await dials(), 1, 'Alt+C dials');
    await page.keyboard.press('Alt+KeyC');
    await page.waitForTimeout(250);
    eq(await dials(), 1, 'Alt+C during a call does nothing — it never hangs up');
    await page.keyboard.press('Alt+KeyX');
    await page.waitForTimeout(250);
    await page.keyboard.press('Alt+KeyC');
    await page.waitForTimeout(250);
    eq(await dials(), 2, 'Alt+X hung up, so Alt+C can dial again');
    await page.keyboard.press('Alt+KeyX');
    await page.waitForTimeout(250);

    // A TEXT FIELD keeps its own Alt keys: on macOS Alt+<letter> composes a
    // character, and stealing it inside the host:port box would be a bug. The
    // two assertions above already covered the other half of this rule — they
    // run with a toolbar button focused, which is where a broader "is this a
    // form control" test would have killed the shortcut outright.
    await page.click('#bbstoggle');                     // switch to manual entry
    await page.click('#hostport');
    const before = await kbdOpen();
    await page.keyboard.press('Alt+KeyK');
    await page.waitForTimeout(80);
    eq(await kbdOpen(), before, 'Alt+K is left alone while a field has focus');
    await ctx.close();
  }

  // ── 14. The scrollback button says OFF, not merely "not lit" ─────────────
  // The class is the assertion because it is what the shared prohibition-sign
  // rule in index.html selects on; the sign itself is drawn in pseudo-elements
  // that have no other observable.
  {
    const { page, ctx } = await boot('', { prefs: { welcomeDismissed: true } });
    const off = () => page.evaluate(() =>
      document.querySelector('#scrolltoggle .kbdicon').classList.contains('off'));
    eq(await off(), false, 'scrollback on: no sign');
    await page.click('#scrolltoggle');
    eq(await off(), true, 'scrollback off: the crossed-out sign appears');
    await page.click('#scrolltoggle');
    eq(await off(), false, 'and it goes away again');
    await ctx.close();
  }

  // ── 15. A narrow terminal must not shrink the keys past legibility ───────
  // 40-column mode in mobile landscape: height binds, so the terminal comes out
  // far narrower than the screen, and the keyboard used to follow it down until
  // a 4-character label no longer fitted its button. The floor lets the
  // keyboard be wider than the terminal instead. `width:100%` is what keeps
  // that from overflowing, so the viewport bound is asserted too.
  {
    const { page, ctx } = await boot('', {
      viewport: { width: 740, height: 360 },            // phone, landscape
      prefs: { welcomeDismissed: true, fontId: 'vga9x14px', kbdOpen: true },
    });
    await page.waitForTimeout(400);   // outline atlas + the hybrid settle
    const m = await page.evaluate(() => {
      const kb = document.getElementById('keyboard');
      const row = kb.querySelector('.krow');
      const keys = row ? row.querySelectorAll('.kbk') : [];
      return {
        kbW: kb.getBoundingClientRect().width,
        termW: document.getElementById('terminal-canvas').getBoundingClientRect().width,
        keyW: keys.length ? keys[0].getBoundingClientRect().width : 0,
        nKeys: keys.length,
        viewW: document.documentElement.clientWidth,
      };
    });
    ok(m.nKeys >= 10, `the letter row rendered (${m.nKeys} keys)`);
    ok(m.keyW >= 28, `keys keep a legible width (${m.keyW.toFixed(1)}px each, `
       + `terminal ${m.termW.toFixed(0)}px wide)`);
    ok(m.kbW <= m.viewW + 0.5,
       `and the keyboard still fits the viewport (${m.kbW.toFixed(0)} <= ${m.viewW})`);
    await ctx.close();
  }

  // ── 16. Hang up during the dial actually stops the dial ──────────────────
  // The dial sequence is ~3 s of audio scheduled onto the audio clock in ONE
  // call, and the modem starts from a promise that resolves when it finishes.
  // So the assertion is about what reaches the socket: a call hung up mid-dial
  // must never send its `dial` message. The positive control runs first, so a
  // pass cannot come from dialling being broken outright.
  {
    const { page, ctx } = await boot('', { prefs: { welcomeDismissed: true } });
    const dialMsgs = async () => page.evaluate(() => (window.__sent || [])
      .map((d) => { try { return JSON.parse(d); } catch (_) { return null; } })
      .filter((m) => m && m.type === 'dial').length);

    await page.click('#dial');                       // Connect
    await page.waitForTimeout(4500);                 // longer than the dial sequence
    ok(await dialMsgs() >= 1, 'control: a call left undisturbed does send its dial');

    await page.click('#dial');                       // Hang up
    await page.waitForTimeout(200);
    await page.evaluate(() => { window.__sent.length = 0; });

    await page.click('#dial');                       // Connect again
    await page.waitForTimeout(400);                  // mid-dial: tones scheduled, promise pending
    await page.click('#dial');                       // Hang up
    await page.waitForTimeout(4500);                 // let the old promise resolve
    eq(await dialMsgs(), 0, 'a call hung up mid-dial never sends its dial message');

    // The stale socket's close must not tear down the call that replaced it.
    // A real close is asynchronous, so hanging up and immediately redialling
    // lands the OLD socket's onclose inside the NEW call. Without a per-call
    // guard that runs cleanup() over a live call: the button falls back to
    // "Connect" with the call still going.
    // #dial is a toggle, so establish a live call first, THEN hang up and
    // redial in the same tick.
    await page.evaluate(() => { window.__sent.length = 0; });
    await page.click('#dial');                       // Connect (call to be replaced)
    await page.waitForTimeout(300);
    eq(await page.evaluate(() => document.getElementById('dial').textContent), 'Hang up',
       'a call is live before the redial race');
    await page.evaluate(() => {
      const b = document.getElementById('dial');
      b.click();                                     // Hang up  — schedules the old onclose
      b.click();                                     // Connect  — new call, same tick
    });
    await page.waitForTimeout(300);                  // the stale onclose fires in here
    eq(await page.evaluate(() => document.getElementById('dial').textContent), 'Hang up',
       'a stale close does not tear down the call that replaced it');
    await page.waitForTimeout(4500);
    ok(await dialMsgs() >= 1, 'and that redial still reaches its dial');
    await ctx.close();
  }

  // ── 17. Desktop: a mouse press on the terminal zooms ─────────────────────
  // The magnifier used to be reachable only from touchstart, so a mouse had no
  // gesture that could open it. Asserted through the transform the zoom applies,
  // and through the exclusivity rule still holding: with scrollback on, zoom is
  // suppressed and a press must do nothing.
  {
    const { page, ctx } = await boot('', { prefs: { welcomeDismissed: true, zoomLevel: 0 } });
    const transform = () => page.evaluate(() =>
      document.getElementById('terminal-canvas').style.transform || '');
    const press = async () => {
      const b2 = await page.evaluate(() => {
        const r = document.getElementById('terminal-canvas').getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      await page.mouse.move(b2.x, b2.y);
      await page.mouse.down();
      await page.waitForTimeout(80);
    };
    // Scrollback defaults ON on desktop, so zoom starts suppressed.
    await press();
    eq(await transform(), '', 'with scrollback on, a mouse press does not zoom');
    await page.mouse.up();

    await page.click('#scrolltoggle');          // release zoom
    await page.click('#zoomtoggle');            // 2x
    await press();
    ok(/scale\(/.test(await transform()), 'with zoom armed, a mouse press zooms');
    await page.mouse.up();
    await page.waitForTimeout(50);
    eq(await transform(), '', 'and releasing the button closes the magnifier');
    await ctx.close();
  }

  // ── 18. Desktop scroll rail ──────────────────────────────────────────────
  // Driven off the ring, not off an overflowing element — there isn't one. Built
  // only from real user paths: typing at the AT command line echoes through
  // termEcho(), which is one of the three paths that must keep the rail current.
  {
    const { page, ctx } = await boot('', { prefs: { welcomeDismissed: true } });
    const railActive = () => page.evaluate(() =>
      document.getElementById('scrollrail').classList.contains('active'));
    const thumbTop = () => page.evaluate(() =>
      parseFloat(document.getElementById('scrollthumb').style.top || '0'));

    ok(!(await railActive()), 'no history yet, so no rail');

    await page.click('#terminal-canvas');
    for (let i = 0; i < 45; i++) await page.keyboard.type('AT\r');   // 2 lines each
    await page.waitForTimeout(200);
    ok(await railActive(), 'output past a screenful brings the rail up');

    const atLive = await thumbTop();
    await page.mouse.move(200, 300);
    for (let i = 0; i < 12; i++) await page.mouse.wheel(0, -120);     // scroll back
    await page.waitForTimeout(200);
    ok(await thumbTop() < atLive,
       `scrolling back moves the thumb up the rail (${atLive} -> ${await thumbTop()})`);

    // The rail belongs to scrollback, so it goes when scrollback does.
    await page.click('#scrolltoggle');
    await page.waitForTimeout(120);
    ok(!(await railActive()), 'and switching scrollback off takes the rail with it');
    await ctx.close();
  }

  // ── 19. scrollbackLines reaches the browser ──────────────────────────────
  // config/site.json -> lib/site.js -> {{SCROLLBACK}} meta -> term.MAX_SCROLLBACK.
  // The tag going missing is the regression that happened, and it made the
  // setting silently do nothing, which is worse than not having it. (The
  // assignment itself is not asserted here: `term` is deliberately not exposed
  // on window, and a production hook for a test is the wrong trade.)
  {
    const { page, ctx } = await boot('', { prefs: { welcomeDismissed: true } });
    const meta = await page.evaluate(() =>
      (document.querySelector('meta[name="app-scrollback"]') || {}).content);
    ok(meta !== undefined && meta !== null && meta !== '',
       'the page carries an app-scrollback meta tag');
    ok(/^\d+$/.test(String(meta)),
       `and it carries a substituted number, not the raw token (got ${JSON.stringify(meta)})`);
    await ctx.close();
  }

  // ── 20. Guide sort order ─────────────────────────────────────────────────
  // The three sort entries are options that ACT and then put the dropdown back,
  // the same trick the guide link uses. Three things have to hold and only one
  // of them is the sorting itself: the order must actually change, the choice
  // must survive as a preference, and — the one that would be a real bug — the
  // sentinel must never reach #host, which is one step away from renderBBS()'s
  // "adopt what's displayed" branch.
  //
  // Only the guide tier moves. Featured is the order config/curated.txt is
  // written in, which is somebody's deliberate choice.
  {
    const SORTDIR = {
      curated: [{ name: 'Zeta Featured', host: 'z.example.org', port: 23 },
                { name: 'Alpha Featured', host: 'af.example.org', port: 23 }],
      guide: [
        { name: 'Alpha', host: 'a.example.org', port: 23, added: '2026-01-01' },
        { name: 'Bravo', host: 'b.example.org', port: 23, added: '2026-03-01' },
        { name: 'Charlie', host: 'c.example.org', port: 23, added: '2026-02-01' },
      ],
      stats: { total: 10, counts: { 'b.example.org:23': 9, 'a.example.org:23': 1 } },
    };
    const guideOrder = (page) => page.evaluate(() => [...document.getElementById('bbs').options]
      .filter((o) => o.dataset.hp && !/Featured/.test(o.dataset.name || ''))
      .map((o) => o.dataset.name));
    const featuredOrder = (page) => page.evaluate(() => [...document.getElementById('bbs').options]
      .filter((o) => /Featured/.test(o.dataset.name || '')).map((o) => o.dataset.name));
    const dest = (page) => page.evaluate(() => [document.getElementById('host').value,
                                                document.getElementById('bbs').value]);

    const { page, ctx, errs } = await boot('', {
      prefs: { welcomeDismissed: true }, directory: SORTDIR,
    });
    eq(errs, [], 'guide sort: no page errors');
    eq(await guideOrder(page), ['Alpha', 'Bravo', 'Charlie'],
       'guide sort: alphanumeric is the default order');

    const sorts = await page.evaluate(() => [...document.getElementById('bbs').options]
      .filter((o) => o.value.startsWith('@sort-')).map((o) => o.value));
    eq(sorts.length, 3, 'guide sort: three sort entries offered');

    // Sit on a real board first, so the restore has something to restore.
    await page.selectOption('#bbs', 'c.example.org:23');
    eq((await dest(page))[0], 'c.example.org', 'guide sort: a board can be selected');

    await page.selectOption('#bbs', '@sort-dialed');
    await page.waitForTimeout(100);
    eq(await guideOrder(page), ['Bravo', 'Alpha', 'Charlie'],
       'guide sort: most dialed first, ties alphabetical');
    eq(await dest(page), ['c.example.org', 'c.example.org:23'],
       'guide sort: the selected board survives the reorder, and no sentinel is adopted');
    eq(await featuredOrder(page), ['Zeta Featured', 'Alpha Featured'],
       'guide sort: the Featured tier keeps its file order');

    await page.selectOption('#bbs', '@sort-new');
    await page.waitForTimeout(100);
    eq(await guideOrder(page), ['Bravo', 'Charlie', 'Alpha'],
       'guide sort: newest first, by the date we first saw each board');
    eq((await dest(page))[0], 'c.example.org', 'guide sort: destination still intact');

    const stored = await page.evaluate((k) =>
      JSON.parse(localStorage.getItem(k) || '{}').guideSort, PREFS_KEY);
    eq(stored, 'newest', 'guide sort: the choice is remembered');

    await page.selectOption('#bbs', '@sort-alpha');
    await page.waitForTimeout(100);
    eq(await guideOrder(page), ['Alpha', 'Bravo', 'Charlie'], 'guide sort: and back again');
    await ctx.close();
  }

  // 20b. A stored order is applied on the next load, before anything is clicked.
  {
    const SORTDIR = {
      curated: [],
      guide: [{ name: 'Alpha', host: 'a.example.org', port: 23, added: '2026-01-01' },
              { name: 'Bravo', host: 'b.example.org', port: 23, added: '2026-03-01' }],
      stats: { total: 0, counts: {} },
    };
    const { page, ctx } = await boot('', {
      prefs: { welcomeDismissed: true, guideSort: 'newest' }, directory: SORTDIR,
    });
    const names = await page.evaluate(() => [...document.getElementById('bbs').options]
      .filter((o) => o.dataset.hp).map((o) => o.dataset.name));
    eq(names, ['Bravo', 'Alpha'], 'guide sort: a stored order is applied on load');
    await ctx.close();
  }

  // ── 21. Mouse selection, and who is allowed to claim a press ───────────────
  // clicktest covers the geometry and the predicates; what needs a real browser
  // is the arbitration — that zoom keeps the drag while it is on, that a mobile
  // viewport claims nothing at all, and that the canvas ends up focused so
  // typing goes down the canvas keydown path rather than the window fallback.
  {
    const { page, ctx } = await boot('', { prefs: { welcomeDismissed: true } });
    const box = await page.evaluate(() => {
      const r = document.getElementById('terminal-canvas').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });

    // Scrollback defaults on for desktop, which suppresses zoom (they are
    // mutually exclusive), so selection is the action that should claim it.
    await page.mouse.move(box.x, box.y);
    await page.mouse.down();
    await page.mouse.move(box.x + 60, box.y + 20);
    await page.mouse.up();
    const focused = await page.evaluate(() => document.activeElement &&
      document.activeElement.id);
    eq(focused, 'terminal-canvas', 'select: a click leaves the canvas focused');

    // Turn zoom on (which turns scrollback off) and the magnifier takes the
    // press back — the canvas transform is how that shows from out here.
    await page.evaluate(() => document.getElementById('scrolltoggle').click());
    await page.evaluate(() => document.getElementById('zoomtoggle').click());
    const zoomOn = await page.evaluate(() =>
      !document.getElementById('zoomtoggle').classList.contains('off'));
    if (zoomOn) {
      await page.mouse.move(box.x, box.y);
      await page.mouse.down();
      const scaled = await page.evaluate(() => {
        const t = getComputedStyle(document.getElementById('terminal-canvas')).transform;
        return t && t !== 'none';
      });
      await page.mouse.up();
      ok(scaled, 'select: with zoom enabled the magnifier claims the press instead');
    }
    await ctx.close();
  }

  // 21b. SELECTION claims nothing on a phone. Note what this cannot assert: a
  // phone defaults to scrollback off, which leaves zoom enabled, and zoom
  // legitimately claims the press — so "nothing claims it" is false there and
  // was the wrong assertion. Zoom is switched off first (two presses of the
  // 2x/3x/off cycle), which on a DESKTOP is exactly the state §21 just showed
  // selection claiming. Same state, different viewport, opposite answer, and
  // that difference is the whole of the mobile gate.
  {
    const { page, ctx } = await boot('', {
      prefs: { welcomeDismissed: true }, viewport: { width: 400, height: 780 },
    });
    await page.evaluate(() => {
      document.getElementById('zoomtoggle').click();
      document.getElementById('zoomtoggle').click();
    });
    // The crossed-out marker lives on the .zoomicon span, not the button.
    ok(await page.evaluate(() =>
      document.querySelector('#zoomtoggle .zoomicon').classList.contains('off')),
      'select: zoom really is off for the mobile check');
    const claimed = await page.evaluate(() => {
      const c = document.getElementById('terminal-canvas');
      const r = c.getBoundingClientRect();
      const e = new MouseEvent('mousedown', {
        bubbles: true, cancelable: true, button: 0,
        clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
      });
      c.dispatchEvent(e);
      return e.defaultPrevented;      // the press path preventDefaults what it claims
    });
    eq(claimed, false, 'select: a synthetic tap on a phone is not a selection');
    await ctx.close();
  }

  // ── 21c. The click that brings the window back only focuses ───────────────
  // A click on empty screen is Enter, which is what a BBS pager wants. But the
  // click that brings the window back from another application means "I am
  // looking at this again", and spending a keystroke on it is a surprise — so
  // that one focuses and stops. A carrier makes both cases observable: with the
  // modem bypassed, whatever is sent goes out on the socket as a binary frame.
  {
    const { page, ctx } = await boot('', {
      prefs: { welcomeDismissed: true }, answerConnected: true,
    });
    await page.selectOption('#protocol', 'direct');
    await page.click('#dial');
    await page.waitForTimeout(400);
    const binaryCount = () => page.evaluate(() =>
      (window.__sent || []).filter((d) => typeof d !== 'string').length);
    await page.evaluate(() => { window.__sent.length = 0; });

    const box = await page.evaluate(() => {
      const r = document.getElementById('terminal-canvas').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });

    // An ordinary click on empty screen: one Enter.
    await page.mouse.click(box.x, box.y);
    await page.waitForTimeout(50);
    eq(await binaryCount(), 1, 'refocus: a click on empty screen sends Enter');

    // The same click, but the window has just come back. Nothing goes out.
    await page.evaluate(() => { window.__sent.length = 0; });
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.mouse.click(box.x + 24, box.y + 16);
    await page.waitForTimeout(50);
    eq(await binaryCount(), 0, 'refocus: the click that brought the window back does not');

    // And it is consumed, not sticky — the NEXT click is an ordinary one again.
    await page.mouse.click(box.x + 48, box.y + 32);
    await page.waitForTimeout(50);
    eq(await binaryCount(), 1, 'refocus: only that one click is swallowed');
    await ctx.close();
  }

  // ── 21d. A click that lands ON a character sends nothing ──────────────────
  // The near miss. Clicking a menu key is easy to get slightly wrong — the
  // bracket beside it, the next letter along — and answering that with Enter
  // hands the menu a choice the user did not make. So Enter is for BLANK screen
  // only; a character that is not itself a menu key is simply not a target.
  {
    const { page, ctx } = await boot('', {
      prefs: { welcomeDismissed: true }, answerConnected: true,
    });
    await page.selectOption('#protocol', 'direct');
    await page.click('#dial');
    await page.waitForTimeout(400);

    // The recorder echoes, so anything sent comes back as terminal output. The
    // screen is CLEARED first and homed — a live call has already printed its
    // connect banner, so row 0 is not empty and text typed onto it would land
    // somewhere this test cannot predict. The paste box is the way to send an
    // escape sequence through the ordinary UI.
    await page.evaluate(() => {
      const c = document.getElementById('terminal-canvas');
      c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    await page.fill('#pastetext', '\x1b[2J\x1b[H[L]ogin');
    await page.click('#pastesend');
    // Past REFOCUS_MS: the window focus that came with page load would make the
    // very next click a focusing one, which is §21c's rule doing its job.
    // Waiting it out is what leaves an ordinary click to measure.
    await page.waitForTimeout(900);

    const cell = (col, rowN) => page.evaluate(([c, r]) => {
      const canvas = document.getElementById('terminal-canvas');
      const box = canvas.getBoundingClientRect();
      // Cell pitch in CSS pixels, from the backing store the renderer sized.
      const w = box.width / 80, h = box.height / 25;
      return { x: box.left + (c + 0.5) * w, y: box.top + (r + 0.5) * h };
    }, [col, rowN]);

    const binaryCount = () => page.evaluate(() =>
      (window.__sent || []).filter((d) => typeof d !== 'string').length);
    const clickAt = async (col, rowN) => {
      await page.evaluate(() => { window.__sent.length = 0; });
      const p = await cell(col, rowN);
      await page.mouse.click(p.x, p.y);
      await page.waitForTimeout(80);
      return binaryCount();
    };

    eq(await clickAt(1, 0), 1, 'near miss: the menu key itself still sends');
    eq(await clickAt(0, 0), 0, 'near miss: the bracket beside it sends nothing');
    eq(await clickAt(4, 0), 0, 'near miss: the "o" of Login sends nothing');
    eq(await clickAt(40, 0), 1, 'near miss: blank screen on the same row is Enter');
    eq(await clickAt(20, 10), 1, 'near miss: and an untouched row is Enter');
    await ctx.close();
  }

  // ── 22. The paste box ──────────────────────────────────────────────────────
  // Right-click over the terminal opens it instead of the browser menu, the
  // textarea takes focus (it is the mechanism — a real paste target), Escape
  // closes it and the keyboard goes back to the terminal. With no carrier it
  // says so, because what you type there reaches the AT command line instead.
  {
    const { page, ctx } = await boot('', { prefs: { welcomeDismissed: true } });
    const hidden = () => page.evaluate(() =>
      document.getElementById('pastemodal').hasAttribute('hidden'));

    eq(await hidden(), true, 'paste: closed to begin with');

    const prevented = await page.evaluate(() => {
      const c = document.getElementById('terminal-canvas');
      const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      c.dispatchEvent(e);
      return e.defaultPrevented;
    });
    eq(prevented, true, 'paste: the canvas context menu is claimed');
    eq(await hidden(), false, 'paste: right-click opens the box');
    eq(await page.evaluate(() => document.activeElement.id), 'pastetext',
       'paste: the textarea has focus, ready for a native Ctrl+V');
    ok((await page.textContent('#pastenote')).includes('command line'),
       'paste: with no carrier it says where the text will go');

    await page.keyboard.press('Escape');
    eq(await hidden(), true, 'paste: Escape closes it');
    eq(await page.evaluate(() => document.activeElement.id), 'terminal-canvas',
       'paste: and hands the keyboard back to the terminal');

    // Cancel discards rather than sends, and the box does not keep what was
    // typed into it — a clipboard is not something to leave lying around.
    await page.evaluate(() => {
      const c = document.getElementById('terminal-canvas');
      c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    await page.fill('#pastetext', 'ATDT bbs.example.org:23');
    await page.click('#pastecancel');
    eq(await hidden(), true, 'paste: Cancel closes it');
    await page.evaluate(() => {
      const c = document.getElementById('terminal-canvas');
      c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    eq(await page.inputValue('#pastetext'), '', 'paste: it opens empty every time');
    await ctx.close();
  }

  // 22a. The paste box accepts typing WITH A CARRIER UP — the reported bug, and
  // it only exists in that state. A live carrier used to claim every keydown on
  // the page outright, so the textarea stayed empty while what was typed went
  // down the wire. The call is brought up through the modem-bypass path, which
  // is the one route to a carrier that needs no DSP: pick "Telnet · max speed",
  // dial, and let the recorder answer the dial with `connected`.
  {
    const { page, ctx } = await boot('', {
      prefs: { welcomeDismissed: true }, answerConnected: true,
    });
    await page.selectOption('#protocol', 'direct');
    await page.click('#dial');
    await page.waitForFunction(() => document.getElementById('led')
      && document.getElementById('led').className.includes('up'), null, { timeout: 8000 })
      .catch(() => {});
    const up = await page.evaluate(() =>
      (document.getElementById('status') || {}).textContent || '');
    ok(/connected/i.test(up), 'paste: the harness really does have a carrier up');

    await page.evaluate(() => {
      const c = document.getElementById('terminal-canvas');
      c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    // Typed key by key through the real keyboard pipeline, so the window-level
    // handler gets its chance to swallow each one exactly as it did in the bug.
    await page.keyboard.type('ATDT bbs.example.org:23');
    eq(await page.inputValue('#pastetext'), 'ATDT bbs.example.org:23',
       'paste: with a carrier up, every typed character reaches the textarea');

    // Nothing typed into the box leaked down the wire on the way.
    const leaked = await page.evaluate(() => (window.__sent || [])
      .filter((d) => typeof d !== 'string').length);
    eq(leaked, 0, 'paste: and none of it was sent to the BBS instead');

    await page.keyboard.press('Escape');
    // The same line held the manual host:port field shut too, but that field is
    // off screen for the whole of a call, so there is no state in which both can
    // be asserted — the predicate itself is covered by clicktest instead.
    await ctx.close();
  }

  // 22b. On a phone the context menu is left alone — there is no gesture there
  // that could reach a clipboard, so taking the browser's menu away would cost
  // the user something and give nothing back.
  {
    const { page, ctx } = await boot('', {
      prefs: { welcomeDismissed: true }, viewport: { width: 400, height: 780 },
    });
    const prevented = await page.evaluate(() => {
      const c = document.getElementById('terminal-canvas');
      const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      c.dispatchEvent(e);
      return e.defaultPrevented;
    });
    eq(prevented, false, 'paste: a phone keeps its own context menu');
    eq(await page.evaluate(() =>
      document.getElementById('pastemodal').hasAttribute('hidden')), true,
      'paste: and the box stays shut');
    await ctx.close();
  }

  // ── The manual field must never outrank the destination ────────────────────
  //
  // connect() folds the manual host:port field back into #host/#port before it
  // dials (commitHostPort), so if that field is stale it WINS — silently, and
  // after the user has pressed Connect.
  //
  // The reported case: `ATDT some.host` to an address the directory does not
  // carry flips the page into manual mode and leaves the typed address in the
  // field. Choosing a board from the directory afterwards moved #host/#port
  // correctly, and Connect then dialled the typed address anyway.
  //
  // Asserted on the DIAL MESSAGE, which is the only thing that says where the
  // call actually went — every control on the page can look right while the
  // socket goes somewhere else, which is precisely what happened.
  {
    console.log('\n── the destination a control shows is the one that is dialled');
    const { ctx, page } = await boot('', { prefs: { welcomeDismissed: true } });
    await page.waitForTimeout(400);

    // The state an off-directory ATDT leaves behind: manual mode, with the
    // typed address sitting in the field.
    await page.click('#bbstoggle');
    await page.fill('#hostport', 'stale.example.com:23');
    await page.dispatchEvent('#hostport', 'change');
    await page.waitForTimeout(150);

    // Now pick a real board from the directory. The <select> is hidden in manual
    // mode, so this drives its change handler directly — which is the code path
    // the panel and the dropdown both end in, and the one under test.
    const picked = await page.evaluate(() => {
      const sel = document.getElementById('bbs');
      const opt = [...sel.options].find((o) => o.value && /^[^@]+:\d+$/.test(o.value));
      if (!opt) return null;
      sel.value = opt.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return opt.value;
    });
    ok(!!picked, 'the directory offered a board to pick');

    if (picked) {
      const [wantHost, wantPort] = picked.split(':');
      eq(await page.evaluate(() => document.getElementById('hostport').value), picked,
         'choosing a board updates the manual field with it, rather than leaving it stale');

      await page.selectOption('#protocol', 'direct');
      await page.click('#dial');
      await page.waitForTimeout(600);
      const dial = await page.evaluate(() => (window.__sent || [])
        .map((s) => { try { return JSON.parse(s); } catch (_) { return null; } })
        .filter((m) => m && m.type === 'dial')[0] || null);
      eq(dial && [dial.host, String(dial.port)], [wantHost, wantPort],
         'and Connect dials THAT board, not the address left in the field');
    }
    await ctx.close();
  }

  // ── …including the board the dropdown was ALREADY showing ──────────────────
  //
  // The reported reproduction, exactly: the dropdown is sitting on a board,
  // `ATDT` goes to an address the directory does not carry (which flips the page
  // to manual), then back to the directory — where that same board is still
  // displayed — and Connect. It dialled the ATDT address.
  //
  // What makes this its own case rather than a repeat of the one above: the user
  // "picks" the option the <select> is ALREADY on, and a <select> fires no
  // `change` for that. Nothing runs, nothing syncs, and every fix that lives in
  // the change handler misses it. Picking a DIFFERENT board worked, which is
  // what pointed at the missing event.
  {
    console.log('\n── re-picking the board already displayed still dials it');
    const { ctx, page } = await boot('', { prefs: { welcomeDismissed: true } });
    await page.waitForTimeout(400);

    // Whatever the dropdown is sitting on at boot — that is the board in the
    // report, the one that was there before the ATDT.
    const shown = await page.evaluate(() => {
      const sel = document.getElementById('bbs');
      const o = sel.selectedOptions[0];
      return o && o.value ? o.value : null;
    });
    ok(!!shown, 'the dropdown opens on a real board');

    // ATDT to an address the directory does not carry. Driven through the same
    // entry point the AT command line uses, so this is the real path.
    await page.evaluate(() => {
      document.getElementById('bbstoggle').click();      // → manual mode
    });
    await page.fill('#hostport', 'bb.nosuchboard.example:23');
    await page.dispatchEvent('#hostport', 'change');
    await page.waitForTimeout(150);
    eq(await page.evaluate(() => document.getElementById('host').value),
       'bb.nosuchboard.example', 'the typed address is the destination while in manual mode');

    // Back to the directory. The dropdown still displays the original board.
    await page.click('#bbstoggle');
    await page.waitForTimeout(200);
    eq(await page.evaluate(() => {
      const o = document.getElementById('bbs').selectedOptions[0];
      return o ? o.value : null;
    }), shown, 'and the dropdown is still showing the board it started on');

    // NOTHING is done to the dropdown here, and that is the test.
    //
    // The user re-picks the board the <select> is already sitting on, which in a
    // real browser fires no `input` and no `change` — the selection did not
    // change, so there is no event. The page state after that is identical to
    // the state right now: the option displayed, and nothing having run.
    //
    // Do NOT reach for page.selectOption() to express this. Playwright
    // dispatches change unconditionally, including for a selection that does not
    // move, so it drives the change handler the browser would never have called
    // — which makes the broken code pass. It did, on the first version of this
    // test, which is why the note is here rather than the call.
    eq(await page.evaluate(() => document.getElementById('host').value),
       String(shown).split(':')[0],
       'returning to the directory makes the destination match what is displayed');

    await page.selectOption('#protocol', 'direct');
    await page.click('#dial');
    await page.waitForTimeout(600);
    const dial2 = await page.evaluate(() => (window.__sent || [])
      .map((x) => { try { return JSON.parse(x); } catch (_) { return null; } })
      .filter((m) => m && m.type === 'dial')[0] || null);
    const [sh, sp] = String(shown).split(':');
    eq(dial2 && [dial2.host, String(dial2.port)], [sh, sp || '23'],
       'Connect dials the board on screen, not the address typed before it');
    await ctx.close();
  }

  await b.close();
  console.log(`\n${fail ? 'FAILED' : 'OK'} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
