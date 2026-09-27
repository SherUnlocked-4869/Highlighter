const test = require('node:test')
const assert = require('node:assert/strict')
const { createFunctionRouter } = require('../main/services/function-router')

function createHarness(overrides = {}) {
  const calls = {
    capture: [],
    captureFocusedWindow: 0,
    record: [],
    pinWindows: [],
    pinVisibility: 0,
    searchWindows: 0,
    routes: [],
    persisted: [],
    clipboardWrites: [],
    clipboardText: 'clipboard text',
    openedPaths: [],
    dialogs: [],
    log: [],
    hiddenToolbar: 0,
    aiActions: []
  }
  const mainWindow = { destroyed: false, visible: true, isDestroyed: () => mainWindow.destroyed, isVisible: () => mainWindow.visible, hide: () => { mainWindow.visible = false } }
  const router = createFunctionRouter({
    app: { getPath: (name) => (name === 'pictures' ? 'C:\\pictures' : 'C:\\user') },
    clipboard: {
      writeImage: (image) => calls.clipboardWrites.push(image),
      readText: () => calls.clipboardText
    },
    dialog: { showOpenDialog: (...args) => { calls.dialogs.push(args); return Promise.resolve(overrides.dialogResult || { canceled: false, filePaths: ['C:\\shot.png'] }) } },
    nativeImage: {
      createFromDataURL: (value) => ({ kind: 'data-url', value }),
      createFromPath: (value) => ({ kind: 'path', value, toDataURL: () => `data:${value}` })
    },
    screen: {
      getCursorScreenPoint: () => ({ x: 1, y: 2 }),
      getDisplayNearestPoint: () => ({ bounds: { x: 0, y: 0, width: 1920, height: 1080 } })
    },
    shell: { openPath: (target) => { calls.openedPaths.push(target); return Promise.resolve('') } },
    captureDomain: {
      createCaptureWindow: (options) => { calls.capture.push(options); return Promise.resolve({}) },
      captureFocusedWindow: () => { calls.captureFocusedWindow += 1; return Promise.resolve('data:image/png;base64,AAA') }
    },
    pinDomain: {
      createPinWindow: (...args) => calls.pinWindows.push(args),
      togglePinVisibility: () => { calls.pinVisibility += 1 }
    },
    recordDomain: {
      createRecordWindow: (options) => { calls.record.push(options); return Promise.resolve() }
    },
    searchDomain: { createSearchWindow: () => { calls.searchWindows += 1 } },
    selectionDomain: {
      hideToolbar: () => { calls.hiddenToolbar += 1 },
      openToolbarAiAction: (...args) => { calls.aiActions.push(args); return Promise.resolve(true) }
    },
    getMainWindow: () => mainWindow,
    createMainWindow: (route) => { calls.routes.push(route) },
    getSettings: () => ({ screenshot: { saveDirectory: '' } }),
    persistHistory: (...args) => calls.persisted.push(args),
    assertGameModeDisabled: () => {
      if (overrides.gameMode) throw new Error('游戏模式已开启，请先通过托盘菜单关闭游戏模式')
    },
    log: (...args) => calls.log.push(args)
  })
  return { router, calls, mainWindow }
}

test('unknown feature names are rejected, including Object.prototype members', async () => {
  const { router } = createHarness()
  await assert.rejects(() => router.executeFunction('nope'), /未知功能：nope/)
  await assert.rejects(() => router.executeFunction('toString'), /未知功能：toString/)
  await assert.rejects(() => router.executeFunction('constructor'), /未知功能：constructor/)
})

test('game mode blocks every dispatch before the handler runs', async () => {
  const { router, calls } = createHarness({ gameMode: true })
  await assert.rejects(() => router.executeFunction('screenshot'), /游戏模式已开启/)
  assert.equal(calls.capture.length, 0)
})

test('screenshot variants map to capture window options', async () => {
  const { router, calls } = createHarness()
  const expected = {
    screenshot: { mode: 'region', source: 'region' },
    screenshotFixed: { mode: 'region', autoAction: 'pin', source: 'fixed' },
    screenshotOcr: { mode: 'region', autoAction: 'ocr', source: 'ocr' },
    screenshotTable: { mode: 'region', autoAction: 'table', source: 'table' },
    screenshotQr: { mode: 'region', autoAction: 'qr', source: 'qr' },
    screenshotOcrTranslate: { mode: 'region', autoAction: 'translate', source: 'ocr-translate' },
    screenshotCopy: { mode: 'region', autoAction: 'copy', source: 'copy' },
    screenshotLong: { mode: 'region', autoAction: 'long', source: 'long-capture' },
    fullScreenDraw: { mode: 'canvas', source: 'canvas' }
  }
  for (const [name, options] of Object.entries(expected)) {
    assert.equal(await router.executeFunction(name), true)
    assert.deepEqual(calls.capture.at(-1), options)
  }
})

test('fullscreen capture honours the save flag and delay schedules without opening one', async () => {
  const { router, calls } = createHarness()
  await router.executeFunction('screenshotFullScreen', { save: true })
  assert.deepEqual(calls.capture.at(-1), { mode: 'fullscreen', autoAction: 'save', source: 'fullscreen' })
  await router.executeFunction('screenshotFullScreen')
  assert.deepEqual(calls.capture.at(-1), { mode: 'fullscreen', autoAction: 'copy', source: 'fullscreen' })

  const scheduled = await router.executeFunction('screenshotDelay', { seconds: 0 })
  assert.deepEqual(scheduled, { scheduled: true, seconds: 0 })
  assert.equal(calls.capture.length, 2, 'the delayed capture runs later, not inline')
})

test('focused window capture copies the image and records history', async () => {
  const { router, calls } = createHarness()
  assert.equal(await router.executeFunction('screenshotFocusedWindow'), true)
  assert.equal(calls.captureFocusedWindow, 1)
  assert.equal(calls.clipboardWrites.length, 1)
  assert.deepEqual(calls.persisted.at(-1), ['data:image/png;base64,AAA', { action: 'copy', source: 'focused-window' }])
})

test('fixed content pins the chosen file but a cancelled dialog returns false', async () => {
  const ok = createHarness()
  assert.equal(await ok.router.executeFunction('fixedContent'), true)
  assert.deepEqual(ok.calls.pinWindows.at(-1), ['data:C:\\shot.png', { source: 'file' }])

  const cancelled = createHarness({ dialogResult: { canceled: true, filePaths: [] } })
  assert.equal(await cancelled.router.executeFunction('fixedContent'), false)
  assert.equal(cancelled.calls.pinWindows.length, 0)
})

test('record, pin, search, folder and window routes land on their domains', async () => {
  const { router, calls, mainWindow } = createHarness()

  assert.equal(await router.executeFunction('videoRecord'), true)
  assert.deepEqual(calls.record.at(-1), { display: { bounds: { x: 0, y: 0, width: 1920, height: 1080 } }, selectionBounds: { x: 0, y: 0, width: 1920, height: 1080 } })

  assert.equal(await router.executeFunction('toggleFixedContentVisibility'), true)
  assert.equal(calls.pinVisibility, 1)

  assert.equal(await router.executeFunction('localSearch'), true)
  assert.equal(calls.searchWindows, 1)

  assert.equal(await router.executeFunction('openCaptureHistory'), true)
  assert.equal(await router.executeFunction('translation'), true)
  assert.equal(await router.executeFunction('chat'), true)
  assert.deepEqual(calls.routes, ['history', 'translation', 'chat'])

  assert.equal(await router.executeFunction('openImageSaveFolder'), true)
  assert.deepEqual(calls.openedPaths, ['C:\\pictures'])

  assert.equal(await router.executeFunction('showOrHideMainWindow'), true)
  assert.equal(mainWindow.visible, false, 'a visible main window is hidden')
  assert.equal(await router.executeFunction('showOrHideMainWindow'), true)
  assert.deepEqual(calls.routes, ['history', 'translation', 'chat', 'home'])
})

test('explain clipboard only reads the clipboard and refuses empty or oversized text', async () => {
  const { router, calls } = createHarness()
  assert.equal(await router.executeFunction('explainClipboard'), true)
  assert.equal(calls.hiddenToolbar, 1)
  assert.deepEqual(calls.aiActions.at(-1), ['explain', 'clipboard text'])
  assert.equal(calls.clipboardWrites.length, 0, 'never writes the clipboard')

  calls.clipboardText = '   '
  assert.equal(await router.executeFunction('explainClipboard'), false)

  calls.clipboardText = 'x'.repeat(10001)
  assert.equal(await router.executeFunction('explainClipboard'), false)
  assert.equal(calls.log.at(-1)[0], 'Explain clipboard skipped: text too long')
})

test('the router advertises every feature name it dispatches', () => {
  const { router } = createHarness()
  const names = router.functionNames()
  assert.ok(names.includes('screenshot'))
  assert.ok(names.includes('explainClipboard'))
  assert.equal(new Set(names).size, names.length)
})
