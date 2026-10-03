// Synthetic TEXT corpus pages (same text format as text_corpus.js) exercising what the real captures do not:
// cubic outlines, sizes in different buckets, negative coordinates, alpha fills, symbol collisions and unknown
// characters, even-odd fills, blank non-space glyphs.
import fs from 'node:fs';

const f2 = v => String(Math.round(v * 100) / 100);
const poly = pts => 'M ' + pts.map(p => f2(p[0]) + ' ' + f2(p[1])).join(' L ') + ' Z';
function cubicCircle(cx, cy, r) {
  const k = 0.5523 * r, P = (x, y) => f2(x) + ' ' + f2(y);
  return `M ${P(cx + r, cy)} C ${P(cx + r, cy + k)} ${P(cx + k, cy + r)} ${P(cx, cy + r)} C ${P(cx - k, cy + r)} ${P(cx - r, cy + k)} ${P(cx - r, cy)} ` +
    `C ${P(cx - r, cy - k)} ${P(cx - k, cy - r)} ${P(cx, cy - r)} C ${P(cx + k, cy - r)} ${P(cx + r, cy - k)} ${P(cx + r, cy)} Z`;
}
function quadBlob(cx, cy, r) {   // closed quad contour with an explicit end back on the start
  const P = (x, y) => f2(x) + ' ' + f2(y);
  return `M ${P(cx + r, cy)} Q ${P(cx + r, cy + r)} ${P(cx, cy + r)} Q ${P(cx - r, cy + r)} ${P(cx - r, cy)} Q ${P(cx - r, cy - r)} ${P(cx, cy - r)} Q ${P(cx + r, cy - r)} ${P(cx + r, cy)} Z`;
}
// outline set scaled for a font size (design at 16 px)
function shapes(size) {
  const s = size / 16;
  const sc = pts => pts.map(p => [p[0] * s, p[1] * s]);
  return {
    A: poly(sc([[0, 0], [4, -11], [8, 0], [6.5, 0], [4, -7], [1.5, 0]])),
    B: poly(sc([[0, 0], [0, -11], [6, -11], [6, 0]])),
    O: cubicCircle(4 * s, -5.5 * s, 5 * s),
    Q: quadBlob(4 * s, -5.5 * s, 4.5 * s),
    E: poly(sc([[0, 0], [0, -11], [7, -11], [7, 0]])) + ' ' + poly(sc([[2, -2], [5, -2], [5, -9], [2, -9]])),
  };
}
const GLYPHS = {65: 'A', 66: 'B', 79: 'O', 81: 'Q', 69: 'E', 300: 'A', 301: 'B', 400: 'Q', 500: 'O'};
// glyph id -> [shape name, advance]
const ADV = {A: 9, B: 7, O: 9, Q: 10, E: 8};

export function writeSynth(dir) {
  fs.mkdirSync(dir, {recursive: true});
  const pages = {A: [], B: []};
  function page(name, runsSpec) {
    const L = [`page ${name} 2 0`], outlines = [], oid = new Map();
    const runLines = [];
    for (const r of runsSpec) {
      const sh = shapes(r.size), glyphLines = [];
      let x = r.x;
      for (const g of r.glyphs) {
        const [id, ch, gap = 0] = Array.isArray(g) ? g : [g, undefined];
        x += gap;
        if (id === 32 || id === 160) { glyphLines.push(`g ${id} ${f2(x)} -1 ${id}`); x += r.size * 0.3; continue; }
        const key = r.size + ':' + GLYPHS[id], eo = GLYPHS[id] === 'E' ? 1 : 0;
        if (!oid.has(key)) { oid.set(key, outlines.length); outlines.push(`o ${outlines.length} ${eo} ${sh[GLYPHS[id]].split(' ').length} ${sh[GLYPHS[id]]}`); }
        glyphLines.push(`g ${id} ${f2(x)} ${oid.get(key)} ${ch === undefined ? id : ch}`);
        x += ADV[GLYPHS[id]] * r.size / 16 + (r.jitter ? (glyphLines.length % 3) * 0.13 : 0);
      }
      runLines.push(`r ${r.face} ${r.size} ${r.fill} ${r.y} ${glyphLines.length}`, ...glyphLines);
    }
    fs.writeFileSync(`${dir}/${name}.txt`, [...L, ...outlines, ...runLines].join('\n') + '\n');
  }
  page('A', [
    {face: 1, size: 16, fill: '000000ff', y: 20, x: 10, glyphs: [65, 66, 79, 32, 81, 69, 65, 66], jitter: true},
    {face: 1, size: 16, fill: '000000ff', y: 20, x: 150.37, glyphs: [66, 66, 79]},
    {face: 1, size: 16, fill: '11223344', y: 38.5, x: 10, glyphs: [79, 79, 32, 160, 65, 66, 32, 32, 69]},
    {face: 1, size: 120, fill: 'ff0000ff', y: 180, x: -5.5, glyphs: [65, 66, 79, 81]},
    {face: 1, size: 16, fill: '000000ff', y: -3.5, x: -20, glyphs: [65, 66]},
    {face: 2, size: 12, fill: '336699ff', y: 60, x: 7, glyphs: [[300, 65], [301, 65], [400, 0], 65, [500, 79]], jitter: true},
    {face: 2, size: 12, fill: '336699ff', y: 74.25, x: 7.5, glyphs: [66, 66, 32, 66, 79, 81, 69, 65], jitter: true},
  ]);
  page('B', [
    {face: 1, size: 16, fill: '000000ff', y: 20, x: 10, glyphs: [65, 66, 79, 32, 81, 69, 65, 66], jitter: true},
    {face: 1, size: 16, fill: '00aa00ff', y: 40, x: 10, glyphs: [66, 79, 79, 32, 65, 65, 65]},
    {face: 2, size: 12, fill: '336699ff', y: 60, x: 7, glyphs: [[300, 65], [301, 65], [400, 0], 65, [500, 79]], jitter: true},
    {face: 3, size: 24, fill: '000000ff', y: 100, x: 3, glyphs: [69, 81, 79, 66]},
    {face: 1, size: 120, fill: 'ff0000ff', y: 300.5, x: 20, glyphs: [66, 65]},
  ]);
  return [`${dir}/A.txt`, `${dir}/B.txt`];
}
