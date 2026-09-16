// Shared by the inline early socket and the module client's reconnect path.
(function(root) {
  root.briskViewport = function() {
    const box = document.getElementById('browser')?.getBoundingClientRect();
    const width = Math.floor(box?.width || (innerWidth >= 800 ? 360 : innerWidth));
    const height = Math.floor(box?.height || (innerWidth >= 800 ? 640 : innerHeight));
    const dpr = devicePixelRatio || 1;
    try {
      document.cookie = 'briskViewport=' + encodeURIComponent(JSON.stringify([width,height,dpr])) +
        '; Path=/; Max-Age=31536000; SameSite=Lax' + (location.protocol === 'https:' ? '; Secure' : '');
    } catch (_) {}
    return {w:width, h:height, dpr};
  };
})(globalThis);
