'use strict';
// Layers keep the compositor's global draw order across transform nodes.
//
// A node used to be given z-index = max(z of its layers). That makes it a
// stacking context, so a page's white root background (order 0) that shares a
// node with a fixed header (order 6) was lifted above the scrolling content
// (order 1): Pinterest, Twitch and Stack Overflow rendered only the header.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const puppeteer = require('puppeteer');
(async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/') return res.end('<body style="margin:0"></body>');
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
      session.stickyOffsetPx = () => null;
      session.domElement_ = document.body;
      const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
      const root = {};
      let nextId = 1;
      // Built through createDOMTransformNode, as the client builds real nodes.
      const node = (zIndex, extra = {}) => {
        const t = {id: nextId++, parent_id: root, local: identity, origin: [0, 0, 0],
          post_translation: [0, 0, 0], ...extra};
        session.createDOMTransformNode(t, zIndex);
        return t;
      };
      const layer = (parent, zIndex, color) => {
        const dom = document.createElement('div');
        dom.style.cssText = `position:absolute;left:0;top:0;width:100px;height:100px;background:${color}`;
        dom.style.zIndex = zIndex;
        parent.dom.appendChild(dom);
      };
      // Header node: root background (order 0) and header (order 6).
      // Content node: the page content (order 1).
      const header = node(6), content = node(1);
      layer(header, 0, 'rgb(255,255,255)');
      layer(content, 1, 'rgb(255,0,0)');
      layer(header, 6, 'rgb(0,0,255)');
      const top = (x, y) => getComputedStyle(document.elementFromPoint(x, y)).backgroundColor;
      // Move the header layer away so only the background of its node overlaps.
      header.dom.lastChild.style.top = '200px';
      const moved = node(3, {local: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1]});
      return {
        plain: header.dom.style.zIndex,
        transformed: moved.dom.style.zIndex,
        contentOverBackground: top(50, 50),
      };
    });
    assert.equal(result.plain, '', 'a node without a transform must not become a stacking context');
    assert.equal(result.transformed, '3', 'a node with a transform is a stacking context anyway and keeps its order');
    assert.equal(result.contentOverBackground, 'rgb(255, 0, 0)',
      'content (order 1) must paint over the root background (order 0) that shares a node with a later layer');
    console.log('layer stacking: ok');
  } finally {
    if (browser) await browser.close();
    server.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
