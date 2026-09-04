// SynthLink — <synthlink-terminal>, the embed element.
//
// Served raw like public/fontmask.js: no bundling, no build step, and no
// {{TOKEN}} substitution either, because lib/site.js only rewrites .html. So
// nothing brand-shaped lives here — the host page supplies its own wording.
//
//   <script src="https://HOST/embed.js"></script>
//   <synthlink-terminal host="bbs.example.org" port="23"
//                       speed="v32bis" connect="1" width="90%" height="90vh">
//   </synthlink-terminal>
//
// A CLASSIC script, deliberately, and this is the one thing here that must not
// be modernised. A `type="module"` script is ALWAYS fetched in CORS mode, so a
// cross-origin module needs `Access-Control-Allow-Origin` on the response — and
// an embed is cross-origin by definition. Shipped as a module it failed for
// every embedder with "Access-Control-Allow-Origin missing" (Chromium) or
// "Module source URI is not allowed" (Firefox), on a 200 response, while
// same-origin testing showed nothing at all. A classic script is fetched in
// no-cors mode and needs no header, which is why third-party widgets have always
// been classic scripts. It also means no `import`, no `export` and no
// `import.meta` in this file, ever: any of them makes it a module again.
//
// The attribute VALUES are the query values, verbatim — `connect="1"` is a
// Connect prompt and `connect="auto"` dials on load, exactly as in a link.
// There is no mode vocabulary of the element's own to learn or to mistype.
//
// It is an iframe, and that is not a compromise. The page owns a canvas
// terminal, document-level key handling, @font-face faces and a glyph atlas, a
// WebSocket, an AudioContext and localStorage preferences, and `monitor`,
// `prefs` and `renderer` are module-level singletons — two instances in one DOM
// would fight over every one of them. The frame gets the isolation for free,
// which is the same reason maps, video players and payment fields still use one.
// Shadow DOM is not an alternative: it scopes CSS and nothing else — not the
// globals, not the key handling, not autoplay policy, not the origin.
//
// The element is the API. There is deliberately no connect() method and no
// carrier event: both would mean postMessage across the frame boundary and a
// message contract to version, and the attribute surface is the whole product
// until an embedder asks for more.

// The frame's parameters, in the query vocabulary public/main.js already parses
// (parseShareParams is the authority on what each accepts). Nothing here invents
// a second one: the element's job is to spell the URL, not to define it.
const PARAMS = ['host', 'port', 'speed', 'connect'];
const BOX = ['width', 'height'];

// A nested browsing context is gated harder than a top-level one. Without
// `autoplay` the visitor's click inside the frame cannot ungate the speaker;
// without `fullscreen` the toggle is refused.
const ALLOW = 'autoplay; fullscreen';

// The app's own URL, taken from where this script was loaded from — so the
// embedder states the origin once, in the script tag, and cannot state it
// inconsistently. `.` resolves to the directory embed.js sits in, which is the
// directory index.html is served from.
//
// `document.currentScript` is the classic-script equivalent of `import.meta.url`
// and is only valid while the script is executing, which is why it is read here
// at top level and not inside the element. The fallback covers a page that
// re-executes this file some other way (injected, inlined, concatenated), where
// currentScript is null; a wrong origin there would be a frame that loads
// nothing, so it is worth the four lines.
const SELF = (document.currentScript && document.currentScript.src) || (() => {
  const tags = document.querySelectorAll('script[src]');
  for (let i = tags.length - 1; i >= 0; i--) {
    if (/\bembed\.js(\?|#|$)/.test(tags[i].src)) return tags[i].src;
  }
  return '';
})();
const APP = new URL('.', SELF || location.href).href;

// The default box. A percentage WIDTH resolves against a block's width, which is
// always definite, so 90% keeps the frame inside the embedder's column instead
// of overhanging it, and the leftover 10% is the centring.
//
// A percentage HEIGHT would not resolve: it needs a containing block with a
// definite height, and a frame dropped into an article has a parent of `auto` —
// the percentage computes to `auto` too and the frame collapses to the CSS
// default of 150px. `vh` always resolves. Pixels resolve as well but pick a
// number blind: at 600 or under, the app's short-viewport rule (`@media
// (max-height: 600px)`) takes over, the page inside scrolls and the on-screen
// keyboard stops shrinking the terminal. A frame IS the viewport for the
// document in it, so that fires on a 600px frame in a tall window exactly as it
// does in a 600px window. 90vh clears it on all but a very short screen, where
// the scrolling layout is the right answer anyway.
const WIDTH = '90%';
const HEIGHT = '90vh';

class SynthLinkTerminal extends HTMLElement {
  static get observedAttributes() { return [...PARAMS, ...BOX]; }

  connectedCallback() {
    if (!this._frame) {
      this.style.display = this.style.display || 'block';
      const f = document.createElement('iframe');
      f.setAttribute('allow', ALLOW);
      f.setAttribute('allowfullscreen', '');
      f.style.border = '0';
      f.style.display = 'block';
      // Centred in whatever the embedder gave it, which is what a frame narrower
      // than its column wants and costs nothing when it is not.
      f.style.margin = '0 auto';
      f.title = this.getAttribute('title') || 'Terminal';
      this._frame = f;
      this.appendChild(f);
    }
    this._apply();
  }

  attributeChangedCallback() { if (this._frame) this._apply(); }

  _url() {
    const q = new URLSearchParams();
    for (const name of PARAMS) {
      const v = (this.getAttribute(name) || '').trim();
      // An omitted `connect` is a terminal that waits, which is a real choice —
      // so an empty attribute writes nothing rather than a default.
      if (v) q.set(name, v);
    }
    const s = q.toString();
    return s ? `${APP}?${s}` : APP;
  }

  _apply() {
    const f = this._frame;
    // A terminal has no intrinsic aspect ratio, so a frame with no stated box
    // collapses. Any CSS length is honoured — the defaults are a starting point,
    // not a recommendation, and the app is responsive below whatever it is
    // given, including the 40-column and collapsed-scope layouts. A bare number
    // is pixels, which is what the HTML attribute of that name has always meant.
    const len = (name, dflt) => {
      const v = (this.getAttribute(name) || '').trim() || dflt;
      return /^\d+$/.test(v) ? `${v}px` : v;
    };
    f.style.width = len('width', WIDTH);
    f.style.height = len('height', HEIGHT);
    const src = this._url();
    // Only on a real change. Reassigning the same src reloads the frame, which
    // would drop a call in progress for nothing. A changed destination DOES drop
    // it, and that is the honest behaviour rather than something to paper over.
    if (f.getAttribute('src') !== src) f.setAttribute('src', src);
  }
}

// Defined once. A page that includes the script twice — two embeds, or a CMS
// that duplicates the tag — must not throw on the second.
// No `export` — see the header. An export statement would make this a module
// again, and a module cannot be loaded cross-origin without a CORS header.
if (!customElements.get('synthlink-terminal')) {
  customElements.define('synthlink-terminal', SynthLinkTerminal);
}
