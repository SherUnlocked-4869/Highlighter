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

const { t } = require('./i18n-bootstrap')
const { setActiveUsageFeature } = require('./usage-runtime')
const { createUsageCollector } = require('./usage-collector')
const { createUsageQuery, heatmapLevel } = require('./usage-query')
const { createUsageWorkerClient } = require('./usage-worker-client')
const { openUsageStore, RETENTION_MONTHS } = require('./usage-store')
const { createUsageSnapshotStore } = require('./usage-snapshot-store')
const {
  buildUsageReport,
  reportFileName,
  reportToCsv,
  reportToJson
} = require('./usage-export')
const tools = require('./usage-tools')
const {
  registerUsageIpc,
  USAGE_EXCHANGE_CHANNELS,
  USAGE_PROGRESS_CHANNEL,
  validateExportArgs,
  validateImportArgs
} = require('../ipc/usage-ipc')

const SOURCE_LABELS = Object.freeze({
  codex: 'Codex',
  dsh: 'DeepSeek Harness',
  opencode: 'OpenCode'
})

// The usage scan worker is forked lazily on the first scan; once the last
// request settles it is kept warm for this long, then killed so an idle app does
// not hold a utility process (M1 memory plan §4.2).
const USAGE_WORKER_IDLE_MS = 2 * 60 * 1000

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
    workerClient: injectedWorkerClient = null,
    workerIdleTimeoutMs = USAGE_WORKER_IDLE_MS,
    // Exchange surfaces are injectable so a test never opens a real save dialog
    // or writes outside its temp directory.
    dialog = null,
    writeFile = null
  } = deps

  if (typeof getPaths !== 'function') throw new TypeError('usage feature requires getPaths()')

  let store = null
  let storePath = null
  let ownedWorkerClient = null
  let collector = null
  let query = null
  let snapshots = null
  let lastError = null
  // Which exchange channels this host actually registered. The page reads it
  // from status and disables the buttons when this build's IPC policy does not
  // expose them yet, instead of failing only after the user clicks.
  const exchange = { export: false, import: false }

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
    if (typeof dir === 'string' && dir) return dir
    // Legacy profile (no managed data root selected yet) and the E2E harness keep
    // no `paths` object; the other stores fall back to app.getPath('userData') in
    // exactly this situation. Before a data-root migration the usage DB lives
    // under the legacy userData; the migration copy group only covers managed
    // roots, which is the documented pre-existing legacy boundary.
    if (app && typeof app.getPath === 'function') return path.join(app.getPath('userData'), 'usage')
    throw new Error('usage data directory is unavailable')
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

  function snapshotDirectory() {
    return path.join(usageDir(), 'snapshots')
  }

  // Imported aggregate snapshots live beside the scan database, in their own
  // directory: they are reports from other profiles/machines, never scan input.
  function ensureSnapshots() {
    const directory = snapshotDirectory()
    if (snapshots && snapshots.directory === directory) return snapshots
    snapshots = createUsageSnapshotStore({ directory, fs, now, log })
    return snapshots
  }

  function resolveDialog() {
    if (dialog && typeof dialog.showSaveDialog === 'function') return dialog
    try {
      const electron = require('electron')
      return electron && typeof electron.dialog?.showSaveDialog === 'function' ? electron.dialog : null
    } catch (_error) {
      return null
    }
  }

  async function writeFileAt(target, content) {
    if (typeof writeFile === 'function') return writeFile(target, content, 'utf8')
    await fs.promises.writeFile(target, content, 'utf8')
  }

  function defaultExportDirectory() {
    try {
      if (app && typeof app.getPath === 'function') return app.getPath('documents')
    } catch (_error) {}
    return usageDir()
  }

  function getWorkerClient() {
    if (injectedWorkerClient) return injectedWorkerClient
    if (!ownedWorkerClient) {
      ownedWorkerClient = createUsageWorkerClient({ idleTimeoutMs: workerIdleTimeoutMs, log })
    }
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
      query = createUsageQuery({ getStore: ensureStore, getPrices: () => getSettings()?.usage?.prices, now, log })
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
      sources: [],
      // Imported aggregate snapshots are listed separately from the scanned
      // ledger on purpose: they are never folded into the local totals.
      snapshots: [],
      exchange: { export: exchange.export, import: exchange.import }
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
    try {
      status.snapshots = ensureSnapshots().list()
    } catch (error) {
      log(`usage feature: snapshot list failed: ${error?.message || String(error)}`)
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
    snapshots = null
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
      worker: ownedWorkerClient ? ownedWorkerClient.getDiagnostics() : null,
      workerIdleTimeoutMs
    }
  }

  function reportParams(args) {
    return {
      period: args.period || 'month',
      tz: args.tz || 'UTC',
      from: args.from || null,
      to: args.to || null,
      sources: args.sources,
      model: args.model,
      project: args.project
    }
  }

  // Batch 1 exchange surfaces. Both read the SAME query functions the page
  // renders, so an export can never disagree with what the user clicked.
  async function exportReport(validated = {}) {
    const format = validated.format === 'json' ? 'json' : 'csv'
    const params = reportParams(validated)
    const activeQuery = ensureQuery()
    const daily = activeQuery.daily(params)
    const breakdown = activeQuery.breakdown({ ...params, scope: 'model' })
    let prices = []
    try {
      prices = getSettings()?.usage?.prices || []
    } catch (_error) {
      prices = []
    }
    const report = buildUsageReport({
      daily,
      breakdown,
      prices,
      sources: validated.sources,
      model: validated.model,
      projectFiltered: Boolean(validated.project),
      sourceLabels: SOURCE_LABELS,
      generatedAt: now(),
      appVersion: typeof app?.getVersion === 'function' ? app.getVersion() : ''
    })
    const content = format === 'json' ? reportToJson(report) : reportToCsv(report)
    const fileName = reportFileName(report, format)
    const result = {
      format,
      fileName,
      schemaVersion: report.schemaVersion,
      snapshotId: report.snapshotId,
      rows: report.daily.length,
      bytes: Buffer.byteLength(content, 'utf8')
    }
    if (validated.save !== true) return { ...result, canceled: false, content }
    const activeDialog = resolveDialog()
    if (!activeDialog) throw new Error('usage: export dialog is unavailable')
    const saveResult = await activeDialog.showSaveDialog(getMainWindow(), {
      title: t('config.usage.dashboard.export-title'),
      defaultPath: path.join(defaultExportDirectory(), fileName),
      filters: [{
        name: t(format === 'json' ? 'config.usage.dashboard.export-json-filter' : 'config.usage.dashboard.export-csv-filter'),
        extensions: [format]
      }]
    })
    if (!saveResult || saveResult.canceled || !saveResult.filePath) return { ...result, canceled: true }
    await writeFileAt(saveResult.filePath, content)
    return { ...result, canceled: false }
  }

  function importReport(validated = {}) {
    const activeSnapshots = ensureSnapshots()
    if (validated.mode === 'commit') {
      const result = activeSnapshots.commit(validated.payload)
      if (result.imported && query) query.invalidate()
      return result
    }
    return activeSnapshots.preview(validated.payload)
  }

  const handlers = {
    status: () => getStatus(),
    export: (args) => exportReport(args),
    import: (args) => importReport(args),
    refresh,
    summary: (args) => ensureQuery().summary(args),
    daily: (args) => ensureQuery().daily(args),
    hourly: (args) => ensureQuery().hourly(args),
    breakdown: (args) => ensureQuery().breakdown(args),
    heatmap: (args) => ensureQuery().heatmap(args),
    clear
  }

  function markExchange(channels = []) {
    exchange.export = channels.includes('usage:export')
    exchange.import = channels.includes('usage:import')
    return { ...exchange }
  }

  return {
    clear,
    getDiagnostics,
    getStatus,
    handlers,
    markExchange,
    quiesce,
    refresh,
    resume
  }
}

// Exchange channels (export / import) are additive to the frozen eight-channel
// usage surface. They are registered here, not in main/ipc/usage-ipc.js, because
// that file's literal-channel contract is pinned by test/usage-ipc.test.js.
//
// Two guards keep this honest:
//   - only the secure IPC facade (the host that exposes assertComplete()) gets
//     them; plain test doubles keep exactly the frozen eight channels;
//   - the facade refuses any channel that has no sender policy in
//     ipc-security.js, so a build whose policy table does not list them yet logs
//     the mismatch instead of failing application startup. Adding the two
//     channel names to IPC_SURFACES' main role enables them with no other change.
function registerExchangeIpc({ ipcMain, handlers, log = () => {} } = {}) {
  const registered = []
  if (typeof ipcMain?.assertComplete !== 'function' || typeof ipcMain.handle !== 'function') return registered
  const settle = (channel, handler) => async (_event, value) => {
    const normalized = channel === 'usage:export' ? validateExportArgs(value) : validateImportArgs(value)
    try {
      return await handler(normalized)
    } catch (error) {
      log(`usage ipc ${channel} failed: ${error?.message || String(error)}`)
      throw error instanceof Error ? error : new Error(`usage: ${String(error)}`)
    }
  }
  // Literal channel names keep the IPC security inventory honest: the policy audit scans the
  // registration call for a quoted first argument and cannot see a variable. Each channel is
  // still listed in USAGE_EXCHANGE_CHANNELS for the status/exchange capability report.
  for (const channel of USAGE_EXCHANGE_CHANNELS) {
    const handler = channel === 'usage:export' ? handlers.export : handlers.import
    if (typeof handler !== 'function') continue
    try {
      if (channel === 'usage:export') ipcMain.handle('usage:export', settle('usage:export', handler))
      else ipcMain.handle('usage:import', settle('usage:import', handler))
      registered.push(channel)
    } catch (error) {
      log(`usage feature: ${channel} unavailable: ${error?.message || String(error)}`)
    }
  }
  return registered
}

function install(deps = {}) {
  const feature = createUsageFeature(deps)
  registerUsageIpc({ ipcMain: deps.ipcMain, handlers: feature.handlers, log: deps.log || (() => {}) })
  feature.markExchange(registerExchangeIpc({ ipcMain: deps.ipcMain, handlers: feature.handlers, log: deps.log || (() => {}) }))
  setActiveUsageFeature(feature)
  return feature
}

module.exports = {
  USAGE_WORKER_IDLE_MS,
  createUsageFeature,
  heatmapLevel,
  install,
  registerExchangeIpc
}
