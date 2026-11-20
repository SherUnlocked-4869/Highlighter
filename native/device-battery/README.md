# Highlighter device battery sidecar

This is a headless Windows x64 .NET 10 executable, built from the device suite in [BrimDeck `f1510d09677492a13a31d26bc37c3509da1b818f`](https://github.com/MoFeng2223/BrimDeck/tree/f1510d09677492a13a31d26bc37c3509da1b818f). `Vendor/BrimDeck.Core` holds the device model, merger, battery decoders, HID families and read policy. `Vendor/BrimDeck.Native` holds SetupAPI/HID, Bluetooth cache and BLE GATT, passive Apple advertisements, Windows Gaming Input and XInput, Phone Link, and their workers. `Vendor/Tests` holds upstream pure fixtures from `tests/BrimDeck.Tests`. No upstream app shell, user interface, assets, or installer is used.

The C# host retains WPF's Dispatcher/DispatcherTimer to run the upstream sources, but does not create a WPF `Application` or `Window`. Electron controls suspend/resume and session lifetime. The adapted files are marked at the top. The protocol byte layouts and device-family tables were not reimplemented. See [BrimDeck's license](../../docs/third-party/LICENSE-BrimDeck.txt) and the [device notices](../../docs/third-party/NOTICE-BrimDeck-device-battery.txt). The upstream comments also identify some GPL/AGPL or unlicensed projects as references for protocol facts, recorded bytes, or model IDs only; those projects are not vendored or linked here.

## Build and verify

With the Windows x64 **.NET SDK 10.0.404** available, run from the repository root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File native/device-battery/build.ps1 -Verify
```

For a locally unpacked SDK, set `$env:DOTNET_EXE` to its absolute `dotnet.exe` path; the script otherwise checks `.tmp-sdk/dotnet.exe` and then `PATH`. `global.json` selects the exact SDK (no roll-forward). Restore uses NuGet.org and the checked-in lockfile; the SDK selects the .NET 10.0.15 runtime packs and the Windows SDK projection. The build uses deterministic C# output with normalized source paths, stages the publishing files outside `bin`, and replaces `bin` only after a successful build (and verification if requested). Do not run two builds in the same checkout concurrently.

The output is **`bin/HighlighterDeviceBattery.exe` plus the rest of `bin/`** (runtime, WinRT projection, system ports package, and licenses; ~158 MiB uncompressed). Copy or package the whole directory together. It is self-contained and does not extract files at runtime. The apphost is a console PE; spawn it with redirected stdio and `windowsHide: true` (or `CreateNoWindow` for PowerShell verification). It runs as the current user without elevation.

The API baseline and `--watch` guard are Windows 10 2004, build 19041, or later. This is not a promise of runtime support on every later Windows 10 release: see the [.NET 10 OS support matrix](https://github.com/dotnet/core/blob/main/release-notes/10.0/supported-os.md). Local automated verification on Windows 11 x64 build 26300 did not probe hardware. Windows 10 and actual Bluetooth/HID/controller/Phone Link capture still need separate device validation.

## Stdio contract

| Invocation | Behavior |
| --- | --- |
| `--version` | Prints exactly `HighlighterDeviceBattery 1` plus newline. Runs no device source. |
| `--smoke` | Runs pure recorded/synthetic protocol, model and command checks. `--smoke --scratch-dir <absolute path>` adds safety storage checks in a new test subdirectory; neither mode runs device I/O. |
| `--smoke-pipe` | Exercises the real Dispatcher, pipe and shutdown path with synthetic snapshots only. Accepts the same commands as watch. Normal application launch never selects this mode. |
| `--watch --state-dir <absolute path>` | Opens the Win32/WinRT readers; intended only for the primary application's fixed launch path. Requires stdin from a live parent pipe and redirected stdout. |

Watch stdout is newline-delimited UTF-8 JSON, with no BOM, logs or device-identifying raw keys. Each line has `schemaVersion: 1`, `status`, `system`, and `devices`. `status` starts `loading`, then is `ready` after successful enumeration or `partial` if a required source is not ready after ten seconds, a source reports failure, safety state is unavailable, or the roster was truncated. Partial snapshots still carry available results. An empty partial roster does not mean no devices. `system.state` is independent: `ready`, `no-battery`, or `unavailable`. Unknown percent or charge values are `null`, not zero or false. Upstream coarse/asleep values map to `estimated`/`stale`. Row IDs are digests of the native merge keys and should still be re-keyed by the parent before renderer IPC. Changed snapshots are sent promptly; an unchanged snapshot is repeated roughly every 15 seconds as a heartbeat without performing an extra query. Only fixed diagnostic codes go to stderr.

Send `refresh <id>\n`, where the ID is a positive decimal int32 (for example, `refresh 1\n`). The parent sends one request at a time. The reply is a `ready` or `partial` snapshot carrying an additional top-level `refresh: { "id": 1, "status": "complete" }` (or `"partial"`). `complete` means the available query paths finished their attempts and applied any results, not that each device supplied a new value. Ordinary changes and heartbeats continue during the attempt, and never carry a refresh ID.

Refresh reads system power, Phone Link and gaming reports; asks HID for a full pass and includes the independent Corsair reader; rereads Windows Bluetooth endpoint/node cache and any readable BLE battery level/status characteristics. Already-running BLE operations are reused rather than duplicated. Manual BLE reads may reach `Read`-capable fields even when subscribed, but not notify-only fields; automatic polling still follows the notification and interval policy, and Windows' cached percentage still takes precedence. HID retains vendor contention, protocol spacing, slow-device backoff and guarded discovery rules. Passive advertisement/report readers do not wait for new traffic. A source failure or the eight-second refresh budget can return a `partial` receipt with the usable snapshot; late readings may still arrive as ordinary updates. Refresh while still loading settles to a `ready` or `partial` reply, without restarting the process.

Send `stop\n` or close stdin to stop. Input is checked before activating sources and a closed input pipe does not start collection. On stop/EOF, the outstanding refresh wait is cancelled, new guarded HID requests are inhibited, and the Dispatcher keeps pumping asynchronous cleanup. It allows up to two seconds for workers before returning `drain-timeout` (exit 4), with a 2.5-second exit watchdog if the Dispatcher itself blocks. The parent should still enforce its own hard cutoff. A stuck call never has its marker cleared merely because the Dispatcher exited.

## Device safety and private state

Use a private local fixed-drive directory dedicated to this helper. The helper never reads or writes BrimDeck's installed state. It uses an exclusive lease, validates bounded state files and flushes an active probe mark to disk **before** trying an unverified adaptive HID read. The completed read alone may clear its mark. A surviving mark is durably added to the blocked reads on the next start before it is cleared; corrupt, unreadable, redirected, or locked state disables HID in that process rather than forgetting prior blocks. If a later mark cannot be persisted, further adaptive reads stop. The other source families remain available. Device read successes and blocked reads persist across watch processes. Upstream silent-retry rounds, spacing and seen-device bookkeeping are in-memory and restart when a watch process is recreated.

As in BrimDeck, some device-specific battery queries send HID/serial reports; BLE may perform uncached reads and subscribe via the CCCD; Logitech receiver notices may enable the wireless notification bit. These are not purely passive enumeration. Phone Link only reads the existing local Start card; the helper never launches Phone Link or writes to its data directory. AirPods/Beats proximity advertising still uses upstream's signal/name-family heuristic and cannot prove identity of a nearby advertisement. Hardware models, reliability and fallbacks are inherited from the pinned upstream, not blanket Highlighter compatibility claims.
