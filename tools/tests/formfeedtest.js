#!/usr/bin/env node
// Form feed (0x0C) through the real parser: it clears the screen and homes the
// cursor exactly as ESC[2J does, which is what SyncTERM does and what boards
// whose clear-screen is a bare ^L are drawn against. LF and VT still line-feed.
// `node tools/tests/formfeedtest.js`.

let pass = 0, fail = 0;
function eq(a, e, what) {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) { pass++; console.log(`  ok   ${what}`); return; }
  fail++;
  console.log(`  FAIL ${what}\n       expected ${E}\n       actual   ${A}`);
}

(async () => {
  const { Terminal, ANSIParser } = await import('../../public/terminal.js');
  const enc = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
  const run = (s) => {
    const t = new Terminal(80, 25);
    new ANSIParser(t).feed(enc(s));
    return t;
  };
  const screen = (t) => {
    const out = [];
    for (let r = 0; r < t.rows; r++) {
      let s = '';
      for (let c = 0; c < t.cols; c++) s += String.fromCharCode(t.screen.get(c, r).ch);
      out.push(s.replace(/ +$/, ''));
    }
    while (out.length && out[out.length - 1] === '') out.pop();
    return out;
  };
  const state = (t) => ({ screen: screen(t), cx: t.cx, cy: t.cy, sb: t._scrollback.length });

  console.log('formfeedtest — 0x0C is clear + home\n');

  const pre = 'Scanning...\r\n\r\nline two\r\nline three';
  const ff = run(pre + '\x0C' + 'WHO IS ON');
  const csi = run(pre + '\x1B[2J' + 'WHO IS ON');
  eq(screen(ff), ['WHO IS ON'], 'FF clears the prior screen and draws from the top');
  eq([ff.cx, ff.cy], [9, 0], 'FF homes the cursor');
  eq(state(ff), state(csi), 'FF leaves exactly what ESC[2J leaves, scrollback included');

  const lf = run('AB\x0ACD');
  eq(screen(lf), ['AB', '  CD'], 'LF still line-feeds');
  const vt = run('AB\x0BCD');
  eq(screen(vt), ['AB', '  CD'], 'VT still line-feeds');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
