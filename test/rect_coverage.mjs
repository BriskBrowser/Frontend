import assert from 'node:assert/strict';
import fs from 'node:fs';
const source=fs.readFileSync(new URL('../src/rectCoverage.js',import.meta.url),'utf8');
const {assertDisjoint}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
let seed=42;
const random=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;};
for(let run=0;run<2000;run++) {
  const w=1+random(64),h=1+random(64),occupied=new Uint8Array(w*h),rects=[];
  let overlap=false;
  for(let i=0,n=random(40);i<n;i++) {
    const x=random(w),y=random(h),rw=1+random(w-x),rh=1+random(h-y);
    rects.push({x,y,rw,rh});
    for(let yy=y;yy<y+rh;yy++)for(let xx=x;xx<x+rw;xx++){
      const at=yy*w+xx;overlap ||= occupied[at]===1;occupied[at]=1;
    }
  }
  if(overlap)assert.throws(()=>assertDisjoint(rects,w),/Overlapping/);
  else assertDisjoint(rects,w);
}
const strips=Array.from({length:4096},(_,y)=>({x:0,y,rw:1024,rh:1}));
assertDisjoint(strips,1024);
assertDisjoint([{x:0,y:0,rw:1,rh:4096}],1);
console.log('PASS coverage: 2000 pixel-oracle cases, shared edges, 4096 strips and width one');
