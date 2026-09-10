const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
const pinDomainSource = fs.readFileSync(path.join(root, 'main/domains/pin/index.js'), 'utf8')

test('main.js delegates pin domain instead of inlining pin windows and IPC', () => {
  assert.match(main, /require\('\.\/main\/domains\/pin'\)/)
  assert.match(main, /createPinDomain\(\{/)
  assert.match(main, /pinDomain\s*=\s*createPinDomain/)
  assert.doesNotMatch(main, /function createPinWindow\(/)
  assert.doesNotMatch(main, /function startPinReannotation\(/)
  assert.doesNotMatch(main, /function pinFromCapture\(/)
  assert.doesNotMatch(main, /function togglePinVisibility\(/)
  assert.doesNotMatch(main, /secureIpcMain\.on\('pin:/)
  assert.doesNotMatch(main, /const pinWindows = new Set/)
  assert.doesNotMatch(main, /let pinnedCount = 0/)
})

test('pin domain registers the full pin IPC surface', () => {
  for (const channel of [
    'pin:ready',
    'pin:render-ready',
    'pin:close',
    'pin:copy',
    'pin:save',
    'pin:context-menu',
    'pin:resize',
    'pin:move-start',
    'pin:move',
    'pin:move-end',
    'pin:toggle-click-through'
  ]) {
    assert.match(pinDomainSource, new RegExp(`ipcMain\\.on\\('${channel.replace(':', ':')}'`))
  }
})

test('pin domain factory owns windows and shared pin slots', () => {
  const handlers = new Map()
  const created = []
  const { createPinDomain } = require('../main/domains/pin')
  const domain = createPinDomain({
    BrowserWindow: { fromWebContents: () => created[created.length - 1] || null },
    clipboard: { writeImage: () => {} },
    nativeImage: {
      createFromDataURL: () => ({
        getSize: () => ({ width: 200, height: 100 }),
        toDataURL: () => 'data:image/png;base64,AA=='
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
    rootDirectory: root,
    createLocalWindow: () => {
      const win = {
        isDestroyed: () => false,
        getBounds: () => ({ x: 0, y: 0, width: 100, height: 50 }),
        setBounds: () => {},
        setPosition: () => {},
        setContentSize: () => {},
        setAlwaysOnTop: () => {},
        setOpacity: () => {},
        show: () => {},
        hide: () => {},
        moveTop: () => {},
        focus: () => {},
        loadFile: () => {},
        on: (event, cb) => { if (event === 'closed') win._closed = cb },
        webContents: { send: () => {} }
      }
      created.push(win)
      return win
    },
    getSettings: () => ({ fixedContent: { opacity: 1, zoomWithMouse: true }, plugins: { ocr: true } }),
    saveDataUrl: async () => 'saved',
    createRecognitionWindow: () => {},
    getCreateCaptureWindow: () => async () => null,
    dataUrlToBuffer: () => Buffer.from([0]),
    bufferToDataUrl: () => 'data:image/png;base64,AA==',
    log: () => {},
    ipcMain: {
      on: (channel, handler) => handlers.set(channel, handler)
    }
  })

  assert.equal(domain.ownsWindow(null), false)
  assert.equal(domain.getPinnedCount(), 0)
  assert.ok(handlers.has('pin:ready'))
  assert.ok(handlers.has('pin:move-end'))

  const win = domain.createPinWindow('data:image/png;base64,AA==', {})
  assert.equal(domain.ownsWindow(win), true)
  assert.equal(domain.getPinnedCount(), 1)

  assert.equal(domain.canPinMore(), true)
  assert.equal(domain.acquirePinnedSlot(), true)
  assert.equal(domain.getPinnedCount(), 2)
  domain.releasePinnedSlot()
  assert.equal(domain.getPinnedCount(), 1)

  win._closed()
  assert.equal(domain.ownsWindow(win), false)
  assert.equal(domain.getPinnedCount(), 0)
})
