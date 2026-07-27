const fs = require('fs')
const path = require('path')

const MAX_HISTORY_QUERY_LENGTH = 200
const MAX_HISTORY_BATCH_SIZE = 500
const OWNED_CAPTURE_FILE = /^Highlighter(?:_Long)?_\d{4}-\d{2}-\d{2}_[\d-]+\.png$/i
const OWNED_THUMBNAIL_FILE = /^\d{10,}-[a-z0-9]+-thumb\.png$/i

function normalizeHistoryFilter(value = {}) {
  const filter = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  return {
    query: String(filter.query || '').trim().slice(0, MAX_HISTORY_QUERY_LENGTH).toLocaleLowerCase(),
    source: String(filter.source || '').trim().slice(0, 64),
    favoriteOnly: filter.favoriteOnly === true
  }
}

function matchesHistoryFilter(item, filter) {
  if (filter.favoriteOnly && item.favorite !== true) return false
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
  }

  ensureDirectory(directory) {
    fs.mkdirSync(directory, { recursive: true })
    return directory
  }

  readHistory() {
    const history = this.store.get('captureHistory', [])
    return Array.isArray(history) ? history : []
  }

  writeHistory(history) {
    this.store.set('captureHistory', history)
    this.onChanged()
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
    let favoriteCount = 0
    let totalBytes = 0
    for (const item of history) {
      if (item?.favorite === true) favoriteCount++
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
      favoriteCount,
      totalBytes,
      orphanCount: orphans.length,
      orphanBytes: orphans.reduce((total, item) => total + item.size, 0)
    }
  }

  trimHistory(history, limit) {
    const kept = []
    const discarded = []
    let regularCount = 0
    for (const entry of history) {
      if (entry.favorite === true || regularCount < limit) {
        kept.push(entry)
        if (entry.favorite !== true) regularCount++
      } else {
        discarded.push(entry)
      }
    }
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

  persistDataUrl(dataUrl, meta = {}) {
    this.assertWritable()
    const settings = this.getSettings()
    if (!settings.screenshot.historyEnabled) return null
    const id = this.createId()
    const filePath = this.historyImagePath(meta)
    const buffer = Buffer.from(String(dataUrl).replace(/^data:image\/\w+;base64,/, ''), 'base64')
    fs.writeFileSync(filePath, buffer)
    const size = this.nativeImage.createFromPath(filePath).getSize()
    const item = {
      id,
      filePath,
      createdAt: this.now(),
      source: meta.source || 'capture',
      action: meta.action || 'edit',
      width: size.width,
      height: size.height,
      favorite: false
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
      longCapture: !!meta.longCapture,
      favorite: false
    }
    const limit = Math.max(10, Number(settings.screenshot.historyLimit) || 200)
    return this.storeItem(item, limit)
  }

  list(filterValue = {}) {
    const filter = normalizeHistoryFilter(filterValue)
    return this.readHistory()
      .filter((item) => item?.filePath && fs.existsSync(item.filePath))
      .filter((item) => matchesHistoryFilter(item, filter))
      .map((item) => {
        const thumbnailSource = item.thumbnailPath && fs.existsSync(item.thumbnailPath) ? item.thumbnailPath : item.filePath
        const image = this.nativeImage.createFromPath(thumbnailSource)
        const size = image.getSize()
        const width = Math.min(360, size.width || 360)
        return {
          ...item,
          favorite: item.favorite === true,
          thumbnail: image.resize({ width, quality: 'good' }).toDataURL()
        }
      })
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

  setFavorite(id, favorite) {
    this.assertWritable()
    const history = this.readHistory()
    const index = history.findIndex((entry) => entry.id === String(id || ''))
    if (index < 0) return null
    history[index] = { ...history[index], favorite: favorite === true }
    this.writeHistory(history)
    return history[index]
  }
}

module.exports = {
  HistoryService,
  isOwnedHistoryFile,
  matchesHistoryFilter,
  normalizeHistoryIds,
  normalizeHistoryFilter
}
