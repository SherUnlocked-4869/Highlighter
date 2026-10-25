'use strict'

// Unit tests for the two modules extracted out of main.js to free the line
// budget (task R0: main.js 1329 -> 1283 under the unchanged 1330 ceiling).
//
// These are pure factories with every Electron handle injected, so the tests run
// outside Electron — the same contract main/services/* is held to. They also
// keep the extracted code inside the `test:coverage:loaded` 85% bucket instead
// of relying on the aggregate margin (see docs/plans/2026-09-27-mainjs-refactor-v4-design.md).

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const { createWindowActions } = require('../main/services/window-actions')
const {
  createComponentLister,
  createInstallTypeResolver,
  createSensitiveValueCollector
} = require('../main/services/diagnostics-bootstrap')

// ---------- createWindowActions --------------------------------------------

function createActions(overrides = {}) {
  const calls = []
  const deps = {
    app: { getPath: (name) => (name === 'pictures' ? 'P:/pictures' : `P:/${name}`) },
    shell: {
      openExternal: (url) => { calls.push(['openExternal', url]); return Promise.resolve() },
      openPath: (target) => { calls.push(['openPath', target]); return Promise.resolve('') }
    },
    screen: {
      getAllDisplays: () => [{
        id: 1,
        label: 'Display 1',
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        workArea: { x: 0, y: 0, width: 1920, height: 1040 },
        size: { width: 1920, height: 1080 },
        scaleFactor: 1.25,
        rotation: 0,
        internal: false
      }],
      dipToScreenRect: (_display, bounds) => ({ ...bounds, physical: true }),
      getCursorScreenPoint: () => ({ x: 5, y: 6 }),
      getPrimaryDisplay: () => ({ id: 1 }),
      getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 100, height: 100 } })
    },
    desktopCapturer: {
      getSources: async () => [
        { id: 'screen:1', display_id: 1, name: 'Screen 1', thumbnail: { getSize: () => ({ width: 64, height: 36 }) } }
      ]
    },
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ['C:/picked'] }) },
    isWin: true,
    getSettings: () => ({ screenshot: { saveDirectory: 'S:/shots' } }),
    getDataRoot: () => 'R:/data-root',
    isAutomationEnabled: () => false
  }
  return { actions: createWindowActions({ ...deps, ...overrides }), calls }
}

test('openExternal only forwards http(s) after URL normalization', async () => {
  const { actions, calls } = createActions()
  await actions.openExternal('HTTPS://Example.COM/a b')
  assert.deepEqual(calls, [['openExternal', 'https://example.com/a%20b']])
  for (const rejected of ['javascript:alert(1)', 'file:///etc/passwd', '', null, 'not a url']) {
    assert.throws(() => actions.openExternal(rejected), /仅支持打开 HTTP 或 HTTPS 链接/, `rejects ${rejected}`)
  }
})

test('getDisplayDiagnostics maps displays and reports physical bounds on Windows only', async () => {
  const { actions } = createActions()
  const diagnostics = await actions.getDisplayDiagnostics()
  assert.deepEqual(diagnostics.cursor, { x: 5, y: 6 })
  assert.deepEqual(Object.keys(diagnostics.displays[0]), [
    'id', 'label', 'bounds', 'workArea', 'size', 'scaleFactor', 'rotation', 'internal', 'physicalBounds'
  ])
  assert.equal(diagnostics.displays[0].physicalBounds.physical, true)
  assert.deepEqual(diagnostics.sources, [
    { id: 'screen:1', displayId: 1, name: 'Screen 1', thumbnailSize: { width: 64, height: 36 } }
  ])

  const nonWindows = createActions({
    isWin: false,
    screen: {
      getAllDisplays: () => [{
        id: 2,
        label: 'Display 2',
        bounds: { x: 1, y: 2, width: 3, height: 4 },
        workArea: { x: 1, y: 2, width: 3, height: 4 },
        size: { width: 3, height: 4 },
        scaleFactor: 1,
        rotation: 0,
        internal: false
      }],
      dipToScreenRect: () => { throw new Error('dipToScreenRect must not run off Windows') },
      getCursorScreenPoint: () => ({ x: 0, y: 0 })
    },
    desktopCapturer: { getSources: async () => [] }
  })
  const offWindows = await nonWindows.actions.getDisplayDiagnostics()
  assert.deepEqual(offWindows.displays[0].physicalBounds, { x: 1, y: 2, width: 3, height: 4 })
})

test('directory pickers keep the legacy dialog shapes', async () => {
  const opened = []
  const { actions } = createActions({
    dialog: {
      showOpenDialog: async (options) => {
        opened.push(options)
        return { canceled: false, filePaths: ['D:/chosen'] }
      }
    }
  })

  assert.equal(await actions.pickDirectory(), 'D:/chosen')
  assert.deepEqual(opened[0], { properties: ['openDirectory', 'createDirectory'] })

  assert.equal(await actions.pickDirectory({ title: 'T' }), 'D:/chosen')
  assert.deepEqual(opened[1], { title: 'T', properties: ['openDirectory', 'createDirectory'] })

  // chooseDirectory is the title-less form used by the generic app channel.
  assert.equal(await actions.chooseDirectory(), 'D:/chosen')
  assert.deepEqual(opened[2], { properties: ['openDirectory', 'createDirectory'] })
})

test('a cancelled directory picker resolves to the empty string', async () => {
  const { actions } = createActions({
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }
  })
  assert.equal(await actions.pickDirectory(), '')
})

test('the open-directory actions resolve their target through the injected providers', async () => {
  const dataRoot = createActions()
  await dataRoot.actions.openDataDirectory()
  assert.deepEqual(dataRoot.calls, [['openPath', 'R:/data-root']])

  const configured = createActions()
  await configured.actions.openSaveDirectory()
  assert.deepEqual(configured.calls, [['openPath', 'S:/shots']])

  // The remembered directory wins over the configured one (P0-7B ordering).
  const remembered = createActions({
    getSettings: () => ({ screenshot: { saveDirectory: 'S:/shots', lastSaveDirectory: 'M:/last' } })
  })
  await remembered.actions.openSaveDirectory()
  assert.deepEqual(remembered.calls, [['openPath', 'M:/last']])

  const unconfigured = createActions({ getSettings: () => ({}) })
  await unconfigured.actions.openSaveDirectory()
  assert.deepEqual(unconfigured.calls, [['openPath', 'P:/pictures']])
})

test('positionAutomationWindow only acts for an e2e run with a secondary display', () => {
  const secondary = { id: 2, workArea: { x: 1920, y: 0, width: 1000, height: 800 } }
  const positioned = []
  const win = {
    isDestroyed: () => false,
    getSize: () => [200, 100],
    setPosition: (...args) => positioned.push(args)
  }
  const enabled = createActions({
    isAutomationEnabled: () => true,
    screen: {
      getAllDisplays: () => [{ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }, secondary],
      getPrimaryDisplay: () => ({ id: 1 }),
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      dipToScreenRect: (_display, bounds) => bounds
    }
  })
  assert.equal(enabled.actions.positionAutomationWindow(win), true)
  // Centred: 1920 + (1000 - 200) / 2 = 2320, 0 + (800 - 100) / 2 = 350.
  assert.deepEqual(positioned[0], [2320, 350, false])

  const noSecondary = createActions({
    isAutomationEnabled: () => true,
    screen: {
      getAllDisplays: () => [{ id: 1 }],
      getPrimaryDisplay: () => ({ id: 1 }),
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      dipToScreenRect: (_display, bounds) => bounds
    }
  })
  assert.equal(noSecondary.actions.positionAutomationWindow(win), false)
  assert.equal(noSecondary.actions.positionAutomationWindow({ isDestroyed: () => true }), false)
  assert.equal(noSecondary.actions.positionAutomationWindow(null), false)
  // Automation disabled: never touches the window even when a second display exists.
  const disabled = createActions({ isAutomationEnabled: () => false })
  assert.equal(disabled.actions.positionAutomationWindow({
    isDestroyed: () => false,
    getSize: () => [1, 1],
    setPosition: () => { throw new Error('must not position outside an e2e run') }
  }), false)
})

// ---------- diagnostics-bootstrap ----------------------------------------

test('the sensitive-value collector stays empty until the store exists', () => {
  const collect = createSensitiveValueCollector({
    getStore: () => null,
    getSettings: () => ({ apiKey: 'unused' })
  })
  assert.deepEqual(collect(), [])
})

test('the sensitive-value collector harvests apiKey and credential-like key paths', () => {
  const collect = createSensitiveValueCollector({
    getStore: () => ({}),
    getSettings: () => ({
      apiKey: 'top-level',
      ai: {
        providers: [{
          apiKey: 'nested-key',
          authorization: 'bearer-token',
          password: 'pw',
          secret: 'sec',
          token: 'tok',
          prompt: 'prompt-text',
          model: 'not-a-secret'
        }]
      },
      system: { runLog: true }
    })
  })
  // 'top-level' appears twice by design: the collector seeds the list with
  // settings.apiKey and the recursive walk then re-adds it from the `apiKey`
  // key path. That duplication predates the extraction and is kept as-is.
  assert.deepEqual(collect(), ['top-level', 'top-level', 'nested-key', 'bearer-token', 'pw', 'sec', 'tok', 'prompt-text'])
})

test('the install-type resolver keeps the original branch order', () => {
  const resolve = (options) => createInstallTypeResolver({
    app: { isPackaged: options.packaged },
    path,
    isPortable: () => options.portable,
    execPath: options.execPath
  })
  assert.equal(resolve({ packaged: false, portable: true, execPath: 'x' })(), 'development')
  assert.equal(resolve({ packaged: true, portable: true, execPath: 'x' })(), 'portable')
  assert.equal(resolve({
    packaged: true,
    portable: false,
    execPath: path.join('C:', 'app', 'win-unpacked', 'Highlighter.exe')
  })(), 'unpacked')
  assert.equal(resolve({
    packaged: true,
    portable: false,
    execPath: path.join('C:', 'Program Files', 'Highlighter', 'Highlighter.exe')
  })(), 'nsis')
})

test('the component lister reports the three bundled components', () => {
  const list = createComponentLister({
    app: { getVersion: () => '4.1.4' },
    path,
    getResourceRoot: () => path.join('C:', 'resources'),
    resolveFfmpegPath: () => path.join('C:', 'resources', 'ffmpeg.exe'),
    requireFfmpegVersion: () => '5.3.0'
  })
  const root = path.join('C:', 'resources')
  assert.deepEqual(list(), [
    { name: 'SmartSelect', path: path.join(root, 'native', 'smart-select', 'SmartSelect.exe'), version: '4.1.4' },
    { name: 'OCR sidecar', path: path.join(root, 'native', 'ocr', 'HighlighterOcrSidecar.exe'), version: '4.1.4' },
    { name: 'FFmpeg', path: path.join('C:', 'resources', 'ffmpeg.exe'), version: '5.3.0' }
  ])
})

test('the component lister degrades instead of throwing when FFmpeg cannot be resolved', () => {
  const list = createComponentLister({
    app: { getVersion: () => '4.1.4' },
    path,
    getResourceRoot: () => 'R',
    resolveFfmpegPath: () => { throw new Error('ffmpeg-static is missing') },
    requireFfmpegVersion: () => { throw new Error('no package version') }
  })
  const components = list()
  assert.equal(components.length, 3)
  assert.deepEqual(components[2], { name: 'FFmpeg', path: '', version: '' })
})
