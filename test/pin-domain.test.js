const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
const pinDomainSource = fs.readFileSync(path.join(root, 'main/domains/pin/index.js'), 'utf8')
const preloadSource = fs.readFileSync(path.join(root, 'preload-pin.js'), 'utf8')

const DATA_URL = 'data:image/png;base64,AA=='

// A window shape that records everything the click-through path touches, so the
// tests can assert the OS-level call order and the renderer receipt.
function createHarness({ pinnedClickThrough = false } = {}) {
  const handlers = new Map()
  const created = []
  const sends = []
  const { createPinDomain } = require('../main/domains/pin')
  const domain = createPinDomain({
    BrowserWindow: { fromWebContents: (sender) => sender?.window || null },
    clipboard: { writeImage: () => {} },
    nativeImage: {
      createFromDataURL: () => ({
        getSize: () => ({ width: 200, height: 100 }),
        toDataURL: () => DATA_URL
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
        _ops: [],
        _ignoreMouse: [],
        _bounds: [],
        isDestroyed: () => false,
        getBounds: () => ({ x: 0, y: 0, width: 100, height: 50 }),
        setBounds: (bounds) => win._bounds.push(bounds),
        setPosition: () => {},
        setContentSize: () => {},
        setAlwaysOnTop: () => {},
        setOpacity: () => {},
        setIgnoreMouseEvents: (ignore, options) => {
          win._ops.push(`ignore:${ignore}`)
          win._ignoreMouse.push({ ignore, options })
        },
        show: () => win._ops.push('show'),
        hide: () => {},
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
        send: (channel, payload) => sends.push({ win, channel, payload })
      }
      created.push(win)
      return win
    },
    getSettings: () => ({
      fixedContent: { opacity: 1, zoomWithMouse: true },
      plugins: { ocr: true },
      pinned: { clickThrough: pinnedClickThrough }
    }),
    saveDataUrl: async () => 'saved',
    createRecognitionWindow: () => {},
    getCreateCaptureWindow: () => async () => null,
    dataUrlToBuffer: () => Buffer.from([0]),
    bufferToDataUrl: () => DATA_URL,
    log: () => {},
    ipcMain: {
      on: (channel, handler) => handlers.set(channel, handler)
    }
  })
  return { domain, handlers, created, sends }
}

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
    'pin:set-click-through'
  ]) {
    assert.match(pinDomainSource, new RegExp(`ipcMain\\.on\\('${channel.replace(':', ':')}'`))
  }
})

test('the old toggle channel is gone and the receipt stays a main -> renderer send', () => {
  assert.doesNotMatch(pinDomainSource, /pin:toggle-click-through/)
  assert.doesNotMatch(preloadSource, /toggleClickThrough/)
  assert.match(pinDomainSource, /webContents\.send\('pin:click-through-changed', next\)/)
  assert.match(preloadSource, /ipcRenderer\.send\('pin:set-click-through', enabled === true\)/)
  assert.match(preloadSource, /ipcRenderer\.on\('pin:click-through-changed'/)
})

test('pin domain factory owns windows and shared pin slots', () => {
  const { domain, handlers, created } = createHarness()

  assert.equal(domain.ownsWindow(null), false)
  assert.equal(domain.getPinnedCount(), 0)
  assert.ok(handlers.has('pin:ready'))
  assert.ok(handlers.has('pin:move-end'))

  const win = domain.createPinWindow(DATA_URL, {})
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
  assert.equal(created.length, 1)
})

test('pin:set-click-through is explicit and echoes a receipt to the owning renderer', () => {
  const { domain, handlers, sends } = createHarness()
  const win = domain.createPinWindow(DATA_URL, {})
  const set = handlers.get('pin:set-click-through')
  assert.equal(typeof set, 'function')
  assert.equal(win._pinData.clickThrough, false)

  set({ sender: win.webContents }, true)
  assert.equal(win._pinData.clickThrough, true)
  assert.deepEqual(win._ignoreMouse.at(-1), { ignore: true, options: { forward: true } })
  assert.deepEqual(sends.at(-1), { win, channel: 'pin:click-through-changed', payload: true })

  set({ sender: win.webContents }, false)
  assert.equal(win._pinData.clickThrough, false)
  assert.deepEqual(win._ignoreMouse.at(-1), { ignore: false, options: undefined })
  assert.deepEqual(sends.at(-1), { win, channel: 'pin:click-through-changed', payload: false })

  // Explicit, never a flip: a malformed or repeated payload cannot turn the pin
  // transparent or toggle it back on.
  set({ sender: win.webContents }, 'yes')
  assert.equal(win._pinData.clickThrough, false)
  set({ sender: win.webContents }, true)
  const osCalls = win._ignoreMouse.length
  set({ sender: win.webContents }, true)
  assert.equal(win._pinData.clickThrough, true)
  // A repeated set never churns the OS state, but still re-echoes the receipt so
  // a renderer that missed the first one can resync.
  assert.equal(win._ignoreMouse.length, osCalls)
  assert.deepEqual(sends.at(-1), { win, channel: 'pin:click-through-changed', payload: true })
})

test('exitAllClickThrough clears every pin without a renderer round-trip', () => {
  const { domain, handlers } = createHarness()
  const first = domain.createPinWindow(DATA_URL, {})
  const second = domain.createPinWindow(DATA_URL, {})
  const set = handlers.get('pin:set-click-through')
  set({ sender: first.webContents }, true)
  set({ sender: second.webContents }, true)
  assert.equal(first._pinData.clickThrough, true)
  assert.equal(second._pinData.clickThrough, true)
  assert.deepEqual([domain.ownsWindow(first), domain.ownsWindow(second)], [true, true])

  // No ipcMain handler and no renderer is involved: this is exactly what S7's
  // global shortcut / tray item calls through the injected pin domain.
  assert.equal(domain.exitAllClickThrough(), 2)
  assert.equal(first._pinData.clickThrough, false)
  assert.equal(second._pinData.clickThrough, false)
  assert.deepEqual(first._ignoreMouse.at(-1), { ignore: false, options: undefined })

  // Idempotent: a second call reports that nothing left the mode.
  assert.equal(domain.exitAllClickThrough(), 0)
})

test('a new pin honours pinned.clickThrough and is mouse-transparent before it is shown', () => {
  const { domain } = createHarness({ pinnedClickThrough: true })
  const win = domain.createPinWindow(DATA_URL, {})
  assert.equal(win._pinData.clickThrough, true)
  assert.deepEqual(win._ignoreMouse.at(-1), { ignore: true, options: { forward: true } })
  // Applied while the window is still hidden, so the first click already passes
  // through instead of being swallowed by an opaque-to-the-mouse pin.
  assert.equal(win._ops.includes('show'), false)
  assert.ok(win._ops.indexOf('ignore:true') < win._ops.length)

  const visible = createHarness().domain.createPinWindow(DATA_URL, {})
  assert.equal(visible._pinData.clickThrough, false)
  assert.deepEqual(visible._ignoreMouse, [])
})

test('a click-through pin refuses move and resize until it is released', () => {
  const { domain, handlers } = createHarness()
  const win = domain.createPinWindow(DATA_URL, {})
  const set = handlers.get('pin:set-click-through')
  const moveStart = handlers.get('pin:move-start')
  const move = handlers.get('pin:move')
  const resize = handlers.get('pin:resize')

  // Baseline: without click-through the drag still works.
  win._bounds.length = 0
  moveStart({ sender: win.webContents })
  assert.ok(win._pinMove)
  move({ sender: win.webContents })
  assert.equal(win._bounds.length, 1)

  set({ sender: win.webContents }, true)
  win._pinMove = null
  win._bounds.length = 0
  moveStart({ sender: win.webContents })
  assert.equal(win._pinMove, null)
  move({ sender: win.webContents })
  assert.deepEqual(win._bounds, [])
  resize({ sender: win.webContents }, { factor: 1.25 })
  assert.deepEqual(win._bounds, [])
  assert.equal(win._pinData.zoom, 1)
})
