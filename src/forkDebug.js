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
      #toggle{position:absolute;bottom:12px;right:12px;pointer-events:auto}
      section{position:absolute;right:12px;top:12px;bottom:56px;width:min(720px,calc(100vw - 24px));background:#111923f5;border:1px solid #526580;border-radius:10px;pointer-events:auto;display:flex;flex-direction:column;box-shadow:0 8px 35px #0008}
      [hidden]{display:none!important} header{padding:12px;border-bottom:1px solid #526580;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
      h2{font-size:16px;margin:0;flex:1} #status{padding:8px 12px;color:#a9bdd3}
      #cards{overflow:auto;padding:12px;display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px;align-content:start}
      article{border:1px solid #526580;border-radius:7px;padding:10px;min-width:0} article.current{border-color:#66d9a5}
      h3{margin:0 0 6px;font-size:14px} p{margin:5px 0;overflow-wrap:anywhere} .meta{color:#a9bdd3;font-size:12px}
      img{width:100%;height:180px;object-fit:contain;background:#070b10;border-radius:4px} summary{padding:6px 0}
      ul{padding-left:16px;max-height:240px;overflow:auto} li{margin:6px 0;overflow-wrap:anywhere}
    </style>
    <button id="toggle" aria-expanded="false" title="Toggle fork debug (Alt+Shift+D)">Fork debug</button>
    <section hidden aria-label="Fork debug overlay"><header><h2>All forks</h2><button id="refresh">Refresh</button><label><input id="auto" type="checkbox" checked> Live (5s)</label><button id="close" aria-label="Close debug overlay">Close</button></header>
    <div id="status" role="status"></div><div id="cards"></div></section>`;
    document.body.append(this.host);
    this.root = root;
    root.querySelector('#toggle').onclick = () => this.toggle();
    root.querySelector('#close').onclick = () => this.toggle(false);
    root.querySelector('#refresh').onclick = () => this.refresh();
    root.querySelector('#auto').onchange = () => this.schedule();
    window.addEventListener('keydown', event => {
      if (event.altKey && event.shiftKey && event.code === 'KeyD') {
        event.preventDefault(); event.stopImmediatePropagation(); this.toggle();
      } else if (event.key === 'Escape' && this.open && event.composedPath().includes(this.host)) {
        event.preventDefault(); this.toggle(false);
      }
    }, true);
    browser.socket.addEventListener('close', () => {
      clearTimeout(this.timer);
      this.status('Disconnected — displayed snapshots are no longer updating.');
    });
    if (browser.options.debugMode) this.toggle(true);
  }
  status(text) {this.root.querySelector('#status').textContent = text;}
  toggle(open = !this.open) {
    this.open = open;
    this.root.querySelector('section').hidden = !open;
    this.root.querySelector('#toggle').setAttribute('aria-expanded', String(open));
    clearTimeout(this.timer);
    if (open) this.refresh();
    else this.root.querySelector('#toggle').focus();
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
      this.status(`${forks.length} forks · ${new Date(time).toLocaleTimeString()} · Rendered server snapshots; refreshed sequentially.`);
      const ids = new Set(forks.map(fork => fork.id));
      for (const [id, card] of this.cards) if (!ids.has(id)) {card.remove(); this.cards.delete(id);}
      for (const fork of forks) this.render(fork);
      for (const fork of forks) {
        if (!this.open || this.browser.socket.readyState !== 1) break;
        const card = this.cards.get(fork.id);
        if (!fork.screenshotAvailable) {
          card.querySelector('img').hidden = true;
          card.querySelector('.shot').textContent = 'Preview unavailable: ' + fork.state;
          continue;
        }
        try {
          const shot = await this.browser.socket.req(undefined, 'PageStream.debugImage', {forkId:fork.id});
          if (!this.open) break;
          card.querySelector('img').src = shot.image;
          card.querySelector('img').hidden = false;
          card.querySelector('.shot').textContent = 'Snapshot ' + new Date(shot.time).toLocaleTimeString();
        } catch (error) {
          card.querySelector('img').hidden = true;
          card.querySelector('.shot').textContent = 'Preview unavailable: ' + (error.message || error);
        }
      }
    } catch (error) {this.status('Debug refresh failed: ' + (error.message || error));}
    finally {this.busy = false; this.root.querySelector('#refresh').disabled = false; this.schedule();}
  }
  render(fork) {
    let card = this.cards.get(fork.id);
    if (!card) {
      card = document.createElement('article');
      card.innerHTML = '<h3></h3><p class="url"></p><p class="meta"></p><img hidden><p class="shot meta">Waiting for snapshot…</p><details><summary></summary><ul></ul></details>';
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
    card.querySelector('img').alt = 'Currently rendered page for fork ' + fork.id;
    card.querySelector('summary').textContent = `Link targets (${fork.targets.length})`;
    const list = card.querySelector('ul');
    list.replaceChildren(...fork.targets.map(target => {
      const li = document.createElement('li');
      li.textContent = `${target.url || '(non-link target)'} · node ${target.nodeId} · ${target.forkId ? 'fork ' + target.forkId : 'no fork'} · ${target.inputReady ? 'interactive' : target.ready ? 'preview ready' : 'not ready'}${Number.isFinite(target.probability) ? ' · probability ' + target.probability.toFixed(3) : ''}`;
      return li;
    }));
  }
}
