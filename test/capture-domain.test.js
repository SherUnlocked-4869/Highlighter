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
        close: () => { win._closed = true },
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
  })
})
