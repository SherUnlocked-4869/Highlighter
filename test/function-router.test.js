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
    aiActions: [],
    clickThroughExits: 0,
    recordingWorkbench: 0,
    regionRecordings: 0,
    pauseResumes: 0,
    finishes: 0
  }
  const mainWindow = { destroyed: false, visible: true, isDestroyed: () => mainWindow.destroyed, isVisible: () => mainWindow.visible, hide: () => { mainWindow.visible = false } }
  const pinDomain = overrides.pinDomain || {
    createPinWindow: (...args) => calls.pinWindows.push(args),
    togglePinVisibility: () => { calls.pinVisibility += 1 },
    exitAllClickThrough: () => { calls.clickThroughExits += 1; return overrides.clickThroughExited ?? 1 }
  }
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
    pinDomain,
    recordDomain: overrides.recordDomain || {
      createRecordWindow: (options) => { calls.record.push(options); return Promise.resolve() },
      // R2 (contracts §4.1): the recording workbench / quick-start / live-control entries.
      openRecordingWorkbench: () => { calls.recordingWorkbench += 1; return true },
      startRegionRecording: () => { calls.regionRecordings += 1; return Promise.resolve(true) },
      pauseResumeActive: () => { calls.pauseResumes += 1; return true },
      finishActive: () => { calls.finishes += 1; return true }
    },
    searchDomain: { createSearchWindow: () => { calls.searchWindows += 1 } },
    selectionDomain: {
      hideToolbar: () => { calls.hiddenToolbar += 1 },
      openToolbarAiAction: (...args) => { calls.aiActions.push(args); return Promise.resolve(true) }
    },
    getMainWindow: () => mainWindow,
    createMainWindow: (route) => { calls.routes.push(route) },
    getPinDomain: () => pinDomain,
    getSettings: () => overrides.settings || { screenshot: { saveDirectory: '' } },
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
  // The tray entry is the reason this matters: a suspended shortcut and a
  // refused router call would both leave a click-through pin unreachable.
  await assert.rejects(() => router.executeFunction('togglePinClickThrough'), /游戏模式已开启/)
  assert.equal(calls.clickThroughExits, 0)
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

test('the save shortcuts preset the capture window save mode', async () => {
  const { router, calls } = createHarness()
  assert.equal(await router.executeFunction('screenshotQuickSave'), true)
  assert.deepEqual(calls.capture.at(-1), { mode: 'region', autoAction: 'save', saveMode: 'fast', source: 'quick-save' })
  assert.equal(await router.executeFunction('screenshotSaveAs'), true)
  assert.deepEqual(calls.capture.at(-1), { mode: 'region', autoAction: 'save', saveMode: 'dialog', source: 'save-as' })
})

test('the click-through fallback exits every pin and reports the count', async () => {
  const { router, calls } = createHarness({ clickThroughExited: 3 })
  assert.equal(await router.executeFunction('togglePinClickThrough'), 3)
  assert.equal(calls.clickThroughExits, 1)
})

test('the click-through fallback degrades to zero without the domain interface', async () => {
  const bare = { createPinWindow: () => {}, togglePinVisibility: () => {} }
  const { router, calls } = createHarness({ pinDomain: bare })
  assert.equal(await router.executeFunction('togglePinClickThrough'), 0)
  assert.equal(calls.log.at(-1)[0], 'Click-through exit unavailable: pin domain does not expose exitAllClickThrough')
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

// R2 (docs/plans/2026-11-03-recording-r1-r3-contracts.md §4.1/§4.2): the workbench, the two quick
// start entries and the live-control entries. All five are FROZEN shortcut keys (contract §3), so
// the router has to dispatch every one of them; `videoRecord` keeps its fullscreen meaning.
test('recording entries dispatch through the record domain', async () => {
  const { router, calls } = createHarness()

  assert.equal(await router.executeFunction('openRecording'), true)
  assert.equal(calls.recordingWorkbench, 1)

  assert.equal(await router.executeFunction('recordRegion'), true)
  assert.equal(calls.regionRecordings, 1)

  assert.equal(await router.executeFunction('recordFullscreen'), true)
  assert.equal(calls.record.at(-1).mode, 'display')
  assert.deepEqual(calls.record.at(-1).selectionBounds, { x: 0, y: 0, width: 1920, height: 1080 })

  assert.equal(await router.executeFunction('recordPauseResume'), true)
  assert.equal(await router.executeFunction('recordFinish'), true)
  assert.equal(calls.pauseResumes, 1)
  assert.equal(calls.finishes, 1)
})

test('recording entries land on the workbench window and degrade without the domain surface', async () => {
  // A bare domain (no workbench helper) still opens the new recording route, and the live-control
  // entries answer `false` instead of throwing inside a global-shortcut callback.
  const { router, calls } = createHarness({ recordDomain: { createRecordWindow: () => Promise.resolve() } })
  assert.equal(await router.executeFunction('openRecording'), true)
  assert.deepEqual(calls.routes, ['recording'])
  assert.equal(await router.executeFunction('recordPauseResume'), false)
  assert.equal(await router.executeFunction('recordFinish'), false)
  assert.equal(await router.executeFunction('recordRegion'), false)
})

test('opening the save folder follows the remembered directory', async () => {
  const { router, calls } = createHarness({
    settings: { screenshot: { saveDirectory: 'C:/configured', lastSaveDirectory: 'C:/remembered' } }
  })
  assert.equal(await router.executeFunction('openImageSaveFolder'), true)
  assert.deepEqual(calls.openedPaths, ['C:/remembered'])
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
  // P0-7-T3 + P0-6-T4: the names must match the frozen settings keys.
  assert.ok(names.includes('screenshotQuickSave'))
  assert.ok(names.includes('screenshotSaveAs'))
  assert.ok(names.includes('togglePinClickThrough'))
  assert.equal(new Set(names).size, names.length)
})

test('every frozen recording shortcut key has a router entry', () => {
  // R2 (contracts §3): `shortcuts` gained five recording entries. ShortcutService calls
  // executeFunction(name) for ANY non-empty shortcut key, so a missing entry would surface as
  // "unknown feature" inside a global-shortcut callback.
  const { DEFAULT_SETTINGS } = require('../main/services/settings-defaults')
  const { router } = createHarness()
  const names = new Set(router.functionNames())
  for (const key of ['openRecording', 'recordRegion', 'recordFullscreen', 'recordPauseResume', 'recordFinish', 'videoRecord']) {
    assert.ok(Object.hasOwn(DEFAULT_SETTINGS.shortcuts, key), `settings-defaults declares ${key}`)
    assert.ok(names.has(key), `the router dispatches ${key}`)
  }
})
