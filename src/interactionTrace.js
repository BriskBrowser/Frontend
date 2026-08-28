// Records real user interactions (page navigation, link clicks, scroll
// gestures, history back/forward) into a flat, timestamped, JSON-dumpable
// list -- so a real session can be captured live and replayed later against
// test/harness.js's viewer arm for debugging (see test/replayTrace.js and
// docs/interaction-trace.md). Exposed on `window.__briskTrace` (alongside
// the existing `window.sessions` testing hook in browser.js) so it can be
// pulled from devtools without any UI: `__briskTrace.dump()` or
// `__briskTrace.download()`.
const events = [];

function record(type, detail) {
  events.push({type, t: Date.now(), ...detail});
}

export const interactionTrace = {
  events,
  record,
  clear() { events.length = 0; },
  dump() { return JSON.stringify(events, null, 2); },
  download(filename) {
    const blob = new Blob([interactionTrace.dump()], {type: 'application/json'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename || `brisk-trace-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  },
};

if (typeof window !== 'undefined') window.__briskTrace = interactionTrace;
