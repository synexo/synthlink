// sinktest — the audio sink, in a real browser.
//
// The sink is the only part of the local audio path that cannot be tested in
// Node: it runs inside a real AudioContext. bustest covers everything upstream
// of it. What this asserts is the contract the bus depends on — that a sink can
// be built and that every source frame handed to it is retired exactly once, at
// whatever rate the device's audio unit runs.
//
// It runs against BOTH a loopback and a non-loopback address of this machine.
// Browsers treat the first as a secure origin and the second as insecure, and
// audio APIs differ across that line; a harness that only ever loads 127.0.0.1
// cannot see a failure that every phone on the LAN would hit. If this machine
// has no non-loopback address the second half reports SKIP rather than quietly
// not running.
//
// Needs Playwright: npm install --no-save playwright-core, PW_CHROMIUM=<binary>.
// Serves public/ over HTTP and closes the server on exit; this is not the
// WebSocket listener CLAUDE.md warns about, and it does not hang the sandbox.
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
const { chromium } = require('playwright-core');

const PUB = path.join(__dirname, '../../public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log(`  FAIL ${m}`); } };

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) if (ni.family === 'IPv4' && !ni.internal) return ni.address;
  }
  return null;
}

const srv = http.createServer((req, res) => {
  let p = req.url.split('?')[0];
  if (p === '/') p = '/index.html';
  fs.readFile(path.join(PUB, p), (e, d) => {
    if (e) { res.statusCode = 404; res.end(''); return; }
    res.setHeader('Content-Type', MIME[path.extname(p)] || 'application/octet-stream');
    res.end(d);
  });
});

srv.listen(0, '0.0.0.0', async () => {
  const port = srv.address().port;
  const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM });
  const errs = [];

  // Mirrors monitor._makeSink(): a ScriptProcessor pulling posted slices with
  // the same interpolating read. Kept in step with it by hand — main.js is a
  // module, so its `monitor` cannot be reached from here.
  async function probe(host) {
    const page = await browser.newPage();
    page.on('pageerror', (e) => errs.push(`${host}: ${e}`));
    await page.goto(`http://${host}:${port}/index.html`);
    const r = await page.evaluate(async () => {
      const out = { secure: window.isSecureContext };
      let ctx;
      try { ctx = new AudioContext({ sampleRate: 8000 }); } catch (_) { ctx = new AudioContext(); }
      out.rate = ctx.sampleRate;
      out.made = !!ctx.createScriptProcessor;
      if (!out.made) { await ctx.close(); return out; }
      const g = ctx.createGain();
      g.gain.value = 0;                     // silent: this measures, it does not listen
      g.connect(ctx.destination);
      const SRC = 8000, step = SRC / ctx.sampleRate;
      const q = [];
      let pos = 0, consumed = 0;
      const n = ctx.createScriptProcessor(1024, 1, 1);
      n.onaudioprocess = (e) => {
        const o = e.outputBuffer.getChannelData(0);
        for (let i = 0; i < o.length; i++) {
          while (q.length && Math.floor(pos) >= q[0].length) { pos -= q[0].length; q.shift(); }
          if (!q.length) { o[i] = 0; continue; }
          o[i] = q[0][Math.floor(pos)];
          pos += step; consumed += step;
        }
      };
      n.connect(g);
      // One second of 1800 Hz in 20 ms slices — the shape the pump posts in.
      for (let k = 0; k < 50; k++) {
        const pcm = new Float32Array(160);
        for (let i = 0; i < 160; i++) pcm[i] = Math.sin(2 * Math.PI * 1800 * (k * 160 + i) / SRC);
        q.push(pcm);
        await new Promise((res) => setTimeout(res, 20));
      }
      await new Promise((res) => setTimeout(res, 500));
      out.state = ctx.state;
      out.consumed = consumed;
      out.queued = q.reduce((a, sl) => a + sl.length, 0) - pos;
      await ctx.close();
      return out;
    });
    await page.close();
    return r;
  }

  console.log('sinktest — the audio sink, on both kinds of origin\n');

  const loop = await probe('127.0.0.1');
  ok(loop.secure === true, 'loopback is a secure origin');
  ok(loop.made === true, 'the sink can be built there');
  ok(loop.state === 'running', 'its context is running');
  // Every SOURCE frame handed over is retired exactly once, whatever the output
  // rate: no loss, no repeat, no drift. This is what the bus's clock relies on.
  ok(Math.abs(loop.consumed - 8000) <= 400,
     `at ${loop.rate} Hz out, 8000 source frames in, ${Math.round(loop.consumed)} retired`);
  ok(loop.queued < 400, `the queue drains rather than growing (${Math.round(loop.queued)} left)`);

  const lan = lanAddress();
  if (!lan) {
    console.log('  SKIP no non-loopback address here — insecure-origin half not run');
  } else {
    const ins = await probe(lan);
    ok(ins.secure === false, `${lan} is an insecure origin, as a phone on a LAN gets`);
    ok(ins.made === true, 'the sink can be built there too');
    ok(Math.abs(ins.consumed - 8000) <= 400,
       `and retires what it is given (${Math.round(ins.consumed)} of 8000)`);
  }

  ok(errs.length === 0, `no page errors (${errs.join('; ')})`);
  console.log(`\n${fail === 0 ? 'OK' : 'FAILED'} — ${pass} passed, ${fail} failed`);
  await browser.close();
  srv.close();
  process.exit(fail ? 1 : 0);
});
