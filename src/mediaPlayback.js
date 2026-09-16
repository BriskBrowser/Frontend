// A timed media path independent of tile decode/reference state.
export class MediaClock {
  constructor() {
    this.reset();
  }
  reset() {
    this.pts = null;
    this.start = 0;
    this.end = 0;
  }
  anchor(pts, now, delay) {
    this.pts = pts;
    this.start = now + delay;
    this.end = this.start;
  }
  time(pts) {
    return this.start + (pts - this.pts) / 1e6;
  }
  position(now) {
    return this.pts === null ? null : this.pts + (now - this.start) * 1e6;
  }
}
export class MediaPlayback {
  constructor(control, root) {
    this.control = control;
    control.mediaPlayback = this;
    this.root = root;
    this.clock = new MediaClock();
    this.frames = [];
    this.sources = new Set();
    this.target = 0.2;
    this.jitterFloor = 0.2;
    this.activation = 0;
    this.stats = {
      videoFrames: 0,
      audioFrames: 0,
      audibleFrames: 0,
      rebuffer: 0,
      dropped: 0,
      errors: [],
      received: 0
    };
    this.canvas = document.createElement('canvas');
    this.canvas.dataset.briskMedia = '';
    this.canvas.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;pointer-events:auto;touch-action:none;z-index:2147483645;display:none';
    root.appendChild(this.canvas);
    this.sound = document.createElement('button');
    this.sound.textContent = 'Enable sound';
    this.sound.style.cssText =
      'position:absolute;right:12px;top:12px;z-index:2147483646;padding:10px;display:none';
    root.appendChild(this.sound);
    this.unlock = () => {
      if (this.context?.state === 'suspended')
        this.context
          .resume()
          .then(() => {
            this.sound.style.display = 'none';
            this.clearPlayback();
          })
          .catch(() => {});
    };
    this.installInput();
    this.sound.addEventListener('click', this.unlock);
    root.addEventListener('pointerdown', this.unlock, { passive: true });
    root.addEventListener('keydown', this.unlock);
    control.addEventListener('close', () => this.close());
    this.visibility = () => {
      if (document.hidden) {
        this.disconnect();
        control.req(this.session, 'PageStream.mediaStop', {}).catch(() => {});
      } else if (this.session) this.activate(this.session);
    };
    document.addEventListener('visibilitychange', this.visibility);
    this.tick = this.tick.bind(this);
    this.raf = requestAnimationFrame(this.tick);
  }
  installInput() {
    const canvas = this.canvas;
    canvas.tabIndex = 0;
    this.touches = new Map();
    const send = (method, params) => {
      if (this.session) this.control.req(this.session, method, params).catch(() => {});
    };
    const modifiers = (e) =>
      (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
    const point = (e) => {
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
      canvas.addEventListener(type, (e) => {
        e.preventDefault();
        e.stopPropagation();
        const down = type === 'pointerdown',
          move = type === 'pointermove';
        if (down) {
          this.unlock();
          canvas.focus({ preventScroll: true });
          canvas.setPointerCapture(e.pointerId);
        }
        if (e.pointerType === 'touch') {
          if (!down && !this.touches.has(e.pointerId)) return;
          if (down || move) this.touches.set(e.pointerId, { ...point(e), id: e.pointerId });
          else this.touches.delete(e.pointerId);
          if (type === 'pointercancel') this.touches.clear();
          send('Input.dispatchTouchEvent', {
            type: down
              ? 'touchStart'
              : move
                ? 'touchMove'
                : type === 'pointerup'
                  ? 'touchEnd'
                  : 'touchCancel',
            touchPoints: [...this.touches.values()],
            modifiers: modifiers(e)
          });
        } else {
          send('Input.dispatchMouseEvent', {
            type: down ? 'mousePressed' : move ? 'mouseMoved' : 'mouseReleased',
            ...point(e),
            button: ['left', 'middle', 'right'][e.button] || 'none',
            buttons: e.buttons,
            clickCount: move ? 0 : 1,
            modifiers: modifiers(e)
          });
        }
      });
    }
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? canvas.clientHeight : 1;
        send('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          ...point(e),
          deltaX: e.deltaX * unit,
          deltaY: e.deltaY * unit,
          modifiers: modifiers(e)
        });
      },
      { passive: false }
    );
    for (const type of ['keydown', 'keyup']) {
      canvas.addEventListener(type, (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.unlock();
        send('Input.dispatchKeyEvent', {
          type: type === 'keydown' ? 'keyDown' : 'keyUp',
          key: e.key,
          code: e.code,
          windowsVirtualKeyCode: e.keyCode,
          modifiers: modifiers(e),
          text: type === 'keydown' && e.key.length === 1 && !e.ctrlKey && !e.metaKey ? e.key : ''
        });
      });
    }
  }
  async activate(session) {
    const activation = ++this.activation;
    this.session = session;
    this.disconnect();
    if (document.hidden || typeof AudioDecoder !== 'function' || typeof VideoDecoder !== 'function')
      return;
    try {
      if (localStorage.getItem('briskMedia') === '0') return;
      const [audio, video] = await Promise.all([
        AudioDecoder.isConfigSupported({
          codec: 'opus',
          sampleRate: 48000,
          numberOfChannels: 2
        }),
        VideoDecoder.isConfigSupported({ codec: 'avc1.42C01F' })
      ]);
      if (!audio.supported || !video.supported || activation !== this.activation) return;
      if (!this.context)
        this.context = new AudioContext({
          sampleRate: 48000,
          latencyHint: 'playback'
        });
      const result = await this.control.req(session, 'PageStream.mediaStart', {});
      if (activation !== this.activation) return;
      const url = new URL(this.control.url);
      url.pathname = '/devtools/media';
      url.search = new URLSearchParams({ token: result.token }).toString();
      const ws = (this.ws = new WebSocket(url));
      ws.binaryType = 'arraybuffer';
      this.stats.received = 0;
      ws.onmessage = (e) => {
        if (this.ws !== ws) return;
        try {
          this.receive(e.data);
        } catch (error) {
          this.fail(error);
        }
      };
      ws.onerror = () => {};
      ws.onclose = () => {
        if (this.ws === ws) {
          this.ws = null;
          this.reset();
        }
      };
      this.feedback = setInterval(() => {
        if (ws.readyState === 1)
          ws.send(
            JSON.stringify({
              type: 'feedback',
              received: this.stats.received,
              buffered: Math.max(0, (this.clock.end - this.context.currentTime) * 1000),
              decode: (this.video?.decodeQueueSize || 0) + (this.audio?.decodeQueueSize || 0)
            })
          );
      }, 250);
    } catch (error) {
      if (activation === this.activation) this.fail(error);
    }
  }
  growBuffer() {
    this.stats.rebuffer++;
    this.jitterFloor = Math.min(0.6, this.jitterFloor + 0.1);
    this.target = Math.max(this.target, this.jitterFloor);
  }
  clearPlayback(keepVideo = false) {
    for (const source of this.sources) {
      try {
        source.stop();
      } catch (_) {}
      source.disconnect();
    }
    this.sources.clear();
    if (!keepVideo) {
      for (const frame of this.frames) frame.close();
      this.frames = [];
      this.silentAnchor = null;
    }
    this.clock.reset();
  }
  reset() {
    if (this.touches.size && this.session) {
      this.control
        .req(this.session, 'Input.dispatchTouchEvent', {
          type: 'touchCancel',
          touchPoints: []
        })
        .catch(() => {});
    }
    this.touches.clear();
    this.clearPlayback();
    this.canvas.style.display = 'none';
    this.sound.style.display = 'none';
    if (this.audio && this.audio.state !== 'closed') this.audio.close();
    if (this.video && this.video.state !== 'closed') this.video.close();
    this.audio = null;
    this.video = null;
    this.lastAudio = null;
    this.videoSizes = new Map();
  }
  disconnect() {
    clearInterval(this.feedback);
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.close();
    }
    this.reset();
  }
  receive(data) {
    if (typeof data === 'string') {
      const p = JSON.parse(data);
      if (p.type === 'ping') {
        this.ws.send(JSON.stringify({ type: 'pong', id: p.id }));
        return;
      }
      if (p.type === 'reset') {
        if (!Number.isInteger(p.generation) || p.generation < 0)
          throw Error('Invalid media generation');
        this.reset();
        this.generation = p.generation;
        return;
      }
      if (p.type === 'buffer' && Number.isFinite(p.milliseconds)) {
        this.target = Math.max(this.jitterFloor, Math.min(0.6, p.milliseconds / 1000));
        return;
      }
      if (p.type === 'error') {
        this.fail(Error(p.message));
        return;
      }
      return;
    }
    this.stats.received += data.byteLength;
    if (data.byteLength < 32 || data.byteLength > 4 * 1024 * 1024)
      throw Error('Media packet bounds');
    const view = new DataView(data),
      bytes = new Uint8Array(data);
    if (view.getUint32(0) !== 0x424d4544 || view.getUint32(24, true) !== bytes.length - 32)
      throw Error('Media packet header');
    if (view.getUint32(8, true) !== this.generation) return;
    const kind = bytes[4],
      pts = view.getFloat64(16, true),
      payload = bytes.subarray(32);
    if (!Number.isFinite(pts) || pts < 0) throw Error('Media timestamp');
    if (kind === 2) {
      if (view.getUint32(28, true) !== 20000 || payload.length > 4000)
        throw Error('Audio packet bounds');
      if (!this.audio) {
        const generation = this.generation;
        this.audio = new AudioDecoder({
          output: (data) => {
            if (generation === this.generation) this.audioOutput(data);
            else data.close();
          },
          error: (e) => {
            if (generation === this.generation) this.fail(e);
          }
        });
        this.audio.configure({
          codec: 'opus',
          sampleRate: 48000,
          numberOfChannels: 2
        });
      }
      if (this.audio.decodeQueueSize > 8) {
        this.audio.reset();
        this.audio.configure({
          codec: 'opus',
          sampleRate: 48000,
          numberOfChannels: 2
        });
        this.clearPlayback(true);
        this.growBuffer();
      }
      if (this.lastAudio !== null && pts <= this.lastAudio) return;
      this.lastAudio = pts;
      this.audio.decode(
        new EncodedAudioChunk({
          type: 'key',
          timestamp: pts,
          duration: 20000,
          data: payload
        })
      );
      return;
    }
    if (kind !== 1 || bytes[5] > 1) throw Error('Media packet kind');
    const w = view.getUint16(6, true),
      h = view.getUint16(12, true),
      key = bytes[5] === 1;
    if (!w || !h || w > 1920 || h > 1920) throw Error('Video dimensions');
    if (key) {
      let codec;
      for (let i = 0; i + 7 < payload.length; i++)
        if (
          payload[i] === 0 &&
          payload[i + 1] === 0 &&
          payload[i + 2] === 1 &&
          (payload[i + 3] & 31) === 7
        ) {
          codec =
            'avc1.' +
            Array.from(payload.slice(i + 4, i + 7), (b) => b.toString(16).padStart(2, '0')).join(
              ''
            );
          break;
        }
      if (!codec) throw Error('Video key frame missing SPS');
      if (this.video && this.video.state !== 'closed') this.video.close();
      const generation = this.generation;
      this.video = new VideoDecoder({
        output: (frame) => {
          if (generation !== this.generation) {
            frame.close();
            return;
          }
          if (this.frames.length >= 30) {
            this.frames.shift().close();
            this.stats.dropped++;
          }
          this.frames.push(frame);
        },
        error: (e) => {
          if (generation === this.generation) this.fail(e);
        }
      });
      this.video.configure({
        codec,
        optimizeForLatency: true,
        hardwareAcceleration: 'no-preference'
      });
    }
    if (!this.video) return;
    if (this.video.decodeQueueSize > 8) {
      this.video.close();
      this.video = null;
      this.ws.send(JSON.stringify({ type: 'keyframe', generation: this.generation }));
      this.stats.dropped++;
      return;
    }
    this.videoSizes.set(Math.trunc(pts), { w, h });
    if (this.videoSizes.size > 64) this.videoSizes.delete(this.videoSizes.keys().next().value);
    if (!this.silentAnchor)
      this.silentAnchor = { pts, now: performance.now() + this.target * 1000 };
    this.video.decode(
      new EncodedVideoChunk({
        type: key ? 'key' : 'delta',
        timestamp: pts,
        data: payload
      })
    );
  }
  audioOutput(data) {
    try {
      const ctx = this.context,
        pts = data.timestamp;
      if (data.sampleRate !== 48000 || data.numberOfChannels !== 2 || data.numberOfFrames > 1920)
        throw Error('Decoded audio format');
      const buffer = ctx.createBuffer(2, data.numberOfFrames, 48000);
      let audible = false;
      for (let c = 0; c < 2; c++) {
        const samples = buffer.getChannelData(c);
        data.copyTo(samples, { planeIndex: c, format: 'f32-planar' });
        if (!audible) audible = samples.some((x) => Math.abs(x) > 0.002);
      }
      if (audible) this.stats.audibleFrames++;
      if (ctx.state !== 'running') {
        if (audible) this.sound.style.display = '';
        return;
      }
      const now = ctx.currentTime;
      if (this.clock.pts === null) this.clock.anchor(pts, now, this.target);
      let start = this.clock.time(pts);
      if (start < now + 0.01 || start > now + 0.8) {
        this.growBuffer();
        this.clearPlayback(true);
        this.clock.anchor(pts, now, this.target);
        start = this.clock.time(pts);
      }
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      this.sources.add(source);
      source.onended = () => {
        this.sources.delete(source);
        source.disconnect();
      };
      source.start(start);
      this.clock.end = start + buffer.duration;
      this.stats.audioFrames++;
      this.stats.audioPTS = pts;
    } catch (error) {
      this.fail(error);
    } finally {
      data.close();
    }
  }
  audiblePosition() {
    if (this.context?.state === 'running' && this.clock.pts !== null) {
      const stamp = this.context.getOutputTimestamp?.();
      const time =
        stamp && stamp.contextTime > 0
          ? stamp.contextTime + (performance.now() - stamp.performanceTime) / 1000
          : this.context.currentTime -
            (this.context.outputLatency || this.context.baseLatency || 0);
      return this.clock.position(time);
    }
    return this.silentAnchor
      ? this.silentAnchor.pts + (performance.now() - this.silentAnchor.now) * 1000
      : null;
  }
  tick() {
    const pts = this.audiblePosition();
    let chosen;
    while (this.frames.length && pts !== null && this.frames[0].timestamp <= pts) {
      if (chosen) {
        chosen.close();
        this.stats.dropped++;
      }
      chosen = this.frames.shift();
    }
    if (chosen) {
      try {
        const size = this.videoSizes.get(chosen.timestamp) || {
          w: chosen.displayWidth,
          h: chosen.displayHeight
        };
        if (this.canvas.width !== size.w) this.canvas.width = size.w;
        if (this.canvas.height !== size.h) this.canvas.height = size.h;
        this.canvas.getContext('2d', { alpha: false }).drawImage(chosen, 0, 0);
        this.canvas.style.display = '';
        this.stats.videoFrames++;
        this.stats.videoPTS = chosen.timestamp;
        this.stats.skewMs = (chosen.timestamp - pts) / 1000;
      } finally {
        chosen.close();
      }
    }
    this.raf = requestAnimationFrame(this.tick);
  }
  fail(error) {
    this.stats.errors.push(error.message);
    console.warn('Media playback:', error.message);
    this.disconnect();
  }
  close() {
    this.activation++;
    this.disconnect();
    cancelAnimationFrame(this.raf);
    document.removeEventListener('visibilitychange', this.visibility);
    this.root.removeEventListener('pointerdown', this.unlock);
    this.root.removeEventListener('keydown', this.unlock);
    this.context?.close();
    this.canvas.remove();
    this.sound.remove();
  }
}
