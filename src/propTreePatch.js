// Applies a PropTreeDiff.js copy/insert/skip patch (see that file, and
// SocketHandler.js's diffPropTrees()) to reconstruct a full
// propertyTreesJSON string from the last one this session received plus a
// PageStream.streamPropTreesPatch's `ops`. This is a small, deliberate
// duplicate of PropTreeDiff.js's own `apply()` -- Frontend is a separate
// repo/bundle (github.com/BriskBrowser/Frontend) with no access to the
// server project's root, so sharing the module isn't an option; the
// function itself is short enough that keeping two copies in sync by hand
// is far simpler than any cross-repo build wiring would be. Both copies
// are covered by round-trip tests against the SAME patch format
// (server: test/run_prop_tree_diff.js; this file's own behavior is
// exercised indirectly by whatever streamPropTreesPatch messages a real
// session receives).
export function applyPropTreePatch(oldStr, ops) {
  let out = '';
  let pos = 0;
  for (const op of ops) {
    if (op.c !== undefined) {
      out += oldStr.substr(pos, op.c);
      pos += op.c;
    } else if (op.s !== undefined) {
      pos += op.s; // skip deleted old-string content; no output
    } else {
      out += op.i;
    }
  }
  return out;
}
