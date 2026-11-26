const fs = require('fs')
const path = require('path')
const { ensureDirectory: ensureDirectorySync } = require('./fs-utils')
const { DATA_URL_PATTERN, DATA_URL_PREFIX } = require('./image-buffer')
const {
  CAPTURE_PREFIX,
  LONG_CAPTURE_PREFIX,
  OWNED_CAPTURE_FILE,
  OWNED_THUMBNAIL_FILE
} = require('./capture-naming')

const MAX_HISTORY_QUERY_LENGTH = 200
const MAX_HISTORY_BATCH_SIZE = 500
const DEFAULT_HISTORY_PAGE_SIZE = 40
const MAX_HISTORY_PAGE_SIZE = 100
// N02 (docs/reviews/2026-11-26-code-review-and-optimization-report.md section 5.2): the two
// search-only fields the filter above has always read. Tags stay a small, bounded list so the
// card UI and the query string cannot be flooded; OCR text is capped because it is a whole
// screenshot's worth of text and only ever searched, never rendered.
const MAX_HISTORY_TAG_LENGTH = 24
const MAX_HISTORY_TAG_COUNT = 8
const MAX_HISTORY_OCR_TEXT_LENGTH = 20000

function normalizeHistoryFilter(value = {}) {
  const filter = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const requestedLimit = Math.round(Number(filter.limit) || DEFAULT_HISTORY_PAGE_SIZE)
  return {
    query: String(filter.query || '').trim().slice(0, MAX_HISTORY_QUERY_LENGTH).toLocaleLowerCase(),
    source: String(filter.source || '').trim().slice(0, 64),
    cursor: String(filter.cursor || '').trim().slice(0, 128),
    limit: Math.max(1, Math.min(MAX_HISTORY_PAGE_SIZE, requestedLimit))
  }
}

// N02: tags are user input, so the write path owns their whole shape. A tag is a string,
// trimmed, with runs of whitespace collapsed; the list is de-duplicated case-insensitively
// (the search path compares lower-cased text), bounded per tag and per record. Anything else
// in the payload is ignored rather than rejected, so one bad entry cannot block an edit.
// A non-array payload is not a usable edit at all and returns null (callers treat that as
// "nothing was written").
function normalizeHistoryTags(value) {
  if (!Array.isArray(value)) return null
  const tags = []
  const seen = new Set()
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const tag = entry.trim().replace(/\s+/g, ' ').slice(0, MAX_HISTORY_TAG_LENGTH)
    if (!tag) continue
    const key = tag.toLocaleLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    tags.push(tag)
    if (tags.length >= MAX_HISTORY_TAG_COUNT) break
  }
  return tags
}

// N02: OCR text arrives from a renderer process boundary indirectly (the indexer), so the
// same normalization is applied on write: newlines are normalized and the length is capped.
function normalizeHistoryOcrText(value) {
  if (typeof value !== 'string') return ''
  return value.replace(/\r\n?/g, '\n').trim().slice(0, MAX_HISTORY_OCR_TEXT_LENGTH)
}

function matchesHistoryFilter(item, filter) {
  if (filter.source && item.source !== filter.source) return false
  if (!filter.query) return true
  const searchable = [
    item.source,
    item.action,
    path.basename(String(item.filePath || '')),
    ...(Array.isArray(item.tags) ? item.tags : []),
    item.ocrText
  ].filter(Boolean).join(' ').toLocaleLowerCase()
  return searchable.includes(filter.query)
}

function normalizeHistoryIds(value) {
  if (!Array.isArray(value)) throw new TypeError('历史记录 ID 必须是数组')
  if (value.length > MAX_HISTORY_BATCH_SIZE) throw new RangeError(`单次最多处理 ${MAX_HISTORY_BATCH_SIZE} 项历史记录`)
  return [...new Set(value
    .map((id) => String(id || '').trim().slice(0, 128))
    .filter(Boolean))]
}

function isOwnedHistoryFile(filePath) {
  const name = path.basename(String(filePath || ''))
  return OWNED_CAPTURE_FILE.test(name) || OWNED_THUMBNAIL_FILE.test(name)
}

function withoutFavorite(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item
  const { favorite: _favorite, ...historyItem } = item
  return historyItem
}

class HistoryService {
  constructor({
    store,
    nativeImage,
    sharp,
    getSettings,
    assertWritable,
    defaultHistoryDirectory,
    makeCaptureName,
    onChanged = () => {},
    log = () => {},
    now = () => Date.now(),
    createId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  }) {
    if (!store || !nativeImage || !getSettings) throw new Error('HistoryService dependencies are incomplete')
    this.store = store
    this.nativeImage = nativeImage
    this.sharp = sharp
    this.getSettings = getSettings
    this.assertWritable = assertWritable
    this.defaultHistoryDirectory = defaultHistoryDirectory
    this.makeCaptureName = makeCaptureName
    this.onChanged = onChanged
    this.log = log
    this.now = now
    this.createId = createId
    // H01: set by attachDocumentService() once the document service exists (main.js assembly).
    this.documentService = null
    // N02: set by attachOcrIndexer() once the background OCR indexer exists (main/ipc/index.js
    // assembly, which runs before initializeStore()). Only used to cancel pending recognition
    // work when a record is deleted.
    this.ocrIndexer = null
  }

  ensureDirectory(directory) {
    return ensureDirectorySync(directory)
  }

  readHistory() {
    const history = this.store.get('captureHistory', [])
    return Array.isArray(history) ? history.map(withoutFavorite) : []
  }

  writeHistory(history) {
    this.store.set('captureHistory', history.map(withoutFavorite))
    this.onChanged()
  }

  writeHistorySilently(history) {
    this.store.set('captureHistory', history.map(withoutFavorite))
  }

  historyImagePath(meta = {}) {
    const settings = this.getSettings()
    const directory = this.ensureDirectory(settings.screenshot.historyDirectory)
    const prefix = meta.longCapture ? LONG_CAPTURE_PREFIX : CAPTURE_PREFIX
    // History entries are screenshots, so they follow the same naming template as
    // an export (P0-7-T1). The recorder deliberately does not: it owns a separate
    // format until a dedicated key exists.
    return path.join(directory, this.makeCaptureName(prefix, 'png', { template: settings.screenshot.nameTemplate }))
  }

  deleteFiles(item) {
    if (!item) return
    if (item.thumbnailPath && fs.existsSync(item.thumbnailPath)) fs.unlinkSync(item.thumbnailPath)
    if (item.filePath && fs.existsSync(item.filePath)) fs.unlinkSync(item.filePath)
    // H01 (section 2.1.1): an editable capture owns a whole `history/documents/<documentId>/` tree
    // (base image plus every revision). The two flat files above are only the head preview, so
    // deleting just them left the tree — and usually the base image — on disk forever. The
    // document service owns that layout and its own error path (it logs and returns false
    // instead of throwing, so a stubborn tree cannot block the index update).
    this.deleteDocumentFiles(this.documentIdFor(item))
  }

  // H01: the document service is attached after construction because main.js creates the
  // history service first (the document service reads the index through this instance).
  attachDocumentService(service) {
    this.documentService = service && typeof service.deleteDocumentFiles === 'function' ? service : null
    return this
  }

  // N02: same late-attach shape as the document service. The indexer is assembled in
  // main/ipc/index.js while this service is only created inside initializeStore(), so the
  // IPC facade calls this on its first use. It is optional: without it, OCR results are still
  // dropped for deleted records (the indexer re-reads the record before writing), only the
  // in-flight cancellation is lost.
  attachOcrIndexer(indexer) {
    this.ocrIndexer = indexer && typeof indexer.discard === 'function' ? indexer : null
    return this
  }

  discardOcrIndexIds(ids) {
    const indexer = this.ocrIndexer
    if (!indexer || !Array.isArray(ids) || !ids.length) return
    for (const id of ids) {
      try {
        indexer.discard(String(id || ''))
      } catch (error) {
        this.log('History OCR discard failed:', String(id || ''), error?.message || String(error))
      }
    }
  }

  documentIdFor(item) {
    if (!item || typeof item !== 'object') return ''
    return String(item.documentId || item.id || '').slice(0, 128)
  }

  deleteDocumentFiles(documentId) {
    if (!this.documentService || !documentId) return false
    try {
      return this.documentService.deleteDocumentFiles(documentId) !== false
    } catch (error) {
      this.log('History document cleanup failed:', documentId, error?.message || String(error))
      return false
    }
  }

  // H01: bytes/files actually held by an orphaned document tree. The tree is nested
  // (base/, revisions/, assets/), so a flat readdir would report zero.
  directoryUsage(directory) {
    let bytes = 0
    let fileCount = 0
    const stack = [directory]
    while (stack.length) {
      const current = stack.pop()
      let entries = []
      try {
        entries = fs.readdirSync(current, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        const entryPath = path.join(current, entry.name)
        if (entry.isDirectory()) {
          stack.push(entryPath)
          continue
        }
        if (!entry.isFile()) continue
        try {
          bytes += fs.statSync(entryPath).size
          fileCount++
        } catch {
          // the file vanished between the two calls
        }
      }
    }
    return { bytes, fileCount }
  }

  thumbnailPath(id) {
    return path.join(this.ensureDirectory(this.defaultHistoryDirectory), `${String(id)}-thumb.png`)
  }

  persistThumbnail(image, id) {
    if (!image || image.isEmpty?.()) return ''
    const size = image.getSize()
    const width = Math.max(1, Math.min(360, Number(size.width) || 360))
    const thumbnail = image.resize({ width, quality: 'good' })
    const outputPath = this.thumbnailPath(id)
    fs.writeFileSync(outputPath, thumbnail.toPNG())
    return outputPath
  }

  ensureThumbnail(id) {
    const normalizedId = String(id || '').slice(0, 128)
    const history = this.readHistory()
    const index = history.findIndex((entry) => entry.id === normalizedId)
    if (index < 0) return ''
    const item = history[index]
    if (item.thumbnailPath && fs.existsSync(item.thumbnailPath)) return item.thumbnailPath
    if (!item.filePath || !fs.existsSync(item.filePath)) return ''
    try {
      this.assertWritable()
      const thumbnailPath = this.persistThumbnail(this.nativeImage.createFromPath(item.filePath), item.id)
      if (!thumbnailPath) return ''
      history[index] = { ...item, thumbnailPath }
      this.writeHistorySilently(history)
      return thumbnailPath
    } catch (error) {
      this.log('History thumbnail generation failed:', item.filePath, error.message)
      return ''
    }
  }

  getThumbnail(id) {
    const thumbnailPath = this.ensureThumbnail(id)
    if (!thumbnailPath) return ''
    try {
      return `${DATA_URL_PREFIX}${fs.readFileSync(thumbnailPath).toString('base64')}`
    } catch (error) {
      this.log('History thumbnail read failed:', thumbnailPath, error.message)
      return ''
    }
  }

  historyDirectories() {
    return [...new Set([
      this.getSettings().screenshot.historyDirectory,
      this.defaultHistoryDirectory
    ]
      .filter(Boolean)
      .map((directory) => path.resolve(directory)))]
  }

  referencedFilePaths(history = this.readHistory()) {
    const referenced = new Set()
    for (const item of history) {
      for (const filePath of [item?.filePath, item?.thumbnailPath]) {
        if (filePath) referenced.add(path.resolve(filePath).toLocaleLowerCase())
      }
    }
    return referenced
  }

  orphanFiles(history = this.readHistory()) {
    const referenced = this.referencedFilePaths(history)
    const orphans = []
    for (const directory of this.historyDirectories()) {
      if (!fs.existsSync(directory)) continue
      let entries = []
      try {
        entries = fs.readdirSync(directory, { withFileTypes: true })
      } catch (error) {
        this.log('History directory scan failed:', directory, error.message)
        continue
      }
      for (const entry of entries) {
        if (!entry.isFile()) continue
        const filePath = path.join(directory, entry.name)
        if (!isOwnedHistoryFile(filePath)) continue
        if (referenced.has(path.resolve(filePath).toLocaleLowerCase())) continue
        let size = 0
        try {
          size = fs.statSync(filePath).size
        } catch {
          continue
        }
        orphans.push({ filePath, size })
      }
    }
    // H01 (section 2.1.2): document trees are directories, and the flat scan above deliberately
    // skips them (`if (!entry.isFile()) continue`), so every orphaned `documents/<id>/` was
    // invisible to both cleanup and the size the settings page reports. A tree is an orphan
    // only when no history entry still carries its id.
    const referencedDocuments = new Set()
    for (const item of history) {
      const documentId = this.documentIdFor(item)
      if (documentId) referencedDocuments.add(documentId.toLocaleLowerCase())
    }
    for (const directory of this.historyDirectories()) {
      const documentsDirectory = path.join(directory, 'documents')
      let entries = []
      try {
        entries = fs.readdirSync(documentsDirectory, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (referencedDocuments.has(entry.name.toLocaleLowerCase())) continue
        const filePath = path.join(documentsDirectory, entry.name)
        const usage = this.directoryUsage(filePath)
        orphans.push({ filePath, size: usage.bytes, fileCount: usage.fileCount, isDirectory: true })
      }
    }
    return orphans
  }

  // H01: the document service counts the head result/thumbnail plus the base image and every
  // revision. When attached it is the authoritative byte count; summing the flat files too
  // would count the head images twice.
  readDocumentStats() {
    const service = this.documentService
    if (!service || typeof service.documentStats !== 'function') return null
    try {
      const stats = service.documentStats()
      return stats && typeof stats === 'object' ? stats : null
    } catch (error) {
      this.log('Document stats failed:', error?.message || String(error))
      return null
    }
  }

  stats() {
    const history = this.readHistory()
    const documentStats = this.readDocumentStats()
    const referencedFiles = new Set()
    let availableCount = 0
    let missingCount = 0
    let totalBytes = 0
    for (const item of history) {
      if (item?.filePath && fs.existsSync(item.filePath)) availableCount++
      else missingCount++
      if (documentStats) continue
      for (const filePath of [item?.filePath, item?.thumbnailPath]) {
        if (!filePath || !fs.existsSync(filePath)) continue
        const normalized = path.resolve(filePath).toLocaleLowerCase()
        if (referencedFiles.has(normalized)) continue
        referencedFiles.add(normalized)
        try {
          totalBytes += fs.statSync(filePath).size
        } catch {
          // File can disappear between existence and size checks.
        }
      }
    }
    if (documentStats) totalBytes = Number(documentStats.totalBytes) || 0
    const orphans = this.orphanFiles(history)
    const result = {
      totalCount: history.length,
      availableCount,
      missingCount,
      totalBytes,
      orphanCount: orphans.length,
      orphanBytes: orphans.reduce((total, item) => total + item.size, 0)
    }
    if (documentStats) {
      result.revisionCount = Number(documentStats.revisionCount) || 0
      result.editableCount = Number(documentStats.editableCount) || 0
      result.bitmapOnlyCount = Number(documentStats.bitmapOnlyCount) || 0
    }
    return result
  }

  trimHistory(history, limit) {
    const kept = history.slice(0, limit)
    const discarded = history.slice(limit)
    const discardedIds = []
    for (const entry of discarded) {
      try {
        this.deleteFiles(entry)
        discardedIds.push(entry?.id)
      } catch (error) {
        kept.push(entry)
        this.log('History limit cleanup failed:', entry.filePath, error.message)
      }
    }
    // N02: a record evicted by the history limit must not get its OCR text written later.
    this.discardOcrIndexIds(discardedIds)
    return kept
  }

  storeItem(item, limit) {
    const history = this.trimHistory([item, ...this.readHistory()], limit)
    this.writeHistory(history)
    return item
  }

  // B01: a one-shot "do not keep this capture" reaches the history service as
  // meta.skipHistory. The capture domain already refuses to call here for a skipped
  // result, but the guard is repeated at the only place that actually writes, so no
  // future caller can turn a skipped capture into a record by accident.
  skipsHistory(meta) {
    return !!meta && meta.skipHistory === true
  }

  persistBuffer(value, meta = {}) {
    this.assertWritable()
    if (this.skipsHistory(meta)) return null
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value || [])
    return this.persistImageBuffer(buffer, meta)
  }

  persistDataUrl(dataUrl, meta = {}) {
    this.assertWritable()
    if (this.skipsHistory(meta)) return null
    const buffer = Buffer.from(String(dataUrl).replace(DATA_URL_PATTERN, ''), 'base64')
    return this.persistImageBuffer(buffer, meta)
  }

  persistImageBuffer(buffer, meta = {}) {
    const settings = this.getSettings()
    if (!settings.screenshot.historyEnabled) return null
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('截图历史图片为空')
    const id = this.createId()
    const filePath = this.historyImagePath(meta)
    fs.writeFileSync(filePath, buffer)
    // Callers that already decoded the buffer (clipboard copy) pass it in so
    // the full PNG is not decoded a second time on the click path.
    const provided = meta.image
    const image = provided && typeof provided.getSize === 'function'
      ? provided
      : (typeof this.nativeImage.createFromBuffer === 'function'
        ? this.nativeImage.createFromBuffer(buffer)
        : this.nativeImage.createFromPath(filePath))
    const size = image.getSize()
    let thumbnailPath = ''
    try {
      thumbnailPath = this.persistThumbnail(image, id)
    } catch (error) {
      this.log('History thumbnail persistence failed:', filePath, error.message)
    }
    const item = {
      id,
      filePath,
      ...(thumbnailPath ? { thumbnailPath } : {}),
      createdAt: this.now(),
      source: meta.source || 'capture',
      action: meta.action || 'edit',
      width: size.width,
      height: size.height
    }
    const limit = Math.max(10, Number(settings.screenshot.historyLimit) || 200)
    return this.storeItem(item, limit)
  }

  async persistFile(sourcePath, meta = {}) {
    this.assertWritable()
    if (this.skipsHistory(meta)) return null
    const settings = this.getSettings()
    if (!settings.screenshot.historyEnabled || !sourcePath || !fs.existsSync(sourcePath)) return null
    const id = this.createId()
    const filePath = this.historyImagePath(meta)
    const thumbnailPath = path.join(this.ensureDirectory(this.defaultHistoryDirectory), `${id}-thumb.png`)
    fs.copyFileSync(sourcePath, filePath)
    const imageMeta = await this.sharp(filePath, { limitInputPixels: false }).metadata()
    await this.sharp(filePath, { limitInputPixels: false })
      .resize({ width: Math.min(360, imageMeta.width || 360), height: 240, fit: 'inside', withoutEnlargement: true })
      .png({ compressionLevel: 7 })
      .toFile(thumbnailPath)
    const item = {
      id,
      filePath,
      thumbnailPath,
      createdAt: this.now(),
      source: meta.source || 'long-capture',
      action: meta.action || 'save',
      width: Number(meta.width) || imageMeta.width || 0,
      height: Number(meta.height) || imageMeta.height || 0,
      longCapture: !!meta.longCapture
    }
    const limit = Math.max(10, Number(settings.screenshot.historyLimit) || 200)
    return this.storeItem(item, limit)
  }

  // Identity projection for the list (batch 1, history-reedit-batch0-contracts.md §6.5.1).
  // Every card must carry a stable documentId, the current revisionId and a human version
  // number, while `item.id` keeps its compatibility meaning (`id === documentId` during the
  // compatibility period). Legacy rows written before documents existed have neither field,
  // so they project to `documentId = id` and `version = 1` - that is what keeps old records
  // rendering exactly as before instead of showing a noisy "version 1" badge.
  toListItem(item) {
    if (!item || typeof item !== 'object') return item
    const documentId = String(item.documentId || item.id || '')
    const version = Math.max(1, Math.round(Number(item.version) || 1))
    // N02: the mutable full-text index (ocrText) is search input, not card content. Keeping it
    // out of the list projection keeps a 40-card page from shipping up to 800 KiB of OCR text
    // over IPC on every refresh; the search itself runs in the main process before projection.
    // Tags stay because the card renders them.
    const { ocrText: _ocrText, ...listItem } = item
    return {
      ...listItem,
      documentId,
      revisionId: String(item.revisionId || ''),
      headRevisionId: String(item.headRevisionId || item.revisionId || ''),
      version
    }
  }

  list(filterValue = {}) {
    const filter = normalizeHistoryFilter(filterValue)
    const matching = this.readHistory().filter((item) => matchesHistoryFilter(item, filter))
    const cursorIndex = filter.cursor
      ? matching.findIndex((item) => String(item.id) === filter.cursor)
      : -1
    // F01 (docs/reviews/2026-11-26-code-review-and-optimization-report.md section 3.1): the
    // existence probe used to run on the WHOLE history before pagination, so listing 40 cards
    // out of 200 records cost 200 synchronous disk hits. Only the records the page can return
    // are probed now; totalCount reports the metadata index size (missing files are reclaimed
    // by cleanup(), and stats() still counts them).
    let index = cursorIndex >= 0 ? cursorIndex + 1 : 0
    const items = []
    while (index < matching.length && items.length < filter.limit) {
      const item = matching[index]
      index += 1
      if (!item?.filePath || !fs.existsSync(item.filePath)) continue
      items.push(this.toListItem(item))
    }
    const hasMore = index < matching.length
    return {
      items,
      totalCount: matching.length,
      hasMore,
      nextCursor: hasMore && items.length ? String(items[items.length - 1].id) : ''
    }
  }

  listSources() {
    return [...new Set(this.readHistory()
      .filter((item) => item?.filePath && fs.existsSync(item.filePath))
      .map((item) => String(item.source || 'capture')))]
      .sort((left, right) => left.localeCompare(right))
  }

  getItem(id) {
    const normalizedId = String(id || '').slice(0, 128)
    return this.readHistory().find((entry) => entry.id === normalizedId) || null
  }

  // N02: the one write door for the search-only fields (ocrText / tags). The record is
  // re-read here, so a caller that raced a delete gets `false` instead of recreating the row.
  // The write is silent (writeHistorySilently) and followed by onChanged(), which is what the
  // history page's in-place refresh listens to: the index changes without a second
  // broadcast per field.
  writeItemFields(id, patch) {
    this.assertWritable()
    const normalizedId = String(id || '').slice(0, 128)
    if (!normalizedId || !patch || typeof patch !== 'object' || Array.isArray(patch)) return false
    const history = this.readHistory()
    const index = history.findIndex((entry) => String(entry?.id || '') === normalizedId)
    if (index < 0) return false
    history[index] = { ...history[index], ...patch }
    try {
      this.writeHistorySilently(history)
    } catch (error) {
      this.log('History entry update failed:', normalizedId, error?.message || String(error))
      return false
    }
    this.onChanged()
    return true
  }

  // N02: called by the background OCR indexer once a saved capture's text was recognized.
  // The record may already be gone (deleted while the sidecar ran): that is a normal race,
  // not an error, and the result is simply dropped. Empty text is not written either - it
  // would only create a write and a page refresh that cannot change any search result.
  updateOcrText(id, text) {
    const normalizedText = normalizeHistoryOcrText(text)
    const normalizedId = String(id || '').slice(0, 128)
    if (!normalizedId || !normalizedText) return false
    const current = this.getItem(normalizedId)
    if (!current) return false
    if (current.ocrText === normalizedText) return true
    return this.writeItemFields(normalizedId, { ocrText: normalizedText })
  }

  // N02: replace a record's tag list (the history card's tag editor). Returns the normalized
  // tags that are now stored, or null when nothing was written (record gone, or the payload
  // was not an array at all). An unchanged list is a no-op that still reports the tags, so the
  // card can re-render from the answer without a second history write.
  updateTags(id, tags) {
    const normalizedTags = normalizeHistoryTags(tags)
    const normalizedId = String(id || '').slice(0, 128)
    if (!normalizedId || !normalizedTags) return null
    const current = this.getItem(normalizedId)
    if (!current) return null
    const previousTags = normalizeHistoryTags(Array.isArray(current.tags) ? current.tags : []) || []
    const unchanged = previousTags.length === normalizedTags.length &&
      previousTags.every((tag, index) => tag === normalizedTags[index])
    if (unchanged) return normalizedTags
    return this.writeItemFields(normalizedId, { tags: normalizedTags }) ? normalizedTags : null
  }

  delete(id) {
    this.assertWritable()
    const history = this.readHistory()
    const item = history.find((entry) => entry.id === String(id || ''))
    if (item) {
      this.deleteFiles(item)
      // N02: stop a pending OCR write before the row disappears.
      this.discardOcrIndexIds([item.id])
    }
    this.writeHistory(history.filter((entry) => entry !== item))
    return true
  }

  deleteMany(ids) {
    this.assertWritable()
    const selected = new Set(normalizeHistoryIds(ids))
    const remaining = []
    const failures = []
    const deletedIds = []
    let deletedCount = 0
    for (const item of this.readHistory()) {
      if (!selected.has(String(item?.id || ''))) {
        remaining.push(item)
        continue
      }
      try {
        this.deleteFiles(item)
        deletedIds.push(item.id)
        deletedCount++
      } catch (error) {
        remaining.push(item)
        failures.push({ id: item.id, message: error?.message || String(error) })
      }
    }
    // N02: only records that actually left the index may cancel their OCR work.
    this.discardOcrIndexIds(deletedIds)
    this.writeHistory(remaining)
    return {
      deletedCount,
      missingCount: selected.size - deletedCount - failures.length,
      failures
    }
  }

  /**
   * Ordered export items for a selection (id -> existing file path).
   *
   * Walks the stored history exactly once, in history order, and keeps only the
   * requested ids whose file is still readable. Ids that are not in the history at
   * all are reported alongside the ones whose file vanished, so a batch exporter
   * can tell the user how many entries were skipped instead of silently shrinking
   * the batch. Shared with exportMany so the selection rules (normalizeHistoryIds,
   * existence probe, history order) have a single definition.
   */
  selectExportItems(ids) {
    const selected = new Set(normalizeHistoryIds(ids))
    const items = []
    const missingIds = []
    for (const item of this.readHistory()) {
      const id = String(item?.id || '')
      if (!selected.has(id)) continue
      selected.delete(id)
      if (!item.filePath || !fs.existsSync(item.filePath)) {
        missingIds.push(id)
        continue
      }
      items.push({
        id: item.id,
        filePath: item.filePath,
        width: Number(item.width) || 0,
        height: Number(item.height) || 0,
        longCapture: item.longCapture === true
      })
    }
    missingIds.push(...selected)
    return { items, missingIds }
  }

  exportMany(ids, directory) {
    this.assertWritable()
    const requestedDirectory = String(directory || '').trim()
    if (!requestedDirectory || !path.isAbsolute(requestedDirectory)) throw new Error('导出目录必须是绝对路径')
    const exportDirectory = path.resolve(requestedDirectory)
    fs.mkdirSync(exportDirectory, { recursive: true })
    const failures = []
    let exportedCount = 0
    // Selection + existence accounting is shared with the PDF batch export; only
    // the copy below is specific to "keep the original file name" exporting.
    const { items, missingIds } = this.selectExportItems(ids)
    for (const item of items) {
      const extension = path.extname(item.filePath)
      const baseName = path.basename(item.filePath, extension)
      let destination = path.join(exportDirectory, `${baseName}${extension}`)
      let suffix = 1
      while (fs.existsSync(destination)) {
        destination = path.join(exportDirectory, `${baseName}-${suffix}${extension}`)
        suffix++
      }
      try {
        fs.copyFileSync(item.filePath, destination)
        exportedCount++
      } catch (error) {
        failures.push({ id: item.id, message: error?.message || String(error) })
      }
    }
    return {
      exportedCount,
      missingCount: missingIds.length,
      failures,
      directory: exportDirectory
    }
  }

  cleanup() {
    this.assertWritable()
    const history = this.readHistory()
    const remaining = []
    const failures = []
    let removedEntries = 0
    let removedFiles = 0
    let reclaimedBytes = 0

    for (const item of history) {
      if (item?.filePath && fs.existsSync(item.filePath)) {
        remaining.push(item)
        continue
      }
      removedEntries++
      // H01: an entry whose head image is gone still owns its document tree; drop both so a
      // single "clean up" run actually reclaims the space it reports.
      this.deleteDocumentFiles(this.documentIdFor(item))
      if (item?.thumbnailPath && fs.existsSync(item.thumbnailPath)) {
        try {
          reclaimedBytes += fs.statSync(item.thumbnailPath).size
          fs.unlinkSync(item.thumbnailPath)
          removedFiles++
        } catch (error) {
          failures.push({ filePath: item.thumbnailPath, message: error?.message || String(error) })
        }
      }
    }

    for (const orphan of this.orphanFiles(history)) {
      try {
        if (orphan.isDirectory) {
          fs.rmSync(orphan.filePath, { recursive: true, force: true })
          removedFiles += Number(orphan.fileCount) || 1
        } else {
          fs.unlinkSync(orphan.filePath)
          removedFiles++
        }
        reclaimedBytes += orphan.size
      } catch (error) {
        failures.push({ filePath: orphan.filePath, message: error?.message || String(error) })
      }
    }

    if (removedEntries) this.writeHistory(remaining)
    else if (removedFiles) this.onChanged()
    return { removedEntries, removedFiles, reclaimedBytes, failures }
  }

  clear() {
    this.assertWritable()
    const remaining = []
    const failures = []
    const removedIds = []
    for (const item of this.readHistory()) {
      try {
        this.deleteFiles(item)
        removedIds.push(item?.id)
      } catch (error) {
        remaining.push(item)
        failures.push(`${path.basename(item.filePath)}: ${error.message}`)
      }
    }
    this.discardOcrIndexIds(removedIds)
    this.writeHistory(remaining)
    if (failures.length) throw new Error(`有 ${failures.length} 个历史文件删除失败`)
    return true
  }

}

module.exports = {
  HistoryService,
  isOwnedHistoryFile,
  matchesHistoryFilter,
  normalizeHistoryIds,
  normalizeHistoryFilter,
  normalizeHistoryTags,
  normalizeHistoryOcrText,
  MAX_HISTORY_TAG_COUNT,
  MAX_HISTORY_TAG_LENGTH
}
