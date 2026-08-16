'use strict';
// Isolation test: exact V.34 TX pulse-shaping + carrier and the RX matched filter,
// with PERFECT timing (RX samples exactly where TX placed symbols). If the eye is
// open here at 2.5 SPS, the 28800 problem is acquisition, not the filter/ISI.
function makeRRC(ROLLOFF, SPAN) {
  function rrcAt(t){const b=ROLLOFF;if(Math.abs(t)<1e-8)return 1-b+4*b/Math.PI;
    if(Math.abs(Math.abs(4*b*t)-1)<1e-6)return (b/Math.SQRT2)*((1+2/Math.PI)*Math.sin(Math.PI/(4*b))+(1-2/Math.PI)*Math.cos(Math.PI/(4*b)));
    const pt=Math.PI*t;return (Math.sin(pt*(1-b))+4*b*t*Math.cos(pt*(1+b)))/(pt*(1-(4*b*t)*(4*b*t)));}
  let G=1;{let s=0;for(let k=-SPAN*4;k<=SPAN*4;k++)s+=rrcAt(k/4)**2;G=1/Math.sqrt(s/4);}
  return t=>rrcAt(t)*G;
}
function test(label, BAUD, FC, ROLLOFF, SPAN){
  const SR=8000, SPS=SR/BAUD, rrc=makeRRC(ROLLOFF,SPAN);
  const N=2000;
  // random symbols on odd lattice up to ±13
  const syms=[];let rng=99;const rnd=()=>{rng=(rng*1103515245+12345)&0x7fffffff;return rng;};
  for(let k=0;k<N;k++)syms.push({i:2*(rnd()%14)-13,q:2*(rnd()%14)-13});
  // TX
  const nsamp=Math.ceil((N+SPAN)*SPS);const audio=new Float32Array(nsamp);
  for(let n=0;n<nsamp;n++){const st=n/SPS;const klo=Math.max(0,Math.ceil(st-SPAN/2)),khi=Math.min(N-1,Math.floor(st+SPAN/2));
    let ai=0,aq=0;for(let k=klo;k<=khi;k++){const p=rrc(st-k);ai+=syms[k].i*p;aq+=syms[k].q*p;}
    const ph=2*Math.PI*FC*n/SR;audio[n]=ai*Math.cos(ph)-aq*Math.sin(ph);}
  // RX matched filter at perfect timing pos=k*SPS
  function sym(pos){const nlo=Math.max(0,Math.ceil(pos-SPAN/2*SPS)),nhi=Math.min(nsamp-1,Math.floor(pos+SPAN/2*SPS));
    let ai=0,aq=0;for(let n=nlo;n<=nhi;n++){const ph=2*Math.PI*FC*n/SR;const bi=audio[n]*Math.cos(ph)*2,bq=-audio[n]*Math.sin(ph)*2;const p=rrc((n-pos)/SPS);ai+=bi*p;aq+=bq*p;}return[ai,aq];}
  // estimate gain from mid symbols, then residual slice error
  let gsum=0,cnt=0;const K0=SPAN,K1=N-SPAN;
  for(let k=K0;k<K1;k++){const s=sym(k*SPS);gsum+=Math.hypot(s[0],s[1])/Math.hypot(syms[k].i,syms[k].q);cnt++;}
  const g=gsum/cnt;
  let err=[],bad=0;
  for(let k=K0;k<K1;k++){const s=sym(k*SPS);const xi=s[0]/g,xq=s[1]/g;const si=Math.round((xi-1)/2)*2+1,sq=Math.round((xq-1)/2)*2+1;
    err.push(Math.hypot(xi-syms[k].i,xq-syms[k].q));if(si!==syms[k].i||sq!==syms[k].q)bad++;}
  err.sort((a,b)=>a-b);const mean=err.reduce((a,b)=>a+b,0)/err.length;
  console.log(`${label}: SPS=${SPS.toFixed(2)} roll=${ROLLOFF} span=${SPAN}  gain=${g.toFixed(3)}  sliceErr mean=${mean.toFixed(4)} max=${err[err.length-1].toFixed(4)}  symbolErrors=${bad}/${err.length}`);
}
test('2400 (working)', 2400, 1800, 0.25, 10);
test('3200 span16   ', 3200, 1920, 0.18, 16);
test('3200 span24   ', 3200, 1920, 0.18, 24);
test('3200 span32   ', 3200, 1920, 0.18, 32);
test('3200 roll0.20 ', 3200, 1920, 0.20, 32);
test('3200 lowcar1829',3200, 1829, 0.12, 32);
