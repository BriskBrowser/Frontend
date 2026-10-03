// Bytes of the GPU flat encoder vs the research regions7 encoder (BH=16, LG=4, shipped priors) on the same corpus
// surfaces and the same photo rects (the rects the GPU classifier chose), plus encode/decode timings.
//   node test/gs/flat_vs_regions7.mjs --bin /path/flat_test --out /tmp/flat-r7 --site bbc [--n 6] [--crop 1280x1024]
//        [--params 16,4,32,4,4] [--cells]
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { FlatDecoder } from '../../src/gs/flat.js';
import { Surface, surfaceKey } from '../../src/gs/surface.js';

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i < 0 ? d : args[i + 1]; };
const BIN = opt('bin'), OUT = opt('out', '/tmp/flat-r7'), site = opt('site', 'bbc'), N = +opt('n', 6);
const PARAMS = opt('params', '16,4,32,4,4').split(',').map(Number);
const [CW, CH] = opt('crop', '1280x1024').split('x').map(Number);
const cells = args.includes('--cells');
fs.mkdirSync(OUT, { recursive: true });
const R = '/workspace/root/.claude/worktrees/tree-codec-capture/experiments/tree-codec/';
const { loadSite } = require(R + 'harness/corpus.js');
const r7 = require(R + 'research/gpu-lanes/regions7.js');
const priors = r7.A.loadPriors(r7.SPEC, R + 'research/gpu-lanes/priors.json');

const { surfaces } = loadSite(site);
const picks = surfaces.filter(s => s.w >= 300 && s.h >= 200).slice(0, N).map(s => {
  const w = Math.min(s.w, CW), h = Math.min(s.h, CH), rgb = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) s.rgb.copy(rgb, y * w * 3, y * s.w * 3, (y * s.w + w) * 3);
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) { rgba[i * 4] = rgb[i * 3]; rgba[i * 4 + 1] = rgb[i * 3 + 1]; rgba[i * 4 + 2] = rgb[i * 3 + 2]; rgba[i * 4 + 3] = 255; }
  return { w, h, rgb, rgba };
});
const keys = picks.map((_, i) => surfaceKey(1, i + 1));
const lines = ['params ' + PARAMS.join(' ')];
const ids = [];
picks.forEach((p, i) => {
  const file = path.join(OUT, `s${i}.rgba`); fs.writeFileSync(file, p.rgba);
  lines.push(`image s${i} ${file} ${p.w} ${p.h}`);
  const refs = keys.slice(Math.max(0, i - 4), i).reverse();
  const cell = cells ? 256 : 1 << 20;
  for (let y = 0; y < p.h; y += cell) for (let x = 0; x < p.w; x += cell) {
    const id = `s${i}_${x}_${y}`; ids.push({ id, i, x, y, w: Math.min(cell, p.w - x), h: Math.min(cell, p.h - y) });
    lines.push(`patch ${id} ${keys[i]} s${i} ${x} ${y} ${Math.min(cell, p.w - x)} ${Math.min(cell, p.h - y)} ${x} ${y} ${p.w} ${p.h} ${refs.length} ${refs.join(' ')}`);
  }
});
fs.writeFileSync(path.join(OUT, 'scenario.txt'), lines.join('\n') + '\n');
execFileSync(BIN, [path.join(OUT, 'scenario.txt'), OUT], { stdio: ['ignore', 'ignore', 'inherit'] });

let mine = 0, gpuMs = 0, anaMs = 0, laneMs = 0, cpuMs = 0, decMs = 0, newLib = 0, lanes = 0;
const dec = new FlatDecoder(), S = new Map();
for (const p of ids) {
  const info = Object.fromEntries(fs.readFileSync(path.join(OUT, p.id + '.txt'), 'utf8').split('\n').filter(Boolean).map(l => [l.split(' ')[0], l.split(' ').slice(1)]));
  const bytes = fs.readFileSync(path.join(OUT, p.id + '.flat'));
  mine += bytes.length;
  const st = info.stats, g = n => +st[st.indexOf(n) + 1];
  gpuMs += g('ms_total'); anaMs += g('ms_analysis'); laneMs += g('ms_lanes'); cpuMs += g('ms_cpu'); newLib += g('newlib'); lanes += g('liblanes') + g('bands');
  const pk = picks[p.i];
  if (!S.has(keys[p.i])) S.set(keys[p.i], new Surface(pk.w, pk.h));
  const t0 = performance.now();
  if (bytes.length) dec.apply(S.get(keys[p.i]), S, { x: p.x, y: p.y, w: p.w, h: p.h }, bytes);
  decMs += performance.now() - t0;
}
// regions7 on the same surfaces and photo rects (file line: "rects n tx ty tw th ...")
const uniq = picks.map((p, i) => {
  let id = 0;
  const all = [];
  for (const q of ids.filter(q => q.i === i)) { const f = fs.readFileSync(path.join(OUT, q.id + '.txt'), 'utf8').split('\n').find(l => l.startsWith('rects')).split(' ').slice(1).map(Number); for (let k = 1; k + 3 < f.length; k += 4) all.push({ tx: f[k] + q.x / 16, ty: f[k + 1] + q.y / 16, tw: f[k + 2], th: f[k + 3], id: id++ }); }
  return { w: p.w, h: p.h, rgb: p.rgb, rects: all };
});
const t0 = performance.now();
const r = r7.encode(uniq, uniq.map((_, i) => i), new Uint8Array(uniq.reduce((a, u) => a + u.rects.length, 0)), { priors, BH: 16, LG: 4 });
const r7ms = performance.now() - t0;
const r7b = { total: r.buf.length, ...r.stats };
const photoTiles = uniq.reduce((a, u) => a + u.rects.reduce((b, q) => b + q.tw * q.th, 0), 0);
console.log(`${site}: ${picks.length} surfaces ${picks.map(p => p.w + 'x' + p.h).join(' ')} (${cells ? '256px cells' : 'whole-surface patches'}), ${photoTiles} photo tiles masked`);
console.log(`  GPU flat   : ${mine} B   new library tiles ${newLib}   lanes ${lanes}   encode ${gpuMs.toFixed(1)} ms (analysis ${anaMs.toFixed(1)}, lib lanes ${laneMs.toFixed(1)}, cpu layout ${cpuMs.toFixed(1)})   JS decode ${decMs.toFixed(1)} ms`);
console.log(`  regions7   : ${r7b.total} B   (lib ${r7b.libBytes} layout ${r7b.layBytes} meta ${r7b.metaBytes} lane hdr ${r7b.laneHdr})  library tiles ${r7b.libTiles}   CPU JS encode ${r7ms.toFixed(0)} ms`);
console.log(`  ratio GPU/regions7 = ${(mine / r7b.total).toFixed(3)}`);
