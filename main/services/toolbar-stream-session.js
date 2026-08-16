class ToolbarStreamSession {
  constructor({
    win,
    timeoutMs = 30000,
    timeoutMessage = '模型长时间无输出，已取消。免费模型高峰期易排队超时，可重试或更换模型',
    onFinish = () => {},
    createAbortController = () => new AbortController(),
    setTimer = setTimeout,
    clearTimer = clearTimeout
  } = {}) {
    if (!win) throw new Error('ToolbarStreamSession requires a window')
    this.win = win
    this.timeoutMs = timeoutMs
    this.timeoutMessage = timeoutMessage
    this.onFinish = onFinish
    this.abortController = createAbortController()
    this.setTimer = setTimer
    this.clearTimer = clearTimer
    this.idleTimer = null
    this.cancelled = false
    this.cancelReason = ''
    this.finished = false
  }

  get signal() {
    return this.abortController.signal
  }

  matchesSender(sender) {
    return !this.finished && sender === this.win?.webContents
  }

  armTimeout() {
    if (this.finished) return false
    this.clearTimer(this.idleTimer)
    this.idleTimer = this.setTimer(() => {
      this.cancel(this.timeoutMessage, { notify: true })
    }, this.timeoutMs)
    this.idleTimer?.unref?.()
    return true
  }

  cancel(reason = 'cancelled', { notify = false } = {}) {
    if (this.finished) return false
    this.cancelled = true
    this.cancelReason = reason
    if (notify && !this.win.isDestroyed()) {
      this.win.webContents.send('stream:error', { error: reason })
    }
    try { this.abortController.abort(reason) } catch {}
    this.finish()
    return true
  }

  finish() {
    if (this.finished) return false
    this.finished = true
    this.clearTimer(this.idleTimer)
    this.idleTimer = null
    this.onFinish(this)
    return true
  }
}

module.exports = { ToolbarStreamSession }
