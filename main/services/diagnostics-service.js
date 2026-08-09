const crypto = require('node:crypto')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const AdmZip = require('adm-zip')
const { redactString } = require('./app-logger')

const SESSION_SCHEMA_VERSION = 1
const DIAGNOSTICS_SCHEMA_VERSION = 1
const MAX_PROCESS_EXITS = 50
const MAX_LOG_BYTES = 512 * 1024
const MAX_CRASH_DUMPS = 10
const SENSITIVE_DIAGNOSTIC_KEY = /(api[-_]?key|authorization|password|secret|token|prompt|messages|selected[-_]?text|content)/i

function readJsonSync(filePath, fallback, fileSystem = fs) {
  try {
    return JSON.parse(fileSystem.readFileSync(filePath, 'utf8'))
  } catch {
    return fallback
  }
}

function atomicWriteJsonSync(filePath, value, fileSystem = fs) {
  fileSystem.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`
  const backupPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.bak`
  let hasBackup = false
  try {
    fileSystem.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    try {
      fileSystem.renameSync(temporaryPath, filePath)
    } catch (error) {
      if (!['EEXIST', 'EPERM'].includes(error.code)) throw error
      fileSystem.renameSync(filePath, backupPath)
      hasBackup = true
      try {
        fileSystem.renameSync(temporaryPath, filePath)
      } catch (replacementError) {
        try { fileSystem.renameSync(backupPath, filePath) } catch {}
        throw replacementError
      }
      try {
        fileSystem.rmSync(backupPath, { force: true })
        hasBackup = false
      } catch {}
    }
  } finally {
    try { fileSystem.rmSync(temporaryPath, { force: true }) } catch {}
    if (!hasBackup) {
      try { fileSystem.rmSync(backupPath, { force: true }) } catch {}
    }
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function replaceLiteral(value, target, replacement, caseInsensitive = false) {
  if (!target) return value
  return value.replace(new RegExp(escapeRegExp(target), caseInsensitive ? 'gi' : 'g'), replacement)
}

function collectStrings(value, output = []) {
  if (typeof value === 'string') {
    if (value.length >= 4) output.push(value)
    return output
  }
  if (!value || typeof value !== 'object') return output
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, output)
    return output
  }
  for (const item of Object.values(value)) collectStrings(item, output)
  return output
}

function createSanitizer({ pathReplacements = [], sensitiveValues = [] } = {}) {
  const replacements = pathReplacements
    .filter(({ value }) => typeof value === 'string' && value)
    .sort((left, right) => right.value.length - left.value.length)
  const secrets = [...new Set(collectStrings(sensitiveValues))]
    .sort((left, right) => right.length - left.length)

  function sanitizeString(input) {
    let value = redactString(input)
    for (const secret of secrets) value = replaceLiteral(value, secret, '[REDACTED]')
    for (const { value: original, placeholder } of replacements) {
      value = replaceLiteral(value, original, placeholder, process.platform === 'win32')
    }
    value = value.replace(/\b[A-Za-z]:[\\/]Users[\\/][^\\/\s"'<>]+/gi, '%USERPROFILE%')
    value = value.replace(/\b[A-Za-z]:[\\/][^\r\n"'<>|]*/g, '%PATH%')
    value = value.replace(/\\\\[^\\/\s"'<>]+[\\/][^\r\n"'<>|]*/g, '%PATH%')
    value = value.replace(/([?&](?:api[-_]?key|authorization|password|secret|token|signature)=)[^&#\s]+/gi, '$1[REDACTED]')
    return value
  }

  function sanitize(value, seen = new WeakSet()) {
    if (typeof value === 'string') return sanitizeString(value)
    if (value instanceof Error) return sanitizeString(value.stack || value.message || String(value))
    if (!value || typeof value !== 'object') return value
    if (seen.has(value)) return '[Circular]'
    seen.add(value)
    if (Array.isArray(value)) return value.map((item) => sanitize(item, seen))
    const output = {}
    for (const [key, item] of Object.entries(value)) {
      output[key] = SENSITIVE_DIAGNOSTIC_KEY.test(key) ? '[REDACTED]' : sanitize(item, seen)
    }
    return output
  }

  return { sanitize, sanitizeString, secrets, replacements }
}

function sanitizeLogText(value, sanitizer) {
  return String(value).split(/\r?\n/).map((line) => {
    if (!line) return ''
    try {
      return JSON.stringify(sanitizer.sanitize(JSON.parse(line)))
    } catch {
      return sanitizer.sanitizeString(line)
    }
  }).join('\n')
}

async function hashFile(filePath) {
  const hash = crypto.createHash('sha256')
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', resolve)
  })
  return hash.digest('hex')
}

async function readFileTail(filePath, maxBytes = MAX_LOG_BYTES) {
  const stat = await fsp.stat(filePath)
  const length = Math.min(stat.size, maxBytes)
  const handle = await fsp.open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, stat.size - length)
    let text = buffer.toString('utf8')
    if (stat.size > length) {
      const firstLineEnd = text.indexOf('\n')
      text = firstLineEnd >= 0 ? text.slice(firstLineEnd + 1) : ''
    }
    return text
  } finally {
    await handle.close()
  }
}

async function listCrashDumps(directory, limit = MAX_CRASH_DUMPS) {
  const results = []
  async function visit(current) {
    if (results.length >= limit) return
    const entries = await fsp.readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (results.length >= limit || entry.isSymbolicLink()) continue
      const absolutePath = path.join(current, entry.name)
      if (entry.isDirectory()) await visit(absolutePath)
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.dmp')) results.push(absolutePath)
    }
  }
  await visit(directory)
  return results
}

class DiagnosticsService {
  constructor({
    sessionId,
    version,
    paths,
    screen,
    getAppInfo,
    getComponents = () => [],
    getSensitiveValues = () => [],
    getUpdateStatus = () => ({ status: 'not-configured', lastError: null }),
    now = () => new Date(),
    platform = process.platform,
    architecture = process.arch,
    versions = process.versions,
    system = os,
    log = () => {}
  }) {
    if (!sessionId || !version) throw new TypeError('Diagnostics require a session id and version')
    if (!paths?.runtime || !paths?.logs || !paths?.dataRoot || !paths?.crashDumps) {
      throw new TypeError('Diagnostics require managed runtime, log, data, and crash paths')
    }
    this.sessionId = sessionId
    this.version = version
    this.paths = paths
    this.screen = screen
    this.getAppInfo = getAppInfo
    this.getComponents = getComponents
    this.getSensitiveValues = getSensitiveValues
    this.getUpdateStatus = getUpdateStatus
    this.now = now
    this.platform = platform
    this.architecture = architecture
    this.versions = versions
    this.system = system
    this.log = log
    this.sessionPath = path.join(paths.runtime, 'session.json')
    this.processExitsPath = path.join(paths.runtime, 'process-exits.json')
    this.previousExit = null
    this.startedAt = ''
    this.cleanMarked = false
  }

  getSanitizer() {
    return createSanitizer({
      pathReplacements: [
        { value: this.paths.dataRoot, placeholder: '%DATA_ROOT%' },
        { value: this.paths.userProfile, placeholder: '%USERPROFILE%' },
        { value: this.paths.temp, placeholder: '%TEMP%' },
        { value: this.paths.resources, placeholder: '%RESOURCES%' },
        { value: this.paths.appRoot, placeholder: '%APP_ROOT%' }
      ],
      sensitiveValues: this.getSensitiveValues()
    })
  }

  startSession() {
    const previous = readJsonSync(this.sessionPath, null)
    if (previous?.sessionId === this.sessionId && previous.state === 'running') return this.getSessionSummary()
    if (previous?.sessionId) {
      const clean = previous.state === 'clean'
      this.previousExit = {
        sessionId: previous.sessionId,
        startedAt: previous.startedAt || '',
        endedAt: previous.endedAt || '',
        clean,
        exitType: clean ? (previous.exitType || 'clean') : 'unclean'
      }
      if (!clean) {
        this.recordProcessExit('application', {
          reason: 'previous-session-unclean',
          previousSessionId: previous.sessionId,
          previousStartedAt: previous.startedAt || ''
        })
      }
    }
    this.startedAt = this.now().toISOString()
    atomicWriteJsonSync(this.sessionPath, {
      schemaVersion: SESSION_SCHEMA_VERSION,
      sessionId: this.sessionId,
      version: this.version,
      pid: process.pid,
      startedAt: this.startedAt,
      state: 'running'
    })
    return this.getSessionSummary()
  }

  markClean(exitType = 'clean') {
    if (!this.startedAt || this.cleanMarked) return false
    atomicWriteJsonSync(this.sessionPath, {
      schemaVersion: SESSION_SCHEMA_VERSION,
      sessionId: this.sessionId,
      version: this.version,
      pid: process.pid,
      startedAt: this.startedAt,
      endedAt: this.now().toISOString(),
      state: 'clean',
      exitType: String(exitType || 'clean')
    })
    this.cleanMarked = true
    return true
  }

  getSessionSummary() {
    return {
      sessionId: this.sessionId,
      startedAt: this.startedAt,
      previousExit: this.previousExit
    }
  }

  recordProcessExit(processType, details = {}) {
    try {
      const sanitizer = this.getSanitizer()
      const current = readJsonSync(this.processExitsPath, [])
      const entries = Array.isArray(current) ? current : []
      entries.push(sanitizer.sanitize({
        timestamp: this.now().toISOString(),
        sessionId: this.sessionId,
        processType: String(processType || 'unknown'),
        details
      }))
      atomicWriteJsonSync(this.processExitsPath, entries.slice(-MAX_PROCESS_EXITS))
      return true
    } catch (error) {
      this.log('Unable to record process exit:', error.message || String(error))
      return false
    }
  }

  async collectComponents(sanitizer) {
    const components = await this.getComponents()
    const results = []
    for (const component of components) {
      const filePath = component?.path
      const summary = { name: String(component?.name || 'unknown'), exists: false }
      if (typeof filePath === 'string') summary.path = sanitizer.sanitizeString(filePath)
      try {
        const stat = await fsp.stat(filePath)
        if (!stat.isFile()) throw new Error('not a file')
        summary.exists = true
        summary.size = stat.size
        summary.modifiedAt = stat.mtime.toISOString()
        summary.sha256 = await hashFile(filePath)
        if (component.version) summary.version = String(component.version)
      } catch (error) {
        summary.error = sanitizer.sanitizeString(error.message || String(error))
      }
      results.push(summary)
    }
    return results
  }

  async collectLogs() {
    const candidates = [this.paths.logFile, `${this.paths.logFile}.1`, `${this.paths.logFile}.2`, `${this.paths.logFile}.3`]
    const results = []
    for (const filePath of candidates) {
      try {
        const stat = await fsp.stat(filePath)
        if (!stat.isFile()) continue
        results.push({ filePath, name: path.basename(filePath), size: stat.size, modifiedAt: stat.mtime.toISOString() })
      } catch {}
    }
    return results
  }

  async collectCrashDumpSummary() {
    const files = await listCrashDumps(this.paths.crashDumps)
    let totalBytes = 0
    for (const filePath of files) {
      const stat = await fsp.stat(filePath).catch(() => null)
      if (stat?.isFile()) totalBytes += stat.size
    }
    return { files, count: files.length, totalBytes }
  }

  async preview() {
    const sanitizer = this.getSanitizer()
    const displays = this.screen.getAllDisplays().map((display) => ({
      id: display.id,
      label: display.label || '',
      bounds: display.bounds,
      workArea: display.workArea,
      scaleFactor: display.scaleFactor,
      rotation: display.rotation,
      internal: display.internal
    }))
    const [components, logs, crashDumps] = await Promise.all([
      this.collectComponents(sanitizer),
      this.collectLogs(),
      this.collectCrashDumpSummary()
    ])
    const processExits = readJsonSync(this.processExitsPath, [])
    return sanitizer.sanitize({
      schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
      generatedAt: this.now().toISOString(),
      privacy: {
        offline: true,
        automaticUpload: false,
        excludes: ['configuration', 'credentials', 'AI content', 'selection text', 'screenshots', 'history media', 'recordings', 'OCR results'],
        crashDumpsIncluded: false
      },
      application: this.getAppInfo(),
      runtime: {
        electron: this.versions.electron || '',
        chromium: this.versions.chrome || '',
        node: this.versions.node || ''
      },
      system: {
        platform: this.platform,
        architecture: this.architecture,
        release: this.system.release(),
        version: typeof this.system.version === 'function' ? this.system.version() : ''
      },
      displays,
      components,
      session: this.getSessionSummary(),
      processExits: Array.isArray(processExits) ? processExits.slice(-MAX_PROCESS_EXITS) : [],
      logs: logs.map(({ name, size, modifiedAt }) => ({ name, size, modifiedAt })),
      crashDumps: { available: crashDumps.count, totalBytes: crashDumps.totalBytes, included: false },
      update: this.getUpdateStatus()
    })
  }

  assertTextEntriesSafe(entries, sanitizer) {
    const forbidden = [
      ...sanitizer.secrets,
      ...sanitizer.replacements.map(({ value }) => value)
    ].filter((value) => typeof value === 'string' && value.length >= 4)
    for (const entry of entries) {
      if (entry.binary) continue
      const content = entry.data.toString('utf8')
      for (const value of forbidden) {
        if (content.toLowerCase().includes(value.toLowerCase())) {
          throw new Error(`Diagnostics redaction failed for ${entry.name}`)
        }
      }
      if (/\bsk-[A-Za-z0-9_-]{8,}\b/.test(content) || /\bBearer\s+(?!\[REDACTED\])\S+/i.test(content)) {
        throw new Error(`Diagnostics credential scan failed for ${entry.name}`)
      }
    }
  }

  async exportZip(outputPath, { includeCrashDumps = false } = {}) {
    if (typeof outputPath !== 'string' || !path.isAbsolute(outputPath) || path.extname(outputPath).toLowerCase() !== '.zip') {
      throw new TypeError('Diagnostics output must be an absolute .zip path')
    }
    const sanitizer = this.getSanitizer()
    const summary = await this.preview()
    summary.privacy.crashDumpsIncluded = includeCrashDumps === true
    summary.crashDumps.included = includeCrashDumps === true
    const entries = [
      {
        name: 'summary.json',
        data: Buffer.from(`${JSON.stringify(sanitizer.sanitize(summary), null, 2)}\n`, 'utf8')
      },
      {
        name: 'README.txt',
        data: Buffer.from('Highlighter diagnostics are generated locally and are never uploaded automatically. Configuration, credentials, user content, and media are excluded. Crash dumps are included only when explicitly selected.\n', 'utf8')
      }
    ]

    for (const logInfo of await this.collectLogs()) {
      const content = sanitizeLogText(await readFileTail(logInfo.filePath), sanitizer)
      entries.push({ name: `logs/${logInfo.name}`, data: Buffer.from(content, 'utf8') })
    }

    if (includeCrashDumps) {
      for (const filePath of await listCrashDumps(this.paths.crashDumps)) {
        const data = await fsp.readFile(filePath).catch(() => null)
        if (data) entries.push({ name: `crash-dumps/${path.basename(filePath)}`, data, binary: true })
      }
    }

    this.assertTextEntriesSafe(entries, sanitizer)
    const archive = new AdmZip()
    for (const entry of entries) archive.addFile(entry.name, entry.data)
    await fsp.mkdir(path.dirname(outputPath), { recursive: true })
    const temporaryPath = `${outputPath}.${process.pid}.${crypto.randomUUID()}.tmp`
    try {
      archive.writeZip(temporaryPath)
      await fsp.rm(outputPath, { force: true })
      await fsp.rename(temporaryPath, outputPath)
    } finally {
      await fsp.rm(temporaryPath, { force: true }).catch(() => {})
    }
    const stat = await fsp.stat(outputPath)
    this.log('Diagnostics exported:', { files: entries.length, bytes: stat.size, crashDumpsIncluded: includeCrashDumps === true })
    return { outputPath, files: entries.map(({ name }) => name), bytes: stat.size, crashDumpsIncluded: includeCrashDumps === true }
  }
}

module.exports = {
  DIAGNOSTICS_SCHEMA_VERSION,
  DiagnosticsService,
  atomicWriteJsonSync,
  createSanitizer,
  listCrashDumps,
  readFileTail,
  sanitizeLogText
}
