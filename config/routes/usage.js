// Local AI CLI usage dashboard over the main process aggregates.


const USAGE_DEFAULT_PERIOD = 'week'
const USAGE_TREND_DAYS = 30
const USAGE_ROLLING_DAYS = { week: 7, month: 30, quarter: 90 }
const USAGE_TREND_METRICS = ['token', 'output', 'records', 'sessions', 'cost', 'active']
const USAGE_MODEL_LIMIT = 5
const USAGE_HEATMAP_WEEKS = 52
const USAGE_HEATMAP_TICK_MIN_SPAN = 1
const USAGE_CUSTOM_PERIOD = 'custom'

// Period tabs in display order. The custom tab reveals the date range row; the
// resolves through t() on every render so a language switch needs no reload.
const USAGE_PERIODS = [
  { id: 'day', labelKey: 'config.usage.tab.day' },
  { id: 'week', labelKey: 'config.usage.kpi.last-7d' },
  { id: 'month', labelKey: 'config.usage.kpi.last-30d' },
  { id: 'quarter', labelKey: 'config.usage.dashboard.last-90d' },
  { id: 'total', labelKey: 'config.usage.tab.total' },
  { id: USAGE_CUSTOM_PERIOD, labelKey: 'config.usage.tab.custom' }
]

// Confirmed MVP scope (plan §0.5): these three tools are measured; Cursor is the
// deliberate "cannot measure locally" example rendered as a persistent note.
const USAGE_SUPPORTED_SOURCES = ['codex', 'dsh', 'opencode']

const USAGE_SOURCE_LABEL_KEYS = {
  codex: 'config.usage.source.codex',
  dsh: 'config.usage.source.dsh',
  opencode: 'config.usage.source.opencode',
  cursor: 'config.usage.source.cursor'
}

const USAGE_SOURCE_STATE_KEYS = {
  ok: 'config.usage.coverage.state-ok',
  empty: 'config.usage.coverage.state-empty',
  unreadable: 'config.usage.coverage.state-unreadable',
  absent: 'config.usage.coverage.state-absent',
  error: 'config.usage.coverage.state-error',
  unsupported: 'config.usage.coverage.state-unsupported'
}

// Weekday column labels for the heatmap (Monday first, matching the payload).
const USAGE_WEEKDAY_KEYS = [
  'config.usage.weekday.mon',
  'config.usage.weekday.tue',
  'config.usage.weekday.wed',
  'config.usage.weekday.thu',
  'config.usage.weekday.fri',
  'config.usage.weekday.sat',
  'config.usage.weekday.sun'
]

const USAGE_STATE_COPY = {
  scanning: { title: 'config.usage.state.scanning-title', body: 'config.usage.state.scanning-body' },
  empty: { title: 'config.usage.state.empty-title', body: 'config.usage.state.empty-body' },
  absent: { title: 'config.usage.state.absent-title', body: 'config.usage.state.absent-body' },
  unreadable: { title: 'config.usage.state.unreadable-title', body: 'config.usage.state.unreadable-body' },
  error: { title: 'config.usage.state.error-title', body: 'config.usage.state.error-body' },
  unsupported: { title: 'config.usage.state.unsupported-title', body: 'config.usage.state.unsupported-body' }
}

const USAGE_CONSENT_POINTS = [
  'config.usage.consent.point-readonly',
  'config.usage.consent.point-local',
  'config.usage.consent.point-optout'
]

// The required channels gate the whole page; the optional ones only add a card.
const USAGE_REQUIRED_METHODS = ['usageStatus', 'usageSummary', 'usageDaily', 'usageBreakdown', 'usageRefresh', 'usageClear']
const USAGE_OPTIONAL_METHODS = ['usageHourly', 'usageHeatmap']

// Automatic freshness poll. The renderer asks faster than the engine's floor on
// purpose: the collector is the single owner of the floor (5 min, see
// usage-collector.js DEFAULT_SCAN_THROTTLE_MS), so its answer tells us when the
// data actually moved. Polling exactly at the floor would drift a whole period
// (a tick landing 200 ms early is throttled, then the next tick is 5 min later),
// while polling faster than the floor converges to "a scan within the floor".
const USAGE_AUTO_REFRESH_MS = 60 * 1000

// Localized message per custom-range validation failure (helper reasons, see
// shared/usage-format.js validateCustomRange).
const USAGE_RANGE_REASON_KEYS = {
  from: 'config.usage.range.invalid',
  to: 'config.usage.range.invalid',
  order: 'config.usage.range.order',
  future: 'config.usage.range.future',
  span: 'config.usage.range.span',
  invalid: 'config.usage.range.invalid'
}

// Three stacked trend bands, all primary-derived so the single accent rule holds:
// full accent input, a mid cache tone and a light output tone that still reads on
// both themes (they are re-evaluated under body.dark by color-mix at use time).
const USAGE_TREND_SEGMENTS = [
  { id: 'input', labelKey: 'config.usage.trend.input', dotClass: 'usage-trend-dot-input' },
  { id: 'cache', labelKey: 'config.usage.trend.cache', dotClass: 'usage-trend-dot-cache' },
  { id: 'output', labelKey: 'config.usage.trend.output', dotClass: 'usage-trend-dot-output' }
]

let usageRenderVersion = 0
let usagePeriod = USAGE_DEFAULT_PERIOD
let usageRange = { from: '', to: '' }
let usagePeriodBeforeCustom = USAGE_DEFAULT_PERIOD
// Selected AI tools for the filter row. Empty means "all tools" (default): the
// query then omits `sources` entirely instead of enumerating the supported set.
let usageSourceFilter = []
let usageModelFilter = ''
let usageProjectFilter = ''
let usageProjectLabel = ''
let usageSessionSort = 'token'
let usageSessionSearch = ''
let usageSessionExpanded = false
const usageExpandedActivity = new Set()
// Price editor state (B07). `null` means "render from settings". The first edit
// or "add version" snapshots every row from the DOM into this array, which then
// survives the repaint a period switch causes; Save clears it. A whole-table
// snapshot avoids keying drafts by a model+date string that the user is still
// typing (the key would change under the draft).
let usagePriceEditor = null
let usagePriceRowSeq = 0
// Imported aggregate snapshot preview (B07): { payload, preview }. The payload
// is the exact text the user picked; commit re-validates it in the main process.
let usageImportPayload = null
let usageImportPreviewData = null
let usageIncludeCache = true
let usageTrendMetric = 'token'
let usageHeatView = 'hourly'
let usageRefreshInterval = USAGE_AUTO_REFRESH_MS
let usageDailySort = 'desc'
let usageDailyRowCache = []
let usageProgressUnsubscribe = null
let usageRefreshPending = false
let usageHeatTooltipTimer = null
let usageDashboardPayload = null
let usageTrendModal = null
let usageTrendModalGranularity = 'day'
let usageTrendModalCleanup = null
let usageTrendModalRequest = 0
// Monotonic counter for the "keep the old dashboard while re-querying" path.
// A period/filter switch only swaps the dashboard in once new data lands.
let usageSwapVersion = 0
// Auto-refresh lifecycle (see the header comment). `usageAutoRefreshTimer` is a
// one-shot `setTimeout` chain, not `setInterval`: a slow engine answer must never
// stack calls. `usageAutoRefreshListeners` holds the window/document handlers the
// route added, so leaving the page can remove exactly those.
let usageAutoRefreshTimer = null
let usageAutoRefreshListeners = null
let usageAutoRefreshInFlight = false
// A scan can finish while the trend modal is open; re-rendering would tear the
// modal down, so the refresh is deferred until the modal closes.
let usageAutoRefreshRenderPending = false

function usageHasApi(name) {
  return !!window.electronAPI && typeof window.electronAPI[name] === 'function'
}

function usageMissingMethods() {
  return USAGE_REQUIRED_METHODS.filter((name) => !usageHasApi(name))
}

function usageHasOptionalApi(name) {
  return USAGE_OPTIONAL_METHODS.includes(name) && usageHasApi(name)
}

function usageToday() {
  return window.usageFormat.toDayKey(new Date())
}

function usageDefaultRange() {
  const format = window.usageFormat
  const today = usageToday()
  return { from: format.addDays(today, -(USAGE_TREND_DAYS - 1)), to: today }
}

// Custom period is only entered through the custom tab, but a stale range can
// survive a re-render/language switch; validate it before the IPC round trip and
// fall back to the default tab with a toast.
function usageNormalizeRange() {
  if (usagePeriod !== USAGE_CUSTOM_PERIOD) return
  if (!usageRange.from || !usageRange.to) {
    usageRange = usageDefaultRange()
  }
  const result = window.usageFormat.validateCustomRange(usageRange.from, usageRange.to, usageToday())
  if (result.valid) {
    usageRange = { from: result.from, to: result.to }
    return
  }
  usagePeriod = USAGE_DEFAULT_PERIOD
  usageRange = { from: '', to: '' }
  usageToast(t(USAGE_RANGE_REASON_KEYS[result.reason] || 'config.usage.range.invalid'))
}

// Every query channel takes the same {period, tz, from?, to?} shape; the custom
// period is the only one that carries explicit bounds.
function usageQueryParams() {
  const tz = usageTimezone()
  const filters = {
    ...(usageSourceFilter.length ? { sources: usageSourceFilter.slice() } : {}),
    ...(usageModelFilter ? { model: usageModelFilter } : {}),
    ...(usageProjectFilter ? { project: usageProjectFilter } : {})
  }
  if (usagePeriod === USAGE_CUSTOM_PERIOD) {
    return { period: 'custom', tz, ...usageRange, ...filters }
  }
  const days = USAGE_ROLLING_DAYS[usagePeriod]
  if (days) {
    const to = usageToday()
    return { period: 'custom', tz, from: window.usageFormat.addDays(to, 1 - days), to, ...filters }
  }
  return { period: usagePeriod, tz, ...filters }
}

function usageIsCurrent(renderVersion) {
  return currentRoute === 'usage' && renderVersion === usageRenderVersion
}

function usageLanguage() {
  return typeof currentLanguage === 'function' ? currentLanguage() : 'zh-CN'
}

function usageNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

function usageCompact(value) {
  return window.usageFormat.formatCompactToken(usageNumber(value), 'en-US')
}

function usageFull(value) {
  return window.usageFormat.formatFullToken(usageNumber(value))
}

function usageShare(value) {
  return window.usageFormat.formatSharePct(usageNumber(value))
}

function usageErrorText(error) {
  if (typeof errorMessage === 'function') {
    const text = errorMessage(error)
    if (text) return text
  }
  return String((error && error.message) || error || '')
}

function usageIntlLocale() {
  const language = usageLanguage()
  if (language === 'zh-TW') return 'zh-TW'
  if (language === 'en-US') return 'en-US'
  return 'zh-CN'
}

function usageTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

// '2026-10-21T03:10:00.000Z' -> locale date + short time. Invalid values render
// as an empty string so the coverage strip can fall back to "not scanned yet".
function usageDateTime(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  try {
    return new Intl.DateTimeFormat(usageIntlLocale(), {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    }).format(date)
  } catch {
    return date.toISOString()
  }
}

// "just now / 5 minutes ago / 3 hours ago / yesterday" for the coverage strip.
// A bare timestamp makes a stale reading look like a fresh one; the relative form
// is what tells the user whether they are looking at minutes or days. Returns ''
// when the value is missing/invalid so callers can fall back to "not scanned yet".
function usageRelativeTime(value, now = new Date()) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const seconds = Math.round((now.getTime() - date.getTime()) / 1000)
  // A clock that jumped backwards must not render "in -3 minutes"; treat the
  // future as "just now" and let the absolute timestamp carry the detail.
  if (seconds < 60) return t('config.usage.coverage.relative-now')
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return t('config.usage.coverage.relative-minutes', { count: minutes })
  const hours = Math.round(minutes / 60)
  if (hours < 24) return t('config.usage.coverage.relative-hours', { count: hours })
  const days = Math.round(hours / 24)
  if (days === 1) return t('config.usage.coverage.relative-yesterday')
  return t('config.usage.coverage.relative-days', { count: days })
}

// Locale date for the heatmap/trend tooltip headers (the rest of the page keeps
// ISO day keys for the range label and the table, which are data, not prose).
function usageDayLabel(dayKey) {
  const key = window.usageFormat.toDayKey(dayKey)
  if (!key) return String(dayKey || '')
  const [year, month, day] = key.split('-').map(Number)
  try {
    return new Intl.DateTimeFormat(usageIntlLocale(), { year: 'numeric', month: 'long', day: 'numeric' })
      .format(new Date(year, month - 1, day))
  } catch {
    return key
  }
}

// '2026-10-21T07:00' -> '07:00'; used by the 30-minute granularity axis labels.
function usageHourClock(value) {
  const hour = String(value || '')
  return hour.length >= 16 ? hour.slice(11, 16) : ''
}

function usageSourceLabel(source) {
  const id = source && source.source ? source.source : ''
  const key = USAGE_SOURCE_LABEL_KEYS[id]
  if (key) return t(key)
  return (source && source.label) || id
}

function usageSourceStateKey(state) {
  return USAGE_SOURCE_STATE_KEYS[state] ? state : 'absent'
}


function usageRangeLabel(summary) {
  const period = (summary && summary.period) || usagePeriod
  return window.usageFormat.formatRangeLabel(period, summary && summary.from, summary && summary.to)
}

function usageFormatBytes(value) {
  return typeof formatBytes === 'function' ? formatBytes(value) : ''
}

function usageToast(message) {
  if (typeof toast === 'function' && message) toast(message)
}


function usageIsActiveDay(row) {
  return !!row && (usageDashboardTokens(row, true) > 0 || usageNumber(row.conversation_count) > 0)
}

// Clamp a percentage so inline SVG-free progress bars never overflow their track.
function usageClampPct(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.min(100, Math.max(0, number))
}

// ---------------------------------------------------------------------------
// Page scaffold
// ---------------------------------------------------------------------------

function usageHeaderHtml(actionsHtml = '') {
  const actions = actionsHtml ? `<div class="page-head-actions">${actionsHtml}</div>` : ''
  return pageHeader(t('config.route.usage'), t('config.usage.subtitle'), actions)
}

function usageRefreshButtonHtml(scanning = false) {
  const label = escapeHtml(t(scanning ? 'config.usage.state.scanning-title' : 'config.usage.refresh'))
  const icon = typeof iconMarkup === 'function' ? iconMarkup('icons/refresh.svg') : ''
  return `<button class="button usage-refresh-button" type="button" id="refreshUsage" data-usage-refresh aria-busy="${scanning}"${scanning ? ' disabled' : ''}>${icon}<span>${label}</span></button>`
}

function usageStateCardHtml(state, title, body, actionsHtml = '') {
  return `<div class="usage-card usage-state-card usage-state-${state}" role="status">
    <b class="usage-state-title">${escapeHtml(title)}</b>
    <p class="usage-state-body">${escapeHtml(body)}</p>
    ${actionsHtml ? `<div class="usage-state-actions">${actionsHtml}</div>` : ''}
  </div>`
}

function usageRenderLoading(renderVersion) {
  if (!usageIsCurrent(renderVersion)) return
  view.innerHTML = `<div class="page usage-page" data-usage-state="loading">
    ${usageHeaderHtml()}
    <div class="usage-card usage-loading"><span>${t('config.usage.state.loading')}</span></div>
  </div>`
}

// Engine-not-integrated / status-read failure: no demo data and no coverage
// strip (there is no status payload to be honest about), just a retry action.
function usageRenderStandaloneError(renderVersion, title, body) {
  if (!usageIsCurrent(renderVersion)) return
  view.innerHTML = `<div class="page usage-page" data-usage-state="error">
    ${usageHeaderHtml()}
    ${usageStateCardHtml('error', title, body, `<button class="button primary" type="button" data-usage-retry>${t('config.usage.state.retry')}</button>`)}
  </div>`
  usageBindRetry()
}

function usageRenderConsent(renderVersion, status) {
  if (!usageIsCurrent(renderVersion)) return
  const points = USAGE_CONSENT_POINTS.map((key) => `<li>${t(key)}</li>`).join('')
  view.innerHTML = `<div class="page usage-page" data-usage-state="disabled">
    ${usageHeaderHtml(usageRefreshButtonHtml())}
    ${usageCoverageHtml(status, { disabled: true })}
    <div class="usage-card usage-consent">
      <h2 class="usage-consent-title">${t('config.usage.consent.title')}</h2>
      <p class="usage-consent-body">${t('config.usage.consent.body')}</p>
      <ul class="usage-consent-points">${points}</ul>
      <div class="usage-consent-actions">
        <button class="button primary" type="button" data-usage-enable>${t('config.usage.consent.enable')}</button>
      </div>
    </div>
  </div>`
  usageBindConsent()
}

function usageRenderLoadError(renderVersion, status, error) {
  if (!usageIsCurrent(renderVersion)) return
  const detail = usageErrorText(error) || t('config.usage.state.error-body')
  view.innerHTML = `<div class="page usage-page" data-usage-state="error">
    ${usageHeaderHtml(usageRefreshButtonHtml())}
    ${usageCoverageHtml(status)}
    ${usageStateCardHtml('error', t('config.usage.state.error-title'), detail, `<button class="button primary" type="button" data-usage-retry>${t('config.usage.state.retry')}</button>`)}
  </div>`
  usageBindRetry()
  usageBindRefresh()
  usageBindCoverageActions()
  usageSubscribeProgress()
}

// ---------------------------------------------------------------------------
// Coverage strip (persistent, deliberately secondary to the numbers)
// ---------------------------------------------------------------------------

function usageCoverageChipHtml(source, disabled) {
  const stateId = disabled ? 'absent' : usageSourceStateKey(source && source.state)
  const stateText = disabled ? t('config.usage.coverage.not-enabled') : t(USAGE_SOURCE_STATE_KEYS[stateId])
  const label = usageSourceLabel(source)
  const titleParts = []
  const files = usageNumber(source && source.files)
  if (files > 0) titleParts.push(t('config.usage.coverage.files', { count: files }))
  const errorText = source && source.lastError ? String(source.lastError) : ''
  if (errorText) titleParts.push(errorText)
  const estimated = source && source.estimated === true
    ? `<em class="usage-estimated-badge">${t('config.usage.coverage.estimated')}</em>`
    : ''
  return `<span class="usage-chip" data-usage-source="${escapeHtml(source && source.source)}" data-state="${escapeHtml(disabled ? 'disabled' : stateId)}" title="${escapeHtml(titleParts.join(' · '))}">
    <i class="usage-chip-dot" aria-hidden="true"></i>
    <b>${escapeHtml(label)}</b>
    <span>${escapeHtml(stateText)}</span>
    ${estimated}
  </span>`
}

function usageScanText(scan) {
  const filesDone = usageNumber(scan && scan.filesDone)
  const filesTotal = usageNumber(scan && scan.filesTotal)
  const progress = filesTotal > 0
    ? t('config.usage.coverage.scanning', { done: filesDone, total: filesTotal })
    : t('config.usage.state.scanning-title')
  const tool = scan && scan.tool ? usageSourceLabel({ source: scan.tool }) : ''
  return tool ? `${tool} · ${progress}` : progress
}

function usageScanPercent(scan) {
  const filesDone = usageNumber(scan && scan.filesDone)
  const filesTotal = usageNumber(scan && scan.filesTotal)
  if (filesTotal <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((filesDone / filesTotal) * 100)))
}

function usageScanHtml(status) {
  const scanning = !!(status && status.scanning === true)
  const scan = scanning && status.scan && typeof status.scan === 'object' ? status.scan : null
  return `<div class="usage-scan" data-usage-scan ${scanning ? '' : 'hidden'}>
    <span class="usage-scan-text">${escapeHtml(scan ? usageScanText(scan) : '')}</span>
    <span class="usage-scan-track"><i class="usage-scan-bar" style="width:${usageScanPercent(scan)}%"></i></span>
  </div>`
}

function usageCoverageHtml(status, options = {}) {
  const disabled = options.disabled === true
  const sources = status && Array.isArray(status.sources) ? status.sources : []
  const byId = new Map(sources.map((source) => [source && source.source, source]))
  const supported = USAGE_SUPPORTED_SOURCES.map((id) => byId.get(id) || { source: id, state: 'absent', detected: false, readable: false, files: 0 })
  const detected = supported.filter((source) => source && (source.detected === true || source.state === 'ok' || source.state === 'empty')).length
  const chips = supported.map((source) => usageCoverageChipHtml(source, disabled)).join('')

  let lastScan = ''
  if (!disabled) {
    if (status && status.lastScanAt) {
      const relative = usageRelativeTime(status.lastScanAt)
      lastScan = relative
        ? t('config.usage.coverage.last-scan-relative', { time: usageDateTime(status.lastScanAt), relative })
        : t('config.usage.coverage.last-scan', { time: usageDateTime(status.lastScanAt) })
    } else {
      lastScan = t('config.usage.coverage.never-scanned')
    }
  }

  const meta = []
  if (lastScan) meta.push(lastScan)
  if (!disabled && status && usageNumber(status.dbBytes) > 0) meta.push(t('config.usage.coverage.db-size', { size: usageFormatBytes(status.dbBytes) }))
  if (!disabled && status && usageNumber(status.retentionMonths) > 0) meta.push(t('config.usage.coverage.retention', { months: usageNumber(status.retentionMonths) }))
  const clear = disabled ? '' : `<button class="button usage-clear-button" type="button" data-usage-clear>${t('config.usage.clear')}</button>`

  const errorBanner = !disabled && status && status.lastError
    ? `<div class="usage-banner usage-banner-error" role="alert">${escapeHtml(String(status.lastError))}</div>`
    : ''

  return `<div class="usage-coverage" id="usageCoverage">
    <div class="usage-coverage-main">
      <span class="usage-coverage-heading">${t('config.usage.coverage.title')}</span>
      <span class="usage-coverage-detected">${t('config.usage.coverage.detected', { detected, total: USAGE_SUPPORTED_SOURCES.length })}</span>
      <div class="usage-coverage-chips">${chips}</div>
      <div class="usage-coverage-meta">${meta.map((item) => `<span>${escapeHtml(item)}</span>`).join('')}${clear}</div>
    </div>
    ${usageScanHtml(disabled ? null : status)}
    ${errorBanner}
  </div>`
}

// ---------------------------------------------------------------------------
// Toolbar: date, refresh cadence and filters.
// ---------------------------------------------------------------------------

function usageTabsHtml(models, projects, status) {
  const scanning = status?.scanning === true
  const buttons = USAGE_PERIODS.map((period) => {
    const selected = period.id === usagePeriod
    return `<button class="usage-segment" type="button" data-usage-tab="${period.id}" aria-pressed="${selected}">${escapeHtml(t(period.labelKey))}</button>`
  }).join('')
  const intervalOptions = [60000, 300000, 900000, 0].map((ms) => {
    const label = ms ? usageDashboardText('minutes', { count: ms / 60000 }) : usageDashboardText('off')
    return usageOption(ms, label, usageRefreshInterval)
  }).join('')
  return `<div class="usage-controls">
    <div class="usage-toolbar">
      <div class="usage-segments usage-periods" role="group" aria-label="${escapeHtml(t('config.usage.tabs-label'))}">${buttons}</div>
      <div class="usage-toolbar-end">${usageExchangeButtonsHtml(status)}${usageRefreshButtonHtml(scanning)}
        <label>${escapeHtml(usageDashboardText('auto'))}<select id="usageEvery">${intervalOptions}</select></label>
      </div>
    </div>
    ${usagePeriod === USAGE_CUSTOM_PERIOD ? usageCustomRangeHtml() : ''}
    ${usageSourceFilterHtml(models, projects)}
  </div>`
}

function usageDashboardText(key, params) {
  return t(`config.usage.dashboard.${key}`, params)
}

function usageOption(value, label, selected) {
  return `<option value="${escapeHtml(String(value))}"${value === selected ? ' selected' : ''}>${escapeHtml(label)}</option>`
}

function usageIsFilterableModel(model) {
  return typeof model === 'string' && model.trim() !== '' && model.length <= 256 && !/[\x00-\x1f]/.test(model)
}

function usageSourceFilterHtml(models, projects) {
  const source = usageSourceFilter[0] || ''
  const agents = USAGE_SUPPORTED_SOURCES.map((id) => usageOption(id, usageSourceLabel({ source: id }), source))
  const names = [...new Set(models.map((row) => row.model).filter(usageIsFilterableModel))].sort()
  if (usageModelFilter && !names.includes(usageModelFilter)) names.unshift(usageModelFilter)
  const options = projects.map((item) => usageOption(item.id, item.name, usageProjectFilter))
  if (usageProjectFilter && !projects.some((item) => item.id === usageProjectFilter)) {
    options.unshift(usageOption(usageProjectFilter, usageProjectLabel, usageProjectFilter))
  }
  return `<div class="usage-filters">
    <select id="usageSource" aria-label="${escapeHtml(t('config.usage.filter.label'))}">
      ${usageOption('', usageDashboardText('all-agents'), source)}${agents.join('')}
    </select>
    <select id="usageModel" aria-label="${escapeHtml(usageDashboardText('model'))}">
      ${usageOption('', usageDashboardText('all-models'), usageModelFilter)}${names.map((name) => usageOption(name, name, usageModelFilter)).join('')}
    </select>
    <select id="usageProject" aria-label="${escapeHtml(usageDashboardText('project'))}"${options.length ? '' : ' disabled'}>
      ${usageOption('', usageDashboardText('all-projects'), usageProjectFilter)}${options.join('')}
    </select>
  </div>`
}

// Two native date inputs, visible only while the custom tab is selected. The
// range is validated by the shared helper before it becomes a query.
function usageCustomRangeHtml() {
  const format = window.usageFormat
  const today = usageToday()
  const defaults = usageDefaultRange()
  const from = usageRange.from || defaults.from
  const to = usageRange.to || defaults.to
  const min = format.addDays(today, -format.CUSTOM_RANGE_MAX_SPAN_DAYS)
  return `<div class="usage-custom-range" data-usage-range>
    <label class="usage-range-field"><span>${t('config.usage.range.from')}</span><input class="usage-range-input" type="date" data-usage-range-from value="${escapeHtml(from)}" min="${escapeHtml(min)}" max="${escapeHtml(today)}"></label>
    <span class="usage-range-dash" aria-hidden="true">–</span>
    <label class="usage-range-field"><span>${t('config.usage.range.to')}</span><input class="usage-range-input" type="date" data-usage-range-to value="${escapeHtml(to)}" min="${escapeHtml(min)}" max="${escapeHtml(today)}"></label>
    <button class="button primary usage-range-apply" type="button" data-usage-range-apply>${t('config.usage.range.apply')}</button>
    <button class="button usage-range-cancel" type="button" data-usage-range-reset>${t('config.usage.range.reset')}</button>
  </div>`
}

// ---------------------------------------------------------------------------
// Overview, rankings and daily trend
// ---------------------------------------------------------------------------


function usageTrendRows(daily) {
  const rows = (Array.isArray(daily?.rows) ? daily.rows : [])
    .filter((row) => row && typeof row.day === 'string')
    .slice()
    .sort((a, b) => String(a.day).localeCompare(String(b.day)))
  return rows.slice(-90)
}

function usageDashboardTokens(row, includeCache = usageIncludeCache) {
  const total = usageNumber(row.total_tokens) || usageNumber(row.billable_total_tokens)
  return includeCache ? total : Math.max(0, total - usageNumber(row.cached_input_tokens))
}

function usageDashboardKpis(totals, dailyRows, details) {
  const activeDays = dailyRows.filter(usageIsActiveDay).length
  const activeHours = dailyRows.reduce((sum, row) => sum + usageNumber(row.activeHours), 0)
  const cacheRate = window.usageFormat.cacheHitRate(totals)
  const tokenTitle = usageDashboardText(usageIncludeCache ? 'with-cache' : 'without-cache')
  const card = (value, label, detail, button = false) => `<div class="usage-kpi-tile">
    <strong${button ? ' id="usageTotal"' : ''}>${escapeHtml(value)}</strong>
    ${button ? `<button type="button" id="usageIncludeCache" aria-pressed="${usageIncludeCache}">${escapeHtml(label)} <span aria-hidden="true">⌄</span></button>` : `<b>${escapeHtml(label)}</b>`}
    <small>${escapeHtml(detail)}</small>
  </div>`
  return `<div class="usage-kpi-grid" id="usageKpis">
    ${card(details ? usageFull(details.sessionCount) : '—', usageDashboardText('sessions'), details?.sessionCount ? usageDashboardText('session-percentiles', { median: usageCompact(details.median), p90: usageCompact(details.p90) }) : usageDashboardText('no-session-detail'))}
    ${card(usageCompact(usageDashboardTokens(totals)), tokenTitle, usageDashboardText('token-detail', {
      input: usageCompact(usageNumber(totals.input_tokens) + usageNumber(totals.cache_creation_input_tokens)),
      output: usageCompact(totals.output_tokens), cache: usageCompact(totals.cached_input_tokens)
    }), true)}
    ${card(usageCost(totals), usageDashboardText('estimated-cost'), totals.unpricedModels ? usageDashboardText('unpriced-models', { count: totals.unpricedModels }) : usageDashboardText('price-unit'))}
    ${card(usageCompact(totals.cached_input_tokens), usageDashboardText('cache-read'), cacheRate === null ? '—' : usageDashboardText('hit-rate', { rate: usageShare(cacheRate) }))}
    ${card(details?.sessionCount ? usageDuration(details.activeSeconds) : usageDashboardText('hours', { count: usageFull(activeHours) }), usageDashboardText(details?.sessionCount ? 'estimated-active' : 'recorded-hours'), t('config.usage.kpi.active-days', { count: activeDays }))}
    ${card(details ? usageFull(usageProjectFilter ? Number(details.projects.some((item) => item.id === usageProjectFilter)) : details.projectCount) : '—', usageDashboardText('project'), details?.projects?.length && !usageProjectFilter ? details.projects[0].name : usageDashboardText('project-directory'))}
  </div>`
}

function usageDashboardSegments(attribute, values, current, label) {
  return `<div class="usage-segments" role="group" aria-label="${escapeHtml(label)}">${values.map(({ id, text, disabled }) =>
    `<button type="button" ${attribute}="${id}" aria-pressed="${id === current}"${disabled ? ` disabled title="${escapeHtml(usageDashboardText('unavailable'))}"` : ''}>${escapeHtml(text)}</button>`
  ).join('')}</div>`
}

function usageCost(row) {
  if (row.costCny === null || row.costCny === undefined) return usageDashboardText('unpriced')
  const maximumFractionDigits = row.costCny > 0 && row.costCny < 1 ? 6 : 2
  const label = new Intl.NumberFormat(usageIntlLocale(), { minimumFractionDigits: 2, maximumFractionDigits }).format(row.costCny)
  return '¥' + label + (row.unpricedModels ? '+' : '')
}

// A04 (docs/reviews/2026-11-24-windows-product-architecture-review.md): a zero-height bar used
// to stand for four different facts. The state comes from the shared pure helper
// (shared/usage-format.js costState) and every surface - bar, legend, tooltip, table cell and
// the screen-reader label - resolves its copy through usageCostText below.
function usageCostState(row) {
  return window.usageFormat.costState(row)
}

// The filter scope every cost reading shares: the chart, the tooltip and the table must say
// which sources/models/projects a number belongs to, or two different numbers look comparable.
function usageFilterScopeText() {
  const separator = t('config.common.list-separator')
  const parts = []
  if (usageSourceFilter.length) parts.push(usageSourceFilter.map((id) => usageSourceLabel({ source: id })).join(separator))
  else parts.push(t('config.usage.cost.all-sources'))
  if (usageModelFilter) parts.push(usageModelFilter)
  if (usageProjectFilter) parts.push(usageProjectFilter)
  return parts.join(' · ')
}

function usageCostScopeText(summary) {
  return t('config.usage.cost.scope', {
    currency: 'CNY',
    range: usageRangeLabel(summary),
    filters: usageFilterScopeText()
  })
}

// One formatter for the five states. usageCost(row) stays the amount-only formatter used by
// the totals card; anything that shows a DAY uses this.
function usageCostText(row) {
  const state = usageCostState(row)
  const models = usageNumber(row && row.unpricedModels)
  if (state === 'none') return t('config.usage.cost.no-activity')
  if (state === 'unpriced') return models ? t('config.usage.dashboard.unpriced-models', { count: models }) : t('config.usage.dashboard.unpriced')
  if (state === 'partial') return t('config.usage.cost.partial', { amount: usageCost(row), count: models })
  if (state === 'zero') return t('config.usage.cost.zero')
  return usageCost(row)
}

// The legend reuses the same copy, so it can never describe a state the bar does not draw.
function usageCostLegendHtml() {
  return `<div class="usage-cost-legend" role="group" aria-label="${escapeHtml(t('config.usage.cost.legend-title'))}">` +
    `<span class="usage-cost-legend-item"><i class="usage-trend-unknown-mark" aria-hidden="true">?</i>${escapeHtml(t('config.usage.dashboard.unpriced'))}</span>` +
    `<span class="usage-cost-legend-item"><i class="usage-trend-cost-cap" aria-hidden="true"></i>${escapeHtml(t('config.usage.cost.partial-legend'))}</span>` +
    `<span class="usage-cost-legend-item"><i class="usage-trend-cost-zero" aria-hidden="true"></i>${escapeHtml(t('config.usage.cost.zero'))}</span>` +
    `</div>`
}

function usageDuration(seconds) {
  const minutes = Math.floor(usageNumber(seconds) / 60)
  return usageDashboardText('duration', { hours: Math.floor(minutes / 60), minutes: minutes % 60 })
}

function usageDashboardRankings(models, projects) {
  const totals = new Map()
  for (const row of models) {
    if (!usageIsFilterableModel(row.model)) continue
    if (usageModelFilter && row.model !== usageModelFilter) continue
    const entry = totals.get(row.model) || { id: row.model, name: row.model, tokens: 0, costCny: null }
    entry.tokens += usageDashboardTokens(row)
    if (row.costCny !== null && row.costCny !== undefined) entry.costCny = (entry.costCny || 0) + row.costCny
    totals.set(row.model, entry)
  }
  const rank = (rows, dimension, selected) => {
    const sorted = rows.sort((left, right) => right.tokens - left.tokens).slice(0, USAGE_MODEL_LIMIT)
    return sorted.map((row) => {
      const label = escapeHtml(row.name)
      return `<button type="button" class="usage-rank-row" data-usage-${dimension}-rank="${escapeHtml(row.id)}" aria-pressed="${row.id === selected}" title="${label} · ${escapeHtml(usageFull(row.tokens))} Token">
        <span class="usage-rank-name">${label}</span><span class="usage-rank-track" aria-hidden="true"><i style="width:${usageClampPct(100 * row.tokens / (sorted[0].tokens || 1))}%"></i></span>
        <span class="usage-rank-value">${escapeHtml(usageCompact(row.tokens))}</span><span class="usage-rank-cost">${escapeHtml(usageCostText(row))}</span>
      </button>`
    }).join('') || `<p class="usage-section-note">${escapeHtml(t('config.usage.trend.empty'))}</p>`
  }
  const legend = `<span>${escapeHtml(usageDashboardText('rank-unit'))}</span>`
  return `<div class="usage-pair usage-rankings">
    <section class="usage-card usage-panel-project"><div class="usage-card-head"><h2>${escapeHtml(usageDashboardText('project'))}</h2>${legend}</div>
      ${rank(projects.filter((item) => !usageProjectFilter || item.id === usageProjectFilter).map((item) => ({ ...item, tokens: usageDashboardTokens(item) })), 'project', usageProjectFilter)}
    </section>
    <section class="usage-card" id="usageBreakdown"><div class="usage-card-head"><h2>${escapeHtml(usageDashboardText('model'))}</h2>${legend}</div>
      ${rank([...totals.values()], 'model', usageModelFilter)}
    </section>
  </div>`
}

function usageDashboardMetric(row) {
  if (usageTrendMetric === 'output') return usageNumber(row.output_tokens)
  if (usageTrendMetric === 'records') return usageNumber(row.conversation_count)
  if (usageTrendMetric === 'sessions') return usageNumber(row.sessions)
  if (usageTrendMetric === 'cost') return usageNumber(row.costCny)
  if (usageTrendMetric === 'active') return usageNumber(row.activeSeconds) / 60
  return usageDashboardTokens(row)
}

function usageSessionListHtml(details) {
  const needle = usageSessionSearch.trim().toLocaleLowerCase()
  const value = (row) => usageSessionSort === 'cost' ? (row.costCny ?? -1) :
    usageSessionSort === 'active' ? usageNumber(row.activeSeconds) : usageDashboardTokens(row)
  const items = (details?.sessionRanks || []).filter((row) => !needle ||
    [row.title, row.id, row.projectName, ...row.models].some((field) => String(field || '').toLocaleLowerCase().includes(needle)))
    .sort((left, right) => value(right) - value(left) || usageDashboardTokens(right) - usageDashboardTokens(left))
    .slice(0, 100)
  const rows = items.slice(0, usageSessionExpanded ? 100 : 8).map((row) => {
    const meta = [row.projectName, usageSourceLabel(row), ...row.models].filter(Boolean).join(' · ')
    const metric = usageSessionSort === 'cost' ? usageCost(row) : usageSessionSort === 'active' ? usageDuration(row.activeSeconds) : usageCompact(value(row))
    return `<details class="usage-session-row">
      <summary><span><strong>${escapeHtml(row.title || row.id)}</strong><small>${escapeHtml(meta)}</small></span><b>${escapeHtml(metric)}</b></summary>
      <div class="usage-session-detail">
        <span>${escapeHtml(row.id)}</span>
        <span>${escapeHtml([usageDateTime(row.first), usageDateTime(row.last)].filter(Boolean).join(' – '))}</span>
        <span>${escapeHtml(usageDashboardText('token-detail', { input: usageCompact(row.input_tokens), output: usageCompact(row.output_tokens), cache: usageCompact(row.cached_input_tokens) }))}</span>
        <span>${escapeHtml(usageDashboardText('record-count', { count: usageFull(row.records) }))} · ${escapeHtml(usageCostText(row))} · ${escapeHtml(usageDuration(row.activeSeconds))}</span>
      </div>
    </details>`
  }).join('')
  const more = items.length > 8 ? `<button type="button" class="button usage-show-more" id="usageSessionsMore" aria-expanded="${usageSessionExpanded}">${escapeHtml(usageDashboardText(usageSessionExpanded ? 'show-less' : 'sessions-more'))}</button>` : ''
  return (rows || `<p class="usage-section-note">${escapeHtml(usageDashboardText('no-session-detail'))}</p>`) + more
}

function usageSessionsHtml(details) {
  const searchLabel = escapeHtml(usageDashboardText('session-search'))
  const modes = ['token', 'cost', 'active'].map((id) => ({ id, text: usageDashboardText(id) }))
  return `<section class="usage-card usage-panel-top-sessions"><div class="usage-card-head"><h2>${escapeHtml(usageDashboardText('top-sessions'))}</h2>
    ${usageDashboardSegments('data-usage-session-sort', modes, usageSessionSort, usageDashboardText('session-sort'))}
    </div><input id="usageSessionSearch" class="usage-session-search" type="search" aria-label="${searchLabel}" placeholder="${searchLabel}" value="${escapeHtml(usageSessionSearch)}" maxlength="160">
    <div id="usageSessionList">${usageSessionListHtml(details)}</div></section>`
}

function usageActivityHtml(kind, data) {
  const tool = kind === 'tools'
  const top = data?.top || []
  const limit = tool ? 8 : 5
  const expanded = usageExpandedActivity.has(kind)
  const detail = data ? usageDashboardText(tool ? 'tool-count' : 'skill-count', {
    calls: usageFull(data.calls), count: usageFull(tool ? data.sessions : data.count)
  }) : ''
  const rows = top.slice(0, expanded ? 64 : limit).map((row) => `<li class="usage-activity-row">
    <span title="${escapeHtml(row.name)}">${escapeHtml(row.name)}</span>
    <span class="usage-rank-track" aria-hidden="true"><i style="width:${usageClampPct(100 * row.calls / (top[0]?.calls || 1))}%"></i></span>
    <b>${escapeHtml(usageCompact(row.calls))}</b><small>${escapeHtml(usageDashboardText('session-count', { count: usageFull(row.sessions) }))}</small>
  </li>`).join('')
  const categories = (data?.categories || []).map((row) => `<li>${escapeHtml(usageDashboardText('tool-' + row.name))} <b>${escapeHtml(usageCompact(row.calls))}</b></li>`).join('')
  const weeks = data?.weeks || []
  const totals = weeks.map((row) => Object.values(row.calls).reduce((sum, count) => sum + count, 0))
  const topWeek = Math.max(1, ...totals)
  const trend = weeks.length > 1 ? `<figure class="usage-tool-trend"><figcaption>${escapeHtml(usageDashboardText('weekly-trend'))}</figcaption>
    <div>${weeks.map((row, index) => {
      const values = Object.entries(row.calls)
      const label = escapeHtml([row.start, usageFull(totals[index]), ...values.map(([key, count]) => usageDashboardText('tool-' + key) + ' ' + usageFull(count))].join(' · '))
      return `<span role="img" title="${label}" aria-label="${label}" style="height:${usageClampPct(totals[index] / topWeek * 100)}%">${values.map(([category, count]) =>
        `<i data-category="${escapeHtml(category)}" aria-hidden="true" style="flex-grow:${usageNumber(count)}"></i>`
      ).join('')}</span>`
    }).join('')}</div></figure>` : ''
  const more = top.length > limit ? `<button type="button" class="button usage-show-more" data-usage-activity-more="${kind}" aria-expanded="${expanded}">${escapeHtml(usageDashboardText(expanded ? 'show-less' : 'show-more'))}</button>` : ''
  const content = rows ? `<div class="usage-activity-layout"><div><ul class="usage-activity-list">${rows}</ul>${more}</div>
    ${tool && categories ? `<div><ul class="usage-tool-categories">${categories}</ul>${trend}</div>` : ''}</div>` :
    `<p class="usage-section-note">${escapeHtml(usageDashboardText('no-activity-detail'))}</p>`
  return `<section class="usage-card usage-panel-${kind}"><div class="usage-card-head"><h2>${escapeHtml(usageDashboardText(kind))}</h2><span>${escapeHtml(detail)}</span></div>${content}</section>`
}

function usageSavedPrices() {
  return typeof settings !== 'undefined' && Array.isArray(settings?.usage?.prices) ? settings.usage.prices : []
}

// ---------------------------------------------------------------------------
// B07 price versions: one row per (model, effective day)
// ---------------------------------------------------------------------------

function usagePriceUid() {
  usagePriceRowSeq += 1
  return `p${usagePriceRowSeq}`
}

function usagePriceSavedRows() {
  const rows = []
  for (const row of usageSavedPrices()) {
    if (!row || typeof row.model !== 'string' || !row.model.trim()) continue
    rows.push({
      uid: usagePriceUid(),
      model: row.model,
      effectiveFrom: typeof row.effectiveFrom === 'string' ? row.effectiveFrom : '',
      input: Number.isFinite(row.input) ? row.input : '',
      cached: Number.isFinite(row.cached) ? row.cached : '',
      cachedWrite: Number.isFinite(row.cachedWrite) ? row.cachedWrite : '',
      output: Number.isFinite(row.output) ? row.output : ''
    })
  }
  return rows
}

// The rows the table renders: the in-progress editor snapshot when there is one,
// otherwise the saved price versions. Rows carry a render-only uid, never a
// model+date key, so editing the effective date cannot orphan a draft.
function usagePriceRows() {
  if (usagePriceEditor) return usagePriceEditor.rows
  return usagePriceSavedRows()
}

// Snapshot of what is on screen, used before any mutation (edit/add/save) so the
// editor state is complete instead of delta-based.
function usageCapturePriceRows() {
  const rows = []
  for (const rowElement of view.querySelectorAll('[data-usage-price-row]')) {
    const read = (field) => {
      const input = rowElement.querySelector(`[data-usage-price-field="${field}"]`)
      return input ? input.value : ''
    }
    rows.push({
      uid: rowElement.dataset.usagePriceRow,
      model: rowElement.dataset.usagePriceModel,
      effectiveFrom: read('effectiveFrom'),
      input: read('input'),
      cached: read('cached'),
      cachedWrite: read('cachedWrite'),
      output: read('output')
    })
  }
  return rows
}

function usagePricingHtml(models, open) {
  const names = new Set()
  for (const row of usagePriceRows()) names.add(row.model)
  for (const model of models) if (usageIsFilterableModel(model.model)) names.add(model.model)
  const sorted = [...names].slice(0, 200).sort()
  const rows = usagePriceRows()
  const fields = [
    ['input', 'input-no-cache'],
    ['cached', 'cache-read'],
    ['cachedWrite', 'price-cached-write'],
    ['output', 'output']
  ]
  const versionsByModel = new Map(sorted.map((name) => [name, rows.filter((row) => row.model === name)]))
  let body = ''
  for (const name of sorted) {
    const versions = versionsByModel.get(name)
    const list = versions.length > 0
      ? versions.sort((left, right) => (left.effectiveFrom || '').localeCompare(right.effectiveFrom || ''))
      : [{ uid: `blank-${usagePriceUid()}`, model: name, effectiveFrom: '', input: '', cached: '', cachedWrite: '', output: '' }]
    list.forEach((row, index) => {
      const modelCell = index === 0
        ? `<th scope="row" rowspan="${list.length}"><span class="usage-price-model">${escapeHtml(name)}</span>
            <button type="button" class="button usage-price-add" data-usage-price-add="${escapeHtml(name)}">${escapeHtml(usageDashboardText('price-add-version'))}</button></th>`
        : ''
      const fieldCells = fields.map(([key, title]) => `<td><input type="number" min="0" max="1000000" step="any" data-usage-price-field="${key}" value="${escapeHtml(String(row[key] ?? ''))}" aria-label="${escapeHtml(name + ' · ' + usageDashboardText(title))}"></td>`).join('')
      const effectiveTitle = usageDashboardText(row.effectiveFrom ? 'price-effective' : 'price-always')
      body += `<tr data-usage-price-row="${escapeHtml(row.uid)}" data-usage-price-model="${escapeHtml(name)}">${modelCell}
        <td><input type="date" data-usage-price-field="effectiveFrom" value="${escapeHtml(row.effectiveFrom || '')}" aria-label="${escapeHtml(name + ' · ' + usageDashboardText('price-effective'))}" title="${escapeHtml(effectiveTitle)}"></td>
        ${fieldCells}</tr>`
    })
  }
  const table = sorted.length > 0 ? `<div class="usage-table-wrap"><table class="usage-table"><thead><tr><th>${escapeHtml(usageDashboardText('model'))}</th>
    <th>${escapeHtml(usageDashboardText('price-effective'))}</th>
    ${fields.map(([, title]) => `<th>${escapeHtml(usageDashboardText(title))}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>
    <p class="usage-section-note">${escapeHtml(usageDashboardText('price-cached-write-help'))} ${escapeHtml(usageDashboardText('price-version-help'))}</p>
    <button class="button" id="saveUsagePrices" type="button">${escapeHtml(usageDashboardText('price-save'))}</button>` : ''
  return `<details class="usage-dashboard-settings" id="usagePricing"${open ? ' open' : ''}><summary>${escapeHtml(usageDashboardText('pricing'))}<span>${escapeHtml(usageDashboardText('price-unit'))}</span></summary>
    <p class="usage-section-note">${escapeHtml(usageDashboardText(sorted.length > 0 ? 'price-help' : 'price-no-models'))}</p>${table}</details>`
}

// ---------------------------------------------------------------------------
// B07 report exchange: CSV/JSON export and aggregate-snapshot import
// ---------------------------------------------------------------------------

// The feature reports which exchange channels this build registered (a build
// whose IPC policy does not list them yet reports false), so the buttons are
// disabled instead of failing only after a click.
function usageExchangeState(status) {
  const value = status && typeof status === 'object' ? status.exchange : null
  return {
    export: usageHasApi('usageExport') && value?.export !== false,
    import: usageHasApi('usageImport') && value?.import !== false
  }
}

function usageExchangeButtonsHtml(status) {
  const state = usageExchangeState(status)
  const exportDisabled = state.export ? '' : ' disabled title="' + escapeHtml(usageDashboardText('export-unavailable')) + '"'
  const importDisabled = state.import ? '' : ' disabled title="' + escapeHtml(usageDashboardText('export-unavailable')) + '"'
  const button = (format) => `<button class="button" type="button" data-usage-export="${format}"${exportDisabled}>${escapeHtml(t(`config.usage.dashboard.export-${format}`))}</button>`
  return `<div class="usage-export-actions" role="group" aria-label="${escapeHtml(usageDashboardText('export-group'))}">
    ${button('csv')}${button('json')}
    <button class="button" type="button" data-usage-import${importDisabled}>${escapeHtml(usageDashboardText('import'))}</button>
    <input type="file" accept="application/json,.json" data-usage-import-file hidden>
  </div>`
}

function usageSnapshotSources(sources) {
  return (Array.isArray(sources) ? sources : []).map((source) => usageSourceLabel({ source })).join(t('config.common.list-separator'))
}

function usageImportPreviewHtml() {
  const preview = usageImportPreviewData
  if (!preview) return ''
  const text = t('config.usage.dashboard.import-preview', {
    sources: usageSnapshotSources(preview.sources),
    from: preview.from,
    to: preview.to,
    rows: usageNumber(preview.days),
    tokens: usageCompact(preview.totals?.total)
  })
  const note = preview.duplicate
    ? usageDashboardText('import-duplicate')
    : (!preview.mergeable ? usageDashboardText('import-overlap') : '')
  const confirm = !preview.duplicate && preview.mergeable
    ? `<button class="button primary" type="button" data-usage-import-confirm>${escapeHtml(usageDashboardText('import-confirm'))}</button>`
    : ''
  return `<div class="usage-import-preview" role="status">
    <b>${escapeHtml(usageDashboardText('import-title'))}</b>
    <span>${escapeHtml(text)}</span>
    ${note ? `<em class="usage-import-note">${escapeHtml(note)}</em>` : ''}
    <span class="usage-import-actions">${confirm}<button class="button" type="button" data-usage-import-cancel>${escapeHtml(usageDashboardText('import-cancel'))}</button></span>
  </div>`
}

function usageSnapshotsHtml(status) {
  const items = Array.isArray(status?.snapshots) ? status.snapshots : []
  const rows = items.map((item) => `<li class="usage-snapshot-row" data-usage-snapshot="${escapeHtml(item.id)}">
    <span class="usage-snapshot-range">${escapeHtml(t('config.usage.dashboard.snapshot-row', {
      sources: usageSnapshotSources(item.sources),
      from: item.from,
      to: item.to,
      rows: usageNumber(item.days),
      tokens: usageCompact(item.totalTokens)
    }))}</span>
    <small class="usage-snapshot-meta">${escapeHtml([usageDateTime(item.importedAt), item.priceVersion || ''].filter(Boolean).join(' · '))}</small>
  </li>`).join('')
  return `<section class="usage-card usage-snapshots" id="usageSnapshots">
    <div class="usage-card-head"><h2>${escapeHtml(usageDashboardText('snapshots'))}</h2><span>${escapeHtml(usageDashboardText('snapshots-note'))}</span></div>
    ${rows ? `<ul class="usage-snapshot-list">${rows}</ul>` : `<p class="usage-section-note">${escapeHtml(usageDashboardText('snapshot-empty'))}</p>`}
    <div id="usageImportPreview">${usageImportPreviewHtml()}</div>
  </section>`
}

function usageTrendSegments(row) {
  const input = usageNumber(row && row.input_tokens) + usageNumber(row && row.cache_creation_input_tokens)
  const cache = usageNumber(row && row.cached_input_tokens)
  const output = usageNumber(row && row.output_tokens)
  const stackSum = input + cache + output
  const total = usageNumber(row && row.billable_total_tokens) || stackSum
  return { input, cache, output, stackSum, total }
}


function usageTrendTooltipHtml(row, summary = null) {
  if (usageTrendMetric !== 'token' || !usageIncludeCache) {
    const metric = usageDashboardText(({ token: 'without-cache', active: 'estimated-active' })[usageTrendMetric] || usageTrendMetric)
    const value = usageTrendMetric === 'cost' ? usageCostText(row) : usageTrendMetric === 'active' ? usageDuration(row.activeSeconds) : usageFull(usageDashboardMetric(row))
    const date = usageDayLabel(row.day)
    const scope = usageTrendMetric === 'cost' ? ` · ${usageCostScopeText(summary)}` : ''
    return { label: `${date} · ${metric}: ${value}${scope}`, html: `<b class="usage-tooltip-date">${escapeHtml(date)}</b><span>${escapeHtml(metric)}: ${escapeHtml(value)}</span>` }
  }
  const segments = usageTrendSegments(row)
  const total = usageDashboardTokens(row)
  const values = { input: segments.input, cache: segments.cache, output: segments.output }
  const lines = USAGE_TREND_SEGMENTS.map((segment) => {
    const value = values[segment.id]
    const pct = total > 0 ? (value / total) * 100 : 0
    return { label: t(segment.labelKey), value, pct, dotClass: segment.dotClass }
  })
  const html = `<b class="usage-tooltip-date">${escapeHtml(usageDayLabel(row.day))}</b>${lines.map((line) => `<span class="usage-tooltip-line"><i class="usage-trend-dot ${line.dotClass}" aria-hidden="true"></i><span class="usage-tooltip-label">${escapeHtml(line.label)}</span><b class="usage-tooltip-value">${escapeHtml(usageFull(line.value))}</b><em class="usage-tooltip-pct">${usageShare(line.pct)}</em></span>`).join('')}<span class="usage-tooltip-line usage-tooltip-total"><span class="usage-tooltip-label">${t('config.usage.trend.total')}</span><b class="usage-tooltip-value">${escapeHtml(usageFull(total))}</b><em class="usage-tooltip-pct">100%</em></span>`
  const label = `${row.day}; ${lines.map((line) => `${line.label} ${usageFull(line.value)} (${usageShare(line.pct)})`).join('; ')}; ${t('config.usage.trend.total')} ${usageFull(total)}`
  return { html, label }
}

function usageTrendHtml(daily) {
  const rows = usageTrendRows(daily)
  const metrics = usageDashboardSegments('data-usage-metric', USAGE_TREND_METRICS.map((id) => ({
    id, text: usageDashboardText(id)
  })), usageTrendMetric, usageDashboardText('trend-metric'))
  const maxTotal = rows.reduce((max, row) => Math.max(max, usageDashboardMetric(row)), 0)
  let chart = `<div class="usage-empty-text">${t('config.usage.trend.empty')}</div>`
  let axis = ''
  if (rows.length > 0) {
    const columns = rows.map((row) => {
      const value = usageDashboardMetric(row)
      const barHeight = maxTotal > 0 ? (value / maxTotal) * 100 : 0
      const tooltip = usageTrendTooltipHtml(row, daily)
      const cacheShare = usageTrendMetric === 'token' && usageIncludeCache && value > 0 ? usageClampPct(100 * usageNumber(row.cached_input_tokens) / value) : 0
      // A04: an unknown day is drawn as an explicit marker, never as a zero-cost bar; a
      // partial day keeps its known subtotal and carries a cap; a real zero keeps a tick.
      const costState = usageTrendMetric === 'cost' ? usageCostState(row) : ''
      let stack
      if (costState === 'unpriced') {
        stack = `<div class="usage-trend-stack usage-trend-stack-state" style="height:16%"><i class="usage-trend-unknown-mark" aria-hidden="true">?</i></div>`
      } else if (costState === 'zero') {
        stack = `<div class="usage-trend-stack usage-trend-stack-state" style="height:0"><i class="usage-trend-cost-zero" aria-hidden="true"></i></div>`
      } else {
        stack = `<div class="usage-trend-stack" style="height:${barHeight}%">${costState === 'partial' ? '<i class="usage-trend-cost-cap" aria-hidden="true"></i>' : ''}
        <i class="usage-trend-seg usage-trend-cache" style="height:${cacheShare}%"></i>
        <i class="usage-trend-seg usage-trend-input" style="height:${100 - cacheShare}%"></i>
      </div>`
      }
      return `<div class="usage-trend-col${costState ? ' usage-trend-col-cost' : ''}" tabindex="-1" role="gridcell" data-usage-day="${escapeHtml(row.day)}"${costState ? ` data-cost-state="${costState}"` : ''} aria-label="${escapeHtml(tooltip.label)}">${stack}</div>`
    }).join('')
    chart = `<div class="usage-trend-chart" role="grid" aria-labelledby="usageTrendTitle">
      <div class="usage-trend-bars${rows.length === 1 ? ' is-single' : ''}" data-usage-trend role="row">
        ${columns}
        <div class="usage-tooltip usage-trend-tooltip" data-usage-tooltip aria-hidden="true" hidden></div>
      </div>
    </div>`
    const ticks = rows.length <= 7 ? rows.map((_, index) => index) : [0, .25, .5, .75, 1].map((ratio) => Math.round(ratio * (rows.length - 1)))
    const formatter = new Intl.DateTimeFormat(usageIntlLocale(), { month: 'short', day: 'numeric', timeZone: 'UTC' })
    axis = `<div class="usage-overview-axis" aria-hidden="true">${ticks.map((index, tick) =>
      `<span class="${tick === 0 || tick === ticks.length - 1 ? 'usage-axis-edge' : ''}" style="--tick:${(index + .5) / rows.length * 100}%">${escapeHtml(formatter.format(new Date(`${rows[index].day}T00:00:00Z`)))}</span>`
    ).join('')}</div>`
  }
  return `<section class="usage-card usage-trend" id="usageTrend">
    <div class="usage-card-head">
      <h2 id="usageTrendTitle">${escapeHtml(usageDashboardText('daily-trend'))}</h2>
      ${metrics}
      <span class="usage-card-meta">${escapeHtml(usageTrendMetric === 'cost' ? usageCost({ costCny: rows.some((row) => row.costCny != null) ? maxTotal : null }) : usageTrendMetric === 'active' ? usageDuration(maxTotal * 60) : usageCompact(maxTotal))}</span>
    </div>
    ${chart}
    ${axis}
    ${usageTrendMetric === 'cost' ? usageCostLegendHtml() + `<p class="usage-section-note usage-cost-scope">${escapeHtml(usageCostScopeText(daily))}</p>` : ''}
    <button class="usage-trend-expand" type="button" data-usage-trend-expand aria-label="${escapeHtml(t('config.usage.trend.expand'))}" title="${escapeHtml(t('config.usage.trend.expand'))}">${typeof iconMarkup === 'function' ? iconMarkup('icons/fullscreen.svg') : ''}</button>
  </section>`
}

// ---------------------------------------------------------------------------
// Daily detail table (sticky header, sortable date, compact rows)
// ---------------------------------------------------------------------------

function usageTableCell(value, blank = false) {
  if (blank || value === null || value === undefined || value === '') return '<td class="num">—</td>'
  const number = usageNumber(value)
  const text = escapeHtml(usageFull(number))
  return `<td class="num" title="${text}">${text}</td>`
}

// Cache hit rate cell: the share of the day's prompt tokens that the provider
// already had cached (definition in shared/usage-format.js). A day with no
// prompt at all is blank like the other columns rather than a misleading 0%;
// the title carries all three counters behind the percentage (read / write /
// prompt), because the row itself cannot show cache writes — without the write
// term a write-heavy day would look like the row's numbers do not add up.
function usageCacheHitCell(row, blank = false) {
  const rate = window.usageFormat.cacheHitRate(row)
  if (blank || rate === null) return '<td class="num">—</td>'
  const title = t('config.usage.table.cache-hit-detail', {
    read: usageFull(usageNumber(row && row.cached_input_tokens)),
    write: usageFull(usageNumber(row && row.cache_creation_input_tokens)),
    prompt: usageFull(window.usageFormat.promptTokens(row))
  })
  return `<td class="num" title="${escapeHtml(title)}">${escapeHtml(usageShare(rate))}</td>`
}

function usageSortDailyRows(rows, direction) {
  const sorted = rows
    .filter((row) => row && typeof row.day === 'string')
    .slice()
    .sort((a, b) => String(a.day).localeCompare(String(b.day)))
  return direction === 'asc' ? sorted : sorted.reverse()
}

function usageDailyRowsHtml(rows, direction) {
  const sorted = usageSortDailyRows(rows, direction)
  if (sorted.length === 0) {
    return `<tr><td class="usage-table-empty" colspan="8">${t('config.usage.table.empty')}</td></tr>`
  }
  return sorted.map((row) => {
    // A fully empty day (no tokens and no conversations) reads as "—" like TT's
    // table instead of a wall of zeros.
    const empty = usageDashboardTokens(row, true) === 0 && usageNumber(row.conversation_count) === 0
    return `<tr data-usage-day="${escapeHtml(row.day)}"${empty ? ' class="is-empty"' : ''}>
        <td class="usage-date">${escapeHtml(row.day)}</td>
        ${usageTableCell(usageDashboardTokens(row), empty)}
        ${usageTableCell(usageNumber(row.input_tokens) + usageNumber(row.cache_creation_input_tokens), empty)}
        ${usageTableCell(row.output_tokens, empty)}
        ${usageTableCell(row.cached_input_tokens, empty)}
        ${usageCacheHitCell(row, empty)}
        ${usageTableCell(row.sessions, empty)}
        <td class="num">${escapeHtml(empty ? '—' : usageCostText(row))}</td>
      </tr>`
  }).join('')
}

function usageDailyTableHtml(rows) {
  const sortedCount = usageSortDailyRows(rows, usageDailySort).length
  const sortState = usageDailySort === 'desc' ? 'descending' : 'ascending'
  const arrow = usageDailySort === 'desc' ? '↓' : '↑'
  const head = [
    ['config.usage.table.date', ''],
    [`config.usage.dashboard.${usageIncludeCache ? 'total-with-cache' : 'total-without-cache'}`, 'num'],
    ['config.usage.dashboard.input-no-cache', 'num'],
    ['config.usage.table.output', 'num'],
    ['config.usage.table.cache-read', 'num'],
    ['config.usage.table.cache-hit', 'num'],
    ['config.usage.dashboard.sessions', 'num'],
    ['config.usage.dashboard.estimated-cost', 'num']
  ].map(([key, className], index) => {
    if (index === 0) {
      return `<th scope="col" class="${className}" aria-sort="${sortState}"><button class="usage-sort-button" type="button" data-usage-sort="date" aria-label="${escapeHtml(t('config.usage.table.sort'))}">${t(key)}<i class="usage-sort-arrow" aria-hidden="true">${arrow}</i></button></th>`
    }
    return `<th scope="col" class="${className}">${t(key)}</th>`
  }).join('')
  return `<section class="usage-card usage-daily">
    <div class="usage-card-head">
      <h2>${t('config.usage.table.title')}</h2>
      <span>${t('config.usage.kpi.active-days', { count: sortedCount })}</span>
    </div>
    <div class="usage-table-wrap" tabindex="0" role="region" aria-label="${escapeHtml(t('config.usage.table.title'))}">
      <table class="usage-table" id="usageDailyTable">
        <thead><tr>${head}</tr></thead>
        <tbody data-usage-daily-body>${usageDailyRowsHtml(rows, usageDailySort)}</tbody>
      </table>
    </div>
  </section>`
}

// ---------------------------------------------------------------------------
// Activity heatmap (52 weeks x 7, Monday first, rich tooltip)
// ---------------------------------------------------------------------------

function usageHeatmapLabel(cell) {
  return [
    usageDayLabel(cell.day),
    t('config.usage.heatmap.level', { level: cell.level }),
    `${usageFull(cell.value)} ${t('config.usage.heatmap.token-unit')}`,
    t('config.usage.heatmap.conversations-footer', { count: cell.conversation_count })
  ].join(' · ')
}

function usageHeatmapCellHtml(cell) {
  if (!cell) return '<span class="usage-heat-cell is-empty" role="gridcell" aria-hidden="true"></span>'
  const levelClass = window.usageFormat.heatmapLevelClass(cell.level)
  return `<span class="usage-heat-cell ${levelClass}" tabindex="-1" role="gridcell" data-usage-heat-day="${escapeHtml(cell.day)}" data-usage-heat-level="${cell.level}" aria-label="${escapeHtml(usageHeatmapLabel(cell))}"></span>`
}

function usageHeatMonthLabel(monthKey, includeYear) {
  const parts = String(monthKey || '').split('-')
  const year = Number(parts[0])
  const month = Number(parts[1])
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) return String(monthKey || '')
  try {
    return new Intl.DateTimeFormat(usageIntlLocale(), includeYear ? { year: 'numeric', month: 'short' } : { month: 'short' })
      .format(new Date(year, month - 1, 1))
  } catch {
    return String(monthKey || '')
  }
}

// Rich hover card: date + level pill -> large daily total (+ conversations) ->
// model split rows (top 5, 2px bars) -> an overflow line when more models exist.
// Everything is clamped inside the heatmap card so nothing clips.
const USAGE_HEAT_TIP_MODEL_LIMIT = 5

function usageHeatTipHtml(cell) {
  const levelClass = window.usageFormat.heatmapLevelClass(cell.level)
  const visibleModels = cell.models.slice(0, USAGE_HEAT_TIP_MODEL_LIMIT)
  const hiddenModels = Math.max(0, cell.models.length - visibleModels.length) + cell.moreModels
  const modelRows = visibleModels.length > 0
    ? `<div class="usage-heat-tip-divider"></div>
      <div class="usage-heat-tip-section">${t('config.usage.heatmap.model-breakdown')}</div>
      <div class="usage-heat-tip-models">${visibleModels.map((model) => {
        const width = usageClampPct(model.sharePct)
        return `<div class="usage-heat-tip-model">
          <div class="usage-heat-tip-model-line">
            <span class="usage-heat-tip-model-name" title="${escapeHtml(model.model)}">${escapeHtml(model.model)}</span>
            <b class="usage-heat-tip-model-value" title="${escapeHtml(usageFull(model.tokens))}">${escapeHtml(usageCompact(model.tokens))}</b>
            <span class="usage-heat-tip-model-pct">${usageShare(model.sharePct)}</span>
          </div>
          <div class="usage-heat-tip-model-bar" aria-hidden="true"><i style="width:${width.toFixed(2)}%"></i></div>
        </div>`
      }).join('')}</div>`
    : ''
  const overflow = hiddenModels > 0
    ? `<div class="usage-heat-tip-more">${escapeHtml(t('config.usage.heatmap.more-models', { count: hiddenModels }))}</div>`
    : ''
  const conversations = cell.conversation_count > 0
    ? `<em class="usage-heat-tip-conversations">${escapeHtml(t('config.usage.heatmap.conversations-footer', { count: cell.conversation_count }))}</em>`
    : ''
  return `<div class="usage-heat-tip-head">
      <span class="usage-heat-tip-date">${escapeHtml(usageDayLabel(cell.day))}</span>
      <span class="usage-heat-tip-level ${levelClass}">${escapeHtml(t('config.usage.heatmap.level', { level: cell.level }))}</span>
    </div>
    <div class="usage-heat-tip-total" title="${escapeHtml(usageFull(cell.value))}">
      <b>${escapeHtml(usageCompact(cell.value))}</b><span>${t('config.usage.heatmap.token-unit')}</span>${conversations}
    </div>
    ${modelRows}
    ${overflow}
    <i class="usage-heat-tip-arrow" aria-hidden="true"></i>`
}

// The card is conditional on the channel, not on the data: a build without
// usage:heatmap hides it entirely, while an available channel with no activity
// still shows the empty card (the feature exists, there is just nothing yet).
function usageHeatmapHtml(heatmap, timezoneLabel) {
  if (!usageHasOptionalApi('usageHeatmap')) return ''
  if (!heatmap) return ''
  const model = window.usageFormat.layoutHeatmapWeeks(heatmap.weeks)
  const head = usageDashboardHeatHead(timezoneLabel)
  if (model.columns.length === 0) {
    return `<section class="usage-card usage-heatmap" id="usageHeatmap">${head}<div class="usage-empty-text">${t('config.usage.heatmap.empty')}</div></section>`
  }
  const ticks = window.usageFormat.heatmapMonthTicks(model.months, model.columns.length, USAGE_HEATMAP_TICK_MIN_SPAN)
    // The grid can start mid-month, leaving the first month with a single week
    // column; a year label cannot fit there and would overlap the next month.
    // Drop only that partial first tick, then put the year on the first label
    // that is actually rendered (plus every January).
    .filter((tick) => tick.span >= 2)
  const monthLabels = ticks.map((tick, index) => {
    const label = usageHeatMonthLabel(tick.month, index === 0 || tick.month.endsWith('-01'))
    return `<span style="grid-column:${tick.index + 1} / span ${tick.span}">${escapeHtml(label)}</span>`
  }).join('')
  const weekdayLabels = USAGE_WEEKDAY_KEYS.map((key) => `<span>${t(key)}</span>`).join('')
  const rows = USAGE_WEEKDAY_KEYS.map((_, weekday) =>
    `<div class="usage-heat-row" role="row">${model.columns.map((column) => usageHeatmapCellHtml(column[weekday])).join('')}</div>`
  ).join('')
  const legend = ['0', '1', '2', '3', '4'].map((level) => `<i class="usage-heat-swatch level-${level}" aria-hidden="true"></i>`).join('')
  return `<section class="usage-card usage-heatmap" id="usageHeatmap">
    ${head}
    <div class="usage-heat-body">
      <div class="usage-heat-chart" data-usage-heatmap>
        <div class="usage-heat-weekdays" aria-hidden="true">${weekdayLabels}</div>
        <div class="usage-heat-scroll" data-usage-heatmap-scroll>
          <div class="usage-heat-canvas" style="--usage-heat-weeks:${model.columns.length}">
            <div class="usage-heat-months" style="grid-template-columns:repeat(${model.columns.length},var(--usage-heat-cell))">${monthLabels}</div>
            <div class="usage-heat-grid" role="grid" aria-labelledby="usageHeatmapTitle">${rows}</div>
          </div>
        </div>
        <div class="usage-heat-tip" data-usage-heatmap-tooltip hidden></div>
      </div>
    </div>
    <div class="usage-heat-foot" title="${escapeHtml(usageDashboardText('with-cache'))}">
      <button class="usage-heat-arrow" type="button" data-usage-heat-scroll="-1" aria-label="${escapeHtml(t('config.usage.heatmap.scroll-left'))}">‹</button>
      <span class="usage-heat-total-label">${escapeHtml(usageDashboardText('with-cache'))}</span>
      <div class="usage-heat-legend"><span>${t('config.usage.heatmap.less')}</span>${legend}<span>${t('config.usage.heatmap.more')}</span></div>
      <button class="usage-heat-arrow" type="button" data-usage-heat-scroll="1" aria-label="${escapeHtml(t('config.usage.heatmap.scroll-right'))}">›</button>
    </div>
  </section>`
}

function usageDashboardHeatHead(timezone) {
  const modes = [
    { id: 'hourly', text: usageDashboardText('hourly') },
    { id: 'yearly', text: usageDashboardText('yearly'), disabled: !usageHasOptionalApi('usageHeatmap') }
  ]
  return `<div class="usage-card-head usage-heat-head"><h2 id="usageHeatmapTitle">${escapeHtml(usageDashboardText('heatmap'))}</h2>
    ${usageDashboardSegments('data-usage-heat-view', modes, usageHeatView, usageDashboardText('heatmap'))}
    <span class="usage-card-meta">${escapeHtml(timezone)}</span>
  </div>`
}

function usageDashboardHeatmap(daily, heatmap, timezone) {
  if (usageHeatView === 'yearly' && heatmap) return usageHeatmapHtml(heatmap, timezone)
  const head = usageDashboardHeatHead(timezone)
  if (usageHeatView === 'yearly' || !Array.isArray(daily.weekdayHours)) {
    return `<section class="usage-card usage-heatmap">${head}<p class="usage-section-note">${escapeHtml(usageDashboardText('unavailable'))}</p></section>`
  }
  const hourly = daily.weekdayHours.map((cell) => usageNumber(usageIncludeCache ? cell.total : cell.withoutCache))
  const max = Math.max(0, ...hourly)
  const clock = (index) => `${String(index % 24).padStart(2, '0')}:00`
  const formatter = new Intl.DateTimeFormat(usageIntlLocale(), { weekday: 'short', timeZone: 'UTC' })
  const weekdays = USAGE_WEEKDAY_KEYS.map((_, index) => formatter.format(new Date(Date.UTC(2024, 0, index + 1))))
  const hottest = hourly.indexOf(max)
  const cells = weekdays.map((weekday, row) => `<span class="usage-hour-label" aria-hidden="true">${escapeHtml(weekday)}</span>${hourly.slice(row * 24, (row + 1) * 24).map((value, column) => {
    const index = row * 24 + column
    const level = value > 0 ? Math.max(1, Math.min(4, Math.ceil(4 * Math.sqrt(value / max)))) : 0
    const label = escapeHtml(`${weekday} ${clock(index)} · ${timezone} · ${usageFull(value)} Token`)
    return `<span class="usage-hour-cell level-${level}" role="img" data-usage-hour-cell="${index}" tabindex="${index === hottest ? 0 : -1}" aria-label="${label}" title="${label}"></span>`
  }).join('')}`).join('')
  const legend = [0, 1, 2, 3, 4].map((level) => `<i class="usage-heat-swatch level-${level}" aria-hidden="true"></i>`).join('')
  const peak = max > 0 ? usageDashboardText('busiest', { slot: `${weekdays[Math.floor(hottest / 24)]} ${clock(hottest)}` }) : t('config.usage.trend.empty')
  return `<section class="usage-card usage-heatmap" id="usageHeatmap">
    ${head}
    <div class="usage-hour-grid" role="group" aria-label="${escapeHtml(usageDashboardText('hour-grid'))}">${cells}</div>
    <div class="usage-heat-foot usage-hour-foot"><span>${escapeHtml(peak)}</span>
      <span class="usage-heat-legend">${escapeHtml(t('config.usage.heatmap.less'))}${legend}${escapeHtml(t('config.usage.heatmap.more'))}</span>
    </div>
  </section>`
}

// ---------------------------------------------------------------------------
// Page state resolution + banner
// ---------------------------------------------------------------------------

function usageResolvePageState(status, totals) {
  const sources = status && Array.isArray(status.sources) ? status.sources : []
  const present = USAGE_SUPPORTED_SOURCES
    .map((id) => sources.find((source) => source && source.source === id))
    .filter(Boolean)
  const billable = usageNumber(totals && totals.billable_total_tokens)
  if (present.length === 0) {
    return sources.some((source) => source && source.state === 'unsupported') ? 'unsupported' : 'absent'
  }
  const states = present.map((source) => usageSourceStateKey(source.state))
  if (states.every((state) => state === 'absent')) return 'absent'
  if (states.some((state) => state === 'error') && billable === 0) return 'error'
  if (states.every((state) => state === 'unreadable')) return 'unreadable'
  if (status && status.scanning === true && billable === 0) return 'scanning'
  if (billable === 0) return 'empty'
  return 'ok'
}

function usageStateBannerHtml(state) {
  const copy = USAGE_STATE_COPY[state]
  if (!copy) return ''
  const action = state === 'scanning'
    ? ''
    : `<button class="button" type="button" data-usage-refresh>${t('config.usage.refresh')}</button>`
  return `<div class="usage-banner usage-banner-${state}" role="status">
    <div class="usage-banner-copy">
      <b>${t(copy.title)}</b>
      <p>${t(copy.body)}</p>
    </div>
    ${action}
  </div>`
}

// ---------------------------------------------------------------------------
// Trend detail modal (v6)
// ---------------------------------------------------------------------------

const USAGE_MODAL_GRANULARITIES = [
  { id: '30m', labelKey: 'config.usage.trend.granularity-30m' },
  { id: 'day', labelKey: 'config.usage.trend.granularity-day' },
  { id: 'month', labelKey: 'config.usage.trend.granularity-month' }
]

function usageModalRangeLabel(summary) {
  const from = summary && summary.from ? String(summary.from) : ''
  const to = summary && summary.to ? String(summary.to) : ''
  if (from && to) return `${from} → ${to}`
  return usageRangeLabel(summary)
}

function usageModalActiveDays(payload) {
  const summary = payload && payload.summary && typeof payload.summary === 'object' ? payload.summary : {}
  const rolling = summary.rolling && typeof summary.rolling === 'object' ? summary.rolling : {}
  const rows = usageTrendRows(payload?.daily)
  const stats = window.usageFormat.summarizeTrendRows(rows)
  // The modal range is the trend window, so its active-day count comes from the
  // same rows (heatmap.activeDays spans 52 weeks and would contradict the range).
  return stats.activeDays || usageNumber(rolling.activeDays) || 0
}

// One short, data-derived sentence for the left insight panel. Peak vs average
// picks the template; all numbers are localized by the route before insertion.
function usageModalInsightText(payload) {
  const rows = usageTrendRows(payload?.daily)
  const stats = window.usageFormat.summarizeTrendRows(rows)
  const activeDays = usageModalActiveDays(payload) || stats.activeDays
  const avg = stats.avgPerActiveDay
  const peakRatio = avg > 0 ? stats.peakValue / avg : 0
  if (stats.peakDay && peakRatio >= 2) {
    return t('config.usage.trend.insight-peak', {
      date: usageDayLabel(stats.peakDay),
      value: usageCompact(stats.peakValue),
      activeDays,
      avg: usageCompact(avg)
    })
  }
  return t('config.usage.trend.insight-steady', {
    days: stats.dayCount,
    activeDays,
    avg: usageCompact(avg)
  })
}

function usageModalSideHtml(payload, timezoneLabel) {
  const summary = payload.summary && typeof payload.summary === 'object' ? payload.summary : {}
  const totals = summary.totals && typeof summary.totals === 'object' ? summary.totals : {}
  const rows = usageTrendRows(payload.daily)
  const stats = window.usageFormat.summarizeTrendRows(rows)
  const activeDays = usageModalActiveDays(payload) || stats.activeDays
  const battery = [
    {
      label: t('config.usage.trend.stat-total'),
      value: usageCompact(totals.billable_total_tokens),
      title: usageFull(totals.billable_total_tokens)
    },
    {
      label: t('config.usage.trend.stat-conversations'),
      value: usageFull(totals.conversation_count),
      title: usageFull(totals.conversation_count)
    },
    {
      label: t('config.usage.trend.stat-peak'),
      value: usageCompact(stats.peakValue),
      title: usageFull(stats.peakValue),
      sub: stats.peakDay ? usageDayLabel(stats.peakDay) : '—'
    },
    {
      label: t('config.usage.trend.stat-active-days'),
      value: t('config.usage.trend.active-days-value', { count: activeDays })
    }
  ]
  const cells = battery.map((item) => `<div class="usage-modal-stat">
    <span>${escapeHtml(item.label)}</span>
    <b title="${escapeHtml(item.title || '')}">${escapeHtml(item.value)}</b>
    ${item.sub ? `<small>${escapeHtml(item.sub)}</small>` : ''}
  </div>`).join('')
  return `<aside class="usage-modal-side">
    <span class="usage-modal-eyebrow"><i class="usage-modal-eyebrow-dot" aria-hidden="true"></i>${t('config.usage.trend.modal-eyebrow')}</span>
    <h2 class="usage-modal-title" id="usageTrendModalTitle">${t('config.usage.trend.title')}</h2>
    <p class="usage-modal-tz">${escapeHtml(timezoneLabel)}</p>
    <p class="usage-modal-desc">${t('config.usage.trend.modal-desc')}</p>
    <div class="usage-modal-divider" aria-hidden="true"></div>
    <div class="usage-modal-stats">${cells}</div>
    <div class="usage-modal-divider" aria-hidden="true"></div>
    <div class="usage-modal-insight">
      <span class="usage-modal-insight-label">${t('config.usage.trend.insight')}</span>
      <p>${escapeHtml(usageModalInsightText(payload))}</p>
    </div>
  </aside>`
}

function usageModalDay(payload) {
  const summary = payload && payload.summary && typeof payload.summary === 'object' ? payload.summary : {}
  const today = usageToday()
  const end = window.usageFormat.toDayKey(summary.to)
  return end && end <= today ? end : today
}

function usageModalSeries(payload, granularity) {
  if (granularity === 'month') {
    const buckets = window.usageFormat.bucketRowsByMonth(payload && payload.daily && payload.daily.rows)
    return buckets.map((bucket) => ({
      key: bucket.month,
      title: bucket.month,
      axis: bucket.month,
      input: bucket.input,
      cache: bucket.cache,
      output: bucket.output,
      total: bucket.tokens,
      conversations: bucket.conversations
    }))
  }
  const rows = usageTrendRows(payload?.daily)
  return rows.map((row) => {
    const segments = usageTrendSegments(row)
    return {
      key: row.day,
      title: usageDayLabel(row.day),
      axis: String(row.day).slice(5),
      input: segments.input,
      cache: segments.cache,
      output: segments.output,
      total: segments.total,
      conversations: usageNumber(row.conversation_count)
    }
  })
}

function usageModalAria(item) {
  return [
    item.title,
    `${t('config.usage.trend.input')} ${usageFull(item.input)}`,
    `${t('config.usage.trend.cache')} ${usageFull(item.cache)}`,
    `${t('config.usage.trend.output')} ${usageFull(item.output)}`,
    `${t('config.usage.trend.total')} ${usageFull(item.total)}`,
    t('config.usage.kpi.conversations-in-range', { count: item.conversations })
  ].join(' · ')
}

function usageModalTooltipHtml(item) {
  const lines = [
    { label: t('config.usage.trend.input'), value: item.input, dotClass: 'usage-trend-dot-input' },
    { label: t('config.usage.trend.cache'), value: item.cache, dotClass: 'usage-trend-dot-cache' },
    { label: t('config.usage.trend.output'), value: item.output, dotClass: 'usage-trend-dot-output' }
  ]
  return `<b class="usage-tooltip-date">${escapeHtml(item.title)}</b>${lines.map((line) => `<span class="usage-tooltip-line"><i class="usage-trend-dot ${line.dotClass}" aria-hidden="true"></i><span class="usage-tooltip-label">${escapeHtml(line.label)}</span><b class="usage-tooltip-value">${escapeHtml(usageFull(line.value))}</b></span>`).join('')}<span class="usage-tooltip-line usage-tooltip-total"><span class="usage-tooltip-label">${t('config.usage.trend.total')}</span><b class="usage-tooltip-value">${escapeHtml(usageFull(item.total))}</b><em class="usage-tooltip-pct">${escapeHtml(t('config.usage.kpi.conversations-in-range', { count: item.conversations }))}</em></span>`
}

function usageModalChartHtml(series, emptyKey) {
  if (!Array.isArray(series) || series.length === 0) {
    return { html: `<div class="usage-empty-text usage-modal-empty">${t(emptyKey || 'config.usage.trend.empty')}</div>`, axis: '' }
  }
  const max = series.reduce((value, item) => Math.max(value, item.total), 0)
  const columns = series.map((item, index) => {
    const height = max > 0 ? Math.max(2, Math.round((item.total / max) * 100)) : 2
    const segmentHeight = (value) => (item.total > 0 ? Math.max(0, (value / item.total) * 100) : 0)
    const stack = item.total > 0
      ? `<div class="usage-trend-stack" style="height:${height}%">
          <i class="usage-trend-seg usage-trend-output" style="height:${segmentHeight(item.output).toFixed(2)}%"></i>
          <i class="usage-trend-seg usage-trend-cache" style="height:${segmentHeight(item.cache).toFixed(2)}%"></i>
          <i class="usage-trend-seg usage-trend-input" style="height:${segmentHeight(item.input).toFixed(2)}%"></i>
        </div>`
      : '<div class="usage-trend-stack usage-trend-empty" style="height:2px"></div>'
    return `<div class="usage-modal-col" tabindex="-1" role="gridcell" data-usage-modal-index="${index}" aria-label="${escapeHtml(usageModalAria(item))}">${stack}</div>`
  }).join('')
  const axisIndexes = series.length > 2 ? [0, Math.floor((series.length - 1) / 2), series.length - 1] : series.map((item, index) => index)
  const axis = axisIndexes.map((index) => `<span>${escapeHtml(series[index].axis)}</span>`).join('')
  return {
    html: `<div class="usage-modal-gridlines" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
      <div class="usage-modal-bars" data-usage-modal-bars role="grid" aria-labelledby="usageTrendModalTitle"><div class="usage-modal-bar-row" role="row">${columns}</div><div class="usage-tooltip usage-modal-tooltip" data-usage-modal-tooltip aria-hidden="true" hidden></div></div>`,
    axis: `<div class="usage-modal-axis-labels">${axis}</div>`
  }
}

function usageBindModalChart(overlay, series) {
  const bars = overlay.querySelector('[data-usage-modal-bars]')
  const tooltip = overlay.querySelector('[data-usage-modal-tooltip]')
  if (!bars || !tooltip) return
  usageBindChartNavigation(bars)
  const byIndex = new Map(series.map((item, index) => [String(index), item]))
  const hide = () => { tooltip.hidden = true }
  bars.querySelectorAll('[data-usage-modal-index]').forEach((column) => {
    const show = () => {
      const item = byIndex.get(column.dataset.usageModalIndex)
      if (!item) return
      tooltip.innerHTML = usageModalTooltipHtml(item)
      tooltip.hidden = false
      const barsWidth = bars.clientWidth
      const width = tooltip.offsetWidth
      const center = column.offsetLeft + column.offsetWidth / 2
      let left = center
      let flip = 'center'
      if (center - width / 2 < 4) {
        left = column.offsetLeft
        flip = 'left'
      } else if (center + width / 2 > barsWidth - 4) {
        left = column.offsetLeft + column.offsetWidth
        flip = 'right'
      }
      tooltip.dataset.flip = flip
      tooltip.style.left = `${Math.round(left)}px`
      const height = tooltip.offsetHeight
      const above = column.offsetTop - height - 8
      tooltip.style.top = above >= 2 ? `${Math.round(above)}px` : `${Math.round(column.offsetTop + 8)}px`
    }
    column.addEventListener('mouseenter', show)
    column.addEventListener('focus', show)
    column.addEventListener('mouseleave', hide)
    column.addEventListener('blur', hide)
  })
  bars.addEventListener('mouseleave', hide)
}

async function usageRenderModalChart() {
  const overlay = usageTrendModal
  if (!overlay) return
  const payload = usageDashboardPayload
  if (!payload) return
  const request = ++usageTrendModalRequest
  const chartElement = overlay.querySelector('[data-usage-modal-chart]')
  const axisElement = overlay.querySelector('[data-usage-modal-axis]')
  if (!chartElement) return
  let series
  let emptyKey = 'config.usage.trend.empty'
  if (usageTrendModalGranularity === '30m') {
    if (!usageHasOptionalApi('usageHourly')) {
      chartElement.innerHTML = `<div class="usage-empty-text usage-modal-empty">${t('config.usage.trend.empty-hourly')}</div>`
      axisElement?.replaceChildren()
      chartElement.tabIndex = 0
      chartElement.removeAttribute('aria-busy')
      return
    }
    chartElement.innerHTML = `<div class="usage-empty-text usage-modal-empty">${t('config.usage.state.loading')}</div>`
    axisElement?.replaceChildren()
    chartElement.tabIndex = 0
    chartElement.setAttribute('aria-busy', 'true')
    let hourly = null
    try {
      // The modal is a reading of the same page, so the AI-tool filter applies
      // here too; omitting it for an "all tools" selection keeps the query shape
      // identical to older builds.
      const hourlyQuery = { day: usageModalDay(payload), tz: usageTimezone() }
      if (usageSourceFilter.length > 0) hourlyQuery.sources = usageSourceFilter.slice()
      if (usageModelFilter) hourlyQuery.model = usageModelFilter
      if (usageProjectFilter) hourlyQuery.project = usageProjectFilter
      hourly = await window.electronAPI.usageHourly(hourlyQuery)
    } catch {
      // Only the IPC call is allowed to degrade to the empty state; programming
      // errors below must stay loud instead of silently emptying the chart.
      hourly = null
    }
    if (request !== usageTrendModalRequest || !usageTrendModal) return
    try {
      const rows = hourly && Array.isArray(hourly.rows) ? hourly.rows : []
      series = rows.map((row) => ({
        key: row.hour,
        title: usageDayLabel(row.hour && String(row.hour).slice(0, 10)),
        axis: usageHourClock(row && row.hour),
        input: usageNumber(row && row.input_tokens),
        cache: 0,
        output: usageNumber(row && row.output_tokens),
        total: usageNumber(row && row.billable_total_tokens),
        conversations: usageNumber(row && row.conversation_count)
      }))
      emptyKey = 'config.usage.trend.empty-hourly'
    } catch (error) {
      if (error instanceof ReferenceError || error instanceof TypeError) throw error
      series = []
      emptyKey = 'config.usage.trend.empty-hourly'
    }
  } else {
    series = usageModalSeries(payload, usageTrendModalGranularity)
  }
  if (request !== usageTrendModalRequest || !usageTrendModal) return
  const rendered = usageModalChartHtml(series, emptyKey)
  chartElement.innerHTML = rendered.html
  chartElement.tabIndex = series.length ? -1 : 0
  chartElement.removeAttribute('aria-busy')
  if (axisElement) axisElement.innerHTML = rendered.axis
  usageBindModalChart(overlay, series)
}

function usageTrendModalHtml(payload, timezoneLabel) {
  const granularity = USAGE_MODAL_GRANULARITIES.map((entry) => {
    const selected = entry.id === usageTrendModalGranularity
    return `<button id="usageGranularity-${entry.id}" class="usage-modal-granularity-btn${selected ? ' is-active' : ''}" type="button" role="tab" data-usage-granularity="${entry.id}" aria-controls="usageTrendGranularityPanel" aria-selected="${selected}" tabindex="${selected ? 0 : -1}">${t(entry.labelKey)}</button>`
  }).join('')
  return `<div class="usage-modal" role="dialog" aria-modal="true" aria-labelledby="usageTrendModalTitle">
    ${usageModalSideHtml(payload, timezoneLabel)}
    <section class="usage-modal-main">
      <div class="usage-modal-toolbar">
        <div class="usage-modal-granularity" role="tablist" aria-label="${escapeHtml(t('config.usage.trend.granularity'))}">${granularity}</div>
        <span class="usage-modal-range">${escapeHtml(usageModalRangeLabel(payload.summary))}</span>
        <button class="usage-modal-close" type="button" data-usage-modal-close aria-label="${escapeHtml(t('config.usage.trend.close'))}">×</button>
      </div>
      <div id="usageTrendGranularityPanel" class="usage-modal-chart" role="tabpanel" aria-labelledby="usageGranularity-${usageTrendModalGranularity}" data-usage-modal-chart></div>
      <div class="usage-modal-axis" data-usage-modal-axis aria-hidden="true"></div>
    </section>
  </div>`
}

function usageCloseTrendModal(restoreFocus = true) {
  const overlay = usageTrendModal
  if (!overlay) return
  usageTrendModal = null
  usageTrendModalRequest += 1
  if (typeof usageTrendModalCleanup === 'function') {
    try { usageTrendModalCleanup() } catch { /* listeners already gone */ }
  }
  usageTrendModalCleanup = null
  document.body.classList.remove('usage-modal-open')
  const trigger = overlay._usageTrigger
  overlay.remove()
  if (restoreFocus && trigger && typeof trigger.focus === 'function' && trigger.isConnected) trigger.focus()
  // A scan that finished while the modal was open could not repaint the page
  // without destroying the overlay; the deferred repaint lands now that it is gone.
  if (usageAutoRefreshRenderPending) {
    usageAutoRefreshRenderPending = false
    void usageRerenderKeepingDashboard()
  }
}

function usageOpenTrendModal() {
  const payload = usageDashboardPayload
  if (!payload || usageTrendModal) return
  const timezone = usageTimezone()
  const timezoneLabel = `${timezone} (${window.usageFormat.formatTimezoneOffsetLabel(timezone)})`
  usageTrendModalGranularity = 'day'
  const overlay = document.createElement('div')
  overlay.className = 'usage-modal-overlay'
  overlay.dataset.usageTrendModal = ''
  overlay.tabIndex = -1
  overlay.innerHTML = usageTrendModalHtml(payload, timezoneLabel)
  const trigger = view.querySelector('[data-usage-trend-expand]') || document.activeElement
  overlay._usageTrigger = trigger
  document.body.appendChild(overlay)
  usageTrendModal = overlay
  document.body.classList.add('usage-modal-open')

  const focusable = () => [...overlay.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
    .filter((element) => !element.disabled && element.tabIndex >= 0)
  const onKeydown = (event) => {
    if (!usageTrendModal || event.defaultPrevented || event.isComposing || event.keyCode === 229) return
    if (event.key === 'Escape') {
      event.preventDefault()
      usageCloseTrendModal()
      return
    }
    if (event.key !== 'Tab') return
    const list = focusable()
    if (list.length === 0) return
    const first = list[0]
    const last = list[list.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }
  const onFocusIn = (event) => {
    if (!usageTrendModal) return
    if (!usageTrendModal.contains(event.target)) {
      const list = focusable()
      if (list.length > 0) list[0].focus()
    }
  }
  document.addEventListener('keydown', onKeydown)
  document.addEventListener('focusin', onFocusIn)
  usageTrendModalCleanup = () => {
    document.removeEventListener('keydown', onKeydown)
    document.removeEventListener('focusin', onFocusIn)
  }
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) usageCloseTrendModal()
  })
  const closeButton = overlay.querySelector('[data-usage-modal-close]')
  if (closeButton) {
    closeButton.onclick = () => usageCloseTrendModal()
    closeButton.focus()
  }
  const tablist = overlay.querySelector('[role="tablist"]')
  const tabs = [...tablist.querySelectorAll('[role="tab"]')]
  const panel = overlay.querySelector('[data-usage-modal-chart]')
  for (const button of tabs) {
    button.onclick = () => {
      const next = button.dataset.usageGranularity
      if (next === usageTrendModalGranularity) return
      usageTrendModalGranularity = next
      for (const item of tabs) {
        const selected = item === button
        item.classList.toggle('is-active', selected)
        item.setAttribute('aria-selected', String(selected))
        item.tabIndex = selected ? 0 : -1
      }
      panel.setAttribute('aria-labelledby', button.id)
      void usageRenderModalChart()
    }
  }
  tablist.addEventListener('keydown', (event) => {
    const index = tabs.indexOf(event.target)
    if (index === -1 || event.isComposing || event.keyCode === 229) return
    let next
    switch (event.key) {
      case 'ArrowLeft': next = tabs[(index - 1 + tabs.length) % tabs.length]; break
      case 'ArrowRight': next = tabs[(index + 1) % tabs.length]; break
      case 'Home': next = tabs[0]; break
      case 'End': next = tabs.at(-1); break
      default: return
    }
    event.preventDefault()
    for (const tab of tabs) tab.tabIndex = tab === next ? 0 : -1
    next.focus()
  })
  tablist.addEventListener('focusout', (event) => {
    if (tablist.contains(event.relatedTarget)) return
    for (const tab of tabs) tab.tabIndex = tab.dataset.usageGranularity === usageTrendModalGranularity ? 0 : -1
  })
  void usageRenderModalChart()
}

// ---------------------------------------------------------------------------
// Dashboard composition
// ---------------------------------------------------------------------------

function usageRenderDashboard(renderVersion, payload) {
  if (!usageIsCurrent(renderVersion)) return
  const status = payload.status
  const summary = payload.summary && typeof payload.summary === 'object' ? payload.summary : {}
  const daily = payload.daily && typeof payload.daily === 'object' ? payload.daily : {}
  const breakdown = payload.breakdown && typeof payload.breakdown === 'object' ? payload.breakdown : {}
  const totals = summary.totals && typeof summary.totals === 'object' ? summary.totals : {}
  const details = summary.details
  const projects = Array.isArray(details?.projects) ? details.projects : []
  const dailyRows = Array.isArray(daily.rows) ? daily.rows : []
  const models = Array.isArray(breakdown.models) ? breakdown.models : []
  const state = usageResolvePageState(status, totals)
  usageDailyRowCache = dailyRows.filter(usageIsActiveDay)
  usageDashboardPayload = payload
  const timezone = usageTimezone()
  // A re-query (period/filter/refresh) swaps the page in place; keep the reading
  // position and keyboard focus so the swap is not a jump to the top.
  const restore = usageCaptureViewState()

  view.innerHTML = `<div class="page usage-page usage-overview" data-usage-state="${escapeHtml(state)}">
    ${usageHeaderHtml()}
    ${usageTabsHtml(models, projects, status)}
    ${usageStateBannerHtml(state)}
    ${details && details.status !== 'ready' ? `<p class="usage-section-note" role="status">${escapeHtml(usageDashboardText(details.status === 'pending' ? 'detail-pending' : 'detail-partial'))}</p>` : ''}
    <div class="usage-dashboard" data-usage-view="${escapeHtml(usagePeriod)}">
      ${usageDashboardKpis(totals, dailyRows, details)}
      ${usageTrendHtml(daily)}
      ${usageDashboardRankings(models, projects)}
      <div class="usage-pair usage-drilldown">
        ${usageDashboardHeatmap(daily, payload.heatmap, timezone)}
        ${usageSessionsHtml(details)}
        ${usageActivityHtml('skills', details?.skills)}
      </div>
      ${usageActivityHtml('tools', details?.tools)}
      ${usageDailyTableHtml(usageDailyRowCache)}
      ${usagePricingHtml(models, restore.pricingOpen)}
      ${usageSnapshotsHtml(status)}
      <details class="usage-dashboard-settings" id="usageSources"${restore.coverageOpen ? ' open' : ''}><summary>${escapeHtml(usageDashboardText('sources-settings'))}
        <span>${status?.lastScanAt ? escapeHtml(t('config.usage.coverage.last-scan', { time: usageDateTime(status.lastScanAt) })) : ''}</span></summary>
        ${usageCoverageHtml(status)}
      </details>
    </div>
  </div>`
  usageBindDashboard(payload)
  usageSubscribeProgress()
  usageRestoreViewState(restore)
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

// '#view' is the scroller (the page itself is height:auto inside it), so both
// the scroll offset and the focused control need an explicit hand-off across a
// re-render. Focus is restored by the same data attribute plus, for the daily
// sort button, its stable selector.
function usageCaptureViewState() {
  const active = document.activeElement
  const focusSelector = active && active.closest && active.closest('#view')
    ? usageFocusSelector(active)
    : ''
  const selection = active?.id === 'usageSessionSearch' ? [active.selectionStart, active.selectionEnd] : null
  return {
    scrollTop: view.scrollTop || 0, focusSelector, selection,
    heatScrollLeft: view.querySelector('[data-usage-heatmap-scroll]')?.scrollLeft,
    coverageOpen: view.querySelector('#usageSources')?.open === true,
    pricingOpen: view.querySelector('#usagePricing')?.open === true
  }
}

function usageFocusSelector(element) {
  if (!element || element === document.body) return ''
  if (['usageSource', 'usageModel', 'usageProject', 'usageEvery', 'refreshUsage', 'usageIncludeCache', 'usageSessionSearch'].includes(element.id)) return `#${element.id}`
  if (element.hasAttribute?.('data-usage-model-rank')) return '#usageModel'
  if (element.hasAttribute?.('data-usage-project-rank')) return '#usageProject'
  const priceRow = element.closest?.('[data-usage-price-row]')
  if (priceRow && element.dataset?.usagePriceField && typeof CSS !== 'undefined') {
    return `[data-usage-price-row="${CSS.escape(priceRow.dataset.usagePriceRow)}"] [data-usage-price-field="${CSS.escape(element.dataset.usagePriceField)}"]`
  }
  for (const attribute of ['data-usage-tab', 'data-usage-metric', 'data-usage-heat-view', 'data-usage-hour-cell', 'data-usage-day', 'data-usage-heat-day', 'data-usage-trend-expand', 'data-usage-sort', 'data-usage-session-sort', 'data-usage-activity-more']) {
    const value = element.getAttribute && element.getAttribute(attribute)
    if (value !== null && value !== undefined) return `[${attribute}="${String(value).replace(/"/g, '\\"')}"]`
  }
  return ''
}

function usageRestoreViewState(state) {
  if (!state) return
  const heatScroll = view.querySelector('[data-usage-heatmap-scroll]')
  if (heatScroll && state.heatScrollLeft !== undefined) heatScroll.scrollLeft = state.heatScrollLeft
  const applyScroll = () => {
    if (state.scrollTop > 0 && view.scrollTop !== state.scrollTop) view.scrollTop = state.scrollTop
  }
  // The new dashboard is not laid out yet on the line right after innerHTML, so
  // its scrollHeight still describes the old content and clamps the assignment.
  // Re-apply on the next frame, once the swap has real geometry.
  applyScroll()
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(applyScroll)
  if (!state.focusSelector) return
  const target = view.querySelector(state.focusSelector)
  if (target && typeof target.focus === 'function') {
    target.focus({ preventScroll: true })
    if (state.selection) target.setSelectionRange?.(...state.selection)
  }
}


async function usageRenderRoute(options = {}) {
  const renderVersion = ++usageRenderVersion
  const swapVersion = ++usageSwapVersion
  usageUnsubscribeProgress()
  usageAutoRefreshStop()
  usageClearHeatTooltip()
  usageAutoRefreshRenderPending = false
  usageCloseTrendModal(false)
  usageDashboardPayload = null
  usageRefreshPending = false

  const missing = usageMissingMethods()
  if (missing.length > 0) {
    usageRenderStandaloneError(renderVersion, t('config.usage.state.error-title'), t('config.usage.state.api-missing'))
    return
  }

  // Period/filter/refresh switches keep the current dashboard on screen and only
  // mark it busy; blanking the page to a loading card for a 1-2 ms cache hit is
  // what made the tabs flash. A first visit (or a full route re-entry) still gets
  // the loading card because there is nothing to keep.
  const keepCurrent = options.keepDashboard === true && usageKeepDashboardForSwap()

  let status
  try {
    status = await window.electronAPI.usageStatus()
  } catch (error) {
    if (usageIsCurrent(renderVersion)) {
      usageRenderStandaloneError(renderVersion, t('config.usage.state.error-title'), usageErrorText(error) || t('config.usage.state.error-body'))
    }
    return
  }
  if (!usageIsCurrent(renderVersion)) return

  if (!status || status.enabled !== true) {
    usageRenderConsent(renderVersion, status)
    return
  }

  // Freshness starts here, for every enabled entry into the page: the timer and
  // the focus/visibility listeners are armed before the first query so a scan
  // finishing mid-load still reaches the page. Only a real route entry triggers
  // the initial `page-open` scan; an in-place re-query (period switch, manual
  // refresh) must not ask for another scan.
  usageAutoRefreshArm()
  if (options.keepDashboard !== true) void usageAutoRefreshTick()

  usageNormalizeRange()
  const params = usageQueryParams()
  // The heatmap is optional: a rejection collapses to null so a build without
  // the channel hides the card instead of failing the page (hourly is fetched
  // lazily only when the trend modal's 30-minute granularity is selected).
  const { model, project, ...unfilteredModelParams } = params
  const heatmapRequest = usageHeatView === 'yearly' && usageHasOptionalApi('usageHeatmap')
    ? window.electronAPI.usageHeatmap({ tz: params.tz, weeks: USAGE_HEATMAP_WEEKS, ...(params.sources ? { sources: params.sources } : {}), ...(model ? { model } : {}), ...(project ? { project } : {}) }).catch(() => null)
    : Promise.resolve(null)
  // Mark busy only once the request is actually in flight, and only when the old
  // dashboard stayed mounted; a swap that resolves immediately then never paints
  // the busy state at all.
  if (!keepCurrent) usageRenderLoading(renderVersion)
  else usageSetBusy(renderVersion, swapVersion, true)
  let summary
  let daily
  let breakdown
  let heatmap
  try {
    [summary, daily, breakdown, heatmap] = await Promise.all([
      window.electronAPI.usageSummary(params),
      window.electronAPI.usageDaily(params),
      window.electronAPI.usageBreakdown({ ...unfilteredModelParams, ...(project ? { project } : {}), scope: 'source' }),
      heatmapRequest
    ])
  } catch (error) {
    if (!usageIsCurrent(renderVersion)) return
    if (keepCurrent) usageSetBusy(renderVersion, swapVersion, false)
    usageRenderLoadError(renderVersion, status, error)
    return
  }
  if (!usageIsCurrent(renderVersion)) return

  usageRenderDashboard(renderVersion, { status, summary, daily, breakdown, heatmap })
}

// True when the visible page already has a dashboard whose markup can survive a
// re-query untouched (same route, same shell). Consent/error/loading states have
// no dashboard, so they always go through the full loading path.
function usageKeepDashboardForSwap() {
  const page = view.querySelector('.usage-page')
  if (!page || page.dataset.usageState === 'loading') return false
  return !!page.querySelector('.usage-dashboard')
}

function usageSetBusy(renderVersion, swapVersion, busy) {
  if (!usageIsCurrent(renderVersion) || swapVersion !== usageSwapVersion) return
  const page = view.querySelector('.usage-page')
  if (!page) return
  if (busy) page.dataset.usageBusy = 'true'
  else delete page.dataset.usageBusy
}

async function renderUsage() {
  try {
    await usageRenderRoute()
  } catch (error) {
    // renderRoute() dispatches without awaiting, so a rejected render would be
    // an unhandled rejection in the renderer console. Keep the page honest.
    if (currentRoute === 'usage') {
      usageRenderStandaloneError(usageRenderVersion, t('config.usage.state.error-title'), usageErrorText(error) || t('config.usage.state.error-body'))
    }
  }
}

// User-initiated re-query (period tab, AI-tool filter, custom range): the old
// dashboard stays mounted and readable until the new payload arrives.
async function usageRerenderKeepingDashboard() {
  try {
    await usageRenderRoute({ keepDashboard: true })
  } catch (error) {
    if (currentRoute === 'usage') {
      usageRenderStandaloneError(usageRenderVersion, t('config.usage.state.error-title'), usageErrorText(error) || t('config.usage.state.error-body'))
    }
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function usageBindRetry() {
  view.querySelectorAll('[data-usage-retry]').forEach((button) => {
    button.onclick = () => { void renderUsage() }
  })
}

function usageBindRefresh() {
  view.querySelectorAll('[data-usage-refresh]').forEach((button) => {
    button.onclick = () => { void usageRefreshNow() }
  })
}

function usageBindConsent() {
  const enable = view.querySelector('[data-usage-enable]')
  if (enable) {
    enable.onclick = async () => {
      enable.disabled = true
      try {
        await updateSettings({ usage: { enabled: true } }, '')
        // renderUsage() arms the auto-refresh lifecycle and fires the initial
        // `page-open` scan for an enabled page, so the consent path must not
        // trigger a second scan of its own.
        await renderUsage()
      } catch (error) {
        usageToast(t('config.usage.consent.enable-failed', { message: usageErrorText(error) }))
        enable.disabled = false
      }
    }
  }
  usageBindRefresh()
  usageBindRetry()
}

function usageBindCoverageActions() {
  view.querySelectorAll('[data-usage-clear]').forEach((button) => {
    button.onclick = () => { void usageClearData() }
  })
}

function usageBindTabs() {
  view.querySelectorAll('[data-usage-tab]').forEach((button) => {
    button.onclick = () => {
      const next = button.dataset.usageTab
      if (!USAGE_PERIODS.some((period) => period.id === next) || next === usagePeriod) return
      if (next === USAGE_CUSTOM_PERIOD && usagePeriod !== USAGE_CUSTOM_PERIOD) {
        usagePeriodBeforeCustom = usagePeriod
        if (!usageRange.from || !usageRange.to) usageRange = usageDefaultRange()
      }
      usagePeriod = next
      void usageRerenderKeepingDashboard()
    }
  })
}

function usageBindSourceFilter() {
  const source = view.querySelector('#usageSource')
  if (source) source.onchange = () => {
    usageSourceFilter = USAGE_SUPPORTED_SOURCES.includes(source.value) ? [source.value] : []
    usageModelFilter = ''
    usageProjectFilter = ''
    void usageRerenderKeepingDashboard()
  }
  const selectModel = (model) => {
    if (model === usageModelFilter) return
    usageModelFilter = model
    void usageRerenderKeepingDashboard()
  }
  const model = view.querySelector('#usageModel')
  if (model) model.onchange = () => selectModel(model.value)
  view.querySelectorAll('[data-usage-model-rank]').forEach((button) => {
    button.onclick = () => selectModel(button.dataset.usageModelRank === usageModelFilter ? '' : button.dataset.usageModelRank)
  })
  const selectProject = (value, label) => {
    if (value === usageProjectFilter) return
    usageProjectFilter = value
    usageProjectLabel = label
    void usageRerenderKeepingDashboard()
  }
  const project = view.querySelector('#usageProject')
  if (project) project.onchange = () => selectProject(project.value, project.selectedOptions[0]?.textContent || '')
  view.querySelectorAll('[data-usage-project-rank]').forEach((button) => {
    button.onclick = () => selectProject(button.dataset.usageProjectRank === usageProjectFilter ? '' : button.dataset.usageProjectRank,
      button.querySelector('.usage-rank-name')?.textContent || '')
  })
}

function usageBindDetailControls(payload, repaint) {
  const list = view.querySelector('#usageSessionList')
  const search = view.querySelector('#usageSessionSearch')
  const details = payload?.summary?.details
  const bindMore = () => {
    const more = view.querySelector('#usageSessionsMore')
    if (more) more.onclick = () => {
      usageSessionExpanded = !usageSessionExpanded
      redraw()
      view.querySelector('#usageSessionsMore')?.focus({ preventScroll: true })
    }
  }
  const redraw = () => {
    if (list) list.innerHTML = usageSessionListHtml(details)
    bindMore()
  }
  bindMore()
  if (search) search.oninput = () => {
    usageSessionSearch = search.value
    usageSessionExpanded = false
    redraw()
  }
  view.querySelectorAll('[data-usage-session-sort]').forEach((button) => {
    button.onclick = () => {
      usageSessionSort = button.dataset.usageSessionSort
      repaint()
    }
  })
  view.querySelectorAll('[data-usage-activity-more]').forEach((button) => {
    button.onclick = () => {
      const kind = button.dataset.usageActivityMore
      if (!usageExpandedActivity.delete(kind)) usageExpandedActivity.add(kind)
      repaint()
    }
  })
  // Price versions: one edit snapshots the whole table, so any later repaint
  // (period switch, add version) re-renders exactly what the user typed.
  view.querySelectorAll('[data-usage-price-field]').forEach((input) => {
    input.oninput = () => { usagePriceEditor = { rows: usageCapturePriceRows() } }
  })
  view.querySelectorAll('[data-usage-price-add]').forEach((button) => {
    button.onclick = () => {
      const rows = usageCapturePriceRows()
      rows.push({
        uid: usagePriceUid(),
        model: button.dataset.usagePriceAdd,
        effectiveFrom: usageToday(),
        input: '',
        cached: '',
        cachedWrite: '',
        output: ''
      })
      usagePriceEditor = { rows }
      usageRepaintDashboard()
      view.querySelector('[data-usage-price-field="effectiveFrom"]')?.focus()
    }
  })
  const save = view.querySelector('#saveUsagePrices')
  if (save) save.onclick = async () => {
    const rows = []
    const seen = new Set()
    for (const rowElement of view.querySelectorAll('[data-usage-price-row]')) {
      const model = rowElement.dataset.usagePriceModel
      const read = (field) => {
        const input = rowElement.querySelector(`[data-usage-price-field="${field}"]`)
        return input ? input.value.trim() : ''
      }
      const effectiveFrom = read('effectiveFrom')
      const rates = [read('input'), read('cached'), read('output')]
      const cachedWrite = read('cachedWrite')
      const blanks = rates.filter((value) => value === '').length
      // Clearing the three required rates removes this version, exactly like the
      // single-version editor removed a model's price.
      if (blanks === 3) continue
      if (blanks > 0) {
        usageToast(usageDashboardText('price-invalid'))
        return
      }
      const values = rates.map(Number)
      if (values.some((value) => !Number.isFinite(value) || value < 0 || value > 1000000)) {
        usageToast(usageDashboardText('price-invalid'))
        return
      }
      const row = { model, input: values[0], cached: values[1], output: values[2] }
      if (cachedWrite !== '') {
        const writeRate = Number(cachedWrite)
        if (!Number.isFinite(writeRate) || writeRate < 0 || writeRate > 1000000) {
          usageToast(usageDashboardText('price-invalid'))
          return
        }
        row.cachedWrite = writeRate
      }
      if (effectiveFrom) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) {
          usageToast(usageDashboardText('price-invalid'))
          return
        }
        row.effectiveFrom = effectiveFrom
      }
      const key = `${model}\u0000${row.effectiveFrom || ''}`
      if (seen.has(key)) {
        usageToast(usageDashboardText('price-duplicate'))
        return
      }
      seen.add(key)
      rows.push(row)
    }
    if (rows.length > 100) {
      usageToast(usageDashboardText('price-limit'))
      return
    }
    save.disabled = true
    try {
      await updateSettings({ usage: { prices: rows } }, usageDashboardText('price-saved'))
      usagePriceEditor = null
      if (currentRoute === 'usage') await usageRerenderKeepingDashboard()
    } catch (error) {
      usageToast(usageErrorText(error))
    } finally {
      save.disabled = false
    }
  }
}

// Repaint the mounted dashboard in place (no query round trip). Used by the
// price-version drafts and the import preview, both of which are renderer state.
function usageRepaintDashboard() {
  if (usageDashboardPayload) usageRenderDashboard(usageRenderVersion, usageDashboardPayload)
}

async function usageExportReport(format, button) {
  if (!usageHasApi('usageExport')) {
    usageToast(usageDashboardText('export-unavailable'))
    return
  }
  if (button) button.disabled = true
  try {
    // Same period/timezone/filters the page is showing; main resolves the file
    // target through its own save dialog so no path crosses this call.
    const result = await window.electronAPI.usageExport({ ...usageQueryParams(), format, save: true })
    if (!result || result.canceled) return
    usageToast(t('config.usage.dashboard.export-done', { file: result.fileName || '', rows: usageNumber(result.rows) }))
  } catch (error) {
    // A build whose IPC policy does not expose the channel reports "No handler
    // registered"; say "no export channel" instead of leaking that string.
    const message = usageErrorText(error)
    usageToast(/handler/i.test(message) ? usageDashboardText('export-unavailable') : message)
  } finally {
    if (button) button.disabled = false
  }
}

async function usageReadImportFile(fileInput) {
  const file = fileInput.files && fileInput.files[0]
  fileInput.value = ''
  if (!file) return
  if (!usageHasApi('usageImport')) {
    usageToast(usageDashboardText('export-unavailable'))
    return
  }
  try {
    const text = await file.text()
    const preview = await window.electronAPI.usageImport({ mode: 'preview', payload: text })
    usageImportPayload = text
    usageImportPreviewData = preview
    usageRepaintDashboard()
    view.querySelector('#usageSnapshots')?.scrollIntoView?.({ block: 'nearest' })
  } catch (error) {
    usageImportPayload = null
    usageImportPreviewData = null
    const message = usageErrorText(error)
    usageToast(/handler/i.test(message) ? usageDashboardText('export-unavailable') : (message || usageDashboardText('import-invalid')))
  }
}

async function usageCommitImport() {
  if (!usageImportPayload || !usageHasApi('usageImport')) return
  const confirm = view.querySelector('[data-usage-import-confirm]')
  if (confirm) confirm.disabled = true
  try {
    const result = await window.electronAPI.usageImport({ mode: 'commit', payload: usageImportPayload })
    usageImportPayload = null
    usageImportPreviewData = null
    if (result?.duplicate) usageToast(usageDashboardText('import-duplicate'))
    else usageToast(t('config.usage.dashboard.import-done', { rows: usageNumber(result?.totalRows) }))
    if (currentRoute === 'usage') await usageRerenderKeepingDashboard()
  } catch (error) {
    usageToast(usageErrorText(error) || usageDashboardText('import-invalid'))
    if (confirm) confirm.disabled = false
  }
}

function usageBindExchangeControls() {
  view.querySelectorAll('[data-usage-export]').forEach((button) => {
    button.onclick = () => { void usageExportReport(button.dataset.usageExport, button) }
  })
  const trigger = view.querySelector('[data-usage-import]')
  const fileInput = view.querySelector('[data-usage-import-file]')
  if (trigger && fileInput) {
    trigger.onclick = () => fileInput.click()
    fileInput.onchange = () => { void usageReadImportFile(fileInput) }
  }
}

function usageBindSnapshots() {
  const confirm = view.querySelector('[data-usage-import-confirm]')
  if (confirm) confirm.onclick = () => { void usageCommitImport() }
  const cancel = view.querySelector('[data-usage-import-cancel]')
  if (cancel) cancel.onclick = () => {
    usageImportPayload = null
    usageImportPreviewData = null
    usageRepaintDashboard()
  }
}

function usageBindOverviewControls() {
  const repaint = usageRepaintDashboard
  usageBindDetailControls(usageDashboardPayload, repaint)
  const interval = view.querySelector('#usageEvery')
  if (interval) interval.onchange = () => {
    usageRefreshInterval = Number(interval.value)
    usageAutoRefreshArm()
  }
  const cacheToggle = view.querySelector('#usageIncludeCache')
  if (cacheToggle) cacheToggle.onclick = () => {
    usageIncludeCache = !usageIncludeCache
    repaint()
  }
  view.querySelectorAll('[data-usage-metric]:enabled').forEach((button) => {
    button.onclick = () => {
      usageTrendMetric = button.dataset.usageMetric
      repaint()
    }
  })
  view.querySelectorAll('[data-usage-heat-view]:enabled').forEach((button) => {
    button.onclick = () => {
      const next = button.dataset.usageHeatView
      if (next === usageHeatView) return
      usageHeatView = next
      if (next === 'yearly' && !usageDashboardPayload?.heatmap) void usageRerenderKeepingDashboard()
      else repaint()
    }
  })
  const grid = view.querySelector('.usage-hour-grid')
  if (grid) {
    grid.onfocusin = (event) => {
      if (!event.target.hasAttribute('data-usage-hour-cell')) return
      const previous = grid.querySelector('[tabindex="0"]')
      if (previous) previous.tabIndex = -1
      event.target.tabIndex = 0
    }
    grid.onkeydown = (event) => {
      const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -24, ArrowDown: 24 }[event.key]
      const index = Number(event.target.dataset.usageHourCell)
      if (!delta || !Number.isInteger(index)) return
      event.preventDefault()
      grid.querySelector(`[data-usage-hour-cell="${index + delta}"]`)?.focus({ preventScroll: true })
    }
  }
}

function usageReadRangeInput(selector) {
  const input = view.querySelector(selector)
  return input && typeof input.value === 'string' ? input.value : ''
}

// Invalid input falls back to the month tab with a toast; valid input becomes
// {period:'custom', from, to} on the next query round.
function usageApplyCustomRange() {
  const result = window.usageFormat.validateCustomRange(
    usageReadRangeInput('[data-usage-range-from]'),
    usageReadRangeInput('[data-usage-range-to]'),
    usageToday()
  )
  if (!result.valid) {
    usageToast(t(USAGE_RANGE_REASON_KEYS[result.reason] || 'config.usage.range.invalid'))
    usagePeriod = USAGE_DEFAULT_PERIOD
    usageRange = { from: '', to: '' }
    void usageRerenderKeepingDashboard()
    return
  }
  if (usagePeriod !== USAGE_CUSTOM_PERIOD) usagePeriodBeforeCustom = usagePeriod
  usageRange = { from: result.from, to: result.to }
  usagePeriod = USAGE_CUSTOM_PERIOD
  usageToast(t('config.usage.range.applied'))
  void usageRerenderKeepingDashboard()
}

function usageCancelCustomRange() {
  usageRange = { from: '', to: '' }
  usagePeriod = usagePeriodBeforeCustom || USAGE_DEFAULT_PERIOD
  void usageRerenderKeepingDashboard()
}

function usageBindCustomRange() {
  const apply = view.querySelector('[data-usage-range-apply]')
  if (apply) apply.onclick = () => usageApplyCustomRange()
  const cancel = view.querySelector('[data-usage-range-reset]')
  if (cancel) cancel.onclick = () => usageCancelCustomRange()
}

function usageBindDailySort() {
  const button = view.querySelector('[data-usage-sort="date"]')
  if (!button) return
  button.onclick = () => {
    usageDailySort = usageDailySort === 'desc' ? 'asc' : 'desc'
    const body = view.querySelector('[data-usage-daily-body]')
    if (body) body.innerHTML = usageDailyRowsHtml(usageDailyRowCache, usageDailySort)
    const header = button.closest('th')
    if (header) header.setAttribute('aria-sort', usageDailySort === 'desc' ? 'descending' : 'ascending')
    const arrow = button.querySelector('.usage-sort-arrow')
    if (arrow) arrow.textContent = usageDailySort === 'desc' ? '↓' : '↑'
  }
}

// Absolute tooltip inside the trend card. Horizontal flip keeps it inside the
// card near the edges; vertical flip drops it below the bar when the top of the
// plot has no room.
function usageShowTrendTooltip(chart, tooltip, column, rowsByDay) {
  const row = rowsByDay.get(column.dataset.usageDay)
  if (!row) return
  const content = usageTrendTooltipHtml(row)
  tooltip.innerHTML = content.html
  tooltip.hidden = false
  const chartWidth = chart.clientWidth
  const tooltipWidth = tooltip.offsetWidth
  const center = column.offsetLeft + column.offsetWidth / 2
  let left = center
  let flip = 'center'
  if (center - tooltipWidth / 2 < 4) {
    left = column.offsetLeft
    flip = 'left'
  } else if (center + tooltipWidth / 2 > chartWidth - 4) {
    left = column.offsetLeft + column.offsetWidth
    flip = 'right'
  }
  tooltip.dataset.flip = flip
  tooltip.style.left = `${Math.round(left)}px`
  const tooltipHeight = tooltip.offsetHeight
  const above = column.offsetTop - tooltipHeight - 8
  tooltip.dataset.side = above >= 2 ? 'top' : 'bottom'
  tooltip.style.top = above >= 2 ? `${Math.round(above)}px` : `${Math.round(column.offsetTop + 8)}px`
}

function usageBindChartNavigation(grid, initialCell) {
  const rows = [...grid.querySelectorAll('[role="row"]')].map((row) =>
    [...row.children].filter((cell) => cell.getAttribute('role') === 'gridcell'))
  let tabStop = initialCell || rows.flat().find((cell) => cell.hasAttribute('tabindex'))
  if (!tabStop) return
  tabStop.tabIndex = 0
  const setTabStop = (cell) => {
    if (cell === tabStop) return
    tabStop.tabIndex = -1
    cell.tabIndex = 0
    tabStop = cell
  }
  grid.addEventListener('focusin', (event) => {
    if (event.target.getAttribute('role') === 'gridcell') setTabStop(event.target)
  })
  grid.addEventListener('keydown', (event) => {
    if (event.isComposing || event.keyCode === 229) return
    const row = rows.findIndex((cells) => cells.includes(event.target))
    if (row === -1) return
    const column = rows[row].indexOf(event.target)
    let next
    switch (event.key) {
      case 'ArrowLeft': next = rows[row][column - 1]; break
      case 'ArrowRight': next = rows[row][column + 1]; break
      case 'ArrowUp': next = rows[row - 1]?.[column]; break
      case 'ArrowDown': next = rows[row + 1]?.[column]; break
      case 'Home': next = rows[row].find((cell) => cell.hasAttribute('tabindex')); break
      case 'End': next = rows[row].findLast((cell) => cell.hasAttribute('tabindex')); break
      default: return
    }
    if (!next?.hasAttribute('tabindex') || next === event.target) return
    event.preventDefault()
    setTabStop(next)
    next.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    next.focus({ preventScroll: true })
  })
}

function usageBindTrend(dailyRows) {
  const chart = view.querySelector('[data-usage-trend]')
  const tooltip = view.querySelector('[data-usage-tooltip]')
  if (!chart || !tooltip) return
  usageBindChartNavigation(chart.parentElement)
  const trendRows = usageTrendRows({ rows: dailyRows })
  const rowsByDay = new Map(trendRows.map((row) => [row.day, row]))
  const hide = () => { tooltip.hidden = true }
  chart.querySelectorAll('[data-usage-day]').forEach((column) => {
    const show = () => usageShowTrendTooltip(chart, tooltip, column, rowsByDay)
    column.addEventListener('mouseenter', show)
    column.addEventListener('focus', show)
    column.addEventListener('mouseleave', hide)
    column.addEventListener('blur', hide)
  })
  chart.addEventListener('mouseleave', hide)
}

function usageClearHeatTooltip() {
  if (usageHeatTooltipTimer) {
    clearTimeout(usageHeatTooltipTimer)
    usageHeatTooltipTimer = null
  }
}

// The rich tooltip is clamped inside the heatmap CARD (not just the chart): the
// card is short, so a 200px card anchored to a cell can otherwise spill out of
// the card bottom. Preference order: above the cell, then below, and the final
// top/left are clamped so the tooltip + arrow always stay inside the card.
// The rich tooltip is clamped inside the heatmap CARD with an 8px margin and
// kept clear of the legend/footer row. Preference: above the cell, then below.
// The arrow is positioned on the side that faces the hovered cell.
function usagePositionHeatTooltip(chart, tooltip, cell) {
  const card = chart.closest('.usage-heatmap') || chart.parentElement || chart
  const cardRect = card.getBoundingClientRect()
  const chartRect = chart.getBoundingClientRect()
  const cellRect = cell.getBoundingClientRect()
  const chartWidth = chart.clientWidth
  const legend = card.querySelector('.usage-heat-foot')
  tooltip.style.maxHeight = `${Math.max(120, Math.round(cardRect.height - 16))}px`
  const width = tooltip.offsetWidth
  const height = tooltip.offsetHeight
  const center = cellRect.left - chartRect.left + cellRect.width / 2
  const left = Math.max(8, Math.min(chartWidth - width - 8, center - width / 2))
  tooltip.style.left = `${Math.round(left)}px`
  const cardTop = cardRect.top - chartRect.top
  const cardBottom = cardRect.bottom - chartRect.top
  const minTop = cardTop + 8
  const clearBottom = legend
    ? legend.getBoundingClientRect().top - chartRect.top - 4
    : cardBottom - 8
  let maxTop = clearBottom - height
  // Very short cards: allow overlapping the legend rather than spilling out.
  if (maxTop < minTop) maxTop = cardBottom - 8 - height
  const above = cellRect.top - chartRect.top - height - 12
  const below = cellRect.bottom - chartRect.top + 12
  const preferred = above >= minTop ? above : below
  const top = Math.max(Math.min(minTop, maxTop), Math.min(maxTop, preferred))
  const cellCenter = cellRect.top - chartRect.top + cellRect.height / 2
  tooltip.dataset.side = top + height <= cellCenter ? 'top' : 'bottom'
  tooltip.style.top = `${Math.round(top)}px`
  const arrow = tooltip.querySelector('.usage-heat-tip-arrow')
  if (arrow) arrow.style.left = `${Math.round(Math.max(14, Math.min(width - 14, center - left)))}px`
}

// Rich tooltip with a 150ms hide debounce (so moving across adjacent cells does
// not flicker), scroll-closes, and keyboard support through the focusable cells.
function usageBindHeatmap(heatmap) {
  if (!usageHasOptionalApi('usageHeatmap') || !heatmap) return
  const chart = view.querySelector('[data-usage-heatmap]')
  const tooltip = view.querySelector('[data-usage-heatmap-tooltip]')
  const scroll = view.querySelector('[data-usage-heatmap-scroll]')
  if (!chart || !tooltip) return
  const model = window.usageFormat.layoutHeatmapWeeks(heatmap.weeks)
  const byDay = new Map()
  for (const column of model.columns) for (const cell of column) if (cell) byDay.set(cell.day, cell)
  const grid = chart.querySelector('.usage-heat-grid')
  const newestDay = [...byDay.keys()].at(-1)
  const newestCell = newestDay ? grid.querySelector(`[data-usage-heat-day="${CSS.escape(newestDay)}"]`) : null
  usageBindChartNavigation(grid, newestCell)
  let tooltipCell = null
  const hide = () => {
    usageClearHeatTooltip()
    usageHeatTooltipTimer = setTimeout(() => {
      usageHeatTooltipTimer = null
      tooltip.hidden = true
      tooltipCell = null
    }, 150)
  }
  const show = (cell) => {
    usageClearHeatTooltip()
    const data = byDay.get(cell.dataset.usageHeatDay)
    if (!data) return
    tooltipCell = cell
    tooltip.innerHTML = usageHeatTipHtml(data)
    tooltip.hidden = false
    usagePositionHeatTooltip(chart, tooltip, cell)
  }
  chart.querySelectorAll('[data-usage-heat-day]').forEach((cell) => {
    cell.addEventListener('mouseenter', () => show(cell))
    cell.addEventListener('focus', () => show(cell))
    cell.addEventListener('mouseleave', hide)
    cell.addEventListener('blur', hide)
  })
  chart.addEventListener('mouseleave', hide)
  if (scroll) {
    scroll.addEventListener('scroll', () => {
      usageClearHeatTooltip()
      if (tooltipCell && document.activeElement === tooltipCell) {
        const cellRect = tooltipCell.getBoundingClientRect()
        const scrollRect = scroll.getBoundingClientRect()
        if (cellRect.left >= scrollRect.left && cellRect.right <= scrollRect.right) {
          usagePositionHeatTooltip(chart, tooltip, tooltipCell)
          return
        }
      }
      tooltip.hidden = true
      tooltipCell = null
    }, { passive: true })
    if (scroll.scrollWidth > scroll.clientWidth) scroll.scrollLeft = scroll.scrollWidth
  }
  usageBindHeatScroll()
}

async function usageRefreshNow() {
  if (usageRefreshPending) return
  usageRefreshPending = true
  view.querySelectorAll('[data-usage-refresh]').forEach((button) => { button.disabled = true })
  try {
    const result = await window.electronAPI.usageRefresh({ reason: 'manual' })
    usageToast(result && result.started === false ? t('config.usage.scan.already-running') : t('config.usage.scan.started'))
    await usageRerenderKeepingDashboard()
  } catch (error) {
    usageToast(usageErrorText(error) || t('config.usage.scan.failed'))
    view.querySelectorAll('[data-usage-refresh]').forEach((button) => { button.disabled = false })
  } finally {
    usageRefreshPending = false
  }
}

async function usageClearData() {
  if (!window.confirm(t('config.usage.clear-confirm'))) return
  try {
    await window.electronAPI.usageClear()
    usageToast(t('config.usage.clear-done'))
    await usageRerenderKeepingDashboard()
  } catch (error) {
    usageToast(usageErrorText(error) || t('config.usage.clear-failed'))
  }
}

// Arrow affordance for the horizontally scrolled heatmap; the native thin
// scrollbar stays available too. Scroll-to-newest happens on first bind.
function usageBindHeatScroll() {
  const scroller = view.querySelector('[data-usage-heatmap-scroll]')
  if (!scroller) return
  const step = Math.max(160, Math.round(scroller.clientWidth * 0.6))
  view.querySelectorAll('[data-usage-heat-scroll]').forEach((button) => {
    button.onclick = () => {
      const direction = Number(button.dataset.usageHeatScroll) || 1
      const reduceMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
      scroller.scrollBy({ left: direction * step, behavior: reduceMotion ? 'auto' : 'smooth' })
    }
  })
}

function usageBindTrendExpand() {
  view.querySelectorAll('[data-usage-trend-expand]').forEach((button) => {
    button.onclick = () => usageOpenTrendModal()
  })
}

function usageBindDashboard(payload) {
  usageBindRefresh()
  usageBindCoverageActions()
  usageBindRetry()
  usageBindTabs()
  usageBindSourceFilter()
  usageBindOverviewControls()
  usageBindCustomRange()
  usageBindDailySort()
  usageBindTrendExpand()
  usageBindHeatScroll()
  usageBindExchangeControls()
  usageBindSnapshots()
  const dailyRows = payload && payload.daily && Array.isArray(payload.daily.rows) ? payload.daily.rows : []
  usageBindTrend(dailyRows)
  usageBindHeatmap(payload ? payload.heatmap : null)
}

function usageUnsubscribeProgress() {
  const unsubscribe = usageProgressUnsubscribe
  usageProgressUnsubscribe = null
  if (typeof unsubscribe !== 'function') return
  try {
    unsubscribe()
  } catch {
    // The preload listener is already gone; nothing to clean up.
  }
}

// ---------------------------------------------------------------------------
// Automatic refresh (plan §2.2: page-open increment + visible-window polling)
// ---------------------------------------------------------------------------

// True while the page is actually on screen. A minimized/occluded settings
// window has no reason to wake the disk, and the visibility listener runs once
// more on return, so skipping hidden ticks loses nothing.
function usagePageVisible() {
  return typeof document !== 'undefined' && document.visibilityState !== 'hidden'
}

function usageAutoRefreshSchedule() {
  usageAutoRefreshStopTimer()
  if (!usageRefreshInterval) return
  usageAutoRefreshTimer = setTimeout(() => {
    usageAutoRefreshTimer = null
    void usageAutoRefreshTick()
  }, usageRefreshInterval)
}

function usageAutoRefreshStopTimer() {
  if (usageAutoRefreshTimer === null) return
  clearTimeout(usageAutoRefreshTimer)
  usageAutoRefreshTimer = null
}

// Dropping the listeners is what keeps a re-render from multiplying them: every
// route entry and in-place re-query arms the probe again from a clean slate.
function usageAutoRefreshStop() {
  usageAutoRefreshStopTimer()
  const listeners = usageAutoRefreshListeners
  usageAutoRefreshListeners = null
  if (!listeners) return
  try {
    window.removeEventListener('focus', listeners.focus)
    document.removeEventListener('visibilitychange', listeners.visibility)
  } catch {
    // The window is tearing down; the listeners go with it.
  }
}

function usageAutoRefreshArm() {
  usageAutoRefreshStop()
  if (!usageRefreshInterval) return
  usageAutoRefreshSchedule()
  const focus = () => { void usageAutoRefreshTick() }
  const visibility = () => {
    if (!usagePageVisible()) return
    void usageAutoRefreshTick()
  }
  usageAutoRefreshListeners = { focus, visibility }
  window.addEventListener('focus', focus)
  document.addEventListener('visibilitychange', visibility)
}

// Route-leave teardown, called from config.js navigate(): the settings window is
// a single page that can sit on another route for hours, so nothing on this page
// may keep ticking or listening once it is off screen.
function usageDeactivate() {
  usageAutoRefreshStop()
  usageAutoRefreshRenderPending = false
  usageUnsubscribeProgress()
  usageDashboardPayload = null
}

// The single scan trigger behind page-open, the poll and the focus/visibility
// listeners. The engine still owns the real floor (5 minutes, see
// usage-collector.js): a throttled answer means the data on disk is recent
// enough that repainting would be pure churn.
//
// A started scan repaints the page when its `done` progress push arrives, so this
// function intentionally does not re-query anything itself.
async function usageAutoRefreshTick() {
  if (currentRoute !== 'usage') {
    usageAutoRefreshStop()
    return
  }
  if (!usageHasApi('usageRefresh')) return
  if (!usagePageVisible()) {
    usageAutoRefreshSchedule()
    return
  }
  // One request in flight at a time: `usageRefresh` is cheap but a stalled IPC
  // reply must not let ticks pile up behind it.
  if (usageAutoRefreshInFlight) {
    usageAutoRefreshSchedule()
    return
  }
  usageAutoRefreshInFlight = true
  try {
    await window.electronAPI.usageRefresh({ reason: 'page-open' })
  } catch {
    // Disabled or engine gone: the page stays readable and the next tick retries.
  } finally {
    usageAutoRefreshInFlight = false
    if (currentRoute === 'usage') usageAutoRefreshSchedule()
  }
}

// Scan-progress pushes keep the coverage strip alive between renders. Leaving
// the route drops the subscription so a finishing scan cannot repaint another
// page; entering again re-subscribes from renderUsage().
function usageSubscribeProgress() {
  usageUnsubscribeProgress()
  if (!usageHasApi('onUsageScanProgress')) return
  try {
    usageProgressUnsubscribe = window.electronAPI.onUsageScanProgress((progress) => {
      if (currentRoute !== 'usage') {
        usageUnsubscribeProgress()
        return
      }
      usageApplyProgress(progress)
    })
  } catch {
    usageProgressUnsubscribe = null
  }
}

function usageApplyProgress(progress) {
  if (!progress || typeof progress !== 'object') return
  const page = view.querySelector('.usage-page')
  if (!page) return
  const refresh = view.querySelector('#refreshUsage')
  if (refresh && progress.done !== true) {
    refresh.disabled = true
    refresh.setAttribute('aria-busy', 'true')
    const label = refresh.querySelector('span')
    if (label) label.textContent = t('config.usage.state.scanning-title')
  }
  const scan = page.querySelector('[data-usage-scan]')
  if (scan) {
    scan.hidden = false
    const text = scan.querySelector('.usage-scan-text')
    const bar = scan.querySelector('.usage-scan-bar')
    if (text) text.textContent = usageScanText(progress)
    if (bar) bar.style.width = `${usageScanPercent(progress)}%`
  }
  if (progress.done !== true) return
  usageRefreshPending = false
  // A background (auto) scan finishing must not blank the page back to the
  // loading card the way a route entry does, and it must not tear down an open
  // trend modal. Both are handled by the in-place path: repaint the mounted
  // dashboard, or defer the repaint until the modal closes.
  if (usageTrendModal) {
    usageAutoRefreshRenderPending = true
    return
  }
  void usageRerenderKeepingDashboard()
}

window.configRoutes = window.configRoutes || {}
window.configRoutes['renderUsage'] = () => renderUsage()
