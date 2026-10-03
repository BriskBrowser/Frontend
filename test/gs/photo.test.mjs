// Node tests for src/gs/photo.js: container parsing, dictionary mirror rules, blit, error handling, and a replay of the
// C++ PhotoStream (raw codec) scenario. The scenario is produced by
//   photo_test --scenario <dir>      (brisk_gpu/photo/test; PHOTO_SCENARIO=<dir> points this test at it)
// and is skipped when absent. Real AV1 decode is in photo_browser.cjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  PhotoDecoder, PhotoDictionary, PhotoError, parseSection, blitPhoto, wrapAvif, photoDecoders, RawAtlasDecoder,
  CODEC_RAW, CODEC_AV1, TILE,
} from '../../src/gs/photo.js';
import {Surface} from '../../src/gs/surface.js';

const SCENARIO = process.env.PHOTO_SCENARIO || '/home/sd/.claude/jobs/5092cee3/tmp/photo/scenario';

const varint = v => { const o = []; while (v >= 128) { o.push((v & 127) | 128); v = Math.floor(v / 128); } o.push(v); return o; };
const u16 = v => [v & 255, v >> 8];

// Hand-built raw-codec section: one new photo (tw x th tiles, solid colour c) at atlas (0,0), then optional held refs.
function rawSection({reset = false, rects, atlas}) {
  // rects: [{tx,ty,tw,th, held?: id}] ; atlas: {w,h,rgb:Uint8Array} or null
  const o = [...varint(rects.length * 2 + (reset ? 1 : 0))];
  for (const r of rects) o.push(...u16(r.tx), ...u16(r.ty), ...u16(r.tw), ...u16(r.th));
  for (const r of rects) o.push(...varint(r.held === undefined ? 0 : r.held + 1));
  if (!atlas) { o.push(0); return new Uint8Array(o); }
  o.push(1, ...varint(atlas.w), ...varint(atlas.h));
  for (const p of atlas.pos) o.push(0, ...varint(p.x / 8), ...varint(p.y / 8));
  o.push(...varint(atlas.rgb.length));
  const head = new Uint8Array(o);
  const out = new Uint8Array(head.length + atlas.rgb.length);
  out.set(head); out.set(atlas.rgb, head.length);
  return out;
}
function solidAtlas(w, h, color, pos) {
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) rgb.set(color, i * 3);
  return {w, h, rgb, pos};
}
const px = (s, x, y) => Array.from(s.rgba.subarray((y * s.w + x) * 4, (y * s.w + x) * 4 + 4));

test('registry holds the built-in decoders', () => {
  assert.equal(photoDecoders.get(CODEC_RAW), RawAtlasDecoder);
  assert.ok(photoDecoders.has(CODEC_AV1));
});

test('new photo then held photo, blit position and clipping', async () => {
  const dec = new PhotoDecoder();
  const s = new Surface(100, 80);
  const rect = {x: 10, y: 8, w: 70, h: 50};   // not tile multiples: photo is clipped to the patch
  await dec.apply(s, rect, rawSection({rects: [{tx: 0, ty: 0, tw: 2, th: 2}], atlas: solidAtlas(32, 32, [10, 20, 30], [{x: 0, y: 0}])}), CODEC_RAW);
  assert.deepEqual(px(s, 10, 8), [10, 20, 30, 255]);
  assert.deepEqual(px(s, 41, 39), [10, 20, 30, 255]);
  assert.deepEqual(px(s, 42, 8), [0, 0, 0, 0]);
  // held id 0 at tile (3,2): x = 10+48 = 58..89 clipped at the patch edge 80, y = 8+32 = 40..71 clipped at 58
  await dec.apply(s, rect, rawSection({rects: [{tx: 3, ty: 2, tw: 2, th: 2, held: 0}], atlas: null}), CODEC_RAW);
  assert.deepEqual(px(s, 58, 40), [10, 20, 30, 255]);
  assert.deepEqual(px(s, 69, 57), [10, 20, 30, 255]);
  assert.deepEqual(px(s, 79, 40), [10, 20, 30, 255]);
  assert.deepEqual(px(s, 80, 40), [0, 0, 0, 0]);
  assert.deepEqual(px(s, 69, 58), [0, 0, 0, 0]);
  assert.equal(dec.stats.newPhotos, 1);
  assert.equal(dec.stats.heldPhotos, 1);
});

test('codec byte can lead the bytes when the codec argument is omitted', async () => {
  const dec = new PhotoDecoder();
  const s = new Surface(32, 32);
  const body = rawSection({rects: [{tx: 0, ty: 0, tw: 1, th: 1}], atlas: solidAtlas(16, 16, [1, 2, 3], [{x: 0, y: 0}])});
  const framed = new Uint8Array(body.length + 1);
  framed[0] = CODEC_RAW; framed.set(body, 1);
  await dec.apply(s, {x: 0, y: 0, w: 32, h: 32}, framed);
  assert.deepEqual(px(s, 3, 3), [1, 2, 3, 255]);
});

test('corrupt sections reject, change nothing, and later sections still work', async () => {
  const dec = new PhotoDecoder();
  const s = new Surface(64, 64);
  const rect = {x: 0, y: 0, w: 64, h: 64};
  const good = rawSection({rects: [{tx: 0, ty: 0, tw: 1, th: 1}], atlas: solidAtlas(16, 16, [9, 9, 9], [{x: 0, y: 0}])});
  const bad = [
    ['truncated', good.subarray(0, good.length - 5)],
    ['trailing', new Uint8Array([...good, 0])],
    ['empty', new Uint8Array(0)],
    ['unknown held id', rawSection({rects: [{tx: 0, ty: 0, tw: 1, th: 1, held: 7}], atlas: null})],
    ['rect outside patch', rawSection({rects: [{tx: 9, ty: 0, tw: 1, th: 1}], atlas: solidAtlas(16, 16, [1, 1, 1], [{x: 0, y: 0}])})],
    ['photo outside atlas', rawSection({rects: [{tx: 0, ty: 0, tw: 2, th: 2}], atlas: solidAtlas(16, 16, [1, 1, 1], [{x: 0, y: 0}])})],
    ['huge varint', new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f])],
    ['rect count lie', new Uint8Array([...varint(4000 * 2), 1, 2, 3])],
  ];
  for (const [name, bytes] of bad) {
    await assert.rejects(dec.apply(s, rect, bytes, CODEC_RAW), PhotoError, name);
  }
  assert.equal(dec.dict.size, 0);
  assert.deepEqual(px(s, 0, 0), [0, 0, 0, 0]);
  // raw payload length mismatch is an atlas decode error after parsing: still no state change
  const lenLie = rawSection({rects: [{tx: 0, ty: 0, tw: 1, th: 1}], atlas: {...solidAtlas(16, 16, [1, 1, 1], [{x: 0, y: 0}]), w: 16, h: 17}});
  await assert.rejects(dec.apply(s, rect, lenLie, CODEC_RAW), PhotoError);
  await assert.rejects(dec.apply(s, rect, good, 99), /unsupported photo codec/);
  assert.equal(dec.dict.size, 0);
  await dec.apply(s, rect, good, CODEC_RAW);
  assert.equal(dec.dict.size, 1);
  assert.deepEqual(px(s, 5, 5), [9, 9, 9, 255]);
  assert.equal(dec.stats.errors, bad.length + 2);
});

test('decoder error from the codec leaves the dictionary untouched and the chain alive', async () => {
  let fail = true;
  class Flaky { async decodeAtlas(w, h) { if (fail) throw new Error('boom'); return new Uint8ClampedArray(w * h * 4).fill(200); } }
  const dec = new PhotoDecoder({codecs: new Map([[2, Flaky]])});
  const s = new Surface(32, 32);
  const sec = rawSection({rects: [{tx: 0, ty: 0, tw: 1, th: 1}], atlas: solidAtlas(16, 16, [0, 0, 0], [{x: 0, y: 0}])});
  const rect = {x: 0, y: 0, w: 32, h: 32};
  const p1 = dec.apply(s, rect, sec, 2), p2 = dec.apply(s, rect, sec, 2);   // fired without awaiting: serialized
  await assert.rejects(p1, PhotoError);
  await assert.rejects(p2, PhotoError);
  assert.equal(dec.dict.size, 0);
  fail = false;
  await dec.apply(s, rect, sec, 2);
  assert.equal(dec.dict.size, 1);
  assert.deepEqual(px(s, 0, 0), [200, 200, 200, 200]);
});

test('sections apply in call order even when the codec is slow', async () => {
  const order = [];
  class Slow { async decodeAtlas(w, h, bytes) { await new Promise(r => setTimeout(r, bytes[0] === 1 ? 30 : 1)); order.push(bytes[0]); return new Uint8ClampedArray(w * h * 4).fill(bytes[0]); } }
  const dec = new PhotoDecoder({codecs: new Map([[2, Slow]])});
  const s = new Surface(32, 16);
  const rect = {x: 0, y: 0, w: 32, h: 16};
  // one new 1x1-tile photo whose atlas payload is the single byte v
  const sec = (tx, v) => new Uint8Array([...varint(2), ...u16(tx), ...u16(0), ...u16(1), ...u16(1), 0, 1, 16, 16, 0, 0, 0, 1, v]);
  await Promise.all([dec.apply(s, rect, sec(0, 1), 2), dec.apply(s, rect, sec(1, 2), 2)]);
  assert.deepEqual(order, [1, 2]);
  assert.deepEqual(px(s, 0, 0), [1, 1, 1, 1]);
  assert.deepEqual(px(s, 16, 0), [2, 2, 2, 2]);
});

test('dictionary: LRU eviction by pixels and entries, ids never reused', () => {
  const d = new PhotoDictionary(1000, 3);
  const a = d.add(null, 10, 10), b = d.add(null, 10, 10), c = d.add(null, 10, 10);
  d.touch(a);                 // order: b c a
  const e = d.add(null, 10, 10);
  d.evict();                  // entries > 3 -> evict b
  assert.deepEqual([...d.map.keys()], [c, a, e]);
  assert.equal(d.pixels, 300);
  const big = d.add(null, 30, 30); // 900 px: pixels 1200 > 1000 -> evicts c, a then e? 1200-100-100=1000 ok
  d.evict();
  assert.deepEqual([...d.map.keys()], [e, big]);
  assert.equal(big, 4);
  d.reset();
  assert.equal(d.add(null, 1, 1), 0);
});

test('reset flag clears held photos before the section is applied', async () => {
  const dec = new PhotoDecoder();
  const s = new Surface(64, 32);
  const rect = {x: 0, y: 0, w: 64, h: 32};
  await dec.apply(s, rect, rawSection({rects: [{tx: 0, ty: 0, tw: 1, th: 1}], atlas: solidAtlas(16, 16, [5, 5, 5], [{x: 0, y: 0}])}), CODEC_RAW);
  await dec.apply(s, rect, rawSection({reset: true, rects: [{tx: 1, ty: 0, tw: 1, th: 1}], atlas: solidAtlas(16, 16, [6, 6, 6], [{x: 0, y: 0}])}), CODEC_RAW);
  assert.equal(dec.dict.size, 1);
  assert.equal(dec.dict.nextId, 1);
  await assert.rejects(dec.apply(s, rect, rawSection({rects: [{tx: 2, ty: 0, tw: 1, th: 1, held: 1}], atlas: null}), CODEC_RAW));
  await dec.apply(s, rect, rawSection({rects: [{tx: 2, ty: 0, tw: 1, th: 1, held: 0}], atlas: null}), CODEC_RAW);
  assert.deepEqual(px(s, 32, 0), [6, 6, 6, 255]);
  dec.reset();
  assert.equal(dec.dict.size, 0);
});

test('blitPhoto is clipped to surface and patch', () => {
  const s = new Surface(20, 20);
  const p = {rgba: new Uint8ClampedArray(32 * 32 * 4).fill(255), w: 32, h: 32};
  blitPhoto(s, {x: 4, y: 4, w: 10, h: 10}, 0, 0, p);
  assert.deepEqual(px(s, 4, 4), [255, 255, 255, 255]);
  assert.deepEqual(px(s, 13, 13), [255, 255, 255, 255]);
  assert.deepEqual(px(s, 14, 14), [0, 0, 0, 0]);
  assert.deepEqual(px(s, 3, 4), [0, 0, 0, 0]);
  blitPhoto(s, {x: 0, y: 0, w: 20, h: 20}, 5, 5, p);   // fully outside: nothing, no throw
});

test('parseSection rejects what the encoder never emits', () => {
  assert.throws(() => parseSection(new Uint8Array([0x80])), PhotoError);
  const ok = parseSection(rawSection({rects: [{tx: 0, ty: 0, tw: 1, th: 1}], atlas: solidAtlas(16, 16, [1, 2, 3], [{x: 0, y: 0}])}));
  assert.equal(ok.rects.length, 1);
  assert.equal(ok.atlases[0].payload.length, 16 * 16 * 3);
  assert.equal(parseSection(new Uint8Array([0, 0])).rects.length, 0);
});

test('wrapAvif builds a well formed box tree with a correct iloc offset', () => {
  const obu = new Uint8Array([0x12, 0x00, 0x0a, 0x0b, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  const f = wrapAvif(obu, 48, 32);
  const dv = new DataView(f.buffer);
  const boxes = (from, to) => { const r = []; for (let i = from; i < to;) { const n = dv.getUint32(i); r.push({type: String.fromCharCode(...f.subarray(i + 4, i + 8)), at: i, n}); i += n; } return r; };
  const top = boxes(0, f.length);
  assert.deepEqual(top.map(b => b.type), ['ftyp', 'meta', 'mdat']);
  const mdat = top[2];
  assert.equal(mdat.at + mdat.n, f.length);
  assert.deepEqual(Array.from(f.subarray(mdat.at + 8)), Array.from(obu.subarray(2)));   // TD stripped
  // find iloc: extent_offset must point at the mdat payload
  const meta = top[1];
  const inner = boxes(meta.at + 12, meta.at + meta.n);
  assert.deepEqual(inner.map(b => b.type), ['hdlr', 'pitm', 'iloc', 'iinf', 'iprp']);
  const iloc = inner[2];
  const off = dv.getUint32(iloc.at + 12 + 2 + 2 + 2 + 2 + 2);
  const len = dv.getUint32(iloc.at + 12 + 2 + 2 + 2 + 2 + 2 + 4);
  assert.equal(off, mdat.at + 8);
  assert.equal(len, obu.length - 2);
});

test('replay of the C++ PhotoStream raw scenario reproduces the source pixels', { skip: !fs.existsSync(SCENARIO + '/scenario.json') && 'no scenario (run photo_test --scenario)' }, async () => {
  const sc = JSON.parse(fs.readFileSync(SCENARIO + '/scenario.json', 'utf8'));
  const imgs = sc.imgs.map(([w, h], i) => ({w, h, px: fs.readFileSync(`${SCENARIO}/img${i}.rgba`)}));
  const [SW, SH] = sc.surface;
  const dec = new PhotoDecoder({maxPixels: sc.max_pixels, maxEntries: sc.max_entries});
  const surface = new Surface(SW, SH);
  const expect = new Uint8ClampedArray(SW * SH * 4);
  let held = 0, news = 0;
  for (let n = 0; n < sc.steps.length; n++) {
    const st = sc.steps[n];
    const [px0, py0, pw, ph] = st.patch;
    const body = new Uint8Array(fs.readFileSync(`${SCENARIO}/step${n}.sec`));
    const parsed = parseSection(body);
    assert.equal(parsed.reset, st.reset, 'step ' + n + ' reset flag');
    for (const r of parsed.rects) r.held >= 0 ? held++ : news++;
    await dec.apply(surface, {x: px0, y: py0, w: pw, h: ph}, body, CODEC_RAW);
    for (const [ii, tx, ty] of st.rects) {   // independent expectation: replicate-pad, clip to the patch
      const im = imgs[ii], tw = Math.ceil(im.w / TILE), th = Math.ceil(im.h / TILE);
      for (let y = 0; y < th * TILE; y++) for (let x = 0; x < tw * TILE; x++) {
        const dx = px0 + tx * TILE + x, dy = py0 + ty * TILE + y;
        if (dx >= px0 + pw || dy >= py0 + ph || dx >= SW || dy >= SH) continue;
        const sx = Math.min(x, im.w - 1), sy = Math.min(y, im.h - 1);
        expect.set([im.px[(sy * im.w + sx) * 4], im.px[(sy * im.w + sx) * 4 + 1], im.px[(sy * im.w + sx) * 4 + 2], 255], (dy * SW + dx) * 4);
      }
    }
    assert.deepEqual(Buffer.from(surface.rgba), Buffer.from(expect), 'surface after step ' + n);
  }
  assert.ok(held >= 5 && news >= 8, `scenario exercises held (${held}) and new (${news}) photos`);
  assert.ok(dec.dict.pixels <= sc.max_pixels && dec.dict.size <= sc.max_entries);
});
