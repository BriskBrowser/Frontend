// PHOTO sections (codec ids 2..15): photo dictionary + atlas decode + blit into a Surface.
// Normative bit-level description: docs/gpu-stream-photo.md (service side: brisk_gpu/photo/photo_stream.cc).
//
//   const dec = new PhotoDecoder();
//   await dec.apply(surface, {x, y, w, h}, sectionBody, codecId);   // one PIXELS section
//
// Section body: varint head (n_rects << 1 | reset) | n x {u16 tx,ty,tw,th} | n x varint entry (0 = new photo, else held
// id + 1) | varint n_atlas | n_atlas x {varint w, varint h} | n_new x {varint atlas, varint x/8, varint y/8} |
// n_atlas x {varint len, bytes}. Photos are tw*16 x th*16 px, opaque.
//
// A codec is a class registered in `photoDecoders` (codec id -> class) with
//   async decodeAtlas(w, h, bytes) -> Uint8ClampedArray|Uint8Array RGBA w*h*4 (opaque),  close()
// Everything in this file except Av1AtlasDecoder's browser calls runs in Node (tests use the raw codec).

export const TILE = 16;
export const GUTTER = 8;                       // atlas position unit
export const DICT_MAX_PIXELS = 16 * 1024 * 1024;   // = kDictMaxPixels in photo_wire.h (padded px of all held photos)
export const DICT_MAX_ENTRIES = 4096;              // = kDictMaxEntries
export const MAX_RECTS = 4096;
export const MAX_ATLAS_DIM = 8192;
export const MAX_ATLAS_PIXELS = 8912896;
export const CODEC_AV1 = 2;
export const CODEC_RAW = 3;

export class PhotoError extends Error {
  constructor(message) { super('photo: ' + message); this.name = 'PhotoError'; }
}

// ---------------------------------------------------------------- parsing (pure)

class Cursor {
  constructor(bytes) { this.b = bytes; this.i = 0; }
  get left() { return this.b.length - this.i; }
  varint() {
    let v = 0, mul = 1;
    for (let n = 0; n < 8; n++) {
      if (this.i >= this.b.length) throw new PhotoError('truncated varint');
      const x = this.b[this.i++];
      v += (x & 0x7f) * mul;
      if (!(x & 0x80)) return v;
      mul *= 128;
    }
    throw new PhotoError('varint too long');
  }
  u16() {
    if (this.left < 2) throw new PhotoError('truncated');
    const v = this.b[this.i] | (this.b[this.i + 1] << 8);
    this.i += 2;
    return v;
  }
  take(n) {
    if (n > this.left) throw new PhotoError('truncated payload');
    const s = this.b.subarray(this.i, this.i + n);
    this.i += n;
    return s;
  }
}

// -> {reset, rects:[{tx,ty,tw,th, held: id|-1}], atlases:[{w,h,payload}], pos:[{atlas,x,y}] (one per new rect, in order)}
export function parseSection(bytes) {
  const c = new Cursor(bytes);
  const head = c.varint();
  const reset = head % 2 === 1, n = Math.floor(head / 2);
  if (n > MAX_RECTS) throw new PhotoError('too many rects');
  if (c.left < n * 9) throw new PhotoError('truncated rect table');   // 8 B rect + >= 1 B entry each
  const rects = [];
  for (let i = 0; i < n; i++) {
    const tx = c.u16(), ty = c.u16(), tw = c.u16(), th = c.u16();
    if (tw === 0 || th === 0 || tw * TILE > MAX_ATLAS_DIM || th * TILE > MAX_ATLAS_DIM) throw new PhotoError('bad rect size');
    rects.push({tx, ty, tw, th, held: -1});
  }
  let nNew = 0;
  for (const r of rects) {
    const e = c.varint();
    if (e === 0) nNew++; else r.held = e - 1;
  }
  const nAtlas = c.varint();
  if (nAtlas > nNew || (nNew > 0 && nAtlas === 0)) throw new PhotoError('bad atlas count');
  const atlases = [];
  for (let i = 0; i < nAtlas; i++) {
    const w = c.varint(), h = c.varint();
    if (w <= 0 || h <= 0 || w > MAX_ATLAS_DIM || h > MAX_ATLAS_DIM || w * h > MAX_ATLAS_PIXELS) throw new PhotoError('bad atlas size');
    atlases.push({w, h, payload: null});
  }
  const pos = [];
  for (let i = 0; i < nNew; i++) {
    const atlas = c.varint(), x = c.varint() * GUTTER, y = c.varint() * GUTTER;
    if (atlas >= nAtlas) throw new PhotoError('bad atlas index');
    pos.push({atlas, x, y});
  }
  for (const a of atlases) a.payload = c.take(c.varint());
  if (c.left !== 0) throw new PhotoError('trailing bytes');
  // positions must lie inside their atlas
  let k = 0;
  for (const r of rects) {
    if (r.held >= 0) continue;
    const p = pos[k++], a = atlases[p.atlas];
    if (p.x + r.tw * TILE > a.w || p.y + r.th * TILE > a.h) throw new PhotoError('photo outside atlas');
  }
  return {reset, rects, atlases, pos};
}

// ---------------------------------------------------------------- dictionary (mirrors PhotoStream)

// id -> {rgba, w, h, px}. Map iteration order is recency order (oldest first): get() with touch moves to the end.
export class PhotoDictionary {
  constructor(maxPixels = DICT_MAX_PIXELS, maxEntries = DICT_MAX_ENTRIES) {
    this.maxPixels = maxPixels; this.maxEntries = maxEntries;
    this.reset();
  }
  reset() { this.map = new Map(); this.pixels = 0; this.nextId = 0; }
  get size() { return this.map.size; }
  has(id) { return this.map.has(id); }
  touch(id) {
    const e = this.map.get(id);
    if (!e) return null;
    this.map.delete(id); this.map.set(id, e);
    return e;
  }
  add(rgba, w, h) {
    const id = this.nextId++;
    this.map.set(id, {rgba, w, h, px: w * h});
    this.pixels += w * h;
    return id;
  }
  evict() {
    for (const [id, e] of this.map) {
      if (this.pixels <= this.maxPixels && this.map.size <= this.maxEntries) break;
      this.map.delete(id); this.pixels -= e.px;
    }
  }
}

// ---------------------------------------------------------------- blit (replaceable)

// Copy photo `p` ({rgba,w,h}, tightly packed) to the surface at tile offset (tx,ty) of the patch `rect`, clipped to the
// patch rect and the surface. Photos are opaque and replace what is there. Frontend glue may swap this function
// (e.g. to also update per-tile maps): PhotoDecoder calls `this.blit`.
export function blitPhoto(surface, rect, tx, ty, p) {
  const x0 = rect.x + tx * TILE, y0 = rect.y + ty * TILE;
  const cx0 = Math.max(x0, rect.x, 0), cy0 = Math.max(y0, rect.y, 0);
  const cx1 = Math.min(x0 + p.w, rect.x + rect.w, surface.w), cy1 = Math.min(y0 + p.h, rect.y + rect.h, surface.h);
  if (cx1 <= cx0 || cy1 <= cy0) return;
  const bytes = (cx1 - cx0) * 4;
  for (let y = cy0; y < cy1; y++) {
    const s = ((y - y0) * p.w + (cx0 - x0)) * 4;
    surface.rgba.set(p.rgba.subarray(s, s + bytes), (y * surface.w + cx0) * 4);
  }
}

// ---------------------------------------------------------------- decoder

export const photoDecoders = new Map();   // codec id -> class (constructed with no arguments)

export class PhotoDecoder {
  constructor({maxPixels = DICT_MAX_PIXELS, maxEntries = DICT_MAX_ENTRIES, blit = blitPhoto, codecs} = {}) {
    this.dict = new PhotoDictionary(maxPixels, maxEntries);
    this.blit = blit;
    this.registry = codecs || photoDecoders;
    this.codecs = new Map();     // codec id -> instance
    this.chain = Promise.resolve();
    this.stats = {sections: 0, newPhotos: 0, heldPhotos: 0, errors: 0};
  }

  // Applies one PHOTO section. Sections are serialized internally (the dictionary is order dependent) so a caller may
  // fire them without awaiting. A malformed or undecodable section rejects and leaves the dictionary and the surface
  // untouched; later sections keep working (the service resyncs through the reset flag after its own failures).
  // `codec` is the section's codec byte; if omitted, bytes[0] is taken as the codec byte and the rest as the body.
  apply(surface, rect, bytes, codec) {
    if (codec === undefined) { codec = bytes[0]; bytes = bytes.subarray(1); }
    const run = this.chain.then(() => this._apply(surface, rect, bytes, codec));
    this.chain = run.catch(() => {});
    return run;
  }

  async _apply(surface, rect, bytes, codec) {
    try {
      const sec = parseSection(bytes);
      this._validate(sec, rect);
      const atlases = [];
      if (sec.atlases.length) {
        const dec = this._codec(codec);
        for (const a of sec.atlases) {
          const rgba = await dec.decodeAtlas(a.w, a.h, a.payload);
          if (!rgba || rgba.length !== a.w * a.h * 4) throw new PhotoError('atlas decode size mismatch');
          atlases.push(rgba);
        }
      }
      this._commit(surface, rect, sec, atlases);
      this.stats.sections++;
    } catch (e) {
      this.stats.errors++;
      throw e instanceof PhotoError ? e : Object.assign(new PhotoError(String(e && e.message || e)), {cause: e});
    }
  }

  _validate(sec, rect) {
    // held ids must exist (or be assigned earlier in this very section); rects must lie inside the patch
    let next = sec.reset ? 0 : this.dict.nextId;
    const present = id => (sec.reset ? false : this.dict.has(id));
    const fresh = new Set();
    const tilesX = Math.ceil(rect.w / TILE), tilesY = Math.ceil(rect.h / TILE);
    for (const r of sec.rects) {
      if (r.tx >= tilesX || r.ty >= tilesY) throw new PhotoError('rect outside patch');
      if (r.held < 0) fresh.add(next++);
      else if (!present(r.held) && !fresh.has(r.held)) throw new PhotoError('unknown photo id ' + r.held);
    }
  }

  _commit(surface, rect, sec, atlases) {
    const dict = this.dict;
    if (sec.reset) dict.reset();
    let k = 0;
    for (const r of sec.rects) {
      let p;
      if (r.held >= 0) {
        p = dict.touch(r.held);
        this.stats.heldPhotos++;
      } else {
        const pos = sec.pos[k++], a = atlases[pos.atlas], aw = sec.atlases[pos.atlas].w;
        const w = r.tw * TILE, h = r.th * TILE, rgba = new Uint8ClampedArray(w * h * 4);
        for (let y = 0; y < h; y++) {
          const s = ((pos.y + y) * aw + pos.x) * 4;
          rgba.set(a.subarray(s, s + w * 4), y * w * 4);
        }
        const id = dict.add(rgba, w, h);
        p = dict.map.get(id);
        this.stats.newPhotos++;
      }
      this.blit(surface, rect, r.tx, r.ty, p);
    }
    dict.evict();
  }

  _codec(id) {
    let c = this.codecs.get(id);
    if (!c) {
      const Cls = this.registry.get(id);
      if (!Cls) throw new PhotoError('unsupported photo codec ' + id);
      c = new Cls();
      this.codecs.set(id, c);
    }
    return c;
  }

  // LIBRARY_RESET: forget every held photo.
  reset() { this.dict.reset(); }

  close() {
    for (const c of this.codecs.values()) c.close?.();
    this.codecs.clear();
    this.dict.reset();
  }
}

// ---------------------------------------------------------------- codec 3: raw RGB

export class RawAtlasDecoder {
  async decodeAtlas(w, h, bytes) {
    if (bytes.length !== w * h * 3) throw new PhotoError('raw atlas length');
    const out = new Uint8ClampedArray(w * h * 4);
    for (let i = 0, j = 0, n = w * h; i < n; i++, j += 3) {
      out[i * 4] = bytes[j]; out[i * 4 + 1] = bytes[j + 1]; out[i * 4 + 2] = bytes[j + 2]; out[i * 4 + 3] = 255;
    }
    return out;
  }
  close() {}
}
photoDecoders.set(CODEC_RAW, RawAtlasDecoder);

// ---------------------------------------------------------------- codec 2: AV1 4:4:4

// AV1 level for a w x h picture (seq_level_idx; only used to build the WebCodecs codec string / av1C). 13 = level 5.1
// (8,912,896 px, 16384 wide), 17 = 6.1 would allow more, but atlases never exceed MAX_ATLAS_PIXELS.
const AV1_LEVEL = 13;
export function av1CodecString() { return 'av01.1.' + String(AV1_LEVEL).padStart(2, '0') + 'M.08.0.000'; }

// The service emits temporal units "TD | sequence header | frame". WebCodecs takes them as they are.
// For createImageBitmap the units are wrapped in a minimal AVIF (no TD in the item). All boxes below are the ISOBMFF/HEIF
// minimum a browser AVIF decoder accepts for one 8-bit 4:4:4 image with BT.709/sRGB/full-range colr.
export function wrapAvif(obu, w, h) {
  const u32 = v => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
  const u16 = v => [(v >> 8) & 255, v & 255];
  const str = s => Array.from(s, ch => ch.charCodeAt(0));
  const box = (type, ...parts) => {
    const body = parts.flat();
    return [...u32(8 + body.length), ...str(type), ...body];
  };
  const full = (type, version, flags, ...parts) => box(type, version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255, ...parts);
  let data = obu;
  if (data.length >= 2 && data[0] === 0x12 && data[1] === 0x00) data = data.subarray(2);   // drop the temporal delimiter
  const ftyp = box('ftyp', str('avif'), u32(0), str('avif'), str('mif1'), str('miaf'));
  const hdlr = full('hdlr', 0, 0, u32(0), str('pict'), u32(0), u32(0), u32(0), [0]);
  const pitm = full('pitm', 0, 0, u16(1));
  const infe = full('infe', 2, 0, u16(1), u16(0), str('av01'), [0]);
  const iinf = full('iinf', 0, 0, u16(1), infe);
  const ispe = full('ispe', 0, 0, u32(w), u32(h));
  const pixi = full('pixi', 0, 0, [3, 8, 8, 8]);
  const av1C = box('av1C', [0x81, (1 << 5) | AV1_LEVEL, 0x00, 0x00]);
  const colr = box('colr', str('nclx'), u16(1), u16(13), u16(1), [0x80]);
  const ipco = box('ipco', ispe, pixi, av1C, colr);
  const ipma = full('ipma', 0, 0, u32(1), u16(1), [4, 1, 2, 0x80 | 3, 4]);
  const iprp = box('iprp', ipco, ipma);
  const ilocFor = off => full('iloc', 0, 0, [0x44, 0x00], u16(1), u16(1), u16(0), u16(1), u32(off), u32(data.length));
  const metaFor = off => full('meta', 0, 0, hdlr, pitm, ilocFor(off), iinf, iprp);
  const metaLen = metaFor(0).length;
  const mdatOffset = ftyp.length + metaLen + 8;
  const head = new Uint8Array([...ftyp, ...metaFor(mdatOffset), ...u32(8 + data.length), ...str('mdat')]);
  const out = new Uint8Array(head.length + data.length);
  out.set(head); out.set(data, head.length);
  return out;
}

// RGBA from a VideoFrame / ImageBitmap through a 2D canvas (the colour conversion is the browser's: BT.709 full range
// 4:4:4 -> sRGB, no gamma change).
function makeCanvas(env, w, h) {
  if (typeof env.OffscreenCanvas === 'function') return new env.OffscreenCanvas(w, h);
  const c = env.document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

export class Av1AtlasDecoder {
  // opts.env: globalThis-like (tests); opts.path: 'webcodecs' | 'bitmap' | undefined (auto)
  constructor(opts = {}) {
    this.env = opts.env || globalThis;
    this.forced = opts.path || null;
    this.path = null;
    this.decoder = null;
    this.configured = null;
    this.stats = {webcodecs: 0, bitmap: 0, copyTo: 0, canvas: 0};
  }

  async decodeAtlas(w, h, bytes) {
    const path = await this._pick(w, h);
    return path === 'webcodecs' ? this._viaWebCodecs(w, h, bytes) : this._viaBitmap(w, h, bytes);
  }

  async _pick(w, h) {
    if (this.path) return this.path;
    const env = this.env;
    const want = this.forced || 'webcodecs';
    if (want === 'webcodecs' && typeof env.VideoDecoder === 'function') {
      try {
        const s = await env.VideoDecoder.isConfigSupported({codec: av1CodecString(), codedWidth: Math.max(w, 16), codedHeight: Math.max(h, 16)});
        if (s && s.supported) return (this.path = 'webcodecs');
      } catch (_) { /* fall through */ }
    }
    if (this.forced === 'webcodecs') throw new PhotoError('WebCodecs cannot decode AV1 4:4:4');
    if (typeof env.createImageBitmap === 'function') return (this.path = 'bitmap');
    throw new PhotoError('no AV1 4:4:4 decode path');
  }

  _newDecoder(w, h) {
    const env = this.env;
    const state = {error: null, frames: [], wake: null};
    const dec = new env.VideoDecoder({
      output: f => { state.frames.push(f); },
      error: e => { state.error = e; },
    });
    dec.configure({codec: av1CodecString(), codedWidth: w, codedHeight: h});
    return {dec, state};
  }

  async _viaWebCodecs(w, h, bytes) {
    const env = this.env;
    // A fresh decoder per atlas: a decoder that failed is closed and cannot be reused, and 4:4:4 keyframes are
    // independent anyway. (Creation costs well under a millisecond.)
    const {dec, state} = this._newDecoder(w, h);
    let frame = null;
    try {
      dec.decode(new env.EncodedVideoChunk({type: 'key', timestamp: 0, data: bytes}));
      await dec.flush();
      if (state.error) throw state.error;
      frame = state.frames.shift();
      if (!frame) throw new PhotoError('decoder produced no frame');
      if (frame.displayWidth !== w || frame.displayHeight !== h) throw new PhotoError('decoded size ' + frame.displayWidth + 'x' + frame.displayHeight + ' != ' + w + 'x' + h);
      this.stats.webcodecs++;
      return await this._frameToRgba(frame, w, h);
    } catch (e) {
      throw e instanceof PhotoError ? e : new PhotoError('AV1 decode failed: ' + (e && e.message || e));
    } finally {
      if (frame) frame.close();
      for (const f of state.frames) f.close();
      try { dec.close(); } catch (_) { /* already closed after an error */ }
    }
  }

  async _frameToRgba(frame, w, h) {
    const out = new Uint8ClampedArray(w * h * 4);
    if (!this.noCopyTo && typeof frame.copyTo === 'function') {
      try {
        await frame.copyTo(out, {format: 'RGBA', colorSpace: 'srgb', layout: [{offset: 0, stride: w * 4}]});
        this.stats.copyTo++;
        for (let i = 3; i < out.length; i += 4) out[i] = 255;
        return out;
      } catch (_) { this.noCopyTo = true; }   // this browser cannot convert in copyTo: use the canvas
    }
    return this._drawToRgba(frame, w, h);
  }

  _drawToRgba(src, w, h) {
    const canvas = makeCanvas(this.env, w, h);
    const ctx = canvas.getContext('2d', {willReadFrequently: true, colorSpace: 'srgb', alpha: false});
    ctx.drawImage(src, 0, 0);
    const d = ctx.getImageData(0, 0, w, h).data;
    this.stats.canvas++;
    return new Uint8ClampedArray(d.buffer, d.byteOffset, d.length);
  }

  async _viaBitmap(w, h, bytes) {
    const env = this.env;
    let bmp;
    try {
      const blob = new env.Blob([wrapAvif(bytes, w, h)], {type: 'image/avif'});
      bmp = await env.createImageBitmap(blob, {colorSpaceConversion: 'none', premultiplyAlpha: 'none'});
      if (bmp.width !== w || bmp.height !== h) throw new PhotoError('decoded size ' + bmp.width + 'x' + bmp.height);
      this.stats.bitmap++;
      return this._drawToRgba(bmp, w, h);
    } catch (e) {
      throw e instanceof PhotoError ? e : new PhotoError('AVIF decode failed: ' + (e && e.message || e));
    } finally {
      if (bmp) bmp.close();
    }
  }

  close() { this.decoder = null; }
}
photoDecoders.set(CODEC_AV1, Av1AtlasDecoder);
