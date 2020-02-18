# FastBrowser

This repo contains the frontend to FastBrowser.  The backend is located [here](https://github.com/FastBrowser/chromium).

A hosted version is available [here](https://briskbrowser.omattos.com).

## Project Goals

Make a web browser where every interaction is zero delay.   To achieve this, we render all content into images *serverside*, and send to the client all data necessary for all possible interactions.   All scroll, zoom, and click events should not require a server round-trip, so the user should never notice network latency.  All data necessary for any of those interactions is preloaded.

We aren't there yet - this project is currently a proof of concept, and isn't yet usable for daily browsing.

## Contributing

Get involved [here](docs/contributing.md)!

