'use strict';
const fs = require('fs');
const WebSocket = require('ws');
const Bundle = new Function(fs.readFileSync(__dirname+'/../public/dsp-bundle.js','utf8')+'\nreturn SynthModemDSP;')();
const { ModemDSP, config } = Bundle;
const HOST = process.env.HOST || '127.0.0.1';
const PORT = process.env.BBS_PORT || '2323';
const PROTO = process.env.PROTO || 'V21';
config.modem.native.protocolPreference=[PROTO];
config.modem.native.v8ModulationModes=[PROTO];
function f2i(f){const b=Buffer.allocUnsafe(f.length*2);for(let i=0;i<f.length;i++){let s=Math.max(-1,Math.min(1,f[i]));b.writeInt16LE((s*32767)|0,i*2);}return b;}
function i2f(b){const n=b.length>>1,o=new Float32Array(n);for(let i=0;i<n;i++)o[i]=b.readInt16LE(i*2)/32768;return o;}
const dsp = new ModemDSP('originate');
const ws  = new WebSocket('ws://localhost:8088');
let up=false; const t0=Date.now(); const rxQueue=[]; const rx=[];
function scheduleFlush(){const delay=Math.random()<0.25?30+Math.random()*30:Math.random()*8;
  setTimeout(()=>{const n=1+Math.floor(Math.random()*4);for(let k=0;k<n&&rxQueue.length;k++)dsp.receiveAudio(rxQueue.shift());scheduleFlush();},delay);}
scheduleFlush();
ws.on('open',()=>{ws.send(JSON.stringify({type:'dial',host:HOST,port:PORT,protocol:PROTO}));
  dsp.on('audioOut',f=>{if(ws.readyState===WebSocket.OPEN)ws.send(f2i(f));});dsp.start();});
ws.on('message',(d,bin)=>{if(!bin)return;rxQueue.push(i2f(Buffer.from(d)));});
dsp.on('connected',i=>{up=true;console.log(`[${((Date.now()-t0)/1000).toFixed(1)}s] ORIGINATE CONNECTED ${i.protocol}@${i.bps}`);
  setTimeout(()=>dsp.write(Buffer.from('hi\r')),1500);});
dsp.on('data',b=>{for(const x of b)rx.push(x);});
setTimeout(()=>{const s=Buffer.from(rx).toString('latin1').replace(/\x1b\[[0-9;]*[A-Za-z]/g,'');
  const ok=up && /SYNTHLINK TEST BBS/.test(s);
  console.log('RESULT('+PROTO+'):', ok?'PASS ✅':(up?'connected but no banner ❌':'no carrier ❌'));
  try{dsp.stop();ws.close();}catch(_){}; process.exit(ok?0:1);},22000);
ws.on('error',e=>{console.error('ws',e.message);process.exit(3);});
