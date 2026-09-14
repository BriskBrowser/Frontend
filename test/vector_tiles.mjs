import assert from 'node:assert/strict';
import fs from 'node:fs';
import {gzipSync} from 'node:zlib';
import {EventEmitter} from 'node:events';
class FakeSocket extends EventEmitter {
  addEventListener(...args) {this.on(...args);}
  close(code) {this.closed=code;}
}
globalThis.WebSocket=FakeSocket;
globalThis.BriskTileDelta = (await import('../src/tileDelta.js')).default;
globalThis.BriskGlyphCodec = (await import('../src/glyphcodec.js')).default;
const source=Buffer.from(fs.readFileSync(new URL('../src/devtoolswebsocket.js',import.meta.url), 'utf8').replace(/^import .*;$/gm, ''));
const {devToolsWebsocket,decodeVectorTile}=await import('data:text/javascript;base64,'+source.toString('base64'));
const svg='<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L10 0L0 10Z"/></svg>';
assert.equal(await (await decodeVectorTile(gzipSync(svg))).text(),svg);
await assert.rejects(()=>decodeVectorTile(Buffer.from('broken gzip')));
await assert.rejects(()=>decodeVectorTile(gzipSync(Buffer.alloc(16*1024*1024+1))),/decoded size limit/);
const socket=new devToolsWebsocket('ws://test');
const mime=Buffer.from('image/svg+xml+gzip'),body=gzipSync(svg),header=Buffer.alloc(9+mime.length);
header.writeUInt32BE(0x42524953,0);header.writeUInt32BE(42,4);header[8]=mime.length;mime.copy(header,9);
const packet=Buffer.concat([header,body]);
let received;
socket.eventListeners.tile=()=>{received=socket.takeBinaryImage(42);};
socket.emit('message',{data:packet.buffer.slice(packet.byteOffset,packet.byteOffset+packet.length)});
socket.emit('message',{data:JSON.stringify({method:'tile',params:{}})});
for(let i=0;i<100 && !received;i++)await new Promise(r=>setTimeout(r,10));
assert(received,'metadata must wait for preceding compressed tile');
assert.equal(await (await fetch(received)).text(),svg);
assert.equal(socket.takeBinaryImage(42),undefined,'tile ticket remains one-shot');
URL.revokeObjectURL(received);
assert.equal(socket.closed,undefined);
console.log('PASS gzip vectors: exact bytes, malformed/oversized rejection, ordered delivery and one-shot tickets');
const c = globalThis.BriskGlyphCodec, encoder = new c.Encoder();
const glyphSVG = id => `<svg xmlns='http://www.w3.org/2000/svg'><defs><path id='g${id}' d='M0 0L10 0L0 10Z'/></defs><use href='#g${id}'/></svg>`;
const wire = (id, bytes) => {
  const mime=Buffer.from('application/x-brisk-glyphs-v1+gzip'),h=Buffer.alloc(9+mime.length);
  h.writeUInt32BE(0x42524953);h.writeUInt32BE(id,4);h[8]=mime.length;mime.copy(h,9);
  const b=Buffer.concat([h,gzipSync(bytes)]);return b.buffer.slice(b.byteOffset,b.byteOffset+b.length);
};
const second = new devToolsWebsocket('ws://fork-test');
let count=0;const urls=[];
second.eventListeners.tile=params=>{urls.push(second.takeBinaryImage(params.id));count++;};
for (const [id,local] of [[1,0],[2,17]]) {
  const packet=encoder.encode(glyphSVG(local));assert.equal(packet.additions,id===1?1:0);
  second.emit('message',{data:wire(id,packet.bytes)});
  second.emit('message',{data:JSON.stringify({method:'tile',params:{id}})});
}
for(let i=0;i<100 && count<2;i++)await new Promise(r=>setTimeout(r,10));
assert.equal(count,2);assert.equal(second.glyphDecoder.paths.size,1);
assert((await (await fetch(urls[1])).text()).includes("id='g17'"));
urls.forEach(url=>URL.revokeObjectURL(url));
second.emit('close');assert.equal(second.glyphDecoder,null);assert.equal(second.receiveQueue.length,0);
const third=new devToolsWebsocket('ws://close-during-decode');
third.emit('message',{data:wire(1,new c.Encoder().encode(glyphSVG(0)).bytes)});
third.emit('close');await new Promise(r=>setTimeout(r,30));assert.equal(third.binaryImages.size,0);
console.log('PASS glyph vectors: asynchronous dictionary-before-reference ordering, sibling ID remapping and close cleanup');
