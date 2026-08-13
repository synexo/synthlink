'use strict';
// Headless "browser": originate-side modem over a real WS to the server,
// dialing a telnet BBS. Proves the whole chain minus DOM rendering/Web Audio.
const WebSocket = require('ws');
require('../vendor/synthlink-config');
const { ModemDSP } = require('../vendor/src/dsp/ModemDSP');

const URL  = process.env.URL  || 'ws://localhost:8088';
const HOST = process.env.HOST || '127.0.0.1';
const PORT = process.env.BBS_PORT || '2323';

function floatToInt16(f32){const b=Buffer.allocUnsafe(f32.length*2);for(let i=0;i<f32.length;i++){let s=Math.max(-1,Math.min(1,f32[i]));b.writeInt16LE((s*32767)|0,i*2);}return b;}
function int16ToFloat(buf){const n=buf.length>>1,o=new Float32Array(n);for(let i=0;i<n;i++)o[i]=buf.readInt16LE(i*2)/32768;return o;}

const dsp = new ModemDSP('originate');
const ws  = new WebSocket(URL);
const rx  = [];
let connected = false;
const t0 = Date.now();

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'dial', host: HOST, port: PORT }));
  dsp.on('audioOut', f32 => { if (ws.readyState === WebSocket.OPEN) ws.send(floatToInt16(f32)); });
  dsp.start();
});
ws.on('message', (data, isBinary) => {
  if (!isBinary) { console.log('SERVER:', data.toString()); return; }
  dsp.receiveAudio(int16ToFloat(Buffer.from(data)));
});
dsp.on('connected', info => {
  connected = true;
  console.log(`[${((Date.now()-t0)/1000).toFixed(1)}s] CARRIER ${info.protocol}@${info.bps}`);
  setTimeout(() => { console.log('typing: hello there\\r'); dsp.write(Buffer.from('hello there\r')); }, 16000);
  setTimeout(() => { console.log('typing: BYE\\r'); dsp.write(Buffer.from('BYE\r')); }, 30000);
});
dsp.on('data', buf => { for (const b of buf) rx.push(b); });

setTimeout(() => {
  const s = Buffer.from(rx).toString('latin1');
  const clean = s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  console.log('\n===== DECODED FROM BBS (ANSI stripped) =====');
  console.log(clean);
  const ok = /SYNTHLINK TEST BBS/.test(clean) && /you said: hello there/.test(clean);
  console.log('\nRESULT:', ok ? 'PASS ✅' : 'FAIL ❌');
  try { dsp.stop(); ws.close(); } catch(_){}
  process.exit(ok ? 0 : 1);
}, 40000);

ws.on('error', e => { console.error('ws error', e.message); process.exit(3); });
