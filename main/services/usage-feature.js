// Usage feature composition root.
//
// Owns the main-process usage pipeline:
//   renderer -> usage-ipc -> feature handlers -> usage-query (aggregation)
//                                |                    -> usage-store (SQLite)
//                                -> usage-collector (scan state machine)
//                                     -> usage-tools (file discovery)
//                                     -> utilityProcess worker (vendored parser)
//
// main.js assembles this with ONE line (plan §2.9 G1):
//   require('./main/services/usage-feature').install({ ipcMain: secureIpcMain, app, getPaths, getMainWindow, getSettings, log })
//
// Everything expensive is lazy: install() only registers IPC channels and the
// data-root registry hook, so app startup is untouched and no user directory is
// touched until the usage page asks for status/refresh. `HIGHLIGHTER_USAGE_HOME`
// overrides the scanned home for tests/e2e; it is part of the feature's deps to
// make that explicit.

const fs = require('node:fs')
const path = require('node:path')

const { setActiveUsageFeature } = require('./usage-runtime')
const { createUsageCollector } = require('./usage-collector')
const { createUsageQuery, heatmapLevel } = require('./usage-query')
const { createUsageWorkerClient } = require('./usage-worker-client')
const { openUsageStore, RETENTION_MONTHS } = require('./usage-store')
const tools = require('./usage-tools')
const { registerUsageIpc, USAGE_PROGRESS_CHANNEL } = require('../ipc/usage-ipc')

const SOURCE_LABELS = Object.freeze({
  codex: 'Codex',
  dsh: 'DeepSeek Harness',
  opencode: 'OpenCode'
})

function createUsageFeature(deps = {}) {
  const {
    app = null,
    getPaths,
    getSettings = () => ({}),
    getMainWindow = () => null,
    log = () => {},
    homeDir = null,
    now = () => new Date(),
    env = process.env,
    workerClient: injectedWorkerClient = null
  } = deps

  if (typeof getPaths !== 'function') throw new TypeError('usage feature requires getPaths()')

  let store = null
  let storePath = null
  let ownedWorkerClient = null
  let collector = null
  let query = null
  let lastError = null

  function isoNow() {
    const value = now()
    return (value instanceof Date ? value : new Date(value)).toISOString()
  }

  function settingsEnabled() {
    try {
      return getSettings()?.usage?.enabled === true
    } catch (_error) {
      return false
    }
  }

  function usageDir() {
    const paths = getPaths()
    const dir = paths?.usage
    if (typeof dir !== 'string' || !dir) throw new Error('usage data directory is unavailable')
    return dir
  }

  function ensureStore() {
    const dir = usageDir()
    const target = path.join(dir, 'usage.db')
    if (store && storePath === target && store.isOpen()) return store
    if (store) {
      try { store.close() } catch (_error) {}
    }
    store = openUsageStore({ dbPath: target, now, log })
    storePath = target
    if (query) query.invalidate()
    return store
  }

  function getWorkerClient() {
    if (injectedWorkerClient) return injectedWorkerClient
    if (!ownedWorkerClient) ownedWorkerClient = createUsageWorkerClient({ log })
    return ownedWorkerClient
  }

  function homeContext() {
    const defaultHome = typeof app?.getPath === 'function' ? app.getPath('home') : null
    return tools.resolveHomeContext({ homeDir, env, defaultHome })
  }

  function emitProgress(payload) {
    try {
      const win = getMainWindow()
      const webContents = win?.webContents
      if (!webContents || typeof webContents.send !== 'function') return
      if (typeof webContents.isDestroyed === 'function' && webContents.isDestroyed()) return
      webContents.send(USAGE_PROGRESS_CHANNEL, payload)
    } catch (error) {
      log(`usage feature: progress push failed: ${error?.message || String(error)}`)
    }
  }

  function ensureCollector() {
    if (collector) return collector
    collector = createUsageCollector({
      getStore: ensureStore,
      getWorkerClient,
      getSettings,
      getHomeContext: homeContext,
      getUsageDir: usageDir,
      tools,
      log,
      now,
      onProgress: emitProgress
    })
    return collector
  }

  function ensureQuery() {
    if (!query) {
      query = createUsageQuery({ getStore: ensureStore, now, log })
    }
    return query
  }

  function probeStatusFromStore(source, stored) {
    const coverage = store && store.isOpen() ? store.getCoverageStart(source) : null
    return {
      source,
      label: SOURCE_LABELS[source] || source,
      lastScanAt: stored?.lastScanAt || null,
      lastError: stored?.lastError || null,
      coverageStartAt: stored?.coverageStartAt || coverage,
      estimated: false
    }
  }

  function probeToStatus(probe, { scannedAt = null } = {}) {
    return {
      source: probe.source,
      state: probe.state,
      detected: probe.detected === true,
      readable: probe.readable === true,
      files: Number(probe.fileCount) || 0,
      lastScanAt: scannedAt,
      lastError: probe.lastError || null,
      detail: probe.reason || null,
      coverageStartAt: probe.coverageStartAt || null
    }
  }

  async function getStatus() {
    const enabled = settingsEnabled()
    const status = {
      enabled,
      scanning: Boolean(collector && collector.isScanning()),
      scan: collector ? collector.getScan() : null,
      lastScanAt: null,
      lastError,
      dbBytes: 0,
      retentionMonths: RETENTION_MONTHS,
      sources: []
    }
    let activeStore = null
    try {
      activeStore = ensureStore()
      status.lastScanAt = activeStore.getAppMeta('lastScanAt')
      status.lastError = lastError || activeStore.getAppMeta('lastError')
      status.dbBytes = activeStore.getStats().dbBytes
    } catch (error) {
      lastError = error?.message || String(error)
      status.lastError = lastError
    }
    const stored = activeStore ? activeStore.listSourceStatus() : {}
    if (!enabled) {
      status.sources = tools.listTools().map((tool) => {
        const previous = stored[tool.source] || {}
        return {
          ...probeStatusFromStore(tool.source, previous),
          state: previous.state || 'absent',
          detected: previous.detected === true,
          readable: previous.readable === true,
          files: previous.files || 0
        }
      })
    } else {
      const context = homeContext()
      for (const tool of tools.listTools()) {
        const previous = stored[tool.source] || {}
        let probe
        try {
          probe = await tool.probe(context)
        } catch (error) {
          probe = {
            source: tool.source,
            label: tool.label,
            state: 'error',
            detected: false,
            readable: false,
            files: [],
            fileCount: 0,
            lastError: error?.message || String(error)
          }
        }
        status.sources.push({
          ...probeStatusFromStore(tool.source, previous),
          ...probeToStatus(probe, { scannedAt: previous.lastScanAt || null }),
          label: tool.label || SOURCE_LABELS[tool.source] || tool.source
        })
      }
    }
    for (const unsupported of tools.UNSUPPORTED_TOOLS) {
      status.sources.push({
        source: unsupported.source,
        label: unsupported.label,
        state: 'unsupported',
        detected: false,
        readable: false,
        files: 0,
        lastScanAt: null,
        lastError: null,
        coverageStartAt: null,
        estimated: false
      })
    }
    return status
  }

  async function refresh(validated = {}) {
    return ensureCollector().refresh(validated)
  }

  async function clear() {
    if (collector) {
      try { collector.cancel('clear') } catch (_error) {}
      try { collector.dispose() } catch (_error) {}
      collector = null
    }
    if (ownedWorkerClient) {
      try { ownedWorkerClient.dispose() } catch (_error) {}
      ownedWorkerClient = null
    }
    if (store) {
      try { store.close() } catch (_error) {}
      store = null
      storePath = null
    }
    const dir = usageDir()
    fs.rmSync(dir, { recursive: true, force: true })
    lastError = null
    const activeStore = ensureStore()
    activeStore.setAppMeta('lastError', '')
    if (query) query.invalidate()
    return { ok: true, clearedAt: isoNow() }
  }

  function quiesce() {
    if (collector) {
      try { collector.dispose() } catch (_error) {}
      collector = null
    }
    if (ownedWorkerClient) {
      try { ownedWorkerClient.dispose() } catch (_error) {}
      ownedWorkerClient = null
    }
    if (store) {
      try { store.close() } catch (_error) {}
      store = null
      storePath = null
    }
    if (query) query.invalidate()
    return { ok: true }
  }

  function resume() {
    return { ok: true }
  }

  function getDiagnostics() {
    return {
      storeOpen: Boolean(store && store.isOpen()),
      scanning: Boolean(collector && collector.isScanning()),
      scan: collector ? collector.getScan() : null,
      lastError,
      queryCache: query ? query.getCacheStats() : null,
      worker: ownedWorkerClient ? ownedWorkerClient.getDiagnostics() : null
    }
  }

  const handlers = {
    status: () => getStatus(),
    refresh,
    summary: (args) => ensureQuery().summary(args),
    daily: (args) => ensureQuery().daily(args),
    hourly: (args) => ensureQuery().hourly(args),
    breakdown: (args) => ensureQuery().breakdown(args),
    heatmap: (args) => ensureQuery().heatmap(args),
    clear
  }

  return {
    clear,
    getDiagnostics,
    getStatus,
    handlers,
    quiesce,
    refresh,
    resume
  }
}

function install(deps = {}) {
  const feature = createUsageFeature(deps)
  registerUsageIpc({ ipcMain: deps.ipcMain, handlers: feature.handlers, log: deps.log || (() => {}) })
  setActiveUsageFeature(feature)
  return feature
}

module.exports = {
  createUsageFeature,
  heatmapLevel,
  install
}
