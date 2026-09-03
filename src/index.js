// ***************   Settings
// These values are used to allow this to either be hosted as a static file or replaced by a
// server-side script to eliminate a server round-trip.

let options = {
  // Websocket for server comms.  Method to select websocket:
  //  * If available, connect to websocketServer.
  //  * Otherwise, if available, connect to websocketPool.
  //  * Otherwise, connect to document.location.host

  //websocketServer: 'wss://server.example.com/',
  //websocketServer: 'ws://localhost:12159',

  // It's a dns based pool with a custom load balancing algorithm.
  // servers are expected to register at n.serverpool.com, where n is an integer from 0 to ~ the pool
  // size.  A few gaps doesn't matter.  If servers with low numbers get inundated with load-discovery-requests,
  // take them down (should only happen >10k servers).
  // The client will connect to 10 hosts logarithmicly spaced, 
  // and use whichever has the lowest published load scaled by response time.
  // briskbrowser.com is provided without any SLA.  Expect to be blocked if you apply too much load.
  //websocketPool: 'briskbrowser.com',

  // Don't display previews of future windows
  fullscreen: false,

  // Debug aid: outlines every clickable target region in translucent
  // red (green once its session is alive). Off by default -- it's a
  // developer visualization, not something end users should see painted
  // over every link on every page.
  showLinkOverlay: false,
}

typeof BBOptionsOverrides !== 'undefined' && Object.assign(options, BBOptionsOverrides)

import {Browser} from './browser.js?v=20260901-tilecache1'
    
window.addEventListener('DOMContentLoaded', async (event) => {
  let b = new Browser(document.querySelector('#browser'), options)

  // Real bugs, found by audit, fixed together: init() is async and does
  // real work that can reject (e.g. selectWebsocket() finding no reachable
  // pool server) -- this used to call it with neither await nor .catch(),
  // so a failure was a silent unhandled promise rejection: the user was
  // left staring at a permanently blank #browser div with zero visible
  // indication anything went wrong. Separately, index.html already SHIPPED
  // a "something's gone wrong" fallback message with no code anywhere that
  // ever showed or hid it -- a plain sibling of #browser, so on any
  // desktop-width viewport (see style.css's "Phone emulation for desktop
  // browsers" media query) it rendered permanently, on every successful
  // load too, not just on failure. Now hidden by default (index.html) and
  // shown here specifically when init() actually fails -- giving that
  // message the real, working, failure-only meaning its own text already
  // implied.
  b.init().catch(e => {
    console.error('Browser.init() failed:', e);
    const fallback = document.getElementById('error-fallback');
    if (fallback) fallback.style.display = '';
  });
});
