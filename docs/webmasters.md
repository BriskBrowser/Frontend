# Information for webmasters

Brisk Browser focusses on speed above all else.  This means it does a lot of preloading and caching tricks which could impact your stats, your server load, or even your users privacy.    Read on to learn how best to mitigate that.

***NOTE this this documents the final goal for brisk browser. The current implementation does not offer any privacy guarantees***

For each resource URL, brisk browser can operate in two modes:   Aggressive caching (which does not need support of the server), and Aggressive preloading (which requires server support, but offers greater user privacy).

## Aggressive caching mode

In this mode (which is the default), a resource cached for any user of Brisk Browser can be used to render a 'quick' version of a page displayed to any user.   Later, the URL will be reloaded correctly according to the HTTP standards (taking into account cache headers), and the 'correct' rendering shown to the user, which in the vast majority of the cases is the same.

In agressive caching mode, a 'quick' resource which contains private data, such as a users auth cookie, might be loaded into another users session.   Any session with any 'quick' loaded resources will never be directly exposed to any user - all session state, including the DOM, javascript variables and HTTP requests will be kept secret.  The final rendered page *will* be displayed to the user though.  

This means, when using agressive caching mode:

  * It is important for your users privacy you do not write code which could display sensitive data served from a URL in aggressive caching mode onto the screen.
  * Your site does not contain XSS vulnerabilities allowing an attacker to run arbitary javascript on your domain.  If it did, then an attacker could run arbitary javascript and extract any private data such as auth tokens from any URL using Aggressive caching mode.  XSS vulnerabilities leak resources from your domain in other browsers, so this doesn't really differ.

The TL;DR is agressive caching mode is suitable for static resources and your hosted DnD forum, but probably not for the AJAX request to view your bank balance.

If these are a concern, you should use Aggressive Preloading mode.

## Aggressive preloading mode

In this mode, data is never shared between users.  Instead, data to pre-render a page is loaded directly from your server.  If that page is later *actually* rendered, the request will be done again.

Your server needs to guarantee that the 'prerender' request will have no side effects.   That means if the user clicks the "buy it now" button, your server should respond with "This order is now being shipped to you", but should *not* update the database.

In most programming languages, this can be achieved by starting a database transaction, running all the logic for the page, and then rolling back the transaction at the end.

Note that in Agressive preloading mode, Aggressive caching mode of other URL's on your domain might be used to determine *what* to preload.  Other preloaded responses from your server might also be used.

To enable Aggressive preloading mode for a URL:

 * Set the `X-Preload-Supported: true` HTTP header on responses.
 * Respond in under 200ms
 * Respond with headers and data which usually matches the non-preloaded version of the same request byte for byte.

All preloaded requests will be made with an `X-Preload: XXXX` header.   The `XXXX` value represents a piece of client state, and most implementors can ignore it.

In some specific scenareos, for example where a client accesses one URL to get a token that it then uses at another URL to get a response, you will want to make use of this state value.  A followup request will always be made with a state value which is either the same, or the same with a suffix.  For example, `X-Preload: XXXXY`.


Most pages will end up displaying a mix of preload and caching mode resources.