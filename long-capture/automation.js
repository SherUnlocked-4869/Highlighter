(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.LongCaptureAutomation = api
})(typeof self !== 'undefined' ? self : globalThis, function () {
  const DEFAULT_AUTOMATION_LIMITS = Object.freeze({
    maxFrames: 200,
    maxDurationMs: 120000,
    endStillFrames: 2,
    initialEndStillFrames: 4,
    failedRetries: 2
  })

  class AutomationController {
    constructor(options = {}) {
      this.options = {
        maxFrames: Math.max(2, Math.round(Number(options.maxFrames) || DEFAULT_AUTOMATION_LIMITS.maxFrames)),
        maxDurationMs: Math.max(1000, Math.round(Number(options.maxDurationMs) || DEFAULT_AUTOMATION_LIMITS.maxDurationMs)),
        endStillFrames: Math.max(1, Math.round(Number(options.endStillFrames) || DEFAULT_AUTOMATION_LIMITS.endStillFrames)),
        initialEndStillFrames: Math.max(
          1,
          Math.round(Number(options.initialEndStillFrames) || DEFAULT_AUTOMATION_LIMITS.initialEndStillFrames)
        ),
        failedRetries: Math.max(1, Math.round(Number(options.failedRetries) || DEFAULT_AUTOMATION_LIMITS.failedRetries))
      }
      this.reset()
    }

    reset() {
      this.running = false
      this.startedAt = 0
      this.frames = 0
      this.scrolls = 0
      this.matchedFrames = 0
      this.stillFrames = 0
      this.failedFrames = 0
      this.stopReason = ''
    }

    start(now = Date.now()) {
      this.reset()
      this.running = true
      this.startedAt = Number(now) || Date.now()
      return this.snapshot()
    }

    stop(reason = 'paused') {
      this.running = false
      this.stopReason = String(reason || 'paused')
      return { action: 'stop', reason: this.stopReason, state: this.snapshot() }
    }

    checkLimits(now) {
      if (this.frames >= this.options.maxFrames) return this.stop('max-frames')
      if (Number(now) - this.startedAt >= this.options.maxDurationMs) return this.stop('max-duration')
      return null
    }

    acceptFrame(result = {}, now = Date.now()) {
      if (!this.running) return { action: 'idle', state: this.snapshot() }
      const limit = this.checkLimits(now)
      if (limit) return limit

      if (result.status === 'initialized') {
        this.frames = Math.max(1, this.frames)
        this.stillFrames = 0
        this.failedFrames = 0
        return { action: 'scroll', append: 'initial', state: this.snapshot() }
      }
      if (result.status === 'matched') {
        this.frames++
        this.matchedFrames++
        this.stillFrames = 0
        this.failedFrames = 0
        const frameLimit = this.checkLimits(now)
        if (frameLimit) return { ...frameLimit, append: 'matched' }
        return { action: 'scroll', append: 'matched', state: this.snapshot() }
      }
      if (result.status === 'still') {
        this.stillFrames++
        this.failedFrames = 0
        const requiredConfirmations = this.matchedFrames
          ? this.options.endStillFrames
          : this.options.initialEndStillFrames
        if (this.stillFrames >= requiredConfirmations) return this.stop('end-reached')
        return { action: 'scroll', probe: true, state: this.snapshot() }
      }

      this.failedFrames++
      this.stillFrames = 0
      if (this.failedFrames >= this.options.failedRetries) return this.stop('low-confidence')
      return { action: 'retry', delay: 'retry', state: this.snapshot() }
    }

    acceptScroll(result = {}, now = Date.now()) {
      if (!this.running) return { action: 'idle', state: this.snapshot() }
      const limit = this.checkLimits(now)
      if (limit) return limit
      if (!result.ok) return this.stop(result.reason || 'scroll-failed')
      this.scrolls++
      return { action: 'capture', state: this.snapshot() }
    }

    snapshot() {
      return {
        running: this.running,
        startedAt: this.startedAt,
        frames: this.frames,
        scrolls: this.scrolls,
        matchedFrames: this.matchedFrames,
        stillFrames: this.stillFrames,
        failedFrames: this.failedFrames,
        stopReason: this.stopReason,
        limits: { ...this.options }
      }
    }
  }

  return {
    AutomationController,
    DEFAULT_AUTOMATION_LIMITS
  }
})
