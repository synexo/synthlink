#!/usr/bin/env node
// Unit tests for SynthLink's embedding: the frame-URL and snippet builders in
// public/main.js, the speed menu the share panel's embed view clones from the
// header, the sub-view markup in public/index.html, and public/embed.js itself.
//
// Same extraction trick as tools/tests/sharelinktest.js — main.js is a browser
// module that runs top-to-bottom against a live DOM and an AudioContext, so it
// can't be required. The pure builders are pulled out of the source by name and
// run here; `fillSpeeds` lives inside the share panel's IIFE and closes over
// `protocolEl`, `eSpeed` and `DEFAULT_SPEED`, so it is extracted and handed
// those as parameters. Rename any of them and the extraction throws rather than
// quietly testing a stale copy.
//
// The negative cases carry the brief: an embed must never be handed the telnet
// bypass speed (it is gated one dial server-wide, so an embed dialling through
// it queues behind every other embed anywhere), the snippets are MARKUP and must
// be escaped as such, and `allow="autoplay; fullscreen"` must survive on both —
// without it the speaker and the fullscreen toggle stay gated inside the frame.
//
//   node tools/tests/embedtest.js

const fs = require('fs');
const path = require('path');

const MAIN = path.join(__dirname, '..', '..', 'public', 'main.js');
const INDEX = path.join(__dirname, '..', '..', 'public', 'index.html');
const EMBED = path.join(__dirname, '..', '..', 'public', 'embed.js');
const SRC = fs.readFileSync(MAIN, 'utf8');
const HTML = fs.readFileSync(INDEX, 'utf8');
const EJS = fs.readFileSync(EMBED, 'utf8');
// Assertions about what embed.js DOES read this comment-stripped copy: its
// header explains at length what the file deliberately avoids — modules,
// postMessage — and naming a thing in prose is not shipping it.
const EJS_CODE = EJS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// `const NAME = <expression>;` over any number of lines, or `function NAME(…){}`.
//
// The const arm grows the slice a line at a time until it PARSES, rather than
// hunting for the terminating ';' with a character scan. embedAttr is a
// multi-line arrow chain whose regex literals contain a quote character
// (`/"/g`), and a hand-rolled scanner reads that as the start of a string and
// runs off the end of the file. The parser is already the authority on where a
// statement ends, so ask it.
function extract(name) {
  const cd = SRC.indexOf(`const ${name} = `);
  if (cd >= 0) {
    const lines = SRC.slice(cd).split('\n');
    for (let n = 1; n <= Math.min(lines.length, 60); n++) {
      const chunk = lines.slice(0, n).join('\n');
      if (!chunk.trimEnd().endsWith(';')) continue;
      try { new Function(chunk); return chunk; } catch (_) { /* keep growing */ }
    }
    throw new Error(`embedtest: could not read const ${name} from public/main.js`);
  }
  const start = SRC.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`embedtest: ${name} not found in public/main.js`);
  // Walk the parameter list to its closing paren first: a destructured parameter
  // closes a brace before the body is ever reached.
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
  throw new Error(`embedtest: unbalanced braces reading ${name}`);
}

const NAMES = ['DEFAULT_SPEED', 'speedToken', 'EMBED_ALLOW', 'EMBED_WIDTH',
               'EMBED_HEIGHT', 'embedAttr', 'embedConnectValue',
               'buildEmbedURL', 'buildEmbedSnippet', 'buildIframeSnippet'];
const { DEFAULT_SPEED, speedToken, EMBED_ALLOW, EMBED_WIDTH, EMBED_HEIGHT,
        embedAttr, embedConnectValue,
        buildEmbedURL, buildEmbedSnippet, buildIframeSnippet } =
  new Function([...NAMES.map(extract), `return { ${NAMES.join(', ')} };`].join('\n'))();

let pass = 0, fail = 0;
function eq(actual, expected, what) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  fail++;
  console.log(`  FAIL ${what}\n       expected ${e}\n       actual   ${a}`);
}
const ok = (cond, what) => eq(!!cond, true, what);

console.log('embedtest — embedding\n');

const O = 'https://x.example', P = '/';
const url = (o) => buildEmbedURL(O, P, o);

// ── buildEmbedURL: the frame's address, in the query language main.js reads ──
{
  const u = new URL(url({ host: 'bbs.example.org', port: '2003', speed: 'V32bis', connect: 'auto' }));
  eq(u.origin + u.pathname, 'https://x.example/', 'the frame loads the app itself');
  eq(u.searchParams.get('host'), 'bbs.example.org', 'host is written out');
  eq(u.searchParams.get('port'), '2003', 'port is written out');
  eq(u.searchParams.get('speed'), 'v32bis', 'speed is the canonical token');
  eq(u.searchParams.get('connect'), 'auto', 'auto dials on load with no prompt');
}
eq(new URL(url({ host: 'a.org', connect: 'prompt' })).searchParams.get('connect'), '1',
   'prompt is connect=1, the same value a share link writes');
eq(new URL(url({ host: 'a.org', connect: 'none' })).searchParams.has('connect'), false,
   'none writes no connect key at all — a terminal pointed at a board, waiting');
eq(new URL(url({ host: 'a.org', connect: '' })).searchParams.has('connect'), false,
   'an unset mode is none, never a silent auto');
eq(new URL(url({ host: 'a.org' })).searchParams.get('port'), '23',
   'port defaults to 23 and is still stated');
eq(new URL(url({ host: 'a.org', port: '23' })).searchParams.get('speed'),
   speedToken(DEFAULT_SPEED), 'no speed means the default speed, spelled out');
// The vocabulary is the share link's. A key here that parseShareParams does not
// read would be a second parameter language, which is the thing this avoids.
eq([...new URL(url({ host: 'a.org', connect: 'auto' })).searchParams.keys()].sort(),
   ['connect', 'host', 'port', 'speed'], 'no key beyond the four main.js parses');

// ── The default box ─────────────────────────────────────────────────────────
// A percentage HEIGHT resolves only against a containing block with a definite
// height; a frame dropped into an article has a parent of `auto`, so it would
// compute to `auto` and collapse to 150px. And a pixel height at or under 600
// trips the app's own short-viewport rule — a frame IS the viewport for the
// document inside it — after which the page scrolls and the on-screen keyboard
// stops shrinking the terminal.
ok(/vh$/.test(EMBED_HEIGHT), 'the default height is a viewport unit, not a percentage or a pixel count');
ok(parseInt(EMBED_HEIGHT, 10) * 10 > 600, 'and is tall enough to clear the short-viewport rule on a normal screen');
ok(EMBED_WIDTH.endsWith('%'), 'the default width is a percentage — widths resolve where heights do not');

// ── The wizard's modes are not the query's values ───────────────────────────
// The element copies attributes verbatim into the query, so a mode NAME reaching
// it would be an unrecognised value, which is falsy — the prompt an embedder
// asked for would never appear, and nothing would say so.
eq(embedConnectValue('auto'), 'auto', 'auto is spelled auto');
eq(embedConnectValue('prompt'), '1', 'prompt is spelled 1, never "prompt"');
eq(embedConnectValue('none'), '', 'none is spelled by absence');
eq(embedConnectValue(undefined), '', 'and so is an unset mode');

// ── The snippets are markup ─────────────────────────────────────────────────
const OPTS = { host: 'bbs.example.org', port: '2003', speed: 'V34',
               connect: 'auto', width: '90%', height: '90vh' };
const snip = buildEmbedSnippet('https://x.example/embed.js', OPTS);
const frame = buildIframeSnippet(url(OPTS), { ...OPTS, title: 'Board' });

ok(snip.includes('<script src="https://x.example/embed.js">'),
   'the element snippet carries the script that defines it');
// A module script is ALWAYS fetched in CORS mode, and an embed is cross-origin
// by definition, so the module form 404s nothing and fails everything: every
// real embedder saw Access-Control-Allow-Origin missing against a 200. It
// shipped that way once. Never again without a server header to match.
ok(!snip.includes('type="module"'),
   'and it is a CLASSIC script — a module would need a CORS header to load cross-origin');
ok(snip.includes('<synthlink-terminal '), 'and the element itself');
ok(snip.includes('host="bbs.example.org"'), 'element: destination host');
ok(snip.includes('port="2003"'), 'element: destination port');
ok(snip.includes('speed="v34"'), 'element: speed as the canonical token, the option value "V34" lower-cased');
ok(snip.includes('connect="auto"'), 'element: connect mode, in the query\'s spelling');
ok(snip.includes('height="90vh"'), 'element: a stated height, or the frame collapses');
ok(snip.includes('width="90%"'), 'element: a stated width');
ok(!snip.includes('<iframe'), 'the documented integration is the element, not raw iframe markup');
ok(buildEmbedSnippet('/embed.js', { host: 'a.org', connect: 'prompt' }).includes('connect="1"'),
   'element: prompt reaches the frame as connect=1, which is a value the page reads');
ok(!buildEmbedSnippet('/embed.js', { host: 'a.org', connect: 'none' }).includes('connect='),
   'element: none omits the attribute rather than shipping a blank one to fill in wrongly');

ok(frame.includes(`allow="${EMBED_ALLOW}"`), 'the fallback frame carries allow');
eq(EMBED_ALLOW, 'autoplay; fullscreen',
   'autoplay ungates the speaker in a nested context; fullscreen ungates the toggle');
// The width/height ATTRIBUTES are pixel counts and cannot carry 90% or 90vh, so
// the box goes in style — an iframe with height="90vh" is an iframe 150px tall.
ok(/style="[^"]*height:90vh/.test(frame), 'the fallback frame states its height in style, not the attribute');
ok(/style="[^"]*width:90%/.test(frame), 'and its width');
ok(!/\sheight="/.test(frame), 'no pixel-only height attribute to contradict it');
ok(/margin:0 auto/.test(frame), 'and it is centred, as the element centres itself');
ok(frame.includes('title="Board"'), 'the fallback frame is labelled');
ok(/src="[^"]*host=bbs\.example\.org[^"]*"/.test(frame), 'the fallback frame names the destination');
// A raw '&' between query keys is not valid in an attribute and some parsers
// swallow what follows it, which loses the speed and the connect mode silently.
ok(!/src="[^"]*&(?!amp;)/.test(frame), 'query separators are escaped — it is markup, not a link');
eq(embedAttr('a&b<c>"d"'), 'a&amp;b&lt;c&gt;&quot;d&quot;', 'attribute escaping covers & < > "');
eq(buildIframeSnippet('https://x.example/?host=a"onload="x', {}).includes('"onload="'), false,
   'a crafted destination cannot break out of the src attribute');

// Defaults, so a builder called with a blank box still yields pasteable markup.
ok(buildEmbedSnippet('/embed.js', { host: 'a.org' }).includes(`width="${EMBED_WIDTH}"`), 'element width defaults');
ok(buildIframeSnippet('/', {}).includes(`height:${EMBED_HEIGHT}`), 'iframe height defaults');

// ── fillSpeeds: cloned from the header menu, minus telnet bypass ────────────
{
  const fillSpeeds = new Function('protocolEl', 'eSpeed', 'DEFAULT_SPEED', 'document',
    `${extract('fillSpeeds')}\nreturn fillSpeeds;`);
  const mkSelect = () => {
    const el = { options: [], textContent: '', value: '',
                 appendChild(o) { this.options.push(o); } };
    return el;
  };
  const doc = { createElement: () => ({ value: '', textContent: '' }) };
  // The real menu, read out of index.html rather than restated here, so a
  // protocol added there is exercised without touching this file.
  const menu = [...HTML.matchAll(/<option value="([^"]+)"[^>]*>([^<]*)<\/option>/g)]
    .filter((m) => /^(V\d|Bell|direct)/.test(m[1]))
    .map((m) => ({ value: m[1], textContent: m[2] }));
  ok(menu.length >= 10, 'the header speed menu was found in index.html');
  ok(menu.some((o) => o.value === 'direct'), 'and it offers telnet bypass, which is the case under test');

  const sel = mkSelect();
  fillSpeeds({ options: menu }, sel, DEFAULT_SPEED, doc)('V32bis');
  eq(sel.options.some((o) => o.value === 'direct'), false,
     'telnet bypass is NOT offered to an embed — it is gated one dial server-wide');
  eq(sel.options.length, menu.length - 1, 'every other protocol is cloned, none invented');
  eq(sel.options.map((o) => o.value), menu.filter((o) => o.value !== 'direct').map((o) => o.value),
     'cloned in menu order, from the header menu, so a new protocol needs no edit here');
  eq(sel.value, 'V32bis', 'the current selection is prefilled');

  const sel2 = mkSelect();
  fillSpeeds({ options: menu }, sel2, DEFAULT_SPEED, doc)('direct');
  eq(sel2.value, DEFAULT_SPEED, 'a page on telnet bypass falls back to the default speed, not to blank');

  const sel3 = mkSelect();
  fillSpeeds({ options: menu }, sel3, DEFAULT_SPEED, doc)('V99nonesuch');
  eq(sel3.value, DEFAULT_SPEED, 'an unknown speed falls back rather than leaving the menu unset');
}

// ── The sub-view exists in the markup main.js reaches for ───────────────────
for (const id of ['shareview-link', 'shareview-embed', 'shareembedbtn', 'embedback',
                  'embedhost', 'embedport', 'embedspeed', 'embedconnect',
                  'embedwidth', 'embedheight', 'embedsnippet', 'embediframe',
                  'embedsnippetcopy', 'embediframecopy']) {
  ok(HTML.includes(`id="${id}"`), `index.html carries #${id}`);
}
ok(/id="shareview-embed"[^>]*hidden/.test(HTML), 'the embed view starts hidden — Share opens on the link view');
ok(/id="embedsnippet"[^>]*readonly/.test(HTML) && /id="embediframe"[^>]*readonly/.test(HTML),
   'both snippet fields are readonly, and selectable for the copy fallback');
{
  const modals = HTML.match(/id="share(modal|panel)"/g) || [];
  eq(modals.length, 2, 'one modal, one panel — the builder is a sub-view, not a second dialog');
  const opts = HTML.match(/id="embedconnect"[\s\S]*?<\/select>/)[0];
  // A press, not an automatic dial: an embed that dialled on scroll-past would
  // open a socket nobody asked for, and the press is also the gesture that lets
  // the audio start with the handshake.
  eq(/value="prompt"[^>]*selected/.test(opts), true, 'an embed defaults to a Connect prompt');
  eq((opts.match(/<option/g) || []).length, 3, 'three modes: prompt, auto, none');
}

// ── public/embed.js ─────────────────────────────────────────────────────────
ok(EJS.includes("customElements.define('synthlink-terminal'"), 'embed.js defines the element');
ok(EJS.includes("customElements.get('synthlink-terminal')"),
   'and guards the definition — a CMS that duplicates the tag must not throw');
ok(EJS_CODE.includes('document.currentScript'),
   'the frame origin comes from the script URL, never from an attribute');
// The classic-script rule, stated as code rather than as a comment: any of these
// makes the file a module again, and a module cannot load cross-origin without
// Access-Control-Allow-Origin.
ok(!/\bimport\s*[({.]/.test(EJS_CODE), 'no import — it would make this a module');
ok(!/^\s*export\b/m.test(EJS_CODE), 'no export — same');
ok(!EJS_CODE.includes('import.meta'), 'no import.meta — same, and it is a syntax error in a classic script');
ok(EJS.includes(`'${EMBED_ALLOW}'`), 'embed.js sets the same allow list the fallback snippet documents');
ok(/observedAttributes/.test(EJS) && /attributeChangedCallback/.test(EJS),
   'attributes are the whole API surface, and they reflect');
// It is served as .js, so lib/site.js performs no {{TOKEN}} substitution on it:
// a token left here would reach the embedder's page as literal braces.
ok(!/\{\{[A-Z_]+\}\}/.test(EJS_CODE), 'no {{TOKEN}} in a file that gets no substitution');
// Same rule the DSP bundle lives under, and for the same reason: this runs in
// someone else's page, where a Node-only reference is an immediate crash.
for (const bad of ['require(', 'process.', "'fs'", "'path'"]) {
  ok(!EJS_CODE.includes(bad), `no Node-only reference (${bad}) in a browser-served file`);
}
// postMessage would be a message contract to version. The attribute surface is
// the whole product until an embedder asks for more, and none has.
ok(!EJS_CODE.includes('postMessage'), 'no cross-frame message contract');
// The element and the snippet builders each hold the default box, because
// neither can import the other. They must agree: a snippet that states the
// default explicitly and an element that fills in a different one would differ
// only for the embedder who deleted an attribute.
ok(EJS_CODE.includes(`const WIDTH = '${EMBED_WIDTH}'`), 'embed.js defaults to the same width main.js writes');
ok(EJS_CODE.includes(`const HEIGHT = '${EMBED_HEIGHT}'`), 'embed.js defaults to the same height main.js writes');
ok(EJS_CODE.includes("margin = '0 auto'"), 'the element centres its frame');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
