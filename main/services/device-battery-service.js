'use strict'

const { spawn } = require('node:child_process')
const path = require('node:path')
const { createLineReader, createSnapshotDecoder, normalizeSystem } = require('./device-battery-protocol')

const EXE = 'HighlighterDeviceBattery.exe'
const START_TIMEOUT = 15_000 // BrimDeck settles all sources, or reports partial after 10s.
const HEARTBEAT_TIMEOUT = 45_000 // The native Dispatcher sends a snapshot at least every 15s.
const STOP_TIMEOUT = 2_800 // Give the native worker time to release handles / finish its probe marker.
const REFRESH_INTERVAL = 5_000
const REFRESH_TIMEOUT = 17_000 // Includes the cooldown and the helper's bounded read round.

function resolveDeviceBatteryExecutable({ appRoot, resourcesPath, packaged }) {
  return packaged
    ? path.join(resourcesPath, 'native', 'device-battery', EXE)
    : path.join(appRoot, 'native', 'device-battery', 'bin', EXE)
}

function createDeviceBatteryService({
  getExecutable,
  getStateDirectory,
  spawnProcess = spawn,
  supported = process.platform === 'win32' && process.arch === 'x64',
  onSnapshot = () => {},
  log = () => {},
  now = () => Date.now(),
  monotonicNow = () => performance.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  startTimeoutMs = START_TIMEOUT,
  heartbeatTimeoutMs = HEARTBEAT_TIMEOUT,
  stopTimeoutMs = STOP_TIMEOUT,
  refreshTimeoutMs = REFRESH_TIMEOUT
} = {}) {
  let active = false
  let disposed = false
  let processRun = null
  let pendingRefresh = null
  let refreshId = 0
  let revision = 0
  let lastRefresh = -Infinity
  let lastStart = -Infinity
  const decode = createSnapshotDecoder()
  const empty = (status) => ({ status, system: normalizeSystem(), devices: [] })
  let snapshot = { ...empty('paused'), updatedAt: null, revision }

  function publish(next) {
    snapshot = {
      ...next,
      updatedAt: next.status === 'ready' || next.status === 'partial' ? now() : null,
      revision: ++revision
    }
    onSnapshot(snapshot)
  }

  function finishRefresh(status) {
    const request = pendingRefresh
    if (!request) return
    pendingRefresh = null
    clearTimer(request.deadline)
    clearTimer(request.dispatchTimer)
    request.resolve({ status, snapshot })
  }

  function stop(run, reason = 'cancelled') {
    if (!run || run.stopping) return
    run.stopping = reason
    clearTimer(run.watchdog)
    // An ended pipe also tells the sidecar to stop if Electron exits abruptly.
    // Drop late stdout immediately, but keep draining so the child can exit.
    run.stopTimer = setTimer(() => {
      if (processRun !== run) return
      try { run.child.kill() } catch { /* close/error might already be queued */ }
    }, stopTimeoutMs)
    try { run.child.stdin?.end('stop\n') } catch { /* bounded by stopTimer */ }
  }

  function fail(run, reason) {
    if (run && (processRun !== run || run.stopping)) return
    log('device-battery-helper', { reason })
    stop(run, 'failed')
    if (active) publish(empty('unavailable'))
    finishRefresh('unavailable')
  }

  function start() {
    if (!active || disposed || processRun) return
    if (!supported) { publish(empty('unavailable')); return }
    lastStart = monotonicNow()
    let child
    try {
      const executable = getExecutable()
      const stateDirectory = getStateDirectory()
      if (!path.isAbsolute(executable) || !path.isAbsolute(stateDirectory)) throw new Error('battery-path-not-absolute')
      child = spawnProcess(executable, ['--watch', '--state-dir', stateDirectory], {
        cwd: path.dirname(executable),
        windowsHide: true,
        shell: false,
        stdio: ['pipe', 'pipe', 'ignore']
      })
    } catch {
      fail(null, 'launch-failed')
      return
    }
    let resolveExit
    const exited = new Promise((resolve) => { resolveExit = resolve })
    const run = { child, exited, stopping: null, restartOnClose: false, sawResult: false, watchdog: null, stopTimer: null }
    processRun = run

    const read = createLineReader((line) => {
      if (processRun !== run || run.stopping || !active) return false
      const { refresh: receipt, ...next } = decode(line)
      if (next.status !== 'loading') {
        clearTimer(run.watchdog)
        run.sawResult = true
        run.watchdog = setTimer(() => fail(run, 'heartbeat-timeout'), heartbeatTimeoutMs)
      } else if (run.sawResult) {
        throw new Error('battery-loading-after-result')
      }
      publish(next)
      if (receipt && pendingRefresh?.run === run && pendingRefresh.id === receipt.id) {
        finishRefresh(next.status === 'partial' ? 'partial' : receipt.status)
      }
    })
    child.stdout.on('data', (data) => {
      if (!active || processRun !== run || run.stopping) return
      try { read(data) } catch { fail(run, 'invalid-output') }
    })
    child.stdout.on('error', () => fail(run, 'output-failed'))
    child.stdin.on('error', () => fail(run, 'command-pipe-closed'))
    child.on('error', () => fail(run, 'launch-or-process-failed'))
    child.once('close', () => {
      clearTimer(run.watchdog)
      clearTimer(run.stopTimer)
      resolveExit()
      if (processRun !== run) return
      processRun = null
      if (!active || disposed) return
      if (!run.stopping) {
        fail(null, 'unexpected-exit')
        return
      }
      if (run.stopping === 'cancelled' || run.restartOnClose) start()
      dispatchRefresh()
    })
    run.watchdog = setTimer(() => fail(run, 'startup-timeout'), startTimeoutMs)
  }

  function setActive(value) {
    if (disposed || active === Boolean(value)) return
    active = Boolean(value)
    if (active) {
      publish(empty('loading'))
      if (processRun?.stopping) processRun.restartOnClose = true
      else start()
    } else {
      stop(processRun)
      publish(empty('paused'))
      finishRefresh('paused')
    }
  }

  function dispatchRefresh() {
    const request = pendingRefresh
    if (!request || request.run) return
    clearTimer(request.dispatchTimer)
    if (processRun?.stopping) return // Its close handler will retry, with the same deadline.
    const instant = monotonicNow()
    const last = processRun ? lastRefresh : Math.max(lastRefresh, lastStart)
    const wait = REFRESH_INTERVAL - (instant - last)
    if (wait > 0) {
      request.dispatchTimer = setTimer(dispatchRefresh, Math.ceil(wait))
      return
    }
    if (!processRun) {
      publish(empty('loading'))
      start()
    }
    const run = processRun
    if (!run || pendingRefresh !== request || run.stopping) return
    request.run = run
    lastRefresh = instant
    try {
      run.child.stdin.write(`refresh ${request.id}\n`)
    } catch {
      fail(run, 'command-pipe-closed')
    }
  }

  function refresh() {
    if (!active || disposed) return Promise.resolve({ status: 'paused', snapshot })
    if (!supported) return Promise.resolve({ status: 'unavailable', snapshot })
    if (pendingRefresh) return pendingRefresh.promise
    // A heartbeat or unsolicited device change must not finish a manual read.
    // Keep one request across IPC callers and defer (rather than drop) a click
    // inside the native-read cooldown.
    refreshId = refreshId === 0x7fffffff ? 1 : refreshId + 1
    let resolve
    const promise = new Promise((done) => { resolve = done })
    pendingRefresh = {
      id: refreshId, promise, resolve, run: null, dispatchTimer: null,
      deadline: setTimer(() => finishRefresh('timeout'), refreshTimeoutMs)
    }
    dispatchRefresh()
    return promise
  }

  function dispose() {
    if (disposed) return processRun?.exited || null
    setActive(false)
    disposed = true
    return processRun?.exited || null
  }

  return { setActive, refresh, dispose, getSnapshot: () => snapshot }
}

module.exports = { createDeviceBatteryService, resolveDeviceBatteryExecutable }
