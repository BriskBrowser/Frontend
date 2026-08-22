import {deepClone} from './deepclone.js'

// Session-global cache of tile bytes by content id (server-computed hash of
// the tile's pixels), shared across every layer and every Session in this
// tab -- including a session promoted from a speculative fork, which is
// exactly the case this exists for. The server omits `image` from a
// BufferUpdate whenever it believes this client already holds the bytes for
// `tileId` (a resize/split/repeated motif/navigation/promoted fork reusing
// content already sent); this cache is where those bytes actually live so
// they can be reused instead of re-fetched. See docs/tile-transport.md.
const tileStore = new Map();

export class Session {
  // domElement can be null, in which case this session will be initialised when its set with the setter.
  constructor(ws, baseSession, options) {
    this.options = options || {};
    this.sessionState = {
      preventscroll: 0,
      nextLayerUpdates: [],
      comittedLayerUpdates: [],
      layer_tree: [],
      keyboard: {showing: false}
    };

    this.ws = ws;
    this.onNewSession = () => {};
    this.onSessionActivate = () => {};
    this.onSessionSetHeight = () => {};

    if (baseSession) {
      this.sessionState = deepClone(baseSession.sessionState);
    }

    this.ws.eventListeners['PageStream.streamLayerInfo'] =  msg => {
      this.sessionState.nextLayerUpdates.push(msg.layerUpdate);
      // Create any sessions for event target clicks, because they could start sending data right away.
      msg.layerUpdate.targets && msg.layerUpdate.targets.forEach(x=> {
        x.sessionId && this.onNewSession(x.sessionId, this)
      });
    };

    this.ws.eventListeners['PageStream.streamPropTrees'] =  params => {
      this.sessionState.nextProptrees = JSON.parse(params.propertyTreesJSON);
      this.fullUpdateRequired = true;
    };
    
    this.ws.eventListeners['PageStream.frameDone'] = () => {
      this.sessionState.comittedLayerUpdates = this.sessionState.comittedLayerUpdates.concat(this.sessionState.nextLayerUpdates);
      this.sessionState.nextLayerUpdates = [];
      if (this.sessionState.nextProptrees) {
        this.sessionState.comittedProptrees = this.sessionState.nextProptrees;
        delete this.sessionState.nextProptrees;
      }
      this.scheduleUpdateScreen();
    };

    this.ws.eventListeners['PageStream.keyboardStateChange'] = params => {
      this.sessionState.keyboard = params;

      this.updateKeyboard();
    }

  }

  // Element ele is adopted by this Session.  It will be removed if a new element is bound.
  set domElement(ele) {
    // get rid of old element
    this.domElement_ &&  this.domElement_.remove();

    this.domElement_ = ele;
    if (ele) {
      ['touchStart', 'touchEnd', 'touchCancel', 'touchMove'].forEach(evt =>
        ele.addEventListener(evt.toLowerCase(), this.touch.bind(this, evt), {passive: true}));

      this.keyboard = document.createElement('textarea');
      this.keyboard.style = "width: 0px; height: 0px; position: absolute; z-index: -999";
      this.keyboard.oninput = this.keyboardHandler.bind(this);
      this.keyboardUpdateBlockedCtr = 0;

      ele.appendChild(this.keyboard);
      this.updateKeyboard();
    }

    this.updateScreen();
  }

  updateKeyboard() {
    if (this.keyboard && !this.keyboardUpdateBlockedCtr) {
      var params = this.sessionState.keyboard;
      this.keyboard.innerText = params.inputBoxValue;
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

    await this.ws.req("PageStream.setKeyboardState", {
      inputBoxValue: e.target.value,
      selectionStart: e.target.selectionStart,
      selectionEnd: e.target.selectionEnd
    });

    this.keyboardUpdateBlockedCtr--;
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

  createDOMTransformNode(t, zIndex, adopt) {
    if (t.parent_id) {
      if (!t.dom && adopt)
        // See if there is an element we might adopt
        if (adopt.adoptable) {
          t.dom = adopt
        }

      var oldZIndex = t.zIndex || -1;
      
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
      if (oldZIndex != t.zIndex)
        t.dom.style.zIndex = t.zIndex;

      if (t.clip) {
        t.dom.style.width = t.clip.clip[2] + 'px';
        t.dom.style.height = t.clip.clip[3] + 'px';
        t.dom.style.top = t.clip.clip[1] + 'px';
        t.dom.style.left = t.clip.clip[0] + 'px';
        t.dom.style.borderRadius = this.roundedCornerCssFor(t.clip);
      }
      t.dom.style.transform = this.toCss(t.local, t.origin, t.post_translation);

      if (t.scroll) this.applyServerScroll(t);
      t.dom.onscroll = t.scroll?this.scrollHandler.bind(this, t):undefined;
      t.dom.classList.toggle('scroll', !!t.scroll)

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
        t.sessionId && t.containingQuads && this.onSessionSetHeight(t.sessionId, t.containingQuads[0][1])
      })
    });
  }

  scrollHandler(t, evt) {
    // Distinguishes a real (touch-driven) scroll from the echo fired by
    // applyServerScroll's own `t.dom.scrollTop = ...` below -- setting
    // scrollTop programmatically still dispatches a native 'scroll' event,
    // and without this guard that echo would immediately report the
    // server's own value straight back to it as if the user had scrolled
    // there themselves (harmless -- same value -- but pointless chatter,
    // and it stomps the "was this recently a *local* scroll" signal
    // applyServerScroll depends on).
    if (t.dom.applyingServerScroll) { t.dom.applyingServerScroll = false; return; }

    t.dom.lastLocalScrollTime = Date.now();
    this.sessionState.preventscroll++;
    this.sessionState.preventscrollElem = t.scroll.element_id.id_;
    this.ws.req('PageStream.setScroll', {backendNodeId:  t.scroll.element_id.id_, x: Math.floor(t.dom.scrollLeft), y: Math.floor(t.dom.scrollTop)}).then(x => {
      this.sessionState.preventscroll--;
      // preventscrollElem is a single global slot, not tracked per in-flight
      // request -- it must be cleared once nothing is outstanding, or it
      // permanently "remembers" whichever element last scrolled and blocks
      // applyServerScroll from ever reconciling that element again, even
      // long after this request actually completed (this was never visible
      // before applyServerScroll existed, since nothing else read this
      // field once the request settled).
      if (!this.sessionState.preventscroll) this.sessionState.preventscrollElem = null;
    });
    this.updateTargetHeights();
  }

  // Local scrolling is the whole point of this architecture -- a scroll
  // gesture must never wait on the server. But the *server's* page can also
  // move its own scroll positions (window.scrollTo(), infinite-scroll
  // pagination, a "back to top" button, anything the page's own script
  // does), and since PageStream only streams positions the server computed,
  // that change is otherwise invisible until something makes the client
  // adopt it. This reconciles the two: apply the server's reported
  // scroll_offset for a '.scroll' element, but only once local activity on
  // that *specific* element has gone quiet -- so an active user scroll
  // always wins locally (the "typical case"), while a server-side
  // reposition the user isn't actively fighting still eventually lands
  // ("awkward script" case). Guards against redundant writes (the earlier,
  // disabled version of this unconditionally set scrollTop/scrollLeft on
  // every single update regardless of whether the value had even changed --
  // called out in a comment here as a "perf bottleneck", which this avoids).
  applyServerScroll(t) {
    // A fresh incoming scroll_offset can legitimately be *stale* -- it's
    // whatever the server had committed as of a round trip ago, and under
    // real latency (the whole reason local scroll exists in the first
    // place) that can lag several seconds behind a scroll already in
    // flight. 2000ms is a deliberately generous margin against that,
    // wider than a single round trip needs to be under most real-world
    // latency -- worth being conservative here, since the failure mode of
    // *too short* is actively snapping a live scroll backwards mid-fling
    // (confirmed: reproduced at 400ms under 1s one-way injected latency,
    // see test/run_latency.js), while *too long* just delays how quickly
    // an "awkward script" server-side change is noticed, a much milder
    // cost for what should be a rare case anyway.
    var recentlyScrolledLocally = t.dom.lastLocalScrollTime && (Date.now() - t.dom.lastLocalScrollTime < 2000);
    // Coarser, global backstop alongside the per-element check above: a
    // touch's eventual scroll target isn't knowable without hit-testing, so
    // this can't be narrowed to "this element specifically" -- any recent
    // touch anywhere defers reconciliation everywhere, briefly. Shorter
    // window than the per-element one (that touch may turn out to target a
    // *different* element than the one being considered here, or none at
    // all) but still long enough to cover momentum/fling's post-touchend
    // ramp-up before its first native 'scroll' event fires.
    var recentTouchAnywhere = this.sessionState.lastTouchTime && (Date.now() - this.sessionState.lastTouchTime < 1000);
    var hasInFlightRequest = this.sessionState.preventscrollElem === t.scroll.element_id.id_;
    if (recentlyScrolledLocally || hasInFlightRequest || this.sessionState.touchActive || recentTouchAnywhere) return;

    var newTop = Math.round(t.scroll_offset[1]), newLeft = Math.round(t.scroll_offset[0]);
    if (t.dom.scrollTop === newTop && t.dom.scrollLeft === newLeft) return;

    t.dom.applyingServerScroll = true;
    t.dom.scrollTop = newTop;
    t.dom.scrollLeft = newLeft;
  }
  createDOMLayerImages(l) {
    l.images && l.images.forEach(i => {
      if (i.dom.activeInLayer != l) {
        // TODO:  i.dom is shared with other sessions - implement some kind of refcounting & duplication here.
        l.dom.appendChild(i.dom);
        i.dom.style.position = 'absolute';
        i.dom.style.top = i.clip.y + 'px';
        i.dom.style.left = i.clip.x + 'px';
        i.dom.width = i.clip.width;
        i.dom.height = i.clip.height;
        i.dom.activeInLayer = l;
      }
    });
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
    if (!l.images || l.name == 'Frame Overlay Content Layer') return;

    // Huh - looks like a scrollingcontents layer.  If so, set everything up appropriately
    if (l.clip_tree_index.transform_id === l.scroll_tree_index.transform_id.parent_id  &&
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
    
    this.createDOMLayerImages(l);

    // offsetToTransformParent is expressed relative to the transform node's
    // own property-tree origin -- but when that node carries a .clip (see
    // above: a scroll frame's clip box is positioned via CSS top/left at
    // clip[0],clip[1] rather than at the node's true origin), the node's
    // *DOM box* origin is already shifted by that same clip amount. Without
    // subtracting it back out here, every layer parented under a bordered/
    // padded scroll frame renders one clip-offset too far right/down (see
    // BUGS.md #5 -- confirmed by direct pixel measurement: frontend items
    // landed exactly clip[0]/clip[1] past ground truth, uniformly in both
    // axes, only on scrollers with a nonzero clip offset).
    var clipOffsetX = (l.transform_tree_index.clip && l.transform_tree_index.clip.clip[0]) || 0;
    var clipOffsetY = (l.transform_tree_index.clip && l.transform_tree_index.clip.clip[1]) || 0;
    l.dom.style.top = (l.offsetToTransformParent[1] - clipOffsetY) + 'px';
    l.dom.style.left = (l.offsetToTransformParent[0] - clipOffsetX) + 'px';
    l.dom.style.width=l.bounds[0] + 'px';
    l.dom.style.height=l.bounds[1] + 'px';
    l.dom.style.overflow = 'hidden';
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

  targetTouch(type, evt) {
    // We want to detect 'click' events, but have to use touch instead because
    // we'll need to cancel the global touch event touch if we detect a click, and the onclick() event
    // fires too late to do that.
    if (type=='touchStart' && evt.touches.length==1) {
      evt.currentTarget.metadata.touchStarted = true;
    } else if (type=='touchEnd' && evt.currentTarget.metadata.touchStarted) {
      if (evt.currentTarget.metadata.sessionId) {
        // Means we have preloaded this click - we just need to transfer to that session.
        this.onSessionActivate(evt.currentTarget.metadata.sessionId);
      }
      this.ws.req('PageStream.clickNode', { backendNodeId: evt.currentTarget.metadata.backendNodeId } );
      evt.cancel = true;
    } else {
      delete evt.currentTarget.metadata.touchStarted;
    }
  }

  createTargetNode(t, l) {
    if (!t.containingQuads) return;
    var container = l.dom.parentNode;
    if (!t.dom) {
      t.dom=document.createElement('div');
      ['touchStart', 'touchEnd', 'touchCancel', 'touchMove'].forEach(evt =>
        t.dom.addEventListener(evt.toLowerCase(), this.targetTouch.bind(this, evt), {passive: true}));
    }
    if (t.dom.parentNode != container) container.appendChild(t.dom);
    t.dom.style.left = t.containingQuads[0][0]+'px';
    t.dom.style.top = t.containingQuads[0][1]+'px';
    t.dom.style.width = (t.containingQuads[0][4]-t.containingQuads[0][0])+'px';
    t.dom.style.height = (t.containingQuads[0][5]-t.containingQuads[0][1])+'px';

    
    t.dom.metadata = t;
    if (this.options.showLinkOverlay) {
      t.dom.classList.add('link');
      t.dom.classList.toggle('alive', !!t.sessionId);
    }
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
  toCss(matrix, origin, postTranslation) {
    matrix = Array(16).fill().map((_,i) => matrix[Math.floor(i/4) + (i%4)*4]);
    var ox = (origin && origin[0]) || 0, oy = (origin && origin[1]) || 0, oz = (origin && origin[2]) || 0;
    var px = (postTranslation && postTranslation[0]) || 0, py = (postTranslation && postTranslation[1]) || 0;
    var parts = [];
    if (px + ox || py + oy || oz) parts.push(`translate3d(${px + ox}px, ${py + oy}px, ${oz}px)`);
    var mat = 'matrix3d(' + matrix.join(',') + ')';
    if (mat !== 'matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1)') parts.push(mat);
    if (ox || oy || oz) parts.push(`translate3d(${-ox}px, ${-oy}px, ${-oz}px)`);
    return parts.join(' ');
  }


  makeTrees(propTrees) {
    var clip_tree = propTrees.clip_tree.nodes.reduce((map, obj) => (map[obj.id] = obj, map), []);
    var effect_tree = propTrees.effect_tree.nodes.reduce((map, obj) => (map[obj.id] = obj, map), []);
    var scroll_tree = propTrees.scroll_tree.nodes.reduce((map, obj) => (map[obj.id] = obj, map), []);
    var transform_tree = propTrees.transform_tree.nodes.reduce((map, obj) => (map[obj.id] = obj, map), []);

    var layer_tree = this.sessionState.layer_tree;

    function get_tree_node(a) {
      if (Number.isInteger(a)) return a;
      if (a === undefined) return a;
      return a.id;
    }
    layer_tree.forEach(l => {
      l.clip_tree_index = clip_tree[get_tree_node(l.clip_tree_index)];
      l.effect_tree_index = effect_tree[get_tree_node(l.effect_tree_index)];
      l.scroll_tree_index = scroll_tree[get_tree_node(l.scroll_tree_index)];
      l.transform_tree_index = transform_tree[get_tree_node(l.transform_tree_index)];
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

    this.sessionState = {...this.sessionState, clip_tree, effect_tree, scroll_tree, transform_tree, layer_tree};

  }
  scheduleUpdateScreen() {
    if (this.requestAnimationFrameCallback) cancelAnimationFrame(this.requestAnimationFrameCallback);
    this.requestAnimationFrameCallback = requestAnimationFrame(this.updateScreen.bind(this));
  }
  updateScreen() {
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

      if (params.layerDeleted || params.layerInfo || params.zIndex || params.targets) {
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

      if (params.zIndex)
        l.zIndex=params.zIndex;

      if (params.bufferUpdates) {
        l.images = l.images || [];

        params.bufferUpdates.forEach(bufUpdate => {
          // Cull images this new image covers up (note - this test could cull more things)
          for (let i = l.images.length - 1; i >= 0; i--) {
            if (l.images[i].clip.x >= bufUpdate.clip.x &&
              l.images[i].clip.y >= bufUpdate.clip.y &&
              l.images[i].clip.x + l.images[i].clip.width <= bufUpdate.clip.x + bufUpdate.clip.width &&
              l.images[i].clip.y + l.images[i].clip.height <= bufUpdate.clip.y + bufUpdate.clip.height) {
            l.images[i].dom.activeInLayer == l && l.images[i].dom.remove();
            l.images.splice(i, 1);
            }
          }
          var domImage;
          if (bufUpdate.image) {
            domImage = new Image();
            domImage.src = bufUpdate.image;
            domImage.decode();
            // Indicates this HTMLElement can be referenced from multiple sessions.
            domImage.sharable = true;
            if (bufUpdate.tileId) tileStore.set(bufUpdate.tileId, bufUpdate.image);
          } else if (bufUpdate.srcTileId !== undefined) {
            // Motion-vector reference ("blit", docs/tile-transport.md
            // Section 4a): this tile's content is a verified byte-exact
            // crop of an already-cached tile. Checked *before* the plain
            // tileId branch below even though a blit response also
            // carries its own `tileId` -- srcTileId is the more specific
            // signal and must win, or this would be misrouted into the
            // exact-match path, which would look up this tile's own
            // (not-yet-cached) id instead of resolving the reference.
            //
            // dx/dy/rasterWidth/rasterHeight are all in the cached source
            // image's *natural* pixel space, deliberately not CSS pixels:
            // drawImage()'s 9-arg source-rect is always interpreted that
            // way regardless of any CSS size applied to the image, so
            // converting them server-side would just be wrong unit math
            // for no benefit -- see inspector_page_stream_agent.cc's
            // commitImage() for the full reasoning.
            var srcCachedSrc = tileStore.get(bufUpdate.srcTileId);
            if (srcCachedSrc) {
              var srcImg = new Image();
              srcImg.src = srcCachedSrc;
              var canvas = document.createElement('canvas');
              canvas.width = bufUpdate.clip.width;
              canvas.height = bufUpdate.clip.height;
              var ctx = canvas.getContext('2d');
              var tileIdForCache = bufUpdate.tileId;
              srcImg.decode().then(() => {
                ctx.drawImage(srcImg, bufUpdate.dx, bufUpdate.dy, bufUpdate.rasterWidth, bufUpdate.rasterHeight,
                              0, 0, bufUpdate.clip.width, bufUpdate.clip.height);
                // Cache the reconstructed result under this tile's own id
                // too -- a future BufferUpdate may reference *this* tile
                // as a srcTileId (server-side, blit sources aren't
                // limited to full-image tiles; see TileMotionIndex's
                // Stage() call sites), and it needs to resolve the same
                // way any other cached tile does.
                if (tileIdForCache) tileStore.set(tileIdForCache, canvas.toDataURL());
              }).catch(e => console.warn('PageStream: blit source', bufUpdate.srcTileId, 'failed to decode', e));
              domImage = canvas;
              domImage.sharable = true;
            } else {
              // Same cache-miss reasoning as the plain tileId branch below.
              console.warn('PageStream: srcTileId', bufUpdate.srcTileId, 'referenced by blit but not in local tileStore (cache miss)');
            }
          } else if (bufUpdate.tileId) {
            // No `image` -- the server believes we already hold this tile's
            // bytes under `tileId` (see tileStore's own comment above).
            var cachedSrc = tileStore.get(bufUpdate.tileId);
            if (cachedSrc) {
              domImage = new Image();
              domImage.src = cachedSrc;
              domImage.decode();
              domImage.sharable = true;
            } else {
              // A genuine cache miss: the server's residency model and this
              // client's actual cache have diverged (there's no client-side
              // eviction yet, so this shouldn't happen in practice -- but if
              // it does, leave the region showing whatever was previously
              // drawn there rather than guess at wrong pixels. No resend
              // round-trip yet; see docs/tile-transport.md §6.
              console.warn('PageStream: tileId', bufUpdate.tileId, 'referenced but not in local tileStore (cache miss)');
            }
          } else if (bufUpdate.color !== undefined) {
            // Uniform solid-color tile (docs/tile-transport.md §5) -- no
            // image data at all, just fill the clip rect. `color` arrives
            // as a signed 32-bit int (protocol `integer`); `>>> 0` undoes
            // the 0xRRGGBBAA-packed-into-an-int32 reinterpretation
            // inspector_page_stream_agent.cc's commitImage() applies.
            var packed = bufUpdate.color >>> 0;
            var r = (packed >>> 24) & 0xff, g = (packed >>> 16) & 0xff,
                b = (packed >>> 8) & 0xff, a = packed & 0xff;
            domImage = document.createElement('div');
            // createDOMLayerImages() below also sets the `width`/`height`
            // *properties* (meaningful for <img>, a no-op expando on a
            // <div>) -- set the real CSS size here instead.
            domImage.style.width = bufUpdate.clip.width + 'px';
            domImage.style.height = bufUpdate.clip.height + 'px';
            domImage.style.backgroundColor = 'rgba(' + r + ',' + g + ',' + b + ',' + (a / 255) + ')';
            domImage.sharable = true;
          }
          l.images.push({clip: bufUpdate.clip, dom: domImage});
        });
      }

      if (params.targets) {
        params.targets.forEach(t => {
          if (t.targetDeleted) {
            var old_target = l.targets[t.backendNodeId]
            old_target.dom && old_target.dom.remove();
            delete l.targets[t.backendNodeId];
          } else {
            l.targets[t.backendNodeId] = l.targets[t.backendNodeId] || {};
            Object.assign(l.targets[t.backendNodeId], t);
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
      if (this.fullUpdateRequired)
        this.createDOMLayerNode(l);
      else
        this.createDOMLayerImages(l);
    });

    // remove unowned transform nodes
    if (old_transform_tree) old_transform_tree.forEach(t => {
      if (t.dom && (t.dom.adoptable==true))
        t.dom.remove();
    });
    this.updateTargetHeights();
  }

  resize() {
    this.ws.req('Emulation.setDeviceMetricsOverride', {
      height: window.innerHeight,
      width: Math.floor(window.innerWidth),
      deviceScaleFactor: window.devicePixelRatio,
      mobile: true
    }); 
  }

  touch(n, e){
    if (e.cancel) {
      n = 'touchCancel';
    }
    // A finger is down but hasn't produced a native 'scroll' event *yet* --
    // browsers don't fire one on the very first touchmove, only once actual
    // movement is registered -- so applyServerScroll's own recency check
    // (which depends on a 'scroll' event having already happened at least
    // once) can't see this window on its own. touchActive alone still
    // leaves a second gap: browser-driven momentum/fling can keep scrolling
    // well after touchend, and there's no guarantee a fresh 'scroll' event
    // has fired by the time the *next* one would (confirmed empirically:
    // reproduced with just touchActive in place, under 1s one-way injected
    // latency -- see test/run_latency.js). Track touch recency globally
    // (not per scroll element -- a touch's eventual target isn't known
    // without hit-testing) as a second, coarser guard alongside it.
    this.sessionState.touchActive = (n === 'touchStart' || n === 'touchMove');
    this.sessionState.lastTouchTime = Date.now();
    this.handlePinchGesture(n, e);
    this.ws.req('Input.dispatchTouchEvent', {
      type: n,
      touchPoints: Array(...e.touches).map(t => { return {x: t.clientX, y: t.clientY, id:t.identifier}}),
    });
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