import {ForkDebug} from './forkDebug.js';
import {supportsH264Tiles, supportsVp9Tiles} from './h264tiles.js';
import {devToolsWebsocket, devToolsSession} from './devtoolswebsocket.js?v=20260912-perf1'
import {selectWebsocket} from './loadbalancer.js?v=20260912-perf1'
import {Session} from './session.js?v=20260912-perf1'
import {interactionTrace} from './interactionTrace.js?v=20260827-trace1'

// Landing page for sessions without an explicitly requested URL.
const DEFAULT_HOME_URL = 'https://briskbrowser.com/home';

export class Browser {
  constructor(rootElement, options) {
    this.rootElement = rootElement;
    this.options = options;
    this.sessions = {};
    this.historyTraversal = false;
    this.historyIndex = 0;
  }

  async init() {
    // Redirect events can update the address while codecs/viewport initialize.
    // The eager server navigation must be acknowledged with the original URL.
    const startupURL = this.currentURL();
    // get the websocket loading early in the page load.
    const h264Supported = supportsH264Tiles();
    const vp9Supported = supportsVp9Tiles();
    let wsPromise = selectWebsocket(this.options.websocketServer, this.options.websocketPool);

    var socket = this.socket = await wsPromise;

    this.forkDebug = new ForkDebug(this);

    socket.addEventListener('close', () => this.showError('The browser connection was lost. Reload to reconnect.'));
    socket.eventListeners['PageStream.navigationFailed'] = params => {
      this.showError('Could not load this page: ' + (params.message || 'Navigation failed'));
    };
    window.sessions = this.sessions;  // for testing
    socket.eventListeners['PageStream.sessionAvailable'] = params => {
      this.addSession(params.sessionId, null);
    };
    socket.eventListeners['PageStream.activateSession'] = params => {
      this.addSession(params.sessionId, null);
      if (String(this.activeSession) !== String(params.sessionId))
        this.sessionActivate(params.sessionId);
    };
    // The outer browser's address/history is the thin client's navigation
    // UI. Store the represented server-side URL in every entry so native
    // back and forward buttons can drive the active remote page.
    this.historyIndex = history.state?.briskIndex || 0;
    history.replaceState({briskURL: this.currentURL(), briskIndex: this.historyIndex}, '',
        this.frontendPathForURL(this.currentURL()));
    window.addEventListener('popstate', event => {
      const url = event.state && event.state.briskURL || this.currentURL();
      const session = this.sessions[this.activeSession];
      if (!session || !url) return;
      this.historyTraversal = true;
      const index = event.state && event.state.briskIndex;
      const direction = Number.isInteger(index) ? Math.sign(index - this.historyIndex) : 0;
      if (Number.isInteger(index)) this.historyIndex = index;
      // Covers both back and forward (popstate doesn't distinguish them),
      // but 'back' is overwhelmingly the real-world case (mobile back
      // button/edge-swipe) and the destination url is what replay actually
      // needs, so a single event type is enough here.
      interactionTrace.record('back', {url});
      session.ws.req('PageStream.navigateHistory', {url, direction}).catch(error => {
        this.historyTraversal = false;
        console.error('History navigation failed:', error);
      });
    });

    // All these are run serially on connection, but none depend on a
    // response from a request.  The intention is a server can fire
    // off all these requests to the browser before the client even
    // connects to speed up initial loading.
    socket.eventListeners['PageStream.timing']=params=>performance.mark('brisk:server:'+params.stage,{detail:{elapsed:params.elapsed}});

    socket.eventListeners['Target.targetCreated'] = msg => {
      if (msg.targetInfo.type == 'page' && !this.attached) {
        socket.req(undefined, 'Target.attachToTarget', {targetId: msg.targetInfo.targetId, flatten: true});
        this.attached = true;
      }
    };

    const initializeTarget = async msg => {
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
      sess.targetId = msg.targetInfo.targetId;
      this.sessionActivate(msg.sessionId);

      let dims = this.rootElement.getBoundingClientRect();
      const initial=socket.initialViewport;
      const alreadyApplied=initial&&initial.w===Math.floor(dims.width)&&initial.h===Math.floor(dims.height)&&initial.dpr===window.devicePixelRatio;
      await sess.resize(dims.width, dims.height, window.devicePixelRatio,alreadyApplied);
      socket.initialViewport=null;

      sess.ws.req('Page.enable', {});
      // Proxy-only capability: SocketHandler strips binaryTiles before
      // forwarding this command to Chromium. Negotiated clients receive tile
      // payloads as binary WebSocket frames and Blob URLs instead of paying
      // Base64 expansion/decoding in JSON.
      const h264Tiles = await h264Supported;
      const vp9Tiles = h264Tiles && vp9Supported;
      const streamTiles = h264Tiles && vp9Tiles && typeof DecompressionStream === 'function' && localStorage.getItem('briskTileStream') !== '0' && sessionStorage.getItem('briskTileStreamRecovery') !== '1';
      socket.tileStreamNegotiated = streamTiles;
      sess.bootstrapPreview = streamTiles; // startupMode disables client upgrades on a capable proxy.
      sess.ws.req('PageStream.enable', {
        fastStartup:true, cachedPreview:!!globalThis.briskPreview,
        previewURL: startupURL,
        previewSeed: globalThis.briskPreview?.seed !== false && globalThis.briskPreview?.token,
        fps: 0, targetBandwidth: 999999999, binaryTiles: true, h264Tiles, vp9Tiles, tileDelta: true,
        streamTiles, patchAtlas: streamTiles, compactPreview: streamTiles, previewOnly: streamTiles,
        glyphDictionary: typeof DecompressionStream === 'function' ? 'curves-v1' : 'none',
        vectorTileCompression: typeof DecompressionStream === 'function' ? 'gzip' : 'none'
      });
      interactionTrace.record('navigate', {url: startupURL});
      const response = await sess.ws.req('Page.navigate', {url: startupURL});
      if (response.errorText && response.errorText !== 'net::ERR_ABORTED') this.showError('Could not load this page: ' + response.errorText);
    };

    socket.eventListeners['Target.attachedToTarget'] = msg => initializeTarget(msg).catch(error => {
      this.showError('Could not start this page: ' + (error.message || String(error)));
    });

    socket.eventListeners['Target.detachedFromTarget'] = msg => {
      if (!this.sessions[msg.sessionId]) return;   // duplicate/unmatched detach
      for (const session of Object.values(this.sessions)) session.forgetPreload(msg.sessionId);
      this.sessions[msg.sessionId].destroy();
      delete this.sessions[msg.sessionId];
      this.arrangeSessions();
    }

    socket.eventListeners['Target.targetInfoChanged'] = params => {
      // Same reasoning as the attachedToTarget guard above: a worker target's
      // info change is not the page's. Without this, a blob: worker's title
      // ("blob:https://www.w3.org/<uuid>") became the tab title.
      if (!params.targetInfo || params.targetInfo.type !== 'page') return;
      const active = this.sessions[this.activeSession];
      if (!active || params.targetInfo.targetId !== active.targetId) return;
      if (params.targetInfo.title) document.title = params.targetInfo.title;
      // Frame events on the active session own navigation history. Target
      // discovery also reports popups and can arrive after a later commit.
    };

    // Enabling discovery can synchronously produce targetCreated on a fast
    // local backend. Install every handshake listener first so the initial
    // page target cannot arrive in the gap and leave this client blank.
    socket.req(undefined, 'Target.setDiscoverTargets', {discover: true});


    var resize = () => {
      let dims = this.rootElement.getBoundingClientRect();
      Object.values(this.sessions).forEach(x => x.resize(dims.width, dims.height, window.devicePixelRatio));
    }
    window.addEventListener('resize', resize);
  }

  showError(message) {
    let panel = document.getElementById('brisk-load-error');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'brisk-load-error';
      panel.setAttribute('role', 'alert');
      Object.assign(panel.style, {position:'fixed', top:'0', left:'0', right:'0',
        zIndex:'2147483647', padding:'16px', background:'#fff', color:'#222', font:'16px sans-serif'});
      const text = document.createElement('span');
      const retry = document.createElement('button');
      retry.textContent = 'Reload';
      retry.style.marginLeft = '12px';
      retry.onclick = () => location.reload();
      panel.append(text, retry);
      document.body.append(panel);
    }
    panel.firstChild.textContent = message;
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
    if (!this.historyTraversal) this.historyIndex++;
    history[method]({briskURL: url, briskIndex: this.historyIndex}, '', this.frontendPathForURL(url));
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

  async activateMedia(sessionId) {
    if(typeof AudioDecoder !== 'function' || typeof VideoDecoder !== 'function')return;
    try {
      const {MediaPlayback}=await (this.mediaModule ||= import('/mediaPlayback.js'));
      if(this.activeSession!==sessionId || this.socket.readyState>1)return;
      if(!this.media)this.media=new MediaPlayback(this.socket,this.rootElement);
      this.media.activate(sessionId);
    } catch(error){console.warn('Media player unavailable:',error.message);}
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
    this.activateMedia(sessionId);
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
    sess.targetId = existingSession && existingSession.targetId;
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
