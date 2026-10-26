'use strict'

// M2/W6b (conservative): after the main window is hidden for a while the main
// process may destroy its renderer to give the memory back. Rebuilding goes
// through createMainWindow(), which restores the route recorded at reclaim time.
//
// The rule is "never lose a draft", so the policy is deliberately one-sided:
//   - the renderer is untrusted about *when* to reclaim but trusted to report its
//     own state (route + dirty); a report it never sends leaves the old state in
//     place, and the old state cannot be dirty;
//   - destruction additionally requires a route on SAFE_ROUTES. Settings-like
//     routes (local-search category editor, models provider editor, the settings
//     pages) are NOT reclaimed in v1 even when they report clean - the renderer
//     has no beforeunload hook we could rely on;
//   - a held lease or a main-process busy signal (data-root migration) always
//     wins: the timer fire is skipped, not retried. The caller re-arms on the next
//     hide, and the reclaimer re-checks every predicate when it fires.
const { createIdleReclaimer } = require('./idle-reclaimer')
const { createLeaseTracker } = require('./window-leases')

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

// Must stay aligned with the dispatch table in config/config.js (`routes` keys);
// test/main-window-reclaimer.test.js diffs the two sources so a new route cannot
// silently become un-restorable (or, worse, implicitly reclaimable).
const RENDERER_ROUTES = Object.freeze([
  'home',
  'translation',
  'chat',
  'history',
  'settings-general',
  'models',
  'settings-function',
  'selection-toolbar',
  'local-search',
  'clipboard-history',
  'usage',
  'settings-system',
  'about'
])

// v1: the six low-risk pages. Anything with an editor draft or a settings form
// stays warm on purpose; see main/ipc/window-reclaim-ipc.js for the second
// barrier (the route has to be on this list AND the renderer has to be clean).
const SAFE_ROUTES = Object.freeze(['home', 'history', 'usage', 'translation', 'chat', 'about'])

const MAX_ROUTE_REASON_LENGTH = 120

// The main window's last reported renderer state. `route` is only ever written
// from the IPC validator (route already on RENDERER_ROUTES); `clear()` resets it
// after destruction so a rebuilt window never inherits a stale route as "pending".
function createRendererWindowState({ now = () => Date.now() } = {}) {
  let current = { route: 'home', dirty: false, dirtyReason: '', updatedAt: 0 }

  function set(next = {}) {
    const route = typeof next.route === 'string' ? next.route : current.route
    const dirty = next.dirty === true
    current = {
      route,
      dirty,
      dirtyReason: dirty && typeof next.dirtyReason === 'string'
        ? next.dirtyReason.slice(0, MAX_ROUTE_REASON_LENGTH)
        : '',
      updatedAt: now()
    }
    return { ...current }
  }

  return {
    set,
    get: () => ({ ...current }),
    isDirty: () => current.dirty === true,
    getRoute: () => current.route,
    clear() {
      current = { route: 'home', dirty: false, dirtyReason: '', updatedAt: 0 }
    }
  }
}

function createMainWindowReclaimer({
  timeoutMs = DEFAULT_TIMEOUT_MS,
  getWindow,
  state = createRendererWindowState(),
  leases = createLeaseTracker(),
  isBusy = () => false,
  shouldReclaim,
  onReclaim,
  setTimer,
  clearTimer,
  now,
  log = () => {}
} = {}) {
  if (typeof getWindow !== 'function') throw new TypeError('A main window reclaimer requires getWindow')
  if (shouldReclaim !== undefined && typeof shouldReclaim !== 'function') throw new TypeError('shouldReclaim must be a function when provided')
  if (onReclaim !== undefined && typeof onReclaim !== 'function') throw new TypeError('onReclaim must be a function when provided')

  // The route to reopen with, recorded exactly when the window is destroyed and
  // consumed exactly once by createMainWindow(). A second open must not keep
  // replaying a route the user already left.
  let pendingRoute = null

  function evaluate() {
    const win = getWindow()
    if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) {
      return { reclaim: false, reason: 'no-window' }
    }
    // Hidden is the whole premise of this reclaimer; a visible window is never
    // touched even if a stale timer manages to fire.
    if (typeof win.isVisible === 'function' && win.isVisible()) {
      return { reclaim: false, reason: 'visible' }
    }
    if (state.isDirty()) return { reclaim: false, reason: 'renderer-dirty' }
    const route = state.getRoute()
    if (!SAFE_ROUTES.includes(route)) return { reclaim: false, reason: 'route-unsafe', route }
    if (!leases.isIdle()) return { reclaim: false, reason: 'lease-held', leases: leases.heldReasons() }
    let busy = true
    try {
      busy = isBusy() === true
    } catch (error) {
      // An unreadable busy signal counts as busy: safety over memory.
      log('main-window-busy-check-failed', { error: error?.message || String(error) })
    }
    if (busy) return { reclaim: false, reason: 'main-busy' }
    if (shouldReclaim) {
      let extra = false
      try {
        extra = shouldReclaim() === true
      } catch (error) {
        log('main-window-reclaim-predicate-failed', { error: error?.message || String(error) })
        return { reclaim: false, reason: 'predicate-failed' }
      }
      if (!extra) return { reclaim: false, reason: 'custom-predicate' }
    }
    return { reclaim: true, reason: 'clean', route }
  }

  const idle = createIdleReclaimer({
    name: 'main-window',
    timeoutMs,
    shouldReclaim: () => evaluate().reclaim === true,
    // The idle reclaimer checked the predicate a moment ago; re-check here so a
    // state report that raced with the timer still wins. The route is recorded
    // BEFORE anything is destroyed - if the destroy throws, the window is still
    // there and the recorded route is cleared again.
    onReclaim: ({ idleForMs }) => {
      const decision = evaluate()
      if (!decision.reclaim) {
        log('main-window-reclaim-aborted', { reason: decision.reason, idleForMs })
        return
      }
      pendingRoute = RENDERER_ROUTES.includes(decision.route) ? decision.route : null
      log('main-window-route-recorded', { route: pendingRoute, idleForMs })
      const win = getWindow()
      try {
        if (onReclaim) onReclaim(win, { route: pendingRoute, idleForMs })
        else if (win && typeof win.destroy === 'function') win.destroy()
      } catch (error) {
        pendingRoute = null
        log('main-window-reclaim-failed', { error: error?.message || String(error) })
        return
      }
      state.clear()
      log('main-window-reclaimed', { route: pendingRoute, idleForMs })
    },
    setTimer,
    clearTimer,
    now,
    log
  })

  // Rebuild entry point: createMainWindow('home') is the tray/activate path, so a
  // reclaimed route wins over the default 'home'. An explicit non-home request
  // (tray "open history") is honoured and leaves the pending route for the next
  // default open.
  function resolveInitialRoute(requested = 'home') {
    if (requested !== 'home' || !pendingRoute) return requested
    const route = pendingRoute
    pendingRoute = null
    log('main-window-route-restored', { route })
    return route
  }

  return {
    arm: () => idle.arm(),
    disarm: (reason = 'manual') => idle.disarm(reason),
    isArmed: () => idle.isArmed(),
    isDisposed: () => idle.isDisposed(),
    getTimeoutMs: () => idle.getTimeoutMs(),
    getLastOutcome: () => idle.getLastOutcome(),
    getState: () => state,
    acquireLease: (reason = 'main-window-busy') => leases.acquire(reason),
    resolveInitialRoute,
    peekPendingRoute: () => pendingRoute,
    dispose() {
      idle.dispose()
      leases.dispose()
      state.clear()
    }
  }
}

// Assembly used by main.js: one call wires the state store, the lease tracker,
// the reclaimer and the renderer-report IPC together. main.js is at a hard line
// ceiling, so this hides every line of the wiring behind a single require + one
// const; the pieces above stay separately unit-testable.
function createMainWindowReclaim({ ipcMain, getWindow, timeoutMs = DEFAULT_TIMEOUT_MS, isBusy, log = () => {} } = {}) {
  // Required lazily: main/ipc/window-reclaim-ipc.js requires this module for
  // RENDERER_ROUTES, and a top-level require here would be a load-time cycle.
  const { registerWindowReclaimIpc } = require('../ipc/window-reclaim-ipc')
  const state = createRendererWindowState()
  const leases = createLeaseTracker({ log })
  const reclaimer = createMainWindowReclaimer({ timeoutMs, getWindow, state, leases, isBusy, log })
  const ipc = registerWindowReclaimIpc({ ipcMain, state, getMainWindow: getWindow, log })
  return {
    arm: reclaimer.arm,
    disarm: reclaimer.disarm,
    resolveInitialRoute: reclaimer.resolveInitialRoute,
    getState: reclaimer.getState,
    acquireLease: reclaimer.acquireLease,
    dispose: reclaimer.dispose,
    reclaimer,
    ipc
  }
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  RENDERER_ROUTES,
  SAFE_ROUTES,
  createRendererWindowState,
  createMainWindowReclaimer,
  createMainWindowReclaim
}
