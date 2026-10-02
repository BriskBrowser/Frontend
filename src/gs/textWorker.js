// Worker entry: decodes TEXT packet bodies in the order they are posted.
// Messages in:  {op:'decode', id, bytes} | {op:'reset', id}
// Messages out: {id, runs} | {id, error}
import {TextDecoder2} from './text.js';
import {createTextHandler} from './textHost.js';

if (typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope) {
  const handle = createTextHandler(TextDecoder2);
  globalThis.onmessage = event => {
    const reply = handle(event.data);
    try { globalThis.postMessage(reply); }
    catch (error) { globalThis.postMessage({id: reply.id, error: 'runs are not cloneable: ' + error.message}); }
  };
}
