'use strict'

// N02 (docs/reviews/2026-11-26-code-review-and-optimization-report.md §5.2):
// history screenshot full-text OCR index + per-record tags.
//
// The read half already existed (HistoryService.matchesHistoryFilter has always searched
// item.ocrText / item.tags); this ticket adds the writes:
//   * a background indexer that recognizes a saved capture's text off the save path and
//     writes it back through HistoryService.updateOcrText;
//   * a bounded, de-duplicated, serial queue with one silent retry and a delete race that
//     drops the result instead of resurrecting the record;
//   * HistoryService.updateTags with a strict shape (strings only, 8 tags, 24 chars) plus the
//     history page's tag editor and the three-language search hint;
//   * wiring assertions (the capture domain's save door, the IPC assembly, the preload write,
//     the command envelope on the frozen history channel) because those seams cannot run
//     without Electron.
//
// Everything here runs under plain node: the OCR service is a fake, HistoryService is the
// real class writing to a temporary directory, and the capture domain is driven through its
// real controller with fake collaborators (the same idiom as test/capture-skip-history.test.js).

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  HistoryService,
  MAX_HISTORY_TAG_COUNT,
  MAX_HISTORY_TAG_LENGTH,
  normalizeHistoryTags,
  normalizeHistoryOcrText
} = require('../main/services/history-service')
const { createHistoryOcrIndexer, MAX_IMAGE_SIDE } = require('../main/services/history-ocr-indexer')
const { createCaptureDomain } = require('../main/domains/capture')
const { registerHistoryIpc } = require('../main/ipc/history-ipc')

const root = path.join(__dirname, '..')
// Source-shape assertions below must not depend on the checkout's line endings: the
// git blobs are LF, but some Windows checkouts and CI runners materialise CRLF.
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8').replace(/\r\n/g, '\n')

const LANGUAGE_TABLES = ['zh-CN', 'en-US', 'zh-TW']
const TAG_KEYS = [
  'config.history.tags-placeholder',
  'config.history.tag-remove',
  'config.history.tags-failed',
  'config.history.tags-limit'
]

const DEFAULT_SETTINGS = Object.freeze({
  plugins: { ocr: true },
  screenshot: { historyEnabled: true }
})

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

class MemoryStore {
  constructor(history = []) {
    this.history = history
    this.writes = 0
  }

  get(key, fallback) {
    return key === 'captureHistory' ? this.history : fallback
  }

  set(key, value) {
    if (key !== 'captureHistory') return
    this.history = value
    this.writes += 1
  }
}

function fakeImage() {
  return {
    isEmpty: () => false,
    getSize: () => ({ width: 120, height: 80 }),
    resize: () => ({ toPNG: () => Buffer.from('thumb') }),
    toPNG: () => Buffer.from('image')
  }
}

async function withTempDirectory(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'highlighter-n02-'))
  try {
    return await callback(directory)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

let sequence = 0

function createService(directory, store, overrides = {}) {
  return new HistoryService({
    store,
    nativeImage: {
      createFromBuffer: () => fakeImage(),
      createFromPath: () => fakeImage()
    },
    sharp: () => {},
    getSettings: () => ({
      plugins: { ocr: true },
      screenshot: { historyDirectory: directory, historyEnabled: true, historyLimit: 20 }
    }),
    assertWritable: () => {},
    defaultHistoryDirectory: directory,
    makeCaptureName: (prefix) => `${prefix}-${++sequence}.png`,
    createId: () => `record-${++sequence}`,
    ...overrides
  })
}

function persist(service, meta = {}) {
  return service.persistBuffer(Buffer.from('png'), { source: 'capture', action: 'copy', ...meta })
}

function createIndexer({ service, recognize, settings, prepareImage, log = () => {}, maxQueueSize } = {}) {
  const readSettings = typeof settings === 'function'
    ? settings
    : () => settings || DEFAULT_SETTINGS
  return createHistoryOcrIndexer({
    getSettings: readSettings,
    getOcrService: () => ({ recognize }),
    getHistoryService: () => service,
    prepareImage: prepareImage || (async () => Buffer.from('small')),
    log,
    ...(maxQueueSize ? { maxQueueSize } : {})
  })
}

function flushMacrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 15))
}

// ---------------------------------------------------------------------------
// background indexing
// ---------------------------------------------------------------------------

test('N02 a saved record is indexed in the background and searchable by its recognized text', async () => {
  await withTempDirectory(async (directory) => {
    const store = new MemoryStore()
    const service = createService(directory, store)
    const item = persist(service)
    const calls = []
    const indexer = createIndexer({
      service,
      recognize: async (buffer, options) => {
        calls.push({ bytes: buffer.length, options })
        return { text: '  发票 总额 100 元 \r\n' }
      }
    })
    try {
      assert.equal(indexer.enqueue(item), true)
      assert.equal(indexer.enqueue(item), false, 'the same record id is queued only once')
      const settled = await indexer.idle()
      assert.equal(settled.pending, 0)
      assert.equal(settled.processedCount, 1)
      assert.equal(calls.length, 1)
      assert.equal(calls[0].options.maxSide, MAX_IMAGE_SIDE)
      // Normalized on write: trimmed and newline-normalized.
      assert.equal(service.getItem(item.id).ocrText, '发票 总额 100 元')
      // The pre-existing filter (HistoryService.matchesHistoryFilter) now has producer data.
      const found = service.list({ query: '发票' })
      assert.deepEqual(found.items.map((row) => row.id), [item.id])
      assert.equal(found.totalCount, 1)
      // The list projection keeps the OCR text in the main process (search input, not card
      // content); tags stay because the card renders them.
      assert.equal('ocrText' in found.items[0], false)
      assert.deepEqual(service.list({ query: 'nothing-matches-this' }).items, [])
    } finally {
      indexer.dispose()
    }
  })
})

test('N02 indexing stays idle while the OCR plugin or the history switch is off', async () => {
  await withTempDirectory(async (directory) => {
    const store = new MemoryStore()
    const service = createService(directory, store)
    const item = persist(service)
    let settings = { plugins: { ocr: false }, screenshot: { historyEnabled: true } }
    const calls = []
    const indexer = createIndexer({
      service,
      settings: () => settings,
      recognize: async () => {
        calls.push('recognize')
        return { text: 'unused' }
      }
    })
    try {
      assert.equal(indexer.enqueue(item), false, 'the OCR plugin is off')
      settings = { plugins: { ocr: true }, screenshot: { historyEnabled: false } }
      assert.equal(indexer.enqueue(item), false, 'history is off')
      assert.deepEqual(calls, [])
      settings = { plugins: { ocr: true }, screenshot: { historyEnabled: true } }
      assert.equal(indexer.enqueue(item), true)
      await indexer.idle()
      assert.deepEqual(calls, ['recognize'])
    } finally {
      indexer.dispose()
    }
  })
})

test('N02 a record deleted while OCR runs drops the result instead of recreating it', async () => {
  await withTempDirectory(async (directory) => {
    const store = new MemoryStore()
    const service = createService(directory, store)
    const item = persist(service)
    let release
    let recognizeStarted
    const started = new Promise((resolve) => { recognizeStarted = resolve })
    const gate = new Promise((resolve) => { release = resolve })
    const indexer = createIndexer({
      service,
      recognize: async () => {
        recognizeStarted()
        await gate
        return { text: 'deleted record text' }
      }
    })
    service.attachOcrIndexer(indexer)
    try {
      assert.equal(indexer.enqueue(item), true)
      await started
      service.delete(item.id)
      assert.equal(service.getItem(item.id), null)
      release()
      await indexer.idle()
      assert.deepEqual(store.history, [], 'the OCR write must not re-create the deleted record')
      assert.equal(fs.existsSync(item.filePath), false)
    } finally {
      indexer.dispose()
      release()
    }
  })
})

test('N02 the queue dedupes ids, caps its length and runs one OCR at a time', async () => {
  await withTempDirectory(async (directory) => {
    const store = new MemoryStore()
    const service = createService(directory, store)
    const items = [persist(service), persist(service), persist(service)]
    let active = 0
    let maxActive = 0
    const indexer = createIndexer({
      service,
      maxQueueSize: 2,
      recognize: async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await new Promise((resolve) => setImmediate(resolve))
        active -= 1
        return { text: 'queued text' }
      }
    })
    try {
      assert.equal(indexer.enqueue(items[0]), true)
      assert.equal(indexer.enqueue(items[1]), true)
      assert.equal(indexer.enqueue(items[2]), false, 'the queue is bounded')
      assert.equal(indexer.enqueue(items[0]), false, 'a queued id is never queued twice')
      assert.equal(indexer.state().pending, 2)
      await indexer.idle()
      assert.equal(maxActive, 1, 'background OCR is serial')
      for (const item of items.slice(0, 2)) assert.equal(service.getItem(item.id).ocrText, 'queued text')
      // Once the backlog cleared the bounded queue accepts the dropped record.
      assert.equal(indexer.enqueue(items[2]), true)
      await indexer.idle()
      assert.equal(service.getItem(items[2].id).ocrText, 'queued text')
    } finally {
      indexer.dispose()
    }
  })
})

test('N02 a failing recognition is retried exactly once and then abandoned silently', async () => {
  await withTempDirectory(async (directory) => {
    const store = new MemoryStore()
    const service = createService(directory, store)
    const recovered = persist(service)
    const broken = persist(service)
    const logs = []
    let calls = 0
    const indexer = createIndexer({
      service,
      log: (...args) => logs.push(args.join(' ')),
      recognize: async () => {
        calls += 1
        if (calls === 1) throw new Error('transient sidecar start')
        if (calls === 2) return { text: 'recovered text' }
        throw new Error('permanent decode failure')
      }
    })
    try {
      assert.equal(indexer.enqueue(recovered), true)
      await indexer.idle()
      assert.equal(calls, 2, 'one failure plus one retry')
      assert.equal(service.getItem(recovered.id).ocrText, 'recovered text')
      assert.equal(indexer.state().failedCount, 0)
      assert.equal(indexer.enqueue(broken), true)
      await indexer.idle()
      assert.equal(calls, 4, 'the permanent failure gets no third attempt')
      assert.equal(service.getItem(broken.id).ocrText, undefined)
      assert.equal(indexer.state().failedCount, 1)
      assert.equal(logs.some((line) => line.includes('History OCR failed:')), true)
    } finally {
      indexer.dispose()
    }
  })
})

test('N02 dispose clears the queue and drops an in-flight result', async () => {
  await withTempDirectory(async (directory) => {
    const store = new MemoryStore()
    const service = createService(directory, store)
    const item = persist(service)
    let release
    let recognizeStarted
    const started = new Promise((resolve) => { recognizeStarted = resolve })
    const gate = new Promise((resolve) => { release = resolve })
    const indexer = createIndexer({
      service,
      recognize: async () => {
        recognizeStarted()
        await gate
        return { text: 'too late' }
      }
    })
    try {
      assert.equal(indexer.enqueue(item), true)
      await started
      indexer.dispose()
      release()
      const settled = await indexer.idle()
      assert.equal(settled.disposed, true)
      assert.equal(service.getItem(item.id).ocrText, undefined)
      assert.equal(indexer.enqueue(item), false, 'a disposed indexer accepts nothing new')
    } finally {
      indexer.dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// tags
// ---------------------------------------------------------------------------

test('N02 tags are normalized, persisted and searched through the existing filter', async () => {
  await withTempDirectory(async (directory) => {
    const store = new MemoryStore()
    const service = createService(directory, store)
    const item = persist(service)
    const longTag = 'x'.repeat(MAX_HISTORY_TAG_LENGTH + 12)
    const payload = [
      '  invoice ', 'Invoice', 'OCR', 7, '', '   ', longTag,
      'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta'
    ]
    const written = service.updateTags(item.id, payload)
    assert.ok(Array.isArray(written))
    assert.equal(written.length, MAX_HISTORY_TAG_COUNT)
    assert.deepEqual(written.slice(0, 5), ['invoice', 'OCR', longTag.slice(0, MAX_HISTORY_TAG_LENGTH), 'alpha', 'beta'])
    assert.equal(written.includes('Invoice'), false, 'duplicates are case-insensitive')
    assert.deepEqual(service.getItem(item.id).tags, written)
    assert.deepEqual(service.list({ query: 'ocr' }).items.map((row) => row.id), [item.id])
    assert.deepEqual(service.list({ query: 'gamma' }).items.map((row) => row.id), [item.id])
    // The card renders tags, so the list projection has to carry them.
    assert.deepEqual(service.list({ query: 'gamma' }).items[0].tags, written)
    // A second service on the same store reads the tags back: the write round-trips.
    const reloaded = createService(directory, store)
    assert.deepEqual(reloaded.getItem(item.id).tags, written)
    // Invalid writes are refused instead of silently clearing the list.
    assert.equal(service.updateTags(item.id, 'invoice,ocr'), null)
    assert.equal(service.updateTags('missing-record', ['a']), null)
    assert.deepEqual(service.getItem(item.id).tags, written)
    // An empty array is a valid edit: it clears the tags.
    assert.deepEqual(service.updateTags(item.id, []), [])
    assert.deepEqual(service.getItem(item.id).tags, [])
  })
})

test('N02 the tag normalizer keeps the documented shape without touching the store', () => {
  assert.equal(normalizeHistoryTags('ocr'), null)
  assert.equal(normalizeHistoryTags(null), null)
  assert.deepEqual(normalizeHistoryTags(['  a  b ', 'A B', '', 3, null]), ['a b'])
  assert.deepEqual(normalizeHistoryTags(['x'.repeat(MAX_HISTORY_TAG_LENGTH + 10)])[0].length, MAX_HISTORY_TAG_LENGTH)
  assert.equal(normalizeHistoryTags(Array.from({ length: 20 }, (_value, index) => `tag-${index}`)).length, MAX_HISTORY_TAG_COUNT)
  assert.equal(normalizeHistoryOcrText('  one\r\ntwo  '), 'one\ntwo')
  assert.equal(normalizeHistoryOcrText(42), '')
})

test('N02 OCR text is written once, kept across the history round-trip and discarded on delete', async () => {
  await withTempDirectory(async (directory) => {
    const store = new MemoryStore()
    let changes = 0
    const service = createService(directory, store, { onChanged: () => { changes += 1 } })
    const item = persist(service)
    changes = 0
    assert.equal(service.updateOcrText(item.id, '第一行\n第二行'), true)
    assert.equal(changes, 1, 'the index write notifies the history page once')
    assert.equal(store.writes, 2, 'the silent write is one store write, no second broadcast write')
    assert.equal(service.updateOcrText(item.id, '第一行\n第二行'), true)
    assert.equal(changes, 1, 'identical text is not written again')
    assert.equal(store.writes, 2)
    assert.equal(service.updateOcrText(item.id, '   '), false, 'empty text is not a write')
    assert.equal(service.updateOcrText('missing-record', 'text'), false, 'a deleted record is not re-created')
    assert.equal(service.updateOcrText('', 'text'), false, 'an empty id is rejected')
    assert.equal(service.updateOcrText(item.id, 'x'.repeat(30000)), true)
    assert.equal(service.getItem(item.id).ocrText.length, 20000, 'the stored text is capped')
    // writeHistory()/withoutFavorite keeps both search-only fields (only `favorite` is stripped).
    store.history[0] = { ...store.history[0], favorite: true }
    service.writeHistory(service.readHistory())
    assert.equal('favorite' in store.history[0], false)
    assert.equal(store.history[0].ocrText.length, 20000)
    // Deleting the record cancels any pending index work before the row disappears.
    const discarded = []
    service.attachOcrIndexer({ discard: (id) => discarded.push(id) })
    service.delete(item.id)
    assert.deepEqual(discarded, [item.id])
    assert.equal(service.getItem(item.id), null)
  })
})

// ---------------------------------------------------------------------------
// save path (capture domain) + IPC wiring
// ---------------------------------------------------------------------------

function createCaptureDomainHarness() {
  const persisted = []
  const enqueued = []
  const captureWindow = {
    isDestroyed: () => false,
    close: () => {},
    webContents: { send: () => {} }
  }
  const domain = createCaptureDomain({
    app: { isPackaged: false },
    spawn: () => ({
      stdout: { setEncoding: () => {}, on: () => {} },
      stderr: { setEncoding: () => {}, on: () => {} },
      once: () => {},
      stdin: { write: () => {}, end: () => {} },
      kill: () => {}
    }),
    execFile: () => {},
    fs: { existsSync: () => true },
    path,
    screen: {
      getDisplayMatching: () => ({ id: 1, scaleFactor: 1, bounds: { x: 0, y: 0, width: 800, height: 600 } }),
      getDisplayNearestPoint: () => ({ id: 1, scaleFactor: 1, bounds: { x: 0, y: 0, width: 800, height: 600 } }),
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      dipToScreenRect: (_display, bounds) => bounds
    },
    BrowserWindow: { fromWebContents: () => captureWindow },
    desktopCapturer: {},
    nativeImage: { createFromBuffer: () => fakeImage() },
    clipboard: { writeImage: () => {} },
    dialog: { showErrorBox: () => {}, showMessageBox: async () => ({ response: 0 }) },
    performance: { now: () => 0 },
    rootDirectory: root,
    isWin: false,
    createLocalWindow: () => captureWindow,
    getSettings: () => ({ screenshot: { historyEnabled: true } }),
    log: () => {},
    assertGameModeDisabled: () => {},
    getScreenshotDesktop: () => null,
    listNativeDisplays: () => [],
    findNativeDisplay: () => null,
    getNativeDisplayBounds: () => ({}),
    readPngSize: () => null,
    shouldFilterApp: () => false,
    pinDomain: { canPinMore: () => true, pinFromCapture: () => ({}) },
    createRecordWindow: async () => {},
    createLongCaptureFromSelection: async () => {},
    createRecognitionWindow: () => {},
    persistHistory: (_imageData, meta) => {
      const item = { id: `history-${persisted.length + 1}`, filePath: '/history/new.png', ...meta }
      persisted.push(item)
      return item
    },
    saveImageBuffer: async () => '',
    imageDataToBuffer: (value) => (Buffer.isBuffer(value) ? value : Buffer.from(String(value || ''))),
    dataUrlToBuffer: () => Buffer.from([1]),
    bufferToDataUrl: () => 'data:image/png;base64,AA==',
    performanceMonitor: { record: () => {}, snapshot: () => {} }
  })
  const attached = domain.attachHistoryOcrIndexer({
    enqueue: (item) => {
      enqueued.push(item)
      return true
    }
  })
  return {
    attached,
    controller: domain.createCaptureController(),
    enqueued,
    persisted
  }
}

test('N02 every history write in the capture domain hands the new record to the indexer', async () => {
  const harness = createCaptureDomainHarness()
  assert.equal(harness.attached, true)
  // Immediate path (recognition save).
  const saved = harness.controller.recordHistory({ sender: {} }, { imageBuffer: Buffer.from('png'), meta: {} })
  assert.equal(harness.persisted.length, 1)
  assert.deepEqual(harness.enqueued.map((row) => row.id), [saved.id])
  // Delayed path (pin schedules the history write on setImmediate): same door.
  harness.controller.pin({ sender: {} }, { imageBuffer: Buffer.from('png'), meta: {} })
  await flushMacrotasks()
  assert.equal(harness.persisted.length, 2)
  assert.deepEqual(harness.enqueued.map((row) => row.id), ['history-1', 'history-2'])
  // Nothing is enqueued when the domain short-circuits (skipped history).
  harness.controller.recordHistory({ sender: {} }, { imageBuffer: Buffer.from('png'), meta: { skipHistory: true } })
  assert.equal(harness.persisted.length, 2)
  assert.equal(harness.enqueued.length, 2)
})

test('N02 the history IPC channel routes the tag command envelope to HistoryService.updateTags', async () => {
  await withTempDirectory(async (directory) => {
    const store = new MemoryStore()
    const service = createService(directory, store)
    const item = persist(service)
    const handlers = new Map()
    const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) }
    registerHistoryIpc({
      ipcMain,
      historyService: service,
      copyItem: () => true,
      copyPathItem: () => true,
      editItem: () => true,
      openItem: () => true,
      chooseExportDirectory: async () => ''
    })
    const listHandler = handlers.get('history:list')
    const written = listHandler(null, { op: 'update-tags', id: item.id, tags: [' 账单 ', '账单', 'payout'] })
    assert.deepEqual(written, ['账单', 'payout'])
    assert.deepEqual(service.getItem(item.id).tags, ['账单', 'payout'])
    // A payload without the envelope discriminant keeps the original list contract.
    const page = listHandler(null, { query: '', limit: 10 })
    assert.deepEqual(page.items.map((row) => row.id), [item.id])
    // A missing record answers null, which the card reports as a failed edit.
    assert.equal(listHandler(null, { op: 'update-tags', id: 'gone', tags: ['x'] }), null)
  })
})

test('N02 wiring: the indexer is created once, attached to both paths and needs no main.js change', () => {
  const captureSource = read(path.join('main', 'domains', 'capture', 'index.js'))
  assert.match(captureSource, /let historyOcrIndexer = null/)
  assert.match(captureSource, /function attachHistoryOcrIndexer\(indexer\)/)
  assert.match(captureSource, /function persistHistoryEntry\(imageData, meta\)/)
  assert.match(captureSource, /enqueueHistoryOcr\(historyItem\)/)
  assert.match(captureSource, /enqueueHistoryOcr\(created\)/)
  // The definition plus the four record-producing call sites (copy/save/pin scheduling,
  // pin-copy, recognition and record-history all funnel through it).
  assert.ok((captureSource.match(/persistHistoryEntry\(/g) || []).length >= 5)
  assert.match(captureSource, /attachHistoryOcrIndexer,/)
  // The save path must hand over AFTER persisting, never before.
  const wrapper = captureSource.slice(captureSource.indexOf('function persistHistoryEntry'))
  assert.ok(wrapper.indexOf('persistHistory(imageData, meta)') < wrapper.indexOf('enqueueHistoryOcr(created)'))

  const ipcIndex = read(path.join('main', 'ipc', 'index.js'))
  assert.match(ipcIndex, /const \{ createHistoryOcrIndexer \} = require\('\.\.\/services\/history-ocr-indexer'\)/)
  assert.match(ipcIndex, /const historyOcrIndexer = createHistoryOcrIndexer\(\{/)
  assert.match(ipcIndex, /getHistoryService,\n\s+nativeImage,\n\s+log/)
  assert.match(ipcIndex, /captureDomain\.attachHistoryOcrIndexer\(historyOcrIndexer\)/)
  assert.match(ipcIndex, /service\.attachOcrIndexer\(ocrIndexer\)/)
  assert.match(ipcIndex, /app\.once\('will-quit', \(\) => historyOcrIndexer\.dispose\(\)\)/)
  assert.match(ipcIndex, /ocrIndexer: historyOcrIndexer/)
  assert.match(ipcIndex, /ocrController\.ocr\(null, \{ imageBuffer, \.\.\.options \}\)/)
  // main.js is frozen by H05: the assembly must not have needed it.
  assert.doesNotMatch(read('main.js'), /historyOcrIndexer|history-ocr-indexer|attachHistoryOcrIndexer/)

  const historyIpc = read(path.join('main', 'ipc', 'history-ipc.js'))
  assert.match(historyIpc, /const HISTORY_UPDATE_TAGS_OP = 'update-tags'/)
  assert.match(historyIpc, /function isUpdateTagsCommand\(payload\)/)
  assert.match(historyIpc, /if \(isUpdateTagsCommand\(filter\)\) \{/)
  assert.match(historyIpc, /historyService\.updateTags\(filter\.id, filter\.tags\)/)
  // No dedicated channel: the main-role surface is a frozen inventory (ipc-security.js) and
  // test/history-ipc.test.js pins this module's exact channel list, so the write rides the
  // existing 'history:list' envelope instead.
  assert.doesNotMatch(historyIpc, /ipcMain\.handle\('history:update-tags'/)

  const preload = read('preload.js')
  assert.match(preload, /updateHistoryTags: \(id, tags\) => ipcRenderer\.invoke\('history:list', \{/)
  assert.match(preload, /op: 'update-tags'/)

  const route = read(path.join('config', 'routes', 'history.js'))
  assert.match(route, /data-history-tag-input/)
  assert.match(route, /data-history-tag-remove/)
  assert.match(route, /window\.electronAPI\.updateHistoryTags\(id, tags\)/)
  assert.match(route, /t\('config\.history\.tags-placeholder'\)/)
  assert.match(route, /t\('config\.history\.tag-remove', \{ tag \}\)/)
  // Tags are part of the card signature, so an edit re-renders the card in place.
  assert.match(route, /Array\.isArray\(item\?\.tags\) \? item\.tags\.join/)
})

test('N02 the tag editor copy exists in all three language tables', () => {
  globalThis.__LOCALES = {}
  for (const name of fs.readdirSync(path.join(root, 'shared', 'locales')).filter((entry) => entry.endsWith('.js')).sort()) {
    const file = path.join(root, 'shared', 'locales', name)
    delete require.cache[require.resolve(file)]
    require(file)
  }
  const tables = {}
  for (const language of LANGUAGE_TABLES) tables[language] = globalThis.__LOCALES[language] || {}
  for (const language of LANGUAGE_TABLES) {
    for (const key of TAG_KEYS) {
      assert.equal(typeof tables[language][key], 'string', `${language} is missing ${key}`)
      assert.ok(tables[language][key].length > 0, `${language} has an empty value for ${key}`)
    }
    // The search box now advertises what it can match: tags and the text inside a capture.
    assert.match(tables[language]['config.history.search-placeholder'], /标签|tags|標籤/i)
    assert.match(tables[language]['config.history.tags-limit'], /\{max\}/)
  }
  // The config table's keys still match across languages after this change. Scoped to config.*
  // on purpose: this file only owns the settings-window table, and a sibling window's in-flight
  // locale edit must not fail this ticket's test.
  const configKeys = (table) => Object.keys(table).filter((key) => key.startsWith('config.')).sort()
  const reference = configKeys(tables['zh-CN'])
  assert.ok(reference.includes('config.history.tags-placeholder'))
  for (const language of LANGUAGE_TABLES.slice(1)) {
    assert.deepEqual(configKeys(tables[language]), reference, `${language} config key set drifted`)
  }
})
