// Implements the chrome devtools protocol on top of a websocket.
export class devToolsWebsocket extends WebSocket {
  constructor(host){
    super(host + '/devtools/browser');
    this.binaryType = 'arraybuffer';
    this.binaryImages = new Map();
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
    this.addEventListener('message', (evt) => {
      if (evt.data instanceof ArrayBuffer) {
        const bytes = new Uint8Array(evt.data);
        const view = new DataView(evt.data);
        if (bytes.length < 9 || view.getUint32(0) !== 0x42524953) {
          console.error('PageStream: invalid binary tile frame');
          return;
        }
        const id = view.getUint32(4);
        const mimeLength = bytes[8];
        if (bytes.length < 9 + mimeLength) {
          console.error('PageStream: truncated binary tile frame');
          return;
        }
        const mime = new TextDecoder().decode(bytes.slice(9, 9 + mimeLength));
        const blob = new Blob([bytes.slice(9 + mimeLength)], {type: mime});
        this.binaryImages.set(id, URL.createObjectURL(blob));
        return;
      }
      var d = JSON.parse(evt.data);
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
    });
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
