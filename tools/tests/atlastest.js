#!/usr/bin/env node
// The glyph atlas surviving a page that was hidden — in a REAL browser.
//
//     npm install --no-save playwright-core
//     node tools/tests/atlastest.js
//     PW_CHROMIUM=/path/to/chrome node tools/tests/atlastest.js
//
// WHAT IT IS ABOUT. A canvas backing store is a discardable resource. A mobile
// browser may empty one while the page is in the background, and it does not
// only do that to the canvas on screen: the glyph sheet and the tinted sheets
// are canvases too, and they come back present, correctly sized, and entirely
// transparent. Dropping the per-cell cache cannot repair that — every cell is
// redrawn, every blit reads an empty atlas, and the terminal stays black while
// the cursor, which is a fillRect and needs no atlas, still moves around it.
//
// The discard is simulated by clearing the sheets, which is what the browser
// leaves behind. That is the only way to reach the state: there is no API to
// make a browser drop a backing store on demand, and the devices that do it do
// it under memory pressure a harness cannot create.
//
// It drives the Renderer directly rather than main.js — no sockets, no server,
// so no WS-listener hang (CLAUDE.md). Both draw paths are covered, because they
// hold their sheets in different places: the legacy tinted-pair cache and the
// hybrid prescaled atlas plus its per-foreground tints.

const BROWSER_PKG = (() => {
  for (const p of ['playwright', 'playwright-core']) {
    try { require.resolve(p); return p; } catch (_) {}
  }
  console.error('atlastest: needs Playwright. Run:  npm install --no-save playwright-core');
  process.exit(2);
})();

const LAUNCH = process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {};
const { chromium } = require(BROWSER_PKG);
const fs = require('fs');
const dir = require('path').join(__dirname, '..', '..', 'public');

let pass = 0, fail = 0;
function eq(a, e, what) {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { pass++; return; }
  fail++;
  console.log(`  FAIL ${what}\n       expected ${E}\n       actual   ${A}`);
}
function ok(cond, what) { eq(!!cond, true, what); }

// The page the renderer is driven on. Deliberately not index.html: main.js
// would open a socket and fit a terminal, and neither is under test here.
const HOST_PAGE = '<!doctype html><meta charset="utf-8"><body></body>';

// Everything below runs IN THE PAGE. It builds a renderer, draws a screenful,
// counts the lit pixels, simulates the discard, and reports what each recovery
// step got back.
async function runInPage(page, fontId, hybrid) {
  return page.evaluate(async ([fontId, hybrid]) => {
    const { Renderer } = await import('/renderer.js');
    const { fontById } = await import('/fonts/index.js');

    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const COLS = 20, ROWS = 4;
    const r = new Renderer(canvas, COLS, ROWS, fontById(fontId));
    await r.init();
    if (hybrid) {
      const ready = new Promise((res) => { r.onAtlasReady = res; });
      r.setDeviceMetrics(COLS * 16, ROWS * 32);
      // An outline atlas is asynchronous — the font file has to arrive first.
      await Promise.race([ready, new Promise((res) => setTimeout(res, 4000))]);
    }

    // A screenful of ink: text in white on black, so a lit pixel can only have
    // come from a glyph.
    const cells = [];
    const text = 'SYNTHLINK ATLAS TEST';
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        cells.push({ ch: text.charCodeAt(col % text.length), fg: 15, bg: 0,
                     bold: false, blink: false });
      }
    }
    const draw = () => r.drawFrame(cells, -1, -1, false, false, true, null);
    // Every cell is white-on-black, so a pixel with any brightness at all came
    // from a glyph and nothing else.
    const lit = () => {
      const d = canvas.getContext('2d')
        .getImageData(0, 0, canvas.width, canvas.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] > 40 || d[i + 1] > 40 || d[i + 2] > 40) n++;
      }
      return n;
    };
    // Clearing a canvas is what a discarded backing store leaves behind. The
    // visible one goes too: the browser empties whatever it is holding, and on
    // the legacy path an emptied SHEET alone is invisible — its blits are
    // transparent, so stale pixels stay on screen and look correct until the
    // text changes. Discarding both is the state the device is actually in.
    const discard = () => {
      const sheets = [canvas, r._fontSheet, r._scaledSheet,
                      ...r._fgSheets.values(), ...r._tintedSheets.values()];
      for (const s of sheets) {
        if (s) s.getContext('2d').clearRect(0, 0, s.width, s.height);
      }
    };

    draw();
    const drawn = lit();

    // Nothing lost: restore() must say so, and must not throw the tinted
    // sheets away — a return to the page is common and re-tinting is not free.
    const tintsBefore = hybrid ? r._fgSheets.size : r._tintedSheets.size;
    const quiet = r.restore();
    const tintsAfter = hybrid ? r._fgSheets.size : r._tintedSheets.size;
    draw();
    const afterQuiet = lit();

    // The discard, and the recovery that is NOT enough on its own.
    discard();
    r.invalidateAll();
    draw();
    const afterInvalidate = lit();

    const said = r.restore();
    draw();
    const afterRestore = lit();

    // And a second round trip, to be sure the rebuilt sheets are themselves
    // probe-able rather than a one-shot recovery.
    discard();
    const saidAgain = r.restore();
    draw();
    const afterSecond = lit();

    return { drawn, quiet, tintsBefore, tintsAfter, afterQuiet,
             afterInvalidate, said, afterRestore, saidAgain, afterSecond };
  }, [fontId, hybrid]);
}

(async () => {
  const b = await chromium.launch(LAUNCH);
  const ctx = await b.newContext({ viewport: { width: 900, height: 600 } });
  const page = await ctx.newPage();
  await page.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/host.html') {
      return route.fulfill({ contentType: 'text/html', body: HOST_PAGE });
    }
    const p = dir + u.pathname;
    if (fs.existsSync(p) && fs.statSync(p).isFile()) {
      const ext = p.split('.').pop();
      const type = { js: 'text/javascript', html: 'text/html', json: 'application/json',
                     woff2: 'font/woff2', svg: 'image/svg+xml' }[ext] || 'text/plain';
      return route.fulfill({ contentType: type, body: fs.readFileSync(p) });
    }
    return route.fulfill({ status: 404, body: '' });
  });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.goto('http://localhost/host.html');

  // ── 1. Legacy path: one bitmap font, tinted colour-pair sheets ────────────
  {
    const g = await runInPage(page, 'vga8x16', false);
    console.log('legacy (vga8x16):', JSON.stringify(g));
    ok(g.drawn > 0, 'legacy: a screenful of text lights pixels');
    eq(g.quiet, false, 'legacy: restore() reports nothing lost when nothing was');
    eq(g.tintsAfter, g.tintsBefore, 'legacy: an intact tint cache survives restore()');
    eq(g.afterQuiet, g.drawn, 'legacy: a no-op restore() changes no pixel');
    eq(g.afterInvalidate, 0, 'legacy: invalidateAll alone cannot redraw an emptied sheet');
    eq(g.said, true, 'legacy: restore() reports the loss');
    eq(g.afterRestore, g.drawn, 'legacy: restore() puts every pixel back');
    eq(g.saidAgain, true, 'legacy: a rebuilt sheet is still checkable');
    eq(g.afterSecond, g.drawn, 'legacy: and recovers a second time');
  }

  // ── 2. Hybrid path, outline font: prescaled atlas + per-fg tints ──────────
  // The atlas here is built from a woff2 that had to be fetched, so this is
  // also the case where a naive rebuild would go back to the network.
  {
    const g = await runInPage(page, 'astpx8x19', true);
    console.log('hybrid (astpx8x19):', JSON.stringify(g));
    ok(g.drawn > 0, 'hybrid: a screenful of text lights pixels');
    eq(g.quiet, false, 'hybrid: restore() reports nothing lost when nothing was');
    eq(g.tintsAfter, g.tintsBefore, 'hybrid: an intact tint cache survives restore()');
    eq(g.afterQuiet, g.drawn, 'hybrid: a no-op restore() changes no pixel');
    eq(g.afterInvalidate, 0, 'hybrid: invalidateAll alone cannot redraw an emptied atlas');
    eq(g.said, true, 'hybrid: restore() reports the loss');
    eq(g.afterRestore, g.drawn, 'hybrid: restore() puts every pixel back');
    eq(g.saidAgain, true, 'hybrid: a rebuilt atlas is still checkable');
    eq(g.afterSecond, g.drawn, 'hybrid: and recovers a second time');
  }

  // ── 3. The page wires it up ───────────────────────────────────────────────
  // The renderer can only recover if something calls it. repaintAll() is that
  // something, and it is reached from both events — an app switch fires
  // visibilitychange, a bfcache restore fires only pageshow.
  {
    const src = fs.readFileSync(dir + '/main.js', 'utf8');
    ok(/renderer\.restore\s*\(\s*\)/.test(src), 'main.js: the repaint calls restore()');
    ok(/addEventListener\('visibilitychange'/.test(src)
       && /addEventListener\('pageshow'/.test(src),
       'main.js: both return-to-page events are listened for');
  }

  eq(errs, [], 'no page errors');
  await b.close();
  console.log(`\natlastest: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
