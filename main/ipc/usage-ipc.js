// Usage IPC registration + renderer argument validation (B1).
//
// Frozen channel list (plan §2.7). This module is a thin layer: the composition
// root (`usage-feature.js`) owns behaviour, this file freezes names and rejects
// malformed renderer arguments with English `usage: ...` errors before they can
// reach the store or the worker.
//
// Registered channels (all `ipcMain.handle`, 'main' role in ipc-security):
//   usage:status, usage:refresh, usage:summary, usage:daily, usage:hourly,
//   usage:breakdown, usage:heatmap, usage:clear
// `usage:scan-progress` is main -> renderer only (webContents.send); the preload
// subscribes with ipcRenderer.on and the main process never registers a
// listener for it.

const USAGE_HANDLE_CHANNELS = Object.freeze([
  'usage:status',
  'usage:refresh',
  'usage:summary',
  'usage:daily',
  'usage:hourly',
  'usage:breakdown',
  'usage:heatmap',
  'usage:clear'
])

const USAGE_PROGRESS_CHANNEL = 'usage:scan-progress'
const HANDLER_BY_CHANNEL = Object.freeze({
  'usage:status': 'status',
  'usage:refresh': 'refresh',
  'usage:summary': 'summary',
  'usage:daily': 'daily',
  'usage:hourly': 'hourly',
  'usage:breakdown': 'breakdown',
  'usage:heatmap': 'heatmap',
  'usage:clear': 'clear'
})

const PERIODS = Object.freeze(['day', 'week', 'month', 'total', 'custom'])
const BREAKDOWN_SCOPES = Object.freeze(['source', 'model'])
// The tools the usage page can filter by. Kept in sync with usage-tools.js; the
// filter never reaches SQLite without passing this whitelist check.
const USAGE_SOURCES = Object.freeze(['codex', 'dsh', 'opencode'])
const MAX_RANGE_DAYS = 800
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const MAX_TZ_LENGTH = 64

function usageError(message) {
  return new Error(`usage: ${message}`)
}

function asObject(value, label) {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw usageError(`${label} must be an object`)
  return value
}

function normalizePeriod(value) {
  if (value === undefined || value === null || value === '') return 'month'
  if (typeof value !== 'string' || !PERIODS.includes(value)) {
    throw usageError(`invalid period: ${String(value)}`)
  }
  return value
}

function normalizeTimezone(value) {
  if (value === undefined || value === null || value === '') return 'UTC'
  if (typeof value !== 'string' || value.length > MAX_TZ_LENGTH) throw usageError('invalid timezone')
  const candidate = value.trim()
  if (!candidate) return 'UTC'
  try {
    // Throws RangeError for unknown IANA zones.
    new Intl.DateTimeFormat('en-US', { timeZone: candidate })
    return candidate
  } catch (_error) {
    return 'UTC'
  }
}

function normalizeDay(value, label) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || !DAY_PATTERN.test(value)) throw usageError(`${label} must be YYYY-MM-DD`)
  const ms = Date.parse(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(ms)) throw usageError(`${label} is not a real date`)
  return value
}

function dayKeyToUtcMs(day) {
  return Date.parse(`${day}T00:00:00.000Z`)
}

function normalizeRange(from, to) {
  const fromDay = normalizeDay(from, 'from')
  const toDay = normalizeDay(to, 'to')
  if (!fromDay && !toDay) return { from: null, to: null }
  if (!fromDay || !toDay) throw usageError('custom range requires both from and to')
  const fromMs = dayKeyToUtcMs(fromDay)
  const toMs = dayKeyToUtcMs(toDay)
  if (fromMs > toMs) throw usageError('range start is after range end')
  const spanDays = Math.round((toMs - fromMs) / 86400000) + 1
  if (spanDays > MAX_RANGE_DAYS) throw usageError(`range is longer than ${MAX_RANGE_DAYS} days`)
  return { from: fromDay, to: toDay }
}

// Returns `undefined` for "no filtering" and the deduplicated selection
// otherwise. Treating both the empty array and the full set as `undefined` is
// deliberate: the renderer's "all tools" state can arrive as either, and an
// unfiltered query keeps the cheaper SQL path. Keeping the key out of the
// returned object when there is nothing to filter also preserves the frozen
// validated-args shape the IPC contract fixtures assert on.
function normalizeSources(value) {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw usageError('sources must be an array')
  const unique = []
  for (const entry of value) {
    if (typeof entry !== 'string' || !USAGE_SOURCES.includes(entry)) {
      throw usageError(`invalid source: ${String(entry)}`)
    }
    if (!unique.includes(entry)) unique.push(entry)
  }
  if (unique.length === 0 || unique.length === USAGE_SOURCES.length) return undefined
  return unique
}

// Attaches the filter only when one survives normalization, so an unfiltered
// call's validated args stay byte-identical to the pre-filter contract.
function withSources(args, value) {
  const sources = normalizeSources(value)
  return sources ? { ...args, sources } : args
}

function normalizePeriodArgs(value, { allowCustom = false } = {}) {
  const args = asObject(value, 'args')
  const period = normalizePeriod(args.period)
  const tz = normalizeTimezone(args.tz)
  const range = normalizeRange(args.from, args.to)
  if (period === 'custom' && !allowCustom) throw usageError('custom period is not supported here')
  if (period === 'custom' && (!range.from || !range.to)) throw usageError('custom period requires from and to')
  return withSources({ period, tz, from: range.from, to: range.to }, args.sources)
}

function validateStatusArgs() {
  return undefined
}

function validateRefreshArgs(value) {
  const args = asObject(value, 'args')
  const reason = args.reason === undefined ? 'manual' : args.reason
  if (reason !== 'page-open' && reason !== 'manual') throw usageError('invalid refresh reason')
  return { reason }
}

function validateSummaryArgs(value) {
  return normalizePeriodArgs(value, { allowCustom: true })
}

function validateDailyArgs(value) {
  return normalizePeriodArgs(value, { allowCustom: true })
}

function validateBreakdownArgs(value) {
  const args = normalizePeriodArgs(value, { allowCustom: true })
  const scope = asObject(value, 'args').scope === undefined ? 'source' : asObject(value, 'args').scope
  if (typeof scope !== 'string' || !BREAKDOWN_SCOPES.includes(scope)) {
    throw usageError(`invalid breakdown scope: ${String(scope)}`)
  }
  return { ...args, scope }
}

function validateHourlyArgs(value) {
  const args = asObject(value, 'args')
  const day = normalizeDay(args.day, 'day') || new Date().toISOString().slice(0, 10)
  return withSources({ day, tz: normalizeTimezone(args.tz) }, args.sources)
}

function validateHeatmapArgs(value) {
  const args = asObject(value, 'args')
  let weeks = args.weeks === undefined ? 52 : args.weeks
  if (typeof weeks !== 'number' || !Number.isFinite(weeks)) throw usageError('weeks must be a number')
  weeks = Math.min(52, Math.max(1, Math.trunc(weeks)))
  return withSources({ tz: normalizeTimezone(args.tz), weeks }, args.sources)
}

function validateClearArgs() {
  return undefined
}

const VALIDATOR_BY_CHANNEL = Object.freeze({
  'usage:status': validateStatusArgs,
  'usage:refresh': validateRefreshArgs,
  'usage:summary': validateSummaryArgs,
  'usage:daily': validateDailyArgs,
  'usage:hourly': validateHourlyArgs,
  'usage:breakdown': validateBreakdownArgs,
  'usage:heatmap': validateHeatmapArgs,
  'usage:clear': validateClearArgs
})

function registerUsageIpc({ ipcMain, handlers = {}, log = () => {} } = {}) {
  if (!ipcMain || typeof ipcMain.handle !== 'function') {
    throw new TypeError('usage IPC requires ipcMain.handle')
  }
  for (const channel of USAGE_HANDLE_CHANNELS) {
    const handlerName = HANDLER_BY_CHANNEL[channel]
    if (typeof handlers[handlerName] !== 'function') {
      throw new Error(`usage IPC handler is missing: ${handlerName}`)
    }
  }
  // The Channel layer wraps validation + English error mapping, but every
  // ipcMain.handle() call below keeps a LITERAL channel string: the repository's
  // IPC surface contract test discovers registrations by regex and a loop over a
  // channel array would be invisible to it (and therefore to assertComplete()).
  const wrap = (channel, validate, handler) => async (_event, ...args) => {
    const normalized = validate(args[0])
    try {
      return await handler(normalized)
    } catch (error) {
      log(`usage ipc ${channel} failed: ${error?.message || String(error)}`)
      throw error instanceof Error ? error : usageError(String(error))
    }
  }

  ipcMain.handle('usage:status', wrap('usage:status', validateStatusArgs, handlers.status))
  ipcMain.handle('usage:refresh', wrap('usage:refresh', validateRefreshArgs, handlers.refresh))
  ipcMain.handle('usage:summary', wrap('usage:summary', validateSummaryArgs, handlers.summary))
  ipcMain.handle('usage:daily', wrap('usage:daily', validateDailyArgs, handlers.daily))
  ipcMain.handle('usage:hourly', wrap('usage:hourly', validateHourlyArgs, handlers.hourly))
  ipcMain.handle('usage:breakdown', wrap('usage:breakdown', validateBreakdownArgs, handlers.breakdown))
  ipcMain.handle('usage:heatmap', wrap('usage:heatmap', validateHeatmapArgs, handlers.heatmap))
  ipcMain.handle('usage:clear', wrap('usage:clear', validateClearArgs, handlers.clear))
}

module.exports = {
  BREAKDOWN_SCOPES,
  HANDLER_BY_CHANNEL,
  MAX_RANGE_DAYS,
  PERIODS,
  USAGE_HANDLE_CHANNELS,
  USAGE_PROGRESS_CHANNEL,
  USAGE_SOURCES,
  normalizeSources,
  registerUsageIpc,
  usageError,
  validateBreakdownArgs,
  validateClearArgs,
  validateDailyArgs,
  validateHeatmapArgs,
  validateHourlyArgs,
  validateRefreshArgs,
  validateStatusArgs,
  validateSummaryArgs
}
