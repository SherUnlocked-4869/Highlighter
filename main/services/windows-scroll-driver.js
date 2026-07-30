const { spawn } = require('child_process')

const DEFAULT_START_TIMEOUT_MS = 3000
const DEFAULT_REQUEST_TIMEOUT_MS = 1500
const DEFAULT_SMOOTH_STEPS = 6
const DEFAULT_SMOOTH_DURATION_MS = 270

function splitWheelDelta(delta, requestedSteps = DEFAULT_SMOOTH_STEPS) {
  const total = Math.round(Number(delta) || 0)
  if (!total) return []
  const steps = Math.max(1, Math.min(Math.abs(total), Math.round(Number(requestedSteps) || DEFAULT_SMOOTH_STEPS)))
  const sign = Math.sign(total)
  const magnitude = Math.abs(total)
  const base = Math.floor(magnitude / steps)
  let remainder = magnitude % steps
  return Array.from({ length: steps }, () => sign * (base + (remainder-- > 0 ? 1 : 0)))
}

class WindowsScrollDriver {
  constructor(options = {}) {
    if (!options.executablePath) throw new Error('自动滚动组件路径不能为空')
    this.executablePath = options.executablePath
    this.spawnProcess = options.spawnProcess || spawn
    this.startTimeoutMs = Number(options.startTimeoutMs) || DEFAULT_START_TIMEOUT_MS
    this.requestTimeoutMs = Number(options.requestTimeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS
    this.wait = options.wait || ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)))
    this.process = null
    this.buffer = ''
    this.ready = false
    this.readyPromise = null
    this.resolveReady = null
    this.rejectReady = null
    this.nextRequestId = 1
    this.pending = new Map()
    this.target = '0'
    this.disposed = false
  }

  start() {
    if (this.disposed) throw new Error('自动滚动组件已关闭')
    if (this.ready) return Promise.resolve(true)
    if (this.readyPromise) return this.readyPromise

    this.process = this.spawnProcess(this.executablePath, [], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.process.stdout.setEncoding('utf8')
    this.process.stderr.setEncoding('utf8')
    this.readyPromise = new Promise((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    const timer = setTimeout(() => this.fail(new Error('自动滚动组件启动超时')), this.startTimeoutMs)
    this.readyPromise.finally(() => clearTimeout(timer)).catch(() => {})

    this.process.stdout.on('data', (chunk) => this.consume(chunk))
    this.process.stderr.on('data', () => {})
    this.process.on('error', (error) => this.fail(error))
    this.process.on('exit', (code) => {
      if (!this.disposed) this.fail(new Error(`自动滚动组件异常退出：${code}`))
    })
    return this.readyPromise
  }

  consume(chunk) {
    this.buffer += chunk
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (line) this.consumeLine(line)
      newline = this.buffer.indexOf('\n')
    }
  }

  consumeLine(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (message.ready) {
      this.ready = true
      this.resolveReady?.(true)
      this.resolveReady = null
      this.rejectReady = null
      return
    }
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    clearTimeout(pending.timer)
    if (message.ok && message.target) this.target = String(message.target)
    pending.resolve({
      ok: !!message.ok,
      target: String(message.target || '0'),
      processId: Number(message.processId) || 0,
      reason: String(message.reason || '')
    })
  }

  async scroll({ x, y, delta = -720, excludedProcessId = process.pid } = {}) {
    await this.start()
    if (!this.process || this.disposed) throw new Error('自动滚动组件不可用')
    const pointX = Math.round(Number(x))
    const pointY = Math.round(Number(y))
    const wheelDelta = Math.max(-1200, Math.min(1200, Math.round(Number(delta) || -720)))
    if (!Number.isFinite(pointX) || !Number.isFinite(pointY)) throw new Error('自动滚动坐标无效')

    const id = this.nextRequestId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('自动滚动响应超时'))
      }, this.requestTimeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.process.stdin.write(
        `${id} ${pointX} ${pointY} ${wheelDelta} ${this.target} ${Math.max(0, Math.round(Number(excludedProcessId) || 0))} ${this.requestTimeoutMs}\n`,
        (error) => {
          if (!error) return
          const pending = this.pending.get(id)
          if (!pending) return
          this.pending.delete(id)
          clearTimeout(pending.timer)
          reject(error)
        }
      )
    })
  }

  async smoothScroll({
    x,
    y,
    delta = -720,
    excludedProcessId = process.pid,
    steps = DEFAULT_SMOOTH_STEPS,
    durationMs = DEFAULT_SMOOTH_DURATION_MS
  } = {}) {
    const pulses = splitWheelDelta(delta, steps)
    const intervalMs = pulses.length > 1
      ? Math.max(0, Math.round(Number(durationMs) || DEFAULT_SMOOTH_DURATION_MS) / (pulses.length - 1))
      : 0
    let result = { ok: true, target: this.target, processId: 0, reason: '' }
    for (let index = 0; index < pulses.length; index++) {
      result = await this.scroll({ x, y, delta: pulses[index], excludedProcessId })
      if (!result.ok) return { ...result, pulses: index + 1 }
      if (intervalMs && index < pulses.length - 1) await this.wait(intervalMs)
    }
    return { ...result, pulses: pulses.length }
  }

  fail(error) {
    if (this.readyPromise && !this.ready) this.rejectReady?.(error)
    this.resolveReady = null
    this.rejectReady = null
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    this.dispose()
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    const child = this.process
    this.process = null
    if (child && !child.killed) {
      try { child.stdin.write('quit\n') } catch {}
      try { child.kill() } catch {}
    }
  }
}

module.exports = {
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_SMOOTH_DURATION_MS,
  DEFAULT_SMOOTH_STEPS,
  DEFAULT_START_TIMEOUT_MS,
  splitWheelDelta,
  WindowsScrollDriver
}
