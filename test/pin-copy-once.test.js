'use strict'

// B03 (docs/reviews/2026-11-24-windows-product-architecture-review.md):
// "pin and copy in one confirmation; original image vs current-view export".
//
// Two halves, matching the two ends of the feature:
//   * the preview/export plan is PURE ("what does the view contain, which way does it
//     face, is the OCR overlay part of it"), so it can be asserted as data;
//   * the pin domain's existing "original bytes" exit stays rotation-proof - a pin
//     rotated four ways must still copy/save the SAME bytes it was created from,
//     while the view export is the rotated rendering.
const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const pinDomainSource = fs.readFileSync(path.join(root, 'main/domains/pin/index.js'), 'utf8')
const preloadCapture = fs.readFileSync(path.join(root, 'preload-capture.js'), 'utf8')

const {
  describePinViewExport,
  pinViewExportSize,
  PIN_VIEW_LAYERS,
  PIN_VIEW_EXCLUSIONS
} = require('../main/domains/pin')

const DATA_URL = 'data:image/png;base64,AA=='
const ORIGINAL = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5])
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')

async function waitFor(predicate, message = 'timed out waiting for pin image I/O', timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  if (predicate()) return
  assert.fail(message)
}

function createFakePinImages() {
  const assets = new Map()
  let sequence = 0
  return {
    assets,
    add: ({ bytes, mime }) => {
      const id = `pin-image-${++sequence}`
      assets.set(id, { bytes, mime })
      return id
    },
    read: async (id) => {
      const entry = assets.get(id)
      if (!entry) throw new Error('贴图资源已释放')
      return entry
    },
    retain: (id) => assets.has(id),
    release: (id) => { assets.delete(id) },
    stats: () => ({ resident: 0, assets: assets.size, handles: 0 })
  }
}

// A window shape that records the OS-level calls the pin domain makes. The offscreen
// view export is driven by the fake renderer: when main sends pin:view-export-request,
// `viewExportAnswer` produces the bounded envelope the real preload would send on
// pin:context-menu. Everything else mirrors test/pin-domain.test.js.
function createHarness({ viewExportAnswer, showMessageBox, pinImages = createFakePinImages(), clipboard } = {}) {
  const handlers = new Map()
  const sent = []
  const saved = []
  const written = []
  const errors = []
  const { createPinDomain } = require('../main/domains/pin')
  const domain = createPinDomain({
    BrowserWindow: { fromWebContents: (sender) => sender?.window || null },
    clipboard: clipboard || {
      writeImage: (image) => written.push(image?.bytes || Buffer.alloc(0)),
      readImage: () => ({ getSize: () => ({ width: 200, height: 100 }) })
    },
    nativeImage: {
      createFromBuffer: (bytes) => ({
        bytes: Buffer.from(bytes),
        getSize: () => ({ width: 600, height: 800 }),
        toDataURL: () => DATA_URL,
        isEmpty: () => false,
        resize: () => ({ getSize: () => ({ width: 128, height: 128 }) })
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
    Menu: { buildFromTemplate: (template) => ({ popup: () => {}, template }) },
    path,
    rootDirectory: root,
    createLocalWindow: () => {
      const win = {
        _ops: [],
        _bounds: [],
        isDestroyed: () => false,
        isVisible: () => true,
        getBounds: () => ({ x: 0, y: 0, width: 100, height: 50 }),
        getContentBounds: () => ({ x: 0, y: 0, width: 100, height: 50 }),
        setBounds: (bounds) => win._bounds.push(bounds),
        setPosition: () => {},
        setContentSize: () => {},
        setAlwaysOnTop: () => {},
        setOpacity: () => {},
        setIgnoreMouseEvents: () => {},
        show: () => win._ops.push('show'),
        showInactive: () => win._ops.push('show-inactive'),
        hide: () => win._ops.push('hide'),
        moveTop: () => {},
        focus: () => {},
        loadFile: () => {},
        close: () => {},
        on: (event, cb) => { if (event === 'closed') win._closed = cb },
        webContents: null
      }
      win.webContents = {
        window: win,
        isDestroyed: () => false,
        send: (channel, payload) => {
          sent.push({ win, channel, payload })
          if (channel !== 'pin:view-export-request' || typeof viewExportAnswer !== 'function') return
          const command = viewExportAnswer(payload?.requestId, win)
          if (!command) return
          // The real path is a round trip through the preload and the IPC facade; deliver
          // it asynchronously so the domain's timeout timer is armed first.
          setImmediate(() => {
            handlers.get('pin:context-menu')?.({ sender: win.webContents }, null, command)
          })
        }
      }
      return win
    },
    getSettings: () => ({
      fixedContent: { opacity: 1, zoomWithMouse: true },
      plugins: { ocr: true },
      pinned: { clickThrough: false }
    }),
    saveImageBuffer: async (buffer) => { saved.push(Buffer.from(buffer)); return 'saved.png' },
    createRecognitionWindow: () => {},
    recognizePin: () => {},
    pinImages,
    getCreateCaptureWindow: () => async () => null,
    log: () => {},
    showMessageBox: showMessageBox || (async () => ({ response: 0 })),
    showErrorBox: (message, detail) => errors.push({ message, detail }),
    ipcMain: { on: (channel, handler) => handlers.set(channel, handler) }
  })
  return { domain, handlers, sent, saved, written, errors, pinImages }
}

// A minimal PNG header (signature + IHDR width/height) with an opaque payload tail.
// The domain validates the real header through readPngSize and treats the whole buffer
// as the bytes it writes, so the tail is enough to prove "the previewed bytes are the
// saved bytes".
function makePng(width, height, tail = Buffer.from([7, 7, 7])) {
  const header = Buffer.alloc(24)
  header.writeUInt32BE(0x89504e47, 0)
  header.writeUInt32BE(0x0d0a1a0a, 4)
  header.write('IHDR', 12, 'ascii')
  header.writeUInt32BE(width, 16)
  header.writeUInt32BE(height, 20)
  return Buffer.concat([header, tail])
}


// ---------------------------------------------------------------------------
// The pure plan: what leaves the pin, which way it faces, what is excluded.
// ---------------------------------------------------------------------------

test('view export orientation is the stored angle, and a quarter turn swaps the axes', () => {
  const base = { pixelWidth: 800, pixelHeight: 600, zoom: 1 }
  assert.deepEqual(pinViewExportSize({ ...base, rotation: 0 }), {
    width: 800, height: 600, rotation: 0, quarterTurn: false
  })
  assert.deepEqual(pinViewExportSize({ ...base, rotation: 90 }), {
    width: 600, height: 800, rotation: 90, quarterTurn: true
  })
  assert.deepEqual(pinViewExportSize({ ...base, rotation: 180 }), {
    width: 800, height: 600, rotation: 180, quarterTurn: false
  })
  assert.deepEqual(pinViewExportSize({ ...base, rotation: 270 }), {
    width: 600, height: 800, rotation: 270, quarterTurn: true
  })
  // Zoom applies to the pre-rotation picture, then the quarter turn swaps the axes -
  // the same order the window itself is sized in (rotatePin -> getPinWindowSize).
  assert.deepEqual(pinViewExportSize({ ...base, rotation: 90, zoom: 0.75 }), {
    width: 450, height: 600, rotation: 90, quarterTurn: true
  })
  // Malformed input never produces a zero-sized or NaN plan.
  const degraded = pinViewExportSize({ pixelWidth: 0, pixelHeight: -5, rotation: 'x', zoom: -2 })
  assert.equal(degraded.width, 1)
  assert.equal(degraded.height, 1)
  assert.equal(degraded.rotation, 0)
})

test('the current-view plan includes rotation and zoom, and the OCR overlay only when shown', () => {
  const withOcr = describePinViewExport({ rotation: 270, zoom: 0.5, ocrOverlay: true, width: 300, height: 400 })
  assert.equal(withOcr.rotation, 270)
  assert.equal(withOcr.orientation, 270)
  assert.equal(withOcr.quarterTurn, true)
  assert.equal(withOcr.zoom, 0.5)
  assert.deepEqual(withOcr.size, { width: 300, height: 400 })
  assert.deepEqual(withOcr.included, ['picture', 'rotation', 'zoom', 'ocr'])

  const withoutOcr = describePinViewExport({ rotation: 0, zoom: 1, ocrOverlay: false, width: 10, height: 20 })
  assert.deepEqual(withoutOcr.included, ['picture', 'rotation', 'zoom'])
  assert.equal(withoutOcr.ocrOverlay, false)

  // The desktop and other windows are excluded BY CONSTRUCTION (the pixels come from
  // this window's own page), and the transient badges are hidden for the capture.
  for (const plan of [withOcr, withoutOcr]) {
    assert.deepEqual(plan.excluded, ['desktop', 'other-windows', 'overlay-badges'])
  }
  assert.deepEqual(PIN_VIEW_EXCLUSIONS, ['desktop', 'other-windows', 'overlay-badges'])
  assert.deepEqual(PIN_VIEW_LAYERS, ['picture', 'rotation', 'zoom', 'ocr'])
})

// ---------------------------------------------------------------------------
// The pin domain: original bytes vs current view.
// ---------------------------------------------------------------------------

test('four rotations still copy and save the ORIGINAL bytes', async () => {
  const originalHash = hash(ORIGINAL)
  for (const angle of [0, 90, 180, 270]) {
    const { domain, handlers, written, saved } = createHarness()
    const win = domain.createPinWindow(ORIGINAL, {})
    if (angle) {
      assert.equal(domain.rotatePin(win, angle), angle)
    }
    assert.equal(win._pinData.rotation, angle)
    const before = written.length
    handlers.get('pin:copy')({ sender: win.webContents })
    await waitFor(() => written.length === before + 1)
    assert.equal(hash(written.at(-1)), originalHash, `rotation ${angle} must not change the copied bytes`)
    await handlers.get('pin:save')({ sender: win.webContents })
    assert.equal(saved.length, 1)
    assert.equal(hash(saved[0]), originalHash, `rotation ${angle}: saving must read the stored asset, not a render`)
    win._closed()
  }
})

test('the view export previews the renderer composition, then writes exactly those bytes', async () => {
  const composed = makePng(600, 800, Buffer.from([9, 9, 9, 9]))
  const order = []
  let dialogOptions = null
  const { domain, saved, errors } = createHarness({
    viewExportAnswer: (requestId) => {
      order.push('compose')
      return {
        type: 'view-export-result',
        requestId,
        ok: true,
        png: composed,
        width: 600,
        height: 800,
        ocrOverlay: true
      }
    },
    showMessageBox: async (_win, options) => {
      order.push('preview')
      dialogOptions = options
      return { response: 0 }
    }
  })
  const win = domain.createPinWindow(ORIGINAL, {})
  domain.rotatePin(win, 90)

  const receipt = await domain.exportPinView(win)
  assert.equal(receipt.status, 'saved')
  assert.equal(receipt.filePath, 'saved.png')
  // Preview BEFORE the write, and both refer to the SAME renderer-composed PNG.
  assert.deepEqual(order, ['compose', 'preview'])
  assert.equal(saved.length, 1)
  assert.deepEqual(saved[0], composed)
  assert.deepEqual(errors, [])

  // The preview says which way it faces, what it includes and what it never includes.
  assert.match(dialogOptions.detail, /600 × 800/)
  assert.match(dialogOptions.detail, /旋转 90°/)
  assert.match(dialogOptions.detail, /缩放 72%/)
  assert.match(dialogOptions.detail, /包含：贴图画面/)
  assert.match(dialogOptions.detail, /OCR 叠层/)
  assert.match(dialogOptions.detail, /不含：桌面背景、其他窗口/)
  assert.equal(dialogOptions.buttons[0], '导出')
  assert.equal(dialogOptions.cancelId, 1)
  // The preview dialog gets the composed image itself, downscaled, as its icon.
  assert.ok(dialogOptions.icon)
  assert.equal(receipt.plan.rotation, 90)
  assert.equal(receipt.plan.size.width, 600)
  win._closed()
})

test('a cancelled preview writes nothing, and a hidden pin reports instead of exporting', async () => {
  let dialogShown = 0
  const composed = makePng(600, 800)
  const cancelled = createHarness({
    viewExportAnswer: (requestId) => ({
      type: 'view-export-result', requestId, ok: true, png: composed, width: 600, height: 800
    }),
    showMessageBox: async () => { dialogShown += 1; return { response: 1 } }
  })
  const win = cancelled.domain.createPinWindow(ORIGINAL, {})
  const receipt = await cancelled.domain.exportPinView(win)
  assert.equal(receipt.status, 'cancelled')
  assert.equal(dialogShown, 1)
  assert.equal(cancelled.saved.length, 0)
  win._closed()

  const hidden = createHarness()
  const hiddenWin = hidden.domain.createPinWindow(ORIGINAL, {})
  hiddenWin.isVisible = () => false
  const hiddenReceipt = await hidden.domain.exportPinView(hiddenWin)
  assert.equal(hiddenReceipt.status, 'hidden')
  assert.equal(hidden.saved.length, 0)
  assert.equal(hidden.errors.length, 1)
  assert.match(hidden.errors[0].detail, /不可见/)
  hiddenWin._closed()
})

test('the pin menu renames the original-bytes exits and adds the offscreen view export', () => {
  assert.match(pinDomainSource, /label: t\('pin\.menu\.copy-original'\)/)
  assert.match(pinDomainSource, /label: t\('pin\.menu\.save-original'\)/)
  assert.match(pinDomainSource, /label: t\('pin\.menu\.export-view'\)/)
  // The original exits still read the stored asset (rotation/zoom never touch it).
  assert.match(pinDomainSource, /async function copyPin\(win\) \{[\s\S]{0,400}?pinImages\.read\(imageId\)/)
  assert.match(pinDomainSource, /async function savePin\(win\) \{[\s\S]{0,240}?pinImages\.read\(win\._pinData\.imageId\)/)
  // DEV-02: no more capturePage / hide-style injection; the renderer composes the view
  // and answers on the existing pin:context-menu envelope.
  assert.doesNotMatch(pinDomainSource, /capturePage/)
  assert.doesNotMatch(pinDomainSource, /pin-view-export-chrome/)
  assert.match(pinDomainSource, /pin:view-export-request/)
  assert.match(pinDomainSource, /normalizeViewExportCommand\(command\)/)
  // Desktop capture is confined to the DEV-08 EXPERIMENT-ONLY prototype; no user surface
  // reaches it and the view export itself never samples the screen.
  assert.match(pinDomainSource, /EXPERIMENT-ONLY/)
  assert.match(pinDomainSource, /async function captureScreenUnderPin/)
  const viewExportBlock = pinDomainSource.slice(
    pinDomainSource.indexOf('async function exportPinView'),
    pinDomainSource.indexOf('EXPERIMENT-ONLY')
  )
  assert.doesNotMatch(viewExportBlock, /desktopCapturer/)
  assert.doesNotMatch(viewExportBlock, /captureScreenUnderPin/)
  // A second click while the preview is open must not stack a second export.
  assert.match(pinDomainSource, /if \(win\._pinViewExporting\) return null/)
  // Existing pin channels keep their semantics: no new channel was introduced.
  assert.match(pinDomainSource, /ipcMain\.on\('pin:copy'/)
  assert.match(pinDomainSource, /ipcMain\.on\('pin:save'/)
  assert.match(pinDomainSource, /ipcMain\.on\('pin:context-menu'/)
})


test('preload exposes the combined pin through the existing capture:pin channel only', () => {
  assert.match(preloadCapture, /pin: \(imageBuffer, meta, options\) => ipcRenderer\.invoke\('capture:pin'/)
  assert.match(preloadCapture, /copy: options\?\.copy === true/)
  assert.match(preloadCapture, /retry: options\?\.retry === 'pin' \|\| options\?\.retry === 'copy' \? options\.retry : ''/)
  for (const channel of preloadCapture.matchAll(/ipcRenderer\.(?:invoke|send)\('([^']+)'/g)) {
    assert.notEqual(channel[1], 'capture:pin-copy')
    assert.notEqual(channel[1], 'pin:copy-original')
  }
})
