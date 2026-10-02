// Turns surfaces into pixels on screen. Each (source, layer) owns one root
// element holding the layer's pixel canvas, with the layer's text bands drawn
// in canvases above it. The Session puts that root inside the layer's div, so
// property-tree transforms, clips, scroll and opacity apply exactly as they did
// to the old per-tile elements; only the pixel source changed.
//
// Pixels: dirty rects are put (putImageData, straight alpha, replacing) into
// the canvas straight from the Surface's RGBA buffer on the next animation
// frame. A canvas is at most STRIP_H device px tall, so one tall layer is a
// short stack of strips created on first use rather than one 100k px canvas.
// Layers that are not in the document are not painted; their dirty region
// accumulates and is painted when they are attached.
//
// Text: runs for a (layer, band) are drawn with drawRuns() into a canvas per
// band that is positioned at css y = band * BAND_CSS from the layer origin.
export const STRIP_H = 4096;
export const BAND_CSS = 1024;

// Everything DOM goes through env so the logic runs in Node with stubs.
export function domEnv(doc = globalThis.document) {
  return {
    createElement: tag => doc.createElement(tag),
    requestFrame: cb => globalThis.requestAnimationFrame(cb),
    imageData: (rgba, w, h) => new ImageData(rgba, w, h),
    isConnected: el => el.isConnected,
  };
}

function unionRect(a, b) {
  if (!a) return {x: b.x, y: b.y, w: b.w, h: b.h};
  const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.w, b.x + b.w), y1 = Math.max(a.y + a.h, b.y + b.h);
  return {x: x0, y: y0, w: x1 - x0, h: y1 - y0};
}

class LayerView {
  constructor(env) {
    this.env = env;
    this.root = env.createElement('div');
    this.root.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;pointer-events:none';
    this.pixelRoot = env.createElement('div');
    this.textRoot = env.createElement('div');
    this.root.append(this.pixelRoot, this.textRoot);
    this.surface = null; this.image = null; this.info = null;
    this.dirty = null;        // device-px rect still to paint
    this.strips = new Map();  // strip index -> {canvas, ctx}
    this.bands = new Map();   // band -> {runs, canvas, ctx, stale}
    this.textStale = false;
  }
}

export class Compositor {
  constructor(env = domEnv(), {drawRuns = null} = {}) {
    this.env = env;
    this.drawRuns = drawRuns;       // set once text.js is loaded
    this.layers = new Map();        // 'source:layer' -> LayerView
    this.scheduled = false;
    this.onLayerCreated = null;     // (source, layer) -> void: a layer's element exists now
    this.stats = {paints: 0, putPixels: 0, textDraws: 0};
  }

  setDrawRuns(drawRuns) {
    this.drawRuns = drawRuns;
    for (const view of this.layers.values()) {
      for (const band of view.bands.values()) band.stale = true;
      view.textStale = view.bands.size > 0;
    }
    this.schedule();
  }

  key(source, layer) { return source * 4294967296 + layer; }
  layer(source, layer) { return this.layers.get(this.key(source, layer)); }
  hasPixels(source) {
    for (const k of this.layers.keys()) if (Math.floor(k / 4294967296) === source) return true;
    return false;
  }

  // ---- sink callbacks (see StreamDispatcher) -------------------------------
  layerChanged(source, layer, info, surface) {
    let view = this.layer(source, layer), created = false;
    if (!view) { view = new LayerView(this.env); this.layers.set(this.key(source, layer), view); created = true; }
    const resized = view.surface !== surface;
    view.info = info;
    if (resized) {
      view.surface = surface;
      view.image = this.env.imageData(surface.rgba, surface.w, surface.h);
      view.dirty = {x: 0, y: 0, w: surface.w, h: surface.h};   // keep what the old surface showed, repaint fully
      this.dropStrips(view);
    }
    this.place(view);
    for (const band of view.bands.values()) band.stale = true;
    view.textStale = view.bands.size > 0;
    this.schedule();
    if (created) this.onLayerCreated?.(source, layer);
  }

  layerRemoved(source, layer) {
    const view = this.layer(source, layer);
    if (!view) return;
    view.root.remove?.();
    this.layers.delete(this.key(source, layer));
  }

  sourceRemoved(source) {
    for (const k of [...this.layers.keys()])
      if (Math.floor(k / 4294967296) === source) { this.layers.get(k).root.remove?.(); this.layers.delete(k); }
  }

  dirty(source, layer, rect) {
    const view = this.layer(source, layer);
    if (!view || !view.surface) return;
    view.dirty = unionRect(view.dirty, rect);
    this.schedule();
  }

  runs(source, layer, band, runs) {
    const view = this.layer(source, layer);
    if (!view) return;
    let entry = view.bands.get(band);
    if (!runs || !runs.length) {
      if (entry) { entry.canvas?.remove?.(); view.bands.delete(band); }
      return;
    }
    if (!entry) view.bands.set(band, entry = {runs, canvas: null, ctx: null, stale: true});
    entry.runs = runs; entry.stale = true; view.textStale = true;
    this.schedule();
  }

  // ---- DOM placement ---------------------------------------------------------
  // Parent a layer's root under the layer's own element (once); idempotent.
  attach(source, layer, parent) {
    const view = this.layer(source, layer);
    if (!view || !parent) return false;
    if (view.root.parentNode !== parent) {
      parent.appendChild(view.root);
      // Never painted while detached: everything is owed to this parent.
      if (view.surface) view.dirty = {x: 0, y: 0, w: view.surface.w, h: view.surface.h};
      for (const band of view.bands.values()) band.stale = true;
      view.textStale = view.bands.size > 0;
      this.schedule();
    }
    return true;
  }

  // Strips live at the surface's css offset inside the layer.
  place(view) {
    const {cssScale, cssX, cssY, w, h} = view.info;
    view.pixelRoot.style.cssText = 'position:absolute;left:' + cssX + 'px;top:' + cssY + 'px;width:' + (w / cssScale) + 'px;height:' + (h / cssScale) + 'px';
    for (const [index, strip] of view.strips) this.placeStrip(view, index, strip.canvas);
  }
  placeStrip(view, index, canvas) {
    const {cssScale, w, h} = view.info;
    const y = index * STRIP_H, sh = Math.min(STRIP_H, h - y);
    canvas.style.cssText = 'position:absolute;left:0;top:' + (y / cssScale) + 'px;width:' + (w / cssScale) + 'px;height:' + (sh / cssScale) + 'px';
  }
  dropStrips(view) {
    for (const strip of view.strips.values()) strip.canvas.remove?.();
    view.strips.clear();
  }

  // ---- painting ----------------------------------------------------------------
  schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    this.env.requestFrame(() => { this.scheduled = false; this.flush(); });
  }

  connected(view) {
    return this.env.isConnected ? this.env.isConnected(view.root) : !!view.root.parentNode;
  }

  flush() {
    for (const view of this.layers.values()) {
      if (!this.connected(view)) continue;
      if (view.dirty && view.surface) { this.paintPixels(view); view.dirty = null; }
      if (view.textStale) { this.paintText(view); view.textStale = false; }
    }
  }

  paintPixels(view) {
    const s = view.surface;
    const d = view.dirty;
    const x0 = Math.max(0, d.x), y0 = Math.max(0, d.y);
    const x1 = Math.min(s.w, d.x + d.w), y1 = Math.min(s.h, d.y + d.h);
    if (x1 <= x0 || y1 <= y0) return;
    this.stats.paints++;
    for (let index = Math.floor(y0 / STRIP_H); index * STRIP_H < y1; index++) {
      const top = Math.max(y0, index * STRIP_H), bottom = Math.min(y1, (index + 1) * STRIP_H);
      let strip = view.strips.get(index);
      if (!strip) {
        const canvas = this.env.createElement('canvas');
        canvas.width = s.w; canvas.height = Math.min(STRIP_H, s.h - index * STRIP_H);
        strip = {canvas, ctx: canvas.getContext('2d')};
        view.strips.set(index, strip);
        view.pixelRoot.appendChild(canvas);
        this.placeStrip(view, index, canvas);
      }
      strip.ctx.putImageData(view.image, 0, -index * STRIP_H, x0, top, x1 - x0, bottom - top);
      this.stats.putPixels += (x1 - x0) * (bottom - top);
    }
  }

  paintText(view) {
    if (!view.info) return;
    const {cssScale, cssX, cssY, w, h} = view.info;
    const widthDev = Math.ceil((cssX + w / cssScale) * cssScale);
    const layerCssH = cssY + h / cssScale;
    for (const [band, entry] of view.bands) {
      if (!entry.stale) continue;
      const topCss = band * BAND_CSS;
      const heightCss = Math.min(BAND_CSS, layerCssH - topCss);
      if (heightCss <= 0 || !this.drawRuns) continue;   // below the layer, or text.js not loaded yet
      const wDev = Math.min(widthDev, 16384), hDev = Math.ceil(heightCss * cssScale);
      if (!entry.canvas) {
        entry.canvas = this.env.createElement('canvas');
        view.textRoot.appendChild(entry.canvas);
        entry.ctx = entry.canvas.getContext('2d');
      }
      const canvas = entry.canvas;
      // Resizing clears; only do it when the geometry changed.
      if (canvas.width !== wDev) canvas.width = wDev;
      if (canvas.height !== hDev) canvas.height = hDev;
      canvas.style.cssText = 'position:absolute;left:0;top:' + topCss + 'px;width:' + (wDev / cssScale) + 'px;height:' + (hDev / cssScale) + 'px';
      const ctx = entry.ctx;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, wDev, hDev);
      ctx.translate(0, -topCss * cssScale);
      this.drawRuns(ctx, entry.runs, cssScale, 0, 0);
      entry.stale = false;
      this.stats.textDraws++;
    }
  }

  close() {
    for (const view of this.layers.values()) view.root.remove?.();
    this.layers.clear();
  }
}
