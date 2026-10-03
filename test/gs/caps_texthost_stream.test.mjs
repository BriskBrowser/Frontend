import test from 'node:test';
import assert from 'node:assert/strict';
import {probeCaps, PHOTO_AV1, PHOTO_RAW} from '../../src/gs/caps.js';
import {TextHost, createTextHandler} from '../../src/gs/textHost.js';
import {GsStream} from '../../src/gs/stream.js';
import {Compositor} from '../../src/gs/compositor.js';
import {Surface, TILE} from '../../src/gs/surface.js';
import * as P from './fixtures/packets.mjs';
import {StubFlat, StubPhoto, stubEnv} from './fixtures/decoders.mjs';

// ---- capability probe -------------------------------------------------------
test('caps: raw is always advertised; AV1 only when VideoDecoder supports 4:4:4', async () => {
  const none = await probeCaps({});
  assert.deepEqual(none, {flat: [1], text: [1], photo: [PHOTO_RAW], webgpu: false, worker: false, maxTexture: 4096});
  const av1 = await probeCaps({
    VideoDecoder: {isConfigSupported: async cfg => ({supported: cfg.codec.startsWith('av01.1.')})},
    Worker: function () {},
    navigator: {gpu: {requestAdapter: async () => ({limits: {maxTextureDimension2D: 16384}})}},
  });
  assert.deepEqual(av1.photo, [PHOTO_AV1, PHOTO_RAW]);
  assert.equal(av1.worker, true); assert.equal(av1.webgpu, true); assert.equal(av1.maxTexture, 16384);
  const no = await probeCaps({VideoDecoder: {isConfigSupported: async () => ({supported: false})}});
  assert.deepEqual(no.photo, [PHOTO_RAW]);
});

test('caps: a throwing or hanging probe degrades, never rejects', async () => {
  const caps = await probeCaps({
    VideoDecoder: {isConfigSupported: async () => { throw new Error('boom'); }},
    navigator: {gpu: {requestAdapter: async () => { throw new Error('no adapter'); }}},
  });
  assert.deepEqual(caps.photo, [PHOTO_RAW]);
  assert.equal(caps.webgpu, false);
});

// ---- text host -----------------------------------------------------------------
class FakeDecoder {
  constructor() { this.n = 0; }
  decodeBand(bytes) { if (bytes[0] === 99) throw new Error('bad band'); this.n++; return [{n: this.n, b: bytes[0]}]; }
  reset() { this.n = 0; }
}

test('text host main-thread mode decodes in order with persistent state', async () => {
  const host = new TextHost({createWorker: () => null, loadDecoder: async () => FakeDecoder});
  const r = await Promise.all([1, 2, 3].map(b => host.decode(Uint8Array.of(b))));
  assert.deepEqual(r.map(x => x[0].n), [1, 2, 3]);
  host.reset();
  assert.deepEqual((await host.decode(Uint8Array.of(7)))[0], {n: 1, b: 7});
  await assert.rejects(host.decode(Uint8Array.of(99)), /bad band/);
  assert.deepEqual((await host.decode(Uint8Array.of(8)))[0].b, 8, 'a failed band does not wedge the queue');
});

class FakeWorker {
  constructor(fail) { this.fail = fail; this.sent = []; }
  postMessage(m) {
    this.sent.push(m);
    if (this.fail) { setTimeout(() => this.onerror({message: 'cannot load', preventDefault() {}}), 0); return; }
    const handler = this.handler ||= createTextHandler(FakeDecoder);
    setTimeout(() => this.onmessage({data: handler(m)}), 0);
  }
  terminate() { this.terminated = true; }
}

test('text host with a worker posts copies and resolves by id', async () => {
  const w = new FakeWorker(false);
  const host = new TextHost({createWorker: () => w});
  const bytes = Uint8Array.of(5);
  const p = host.decode(bytes);
  bytes[0] = 0;
  assert.equal(w.sent[0].bytes[0], 5, 'the websocket buffer is copied, not transferred');
  assert.deepEqual(await p, [{n: 1, b: 5}]);
});

test('text host falls back to the main thread when the worker never starts', async () => {
  const w = new FakeWorker(true);
  const host = new TextHost({createWorker: () => w, loadDecoder: async () => FakeDecoder});
  const out = await Promise.all([host.decode(Uint8Array.of(1)), host.decode(Uint8Array.of(2))]);
  assert.deepEqual(out.map(x => x[0].n), [1, 2]);
  assert.equal(w.terminated, true);
  assert.equal(host.mode, 'main');
});

test('text host: close rejects pending work', async () => {
  const w = new FakeWorker(false);
  const host = new TextHost({createWorker: () => { const x = w; x.postMessage = () => {}; return x; }});
  const p = host.decode(Uint8Array.of(1));
  host.close();
  await assert.rejects(p, /closed/);
  await assert.rejects(host.decode(Uint8Array.of(1)), /closed/);
});

// ---- GsStream: packet -> pixels -------------------------------------------------
test('GsStream: packets that arrive before the decoders load are applied in order', async () => {
  const e = stubEnv();
  const compositor = new Compositor(e.env);
  const flat = new StubFlat(), photo = new StubPhoto();
  let release;
  const gate = new Promise(r => { release = r; });
  const stream = new GsStream({
    compositor, textHost: {decode() { return Promise.resolve([]); }, reset() {}, close() {}},
    loadModules: async () => { await gate; return {FlatDecoder: function () { return flat; }, PhotoDecoder: function () { return photo; }, drawRuns: () => {}}; },
  });
  const frameEnds = [];
  stream.onFrameEnd = (s, seq) => frameEnds.push([s, seq]);
  const done = [
    stream.handle(P.layerCtl({w: 16, h: 16})),
    stream.handle(P.pixels({sections: [[1, Uint8Array.of(1, 2, 3, 255, 0)]]})),
    stream.handle(P.pixels({sections: [[2, Uint8Array.of(10, 77)]]})),
    stream.handle(P.frameEnd(1, 5)),
  ];
  release();
  await Promise.all(done);
  assert.deepEqual(Array.from(stream.dispatcher.surface(1, 1).rgba.subarray(0, 4)), [77, 77, 77, 255]);
  assert.deepEqual(frameEnds, [[1, 5]]);
  const parent = new (await import('./fixtures/decoders.mjs')).El('document');
  const holder = new (await import('./fixtures/decoders.mjs')).El('div');
  parent.appendChild(holder);
  compositor.attach(1, 1, holder);
  e.runFrames();
  const [strip] = compositor.layer(1, 1).strips.values();
  assert.deepEqual(strip.canvas.puts.at(-1).first, [77, 77, 77, 255]);
  stream.close();
});

// ---- Surface ------------------------------------------------------------------------
test('Surface: sizes, tile maps and bounds', () => {
  const s = new Surface(33, 17);
  assert.deepEqual([s.tilesX, s.tilesY, s.rgba.length, s.tileLay.length, s.tileUni.length], [3, 2, 33 * 17 * 4, 6, 6]);
  assert.ok(s.rgba instanceof Uint8ClampedArray);
  assert.throws(() => new Surface(0, 5), RangeError);
  assert.throws(() => new Surface(20000, 5), RangeError);
  assert.throws(() => new Surface(16384, 16384), RangeError);
  s.tileLay.fill(3); s.tileUni.fill(4); s.rgba.fill(255);
  s.clearRect(TILE, 0, TILE, TILE);
  assert.equal(s.tileLay[1], 0); assert.equal(s.tileLay[0], 3);
  assert.equal(s.rgba[(0 * 33 + 16) * 4], 0); assert.equal(s.rgba[15 * 4], 255);
});

test('Surface.copyBlock copies pixels and, when aligned, tile maps', () => {
  const a = new Surface(32, 32), b = new Surface(32, 32);
  a.rgba.fill(7); a.tileLay[3] = 9; a.tileUni[3] = 11;   // tile (1,1)
  b.copyBlock(a, 16, 16, 0, 0, 16, 16);
  assert.equal(b.rgba[0], 7); assert.equal(b.rgba[(15 * 32 + 15) * 4], 7); assert.equal(b.rgba[16 * 4], 0);
  assert.equal(b.tileLay[0], 9); assert.equal(b.tileUni[0], 11);
});
