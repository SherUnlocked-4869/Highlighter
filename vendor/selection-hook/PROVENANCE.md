# Highlighter selection-hook source

Upstream: https://github.com/0xfullex/selection-hook, npm `selection-hook@2.1.1`.
License: MIT; the unmodified upstream LICENSE is included.

Registry tarball: `selection-hook-2.1.1.tgz`.
SHA-1: `7e5b6b5094983a0ae7366ad5ab80db55843eb218`.
Registry integrity: `sha512-8ZqU2ModYR7Ji2s/T4GUgxBeZw2oeOJZeYMyMT6kxZUPkJUD193kGLIF1mxqlV6pYSmo0CBGi9mW8468PsMuYA==`.

The initial src/ tree, wrapper and type definitions match this registry package.
Prebuilt binaries and upstream agent instructions are deliberately not imported.
This is a source dependency: installation builds the Node-API addon locally.
Highlighter changes are reviewable in Git, not patches to node_modules.

Changes:

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
