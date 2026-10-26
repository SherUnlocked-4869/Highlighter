# Highlighter selection-hook source

Upstream: https://github.com/0xfullex/selection-hook, npm `selection-hook@2.1.2`.
License: MIT; the unmodified upstream LICENSE is included.

Registry tarball: `selection-hook-2.1.2.tgz`.
SHA-1: `e66d3da432175dd02484c4e60fd928932885e39e`.
Registry integrity: `sha512-eNPQzL+OFf4WUXApxpXiplTUicL5MAtxm3yXi6dIRY8VUZ+2vuXHnlFBSQ/LXAe8hXewMM91SWK+YjU06ZbZVg==`.

The initial src/ tree, wrapper and type definitions match this registry package.
Prebuilt binaries and upstream agent instructions are deliberately not imported.
This is a source dependency: installation builds the Node-API addon locally.
Highlighter changes are reviewable in Git, not patches to node_modules.

## Synced to 2.1.2 (2026-10-26)

The vendored tree was rebased from upstream 2.1.1 onto 2.1.2. The two upstream
Windows changes are kept in full; the Highlighter patches below still apply on
top of them.

- Removed the UIA DocumentRange fallback (upstream issue #25). Chromium answers
  document-range attribute queries on its browser UI thread by walking the page,
  so a gesture that ended without a selection could freeze every browser window
  for tens of seconds. The focused element and its ancestors are now read
  through `GetSelection` only.
- The clipboard fallback refuses a window created by the calling thread.
  Keystrokes queued to that thread cannot be dispatched while the poll loops
  block, and they would reach the window after the clipboard was restored and
  silently overwrite the user's copy.
- `docs/WINDOWS.md` (not imported) documents the same-thread limitation. No
  public API or configuration changed in 2.1.2.

## Changes

- Build a native identity from the exact source/configuration hash. Expose it
  through `SelectionHook.nativeBuildId` for packaged runtime verification.
- Limit package scripts to the supported source rebuild instead of referring
  to tests/tools omitted by the registry tarball.

The initial import (aa14d6f) did not change native clipboard behavior. Subsequent
G0 patches are source changes in this repository:

- Optional private Windows coordinator API, asynchronous health check, and native
  worker lease acquisition before any clear/copy/restore operation. A configured
  synchronous caller never waits for a lease; UIA/MSAA are unaffected.
- Native input serials counted before retrieval-event filtering. Only this
  module's tagged injections are ignored; other tools' injections interrupt.
- Sequence/owner/input checks under the restore lock, a message-only owner HWND,
  restoration of empty backups, and cleanup on early returns.
- Limit backup to 64 formats / 64 MiB and text reads to 2 MiB allocated UTF-16
  or ANSI source data. Reject incomplete/unsupported backups before clearing.
- Metadata-only counters for lease denial, backup rejection, interruption,
  ambiguity and restoration. Never include payloads or coordinator credentials.

The protocol and restore policy have automated synthetic tests. This does not
prove compatibility with every application's delayed rendering; G0 remains
unqualified until isolated clipboard and application-matrix tests pass.

Run `node scripts/source-build-id.js` here to compute the expected identity.
Changes to tracked native sources, wrapper, types, package or build configuration
invalidate that identity and require a rebuild. The identity does not replace
the release binary SHA-256 or toolchain record.
