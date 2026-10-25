'use strict'

// Export result registry (feature A, docs/plans/2026-10-25-snow-apps-feature-development-plan.md
// §4.1/§4.2). A producer that just wrote a file to disk (image-file-save's saveImageBuffer,
// pdf-export's savePdfBuffer, the recognition workbook/PDF exports) hands the resulting path
// here ONCE. From then on the file is addressed by `resultId`: a renderer result bar or the tray
// sends `{ resultId, action }`, never a path, so "open / copy its address / reveal it" cannot be
// turned into a generic "open any path for me" primitive by a compromised renderer.
//
// Invariants (plan §4.2, §3.2):
//   1. A `{ status: 'saved' }` receipt only claims the file was written. Whether a document was
//      committed is a different return value and is never inferred from here.
//   2. The receipt is EXACTLY `{ status, resultId, fileName, kind }` - no `filePath`. A renderer
//      addresses results by `resultId` only, so it never receives (or can supply) a path; the
//      absolute path stays main-process-only in the `entries` map. This is also why the tray and
//      `perform` are the only consumers that ever touch a path.
//   3. Ownership: only the window that registered a result may act on it. The tray (ownerId
//      null / 'tray') is main-process internal and may act on the newest live result - exactly
//      what `latestFor()` returns - but cannot address an older entry.
//   4. Expiry is lazy: entries are evaluated against the injected `now()` on read/perform and
//      capped to `maxEntries` on write. Dropping a reference NEVER deletes the user's file.
//   5. Every action re-checks that the file still exists and still has the registered kind's
//      extension before it touches the system: a result that was moved, replaced or overwritten
//      is reported as gone instead of opening somebody else's file at the same path.
//
// No Electron import at module scope: shell / clipboard / fs / path are injected, so this module
// loads in plain node (unit tests) and main.js passes the real modules. The frozen error-code
// vocabulary is `result-expired | file-missing | invalid-owner | open-failed | unknown-action`;
// an unexpected OS failure in a non-open action is reported through `open-failed` (the single
// "the system refused the action" code in that vocabulary) and the real cause goes to `log`.

const crypto = require('node:crypto')
const defaultFs = require('node:fs')
const defaultPath = require('node:path')

const EXPORT_KINDS = Object.freeze(['png', 'pdf', 'xlsx', 'mp4', 'gif'])
const EXPORT_EXTENSIONS = Object.freeze({
  png: '.png',
  pdf: '.pdf',
  xlsx: '.xlsx',
  mp4: '.mp4',
  gif: '.gif'
})
const EXPORT_ACTIONS = Object.freeze(['open', 'copy-path', 'reveal'])
// Plan §3.3: the registry is metadata only - 50 entries, 15 minutes each, tray shows the newest.
const DEFAULT_MAX_ENTRIES = 50
const DEFAULT_TTL_MS = 15 * 60 * 1000
// Main-process tray scope. A concrete window owner id can never be this string because
// `ownerScope` reads it as the tray scope first.
const TRAY_OWNER = 'tray'
const MAX_REQUEST_ID_LENGTH = 128
const MAX_SOURCE_LENGTH = 64

// Caller scope: 'tray' for the main-process tray (null / undefined / 'tray'), the concrete owner
// id for a window, or '' for anything unusable (an object, a symbol, an empty string). The empty
// return is what makes a malformed ownerId fail closed instead of silently becoming the tray.
function ownerScope(value) {
  if (value === null || value === undefined) return TRAY_OWNER
  const text = typeof value === 'string'
    ? value.trim()
    : (typeof value === 'number' && Number.isFinite(value) ? String(value) : '')
  if (!text) return ''
  return text === TRAY_OWNER ? TRAY_OWNER : text
}

// The owner id a receipt carries: null when the main process/tray owns the entry, so a renderer
// never sees the internal tray scope string.
function storedOwnerId(value) {
  const scope = ownerScope(value)
  if (!scope || scope === TRAY_OWNER) return null
  return scope
}

function normalizeText(value, limit) {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, limit)
}

class ExportResultService {
  constructor({
    now = Date.now,
    path: pathImpl = defaultPath,
    fs: fsImpl = defaultFs,
    shell,
    clipboard,
    log = () => {},
    maxEntries = DEFAULT_MAX_ENTRIES,
    ttlMs = DEFAULT_TTL_MS,
    createId = () => `export-${crypto.randomUUID()}`
  } = {}) {
    if (typeof now !== 'function') throw new TypeError('Export result service requires a now() clock')
    if (!pathImpl || typeof pathImpl.resolve !== 'function' || typeof pathImpl.basename !== 'function' ||
        typeof pathImpl.extname !== 'function') {
      throw new TypeError('Export result service requires a path module')
    }
    if (!fsImpl || typeof fsImpl.existsSync !== 'function') {
      throw new TypeError('Export result service requires a file system')
    }
    if (!shell || typeof shell.openPath !== 'function' || typeof shell.showItemInFolder !== 'function') {
      throw new TypeError('Export result service requires a shell')
    }
    if (!clipboard || typeof clipboard.writeText !== 'function') {
      throw new TypeError('Export result service requires a clipboard')
    }
    if (typeof createId !== 'function') throw new TypeError('Export result service requires createId')
    this.now = now
    this.path = pathImpl
    this.fs = fsImpl
    this.shell = shell
    this.clipboard = clipboard
    this.log = typeof log === 'function' ? log : () => {}
    const entriesLimit = Math.round(Number(maxEntries))
    this.maxEntries = Number.isFinite(entriesLimit) && entriesLimit >= 1 ? entriesLimit : DEFAULT_MAX_ENTRIES
    const ttl = Number(ttlMs)
    this.ttlMs = Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_TTL_MS
    this.createId = createId
    // Insertion order is registration order: eviction drops the first key, `latestFor` reads the
    // last value, and `list` reverses it. One structure, no separate ordering bookkeeping.
    this.entries = new Map()
    // requestId replay index (`<owner>\u0000<requestId>` -> resultId) so a retried save returns the
    // same receipt instead of registering the same file twice.
    this.requests = new Map()
    this.disposed = false
  }

  // ---------- Clock, pruning, capacity ----------

  clock() {
    const value = Number(this.now())
    return Number.isFinite(value) ? value : Date.now()
  }

  prune(nowMs) {
    for (const [resultId, entry] of [...this.entries]) {
      if (nowMs - entry.registeredAt >= this.ttlMs) {
        this.entries.delete(resultId)
        this.log('Export result expired:', resultId)
      }
    }
  }

  enforceCapacity() {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next()
      if (oldest.done) return
      this.entries.delete(oldest.value)
      this.log('Export result evicted (maxEntries reached):', oldest.value)
    }
  }

  newestEntry() {
    let newest = null
    for (const entry of this.entries.values()) newest = entry
    return newest
  }

  makeResultId() {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const candidate = String(this.createId() ?? '')
      if (candidate && !this.entries.has(candidate)) return candidate
    }
    // A fake createId that keeps colliding must not register under an existing id.
    return `export-${crypto.randomUUID()}`
  }

  // ---------- Receipts ----------

  // Public receipt, frozen by plan §4.2: `{ status, resultId, fileName, kind }` and nothing else.
  // Deliberately no `filePath` (renderers address results by id and must never see a path), and no
  // `registeredAt` / `ownerId` (internal ordering and ownership stay readable through `entries`).
  toReceipt(entry) {
    return {
      status: 'saved',
      resultId: entry.resultId,
      fileName: entry.fileName,
      kind: entry.kind
    }
  }

  // Existence probe. `statSync` is optional (a test double may only implement existsSync, and the
  // production fs always has it). An empty file is a failed/aborted write, not a saved result.
  inspectFile(filePath) {
    try {
      if (!this.fs.existsSync(filePath)) return { ok: false, reason: 'missing' }
      if (typeof this.fs.statSync === 'function') {
        const stats = this.fs.statSync(filePath)
        if (stats && typeof stats === 'object') {
          if (typeof stats.isFile === 'function' && !stats.isFile()) return { ok: false, reason: 'not-a-file' }
          if (Number.isFinite(stats.size) && stats.size <= 0) return { ok: false, reason: 'empty' }
        }
      }
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: error?.code || 'unreadable' }
    }
  }

  // ---------- register ----------

  // Registers a file this process just produced. NEVER throws: a cancelled save, a vanished or
  // empty file, or a caller bug all come back as `null` with a log line, because a result bar
  // must not appear for something that was not written (plan §4.2: a cancelled or failed export
  // never surfaces as a success receipt).
  register(payload) {
    if (this.disposed) {
      this.log('Export result registration ignored: service disposed')
      return null
    }
    try {
      // Destructured inside the try so a null/absent payload from a buggy producer is logged and
      // ignored instead of escaping as a TypeError.
      const { filePath, kind, source = '', ownerId = null, requestId = null } = payload || {}
      if (typeof filePath !== 'string' || !filePath.trim() || filePath.includes('\u0000')) {
        this.log('Export result registration ignored: invalid file path')
        return null
      }
      if (!EXPORT_KINDS.includes(kind)) {
        this.log('Export result registration ignored: unknown kind:', kind)
        return null
      }
      const absolutePath = this.path.resolve(filePath)
      const fileName = this.path.basename(absolutePath)
      if (!fileName || fileName === '.' || fileName === '..') {
        this.log('Export result registration ignored: path has no file name:', filePath)
        return null
      }
      const fileState = this.inspectFile(absolutePath)
      if (!fileState.ok) {
        this.log('Export result registration ignored:', fileState.reason, absolutePath)
        return null
      }
      // A kind/extension mismatch is a producer bug worth surfacing, but the save DID happen, so
      // the entry is still registered and the re-check in `perform` refuses to act on it later.
      const extension = this.path.extname(absolutePath).toLowerCase()
      if (extension !== EXPORT_EXTENSIONS[kind]) {
        this.log('Export result kind does not match the file extension:', kind, extension, absolutePath)
      }
      const registeredAt = this.clock()
      this.prune(registeredAt)
      const owner = storedOwnerId(ownerId)
      const requestKey = this.requestKey(owner, requestId)
      if (requestKey) {
        const replayed = this.replayRequest(requestKey, { absolutePath, kind })
        if (replayed) return this.toReceipt(replayed)
      }
      const entry = {
        resultId: this.makeResultId(),
        fileName,
        kind,
        filePath: absolutePath,
        registeredAt,
        ownerId: owner,
        source: normalizeText(source, MAX_SOURCE_LENGTH),
        requestId: normalizeText(requestId, MAX_REQUEST_ID_LENGTH)
      }
      this.entries.set(entry.resultId, entry)
      if (requestKey) this.requests.set(requestKey, entry.resultId)
      this.enforceCapacity()
      this.log('Export result registered:', entry.resultId, kind, entry.source || '-', absolutePath)
      return this.toReceipt(entry)
    } catch (error) {
      this.log('Export result registration failed:', error?.message || error)
      return null
    }
  }

  requestKey(owner, requestId) {
    const id = normalizeText(requestId, MAX_REQUEST_ID_LENGTH)
    if (!id) return ''
    return `${owner ?? ''}\u0000${id}`
  }

  replayRequest(requestKey, { absolutePath, kind }) {
    const resultId = this.requests.get(requestKey)
    if (!resultId) return null
    const entry = this.entries.get(resultId)
    // A retry after expiry/eviction is a new save: drop the stale index and register normally.
    if (!entry || entry.kind !== kind || entry.filePath !== absolutePath) {
      this.requests.delete(requestKey)
      return null
    }
    return entry
  }

  // ---------- perform ----------

  ownerMayAct(entry, ownerId) {
    const scope = ownerScope(ownerId)
    if (!scope) return false
    if (scope === TRAY_OWNER) {
      // The tray may act on the newest live result (what `latestFor()` handed it), not on an
      // arbitrary older one it never saw.
      const newest = this.newestEntry()
      return !!newest && newest.resultId === entry.resultId
    }
    return entry.ownerId === scope
  }

  // Executes one system action for a registered result. `ownerId` must be derived by the caller
  // from the transport identity (BrowserWindow / webContents id), never from renderer payload -
  // this service can only compare ids, not authenticate a sender.
  async perform({ resultId, action, ownerId } = {}) {
    if (this.disposed) return { status: 'failed', code: 'result-expired' }
    const requestedAction = typeof action === 'string' ? action.trim() : ''
    if (!EXPORT_ACTIONS.includes(requestedAction)) return { status: 'failed', code: 'unknown-action' }
    const id = typeof resultId === 'string' ? resultId.trim() : ''
    this.prune(this.clock())
    const entry = id ? this.entries.get(id) : undefined
    // Unknown and expired ids are deliberately indistinguishable: a renderer cannot probe which
    // resultIds exist, and both mean "this reference is no longer actionable".
    if (!entry) return { status: 'failed', code: 'result-expired' }
    if (!this.ownerMayAct(entry, ownerId)) {
      this.log('Export result action rejected: owner mismatch', id)
      return { status: 'failed', code: 'invalid-owner' }
    }
    try {
      if (!this.fs.existsSync(entry.filePath)) {
        this.log('Export result action rejected: file missing', entry.filePath)
        return { status: 'failed', code: 'file-missing' }
      }
      const extension = this.path.extname(entry.filePath).toLowerCase()
      if (extension !== EXPORT_EXTENSIONS[entry.kind]) {
        this.log('Export result action rejected: file is no longer the registered kind', entry.kind, entry.filePath)
        return { status: 'failed', code: 'file-missing' }
      }
      if (requestedAction === 'open') {
        const message = await this.shell.openPath(entry.filePath)
        if (message) {
          this.log('Export result open failed:', message, entry.filePath)
          return { status: 'failed', code: 'open-failed' }
        }
        return { status: 'done' }
      }
      if (requestedAction === 'copy-path') {
        this.clipboard.writeText(this.path.resolve(entry.filePath))
        return { status: 'done' }
      }
      this.shell.showItemInFolder(entry.filePath)
      return { status: 'done' }
    } catch (error) {
      // The vocabulary has no generic 'action-failed' code, so an unexpected throw (a clipboard
      // failure on copy-path, a reveal the shell rejects) is reported as 'open-failed'; the log
      // line carries the action and resultId so the real cause is diagnosable from a bug report.
      this.log('Export result action failed:', requestedAction, id, error?.message || error)
      return { status: 'failed', code: 'open-failed' }
    }
  }

  // ---------- reads ----------

  // Newest not-expired receipt for one owner, or the newest overall for the tray when called
  // without an owner. Existence is re-checked by `perform`, not here: the tray may briefly show
  // a result whose file was removed, and that action then reports 'file-missing'.
  latestFor(ownerId) {
    if (this.disposed) return null
    this.prune(this.clock())
    const scope = ownerScope(ownerId)
    if (!scope) return null
    if (scope === TRAY_OWNER) {
      const newest = this.newestEntry()
      return newest ? this.toReceipt(newest) : null
    }
    let found = null
    for (const entry of this.entries.values()) {
      if (entry.ownerId === scope) found = entry
    }
    return found ? this.toReceipt(found) : null
  }

  // Newest first; test/debug surface.
  list() {
    if (this.disposed) return []
    this.prune(this.clock())
    return [...this.entries.values()].reverse().map((entry) => this.toReceipt(entry))
  }

  // Drops one owner's references (window destroyed). Returns the number dropped. The tray scope
  // cannot be revoked: it has no window lifecycle and is already bounded by maxEntries/ttl.
  // The requestId replay index is cleaned in the same pass, so a revoked owner's retried requestId
  // starts a fresh save instead of resolving to a reference that no longer exists.
  revokeOwner(ownerId) {
    if (this.disposed) return 0
    const scope = ownerScope(ownerId)
    if (!scope || scope === TRAY_OWNER) {
      this.log('Export result revoke ignored: an owner id is required')
      return 0
    }
    let removed = 0
    for (const [resultId, entry] of [...this.entries]) {
      if (entry.ownerId !== scope) continue
      this.entries.delete(resultId)
      removed += 1
    }
    if (removed) {
      // Only this owner's replays: `${owner}\u0000${requestId}`, matching requestKey().
      const prefix = `${scope}\u0000`
      for (const key of [...this.requests.keys()]) {
        if (key.startsWith(prefix)) this.requests.delete(key)
      }
      this.log('Export result references revoked:', scope, removed)
    }
    return removed
  }

  // Expiry is evaluated lazily, so there is no timer to clear; dispose only drops the registry so
  // a quitting app keeps no file paths alive.
  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.entries.clear()
    this.requests.clear()
  }
}

function createExportResultService(options) {
  return new ExportResultService(options)
}

module.exports = {
  DEFAULT_MAX_ENTRIES,
  DEFAULT_TTL_MS,
  EXPORT_ACTIONS,
  EXPORT_EXTENSIONS,
  EXPORT_KINDS,
  ExportResultService,
  createExportResultService,
  ownerScope,
  storedOwnerId
}
