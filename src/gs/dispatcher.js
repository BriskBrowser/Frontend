// Parses stream packets (docs/gpu-stream-wire.md section 2) and applies them,
// strictly in arrival order, to the held surfaces and the shared decoders.
//
// handle(bytes) returns undefined when the packet was applied synchronously
// and a Promise when it needs async work (photo decode, the text barrier at
// FRAME_END). The websocket receive loop awaits that Promise before it hands
// over the next message, and handle() itself chains onto unfinished work when
// called anyway, so applying can never be reordered by an async decoder.
//
// Everything a packet claims is validated before anything is mutated; a bad
// packet throws StreamError and leaves surfaces and decoder state untouched
// (decoder-internal failures are the decoders' own to report).
import {Surface, TILE, surfaceKey, MAX_DIMENSION, MAX_PIXELS} from './surface.js';

export const MAGIC = 0xB7;
export const KIND = {PIXELS: 1, TEXT: 2, CONTROL: 3};
export const CODEC = {FLAT: 1, REF: 16};
export const CTL = {HELLO: 1, LAYER: 2, FRAME_END: 3, DROP: 4, LIBRARY_RESET: 5, SOURCE_END: 6};
export const FLAG_RESET_RECT = 1;
const MAX_SECTIONS = 64;
const MAX_REFS = 1 << 16;

export class StreamError extends Error {
  constructor(message) { super('PageStream: ' + message); this.name = 'StreamError'; }
}

class Reader {
  constructor(bytes, at = 0) {
    this.b = bytes; this.at = at;
    this.v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  need(n) { if (n < 0 || this.at + n > this.b.length) throw new StreamError('truncated packet'); }
  u8() { this.need(1); return this.b[this.at++]; }
  u16() { this.need(2); const x = this.v.getUint16(this.at, true); this.at += 2; return x; }
  u32() { this.need(4); const x = this.v.getUint32(this.at, true); this.at += 4; return x; }
  i32() { this.need(4); const x = this.v.getInt32(this.at, true); this.at += 4; return x; }
  f32() { this.need(4); const x = this.v.getFloat32(this.at, true); this.at += 4; return x; }
  varint() {
    let x = 0, scale = 1;
    for (let i = 0; i < 5; i++) {
      const byte = this.u8();
      x += (byte & 0x7f) * scale;
      if (!(byte & 0x80)) return x;
      scale *= 128;
    }
    throw new StreamError('bad varint');
  }
  take(n) { this.need(n); const out = this.b.subarray(this.at, this.at + n); this.at += n; return out; }
  rest() { return this.b.subarray(this.at); }
  get left() { return this.b.length - this.at; }
}

class LayerState {
  constructor(surface, generation) {
    this.surface = surface;
    this.generation = generation;
    this.info = null;
    this.bands = new Map();   // band -> newest text version applied
  }
}

// decoders: {flat, photo, text}; each is the decoder object or a function that
//   builds it on first use. flat: apply(surface, surfaces, rect, bytes)->{photoTiles};
//   photo: async apply(surface, rect, bytes, codec); text: decode(bytes)->Run[]|Promise<Run[]>;
//   all: reset().
// sink (all optional): hello(info) layerChanged(source, layer, info, surface)
//   layerRemoved(source, layer) sourceRemoved(source) dirty(source, layer, rect)
//   runs(source, layer, band, runs, version) frameEnd(source, seq) drop(source, layer)
//   libraryReset()
export class StreamDispatcher {
  constructor({decoders = {}, sink = {}} = {}) {
    this.decoders = decoders;
    this.sink = sink;
    this.sources = new Map();     // source -> Map(layer -> LayerState)
    this.surfaces = new Map();    // surfaceKey -> Surface, for reference modes
    this.tail = null;             // promise of the packet currently applying
    this.textPending = new Set(); // text decodes whose runs are not applied yet
    this.textError = null;
    this.closed = false;
    this.stats = {pixels: 0, text: 0, control: 0, ignored: 0, resets: 0};
  }

  decoder(name) {
    let d = this.decoders[name];
    if (typeof d === 'function') d = this.decoders[name] = d();
    if (!d) throw new StreamError('no ' + name + ' decoder');
    return d;
  }
  layerState(source, layer) { return this.sources.get(source)?.get(layer); }
  surface(source, layer) { return this.layerState(source, layer)?.surface; }

  handle(bytes) {
    if (this.closed) return undefined;
    if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
    const result = this.tail ? this.tail.then(() => this.process(bytes)) : this.process(bytes);
    if (result && typeof result.then === 'function') {
      const mine = result.then(() => {}, () => {}).then(() => { if (this.tail === mine) this.tail = null; });
      this.tail = mine;
      return result;
    }
    return undefined;
  }

  process(bytes) {
    if (bytes.length < 4 || bytes[0] !== MAGIC) throw new StreamError('bad packet magic');
    const r = new Reader(bytes, 1);
    const kind = r.u8(), source = r.u16();
    if (kind === KIND.PIXELS) return this.pixels(source, r);
    if (kind === KIND.TEXT) return this.text(source, r);
    if (kind === KIND.CONTROL) return this.control(source, r);
    throw new StreamError('unknown packet kind ' + kind);
  }

  // ---- PIXELS -------------------------------------------------------------
  pixels(source, r) {
    const layer = r.u32(), generation = r.u32(), x = r.i32(), y = r.i32();
    const w = r.u16(), h = r.u16();
    r.u8();                                   // quality: only final (0) is sent so far
    const flags = r.u8();
    const count = r.varint();
    if (!w || !h) throw new StreamError('empty patch rect');
    if (count > MAX_SECTIONS) throw new StreamError('too many sections');
    const sections = [];
    for (let i = 0; i < count; i++) {
      const codec = r.u8(), len = r.varint();
      const section = {codec, body: r.take(len), refs: null};
      if (codec === CODEC.REF) section.refs = this.parseRefs(section.body);
      else if (codec !== CODEC.FLAT && !(codec >= 2 && codec <= 15)) throw new StreamError('unknown codec ' + codec);
      sections.push(section);
    }
    if (r.left) throw new StreamError('trailing bytes in pixel packet');
    this.stats.pixels++;

    const state = this.layerState(source, layer);
    let ignore = !state || generation < state.generation;
    if (!ignore) {
      const s = state.surface;
      if (x < 0 || y < 0 || x + w > s.w || y + h > s.h) throw new StreamError('patch outside layer');
      ignore = this.allTilesNewer(s, x, y, w, h, generation);
    }
    // A stale or orphaned patch still runs through the decoders, on a scratch
    // surface: library tiles and photo ids are stream-global and append-only,
    // so skipping a section would desynchronise every later one.
    if (ignore) this.stats.ignored++;
    const surface = ignore ? new Surface(w, h) : state.surface;
    const rect = ignore ? {x: 0, y: 0, w, h} : {x, y, w, h};
    if (flags & FLAG_RESET_RECT) surface.clearRect(rect.x, rect.y, rect.w, rect.h);
    const done = () => {
      if (ignore) return;
      this.markGeneration(surface, rect, generation);
      this.sink.dirty?.(source, layer, rect);
    };
    let i = 0;
    const step = () => {
      while (i < sections.length) {
        const s = sections[i++];
        if (s.codec === CODEC.FLAT) this.decoder('flat').apply(surface, this.surfaces, rect, s.body);
        else if (s.codec === CODEC.REF) this.applyRefs(surface, rect, s.refs);
        else {
          const p = this.decoder('photo').apply(surface, rect, s.body, s.codec);
          if (p && typeof p.then === 'function') return p.then(step);
        }
      }
      done();
      return undefined;
    };
    return step();
  }

  allTilesNewer(s, x, y, w, h, generation) {
    const tx0 = Math.floor(x / TILE), tx1 = Math.ceil((x + w) / TILE);
    const ty0 = Math.floor(y / TILE), ty1 = Math.ceil((y + h) / TILE);
    for (let ty = ty0; ty < ty1; ty++) for (let tx = tx0; tx < tx1; tx++)
      if (s.tileGen[ty * s.tilesX + tx] <= generation) return false;
    return true;
  }

  markGeneration(s, rect, generation) {
    const tx0 = Math.floor(rect.x / TILE), tx1 = Math.ceil((rect.x + rect.w) / TILE);
    const ty0 = Math.floor(rect.y / TILE), ty1 = Math.ceil((rect.y + rect.h) / TILE);
    for (let ty = ty0; ty < ty1; ty++) for (let tx = tx0; tx < tx1; tx++) {
      const i = ty * s.tilesX + tx;
      if (s.tileGen[i] < generation) s.tileGen[i] = generation;
    }
  }

  parseRefs(body) {
    const r = new Reader(body);
    const n = r.varint();
    if (n > MAX_REFS || r.left !== n * 20) throw new StreamError('bad REF section');
    const refs = [];
    for (let i = 0; i < n; i++)
      refs.push({tx: r.u16(), ty: r.u16(), tw: r.u16(), th: r.u16(), srcSource: r.u16(), srcLayer: r.u32(), stx: r.u16(), sty: r.u16()});
    return refs;
  }

  applyRefs(surface, rect, refs) {
    for (const ref of refs) {
      const src = this.surfaces.get(surfaceKey(ref.srcSource, ref.srcLayer));
      if (!src) throw new StreamError('REF names a surface that is not held');
      const dx = rect.x + ref.tx * TILE, dy = rect.y + ref.ty * TILE;
      const sx = ref.stx * TILE, sy = ref.sty * TILE;
      const w = Math.min(ref.tw * TILE, rect.x + rect.w - dx, src.w - sx, surface.w - dx);
      const h = Math.min(ref.th * TILE, rect.y + rect.h - dy, src.h - sy, surface.h - dy);
      if (w <= 0 || h <= 0) throw new StreamError('REF rect outside surfaces');
      surface.copyBlock(src, sx, sy, dx, dy, w, h);
    }
  }

  // ---- TEXT ---------------------------------------------------------------
  text(source, r) {
    const layer = r.u32(), generation = r.u32(), band = r.u32(), version = r.u32();
    const body = r.rest();
    this.stats.text++;
    // Decoded even when the result is thrown away: the text model is stream state.
    const decode = body.length ? this.decoder('text').decode(body) : [];
    const apply = runs => {
      const state = this.layerState(source, layer);
      if (!state || generation < state.generation) return;
      const held = state.bands.get(band);
      if (held !== undefined && version < held) return;
      state.bands.set(band, version);
      this.sink.runs?.(source, layer, band, runs, version);
    };
    if (!decode || typeof decode.then !== 'function') { apply(decode); return undefined; }
    // Worker results come back in submission order; the packet itself does not
    // wait (pixels and text are independent surfaces) but FRAME_END does.
    const p = decode.then(runs => { apply(runs); }, error => {
      this.textError = this.textError || error;
    }).then(() => { this.textPending.delete(p); });
    this.textPending.add(p);
    return undefined;
  }

  // Resolves once every text decode started so far has been applied (or has failed).
  async textBarrier() {
    while (this.textPending.size) await Promise.all([...this.textPending]);
    if (this.textError) { const e = this.textError; this.textError = null; throw e; }
  }

  // ---- CONTROL ------------------------------------------------------------
  control(source, r) {
    this.stats.control++;
    const sub = r.u8();
    switch (sub) {
      case CTL.HELLO: {
        const stream = r.u32(), flat = r.u8(), text = r.u8(), n = r.u8();
        const photo = Array.from(r.take(n));
        if (flat !== 1 || text !== 1) throw new StreamError('unsupported codec versions ' + flat + '/' + text);
        this.sink.hello?.({stream, flat, text, photo});
        return undefined;
      }
      case CTL.LAYER: return this.layerControl(source, r);
      case CTL.FRAME_END: {
        const seq = r.u32();
        if (!this.textPending.size && !this.textError) { this.sink.frameEnd?.(source, seq); return undefined; }
        return this.textBarrier().then(() => this.sink.frameEnd?.(source, seq));
      }
      case CTL.DROP: {
        const layer = r.u32();
        // The service discards its own queue; the client keeps what it holds.
        this.sink.drop?.(source, layer);
        return undefined;
      }
      case CTL.LIBRARY_RESET: {
        this.stats.resets++;
        for (const name of ['flat', 'photo', 'text']) if (this.decoders[name]) this.decoder(name).reset?.();
        this.sink.libraryReset?.();
        return undefined;
      }
      case CTL.SOURCE_END: {
        this.removeSource(source);
        return undefined;
      }
      default: throw new StreamError('unknown control subtype ' + sub);
    }
  }

  layerControl(source, r) {
    const layer = r.u32(), generation = r.u32(), w = r.u32(), h = r.u32();
    const cssScale = r.f32(), cssX = r.i32(), cssY = r.i32();
    if (r.left) throw new StreamError('trailing bytes in LAYER');
    if (w === 0 && h === 0) { this.removeLayer(source, layer); return undefined; }
    if (!w || !h || w > MAX_DIMENSION || h > (1 << 24) || w * h > MAX_PIXELS) throw new StreamError('bad layer size ' + w + 'x' + h);
    if (!(cssScale > 0) || !Number.isFinite(cssScale)) throw new StreamError('bad layer scale');
    let layers = this.sources.get(source);
    const old = layers?.get(layer);
    if (old && generation < old.generation) return undefined;
    if (!layers) this.sources.set(source, layers = new Map());
    let state = old;
    if (!old || old.surface.w !== w || old.surface.h !== h) {
      const surface = new Surface(w, h);
      surface.key = surfaceKey(source, layer);
      if (old) surface.copyFrom(old.surface);
      state = old || new LayerState(surface, generation);
      state.surface = surface;
      layers.set(layer, state);
      this.surfaces.set(surface.key, surface);
    }
    state.generation = generation;
    state.info = {generation, w, h, cssScale, cssX, cssY};
    this.sink.layerChanged?.(source, layer, state.info, state.surface);
    return undefined;
  }

  removeLayer(source, layer) {
    const layers = this.sources.get(source);
    const state = layers?.get(layer);
    if (!state) return;
    layers.delete(layer);
    this.surfaces.delete(state.surface.key);
    if (!layers.size) this.sources.delete(source);
    this.sink.layerRemoved?.(source, layer);
  }

  removeSource(source) {
    const layers = this.sources.get(source);
    if (layers) for (const [layer, state] of layers) {
      this.surfaces.delete(state.surface.key);
      this.sink.layerRemoved?.(source, layer);
    }
    this.sources.delete(source);
    this.sink.sourceRemoved?.(source);
  }

  close() {
    this.closed = true;
    this.sources.clear(); this.surfaces.clear();
    this.tail = null;
  }
}
