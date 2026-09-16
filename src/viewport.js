// Shared by the inline early socket and the module client's reconnect path.
(function(root) {
  root.briskViewport = function() {
    const box = document.getElementById('browser')?.getBoundingClientRect();
    const width = Math.floor(box?.width || innerWidth);
    const height = Math.floor(box?.height || innerHeight);
    const desktop = !!root.matchMedia?.('(any-pointer: fine)').matches;
    const dpr = devicePixelRatio || 1;
    try {
      document.cookie = 'briskViewport=' + encodeURIComponent(JSON.stringify(desktop ? [width,height,dpr,true] : [width,height,dpr])) +
        '; Path=/; Max-Age=31536000; SameSite=Lax' + (location.protocol === 'https:' ? '; Secure' : '');
    } catch (_) {}
    return desktop ? {w:width, h:height, dpr, desktop:1} : {w:width, h:height, dpr};
  };
})(globalThis);
