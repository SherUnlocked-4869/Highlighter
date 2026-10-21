// Usage feature composition root (B1).
//
// Owns the whole main-process usage pipeline for the first vertical slice:
//   renderer -> usage-ipc -> feature handlers -> usage-store (SQLite)
//                                -> usage-tools (file discovery)
//                                -> utilityProcess worker (vendored parser)
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
const { createUsageWorkerClient } = require('./usage-worker-client')
const { openUsageStore, RETENTION_MONTHS } = require('./usage-store')
const usageState = require('./usage-state')
const usageTime = require('./usage-time')
const tools = require('./usage-tools')
const { registerUsageIpc, USAGE_PROGRESS_CHANNEL } = require('../ipc/usage-ipc')

const DAY_MS = usageTime.DAY_MS
const SOURCE_LABELS = Object.freeze({
  codex: 'Codex',
  dsh: 'DeepSeek Harness',
  opencode: 'OpenCode'
})
const SUMMARY_INTEGER_COLUMNS = Object.freeze([
  'billable_total_tokens',
  'total_tokens',
  'input_tokens',
  'output_tokens',
  'cached_input_tokens',
  'cache_creation_input_tokens',
  'reasoning_output_tokens',
  'conversation_count'
])

function toIso(value) {
  const date = value instanceof Date ? value : new Date(value)
  return date.toISOString()
}

function resolvedRangeToIso(resolved) {
  return {
    fromDay: resolved.fromDay,
    toDay: resolved.toDay,
    fromIso: new Date(resolved.startUtcMs).toISOString(),
    toIso: new Date(resolved.endUtcMs).toISOString()
  }
}

function emptyTotals() {
  const totals = {}
  for (const column of SUMMARY_INTEGER_COLUMNS) totals[column] = 0
  return totals
}

function addTotals(target, source) {
  for (const column of SUMMARY_INTEGER_COLUMNS) {
    target[column] = (target[column] || 0) + (Number(source?.[column]) || 0)
  }
  return target
}

function sharePct(value, total) {
  if (!total) return 0
  return Math.round((value / total) * 10000) / 100
}

// Max-relative four-band level (plan §1.2 #10 / TT local-api.js max-relative):
// 0 = no activity, 1..4 = <=25% / <=50% / <=75% / >75% of the range maximum.
function heatmapLevel(value, max) {
  if (!value || value <= 0 || !max || max <= 0) return 0
  const ratio = value / max
  if (ratio <= 0.25) return 1
  if (ratio <= 0.5) return 2
  if (ratio <= 0.75) return 3
  return 4
}

function toTotalsPayload(columns) {
  return {
    billable_total_tokens: Number(columns.billable_total_tokens) || 0,
    total_tokens: Number(columns.total_tokens) || 0,
    input_tokens: Number(columns.input_tokens) || 0,
    output_tokens: Number(columns.output_tokens) || 0,
    cached_input_tokens: Number(columns.cached_input_tokens) || 0,
    cache_creation_input_tokens: Number(columns.cache_creation_input_tokens) || 0,
    reasoning_output_tokens: Number(columns.reasoning_output_tokens) || 0,
    conversation_count: Number(columns.conversation_count) || 0,
    total_cost_usd: null,
    unpriced_tokens: 0
  }
}

function dailyRowFromTotals(day, columns) {
  return {
    day,
    total_tokens: Number(columns.total_tokens) || 0,
    billable_total_tokens: Number(columns.billable_total_tokens) || 0,
    input_tokens: Number(columns.input_tokens) || 0,
    output_tokens: Number(columns.output_tokens) || 0,
    cached_input_tokens: Number(columns.cached_input_tokens) || 0,
    reasoning_output_tokens: Number(columns.reasoning_output_tokens) || 0,
    conversation_count: Number(columns.conversation_count) || 0,
    total_cost_usd: null
  }
}

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
  let lastError = null
  let scanState = null
  let scanSequence = 0
  let lastProgressSentAt = 0

  function isoNow() {
    return toIso(now())
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

  function progressPayload(overrides = {}) {
    const scan = scanState || {}
    const filesTotal = Number(overrides.filesTotal ?? scan.filesTotal) || 0
    const filesDone = Number(overrides.filesDone ?? scan.filesDone) || 0
    return {
      scanId: scan.scanId || null,
      phase: scan.phase || 'idle',
      tool: scan.tool || null,
      toolIndex: Number.isFinite(scan.toolIndex) ? scan.toolIndex : 0,
      toolCount: Number.isFinite(scan.toolCount) ? scan.toolCount : 0,
      filesDone,
      filesTotal,
      bytesRead: Number(scan.bytesRead) || 0,
      buckets: Number(overrides.buckets ?? scan.buckets) || 0,
      startedAt: scan.startedAt || null,
      done: scan.done === true,
      ...overrides
    }
  }

  function publishProgress(overrides = {}, { force = false } = {}) {
    const timestamp = Date.now()
    if (!force && timestamp - lastProgressSentAt < 250) return
    lastProgressSentAt = timestamp
    emitProgress(progressPayload(overrides))
  }

  function rangeForPeriod({ period, from, to, tz }) {
    return resolvedRangeToIso(
      usageTime.resolveCalendarPeriod({ period, now: now(), timeZone: tz, from, to })
    )
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
      scanning: Boolean(scanState && scanState.done !== true),
      scan: scanState ? progressPayload() : null,
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

  async function summary(validated = {}) {
    const period = validated.period || 'month'
    const tz = validated.tz || 'UTC'
    const range = rangeForPeriod({ ...validated, period, tz })
    const activeStore = ensureStore()
    const totals = toTotalsPayload(activeStore.sumRange({ fromIso: range.fromIso, toIso: range.toIso }))
    const current = now()
    const last7Window = usageTime.resolveRollingWindow({ days: 7, now: current, timeZone: tz })
    const last30Window = usageTime.resolveRollingWindow({ days: 30, now: current, timeZone: tz })
    const last7 = activeStore.sumRange({
      fromIso: new Date(last7Window.startUtcMs).toISOString(),
      toIso: new Date(last7Window.endUtcMs).toISOString()
    })
    const last30 = activeStore.sumRange({
      fromIso: new Date(last30Window.startUtcMs).toISOString(),
      toIso: new Date(last30Window.endUtcMs).toISOString()
    })
    // Active days = local calendar days with observed usage inside last-30d
    // (TokenTracker local-api.js counts observed days, not zero-filled rows).
    const last30Rows = activeStore.getRangeRows({
      fromIso: new Date(last30Window.startUtcMs).toISOString(),
      toIso: new Date(last30Window.endUtcMs).toISOString()
    })
    const observedDays = new Set()
    for (const row of last30Rows) {
      if ((Number(row.billable_total_tokens) || 0) > 0 || (Number(row.conversation_count) || 0) > 0) {
        observedDays.add(usageTime.zonedDayKey(row.hour_start, tz))
      }
    }
    const activeDays = observedDays.size
    const last30Billable = Number(last30.billable_total_tokens) || 0
    return {
      period,
      from: range.fromDay,
      to: range.toDay,
      tz,
      totals,
      rolling: {
        last7d: {
          billable_total_tokens: Number(last7.billable_total_tokens) || 0,
          conversation_count: Number(last7.conversation_count) || 0
        },
        last30d: {
          billable_total_tokens: last30Billable,
          conversation_count: Number(last30.conversation_count) || 0
        },
        avgPerActiveDay: activeDays > 0 ? Math.round(last30Billable / activeDays) : 0,
        activeDays
      },
      pricing: { mode: 'none', version: null }
    }
  }

  function rowsByZoneDay(rows, tz, range) {
    const grouped = new Map()
    for (const row of Array.isArray(rows) ? rows : []) {
      const day = usageTime.zonedDayKey(row.hour_start, tz)
      if (day < range.fromDay || day > range.toDay) continue
      const bucket = grouped.get(day) || emptyTotals()
      addTotals(bucket, row)
      grouped.set(day, bucket)
    }
    return grouped
  }

  async function daily(validated = {}) {
    const period = validated.period || 'month'
    const tz = validated.tz || 'UTC'
    const range = rangeForPeriod({ ...validated, period, tz })
    const activeStore = ensureStore()
    const rows = activeStore.getRangeRows({ fromIso: range.fromIso, toIso: range.toIso })
    const grouped = rowsByZoneDay(rows, tz, range)
    const out = []
    // Do not fabricate future days: month/week ranges include days after today,
    // and TT returns observed days only; zero-filling stops at local today.
    const todayKey = usageTime.zonedDayKey(now(), tz)
    const lastFillDay = range.toDay < todayKey ? range.toDay : todayKey
    let cursor = range.fromDay
    let guard = 0
    while (cursor <= lastFillDay && guard < 4000) {
      out.push(dailyRowFromTotals(cursor, grouped.get(cursor) || emptyTotals()))
      cursor = usageTime.addDaysToDayKey(cursor, 1)
      guard += 1
    }
    return { period, from: range.fromDay, to: range.toDay, tz, rows: out }
  }

  async function hourly(validated = {}) {
    const tz = validated.tz || 'UTC'
    const day = validated.day
    const bounds = usageTime.resolveDayBounds(day, tz)
    const range = resolvedRangeToIso({
      fromDay: day,
      toDay: day,
      startUtcMs: bounds.startUtcMs,
      endUtcMs: bounds.endUtcMs
    })
    const activeStore = ensureStore()
    const rows = activeStore.getRangeRows({ fromIso: range.fromIso, toIso: range.toIso })
    const buckets = Array.from({ length: 24 }, () => emptyTotals())
    for (const row of rows) {
      const hour = usageTime.zonedHour(row.hour_start, tz)
      if (!Number.isFinite(hour) || hour < 0 || hour > 23) continue
      addTotals(buckets[hour], row)
    }
    return {
      day,
      tz,
      from: range.fromIso,
      to: range.toIso,
      rows: buckets.map((totals, hour) => ({
        hour: `${day}T${String(hour).padStart(2, '0')}:00`,
        billable_total_tokens: totals.billable_total_tokens,
        total_tokens: totals.total_tokens,
        input_tokens: totals.input_tokens,
        output_tokens: totals.output_tokens,
        conversation_count: totals.conversation_count,
        total_cost_usd: null
      }))
    }
  }

  async function breakdown(validated = {}) {
    const period = validated.period || 'month'
    const tz = validated.tz || 'UTC'
    const range = rangeForPeriod({ ...validated, period, tz })
    const activeStore = ensureStore()
    const rows = activeStore.getRangeRows({ fromIso: range.fromIso, toIso: range.toIso })
    const totals = toTotalsPayload(activeStore.sumRange({ fromIso: range.fromIso, toIso: range.toIso }))
    const sources = new Map()
    const models = new Map()
    for (const row of rows) {
      const sourceEntry = sources.get(row.source) || {
        source: row.source,
        label: SOURCE_LABELS[row.source] || row.source,
        billable_total_tokens: 0,
        conversation_count: 0,
        models: new Set(),
        total_cost_usd: null
      }
      sourceEntry.billable_total_tokens += Number(row.billable_total_tokens) || 0
      sourceEntry.conversation_count += Number(row.conversation_count) || 0
      sourceEntry.models.add(row.model)
      sources.set(row.source, sourceEntry)
      const modelKey = `${row.source}\u0000${row.model}`
      const modelEntry = models.get(modelKey) || {
        source: row.source,
        model: row.model,
        billable_total_tokens: 0,
        conversation_count: 0,
        total_cost_usd: null,
        pricing: 'none'
      }
      modelEntry.billable_total_tokens += Number(row.billable_total_tokens) || 0
      modelEntry.conversation_count += Number(row.conversation_count) || 0
      models.set(modelKey, modelEntry)
    }
    const totalBillable = totals.billable_total_tokens || 0
    return {
      scope: validated.scope || 'source',
      period,
      from: range.fromDay,
      to: range.toDay,
      tz,
      totals,
      sources: [...sources.values()]
        .map((entry) => ({
          source: entry.source,
          label: entry.label,
          billable_total_tokens: entry.billable_total_tokens,
          sharePct: sharePct(entry.billable_total_tokens, totalBillable),
          modelCount: entry.models.size,
          conversationCount: entry.conversation_count,
          total_cost_usd: null
        }))
        .sort((a, b) => b.billable_total_tokens - a.billable_total_tokens),
      models: [...models.values()]
        .map((entry) => ({
          ...entry,
          sharePct: sharePct(entry.billable_total_tokens, totalBillable)
        }))
        .sort((a, b) => b.billable_total_tokens - a.billable_total_tokens)
    }
  }

  async function heatmap(validated = {}) {
    const tz = validated.tz || 'UTC'
    const weeks = validated.weeks || 52
    const activeStore = ensureStore()
    const today = usageTime.zonedDayKey(now(), tz)
    const weekdayIndex = usageTime.zonedWeekdayIndex(now(), tz) // 0 = Monday
    const currentWeekStart = usageTime.addDaysToDayKey(today, -weekdayIndex)
    const fromDay = usageTime.addDaysToDayKey(currentWeekStart, -(weeks - 1) * 7)
    const toDay = usageTime.addDaysToDayKey(currentWeekStart, 6)
    const startBounds = usageTime.resolveDayBounds(fromDay, tz)
    const endBounds = usageTime.resolveDayBounds(toDay, tz)
    const rows = activeStore.getRangeRows({
      fromIso: new Date(startBounds.startUtcMs).toISOString(),
      toIso: new Date(endBounds.endUtcMs).toISOString()
    })
    const byDay = new Map()
    for (const row of rows) {
      const day = usageTime.zonedDayKey(row.hour_start, tz)
      if (day < fromDay || day > toDay) continue
      const entry = byDay.get(day) || { billable_total_tokens: 0, total_tokens: 0, conversation_count: 0 }
      entry.billable_total_tokens += Number(row.billable_total_tokens) || 0
      entry.total_tokens += Number(row.total_tokens) || 0
      entry.conversation_count += Number(row.conversation_count) || 0
      byDay.set(day, entry)
    }
    let max = 0
    for (const entry of byDay.values()) max = Math.max(max, entry.billable_total_tokens)
    let activeDays = 0
    const grid = []
    for (let week = 0; week < weeks; week += 1) {
      const cells = []
      for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
        const day = usageTime.addDaysToDayKey(fromDay, week * 7 + dayIndex)
        if (day > today) {
          cells.push(null)
          continue
        }
        const entry = byDay.get(day) || { billable_total_tokens: 0, total_tokens: 0, conversation_count: 0 }
        if (entry.billable_total_tokens > 0) activeDays += 1
        cells.push({
          day,
          value: entry.billable_total_tokens,
          level: heatmapLevel(entry.billable_total_tokens, max),
          total_tokens: entry.total_tokens,
          conversation_count: entry.conversation_count
        })
      }
      grid.push(cells)
    }
    return {
      from: fromDay,
      to: toDay,
      tz,
      weekStartsOn: 'mon',
      activeDays,
      max,
      weeks: grid
    }
  }

  async function refresh(validated = {}) {
    if (!settingsEnabled()) return { started: false, reason: 'disabled' }
    if (scanState && scanState.done !== true) {
      return { started: false, scanId: scanState.scanId }
    }
    scanSequence += 1
    const scanId = `usage-scan-${Date.now()}-${scanSequence}`
    const controller = {
      scanId,
      reason: validated.reason || 'manual',
      startedAt: isoNow(),
      phase: 'discovering',
      tool: null,
      toolIndex: 0,
      toolCount: tools.listTools().length,
      filesDone: 0,
      filesTotal: 0,
      bytesRead: 0,
      buckets: 0,
      done: false,
      cancelled: false,
      error: null
    }
    scanState = controller
    publishProgress({}, { force: true })
    runScan(controller)
      .catch((error) => {
        controller.error = error?.message || String(error)
      })
      .finally(() => {
        controller.done = true
        controller.phase = controller.cancelled ? 'cancelled' : controller.error ? 'error' : 'done'
        publishProgress({}, { force: true })
        if (scanState === controller) scanState = null
      })
    return { started: true, scanId }
  }

  async function runScan(controller) {
    const activeStore = ensureStore()
    const context = homeContext()
    const registry = tools.listTools()
    controller.toolCount = registry.length
    let failures = 0
    try {
      for (let index = 0; index < registry.length; index += 1) {
        const tool = registry[index]
        if (controller.cancelled) break
        controller.tool = tool.source
        controller.toolIndex = index
        controller.phase = 'discovering'
        controller.filesDone = 0
        controller.filesTotal = 0
        publishProgress({}, { force: true })

        let probe
        try {
          probe = await tool.probe(context)
        } catch (error) {
          failures += 1
          lastError = error?.message || String(error)
          activeStore.recordSourceStatus({
            source: tool.source,
            state: 'error',
            detected: false,
            readable: false,
            files: 0,
            lastScanAt: isoNow(),
            lastError: lastError
          })
          continue
        }
        if (probe.state !== 'ok' || probe.files.length === 0) {
          activeStore.recordSourceStatus(probeToStatus(probe, { scannedAt: isoNow() }))
          continue
        }

        controller.phase = 'scanning'
        controller.filesTotal = probe.files.length
        publishProgress({}, { force: true })
        try {
          const committed = await scanProbe(activeStore, probe, controller, context)
          controller.buckets += committed
        } catch (error) {
          failures += 1
          lastError = error?.message || String(error)
          activeStore.recordSourceStatus({
            ...probeToStatus(probe, { scannedAt: isoNow() }),
            state: 'error',
            lastError
          })
        }
        if (controller.cancelled) break
      }
      if (controller.cancelled) return
      controller.phase = 'finalizing'
      publishProgress({}, { force: true })
      const finishedAt = isoNow()
      activeStore.setAppMeta('lastScanAt', finishedAt)
      if (failures > 0) activeStore.setAppMeta('lastError', lastError || 'scan failed')
      else activeStore.setAppMeta('lastError', '')
      lastError = failures > 0 ? lastError : null
    } finally {
      if (controller.done !== true) controller.done = true
    }
  }

  async function scanProbe(activeStore, probe, controller, context) {
    const source = probe.source
    const previousRows = activeStore.loadBucketRows([source])
    const cursors = activeStore.loadCursors(source) || {}
    cursors.hourly = usageState.buildHourlyState(previousRows)
    const queuePath = path.join(usageDir(), 'runtime', 'queue.jsonl')
    const workerClient = getWorkerClient()
    const result = await workerClient.scanTool(
      { source, files: probe.files, cursors, queuePath },
      {
        onProgress: (progress) => {
          controller.filesDone = Math.max(controller.filesDone, Number(progress?.index) || 0)
          controller.filesTotal = Number(progress?.total) || controller.filesTotal
          controller.buckets = Number(progress?.bucketsQueued) || controller.buckets
          publishProgress()
        }
      }
    )
    const previousByKey = new Map(previousRows.map((row) => [usageState.bucketKeyForRow(row), row]))
    const removed = (Array.isArray(result?.removed) ? result.removed : [])
      .map((key) => previousByKey.get(key))
      .filter(Boolean)
    const upserts = Array.isArray(result?.upserts) ? result.upserts : []
    const scannedAt = isoNow()
    activeStore.commitScan({
      source,
      upserts,
      removed,
      cursors: result?.cursors && typeof result.cursors === 'object' ? result.cursors : cursors,
      status: {
        ...probeToStatus(probe, { scannedAt }),
        state: 'ok',
        coverageStartAt: probe.coverageStartAt || activeStore.getCoverageStart(source)
      },
      now: now()
    })
    return upserts.length
  }

  async function clear() {
    if (scanState) scanState.cancelled = true
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
    return { ok: true, clearedAt: isoNow() }
  }

  function quiesce() {
    if (scanState) scanState.cancelled = true
    if (ownedWorkerClient) {
      try { ownedWorkerClient.dispose() } catch (_error) {}
      ownedWorkerClient = null
    }
    if (store) {
      try { store.close() } catch (_error) {}
      store = null
      storePath = null
    }
    return { ok: true }
  }

  function resume() {
    return { ok: true }
  }

  function getDiagnostics() {
    return {
      storeOpen: Boolean(store && store.isOpen()),
      scanning: Boolean(scanState && scanState.done !== true),
      scan: scanState ? progressPayload() : null,
      lastError,
      worker: ownedWorkerClient ? ownedWorkerClient.getDiagnostics() : null
    }
  }

  const handlers = {
    status: () => getStatus(),
    refresh,
    summary,
    daily,
    hourly,
    breakdown,
    heatmap,
    clear
  }

  return {
    clear,
    getDiagnostics,
    getStatus,
    handlers,
    quiesce,
    refresh,
    resume,
    scanProbe
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
