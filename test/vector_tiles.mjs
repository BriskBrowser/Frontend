import assert from 'node:assert/strict';
import fs from 'node:fs';
import {gzipSync} from 'node:zlib';
import {EventEmitter} from 'node:events';
class FakeSocket extends EventEmitter {
  addEventListener(...args) {this.on(...args);}
  close(code) {this.closed=code;}
}
globalThis.WebSocket=FakeSocket;
const source=fs.readFileSync(new URL('../src/devtoolswebsocket.js',import.meta.url));
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
