'use strict'

// U02 / DEV-01 (docs/plans/2026-11-28-review-optimization-follow-up-tasks.md):
// non-destructive vector re-annotation of a pinned screenshot.
//
// Contract under test:
//   * the capture editor can attach an optional editable snapshot to a pin: the base
//     pixels of the crop (unannotated) + annotations in SOURCE pixels + crop/output-style
//     parameters, all document-shaped through shared/capture-document.js;
//   * the snapshot travels on the EXISTING capture:pin / capture:pin-reannotate payloads
//     as meta.pinEditable, and the capture domain strips it before any history write;
//   * the pin domain normalises/budgets it, binds it to the window's image generation,
//     keeps it in memory only (never in workspace snapshots, recovery tickets or history)
//     and reopens the editor from it on "re-annotate";
//   * a save replaces the display PNG AND the snapshot; old flat pins / clipboard images
//     keep today's bitmap-only behaviour.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8')

const captureDocument = require('../shared/capture-document')
const pinDomainModule = require('../main/domains/pin')
const { createCaptureDomain } = require('../main/domains/capture')

const ORIGINAL = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5])
const DATA_URL = 'data:image/png;base64,AA=='

function makePng(width, height, tail = Buffer.from([7, 7, 7])) {
  const header = Buffer.alloc(24)
  header.writeUInt32BE(0x89504e47, 0)
  header.writeUInt32BE(0x0d0a1a0a, 4)
  header.write('IHDR', 12, 'ascii')
  header.writeUInt32BE(width, 16)
  header.writeUInt32BE(height, 20)
  return Buffer.concat([header, tail])
}

// A valid document-shaped snapshot: base 120x80, full-crop, two vector objects.
function validSnapshot(overrides = {}) {
  const document = captureDocument.createPinEditableDocument({
    width: 120,
    height: 80,
    annotations: [
      { type: 'rect', x: 10, y: 12, x2: 60, y2: 40, color: '#ff3b30', width: 4 },
      { type: 'text', x: 20, y: 50, text: 'hello', color: '#ff3b30', width: 4 }
    ],
    outputStyle: null,
    sourceScaleFactor: 1.5
  })
  return {
    schema: 1,
    document,
    baseImagePng: makePng(120, 80),
    sourceScaleFactor: 1.5,
    ...overrides
  }
}

// ---------------------------------------------------------------------------
// 1. Pure shared contract: the snapshot document and the annotation projection.
// ---------------------------------------------------------------------------

test('a pin snapshot is a normal, validated capture document with a full-base crop', () => {
  const document = captureDocument.createPinEditableDocument({
    width: 120,
    height: 80,
    annotations: [{ type: 'arrow', x: 5, y: 6, x2: 60, y2: 40, color: '#00ff00', width: 3 }],
    outputStyle: null,
    sourceScaleFactor: 1.5
  })
  assert.deepEqual(document.crop, { x: 0, y: 0, w: 120, h: 80 })
  assert.deepEqual(document.baseImage, { assetId: 'pin', width: 120, height: 80 })
  assert.equal(document.source, 'pin')
  assert.equal(document.captureMetadata.sourceScaleFactor, 1.5)
  assert.equal(document.captureMetadata.longCapture, false)
  assert.equal(document.annotations.length, 1)
  assert.equal(captureDocument.validateDocument(document, { expectedBaseWidth: 120, expectedBaseHeight: 80 }).ok, true)
  // Fingerprinting works on it like on any other document (dirty/reopen semantics).
  assert.equal(typeof captureDocument.documentFingerprint(document), 'string')
  assert.equal(captureDocument.documentFingerprint(document), captureDocument.documentFingerprint(document))
})

test('export-canvas annotations project into crop source pixels (flat, points, nested magnifier)', () => {
  const annotations = [
    { type: 'rect', x: 100, y: 120, x2: 160, y2: 140, color: '#ff3b30', width: 4, radius: 6 },
    { type: 'pen', x: 0, y: 0, points: [{ x: 100, y: 130 }, { x: 120, y: 150 }], color: '#ff3b30', width: 2 },
    { type: 'text', x: 110, y: 140, text: 'hi', color: '#ff3b30', width: 8, fontSize: 14 },
    {
      type: 'magnifier',
      sourceRect: { x: 100, y: 120, w: 40, h: 20 },
      lensOrigin: { x: 200, y: 60 },
      factor: 2,
      stroke: { color: '#ff3b30', widthPx: 3 },
      connector: 'none'
    }
  ]
  // High-DPI capture: window CSS (100,120) is source (20,240) because the crop starts at
  // (80,100) in a 3x/2x non-uniform rounded rect. Scaling is intentionally per-axis.
  const mapped = captureDocument.annotationsFromExportView(annotations, {
    offsetX: 80,
    offsetY: 100,
    scaleX: 2,
    scaleY: 1.5
  })
  assert.equal(mapped.length, 4)
  assert.deepEqual([mapped[0].x, mapped[0].y], [40, 30])
  assert.deepEqual([mapped[0].x2, mapped[0].y2], [160, 60])
  assert.equal(mapped[0].radius, 12, 'radius scales by the larger axis')
  assert.deepEqual(mapped[1].points, [{ x: 40, y: 45 }, { x: 80, y: 75 }])
  assert.equal(mapped[2].fontSize, 28)
  assert.deepEqual([mapped[3].sourceRect.x, mapped[3].sourceRect.y], [40, 30])
  assert.deepEqual([mapped[3].sourceRect.w, mapped[3].sourceRect.h], [80, 30])
  assert.deepEqual([mapped[3].lensOrigin.x, mapped[3].lensOrigin.y], [240, -60])
  // The projection is a fixed point on already-normalised annotations.
  const again = captureDocument.annotationsFromExportView(mapped, { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1 })
  assert.deepEqual(again.map((item) => item.type), ['rect', 'pen', 'text', 'magnifier'])
})

// ---------------------------------------------------------------------------
// 2. Pin domain: validation, budget, image-generation binding, release.
// ---------------------------------------------------------------------------

function createFakePinImages() {
  const assets = new Map()
  const refs = new Map()
  let sequence = 0
  return {
    assets,
    add: ({ bytes, mime }) => {
      const id = `pin-image-${++sequence}`
      assets.set(id, { bytes, mime })
      refs.set(id, 1)
      return id
    },
    read: async (id) => {
      const entry = assets.get(id)
      if (!entry) throw new Error('贴图资源已释放')
      return entry
    },
    retain: (id) => {
      if (!assets.has(id)) return false
      refs.set(id, (refs.get(id) || 0) + 1)
      return true
    },
    release: (id) => {
      if (!assets.has(id)) return
      const next = (refs.get(id) || 1) - 1
      if (next > 0) {
        refs.set(id, next)
        return
      }
      refs.delete(id)
      assets.delete(id)
    },
    stats: () => ({ resident: 0, assets: assets.size, handles: 0 })
  }
}

function createPinHarness(options = {}) {
  const { createPinDomain } = require('../main/domains/pin')
  const created = []
  const handlers = new Map()
  const sends = []
  const pinImages = options.pinImages || createFakePinImages()
  const domain = createPinDomain({
    BrowserWindow: { fromWebContents: (sender) => sender?.window || null },
    clipboard: { writeImage: () => {} },
    nativeImage: {
      createFromBuffer: (bytes) => ({
        bytes: Buffer.from(bytes),
        getSize: () => ({ width: 120, height: 80 }),
        isEmpty: () => false
      })
    },
    screen: {
      getDisplayMatching: () => ({
        scaleFactor: 1,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        workArea: { x: 0, y: 0, width: 1920, height: 1040 }
      }),
      getDisplayNearestPoint: () => ({
        scaleFactor: 1,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        workArea: { x: 0, y: 0, width: 1920, height: 1040 }
      }),
      getCursorScreenPoint: () => ({ x: 10, y: 10 })
    },
    Menu: { buildFromTemplate: () => ({ popup: () => {} }) },
    path,
    rootDirectory: ROOT,
    createLocalWindow: () => {
      const win = {
        _events: {},
        _ops: [],
        _bounds: [],
        isDestroyed: () => false,
        isVisible: () => true,
        getBounds: () => ({ x: 0, y: 0, width: 120, height: 80 }),
        getContentBounds: () => ({ x: 0, y: 0, width: 120, height: 80 }),
        setBounds: (bounds) => win._bounds.push(bounds),
        setPosition: () => {},
        setContentSize: () => {},
        setAlwaysOnTop: () => {},
        setOpacity: () => {},
        setIgnoreMouseEvents: () => {},
        show: () => win._ops.push('show'),
        hide: () => win._ops.push('hide'),
        moveTop: () => {},
        focus: () => {},
        loadFile: () => {},
        close: () => {},
        destroy: () => {
          win._destroyed = true
          // Real Electron emits 'closed' after destroy(); the fake must too, or the
          // domain's release path (snapshot budget included) is never exercised.
          win._closed?.()?.catch?.(() => {})
        },
        on: (event, cb) => {
          win._events[event] = cb
          if (event === 'closed') win._closed = cb
        },
        webContents: null
      }
      win.webContents = {
        window: win,
        isDestroyed: () => false,
        send: (channel, payload) => sends.push({ win, channel, payload }),
        on: (event, cb) => { win._events[`webContents:${event}`] = cb }
      }
      created.push(win)
      return win
    },
    getSettings: () => ({
      fixedContent: { opacity: 1, zoomWithMouse: true },
      plugins: { ocr: true },
      pinned: { clickThrough: false }
    }),
    saveImageBuffer: async () => 'saved',
    createRecognitionWindow: () => {},
    recognizePin: () => {},
    pinImages,
    getCreateCaptureWindow: options.getCreateCaptureWindow || (() => async () => null),
    pinSnapshotBudgetBytes: options.pinSnapshotBudgetBytes,
    log: () => {},
    ipcMain: { on: (channel, handler) => handlers.set(channel, handler) }
  })
  return { domain, created, handlers, sends, pinImages }
}

test('pin domain: a valid snapshot is normalised, budgeted and bound to the image generation', () => {
  const valid = pinDomainModule.normalizePinEditableSnapshot(validSnapshot())
  assert.equal(valid.ok, true)
  assert.equal(valid.snapshot.baseImage.width, 120)
  assert.equal(valid.snapshot.baseImage.height, 80)
  assert.equal(valid.snapshot.document.source, 'pin')
  assert.equal(valid.snapshot.sourceScaleFactor, 1.5)
  assert.equal(valid.snapshot.byteLength, valid.snapshot.baseImage.bytes.length)

  // Explicit rejection codes, all without throwing or creating half a pin.
  assert.equal(pinDomainModule.normalizePinEditableSnapshot(null).code, 'INVALID_SNAPSHOT')
  assert.equal(pinDomainModule.normalizePinEditableSnapshot(validSnapshot({ schema: 2 })).code, 'UNSUPPORTED_SCHEMA')
  assert.equal(pinDomainModule.normalizePinEditableSnapshot(validSnapshot({ baseImagePng: Buffer.alloc(0) })).code, 'EMPTY_BASE')
  assert.equal(pinDomainModule.normalizePinEditableSnapshot(validSnapshot({ baseImagePng: Buffer.from('nope') })).code, 'INVALID_BASE')
  // Declared dims must match the document base size and the bitmap's own header.
  const wrongSize = validSnapshot()
  wrongSize.baseImagePng = makePng(200, 80)
  assert.equal(pinDomainModule.normalizePinEditableSnapshot(wrongSize).code, 'INVALID_DOCUMENT')
  // The base image IS the crop: a cropped document is rejected, never silently reinterpreted.
  const cropped = validSnapshot()
  cropped.document = { ...cropped.document, crop: { x: 10, y: 0, w: 110, h: 80 } }
  assert.equal(pinDomainModule.normalizePinEditableSnapshot(cropped).code, 'CROP_MISMATCH')
  // The byte budget is enforced before the PNG is decoded further.
  assert.equal(pinDomainModule.normalizePinEditableSnapshot(validSnapshot(), { maxBytes: 10 }).code, 'BASE_TOO_LARGE')
  // Unknown annotation types are rejected by the shared validator, not guessed.
  const badAnnotation = validSnapshot()
  badAnnotation.document = {
    ...badAnnotation.document,
    annotations: [{ type: 'future-object', x: 1, y: 1 }]
  }
  assert.equal(pinDomainModule.normalizePinEditableSnapshot(badAnnotation).code, 'INVALID_DOCUMENT')
})

test('pin domain: attach/update/close keeps the in-memory budget exact and generation-bound', () => {
  const harness = createPinHarness({ pinSnapshotBudgetBytes: validSnapshot().baseImagePng.length + 10 })
  const win = harness.domain.createPinWindow(ORIGINAL, {}, { editableSnapshot: validSnapshot() })
  assert.equal(win._pinData.pinEditable.imageId, win._pinData.imageId)
  assert.equal(harness.domain.getPinSnapshotBytes(), validSnapshot().baseImagePng.length)

  // A second pin would exceed the aggregate budget: it is created as a flat bitmap.
  const second = harness.domain.createPinWindow(ORIGINAL, {}, { editableSnapshot: validSnapshot() })
  assert.equal(second._pinData.pinEditable, null)
  assert.equal(harness.domain.getPinSnapshotBytes(), validSnapshot().baseImagePng.length)

  // Re-annotation save replaces BOTH artefacts: the old base bytes are released and the
  // new snapshot is bound to the new imageId.
  const oldImageId = win._pinData.imageId
  const replacement = validSnapshot()
  harness.domain.updatePinWindow(win, makePng(120, 80), {}, { editableSnapshot: replacement })
  assert.notEqual(win._pinData.imageId, oldImageId)
  assert.equal(win._pinData.pinEditable.imageId, win._pinData.imageId)
  assert.deepEqual(win._pinData.pinEditable.baseImage.bytes, replacement.baseImagePng)
  assert.equal(harness.domain.getPinSnapshotBytes(), replacement.baseImagePng.length + 0)

  // Invalid snapshot on update degrades to flat, releasing the old one (never a leak).
  harness.domain.updatePinWindow(win, makePng(120, 80), {}, { editableSnapshot: { schema: 1 } })
  assert.equal(win._pinData.pinEditable, null)
  assert.equal(harness.domain.getPinSnapshotBytes(), 0)

  // Closing a pin releases its share.
  harness.domain.updatePinWindow(win, makePng(120, 80), {}, { editableSnapshot: validSnapshot() })
  assert.equal(harness.domain.getPinSnapshotBytes(), validSnapshot().baseImagePng.length)
  win._closed()
  assert.equal(harness.domain.getPinSnapshotBytes(), 0)
})

test('pin domain: the renderer presentation never receives the editable snapshot', async () => {
  const harness = createPinHarness()
  const display = makePng(120, 80, Buffer.from([1, 2, 3]))
  const win = harness.domain.createPinWindow(display, {}, { editableSnapshot: validSnapshot() })
  harness.handlers.get('pin:ready')({ sender: win.webContents })
  const deadline = Date.now() + 2000
  while (harness.sends.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  assert.equal(harness.sends.length, 1)
  const payload = harness.sends[0].payload
  assert.equal(payload.channel || harness.sends[0].channel, 'pin:init')
  assert.equal(payload.pinEditable, undefined, 'the base bitmap must never cross the IPC boundary')
  assert.deepEqual(payload.imageBuffer, display)
  win._closed()
})

test('pin domain: crash recovery keeps pixels but never the editable base image', async () => {
  const harness = createPinHarness()
  const win = harness.domain.createPinWindow(ORIGINAL, {}, { editableSnapshot: validSnapshot() })
  assert.equal(harness.domain.getPinSnapshotBytes(), validSnapshot().baseImagePng.length)
  // Abnormal renderer exit retains the display PNG for recovery.
  win._events['webContents:render-process-gone']({}, { reason: 'crashed' })
  const tickets = harness.domain.getRecoverablePins()
  assert.equal(tickets.length, 1)
  // The retained metadata is JSON-serialisable placement only: no pinEditable, no base
  // image bytes (the snapshot is in-memory and dies with the crashed window).
  const retained = harness.domain.windowResilience.list()
  const serialised = JSON.stringify(retained)
  assert.doesNotMatch(serialised, /pinEditable/)
  assert.doesNotMatch(serialised, /baseImagePng/)
  assert.ok(!serialised.includes(validSnapshot().baseImagePng.toString('base64').slice(0, 24)))
  assert.equal(harness.domain.getPinSnapshotBytes(), 0)

  // Recovering the ticket rebuilds a FLAT pin (bitmap-only re-annotation from then on).
  const recovered = await harness.domain.recoverPin(tickets[0].id)
  assert.equal(recovered.status, 'recovered')
  assert.equal(recovered.window._pinData.pinEditable, null)
})

test('pin domain: re-annotation reopens the snapshot session (base bitmap + vector document)', async () => {
  let capturedOptions = null
  const harness = createPinHarness({
    getCreateCaptureWindow: () => async (options) => {
      capturedOptions = options
      return null
    }
  })
  const win = harness.domain.createPinWindow(ORIGINAL, {}, { editableSnapshot: validSnapshot() })
  const result = await harness.domain.startPinReannotation(win, { x: 0, y: 0, width: 120, height: 80 })
  assert.equal(result, null)
  assert.ok(capturedOptions, 'the capture editor must be opened')
  assert.equal(capturedOptions.editPin, true)
  assert.equal(capturedOptions.editingPinWindow, win)
  assert.equal(capturedOptions.mode, 'image')
  // The editor opens on the UNANNOTATED crop pixels, not on the flattened display PNG.
  assert.deepEqual(capturedOptions.imageBuffer, validSnapshot().baseImagePng)
  assert.equal(capturedOptions.pinEditable.document.annotations.length, 2)
  assert.deepEqual(capturedOptions.pinEditable.crop, { x: 0, y: 0, w: 120, h: 80 })
  assert.ok(capturedOptions.sourceScaleFactor > 0)
  // The pin is hidden while its editor is open, like the shipped flow.
  assert.ok(win._ops.includes('hide'))
})

test('pin domain: a confirmed re-annotation keeps BOTH artefacts, so the next reopen still has the old vectors', async () => {
  // P1-03 half of the contract: every confirm entry that REPLACES the pin's display image
  // must also hand the domain a fresh snapshot. The domain side here proves the chain the
  // renderer feeds: replace image + attach snapshot -> both artefacts released/attached in
  // lockstep -> the reopened editor payload still carries the existing rectangle.
  const captureOptions = []
  const harness = createPinHarness({
    getCreateCaptureWindow: () => async (options) => {
      captureOptions.push(options)
      return null
    }
  })
  const win = harness.domain.createPinWindow(ORIGINAL, {}, { editableSnapshot: validSnapshot() })
  const firstImageId = win._pinData.imageId
  const confirmed = validSnapshot()
  harness.domain.updatePinWindow(win, makePng(120, 80), {}, { editableSnapshot: confirmed })
  assert.notEqual(win._pinData.imageId, firstImageId, 'the display image generation changed')
  assert.equal(win._pinData.pinEditable.imageId, win._pinData.imageId, 'the snapshot is bound to the NEW image generation')
  assert.deepEqual(win._pinData.pinEditable.baseImage.bytes, confirmed.baseImagePng)
  assert.equal(harness.domain.getPinSnapshotBytes(), confirmed.baseImagePng.length, 'old base released, new base attached exactly once')

  await harness.domain.startPinReannotation(win, { x: 0, y: 0, width: 120, height: 80 })
  const reopened = captureOptions.at(-1)
  assert.ok(reopened, 'the confirmed pin must reopen in the vector editor')
  assert.equal(reopened.editPin, true)
  assert.equal(reopened.pinEditable.document.annotations.length, 2)
  const rect = reopened.pinEditable.document.annotations.find((item) => item.type === 'rect')
  assert.ok(rect, 'the old rectangle must still be selectable after a confirmed re-annotation')
  assert.deepEqual([rect.x, rect.y], [10, 12])

  // The unchanged degradation: an update that arrives WITHOUT a snapshot releases the old
  // base and the pin becomes a flat bitmap again (this is why the renderer must always send
  // it - the bug P1-03 fixes). Nothing leaks, and the next reopen is bitmap-only.
  harness.domain.updatePinWindow(win, makePng(120, 80), {})
  assert.equal(win._pinData.pinEditable, null)
  assert.equal(harness.domain.getPinSnapshotBytes(), 0)
  await harness.domain.startPinReannotation(win, { x: 0, y: 0, width: 120, height: 80 })
  const reopenedFlat = captureOptions.at(-1)
  assert.equal(reopenedFlat.pinEditable, null)
  assert.deepEqual(reopenedFlat.imageBuffer, (await harness.pinImages.read(win._pinData.imageId)).bytes)
})

test('pin domain: an old flat pin keeps today\'s bitmap-only re-annotation', async () => {
  let capturedOptions = null
  const harness = createPinHarness({
    getCreateCaptureWindow: () => async (options) => {
      capturedOptions = options
      return null
    }
  })
  const win = harness.domain.createPinWindow(ORIGINAL, {})
  assert.equal(win._pinData.pinEditable, null)
  await harness.domain.startPinReannotation(win, { x: 0, y: 0, width: 120, height: 80 })
  assert.ok(capturedOptions)
  // No snapshot => no pinEditable payload; the editor loads the stored display PNG.
  assert.equal(capturedOptions.pinEditable, null)
  assert.deepEqual(capturedOptions.imageBuffer, (await harness.pinImages.read(win._pinData.imageId)).bytes)
})

// ---------------------------------------------------------------------------
// 3. Capture domain: transport extraction, history hygiene, skip-history privacy.
// ---------------------------------------------------------------------------

function createCaptureHarness(options = {}) {
  const persisted = []
  const pinCalls = []
  const captureWindow = {
    _pinCopyState: undefined,
    _skipHistory: options.skipHistory === true,
    isDestroyed: () => false,
    close: () => {}
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
    fs: { existsSync: () => false },
    path,
    screen: {
      getDisplayMatching: () => ({ id: 1, scaleFactor: 1, bounds: { x: 0, y: 0, width: 800, height: 600 }, workArea: { x: 0, y: 0, width: 800, height: 600 } }),
      getDisplayNearestPoint: () => ({ id: 1, scaleFactor: 1, bounds: { x: 0, y: 0, width: 800, height: 600 }, workArea: { x: 0, y: 0, width: 800, height: 600 } }),
      getCursorScreenPoint: () => ({ x: 10, y: 10 }),
      dipToScreenRect: (_display, bounds) => bounds
    },
    BrowserWindow: { fromWebContents: () => captureWindow },
    nativeImage: { createFromBuffer: () => ({ getSize: () => ({ width: 800, height: 600 }) }) },
    clipboard: {
      writeImage: () => {},
      readImage: () => ({ getSize: () => ({ width: 800, height: 600 }) })
    },
    dialog: { showErrorBox: () => {} },
    performance: { now: () => 0 },
    rootDirectory: ROOT,
    isWin: false,
    createLocalWindow: () => ({ isDestroyed: () => false }),
    getSettings: () => ({ screenshot: {} }),
    log: () => {},
    assertGameModeDisabled: () => {},
    pinDomain: {
      bringPinToFront: () => {},
      canPinMore: () => true,
      pinFromCapture: (...args) => {
        pinCalls.push(args)
        return { pinWindow: { _pinData: { meta: args[2] } } }
      }
    },
    createRecordWindow: async () => {},
    createLongCaptureFromSelection: async () => {},
    createRecognitionWindow: () => {},
    persistHistory: (_buffer, meta) => persisted.push(meta),
    saveImageBuffer: async () => '',
    imageDataToBuffer: (value) => (Buffer.isBuffer(value) ? value : Buffer.from(String(value || ''))),
    dataUrlToBuffer: () => Buffer.from([1]),
    bufferToDataUrl: () => 'data:image/png;base64,AA==',
    performanceMonitor: { record: () => {}, snapshot: () => {} }
  })
  return { controller: domain.createCaptureController(), persisted, pinCalls }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 45))

test('capture domain: the snapshot is extracted BEFORE history and handed to the pin domain', async () => {
  const harness = createCaptureHarness()
  const meta = { width: 120, height: 80, skipHistory: false, pinEditable: validSnapshot() }
  await harness.controller.pin({ sender: {} }, { imageBuffer: makePng(120, 80), meta })
  // The pin domain received the snapshot as a separate argument, the meta object is clean.
  assert.equal(harness.pinCalls.length, 1)
  assert.deepEqual(harness.pinCalls[0][4], { editableSnapshot: meta.pinEditable || harness.pinCalls[0][4].editableSnapshot })
  assert.ok(harness.pinCalls[0][4].editableSnapshot)
  assert.equal(harness.pinCalls[0][2].pinEditable, undefined)
  await flush()
  assert.equal(harness.persisted.length, 1)
  assert.equal(harness.persisted[0].pinEditable, undefined, 'history must never serialize the base bitmap')
  assert.match(JSON.stringify(harness.persisted[0]), /"action":"pin"/)
})

test('capture domain: a private (skip-history) capture never forwards a snapshot', async () => {
  const harness = createCaptureHarness({ skipHistory: true })
  const meta = { width: 120, height: 80, skipHistory: true, pinEditable: validSnapshot() }
  await harness.controller.pin({ sender: {} }, { imageBuffer: makePng(120, 80), meta })
  assert.equal(harness.pinCalls.length, 1)
  assert.deepEqual(harness.pinCalls[0][4], {})
  assert.equal(meta.pinEditable, undefined)
  await flush()
  assert.equal(harness.persisted.length, 0)
})

test('capture domain: pin-copy and pin-reannotate forward the snapshot without a new channel', async () => {
  const copyHarness = createCaptureHarness()
  await copyHarness.controller.pin({ sender: {} }, {
    imageBuffer: makePng(120, 80),
    meta: { width: 120, height: 80, pinEditable: validSnapshot() },
    copy: true
  })
  assert.equal(copyHarness.pinCalls.length, 1)
  assert.ok(copyHarness.pinCalls[0][4].editableSnapshot)
  await flush()

  const reannotateHarness = createCaptureHarness()
  await reannotateHarness.controller.pinReannotate({ sender: {} }, {
    imageBuffer: makePng(120, 80),
    meta: { width: 120, height: 80, pinEditable: validSnapshot() },
    action: 'ocr'
  })
  assert.equal(reannotateHarness.pinCalls.length, 1)
  assert.ok(reannotateHarness.pinCalls[0][4].editableSnapshot)
  assert.equal(reannotateHarness.pinCalls[0][3], 'ocr')
  await flush()
  assert.equal(reannotateHarness.persisted[0].pinEditable, undefined)
})

// ---------------------------------------------------------------------------
// 4. Renderer/static wiring: no new IPC channel, snapshot only at pin output.
// ---------------------------------------------------------------------------

test('wiring: the snapshot rides existing payloads and the renderer strips/gates it', () => {
  const script = read('capture', 'capture.js')
  const preload = read('preload-capture.js')
  const pinDomainSource = read('main', 'domains', 'pin', 'index.js')
  const captureDomainSource = read('main', 'domains', 'capture', 'index.js')
  // Capture side: built from the same frozen session state as the exported PNG and only
  // for the pin-replacement confirm entries.
  assert.match(script, /function buildPinEditableSnapshot\(/)
  assert.match(script, /meta\.pinEditable=pinEditableSnapshot/)
  assert.match(script, /function pinConfirmReplacesPin\(action\)/)
  assert.match(script, /if\(pinConfirmReplacesPin\(action\)\)/)
  // P1-03: 'copy' inside an editPin session REPLACES the original pin, so it must carry
  // the snapshot exactly like the pin buttons (Enter / copy button / double-click-copy).
  assert.match(script, /return action === 'copy' && !!initData\?\.editPin/)
  assert.match(script, /if \(skipHistoryThisCapture\) return null/)
  assert.match(script, /if \(initData\?\.editPin && !pinEditable\) return null/)
  assert.match(script, /createPinEditableDocument\(/)
  assert.match(script, /function restorePinEditable\(/)
  // Main side: stripped before history, validated in the pin domain.
  assert.match(captureDomainSource, /function pullPinEditable\(meta, skipHistory\)/)
  assert.match(captureDomainSource, /delete meta\.pinEditable/)
  assert.match(pinDomainSource, /normalizePinEditableSnapshot/)
  assert.match(pinDomainSource, /attachPinEditable/)
  assert.match(pinDomainSource, /releasePinEditable/)
  // No new channel: the existing invoke bridge is untouched and still has no pin-editable
  // channel name anywhere in the preload.
  assert.doesNotMatch(preload, /pin-editable|pinEditable|editableSnapshot/)
  const channels = [...preload.matchAll(/ipcRenderer\.(?:invoke|send)\('([^']+)'/g)].map((match) => match[1])
  assert.ok(channels.includes('capture:pin'))
  assert.ok(channels.includes('capture:pin-reannotate'))
  assert.equal(channels.filter((channel) => /pin-editable|snapshot/i.test(channel)).length, 0)
  // capture.html already loads the shared document contract (reused, not duplicated).
  assert.match(read('capture', 'capture.html'), /shared\/capture-document\.js/)
})
