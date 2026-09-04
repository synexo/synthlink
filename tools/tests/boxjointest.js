#!/usr/bin/env node
/*
 * boxjointest.js — do box-drawing characters actually JOIN?
 *
 * Renders tools/tests/boxsheet.js through the real render stack, in a real browser,
 * for every font the Aa button offers, at several device sizes, and measures
 * the one thing a screenshot cannot be argued with about: whether a stroke that
 * crosses a cell boundary has a hole in it.
 *
 * WHY A SEPARATE HARNESS
 * ======================
 * The older render check verified that `─` (0xC4) is continuous across a row
 * and that `█` tiles. Both passed throughout the defect this file was written
 * to find, because both of those characters span their whole cell and the
 * stretch classifier therefore handles them. The characters that break are the
 * ones that reach only ONE edge — every corner, every tee — and nothing was
 * looking at those. So this is not a duplicate: it is the same property tested
 * over the whole junction alphabet instead of two representatives.
 *
 * WHAT COUNTS AS A GAP, AND WHAT DOES NOT
 * =======================================
 * A double-line corner has a designed hole in it. `╔` is two strokes meeting at
 * a right angle with an empty square between them, so on the row of its INNER
 * horizontal stroke there is ink at the outer vertical, then background, then
 * ink again. Counting every background pixel between the first and last ink of
 * a stroke row therefore reports the whole double-line and mixed-line
 * alphabet as broken, which is how this harness first read them.
 *
 * The discriminator is the CELL BOUNDARY. A designed notch lives inside one
 * glyph and so contains no boundary; a join failure is by definition centred on
 * one. So a run of background is a gap only if a cell edge falls inside it.
 * Nothing about the tolerance changes — a single background pixel across a
 * boundary is still a failure — only which holes are the font's own business.
 *
 * TWO DISTINCT FAILURES, MEASURED SEPARATELY
 *   GAP      a background pixel inside a stroke. The stroke stopped short of
 *            the cell edge, or the next cell started late.
 *   SOFT     a partially-covered pixel where the glyph should be solid. Comes
 *            from a full-cell glyph being drawn with fillText (antialiased)
 *            instead of from the thresholded bitmap — FONTS.md It reads as
 *            a faint seam rather than a hole, and only outline fonts can have
 *            it, which is why this defect looked TTF-specific.
 *
 * SIZES, and why these three
 *   exact      a device width that is an exact multiple of the column count,
 *              so every cell rect is exactly inkW wide and there is NO residue
 *. This is the control: a failure here
 *              cannot be a scaling artefact.
 *   1920x1080  height-constrained, so the pitch goes fractional and the residue
 *              appears. The difference between this and `exact` isolates
 *              everything the residue is responsible for.
 *   1080 wide  a phone, 13.5 px per cell — the worst fractional case.
 *
 * Serves public/ from memory like urltest.js, so no
 * server.js and no WS-listener hang.
 *
 *   npm install --no-save playwright-core
 *   node tools/tests/boxjointest.js               # measure, and write PNGs
 *   PNG=0 node tools/tests/boxjointest.js         # measure only
 *
 * SynthLink's own code, GPL-3.0-or-later.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { build } = require('./boxsheet');

const PUB = path.join(__dirname, '..', '..', 'public');
const OUT = path.join(__dirname, 'out');

let pass = 0, fail = 0;
function eq(a, e, what) {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { pass++; return; }
  fail++;
  console.log(`  FAIL ${what}\n       expected ${E}\n       actual   ${A}`);
}
function ok(cond, what) { eq(!!cond, true, what); }

// Which fonts, and how wide a device makes their cell rects exact. A cell is
// `inkW` device pixels and the residue vanishes when cols * inkW == Dw, so any
// multiple of the column count does it — 24 px a cell is picked because it is
// big enough to see a one-pixel notch in a PNG.
//
// `romCols` is the font's own ROM cell width, which for an OUTLINE entry is not
// its registry cellW — that states an aspect and a rasterization resolution and
// is 16 on flexi160, 27 on flexi135, for faces whose ROM cell is nine columns.
// Some shade cases only apply at nine (boxsheet.js's `nineWide`), so the width
// has to be stated rather than inferred.
const SUBJECTS = [
  { id: 'flexi160',  label: 'Modern (desktop) — Flexi False 1.60', romCols: 9 },
  { id: 'flexi135',  label: 'Modern (mobile) — Flexi True', romCols: 9 },
  { id: 'astpx8x19', label: 'Pixel — AST PremiumExec outline', romCols: 8 },
  { id: 'vga9x14px', label: 'Squat — IBM VGA 9x14 outline', romCols: 9 },
  // The bitmap arm of the 40-column slot. Hidden from the UI, kept here for two
  // reasons: it is the only 9-wide BITMAP on the hybrid path, so it is the only
  // subject that exercises fontscale.js's 2-byte glyph-row stride through a
  // real render — and it is the POSITIVE CONTROL for the shade cases.
  //
  // Its glyph data is the untouched IBM ROM, blank ninth column and all, so it
  // still has the gutter the outline fonts were re-pitched to remove. That is
  // deliberate and it is asserted: `shadeGutter` says this subject MUST fail
  // the shade cases. A check that only ever passes is not evidence, and this is
  // the one subject that can prove the shade case has teeth. If it ever comes
  // back clean, the data was changed and this flag has to go with it.
  { id: 'vga9x14hr', label: 'Squat reference — IBM VGA 9x14 hybrid bitmap',
    romCols: 9, shadeGutter: true },
];

const SIZES = [
  { name: 'exact',  w: 1920, h: 1000000 },
  { name: '1080p',  w: 1920, h: 1080 },
  { name: 'phone',  w: 1080, h: 1000000 },
];

(async () => {
  let chromium;
  try { ({ chromium } = require('playwright-core')); }
  catch (_) {
    console.log('playwright-core not installed — skipping.');
    console.log('  npm install --no-save playwright-core && node tools/tests/boxjointest.js');
    process.exit(0);
  }

  const wantPng = process.env.PNG !== '0';
  if (wantPng) fs.mkdirSync(OUT, { recursive: true });

  const launch = {};
  if (process.env.PW_CHROMIUM) launch.executablePath = process.env.PW_CHROMIUM;
  const browser = await chromium.launch(launch);
  const page = await browser.newPage();

  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'probe.test') return route.abort();
    if (url.pathname === '/') {
      return route.fulfill({ contentType: 'text/html',
        body: '<!doctype html><meta charset=utf-8><title>boxjoin</title>' });
    }
    const file = path.join(PUB, url.pathname);
    if (!file.startsWith(PUB) || !fs.existsSync(file)) return route.abort();
    const ct = url.pathname.endsWith('.js') ? 'text/javascript'
             : url.pathname.endsWith('.woff2') ? 'font/woff2'
             : 'text/plain';
    route.fulfill({ contentType: ct, body: fs.readFileSync(file) });
  });
  await page.goto('http://probe.test/');

  console.log('boxjointest — do box-drawing characters join?\n');

  const sheet = build();

  const results = await page.evaluate(async ({ sheetGrid, cases, subjects, sizes }) => {
    const F = await import('/fonts/index.js');
    const R = await import('/renderer.js');

    const FG = 0xAA;                      // VGA_PALETTE[7] on VGA_PALETTE[0]
    const out = [];

    for (const sub of subjects) {
      const font = F.fontById(sub.id);
      const cols = F.fontCols(font);
      const rows = 25;

      for (const size of sizes) {
        const canvas = document.createElement('canvas');
        document.body.appendChild(canvas);
        const r = new R.Renderer(canvas, cols, rows, font);
        await r.init();

        const ready = new Promise((res) => {
          r.onAtlasReady = () => res('ready');
          r.onFontUnavailable = () => res('failed');
        });
        r.setDeviceMetrics(size.w, size.h);
        let verdict = 'legacy';
        if (F.isTTF(font)) {
          verdict = await Promise.race([ready,
            new Promise((res) => setTimeout(() => res('timeout'), 8000))]);
        }

        // The sheet is 80 columns wide. A 40-column font shows the left half,
        // which still contains the single-line grid and the block fills — the
        // cases are filtered to what fits rather than the font being skipped,
        // because the 40-column path is exactly where a cell is widest and a
        // one-pixel error is most visible.
        const cells = [];
        for (let y = 0; y < rows; y++) {
          for (let x = 0; x < cols; x++) {
            cells.push({ ch: (sheetGrid[y] && sheetGrid[y][x]) || 32,
                         fg: 7, bg: 0, bold: false, blink: false, dirty: true });
          }
        }
        r.drawFrame(cells, -1, -1, false, false, true, null);

        const g = canvas.getContext('2d');
        const W = canvas.width, H = canvas.height;
        const img = g.getImageData(0, 0, W, H).data;
        // One byte per pixel: 2 = solid foreground, 1 = partial, 0 = background.
        const px = new Uint8Array(W * H);
        for (let i = 0, p = 0; i < img.length; i += 4, p++) {
          const v = img[i];
          px[p] = v >= FG ? 2 : (v > 0 ? 1 : 0);
        }
        const at = (x, y) => px[y * W + x];

        const L = r._layout;
        const X = L ? Array.from(L.xEdges) : null;
        const Y = L ? Array.from(L.yEdges) : null;
        const rec = { id: sub.id, label: sub.label, size: size.name, verdict,
                      cols, W, H, inkW: L && L.inkW, inkH: L && L.inkH,
                      residueX: null, findings: [] };
        if (!L) { out.push(rec); continue; }

        // How many cell rects are wider than the ink extent — the §1.3 residue,
        // and the quantity the `exact` size exists to drive to zero.
        let wide = 0;
        for (let c = 0; c < cols; c++) if (X[c + 1] - X[c] !== L.inkW) wide++;
        rec.residueX = wide;

        for (const cs of cases) {
          if (cs.kind === 'hrun') {
            if (cs.col1 >= cols) continue;
            const x0 = X[cs.col0], x1 = X[cs.col1 + 1];
            const yA = Y[cs.row], yB = Y[cs.row + 1];
            // Stroke rows: device rows that are mostly ink across the span.
            // A corner at each end leaves part of the span blank, hence 0.6
            // rather than something nearer 1.
            const strokeRows = [];
            for (let y = yA; y < yB; y++) {
              let n = 0;
              for (let x = x0; x < x1; x++) if (at(x, y)) n++;
              if (n > (x1 - x0) * 0.6) strokeRows.push(y);
            }
            if (!strokeRows.length) {
              rec.findings.push({ what: cs.what, kind: 'hrun', error: 'no stroke found' });
              continue;
            }
            // Cell edges strictly inside the run — the only places a join can
            // fail, and what separates a real gap from a corner's own notch.
            const bounds = new Set();
            for (let c = cs.col0 + 1; c <= cs.col1; c++) bounds.add(X[c]);
            let gaps = 0, soft = 0;
            for (const y of strokeRows) {
              let first = -1, last = -1;
              for (let x = x0; x < x1; x++) if (at(x, y)) { if (first < 0) first = x; last = x; }
              for (let x = first; x <= last; x++) {
                if (at(x, y) === 1) { soft++; continue; }
                if (at(x, y) !== 0) continue;
                let run = x;                                  // maximal background run
                while (run <= last && at(run, y) === 0) run++;
                let crosses = false;
                for (let b = x; b <= run; b++) if (bounds.has(b)) crosses = true;
                if (crosses) gaps += run - x;
                x = run - 1;
              }
            }
            if (gaps || soft) {
              rec.findings.push({ what: cs.what, kind: 'hrun', gaps, soft,
                                  rows: strokeRows.length });
            }
          } else if (cs.kind === 'vrun') {
            if (cs.col >= cols) continue;
            const y0 = Y[cs.row0], y1 = Y[cs.row1 + 1];
            const xA = X[cs.col], xB = X[cs.col + 1];
            const strokeCols = [];
            for (let x = xA; x < xB; x++) {
              let n = 0;
              for (let y = y0; y < y1; y++) if (at(x, y)) n++;
              if (n > (y1 - y0) * 0.6) strokeCols.push(x);
            }
            if (!strokeCols.length) {
              rec.findings.push({ what: cs.what, kind: 'vrun', error: 'no stroke found' });
              continue;
            }
            const bounds = new Set();
            for (let rr = cs.row0 + 1; rr <= cs.row1; rr++) bounds.add(Y[rr]);
            let gaps = 0, soft = 0;
            for (const x of strokeCols) {
              let first = -1, last = -1;
              for (let y = y0; y < y1; y++) if (at(x, y)) { if (first < 0) first = y; last = y; }
              for (let y = first; y <= last; y++) {
                if (at(x, y) === 1) { soft++; continue; }
                if (at(x, y) !== 0) continue;
                let run = y;
                while (run <= last && at(x, run) === 0) run++;
                let crosses = false;
                for (let b = y; b <= run; b++) if (bounds.has(b)) crosses = true;
                if (crosses) gaps += run - y;
                y = run - 1;
              }
            }
            if (gaps || soft) {
              rec.findings.push({ what: cs.what, kind: 'vrun', gaps, soft,
                                  cols: strokeCols.length });
            }
          } else if (cs.kind === 'solid') {
            if (cs.col + cs.w > cols) continue;
            let x0 = X[cs.col], x1 = X[cs.col + cs.w];
            const y0 = Y[cs.row], y1 = Y[cs.row + cs.h];
            if (cs.inset) {
              // ▐▌ — each glyph fills only the half of its cell facing the
              // other, so the solid region is not the two cells but whatever
              // ink is actually in them. Derived rather than assumed: a 9-wide
              // cell does not split into two equal halves, so any fixed inset
              // would be wrong for the 40-column font and right for the others.
              let a = -1, b = -1;
              for (let x = x0; x < x1; x++) {
                let any = false;
                for (let y = y0; y < y1 && !any; y++) if (at(x, y)) any = true;
                if (any) { if (a < 0) a = x; b = x; }
              }
              if (a < 0) { rec.findings.push({ what: cs.what, kind: 'solid', error: 'no ink' }); continue; }
              x0 = a; x1 = b + 1;
            }
            let gaps = 0, soft = 0;
            for (let y = y0; y < y1; y++) {
              for (let x = x0; x < x1; x++) {
                const v = at(x, y);
                if (v === 0) gaps++; else if (v === 1) soft++;
              }
            }
            if (gaps || soft) {
              rec.findings.push({ what: cs.what, kind: 'solid', gaps, soft,
                                  area: (x1 - x0) * (y1 - y0) });
            }
          } else if (cs.kind === 'shade') {
            // A dithered field: background is everywhere by design, so the
            // `solid` measure is meaningless here. What must not exist is a
            // blank device column or row ON A CELL BOUNDARY — that is the
            // gutter, one cell's edge showing through a fill that should be
            // seamless.
            //
            // THE BOUNDARY CLAUSE IS THE WHOLE TEST, and the version without
            // it was wrong. "No blank column ANYWHERE in the region" assumes
            // the shade glyph inks every column of its cell, which is a
            // property of some faces and not others: a dither whose period does
            // not align with the device cell leaves interior columns blank and
            // still tiles perfectly. `nineWide` below is the same observation
            // made narrowly for one glyph; this is it made generally. The
            // discriminator is the one this harness already applies to every
            // run and solid case — a hole counts only if a cell edge is in it.
            if (cs.col + cs.w > cols) continue;
            if (cs.nineWide && sub.romCols !== 9) continue;
            const x0 = X[cs.col], x1 = X[cs.col + cs.w];
            const y0 = Y[cs.row], y1 = Y[cs.row + cs.h];
            // A boundary between two cells is the pair of device columns that
            // straddle it: the last of one cell and the first of the next.
            const colEdge = new Set(), rowEdge = new Set();
            for (let k = cs.col + 1; k < cs.col + cs.w; k++) { colEdge.add(X[k]); colEdge.add(X[k] - 1); }
            for (let k = cs.row + 1; k < cs.row + cs.h; k++) { rowEdge.add(Y[k]); rowEdge.add(Y[k] - 1); }
            const blankCols = [], blankRows = [], interior = [];
            for (let x = x0; x < x1; x++) {
              let any = false;
              for (let y = y0; y < y1 && !any; y++) if (at(x, y)) any = true;
              if (any) continue;
              (colEdge.has(x) ? blankCols : interior).push(x - x0);
            }
            for (let y = y0; y < y1; y++) {
              let any = false;
              for (let x = x0; x < x1 && !any; x++) if (at(x, y)) any = true;
              if (any) continue;
              (rowEdge.has(y) ? blankRows : interior).push(y - y0);
            }
            if (blankCols.length || blankRows.length) {
              rec.findings.push({ what: cs.what, kind: 'shade',
                                  gaps: blankCols.length + blankRows.length,
                                  interior: interior.length,
                                  blankCols: blankCols.slice(0, 12),
                                  blankRows: blankRows.slice(0, 12),
                                  area: (x1 - x0) * (y1 - y0) });
            }
          }
        }
        rec.png = canvas.toDataURL('image/png');
        out.push(rec);
        canvas.remove();
      }
    }
    return out;
  }, { sheetGrid: sheet.grid, cases: sheet.cases, subjects: SUBJECTS, sizes: SIZES });

  // ── Report ───────────────────────────────────────────────────────────────
  const summary = [];
  for (const r of results) {
    const png = r.png;
    delete r.png;
    if (wantPng && png) {
      const file = path.join(OUT, `boxjoin-${r.id}-${r.size}.png`);
      fs.writeFileSync(file, Buffer.from(png.split(',')[1], 'base64'));
    }
    const gaps = r.findings.reduce((n, f) => n + (f.gaps || 0), 0);
    const soft = r.findings.reduce((n, f) => n + (f.soft || 0), 0);
    summary.push({ id: r.id, size: r.size, verdict: r.verdict, cell: `${r.inkW}x${r.inkH}`,
                   residueCells: r.residueX, broken: r.findings.length, gaps, soft });
    console.log(`${r.label}  [${r.size}]  cell ${r.inkW}x${r.inkH}, `
              + `${r.residueX} of ${r.cols} cell rects wider than the ink`);
    if (!r.findings.length) console.log('   all joins clean');
    for (const f of r.findings.slice(0, 12)) {
      console.log(`   ${f.error ? 'ERROR ' + f.error : `gaps ${f.gaps}  soft ${f.soft}`}`
                + `${f.kind === 'shade' ? `  (${f.interior} interior, not counted)` : ''}`
                + `   — ${f.what}`);
    }
    if (r.findings.length > 12) console.log(`   ...and ${r.findings.length - 12} more`);
    console.log('');
  }

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'boxjoin.json'), JSON.stringify(results, null, 2));

  // ── Assertions ───────────────────────────────────────────────────────────
  // Everything the Aa button offers must join, at every size. There is no
  // tolerance to set here: one background pixel inside a stroke is a hole in a
  // table border, and one partially-covered pixel is a visible seam.
  const expectGutter = new Set(SUBJECTS.filter((s) => s.shadeGutter).map((s) => s.id));
  for (const s of summary) {
    if (expectGutter.has(s.id)) continue;
    eq([s.gaps, s.soft], [0, 0],
       `${s.id} @ ${s.size}: every stroke solid, corner to corner (${s.broken} broken)`);
  }
  // The positive control, both halves of it: the ROM bitmap must still show the
  // gutter in the shade cases, and must still be clean everywhere else.
  for (const r of results.filter((x) => expectGutter.has(x.id))) {
    const shade = r.findings.filter((f) => f.kind === 'shade');
    const other = r.findings.filter((f) => f.kind !== 'shade');
    ok(shade.length > 0,
       `${r.id} @ ${r.size}: the untouched ROM bitmap STILL guttters — the shade case has teeth`);
    eq(other.length, 0,
       `${r.id} @ ${r.size}: ...and nothing else about it is broken`);
  }
  for (const r of results) {
    ok(r.verdict === 'ready' || r.verdict === 'legacy',
       `${r.id} @ ${r.size}: the font actually loaded (${r.verdict})`);
  }
  // The control has to BE a control, or "clean at exact" proves nothing.
  for (const s of summary.filter((x) => x.size === 'exact')) {
    eq(s.residueCells, 0, `${s.id} @ exact: no cell rect carries residue — this size is the control`);
  }
  ok(summary.some((s) => s.size !== 'exact' && s.residueCells > 0),
     'the fractional sizes DO carry residue, so they test something the control does not');

  console.log(`${fail ? 'FAILED' : 'OK'} — ${pass} passed, ${fail} failed`);
  console.log(`PNGs and boxjoin.json in ${OUT}`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
