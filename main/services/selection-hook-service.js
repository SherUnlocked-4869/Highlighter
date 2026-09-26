'use strict'

const path = require('node:path')

const DEFAULTS = {
  restartDelayMs: 1200,
  retryDelayMs: 2500,
  maxStartRetries: 2,
  // Liveness probes for a wedged host. A blocked synchronous UIA/COM call
  // occupies the host event loop, so a missed pong is the signal to recycle the
  // process. The timeout must stay above the longest legitimate synchronous
  // block in the host (~435-700ms, the clipboard fallback path) to avoid
  // recycling a host that is merely busy.
  heartbeatIntervalMs: 1000,
  heartbeatTimeoutMs: 1500,
  maxHeartbeatFailures: 2,
  // Re-probe promptly after the first miss instead of waiting a full interval.
  heartbeatConfirmDelayMs: 250,
  powerDebounceMs: 1500,
  unexpectedStopRestartDelayMs: 400
}

class SelectionHookService {
  constructor({
    createHost,
    handlers = {},
    log = () => {},
    startOptions = { debug: false, enableClipboard: false },
    restartDelayMs = DEFAULTS.restartDelayMs,
    retryDelayMs = DEFAULTS.retryDelayMs,
    maxStartRetries = DEFAULTS.maxStartRetries,
    heartbeatIntervalMs = DEFAULTS.heartbeatIntervalMs,
    heartbeatTimeoutMs = DEFAULTS.heartbeatTimeoutMs,
    maxHeartbeatFailures = DEFAULTS.maxHeartbeatFailures,
    heartbeatConfirmDelayMs = DEFAULTS.heartbeatConfirmDelayMs,
    powerDebounceMs = DEFAULTS.powerDebounceMs,
    unexpectedStopRestartDelayMs = DEFAULTS.unexpectedStopRestartDelayMs,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    now = () => Date.now()
  } = {}) {
    if (typeof createHost !== 'function') throw new Error('SelectionHookService requires createHost')
    this.createHost = createHost
    this.handlers = handlers
    this.log = log
    this.startOptions = { debug: false, enableClipboard: false, ...startOptions }
    this.restartDelayMs = restartDelayMs
    this.retryDelayMs = retryDelayMs
    this.maxStartRetries = maxStartRetries
    this.heartbeatIntervalMs = heartbeatIntervalMs
    this.heartbeatTimeoutMs = heartbeatTimeoutMs
    this.maxHeartbeatFailures = maxHeartbeatFailures
    this.heartbeatConfirmDelayMs = heartbeatConfirmDelayMs
    this.powerDebounceMs = powerDebounceMs
    this.unexpectedStopRestartDelayMs = unexpectedStopRestartDelayMs
    this.setTimer = setTimer
    this.clearTimer = clearTimer
    this.now = now

    this.host = null
    this.restartTimer = null
    this.powerTimer = null
    this.heartbeatTimer = null
    this.heartbeatTimeoutTimer = null
    this.disposed = false
    this.intentionalStop = false
    this.desiredRunning = false
    this.hostReady = false
    this.hookReportedRunning = false
    this.pendingStartReason = null
    this.pendingStartAttempt = 0
    this.heartbeatFailures = 0
    this.lastHookInputAt = 0
    this.hostRecreateCount = 0
    this.heartbeatFailureCount = 0
    this.lastRecreateReason = null
    this.hostPid = null
  }

  static createUtilityProcessHostFactory({ utilityProcess, hostPath }) {
    return function createUtilityProcessHost() {
      if (!utilityProcess || typeof utilityProcess.fork !== 'function') {
        throw new Error('utilityProcess.fork is unavailable')
      }
      const child = utilityProcess.fork(hostPath, [], {
        serviceName: 'highlighter-selection-hook',
        stdio: ['ignore', 'pipe', 'pipe']
      })
      return {
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

  static defaultHostPath() {
    return path.join(__dirname, 'selection-hook-host.js')
  }

  isRunning() {
    return !!this.host && this.hostReady && this.hookReportedRunning
  }

  getDiagnostics() {
    return {
      running: this.isRunning(),
      desiredRunning: this.desiredRunning,
      hostReady: this.hostReady,
      hookReportedRunning: this.hookReportedRunning,
      hostPid: this.hostPid,
      hostRecreateCount: this.hostRecreateCount,
      heartbeatFailureCount: this.heartbeatFailureCount,
      consecutiveHeartbeatFailures: this.heartbeatFailures,
      lastRecreateReason: this.lastRecreateReason
    }
  }

  start(reason = 'startup', retryAttempt = 0) {
    if (this.disposed) return false
    this.desiredRunning = true
    this.intentionalStop = false
    this.cancelScheduledRestart()
    this.cancelPowerTimer()

    if (this.isRunning()) return true

    this.stopHost('restart-before-start')
    this.hostReady = false
    this.hookReportedRunning = false

    let host = null
    try {
      host = this.createHost()
    } catch (error) {
      this.log('Selection hook host unavailable:', error?.message || String(error))
      this.scheduleRetry(reason, retryAttempt)
      return false
    }

    this.host = host
    this.pendingStartReason = reason
    this.pendingStartAttempt = retryAttempt
    this.unbindHost = host.onMessage((message) => this.handleHostMessage(message))
    this.unbindHostExit = host.onExit((info) => this.handleHostExit(info))

    try {
      host.postMessage({ type: 'start', options: { ...this.startOptions } })
    } catch (error) {
      this.log('Selection hook start post failed:', error?.message || String(error))
      this.stopHost('start-post-failed')
      this.scheduleRetry(reason, retryAttempt)
      return false
    }

    this.armHeartbeat()
    // Success is confirmed asynchronously via host status:started.
    return true
  }

  scheduleRetry(reason, retryAttempt) {
    if (this.disposed || !this.desiredRunning) return false
    if (retryAttempt >= this.maxStartRetries) {
      this.log('Selection hook start retries exhausted:', reason)
      return false
    }
    this.scheduleStart(reason, this.retryDelayMs, retryAttempt + 1)
    return true
  }

  scheduleStart(reason, delayMs, retryAttempt = 0) {
    if (this.disposed) return false
    this.cancelScheduledRestart()
    this.restartTimer = this.setTimer(() => {
      this.restartTimer = null
      if (!this.desiredRunning || this.disposed) return
      this.start(reason, retryAttempt)
    }, delayMs)
    this.restartTimer?.unref?.()
    return true
  }

  scheduleRestart(reason = 'system-resume', delayMs = this.restartDelayMs) {
    if (this.disposed) return false
    this.desiredRunning = true
    this.intentionalStop = false
    this.cancelScheduledRestart()
    this.stopHost(`schedule-restart:${reason}`)
    this.log('Selection hook restart scheduled:', reason)
    return this.scheduleStart(reason, delayMs, 0)
  }

  /**
   * Coalesce rapid suspend/resume/lock/unlock storms into one terminal action.
   * type: 'sleep' | 'wake'
   */
  notePowerEvent(type, reason) {
    if (this.disposed) return false
    // The debounced action stops or recreates the host anyway, so an in-flight
    // probe is moot and must not be counted as a failure while the OS suspends
    // the process. Its timeout now equals the debounce window, so drop it first.
    this.cancelHeartbeat()
    this.cancelPowerTimer()
    this.powerTimer = this.setTimer(() => {
      this.powerTimer = null
      if (this.disposed) return
      if (type === 'sleep') this.suspend(reason)
      else if (this.desiredRunning || type === 'wake') this.scheduleRestart(reason)
    }, this.powerDebounceMs)
    this.powerTimer?.unref?.()
    return true
  }

  updateStartOptions(patch, reason = 'configuration-change') {
    if (!patch || typeof patch !== 'object') throw new TypeError('Selection hook options require an object')
    const nextOptions = { ...this.startOptions, ...patch }
    const changed = Object.keys(nextOptions).some((key) => nextOptions[key] !== this.startOptions[key])
    if (!changed) return false
    this.startOptions = nextOptions
    if (!this.host || this.disposed || !this.desiredRunning) return true
    try {
      this.host.postMessage({ type: 'update-options', options: { ...this.startOptions } })
    } catch (error) {
      this.log('Selection hook option update failed:', error?.message || String(error))
      this.scheduleRestart(reason)
    }
    return true
  }

  suspend(reason = 'system-suspend') {
    if (this.disposed) return false
    this.desiredRunning = false
    this.intentionalStop = true
    this.cancelScheduledRestart()
    this.cancelPowerTimer()
    this.cancelHeartbeat()
    this.stopHost(`suspend:${reason}`)
    this.log('Selection hook suspended:', reason)
    return true
  }

  cancelScheduledRestart() {
    if (!this.restartTimer) return
    this.clearTimer(this.restartTimer)
    this.restartTimer = null
  }

  cancelPowerTimer() {
    if (!this.powerTimer) return
    this.clearTimer(this.powerTimer)
    this.powerTimer = null
  }

  armHeartbeat(delayMs = this.heartbeatIntervalMs) {
    this.cancelHeartbeat()
    if (this.disposed || !this.desiredRunning) return
    this.heartbeatTimer = this.setTimer(() => this.runHeartbeat(), delayMs)
    this.heartbeatTimer?.unref?.()
  }

  cancelHeartbeat() {
    if (this.heartbeatTimer) {
      this.clearTimer(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    if (this.heartbeatTimeoutTimer) {
      this.clearTimer(this.heartbeatTimeoutTimer)
      this.heartbeatTimeoutTimer = null
    }
  }

  runHeartbeat() {
    if (this.disposed || !this.desiredRunning || !this.host) return
    const host = this.host
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      if (this.heartbeatTimeoutTimer) {
        this.clearTimer(this.heartbeatTimeoutTimer)
        this.heartbeatTimeoutTimer = null
      }
      this.armHeartbeat()
    }

    this.heartbeatTimeoutTimer = this.setTimer(() => {
      this.heartbeatTimeoutTimer = null
      if (settled || this.disposed || this.host !== host) return
      settled = true
      this.heartbeatFailures += 1
      this.heartbeatFailureCount += 1
      this.log('Selection hook heartbeat timeout:', this.heartbeatFailures)
      if (this.heartbeatFailures >= this.maxHeartbeatFailures) {
        this.heartbeatFailures = 0
        this.forceHostRecreate('heartbeat-timeout')
      } else {
        this.armHeartbeat(this.heartbeatConfirmDelayMs)
      }
    }, this.heartbeatTimeoutMs)
    this.heartbeatTimeoutTimer?.unref?.()

    try {
      host.postMessage({ type: 'ping' })
    } catch (error) {
      finish()
      this.forceHostRecreate(`ping-failed:${error?.message || error}`)
    }
  }

  forceHostRecreate(reason) {
    if (this.disposed || !this.desiredRunning) return false
    this.hostRecreateCount += 1
    this.lastRecreateReason = reason
    this.log('Selection hook host recreate:', reason, {
      count: this.hostRecreateCount,
      failures: this.heartbeatFailureCount,
      pid: this.hostPid
    })
    this.stopHost(reason)
    return this.scheduleStart(reason, this.unexpectedStopRestartDelayMs, 0)
  }

  stopHost(reason = 'stop') {
    this.cancelHeartbeat()
    const host = this.host
    this.host = null
    this.hostReady = false
    this.hookReportedRunning = false
    this.hostPid = null
    this.pendingStartReason = null
    this.pendingStartAttempt = 0
    if (this.unbindHost) {
      try { this.unbindHost() } catch {}
      this.unbindHost = null
    }
    if (this.unbindHostExit) {
      try { this.unbindHostExit() } catch {}
      this.unbindHostExit = null
    }
    if (!host) return false
    try {
      host.postMessage({ type: 'stop', reason })
    } catch {}
    try { host.kill() } catch (error) {
      this.log('Selection hook host kill failed:', error?.message || String(error))
    }
    return true
  }

  handleHostMessage(message) {
    if (this.disposed || !message || typeof message !== 'object') return
    switch (message.type) {
      case 'ready':
        this.hostReady = true
        break
      case 'pong':
        this.heartbeatFailures = 0
        if (this.heartbeatTimeoutTimer) {
          this.clearTimer(this.heartbeatTimeoutTimer)
          this.heartbeatTimeoutTimer = null
        }
        this.hookReportedRunning = message.hookRunning === true
        if (message.pid) this.hostPid = message.pid
        if (message.lastInputAt) this.lastHookInputAt = message.lastInputAt
        this.armHeartbeat()
        break
      case 'status':
        this.handleHostStatus(message)
        break
      case 'event':
        this.handleHostEvent(message)
        break
      case 'error':
        this.log('Selection hook error:', message.message || 'unknown')
        if (typeof this.handlers.error === 'function') {
          this.handlers.error(new Error(message.message || 'selection-hook error'))
        }
        break
      default:
        break
    }
  }

  handleHostStatus(message) {
    const status = message.status
    if (status === 'started') {
      this.hookReportedRunning = true
      this.heartbeatFailures = 0
      const reason = this.pendingStartReason || 'host'
      this.pendingStartReason = null
      this.log('Selection hook started:', reason)
      this.armHeartbeat()
      return
    }
    if (status === 'start-failed') {
      this.hookReportedRunning = false
      const attempt = this.pendingStartAttempt
      const reason = this.pendingStartReason || 'start-failed'
      this.pendingStartReason = null
      this.log('Selection hook start failed on host')
      this.stopHost('start-failed')
      if (this.desiredRunning && !this.disposed) {
        this.scheduleRetry(reason, attempt)
      }
      return
    }
    if (status === 'stopped') {
      this.hookReportedRunning = false
      if (typeof this.handlers.status === 'function') this.handlers.status(status)
      if (this.intentionalStop || !this.desiredRunning || this.disposed) return
      this.log('Selection hook stopped unexpectedly; recovering')
      this.stopHost('unexpected-stop')
      this.scheduleStart('unexpected-stop', this.unexpectedStopRestartDelayMs, 0)
    }
  }

  handleHostEvent(message) {
    const event = message.event
    const data = message.data
    this.lastHookInputAt = this.now()
    if (event === 'text-selection' && typeof this.handlers.textSelection === 'function') {
      this.handlers.textSelection(data)
      return
    }
    if (event === 'mouse-down' && typeof this.handlers.mouseDown === 'function') {
      this.handlers.mouseDown(data)
      return
    }
    if (event === 'key-down' && typeof this.handlers.keyDown === 'function') {
      this.handlers.keyDown(data)
      return
    }
    if (event === 'mouse-wheel' && typeof this.handlers.mouseWheel === 'function') {
      this.handlers.mouseWheel(data)
    }
  }

  handleHostExit(info = {}) {
    if (this.disposed) return
    const wasDesired = this.desiredRunning && !this.intentionalStop
    this.hostReady = false
    this.hookReportedRunning = false
    this.log('Selection hook host exited:', info.code ?? info.reason ?? 'unknown')
    if (!wasDesired) return
    this.forceHostRecreate('host-exit')
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.desiredRunning = false
    this.intentionalStop = true
    this.cancelScheduledRestart()
    this.cancelPowerTimer()
    this.cancelHeartbeat()
    const host = this.host
    this.stopHost('dispose')
    if (host) {
      try { host.postMessage({ type: 'dispose' }) } catch {}
    }
  }
}

module.exports = { SelectionHookService, SELECTION_HOOK_HOST_DEFAULTS: DEFAULTS }
