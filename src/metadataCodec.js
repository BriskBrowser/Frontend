/* Brisk metadata v1. Shared verbatim by Node (require) and the browser.
 * Dictionaries are directional, connection-local FIFO rings. No cache depends
 * on renderer/session lifetime. BRM1 is distinct from the BRIS tile envelope.
 */
(function(root) {
  'use strict';
  const MAGIC = [66,82,77,49], LIMIT = 16 * 1024 * 1024, SLOTS = 2048;
  const utf8 = new TextEncoder(), text = new TextDecoder('utf-8', {fatal:true});
  const context = key => /url|href/i.test(key) ? 1 : /text|title/i.test(key) ? 2 : 0;
  class Dictionary {
    constructor() { this.values = []; this.ids = new Map(); this.next = 0; }
    add(value) {
      const id = this.next;
      if (this.values[id] !== undefined) this.ids.delete(this.values[id]);
      this.values[id] = value; this.ids.set(value, id);
      this.next = (id + 1) % SLOTS;
    }
  }
  class Codec {
    constructor() { this.strings = Array.from({length:4}, () => new Dictionary()); this.objects = new Dictionary(); this.numbers = new Map(); }
    encode(value) {
      const out = [...MAGIC, 0];
      const uint = n => { do { const b = n % 128; n = Math.floor(n / 128); out.push(b | (n ? 128 : 0)); } while(n); };
      const string = (s, c) => {
        const dict = this.strings[c], id = dict.ids.get(s);
        if (id !== undefined) { uint(id * 2 + 1); return; }
        const bytes = utf8.encode(s); if (out.length + bytes.length + 8 > LIMIT) throw Error('Metadata size limit'); uint(bytes.length * 2); for (const b of bytes) out.push(b);
        if (bytes.length <= 4096) dict.add(s);
      };
      const write = (v, key, depth) => {
        if (out.length > LIMIT) throw Error('Metadata size limit');
        if (depth > 128) throw Error('Metadata nesting limit');
        if (v === null) { out.push(0); return; }
        if (v === false || v === true) { out.push(v ? 2 : 1); return; }
        if (typeof v === 'number') {
          const previous = this.numbers.get(key) || 0, delta = v - previous;
          if (Number.isSafeInteger(v) && Number.isSafeInteger(delta) && Math.abs(delta) <= 0x7fffffff) {
            out.push(3); uint(delta >= 0 ? delta * 2 : -delta * 2 - 1);
          } else {
            out.push(4); const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v, true); out.push(...b);
          }
          if (this.numbers.size < SLOTS || this.numbers.has(key)) this.numbers.set(key, v);
          return;
        }
        if (typeof v === 'string') { out.push(5); string(v, context(key)); return; }
        const signature = JSON.stringify(v);
        const cacheable = signature.length >= 16 && signature.length <= 4096;
        const id = cacheable ? this.objects.ids.get(signature) : undefined;
        if (id !== undefined) { out.push(8); uint(id); return; }
        if (Array.isArray(v)) { out.push(6); uint(v.length); for (const x of v) write(x, key, depth + 1); }
        else {
          const keys = Object.keys(v); out.push(7); uint(keys.length);
          for (const k of keys) { string(k, 3); write(v[k], k, depth + 1); }
        }
        if (cacheable) this.objects.add(signature);
      };
      write(value, '', 0);
      if (out.length > LIMIT) throw Error('Metadata size limit');
      return Uint8Array.from(out);
    }
    decode(input) {
      const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
      if (bytes.length > LIMIT || !isFrame(bytes) || bytes[4] !== 0) throw Error('Invalid metadata envelope');
      let pos = 5, nodes = 0, expanded = 0;
      const spend = n => { expanded += n; if (expanded > LIMIT) throw Error('Metadata expansion limit'); };
      const byte = () => { if (pos >= bytes.length) throw Error('Truncated metadata'); return bytes[pos++]; };
      const uint = () => { let n = 0, scale = 1; for (let i=0;i<8;i++) { const b=byte(); n += (b & 127)*scale; if (!Number.isSafeInteger(n)) throw Error('Invalid integer'); if (!(b&128)) return n; scale *=128; } throw Error('Invalid varint'); };
      const string = c => {
        const n = uint(), dict = this.strings[c];
        if (n % 2) { const s = dict.values[(n-1)/2]; if (s === undefined) throw Error('Missing string reference'); spend(s.length); return s; }
        const length=n/2; spend(length); if (length > bytes.length-pos) throw Error('Truncated string');
        const s=text.decode(bytes.subarray(pos,pos+length)); pos+=length;
        if (length <= 4096) dict.add(s); return s;
      };
      const read = (key, depth) => {
        if (++nodes > 1000000 || depth > 128) throw Error('Metadata structure limit');
        const tag=byte();
        if (tag===0) return null;
        if (tag===1 || tag===2) return tag===2;
        if (tag===3 || tag===4) {
          let v;
          if (tag===3) { const n=uint(); v=(this.numbers.get(key)||0)+(n%2 ? -(n+1)/2 : n/2); if (!Number.isSafeInteger(v)) throw Error('Invalid delta'); }
          else { if (pos+8>bytes.length) throw Error('Truncated float'); v=new DataView(bytes.buffer,bytes.byteOffset+pos,8).getFloat64(0,true); pos+=8; if (!Number.isFinite(v)) throw Error('Invalid float'); }
          if (this.numbers.size < SLOTS || this.numbers.has(key)) this.numbers.set(key,v); return v;
        }
        if (tag===5) return string(context(key));
        if (tag===8) { const s=this.objects.values[uint()]; if (s===undefined) throw Error('Missing object reference'); spend(s.length); return JSON.parse(s); }
        if (tag!==6 && tag!==7) throw Error('Unknown metadata tag');
        const length=uint(); if (length>1000000 || length>bytes.length-pos) throw Error('Invalid container size');
        const v=tag===6 ? [] : {};
        for (let i=0;i<length;i++) {
          if (tag===6) v.push(read(key,depth+1));
          else { const k=string(3); Object.defineProperty(v,k,{value:read(k,depth+1),enumerable:true,writable:true,configurable:true}); }
        }
        const signature=JSON.stringify(v); if (signature.length>=16 && signature.length<=4096) this.objects.add(signature);
        return v;
      };
      const result=read('',0); if(pos!==bytes.length) throw Error('Trailing metadata'); return result;
    }
  }
  function isFrame(b) { return b.length>=5 && MAGIC.every((x,i)=>b[i]===x); }
  const api={Codec,isFrame,LIMIT,protocol:'brisk-binary-v1'};
  if (typeof module !== 'undefined' && module.exports) module.exports=api;
  root.BriskMetadata=api;
})(globalThis);
