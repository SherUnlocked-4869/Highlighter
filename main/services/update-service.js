const DEFAULT_STARTUP_DELAY_MS = 30 * 1000
const DEFAULT_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
const MAX_RELEASE_NOTES_LENGTH = 8000

function normalizeChannel(value) {
  return value === 'beta' ? 'beta' : 'stable'
}

function sanitizeUpdateText(value, maxLength = 500) {
  return String(value || '')
    .replace(/https?:\/\/[^\s<>'"]+/gi, (match) => {
      try {
        const url = new URL(match)
        url.search = ''
        url.hash = ''
        return url.toString()
      } catch {
        return '[REDACTED_URL]'
      }
    })
    .replace(/\b(Bearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/\b(token|access_token|authorization|password|secret|signature)=([^\s&,;]+)/gi, '$1=[REDACTED]')
    .slice(0, maxLength)
}

function sanitizeLogArgument(value) {
  if (value instanceof Error) return sanitizeUpdateText(value.message)
  if (value && typeof value === 'object') {
    try { return sanitizeUpdateText(JSON.stringify(value)) } catch {}
  }
  return sanitizeUpdateText(value)
}

function createSanitizedUpdaterLogger(log) {
  const write = (level, values) => log(`Updater ${level}:`, values.map(sanitizeLogArgument).join(' '))
  return {
    debug: (...values) => write('debug', values),
    info: (...values) => write('info', values),
    warn: (...values) => write('warn', values),
    error: (...values) => write('error', values)
  }
}

function normalizeReleaseNotes(value) {
  const notes = Array.isArray(value)
    ? value.map((entry) => {
        if (typeof entry === 'string') return entry
        const version = entry?.version ? `${entry.version}: ` : ''
        return `${version}${entry?.note || ''}`
      }).join('\n\n')
    : value
  return sanitizeUpdateText(notes, MAX_RELEASE_NOTES_LENGTH)
}

function normalizeUpdateInfo(info = {}) {
  const sizes = Array.isArray(info.files)
    ? info.files.map((file) => Number(file?.size) || 0)
    : []
  return {
    version: String(info.version || ''),
    releaseDate: String(info.releaseDate || ''),
    releaseNotes: normalizeReleaseNotes(info.releaseNotes),
    size: sizes.length ? Math.max(...sizes) : 0
  }
}

function normalizeUpdateError(error) {
  const raw = `${error?.code || ''} ${error?.message || error || ''}`
  const matchers = [
    {
      pattern: /signature|not signed|code signing|certificate|publisher|checksum|sha(?:256|512)?|integrity/i,
      code: 'signature-invalid',
      message: '更新包签名或完整性校验失败。',
      action: '请从项目发布页下载安装包，并确认发布者为 Highlighter。'
    },
    {
      pattern: /ENOSPC|not enough space|disk full|insufficient disk/i,
      code: 'disk-full',
      message: '磁盘空间不足，无法保存更新包。',
      action: '请释放系统盘空间后重试。'
    },
    {
      pattern: /ETIMEDOUT|ESOCKETTIMEDOUT|timeout|timed out/i,
      code: 'network-timeout',
      message: '检查或下载更新超时。',
      action: '请检查网络连接后重试，或从项目发布页手动下载。'
    },
    {
      pattern: /ENOTFOUND|ECONNRESET|ECONNREFUSED|EAI_AGAIN|network|http status/i,
      code: 'network-error',
      message: '无法连接更新服务。',
      action: '请检查网络连接后重试，或从项目发布页手动下载。'
    },
    {
      pattern: /download/i,
      code: 'download-failed',
      message: '更新包下载失败。',
      action: '请重新下载；若问题持续，请从项目发布页手动下载。'
    }
  ]
  const matched = matchers.find(({ pattern }) => pattern.test(raw))
  return matched
    ? { code: matched.code, message: matched.message, action: matched.action }
    : {
        code: 'update-failed',
        message: '更新操作失败。',
        action: '请稍后重试；若问题持续，请从项目发布页手动下载。'
      }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

class UpdateService {
  constructor({
    updater = null,
    currentVersion,
    installType,
    channel = 'stable',
    openDownloadPage = async () => {},
    canInstall = async () => ({ ok: true }),
    prepareInstall = async () => {},
    notify = () => {},
    log = () => {},
    now = () => Date.now(),
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    startupDelayMs = DEFAULT_STARTUP_DELAY_MS,
    checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS
  }) {
    if (!currentVersion || !installType) throw new TypeError('UpdateService requires version and install type')
    this.updater = updater
    this.openDownloadPageHandler = openDownloadPage
    this.canInstall = canInstall
    this.prepareInstall = prepareInstall
    this.notify = notify
    this.log = log
    this.now = now
    this.setTimeoutFn = setTimeoutFn
    this.clearTimeoutFn = clearTimeoutFn
    this.startupDelayMs = startupDelayMs
    this.checkIntervalMs = checkIntervalMs
    this.channel = normalizeChannel(channel)
    this.timer = null
    this.started = false
    this.disposed = false
    this.checkPromise = null
    this.downloadPromise = null
    this.installPromise = null
    this.listeners = []
    this.state = {
      status: 'idle',
      currentVersion: String(currentVersion),
      installType: String(installType),
      portable: installType === 'portable',
      channel: this.channel,
      version: '',
      releaseDate: '',
      releaseNotes: '',
      size: 0,
      progress: null,
      error: null,
      installBlocked: '',
      lastCheckedAt: ''
    }
    if (this.updater) {
      this.configureUpdater()
      this.bindUpdaterEvents()
    }
  }

  getStatus() {
    return clone(this.state)
  }

  setChannel(value) {
    this.channel = normalizeChannel(value)
    this.state.channel = this.channel
    if (this.updater && !['checking', 'downloading', 'installing'].includes(this.state.status)) this.configureUpdater()
    this.emitStatus()
    return this.getStatus()
  }

  configureUpdater() {
    if (!this.updater) return
    this.updater.logger = createSanitizedUpdaterLogger(this.log)
    this.updater.autoDownload = false
    this.updater.autoInstallOnAppQuit = false
    this.updater.channel = this.channel === 'beta' ? 'beta' : 'latest'
    this.updater.allowPrerelease = this.channel === 'beta'
    // Setting channel or allowPrerelease may enable downgrade in electron-updater.
    this.updater.allowDowngrade = false
  }

  bindUpdaterEvents() {
    const on = (name, listener) => {
      this.updater.on(name, listener)
      this.listeners.push([name, listener])
    }
    on('checking-for-update', () => {
      if (this.state.status !== 'checking') this.setState({ status: 'checking', error: null, installBlocked: '' })
    })
    on('update-available', (info) => {
      if (this.state.status !== 'checking') return
      this.setState({ status: 'available', ...normalizeUpdateInfo(info), progress: null, error: null, installBlocked: '' })
    })
    on('update-not-available', () => {
      if (this.state.status !== 'checking') return
      this.setState({
        status: 'idle',
        version: '',
        releaseDate: '',
        releaseNotes: '',
        size: 0,
        progress: null,
        error: null,
        installBlocked: ''
      })
    })
    on('download-progress', (progress = {}) => {
      if (this.state.status !== 'downloading') return
      this.setState({
        progress: {
          percent: Math.max(0, Math.min(100, Number(progress.percent) || 0)),
          transferred: Math.max(0, Number(progress.transferred) || 0),
          total: Math.max(0, Number(progress.total) || 0),
          bytesPerSecond: Math.max(0, Number(progress.bytesPerSecond) || 0)
        }
      }, { logState: false })
    })
    on('update-downloaded', (info) => {
      if (!['downloading', 'available'].includes(this.state.status)) return
      this.setState({
        status: 'downloaded',
        ...normalizeUpdateInfo(info),
        progress: this.state.progress ? { ...this.state.progress, percent: 100 } : { percent: 100, transferred: 0, total: 0, bytesPerSecond: 0 },
        error: null,
        installBlocked: ''
      })
    })
    on('update-cancelled', () => {
      if (this.state.status !== 'downloading') return
      this.setState({ status: 'available', progress: null, installBlocked: '下载已取消。' })
    })
    on('error', (error) => this.fail(error))
  }

  setState(patch, { logState = true } = {}) {
    const previousStatus = this.state.status
    this.state = { ...this.state, ...patch, channel: this.channel }
    if (logState && previousStatus !== this.state.status) {
      this.log('Update state:', {
        status: this.state.status,
        channel: this.state.channel,
        version: this.state.version,
        errorCode: this.state.error?.code || ''
      })
    }
    this.emitStatus()
    return this.getStatus()
  }

  emitStatus() {
    try { this.notify(this.getStatus()) } catch (error) {
      this.log('Update status notification failed:', sanitizeUpdateText(error?.message || error))
    }
  }

  fail(error) {
    const normalized = normalizeUpdateError(error)
    this.log('Update operation failed:', {
      code: normalized.code,
      detail: sanitizeUpdateText(error?.message || error)
    })
    return this.setState({ status: 'error', error: normalized, installBlocked: '', progress: null })
  }

  async check({ manual = false } = {}) {
    if (this.state.portable) {
      if (manual) return this.openDownloadPage()
      return this.getStatus()
    }
    if (this.state.installType !== 'nsis' || !this.updater) {
      return this.setState({
        status: 'error',
        error: {
          code: 'unsupported-install-type',
          message: '当前运行方式不支持应用内更新。',
          action: '请安装正式安装版，或从项目发布页手动下载。'
        }
      })
    }
    if (this.checkPromise) return this.checkPromise
    if (['downloading', 'downloaded', 'installing'].includes(this.state.status)) return this.getStatus()
    const now = Number(this.now())
    const lastChecked = Date.parse(this.state.lastCheckedAt)
    if (!manual && Number.isFinite(lastChecked) && now - lastChecked < this.checkIntervalMs) return this.getStatus()

    this.checkPromise = (async () => {
      try {
        this.configureUpdater()
        this.setState({
          status: 'checking',
          error: null,
          installBlocked: '',
          lastCheckedAt: new Date(now).toISOString()
        })
        await this.updater.checkForUpdates()
        return this.getStatus()
      } catch (error) {
        return this.fail(error)
      }
    })().finally(() => { this.checkPromise = null })
    return this.checkPromise
  }

  async download() {
    if (this.state.portable) return this.openDownloadPage()
    if (this.downloadPromise) return this.downloadPromise
    if (this.state.status !== 'available') return this.getStatus()
    this.downloadPromise = (async () => {
      try {
        this.setState({ status: 'downloading', progress: { percent: 0, transferred: 0, total: this.state.size, bytesPerSecond: 0 }, error: null, installBlocked: '' })
        await this.updater.downloadUpdate()
        return this.getStatus()
      } catch (error) {
        return this.fail(error)
      }
    })().finally(() => { this.downloadPromise = null })
    return this.downloadPromise
  }

  async install() {
    if (this.state.portable) return this.openDownloadPage()
    if (this.installPromise) return this.installPromise
    if (this.state.status !== 'downloaded') return this.getStatus()
    this.installPromise = (async () => {
      try {
        const gate = await this.canInstall()
        if (!gate?.ok) {
          const reason = sanitizeUpdateText(gate?.reason || '当前有任务正在运行，请结束后重试。')
          return this.setState({ status: 'downloaded', installBlocked: reason, error: null })
        }
        this.setState({ status: 'installing', installBlocked: '', error: null })
        await this.prepareInstall()
        this.updater.quitAndInstall(false, true)
        return this.getStatus()
      } catch (error) {
        return this.fail(error)
      }
    })().finally(() => { this.installPromise = null })
    return this.installPromise
  }

  async openDownloadPage() {
    try {
      await this.openDownloadPageHandler(this.channel)
      return this.getStatus()
    } catch (error) {
      return this.fail(error)
    }
  }

  start() {
    if (this.started || this.disposed || this.state.installType !== 'nsis' || !this.updater) return false
    this.started = true
    this.schedule(this.startupDelayMs)
    return true
  }

  schedule(delay) {
    if (this.disposed) return
    if (this.timer) this.clearTimeoutFn(this.timer)
    this.timer = this.setTimeoutFn(async () => {
      this.timer = null
      await this.check({ manual: false })
      if (!this.disposed) this.schedule(this.checkIntervalMs)
    }, delay)
  }

  dispose() {
    this.disposed = true
    if (this.timer) this.clearTimeoutFn(this.timer)
    this.timer = null
    if (this.updater?.removeListener) {
      for (const [name, listener] of this.listeners) this.updater.removeListener(name, listener)
    }
    this.listeners = []
  }
}

module.exports = {
  DEFAULT_CHECK_INTERVAL_MS,
  DEFAULT_STARTUP_DELAY_MS,
  UpdateService,
  createSanitizedUpdaterLogger,
  normalizeChannel,
  normalizeUpdateError,
  normalizeUpdateInfo,
  sanitizeUpdateText
}
