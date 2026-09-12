// The startup module graph must load each file under exactly one URL (a
// second version token downloads and instantiates it twice), and index.html
// must preload every module the entry point reaches.
import assert from 'assert';
import fs from 'fs';
const src = new URL('../src/', import.meta.url);
const html = fs.readFileSync(new URL('index.html', src), 'utf8');
const entry = /<script src='\/([^']+)' type="module">/.exec(html)[1];
const preloads = new Set([...html.matchAll(/rel='modulepreload' href='\/([^']+)'/g)].map(m => m[1]));
const seen = new Map(), queue = [entry];
while (queue.length) {
  const url = queue.shift(), file = url.split('?')[0];
  if (seen.has(file)) {
    assert.equal(seen.get(file), url, `${file} imported as both ${seen.get(file)} and ${url}`);
    continue;
  }
  seen.set(file, url);
  const source = fs.readFileSync(new URL(file, src), 'utf8');
  for (const m of source.matchAll(/^import\s+(?:[^'"]+from\s+)?['"]\.\/([^'"]+)['"]/gm)) queue.push(m[1]);
}
const reachable = new Set([...seen.values()].filter(url => url !== entry));
assert.deepEqual([...preloads].sort(), [...reachable].sort(), 'modulepreload list must equal the startup graph');
console.log('PASS module graph: one URL per module,', reachable.size, 'preloaded');
