// Round trip of the FLAT codec: the standalone C++ GPU encoder (brisk_gpu/flat/test/flat_test) encodes patches of real
// corpus surfaces (and synthetic ones), src/gs/flat.js decodes them, and every non-photo tile is compared pixel exact.
//
//   node test/gs/flat_roundtrip.mjs --bin /path/to/flat_test --out /tmp/flat [--site hackernews] [--crop 1280x1024]
//        [--synthetic] [--params 16,2,32,4,4] [--cells] [--fixture dir]
//
// Also checks the persistent tile maps (every known tile of every surface matches its pixels after every step) and that
// the decoder's photo mask equals the encoder's rects.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { FlatDecoder } from '../../src/gs/flat.js';
import { Surface, surfaceKey } from '../../src/gs/surface.js';

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const flag = n => args.includes('--' + n);
const BIN = opt('bin'), OUT = opt('out', '/tmp/flat-rt');
const PARAMS = opt('params', '16,2,32,4,4').split(',').map(Number);
const TS = 16;

fs.mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------- scenario construction
const lines = ['params ' + PARAMS.join(' ')];
const steps = [];                        // replay list
const truth = new Map();                 // key -> {w,h,img:Uint8Array rgba}
let imgN = 0;
function saveImage(key) {
  const t = truth.get(key), name = 'img' + imgN++, file = path.join(OUT, name + '.rgba');
  fs.writeFileSync(file, t.img);
  lines.push(`image ${name} ${file} ${t.w} ${t.h}`);
  return name;
}
function setTruth(key, w, h, img) { truth.set(key, { w, h, img }); }
let patchN = 0;
function patch(key, x, y, w, h, refs = [], label = '') {
  const name = saveImage(key), id = 'p' + String(patchN++).padStart(3, '0'), t = truth.get(key);
  lines.push(`patch ${id} ${key} ${name} ${x} ${y} ${w} ${h} ${x} ${y} ${t.w} ${t.h} ${refs.length} ${refs.join(' ')}`);
  steps.push({ type: 'patch', id, key, x, y, w, h, refs, label, sw: t.w, sh: t.h, img: Buffer.from(t.img) });
}
function event(type, cmd, fn, desc) { lines.push(cmd); steps.push({ type, fn, desc: { type, ...desc } }); }
function patchCells(key, x0, y0, w, h, refs, label, cell = 256) {
  for (let y = y0; y < y0 + h; y += cell) for (let x = x0; x < x0 + w; x += cell)
    patch(key, x, y, Math.min(cell, x0 + w - x), Math.min(cell, y0 + h - y), refs, label);
}
const crop = (img, W, x, y, w, h) => { const o = new Uint8Array(w * h * 4); for (let r = 0; r < h; r++) o.set(img.subarray(((y + r) * W + x) * 4, ((y + r) * W + x + w) * 4), r * w * 4); return o; };
function rgbToRgba(rgb, w, h) { const o = new Uint8Array(w * h * 4); for (let i = 0, j = 0; i < w * h; i++, j += 3) { o[i * 4] = rgb[j]; o[i * 4 + 1] = rgb[j + 1]; o[i * 4 + 2] = rgb[j + 2]; o[i * 4 + 3] = 255; } return o; }

const K1 = surfaceKey(1, 1), K2 = surfaceKey(1, 2), K3 = surfaceKey(2, 7), K4 = surfaceKey(2, 8);
let sources = [];                                  // [{w,h,rgba}] candidates
let r7sources = [];
if (flag('synthetic')) {
  // Deterministic synthetic page: text-like glyph noise, flat blocks, gradients (photo-like) and alpha.
  let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const mk = (w, h, alpha) => {
    const img = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) { img[i * 4] = img[i * 4 + 1] = img[i * 4 + 2] = 255; img[i * 4 + 3] = 255; }
    const put = (x, y, r, g, b, a = 255) => { if (x >= 0 && y >= 0 && x < w && y < h) { const o = (y * w + x) * 4; img[o] = r; img[o + 1] = g; img[o + 2] = b; img[o + 3] = a; } };
    for (let k = 0; k < 40; k++) { const x0 = rnd() * w | 0, y0 = rnd() * h | 0, bw = 20 + rnd() * 200 | 0, bh = 10 + rnd() * 60 | 0, c = [rnd() * 255 | 0, rnd() * 255 | 0, rnd() * 255 | 0]; for (let y = y0; y < y0 + bh; y++) for (let x = x0; x < x0 + bw; x++) put(x, y, c[0], c[1], c[2], alpha && k % 5 === 0 ? 128 : 255); }
    for (let k = 0; k < 600; k++) { const x0 = rnd() * w | 0, y0 = rnd() * h | 0; for (let y = 0; y < 8; y++) for (let x = 0; x < 6; x++) if (rnd() < 0.45) put(x0 + x, y0 + y, 20, 20, 30); }
    // "photo": noisy gradient
    const px = w / 3 | 0, py = h / 4 | 0;
    for (let y = py; y < py + 160 && y < h; y++) for (let x = px; x < px + 220 && x < w; x++) put(x, y, (x * 3 + rnd() * 30) & 255, (y * 2 + rnd() * 30) & 255, (x + y + rnd() * 40) & 255);
    if (alpha) for (let y = 0; y < h; y += 7) for (let x = 0; x < w; x++) { const o = (y * w + x) * 4; if (x % 3) { img[o + 3] = 0; img[o] = img[o + 1] = img[o + 2] = 0; } }
    return { w, h, rgba: img };
  };
  sources = [mk(700, 500, false), mk(700, 500, false), mk(333, 211, true)];
  sources[1].rgba.set(sources[0].rgba.subarray(0, 700 * 300 * 4));    // sibling shares the top
} else {
  const { loadSite } = require('/workspace/root/.claude/worktrees/tree-codec-capture/experiments/tree-codec/harness/corpus.js');
  const site = opt('site', 'hackernews'), [CW, CH] = opt('crop', '1280x1024').split('x').map(Number);
  const { surfaces } = loadSite(site);
  const pick = surfaces.filter(s => s.w >= 300 && s.h >= 200).slice(0, 4);
  for (const s of pick) {
    const w = Math.min(s.w, CW), h = Math.min(s.h, CH);
    const rgb = Buffer.alloc(w * h * 3); for (let y = 0; y < h; y++) s.rgb.copy(rgb, y * w * 3, y * s.w * 3, (y * s.w + w) * 3);
    sources.push({ w, h, rgba: rgbToRgba(rgb, w, h), rgb });
  }
  r7sources = sources;
}
if (sources.length < 2) throw new Error('need two surfaces');

const cells = flag('cells');
const doPatch = (key, x, y, w, h, refs, label) => cells ? patchCells(key, x, y, w, h, refs, label) : patch(key, x, y, w, h, refs, label);
{
  const A = sources[0], B = sources[1];
  // 1. a fresh surface, one patch (library empty)
  setTruth(K1, A.w, A.h, A.rgba.slice());
  doPatch(K1, 0, 0, A.w, A.h, [], 'first surface');
  // 2. a sibling surface, library populated, reference to the first
  setTruth(K2, B.w, B.h, B.rgba.slice());
  doPatch(K2, 0, 0, B.w, B.h, [K1], 'sibling with reference');
  // 3. unchanged re-raster: nothing to send
  doPatch(K1, 0, 0, A.w, A.h, [], 'unchanged');
  // 4. partial damage: repaint a band with a flat block + moved content
  {
    const t = truth.get(K1), y0 = 48, y1 = Math.min(A.h, 176);
    for (let y = y0; y < y1; y++) for (let x = 32; x < Math.min(A.w, 400); x++) { const o = (y * A.w + x) * 4; t.img[o] = 200; t.img[o + 1] = 30 + (x >> 5); t.img[o + 2] = 90; t.img[o + 3] = 255; }
    doPatch(K1, 0, 0, A.w, A.h, [], 'partial damage, whole-layer patch');
    doPatch(K1, 32, y0, Math.min(A.w, 400) - 32 - ((Math.min(A.w, 400) - 32) % 16), 96, [], 'damage rect only');
  }
  // 5. odd sizes: surface 5 px narrower and 7 px shorter, whole patch then a sub-patch at the ragged edge
  {
    const w = A.w - 5, h = A.h - 7, img = crop(A.rgba, A.w, 0, 0, w, h);
    setTruth(K3, w, h, img);
    doPatch(K3, 0, 0, w, h, [K1], 'odd size');
    const x0 = Math.floor((w - 40) / 16) * 16, y0 = Math.floor((h - 40) / 16) * 16;
    const t = truth.get(K3); for (let y = y0; y < h; y++) for (let x = x0; x < w; x++) { const o = (y * w + x) * 4; t.img[o] = 12; t.img[o + 1] = 99; t.img[o + 2] = 200; }
    patch(K3, x0, y0, w - x0, h - y0, [], 'ragged corner sub-patch');
  }
  // 6. events: clearRect, copyBlock (aligned), resize, then re-patch
  {
    const t = truth.get(K1);
    event('clear', `clear ${K1} 64 64 130 70`, (S) => { S.get(K1).clearRect(64, 64, 130, 70); for (let y = 64; y < 134; y++) t.img.fill(0, (y * t.w + 64) * 4, (y * t.w + 194) * 4); }, { key: K1, x: 64, y: 64, w: 130, h: 70 });
    doPatch(K1, 0, 0, A.w, A.h, [], 'after clearRect (truth stays cleared)');
    const t2 = truth.get(K2);
    event('copy', `copyblock ${K1} 32 32 ${K2} 96 96 128 96`, (S) => { S.get(K2).copyBlock(S.get(K1), 32, 32, 96, 96, 128, 96); for (let y = 0; y < 96; y++) t2.img.set(t.img.subarray(((32 + y) * t.w + 32) * 4, ((32 + y) * t.w + 160) * 4), ((96 + y) * t2.w + 96) * 4); }, { sk: K1, sx: 32, sy: 32, dk: K2, dx: 96, dy: 96, w: 128, h: 96 });
    doPatch(K2, 0, 0, B.w, B.h, [K1], 'after copyBlock');
    const nw = A.w + 21, nh = A.h - 11, nimg = new Uint8Array(nw * nh * 4);
    for (let y = 0; y < nh; y++) nimg.set(t.img.subarray(y * t.w * 4, (y * t.w + Math.min(t.w, nw)) * 4), y * nw * 4);
    event('resize', `resize ${K1} ${nw} ${nh}`, (S) => { const n = new Surface(nw, nh); n.copyFrom(S.get(K1)); S.set(K1, n); }, { key: K1, w: nw, h: nh });
    setTruth(K1, nw, nh, nimg);
    doPatch(K1, 0, 0, nw, nh, [], 'after resize (new area, ragged edge)');
  }
  // 7. alpha surface
  if (sources[2]) {
    const C = sources[2]; const img = C.rgba.slice(); for (let i = 3; i < img.length; i += 4) if (img[i - 1] > 240 && img[i - 2] > 240) img[i] = (i >> 2) % 5 ? 255 : 90;
    setTruth(K4, C.w, C.h, img);
    doPatch(K4, 0, 0, C.w, C.h, [], 'alpha');
  }
}
fs.writeFileSync(path.join(OUT, 'scenario.txt'), lines.join('\n') + '\n');
execFileSync(BIN, [path.join(OUT, 'scenario.txt'), OUT], { stdio: ['ignore', 'inherit', 'inherit'] });

// ---------------------------------------------------------------- replay
const dec = new FlatDecoder();
const S = new Map();                         // key -> Surface
const get = (key, w, h) => { let s = S.get(key); if (!s || s.w !== w || s.h !== h) { if (s) throw new Error('size mismatch on surface ' + key); s = new Surface(w, h); S.set(key, s); } return s; };
let failures = 0, totalBytes = 0, totalDec = 0;
const FIX = opt('fixture');
const manifest = [];
if (FIX) fs.mkdirSync(FIX, { recursive: true });
const rows = [];

function checkConsistency(label, only) {
  for (const [key, s] of S) {
    if (only && key !== only.key) continue;
    const px = new Uint32Array(s.rgba.buffer, s.rgba.byteOffset, s.rgba.byteLength >> 2);
    const [a0, b0, a1, b1] = only ? [only.x >> 4, only.y >> 4, (only.x + only.w + 15) >> 4, (only.y + only.h + 15) >> 4] : [0, 0, s.tilesX, s.tilesY];
    for (let ty = b0; ty < b1; ty++) for (let tx = a0; tx < a1; tx++) {
      const l = s.tileLay[ty * s.tilesX + tx];
      if (l === 0) continue;
      const X = tx * TS, Y = ty * TS;
      for (let y = 0; y < TS && Y + y < s.h; y++) for (let x = 0; x < TS && X + x < s.w; x++) {
        const have = px[(Y + y) * s.w + X + x];
        const want = l === 1 ? s.tileUni[ty * s.tilesX + tx] : dec.lib[l - 2][Math.min(y, TS - 1) * TS + x];
        if (have !== want) { failures++; console.log(`FAIL ${label}: map of surface ${key} tile ${tx},${ty} (lay ${l}) disagrees with pixels at ${X + x},${Y + y}`); return; }
      }
    }
  }
}

for (const st of steps) {
  if (st.type !== 'patch') { st.fn(S); manifest.push(st.desc); continue; }
  const info = Object.fromEntries(fs.readFileSync(path.join(OUT, st.id + '.txt'), 'utf8').split('\n').filter(Boolean).map(l => [l.split(' ')[0], l.split(' ').slice(1)]));
  const bytes = fs.readFileSync(path.join(OUT, st.id + '.flat'));
  const t = { w: st.sw, h: st.sh, img: st.img };
  const surf = get(st.key, t.w, t.h);
  const rect = { x: st.x, y: st.y, w: st.w, h: st.h };
  const tw = Math.ceil(st.w / TS), th = Math.ceil(st.h / TS);
  const st0 = performance.now();
  let res = null;
  if (info.empty[0] === '1') { res = { photoTiles: new Uint8Array(tw * th) }; }
  else res = dec.apply(surf, S, rect, bytes);
  const ms = performance.now() - st0;
  totalBytes += bytes.length; totalDec += ms;
  // photo mask == rects
  const mask = new Uint8Array(tw * th), r = info.rects.map(Number);
  for (let i = 1; i + 3 < r.length + 0; i += 4) for (let y = r[i + 1]; y < r[i + 1] + r[i + 3]; y++) mask.fill(1, y * tw + r[i], y * tw + r[i] + r[i + 2]);
  if (info.empty[0] === '0' && Buffer.compare(Buffer.from(mask), Buffer.from(res.photoTiles)) !== 0) { failures++; console.log(`FAIL ${st.id}: photo mask differs`); }
  // pixels of every non-photo tile
  let bad = 0, checked = 0;
  for (let ty = 0; ty < th; ty++) for (let tx = 0; tx < tw; tx++) {
    if (mask[ty * tw + tx]) continue;
    for (let y = ty * TS; y < Math.min(st.h, ty * TS + TS) && bad < 3; y++) for (let x = tx * TS; x < Math.min(st.w, tx * TS + TS); x++) {
      const o1 = ((st.y + y) * surf.w + st.x + x) * 4, o2 = ((st.y + y) * t.w + st.x + x) * 4;
      checked++;
      if (surf.rgba[o1] !== t.img[o2] || surf.rgba[o1 + 1] !== t.img[o2 + 1] || surf.rgba[o1 + 2] !== t.img[o2 + 2] || surf.rgba[o1 + 3] !== t.img[o2 + 3]) {
        bad++; console.log(`FAIL ${st.id} (${st.label}) pixel ${st.x + x},${st.y + y}: got ${[...surf.rgba.subarray(o1, o1 + 4)]} want ${[...t.img.subarray(o2, o2 + 4)]}`); break;
      }
    }
  }
  failures += bad;
  if (FIX) {
    // sha256 of every non-photo tile's true pixels, row by row, in tile order
    const h = createHash('sha256');
    for (let ty = 0; ty < th; ty++) for (let tx = 0; tx < tw; tx++) {
      if (mask[ty * tw + tx]) continue;
      for (let y = ty * TS; y < Math.min(st.h, ty * TS + TS); y++) { const o = ((st.y + y) * surf.w + st.x + tx * TS) * 4; h.update(surf.rgba.subarray(o, o + Math.min(TS, st.w - tx * TS) * 4)); }
    }
    fs.writeFileSync(path.join(FIX, st.id + '.flat'), bytes);
    manifest.push({ type: 'patch', id: st.id, key: st.key, sw: t.w, sh: t.h, rect, refs: st.refs, empty: info.empty[0] === '1', sha: h.digest('hex'), maskRects: info.rects.map(Number) });
  }
  checkConsistency(st.id, { key: st.key, x: st.x, y: st.y, w: st.w, h: st.h });
  const stats = info.stats.join(' ');
  rows.push({ id: st.id, label: st.label, rect: `${st.x},${st.y} ${st.w}x${st.h}`, bytes: bytes.length, ms: +ms.toFixed(2), stats });
  console.log(`${st.id} ${st.label.padEnd(36)} ${rect.w}x${rect.h}@${rect.x},${rect.y} -> ${String(bytes.length).padStart(7)} B  decode ${ms.toFixed(2)} ms  ${stats}`);
}
console.log(failures ? `FAILED: ${failures} problems` : `OK: ${steps.filter(s => s.type === 'patch').length} patches pixel exact, ${totalBytes} B, JS decode ${totalDec.toFixed(1)} ms`);
if (FIX && !failures) fs.writeFileSync(path.join(FIX, 'manifest.json'), JSON.stringify(manifest));
fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ failures, rows }, null, 1));
process.exit(failures ? 1 : 0);
