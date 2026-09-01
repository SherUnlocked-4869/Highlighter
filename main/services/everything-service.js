const fs = require('fs')
const path = require('path')
const { execFile, spawn } = require('child_process')

const SIDECAR_START_TIMEOUT_MS = 15000
const READY_TIMEOUT_MS = 30000
const QUERY_TIMEOUT_MS = 8000
const STATUS_TIMEOUT_MS = 5000
const READY_CACHE_MS = 2000
const STATUS_REFRESH_MIN_INTERVAL_MS = 5000
const DEFAULT_CACHE_LIMIT = 24
const DEFAULT_IDLE_TIMEOUT_MS = 120000
const SORT_MODES = new Set([
  'modified-desc', 'modified-asc',
  'name-asc', 'name-desc',
  'path-asc', 'path-desc',
  'size-asc', 'size-desc'
])
const EVERYTHING_DOWNLOAD_URL = 'https://www.voidtools.com/zh-cn/downloads/'

function clampInteger(value, min, max, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

class EverythingService {
  constructor(options = {}) {
    this.sidecarPath = options.sidecarPath
    if (!this.sidecarPath) throw new Error('Everything 组件路径不能为空')
    this.bundledEverythingPath = options.bundledEverythingPath || ''
    this.runtimeEverythingDir = options.runtimeEverythingDir || ''
    this.log = options.log || (() => {})
    this.onStatusChange = typeof options.onStatusChange === 'function' ? options.onStatusChange : null
    this.getUseBundledEverything = options.getUseBundledEverything || (() => true)
    this.processProbe = options.processProbe || ((pid) => probeProcessImagePath(pid, this.log))
    this.runCommand = options.runCommand || ((file, args) => new Promise((resolve, reject) => {
      execFile(file, args, { windowsHide: true }, (error) => (error ? reject(error) : resolve()))
    }))
    this.spawn = options.spawn || spawn
    this.process = null
    this.startPromise = null
    this.ensureReadyPromise = null
    this.refreshPromise = null
    this.lastStatusProbeAt = 0
    this.ready = false
    this.stopping = false
    this.stdoutBuffer = ''
    this.pending = new Map()
    this.inFlight = new Map()
    this.resultCache = new Map()
    this.cacheLimit = DEFAULT_CACHE_LIMIT
    this.idleTimeoutMs = Number.isFinite(Number(options.idleTimeoutMs)) ? Number(options.idleTimeoutMs) : DEFAULT_IDLE_TIMEOUT_MS
    this.idleTimer = null
    this.managedEverything = null
    this.status = {
      phase: 'idle',
      message: '',
      running: false,
      dbLoaded: false,
      version: null,
      managedByHighlighter: false,
      available: fs.existsSync(this.sidecarPath)
    }
  }

  getStatus() {
    return { ...this.status, available: fs.existsSync(this.sidecarPath) }
  }

  // Passive status reads never probe, so surfaces like the settings page would
  // otherwise show a stale `running:false` until a search window opens. Probe
  // on demand here — lightweight status only, never spawning the bundled
  // Everything (that stays a search-window behavior).
  async refreshStatus() {
    if (this.refreshPromise) return this.refreshPromise
    const sidecarActive = !!(this.process && !this.process.killed && this.ready)
    const probedRecently = Date.now() - (this.lastStatusProbeAt || 0) < STATUS_REFRESH_MIN_INTERVAL_MS
    if (sidecarActive || probedRecently) return this.getStatus()
    this.refreshPromise = (async () => {
      try {
        await this.ensureStarted()
        const snapshot = await this.request({ action: 'status' }, STATUS_TIMEOUT_MS)
        this.lastStatusProbeAt = Date.now()
        const running = !!snapshot?.running
        const ready = running && !!snapshot?.dbLoaded
        this.applySidecarStatus(snapshot, {
          managedByHighlighter: !!this.managedEverything,
          phase: ready ? 'ready' : (running ? 'waiting' : 'idle'),
          message: ready ? 'Everything 已就绪' : (running ? 'Everything 正在运行，索引尚未就绪' : '')
        })
        this.scheduleIdleStop()
      } catch (error) {
        this.log('Everything status refresh failed:', error.message)
      }
      return this.getStatus()
    })().finally(() => {
      this.refreshPromise = null
    })
    return this.refreshPromise
  }

  setStatus(patch) {
    this.status = { ...this.status, ...patch, available: fs.existsSync(this.sidecarPath) }
    if (this.onStatusChange) {
      try { this.onStatusChange(this.getStatus()) } catch (error) {
        this.log('Everything status listener failed:', error.message)
      }
    }
    return this.status
  }

  clearIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  scheduleIdleStop() {
    this.clearIdleTimer()
    if (this.idleTimeoutMs <= 0) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.pending.size === 0 && this.inFlight.size === 0) this.stop()
    }, this.idleTimeoutMs)
    this.idleTimer.unref?.()
  }

  async ensureStarted() {
    this.clearIdleTimer()
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
    if (!fs.existsSync(this.sidecarPath)) {
      return Promise.reject(new Error(`Everything 组件不存在：${this.sidecarPath}`))
    }
    this.stopping = false
    this.ready = false
    this.stdoutBuffer = ''
    return new Promise((resolve, reject) => {
      const child = this.spawn(this.sidecarPath, [], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      })
      this.process = child
      let settled = false
      const startupTimer = setTimeout(() => {
        if (settled) return
        settled = true
        child.kill()
        reject(new Error('Everything 组件启动超时'))
      }, SIDECAR_START_TIMEOUT_MS)

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
          this.log('Everything sidecar ready')
          resolve()
        })
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk) => {
        const message = chunk.trim()
        if (message) this.log('Everything sidecar:', message)
      })
      child.on('error', (error) => {
        failStart(new Error(`无法启动 Everything 组件：${error.message}`))
        this.handleExit(child, error)
      })
      child.on('exit', (code) => {
        const error = new Error(this.stopping ? 'Everything 组件已停止' : `Everything 组件异常退出（${code ?? 'unknown'}）`)
        failStart(error)
        this.handleExit(child, error)
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
          if (message.id !== undefined && message.id !== null) {
            const pending = this.pending.get(message.id)
            if (pending) {
              this.pending.delete(message.id)
              clearTimeout(pending.timer)
              if (message.ok) pending.resolve(message.result)
              else {
                const error = new Error(message.error?.message || 'Everything 查询失败')
                error.code = message.error?.code || 'internal'
                pending.reject(error)
              }
            }
          }
        } catch (error) {
          this.log('Invalid Everything response:', error.message)
        }
      }
      newline = this.stdoutBuffer.indexOf('\n')
    }
  }

  handleExit(child, error) {
    if (this.process !== child) return
    this.process = null
    this.ready = false
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    this.clearIdleTimer()
  }

  request(payload, timeoutMs = QUERY_TIMEOUT_MS) {
    if (!this.process || this.process.killed || !this.ready) {
      return Promise.reject(new Error('Everything 组件尚未就绪'))
    }
    const id = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        const error = new Error('Everything 请求超时')
        error.code = 'timeout'
        reject(error)
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

  applySidecarStatus(status, patch = {}) {
    return this.setStatus({
      running: !!status?.running,
      dbLoaded: !!status?.dbLoaded,
      version: status?.version ?? null,
      ...patch
    })
  }

  async waitReady(timeoutMs = READY_TIMEOUT_MS) {
    const result = await this.request({ action: 'wait-ready', timeoutMs }, timeoutMs + 10000)
    this.applySidecarStatus(result?.status, { managedByHighlighter: !!this.managedEverything })
    return result?.ready === true
  }

  async spawnBundledEverything() {
    if (!this.bundledEverythingPath || !fs.existsSync(this.bundledEverythingPath)) {
      throw new Error('内置 Everything 不存在')
    }
    const targetDir = this.runtimeEverythingDir || path.dirname(this.bundledEverythingPath)
    fs.mkdirSync(targetDir, { recursive: true })
    const targetExe = path.join(targetDir, 'Everything.exe')
    const targetIni = path.join(targetDir, 'Everything.ini')
    const sourceDir = path.dirname(this.bundledEverythingPath)
    if (!fs.existsSync(targetExe)) fs.copyFileSync(this.bundledEverythingPath, targetExe)
    const sourceIni = path.join(sourceDir, 'Everything.ini')
    if (!fs.existsSync(targetIni) && fs.existsSync(sourceIni)) fs.copyFileSync(sourceIni, targetIni)
    const child = this.spawn(targetExe, ['-startup', '-config', targetIni], {
      cwd: targetDir,
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    })
    child.once('exit', () => {
      if (this.managedEverything?.pid === child.pid) this.managedEverything = null
    })
    child.unref()
    this.managedEverything = { pid: child.pid, exePath: targetExe }
    this.log('Started bundled Everything:', targetExe, 'pid', child.pid)
    this.setStatus({ managedByHighlighter: true })
    return child.pid
  }

  async ensureReady(options = {}) {
    if (this.ensureReadyPromise) return this.ensureReadyPromise
    this.ensureReadyPromise = this.ensureReadyInternal(options).finally(() => {
      this.ensureReadyPromise = null
    })
    return this.ensureReadyPromise
  }

  async ensureReadyInternal(options = {}) {
    const timeoutMs = clampInteger(options.timeoutMs, 3000, 120000, READY_TIMEOUT_MS)
    if (this.status.phase === 'ready' && Date.now() - (this.lastReadyAt || 0) < READY_CACHE_MS) {
      return this.getStatus()
    }
    await this.ensureStarted()
    this.setStatus({ phase: 'checking', message: '正在检测 Everything...' })
    const snapshot = await this.request({ action: 'status' }, STATUS_TIMEOUT_MS).catch((error) => {
      this.log('Everything status check failed:', error.message)
      return null
    })
    if (!snapshot) {
      this.setStatus({ phase: 'error', message: 'Everything 组件不可用' })
      throw new Error('Everything 组件不可用')
    }
    this.applySidecarStatus(snapshot, { managedByHighlighter: !!this.managedEverything })

    if (snapshot.running && !snapshot.dbLoaded && snapshot.ipcAvailable === false) {
      // The IPC window class matched but both probe channels stayed silent —
      // typically an integrity-level mismatch. Fail fast instead of waiting
      // 30s or shadowing the user's instance with the bundled copy.
      const message = '检测到 Everything，但无法与之通信（可能正在加载索引或权限不一致），请尝试以相同权限运行 Highlighter 与 Everything'
      this.setStatus({ phase: 'error', message })
      throw new Error(message)
    }

    if (snapshot.running && snapshot.dbLoaded) {
      this.lastReadyAt = Date.now()
      this.setStatus({ phase: 'ready', message: 'Everything 已就绪' })
      return this.getStatus()
    }

    if (snapshot.running) {
      this.setStatus({ phase: 'waiting', message: '检测到 Everything 正在运行，正在等待索引服务就绪...' })
    } else if (this.getUseBundledEverything()) {
      this.setStatus({ phase: 'starting', message: '未检测到 Everything，正在启动内置 Everything...' })
      await this.spawnBundledEverything()
    } else {
      const message = '未检测到 Everything，请安装并启动 Everything 后重试'
      this.setStatus({ phase: 'error', message, downloadUrl: EVERYTHING_DOWNLOAD_URL })
      throw new Error(message)
    }

    const ready = await this.waitReady(timeoutMs).catch((error) => {
      this.log('Everything wait-ready failed:', error.message)
      return false
    })
    if (ready) {
      this.lastReadyAt = Date.now()
      this.setStatus({ phase: 'ready', message: 'Everything 已就绪' })
      return this.getStatus()
    }
    const message = snapshot.running
      ? 'Everything 初始化超时，索引尚未就绪'
      : 'Everything 初始化超时，请确认 Everything 可正常启动（NTFS 索引需要管理员权限或 Everything 服务）'
    this.setStatus({ phase: 'error', message })
    throw new Error(message)
  }

  async query(params) {
    const normalized = {
      search: String(params?.search ?? ''),
      maxResults: clampInteger(params?.maxResults, 1, 2000, 600),
      sortMode: SORT_MODES.has(params?.sortMode) ? params.sortMode : 'modified-desc',
      matchPath: !!params?.matchPath
    }
    const cacheKey = JSON.stringify(normalized)
    const cached = this.resultCache.get(cacheKey)
    if (cached) {
      this.resultCache.delete(cacheKey)
      this.resultCache.set(cacheKey, cached)
      this.scheduleIdleStop()
      return { ...cached, cached: true }
    }
    const existing = this.inFlight.get(cacheKey)
    if (existing) return existing

    await this.ensureReady()
    // Another caller may have created the identical request while this one
    // waited for readiness — coalesce onto it instead of duplicating work.
    const coalesced = this.inFlight.get(cacheKey)
    if (coalesced) return coalesced
    const task = this.request({ action: 'query', ...normalized }, QUERY_TIMEOUT_MS).then((result) => {
      this.resultCache.set(cacheKey, result)
      while (this.resultCache.size > this.cacheLimit) {
        this.resultCache.delete(this.resultCache.keys().next().value)
      }
      return result
    }).catch((error) => {
      if (error.code === 'not-running' || error.code === 'send-failed') {
        // Everything may have exited after the readiness check; force a
        // re-check on the next query.
        this.lastReadyAt = 0
        this.setStatus({ phase: 'checking', message: '正在重新检测 Everything...' })
      }
      throw error
    }).finally(() => {
      this.inFlight.delete(cacheKey)
      this.scheduleIdleStop()
    })
    this.inFlight.set(cacheKey, task)
    return task
  }

  async stopManagedEverything() {
    const managed = this.managedEverything
    this.managedEverything = null
    if (!managed || !managed.pid) return false
    try {
      const imagePath = await this.processProbe(managed.pid)
      if (!imagePath || path.resolve(String(imagePath).toLowerCase()) !== path.resolve(managed.exePath.toLowerCase())) {
        this.log('Skip killing Everything: image path mismatch', imagePath)
        return false
      }
      await this.runCommand('taskkill', ['/PID', String(managed.pid), '/T', '/F'])
      this.log('Stopped bundled Everything pid', managed.pid)
      return true
    } catch (error) {
      this.log('Failed to stop bundled Everything:', error.message)
      return false
    }
  }

  stop() {
    this.clearIdleTimer()
    this.stopping = true
    if (this.process && !this.process.killed) {
      try { this.process.stdin.write(`${JSON.stringify({ id: 'shutdown', action: 'shutdown' })}\n`) } catch {}
      const child = this.process
      setTimeout(() => { if (!child.killed) child.kill() }, 1000).unref()
    }
    this.process = null
    this.ready = false
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Everything 组件已停止'))
    }
    this.pending.clear()
    this.inFlight.clear()
    this.setStatus({ phase: 'idle', message: '', running: false, dbLoaded: false, managedByHighlighter: false })
    return this.stopManagedEverything()
  }
}

async function probeProcessImagePath(pid, log = () => {}) {
  const script = `(Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=${Number(pid)}").ExecutablePath`
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      timeout: 10000
    }, (error, stdout) => {
      if (error) {
        log('Process probe failed:', error.message)
        resolve('')
        return
      }
      resolve(String(stdout || '').trim())
    })
  })
}

module.exports = {
  EverythingService,
  SORT_MODES,
  EVERYTHING_DOWNLOAD_URL
}
