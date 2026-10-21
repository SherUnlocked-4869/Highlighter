const test = require('node:test')
const assert = require('node:assert/strict')

const {
  bucketKeyForRow,
  bucketRowToTotals,
  buildHourlyState,
  diffRemovedBuckets,
  diffRemovedKeys,
  isZeroTotals,
  normalizeQueueRow,
  rowsToKnownBuckets
} = require('../main/services/usage-state')
const { bucketKey, totalsKey } = require('../main/vendor/tokentracker/rollout')

function bucketRow(overrides = {}) {
  return {
    source: 'codex',
    model: 'gpt-5.4-codex',
    hour_start: '2026-03-14T01:00:00.000Z',
    input_tokens: 7000,
    cached_input_tokens: 9000,
    cache_creation_tokens: 0,
    output_tokens: 550,
    reasoning_tokens: 150,
    total_tokens: 16550,
    billable_total_tokens: 16550,
    conversation_count: 2,
    total_cost_usd: 0,
    usage_precision: null,
    ...overrides
  }
}

test('normalizeQueueRow maps parser queue columns to usage_bucket columns', () => {
  const row = normalizeQueueRow({
    source: ' codex ',
    model: ' gpt-5.4-codex ',
    hour_start: '2026-03-14T01:00:00.000Z',
    input_tokens: 1.9,
    cached_input_tokens: '2',
    cache_creation_input_tokens: 3,
    output_tokens: 4,
    reasoning_output_tokens: 5,
    total_tokens: 6,
    billable_total_tokens: 7,
    conversation_count: 8,
    usage_precision: 'estimated',
    total_cost_usd: 0.25
  })
  assert.deepEqual(row, {
    source: 'codex',
    model: 'gpt-5.4-codex',
    hour_start: '2026-03-14T01:00:00.000Z',
    input_tokens: 1,
    cached_input_tokens: 2,
    cache_creation_tokens: 3,
    output_tokens: 4,
    reasoning_tokens: 5,
    total_tokens: 6,
    billable_total_tokens: 7,
    conversation_count: 8,
    usage_precision: 'estimated'
  })
  assert.equal(normalizeQueueRow(null), null)
  assert.equal(normalizeQueueRow({ source: 'codex', model: '', hour_start: 'x' }), null)
})

test('bucketRowToTotals restores the parser token vocabulary', () => {
  assert.deepEqual(bucketRowToTotals(bucketRow()), {
    input_tokens: 7000,
    cached_input_tokens: 9000,
    cache_creation_input_tokens: 0,
    output_tokens: 550,
    reasoning_output_tokens: 150,
    total_tokens: 16550,
    billable_total_tokens: 16550,
    total_cost_usd: 0,
    conversation_count: 2
  })
  assert.equal(bucketRowToTotals(bucketRow({ usage_precision: 'estimated' })).usage_precision, 'estimated')
})

test('buildHourlyState restores the vendored parser state shape', () => {
  const row = bucketRow()
  const state = buildHourlyState([row])
  assert.equal(state.version, 1)
  assert.deepEqual(state.groupQueued, {})
  const key = bucketKey('codex', 'gpt-5.4-codex', '2026-03-14T01:00:00.000Z')
  const bucket = state.buckets[key]
  assert.ok(bucket, 'bucket key matches the vendored bucketKey format')
  assert.equal(bucket.source, 'codex')
  assert.equal(bucket.model, 'gpt-5.4-codex')
  assert.equal(bucket.hour_start, '2026-03-14T01:00:00.000Z')
  assert.equal(bucket.queuedKey, totalsKey(bucket.totals))
  assert.equal(bucket.totals.billable_total_tokens, 16550)
  assert.equal(bucketKeyForRow(row), key)
})

test('buildHourlyState skips malformed rows and tolerates non-arrays', () => {
  assert.deepEqual(buildHourlyState(null), { version: 1, buckets: {}, groupQueued: {} })
  const state = buildHourlyState([null, {}, { source: 'codex', model: 'm' }, bucketRow()])
  assert.equal(Object.keys(state.buckets).length, 1)
})

test('diffRemovedBuckets reports vanished and zeroed buckets only', () => {
  const kept = bucketRow()
  const vanished = bucketRow({ hour_start: '2026-03-14T02:00:00.000Z' })
  const zeroed = bucketRow({ hour_start: '2026-03-14T03:00:00.000Z' })
  const state = buildHourlyState([kept])
  state.buckets[bucketKey('codex', 'gpt-5.4-codex', '2026-03-14T03:00:00.000Z')] = {
    totals: bucketRowToTotals({ ...zeroed, input_tokens: 0, cached_input_tokens: 0, cache_creation_tokens: 0, output_tokens: 0, reasoning_tokens: 0, total_tokens: 0, billable_total_tokens: 0, conversation_count: 0 })
  }
  const removed = diffRemovedBuckets([kept, vanished, zeroed], state)
  assert.deepEqual(removed, [
    { source: 'codex', model: 'gpt-5.4-codex', hour_start: '2026-03-14T02:00:00.000Z' },
    { source: 'codex', model: 'gpt-5.4-codex', hour_start: '2026-03-14T03:00:00.000Z' }
  ])
})

test('diffRemovedKeys is the worker-side key twin', () => {
  const kept = bucketKey('codex', 'gpt-5.4-codex', '2026-03-14T01:00:00.000Z')
  const gone = bucketKey('codex', 'gpt-5.4-codex', '2026-03-14T02:00:00.000Z')
  const state = buildHourlyState([bucketRow()])
  assert.deepEqual(diffRemovedKeys([kept, gone], state), [gone])
  assert.deepEqual(diffRemovedKeys([kept], null), [kept])
})

test('isZeroTotals and rowsToKnownBuckets helpers', () => {
  assert.equal(isZeroTotals({}), true)
  assert.equal(isZeroTotals({ input_tokens: 1 }), false)
  assert.equal(isZeroTotals(null), true)
  assert.deepEqual(
    rowsToKnownBuckets([bucketRow(), null, { source: 'x' }]),
    [{ source: 'codex', model: 'gpt-5.4-codex', hour_start: '2026-03-14T01:00:00.000Z' }]
  )
})
