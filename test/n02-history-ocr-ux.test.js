'use strict'

// N02 follow-up (real-device verification, 2026-11-27): the three interaction defects found
// while using the screenshot-history OCR index and tags on a real desktop:
//   1. typing Chinese into the search box failed: every IME keystroke ran the full page
//      render (220 ms debounce), which replaced the focused input mid-composition and left
//      only the pinyin letters in the box;
//   2. there was no way to tell "OCR found no text" from "OCR never ran", so a search with no
//      result was ambiguous;
//   3. tags could only be searched by typing them, with no dropdown listing the tags that
//      actually exist.
//
// This file pins the fixes at each layer:
//   * HistoryService: explicit OCR status + effective-status projection (stale `pending` after
//     a restart reads as unindexed), tag summary, exact tag filter;
//   * the background indexer's status transitions and explicit retry/backfill path;
//   * the frozen `history:list` command envelope's three new ops;
//   * the history route's composition-safe, results-only search path and the new UI controls;
//   * the preload surface and the three-language copy.
//
// The behaviour tests use the real HistoryService over a temp directory and the real indexer
// with a fake OCR service, the same idiom as test/n02-history-ocr.test.js; the renderer has no
// DOM harness in this repository, so its contracts are source-text assertions (see
// test/history-reedit-ui.test.js for why).

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  HistoryService,
  normalizeHistoryFilter,
  normalizeHistoryOcrStatus
} = require('../main/services/history-service')
const { createHistoryOcrIndexer } = require('../main/services/history-ocr-indexer')
const { registerHistoryIpc } = require('../main/ipc/history-ipc')
const { createHistoryFacade } = require('../main/ipc')

const root = path.join(__dirname, '..')
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8')
const historyRoute = read(path.join('config', 'routes', 'history.js'))
const preload = read('preload.js')
const styles = read(path.join('config', 'config.css'))
const LANGUAGES = ['zh-CN', 'en-US', 'zh-TW']

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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'highlighter-n02-ux-'))
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

async function withIndexer(options, callback) {
  const indexer = createIndexer(options)
  options.service.attachOcrIndexer(indexer)
  try {
    return await callback(indexer)
  } finally {
    indexer.dispose()
  }
}

// Lifts a pure helper out of the classic-script route file (same idiom as
// test/history-reedit-ui.test.js).
function sliceFunction(source, name) {
  const match = new RegExp(`(?:async )?function ${name} ?\\(`).exec(source)
  assert.ok(match, `expected function ${name}() in config/routes/history.js`)
  const open = source.indexOf('{', match.index)
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(match.index, index + 1)
    }
  }
  throw new Error(`unbalanced braces while lifting ${name}()`)
}

function evaluateHelpers(names) {
  const source = names.map((name) => sliceFunction(historyRoute, name)).join('\n')
  // eslint-disable-next-line no-new-func
  return new Function(`${source}\nreturn { ${names.join(', ')} }`)()
}

function functionBody(name) {
  return sliceFunction(historyRoute, name)
}

function localeTables() {
  globalThis.__LOCALES = {}
  for (const name of fs.readdirSync(path.join(root, 'shared', 'locales')).filter((entry) => entry.endsWith('.js')).sort()) {
    const file = path.join(root, 'shared', 'locales', name)
    delete require.cache[require.resolve(file)]
    require(file)
  }
  const tables = {}
  for (const language of LANGUAGES) tables[language] = globalThis.__LOCALES[language] || {}
  return tables
}

// ---------------------------------------------------------------------------
// 1. IME-safe, results-only search
// ---------------------------------------------------------------------------

test('N02 the search box ignores IME composition events and never full-renders per keystroke', () => {
  assert.match(historyRoute, /let historySearchComposing = false/)
  // Composition lifecycle: the debounce is cleared on start and only armed for committed text.
  assert.match(historyRoute, /searchInput\.oncompositionstart = \(\) => \{\s*historySearchComposing = true\s*clearTimeout\(historySearchTimer\)/)
  assert.match(historyRoute, /searchInput\.oncompositionend = \(\) => \{\s*historySearchComposing = false[\s\S]{0,200}?historyScheduleSearch\(\)/)
  // `input` events that Chromium fires mid-composition are ignored instead of searched.
  assert.match(historyRoute, /searchInput\.oninput = \(event\) => \{[\s\S]{0,600}?if \(event\?\.isComposing === true\) return\s*historySearchComposing = false/)
  // A composition that ends without compositionend must not leave the flag stuck and swallow
  // every later keystroke: an input event without isComposing recovers, and blur clears it.
  assert.match(historyRoute, /searchInput\.oninput = \(event\) => \{[\s\S]{0,600}?historySearchComposing = false\s*historyQuery = searchInput\.value/)
  assert.match(historyRoute, /searchInput\.onblur = \(\) => \{ historySearchComposing = false \}/)
  // A fresh input node starts with a clean composition state.
  assert.match(historyRoute, /A fresh input node starts clean[\s\S]{0,120}?historySearchComposing = false/)
  // Enter must not search while a candidate window owns it (Windows IMEs report keyCode 229).
  assert.match(historyRoute, /event\.isComposing === true \|\| event\.keyCode === 229/)
  // The search path no longer calls the full render: it goes through the filter path, which
  // replaces the result grid only.
  const schedule = functionBody('historyScheduleSearch')
  assert.match(schedule, /historyApplyFilters\(\)/)
  assert.doesNotMatch(schedule, /renderHistory\(\)/)
  const applyFilters = functionBody('historyApplyFilters')
  assert.match(applyFilters, /window\.electronAPI\.getHistory\(\{/)
  assert.match(applyFilters, /tag: historyTag/)
  // The filter path patches the existing cards (so thumbnails are not reloaded per keystroke).
  assert.match(applyFilters, /historyRenderFilteredResults\(state\)/)
  assert.match(functionBody('historyRenderFilteredResults'), /historyPatchCards\(state, state\.items\)/)
  // A results-only update must not rebuild the page shell (stats/filters/batch/scroll).
  assert.doesNotMatch(applyFilters, /view\.innerHTML/)
  assert.doesNotMatch(applyFilters, /document\.getElementById\('historySearch'\)/)
  // Leaving the route drops a half-finished composition state with the debounce.
  assert.match(functionBody('historyDeactivate'), /historySearchComposing = false/)
})

test('N02 a filter change keeps load more, thumbnails and the tag filter usable', () => {
  // The full-render closure owns "load more", but a filter change reuses its state object and
  // bumps state.version. The guard must compare that token (not the closure's renderVersion),
  // and the button must be re-enabled on every exit path, or the first keystroke kills paging.
  assert.match(historyRoute, /const token = state\.version/)
  assert.match(historyRoute, /historyListState !== state \|\| state\.version !== token/)
  assert.match(historyRoute, /finally \{\s*if \(currentRoute === 'history' && historyListState === state\) state\.loadMore\.disabled = false/)
  assert.match(historyRoute, /state\.version = renderVersion/)
  assert.match(historyRoute, /state\.version = refreshVersion/)
  // A results-only filter change bumps historyRenderVersion; an in-flight thumbnail IPC must
  // not be mistaken for a failed load (that used to poison every plate on the first keystroke).
  const loadThumbnail = functionBody('historyLoadThumbnail')
  assert.doesNotMatch(loadThumbnail, /renderVersion/)
  assert.match(loadThumbnail, /if \(!thumbnail\) \{\s*historyMarkThumbnailUnavailable\(imageElement\)\s*return/)
  assert.match(loadThumbnail, /if \(currentRoute === 'history' && imageElement\.isConnected\) imageElement\.src = thumbnail/)
  // An optional tag-read failure keeps the active tag filter instead of clearing it.
  assert.match(historyRoute, /window\.electronAPI\.getHistoryTags\(\)\.catch\(\(\) => null\)/)
  assert.match(historyRoute, /if \(historyTag && Array\.isArray\(tags\)\)/)
  assert.match(historyRoute, /const selectedTagFallback = !Array\.isArray\(tags\) && historyTag/)
  // The tag-reset refetch is a second await: it re-checks route/render generation afterwards.
  const renderPage = functionBody('renderHistoryPage')
  const refetchIndex = renderPage.indexOf('firstPage = await window.electronAPI.getHistory')
  assert.ok(refetchIndex > 0, 'expected the tag-reset refetch in renderHistoryPage')
  assert.ok(
    renderPage.indexOf("if (currentRoute !== 'history' || renderVersion !== historyRenderVersion) return", refetchIndex) > refetchIndex,
    'the second await must be followed by a route/render guard'
  )
})

test('N02 the search debounce is shared by the free-text box and the committed IME value', () => {
  // Both handlers assign the committed value before scheduling, so a full render re-entry
  // (delete/clear) restores what the user actually sees in the box.
  assert.match(historyRoute, /historySearchComposing = false\s*historyQuery = searchInput\.value\s*historyScheduleSearch\(\)/)
  assert.match(historyRoute, /searchInput\.oncompositionend = \(\) => \{[\s\S]{0,200}?historyQuery = searchInput\.value\s*historyScheduleSearch\(\)/)
  // Enter (outside a composition) skips the debounce but still uses the filter path.
  assert.match(historyRoute, /historyQuery = searchInput\.value\s*void historyApplyFilters\(\)/)
})

// ---------------------------------------------------------------------------
// 2. explicit OCR status
// ---------------------------------------------------------------------------

test('N02 OCR status values are normalized and unknown values are ignored', () => {
  assert.equal(normalizeHistoryOcrStatus('pending'), 'pending')
  assert.equal(normalizeHistoryOcrStatus(' DONE '), 'done')
  assert.equal(normalizeHistoryOcrStatus('empty'), 'empty')
  assert.equal(normalizeHistoryOcrStatus('failed'), 'failed')
  assert.equal(normalizeHistoryOcrStatus('skipped'), 'skipped')
  assert.equal(normalizeHistoryOcrStatus('running'), '', 'running was folded into pending')
  assert.equal(normalizeHistoryOcrStatus(''), '')
  assert.equal(normalizeHistoryOcrStatus(null), '')
})

test('N02 the indexer writes pending, done, empty and failed so the card can show the real state', async () => {
  await withTempDirectory(async (directory) => {
    const store = new MemoryStore()
    const service = createService(directory, store)
    const done = persist(service)
    const empty = persist(service)
    const broken = persist(service)
    let brokenCalls = 0
    await withIndexer({
      service,
      recognize: async (buffer) => {
        if (buffer.toString() === 'broken') {
          brokenCalls += 1
          throw new Error('decode failed')
        }
        if (buffer.toString() === 'empty') return { text: '   ' }
        return { text: '发票 100 元' }
      },
      prepareImage: async (filePath) => {
        if (filePath.endsWith('.png') && fs.existsSync(filePath)) {
          // Route the fake result by the record id stored in the file content.
          return Buffer.from(fs.readFileSync(filePath, 'utf8'))
        }
        return Buffer.from('image')
      }
    }, async (indexer) => {
      // `prepareImage` reads the persisted file; the test writes a marker into it first.
      fs.writeFileSync(done.filePath, 'image-text')
      fs.writeFileSync(empty.filePath, 'empty')
      fs.writeFileSync(broken.filePath, 'broken')
      const writesBeforeEnqueue = store.writes
      assert.equal(indexer.enqueue(done), true)
      // Accepting a job is an in-memory queue change plus one push: the history store is not
      // rewritten on the capture save path (the card's "识别中…" is derived from isActive()).
      assert.equal(store.writes, writesBeforeEnqueue, 'accepting a job does not rewrite the history store')
      const queued = service.list().items.find((row) => row.id === done.id)
      assert.equal(queued.ocrStatus, 'pending', 'a queued job shows up immediately through the projection')
      assert.equal(service.getItem(done.id).ocrStatus, undefined, 'no pending value is persisted')
      assert.equal(indexer.isActive(done.id), true)
      await indexer.idle()
      assert.equal(indexer.isActive(done.id), false)
      assert.equal(service.getItem(done.id).ocrStatus, 'done')
      assert.equal(service.getItem(done.id).ocrText, '发票 100 元')
      assert.equal(service.getItem(empty.id).ocrStatus, undefined, 'not queued yet')
      assert.equal(indexer.enqueue(empty), true)
      await indexer.idle()
      assert.equal(service.getItem(empty.id).ocrStatus, 'empty', 'empty recognition is a valid result')
      assert.equal(service.getItem(empty.id).ocrText, undefined)
      assert.equal(indexer.enqueue(broken), true)
      await indexer.idle()
      assert.equal(brokenCalls, 2, 'the indexer retries once')
      assert.equal(service.getItem(broken.id).ocrStatus, 'failed')
      // The list projection carries the status + character count, never the text itself.
      const page = service.ocrSummary()
      assert.deepEqual(page, {
        total: 3, indexed: 1, empty: 1, pending: 0, failed: 1, skipped: 0, unindexed: 0
      })
    })
  })
})

test('N02 a pending record from a previous run reads as unindexed instead of pretending to work', async () => {
  await withTempDirectory(async (directory) => {
    const store = new MemoryStore()
    const service = createService(directory, store)
    const item = persist(service)
    assert.equal(service.markOcrStatus(item.id, 'pending'), true)
    assert.equal(service.getItem(item.id).ocrStatus, 'pending')
    // No indexer attached yet (a fresh process): the persisted pending is stale.
    assert.equal(service.list().items[0].ocrStatus, '')
    let active = true
    service.attachOcrIndexer({ discard: () => {}, isActive: (id) => active && id === item.id })
    assert.equal(service.list().items[0].ocrStatus, 'pending')
    active = false
    assert.equal(service.list().items[0].ocrStatus, '')
    // The summary counts it as "needs indexing", which is what the page-level action targets.
    assert.equal(service.ocrSummary().unindexed, 1)
    assert.equal(service.ocrSummary().pending, 0)
  })
})

test('N02 records indexed by the first N02 release read as done without a migration', async () => {
  await withTempDirectory(async (directory) => {
    const store = new MemoryStore()
    const service = createService(directory, store)
    const item = persist(service)
    // Exactly the shape the first release wrote: ocrText, no ocrStatus field.
    service.writeItemFields(item.id, { ocrText: '第一行\n第二行' })
    const projected = service.list().items[0]
    assert.equal(projected.ocrStatus, 'done')
    assert.equal(projected.ocrTextLength, '第一行\n第二行'.length)
    assert.equal('ocrText' in projected, false, 'the search text stays in the main process')
    assert.equal(service.ocrSummary().indexed, 1)
  })
})

test('N02 markOcrStatus refuses unknown statuses and a deleted record', async () => {
  await withTempDirectory(async (directory) => {
    const store = new MemoryStore()
    const service = createService(directory, store)
    const item = persist(service)
    assert.equal(service.markOcrStatus(item.id, 'running'), false)
    assert.equal(service.getItem(item.id).ocrStatus, undefined)
    assert.equal(service.markOcrStatus('missing-record', 'failed'), false)
    service.delete(item.id)
    assert.equal(service.markOcrStatus(item.id, 'failed'), false)
  })
})

test('N02 the facade index action backfills only captures that still need an index', async () => {
  await withTempDirectory(async (directory) => {
    const store = new MemoryStore()
    const service = createService(directory, store)
    const unindexed = persist(service)
    const done = persist(service)
    const empty = persist(service)
    const failed = persist(service)
    const skipped = persist(service)
    const stalePending = persist(service)
    const missing = persist(service)
    service.writeItemFields(done.id, { ocrText: 'already indexed', ocrStatus: 'done' })
    service.markOcrStatus(empty.id, 'empty')
    service.markOcrStatus(failed.id, 'failed')
    service.markOcrStatus(skipped.id, 'skipped')
    service.markOcrStatus(stalePending.id, 'pending')
    fs.rmSync(missing.filePath, { force: true })
    const indexer = createIndexer({ service, recognize: async () => ({ text: '' }) })
    service.attachOcrIndexer(indexer)
    const facade = createHistoryFacade({
      getHistoryService: () => service,
      performanceMonitor: { measure: (_name, task) => task() },
      ocrIndexer: indexer
    })
    try {
      const result = facade.indexOcr({ all: true })
      // unindexed + failed + skipped + stale pending are retryable; done/empty are final results
      // and the record whose file vanished cannot be recognized at all.
      assert.equal(result.accepted, 4)
      assert.equal(result.skipped, 3)
      assert.equal(result.disabled, false)
      const state = facade.ocrState()
      assert.equal(state.queue.pending, 4)
      assert.equal(state.summary.pending, 4, 'accepted jobs project as pending without a store write')
      // The whole batch emits one queue notification, not one per accepted id.
      assert.equal(typeof service.notifyOcrQueue, 'function')
      // An explicit card retry is honoured for a finished record, and a missing id/file is skipped.
      assert.deepEqual(facade.indexOcr({ ids: [done.id] }), { accepted: 1, skipped: 0, disabled: false })
      assert.deepEqual(facade.indexOcr({ ids: [missing.id] }), { accepted: 0, skipped: 1, disabled: false })
      // OCR off answers disabled instead of queuing.
      assert.deepEqual(
        createHistoryFacade({
          getHistoryService: () => service,
          performanceMonitor: { measure: (_name, task) => task() },
          ocrIndexer: { ...indexer, enabled: () => false, enqueue: () => false, state: () => null }
        }).indexOcr({ all: true }),
        { accepted: 0, skipped: 0, disabled: true }
      )
    } finally {
      indexer.dispose()
    }
  })
})

test('N02 failure can be retried explicitly even though the automatic path stays quiet', async () => {
  await withTempDirectory(async (directory) => {
    const store = new MemoryStore()
    const service = createService(directory, store)
    const item = persist(service)
    let attempts = 0
    await withIndexer({
      service,
      recognize: async () => {
        attempts += 1
        if (attempts <= 2) throw new Error('sidecar unavailable')
        return { text: 'recovered' }
      }
    }, async (indexer) => {
      assert.equal(indexer.enqueue(item), true)
      await indexer.idle()
      assert.equal(service.getItem(item.id).ocrStatus, 'failed')
      assert.equal(indexer.has(item.id), true)
      assert.equal(indexer.enqueue(item), false, 'the automatic path does not retry a failure')
      assert.equal(indexer.enqueue(item, { force: true }), true, 'the card retry clears the entry')
      await indexer.idle()
      assert.equal(service.getItem(item.id).ocrStatus, 'done')
      assert.equal(service.getItem(item.id).ocrText, 'recovered')
      assert.equal(attempts, 3, 'two failed attempts, then one success on the explicit retry')
    })
  })
})

test('N02 a job dropped because OCR was switched off is reported as skipped', async () => {
  await withTempDirectory(async (directory) => {
    const store = new MemoryStore()
    const service = createService(directory, store)
    const item = persist(service)
    let settings = { plugins: { ocr: true }, screenshot: { historyEnabled: true } }
    await withIndexer({
      service,
      settings: () => settings,
      recognize: async () => ({ text: 'unused' })
    }, async (indexer) => {
      assert.equal(indexer.enqueue(item), true)
      // Queued in memory only: the projection reads "pending" while the store stays untouched.
      assert.equal(service.list().items[0].ocrStatus, 'pending')
      assert.equal(service.getItem(item.id).ocrStatus, undefined)
      // Disabled before the macrotask runs the job.
      settings = { plugins: { ocr: false }, screenshot: { historyEnabled: true } }
      await indexer.idle()
      assert.equal(service.getItem(item.id).ocrStatus, 'skipped')
      assert.equal(service.getItem(item.id).ocrText, undefined)
      assert.equal(indexer.enabled(), false)
    })
  })
})

test('N02 the queue snapshot exposes the record being recognized', async () => {
  await withTempDirectory(async (directory) => {
    const store = new MemoryStore()
    const service = createService(directory, store)
    const item = persist(service)
    let release
    let started
    const gate = new Promise((resolve) => { release = resolve })
    const began = new Promise((resolve) => { started = resolve })
    await withIndexer({
      service,
      recognize: async () => {
        started()
        await gate
        return { text: 'slow text' }
      }
    }, async (indexer) => {
      assert.equal(indexer.enqueue(item), true)
      await began
      const state = indexer.state()
      assert.equal(state.running, true)
      assert.equal(state.activeId, item.id)
      assert.equal(state.pending, 0)
      release()
      await indexer.idle()
      assert.equal(indexer.state().activeId, '')
      assert.equal(indexer.has(item.id), true)
    })
    release()
  })
})

// ---------------------------------------------------------------------------
// 3. tag dropdown data + exact tag filter
// ---------------------------------------------------------------------------

test('N02 the tag filter is an exact case-insensitive match, not a substring', async () => {
  await withTempDirectory(async (directory) => {
    const store = new MemoryStore()
    const service = createService(directory, store)
    const invoice = persist(service)
    const invoice2024 = persist(service)
    const untagged = persist(service)
    service.updateTags(invoice.id, ['Invoice', 'payout'])
    service.updateTags(invoice2024.id, ['invoice-2024'])
    assert.deepEqual(service.list({ tag: 'invoice' }).items.map((row) => row.id), [invoice.id])
    assert.deepEqual(service.list({ tag: ' INVOICE ' }).items.map((row) => row.id), [invoice.id])
    assert.deepEqual(service.list({ tag: 'payout' }).items.map((row) => row.id), [invoice.id])
    assert.deepEqual(service.list({ tag: 'invo' }).items, [], 'a partial tag is not a filter hit')
    assert.deepEqual(service.list({ tag: 'invoice-2024' }).items.map((row) => row.id), [invoice2024.id])
    assert.deepEqual(service.list({ tag: 'missing' }).items, [])
    assert.equal(service.list().items.length, 3, 'an empty tag filter keeps everything')
    assert.equal(service.list({ tag: 'invoice' }).items.some((row) => row.id === untagged.id), false)
    // The free-text query still substring-matches tags (shipped behaviour, kept for the box).
    assert.deepEqual(service.list({ query: 'payout' }).items.map((row) => row.id), [invoice.id])
    // The normalized filter carries the tag for the IPC layer.
    assert.equal(normalizeHistoryFilter({ tag: ' Invoice ' }).tag, 'Invoice')
  })
})

test('N02 listTags reports the tags that exist, with counts, most used first', async () => {
  await withTempDirectory(async (directory) => {
    const store = new MemoryStore()
    const service = createService(directory, store)
    const first = persist(service)
    const second = persist(service)
    const third = persist(service)
    service.updateTags(first.id, ['invoice', 'OCR'])
    service.updateTags(second.id, ['Invoice', 'payout'])
    service.updateTags(third.id, ['orphan'])
    const tags = service.listTags()
    // Casing comes from the first record seen (newest first), so the second record's 'Invoice'
    // wins over the first record's 'invoice'; grouping is still case-insensitive.
    assert.deepEqual(tags[0], { tag: 'Invoice', count: 2 })
    assert.deepEqual(tags.slice(1).map((entry) => entry.count), [1, 1, 1])
    assert.deepEqual(
      tags.slice(1).map((entry) => entry.tag).sort(),
      ['OCR', 'orphan', 'payout']
    )
    // Tag listing is memory-only (no per-record disk probe) but a record whose file vanished is
    // still dropped by list(): selecting its tag shows the empty state until cleanup().
    fs.rmSync(third.filePath, { force: true })
    assert.equal(service.list({ tag: 'orphan' }).items.length, 0)
  })
})

// ---------------------------------------------------------------------------
// 4. history:list command envelope
// ---------------------------------------------------------------------------

function registerFakeHistoryIpc(historyService) {
  const handlers = new Map()
  registerHistoryIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    historyService,
    copyItem: () => true,
    copyPathItem: () => true,
    editItem: () => true,
    openItem: () => true,
    chooseExportDirectory: async () => ''
  })
  return handlers.get('history:list')
}

test('N02 the frozen history channel routes the new tag/OCR commands and rejects unknown ops', () => {
  const calls = []
  const listHandler = registerFakeHistoryIpc({
    list: (filter) => ({ items: [], filter }),
    listTags: () => [{ tag: 'invoice', count: 2 }],
    ocrState: () => ({ summary: { unindexed: 1 }, queue: { pending: 0 }, enabled: true }),
    indexOcr: (options) => {
      calls.push(options)
      return { accepted: 1, skipped: 0, disabled: false }
    }
  })
  assert.deepEqual(listHandler(null, { op: 'list-tags' }), [{ tag: 'invoice', count: 2 }])
  assert.deepEqual(listHandler(null, { op: 'ocr-state' }), {
    summary: { unindexed: 1 }, queue: { pending: 0 }, enabled: true
  })
  assert.deepEqual(listHandler(null, { op: 'index-ocr', ids: ['a'] }), { accepted: 1, skipped: 0, disabled: false })
  assert.deepEqual(listHandler(null, { op: 'index-ocr', all: true }), { accepted: 1, skipped: 0, disabled: false })
  assert.deepEqual(calls, [{ ids: ['a'], all: false }, { ids: null, all: true }])
  // A payload without an op keeps the byte-for-byte list contract.
  assert.deepEqual(listHandler(null, { query: 'invoice' }), { items: [], filter: { query: 'invoice' } })
  // An unknown op is an error, not a silent list call.
  assert.throws(() => listHandler(null, { op: 'bogus' }), /Unsupported history command/)
  // An index command with no target must not default to "index the whole history": a renderer
  // typo would otherwise start a mass OCR run.
  assert.throws(() => listHandler(null, { op: 'index-ocr' }), /requires ids or all/)
  assert.throws(() => listHandler(null, { op: 'index-ocr', all: false }), /requires ids or all/)
  assert.equal(calls.length, 2, 'the malformed commands never reached the service')
})

// ---------------------------------------------------------------------------
// 5. renderer wiring
// ---------------------------------------------------------------------------

test('N02 the history page renders the tag dropdown instead of typed tag search', () => {
  assert.match(historyRoute, /<select id="historyTag"/)
  assert.match(historyRoute, /t\('config\.history\.all-tags'\)/)
  assert.match(historyRoute, /historyTagOptionsMarkup\(tagOptionList\)/)
  assert.match(historyRoute, /state\.tagSelect\.onchange = \(\) => \{\s*historyTag = state\.tagSelect\.value\s*void historyApplyFilters\(\)/)
  // Every list read carries the selected tag; a filter change must not silently drop it.
  assert.match(historyRoute, /tag: historyTag/)
  assert.match(historyRoute, /historyRenderTagOptions\(state, tags\)/)
  // A tag that disappears with its last record falls back to "all tags" (case-insensitive,
  // because the store groups tags that way) and the list is re-queried.
  assert.match(historyRoute, /const wanted = historyTag\.toLocaleLowerCase\(\)\s*const match = list\.find/)
  assert.match(historyRoute, /historyTag = match \? String\(match\.tag \|\| ''\) : ''/)
  assert.match(historyRoute, /historyTag\.toLocaleLowerCase\(\) !== previousTag\.toLocaleLowerCase\(\)/)
})

test('N02 the history page shows OCR status per card and a page-level recognition bar', () => {
  // Card: status chip on the thumbnail plate, generated from the projected status.
  assert.match(historyRoute, /data-history-ocr="\$\{escapeHtml\(status \|\| 'none'\)\}"/)
  assert.match(historyRoute, /function historyOcrStatusLabel\(item\)/)
  for (const key of [
    'config.history.ocr-pending',
    'config.history.ocr-done',
    'config.history.ocr-empty',
    'config.history.ocr-failed',
    'config.history.ocr-skipped',
    'config.history.ocr-unindexed'
  ]) {
    assert.match(historyRoute, new RegExp(`t\\('${key.replace(/\./g, '\\.')}'`), `${key} is not resolved`)
  }
  // Card action: index/retry text recognition for records without a live job.
  assert.match(historyRoute, /data-history-action="ocr" data-id="\$\{id\}"/)
  assert.match(historyRoute, /if \(action === 'ocr'\) \{ await historyIndexOcrItem\(button\); return \}/)
  assert.match(historyRoute, /window\.electronAPI\.indexHistoryOcr\(\{ ids: \[id\] \}\)/)
  // Page bar: the status read is refreshed on every push and after an explicit request.
  assert.match(historyRoute, /<div class="history-ocr-bar card" id="historyOcrBar" hidden>/)
  assert.match(historyRoute, /historyRenderOcrBar\(state, ocrSnapshot\)/)
  assert.match(historyRoute, /window\.electronAPI\.getHistoryOcrState\(\)/)
  assert.match(historyRoute, /window\.electronAPI\.indexHistoryOcr\(\{ all: true \}\)/)
  assert.match(historyRoute, /void refreshHistoryMeta\(state, refreshVersion\)/)
  assert.match(historyRoute, /function refreshHistoryMeta\(state, renderVersion\)/)
  // The badge is part of the card signature, so a background recognition patches the card
  // instead of leaving a stale "未识别" chip on screen.
  assert.match(historyRoute, /String\(item\?\.ocrStatus \?\? ''\),\s*String\(item\?\.ocrTextLength \?\? ''\),/)
  // Styles exist and use theme tokens only (no hardcoded hex).
  assert.match(styles, /\.history-ocr\{[^}]*position:absolute/)
  assert.match(styles, /\.history-ocr-bar\[hidden\]\{display:none\}/)
  assert.doesNotMatch(styles.match(/\.history-ocr\{[^}]*\}/)[0], /color:\s*#/)
})

test('N02 the preload loads tags and OCR state through the same envelope', () => {
  assert.match(preload, /getHistoryTags: \(\) => ipcRenderer\.invoke\('history:list', \{ op: 'list-tags' \}\)/)
  assert.match(preload, /getHistoryOcrState: \(\) => ipcRenderer\.invoke\('history:list', \{ op: 'ocr-state' \}\)/)
  assert.match(preload, /indexHistoryOcr: \(options\) => \{/)
  assert.match(preload, /op: 'index-ocr'/)
  assert.match(preload, /all: source\.all === true/)
})

test('N02 the page-level OCR bar logic is priority-ordered and silent when fully indexed', () => {
  const { historyOcrBarState } = evaluateHelpers(['historyOcrBarState'])
  // Nothing to report: no bar at all, so a fully indexed history adds no noise.
  assert.equal(historyOcrBarState(null), null)
  assert.equal(historyOcrBarState({ summary: { indexed: 12, empty: 1 }, queue: { pending: 0 }, enabled: true }), null)
  // A running/queued job wins over the backlog copy: the user sees progress first.
  assert.deepEqual(
    historyOcrBarState({ summary: { unindexed: 5 }, queue: { pending: 2, running: false }, enabled: true }),
    { mode: 'progress', count: 2, action: false }
  )
  assert.deepEqual(
    historyOcrBarState({ summary: { unindexed: 5 }, queue: { pending: 1, running: true }, enabled: true }),
    { mode: 'progress', count: 2, action: false }
  )
  // Idle queue + missing index: offer the one-click index action.
  assert.deepEqual(
    historyOcrBarState({ summary: { unindexed: 3, failed: 2, skipped: 1 }, queue: { pending: 0, running: false }, enabled: true }),
    { mode: 'backlog', count: 6, action: true }
  )
  // OCR switched off: explain why nothing will happen and do not offer a dead button.
  assert.deepEqual(
    historyOcrBarState({ summary: { unindexed: 3 }, queue: { pending: 0 }, enabled: false }),
    { mode: 'unavailable', count: 3, action: false }
  )
  // Garbage numbers do not produce a negative count.
  assert.deepEqual(
    historyOcrBarState({ summary: { unindexed: -4 }, queue: { pending: 'x', running: false }, enabled: true }),
    null
  )
})

test('N02 a background OCR write changes the card signature', () => {
  const { historyCardSignature } = evaluateHelpers([
    'historyDocumentId',
    'historyRevisionId',
    'historyVersion',
    'historyCardSignature'
  ])
  const base = {
    id: 'doc-a',
    documentId: 'doc-a',
    createdAt: 1700000000000,
    source: 'capture',
    width: 100,
    height: 80,
    tags: ['invoice']
  }
  const pending = historyCardSignature({ ...base, ocrStatus: 'pending' })
  const done = historyCardSignature({ ...base, ocrStatus: 'done', ocrTextLength: 12 })
  assert.notEqual(pending, historyCardSignature(base))
  assert.notEqual(pending, done)
  assert.match(done, /\|done\|12\|/)
  // Tags still participate (an edit re-renders the chips) and selection does not.
  assert.notEqual(historyCardSignature(base), historyCardSignature({ ...base, tags: [] }))
})

test('N02 a re-created card carries a half-typed tag draft over instead of dropping it', () => {
  // Adding the OCR fields to the signature makes a background recognition re-create the card.
  // If the user was typing a tag on that card at that moment, the draft must survive.
  assert.match(historyRoute, /function historyCaptureCardDraft\(card\)/)
  assert.match(historyRoute, /function historyRestoreCardDraft\(card, draft\)/)
  const patch = functionBody('historyPatchCards')
  assert.match(patch, /const draft = historyCaptureCardDraft\(card\)/)
  assert.match(patch, /historyRestoreCardDraft\(next, draft\)/)
  assert.match(historyRoute, /active\.matches\('\[data-history-tag-input\]'\)/)
})

// ---------------------------------------------------------------------------
// 6. copy
// ---------------------------------------------------------------------------

test('N02 the new history UI copy exists in all three language tables', () => {
  const tables = localeTables()
  const keys = [
    'config.history.all-tags',
    'config.history.ocr-pending',
    'config.history.ocr-done',
    'config.history.ocr-empty',
    'config.history.ocr-failed',
    'config.history.ocr-skipped',
    'config.history.ocr-unindexed',
    'config.history.ocr-action',
    'config.history.ocr-action-retry',
    'config.history.ocr-action-running',
    'config.history.ocr-progress',
    'config.history.ocr-backlog',
    'config.history.ocr-backlog-off',
    'config.history.ocr-index-missing',
    'config.history.ocr-index-queued',
    'config.history.ocr-index-started',
    'config.history.ocr-index-unavailable',
    'config.history.ocr-index-failed',
    'config.history.ocr-nothing-to-index'
  ]
  for (const language of LANGUAGES) {
    for (const key of keys) {
      assert.equal(typeof tables[language][key], 'string', `${language} is missing ${key}`)
      assert.ok(tables[language][key].length > 0, `${language} has an empty value for ${key}`)
    }
    assert.match(tables[language]['config.history.ocr-done'], /\{count\}/)
    assert.match(tables[language]['config.history.ocr-progress'], /\{count\}/)
    assert.match(tables[language]['config.history.ocr-backlog'], /\{count\}/)
    assert.match(tables[language]['config.history.ocr-backlog-off'], /\{count\}/)
    assert.match(tables[language]['config.history.ocr-index-queued'], /\{count\}/)
  }
  // Every key is actually resolved by the route (a key only the test knows is dead weight).
  for (const key of keys) {
    assert.match(historyRoute, new RegExp(`t\\('${key.replace(/\./g, '\\.')}'`), `${key} is not used`)
  }
  // The three tables keep identical key sets after this change (check-i18n enforces it too).
  const reference = Object.keys(tables['zh-CN']).sort()
  for (const language of LANGUAGES.slice(1)) {
    assert.deepEqual(Object.keys(tables[language]).sort(), reference, `${language} key set drifted`)
  }
})
