'use strict'

// A07 (docs/reviews/2026-11-24-windows-product-architecture-review.md):
// "多贴图按显示器找回，拖放末端可吸附".
//
// The pin domain half - grouping by display, the three window-level actions, the
// display-change reflow and the single end-of-drag snap - runs against fake windows and
// a fake screen, so 100%/150%, negative coordinates and unplugging are deterministic.
// The tray half pins the new submenu as behaviour (labels, nesting, fallback and the
// three languages), and the source-contract test keeps the wiring honest.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { buildTrayMenuTemplate } = require('../main/services/tray-menu')
const { displayLabel } = require('../main/services/pin-geometry')
const { t, registerLocales, setLanguage, currentLanguage } = require('../main/services/i18n-bootstrap')

registerLocales()

const root = path.join(__dirname, '..')
const DATA_URL = 'data:image/png;base64,AA=='
const LANGUAGES = ['zh-CN', 'en-US', 'zh-TW']

function withLanguage(language, run) {
  const previous = currentLanguage()
  setLanguage(language)
  try {
    return run()
  } finally {
    setLanguage(previous)
  }
}

// ---------------------------------------------------------------------------
// Fake Electron surface
// ---------------------------------------------------------------------------

function primaryDisplay() {
  return {
    id: 1,
    label: 'Primary',
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    size: { width: 1920, height: 1080 },
    scaleFactor: 1
  }
}

function secondaryDisplay() {
  return {
    id: 2,
    label: 'Left 150%',
    bounds: { x: -2560, y: 0, width: 2560, height: 1440 },
    workArea: { x: -2560, y: 0, width: 2560, height: 1400 },
    size: { width: 2560, height: 1440 },
    scaleFactor: 1.5
  }
}

function intersection(a, b) {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return width > 0 && height > 0 ? width * height : 0
}

function centerOf(bounds) {
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
}

function nearestDisplay(displays, bounds) {
  const center = centerOf(bounds)
  let best = displays[0]
  let bestDistance = Number.POSITIVE_INFINITY
  for (const display of displays) {
    const displayCenter = centerOf(display.bounds)
    const distance = Math.hypot(displayCenter.x - center.x, displayCenter.y - center.y)
    if (distance < bestDistance) {
      bestDistance = distance
      best = display
    }
  }
  return best
}

function matchDisplay(displays, bounds) {
  if (!displays.length) return null
  let best = null
  let bestArea = 0
  for (const display of displays) {
    const area = intersection(bounds, display.bounds)
    if (area > bestArea) {
      bestArea = area
      best = display
    }
  }
  return best || nearestDisplay(displays, bounds)
}

function createScreen(displays, { primaryId = 1 } = {}) {
  const listeners = new Map()
  const state = { displays: [...displays], queries: 0 }
  const api = {
    state,
    getAllDisplays: () => state.displays.slice(),
    getPrimaryDisplay: () => state.displays.find((display) => display.id === primaryId) || state.displays[0] || null,
    getDisplayMatching(bounds) {
      state.queries += 1
      return matchDisplay(state.displays, bounds)
    },
    getDisplayNearestPoint(point) {
      if (!state.displays.length) return null
      return state.displays.find((display) => (
        point.x >= display.bounds.x && point.x < display.bounds.x + display.bounds.width &&
        point.y >= display.bounds.y && point.y < display.bounds.y + display.bounds.height
      )) || nearestDisplay(state.displays, { x: point.x, y: point.y, width: 1, height: 1 })
    },
    getCursorScreenPoint: () => ({ x: 10, y: 10 }),
    on(event, listener) {
      const list = listeners.get(event) || []
      list.push(listener)
      listeners.set(event, list)
    },
    removeListener(event, listener) {
      const list = listeners.get(event) || []
      const index = list.indexOf(listener)
      if (index >= 0) list.splice(index, 1)
    },
    emit(event) {
      for (const listener of [...(listeners.get(event) || [])]) listener()
    },
    removeDisplay(id) {
      state.displays = state.displays.filter((display) => display.id !== id)
      api.emit('display-removed')
    }
  }
  return api
}

function createFakeWindow(sends) {
  const win = {
    _ops: [],
    _bounds: [],
    _topCalls: [],
    _ignoreMouse: [],
    _state: { x: 0, y: 0, width: 100, height: 50 },
    _visible: false,
    _destroyed: false,
    isDestroyed: () => win._destroyed,
    getBounds: () => ({ ...win._state }),
    setBounds: (bounds) => {
      win._bounds.push({ ...bounds })
      win._state = { ...bounds }
    },
    setPosition: (x, y) => { win._state = { ...win._state, x, y } },
    setContentSize: (width, height) => { win._state = { ...win._state, width, height } },
    setAlwaysOnTop: (value, level) => win._topCalls.push({ value, level }),
    setOpacity: () => win._ops.push('opacity'),
    setIgnoreMouseEvents: (ignore, options) => win._ignoreMouse.push({ ignore, options }),
    show: () => { win._visible = true; win._ops.push('show') },
    hide: () => { win._visible = false; win._ops.push('hide') },
    showInactive: () => { win._visible = true; win._ops.push('show-inactive') },
    isVisible: () => win._visible,
    moveTop: () => win._ops.push('move-top'),
    focus: () => win._ops.push('focus'),
    loadFile: () => undefined,
    close: () => {},
    destroy: () => { win._destroyed = true },
    on: (event, callback) => { win['_on_' + event] = callback },
    webContents: null
  }
  win.webContents = {
    window: win,
    isDestroyed: () => false,
    send: (channel, payload) => sends.push({ win, channel, payload })
  }
  return win
}

function createHarness({ displays = [primaryDisplay(), secondaryDisplay()], isPinSnapEnabled } = {}) {
  const handlers = new Map()
  const created = []
  const sends = []
  const screen = createScreen(displays)
  const { createPinDomain } = require('../main/domains/pin')
  const domain = createPinDomain({
    BrowserWindow: { fromWebContents: (sender) => sender?.window || null },
    clipboard: { writeImage: () => {} },
    nativeImage: {
      createFromBuffer: () => ({
        getSize: () => ({ width: 200, height: 100 }),
        toDataURL: () => DATA_URL
      })
    },
    screen,
    Menu: { buildFromTemplate: () => ({ popup: () => {} }) },
    path,
    rootDirectory: root,
    createLocalWindow: () => {
      const win = createFakeWindow(sends)
      created.push(win)
      return win
    },
    getSettings: () => ({
      fixedContent: { opacity: 1, zoomWithMouse: true },
      plugins: { ocr: true },
      pinned: { clickThrough: false }
    }),
    saveImageBuffer: async () => 'saved',
    createRecognitionWindow: () => {},
    getCreateCaptureWindow: () => async () => null,
    log: () => {},
    isPinSnapEnabled,
    ipcMain: { on: (channel, handler) => handlers.set(channel, handler) }
  })
  return { domain, screen, handlers, created, sends }
}

function pinAt(domain, { x, y, width = 200, height = 100 }) {
  return domain.createPinWindow(DATA_URL, { selectionBounds: { x, y, width, height } })
}

function payloadPins(payload) {
  return payload.displays.flatMap((display) => display.pins)
}

function pinPayload() {
  const calls = []
  return {
    calls,
    payload: {
      displays: [
        {
          label: 'Display A · 1920×1080 · 100% · primary · (0, 0)',
          pins: [
            {
              id: 'pin-1',
              index: 1,
              bounds: { x: 100, y: 100, width: 200, height: 100 },
              alwaysOnTop: true,
              clickThrough: false,
              opacity: 1
            }
          ]
        },
        {
          label: 'Display B · 2560×1440 · 150% · secondary · (-2560, 0)',
          pins: [
            {
              id: 'pin-2',
              index: 2,
              bounds: { x: -2200, y: 300, width: 300, height: 200 },
              alwaysOnTop: false,
              clickThrough: true,
              opacity: 0.5
            }
          ]
        }
      ],
      actions: {
        focusPin: (id) => calls.push(['focus', id]),
        togglePinAlwaysOnTop: (id, enabled) => calls.push(['top', id, enabled]),
        exitPinClickThrough: (id) => calls.push(['exit', id])
      }
    }
  }
}

function buildMenu(options = {}) {
  const calls = []
  const template = buildTrayMenuTemplate({
    clipboardEnabled: true,
    executeFunction: (name) => calls.push(['execute', name]),
    setGameModeEnabled: () => {},
    openHistory: () => {},
    openMainWindow: () => {},
    showConversation: () => {},
    quit: () => {},
    ...options
  })
  return { template, calls }
}

// ---------------------------------------------------------------------------
// Domain: grouping
// ---------------------------------------------------------------------------

test('A07 groups open pins by display at 100% and 150%', () => {
  const { domain, screen } = createHarness()
  const primaryPin = pinAt(domain, { x: 100, y: 100 })
  const scaledPin = pinAt(domain, { x: -2200, y: 300 })
  const payload = withLanguage('zh-CN', () => domain.listPinsByDisplay())

  assert.equal(payload.displays.length, 2)
  const [first, second] = payload.displays
  assert.equal(first.id, 1)
  assert.equal(second.id, 2)
  assert.equal(first.workArea.width, 1920)
  assert.equal(first.scaleFactor, 1)
  assert.equal(second.scaleFactor, 1.5)
  assert.match(first.label, /1920×1080/)
  assert.match(first.label, /100%/)
  assert.match(first.label, /主屏/)
  assert.match(second.label, /2560×1440/)
  assert.match(second.label, /150%/)
  assert.match(second.label, /副屏/)
  assert.match(second.label, /-2560/)

  assert.equal(first.pins.length, 1)
  assert.equal(second.pins.length, 1)
  assert.equal(first.pins[0].id, primaryPin._pinId)
  assert.deepEqual(first.pins[0].bounds, { x: 100, y: 100, width: 200, height: 100 })
  assert.equal(first.pins[0].alwaysOnTop, true)
  assert.equal(first.pins[0].clickThrough, false)
  assert.equal(first.pins[0].opacity, 1)
  assert.equal(second.pins[0].id, scaledPin._pinId)
  assert.deepEqual(second.pins[0].bounds, { x: -2200, y: 300, width: 200, height: 100 })

  // Grouping consults Electron's match (the seam rule only overrides it).
  assert.ok(screen.state.queries >= 2)
  for (const action of ['focusPin', 'togglePinAlwaysOnTop', 'exitPinClickThrough']) {
    assert.equal(typeof payload.actions[action], 'function', action)
  }
})

test('A07 pins straddling the seam group under the display that owns their center', () => {
  const { domain } = createHarness()
  // Both boxes overlap both screens; only the center decides.
  const mostlyPrimary = pinAt(domain, { x: -140, y: 100, width: 300, height: 100 })
  const mostlySecondary = pinAt(domain, { x: -160, y: 300, width: 300, height: 100 })
  const payload = domain.listPinsByDisplay()
  const primaryGroup = payload.displays.find((display) => display.id === 1)
  const secondaryGroup = payload.displays.find((display) => display.id === 2)
  assert.deepEqual(primaryGroup.pins.map((pin) => pin.id), [mostlyPrimary._pinId])
  assert.deepEqual(secondaryGroup.pins.map((pin) => pin.id), [mostlySecondary._pinId])
})

test('A07 keeps pin numbering stable in creation order', () => {
  const { domain } = createHarness()
  const first = pinAt(domain, { x: 100, y: 100 })
  const second = pinAt(domain, { x: 400, y: 100 })
  const third = pinAt(domain, { x: -2200, y: 100 })
  const pins = payloadPins(domain.listPinsByDisplay())
  assert.deepEqual(pins.map((pin) => pin.index), [1, 2, 3])
  assert.deepEqual(pins.map((pin) => pin.id), [first._pinId, second._pinId, third._pinId])
})

test('A07 reflows and re-groups pins after a display is unplugged', () => {
  const { domain, screen } = createHarness()
  const primaryPin = pinAt(domain, { x: 100, y: 100 })
  const secondaryPin = pinAt(domain, { x: -2200, y: 300 })
  assert.equal(domain.listPinsByDisplay().displays.length, 2)

  screen.removeDisplay(2)

  const payload = domain.listPinsByDisplay()
  assert.equal(payload.displays.length, 1)
  assert.equal(payload.displays[0].id, 1)
  assert.deepEqual(
    payload.displays[0].pins.map((pin) => pin.id).sort(),
    [primaryPin._pinId, secondaryPin._pinId].sort(),
    'the rescued pin is still findable'
  )
  const bounds = secondaryPin.getBounds()
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 1920, 'clamped into the primary work area')
  assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 1040)
  assert.equal(secondaryPin._pinData.zoom, 1, 'the rescue does not zoom the image')
})

test('A07 display metrics changes clamp pins back into their work area', () => {
  const { domain, screen } = createHarness()
  const win = pinAt(domain, { x: 1800, y: 100, width: 100, height: 50 })
  // The taskbar grew / the resolution changed: the old right edge is now off-screen.
  screen.state.displays[0].workArea = { x: 0, y: 0, width: 1200, height: 800 }
  screen.emit('display-metrics-changed')
  const bounds = win.getBounds()
  assert.ok(bounds.x + bounds.width <= 1200)
  assert.ok(bounds.y + bounds.height <= 800)
  assert.equal(domain.listPinsByDisplay().displays[0].pins[0].id, win._pinId)
})

test('A07 all 20 pins stay findable and individually addressable', () => {
  const { domain } = createHarness()
  const wins = []
  for (let index = 0; index < 20; index += 1) {
    const onSecondary = index % 2 === 1
    wins.push(pinAt(domain, {
      x: onSecondary ? -2300 + index * 10 : 100 + index * 10,
      y: 100 + (index % 5) * 120,
      width: 120,
      height: 80
    }))
  }
  assert.equal(domain.getPinnedCount(), 20)
  const payload = domain.listPinsByDisplay()
  const pins = payloadPins(payload)
  assert.equal(pins.length, 20)
  assert.equal(new Set(pins.map((pin) => pin.id)).size, 20, 'every pin has a unique id')
  assert.deepEqual(pins.map((pin) => pin.index).sort((a, b) => a - b), Array.from({ length: 20 }, (_, index) => index + 1))
  assert.equal(payload.displays.length, 2, 'the 20-pin list still groups by display')

  // "找回指定窗口" at full capacity: the 17th pin can be pulled out of the stack.
  const target = wins[16]
  const located = domain.focusPin(target._pinId)
  assert.equal(located.id, target._pinId)
  assert.deepEqual(located.bounds, target.getBounds())
  assert.equal(domain.togglePinAlwaysOnTop(target._pinId, false), false)
  assert.equal(payloadPins(domain.listPinsByDisplay()).find((pin) => pin.id === target._pinId).alwaysOnTop, false)
})

// ---------------------------------------------------------------------------
// Domain: window-level actions
// ---------------------------------------------------------------------------

test('A07 locate/toggle/exit change window state only', () => {
  const { domain } = createHarness()
  const win = pinAt(domain, { x: 300, y: 200 })
  const id = win._pinId
  const before = { ...win._pinData }
  const boundsBefore = win.getBounds()
  const geometryCalls = win._bounds.length

  // Locate: show + raise + focus, no move and no resize.
  win._visible = false
  const located = domain.focusPin(id)
  assert.equal(located.id, id)
  assert.equal(win._visible, true)
  assert.ok(win._ops.includes('move-top'))
  assert.ok(win._ops.includes('focus'))
  assert.deepEqual(win.getBounds(), boundsBefore)
  assert.equal(win._bounds.length, geometryCalls)

  // Temporary un-top, idempotent because the tray states the value it wants.
  assert.equal(domain.togglePinAlwaysOnTop(id), false)
  assert.equal(win._pinData.alwaysOnTop, false)
  assert.deepEqual(win._topCalls.at(-1), { value: false, level: undefined })
  assert.equal(domain.togglePinAlwaysOnTop(id, false), false)
  assert.equal(win._pinData.alwaysOnTop, false)
  assert.equal(domain.togglePinAlwaysOnTop(id, true), true)
  assert.equal(win._pinData.alwaysOnTop, true)
  assert.deepEqual(win._topCalls.at(-1), { value: true, level: 'screen-saver' })
  assert.equal(domain.togglePinAlwaysOnTop(id, true), true)

  // Per-pin click-through exit.
  domain.setPinClickThrough(win, true)
  assert.equal(win._pinData.clickThrough, true)
  assert.equal(domain.exitPinClickThrough(id), true)
  assert.equal(win._pinData.clickThrough, false)
  assert.equal(win._ignoreMouse.at(-1).ignore, false)
  assert.equal(domain.exitPinClickThrough(id), false, 'idempotent')

  // Unknown ids are no-ops, never a crash.
  assert.equal(domain.focusPin('pin-window-missing'), null)
  assert.equal(domain.togglePinAlwaysOnTop('pin-window-missing'), null)
  assert.equal(domain.exitPinClickThrough('pin-window-missing'), false)

  // The image, opacity, zoom, rotation and geometry are exactly what they were.
  for (const key of ['imageId', 'imageBytes', 'pixelWidth', 'pixelHeight', 'baseWidth', 'baseHeight', 'zoom', 'opacity', 'rotation', 'displayScaleFactor']) {
    assert.equal(win._pinData[key], before[key], key + ' must not change')
  }
  assert.deepEqual(win.getBounds(), boundsBefore)
})

test('A07 locate recovers a pin whose display disappeared before the event', () => {
  const { domain, screen } = createHarness()
  const win = pinAt(domain, { x: -2200, y: 300 })
  // Simulate a screen list that no longer knows the pin's display, without firing the
  // display event: locate is the manual recovery path.
  screen.state.displays = [primaryDisplay()]
  assert.equal(domain.focusPin(win._pinId).bounds.x >= 0, true)
  assert.ok(win.getBounds().x >= 0)
  assert.ok(win.getBounds().x + win.getBounds().width <= 1920)
})

// ---------------------------------------------------------------------------
// Domain: end-of-drag snap
// ---------------------------------------------------------------------------

test('A07 snaps once at drag end, within 8 DIP, and never resizes', () => {
  const { domain, handlers } = createHarness()
  const left = pinAt(domain, { x: 100, y: 100 })
  const right = pinAt(domain, { x: 308, y: 100 })
  left.show()
  right.show()
  const before = { ...right._pinData }
  const start = handlers.get('pin:move-start')
  const end = handlers.get('pin:move-end')

  // No drag in flight: a stray move-end must not snap.
  end({ sender: right.webContents }, { altKey: false })
  assert.equal(right.getBounds().x, 308)

  start({ sender: right.webContents })
  end({ sender: right.webContents }, { altKey: false })
  assert.deepEqual(right.getBounds(), { x: 300, y: 100, width: 200, height: 100 })
  assert.ok(Math.abs((left.getBounds().x + left.getBounds().width) - right.getBounds().x) <= 1)
  assert.equal(right.getBounds().width, 200, 'the snap never resizes the window')
  assert.equal(right.getBounds().height, 100)

  // Alt keeps the exact drop position.
  right.setBounds({ x: 308, y: 100, width: 200, height: 100 })
  start({ sender: right.webContents })
  end({ sender: right.webContents }, { altKey: true })
  assert.equal(right.getBounds().x, 308)

  for (const key of ['imageId', 'opacity', 'zoom', 'rotation', 'pixelWidth', 'pixelHeight', 'baseWidth', 'baseHeight']) {
    assert.equal(right._pinData[key], before[key], key + ' must survive a snap')
  }
})

test('A07 snap entry point honours the injected preference', () => {
  let enabled = false
  const { domain } = createHarness({ isPinSnapEnabled: () => enabled })
  const left = pinAt(domain, { x: 100, y: 100 })
  const right = pinAt(domain, { x: 308, y: 100 })
  left.show()
  right.show()

  const disabled = domain.applySnapOnDragEnd(right._pinId, false)
  assert.equal(disabled.reason, 'disabled')
  assert.equal(right.getBounds().x, 308)

  enabled = true
  const applied = domain.applySnapOnDragEnd(right._pinId, false)
  assert.equal(applied.snapped, true)
  assert.equal(right.getBounds().x, 300)

  // Explicit Alt still skips even when the policy is on.
  right.setBounds({ x: 308, y: 100, width: 200, height: 100 })
  assert.equal(domain.applySnapOnDragEnd(right._pinId, true).reason, 'alt')
  assert.equal(right.getBounds().x, 308)
})

// ---------------------------------------------------------------------------
// Tray menu contract
// ---------------------------------------------------------------------------

test('A07 the pin finder only appears while a pin exists', () => {
  const withoutPins = buildMenu()
  assert.equal(withoutPins.template.some((item) => item.label === t('main.tray.pinned-displays', { count: 1 })), false)

  const empty = buildMenu({ pinnedDisplays: { displays: [], actions: {} } })
  assert.equal(empty.template.some((item) => typeof item.label === 'string' && item.label.startsWith(t('main.tray.pinned-displays', { count: 0 }).split('（')[0])), false)

  const { payload } = pinPayload()
  const { template } = buildMenu({ pinnedDisplays: payload })
  const entry = template.find((item) => item.label === t('main.tray.pinned-displays', { count: 2 }))
  assert.ok(entry, 'the group entry exists once a pin is open')
  assert.equal(entry.enabled, true, 'window management survives game mode')
})

test('A07 the tray nests display > pin > locate/un-top/exit', () => {
  const { payload, calls } = pinPayload()
  const { template } = buildMenu({ pinnedDisplays: payload })
  const entry = template.find((item) => item.label === t('main.tray.pinned-displays', { count: 2 }))
  const [primaryGroup, secondaryGroup] = entry.submenu
  assert.equal(primaryGroup.label, payload.displays[0].label)
  assert.equal(secondaryGroup.label, payload.displays[1].label)

  const firstPin = primaryGroup.submenu[0]
  const secondPin = secondaryGroup.submenu[0]
  assert.equal(firstPin.label, t('main.tray.pin-item', { index: 1, width: 200, height: 100 }))
  assert.equal(secondPin.label, t('main.tray.pin-item-click-through', { index: 2, width: 300, height: 200 }))

  const [locate, alwaysOnTop, exit] = firstPin.submenu
  assert.equal(locate.label, t('main.tray.pin-focus'))
  assert.equal(alwaysOnTop.label, t('main.tray.pin-always-on-top-off'), 'a topped pin offers to un-top')
  assert.equal(exit.label, t('main.tray.pin-exit-click-through'))
  assert.equal(exit.enabled, false, 'an opaque pin has nothing to exit')

  const secondActions = secondPin.submenu
  assert.equal(secondActions[1].label, t('main.tray.pin-always-on-top-on'), 'an un-topped pin offers to restore')
  assert.equal(secondActions[2].enabled, true, 'a click-through pin can exit')

  locate.click()
  alwaysOnTop.click()
  secondActions[1].click()
  secondActions[2].click()
  assert.deepEqual(calls, [
    ['focus', 'pin-1'],
    ['top', 'pin-1', false],
    ['top', 'pin-2', true],
    ['exit', 'pin-2']
  ])
})

test('A07 pin actions fall back to the router names', () => {
  const { payload } = pinPayload()
  delete payload.actions
  const { template, calls } = buildMenu({ pinnedDisplays: payload })
  const entry = template.find((item) => item.label === t('main.tray.pinned-displays', { count: 2 }))
  const firstPin = entry.submenu[0].submenu[0]
  firstPin.submenu[0].click()
  firstPin.submenu[1].click()
  entry.submenu[1].submenu[0].submenu[2].click()
  assert.deepEqual(calls, [
    ['execute', 'focusPin'],
    ['execute', 'togglePinAlwaysOnTop'],
    ['execute', 'exitPinClickThrough']
  ])
})

test('A07 every pin/dock label resolves in all three languages', () => {
  const keys = [
    'main.tray.pinned-displays',
    'main.tray.pin-item',
    'main.tray.pin-item-click-through',
    'main.tray.pin-focus',
    'main.tray.pin-always-on-top-off',
    'main.tray.pin-always-on-top-on',
    'main.tray.pin-exit-click-through',
    'main.tray.pin-display-label',
    'main.tray.pin-display-primary',
    'main.tray.pin-display-secondary'
  ]
  const rendered = new Map()
  for (const language of LANGUAGES) {
    const labels = withLanguage(language, () => {
      for (const key of keys) {
        const value = t(key, { count: 2, index: 1, width: 200, height: 100, scale: 150, role: 'role', x: -2560, y: 0 })
        assert.doesNotMatch(value, /^main\./, language + ': ' + key + ' fell back to its key')
      }
      const { payload } = pinPayload()
      payload.displays[0].label = displayLabel({ ...primaryDisplay(), primary: true }, 0)
      payload.displays[1].label = displayLabel({ ...secondaryDisplay(), primary: false }, 1)
      const { template } = buildMenu({ pinnedDisplays: payload })
      const entry = template.find((item) => item.label === t('main.tray.pinned-displays', { count: 2 }))
      return {
        entry: entry.label,
        groups: entry.submenu.map((group) => group.label),
        items: entry.submenu.flatMap((group) => group.submenu.map((pin) => pin.label))
      }
    })
    assert.match(labels.groups[0], /1920×1080/)
    assert.match(labels.groups[0], /100%/)
    assert.match(labels.groups[1], /2560×1440/)
    assert.match(labels.groups[1], /150%/)
    assert.match(labels.groups[1], /\(-2560, 0\)/, language + ': the negative origin stays readable')
    rendered.set(language, labels)
  }
  assert.notDeepEqual(rendered.get('zh-CN'), rendered.get('en-US'))
  assert.notDeepEqual(rendered.get('en-US'), rendered.get('zh-TW'))
})

// ---------------------------------------------------------------------------
// Source contract
// ---------------------------------------------------------------------------

test('A07 source contract keeps the wiring and the three-language copy honest', () => {
  const pinSource = fs.readFileSync(path.join(root, 'main/domains/pin/index.js'), 'utf8')
  const traySource = fs.readFileSync(path.join(root, 'main/services/tray-menu.js'), 'utf8')
  const geometrySource = fs.readFileSync(path.join(root, 'main/services/pin-geometry.js'), 'utf8')

  assert.match(pinSource, /require\('\.\.\/\.\.\/services\/pin-geometry'\)/)
  for (const name of ['listPinsByDisplay', 'focusPin', 'togglePinAlwaysOnTop', 'exitPinClickThrough', 'applySnapOnDragEnd']) {
    assert.match(pinSource, new RegExp('function ' + name + '\\('), name + ' is a domain function')
    assert.match(pinSource, new RegExp('\\b' + name + '\\b'), name + ' is referenced')
  }
  assert.match(pinSource, /screen\.getDisplayMatching/)
  assert.match(pinSource, /pickDisplayForBounds/)
  assert.match(pinSource, /displayLabel/)
  assert.match(pinSource, /ipcMain\.on\('pin:move-end'[\s\S]*applySnapOnDragEnd/)

  assert.match(traySource, /pinnedDisplays/)
  for (const key of [
    'main.tray.pinned-displays',
    'main.tray.pin-item',
    'main.tray.pin-item-click-through',
    'main.tray.pin-focus',
    'main.tray.pin-always-on-top-off',
    'main.tray.pin-always-on-top-on',
    'main.tray.pin-exit-click-through'
  ]) {
    assert.ok(traySource.includes(`t('${key}'`), key + ' is rendered through t()')
  }
  assert.doesNotMatch(traySource, /[\u4e00-\u9fff]/, 'tray-menu.js must not hard-code CJK copy')

  for (const key of ['main.tray.pin-display-label', 'main.tray.pin-display-primary', 'main.tray.pin-display-secondary']) {
    assert.ok(geometrySource.includes(`t('${key}'`), key + ' is rendered through t()')
  }
  assert.doesNotMatch(geometrySource, /require\('electron'\)/, 'pin-geometry stays Electron-free')

  const tables = globalThis.__LOCALES
  for (const language of LANGUAGES) {
    for (const key of [
      'main.tray.pinned-displays',
      'main.tray.pin-display-label',
      'main.tray.pin-display-primary',
      'main.tray.pin-display-secondary',
      'main.tray.pin-item',
      'main.tray.pin-item-click-through',
      'main.tray.pin-focus',
      'main.tray.pin-always-on-top-off',
      'main.tray.pin-always-on-top-on',
      'main.tray.pin-exit-click-through'
    ]) {
      assert.equal(typeof tables[language][key], 'string', language + ': ' + key)
    }
  }
})
