const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { StringDecoder } = require('node:string_decoder')

const MODEL_FILES = [
  'ch_PP-OCRv4_det_mobile.onnx',
  'ch_ppocr_mobile_v2.0_cls_mobile.onnx',
  'ch_PP-OCRv4_rec_mobile.onnx'
]

// DEV-06: optional stdin binary image frames. The legacy newline JSON protocol
// that writes a temporary PNG and sends `imagePath` stays fully supported: it is
// the fallback whenever the sidecar does not advertise this token in its ready
// line. Wire layout (little endian, mirrors native/ocr/src/main.rs):
//   magic "HLOC" | version u8 | kind u8 | reserved u16 | headerLen u32 | bodyLen u32
//   header: UTF-8 JSON object {id, action, ...options}
//   body: exactly bodyLen encoded PNG bytes
const FRAME_MAGIC = Buffer.from('HLOC', 'ascii')
const FRAME_VERSION = 1
const FRAME_KIND_RECOGNIZE = 1
const FRAME_FIXED_BYTES = 16
const FRAME_HEADER_LIMIT = 8 * 1024
const FRAME_BODY_LIMIT = 64 * 1024 * 1024
const IMAGE_TRANSFER_FRAME = 'stdin-frame-v1'
const IMAGE_FRAME = Object.freeze({
  magic: 'HLOC',
  version: FRAME_VERSION,
  kind: FRAME_KIND_RECOGNIZE,
  fixedBytes: FRAME_FIXED_BYTES,
  headerLimit: FRAME_HEADER_LIMIT,
  bodyLimit: FRAME_BODY_LIMIT,
  imageTransfer: IMAGE_TRANSFER_FRAME
})

// Serializes one request header and its exact image bytes into a single Buffer.
// Writing it as one unit is what keeps concurrent recognitions from interleaving
// a header into the middle of another request's body.
function encodeImageFrame(payload, imageBuffer) {
  if (!Buffer.isBuffer(imageBuffer)) throw new TypeError('OCR image frame body must be a Buffer')
  if (imageBuffer.length === 0) throw new Error('OCR image frame body is empty')
  if (imageBuffer.length > FRAME_BODY_LIMIT) throw new Error(`OCR image frame body exceeds ${FRAME_BODY_LIMIT} bytes`)
  const header = Buffer.from(JSON.stringify(payload), 'utf8')
  if (header.length === 0 || header.length > FRAME_HEADER_LIMIT) {
    throw new Error(`OCR image frame header exceeds ${FRAME_HEADER_LIMIT} bytes`)
  }
  const frame = Buffer.allocUnsafe(FRAME_FIXED_BYTES + header.length + imageBuffer.length)
  FRAME_MAGIC.copy(frame, 0)
  frame.writeUInt8(FRAME_VERSION, 4)
  frame.writeUInt8(FRAME_KIND_RECOGNIZE, 5)
  frame.writeUInt16LE(0, 6)
  frame.writeUInt32LE(header.length, 8)
  frame.writeUInt32LE(imageBuffer.length, 12)
  header.copy(frame, FRAME_FIXED_BYTES)
  imageBuffer.copy(frame, FRAME_FIXED_BYTES + header.length)
  return frame
}

class OcrService {
  constructor(options = {}) {
    if (!options.tempDir) throw new Error('OCR 临时目录不能为空')
    this.sidecarPath = options.sidecarPath
    this.modelDir = options.modelDir
    this.log = options.log || (() => {})
    this.process = null
    this.startPromise = null
    this.ready = false
    this.stdoutBuffer = ''
    this.stdoutDecoder = new StringDecoder('utf8')
    this.pending = new Map()
    this.inFlight = new Map()
    this.resultCache = new Map()
    this.cacheLimit = 12
    this.stopping = false
    this.tempDir = path.resolve(options.tempDir)
    this.idleTimeoutMs = Number.isFinite(Number(options.idleTimeoutMs)) ? Number(options.idleTimeoutMs) : 30000
    this.idleTimer = null
    this.validatedModelHashes = new Map()
    // Negotiated in the ready handshake; null means the sidecar only understands
    // the legacy imagePath line protocol.
    this.imageTransfer = null
    this.frameBodyLimit = FRAME_BODY_LIMIT
    this.frameWriteChain = Promise.resolve()
  }

  getStatus() {
    const missingFiles = MODEL_FILES.filter((name) => !fs.existsSync(path.join(this.modelDir, name)))
    const runtimePath = path.join(path.dirname(this.sidecarPath), 'onnxruntime.dll')
    if (!fs.existsSync(runtimePath)) missingFiles.push('onnxruntime.dll')
    return {
      ready: this.ready,
      available: fs.existsSync(this.sidecarPath) && missingFiles.length === 0,
      sidecarPath: this.sidecarPath,
      modelDir: this.modelDir,
      missingFiles
    }
  }

  validateFiles() {
    if (!fs.existsSync(this.sidecarPath)) {
      throw new Error(`OCR 组件不存在：${this.sidecarPath}`)
    }
    const missing = MODEL_FILES.filter((name) => !fs.existsSync(path.join(this.modelDir, name)))
    if (missing.length) throw new Error(`OCR 模型不完整：${missing.join('、')}`)
    const runtimePath = path.join(path.dirname(this.sidecarPath), 'onnxruntime.dll')
    if (!fs.existsSync(runtimePath)) throw new Error(`ONNX Runtime 不存在：${runtimePath}`)
    const manifestPath = path.join(this.modelDir, 'model.json')
    if (!fs.existsSync(manifestPath)) throw new Error('OCR 模型清单不存在')
    let manifest
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    } catch (error) {
      throw new Error(`OCR 模型清单无效：${error.message}`)
    }
    for (const item of Object.values(manifest.files || {})) {
      const filePath = path.join(this.modelDir, item.name || '')
      const stat = fs.statSync(filePath)
      if (Number(item.size) && stat.size !== Number(item.size)) throw new Error(`OCR 模型大小异常：${item.name}`)
      if (item.sha256) {
        // Hashing all ~16 MB of models on every sidecar start blocks the main
        // process; the sidecar is idle-stopped after 30s, so this repeated for
        // every capture burst. Existence and size checks above still run every
        // time — only the expensive digest is memoized against file identity.
        const key = `${filePath}\u0000${stat.size}\u0000${stat.mtimeMs}\u0000${stat.ino ?? ''}`
        const expected = String(item.sha256).toLowerCase()
        if (this.validatedModelHashes.get(key) === expected) continue
        const actual = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
        if (actual !== expected) throw new Error(`OCR 模型校验失败：${item.name}`)
        this.validatedModelHashes.set(key, expected)
      }
    }
  }

  // "Busy" means a started sidecar must not be reclaimed: a request is either
  // queued (pending) or being produced (inFlight). The idle timer and the
  // settings effects share this predicate so a shutdown can never race a
  // recognition that is already in progress.
  isBusy() {
    return this.pending.size > 0 || this.inFlight.size > 0
  }

  setIdleTimeoutMs(value) {
    const next = Number(value)
    if (!Number.isFinite(next) || next < 0) return this.idleTimeoutMs
    this.idleTimeoutMs = next
    if (this.idleTimer) this.scheduleIdleStop()
    return this.idleTimeoutMs
  }

  // Deferred by one macrotask on purpose: recognizeUncached() calls
  // ensureStarted() before it registers inFlight, so arming the timer
  // synchronously here would let a very short idle timeout stop the sidecar
  // between the await and the first request. By the time this runs the caller
  // has registered its work (or has finished and scheduled its own timer).
  armIdleStopIfIdle() {
    const arm = () => {
      if (this.stopping || this.isBusy()) return
      if (!this.process || this.process.killed || !this.ready) return
      this.scheduleIdleStop()
    }
    const immediate = setImmediate(arm)
    if (immediate && typeof immediate.unref === 'function') immediate.unref()
  }

  async ensureStarted() {
    this.clearIdleTimer()
    if (this.process && !this.process.killed && this.ready) {
      this.armIdleStopIfIdle()
      return
    }
    if (this.startPromise) return this.startPromise
    this.startPromise = this.start()
    try {
      await this.startPromise
    } finally {
      this.startPromise = null
    }
    // A hot start that never recognizes is exactly the leak this timer closes:
    // the previous implementation only armed the timer from recognize().
    this.armIdleStopIfIdle()
  }

  // Spawning is its own method so tests can substitute a protocol-faithful fake
  // sidecar without touching the handshake, buffering or lifecycle logic.
  spawnSidecar() {
    return spawn(this.sidecarPath, ['--model-dir', this.modelDir], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
  }

  // Reads the optional DEV-06 capability out of the existing ready line. Older
  // sidecars have no `protocol` member and keep the legacy path.
  handleReadyMessage(message) {
    const protocol = message && typeof message.protocol === 'object' && message.protocol ? message.protocol : null
    this.imageTransfer = protocol && protocol.imageTransfer === IMAGE_TRANSFER_FRAME ? IMAGE_TRANSFER_FRAME : null
    const advertised = Number(protocol && protocol.maxFrameBodyBytes)
    this.frameBodyLimit = Number.isFinite(advertised) && advertised > 0
      ? Math.min(FRAME_BODY_LIMIT, Math.floor(advertised))
      : FRAME_BODY_LIMIT
  }

  start() {
    const validationStarted = Date.now()
    this.validateFiles()
    const validationMs = Date.now() - validationStarted
    if (validationMs >= 5) this.log('OCR model validation', `${validationMs}ms`)
    this.stopping = false
    this.ready = false
    this.imageTransfer = null
    this.frameBodyLimit = FRAME_BODY_LIMIT
    this.frameWriteChain = Promise.resolve()
    this.stdoutBuffer = ''
    // A fresh stream needs a fresh decoder: bytes still buffered from the
    // previous sidecar must never leak into the new one's first line.
    this.stdoutDecoder = new StringDecoder('utf8')
    return new Promise((resolve, reject) => {
      const child = this.spawnSidecar()
      this.process = child
      let settled = false
      const startupTimer = setTimeout(() => {
        if (settled) return
        settled = true
        child.kill()
        reject(new Error('OCR 引擎启动超时'))
      }, 60000)

      const failStart = (error) => {
        if (settled) return
        settled = true
        clearTimeout(startupTimer)
        reject(error)
      }

      child.stdout.on('data', (chunk) => {
        this.handleStdout(chunk, (message) => {
          if (message.type !== 'ready' || settled) return
          settled = true
          clearTimeout(startupTimer)
          this.handleReadyMessage(message)
          this.ready = true
          this.log('OCR ready', message.model, `${message.initDurationMs || 0}ms`, this.imageTransfer || 'json-lines')
          resolve()
        })
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk) => {
        const message = chunk.trim()
        if (message) this.log('OCR sidecar:', message)
      })
      child.on('error', (error) => {
        failStart(new Error(`无法启动 OCR 引擎：${error.message}`))
        this.handleExit(child, error)
      })
      child.on('exit', (code) => {
        const error = new Error(this.stopping ? 'OCR 引擎已停止' : `OCR 引擎异常退出（${code ?? 'unknown'}）`)
        failStart(error)
        this.handleExit(child, error)
      })
    })
  }

  handleStdout(chunk, onMessage) {
    // Pipe chunks arrive as raw Buffers and a 3-byte UTF-8 Chinese character
    // can straddle the boundary between two of them. Decoding each chunk on its
    // own (chunk.toString('utf8')) emits U+FFFD for both halves, which still
    // parses as JSON and silently corrupts OCR text. One StringDecoder per
    // stream keeps the unfinished bytes until the next chunk completes them.
    // String chunks (when an encoding is already set upstream) pass through.
    this.stdoutBuffer += typeof chunk === 'string' ? chunk : this.stdoutDecoder.write(chunk)
    let newline = this.stdoutBuffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim()
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1)
      if (line) {
        try {
          const message = JSON.parse(line)
          onMessage(message)
          if (message.id) {
            const pending = this.pending.get(message.id)
            if (pending) {
              this.pending.delete(message.id)
              clearTimeout(pending.timer)
              if (message.ok) pending.resolve(message.result)
              else pending.reject(new Error(message.error || 'OCR 识别失败'))
            }
          } else if (message.type === 'fatal') {
            this.log('OCR fatal:', message.error)
          }
        } catch (error) {
          this.log('Invalid OCR response:', error.message)
        }
      }
      newline = this.stdoutBuffer.indexOf('\n')
    }
  }

  handleExit(child, error) {
    if (this.process !== child) return
    this.process = null
    this.ready = false
    this.imageTransfer = null
    this.frameBodyLimit = FRAME_BODY_LIMIT
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  clearIdleTimer() {
    if (!this.idleTimer) return
    clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  scheduleIdleStop() {
    this.clearIdleTimer()
    if (this.stopping) return
    if (this.idleTimeoutMs <= 0) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      // Re-arm instead of dropping the timer: work that started after the last
      // arming keeps the sidecar alive, and its own recognize() finally will arm
      // again. Without the re-arm a busy period would leave the sidecar warm
      // forever, which is the original leak in a different shape.
      if (this.isBusy()) {
        this.scheduleIdleStop()
        return
      }
      this.stop()
    }, this.idleTimeoutMs)
    this.idleTimer.unref?.()
  }

  // Settings turn the hot-start preference off: only stop a service that is
  // idle. An active recognition owns the sidecar until it settles.
  stopIfIdle() {
    if (this.isBusy()) return false
    this.stop()
    return true
  }

  request(payload, timeoutMs = 120000) {
    if (!this.process || this.process.killed || !this.ready) {
      return Promise.reject(new Error('OCR 引擎尚未就绪'))
    }
    const id = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('OCR 识别超时'))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.process.stdin.write(`${JSON.stringify({ id, ...payload })}\n`, (error) => {
        if (!error) return
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      })
    })
  }

  // Writes one frame and resolves when its bytes are flushed. The write callback
  // reports a broken pipe; the caller discards the process in that case because
  // a partially written frame leaves the stdin position unknown.
  writeFrame(child, frame) {
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (error) => {
        if (settled) return
        settled = true
        child.stdin.removeListener('error', onError)
        if (error) reject(error)
        else resolve()
      }
      const onError = (error) => finish(error)
      child.stdin.on('error', onError)
      try {
        child.stdin.write(frame, (error) => finish(error || null))
      } catch (error) {
        finish(error)
      }
    })
  }

  // Frames are written strictly one after another so a concurrent recognition
  // can never splice its header into another request's body. A failed write does
  // not poison the chain for the next process: start() replaces it on spawn.
  queueFrame(child, frame) {
    const write = this.frameWriteChain.then(() => this.writeFrame(child, frame))
    this.frameWriteChain = write.catch(() => {})
    return write
  }

  // The stdin stream is desynchronised after a write failure, so this sidecar
  // cannot serve another request. Drop it together with every pending request;
  // ensureStarted() performs a fresh handshake on the next recognition.
  discardProcess(child, error) {
    if (this.process !== child) return
    try { child.kill() } catch {}
    this.process = null
    this.ready = false
    this.imageTransfer = null
    this.frameBodyLimit = FRAME_BODY_LIMIT
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  requestFrame(payload, imageBuffer, timeoutMs = 120000) {
    const child = this.process
    if (!child || child.killed || !this.ready) {
      return Promise.reject(new Error('OCR sidecar is not ready'))
    }
    if (this.imageTransfer !== IMAGE_TRANSFER_FRAME) {
      return Promise.reject(new Error('OCR sidecar does not accept binary image frames'))
    }
    if (imageBuffer.length > this.frameBodyLimit) {
      return Promise.reject(new Error(`OCR image exceeds the advertised frame limit of ${this.frameBodyLimit} bytes`))
    }
    const id = crypto.randomUUID()
    let frame
    try {
      frame = encodeImageFrame({ id, ...payload }, imageBuffer)
    } catch (error) {
      return Promise.reject(error)
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('OCR recognition timed out'))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.queueFrame(child, frame).catch((error) => {
        if (!this.pending.has(id)) return
        this.pending.delete(id)
        clearTimeout(timer)
        reject(error)
        this.discardProcess(child, error)
      })
    })
  }

  async recognize(imageBuffer, options = {}) {
    const requestOptions = {
      scaleFactor: Number(options.scaleFactor) || 1,
      detectAngle: !!options.detectAngle,
      maxSide: Number(options.maxSide) || 2048,
      minConfidence: Number.isFinite(Number(options.minConfidence)) ? Number(options.minConfidence) : 0.3
    }
    const cacheKey = crypto.createHash('sha256')
      .update(imageBuffer)
      .update(JSON.stringify(requestOptions))
      .digest('hex')
    const cached = this.resultCache.get(cacheKey)
    if (cached) {
      this.resultCache.delete(cacheKey)
      this.resultCache.set(cacheKey, cached)
      this.scheduleIdleStop()
      return { ...cached, cached: true, durationMs: 0 }
    }
    if (this.inFlight.has(cacheKey)) return this.inFlight.get(cacheKey)

    const task = this.recognizeUncached(imageBuffer, requestOptions).then((result) => {
      this.resultCache.set(cacheKey, result)
      while (this.resultCache.size > this.cacheLimit) {
        this.resultCache.delete(this.resultCache.keys().next().value)
      }
      return result
    }).finally(() => {
      this.inFlight.delete(cacheKey)
      this.scheduleIdleStop()
    })
    this.inFlight.set(cacheKey, task)
    return task
  }

  async recognizeUncached(imageBuffer, options) {
    await this.ensureStarted()
    if (this.imageTransfer === IMAGE_TRANSFER_FRAME) {
      // DEV-06: the image travels inside the stdin frame; no temp PNG is written.
      return this.requestFrame({ action: 'recognize', ...options }, imageBuffer)
    }
    // Legacy sidecar (no negotiated capability): keep the temp-file protocol and
    // its cleanup contract for both success and failure.
    await fs.promises.mkdir(this.tempDir, { recursive: true })
    const imagePath = path.join(this.tempDir, `${crypto.randomUUID()}.png`)
    await fs.promises.writeFile(imagePath, imageBuffer)
    try {
      return await this.request({
        action: 'recognize',
        imagePath,
        ...options
      })
    } finally {
      await fs.promises.unlink(imagePath).catch(() => {})
    }
  }

  stop() {
    this.clearIdleTimer()
    this.stopping = true
    // Reject in-flight requests immediately instead of leaving them to the
    // per-request 120 s timeout: migration and quit paths await these promises,
    // and the old behaviour let a stop() (process=null) hide the exit event
    // behind the handleExit guard, freezing the caller for two minutes.
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      const error = new Error('OCR 引擎已停止')
      error.code = 'OCR_STOPPED'
      pending.reject(error)
    }
    this.pending.clear()
    if (this.process && !this.process.killed) {
      try { this.process.stdin.write(`${JSON.stringify({ action: 'shutdown' })}\n`) } catch {}
      const child = this.process
      setTimeout(() => { if (!child.killed) child.kill() }, 1000).unref()
    }
    this.process = null
    this.ready = false
  }
}

module.exports = { OcrService, MODEL_FILES, encodeImageFrame, IMAGE_FRAME }
