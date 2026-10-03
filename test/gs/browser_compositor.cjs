'use strict';
// Real-browser check of the packet -> pixels path: synthetic stream packets go
// through GsStream (stub flat/photo decoders), the Compositor paints real
// canvases, and the canvas pixels are read back. Also loads the modules the
// page imports at startup so a syntax or import error fails here.
// Needs puppeteer and a chromium (TEST_BROWSER); skipped when absent.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
let puppeteer;
try { puppeteer = require('puppeteer'); } catch (_) { console.log('SKIP browser compositor: no puppeteer'); process.exit(0); }
const executablePath = process.env.TEST_BROWSER || '/usr/bin/chromium';
if (!fs.existsSync(executablePath)) { console.log('SKIP browser compositor: no browser'); process.exit(0); }
const src = path.join(__dirname, '../../src');
(async () => {
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/') return res.end('<body style="margin:0"></body>');
    const file = path.join(src, url);
    if (!file.startsWith(src) || !fs.existsSync(file)) { res.statusCode = 404; return res.end(); }
    res.setHeader('Content-Type', url.endsWith('.js') ? 'text/javascript' : 'text/plain');
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await puppeteer.launch({executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage']});
  try {
    const page = await browser.newPage();
    page.on('pageerror', e => { throw e; });
    await page.goto('http://127.0.0.1:' + server.address().port);
    const result = await page.evaluate(async () => {
      for (const m of ['/browser.js', '/devtoolswebsocket.js', '/session.js', '/gs/caps.js']) await import(m);
      const {GsStream} = await import('/gs/stream.js');
      const caps = await (await import('/gs/caps.js')).probeCaps();
      const u32 = n => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, n >>> 24];
      const head = (kind, source) => [0xB7, kind, source & 255, source >> 8];
      const layer = (id, w, h) => Uint8Array.from([...head(3, 1), 2, ...u32(id), ...u32(1), ...u32(w), ...u32(h), 0, 0, 128, 63, ...u32(0), ...u32(0)]);
      const patch = (id, x, y, w, h, codec, body) => Uint8Array.from([...head(1, 1), ...u32(id), ...u32(1), ...u32(x), ...u32(y),
        w & 255, w >> 8, h & 255, h >> 8, 0, 0, 1, codec, body.length, ...body]);
      const flat = {apply(surface, surfaces, rect, b) {
        for (let y = rect.y; y < rect.y + rect.h; y++) for (let x = rect.x; x < rect.x + rect.w; x++) surface.rgba.set(b, (y * surface.w + x) * 4);
        return {photoTiles: new Uint8Array(1)};
      }, reset() {}};
      const photo = {async apply(surface, rect, b) { await new Promise(r => setTimeout(r, 20)); surface.rgba.set([b[0], 0, 0, 255], (rect.y * surface.w + rect.x) * 4); }, reset() {}};
      const stream = new GsStream({textHost: {decode: async () => [], reset() {}, close() {}},
        loadModules: async () => ({FlatDecoder: function () { return flat; }, PhotoDecoder: function () { return photo; }})});
      const holder = document.createElement('div');
      holder.style.cssText = 'position:absolute;left:0;top:0;width:100px;height:100px';
      document.body.append(holder);
      await stream.handle(layer(5, 40, 5000));
      stream.compositor.attach(1, 5, holder);
      const jobs = [
        stream.handle(patch(5, 0, 0, 16, 16, 1, [10, 20, 30, 255])),
        stream.handle(patch(5, 16, 4090, 16, 16, 1, [200, 100, 50, 255])),   // straddles the strip boundary
        stream.handle(patch(5, 0, 0, 16, 16, 2, [250])),
      ];
      await Promise.all(jobs);
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const canvases = [...holder.querySelectorAll('canvas')];
      const px = (c, x, y) => Array.from(c.getContext('2d').getImageData(x, y, 1, 1).data);
      const out = {caps, count: canvases.length, sizes: canvases.map(c => [c.width, c.height]),
        a: px(canvases[0], 0, 0), b: px(canvases[0], 20, 4094), c: px(canvases[1], 20, 0), blank: px(canvases[0], 30, 100)};
      stream.close();
      return out;
    });
    assert.ok(result.caps.photo.includes(3));
    assert.equal(result.count, 2);
    assert.deepEqual(result.sizes, [[40, 4096], [40, 904]]);
    assert.deepEqual(result.a, [250, 0, 0, 255], 'photo section applied after the flat one');
    assert.deepEqual(result.b, [200, 100, 50, 255]);
    assert.deepEqual(result.c, [200, 100, 50, 255]);
    assert.deepEqual(result.blank, [0, 0, 0, 0]);
    console.log('PASS browser compositor: packets reach canvas pixels');
  } finally {
    await browser.close();
    server.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
