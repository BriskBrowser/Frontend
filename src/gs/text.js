// GPU stream TEXT decoder (wire kind 2). Normative bit-level reference: docs/gpu-stream-text.md in the main repo.
//
// Pure ES module: no DOM access at import (Path2D is touched only inside drawRuns), so it runs in Node tests and in
// a Worker. The service-side encoder (chromium/src/brisk_gpu/text/) is a C++ port of codeBand() below and must stay
// bit-identical; test/gs/text_ref_encoder.js drives the same codeBand() as an encoder for cross-checks.
//
// Everything that influences a probability is integer arithmetic (Math.imul, shifts, integer tables), never
// Math.exp/log/round on doubles. Positions are integers in "u" = 1/256 CSS px.
//
//   const dec = new TextDecoder2();
//   const runs = dec.decodeBand(bytes);   // one (layer, band) full run set, [] for an empty body
//   drawRuns(ctx, runs, scale, ox, oy);

// ---------------------------------------------------------------------------------------------------------------
// limits (shared with the encoder; see doc section 7)
export const LIMITS = Object.freeze({
  maxBody: 16 << 20, maxRuns: 1 << 16, maxRunGlyphs: 1 << 16, maxBandGlyphs: 1 << 20, maxContours: 512,
  maxPoints: 8192, maxCoord: 1 << 15, maxFonts: 4096, maxFaces: 2048, maxMasters: 1 << 16, maxFills: 256,
  maxSize64: 32767, maxHist: 32 << 20, maxQuantum: 1 << 16,
});
const SYM_SHIFT = 2097152;               // 2^21: (slot|font) * SYM_SHIFT + sym is the table key
const TEXT_BITS = 18;                    // 2^18 entries per hashed text context table

// ---------------------------------------------------------------------------------------------------------------
// integer helpers
const floorDiv = (a, d) => {            // d > 0, integers up to 2^53
  if (a > -2147483648 && a < 2147483648) return Math.floor(a / d);
  const r = ((a % d) + d) % d; return (a - r) / d;
};
export const roundDiv = (a, d) => floorDiv(2 * a + d, 2 * d);   // round half up, like Math.round(a / d)
export const gridMilli = msize64 => Math.max(100, (msize64 * 25) >> 8);   // grid unit in 1/1000 CSS px at master size

// ---------------------------------------------------------------------------------------------------------------
// rANS decoder: 32-bit state, 15-bit probabilities, lower bound 2^23, byte renormalisation (same primitive as the
// flat coder's adapt.js Dec; probabilities clamped to [32, 32736]).
const PB = 15, PM = 1 << PB, LB = 23;
export class RansDecoder {
  constructor(buf, off = 0, end = buf.length) {
    if (end - off < 4) throw new Error('text: truncated rANS stream');
    this.b = buf; this.o = off + 4; this.end = end; this.dec = true;
    this.x = ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0;
  }
  bit(p1) {
    if (p1 < 32) p1 = 32; else if (p1 > PM - 32) p1 = PM - 32;
    const cum = this.x & (PM - 1), b = cum >= PM - p1 ? 1 : 0, f = b ? p1 : PM - p1, start = b ? PM - p1 : 0;
    this.x = f * (this.x >>> PB) + cum - start;
    while (this.x < (1 << LB)) {
      if (this.o >= this.end) throw new Error('text: truncated rANS stream');
      this.x = ((this.x << 8) | this.b[this.o++]) >>> 0;
    }
    return b;
  }
  // A complete stream leaves the state at its initial value with every byte consumed.
  check() { if (this.x !== (1 << LB) || this.o !== this.end) throw new Error('text: corrupt or truncated rANS stream'); }
}

// ---------------------------------------------------------------------------------------------------------------
// transactional adaptive state. All big arrays save a block the first time a transaction touches it.
const BSH = 8, BLK = 1 << BSH;
const SQ = [1, 2, 3, 6, 10, 16, 27, 45, 73, 120, 194, 310, 488, 747, 1101, 1546, 2047, 2549, 2994, 3348, 3607, 3785, 3901, 3975, 4022, 4050, 4068, 4079, 4085, 4089, 4092, 4093, 4094];
function squash(d) { if (d > 2047) return 4095; if (d < -2047) return 1; const w = d & 127, i = (d >> 7) + 16; return (SQ[i] * (128 - w) + SQ[i + 1] * w + 64) >> 7; }
const STRETCH = new Int16Array(4096);
{ let pi = 0; for (let x = -2047; x <= 2047; x++) { const v = squash(x); for (let i = pi; i <= v; i++) STRETCH[i] = x; pi = v + 1; } for (let i = pi; i < 4096; i++) STRETCH[i] = 2047; }
const stretch = p12 => STRETCH[p12];

// p += (bit - p) / (n + 1.5) until the rate floor 2^-5, as flat-coder/adapt.js
const RATE = new Int32Array(256);
for (let i = 0; i < 256; i++) RATE[i] = Math.max(Math.round(65536 / (i + 1.5)), 65536 >> 5);

class Probs {
  constructor(n) {
    this.len = n; this.p = new Uint16Array(n).fill(32768); this.n = new Uint8Array(n);
    this.d = new Uint8Array((n + BLK - 1) >> BSH); this.sv = [];
  }
  p15(i) { const q = this.p[i] >> 1; return q < 32 ? 32 : q > 32736 ? 32736 : q; }
  upd(i, b) {
    const k = i >> BSH; if (!this.d[k]) this.save(k);
    const n = this.n[i], r = RATE[n]; const p = this.p[i] + ((((b << 16) - this.p[i]) * r) >> 16);
    this.p[i] = p < 64 ? 64 : p > 65472 ? 65472 : p; if (n < 255) this.n[i] = n + 1;
  }
  save(k) { this.d[k] = 1; const s = k << BSH, e = Math.min(s + BLK, this.len); this.sv.push(k, this.p.slice(s, e), this.n.slice(s, e)); }
  code(cd, i, b) { const bit = cd.bit(this.p15(i), b); this.upd(i, bit); return bit; }
  commit() { for (let j = 0; j < this.sv.length; j += 3) this.d[this.sv[j]] = 0; this.sv.length = 0; }
  rollback() {
    for (let j = 0; j < this.sv.length; j += 3) { const k = this.sv[j], s = k << BSH; this.p.set(this.sv[j + 1], s); this.n.set(this.sv[j + 2], s); this.d[k] = 0; }
    this.sv.length = 0;
  }
}

// Exp-Golomb integers under adaptive contexts occupying Probs[base .. base+48).
function codeUInt(cd, P, base, v) {      // v >= 0
  let nb = 0; if (!cd.dec) nb = 31 - Math.clz32(v + 1);
  let k = 0;
  for (;;) {
    const more = P.code(cd, base + Math.min(k, 15), cd.dec ? 0 : +(k < nb)); if (!more) break;
    if (++k > 30) throw new Error('text: integer overflow');
  }
  nb = k; let t = 1;
  for (let j = nb - 1; j >= 0; j--) {
    const idx = j === nb - 1 ? base + 16 + Math.min(nb, 15) : base + 32 + Math.min(j, 15);
    const b = P.code(cd, idx, cd.dec ? 0 : ((v + 1) >> j) & 1); t = t * 2 + b;
  }
  return t - 1;
}
function codeSInt(cd, P, base, v) {      // base .. base+66
  const z = P.code(cd, base + 64, cd.dec ? 0 : +(v === 0)); if (z) return 0;
  const neg = P.code(cd, base + 65, cd.dec ? 0 : +(v < 0));
  const m = codeUInt(cd, P, base, cd.dec ? 0 : Math.abs(v) - 1) + 1; return neg ? -m : m;
}

class Mixer {
  constructor(K, nsel, lrShift, init) {
    this.K = K; this.w = new Int32Array(K * nsel).fill(init); this.lr = lrShift; this.st = new Int32Array(K); this.o = 0; this.p = 2048;
    this.d = new Uint8Array(nsel); this.sv = [];
  }
  mix(sel) {
    this.o = sel * this.K; let s = 0; for (let i = 0; i < this.K; i++) s += this.w[this.o + i] * this.st[i];
    let d = Math.trunc(s / 65536); if (d > 2047) d = 2047; else if (d < -2047) d = -2047; return (this.p = squash(d));
  }
  update(b) {
    const sel = this.o / this.K; if (!this.d[sel]) { this.d[sel] = 1; this.sv.push(sel, this.w.slice(this.o, this.o + this.K)); }
    const err = (b << 12) - this.p;
    for (let i = 0; i < this.K; i++) this.w[this.o + i] += (this.st[i] * err) >> this.lr;
  }
  commit() { for (let j = 0; j < this.sv.length; j += 2) this.d[this.sv[j]] = 0; this.sv.length = 0; }
  rollback() { for (let j = 0; j < this.sv.length; j += 2) { this.w.set(this.sv[j + 1], this.sv[j] * this.K); this.d[this.sv[j]] = 0; } this.sv.length = 0; }
}

// Byte-oriented CM text model: orders 1-6 + two word contexts + order-0 + match model, two mixers.
class TextModel {
  constructor() {
    const bits = TEXT_BITS, K = 8;
    this.mask = (1 << bits) - 1; this.K = K; this.mmBits = 20;
    this.ht = new Int32Array(1 << this.mmBits).fill(-1); this.htd = new Uint8Array(1 << (this.mmBits - 10)); this.htsv = [];
    this.ptr = -1; this.len = 0; this.mmP = new Probs(128);
    this.tabs = []; for (let i = 0; i < K; i++) this.tabs.push(new Probs(1 << bits));
    this.o0 = new Probs(256);
    this.mx = new Mixer(K + 3, 256, 10, 16384); this.mx2 = new Mixer(K + 3, 1024, 10, 16384);
    this.h = new Int32Array(K); this.idx = new Int32Array(K);
    this.hist = new Uint8Array(1 << 16); this.hn = 0; this.word = 0; this.pword = 0; this.sc = null;
  }
  parts() { return [...this.tabs, this.o0, this.mmP, this.mx, this.mx2]; }
  begin() { this.sc = [this.ptr, this.len, this.word, this.pword, this.hn]; }
  commit() { for (const p of this.parts()) p.commit(); for (let j = 0; j < this.htsv.length; j += 2) this.htd[this.htsv[j]] = 0; this.htsv.length = 0; }
  rollback() {
    for (const p of this.parts()) p.rollback();
    for (let j = 0; j < this.htsv.length; j += 2) { this.ht.set(this.htsv[j + 1], this.htsv[j] << 10); this.htd[this.htsv[j]] = 0; }
    this.htsv.length = 0;
    [this.ptr, this.len, this.word, this.pword, this.hn] = this.sc;
  }
  ctxs() {
    const H = this.hist, n = this.hn, g = k => (n >= k ? H[n - k] : 0), hs = this.h;
    let h = Math.imul(g(1) + 1, 0x2F0B4A27); hs[0] = h;
    h = Math.imul(h ^ (g(2) + 1), 0x6A09E667); hs[1] = h;
    h = Math.imul(h ^ (g(3) + 1), 0x3C6EF372); hs[2] = h;
    h = Math.imul(h ^ (g(4) + 1), 0x510E527F); hs[3] = h;
    h = Math.imul(h ^ (g(5) + 1), 0x1F83D9AB); hs[4] = h;
    h = Math.imul(h ^ (g(6) + 1), 0x5BE0CD19); hs[5] = h;
    hs[6] = Math.imul(this.word + 7, 0x9E3779B1);
    hs[7] = Math.imul(this.word ^ Math.imul(this.pword + 3, 0x85EBCA6B), 0xC2B2AE35);
  }
  push(c) {
    if (this.hn >= LIMITS.maxHist) throw new Error('text: history limit');
    if (this.hn === this.hist.length) { const nh = new Uint8Array(this.hist.length * 2); nh.set(this.hist); this.hist = nh; }
    const H = this.hist;
    if (this.ptr >= 0 && H[this.ptr] === c) { this.len++; this.ptr++; } else { this.len = 0; this.ptr = -1; }
    H[this.hn++] = c;
    if (this.hn >= 5) {
      let h = 0; for (let k = 1; k <= 5; k++) h = (Math.imul(h ^ (H[this.hn - k] + 1), 0x2F0B4A27) + k) | 0;
      h = (h >>> 8) & ((1 << this.mmBits) - 1);
      if (this.ptr < 0) { const q = this.ht[h]; if (q >= 0) { this.ptr = q; this.len = 1; } }
      const blk = h >> 10; if (!this.htd[blk]) { this.htd[blk] = 1; this.htsv.push(blk, this.ht.slice(blk << 10, (blk + 1) << 10)); }
      this.ht[h] = this.hn;
    }
    const L = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c >= 128 || (c >= 48 && c <= 57);
    if (L) this.word = (Math.imul(this.word, 0x2F0B4A27) + c + 1) | 0; else if (this.word !== 0) { this.pword = this.word; this.word = 0; }
  }
  code(cd, byte) {
    this.ctxs(); const mx = this.mx, mx2 = this.mx2, mask = this.mask, K = this.K;
    let c0 = 1;
    for (let b = 7; b >= 0; b--) {
      for (let i = 0; i < K; i++) {
        const j = ((this.h[i] + Math.imul(c0, 0x9E3779B1)) >>> 7) & mask; this.idx[i] = j;
        const T = this.tabs[i]; const v = T.n[j] === 0 ? 0 : stretch(T.p[j] >> 4);
        mx.st[i] = v; mx2.st[i] = v;
      }
      const v0 = stretch(this.o0.p[c0] >> 4); mx.st[K] = v0; mx2.st[K] = v0; mx.st[K + 1] = 256; mx2.st[K + 1] = 256;
      let mi = 0, expect = -1, lenb = 0;
      if (this.ptr >= 0 && this.ptr < this.hn) {
        const eb = this.hist[this.ptr] | 256;
        if ((eb >> (b + 1)) === c0) { expect = (eb >> b) & 1; lenb = Math.min(this.len, 31); const st = stretch(this.mmP.p[lenb * 2] >> 4); mi = expect ? st : -st; }
      }
      mx.st[K + 2] = mi; mx2.st[K + 2] = mi;
      const mctx = expect < 0 ? 0 : this.len < 8 ? 1 : this.len < 24 ? 2 : 3;
      const pa = mx.mix(c0), pb = mx2.mix(c0 * 4 + mctx);
      let p12 = (pa + pb + 1) >> 1; if (p12 < 4) p12 = 4; else if (p12 > 4092) p12 = 4092;
      const bit = cd.bit(p12 << 3, cd.dec ? 0 : (byte >> b) & 1);
      mx.update(bit); mx2.update(bit); this.o0.upd(c0, bit); if (expect >= 0) this.mmP.upd(lenb * 2, +(bit === expect));
      for (let i = 0; i < K; i++) this.tabs[i].upd(this.idx[i], bit);
      c0 = c0 * 2 + bit;
    }
    const out = c0 & 255; this.push(out); return out;
  }
}

// Map with an undo log: set() of a new key is undone by deletion, mod() snapshots the entry before it is mutated.
class TxMap {
  constructor() { this.m = new Map(); this.ins = []; this.old = new Map(); this.insSet = new Set(); }
  get(k) { return this.m.get(k); }
  has(k) { return this.m.has(k); }
  set(k, v) { this.m.set(k, v); this.ins.push(k); this.insSet.add(k); }
  mod(k) {
    const e = this.m.get(k);
    if (e !== undefined && !this.insSet.has(k) && !this.old.has(k)) this.old.set(k, {...e});
    return e;
  }
  get size() { return this.m.size; }
  commit() { this.ins.length = 0; this.insSet.clear(); this.old.clear(); }
  rollback() {
    for (const k of this.ins) this.m.delete(k);
    for (const [k, v] of this.old) this.m.set(k, v);
    this.commit();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// glyph outline coder: TrueType form (on/off-curve points, implied midpoints, implied closing line), grid integers.
const PAT = (pprevOn, prevOn, curOn) => (pprevOn << 2) | (prevOn << 1) | curOn;
function codeRes(cd, P, base, pat, v, axis, zOther) {
  const E = !cd.dec, zc = base + (pat * 2 + axis) * 3 + zOther;
  const zero = P.code(cd, zc, E ? +(v === 0) : 0); if (zero) return 0;
  const neg = P.code(cd, base + 60 + pat * 2 + axis, E ? +(v < 0) : 0);
  const m = codeUInt(cd, P, base + 80 + (pat * 2 + axis) * 66, E ? Math.abs(v) - 1 : 0) + 1;
  return neg ? -m : m;
}
const inCoord = v => v >= -LIMITS.maxCoord && v <= LIMITS.maxCoord;
// shape: {eo, contours:[{x:[],y:[],on:[]}]} (encoder) or null (decoder). Returns the shape.
function codeShape(cd, P, shape) {
  const E = !cd.dec, contours = [];
  const eo = P.code(cd, 3000, E ? shape.eo : 0);
  const nC = codeUInt(cd, P, 0, E ? shape.contours.length - 1 : 0) + 1;
  if (nC > LIMITS.maxContours) throw new Error('text: too many contours');
  let psx = 0, psy = 0;
  for (let ci = 0; ci < nC; ci++) {
    const c = E ? shape.contours[ci] : null;
    const n = codeUInt(cd, P, 70 + (ci === 0 ? 0 : 70), E ? c.x.length - 1 : 0) + 1;
    if (n > LIMITS.maxPoints) throw new Error('text: too many points');
    const sx = codeSInt(cd, P, 300 + (ci ? 70 : 0), E ? c.x[0] - psx : 0);
    const sy = codeSInt(cd, P, 500 + (ci ? 70 : 0), E ? c.y[0] - psy : 0);
    const X = [psx + sx], Y = [psy + sy], ON = [1]; psx = X[0]; psy = Y[0];
    if (!inCoord(psx) || !inCoord(psy)) throw new Error('text: coordinate range');
    for (let i = 1; i < n; i++) {
      const pvOn = ON[i - 1], ppOn = i >= 2 ? ON[i - 2] : 1, flagCtx = 700 + ((ppOn << 1 | pvOn) * 2 + (i === 1 ? 1 : 0)) + (n - i <= 2 ? 8 : 0);
      const on = P.code(cd, flagCtx, E ? c.on[i] : 0);
      const pat = PAT(ppOn, pvOn, on);
      let px = X[i - 1], py = Y[i - 1];
      if (i >= 2 && !on && !pvOn) { px += X[i - 1] - X[i - 2]; py += Y[i - 1] - Y[i - 2]; }   // off after off: extrapolate
      const rx = codeRes(cd, P, 1000, pat, E ? c.x[i] - px : 0, 0, 2);
      const ry = codeRes(cd, P, 1000, pat, E ? c.y[i] - py : 0, 1, rx === 0 ? 1 : 0);
      X.push(px + rx); Y.push(py + ry); ON.push(on);
      if (!inCoord(px + rx) || !inCoord(py + ry)) throw new Error('text: coordinate range');
    }
    contours.push({x: X, y: Y, on: ON});
  }
  return {eo, contours};
}

// ---------------------------------------------------------------------------------------------------------------
// codec state (stream-global, append-only apart from the adaptive probabilities and the MRU lists)
export class State {
  constructor() {
    this.text = new TextModel();
    this.H = new Probs(4096); this.R = new Probs(8192);
    this.pair = new Probs(1 << 14); this.ctx2 = new Probs(64); this.zmix = new Mixer(3, 4, 10, 26214);
    this.byteP = new Probs(512); this.shapeP = new Probs(1 << 15);
    this.nfonts = 0; this.fontMru = []; this.fills = []; this.nfaces = 0; this.fontInfo = [];
    this.masters = new TxMap(); this.xm = new TxMap(); this.adv = new TxMap(); this.spAdv = new TxMap();
    this.prev = null; this.lastDy = 0; this.ls = []; this.lastR = 0; this.q = 1; this.lattice = false; this.sc = null;
  }
  probs() { return [this.H, this.R, this.pair, this.ctx2, this.zmix, this.byteP, this.shapeP]; }
  maps() { return [this.masters, this.xm, this.adv, this.spAdv]; }
  begin() {
    this.text.begin();
    this.sc = {nfonts: this.nfonts, nfaces: this.nfaces, nfi: this.fontInfo.length, fontMru: this.fontMru.slice(), fills: this.fills.slice()};
  }
  commit() { this.text.commit(); for (const p of this.probs()) p.commit(); for (const m of this.maps()) m.commit(); this.sc = null; }
  rollback() {
    this.text.rollback(); for (const p of this.probs()) p.rollback(); for (const m of this.maps()) m.rollback();
    const s = this.sc; this.nfonts = s.nfonts; this.nfaces = s.nfaces; this.fontInfo.length = s.nfi; this.fontMru = s.fontMru; this.fills = s.fills; this.sc = null;
  }
  nearlyFull() {
    return this.text.hn > (LIMITS.maxHist >> 2) * 3 || this.masters.size > (LIMITS.maxMasters >> 2) * 3 || this.nfonts > (LIMITS.maxFonts >> 2) * 3 || this.nfaces > (LIMITS.maxFaces >> 2) * 3;
  }
}

const hashPair = (a, b) => (Math.imul(a + 1, 0x2F0B4A27) ^ Math.imul(b + 7, 0x6A09E667)) >>> 18;   // 14 bits

function codeFill(cd, S, fill) {            // fill: u32 r<<24|g<<16|b<<8|a
  const E = !cd.dec, mru = S.fills; const pos = E ? mru.indexOf(fill) : 0;
  const same = mru.length > 0 ? S.H.code(cd, 1, E ? +(pos === 0) : 0) : 0;
  let out;
  if (same) out = mru[0];
  else {
    const isNew = mru.length === 0 ? 1 : S.H.code(cd, 3, E ? +(pos < 0) : 0);
    if (isNew) {
      const long = S.H.code(cd, 2, E ? +((fill & 255) !== 255) : 0), nb = long ? 4 : 3; let v = 0;
      for (let i = 0; i < nb; i++) {
        const byte = E ? (fill >>> (24 - 8 * i)) & 255 : 0; let node = 1;
        for (let b = 7; b >= 0; b--) { const bit = S.byteP.code(cd, (i === 3 ? 256 : 0) + node, (byte >> b) & 1); node = node * 2 + bit; }
        v = v * 256 + (node & 255);
      }
      out = long ? v : v * 256 + 255;
    } else { const k = codeUInt(cd, S.H, 100, E ? pos - 1 : 0); if (k + 1 >= mru.length) throw new Error('text: bad fill index'); out = mru[k + 1]; }
  }
  const at = mru.indexOf(out); if (at >= 0) mru.splice(at, 1); mru.unshift(out); if (mru.length > LIMITS.maxFills) mru.pop();
  return out;
}
function codeFace(cd, S, fontId, hooks) {
  const E = !cd.dec, fi = E ? hooks.fontInfo(fontId) : null;
  const newFace = S.nfaces === 0 ? 1 : S.H.code(cd, 6, E ? +(fi.slot === S.nfaces) : 0);
  let slot;
  if (newFace) { if (S.nfaces >= LIMITS.maxFaces) throw new Error('text: face table full'); slot = S.nfaces++; }
  else { slot = codeUInt(cd, S.H, 900, E ? fi.slot : 0); if (slot >= S.nfaces) throw new Error('text: unknown face'); }
  const size64 = codeUInt(cd, S.H, 1000, E ? fi.size64 - 1 : 0) + 1;
  if (size64 > LIMITS.maxSize64) throw new Error('text: font size');
  S.fontInfo[fontId] = {slot, size64};
}
function codeFont(cd, S, font, hooks) {
  const E = !cd.dec, mru = S.fontMru; const pos = E ? mru.indexOf(font) : 0;
  const same = mru.length > 0 ? S.H.code(cd, 4, E ? +(pos === 0) : 0) : 0;
  let out;
  if (same) out = mru[0];
  else {
    const isNew = mru.length === 0 ? 1 : S.H.code(cd, 5, E ? +(pos < 0) : 0);
    if (isNew) { if (S.nfonts >= LIMITS.maxFonts) throw new Error('text: font table full'); out = S.nfonts++; codeFace(cd, S, out, hooks); }
    else { const k = codeUInt(cd, S.H, 200, E ? pos - 1 : 0); if (k + 1 >= mru.length) throw new Error('text: unknown font'); out = mru[k + 1]; }
  }
  const at = mru.indexOf(out); if (at >= 0) mru.splice(at, 1); mru.unshift(out);
  return out;
}
function learn(map, key, obs, q) {          // running mean of reconstructed steps; outliers ignored once settled
  const e = map.mod(key);
  if (!e) { map.set(key, {v: obs, sum: obs, n: 1}); return; }
  if (e.n >= 3 && 2 * Math.abs(obs - e.v) > 3 * q) return;
  e.sum += obs; e.n++; e.v = roundDiv(e.sum, e.n);
}
export function utf8Len(sym) { return sym < 0x80 ? 1 : sym < 0x800 ? 2 : sym < 0x10000 ? 3 : 4; }

// Code one run. Encoder passes `run` = {font, fill, yq, x0, glyphs:[{sym, x, sp}]}; decoder passes null.
function codeRun(cd, S, run, hooks) {
  const E = !cd.dec, q = S.q, P = S.prev;
  let yq, newLine = true;
  if (!P) yq = codeSInt(cd, S.H, 300, E ? run.yq : 0);
  else {
    const dyq = E ? run.yq - P.yq : 0;
    const zero = S.H.code(cd, 10 + (P.dyZero ? 1 : 0), E ? +(dyq === 0) : 0);
    let d = 0;
    if (!zero) {
      const same = S.lastDy > 0 ? S.H.code(cd, 12, E ? +(dyq === S.lastDy) : 0) : 0;
      d = same ? S.lastDy : codeUInt(cd, S.H, 400, E ? dyq - 1 : 0) + 1; S.lastDy = d;
    }
    yq = P.yq + d; newLine = !zero;
  }
  const y = yq * q;
  const font = codeFont(cd, S, E ? run.font : 0, hooks);
  const fill = codeFill(cd, S, E ? run.fill : 0);
  const rl = v => (S.lattice ? roundDiv(v, q) * q : v);
  let x0, isLineStart = true;
  const xd = E ? run.x0 : 0;
  if (!P) x0 = q * codeSInt(cd, S.H, 500, E ? roundDiv(xd, q) : 0);
  else {
    const nl = newLine ? 1 : 0, ls = S.ls, sp = S.spAdv.get(P.font);
    const A = P.endX, B = A + rl(sp ? sp.v : 0);
    let mode = 3, mi = -1;
    if (E) {
      if (!newLine && 2 * Math.abs(xd - A) <= q) mode = 0;
      else if (!newLine && 2 * Math.abs(xd - B) <= q) mode = 1;
      else { mi = ls.findIndex(v => 2 * Math.abs(xd - v) <= q); if (mi >= 0) mode = 2; }
    }
    let done = false;
    if (!newLine) {
      if (S.H.code(cd, 20, E ? +(mode === 0) : 0)) { mode = 0; done = true; }
      else if (S.H.code(cd, 22, E ? +(mode === 1) : 0)) { mode = 1; done = true; }
    }
    if (!done) {
      const hit = ls.length ? S.H.code(cd, 24 + nl, E ? +(mode === 2) : 0) : 0;
      if (hit) { mode = 2; mi = codeUInt(cd, S.H, 1100 + nl * 70, E ? mi : 0); if (mi >= ls.length) throw new Error('text: bad line-start index'); }
      else mode = 3;
    }
    if (mode === 0) { x0 = A; isLineStart = false; }
    else if (mode === 1) { x0 = B; isLineStart = false; }
    else if (mode === 2) x0 = ls[mi];
    else { const anchor = newLine ? (ls.length ? ls[0] : A) : A; x0 = anchor + codeSInt(cd, S.H, 600 + nl * 80, E ? roundDiv(xd - anchor, q) : 0) * q; }
    if (mode === 1 || newLine) S.text.push(32);
  }
  if (isLineStart) { const k = S.ls.findIndex(v => 2 * Math.abs(v - x0) <= q); if (k >= 0) S.ls.splice(k, 1); S.ls.unshift(x0); if (S.ls.length > 8) S.ls.pop(); }
  // ---- glyphs
  const glyphs = []; let xhat = x0, prevSym = -1, k = 0;
  const text = S.text, fi = S.fontInfo[font];
  for (;;) {
    let sym, spaceBefore = false;
    if (E) {
      if (k >= run.glyphs.length) { text.code(cd, 10); break; }
      if (k > 0 && run.glyphs[k - 1].sp) { text.code(cd, 32); spaceBefore = true; }
      sym = run.glyphs[k].sym;
      const n = utf8Len(sym);
      if (n === 1) text.code(cd, sym);
      else { text.code(cd, (n === 2 ? 0xC0 : n === 3 ? 0xE0 : 0xF0) | (sym >> (6 * (n - 1)))); for (let j = n - 2; j >= 0; j--) text.code(cd, 0x80 | ((sym >> (6 * j)) & 63)); }
    } else {
      let b = text.code(cd, 0);
      if (b === 10) break;
      if (b === 32) { spaceBefore = true; b = text.code(cd, 0); }
      if (b < 0x80) sym = b;
      else {
        const need = b >= 0xC0 && b < 0xE0 ? 2 : b >= 0xE0 && b < 0xF0 ? 3 : b >= 0xF0 && b < 0xF8 ? 4 : 0;
        if (!need) throw new Error('text: bad symbol');
        sym = b & (0xFF >> (need + 1));
        for (let j = 1; j < need; j++) { const c = text.code(cd, 0); if ((c & 0xC0) !== 0x80) throw new Error('text: bad symbol'); sym = sym * 64 + (c & 63); }
        if (utf8Len(sym) !== need) throw new Error('text: bad symbol');
      }
      if (glyphs.length >= LIMITS.maxRunGlyphs) throw new Error('text: run too long');
    }
    const fk = font * SYM_SHIFT + sym;
    let xe = S.xm.get(fk); const isNew = xe === undefined;
    if (isNew) {
      const mk = fi.slot * SYM_SHIFT + sym; let m = S.masters.get(mk);
      if (!m) {
        if (S.masters.size >= LIMITS.maxMasters) throw new Error('text: master table full');
        const sh = codeShape(cd, S.shapeP, E ? hooks.shapeFor(fi.slot, sym) : null);
        let xmaxG = -LIMITS.maxCoord; for (const c of sh.contours) for (const v of c.x) if (v > xmaxG) xmaxG = v;
        m = {contours: sh.contours, eo: sh.eo, msize64: fi.size64, grid: gridMilli(fi.size64), xmaxG, sym, path: null}; S.masters.set(mk, m);
      }
      xe = {xm: roundDiv(m.xmaxG * m.grid * 256 * fi.size64, 1000 * m.msize64), m}; S.xm.set(fk, xe);
    }
    let r = 0, x = xhat;
    if (prevSym >= 0) {
      const pk = font * SYM_SHIFT + prevSym, pe = S.adv.get(pk);
      const advp = pe ? pe.v : S.xm.get(pk).xm + 256;
      const sa = S.spAdv.get(font), spv = spaceBefore ? (sa ? sa.v : 1024) : 0;
      const pred = xhat + rl(advp) + rl(spv);
      const rEnc = E ? roundDiv(run.glyphs[k].x - pred, q) : 0;
      const hp = hashPair(prevSym, sym), c2 = (spaceBefore ? 1 : 0) + (S.lastR !== 0 ? 2 : 0) + (pe ? 0 : 4) + (isNew ? 8 : 0);
      const zm = S.zmix; zm.st[0] = S.pair.n[hp] ? stretch(S.pair.p[hp] >> 4) : 0; zm.st[1] = stretch(S.ctx2.p[c2] >> 4); zm.st[2] = 256;
      let p12 = zm.mix(spaceBefore ? 1 : 0); if (p12 < 4) p12 = 4; else if (p12 > 4092) p12 = 4092;
      const zero = cd.bit(p12 << 3, E ? +(rEnc === 0) : 0);
      zm.update(zero); S.pair.upd(hp, zero); S.ctx2.upd(c2, zero);
      if (zero) r = 0; else {
        const neg = S.R.code(cd, 7000 + (spaceBefore ? 1 : 0), E ? +(rEnc < 0) : 0);
        const m = codeUInt(cd, S.R, (spaceBefore ? 100 : 0) + (pe ? 0 : 200), E ? Math.abs(rEnc) - 1 : 0) + 1; r = neg ? -m : m;
      }
      S.lastR = r; x = pred + r * q;
      const obs = x - xhat;
      if (!spaceBefore) learn(S.adv, pk, obs, q); else if (pe) learn(S.spAdv, font, obs - pe.v, q);
    }
    glyphs.push({sym, x: x / 256, master: xe.m});
    xhat = x; prevSym = sym; k++;
  }
  if (k === 0) throw new Error('text: empty run');
  const pk = font * SYM_SHIFT + prevSym, pe = S.adv.get(pk);
  const lastAdv = pe ? pe.v : S.xm.get(pk).xm + 256;
  S.prev = {yq, font, endX: xhat + rl(lastAdv), dyZero: !newLine};
  return {font, face: fi.slot, size: fi.size64 / 64, fill, y: y / 256, glyphs};
}

// One band: [varint run count][runs]. The encoder passes `band` = {runs}; the decoder passes null and gets runs.
export function codeBand(cd, S, band, hooks) {
  const E = !cd.dec;
  S.prev = null; S.lastDy = 0; S.ls = []; S.lastR = 0;
  const n = codeUInt(cd, S.H, 800, E ? band.runs.length - 1 : 0) + 1;
  if (n > LIMITS.maxRuns) throw new Error('text: too many runs');
  const runs = []; let total = 0;
  for (let i = 0; i < n; i++) {
    const r = codeRun(cd, S, E ? band.runs[i] : null, hooks);
    total += r.glyphs.length; if (total > LIMITS.maxBandGlyphs) throw new Error('text: band too large');
    runs.push(r);
  }
  return runs;
}

// ---------------------------------------------------------------------------------------------------------------
// body header: varint q (units of 1/256 CSS px) | u8 flags (bit0 lattice) | rANS bytes
export function readVarint(b, o) {
  let v = 0, s = 1;
  for (let i = 0; i < 5; i++) { if (o >= b.length) throw new Error('text: truncated header'); const c = b[o++]; v += (c & 127) * s; if (!(c & 128)) return [v, o]; s *= 128; }
  throw new Error('text: bad varint');
}

export class TextDecoder2 {
  constructor() { this.state = new State(); }
  reset() { this.state = new State(); }
  // -> Run[]: {font, face, size (CSS px), fill (u32 r<<24|g<<16|b<<8|a), y (baseline, layer CSS px),
  //            glyphs:[{x (layer CSS px), sym, master}]}. An empty body is an empty band.
  decodeBand(bytes) {
    if (!bytes || bytes.length === 0) return [];
    if (bytes.length > LIMITS.maxBody) throw new Error('text: body too large');
    const S = this.state;
    let [q, o] = readVarint(bytes, 0);
    if (q < 1 || q > LIMITS.maxQuantum || o >= bytes.length) throw new Error('text: bad header');
    const flags = bytes[o++]; if (flags & ~1) throw new Error('text: bad flags');
    const cd = new RansDecoder(bytes, o);
    S.begin(); S.q = q; S.lattice = !!(flags & 1);
    try {
      const runs = codeBand(cd, S, null, null);
      cd.check();
      S.commit();
      return runs;
    } catch (e) { S.rollback(); throw e; }
  }
  nearlyFull() { return this.state.nearlyFull(); }
}

// ---------------------------------------------------------------------------------------------------------------
// rendering
export function cssColor(fill) {
  const a = fill & 255;
  return a === 255 ? '#' + ((fill >>> 8) & 0xFFFFFF).toString(16).padStart(6, '0') : `rgba(${fill >>> 24},${(fill >>> 16) & 255},${(fill >>> 8) & 255},${a / 255})`;
}
// Master outline as explicit segments in grid units: ['M',x,y] ['L',x,y] ['Q',cx,cy,x,y]; every contour is closed.
export function masterSegments(m) {
  const res = [];
  for (const c of m.contours) {
    const n = c.x.length; res.push(['M', c.x[0], c.y[0]]);
    let i = 1;
    while (i < n) {
      if (c.on[i]) { res.push(['L', c.x[i], c.y[i]]); i++; continue; }
      if (i + 1 >= n) { res.push(['Q', c.x[i], c.y[i], c.x[0], c.y[0]]); i++; continue; }   // last control closes onto the start
      if (c.on[i + 1]) { res.push(['Q', c.x[i], c.y[i], c.x[i + 1], c.y[i + 1]]); i += 2; }
      else { res.push(['Q', c.x[i], c.y[i], (c.x[i] + c.x[i + 1]) / 2, (c.y[i] + c.y[i + 1]) / 2]); i++; }
    }
    res.push(['Z']);
  }
  return res;
}
function masterPath(m, Path2DCtor) {
  const p = new Path2DCtor();
  for (const s of masterSegments(m)) {
    if (s[0] === 'M') p.moveTo(s[1], s[2]); else if (s[0] === 'L') p.lineTo(s[1], s[2]);
    else if (s[0] === 'Q') p.quadraticCurveTo(s[1], s[2], s[3], s[4]); else p.closePath();
  }
  return p;
}
// Draws runs onto a 2D context. `scale` = device px per layer CSS px, (ox, oy) = device px offset of the layer origin.
export function drawRuns(ctx, runs, scale, ox, oy, Path2DCtor = globalThis.Path2D) {
  ctx.save();
  for (const run of runs) {
    ctx.fillStyle = run.css ||= cssColor(run.fill);
    for (const g of run.glyphs) {
      const m = g.master, k = scale * (m.grid / 1000) * (run.size * 64 / m.msize64);
      ctx.setTransform(k, 0, 0, k, ox + g.x * scale, oy + run.y * scale);
      ctx.fill(m.path ||= masterPath(m, Path2DCtor), m.eo ? 'evenodd' : 'nonzero');
    }
  }
  ctx.restore();
}
