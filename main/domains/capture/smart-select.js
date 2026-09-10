'use strict'

function createSmartSelectSessionClass({ spawn, log }) {
  return class SmartSelectSession {
    constructor(executablePath) {
      this.process = spawn(executablePath, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      this.buffer = ''
      this.nextRequestId = 1
      this.pending = new Map()
      this.windowRects = []
      this.ready = false
      this.available = true
      this.readyPromise = new Promise((resolve, reject) => {
        this.resolveReady = resolve
        this.rejectReady = reject
      })
      this.process.stdout.setEncoding('utf8')
      this.process.stdout.on('data', (chunk) => this.handleOutput(chunk))
      this.process.stderr.setEncoding('utf8')
      this.process.stderr.on('data', (chunk) => {
        const message = String(chunk || '').trim()
        if (message) log('Smart select helper:', message)
      })
      this.process.once('error', (error) => this.handleExit(error))
      this.process.once('exit', (code) => this.handleExit(new Error(`helper exited (${code})`)))
    }

    handleOutput(chunk) {
      this.buffer += chunk
      let newline = this.buffer.indexOf('\n')
      while (newline >= 0) {
        const line = this.buffer.slice(0, newline).trim()
        this.buffer = this.buffer.slice(newline + 1)
        if (line) {
          try {
            const message = JSON.parse(line)
            if (message.ready) {
              this.ready = true
              this.windowRects = Array.isArray(message.windows) ? message.windows : []
              this.resolveReady(true)
            } else if (Number.isInteger(message.id)) {
              const request = this.pending.get(message.id)
              if (request) {
                clearTimeout(request.timer)
                this.pending.delete(message.id)
                request.resolve(Array.isArray(message.rects) ? message.rects : [])
              }
            }
          } catch (error) {
            log('Smart select response error:', error.message)
          }
        }
        newline = this.buffer.indexOf('\n')
      }
    }

    handleExit(error) {
      if (!this.available) return
      this.available = false
      if (!this.ready) this.rejectReady(error)
      for (const request of this.pending.values()) {
        clearTimeout(request.timer)
        request.resolve([])
      }
      this.pending.clear()
    }

    async waitUntilReady(timeout = 1000) {
      let timer
      try {
        await Promise.race([
          this.readyPromise,
          new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('helper startup timeout')), timeout)
          })
        ])
      } finally {
        clearTimeout(timer)
      }
    }

    query(x, y) {
      if (!this.available || !this.ready) return Promise.resolve([])
      const id = this.nextRequestId++
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          const requests = [...this.pending.values()]
          this.pending.clear()
          this.available = false
          try { this.process.kill() } catch {}
          requests.forEach((request) => {
            clearTimeout(request.timer)
            request.resolve([])
          })
        }, 350)
        this.pending.set(id, { resolve, timer })
        try {
          this.process.stdin.write(`${id} ${Math.round(x)} ${Math.round(y)}\n`)
        } catch {
          clearTimeout(timer)
          this.pending.delete(id)
          resolve([])
        }
      })
    }

    findWindowAt(x, y) {
      const rect = this.windowRects.find((item) => (
        x >= item.left && x <= item.right && y >= item.top && y <= item.bottom
      ))
      return rect ? [rect] : []
    }

    dispose() {
      if (!this.available && this.process.killed) return
      this.available = false
      for (const request of this.pending.values()) {
        clearTimeout(request.timer)
        request.resolve([])
      }
      this.pending.clear()
      try { this.process.stdin.end('quit\n') } catch {}
      try { this.process.kill() } catch {}
    }
  }
}

function convertSmartSelectRects(rects, context) {
  const physical = context.physicalBounds
  const logical = context.captureBounds
  if (!physical?.width || !physical?.height) return []
  const scaleX = logical.width / physical.width
  const scaleY = logical.height / physical.height
  const result = []
  for (const rect of rects) {
    const left = Math.max(0, Math.min(logical.width, (Number(rect.left) - physical.x) * scaleX))
    const top = Math.max(0, Math.min(logical.height, (Number(rect.top) - physical.y) * scaleY))
    const right = Math.max(0, Math.min(logical.width, (Number(rect.right) - physical.x) * scaleX))
    const bottom = Math.max(0, Math.min(logical.height, (Number(rect.bottom) - physical.y) * scaleY))
    const candidate = {
      x: Math.round(Math.min(left, right)),
      y: Math.round(Math.min(top, bottom)),
      w: Math.round(Math.abs(right - left)),
      h: Math.round(Math.abs(bottom - top))
    }
    if (candidate.w < 3 || candidate.h < 3) continue
    if (result.some((item) => item.x === candidate.x && item.y === candidate.y && item.w === candidate.w && item.h === candidate.h)) continue
    result.push(candidate)
  }
  return result
}

module.exports = {
  createSmartSelectSessionClass,
  convertSmartSelectRects
}
