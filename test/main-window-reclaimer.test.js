'use strict'

// M2/W6b: the main-window reclaimer is the only path that may destroy a hidden
// main window, so these tests pin the conservative half of the contract:
//   - five idle minutes, hidden, CLEAN renderer, SAFE route, no lease, no busy
//     signal - all of them required;
//   - the route is recorded at destruction and restored exactly once;
//   - the renderer report is validated field by field.
// They are pure node tests: no Electron, no timers (both are injected).

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const {
  DEFAULT_TIMEOUT_MS,
  RENDERER_ROUTES,
  SAFE_ROUTES,
  createRendererWindowState,
  createMainWindowReclaimer,
  createMainWindowReclaim
} = require('../main/services/main-window-reclaimer')
const { registerWindowReclaimIpc } = require('../main/ipc/window-reclaim-ipc')

const ROOT = path.join(__dirname, '..')
const MINUTE = 60 * 1000

function createClock() {
  let time = 0
  const timers = []
  return {
    setTimer(fn, ms) {
      const timer = { fn, at: time + ms, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimer(timer) {
      if (timer) timer.cleared = true
    },
    now: () => time,
    advance(ms) {
      time += ms
      for (const timer of timers.slice()) {
        if (!timer.cleared && timer.at <= time) {
          timer.cleared = true
          timer.fn()
        }
      }
    }
  }
}

function createWindow({ visible = false } = {}) {
  const win = {
    visible,
    destroyed: false,
    destroyCount: 0,
    webContents: { id: 'main-web-contents' },
    isDestroyed() { return win.destroyed },
    isVisible() { return win.visible },
    destroy() { win.destroyed = true; win.destroyCount += 1 }
  }
  return win
}

function createHarness({ state, win, isBusy, shouldReclaim, onReclaim, timeoutMs } = {}) {
  const clock = createClock()
  const windowState = state || createRendererWindowState({ now: clock.now })
  const window = win === undefined ? createWindow() : win
  const reclaimer = createMainWindowReclaimer({
    getWindow: () => window,
    state: windowState,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    now: clock.now,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(isBusy === undefined ? {} : { isBusy }),
    ...(shouldReclaim === undefined ? {} : { shouldReclaim }),
    ...(onReclaim === undefined ? {} : { onReclaim })
  })
  return { clock, state: windowState, win: window, reclaimer }
}

test('a hidden clean main window is reclaimed after five minutes and its route is restored once', () => {
  const { clock, win, reclaimer, state } = createHarness()
  assert.equal(DEFAULT_TIMEOUT_MS, 5 * MINUTE)
  state.set({ route: 'history', dirty: false })

  assert.equal(reclaimer.arm(), true)
  clock.advance(5 * MINUTE - 1)
  assert.equal(win.destroyCount, 0, 'not a moment before the idle timeout')
  assert.equal(reclaimer.getLastOutcome(), null)

  clock.advance(1)
  assert.equal(win.destroyCount, 1)
  assert.equal(reclaimer.getLastOutcome(), 'fired')
  assert.equal(reclaimer.peekPendingRoute(), 'history')
  // The recorded state must not survive into the rebuilt window as "current".
  assert.deepEqual(reclaimer.getState().get(), { route: 'home', dirty: false, dirtyReason: '', updatedAt: 0 })

  assert.equal(reclaimer.resolveInitialRoute('home'), 'history')
  assert.equal(reclaimer.peekPendingRoute(), null)
  assert.equal(reclaimer.resolveInitialRoute('home'), 'home', 'the restored route is consumed exactly once')
})

test('a visible or already destroyed window is never reclaimed', () => {
  const visible = createHarness({ win: createWindow({ visible: true }) })
  visible.reclaimer.arm()
  visible.clock.advance(5 * MINUTE)
  assert.equal(visible.win.destroyCount, 0)
  assert.equal(visible.reclaimer.getLastOutcome(), 'skipped')

  const destroyed = createWindow()
  destroyed.destroyed = true
  const gone = createHarness({ win: destroyed })
  gone.reclaimer.arm()
  gone.clock.advance(5 * MINUTE)
  assert.equal(destroyed.destroyCount, 0)
  assert.equal(gone.reclaimer.peekPendingRoute(), null)
})

test('a dirty renderer report blocks the reclaim even on a safe route', () => {
  const { clock, win, reclaimer, state } = createHarness()
  state.set({ route: 'home', dirty: true, dirtyReason: 'local-search-categories' })
  reclaimer.arm()
  clock.advance(5 * MINUTE)
  assert.equal(win.destroyCount, 0)
  assert.equal(reclaimer.getLastOutcome(), 'skipped')
  assert.equal(reclaimer.peekPendingRoute(), null)
})

test('settings-like routes are not reclaimed even when the renderer reports clean', () => {
  const unsafe = RENDERER_ROUTES.filter((route) => !SAFE_ROUTES.includes(route))
  assert.ok(unsafe.length > 0)
  for (const route of ['settings-general', 'models', 'local-search', 'settings-system', 'selection-toolbar', 'clipboard-history', 'recording']) {
    const { clock, win, reclaimer, state } = createHarness()
    state.set({ route, dirty: false })
    reclaimer.arm()
    clock.advance(5 * MINUTE)
    assert.equal(win.destroyCount, 0, `route ${route} must stay warm`)
    assert.equal(reclaimer.getLastOutcome(), 'skipped', `route ${route} must report skipped`)
  }
  for (const route of ['home', 'history', 'usage', 'translation', 'chat', 'about']) {
    assert.ok(SAFE_ROUTES.includes(route))
    assert.ok(RENDERER_ROUTES.includes(route))
  }
})

test('a held lease blocks the reclaim until it is released and the window hides again', () => {
  const { clock, win, reclaimer } = createHarness()
  const release = reclaimer.acquireLease('export')
  reclaimer.arm()
  clock.advance(5 * MINUTE)
  assert.equal(win.destroyCount, 0)
  assert.equal(reclaimer.getLastOutcome(), 'skipped')

  release()
  reclaimer.arm()
  clock.advance(5 * MINUTE)
  assert.equal(win.destroyCount, 1)
})

test('a main-process busy signal (data-root migration / recording) blocks the reclaim', () => {
  const { clock, win, reclaimer } = createHarness({ isBusy: () => true })
  reclaimer.arm()
  clock.advance(5 * MINUTE)
  assert.equal(win.destroyCount, 0)

  // A throwing busy probe counts as busy: safety beats the memory win.
  const throwing = createHarness({ isBusy: () => { throw new Error('store not ready') } })
  throwing.reclaimer.arm()
  throwing.clock.advance(5 * MINUTE)
  assert.equal(throwing.win.destroyCount, 0)
})

test('the reclaim handler receives the recorded route and a throwing handler records nothing', () => {
  const calls = []
  const ok = createHarness({
    onReclaim: (win, details) => { calls.push({ win, details }); win.destroy() }
  })
  ok.state.set({ route: 'usage', dirty: false })
  ok.reclaimer.arm()
  ok.clock.advance(5 * MINUTE)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].details.route, 'usage')
  assert.equal(calls[0].win.destroyCount, 1)
  assert.equal(ok.reclaimer.peekPendingRoute(), 'usage')

  const failing = createHarness({ onReclaim: () => { throw new Error('destroy failed') } })
  failing.state.set({ route: 'chat', dirty: false })
  failing.reclaimer.arm()
  failing.clock.advance(5 * MINUTE)
  assert.equal(failing.reclaimer.peekPendingRoute(), null, 'a failed destroy has no route to restore')
  assert.equal(failing.reclaimer.getState().getRoute(), 'chat', 'state is kept while the window survives')
})

test('an explicit non-home rebuild request wins and leaves the pending route for later', () => {
  const { clock, reclaimer, state } = createHarness()
  state.set({ route: 'history', dirty: false })
  reclaimer.arm()
  clock.advance(5 * MINUTE)
  assert.equal(reclaimer.resolveInitialRoute('usage'), 'usage')
  assert.equal(reclaimer.peekPendingRoute(), 'history')
  assert.equal(reclaimer.resolveInitialRoute('home'), 'history')
  assert.equal(reclaimer.peekPendingRoute(), null)
})

test('renderer window state keeps the route on partial updates, drops a stale reason and clears', () => {
  const clock = createClock()
  const state = createRendererWindowState({ now: clock.now })
  assert.deepEqual(state.get(), { route: 'home', dirty: false, dirtyReason: '', updatedAt: 0 })

  state.set({ route: 'translation', dirty: true, dirtyReason: 'migration' })
  assert.deepEqual(state.get(), { route: 'translation', dirty: true, dirtyReason: 'migration', updatedAt: 0 })
  state.set({ dirty: false })
  assert.deepEqual(state.get(), { route: 'translation', dirty: false, dirtyReason: '', updatedAt: 0 })
  state.set({ route: 42, dirty: false })
  assert.equal(state.get().route, 'translation', 'a non-string route never replaces the last known route')

  state.clear()
  assert.deepEqual(state.get(), { route: 'home', dirty: false, dirtyReason: '', updatedAt: 0 })
})

test('dispose clears the state and disarms the timer', () => {
  const { clock, win, reclaimer, state } = createHarness()
  state.set({ route: 'home', dirty: false })
  reclaimer.arm()
  reclaimer.dispose()
  assert.equal(reclaimer.isDisposed(), true)
  assert.equal(reclaimer.isArmed(), false)
  clock.advance(5 * MINUTE)
  assert.equal(win.destroyCount, 0)
  assert.equal(state.get().route, 'home')
  assert.equal(reclaimer.arm(), false, 'a disposed reclaimer cannot be re-armed')
})

test('the bootstrap wires the IPC listener to the state the reclaimer evaluates', () => {
  const listeners = new Map()
  const ipcMain = { on: (channel, listener) => listeners.set(channel, listener) }
  const win = createWindow()
  const reclaim = createMainWindowReclaim({ ipcMain, getWindow: () => win })

  assert.ok(listeners.has('window:renderer-state'))
  const report = listeners.get('window:renderer-state')
  assert.equal(report({ sender: win.webContents }, { route: 'models', dirty: true, dirtyReason: 'provider-editor' }), true)
  assert.deepEqual(reclaim.getState().get().route, 'models')
  assert.equal(reclaim.getState().isDirty(), true)
  // Safe-route barrier is enforced by the reclaimer itself, not only by the IPC.
  assert.equal(reclaim.arm(), true)
})

test('the renderer route whitelist stays aligned with the config shell dispatch table', () => {
  const shell = fs.readFileSync(path.join(ROOT, 'config', 'config.js'), 'utf8')
  const block = shell.match(/const routes = \{([\s\S]*?)\n\}/)
  assert.ok(block, 'config/config.js must keep a literal routes dispatch table')
  const dispatchRoutes = [...block[1].matchAll(/(?:^|\n)\s+'?([a-z][a-z-]*)'?: \{/g)].map((match) => match[1])
  assert.deepEqual(RENDERER_ROUTES, dispatchRoutes)

  assert.ok(SAFE_ROUTES.every((route) => RENDERER_ROUTES.includes(route)))
  assert.ok(SAFE_ROUTES.length < RENDERER_ROUTES.length)
  for (const unsafe of ['settings-general', 'models', 'local-search', 'settings-system', 'clipboard-history', 'selection-toolbar']) {
    assert.equal(SAFE_ROUTES.includes(unsafe), false, `${unsafe} owns drafts and must not be reclaimable`)
    assert.ok(RENDERER_ROUTES.includes(unsafe))
  }

  // The shell must expose the dirty reporter and the two route files must use it.
  assert.match(shell, /window\.setConfigDirty = setConfigDirty/)
  const localSearch = fs.readFileSync(path.join(ROOT, 'config', 'routes', 'local-search.js'), 'utf8')
  const modelsProvider = fs.readFileSync(path.join(ROOT, 'config', 'routes', 'models-provider.js'), 'utf8')
  assert.match(localSearch, /setConfigDirty\?\.\('local-search-categories', true\)/)
  assert.match(modelsProvider, /setConfigDirty\?\.\('models-provider-editor', true\)/)
  const preload = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8')
  assert.match(preload, /window:renderer-state/)
})

test('main.js arms on hide and consumes the restored route without direct IPC wiring', () => {
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8')
  assert.match(main, /createMainWindowReclaim\(\{ ipcMain: secureIpcMain/)
  assert.match(main, /route = mainWindowReclaim\.resolveInitialRoute\(route\)/)
  assert.match(main, /win\?\.hide\(\); if \(win\) mainWindowReclaim\.arm\(\)/)
  assert.doesNotMatch(main, /secureIpcMain\.on\('window:renderer-state'/)
})
