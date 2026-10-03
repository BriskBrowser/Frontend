// FLAT decoder tests that need no GPU: replay of encoder output committed under fixtures/flat (made by
// flat_roundtrip.mjs --synthetic --fixture, i.e. by the GLES compute encoder, and verified pixel exact there), and
// corrupt/truncated input handling.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { FlatDecoder, FlatError } from '../../src/gs/flat.js';
import { Surface } from '../../src/gs/surface.js';

const DIR = new URL('./fixtures/flat/', import.meta.url);
const manifest = JSON.parse(fs.readFileSync(new URL('manifest.json', DIR), 'utf8'));
const TS = 16;
const bytesOf = id => new Uint8Array(fs.readFileSync(new URL(id + '.flat', DIR)));

function sha(surf, rect, mask) {
  const tw = Math.ceil(rect.w / TS), th = Math.ceil(rect.h / TS), h = createHash('sha256');
  for (let ty = 0; ty < th; ty++) for (let tx = 0; tx < tw; tx++) {
    if (mask[ty * tw + tx]) continue;
    for (let y = ty * TS; y < Math.min(rect.h, ty * TS + TS); y++) { const o = ((rect.y + y) * surf.w + rect.x + tx * TS) * 4; h.update(surf.rgba.subarray(o, o + Math.min(TS, rect.w - tx * TS) * 4)); }
  }
  return h.digest('hex');
}

// Replays the manifest; calls hook(step, dec, S, bytes) before each non-empty patch if given and returns the final state.
function replay(stopAt, hook) {
  const dec = new FlatDecoder(), S = new Map();
  for (const st of manifest) {
    if (st.type === 'clear') S.get(st.key).clearRect(st.x, st.y, st.w, st.h);
    else if (st.type === 'copy') S.get(st.dk).copyBlock(S.get(st.sk), st.sx, st.sy, st.dx, st.dy, st.w, st.h);
    else if (st.type === 'resize') { const n = new Surface(st.w, st.h); n.copyFrom(S.get(st.key)); S.set(st.key, n); }
    else {
      if (!S.has(st.key)) S.set(st.key, new Surface(st.sw, st.sh));
      if (st.id === stopAt) return { dec, S, st };
      if (st.empty) continue;
      const bytes = bytesOf(st.id), surf = S.get(st.key);
      if (hook) hook(st, dec, S, bytes);
      const res = dec.apply(surf, S, st.rect, bytes);
      const out = sha(surf, st.rect, res.photoTiles);
      assert.equal(out, st.sha, `${st.id}: pixels differ from the encoder's input`);
    }
  }
  return { dec, S };
}

test('replays every committed patch pixel exact (library persistence, reference modes, partial damage, odd sizes, alpha)', () => {
  replay(null);
});

test('photo mask equals the encoder rects', () => {
  const dec = new FlatDecoder(), S = new Map();
  let checked = 0;
  for (const st of manifest) {
    if (st.type === 'clear') S.get(st.key).clearRect(st.x, st.y, st.w, st.h);
    else if (st.type === 'copy') S.get(st.dk).copyBlock(S.get(st.sk), st.sx, st.sy, st.dx, st.dy, st.w, st.h);
    else if (st.type === 'resize') { const n = new Surface(st.w, st.h); n.copyFrom(S.get(st.key)); S.set(st.key, n); }
    else {
      if (!S.has(st.key)) S.set(st.key, new Surface(st.sw, st.sh));
      if (st.empty) continue;
      const res = dec.apply(S.get(st.key), S, st.rect, bytesOf(st.id));
      const tw = Math.ceil(st.rect.w / TS), th = Math.ceil(st.rect.h / TS), want = new Uint8Array(tw * th), r = st.maskRects;
      for (let k = 1; k + 3 < r.length; k += 4) for (let y = r[k + 1]; y < r[k + 1] + r[k + 3]; y++) want.fill(1, y * tw + r[k], y * tw + r[k] + r[k + 2]);
      assert.deepEqual(res.photoTiles, want);
      checked++;
    }
  }
  assert.ok(checked >= 8);
});

test('reset() forgets the library: a patch that refers to old ids throws', () => {
  const { dec, S, st } = replay('p005');
  dec.reset();
  assert.throws(() => dec.apply(S.get(st.key), S, st.rect, bytesOf(st.id)), FlatError);
});

test('every truncation of a section throws FlatError (and never hangs)', () => {
  const { dec, S, st } = replay('p003');
  const bytes = bytesOf('p003'), surf = S.get(st.key);
  const before = dec.librarySize;
  const t0 = Date.now();
  for (let n = 0; n < bytes.length; n++) assert.throws(() => dec.apply(surf, S, st.rect, bytes.subarray(0, n)), FlatError, 'truncated to ' + n);
  assert.equal(dec.librarySize, before, 'failed decodes must not grow the library');
  assert.ok(Date.now() - t0 < 20000);
});

test('truncating the biggest first patch at many points throws; trailing garbage throws', () => {
  const bytes = bytesOf('p000'), st = manifest.find(s => s.id === 'p000');
  for (let n = 0; n < bytes.length; n += Math.ceil(bytes.length / 120)) {
    const dec = new FlatDecoder(), S = new Map([[st.key, new Surface(st.sw, st.sh)]]);
    assert.throws(() => dec.apply(S.get(st.key), S, st.rect, bytes.subarray(0, n)), FlatError, 'truncated to ' + n);
  }
  const dec = new FlatDecoder(), S = new Map([[st.key, new Surface(st.sw, st.sh)]]);
  const longer = new Uint8Array(bytes.length + 3); longer.set(bytes);
  assert.throws(() => dec.apply(S.get(st.key), S, st.rect, longer), FlatError);
});

test('random bit flips either decode or throw FlatError, quickly', () => {
  const bytes = bytesOf('p000'), st = manifest.find(s => s.id === 'p000');
  let seed = 7; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  let threw = 0;
  const t0 = Date.now();
  for (let i = 0; i < 150; i++) {
    const b = bytes.slice(), flips = 1 + (rnd() * 3 | 0);
    for (let k = 0; k < flips; k++) b[rnd() * b.length | 0] ^= 1 << (rnd() * 8 | 0);
    const dec = new FlatDecoder(), S = new Map([[st.key, new Surface(st.sw, st.sh)]]);
    try { dec.apply(S.get(st.key), S, st.rect, b); } catch (e) { assert.ok(e instanceof FlatError, 'unexpected ' + e); threw++; }
  }
  assert.ok(threw > 100, 'most corruptions are detected (lanes must end with the initial rANS state): ' + threw);
  assert.ok(Date.now() - t0 < 60000);
});

test('hostile headers are rejected without work', () => {
  const dec = new FlatDecoder(), surf = new Surface(64, 64), S = new Map();
  const rect = { x: 0, y: 0, w: 64, h: 64 };
  const hdr = (...v) => new Uint8Array(v);
  assert.throws(() => dec.apply(surf, S, rect, hdr()), FlatError);
  assert.throws(() => dec.apply(surf, S, rect, hdr(0x80)), FlatError);                       // reserved flags
  assert.throws(() => dec.apply(surf, S, rect, hdr(6)), FlatError);                           // reference kind 3
  assert.throws(() => dec.apply(surf, S, rect, hdr(4, 0, 1)), FlatError);                     // other surface that is not held
  assert.throws(() => dec.apply(surf, S, rect, hdr(0, 0, 4, 0, 0)), FlatError);               // BH = 0
  assert.throws(() => dec.apply(surf, S, rect, hdr(0, 16, 2, 200, 0, 0)), FlatError);         // more new tiles than tiles
  assert.throws(() => dec.apply(surf, S, rect, hdr(0, 16, 2, 0, 1, 0, 0, 9, 9)), FlatError);  // photo rect outside the patch
  assert.throws(() => dec.apply(surf, S, rect, hdr(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff)), FlatError);  // endless varint
  assert.throws(() => dec.apply(surf, S, { x: 8, y: 0, w: 16, h: 16 }, hdr(0, 16, 2, 0, 0)), FlatError);   // unaligned rect
  assert.throws(() => dec.apply(surf, S, { x: 0, y: 0, w: 128, h: 16 }, hdr(0, 16, 2, 0, 0)), FlatError);  // rect outside the surface
});
