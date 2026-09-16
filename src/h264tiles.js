// Each tile is an independent Annex B IDR with SPS/PPS. Keep one decoder per
// socket and draw its output directly; never transcode decoded pixels to PNG.
export async function supportsH264Tiles() {
  if (typeof VideoDecoder !== 'function') return false;
  try {
    if (localStorage.getItem('briskH264') === '0') return false;
    return (await VideoDecoder.isConfigSupported({codec: 'avc1.42C01F', optimizeForLatency: true})).supported;
  } catch (_) { return false; }
}

export class H264TileDecoder {
  constructor() {
    this.decoder = new VideoDecoder({
      output: frame => {
        try {
          if (frame.displayWidth > 4096 || frame.displayHeight > 4096 ||
              frame.displayWidth * frame.displayHeight > 4 * 1024 * 1024) {
            this.error = Error('H264 tile exceeds dimension limit'); return;
          }
          const canvas = document.createElement('canvas');
          canvas.width = frame.displayWidth;
          canvas.height = frame.displayHeight;
          canvas.getContext('2d', {alpha: false}).drawImage(frame, 0, 0);
          canvas.sharable = true;
          this.output = canvas;
        } finally { frame.close(); }
      },
      error: error => { this.error = error; }
    });
    this.sequence = 0;
  }
  async decode(bytes) {
    if (bytes.length > 16 * 1024 * 1024) throw Error('H264 tile exceeds size limit');
    // The codec string must match this independently decodable tile's SPS.
    let codec;
    for (let i = 0; i + 6 < bytes.length; ++i) {
      if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1 && (bytes[i + 3] & 31) === 7) {
        codec = 'avc1.' + Array.from(bytes.slice(i + 4, i + 7), b => b.toString(16).padStart(2, '0')).join('');
        break;
      }
    }
    if (!codec) throw Error('H264 tile is missing its SPS');
    if (codec !== this.codec) {
      // Tiny independent frames pay more driver/IPC setup than decode work.
      // Server encoding remains hardware accelerated; avoid client GPU churn.
      this.decoder.configure({codec, optimizeForLatency: true, hardwareAcceleration: 'prefer-software'});
      this.codec = codec;
    }
    this.output = null;
    this.error = null;
    this.decoder.decode(new EncodedVideoChunk({type: 'key', timestamp: this.sequence++, data: bytes}));
    await this.decoder.flush();
    if (this.error) throw this.error;
    if (!this.output) throw Error('H264 tile produced no frame');
    return this.output;
  }
  close() { if (this.decoder.state !== 'closed') this.decoder.close(); }
}

// Decode image tiles before their metadata can replace retained pixels.
// A fresh <img> decodes asynchronously even after all of its bytes arrived;
// presenting its empty box first flashes white during structural updates.
export async function decodeImageTile(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    canvas.getContext('2d').drawImage(image, 0, 0);
    canvas.sharable = true;
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Each DOM placement needs its own canvas, including content-id cache hits.
// Sharing the cached canvas element would move it out of the previous layer.
export function tileElement(source) {
  if (source instanceof HTMLCanvasElement) {
    const canvas = document.createElement('canvas');
    canvas.width = source.width; canvas.height = source.height;
    canvas.getContext('2d').drawImage(source, 0, 0);
    canvas.sharable = true;
    return canvas;
  }
  const image = new Image();
  image.src = source;
  image.decode().catch(() => {});
  image.sharable = true;
  return image;
}

export function supportsVp9Tiles() {
  try {
    return localStorage.getItem('briskVP9') !== '0' &&
      !!document.createElement('video').canPlayType('video/webm; codecs="vp9"');
  } catch (_) { return false; }
}

// VP9 alpha is a second plane carried by WebM BlockAdditional. Use the browser's
// demuxer/alpha decoder rather than discarding that plane as a raw VP9 chunk.
export class Vp9TileDecoder {
  constructor() {this.video = document.createElement('video'); this.video.muted = true;}
  decode(bytes) {
    if (this.closed) return Promise.reject(Error('VP9 decoder closed'));
    if (bytes.length > 16 * 1024 * 1024) return Promise.reject(Error('VP9 tile exceeds size limit'));
    const video = this.video;
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(new Blob([bytes], {type:'video/webm'}));
      let finished=false, callback;
      const cleanup = () => {
        clearTimeout(timer); video.onloadeddata = video.onerror = null;
        if(callback!==undefined)video.cancelVideoFrameCallback(callback);
        video.pause(); video.removeAttribute('src'); video.load();
        URL.revokeObjectURL(url); this.cancel = null;
      };
      const fail = error => {if(finished)return;finished=true;cleanup();reject(error);};
      const timer = setTimeout(() => fail(Error('VP9 tile decode timed out')), 10000);
      this.cancel = () => fail(Error('VP9 decoder closed'));
      const render = () => {
        if(finished)return;
        try {
          const width=video.videoWidth,height=video.videoHeight;
          if(!width || !height || width>4096 || height>4096 || width*height>4*1024*1024)
            throw Error('VP9 tile exceeds dimension limit');
          const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
          canvas.getContext('2d',{willReadFrequently:true}).drawImage(video,0,0);canvas.sharable=true;
          finished=true;cleanup();resolve(canvas);
        } catch(error) {fail(error);}
      };
      video.onerror = () => fail(Error('VP9 tile decode failed'));
      // loadeddata alone can precede selection of the first alpha frame. Wait
      // for a presentable frame before drawing; otherwise the first tile clears.
      if(video.requestVideoFrameCallback)callback=video.requestVideoFrameCallback(render);
      video.onloadeddata = () => {
        if(callback===undefined)requestAnimationFrame(render);
        video.play().catch(error=>{if(!finished && error.name!=='AbortError')fail(error);});
      };
      video.preload='auto'; video.src=url;
    });
  }
  close() {this.closed=true;if(this.cancel)this.cancel();}
}
