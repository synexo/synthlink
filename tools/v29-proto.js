'use strict';
// Genuine V.29 core prototype (9600 bps) — real constellation, differential
// phase + absolute amplitude encoding, V.29 scrambler, 2400 baud, 1700 Hz
// carrier, RRC shaping at 8 kHz. Tested through the Int16 wire.
//
// V.29 is 2400 baud → 3.333 samples/symbol at 8 kHz. We synthesize and
// matched-filter with a CONTINUOUS RRC evaluated at the true fractional symbol
// instants (arg = n*BAUD/SR - k), which sidesteps integer-sps assumptions.

const SR = 8000, BAUD = 2400, FC = 1700;
const T = BAUD / SR;                 // symbol-times per sample = 0.3
const ROLLOFF = 0.25, SPAN = 10;     // RRC (V.29-ish rolloff)

// ── V.29 16-point constellation (spandsp ordering) ──
// index = (ampBit<<3) | phaseIdx ; phaseIdx 0..7 = 0,45,90,135,180,225,270,315°
const C = [
  {i: 3,q: 0},{i: 1,q: 1},{i: 0,q: 3},{i:-1,q: 1},
  {i:-3,q: 0},{i:-1,q:-1},{i: 0,q:-3},{i: 1,q:-1},
  {i: 5,q: 0},{i: 3,q: 3},{i: 0,q: 5},{i:-3,q: 3},
  {i:-5,q: 0},{i:-3,q:-3},{i: 0,q:-5},{i: 3,q:-3},
];
// V.29 §4 differential phase table: Q2Q3Q4 → phase change (units of 45°)
// Q2Q3Q4:  001→0  000→1  010→2  011→3  111→4  110→5  100→6  101→7
const DPHASE = {1:0, 0:1, 2:2, 3:3, 7:4, 6:5, 4:6, 5:7};
const DPHASE_INV = {}; for (const k in DPHASE) DPHASE_INV[DPHASE[k]] = +k;

// ── V.29 scrambler: 1 + x^-18 + x^-23 (self-synchronising) ──
function makeScrambler(){ const r=new Array(23).fill(0);
  return (bit)=>{ const out = bit ^ r[17] ^ r[22]; r.unshift(out); r.pop(); return out; }; }
function makeDescrambler(){ const r=new Array(23).fill(0);
  return (bit)=>{ const out = bit ^ r[17] ^ r[22]; r.unshift(bit); r.pop(); return out; }; }

// ── RRC (continuous, argument in symbol units) ──
function rrcAt(t){ const b=ROLLOFF;
  if (Math.abs(t) < 1e-8) return 1 - b + 4*b/Math.PI;
  if (Math.abs(Math.abs(4*b*t)-1) < 1e-6)
    return (b/Math.SQRT2)*((1+2/Math.PI)*Math.sin(Math.PI/(4*b))+(1-2/Math.PI)*Math.cos(Math.PI/(4*b)));
  const pt=Math.PI*t;
  return (Math.sin(pt*(1-b))+4*b*t*Math.cos(pt*(1+b)))/(pt*(1-(4*b*t)*(4*b*t)));
}
// energy-normalise
let RRC_G=1; { let s=0; for(let k=-SPAN*4;k<=SPAN*4;k++) s+=rrcAt(k/4)*rrcAt(k/4); RRC_G=1/Math.sqrt(s/4); }
function rrc(t){ return rrcAt(t)*RRC_G; }

// ── TX: bytes → V.29 symbols (with preamble) → audio ──
const PRE_SYMS = 32;          // preamble: known point (5,0) = idx 8, phaseIdx 0, ampBit1
function encodeSymbols(bytes){
  const scr = makeScrambler();
  // serialize bits LSB-first, scramble
  const bits=[]; for(const by of bytes) for(let k=0;k<8;k++) bits.push(scr((by>>k)&1));
  while(bits.length%4) bits.push(scr(0));
  const syms=[]; let phase=0;                 // absolute phase index (differential)
  // preamble: repeated (5,0) so RX can seed phase=0 and gain
  for(let p=0;p<PRE_SYMS;p++) syms.push(8);   // idx 8 = (5,0)
  for(let i=0;i<bits.length;i+=4){
    const Q1=bits[i], Q2=bits[i+1], Q3=bits[i+2], Q4=bits[i+3];
    const key=(Q2<<2)|(Q3<<1)|Q4;
    phase=(phase + DPHASE[key]) & 7;
    syms.push((Q1<<3)|phase);
  }
  return { syms, nbits: bits.length };
}
function modulate(bytes){
  const { syms, nbits } = encodeSymbols(bytes);
  const nSym=syms.length;
  const nSamp=Math.ceil((nSym+SPAN)/T)+8;
  const bI=new Float32Array(nSamp), bQ=new Float32Array(nSamp);
  for(let n=0;n<nSamp;n++){
    const st=n*T;                       // symbol-time of this sample
    let ai=0,aq=0;
    const klo=Math.ceil(st-SPAN/2), khi=Math.floor(st+SPAN/2);
    for(let k=Math.max(0,klo);k<=Math.min(nSym-1,khi);k++){
      const p=rrc(st-k); ai+=C[syms[k]].i*p; aq+=C[syms[k]].q*p;
    }
    bI[n]=ai; bQ[n]=aq;
  }
  const out=new Float32Array(nSamp); let peak=0;
  for(let n=0;n<nSamp;n++){ const ph=2*Math.PI*FC*n/SR;
    const s=bI[n]*Math.cos(ph)-bQ[n]*Math.sin(ph); out[n]=s; if(Math.abs(s)>peak)peak=Math.abs(s);}
  const g=0.35/peak; for(let n=0;n<nSamp;n++) out[n]*=g;
  return { audio: out, nSym, nbits };
}

function wire(f){ const o=new Float32Array(f.length);
  for(let n=0;n<f.length;n++){ let s=Math.max(-1,Math.min(1,f[n])); o[n]=((s*32767)|0)/32768; } return o; }

// ── RX: audio → symbols → bytes ──
function demodulate(audio, nSym, nbits){
  const N=audio.length;
  // downconvert
  const dI=new Float32Array(N), dQ=new Float32Array(N);
  for(let n=0;n<N;n++){ const ph=2*Math.PI*FC*n/SR; dI[n]=audio[n]*Math.cos(ph)*2; dQ[n]=-audio[n]*Math.sin(ph)*2; }
  // matched filter evaluated AT symbol instants: rxSym[k] = Σ_n bb[n]*rrc(n*T - k)
  const rI=new Float32Array(nSym), rQ=new Float32Array(nSym);
  for(let k=0;k<nSym;k++){
    const nlo=Math.ceil((k-SPAN/2)/T), nhi=Math.floor((k+SPAN/2)/T);
    let ai=0,aq=0;
    for(let n=Math.max(0,nlo);n<=Math.min(N-1,nhi);n++){ const p=rrc(n*T-k); ai+=dI[n]*p; aq+=dQ[n]*p; }
    rI[k]=ai; rQ[k]=aq;
  }
  // gain from preamble (known |(5,0)|=5)
  let mag=0; for(let k=4;k<PRE_SYMS;k++) mag+=Math.hypot(rI[k],rQ[k]);
  const A=(mag/(PRE_SYMS-4))/5;
  // seed absolute phase from last preamble symbol (should be phaseIdx 0)
  let prevAng=Math.atan2(rQ[PRE_SYMS-1], rI[PRE_SYMS-1]);
  let phase=0;                                  // preamble is phaseIdx 0
  const outbits=[];
  for(let k=PRE_SYMS;k<nSym;k++){
    const ang=Math.atan2(rQ[k], rI[k]);
    let d=Math.round((ang-prevAng)/(Math.PI/4)); d=((d%8)+8)&7;  // phase-index delta
    prevAng=ang;
    phase=(phase+d)&7;
    const Q234=DPHASE_INV[d];
    // amplitude bit: axis phases (even idx) rings 3/5 → thr 4A; diagonal (odd) rings √2/3√2 → thr 2.12A
    const r=Math.hypot(rI[k],rQ[k])/A;
    const thr=(phase&1)? (Math.SQRT2+3*Math.SQRT2)/2 : 4;
    const Q1=(r>thr)?1:0;
    outbits.push(Q1,(Q234>>2)&1,(Q234>>1)&1,Q234&1);
  }
  // descramble + pack
  const des=makeDescrambler();
  const data=outbits.slice(0,nbits).map(des);
  const nbytes=Math.floor(nbits/8);
  const out=Buffer.alloc(nbytes);
  for(let i=0;i<nbytes;i++){ let b=0; for(let k=0;k<8;k++) b|=(data[i*8+k]||0)<<k; out[i]=b; }
  return out;
}

// ── Tests ──
function run(payload, noise=0){
  const { audio, nSym, nbits } = modulate(payload);
  let a=wire(audio);
  if(noise){ const o=new Float32Array(a.length); for(let n=0;n<a.length;n++)o[n]=a[n]+(Math.random()*2-1)*noise; a=o; }
  const got=demodulate(a, nSym, nbits);
  let e=0; for(let i=0;i<payload.length;i++) if(got[i]!==payload[i]) e++;
  return { got, e, ms:(audio.length/SR*1000).toFixed(0) };
}
const msg=Buffer.from('V.29 at 9600 bps — 2400 baud 16-point QAM, 1700 Hz carrier. The quick brown fox 0123456789.');
const r=run(msg);
console.log(`V.29: ${BAUD} baud x 4 bits = ${BAUD*4} bps, carrier ${FC} Hz, rolloff ${ROLLOFF}`);
console.log(`payload ${msg.length}B, audio ${r.ms} ms`);
console.log(`recovered: ${JSON.stringify(r.got.toString('latin1').slice(0,64))}`);
console.log(`byte errors: ${r.e}/${msg.length}  ${r.e===0?'PERFECT ✅':'❌'}`);

console.log('\n--- robustness: 512 random bytes vs noise ---');
const big=Buffer.alloc(512); for(let i=0;i<big.length;i++) big[i]=Math.floor(Math.random()*256);
for(const nz of [0,0.002,0.005,0.01,0.02,0.04]){ const rr=run(big,nz);
  console.log(`noise=${String(nz).padEnd(6)} errors=${String(rr.e).padStart(3)}/512 ${rr.e===0?'clean':''}`); }
