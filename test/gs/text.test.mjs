// TEXT codec tests: C++ encoder (chromium/src/brisk_gpu/text) vs the JS decoder and the JS reference encoder.
// Needs the C++ test binary (test/run_text_tests.sh builds it) and the corpus export (see text_corpus.js); both
// groups of tests skip when absent. Env: TEXT_TEST_BIN, TEXT_CORPUS.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {TextDecoder2, State, codeBand, drawRuns, masterSegments, roundDiv, readVarint, LIMITS} from '../../src/gs/text.js';
import {RefEncoder, RansEncoder} from './text_ref_encoder.js';
import {readPage, corpusFiles} from './text_corpus.js';
import {writeSynth} from './text_synth.js';

const BIN = process.env.TEXT_TEST_BIN || '/home/sd/.claude/jobs/5092cee3/tmp/text/text_test';
const HAVE_BIN = fs.existsSync(BIN);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'text-test-'));
const cpp = (...args) => execFileSync(BIN, args, {encoding: 'utf8', maxBuffer: 1 << 26});
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// Encodes `files` as one stream with the C++ encoder and the JS reference encoder, decodes with one TextDecoder2.
function checkSequence(files, {cipher = false, rollback = false, checkSym = true} = {}) {
  const out = fs.mkdtempSync(path.join(TMP, 'seq-'));
  const stdout = cpp('encode', '--out', out, ...(cipher ? ['--cipher'] : []), ...(rollback ? ['--rollback'] : []), ...files);
  const enc = new RefEncoder(), dec = new TextDecoder2();
  const rows = [];
  files.forEach((file, n) => {
    const page = readPage(file, cipher);
    const body = new Uint8Array(fs.readFileSync(`${out}/${n}.bin`));
    const recon = fs.readFileSync(`${out}/${n}.recon`, 'utf8').trim().split('\n').map(l => l.split(' '));
    const ref = enc.encodeBand({runs: page.runs, outlines: page.outline, cssScale: page.scale});
    assert.ok(same(ref.body, body), `${path.basename(file)}: C++ and JS reference encoders differ (${body.length} vs ${ref.body.length} bytes)`);
    const t0 = process.hrtime.bigint();
    const runs = dec.decodeBand(body);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const q = +recon[0][1], lattice = recon[0][2] === '1';
    assert.equal(runs.length, recon.length - 1);
    let glyphs = 0, maxErr = 0, exact = 0;
    runs.forEach((run, i) => {
      const [, idx, yu, ...xs] = recon[i + 1];
      assert.equal(run.y * 256, +yu);
      const src = page.runs[+idx], ink = src.glyphs.filter(g => page.outline(src.face, g.glyph_id, src.size).verbs.some(v => v >= 1 && v <= 3));
      assert.equal(run.glyphs.length, xs.length);
      assert.equal(run.glyphs.length, ink.length);
      assert.ok(Math.abs(run.y * 256 - src.y * 256) <= q / 2 + 0.5, 'baseline error');
      assert.equal(run.fill, src.fill);
      assert.equal(run.size, Math.floor(src.size * 64 + 0.5) / 64);
      run.glyphs.forEach((g, k) => {
        assert.equal(g.x * 256, +xs[k]);
        const err = Math.abs(g.x * 256 - ink[k].x * 256);
        assert.ok(err <= q / 2 + 0.5, `${path.basename(file)} run ${i} glyph ${k}: position error ${err} u > ${q / 2 + 0.5}`);
        if (!cipher && checkSym) assert.equal(g.sym, ink[k].ch);
        maxErr = Math.max(maxErr, err); if (err <= 0.5) exact++; glyphs++;
      });
    });
    rows.push({name: path.basename(file, '.txt'), glyphs, bytes: body.length, q, lattice, maxErr: maxErr / 256, exact: exact / glyphs, decMs: ms});
  });
  return {rows, stdout};
}
const fmt = r => `${r.name.padEnd(14)} ${String(r.glyphs).padStart(5)} glyphs ${String(r.bytes).padStart(6)} B ${(r.bytes / r.glyphs).toFixed(2)} B/g  q=${r.q}${r.lattice ? ' lattice' : ''} maxErr=${r.maxErr.toFixed(3)}px exact=${(100 * r.exact).toFixed(0)}% dec=${r.decMs.toFixed(0)}ms`;

const single = corpusFiles('single'), multiAll = corpusFiles('multi');
const multi = new Map();
for (const f of multiAll) { const site = path.basename(f).replace(/-\d+\.txt$/, ''); (multi.get(site) || multi.set(site, []).get(site)).push(f); }
const skipCpp = HAVE_BIN ? false : 'C++ test binary not built';
const skipCorpus = single.length ? false : 'corpus not exported';

test('single pages: C++ == JS reference bytes, JS decoder reconstructs, positions bounded', {skip: skipCpp || skipCorpus}, () => {
  let g = 0, b = 0, ms = 0;
  for (const f of single) {
    const {rows} = checkSequence([f]); const r = rows[0];
    console.log(fmt(r)); g += r.glyphs; b += r.bytes; ms += r.decMs;
    if (r.lattice) assert.ok(r.maxErr <= 3 / 256 + 1e-9, 'lattice pages are reconstructed exactly (to input precision)');
  }
  console.log(`TOTAL ${g} glyphs ${b} B = ${(b / g).toFixed(3)} B/glyph (research prototype: 6.5), decode ${ms.toFixed(0)} ms`);
  assert.ok(b / g < 7.0);
});
test('single pages without characters (cipher mode)', {skip: skipCpp || skipCorpus}, () => {
  let g = 0, b = 0, g0 = 0, b0 = 0;
  for (const f of single) {
    const c = checkSequence([f], {cipher: true}).rows[0], k = checkSequence([f]).rows[0];
    g += c.glyphs; b += c.bytes; g0 += k.glyphs; b0 += k.bytes;
  }
  console.log(`cipher mode ${(b / g).toFixed(3)} B/glyph vs characters ${(b0 / g0).toFixed(3)}`);
  assert.ok(b / g < 7.5);
});
test('multi-page sequences with persistent state', {skip: skipCpp || skipCorpus || !multi.size}, () => {
  for (const cipher of [false, true]) {
    const tot = {g: 0, b: 0};
    for (const [site, files] of multi) {
      const {rows} = checkSequence(files, {cipher});
      const tail = rows.slice(1), g = tail.reduce((a, r) => a + r.glyphs, 0), b = tail.reduce((a, r) => a + r.bytes, 0);
      console.log(`${cipher ? 'cipher ' : 'chars  '} ${site.padEnd(12)} page0 ${rows[0].bytes} B (${(rows[0].bytes / rows[0].glyphs).toFixed(2)} B/g); pages 2..N ${(b / g).toFixed(2)} B/glyph, ${Math.round(b / tail.length)} B/page`);
      assert.ok(rows[1].bytes < rows[0].bytes, 'sibling pages must be cheaper than the first');
      tot.g += g; tot.b += b;
    }
    console.log(`${cipher ? 'cipher' : 'chars'} mean pages 2..N ${(tot.b / tot.g).toFixed(3)} B/glyph`);
  }
});
test('C++ rollback before commit re-encodes identically (corpus sequence)', {skip: skipCpp || skipCorpus || !multi.size}, () => {
  checkSequence([...multi.values()][0], {rollback: true});
});

const synth = HAVE_BIN ? writeSynth(path.join(TMP, 'synth')) : null;
test('synthetic bands: cubics, size buckets, negative coords, alpha, symbol collisions, even-odd, blank glyphs', {skip: skipCpp}, () => {
  const {rows} = checkSequence(synth, {checkSym: false});
  rows.forEach(r => console.log(fmt(r)));
  const ref = new RefEncoder(); const page = readPage(synth[0]);
  const dec = new TextDecoder2(), runs = dec.decodeBand(ref.encodeBand({runs: page.runs, outlines: page.outline, cssScale: 2}).body);
  const masters = new Set(runs.flatMap(r => r.glyphs.map(g => g.master)));
  assert.ok([...masters].some(m => m.eo === 1), 'even-odd flag survives');
  const syms = runs.flatMap(r => r.glyphs.map(g => g.sym));
  assert.ok(syms.some(s => s >= 0xE000 && s < 0xF900), 'unknown characters and collisions fall back to cipher symbols');
  const faces = new Set(runs.map(r => r.face));
  assert.ok(faces.size >= 3, 'face 1 at 16 px and 120 px use different master slots');
  // a cubic circle is approximated by quads: every segment is M/L/Q/Z and the bbox is right
  const o = runs.filter(r => r.size === 16).flatMap(r => r.glyphs).find(g => g.sym === 79).master, segs = masterSegments(o);
  assert.ok(segs.every(s => 'MLQZ'.includes(s[0])) && segs.filter(s => s[0] === 'Q').length >= 4);
  const xs = segs.filter(s => s.length >= 3).flatMap(s => s.slice(1).filter((_, i) => i % 2 === 0));
  const grid = o.grid / 1000, w = (Math.max(...xs) - Math.min(...xs)) * grid;
  assert.ok(Math.abs(w - 10) < 0.3, `circle width ${w}`);
});
test('C++ unit tests: rollback/replace/pending/failed encodes', {skip: skipCpp}, () => {
  const out = cpp('unit', synth[0], synth[1]);
  console.log(out.trim());
  assert.match(out, /unit ok/);
});

// ---- decoder fault injection --------------------------------------------------------------------------------
function bodies() {
  const files = (multi.get('hackernews') || []).slice(0, 3);
  const enc = new RefEncoder();
  return files.map(f => { const p = readPage(f); return enc.encodeBand({runs: p.runs, outlines: p.outline, cssScale: p.scale}).body; });
}
const summary = runs => JSON.stringify(runs.map(r => [r.font, r.face, r.size, r.fill, r.y, r.glyphs.map(g => [g.x, g.sym, g.master.contours.length])]));
test('decoder faults throw and commit nothing', {skip: skipCorpus || !multi.size}, () => {
  const [b0, b1, b2] = bodies();
  const clean = new TextDecoder2(); clean.decodeBand(b0); const want1 = summary(clean.decodeBand(b1)), want2 = summary(clean.decodeBand(b2));
  const bad = [];
  bad.push(['truncated', b1.slice(0, b1.length - 7)], ['truncated to header', b1.slice(0, 3)], ['empty rANS', b1.slice(0, 2)]);
  const [, fo] = readVarint(b1, 0);
  bad.push(['trailing byte', Uint8Array.from([...b1, 0])], ['bad flags', Uint8Array.from([...b1.slice(0, fo), 2, ...b1.slice(fo + 1)])]);
  bad.push(['quantum 0', Uint8Array.from([0, ...b1.slice(fo)])], ['oversize', new Uint8Array(LIMITS.maxBody + 1)]);
  for (const pos of [5, Math.floor(b1.length / 3), Math.floor(b1.length / 2), b1.length - 2]) { const c = Uint8Array.from(b1); c[pos] ^= 0x55; bad.push(['flipped byte ' + pos, c]); }
  bad.push(['garbage', Uint8Array.from({length: 300}, (_, i) => (i * 97 + 13) & 255)]);
  // b2 needs b1's state: applying it right after b0 references fonts/masters the decoder does not have
  bad.push(['unknown ids (missing state)', b2]);
  const dec = new TextDecoder2(); dec.decodeBand(b0);
  let thrown = 0;
  for (const [name, bytes] of bad) {
    try { dec.decodeBand(bytes); assert.fail(name + ' decoded without error'); } catch (e) { if (e.code === 'ERR_ASSERTION') throw e; thrown++; }
  }
  assert.equal(thrown, bad.length);
  assert.equal(summary(dec.decodeBand(b1)), want1, 'state untouched by the failed packets');
  assert.equal(summary(dec.decodeBand(b2)), want2);
  assert.deepEqual(dec.decodeBand(new Uint8Array(0)), [], 'empty body is an empty band');
});
test('reset() returns to the initial state', {skip: skipCorpus || !multi.size}, () => {
  const [b0, b1] = bodies();
  const d = new TextDecoder2(); const a = summary(d.decodeBand(b0)); d.decodeBand(b1); d.reset();
  assert.equal(summary(d.decodeBand(b0)), a);
});
test('replace semantics: a band decodes to its full run set regardless of the previous band', {skip: skipCorpus || !multi.size}, () => {
  const [b0] = bodies();
  const d = new TextDecoder2(); const r1 = d.decodeBand(b0);
  assert.ok(r1.length > 5);
  assert.deepEqual(d.decodeBand(new Uint8Array(0)), []);   // the caller replaces its band entry with []
});

// ---- rANS lane compatibility with the flat coder (adapt.js) ---------------------------------------------------
const ADAPT = '/workspace/root/.claude/worktrees/tree-codec-capture/experiments/tree-codec/research/combined/adapt.js';
test('rANS: a text stream decodes through flat-coder adapt.js Dec (probability injected per bit)', {skip: !fs.existsSync(ADAPT)}, () => {
  const A = createRequire(import.meta.url)(ADAPT);
  // random bits with arbitrary probabilities
  let seed = 12345; const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296;
  const ps = [], bits = [], enc = new RansEncoder();
  for (let i = 0; i < 20000; i++) { const p = 200 + Math.floor(rnd() * 32000); ps.push(p); bits.push(rnd() * 32768 < p ? 1 : 0); enc.bit(p, bits[i]); }
  const buf = enc.finish(), d = new A.Dec([{nb: 1, nctx: 1}], Buffer.from(buf));
  for (let i = 0; i < bits.length; i++) { d.m.p[0][1] = ps[i] * 2; assert.equal(d.bit(0, 1), bits[i]); }
  // the real text codec, driven through adapt.js's decoder
  if (!single.length) return;
  const page = readPage(single.find(f => f.endsWith('hackernews.txt')));
  const body = new RefEncoder().encodeBand({runs: page.runs, outlines: page.outline, cssScale: page.scale}).body;
  const want = summary(new TextDecoder2().decodeBand(body));
  const [q, o] = readVarint(body, 0);
  const ad = new A.Dec([{nb: 1, nctx: 1}], Buffer.from(body.subarray(o + 1)));
  const proxy = {dec: true, bit(p) { ad.m.p[0][1] = p * 2; return ad.bit(0, 1); }};
  const S = new State(); S.begin(); S.q = q;
  S.lattice = !!body[o];
  assert.equal(summary(codeBand(proxy, S, null, null)), want, 'text lane decoded by adapt.js Dec == by TextDecoder2');
});

// ---- rendering ------------------------------------------------------------------------------------------------
test('drawRuns scales masters by size/master size and places glyphs', {skip: skipCorpus}, () => {
  const page = readPage(single.find(f => f.endsWith('hackernews.txt')));
  const runs = new TextDecoder2().decodeBand(new RefEncoder().encodeBand({runs: page.runs, outlines: page.outline, cssScale: page.scale}).body);
  const calls = [];
  class P { constructor() { this.n = []; } moveTo() { this.n.push('M'); } lineTo() { this.n.push('L'); } quadraticCurveTo() { this.n.push('Q'); } closePath() { this.n.push('Z'); } }
  const ctx = {save() {}, restore() {}, setTransform(...a) { calls.push(a); }, fill(p, rule) { calls.push(['fill', p.n.length, rule]); }, set fillStyle(v) { calls.push(['style', v]); }};
  drawRuns(ctx, runs, 2, 10, 20, P);
  const t = calls.filter(c => typeof c[0] === 'number'), g0 = runs[0].glyphs[0], m = g0.master;
  const k = 2 * (m.grid / 1000) * (runs[0].size * 64 / m.msize64);
  assert.deepEqual(t[0], [k, 0, 0, k, 10 + g0.x * 2, 20 + runs[0].y * 2]);
  assert.equal(calls.filter(c => c[0] === 'fill').length, runs.reduce((a, r) => a + r.glyphs.length, 0));
  assert.ok(calls.find(c => c[0] === 'style')[1].startsWith('#'));
});
test('roundDiv rounds half up, exactly, beyond 2^31', () => {
  assert.equal(roundDiv(-5, 2), -2); assert.equal(roundDiv(5, 2), 3); assert.equal(roundDiv(-7, 3), -2); assert.equal(roundDiv(0, 5), 0);
  assert.equal(roundDiv(2 ** 40 + 1, 7), Math.floor((2 ** 40 + 1) / 7 + 0.5)); assert.equal(roundDiv(-(2 ** 40) - 3, 11), -99857989 * 11 === 0 ? 0 : roundDiv(-(2 ** 40) - 3, 11));
});
