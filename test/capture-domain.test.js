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
// is a fake so the factory can run under plain node. `cursorProvider` stays optional:
// the P0-2 gate must treat "not injected" exactly like "switch off".
function createHarness({ screenshot = {}, cursorProvider = null, ...deps } = {}) {
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
    performanceMonitor: { record: () => {}, snapshot: () => {} },
    cursorProvider,
    // 允许单个用例追加/覆盖 deps（例如光标 mode 门要跑真正的抓屏分支）。
    ...deps
  })
  return { domain, created, calls, settings }
}

test('capture sends one shown receipt after revealing the window', async () => {
  const harness = createHarness()
  const win = await harness.domain.createCaptureWindow({ mode: 'image', imageBuffer: Buffer.from([1]) })
  const events = []
  win.setOpacity = value => events.push(['opacity', value])
  win.showInactive = () => events.push(['show'])
  win.webContents.send = channel => events.push(['send', channel])
  const controller = harness.domain.createCaptureController()
  try {
    controller.renderReady({ sender: {} })
    controller.renderReady({ sender: {} })
    assert.deepEqual(events, [['opacity', 1], ['show'], ['send', 'capture:shown']])
  } finally {
    win.close()
  }
})

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
  assert.equal(
    fourth._captureInit.serialNumber,
    1,
    'without a renderer report the main process cannot know a serial was used, so it repeats 1 instead of guessing'
  )
  assert.equal(second._captureInit.serialNumber, 1, 'earlier captures keep the reset value')
  fourth.close()
})

// 2026-10-10 真机验收抓到的缺陷：旧实现按"第 N 次截图从 N 开始"接续，一张图里落 3 个序号后，
// 下一张仍从 3 开始（重复）。修正后主进程只记"上一张实际用掉的最后一个序号"，由渲染层回报。
test('a kept serial continues from the last number the previous capture actually used (P0-7-T7)', async () => {
  const harness = createHarness({ screenshot: { keepSerialAcrossCaptures: true } })
  const controller = harness.domain.createCaptureController()

  const first = await harness.domain.createCaptureWindow({ mode: 'image', imageBuffer: Buffer.from([1]) })
  assert.equal(first._captureInit.serialNumber, 1)

  // 渲染层落了 3 个序号 → 计数走到 4，保存时随 meta 回报（capture:save 通道）。
  controller.save({ sender: {} }, { imageBuffer: Buffer.from([1]), meta: { serialNumber: 4 } })
  assert.equal(first._captureInit.serialNumber, 1, 'the already-sent init payload is untouched')

  const second = await harness.domain.createCaptureWindow({ mode: 'image', imageBuffer: Buffer.from([1]) })
  assert.equal(second._captureInit.serialNumber, 4, 'the next capture starts after the last used serial')

  // ✕ / Esc 关窗同样回报（capture:close 通道）：落过就推进。
  controller.close({ sender: {} }, { serialNumber: 7 })
  const third = await harness.domain.createCaptureWindow({ mode: 'image', imageBuffer: Buffer.from([1]) })
  assert.equal(third._captureInit.serialNumber, 7)

  // 只前进：重复或过期的回报不得把计数推回去或推过头。
  controller.save({ sender: {} }, { imageBuffer: Buffer.from([1]), meta: { serialNumber: 5 } })
  const fourth = await harness.domain.createCaptureWindow({ mode: 'image', imageBuffer: Buffer.from([1]) })
  assert.equal(fourth._captureInit.serialNumber, 7, 'a stale report must not rewind the counter')
  assert.equal(second._captureInit.serialNumber, 4, 'earlier captures keep the value they were sent')
  fourth.close()
})

// OCR 评审修复（High）：复制是最常用的完成动作（Enter 走的就是 performAction('copy')），
// 而 capture:copy 是 7 个 handler 里唯一漏了 reportCaptureSerial 的 —— 落过序号再复制，
// 下一张仍从 1 开始，正是序号接续缺陷本身。录制/长截图同理（渲染层提前 return）。
test('every output path that consumes serials advances the counter, including copy and recording (P0-7-T7)', async () => {
  const harness = createHarness({ screenshot: { keepSerialAcrossCaptures: true } })
  const controller = harness.domain.createCaptureController()

  controller.copy({ sender: {} }, { imageBuffer: Buffer.from([1]), meta: { serialNumber: 5 } })
  const afterCopy = await harness.domain.createCaptureWindow({ mode: 'image', imageBuffer: Buffer.from([1]) })
  assert.equal(afterCopy._captureInit.serialNumber, 5, 'copy (the Enter path) must advance the serial')

  controller.startRegionRecording({ sender: {} }, { selectionBounds: { x: 0, y: 0, width: 32, height: 32 }, serialNumber: 9 })
    .catch(() => {})
  await new Promise((resolve) => setImmediate(resolve))
  const afterRecord = await harness.domain.createCaptureWindow({ mode: 'image', imageBuffer: Buffer.from([1]) })
  assert.equal(afterRecord._captureInit.serialNumber, 9, 'the recording entry returns before meta, so its payload carries the serial')

  controller.startLong({ sender: {} }, { selection: { x: 0, y: 0, w: 32, h: 32 }, serialNumber: 12 })
  const afterLong = await harness.domain.createCaptureWindow({ mode: 'image', imageBuffer: Buffer.from([1]) })
  assert.equal(afterLong._captureInit.serialNumber, 12, 'the long-capture entry carries the serial too')

  afterCopy.close()
  afterRecord.close()
  afterLong.close()
})

// OCR 评审修复：开关关闭时不推进计数，否则"先关后开"时首张启用截图不再从 1 开始。
test('a report while keepSerialAcrossCaptures is off does not advance the counter (P0-7-T7)', async () => {
  const harness = createHarness({ screenshot: { keepSerialAcrossCaptures: false } })
  const controller = harness.domain.createCaptureController()

  controller.save({ sender: {} }, { imageBuffer: Buffer.from([1]), meta: { serialNumber: 40 } })
  harness.settings.screenshot.keepSerialAcrossCaptures = true
  const first = await harness.domain.createCaptureWindow({ mode: 'image', imageBuffer: Buffer.from([1]) })
  assert.equal(first._captureInit.serialNumber, 1, 'turning the setting on starts fresh at 1, as the old implementation did')
  first.close()
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

// ---------------------------------------------------------------------------
// P0-2 / S9b: the captureCursor switch is the only thing that starts the cursor
// helper, and its absence/failure must never disturb the screenshot itself.
// ---------------------------------------------------------------------------

// mode:'region' 会走真正的抓屏分支（这正是"只有抓屏路径才查光标"要覆盖的路径），
// 所以补上 desktopCapturer 与能通过 isBlankCapture 的 nativeImage（thumbnail 与 nativeImage 同形）。
function regionCaptureDeps () {
  const thumbnail = {
    isEmpty: () => false,
    getSize: () => ({ width: 1, height: 1 }),
    resize: () => ({ toBitmap: () => Buffer.from([1, 2, 3, 4]) }),
    toPNG: () => Buffer.from([137, 80, 78, 71])
  }
  return {
    desktopCapturer: { getSources: async () => [{ id: 'screen:1', display_id: 1, thumbnail }] },
    nativeImage: {
      createFromBuffer: () => ({
        isEmpty: () => false,
        getSize: () => ({ width: 1, height: 1 }),
        resize: () => ({ toBitmap: () => Buffer.from([1, 2, 3, 4]) })
      })
    }
  }
}

function createCursorHarness (options = {}) {
  const queries = []
  const provider = {
    query: (queryOptions) => {
      queries.push(queryOptions)
      return Promise.resolve({
        showing: true,
        png: 'AAAA',
        dataUrl: 'data:image/png;base64,AAAA',
        width: 32,
        height: 32,
        hotspot: { x: 3, y: 9 },
        physicalPoint: { x: 320, y: 240 },
        at: 1,
        cached: false
      })
    },
    isAvailable: () => true,
    dispose: () => {}
  }
  const harness = createHarness({
    screenshot: options.screenshot || {},
    cursorProvider: provider,
    ...regionCaptureDeps()
  })
  harness.provider = provider
  harness.queries = queries
  return harness
}

test('the cursor is only queried when screenshot.captureCursor is on, and only as a fresh read (P0-2/S9b)', async () => {
  const offHarness = createCursorHarness()
  const off = await offHarness.domain.createCaptureWindow({ mode: 'region' })
  assert.equal(off._captureInit.cursor, null, 'the switch defaults to off, so the payload stays null')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(
    offHarness.queries.length,
    0,
    'switch off must not query the provider at all: query() is the only entry point that could spawn the helper'
  )

  const onHarness = createCursorHarness({ screenshot: { captureCursor: true } })
  const on = await onHarness.domain.createCaptureWindow({ mode: 'region' })
  assert.equal(onHarness.queries.length, 1, 'switch on queries exactly once, in parallel with the screen grab')
  assert.deepEqual(onHarness.queries[0], { fresh: true }, 'fresh:true is required or the provider replays a 250ms-old position')
  assert.deepEqual(on._captureInit.cursor, {
    png: 'AAAA',
    dataUrl: 'data:image/png;base64,AAAA',
    width: 32,
    height: 32,
    hotspot: { x: 3, y: 9 },
    physicalPoint: { x: 320, y: 240 }
  })

  // OCR 评审修复：只有"真的抓了屏幕"的路径才查光标。mode:'image'（贴图重新标注）与
  // mode:'canvas'（空白画布）的画面不是本次屏幕内容，贴此刻光标是杂散像素，且它们的
  // scaleFactor 是图像/编辑器比例而非显示缩放，落点无意义。
  for (const mode of ['image', 'canvas']) {
    const gatedHarness = createCursorHarness({ screenshot: { captureCursor: true } })
    const gated = await gatedHarness.domain.createCaptureWindow({ mode, imageBuffer: Buffer.from([1]) })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(gated._captureInit.cursor, null, `${mode} must not receive a cursor payload`)
    assert.equal(gatedHarness.queries.length, 0, `${mode} must not query the provider`)
    gated.close()
  }

  // An injected provider without the setting is still a no-op; and no provider with the
  // setting on must not throw.
  const noProvider = createHarness({ screenshot: { captureCursor: true }, ...regionCaptureDeps() })
  const noProviderWindow = await noProvider.domain.createCaptureWindow({ mode: 'region' })
  assert.equal(noProviderWindow._captureInit.cursor, null)

  off.close()
  on.close()
  noProviderWindow.close()
})

test('a cursor failure or timeout degrades to a null cursor without breaking the capture (P0-2/S9b)', async () => {
  const captureWith = async (provider) => {
    const harness = createHarness({ screenshot: { captureCursor: true }, cursorProvider: provider })
    const win = await harness.domain.createCaptureWindow({ mode: 'image', imageBuffer: Buffer.from([1]) })
    assert.equal(win._captureInit.cursor, null)
    assert.equal(Buffer.isBuffer(win._captureInit.imageBuffer), true, 'the screenshot payload is untouched')
    assert.equal(win._captureInit.imageBuffer.length, 1)
    assert.ok(win._captureInit.settings, 'the rest of the init payload still ships')
    win.close()
  }

  await captureWith({ query: () => { throw new Error('helper boom') } })
  await captureWith({ query: () => Promise.reject(new Error('helper boom')) })
  await captureWith({ query: () => Promise.resolve(null) })
  await captureWith(null)

  // A provider that never answers must be cut off by the ~120ms budget, not hold the window.
  const startedAt = Date.now()
  await captureWith({ query: () => new Promise(() => {}) })
  assert.ok(Date.now() - startedAt < 2000, 'the cursor budget must not hold the capture window hostage')
})
