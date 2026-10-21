// Headless end-to-end smoke for the usage scanner (B1/B2 verification).
//
// Runs a real Electron main process (no BrowserWindow is created), assembles the
// usage feature against the committed fixture home, triggers one scan, then
// prints the store status plus the four page-level payloads as JSON. The DB path
// is printed so `scripts/usage-oracle-check.js --hl-db <path>` can diff it
// against the TokenTracker golden baseline.
//
// Run from the repository root (the agent shell exports ELECTRON_RUN_AS_NODE=1,
// so it has to be unset; a normal dev shell does not need either workaround):
//   env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe --no-sandbox scripts/usage-scan-smoke.js
//
// Optional env: USAGE_SMOKE_HOME (fixture home), USAGE_SMOKE_TZ (IANA zone),
// USAGE_SMOKE_TIMEOUT_MS (scan wait, default 180000).
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { app } = require('electron')

app.disableHardwareAcceleration()

const WORKTREE = path.join(__dirname, '..')

function fail(message) {
  console.error(`USAGE SMOKE FAIL: ${message}`)
  app.exit(1)
}

async function waitForScan(feature, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastProgress = null
  while (Date.now() < deadline) {
    const status = await feature.getStatus()
    lastProgress = status?.scan || lastProgress
    if (!status?.scanning) return { status, lastProgress }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return { status: await feature.getStatus(), lastProgress, timedOut: true }
}

async function main() {
  const fixtureHome = path.resolve(process.env.USAGE_SMOKE_HOME || path.join(WORKTREE, 'test', 'fixtures', 'usage', 'home'))
  const timeZone = process.env.USAGE_SMOKE_TZ || 'Asia/Shanghai'
  const timeoutMs = Number(process.env.USAGE_SMOKE_TIMEOUT_MS) || 180000
  if (!fs.existsSync(fixtureHome)) throw new Error(`fixture home not found: ${fixtureHome}`)

  const scratchRoot = path.join(WORKTREE, '.tmp', `usage-smoke-${process.pid}-${Date.now()}`)
  const paths = { usage: path.join(scratchRoot, 'usage') }
  fs.mkdirSync(paths.usage, { recursive: true })

  const logLines = []
  const feature = require(path.join(WORKTREE, 'main', 'services', 'usage-feature')).createUsageFeature({
    app,
    getPaths: () => paths,
    getSettings: () => ({ usage: { enabled: true } }),
    getMainWindow: () => null,
    homeDir: fixtureHome,
    env: { ...process.env, HIGHLIGHTER_USAGE_HOME: fixtureHome },
    log: (...args) => logLines.push(args.map(String).join(' '))
  })

  const scanStarted = await feature.refresh({ reason: 'smoke' })
  const { status, lastProgress, timedOut } = await waitForScan(feature, timeoutMs)
  if (timedOut) throw new Error(`scan did not finish within ${timeoutMs}ms (last progress: ${JSON.stringify(lastProgress)})`)

  const query = { period: 'total', tz: timeZone }
  const handlers = feature.handlers || {}
  const summary = await handlers.summary(query)
  const daily = await handlers.daily(query)
  const breakdown = await handlers.breakdown({ ...query, scope: 'source' })
  const heatmap = await handlers.heatmap({ tz: timeZone })
  const dbPath = path.join(paths.usage, 'usage.db')
  let bucketRows = null
  try {
    const { DatabaseSync } = require('node:sqlite')
    const db = new DatabaseSync(dbPath, { readOnly: true })
    bucketRows = db.prepare('SELECT COUNT(*) AS rows, SUM(billable_total_tokens) AS billable FROM usage_bucket').get()
    db.close()
  } catch (error) {
    bucketRows = { error: error?.message || String(error) }
  }
  const report = {
    ok: status.scanning === false && !status.lastError,
    fixtureHome,
    dbPath,
    scanStarted,
    bucketRows,
    status,
    summary: summary && { totals: summary.totals, rolling: summary.rolling, from: summary.from, to: summary.to },
    dailyRows: daily?.rows?.length || 0,
    dailyNonZero: (daily?.rows || []).filter((row) => row.billable_total_tokens > 0).length,
    sources: (breakdown?.sources || []).map((row) => ({ source: row.source, billable: row.billable_total_tokens })),
    models: (breakdown?.models || []).length,
    heatmapWeeks: heatmap?.weeks?.length || 0,
    heatmapActiveDays: heatmap?.activeDays || 0,
    logLines: logLines.slice(-20)
  }
  console.log(JSON.stringify(report, null, 2))
  console.log(`USAGE SMOKE OK db=${dbPath}`)
  feature.quiesce()
  if (process.env.USAGE_SMOKE_KEEP === '1') console.log(`USAGE SMOKE KEPT dataRoot=${scratchRoot}`)
  else fs.rmSync(scratchRoot, { recursive: true, force: true })
  app.exit(0)
}

app.whenReady().then(() => main().catch((error) => {
  console.error(error?.stack || String(error))
  fail(error?.message || String(error))
}))
