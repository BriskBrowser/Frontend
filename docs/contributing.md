# Contributing

Our goal is to save millions of hours of human time by loading webpages faster.  You can help!

## Spreading the word.

Get news of Brisk Browser out there to friends and family - particularly to those who you think might be able to contribute!

## Donations

If you can contribute financially, we will use it to add to the reward fund to encourage other people to help us achieve our goal of saving millions of human hours quicer.  Contact Project maintainer @Hello1024.

## Writing Code

If you can write C++ or Javascript, your expertise will help!  We even offer [rewards](rewards.md) for good contributions!

### Frontend

The [Frontend](../src/index.html) runs in a regular browser, and it's job is to display any pre-rendered webpage.  It receives data from the backend about what to render where, and how interactions like scrolling should be done.  The cardinal rule is any action from the user, like taps, swipes, or pinches should not wait for a network round trip - the backend (server) will send enough information to allow all those to happen entirely locally.

The frontend is optionally compiled to a single html file for deployment, or you can just copy the whole "src" directory straight to a webserver.  It's far from perfect - there are lots of useful things one could add - perhaps start with a list of [beginner issues](https://github.com/BriskBrowser/Frontend/labels/good%20first%20issue).


### Backend

The [Backend](https://github.com/BriskBrowser/chromium) is based on Chromium, and it does everything necessary to be able to give the frontend the information it needs to show an interactive page.   Keep patches here as uninvasive as possible - we want to keep our fork uptodate, so nearly all of our code is in [just one file](https://github.com/BriskBrowser/chromium/blob/22ccfd0dec348ce615a1d0e27aa147d811bdc89c/third_party/blink/renderer/core/inspector/inspector_page_stream_agent.cc).

