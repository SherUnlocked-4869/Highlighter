// Capture the Highlighter usage IPC payloads for the aggregation-level oracle
// (see test/fixtures/usage/golden/README.md "Capturing the Highlighter side").
//
// Headless Electron main script: no BrowserWindow is created. It assembles the
// real usage feature against the committed fixture home, runs one scan, then
// calls the same handlers the IPC channels use and writes the 26-entry capture
// file expected by `scripts/usage-oracle-check.js --aggregates`.
//
// The fixture data lives in 2026-03, so the four "period" payloads are produced
// with custom ranges matching the pinned ranges in the aggregation goldens
// (day=latest fixture day, week=Monday..Sunday, month=calendar month, total=
// fixture span). The comparator keys captures by tz/view/period, so this is an
// equivalence test of aggregation semantics on the same ranges, not a
// system-clock-dependent reimplementation.
//
// Run from the repository root (unset ELECTRON_RUN_AS_NODE in agent shells):
//   env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe --no-sandbox \
//     scripts/usage-capture-aggregates.js .tmp/hl-aggregates.json
// The output path is the last *.json argument (USAGE_CAPTURE_OUT overrides it);
// it defaults to .tmp/hl-aggregates.json.
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { app } = require('electron')

app.disableHardwareAcceleration()

const WORKTREE = path.join(__dirname, '..')
const TZS = ['Asia/Shanghai', 'UTC']
const PERIOD_RANGES = {
  day: { from: '2026-03-16', to: '2026-03-16' },
  week: { from: '2026-03-16', to: '2026-03-22' },
  month: { from: '2026-03-01', to: '2026-03-31' },
  total: { from: '2026-03-14', to: '2026-03-16' }
}
const PERIODS = ['day', 'week', 'month', 'total']
const SCAN_TIMEOUT_MS = 120000

function resolveOutputPath() {
  if (process.env.USAGE_CAPTURE_OUT) return path.resolve(process.env.USAGE_CAPTURE_OUT)
  // Electron keeps its own switches in argv, so accept any trailing *.json arg
  // instead of relying on a fixed index.
  const jsonArg = process.argv.slice(1).reverse().find((arg) => typeof arg === 'string' && arg.toLowerCase().endsWith('.json'))
  return path.resolve(jsonArg || path.join(WORKTREE, '.tmp', 'hl-aggregates.json'))
}

async function waitForScan(feature, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const status = await feature.getStatus()
    if (status && status.scanning === false) return status
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`scan did not finish within ${timeoutMs}ms`)
}

async function main() {
  const outputPath = resolveOutputPath()
  const fixtureHome = path.resolve(process.env.HIGHLIGHTER_USAGE_HOME || path.join(WORKTREE, 'test', 'fixtures', 'usage', 'home'))
  const scratchRoot = path.join(WORKTREE, '.tmp', `usage-capture-${process.pid}-${Date.now()}`)
  const paths = { usage: path.join(scratchRoot, 'usage') }
  fs.mkdirSync(paths.usage, { recursive: true })
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  if (!fs.existsSync(fixtureHome)) throw new Error(`fixture home not found: ${fixtureHome}`)

  const feature = require(path.join(WORKTREE, 'main', 'services', 'usage-feature')).createUsageFeature({
    app,
    getPaths: () => paths,
    getSettings: () => ({ usage: { enabled: true } }),
    getMainWindow: () => null,
    homeDir: fixtureHome,
    env: { ...process.env, HIGHLIGHTER_USAGE_HOME: fixtureHome },
    log: () => {}
  })

  await feature.refresh({ reason: 'capture' })
  await waitForScan(feature, SCAN_TIMEOUT_MS)

  const handlers = feature.handlers || {}
  const captures = []
  for (const tz of TZS) {
    for (const period of PERIODS) {
      const range = PERIOD_RANGES[period]
      const query = { period: 'custom', tz, from: range.from, to: range.to }
      captures.push({ tz, view: 'summary', period, payload: await handlers.summary(query) })
      captures.push({ tz, view: 'daily', period, payload: await handlers.daily(query) })
      captures.push({ tz, view: 'breakdown', period, payload: await handlers.breakdown({ ...query, scope: 'source' }) })
    }
    captures.push({ tz, view: 'heatmap', period: 'total', payload: await handlers.heatmap({ tz, weeks: 52 }) })
  }

  // Non-comparator payloads used by the page's real-payload render check: the
  // oracle comparator reads only `captures`, so these extras are ignored there.
  const extras = {
    status: await feature.getStatus(),
    hourly: {}
  }
  for (const tz of TZS) {
    extras.hourly[tz] = await handlers.hourly({ day: '2026-03-16', tz })
  }

  const capture = {
    schema: 'hl-usage-aggregates-v1',
    generator: 'scripts/usage-capture-aggregates.js',
    fixture_home: path.relative(WORKTREE, fixtureHome).split(path.sep).join('/'),
    captured_at: new Date().toISOString(),
    captures,
    extras
  }
  fs.writeFileSync(outputPath, `${JSON.stringify(capture, null, 2)}\n`, 'utf8')
  console.log(`USAGE CAPTURE OK entries=${captures.length} file=${outputPath}`)
  feature.quiesce()
  fs.rmSync(scratchRoot, { recursive: true, force: true })
  app.exit(0)
}

app.whenReady().then(() => main().catch((error) => {
  console.error(error?.stack || String(error))
  app.exit(1)
}))
