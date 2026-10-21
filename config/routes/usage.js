// B4/B5/B6 (usage line): the "AI usage" settings-window route — visual redesign.
//
// The page is a read-only dashboard over the frozen `usage:*` IPC contract
// (plan §2.7 / §2.8). This revision reworks the presentation around a calm,
// high-density "instrument panel" that translates TokenTracker's dashboard
// rhythm into Nightshift: warm surfaces, one user accent, monospace numbers and
// a single unified card system.
//
// Layout: page head -> slim coverage strip -> segmented period tabs (custom
// date row appears only while the custom tab is selected) -> dashboard grid. At
// default window widths the grid is one column; >=760px of page content puts the
// model-share/trend pair side by side; >=1080px switches to a two-column TT-like
// arrangement (left: KPI + model share + trend; right: hero + daily table;
// heatmap and the day-view hourly card span the full width). The switch is a
// CONTAINER query on `.usage-page`, not a viewport media query, because the
// settings window's content area is narrower than the viewport.
//
// Data access is feature-probed: a missing engine renders a neutral "not
// connected" error state with retry instead of demo data; the optional B5/B6
// channels (hourly/heatmap) hide only their own card. The heatmap tooltip reads
// the optional per-day `cell.models` split defensively and degrades to the day
// total when the engine revision does not carry it yet.
//
// Re-render safety follows history.js: renderUsage() can run again at any time
// (period change, refresh, language hot switch) and async continuations are
// guarded by `currentRoute === 'usage'` plus a render version counter. No
// document-level listeners: every handler is bound to an element this route
// owns, and the single IPC subscription is dropped when the route is left.

const USAGE_DEFAULT_PERIOD = 'month'
const USAGE_TREND_DAYS = 30
const USAGE_MODEL_LIMIT = 5
const USAGE_HEATMAP_WEEKS = 52
const USAGE_HEATMAP_TICK_MIN_SPAN = 1
const USAGE_DAY_VIEW_PERIOD = 'day'
const USAGE_CUSTOM_PERIOD = 'custom'

// Period tabs in display order. The custom tab reveals the date range row; the
// resolves through t() on every render so a language switch needs no reload.
const USAGE_PERIODS = [
  { id: 'day', labelKey: 'config.usage.tab.day' },
  { id: 'week', labelKey: 'config.usage.tab.week' },
  { id: 'month', labelKey: 'config.usage.tab.month' },
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

// Long-form period names for the KPI sub-label and range descriptions
// (long-form names such as "this month" instead of the bare tab label).
const USAGE_PERIOD_LONG_KEYS = {
  day: 'config.usage.period.day',
  week: 'config.usage.period.week',
  month: 'config.usage.period.month',
  total: 'config.usage.period.total',
  custom: 'config.usage.period.custom'
}

// Page-level state banner copy. `data-usage-state` on the page root carries the
// same id, which keeps the e2e/debug surface and the rendered copy in step.
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
let usageDailySort = 'desc'
let usageDailyRowCache = []
let usageProgressUnsubscribe = null
let usageRefreshPending = false
let usageHeatTooltipTimer = null

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
// fall back to the month tab with a toast.
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
  if (usagePeriod === USAGE_CUSTOM_PERIOD) {
    return { period: 'custom', tz, from: usageRange.from, to: usageRange.to }
  }
  return { period: usagePeriod, tz }
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
  return window.usageFormat.formatCompactToken(usageNumber(value), usageLanguage())
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

function usageSourceLabel(source) {
  const id = source && source.source ? source.source : ''
  const key = USAGE_SOURCE_LABEL_KEYS[id]
  if (key) return t(key)
  return (source && source.label) || id
}

function usageSourceStateKey(state) {
  return USAGE_SOURCE_STATE_KEYS[state] ? state : 'absent'
}

function usagePeriodLabel(period) {
  const entry = USAGE_PERIODS.find((item) => item.id === period) || USAGE_PERIODS[2]
  return t(entry.labelKey)
}

// Long-form period name for labels ("this month", "this week", custom range).
function usagePeriodLongLabel(period) {
  const key = USAGE_PERIOD_LONG_KEYS[period] || USAGE_PERIOD_LONG_KEYS[USAGE_DEFAULT_PERIOD]
  return t(key)
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

// One primary-derived tone per source. The first three are deliberately spread
// (100 / 58 / 30 % of the accent over the surface ladder) so three sources are
// distinguishable in both themes, not three near-identical ambers.
const USAGE_SHARE_TONES = [100, 58, 30, 20, 12]

function usageShareTone(index) {
  return USAGE_SHARE_TONES[index % USAGE_SHARE_TONES.length]
}

function usageShareColor(index) {
  return `color-mix(in srgb,var(--primary) ${usageShareTone(index)}%,var(--surface-3))`
}

function usageShareSources(sources) {
  return sources
    .filter((source) => usageNumber(source && source.billable_total_tokens) > 0)
    .sort((a, b) => usageNumber(b.billable_total_tokens) - usageNumber(a.billable_total_tokens))
}

function usageActiveDayCount(rows) {
  return rows.filter((row) => usageNumber(row && row.billable_total_tokens) > 0 || usageNumber(row && row.conversation_count) > 0).length
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

// Icon+text refresh action: the only extra glyph on the page is this action
// affordance (no decorative icons anywhere else).
function usageRefreshButtonHtml() {
  const icon = typeof iconMarkup === 'function' ? iconMarkup('icons/history.svg') : ''
  return `<button class="button usage-refresh-button" type="button" data-usage-refresh>${icon}<span>${t('config.usage.refresh')}</span></button>`
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
    lastScan = status && status.lastScanAt
      ? t('config.usage.coverage.last-scan', { time: usageDateTime(status.lastScanAt) })
      : t('config.usage.coverage.never-scanned')
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
    <p class="usage-unsupported-note">${t('config.usage.coverage.cursor-note')}</p>
  </div>`
}

// ---------------------------------------------------------------------------
// Toolbar: segmented tabs + custom range (only while the custom tab is active)
// ---------------------------------------------------------------------------

function usageTabsHtml() {
  const buttons = USAGE_PERIODS.map((period) => {
    const selected = period.id === usagePeriod
    return `<button class="usage-segment${selected ? ' is-active' : ''}" type="button" role="tab" data-usage-tab="${period.id}" aria-selected="${selected}" tabindex="${selected ? 0 : -1}">${t(period.labelKey)}</button>`
  }).join('')
  return `<div class="usage-toolbar">
    <div class="usage-segmented" role="tablist" aria-label="${escapeHtml(t('config.usage.tabs-label'))}">${buttons}</div>
    ${usagePeriod === USAGE_CUSTOM_PERIOD ? usageCustomRangeHtml() : ''}
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
// KPI tiles
// ---------------------------------------------------------------------------

function usageKpiTileHtml(item) {
  return `<div class="usage-kpi">
    <span class="usage-kpi-label">${escapeHtml(item.label)}</span>
    <b class="usage-kpi-value" title="${escapeHtml(item.full)}">${escapeHtml(item.value)}</b>
    <small class="usage-kpi-sub">${escapeHtml(item.sub)}</small>
  </div>`
}

function usageKpisHtml(summary) {
  const rolling = summary && summary.rolling && typeof summary.rolling === 'object' ? summary.rolling : {}
  const last7 = rolling.last7d && typeof rolling.last7d === 'object' ? rolling.last7d : {}
  const last30 = rolling.last30d && typeof rolling.last30d === 'object' ? rolling.last30d : {}
  const totals = summary && summary.totals && typeof summary.totals === 'object' ? summary.totals : {}
  const cards = [
    {
      label: t('config.usage.kpi.last-7d'),
      value: usageCompact(last7.billable_total_tokens),
      full: usageFull(last7.billable_total_tokens),
      sub: t('config.usage.kpi.conversations-in-range', { count: usageNumber(last7.conversation_count) })
    },
    {
      label: t('config.usage.kpi.last-30d'),
      value: usageCompact(last30.billable_total_tokens),
      full: usageFull(last30.billable_total_tokens),
      sub: t('config.usage.kpi.conversations-in-range', { count: usageNumber(last30.conversation_count) })
    },
    {
      label: t('config.usage.kpi.avg-per-active-day'),
      value: usageCompact(rolling.avgPerActiveDay),
      full: usageFull(rolling.avgPerActiveDay),
      sub: t('config.usage.kpi.active-days', { count: usageNumber(rolling.activeDays) })
    },
    {
      label: t('config.usage.kpi.conversations'),
      value: usageFull(totals.conversation_count),
      full: usageFull(totals.conversation_count),
      sub: usagePeriodLongLabel((summary && summary.period) || usagePeriod)
    }
  ]
  return `<section class="usage-kpis" id="usageKpis">${cards.map(usageKpiTileHtml).join('')}</section>`
}

// ---------------------------------------------------------------------------
// Hero: the one big number + source share + provider cards
// ---------------------------------------------------------------------------

function usageProviderCardHtml(source, index, isAll, totals, modelsCount) {
  const color = isAll ? 'var(--primary)' : usageShareColor(index)
  const label = isAll ? t('config.usage.providers.all') : usageSourceLabel(source)
  const percent = isAll ? 100 : usageNumber(source && source.sharePct)
  const modelCount = isAll ? modelsCount : usageNumber(source && source.modelCount)
  const conversations = isAll ? usageNumber(totals.conversation_count) : usageNumber(source && source.conversationCount)
  const sub = `${t('config.usage.breakdown.model-count', { count: modelCount })} · ${t('config.usage.breakdown.conversations', { count: conversations })}`
  return `<div class="usage-provider${isAll ? ' usage-provider-all' : ''}" data-usage-source="${escapeHtml(isAll ? 'all' : (source && source.source))}">
    <span class="usage-provider-head"><i class="usage-provider-dot" style="background:${color}" aria-hidden="true"></i><span>${escapeHtml(label)}</span></span>
    <b class="usage-provider-pct">${usageShare(percent)}</b>
    <small class="usage-provider-sub">${escapeHtml(sub)}</small>
  </div>`
}

function usageHeroHtml(summary, sources, models, dailyRows) {
  const totals = summary && summary.totals && typeof summary.totals === 'object' ? summary.totals : {}
  const billable = usageNumber(totals.billable_total_tokens)
  const range = usageRangeLabel(summary)
  const activeDays = usageActiveDayCount(dailyRows)
  const shareSources = usageShareSources(sources)
  const shareTotal = shareSources.reduce((sum, source) => sum + usageNumber(source.billable_total_tokens), 0)

  let shareBar = `<div class="usage-hero-empty">${t('config.usage.breakdown.empty')}</div>`
  let shareLegend = ''
  if (shareSources.length > 0 && shareTotal > 0) {
    const segments = shareSources.map((source, index) => {
      const percent = (usageNumber(source.billable_total_tokens) / shareTotal) * 100
      return `<i class="usage-share-seg" data-usage-source="${escapeHtml(source.source)}" style="width:${percent.toFixed(2)}%;background:${usageShareColor(index)}"></i>`
    }).join('')
    const legend = shareSources.map((source, index) => {
      const percent = (usageNumber(source.billable_total_tokens) / shareTotal) * 100
      return `<span class="usage-share-key" data-usage-source="${escapeHtml(source.source)}" title="${escapeHtml(`${usageSourceLabel(source)} ${usageShare(percent)}`)}">
        <i class="usage-share-dot" style="background:${usageShareColor(index)}" aria-hidden="true"></i>
        <span>${escapeHtml(usageSourceLabel(source))}</span>
        <b>${usageShare(percent)}</b>
      </span>`
    }).join('')
    shareBar = `<div class="usage-share-bar" role="img" aria-label="${escapeHtml(t('config.usage.overview.share'))}">${segments}</div>`
    shareLegend = `<div class="usage-share-legend">${legend}</div>`
  }

  const providers = [
    usageProviderCardHtml(null, 0, true, totals, models.length),
    ...sources.map((source, index) => usageProviderCardHtml(source, index, false, totals, models.length))
  ].join('')
  const meta = [range, t('config.usage.kpi.active-days', { count: activeDays })].filter(Boolean).join(' · ')

  return `<section class="usage-card usage-hero">
    <span class="usage-hero-label">${t('config.usage.hero.total')}</span>
    <b class="usage-hero-number" id="usageTotal" title="${escapeHtml(usageFull(billable))}">${escapeHtml(usageCompact(billable))}</b>
    <span class="usage-hero-meta">${escapeHtml(meta)}</span>
    <div class="usage-hero-share">
      ${shareBar}
      ${shareLegend}
    </div>
    <div class="usage-providers">${providers}</div>
  </section>`
}

// ---------------------------------------------------------------------------
// Model share card (ranked top N + aggregated tail)
// ---------------------------------------------------------------------------

// Bar width is relative to the TOP model so the ranking reads instantly; the
// percentage text stays the true share of the period total.
function usageModelRowHtml(row, options = {}) {
  const isOther = options.isOther === true
  const maxTokens = usageNumber(options.maxTokens)
  const totalTokens = usageNumber(options.totalTokens)
  const share = row.sharePct > 0
    ? row.sharePct
    : (totalTokens > 0 ? (row.tokens / totalTokens) * 100 : 0)
  const width = maxTokens > 0 ? usageClampPct((row.tokens / maxTokens) * 100) : 0
  const sourceLabel = usageSourceLabel({ source: row.source })
  const name = isOther ? t('config.usage.models.other', { count: row.count }) : row.model
  const rankMark = isOther ? '+' : String(row.rank)
  const rankClass = !isOther && row.rank === 1 ? ' is-top' : ''
  const rowTitle = `${name} · ${usageFull(row.tokens)} · ${usageShare(share)}`
  return `<div class="usage-model-row${isOther ? ' usage-model-other' : ''}" data-usage-model="${escapeHtml(isOther ? 'other' : row.model)}" title="${escapeHtml(rowTitle)}">
    <span class="usage-model-rank${rankClass}">${rankMark}</span>
    <div class="usage-model-body">
      <div class="usage-model-line">
        <b class="usage-model-name" title="${escapeHtml(isOther ? name : row.model)}">${escapeHtml(name)}</b>
        ${isOther || !sourceLabel ? '' : `<span class="usage-model-source">${escapeHtml(sourceLabel)}</span>`}
        <span class="usage-model-pct">${usageShare(share)}</span>
      </div>
      <div class="usage-model-bar" aria-hidden="true"><i style="width:${width.toFixed(2)}%"></i></div>
    </div>
  </div>`
}

function usageModelsHtml(models) {
  const model = window.usageFormat.projectModelShareRows(models, USAGE_MODEL_LIMIT)
  const maxTokens = model.top.length > 0 ? model.top[0].tokens : 0
  const options = { maxTokens, totalTokens: model.totalTokens }
  const rows = model.top.map((row) => usageModelRowHtml(row, options)).join('')
  const other = model.other ? usageModelRowHtml(model.other, { ...options, isOther: true }) : ''
  const body = model.top.length > 0
    ? `${rows}${other}`
    : `<div class="usage-empty-text">${t('config.usage.breakdown.empty')}</div>`
  return `<section class="usage-card usage-models" id="usageBreakdown">
    <div class="usage-card-head">
      <h2>${t('config.usage.models.title')}</h2>
      <span>${t('config.usage.breakdown.model-count', { count: models.length })}</span>
    </div>
    <div class="usage-model-list">${body}</div>
  </section>`
}

// ---------------------------------------------------------------------------
// Trend card (30-day stacked bars + rich hover tooltip)
// ---------------------------------------------------------------------------

function usageTrendRows(daily, trend) {
  const preferred = trend && Array.isArray(trend.rows) ? trend.rows : null
  const fallback = daily && Array.isArray(daily.rows) ? daily.rows : []
  const rows = (preferred || fallback)
    .filter((row) => row && typeof row.day === 'string')
    .slice()
    .sort((a, b) => String(a.day).localeCompare(String(b.day)))
  return rows.slice(-USAGE_TREND_DAYS)
}

function usageTrendSegments(row) {
  const input = usageNumber(row && row.input_tokens)
  const cache = usageNumber(row && row.cached_input_tokens)
  const output = usageNumber(row && row.output_tokens)
  const stackSum = input + cache + output
  const total = usageNumber(row && row.billable_total_tokens) || stackSum
  return { input, cache, output, stackSum, total }
}

function usageTrendLegendHtml() {
  return `<div class="usage-trend-legend">${USAGE_TREND_SEGMENTS.map((segment) => `<span class="usage-trend-key"><i class="usage-trend-dot ${segment.dotClass}" aria-hidden="true"></i>${t(segment.labelKey)}</span>`).join('')}</div>`
}

function usageTrendTooltipHtml(row) {
  const segments = usageTrendSegments(row)
  const total = segments.total
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

function usageTrendHtml(daily, trend) {
  const rows = usageTrendRows(daily, trend)
  const maxTotal = rows.reduce((max, row) => Math.max(max, usageTrendSegments(row).total), 0)
  let chart = `<div class="usage-empty-text">${t('config.usage.trend.empty')}</div>`
  let axis = ''
  if (rows.length > 0 && maxTotal > 0) {
    const columns = rows.map((row) => {
      const segments = usageTrendSegments(row)
      const barHeight = Math.max(2, Math.round((segments.total / maxTotal) * 100))
      const segmentHeight = (value) => (segments.total > 0 ? Math.max(0, (value / segments.total) * 100) : 0)
      const tooltip = usageTrendTooltipHtml(row)
      const stack = segments.total > 0
        ? `<div class="usage-trend-stack" style="height:${barHeight}%">
            <i class="usage-trend-seg usage-trend-output" style="height:${segmentHeight(segments.output).toFixed(2)}%"></i>
            <i class="usage-trend-seg usage-trend-cache" style="height:${segmentHeight(segments.cache).toFixed(2)}%"></i>
            <i class="usage-trend-seg usage-trend-input" style="height:${segmentHeight(segments.input).toFixed(2)}%"></i>
          </div>`
        : '<div class="usage-trend-stack usage-trend-empty" style="height:2px"></div>'
      return `<div class="usage-trend-col" tabindex="0" role="img" data-usage-day="${escapeHtml(row.day)}" aria-label="${escapeHtml(tooltip.label)}">${stack}</div>`
    }).join('')
    chart = `<div class="usage-trend-chart">
      <div class="usage-trend-gridlines" aria-hidden="true"><i></i><i></i><i></i></div>
      <span class="usage-trend-max" aria-hidden="true">${escapeHtml(usageCompact(maxTotal))}</span>
      <div class="usage-trend-bars" data-usage-trend>
        ${columns}
        <div class="usage-tooltip usage-trend-tooltip" data-usage-tooltip hidden></div>
      </div>
    </div>`
    axis = `<div class="usage-trend-axis"><span>${escapeHtml(rows[0].day)}</span><span>${escapeHtml(rows[rows.length - 1].day)}</span></div>`
  }
  return `<section class="usage-card usage-trend" id="usageTrend">
    <div class="usage-card-head">
      <h2>${t('config.usage.trend.title')}</h2>
      ${usageTrendLegendHtml()}
    </div>
    ${chart}
    ${axis}
  </section>`
}

// ---------------------------------------------------------------------------
// Daily detail table (sticky header, sortable date, compact rows)
// ---------------------------------------------------------------------------

function usageTableCell(value, compact, blank = false) {
  if (blank || value === null || value === undefined || value === '') return '<td class="num">—</td>'
  const number = usageNumber(value)
  const text = compact ? usageCompact(number) : usageFull(number)
  return `<td class="num" title="${escapeHtml(usageFull(number))}">${escapeHtml(text)}</td>`
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
    return `<tr><td class="usage-table-empty" colspan="7">${t('config.usage.table.empty')}</td></tr>`
  }
  return sorted.map((row) => {
    // A fully empty day (no tokens and no conversations) reads as "—" like TT's
    // table instead of a wall of zeros.
    const empty = usageNumber(row.billable_total_tokens) === 0 && usageNumber(row.conversation_count) === 0
    return `<tr data-usage-day="${escapeHtml(row.day)}"${empty ? ' class="is-empty"' : ''}>
        <td class="usage-date">${escapeHtml(row.day)}</td>
        ${usageTableCell(row.billable_total_tokens, true, empty)}
        ${usageTableCell(row.input_tokens, true, empty)}
        ${usageTableCell(row.output_tokens, true, empty)}
        ${usageTableCell(row.cached_input_tokens, true, empty)}
        ${usageTableCell(row.reasoning_output_tokens, true, empty)}
        ${usageTableCell(row.conversation_count, false, empty)}
      </tr>`
  }).join('')
}

function usageDailyTableHtml(rows) {
  const sortedCount = usageSortDailyRows(rows, usageDailySort).length
  const sortState = usageDailySort === 'desc' ? 'descending' : 'ascending'
  const arrow = usageDailySort === 'desc' ? '↓' : '↑'
  const head = [
    ['config.usage.table.date', ''],
    ['config.usage.table.total', 'num'],
    ['config.usage.table.input', 'num'],
    ['config.usage.table.output', 'num'],
    ['config.usage.table.cache-read', 'num'],
    ['config.usage.table.reasoning', 'num'],
    ['config.usage.table.conversations', 'num']
  ].map(([key, className], index) => {
    if (index === 0) {
      return `<th scope="col" class="${className}" aria-sort="${sortState}"><button class="usage-sort-button" type="button" data-usage-sort="date" aria-label="${escapeHtml(t('config.usage.table.sort'))}">${t(key)}<i class="usage-sort-arrow" aria-hidden="true">${arrow}</i></button></th>`
    }
    return `<th scope="col" class="${className}">${t(key)}</th>`
  }).join('')
  return `<section class="usage-card usage-daily">
    <div class="usage-card-head">
      <h2>${t('config.usage.table.title')}</h2>
      <span>${t('config.usage.table.rows', { count: sortedCount })}</span>
    </div>
    <div class="usage-table-wrap">
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
  if (!cell) return '<i class="usage-heat-cell is-empty" aria-hidden="true"></i>'
  const levelClass = window.usageFormat.heatmapLevelClass(cell.level)
  return `<i class="usage-heat-cell ${levelClass}" tabindex="0" role="img" data-usage-heat-day="${escapeHtml(cell.day)}" data-usage-heat-level="${cell.level}" aria-label="${escapeHtml(usageHeatmapLabel(cell))}"></i>`
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
function usageHeatmapHtml(heatmap) {
  if (!usageHasOptionalApi('usageHeatmap')) return ''
  if (!heatmap) return ''
  const model = window.usageFormat.layoutHeatmapWeeks(heatmap.weeks)
  const activeDays = usageNumber(heatmap.activeDays)
  const head = `<div class="usage-card-head">
    <h2>${t('config.usage.heatmap.title')}</h2>
    <span>${t('config.usage.heatmap.hint')} · ${t('config.usage.heatmap.active-days', { count: activeDays })}</span>
  </div>`
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
  const cells = model.columns.map((column) => column.map(usageHeatmapCellHtml).join('')).join('')
  const legend = ['0', '1', '2', '3', '4'].map((level) => `<i class="usage-heat-swatch level-${level}" aria-hidden="true"></i>`).join('')
  return `<section class="usage-card usage-heatmap" id="usageHeatmap">
    ${head}
    <div class="usage-heatmap-chart" data-usage-heatmap>
      <div class="usage-heat-weekdays" aria-hidden="true">${weekdayLabels}</div>
      <div class="usage-heatmap-scroll" data-usage-heatmap-scroll>
        <div class="usage-heatmap-canvas" style="--usage-heat-weeks:${model.columns.length}">
          <div class="usage-heatmap-months">${monthLabels}</div>
          <div class="usage-heatmap-grid">${cells}</div>
        </div>
      </div>
      <div class="usage-heat-tip" data-usage-heatmap-tooltip hidden></div>
    </div>
    <div class="usage-heatmap-foot">
      <div class="usage-heatmap-legend"><span>${t('config.usage.heatmap.less')}</span>${legend}<span>${t('config.usage.heatmap.more')}</span></div>
    </div>
  </section>`
}

// ---------------------------------------------------------------------------
// Day-view hourly card
// ---------------------------------------------------------------------------

function usageHourlyLabel(row, clock) {
  return window.usageFormat.formatTooltip({
    title: clock || t('config.usage.hourly.title'),
    rows: [
      { label: t('config.usage.trend.total'), value: row && row.billable_total_tokens },
      { label: t('config.usage.trend.input'), value: row && row.input_tokens },
      { label: t('config.usage.trend.output'), value: row && row.output_tokens },
      { label: t('config.usage.kpi.conversations'), value: row && row.conversation_count }
    ]
  }).replace(/\n/g, '; ')
}

function usageHourClock(value) {
  const hour = String(value || '')
  return hour.length >= 16 ? hour.slice(11, 16) : ''
}

function usageHourlyHtml(hourly) {
  // Day view only, and only when the channel exists; every other period keeps
  // the page identical to its pre-hourly composition.
  if (usagePeriod !== USAGE_DAY_VIEW_PERIOD || !usageHasOptionalApi('usageHourly') || !hourly) return ''
  const rows = Array.isArray(hourly.rows) ? hourly.rows : []
  const day = hourly.day || usageToday()
  const head = `<div class="usage-card-head">
    <h2>${t('config.usage.hourly.title')}</h2>
    <span>${escapeHtml(day)} · ${t('config.usage.hourly.hint')}</span>
  </div>`
  if (rows.length === 0) {
    return `<section class="usage-card usage-hourly" id="usageHourly">${head}<div class="usage-empty-text">${t('config.usage.hourly.empty')}</div></section>`
  }
  const max = rows.reduce((value, row) => Math.max(value, usageNumber(row && row.billable_total_tokens)), 0)
  const bars = rows.map((row) => {
    const value = usageNumber(row && row.billable_total_tokens)
    const height = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 2
    const clock = usageHourClock(row && row.hour)
    const label = usageHourlyLabel(row, clock)
    return `<div class="usage-hourly-col" data-usage-hour="${escapeHtml(clock)}" tabindex="0" role="img" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}"><i class="usage-hourly-bar${value > 0 ? '' : ' is-empty'}" style="height:${height}%"></i></div>`
  }).join('')
  const axisHours = [0, 6, 12, 18, rows.length - 1].map((index) => usageHourClock(rows[Math.min(index, rows.length - 1)] && rows[Math.min(index, rows.length - 1)].hour)).filter(Boolean)
  const axis = `<div class="usage-hourly-axis">${axisHours.map((hour) => `<span>${escapeHtml(hour)}</span>`).join('')}</div>`
  return `<section class="usage-card usage-hourly" id="usageHourly">${head}<div class="usage-hourly-chart" data-usage-hourly>${bars}</div>${axis}</section>`
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
// Dashboard composition
// ---------------------------------------------------------------------------

function usageRenderDashboard(renderVersion, payload) {
  if (!usageIsCurrent(renderVersion)) return
  const status = payload.status
  const summary = payload.summary && typeof payload.summary === 'object' ? payload.summary : {}
  const daily = payload.daily && typeof payload.daily === 'object' ? payload.daily : {}
  const breakdown = payload.breakdown && typeof payload.breakdown === 'object' ? payload.breakdown : {}
  const totals = summary.totals && typeof summary.totals === 'object' ? summary.totals : {}
  const dailyRows = Array.isArray(daily.rows) ? daily.rows : []
  const sources = Array.isArray(breakdown.sources) ? breakdown.sources : []
  const models = Array.isArray(breakdown.models) ? breakdown.models : []
  const state = usageResolvePageState(status, totals)
  usageDailyRowCache = dailyRows

  view.innerHTML = `<div class="page usage-page" data-usage-state="${escapeHtml(state)}">
    ${usageHeaderHtml(usageRefreshButtonHtml())}
    ${usageCoverageHtml(status)}
    ${usageStateBannerHtml(state)}
    ${usageTabsHtml()}
    <div class="usage-dashboard" data-usage-view="${escapeHtml(usagePeriod)}">
      ${usageKpisHtml(summary)}
      ${usageHeroHtml(summary, sources, models, dailyRows)}
      ${usageModelsHtml(models)}
      ${usageTrendHtml(daily, payload.trend)}
      ${usageDailyTableHtml(dailyRows)}
      ${usageHeatmapHtml(payload.heatmap)}
      ${usageHourlyHtml(payload.hourly)}
    </div>
  </div>`
  usageBindDashboard(payload)
  usageSubscribeProgress()
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

// The contract has no rolling daily channel, so the trend uses the custom
// period range (plan §2.7 keeps `from`/`to` on every query). If a build does not
// answer that call yet, the card falls back to the selected period's daily rows
// instead of failing the whole page.
async function usageLoadTrend(renderVersion) {
  const format = window.usageFormat
  const today = format.toDayKey(new Date())
  const from = format.addDays(today, -(USAGE_TREND_DAYS - 1))
  if (!today || !from) return null
  try {
    const result = await window.electronAPI.usageDaily({ period: 'custom', tz: usageTimezone(), from, to: today })
    if (!usageIsCurrent(renderVersion)) return null
    return result && Array.isArray(result.rows) ? result : null
  } catch {
    return null
  }
}

async function usageRenderRoute() {
  const renderVersion = ++usageRenderVersion
  usageUnsubscribeProgress()
  usageClearHeatTooltip()
  usageRefreshPending = false

  const missing = usageMissingMethods()
  if (missing.length > 0) {
    usageRenderStandaloneError(renderVersion, t('config.usage.state.error-title'), t('config.usage.state.api-missing'))
    return
  }

  usageRenderLoading(renderVersion)

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

  usageNormalizeRange()
  const params = usageQueryParams()
  // Optional channels: rejections collapse to null so a missing/not-yet-
  // implemented heatmap or hourly channel hides its card instead of failing the
  // whole page (the required four channels keep the strict Promise.all below).
  const heatmapRequest = usageHasOptionalApi('usageHeatmap')
    ? window.electronAPI.usageHeatmap({ tz: params.tz, weeks: USAGE_HEATMAP_WEEKS }).catch(() => null)
    : Promise.resolve(null)
  const hourlyRequest = usagePeriod === USAGE_DAY_VIEW_PERIOD && usageHasOptionalApi('usageHourly')
    ? window.electronAPI.usageHourly({ day: usageToday(), tz: params.tz }).catch(() => null)
    : Promise.resolve(null)
  let summary
  let daily
  let breakdown
  let heatmap
  let hourly
  try {
    [summary, daily, breakdown, heatmap, hourly] = await Promise.all([
      window.electronAPI.usageSummary(params),
      window.electronAPI.usageDaily(params),
      window.electronAPI.usageBreakdown({ ...params, scope: 'source' }),
      heatmapRequest,
      hourlyRequest
    ])
  } catch (error) {
    if (usageIsCurrent(renderVersion)) usageRenderLoadError(renderVersion, status, error)
    return
  }
  if (!usageIsCurrent(renderVersion)) return

  const trend = await usageLoadTrend(renderVersion)
  if (!usageIsCurrent(renderVersion)) return
  usageRenderDashboard(renderVersion, { status, summary, daily, breakdown, trend, heatmap, hourly })
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
        if (usageHasApi('usageRefresh')) {
          await window.electronAPI.usageRefresh({ reason: 'page-open' }).catch(() => null)
        }
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
      void renderUsage()
    }
  })
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
    void renderUsage()
    return
  }
  if (usagePeriod !== USAGE_CUSTOM_PERIOD) usagePeriodBeforeCustom = usagePeriod
  usageRange = { from: result.from, to: result.to }
  usagePeriod = USAGE_CUSTOM_PERIOD
  usageToast(t('config.usage.range.applied'))
  void renderUsage()
}

function usageCancelCustomRange() {
  usageRange = { from: '', to: '' }
  usagePeriod = usagePeriodBeforeCustom || USAGE_DEFAULT_PERIOD
  void renderUsage()
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

function usageBindTrend(dailyRows, trend) {
  const chart = view.querySelector('[data-usage-trend]')
  const tooltip = view.querySelector('[data-usage-tooltip]')
  if (!chart || !tooltip) return
  const trendRows = usageTrendRows({ rows: dailyRows }, trend)
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
  const legend = card.querySelector('.usage-heatmap-foot')
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
  const hide = () => {
    usageClearHeatTooltip()
    usageHeatTooltipTimer = setTimeout(() => {
      usageHeatTooltipTimer = null
      tooltip.hidden = true
    }, 150)
  }
  const show = (cell) => {
    usageClearHeatTooltip()
    const data = byDay.get(cell.dataset.usageHeatDay)
    if (!data) return
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
      tooltip.hidden = true
    }, { passive: true })
    if (scroll.scrollWidth > scroll.clientWidth) scroll.scrollLeft = scroll.scrollWidth
  }
}

async function usageRefreshNow() {
  if (usageRefreshPending) return
  usageRefreshPending = true
  view.querySelectorAll('[data-usage-refresh]').forEach((button) => { button.disabled = true })
  try {
    const result = await window.electronAPI.usageRefresh({ reason: 'manual' })
    usageToast(result && result.started === false ? t('config.usage.scan.already-running') : t('config.usage.scan.started'))
    await renderUsage()
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
    await renderUsage()
  } catch (error) {
    usageToast(usageErrorText(error) || t('config.usage.clear-failed'))
  }
}

function usageBindDashboard(payload) {
  usageBindRefresh()
  usageBindCoverageActions()
  usageBindRetry()
  usageBindTabs()
  usageBindCustomRange()
  usageBindDailySort()
  const dailyRows = payload && payload.daily && Array.isArray(payload.daily.rows) ? payload.daily.rows : []
  usageBindTrend(dailyRows, payload ? payload.trend : null)
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
  const scan = page.querySelector('[data-usage-scan]')
  if (scan) {
    scan.hidden = false
    const text = scan.querySelector('.usage-scan-text')
    const bar = scan.querySelector('.usage-scan-bar')
    if (text) text.textContent = usageScanText(progress)
    if (bar) bar.style.width = `${usageScanPercent(progress)}%`
  }
  if (progress.done === true) {
    usageRefreshPending = false
    void renderUsage()
  }
}

window.configRoutes = window.configRoutes || {}
window.configRoutes['renderUsage'] = () => renderUsage()
