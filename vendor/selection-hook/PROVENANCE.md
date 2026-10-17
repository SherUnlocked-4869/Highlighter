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

The native clipboard transaction behavior is unchanged in this initial import.
Run `node scripts/source-build-id.js` here to compute the expected identity.
Changes to tracked native sources, wrapper, types, package or build configuration
invalidate that identity and require a rebuild. The identity does not replace
the release binary SHA-256 or toolchain record.
