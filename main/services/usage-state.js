// Usage bucket-state adapter between SQLite rows and the vendored parser state.
//
// The vendored TokenTracker parsers expect `cursors.hourly` to be a
// `{ version, buckets, groupQueued }` object whose bucket keys are
// `source|model|hour_start` (vendored `bucketKey`) and whose totals use the
// upstream token vocabulary. Highlighter persists the same information as
// `usage_bucket` rows, so this module rebuilds that state before a scan and
// diffs the post-scan state back into deletions.
//
// Deliberate deviation from TokenTracker (documented in the vendor README):
// `groupQueued` stays empty. Upstream seeds it to keep legacy aggregate queue
// rows from being re-appended; Highlighter never writes a legacy queue (its DB
// rows are per model), so a non-empty seed would wrongly route every touched
// hour through the legacy "aggregate into one row" path and lose the model
// breakdown.
//
// All exported helpers are pure so the worker and node:test can require this
// module without Electron. The vendored module (big, but only needed for key
// formatting) is required lazily on first use.

const QUEUE_ROW_TO_BUCKET_COLUMNS = Object.freeze({
  input_tokens: 'input_tokens',
  cached_input_tokens: 'cached_input_tokens',
  cache_creation_input_tokens: 'cache_creation_tokens',
  output_tokens: 'output_tokens',
  reasoning_output_tokens: 'reasoning_tokens',
  total_tokens: 'total_tokens',
  billable_total_tokens: 'billable_total_tokens',
  conversation_count: 'conversation_count'
})

const BUCKET_INTEGER_COLUMNS = Object.freeze([
  'input_tokens',
  'cached_input_tokens',
  'cache_creation_tokens',
  'output_tokens',
  'reasoning_tokens',
  'total_tokens',
  'billable_total_tokens',
  'conversation_count'
])

let vendorHelpers = null

function getVendorHelpers() {
  if (!vendorHelpers) {
    // Lazy: keeps `require('./usage-state')` cheap in the main process and in
    // unit tests that only exercise the pure mapping helpers.
    const { bucketKey, totalsKey } = require('../vendor/tokentracker/rollout')
    vendorHelpers = { bucketKey, totalsKey }
  }
  return vendorHelpers
}

function toInteger(value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.trunc(number) : 0
}

// Parser queue row -> usage_bucket columns. Returns null for rows that cannot
// identify a bucket (the store treats those as a programming error).
function normalizeQueueRow(row) {
  if (!row || typeof row !== 'object') return null
  const source = typeof row.source === 'string' ? row.source.trim() : ''
  const model = typeof row.model === 'string' ? row.model.trim() : ''
  const hourStart = typeof row.hour_start === 'string' ? row.hour_start.trim() : ''
  if (!source || !model || !hourStart) return null
  const bucket = { source, model, hour_start: hourStart }
  for (const [queueColumn, bucketColumn] of Object.entries(QUEUE_ROW_TO_BUCKET_COLUMNS)) {
    bucket[bucketColumn] = toInteger(row[queueColumn])
  }
  const precision = typeof row.usage_precision === 'string' ? row.usage_precision.trim() : ''
  bucket.usage_precision = precision || null
  return bucket
}

// usage_bucket row -> upstream totals object (the shape parser state stores).
function bucketRowToTotals(row) {
  if (!row || typeof row !== 'object') return null
  const totals = {
    input_tokens: toInteger(row.input_tokens),
    cached_input_tokens: toInteger(row.cached_input_tokens),
    cache_creation_input_tokens: toInteger(row.cache_creation_tokens),
    output_tokens: toInteger(row.output_tokens),
    reasoning_output_tokens: toInteger(row.reasoning_tokens),
    total_tokens: toInteger(row.total_tokens),
    billable_total_tokens: toInteger(row.billable_total_tokens),
    total_cost_usd: Number(row.total_cost_usd) || 0,
    conversation_count: toInteger(row.conversation_count)
  }
  if (typeof row.usage_precision === 'string' && row.usage_precision) {
    totals.usage_precision = row.usage_precision
  }
  return totals
}

function isZeroTotals(totals) {
  if (!totals || typeof totals !== 'object') return true
  return BUCKET_INTEGER_COLUMNS.every((column) => toInteger(totals[column]) === 0)
}

function bucketKeyForRow(row) {
  const { bucketKey } = getVendorHelpers()
  return bucketKey(row.source, row.model, row.hour_start)
}

// Rebuild parser `hourlyState` from persisted bucket rows.
//
// `queuedKey` is seeded with the row's current totals key: the row is already
// durable, so a parser that re-touches an unchanged bucket can skip re-emitting
// it, while a changed bucket gets a different key and is emitted as a new LWW
// snapshot.
function buildHourlyState(rows = []) {
  const { bucketKey, totalsKey } = getVendorHelpers()
  const buckets = {}
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object' || !row.source || !row.model || !row.hour_start) continue
    const totals = bucketRowToTotals(row)
    const key = bucketKey(row.source, row.model, row.hour_start)
    buckets[key] = {
      source: row.source,
      model: row.model,
      hour_start: row.hour_start,
      totals,
      queuedKey: totalsKey(totals)
    }
  }
  return {
    version: 1,
    buckets,
    groupQueued: {}
  }
}

// Rows that vanished from (or were zeroed in) the post-parse state. Returns row
// identities so the store can delete by primary key without parsing opaque keys.
function diffRemovedBuckets(previousRows = [], hourlyState = null) {
  const { bucketKey } = getVendorHelpers()
  const buckets = hourlyState && typeof hourlyState === 'object' && hourlyState.buckets && typeof hourlyState.buckets === 'object'
    ? hourlyState.buckets
    : {}
  const removed = []
  for (const row of Array.isArray(previousRows) ? previousRows : []) {
    if (!row || typeof row !== 'object' || !row.source || !row.model || !row.hour_start) continue
    const bucket = buckets[bucketKey(row.source, row.model, row.hour_start)]
    if (!bucket || isZeroTotals(bucket.totals)) {
      removed.push({ source: row.source, model: row.model, hour_start: row.hour_start })
    }
  }
  return removed
}

// Key-level twin of diffRemovedBuckets, used inside the scan worker where only
// the parser state (and the pre-scan key list) is available.
function diffRemovedKeys(previousKeys = [], hourlyState = null) {
  const buckets = hourlyState && typeof hourlyState === 'object' && hourlyState.buckets && typeof hourlyState.buckets === 'object'
    ? hourlyState.buckets
    : {}
  const removed = []
  for (const key of Array.isArray(previousKeys) ? previousKeys : []) {
    if (typeof key !== 'string' || !key) continue
    const bucket = buckets[key]
    if (!bucket || isZeroTotals(bucket.totals)) removed.push(key)
  }
  return removed
}

function rowsToKnownBuckets(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => row && typeof row === 'object' && row.source && row.model && row.hour_start)
    .map((row) => ({ source: row.source, model: row.model, hour_start: row.hour_start }))
}

module.exports = {
  BUCKET_INTEGER_COLUMNS,
  QUEUE_ROW_TO_BUCKET_COLUMNS,
  bucketKeyForRow,
  bucketRowToTotals,
  buildHourlyState,
  diffRemovedBuckets,
  diffRemovedKeys,
  isZeroTotals,
  normalizeQueueRow,
  rowsToKnownBuckets,
  toInteger
}
