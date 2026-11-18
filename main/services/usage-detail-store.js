const { normalizeQueueRow } = require('./usage-state')

function createUsageDetailStore(db, columns, columnAliases) {
  db.exec([
    "CREATE TABLE IF NOT EXISTS usage_detail_stamp (source TEXT NOT NULL, file TEXT NOT NULL, stamp TEXT NOT NULL, partial INTEGER NOT NULL, observed_at TEXT NOT NULL, PRIMARY KEY(source,file))",
    "CREATE TABLE IF NOT EXISTS usage_detail_status (source TEXT PRIMARY KEY, status TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS usage_detail_title (session TEXT PRIMARY KEY,title TEXT NOT NULL,observed_at TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS usage_session_bucket (source TEXT NOT NULL, file TEXT NOT NULL, session TEXT NOT NULL, title TEXT NOT NULL, project TEXT NOT NULL, project_name TEXT NOT NULL, model TEXT NOT NULL, hour_start TEXT NOT NULL, first_at TEXT NOT NULL, last_at TEXT NOT NULL, active_seconds REAL NOT NULL, " +
      columns.map((column) => column + ' INTEGER NOT NULL').join(',') + ", PRIMARY KEY(source,session,project,model,hour_start))",
    "CREATE TABLE IF NOT EXISTS usage_activity_bucket (source TEXT NOT NULL, file TEXT NOT NULL, session TEXT NOT NULL, project TEXT NOT NULL, project_name TEXT NOT NULL, model TEXT NOT NULL, hour_start TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, calls INTEGER NOT NULL, last_at TEXT NOT NULL, PRIMARY KEY(source,session,project,model,hour_start,kind,name))",
    "CREATE INDEX IF NOT EXISTS idx_usage_session_hour ON usage_session_bucket(hour_start)",
    "CREATE INDEX IF NOT EXISTS idx_usage_session_project_hour ON usage_session_bucket(project,hour_start)",
    "CREATE INDEX IF NOT EXISTS idx_usage_session_file ON usage_session_bucket(source,file)",
    "CREATE INDEX IF NOT EXISTS idx_usage_activity_hour ON usage_activity_bucket(hour_start)",
    "CREATE INDEX IF NOT EXISTS idx_usage_activity_file ON usage_activity_bucket(source,file)"
  ].join(';\n'))
  const saveStamp = db.prepare('INSERT OR REPLACE INTO usage_detail_stamp VALUES (?,?,?,?,?)')
  const saveStatus = db.prepare('INSERT OR REPLACE INTO usage_detail_status VALUES (?,?)')
  const saveTitle = db.prepare('INSERT OR REPLACE INTO usage_detail_title VALUES (?,?,?)')
  const saveBucket = db.prepare('INSERT OR REPLACE INTO usage_session_bucket VALUES (' + Array(11 + columns.length).fill('?').join(',') + ')')
  const saveCall = db.prepare('INSERT OR REPLACE INTO usage_activity_bucket VALUES (?,?,?,?,?,?,?,?,?,?,?)')
  const deleteBuckets = db.prepare('DELETE FROM usage_session_bucket WHERE source=? AND file=?')
  const deleteCalls = db.prepare('DELETE FROM usage_activity_bucket WHERE source=? AND file=?')
  const deleteSessionBuckets = db.prepare('DELETE FROM usage_session_bucket WHERE source=? AND session=? AND file<>?')
  const deleteSessionCalls = db.prepare('DELETE FROM usage_activity_bucket WHERE source=? AND session=? AND file<>?')
  const tokenSums = columns.map((column) => 'SUM(' + column + ') AS ' + columnAliases(column)).join(',')

  function stamps(source) {
    return Object.fromEntries(db.prepare('SELECT file,stamp,partial FROM usage_detail_stamp WHERE source=?').all(source)
      .map(({ file, stamp, partial }) => [file, { stamp, partial: partial === 1 }]))
  }

  function commit(source, scan, observedAt) {
    if (!scan) return
    if (source === 'codex' && scan.titleIndex) {
      for (const { session, title } of scan.titleIndex.rows) saveTitle.run(session, title, observedAt)
      saveStamp.run(source, 'titleIndex', scan.titleIndex.stamp, 0, observedAt)
    }
    for (const update of scan.updates || []) {
      if (source !== 'opencode') {
        const sessions = new Set([...update.buckets, ...update.calls].map((row) => row.session))
        for (const session of sessions) {
          deleteSessionBuckets.run(source, session, update.key)
          deleteSessionCalls.run(source, session, update.key)
        }
      }
      deleteBuckets.run(source, update.key)
      deleteCalls.run(source, update.key)
      for (const row of update.buckets) {
        const normalized = normalizeQueueRow({ ...row, source })
        if (!normalized) continue
        saveBucket.run(source, update.key, row.session, row.title, row.project, row.projectName, normalized.model,
          row.hour_start, row.first, row.last, row.activeSeconds, ...columns.map((column) => normalized[column]))
      }
      for (const row of update.calls) {
        saveCall.run(source, update.key, row.session, row.project, row.projectName, row.model, row.hour_start, row.kind, row.name, row.calls, row.last)
      }
      saveStamp.run(source, update.key, update.stamp, update.partial ? 1 : 0, observedAt)
    }
    saveStatus.run(source, scan.pending ? 'pending' : scan.partial ? 'partial' : 'ready')
  }

  function prune(cutoff) {
    for (const table of ['usage_session_bucket', 'usage_activity_bucket']) db.prepare('DELETE FROM ' + table + ' WHERE hour_start<?').run(cutoff)
    db.prepare('DELETE FROM usage_detail_stamp WHERE observed_at<?').run(cutoff)
    db.prepare('DELETE FROM usage_detail_title WHERE observed_at<?').run(cutoff)
  }

  function clear() {
    db.exec('DELETE FROM usage_session_bucket; DELETE FROM usage_activity_bucket; DELETE FROM usage_detail_stamp; DELETE FROM usage_detail_status; DELETE FROM usage_detail_title')
  }

  function query(filters, whereFor) {
    const info = db.prepare('SELECT source,status FROM usage_detail_status').all()
      .filter(({ source }) => !filters.sources || filters.sources.includes(source))
    if (!info.length) return null
    const { where, params } = whereFor(filters)
    const unscopedProject = { ...filters, project: null }
    const projectWhere = whereFor(unscopedProject)
    const projects = db.prepare("SELECT project AS id, MAX(project_name) AS name, model, " + tokenSums +
      " FROM usage_session_bucket " + projectWhere.where + " AND project<>'' GROUP BY project,model ORDER BY id,model LIMIT 10001").all(...projectWhere.params)
    const sessions = db.prepare('SELECT session AS id,source,model,COALESCE((SELECT title FROM usage_detail_title WHERE usage_detail_title.session=usage_session_bucket.session),MAX(title)) AS title, MAX(project_name) AS projectName, MIN(first_at) AS first, MAX(last_at) AS last, SUM(active_seconds) AS activeSeconds,' +
      tokenSums + ' FROM usage_session_bucket ' + where + ' GROUP BY source,session,model ORDER BY id,model LIMIT 10001').all(...params)
    const activityScope = whereFor({ ...filters, model: null })
    const activityWhere = filters.model ? activityScope.where +
      ' AND (model=? OR EXISTS (SELECT 1 FROM usage_session_bucket AS tokens WHERE tokens.source=usage_activity_bucket.source AND tokens.session=usage_activity_bucket.session AND tokens.hour_start>=? AND tokens.hour_start<? AND tokens.model=?))' : where
    const activityParams = filters.model ? [...activityScope.params, filters.model, filters.fromIso, filters.toIso, filters.model] : params
    const activities = db.prepare("SELECT kind, name, SUM(calls) AS calls, COUNT(DISTINCT session) AS sessions, MAX(last_at) AS last FROM usage_activity_bucket " +
      activityWhere + " GROUP BY kind,name ORDER BY calls DESC, name LIMIT 2000").all(...activityParams)
    const activityTotals = db.prepare("SELECT kind, SUM(calls) AS calls, COUNT(DISTINCT session) AS sessions,COUNT(DISTINCT name) AS names FROM usage_activity_bucket " +
      activityWhere + " GROUP BY kind").all(...activityParams)
    const activityHours = db.prepare("SELECT hour_start, name, SUM(calls) AS calls FROM usage_activity_bucket " + activityWhere +
      " AND kind='tool' GROUP BY hour_start,name ORDER BY hour_start DESC LIMIT 10001").all(...activityParams)
    return { projects, sessions, activities, activityTotals, activityHours, info }
  }

  function days(filters, bounds, whereFor) {
    const matches = whereFor({ sources: filters.sources, model: filters.model, project: filters.project })
    const extra = matches.where ? ' AND ' + matches.where.slice(6) : ''
    return db.prepare("WITH days AS (SELECT value->>0 AS day,value->>1 AS start,value->>2 AS end FROM json_each(?)) " +
      "SELECT day,COUNT(DISTINCT session) AS sessions,COALESCE(SUM(active_seconds),0) AS activeSeconds FROM days JOIN usage_session_bucket " +
      "ON hour_start>=days.start AND hour_start<days.end" + extra + " GROUP BY day").all(JSON.stringify(bounds), ...matches.params)
  }

  return { stamps, commit, prune, clear, query, days, hasBuckets: () => !!db.prepare('SELECT 1 FROM usage_session_bucket LIMIT 1').get() }
}

module.exports = { createUsageDetailStore }
