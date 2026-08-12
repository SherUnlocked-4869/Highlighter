class SelectionHookService {
  constructor({
    createHook,
    handlers = {},
    log = () => {},
    startOptions = { debug: false, enableClipboard: false },
    restartDelayMs = 1200,
    retryDelayMs = 2500,
    maxStartRetries = 2,
    setTimer = setTimeout,
    clearTimer = clearTimeout
  } = {}) {
    if (typeof createHook !== 'function') throw new Error('SelectionHookService requires createHook')
    this.createHook = createHook
    this.handlers = handlers
    this.log = log
    this.startOptions = startOptions
    this.restartDelayMs = restartDelayMs
    this.retryDelayMs = retryDelayMs
    this.maxStartRetries = maxStartRetries
    this.setTimer = setTimer
    this.clearTimer = clearTimer
    this.hook = null
    this.restartTimer = null
    this.disposed = false
  }

  isRunning() {
    if (!this.hook) return false
    try {
      return !!this.hook.isRunning()
    } catch {
      return false
    }
  }

  bindHook(hook) {
    const eventHandlers = {
      'text-selection': this.handlers.textSelection,
      'mouse-down': this.handlers.mouseDown,
      'key-down': this.handlers.keyDown,
      'mouse-wheel': this.handlers.mouseWheel,
      status: this.handlers.status
    }
    for (const [eventName, handler] of Object.entries(eventHandlers)) {
      if (typeof handler === 'function') hook.on(eventName, handler)
    }
    hook.on('error', (error) => {
      this.log('Selection hook error:', error?.message || String(error))
      if (typeof this.handlers.error === 'function') this.handlers.error(error)
    })
  }

  start(reason = 'startup', retryAttempt = 0) {
    if (this.disposed) return false
    this.cancelScheduledRestart()
    if (this.isRunning()) return true
    this.stopHook()

    let hook = null
    try {
      hook = this.createHook()
      this.bindHook(hook)
      const started = hook.start(this.startOptions)
      if (started === false) throw new Error('selection-hook returned an unsuccessful start result')
      this.hook = hook
      this.log('Selection hook started:', reason)
      return true
    } catch (error) {
      this.cleanupHook(hook)
      if (this.hook === hook) this.hook = null
      this.log('Selection hook unavailable:', error?.message || String(error))
      if (!this.disposed && retryAttempt < this.maxStartRetries) {
        this.scheduleStart(reason, this.retryDelayMs, retryAttempt + 1)
      }
      return false
    }
  }

  scheduleStart(reason, delayMs, retryAttempt = 0) {
    if (this.disposed) return false
    this.cancelScheduledRestart()
    this.restartTimer = this.setTimer(() => {
      this.restartTimer = null
      this.start(reason, retryAttempt)
    }, delayMs)
    this.restartTimer?.unref?.()
    return true
  }

  scheduleRestart(reason = 'system-resume', delayMs = this.restartDelayMs) {
    if (this.disposed) return false
    this.cancelScheduledRestart()
    this.stopHook()
    this.log('Selection hook restart scheduled:', reason)
    return this.scheduleStart(reason, delayMs)
  }

  updateStartOptions(patch, reason = 'configuration-change') {
    if (!patch || typeof patch !== 'object') throw new TypeError('Selection hook options require an object')
    const nextOptions = { ...this.startOptions, ...patch }
    const changed = Object.keys(nextOptions).some((key) => nextOptions[key] !== this.startOptions[key])
    if (!changed) return false
    this.startOptions = nextOptions
    if (!this.hook || this.disposed) return true
    this.stopHook()
    this.start(reason)
    return true
  }

  suspend(reason = 'system-suspend') {
    if (this.disposed) return false
    this.cancelScheduledRestart()
    this.stopHook()
    this.log('Selection hook suspended:', reason)
    return true
  }

  cancelScheduledRestart() {
    if (!this.restartTimer) return
    this.clearTimer(this.restartTimer)
    this.restartTimer = null
  }

  cleanupHook(hook) {
    if (!hook) return
    try {
      if (typeof hook.cleanup === 'function') hook.cleanup()
      else if (typeof hook.stop === 'function') hook.stop()
    } catch (error) {
      this.log('Selection hook shutdown failed:', error?.message || String(error))
      try { hook.removeAllListeners?.() } catch {}
    }
  }

  stopHook() {
    const hook = this.hook
    this.hook = null
    this.cleanupHook(hook)
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.cancelScheduledRestart()
    this.stopHook()
  }
}

module.exports = { SelectionHookService }
