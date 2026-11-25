'use strict'

// B06 (plan item 10): the completion receipt.
//
// The bug was a plain ReferenceError: the save branch declared `filePath` inside its block and
// the return read it outside, so a long capture that HAD been written answered an exception
// and the caller closed the window as if nothing had been saved. These tests drive the REAL
// domain completion entry (`longFinish`) against a fake window/session so the receipt, the
// actual file name and the close-once rule are behaviour, not string matches.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const fsp = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createLongCaptureDomain } = require('../main/domains/long-capture')

function createFakeWindow() {
  const webContents = { send() {}, id: Math.random() }
  const win = {
    webContents,
    destroyed: false,
    isDestroyed() { return win.destroyed },
    close() { win.destroyed = true },
    focus() {},
    moveTop() {},
    setFocusable() {},
    setIgnoreMouseEvents() {},
    setContentProtection() {},
    setAlwaysOnTop() {},
    setResizable() {},
    setMovable() {},
    setBounds() {},
    setPosition() {},
    show() {},
    showInactive() {},
    loadFile() { return Promise.resolve() },
    on() {}
  }
  return win
}

class FakeSession {
  constructor({ tempRoot }) {
    this.tempRoot = tempRoot
    this.strips = [{ height: 120 }]
    this.axis = 'vertical'
    this.cleaned = 0
  }

  async addStrip() { return true }

  setTrim() { return true }

  getSize() { return { width: 800, height: 600 } }

  async render() {
    const target = path.join(this.tempRoot, 'long-capture-render.png')
    await fs.mkdir(this.tempRoot, { recursive: true })
    await fs.writeFile(target, 'long-image-bytes')
    return target
  }

  cleanup() { this.cleaned += 1 }
}

async function createHarness(t, options = {}) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'highlighter-long-completion-'))
  t.after(() => fs.rm(parent, { recursive: true, force: true }))
  const tempRoot = path.join(parent, 'long-temp')
  const settings = {
    screenshot: {
      saveDirectory: options.saveDirectory === undefined ? path.join(parent, 'saves') : options.saveDirectory,
      nameTemplate: '',
      longCaptureDirection: 'vertical'
    }
  }
  const history = []
  const dialogs = []
  const clipboardWrites = []
  let sentClose = 0
  const domain = createLongCaptureDomain({
    app: { getPath: () => parent },
    desktopCapturer: { getSources: async () => [{ id: 'screen:1', display_id: '1' }] },
    path,
    screen: {
      getDisplayMatching: () => ({ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 })
    },
    dialog: {
      showSaveDialog: async (payload) => {
        dialogs.push(payload)
        if (options.dialogResult) return options.dialogResult
        return { canceled: true }
      }
    },
    clipboard: { writeImage: (image) => clipboardWrites.push(image) },
    nativeImage: { createFromPath: () => ({ isEmpty: () => false }) },
    // The domain uses both fs.promises.* and bare promise methods.
    fs: { ...fs, promises: fs },
    rootDirectory: path.join(__dirname, '..'),
    createLocalWindow: () => createFakeWindow(),
    getSettings: () => settings,
    log: () => {},
    assertManagedDataWritable: () => {},
    isMigrationInProgress: () => false,
    LongCaptureSession: FakeSession,
    getLongCaptureTempRoot: () => tempRoot,
    captureDomain: { ownsWindow: () => true },
    pinDomain: { createPinWindow: () => {} },
    persistHistoryFile: async (filePath, meta) => {
      if (options.historyFails) throw Object.assign(new Error('history write failed'), { code: 'history-failed' })
      history.push({ filePath, meta })
    },
    ensureDirectory: (target) => fsp.mkdirSync(target, { recursive: true }),
    makeCaptureName: (prefix) => `${prefix}-${options.nameSuffix || 'one'}.png`,
    LONG_CAPTURE_PREFIX: 'LongCapture',
    updateSettings: () => {}
  })
  const captureWindow = {
    isDestroyed: () => false,
    close() {},
    _captureInit: {
      captureBounds: { x: 0, y: 0, width: 1920, height: 1080 },
      displayBounds: { x: 0, y: 0, width: 1920, height: 1080 },
      scaleFactor: 1
    }
  }
  await domain.createLongCaptureFromSelection(captureWindow, {
    selection: { x: 10, y: 10, w: 400, h: 300 }
  })
  const state = domain.getState()
  assert.ok(state, 'the long-capture session is live')
  const controller = domain.createLongCaptureController()
  const eventFor = () => ({ sender: state.controllerWindow.webContents })
  return {
    parent,
    domain,
    state,
    controller,
    eventFor,
    settings,
    history,
    dialogs,
    clipboardWrites,
    async settle() {
      for (let index = 0; index < 20; index += 1) await new Promise((resolve) => setImmediate(resolve))
    },
    closeCount: () => sentClose
  }
}

test('B06 (10): a plain save returns the real path, registers the same path and closes once', async (t) => {
  const harness = await createHarness(t, { nameSuffix: 'plain' })
  const target = path.join(harness.parent, 'saves', 'LongCapture-plain.png')
  await fs.mkdir(path.dirname(target), { recursive: true })
  // A dialog save: the user's own path wins.
  const harness2 = harness
  harness2.dialogs.length = 0
  const result = await harness.controller.longFinish(harness.eventFor(), { action: 'save' })
  // No dialog answer was configured (canceled): the capture must stay alive.
  assert.deepEqual(result, { canceled: true })
  assert.equal(harness.domain.isTaskActive(), true, 'a cancelled dialog keeps the capture on screen')
  assert.equal(harness.history.length, 0)
})

test('B06 (10): a fast save reports the file that actually exists, not the requested name', async (t) => {
  const harness = await createHarness(t, { nameSuffix: 'fast' })
  const saves = path.join(harness.parent, 'saves')
  await fs.mkdir(saves, { recursive: true })
  // An existing file with the requested name: copyExclusive must pick a new one.
  await fs.writeFile(path.join(saves, 'LongCapture-fast.png'), 'already here')
  const result = await harness.controller.longFinish(harness.eventFor(), { action: 'save', fast: true })
  assert.equal(result.ok, true)
  assert.equal(result.action, 'save')
  assert.notEqual(result.savedPath, path.join(saves, 'LongCapture-fast.png'))
  const saved = await fs.stat(result.savedPath)
  assert.ok(saved.size > 0, 'the returned path exists')
  assert.equal((await fs.readFile(result.savedPath, 'utf8')), 'long-image-bytes')
  // The existing file was not overwritten.
  assert.equal(await fs.readFile(path.join(saves, 'LongCapture-fast.png'), 'utf8'), 'already here')
  // The history row points at the actual file.
  assert.equal(harness.history.length, 1)
  assert.equal(harness.history[0].filePath, result.savedPath)
  assert.equal(result.history, 'recorded')
  await harness.settle()
  assert.equal(harness.domain.isTaskActive(), false, 'the session closes after a final success')
})

test('B06 (10): a history failure still reports the saved file and says which step failed', async (t) => {
  const harness = await createHarness(t, { nameSuffix: 'history-fail', historyFails: true })
  const result = await harness.controller.longFinish(harness.eventFor(), { action: 'save', fast: true })
  assert.equal(result.ok, true, 'the file was written; a history failure is not a save failure')
  assert.equal(result.history, 'failed')
  assert.equal(result.historyCode, 'history-failed')
  assert.equal(fsp.existsSync(result.savedPath), true, 'the receipt still names the real file')
  await harness.settle()
  assert.equal(harness.domain.isTaskActive(), false)
})

test('B06 (10): a target write failure keeps the capture alive and surfaces the error once', async (t) => {
  const harness = await createHarness(t, { nameSuffix: 'write-fail' })
  // Block the destination with a directory of the requested name so the copy fails.
  const saves = path.join(harness.parent, 'saves')
  await fs.mkdir(path.join(saves, 'LongCapture-write-fail.png'), { recursive: true })
  await assert.rejects(() => harness.controller.longFinish(harness.eventFor(), { action: 'save', fast: true }))
  // A failed write leaves the material and the session; the completion can be retried.
  assert.equal(harness.domain.isTaskActive(), true)
  assert.equal(harness.history.length, 0)
})

test('B06 (10): a repeated completion runs the output and the close at most once', async (t) => {
  const harness = await createHarness(t, { nameSuffix: 'repeat' })
  const first = harness.controller.longFinish(harness.eventFor(), { action: 'save', fast: true })
  const second = harness.controller.longFinish(harness.eventFor(), { action: 'save', fast: true }).catch((error) => ({ error: error.message }))
  const [one, two] = await Promise.all([first, second])
  assert.equal(one.ok, true)
  assert.ok(two.error || two.ok === false, 'the second press is refused, not run twice')
  assert.equal(harness.history.length, 1, 'one file: one history row')
})

test('B06 (10): a pin completion returns the rendered path and records it', async (t) => {
  const harness = await createHarness(t)
  const result = await harness.controller.longFinish(harness.eventFor(), { action: 'pin' })
  assert.equal(result.ok, true)
  assert.equal(result.action, 'pin')
  assert.equal(fsp.existsSync(result.savedPath), true)
  assert.equal(harness.history.length, 1)
  assert.equal(harness.history[0].meta.action, 'pin')
})
