// A layer's pixels on the client: one RGBA surface per (source, layer), plus
// the per-16x16-tile maps the flat decoder keeps for its reference modes.
// Pure data, no DOM: the decoders write into it and the compositor reads it.

export const TILE = 16;
export const MAX_DIMENSION = 16384;        // a canvas cannot be wider than this on every browser we run on
export const MAX_PIXELS = 1 << 27;         // 512 MiB of RGBA; a larger layer is a protocol violation

// Key of a surface in the `surfaces` Map handed to FlatDecoder.apply():
// source (u16) * 2^32 + layer (u32), a safe integer.
export function surfaceKey(source, layer) {
  return source * 4294967296 + layer;
}

export class Surface {
  constructor(w, h) {
    if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0 ||
        w > MAX_DIMENSION || h > 1 << 24 || w * h > MAX_PIXELS)
      throw new RangeError('Surface size ' + w + 'x' + h);
    this.w = w; this.h = h;
    this.tilesX = Math.ceil(w / TILE); this.tilesY = Math.ceil(h / TILE);
    this.rgba = new Uint8ClampedArray(w * h * 4);   // straight alpha, row stride w*4
    const tiles = this.tilesX * this.tilesY;
    this.tileLay = new Int32Array(tiles);            // flat decoder: per tile layout/reference class
    this.tileUni = new Uint32Array(tiles);           // flat decoder: per tile uniform colour
    this.tileGen = new Uint32Array(tiles);           // generation of the patch that last wrote the tile
    this.key = 0;                                    // surfaceKey(), set when registered
  }
  get width() { return this.w; }
  get height() { return this.h; }

  // Pixels and tile maps of the part `old` and this surface share (same
  // origin). A resized layer keeps showing what it had until patches replace it.
  copyFrom(old) {
    const w = Math.min(this.w, old.w), h = Math.min(this.h, old.h);
    for (let y = 0; y < h; y++)
      this.rgba.set(old.rgba.subarray(y * old.w * 4, (y * old.w + w) * 4), y * this.w * 4);
    const tx = Math.min(this.tilesX, old.tilesX), ty = Math.min(this.tilesY, old.tilesY);
    for (let y = 0; y < ty; y++) for (let x = 0; x < tx; x++) {
      const a = y * this.tilesX + x, b = y * old.tilesX + x;
      this.tileLay[a] = old.tileLay[b]; this.tileUni[a] = old.tileUni[b]; this.tileGen[a] = old.tileGen[b];
    }
  }

  // Make the rect transparent and forget the tile maps under it (patch flag reset_rect).
  clearRect(x, y, w, h) {
    for (let row = y; row < y + h; row++)
      this.rgba.fill(0, (row * this.w + x) * 4, (row * this.w + x + w) * 4);
    const tx0 = Math.floor(x / TILE), tx1 = Math.ceil((x + w) / TILE);
    const ty0 = Math.floor(y / TILE), ty1 = Math.ceil((y + h) / TILE);
    for (let ty = ty0; ty < ty1; ty++) for (let tx = tx0; tx < tx1; tx++) {
      const i = ty * this.tilesX + tx;
      this.tileLay[i] = 0; this.tileUni[i] = 0;
    }
  }

  // Copy a block of pixels (and the tile maps when both are tile aligned)
  // from another surface; used by the REF section. The caller has clipped.
  copyBlock(src, sx, sy, dx, dy, w, h) {
    for (let row = 0; row < h; row++) {
      const from = ((sy + row) * src.w + sx) * 4, to = ((dy + row) * this.w + dx) * 4;
      this.rgba.set(src.rgba.subarray(from, from + w * 4), to);
    }
    if (sx % TILE === 0 && sy % TILE === 0 && dx % TILE === 0 && dy % TILE === 0) {
      const tw = Math.ceil(w / TILE), th = Math.ceil(h / TILE);
      for (let ty = 0; ty < th; ty++) for (let tx = 0; tx < tw; tx++) {
        const a = (dy / TILE + ty) * this.tilesX + dx / TILE + tx, b = (sy / TILE + ty) * src.tilesX + sx / TILE + tx;
        this.tileLay[a] = src.tileLay[b]; this.tileUni[a] = src.tileUni[b];
      }
    }
  }
}
