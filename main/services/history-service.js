const fs = require('fs')
const path = require('path')

const MAX_HISTORY_QUERY_LENGTH = 200

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
  matchesHistoryFilter,
  normalizeHistoryFilter
}
