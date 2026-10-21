# Third-party notices

## Index-Translate (bilibili)

`main/services/translation-proxy-service.js` contains a rewritten, in-process
implementation of the local OpenAI-compatible relay that ships with
[bilibili/Index-Translate](https://github.com/bilibili/Index-Translate)
(`inference/llm/call_api.py`, `run_proxy_server`), commit
`9aff74ca50c60873916f99269b10cd0d79237b4a`.

That project is licensed under the Apache License 2.0; the full text is in
`LICENSE-Index-Translate.txt` next to this file. The relay implementation here is
a derivative work and is provided under the same licence terms for the derived
portions.

The Index-Translate *model* and its public API are operated by Bilibili and are
not distributed with Highlighter. Text translated through the built-in cloud
endpoint is sent to `index-translate.bilibili.com`; point the "upstream API
address" setting at a local deployment to keep it on the machine.

## TokenTracker

`main/vendor/tokentracker/` holds a vendored copy of the scan/parse closure of
[xiufengsun/TokenTracker](https://github.com/xiufengsun/TokenTracker) — the
`tokentracker-cli` package the AI Usage page uses to read local AI CLI logs
(Codex / DeepSeek Harness / OpenCode in the first release; the remaining
passive-log parsers stay available for later tool batches).

- Upstream repository: <https://github.com/xiufengsun/TokenTracker>
- Upstream version: `tokentracker-cli@1.4.7`
- Upstream commit: `148b758e` (2026-10-20, "feat: optional Sentry error reporting (dashboard + Node CLI) (#841)")
- Vendored on: 2026-10-21
- License: MIT — full text in `LICENSE-TokenTracker.txt` next to this file.
  Copyright (c) 2026 xiufengsun.

### Vendored files

| File | Lines | Note |
|---|---:|---|
| `rollout.js` | 25,038 | 43 `parse*Incremental` parsers after V1 (upstream had 46) |
| `jsonl-lines.js` | 136 | |
| `sqlite-reader.js` | 124 | rewritten by V4 |
| `install-resolver.js` | 172 | |
| `scan-roots.js` | 262 | trimmed by V6 |
| `fs.js` | 457 | |
| `claude-user-identity.js` | 58 | |
| `codex-token-usage.js` | 197 | |
| `codex-usage-record.js` | 197 | |
| `codex-model-attribution.js` | 130 | |
| `codex-service-tier.js` | 51 | |
| `devin-usage.js` | 214 | |
| `grok-usage.js` | 97 | |
| `wsl-probe.js` | 84 | replaced by the V5 no-op stub (upstream had 281) |

Total: 14 files, 27,217 lines including the V8 headers.

### Modifications (V1–V9)

Tracked against upstream `src/lib/`; the plan is
`docs/plans/2026-10-21-tokentracker-usage-page-development-plan.md` §2.3.

| # | File | Change |
|---|---|---|
| V1 | `rollout.js` | Removed the Trae SOLO / Trae CN parsers (`parseTraeIncremental`, `parseTraeCnApiIncremental`) together with their SQLCipher/network helpers, resolvers, source aliases and the `require("./trae-db")` / `require("./trae-usage")` imports; removed the Cursor account-API parser (`parseCursorApiIncremental`) and its lazy `require("./cursor-config")` credential/network path. No Trae or Cursor-tool code remains. |
| V2 | `rollout.js` | Removed both `@mongodb-js/zstd` fallbacks (Zed BLOB decoder and DeepSeek Harness frame decoder); decompression uses the runtime's built-in `zlib.zstdDecompressSync` only, so no npm runtime dependency is added. |
| V3 | `rollout.js` | Added the module-level `bucketSink` + `setBucketSink(fn)`. `enqueueTouchedBuckets` / `enqueueTouchedProjectBuckets` now build row objects first and pass them to the sink as `(rows, { kind: "usage" })` / `(rows, { kind: "project" })`; with no sink installed they keep the upstream JSONL append byte for byte. `module.exports` gains `setBucketSink` and `normalizeHourlyState` (`bucketKey`, `groupBucketKey`, `totalsKey`, `toUtcHalfHourStart` were already exported). |
| V4 | `sqlite-reader.js` | Removed the external `sqlite3` CLI branch (`execFileSync`/`execFile`, PATH lookup) and its warning plumbing. Every read now uses the runtime's built-in `node:sqlite` `DatabaseSync` opened with `{ readOnly: true }`; public API and return shapes are unchanged. |
| V5 | `wsl-probe.js` | Replaced with a stub that exports exactly the 11 functions the vendored closure calls. It reports native-only mode (`shouldProbeWsl` false, `shouldProbeNative` true, `getWslMode` `native-only`), never spawns `wsl.exe` and performs no I/O. `snapshotSqliteDb` hands the native path back so non-WSL parsers keep working. |
| V6 | `scan-roots.js` | Removed the `~/.tokentracker/tracker/config.json` read (`loadScanRootsConfig` and the `tracker-paths` import). `expandHome`, `resolveEnvRoot`, `scanRootDirState`, `dedupeDirsByRealpath`, `resolveScanRoots` and the other helpers are kept. |
| V7 | — | Deliberately not vendored: `tracker-paths.js`, `cursor-config.js`, `trae-db.js`, `trae-snapshot.js`, `trae-sqlite.js`, `trae-usage.js`, `trae-cn-config.js`. |
| V8 | all files | Each file starts with `// Vendored from TokenTracker v1.4.7 (commit 148b758e, MIT) — see docs/third-party/LICENSE-TokenTracker.txt`. All code, comments and diagnostics stay English (the repo i18n gate counts CJK lines under `main/`). |
| V9 | `rollout.js` | Export surface narrowed to the parser closure: every export of a deleted Trae/Cursor symbol is gone and the V3 helpers were added. The remaining exports are the upstream parser API the adapter registry (and later tool batches) call. |

### Behaviour notes

- No child process, no network and no new npm runtime dependency: the whole
  closure uses Node built-ins plus the runtime's `node:sqlite` and
  `zlib.zstdDecompressSync`.
- `scripts/usage-vendor-smoke.js` is a development-only check that requires the
  vendored module, asserts the parser entry points and runs empty synthetic
  `parseRolloutIncremental` / `parseDshIncremental` calls. It is not part of
  `npm test`.
- Upstream parser test suites are not vendored; Highlighter-side gates are the
  smoke script above plus the usage fixtures and unit tests added in later
  batches.
- Re-vendoring: diff against tag `v1.4.7` / commit `148b758e` and replay V1–V9.
