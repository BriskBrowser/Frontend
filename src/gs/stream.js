// The client side of one stream (one websocket): packet dispatcher, the shared
// decoders, the text worker host and the compositor, wired together.
//
//   websocket binary message (first byte 0xB7)
//     -> GsStream.handle -> StreamDispatcher (ordered apply)
//          FLAT/REF/PHOTO sections write the layer's Surface -> Compositor.dirty
//          TEXT -> TextHost (worker) -> runs -> Compositor.runs
//          CONTROL LAYER/DROP/RESET/SOURCE_END -> surfaces, decoders, compositor
//     -> Compositor paints dirty rects on the next animation frame
import {StreamDispatcher} from './dispatcher.js';
import {Compositor} from './compositor.js';
import {TextHost} from './textHost.js';

export class GsStream {
  // modules: injectable loader for tests, () => Promise<{FlatDecoder, PhotoDecoder, drawRuns}>
  constructor({compositor, textHost, loadModules} = {}) {
    this.compositor = compositor || new Compositor();
    this.textHost = textHost || new TextHost();
    this.hello = null;
    this.onFrameEnd = null;       // (source, seq) after every packet of that frame was applied
    this.flat = null;
    this.photo = null;
    this.dispatcher = new StreamDispatcher({
      decoders: {flat: () => this.flat, photo: () => this.photo, text: this.textHost},
      sink: {
        hello: info => { this.hello = info; },
        layerChanged: (s, l, info, surface) => this.compositor.layerChanged(s, l, info, surface),
        layerRemoved: (s, l) => this.compositor.layerRemoved(s, l),
        sourceRemoved: s => this.compositor.sourceRemoved(s),
        dirty: (s, l, rect) => this.compositor.dirty(s, l, rect),
        runs: (s, l, band, runs) => this.compositor.runs(s, l, band, runs),
        frameEnd: (s, seq) => this.onFrameEnd?.(s, seq),
      },
    });
    this.loaded = false;
    this.ready = (loadModules || defaultLoadModules)().then(m => {
      this.flat = new m.FlatDecoder();
      this.photo = new m.PhotoDecoder();
      if (m.drawRuns) this.compositor.setDrawRuns(m.drawRuns);
      this.loaded = true;
    });
    this.ready.catch(() => {});
  }

  // Apply one packet. Returns a Promise when the receive loop must wait.
  handle(bytes) {
    if (!this.loaded) return this.ready.then(() => this.dispatcher.handle(bytes));
    return this.dispatcher.handle(bytes);
  }

  close() {
    this.dispatcher.close();
    this.textHost.close();
    this.compositor.close();
    this.flat?.close?.();
    this.photo?.close?.();
  }
}

// The decoders load with the connection, not the first packet, so the first
// packets do not wait a round trip for them.
async function defaultLoadModules() {
  const [flat, photo, text] = await Promise.all([import('./flat.js'), import('./photo.js'), import('./text.js')]);
  return {FlatDecoder: flat.FlatDecoder, PhotoDecoder: photo.PhotoDecoder, drawRuns: text.drawRuns};
}
