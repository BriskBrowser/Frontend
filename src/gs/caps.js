// What this browser can decode, advertised in PageStream.enable as `gpuStream`.
// The service picks photo codecs from this list; flat and text are versioned.
export const PHOTO_RAW = 3;    // uncompressed RGB(A): always decodable
export const PHOTO_AV1 = 2;    // AV1 4:4:4 via WebCodecs

// codec id -> async (env) => boolean. More photo codecs are one entry each.
export const PHOTO_PROBES = {
  [PHOTO_AV1]: async env => {
    if (typeof env.VideoDecoder?.isConfigSupported !== 'function') return false;
    // High profile (4:4:4), level 5.1, 8 bit, no monochrome, 4:4:4 subsampling.
    const result = await env.VideoDecoder.isConfigSupported({codec: 'av01.1.13M.08.0.000', codedWidth: 1024, codedHeight: 1024});
    return !!result?.supported;
  },
  [PHOTO_RAW]: async () => true,
};

async function probeWebGpu(env) {
  const gpu = env.navigator?.gpu;
  if (!gpu?.requestAdapter) return {webgpu: false, maxTexture: 0};
  try {
    // A browser that never answers must not hold up PageStream.enable.
    const adapter = await Promise.race([gpu.requestAdapter(), new Promise(resolve => setTimeout(() => resolve(null), 1000))]);
    if (!adapter) return {webgpu: false, maxTexture: 0};
    return {webgpu: true, maxTexture: adapter.limits?.maxTextureDimension2D || 8192};
  } catch (_) { return {webgpu: false, maxTexture: 0}; }
}

// env is injectable for tests: {VideoDecoder, navigator, Worker, createImageBitmap}.
export async function probeCaps(env = globalThis) {
  const photo = [];
  for (const [id, probe] of Object.entries(PHOTO_PROBES)) {
    try { if (await probe(env)) photo.push(Number(id)); } catch (_) { /* unsupported */ }
  }
  if (!photo.includes(PHOTO_RAW)) photo.push(PHOTO_RAW);
  const gpu = await probeWebGpu(env);
  return {
    flat: [1], text: [1], photo: photo.sort((a, b) => a - b),
    webgpu: gpu.webgpu, worker: typeof env.Worker === 'function',
    // Largest image dimension we can place on a canvas/texture.
    maxTexture: gpu.webgpu ? gpu.maxTexture : 4096,
  };
}
