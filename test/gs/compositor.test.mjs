import test from 'node:test';
import assert from 'node:assert/strict';
import {Compositor, STRIP_H, BAND_CSS} from '../../src/gs/compositor.js';
import {Surface} from '../../src/gs/surface.js';
import {El, stubEnv} from './fixtures/decoders.mjs';

function setup(w = 64, h = 64, info = {}) {
  const e = stubEnv();
  const doc = new El('document');
  const c = new Compositor(e.env);
  const surface = new Surface(w, h);
  const created = [];
  c.onLayerCreated = (s, l) => created.push([s, l]);
  c.layerChanged(1, 2, {generation: 1, w, h, cssScale: 2, cssX: 0, cssY: 0, ...info}, surface);
  const parent = new El('div');
  return {e, doc, c, surface, parent, created};
}

test('layer creation notifies once; unattached layers are not painted', () => {
  const t = setup();
  assert.deepEqual(t.created, [[1, 2]]);
  t.c.dirty(1, 2, {x: 0, y: 0, w: 16, h: 16});
  t.e.runFrames();
  assert.equal(t.c.stats.paints, 0);
  const view = t.c.layer(1, 2);
  assert.equal(view.strips.size, 0);
  t.c.layerChanged(1, 2, {generation: 2, w: 64, h: 64, cssScale: 2, cssX: 0, cssY: 0}, t.surface);
  assert.deepEqual(t.created, [[1, 2]], 'same surface: not a new layer');
});

test('attach owes the whole layer; dirty rects are put from the surface buffer', () => {
  const t = setup();
  t.surface.rgba.set([10, 20, 30, 255], 0);
  assert.ok(t.c.attach(1, 2, t.parent));
  t.doc.appendChild(t.parent);
  t.e.runFrames();
  const view = t.c.layer(1, 2);
  assert.equal(view.strips.size, 1);
  const [strip] = view.strips.values();
  assert.deepEqual(strip.canvas.puts[0], {dx: 0, dy: 0, x: 0, y: 0, w: 64, h: 64, first: [10, 20, 30, 255]});
  assert.equal(strip.canvas.width, 64);
  assert.equal(view.pixelRoot.style.cssText.includes('width:32px'), true, 'css size = device size / scale');

  t.surface.rgba.set([1, 2, 3, 4], (20 * 64 + 17) * 4);
  t.c.dirty(1, 2, {x: 16, y: 16, w: 16, h: 16});
  t.c.dirty(1, 2, {x: 32, y: 16, w: 16, h: 16});
  t.e.runFrames();
  assert.equal(strip.canvas.puts.length, 2, 'two dirty rects in one frame are one union put');
  assert.deepEqual(strip.canvas.puts[1], {dx: 0, dy: 0, x: 16, y: 16, w: 32, h: 16, first: [0, 0, 0, 0]});
});

test('tall layers become a stack of strips, painted only where dirty', () => {
  const h = STRIP_H * 2 + 100;
  const t = setup(32, h);
  t.c.attach(1, 2, t.parent); t.doc.appendChild(t.parent);
  t.e.runFrames();
  const view = t.c.layer(1, 2);
  assert.equal(view.strips.size, 3);
  assert.equal(view.strips.get(2).canvas.height, 100);
  t.c.dirty(1, 2, {x: 0, y: STRIP_H - 8, w: 16, h: 16});
  t.e.runFrames();
  const a = view.strips.get(0).canvas.puts.at(-1), b = view.strips.get(1).canvas.puts.at(-1);
  assert.deepEqual([a.y, a.h, a.dy], [STRIP_H - 8, 8, 0]);
  assert.deepEqual([b.y, b.h, b.dy], [STRIP_H, 8, -STRIP_H]);
  assert.equal(view.strips.get(2).canvas.puts.length, 1);
});

test('resize swaps the surface, repaints fully, keeps the root element', () => {
  const t = setup();
  t.c.attach(1, 2, t.parent); t.doc.appendChild(t.parent);
  t.e.runFrames();
  const root = t.c.layer(1, 2).root;
  const bigger = new Surface(128, 64);
  bigger.rgba.set([9, 9, 9, 9], 0);
  t.c.layerChanged(1, 2, {generation: 2, w: 128, h: 64, cssScale: 2, cssX: 0, cssY: 0}, bigger);
  t.e.runFrames();
  const view = t.c.layer(1, 2);
  assert.equal(view.root, root);
  const [strip] = view.strips.values();
  assert.equal(strip.canvas.width, 128);
  assert.deepEqual(strip.canvas.puts.at(-1), {dx: 0, dy: 0, x: 0, y: 0, w: 128, h: 64, first: [9, 9, 9, 9]});
});

test('layer and source removal detach elements', () => {
  const t = setup();
  t.c.layerChanged(1, 3, {generation: 1, w: 64, h: 64, cssScale: 1, cssX: 0, cssY: 0}, new Surface(64, 64));
  t.c.layerChanged(2, 2, {generation: 1, w: 64, h: 64, cssScale: 1, cssX: 0, cssY: 0}, new Surface(64, 64));
  t.c.attach(1, 2, t.parent);
  t.c.layerRemoved(1, 2);
  assert.equal(t.parent.children.length, 0);
  assert.equal(t.c.layer(1, 2), undefined);
  assert.equal(t.c.hasPixels(1), true);
  t.c.sourceRemoved(1);
  assert.equal(t.c.hasPixels(1), false);
  assert.equal(t.c.hasPixels(2), true);
});

test('attach is idempotent and re-parenting repaints', () => {
  const t = setup();
  t.c.attach(1, 2, t.parent); t.doc.appendChild(t.parent);
  t.e.runFrames();
  const [strip] = t.c.layer(1, 2).strips.values();
  const n = strip.canvas.puts.length;
  t.c.attach(1, 2, t.parent);
  t.e.runFrames();
  assert.equal(strip.canvas.puts.length, n);
  const other = new El('div'); t.doc.appendChild(other);
  t.c.attach(1, 2, other);
  t.e.runFrames();
  assert.equal(strip.canvas.puts.length, n + 1);
  assert.equal(t.parent.children.length, 0);
  assert.equal(t.c.attach(1, 99, other), false);
});

test('text bands draw with drawRuns above the pixels; empty runs remove the band', () => {
  const t = setup(64, 3000, {cssScale: 2});     // 1500 css px tall: bands 0 and 1
  const draws = [];
  t.c.setDrawRuns((ctx, runs, scale, ox, oy) => draws.push({runs, scale, ox, oy}));
  t.c.attach(1, 2, t.parent); t.doc.appendChild(t.parent);
  t.c.runs(1, 2, 0, [{id: 'a'}], 1);
  t.c.runs(1, 2, 1, [{id: 'b'}], 1);
  t.c.runs(1, 2, 2, [{id: 'c'}], 1);           // below the layer: nothing drawn
  t.e.runFrames();
  assert.deepEqual(draws.map(d => d.runs[0].id), ['a', 'b']);
  assert.equal(draws[0].scale, 2);
  const view = t.c.layer(1, 2);
  const canvas1 = view.bands.get(1).canvas;
  assert.equal(canvas1.height, Math.ceil((1500 - BAND_CSS) * 2));
  assert.ok(canvas1.style.cssText.includes('top:' + BAND_CSS + 'px'));
  assert.equal(view.textRoot.children.length, 2);
  t.c.runs(1, 2, 1, [], 2);
  assert.equal(view.textRoot.children.length, 1);
  assert.equal(view.bands.has(1), false);
});

test('text arriving before drawRuns loads is painted once it is set', () => {
  const t = setup();
  t.c.attach(1, 2, t.parent); t.doc.appendChild(t.parent);
  t.c.runs(1, 2, 0, [{id: 'x'}], 1);
  t.e.runFrames();
  assert.equal(t.c.stats.textDraws, 0);
  const draws = [];
  t.c.setDrawRuns((ctx, runs) => draws.push(runs));
  t.e.runFrames();
  assert.equal(draws.length, 1);
});

test('LAYER geometry change restyles strips and redraws text', () => {
  const t = setup();
  const draws = [];
  t.c.setDrawRuns((ctx, runs) => draws.push(runs));
  t.c.attach(1, 2, t.parent); t.doc.appendChild(t.parent);
  t.c.runs(1, 2, 0, [{id: 'x'}], 1);
  t.e.runFrames();
  t.c.layerChanged(1, 2, {generation: 3, w: 64, h: 64, cssScale: 2, cssX: 5, cssY: 6}, t.surface);
  t.e.runFrames();
  assert.equal(draws.length, 2);
  assert.ok(t.c.layer(1, 2).pixelRoot.style.cssText.includes('left:5px;top:6px'));
});
