const puppeteer = require('puppeteer');
const expect = require('chai').expect;
const express = require('express');
const sharp = require("sharp");
const path = require('path');
const pixelmatch = require('pixelmatch');
const sleep = require('sleep-promise');
var firstFail = false;

async function takeAndCompareScreenshots(pages) {
  var screenshots = await Promise.all(pages.map(async x => {
    var p = await x;

    var s = await p.screenshot();
    var img = sharp(s);

    // Blur used because text rendering seems subtly different between the server and client/
    // TODO:  Figure out how to do pixel-perfect rendering.
    return {data: await img.blur(5).raw().toBuffer(), meta: await img.metadata()};
  }));
  
  const numDiffPixels = pixelmatch(
      screenshots[0].data, screenshots[1].data, null, screenshots[0].meta.width, screenshots[0].meta.height,
      {threshold: 0.2});

  // The files should look the same.
  expect(numDiffPixels, 'number of different pixels').equal(0);
}

async function testLoadingPage(pagename, pages) {
  var testURL = 'http://localhost:3000/'+pagename;
  
  pages = pages.map(async (x) => {
    var p = await x;
    await p.goto(testURL);
    return p;
  });
  
  await takeAndCompareScreenshots(pages);
}

function setupWebserver() {
  var app = express();

  app.use(express.static(path.join(__dirname, '../static')));
  app.use(express.static(path.join(__dirname, 'testData')));

  return app.listen(3000);
}


function testSkeleton() {
  this.timeout(10000);

  // To cover some race condition where PageStream.flush() can fail to flush a previously completed
  // Emulation.setDeviceMetricsOverride call (used to resize the window and set the DevicePixelRatio)
  this.retries(3);

  let webServer, serverBrowser, clientBrowser;

  var pages = this.pages = [];

  before(function() { webServer = setupWebserver(); });

  after(function(done) { webServer.close(done); });

  // This is ran before every test. It's where you start a clean browser.
  beforeEach(async function() {
    serverBrowser = await puppeteer.launch({
          executablePath: path.join(__dirname, '../../chromium/src/out/Default/chrome'),
          userDataDir: path.join(__dirname, '../README.md/invaliddir'),
          //dumpio: true,
          args: [
            "--disable-extensions", '--no-sandbox',
            "--incognito", "--disable-features=TranslateUI,BlinkGenPropertyTrees",
            "--disable-threaded-scrolling", '--enable-features=DcheckIsFatal',
            "--user-agent=Mozilla/5.0 (Linux; Android 9; Pixel 3 XL; BRISKBROWSER) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/67.0.3396.87 Mobile Safari/537.36"],
      });

    var wsUrl = serverBrowser._connection._url.slice(0,-17);

    clientBrowser = await puppeteer.launch({args: ['--no-sandbox']});

    // all setup needed for briskbrowser
    pages[0] = (async () => {
      var page = await clientBrowser.newPage();
      await page.evaluateOnNewDocument(`
        let BBOptionsOverrides = {
          websocketServer: '${wsUrl}',
          fullscreen: true,
          quality: 1.0,
        }

        class tracedWebsocket extends WebSocket {
        constructor(host){
          super(host)
          this.tracedMessages = [];
          window.tracedSocket = this;
          this.addEventListener('message', (evt) => {
            this.tracedMessages.push(JSON.parse(evt.data))
          });
        }}
        window.WebSocket = tracedWebsocket;

        `);
      await page.emulate(puppeteer.devices['Pixel 2']);
      var goto = page.goto.bind(page);
      page.goto = async (url) => {
        var res = await goto('http://localhost:3000/?' + url);

        // wait till we see serverside domcontentloaded
        await page.waitForFunction(() => {
          var state=0;
          window.tracedSocket.tracedMessages.forEach(x => {
            if (state==0 && x.method == 'Page.domContentEventFired') state++;
          });
          return state==1;
        });
        await page.flush();
        return res;
      };
      page.flush = async () => {
        // wait for no in-flight requests
        await page.waitForFunction(() => {
          return Object.keys(Object.values(window.sessions)[0].ws.wrappedSocket.callbacks).length==0;
        })
        //flush all sessions
        await page.evaluate(() => {
          return Promise.all(Object.values(window.sessions).map(s=> {
            return s.ws.req('PageStream.flush')
          }));
        })
      }
      return page;
    })();

    // setup needed for regular page
    pages[1] = (async () => {
      var page = await clientBrowser.newPage();
      await page.emulate(puppeteer.devices['Pixel 2']);
      return page;
    })();

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
}


module.exports = {testSkeleton, testLoadingPage, takeAndCompareScreenshots};