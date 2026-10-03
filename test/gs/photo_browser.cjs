'use strict';
// Real-browser check of the AV1 photo path: sections written by the C++ PhotoStream (brisk_gpu/photo/test/photo_bench) are
// decoded by PhotoDecoder in headless Chromium (WebCodecs VideoDecoder and the createImageBitmap/AVIF alternative) and
// compared with the source pixels: PSNR per quality, colour accuracy, multi-rect atlas, corrupt payloads, dictionary
// reuse across sections. Needs puppeteer + chromium (TEST_BROWSER) and a data dir (PHOTO_DATA, default below) produced by
//   extract_fixtures.cjs <dir>/fixtures ; photo_bench <dir>/fixtures <dir>/sec --q ... --multi 6
// Usage: node photo_browser.cjs [--json out.json]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
let puppeteer;
try { puppeteer = require('puppeteer'); } catch (_) { console.log('SKIP photo browser: no puppeteer'); process.exit(0); }
const executablePath = process.env.TEST_BROWSER || '/usr/bin/chromium';
const DATA = process.env.PHOTO_DATA || '/home/sd/.claude/jobs/5092cee3/tmp/photo';
if (!fs.existsSync(executablePath) || !fs.existsSync(DATA + '/sec/manifest.jsonl')) { console.log('SKIP photo browser: no browser or data'); process.exit(0); }
const src = path.join(__dirname, '../../src');
const jsonOut = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : null;

(async () => {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    if (url === '/') return res.end('<body></body>');
    const file = url.startsWith('/data/') ? path.join(DATA, url.slice(6)) : path.join(src, url.replace(/^\/src\//, ''));
    if (!(file.startsWith(src) || file.startsWith(DATA)) || !fs.existsSync(file)) { res.statusCode = 404; return res.end(); }
    res.setHeader('Content-Type', url.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
    res.end(fs.readFileSync(file));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const browser = await puppeteer.launch({executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage']});
  const failures = [];
  try {
    const page = await browser.newPage();
    page.on('pageerror', e => { throw e; });
    await page.goto('http://127.0.0.1:' + server.address().port);
    const manifest = fs.readFileSync(DATA + '/sec/manifest.jsonl', 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const result = await page.evaluate(async (manifest, wantPaths) => {
      const {PhotoDecoder, Av1AtlasDecoder, photoDecoders} = await import('/src/gs/photo.js');
      const {Surface} = await import('/src/gs/surface.js');
      const get = async u => new Uint8Array(await (await fetch(u)).arrayBuffer());
      const psnr = (a, b, w, h, x0 = 0, y0 = 0, sw = w) => {   // RGB only; a = decoded surface (stride sw), b = source (stride w)
        let se = 0, maxd = 0;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) {
          const d = a[((y0 + y) * sw + x0 + x) * 4 + c] - b[(y * w + x) * 4 + c]; se += d * d; if (Math.abs(d) > maxd) maxd = Math.abs(d);
        }
        const mse = se / (w * h * 3);
        return {psnr: mse === 0 ? 99 : 10 * Math.log10(255 * 255 / mse), maxd};
      };
      const out = {caps: {videoDecoder: typeof VideoDecoder, av1444: null, createImageBitmap: typeof createImageBitmap}, rows: [], multi: [], errors: [], dict: null};
      out.caps.av1444 = (await VideoDecoder.isConfigSupported({codec: 'av01.1.13M.08.0.000', codedWidth: 512, codedHeight: 512})).supported;
      const fxCache = {};
      const fixture = async (name) => fxCache[name] || (fxCache[name] = await get('/data/fixtures/' + name + '.rgba'));
      for (const path of wantPaths) {
        for (const m of manifest) {
          if (m.multi || m.codec !== 2) continue;
          const body = await get('/data/sec/' + m.file), srcpx = await fixture(m.name);
          const s = new Surface(m.w, m.h);
          const dec = new PhotoDecoder({codecs: new Map([[2, class extends Av1AtlasDecoder { constructor() { super({path}); } }]])});
          const t0 = performance.now();
          await dec.apply(s, {x: 0, y: 0, w: m.w, h: m.h}, body, 2);
          const ms = performance.now() - t0;
          const q = psnr(s.rgba, srcpx, m.w, m.h);
          out.rows.push({path, name: m.name, q: m.q, speed: m.speed, bytes: m.bytes, w: m.w, h: m.h, psnr: q.psnr, maxd: q.maxd, decode_ms: ms,
            stats: JSON.stringify(dec.codecs.get(2).stats)});
          dec.close();
        }
      }
      // multi-rect atlas sections: every rect region against its source
      for (const m of manifest.filter(x => x.multi)) {
        const body = await get('/data/sec/' + m.file), rects = JSON.parse(new TextDecoder().decode(await get('/data/sec/' + m.multi)));
        const s = new Surface(Math.max(...rects.map(r => r.tx * 16 + r.w)) + 16, Math.max(...rects.map(r => r.ty * 16 + r.h)) + 16);
        const dec = new PhotoDecoder();
        const t0 = performance.now();
        await dec.apply(s, {x: 0, y: 0, w: s.w, h: s.h}, body, 2);
        const ms = performance.now() - t0;
        const per = [];
        for (const r of rects) per.push(psnr(s.rgba, await fixture(r.name), r.w, r.h, r.tx * 16, r.ty * 16, s.w).psnr);
        out.multi.push({file: m.file, q: m.q, speed: m.speed, bytes: m.bytes, decode_ms: ms, minPsnr: Math.min(...per), meanPsnr: per.reduce((a, b) => a + b) / per.length, n: rects.length});
      }
      // dictionary reuse + corrupt payloads on a real AV1 section
      {
        const m = manifest.find(x => !x.multi && x.codec === 2);
        const body = await get('/data/sec/' + m.file);
        const s = new Surface(m.w, m.h);
        const rect = {x: 0, y: 0, w: m.w, h: m.h};
        const dec = new PhotoDecoder();
        const tryApply = async (b) => { try { await dec.apply(s, rect, b, 2); return null; } catch (e) { return e.name + ': ' + e.message; } };
        out.errors.push(['truncated', await tryApply(body.subarray(0, body.length - 40))]);
        // wrong atlas width in the table (512 -> 496): the photo no longer fits / the decoded size mismatches
        const wrongDim = body.slice(); wrongDim[11] = 0xf0; wrongDim[12] = 0x03;
        out.errors.push(['wrong atlas dims', await tryApply(wrongDim)]);
        // AV1 has no checksum: flipped entropy-coded bytes decode to garbage without an error (the websocket is TCP-checked);
        // only record that the decoder survives them. Uses a throwaway decoder so the dictionary check below stays meaningful.
        const junk = body.slice(); for (let i = body.length - 200; i < body.length - 20; i++) junk[i] = (i * 131) & 255;
        const dec2 = new PhotoDecoder();
        try { await dec2.apply(new Surface(m.w, m.h), rect, junk, 2); out.errors.push(['garbage payload', 'decoded (no error)']); }
        catch (e) { out.errors.push(['garbage payload', 'rejected: ' + e.message]); }
        out.errors.push(['dict size after errors', dec.dict.size]);
        out.errors.push(['good after errors', await tryApply(body)]);
        out.errors.push(['dict size after good', dec.dict.size]);
        // held reuse: a second patch referencing the same photo id 0 (varint head 1<<1, rect, entry id+1=1, n_atlas 0)
        const tw = m.w / 16, th = m.h / 16;
        const held = new Uint8Array([2, 0, 0, 0, 0, tw & 255, tw >> 8, th & 255, th >> 8, 1, 0]);
        out.errors.push(['held ref', await tryApply(held)]);
      }
      return out;
    }, manifest, ['webcodecs', 'bitmap']);

    // ---------------------------------------------------------------- report and assertions
    console.log('caps', JSON.stringify(result.caps));
    const byPath = {};
    for (const r of result.rows) {
      const k = r.path + ' q' + r.q + ' s' + r.speed;
      (byPath[k] = byPath[k] || []).push(r);
    }
    for (const [k, rows] of Object.entries(byPath)) {
      const bytes = rows.reduce((a, r) => a + r.bytes, 0), px = rows.reduce((a, r) => a + r.w * r.h, 0);
      const mean = rows.reduce((a, r) => a + r.psnr, 0) / rows.length, min = Math.min(...rows.map(r => r.psnr));
      const dms = rows.reduce((a, r) => a + r.decode_ms, 0) / rows.length;
      console.log(`${k.padEnd(26)} n=${rows.length} bytes=${bytes} bpp=${(bytes * 8 / px).toFixed(3)} PSNR mean=${mean.toFixed(2)} min=${min.toFixed(2)} dB, decode ${dms.toFixed(1)} ms/section`);
    }
    for (const m of result.multi) console.log(`multi ${m.file}: ${m.n} rects, ${m.bytes} B, PSNR mean ${m.meanPsnr.toFixed(2)} min ${m.minPsnr.toFixed(2)}, decode ${m.decode_ms.toFixed(1)} ms`);
    console.log('errors', JSON.stringify(result.errors));
    if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(result, null, 1));

    const check = (cond, msg) => { if (!cond) failures.push(msg); };
    check(result.caps.av1444, 'WebCodecs does not report AV1 4:4:4 support');
    for (const r of result.rows) check(r.psnr > 18, `${r.path} ${r.name} q${r.q}: PSNR ${r.psnr.toFixed(1)} too low (decode or colour broken)`);
    // quality knob is monotone in bytes and PSNR (mean over fixtures)
    for (const p of ['webcodecs', 'bitmap']) {
      const qs = [...new Set(result.rows.filter(r => r.path === p).map(r => r.q))].sort((a, b) => a - b);
      const speeds = [...new Set(result.rows.map(r => r.speed))];
      for (const sp of speeds) {
        let prev = null;
        for (const q of qs) {
          const rows = result.rows.filter(r => r.path === p && r.q === q && r.speed === sp);
          if (!rows.length) continue;
          const mean = rows.reduce((a, r) => a + r.psnr, 0) / rows.length, bytes = rows.reduce((a, r) => a + r.bytes, 0);
          if (prev) { check(mean > prev.mean, `${p} s${sp}: PSNR not increasing at q${q}`); check(bytes > prev.bytes, `${p} s${sp}: bytes not increasing at q${q}`); }
          prev = {mean, bytes};
        }
      }
    }
    // both decode paths agree to within 1 dB on the same sections
    for (const r of result.rows.filter(x => x.path === 'webcodecs')) {
      const o = result.rows.find(x => x.path === 'bitmap' && x.name === r.name && x.q === r.q && x.speed === r.speed);
      if (o) check(Math.abs(o.psnr - r.psnr) < 1, `webcodecs vs bitmap PSNR differ for ${r.name} q${r.q}: ${r.psnr.toFixed(2)} vs ${o.psnr.toFixed(2)}`);
    }
    for (const m of result.multi) check(m.minPsnr > 18, `multi ${m.file}: min PSNR ${m.minPsnr.toFixed(1)}`);
    const e = Object.fromEntries(result.errors);
    check(e['truncated'] && /PhotoError/.test(e['truncated']), 'truncated payload was not rejected');
    check(e['wrong atlas dims'] && /PhotoError/.test(e['wrong atlas dims']), 'wrong atlas dims were not rejected');
    check(e['dict size after errors'] === 0, 'dictionary changed by a rejected section');
    check(e['good after errors'] === null, 'good section failed after corrupt ones: ' + e['good after errors']);
    check(e['dict size after good'] === 1, 'good section did not register its photo');
    check(e['held ref'] === null, 'held reference failed: ' + e['held ref']);
  } finally {
    await browser.close();
    server.close();
  }
  if (failures.length) { console.error('FAIL\n' + failures.join('\n')); process.exit(1); }
  console.log('photo browser: ok');
})().catch(e => { console.error(e); process.exit(1); });
