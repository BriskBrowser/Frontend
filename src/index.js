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
}

typeof BBOptionsOverrides !== 'undefined' && Object.assign(options, BBOptionsOverrides)

import {Browser} from './browser.js'
    
window.addEventListener('DOMContentLoaded', async (event) => {
  let b = new Browser(document.querySelector('#browser'), options)

  b.init();
});