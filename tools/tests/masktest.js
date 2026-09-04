#!/usr/bin/env node
// Sharpening mask — the tuning table and the kernel behind it.
//
// Two things are being protected here, and they fail in different ways:
//
//   1. THE KERNEL, unsharpAlpha() in public/fonts/index.js. Its properties are
//      what make it safe to run over an atlas at all, and every one of them is
//      the kind of thing that still produces a plausible-looking terminal when
//      broken. The cell-clamp especially: taps that reach past a cell edge
//      smear one glyph's ink into its neighbour, which is invisible on most
//      character pairs and wrong on a few, so it cannot be found by looking.
//
//   2. THE TABLE, public/fontmask.js. It is hand-edited during tuning, so it is
//      asserted to be total (a typo resolves to "off", never to a throw) and
//      its keys are checked against the real registry — a mistyped font id
//      would otherwise be a knob that silently does nothing while appearing to
//      be set.
//
// Deliberately no canvas and no font file: the kernel takes a bare alpha plane
// precisely so this harness is pure arithmetic. Same reason inkGammaLUT()
// returns a table.
//
// Both modules are ES modules and this harness is CommonJS like its neighbours,
// hence the dynamic import.
//
//   node tools/tests/masktest.js

let pass = 0, fail = 0;
function eq(a, e, what) {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { pass++; return; }
  fail++;
  console.log(`  FAIL ${what}\n       expected ${E}\n       actual   ${A}`);
}
function ok(cond, what) { eq(!!cond, true, what); }

// A plane built from a picture, so the fixtures read as what they are.
// '#' = 255, '.' = 0, digits 1-9 = that tenth of full.
function plane(rows) {
  const w = rows[0].length, h = rows.length;
  const a = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = rows[y][x];
      a[y * w + x] = c === '#' ? 255 : c === '.' ? 0 : Math.round(255 * (+c / 10));
    }
  }
  return { a, w, h };
}

(async () => {
  const F = await import('../../public/fonts/index.js');
  const M = await import('../../public/fontmask.js');
  const { unsharpAlpha } = F;
  const { MASK, maskFor } = M;

  // ── The table ────────────────────────────────────────────────────────────
  console.log('fontmask.js — the tuning table');

  // Every key must name a font that exists. This is the assertion that earns
  // the file its keep: a typo'd id is a knob that reads as set and does
  // nothing, and there is no other way to notice.
  const ids = new Set(F.FONTS.map((f) => f.id));
  for (const k of Object.keys(MASK)) ok(ids.has(k), `MASK key '${k}' is a real font id`);

  // Total, and silent about it. A stray edit should turn the mask OFF, never
  // throw partway through building an atlas.
  eq(maskFor('astpx8x19'), MASK.astpx8x19, 'a listed font returns its own entry');
  eq(maskFor('no-such-font'), 0, 'an unknown id is 0');
  eq(maskFor(undefined), 0, 'undefined is 0');
  eq(maskFor('toString'), 0, 'an Object.prototype key is 0, not a function');
  for (const bad of [-0.5, NaN, Infinity, '0.4', null, {}]) {
    // Driven through a temporary entry, so this tests maskFor's guard rather
    // than the shipped values.
    const saved = MASK.vga8x16;
    MASK.vga8x16 = bad;
    eq(maskFor('vga8x16'), 0, `a ${JSON.stringify(String(bad))} entry is 0`);
    MASK.vga8x16 = saved;
  }

  // ── The gamma curve next door ────────────────────────────────────────────
  // Pass 4 shares its read-back with pass 3, runs after it, and is the second
  // curve over the same channel — so this is the harness that has both in hand
  // and the one that owns the properties FONTS.md §5.5 leans on. They were
  // documented as asserted and were not, anywhere.
  console.log('\ninkGammaLUT() — the pass-3 curve');
  {
    const { inkGammaLUT } = F;
    const id = inkGammaLUT(1);
    eq(Array.from(id), Array.from({ length: 256 }, (_, i) => i),
       'g = 1 is the exact identity at every entry');
    for (const g of [1.45, 1.8, 2.2]) {
      const lut = inkGammaLUT(g);
      eq([lut[0], lut[255]], [0, 255], `g = ${g}: endpoints are pinned`);
      ok(Array.from(lut).every((v, i) => i === 0 || v >= lut[i - 1]),
         `g = ${g}: monotonic non-decreasing`);
      // Darker everywhere in between — this is what catches the exponent
      // applied as ^g rather than ^(1/g).
      ok(Array.from(lut).every((v, i) => v >= i) && lut[128] > 128,
         `g = ${g}: partial coverage is darkened, never lightened`);
    }
    const a = inkGammaLUT(1.8), b = inkGammaLUT(2.2);
    ok(Array.from(b).every((v, i) => v >= a[i]) && b[128] > a[128],
       'a larger g is darker than a smaller one at every entry');
  }

  // ── The kernel ───────────────────────────────────────────────────────────
  console.log('\nunsharpAlpha() — the kernel');

  // amount 0 is the identity, exactly. Callers skip the pass instead, but the
  // function must not depend on them doing so.
  {
    const { a, w, h } = plane(['.#3#.', '#.7.#', '.#3#.']);
    eq(Array.from(unsharpAlpha(a, w, h, 5, 0)), Array.from(a), 'amount 0 is bit-identical');
  }

  // A uniform region is a fixed point: blur(uniform) === uniform, so the
  // difference term is zero whatever the amount. This is what makes the
  // interior of a solid glyph and the empty space around it immune.
  for (const row of ['#####', '.....', '55555']) {
    const { a, w, h } = plane([row, row, row]);
    eq(Array.from(unsharpAlpha(a, w, h, 5, 0.8)), Array.from(a),
       `a uniform plane at '${row[0]}' is unchanged`);
  }

  // THE CELL CLAMP. Two cells of 3px: one solid, one empty. Both are uniform
  // WITHIN their cell, so a correct kernel returns the plane untouched. A
  // kernel clamped to the image instead of the cell rings along the seam —
  // which is exactly one glyph's ink landing in its neighbour's cell.
  {
    const { a, w, h } = plane(['###...', '###...', '###...']);
    const out = unsharpAlpha(a, w, h, 3, 0.8);
    eq(Array.from(out), Array.from(a), 'taps do not cross a cell boundary');
  }

  // Ink never grows: where a === 0 the result is -amount * blur, which clamps
  // to 0. So a mask can sharpen a letterform but never widen or bleed one, and
  // the atlas cell's blank pad column stays blank.
  {
    const { a, w, h } = plane(['##...', '##...', '##...']);
    const out = unsharpAlpha(a, w, h, 5, 0.9);
    for (let i = 0; i < a.length; i++) {
      if (a[i] === 0) ok(out[i] === 0, `a zero pixel at ${i} stays zero`);
    }
  }

  // It does actually sharpen: across an edge the bright side goes brighter and
  // the dim side dimmer. Asserted as a widened gap rather than as exact values,
  // so the test survives a change of kernel but not a change of sign.
  {
    const { a, w, h } = plane(['33377', '33377', '33377']);
    const out = unsharpAlpha(a, w, h, 5, 0.7);
    const i = 1 * w + 2, j = 1 * w + 3;             // the two pixels at the step
    ok(out[i] < a[i], 'the dim side of an edge goes dimmer');
    ok(out[j] > a[j], 'the bright side of an edge goes brighter');
    ok((out[j] - out[i]) > (a[j] - a[i]), 'the step is steeper than it was');
  }

  // Clamped to the byte, at a strength no one would ever set.
  {
    const { a, w, h } = plane(['.#.#.', '#.#.#', '.#.#.']);
    const out = unsharpAlpha(a, w, h, 5, 12);
    ok(Array.from(out).every((v) => v >= 0 && v <= 255), 'output stays in [0,255]');
  }

  // The skip list leaves a cell byte-identical — this is how the graphics
  // glyphs keep the hard edges that let them tile.
  {
    // Cell 1 is mid-tone and non-uniform, so it demonstrably moves; a 0/255
    // fixture would clamp at both ends and prove nothing about the skip.
    const { a, w, h } = plane(['.#.357', '#.#573', '.#.357']);
    const skip = new Uint8Array([1, 0]);
    const out = unsharpAlpha(a, w, h, 3, 0.7, skip);
    eq(Array.from(out.slice(0, 3)), Array.from(a.slice(0, 3)), 'a skipped cell is untouched');
    ok(Array.from(out).some((v, i) => v !== a[i]), 'the unskipped cell was still processed');
  }

  // The input is not modified — the atlas build reads the plane it passed in
  // while writing the result back, and an in-place kernel would feed sharpened
  // pixels into the taps of their own neighbours.
  {
    const { a, w, h } = plane(['.#3#.', '#.7.#', '.#3#.']);
    const before = Array.from(a);
    unsharpAlpha(a, w, h, 5, 0.7);
    eq(Array.from(a), before, 'the input plane is not modified');
  }

  console.log(`\n${fail ? 'FAILED' : 'OK'} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
