# BriskBrowser frontend

The frontend is a thin mobile browser client. A remote patched Chromium sends
PageStream compositor layers, property trees, click targets, and interaction
state, and a GPU stream service sends the layers' pixels and text as binary
packets (`src/gs/`, `docs/gpu-stream-wire.md` in the root repository); the frontend reconstructs that state in ordinary HTML/CSS
and applies latency-sensitive gestures locally.

The project remains experimental rather than a daily-use browser.

## Implemented

- reconstruction of most ordinary web layouts;
- local touch scrolling and pinch-zoom prediction;
- link hit targets and instant activation of ready preloaded branches;
- keyboard/form state forwarding;
- browser back/forward history integration;
- per-layer surfaces decoded from stream packets (flat, photo and text codecs) and composited on canvases;
- optimistic preview/truth session activation and status;
- interaction trace recording for real-device reproduction;
- Android/mobile Chrome support.

## Important limitations

- default aggressive caching can briefly render another user's cached response;
- video and general GPU-resource transport are incomplete;
- a first-ever uncached URL still pays its real origin RTT (learned responses
  and linked destinations use the shared cache/preload paths);
- iOS support remains constrained by codec and interaction differences.

See the root repository's `BUGS.md`, `docs/optimistic-cache.md`, and
`docs/gpu-stream-service.md` for current behavior (the old tile transport,
`docs/tile-transport.md`, is superseded). Contributor setup is in
`docs/contributing.md`.
