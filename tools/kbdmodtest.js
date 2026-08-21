#!/usr/bin/env node
// Unit test for the keyboard's byte sequences and its sticky-modifier state
// machine, both in public/main.js.
//
// Two things are under test and they matter for different reasons:
//
//  1. namedSeq()/ctrlChar() — the ONE place that decides what bytes a key sends.
//     Both the physical path (keyToSeq) and the on-screen path (keySeq) call
//     them, which is the whole point: a physical F5 and an on-screen F5 cannot
//     drift apart. The audit that prompted this work found exactly that class of
//     bug — the on-screen keyboard had F1–F12 and keyToSeq returned null for
//     them — so the sequences get asserted against literal expected bytes here
//     rather than against a second copy of the same table.
//
//  2. modTap/modHold/modConsume/modClear — the tap/long-press/lock transitions.
//     Pure functions over an explicit state object precisely so they can be
//     driven with no DOM and no timers.
//
// main.js runs top-to-bottom against a live DOM and an AudioContext, so it
// can't be required; the declarations are extracted by name, the same technique
// tools/bbslabeltest.js and tools/sharelinktest.js use. Rename one and the
// extraction throws instead of silently testing a stale copy.
//
//   node tools/kbdmodtest.js

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'main.js'), 'utf8');

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
  "return { namedSeq, ctrlChar, keyToSeq, newModState, modTap, modHold, modConsume, modClear, modReleaseLocks, modActive, altAccept };",
].join('\n'))();

const { namedSeq, ctrlChar, keyToSeq, newModState, modTap, modHold, modReleaseLocks,
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

// ── 1. Unmodified sequences must match what the app shipped before ──────────
// These are the bytes boards have been receiving; the refactor must not move
// them. Home/End are the VT220 tilde forms on purpose, not ESC [ H / ESC [ F.
console.log('unmodified sequences (must be unchanged from the pre-refactor app)');
eq(namedSeq('Enter', 0, 0),      '\r',        'Enter');
eq(namedSeq('Backspace', 0, 0),  '\x7F',      'Backspace stays DEL');
eq(namedSeq('Escape', 0, 0),     '\x1B',      'Escape');
eq(namedSeq('Tab', 0, 0),        '\t',        'Tab');
eq(namedSeq('Delete', 0, 0),     '\x1B[3~',   'Delete');
eq(namedSeq('Home', 0, 0),       '\x1B[1~',   'Home');
eq(namedSeq('End', 0, 0),        '\x1B[4~',   'End');
eq(namedSeq('ArrowUp', 0, 0),    '\x1B[A',    'ArrowUp');
eq(namedSeq('ArrowDown', 0, 0),  '\x1B[B',    'ArrowDown');
eq(namedSeq('ArrowRight', 0, 0), '\x1B[C',    'ArrowRight');
eq(namedSeq('ArrowLeft', 0, 0),  '\x1B[D',    'ArrowLeft');

// ── 2. The keys the audit found unreachable ─────────────────────────────────
console.log('keys the audit reported as null / unreachable');
eq(namedSeq('F1', 0, 0),  '\x1BOP',    'F1 (SS3)');
eq(namedSeq('F4', 0, 0),  '\x1BOS',    'F4 (SS3)');
eq(namedSeq('F5', 0, 0),  '\x1B[15~',  'F5');
eq(namedSeq('F10', 0, 0), '\x1B[21~',  'F10');
eq(namedSeq('F11', 0, 0), '\x1B[23~',  'F11');
eq(namedSeq('F12', 0, 0), '\x1B[24~',  'F12');
eq(namedSeq('Insert', 0, 0),   '\x1B[2~', 'Insert');
eq(namedSeq('PageUp', 0, 0),   '\x1B[5~', 'PageUp');
eq(namedSeq('PageDown', 0, 0), '\x1B[6~', 'PageDown');
eq(namedSeq('Break', 0, 0),    '\xFF\xF3', 'BRK = telnet IAC BRK');
// Every F-key must be distinct — a duplicated table entry is the easy typo here.
{
  const seqs = new Set();
  for (let i = 1; i <= 12; i++) seqs.add(namedSeq('F' + i, 0, 0));
  eq(seqs.size, 12, 'F1–F12 are twelve distinct sequences');
}

// ── 3. Modifier encoding: n = 1 + Shift(1) + Ctrl(4) ────────────────────────
console.log('modifier encoding');
eq(namedSeq('Tab', 0, 1), '\x1B[Z',      'Shift+Tab is the classic ESC [ Z, not the modifier form');
eq(namedSeq('Tab', 1, 0), '\x1B[1;5I',   'Ctrl+Tab');
eq(namedSeq('F1', 1, 0),  '\x1B[1;5P',   'Ctrl+F1 promotes SS3 to CSI');
eq(namedSeq('F1', 0, 1),  '\x1B[1;2P',   'Shift+F1');
eq(namedSeq('F1', 1, 1),  '\x1B[1;6P',   'Ctrl+Shift+F1');
eq(namedSeq('F5', 1, 0),  '\x1B[15;5~',  'Ctrl+F5');
eq(namedSeq('F5', 0, 1),  '\x1B[15;2~',  'Shift+F5');
eq(namedSeq('F5', 1, 1),  '\x1B[15;6~',  'Ctrl+Shift+F5');
eq(namedSeq('ArrowLeft', 1, 0),  '\x1B[1;5D', 'Ctrl+Left (word-left)');
eq(namedSeq('ArrowRight', 1, 0), '\x1B[1;5C', 'Ctrl+Right');
eq(namedSeq('ArrowUp', 0, 1),    '\x1B[1;2A', 'Shift+Up');
eq(namedSeq('ArrowUp', 1, 1),    '\x1B[1;6A', 'Ctrl+Shift+Up');
eq(namedSeq('Delete', 0, 1),     '\x1B[3;2~', 'Shift+Delete');
eq(namedSeq('PageUp', 1, 0),     '\x1B[5;5~', 'Ctrl+PageUp');
eq(namedSeq('Home', 1, 1),       '\x1B[1;6~', 'Ctrl+Shift+Home');
// A modifier must never silently vanish: modified != unmodified, everywhere.
for (const name of ['F1','F5','F12','Insert','Delete','Home','End','PageUp',
                    'PageDown','ArrowUp','ArrowDown','ArrowLeft','ArrowRight']) {
  const base = namedSeq(name, 0, 0);
  for (const [c, s, lbl] of [[1,0,'ctrl'],[0,1,'shift'],[1,1,'ctrl+shift']]) {
    if (namedSeq(name, c, s) === base) {
      fail++; console.log(`  FAIL ${lbl}+${name} is identical to unmodified`);
    } else pass++;
  }
}
// Non-keys fall through so the caller can treat them as ordinary characters.
eq(namedSeq('a', 0, 0), null, 'a is not a named key');
eq(namedSeq('1', 1, 0), null, '1 is not a named key');

// ── 4. Ctrl on characters — the whole 0x00–0x1F range plus DEL ──────────────
console.log('control characters');
eq(ctrlChar('c'), '\x03', 'Ctrl-c (abort)');
eq(ctrlChar('C'), '\x03', 'Ctrl-C — case-insensitive');
eq(ctrlChar('a'), '\x01', 'Ctrl-a');
eq(ctrlChar('z'), '\x1A', 'Ctrl-z');
eq(ctrlChar('h'), '\x08', 'Ctrl-h = BS, the route to 0x08 the audit wanted');
eq(ctrlChar('s'), '\x13', 'Ctrl-s (XOFF)');
eq(ctrlChar('q'), '\x11', 'Ctrl-q (XON)');
eq(ctrlChar('@'), '\x00', 'Ctrl-@ = NUL');
eq(ctrlChar(' '), '\x00', 'Ctrl-space = NUL');
eq(ctrlChar('['), '\x1B', 'Ctrl-[ = ESC');
eq(ctrlChar('\\'),'\x1C', 'Ctrl-\\ = FS');
eq(ctrlChar(']'), '\x1D', 'Ctrl-] = GS');
eq(ctrlChar('^'), '\x1E', 'Ctrl-^ = RS');
eq(ctrlChar('_'), '\x1F', 'Ctrl-_ = US');
eq(ctrlChar('?'), '\x7F', 'Ctrl-? = DEL');
eq(ctrlChar('5'), null,   'Ctrl-5 has no control form');
eq(ctrlChar('ab'), null,  'multi-char input rejected');
// The audit's headline claim was that no control character was reachable.
// Assert the converse: every byte 0x00–0x1F is produced by some key.
{
  const reached = new Set();
  for (const ch of '@ abcdefghijklmnopqrstuvwxyz[\\]^_') {
    const c = ctrlChar(ch);
    if (c !== null) reached.add(c.charCodeAt(0));
  }
  const missing = [];
  for (let i = 0x00; i <= 0x1F; i++) if (!reached.has(i)) missing.push(i);
  eq(missing.join(','), '', 'every control code 0x00–0x1F is reachable');
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
  // Long-pressing ⇧# locks the view without arming anything.
  const st = newModState();
  st.viewLocked = true;
  eq(st.ctrl, 'off',  'a view lock alone arms no modifier');
  eq(st.shift, 'off', 'nor shift');
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

// ── 6. Composition: what the on-screen keyboard actually emits ──────────────
// Mirrors keySeq()'s logic against the state machine, end to end.
console.log('composed on-screen presses');
{
  const send = (k, st) => {
    const ctrl = modActive(st, 'ctrl'), shift = modActive(st, 'shift');
    if (k.n) return namedSeq(k.n, ctrl, shift);
    if (ctrl) { const c = ctrlChar(k.s); if (c !== null) return c; }
    return k.s;
  };
  const st = newModState();

  modTap(st, 'ctrl');
  eq(send({ s: 'c' }, st), '\x03', 'armed Ctrl then C sends ^C');
  modConsume(st);
  eq(send({ s: 'c' }, st), 'c', 'and the next C is a plain c again');

  modTap(st, 'shift');
  eq(send({ n: 'Tab' }, st), '\x1B[Z', 'armed Shft then Tab sends ESC [ Z');
  eq(send({ s: 'a' }, st), 'a', 'Shft alone on a printable is a no-op');
  modConsume(st);

  modTap(st, 'ctrl'); modHold(st, 'ctrl');
  eq(send({ s: '[' }, st), '\x1B', 'locked Ctrl: ^[');
  modConsume(st);
  eq(send({ s: '\\' }, st), '\x1C', 'locked Ctrl survives: ^\\');
  modConsume(st);
  eq(send({ s: ']' }, st), '\x1D', 'and again: ^]');
  modConsume(st);
  modTap(st, 'shift');
  eq(send({ n: 'ArrowLeft' }, st), '\x1B[1;6D', 'locked Ctrl + armed Shft on Left');
  modConsume(st);
  eq(send({ n: 'ArrowLeft' }, st), '\x1B[1;5D', 'shift fell away, ctrl stayed');
  eq(send({ n: 'Break' }, st), '\xFF\xF3', 'BRK ignores modifiers');
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
  eq(enter('065')[0], 65,  '065 -> 0x41 "A"');
  eq(enter('219')[0], 219, '219 -> █ (CP437 full block)');
  eq(enter('176')[0], 176, '176 -> ░');
  eq(enter('186')[0], 186, '186 -> ║ (box drawing, the point of the feature)');
  eq(enter('000')[0], 0,   '000 -> NUL');
  eq(enter('255')[0], 255, '255 -> top of the range');
  eq(enter('256')[0], null, '256 is out of range and sends nothing');
  eq(enter('300')[0], null, '300 discarded rather than wrapped to 44');
  eq(enter('999')[0], null, '999 discarded');

  // Partial entries commit nothing and keep accumulating.
  let d = '';
  let r = altAccept(d, '0'); eq(r.byte, null, 'one digit sends nothing');
  eq(r.digits, '0', 'and accumulates');
  r = altAccept(r.digits, '6'); eq(r.byte, null, 'two digits send nothing');
  eq(r.digits, '06', 'still accumulating');
  r = altAccept(r.digits, '5'); eq(r.byte, 65, 'the third digit commits');
  eq(r.digits, null, 'and disarms');

  // Leading zeros are required, so 65 typed as two digits must not fire.
  eq(altAccept(altAccept('', '6').digits, '5').byte, null,
     '"65" alone does not commit — three digits always');

  // Two codes back to back.
  const two = enter('219176');
  eq(two.length, 2, 'two consecutive codes');
  eq(two[0] + ',' + two[1], '219,176', 'both correct');
}

// ── 6b. The physical path (keyToSeq) ────────────────────────────────────────
// The audit's second half was all about this function returning null. Drive it
// with plain event-shaped objects — it only ever reads key/ctrlKey/shiftKey/
// altKey/metaKey.
console.log('physical keyboard (keyToSeq)');
{
  const ev = (key, m = {}) => keyToSeq({
    key, ctrlKey: !!m.ctrl, shiftKey: !!m.shift, altKey: !!m.alt, metaKey: !!m.meta });

  // Previously null — "a physical keyboard cannot send a function key at all".
  eq(ev('F1'),  '\x1BOP',   'F1 no longer falls through to null');
  eq(ev('F12'), '\x1B[24~', 'F12');
  eq(ev('Insert'),   '\x1B[2~', 'Insert');
  eq(ev('PageUp'),   '\x1B[5~', 'PageUp now reaches the BBS');
  eq(ev('PageDown'), '\x1B[6~', 'PageDown now reaches the BBS');
  eq(ev('Pause', { ctrl: true }), '\xFF\xF3', 'Ctrl+Pause sends BRK');

  // Ctrl coverage the old switch lacked.
  eq(ev('c', { ctrl: true }), '\x03', 'Ctrl+C');
  eq(ev('@', { ctrl: true }), '\x00', 'Ctrl+@ = NUL (was null)');
  eq(ev(' ', { ctrl: true }), '\x00', 'Ctrl+Space = NUL (was null)');
  eq(ev('^', { ctrl: true }), '\x1E', 'Ctrl+^ = RS (was null)');
  eq(ev('_', { ctrl: true }), '\x1F', 'Ctrl+_ = US (was null)');
  eq(ev('?', { ctrl: true }), '\x7F', 'Ctrl+? = DEL (was null)');
  eq(ev('[', { ctrl: true }), '\x1B', 'Ctrl+[ still ESC');

  // Modifiers reach the named keys now, on the same encoding as on-screen.
  eq(ev('Tab', { shift: true }),       '\x1B[Z',    'Shift+Tab unchanged');
  eq(ev('ArrowLeft', { ctrl: true }),  '\x1B[1;5D', 'Ctrl+Left');
  eq(ev('F5', { ctrl: true, shift: true }), '\x1B[15;6~', 'Ctrl+Shift+F5');

  // Shift+arrows and Shift+Home/End used to be eaten by scrollback and could
  // never be sent; freeing them was the point of moving scrollback onto Alt.
  eq(ev('ArrowUp', { shift: true }), '\x1B[1;2A', 'Shift+Up is sendable now');
  eq(ev('Home', { shift: true }),    '\x1B[1;2~', 'Shift+Home is sendable now');

  // Alt belongs to scrollback and must never produce bytes, or an Alt+PgUp
  // would both scroll and type.
  for (const k of ['PageUp','PageDown','ArrowUp','ArrowDown','Home','End','a','F1']) {
    eq(ev(k, { alt: true }), null, `Alt+${k} sends nothing (reserved for scrollback)`);
  }
  eq(ev('a', { meta: true }), null, 'Meta+a sends nothing');

  // Ordinary typing is untouched.
  eq(ev('a'), 'a', 'plain a');
  eq(ev('A', { shift: true }), 'A', 'Shift+A');
  eq(ev(' '), ' ', 'space');
  eq(ev('Enter'), '\r', 'Enter');
  eq(ev('Backspace'), '\x7F', 'Backspace still DEL');
  eq(ev('Shift'), null, 'a bare modifier keydown sends nothing');
  eq(ev('CapsLock'), null, 'CapsLock sends nothing');
  eq(ev('F13'), null, 'an unmapped key still returns null rather than garbage');
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

  eq(views.length, 4, 'four views');

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

  // ⇧# is the key you press most often and it is in the same place on every
  // rows-view, so it must also be the same SIZE on every rows-view — a shrunken
  // one on a single panel is a thumb-target regression you only notice in use.
  {
    const widths = new Set();
    for (const v of views) {
      if (v.kind !== 'rows') continue;
      for (const row of v.rows) for (const k of row) if (k.cycle) widths.add(k.u);
    }
    eq([...widths].join(','), '1.25', '⇧# is 1.25 units on every rows-view');
  }

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

  // Ctrl replaces ⌫ in its slot on views 2 and 3, so the reach is unchanged.
  eq(posOf(1, 3, 'Ctrl'), posOf(0, 3, '⌫'), 'view 2 Ctrl sits in view 1\'s ⌫ slot');
  eq(posOf(2, 3, 'Ctrl'), posOf(0, 3, '⌫'), 'view 3 Ctrl sits in view 1\'s ⌫ slot');

  // The numpad grids must stay full or the CSS grid reflows into a mess.
  const pads = views[3];
  eq(pads.num.length, 16, 'numpad is 4x4');
  eq(pads.nav.length, 12, 'nav pad is 3x4');
  eq(pads.num[12].t, '=', '= fills the old blank under 1');
  eq(pads.nav[7].t, 'BRK', 'BRK took ↑\'s slot');
  eq(pads.nav.filter((k) => k.t === '↑' || k.t === '←' || k.t === '↓' || k.t === '→').length,
     0, 'no arrows left on the numpad');
  eq(pads.nav[9].t,  'Alt',  'Alt fills the slot under Esc');
  eq(pads.nav[9].alt, true,  'and is flagged as the code-entry key');
  eq(pads.nav[10].t, 'Ctrl', 'Ctrl far right, row 4');
  eq(pads.nav[11].t, 'Shft', 'Shft far right, row 4');
  // Alt code entry needs digits on the same view, since arming it does not and
  // must not change panel.
  eq(pads.num.filter((k) => k.s >= '0' && k.s <= '9').length, 10,
     'all ten digits are on the numpad view with Alt');

  // Every key must be able to produce bytes: either literal `s` or a name that
  // namedSeq() actually resolves. A typo'd name would send nothing at all,
  // which is precisely the failure mode the audit found with the F-keys.
  const allKeys = [];
  for (const v of views) {
    if (v.kind === 'rows') for (const r of v.rows) allKeys.push(...r);
    else allKeys.push(...v.num, ...v.nav, ...v.foot);
  }
  for (const k of allKeys) {
    if (k.blank || k.cycle || k.mod || k.alt) continue;
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
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
