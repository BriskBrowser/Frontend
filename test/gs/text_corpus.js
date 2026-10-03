// Reader for the line-based corpus export (implstream chromium/src/brisk_gpu/text/test/corpus_export.cjs):
//   page <name> <scale> <lattice>
//   o <idx> <evenodd> <ntokens> tok...      M x y | L | Q | C | Z (SVG rules: coordinate groups repeat the verb, M repeats as L)
//   r <face> <size> <fill rrggbbaa> <y> <nglyphs>
//   g <codepoint = glyph id> <x> <outlineIdx or -1> [char; default = codepoint, 0 = unknown]
// -> {name, scale, runs:[{face,size,fill,y,glyphs:[{glyph_id,ch,x}]}], outline(face,glyph,size)}
import fs from 'node:fs';

function parseOutline(tokens, evenOdd) {
  const verbs = [], pts = []; let i = 0, verb = null;
  const num = () => +tokens[i++];
  while (i < tokens.length) {
    if (/[MLQCZ]/.test(tokens[i])) verb = tokens[i++];
    if (verb === 'Z') { verbs.push(4); verb = null; continue; }
    if (verb === 'M') { verbs.push(0); pts.push(num(), num()); verb = 'L'; continue; }
    if (verb === 'L') { verbs.push(1); pts.push(num(), num()); continue; }
    if (verb === 'Q') { verbs.push(2); pts.push(num(), num(), num(), num()); continue; }
    if (verb === 'C') { verbs.push(3); pts.push(num(), num(), num(), num(), num(), num()); continue; }
    throw new Error('bad outline token ' + tokens[i]);
  }
  return {verbs: Uint8Array.from(verbs), pts: Float32Array.from(pts), even_odd: !!evenOdd};
}
export function readPage(file, cipher = false) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const page = {name: '', scale: 1, lattice: 0, runs: []}, outlines = [], table = new Map();
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].split(' ');
    if (t[0] === 'page') { page.name = t[1]; page.scale = Math.fround(+t[2]); page.lattice = +t[3]; }
    else if (t[0] === 'o') outlines[+t[1]] = parseOutline(t.slice(4, 4 + +t[3]), +t[2]);
    else if (t[0] === 'r') {
      const n = +t[5], run = {face: +t[1], size: Math.fround(+t[2]), fill: parseInt(t[3], 16) >>> 0, y: Math.fround(+t[4]), glyphs: []};
      for (let k = 0; k < n; k++) {
        const g = lines[++i].split(' '), cp = +g[1], o = +g[3];
        run.glyphs.push({glyph_id: cp, ch: cipher ? 0 : g[4] !== undefined ? +g[4] : cp, x: Math.fround(+g[2])});
        table.set(run.face + ':' + run.size + ':' + cp, o < 0 ? {verbs: new Uint8Array(0), pts: new Float32Array(0), even_odd: false} : outlines[o]);
      }
      page.runs.push(run);
    }
  }
  page.outline = (face, glyph, size) => table.get(face + ':' + Math.fround(size) + ':' + glyph) ?? null;
  page.glyphCount = page.runs.reduce((a, r) => a + r.glyphs.length, 0);
  return page;
}
export const CORPUS_DIR = process.env.TEXT_CORPUS || '/home/sd/.claude/jobs/5092cee3/tmp/text/corpus';
export function corpusFiles(kind) {
  const d = CORPUS_DIR + '/' + kind;
  return fs.existsSync(d) ? fs.readdirSync(d).filter(f => f.endsWith('.txt')).sort().map(f => d + '/' + f) : [];
}
