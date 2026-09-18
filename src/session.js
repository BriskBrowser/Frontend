import {tileElement} from './h264tiles.js';
import {deepClone} from './deepclone.js'
import {interactionTrace} from './interactionTrace.js?v=20260827-trace1'
import {applyPropTreePatch} from './propTreePatch.js'

// Session-global cache of tile bytes by content id (server-computed hash of
// the tile's pixels), shared across every layer and every Session in this
// tab -- including a session promoted from a speculative fork, which is
// exactly the case this exists for. The server omits `image` from a
// BufferUpdate whenever it believes this client already holds the bytes for
// `tileId` (a resize/split/repeated motif/navigation/promoted fork reusing
// content already sent); this cache is where those bytes actually live so
// they can be reused instead of re-fetched. See docs/tile-transport.md.
const tileStore = new Map();

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

// --- Tile region arithmetic -------------------------------------------------
//
// A BufferUpdate's raster is a *complete* re-raster of its clip rect of the
// layer, not a diff of what changed inside it (verified live: the small
// "16,39,133,20" stats-text update tile carries the card's own translucent
// background at exactly the same alpha as the full-card tile underneath it,
// not just the glyphs). That is what makes it legal to take the pixels
// underneath a new tile away entirely -- see updateScreen()'s cull.

function rectRight(r) { return r.x + r.width; }
function rectBottom(r) { return r.y + r.height; }

// Does `outer` completely cover `inner`?
function rectContains(outer, inner) {
  return inner.x >= outer.x && inner.y >= outer.y &&
         rectRight(inner) <= rectRight(outer) && rectBottom(inner) <= rectBottom(outer);
}

// The overlapping part of two rects, or null if they don't overlap.
function rectIntersect(a, b) {
  var x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  var r = Math.min(rectRight(a), rectRight(b)), bt = Math.min(rectBottom(a), rectBottom(b));
  if (r <= x || bt <= y) return null;
  return {x: x, y: y, width: r - x, height: bt - y};
}

// `a` minus `b`, as up to four *disjoint* rects (top band, bottom band, then
// left and right of the overlap between them). Disjointness is not a detail:
// the clip-path built from these uses ordinary nonzero winding, so two hole
// rects that overlapped each other would cancel back to "filled" and
// resurrect the very pixels they were meant to erase.
function rectSubtract(a, b) {
  var overlap = rectIntersect(a, b);
  if (!overlap) return [a];
  var out = [];
  if (overlap.y > a.y)
    out.push({x: a.x, y: a.y, width: a.width, height: overlap.y - a.y});
  if (rectBottom(overlap) < rectBottom(a))
    out.push({x: a.x, y: rectBottom(overlap), width: a.width, height: rectBottom(a) - rectBottom(overlap)});
  if (overlap.x > a.x)
    out.push({x: a.x, y: overlap.y, width: overlap.x - a.x, height: overlap.height});
  if (rectRight(overlap) < rectRight(a))
    out.push({x: rectRight(overlap), y: overlap.y, width: rectRight(a) - rectRight(overlap), height: overlap.height});
  return out;
}

// Glue back together hole rects that share a whole edge. Without this, a
// region that repaints at a slowly-changing width (the stats page's CPU
// progress bar walks 129px -> 139px and back, one pixel at a time) would add
// a fresh one-pixel-wide sliver to the hole list on every single frame and
// grow it without bound for as long as the page stays open.
function coalesceRects(rects) {
  for (var again = true; again; ) {
    again = false;
    outer:
    for (var i = 0; i < rects.length; i++) {
      for (var j = i + 1; j < rects.length; j++) {
        var a = rects[i], b = rects[j], merged = null;
        if (a.x === b.x && a.width === b.width &&
            (rectBottom(a) === b.y || rectBottom(b) === a.y))
          merged = {x: a.x, y: Math.min(a.y, b.y), width: a.width, height: a.height + b.height};
        else if (a.y === b.y && a.height === b.height &&
            (rectRight(a) === b.x || rectRight(b) === a.x))
          merged = {x: Math.min(a.x, b.x), y: a.y, width: a.width + b.width, height: a.height};
        if (merged) {
          rects.splice(j, 1);
          rects[i] = merged;
          again = true;
          break outer;
        }
      }
    }
  }
  return rects;
}

// Erase `hole` (in layer coordinates) from a tile entry. Returns true once
// nothing of the tile is left visible, so the caller can drop it outright.
function punchTileHole(entry, hole) {
  entry.holes = entry.holes || [];
  var pieces = [hole];
  entry.holes.forEach(h => {
    pieces = pieces.reduce((acc, p) => acc.concat(rectSubtract(p, h)), []);
  });
  if (pieces.length) {
    entry.holes = coalesceRects(entry.holes.concat(pieces));
    entry.holesChanged = true;
  }
  var covered = entry.holes.reduce((n, h) => n + h.width * h.height, 0);
  return covered >= entry.clip.width * entry.clip.height;
}

// The tile's own rect with every hole cut out of it, in the element's local
// (border-box) coordinates. Holes are wound the opposite way round from the
// outer rect so plain nonzero winding drops them; that avoids depending on
// path()'s optional `evenodd` argument being parsed, and is only correct
// because punchTileHole() keeps the holes disjoint.
function clipPathForTile(entry) {
  if (!entry.holes || !entry.holes.length) return '';
  var w = entry.clip.width, h = entry.clip.height;
  var d = 'M0,0 L' + w + ',0 L' + w + ',' + h + ' L0,' + h + ' Z';
  entry.holes.forEach(o => {
    var x = o.x - entry.clip.x, y = o.y - entry.clip.y;
    d += ' M' + x + ',' + y + ' L' + x + ',' + (y + o.height) +
         ' L' + (x + o.width) + ',' + (y + o.height) + ' L' + (x + o.width) + ',' + y + ' Z';
  });
  return 'path("' + d + '")';
}

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

    this.ws.eventListeners['PageStream.startupMode']=params=>{this.bootstrapPreview=!params.serverUpgrade;};
    this.previewGeneration = 0;
    this.ws.eventListeners['PageStream.frameStart'] = () => {this.previewFrameHasLayers=false;};
    this.ws.eventListeners['PageStream.preview'] = msg => {
      const source=msg.binaryImageId===undefined?msg.image:this.ws.ws.takeBinaryImage(msg.binaryImageId);
      const generation=++this.previewGeneration;
      import('/compactPreview.js').then(({CompactPreview})=>{
        if(generation!==this.previewGeneration){if(typeof source==='string'&&source.startsWith('blob:'))URL.revokeObjectURL(source);return;}
        if(!this.compactPreview)this.compactPreview=new CompactPreview();
        return this.compactPreview.set(msg,source,this.domElement_).then(()=>{
          if(this.bootstrapPreview&&generation===this.previewGeneration){
            this.bootstrapPreview=false;
            return this.ws.req('PageStream.enable',{previewOnly:false,bytesPerFrame:999999999})
              .then(()=>this.ws.req('PageStream.flush',{}));
          }
        });
      }).catch(error=>{
        console.error('PageStream: invalid compact preview',error);
        this.ws.ws.close(4002,'Invalid compact preview');
      });
    };

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
      this.previewFrameHasLayers = true;
      this.resolveBinaryTiles(msg.layerUpdate);
      this.sessionState.nextLayerUpdates.push(msg.layerUpdate);
      // Create any sessions for event target clicks, because they could start sending data right away.
      msg.layerUpdate.targets && msg.layerUpdate.targets.forEach(x=> {
        x.sessionId && this.onNewSession(x.sessionId, this)
      });
      // Paint initial and tile-only updates progressively. Once a layout is
      // visible, keep structural replacements together through frameDone:
      // deleting old layers before their replacements arrive exposes white
      // holes, even while the origin document is still loading (BBC News).
      const update = msg.layerUpdate;
      const structural = u => u.layerInfo || u.layerDeleted || u.zIndex !== undefined;
      const pendingStructure = this.sessionState.nextProptrees ||
        this.sessionState.nextLayerUpdates.some(structural);
      if (this.domElement_ && update.bufferUpdates && !structural(update) &&
          (!this.sessionState.comittedProptrees || !pendingStructure))
        this.commitPendingUpdates();
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
      if(params.briskFrame)this.ws.req('PageStream.clientReady',{frame:params.briskFrame,generation:params.briskGeneration,interactive:!!this.previewFrameHasLayers});
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
      if (this.previewFrameHasLayers) this.clearPreviewAfterPaint = true;
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

  // Turns every `binaryImageId` reference in a just-arrived layerUpdate into a
  // plain, reusable `image` Blob URL, immediately, in WebSocket receive order.
  //
  // A binary tile is a ONE-SHOT ticket: SocketHandler.js sends the tile's
  // bytes as a single binary WebSocket frame directly before the JSON
  // metadata naming it, and devToolsWebsocket.takeBinaryImage() deletes the
  // entry on the first read, so the id can only ever be redeemed once.
  //
  // This used to be redeemed lazily, in updateScreen(), which is far too late.
  // A layerUpdate sits in sessionState.nextLayerUpdates until the next
  // frameDone commits it, and in that window this session hands `this` to
  // onNewSession() for every click target the same update carries -- and the
  // Session constructor deep-clones the base session's whole sessionState,
  // pending tile updates included. Each speculative session therefore
  // inherited a copy of the same not-yet-redeemed ticket. Whichever session
  // painted first redeemed it; every other one got undefined and logged
  // "binary tile N was not received before its metadata" -- a badly misleading
  // message, because the bytes had in fact arrived perfectly on time and in
  // the right order. The affected tile was then simply dropped, leaving a
  // hole in that session's page, and (because the bytes never reached
  // tileStore under their content id) any later cross-session dedup reference
  // to the same tile missed too: "tileId ... referenced but not in local
  // tileStore".
  //
  // Redeeming here, exactly once, at the only point where "before its
  // metadata" is a meaningful claim, makes the clone inherit real image bytes
  // instead of a spent ticket, and restores the ordering guarantee the error
  // message was written to check. Note this must run before the
  // onNewSession() calls below it, not after.
  resolveBinaryTiles(layerUpdate) {
    var updates = layerUpdate && layerUpdate.bufferUpdates;
    if (!updates) return;
    updates.forEach(bufUpdate => {
      if (bufUpdate.binaryImageId !== undefined) {
        var src = this.ws.ws.takeBinaryImage(bufUpdate.binaryImageId);
        if (src === undefined) {
          // Now a genuine transport-ordering violation (or a tile whose binary
          // frame was addressed to a session that no longer exists), not the
          // self-inflicted double-redeem this function exists to remove.
          console.error('PageStream: binary tile', bufUpdate.binaryImageId,
                        'was not received before its metadata');
          delete bufUpdate.binaryImageId;
          return;
        }
        delete bufUpdate.binaryImageId;
        bufUpdate.image = src;
      }

      // Real bug, found live: cache on RECEIPT, not on paint.
      //
      // updateScreen() also populates tileStore, but only for tiles it
      // actually paints -- and that is strictly later, and strictly fewer
      // tiles, than the set the server believes we hold. SocketHandler.js's
      // dedupTileReferences() adds a tile to `forwardedTileIds` the instant
      // it puts the bytes on the wire, and that Set is shared across every
      // browser in the fork tree ("whichever fork's tile arrives first
      // wins"). So the server's contract is "I sent you these bytes once,
      // you have them forever".
      //
      // The client was breaking that contract for any tile received but
      // never painted, and speculative execution makes that the common case:
      // a fork rasters a tile, the server forwards the bytes to that fork's
      // session and marks the id forwarded, the fork then loses the click
      // race and is destroyed with its layerUpdates still sitting unpainted
      // in nextLayerUpdates. The bytes are gone. When the winning fork later
      // rasters the same furniture, the server strips the payload and sends
      // the bare tileId -- and the client logs "tileId ... referenced but
      // not in local tileStore (cache miss)" and drops the tile, leaving a
      // stale or blank region.
      //
      // Measured against production, misses scaled with fork count exactly
      // as that predicts: /home (1 session) 0 misses, example.com (2) 5,
      // wikipedia (5) 10, bbc.com (5) many -- and bbc.com rendered visibly
      // washed out because of the dropped tiles. Storing here, at the one
      // point every tile's bytes are known to have arrived, makes the
      // client's cache mirror `forwardedTileIds` exactly.
      //
      // Same Map, same content-addressed keys, so this is idempotent with
      // updateScreen()'s own store: re-storing an identical id is a no-op.
      if (bufUpdate.image && bufUpdate.tileId)
        tileStore.set(bufUpdate.tileId, bufUpdate.image);
    });
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
    if(this.compactPreview)this.compactPreview.attach(ele);
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
      const installDesktop = () => import('/desktopInput.js').then(({DesktopInput}) => {
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
      if (oldZIndex != t.zIndex)
        t.dom.style.zIndex = t.zIndex;

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

    if (this.sessionState.layer_tree.some(l => l && l.images && l.images.length)) {
      const warmPreview = document.getElementById('warm-preview');
      if (warmPreview) warmPreview.remove();
    }
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

  createDOMLayerImages(l) {
    l.images && l.images.forEach(i => {
      if (i.dom.activeInLayer != l) {
        // TODO:  i.dom is shared with other sessions - implement some kind of refcounting & duplication here.
        l.dom.appendChild(i.dom);
        i.dom.style.position = 'absolute';
        i.dom.style.top = i.clip.y + 'px';
        i.dom.style.left = i.clip.x + 'px';
        // CSS scales the tile without resizing (and clearing) a decoded canvas.
        i.dom.style.width = i.clip.width + 'px';
        i.dom.style.height = i.clip.height + 'px';
        i.dom.activeInLayer = l;
        i.holesChanged = true;
      }
      // Cut out whatever a newer tile has since taken over (updateScreen's
      // cull). Done here rather than at punch time for the same reason the
      // positioning above is: i.dom can be shared with a cloned speculative
      // session, and only the layer that currently owns it in the DOM may
      // write to it -- the other session re-applies its own holes if and
      // when it adopts the element (which flips activeInLayer above).
      if (i.holesChanged && i.dom.activeInLayer == l) {
        i.dom.style.clipPath = clipPathForTile(i);
        i.holesChanged = false;
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
    
    this.createDOMLayerImages(l);

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
      // Real bug, found live: this used to fire on sessionId alone --
      // SocketHandler.js sets that the instant a speculative fork exists,
      // well before its own pre-navigation (PageStream.clickNode) has
      // actually finished (measured live: 6+ seconds for a real
      // destination page). Activating instantly on a fork that hasn't
      // gone anywhere yet swapped the client straight to stale/blank
      // content instead of the promised instant page. `ready` is a
      // separate flag SocketHandler.js now sends only once that
      // navigation genuinely succeeds -- see its own comment.
      if (evt.currentTarget.metadata.sessionId && evt.currentTarget.metadata.ready) {
        // Means we have preloaded this click - we just need to transfer to that session.
        // The destination recorded on the clickable target is only a
        // prediction/readiness label and may be an intermediate redirect.
        // Every fork's Session independently tracks authoritative Chromium
        // Page.frameNavigated/navigatedWithinDocument events. Promote that
        // session as-is; sessionActivate publishes its currentURL, and any
        // later canonicalisation continues to update the active address bar.
        performance.mark('brisk:promotion-start');
        const interactive=!!evt.currentTarget.metadata.inputReady;
        this.onSessionActivate(evt.currentTarget.metadata.sessionId);
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
        backendNodeId: evt.currentTarget.metadata.backendNodeId,
        linkText: evt.currentTarget.dataset.linkText || undefined,
      });
      this.ws.req('PageStream.clickNode', { backendNodeId: evt.currentTarget.metadata.backendNodeId } );
      evt.preventDefault();
    } else {
      delete evt.currentTarget.metadata.touchStarted;
      evt.currentTarget.releasePointerCapture(evt.pointerId) 
    }
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
    t.dom.replaceChildren();
    const automationText = (t.linkText || '').replace(/\s+/g, ' ').trim();
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
      if (this.options.showLinkOverlay) {
        region.classList.add('link');
        region.classList.toggle('alive', !!t.sessionId);
      }
      region.classList.toggle('preloaded', !!(t.sessionId && t.ready));
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

    var scrollDom = s.scrollAncestor && s.scrollAncestor.transform_id && s.scrollAncestor.transform_id.dom;
    var scrollX = scrollDom ? scrollDom.scrollLeft : 0;
    var scrollY = scrollDom ? scrollDom.scrollTop : 0;

    var c = s.constraintBoxRect || [0, 0, 0, 0];
    var clipX = c[0] + scrollX, clipY = c[1] + scrollY, clipW = c[2], clipH = c[3];

    var ancestorStickyBox = {x: 0, y: 0};
    if (s.nearestNodeShiftingStickyBox) {
      this.stickyOffsetPx(s.nearestNodeShiftingStickyBox);
      ancestorStickyBox = s.nearestNodeShiftingStickyBox.sticky.totalStickyBoxOffset || ancestorStickyBox;
    }
    var ancestorContainingBlock = {x: 0, y: 0};
    if (s.nearestNodeShiftingContainingBlock) {
      this.stickyOffsetPx(s.nearestNodeShiftingContainingBlock);
      ancestorContainingBlock = s.nearestNodeShiftingContainingBlock.sticky.totalContainingBlockOffset || ancestorContainingBlock;
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

    return {x: Math.round(offX), y: Math.round(offY)};
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
      if (node.sticky.scrollAncestor && node.sticky.scrollAncestor.transform_id === scrolledTransformNode && node.dom) {
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

      if (params.bufferUpdates) {
        l.images = l.images || [];

        params.bufferUpdates.forEach(bufUpdate => {
          var domImage;
          // No binaryImageId branch here: resolveBinaryTiles() has already
          // turned every one into a plain `image` Blob URL at receive time
          // (see its comment -- redeeming the one-shot id this late is what
          // made cloned speculative sessions fight over the same tile).
          if (bufUpdate.image) {
            domImage = tileElement(bufUpdate.image);
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
              var srcImg = tileElement(srcCachedSrc);
              var canvas = document.createElement('canvas');
              canvas.width = bufUpdate.clip.width;
              canvas.height = bufUpdate.clip.height;
              var ctx = canvas.getContext('2d');
              var tileIdForCache = bufUpdate.tileId;
              (srcImg.decode ? srcImg.decode() : Promise.resolve()).then(() => {
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
              domImage = tileElement(cachedSrc);
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

          // Real bug, found live: this cull-and-replace used to run
          // unconditionally, before domImage was even computed. On a cache
          // miss (the tileId/srcTileId branches above, when nothing was
          // actually resolved) domImage stays undefined -- but the old code
          // still culled whatever tile was previously covering this region
          // AND pushed a new {dom: undefined} entry in its place, directly
          // contradicting the cache-miss comments' own stated intent
          // ("leave the region showing whatever was previously drawn
          // there"). Worse, createDOMLayerImages() below unconditionally
          // dereferences every entry's `.dom.activeInLayer` -- hitting the
          // undefined entry threw a TypeError that aborted the *rest* of
          // that updateScreen() pass partway through, leaving other layers
          // stuck mid-update. That's what produced the garbled/overlapping
          // tile rendering seen live (screenshot against the real deployed
          // instance): a single cache-miss tile anywhere on the page could
          // corrupt the whole frame. Only cull+replace when there's an
          // actual replacement image; a cache miss now correctly leaves the
          // existing tile (and DOM) completely untouched.
          if (domImage) {
            // Real bug, found live (ghosting on briskbrowser.com's own "LIVE
            // SERVER STATS" panel: "92.9" and "93.9" legible on top of each
            // other, over a grey box that isn't in the page at all).
            //
            // Tiles are stacked as separate absolutely-positioned DOM
            // elements, which composites them source-over. That is only
            // equivalent to what the compositor does if each tile is opaque
            // -- and these aren't. A layer that isn't contents_opaque rasters
            // its translucent background into *every* tile: the stats cards
            // are `rgba(255,255,255,0.05)`, so every tile covering one is
            // alpha 13 everywhere except the glyphs. Stacking N of them
            // therefore lightens the region to 1-0.95^N (the grey box: N was
            // 12, so ~46% white) and leaves every older tile's opaque glyph
            // pixels showing through at 95% (the ghost digits).
            //
            // The old test only dropped a tile the new one *completely*
            // covered, which for this page is never:
            //   - the full-card tile (0,0,176,85) is far bigger than the
            //     text/bar damage rects that repaint inside it, so it keeps
            //     its baked-in copy of the digits from page load forever;
            //   - consecutive damage rects differ (the CPU bar's width walks
            //     129px..139px as the number moves), so each one only mostly
            //     covers the last and they pile up one per second.
            // Static content never shows this only because it is rastered
            // once and nothing ever overlaps it.
            //
            // Culling anything the new tile merely *touches* would be wrong
            // in the other direction -- it would take the rest of the
            // full-card tile down with it and punch a real hole in the page.
            // What's actually correct is to remove exactly the overlap:
            // subtract the new tile's rect from every tile beneath it, so
            // each pixel is painted by exactly one tile (the newest to cover
            // it), which is the compositor's own rule. That's safe because a
            // BufferUpdate is a complete re-raster of its clip rect, not a
            // diff -- see the tile region arithmetic at the top of this file.
            for (let i = l.images.length - 1; i >= 0; i--) {
              var overlap = rectIntersect(l.images[i].clip, bufUpdate.clip);
              if (!overlap) continue;
              // Whole tile gone: drop it. Partly gone: keep it, minus the part
              // the new tile now owns (punchTileHole reports back if that
              // leaves nothing).
              if (rectContains(bufUpdate.clip, l.images[i].clip) ||
                  punchTileHole(l.images[i], overlap)) {
                l.images[i].dom.activeInLayer == l && l.images[i].dom.remove();
                l.images.splice(i, 1);
              }
            }
            l.images.push({clip: bufUpdate.clip, dom: domImage, holes: []});
          }
        });
      }

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

    this.captureLocalScrolls();

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
        this.createDOMLayerImages(l);
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
    // frameDone only schedules this paint. Keep previews until the matching
    // interactive layers have actually been installed in the DOM.
    if (this.clearPreviewAfterPaint) {
      this.clearPreviewAfterPaint = false;
      this.bootstrapPreview = false;
      this.clearCompactPreview();
      performance.mark('brisk:interactive-committed');
      requestAnimationFrame(()=>requestAnimationFrame(()=>{
        performance.mark('brisk:interactive-presented');
        globalThis.dispatchEvent(new CustomEvent('brisk:interactive',{detail:{sessionId:this.ws.sessionId,frame:this.lastBriskFrame?.briskFrame}}));
      }));
      if (this.domElement_.classList.contains('active')) {
        document.getElementById('startup-preview')?.remove();
        globalThis.briskPreview = null;
      }
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

  clearCompactPreview(){++this.previewGeneration;if(this.compactPreview)this.compactPreview.clear();}

  destroy() {
    this.clearCompactPreview();
    this.ws.destroy();
    this.domElement = null;
  }
}
