#!/usr/bin/env node
// petscii-derive.js — pick the design grid for the BESCII PETSCII face by
// MEASURING it, which is what FONTS.md 11.3 step 5 asks for and what settled
// Topaz at 15x36 rather than 10x24.
//
//     npm install --no-save playwright-core
//     node tools/petscii-derive.js
//
// BY HAND, like tools/fontaspect.py and the rest of this directory, and on no
// test path. It runs once per upstream release, or when the grid is questioned.
//
// WHAT IT MEASURES
//
// The registry's cellW/cellH for an outline font are not pixels: they state the
// cell's aspect and the resolution deriveOutlineBitmap() rasterizes at. Too
// coarse a grid and a one-pixel stem falls below the 192 threshold and vanishes
// from the derived bitmap, which is what the classifier and the hard-edged blit
// path both read — so the glyph seams or loses ink and nothing throws.
//
// So: rasterize the face at each candidate grid exactly as deriveOutlineBitmap()
// does, sample each of the 8x8 SOURCE pixels at its block centre, and compare
// against the truth. The misread percentage is the answer.
//
// THE TRUTH IS ALSO DERIVED, at 96x128 — 12 device pixels per source pixel
// across and 16 down, where every source pixel boundary lands on a whole device
// pixel and the rasterization cannot be ambiguous. That grid is far past the
// cellW <= 32 limit and is a measurement reference only; nothing ships at it.
//
// THE REFERENCE MUST CARRY THE FILE'S OWN CELL ASPECT. It was 80x96 for the 1.2
// asset; left there against a 4/3 file it rasterizes the face into the wrong
// box, and EVERY candidate then misreads about 6.4% — a flat column that looks
// like a bad font rather than like a bad reference, because the one thing a
// wrong truth cannot do is single out a grid.
//
// WHY THE CANDIDATES ARE WHAT THEY ARE
//
// The cell-aspect invariant is cellW * (ascent + descent) == cellH * advance,
// and the shipped file is 1792 + 256 over 1536, so cellH must be exactly
// cellW * 4/3. That leaves 3x4, 6x8, 9x12, 12x16, 15x20, 18x24, 21x28, 24x32,
// 27x36 and 30x40 under the 32 limit. Note 24x32 is exact on BOTH axes — 3 and
// 4 device pixels per source pixel — which no grid at the old 1.2 aspect could
// be, and 30x40 and 6x8 are the only others. The point of running this is that
// exact-on-both-axes is an arithmetic claim and the rasterizer is the authority.
//
// SynthLink's own code, GPL-3.0-or-later.

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const ROOT = path.join(__dirname, '..');
const WOFF2 = path.join(ROOT, 'public', 'fonts', 'Bescii_PETSCII.woff2');
const FAMILY = 'BesciiPETSCII';
const UPEM = 1536, ADVANCE = 1536, ASCENT = 1792, DESCENT = 256;
const THRESHOLD = 192;                     // DERIVE_THRESHOLD in fonts/index.js
const REF = { w: 96, h: 128 };
const GRIDS = [{ w: 3, h: 4 }, { w: 6, h: 8 }, { w: 9, h: 12 }, { w: 12, h: 16 },
               { w: 15, h: 20 }, { w: 18, h: 24 }, { w: 21, h: 28 },
               { w: 24, h: 32 }, { w: 27, h: 36 }, { w: 30, h: 40 }];

// The codepoints to measure: every printable position of both PETSCII tables,
// read out of fonts/petscii.js so this cannot drift from what actually ships.
function codepoints() {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'fonts', 'petscii.js'), 'utf8');
  const set = new Set();
  for (const m of src.matchAll(
    /export const PETSCII_\w+_TO_UNICODE = new Uint16Array\(\[([\s\S]*?)\]\);/g)) {
    for (const v of m[1].matchAll(/0x([0-9A-Fa-f]{4})/g)) {
      const cp = parseInt(v[1], 16);
      if (cp) set.add(cp);
    }
  }
  if (set.size < 128) throw new Error('petscii.js: tables not found');
  return [...set].sort((a, b) => a - b);
}

// outlineMetrics() from fonts/index.js, restated rather than imported — that
// file is an ES module in the browser tree and this is a Node script. The
// arithmetic is three lines and asserting it against the real one is ttftest's
// job, not this script's.
const metrics = (cellW) => {
  const fontSize = cellW * UPEM / ADVANCE;
  return { fontSize, baseline: Math.round(fontSize * ASCENT / UPEM) };
};

(async () => {
  const woff2 = fs.readFileSync(WOFF2).toString('base64');
  const cps = codepoints();

  // PW_CHROMIUM overrides, as the other browser harnesses in this repo allow;
  // otherwise take the first binary that exists, then let playwright-core find
  // its own download.
  const candidates = [process.env.PW_CHROMIUM,
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    '/opt/pw-browsers/chromium/chrome-linux/chrome'].filter(Boolean);
  const executablePath = candidates.find((p) => fs.existsSync(p));
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><meta charset="utf-8"><body></body>`);
  await page.evaluate(async ([b64, family]) => {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const face = new FontFace(family, bin.buffer);
    await face.load();
    document.fonts.add(face);
    await document.fonts.ready;
  }, [woff2, FAMILY]);

  const result = await page.evaluate(([cps, family, grids, ref, threshold, F]) => {
    const metrics = (cellW) => {
      const fontSize = cellW * F.upem / F.advance;
      return { fontSize, baseline: Math.round(fontSize * F.ascent / F.upem) };
    };
    // deriveOutlineBitmap()'s inner loop, one glyph at a time so a 25x30 strip
    // of 250 glyphs does not have to fit one canvas.
    function derive(cp, W, H) {
      const c = new OffscreenCanvas(W, H);
      const g = c.getContext('2d', { willReadFrequently: true });
      const m = metrics(W);
      g.clearRect(0, 0, W, H);
      g.font = `${m.fontSize}px "${family}"`;
      g.textBaseline = 'alphabetic';
      g.fillStyle = '#fff';
      g.fillText(String.fromCharCode(cp), 0, m.baseline);
      const d = g.getImageData(0, 0, W, H).data;
      const bits = [];
      for (let y = 0; y < H; y++) {
        const row = [];
        for (let x = 0; x < W; x++) row.push(d[(y * W + x) * 4 + 3] >= threshold ? 1 : 0);
        bits.push(row);
      }
      return bits;
    }
    // Sample the 8x8 source grid at each block's centre — FONTS.md 11.3 step 5.
    const sample = (bits, W, H) => {
      const out = [];
      for (let py = 0; py < 8; py++) {
        for (let px = 0; px < 8; px++) {
          const x = Math.floor((px + 0.5) * W / 8), y = Math.floor((py + 0.5) * H / 8);
          out.push(bits[Math.min(y, H - 1)][Math.min(x, W - 1)]);
        }
      }
      return out;
    };

    const truth = new Map();
    for (const cp of cps) truth.set(cp, sample(derive(cp, ref.w, ref.h), ref.w, ref.h));

    const rows = [];
    for (const G of grids) {
      let wrong = 0, total = 0, worst = null, worstN = 0;
      for (const cp of cps) {
        const got = sample(derive(cp, G.w, G.h), G.w, G.h);
        const want = truth.get(cp);
        let n = 0;
        for (let i = 0; i < 64; i++) if (got[i] !== want[i]) n++;
        wrong += n; total += 64;
        if (n > worstN) { worstN = n; worst = cp; }
      }
      const m = metrics(G.w);
      rows.push({
        grid: `${G.w}x${G.h}`,
        perSourcePixel: +(G.w / 8).toFixed(3),
        fontSize: m.fontSize,
        baselineExact: m.fontSize * F.ascent / F.upem === m.baseline,
        misreadPct: +(100 * wrong / total).toFixed(3),
        worst: worst === null ? null : 'U+' + worst.toString(16).toUpperCase().padStart(4, '0'),
        worstPixels: worstN,
      });
    }
    return { glyphs: cps.length, rows };
  }, [cps, FAMILY, GRIDS, REF, THRESHOLD,
      { upem: UPEM, advance: ADVANCE, ascent: ASCENT, descent: DESCENT }]);

  await browser.close();

  console.log(`BESCII PETSCII derive, ${result.glyphs} codepoints, `
    + `truth grid ${REF.w}x${REF.h}, threshold ${THRESHOLD}\n`);
  console.log('  grid    px/source  fontSize  baseline  misread%   worst glyph');
  for (const r of result.rows) {
    console.log(`  ${r.grid.padEnd(7)} ${String(r.perSourcePixel).padEnd(10)} `
      + `${String(r.fontSize).padEnd(9)} ${(r.baselineExact ? 'exact' : 'rounded').padEnd(9)} `
      + `${String(r.misreadPct).padEnd(10)} ${r.worst} (${r.worstPixels}/64)`);
  }
})();
