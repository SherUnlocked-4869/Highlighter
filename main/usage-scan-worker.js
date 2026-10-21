// Usage scan worker (utilityProcess entry) — pure parser runner, no SQLite.
//
// Protocol (parent ⇄ worker):
//   parent -> worker  { type: 'scan', id, request: { source, files, cursors, queuePath } }
//                     { type: 'shutdown' }
//   worker -> parent  { type: 'ready', pid, startedAt }
//                     { type: 'progress', id, progress: {...} }
//                     { type: 'result', id, result: { upserts, removed, cursors, stats } }
//                     { type: 'error', id, message }
//
// `cursors.hourly` carries the parser hourly state rebuilt from SQLite by
// `main/services/usage-state.js`; the parser mutates `cursors` in place and the
// worker returns it for the main process to persist in one transaction. The
// worker never opens the database and never spawns a process.

const { diffRemovedKeys } = require('./services/usage-state')

let rolloutModule = null

function getRolloutModule() {
  if (!rolloutModule) {
    rolloutModule = require('./vendor/tokentracker/rollout')
  }
  return rolloutModule
}

function parentPort() {
  return process.parentPort || null
}

function send(message) {
  try {
    const port = parentPort()
    if (port) port.postMessage(message)
    else if (typeof process.send === 'function') process.send(message)
  } catch (_error) {
    // A closed parent port means the main process is gone; nothing to report.
  }
}

// Source -> vendored parser call. The file list is always supplied by the main
// process (discovery lives in usage-tools.js), so the worker stays deterministic
// and side-effect free. Only the OpenCode parser opens a (read-only) database;
// everything else is passive JSONL/zstd reading.
const PARSERS = Object.freeze({
  codex: async (rollout, { files, cursors, queuePath, onProgress }) => {
    return rollout.parseRolloutIncremental({
      rolloutFiles: files,
      cursors,
      queuePath,
      onProgress
    })
  },
  dsh: async (rollout, { files, cursors, queuePath, onProgress }) => {
    return rollout.parseDshIncremental({
      sessionFiles: files,
      cursors,
      queuePath,
      onProgress
    })
  },
  opencode: async (rollout, { files, cursors, queuePath, onProgress }) => {
    const dbPath = files[0]
    if (typeof dbPath !== 'string' || !dbPath) {
      throw new Error('opencode scan requires the database path')
    }
    const previousState = cursors.opencode && typeof cursors.opencode === 'object' ? cursors.opencode : null
    const previousDbCursor =
      previousState && previousState.dbCursor && typeof previousState.dbCursor === 'object'
        ? previousState.dbCursor
        : null
    const read = await readOpencodeDbWithRetry(rollout, dbPath, previousDbCursor)
    return rollout.parseOpencodeDbIncremental({
      dbMessages: read.messages,
      dbPath,
      dbCursor: read.cursor,
      cursors,
      queuePath,
      source: 'opencode',
      cursorKey: 'opencode',
      onProgress
    })
  }
})

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isSqliteBusyError(error) {
  const message = String(error && error.message ? error.message : error).toLowerCase()
  const code = String((error && error.code) || '')
  return (
    message.includes('sqlite_busy') ||
    message.includes('database is locked') ||
    message.includes('database table is locked') ||
    code.includes('SQLITE_BUSY')
  )
}

// `opencode.db` is the live database of a running CLI: a read can hit
// SQLITE_BUSY when a write transaction is open. Retry briefly, then fall back to
// a read-only snapshot copy (db + WAL/SHM/journal) exactly like the plan's R5
// mitigation. The snapshot is deleted immediately after the read.
function snapshotOpencodeDb(dbPath) {
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-usage-opencode-'))
  const target = path.join(root, path.basename(dbPath))
  fs.copyFileSync(dbPath, target)
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const source = dbPath + suffix
    try {
      if (fs.existsSync(source)) fs.copyFileSync(source, target + suffix)
    } catch (_error) {}
  }
  return {
    path: target,
    cleanup() {
      try { fs.rmSync(root, { recursive: true, force: true }) } catch (_error) {}
    }
  }
}

async function readOpencodeDbWithRetry(rollout, dbPath, previousCursor) {
  let lastError = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return rollout.readOpencodeDbMessagesIncremental(dbPath, previousCursor)
    } catch (error) {
      lastError = error
      if (!isSqliteBusyError(error)) throw error
      await sleep(150 * (attempt + 1))
    }
  }
  const snapshot = snapshotOpencodeDb(dbPath)
  try {
    return rollout.readOpencodeDbMessagesIncremental(snapshot.path, previousCursor)
  } catch (error) {
    throw lastError || error
  } finally {
    snapshot.cleanup()
  }
}

function num(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

async function runScan({ source, files, cursors, queuePath, onProgress } = {}) {
  if (typeof source !== 'string' || !source) throw new Error('usage scan worker requires a source')
  const parser = PARSERS[source]
  if (!parser) throw new Error(`unsupported usage source: ${source}`)
  if (!Array.isArray(files)) throw new Error('usage scan worker requires a file list')
  if (!cursors || typeof cursors !== 'object') throw new Error('usage scan worker requires cursors')
  if (typeof queuePath !== 'string' || !queuePath) throw new Error('usage scan worker requires a queue path')

  const rollout = getRolloutModule()
  const upserts = []
  const previousKeys = cursors.hourly && typeof cursors.hourly === 'object' && cursors.hourly.buckets && typeof cursors.hourly.buckets === 'object'
    ? Object.keys(cursors.hourly.buckets)
    : []

  // Progress is throttled to <= 4 messages/s (plan §2.7); the final progress is
  // always emitted by the result message itself.
  let lastProgressAt = 0
  const progressSink = typeof onProgress === 'function'
    ? (progress) => {
        const now = Date.now()
        if (now - lastProgressAt < 250) return
        lastProgressAt = now
        onProgress({ ...progress, filesTotal: Array.isArray(files) ? files.length : 0 })
      }
    : null

  rollout.setBucketSink(async (rows, meta) => {
    if (!meta || meta.kind === 'usage') {
      for (const row of Array.isArray(rows) ? rows : []) upserts.push(row)
    }
  })

  let stats
  try {
    stats = await parser(rollout, { files, cursors, queuePath, onProgress: progressSink })
  } finally {
    rollout.setBucketSink(null)
  }

  const finalHourly = cursors.hourly || null
  const removed = diffRemovedKeys(previousKeys, finalHourly)

  return {
    upserts,
    removed,
    cursors,
    stats: {
      files: Array.isArray(files) ? files.length : 0,
      eventsAggregated: num(stats?.eventsAggregated),
      bucketsQueued: num(stats?.bucketsQueued),
      rows: upserts.length
    }
  }
}

function handleMessage(rawMessage) {
  const message = rawMessage && typeof rawMessage === 'object' && rawMessage.data !== undefined && rawMessage.type === undefined
    ? rawMessage.data
    : rawMessage
  if (!message || typeof message !== 'object') return
  if (message.type === 'shutdown') {
    try { process.exit(0) } catch {}
    return
  }
  if (message.type !== 'scan') return
  const id = message.id
  const request = message.request && typeof message.request === 'object' ? message.request : {}
  runScan({
    ...request,
    onProgress: (progress) => send({ type: 'progress', id, progress })
  })
    .then((result) => send({ type: 'result', id, result }))
    .catch((error) => send({ type: 'error', id, message: error?.message || String(error) }))
}

const port = parentPort()
if (port && typeof port.on === 'function') {
  port.on('message', handleMessage)
  send({ type: 'ready', pid: process.pid, startedAt: Date.now() })
}

module.exports = {
  PARSERS,
  handleMessage,
  runScan
}
