import {deepClone} from './deepclone.js'
import {interactionTrace} from './interactionTrace.js?v=20260827-trace1'
import {applyPropTreePatch} from './propTreePatch.js'

// Keys forwarded to the real page as genuine CDP key events (see
// keyboardKeyHandler below) rather than through the value-mirroring
// PageStream.setKeyboardState path. `code` is the Windows virtual-key code
// Input.dispatchKeyEvent expects; `domCode` is the DOM UIEvents `code`
// string; `text` is only set for keys that actually produce a character
// (only Enter, here -- '\r'), since sending an empty-string char event for
// a pure navigation key like an arrow would incorrectly signal "this key
// types a character" to anything inspecting the dispatched event.
const SPECIAL_KEY_CODES = {
  Enter: {code: 13, domCode: 'Enter', text: '\r'},
  Escape: {code: 27, domCode: 'Escape'},
  ArrowLeft: {code: 37, domCode: 'ArrowLeft'},
  ArrowUp: {code: 38, domCode: 'ArrowUp'},
  ArrowRight: {code: 39, domCode: 'ArrowRight'},
  ArrowDown: {code: 40, domCode: 'ArrowDown'},
  Home: {code: 36, domCode: 'Home'},
  End: {code: 35, domCode: 'End'},
};

// Network counterpart of cc/base/synced_property.h (AdditionGroup).
// The active tree draws base + delta. A pending renderer commit replaces the
// base and subtracts ONLY the client deltas that commit already reflects.
// Cumulative reflected values generalize Chromium's single in-flight commit
// bookkeeping to an ordered network with multiple outstanding delta batches.
export class SyncedScrollOffset {
  constructor(x = 0, y = 0) {
    this.baseX = x; this.baseY = y;
    this.deltaX = 0; this.deltaY = 0;
    this.reflectedX = 0; this.reflectedY = 0;
    this.sentX = 0; this.sentY = 0;
    this.sequence = 0; this.revision = -1;
  }
  get x() { return this.baseX + this.deltaX; }
  get y() { return this.baseY + this.deltaY; }
  setCurrent(x, y) {
    this.deltaX = x - this.baseX;
    this.deltaY = y - this.baseY;
  }
  pullDeltaForMainThread() {
    if (this.epoch === undefined) return null;
    const x = Math.round(this.reflectedX + this.deltaX);
    const y = Math.round(this.reflectedY + this.deltaY);
    if (x === this.sentX && y === this.sentY) return null;
    this.sentX = x; this.sentY = y;
    return {x, y, scrollSequence: ++this.sequence, scrollEpoch: this.epoch};
  }
  pushMainToPending(update) {
    if (this.epoch === update.epoch && update.revision <= this.revision) return;
    if (this.pending?.epoch === update.epoch && update.revision <= this.pending.revision) return;
    this.pending = update;
  }
  pushPendingToActive() {
    const update = this.pending;
    if (!update) return;
    this.pending = null;
    if (this.epoch === undefined || this.epoch !== update.epoch) {
      // Epoch replacement represents a new document or Chromium's explicit
      // clobber-active-value condition, not an ordinary main-thread scroll.
      if (this.epoch !== undefined) this.deltaX = this.deltaY = 0;
      this.sentX = update.reflectedX; this.sentY = update.reflectedY;
      this.sequence = update.sequence;
    } else {
      this.deltaX -= update.reflectedX - this.reflectedX;
      this.deltaY -= update.reflectedY - this.reflectedY;
      this.sequence = Math.max(this.sequence, update.sequence);
    }
    this.epoch = update.epoch; this.revision = update.revision;
    this.reflectedX = update.reflectedX; this.reflectedY = update.reflectedY;
    this.baseX = update.x; this.baseY = update.y;
  }
}

export class Session {
  // domElement can be null, in which case this session will be initialised when its set with the setter.
  constructor(ws, baseSession, options) {
    this.options = options || {};
    this.sessionState = {
      nextLayerUpdates: [],
      comittedLayerUpdates: [],
      layer_tree: [],
      keyboard: {showing: false}
    };

    this.scrollStates = new Map();
    this.ws = ws;
    this.onNewSession = () => {};
    this.onSessionActivate = () => {};
    this.onSessionSetHeight = () => {};
    this.onURLChange = () => {};

    if (baseSession) {
      this.sessionState = deepClone(baseSession.sessionState);
    }

    // Layer pixels and text arrive as stream packets (src/gs/); `sourceId`
    // (set by Browser) names this session's source in them.
    this.ws.eventListeners['PageStream.frameStart'] = () => {this.frameHasLayers=false;};

    this.targetStatuses=new Map();
    this.ws.eventListeners['PageStream.targetStatus']=({layerUpdate})=>{
      // Readiness is control metadata, not a renderer frame boundary. Updating
      // it must never commit an unrelated structural frame halfway through.
      for(const status of layerUpdate.targets||[]){
        if(status.sessionId)this.onNewSession(status.sessionId,this);
        this.targetStatuses.set(layerUpdate.layerId+':'+status.backendNodeId,status);
        if(this.targetStatuses.size>2048)this.targetStatuses.delete(this.targetStatuses.keys().next().value);
        const layer=this.sessionState.layer_tree[layerUpdate.layerId];
        const target=layer?.targets?.[status.backendNodeId];
        if(target){Object.assign(target,status);if(layer.dom&&!layer.unresolved)this.createTargetNode(target,layer);}
      }
    };

    this.ws.eventListeners['PageStream.streamLayerInfo'] =  msg => {
      this.frameHasLayers = true;
      this.sessionState.nextLayerUpdates.push(msg.layerUpdate);
      // Create any sessions for event target clicks, because they could start sending data right away.
      msg.layerUpdate.targets && msg.layerUpdate.targets.forEach(x=> {
        x.sessionId && this.onNewSession(x.sessionId, this)
      });
    };

    // `this.lastPropertyTreesJSON` is the raw string form of whatever
    // `nextProptrees` was last set from -- kept specifically so a later
    // PageStream.streamPropTreesPatch has something to apply against. Not
    // part of `sessionState` (so not carried over by the deepClone(
    // baseSession.sessionState) above): a promoted/forked session gets a
    // brand-new client-facing sessionId, and SocketHandler.js's
    // diffPropTrees() starts every new session with no server-side
    // baseline either, so its first tree is always sent in full -- nothing
    // here needs a patch target inherited from a prior session.
    this.ws.eventListeners['PageStream.streamPropTrees'] =  params => {
      this.lastPropertyTreesJSON = params.propertyTreesJSON;
      this.sessionState.nextProptrees = params.propertyTrees || JSON.parse(params.propertyTreesJSON);
      this.fullUpdateRequired = true;
    };

    this.ws.eventListeners['PageStream.streamPropTreesPatch'] =  params => {
      if (this.lastPropertyTreesJSON === undefined) {
        // Shouldn't happen (see diffPropTrees()'s own comment: the first
        // send for a session is always a full streamPropTrees, never a
        // patch), but a patch with nothing to apply against is unusable --
        // drop it rather than crash the session on a corrupt/out-of-order
        // message.
        console.error('PageStream.streamPropTreesPatch received with no prior full tree; dropping');
        return;
      }
      const json = applyPropTreePatch(this.lastPropertyTreesJSON, params.ops);
      this.lastPropertyTreesJSON = json;
      this.sessionState.nextProptrees = JSON.parse(json);
      this.fullUpdateRequired = true;
    };
    
    this.ws.eventListeners['PageStream.frameDone'] = (params={}) => {
      this.lastBriskFrame=params;
      if(params.briskFrame)this.ws.req('PageStream.clientReady',{frame:params.briskFrame,generation:params.briskGeneration,interactive:!!this.frameHasLayers});
      // Required by the protocol (browser_protocol.pdl: "Must be sent by
      // the client once per frameDone") but was never actually implemented
      // client-side -- previously harmless because nothing server-side
      // depended on it, but the adaptive-bandwidth stop-and-wait gate in
      // inspector_page_stream_agent.cc now blocks the next frame on this
      // ack, so a missing ackFrame would stall the connection after one
      // frame. Sent first, before the (synchronous but non-trivial)
      // bookkeeping below, so the server sees it as promptly as possible.
      if(!params.briskMetadataOnly)this.ws.req('PageStream.ackFrame', {});
      this.commitPendingUpdates(true);
      if (this.frameHasLayers) this.interactivePending = true;
      // First frame of the destination after a navigation: its content, not
      // the previous page's pixels kept on screen meanwhile, is now shown.
      if (this.awaitingNavigationFrame && !params.briskMetadataOnly) {
        this.awaitingNavigationFrame = false;
        this.navigationFrameAt = performance.now();
        requestAnimationFrame(() => performance.mark('brisk:navigation-presented'));
      }
    };

    this.ws.eventListeners['PageStream.keyboardStateChange'] = params => {
      this.sessionState.keyboard = params;

      this.updateKeyboard();
    }

    this.ws.eventListeners['PageStream.linkText'] = params => {
      const text = (params.linkText || '').replace(/\s+/g, ' ').trim();
      this.sessionState.layer_tree.forEach(layer => {
        const target = layer && layer.targets && layer.targets[params.backendNodeId];
        if (!target) return;
        target.linkText = text;
        if (target.dom) target.dom.querySelectorAll('.link-hit-region').forEach(region => {
          region.dataset.linkText = text;
          region.setAttribute('aria-label', text || 'clickable target');
        });
      });
    };

    this.ws.eventListeners['Page.frameNavigated'] = params => {
      // Child-frame navigations must not replace the browser's address.
      if (params.frame && !params.frame.parentId && params.frame.url) {
        this.desktopInput?.reset();
        this.targetStatuses.clear();
        this.awaitingNavigationFrame = true;
        // The previous document's link regions name nodes that no longer
        // exist. Its pixels stay until replaced; a tap on them reaches the
        // new page at that point (PageStream.clickNode x/y) instead.
        for (const l of this.sessionState.layer_tree || []) {
          if (!l || !l.targets) continue;
          for (const t of Object.values(l.targets)) t.dom && t.dom.remove();
          l.targets = {};
        }
        this.documentLoaded = false;
        this.currentURL = params.frame.url;
        this.onURLChange(this.currentURL);
      }
    };
    this.ws.eventListeners['Page.navigatedWithinDocument'] = params => {
      if (params.url) {
        this.currentURL = params.url;
        this.onURLChange(this.currentURL);
      }
    };

  }

  // Tiles arrive before frameDone, and a complex page can spend well over a
  // second finishing the rest of that frame. Once property trees exist, the
  // updates already received are independently renderable; paint them on the
  // next animation frame instead of holding a useful first viewport behind
  // the server's end-of-frame bookkeeping.
  commitPendingUpdates(force = false) {
    if (!force && !this.sessionState.nextProptrees &&
        !this.sessionState.comittedProptrees) return;
    this.sessionState.comittedLayerUpdates =
      this.sessionState.comittedLayerUpdates.concat(this.sessionState.nextLayerUpdates);
    this.sessionState.nextLayerUpdates = [];
    if (this.sessionState.nextProptrees) {
      this.sessionState.comittedProptrees = this.sessionState.nextProptrees;
      delete this.sessionState.nextProptrees;
    }
    this.scheduleUpdateScreen();
  }

  // Element ele is adopted by this Session.  It will be removed if a new element is bound.
  set domElement(ele) {
    this.desktopInput?.destroy();
    this.desktopInput = null;
    this.captureLocalScrolls();
    // get rid of old element
    this.domElement_ &&  this.domElement_.remove();

    this.domElement_ = ele;
    // Forks inherit decoded state, but deepClone deliberately drops layer
    // DOM. A preview-only fork may receive no new property trees before it
    // is promoted, so adoption must rebuild that state into the new root.
    if (ele) this.fullUpdateRequired = true;
    if (ele) {
      ['touchStart', 'touchEnd', 'touchCancel', 'touchMove'].forEach(evt =>
        ele.addEventListener(evt.toLowerCase(), this.touch.bind(this, evt), {passive: true}));

      this.keyboard = document.createElement('textarea');
      this.keyboard.className = "keyboard";
      this.keyboard.oninput = this.keyboardHandler.bind(this);
      this.keyboard.onkeydown = this.keyboardKeyHandler.bind(this);
      this.keyboardUpdateBlockedCtr = 0;

      ele.appendChild(this.keyboard);
      this.updateKeyboard();
      const installDesktop = () => import('./desktopInput.js').then(({DesktopInput}) => {
        if (this.domElement_ === ele && !this.desktopInput) this.desktopInput = new DesktopInput(this, ele);
      }).catch(error => console.error('Desktop input failed', error));
      if (globalThis.matchMedia?.('(any-pointer: fine)').matches) installDesktop();
      else ele.addEventListener('pointerover', event => {
        if (event.pointerType === 'mouse') installDesktop();
      }, {passive:true});
    }

    this.updateScreen();
  }

  updateKeyboard() {
    if (this.keyboard && !this.keyboardUpdateBlockedCtr) {
      var params = this.sessionState.keyboard;
      this.keyboard.value = params.inputBoxValue || '';
      this.keyboard.setSelectionRange(params.selectionStart, params.selectionEnd);
      if (params.showing) {
        this.keyboard.focus();
        this.domElement_.onmousedown = (e) => {e.preventDefault();};
      } else {
        this.keyboard.blur();
        this.domElement_.onmousedown = null;
      }
    }
  }
  async keyboardHandler(e) {
    this.keyboardUpdateBlockedCtr++;

    try {
      await this.ws.req("PageStream.setKeyboardState", {
        inputBoxValue: e.target.value,
        selectionStart: e.target.selectionStart,
        selectionEnd: e.target.selectionEnd
      });
    } finally {
      this.keyboardUpdateBlockedCtr--;
    }
  }

  // PageStream.setKeyboardState only ever mirrors a text box's whole value
  // and selection range (see the .pdl's own TODOs on that command) -- it has
  // no notion of a semantic keypress, so Enter/arrow keys/Escape never reach
  // the real page through it. A plain <textarea>'s 'input' event doesn't
  // fire for these either: Enter's default action is inserting a literal
  // '\n' into *this* shadow textarea's value (not "submit"), and moving the
  // caret without changing text fires no 'input' event at all -- so before
  // this handler existed, pressing Enter in a search box did nothing but
  // pressing search on a real browser is one of the most basic things you'd
  // expect to work, and arrow-key caret navigation silently no-op'd.
  //
  // Fixed by forwarding these as real CDP Input.dispatchKeyEvent calls
  // (stock CDP, confirmed present in this build independent of the private
  // fork/PageStream patch -- see SocketHandler.js's whitelist comment), in
  // ADDITION to (not instead of) whatever this shadow textarea's own default
  // action already does. Verified empirically against the compiled binary,
  // including the interaction between the two paths:
  //  - single-line <input>: a dispatched Enter correctly triggers the
  //    field's native implicit form submission, and value stays clean even
  //    though the shadow textarea's own default action still separately
  //    inserts a local '\n' and mirrors it right after via the normal
  //    'input' -> keyboardHandler -> setKeyboardState path (Blink's
  //    SetComposition, like a real <input>.value setter, silently drops an
  //    embedded newline that doesn't belong on a single-line field).
  //  - dispatched ArrowLeft moves the real focused field's actual selection.
  // An earlier version of this called preventDefault() on Enter to suppress
  // that local '\n' -- don't reintroduce that: on a real multi-line
  // <textarea> target it let the dispatched key event commit a real
  // newline server-side, but then the next keystroke's setKeyboardState
  // mirrored the shadow's now-newline-less value on top of it (full-replace
  // composition, not an append) and silently erased it again. Leaving the
  // shadow's own default action alone keeps its mirrored value matching
  // what's really there either way.
  async keyboardKeyHandler(e) {
    var spec = SPECIAL_KEY_CODES[e.key];
    if (!spec) return; // ordinary printable keys are already covered by 'input' -> keyboardHandler above.
    const modifiers = (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);

    this.keyboardUpdateBlockedCtr++;
    try {
      await this.ws.req('Input.dispatchKeyEvent', {
        type: 'rawKeyDown', windowsVirtualKeyCode: spec.code, key: e.key, code: spec.domCode,
        text: spec.text,
        modifiers,
      });
      if (spec.text) {
        await this.ws.req('Input.dispatchKeyEvent', {
          type: 'char', windowsVirtualKeyCode: spec.code, key: e.key, code: spec.domCode, text: spec.text, modifiers,
        });
      }
      await this.ws.req('Input.dispatchKeyEvent', {
        type: 'keyUp', windowsVirtualKeyCode: spec.code, key: e.key, code: spec.domCode, modifiers,
      });
    } finally {
      this.keyboardUpdateBlockedCtr--;
    }
  }

  decodeLayerInfo(l) {
    var decoded = l.split('\n').map(x => x.split(':')).filter(x=>x.length>1).reduce((m, i) => (m[i[0].trim()] = i[1].trim(), m), {});

    var res = {layerId: decoded.layer_id};
    res.drawsContent = decoded.Bounds != '0x0';

    res.name = decoded.name;
    res.bounds = decoded.Bounds.split('x').map(x => parseInt(x));
    res.offsetToTransformParent = decoded.OffsetToTransformParent.split(' ').map(x => parseFloat(x.replace(/[^\d.-]/g, '')));
    res.clip_tree_index = parseInt(decoded.clip_tree_index);
    res.effect_tree_index = parseInt(decoded.effect_tree_index);
    res.scroll_tree_index = parseInt(decoded.scroll_tree_index);
    res.transform_tree_index = parseInt(decoded.transform_tree_index);
    return res
  }

  // Border-radius on an overflow:hidden/auto element is a paint-time detail
  // for static content -- Skia bakes the rounded clip directly into the
  // rastered tile pixels server-side, so a plain rectangular reconstruction
  // displays it correctly with no extra client-side work. But a *scrolled*
  // clip frame (the '.scroll' div created above for a scroll container) is
  // reconstructed as its own DOM box precisely so it can move/clip content
  // independently of any raster tile -- so its corners need rounding too,
  // or they render as hard right angles regardless of the source page's
  // CSS. cc doesn't carry corner radii on the clip tree at all; they live
  // on whichever effect-tree node shares this clip's id
  // (EffectNode::rounded_corner_bounds, a [x,y,w,h, rx,ry x4] RRectF in
  // SkRRect's standard UL/UR/LR/LL corner order -- conveniently the same
  // order CSS's border-radius shorthand uses).
  roundedCornerCssFor(clipNode) {
    var effectNodes = this.sessionState.effect_tree || [];
    for (var i = 0; i < effectNodes.length; i++) {
      var e = effectNodes[i];
      var rcb = e && e.rounded_corner_bounds;
      if (!rcb || rcb.length < 12 || !e.clip_id) continue;
      // Match by geometry (same rect, same local transform space), not
      // object identity -- cc can emit a separate-but-coincident clip node
      // for the effect vs. the one a scroll/overflow frame's own clip_id
      // references, even when they describe the same rounded region.
      if (e.transform_id !== clipNode.transform_id) continue;
      var c = clipNode.clip, b = rcb;
      if (c[0] !== b[0] || c[1] !== b[1] || c[2] !== b[2] || c[3] !== b[3]) continue;
      var rx = [rcb[4], rcb[6], rcb[8], rcb[10]];
      var ry = [rcb[5], rcb[7], rcb[9], rcb[11]];
      if (rx.some(v => v)) {
        return rx.join('px ') + 'px / ' + ry.join('px ') + 'px';
      }
    }
    return '';
  }

  // A scroller's scrollable extent is its scroll node's content bounds. It
  // cannot come from the layers inside it: current Chromium sizes a layer to
  // what was painted, not to the scroll extent (Chromium 87's scrolling
  // contents layer spanned it), so a scroller whose content does not paint to
  // its far edge would otherwise be too short, or not scroll at all.
  applyScrollExtent(t) {
    const bounds = t.scroll && t.scroll.bounds;
    let extent = t.dom.scrollExtent;
    if (!bounds) {
      if (extent) extent.remove();
      return;
    }
    if (!extent) {
      extent = t.dom.scrollExtent = document.createElement('div');
      extent.style.cssText = 'position:absolute;left:0;top:0;visibility:hidden;pointer-events:none';
    }
    if (extent.parentNode !== t.dom) t.dom.prepend(extent);
    extent.style.width = bounds.width + 'px';
    extent.style.height = bounds.height + 'px';
  }

  createDOMTransformNode(t, zIndex, adopt) {
    if (t.parent_id) {
      if (!t.dom && adopt)
        // See if there is an element we might adopt
        if (adopt.adoptable) {
          t.dom = adopt
        }

      var oldZIndex = t.zIndex ?? -1;
      
      if (oldZIndex < zIndex || !t.dom || t.dom.adoptable) {
        t.zIndex = Math.max(zIndex, oldZIndex);
        this.createDOMTransformNode(t.parent_id, zIndex, t.dom && t.dom.parentNode);
      }

      if (!t.dom) {
        t.dom = document.createElement('div');
        t.parent_id.dom.appendChild(t.dom);
      }
      t.dom.adoptable = false;
      
      if (t.dom.parentNode != t.parent_id.dom) {
        t.parent_id.dom.appendChild(t.dom);
      }
      t.dom.classList.add('t');
      t.dom.setAttribute('t'+t.id, '');

      if (t.clip) {
        t.dom.style.width = t.clip.clip[2] + 'px';
        t.dom.style.height = t.clip.clip[3] + 'px';
        t.dom.style.top = t.clip.clip[1] + 'px';
        t.dom.style.left = t.clip.clip[0] + 'px';
        t.dom.style.borderRadius = this.roundedCornerCssFor(t.clip);
      }
      this.applyTransformCss(t);

      t.dom.onscroll = t.scroll?this.scrollHandler.bind(this, t):undefined;
      t.dom.classList.toggle('scroll', !!t.scroll)
      this.applyScrollExtent(t);

    } else {
      // Root transform is the one given when the class was constructed
      t.dom = this.domElement_;
    }
  }

  updateTargetHeights() {
    this.sessionState.layer_tree.forEach(l => {
      Object.keys(l.targets).forEach(backendNodeId => {
        var t = l.targets[backendNodeId];
        // TODO:  Should take into account all the layer transforms and scroll positions
        // A target with no rendered box has an empty quad list; throwing here
        // would abort the rest of updateScreen().
        const quad = t.containingQuads && t.containingQuads[0];
        t.sessionId && quad && this.onSessionSetHeight(t.sessionId, quad[1])
      })
    });
  }

  scrollState(t) {
    const id = t.scroll.element_id.id_;
    let state = this.scrollStates.get(id);
    if (!state) {
      state = new SyncedScrollOffset(t.scroll_offset[0], t.scroll_offset[1]);
      this.scrollStates.set(id, state);
    }
    return state;
  }

  scrollHandler(t, evt) {
    if (!t.dom.isConnected) return;
    this.refreshStickyFor(t);
    const state = this.scrollState(t);
    const x = t.dom.scrollLeft, y = t.dom.scrollTop;
    // Native events are asynchronous and can coalesce a programmatic write
    // with a later user movement. Suppress only an echo of the actual write.
    const echo = t.dom.serverScrollEcho;
    if (echo && echo.x === x && echo.y === y) return;
    t.dom.serverScrollEcho = {x, y};
    if (Math.round(state.x) === x && Math.round(state.y) === y) return;
    // Layout may clamp the displayed DOM while the logical offset still has
    // unreflected input. Add only movement since the last displayed position;
    // treating this as an absolute offset would resend the clamp as input.
    state.setCurrent(echo && state.deltaX ? state.x + x - echo.x : x,
                     echo && state.deltaY ? state.y + y - echo.y : y);
    this.sendScrollDelta(t, state);
    this.updateTargetHeights();
  }

  sendScrollDelta(t, state) {
    const delta = state.pullDeltaForMainThread();
    if (!delta) return;
    const params = {backendNodeId: t.scroll.element_id.id_, ...delta};
    // Completion is not evidence that a subsequently displayed frame includes
    // this delta. Only reflected deltas in an activated tree acknowledge it.
    this.ws.req('PageStream.setScroll', params).catch(() => {});
  }

  captureLocalScrolls() {
    // A native movement may precede its event. Record and send it before tree
    // reparenting can clamp the DOM or make its queued event look like an echo.
    (this.sessionState.scroll_tree || []).forEach(node => {
      const t = node && node.transform_id;
      if (!t || !t.dom || !t.dom.isConnected || !t.scroll) return;
      const state = this.scrollState(t), echo = t.dom.serverScrollEcho;
      const x = t.dom.scrollLeft, y = t.dom.scrollTop;
      if ((!echo || echo.x !== x || echo.y !== y) && (Math.round(state.x) !== x || Math.round(state.y) !== y))
        this.scrollHandler(t);
    });
  }

  applyServerScroll(t) {
    const state = this.scrollState(t);
    const update = t.scroll.serverScroll;
    if (update) {
      state.pushMainToPending(update);
      state.pushPendingToActive();
    }
    // Activation keeps all input not reflected in this renderer commit. No
    // timeout or request reply can replace the active compositor-side state.
    const x = Math.round(state.x), y = Math.round(state.y);
    if (t.dom.scrollLeft !== x || t.dom.scrollTop !== y) {
      t.dom.scrollLeft = x;
      t.dom.scrollTop = y;
      // Record the browser's actual result, including layout clamping.
      t.dom.serverScrollEcho = {x: t.dom.scrollLeft, y: t.dom.scrollTop};
      this.refreshStickyFor(t);
    }
    this.sendScrollDelta(t, state);
  }

  // The compositor owns the layer's pixel and text canvases (src/gs/); this
  // only parents them under the layer's element, where the property-tree
  // transforms, clips and opacity built here apply to them.
  gsCompositor() { return this.ws?.ws?._gs?.compositor; }
  attachLayerPixels(l) {
    if (this.sourceId === undefined || !l.dom) return;
    this.gsCompositor()?.attach(this.sourceId, Number(l.layerId), l.dom);
  }
  // A layer's stream state was created: its element may be buildable now.
  gsLayerChanged() {
    this.fullUpdateRequired = true;
    this.scheduleUpdateScreen();
  }
  // Port of cc::LayerDrawOpacity (draw_property_utils.cc): the opacity a
  // layer's own raster needs when composited is the product of every
  // effect node's opacity from the layer's own node up to (but NOT
  // including) the nearest ancestor-or-self node that owns a render
  // surface -- that boundary node's own opacity gets applied separately,
  // when *that surface* is composited into *its* target, a step this
  // reconstruction doesn't otherwise replicate. Climbing all the way to
  // the tree root instead (an earlier attempt at this) double-counts any
  // opacity already "spent" at an intermediate render-surface boundary --
  // harmless on a simple page with only one such boundary (the root
  // surface), but produces widespread wrong-opacity corruption on complex
  // real pages with several nested surfaces (confirmed: broke Wikipedia
  // badly). If the layer's own node *is* such a boundary, its own raster
  // needs no opacity here at all (1) -- the boundary's opacity is that
  // separate, unreplicated compositing step's job, not this layer's.
  layerDrawOpacity(l) {
    var node = l.effect_tree_index;
    if (!node) return 1;
    if (node.render_surface_reason && node.render_surface_reason !== 'none') return 1;
    var opacity = 1;
    for (var n = node; n && n !== node.target_id; n = n.parent_id) {
      if (n.opacity != null) opacity *= n.opacity;
    }
    return opacity;
  }

  createDOMLayerNode(l) {
    if (!this.gsCompositor()?.layer(this.sourceId, Number(l.layerId)) || l.name == 'Frame Overlay Content Layer') return;

    // Huh - looks like a scrollingcontents layer.  If so, set everything up appropriately
    // `scroll_tree_index.transform_id` is resolved from the scroll tree's own
    // node, not the layer's indices, so it can dangle even for a layer
    // makeTrees() resolved fully (same staleness window described there).
    // Reading `.parent_id` through it unguarded threw the identical
    // "Cannot read properties of undefined" that aborted this whole loop.
    if (l.scroll_tree_index.transform_id &&
        l.clip_tree_index.transform_id === l.scroll_tree_index.transform_id.parent_id  &&
        l.scroll_tree_index.scrollable) {
      l.scroll_tree_index.transform_id.scroll = l.scroll_tree_index;
      l.scroll_tree_index.transform_id.clip = l.clip_tree_index;
      
      this.createDOMTransformNode(l.scroll_tree_index.transform_id, 0, l.scrolldom);
      l.scrolldom = l.scroll_tree_index.transform_id.dom;
    }

    this.createDOMTransformNode(l.transform_tree_index, l.zIndex, l.dom && l.dom.parentNode);
          
    if (!l.dom) {
      l.dom=document.createElement('div');  // layer
    }
    if (l.dom.parentNode != l.transform_tree_index.dom) {
      // Transforms have changed - we need to add/move our layer elsewhere.
      l.transform_tree_index.dom.appendChild(l.dom);
    }
    
    this.attachLayerPixels(l);

    // offsetToTransformParent is expressed relative to the transform node's
    // own property-tree origin -- but when that node carries a .clip (see
    // above: a scroll frame's clip box is positioned via CSS top/left at
    // clip[0],clip[1] rather than at the node's true origin), the node's
    // *DOM box* origin is already shifted by that same clip amount. Without
    // subtracting it back out here, every layer parented under a bordered/
    // padded scroll frame renders one clip-offset too far right/down (see
    // Confirmed by the border/padding-scroll pixel regression: frontend items
    // landed exactly clip[0]/clip[1] past ground truth, uniformly in both
    // axes, only on scrollers with a nonzero clip offset).
    var clipOffsetX = (l.transform_tree_index.clip && l.transform_tree_index.clip.clip[0]) || 0;
    var clipOffsetY = (l.transform_tree_index.clip && l.transform_tree_index.clip.clip[1]) || 0;
    l.dom.style.top = (l.offsetToTransformParent[1] - clipOffsetY) + 'px';
    l.dom.style.left = (l.offsetToTransformParent[0] - clipOffsetX) + 'px';
    l.dom.style.width=l.bounds[0] + 'px';
    l.dom.style.height=l.bounds[1] + 'px';
    l.dom.style.overflow = 'hidden';
    // Paint regions can contain transparent gaps (including Chromium's own
    // full-viewport fixed-content picture). Native scroll boxes and explicit
    // link regions own input; a raster rectangle must not intercept it.
    l.dom.style.pointerEvents = 'none';
    l.dom.style.position = 'absolute';
    l.dom.style.zIndex = l.zIndex;
    l.dom.style.opacity = this.layerDrawOpacity(l);
    l.dom.setAttribute('l'+l.layerId, l.name);
    //l.dom.alt = l.name;
    //l.dom.l = l;

    l.targets && Object.keys(l.targets).forEach(t => {
      this.createTargetNode(l.targets[t], l);
    });

  }

  forgetPreload(sessionId) {
    const clear = target => {
      if (String(target.sessionId) !== String(sessionId)) return false;
      target.sessionId = null;
      target.ready = false;
      target.inputReady = false;
      return true;
    };
    for (const status of this.targetStatuses.values()) clear(status);
    this.sessionState.layer_tree.forEach(layer => {
      for (const target of Object.values(layer.targets || {})) {
        if (clear(target) && this.domElement_ && layer.dom && !layer.unresolved)
          this.createTargetNode(target, layer);
      }
    });
  }

  // A completed click on a hit region, by finger or by mouse: promote its fork when that is ready,
  // and tell the server which node was clicked. |evt| is the pointer event that ended the click.
  tapTarget(region, evt) {
    // Real bug, found live: this used to fire on sessionId alone --
    // SocketHandler.js sets that the instant a speculative fork exists,
    // well before its own pre-navigation (PageStream.clickNode) has
    // actually finished (measured live: 6+ seconds for a real
    // destination page). Activating instantly on a fork that hasn't
    // gone anywhere yet swapped the client straight to stale/blank
    // content instead of the promised instant page. `ready` is a
    // separate flag SocketHandler.js now sends only once that
    // navigation genuinely succeeds -- see its own comment.
    if (region.metadata.sessionId && region.metadata.ready) {
      // Means we have preloaded this click - we just need to transfer to that session.
      // The destination recorded on the clickable target is only a
      // prediction/readiness label and may be an intermediate redirect.
      // Every fork's Session independently tracks authoritative Chromium
      // Page.frameNavigated/navigatedWithinDocument events. Promote that
      // session as-is; sessionActivate publishes its currentURL, and any
      // later canonicalisation continues to update the active address bar.
      performance.mark('brisk:promotion-start');
      const interactive=!!region.metadata.inputReady;
      this.onSessionActivate(region.metadata.sessionId);
      requestAnimationFrame(()=>requestAnimationFrame(()=>performance.mark('brisk:promotion-presented',{detail:{interactive}})));
    }
    // A PointerEvent carries the lifted pointer's position directly on the
    // event -- the actual tap point, useful for replaying this exact click
    // by coordinate later (see test/replayTrace.js). (This used to dig it
    // out of TouchEvent.changedTouches, which does not exist on a
    // PointerEvent and would have recorded undefined for every click.)
    interactionTrace.record('click', {
      x: Number.isFinite(evt.clientX) ? Math.round(evt.clientX) : undefined,
      y: Number.isFinite(evt.clientY) ? Math.round(evt.clientY) : undefined,
      backendNodeId: region.metadata.backendNodeId,
      linkText: region.dataset.linkText || undefined,
    });
    // The tap point travels with the node: if the node is gone by the time
    // the click arrives (navigation, re-render), the server clicks whatever
    // is at that point instead. A click is never dropped.
    const point = Number.isFinite(evt.clientX) && Number.isFinite(evt.clientY) ?
        {x: evt.clientX, y: evt.clientY} : {};
    this.ws.req('PageStream.clickNode', { backendNodeId: region.metadata.backendNodeId, ...point } );
    evt.preventDefault();
  }

  targetTouch(type, evt) {
    if (evt.pointerType === 'mouse') return;
    // We want to detect 'click' events, but have to use touch instead because
    // we'll need to cancel the global touch event touch if we detect a click, and the onclick() event
    // fires too late to do that.
    if (type=='pointerdown' && evt.isPrimary) {
      evt.currentTarget.setPointerCapture(evt.pointerId)
      evt.currentTarget.metadata.touchStarted = true;
    } else if (type=='pointerup' && evt.currentTarget.metadata.touchStarted) {
      delete evt.currentTarget.metadata.touchStarted;
      // The root already forwarded touchStart. clickNode is the complete
      // action; ending that touch as well synthesizes a second origin click,
      // possibly on a different page after navigation. Cancel it first.
      this.touch('touchCancel', {touches: []});
      this.suppressTouchEnd = true;
      this.tapTarget(evt.currentTarget, evt);
    } else {
      delete evt.currentTarget.metadata.touchStarted;
      evt.currentTarget.releasePointerCapture(evt.pointerId) 
    }
  }

  // The parts of a hit region that change without its geometry changing.
  applyTargetRegionState(region, t) {
    region.metadata = t;
    region.dataset.backendNodeId = t.backendNodeId;
    if (this.options.showLinkOverlay) {
      region.classList.add('link');
      region.classList.toggle('alive', !!t.sessionId);
    }
    region.classList.toggle('preloaded', !!(t.sessionId && t.ready));
  }

  createTargetNode(t, l) {
    if (!t.containingQuads) return;
    var container = l.dom.parentNode;
    if (!t.dom) {
      t.dom=document.createElement('div');
    }
    if (t.dom.parentNode != container) container.appendChild(t.dom);
    // A link can produce several quads when its inline content wraps, and a
    // transformed target can be a non-axis-aligned quadrilateral. The old
    // frontend used only containingQuads[0], making later lines untappable
    // and filling gaps in uneven shapes. Keep a pointer-transparent owner
    // and create one clipped, independently hittable region per real quad.
    t.dom.style.position = 'absolute';
    t.dom.style.inset = '0';
    t.dom.style.pointerEvents = 'none';
    t.dom.metadata = t;
    const automationText = (t.linkText || '').replace(/\s+/g, ' ').trim();
    // Targets are re-sent with every frame, so a page that animates (a live
    // counter, a clock) would otherwise rebuild the regions continuously. A
    // replaced element under a resting pointer loses :hover until the next
    // mouse move, and the hover highlight flickers. Keep the regions while
    // their geometry and label are unchanged; refresh only their state.
    const regionKey = JSON.stringify([t.containingQuads, automationText]);
    if (t.dom.regionKey === regionKey) {
      for (const region of t.dom.children) this.applyTargetRegionState(region, t);
      return;
    }
    t.dom.regionKey = regionKey;
    t.dom.replaceChildren();
    t.containingQuads.forEach((quad, quadIndex) => {
      if (!quad || quad.length < 8) return;
      const xs = [quad[0], quad[2], quad[4], quad[6]];
      const ys = [quad[1], quad[3], quad[5], quad[7]];
      const left = Math.min(...xs), top = Math.min(...ys);
      const width = Math.max(...xs) - left, height = Math.max(...ys) - top;
      if (width <= 0 || height <= 0) return;
      const region = document.createElement('div');
      region.className = 'link-hit-region';
      region.style.position = 'absolute';
      region.style.pointerEvents = 'auto';
      region.style.left = left + 'px';
      region.style.top = top + 'px';
      region.style.width = width + 'px';
      region.style.height = height + 'px';
      region.style.clipPath = 'polygon(' + xs.map((x, i) =>
        (((x - left) / width) * 100) + '% ' + (((ys[i] - top) / height) * 100) + '%').join(',') + ')';
      region.metadata = t;
      region.dataset.backendNodeId = t.backendNodeId;
      region.dataset.linkText = automationText;
      region.dataset.linkQuad = quadIndex;
      region.setAttribute('aria-label', automationText || 'clickable target');
      // Not {passive: true}: targetTouch() preventDefault()s a completed
      // click so the global touch/scroll path doesn't also act on it, and a
      // passive listener would silently drop that. Unlike touchstart/
      // touchmove, a non-passive pointer listener costs nothing for scrolling
      // -- scroll blocking for pointer events is governed by touch-action.
      ['pointerdown', 'pointerup', 'pointercancel', 'pointermove'].forEach(evt =>
        region.addEventListener(evt.toLowerCase(), this.targetTouch.bind(this, evt)));
      this.applyTargetRegionState(region, t);
      t.dom.appendChild(region);
    });
    // Real, shipped highlight for speculatively-preloaded links -- distinct
    // from showLinkOverlay above, which is a dev-only debug outline over
    // EVERY clickable target on the page (off by default; would paint
    // dozens of boxes on a real page). t.sessionId is only ever set once
    // SocketHandler.js's startNewBrowsers() has actually forked a live
    // Chromium process for this specific target (see its streamLayerInfo
    // relay) -- i.e. this is exactly the up-to-5-target preloaded set, not
    // "every link", and it's on unconditionally so a real user actually
    // sees which taps are about to be instant. Also requires t.ready: a
    // fork exists (sessionId set) well before its own speculative
    // navigation has actually finished (measured live: 6+ seconds) --
    // highlighting green before then would promise a tap is instant when
    // it isn't yet. See targetTouch()'s matching guard and
    // SocketHandler.js's own comment on where `ready` comes from.
  }

  // t.local alone is NOT a transform node's actual to-parent transform --
  // cc's TransformTree::UpdateLocalTransform (property_tree.cc) computes it
  // as translate(post_translation + origin) * translate(-scroll_offset) *
  // translate(sticky) * local * translate(-origin). This matters because
  // `local` is very often just the "core" transform (e.g. a bare rotation
  // matrix) with the actual pivot/position living in origin/post_translation
  // instead -- Blink keeps them separate specifically so a compositor-thread
  // animation can replay just `local` every frame without redoing the
  // origin dance. Reading `local` alone (as this used to) renders such a
  // node pivoting around (0,0) instead of its real transform-origin, and
  // drops its position entirely when that position lives in
  // post_translation rather than baked into local. Degrades to the exact
  // previous behavior when origin/post_translation are both zero (the
  // common case for ordinary, non-promoted content), so this is a strict
  // generalization, not a conditional special case.
  //
  // `-scroll_offset` is deliberately still not here: this reconstruction
  // implements scrolling as native DOM scrollTop/scrollLeft on a '.scroll'
  // box (see applyServerScroll/scrollHandler), not as a baked-in transform
  // offset, so cc's own scroll_offset term has no equivalent to apply here.
  // `sticky` (a CSS px {x, y}, from stickyOffsetPx()) now is.
  toCss(matrix, origin, postTranslation, sticky) {
    matrix = Array(16).fill().map((_,i) => matrix[Math.floor(i/4) + (i%4)*4]);
    var ox = (origin && origin[0]) || 0, oy = (origin && origin[1]) || 0, oz = (origin && origin[2]) || 0;
    var px = (postTranslation && postTranslation[0]) || 0, py = (postTranslation && postTranslation[1]) || 0;
    var sx = (sticky && sticky.x) || 0, sy = (sticky && sticky.y) || 0;
    var parts = [];
    if (px + ox || py + oy || oz) parts.push(`translate3d(${px + ox}px, ${py + oy}px, ${oz}px)`);
    if (sx || sy) parts.push(`translate(${sx}px, ${sy}px)`);
    var mat = 'matrix3d(' + matrix.join(',') + ')';
    if (mat !== 'matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1)') parts.push(mat);
    if (ox || oy || oz) parts.push(`translate3d(${-ox}px, ${-oy}px, ${-oz}px)`);
    return parts.join(' ');
  }

  // Recomputes and reapplies t.dom.style.transform, including its current
  // sticky offset if it has one. The one place both a server commit
  // (createDOMTransformNode) and a local scroll event (refreshStickyFor)
  // need to update a node's CSS transform -- kept as one function so
  // neither path can drift from what toCss() actually needs.
  applyTransformCss(t) {
    t.dom.style.transform = this.toCss(t.local, t.origin, t.post_translation, this.stickyOffsetPx(t));
    // Layers are ordered by one global draw order (`layer.zIndex`), but they
    // live in per-transform-node elements. An element with a `z-index` is a
    // stacking context, which flattens everything inside it into a single slot
    // in that order: a node holding the page's white root background (order 0)
    // and its fixed header (order 6) was given z-index 6, so the background
    // painted over the scrolling content (order 1) and Pinterest, Twitch and
    // Stack Overflow showed only their header over white.
    //
    // So only a node that is a stacking context anyway -- one with a CSS
    // transform -- keeps a z-index (the best a single element can do). Every
    // other node (scroll frames, clips, identity transforms) leaves it `auto`,
    // and its layers take their own z-index in the enclosing context, which
    // interleaves them with other nodes' layers exactly as the compositor does.
    t.dom.style.zIndex = t.dom.style.transform && t.zIndex !== undefined ? t.zIndex : '';
  }

  // Port of cc::TransformTree::StickyPositionOffset (property_tree.cc),
  // using PageStream.streamPropTrees's sticky_position_data (see
  // GetPropertyTreesJSON/AddStickyPositionData, inspector_page_stream_
  // agent.cc) for the constraint plus the LIVE local scroll position of
  // the scroll ancestor -- not the server-reported one, which can be
  // arbitrarily stale under real latency the instant local scroll has
  // moved since the last commit (this reconstruction's entire premise is
  // that local scroll never waits for a round trip -- see
  // applyServerScroll's own header comment). The scroll ancestor's LIVE
  // position is exactly its '.scroll' DOM box's own scrollLeft/scrollTop:
  // that's how this reconstruction already implements scrolling (a real
  // native scroll box), so nothing else needs to track it separately.
  //
  // Returns {x, y} in CSS px, rounded (cc rounds too, at the same point --
  // see its own `roundf` right before returning). Also stashes
  // totalStickyBoxOffset/totalContainingBlockOffset on node.sticky, the
  // same accumulate-as-you-go values cc's own total_{sticky_box,
  // containing_block}_sticky_offset are for nested sticky elements
  // (nearestNodeShiftingStickyBox/nearestNodeShiftingContainingBlock)
  // to build on -- recomputed fresh on every call rather than cached
  // across calls: real pages rarely nest sticky elements more than one or
  // two deep, so redoing that short ancestor chain every time is cheap,
  // and it means there is no persistent cache to ever go stale after a
  // scroll cc's own C++ version never has to reason about at all.
  stickyOffsetPx(node) {
    var s = node && node.sticky;
    if (!s) return {x: 0, y: 0};

    const xAncestor = s.xScrollAncestor === undefined ? s.scrollAncestor : s.xScrollAncestor;
    const yAncestor = s.yScrollAncestor === undefined ? s.scrollAncestor : s.yScrollAncestor;
    const xDom = xAncestor && xAncestor.transform_id && xAncestor.transform_id.dom;
    const yDom = yAncestor && yAncestor.transform_id && yAncestor.transform_id.dom;
    var scrollX = xDom ? xDom.scrollLeft : 0;
    var scrollY = yDom ? yDom.scrollTop : 0;
    const matchingAxes = (ancestor, offsets) => {
      const a = ancestor.sticky;
      const ax = a.xScrollAncestor === undefined ? a.scrollAncestor : a.xScrollAncestor;
      const ay = a.yScrollAncestor === undefined ? a.scrollAncestor : a.yScrollAncestor;
      return {x: ax === xAncestor ? offsets.x : 0, y: ay === yAncestor ? offsets.y : 0};
    };

    var c = s.constraintBoxRect || [0, 0, 0, 0];
    var clipX = c[0] + scrollX, clipY = c[1] + scrollY, clipW = c[2], clipH = c[3];

    var ancestorStickyBox = {x: 0, y: 0};
    if (s.nearestNodeShiftingStickyBox) {
      this.stickyOffsetPx(s.nearestNodeShiftingStickyBox);
      ancestorStickyBox = matchingAxes(s.nearestNodeShiftingStickyBox,
          s.nearestNodeShiftingStickyBox.sticky.totalStickyBoxOffset || ancestorStickyBox);
    }
    var ancestorContainingBlock = {x: 0, y: 0};
    if (s.nearestNodeShiftingContainingBlock) {
      this.stickyOffsetPx(s.nearestNodeShiftingContainingBlock);
      ancestorContainingBlock = matchingAxes(s.nearestNodeShiftingContainingBlock,
          s.nearestNodeShiftingContainingBlock.sticky.totalContainingBlockOffset || ancestorContainingBlock);
    }

    var sb = s.scrollContainerRelativeStickyBoxRect || [0, 0, 0, 0];
    var cb = s.scrollContainerRelativeContainingBlockRect || [0, 0, 0, 0];
    var stickyBoxX = sb[0] + ancestorStickyBox.x + ancestorContainingBlock.x;
    var stickyBoxY = sb[1] + ancestorStickyBox.y + ancestorContainingBlock.y;
    var stickyBoxRight = stickyBoxX + sb[2], stickyBoxBottom = stickyBoxY + sb[3];
    var containingX = cb[0] + ancestorContainingBlock.x;
    var containingY = cb[1] + ancestorContainingBlock.y;
    var containingRight = containingX + cb[2], containingBottom = containingY + cb[3];

    // Order matches cc exactly: right/left/bottom/top, so a left offset
    // can override a right one and top can override bottom on the same
    // node, the same precedence StickyPositionOffset's own comment states.
    var offX = 0, offY = 0;
    if (s.isAnchoredRight) {
      var rightLimit = (clipX + clipW) - s.rightOffset;
      var rightDelta = Math.min(0, rightLimit - stickyBoxRight);
      var rightAvailable = Math.min(0, containingX - stickyBoxX);
      if (rightDelta < rightAvailable) rightDelta = rightAvailable;
      offX += rightDelta;
    }
    if (s.isAnchoredLeft) {
      var leftLimit = clipX + s.leftOffset;
      var leftDelta = Math.max(0, leftLimit - stickyBoxX);
      var leftAvailable = Math.max(0, containingRight - stickyBoxRight);
      if (leftDelta > leftAvailable) leftDelta = leftAvailable;
      offX += leftDelta;
    }
    if (s.isAnchoredBottom) {
      var bottomLimit = (clipY + clipH) - s.bottomOffset;
      var bottomDelta = Math.min(0, bottomLimit - stickyBoxBottom);
      var bottomAvailable = Math.min(0, containingY - stickyBoxY);
      if (bottomDelta < bottomAvailable) bottomDelta = bottomAvailable;
      offY += bottomDelta;
    }
    if (s.isAnchoredTop) {
      var topLimit = clipY + s.topOffset;
      var topDelta = Math.max(0, topLimit - stickyBoxY);
      var topAvailable = Math.max(0, containingBottom - stickyBoxBottom);
      if (topDelta > topAvailable) topDelta = topAvailable;
      offY += topDelta;
    }

    s.totalStickyBoxOffset = {x: ancestorStickyBox.x + offX, y: ancestorStickyBox.y + offY};
    s.totalContainingBlockOffset = {
      x: ancestorStickyBox.x + ancestorContainingBlock.x + offX,
      y: ancestorStickyBox.y + ancestorContainingBlock.y + offY,
    };

    const snap = s.pixelSnapOffset || [0, 0];
    return {x: Math.round(offX + snap[0]), y: Math.round(offY + snap[1])};
  }

  // Called whenever a '.scroll' box actually moves (scrollHandler) --
  // finds every sticky transform node anchored to that scroll container
  // and reapplies its CSS transform immediately, with no round trip.
  // Linear scan over the (typically small) transform tree rather than a
  // maintained scrollAncestor -> [stickyNodes] index: real pages rarely
  // have more than a handful of sticky elements, and this only runs on an
  // actual scroll event, not every frame.
  refreshStickyFor(scrolledTransformNode) {
    (this.sessionState.transform_tree || []).forEach(node => {
      if (!node || !node.sticky) return;
      if ([node.sticky.scrollAncestor, node.sticky.xScrollAncestor, node.sticky.yScrollAncestor]
          .some(ancestor => ancestor && ancestor.transform_id === scrolledTransformNode) && node.dom) {
        this.applyTransformCss(node);
      }
    });
  }

  makeTrees(propTrees) {
    var clip_tree = propTrees.clip_tree.nodes.reduce((map, obj) => (map[obj.id] = obj, map), []);
    var effect_tree = propTrees.effect_tree.nodes.reduce((map, obj) => (map[obj.id] = obj, map), []);
    var scroll_tree = propTrees.scroll_tree.nodes.reduce((map, obj) => (map[obj.id] = obj, map), []);
    var transform_tree = propTrees.transform_tree.nodes.reduce((map, obj) => (map[obj.id] = obj, map), []);

    const scrollUpdates = propTrees.brisk_scroll_updates ? JSON.parse(propTrees.brisk_scroll_updates) : {};
    scroll_tree.forEach(node => {
      node.serverScroll = scrollUpdates[node.element_id && node.element_id.id_];
    });
    var layer_tree = this.sessionState.layer_tree;

    // Export-region membership can change without changing a scroll container.
    // Keep its live DOM node by compositor element id, rather than relying on
    // whichever old paint layer happens to be visited first. Replacing it
    // during a gesture loses momentum, local-scroll protection and listeners.
    const elementKey = node => node && node.element_id &&
      (typeof node.element_id === 'object' ? node.element_id.id_ : node.element_id);
    const scrollDoms = new Map();
    (this.sessionState.scroll_tree || []).forEach(node => {
      const transform = node && node.transform_id;
      const key = elementKey(node);
      if (key && transform && transform.dom && transform.dom.isConnected)
        scrollDoms.set(key, transform.dom);
    });
    scroll_tree.forEach(node => {
      const dom = scrollDoms.get(elementKey(node));
      const transform = transform_tree[node.transform_id];
      if (dom && transform) transform.dom = dom;
    });

    function get_tree_node(a) {
      if (Number.isInteger(a)) return a;
      if (a === undefined) return a;
      return a.id;
    }
    // A layer can outlive the property trees it was described against. The
    // server only sends a layer's info when that layer itself changes, and
    // only re-sends property trees when their serialization changes, so a
    // navigation (or a promoted speculative fork taking over this session)
    // can replace the whole tree set with a smaller one while layers from
    // the previous page are still sitting in layer_tree with no matching
    // `layerDeleted` ever having arrived for them. Observed live on
    // https://en.wikipedia.org/wiki/Main_Page: frame 1 carried transform
    // nodes 0-12 and layers 23-31 using nodes 7-12; frame 2 replaced the
    // trees with nodes 0-6 and added layers 35-38, and no delete was ever
    // sent for 23-31.
    //
    // Resolving those dangling indices in place stored `undefined` on the
    // layer, which then reached createDOMLayerNode() ->
    // createDOMTransformNode(undefined) and threw "Cannot read properties
    // of undefined (reading 'parent_id')". That throw escaped the
    // layer_tree.forEach in updateScreen(), so EVERY remaining layer --
    // including every one that resolved perfectly well -- was skipped, and
    // with them createTargetNode() and the entire click-target DOM. The
    // user-visible result was a page that streamed tiles normally but had
    // no `.link-hit-region` elements at all, i.e. no tappable links and no
    // `.preloaded` highlighting, on roughly half of all page loads.
    //
    // Mark such a layer unresolved and leave its raw indices untouched
    // rather than overwriting them with undefined: the ids are the only
    // record of what the layer wanted, so keeping them lets it resolve
    // normally if a later property-tree update reintroduces those nodes,
    // and makes the condition non-destructive either way.
    layer_tree.forEach(l => {
      var clip = clip_tree[get_tree_node(l.clip_tree_index)];
      var effect = effect_tree[get_tree_node(l.effect_tree_index)];
      var scroll = scroll_tree[get_tree_node(l.scroll_tree_index)];
      var transform = transform_tree[get_tree_node(l.transform_tree_index)];
      l.unresolved = !clip || !effect || !scroll || !transform;
      if (l.unresolved) return;
      l.clip_tree_index = clip;
      l.effect_tree_index = effect;
      l.scroll_tree_index = scroll;
      l.transform_tree_index = transform;
    });
    transform_tree.forEach(l => {
      l.parent_id = transform_tree[get_tree_node(l.parent_id)];
    });
    scroll_tree.forEach(l => {
      l.parent_id = scroll_tree[get_tree_node(l.parent_id)];
      l.transform_id = transform_tree[get_tree_node(l.transform_id)];
    });
    effect_tree.forEach(l => {
      l.parent_id = effect_tree[get_tree_node(l.parent_id)];
      l.transform_id = transform_tree[get_tree_node(l.transform_id)];
      l.clip_id = clip_tree[get_tree_node(l.clip_id)];
      l.target_id = effect_tree[get_tree_node(l.target_id)];
    });
    clip_tree.forEach(l => {
      l.parent_id = clip_tree[get_tree_node(l.parent_id)];
      l.transform_id = transform_tree[get_tree_node(l.transform_id)];
    });

    // AddStickyPositionData (inspector_page_stream_agent.cc): keyed by
    // transform node id (JSON keys are strings; get_tree_node's job above
    // is for values that can arrive as either a raw id or an
    // already-resolved node, which never applies to an object's own keys),
    // one entry per transform node that has cc::StickyPositionConstraint
    // data. Cross-references (scrollAncestor etc.) get resolved into
    // actual node objects the same way every other tree here does, so
    // stickyOffsetPx() never has to re-look-up an id itself. Absent
    // (undefined) rather than {} only for property-tree JSON from before
    // this field existed -- shouldn't happen live, but a PropTreeDiff.js
    // patch is only ever applied against a tree this same client already
    // parsed, so this can't come up post-connection either way; kept
    // defensive regardless of how unreachable it currently is.
    Object.keys(propTrees.sticky_position_data || {}).forEach(nodeIdStr => {
      var node = transform_tree[parseInt(nodeIdStr, 10)];
      if (!node) return;
      var s = propTrees.sticky_position_data[nodeIdStr];
      node.sticky = {
        scrollAncestor: scroll_tree[s.scrollAncestor],
        xScrollAncestor: s.xScrollAncestor === undefined ? undefined : scroll_tree[s.xScrollAncestor] || null,
        yScrollAncestor: s.yScrollAncestor === undefined ? undefined : scroll_tree[s.yScrollAncestor] || null,
        pixelSnapOffset: s.pixelSnapOffset,
        nearestNodeShiftingStickyBox: transform_tree[s.nearestNodeShiftingStickyBox],
        nearestNodeShiftingContainingBlock: transform_tree[s.nearestNodeShiftingContainingBlock],
        isAnchoredLeft: s.isAnchoredLeft, isAnchoredRight: s.isAnchoredRight,
        isAnchoredTop: s.isAnchoredTop, isAnchoredBottom: s.isAnchoredBottom,
        leftOffset: s.leftOffset, rightOffset: s.rightOffset,
        topOffset: s.topOffset, bottomOffset: s.bottomOffset,
        constraintBoxRect: s.constraintBoxRect,
        scrollContainerRelativeStickyBoxRect: s.scrollContainerRelativeStickyBoxRect,
        scrollContainerRelativeContainingBlockRect: s.scrollContainerRelativeContainingBlockRect,
      };
    });

    this.sessionState = {...this.sessionState, clip_tree, effect_tree, scroll_tree, transform_tree, layer_tree};

  }
  scheduleUpdateScreen() {
    // Coalesce into the already-pending paint instead of postponing it.
    // Tile updates can arrive continuously for several seconds; cancelling
    // and replacing requestAnimationFrame on every update starved the
    // callback until the stream finally went quiet (observed live as blank
    // until ~8s and no final-resolution paint until ~14s).
    if (this.requestAnimationFrameCallback) return;
    this.requestAnimationFrameCallback = requestAnimationFrame(this.updateScreen.bind(this));
  }
  updateScreen() {
    // Capture before even deleting old tiles: that alone can collapse a
    // scroller and must never be mistaken for new compositor input.
    this.captureLocalScrolls();
    this.requestAnimationFrameCallback = null;
    // updateScreen() only ever runs from a fresh 'PageStream.frameDone' (or
    // once, at initial domElement assignment, before any gesture could have
    // happened) -- so any call reaching here is proof a real server frame
    // just arrived. If a pinch gesture left an optimistic zoom transform
    // applied and has since ended, this is the real content that transform
    // was standing in for -- clear it. A zoom-only update can arrive as a
    // proptree change with no accompanying layer/image content, so this
    // must NOT be gated on comittedLayerUpdates being non-empty -- doing so
    // left the transform stuck forever whenever that happened, stacking it
    // on top of the real (already correctly zoomed) content. Guarded on
    // !this.pinch so an update that streams in mid-gesture doesn't fight
    // with the live touch-driven transform.
    if (this.pinchZoomApplied && !this.pinch && this.domElement_) {
      this.domElement_.style.transform = '';
      this.domElement_.style.transformOrigin = '';
      this.pinchZoomApplied = false;
    }

    this.sessionState.comittedLayerUpdates.forEach(params => {
      var l = this.sessionState.layer_tree[params.layerId] = this.sessionState.layer_tree[params.layerId] || { targets: {}};

      if (params.layerDeleted || params.layerInfo || params.zIndex !== undefined || params.targets) {
        this.fullUpdateRequired = true;
      }

      if (params.layerDeleted) {
        l.dom && l.dom.remove();
        l.targets && Object.keys(l.targets).forEach(t => l.targets[t].dom && l.targets[t].dom.remove()); 
        delete this.sessionState.layer_tree[params.layerId];
        return;
      }

      if (params.layerInfo) {
        this.sessionState.layer_tree[params.layerId] = l = {...l, ...this.decodeLayerInfo(params.layerInfo)};
      }

      if (params.zIndex !== undefined)
        l.zIndex=params.zIndex;

      if (params.targets) {
        l.targets = l.targets || {};
        params.targets.forEach(t => {
          if (t.targetDeleted) {
            // Real bug, found live against the deployed instance (repeating
            // "Cannot read properties of undefined (reading 'dom')" on
            // bbc.com): a targetDeleted for a backendNodeId this layer does
            // not currently hold made `old_target` undefined, and the
            // unguarded `.dom` dereference threw.
            //
            // That is not an exotic case, it's routine. Layers get deleted
            // and re-created constantly on a busy page, and the top of this
            // very loop re-creates a previously-deleted layer with a *fresh*
            // empty `targets: {}` -- so any targetDeleted still in flight for
            // a node that lived on the old incarnation (and equally, any
            // duplicate delete) lands on an empty map and blew up.
            //
            // The throw is far more damaging than one missing removal. It
            // escapes this forEach, so the rest of the committed layer
            // updates for the frame never apply AND
            // `comittedLayerUpdates = []` below never runs -- leaving the
            // poisoned update in the queue to be replayed, and to throw
            // again, on every subsequent frame. One stray delete therefore
            // wedges rendering permanently rather than costing a single
            // frame: exactly the "tiles stream in but the page never
            // assembles" symptom observed.
            //
            // Same defensive contract as the cache-miss cull above and the
            // `l.unresolved` teardown below ("Crucially this must not
            // throw"): a delete for a target we don't have is simply a no-op.
            var old_target = l.targets[t.backendNodeId];
            old_target && old_target.dom && old_target.dom.remove();
            delete l.targets[t.backendNodeId];
          } else {
            l.targets[t.backendNodeId] = l.targets[t.backendNodeId] || {};
            Object.assign(l.targets[t.backendNodeId], t, this.targetStatuses.get(params.layerId+':'+t.backendNodeId));
          }
        });
      };
    });

    this.sessionState.comittedLayerUpdates = [];

    if (!this.domElement_) return;

    // Mark all transform nodes as adoptable
    var old_transform_tree = this.sessionState.transform_tree;
    if (old_transform_tree) old_transform_tree.forEach(t => {
      if (t.dom && t.parent_id) {
        t.dom.adoptable=true
      }

    });

    // apply proptrees
    if (this.sessionState.comittedProptrees && this.fullUpdateRequired) {
      this.makeTrees(this.sessionState.comittedProptrees);
    }
    
    // Create or adopt all layers, (and by extension scrolls, clips, transforms and targets)
    this.sessionState.layer_tree.forEach(l => {
      // Stale layer left behind by a property-tree replacement (see
      // makeTrees). It cannot be positioned -- its transform/clip/scroll/
      // effect nodes are gone -- and whatever it is still painting is the
      // previous page's content, so take its DOM (and its targets') down
      // and leave the layer itself in place in case a later tree update
      // brings its nodes back. Crucially this must not throw: everything
      // after it in this loop, including every click target on the page,
      // depends on the loop running to completion.
      if (l.unresolved) {
        l.dom && l.dom.remove();
        l.targets && Object.keys(l.targets).forEach(
            t => l.targets[t].dom && l.targets[t].dom.remove());
        return;
      }
      if (this.fullUpdateRequired)
        this.createDOMLayerNode(l);
      else
        this.attachLayerPixels(l);
    });

    // remove unowned transform nodes
    if (old_transform_tree) old_transform_tree.forEach(t => {
      if (t.dom && (t.dom.adoptable==true))
        t.dom.remove();
    });
    // Scroll extents are valid only after the entire frame has been assembled.
    (this.sessionState.scroll_tree || []).forEach(node => {
      const t = node && node.transform_id;
      if (t && t.dom && t.dom.isConnected && t.scroll) this.applyServerScroll(t);
    });
    this.updateTargetHeights();
    // frameDone only schedules this paint.
    if (this.interactivePending) {
      this.interactivePending = false;
      performance.mark('brisk:interactive-committed');
      requestAnimationFrame(()=>requestAnimationFrame(()=>{
        performance.mark('brisk:interactive-presented');
        globalThis.dispatchEvent(new CustomEvent('brisk:interactive',{detail:{sessionId:this.ws.sessionId,frame:this.lastBriskFrame?.briskFrame}}));
      }));
    }
  }

  resize(width, height, dpr, alreadyApplied = false) {
    if (this.domElement_) {
      this.domElement_.style.width = Math.floor(width) + 'px';
      this.domElement_.style.height = Math.floor(height) + 'px';
    }
    globalThis.briskViewport?.();
    if(alreadyApplied)return Promise.resolve({});
    return this.ws.req('Emulation.setDeviceMetricsOverride', {
      height: Math.floor(height),
      width: Math.floor(width),
      deviceScaleFactor: dpr,
      mobile: !globalThis.matchMedia?.('(any-pointer: fine)').matches
    }); 
  }

  touch(n, e){
    if (n === 'touchStart') this.suppressTouchEnd = false;
    if (n === 'touchEnd' && this.suppressTouchEnd) {
      this.suppressTouchEnd = false;
      return;
    }
    if (e.cancel) n = 'touchCancel';
    this.trackGestureForTrace(n, e);
    this.handlePinchGesture(n, e);

    if (n === 'touchStart') {
      this.localTouchScroll = false;
      const finger = e.touches.length === 1 && e.touches[0];
      this.touchScrollOrigin = finger && {
        x: finger.clientX, y: finger.clientY,
        scrollers: e.composedPath().filter(node => node.classList?.contains('scroll'))
      };
    }
    const origin = this.touchScrollOrigin;
    if (n === 'touchMove' && !this.localTouchScroll && origin && e.touches.length === 1) {
      const dx = origin.x - e.touches[0].clientX, dy = origin.y - e.touches[0].clientY;
      if (Math.hypot(dx, dy) >= 8 && origin.scrollers.some(dom =>
          (dx && dom.scrollWidth > dom.clientWidth) ||
          (dy && dom.scrollHeight > dom.clientHeight))) {
        // Native browsers cancel the page's touch stream when scrolling takes
        // over. Do the same remotely BEFORE forwarding a move that could start
        // a second server-side fling. This includes gestures at a local edge:
        // the delayed server might still be far from that edge. setScroll
        // carries the local movement.
        this.localTouchScroll = true;
        this.ws.req('Input.dispatchTouchEvent', {type:'touchCancel',touchPoints:[]}).catch(() => {});
      }
    }
    if (this.localTouchScroll) {
      if (n === 'touchEnd' || n === 'touchCancel') this.touchScrollOrigin = null;
      return;
    }
    if (n === 'touchEnd' || n === 'touchCancel') this.touchScrollOrigin = null;
    this.ws.req('Input.dispatchTouchEvent', {
      type: n,
      touchPoints: Array(...e.touches).map(t => { return {x: t.clientX, y: t.clientY, id:t.identifier}}),
    }).catch(() => {});
  }

  // Records single-finger drags as 'scroll' trace events (see
  // interactionTrace.js / test/replayTrace.js), using the same {x, y, dy}
  // shape test/scenarios.js's action DSL already uses -- x/y is the drag's
  // start point, dy is signed so a finger moving up (content scrolling
  // down) is positive, matching applyFrontendAction's own convention.
  // Multi-touch (pinch) gestures are deliberately not recorded as scrolls;
  // handlePinchGesture already covers that case separately, and a two-finger
  // drag isn't something a coordinate-based scroll replay could reproduce
  // anyway.
  trackGestureForTrace(n, e) {
    if (e.touches && e.touches.length >= 2) { this._traceGesture = null; return; }
    if (n === 'touchStart') {
      const t = e.touches[0];
      this._traceGesture = t && {startX: t.clientX, startY: t.clientY, lastX: t.clientX, lastY: t.clientY};
      return;
    }
    if (n === 'touchMove' && this._traceGesture) {
      const t = e.touches[0];
      if (t) { this._traceGesture.lastX = t.clientX; this._traceGesture.lastY = t.clientY; }
      return;
    }
    if ((n === 'touchEnd' || n === 'touchCancel') && this._traceGesture) {
      const g = this._traceGesture;
      this._traceGesture = null;
      const dy = g.startY - g.lastY;
      const dx = g.lastX - g.startX;
      // Below this, it's a tap (already recorded, if it landed on a link,
      // by targetTouch's own 'click' trace event) rather than a scroll.
      if (Math.abs(dy) < 10 && Math.abs(dx) < 10) return;
      interactionTrace.record('scroll', {x: Math.round(g.startX), y: Math.round(g.startY), dy: Math.round(dy)});
    }
  }

  // Scroll gets local prediction for free (native DOM scrolling on the '.scroll'
  // elements), but pinch-zoom has no browser-native path here (the page's own
  // <meta viewport> sets user-scalable=no, and there's no zoom handling on the
  // server-streamed content either) -- the real zoomed re-render only shows up
  // after a full server round trip. So apply an optimistic CSS transform on the
  // root element the instant a 2-finger gesture starts, purely for immediate
  // visual feedback, and let the real thing (the next genuine streamed update)
  // replace it once it arrives.
  handlePinchGesture(n, e) {
    if (!this.domElement_) return;
    if (e.touches.length == 2) {
      var [t0, t1] = e.touches;
      var dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
      if (!this.pinch) this.pinch = {startDist: dist};
      var scale = dist / this.pinch.startDist;
      this.domElement_.style.transformOrigin = ((t0.clientX + t1.clientX) / 2) + 'px ' + ((t0.clientY + t1.clientY) / 2) + 'px';
      this.domElement_.style.transform = 'scale(' + scale + ')';
      this.pinchZoomApplied = true;
    } else if (this.pinch) {
      // Gesture ended (or dropped below 2 touches) -- leave the optimistic
      // transform in place. Clearing it here would snap back to the
      // pre-zoom layout for the rest of the round trip; updateScreen()
      // clears it once real content replaces it instead.
      this.pinch = null;
    }
  }

  destroy() {
    this.ws.destroy();
    this.domElement = null;
  }
}
