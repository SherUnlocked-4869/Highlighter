'use strict'

// AI usage page — automatic refresh lifecycle (plan §2.2, 2026-10-23 regression).
//
// The page used to be read-only in the worst way: `renderUsage()` only ran the
// query channels, so the data on screen never moved until the user pressed the
// header refresh button. The engine's `page-open` reason and its 5-minute
// throttle existed and were unit-tested, but nothing in production ever sent
// that reason after the one-time consent click — a dead path.
//
// These are runtime contract tests, not source regexes (source shape is already
// pinned in usage-page-controls.test.js): the real `config/routes/usage.js` is
// executed in a VM with fake timers/listeners, so what is asserted is the actual
// lifecycle — arm on entry, trigger on focus/visibility/poll, and full teardown
// on route leave (no timers, no listeners, no IPC subscription left behind).

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '..')
const USAGE_SOURCE = fs.readFileSync(path.join(ROOT, 'config', 'routes', 'usage.js'), 'utf8')
// The real formatter module is a plain classic script that only assigns
// `window.usageFormat`; loading it beats a stub that drifts from the real API.
const USAGE_FORMAT_SOURCE = fs.readFileSync(path.join(ROOT, 'shared', 'usage-format.js'), 'utf8')

// The route file is a classic script: it declares top-level functions that the
// shell calls as bare identifiers (`usageDeactivate` from config.js). A VM sandbox
// with the script evaluated in non-strict script scope reproduces that exactly.
function createSandbox({ enabled = true, disabledChannels = [] } = {}) {
  const timers = new Map()
  let timerSequence = 0
  const listeners = { window: new Map(), document: new Map() }
  const refreshCalls = []
  const queries = []
  let visibilityState = 'visible'
  let route = 'usage'

  const add = (target) => (type, handler) => {
    const bucket = listeners[target].get(type) || []
    bucket.push(handler)
    listeners[target].set(type, bucket)
  }
  const remove = (target) => (type, handler) => {
    const bucket = listeners[target].get(type) || []
    listeners[target].set(type, bucket.filter((entry) => entry !== handler))
  }
  const emit = (target, type) => {
    for (const handler of listeners[target].get(type) || []) handler({ type })
  }

  const element = () => ({
    hidden: true,
    dataset: {},
    style: {},
    textContent: '',
    innerHTML: '',
    classList: { add() {}, remove() {}, toggle() {} },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    appendChild() {},
    remove() {},
    focus() {},
    setAttribute() {},
    getAttribute: () => null,
    closest: () => null
  })

  const missing = new Set(disabledChannels)
  const api = (name, handler) => (missing.has(name) ? undefined : handler)

  const statusPayload = () => ({
    enabled,
    scanning: false,
    scan: null,
    lastScanAt: enabled ? '2026-10-21T03:00:00.000Z' : null,
    lastError: null,
    dbBytes: 1024,
    retentionMonths: 24,
    sources: [
      { source: 'codex', state: 'ok', detected: true, readable: true, files: 3, coverageStartAt: null },
      { source: 'dsh', state: 'ok', detected: true, readable: true, files: 1, coverageStartAt: null },
      { source: 'opencode', state: 'absent', detected: false, readable: false, files: 0, coverageStartAt: null }
    ]
  })

  const document = {
    visibilityState,
    body: { classList: { add() {}, remove() {} }, appendChild() {} },
    createElement: element,
    getElementById: () => element(),
    querySelector: () => element(),
    querySelectorAll: () => [],
    addEventListener: add('document'),
    removeEventListener: remove('document')
  }
  Object.defineProperty(document, 'visibilityState', { get: () => visibilityState })

  const sandbox = {
    document,
    window: {
      addEventListener: add('window'),
      removeEventListener: remove('window'),
      electronAPI: {
        usageStatus: api('usageStatus', async () => statusPayload()),
        usageSummary: api('usageSummary', async (query) => { queries.push(['summary', query]); return { totals: { billable_total_tokens: 0 }, rolling: {} } }),
        usageDaily: api('usageDaily', async (query) => { queries.push(['daily', query]); return { rows: [] } }),
        usageBreakdown: api('usageBreakdown', async (query) => { queries.push(['breakdown', query]); return { sources: [], models: [] } }),
        usageHeatmap: api('usageHeatmap', async () => null),
        usageHourly: api('usageHourly', async () => ({ rows: [] })),
        usageRefresh: api('usageRefresh', async (payload) => {
          refreshCalls.push(payload)
          return { started: true, scanId: 'scan-1' }
        }),
        usageClear: api('usageClear', async () => ({ ok: true })),
        onUsageScanProgress: api('onUsageScanProgress', (handler) => {
          sandbox.__progressHandler = handler
          return () => { sandbox.__progressHandler = null }
        })
      }
    },
    setTimeout: (fn, delay) => {
      timerSequence += 1
      const id = timerSequence
      timers.set(id, { fn, delay })
      return id
    },
    clearTimeout: (id) => { timers.delete(id) },
    requestAnimationFrame: (fn) => { fn(); return 1 },
    matchMedia: () => ({ matches: false }),
    Intl,
    Date,
    Math,
    Number,
    String,
    Array,
    Object,
    Map,
    Set,
    JSON,
    console,
    currentRoute: route,
    t: (key, params) => (params ? `${key} ${JSON.stringify(params)}` : key),
    escapeHtml: (value) => String(value ?? ''),
    pageHeader: () => '',
    iconMarkup: () => '',
    toast: () => {},
    confirm: () => false,
    errorMessage: (error) => (error && error.message) || String(error || ''),
    updateSettings: async () => {},
    view: {
      innerHTML: '',
      scrollTop: 0,
      // The in-place path probes for a mounted dashboard (`usageKeepDashboardForSwap`),
      // so the stub reports a rendered, non-loading page once a render has run.
      querySelector: (selector) => {
        if (selector === '.usage-page' && sandbox.view.innerHTML) {
          return {
            dataset: { usageState: 'ok' },
            querySelector: () => ({ style: {}, textContent: '', querySelector: () => null })
          }
        }
        return null
      },
      querySelectorAll: () => []
    },
    window_on_load: null
  }
  // Top-level `let`/`const` in a classic script are script-scoped, not global;
  // the tests need a handle on a few of them, so the script is compiled once and
  // the live bindings are read through a probe generated from the same source.
  const state = {
    timers,
    listeners,
    refreshCalls,
    queries,
    setRoute(next) {
      sandbox.currentRoute = next
    },
    setVisibility(next) {
      visibilityState = next
    },
    get progressHandler() { return sandbox.__progressHandler },
    get timerCount() { return timers.size },
    runTimer() {
      const [id, entry] = [...timers.entries()][0] || []
      if (!entry) throw new Error('no pending timer')
      timers.delete(id)
      entry.fn()
      return entry.delay
    },
    peekTimer() { return [...timers.values()][0] || null },
    emitWindow(type) { emit('window', type) },
    emitDocument(type) { emit('document', type) },
    listenerCount(type) {
      return (listeners.window.get(type) || []).length + (listeners.document.get(type) || []).length
    }
  }
  sandbox.__testState = state
  return { sandbox, state }
}

function loadRoute({ enabled, disabledChannels } = {}) {
  const { sandbox, state } = createSandbox({ enabled, disabledChannels })
  const context = vm.createContext(sandbox)
  // Same load order as config.html: the formatter module first, then the route
  // script. The module is UMD: in a real browser it writes `window.usageFormat`,
  // while in this sandbox `window` is not the global object, so the executed
  // assignment lands on the context global — mirror it onto `window` explicitly.
  vm.runInContext(USAGE_FORMAT_SOURCE, context, { filename: 'shared/usage-format.js' })
  sandbox.window.usageFormat = sandbox.usageFormat
  const probe = `
    ;globalThis.__probe = {
      renderUsage,
      usageRerenderKeepingDashboard,
      usageDeactivate,
      usageAutoRefreshTick,
      usageAutoRefreshArm,
      usageAutoRefreshStop,
      usageRelativeTime
    }
  `
  vm.runInContext(USAGE_SOURCE + probe, context, { filename: 'config/routes/usage.js' })
  return { sandbox, state, probe: sandbox.__probe }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

test('entering the usage page requests an increment scan and arms the refresh timer', async (t) => {
  const { sandbox, state, probe } = loadRoute()
  sandbox.currentRoute = 'usage'

  await probe.renderUsage()
  await settle()

  // Objects created inside the VM context have that realm's Object.prototype, so
  // deepStrictEqual across realms would fail on prototypes; compare the payload.
  assert.equal(JSON.stringify(state.refreshCalls), JSON.stringify([{ reason: 'page-open' }]), 'a route entry must ask for a page-open scan')
  const timer = state.peekTimer()
  assert.ok(timer, 'the auto-refresh timer must be armed after an enabled render')
  assert.equal(timer.delay, 60 * 1000)
  assert.equal(state.listenerCount('focus'), 1, 'window focus listener')
  assert.equal(state.listenerCount('visibilitychange'), 1, 'document visibility listener')
})

test('the poll, window focus and visibility return all ask for a page-open scan', async (t) => {
  const { sandbox, state, probe } = loadRoute()
  sandbox.currentRoute = 'usage'
  await probe.renderUsage()
  await settle()
  assert.equal(state.refreshCalls.length, 1)

  // Timer tick.
  state.runTimer()
  await settle()
  assert.equal(state.refreshCalls.length, 2)
  assert.equal(state.peekTimer().delay, 60 * 1000, 'a tick must re-arm the timer')

  // Focus.
  state.emitWindow('focus')
  await settle()
  assert.equal(state.refreshCalls.length, 3)

  // Visibility return after being hidden.
  state.setVisibility('hidden')
  state.emitDocument('visibilitychange')
  await settle()
  assert.equal(state.refreshCalls.length, 3, 'a hidden page must not scan')
  state.setVisibility('visible')
  state.emitDocument('visibilitychange')
  await settle()
  assert.equal(state.refreshCalls.length, 4)

  for (const call of state.refreshCalls) assert.equal(call.reason, 'page-open')
})

test('leaving the route tears down the timer, both listeners and the progress subscription', async (t) => {
  const { sandbox, state, probe } = loadRoute()
  sandbox.currentRoute = 'usage'
  await probe.renderUsage()
  await settle()
  assert.ok(state.progressHandler, 'the page subscribes to scan progress while visible')

  probe.usageDeactivate()

  assert.equal(state.timerCount, 0, 'no timer may survive the route leave')
  assert.equal(state.listenerCount('focus'), 0, 'the focus listener must be removed')
  assert.equal(state.listenerCount('visibilitychange'), 0, 'the visibility listener must be removed')
  assert.equal(state.progressHandler, null, 'the IPC subscription must be dropped')

  // A late tick from anywhere must be inert once the route is gone.
  const before = state.refreshCalls.length
  state.emitWindow('focus')
  state.emitDocument('visibilitychange')
  await settle()
  assert.equal(state.refreshCalls.length, before)
})

test('a disabled page neither scans nor arms the timer', async (t) => {
  const { sandbox, state, probe } = loadRoute({ enabled: false })
  sandbox.currentRoute = 'usage'
  await probe.renderUsage()
  await settle()
  assert.deepEqual(state.refreshCalls, [])
  assert.equal(state.timerCount, 0)
  assert.equal(state.listenerCount('focus'), 0)
})

test('an in-place re-query does not ask for another scan', async (t) => {
  const { sandbox, state, probe } = loadRoute()
  sandbox.currentRoute = 'usage'
  await probe.renderUsage()
  await settle()
  const afterEntry = state.refreshCalls.length
  assert.equal(afterEntry, 1)

  // Period switch / AI-tool filter / manual refresh all go through the in-place
  // path: the dashboard stays mounted and only the queries run again. Triggering
  // a scan here would re-scan on every tab click.
  await probe.usageRerenderKeepingDashboard()
  await settle()
  assert.equal(state.refreshCalls.length, afterEntry, 'an in-place re-query must not re-trigger the entry scan')
})

test('a finished scan repaints in place instead of blanking the page', async (t) => {
  const { sandbox, state, probe } = loadRoute()
  sandbox.currentRoute = 'usage'
  await probe.renderUsage()
  await settle()
  const queriesAfterRender = state.queries.length
  const refreshAfter = state.refreshCalls.length

  // Drive the main-process push the way usage-collector does.
  const handler = state.progressHandler
  assert.equal(typeof handler, 'function', 'the page must subscribe to scan progress')
  handler({ done: true, filesDone: 3, filesTotal: 3 })

  await settle()
  assert.equal(state.refreshCalls.length, refreshAfter, 'repainting must not start another scan')
  assert.ok(state.queries.length > queriesAfterRender, 'the finished scan must re-query the dashboard')
  // The in-place path keeps the mounted shell: no loading card was requested.
  assert.doesNotMatch(String(sandbox.view.innerHTML), /usage-state-loading|usage-loading/)
})

test('relative freshness copy distinguishes minutes, hours and days', async () => {
  const { probe } = loadRoute()
  const now = new Date('2026-10-23T11:00:00.000Z')
  const key = (iso) => probe.usageRelativeTime(iso, now)
  assert.match(key('2026-10-23T10:59:30.000Z'), /relative-now/)
  assert.match(key('2026-10-23T10:45:00.000Z'), /relative-minutes/)
  assert.match(key('2026-10-23T08:00:00.000Z'), /relative-hours/)
  assert.match(key('2026-10-22T09:00:00.000Z'), /relative-yesterday/)
  assert.match(key('2026-10-20T09:00:00.000Z'), /relative-days/)
  // Missing / malformed values fall back to the "never scanned" path.
  assert.equal(key(null), '')
  assert.equal(key('not-a-date'), '')
})
