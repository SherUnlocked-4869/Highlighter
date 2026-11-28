'use strict'

// N05 - docs/reviews/2026-11-26-code-review-and-optimization-report.md section 5.5:
// the pin "pixel-aligned onion skin" modes and the pin workspace snapshot feature.
//
// Test strategy:
//   * the onion-mode transition function and the snapshot manifest helpers are pure,
//     so they are driven behaviourally (mode state machine, reduced-motion fallback,
//     serialisation round-trip, malformed-entry dropping, newest-first eviction);
//   * the snapshot store is exercised against a temporary directory with the REAL
//     atomic writer and REAL copied PNG bytes, so restore/skip/corruption are actual
//     files, not mocks;
//   * the window side runs through a fake BrowserWindow + fake image store: restore
//     asserts the createPinWindow call arguments (page/preload, placement, opacity,
//     click-through) and suspend/resume asserts the hide/show state machine;
//   * the renderer half (classic scripts) is pinned with source assertions plus the
//     frozen IPC policy table, which is the repo convention for windows that need a
//     live DOM.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const LANGUAGES = ['zh-CN', 'en-US', 'zh-TW']

const pinDomainSource = fs.readFileSync(path.join(ROOT, 'main/domains/pin/index.js'), 'utf8')
const pinScript = fs.readFileSync(path.join(ROOT, 'pin/pin.js'), 'utf8')
const pinMarkup = fs.readFileSync(path.join(ROOT, 'pin/pin.html'), 'utf8')
const pinStyle = fs.readFileSync(path.join(ROOT, 'pin/pin.css'), 'utf8')
const preloadSource = fs.readFileSync(path.join(ROOT, 'preload-pin.js'), 'utf8')
const mainSource = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8')

const pinDomain = require('../main/domains/pin')
const renderer = require('../pin/pin.js')
const geometry = require('../main/domains/pin/geometry')
const { IPC_SURFACES } = require('../main/services/ipc-security')

const PIN_SURFACE = IPC_SURFACES.find((surface) => surface.role === 'pin')
const PIN_CHANNELS = new Set([...(PIN_SURFACE.handles || []), ...(PIN_SURFACE.listeners || [])])
const PNG_A = Buffer.from('n05-fixture-png-a')
const PNG_B = Buffer.from('n05-fixture-png-b')
const PNG_C = Buffer.from('n05-fixture-png-c')

function loadLocaleTables() {
  globalThis.__LOCALES = {}
  const directory = path.join(ROOT, 'shared', 'locales')
  for (const name of fs.readdirSync(directory).filter((entry) => entry.endsWith('.js')).sort()) {
    const file = path.join(directory, name)
    delete require.cache[require.resolve(file)]
    require(file)
  }
  const tables = {}
  for (const language of LANGUAGES) tables[language] = globalThis.__LOCALES[language] || {}
  return tables
}

async function temporaryRoot(t) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'highlighter-n05-'))
  t.after(() => fsp.rm(directory, { recursive: true, force: true }))
  return directory
}

async function waitFor(predicate, message = 'timed out', timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  if (await predicate()) return true
  assert.fail(message)
}

function readJson(filePath) {
  return fsp.readFile(filePath, 'utf8').then((text) => JSON.parse(text))
}

async function exists(filePath) {
  return fsp.lstat(filePath).then(() => true, () => false)
}

// ---------------------------------------------------------------------------
// A. Onion skin state machine (pure behaviour).
// ---------------------------------------------------------------------------

const { ONION_MODES, ONION_ACTIONS, resolveOnionMode } = renderer
const READY = { clickThrough: true, opacity: 0.5 }

test('N05 onion: both modes toggle on and the same shortcut returns to normal', () => {
  const difference = resolveOnionMode({ mode: ONION_MODES.OFF, action: ONION_ACTIONS.TOGGLE_DIFFERENCE, ...READY })
  assert.equal(difference.mode, ONION_MODES.DIFFERENCE)
  assert.equal(difference.changed, true)
  assert.equal(difference.reducedMotionApplied, false)
  assert.equal(difference.toastKey, 'pin.onion.difference-on')

  const off = resolveOnionMode({ mode: ONION_MODES.DIFFERENCE, action: ONION_ACTIONS.TOGGLE_DIFFERENCE, ...READY })
  assert.equal(off.mode, ONION_MODES.OFF)
  assert.equal(off.changed, true)
  assert.equal(off.toastKey, 'pin.onion.off')

  const flash = resolveOnionMode({ mode: ONION_MODES.OFF, action: ONION_ACTIONS.TOGGLE_FLASH, ...READY })
  assert.equal(flash.mode, ONION_MODES.FLASH)
  assert.equal(flash.toastKey, 'pin.onion.flash-on')

  // The other shortcut switches modes directly instead of stacking them.
  const switched = resolveOnionMode({ mode: ONION_MODES.DIFFERENCE, action: ONION_ACTIONS.TOGGLE_FLASH, ...READY })
  assert.equal(switched.mode, ONION_MODES.FLASH)
  assert.equal(switched.changed, true)
})

test('N05 onion: modes require click-through AND a semi-transparent pin', () => {
  for (const state of [
    { clickThrough: false, opacity: 0.5 },
    { clickThrough: true, opacity: 1 },
    { clickThrough: false, opacity: 1 }
  ]) {
    const attempted = resolveOnionMode({ mode: ONION_MODES.OFF, action: ONION_ACTIONS.TOGGLE_DIFFERENCE, ...state })
    assert.equal(attempted.mode, ONION_MODES.OFF, 'an unavailable state must not enable a mode')
    assert.equal(attempted.available, false)
    assert.equal(attempted.changed, false)
    assert.equal(attempted.toastKey, 'pin.onion.unavailable')
  }
  // Any transparency below 100% counts; 99.9% rounds to 100 on screen but is still
  // a supported compare state.
  const nearlyOpaque = resolveOnionMode({ mode: ONION_MODES.OFF, action: ONION_ACTIONS.TOGGLE_DIFFERENCE, clickThrough: true, opacity: 0.9 })
  assert.equal(nearlyOpaque.mode, ONION_MODES.DIFFERENCE)
})

test('N05 onion: prefers-reduced-motion never animates - flash degrades to static difference', () => {
  const reduced = resolveOnionMode({
    mode: ONION_MODES.OFF,
    action: ONION_ACTIONS.TOGGLE_FLASH,
    ...READY,
    reducedMotion: true
  })
  assert.equal(reduced.mode, ONION_MODES.DIFFERENCE)
  assert.equal(reduced.reducedMotionApplied, true)
  assert.equal(reduced.toastKey, 'pin.onion.reduced-motion')
  // Toggling the degraded mode turns it off, like any other active mode.
  const off = resolveOnionMode({ mode: ONION_MODES.DIFFERENCE, action: ONION_ACTIONS.TOGGLE_FLASH, ...READY, reducedMotion: true })
  assert.equal(off.mode, ONION_MODES.OFF)
  assert.equal(off.toastKey, 'pin.onion.off')
})

test('N05 onion: losing click-through or transparency revalidates an active mode to off', () => {
  const lostClickThrough = resolveOnionMode({
    mode: ONION_MODES.FLASH,
    action: ONION_ACTIONS.REVALIDATE,
    clickThrough: false,
    opacity: 0.5
  })
  assert.equal(lostClickThrough.mode, ONION_MODES.OFF)
  assert.equal(lostClickThrough.changed, true)
  assert.equal(lostClickThrough.toastKey, 'pin.onion.unavailable')

  const becameOpaque = resolveOnionMode({
    mode: ONION_MODES.DIFFERENCE,
    action: ONION_ACTIONS.REVALIDATE,
    clickThrough: true,
    opacity: 1
  })
  assert.equal(becameOpaque.mode, ONION_MODES.OFF)
  assert.equal(becameOpaque.toastKey, 'pin.onion.unavailable')

  // Still available, or already off: nothing changes and there is no toast.
  const stillOk = resolveOnionMode({ mode: ONION_MODES.DIFFERENCE, action: ONION_ACTIONS.REVALIDATE, ...READY })
  assert.equal(stillOk.changed, false)
  assert.equal(stillOk.toastKey, '')
  const alreadyOff = resolveOnionMode({ mode: ONION_MODES.OFF, action: ONION_ACTIONS.REVALIDATE, clickThrough: false, opacity: 1 })
  assert.equal(alreadyOff.changed, false)
  assert.equal(alreadyOff.toastKey, '')
})

test('N05 onion: invalid modes/actions are inert instead of throwing', () => {
  assert.equal(resolveOnionMode().mode, ONION_MODES.OFF)
  assert.equal(resolveOnionMode({ mode: 'rainbow', action: ONION_ACTIONS.TOGGLE_DIFFERENCE, ...READY }).mode, ONION_MODES.DIFFERENCE)
  const unknown = resolveOnionMode({ mode: ONION_MODES.FLASH, action: 'explode', ...READY })
  assert.equal(unknown.mode, ONION_MODES.FLASH)
  assert.equal(unknown.changed, false)
  assert.equal(unknown.toastKey, '')
})

// ---------------------------------------------------------------------------
// B. Snapshot manifest (pure serialisation).
// ---------------------------------------------------------------------------

function placement(overrides = {}) {
  return {
    bounds: { x: 100, y: 120, width: 200, height: 100 },
    zoom: 1,
    rotation: 0,
    opacity: 1,
    clickThrough: false,
    alwaysOnTop: true,
    longCapture: false,
    pixelWidth: 200,
    pixelHeight: 100,
    baseWidth: 200,
    baseHeight: 100,
    displayScaleFactor: 1,
    annotations: null,
    meta: { source: 'capture' },
    ...overrides
  }
}

function snapshotOf({ id = 'ws-test-0001', name = 'Workspace', pins = [placement()] } = {}) {
  return pinDomain.buildWorkspaceSnapshot({ id, name, createdAt: 1700000000000, pins })
}

test('N05 snapshot: a built snapshot round-trips through JSON unchanged', () => {
  const source = snapshotOf({
    pins: [
      placement({ zoom: 1.5, rotation: 90, opacity: 0.5, clickThrough: true, alwaysOnTop: false, annotations: [{ type: 'arrow', from: { x: 1, y: 2 } }] }),
      placement({ bounds: { x: 0, y: 0, width: 10, height: 20 }, longCapture: true, meta: { source: 'long-capture' } })
    ]
  })
  const roundTripped = JSON.parse(JSON.stringify(source))
  assert.deepEqual(pinDomain.normalizeWorkspaceSnapshot(roundTripped), source)
  assert.equal(source.pins.length, 2)
  assert.equal(source.pins[0].zoom, 1.5)
  assert.equal(source.pins[0].rotation, 90)
  assert.equal(source.pins[0].clickThrough, true)
  assert.deepEqual(source.pins[0].annotations, [{ type: 'arrow', from: { x: 1, y: 2 } }])
  assert.equal(source.pins[1].longCapture, true)
})

test('N05 snapshot: malformed pins/names are normalised, not trusted', () => {
  const normalized = pinDomain.normalizeWorkspaceSnapshot({
    id: 'ws-test-0002',
    name: '   spaced   out  ',
    createdAt: 'nope',
    pins: [
      { ...placement({ zoom: 99, rotation: 91, opacity: 0.1 }), asset: '../../etc/passwd' },
      null,
      'garbage'
    ]
  })
  assert.equal(normalized.name, 'spaced out')
  assert.equal(normalized.createdAt, 0)
  assert.equal(normalized.pins.length, 1)
  // Clamped into the product ranges and the traversal-shaped asset name dropped.
  assert.equal(normalized.pins[0].zoom, geometry.PIN_ZOOM_MAX)
  assert.equal(normalized.pins[0].rotation, 90)
  assert.equal(normalized.pins[0].opacity, geometry.PIN_OPACITY_MIN)
  assert.equal(normalized.pins[0].asset, '')
  assert.equal(pinDomain.normalizeWorkspaceSnapshotName('x'.repeat(200)).length, pinDomain.MAX_WORKSPACE_SNAPSHOT_NAME)
  assert.equal(pinDomain.normalizeWorkspaceSnapshot({ name: 'no id' }), null)
})

test('N05 snapshot: a corrupt manifest is ignored, a newer schema is corrupt too', () => {
  assert.deepEqual(pinDomain.parseWorkspaceSnapshotText('{not json'), { snapshots: [], corrupt: true })
  assert.deepEqual(pinDomain.normalizeWorkspaceSnapshotFile(null), { snapshots: [], corrupt: true })
  assert.deepEqual(pinDomain.normalizeWorkspaceSnapshotFile({ version: 99, snapshots: [] }), { snapshots: [], corrupt: true })
  const mixed = pinDomain.normalizeWorkspaceSnapshotFile({
    version: pinDomain.WORKSPACE_SNAPSHOT_SCHEMA,
    snapshots: [snapshotOf({ id: 'ws-test-0003' }), { id: 'not valid id!' }, { id: 'ws-test-0003', name: 'duplicate' }]
  })
  assert.equal(mixed.corrupt, false)
  assert.equal(mixed.snapshots.length, 1, 'invalid and duplicate entries are dropped')
})

test('N05 snapshot: the list is capped newest-first and evicts the oldest', () => {
  let entries = []
  const evicted = []
  for (let index = 1; index <= pinDomain.MAX_WORKSPACE_SNAPSHOTS + 1; index += 1) {
    const id = `ws-cap-${String(index).padStart(4, '0')}`
    const snapshot = snapshotOf({ id, name: `snap ${index}` })
    const result = pinDomain.appendWorkspaceSnapshot(entries, snapshot)
    entries = result.snapshots
    evicted.push(...result.evicted)
  }
  assert.equal(entries.length, pinDomain.MAX_WORKSPACE_SNAPSHOTS)
  assert.equal(entries[0].name, `snap ${pinDomain.MAX_WORKSPACE_SNAPSHOTS + 1}`)
  assert.deepEqual(evicted.map((snapshot) => snapshot.name), ['snap 1'])
  // Re-saving the same id replaces instead of duplicating or evicting itself.
  const replaced = pinDomain.appendWorkspaceSnapshot(entries, snapshotOf({ id: entries[0].id, name: 'renamed' }))
  assert.equal(replaced.evicted.length, 0)
  assert.equal(replaced.snapshots[0].name, 'renamed')
  assert.equal(replaced.snapshots.length, pinDomain.MAX_WORKSPACE_SNAPSHOTS)
})

test('N05 snapshot: the command envelope only accepts the closed allowlist', () => {
  assert.equal(pinDomain.normalizeWorkspaceCommand(null), null)
  assert.equal(pinDomain.normalizeWorkspaceCommand({ type: 'workspace-rm-rf' }), null)
  const save = pinDomain.normalizeWorkspaceCommand({ type: 'workspace-save', name: '  my   workspace ', id: '../../../x' })
  assert.deepEqual(save, { type: 'workspace-save', name: 'my workspace', id: '' })
  const restore = pinDomain.normalizeWorkspaceCommand({ type: 'workspace-restore', id: 'ws-good-0001' })
  assert.deepEqual(restore, { type: 'workspace-restore', name: '', id: 'ws-good-0001' })
  for (const type of pinDomain.WORKSPACE_COMMAND_TYPES) {
    assert.equal(pinDomain.normalizeWorkspaceCommand({ type }).type, type)
  }
})

// ---------------------------------------------------------------------------
// C. Snapshot store + restore (real files, fake windows).
// ---------------------------------------------------------------------------

function createScreen() {
  const primary = {
    id: 1,
    scaleFactor: 1,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1040 }
  }
  const state = { displays: [primary], matching: primary, cursor: { x: 10, y: 10 } }
  return {
    primary,
    state,
    api: {
      getDisplayMatching: () => state.matching,
      getDisplayNearestPoint: () => primary,
      getCursorScreenPoint: () => state.cursor,
      getAllDisplays: () => state.displays.slice(),
      getPrimaryDisplay: () => primary,
      on() {},
      removeListener() {}
    }
  }
}

function createFakePinImages() {
  let next = 0
  const assets = new Map()
  return {
    assets,
    add({ bytes, mime }) {
      const id = `img-${++next}`
      assets.set(id, { bytes: Buffer.from(bytes), mime: mime || 'image/png' })
      return id
    },
    retain(id) {
      return assets.has(id)
    },
    release(id) {
      assets.delete(id)
    },
    async read(id) {
      const entry = assets.get(id)
      if (!entry) throw Object.assign(new Error('released'), { code: 'image-store-released' })
      return { bytes: Buffer.from(entry.bytes), mime: entry.mime }
    },
    stats() {
      return { resident: 0, assets: assets.size }
    }
  }
}

function createFakeWindow({ record } = {}) {
  const win = {
    _state: { x: 0, y: 0, width: 100, height: 50 },
    _boundsCalls: [],
    _events: {},
    _ops: [],
    _sent: [],
    _ignoreMouse: [],
    _createdArgs: record || null,
    _destroyed: false,
    _visible: false,
    _closedOnce: false,
    _opacity: 1,
    _alwaysOnTop: null,
    isDestroyed: () => win._destroyed,
    getBounds: () => ({ ...win._state }),
    setBounds: (bounds) => {
      win._boundsCalls.push({ ...bounds })
      win._state = { ...bounds }
    },
    setPosition: (x, y) => { win._state = { ...win._state, x, y } },
    setContentSize: (width, height) => { win._state = { ...win._state, width, height } },
    setAlwaysOnTop: (value) => { win._alwaysOnTop = value },
    setOpacity: (value) => { win._opacity = value },
    setIgnoreMouseEvents: (ignore, options) => { win._ignoreMouse.push({ ignore, options }) },
    show: () => { win._visible = true; win._ops.push('show') },
    hide: () => { win._visible = false; win._ops.push('hide') },
    isVisible: () => win._visible,
    moveTop: () => { win._ops.push('moveTop') },
    focus: () => { win._ops.push('focus') },
    loadFile: () => Promise.resolve(),
    close: () => {
      if (win._closedOnce) return
      win._closedOnce = true
      win._events.close?.()
      win._events.closed?.()
      win._destroyed = true
    },
    destroy: () => {
      if (!win._destroyed) win.close()
    },
    on: (event, callback) => { win._events[event] = callback }
  }
  win.webContents = {
    window: win,
    isDestroyed: () => win._destroyed,
    send: (channel, payload) => win._sent.push({ channel, payload }),
    on: () => {},
    executeJavaScript: async () => ({})
  }
  return win
}

function createHarness({ snapshotsPath, now, createWorkspaceSnapshotId } = {}) {
  const handlers = new Map()
  const menus = []
  const messages = []
  const created = []
  const screen = createScreen()
  const pinImages = createFakePinImages()
  const { createPinDomain } = pinDomain
  const domain = createPinDomain({
    BrowserWindow: { fromWebContents: (sender) => sender?.window || null },
    clipboard: { writeImage() {} },
    nativeImage: {
      createFromBuffer: () => ({
        getSize: () => ({ width: 200, height: 100 }),
        toDataURL: () => '',
        toPNG: () => Buffer.from([1]),
        isEmpty: () => false,
        resize() { return this }
      })
    },
    screen: screen.api,
    Menu: {
      buildFromTemplate: (template) => {
        menus.push(template)
        return { popup() { menus.popped = (menus.popped || 0) + 1 } }
      }
    },
    path,
    rootDirectory: ROOT,
    createLocalWindow: (pagePath, options) => {
      const win = createFakeWindow()
      win._createdArgs = { pagePath, options }
      created.push(win)
      return win
    },
    getSettings: () => ({
      fixedContent: { opacity: 1, zoomWithMouse: true },
      plugins: { ocr: true },
      pinned: { clickThrough: false }
    }),
    saveImageBuffer: async () => 'saved',
    createRecognitionWindow() {},
    getCreateCaptureWindow: () => async () => null,
    log() {},
    ipcMain: {
      on: (channel, handler) => handlers.set(channel, handler),
      handle: (channel, handler) => handlers.set(channel, handler)
    },
    getWorkspaceSnapshotsFilePath: () => snapshotsPath,
    showMessageBox: async (_win, options) => { messages.push(options); return { response: 0 } },
    pinImages,
    now,
    createWorkspaceSnapshotId
  })
  return { domain, handlers, menus, messages, created, screen, pinImages, snapshotsPath }
}

async function createWorkspaceHarness(t, options = {}) {
  const tempRoot = await temporaryRoot(t)
  const snapshotsPath = path.join(tempRoot, 'pins', 'snapshots.json')
  const harness = createHarness({ snapshotsPath, ...options })
  return { ...harness, tempRoot }
}

function pinSelection(x, y, width = 200, height = 100) {
  return { selectionBounds: { x, y, width, height } }
}

async function seedSnapshot(harness, { name = 'Design review', pins } = {}) {
  for (const pin of pins || []) {
    harness.domain.createPinWindow(pin.bytes, pinSelection(pin.x, pin.y, pin.width, pin.height))
  }
  const saved = await harness.domain.saveWorkspaceSnapshot(name)
  assert.equal(saved.status, 'saved')
  return readJson(harness.snapshotsPath).then((manifest) => manifest.snapshots[0])
}

test('N05 snapshot: saving copies every live picture and persists the full placement', async (t) => {
  const harness = await createWorkspaceHarness(t, { now: () => 1700000000000 })
  const first = harness.domain.createPinWindow(PNG_A, pinSelection(100, 120, 200, 100))
  const second = harness.domain.createPinWindow(PNG_B, pinSelection(400, 300, 120, 80))
  // Presentation changes a user could have made before saving.
  first._pinData.zoom = 1.5
  first._pinData.rotation = 90
  first._pinData.opacity = 0.5
  first._pinData.clickThrough = true
  first._pinData.alwaysOnTop = false
  first._pinData.meta = { source: 'capture', annotations: [{ type: 'box', x: 1, y: 2, width: 3, height: 4 }] }
  first.setBounds({ x: 150, y: 160, width: 300, height: 150 })
  second._pinData.longCapture = true

  const receipt = await harness.domain.saveWorkspaceSnapshot('   Design   review  ')
  assert.equal(receipt.status, 'saved')
  assert.equal(receipt.name, 'Design review')
  assert.equal(receipt.pinCount, 2)

  const manifest = await readJson(harness.snapshotsPath)
  assert.equal(manifest.version, pinDomain.WORKSPACE_SNAPSHOT_SCHEMA)
  assert.equal(manifest.snapshots.length, 1)
  const snapshot = manifest.snapshots[0]
  assert.equal(snapshot.name, 'Design review')
  assert.match(snapshot.id, /^ws-/)
  assert.equal(snapshot.pins.length, 2)
  const [firstPin, secondPin] = snapshot.pins
  assert.deepEqual(firstPin.bounds, { x: 150, y: 160, width: 300, height: 150 })
  assert.equal(firstPin.zoom, 1.5)
  assert.equal(firstPin.rotation, 90)
  assert.equal(firstPin.opacity, 0.5)
  assert.equal(firstPin.clickThrough, true)
  assert.equal(firstPin.alwaysOnTop, false)
  assert.deepEqual(firstPin.annotations, [{ type: 'box', x: 1, y: 2, width: 3, height: 4 }])
  assert.equal(firstPin.asset, 'pin-1.png')
  assert.equal(secondPin.asset, 'pin-2.png')
  assert.equal(secondPin.longCapture, true)
  // The picture is copied next to the manifest, byte for byte.
  const assetPath = path.join(path.dirname(harness.snapshotsPath), 'snapshot-assets', snapshot.id, 'pin-1.png')
  assert.deepEqual(await fsp.readFile(assetPath), PNG_A)
  // Atomic write leaves no temp files behind.
  const names = await fsp.readdir(path.dirname(harness.snapshotsPath))
  assert.deepEqual(names.filter((name) => name.endsWith('.tmp')), [])
  // Saving with no pins is a stated failure, not an empty snapshot.
  for (const win of [...harness.created]) win.close()
  assert.equal((await harness.domain.saveWorkspaceSnapshot('empty')).code, 'NO_PINS')
})

test('N05 snapshot: restore closes the current pins and rebuilds the saved ones through createPinWindow', async (t) => {
  const harness = await createWorkspaceHarness(t, {
    now: () => 1700000000000,
    createWorkspaceSnapshotId: () => 'ws-fixed-0001'
  })
  const original = harness.domain.createPinWindow(PNG_A, pinSelection(100, 120, 200, 100))
  original._pinData.zoom = 1.5
  original._pinData.rotation = 90
  original._pinData.opacity = 0.5
  original._pinData.clickThrough = true
  original._pinData.alwaysOnTop = false
  original.setBounds({ x: 150, y: 160, width: 300, height: 150 })
  const saved = await harness.domain.saveWorkspaceSnapshot('Restore me')
  assert.equal(saved.status, 'saved')
  const manifest = await readJson(harness.snapshotsPath)
  const snapshot = manifest.snapshots[0]
  const entry = snapshot.pins[0]

  // Something else is on the desktop when the snapshot is restored.
  const current = harness.domain.createPinWindow(PNG_C, pinSelection(700, 500, 90, 70))
  const idBeforeRestore = current._pinData.imageId
  const createdBefore = harness.created.length

  const receipt = await harness.domain.restoreWorkspaceSnapshot(snapshot.id)
  assert.equal(receipt.status, 'restored')
  assert.equal(receipt.restored, 1)
  assert.equal(receipt.total, 1)
  assert.equal(receipt.missing, 0)
  // The old workspace is gone (closing releases its image-store reference).
  assert.equal(current.isDestroyed(), true)
  assert.equal(harness.pinImages.assets.has(idBeforeRestore), false)
  assert.equal(harness.created.length, createdBefore + 1)

  const restored = harness.created[harness.created.length - 1]
  // createPinWindow is reused: the real pin page + pin preload.
  assert.equal(path.basename(restored._createdArgs.pagePath), 'pin.html')
  assert.equal(path.basename(restored._createdArgs.options.webPreferences.preload), 'preload-pin.js')
  // Placement is derived by the same helpers zoom/rotation use, so the box is the
  // rotated bounding box of the saved 300x150 at 90 degrees.
  const sized = geometry.getRotatedPinSize(
    Math.round(entry.baseWidth * entry.zoom),
    Math.round(entry.baseHeight * entry.zoom),
    entry.rotation
  )
  assert.deepEqual(restored.getBounds(), {
    x: entry.bounds.x,
    y: entry.bounds.y,
    width: sized.width,
    height: sized.height
  })
  assert.equal(restored._pinData.zoom, 1.5)
  assert.equal(restored._pinData.rotation, 90)
  assert.equal(restored._pinData.opacity, 0.5)
  assert.equal(restored._pinData.alwaysOnTop, false)
  assert.equal(restored._pinData.longCapture, false)
  // Click-through is applied before the rebuilt renderer reveals, exactly like create.
  assert.deepEqual(restored._ignoreMouse.at(-1), { ignore: true, options: { forward: true } })
  assert.equal(restored._alwaysOnTop, false)
  // The picture bytes reached the new pin's image store handle.
  const restoredImage = await harness.pinImages.read(restored._pinData.imageId)
  assert.deepEqual(restoredImage.bytes, PNG_A)
})

test('N05 snapshot: a missing picture is skipped and reported, the rest still restore', async (t) => {
  const harness = await createWorkspaceHarness(t, { now: () => 1700000000000 })
  harness.domain.createPinWindow(PNG_A, pinSelection(100, 120, 200, 100))
  harness.domain.createPinWindow(PNG_B, pinSelection(400, 300, 200, 100))
  const saved = await harness.domain.saveWorkspaceSnapshot('Partial')
  assert.equal(saved.status, 'saved')
  const manifest = await readJson(harness.snapshotsPath)
  const snapshot = manifest.snapshots[0]
  const missingAsset = path.join(path.dirname(harness.snapshotsPath), 'snapshot-assets', snapshot.id, snapshot.pins[1].asset)
  await fsp.rm(missingAsset)

  const receipt = await harness.domain.restoreWorkspaceSnapshot(snapshot.id)
  assert.equal(receipt.status, 'restored')
  assert.equal(receipt.restored, 1)
  assert.equal(receipt.total, 2)
  assert.equal(receipt.missing, 1)
  assert.deepEqual(receipt.skipped.map((entry) => entry.code), ['IMAGE_MISSING'])
  // The user is told which pictures were skipped (the requester window is gone by
  // then, so the notice is a native message box).
  assert.equal(harness.messages.length, 1)
  assert.match(harness.messages[0].title, /部分贴图没有恢复/)
  assert.match(harness.messages[0].message, /1 \/ 2/)
})

test('N05 snapshot: an all-missing snapshot aborts before closing the current workspace', async (t) => {
  const harness = await createWorkspaceHarness(t, { now: () => 1700000000000 })
  const pin = harness.domain.createPinWindow(PNG_A, pinSelection(100, 120, 200, 100))
  const saved = await harness.domain.saveWorkspaceSnapshot('Gone')
  assert.equal(saved.status, 'saved')
  const manifest = await readJson(harness.snapshotsPath)
  const snapshot = manifest.snapshots[0]
  await fsp.rm(
    path.join(path.dirname(harness.snapshotsPath), 'snapshot-assets', snapshot.id),
    { recursive: true, force: true }
  )
  const receipt = await harness.domain.restoreWorkspaceSnapshot(snapshot.id)
  assert.equal(receipt.status, 'failed')
  assert.equal(receipt.code, 'ALL_IMAGES_MISSING')
  // Nothing was replaced: the live pin and its image are untouched.
  assert.equal(pin.isDestroyed(), false)
  assert.equal(harness.domain.getPinnedCount(), 1)
  assert.equal(harness.pinImages.assets.size, 1)
})

test('N05 snapshot: deleting removes the manifest entry and its copied pictures', async (t) => {
  const harness = await createWorkspaceHarness(t, { now: () => 1700000000000 })
  harness.domain.createPinWindow(PNG_A, pinSelection(100, 120, 200, 100))
  const saved = await harness.domain.saveWorkspaceSnapshot('Delete me')
  assert.equal(saved.status, 'saved')
  const manifest = await readJson(harness.snapshotsPath)
  const snapshot = manifest.snapshots[0]
  const assetDirectory = path.join(path.dirname(harness.snapshotsPath), 'snapshot-assets', snapshot.id)
  assert.equal(await exists(assetDirectory), true)

  const receipt = await harness.domain.deleteWorkspaceSnapshot(snapshot.id)
  assert.equal(receipt.status, 'deleted')
  assert.equal(receipt.name, 'Delete me')
  assert.deepEqual((await readJson(harness.snapshotsPath)).snapshots, [])
  assert.equal(await exists(assetDirectory), false)
  assert.equal((await harness.domain.deleteWorkspaceSnapshot(snapshot.id)).code, 'NOT_FOUND')
  assert.deepEqual(await harness.domain.listWorkspaceSnapshots(), [])
})

test('N05 snapshot: a corrupt manifest is ignored and rebuilt, then saving works again', async (t) => {
  const harness = await createWorkspaceHarness(t)
  await fsp.mkdir(path.dirname(harness.snapshotsPath), { recursive: true })
  await fsp.writeFile(harness.snapshotsPath, '{ this is not json')
  assert.deepEqual(await harness.domain.listWorkspaceSnapshots(), [])
  const rebuilt = await readJson(harness.snapshotsPath)
  assert.equal(rebuilt.version, pinDomain.WORKSPACE_SNAPSHOT_SCHEMA)
  assert.deepEqual(rebuilt.snapshots, [])

  harness.domain.createPinWindow(PNG_A, pinSelection(100, 120, 200, 100))
  const saved = await harness.domain.saveWorkspaceSnapshot('After repair')
  assert.equal(saved.status, 'saved')
  const manifest = await readJson(harness.snapshotsPath)
  assert.equal(manifest.snapshots.length, 1)
  assert.equal(manifest.snapshots[0].name, 'After repair')
})

test('N05 snapshot: the store keeps at most ten workspaces and evicts the oldest pictures', async (t) => {
  const harness = await createWorkspaceHarness(t, {
    now: () => 1700000000000
  })
  harness.domain.createPinWindow(PNG_A, pinSelection(100, 120, 200, 100))
  const ids = []
  for (let index = 1; index <= pinDomain.MAX_WORKSPACE_SNAPSHOTS + 1; index += 1) {
    const saved = await harness.domain.saveWorkspaceSnapshot(`snapshot ${index}`)
    assert.equal(saved.status, 'saved')
    ids.push(saved.id)
  }
  const manifest = await readJson(harness.snapshotsPath)
  assert.equal(manifest.snapshots.length, pinDomain.MAX_WORKSPACE_SNAPSHOTS)
  assert.equal(manifest.snapshots[0].name, `snapshot ${pinDomain.MAX_WORKSPACE_SNAPSHOTS + 1}`)
  assert.equal(manifest.snapshots.some((snapshot) => snapshot.name === 'snapshot 1'), false)
  const evictedDirectory = path.join(path.dirname(harness.snapshotsPath), 'snapshot-assets', ids[0])
  assert.equal(await exists(evictedDirectory), false)
  const summaries = await harness.domain.listWorkspaceSnapshots()
  assert.equal(summaries.length, 10)
  assert.equal(summaries[0].name, 'snapshot 11')
  assert.equal(summaries[0].pinCount, 1)
})

// ---------------------------------------------------------------------------
// D. Suspend / resume and the context-menu command carrier.
// ---------------------------------------------------------------------------

test('N05 workspace: suspend hides every pin and resume restores placement and visibility', async (t) => {
  const harness = await createWorkspaceHarness(t)
  const first = harness.domain.createPinWindow(PNG_A, pinSelection(100, 120, 200, 100))
  const second = harness.domain.createPinWindow(PNG_B, pinSelection(400, 300, 160, 90))
  harness.domain.revealPinWindow(first)
  harness.domain.revealPinWindow(second)
  assert.equal(first.isVisible(), true)
  assert.equal(second.isVisible(), true)

  const suspended = harness.domain.suspendPinWorkspace()
  assert.equal(suspended.status, 'suspended')
  assert.equal(suspended.count, 2)
  assert.equal(first.isVisible(), false)
  assert.equal(second.isVisible(), false)
  assert.equal(harness.domain.isPinWorkspaceSuspended(), true)
  // A second suspend is a no-op rather than a second state.
  assert.equal(harness.domain.suspendPinWorkspace().code, 'ALREADY_SUSPENDED')

  // Move a window while it is hidden; resume must put the saved placement back.
  first._state = { x: 5, y: 5, width: 200, height: 100 }
  const resumed = harness.domain.resumePinWorkspace()
  assert.equal(resumed.status, 'resumed')
  assert.equal(resumed.resumed, 2)
  assert.equal(resumed.skipped, 0)
  assert.equal(first.isVisible(), true)
  assert.equal(second.isVisible(), true)
  assert.equal(harness.domain.isPinWorkspaceSuspended(), false)
  assert.deepEqual(first.getBounds(), { x: 100, y: 120, width: 200, height: 100 })
  // A second resume is a stated no-op.
  assert.equal(harness.domain.resumePinWorkspace().code, 'NOT_SUSPENDED')
})

test('N05 workspace: the tray locate path resumes a suspended workspace', async (t) => {
  const harness = await createWorkspaceHarness(t)
  const first = harness.domain.createPinWindow(PNG_A, pinSelection(100, 120, 200, 100))
  const second = harness.domain.createPinWindow(PNG_B, pinSelection(400, 300, 160, 90))
  harness.domain.revealPinWindow(first)
  harness.domain.revealPinWindow(second)
  harness.domain.suspendPinWorkspace()
  assert.equal(first.isVisible(), false)

  const focused = harness.domain.focusPin(first._pinId)
  assert.ok(focused, 'locate returns the pin snapshot')
  assert.equal(harness.domain.isPinWorkspaceSuspended(), false)
  assert.equal(first.isVisible(), true)
  assert.equal(second.isVisible(), true)
})

test('N05 workspace: the existing show/hide-every-pin entry resumes a suspended workspace', async (t) => {
  const harness = await createWorkspaceHarness(t)
  const pin = harness.domain.createPinWindow(PNG_A, pinSelection(100, 120, 200, 100))
  harness.domain.revealPinWindow(pin)
  harness.domain.suspendPinWorkspace()
  assert.equal(pin.isVisible(), false)
  // The function router / tray entry calls exactly this method.
  harness.domain.togglePinVisibility()
  assert.equal(pin.isVisible(), true)
  assert.equal(harness.domain.isPinWorkspaceSuspended(), false)
})

test('N05 workspace: the context menu lists snapshots and save asks the renderer for a name', async (t) => {
  const harness = await createWorkspaceHarness(t, { now: () => 1700000000000 })
  const win = harness.domain.createPinWindow(PNG_A, pinSelection(100, 120, 200, 100))
  await harness.domain.saveWorkspaceSnapshot('Menu visible')

  const menuHandler = harness.handlers.get('pin:context-menu')
  assert.equal(typeof menuHandler, 'function')
  menuHandler({ sender: win.webContents }, { x: 0, y: 0, width: 100, height: 50 })
  await waitFor(() => harness.menus.length === 1, 'the pin context menu was not built')
  const template = harness.menus[0]
  const workspaceEntry = template.find((item) => item && item.label === '工作区快照')
  assert.ok(workspaceEntry, 'the pin menu owns a workspace snapshot submenu')
  const labels = workspaceEntry.submenu.map((item) => item.label)
  assert.ok(labels.includes('保存当前工作区…'))
  assert.ok(labels.includes('挂起全部贴图（可从托盘恢复）'))
  const restore = workspaceEntry.submenu.find((item) => item.label === '恢复工作区快照')
  assert.equal(restore.submenu[0].label, 'Menu visible · 1 张贴图')
  // "Save" does not write anything itself: it asks this renderer to name the group.
  const save = workspaceEntry.submenu.find((item) => item.label === '保存当前工作区…')
  save.click()
  assert.ok(win._sent.some((entry) => entry.channel === 'pin:workspace-name-request'))
})

test('N05 workspace: the command envelope saves/restores without opening a menu and ignores unknown types', async (t) => {
  const harness = await createWorkspaceHarness(t, { now: () => 1700000000000 })
  const win = harness.domain.createPinWindow(PNG_A, pinSelection(100, 120, 200, 100))
  const menuHandler = harness.handlers.get('pin:context-menu')
  menuHandler({ sender: win.webContents }, {}, { type: 'workspace-save', name: 'From shortcut' })
  await waitFor(() => exists(harness.snapshotsPath), 'the command did not persist a snapshot')
  const manifest = await readJson(harness.snapshotsPath)
  assert.equal(manifest.snapshots.length, 1)
  assert.equal(manifest.snapshots[0].name, 'From shortcut')
  assert.equal(harness.menus.length, 0, 'a command must not open the native menu')
  assert.equal(win._sent.some((entry) => entry.channel === 'pin:workspace-result'), true)
  // An unknown command is not a menu request either: it is rejected before any
  // action, and the hostile payload never reaches a snapshot name/id.
  menuHandler({ sender: win.webContents }, {}, { type: 'workspace-delete-everything' })
  await waitFor(() => harness.menus.length === 1, 'an unknown command falls back to the normal menu')
  assert.equal((await readJson(harness.snapshotsPath)).snapshots.length, 1, 'nothing was deleted')
  // No new IPC channel: the command rides the frozen context-menu listener.
  assert.ok(PIN_CHANNELS.has('pin:context-menu'))
  assert.equal(PIN_CHANNELS.has('pin:workspace-save'), false)
})

// ---------------------------------------------------------------------------
// E. Renderer + wiring structure (classic scripts; no live DOM in node tests).
// ---------------------------------------------------------------------------

test('N05 wiring: the pin domain registers no IPC channel outside the frozen pin surface', () => {
  const registrations = [...pinDomainSource.matchAll(/ipcMain\.(on|handle)\('([^']+)'/g)]
  assert.ok(registrations.length >= 12)
  for (const [, kind, channel] of registrations) {
    assert.ok(PIN_CHANNELS.has(channel), `${kind}('${channel}') is not in IPC_SURFACES for role pin`)
  }
  // The renderer -> main workspace command rides the existing context-menu channel,
  // so nothing new had to be added to the frozen sender-policy table.
  assert.match(pinDomainSource, /ipcMain\.on\('pin:context-menu', \(event, imageBounds = \{\}, command = null\) => \{/)
  // No global shortcut registry entry for the pin window (the report's constraint).
  assert.doesNotMatch(pinDomainSource, /globalShortcut/)
  assert.doesNotMatch(pinScript, /globalShortcut/)
  // No main.js wiring for the new feature: both entries are the pin domain's own.
  assert.doesNotMatch(mainSource, /saveWorkspaceSnapshot|restoreWorkspaceSnapshot|suspendPinWorkspace/)
})

test('N05 wiring: the snapshot store uses the atomic JSON writer, a 10-entry cap and a copied-asset layout', () => {
  assert.match(pinDomainSource, /const \{ atomicWriteJson \} = require\('\.\.\/\.\.\/services\/data-root'\)/)
  assert.match(pinDomainSource, /const MAX_WORKSPACE_SNAPSHOTS = 10/)
  assert.match(pinDomainSource, /WORKSPACE_SNAPSHOT_FILE_NAME = 'snapshots\.json'/)
  assert.match(pinDomainSource, /await atomicWriteJson\(resolveWorkspaceSnapshotFile\(\), \{/)
  assert.match(pinDomainSource, /WORKSPACE_SNAPSHOT_ASSET_DIR = 'snapshot-assets'/)
  assert.match(pinDomainSource, /async function writeBytesAtomic\(/)
  assert.match(pinDomainSource, /applyWorkspacePlacement\(win, item\.pin\)/)
  assert.match(pinDomainSource, /parseWorkspaceSnapshotText/)
  assert.match(pinDomainSource, /ALL_IMAGES_MISSING/)
  assert.match(pinDomainSource, /suspendPinWorkspace,/)
  assert.match(pinDomainSource, /resumePinWorkspace,/)
  // Restore reuses the existing create path instead of re-implementing a window.
  assert.match(pinDomainSource, /const win = createPinWindow\(bytes, snapshotRestoreMeta\(item\.pin\)\)/)
  // The pin menu is the snapshot entry point: no tray wiring is added in main.js.
  assert.match(pinDomainSource, /label: t\('pin\.workspace\.menu-label'\)/)
  assert.match(pinDomainSource, /sendToRenderer\(win, 'pin:workspace-name-request'\)/)
})

test('N05 renderer: pin.js owns the onion state machine, its keydown shortcuts and the naming overlay', () => {
  assert.match(pinScript, /const ONION_MODES = Object\.freeze\(\{ OFF: 'off', DIFFERENCE: 'difference', FLASH: 'flash' \}\)/)
  assert.match(pinScript, /function resolveOnionMode\(options = \{\}\)/)
  assert.match(pinScript, /function applyOnionMode\(nextMode\)/)
  assert.match(pinScript, /classList\.toggle\('onion-difference'/)
  assert.match(pinScript, /classList\.toggle\('onion-flash'/)
  assert.match(pinScript, /prefers-reduced-motion: reduce/)
  assert.match(pinScript, /revalidateOnionMode\(\)/)
  // Pin-window-local keyboard handling only (Ctrl+Shift+D/F/S/R/H), never a global
  // accelerator registration.
  assert.match(pinScript, /const shortcut = event\.ctrlKey && event\.shiftKey/)
  assert.match(pinScript, /key === 'd'/)
  assert.match(pinScript, /key === 'f'/)
  assert.match(pinScript, /key === 's'/)
  assert.match(pinScript, /key === 'r'/)
  assert.match(pinScript, /key === 'h'/)
  assert.match(pinScript, /window\.pinAPI\.workspaceCommand\(\{ type: 'workspace-restore-latest' \}\)/)
  assert.match(pinScript, /window\.pinAPI\.workspaceCommand\(\{ type: 'workspace-suspend' \}\)/)
  // The toasts are trilingual keys, never hardcoded copy.
  for (const key of [
    'pin.onion.difference-on',
    'pin.onion.flash-on',
    'pin.onion.off',
    'pin.onion.unavailable',
    'pin.onion.reduced-motion'
  ]) {
    assert.ok(pinScript.includes(key), `pin.js resolves ${key}`)
  }
  assert.match(pinScript, /function showToast\(key, params = null\)/)
  assert.match(pinScript, /function openWorkspaceNaming\(\)/)
  assert.match(pinScript, /window\.pinAPI\.onWorkspaceResult\(handleWorkspaceResult\)/)
})

test('N05 renderer: markup/styles carry the toast, the naming overlay and the reduced-motion fallback', () => {
  assert.match(pinMarkup, /<div id="pinToast" role="status" hidden><\/div>/)
  assert.match(pinMarkup, /<div id="pinWorkspaceNaming" hidden>/)
  assert.match(pinMarkup, /data-i18n="pin\.workspace\.naming-title"/)
  assert.match(pinMarkup, /data-i18n-placeholder="pin\.workspace\.naming-placeholder"/)
  assert.match(pinMarkup, /id="pinWorkspaceNameInput"/)
  // The overlay controls may not collide with the reserved pin controls.
  assert.doesNotMatch(pinMarkup, /<button id="(?:copy|save|close)"/)
  assert.doesNotMatch(pinMarkup, /type="range"/)

  assert.match(pinStyle, /body\.onion-difference \.pin-surface\{mix-blend-mode:difference\}/)
  assert.match(pinStyle, /body\.onion-flash \.pin-surface\{animation:pin-onion-flash 1s step-end infinite\}/)
  assert.match(pinStyle, /@keyframes pin-onion-flash\{0%,49%\{opacity:1\}50%,100%\{opacity:0\}\}/)
  assert.match(pinStyle, /@media\(prefers-reduced-motion:reduce\)\{body\.onion-flash \.pin-surface\{animation:none!important\}\}/)
  assert.match(pinStyle, /#pinToast\{/)
  assert.match(pinStyle, /#pinWorkspaceNaming\{/)
})

test('N05 wiring: preload sends workspace commands over the existing channel only', () => {
  assert.match(preloadSource, /workspaceCommand: \(command\) => \{/)
  assert.match(preloadSource, /normalizeWorkspaceCommand\(command\)/)
  assert.match(preloadSource, /ipcRenderer\.send\('pin:context-menu', null, normalized\)/)
  assert.match(preloadSource, /onWorkspaceNameRequest/)
  assert.match(preloadSource, /onWorkspaceResult/)
  assert.doesNotMatch(preloadSource, /ipcRenderer\.(?:send|invoke)\('pin:workspace/)
  assert.doesNotMatch(preloadSource, /globalShortcut/)
})

test('N05 i18n: every new onion/workspace key exists in all three tables', () => {
  const tables = loadLocaleTables()
  const keys = new Set()
  for (const source of [pinScript, pinDomainSource]) {
    for (const match of source.matchAll(/'(pin\.(?:onion|workspace)\.[a-z-]+)'/g)) keys.add(match[1])
  }
  assert.ok(keys.size >= 20, 'both the renderer and the domain resolve the new keys')
  for (const key of keys) {
    for (const language of LANGUAGES) {
      assert.equal(typeof tables[language][key], 'string', `${language} is missing ${key}`)
      assert.notEqual(tables[language][key], '', `${language}.${key} is empty`)
    }
  }
  // Trilingual means the three values are actually translated, not copied.
  assert.notEqual(tables['zh-CN']['pin.onion.difference-on'], tables['en-US']['pin.onion.difference-on'])
  assert.notEqual(tables['zh-CN']['pin.workspace.menu-label'], tables['en-US']['pin.workspace.menu-label'])
  assert.match(tables['en-US']['pin.workspace.toast-saved'], /\{name\}/)
  assert.match(tables['zh-TW']['pin.workspace.toast-saved'], /\{name\}/)
})
