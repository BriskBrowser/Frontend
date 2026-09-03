import {devToolsWebsocket, devToolsSession} from './devtoolswebsocket.js?v=20260825-earlyevents1'
import {selectWebsocket} from './loadbalancer.js?v=20260825-earlyevents1'
import {Session} from './session.js?v=20260901-tilecache1'
import {interactionTrace} from './interactionTrace.js?v=20260827-trace1'

// Kept in sync with SocketHandler.js's DEFAULT_WARM_URL (the server keeps
// one Chromium instance permanently pre-navigated to this exact URL) --
// this is what currentURL() falls back to below, and what the eager
// compositor snapshot in init() is allowed to keep showing while that
// default page loads.
const DEFAULT_HOME_URL = 'https://briskbrowser.com/home';

export class Browser {
  constructor(rootElement, options) {
    this.rootElement = rootElement;
    this.options = options;
    this.sessions = {};
    this.historyTraversal = false;
  }

  async init() {
    // The eager compositor snapshot is intentionally specific to the default
    // landing page. Never flash the homepage while loading an explicitly
    // requested URL; that request goes straight to the live PageStream path.
    if (this.currentURL() !== DEFAULT_HOME_URL) {
      const warmPreview = document.getElementById('warm-preview');
      if (warmPreview) warmPreview.remove();
    }

    // get the websocket loading early in the page load.
    let wsPromise = selectWebsocket(this.options.websocketServer, this.options.websocketPool);

    var socket = this.socket = await wsPromise;

    if (!window.navigator.userAgent.match(/Chrome\/[.0-9]* Mobile/)) {
      alert("Hold Up!  We only support Android Chrome right now...   Click OK to try anyway...   But it probably won't work :-(")
    }

    window.sessions = this.sessions;  // for testing
    // The outer browser's address/history is the thin client's navigation
    // UI. Store the represented server-side URL in every entry so native
    // back and forward buttons can drive the active remote page.
    history.replaceState({briskURL: this.currentURL()}, '',
        this.frontendPathForURL(this.currentURL()));
    window.addEventListener('popstate', event => {
      const url = event.state && event.state.briskURL || this.currentURL();
      const session = this.sessions[this.activeSession];
      if (!session || !url) return;
      this.historyTraversal = true;
      // Covers both back and forward (popstate doesn't distinguish them),
      // but 'back' is overwhelmingly the real-world case (mobile back
      // button/edge-swipe) and the destination url is what replay actually
      // needs, so a single event type is enough here.
      interactionTrace.record('back', {url});
      session.ws.req('PageStream.navigateHistory', {url}).catch(error => {
        this.historyTraversal = false;
        console.error('History navigation failed:', error);
      });
    });

    // All these are run serially on connection, but none depend on a
    // response from a request.  The intention is a server can fire
    // off all these requests to the browser before the client even
    // connects to speed up initial loading.
    socket.eventListeners['Target.targetCreated'] = msg => {
      if (msg.targetInfo.type == 'page' && !this.attached) {
        socket.req(undefined, 'Target.attachToTarget', {targetId: msg.targetInfo.targetId, flatten: true});
        this.attached = true;
      }
    };

    socket.eventListeners['Target.attachedToTarget'] = msg => {
      // Only a real page target is something this client can render, and
      // 'Target.targetCreated' above has always agreed (`type == 'page'`) --
      // but this handler did not, and it is the one that actually builds a
      // Session, makes it the *active* one, and issues a Page.navigate.
      //
      // Chromium auto-attaches every dedicated/shared/service worker the page
      // spawns, and those attaches come down this same socket. Each one used
      // to create a brand-new empty Session, activate it (hiding the real
      // page, which had already painted), and then send Page.navigate to a
      // worker session -- where it does nothing at all, so the "page" the
      // user is now looking at stays blank forever. Every worker the site
      // creates repeats the cycle, which is the endlessly-churning
      // window.sessions/never-renders failure seen on every Cloudflare
      // Turnstile-protected site (its challenge runs in blob: workers) and on
      // anything else worker-heavy: w3.org, github, crates.io, duckduckgo,
      // hackernews/newest, the python/django/webpack docs, and so on. Pages
      // with no workers (wikipedia) were unaffected, which is exactly why the
      // failure looked site-specific rather than structural.
      //
      // Filtered client-side as well as in SocketHandler.browserEventHandler()
      // (which no longer forwards non-page target attaches at all) because
      // this handler's assumption is a client-side invariant in its own right
      // -- addSession/sessionActivate/Page.navigate are only ever meaningful
      // for a page.
      if (!msg.targetInfo || msg.targetInfo.type !== 'page') return;

      // TODO:  Handle case of multiple targets/sessions/windows etc.
      console.log("new target", msg);

      var sess = this.addSession(msg.sessionId, null);
      if (!sess) return;   // duplicate attach for a session we already have
      this.sessionActivate(msg.sessionId);

      sess.resize();
      sess.ws.req('Page.enable', {});
      // Proxy-only capability: SocketHandler strips binaryTiles before
      // forwarding this command to Chromium. Negotiated clients receive tile
      // payloads as binary WebSocket frames and Blob URLs instead of paying
      // Base64 expansion/decoding in JSON.
      sess.ws.req('PageStream.enable', {
        fps: 0, targetBandwidth: 999999999, binaryTiles: true
      });
      interactionTrace.record('navigate', {url: this.currentURL()});
      sess.ws.req('Page.navigate', {url: this.currentURL()});
    };

    socket.eventListeners['Target.detachedFromTarget'] = msg => {
      if (!this.sessions[msg.sessionId]) return;   // duplicate/unmatched detach
      this.sessions[msg.sessionId].destroy();
      delete this.sessions[msg.sessionId];
      this.arrangeSessions();
    }

    socket.eventListeners['Target.targetInfoChanged'] = params => {
      // Same reasoning as the attachedToTarget guard above: a worker target's
      // info change is not the page's. Without this, a blob: worker's title
      // ("blob:https://www.w3.org/<uuid>") became the tab title.
      if (!params.targetInfo || params.targetInfo.type !== 'page') return;
      if (params.targetInfo.title) document.title = params.targetInfo.title;
      if (params.targetInfo.url && params.targetInfo.url.startsWith('http'))
        this.committedURLChanged(this.activeSession, params.targetInfo.url);
    };

    // Enabling discovery can synchronously produce targetCreated on a fast
    // local backend. Install every handshake listener first so the initial
    // page target cannot arrive in the gap and leave this client blank.
    socket.req(undefined, 'Target.setDiscoverTargets', {discover: true});


    var resize = () => {
      Object.values(this.sessions).forEach(x => x.resize());
    }
    window.addEventListener('resize', resize);
  }

  currentURL() {
    var path = document.location.pathname;
    var search = document.location.search;
    if (path.startsWith('/http')) return path.substring(1)+search+document.location.hash;
    if (search.startsWith('?http')) return search.substring(1)+document.location.hash;
    // Real bug, found live: this used to fall back to document.location.href
    // -- this app's OWN url -- whenever it was loaded with no target embedded
    // in the path/query (e.g. visiting the bare deployment root). That tells
    // the server-side browser to navigate to the Brisk Browser frontend
    // itself, which loads and runs *this same client*, which attaches and
    // navigates again, recursively -- a self-referential explosion of
    // Target.attachToTarget/navigate calls that floods the connection with
    // targets until it crashes. Observed directly: visiting the bare root
    // produced hundreds of rapid connect/disconnect cycles in the server log
    // (the "flickering" symptom) before the tab gave out. A sensible,
    // non-self-referential default instead: Brisk's own homepage, served at
    // a distinct path (HttpHandler.js's /home) so it can never be this same
    // frontend app and re-trigger the recursion.
    return DEFAULT_HOME_URL;
  }

  frontendPathForURL(url) {
    return '/' + url;
  }

  committedURLChanged(sessionId, url) {
    if (!url || !url.startsWith('http') || sessionId !== this.activeSession) return;
    const stateURL = history.state && history.state.briskURL;
    if (stateURL === url) {
      this.historyTraversal = false;
      return;
    }
    const method = this.historyTraversal ? 'replaceState' : 'pushState';
    history[method]({briskURL: url}, '', this.frontendPathForURL(url));
    this.historyTraversal = false;
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
    this.arrangeSessions();
  }

  sessionActivate(sessionId, destinationURL) {
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
    if (destinationURL) this.sessions[sessionId].currentURL = destinationURL;
    // A speculative session normally completed its navigation while hidden,
    // so its frameNavigated event was correctly ignored by the address bar.
    // Publish that stored destination at the exact promotion point.
    if (this.sessions[sessionId].currentURL)
      this.committedURLChanged(sessionId, this.sessions[sessionId].currentURL);
    this.arrangeSessions();
  }

  addSession(sessionId, existingSession) {
    if (this.sessions[sessionId]) return;
    
    
    var ws = new devToolsSession(this.socket, sessionId);

    var sess = new Session(ws, existingSession, this.options);
    this.sessions[sessionId] = sess;

    
    // Event emitted whenever this session wants to trigger the creation of a clone of itself.
    // Unbound, these run with `this` == the Session that calls them (session.js
    // invokes them as `this.onX(...)`), not the Browser -- both immediately
    // dereferenced this.sessions/this.socket/this.rootElement, none of which
    // exist on a Session, throwing every time. onSessionActivate in particular
    // is called from targetTouch() -- the real user-tap handler that promotes a
    // preloaded/predicted session on tap, i.e. the product's headline "zero
    // perceived latency" mechanic -- so every real tap on a preloaded target
    // silently failed to activate it.
    sess.onNewSession = this.addSession.bind(this);

    // Event emitted whenever this session wants to activate another session.
    sess.onSessionActivate = this.sessionActivate.bind(this);

    // UX data linkage to allow non-active sessions to be rendered on the screen at positions
    // dependant on the links which will activate them.  Called repeatedly on scroll.
    sess.onSessionSetHeight = this.sessionSetHeight.bind(this, sessionId);
    sess.onURLChange = this.committedURLChanged.bind(this, sessionId);

    return sess;
  }

}
