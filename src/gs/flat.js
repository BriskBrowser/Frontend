// FLAT codec decoder (codec id 1 of the GPU stream): the normative reference for docs/gpu-stream-flat.md.
// Pure JS, no DOM; runs in Node and in a worker. Library tiles are stream-global and append-only.
//
//   const dec = new FlatDecoder();
//   const { photoTiles } = dec.apply(surface, surfaces, { x, y, w, h }, bytes);
//
// Any malformed or truncated input throws FlatError; no loop is unbounded (every count is validated against the patch
// size and every rANS lane must end exactly at its last byte with the initial state).
import * as P from './flat_priors.js';

export class FlatError extends Error {}

const TS = 16;
const PM = 32768, LB = 1 << 23;
const MAX_TILES = 1 << 20;
const PALMAX = 12;

const RATE = new Int32Array(256);
for (let n = 0; n < 256; n++) RATE[n] = Math.max(Math.floor((262144 + 2 * n + 3) / (4 * n + 6)), 2048);

function b64(s) {
  if (typeof Buffer !== 'undefined') { const b = Buffer.from(s, 'base64'); return new Uint8Array(b.buffer, b.byteOffset, b.length); }
  const bin = atob(s), u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
const PRIOR_N = b64(P.PRIOR_N_B64);
const PRIOR_P = (() => { const u = b64(P.PRIOR_P_B64), o = new Uint16Array(u.length >> 1); for (let i = 0; i < o.length; i++) o[i] = u[2 * i] | u[2 * i + 1] << 8; return o; })();
if (PRIOR_P.length !== P.MODEL_ENTRIES || PRIOR_N.length !== P.MODEL_ENTRIES) throw new Error('flat priors corrupt');

const OFF = P.TAB_OFF, NB = P.TAB_NB, PAL_OFF = OFF[P.TB_PAL];

// One rANS lane: adaptive binary models (15-bit probabilities, arithmetic of research adapt.js) over a byte range.
class Lane {
  constructor() { this.p = new Uint16Array(P.MODEL_ENTRIES); this.n = new Uint8Array(P.MODEL_ENTRIES); this.buf = null; this.o = 0; this.end = 0; this.x = 0; }
  start(buf, o, end) {
    if (end - o < 4) throw new FlatError('lane too short');
    this.p.set(PRIOR_P); this.n.set(PRIOR_N);
    this.buf = buf; this.end = end;
    const x0 = ((buf[o] << 24) | (buf[o + 1] << 16) | (buf[o + 2] << 8) | buf[o + 3]) >>> 0;
    if (x0 < LB || x0 >= 0x80000000) throw new FlatError('bad lane state');
    this.x = x0 | 0;                // the state is always in [2^23, 2^31): plain int32 arithmetic
    this.o = o + 4;
  }
  bit(gi) {
    const p = this.p, n = this.n, pp = p[gi];
    let q = pp >> 1; q = q < 32 ? 32 : q > 32736 ? 32736 : q;
    let x = this.x;
    const cum = x & (PM - 1), lim = PM - q;
    let b;
    if (cum >= lim) { b = 1; x = (Math.imul(q, x >>> 15) + cum - lim) | 0; } else { b = 0; x = (Math.imul(lim, x >>> 15) + cum) | 0; }
    while (x < LB) {
      if (this.o >= this.end) throw new FlatError('lane truncated');
      x = (x << 8) | this.buf[this.o++];
    }
    this.x = x;
    const c = n[gi];
    let v = pp + (Math.imul((b << 16) - pp, RATE[c]) >> 16);
    p[gi] = v < 64 ? 64 : v > 65472 ? 65472 : v;
    if (c < 255) n[gi] = c + 1;
    return b;
  }
  raw() {
    let x = this.x;
    const cum = x & (PM - 1), b = cum >= PM >> 1 ? 1 : 0;
    x = (Math.imul(PM >> 1, x >>> 15) + cum - (b ? PM >> 1 : 0)) | 0;
    while (x < LB) {
      if (this.o >= this.end) throw new FlatError('lane truncated');
      x = (x << 8) | this.buf[this.o++];
    }
    this.x = x;
    return b;
  }
  sym(tab, ctx) {
    const nb = NB[tab], base = OFF[tab] + (ctx << nb);
    let node = 1;
    for (let k = 0; k < nb; k++) node = node << 1 | this.bit(base + node);
    return node - (1 << nb);
  }
  num(tab) {
    const nb = this.sym(tab, 0) + 1;
    if (nb > 24) throw new FlatError('number too large');
    let v = 1;
    for (let k = 1; k < nb; k++) v = v << 1 | this.raw();
    return v - 1;
  }
  finish() { if (this.o !== this.end || this.x !== LB) throw new FlatError('lane did not end cleanly'); }
}

const unzz = z => (z & 1) ? -((z + 1) >> 1) : (z >> 1);

// Colour with per-channel residuals against pred (G first, R and B relative to the G residual), alpha if present.
function decodeColour(l, pred, t0, t1, t2, ta, alpha) {
  const pr = pred & 255, pg = (pred >>> 8) & 255, pb = (pred >>> 16) & 255, pa = pred >>> 24;
  const dg = unzz(l.sym(t0, 0));
  const r = (pr + unzz(l.sym(t1, 0)) + dg) & 255, g = (pg + dg) & 255, b = (pb + unzz(l.sym(t2, 0)) + dg) & 255;
  const a = alpha ? (pa + unzz(l.sym(ta, 0))) & 255 : 255;
  return (r | g << 8 | b << 16 | a << 24) >>> 0;
}

function readVarint(b, o, end) {
  let v = 0, m = 1;
  for (let i = 0; i < 6; i++) {
    if (o.p >= end) throw new FlatError('header truncated');
    const c = b[o.p++];
    v += (c & 127) * m; m *= 128;
    if (!(c & 128)) return v;
  }
  throw new FlatError('varint too long');
}

// Tile map encodings in Surface.tileLay: 0 unknown/photo, 1 uniform (tileUni), n >= 2 library tile n-2.
const MRU0 = [0xffffffff, 0xff000000, 0x00000000, 0xff808080];
const cls = m => m === 10 ? 6 : m === 0 ? 0 : m < 4 ? 1 : m === 4 ? 2 : m === 5 ? 3 : m < 9 ? 4 : 5;

const views = new WeakMap();
function px32(surface) {
  let v = views.get(surface.rgba);
  if (!v) { const r = surface.rgba; v = new Uint32Array(r.buffer, r.byteOffset, r.byteLength >> 2); views.set(r, v); }
  return v;
}

export class FlatDecoder {
  constructor() {
    this.lib = [];                 // Uint32Array(256) per library tile (RGBA words, row major)
    this.lane = new Lane();
    this.sy = new Uint8Array(256);
    this.pal = new Uint32Array(PALMAX);
    this.stats = { tiles: 0, newTiles: 0, bytes: 0 };
  }
  reset() { this.lib = []; }
  get librarySize() { return this.lib.length; }

  // One 16x16 library tile. The palette symbol (5 binary decisions per pixel, the hot loop of the whole decoder) is
  // decoded with the rANS state in locals; escapes go through the Lane methods.
  decodeTile(l, out, alpha) {
    const sy = this.sy, pal = this.pal, p = l.p, n = l.n, buf = l.buf, end = l.end;
    let x = l.x, o = l.o, npal = 0;
    for (let y = 0; y < TS; y++) for (let xx = 0; xx < TS; xx++) {
      const i = y * TS + xx;
      const hW = xx > 0, hN = y > 0, hNE = y > 0 && xx < TS - 1, hNW = y > 0 && xx > 0;
      const W = hW ? out[i - 1] : 0, N = hN ? out[i - 16] : 0, NE = hNE ? out[i - 15] : 0, NW = hNW ? out[i - 17] : 0;
      const eq = ((hW === hN && (!hW || W === N)) ? 1 : 0) | ((hN === hNE && (!hN || N === NE)) ? 2 : 0) | ((hN === hNW && (!hN || N === NW)) ? 4 : 0);
      const cl = xx > 0 ? (sy[i - 1] < 5 ? sy[i - 1] : 5) : 5, cu = y > 0 ? (sy[i - 16] < 5 ? sy[i - 16] : 5) : 5;
      const base = PAL_OFF + (((eq * 6 + cl) * 6 + cu) << 5);
      let node = 1;
      for (let k = 0; k < 5; k++) {
        const gi = base + node, pp = p[gi];
        let q = pp >> 1; q = q < 32 ? 32 : q > 32736 ? 32736 : q;
        const cum = x & 32767, lim = 32768 - q;
        let b;
        if (cum >= lim) { b = 1; x = (Math.imul(q, x >>> 15) + cum - lim) | 0; } else { b = 0; x = (Math.imul(lim, x >>> 15) + cum) | 0; }
        while (x < LB) {
          if (o >= end) throw new FlatError('lane truncated');
          x = (x << 8) | buf[o++];
        }
        const c = n[gi];
        const v2 = pp + (Math.imul((b << 16) - pp, RATE[c]) >> 16);
        p[gi] = v2 < 64 ? 64 : v2 > 65472 ? 65472 : v2;
        if (c < 255) n[gi] = c + 1;
        node = node << 1 | b;
      }
      const s = node - 32;
      sy[i] = s;
      let v;
      if (s === 0) { if (!hW) throw new FlatError('bad tile symbol'); v = W; }
      else if (s === 1) { if (!hN) throw new FlatError('bad tile symbol'); v = N; }
      else if (s === 2) { if (!hNE) throw new FlatError('bad tile symbol'); v = NE; }
      else if (s === 3) { if (!hNW) throw new FlatError('bad tile symbol'); v = NW; }
      else if (s === 4) {
        l.x = x; l.o = o;
        v = decodeColour(l, hW ? W : hN ? N : 0xffffffff, P.TB_ESC0, P.TB_ESC1, P.TB_ESC2, P.TB_EA, alpha);
        x = l.x; o = l.o;
        if (npal < PALMAX) pal[npal++] = v;
      } else {
        if (s - 5 >= npal) throw new FlatError('bad palette index');
        v = pal[s - 5];
      }
      out[i] = v;
    }
    l.x = x; l.o = o;
  }

  // surface: Surface; surfaces: Map key -> Surface (reference modes); rect: {x, y, w, h} device px (x, y multiples of 16);
  // bytes: the codec-1 section body. Returns {photoTiles}: 1 per tile of the rect (row major) marked photo.
  apply(surface, surfaces, rect, bytes) {
    const { x: rx, y: ry, w: rw, h: rh } = rect;
    if (!(rw > 0 && rh > 0) || rx < 0 || ry < 0 || rx % TS || ry % TS || rx + rw > surface.w || ry + rh > surface.h) throw new FlatError('bad rect');
    const tw = Math.ceil(rw / TS), th = Math.ceil(rh / TS), nt = tw * th;
    if (nt > MAX_TILES) throw new FlatError('rect too large');
    const end = bytes.length, o = { p: 0 };
    if (end < 1) throw new FlatError('empty section');
    const flags = bytes[o.p++];
    if (flags & ~7) throw new FlatError('bad flags');
    const alpha = (flags & 1) !== 0, refKind = (flags >> 1) & 3;
    if (refKind === 3) throw new FlatError('bad reference kind');
    let refSurf = null;
    if (refKind === 2) {
      const src = readVarint(bytes, o, end), layer = readVarint(bytes, o, end);
      refSurf = surfaces && surfaces.get(src * 4294967296 + layer);
      if (!refSurf) throw new FlatError('missing reference surface');
    }
    const BH = readVarint(bytes, o, end), LG = readVarint(bytes, o, end), nNew = readVarint(bytes, o, end), nRects = readVarint(bytes, o, end);
    if (BH < 1 || BH > 4096 || LG < 1 || LG > 4096 || nNew > nt || nRects > nt) throw new FlatError('bad header');
    const mask = new Uint8Array(nt);
    for (let i = 0; i < nRects; i++) {
      const tx = readVarint(bytes, o, end), ty = readVarint(bytes, o, end), w = readVarint(bytes, o, end), h = readVarint(bytes, o, end);
      if (w < 1 || h < 1 || tx + w > tw || ty + h > th) throw new FlatError('bad photo rect');
      for (let y = ty; y < ty + h; y++) mask.fill(1, y * tw + tx, y * tw + tx + w);
    }
    const nb = Math.ceil(th / BH), nl = Math.ceil(nNew / LG);
    const lens = [];
    let total = 0;
    for (let i = 0; i < nb + nl; i++) { const n = readVarint(bytes, o, end); lens.push(n); total += n; }
    if (o.p + total !== end) throw new FlatError('lane lengths do not match section size');
    let pos = o.p;
    const l = this.lane;

    // Library lanes first (layout references the new ids).
    const libBase = this.lib.length, newTiles = [];
    {
      let off = pos;
      for (let i = 0; i < nb; i++) off += lens[i];
      for (let g = 0; g < nl; g++) {
        const n = Math.min(LG, nNew - g * LG);
        l.start(bytes, off, off + lens[nb + g]);
        for (let k = 0; k < n; k++) { const t = new Uint32Array(256); this.decodeTile(l, t, alpha); newTiles.push(t); }
        l.finish();
        off += lens[nb + g];
      }
    }
    const tileOf = id => id < libBase ? this.lib[id] : newTiles[id - libBase];
    const idLimit = libBase + nNew;

    // Reference map under the rect, internal convention (-2 unknown, -1 uniform, >= 0 id).
    const stx = surface.tilesX || Math.ceil(surface.w / TS), ox = rx / TS, oy = ry / TS;
    const rlay = new Int32Array(nt).fill(-2), runi = new Uint32Array(nt);
    const oldLay = new Int32Array(nt), oldUni = new Uint32Array(nt);
    for (let ty = 0; ty < th; ty++) for (let tx = 0; tx < tw; tx++) {
      const v = surface.tileLay[(oy + ty) * stx + ox + tx];
      oldLay[ty * tw + tx] = v - 2; oldUni[ty * tw + tx] = surface.tileUni[(oy + ty) * stx + ox + tx];
    }
    if (refKind === 1) { rlay.set(oldLay); runi.set(oldUni); }
    else if (refKind === 2) {
      const rtx = refSurf.tilesX || Math.ceil(refSurf.w / TS), rty = refSurf.tilesY || Math.ceil(refSurf.h / TS);
      for (let ty = 0; ty < th; ty++) for (let tx = 0; tx < tw; tx++) {
        if (ox + tx >= rtx || oy + ty >= rty) continue;
        rlay[ty * tw + tx] = refSurf.tileLay[(oy + ty) * rtx + ox + tx] - 2;
        runi[ty * tw + tx] = refSurf.tileUni[(oy + ty) * rtx + ox + tx];
      }
    }
    for (let i = 0; i < nt; i++) if (oldLay[i] < -2) oldLay[i] = -2;

    // Layout lanes.
    const lay = new Int32Array(nt).fill(-2), uni = new Uint32Array(nt), mode = new Uint8Array(nt).fill(10);
    let next = libBase;
    const mru = new Uint32Array(4);
    const touch = c => { let k = 3; for (let j = 0; j < 4; j++) if (mru[j] === c) { k = j; break; } for (; k > 0; k--) mru[k] = mru[k - 1]; mru[0] = c; };
    for (let b = 0; b < nb; b++) {
      const ty0 = b * BH, ty1 = Math.min(th, ty0 + BH);
      let any = false;
      for (let i = ty0 * tw; i < ty1 * tw; i++) if (!mask[i]) { any = true; break; }
      if (!any) { if (lens[b] !== 0) throw new FlatError('unexpected layout lane'); pos += 0; continue; }
      if (lens[b] === 0) throw new FlatError('missing layout lane');
      l.start(bytes, pos, pos + lens[b]);
      pos += lens[b];
      for (let j = 0; j < 4; j++) mru[j] = MRU0[j];
      for (let ty = ty0; ty < ty1; ty++) for (let tx = 0; tx < tw; tx++) {
        const ti = ty * tw + tx;
        if (mask[ti]) continue;
        const top = ty === ty0;
        const lm = tx ? mode[ti - 1] : 10, um = top ? 10 : mode[ti - tw];
        const L = tx ? lay[ti - 1] : -2, U = top ? -2 : lay[ti - tw], C = rlay[ti], CU = runi[ti];
        const rc = C === -1 ? (CU === mru[0] ? 1 : (CU === mru[1] || CU === mru[2] || CU === mru[3]) ? 2 : 3) : C >= 0 ? 4 : 0;
        const m = l.sym(P.TB_MODE, (cls(lm) * 7 + cls(um)) * 5 + rc);
        if (m > 9) throw new FlatError('bad layout mode');
        mode[ti] = m;
        if (m < 4) { const c = mru[m]; touch(c); lay[ti] = -1; uni[ti] = c; }
        else if (m === 4) { const c = decodeColour(l, mru[0], P.TB_UESC0, P.TB_UESC1, P.TB_UESC2, P.TB_UA, alpha); touch(c); lay[ti] = -1; uni[ti] = c; }
        else if (m === 5) { if (next >= idLimit) throw new FlatError('library id overflow'); lay[ti] = next++; }
        else if (m === 6) { if (U < 0) throw new FlatError('bad copy'); lay[ti] = U; }
        else if (m === 7) { if (L < 0) throw new FlatError('bad copy'); lay[ti] = L; }
        else if (m === 8) {
          if (C < -1 || C >= idLimit) throw new FlatError('bad reference copy');
          lay[ti] = C;
          if (C === -1) { uni[ti] = CU; touch(CU); }
        } else {
          const id = l.num(P.TB_BKT);
          if (id >= idLimit) throw new FlatError('bad tile id');
          lay[ti] = id;
        }
      }
      l.finish();
    }
    if (next !== idLimit) throw new FlatError('library tiles unused');

    // Write pixels and tile maps. Every tile is written even when 'unchanged': the maps can be stale after a resize or an
    // unaligned copyBlock, and the id is all the encoder promises about the tile content.
    const px = px32(surface), sw = surface.w;
    const xLim = Math.min(surface.w, rx + rw), yLim = Math.min(surface.h, ry + rh);
    const tlay = surface.tileLay, tuni = surface.tileUni;
    for (let ty = 0; ty < th; ty++) for (let tx = 0; tx < tw; tx++) {
      const ti = ty * tw + tx, si = (oy + ty) * stx + ox + tx, id = lay[ti];
      if (id === -2) { tlay[si] = 0; tuni[si] = 0; continue; }
      tlay[si] = id + 2; tuni[si] = id === -1 ? uni[ti] : 0;
      const X = rx + tx * TS, Y = ry + ty * TS, cw = Math.min(TS, xLim - X), chh = Math.min(TS, yLim - Y);
      if (id === -1) {
        const c = uni[ti];
        for (let y = 0; y < chh; y++) { const r = (Y + y) * sw + X; px.fill(c, r, r + cw); }
      } else {
        const t = tileOf(id);
        for (let y = 0; y < chh; y++) { const r = (Y + y) * sw + X; if (cw === TS) px.set(t.subarray(y * TS, y * TS + TS), r); else for (let x = 0; x < cw; x++) px[r + x] = t[y * TS + x]; }
      }
    }
    for (const t of newTiles) this.lib.push(t);
    this.stats.tiles += nt; this.stats.newTiles += nNew; this.stats.bytes += end;
    return { photoTiles: mask };
  }
}
