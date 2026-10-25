'use strict'

// Feature A/B integration contracts (docs/plans/2026-10-25-snow-apps-feature-development-plan.md
// §4.2/§5.2). These cover the layer between the IPC transport and the services: who may act on an
// export result, how a display becomes a region descriptor, and how the renderer-facing result bar
// behaves. Each module is pure enough to test in plain node (no Electron, no jsdom).

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  ACTIONS,
  createExportActionResultController
} = require('../main/ipc/export-action-controller')
const {
  createDisplayProvider,
  createRegionController,
  describeDisplay,
  toPublicPreferences
} = require('../main/ipc/region-ipc-controller')
const { createExportResultService } = require('../main/services/export-result-service')
const { createExportResultBar, LOCALE_KEYS } = require('../capture/export-result-bar')

function scratchDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'highlighter-feature-contract-'))
  return {
    directory,
    write(name, contents = 'x') {
      const file = path.join(directory, name)
      fs.writeFileSync(file, contents)
      return file
    },
    dispose() {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  }
}

// A fake transport: one window owns one fake WebContents whose `id` is the owner identity.
function createFakeWindows() {
  const windows = []
  const BrowserWindow = {
    fromWebContents(sender) {
      const found = windows.find((entry) => entry.webContents === sender)
      return found ? found.window : null
    }
  }
  function open(id) {
    const listeners = new Map()
    const webContents = { id }
    webContents.once = (event, listener) => listeners.set(event, listener)
    webContents.removeListener = (event, listener) => {
      if (listeners.get(event) === listener) listeners.delete(event)
    }
    const window = {
      destroyed: false,
      // The controller resolves the sender's owner id via `win.webContents`, so the fake window has
      // to expose the same WebContents it was opened with.
      webContents,
      isDestroyed() {
        return this.destroyed
      },
      destroy() {
        this.destroyed = true
        const listener = listeners.get('destroyed')
        listeners.delete('destroyed')
        listener?.()
      }
    }
    windows.push({ window, webContents })
    return { window, webContents, destroy: () => window.destroy() }
  }
  return { BrowserWindow, open }
}

function fakeShell(overrides = {}) {
  const calls = []
  return {
    calls,
    openPath: async (target) => {
      calls.push(['openPath', target])
      return overrides.openPathError || ''
    },
    showItemInFolder: (target) => { calls.push(['showItemInFolder', target]) }
  }
}

function fakeClipboard() {
  const written = []
  return { written, writeText: (value) => { written.push(value) } }
}

// ---------------------------------------------------------------------------
// export:perform-action - sender attribution
// ---------------------------------------------------------------------------

test('the export action controller attributes a sender to a WebContents-scoped owner', () => {
  const scratch = scratchDirectory()
  try {
    const file = scratch.write('shot.png')
    const service = createExportResultService({
      fs,
      path,
      shell: fakeShell(),
      clipboard: fakeClipboard(),
      log: () => {}
    })
    const { BrowserWindow, open } = createFakeWindows()
    const controller = createExportActionResultController({ service, BrowserWindow })
    const owner = open(41)
    const stranger = open(42)

    const receipt = service.register({ filePath: file, kind: 'png', ownerId: controller.ownerIdFor(owner.webContents) })
    assert.equal(receipt.status, 'saved')

    // The registering window may act; another live window may not.
    return (async () => {
      const own = await controller.performAction({ sender: owner.webContents }, { resultId: receipt.resultId, action: 'copy-path' })
      assert.deepEqual(own, { status: 'done' })
      const forged = await controller.performAction({ sender: stranger.webContents }, { resultId: receipt.resultId, action: 'open' })
      assert.equal(forged.status, 'failed')
      assert.equal(forged.code, 'invalid-owner')
    })()
  } finally {
    scratch.dispose()
  }
})

test('the export action controller validates the payload instead of forwarding it', async () => {
  const scratch = scratchDirectory()
  try {
    const file = scratch.write('shot.png')
    const service = createExportResultService({
      fs,
      path,
      shell: fakeShell(),
      clipboard: fakeClipboard(),
      log: () => {}
    })
    const { BrowserWindow, open } = createFakeWindows()
    const controller = createExportActionResultController({ service, BrowserWindow })
    const owner = open(7)
    const receipt = service.register({ filePath: file, kind: 'png', ownerId: controller.ownerIdFor(owner.webContents) })
    const event = { sender: owner.webContents }

    // A path smuggled in the payload is ignored: only resultId + a known action survive.
    const withPath = await controller.performAction(event, {
      resultId: receipt.resultId,
      action: 'copy-path',
      filePath: 'C:\\Windows\\System32\\evil.exe'
    })
    assert.deepEqual(withPath, { status: 'done' })
    assert.equal((await controller.performAction(event, { resultId: receipt.resultId, action: 'rm -rf' })).code, 'unknown-action')
    assert.equal((await controller.performAction(event, { resultId: '', action: 'open' })).code, 'result-expired')
    assert.equal((await controller.performAction(event, { resultId: 'x'.repeat(2000), action: 'open' })).code, 'result-expired')
    // A sender that cannot be attributed fails closed.
    assert.equal((await controller.performAction({ sender: { id: 'nope' } }, { resultId: receipt.resultId, action: 'open' })).code, 'invalid-owner')
    assert.deepEqual(ACTIONS, ['open', 'copy-path', 'reveal'])
  } finally {
    scratch.dispose()
  }
})

test('destroying a window revokes only its own result references', async () => {
  const scratch = scratchDirectory()
  try {
    const fileA = scratch.write('a.png')
    const fileB = scratch.write('b.png')
    const service = createExportResultService({
      fs,
      path,
      shell: fakeShell(),
      clipboard: fakeClipboard(),
      log: () => {}
    })
    const { BrowserWindow, open } = createFakeWindows()
    const controller = createExportActionResultController({ service, BrowserWindow })
    const first = open(1)
    const second = open(2)
    const disposers = [controller.trackWindow(first.window), controller.trackWindow(second.window)]
    const receiptA = service.register({ filePath: fileA, kind: 'png', ownerId: controller.ownerIdFor(first.webContents) })
    const receiptB = service.register({ filePath: fileB, kind: 'png', ownerId: controller.ownerIdFor(second.webContents) })

    first.destroy()
    // list() is newest-first, so compare as a set: exactly the survivor remains.
    assert.deepEqual(service.list().map((entry) => entry.resultId), [receiptB.resultId], 'only the destroyed window loses its references')
    assert.equal((await controller.performAction({ sender: second.webContents }, { resultId: receiptB.resultId, action: 'copy-path' })).status, 'done')
    // The disposer is safe after the fact and stops listening.
    for (const dispose of disposers) dispose()
  } finally {
    scratch.dispose()
  }
})

// ---------------------------------------------------------------------------
// region IPC controller - display descriptor + renderer projection
// ---------------------------------------------------------------------------

function fakeElectronDisplay({ id, bounds, scaleFactor, nativeSize }) {
  return {
    id,
    bounds,
    scaleFactor,
    // dipToScreenRect is injected straight from Electron's screen module in production.
    nativeSize
  }
}

test('describeDisplay measures the pixel size instead of assuming scaleFactor', () => {
  const display = fakeElectronDisplay({
    id: 3,
    bounds: { x: -1920, y: 0, width: 1920, height: 1080 },
    scaleFactor: 1.5,
    nativeSize: { width: 3072, height: 1728 }
  })
  const descriptor = describeDisplay(display, () => display.nativeSize)
  assert.equal(descriptor.key, '3')
  assert.deepEqual(descriptor.boundsDip, { x: -1920, y: 0, width: 1920, height: 1080 })
  // Measured from the native rect, which is what a mixed-DPI desktop really reports.
  assert.deepEqual(descriptor.pixelSize, { width: 3072, height: 1728 })
  assert.equal(descriptor.scaleFactor, 1.5)

  // Without a native rect probe the scaleFactor fallback is used, so a test host still works.
  const fallback = describeDisplay(display, null)
  assert.deepEqual(fallback.pixelSize, { width: 2880, height: 1620 })

  // A histogram with no usable geometry is skipped, not guessed.
  assert.equal(describeDisplay({ id: 1, bounds: { x: 0, y: 0, width: 0, height: 0 } }, null), null)
  assert.equal(describeDisplay(null, null), null)
})

test('the display provider puts the display under the cursor first (v1 is single-display)', () => {
  const primary = fakeElectronDisplay({ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1, nativeSize: { width: 1920, height: 1080 } })
  const secondary = fakeElectronDisplay({ id: 2, bounds: { x: 1920, y: 0, width: 1280, height: 1024 }, scaleFactor: 1, nativeSize: { width: 1280, height: 1024 } })
  const screen = {
    getAllDisplays: () => [primary, secondary],
    getDisplayNearestPoint: () => secondary
  }
  const getDisplays = createDisplayProvider({ screen, dipToScreenRect: null, getCursorPoint: () => ({ x: 2000, y: 100 }) })
  const displays = getDisplays()
  assert.deepEqual(displays.map((entry) => entry.key), ['2', '1'], 'the current display must be first: presets resolve against displays[0]')
})

test('the region controller projects preferences without leaking stored desktop geometry', () => {
  const preferences = {
    read: () => ({
      schemaVersion: 1,
      lastByMode: {
        capture: { displayKey: '1', displayBoundsDip: { x: 0, y: 0, width: 100, height: 100 }, displayPixelSize: { width: 100, height: 100 }, rectDisplayPx: { x: 5, y: 6, width: 7, height: 8 }, capturedScaleFactor: 1 },
        record: null
      },
      presets: [{ id: 'p1', name: '1080p', widthPx: 1920, heightPx: 1080 }]
    }),
    resolveInput: () => ({ ok: false, code: 'no-last-region' }),
    savePreset: () => ({ ok: false, code: 'invalid-preset' }),
    deletePreset: () => ({ ok: false, code: 'not-found' })
  }
  const controller = createRegionController({
    preferences,
    limits: { MAX_PRESETS: 20, MAX_NAME_LENGTH: 40, MIN_EDGE_PX: 16, MAX_EDGE_PX: 10000 }
  })
  const snapshot = controller.getPreferences()
  assert.equal(snapshot.ok, true)
  assert.deepEqual(snapshot.presets, [{ id: 'p1', name: '1080p', widthPx: 1920, heightPx: 1080 }])
  // Only "is there one?" reaches the renderer - the remembered desktop rect stays in the main process.
  assert.deepEqual(snapshot.lastAvailable, { capture: true, record: false })
  assert.equal(snapshot.lastByMode, undefined)
  assert.equal(snapshot.limits.maxPresets, 20)
  assert.equal(JSON.stringify(snapshot).includes('rectDisplayPx'), false)

  // The reduce helper is also exercised directly.
  assert.deepEqual(toPublicPreferences({ lastByMode: {}, presets: [] }, {}).presets, [])
})

test('the region controller returns DIP rects and forwards the adjusted reason', () => {
  const resolved = {
    ok: true,
    rectDisplayPx: { x: 20, y: 40, width: 200, height: 100 },
    rectDip: { x: 10.4, y: 20.6, width: 100.4, height: 50.4 },
    displayKey: '2',
    appliedPixelSize: { width: 200, height: 100 },
    adjusted: [{ code: 'clamped-to-screen', requestedPixelSize: { width: 400, height: 100 }, appliedPixelSize: { width: 200, height: 100 } }]
  }
  const preferences = {
    read: () => ({ schemaVersion: 1, lastByMode: { capture: null, record: null }, presets: [] }),
    resolveInput: () => resolved,
    savePreset: () => ({ ok: true, preset: { id: 'p2', name: 'n', widthPx: 200, heightPx: 100 } }),
    deletePreset: () => ({ ok: true })
  }
  const controller = createRegionController({ preferences, limits: {} })
  const result = controller.resolve(null, { mode: 'capture', presetId: 'p1' })
  assert.equal(result.ok, true)
  // The renderer draws in CSS px, so the DIP rect is what crosses the wire - rounded to integers.
  assert.deepEqual(result.rect, { x: 10, y: 21, width: 100, height: 50 })
  assert.deepEqual(result.adjusted, resolved.adjusted)
  assert.equal(result.displayKey, '2')
  assert.deepEqual(result.pixelSize, { width: 200, height: 100 })

  // Invalid input is refused with a code, never coerced.
  assert.equal(controller.resolve(null, {}).code, 'invalid-mode')
  assert.equal(controller.resolve(null, { mode: 'capture' }).code, 'invalid-input')
  assert.equal(controller.resolve(null, { mode: 'record', last: true }).ok, true)
  assert.equal(controller.savePreset(null, { name: '', widthPx: 1, heightPx: 1 }).code, 'invalid-preset')
  assert.equal(controller.savePreset(null, { name: 'x', widthPx: 'abc', heightPx: 1 }).code, 'invalid-preset')
  assert.equal(controller.savePreset(null, { name: 'x', widthPx: 200, heightPx: 100 }).ok, true)
  assert.equal(controller.deletePreset(null, {}).code, 'not-found')
  assert.equal(controller.deletePreset(null, { id: 'p' }).ok, true)
})

test('a service failure in the region controller becomes a code, not a throw', () => {
  const controller = createRegionController({
    preferences: {
      read: () => { throw new Error('boom') },
      resolveInput: () => { throw new Error('boom') },
      savePreset: () => { throw new Error('boom') },
      deletePreset: () => { throw new Error('boom') }
    },
    limits: {},
    log: () => {}
  })
  assert.equal(controller.getPreferences().code, 'unavailable')
  assert.equal(controller.resolve(null, { mode: 'capture', last: true }).code, 'unavailable')
  assert.equal(controller.savePreset(null, { name: 'x', widthPx: 100, heightPx: 100 }).code, 'unavailable')
  assert.equal(controller.deletePreset(null, { id: 'x' }).code, 'unavailable')
})

// ---------------------------------------------------------------------------
// capture/export-result-bar.js - the renderer result bar
// ---------------------------------------------------------------------------

// The smallest DOM the bar touches. Deliberately hand-rolled: the bar must not depend on a browser
// environment to be testable, and adding jsdom for six elements would be a poor trade.
function createFakeDocument() {
  function createElement(tagName) {
    const classes = new Set()
    const children = []
    const listeners = new Map()
    const element = {
      tagName: String(tagName).toUpperCase(),
      id: '',
      className: '',
      textContent: '',
      dataset: {},
      children,
      isConnected: true,
      parentNode: null,
      classList: {
        add: (...names) => names.forEach((name) => classes.add(name)),
        remove: (...names) => names.forEach((name) => classes.delete(name)),
        contains: (name) => classes.has(name),
        toggle: (name, force) => {
          const wanted = force === undefined ? !classes.has(name) : force === true
          if (wanted) classes.add(name)
          else classes.delete(name)
          return wanted
        }
      },
      append(...nodes) {
        for (const node of nodes) {
          children.push(node)
          node.parentNode = element
        }
      },
      appendChild(node) {
        element.append(node)
        return node
      },
      removeChild(node) {
        const index = children.indexOf(node)
        if (index >= 0) children.splice(index, 1)
        node.parentNode = null
      },
      addEventListener: (event, listener) => listeners.set(event, listener),
      setAttribute() {},
      getAttribute() { return null },
      click() { listeners.get('click')?.() }
    }
    return element
  }
  const body = createElement('body')
  return {
    body,
    createElement,
    documentElement: body
  }
}

function findById(root, id) {
  if (root.id === id) return root
  for (const child of root.children || []) {
    const found = findById(child, id)
    if (found) return found
  }
  return null
}

test('the export result bar shows a saved receipt and performs the three actions', async () => {
  const doc = createFakeDocument()
  const calls = []
  const bar = createExportResultBar({
    document: doc,
    translate: (key, params) => (params?.fileName ? `${key}:${params.fileName}` : key),
    getAction: async (resultId, action) => {
      calls.push([resultId, action])
      return { status: 'done' }
    }
  })

  assert.equal(bar.show(null), false, 'a cancelled export shows no bar')
  assert.equal(bar.show({ status: 'failed', code: 'x' }), false)
  assert.equal(bar.isVisible(), false)

  assert.equal(bar.show({ status: 'saved', resultId: 'r1', fileName: 'a.png', kind: 'png' }), true)
  assert.equal(bar.isVisible(), true)
  assert.equal(findById(doc.body, 'exportResultBar').classList.contains('hidden'), false)
  assert.match(findById(doc.body, 'exportResultBar').children[0].textContent, /a\.png/)

  // copy-path keeps the bar visible (so the user can confirm), open hides it.
  await bar.runAction('copy-path')
  assert.deepEqual(calls.at(-1), ['r1', 'copy-path'])
  assert.equal(bar.isVisible(), true)
  await bar.runAction('reveal')
  assert.deepEqual(calls.at(-1), ['r1', 'reveal'])
  assert.equal(bar.isVisible(), false)

  assert.equal(bar.show({ status: 'saved', resultId: 'r2', fileName: 'b.png', kind: 'png' }), true)
  await bar.runAction('open')
  assert.equal(bar.isVisible(), false)
  bar.dispose()
})

test('the export result bar reports a failed action without losing the file', async () => {
  const doc = createFakeDocument()
  const bar = createExportResultBar({
    document: doc,
    translate: (key) => key,
    getAction: async () => ({ status: 'failed', code: 'open-failed' })
  })
  bar.show({ status: 'saved', resultId: 'r1', fileName: 'a.png', kind: 'png' })
  const result = await bar.runAction('open')
  assert.equal(result.code, 'open-failed')
  // The bar stays up and names the failure: the file WAS saved (plan §3.2 partial-failure rule).
  assert.equal(bar.isVisible(), true)
  const status = findById(doc.body, 'exportResultBar').children.find((child) => child.className.includes('export-result-status'))
  assert.equal(status.textContent, 'capture.export-result.open-failed')
  assert.equal(status.classList.contains('error'), true)

  // A throwing transport is reported as open-failed instead of rejecting.
  const throwing = createExportResultBar({
    document: createFakeDocument(),
    translate: (key) => key,
    getAction: async () => { throw new Error('boom') }
  })
  throwing.show({ status: 'saved', resultId: 'r1', fileName: 'a.png', kind: 'png' })
  assert.equal((await throwing.runAction('open')).code, 'open-failed')
  // An unknown action never reaches the transport.
  assert.equal((await throwing.runAction('format-disk')).code, 'unknown-action')
})

test('the export result bar re-translates its buttons after a language switch', () => {
  const doc = createFakeDocument()
  let language = 'zh-CN'
  const bar = createExportResultBar({
    document: doc,
    translate: (key) => `${language}:${key}`,
    getAction: async () => ({ status: 'done' })
  })
  bar.show({ status: 'saved', resultId: 'r1', fileName: 'a.png', kind: 'png' })
  const buttons = findById(doc.body, 'exportResultBar').children
    .find((child) => child.className.includes('export-result-actions')).children
  assert.match(buttons[0].textContent, /^zh-CN:/)
  language = 'en-US'
  bar.retranslate()
  assert.match(buttons[0].textContent, /^en-US:/)
})

test('every locale key the result bar renders exists in all three tables', () => {
  globalThis.__LOCALES = {}
  for (const file of ['zh-CN.js', 'en-US.js', 'zh-TW.js', 'capture.js']) {
    const target = path.join(__dirname, '..', 'shared', 'locales', file)
    delete require.cache[require.resolve(target)]
    require(target)
  }
  assert.ok(LOCALE_KEYS.length > 0)
  for (const language of ['zh-CN', 'en-US', 'zh-TW']) {
    const table = globalThis.__LOCALES[language] || {}
    for (const key of LOCALE_KEYS) {
      assert.equal(typeof table[key], 'string', `${language} is missing ${key}`)
      assert.ok(table[key].length > 0, `${language}/${key} must not be empty`)
    }
  }
})

// ---------------------------------------------------------------------------
// Feature B: the remembered-region write is DIP-correct (plan §5.1 / §5.3)
// ---------------------------------------------------------------------------

// The exact trap this test exists for: the capture/record domains compute selectionBounds from
// Electron window bounds, which are DIP. If the write treated them as display pixels, a 200% display
// would store a region twice the real size - the mixed-DPI acceptance case in plan §5.3. The
// conversion is centralised in recordFromDisplaySelection (space:'dip') so a caller cannot forget it.
test('recordFromDisplaySelection writes a DIP selection as the correct physical-pixel region', () => {
  const { createRegionPreferences } = require('../main/services/region-preferences')
  // Stateful fake settings: read() goes through getSettings() on every write, so a fake that always
  // returned the same object would make each write look like it dropped the other mode's value.
  let settings = { screenshot: { regionPreferences: { schemaVersion: 1, lastByMode: { capture: null, record: null }, presets: [] } } }
  const preferences = createRegionPreferences({
    getSettings: () => settings,
    updateSettings: (patch) => {
      const next = patch.screenshot.regionPreferences
      settings = { screenshot: { regionPreferences: next } }
      return {}
    },
    log: () => {}
  })

  // A 200%-scaled display: 1920x1080 DIP is 3840x2160 physical.
  const display = {
    key: 'display-2',
    boundsDip: { x: 0, y: 0, width: 1920, height: 1080 },
    pixelSize: { width: 3840, height: 2160 },
    scaleFactor: 2
  }
  // A 960x540 DIP selection => 1920x1080 physical pixels.
  const result = preferences.recordFromDisplaySelection({
    mode: 'record',
    display,
    selectionBounds: { x: 0, y: 0, width: 960, height: 540 }
  })
  assert.equal(result.ok, true)
  const written = settings.screenshot.regionPreferences.lastByMode.record
  assert.deepEqual(written.rectDisplayPx, { x: 0, y: 0, width: 1920, height: 1080 }, 'DIP input must be doubled into physical pixels on a 200% display')
  assert.deepEqual(written.displayPixelSize, { width: 3840, height: 2160 })
  assert.equal(written.capturedScaleFactor, 2)

  // An unusable selection is refused rather than remembering garbage; the previous value survives.
  const refused = preferences.recordFromDisplaySelection({ mode: 'record', display, selectionBounds: { x: 0, y: 0, width: 0, height: 0 } })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'selection-unusable')

  // The record and capture slots are independent.
  const captureResult = preferences.recordFromDisplaySelection({
    mode: 'capture',
    display,
    selectionBounds: { x: 0, y: 0, width: 480, height: 270 }
  })
  assert.equal(captureResult.ok, true)
  assert.deepEqual(settings.screenshot.regionPreferences.lastByMode.capture.rectDisplayPx, { x: 0, y: 0, width: 960, height: 540 })
  assert.deepEqual(settings.screenshot.regionPreferences.lastByMode.record.rectDisplayPx, { x: 0, y: 0, width: 1920, height: 1080 }, 'writing capture must not disturb record')
})
