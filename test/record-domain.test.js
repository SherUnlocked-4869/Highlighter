const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
const recordDomainSource = fs.readFileSync(path.join(root, 'main/domains/record/index.js'), 'utf8')

test('main.js delegates record domain instead of inlining recording windows and IPC', () => {
  assert.match(main, /require\('\.\/main\/domains\/record'\)/)
  assert.match(main, /createRecordDomain\(\{/)
  assert.match(main, /recordDomain\s*=\s*createRecordDomain/)
  assert.doesNotMatch(main, /function createRecordWindow\(/)
  assert.doesNotMatch(main, /function closeRecordFlow\(/)
  assert.doesNotMatch(main, /function requireRecordSender\(/)
  assert.doesNotMatch(main, /const recordingIpcController/)
  assert.doesNotMatch(main, /let recordWindow = null/)
})

test('main.js routes record ownership through the domain', () => {
  assert.match(main, /recordDomain\?\.ownsControlWindow\(win\)/)
  assert.match(main, /recordDomain\?\.ownsFrameWindow\(win\)/)
  assert.match(main, /recordDomain\?\.isTaskActive\(\)/)
  assert.match(main, /recordDomain\.createRecordWindow\(/)
  assert.match(main, /recordDomain\.createRecordingController\(\)/)
  assert.match(main, /recordDomain\.shutdown\(\)/)
})

test('record domain owns window lifecycle, annotation routing, and MP4 save', () => {
  assert.match(recordDomainSource, /function createRecordWindow/)
  assert.match(recordDomainSource, /function createRecordingController/)
  assert.match(recordDomainSource, /function requireRecordSender/)
  assert.match(recordDomainSource, /function requireRecordFrameSender/)
  assert.match(recordDomainSource, /function sendRecordAnnotationCommand/)
  assert.match(recordDomainSource, /saveMp4/)
  assert.match(recordDomainSource, /setContentProtection\(true\)/)
})

test('record domain factory tracks control and frame window ownership', async () => {
  const { createRecordDomain } = require('../main/domains/record')
  const domain = createRecordDomain({
    app: { getPath: () => path.join(root, 'tmp-videos') },
    desktopCapturer: {
      getSources: async () => [{ id: 'screen:1', display_id: '1', thumbnail: { isEmpty: () => false } }]
    },
    path,
    screen: {
      getDisplayMatching: () => ({ id: 1, scaleFactor: 1, bounds: { x: 0, y: 0, width: 800, height: 600 }, workArea: { x: 0, y: 0, width: 800, height: 600 } }),
      getDisplayNearestPoint: () => ({ id: 1, scaleFactor: 1, bounds: { x: 0, y: 0, width: 800, height: 600 }, workArea: { x: 0, y: 0, width: 800, height: 600 } })
    },
    dialog: { showSaveDialog: async () => ({ canceled: true }) },
    BrowserWindow: { fromWebContents: () => null },
    rootDirectory: root,
    createLocalWindow: (pagePath) => {
      const win = {
        pagePath,
        isDestroyed: () => false,
        setAlwaysOnTop: () => {},
        setContentProtection: () => {},
        setIgnoreMouseEvents: () => {},
        setBounds: () => {},
        show: () => {},
        showInactive: () => {},
        hide: () => {},
        close: () => {},
        loadFile: () => Promise.resolve(),
        on: () => {},
        webContents: { send: () => {} }
      }
      return win
    },
    getSettings: () => ({ record: { frameRate: 24, saveDirectory: '' } }),
    log: () => {},
    assertGameModeDisabled: () => {},
    assertManagedDataWritable: () => {},
    getRecordingService: () => null,
    managedRecordingWriters: {
      track: async (fn) => (typeof fn === 'function' ? fn() : fn),
      assertOpen: () => {}
    },
    makeCaptureName: (prefix) => `${prefix}-test.png`,
    VIDEO_CAPTURE_PREFIX: 'video',
    performanceMonitor: { record: () => {}, snapshot: () => {} }
  })

  assert.equal(domain.ownsControlWindow(null), false)
  assert.equal(domain.ownsFrameWindow(null), false)
  assert.equal(domain.isTaskActive(), false)

  const control = await domain.createRecordWindow({
    selectionBounds: { x: 10, y: 10, width: 200, height: 150 }
  })
  assert.ok(control)
  assert.equal(domain.ownsControlWindow(control), true)
  assert.equal(domain.isTaskActive(), true)
})
