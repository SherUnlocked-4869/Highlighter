// Utility-process client for the usage scan worker.
//
// The Electron main process forks `main/usage-scan-worker.js` lazily (first
// scan), keeps it warm across tool scans and re-forks after a crash. All
// Electron access is lazy / injectable so unit tests run under plain node with
// a fake child:
//
//   const client = createUsageWorkerClient({ fork: () => fakeChild })
//
// Request lifecycle: one in-flight scan per worker (the collector serializes
// tools), each with an id, a timeout and progress forwarding. A worker exit or
// timeout rejects the pending request instead of hanging the scan state machine.

const path = require('node:path')

const WORKER_PATH = path.join(__dirname, '..', 'usage-scan-worker.js')
const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 60 * 1000
const DEFAULT_IDLE_TIMEOUT_MS = 0 // 0 disables idle exit (backward compatible)

function defaultFork(workerPath) {
  const electron = require('electron')
  const utilityProcess = electron?.utilityProcess
  if (!utilityProcess || typeof utilityProcess.fork !== 'function') {
    throw new Error('utilityProcess.fork is unavailable')
  }
  return utilityProcess.fork(workerPath, [], {
    serviceName: 'highlighter-usage-scan',
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

function createUsageWorkerClient({
  fork = null,
  workerPath = WORKER_PATH,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  log = () => {}
} = {}) {
  const idleTimeout = Number.isFinite(idleTimeoutMs) && idleTimeoutMs > 0 ? idleTimeoutMs : 0
  let child = null
  let disposed = false
  let nextRequestId = 1
  let idleTimer = null
  const pending = new Map()
  const diagnostics = {
    forkCount: 0,
    lastForkStartedAt: null,
    lastReadyAt: null,
    lastColdStartMs: null,
    lastExit: null,
    requests: 0,
    idleTimeoutMs: idleTimeout,
    lastIdleExitAt: null
  }

  function clearIdleTimer() {
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
  }

  // Armed only once the last in-flight request has settled. The timer is
  // unref'd so it never keeps the process alive, and it is cleared by every
  // path that starts or ends worker activity.
  function armIdleTimer() {
    if (disposed || idleTimeout <= 0 || pending.size > 0 || !child) return
    clearIdleTimer()
    idleTimer = setTimeout(() => {
      idleTimer = null
      if (disposed || pending.size > 0 || !child) return
      const idleChild = child
      child = null
      diagnostics.lastIdleExitAt = Date.now()
      log(`usage scan worker exited after ${idleTimeout}ms idle`)
      if (typeof idleChild.kill === 'function') {
        try { idleChild.kill() } catch (_error) {}
      }
    }, idleTimeout)
    if (typeof idleTimer.unref === 'function') idleTimer.unref()
  }

  function settle(id, error, result) {
    const entry = pending.get(id)
    if (!entry) return
    pending.delete(id)
    if (entry.timer) clearTimeout(entry.timer)
    if (error) entry.reject(error)
    else entry.resolve(result)
    if (pending.size === 0) armIdleTimer()
  }

  function handleMessage(message) {
    const payload = message && typeof message === 'object' ? message : null
    if (!payload) return
    if (payload.type === 'ready') {
      diagnostics.lastReadyAt = Date.now()
      if (diagnostics.lastForkStartedAt != null) {
        diagnostics.lastColdStartMs = diagnostics.lastReadyAt - diagnostics.lastForkStartedAt
      }
      return
    }
    if (payload.type === 'progress') {
      const entry = pending.get(payload.id)
      if (entry && typeof entry.onProgress === 'function') {
        try { entry.onProgress(payload.progress) } catch (_error) {}
      }
      return
    }
    if (payload.type === 'result') {
      settle(payload.id, null, payload.result)
      return
    }
    if (payload.type === 'error') {
      settle(payload.id, new Error(payload.message || 'usage scan worker failed'))
    }
  }

  // `ownerChild` is the worker that emitted the exit. A late exit from an
  // already-replaced worker (idle kill / cancel) must not tear down the fresh
  // worker or reject its in-flight request.
  function handleExit(ownerChild, code, reason) {
    const detail = reason ? ` (${reason})` : ''
    diagnostics.lastExit = { code: code ?? null, reason: reason ?? null, at: Date.now() }
    if (ownerChild !== child) {
      log(`usage scan worker exited late (code ${code ?? 'unknown'})${detail}`)
      return
    }
    clearIdleTimer()
    child = null
    for (const id of [...pending.keys()]) {
      settle(id, new Error(`usage scan worker exited (code ${code ?? 'unknown'})${detail}`))
    }
    log(`usage scan worker exited (code ${code ?? 'unknown'})${detail}`)
  }

  function ensureChild() {
    if (disposed) throw new Error('usage worker client is disposed')
    clearIdleTimer()
    if (child) return child
    const spawn = typeof fork === 'function' ? fork : defaultFork
    diagnostics.forkCount += 1
    diagnostics.lastForkStartedAt = Date.now()
    const created = spawn(workerPath)
    if (!created || typeof created.postMessage !== 'function' || typeof created.on !== 'function') {
      diagnostics.lastForkStartedAt = null
      throw new Error('usage worker fork returned an invalid child process')
    }
    created.on('message', handleMessage)
    created.on('exit', (code, reason) => handleExit(created, code, reason))
    child = created
    return child
  }

  function scanTool(request, { onProgress = null, timeoutMs = requestTimeoutMs } = {}) {
    if (disposed) return Promise.reject(new Error('usage worker client is disposed'))
    if (!request || typeof request !== 'object') {
      return Promise.reject(new Error('usage worker scan requires a request'))
    }
    return new Promise((resolve, reject) => {
      let activeChild
      try {
        activeChild = ensureChild()
      } catch (error) {
        reject(error)
        return
      }
      const id = `scan-${nextRequestId}`
      nextRequestId += 1
      diagnostics.requests += 1
      const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
        ? setTimeout(() => {
            settle(id, new Error(`usage scan worker request timed out after ${timeoutMs}ms`))
          }, timeoutMs)
        : null
      if (timer && typeof timer.unref === 'function') timer.unref()
      pending.set(id, { resolve, reject, onProgress, timer })
      try {
        activeChild.postMessage({ type: 'scan', id, request })
      } catch (error) {
        settle(id, error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  function dispose() {
    if (disposed) return
    disposed = true
    clearIdleTimer()
    for (const id of [...pending.keys()]) {
      settle(id, new Error('usage worker client was disposed'))
    }
    const activeChild = child
    child = null
    if (activeChild && typeof activeChild.kill === 'function') {
      try { activeChild.kill() } catch (_error) {}
    }
  }

  // Cancellation keeps the client usable: the current worker is killed (its
  // pending request rejects) and the next scanTool() call forks a fresh one.
  function cancel(reason = 'cancelled') {
    clearIdleTimer()
    const activeChild = child
    child = null
    for (const id of [...pending.keys()]) {
      settle(id, new Error(`usage scan cancelled (${reason})`))
    }
    if (activeChild && typeof activeChild.kill === 'function') {
      try { activeChild.kill() } catch (_error) {}
    }
  }

  return {
    cancel,
    dispose,
    ensureChild,
    getDiagnostics: () => ({
      ...diagnostics,
      pending: pending.size,
      running: Boolean(child),
      idleTimerArmed: Boolean(idleTimer)
    }),
    isRunning: () => Boolean(child),
    scanTool
  }
}

module.exports = {
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  WORKER_PATH,
  createUsageWorkerClient,
  defaultFork
}
