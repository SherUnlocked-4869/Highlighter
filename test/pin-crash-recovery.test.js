// D05 (docs/reviews/2026-11-24-windows-product-architecture-review.md): the pin
// domain wiring contract for an abnormal renderer exit: retain, recover once,
// exhaust after three failures, and release immediately on a normal close.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const pinDomainSource = fs.readFileSync(path.join(root, 'main/domains/pin/index.js'), 'utf8')

const DATA_URL = 'data:image/png;base64,AA=='

function createClock(start = 1_000) {
  let current = start
  let sequence = 0
  const timers = new Map()
  return {
    now: () => current,
    setTimer: (fn, ms) => {
      const id = ++sequence
      timers.set(id, { fn, at: current + Math.max(0, Number(ms) || 0) })
      return id
    },
    clearTimer: (id) => timers.delete(id),
    advance(ms) {
      current += ms
      let guard = 0
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= current)
          .sort((left, right) => left[1].at - right[1].at)[0]
        if (!due) return
        timers.delete(due[0])
        due[1].fn()
        if (++guard > 1000) throw new Error('timer loop')
      }
    }
  }
}

async function waitFor(predicate, message = 'timed out waiting for pin image I/O', timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  if (predicate()) return
  assert.fail(message)
}

// A window fake with the three surfaces D05 touches: the 'close'/'closed' pair,
// destroy(), and the webContents render-process-gone listener. `crash()` replays
// exactly what Electron emits when the renderer process disappears.
function createFakeWindow(sends) {
  const listeners = new Map()
  let destroyed = false
  const win = {
    _pinData: null,
    _bounds: { x: 10, y: 20, width: 120, height: 80 },
    isDestroyed: () => destroyed,
    getBounds: () => ({ ...win._bounds }),
    setBounds: (bounds) => { win._bounds = { ...bounds } },
    setPosition: () => {},
    setContentSize: () => {},
    setAlwaysOnTop: () => {},
    setOpacity: () => {},
    setIgnoreMouseEvents: () => {},
    show: () => {},
    hide: () => {},
    moveTop: () => {},
    focus: () => {},
    loadFile: () => undefined,
    on: (event, callback) => {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(callback)
    },
    emit: (event) => {
      for (const callback of listeners.get(event) || []) callback()
    },
    destroy: () => {
      if (destroyed) return
      destroyed = true
      win.emit('closed')
    },
    close: () => {
      win.emit('close')
      win.destroy()
    },
    webContents: {
      isDestroyed: () => destroyed,
      send: (channel, payload) => sends.push({ win, channel, payload }),
      on: (event, callback) => {
        if (event === 'render-process-gone') win._rendererGone = callback
      }
    }
  }
  win.webContents.window = win
  win.crash = (details = { reason: 'crashed', exitCode: -1073741819 }) => {
    if (win._rendererGone) win._rendererGone({}, details)
  }
  return win
}

function createHarness({ failCreate = () => false, saveError = null, saveAnswer = undefined, timers = createClock() } = {}) {
  const handlers = new Map()
  const created = []
  const sends = []
  const changes = []
  const saves = []
  const { createPinDomain } = require('../main/domains/pin')
  const { createPinImageStore } = require('../main/services/pin-image-store')
  const pinImages = createPinImageStore()
  const domain = createPinDomain({
    BrowserWindow: { fromWebContents: (sender) => sender?.window || null },
    clipboard: { writeImage: () => {} },
    nativeImage: {
      createFromBuffer: () => ({
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
      if (failCreate(created.length)) throw new Error('window creation failed')
      const win = createFakeWindow(sends)
      created.push(win)
      return win
    },
    getSettings: () => ({
      fixedContent: { opacity: 1, zoomWithMouse: true },
      plugins: { ocr: true },
      pinned: {}
    }),
    saveImageBuffer: async (buffer) => {
      if (saveError) throw saveError
      if (saveAnswer !== undefined) return saveAnswer
      saves.push(buffer)
      return 'saved'
    },
    createRecognitionWindow: () => {},
    recognizePin: undefined,
    pinImages,
    getCreateCaptureWindow: () => async () => null,
    log: () => {},
    now: timers.now,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    onRecoverableChange: (list, change) => changes.push({ list: [...list], change }),
    ipcMain: { on: (channel, handler) => handlers.set(channel, handler) }
  })
  return { domain, handlers, created, sends, changes, saves, pinImages, timers }
}

test('an abnormal renderer exit keeps the pin image recoverable instead of dropping it', async () => {
  const { domain, pinImages, changes } = createHarness()
  const win = domain.createPinWindow(Buffer.from([1, 2, 3]), {})
  const imageId = win._pinData.imageId

  win.crash({ reason: 'crashed', exitCode: -1073741819 })
  assert.equal(win.isDestroyed(), true, 'the dead window is destroyed')
  assert.equal(domain.getPinnedCount(), 0)

  const list = domain.getRecoverablePins()
  assert.equal(list.length, 1)
  assert.equal(list[0].reason, 'crashed')
  assert.equal(list[0].attempts, 0)
  assert.equal(list[0].exhausted, false)
  assert.equal(Object.hasOwn(list[0], 'imageId'), false, 'the tray-facing list must not leak pixels')

  // The retained reference keeps the existing store entry alive.
  assert.deepEqual((await pinImages.read(imageId)).bytes, Buffer.from([1, 2, 3]))
  assert.equal(pinImages.stats().assets, 1)
  assert.equal(changes.filter(({ change }) => change.kind === 'retained').length, 1)
})

test('a normal close releases the image immediately and creates no recoverable entry', async () => {
  const { domain, pinImages } = createHarness()
  const win = domain.createPinWindow(Buffer.from([4, 5]), {})
  const imageId = win._pinData.imageId

  win.close()
  assert.equal(domain.getRecoverablePins().length, 0)
  assert.equal(pinImages.stats().assets, 0)
  await assert.rejects(pinImages.read(imageId), /已释放/)
})

test('recovery rebuilds the pin with the retained image and re-sends the pixels', async () => {
  const { domain, handlers, created, sends, pinImages } = createHarness()
  const win = domain.createPinWindow(Buffer.from([7, 8, 9]), {})
  const imageId = win._pinData.imageId
  const bounds = win.getBounds()
  win.crash()

  const ticketId = domain.getRecoverablePins()[0].id
  const result = await domain.recoverPin(ticketId)
  assert.equal(result.status, 'recovered')
  assert.equal(created.length, 2, 'exactly one replacement window')
  assert.equal(result.window._pinData.imageId, imageId, 'the retained store entry is re-used, not copied')
  assert.deepEqual(result.window.getBounds(), bounds)
  assert.equal(domain.getRecoverablePins().length, 0)
  assert.equal(pinImages.stats().assets, 1, 'recovery does not double the image')

  handlers.get('pin:ready')({ sender: result.window.webContents })
  await waitFor(() => sends.length === 1)
  assert.equal(sends[0].channel, 'pin:init')
  assert.deepEqual(sends[0].payload.imageBuffer, Buffer.from([7, 8, 9]))
  assert.equal(Object.hasOwn(sends[0].payload, 'imageId'), false)

  // Closing the recovered window returns to the baseline.
  result.window.close()
  assert.equal(pinImages.stats().assets, 0)
  await assert.rejects(pinImages.read(imageId), /已释放/)
})

test('three failed rebuilds stop the automatic path but keep save/discard available', async () => {
  let fail = false
  const { domain, created, saves, pinImages } = createHarness({ failCreate: () => fail })
  const win = domain.createPinWindow(Buffer.from([10]), {})
  win.crash()
  const ticketId = domain.getRecoverablePins()[0].id
  fail = true

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = await domain.recoverPin(ticketId)
    assert.equal(result.status, 'failed')
    assert.equal(result.code, 'SAVE_OR_DISCARD')
    assert.equal(result.reason, 'RECOVERY_FAILED')
    assert.equal(result.attempts, attempt)
    assert.equal(result.exhausted, attempt === 3)
  }

  const blocked = await domain.recoverPin(ticketId)
  assert.equal(blocked.status, 'failed')
  assert.equal(blocked.code, 'SAVE_OR_DISCARD')
  assert.equal(blocked.reason, 'ATTEMPTS_EXHAUSTED')
  assert.equal(blocked.retryable, false)
  assert.equal(created.length, 1, 'no rebuild loop: no further window is created')
  assert.equal(domain.getRecoverablePins()[0].exhausted, true)

  // "Save or discard" remains available and saving releases the ticket.
  const saved = await domain.saveRecoverablePin(ticketId)
  assert.equal(saved.status, 'saved')
  assert.deepEqual(saves, [Buffer.from([10])])
  assert.equal(domain.getRecoverablePins().length, 0)
  assert.equal(pinImages.stats().assets, 0)
})

test('a failed save keeps the ticket so the user can retry or discard', async () => {
  const { domain, pinImages } = createHarness({ saveError: new Error('disk full') })
  const win = domain.createPinWindow(Buffer.from([11]), {})
  win.crash()
  const ticketId = domain.getRecoverablePins()[0].id

  const result = await domain.saveRecoverablePin(ticketId)
  assert.deepEqual(result, { status: 'failed', code: 'SAVE_FAILED' })
  assert.equal(domain.getRecoverablePins().length, 1)
  assert.equal(pinImages.stats().assets, 1)
})

test('discarding a recoverable pin releases the image without a window', async () => {
  const { domain, pinImages } = createHarness()
  const win = domain.createPinWindow(Buffer.from([12]), {})
  win.crash()
  const ticketId = domain.getRecoverablePins()[0].id

  assert.equal(domain.discardRecoverablePin(ticketId).status, 'discarded')
  assert.equal(domain.getRecoverablePins().length, 0)
  assert.equal(pinImages.stats().assets, 0)
  assert.equal(domain.discardRecoverablePin(ticketId).status, 'failed')
})

test('the domain releases a retained pin when its TTL expires', async () => {
  const timers = createClock()
  const { domain, pinImages } = createHarness({ timers })
  const win = domain.createPinWindow(Buffer.from([13]), {})
  const imageId = win._pinData.imageId
  win.crash()
  assert.equal(domain.getRecoverablePins().length, 1)

  timers.advance(5 * 60 * 1000 + 1)
  assert.equal(domain.getRecoverablePins().length, 0)
  assert.equal(pinImages.stats().assets, 0)
  await assert.rejects(pinImages.read(imageId), /已释放/)
})

test('a crash that would exceed the 20 pin budget is not retained', async () => {
  const { domain, pinImages } = createHarness()
  const pins = []
  for (let index = 0; index < 20; index += 1) {
    pins.push(domain.createPinWindow(Buffer.from([index + 1]), {}))
  }
  pins[0].crash()
  assert.equal(domain.getRecoverablePins().length, 1)

  // 19 live pins + 1 retained = the existing 20 pin envelope. A refilled 20th
  // pin that crashes again cannot add a second retained image.
  const extra = domain.createPinWindow(Buffer.from([99]), {})
  const extraId = extra._pinData.imageId
  extra.crash()
  assert.equal(domain.getRecoverablePins().length, 1)
  assert.equal(pinImages.stats().assets, 20)
  await assert.rejects(pinImages.read(extraId), /已释放/)
})

test('a renderer-gone event during a user close is ignored, never retained', () => {
  const { domain, pinImages } = createHarness()
  const win = domain.createPinWindow(Buffer.from([14]), {})
  win.emit('close')
  win.crash()
  assert.equal(domain.getRecoverablePins().length, 0)
  win.destroy()
  assert.equal(pinImages.stats().assets, 0)
})

test('a second crash event on the same dead window cannot stack tickets', () => {
  const { domain } = createHarness()
  const win = domain.createPinWindow(Buffer.from([15]), {})
  win.crash()
  assert.equal(domain.getRecoverablePins().length, 1)
  win.crash()
  assert.equal(domain.getRecoverablePins().length, 1)
})

test('the pin domain wires the crash listener through the resilience policy', () => {
  assert.match(pinDomainSource, /require\('\.\.\/\.\.\/services\/window-resilience'\)/)
  assert.match(pinDomainSource, /webContents\.on\?\.\('render-process-gone'/)
  assert.match(pinDomainSource, /handlePinRendererGone\(win, details\)/)
  assert.match(pinDomainSource, /getRecoverablePins,/)
  assert.match(pinDomainSource, /recoverPin,/)
  assert.match(pinDomainSource, /saveRecoverablePin,/)
  assert.match(pinDomainSource, /discardRecoverablePin,/)
  assert.match(pinDomainSource, /'SAVE_OR_DISCARD'/)
  // The normal close path keeps releasing the domain's own reference.
  assert.match(pinDomainSource, /pinImages\.release\(win\._pinData\?\.imageId\)/)
})

// ---------------------------------------------------------------------------
// D05 (plan item 18): the tray-facing recovery payload and the save-cancel rule.
// ---------------------------------------------------------------------------

test('D05 (18): a cancelled save dialog keeps the retained pin for a retry', async () => {
  // The host's save flow answers null when the user dismisses the dialog.
  const harness = createHarness({ saveAnswer: null })
  const { domain, pinImages, changes } = harness
  const win = domain.createPinWindow(Buffer.from([1, 2, 3]), {})
  const imageId = win._pinData.imageId
  win.crash()
  const ticketId = domain.getRecoverablePins()[0].id

  const result = await domain.saveRecoverablePin(ticketId)
  assert.equal(result.status, 'cancelled')
  assert.equal(result.code, 'SAVE_CANCELLED')
  // The ticket and its pixels are still there: the only copy of that pin was not released.
  assert.equal(domain.getRecoverablePins().length, 1)
  assert.deepEqual((await pinImages.read(imageId)).bytes, Buffer.from([1, 2, 3]))
  assert.equal(changes.at(-1).change.kind, 'retained', 'a cancel is not a save notification')

  // A second attempt that really saves still works and releases once.
  const saving = createHarness()
  const savedWin = saving.domain.createPinWindow(Buffer.from([4, 5]), {})
  savedWin.crash()
  const saved = await saving.domain.saveRecoverablePin(saving.domain.getRecoverablePins()[0].id)
  assert.equal(saved.status, 'saved')
  assert.equal(saving.domain.getRecoverablePins().length, 0)
})

test('D05 (18): the tray payload carries the retained pins and real actions', async () => {
  const harness = createHarness()
  const { domain } = harness
  const win = domain.createPinWindow(Buffer.from([9, 9, 9]), {})
  win.crash({ reason: 'crashed' })

  const payload = domain.trayRecoveryMenu()
  assert.equal(payload.items.length, 1)
  const item = payload.items[0]
  assert.equal(item.index, 1)
  assert.equal(item.reason, 'crashed')
  assert.equal(item.canRetry, true)
  assert.equal(Object.hasOwn(item, 'imageId'), false, 'the tray payload never carries pixels')
  assert.equal(typeof payload.actions.recover, 'function')
  assert.equal(typeof payload.actions.save, 'function')
  assert.equal(typeof payload.actions.discard, 'function')

  // Discard through the payload action clears the entry and notifies the host.
  const discarded = payload.actions.discard(item.id)
  assert.equal(discarded.status, 'discarded')
  assert.equal(domain.getRecoverablePins().length, 0)
  assert.equal(harness.changes.at(-1).change.kind, 'discarded')
})

test('D05 (18): an exhausted ticket keeps its entry, and restore is not offered', async () => {
  // The first window is created normally; every REBUILD fails.
  const harness = createHarness({ failCreate: (index) => index > 0 })
  const { domain } = harness
  const win = domain.createPinWindow(Buffer.from([1]), {})
  win.crash()
  const ticketId = domain.getRecoverablePins()[0].id
  // Three failed rebuilds exhaust the ticket (the existing policy).
  for (let attempt = 0; attempt < 3; attempt += 1) await domain.recoverPin(ticketId)
  const payload = domain.trayRecoveryMenu()
  assert.equal(payload.items.length, 1, 'the entry survives so it can still be saved or discarded')
  assert.equal(payload.items[0].exhausted, true)
  assert.equal(payload.items[0].canRetry, false)
})

test('D05 (18): a recovered private pin keeps its do-not-keep flag and its layout', async () => {
  const harness = createHarness()
  const { domain, created } = harness
  const win = domain.createPinWindow(Buffer.from([7, 7, 7]), { skipHistory: true, selectionBounds: { x: 10, y: 20, width: 120, height: 80 } })
  assert.equal(win._skipHistory, true, 'the meta carries the private flag into the window')
  const bounds = win.getBounds()
  win.crash()
  const ticketId = domain.getRecoverablePins()[0].id
  const result = await domain.recoverPin(ticketId)
  assert.equal(result.status, 'recovered')
  assert.equal(result.window._skipHistory, true, 'the recovered pin is still private')
  assert.deepEqual(result.window.getBounds(), bounds, 'the layout is restored')
  assert.equal(created.length, 2)
})
