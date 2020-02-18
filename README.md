# BriskBrowser

This repo contains the frontend to BriskBrowser.  The backend is located [here](https://github.com/BriskBrowser/chromium).

A hosted version is available [here](https://briskbrowser.omattos.com).

## Project Goals

Make a mobile web browser where every interaction is zero delay.   To achieve this, we render all content into images *serverside*, and send to the client all data necessary for all possible interactions.   All scroll, zoom, and click events should not require a server round-trip, so the user should never notice network latency.  All data necessary for any of those interactions is preloaded.

We aren't there yet - this project is currently a proof of concept, and isn't yet usable for daily browsing.

Major features implemented:

 * Correctly rendering most webpages
 * Scrolling on the client
 * Android support

Major features missing:

 * Clicking/Prerendering pages
 * Keyboard input
 * Video playback
 * Zooming
 * iOS support (due to no WebP)

## Contributing

Get involved [here](docs/contributing.md)!

