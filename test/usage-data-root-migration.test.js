// B6 integration tests for the usage SQLite database across the data-root
// lifecycle (plan §2.9 G3, §2.5 retention/clear, §1.4 DoD 6/9).
//
// The data-root domain quiesces the usage feature before migrating:
//   stopManagedDataWriters() -> getActiveUsageFeature()?.quiesce()
// which must checkpoint the WAL and close the DB so the migration copies a
// consistent file set. These tests exercise that exact integration point plus
// the retention/clear and diagnostics privacy guarantees that have no other
// coverage. Product files are Lead-owned; the data-root copy gap these tests
// originally documented as a repro is now fixed in `data-root-migration.js`
// (usage dir is part of the managed source + persistent copy group), so the
// migration test below is a hard regression instead of a todo.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const { createDataPaths, ensureDataLayout } = require('../main/services/data-root')
const {
  createManagedSourcePaths,
  migrateDataRoot
} = require('../main/services/data-root-migration')
const { getActiveUsageFeature, setActiveUsageFeature } = require('../main/services/usage-runtime')
const { openUsageStore, RETENTION_MONTHS } = require('../main/services/usage-store')
const { createUsageFeature } = require('../main/services/usage-feature')

async function temporaryRoot(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'hl-usage-dataroot-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  return root
}

function exists(target) {
  return fs.promises.access(target).then(() => true, () => false)
}

function queueRow(overrides = {}) {
  return {
    source: 'codex',
    model: 'gpt-5.4-codex',
    hour_start: '2026-03-14T01:00:00.000Z',
    input_tokens: 7000,
    cached_input_tokens: 9000,
    cache_creation_input_tokens: 0,
    output_tokens: 550,
    reasoning_output_tokens: 150,
    total_tokens: 16550,
    billable_total_tokens: 16550,
    conversation_count: 2,
    total_cost_usd: 0,
    ...overrides
  }
}

// Creates a managed source data root with a real WAL usage DB (2 bucket rows,
// cursor state + scan metadata) and a small amount of other managed data.
async function createManagedUsageSource(parent) {
  const sourceRoot = path.join(parent, 'source-root')
  const layout = createDataPaths(sourceRoot)
  await ensureDataLayout(layout)
  const source = createManagedSourcePaths(sourceRoot)
  await fsp.writeFile(source.logFile, 'log line\n')
  await fsp.writeFile(path.join(source.history, 'one.png'), 'png-bytes')
  const store = openUsageStore({ dbPath: path.join(layout.usage, 'usage.db') })
  store.commitScan({
    source: 'codex',
    upserts: [
      queueRow(),
      queueRow({ hour_start: '2026-03-14T01:30:00.000Z', model: 'gpt-5.4-mini', billable_total_tokens: 4200 })
    ],
    cursors: { files: { 'rollout-a.jsonl': { offset: 128 } } },
    status: { state: 'ok', detected: true, readable: true, files: 1, lastScanAt: '2026-10-21T03:00:00.000Z' }
  })
  store.setAppMeta('lastScanAt', '2026-10-21T03:00:00.000Z')
  store.commitScan({
    source: 'codex',
    upserts: [queueRow({ hour_start: '2025-01-01T00:00:00.000Z', billable_total_tokens: 111 })]
  })
  return { sourceRoot, layout, source, store }
}

async function readUsageRows(dbPath) {
  const store = openUsageStore({ dbPath })
  try {
    return {
      rows: store.loadBucketRows().map((row) => `${row.source}|${row.model}|${row.hour_start}`).sort(),
      cursors: store.loadCursors('codex'),
      lastScanAt: store.getAppMeta('lastScanAt')
    }
  } finally {
    store.close()
  }
}

test('managed source paths include the usage directory (data-root migration scope guard)', async (t) => {
  const parent = await temporaryRoot(t)
  const paths = createManagedSourcePaths(path.join(parent, 'managed-root'))
  const layout = createDataPaths(path.join(parent, 'managed-root'))
  assert.equal(layout.usage, path.join(path.join(parent, 'managed-root'), 'usage'))
  assert.equal(paths.usage, layout.usage,
    'createManagedSourcePaths must expose usage so the migration copy loop can include it')
  assert.equal(paths.cleanupDirectories.includes(layout.usage), true,
    'usage must stay in MANAGED_DIRECTORIES; otherwise a failed migration/cleanup leaves or drops it')
})

test('data-root quiesce checkpoint leaves a consistent usage DB (no stale WAL/SHM)', async (t) => {
  const parent = await temporaryRoot(t)
  const { layout, store } = await createManagedUsageSource(parent)
  const dbPath = path.join(layout.usage, 'usage.db')
  assert.equal(fs.existsSync(dbPath), true)
  assert.equal(fs.existsSync(`${dbPath}-wal`), true, 'commit ran in WAL mode')
  assert.equal(store.loadBucketRows().length, 3)

  // This is the exact call the data-root domain makes before migrating.
  const fakeFeature = {
    quiesce: async () => store.close(),
    resume: async () => {}
  }
  setActiveUsageFeature(fakeFeature)
  t.after(() => setActiveUsageFeature(null))
  await getActiveUsageFeature()?.quiesce?.()

  assert.equal(fs.existsSync(dbPath), true)
  assert.equal(fs.existsSync(`${dbPath}-wal`), false, 'checkpoint(TRUNCATE) removed the WAL sidecar')
  assert.equal(fs.existsSync(`${dbPath}-shm`), false, 'checkpoint removed the SHM sidecar')

  const readBack = await readUsageRows(dbPath)
  assert.equal(readBack.rows.length, 3)
  assert.deepEqual(readBack.cursors, { files: { 'rollout-a.jsonl': { offset: 128 } } })
  assert.equal(readBack.lastScanAt, '2026-10-21T03:00:00.000Z')
})

test('data-root migration carries the usage SQLite DB and scan state', async (t) => {
  const parent = await temporaryRoot(t)
  const sourceRoot = path.join(parent, 'source-root')
  const targetRoot = path.join(parent, 'target-root')
  const portableDirectory = path.join(parent, 'portable')
  await fsp.mkdir(portableDirectory, { recursive: true })
  const { layout, source, store } = await createManagedUsageSource(parent)
  await store.close()
  await fsp.writeFile(source.configFile, JSON.stringify({ screenshot: { dir: source.history } }, null, 2))
  const before = await readUsageRows(path.join(layout.usage, 'usage.db'))
  assert.equal(before.rows.length, 3)

  await migrateDataRoot({
    source,
    target: createDataPaths(targetRoot),
    portableDirectory,
    previousRoot: ''
  })

  const targetDb = path.join(targetRoot, 'usage', 'usage.db')
  assert.equal(fs.existsSync(targetDb), true, 'target usage/usage.db must exist after migration')
  const after = await readUsageRows(targetDb)
  assert.deepEqual(after.rows, before.rows)
  assert.deepEqual(after.cursors, before.cursors)
  assert.equal(after.lastScanAt, before.lastScanAt)
  // The source root is kept intact until the restart/finalization path.
  assert.equal(fs.existsSync(path.join(layout.usage, 'usage.db')), true)
})

test('data-root migration failure removes the target usage directory and keeps the source DB', async (t) => {
  const parent = await temporaryRoot(t)
  const sourceRoot = path.join(parent, 'source-root')
  const targetRoot = path.join(parent, 'target-root')
  const portableDirectory = path.join(parent, 'portable')
  await fsp.mkdir(portableDirectory, { recursive: true })
  const { layout, source, store } = await createManagedUsageSource(parent)
  store.close()
  await fsp.writeFile(source.configFile, '{}')

  await assert.rejects(migrateDataRoot({
    source,
    target: createDataPaths(targetRoot),
    portableDirectory,
    copyFile: async () => {
      throw new Error('injected copy failure')
    }
  }), /injected copy failure/)

  assert.equal(fs.existsSync(path.join(layout.usage, 'usage.db')), true, 'source usage DB untouched')
  assert.equal(fs.existsSync(path.join(targetRoot, 'usage', 'usage.db')), false)
  assert.deepEqual(fs.readdirSync(targetRoot), [], 'failed migration cleaned every created managed directory')
  const readBack = await readUsageRows(path.join(layout.usage, 'usage.db'))
  assert.equal(readBack.rows.length, 3)
})

test('store retention removes only buckets older than the 24-month cutoff', async (t) => {
  const parent = await temporaryRoot(t)
  const layout = createDataPaths(path.join(parent, 'retention-root'))
  // Fixed clock keeps commit-time retention from pruning the synthetic rows, so
  // the explicit deleteOlderThan() call is what the assertion measures.
  const store = openUsageStore({
    dbPath: path.join(layout.usage, 'usage.db'),
    now: () => new Date('2024-12-15T00:00:00.000Z')
  })
  t.after(() => {
    try { store.close() } catch {}
  })
  store.commitScan({
    source: 'codex',
    upserts: [
      queueRow({ hour_start: '2023-01-01T00:00:00.000Z' }),
      queueRow({ hour_start: '2024-12-01T00:00:00.000Z' }),
      queueRow({ hour_start: '2026-03-14T01:00:00.000Z' })
    ]
  })
  assert.equal(store.countBuckets(), 3)
  assert.equal(store.deleteOlderThan('2025-01-01T00:00:00.000Z'), 2)
  assert.equal(store.countBuckets(), 1)
  assert.deepEqual(store.loadBucketRows().map((row) => row.hour_start), ['2026-03-14T01:00:00.000Z'])
  assert.equal(RETENTION_MONTHS, 24)
  // Close before the temp-root cleanup hook runs (it is registered first, so the
  // SQLite sidecars must already be released here).
  store.close()
})

test('store clear empties buckets/cursors/status but keeps the v1 schema usable', async (t) => {
  const parent = await temporaryRoot(t)
  const dbPath = path.join(createDataPaths(path.join(parent, 'clear-root')).usage, 'usage.db')
  const store = openUsageStore({ dbPath })
  store.commitScan({ source: 'codex', upserts: [queueRow()], cursors: { files: { a: { offset: 1 } } } })
  store.setAppMeta('lastScanAt', '2026-03-14T01:00:00.000Z')
  assert.equal(store.countBuckets(), 1)

  const cleared = store.clear()
  assert.equal(cleared.ok, true)
  assert.equal(store.countBuckets(), 0)
  assert.deepEqual(store.loadCursors('codex'), {})
  assert.deepEqual(store.listSourceStatus(), {})
  assert.equal(store.getAppMeta('lastScanAt'), null)
  // Schema is kept: a new scan can commit into the same DB immediately.
  store.commitScan({ source: 'codex', upserts: [queueRow({ billable_total_tokens: 77 })] })
  assert.equal(store.countBuckets(), 1)
  store.close()

  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1)
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name)
    for (const table of ['app_meta', 'scan_state', 'source_status', 'usage_bucket']) {
      assert.equal(tables.includes(table), true, `${table} survives clear`)
    }
  } finally {
    db.close()
  }
})

test('feature diagnostics expose no user paths or prompt-like content', async (t) => {
  const parent = await temporaryRoot(t)
  const confidentialHome = path.join(parent, 'Users', 'secret-person', 'private-home')
  const feature = createUsageFeature({
    app: { getPath: (name) => (name === 'home' ? confidentialHome : path.join(parent, 'appdata')) },
    getPaths: () => createDataPaths(path.join(parent, 'app-root')),
    getSettings: () => ({ usage: { enabled: false } }),
    getMainWindow: () => null,
    homeDir: null,
    env: { HIGHLIGHTER_USAGE_HOME: confidentialHome },
    log: () => {}
  })
  t.after(() => feature.quiesce())
  const diagnostics = feature.getDiagnostics()
  const serialized = JSON.stringify(diagnostics)
  assert.equal(serialized.includes('secret-person'), false, 'no scanned home path')
  assert.equal(serialized.includes('private-home'), false, 'no scanned home path')
  assert.equal(serialized.includes('C:\\Users\\24532'), false, 'no real user profile path')
  assert.deepEqual(Object.keys(diagnostics).sort(), [
    'lastError',
    'queryCache',
    'scan',
    'scanning',
    'storeOpen',
    'worker'
  ])
  assert.equal(diagnostics.lastError, null)
  assert.equal(diagnostics.scan, null)
})
