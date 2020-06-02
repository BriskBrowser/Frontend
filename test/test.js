const puppeteer = require('puppeteer');
const expect = require('chai').expect;
var express = require('express');
var PNG = require("pngjs").PNG;
var path = require('path');
var pixelmatch = require('pixelmatch');
const sleep = require('sleep-promise');
var firstFail = false;

async function takeAndCompareScreenshots(pages) {
  var screenshots = await Promise.all(pages.map(async x => {
    await x.evaluate(() => {document.documentElement.style.filter = 'blur(2px)';});
    await sleep(500);

    var s = await x.screenshot();
    return PNG.sync.read(s);
    }));
  
  expect(screenshots[0].width, 'image widths are the same').equal(screenshots[1].width);
  expect(screenshots[0].height, 'image heights are the same').equal(screenshots[1].height);

  const diff = new PNG({width: screenshots[0].width, height: screenshots[0].height});
  const numDiffPixels = pixelmatch(
      screenshots[0].data, screenshots[1].data, diff.data, screenshots[0].width, screenshots[0].height,
      {threshold: 0.2});

  // The files should look the same.
  expect(numDiffPixels, 'number of different pixels').equal(0);
}


describe('👀 screenshots are correct', function() {
  let server, serverBrowser, clientBrowser, pageBB, pageOriginal;

  // This is ran when the suite starts up.
  before(async function() {
    var app = express();

    app.use(express.static(path.join(__dirname, '../static')));
    app.use(express.static(__dirname));

    server = app.listen(3000);

  });

  // This is ran when the suite is done. Stop your server here.
  after(function(done) {
    this.timeout(10000);
    server.close(done);
  });

  // This is ran before every test. It's where you start a clean browser.
  beforeEach(async function() {
    serverBrowser = await puppeteer.launch({
          executablePath: path.join(__dirname, '../../chromium/src/out/Default/chrome'),
          userDataDir: path.join(__dirname, '../README.md/invaliddir'),
          args: [
            "--disable-extensions", '--no-sandbox',
            "--incognito", "--disable-features=TranslateUI,BlinkGenPropertyTrees",
            "--disable-threaded-scrolling", '--enable-features=DcheckIsFatal',
            "--user-agent=Mozilla/5.0 (Linux; Android 9; Pixel 3 XL; BRISKBROWSER) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/67.0.3396.87 Mobile Safari/537.36"],
      });

    var wsUrl = serverBrowser._connection._url.slice(0,-17);

    clientBrowser = await puppeteer.launch({args: ['--no-sandbox']});

    pageBB = await clientBrowser.newPage();
    await pageBB.evaluateOnNewDocument(`
      let BBOptionsOverrides = {
        websocketServer: '${wsUrl}',
        fullscreen: true,
        quality: 1.0,
      }
      `);
    await pageBB.emulate(puppeteer.devices['Pixel 2']);

    pageOriginal = await clientBrowser.newPage();
    await pageOriginal.emulate(puppeteer.devices['Pixel 2']);

  });

  // This is ran after every test; clean up after your browser.
  afterEach(async function() {
    if (this.currentTest.state === 'failed' && !firstFail) {
      console.log("Leaving server running for first failed test.  Client:", clientBrowser._connection._url, "Server:", serverBrowser._connection._url);
      firstFail = true;
      // a test just failed
    } else {
      serverBrowser.close();
      clientBrowser.close();
    }
  });

  describe('test page', function() {
    it('/view1', async function() {
      this.timeout(10000);
      var testURL = 'http://localhost:3000/helloworld.htm';
      await pageBB.goto('http://localhost:3000/?' + testURL);
      await pageOriginal.goto(testURL);
      
      await takeAndCompareScreenshots([pageBB, pageOriginal]);
    });
    // And your other routes, 404, etc.
  });

});