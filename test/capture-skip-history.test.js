'use strict'

// B01 (docs/reviews/2026-11-24-windows-product-architecture-review.md):
// "let this capture skip history".
//
// The feature is only trustworthy if ONE decision covers every place a screenshot can
// leave a copy. These tests walk three layers:
//   1. the pure write plan (action x switch -> history / file / revision / thumbnail);
//   2. the capture domain's real handlers, including the delayed-write race (a skipped
//      result must schedule nothing, so closing and flushing cannot resurrect a record);
//   3. the edit path (CaptureDocumentService.commit) plus the source/locale contracts
//      that keep the renderer, the preload and the three language tables in step.
//
// Deliberately no Electron: every collaborator is a fake, exactly like
// test/capture-pin-copy.test.js, because the contract under test is the decision logic.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const root = path.join(__dirname, '..')
const html = fs.readFileSync(path.join(root, 'capture', 'capture.html'), 'utf8')
const script = fs.readFileSync(path.join(root, 'capture', 'capture.js'), 'utf8')
const preload = fs.readFileSync(path.join(root, 'preload-capture.js'), 'utf8')
const captureDomainSource = fs.readFileSync(path.join(root, 'main', 'domains', 'capture', 'index.js'), 'utf8')
const documentServiceSource = fs.readFileSync(path.join(root, 'main', 'services', 'capture-document-service.js'), 'utf8')

const {
  CAPTURE_WRITE_ACTIONS,
  CLIPBOARD_HISTORY_EXCLUSION_FORMATS,
  normalizeCaptureWriteAction,
  planCaptureWrites,
  planClipboardPublish,
  createCaptureDomain
} = require('../main/domains/capture')
const { CaptureDocumentService, DEFAULT_REVISION_LIMIT } = require('../main/services/capture-document-service')
const { HistoryService } = require('../main/services/history-service')

const flushWrites = () => new Promise((resolve) => setTimeout(resolve, 5))

// ---------------------------------------------------------------------------
// 1. The pure write plan: one switch, every write path.
// ---------------------------------------------------------------------------

const HISTORY_ACTIONS = [
  'copy', 'save', 'pin', 'pin-copy', 'pin-reannotate',
  'ocr', 'translate', 'table', 'qr', 'convert', 'record-history'
]

test('the switch zeroes every history path for the actions a capture can take', () => {
  for (const action of HISTORY_ACTIONS) {
    const plan = planCaptureWrites({ action, skipHistory: true })
    assert.equal(plan.historyRecords, 0, action + ' must not write a history row when skipped')
    assert.equal(plan.thumbnail, false, action + ' must not write a thumbnail when skipped')
    assert.equal(plan.revisions, 0, action + ' must not write a revision when skipped')
    assert.equal(plan.skipHistory, true)
  }
  // Without the switch the same actions keep their shipped single record.
  for (const action of HISTORY_ACTIONS) {
    assert.equal(planCaptureWrites({ action }).historyRecords, 1, action + ' keeps one record by default')
  }
})

test('copy: skip also disables the auto-save; without it the two outputs are independent', () => {
  const skipped = planCaptureWrites({ action: 'copy', skipHistory: true, autoSaveOnCopy: true, hasSaveDirectory: true })
  assert.equal(skipped.historyRecords, 0)
  assert.equal(skipped.autoSaveFile, false, 'the copy auto-save is a second persistent copy and must be skipped too')

  const saved = planCaptureWrites({ action: 'copy', autoSaveOnCopy: true, hasSaveDirectory: true })
  assert.equal(saved.historyRecords, 1)
  assert.equal(saved.autoSaveFile, true)

  const noDirectory = planCaptureWrites({ action: 'copy', autoSaveOnCopy: true, hasSaveDirectory: false })
  assert.equal(noDirectory.autoSaveFile, false, 'no remembered directory means no auto-save')

  // Globally disabled history is 0 records as well, but it does not suppress the file
  // that "auto-save on copy" would otherwise produce.
  const globallyOff = planCaptureWrites({ action: 'copy', historyEnabled: false, autoSaveOnCopy: true, hasSaveDirectory: true })
  assert.equal(globallyOff.historyRecords, 0)
  assert.equal(globallyOff.autoSaveFile, true)
})

test('an explicit save is exactly one file and no history row when skipped', () => {
  const skipped = planCaptureWrites({ action: 'save', skipHistory: true })
  assert.equal(skipped.explicitFiles, 1, 'the user asked for a file, so the file is still written')
  assert.equal(skipped.historyRecords, 0)
  assert.equal(skipped.autoSaveFile, false)

  const kept = planCaptureWrites({ action: 'save' })
  assert.equal(kept.explicitFiles, 1)
  assert.equal(kept.historyRecords, 1)
})

test('continue-editing is the commit plan: no revision and no thumbnail when skipped', () => {
  assert.equal(normalizeCaptureWriteAction('continue-edit'), 'commit')
  const skipped = planCaptureWrites({ action: 'continue-edit', skipHistory: true })
  assert.equal(skipped.action, 'commit')
  assert.equal(skipped.revisions, 0)
  assert.equal(skipped.thumbnail, false)
  assert.equal(skipped.historyRecords, 0)

  const kept = planCaptureWrites({ action: 'commit' })
  assert.equal(kept.revisions, 1)
  assert.equal(kept.thumbnail, true)
  assert.equal(kept.historyRecords, 1)
})

test('PDF and unknown actions stay inside their shipped semantics', () => {
  // A PDF is an explicit file with no history row today; the switch changes nothing.
  assert.equal(planCaptureWrites({ action: 'pdf' }).historyRecords, 0)
  assert.equal(planCaptureWrites({ action: 'pdf', skipHistory: true }).historyRecords, 0)
  // An action the plan does not know still defaults to "one record unless skipped".
  assert.equal(planCaptureWrites({ action: 'something-new' }).historyRecords, 1)
  assert.equal(planCaptureWrites({ action: 'something-new', skipHistory: true }).historyRecords, 0)
  assert.deepEqual([...CAPTURE_WRITE_ACTIONS].sort(), [
    'commit', 'continue-edit', 'convert', 'copy', 'ocr', 'pdf',
    'pin', 'pin-copy', 'pin-reannotate', 'qr', 'record-history', 'save', 'table', 'translate'
  ])
  // The plan never mutates its input.
  const options = { action: 'copy', skipHistory: true, autoSaveOnCopy: true, hasSaveDirectory: true }
  const before = JSON.stringify(options)
  planCaptureWrites(options)
  assert.equal(JSON.stringify(options), before)
})

test('the clipboard publication names the Windows exclusion formats and admits pending wiring', () => {
  assert.deepEqual(planClipboardPublish({}), { private: false, status: 'plain', formats: [] })
  const pending = planClipboardPublish({ skipHistory: true })
  assert.equal(pending.private, false)
  assert.equal(pending.status, 'pending-native')
  assert.deepEqual(pending.formats, [...CLIPBOARD_HISTORY_EXCLUSION_FORMATS])
  const native = planClipboardPublish({ skipHistory: true, nativeWriter: true })
  assert.equal(native.private, true)
  assert.equal(native.status, 'private')
  // The three names Windows and native/clipboard/src/capture.rs both honour.
  assert.deepEqual([...CLIPBOARD_HISTORY_EXCLUSION_FORMATS], [
    'ExcludeClipboardContentFromMonitorProcessing',
    'Clipboard Viewer Ignore',
    'CanIncludeInClipboardHistory'
  ])
})

// ---------------------------------------------------------------------------
// 2. The capture domain: same decision at the real handlers.
// ---------------------------------------------------------------------------

function createHarness(options = {}) {
  const persisted = []
  const saved = []
  const messages = []
  const recognitions = []
  const pins = []
  const clipboard = { writes: 0 }
  const documentCommits = []
  const broadcasts = []
  const settings = { screenshot: { historyEnabled: options.historyEnabled !== false, ...(options.screenshot || {}) } }
  let destroyed = false
  let clipboardDrops = options.clipboardDrops === true
  const pinWindow = { isDestroyed: () => false }
  const captureWindow = {
    isDestroyed: () => destroyed,
    close: () => { destroyed = true; clearTimeout(captureWindow._renderTimeout) },
    setAlwaysOnTop: () => {},
    setPosition: () => {},
    setBounds: () => {},
    setResizable: () => {},
    setOpacity: () => {},
    showInactive: () => {},
    focus: () => {},
    loadFile: () => Promise.resolve(),
    on: () => {},
    getContentBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
    getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
    webContents: { send: () => {} }
  }
  const deps = {
    app: { isPackaged: false },
    spawn: () => ({
      stdout: { setEncoding: () => {}, on: () => {} },
      stderr: { setEncoding: () => {}, on: () => {} },
      once: () => {}, stdin: { write: () => {}, end: () => {} }, kill: () => {}
    }),
    fs: { existsSync: () => false },
    path,
    screen: {
      getDisplayMatching: () => ({ id: 1, scaleFactor: 1, bounds: { x: 0, y: 0, width: 800, height: 600 }, workArea: { x: 0, y: 0, width: 800, height: 600 } }),
      getDisplayNearestPoint: () => ({ id: 1, scaleFactor: 1, bounds: { x: 0, y: 0, width: 800, height: 600 }, workArea: { x: 0, y: 0, width: 800, height: 600 } }),
      getCursorScreenPoint: () => ({ x: 10, y: 10 }),
      dipToScreenRect: (_display, bounds) => bounds
    },
    BrowserWindow: { fromWebContents: () => captureWindow },
    nativeImage: { createFromBuffer: () => ({ getSize: () => ({ width: 3, height: 2 }) }) },
    clipboard: {
      writeImage: () => { clipboard.writes += 1 },
      readImage: () => ({ getSize: () => (clipboardDrops ? { width: 1, height: 1 } : { width: 3, height: 2 }) })
    },
    dialog: {
      showErrorBox: (title, message) => messages.push({ kind: 'error', title, message }),
      showMessageBox: (payload) => { messages.push({ kind: 'message', ...payload }); return Promise.resolve({ response: 0 }) }
    },
    performance: { now: () => 0 },
    rootDirectory: root,
    isWin: false,
    createLocalWindow: () => captureWindow,
    getSettings: () => settings,
    log: () => {},
    assertGameModeDisabled: () => {},
    getDisplayCapture: async () => ({ imageBuffer: Buffer.from([1]), sourceId: 's', scaleFactor: 1 }),
    pinDomain: {
      bringPinToFront: () => {},
      canPinMore: () => true,
      pinFromCapture: (...args) => {
        pins.push(args)
        if (options.pinThrows) throw new Error('pin failed')
        return { pinWindow, captureWindow }
      }
    },
    createRecordWindow: async () => {},
    createLongCaptureFromSelection: async () => {},
    createRecognitionWindow: (type, url) => recognitions.push({ type, url }),
    persistHistory: (_buffer, meta) => { persisted.push(meta) },
    saveImageBuffer: async (_buffer, opts) => {
      saved.push(opts || {})
      return options.savePath === undefined ? 'C:/shots/only.png' : options.savePath
    },
    imageDataToBuffer: (value) => (Buffer.isBuffer(value) ? value : Buffer.from(String(value || ''))),
    dataUrlToBuffer: () => Buffer.from([1]),
    bufferToDataUrl: () => 'data:image/png;base64,AA==',
    performanceMonitor: { record: () => {}, snapshot: () => {} },
    getCaptureDocumentService: () => ({
      commit: async (payload) => { documentCommits.push(payload); return { ok: true, status: 'skipped', code: 'history-skipped' } }
    }),
    mainWindowBroadcast: (payload) => broadcasts.push(payload)
  }
  const domain = createCaptureDomain(deps)
  return {
    domain,
    deps,
    controller: domain.createCaptureController(),
    captureWindow,
    pinWindow,
    settings,
    persisted,
    saved,
    messages,
    recognitions,
    pins,
    clipboard,
    documentCommits,
    broadcasts,
    closeWindow: () => { destroyed = true },
    setClipboardDropped: (value) => { clipboardDrops = value === true }
  }
}

const event = () => ({ sender: {} })
const payload = (meta = {}, extra = {}) => ({ imageBuffer: Buffer.from([1, 2, 3]), meta: { width: 3, height: 2, ...meta }, ...extra })

test('domain copy with the switch writes the clipboard and nothing else', async () => {
  const harness = createHarness({ screenshot: { autoSaveOnCopy: true, lastSaveDirectory: 'E:/shots' } })
  const receipt = harness.controller.copy(event(), payload({ skipHistory: true }))
  assert.equal(receipt.ok, true)
  assert.equal(receipt.clipboard, 'windows')
  assert.equal(receipt.history, 'skipped')
  assert.equal(receipt.exclusion, 'pending-native', 'the exclusion is reported as pending, never claimed')
  assert.equal(harness.clipboard.writes, 1, 'the explicit copy still reaches the clipboard')
  await flushWrites()
  assert.equal(harness.persisted.length, 0, 'no history row')
  assert.equal(harness.saved.length, 0, 'no auto-save file')
})

test('domain copy stations the exclusion formats on the native seam when one is injected', () => {
  const calls = []
  const harness = createHarness()
  // Same factory, one optional dependency: this is the future native publication.
  const domain = createCaptureDomain({
    ...harness.deps,
    writeClipboardImage: (image) => { calls.push(image); return { ok: true } }
  })
  const receipt = domain.createCaptureController().copy(event(), payload({ skipHistory: true }))
  assert.equal(calls.length, 1)
  assert.equal(receipt.exclusion, 'private')
  assert.equal(harness.clipboard.writes, 0, 'the native publication replaces the plain Electron write')
})

test('copy without the switch keeps its record and its auto-save (regression)', async () => {
  const harness = createHarness({ screenshot: { autoSaveOnCopy: true, lastSaveDirectory: 'E:/shots' } })
  assert.equal(harness.controller.copy(event(), payload()), null)
  await flushWrites()
  assert.equal(harness.persisted.length, 1)
  assert.equal(harness.persisted[0].action, 'copy')
  assert.deepEqual(harness.saved, [{ fast: true }])
})

test('a skipped capture schedules nothing, so closing the window cannot resurrect a record', async () => {
  const harness = createHarness({ screenshot: { autoSaveOnCopy: true, lastSaveDirectory: 'E:/shots' } })
  harness.controller.copy(event(), payload({ skipHistory: true }))
  // The overlay closes right after copy in the shipped flow; the result must already be
  // decided, and no delayed task may fire afterwards.
  harness.closeWindow()
  await flushWrites()
  assert.equal(harness.persisted.length, 0)
  assert.equal(harness.saved.length, 0)
  assert.equal(harness.clipboard.writes, 1)
})

test('the same result records at most once even when an action is dispatched twice', async () => {
  const harness = createHarness()
  harness.controller.copy(event(), payload())
  harness.controller.copy(event(), payload())
  await flushWrites()
  assert.equal(harness.persisted.length, 1, 'a repeated copy is not a second capture')

  const skipped = createHarness()
  skipped.controller.copy(event(), payload({ skipHistory: true }))
  skipped.controller.copy(event(), payload({ skipHistory: true }))
  await flushWrites()
  assert.equal(skipped.persisted.length, 0)
})

test('a normal copy still writes after the window is gone (the shipped behaviour, unchanged)', async () => {
  const harness = createHarness()
  harness.controller.copy(event(), payload())
  harness.closeWindow()
  await flushWrites()
  assert.equal(harness.persisted.length, 1, 'copy closes its overlay before the delayed write runs by design')
})

test('an explicit save keeps the user file, skips history and reports the actual path', async () => {
  const harness = createHarness({ savePath: 'C:/users/me/Desktop/only-this.png' })
  harness.controller.save(event(), payload({ skipHistory: true }))
  await flushWrites()
  assert.deepEqual(harness.saved, [{ fast: false }], 'the explicit file is still written')
  assert.equal(harness.persisted.length, 0, 'no history row for the skipped save')
  assert.equal(harness.messages.length, 1)
  assert.equal(harness.messages[0].kind, 'message')
  assert.equal(harness.messages[0].detail, 'C:/users/me/Desktop/only-this.png', 'the real path is shown')
  assert.ok(harness.messages[0].message.length > 0)
  assert.equal(harness.captureWindow.isDestroyed(), true, 'the plain save still closes the overlay')
})

test('a canvas save keeps its record and shows no path box (regression)', async () => {
  const harness = createHarness()
  harness.controller.save(event(), payload())
  await flushWrites()
  assert.equal(harness.persisted.length, 1)
  assert.equal(harness.messages.length, 0)
})

test('a cancelled save writes neither a file nor a record', async () => {
  const harness = createHarness({ savePath: null })
  harness.controller.save(event(), payload({ skipHistory: true }))
  await flushWrites()
  assert.equal(harness.persisted.length, 0)
  assert.equal(harness.messages.length, 0, 'a cancel is not a saved file, so there is no path to show')
})

test('pin with the switch still pins, marks the pin, and writes no history', async () => {
  const harness = createHarness()
  assert.equal(harness.controller.pin(event(), payload({ skipHistory: true })), null)
  assert.equal(harness.pins.length, 1, 'the pin output itself is not suppressed')
  assert.equal(harness.pinWindow._skipHistory, true, 'the pin hands the switch to its re-annotate editor')
  await flushWrites()
  assert.equal(harness.persisted.length, 0)
})

test('pin and copy with the switch reports both outputs but records nothing', async () => {
  const harness = createHarness()
  const receipt = harness.controller.pin(event(), payload({ skipHistory: true }, { copy: true }))
  assert.equal(receipt.ok, true)
  assert.equal(receipt.recorded, false)
  assert.equal(receipt.history, 'skipped')
  assert.equal(harness.pins.length, 1)
  assert.equal(harness.clipboard.writes, 1)
  await flushWrites()
  assert.equal(harness.persisted.length, 0)
})

test('a retry cannot turn a skipped result into a record', async () => {
  const harness = createHarness({ clipboardDrops: true })
  const first = harness.controller.pin(event(), payload({ skipHistory: true }, { copy: true }))
  assert.deepEqual(first.failed, ['copy'])
  assert.equal(first.recorded, false)
  await flushWrites()
  assert.equal(harness.persisted.length, 0)

  harness.setClipboardDropped(false)
  const retry = harness.controller.pin(event(), payload({ skipHistory: true }, { retry: 'copy' }))
  assert.equal(retry.outputs.copy.ok, true)
  assert.equal(retry.recorded, false)
  await flushWrites()
  assert.equal(harness.persisted.length, 0, 'the retry belongs to the same skipped result')
})

test('recognition still opens while its history row is skipped', async () => {
  const harness = createHarness()
  const result = harness.controller.openRecognition(event(), payload({ skipHistory: true }, { type: 'ocr' }))
  assert.deepEqual(result, { ok: true, history: 'skipped' })
  assert.equal(harness.recognitions.length, 1)
  await flushWrites()
  assert.equal(harness.persisted.length, 0)
  // The capture overlay still closes on this handoff, so its smart-select session is
  // disposed by the existing close path; the recognition window stays the owner of the
  // OCR temp resources (unchanged by the switch).
  assert.equal(harness.captureWindow.isDestroyed(), true)
})

test('the legacy record-history channel honours the switch too', async () => {
  const harness = createHarness()
  assert.deepEqual(harness.controller.recordHistory(event(), payload({ skipHistory: true })), { ok: true, history: 'skipped' })
  await flushWrites()
  assert.equal(harness.persisted.length, 0)
})

test('the document commit receives the switch and is broadcast only when committed', async () => {
  const harness = createHarness()
  const result = await harness.controller.commitDocument(event(), {
    sessionId: 'session-1',
    requestId: 'req-1',
    intent: 'update',
    skipHistory: true
  })
  assert.equal(result.status, 'skipped')
  assert.equal(harness.documentCommits.length, 1)
  assert.equal(harness.documentCommits[0].skipHistory, true)
  assert.equal(harness.broadcasts.length, 0)
})

test('the window opened from a skipped pin starts skipped and ships it in the init payload', async () => {
  const harness = createHarness()
  const win = await harness.domain.createCaptureWindow({
    mode: 'image',
    imageBuffer: Buffer.from([1]),
    editingPinWindow: { _skipHistory: true }
  })
  assert.equal(win._captureInit.skipHistory, true)
  assert.equal(win._skipHistory, true)
  clearTimeout(win._renderTimeout)
})

test('a plain capture window starts with the switch off (the renderer applies the global default)', async () => {
  const harness = createHarness()
  const win = await harness.domain.createCaptureWindow({ mode: 'image', imageBuffer: Buffer.from([1]) })
  assert.equal(win._captureInit.skipHistory, false)
  clearTimeout(win._renderTimeout)
})

// ---------------------------------------------------------------------------
// 3. Editable history: a skipped commit writes no revision and no thumbnail.
// ---------------------------------------------------------------------------

const PNG_800x600 = (() => {
  const buffer = Buffer.alloc(33)
  buffer.writeUInt32BE(0x89504e47, 0)
  buffer.writeUInt32BE(0x0d0a1a0a, 4)
  buffer.writeUInt32BE(13, 8)
  buffer.write('IHDR', 12, 'ascii')
  buffer.writeUInt32BE(800, 16)
  buffer.writeUInt32BE(600, 20)
  return buffer
})()

class MemoryStore {
  constructor(history = []) { this.history = history; this.writes = 0 }
  get(key, fallback) { return key === 'captureHistory' ? this.history : fallback }
  set(key, value) { if (key === 'captureHistory') { this.history = value; this.writes += 1 } }
}

function createDocumentServiceHarness() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'highlighter-skip-'))
  const store = new MemoryStore()
  const settings = { screenshot: { historyDirectory: directory, historyEnabled: true, historyLimit: 200, historyRevisionLimit: DEFAULT_REVISION_LIMIT } }
  let idSeq = 0
  const service = new CaptureDocumentService({
    historyService: {
      defaultHistoryDirectory: directory,
      nativeImage: { createFromPath: () => ({ isEmpty: () => false, getSize: () => ({ width: 120, height: 80 }), resize: () => ({ toPNG: () => Buffer.from('thumb') }) }) },
      ensureDirectory: (target) => fs.mkdirSync(target, { recursive: true }) || target,
      readHistory: () => (Array.isArray(store.get('captureHistory', [])) ? store.get('captureHistory', []) : []),
      writeHistory: (history) => store.set('captureHistory', history),
      writeHistorySilently: (history) => store.set('captureHistory', history)
    },
    getSettings: () => settings,
    assertWritable: () => {},
    createId: () => 'id' + (idSeq += 1),
    now: () => 1792886400000 + idSeq
  })
  return { service, store, directory, settings, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) }
}

test('a skipped commit returns an explicit skipped receipt and touches no file', async () => {
  const harness = createDocumentServiceHarness()
  try {
    const session = harness.service.beginSession({ documentId: '', intent: 'create', windowId: 1, source: 'region' }).session
    const before = fs.readdirSync(harness.directory)
    const result = await harness.service.commit({
      sessionId: session.sessionId,
      requestId: 'req-skip-1',
      intent: 'create',
      snapshot: Buffer.from('{}'),
      resultBuffer: PNG_800x600,
      newBaseBuffer: PNG_800x600,
      skipHistory: true
    })
    assert.equal(result.ok, true)
    assert.equal(result.status, 'skipped')
    assert.equal(result.code, 'history-skipped')
    assert.equal(result.historyStatus, 'skipped')
    assert.equal(harness.store.writes, 0, 'no index entry')
    assert.deepEqual(fs.readdirSync(harness.directory), before, 'no file, base image, revision or thumbnail')
  } finally {
    harness.cleanup()
  }
})

test('a skipped commit still reports an expired session instead of pretending to be safe', async () => {
  const harness = createDocumentServiceHarness()
  try {
    const result = await harness.service.commit({ sessionId: 'session-missing', requestId: 'r', intent: 'update', skipHistory: true })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'session-expired')
    assert.equal(harness.store.writes, 0)
  } finally {
    harness.cleanup()
  }
})

test('a skipped commit with an invalid intent is rejected, not silently skipped', async () => {
  const harness = createDocumentServiceHarness()
  try {
    const session = harness.service.beginSession({ documentId: '', intent: 'create', windowId: 1, source: 'region' }).session
    const result = await harness.service.commit({ sessionId: session.sessionId, requestId: 'r', intent: 'nonsense', skipHistory: true })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'invalid-intent')
  } finally {
    harness.cleanup()
  }
})

test('HistoryService refuses a skipped meta at every write entry point', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'highlighter-skip-history-'))
  try {
    const store = new MemoryStore()
    const service = new HistoryService({
      store,
      nativeImage: {
        createFromBuffer: () => ({ isEmpty: () => false, getSize: () => ({ width: 4, height: 3 }), resize: () => ({ toPNG: () => Buffer.from('thumb') }) }),
        createFromPath: () => ({ isEmpty: () => false, getSize: () => ({ width: 4, height: 3 }), resize: () => ({ toPNG: () => Buffer.from('thumb') }) })
      },
      sharp: null,
      getSettings: () => ({ screenshot: { historyEnabled: true, historyDirectory: directory, historyLimit: 200, nameTemplate: '' } }),
      assertWritable: () => {},
      defaultHistoryDirectory: directory,
      makeCaptureName: (prefix, extension) => prefix + '-skip-test.' + extension,
      log: () => {}
    })
    const sourcePath = path.join(directory, 'source.png')
    fs.writeFileSync(sourcePath, PNG_800x600)
    assert.equal(service.persistBuffer(Buffer.from([1, 2, 3]), { skipHistory: true }), null)
    assert.equal(service.persistDataUrl('data:image/png;base64,AA==', { skipHistory: true }), null)
    assert.equal(await service.persistFile(sourcePath, { skipHistory: true }), null)
    assert.equal(store.writes, 0, 'no index write either')
    assert.deepEqual(fs.readdirSync(directory), ['source.png'], 'no capture file and no thumbnail')
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 4. Wiring contracts: markup, renderer, preload, main-process seams, locales.
// ---------------------------------------------------------------------------

test('capture.html ships the floating switch and its scope hint outside every measured row', () => {
  assert.match(html, /<button id="skipHistoryToggle" class="region-toggle" type="button" aria-pressed="false"><\/button>/)
  assert.match(html, /<div id="skipHistoryHint" class="ocr-result-bar hidden" role="status" aria-live="polite"/)
  // Neither element may carry a data-i18n marker: the capture window's golden key table is
  // frozen at its pre-migration contents, and this copy is written by capture.js.
  const toggleTag = html.match(/<button id="skipHistoryToggle"[^>]*>/)[0]
  const hintTag = html.match(/<div id="skipHistoryHint"[^>]*>/)[0]
  assert.doesNotMatch(toggleTag, /data-i18n/)
  assert.doesNotMatch(hintTag, /data-i18n/)
  // Not inside the main row, the option row, or the element bar: those are all measured.
  const skipIndex = html.indexOf('id="skipHistoryToggle"')
  const elementBarStart = html.indexOf('<div id="elementBar"')
  assert.ok(skipIndex > elementBarStart, 'the switch must not sit between #toolOptions and #elementBar')
  const mainRowStart = html.indexOf('<div class="toolbar-row">')
  const toolOptionsStart = html.indexOf('<div id="toolOptions"')
  assert.ok(mainRowStart >= 0)
  assert.ok(skipIndex > toolOptionsStart, 'the switch is not a toolbar button')
})

test('capture.js sends the switch with every action and never writes it back to settings', () => {
  assert.match(script, /skipHistory:skipHistoryThisCapture\}/, 'the flag rides every action meta')
  assert.match(script, /skipHistoryThisCapture = data\.skipHistory === true \|\| skipHistoryLocked/)
  assert.match(script, /skipHistoryLocked = data\.settings\?\.screenshot\?\.historyEnabled === false/)
  assert.match(script, /skipHistory: skipHistoryThisCapture\s*\}\)/, 'the document commit carries it too')
  // The switch is local state: no settings:update call is made from it.
  assert.doesNotMatch(script, /saveHistoryEnabled|screenshot:\s*\{\s*historyEnabled/)
  // Its copy is re-derived on boot and on the language broadcast.
  assert.match(script, /syncPinOutputCopy\(\)\s+\/\/ B01: same rule for the skip switch and its scope hint\.\s+syncSkipHistoryCopy\(\)/)
  assert.match(script, /syncPinOutputCopy\(\)\s+syncSkipHistoryCopy\(\)/)
  // The hint states the Windows clipboard scope instead of promising an exclusion.
  assert.match(script, /t\('capture-skip\.toolbar\.hint'\)/)
  assert.match(script, /t\('capture-skip\.toolbar\.toggle'\)/)
})

test('the document editor refuses to save a skipped edit and never offers a fake save path', () => {
  assert.match(script, /if\(skipHistoryThisCapture\)\{alert\(t\('capture-skip\.document\.skipped'\)\);return\}/)
  assert.match(script, /if \(skipHistoryThisCapture\) \{\s+if \(confirm\(t\('capture-skip\.document\.close-discard'\)\)\) finishDocumentClose\(\)/)
  assert.match(script, /if \(response\.status === 'skipped'\) \{/)
  assert.match(script, /documentEditor\.dirty = true\s+renderDocumentInfo\(\)\s+alert\(t\('capture-skip\.document\.skipped'\)\)/)
})

test('the preload forwards the flag through the existing meta and adds no channel', () => {
  assert.match(preload, /meta\.skipHistory/)
  assert.doesNotMatch(preload, /capture:skip-history/)
  assert.doesNotMatch(preload, /skipHistory: \(/)
  // Every action entry point still passes meta unchanged.
  for (const channel of ['capture:copy', 'capture:save', 'capture:pin', 'capture:pin-reannotate', 'capture:open-recognition', 'capture:commit-document']) {
    assert.ok(preload.includes(channel), 'the existing ' + channel + ' channel is reused')
  }
})

test('the main domain funnels the decision through one plan and one scheduler', () => {
  assert.match(captureDomainSource, /function scheduleHistoryWrite\(win, plan, buffer, meta\)/)
  assert.match(captureDomainSource, /claimResultWrite\(win, \x60history:/)
  assert.match(captureDomainSource, /if \(!plan \|\| plan\.historyRecords !== 1\) return false/)
  assert.match(captureDomainSource, /const skipHistory = resolveSkipHistory\(captureWindow, meta\)/)
  assert.match(captureDomainSource, /skipHistory: inheritedSkipHistory,/)
  assert.match(captureDomainSource, /const inheritedSkipHistory = options\.skipHistory === true \|\|\s+options\.editingPinWindow\?\._skipHistory === true/)
  // Every action handler that used to write history now passes its plan to the scheduler.
  for (const call of [
    'scheduleHistoryWrite(captureWindow, plan, buffer, { ...meta, image })',
    'if (filePath) scheduleHistoryWrite(captureWindow, plan, buffer, meta)',
    'scheduleHistoryWrite(captureWindow, plan, buffer, meta)'
  ]) {
    assert.ok(captureDomainSource.includes(call), 'missing scheduler call: ' + call)
  }
  assert.match(captureDomainSource, /pin: attemptPinOutput\(event, captureWindow, buffer, meta, skipHistory\)/)
  assert.match(captureDomainSource, /if \(skipHistory\) receipt\.recorded = false/)
  assert.match(captureDomainSource, /announceSavedPath\(filePath\)/)
  assert.match(captureDomainSource, /plan = capturePlan\('save', skipHistory\)/)
})

test('the document service refuses the write before it validates or publishes anything', () => {
  const skipIndex = documentServiceSource.indexOf('if (payload.skipHistory === true) {')
  const writeIndex = documentServiceSource.indexOf('this.withDocumentLock(targetDocumentId')
  assert.ok(skipIndex > 0 && writeIndex > skipIndex, 'the skip branch precedes every write')
  assert.match(documentServiceSource, /status: 'skipped',\s+code: 'history-skipped'/)
  // No revision/thumbnail helper is reachable from the skip branch.
  const branch = documentServiceSource.slice(skipIndex, documentServiceSource.indexOf('const settings = this.getSettings() || {}', skipIndex))
  assert.doesNotMatch(branch, /publishRevision|persistThumbnail|writeHistory|readIndex/)
})

test('the three language tables define the same skip keys with real translations', () => {
  globalThis.__LOCALES = {}
  for (const name of ['zh-CN.js', 'en-US.js', 'zh-TW.js', 'capture.js']) {
    const file = path.join(root, 'shared', 'locales', name)
    delete require.cache[require.resolve(file)]
    require(file)
  }
  const tables = {}
  for (const language of ['zh-CN', 'en-US', 'zh-TW']) tables[language] = globalThis.__LOCALES[language] || {}
  const keys = Object.keys(tables['zh-CN']).filter((key) => key.startsWith('capture-skip.'))
  assert.ok(keys.length >= 8, 'the switch, hint, locked tip, saved-path box and the editor strings')
  const zhKeys = Object.keys(tables['zh-CN']).sort()
  for (const language of ['en-US', 'zh-TW']) {
    assert.deepEqual(zhKeys, Object.keys(tables[language]).sort(), language + ' key set symmetry')
  }
  for (const key of keys) {
    assert.match(key, /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/, key + ' follows the repo key shape')
    for (const language of ['zh-CN', 'en-US', 'zh-TW']) {
      const value = tables[language][key]
      assert.equal(typeof value, 'string', language + ' is missing ' + key)
      assert.ok(value.length > 0, language + '/' + key + ' must not be empty')
      assert.notEqual(value, key, language + '/' + key + ' must be translated')
    }
  }
  // The scope statement has to be in the visible hint, not only in a tooltip.
  assert.match(tables['zh-CN']['capture-skip.toolbar.hint'], /Windows 剪贴板/)
  assert.match(tables['zh-CN']['capture-skip.toolbar.hint'], /历史|修订/)
  assert.match(tables['en-US']['capture-skip.toolbar.hint'], /Windows clipboard/)
})

test('the hint copy is rendered as visible text and the switch reports its state accessibly', () => {
  assert.match(script, /skipHistoryHint\.textContent = skipHistoryThisCapture \? t\('capture-skip\.toolbar\.hint'\) : ''/)
  assert.match(script, /skipHistoryToggle\.setAttribute\('aria-pressed', skipHistoryThisCapture \? 'true' : 'false'\)/)
  assert.match(script, /skipHistoryToggle\.disabled = skipHistoryLocked/)
  assert.match(script, /skipHistoryToggle\.classList\.toggle\('available', available\)/)
})
