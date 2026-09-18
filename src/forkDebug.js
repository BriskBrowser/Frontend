// Debug UI lives outside #browser so its controls never become remote input.
export class ForkDebug {
  constructor(browser) {
    this.browser = browser;
    this.cards = new Map();
    this.host = document.createElement('div');
    this.host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none';
    const root = this.host.attachShadow({mode:'open'});
    root.innerHTML = `<style>
      :host{font:13px/1.4 system-ui;color:#e6edf3;color-scheme:dark}
      *{box-sizing:border-box} button,input,summary{cursor:pointer}
      button{font:inherit;color:inherit;background:#25354b;border:1px solid #526580;border-radius:6px;padding:6px 10px}
      section{position:absolute;right:12px;top:12px;bottom:12px;width:min(720px,calc(100vw - 24px));background:#111923f5;border:1px solid #526580;border-radius:10px;pointer-events:auto;display:flex;flex-direction:column;box-shadow:0 8px 35px #0008}
      [hidden]{display:none!important} header{padding:12px;border-bottom:1px solid #526580;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
      h2{font-size:16px;margin:0;flex:1} #status{padding:8px 12px;color:#a9bdd3}
      #cards{overflow:auto;padding:12px;display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px;align-content:start}
      article{border:1px solid #526580;border-radius:7px;padding:10px;min-width:0} article.current{border-color:#66d9a5}
      h3{margin:0 0 6px;font-size:14px} p{margin:5px 0;overflow-wrap:anywhere} .meta{color:#a9bdd3;font-size:12px}
      .mini{width:100%;height:180px;overflow:hidden;position:relative;background:white;contain:strict;pointer-events:none} summary{padding:6px 0}
      ul{padding-left:16px;max-height:240px;overflow:auto} li{margin:6px 0;overflow-wrap:anywhere}
    </style>
    <section hidden aria-label="Fork debug overlay"><header><h2>All forks</h2><button id="refresh">Refresh</button><label><input id="auto" type="checkbox" checked> Live (5s)</label><button id="close" aria-label="Close debug overlay">Close</button></header>
    <div id="status" role="status"></div><div id="cards"></div></section>`;
    document.body.append(this.host);
    this.root = root;
    root.querySelector('#close').onclick = () => this.toggle(false);
    root.querySelector('#refresh').onclick = () => this.refresh();
    root.querySelector('#auto').onchange = () => this.schedule();
    window.addEventListener('keydown', event => {
      if (event.key === 'Escape' && this.open && event.composedPath().includes(this.host)) {
        event.preventDefault(); this.toggle(false);
      }
    }, true);
    browser.socket.addEventListener('close', () => {
      clearTimeout(this.timer);
      clearTimeout(this.paintTimer);
      this.status('Disconnected — displayed client state is no longer updating.');
    });
  }
  status(text) {this.root.querySelector('#status').textContent = text;}
  toggle(open = !this.open) {
    this.open = open;
    this.root.querySelector('section').hidden = !open;
    clearTimeout(this.timer);
    clearTimeout(this.paintTimer);
    if (open) {this.refresh(); this.paint();}
    else {
      for (const card of this.cards.values()) card.querySelector('.mini').replaceChildren();
      this.browser.rootElement.focus({preventScroll:true});
    }
  }
  schedule() {
    clearTimeout(this.timer);
    if (this.open && this.root.querySelector('#auto').checked && this.browser.socket.readyState === 1)
      this.timer = setTimeout(() => this.refresh(), 5000);
  }
  async refresh() {
    if (this.busy || !this.open || this.browser.socket.readyState !== 1) return;
    this.busy = true;
    clearTimeout(this.timer);
    this.root.querySelector('#refresh').disabled = true;
    try {
      const {forks, time} = await this.browser.socket.req(undefined, 'PageStream.debugState', {});
      if (!this.open) return;
      this.status(`${forks.length} forks · ${new Date(time).toLocaleTimeString()} · Client-rendered mini views; metadata refresh every 5s.`);
      const ids = new Set(forks.map(fork => fork.id));
      for (const [id, card] of this.cards) if (!ids.has(id)) {card.remove(); this.cards.delete(id);}
      for (const fork of forks) this.render(fork);
      this.paint();

    } catch (error) {this.status('Debug refresh failed: ' + (error.message || error));}
    finally {this.busy = false; this.root.querySelector('#refresh').disabled = false; this.schedule();}
  }
  paint() {
    clearTimeout(this.paintTimer);
    if (!this.open) return;
    for (const card of this.cards.values()) {
      const fork = card.fork;
      const session = fork.sessionIds.map(id => this.browser.sessions[id]).find(Boolean);
      const mount = card.querySelector('.mini');
      try {
        if (!session) {
          mount.replaceChildren();
          card.querySelector('.shot').textContent = 'Awaiting client state';
          continue;
        }
        renderMini(session, mount, this.browser.rootElement.getBoundingClientRect());
        card.querySelector('.shot').textContent = 'Live received client state';
      } catch (error) {
        mount.replaceChildren();
        card.querySelector('.shot').textContent = 'Cannot render client state: ' + error.message;
      }
    }
    this.paintTimer = setTimeout(() => this.paint(), 250);
  }
  render(fork) {
    let card = this.cards.get(fork.id);
    if (!card) {
      card = document.createElement('article');
      card.innerHTML = '<h3></h3><p class="url"></p><p class="meta"></p><div class="mini" inert></div><p class="shot meta"></p><details><summary></summary><ul></ul></details>';
      this.cards.set(fork.id, card);
      this.root.querySelector('#cards').append(card);
    }
    card.classList.toggle('current', fork.roles.includes('current'));
    card.querySelector('h3').textContent = `Fork ${fork.id} · ${fork.roles.join(', ')}`;
    card.querySelector('.url').textContent = fork.url || 'No loaded URL yet';
    const loaded = fork.sessionIds.map(id => {
      const session = this.browser.sessions[id];
      if (!session) return id + ': awaiting client state';
      const layers = Object.values(session.sessionState.layer_tree).filter(Boolean).length;
      return `${id}: ${layers} layers${String(this.browser.activeSession) === id ? ', displayed' : ''}`;
    });
    card.querySelector('.meta').textContent = `${fork.state} · parent ${fork.parentId || 'none'} · decoded frame ${fork.clientDecodedFrame} · client sessions ${loaded.join('; ') || 'pending'}`;
    card.fork = fork;
    card.querySelector('summary').textContent = `Link targets (${fork.targets.length})`;
    const list = card.querySelector('ul');
    list.replaceChildren(...fork.targets.map(target => {
      const li = document.createElement('li');
      li.textContent = `${target.url || '(non-link target)'} · node ${target.nodeId} · ${target.forkId ? 'fork ' + target.forkId : 'no fork'} · ${target.inputReady ? 'interactive' : target.ready ? 'preview ready' : 'not ready'}${Number.isFinite(target.probability) ? ' · probability ' + target.probability.toFixed(3) : ''}`;
      return li;
    }));
  }
}

// Clone decoded pixels as well as metadata: Session's normal fork clone shares
// tile DOM, which would let a miniature steal tiles from the foreground view.
function copyPixels(element) {
  const copy = element.cloneNode(true);
  const originals = [element, ...element.querySelectorAll('canvas')];
  const copies = [copy, ...copy.querySelectorAll('canvas')];
  originals.forEach((source, index) => {
    if (source instanceof HTMLCanvasElement)
      copies[index].getContext('2d').drawImage(source, 0, 0);
  });
  return copy;
}
function copyState(value, seen = new WeakMap()) {
  if (!value || typeof value !== 'object') return value;
  if (value instanceof HTMLElement) return value.sharable ? copyPixels(value) : undefined;
  if (seen.has(value)) return seen.get(value);
  const result = Array.isArray(value) ? [] : {};
  seen.set(value, result);
  for (const key of Object.keys(value)) result[key] = copyState(value[key], seen);
  return result;
}

export function renderMini(session, mount, viewport) {
  const host = document.createElement('div');
  const shadow = host.attachShadow({mode:'open'});
  const style = document.createElement('style');
  // Reuse already loaded renderer CSS without fetching a second stylesheet.
  style.textContent = [...document.styleSheets].map(sheet => {
    try {return [...sheet.cssRules].map(rule => rule.cssText).join('\n');}
    catch (_) {return '';}
  }).join('\n');
  const root = document.createElement('div');
  const width = Math.max(1, viewport.width), height = Math.max(1, viewport.height);
  const scale = Math.min(mount.clientWidth / width, mount.clientHeight / height);
  root.style.cssText = `position:absolute;left:0;top:0;width:${width}px;height:${height}px;transform-origin:0 0;transform:scale(${scale});overflow:hidden;pointer-events:none`;
  shadow.append(style, root);
  mount.replaceChildren(host);

  // Use the exact same property-tree/layer renderer, with private tile DOM and
  // no Session constructor, input installation, stream subscription or resize.
  const renderer = Object.create(Object.getPrototypeOf(session));
  renderer.sessionState = copyState(session.sessionState);
  renderer.sessionState.comittedLayerUpdates = [];
  renderer.sessionState.nextLayerUpdates = [];
  renderer.domElement_ = root;
  renderer.fullUpdateRequired = true;
  renderer.options = {};
  renderer.targetStatuses = new Map();
  renderer.updateTargetHeights = () => {};
  renderer.createTargetNode = () => {};
  renderer.scrollHandler = () => {};
  renderer.applyServerScroll = node => {
    if (node?.dom && node.scroll_offset) {
      const live = session.sessionState.transform_tree?.[node.id]?.dom;
      node.dom.scrollTop = live ? live.scrollTop : Math.round(node.scroll_offset[1]);
      node.dom.scrollLeft = live ? live.scrollLeft : Math.round(node.scroll_offset[0]);
    }
  };
  renderer.updateScreen();
  if (session.compactPreview?.canvas) root.append(copyPixels(session.compactPreview.canvas));
}
