'use strict';
const fs=require('fs');const WebSocket=require('ws');
const B=new Function(fs.readFileSync(__dirname+'/../public/dsp-bundle.js','utf8')+'\nreturn SynthModemDSP;')();
const {ModemDSP,config}=B;
const PROTO=process.env.PROTO||'V22bis';
config.modem.native.protocolPreference=[PROTO];config.modem.native.v8ModulationModes=[PROTO];
function f2i(f){const b=Buffer.allocUnsafe(f.length*2);for(let i=0;i<f.length;i++){let s=Math.max(-1,Math.min(1,f[i]));b.writeInt16LE((s*32767)|0,i*2);}return b;}
function i2f(b){const n=b.length>>1,o=new Float32Array(n);for(let i=0;i<n;i++)o[i]=b.readInt16LE(i*2)/32768;return o;}
const dsp=new ModemDSP('originate');const ws=new WebSocket('ws://localhost:8088');
let up=false;const t0=Date.now();const rx=[];
ws.on('open',()=>{ws.send(JSON.stringify({type:'dial',host:'127.0.0.1',port:'2323',protocol:PROTO}));
  dsp.on('audioOut',f=>{if(ws.readyState===WebSocket.OPEN)ws.send(f2i(f));});dsp.start();});
ws.on('message',(d,bin)=>{if(!bin){console.log('SRV',d.toString());return;}dsp.receiveAudio(i2f(Buffer.from(d)));});
dsp.on('connected',i=>{up=true;console.log(`[${((Date.now()-t0)/1000).toFixed(1)}s] ORIG CONNECTED ${i.protocol}@${i.bps}`);});
dsp.on('data',b=>{for(const x of b)rx.push(x);});
setTimeout(()=>{const s=Buffer.from(rx).toString('latin1').replace(/\x1b\[[0-9;]*[A-Za-z]/g,'');
  console.log('RESULT('+PROTO+'):',up&&/SYNTHLINK TEST BBS/.test(s)?'PASS ✅':(up?'connected no-banner':'no carrier'));
  process.exit(0);},16000);
ws.on('error',e=>{console.error(e.message);process.exit(3);});
