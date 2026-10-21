// Usage scan collector (B2) — owns the scan state machine and orchestration.
//
// The composition root (`usage-feature.js`) owns IPC/lifecycle; this module owns
// the scan itself (plan §2.2):
//   - tools run serially in registry order (codex > dsh > opencode);
//   - one scan at a time (single-flight) and one refresh per tool;
//   - per tool: probe -> load state/cursors from SQLite -> worker parse ->
//     ONE transaction commit (buckets + deletions + cursors + source status);
//   - progress is throttled to <= 4 pushes/s; the final push has done=true;
//   - cancellation kills the worker (its pending request rejects) and keeps the
//     DB at the last committed tool boundary;
//   - a worker crash rejects that tool only: its cursor stays at the previous
//     value, its source status records the error, and the next tool re-forks.
//   - page-open triggers are throttled (default 5 min since the last scan);
//     manual refresh always runs.
//
// `getStore` and `getWorkerClient` are lazy getters so the collector (and its
// utility process) is only created when the page actually scans.

const path = require('node:path')

const usageState = require('./usage-state')

const DEFAULT_SCAN_THROTTLE_MS = 5 * 60 * 1000
const PROGRESS_THROTTLE_MS = 250

function createUsageCollector({
  getStore,
  getWorkerClient,
  getSettings,
  getHomeContext,
  getUsageDir,
  tools,
  log = () => {},
  now = () => new Date(),
  onProgress = () => {},
  pageOpenThrottleMs = DEFAULT_SCAN_THROTTLE_MS,
  progressThrottleMs = PROGRESS_THROTTLE_MS
} = {}) {
  if (typeof getStore !== 'function') throw new TypeError('usage collector requires getStore()')
  if (typeof getWorkerClient !== 'function') throw new TypeError('usage collector requires getWorkerClient()')
  if (!tools || typeof tools.listTools !== 'function') throw new TypeError('usage collector requires the tool registry')
  const homeContext = typeof getHomeContext === 'function' ? getHomeContext : () => ({ homeDir: null, explicitHome: false })

  let scanState = null
  let scanSequence = 0
  let lastProgressAt = 0
  let disposed = false

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

  function lastScanAtMs() {
    try {
      const value = getStore().getAppMeta('lastScanAt')
      const ms = value ? Date.parse(value) : NaN
      return Number.isFinite(ms) ? ms : null
    } catch (_error) {
      return null
    }
  }

  function currentToolCount() {
    try {
      return tools.listTools().length
    } catch (_error) {
      return 0
    }
  }

  function progressPayload(overrides = {}) {
    const scan = scanState || {}
    return {
      scanId: scan.scanId || null,
      phase: scan.phase || 'idle',
      tool: scan.tool || null,
      toolIndex: Number.isFinite(scan.toolIndex) ? scan.toolIndex : 0,
      toolCount: Number.isFinite(scan.toolCount) ? scan.toolCount : currentToolCount(),
      filesDone: Number(overrides.filesDone ?? scan.filesDone) || 0,
      filesTotal: Number(overrides.filesTotal ?? scan.filesTotal) || 0,
      bytesRead: Number(scan.bytesRead) || 0,
      buckets: Number(overrides.buckets ?? scan.buckets) || 0,
      startedAt: scan.startedAt || null,
      done: scan.done === true,
      ...overrides
    }
  }

  function publishProgress(overrides = {}, { force = false } = {}) {
    const timestamp = Date.now()
    if (!force && timestamp - lastProgressAt < progressThrottleMs) return
    lastProgressAt = timestamp
    try {
      onProgress(progressPayload(overrides))
    } catch (error) {
      log(`usage collector: progress listener failed: ${error?.message || String(error)}`)
    }
  }

  function getScan() {
    return scanState ? progressPayload() : null
  }

  function isScanning() {
    return Boolean(scanState && scanState.done !== true)
  }

  async function refresh({ reason = 'manual' } = {}) {
    if (disposed) return { started: false, reason: 'disposed' }
    if (!settingsEnabled()) return { started: false, reason: 'disabled' }
    if (scanState && scanState.done !== true) {
      return { started: false, scanId: scanState.scanId }
    }
    if (reason === 'page-open') {
      const last = lastScanAtMs()
      const currentMs = now() instanceof Date ? now().getTime() : new Date(now()).getTime()
      if (last != null && Number.isFinite(currentMs) && currentMs - last < pageOpenThrottleMs) {
        return { started: false, throttled: true }
      }
    }
    scanSequence += 1
    const controller = {
      scanId: `usage-scan-${Date.now()}-${scanSequence}`,
      reason,
      startedAt: isoNow(),
      phase: 'discovering',
      tool: null,
      toolIndex: 0,
      toolCount: currentToolCount(),
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
    return { started: true, scanId: controller.scanId }
  }

  async function runScan(controller) {
    const store = getStore()
    const context = homeContext()
    const registry = tools.listTools()
    controller.toolCount = registry.length
    let failures = 0
    let lastError = null
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
          store.recordSourceStatus({
            source: tool.source,
            state: 'error',
            detected: false,
            readable: false,
            files: 0,
            lastScanAt: isoNow(),
            lastError
          })
          continue
        }
        if (probe.state !== 'ok' || probe.files.length === 0) {
          store.recordSourceStatus(probeStatus(probe, isoNow()))
          continue
        }
        controller.phase = 'scanning'
        controller.filesTotal = probe.files.length
        publishProgress({}, { force: true })
        try {
          const committed = await scanProbe(store, probe, controller)
          controller.buckets += committed
        } catch (error) {
          failures += 1
          lastError = error?.message || String(error)
          if (!controller.cancelled) {
            store.recordSourceStatus({
              ...probeStatus(probe, isoNow()),
              state: 'error',
              lastError: lastError || 'scan failed'
            })
          }
        }
        if (controller.cancelled) break
      }
      if (controller.cancelled) return
      controller.phase = 'finalizing'
      publishProgress({}, { force: true })
      store.setAppMeta('lastScanAt', isoNow())
      store.setAppMeta('lastError', failures > 0 ? lastError || 'scan failed' : '')
    } finally {
      if (controller.done !== true) controller.done = true
    }
  }

  function probeStatus(probe, scannedAt) {
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

  async function scanProbe(store, probe, controller) {
    const { source } = probe
    const previousRows = store.loadBucketRows([source])
    const cursors = store.loadCursors(source) || {}
    cursors.hourly = usageState.buildHourlyState(previousRows)
    const queuePath = path.join(getUsageDir(), 'runtime', 'queue.jsonl')
    const result = await getWorkerClient().scanTool(
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
    store.commitScan({
      source,
      upserts,
      removed,
      cursors: result?.cursors && typeof result.cursors === 'object' ? result.cursors : cursors,
      status: {
        ...probeStatus(probe, isoNow()),
        state: 'ok',
        coverageStartAt: probe.coverageStartAt || store.getCoverageStart(source)
      },
      now: now()
    })
    return upserts.length
  }

  // Cancellation kills the worker so a large parse stops immediately; the
  // pending request rejects, the in-flight tool is not committed, and the scan
  // finishes with phase "cancelled".
  function cancel(reason = 'cancelled') {
    if (!scanState || scanState.done === true) return false
    scanState.cancelled = true
    try {
      const client = getWorkerClient()
      if (client && typeof client.cancel === 'function') client.cancel(reason)
    } catch (_error) {}
    return true
  }

  function dispose() {
    disposed = true
    if (scanState) scanState.cancelled = true
    try {
      const client = getWorkerClient()
      if (client && typeof client.dispose === 'function') client.dispose()
    } catch (_error) {}
  }

  return {
    cancel,
    dispose,
    getScan,
    isScanning,
    refresh,
    runScan
  }
}

module.exports = {
  DEFAULT_SCAN_THROTTLE_MS,
  PROGRESS_THROTTLE_MS,
  createUsageCollector
}
