'use strict';
const { V29 } = require('/home/claude/synthlink/vendor/src/dsp/protocols/V29');

function run({payloadAB, payloadBA, offset=0, jitter=false, label}) {
  const A = new V29('originate'), B = new V29('answer');
  const rxA = [], rxB = []; let readyA=false, readyB=false;
  A.on('data', b => { for (const x of b) rxA.push(x); });
  B.on('data', b => { for (const x of b) rxB.push(x); });
  A.on('ready', () => readyA=true);
  B.on('ready', () => readyB=true);

  // delivery queues (simulate WS): A's audio -> B.receiveAudio, with offset/jitter
  const toB = [], toA = [];
  // prime B->A path with `offset` samples of silence so the two clocks aren't aligned
  if (offset>0) toA.push(new Float32Array(offset));

  let wroteAB=false, wroteBA=false;
  const BLOCK=160;
  const totalTicks = 1600; // ~32s of audio
  for (let t=0; t<totalTicks; t++) {
    // write payloads a little after both are ready
    if (!wroteAB && readyA && readyB && t>40 && payloadAB) { A.write(Buffer.from(payloadAB,'latin1')); wroteAB=true; }
    if (!wroteBA && readyA && readyB && t>40 && payloadBA) { B.write(Buffer.from(payloadBA,'latin1')); wroteBA=true; }

    const a = A.generateAudio(BLOCK);
    const b = B.generateAudio(BLOCK);
    toB.push(a); toA.push(b);

    // deliver — optionally in jittered sub-chunks
    const deliver = (queue, dst) => {
      while (queue.length) {
        const f = queue.shift();
        if (!jitter) { dst.receiveAudio(f); continue; }
        let o=0; while(o<f.length){ const n=1+Math.floor(Math.random()*60); dst.receiveAudio(f.subarray(o,Math.min(f.length,o+n))); o+=n; }
      }
    };
    deliver(toB, B);
    deliver(toA, A);
  }
  const gotAB = Buffer.from(rxB).toString('latin1'); // what B received from A
  const gotBA = Buffer.from(rxA).toString('latin1');
  const okAB = !payloadAB || gotAB === payloadAB;
  const okBA = !payloadBA || gotBA === payloadBA;
  console.log(`[${label}] readyA=${readyA} readyB=${readyB} A->B=${okAB?'OK':'FAIL'}(${JSON.stringify(gotAB).slice(0,60)}) B->A=${okBA?'OK':'FAIL'}(${JSON.stringify(gotBA).slice(0,60)})`);
  return readyA&&readyB&&okAB&&okBA;
}

let pass=0, tot=0;
const T=(o)=>{tot++; if(run(o))pass++;};
T({label:'A->B short', payloadAB:'hi\r', offset:0});
T({label:'A->B short +off', payloadAB:'hi\r', offset:37});
T({label:'B->A banner-ish', payloadBA:'SYNTHLINK TEST BBS\r\nBBS> ', offset:37});
T({label:'bidir', payloadAB:'hello world\r', payloadBA:'you said: hello world\r\n', offset:37});
T({label:'big A->B (600B)', payloadAB:'X'.repeat(600), offset:11});
T({label:'jittered bidir', payloadAB:'ls -la\r', payloadBA:'file1 file2 file3\r\nBBS> ', offset:37, jitter:true});
T({label:'jittered banner', payloadBA:('\x1b[2J\x1b[H  SYNTHLINK TEST BBS  \r\nType anything.\r\nBBS> '), offset:23, jitter:true});
console.log(`\n=== ${pass}/${tot} passed ===`);
process.exit(pass===tot?0:1);
