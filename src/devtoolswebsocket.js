import './viewport.js';
import './metadataCodec.js';
import {GsStream} from './gs/stream.js';

// Bounded inflate for compressed BRM1 metadata frames.
export async function inflateBounded(bytes, format = 'deflate') {
  const maximum = 16 * 1024 * 1024;
  if (bytes.byteLength > maximum) throw new Error('Compressed metadata exceeds size limit');
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format)).getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new Error('Metadata exceeds decoded size limit');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  return new Blob(chunks).arrayBuffer();
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
    this.req=this.req.bind(this);
    this.metadataEncoder = new globalThis.BriskMetadata.Codec();
    this.metadataDecoder = new globalThis.BriskMetadata.Codec();
    this.binaryType = 'arraybuffer';
    this.streamClosed = false;
    this.addEventListener('close', () => {
      this.streamClosed = true;
      for (const callback of this.callbacks) if (callback) callback.reject(new Error('Browser connection closed'));
      this.callbacks = [];
      this._gs?.close();
      this.metadataEncoder = null;
      this.metadataDecoder = null;
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
  // The stream's pixel/text decoders and compositor. Created on first use so a
  // page that never streams pixels loads none of it.
  get gs() {
    return this._gs ||= new GsStream();
  }
  handleMessageData(data) {
      this.wireBytes_ = data instanceof ArrayBuffer ? data.byteLength : (data && data.length) || 0;
      if (data instanceof ArrayBuffer) {
        const bytes = new Uint8Array(data);
        // Stream packets (docs/gpu-stream-wire.md): pixels, text, control.
        if (bytes.length && bytes[0] === 0xB7) return this.gs.handle(bytes);
        if (globalThis.BriskMetadata.isFrame(bytes)) {
          if (bytes[4] === 0) return this.dispatchMessage(this.metadataDecoder.decode(bytes));
          if (bytes[4] !== 2) throw Error('Unknown metadata compression');
          return inflateBounded(bytes.subarray(5), 'deflate').then(buffer => {
            if (this.streamClosed) return;
            const packet = new Uint8Array(5 + buffer.byteLength);
            packet.set([66,82,77,49,0]); packet.set(new Uint8Array(buffer),5);
            this.dispatchMessage(this.metadataDecoder.decode(packet));
          });
        }
        throw Error('PageStream: unknown binary frame');
      }
      return this.dispatchMessage(JSON.parse(data));
  }
  dispatchMessage(d) {
      // Bounded ring for the frame-pacing/first-paint probes (test/run_popular_site.js): what arrived, when, and how large on the wire.
      const ring = globalThis.briskMsgTrace || (globalThis.briskMsgTrace = []);
      ring.push({at: performance.now(), method: d.method || (d.id !== undefined ? 'reply' : '?'), bytes: this.wireBytes_ || 0});
      if (ring.length > 600) ring.splice(0, ring.length - 400);
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
