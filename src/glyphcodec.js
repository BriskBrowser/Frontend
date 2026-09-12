/* Brisk glyph protocol v1. Shared verbatim with Frontend/src/glyphcodec.js.
 * No font/process IDs: dictionary identity is exact SVG outline + fill rule.
 * All limits are connection limits. Never evict/re-send a dictionary entry.
 */
(function(root) {
  'use strict';
  const MAX_PACKET = 16 * 1024 * 1024, MAX_CACHE = 32 * 1024 * 1024;
  const MAX_GLYPHS = 65536, MAX_PATH = 128 * 1024;
  const verbs = 'MLQCZ', utf8 = new TextEncoder(), text = new TextDecoder('utf-8', {fatal: true});
  const check = (ok, message) => {if (!ok) throw Error('Glyph protocol: ' + message);};
  function put(out, n) {
    check(Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff, 'integer overflow');
    do {const b = n % 128; n = Math.floor(n / 128); out.push(b + (n ? 128 : 0));} while (n);
  }
  class Reader {
    constructor(bytes) {this.bytes = bytes; this.at = 0;}
    uint() {
      let n = 0, scale = 1;
      for (let i = 0; i < 5; i++, scale *= 128) {
        check(this.at < this.bytes.length, 'truncated integer');
        const b = this.bytes[this.at++]; n += (b & 127) * scale;
        if (b < 128) {check(n <= 0xffffffff, 'integer overflow'); return n;}
      }
      throw Error('Glyph protocol: invalid integer');
    }
    take(n) {
      check(n <= this.bytes.length - this.at, 'truncated data');
      const out = this.bytes.subarray(this.at, this.at + n); this.at += n; return out;
    }
    end() {check(this.at === this.bytes.length, 'trailing data');}
  }
  function encodePath(d) {
    check(d.length <= MAX_PATH, 'path too large');
    const tokens = d.match(/[MLQCZ]|[+-]?(?:\d+(?:\.\d*)?|\.\d+)/g) || [];
    check(tokens.join('') === d.replace(/[ ,]/g, ''), 'unsupported path syntax');
    const out = [], previous = [0, 0]; let axis = 0;
    for (const token of tokens) {
      const verb = verbs.indexOf(token);
      if (verb >= 0) {put(out, verb); continue;}
      const coordinate = Number(token), value = Math.round(coordinate * 100);
      check(Math.abs(value) <= 100000000 && Math.abs(value / 100 - coordinate) < 1e-9,
        'path precision/range');
      const delta = value - previous[axis]; previous[axis] = value; axis ^= 1;
      put(out, 5 + (delta < 0 ? -2 * delta - 1 : 2 * delta));
    }
    // Validate command arity as well as tokens, before admitting it to a cache.
    decodePath(Uint8Array.from(out));
    return Uint8Array.from(out);
  }
  function decodePath(bytes) {
    check(bytes.length <= MAX_PATH, 'path too large');
    const r = new Reader(bytes), out = [], previous = [0, 0];
    let axis = 0, verb = -1, count = 0, size = 0;
    const arity = [2, 2, 4, 6, 0];
    const finish = () => check(verb >= 0 && (verb === 4 ? count === 0 : count > 0 && count % arity[verb] === 0), 'path arity');
    while (r.at < bytes.length) {
      const n = r.uint();
      if (n < 5) {
        if (verb >= 0) finish();
        else check(n === 0, 'path must start with move');
        verb = n; count = 0; out.push(verbs[n]); size++;
      } else {
        check(verb >= 0 && verb !== 4, 'unexpected coordinate');
        const z = n - 5, delta = z % 2 ? -(z + 1) / 2 : z / 2;
        const value = previous[axis] + delta;
        check(Math.abs(value) <= 100000000, 'coordinate overflow');
        previous[axis] = value; axis ^= 1; count++;
        const token = String(value / 100); out.push(token); size += token.length + 1;
        check(size <= MAX_PATH, 'decoded path too large');
      }
    }
    if (verb >= 0) finish();
    return out.join(' ');
  }

  // Binary arithmetic coder, adaptive prefix-tree contexts plus the previous
  // byte's high bit. Integer interval arithmetic stays below 2^53 in JS.
  function arithmetic(bytes, length) {
    const decoding = length !== undefined;
    check(bytes.length <= MAX_PACKET && (!decoding || length <= MAX_PACKET), 'arithmetic size');
    const zero = new Uint16Array(1024).fill(1), one = new Uint16Array(1024).fill(1);
    const HALF = 0x80000000, QUARTER = 0x40000000, FULL = 0x100000000;
    let low = 0, high = FULL - 1, pending = 0, code = 0, bitAt = 0, prev = 0;
    const output = []; let byte = 0, bits = 0;
    const read = () => {
      // Arithmetic termination permits at most 32 zero pad bits.
      check(bitAt < bytes.length * 8 + 32, 'truncated arithmetic data');
      return bitAt < bytes.length * 8 ? (bytes[bitAt >> 3] >> (7 - (bitAt++ & 7))) & 1 : (bitAt++, 0);
    };
    const write = bit => {byte = byte * 2 + bit; if (++bits === 8) {output.push(byte); byte = bits = 0;}};
    const emit = bit => {write(bit); while (pending) {write(1 - bit); pending--;}};
    if (decoding) for (let i = 0; i < 32; i++) code = code * 2 + read();
    const decoded = decoding ? new Uint8Array(length) : null;
    for (let i = 0; i < (decoding ? length : bytes.length); i++) {
      let prefix = 1, value = 0;
      for (let b = 7; b >= 0; b--) {
        const context = (prev & 128 ? 512 : 0) + prefix;
        const split = low + Math.floor((high - low + 1) * zero[context] / (zero[context] + one[context]));
        const bit = decoding ? +(code >= split) : (bytes[i] >> b) & 1;
        if (bit) low = split; else high = split - 1;
        while (true) {
          if (high < HALF) {if (!decoding) emit(0);}
          else if (low >= HALF) {
            if (!decoding) emit(1); else code -= HALF;
            low -= HALF; high -= HALF;
          } else if (low >= QUARTER && high < 3 * QUARTER) {
            if (!decoding) pending++; else code -= QUARTER;
            low -= QUARTER; high -= QUARTER;
          } else break;
          low *= 2; high = high * 2 + 1;
          if (decoding) code = code * 2 + read();
        }
        if (bit) one[context]++; else zero[context]++;
        if (zero[context] + one[context] >= 16384) {
          zero[context] = (zero[context] + 1) >> 1; one[context] = (one[context] + 1) >> 1;
        }
        prefix = prefix * 2 + bit; value = value * 2 + bit;
      }
      prev = value; if (decoding) decoded[i] = value;
    }
    if (decoding) return decoded;
    pending++; emit(low < QUARTER ? 0 : 1);
    if (bits) output.push(byte << (8 - bits));
    return Uint8Array.from(output);
  }
  function splitSVG(svg) {
    const start = svg.indexOf('<defs>'), end = svg.indexOf('</defs>');
    if (start < 0 || end < start) return null;
    const defs = svg.slice(start + 6, end), paths = [];
    const pattern = /<path id='(g\d+)'( fill-rule='evenodd')? d='([^']*)'\/>/g;
    let match, ids = new Set();
    while ((match = pattern.exec(defs))) {
      check(!ids.has(match[1]), 'duplicate local glyph'); ids.add(match[1]);
      paths.push({local: Number(match[1].slice(1)), evenOdd: !!match[2], d: match[3]});
    }
    // Rectangular clip definitions remain tile-local; glyphs are the only
    // definitions removed. The producer can emit both in the same defs block.
    const remainder = defs.replace(pattern, '');
    if (/<path\b/.test(remainder)) return null;
    return {paths, body: svg.slice(0, start + 6) + remainder + svg.slice(end)};
  }
  class Encoder {
    constructor({coding = 'arithmetic'} = {}) {this.ids = new Map(); this.bytes = 0; this.coding = coding;}
    encode(svg) {
      const parsed = splitSVG(svg); if (!parsed) return null;
      const additions = [], refs = [], staged = new Map(); let addedBytes = 0;
      for (const path of parsed.paths) {
        const key = (path.evenOdd ? 'e' : 'n') + path.d;
        let id = this.ids.get(key) || staged.get(key);
        if (!id) {
          id = this.ids.size + staged.size + 1;
          check(id <= MAX_GLYPHS && this.bytes + addedBytes + key.length <= MAX_CACHE, 'connection dictionary full');
          const data = encodePath(path.d);
          staged.set(key, id); addedBytes += key.length;
          additions.push({id, evenOdd: path.evenOdd, data});
        }
        refs.push([path.local, id]);
      }
      const raw = []; put(raw, additions.length);
      for (const p of additions) {put(raw, p.id); put(raw, +p.evenOdd); put(raw, p.data.length); for (const b of p.data) raw.push(b);}
      const rawBytes = Uint8Array.from(raw);
      const coded = this.coding === 'arithmetic' && additions.length ? arithmetic(rawBytes) : rawBytes;
      const compressed = coded.length < rawBytes.length;
      const chosen = compressed ? coded : rawBytes, out = [71, 76, 89, 1, +compressed];
      put(out, rawBytes.length); put(out, chosen.length); for (const b of chosen) out.push(b);
      put(out, refs.length); for (const [local, id] of refs) {put(out, local); put(out, id);}
      const body = utf8.encode(parsed.body); put(out, body.length); for (const b of body) out.push(b);
      check(out.length <= MAX_PACKET, 'packet too large');
      // Commit only after the whole packet is encoded successfully.
      for (const [key, id] of staged) this.ids.set(key, id);
      this.bytes += addedBytes;
      return {bytes: Uint8Array.from(out), additions: additions.length, references: refs.length};
    }
  }
  class Decoder {
    constructor() {this.paths = new Map(); this.bytes = 0;}
    decode(bytes) {
      check(bytes.length <= MAX_PACKET, 'packet too large');
      const r = new Reader(bytes);
      check(Array.from(r.take(4)).join(',') === '71,76,89,1', 'version');
      const mode = r.take(1)[0]; check(mode <= 1, 'coding');
      const rawLength = r.uint(), codedLength = r.uint();
      check(rawLength <= MAX_PACKET, 'dictionary packet too large');
      const coded = r.take(codedLength);
      check(mode || rawLength === codedLength, 'raw length');
      const raw = new Reader(mode ? arithmetic(coded, rawLength) : coded);
      const count = raw.uint(), staged = new Map(); let addedBytes = 0;
      check(count <= MAX_GLYPHS - this.paths.size, 'connection dictionary full');
      for (let i = 0; i < count; i++) {
        const id = raw.uint(), rule = raw.uint(), length = raw.uint();
        check(id === this.paths.size + i + 1 && rule <= 1, 'dictionary sequence');
        const d = decodePath(raw.take(length));
        const path = (rule ? " fill-rule='evenodd'" : '') + " d='" + d + "'/>";
        addedBytes += path.length;
        check(this.bytes + addedBytes <= MAX_CACHE, 'connection dictionary full');
        staged.set(id, path);
      }
      raw.end();
      const refCount = r.uint(), locals = new Set(), defs = [];
      check(refCount <= MAX_GLYPHS, 'too many references');
      let size = 0;
      for (let i = 0; i < refCount; i++) {
        const local = r.uint(), id = r.uint();
        check(local < MAX_GLYPHS && !locals.has(local), 'local glyph id'); locals.add(local);
        const path = staged.get(id) || this.paths.get(id); check(path !== undefined, 'unknown glyph');
        const def = "<path id='g" + local + "'" + path; size += def.length;
        check(size <= MAX_PACKET, 'expanded tile too large'); defs.push(def);
      }
      const body = text.decode(r.take(r.uint())); r.end();
      check(body.indexOf('<defs>') >= 0 && body.length + size <= MAX_PACKET, 'tile body');
      for (const [id, path] of staged) this.paths.set(id, path);
      this.bytes += addedBytes;
      return body.replace('<defs>', '<defs>' + defs.join(''));
    }
  }
  const api = {Encoder, Decoder, encodePath, decodePath, arithmetic, splitSVG, MAX_PACKET, MAX_CACHE, MAX_GLYPHS};
  root.BriskGlyphCodec = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
