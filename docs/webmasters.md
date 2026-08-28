# Information for webmasters

Brisk Browser prioritizes perceived speed and deliberately uses caching rules
that differ from standard browsers. This can affect server load, analytics,
and privacy.

## Aggressive caching: current default

A response cached for one Brisk Browser user can be rendered speculatively for
another user while that second user's real request is still pending. Cookie,
Authorization, Set-Cookie, `Cache-Control: private`, `no-store`, method, and
status do not prevent admission to this shared speculative cache.

The real request is still made. If its response differs, Brisk Browser replaces
the speculative rendering with truth. Cached Set-Cookie and other stateful
headers are stripped from speculative fulfillment, but response pixels may
briefly expose user-specific content.

Do not leave URLs in this mode if their rendered output can reveal information
that must never be shown to another user, even briefly.

## Opting out with aggressive preloading

Return this response header:

```http
X-Preload-Supported: true
```

The current proxy treats that response as connection-private and does not
share its cached bytes across users.

The intended complete protocol additionally makes speculative origin requests
with an `X-Preload` state value. A server supporting that protocol must make
such requests side-effect-free—for example by executing mutations inside a
transaction that is always rolled back—and should return quickly with bytes
matching a later real response.

Brisk Browser now sends `X-Preload: true` on every request a live speculative
link-preload fork makes to your origin—before the user has tapped the link,
while it's still only a prediction. The header is present for the full
lifetime of that prediction (the initial navigation and every subresource it
loads) and disappears the instant a user's real tap confirms it: from that
point the fork is the user's actual page view, not a guess, and its requests
are indistinguishable from ordinary browsing. A predicted link the user never
taps is simply discarded—your server will have received one `X-Preload: true`
request for it and nothing further.

`X-Preload-Supported: true` (the response-header opt-out above) and
`X-Preload: true` (this request-header signal) are independent: the first
controls whether *any* user's cached bytes can render for another user before
their own request lands, the second tells you whether *this particular
request* is a prediction. A resource can, and reasonably often should, use
both.

## Practical guidance

- Use the default mode only where brief cross-user rendered output is
  acceptable.
- Add `X-Preload-Supported: true` to sensitive or personalized resources.
- Treat every future `X-Preload` request as speculative and side-effect-free.
- Do not rely on ordinary HTTP cache headers to disable Brisk Browser's shared
  speculative cache.
