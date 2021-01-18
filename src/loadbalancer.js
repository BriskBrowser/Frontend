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
        let goodSocketPool = socketPool.filter(x => x.load);
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
