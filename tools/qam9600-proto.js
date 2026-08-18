'use strict';
// Feasibility prototype: a REAL 9600 bps QAM link over an 8 kHz audio channel,
// exercised through the same Int16 quantization the WebSocket uses. This proves
// the modulation reaches 9600 on our clean/deterministic channel. Params chosen
// so samples-per-symbol is an integer (timing becomes trivial on a shared clock):
//   1600 baud x 6 bits/symbol (64-QAM) = 9600 bps, sps = 5, carrier 1800 Hz.
const SR = 8000, BAUD = 1600, SPS = SR / BAUD; // 5
const FC = 1800;                                // carrier
const ROLLOFF = 0.35, SPAN = 8;                 // RRC pulse shape
const BITS = 6, M = 1 << BITS;                  // 64-QAM

// ---- 64-QAM constellation: 8x8 grid, levels [-7,-5,-3,-1,1,3,5,7] ----
const LV = [-7,-5,-3,-1,1,3,5,7];
function sym(idx){ return { i: LV[idx & 7], q: LV[(idx>>3) & 7] }; }
function nearestIdx(i,q){
  const qi = LV.reduce((b,v,k)=> Math.abs(v-i)<Math.abs(LV[b]-i)?k:b,0);
  const qq = LV.reduce((b,v,k)=> Math.abs(v-q)<Math.abs(LV[b]-q)?k:b,0);
  return qi | (qq<<3);
}

// ---- RRC taps ----
function rrc(){
  const n = SPAN*SPS, taps=new Float32Array(n+1); const b=ROLLOFF;
  for(let k=0;k<=n;k++){ const t=(k-n/2)/SPS;
    let v;
    if (Math.abs(t)<1e-8) v = 1 - b + 4*b/Math.PI;
    else if (Math.abs(Math.abs(4*b*t)-1)<1e-6) v = (b/Math.SQRT2)*((1+2/Math.PI)*Math.sin(Math.PI/(4*b))+(1-2/Math.PI)*Math.cos(Math.PI/(4*b)));
    else { const pt=Math.PI*t; v=(Math.sin(pt*(1-b))+4*b*t*Math.cos(pt*(1+b)))/(pt*(1-(4*b*t)*(4*b*t))); }
    taps[k]=v;
  }
  // normalize energy
  let s=0; for(const x of taps) s+=x*x; const g=1/Math.sqrt(s);
  for(let k=0;k<taps.length;k++) taps[k]*=g;
  return taps;
}
const TAPS = rrc(), TLEN = TAPS.length, DELAY = (TLEN-1)/2;

// ---- bytes -> 6-bit symbols ----
function bytesToSymbols(bytes){
  const bits=[]; for(const b of bytes) for(let k=0;k<8;k++) bits.push((b>>k)&1);
  while(bits.length % BITS) bits.push(0);
  const syms=[]; for(let i=0;i<bits.length;i+=BITS){ let v=0; for(let k=0;k<BITS;k++) v|=bits[i+k]<<k; syms.push(v);} 
  return syms;
}
function symbolsToBytes(syms, nbytes){
  const bits=[]; for(const s of syms) for(let k=0;k<BITS;k++) bits.push((s>>k)&1);
  const out=Buffer.alloc(nbytes); for(let i=0;i<nbytes;i++){ let b=0; for(let k=0;k<8;k++) b|=(bits[i*8+k]||0)<<k; out[i]=b;} 
  return out;
}

// ---- Modulator ----
const PREAMBLE = []; for(let i=0;i<24;i++) PREAMBLE.push(nearestIdx(7,7)); // known corner for gain/phase cal
function modulate(bytes){
  const dsyms = bytesToSymbols(bytes);
  const allIdx = PREAMBLE.concat(dsyms);
  // upsample I/Q impulse train
  const N = allIdx.length*SPS + TLEN;
  const upI=new Float32Array(N), upQ=new Float32Array(N);
  for(let s=0;s<allIdx.length;s++){ const {i,q}=sym(allIdx[s]); upI[s*SPS]=i; upQ[s*SPS]=q; }
  // pulse shape (convolve)
  const bI=new Float32Array(N), bQ=new Float32Array(N);
  for(let n=0;n<N;n++){ let ai=0,aq=0; const kmin=Math.max(0,n-(N-1)); 
    for(let t=0;t<TLEN;t++){ const idx=n-t; if(idx>=0&&idx<N){ ai+=upI[idx]*TAPS[t]; aq+=upQ[idx]*TAPS[t]; } }
    bI[n]=ai; bQ[n]=aq;
  }
  // upconvert
  const out=new Float32Array(N); let peak=0;
  for(let n=0;n<N;n++){ const ph=2*Math.PI*FC*n/SR; const s=bI[n]*Math.cos(ph)-bQ[n]*Math.sin(ph); out[n]=s; if(Math.abs(s)>peak)peak=Math.abs(s);}    
  const g=0.35/peak; for(let n=0;n<N;n++) out[n]*=g;   // scale to ~0.35 peak like other protos
  return { audio: out, nsyms: dsyms.length };
}

// ---- Int16 "wire" (matches WS quantization) ----
function wire(f){ const o=new Float32Array(f.length); for(let n=0;n<f.length;n++){ let s=Math.max(-1,Math.min(1,f[n])); o[n]=((s*32767)|0)/32768; } return o; }

// ---- Demodulator (coherent; deterministic timing on shared clock) ----
function demodulate(audio, nsyms, nbytes){
  const N=audio.length;
  // downconvert to baseband
  const dI=new Float32Array(N), dQ=new Float32Array(N);
  for(let n=0;n<N;n++){ const ph=2*Math.PI*FC*n/SR; dI[n]=audio[n]*Math.cos(ph)*2; dQ[n]=-audio[n]*Math.sin(ph)*2; }
  // matched filter
  const mI=new Float32Array(N), mQ=new Float32Array(N);
  for(let n=0;n<N;n++){ let ai=0,aq=0; for(let t=0;t<TLEN;t++){ const idx=n-t; if(idx>=0){ ai+=dI[idx]*TAPS[t]; aq+=dQ[idx]*TAPS[t]; } } mI[n]=ai; mQ[n]=aq; }
  // symbol sampling: first symbol center at 2*DELAY (tx delay + rx delay), then every SPS
  const start = 2*DELAY;
  const total = PREAMBLE.length + nsyms;
  const rI=[], rQ=[];
  for(let s=0;s<total;s++){ const idx=Math.round(start+s*SPS); rI.push(mI[idx]||0); rQ.push(mQ[idx]||0); }
  // estimate complex gain from preamble (known = (7,7))
  let gi=0,gq=0; for(let s=0;s<PREAMBLE.length;s++){ // corr rx * conj(known)
    const ki=7,kq=7; gi += rI[s]*ki + rQ[s]*kq; gq += rQ[s]*ki - rI[s]*kq; }
  gi/=PREAMBLE.length*98; gq/=PREAMBLE.length*98; const gm=gi*gi+gq*gq; // /98 = |(7,7)|^2
  // derotate/scale data symbols by conj(g)/|g|^2, then slice
  const outSyms=[];
  for(let s=PREAMBLE.length;s<total;s++){ const xr=rI[s], xq=rQ[s];
    const ci=(xr*gi+xq*gq)/gm, cq=(xq*gi-xr*gq)/gm; // divide by g
    outSyms.push(nearestIdx(ci,cq));
  }
  return symbolsToBytes(outSyms, nbytes);
}

// ---- Test ----
const payload = Buffer.from('SynthLink 9600 bps QAM feasibility — The quick brown fox jumps over the lazy dog. 0123456789!@#$%^&*()');
const { audio, nsyms } = modulate(payload);
const got = demodulate(wire(audio), nsyms, payload.length);
let errs=0; for(let i=0;i<payload.length;i++) if(got[i]!==payload[i]) errs++;
const durMs = (audio.length/SR*1000).toFixed(0);
console.log(`params: ${BAUD} baud x ${BITS} bits (64-QAM) = ${BAUD*BITS} bps, sps=${SPS}, carrier ${FC}Hz`);
console.log(`payload: ${payload.length} bytes -> ${nsyms} symbols, audio ${audio.length} samples (${durMs} ms)`);
console.log(`recovered: ${JSON.stringify(got.toString('latin1').slice(0,60))}...`);
console.log(`byte errors: ${errs}/${payload.length}  => ${errs===0?'PERFECT ✅ 9600 bps works':'errors ❌'}`);

// ---- Robustness sweep ----
function addNoise(f, amp){ if(!amp) return f; const o=new Float32Array(f.length);
  for(let n=0;n<f.length;n++) o[n]=f[n]+(Math.random()*2-1)*amp; return o; }
console.log('\n--- robustness: 512 random bytes, increasing channel noise ---');
const big = Buffer.alloc(512); for(let i=0;i<big.length;i++) big[i]=Math.floor(Math.random()*256);
for(const noise of [0, 0.002, 0.005, 0.01, 0.02, 0.04]){
  const { audio, nsyms } = modulate(big);
  const got = demodulate(addNoise(wire(audio), noise), nsyms, big.length);
  let e=0; for(let i=0;i<big.length;i++) if(got[i]!==big[i]) e++;
  console.log(`noise=${noise.toString().padEnd(6)} byte errors=${String(e).padStart(3)}/512  ${e===0?'clean':''}`);
}
