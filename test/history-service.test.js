const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  HistoryService,
  matchesHistoryFilter,
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
