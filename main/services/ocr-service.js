const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const MODEL_FILES = [
  'ch_PP-OCRv4_det_mobile.onnx',
  'ch_ppocr_mobile_v2.0_cls_mobile.onnx',
  'ch_PP-OCRv4_rec_mobile.onnx'
]

class OcrService {
  constructor(options) {
    this.sidecarPath = options.sidecarPath
    this.modelDir = options.modelDir
    this.log = options.log || (() => {})
    this.process = null
    this.startPromise = null
    this.ready = false
    this.stdoutBuffer = ''
    this.pending = new Map()
    this.inFlight = new Map()
    this.resultCache = new Map()
    this.cacheLimit = 12
    this.stopping = false
    this.tempDir = path.join(os.tmpdir(), 'Highlighter', 'ocr')
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
        const actual = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
        if (actual !== String(item.sha256).toLowerCase()) throw new Error(`OCR 模型校验失败：${item.name}`)
      }
    }
  }

  async ensureStarted() {
    if (this.process && !this.process.killed && this.ready) return
    if (this.startPromise) return this.startPromise
    this.startPromise = this.start()
    try {
      await this.startPromise
    } finally {
      this.startPromise = null
    }
  }

  start() {
    this.validateFiles()
    this.stopping = false
    this.ready = false
    this.stdoutBuffer = ''
    return new Promise((resolve, reject) => {
      const child = spawn(this.sidecarPath, ['--model-dir', this.modelDir], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      })
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
          this.ready = true
          this.log('OCR ready', message.model, `${message.initDurationMs || 0}ms`)
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
        this.handleExit(error)
      })
      child.on('exit', (code) => {
        const error = new Error(this.stopping ? 'OCR 引擎已停止' : `OCR 引擎异常退出（${code ?? 'unknown'}）`)
        failStart(error)
        this.handleExit(error)
      })
    })
  }

  handleStdout(chunk, onMessage) {
    this.stdoutBuffer += chunk.toString('utf8')
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

  handleExit(error) {
    this.process = null
    this.ready = false
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
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

  async recognize(imageBuffer, options = {}) {
    const requestOptions = {
      scaleFactor: Number(options.scaleFactor) || 1,
      detectAngle: !!options.detectAngle,
      maxSide: Number(options.maxSide) || 4096,
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
      return { ...cached, cached: true, durationMs: 0 }
    }
    if (this.inFlight.has(cacheKey)) return this.inFlight.get(cacheKey)

    const task = this.recognizeUncached(imageBuffer, requestOptions).then((result) => {
      this.resultCache.set(cacheKey, result)
      while (this.resultCache.size > this.cacheLimit) {
        this.resultCache.delete(this.resultCache.keys().next().value)
      }
      return result
    }).finally(() => this.inFlight.delete(cacheKey))
    this.inFlight.set(cacheKey, task)
    return task
  }

  async recognizeUncached(imageBuffer, options) {
    await this.ensureStarted()
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
      fs.promises.unlink(imagePath).catch(() => {})
    }
  }

  stop() {
    this.stopping = true
    if (this.process && !this.process.killed) {
      try { this.process.stdin.write(`${JSON.stringify({ action: 'shutdown' })}\n`) } catch {}
      const child = this.process
      setTimeout(() => { if (!child.killed) child.kill() }, 1000).unref()
    }
    this.process = null
    this.ready = false
  }
}

module.exports = { OcrService, MODEL_FILES }
