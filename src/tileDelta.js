// Connection-local reuse of encoded byte ranges, independent of image codec.
// Both endpoints observe every tile in wire order and retain the same bounded
// FIFO dictionary. References never cross a WebSocket or assume global residency.
(function(root) {
  'use strict';
  const MIME = 'application/x-brisk-tile-delta-v1';
  const LIMIT = 8 * 1024 * 1024, MAX_PACKET = 16 * 1024 * 1024;
  const gear = new Uint32Array(256);
  let seed = 0x9e3779b9;
  for (let i=0;i<256;i++) {seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; gear[i]=seed>>>0;}
  function spans(bytes) {
    const result=[];let start=0, hash=0;
    for(let i=0;i<bytes.length;i++) {
      hash=((hash<<1)+gear[bytes[i]])>>>0;
      const size=i+1-start;
      if(size>=2048 || (size>=128 && (hash&511)===0)) {result.push([start,i+1]);start=i+1;}
    }
    if(start<bytes.length)result.push([start,bytes.length]);
    return result;
  }
  function hash(bytes) {let h=2166136261;for(const b of bytes)h=Math.imul(h^b,16777619);return h>>>0;}
  function equal(a,b) {if(a.length!==b.length)return false;for(let i=0;i<a.length;i++)if(a[i]!==b[i])return false;return true;}
  class Cache {
    constructor(indexed=false, limit=LIMIT) {this.indexed=indexed;this.limit=limit;this.entries=new Map();this.index=new Map();this.next=1;this.size=0;this.stats={tiles:0,deltaTiles:0,rawBytes:0,wireBytes:0};}
    find(bytes) {
      const candidates=this.index.get(hash(bytes));
      let checked=0;
      if(candidates) for(const id of candidates) {if(++checked>8)break;const entry=this.entries.get(id);if(entry && equal(entry.bytes,bytes))return id;}
      return 0;
    }
    observe(bytes) {
      if(bytes.length>MAX_PACKET)throw Error('Tile exceeds delta size limit');
      for(const [from,to] of spans(bytes)) {
        if(this.next>0xffffffff) {this.entries.clear();this.index.clear();this.size=0;this.next=1;}
        const data=Uint8Array.from(bytes.subarray(from,to)), id=this.next++;
        const key=this.indexed?hash(data):0;
        this.entries.set(id,{bytes:data,key});this.size+=data.length;
        if(this.indexed) {let ids=this.index.get(key);if(!ids)this.index.set(key,ids=new Set());ids.add(id);}
        while((this.size>this.limit || this.entries.size>16384) && this.entries.size) {
          const first=this.entries.keys().next().value, entry=this.entries.get(first);
          this.entries.delete(first);this.size-=entry.bytes.length;
          if(this.indexed) {const ids=this.index.get(entry.key);ids.delete(first);if(!ids.size)this.index.delete(entry.key);}
        }
      }
    }
    encode(mime, bytes) {
      if(!this.indexed)throw Error('Delta encoder requires an index');
      if(bytes.length>MAX_PACKET)throw Error('Tile exceeds delta size limit');
      const name=new TextEncoder().encode(mime);
      const parts=spans(bytes).map(([a,b])=>{const data=bytes.subarray(a,b);return {data,id:this.find(data)};});
      let size=1+name.length+4;
      for(const p of parts)size+=p.id?5:3+p.data.length;
      let result={mime,bytes};
      // Save enough bytes to justify reconstruction; tiny headers stay plain.
      if(name.length<=255 && size+128<bytes.length && size<bytes.length*0.8) {
        const output=new Uint8Array(size), view=new DataView(output.buffer);let pos=0;
        output[pos++]=name.length;output.set(name,pos);pos+=name.length;view.setUint32(pos,bytes.length);pos+=4;
        for(const p of parts) {
          output[pos++]=p.id?0:1;
          if(p.id) {view.setUint32(pos,p.id);pos+=4;}
          else {view.setUint16(pos,p.data.length);pos+=2;output.set(p.data,pos);pos+=p.data.length;}
        }
        result={mime:MIME,bytes:output};
      }
      this.stats.tiles++;this.stats.rawBytes+=bytes.length;this.stats.wireBytes+=result.bytes.length;
      if(result.mime===MIME)this.stats.deltaTiles++;
      this.observe(bytes);
      return result;
    }
    decode(mime, bytes) {
      let result={mime,bytes};
      if(mime===MIME) {
        const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
        let pos=0;
        const need=n=>{if(pos+n>bytes.length)throw Error('Truncated tile delta');};
        need(1);const count=bytes[pos++];need(count+4);
        const originalMime=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(pos,pos+count));pos+=count;
        if(!originalMime || originalMime===MIME)throw Error('Invalid tile delta MIME');
        const size=view.getUint32(pos);pos+=4;
        if(size>MAX_PACKET)throw Error('Tile delta exceeds size limit');
        const output=new Uint8Array(size);let written=0;
        while(pos<bytes.length) {
          const op=bytes[pos++];let data;
          if(op===0) {need(4);const id=view.getUint32(pos);pos+=4;const entry=this.entries.get(id);if(!entry)throw Error('Missing tile delta base');data=entry.bytes;}
          else if(op===1) {need(2);const n=view.getUint16(pos);pos+=2;if(!n || n>2048)throw Error('Invalid tile delta literal');need(n);data=bytes.subarray(pos,pos+n);pos+=n;}
          else throw Error('Invalid tile delta operation');
          if(written+data.length>size)throw Error('Tile delta output overflow');
          output.set(data,written);written+=data.length;
        }
        if(written!==size)throw Error('Truncated tile delta output');
        result={mime:originalMime,bytes:output};
      }
      this.observe(result.bytes);
      return result;
    }
  }
  const api={Cache,MIME,spans};
  if(typeof module==='object' && module.exports)module.exports=api;
  root.BriskTileDelta=api;
})(globalThis);
