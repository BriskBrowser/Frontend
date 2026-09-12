import './glyphcodec.js';
// Bounded decoding of self-contained SVG tiles: the server supplies shaped
// glyph paths and an embedded raster background, never executable page markup.
export async function decodeVectorTile(bytes) {
  const maximum = 16 * 1024 * 1024;
  if (bytes.byteLength > maximum) throw new Error('Vector tile exceeds compressed size limit');
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
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
    super(host + '/devtools/browser');
    this.binaryType = 'arraybuffer';
    this.binaryImages = new Map();
    this.glyphDecoder = new globalThis.BriskGlyphCodec.Decoder();
    this.streamClosed = false;
    this.addEventListener('close', () => {
      this.streamClosed = true;
      for (const url of this.binaryImages.values()) URL.revokeObjectURL(url);
      this.binaryImages.clear();
      this.glyphDecoder = null;
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
    this.receiving = false;
    this.addEventListener('message', evt => {
      if (this.streamClosed) return;
      this.receiveQueue.push(evt.data);
      this.drainMessages();
    });
  }
  async drainMessages() {
    if (this.receiving) return;
    this.receiving = true;
    try {
      while (this.receiveQueue.length) {
        const pending = this.handleMessageData(this.receiveQueue.shift());
        if (pending) await pending;
      }
    } catch (error) {
      this.receiveQueue.length = 0;
      console.error('PageStream: invalid tile stream', error);
      this.close(1002, 'Invalid tile stream');
    } finally {
      this.receiving = false;
    }
  }
  handleMessageData(data) {
      if (data instanceof ArrayBuffer) {
        const bytes = new Uint8Array(data);
        const view = new DataView(data);
        if (bytes.length < 9 || view.getUint32(0) !== 0x42524953) {
          throw Error('PageStream: invalid binary tile frame');
        }
        const id = view.getUint32(4);
        const mimeLength = bytes[8];
        if (bytes.length < 9 + mimeLength) {
          throw Error('PageStream: truncated binary tile frame');
        }
        const mime = new TextDecoder().decode(bytes.slice(9, 9 + mimeLength));
        const payload = bytes.slice(9 + mimeLength);
        if (mime === 'application/x-brisk-glyphs-v1+gzip') {
          return decodeVectorTile(payload).then(blob => blob.arrayBuffer()).then(buffer => {
            if (!this.glyphDecoder) return; // socket closed during decompression
            const svg = this.glyphDecoder.decode(new Uint8Array(buffer));
            this.binaryImages.set(id, URL.createObjectURL(new Blob([svg], {type: 'image/svg+xml'})));
          });
        }
        if (mime === 'image/svg+xml+gzip') {
          // Metadata must not overtake asynchronous decompression. The
          // ordered receive queue below waits for this one tile, then runs
          // ordinary JSON and image messages synchronously again.
          return decodeVectorTile(payload).then(blob => {
            if (this.streamClosed) return;
            this.binaryImages.set(id, URL.createObjectURL(blob));
          });
        }
        const blob = new Blob([payload], {type: mime});
        this.binaryImages.set(id, URL.createObjectURL(blob));
        return;
      }
      var d = JSON.parse(data);
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
  takeBinaryImage = id => {
    const src = this.binaryImages.get(id);
    this.binaryImages.delete(id);
    return src;
  }
  req = (sessionId, method, params) => {
    return new Promise((resolve, reject) => {
      this.send(JSON.stringify({
        id: this.nextid,
        method,
        params,
        sessionId,
      }));
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
