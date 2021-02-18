import {deepClone} from './deepclone.js'


export class Session {
  // domElement can be null, in which case this session will be initialised when its set with the setter.
  constructor(ws, baseSession) {
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
        if (t.clip.clip[0] || t.clip.clip[1])
          t.dom.style.transform = `matrix3d(1,0,0,0, 0,1,0,0, 0,0,1,0, ${t.clip.clip[0]},${t.clip.clip[1]},0,1) ` + this.toCss(t.local);
        else
          t.dom.style.transform = this.toCss(t.local);
      } else {
        t.dom.style.transform = this.toCss(t.local);
      }
      
      if (t.scroll && this.sessionState.preventscrollElem != t.scroll.element_id.id_) {
        // Perf bottleneck - server side scrolling disabled
        //t.dom.scrollTop = t.scroll_offset[1];
        //t.dom.scrollLeft = t.scroll_offset[0];
      }
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
    this.sessionState.preventscroll++;
    this.sessionState.preventscrollElem = t.scroll.element_id.id_;
    //if (t.dom.scrollTop == t.scroll_offset[1] && t.dom.scrollLeft==t.scroll_offset[0]) return;
    this.ws.req('PageStream.setScroll', {backendNodeId:  t.scroll.element_id.id_, x: Math.floor(t.dom.scrollLeft), y: Math.floor(t.dom.scrollTop)}).then(x => {this.sessionState.preventscroll--;});
    this.updateTargetHeights();
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

    l.dom.style.top = l.offsetToTransformParent[1] + 'px';
    l.dom.style.left = l.offsetToTransformParent[0] + 'px';
    l.dom.style.width=l.bounds[0] + 'px';
    l.dom.style.height=l.bounds[1] + 'px';
    l.dom.style.overflow = 'hidden';
    l.dom.style.position = 'absolute';
    l.dom.style.zIndex = l.zIndex;
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
    t.dom.classList.add('link');
    t.dom.classList.toggle('alive', !!t.sessionId);
  }

  toCss(matrix) {
    var matrix = Array(16).fill().reverse().map((_,i) => matrix[Math.floor(i/4) + (i%4)*4]);
    var res = 'matrix3d('+ matrix.join(',') + ')';
    // Special case identity transform
    if (res=="matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1)") return '';
    return res;
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
    this.ws.req('Input.dispatchTouchEvent', {
      type: n,
      touchPoints: Array(...e.touches).map(t => { return {x: t.clientX, y: t.clientY, id:t.identifier}}),
    });
  }

  destroy() {
    this.ws.destroy();
    this.domElement = null;
  }
}