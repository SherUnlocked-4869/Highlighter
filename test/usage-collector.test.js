const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createUsageCollector } = require('../main/services/usage-collector')
const { openUsageStore } = require('../main/services/usage-store')
const tools = require('../main/services/usage-tools')
const { runScan: workerRunScan } = require('../main/usage-scan-worker')

const FIXTURE_HOME = path.join(__dirname, 'fixtures', 'usage', 'home')
const GOLDEN = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'usage', 'golden', 'queue-rows.json'), 'utf8')
).rows
const FIXED_NOW = () => new Date('2026-10-21T03:00:00.000Z')

function createHarness(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-usage-collector-'))
  const usageDir = path.join(root, 'usage')
  const store = openUsageStore({ dbPath: path.join(usageDir, 'usage.db'), now: FIXED_NOW })
  t.after(() => {
    try { store.close() } catch {}
    fs.rmSync(root, { recursive: true, force: true })
  })
  const progress = []
  const requests = []
  const results = []
  const behavior = {
    failSources: new Set(),
    hangSources: new Set(),
    ...overrides.behavior
  }
  const pendingCancellations = new Set()
  const workerClient = {
    scanTool: (request, options = {}) => {
      requests.push(request)
      if (behavior.hangSources.has(request.source)) {
        return new Promise((resolve, reject) => { pendingCancellations.add(reject) })
      }
      if (behavior.failSources.has(request.source)) return Promise.reject(new Error(`worker crashed on ${request.source}`))
      return workerRunScan({ ...request, onProgress: options.onProgress }).then((result) => {
        results.push({ source: request.source, upserts: result.upserts.length })
        return result
      })
    },
    cancel: () => {
      behavior.cancelled = true
      for (const reject of pendingCancellations) reject(new Error("usage scan cancelled (test)"))
      pendingCancellations.clear()
    },
    dispose: () => {}
  }
  const collector = createUsageCollector({
    getStore: () => store,
    getWorkerClient: () => workerClient,
    getSettings: () => ({ usage: { enabled: overrides.enabled !== false } }),
    getHomeContext: () => ({ homeDir: FIXTURE_HOME, explicitHome: true }),
    getUsageDir: () => usageDir,
    tools,
    log: () => {},
    now: FIXED_NOW,
    onProgress: (payload) => progress.push(payload),
    ...overrides.collector
  })
  t.after(() => collector.dispose())
  return { collector, store, progress, requests, results, behavior, usageDir }
}

async function waitForIdle(collector, timeoutMs = 15000) {
  const started = Date.now()
  while (collector.isScanning()) {
    if (Date.now() - started > timeoutMs) throw new Error('collector scan did not finish')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function dbRows(store) {
  return store.loadBucketRows().sort((a, b) => (a.source + a.model + a.hour_start).localeCompare(b.source + b.model + b.hour_start))
}

test('collector scans all three fixture tools in registry order and commits golden rows', async (t) => {
  const { collector, store, progress, requests } = createHarness(t)
  const result = await collector.refresh({ reason: 'manual' })
  assert.equal(result.started, true)
  await waitForIdle(collector)

  assert.deepEqual(requests.map((request) => request.source), ['codex', 'dsh', 'opencode'])
  assert.equal(requests.every((request) => typeof request.queuePath === 'string' && request.queuePath.endsWith('queue.jsonl')), true)
  assert.equal(requests.every((request) => request.cursors && typeof request.cursors.hourly === 'object'), true)

  const rows = dbRows(store)
  assert.equal(rows.length, GOLDEN.length)
  const keyOf = (row) => `${row.source}|${row.model}|${row.hour_start}`
  const goldenByKey = new Map(GOLDEN.map((row) => [keyOf(row), row]))
  for (const row of rows) {
    const expected = goldenByKey.get(keyOf(row))
    assert.ok(expected, `unexpected row ${keyOf(row)}`)
    assert.equal(row.billable_total_tokens, expected.billable_total_tokens)
    assert.equal(row.input_tokens, expected.input_tokens)
    assert.equal(row.cached_input_tokens, expected.cached_input_tokens)
    assert.equal(row.cache_creation_tokens, expected.cache_creation_input_tokens)
    assert.equal(row.output_tokens, expected.output_tokens)
    assert.equal(row.reasoning_tokens, expected.reasoning_output_tokens)
    assert.equal(row.total_tokens, expected.total_tokens)
    assert.equal(row.conversation_count, expected.conversation_count)
  }
  const statuses = store.listSourceStatus()
  assert.deepEqual(statuses.codex.state, 'ok')
  assert.deepEqual(statuses.dsh.state, 'ok')
  assert.deepEqual(statuses.opencode.state, 'ok')
  assert.ok(statuses.codex.files >= 3)

  const phases = progress.map((payload) => payload.phase)
  assert.equal(phases.includes('discovering'), true)
  assert.equal(phases.includes('scanning'), true)
  assert.equal(progress[progress.length - 1].done, true)
  const toolsSeen = new Set(progress.filter((payload) => payload.tool).map((payload) => payload.tool))
  assert.deepEqual([...toolsSeen].sort(), ['codex', 'dsh', 'opencode'])
})

test('collector second scan emits zero new buckets and keeps the same rows', async (t) => {
  const { collector, store, results } = createHarness(t)
  await collector.refresh({ reason: 'manual' })
  await waitForIdle(collector)
  const firstCount = store.countBuckets()
  assert.equal(firstCount, GOLDEN.length)
  assert.equal(results.length, 3)

  results.length = 0
  await collector.refresh({ reason: 'manual' })
  await waitForIdle(collector)
  assert.deepEqual(results.map((entry) => entry.source), ['codex', 'dsh', 'opencode'])
  assert.deepEqual(results.map((entry) => entry.upserts), [0, 0, 0])
  assert.equal(store.countBuckets(), firstCount)
  assert.equal(store.listSourceStatus().codex.state, 'ok')
})

test('collector crash recovery: a failing tool leaves its rows/cursors uncommitted and continues', async (t) => {
  const { collector, store, requests, behavior } = createHarness(t, {
    behavior: { failSources: new Set(['dsh']) }
  })
  await collector.refresh({ reason: 'manual' })
  await waitForIdle(collector)

  assert.deepEqual(requests.map((request) => request.source), ['codex', 'dsh', 'opencode'])
  const rows = dbRows(store)
  assert.equal(rows.filter((row) => row.source === 'codex').length, 4)
  assert.equal(rows.filter((row) => row.source === 'dsh').length, 0)
  assert.equal(rows.filter((row) => row.source === 'opencode').length, 4)
  const statuses = store.listSourceStatus()
  assert.equal(statuses.dsh.state, 'error')
  assert.match(statuses.dsh.lastError, /worker crashed on dsh/)
  assert.deepEqual(store.loadCursors('dsh'), {})
  assert.equal(store.getAppMeta('lastError'), 'worker crashed on dsh')
  behavior.cancelled = false
})

test('collector cancellation kills the worker and leaves the DB at the last commit', async (t) => {
  const { collector, store, behavior, progress } = createHarness(t, {
    behavior: { hangSources: new Set(['codex']) }
  })
  const started = await collector.refresh({ reason: 'manual' })
  assert.equal(started.started, true)
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(collector.isScanning(), true)
  const cancelResult = collector.cancel('user')
  assert.equal(cancelResult, true)
  assert.equal(behavior.cancelled, true)
  await waitForIdle(collector)
  assert.equal(collector.isScanning(), false)
  assert.equal(store.countBuckets(), 0)
  assert.equal(progress[progress.length - 1].done, true)
  assert.equal(progress[progress.length - 1].phase, 'cancelled')
  assert.equal(collector.cancel('again'), false)
})

test('collector page-open throttle is 5 minutes, manual refresh bypasses it', async (t) => {
  const { collector, store } = createHarness(t)
  const first = await collector.refresh({ reason: 'page-open' })
  assert.equal(first.started, true)
  await waitForIdle(collector)
  assert.ok(store.getAppMeta('lastScanAt'))

  const throttled = await collector.refresh({ reason: 'page-open' })
  assert.equal(throttled.started, false)
  assert.equal(throttled.throttled, true)

  const manual = await collector.refresh({ reason: 'manual' })
  assert.equal(manual.started, true)
  await waitForIdle(collector)
})

test('collector refuses to scan while the usage feature is disabled', async (t) => {
  const { collector, store, requests } = createHarness(t, { enabled: false })
  const result = await collector.refresh({ reason: 'manual' })
  assert.deepEqual(result, { started: false, reason: 'disabled' })
  assert.equal(collector.isScanning(), false)
  assert.equal(requests.length, 0)
  assert.equal(store.countBuckets(), 0)
})

test('collector reports an unreadable/error source instead of writing rows', async (t) => {
  const { collector, store, behavior } = createHarness(t, {
    behavior: { failSources: new Set(['codex', 'dsh', 'opencode']) }
  })
  await collector.refresh({ reason: 'manual' })
  await waitForIdle(collector)
  assert.equal(store.countBuckets(), 0)
  const statuses = store.listSourceStatus()
  for (const source of ['codex', 'dsh', 'opencode']) {
    assert.equal(statuses[source].state, 'error', source)
    assert.match(statuses[source].lastError, /worker crashed/)
  }
  behavior.cancelled = false
})
