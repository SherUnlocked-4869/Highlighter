const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
const captureDomainSource = fs.readFileSync(path.join(root, 'main/domains/capture/index.js'), 'utf8')
const smartSelectSource = fs.readFileSync(path.join(root, 'main/domains/capture/smart-select.js'), 'utf8')

test('main.js delegates capture domain instead of inlining window factories and smart-select', () => {
  assert.match(main, /require\('\.\/main\/domains\/capture'\)/)
  assert.match(main, /createCaptureDomain\(\{/)
  assert.match(main, /captureDomain\s*=\s*createCaptureDomain/)
  assert.doesNotMatch(main, /function createCaptureWindow\(/)
  assert.doesNotMatch(main, /function sendCaptureInit\(/)
  assert.doesNotMatch(main, /function revealCaptureWindow\(/)
  assert.doesNotMatch(main, /class SmartSelectSession/)
  assert.doesNotMatch(main, /function createSmartSelectSession\(/)
  assert.doesNotMatch(main, /function convertSmartSelectRects\(/)
  assert.doesNotMatch(main, /const currentCaptureWindow = null/)
  assert.doesNotMatch(main, /let captureCreateSeq = 0/)
})

test('main.js routes capture ownership and task checks through the domain', () => {
  assert.match(main, /captureDomain\?\.ownsWindow\(win\)/)
  assert.match(main, /captureDomain\?\.isTaskActive\(\)/)
  assert.match(main, /captureDomain\.createCaptureWindow\(/)
  assert.match(main, /\.\.\.captureDomain\.createCaptureController\(\)/)
})

test('capture domain owns window lifecycle and smart-select helpers', () => {
  assert.match(captureDomainSource, /function createCaptureWindow/)
  assert.match(captureDomainSource, /function sendCaptureInit/)
  assert.match(captureDomainSource, /function revealCaptureWindow/)
  assert.match(captureDomainSource, /function createCaptureController/)
  assert.match(captureDomainSource, /capture\.interactive/)
  assert.match(smartSelectSource, /class SmartSelectSession/)
  assert.match(smartSelectSource, /function convertSmartSelectRects/)
})

test('capture domain factory tracks the current window and create sequence', () => {
  const handlers = {}
  const created = []
  const { createCaptureDomain } = require('../main/domains/capture')
  const domain = createCaptureDomain({
    app: { isPackaged: false },
    spawn: () => ({ stdout: { setEncoding: () => {}, on: () => {} }, stderr: { setEncoding: () => {}, on: () => {} }, once: () => {}, stdin: { write: () => {}, end: () => {} }, kill: () => {} }),
    fs: { existsSync: () => false },
    path,
    screen: {
      getDisplayMatching: () => ({ id: 1, scaleFactor: 1, bounds: { x: 0, y: 0, width: 800, height: 600 }, workArea: { x: 0, y: 0, width: 800, height: 600 } }),
      getDisplayNearestPoint: () => ({ id: 1, scaleFactor: 1, bounds: { x: 0, y: 0, width: 800, height: 600 }, workArea: { x: 0, y: 0, width: 800, height: 600 } }),
      getCursorScreenPoint: () => ({ x: 10, y: 10 }),
      dipToScreenRect: (_display, bounds) => bounds
    },
    BrowserWindow: { fromWebContents: () => created[created.length - 1] || null },
    nativeImage: { createFromBuffer: () => ({}) },
    clipboard: { writeImage: () => {} },
    dialog: { showErrorBox: () => {} },
    performance: { now: () => 0 },
    rootDirectory: root,
    isWin: false,
    createLocalWindow: () => {
      const win = {
        isDestroyed: () => false,
        setAlwaysOnTop: () => {},
        setPosition: () => {},
        setBounds: () => {},
        setResizable: () => {},
        setOpacity: () => {},
        showInactive: () => {},
        focus: () => {},
        close: () => { win._closed = true; clearTimeout(win._renderTimeout) },
        loadFile: () => Promise.resolve(),
        on: (event, cb) => { if (event === 'closed') win._onClosed = cb },
        getContentBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
        getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
        webContents: { send: () => {} }
      }
      created.push(win)
      return win
    },
    getSettings: () => ({ screenshot: {} }),
    log: () => {},
    assertGameModeDisabled: () => {},
    getDisplayCapture: async () => ({ imageBuffer: Buffer.from([1]), sourceId: 's', scaleFactor: 1 }),
    pinDomain: { bringPinToFront: () => {}, pinFromCapture: () => ({}) },
    createRecordWindow: async () => {},
    createLongCaptureFromSelection: async () => {},
    createRecognitionWindow: () => {},
    persistHistory: () => {},
    saveImageBuffer: async () => '',
    imageDataToBuffer: (value) => Buffer.isBuffer(value) ? value : Buffer.from(String(value || '')),
    dataUrlToBuffer: () => Buffer.from([1]),
    bufferToDataUrl: () => 'data:image/png;base64,AA==',
    performanceMonitor: { record: () => {}, snapshot: () => {} }
  })

  assert.equal(domain.ownsWindow(null), false)
  assert.equal(domain.isTaskActive(), false)

  return domain.createCaptureWindow({ mode: 'image', imageBuffer: Buffer.from([1]) }).then((win) => {
    assert.ok(win)
    assert.equal(domain.ownsWindow(win), true)
    assert.equal(domain.isTaskActive(), true)
    assert.equal(domain.getCurrentWindow(), win)
    // Closing clears the 8s render-timeout guard, so the test file does not have
    // to stay alive for the full timeout window.
    win.close()
  })
})

// Shared harness for the Wave-2 (S9a) init-payload contracts. Every collaborator
// is a fake so the factory can run under plain node.
function createHarness({ screenshot = {} } = {}) {
  const created = []
  const calls = { windows: [], saved: [], persisted: [] }
  const settings = { screenshot }
  const { createCaptureDomain } = require('../main/domains/capture')
  const domain = createCaptureDomain({
    app: { isPackaged: false },
    spawn: () => ({ stdout: { setEncoding: () => {}, on: () => {} }, stderr: { setEncoding: () => {}, on: () => {} }, once: () => {}, stdin: { write: () => {}, end: () => {} }, kill: () => {} }),
    fs: { existsSync: () => false },
    path,
    screen: {
      getDisplayMatching: () => ({ id: 1, scaleFactor: 1, bounds: { x: 0, y: 0, width: 800, height: 600 }, workArea: { x: 0, y: 0, width: 800, height: 600 } }),
      getDisplayNearestPoint: () => ({ id: 1, scaleFactor: 1, bounds: { x: 0, y: 0, width: 800, height: 600 }, workArea: { x: 0, y: 0, width: 800, height: 600 } }),
      getCursorScreenPoint: () => ({ x: 10, y: 10 }),
      dipToScreenRect: (_display, bounds) => bounds
    },
    BrowserWindow: { fromWebContents: () => created[created.length - 1] || null },
    nativeImage: { createFromBuffer: () => ({}) },
    clipboard: { writeImage: () => {} },
    dialog: { showErrorBox: () => {} },
    performance: { now: () => 0 },
    rootDirectory: root,
    isWin: false,
    createLocalWindow: (pagePath, options) => {
      calls.windows.push({ pagePath, options })
      const win = {
        isDestroyed: () => false,
        setAlwaysOnTop: () => {},
        setPosition: () => {},
        setBounds: () => {},
        setResizable: () => {},
        setOpacity: () => {},
        showInactive: () => {},
        focus: () => {},
        close: () => { win._closed = true; clearTimeout(win._renderTimeout) },
        loadFile: () => Promise.resolve(),
        on: (event, cb) => { if (event === 'closed') win._onClosed = cb },
        getContentBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
        getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
        webContents: { send: () => {} }
      }
      created.push(win)
      return win
    },
    getSettings: () => settings,
    log: () => {},
    assertGameModeDisabled: () => {},
    getDisplayCapture: async () => ({ imageBuffer: Buffer.from([1]), sourceId: 's', scaleFactor: 1 }),
    pinDomain: { bringPinToFront: () => {}, pinFromCapture: () => ({}) },
    createRecordWindow: async () => {},
    createLongCaptureFromSelection: async () => {},
    createRecognitionWindow: () => {},
    persistHistory: (_image, meta) => { calls.persisted.push(meta) },
    saveImageBuffer: async (_buffer, options) => { calls.saved.push(options || {}); return '' },
    imageDataToBuffer: (value) => Buffer.isBuffer(value) ? value : Buffer.from(String(value || '')),
    dataUrlToBuffer: () => Buffer.from([1]),
    bufferToDataUrl: () => 'data:image/png;base64,AA==',
    performanceMonitor: { record: () => {}, snapshot: () => {} }
  })
  return { domain, created, calls, settings }
}

test('capture init payload carries saveMode, the serial start value and the autoplay policy (P0-7-T4/T5/T7)', async () => {
  const harness = createHarness()

  const first = await harness.domain.createCaptureWindow({ mode: 'image', imageBuffer: Buffer.from([1]), saveMode: 'fast' })
  assert.equal(first._captureInit.saveMode, 'fast')
  assert.equal(first._captureInit.serialNumber, 1, 'the serial resets to 1 on every capture by default')
  assert.equal(harness.calls.windows[0].pagePath, path.join(root, 'capture', 'capture.html'))
  assert.equal(harness.calls.windows[0].options.webPreferences.preload, path.join(root, 'preload-capture.js'))
  assert.equal(harness.calls.windows[0].options.webPreferences.autoplayPolicy, 'no-user-gesture-required')
  assert.equal(harness.calls.windows[0].options.webPreferences.backgroundThrottling, false)

  // No saveMode from the caller (a plain toolbar save) must stay empty so the
  // renderer falls back to the screenshot.fastSave setting.
  const second = await harness.domain.createCaptureWindow({ mode: 'image', imageBuffer: Buffer.from([1]) })
  assert.equal(second._captureInit.saveMode, '')
  assert.equal(second._captureInit.serialNumber, 1)

  // screenshot.keepSerialAcrossCaptures is the only thing that continues the count.
  harness.settings.screenshot.keepSerialAcrossCaptures = true
  const third = await harness.domain.createCaptureWindow({ mode: 'image', imageBuffer: Buffer.from([1]) })
  const fourth = await harness.domain.createCaptureWindow({ mode: 'image', imageBuffer: Buffer.from([1]) })
  assert.equal(third._captureInit.serialNumber, 1, 'the first kept capture still starts at 1')
  assert.equal(fourth._captureInit.serialNumber, 2)
  assert.equal(second._captureInit.serialNumber, 1, 'earlier captures keep the reset value')
  fourth.close()
})

test('capture domain auto-saves on copy when only the remembered directory exists (§17.6)', async () => {
  const harness = createHarness({ screenshot: { autoSaveOnCopy: true, saveDirectory: '', lastSaveDirectory: '  E:/shots  ' } })
  const controller = harness.domain.createCaptureController()

  controller.copy({ sender: {} }, { imageBuffer: Buffer.from([1, 2, 3]) })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(harness.calls.saved, [{ fast: true }], 'a remembered directory alone is enough to trigger the save')
  assert.equal(harness.calls.persisted.length, 1)

  // Whitespace-only memory is still "no directory" (the saver trims it the same way).
  harness.settings.screenshot.lastSaveDirectory = '   '
  controller.copy({ sender: {} }, { imageBuffer: Buffer.from([1, 2, 3]) })
  assert.equal(harness.calls.saved.length, 1, 'a blank memory must not trigger the save')

  // The toggle still wins over any directory.
  harness.settings.screenshot.autoSaveOnCopy = false
  harness.settings.screenshot.lastSaveDirectory = 'E:/shots'
  controller.copy({ sender: {} }, { imageBuffer: Buffer.from([1, 2, 3]) })
  assert.equal(harness.calls.saved.length, 1)
})

test('capture domain reads the save directory through image-file-save (§17.6 single source)', () => {
  assert.match(captureDomainSource, /require\('\.\.\/\.\.\/services\/image-file-save'\)/)
  assert.match(captureDomainSource, /autoSaveOnCopy && resolveSaveDirectory\(settings\)/)
  assert.doesNotMatch(captureDomainSource, /autoSaveOnCopy && getSettings\(\)\.screenshot\.saveDirectory/)
})

test('the exported PDF default name follows screenshot.nameTemplate (§17.5, decided by S9a)', () => {
  // The wiring lives in the domain; the name composition is pure, so it can be
  // checked without an Electron round trip.
  assert.match(
    captureDomainSource,
    /makeName: \(prefix, ext\) => makeCaptureName\(prefix, ext, \{ template: getSettings\(\)\?\.screenshot\?\.nameTemplate \}\)/
  )
  const { createDefaultPdfName } = require('../main/services/pdf-export')
  const { makeCaptureName } = require('../main/services/capture-naming')

  const legacy = createDefaultPdfName((prefix, ext) => makeCaptureName(prefix, ext, { template: '' }))
  assert.match(legacy, /^Highlighter_\d{4}-\d{2}-\d{2}_[\d-]+\.pdf$/, 'an empty template keeps the legacy name')

  const templated = createDefaultPdfName((prefix, ext) => makeCaptureName(prefix, ext, { template: '{app}-{date}_{time}' }))
  assert.match(
    templated,
    /^Highlighter_\d{4}-\d{2}-\d{2}_[\d-]+_Highlighter-\d{4}-\d{2}-\d{2}_[\d-]+\.pdf$/,
    'a non-empty template is rendered into the PDF name'
  )
})
