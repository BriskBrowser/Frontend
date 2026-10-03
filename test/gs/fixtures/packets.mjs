// Builders for synthetic stream packets (docs/gpu-stream-wire.md section 2).
export class W {
  constructor() { this.a = []; }
  u8(x) { this.a.push(x & 255); return this; }
  u16(x) { return this.u8(x).u8(x >>> 8); }
  u32(x) { return this.u16(x & 0xffff).u16(x >>> 16); }
  i32(x) { return this.u32(x >>> 0); }
  f32(x) { const b = new DataView(new ArrayBuffer(4)); b.setFloat32(0, x, true); for (let i = 0; i < 4; i++) this.u8(b.getUint8(i)); return this; }
  varint(x) { while (x >= 128) { this.u8((x % 128) | 128); x = Math.floor(x / 128); } return this.u8(x); }
  bytes(b) { for (const x of b) this.a.push(x); return this; }
  done() { return Uint8Array.from(this.a); }
}

const head = (kind, source) => new W().u8(0xB7).u8(kind).u16(source);

export function pixels({source = 1, layer = 1, generation = 1, x = 0, y = 0, w = 16, h = 16, quality = 0, flags = 0, sections = []}) {
  const p = head(1, source).u32(layer).u32(generation).i32(x).i32(y).u16(w).u16(h).u8(quality).u8(flags).varint(sections.length);
  for (const [codec, body] of sections) p.u8(codec).varint(body.length).bytes(body);
  return p.done();
}
export function refBody(refs) {
  const p = new W().varint(refs.length);
  for (const r of refs) p.u16(r.tx).u16(r.ty).u16(r.tw).u16(r.th).u16(r.srcSource).u32(r.srcLayer).u16(r.stx).u16(r.sty);
  return p.done();
}
export function text({source = 1, layer = 1, generation = 1, band = 0, version = 1, body = []}) {
  return head(2, source).u32(layer).u32(generation).u32(band).u32(version).bytes(body).done();
}
const ctl = (source, sub) => head(3, source).u8(sub);
export const hello = (source = 0, stream = 7, photo = [3]) => ctl(source, 1).u32(stream).u8(1).u8(1).u8(photo.length).bytes(photo).done();
export const layerCtl = ({source = 1, layer = 1, generation = 1, w = 32, h = 32, scale = 1, cssX = 0, cssY = 0}) =>
  ctl(source, 2).u32(layer).u32(generation).u32(w).u32(h).f32(scale).i32(cssX).i32(cssY).done();
export const frameEnd = (source, seq) => ctl(source, 3).u32(seq).done();
export const drop = (source, layer) => ctl(source, 4).u32(layer).done();
export const libraryReset = source => ctl(source, 5).done();
export const sourceEnd = source => ctl(source, 6).done();
