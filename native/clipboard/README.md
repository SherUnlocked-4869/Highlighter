# Clipboard native backend

This Windows-only Rust process now provides the opt-in V1 history backend.
Highlighter starts it only when clipboard history is enabled. Capture remains
disabled at launch until private host coordination and explicit configuration
complete. `initialize` with a private `storageRoot` opens schema v1 and reports
`history: true`; omitting that argument preserves the nonpersistent G0 probe.
`qualified: false` records the outstanding system/resource qualification.

Implementation and deferred acceptance: [V1 development record](../../docs/performance/2026-10-17-clipboard-v1-development.md).

Build and validate from the repository root:

```powershell
npm run build:clipboard
npm run build:selection
npm run test:clipboard:native
cargo clippy --locked --manifest-path native/clipboard/Cargo.toml --all-targets -- -D warnings
node --test test/clipboard-protocol.test.js test/clipboard-resource-series.test.js
```

`bin/HighlighterClipboard.exe` and `target/` are ignored outputs. The build script
embeds a normalized hash of Cargo.lock, Cargo.toml and runtime sources; the Node
probe compares the running executable against that hash. The normal native build and package resource list now include the sidecar and
its build-info.json. Merely opening settings or reading status spawns nothing.

The process uses bounded length-prefixed stdio frames, a message-only HWND and a
bounded queue of sequence/configuration metadata. Its callback never reads data.
An independent capture thread owns bounded snapshots and serially validates
images and commits SQLite history after closing the system clipboard. The native
listener has no polling timer; the parent polls bounded health/status every two
seconds only while enabled. There is no content logging. Windows may coalesce notifications; this is best-effort observation, not a
lossless record of every clipboard mutation. Capture/stop failures are reported,
not converted into successful quiescence.

Current capture support: CF_UNICODETEXT, registered PNG, 24/32-bit uncompressed
DIB/DIBV5. Text preserves whitespace. Privacy flags and CF_HDROP are checked
first. Allocated source sizes and bitmap dimensions are validated before copying;
storage performs a bounded full decode after the clipboard lock is released.

The ordinary lifecycle test starts only **paused** listeners and never reads or
writes clipboard payloads. The actual capture integration test is opt-in and
requires a private non-interactive Window Station:

```powershell
cargo test --locked --manifest-path native/clipboard/Cargo.toml --test isolated_capture -- --ignored --nocapture
```

It aborts before writing if isolation cannot be created. Never replace its private
station with the user's interactive clipboard. In the current execution context,
CreateWindowStationW returned E_ACCESSDENIED; the capture integration case is
therefore unverified. See `docs/performance/2026-10-17-clipboard-g0.md` for gate
status and resource evidence. The product implementation starts only after G0.

The optional coordinator uses a random logon-scoped local named pipe, pins the
registered host process HANDLE and verifies peer PID. Only 128-byte metadata
requests / 32-byte replies cross it. A lease drains active read permits before
granting; orphaned leases remain blocked until the registered host has exited.
Coordinated configuration, recovery and shutdown require capture to be paused.
See `docs/performance/2026-10-17-clipboard-t03.md` for the wire format, limits,
automated evidence and unresolved same-application delayed-publication cases.
