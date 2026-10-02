// Runs the text decoder off the main thread. TEXT packets must be decoded in
// arrival order (the text model is stream-global and append-only); a Worker
// processes messages in order, and without Workers the same decoder runs on
// the main thread behind a promise chain.
//
// If the worker cannot start at all (module worker blocked, script failed to
// load) before it answered anything, the queued work is replayed on the main
// thread, which is still in the initial decoder state, so nothing is lost.

// Message handler shared by the real worker (textWorker.js) and the tests.
export function createTextHandler(DecoderClass) {
  let decoder = null;
  return message => {
    const {op, id} = message;
    try {
      decoder ||= new DecoderClass();
      if (op === 'reset') { decoder.reset(); return {id, runs: null}; }
      if (op === 'decode') return {id, runs: decoder.decodeBand(message.bytes)};
      return {id, error: 'unknown text worker op ' + op};
    } catch (error) {
      return {id, error: String(error && error.message || error)};
    }
  };
}

function defaultCreateWorker() {
  if (typeof Worker !== 'function') return null;
  return new Worker(new URL('./textWorker.js', import.meta.url), {type: 'module'});
}
const defaultLoadDecoder = () => import('./text.js').then(m => m.TextDecoder2);

export class TextHost {
  constructor({createWorker = defaultCreateWorker, loadDecoder = defaultLoadDecoder} = {}) {
    this.createWorker = createWorker;
    this.loadDecoder = loadDecoder;
    this.worker = null;
    this.mode = null;                 // 'worker' | 'main'
    this.nextId = 1;
    this.pending = new Map();         // id -> {message, resolve, reject}, in submission order
    this.answered = 0;
    this.chain = Promise.resolve();   // main-thread mode ordering
    this.handler = null;
    this.closed = false;
  }

  start() {
    if (this.mode) return;
    try {
      this.worker = this.createWorker();
    } catch (_) { this.worker = null; }
    if (!this.worker) { this.mode = 'main'; return; }
    this.mode = 'worker';
    this.worker.onmessage = event => this.answer(event.data);
    this.worker.onerror = event => {
      event.preventDefault?.();
      if (this.answered === 0 && !this.closed) this.fallBack();
      else this.fail(new Error('text worker failed: ' + (event && event.message || 'error')));
    };
  }

  answer(reply) {
    const entry = this.pending.get(reply.id);
    if (!entry) return;
    this.pending.delete(reply.id);
    this.answered++;
    if (reply.error !== undefined) entry.reject(new Error('text decode: ' + reply.error));
    else entry.resolve(reply.runs);
  }

  fail(error) {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) entry.reject(error);
  }

  fallBack() {
    this.worker?.terminate?.();
    this.worker = null;
    this.mode = 'main';
    for (const entry of this.pending.values()) this.runMain(entry.message).then(entry.resolve, entry.reject);
    // answer() must not see these again.
    this.pending.clear();
  }

  runMain(message) {
    const run = async () => {
      if (!this.handler) this.handler = createTextHandler(await this.loadDecoder());
      const reply = this.handler(message);
      if (reply.error !== undefined) throw new Error('text decode: ' + reply.error);
      return reply.runs;
    };
    const result = this.chain.then(run);
    this.chain = result.then(() => {}, () => {});
    return result;
  }

  post(message) {
    if (this.closed) return Promise.reject(new Error('text host closed'));
    this.start();
    message.id = this.nextId++;
    if (this.mode === 'main') return this.runMain(message);
    return new Promise((resolve, reject) => {
      this.pending.set(message.id, {message, resolve, reject});
      try { this.worker.postMessage(message); }
      catch (error) { this.pending.delete(message.id); reject(error); }
    });
  }

  // Resolves to the runs of one band (positions in layer css px).
  decode(bytes) {
    // The packet buffer belongs to the websocket message; copy it for the worker.
    return this.post({op: 'decode', bytes: bytes.slice()});
  }

  // LIBRARY_RESET: drop the text model. Ordered with the decodes around it.
  reset() {
    this.post({op: 'reset'}).catch(() => {});
  }

  close() {
    this.closed = true;
    this.worker?.terminate?.();
    this.worker = null;
    this.fail(new Error('text host closed'));
  }
}
