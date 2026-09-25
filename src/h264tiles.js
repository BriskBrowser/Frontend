// Startup-light tile helpers. The H264/VP9 tile decoders live in
// videoTiles.js, loaded on the first video packet (see devtoolswebsocket.js).
export async function supportsH264Tiles() {
  if (typeof VideoDecoder !== 'function') return false;
  try {
    if (localStorage.getItem('briskH264') === '0') return false;
    return (await VideoDecoder.isConfigSupported({codec: 'avc1.42C01F', optimizeForLatency: true})).supported;
  } catch (_) { return false; }
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
