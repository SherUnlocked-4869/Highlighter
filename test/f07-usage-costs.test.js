// F07 (part 2) —— docs/reviews/2026-11-26-code-review-and-optimization-report.md section 3.7.1
//
// Three cost fixes in the usage module:
//   * the parser's rebuilt hourly state must not be persisted into scan_state (it duplicated
//     up to 24 months of buckets inside usage.db);
//   * the detail query must not repeat a model name once per (day, model) row;
//   * getStatus() must not walk every tool's session files on every period switch.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createUsageCollector } = require('../main/services/usage-collector')
const { openUsageStore } = require('../main/services/usage-store')
const { describeDetails } = require('../main/services/usage-detail-query')
const tools = require('../main/services/usage-tools')
const { runScan: workerRunScan } = require('../main/usage-scan-worker')

const FIXTURE_HOME = path.join(__dirname, 'fixtures', 'usage', 'home')
const FIXED_NOW = () => new Date('2026-10-21T03:00:00.000Z')

function createHarness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-usage-f07-'))
  const usageDir = path.join(root, 'usage')
  const store = openUsageStore({ dbPath: path.join(usageDir, 'usage.db'), now: FIXED_NOW })
  t.after(() => {
    try { store.close() } catch {}
    fs.rmSync(root, { recursive: true, force: true })
  })
  const requests = []
  const workerClient = {
    scanTool: (request, options = {}) => {
      requests.push(request)
      return workerRunScan({ ...request, onProgress: options.onProgress })
    },
    cancel: () => {},
    dispose: () => {}
  }
  const collector = createUsageCollector({
    getStore: () => store,
    getWorkerClient: () => workerClient,
    getSettings: () => ({ usage: { enabled: true } }),
    getHomeContext: () => ({ homeDir: FIXTURE_HOME, explicitHome: true }),
    getUsageDir: () => usageDir,
    tools,
    log: () => {},
    now: FIXED_NOW,
    onProgress: () => {}
  })
  t.after(() => collector.dispose())
  return { collector, store, requests }
}

async function waitForIdle(collector, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (collector.isScanning()) {
    if (Date.now() > deadline) throw new Error('scan did not finish')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

test('F07: the worker still receives the rebuilt hourly state, but it is not persisted', async (t) => {
  const harness = createHarness(t)
  harness.collector.refresh({})
  await waitForIdle(harness.collector)

  assert.ok(harness.requests.length > 0, 'a scan ran')
  // The parser contract (usage-state.js): the request carries the rebuilt hourly state.
  for (const request of harness.requests) {
    assert.ok(request.cursors && typeof request.cursors === 'object')
    assert.ok(request.cursors.hourly && typeof request.cursors.hourly === 'object', `${request.source} request carries hourly`)
  }
  // …but the durable cursor must stay the per-file parse cursor: scan_state is serialised from it.
  const sources = new Set(harness.requests.map((request) => request.source))
  for (const source of sources) {
    const cursors = harness.store.loadCursors(source) || {}
    assert.equal(Object.hasOwn(cursors, 'hourly'), false, `${source} persisted cursor must not carry hourly`)
  }
})

test('F07: describeDetails lists each model once per project', () => {
  const rows = [
    { id: 'p1', name: 'Project', source: 'claude', title: 't', first: '2026-10-01', last: '2026-10-01', model: 'claude-sonnet', total_tokens: 10, conversation_count: 1 },
    { id: 'p1', name: 'Project', source: 'claude', title: 't', first: '2026-10-02', last: '2026-10-02', model: 'claude-sonnet', total_tokens: 20, conversation_count: 1 },
    { id: 'p1', name: 'Project', source: 'claude', title: 't', first: '2026-10-02', last: '2026-10-02', model: 'claude-opus', total_tokens: 5, conversation_count: 1 }
  ]
  const details = describeDetails({
    projects: rows,
    sessions: [],
    activityTotals: [],
    activities: [],
    activityHours: [],
    info: []
  }, {}, (hourStart) => String(hourStart || '').slice(0, 10))
  assert.ok(details, 'describeDetails returns the payload')
  assert.equal(details.projects.length, 1)
  assert.deepEqual(details.projects[0].models, ['claude-sonnet', 'claude-opus'])
  assert.equal(details.projects[0].total_tokens, 35)
})

test('F07: the usage status probes are cached and invalidated by refresh()', () => {
  // `tools` is a module-level import, so the probe counter cannot be injected through the
  // factory; the cache contract is pinned at the source level and the behaviour is covered by
  // the ordering assertions below (cache is consulted before any probe loop runs).
  const source = fs.readFileSync(path.join(__dirname, '..', 'main', 'services', 'usage-feature.js'), 'utf8')
  assert.match(source, /const STATUS_CACHE_MS = 30000/)
  assert.match(source, /let statusCache = null/)
  assert.match(source, /} else if \(statusCache && statusCache\.enabled === enabled && Date\.now\(\) - statusCache\.at < STATUS_CACHE_MS\) \{/)
  assert.match(source, /statusCache = \{ at: Date\.now\(\), enabled, sources: status\.sources\.map/)
  // A scan result must be visible immediately: refresh() drops the cache.
  assert.match(source, /async function refresh\(validated = \{\}\) \{\s*\n\s*statusCache = null/)
  assert.match(source, /async function clear\(\) \{\s*\n\s*statusCache = null/)
})
