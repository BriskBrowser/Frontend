// Implements the chrome devtools protocol on top of a websocket.
export class devToolsWebsocket extends WebSocket {
  constructor(host){
    super(host + '/devtools/browser');
    this.nextid=0;
    this.callbacks = [];
    this.eventListeners = [];
    this.childSockets = [];
    this.addEventListener('message', (evt) => {
      var d = JSON.parse(evt.data);
      if (this.callbacks[d.id]) {
        if (d.result)
          this.callbacks[d.id].resolve(d.result);
        else
          this.callbacks[d.id].reject(d.error);
        delete this.callbacks[d.id];
      } else
      if (this.eventListeners[d.method])
        this.eventListeners[d.method](d.params)
      this.childSockets.forEach(x=>x.handleMessage(d));
    });
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
