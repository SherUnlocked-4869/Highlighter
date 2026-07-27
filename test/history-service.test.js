const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  HistoryService,
  isOwnedHistoryFile,
  matchesHistoryFilter,
  normalizeHistoryIds,
  normalizeHistoryFilter
} = require('../main/services/history-service')

class MemoryStore {
  constructor(history = []) {
    this.history = history
  }

  get(key, fallback) {
    return key === 'captureHistory' ? this.history : fallback
  }

  set(key, value) {
    if (key === 'captureHistory') this.history = value
  }
}

function withTempDirectory(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'highlighter-history-'))
  try {
    return callback(directory)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

function createService(directory, history = [], overrides = {}) {
  return new HistoryService({
    store: new MemoryStore(history),
    nativeImage: {
      createFromPath: () => ({
        getSize: () => ({ width: 120, height: 80 }),
        resize: () => ({ toDataURL: () => 'data:image/png;base64,dGh1bWI=' })
      })
    },
    sharp: () => {},
    getSettings: () => ({
      screenshot: {
        historyDirectory: directory,
        historyEnabled: true,
        historyLimit: 10
      }
    }),
    assertWritable() {},
    defaultHistoryDirectory: directory,
    makeCaptureName: (prefix) => `${prefix}.png`,
    ...overrides
  })
}

test('normalizes and applies history search filters', () => {
  const filter = normalizeHistoryFilter({ query: ' OCR ', source: 'capture', favoriteOnly: true })
  assert.deepEqual(filter, { query: 'ocr', source: 'capture', favoriteOnly: true })
  assert.equal(matchesHistoryFilter({
    source: 'capture',
    action: 'copy',
    filePath: 'screen.png',
    tags: ['OCR'],
    favorite: true
  }, filter), true)
  assert.equal(matchesHistoryFilter({ source: 'file', favorite: true }, filter), false)
})

test('lists history by query, source, and favorite state', () => {
  withTempDirectory((directory) => {
    const first = path.join(directory, 'invoice.png')
    const second = path.join(directory, 'diagram.png')
    fs.writeFileSync(first, 'first')
    fs.writeFileSync(second, 'second')
    const service = createService(directory, [
      { id: '1', filePath: first, source: 'capture', action: 'copy', favorite: true, tags: ['invoice'] },
      { id: '2', filePath: second, source: 'file', action: 'pin' }
    ])
    assert.deepEqual(service.listSources(), ['capture', 'file'])
    assert.deepEqual(service.list({ query: 'invoice' }).map((item) => item.id), ['1'])
    assert.deepEqual(service.list({ source: 'file' }).map((item) => item.id), ['2'])
    assert.deepEqual(service.list({ favoriteOnly: true }).map((item) => item.id), ['1'])
  })
})

test('history limits preserve favorites while deleting old regular items', () => {
  withTempDirectory((directory) => {
    const favoritePath = path.join(directory, 'favorite.png')
    const recentPath = path.join(directory, 'recent.png')
    const oldPath = path.join(directory, 'old.png')
    for (const file of [favoritePath, recentPath, oldPath]) fs.writeFileSync(file, 'image')
    const service = createService(directory)
    const kept = service.trimHistory([
      { id: 'favorite', filePath: favoritePath, favorite: true },
      { id: 'recent', filePath: recentPath },
      { id: 'old', filePath: oldPath }
    ], 1)
    assert.deepEqual(kept.map((item) => item.id), ['favorite', 'recent'])
    assert.equal(fs.existsSync(favoritePath), true)
    assert.equal(fs.existsSync(oldPath), false)
  })
})

test('favorite updates are migration-gated and persisted', () => {
  withTempDirectory((directory) => {
    const filePath = path.join(directory, 'capture.png')
    fs.writeFileSync(filePath, 'image')
    let writableChecks = 0
    let changed = 0
    const service = createService(directory, [{ id: '1', filePath }], {
      assertWritable: () => { writableChecks++ },
      onChanged: () => { changed++ }
    })
    assert.equal(service.setFavorite('1', true).favorite, true)
    assert.equal(service.getItem('1').favorite, true)
    assert.equal(writableChecks, 1)
    assert.equal(changed, 1)
  })
})

test('normalizes bounded batch ids and recognizes only managed history names', () => {
  assert.deepEqual(normalizeHistoryIds([' 1 ', '1', '', 2]), ['1', '2'])
  assert.throws(() => normalizeHistoryIds('1'), /必须是数组/)
  assert.throws(() => normalizeHistoryIds(Array.from({ length: 501 }, (_, index) => index)), /最多处理 500 项/)
  assert.equal(isOwnedHistoryFile('Highlighter_2026-07-25_12-10-11-123.png'), true)
  assert.equal(isOwnedHistoryFile('Highlighter_Long_2026-07-25_12-10-11-123.png'), true)
  assert.equal(isOwnedHistoryFile('1700000000000-abc123-thumb.png'), true)
  assert.equal(isOwnedHistoryFile('family-photo.png'), false)
})

test('reports storage use, missing records, and unreferenced managed files', () => {
  withTempDirectory((directory) => {
    const filePath = path.join(directory, 'Highlighter_2026-07-25_12-10-11-123.png')
    const thumbnailPath = path.join(directory, '1700000000000-abc123-thumb.png')
    const orphanPath = path.join(directory, 'Highlighter_2026-07-25_12-10-11-999.png')
    const unrelatedPath = path.join(directory, 'family-photo.png')
    fs.writeFileSync(filePath, 'image')
    fs.writeFileSync(thumbnailPath, 'thumb')
    fs.writeFileSync(orphanPath, 'orphan')
    fs.writeFileSync(unrelatedPath, 'personal')
    const service = createService(directory, [
      { id: '1', filePath, thumbnailPath, favorite: true },
      { id: '2', filePath: path.join(directory, 'missing.png') }
    ])

    assert.deepEqual(service.stats(), {
      totalCount: 2,
      availableCount: 1,
      missingCount: 1,
      favoriteCount: 1,
      totalBytes: 10,
      orphanCount: 1,
      orphanBytes: 6
    })
  })
})

test('batch deletion keeps failed items and reports missing ids', () => {
  withTempDirectory((directory) => {
    const firstPath = path.join(directory, 'first.png')
    const secondPath = path.join(directory, 'second.png')
    fs.writeFileSync(firstPath, 'first')
    fs.writeFileSync(secondPath, 'second')
    const service = createService(directory, [
      { id: '1', filePath: firstPath },
      { id: '2', filePath: secondPath }
    ])
    const deleteFiles = service.deleteFiles.bind(service)
    service.deleteFiles = (item) => {
      if (item.id === '2') throw new Error('locked')
      deleteFiles(item)
    }

    const result = service.deleteMany(['1', '2', 'missing'])
    assert.equal(result.deletedCount, 1)
    assert.equal(result.missingCount, 1)
    assert.deepEqual(result.failures, [{ id: '2', message: 'locked' }])
    assert.deepEqual(service.readHistory().map((item) => item.id), ['2'])
    assert.equal(fs.existsSync(firstPath), false)
    assert.equal(fs.existsSync(secondPath), true)
  })
})

test('batch export avoids overwrites and reports unavailable records', () => {
  withTempDirectory((directory) => {
    const exportDirectory = path.join(directory, 'export')
    fs.mkdirSync(exportDirectory)
    const filePath = path.join(directory, 'capture.png')
    fs.writeFileSync(filePath, 'new')
    fs.writeFileSync(path.join(exportDirectory, 'capture.png'), 'existing')
    const service = createService(directory, [
      { id: '1', filePath },
      { id: '2', filePath: path.join(directory, 'missing.png') }
    ])

    const result = service.exportMany(['1', '2', 'unknown'], exportDirectory)
    assert.equal(result.exportedCount, 1)
    assert.equal(result.missingCount, 2)
    assert.equal(fs.readFileSync(path.join(exportDirectory, 'capture.png'), 'utf8'), 'existing')
    assert.equal(fs.readFileSync(path.join(exportDirectory, 'capture-1.png'), 'utf8'), 'new')
    assert.throws(() => service.exportMany(['1'], ''), /绝对路径/)
  })
})

test('cleanup removes missing metadata and only unreferenced managed files', () => {
  withTempDirectory((directory) => {
    const validPath = path.join(directory, 'Highlighter_2026-07-25_12-10-11-123.png')
    const missingThumbnail = path.join(directory, '1700000000000-missing-thumb.png')
    const orphanPath = path.join(directory, 'Highlighter_Long_2026-07-25_12-10-11-999.png')
    const unrelatedPath = path.join(directory, 'notes.png')
    fs.writeFileSync(validPath, 'valid')
    fs.writeFileSync(missingThumbnail, 'thumb')
    fs.writeFileSync(orphanPath, 'orphan')
    fs.writeFileSync(unrelatedPath, 'notes')
    const service = createService(directory, [
      { id: 'valid', filePath: validPath },
      { id: 'missing', filePath: path.join(directory, 'gone.png'), thumbnailPath: missingThumbnail }
    ])

    const result = service.cleanup()
    assert.equal(result.removedEntries, 1)
    assert.equal(result.removedFiles, 2)
    assert.equal(result.reclaimedBytes, 11)
    assert.deepEqual(service.readHistory().map((item) => item.id), ['valid'])
    assert.equal(fs.existsSync(orphanPath), false)
    assert.equal(fs.existsSync(missingThumbnail), false)
    assert.equal(fs.existsSync(unrelatedPath), true)
  })
})
