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

## One `npm test` failure is a known flake: the clipboard lease round

`test/clipboard-coordination.test.js` → "native addon authenticates leases,
finishes 100 rounds and rejects bad credentials" drives 100 synchronous lease
round-trips through the native `selection-hook` addon and asserts on every one
(`Lease round ${index}`). On a loaded machine a single round can miss its window
and the assertion fails with `Lease round 98` (the index varies).

Measured 2026-10-24 on this host: the test passes 4/4 alone and 3/4 within a full
`npm test` run, reproducibly, with **no source change** in between. Before
treating it as a regression from a change of yours, re-run it standalone twice:

```bash
npx node --test test/clipboard-coordination.test.js
```

If it passes standalone, it is the flake, not your diff. Do not "fix" it by
loosening the assertion without understanding the timing budget.

## A local pass is not evidence the CI gate will pass

The mirror image of the mistake above, and the one that actually bit: after the
four traps are handled, `npm test` is 1278/1278 **green locally**, and CI still
failed on exactly one test. Do not report "CI is fixed" from a local run alone.

The specific case worth knowing, because it will mislead again:
`test/capture-brush-render.test.js` (§6.3 grid-phase, "overlapping strokes must
share one cell grid") passes here and on 43.2.0, but has **failed in every one of
its six CI runs since it was introduced in `d9ad364`** (2026-10-19) — it has
never once been green on a runner. The probe asserts pixel-exact seam-free
mosaicking, and GitHub's Windows runner has no GPU, so the software rasteriser
produces sub-pixel differences this host's hardware path does not.

So when a gate is red in CI but green locally, establish which it is before
changing anything:

```bash
gh run view <run-id> --log-failed | grep -E "✖|AssertionError"
gh run view <run-id> --log | grep -E "brush plan §6.3"   # ✔ vs ✖ in that run
```

Check whether the failing test has *ever* passed on CI (`git log` the test file
against the run list) — if it never has, the test or the CI environment is the
bug, and it is not a regression from whatever you just changed. Say so plainly
instead of claiming a green pipeline you cannot demonstrate.

Note also that `git push` to `master` currently bypasses the required "Check and
test" status check, so a push succeeding proves nothing about the gate.

