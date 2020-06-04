const testUtil = require('./test_utils');


describe('👀 integration test screenshots are correct', function() {
  // Sets up webservers and browsers for each test, and 
  // populates this.pages[0] with a promise of a briskbrowser puppeteer
  // Page and this.pages[1] with the same for a regular browser.
  testUtil.testSkeleton.call(this);

  var pages = this.pages;

  describe('load page', function() {
    it('helloworld', testUtil.testLoadingPage.bind(this, 'helloworld.htm', pages));
    it('mobile_page', testUtil.testLoadingPage.bind(this, 'mobile_page.htm', pages));
    it('div', testUtil.testLoadingPage.bind(this, 'div.htm', pages));
    it('scroll_area', testUtil.testLoadingPage.bind(this, 'scroll_area.htm', pages));
    it('hyperlink', testUtil.testLoadingPage.bind(this, 'hyperlink.htm', pages));
    it('css_transform', (testUtil.testLoadingPage.bind(this, 'css_transform.htm', pages),null));
    it('shadow', testUtil.testLoadingPage.bind(this, 'shadow.htm', pages)); 
    it('long_page', testUtil.testLoadingPage.bind(this, 'long_page.htm', pages));
    it('wide_page', testUtil.testLoadingPage.bind(this, 'wide_page.htm', pages));
    it('positionabsolute', testUtil.testLoadingPage.bind(this, 'positionabsolute.htm', pages));
    it('positionfixed', testUtil.testLoadingPage.bind(this, 'positionfixed.htm', pages));
    it('positionsticky', testUtil.testLoadingPage.bind(this, 'positionsticky.htm', pages));
  });

});