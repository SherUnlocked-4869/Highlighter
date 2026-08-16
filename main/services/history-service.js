const fs = require('fs')
const path = require('path')

const MAX_HISTORY_QUERY_LENGTH = 200
const MAX_HISTORY_BATCH_SIZE = 500
const DEFAULT_HISTORY_PAGE_SIZE = 40
const MAX_HISTORY_PAGE_SIZE = 100
const OWNED_CAPTURE_FILE = /^Highlighter(?:_Long)?_\d{4}-\d{2}-\d{2}_[\d-]+\.png$/i
const OWNED_THUMBNAIL_FILE = /^\d{10,}-[a-z0-9]+-thumb\.png$/i
const THUMBNAIL_WIDTH = 360
const THUMBNAIL_HEIGHT = 240

// PNG dimensions live in the fixed-position IHDR chunk; reading them directly
// avoids decoding the full capture image just to record its size.
function readPngSize(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null
  if (buffer.readUInt32BE(0) !== 0x89504e47) return null
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') return null
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

function migrateLegacyHistoryStore({ legacyStore, historyStore, log = () => {} }) {
  if (!legacyStore || !historyStore) return { migrated: 0 }
  const legacy = legacyStore.get('captureHistory', undefined)
  if (legacy === undefined) return { migrated: 0 }
  if (!Array.isArray(legacy) || !legacy.length) return { migrated: 0 }
  const existing = historyStore.get('captureHistory', [])
  if (Array.isArray(existing) && existing.length) return { migrated: 0 }
  // The legacy key is only removed after the migration write succeeds, so a
  // failed store write or an already-populated target never destroys data.
  historyStore.set('captureHistory', legacy)
  legacyStore.delete('captureHistory')
  log('Migrated capture history entries to dedicated store:', legacy.length)
  return { migrated: legacy.length }
}

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
    // outputPath -> in-flight promise, plus id -> regeneration promise for
    // concurrent accesses to the same missing thumbnail.
    this.thumbnailWrites = new Map()
    this.thumbnailGenerations = new Map()
  }

  flushThumbnailWrites() {
    return Promise.allSettled([...this.thumbnailWrites.values()])
  }

  ensureDirectory(directory) {
    fs.mkdirSync(directory, { recursive: true })
    return directory
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
    const directory = this.ensureDirectory(this.getSettings().screenshot.historyDirectory)
    const prefix = meta.longCapture ? 'Highlighter_Long' : 'Highlighter'
    return path.join(directory, this.makeCaptureName(prefix))
  }

  deleteFiles(item) {
    if (!item) return
    if (item.thumbnailPath && fs.existsSync(item.thumbnailPath)) fs.unlinkSync(item.thumbnailPath)
    if (item.filePath && fs.existsSync(item.filePath)) fs.unlinkSync(item.filePath)
  }

  thumbnailPath(id) {
    return path.join(this.ensureDirectory(this.defaultHistoryDirectory), `${String(id)}-thumb.png`)
  }

  // Thumbnail resize/encode runs on the sharp thread pool so capture flows do
  // not pay for it on the main process.
  writeThumbnail(source, outputPath) {
    return this.sharp(source, { limitInputPixels: false })
      .resize({ width: THUMBNAIL_WIDTH, height: THUMBNAIL_HEIGHT, fit: 'inside', withoutEnlargement: true })
      .png({ compressionLevel: 7 })
      .toFile(outputPath)
  }

  queueThumbnailWrite(source, id) {
    const outputPath = this.thumbnailPath(id)
    const pending = this.thumbnailWrites.get(outputPath)
    if (pending) return outputPath
    const task = this.writeThumbnail(source, outputPath)
      .catch((error) => {
        this.log('History thumbnail persistence failed:', outputPath, error?.message || String(error))
      })
      .finally(() => {
        if (this.thumbnailWrites.get(outputPath) === task) this.thumbnailWrites.delete(outputPath)
      })
    this.thumbnailWrites.set(outputPath, task)
    return outputPath
  }

  probeImageSize(buffer, filePath) {
    const fromHeader = readPngSize(buffer)
    if (fromHeader) return fromHeader
    try {
      const image = typeof this.nativeImage.createFromBuffer === 'function' && Buffer.isBuffer(buffer)
        ? this.nativeImage.createFromBuffer(buffer)
        : this.nativeImage.createFromPath(filePath)
      return image.getSize()
    } catch {
      return { width: 0, height: 0 }
    }
  }

  async ensureThumbnail(id) {
    const normalizedId = String(id || '').slice(0, 128)
    const history = this.readHistory()
    const index = history.findIndex((entry) => entry.id === normalizedId)
    if (index < 0) return ''
    const item = history[index]
    if (item.thumbnailPath && fs.existsSync(item.thumbnailPath)) return item.thumbnailPath
    if (!item.filePath || !fs.existsSync(item.filePath)) return ''
    // A capture may have queued a write for this thumbnail moments ago; let
    // that specific write land before deciding the entry needs regeneration.
    const queued = this.thumbnailWrites.get(this.thumbnailPath(normalizedId))
    if (queued) await queued
    const refreshed = this.readHistory().find((entry) => entry.id === normalizedId)
    if (refreshed?.thumbnailPath && fs.existsSync(refreshed.thumbnailPath)) return refreshed.thumbnailPath
    if (!refreshed?.filePath || !fs.existsSync(refreshed.filePath)) return ''
    // Concurrent requests for the same missing thumbnail share one regeneration.
    const inFlight = this.thumbnailGenerations.get(normalizedId)
    if (inFlight) return inFlight
    const task = this.regenerateThumbnail(normalizedId, refreshed)
      .finally(() => {
        if (this.thumbnailGenerations.get(normalizedId) === task) this.thumbnailGenerations.delete(normalizedId)
      })
    this.thumbnailGenerations.set(normalizedId, task)
    return task
  }

  async regenerateThumbnail(id, item) {
    try {
      this.assertWritable()
      const outputPath = this.thumbnailPath(item.id)
      await this.writeThumbnail(item.filePath, outputPath)
      if (!fs.existsSync(outputPath)) return ''
      const history = this.readHistory()
      const index = history.findIndex((entry) => entry.id === id)
      if (index < 0) return ''
      history[index] = { ...history[index], thumbnailPath: outputPath }
      this.writeHistorySilently(history)
      return outputPath
    } catch (error) {
      this.log('History thumbnail generation failed:', item.filePath, error.message)
      return ''
    }
  }

  async getThumbnail(id) {
    const normalizedId = String(id || '').slice(0, 128)
    const thumbnailPath = await this.ensureThumbnail(normalizedId)
    if (!thumbnailPath || !fs.existsSync(thumbnailPath)) return ''
    return `historythumb://${encodeURIComponent(normalizedId)}`
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
    return orphans
  }

  stats() {
    const history = this.readHistory()
    const referencedFiles = new Set()
    let availableCount = 0
    let missingCount = 0
    let totalBytes = 0
    for (const item of history) {
      if (item?.filePath && fs.existsSync(item.filePath)) availableCount++
      else missingCount++
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
    const orphans = this.orphanFiles(history)
    return {
      totalCount: history.length,
      availableCount,
      missingCount,
      totalBytes,
      orphanCount: orphans.length,
      orphanBytes: orphans.reduce((total, item) => total + item.size, 0)
    }
  }

  trimHistory(history, limit) {
    const kept = history.slice(0, limit)
    const discarded = history.slice(limit)
    for (const entry of discarded) {
      try {
        this.deleteFiles(entry)
      } catch (error) {
        kept.push(entry)
        this.log('History limit cleanup failed:', entry.filePath, error.message)
      }
    }
    return kept
  }

  storeItem(item, limit) {
    const history = this.trimHistory([item, ...this.readHistory()], limit)
    this.writeHistory(history)
    return item
  }

  persistBuffer(value, meta = {}) {
    this.assertWritable()
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value || [])
    return this.persistImageBuffer(buffer, meta)
  }

  persistDataUrl(dataUrl, meta = {}) {
    this.assertWritable()
    const buffer = Buffer.from(String(dataUrl).replace(/^data:image\/[^;]+;base64,/, ''), 'base64')
    return this.persistImageBuffer(buffer, meta)
  }

  persistImageBuffer(buffer, meta = {}) {
    const settings = this.getSettings()
    if (!settings.screenshot.historyEnabled) return null
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('截图历史图片为空')
    const id = this.createId()
    const filePath = this.historyImagePath(meta)
    fs.writeFileSync(filePath, buffer)
    const size = this.probeImageSize(buffer, filePath)
    const thumbnailPath = this.queueThumbnailWrite(buffer, id)
    const item = {
      id,
      filePath,
      thumbnailPath,
      createdAt: this.now(),
      source: meta.source || 'capture',
      action: meta.action || 'edit',
      width: size.width,
      height: size.height
    }
    const limit = Math.max(10, Number(settings.screenshot.historyLimit) || 200)
    return this.storeItem(item, limit)
  }

  // Indexes an already-persisted image (e.g. the pin source file) without
  // copying it again.
  recordExistingFile(filePath, meta = {}) {
    this.assertWritable()
    const settings = this.getSettings()
    if (!settings.screenshot.historyEnabled) return null
    if (!filePath || !fs.existsSync(filePath)) return null
    const id = this.createId()
    const size = this.probeImageSize(null, filePath)
    const thumbnailPath = this.queueThumbnailWrite(filePath, id)
    const item = {
      id,
      filePath,
      thumbnailPath,
      createdAt: this.now(),
      source: meta.source || 'capture',
      action: meta.action || 'pin',
      width: size.width,
      height: size.height,
      ...(meta.longCapture ? { longCapture: true } : {}),
      ...(meta.axis ? { axis: meta.axis } : {})
    }
    const limit = Math.max(10, Number(settings.screenshot.historyLimit) || 200)
    return this.storeItem(item, limit)
  }

  async persistFile(sourcePath, meta = {}) {
    this.assertWritable()
    const settings = this.getSettings()
    if (!settings.screenshot.historyEnabled || !sourcePath || !fs.existsSync(sourcePath)) return null
    const id = this.createId()
    const filePath = this.historyImagePath(meta)
    const thumbnailPath = this.thumbnailPath(id)
    fs.copyFileSync(sourcePath, filePath)
    const imageMeta = await this.sharp(filePath, { limitInputPixels: false }).metadata()
    await this.writeThumbnail(filePath, thumbnailPath)
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

  list(filterValue = {}) {
    const filter = normalizeHistoryFilter(filterValue)
    const matching = this.readHistory()
      .filter((item) => item?.filePath && fs.existsSync(item.filePath))
      .filter((item) => matchesHistoryFilter(item, filter))
    const cursorIndex = filter.cursor
      ? matching.findIndex((item) => String(item.id) === filter.cursor)
      : -1
    const start = cursorIndex >= 0 ? cursorIndex + 1 : 0
    const items = matching.slice(start, start + filter.limit)
    const hasMore = start + items.length < matching.length
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

  delete(id) {
    this.assertWritable()
    const history = this.readHistory()
    const item = history.find((entry) => entry.id === String(id || ''))
    if (item) this.deleteFiles(item)
    this.writeHistory(history.filter((entry) => entry !== item))
    return true
  }

  deleteMany(ids) {
    this.assertWritable()
    const selected = new Set(normalizeHistoryIds(ids))
    const remaining = []
    const failures = []
    let deletedCount = 0
    for (const item of this.readHistory()) {
      if (!selected.has(String(item?.id || ''))) {
        remaining.push(item)
        continue
      }
      try {
        this.deleteFiles(item)
        deletedCount++
      } catch (error) {
        remaining.push(item)
        failures.push({ id: item.id, message: error?.message || String(error) })
      }
    }
    this.writeHistory(remaining)
    return {
      deletedCount,
      missingCount: selected.size - deletedCount - failures.length,
      failures
    }
  }

  exportMany(ids, directory) {
    this.assertWritable()
    const selected = new Set(normalizeHistoryIds(ids))
    const requestedDirectory = String(directory || '').trim()
    if (!requestedDirectory || !path.isAbsolute(requestedDirectory)) throw new Error('导出目录必须是绝对路径')
    const exportDirectory = path.resolve(requestedDirectory)
    fs.mkdirSync(exportDirectory, { recursive: true })
    const failures = []
    let exportedCount = 0
    let missingCount = 0
    for (const item of this.readHistory()) {
      if (!selected.has(String(item?.id || ''))) continue
      if (!item.filePath || !fs.existsSync(item.filePath)) {
        missingCount++
        continue
      }
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
      missingCount: missingCount + Math.max(0, selected.size - exportedCount - missingCount - failures.length),
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
        fs.unlinkSync(orphan.filePath)
        removedFiles++
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
    for (const item of this.readHistory()) {
      try {
        this.deleteFiles(item)
      } catch (error) {
        remaining.push(item)
        failures.push(`${path.basename(item.filePath)}: ${error.message}`)
      }
    }
    this.writeHistory(remaining)
    if (failures.length) throw new Error(`有 ${failures.length} 个历史文件删除失败`)
    return true
  }

}

module.exports = {
  HistoryService,
  isOwnedHistoryFile,
  matchesHistoryFilter,
  migrateLegacyHistoryStore,
  normalizeHistoryIds,
  normalizeHistoryFilter,
  readPngSize
}
