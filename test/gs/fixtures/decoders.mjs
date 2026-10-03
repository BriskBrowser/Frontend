// Stand-ins for flat.js / photo.js / text.js with the wire-doc signatures.
// Section bodies: flat [r,g,b,a, photoTileFlag]; photo [delayMs, value]; text [id, delayMs].
export class StubFlat {
  constructor() { this.calls = []; this.resets = 0; this.library = 0; }
  apply(surface, surfaces, rect, bytes) {
    if (bytes.length < 5) throw new Error('flat: truncated');
    this.calls.push({rect: {...rect}, bytes: Array.from(bytes), surfaces, surface});
    this.library++;
    for (let y = rect.y; y < rect.y + rect.h; y++)
      for (let x = rect.x; x < rect.x + rect.w; x++) surface.rgba.set(bytes.subarray(0, 4), (y * surface.w + x) * 4);
    const tw = Math.ceil(rect.w / 16), th = Math.ceil(rect.h / 16);
    return {photoTiles: new Uint8Array(tw * th).fill(bytes[4])};
  }
  reset() { this.resets++; this.library = 0; }
}

export class StubPhoto {
  constructor() { this.order = []; this.resets = 0; }
  async apply(surface, rect, bytes, codec) {
    await new Promise(resolve => setTimeout(resolve, bytes[0] === 255 ? 1 : bytes[0]));
    if (bytes[0] === 255) throw new Error('photo: corrupt');
    this.order.push(bytes[1]);
    for (let y = rect.y; y < rect.y + rect.h; y++)
      for (let x = rect.x; x < rect.x + rect.w; x++) surface.rgba.set([bytes[1], bytes[1], bytes[1], 255], (y * surface.w + x) * 4);
  }
  reset() { this.resets++; }
}

export class StubText {
  constructor() { this.order = []; this.resets = 0; }
  decode(bytes) {
    this.order.push(bytes[0]);   // a worker takes messages in arrival order
    // Results come back in submission order, like a worker's.
    const run = (this.tail || Promise.resolve()).then(() => new Promise(resolve => setTimeout(() => resolve([{id: bytes[0]}]), bytes[1] || 0)));
    this.tail = run;
    return run;
  }
  reset() { this.resets++; }
}

// Minimal DOM for the compositor.
export class El {
  constructor(tag) {
    this.tag = tag; this.children = []; this.parentNode = null; this.style = {cssText: ''};
    this.width = 0; this.height = 0; this.puts = [];
  }
  append(...c) { for (const x of c) this.appendChild(x); }
  appendChild(c) { c.remove(); c.parentNode = this; this.children.push(c); return c; }
  remove() { if (this.parentNode) { this.parentNode.children = this.parentNode.children.filter(x => x !== this); this.parentNode = null; } }
  get isConnected() { let e = this; while (e.parentNode) e = e.parentNode; return e.tag === 'document'; }
  getContext() {
    const ops = this.puts;
    return {
      putImageData(image, dx, dy, x, y, w, h) {
        const at = ((y - dy) * image.width + x) * 4;
        ops.push({dx, dy, x, y, w, h, first: Array.from(image.data.subarray(at, at + 4))});
      },
      setTransform() {}, clearRect() {}, translate() {},
    };
  }
}

export function stubEnv() {
  const frames = [];
  return {
    env: {
      createElement: tag => new El(tag),
      requestFrame: cb => frames.push(cb),
      imageData: (data, width, height) => ({data, width, height}),
      isConnected: el => el.isConnected,
    },
    runFrames() { while (frames.length) frames.shift()(); },
    frames,
  };
}
