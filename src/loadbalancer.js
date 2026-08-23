import {devToolsWebsocket, devToolsSession} from './devtoolswebsocket.js'


// Implements a stochastic client-side loadbalancer
export function selectWebsocket(websocketServer, websocketPool) {
  return new Promise(function(resolve, reject) {
    let socketPool = [];
    if (websocketServer) {
      socketPool.push({id: 0, ws: new devToolsWebsocket(websocketServer)});
    } else if (websocketPool) {
      socketPool = socketPool.concat([...Array(10).keys()]
          .map(x => Math.floor(Math.random()*Math.pow(4,x)))
          .map(x => { return {id: x, ws: new devToolsWebsocket('wss://' + x + '.' + websocketPool)}})
        );
    } else {
      socketPool.push({id: 0, ws: new devToolsWebsocket(document.location.origin.replace('http', 'ws'))});
    }
    socketPool.doneCount = 0;
    socketPool.highestOpen = -1;

    function checkDone() {
      if (socketPool.resolved) return;
      if ((socketPool.doneCount/socketPool.length >= 0.9 && socketPool.highestOpen>=0)
          || socketPool.doneCount==socketPool.length ) {
        // Real bug, found by audit: x.load was used as a truthy check, but
        // 0 -- the BEST possible load value (a fully idle backend) -- is
        // falsy, so it silently got filtered OUT here. In the degenerate
        // (and good!) case where every candidate backend is idle, this
        // emptied goodSocketPool entirely despite every socket having
        // opened successfully, rejecting the whole selectWebsocket()
        // promise with `lasterr` (undefined, since nothing actually
        // errored) instead of picking any of the perfectly good open
        // connections. s.load is only ever set to a real number (1, or
        // Load.GetLoad's result) on a successful open -- a socket that
        // never opened never gets .load set at all -- so checking for
        // "is a number" (not "is truthy") is the correct filter.
        let goodSocketPool = socketPool.filter(x => typeof x.load === 'number');
        goodSocketPool.sort((a,b) => a.load - b.load);

        socketPool.resolved = true;
        // TODO:  Should skip first few here due to log sampling.
        var selected = (goodSocketPool.length!=0)?goodSocketPool[0].ws:null;
        if (selected) resolve(selected)
        else reject(socketPool.lasterr);
        socketPool.forEach(x => (x.ws!=selected) && x.ws.close());
      }
    }
    socketPool.forEach(s => {
      s.ws.onopen = async () => {
        try {
          s.load = socketPool.length==1?1:(await s.ws.req(undefined, 'Load.GetLoad', {}));
        } catch {
          s.load = 1;
        };
        socketPool.doneCount++;
        socketPool.highestOpen = Math.max(socketPool.highestOpen, s.id);
        checkDone();
      };
      s.ws.onerror = (err) => {socketPool.doneCount++; socketPool.lasterr=err; checkDone()};
    });
  });
}
