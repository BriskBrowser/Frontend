import {devToolsWebsocket, devToolsSession} from './devtoolswebsocket.js'
import {selectWebsocket} from './loadbalancer.js'
import {Session} from './session.js'


export class Browser {
  constructor(rootElement, options) {
    this.rootElement = rootElement;
    this.options = options;
    this.sessions = {};
  }

  async init() {
    // get the websocket loading early in the page load.
    let wsPromise = selectWebsocket(this.options.websocketServer, this.options.websocketPool);

    var socket = this.socket = await wsPromise;

    if (!window.navigator.userAgent.match(/Chrome\/[.0-9]* Mobile/)) {
      alert("Hold Up!  We only support Android Chrome right now...   Click OK to try anyway...   But it probably won't work :-(")
    }

    window.sessions = this.sessions;  // for testing

    // All these are run serially on connection, but none depend on a
    // response from a request.  The intention is a server can fire
    // off all these requests to the browser before the client even
    // connects to speed up initial loading.
    socket.req(undefined, 'Target.setDiscoverTargets', {discover: true});
    socket.eventListeners['Target.targetCreated'] = function (msg) {
      if (msg.targetInfo.type == 'page' && !this.attached) {
        socket.req(undefined, 'Target.attachToTarget', {targetId: msg.targetInfo.targetId, flatten: true});
        this.attached = true;
      }
    };

    socket.eventListeners['Target.attachedToTarget'] = msg => {
      // TODO:  Handle case of multiple targets/sessions/windows etc.
      console.log("new target", msg);
      
      var sess = this.addSession(msg.sessionId, null);
      this.sessionActivate(msg.sessionId);

      let dims = this.rootElement.getBoundingClientRect();
      sess.resize(dims.width, dims.height, window.devicePixelRatio);

      sess.ws.req('Page.enable', {});
      sess.ws.req('PageStream.enable', {fps: 0, targetBandwidth: 999999999});
      sess.ws.req('Page.navigate', {url: this.currentURL()});
    };

    socket.eventListeners['Target.detachedFromTarget'] = msg => {
      this.sessions[msg.sessionId].destroy();
      delete this.sessions[msg.sessionId];
      this.arrangeSessions();
    }

    socket.eventListeners['Target.targetInfoChanged'] = params => {
      return; // TODO:  Fix
      // Update URL and page title
      if (params.targetInfo.url.startsWith('http'))
        if (this.currentURL() != params.targetInfo.url)
          history.pushState({}, "test", '/'+params.targetInfo.url);
      // This doesn't work properly because the browser doesn't emit an event if
      // the title changes without a navigation event happening.
      document.title = params.targetInfo.title;
    };


    var resize = () => {
      let dims = this.rootElement.getBoundingClientRect();
      Object.values(this.sessions).forEach(x => x.resize(dims.width, dims.height, window.devicePixelRatio));
    }
    window.addEventListener('resize', resize);
  }

  currentURL() {
    var path = document.location.pathname;
    var search = document.location.search;
    if (path.startsWith('/http')) return path.substring(1)+search+document.location.hash;
    if (search.startsWith('?http')) return search.substring(1)+document.location.hash;
    return document.location.href;
  }

  arrangeSessions() {
    return;
    var ca = this.sessions[this.activeSession].childArrangement;
    if (!ca) return;
    var eligibleSessions = Object.keys(ca).filter(x => x in this.sessions);
    eligibleSessions.sort((a,b) => ca[a] - ca[b]);

    eligibleSessions.forEach((x, index)=> {
      this.sessions[x].domElement_.style.setProperty("--height", (index/(eligibleSessions.length)*100) + 'vh');
    });
  }

  sessionSetHeight(fromSessionId, toSessionId, height) {
    this.sessions[fromSessionId].childArrangement = this.sessions[fromSessionId].childArrangement || {};
    this.sessions[fromSessionId].childArrangement[toSessionId] = height;
    arrangeSessions();
  }

  sessionActivate(sessionId) {
/*    Object.keys(sessions).forEach((sid) => {
      //var cl = sessions[sid].domElement_.classList;
      //cl.replace('active', 'old-active');
      //cl.toggle('active', sid==sessionId);
      sessions[sid].domElement = null;
    }); */
    var elem = document.createElement('bb-session');
    this.rootElement.appendChild(elem);
    elem.classList.add('active');
    this.activeSession && (this.sessions[this.activeSession].domElement = null);
    this.sessions[sessionId].domElement = elem;

    this.activeSession = sessionId;
    this.arrangeSessions();
  }

  addSession(sessionId, existingSession) {
    if (this.sessions[sessionId]) return;
    
    
    var ws = new devToolsSession(this.socket, sessionId);
    
    var sess = new Session(ws, existingSession);
    this.sessions[sessionId] = sess;

    
    // Event emitted whenever this session wants to trigger the creation of a clone of itself.
    sess.onNewSession = this.addSession;

    // Event emitted whenever this session wants to activate another session.
    sess.onSessionActivate = this.sessionActivate;

    // UX data linkage to allow non-active sessions to be rendered on the screen at positions
    // dependant on the links which will activate them.  Called repeatedly on scroll.
    sess.onSessionSetHeight = this.sessionSetHeight.bind(this, sessionId);

    return sess;
  }

}