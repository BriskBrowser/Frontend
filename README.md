# FastBrowser

This repo contains the frontend to FastBrowser.  The backend is located [here](https://github.com/FastBrowser/chromium).

A hosted version is available (here)[https://fastbrowser.omattos.com].

## Project Goals

Make a web browser where every interaction is zero delay.   To achieve this, we render all content into images *serverside*, and send to the client all data necessary for all possible interactions.   All scroll, zoom, and click events should not require a server round-trip, so the user should never notice network latency.  All data necessary for any of those interactions is preloaded.

## Contributing

Since hosting this project is non-trivial, many users are expected to use the hosted version.   That is paid for by donations and ads.  Project contributions get paid as detailed [here](docs/rewards.md).

