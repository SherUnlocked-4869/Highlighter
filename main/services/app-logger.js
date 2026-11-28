const fs = require('fs')
const path = require('path')

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024
const DEFAULT_BACKUP_COUNT = 3
const REDACTED = '[REDACTED]'
const SENSITIVE_KEY = /(api[-_]?key|authorization|password|secret|token)/i

function redactString(value) {
  return String(value)
    .replace(/\bBearer\s+\S+/gi, `Bearer ${REDACTED}`)
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, REDACTED)
    .replace(/\b(api[-_]?key|authorization|password|secret|token)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, (_match, key) => `${key}=${REDACTED}`)
}

function sanitizeValue(value, seen = new WeakSet()) {
  if (typeof value === 'string') return redactString(value)
  if (value instanceof Error) return redactString(value.stack || value.message || String(value))
  if (!value || typeof value !== 'object') return value
  if (seen.has(value)) return '[Circular]'
  seen.add(value)
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, seen))
  const sanitized = {}
  for (const [key, item] of Object.entries(value)) {
    sanitized[key] = SENSITIVE_KEY.test(key) ? REDACTED : sanitizeValue(item, seen)
  }
  return sanitized
}

function formatLogMessage(values) {
  return values.map((value) => {
    const sanitized = sanitizeValue(value)
    if (typeof sanitized === 'string') return sanitized
    try {
      return JSON.stringify(sanitized)
    } catch {
      return String(sanitized)
    }
  }).join(' ')
}

function rotateLog(filePath, backupCount, fileSystem = fs) {
  if (backupCount <= 0 || !fileSystem.existsSync(filePath)) return false
  for (let index = backupCount; index >= 1; index--) {
    const source = index === 1 ? filePath : `${filePath}.${index - 1}`
    const destination = `${filePath}.${index}`
    if (!fileSystem.existsSync(source)) continue
    if (fileSystem.existsSync(destination)) fileSystem.rmSync(destination, { force: true })
    fileSystem.renameSync(source, destination)
  }
  return true
}

function createAppLogger({
  filePath,
  isEnabled = () => true,
  sessionId = '',
  version = '',
  maxBytes = DEFAULT_MAX_BYTES,
  backupCount = DEFAULT_BACKUP_COUNT,
  consoleLike = console,
  fileSystem = fs,
  now = () => new Date()
}) {
  let writeFailureReported = false
  // F01 (docs/reviews/2026-11-26-code-review-and-optimization-report.md section 3.1): a log
  // line used to cost mkdirSync + existsSync + statSync + appendFileSync. The directory is now
  // created once and the size is seeded once from the file at startup, so the rotation decision
  // is made from this running byte count and a normal line costs a single append.
  let currentBytes = null
  let directoryReady = false

  function ensureDirectory() {
    if (directoryReady) return
    fileSystem.mkdirSync(path.dirname(filePath), { recursive: true })
    directoryReady = true
  }

  function seededBytes() {
    if (currentBytes !== null) return currentBytes
    try {
      currentBytes = fileSystem.statSync(filePath).size
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      currentBytes = 0
    }
    return currentBytes
  }

  function writeConsole(method, message) {
    try {
      consoleLike?.[method]?.(message)
    } catch {}
  }

  function writeEntry({ level = 'info', event = 'log', values = [], details }) {
    const message = values.length ? formatLogMessage(values) : ''
    const consoleMethod = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'
    const consoleMessage = message || `${event} ${formatLogMessage([details || {}])}`
    writeConsole(consoleMethod, consoleMessage)
    if (!filePath || !isEnabled()) return
    // The message went through formatLogMessage() already; only the structured payload is
    // dynamic here, so it is sanitized exactly once instead of re-running the regexes over the
    // whole entry.
    const entry = {
      timestamp: now().toISOString(),
      level,
      sessionId,
      version,
      event,
      ...(message ? { message } : {}),
      ...(details === undefined ? {} : { details: sanitizeValue(details) })
    }
    const line = `${JSON.stringify(entry)}\n`
    const lineBytes = Buffer.byteLength(line)
    try {
      ensureDirectory()
      let current = seededBytes()
      if (current + lineBytes > maxBytes && rotateLog(filePath, backupCount, fileSystem)) current = 0
      fileSystem.appendFileSync(filePath, line)
      currentBytes = current + lineBytes
      writeFailureReported = false
    } catch (error) {
      if (writeFailureReported) return
      writeFailureReported = true
      writeConsole('warn', `Unable to write application log: ${error.message || String(error)}`)
    }
  }

  const logger = (...values) => writeEntry({ values })
  logger.event = (event, details = {}, level = 'info') => writeEntry({ event, details, level })
  return logger
}

module.exports = {
  createAppLogger,
  formatLogMessage,
  redactString,
  rotateLog,
  sanitizeValue
}
