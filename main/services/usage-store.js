// Usage SQLite store (B1) — the single writer of `<dataRoot>/usage/usage.db`.
//
// Design (plan 2026-10-21-tokentracker-usage-page-development-plan.md §2.2/§2.5):
// - The Electron main process is the only writer. The scan worker only parses
//   and returns rows; `commitScan()` persists bucket upserts, deletions, cursor
//   state and source status inside ONE transaction so a crash can never leave a
//   bucket written without its cursor (which would double-count on the next run).
// - Bucket rows are absolute snapshots produced by the vendored parsers, so an
//   upsert is plain LWW (`INSERT ... ON CONFLICT ... DO UPDATE`).
// - Schema is frozen for v1; `PRAGMA user_version` gates future migrations.
//
// deps signature: all optional. `now()` returns a Date for deterministic tests.
const fs = require('node:fs')
const path = require('node:path')

const { normalizeQueueRow } = require('./usage-state')

const RETENTION_MONTHS = 24
const SCHEMA_VERSION = 1
const BUCKET_TABLE = 'usage_bucket'

// DB column <- parser queue-row column (TokenTracker queue schema, plan §2.5).
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

// DB column -> parser/queue column. The query layer (usage-query.js) works in
// the TokenTracker queue vocabulary, so every read helper aliases these back.
const QUEUE_COLUMN_BY_BUCKET_COLUMN = Object.freeze({
  cache_creation_tokens: 'cache_creation_input_tokens',
  reasoning_tokens: 'reasoning_output_tokens'
})

function queueAlias(column) {
  return QUEUE_COLUMN_BY_BUCKET_COLUMN[column] || column
}

const BUCKET_READ_SELECT = Object.freeze(
  [
    'source',
    'model',
    'hour_start',
    'input_tokens',
    'cached_input_tokens',
    'cache_creation_tokens AS cache_creation_input_tokens',
    'output_tokens',
    'reasoning_tokens AS reasoning_output_tokens',
    'total_tokens',
    'billable_total_tokens',
    'conversation_count',
    'total_cost_usd',
    'usage_precision',
    'updated_at'
  ].join(', ')
)

function sumSelectColumns(columns) {
  return columns.map((column) => `COALESCE(SUM(${column}), 0) AS ${queueAlias(column)}`)
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS usage_bucket (
  source                 TEXT NOT NULL,
  model                  TEXT NOT NULL,
  hour_start             TEXT NOT NULL,
  input_tokens           INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens    INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens          INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens       INTEGER NOT NULL DEFAULT 0,
  total_tokens           INTEGER NOT NULL DEFAULT 0,
  billable_total_tokens  INTEGER NOT NULL DEFAULT 0,
  conversation_count     INTEGER NOT NULL DEFAULT 0,
  total_cost_usd         REAL NOT NULL DEFAULT 0,
  usage_precision        TEXT,
  updated_at             TEXT NOT NULL,
  PRIMARY KEY (source, model, hour_start)
);
CREATE INDEX IF NOT EXISTS idx_usage_hour ON usage_bucket(hour_start);
CREATE INDEX IF NOT EXISTS idx_usage_source_hour ON usage_bucket(source, hour_start);
CREATE INDEX IF NOT EXISTS idx_usage_model_hour ON usage_bucket(model, hour_start);
-- Heatmap reads 52 weeks of (hour, source, model, tokens): this covering index
-- keeps the per-local-day grouped aggregation index-only.
CREATE INDEX IF NOT EXISTS idx_usage_heat_cover ON usage_bucket(hour_start, source, model, total_tokens, billable_total_tokens, conversation_count);

CREATE TABLE IF NOT EXISTS scan_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_status (
  source            TEXT PRIMARY KEY,
  state             TEXT NOT NULL,
  detected          INTEGER NOT NULL DEFAULT 0,
  readable          INTEGER NOT NULL DEFAULT 0,
  files             INTEGER NOT NULL DEFAULT 0,
  last_scan_at      TEXT,
  last_error        TEXT,
  detail            TEXT,
  coverage_start_at TEXT,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

function isoTimestamp(now) {
  const value = now instanceof Date ? now : new Date(now)
  return value.toISOString()
}

function toIsoOrNull(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

function truthyInteger(value) {
  return value ? 1 : 0
}

function createSchemaStatements(db) {
  const insertColumns = ['usage_precision', ...BUCKET_INTEGER_COLUMNS]
  const updateAssignments = insertColumns.map((column) => `${column} = excluded.${column}`)
  const placeholders = insertColumns.map(() => '?')
  const upsertSql = `INSERT INTO usage_bucket (source, model, hour_start, ${insertColumns.join(', ')}, updated_at)
    VALUES (?, ?, ?, ${placeholders.join(', ')}, ?)
    ON CONFLICT(source, model, hour_start) DO UPDATE SET
      ${updateAssignments.join(',\n      ')},
      updated_at = excluded.updated_at`

  const statements = {
    upsertBucket: db.prepare(upsertSql),
    deleteBucket: db.prepare(
      'DELETE FROM usage_bucket WHERE source = ? AND model = ? AND hour_start = ?',
    ),
    deleteOlderThan: db.prepare('DELETE FROM usage_bucket WHERE hour_start < ?'),
    countBuckets: db.prepare('SELECT COUNT(*) AS count FROM usage_bucket'),
    minHourStart: db.prepare(
      'SELECT source, MIN(hour_start) AS hour_start FROM usage_bucket GROUP BY source',
    ),
    getScanState: db.prepare('SELECT key, value, updated_at FROM scan_state WHERE key = ?'),
    setScanState: db.prepare(
      `INSERT INTO scan_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ),
    upsertSourceStatus: db.prepare(
      `INSERT INTO source_status (source, state, detected, readable, files, last_scan_at, last_error, detail, coverage_start_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source) DO UPDATE SET
         state = excluded.state,
         detected = excluded.detected,
         readable = excluded.readable,
         files = excluded.files,
         last_scan_at = COALESCE(excluded.last_scan_at, source_status.last_scan_at),
         last_error = excluded.last_error,
         detail = excluded.detail,
         coverage_start_at = COALESCE(excluded.coverage_start_at, source_status.coverage_start_at),
         updated_at = excluded.updated_at`,
    ),
    listSourceStatus: db.prepare('SELECT * FROM source_status ORDER BY source'),
    getAppMeta: db.prepare('SELECT value FROM app_meta WHERE key = ?'),
    setAppMeta: db.prepare(
      `INSERT INTO app_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ),
    clearBuckets: db.prepare('DELETE FROM usage_bucket'),
    clearScanState: db.prepare('DELETE FROM scan_state'),
    clearSourceStatus: db.prepare('DELETE FROM source_status'),
    clearAppMeta: db.prepare('DELETE FROM app_meta')
  }
  return statements
}

function ensureSchema(db) {
  const versionRow = db.prepare('PRAGMA user_version').get()
  const version = Number(versionRow?.user_version || 0)
  if (version > SCHEMA_VERSION) {
    throw new Error(
      `usage store schema version ${version} is newer than this build supports (${SCHEMA_VERSION})`
    )
  }
  if (version === 0) {
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(SCHEMA_SQL)
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
      db.exec('COMMIT')
    } catch (error) {
      try { db.exec('ROLLBACK') } catch {}
      throw error
    }
  }
}

function openUsageStore({ dbPath, now = () => new Date(), log = () => {} } = {}) {
  if (typeof dbPath !== 'string' || !dbPath) throw new TypeError('usage store requires a dbPath')
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })

  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(dbPath)
  let closed = false

  function ensureHeatmapCoverIndex() {
    // Idempotent: schema v1 databases created before this index was added must
    // still get it without a user_version bump (index-only, no data migration).
    try {
      db.exec('CREATE INDEX IF NOT EXISTS idx_usage_heat_cover ON usage_bucket(hour_start, source, model, total_tokens, billable_total_tokens, conversation_count)')
    } catch (error) {
      log('usage store: heatmap cover index unavailable: ' + (error && error.message ? error.message : String(error)))
    }
  }

  try {
    db.prepare('PRAGMA journal_mode = WAL').get()
    db.exec('PRAGMA synchronous = NORMAL')
    db.exec('PRAGMA busy_timeout = 3000')
    db.exec('PRAGMA foreign_keys = ON')
    ensureSchema(db)
    ensureHeatmapCoverIndex()
  } catch (error) {
    try { db.close() } catch {}
    throw error
  }

  const statements = createSchemaStatements(db)
  // Monotonic in-process version for query-cache invalidation: every write that
  // can change aggregate results bumps it (plan §2.6 LRU key includes dbVersion).
  let dbVersion = 0

  function assertOpen() {
    if (closed) throw new Error('usage store is closed')
  }

  function nowIso() {
    return isoTimestamp(now())
  }

  function withTransaction(work) {
    assertOpen()
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      db.exec('COMMIT')
      return result
    } catch (error) {
      try { db.exec('ROLLBACK') } catch {}
      throw error
    }
  }

  function bucketValues(row, updatedAt) {
    const normalized = normalizeQueueRow(row)
    if (!normalized) throw new Error('usage store received an invalid bucket row')
    return [
      normalized.source,
      normalized.model,
      normalized.hour_start,
      normalized.usage_precision,
      ...BUCKET_INTEGER_COLUMNS.map((column) => normalized[column]),
      updatedAt
    ]
  }

  function loadCursors(source) {
    assertOpen()
    if (typeof source !== 'string' || !source) return {}
    const row = statements.getScanState.get(`cursors:${source}`)
    if (!row || typeof row.value !== 'string') return {}
    try {
      const parsed = JSON.parse(row.value)
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch (_error) {
      log(`usage store: ignoring corrupt cursor state for ${source}`)
      return {}
    }
  }

  function loadBucketRows(sources = null) {
    assertOpen()
    const list = Array.isArray(sources)
      ? sources.filter((source) => typeof source === 'string' && source)
      : null
    // DB-shaped rows: usage-state maps them to the parser's queue vocabulary.
    const sql = list && list.length > 0
      ? `SELECT * FROM usage_bucket WHERE source IN (${list.map(() => '?').join(', ')}) ORDER BY source, model, hour_start`
      : 'SELECT * FROM usage_bucket ORDER BY source, model, hour_start'
    return db.prepare(sql).all(...(list && list.length > 0 ? list : []))
  }

  function getRangeRows({ fromIso, toIso, sources = null } = {}) {
    assertOpen()
    const filters = []
    const params = []
    if (typeof fromIso === 'string' && fromIso) {
      filters.push('hour_start >= ?')
      params.push(fromIso)
    }
    if (typeof toIso === 'string' && toIso) {
      filters.push('hour_start < ?')
      params.push(toIso)
    }
    const list = Array.isArray(sources)
      ? sources.filter((source) => typeof source === 'string' && source)
      : null
    if (list && list.length > 0) {
      filters.push(`source IN (${list.map(() => '?').join(', ')})`)
      params.push(...list)
    }
    const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : ''
    return db
      .prepare(`SELECT ${BUCKET_READ_SELECT} FROM usage_bucket ${where} ORDER BY hour_start, source, model`)
      .all(...params)
  }

  function sumRange({ fromIso, toIso, sources = null } = {}) {
    const columns = sumSelectColumns(BUCKET_INTEGER_COLUMNS)
    const filters = []
    const params = []
    if (typeof fromIso === 'string' && fromIso) {
      filters.push('hour_start >= ?')
      params.push(fromIso)
    }
    if (typeof toIso === 'string' && toIso) {
      filters.push('hour_start < ?')
      params.push(toIso)
    }
    const list = Array.isArray(sources)
      ? sources.filter((source) => typeof source === 'string' && source)
      : null
    if (list && list.length > 0) {
      filters.push(`source IN (${list.map(() => '?').join(', ')})`)
      params.push(...list)
    }
    const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : ''
    const row = db.prepare(`SELECT ${columns.join(', ')} FROM usage_bucket ${where}`).get(...params) || {}
    const totals = {}
    for (const column of BUCKET_INTEGER_COLUMNS) {
      const alias = queueAlias(column)
      totals[alias] = Number(row[alias]) || 0
    }
    return totals
  }

  // SQL pre-aggregation helpers for the query layer (plan §2.6): fold rows per
  // UTC hour (timezone mapping stays in JS) or per dimension tuple (breakdown)
  // so a 100k-row range never crosses the process boundary row-by-row.
  function rangeWhere({ fromIso, toIso } = {}) {
    const filters = []
    const params = []
    if (typeof fromIso === 'string' && fromIso) {
      filters.push('hour_start >= ?')
      params.push(fromIso)
    }
    if (typeof toIso === 'string' && toIso) {
      filters.push('hour_start < ?')
      params.push(toIso)
    }
    return { where: filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '', params }
  }

  function getRangeHourlyTotals({ fromIso, toIso } = {}) {
    assertOpen()
    const sums = sumSelectColumns(BUCKET_INTEGER_COLUMNS)
    const { where, params } = rangeWhere({ fromIso, toIso })
    return db
      .prepare(`SELECT hour_start, ${sums.join(', ')} FROM usage_bucket ${where} GROUP BY hour_start ORDER BY hour_start`)
      .all(...params)
  }

  function getGroupedTotals({ fromIso, toIso, dimensions = ['source', 'model'] } = {}) {
    assertOpen()
    const dims = (Array.isArray(dimensions) ? dimensions : []).filter((dimension) =>
      ['source', 'model'].includes(dimension)
    )
    if (dims.length === 0) throw new Error('usage store grouped totals require at least one dimension')
    const sums = sumSelectColumns(BUCKET_INTEGER_COLUMNS)
    const { where, params } = rangeWhere({ fromIso, toIso })
    return db
      .prepare(`SELECT ${dims.join(', ')}, ${sums.join(', ')} FROM usage_bucket ${where} GROUP BY ${dims.join(', ')} ORDER BY ${dims.join(', ')}`)
      .all(...params)
  }

  // Heatmap pre-aggregation: one grouped SELECT per local calendar day (365 max
  // for a 52-week grid). Each branch streams its day's index range and returns
  // only (day, source, model) totals, so callers get ~5k rows instead of the raw
  // 52-week bucket rows. Day bounds come from usage-time's Intl/DST-safe
  // resolveDayBounds, so timezone folding is exact.
  function countRangeRows({ fromIso = null, toIso = null, limit = 100000 } = {}) {
    assertOpen()
    const filters = []
    const params = []
    if (typeof fromIso === 'string' && fromIso) {
      filters.push('hour_start >= ?')
      params.push(fromIso)
    }
    if (typeof toIso === 'string' && toIso) {
      filters.push('hour_start < ?')
      params.push(toIso)
    }
    const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : ''
    const cap = Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : 100000
    const row = db
      .prepare(`SELECT COUNT(*) AS count FROM (SELECT 1 FROM usage_bucket ${where} LIMIT ${cap + 1})`)
      .get(...params)
    return Number(row?.count) || 0
  }

  function getHeatmapDayModelTotals({ dayRanges = [] } = {}) {
    assertOpen()
    const ranges = (Array.isArray(dayRanges) ? dayRanges : []).filter((range) => {
      if (!range || typeof range !== 'object') return false
      if (typeof range.day !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(range.day)) return false
      return Number.isFinite(Date.parse(range.startIso)) && Number.isFinite(Date.parse(range.endIso))
    })
    if (ranges.length === 0) return []
    if (ranges.length > 400) throw new Error('usage heatmap day range is too large')
    const branches = ranges.map((range) => {
      const startIso = new Date(Date.parse(range.startIso)).toISOString()
      const endIso = new Date(Date.parse(range.endIso)).toISOString()
      return (
        `SELECT '${range.day}' AS day, source AS source, model AS model, ` +
        'COALESCE(SUM(total_tokens), 0) AS total_tokens, ' +
        'COALESCE(SUM(billable_total_tokens), 0) AS billable_total_tokens, ' +
        'COALESCE(SUM(conversation_count), 0) AS conversation_count ' +
        `FROM usage_bucket INDEXED BY idx_usage_heat_cover WHERE hour_start >= '${startIso}' AND hour_start < '${endIso}' GROUP BY source, model`
      )
    })
    return db.prepare(branches.join(' UNION ALL ')).all()
  }

  function countDistinctDays({ fromIso, toIso } = {}) {
    assertOpen()
    const filters = []
    const params = []
    if (typeof fromIso === 'string' && fromIso) {
      filters.push('hour_start >= ?')
      params.push(fromIso)
    }
    if (typeof toIso === 'string' && toIso) {
      filters.push('hour_start < ?')
      params.push(toIso)
    }
    const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : ''
    const row = db
      .prepare(`SELECT COUNT(DISTINCT substr(hour_start, 1, 10)) AS days FROM usage_bucket ${where}`)
      .get(...params)
    return Number(row?.days) || 0
  }

  function recordSourceStatus(status = {}) {
    assertOpen()
    const source = typeof status.source === 'string' ? status.source : ''
    if (!source) throw new Error('usage store source status requires a source')
    const updatedAt = nowIso()
    withTransaction(() => {
      statements.upsertSourceStatus.run(
        source,
        typeof status.state === 'string' ? status.state : 'error',
        truthyInteger(status.detected),
        truthyInteger(status.readable),
        Number.isFinite(status.files) ? Math.trunc(status.files) : 0,
        toIsoOrNull(status.lastScanAt),
        typeof status.lastError === 'string' ? status.lastError : null,
        typeof status.detail === 'string' ? status.detail : null,
        toIsoOrNull(status.coverageStartAt),
        updatedAt
      )
    })
  }

  function listSourceStatus() {
    assertOpen()
    const out = {}
    for (const row of statements.listSourceStatus.all()) {
      out[row.source] = {
        source: row.source,
        state: row.state,
        detected: row.detected === 1,
        readable: row.readable === 1,
        files: Number(row.files) || 0,
        lastScanAt: row.last_scan_at || null,
        lastError: row.last_error || null,
        detail: row.detail || null,
        coverageStartAt: row.coverage_start_at || null,
        updatedAt: row.updated_at || null
      }
    }
    return out
  }

  function getAppMeta(key) {
    assertOpen()
    const row = statements.getAppMeta.get(key)
    return row ? row.value : null
  }

  function setAppMeta(key, value) {
    assertOpen()
    statements.setAppMeta.run(key, String(value))
  }

  // Single transaction: bucket upserts + deletions + cursors + source status +
  // retention pruning. Anything thrown rolls the whole tool scan back.
  function commitScan({ source, upserts = [], removed = [], cursors = null, status = null, retentionMonths = RETENTION_MONTHS, now: commitNow = null } = {}) {
    assertOpen()
    if (typeof source !== 'string' || !source) throw new Error('usage store commit requires a source')
    const updatedAt = commitNow ? isoTimestamp(commitNow) : nowIso()
    let inserted = 0
    withTransaction(() => {
      for (const row of Array.isArray(upserts) ? upserts : []) {
        statements.upsertBucket.run(...bucketValues(row, updatedAt))
        inserted += 1
      }
      for (const row of Array.isArray(removed) ? removed : []) {
        const identity = row && typeof row === 'object' ? row : {}
        if (typeof identity.source !== 'string' || typeof identity.model !== 'string' || typeof identity.hour_start !== 'string') {
          continue
        }
        statements.deleteBucket.run(identity.source, identity.model, identity.hour_start)
      }
      if (cursors && typeof cursors === 'object') {
        statements.setScanState.run(`cursors:${source}`, JSON.stringify(cursors), updatedAt)
      }
      if (status && typeof status === 'object') {
        statements.upsertSourceStatus.run(
          source,
          typeof status.state === 'string' ? status.state : 'ok',
          truthyInteger(status.detected),
          truthyInteger(status.readable),
          Number.isFinite(status.files) ? Math.trunc(status.files) : 0,
          toIsoOrNull(status.lastScanAt) || updatedAt,
          typeof status.lastError === 'string' ? status.lastError : null,
          typeof status.detail === 'string' ? status.detail : null,
          toIsoOrNull(status.coverageStartAt),
          updatedAt
        )
      }
      if (Number.isFinite(retentionMonths) && retentionMonths > 0) {
        const cutoff = new Date(
          Date.UTC(
            (commitNow ? new Date(commitNow) : now()).getUTCFullYear(),
            (commitNow ? new Date(commitNow) : now()).getUTCMonth() - Math.trunc(retentionMonths),
            1
          )
        ).toISOString()
        statements.deleteOlderThan.run(cutoff)
      }
    })
    dbVersion += 1
    return { inserted }
  }

  function getDbVersion() {
    return dbVersion
  }

  function getCoverageStart(source) {
    assertOpen()
    if (typeof source !== 'string' || !source) return null
    const row = db
      .prepare('SELECT MIN(hour_start) AS hour_start FROM usage_bucket WHERE source = ?')
      .get(source)
    return row?.hour_start || null
  }

  function deleteOlderThan(cutoffIso) {
    assertOpen()
    const cutoff = toIsoOrNull(cutoffIso)
    if (!cutoff) throw new Error('usage store retention cutoff must be an ISO timestamp')
    const result = statements.deleteOlderThan.run(cutoff)
    if (result.changes) dbVersion += 1
    return Number(result.changes) || 0
  }

  function countBuckets() {
    assertOpen()
    const row = statements.countBuckets.get()
    return Number(row?.count) || 0
  }

  function getStats() {
    assertOpen()
    let dbBytes = 0
    try {
      dbBytes = fs.statSync(dbPath).size
    } catch (_error) {
      dbBytes = 0
    }
    return { dbBytes, buckets: countBuckets() }
  }

  function clear({ vacuum = false } = {}) {
    assertOpen()
    withTransaction(() => {
      statements.clearBuckets.run()
      statements.clearScanState.run()
      statements.clearSourceStatus.run()
      statements.clearAppMeta.run()
    })
    dbVersion += 1
    if (vacuum) {
      try { db.exec('VACUUM') } catch {}
    }
    return { ok: true, clearedAt: nowIso() }
  }

  function checkpoint() {
    assertOpen()
    try {
      db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
    } catch (error) {
      log(`usage store: WAL checkpoint failed: ${error?.message || String(error)}`)
    }
  }

  function close({ checkpointOnClose = true } = {}) {
    if (closed) return
    if (checkpointOnClose) checkpoint()
    closed = true
    try { db.close() } catch {}
  }

  return {
    dbPath,
    loadCursors,
    loadBucketRows,
    countRangeRows,
    getGroupedTotals,
    getHeatmapDayModelTotals,
    getRangeHourlyTotals,
    getRangeRows,
    sumRange,
    countDistinctDays,
    recordSourceStatus,
    listSourceStatus,
    getAppMeta,
    setAppMeta,
    commitScan,
    deleteOlderThan,
    countBuckets,
    getCoverageStart,
    getDbVersion,
    getStats,
    clear,
    checkpoint,
    close,
    isOpen: () => !closed
  }
}

module.exports = {
  BUCKET_INTEGER_COLUMNS,
  BUCKET_TABLE,
  RETENTION_MONTHS,
  SCHEMA_VERSION,
  isoTimestamp,
  openUsageStore
}
