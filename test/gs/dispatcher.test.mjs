import test from 'node:test';
import assert from 'node:assert/strict';
import {StreamDispatcher, StreamError} from '../../src/gs/dispatcher.js';
import {surfaceKey} from '../../src/gs/surface.js';
import * as P from './fixtures/packets.mjs';
import {StubFlat, StubPhoto, StubText} from './fixtures/decoders.mjs';

function setup() {
  const flat = new StubFlat(), photo = new StubPhoto(), text = new StubText();
  const events = [];
  const sink = {};
  for (const name of ['hello', 'layerChanged', 'layerRemoved', 'sourceRemoved', 'dirty', 'runs', 'frameEnd', 'drop', 'libraryReset'])
    sink[name] = (...args) => events.push([name, ...args]);
  const d = new StreamDispatcher({decoders: {flat, photo, text}, sink});
  return {d, flat, photo, text, events, names: () => events.map(e => e[0])};
}
const px = (d, r, g, b, a = 255, photo = 0) => [1, Uint8Array.from([r, g, b, a, photo])];
const pixelAt = (s, x, y) => Array.from(s.rgba.subarray((y * s.w + x) * 4, (y * s.w + x) * 4 + 4));

test('layer create applies a flat patch and reports dirty', () => {
  const t = setup();
  t.d.handle(P.layerCtl({w: 32, h: 32}));
  assert.equal(t.d.handle(P.pixels({x: 16, y: 0, w: 16, h: 16, sections: [px(t.d, 1, 2, 3)]})), undefined);
  const s = t.d.surface(1, 1);
  assert.deepEqual(pixelAt(s, 16, 0), [1, 2, 3, 255]);
  assert.deepEqual(pixelAt(s, 0, 0), [0, 0, 0, 0]);
  assert.deepEqual(t.names(), ['layerChanged', 'dirty']);
  assert.equal(t.d.surfaces.get(surfaceKey(1, 1)), s);
  assert.deepEqual(t.flat.calls[0].rect, {x: 16, y: 0, w: 16, h: 16});
});

test('photo decode is async but sections and packets apply in arrival order', async () => {
  const t = setup();
  t.d.handle(P.layerCtl({w: 32, h: 16}));
  // Packet A: flat then a slow photo section over the same rect; packet B: fast photo of another value.
  const a = t.d.handle(P.pixels({w: 32, h: 16, sections: [px(t.d, 9, 9, 9, 255, 1), [2, Uint8Array.from([30, 100])]]}));
  const b = t.d.handle(P.pixels({w: 16, h: 16, sections: [[2, Uint8Array.from([0, 200])]]}));
  const c = t.d.handle(P.pixels({x: 16, w: 16, h: 16, sections: px(t.d, 5, 5, 5) && [px(t.d, 5, 5, 5)]}));
  assert.ok(a && b && c, 'later packets queue behind unfinished work');
  await Promise.all([a, b, c]);
  assert.deepEqual(t.photo.order, [100, 200]);
  const s = t.d.surface(1, 1);
  assert.deepEqual(pixelAt(s, 0, 0), [200, 200, 200, 255]);   // B after A
  assert.deepEqual(pixelAt(s, 16, 0), [5, 5, 5, 255]);        // C after A's photo overwrote the whole rect
  assert.deepEqual(t.names().filter(n => n === 'dirty').length, 3);
  assert.equal(t.d.tail, null);
});

test('synchronous packets after a drained queue stay synchronous', async () => {
  const t = setup();
  t.d.handle(P.layerCtl({}));
  await t.d.handle(P.pixels({sections: [[2, Uint8Array.from([1, 7])]]}));
  await new Promise(r => setTimeout(r, 0));
  assert.equal(t.d.handle(P.pixels({sections: [px(t.d, 1, 1, 1)]})), undefined);
});

test('generation: older patch is ignored but still runs the decoders', () => {
  const t = setup();
  t.d.handle(P.layerCtl({generation: 5, w: 16, h: 16}));
  t.d.handle(P.pixels({generation: 5, sections: [px(t.d, 10, 10, 10)]}));
  t.d.handle(P.pixels({generation: 4, sections: [px(t.d, 99, 99, 99)]}));
  assert.deepEqual(pixelAt(t.d.surface(1, 1), 3, 3), [10, 10, 10, 255]);
  assert.equal(t.flat.calls.length, 2, 'library-bearing sections are never skipped');
  assert.equal(t.d.stats.ignored, 1);
  // The coder codes against the surface's tile maps, so a stale patch is decoded on the real surface (pixels restored
  // afterwards), not a scratch one: regression for "lane did not end cleanly" on a slow link.
  assert.equal(t.flat.calls[1].surface, t.d.surface(1, 1));
  t.d.handle(P.pixels({generation: 6, sections: [px(t.d, 20, 20, 20)]}));
  assert.deepEqual(pixelAt(t.d.surface(1, 1), 3, 3), [20, 20, 20, 255]);
});

test('patch for an unknown layer runs decoders on scratch and changes nothing', () => {
  const t = setup();
  t.d.handle(P.pixels({layer: 77, sections: [px(t.d, 1, 1, 1)]}));
  assert.equal(t.flat.calls.length, 1);
  assert.equal(t.d.sources.size, 0);
  assert.deepEqual(t.names(), []);
});

test('layer resize keeps overlapping pixels; delete removes surface', () => {
  const t = setup();
  t.d.handle(P.layerCtl({generation: 1, w: 16, h: 16}));
  t.d.handle(P.pixels({sections: [px(t.d, 4, 5, 6)]}));
  t.d.handle(P.layerCtl({generation: 2, w: 32, h: 48}));
  const s = t.d.surface(1, 1);
  assert.equal(s.w, 32); assert.equal(s.h, 48);
  assert.deepEqual(pixelAt(s, 15, 15), [4, 5, 6, 255]);
  assert.deepEqual(pixelAt(s, 20, 20), [0, 0, 0, 0]);
  assert.equal(t.d.surfaces.get(surfaceKey(1, 1)), s);
  t.d.handle(P.layerCtl({generation: 3, w: 0, h: 0}));
  assert.equal(t.d.surface(1, 1), undefined);
  assert.equal(t.d.surfaces.size, 0);
  assert.equal(t.names().at(-1), 'layerRemoved');
});

test('same-size LAYER keeps the surface, updates geometry and generation', () => {
  const t = setup();
  t.d.handle(P.layerCtl({w: 16, h: 16, scale: 1}));
  const s = t.d.surface(1, 1);
  t.d.handle(P.layerCtl({generation: 2, w: 16, h: 16, scale: 2, cssX: 3, cssY: 4}));
  assert.equal(t.d.surface(1, 1), s);
  assert.deepEqual(t.d.layerState(1, 1).info, {generation: 2, w: 16, h: 16, cssScale: 2, cssX: 3, cssY: 4});
});

test('reset_rect clears before applying; REF copies from another held surface', () => {
  const t = setup();
  t.d.handle(P.layerCtl({layer: 1, w: 32, h: 16}));
  t.d.handle(P.layerCtl({source: 2, layer: 9, w: 32, h: 16}));
  t.d.handle(P.pixels({layer: 1, w: 32, h: 16, sections: [px(t.d, 7, 7, 7)]}));
  t.d.handle(P.pixels({layer: 1, w: 16, h: 16, flags: 1, sections: []}));
  assert.deepEqual(pixelAt(t.d.surface(1, 1), 0, 0), [0, 0, 0, 0]);
  assert.deepEqual(pixelAt(t.d.surface(1, 1), 20, 0), [7, 7, 7, 255]);
  const ref = P.refBody([{tx: 0, ty: 0, tw: 1, th: 1, srcSource: 1, srcLayer: 1, stx: 1, sty: 0}]);
  t.d.handle(P.pixels({source: 2, layer: 9, w: 16, h: 16, sections: [[16, ref]]}));
  assert.deepEqual(pixelAt(t.d.surface(2, 9), 5, 5), [7, 7, 7, 255]);
  assert.deepEqual(pixelAt(t.d.surface(2, 9), 20, 5), [0, 0, 0, 0]);
});

test('TEXT: replaces band runs, in order, with versions; FRAME_END waits for decodes', async () => {
  const t = setup();
  t.d.handle(P.layerCtl({}));
  t.d.handle(P.text({band: 0, version: 2, body: [1, 20]}));      // slow
  t.d.handle(P.text({band: 0, version: 1, body: [2, 0]}));       // older version, arrives later: ignored
  t.d.handle(P.text({band: 3, version: 1, body: []}));           // empty body = no text
  const end = t.d.handle(P.frameEnd(1, 42));
  assert.ok(end && typeof end.then === 'function');
  assert.ok(!t.names().includes('frameEnd'));
  await end;
  assert.deepEqual(t.text.order, [1, 2], 'worker sees arrival order');
  const runs = t.events.filter(e => e[0] === 'runs');
  assert.equal(runs.length, 2);
  assert.deepEqual(runs[0].slice(1, 5), [1, 1, 0, [{id: 1}]]);
  assert.deepEqual(runs[0].slice(3, 5), [0, [{id: 1}]]);
  assert.deepEqual(runs[1].slice(3, 5), [3, []]);
  assert.deepEqual(t.events.at(-1), ['frameEnd', 1, 42]);
});

test('TEXT for a stale generation or removed layer is decoded but not applied', async () => {
  const t = setup();
  t.d.handle(P.layerCtl({generation: 3}));
  t.d.handle(P.text({generation: 2, body: [4, 0]}));
  t.d.handle(P.text({layer: 50, body: [5, 0]}));
  await t.d.handle(P.frameEnd(1, 1));
  assert.deepEqual(t.text.order, [4, 5]);
  assert.equal(t.events.filter(e => e[0] === 'runs').length, 0);
});

test('FRAME_END without pending text is synchronous', () => {
  const t = setup();
  assert.equal(t.d.handle(P.frameEnd(3, 9)), undefined);
  assert.deepEqual(t.events, [['frameEnd', 3, 9]]);
});

test('DROP keeps held pixels and is reported', () => {
  const t = setup();
  t.d.handle(P.layerCtl({w: 16, h: 16}));
  t.d.handle(P.pixels({sections: [px(t.d, 8, 8, 8)]}));
  t.d.handle(P.drop(1, 1));
  t.d.handle(P.drop(1, 0));
  assert.deepEqual(pixelAt(t.d.surface(1, 1), 0, 0), [8, 8, 8, 255]);
  assert.deepEqual(t.events.filter(e => e[0] === 'drop'), [['drop', 1, 1], ['drop', 1, 0]]);
});

test('LIBRARY_RESET resets every decoder and keeps surfaces', () => {
  const t = setup();
  t.d.handle(P.layerCtl({w: 16, h: 16}));
  t.d.handle(P.pixels({sections: [px(t.d, 8, 8, 8)]}));
  assert.equal(t.flat.library, 1);
  t.d.handle(P.libraryReset(1));
  assert.equal(t.flat.library, 0);
  assert.equal(t.flat.resets + t.photo.resets + t.text.resets, 3);
  assert.deepEqual(pixelAt(t.d.surface(1, 1), 0, 0), [8, 8, 8, 255]);
  assert.ok(t.names().includes('libraryReset'));
});

test('SOURCE_END frees that source only', () => {
  const t = setup();
  t.d.handle(P.layerCtl({source: 1, layer: 1}));
  t.d.handle(P.layerCtl({source: 1, layer: 2}));
  t.d.handle(P.layerCtl({source: 2, layer: 1}));
  t.d.handle(P.sourceEnd(1));
  assert.equal(t.d.sources.has(1), false);
  assert.ok(t.d.surface(2, 1));
  assert.equal(t.d.surfaces.size, 1);
  assert.deepEqual(t.names().slice(-3), ['layerRemoved', 'layerRemoved', 'sourceRemoved']);
});

test('HELLO reports the chosen codecs and rejects unknown versions', () => {
  const t = setup();
  t.d.handle(P.hello(0, 7, [2, 3]));
  assert.deepEqual(t.events[0][1], {stream: 7, flat: 1, text: 1, photo: [2, 3]});
  const bad = P.hello(0, 7, [3]); bad[9] = 2;     // flat_ver
  assert.throws(() => t.d.handle(bad), StreamError);
});

test('malformed packets throw StreamError and leave state alone', () => {
  const t = setup();
  t.d.handle(P.layerCtl({w: 32, h: 32}));
  t.d.handle(P.pixels({w: 32, h: 32, sections: [px(t.d, 3, 3, 3)]}));
  const good = P.pixels({x: 16, y: 16, w: 16, h: 16, sections: [px(t.d, 9, 9, 9)]});
  const before = t.d.surface(1, 1).rgba.slice();
  const calls = t.flat.calls.length, evs = t.events.length;
  const bad = [
    new Uint8Array([]), new Uint8Array([0xB7]), new Uint8Array([0xB6, 1, 0, 0, 0]),
    new Uint8Array([0xB7, 9, 1, 0]),                                    // unknown kind
    good.subarray(0, good.length - 1),                                  // truncated section
    good.subarray(0, 20),                                               // truncated header
    P.pixels({x: 20, y: 20, w: 16, h: 16, sections: [px(t.d, 1, 1, 1)]}), // outside the layer
    P.pixels({w: 0, h: 16, sections: []}),
    P.pixels({sections: [[99, Uint8Array.of(1)]]}),                      // unknown codec
    P.pixels({sections: [[16, Uint8Array.of(5, 1)]]}),                   // REF with wrong length
    Uint8Array.from([...good, 0]),                                       // trailing byte
    new Uint8Array([0xB7, 3, 1, 0, 2, 1, 0, 0, 0]),                      // truncated LAYER
    P.layerCtl({w: 100000, h: 4}),
    P.layerCtl({scale: 0}),
    new Uint8Array([0xB7, 2, 1, 0, 1, 0]),                               // truncated TEXT
    Uint8Array.from([0xB7, 1, 1, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 16, 0, 16, 0, 0, 0, 0xff, 0xff, 0xff, 0xff, 0x0f]), // bad varint
  ];
  for (const [i, b] of bad.entries()) assert.throws(() => t.d.handle(b), StreamError, 'case ' + i);
  t.d.handle(new Uint8Array([0xB7, 3, 1, 0, 77]));  // an unknown control subtype is ignored, not an error
  assert.deepEqual(t.d.surface(1, 1).rgba, before);
  assert.equal(t.flat.calls.length, calls);
  assert.equal(t.events.length, evs);
  // Still usable afterwards.
  t.d.handle(good);
  assert.deepEqual(pixelAt(t.d.surface(1, 1), 20, 20), [9, 9, 9, 255]);
});

test('a malformed packet queued behind async work rejects without corrupting order', async () => {
  const t = setup();
  t.d.handle(P.layerCtl({w: 16, h: 16}));
  const a = t.d.handle(P.pixels({sections: [[2, Uint8Array.from([20, 50])]]}));
  const bad = t.d.handle(new Uint8Array([0xB7, 9, 1, 0]));
  const c = t.d.handle(P.pixels({sections: [px(t.d, 6, 6, 6)]}));
  await a;
  await assert.rejects(bad, StreamError);
  await c;
  assert.deepEqual(pixelAt(t.d.surface(1, 1), 0, 0), [6, 6, 6, 255]);
});

test('lazy decoders are built on first use; missing decoder is a StreamError', () => {
  let built = 0;
  const d = new StreamDispatcher({decoders: {flat: () => { built++; return new StubFlat(); }}});
  d.handle(P.layerCtl({w: 16, h: 16}));
  assert.equal(built, 0);
  d.handle(P.pixels({sections: [px(d, 1, 1, 1)]}));
  d.handle(P.pixels({sections: [px(d, 1, 1, 1)]}));
  assert.equal(built, 1);
  assert.throws(() => d.handle(P.pixels({sections: [[2, Uint8Array.of(0, 1)]]})), StreamError);
});

test('closed dispatcher ignores packets', () => {
  const t = setup();
  t.d.close();
  assert.equal(t.d.handle(P.layerCtl({})), undefined);
  assert.equal(t.events.length, 0);
});
