# Workspace Instructions

- Place all visible automation and real-device test windows on the secondary display by default. Keep the primary display free for the user.
- If no secondary display is available, ask before opening a visible test window.

## Running the Electron test gates in a confined session

This checkout is often driven from a sandboxed automation host. Before concluding
that a gate "cannot run here", rule out the four environment traps below — all
four produce failures that look exactly like real regressions. Each was actually
reproduced on 2026-10-22 while upgrading Electron, and all four turned out to be
host configuration, not product bugs.

1. **`ELECTRON_RUN_AS_NODE=1` in the session environment.** The comment on
   `e2e/electron-app.js` is accurate: this host's Chromium sandbox cannot start.
   But that is *not* why GUI probes were dying. With this variable set,
   `electron.exe` runs as plain Node, so `require('electron').app` is `undefined`
   and every probe fails immediately (`app is undefined`, or exit code `3` /
   `2147483651`). Clear it: `env -u ELECTRON_RUN_AS_NODE`. Passing `--no-sandbox`
   while it is set fails differently and more confusingly:
   `electron.exe: bad option: --no-sandbox`, exit code `9`.

2. **`--no-sandbox` must precede the script path.** `electron.exe --no-sandbox
   scripts/probe-foo.js` works. `electron.exe scripts/probe-foo.js --no-sandbox`
   does not: the flag becomes a script argument, Electron falls back to plain
   Node mode, and the probe dies with `app is undefined`. Chromium's own sandbox
   genuinely cannot start in this host, so GUI work needs the flag — the repo's
   env-gated `HIGHLIGHTER_E2E_NO_SANDBOX=1` covers the Playwright adapter, but
   `test/*-runtime.test.js` spawn each probe directly with a bare
   `spawnSync(electronPath, [scriptPath])`, so the flag has to be injected for
   those (e.g. a temporary `NODE_OPTIONS=--require <hook>` that patches
   `spawnSync`; keep it outside the repo and never commit it).

3. **Spawned Electron children cannot write `%LOCALAPPDATA%\Temp`.** The parent
   Node process can, which makes this easy to misread as a passing test host, but
   the child gets `EPERM: operation not permitted, mkdir 'C:\Users\...\Temp\...'`
   and then hangs until the probe timeout. Point the throwaway roots inside the
   checkout instead — the repo already expects this and ships
   `HIGHLIGHTER_E2E_DATA_ROOT_BASE` for the Playwright path. For the direct
   probes, export `TMP` and `TEMP` to an in-repo scratch dir as well.

4. **`npm audit` against the configured registry silently returns nothing.**
   `.npmrc` sets `registry.npmmirror.com`, whose `/-/npm/v1/security/*` endpoints
   are not implemented (`404 NOT_IMPLEMENTED`). `scripts/audit-dependencies.js`
   then sees an empty vulnerability list and reports *every* allowlist entry as
   stale — which reads like a broken allowlist rather than a broken registry.
   Run it with `npm_config_registry=https://registry.npmjs.org` to reproduce CI.

With all four handled, the full suite runs in this host:

```bash
env -u ELECTRON_RUN_AS_NODE \
  TMP="D:/workspace/Highlighter/.tmp-test" \
  TEMP="D:/workspace/Highlighter/.tmp-test" \
  NODE_OPTIONS="--require <path-to-local-spawn-hook>" \
  HIGHLIGHTER_E2E_DATA_ROOT_BASE="D:/workspace/Highlighter/.tmp-test" \
  npm test          # 1278/1278
```

`test:coverage`, `test:e2e` (real Electron launch), `test:long-capture`, `check`,
`check:version` and `verify:fuses` all pass locally this way. Only
`verify:package` (needs a full electron-builder artifact plus silent install) and
the manual real-device checklist genuinely require a real desktop session — do
not report those as verified from a confined host, and do not report the others
as blocked without trying the above first.

Scratch paths must live under `.tmp*/`, which is already gitignored; remove them
before committing.
