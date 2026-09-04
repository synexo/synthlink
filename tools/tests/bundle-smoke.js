'use strict';
// Load the browser IIFE bundle and run ITS ModemDSP (originate) against the
// vendored ModemDSP (answer) in loopback — proves the shipped browser code works.
const fs = require('fs');
const code = fs.readFileSync(__dirname + '/../../public/dsp-bundle.js', 'utf8');
const load = new Function(code + '\nreturn SynthModemDSP;');
const Bundle = load();
console.log('bundle exports:', Object.keys(Bundle));

const { ModemDSP: BrowserDSP } = Bundle;
const nodeConfig = require('../../vendor/synthlink-config');
const { ModemDSP: NodeDSP } = require('../../vendor/src/dsp/ModemDSP');

// The bundle carries its OWN config instance — setting only the Node-side one
// leaves the browser half on the default protocol and the two ends never agree.
// PROTO=<name> (and V34RATE / V90RATE) selects the protocol on BOTH.
const PROTO = process.env.PROTO || null;
if (PROTO) {
  for (const c of [Bundle.config, nodeConfig]) {
    c.modem.native.protocolPreference = [PROTO];
    c.modem.native.v8ModulationModes = [PROTO];
    if (process.env.V34RATE) c.modem.native.v34Rate = parseInt(process.env.V34RATE, 10);
    if (process.env.V90RATE) c.modem.native.v90Rate = parseInt(process.env.V90RATE, 10);
  }
  console.log(`protocol: ${PROTO}`);
}

const originate = new BrowserDSP('originate');   // the browser's code
const answer    = new NodeDSP('answer');          // the server's code
originate.on('audioOut', s => answer.receiveAudio(s));
answer.on('audioOut',    s => originate.receiveAudio(s));

let a=false,o=false,done=false; const rxA=[],rxO=[]; const t0=Date.now();
const chk=()=>{ if(a&&o&&!done){done=true;
  console.log(`[${((Date.now()-t0)/1000).toFixed(1)}s] connected`);
  setTimeout(()=>originate.write(Buffer.from('typed in browser\r\n')),700);
  setTimeout(()=>answer.write(Buffer.from('from bbs via server\r\n')),2600);
  setTimeout(fin,6000);
}};
answer.on('connected',chk); originate.on("connected",()=>{o=true;chk();});
answer.on('connected',()=>{a=true;chk();});
answer.on('data',b=>{for(const x of b)rxA.push(x);});
originate.on('data',b=>{for(const x of b)rxO.push(x);});
function fin(){const A=Buffer.from(rxA).toString('latin1'),O=Buffer.from(rxO).toString('latin1');
  console.log('server got from browser:',JSON.stringify(A));
  console.log('browser got from server:',JSON.stringify(O));
  const ok=A.includes('typed in browser')&&O.includes('from bbs via server');
  console.log(ok?'BUNDLE PASS ✅':'BUNDLE FAIL ❌');
  process.exit(ok?0:1);
}
originate.start(); answer.start();
setTimeout(()=>{if(!done){console.log('timeout',{a,o});process.exit(2);}},30000);
