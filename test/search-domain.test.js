// W5 (M2 memory optimization): the search window gives its renderer back after
// being hidden for a minute, and a rebuilt window restores the query/category/
// sort mirror. These tests drive the real domain with a fake BrowserWindow and a
// fake clock, so no Electron process is required.
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { EventEmitter } = require('node:events')

const { createSearchDomain } = require('../main/domains/search')

function createFakeClock() {
  let nowMs = 0
  const timers = []
  return {
    now: () => nowMs,
    setTimer: (fn, ms) => {
      const timer = { fn, at: nowMs + ms, cleared: false, fired: false }
      timers.push(timer)
      return timer
    },
    clearTimer: (timer) => { if (timer) timer.cleared = true },
    advance: (ms) => {
      nowMs += ms
      for (const timer of timers) {
        if (timer.cleared || timer.fired) continue
        if (timer.at <= nowMs) {
          timer.fired = true
          timer.fn()
        }
      }
    },
    pending: () => timers.filter((timer) => !timer.cleared && !timer.fired).length
  }
}

function createFakeWindow(pagePath) {
  const win = new EventEmitter()
  win.pagePath = pagePath
  win.destroyed = false
  win.visible = false
  win.shown = 0
  win.focused = 0
  win.destroyedCount = 0
  win.sent = []
  win.webContents = {
    send: (channel, payload) => win.sent.push({ channel, payload }),
    once: () => {}
  }
  win.webContents.win = win
  win.isDestroyed = () => win.destroyed
  win.isVisible = () => win.visible
  win.show = () => {
    win.visible = true
    win.shown += 1
  }
  win.focus = () => { win.focused += 1 }
  win.hide = () => { win.visible = false }
  win.getSize = () => [840, 620]
  win.setPosition = () => {}
  win.loadFile = () => {}
  win.destroy = () => {
    win.destroyed = true
    win.visible = false
    win.destroyedCount += 1
    win.emit('closed')
  }
  return win
}

function createSettings() {
  return {
    mainColor: '#e5a44c',
    theme: 'light',
    search: {
      matchPath: true,
      maxResults: 600,
      pageSize: 30,
      sortMode: 'modified-desc',
      categories: [
        { id: 'all', label: 'search.category.all', rule: '' },
        { id: 'excel', label: 'EXCEL', rule: 'ext:xls;xlsx' },
        { id: 'folder', label: 'search.category.folder', rule: 'folder:' }
      ]
    }
  }
}

function createHarness(overrides = {}) {
  const clock = createFakeClock()
  const settings = overrides.settings || createSettings()
  const windows = []
  const events = []
  let gameMode = false
  const deps = {
    path,
    rootDirectory: path.join('C:', 'Highlighter'),
    screen: {
      getCursorScreenPoint: () => ({ x: 10, y: 10 }),
      getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } })
    },
    clipboard: { writeText: () => {} },
    nativeTheme: { shouldUseDarkColors: false },
    shell: { showItemInFolder: () => {}, openPath: async () => '' },
    BrowserWindow: { fromWebContents: (sender) => (sender && sender.win) || null },
    createLocalWindow: (pagePath) => {
      const win = createFakeWindow(pagePath)
      windows.push(win)
      return win
    },
    getSettings: () => settings,
    log: (event, details) => events.push({ event, details }),
    assertGameModeDisabled: () => { if (gameMode) throw new Error('game mode is enabled') },
    isGameModeEnabled: () => gameMode,
    getEverythingService: () => ({
      query: async () => ({ items: [], total: 0 }),
      refreshStatus: () => ({ phase: 'ready' }),
      ensureReady: async () => ({ phase: 'ready' })
    }),
    positionAutomationWindow: () => {},
    getSearchFileIcon: async () => null,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    now: clock.now,
    ...overrides
  }
  delete deps.settings
  const domain = createSearchDomain(deps)
  const controller = domain.createSearchController()
  return {
    domain,
    controller,
    clock,
    settings,
    windows,
    events,
    setGameMode: (value) => { gameMode = value }
  }
}

// The renderer's handshake: it asks for init and the controller shows the window.
function openSearch(harness) {
  const win = harness.domain.createSearchWindow()
  harness.controller.ready({ sender: win.webContents })
  return win
}

test('blur hides the window and destroys it once the 60s release elapses', () => {
  const harness = createHarness()
  const win = openSearch(harness)
  assert.equal(win.isVisible(), true, 'ready shows the window')

  win.emit('blur')
  assert.equal(win.isVisible(), false, 'blur still only hides immediately')
  assert.equal(harness.clock.pending(), 1, 'the release is scheduled')

  harness.clock.advance(59999)
  assert.equal(win.isDestroyed(), false, 'nothing happens before the timeout')
  assert.equal(harness.domain.getCurrentWindow(), win)
  assert.equal(win.destroyedCount, 0)

  harness.clock.advance(1)
  assert.equal(win.isDestroyed(), true, 'the renderer is given back after 60s')
  assert.equal(harness.domain.getCurrentWindow(), null)
  assert.equal(win.destroyedCount, 1)
  assert.ok(harness.events.some((entry) => entry.event === 'reclaim-fired'))
  assert.ok(harness.events.some((entry) => entry.event === 'Search window reclaimed:' && entry.details.destroyed === true))
})

test('showing again before the timer disarms it and keeps the window alive', () => {
  const harness = createHarness()
  const win = openSearch(harness)

  win.emit('blur')
  harness.clock.advance(30000)
  assert.equal(harness.domain.showSearchWindow(), true)
  assert.equal(win.isVisible(), true)
  assert.equal(harness.clock.pending(), 0, 'the show path disarms the release')

  win.emit('blur')
  harness.clock.advance(1000)
  harness.controller.ready({ sender: win.webContents })
  harness.clock.advance(120000)

  assert.equal(win.isDestroyed(), false)
  assert.equal(harness.domain.getCurrentWindow(), win)
  assert.equal(win.destroyedCount, 0)
})

test('controller.close hides and schedules the same release', () => {
  const harness = createHarness()
  const win = openSearch(harness)

  harness.controller.close({ sender: win.webContents })
  assert.equal(win.isVisible(), false)
  assert.equal(harness.clock.pending(), 1)

  harness.clock.advance(60000)
  assert.equal(win.isDestroyed(), true)
  assert.equal(harness.domain.getCurrentWindow(), null)
})

test('the create-search-window toggle schedules a release when it hides', () => {
  const harness = createHarness()
  const win = openSearch(harness)

  harness.domain.createSearchWindow()
  assert.equal(win.isVisible(), false, 'the visible window is toggled off')
  harness.clock.advance(60000)
  assert.equal(win.isDestroyed(), true)
})

test('repeated hide does not stack release timers or destroy twice', () => {
  const harness = createHarness()
  const win = openSearch(harness)

  win.emit('blur')
  harness.domain.hideSearchWindow()
  harness.controller.close({ sender: win.webContents })
  assert.equal(harness.clock.pending(), 1, 'a single armed release remains')

  harness.clock.advance(60000)
  assert.equal(harness.domain.getCurrentWindow(), null)
  assert.equal(win.destroyedCount, 1)
  assert.equal(harness.events.filter((entry) => entry.event === 'reclaim-fired').length, 1)

  // Hiding again after the reclaim is a no-op, not a crash.
  assert.doesNotThrow(() => harness.domain.hideSearchWindow())
  assert.equal(harness.clock.pending(), 0)
})

test('valid query state is mirrored and invalid fields are ignored', () => {
  const harness = createHarness()
  const win = openSearch(harness)
  const saved = { keyword: '报告', categoryId: 'excel', sortMode: 'name-asc', matchPath: false }

  assert.equal(harness.controller.saveState({ sender: win.webContents }, saved), true)
  assert.deepEqual(harness.domain.getLastSearchState(), saved)
  assert.deepEqual(harness.domain.getSearchWindowInitPayload().restore, saved)

  // Out-of-range keyword and unknown category: both dropped, previous values kept.
  assert.equal(harness.controller.saveState({ sender: win.webContents }, {
    keyword: 'x'.repeat(2049),
    categoryId: 'not-a-category'
  }), false)
  assert.deepEqual(harness.domain.getLastSearchState(), saved)

  // Unknown sort mode and non-boolean matchPath are also rejected.
  assert.equal(harness.controller.saveState({ sender: win.webContents }, {
    sortMode: 'random',
    matchPath: 'yes'
  }), false)
  assert.deepEqual(harness.domain.getLastSearchState(), saved)

  // A valid partial update is merged, and the keyword boundary is inclusive.
  assert.equal(harness.controller.saveState({ sender: win.webContents }, { categoryId: 'folder' }), true)
  assert.deepEqual(harness.domain.getLastSearchState(), { ...saved, categoryId: 'folder' })
  assert.equal(harness.controller.saveState({ sender: win.webContents }, { keyword: 'k'.repeat(2048) }), true)
  assert.equal(harness.domain.getLastSearchState().keyword.length, 2048)
})

test('state from another window, a destroyed window, or a non-object is ignored', () => {
  const harness = createHarness()
  const win = openSearch(harness)
  harness.controller.saveState({ sender: win.webContents }, { keyword: 'ok' })

  const stranger = createFakeWindow('other')
  assert.equal(harness.controller.saveState({ sender: stranger.webContents }, { keyword: 'hijack' }), false)
  assert.equal(harness.controller.saveState({}, { keyword: 'hijack' }), false)
  assert.equal(harness.controller.saveState({ sender: win.webContents }, null), false)
  assert.equal(harness.controller.saveState({ sender: win.webContents }, ['not', 'an', 'object']), false)
  assert.equal(harness.domain.getLastSearchState().keyword, 'ok')

  win.emit('blur')
  harness.clock.advance(60000)
  assert.equal(win.isDestroyed(), true)
  assert.equal(harness.controller.saveState({ sender: win.webContents }, { keyword: 'stale' }), false)
  assert.equal(harness.domain.getLastSearchState().keyword, 'ok')
})

test('a rebuilt window receives the retained state in its init payload', () => {
  const harness = createHarness()
  const first = openSearch(harness)
  const saved = { keyword: 'invoice', categoryId: 'folder', sortMode: 'size-desc', matchPath: true }
  harness.controller.saveState({ sender: first.webContents }, saved)

  first.emit('blur')
  harness.clock.advance(60000)
  assert.equal(first.isDestroyed(), true)
  assert.deepEqual(harness.domain.getLastSearchState(), saved, 'the mirror survives the reclaim')

  const rebuilt = harness.domain.createSearchWindow()
  assert.notEqual(rebuilt, first)
  assert.deepEqual(harness.domain.getSearchWindowInitPayload().restore, saved)

  harness.controller.ready({ sender: rebuilt.webContents })
  const initMessages = rebuilt.sent.filter((message) => message.channel === 'search:init')
  assert.equal(initMessages.length, 1)
  assert.deepEqual(initMessages[0].payload.restore, saved)
  assert.equal(rebuilt.isVisible(), true)
})

test('windowReleaseMs: 0 disables reclaiming and keeps the warm window', () => {
  const harness = createHarness({ windowReleaseMs: 0 })
  const win = openSearch(harness)

  win.emit('blur')
  harness.domain.hideSearchWindow()
  harness.clock.advance(10 * 60000)

  assert.equal(harness.clock.pending(), 0)
  assert.equal(win.isDestroyed(), false)
  assert.equal(harness.domain.getCurrentWindow(), win)

  harness.controller.ready({ sender: win.webContents })
  assert.equal(win.isVisible(), true, 'reopening reuses the same hidden window')
})
