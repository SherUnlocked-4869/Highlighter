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
  if (backupCount <= 0 || !fileSystem.existsSync(filePath)) return
  for (let index = backupCount; index >= 1; index--) {
    const source = index === 1 ? filePath : `${filePath}.${index - 1}`
    const destination = `${filePath}.${index}`
    if (!fileSystem.existsSync(source)) continue
    if (fileSystem.existsSync(destination)) fileSystem.rmSync(destination, { force: true })
    fileSystem.renameSync(source, destination)
  }
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

  function writeEntry({ level = 'info', event = 'log', values = [], details }) {
    const message = values.length ? formatLogMessage(values) : ''
    const consoleMethod = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'
    const consoleMessage = message || `${event} ${formatLogMessage([details || {}])}`
    consoleLike[consoleMethod]?.(consoleMessage)
    if (!filePath || !isEnabled()) return
    const entry = sanitizeValue({
      timestamp: now().toISOString(),
      level,
      sessionId,
      version,
      event,
      ...(message ? { message } : {}),
      ...(details === undefined ? {} : { details })
    })
    const line = `${JSON.stringify(entry)}\n`
    try {
      fileSystem.mkdirSync(path.dirname(filePath), { recursive: true })
      const currentSize = fileSystem.existsSync(filePath) ? fileSystem.statSync(filePath).size : 0
      if (currentSize + Buffer.byteLength(line) > maxBytes) rotateLog(filePath, backupCount, fileSystem)
      fileSystem.appendFileSync(filePath, line)
      writeFailureReported = false
    } catch (error) {
      if (writeFailureReported) return
      writeFailureReported = true
      consoleLike.warn(`Unable to write application log: ${error.message || String(error)}`)
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
