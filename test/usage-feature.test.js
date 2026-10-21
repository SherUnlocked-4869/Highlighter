const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { install, heatmapLevel } = require('../main/services/usage-feature')
const { runScan: workerRunScan } = require('../main/usage-scan-worker')
const { setActiveUsageFeature } = require('../main/services/usage-runtime')

const FIXTURE_HOME = path.join(__dirname, 'fixtures', 'usage', 'home')
const GOLDEN = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'usage', 'golden', 'queue-rows.json'), 'utf8')
).rows

const FIXED_NOW = new Date('2026-10-21T03:00:00.000Z') // Oct 21 11:00 Asia/Shanghai

function createHarness(t, { enabled = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-usage-feature-'))
  const usageDir = path.join(root, 'usage')
  const fakeHome = path.join(root, 'fake-home')
  fs.mkdirSync(fakeHome, { recursive: true })
  const ipcHandlers = new Map()
  const ipcMain = {
    handle: (channel, handler) => {
      if (ipcHandlers.has(channel)) throw new Error(`duplicate channel: ${channel}`)
      ipcHandlers.set(channel, handler)
    }
  }
  const previousHome = process.env.HIGHLIGHTER_USAGE_HOME
  process.env.HIGHLIGHTER_USAGE_HOME = FIXTURE_HOME
  const workerClient = {
    scanTool: (request, options = {}) => workerRunScan({ ...request, onProgress: options.onProgress }),
    getDiagnostics: () => ({ forkCount: 0 }),
    dispose: () => {}
  }
  const feature = install({
    ipcMain,
    app: { getPath: (name) => (name === 'home' ? fakeHome : root) },
    getPaths: () => ({ usage: usageDir }),
    getMainWindow: () => null,
    getSettings: () => ({ usage: { enabled } }),
    log: () => {},
    workerClient,
    now: () => FIXED_NOW
  })
  t.after(() => {
    feature.quiesce()
    setActiveUsageFeature(null)
    if (previousHome === undefined) delete process.env.HIGHLIGHTER_USAGE_HOME
    else process.env.HIGHLIGHTER_USAGE_HOME = previousHome
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { feature, ipcHandlers, usageDir, root }
}

async function waitForIdle(feature, timeoutMs = 10000) {
  const started = Date.now()
  while (feature.getDiagnostics().scanning) {
    if (Date.now() - started > timeoutMs) throw new Error('scan did not finish')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('feature install registers the frozen channels and reports disabled status without scanning', async (t) => {
  const { feature, ipcHandlers } = createHarness(t, { enabled: false })
  assert.deepEqual([...ipcHandlers.keys()].sort(), [
    'usage:breakdown',
    'usage:clear',
    'usage:daily',
    'usage:heatmap',
    'usage:hourly',
    'usage:refresh',
    'usage:status',
    'usage:summary'
  ])
  const status = await ipcHandlers.get('usage:status')(null)
  assert.equal(status.enabled, false)
  assert.equal(status.scanning, false)
  assert.equal(status.sources.some((source) => source.source === 'cursor' && source.state === 'unsupported'), true)
  const refresh = await ipcHandlers.get('usage:refresh')(null, { reason: 'manual' })
  assert.equal(refresh.started, false)
  assert.equal(refresh.reason, 'disabled')
  assert.equal(feature.getDiagnostics().scanning, false)
})

test('feature scans the fixture home through the worker and matches the codex golden slice', async (t) => {
  const { feature, ipcHandlers, usageDir } = createHarness(t)
  const refresh = await ipcHandlers.get('usage:refresh')(null, { reason: 'page-open' })
  assert.equal(refresh.started, true)
  await waitForIdle(feature)

  const status = await ipcHandlers.get('usage:status')(null)
  assert.equal(status.enabled, true)
  assert.equal(status.scanning, false)
  assert.equal(status.lastScanAt, FIXED_NOW.toISOString())
  assert.ok(status.dbBytes > 0)
  const codex = status.sources.find((source) => source.source === 'codex')
  assert.equal(codex.state, 'ok')
  assert.equal(codex.detected, true)
  assert.equal(codex.readable, true)
  assert.equal(codex.files, 3)
  assert.equal(codex.coverageStartAt, '2026-03-14T00:00:00.000Z')

  // Committed bucket rows must equal the TokenTracker golden rows (3 tools).
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(path.join(usageDir, 'usage.db'), { readOnly: true })
  const rows = db.prepare('SELECT * FROM usage_bucket ORDER BY source, hour_start, model').all()
  db.close()
  assert.equal(rows.length, GOLDEN.length)
  const keyOf = (row) => `${row.source}|${row.model}|${row.hour_start}`
  const goldenByKey = new Map(GOLDEN.map((row) => [keyOf(row), row]))
  for (const row of rows) {
    const expected = goldenByKey.get(keyOf(row))
    assert.ok(expected, `unexpected bucket ${keyOf(row)}`)
    assert.equal(row.input_tokens, expected.input_tokens)
    assert.equal(row.cached_input_tokens, expected.cached_input_tokens)
    assert.equal(row.cache_creation_tokens, expected.cache_creation_input_tokens)
    assert.equal(row.output_tokens, expected.output_tokens)
    assert.equal(row.reasoning_tokens, expected.reasoning_output_tokens)
    assert.equal(row.total_tokens, expected.total_tokens)
    assert.equal(row.billable_total_tokens, expected.billable_total_tokens)
    assert.equal(row.conversation_count, expected.conversation_count)
  }
})

test('feature summary/daily/hourly/breakdown/heatmap honor local day ranges', async (t) => {
  const { feature, ipcHandlers } = createHarness(t)
  await ipcHandlers.get('usage:refresh')(null, { reason: 'manual' })
  await waitForIdle(feature)

  const total = await ipcHandlers.get('usage:summary')(null, { period: 'total', tz: 'Asia/Shanghai' })
  const goldenBillable = GOLDEN.reduce((sum, row) => sum + row.billable_total_tokens, 0)
  assert.equal(total.period, 'total')
  assert.equal(total.from, '2024-11-01')
  assert.equal(total.to, '2026-10-21')
  assert.equal(total.totals.billable_total_tokens, goldenBillable)
  assert.equal(total.totals.conversation_count, 12)
  assert.equal(total.totals.total_cost_usd, null)
  assert.deepEqual(total.pricing, { mode: 'none', version: null })
  assert.equal(total.rolling.avgPerActiveDay, 0, 'fixture data is outside the rolling 30-day window')
  assert.equal(total.rolling.activeDays, 0)

  const daily = await ipcHandlers.get('usage:daily')(null, { period: 'custom', tz: 'UTC', from: '2026-03-14', to: '2026-03-16' })
  assert.deepEqual(daily.rows.map((row) => row.day), ['2026-03-14', '2026-03-15', '2026-03-16'])
  assert.equal(daily.rows[0].billable_total_tokens, 34840)
  assert.equal(daily.rows[2].billable_total_tokens, 2100)

  const future = await ipcHandlers.get('usage:daily')(null, { period: 'custom', tz: 'UTC', from: '2026-10-01', to: '2026-10-31' })
  assert.equal(future.rows.length, 21, 'no fabricated future days after today')
  assert.equal(future.rows[future.rows.length - 1].day, '2026-10-21')

  const hourly = await ipcHandlers.get('usage:hourly')(null, { day: '2026-03-14', tz: 'UTC' })
  assert.equal(hourly.rows.length, 24)
  assert.equal(hourly.rows[1].billable_total_tokens > 0, true)
  assert.equal(hourly.from, '2026-03-14T00:00:00.000Z')
  assert.equal(hourly.to, '2026-03-15T00:00:00.000Z')

  const breakdown = await ipcHandlers.get('usage:breakdown')(null, { period: 'custom', tz: 'UTC', from: '2026-03-14', to: '2026-03-16', scope: 'source' })
  assert.deepEqual(breakdown.sources.map((source) => source.source).sort(), ['codex', 'dsh', 'opencode'])
  assert.equal(breakdown.sources.reduce((sum, source) => sum + source.billable_total_tokens, 0), goldenBillable)
  assert.equal(breakdown.sources.reduce((sum, source) => sum + source.sharePct, 0), 100)
  assert.equal(breakdown.models.length, 8)
  assert.equal(breakdown.models.reduce((sum, model) => sum + model.billable_total_tokens, 0), goldenBillable)

  const heatmap = await ipcHandlers.get('usage:heatmap')(null, { tz: 'UTC', weeks: 52 })
  assert.equal(heatmap.weeks.length, 52)
  assert.equal(heatmap.weeks.every((week) => week.length === 7), true)
  assert.equal(heatmap.from, '2025-10-27', 'grid starts on a Monday')
  assert.equal(heatmap.to, '2026-10-25', 'last column ends on the current week Sunday')
  assert.equal(heatmap.activeDays, 3)
  assert.equal(heatmap.max, 34840)
  const futureCell = heatmap.weeks[51][5] // Saturday of the current week
  assert.equal(futureCell, null)
  const activeCell = heatmap.weeks.flat().find((cell) => cell && cell.day === '2026-03-14')
  assert.equal(activeCell.level, 4)
  assert.equal(heatmapLevel(0, 100), 0)
  assert.equal(heatmapLevel(10, 100), 1)
  assert.equal(heatmapLevel(50, 100), 2)
  assert.equal(heatmapLevel(75, 100), 3)
  assert.equal(heatmapLevel(76, 100), 4)
})

test('feature refresh is single-flight and clear removes all data', async (t) => {
  const { feature, ipcHandlers, usageDir } = createHarness(t)
  const first = await ipcHandlers.get('usage:refresh')(null, { reason: 'manual' })
  assert.equal(first.started, true)
  const second = await ipcHandlers.get('usage:refresh')(null, { reason: 'manual' })
  assert.equal(second.started, false)
  assert.equal(second.scanId, first.scanId)
  await waitForIdle(feature)
  assert.ok(fs.existsSync(path.join(usageDir, 'usage.db')))

  const cleared = await ipcHandlers.get('usage:clear')(null)
  assert.equal(cleared.ok, true)
  const status = await ipcHandlers.get('usage:status')(null)
  assert.equal(status.dbBytes > 0, true, 'clear recreates an empty database')
  const total = await ipcHandlers.get('usage:summary')(null, { period: 'total', tz: 'UTC' })
  assert.equal(total.totals.billable_total_tokens, 0)
})

test('feature quiesce closes the store and resume is lazy', async (t) => {
  const { feature, ipcHandlers } = createHarness(t)
  await ipcHandlers.get('usage:refresh')(null, { reason: 'manual' })
  await waitForIdle(feature)
  assert.equal(feature.getDiagnostics().storeOpen, true)
  feature.quiesce()
  assert.equal(feature.getDiagnostics().storeOpen, false)
  feature.resume()
  const status = await ipcHandlers.get('usage:status')(null)
  assert.equal(status.enabled, true)
  assert.equal(feature.getDiagnostics().storeOpen, true)
})
