const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { openUsageStore, BUCKET_INTEGER_COLUMNS } = require('../main/services/usage-store')

function createTempStore(t, { now = () => new Date('2026-10-21T03:00:00.000Z') } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-usage-store-'))
  const store = openUsageStore({ dbPath: path.join(dir, 'usage.db'), now })
  t.after(() => {
    try { store.close() } catch {}
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return { dir, store }
}

function queueRow(overrides = {}) {
  return {
    source: 'codex',
    model: 'gpt-5.4-codex',
    hour_start: '2026-03-14T01:00:00.000Z',
    input_tokens: 10,
    cached_input_tokens: 2,
    cache_creation_input_tokens: 1,
    output_tokens: 3,
    reasoning_output_tokens: 0,
    total_tokens: 16,
    billable_total_tokens: 16,
    conversation_count: 1,
    total_cost_usd: 0,
    ...overrides
  }
}

test('usage store creates the frozen v1 schema and commits a bucket with cursors/status', (t) => {
  const { store } = createTempStore(t)
  const result = store.commitScan({
    source: 'codex',
    upserts: [queueRow()],
    cursors: { files: { a: { offset: 10 } } },
    status: { state: 'ok', detected: true, readable: true, files: 1, lastScanAt: '2026-10-21T03:00:00.000Z' }
  })
  assert.equal(result.inserted, 1)
  assert.equal(store.countBuckets(), 1)

  const [row] = store.loadBucketRows(['codex'])
  assert.equal(row.source, 'codex')
  assert.equal(row.model, 'gpt-5.4-codex')
  assert.equal(row.cache_creation_tokens, 1)
  assert.equal(row.reasoning_tokens, 0)
  assert.equal(row.billable_total_tokens, 16)
  for (const column of BUCKET_INTEGER_COLUMNS) assert.equal(typeof row[column], 'number', column)

  assert.deepEqual(store.loadCursors('codex'), { files: { a: { offset: 10 } } })
  const status = store.listSourceStatus().codex
  assert.equal(status.state, 'ok')
  assert.equal(status.detected, true)
  assert.equal(status.readable, true)
  assert.equal(status.files, 1)
  assert.equal(status.lastScanAt, '2026-10-21T03:00:00.000Z')
  assert.equal(store.getCoverageStart('codex'), '2026-03-14T01:00:00.000Z')
})

test('usage store upserts the same bucket key as last-write-wins', (t) => {
  let current = new Date('2026-10-21T03:00:00.000Z')
  const { store } = createTempStore(t, { now: () => current })
  store.commitScan({ source: 'codex', upserts: [queueRow()] })
  current = new Date('2026-10-21T03:05:00.000Z')
  store.commitScan({ source: 'codex', upserts: [queueRow({ input_tokens: 99, total_tokens: 105, billable_total_tokens: 105 })] })
  assert.equal(store.countBuckets(), 1)
  const [row] = store.loadBucketRows()
  assert.equal(row.input_tokens, 99)
  assert.equal(row.billable_total_tokens, 105)
  assert.equal(row.updated_at, '2026-10-21T03:05:00.000Z')
})

test('usage store rolls the whole scan back when a row is invalid', (t) => {
  const { store } = createTempStore(t)
  store.commitScan({ source: 'codex', upserts: [queueRow()], cursors: { before: true } })
  assert.throws(
    () => store.commitScan({
      source: 'codex',
      upserts: [queueRow({ hour_start: '2026-03-14T02:00:00.000Z' }), queueRow({ hour_start: null })],
      cursors: { after: true }
    }),
    /invalid bucket row/
  )
  assert.equal(store.countBuckets(), 1)
  assert.deepEqual(store.loadCursors('codex'), { before: true })
  assert.equal(store.countBuckets(), 1)
})

test('usage store deletes rows removed by the parser and applies retention', (t) => {
  const { store } = createTempStore(t)
  store.commitScan({ source: 'codex', upserts: [queueRow(), queueRow({ hour_start: '2026-03-14T02:00:00.000Z' })] })
  store.commitScan({
    source: 'codex',
    upserts: [],
    removed: [{ source: 'codex', model: 'gpt-5.4-codex', hour_start: '2026-03-14T02:00:00.000Z' }]
  })
  assert.deepEqual(store.loadBucketRows().map((row) => row.hour_start), ['2026-03-14T01:00:00.000Z'])

  // 24-month retention: a 2020 bucket cannot survive a 2026 commit.
  store.commitScan({ source: 'codex', upserts: [queueRow({ hour_start: '2020-01-01T00:00:00.000Z' })] })
  assert.equal(store.loadBucketRows().filter((row) => row.hour_start.startsWith('2020')).length, 0)
  assert.equal(store.countBuckets(), 1)

  assert.equal(store.deleteOlderThan('2026-04-01T00:00:00.000Z'), 1)
  assert.equal(store.countBuckets(), 0)
})

test('usage store aggregates range sums and active days', (t) => {
  const { store } = createTempStore(t)
  store.commitScan({
    source: 'codex',
    upserts: [
      queueRow({ hour_start: '2026-10-01T01:00:00.000Z', input_tokens: 5, cached_input_tokens: 1, total_tokens: 9, billable_total_tokens: 9, conversation_count: 2 }),
      queueRow({ hour_start: '2026-10-01T02:00:00.000Z', model: 'gpt-5.4-mini', input_tokens: 7, cached_input_tokens: 0, total_tokens: 11, billable_total_tokens: 11, conversation_count: 3 }),
      queueRow({ hour_start: '2026-10-03T02:00:00.000Z', input_tokens: 100, total_tokens: 100, billable_total_tokens: 100, conversation_count: 1 })
    ]
  })
  const totals = store.sumRange({ fromIso: '2026-10-01T00:00:00.000Z', toIso: '2026-10-02T00:00:00.000Z' })
  assert.equal(totals.input_tokens, 12)
  assert.equal(totals.billable_total_tokens, 20)
  assert.equal(totals.conversation_count, 5)
  assert.equal(store.countDistinctDays({ fromIso: '2026-10-01T00:00:00.000Z', toIso: '2026-10-04T00:00:00.000Z' }), 2)
  assert.equal(store.getRangeRows({ fromIso: '2026-10-02T00:00:00.000Z' }).length, 1)
  assert.equal(store.getStats().buckets, 3)
  assert.ok(store.getStats().dbBytes > 0)
})

test('usage store survives close/reopen (WAL) and clears everything', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-usage-store-'))
  const dbPath = path.join(dir, 'usage.db')
  const first = openUsageStore({ dbPath })
  first.commitScan({ source: 'codex', upserts: [queueRow()], cursors: { offset: 1 } })
  first.setAppMeta('lastScanAt', '2026-10-21T00:00:00.000Z')
  first.close()
  assert.equal(first.isOpen(), false)

  const second = openUsageStore({ dbPath })
  t.after(() => {
    second.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  assert.equal(second.countBuckets(), 1)
  assert.deepEqual(second.loadCursors('codex'), { offset: 1 })
  assert.equal(second.getAppMeta('lastScanAt'), '2026-10-21T00:00:00.000Z')

  const cleared = second.clear()
  assert.equal(cleared.ok, true)
  assert.equal(second.countBuckets(), 0)
  assert.deepEqual(second.loadCursors('codex'), {})
  assert.equal(second.getAppMeta('lastScanAt'), null)
})

test('usage store ignores corrupt cursor JSON instead of throwing', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-usage-store-corrupt-'))
  const dbPath = path.join(dir, 'usage.db')
  const reopened = openUsageStore({ dbPath })
  t.after(() => {
    reopened.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  reopened.commitScan({ source: 'codex', upserts: [queueRow()], cursors: { ok: true } })
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(dbPath)
  try {
    db.prepare('UPDATE scan_state SET value = ? WHERE key = ?').run('{not-json', 'cursors:codex')
  } finally {
    db.close()
  }
  assert.deepEqual(reopened.loadCursors('codex'), {})
})
