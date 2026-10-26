// Window registry (M0a): the one place that maps an Electron window to the role
// it plays and to the OS process that renders it. `app.getAppMetrics()` alone
// cannot answer "which window owns which pid" because a BrowserWindow has no
// back-reference to its renderer process; `webContents.getOSProcessId()` does.
//
// Requiring this module must stay safe in plain node: the default metrics
// provider lazy-requires `electron` on first use, so every rule below is
// unit-testable with injected fake windows and fake metrics. It is also the
// reference resolved by `window-security.js`, which means the assembly layer
// (main.js) needs no require of its own.

const KiB_PER_MIB = 1024

function round2(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.round(number * 100) / 100
}

function defaultGetAppMetrics() {
  try {
    // Lazy on purpose: requiring 'electron' from plain node resolves to the
    // package path string, not the runtime API, so this must not run at load.
    const electron = require('electron')
    const app = electron && typeof electron === 'object' ? electron.app : null
    return app && typeof app.getAppMetrics === 'function' ? app.getAppMetrics() : []
  } catch {
    return []
  }
}

function readWindowId(win) {
  return Number.isInteger(win?.id) ? win.id : null
}

function readWebContentsId(win) {
  return Number.isInteger(win?.webContents?.id) ? win.webContents.id : null
}

function readPid(win) {
  const getOSProcessId = win?.webContents?.getOSProcessId
  if (typeof getOSProcessId !== 'function') return null
  try {
    const pid = getOSProcessId.call(win.webContents)
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

function readVisible(win) {
  if (typeof win?.isVisible !== 'function') return null
  try {
    return !!win.isVisible()
  } catch {
    return null
  }
}

function readDestroyed(win) {
  if (typeof win?.isDestroyed !== 'function') return false
  try {
    return !!win.isDestroyed()
  } catch {
    return true
  }
}

function describeWindow(entry) {
  return {
    role: entry.role,
    feature: entry.feature,
    windowId: readWindowId(entry.window),
    webContentsId: readWebContentsId(entry.window),
    pid: readPid(entry.window),
    visible: readVisible(entry.window),
    destroyed: readDestroyed(entry.window)
  }
}

function normalizeProcessMetric(metric = {}) {
  const source = metric && typeof metric === 'object' ? metric : {}
  const memory = source.memory && typeof source.memory === 'object' ? source.memory : {}
  const cpu = source.cpu && typeof source.cpu === 'object' ? source.cpu : {}
  return {
    pid: Number.isInteger(source.pid) ? source.pid : null,
    type: String(source.type || 'Unknown'),
    name: typeof source.name === 'string' && source.name ? source.name : null,
    serviceName: typeof source.serviceName === 'string' && source.serviceName ? source.serviceName : null,
    creationTime: Number.isFinite(source.creationTime) ? source.creationTime : null,
    workingSetMiB: round2((Number(memory.workingSetSize) || 0) / KiB_PER_MIB),
    privateMiB: round2((Number(memory.privateBytes) || 0) / KiB_PER_MIB),
    cpuPercent: round2(Number(cpu.percentCPUUsage) || 0)
  }
}

function createWindowRegistry({ getAppMetrics = null, now = () => Date.now() } = {}) {
  const entries = []
  const metricsProvider = typeof getAppMetrics === 'function' ? getAppMetrics : defaultGetAppMetrics

  function findEntry(win) {
    return entries.find((entry) => entry.window === win) || null
  }

  function detachClosedListener(entry) {
    if (!entry.onClosed || typeof entry.window?.removeListener !== 'function') return
    try {
      entry.window.removeListener('closed', entry.onClosed)
    } catch {
      // A destroyed window refuses listener edits; the entry is dropped anyway.
    }
  }

  function unregister(win) {
    const entry = findEntry(win)
    if (!entry) return false
    detachClosedListener(entry)
    entries.splice(entries.indexOf(entry), 1)
    return true
  }

  // A window can be destroyed without emitting 'closed' on the path the
  // registry heard about it (crash, forced destruction, a test fake), so every
  // read prunes dead entries as well as the lifecycle listener.
  function pruneDestroyed() {
    for (let index = entries.length - 1; index >= 0; index--) {
      if (!readDestroyed(entries[index].window)) continue
      detachClosedListener(entries[index])
      entries.splice(index, 1)
    }
  }

  function register(role, win, { feature = null } = {}) {
    if (typeof role !== 'string' || !role.trim()) {
      throw new TypeError('A non-empty window role is required')
    }
    if (!win || typeof win !== 'object') throw new TypeError('A window object is required')
    const existing = findEntry(win)
    if (existing) return describeWindow(existing)
    const entry = {
      role: role.trim(),
      feature: typeof feature === 'string' && feature ? feature : null,
      window: win,
      onClosed: null
    }
    entry.onClosed = () => unregister(win)
    if (typeof win.once === 'function') win.once('closed', entry.onClosed)
    else if (typeof win.on === 'function') win.on('closed', entry.onClosed)
    else entry.onClosed = null
    entries.push(entry)
    return describeWindow(entry)
  }

  function list() {
    pruneDestroyed()
    return entries.map(describeWindow)
  }

  function attachMetrics(descriptor, byPid) {
    const metric = descriptor.pid === null ? null : byPid.get(descriptor.pid) || null
    return {
      ...descriptor,
      type: metric ? metric.type : null,
      name: metric ? metric.name : null,
      serviceName: metric ? metric.serviceName : null,
      workingSetMiB: metric ? metric.workingSetMiB : null,
      privateMiB: metric ? metric.privateMiB : null,
      cpuPercent: metric ? metric.cpuPercent : null
    }
  }

  function snapshot() {
    let metrics = []
    try {
      metrics = metricsProvider()
    } catch {
      metrics = []
    }
    const byPid = new Map()
    for (const raw of Array.isArray(metrics) ? metrics : []) {
      const metric = normalizeProcessMetric(raw)
      if (metric.pid !== null) byPid.set(metric.pid, metric)
    }
    pruneDestroyed()
    const windows = entries.map((entry) => attachMetrics(describeWindow(entry), byPid))
    return {
      generatedAt: now(),
      windowCount: windows.length,
      windows
    }
  }

  function reset() {
    for (const entry of entries) detachClosedListener(entry)
    entries.length = 0
  }

  return {
    register,
    unregister,
    list,
    snapshot,
    // Alias kept so a consumer can read either name (the singleton exports
    // snapshotWindows; the factory reads naturally as registry.snapshot()).
    snapshotWindows: snapshot,
    reset
  }
}

let singleton = null

function getWindowRegistry() {
  if (!singleton) singleton = createWindowRegistry()
  return singleton
}

function registerWindow(role, win, options) {
  return getWindowRegistry().register(role, win, options)
}

function listWindows() {
  return getWindowRegistry().list()
}

function snapshotWindows() {
  return getWindowRegistry().snapshot()
}

function reset() {
  getWindowRegistry().reset()
}

module.exports = {
  createWindowRegistry,
  getWindowRegistry,
  listWindows,
  normalizeProcessMetric,
  registerWindow,
  reset,
  snapshotWindows
}
