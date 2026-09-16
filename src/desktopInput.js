// Lazy-loaded for fine pointers. Wheel scrolling uses Session's native scroll
// containers and setScroll reconciliation, with a fallback for raster-only scrollers.
export const modifiers = e => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) |
  (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
const buttons = ['left', 'middle', 'right', 'back', 'forward'];

export class DesktopInput {
  constructor(session, root) {
    this.session = session;
    this.root = root;
    this.listeners = [];
    this.text = '';
    this.point = {x:0, y:0};
    root.tabIndex = -1;
    for (const type of ['pointerdown','pointermove','pointerup','pointercancel'])
      this.listen(root, type, e => this.pointer(type, e));
    this.listen(root, 'keydown', e => this.key(e), true);
    this.listen(root, 'wheel', e => this.wheel(e), {passive:false});
    this.listen(root, 'copy', e => this.copy(e));
    this.listen(root, 'cut', e => {
      if (e.target === session.keyboard) return;
      this.copy(e);
      Promise.resolve(this.selectionPending)
        .then(() => this.send('Input.dispatchKeyEvent', {type:'rawKeyDown',key:'Delete',code:'Delete',windowsVirtualKeyCode:46}))
        .then(() => this.send('Input.dispatchKeyEvent', {type:'keyUp',key:'Delete',code:'Delete',windowsVirtualKeyCode:46}))
        .then(() => {this.text = '';});
    });
    this.listen(root, 'pointerleave', e => {
      if (e.pointerType !== 'mouse' || this.pressed) return;
      this.flushMove(); this.frame = null;
      this.send('Input.dispatchMouseEvent', {type:'mouseMoved',x:-1,y:-1,button:'none',buttons:0});
      root.style.cursor = '';
      root.style.removeProperty('--brisk-cursor');
    });
    this.listen(root, 'paste', e => {
      if (e.target === session.keyboard) return; // native editing + value mirroring
      const text = e.clipboardData?.getData('text/plain');
      if (text !== undefined) {e.preventDefault(); this.send('Input.insertText', {text});}
    });
    this.listen(root, 'dragstart', e => e.preventDefault());
    this.listen(root, 'contextmenu', e => e.preventDefault());
    this.listen(session.keyboard, 'select', () => {
      const state = session.sessionState.keyboard;
      if (state.showing && !session.keyboardUpdateBlockedCtr &&
          (state.selectionStart !== session.keyboard.selectionStart || state.selectionEnd !== session.keyboard.selectionEnd))
        session.keyboardHandler({target:session.keyboard}).catch(console.error);
    });
    this.listen(window, 'blur', () => this.release());
  }
  listen(node, type, fn, options) {
    node.addEventListener(type, fn, options);
    this.listeners.push(() => node.removeEventListener(type, fn, options));
  }
  send(method, params) {
    return this.session.ws.req(method, params).catch(error => {
      if (!this.closed) console.warn('Desktop input:', error);
    });
  }
  flushMove() {
    cancelAnimationFrame(this.frame);
    if (!this.move) return;
    const move = this.move; this.move = null;
    this.send('Input.dispatchMouseEvent', move).then(() => this.refresh(false));
  }
  pointer(type, e) {
    if (e.pointerType !== 'mouse' || e.target.closest?.('[data-brisk-media]')) return;
    const rect = this.root.getBoundingClientRect();
    this.point = {x:e.clientX - rect.left, y:e.clientY - rect.top};
    const params = {...this.point, modifiers:modifiers(e), buttons:e.buttons,
      button: buttons[e.button] || 'none'};
    if (type === 'pointermove') {
      this.move = {...params, button:this.pressed || 'none', type:'mouseMoved'};
      if (!this.frame) this.frame = requestAnimationFrame(() => {this.frame = null; this.flushMove();});
      return;
    }
    this.flushMove(); this.frame = null;
    if (type === 'pointerdown') {
      e.preventDefault();
      this.reset();
      this.root.focus({preventScroll:true});
      this.root.setPointerCapture(e.pointerId);
      this.pressed = params.button;
      const now = performance.now();
      this.clickCount = this.lastClick && now - this.lastClick.time < 500 &&
        Math.hypot(params.x-this.lastClick.x, params.y-this.lastClick.y) < 5 &&
        this.lastClick.button === params.button ? this.clickCount % 3 + 1 : 1;
      this.lastClick = {...params, time:now};
      this.send('Input.dispatchMouseEvent', {...params,type:'mousePressed',clickCount:this.clickCount});
    } else {
      this.pressed = null;
      if (this.root.hasPointerCapture(e.pointerId)) this.root.releasePointerCapture(e.pointerId);
      this.selectionPending = this.send('Input.dispatchMouseEvent', {
        ...params,type:'mouseReleased',clickCount:this.clickCount || 1,
      }).then(() => this.refresh(true));
    }
  }
  async refresh(selection) {
    if (this.closed) return;
    if (!selection && this.refreshing) return;
    this.refreshing = true;
    const generation = this.generation || 0;
    try {
      const state = await this.send('PageStream.desktopState', {...this.point,selection});
      if (this.closed || !state || generation !== (this.generation || 0)) return;
      if (state.cursor && CSS.supports('cursor',state.cursor)) {
        this.root.style.cursor = state.cursor;
        this.root.style.setProperty('--brisk-cursor', state.cursor);
      }
      if (selection) this.text = state.text || '';
    } finally {this.refreshing = false;}
  }
  wheel(e) {
    if (e.ctrlKey || e.metaKey || e.target.matches?.('[data-brisk-media]')) return;
    const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.root.clientHeight : 1;
    let dx = e.deltaX * scale, dy = e.deltaY * scale;
    if (e.shiftKey && !dx) {dx = dy; dy = 0;}
    // Let the native browser scroll (and chain) represented containers. Some
    // non-composited inner scrollers are baked into raster tiles; only those
    // require a remote wheel event when there is no local scroll to perform.
    const canScroll = (position, maximum, delta) => delta < 0 ? position > 0 : delta > 0 && position < maximum;
    for (const node of e.composedPath()) {
      if (node.classList?.contains('scroll') &&
          (canScroll(node.scrollTop, node.scrollHeight-node.clientHeight, dy) ||
           canScroll(node.scrollLeft, node.scrollWidth-node.clientWidth, dx))) return;
      if (node === this.root) break;
    }
    e.preventDefault();
    const rect = this.root.getBoundingClientRect();
    this.send('Input.dispatchMouseEvent', {type:'mouseWheel',x:e.clientX-rect.left,y:e.clientY-rect.top,
      deltaX:dx,deltaY:dy,modifiers:modifiers(e)});
  }
  key(e) {
    if (e.target.matches?.('[data-brisk-media]')) return;
    // Native copy/paste and textarea editing stay in the local browser.
    if ((e.ctrlKey || e.metaKey) && ['c','v','x'].includes(e.key.toLowerCase())) return;
    if (e.target === this.session.keyboard && e.key !== 'Tab') return;
    const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
    if (printable || e.key === 'Tab' || e.key.startsWith('Arrow') ||
        ['Enter','Escape','Home','End','PageUp','PageDown','Backspace','Delete',' '].includes(e.key) ||
        ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a')) {
      e.preventDefault(); e.stopPropagation();
      this.text = '';
      const params = {key:e.key,code:e.code,windowsVirtualKeyCode:e.keyCode,modifiers:modifiers(e)};
      // The remote renderer runs on Linux; Command-A is the local Mac spelling
      // of its Control-A editing shortcut.
      if (e.metaKey && e.key.toLowerCase() === 'a') params.modifiers = (params.modifiers & ~4) | 2;
      const text = printable ? e.key : e.key === 'Enter' ? '\r' : null;
      this.selectionPending = this.send('Input.dispatchKeyEvent', {...params,type:'rawKeyDown'})
        .then(() => text && this.send('Input.dispatchKeyEvent', {...params,type:'char',text}))
        .then(() => this.send('Input.dispatchKeyEvent', {...params,type:'keyUp'}))
        .then(() => this.refresh(true));
    }
  }
  copy(e) {
    if (e.target === this.session.keyboard) return;
    e.preventDefault();
    if (this.text) e.clipboardData.setData('text/plain',this.text);
    else if (this.selectionPending && navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
      // Capture permission in this user gesture even if mouse-up is still in flight.
      navigator.clipboard.write([new ClipboardItem({'text/plain':this.selectionPending.then(() =>
        new Blob([this.text], {type:'text/plain'}))})]).catch(console.warn);
    }
  }
  reset() {this.generation = (this.generation || 0) + 1; this.text = ''; this.selectionPending = null;}
  release() {
    this.flushMove(); this.frame = null;
    if (this.pressed) this.send('Input.dispatchMouseEvent', {
      ...this.point,type:'mouseReleased',button:this.pressed,buttons:0,clickCount:1,
    });
    this.pressed = null;
  }
  destroy() {
    this.release(); this.closed = true;
    this.listeners.forEach(remove => remove());
  }
}
