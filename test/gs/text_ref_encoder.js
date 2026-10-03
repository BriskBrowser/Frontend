// Reference TEXT encoder in JS, test only. It drives the same codeBand() as the decoder (src/gs/text.js), so the
// C++ encoder (chromium/src/brisk_gpu/text/) must produce byte-identical bodies for the same BandIn. Mirrors the
// encoder-side policy documented in docs/gpu-stream-text.md section 6 (slots, symbols, quantum, outline conversion).
import {State, codeBand, gridMilli, roundDiv, LIMITS} from '../../src/gs/text.js';

const SYM_SHIFT = 2097152;
const PM = 1 << 15, LB = 23;

export class RansEncoder {
  constructor() { this.ps = []; this.bits = []; this.dec = false; }
  bit(p1, b) {
    if (p1 < 32) p1 = 32; else if (p1 > PM - 32) p1 = PM - 32;
    this.ps.push(p1); this.bits.push(b); return b;
  }
  finish() {
    let x = 1 << LB; const out = [];
    for (let i = this.bits.length - 1; i >= 0; i--) {
      const p1 = this.ps[i], b = this.bits[i], f = b ? p1 : PM - p1, start = b ? PM - p1 : 0;
      const xmax = (1 << 16) * f;
      while (x >= xmax) { out.push(x & 255); x >>>= 8; }
      x = Math.floor(x / f) * PM + (x % f) + start;
    }
    out.push(x & 255, (x >>> 8) & 255, (x >>> 16) & 255, (x >>> 24) & 255);
    out.reverse();
    return Uint8Array.from(out);
  }
}
const varint = v => { const o = []; while (v >= 128) { o.push((v & 127) | 128); v = Math.floor(v / 128); } o.push(v); return o; };
const bitlen = v => { let n = 0; while (v > 0) { n++; v = Math.floor(v / 2); } return n; };
export const sizeBucket = size64 => (bitlen(2 * size64 * size64) - 1) >> 1;
const r256 = v => Math.floor(v * 256 + 0.5);

// ---- outline -> grid contours (doubles in the same order as the C++)
function cubicToQuads(p0, c1, c2, p3, tol, out) {      // points are [x,y]; out gets {c, e}
  const dx = p3[0] - 3 * c2[0] + 3 * c1[0] - p0[0], dy = p3[1] - 3 * c2[1] + 3 * c1[1] - p0[1];
  const d = Math.sqrt(dx * dx + dy * dy) * (Math.sqrt(3) / 36);
  let n = 1; while (n < 16 && d / (n * n * n) > tol) n++;
  for (let i = 0; i < n; i++) {
    const t0 = i / n, t1 = (i + 1) / n;
    const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    // sub-cubic [t0, t1] by de Casteljau on the full cubic
    const split = (t) => { const a = lerp(p0, c1, t), b = lerp(c1, c2, t), c = lerp(c2, p3, t), ab = lerp(a, b, t), bc = lerp(b, c, t), m = lerp(ab, bc, t); return {a, b, c, ab, bc, m}; };
    const s0 = split(t0), s1 = split(t1);
    // control points of the sub-cubic: P0 = s0.m, P3 = s1.m, P1 = P0 + (t1-t0)*B'(t0)/3, P2 = P3 - (t1-t0)*B'(t1)/3
    const h = t1 - t0;
    const P0 = s0.m, P3 = s1.m;
    const P1 = [P0[0] + h * (s0.bc[0] - s0.ab[0]), P0[1] + h * (s0.bc[1] - s0.ab[1])];
    const P2 = [P3[0] - h * (s1.bc[0] - s1.ab[0]), P3[1] - h * (s1.bc[1] - s1.ab[1])];
    out.push({c: [(3 * (P1[0] + P2[0]) - (P0[0] + P3[0])) / 4, (3 * (P1[1] + P2[1]) - (P0[1] + P3[1])) / 4], e: i === n - 1 ? p3 : P3});
  }
}
export function outlineIsBlank(o) {      // no verb beyond Move/Close
  return !o.verbs.some(v => v === 1 || v === 2 || v === 3);
}
// -> {eo, contours:[{x,y,on}]} in grid ints at master size msize64, or null when not representable
export function outlineToShape(o, msize64) {
  const gm = gridMilli(msize64), tol = 0.25;
  for (const v of o.pts) if (!Number.isFinite(v)) return null;
  const G = (x, y) => [x * 1000 / gm, y * 1000 / gm];
  const contours = []; let cur = null, pi = 0;
  const pt = () => { const p = G(o.pts[pi], o.pts[pi + 1]); pi += 2; return p; };
  let last = null;
  for (const v of o.verbs) {
    if (v === 0) { const p = pt(); cur = {start: p, segs: []}; contours.push(cur); last = p; }
    else if (v === 1) { if (!cur) return null; const e = pt(); cur.segs.push({v: 'L', e}); last = e; }
    else if (v === 2) { if (!cur) return null; const c = pt(), e = pt(); cur.segs.push({v: 'Q', c, e}); last = e; }
    else if (v === 3) { if (!cur) return null; const c1 = pt(), c2 = pt(), e = pt(); const qs = []; cubicToQuads(last, c1, c2, e, tol, qs); for (const s of qs) cur.segs.push({v: 'Q', c: s.c, e: s.e}); last = e; }
    else if (v === 4) { cur = null; }
    else return null;
  }
  const near = (a, b, t) => Math.abs(a[0] - b[0]) <= t && Math.abs(a[1] - b[1]) <= t;
  const q = v => Math.floor(v + 0.5);
  const out = [];
  for (const c of contours) {
    const segs = c.segs.slice();
    if (segs.length && segs[segs.length - 1].v === 'L' && near(segs[segs.length - 1].e, c.start, 0.15)) segs.pop();
    const pts = [{x: q(c.start[0]), y: q(c.start[1]), on: 1}];
    for (let k = 0; k < segs.length; k++) {
      const s = segs[k];
      if (s.v === 'L') { pts.push({x: q(s.e[0]), y: q(s.e[1]), on: 1}); continue; }
      pts.push({x: q(s.c[0]), y: q(s.c[1]), on: 0});
      const nx = segs[k + 1], lastSeg = k === segs.length - 1; let implied = false;
      if (nx && nx.v === 'Q') implied = near(s.e, [(s.c[0] + nx.c[0]) / 2, (s.c[1] + nx.c[1]) / 2], 0.3);
      else if (lastSeg) implied = near(s.e, c.start, 0.3);
      if (!implied) pts.push({x: q(s.e[0]), y: q(s.e[1]), on: 1});
    }
    if (pts.length < 2) continue;
    out.push({x: pts.map(p => p.x), y: pts.map(p => p.y), on: pts.map(p => p.on)});
  }
  if (!out.length || out.length > LIMITS.maxContours) return null;
  for (const c of out) { if (c.x.length > LIMITS.maxPoints) return null; for (let i = 0; i < c.x.length; i++) if (Math.abs(c.x[i]) > LIMITS.maxCoord || Math.abs(c.y[i]) > LIMITS.maxCoord) return null; }
  return {eo: o.even_odd ? 1 : 0, contours: out};
}

export class RefEncoder {
  constructor() {
    this.S = new State();
    this.slots = new Map(); this.fonts = new Map(); this.glyphs = new Map(); this.symUsed = new Set(); this.cipher = 0;
  }
  reset() { this.constructor.call(this); }
  validSym(ch) { return ch >= 0x21 && ch <= 0x10FFFF && !(ch >= 0xD800 && ch <= 0xDFFF); }
  cipherSym(slot) {
    for (;;) {
      const k = this.cipher++, sym = k < 6400 ? 0xE000 + k : 0xF0000 + (k - 6400);
      if (k > 6400 + 65000) throw new Error('state full');
      if (!this.symUsed.has(slot * SYM_SHIFT + sym)) return sym;
    }
  }
  // in: {runs:[{face,size,fill,y,glyphs:[{glyph_id,ch,x}]}], outlines:(face,glyph,size)->{verbs,pts,even_odd}|null, cssScale}
  encodeBand(inp) {
    const S = this.S, runs = inp.runs;
    // pass 1: quantise inputs, fetch outlines for unknown glyphs, find ink
    const cache = new Map(), items = [];
    runs.forEach((r, idx) => {
      if (!(r.size > 0) || !Number.isFinite(r.y)) throw new Error('bad input');
      const size64 = Math.floor(r.size * 64 + 0.5); if (size64 < 1 || size64 > LIMITS.maxSize64) throw new Error('bad size');
      const bucket = sizeBucket(size64), slotKey = r.face + ':' + bucket;
      const sid = this.slots.get(slotKey);
      const ink = [], sp = [];
      let pendingSp = false, haveInk = false;
      for (const g of r.glyphs) {
        if (!Number.isFinite(g.x)) throw new Error('bad input');
        const known = sid !== undefined ? this.glyphs.get(sid + ':' + g.glyph_id) : undefined;
        let blank;
        if (known !== undefined) blank = known === -1;
        else {
          const ck = slotKey + ':' + g.glyph_id; let e = cache.get(ck);
          if (!e) { const o = inp.outlines(r.face, g.glyph_id, r.size); if (!o) throw new Error('no outline'); e = {o, blank: outlineIsBlank(o)}; cache.set(ck, e); }
          blank = e.blank;
        }
        if (blank) { if (haveInk) pendingSp = true; continue; }
        if (pendingSp) sp[sp.length - 1] = true;
        pendingSp = false; haveInk = true;
        ink.push(g); sp.push(false);
      }
      if (ink.length) items.push({r, idx, size64, bucket, slotKey, ink, sp, y_u: r256(r.y)});
    });
    if (!items.length) return {body: new Uint8Array(0), order: [], recon: {y: [], x: []}};
    // quantum
    const allU = v => items.every(it => Math.abs(it.y_u - Math.floor(it.y_u / v + 0.5) * v) <= 3 &&
      it.ink.every(g => { const x = r256(g.x); return Math.abs(x - Math.floor(x / v + 0.5) * v) <= 3; }));
    let q, lattice = false;
    if (allU(256)) { q = 256; lattice = true; } else if (allU(128)) { q = 128; lattice = true; }
    else q = Math.max(1, Math.floor(64 / inp.cssScale + 0.5));
    for (const it of items) { it.yq = roundDiv(it.y_u, q); it.x0 = r256(it.ink[0].x); }
    items.sort((a, b) => a.yq - b.yq || a.x0 - b.x0 || a.idx - b.idx);
    // pass 2: allocate slots / fonts / symbols / masters in coded order
    const newSlots = new Map(), newFonts = new Map(), newGlyphs = new Map(), newSym = new Set(), fontInfos = [], shapes = new Map();
    let nfaces = S.nfaces, nfonts = S.nfonts, cipher = this.cipher;
    const coded = [];
    for (const it of items) {
      const fk = it.slotKey + ':' + it.size64;
      let font = this.fonts.get(fk) ?? newFonts.get(fk);
      let slot = this.slots.get(it.slotKey) ?? newSlots.get(it.slotKey);
      if (font === undefined) {
        if (slot === undefined) { slot = nfaces++; newSlots.set(it.slotKey, slot); }
        font = nfonts++; newFonts.set(fk, font); fontInfos[font] = {slot, size64: it.size64};
      }
      const glyphs = [];
      const resolve = (g) => {
        const gk = slot + ':' + g.glyph_id;
        let sym = this.glyphs.get(gk) ?? newGlyphs.get(gk);
        if (sym !== undefined) return sym;
        const ck = it.slotKey + ':' + g.glyph_id, e = cache.get(ck);
        if (g.ch && this.validSym(g.ch) && !this.symUsed.has(slot * SYM_SHIFT + g.ch) && !newSym.has(slot * SYM_SHIFT + g.ch)) sym = g.ch;
        else {
          for (;;) {
            const k = cipher++; if (k > 6400 + 65000) throw new Error('state full');
            sym = k < 6400 ? 0xE000 + k : 0xF0000 + (k - 6400);
            if (!this.symUsed.has(slot * SYM_SHIFT + sym) && !newSym.has(slot * SYM_SHIFT + sym)) break;
          }
        }
        const sh = outlineToShape(e.o, it.size64); if (!sh) throw new Error('bad outline');
        newGlyphs.set(gk, sym); newSym.add(slot * SYM_SHIFT + sym); shapes.set(slot * SYM_SHIFT + sym, sh);
        return sym;
      };
      it.ink.forEach((g, i) => glyphs.push({sym: resolve(g), x: r256(g.x), sp: it.sp[i]}));
      // blank glyphs of the run are remembered as blank in this slot
      for (const g of it.r.glyphs) { const gk = slot + ':' + g.glyph_id; if (!this.glyphs.has(gk) && !newGlyphs.has(gk) && cache.get(it.slotKey + ':' + g.glyph_id)?.blank) newGlyphs.set(gk, -1); }
      coded.push({font, fill: it.r.fill >>> 0, yq: it.yq, x0: it.x0, glyphs});
    }
    // encode
    const hooks = {fontInfo: id => fontInfos[id], shapeFor: (slot, sym) => shapes.get(slot * SYM_SHIFT + sym)};
    const cd = new RansEncoder();
    S.begin(); S.q = q; S.lattice = lattice;
    let recon;
    try { codeBand(cd, S, {runs: coded}, hooks); S.commit(); } catch (e) { S.rollback(); throw e; }
    for (const [k, v] of newSlots) this.slots.set(k, v);
    for (const [k, v] of newFonts) this.fonts.set(k, v);
    for (const [k, v] of newGlyphs) this.glyphs.set(k, v);
    for (const k of newSym) this.symUsed.add(k);
    this.cipher = cipher;
    const rans = cd.finish();
    const body = Uint8Array.from([...varint(q), lattice ? 1 : 0, ...rans]);
    return {body, order: items.map(it => it.idx), q, lattice};
  }
}
