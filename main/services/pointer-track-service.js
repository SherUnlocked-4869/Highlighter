'use strict'

// Recording event track: bounded, wall-clock pointer collection (R5 §2.1/§2.2,
// docs/plans/2026-11-03-recording-r5-contracts.md).
//
// The service owns the utility-process host that carries the native mouse hook
// (main/services/pointer-hook-host.js). It is deliberately small and synchronous on the message
// path: every native event either lands in a bounded buffer or is dropped. Wall-clock -> media
// time mapping, coordinate normalization and the events.json projection are the record domain's
// job, so this module stays unit-testable with a fake host (tests/pointer-track-service.test.js).
//
// Buffers are bounded per contract §2.1: pointer <= 20000, clicks <= 2000. On overflow the OLDEST
// entry is dropped and `truncated` is set, so a long recording degrades its early events instead of
// growing without bound (and the editor can say the track is partial).
//
// `stop()` asks the host to stop, waits at most `stopTimeoutMs` (1 s by default) and then kills the
// process. No timer, listener or child survives a stop.

const path = require('node:path')

const POINTER_LIMIT = 20000
const CLICK_LIMIT = 2000
const STOP_TIMEOUT_MS = 1000
const SAMPLED_AT_HZ = 20
const POINTER_KINDS = Object.freeze(['move', 'down', 'up'])

class PointerTrackService {
  constructor({
    createHost,
    log = () => {},
    pointerLimit = POINTER_LIMIT,
    clickLimit = CLICK_LIMIT,
    stopTimeoutMs = STOP_TIMEOUT_MS
  } = {}) {
    if (typeof createHost !== 'function') throw new TypeError('PointerTrackService requires a createHost factory')
    this.createHost = createHost
    this.log = typeof log === 'function' ? log : () => {}
    this.pointerLimit = Math.max(1, Math.round(Number(pointerLimit) || POINTER_LIMIT))
    this.clickLimit = Math.max(1, Math.round(Number(clickLimit) || CLICK_LIMIT))
    this.stopTimeoutMs = Math.max(0, Math.round(Number(stopTimeoutMs) || STOP_TIMEOUT_MS))
    this.host = null
    this.running = false
    this.pointer = []
    this.clicks = []
    this.truncated = false
    this.unsubscribers = []
    this.stopWaiter = null
  }

  isRunning() {
    return this.running === true && !!this.host
  }

  start() {
    if (this.running && this.host) return true
    // A previous session's host is always gone before a new session starts.
    this.finishHost()
    this.pointer = []
    this.clicks = []
    this.truncated = false
    let host
    try {
      host = this.createHost()
    } catch (error) {
      this.log('Pointer track host unavailable:', error?.message || error)
      return false
    }
    if (!host || typeof host.postMessage !== 'function') {
      this.log('Pointer track host factory returned no host')
      return false
    }
    this.host = host
    try {
      if (typeof host.onMessage === 'function') this.unsubscribers.push(host.onMessage((message) => this.handleMessage(message)))
      if (typeof host.onExit === 'function') this.unsubscribers.push(host.onExit(() => this.handleHostExit()))
      host.postMessage({ type: 'start' })
    } catch (error) {
      this.log('Pointer track host start failed:', error?.message || error)
      this.finishHost()
      return false
    }
    this.running = true
    return true
  }

  handleMessage(message) {
    if (!message || typeof message !== 'object') return
    if (message.type === 'status') {
      if (message.status === 'start-failed') {
        this.log('Pointer hook start failed')
        this.running = false
      }
      // The host answers `stopped` after it released the native hook; stop() then disposes the
      // process. `stopped` must settle the waiter, otherwise every stop would wait for the timeout.
      if (message.status === 'stopped') this.settleStop()
      return
    }
    if (message.type !== 'pointer') return
    if (!this.running) return
    const kind = POINTER_KINDS.includes(message.kind) ? message.kind : ''
    const x = Number(message.x)
    const y = Number(message.y)
    const at = Number(message.at)
    if (!kind || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(at)) return
    if (kind === 'move') {
      if (this.pointer.length >= this.pointerLimit) {
        this.pointer.shift()
        this.truncated = true
      }
      this.pointer.push({ x, y, at })
      return
    }
    // Only a button DOWN is a click; the matching up carries no new user intent for the track.
    if (kind !== 'down') return
    if (this.clicks.length >= this.clickLimit) {
      this.clicks.shift()
      this.truncated = true
    }
    const button = Number.isInteger(Number(message.button)) ? Number(message.button) : -1
    this.clicks.push({ x, y, button, at })
  }

  handleHostExit() {
    const wasRunning = this.running
    this.running = false
    this.host = null
    if (wasRunning) this.log('Pointer track host exited unexpectedly')
    this.settleStop()
  }

  settleStop() {
    const waiter = this.stopWaiter
    this.stopWaiter = null
    if (waiter) waiter()
  }

  // Resolves with the collected buffers. A host that does not answer within `stopTimeoutMs` is
  // killed and the buffers already received are returned (the recording must never hang on it).
  async stop() {
    if (!this.host) {
      this.running = false
      return this.results()
    }
    const host = this.host
    this.running = false
    const stopped = new Promise((resolve) => { this.stopWaiter = resolve })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      this.log('Pointer track host stop timed out; killing it')
      try { host.kill() } catch {}
      this.settleStop()
    }, this.stopTimeoutMs)
    timer.unref?.()
    try {
      host.postMessage({ type: 'stop' })
    } catch (error) {
      this.log('Pointer track host stop message failed:', error?.message || error)
      this.settleStop()
    }
    await stopped
    clearTimeout(timer)
    this.finishHost()
    if (timedOut) this.log('Pointer track host was killed after the stop timeout')
    return this.results()
  }

  finishHost() {
    const host = this.host
    this.host = null
    this.running = false
    for (const unsubscribe of this.unsubscribers.splice(0)) {
      try { unsubscribe() } catch {}
    }
    if (!host) return
    try { host.postMessage({ type: 'dispose' }) } catch {}
    try { host.kill() } catch {}
  }

  dispose() {
    this.settleStop()
    this.finishHost()
  }

  results() {
    return {
      sampledAtHz: SAMPLED_AT_HZ,
      pointer: this.pointer.map((entry) => ({ x: entry.x, y: entry.y, at: entry.at })),
      clicks: this.clicks.map((entry) => ({ x: entry.x, y: entry.y, button: entry.button, at: entry.at })),
      truncated: this.truncated === true
    }
  }
}

// Utility-process host factory, mirroring SelectionHookService.createUtilityProcessHostFactory
// (main/services/selection-hook-service.js). Electron's `utilityProcess` is injected rather than
// required so this module stays loadable in plain node (tests).
function createPointerUtilityProcessHostFactory({ utilityProcess, hostPath, serviceName = 'highlighter-pointer-hook' } = {}) {
  return function createUtilityProcessHost() {
    if (!utilityProcess || typeof utilityProcess.fork !== 'function') {
      throw new Error('utilityProcess.fork is unavailable')
    }
    const child = utilityProcess.fork(hostPath, [], {
      serviceName,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const exited = new Promise((resolve) => child.once('exit', resolve))
    return {
      exited,
      postMessage(message) { child.postMessage(message) },
      onMessage(listener) {
        const wrapped = (data) => listener(data)
        child.on('message', wrapped)
        return () => child.removeListener('message', wrapped)
      },
      onExit(listener) {
        const wrapped = (code, reason) => listener({ code, reason })
        child.on('exit', wrapped)
        return () => child.removeListener('exit', wrapped)
      },
      kill() {
        try { child.kill() } catch {}
      }
    }
  }
}

function defaultPointerHostPath() {
  return path.join(__dirname, 'pointer-hook-host.js')
}

function createPointerTrackService(options = {}) {
  return new PointerTrackService(options)
}

module.exports = {
  PointerTrackService,
  POINTER_LIMIT,
  CLICK_LIMIT,
  STOP_TIMEOUT_MS,
  SAMPLED_AT_HZ,
  createPointerTrackService,
  createPointerUtilityProcessHostFactory,
  defaultPointerHostPath
}
