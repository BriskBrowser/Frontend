import './viewport.js';
import './metadataCodec.js';
import './tileDelta.js';
import {decodeImageTile} from './h264tiles.js';
// Decoders for packet types a page may never send stay out of the startup
// bundle. The first packet of that type awaits the import; the ordered receive
// loop (drainMessages) holds every later packet until it has been handled.
const videoTiles = () => import('./videoTiles.js');
const glyphCodec = () => globalThis.BriskGlyphCodec ? Promise.resolve(globalThis.BriskGlyphCodec) :
  import('./glyphcodec.js').then(() => globalThis.BriskGlyphCodec);
// Bounded decoding of self-contained SVG tiles: the server supplies shaped
// glyph paths and an embedded raster background, never executable page markup.
export async function decodeVectorTile(bytes, format = 'gzip') {
  const maximum = 16 * 1024 * 1024;
  if (bytes.byteLength > maximum) throw new Error('Vector tile exceeds compressed size limit');
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format)).getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new Error('Vector tile exceeds decoded size limit');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  return new Blob(chunks, {type: 'image/svg+xml'});
}

// Implements the chrome devtools protocol on top of a websocket.
export class devToolsWebsocket extends WebSocket {
  constructor(host){
    const early = globalThis.briskEarly;
    const socket = early && early.ws.url.split('?')[0] === host.replace(/\/$/, '') + '/devtools/browser' && early.ws.readyState < 2 ? early.ws : new WebSocket(host.replace(/\/$/, '') + '/devtools/browser?' + new URLSearchParams(globalThis.briskViewport()), globalThis.BriskMetadata.protocol);
    Object.setPrototypeOf(socket, new.target.prototype);
    socket.initialize();
    if (early) {
      early.ws.removeEventListener('message', early.capture);
      if (socket === early.ws) {socket.initialViewport=early.viewport;for(const m of early.messages)socket.countReceived(m);socket.receiveQueue.push(...early.messages);socket.drainMessages();}
      else early.ws.close();
      delete globalThis.briskEarly;
    }
    return socket;
  }
  initialize(){
    this.req=this.req.bind(this);this.takeBinaryImage=this.takeBinaryImage.bind(this);
    this.metadataEncoder = new globalThis.BriskMetadata.Codec();
    this.metadataDecoder = new globalThis.BriskMetadata.Codec();
    this.binaryType = 'arraybuffer';
    this.binaryImages = new Map();
    this.tileDelta = new globalThis.BriskTileDelta.Cache();
    this.glyphDecoder = null; // created with the first glyph packet
    this.streamClosed = false;
    this.addEventListener('close', event => {
      // One automatic recovery on codec/base failure: a new connection starts
      // with independent tiles, so no stale prediction history can survive.
      if (this.tileStreamNegotiated && [1002,1011,1013,4002].includes(event.code)) {
        try {if (sessionStorage.getItem('briskTileStreamRecovery') !== '1') {sessionStorage.setItem('briskTileStreamRecovery','1');location.reload();}} catch (_) {}
      }
      this.streamClosed = true;
      for (const callback of this.callbacks) if (callback) callback.reject(new Error('Browser connection closed'));
      this.callbacks = [];
      for (const source of this.binaryImages.values())
        if (typeof source === 'string') URL.revokeObjectURL(source);
      if (this.tileStreamDecoder) this.tileStreamDecoder.close();
      if (this.patchAtlasDecoder) this.patchAtlasDecoder.close();
      if (this.h264Decoder) this.h264Decoder.close();
      if (this.vp9Decoder) this.vp9Decoder.close();
      this.binaryImages.clear();
      this.metadataEncoder = null;
      this.metadataDecoder = null;
      this.glyphDecoder = null;
      this.tileDelta = null;
      this.receiveQueue.length = 0;
    });
    this.nextid=0;
    this.callbacks = [];
    this.pendingEvents = Object.create(null);
    const pendingEvents = this.pendingEvents;
    this.eventListeners = new Proxy([], {
      set(target, method, handler) {
        target[method] = handler;
        if (typeof handler === 'function' && pendingEvents[method]) {
          const queued = pendingEvents[method];
          delete pendingEvents[method];
          queued.forEach(params => handler(params));
        }
        return true;
      }
    });
    this.childSockets = [];
    this.receiveQueue = [];
    this.receiveHead = 0;
    this.receiving = false;
    this.receivedBytes = 0;
    this.reportedBytes = 0;
    this.addEventListener('message', evt => {
      if (this.streamClosed) return;
      this.countReceived(evt.data);
      this.receiveQueue.push(evt.data);
      this.drainMessages();
    });
  }
  async drainMessages() {
    if (this.receiving) return;
    this.receiving = true;
    let deadline=performance.now()+4;
    try {
      while (this.receiveHead < this.receiveQueue.length) {
        if(performance.now()>=deadline){
          await new Promise(resolve=>setTimeout(resolve,0));
          deadline=performance.now()+4;
          if(this.streamClosed)break;
        }
        if(this.receiveHead>=1024 && this.receiveHead*2>=this.receiveQueue.length){
          this.receiveQueue.splice(0,this.receiveHead);this.receiveHead=0;
        }
        const data = this.receiveQueue[this.receiveHead];
        this.receiveQueue[this.receiveHead++] = null;
        const pending = this.handleMessageData(data);
        if (pending) {
          // Decoder waits already let browser tasks run; charge the budget
          // for synchronous dispatch, not time waiting for pixels.
          const paused=performance.now();await pending;deadline+=performance.now()-paused;
        }
      }
    } catch (error) {
      this.receiveQueue.length = 0;
      console.error('PageStream: invalid tile stream', error);
      this.close(4002, 'Invalid tile stream');
    } finally {
      this.receiveQueue.length = 0;
      this.receiveHead = 0;
      this.receiving = false;
    }
  }
  // Tell the proxy how much has arrived, so it keeps only about one round
  // trip of data in flight and holds the rest where it can still be
  // prioritised (the foreground page before hidden previews).
  countReceived(data) {
    this.receivedBytes += data.byteLength ?? data.length ?? 0;
    if (this.receivedBytes - this.reportedBytes < 4096) return;
    // Never disturb receiving: report only once this socket can encode
    // requests; an unsent report is simply folded into the next one.
    if (this.readyState !== 1 || (this.protocol === globalThis.BriskMetadata.protocol && !this.metadataEncoder)) return;
    this.reportedBytes = this.receivedBytes;
    try { this.req(undefined, 'Brisk.received', {bytes: this.receivedBytes}).catch(() => {}); } catch (_) {}
  }
  handleMessageData(data) {
      if (data instanceof ArrayBuffer) {
        const bytes = new Uint8Array(data);
        if (globalThis.BriskMetadata.isFrame(bytes)) {
          if (bytes[4] === 0) return this.dispatchMessage(this.metadataDecoder.decode(bytes));
          if (bytes[4] !== 2) throw Error('Unknown metadata compression');
          return decodeVectorTile(bytes.subarray(5), 'deflate').then(blob => blob.arrayBuffer()).then(buffer => {
            if (this.streamClosed) return;
            const packet = new Uint8Array(5 + buffer.byteLength);
            packet.set([66,82,77,49,0]); packet.set(new Uint8Array(buffer),5);
            this.dispatchMessage(this.metadataDecoder.decode(packet));
          });
        }
        const view = new DataView(data);
        if (bytes.length < 9 || view.getUint32(0) !== 0x42524953) {
          throw Error('PageStream: invalid binary tile frame');
        }
        const id = view.getUint32(4);
        const mimeLength = bytes[8];
        if (bytes.length < 9 + mimeLength) {
          throw Error('PageStream: truncated binary tile frame');
        }
        const decoded = this.tileDelta.decode(new TextDecoder().decode(bytes.subarray(9, 9 + mimeLength)), bytes.subarray(9 + mimeLength));
        const mime = decoded.mime, payload = decoded.bytes;
        if (mime === 'application/x-brisk-patch-atlas-v1') {
          return import('./patchAtlas.js').then(({PatchAtlasDecoder})=>{
            if(this.streamClosed)return;
            if(!this.patchAtlasDecoder)this.patchAtlasDecoder=new PatchAtlasDecoder();
            return this.patchAtlasDecoder.decode(payload).then(canvas=>{if(!this.streamClosed)this.binaryImages.set(id,canvas);});
          });
        }
        if (mime === 'application/x-brisk-stream-v1') {
          // Via patchAtlas.js, which the bundled client preloads anyway: one
          // module and request instead of a separate shared tileStream chunk.
          return import('./patchAtlas.js').then(({TileStreamDecoder})=>{
            if(this.streamClosed)return;
            if(!this.tileStreamDecoder)this.tileStreamDecoder=new TileStreamDecoder();
            return this.tileStreamDecoder.decode(payload).then(canvas=>{if(!this.streamClosed)this.binaryImages.set(id,canvas);});
          });
        }
        if (mime === 'video/webm' || mime === 'video/h264') {
          return videoTiles().then(({H264TileDecoder, Vp9TileDecoder}) => {
            // A decoder created after close would never be closed.
            if (this.streamClosed) return;
            const decoder = mime === 'video/webm' ? (this.vp9Decoder ||= new Vp9TileDecoder()) :
              (this.h264Decoder ||= new H264TileDecoder());
            return decoder.decode(payload).then(canvas => {
              if (!this.streamClosed) this.binaryImages.set(id, canvas);
            });
          });
        }
        if (mime === 'application/x-brisk-glyphs-v1+gzip') {
          // Decompression overlaps the (first-packet-only) codec download.
          return Promise.all([glyphCodec(), decodeVectorTile(payload).then(blob => blob.arrayBuffer())]).then(([codec, buffer]) => {
            if (this.streamClosed) return; // socket closed during decompression
            // One dictionary per physical socket, like the server's encoder.
            this.glyphDecoder ||= new codec.Decoder();
            const svg = this.glyphDecoder.decode(new Uint8Array(buffer));
            return decodeImageTile(new Blob([svg], {type: 'image/svg+xml'})).then(canvas => {
              if (!this.streamClosed) this.binaryImages.set(id, canvas);
            });
          });
        }
        if (mime === 'image/svg+xml+gzip') {
          // Metadata must not overtake decompression or image decoding.
          // The ordered receive queue waits until pixels can be placed
          // synchronously, just as it does for video tiles.
          return decodeVectorTile(payload).then(decodeImageTile).then(canvas => {
            if (!this.streamClosed) this.binaryImages.set(id, canvas);
          });
        }
        const blob = new Blob([payload], {type: mime});
        return decodeImageTile(blob).then(canvas => {
          if (!this.streamClosed) this.binaryImages.set(id, canvas);
        });
      }
      return this.dispatchMessage(JSON.parse(data));
  }
  dispatchMessage(d) {
      if (d.method === 'PageStream.tileDictionaryReset') {
        this.tileDelta = new globalThis.BriskTileDelta.Cache();
        return;
      }
      if (this.callbacks[d.id]) {
        if (d.result)
          this.callbacks[d.id].resolve(d.result);
        else
          this.callbacks[d.id].reject(d.error);
        delete this.callbacks[d.id];
      } else
      if (this.eventListeners[d.method]) {
        this.eventListeners[d.method](d.params)
      } else if (d.method) {
        const queue = this.pendingEvents[d.method] || (this.pendingEvents[d.method] = []);
        queue.push(d.params);
        if (queue.length > 32) queue.shift();
      }
      this.childSockets.forEach(x=>x.handleMessage(d));
  } 
  takeBinaryImage(id) {
    const src = this.binaryImages.get(id);
    this.binaryImages.delete(id);
    return src;
  }
  req(sessionId, method, params) {
    return new Promise((resolve, reject) => {
      // Normalize optional fields exactly as the legacy JSON request did.
      const request = JSON.stringify({id: this.nextid, method, params, sessionId});
      try {
        this.send(this.protocol === globalThis.BriskMetadata.protocol
          ? this.metadataEncoder.encode(JSON.parse(request)) : request);
      } catch (error) {
        // Encoding advances dictionaries. A failed send cannot be skipped.
        this.close(4002, 'Metadata send failed');
        throw error;
      }
      this.callbacks[this.nextid] = {resolve, reject}
      this.nextid++;
    });
  }
}

// Points to a devToolsWebsocket and can perform requests on a specific session.
export class devToolsSession {
  constructor (ws, sessionId) {
    this.ws = ws;
    this.sessionId = sessionId;
    this.eventListeners = [];
    this.ws.childSockets.push(this);
  }
  req = (method, params) => {
    return this.ws.req(this.sessionId, method, params);
  }
  handleMessage = (msg) => {
    if (msg.sessionId == this.sessionId  && this.eventListeners[msg.method])
        this.eventListeners[msg.method](msg.params);
  }
  destroy = () => {
    this.ws.childSockets = this.ws.childSockets.filter(x=> x != this);
  }
}
