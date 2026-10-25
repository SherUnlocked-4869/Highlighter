'use strict'

// Persistence for editable documents and their revisions (design §6.5.2 file layout /
// §6.5.4 commit protocol / §6.5.5 multi-file publish / §6.6 lifecycle). The full rationale is
// in docs/plans/2026-10-25-history-reedit-redesign.md and the frozen interface in
// docs/plans/2026-10-25-history-reedit-batch0-contracts.md; this header only records what the
// code below cannot express on its own.
//
// HistoryService still owns the flat one-record index (`captureHistory`) and the compatibility
// fields `filePath`/`thumbnailPath`; this module adds document/revision fields to those same
// entries and writes editable content into the controlled layout under
// `history/documents/<documentId>/`.
//
// Why one shared index array: every existing consumer (list, open, copy, address, image/PDF
// export) reads `filePath`. A second index would force each of them to read two places and merge
// them itself, turning the "item.id === documentId during the compatibility period" promise into
// a special case at every call site. Sharing the one index and keeping `filePath` an alias for
// the current head's result means no consumer changes at all (§6.5.7).
//
// Atomicity (§6.5.5 step 5): switching the index is the ONLY point at which a revision becomes
// visible. Publishing is stage -> rename into the final path -> switch the index last, so a
// failure at any step cannot make a half-written revision visible. `recoverIndex()` rebuilds an
// index that was emptied or lost from the backup written after the last commit.
//
// Invariants:
//   1. The renderer never names a path or an asset id - everything is derived here from the
//      controlled root plus the document/revision ids.
//   2. Commit, delete and retention pruning for one document are serialised through a
//      per-document queue, so the head cannot race.
//   3. In an index entry `filePath` === the current head's result; the base image exists only
//      to rebuild the editor.
//   4. The previous head's files are never deleted before the new head is published.
//   5. requestId is idempotent: a retry returns the same result and adds no revision.

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const documentApi = require('../../shared/capture-document')
const { readPngSize } = require('./capture-geometry')

// Index backup file. It lives in the history directory rather than beside config's store file,
// where the two would interfere with each other.
const INDEX_BACKUP_FILE = '.capture-index-backup.json'
const STAGING_DIRECTORY = '.staging'
// Cap on retained idempotency receipts: wide enough to cover the active window of a "lost
// confirmation, then retry" round trip, bounded so it cannot grow without limit (§4.2).
const MAX_RECEIPTS_PER_DOCUMENT = 32
const DEFAULT_REVISION_LIMIT = 20

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof ArrayBuffer) return Buffer.from(value)
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  return Buffer.alloc(0)
}

class CaptureDocumentService {
  constructor({
    fs: fsImpl = fs,
    path: pathImpl = path,
    historyService,
    getSettings,
    assertWritable = () => {},
    log = () => {},
    now = () => Date.now(),
    createId,
    // Thumbnail generation: defaults to nativeImage, the same mechanism HistoryService.persistThumbnail uses.
    makeThumbnail = null,
    readPngSize: readPngSizeImpl = readPngSize
  } = {}) {
    if (!historyService || !getSettings) throw new Error('CaptureDocumentService dependencies are incomplete')
    this.fs = fsImpl
    this.path = pathImpl
    this.historyService = historyService
    this.getSettings = getSettings
    this.assertWritable = assertWritable
    this.log = log
    this.now = now
    this.createId = createId || (() => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    this.makeThumbnail = makeThumbnail
    this.readPngSize = readPngSizeImpl
    // Per-document serial queue: commit, delete and retention pruning cannot mutate the same
    // head concurrently.
    this._queues = new Map()
    // In-process idempotency table, `${sessionId}:${requestId}` -> commit result. The receipts
    // stored on the index entries are the durable truth; this table only covers the two windows
    // in which no receipt can exist yet - create, where there is no entry to attach one to, and
    // the moment after the index commit when the receipt may not have reached disk.
    this._recentRequests = new Map()
    // Session table: sessionId -> { documentId, intent, headRevisionId, windowId, createdAt, allowedAssets }
    this._sessions = new Map()
  }

  // ---------- Paths ----------

  historyRoot() {
    const settings = this.getSettings() || {}
    const directory = settings?.screenshot?.historyDirectory || this.historyService.defaultHistoryDirectory
    this.historyService.ensureDirectory(directory)
    return directory
  }

  // Document root: controlled root + document id. The id is already constrained to a safe
  // character set by normalizeResourceId; rejecting path separators and `..` again here is
  // defence in depth, because this is the only place where a directory name is concatenated.
  documentDirectory(documentId) {
    const id = String(documentId || '')
    if (!documentApi.RESOURCE_ID_PATTERN.test(id)) throw new Error(`非法文档 id：${id}`)
    return this.path.join(this.historyRoot(), 'documents', id)
  }

  // File role names (§6.5.2): callers receive only these names, never an arbitrary path.
  pathsFor(documentId, revisionId, baseImageId) {
    const base = this.documentDirectory(documentId)
    const relative = {
      base: (assetId) => this.path.posix.join('base', `${assetId}.png`),
      attachment: (assetId) => this.path.posix.join('assets', `${assetId}.png`),
      doc: this.path.posix.join('revisions', `${revisionId}.doc.json`),
      result: this.path.posix.join('revisions', `${revisionId}.result.png`),
      thumb: this.path.posix.join('revisions', `${revisionId}.thumb.png`)
    }
    return {
      directory: base,
      relative,
      resolved: {
        base: (assetId) => this.path.join(base, 'base', `${assetId}.png`),
        attachment: (assetId) => this.path.join(base, 'assets', `${assetId}.png`),
        doc: this.path.join(base, 'revisions', `${revisionId}.doc.json`),
        result: this.path.join(base, 'revisions', `${revisionId}.result.png`),
        thumb: this.path.join(base, 'revisions', `${revisionId}.thumb.png`)
      },
      baseImageId: baseImageId || null
    }
  }

  // ---------- Index read/write ----------

  readIndex() {
    return this.historyService.readHistory()
  }

  findEntry(documentId) {
    const id = String(documentId || '')
    return this.readIndex().find((entry) => this.entryDocumentId(entry) === id) || null
  }

  // Compatibility period: legacy entries have no documentId, so `id` is the fallback
  // (§6.5.1, "item.id === documentId").
  entryDocumentId(entry) {
    return String(entry?.documentId || entry?.id || '')
  }

  // Index switch = the only commit point. Write the main index, then on success write the NEW
  // index to the backup as the last-known-good recovery source. On failure try to write the
  // previous index back, so the index ends up either old or new and never in between.
  publishIndex(nextHistory) {
    const backupPath = this.path.join(this.historyRoot(), INDEX_BACKUP_FILE)
    let previous = null
    try {
      previous = this.readIndex()
    } catch {
      previous = null
    }
    try {
      this.historyService.writeHistory(nextHistory)
    } catch (error) {
      // Main index write failed: put the previous index back, so it is either old or new and
      // never in between.
      if (previous) {
        try {
          this.historyService.writeHistory(previous)
        } catch (restoreError) {
          this.log('Capture index restore failed:', restoreError.message)
        }
      }
      throw error
    }
    // Refresh the backup after a successful commit. A failed backup must not block the commit,
    // but it must leave a trace: recovery capability degrades, the save itself does not fail.
    try {
      this.fs.writeFileSync(backupPath, JSON.stringify({ at: this.now(), history: nextHistory }), 'utf8')
    } catch (error) {
      this.log('Capture index backup failed:', error.message)
    }
    return true
  }

  // Startup recovery (§6.5.5): restore from the backup when the index is damaged or missing, and
  // return the action taken so diagnostics can report it. A readable backup alone does not prove
  // the current index is damaged; the recoverable signal is an empty main index with a non-empty
  // backup.
  recoverIndex() {
    const backupPath = this.path.join(this.historyRoot(), INDEX_BACKUP_FILE)
    let backup = null
    try {
      backup = JSON.parse(this.fs.readFileSync(backupPath, 'utf8'))
    } catch {
      return { recovered: false, reason: 'no-backup' }
    }
    if (!isPlainObject(backup) || !Array.isArray(backup.history)) {
      return { recovered: false, reason: 'bad-backup' }
    }
    const current = this.readIndex()
    // Any entry left in the current index means it is healthy; an empty array while the backup is
    // non-empty means the main index was emptied or damaged.
    if (current.length || !backup.history.length) return { recovered: false, reason: 'healthy' }
    this.historyService.writeHistory(backup.history)
    this.log('Capture index recovered from backup:', backup.history.length)
    return { recovered: true, reason: 'restored', count: backup.history.length }
  }

  // ---------- Serialisation ----------

  async withDocumentLock(documentId, task) {
    const key = String(documentId || '')
    const previous = this._queues.get(key) || Promise.resolve()
    const run = previous.then(() => task(), () => task())
    // The queue itself must not reject later tasks just because one task failed.
    this._queues.set(key, run.then(() => undefined, () => undefined))
    try {
      return await run
    } finally {
      if (this._queues.get(key) === undefined) this._queues.delete(key)
    }
  }

  // ---------- Sessions ----------

  // Called when the editor is created: binds the sending window, source, document and head.
  // Afterwards the renderer only sends the sessionId back.
  beginSession({ documentId = '', intent = 'create', windowId = null, source = 'region' } = {}) {
    const sessionId = `session-${this.createId()}`
    let entry = null
    if (documentId) {
      entry = this.findEntry(documentId)
      // May a session open the id of a deleted document? No - the entry point checks existence first.
      if (!entry) return { ok: false, code: 'deleted' }
    }
    const session = {
      sessionId,
      intent,
      documentId: entry ? this.entryDocumentId(entry) : '',
      headRevisionId: entry ? String(entry.revisionId || entry.headRevisionId || '') : '',
      version: entry ? this.entryVersion(entry) : 0,
      windowId,
      source,
      createdAt: this.now()
    }
    this._sessions.set(sessionId, session)
    return { ok: true, session }
  }

  getSession(sessionId) {
    return this._sessions.get(String(sessionId || '')) || null
  }

  endSession(sessionId) {
    this._sessions.delete(String(sessionId || ''))
  }

  entryVersion(entry) {
    const version = Number(entry?.version)
    if (Number.isFinite(version) && version > 0) return Math.round(version)
    // Legacy entries have no version yet: a revisionId means revision 1, and its absence also
    // means revision 1 (established by the first upgrade).
    return 1
  }

  // ---------- Loading ----------

  // Open a document for the editor: returns { document, baseImagePath, resultImagePath } or an
  // explicit degradation signal. Legacy entries (no docPath) carry the legacy flag, and the
  // caller decides whether to upgrade them lazily (§6.7).
  loadDocument(documentId, revisionId = '') {
    const entry = this.findEntry(documentId)
    if (!entry) return { ok: false, code: 'deleted' }
    const id = this.entryDocumentId(entry)
    const headRevisionId = String(entry.revisionId || entry.headRevisionId || '')
    const targetRevision = String(revisionId || headRevisionId || '')
    if (!entry.docPath || !targetRevision) {
      return {
        ok: true,
        legacy: true,
        documentId: id,
        storageFormat: entry.storageFormat || 'legacy-bitmap',
        resultImagePath: entry.filePath || '',
        width: Number(entry.width) || 0,
        height: Number(entry.height) || 0
      }
    }
    const docPath = targetRevision === headRevisionId
      ? String(entry.docPath)
      : this.pathsFor(id, targetRevision).resolved.doc
    let payload
    try {
      payload = this.fs.readFileSync(docPath)
    } catch (error) {
      // The doc is gone: recover bitmap-only, explicitly, and never guess annotations (§6.5.7).
      return this.degradeToResult(entry, 'doc-missing', error)
    }
    const parsed = documentApi.parseDocument(payload)
    if (!parsed.ok) return this.degradeToResult(entry, parsed.code, null, parsed.errors)
    return {
      ok: true,
      legacy: false,
      storageFormat: 'editable-v1',
      documentId: id,
      revisionId: targetRevision,
      version: this.entryVersion(entry),
      document: parsed.document,
      baseImagePath: entry.baseImagePath || this.pathsFor(id, targetRevision, parsed.document.baseImage.assetId).resolved.base(parsed.document.baseImage.assetId),
      resultImagePath: targetRevision === headRevisionId ? String(entry.filePath || '') : this.pathsFor(id, targetRevision).resolved.result
    }
  }

  // Degrade: doc unusable but result intact -> bitmap-only recovery; result unusable too ->
  // explicit corruption. The base image is never returned as the result, under any circumstance
  // (§6.5.7).
  degradeToResult(entry, code, error, errors = []) {
    const resultPath = String(entry?.filePath || '')
    const readable = resultPath && this.fs.existsSync(resultPath)
    return {
      ok: !readable ? false : true,
      legacy: true,
      degraded: true,
      code: readable ? 'bitmap-only-recovery' : 'corrupted',
      reason: code,
      errors,
      documentId: this.entryDocumentId(entry),
      storageFormat: entry?.storageFormat || 'legacy-bitmap',
      resultImagePath: readable ? resultPath : '',
      width: Number(entry?.width) || 0,
      height: Number(entry?.height) || 0,
      message: error?.message || ''
    }
  }

  // Single entry point for every image consumer (§6.5.7). No call site may fall back to the base
  // image on its own when the result is missing.
  resolveCommittedResult(documentId, revisionId = '') {
    const entry = this.findEntry(documentId)
    if (!entry) return { ok: false, code: 'deleted' }
    const id = this.entryDocumentId(entry)
    const headRevisionId = String(entry.revisionId || entry.headRevisionId || '')
    const target = String(revisionId || headRevisionId || '')
    const filePath = !target || target === headRevisionId
      ? String(entry.filePath || '')
      : this.pathsFor(id, target).resolved.result
    if (!filePath || !this.fs.existsSync(filePath)) return { ok: false, code: 'result-missing', documentId: id, revisionId: target }
    return {
      ok: true,
      documentId: id,
      revisionId: target,
      filePath,
      width: Number(entry.width) || 0,
      height: Number(entry.height) || 0,
      longCapture: entry.longCapture === true
    }
  }

  // ---------- Commit ----------

  // The single commit path (§6.5.4). `status` distinguishes at least committed/unchanged/conflict/failed.
  async commit(payload = {}) {
    this.assertWritable()
    const settings = this.getSettings() || {}
    if (settings?.screenshot?.historyEnabled !== true) {
      // Report an explicit status; never claim history was saved (§6.5.4, last paragraph).
      return { ok: false, status: 'failed', code: 'history-disabled', retryable: false, historyStatus: 'disabled' }
    }
    const session = this.getSession(payload.sessionId)
    if (!session) return { ok: false, status: 'failed', code: 'session-expired', retryable: false }
    const intent = payload.intent
    if (!['create', 'update', 'save-copy'].includes(intent)) {
      return { ok: false, status: 'failed', code: 'invalid-intent', retryable: false }
    }
    const requestId = String(payload.requestId || '').slice(0, 128)
    if (!requestId) return { ok: false, status: 'failed', code: 'missing-request-id', retryable: false }

    // Validate the document before any write begins: a document that fails validation must not
    // start one.
    const snapshotBytes = toBuffer(payload.snapshot)
    if (!snapshotBytes.length) return { ok: false, status: 'failed', code: 'empty-snapshot', retryable: false }
    const parsed = documentApi.parseDocument(snapshotBytes)
    if (!parsed.ok) {
      return { ok: false, status: 'failed', code: parsed.code, retryable: false, errors: parsed.errors }
    }
    const resultBuffer = toBuffer(payload.resultBuffer)
    if (!resultBuffer.length) return { ok: false, status: 'failed', code: 'empty-result', retryable: false }
    const resultSize = this.readPngSize(resultBuffer)
    const { crop } = parsed.document
    if (!resultSize || resultSize.width !== crop.w || resultSize.height !== crop.h) {
      // The result image size must equal `crop` (§6.5.4: the renderer's result has to come from
      // the same frozen content state).
      return {
        ok: false,
        status: 'failed',
        code: 'result-size-mismatch',
        retryable: false,
        expected: { width: crop.w, height: crop.h },
        actual: resultSize
      }
    }

    // create needs a base image to establish the document; update/save-copy reuse the base bound
    // to the session.
    const newBaseBuffer = toBuffer(payload.newBaseBuffer)
    if (intent === 'create' && !newBaseBuffer.length) {
      return { ok: false, status: 'failed', code: 'missing-base-image', retryable: false }
    }

    // The main process generates new document ids; the renderer never names one. update reuses the
    // document bound to the session, and save-copy deliberately gets a NEW documentId: save-as is
    // an independent document with its own first revision (§6.5.1).
    const targetDocumentId = intent === 'create' || intent === 'save-copy'
      ? `document-${this.createId()}`
      : session.documentId
    if (intent === 'update' && !targetDocumentId) {
      return { ok: false, status: 'failed', code: 'session-expired', retryable: false }
    }

    return this.withDocumentLock(targetDocumentId, () => this._commitLocked({
      intent,
      requestId,
      session,
      documentId: targetDocumentId,
      snapshot: parsed.document,
      resultBuffer,
      resultSize,
      newBaseBuffer,
      attachmentBuffers: isPlainObject(payload.attachmentBuffers) ? payload.attachmentBuffers : {},
      expectedRevisionId: payload.expectedRevisionId === undefined ? null : payload.expectedRevisionId
    }))
  }

  async _commitLocked(options) {
    const {
      intent, requestId, session, documentId, snapshot, resultBuffer, resultSize,
      newBaseBuffer, attachmentBuffers, expectedRevisionId
    } = options
    const entry = this.findEntry(documentId)

    // The document is no longer visible: do not resurrect it automatically (§6.5.4). save-copy is
    // exempt because it creates a new document.
    if (intent !== 'create' && intent !== 'save-copy' && !entry) {
      return { ok: false, status: 'failed', code: 'deleted', retryable: false }
    }

    // Idempotency: a requestId that already committed returns the same result and adds no revision.
    // Two sources: the durable receipt on the entry (still valid after a restart) and the
    // in-process table, which covers the window in which create/save-copy have no entry to carry a
    // receipt yet - at that point the documentId does not exist, so the request is keyed by
    // sessionId + requestId.
    const recentKey = `${session.sessionId}:${requestId}`
    const previous = this.findReceipt(entry, requestId) || this._recentRequests.get(recentKey)
    if (previous) return Object.assign({ ok: true, replayed: true }, previous)

    const headRevisionId = entry ? String(entry.revisionId || entry.headRevisionId || '') : ''
    // Conflict check right before the final commit (§6.5.4; §6.5.5 step 4 checks once more).
    if (entry && intent === 'update') {
      const expected = expectedRevisionId === null || expectedRevisionId === undefined ? '' : String(expectedRevisionId)
      if (expected !== headRevisionId) {
        return {
          ok: false,
          status: 'conflict',
          documentId,
          headRevisionId,
          revisionId: headRevisionId,
          version: this.entryVersion(entry),
          expectedRevisionId: expected
        }
      }
    }

    // Resolve the base image: create supplies a new one, update/save-copy reuse the one of the
    // document being edited. save-copy's targetDocumentId is a NEW document, so it cannot be used
    // to look up the source entry; the base has to come from the source document bound to the
    // session (§6.5.2: save-as physically copies the base image for its first revision).
    const sourceEntry = intent === 'save-copy' ? this.findEntry(session.documentId) : entry
    if (intent === 'save-copy' && !sourceEntry) {
      return { ok: false, status: 'failed', code: 'deleted', retryable: false }
    }
    // First upgrade of a legacy flat entry (§6.7): it has no baseImageId, but its current result
    // PNG is exactly the revision-1 result, so it is kept as-is as an independent, immutable base
    // image - the original file is not rewritten and its pixels are not folded into the new result.
    const legacyBase = !newBaseBuffer.length && !sourceEntry?.baseImageId && entry
      ? this.readLegacyBase(entry)
      : Buffer.alloc(0)
    const baseAssetId = newBaseBuffer.length
      ? `base-${this.createId()}`
      : String(sourceEntry?.baseImageId || entry?.baseImageId || (legacyBase.length ? `base-${this.createId()}` : ''))
    if (!baseAssetId) {
      return { ok: false, status: 'failed', code: 'missing-base-image', retryable: false }
    }
    const baseImageBuffer = newBaseBuffer.length
      ? newBaseBuffer
      : legacyBase.length
        ? legacyBase
        : this.readExistingBase(sourceEntry || entry, baseAssetId)
    if (!baseImageBuffer.length) {
      return { ok: false, status: 'failed', code: 'base-missing', retryable: false }
    }
    const baseSize = this.readPngSize(baseImageBuffer)
    if (!baseSize) return { ok: false, status: 'failed', code: 'base-unreadable', retryable: false }

    // The base image size must match what the snapshot declares, otherwise the result image and
    // the base image would be misaligned.
    if (snapshot.baseImage.width !== baseSize.width || snapshot.baseImage.height !== baseSize.height) {
      return { ok: false, status: 'failed', code: 'base-size-mismatch', retryable: false }
    }
    if (cropWithinBase(snapshot.crop, baseSize) === false) {
      return { ok: false, status: 'failed', code: 'crop-out-of-bounds', retryable: false }
    }

    const revisionId = `revision-${this.createId()}`
    // Version: first creation = 1. When a legacy flat entry is upgraded for the first time, the
    // original PNG is already revision 1 (it is the current head's result, just not editable), so
    // the upgrade produces revision 2 - otherwise the UI would label edited content "version 1"
    // although the user has demonstrably edited it once.
    const previousVersion = entry ? this.entryVersion(entry) : 0
    const version = previousVersion > 0 && (intent === 'update' || intent === 'create')
      ? previousVersion + 1
      : 1
    // A new base image (first creation) or a legacy PNG just promoted to base (lazy upgrade) means
    // this revision is editable from here on.
    const storageFormat = newBaseBuffer.length || legacyBase.length
      ? 'editable-v1'
      : (entry?.storageFormat === 'editable-v1' ? 'editable-v1' : (entry?.storageFormat || 'editable-v1'))

    // Seal the document: write the identity and assets allocated by the main process into it.
    // Note this starts from `snapshot` (the renderer's content) rather than from session fields
    // such as the version number: everything outside CONTENT_FIELDS
    // (documentId/revisionId/parentRevisionId/createdAt/view/source) never takes part in the
    // fingerprint, so this document can be used directly to decide whether the content changed.
    const document = Object.assign({}, snapshot, {
      documentId,
      revisionId,
      parentRevisionId: intent === 'update' ? headRevisionId || null : null,
      baseImage: { assetId: baseAssetId, width: baseSize.width, height: baseSize.height, sha256: sha256(baseImageBuffer) },
      // createdAt is assigned by the server; the renderer's clock is not trusted.
      createdAt: this.now(),
      // Save-as: derivedFrom only records provenance - it takes no part in revision grouping and
      // does not merge cards (§6.5.1). Use sourceEntry (the source document), not entry; the new
      // document does not exist yet.
      ...(intent === 'save-copy' && sourceEntry
        ? { derivedFrom: { documentId: this.entryDocumentId(sourceEntry), revisionId: String(sourceEntry.revisionId || sourceEntry.headRevisionId || '') } }
        : {})
    })

    // Content fingerprint: an update identical to head is `unchanged` - no new version, no files
    // written. This compares the document about to be written with the current head document, and
    // both carry a real baseImage reference.
    if (intent === 'update' && entry) {
      const headDocument = this.loadHeadDocument(entry)
      if (headDocument) {
        const nextFingerprint = documentApi.documentFingerprint(document)
        const headFingerprint = documentApi.documentFingerprint(headDocument)
        if (nextFingerprint === headFingerprint) {
          const unchanged = {
            status: 'unchanged',
            documentId,
            revisionId: headRevisionId,
            headRevisionId,
            version: this.entryVersion(entry),
            contentFingerprint: nextFingerprint
          }
          this.appendReceipt(documentId, requestId, unchanged)
          return Object.assign({ ok: true }, unchanged)
        }
      }
    }

    let documentBytes
    try {
      documentBytes = documentApi.serializeDocument(document)
    } catch (error) {
      return { ok: false, status: 'failed', code: error.code || 'document-too-large', retryable: false }
    }

    const published = this.publishRevision({
      documentId,
      revisionId,
      baseAssetId,
      baseImageBuffer,
      documentBytes,
      resultBuffer,
      attachmentBuffers,
      requestId
    })
    if (!published.ok) return published

    const contentFingerprint = documentApi.documentFingerprint(document)
    const nextEntry = {
      // Compatibility fields - the only ones consumers read
      id: documentId,
      filePath: published.resultPath,
      thumbnailPath: published.thumbPath,
      createdAt: entry ? Number(entry.createdAt) || this.now() : this.now(),
      updatedAt: this.now(),
      source: String(snapshot.source || (entry ? entry.source : 'capture')).slice(0, 64),
      action: intent === 'save-copy' ? 'save-copy' : (entry?.action || 'edit'),
      width: resultSize.width,
      height: resultSize.height,
      // Document/revision fields
      documentId,
      revisionId,
      headRevisionId: revisionId,
      parentRevisionId: document.parentRevisionId,
      version: Math.max(1, version),
      storageFormat,
      docPath: published.docPath,
      baseImagePath: published.basePath,
      baseImageId: baseAssetId,
      contentFingerprint,
      revisionLimit: this.revisionLimit(),
      ...(entry?.longCapture === true ? { longCapture: true } : {}),
      ...(document.derivedFrom ? { derivedFrom: document.derivedFrom } : {}),
      revisionCount: entry ? (Number(entry.revisionCount) || 1) + 1 : 1,
      receipts: this.nextReceipts(entry, requestId, {
        status: 'committed',
        documentId,
        revisionId,
        headRevisionId: revisionId,
        version: Math.max(1, version),
        contentFingerprint
      })
    }

    // Index switch = the only commit point. update keeps the card where it is; create/save-copy are
    // inserted at the head (§6.5.1: a plain update preserves the card's position, only new
    // documents and save-as go to the front).
    const history = this.readIndex()
    const index = history.findIndex((item) => this.entryDocumentId(item) === documentId)
    const next = index >= 0
      ? history.map((item, position) => (position === index ? nextEntry : item))
      : [nextEntry, ...history]
    const retained = this.applyRevisionRetention({
      documentId,
      entry: nextEntry,
      headRevisionId: revisionId
    })
    try {
      this.publishIndex(this.trimDocuments(next, headerLimit(this.getSettings())))
    } catch (error) {
      // Index write failed: reclaim the files just published and fall back to the old head, whose
      // files were never deleted.
      this.discardPublishedRevision(documentId, revisionId, baseAssetId, entry)
      return { ok: false, status: 'failed', code: 'index-publish-failed', retryable: true, message: error.message }
    }
    // Retention pruning runs after a successful commit; a pruning failure is logged separately and
    // does not overturn the successful save (§6.5.5 step 6).
    if (retained?.pruned?.length) this.gcPrunedRevisions(documentId, retained.pruned)

    const sessionUpdate = this.getSession(session.sessionId)
    if (sessionUpdate) {
      sessionUpdate.documentId = documentId
      sessionUpdate.headRevisionId = revisionId
      sessionUpdate.version = Math.max(1, version)
    }

    const committed = {
      ok: true,
      status: 'committed',
      documentId,
      revisionId,
      headRevisionId: revisionId,
      version: Math.max(1, version),
      contentFingerprint,
      storageFormat,
      resources: {
        baseImageId: baseAssetId,
        baseImagePath: published.basePath,
        docPath: published.docPath,
        resultPath: published.resultPath,
        thumbnailPath: published.thumbPath
      }
    }
    // In-process idempotency fallback: before the index commit, create/save-copy have no entry to
    // carry a receipt (the documentId does not exist yet), and after the index commit a crash can
    // still lose a receipt that has not reached disk. This table covers both windows, keyed by
    // session + requestId, because the session is stable across retries.
    this._recentRequests.set(`${session.sessionId}:${requestId}`, committed)
    if (this._recentRequests.size > 512) {
      const oldest = this._recentRequests.keys().next().value
      this._recentRequests.delete(oldest)
    }
    return committed
  }

  readExistingBase(entry, baseAssetId) {
    if (!entry) return Buffer.alloc(0)
    const candidates = [
      entry.baseImagePath,
      this.pathsFor(this.entryDocumentId(entry), String(entry.revisionId || ''), baseAssetId).resolved.base(baseAssetId)
    ].filter(Boolean)
    for (const candidate of candidates) {
      try {
        const buffer = this.fs.readFileSync(candidate)
        if (buffer.length) return buffer
      } catch {
        // try the next candidate
      }
    }
    return Buffer.alloc(0)
  }

  // Base image source for a legacy flat entry: its own result PNG. Returns an empty buffer when
  // unreadable, and the caller reports base-missing. Deliberately does NOT write any file here -
  // publishRevision owns persisting the base, so a failure there is reclaimed as a whole.
  readLegacyBase(entry) {
    const filePath = String(entry?.filePath || '')
    if (!filePath) return Buffer.alloc(0)
    try {
      return this.fs.readFileSync(filePath)
    } catch {
      return Buffer.alloc(0)
    }
  }

  loadHeadDocument(entry) {
    if (!entry?.docPath) return null
    try {
      const parsed = documentApi.parseDocument(this.fs.readFileSync(entry.docPath))
      return parsed.ok ? parsed.document : null
    } catch {
      return null
    }
  }

  // ---------- Multi-file publish ----------

  // staging -> validate -> publish into a unique, immutable final path. Returns the new paths, or
  // an explicit error on failure. Note this deliberately does NOT rely on a cross-directory rename
  // being atomic: a same-volume rename is best effort, and because a final path is unique per
  // revisionId, a repeated publish can only be an idempotent retry and never overwrites another
  // revision.
  publishRevision({
    documentId, revisionId, baseAssetId, baseImageBuffer, documentBytes,
    resultBuffer, attachmentBuffers
  }) {
    const stagingRoot = this.path.join(this.documentDirectory(documentId), STAGING_DIRECTORY)
    const staging = this.path.join(stagingRoot, revisionId)
    const finalDirectory = this.documentDirectory(documentId)
    const created = []
    try {
      this.fs.mkdirSync(this.path.join(staging, 'revisions'), { recursive: true })
      this.fs.mkdirSync(this.path.join(staging, 'base'), { recursive: true })
      this.fs.mkdirSync(this.path.join(finalDirectory, 'revisions'), { recursive: true })
      this.fs.mkdirSync(this.path.join(finalDirectory, 'base'), { recursive: true })

      const stagingDoc = this.path.join(staging, 'revisions', `${revisionId}.doc.json`)
      const stagingResult = this.path.join(staging, 'revisions', `${revisionId}.result.png`)
      const stagingBase = this.path.join(staging, 'base', `${baseAssetId}.png`)
      this.fs.writeFileSync(stagingDoc, documentBytes)
      this.fs.writeFileSync(stagingResult, resultBuffer)
      // The base image is immutable: write it only when absent (later revisions of the same
      // document reuse it).
      const finalBase = this.path.join(finalDirectory, 'base', `${baseAssetId}.png`)
      if (!this.fs.existsSync(finalBase)) this.fs.writeFileSync(stagingBase, baseImageBuffer)

      // Validate the staged output (byte length and decodable size); publish no final file at all
      // if that fails.
      const writtenDoc = this.fs.readFileSync(stagingDoc)
      if (writtenDoc.length !== documentBytes.length) throw new Error('文档写入字节数不一致')
      const writtenResult = this.fs.readFileSync(stagingResult)
      const writtenSize = this.readPngSize(writtenResult)
      if (!writtenSize || writtenSize.width < 1 || writtenSize.height < 1) throw new Error('结果图不可解码')

      const attachmentBuffersMap = isPlainObject(attachmentBuffers) ? attachmentBuffers : {}
      const attachmentPaths = {}
      for (const [key, value] of Object.entries(attachmentBuffersMap)) {
        const buffer = toBuffer(value)
        if (!buffer.length) continue
        const assetId = `asset-${revisionId}-${String(key).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32)}`
        this.fs.mkdirSync(this.path.join(finalDirectory, 'assets'), { recursive: true })
        const target = this.path.join(finalDirectory, 'assets', `${assetId}.png`)
        this.fs.writeFileSync(target, buffer)
        attachmentPaths[key] = target
      }

      const finalDoc = this.path.join(finalDirectory, 'revisions', `${revisionId}.doc.json`)
      const finalResult = this.path.join(finalDirectory, 'revisions', `${revisionId}.result.png`)
      this.fs.mkdirSync(this.path.dirname(finalDoc), { recursive: true })
      if (!this.fs.existsSync(finalBase)) {
        this.fs.renameSync(stagingBase, finalBase)
        created.push(finalBase)
      }
      this.fs.renameSync(stagingDoc, finalDoc)
      created.push(finalDoc)
      this.fs.renameSync(stagingResult, finalResult)
      created.push(finalResult)

      const thumbPath = this.persistThumbnail(finalResult, documentId, revisionId)
      if (thumbPath) created.push(thumbPath)

      return {
        ok: true,
        docPath: finalDoc,
        resultPath: finalResult,
        basePath: finalBase,
        thumbPath: thumbPath || '',
        attachmentPaths
      }
    } catch (error) {
      // Remove the final files published by this call; their ids are unique, so older revisions
      // are untouched.
      for (const filePath of created) {
        try {
          this.fs.unlinkSync(filePath)
        } catch {
          // best effort
        }
      }
      return { ok: false, status: 'failed', code: 'publish-failed', retryable: true, message: error.message }
    } finally {
      // Delete only this call's staging subdirectory, then drop the staging root if it is now
      // empty, so no `.staging` is left under the document directory.
      this.removeDirectory(staging)
      try {
        const root = this.path.join(this.documentDirectory(documentId), STAGING_DIRECTORY)
        if (this.fs.existsSync(root) && this.fs.readdirSync(root).length === 0) this.fs.rmdirSync(root)
      } catch {
        // The directory is not empty, or a concurrent cleanup got there first; leaving it does not
        // affect correctness.
      }
    }
  }

  discardPublishedRevision(documentId, revisionId, baseAssetId, previousEntry) {
    try {
      const directory = this.documentDirectory(documentId)
      for (const name of [`${revisionId}.doc.json`, `${revisionId}.result.png`, `${revisionId}.thumb.png`]) {
        const target = this.path.join(directory, 'revisions', name)
        if (this.fs.existsSync(target)) this.fs.unlinkSync(target)
      }
      // Reclaim the base image only when this call created it and the previous entry does not
      // reference one.
      if (!previousEntry?.baseImageId) {
        const base = this.path.join(directory, 'base', `${baseAssetId}.png`)
        if (this.fs.existsSync(base)) this.fs.unlinkSync(base)
      }
    } catch (error) {
      this.log('Discard published revision failed:', error.message)
    }
  }

  removeDirectory(directory) {
    try {
      this.fs.rmSync(directory, { recursive: true, force: true })
    } catch (error) {
      this.log('Remove staging failed:', error.message)
    }
  }

  persistThumbnail(resultPath, documentId, revisionId) {
    const target = this.path.join(this.documentDirectory(documentId), 'revisions', `${revisionId}.thumb.png`)
    try {
      if (typeof this.makeThumbnail === 'function') return this.makeThumbnail(resultPath, target) ? target : ''
      const image = this.historyService.nativeImage.createFromPath(resultPath)
      if (!image || image.isEmpty?.()) return ''
      const size = image.getSize()
      const width = Math.max(1, Math.min(360, Number(size.width) || 360))
      this.fs.writeFileSync(target, image.resize({ width, quality: 'good' }).toPNG())
      return target
    } catch (error) {
      // Thumbnails are rebuildable (§6.5.2), so a failure is only logged and does not affect the
      // commit.
      this.log('Document thumbnail failed:', error.message)
      return ''
    }
  }

  // ---------- Idempotency receipts ----------

  findReceipt(entry, requestId) {
    if (!entry || !Array.isArray(entry.receipts)) return null
    const receipt = entry.receipts.find((item) => String(item?.requestId || '') === requestId)
    if (!receipt) return null
    return {
      status: receipt.status || 'committed',
      documentId: receipt.documentId,
      revisionId: receipt.revisionId,
      headRevisionId: receipt.headRevisionId,
      version: receipt.version,
      contentFingerprint: receipt.contentFingerprint
    }
  }

  nextReceipts(entry, requestId, result) {
    const receipts = Array.isArray(entry?.receipts)
      ? entry.receipts.filter((item) => String(item?.requestId || '') !== requestId)
      : []
    return [{ requestId, at: this.now(), ...result }, ...receipts].slice(0, MAX_RECEIPTS_PER_DOCUMENT)
  }

  appendReceipt(documentId, requestId, result) {
    try {
      const history = this.readIndex()
      const index = history.findIndex((item) => this.entryDocumentId(item) === documentId)
      if (index < 0) return
      const entry = history[index]
      const next = history.map((item, position) => (position === index
        ? { ...item, receipts: this.nextReceipts(entry, requestId, result) }
        : item))
      this.historyService.writeHistorySilently(next)
    } catch (error) {
      this.log('Capture receipt write failed:', error.message)
    }
  }

  // Commit status lookup for a lost confirmation (§4.2). An expired request returns `expired`
  // explicitly and is never silently re-executed.
  commitStatus(payload = {}) {
    const documentId = String(payload.documentId || '')
    const requestId = String(payload.requestId || '')
    if (!requestId) return { ok: false, status: 'failed', code: 'missing-request-id' }
    const entry = documentId ? this.findEntry(documentId) : null
    const receipt = this.findReceipt(entry, requestId)
    if (receipt) return { ok: true, ...receipt, replayed: true }
    return { ok: false, status: 'expired', code: 'expired', requestId }
  }

  // ---------- Retention (§6.6) ----------

  revisionLimit() {
    const settings = this.getSettings() || {}
    const limit = Math.round(Number(settings?.screenshot?.historyRevisionLimit))
    // Defaults to 20, and a document always keeps at least its head (floor of 1).
    return Number.isFinite(limit) && limit > 0 ? Math.max(1, limit) : DEFAULT_REVISION_LIMIT
  }

  // Evict the oldest NON-head revisions and return the ones to GC; the caller reclaims them after
  // the index commit.
  applyRevisionRetention({ documentId, entry, headRevisionId }) {
    const limit = this.revisionLimit()
    const revisions = this.listRevisions(documentId)
    if (revisions.length <= limit) return { pruned: [] }
    const prunable = revisions.filter((revision) => revision.revisionId !== headRevisionId)
    const overBy = revisions.length - limit
    const pruned = prunable.slice(0, Math.max(0, overBy))
    return { pruned, limit }
  }

  gcPrunedRevisions(documentId, pruned) {
    for (const revision of pruned) {
      try {
        const paths = this.pathsFor(documentId, revision.revisionId)
        for (const target of [paths.resolved.doc, paths.resolved.result, paths.resolved.thumb]) {
          if (this.fs.existsSync(target)) this.fs.unlinkSync(target)
        }
      } catch (error) {
        this.log('Revision GC failed:', revision.revisionId, error.message)
      }
    }
  }

  // Scan revisions/ in the document directory for existing revisions - the disk is the truth, the
  // index only records the head.
  listRevisions(documentId) {
    const revisionsDirectory = this.path.join(this.documentDirectory(documentId), 'revisions')
    let entries = []
    try {
      entries = this.fs.readdirSync(revisionsDirectory, { withFileTypes: true })
    } catch {
      return []
    }
    const revisions = new Map()
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const match = /^(revision-.+)\.(doc\.json|result\.png|thumb\.png)$/.exec(entry.name)
      if (!match) continue
      const revisionId = match[1]
      const revision = revisions.get(revisionId) || { revisionId, hasDoc: false, hasResult: false, hasThumb: false }
      if (match[2] === 'doc.json') revision.hasDoc = true
      if (match[2] === 'result.png') revision.hasResult = true
      if (match[2] === 'thumb.png') revision.hasThumb = true
      revisions.set(revisionId, revision)
    }
    return [...revisions.values()].sort((left, right) => left.revisionId.localeCompare(right.revisionId))
  }

  // Apply historyLimit by document count (§6.6: still counted per document, so repeated edits never
  // push other screenshots out).
  trimDocuments(history, limit) {
    const maximum = Math.max(10, Number(limit) || 200)
    if (history.length <= maximum) return history
    const kept = history.slice(0, maximum)
    const discarded = history.slice(maximum)
    for (const entry of discarded) {
      try {
        this.deleteDocumentFiles(this.entryDocumentId(entry))
      } catch (error) {
        this.log('Document retention cleanup failed:', this.entryDocumentId(entry), error.message)
      }
    }
    return kept
  }

  // ---------- Delete ----------

  deleteDocumentFiles(documentId) {
    try {
      const directory = this.documentDirectory(documentId)
      this.fs.rmSync(directory, { recursive: true, force: true })
      return true
    } catch (error) {
      this.log('Document directory delete failed:', documentId, error.message)
      return false
    }
  }

  // ---------- Statistics ----------

  // Count every referenced asset exactly once (§6.6: `filePath` and the thumbnail alone are not
  // enough).
  documentStats() {
    const history = this.readIndex()
    const seen = new Set()
    let totalBytes = 0
    let documentCount = 0
    let revisionCount = 0
    let editableCount = 0
    let bitmapOnlyCount = 0
    for (const entry of history) {
      documentCount++
      const id = this.entryDocumentId(entry)
      const revisions = this.listRevisions(id)
      revisionCount += Math.max(1, revisions.length)
      if (entry.storageFormat === 'editable-v1') editableCount++
      else if (entry.storageFormat === 'bitmap-only') bitmapOnlyCount++
      const files = [entry.filePath, entry.thumbnailPath, entry.docPath, entry.baseImagePath]
      for (const revision of revisions) {
        const paths = this.pathsFor(id, revision.revisionId)
        files.push(paths.resolved.doc, paths.resolved.result, paths.resolved.thumb)
      }
      for (const filePath of files) {
        if (!filePath || !this.fs.existsSync(filePath)) continue
        const normalized = this.path.resolve(filePath).toLocaleLowerCase()
        if (seen.has(normalized)) continue
        seen.add(normalized)
        try {
          totalBytes += this.fs.statSync(filePath).size
        } catch {
          // the file vanished between two calls
        }
      }
    }
    return { documentCount, revisionCount, editableCount, bitmapOnlyCount, totalBytes, fileCount: seen.size }
  }
}

function headerLimit(settings) {
  const limit = Number(settings?.screenshot?.historyLimit)
  return Number.isFinite(limit) && limit > 0 ? limit : 200
}

function cropWithinBase(crop, baseSize) {
  if (!isPlainObject(crop) || !baseSize) return false
  const right = Number(crop.x) + Number(crop.w)
  const bottom = Number(crop.y) + Number(crop.h)
  return Number(crop.x) >= 0 && Number(crop.y) >= 0 &&
    Number(crop.w) >= 1 && Number(crop.h) >= 1 &&
    right <= Number(baseSize.width) && bottom <= Number(baseSize.height)
}

// Assembly helper for main.js: keeps the dependency wiring out of the line-limited
// assembly file (main.js has a 1330-line architecture ceiling) while still being a plain
// factory the tests can call directly.
function createCaptureDocumentService(dependencies = {}) {
  return new CaptureDocumentService(dependencies)
}

module.exports = {
  CaptureDocumentService,
  createCaptureDocumentService,
  INDEX_BACKUP_FILE,
  MAX_RECEIPTS_PER_DOCUMENT,
  DEFAULT_REVISION_LIMIT,
  cropWithinBase,
  sha256
}
