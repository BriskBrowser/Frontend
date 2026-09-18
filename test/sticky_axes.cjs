'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const puppeteer = require('puppeteer');
(async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/') return res.end('<body></body>');
    res.setHeader('Content-Type', 'text/javascript');
    res.end(fs.readFileSync(path.join(__dirname, '../src', path.basename(req.url.split('?')[0]))));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await puppeteer.launch({executablePath: process.env.TEST_BROWSER || '/usr/bin/chromium',
      headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage']});
    const page = await browser.newPage();
    await page.goto('http://127.0.0.1:' + server.address().port);
    const result = await page.evaluate(async () => {
      const {Session} = await import('/session.js');
      const session = Object.create(Session.prototype);
      const scroller = (x, y) => ({transform_id: {dom: {scrollLeft: x, scrollTop: y}}});
      const horizontal = scroller(80, 999), vertical = scroller(999, 120);
      const constraints = {
        isAnchoredLeft: true, isAnchoredTop: true, leftOffset: 0, topOffset: 0,
        constraintBoxRect: [0, 0, 100, 100],
        scrollContainerRelativeStickyBoxRect: [20, 30, 10, 10],
        scrollContainerRelativeContainingBlockRect: [0, 0, 500, 500],
      };
      const modern = {dom: {}, sticky: {...constraints,
        xScrollAncestor: horizontal, yScrollAncestor: vertical}};
      const legacy = {sticky: {...constraints, scrollAncestor: scroller(80, 120)}};
      const invalid = {sticky: {...constraints, scrollAncestor: horizontal,
        xScrollAncestor: null, yScrollAncestor: null, pixelSnapOffset: [0.6, 0.2]}};
      const ancestor = {sticky: {...constraints, xScrollAncestor: horizontal,
        yScrollAncestor: scroller(0, 300)}};
      const nested = {sticky: {...constraints, xScrollAncestor: horizontal,
        yScrollAncestor: vertical, nearestNodeShiftingStickyBox: ancestor}};
      let refreshes = 0;
      session.sessionState = {transform_tree: [modern]};
      session.applyTransformCss = () => ++refreshes;
      session.refreshStickyFor(horizontal.transform_id);
      session.refreshStickyFor(vertical.transform_id);
      session.refreshStickyFor({});
      return {modern: session.stickyOffsetPx(modern), legacy: session.stickyOffsetPx(legacy),
        invalid: session.stickyOffsetPx(invalid), nested: session.stickyOffsetPx(nested), refreshes};
    });
    assert.deepEqual(result.modern, {x: 60, y: 90});
    assert.deepEqual(result.legacy, result.modern);
    assert.deepEqual(result.invalid, {x: 1, y: 0});
    assert.deepEqual(result.nested, {x: 0, y: 90});
    assert.equal(result.refreshes, 2);
    console.log('PASS sticky axes: separate scrollers, legacy input, invalid ancestors, pixel snapping, nested constraints and live refresh');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
