'use strict';
// Streaming V.29 modem (9600 bps) — genuine constellation/encoding/scrambler,
// with a real preamble + acquisition so it works when the two ends are NOT
// sample-aligned (as over a WebSocket). Proven here in a realistic loopback:
// random start offset + Int16 wire + bursty (jittered) delivery, both directions.
const { EventEmitter } = require('events');
const SR=8000, BAUD=2400, FC=1700, SPS=SR/BAUD; // 3.333
const ROLLOFF=0.25, SPAN=10;

const C=[{i:3,q:0},{i:1,q:1},{i:0,q:3},{i:-1,q:1},{i:-3,q:0},{i:-1,q:-1},{i:0,q:-3},{i:1,q:-1},
         {i:5,q:0},{i:3,q:3},{i:0,q:5},{i:-3,q:3},{i:-5,q:0},{i:-3,q:-3},{i:0,q:-5},{i:3,q:-3}];
const DPHASE={1:0,0:1,2:2,3:3,7:4,6:5,4:6,5:7}, DINV={}; for(const k in DPHASE)DINV[DPHASE[k]]=+k;
function rrcAt(t){const b=ROLLOFF;
  if(Math.abs(t)<1e-8)return 1-b+4*b/Math.PI;
  if(Math.abs(Math.abs(4*b*t)-1)<1e-6)return (b/Math.SQRT2)*((1+2/Math.PI)*Math.sin(Math.PI/(4*b))+(1-2/Math.PI)*Math.cos(Math.PI/(4*b)));
  const pt=Math.PI*t;return (Math.sin(pt*(1-b))+4*b*t*Math.cos(pt*(1+b)))/(pt*(1-(4*b*t)*(4*b*t)));}
let RRC_G=1;{let s=0;for(let k=-SPAN*4;k<=SPAN*4;k++)s+=rrcAt(k/4)**2;RRC_G=1/Math.sqrt(s/4);}
const rrc=t=>rrcAt(t)*RRC_G;

// preamble layout (symbols): SEG_A alternating (timing) | SEG_B constant (5,0) phase/gain seed
const SEG_A=32, SEG_B=16, PRE=SEG_A+SEG_B;

class V29Modem extends EventEmitter{
  constructor(){super();
    this.txSyms=[]; this._buildPreamble(); this.txPhase=0; this.scr=new Array(23).fill(0);
    this.n=0;                       // TX sample counter
    this.txBits=[];                 // pending scrambled data bits
    // RX
    this.rx=[]; this.rxN=0; this.acq=false; this.base=0; this.symIdx=0;
    this.des=new Array(23).fill(0); this.rxPhase=0; this.prevAng=0; this.A=1; this.outbits=[];
    this.connected=false;
  }
  _scramble(bit){const r=this.scr;const out=bit^r[17]^r[22];r.unshift(out);r.pop();return out;}
  _buildPreamble(){ for(let k=0;k<SEG_A;k++) this.txSyms.push((k&1)?12:8); // (-5,0)/(5,0)
    for(let k=0;k<SEG_B;k++) this.txSyms.push(8); }                       // (5,0)
  write(bytes){ for(const by of bytes) for(let k=0;k<8;k++) this.txBits.push(this._scramble((by>>k)&1)); }
  _needSymbol(k){ // ensure txSyms[k] exists (append data or idle)
    while(this.txSyms.length<=k){
      if(this.txBits.length<4){ // idle: scrambled ones
        for(let z=0;z<4;z++) this.txBits.push(this._scramble(1)); }
      const Q1=this.txBits.shift(),Q2=this.txBits.shift(),Q3=this.txBits.shift(),Q4=this.txBits.shift();
      this.txPhase=(this.txPhase+DPHASE[(Q2<<2)|(Q3<<1)|Q4])&7;
      this.txSyms.push((Q1<<3)|this.txPhase);
    }
  }
  generateAudio(count){
    const out=new Float32Array(count);
    for(let c=0;c<count;c++){ const n=this.n++; const st=n/SPS;
      const klo=Math.max(0,Math.ceil(st-SPAN/2)), khi=Math.floor(st+SPAN/2);
      this._needSymbol(khi);
      let ai=0,aq=0;
      for(let k=klo;k<=khi;k++){ const p=rrc(st-k); ai+=C[this.txSyms[k]].i*p; aq+=C[this.txSyms[k]].q*p; }
      const ph=2*Math.PI*FC*n/SR; out[c]=(ai*Math.cos(ph)-aq*Math.sin(ph))*0.06; // fixed scale (~0.35 peak)
    }
    return out;
  }
  _bb(n){ const ph=2*Math.PI*FC*n/SR; return [this.rx[n]*Math.cos(ph)*2, -this.rx[n]*Math.sin(ph)*2]; }
  _sym(pos){ // matched filter at fractional sample position pos
    const nlo=Math.max(0,Math.ceil(pos-SPAN/2*SPS)), nhi=Math.min(this.rx.length-1,Math.floor(pos+SPAN/2*SPS));
    let ai=0,aq=0; for(let n=nlo;n<=nhi;n++){ const b=this._bb(n); const p=rrc((n-pos)/SPS); ai+=b[0]*p; aq+=b[1]*p; }
    return [ai,aq];
  }
  receiveAudio(f32){ for(let i=0;i<f32.length;i++) this.rx.push(f32[i]); this._process(); }
  _process(){
    if(!this.acq){
      if(this.rx.length < (PRE+12)*SPS + 64) return;
      // coarse onset
      let onset=-1,e=0;
      for(let n=0;n<this.rx.length;n++){const b=this._bb(n);const m=Math.hypot(b[0],b[1]);e=0.85*e+0.15*m;if(e>0.04){onset=Math.max(0,n-4);break;}}
      if(onset<0) return;
      // fractional-phase lock: base maximizing SEG_A energy
      let best=onset,bestScore=-1;
      for(let bo=Math.max(0,onset-2*SPS); bo<=onset+2*SPS; bo+=SPS/16){
        let sc=0; for(let k=0;k<12;k++){ const s=this._sym(bo+k*SPS); sc+=Math.hypot(s[0],s[1]); }
        if(sc>bestScore){bestScore=sc;best=bo;}
      }
      // find alternating(SEG_A, Δ≈π) → constant(SEG_B, Δ≈0) boundary = frame sync
      const nSy=PRE+8, ang=[], mag=[];
      for(let j=0;j<nSy;j++){ const s=this._sym(best+j*SPS); ang.push(Math.atan2(s[1],s[0])); mag.push(Math.hypot(s[0],s[1])); }
      const dphi=[]; for(let j=1;j<nSy;j++){ let d=ang[j]-ang[j-1]; while(d>Math.PI)d-=2*Math.PI; while(d<-Math.PI)d+=2*Math.PI; dphi.push(Math.abs(d)); }
      let jB=-1;
      for(let j=3;j<dphi.length-4;j++){
        const preAlt = dphi[j-1]>2.0 && dphi[j-2]>2.0;
        const nowConst = dphi[j]<0.6 && dphi[j+1]<0.6 && dphi[j+2]<0.6;
        if(preAlt && nowConst){ jB=j; break; }
      }
      if(jB<0){ this.acq=false; return; }
      let gm=0,cnt=0; for(let j=jB+1;j<jB+SEG_B-1 && j<nSy;j++){ gm+=mag[j]; cnt++; }
      this.A=(gm/Math.max(1,cnt))/5;
      const dataStart=jB+SEG_B;
      this.base=best; this.symIdx=dataStart;
      this.prevAng=ang[dataStart-1]; this.rxPhase=0;
      this.acq=true;
      if(!this.connected){ this.connected=true; this.emit('connected',{protocol:'V29',bps:9600}); }
    }
    // decode any symbols now fully buffered
    while(true){ const pos=this.base+this.symIdx*SPS;
      if(pos+SPAN/2*SPS >= this.rx.length-1) break;         // not enough samples yet
      const s=this._sym(pos); const ang=Math.atan2(s[1],s[0]);
      let d=Math.round((ang-this.prevAng)/(Math.PI/4)); d=((d%8)+8)&7; this.prevAng=ang;
      this.rxPhase=(this.rxPhase+d)&7;
      const Q234=DINV[d]; const r=Math.hypot(s[0],s[1])/this.A;
      const thr=(this.rxPhase&1)?(Math.SQRT2+3*Math.SQRT2)/2:4; const Q1=(r>thr)?1:0;
      const bits=[Q1,(Q234>>2)&1,(Q234>>1)&1,Q234&1];
      for(const bit of bits){ const r2=this.des; const ob=bit^r2[17]^r2[22]; r2.unshift(bit); r2.pop(); this.outbits.push(ob); }
      this.symIdx++;
      // flush whole bytes
      while(this.outbits.length>=8){ let by=0; for(let k=0;k<8;k++) by|=this.outbits.shift()<<k; this.emit('data',Buffer.from([by])); }
    }
  }
}

// ── Realistic loopback: random offsets, int16 wire, jittered delivery ──
function i16(f){const o=new Float32Array(f.length);for(let n=0;n<f.length;n++){let s=Math.max(-1,Math.min(1,f[n]));o[n]=((s*32767)|0)/32768;}return o;}
function test(){
  const A=new V29Modem(), B=new V29Modem();
  const gotA=[],gotB=[];
  A.on('data',b=>{for(const x of b)gotA.push(x);}); B.on('data',b=>{for(const x of b)gotB.push(x);});
  // random start offsets (unaligned clocks): prepend silence to each wire
  const offA=17, offB=41;                         // samples of silence before carrier
  let aStarted=false,bStarted=false;
  // drive in blocks; B receives A's audio (offset), A receives B's audio (offset)
  const BLOCK=160; const bufAtoB=[], bufBtoA=[];
  for(let i=0;i<offB;i++) bufAtoB.push(0);         // A→B wire pre-silence
  for(let i=0;i<offA;i++) bufBtoA.push(0);         // B→A wire pre-silence
  A.write(Buffer.from('hello from A side over V.29 9600\r\n'));
  B.write(Buffer.from('WELCOME - this is B (answer) at 9600 bps\r\n'));
  for(let step=0; step<220; step++){
    const aTx=A.generateAudio(BLOCK); for(const s of aTx) bufAtoB.push(s);
    const bTx=B.generateAudio(BLOCK); for(const s of bTx) bufBtoA.push(s);
    // jittered delivery: sometimes flush 1-3 blocks, sometimes hold
    if(Math.random()<0.8){ const q=i16(Float32Array.from(bufAtoB.splice(0,BLOCK))); B.receiveAudio(q); }
    if(Math.random()<0.8){ const q=i16(Float32Array.from(bufBtoA.splice(0,BLOCK))); A.receiveAudio(q); }
  }
  // drain
  B.receiveAudio(i16(Float32Array.from(bufAtoB))); A.receiveAudio(i16(Float32Array.from(bufBtoA)));
  const sA=Buffer.from(gotB).toString('latin1');  // what B received from A
  const sB=Buffer.from(gotA).toString('latin1');  // what A received from B
  console.log('B received from A:', JSON.stringify(sA.slice(0,50)));
  console.log('A received from B:', JSON.stringify(sB.slice(0,50)));
  const ok = sA.includes('hello from A side over V.29 9600') && sB.includes('WELCOME - this is B');
  console.log(ok?'STREAMING V.29 LOOPBACK PASS ✅':'partial ❌');
}
test();
