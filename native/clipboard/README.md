# Clipboard G0 native prototype

This Windows-only Rust process is a development prerequisite. It is not started
by Highlighter and does not provide a product history API yet. Initialize is
disabled by default; its capabilities report `history: false`, `coordination:
true`, `qualified: false`. The native lease/barrier is implemented, but isolated
clipboard/application-matrix qualification is incomplete. Do not use this as
product history.

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
probe compares the running executable against that hash. No installer or startup
build path is changed in G0.

The process uses bounded length-prefixed stdio frames, a message-only HWND and a
bounded queue of sequence/configuration metadata. Its callback never reads data.
An independent capture thread owns snapshots and drops them after updating only
counters. There is no database, content logging, image decoding or event polling
timer. Windows may coalesce notifications; this is best-effort observation, not a
lossless record of every clipboard mutation. Capture/stop failures are reported,
not converted into successful quiescence.

Current capture support: CF_UNICODETEXT, registered PNG, 24/32-bit uncompressed
DIB/DIBV5. Text preserves whitespace. Privacy flags and CF_HDROP are checked
first. Allocated source sizes and bitmap dimensions are validated before copying;
the initial image header checks do not replace a safe full decoder in T05.

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
