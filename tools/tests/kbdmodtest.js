#!/usr/bin/env node
// Unit test for the keyboard's byte sequences and its sticky-modifier state
// machine, both in public/main.js.
//
// Two things are under test and they matter for different reasons:
//
//  1. namedSeq() — the ONE place that decides what bytes a key sends. A
//     duplicated table entry would make one F-key silently send another's
//     bytes, so F1–F12 are asserted to be twelve distinct sequences.
//
//  2. modTap/modHold/modConsume/modClear — the tap/long-press/lock transitions.
//     Pure functions over an explicit state object precisely so they can be
//     driven with no DOM and no timers.
//
// main.js runs top-to-bottom against a live DOM and an AudioContext, so it
// can't be required; the declarations are extracted by name, the same technique
// tools/tests/sharelinktest.js uses. Rename one and the
// extraction throws instead of silently testing a stale copy.
//
//   node tools/tests/kbdmodtest.js

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'main.js'), 'utf8');

// ── Extraction ──────────────────────────────────────────────────────────────
function extractFn(name) {
  const start = SRC.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`kbdmodtest: function ${name}() not found in public/main.js`);
  // Walk the parameter list to its closing paren first, THEN brace-match the
  // body — scanning from the first '{' would stop on a destructured parameter.
  let i = SRC.indexOf('(', start), pd = 0;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '(') pd++;
    else if (SRC[i] === ')' && --pd === 0) break;
  }
  let depth = 0;
  for (let j = SRC.indexOf('{', i); j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}' && --depth === 0) return SRC.slice(start, j + 1);
  }
  throw new Error(`kbdmodtest: unbalanced braces reading ${name}()`);
}

// The lookup tables are const object literals; pull them out the same way so a
// changed table is picked up rather than duplicated here.
function extractConst(name) {
  const start = SRC.indexOf(`const ${name} `);
  if (start < 0) throw new Error(`kbdmodtest: const ${name} not found in public/main.js`);
  let depth = 0;
  for (let j = SRC.indexOf('{', start); j < SRC.length; j++) {
    if (SRC[j] === '{') depth++;
    else if (SRC[j] === '}' && --depth === 0) return SRC.slice(start, j + 1) + ';';
  }
  throw new Error(`kbdmodtest: unbalanced braces reading const ${name}`);
}

// One-line arrow declarations (modActive) — take to end of line.
function extractLine(prefix) {
  const start = SRC.indexOf(prefix);
  if (start < 0) throw new Error(`kbdmodtest: "${prefix}" not found in public/main.js`);
  return SRC.slice(start, SRC.indexOf('\n', start));
}

const api = new Function([
  extractConst('CSI_TILDE'), extractConst('SS3_FN'), extractConst('CSI_ARROW'),
  extractFn('modCode'), extractFn('namedSeq'), extractFn('ctrlChar'), extractFn('keyToSeq'),
  extractFn('newModState'), extractFn('modTap'), extractFn('modHold'),
  extractFn('modConsume'), extractFn('modClear'), extractFn('modReleaseLocks'), extractFn('altAccept'),
  extractLine('const modActive ='),
  "return { namedSeq, keyToSeq, newModState, modTap, modHold, modConsume, modClear, modReleaseLocks, modActive, altAccept };",
].join('\n'))();

const { namedSeq, keyToSeq, newModState, modTap, modHold, modReleaseLocks,
        modConsume, modClear, modActive, altAccept } = api;

// ── Harness ─────────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
const show = (s) => s === null ? 'null'
  : JSON.stringify(s).replace(/\\u001b/g, 'ESC ').replace(/\\u00(\w\w)/g, (_, h) => `<${h}>`);
function eq(actual, expected, what) {
  if (actual === expected) { pass++; return; }
  fail++;
  console.log(`  FAIL ${what}\n       expected ${show(expected)}\n       got      ${show(actual)}`);
}

// ── F-key distinctness ──────────────────────────────────────────────────────
{
  const seqs = new Set();
  for (let i = 1; i <= 12; i++) seqs.add(namedSeq('F' + i, 0, 0));
  eq(seqs.size, 12, 'F1–F12 are twelve distinct sequences');
}

// ── 5. Sticky modifier state machine ────────────────────────────────────────
console.log('sticky modifier transitions');
{
  const st = newModState();
  eq(st.ctrl, 'off', 'starts off');

  modTap(st, 'ctrl');
  eq(st.ctrl, 'armed', 'tap arms');
  eq(modActive(st, 'ctrl'), true, 'armed counts as active');

  modConsume(st);
  eq(st.ctrl, 'off', 'an armed modifier is consumed by the next key');

  modTap(st, 'ctrl'); modTap(st, 'ctrl');
  eq(st.ctrl, 'off', 'a second tap disarms');

  // Long press: the tap already ran on pointerdown, then the hold promotes.
  modTap(st, 'ctrl'); modHold(st, 'ctrl');
  eq(st.ctrl, 'locked', 'tap-then-hold locks');
  // THE BUG THIS RULE FIXES: without also locking the view, the first keypress
  // on a shift-like view falls back to view 1 and strands the locked modifier
  // on a panel that shows neither its key nor the capitals/symbols it was
  // locked for — the lock looked like it released itself after one key.
  eq(st.viewLocked, true, 'locking a modifier locks the view too');
  modConsume(st);
  eq(st.ctrl, 'locked', 'a locked modifier survives a keypress');
  eq(st.viewLocked, true, 'and so does the view lock');
  modConsume(st); modConsume(st);
  eq(st.ctrl, 'locked', 'and keeps surviving');
  modTap(st, 'ctrl');
  eq(st.ctrl, 'off', 'tapping a locked modifier releases it');
  eq(st.viewLocked, false, 'and releases the view lock with it');

  // Holding a key whose tap turned it OFF still means "lock it".
  modTap(st, 'shift'); modTap(st, 'shift');
  eq(st.shift, 'off', 'two taps => off');
  modHold(st, 'shift');
  eq(st.shift, 'locked', 'a hold locks regardless of what the tap did');
}
{
  // Undoing any lock undoes them all — one gesture in, one gesture out.
  const st = newModState();
  modTap(st, 'ctrl');  modHold(st, 'ctrl');
  modTap(st, 'shift'); modHold(st, 'shift');
  eq(st.ctrl + '/' + st.shift, 'locked/locked', 'both locked');
  modTap(st, 'shift');
  eq(st.ctrl, 'off',  'releasing shift released the locked ctrl too');
  eq(st.shift, 'off', 'shift released');
  eq(st.viewLocked, false, 'and the view lock');
}
{
  // A lock must not swallow an armed modifier the user is mid-compose on:
  // releasing locks leaves 'armed' alone.
  const st = newModState();
  modTap(st, 'ctrl'); modHold(st, 'ctrl');   // ctrl locked
  modTap(st, 'shift');                        // shift armed
  modReleaseLocks(st);
  eq(st.ctrl, 'off',    'locked ctrl released');
  eq(st.shift, 'armed', 'armed shift survives a lock release');
}
{
  // Independence: ctrl and shift must not disturb each other.
  const st = newModState();
  modTap(st, 'ctrl'); modTap(st, 'shift'); modHold(st, 'shift');
  eq(st.ctrl, 'armed',  'ctrl unaffected by shift');
  eq(st.shift, 'locked','shift locked');
  modConsume(st);
  eq(st.ctrl, 'off',    'armed ctrl consumed');
  eq(st.shift, 'locked','locked shift retained in the same consume');
}
{
  // A view change is a clean slate — locked included. This is the rule that
  // guarantees you can never carry an invisible modifier into a panel where
  // its key isn't shown.
  const st = newModState();
  modTap(st, 'ctrl'); modHold(st, 'ctrl');
  modTap(st, 'shift');
  st.viewLocked = true;
  modClear(st);
  eq(st.ctrl, 'off',  'view change clears a LOCKED ctrl');
  eq(st.shift, 'off', 'view change clears an armed shift');
}

// ── 6a. Alt+numpad CP437 code entry ─────────────────────────────────────────
// Always three digits, DOS-style, because nothing is physically held down to
// signal the end of the code — the third digit commits.
console.log('Alt+numpad code entry');
{
  // Drive a full entry the way the key handler does.
  const enter = (str) => {
    let digits = '', out = [];
    for (const ch of str) {
      const r = altAccept(digits, ch);
      digits = r.digits;
      if (digits === null) { out.push(r.byte); digits = ''; }
    }
    return out;
  };
  eq(enter('256')[0], null, '256 is out of range and sends nothing');
  eq(enter('300')[0], null, '300 discarded rather than wrapped to 44');
  eq(enter('999')[0], null, '999 discarded');
}

// ── 6b. The physical path (keyToSeq) ────────────────────────────────────────
// The audit's second half was all about this function returning null. Drive it
// with plain event-shaped objects — it only ever reads key/ctrlKey/shiftKey/
// altKey/metaKey.
console.log('physical keyboard (keyToSeq)');
{
  const ev = (key, m = {}) => keyToSeq({
    key, ctrlKey: !!m.ctrl, shiftKey: !!m.shift, altKey: !!m.alt, metaKey: !!m.meta });

  // Alt belongs to scrollback and must never produce bytes, or an Alt+PgUp
  // would both scroll and type.
  for (const k of ['PageUp','PageDown','ArrowUp','ArrowDown','Home','End','a','F1']) {
    eq(ev(k, { alt: true }), null, `Alt+${k} sends nothing (reserved for scrollback)`);
  }
  eq(ev('a', { meta: true }), null, 'Meta+a sends nothing');
}

// ── 7. Layout geometry ──────────────────────────────────────────────────────
// The bottom rows are sized in grid units because flex-grow alone could not
// align them (a 5-key row has 5 fewer gaps to give away than a 10-key row, so
// the arrows drifted, by an amount that varied with keyboard width). That only
// holds if every explicitly-sized row sums to exactly 10 units — which is the
// kind of thing that silently breaks when a key is added. Assert it.
//
// The key defs are pure data built by pure helpers, so the whole block from the
// first helper through the end of `views` evaluates standalone.
console.log('layout geometry');
{
  const from = SRC.indexOf('  const chr   =');
  if (from < 0) throw new Error('kbdmodtest: keyboard key-def helpers not found in public/main.js');
  const vstart = SRC.indexOf('const views = [', from);
  if (vstart < 0) throw new Error('kbdmodtest: const views not found in public/main.js');
  let depth = 0, vend = -1;
  for (let j = SRC.indexOf('[', vstart); j < SRC.length; j++) {
    if (SRC[j] === '[') depth++;
    else if (SRC[j] === ']' && --depth === 0) { vend = j + 1; break; }
  }
  if (vend < 0) throw new Error('kbdmodtest: unbalanced brackets reading const views');
  const views = new Function(SRC.slice(from, vend) + '; return views;')();

  const label = (k) => k.blank ? '·' : k.t;
  views.forEach((v, vi) => {
    if (v.kind !== 'rows') return;
    v.rows.forEach((row, ri) => {
      const sized = row.filter((k) => k.u).length;
      if (sized === 0) {
        // An all-default row: every key flexes equally, so it self-aligns.
        // The letter rows are 10 or 9 wide; anything else is a mistake.
        const ok = row.length === 10 || row.length === 9;
        if (!ok) { fail++; console.log(`  FAIL view ${vi+1} row ${ri+1}: ${row.length} unsized keys`); }
        else pass++;
        return;
      }
      // A partially-sized row carries sized keys plus exactly ONE flexible key
      // that soaks up the remainder — space on view 1, Tab on view 2. More than
      // one means a key was added without a width, which quietly throws the
      // row's alignment out; the sized keys must also leave room for the filler.
      const unsized = row.filter((k) => !k.u);
      // Fractional units, so compare with a tolerance rather than exactly.
      const units = Math.round(row.reduce((n, k) => n + (k.u || 0), 0) * 1000) / 1000;
      if (unsized.length === 0) {
        eq(units, 10, `view ${vi+1} row ${ri+1} sums to 10 units [${row.map(label).join(' ')}]`);
      } else if (unsized.length === 1) {
        if (units > 0 && units < 10) {
          pass++;
        } else {
          fail++;
          console.log(`  FAIL view ${vi+1} row ${ri+1}: sized keys total ${units} units, ` +
                      `leaving no room for the flexible "${label(unsized[0])}"`);
        }
      } else {
        fail++;
        console.log(`  FAIL view ${vi+1} row ${ri+1}: ${unsized.length} unsized keys ` +
                    `(${unsized.map(label).join(' ')}) mixed with sized ones`);
      }
    });
  });

  // View 3's rows 4/5 are equal-width and equal-length, so column index is
  // position: ↑ must sit above ↓, PgUp above ←, PgDn above →.
  const posOf = (v, ri, t) => views[v].rows[ri].findIndex((k) => k.t === t);
  eq(views[2].rows[3].length, views[2].rows[4].length,
     'view 3 rows 4 and 5 have the same key count, so columns line up');
  eq(posOf(2, 3, '↑'),    posOf(2, 4, '↓'), 'view 3 ↑ directly above ↓');
  eq(posOf(2, 3, 'PgUp'), posOf(2, 4, '←'), 'PgUp directly above ←');
  eq(posOf(2, 3, 'PgDn'), posOf(2, 4, '→'), 'PgDn directly above →');
  eq(posOf(2, 4, '↓') - posOf(2, 4, '←'), 1, '← ↓ → are contiguous');
  eq(posOf(2, 4, '→') - posOf(2, 4, '↓'), 1, 'and in order');

  // Label length is what sets the floor on key width. Anything with a 4-char
  // label must be at least WIDE, or it overflows its button on a phone — the
  // regression this sizing pass exists to prevent.
  const MIN_FOR_4CHAR = 1.25;
  for (const [vi, v] of views.entries()) {
    if (v.kind !== 'rows') continue;
    for (const [ri, row] of v.rows.entries()) {
      for (const k of row) {
        if (k.blank || !k.t || k.t.length < 4) continue;
        if (k.u == null) continue;              // unsized keys flex to fill
        if (k.u + 1e-9 < MIN_FOR_4CHAR) {
          fail++;
          console.log(`  FAIL view ${vi+1} row ${ri+1}: "${k.t}" is ${k.u} units, ` +
                      `needs >= ${MIN_FOR_4CHAR} for a ${k.t.length}-character label`);
        } else pass++;
      }
    }
  }

  // Every key must be able to produce bytes: either literal `s` or a name that
  // namedSeq() actually resolves. A typo'd name would send nothing at all,
  // which is precisely the failure mode the audit found with the F-keys.
  const allKeys = [];
  for (const v of views) {
    if (v.kind === 'rows') for (const r of v.rows) allKeys.push(...r);
    else allKeys.push(...v.num, ...v.nav, ...v.foot);
  }
  for (const k of allKeys) {
    // Keys that change the panel or hold a modifier send nothing by design.
    // `goto` is the direct jump to the numpad view, and is here for the same
    // reason `cycle` is.
    if (k.blank || k.cycle || k.mod || k.alt || k.goto != null) continue;
    if (k.n != null) {
      if (namedSeq(k.n, 0, 0) === null) {
        fail++; console.log(`  FAIL key "${k.t}" names ${k.n}, which namedSeq() does not resolve`);
      } else pass++;
    } else if (typeof k.s === 'string' && k.s.length > 0) pass++;
    else { fail++; console.log(`  FAIL key "${k.t}" sends nothing`); }
  }

  // The audit's other headline: all 95 printable ASCII must stay reachable.
  const printable = new Set();
  for (const k of allKeys) if (typeof k.s === 'string' && k.s.length === 1) printable.add(k.s);
  const missing = [];
  for (let i = 0x20; i <= 0x7E; i++) {
    const ch = String.fromCharCode(i);
    if (!printable.has(ch) && !printable.has(ch.toLowerCase()) && !printable.has(ch.toUpperCase()))
      missing.push(ch);
  }
  eq(missing.join(''), '', 'all 95 printable ASCII still reachable on-screen');

  // The view-changing keys. `goto` names the view it lands on, so a renumbering
  // of `views` that left it pointing at the wrong panel is caught here rather
  // than by someone tapping it.
  const gotos = allKeys.filter((k) => k.goto != null);
  eq(gotos.length, 1, 'exactly one direct view-jump key');
  eq(gotos[0].t, '#', 'the jump key is labelled #');
  eq(views[gotos[0].goto].kind, 'pads', 'and it lands on the numpad view');
  eq(views[0].rows[4].some((k) => k.goto != null), true,
     'the jump key is on view 1, where the three-press walk to the numpad was');
  // The cycle key is one key shown on every view; its label must not drift on
  // any of them. Behaviour, not wording: a second CYCLE def with its own label
  // is exactly the drift this catches.
  const cycles = allKeys.filter((k) => k.cycle);
  eq(cycles.length, 4, 'one cycle key per view');
  eq(new Set(cycles.map((k) => k.t)).size, 1, 'all four are the same key def');
}

// ── A long press only completes while the finger is still down ──────────────
// The reported failure: on a phone, embedded, the cycle key and both modifiers
// latched on a single tap. All three are exactly the keys that arm a long
// press, and `#` — the one view key with no hold — was never affected. Touch
// implicitly captures the pointer to the BUTTON, and render() destroys that
// button inside the same handler, so the release had nowhere to go and the
// timer promoted a press nobody held.
//
// Two properties are asserted here. The hold is captured by the keyboard ROOT,
// which render() empties but never replaces, so the timer can ask live state
// (hasPointerCapture) rather than trust that a cancel event was delivered; and
// one press supersedes the last, so a release that never arrived cannot poison
// the presses after it. Both for the cycle key and for a modifier, since the
// two paths reach this same plumbing.
console.log('keyboard long press');
{
  const makeHold = new Function('LOCK_MS', 'LOCK_SLOP', 'navigator', 'render',
                                'kbdEl', 'setTimeout', 'clearTimeout', [
    'let holdTimer = null, holdX = 0, holdY = 0;',
    'let holdId = null, holdDown = false;',
    extractFn('cancelKeyHold'), extractFn('releaseKeyPointer'), extractFn('startHold'),
    'return { startHold, releaseKeyPointer };',
  ].join('\n'));

  // A rig with the timer, and the browser's capture state, under the test's
  // control rather than the clock's and the platform's.
  function rig() {
    let timer = null;
    const captured = new Set();
    const kbdEl = {
      setPointerCapture: (id) => captured.add(id),
      hasPointerCapture: (id) => captured.has(id),
    };
    const api = makeHold(550, 10, {}, () => {}, kbdEl,
      (fn) => { timer = fn; return 1; }, () => { timer = null; });
    api.captured = captured;
    api.fire = () => { const t = timer; timer = null; if (t) t(); };
    return api;
  }

  for (const what of ['cycle', 'modifier']) {
    const down = { pointerId: 1, clientX: 0, clientY: 0 };

    // The normal path is unchanged: finger still down at LOCK_MS, promote runs.
    let promoted = false, h = rig();
    h.startHold(down, () => { promoted = true; });
    eq(h.captured.has(1), true, `${what}: the hold is captured by the keyboard root`);
    h.fire();
    eq(promoted, true, `${what}: a genuine hold still promotes`);

    // A release that DID arrive, by any of the sources — including the ones
    // that carry no pointerId at all (touchend, touchcancel, blur).
    promoted = false; h = rig();
    h.startHold(down, () => { promoted = true; });
    h.releaseKeyPointer();
    h.fire();
    eq(promoted, false, `${what}: no promote once the pointer has been released`);

    // The failure itself: every release event goes missing, so nothing tells
    // this code the finger is up. Capture has still lapsed, and that is what
    // the timer consults.
    promoted = false; h = rig();
    h.startHold(down, () => { promoted = true; });
    h.captured.clear();                    // the browser dropped the capture
    h.fire();
    eq(promoted, false, `${what}: no promote once the capture has lapsed, with no event`);

    // A release for some OTHER pointer must not cancel this hold.
    promoted = false; h = rig();
    h.startHold(down, () => { promoted = true; });
    h.releaseKeyPointer({ pointerId: 7 });
    h.fire();
    eq(promoted, true, `${what}: another pointer's release leaves this hold alone`);

    // And the anti-poisoning rule: a first press whose release never arrived
    // must not make the NEXT press promote. The second press supersedes it.
    promoted = false; h = rig();
    h.startHold({ pointerId: 1, clientX: 0, clientY: 0 }, () => {});
    h.captured.clear();                    // that pointer is long gone
    h.releaseKeyPointer();                 // the pointerdown-capture listener
    h.startHold({ pointerId: 2, clientX: 0, clientY: 0 }, () => { promoted = true; });
    h.releaseKeyPointer({ pointerId: 2 }); // released well before LOCK_MS
    h.fire();
    eq(promoted, false, `${what}: a stale press does not promote the next one`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
