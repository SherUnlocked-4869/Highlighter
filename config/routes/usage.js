// B4/B5 (usage line): the "AI usage" settings-window route.
//
// The page is a read-only instrument panel over the frozen `usage:*` IPC
// contract (plan §2.7 / §2.8): status coverage strip, period tabs, KPI strip,
// overview, source/model breakdown, 30-day trend, daily table and — B5
// completeness — a 52-week heatmap, an hourly day view and a custom range
// control. The data engine lands separately, so every IPC accessor is
// feature-probed here: a missing engine renders a neutral "not connected" error
// state with a retry button instead of demo data, and the optional B5 cards
// (hourly/heatmap) are simply omitted when their channel is not there.
//
// Re-render safety follows history.js: renderUsage() can run again at any time
// (period change, manual refresh, language hot switch) and async continuations
// are guarded by both `currentRoute === 'usage'` and a monotonically increasing
// render version, so a slow reply can never paint over another route.
//
// No document-level listeners: every handler is bound to an element this route
// owns, and the single IPC subscription is unsubscribed when the route is left
// or the next render starts.

const USAGE_DEFAULT_PERIOD = 'month'
const USAGE_TREND_DAYS = 30
const USAGE_MODEL_LIMIT = 8
const USAGE_HEATMAP_WEEKS = 52

// Period tabs in display order; labelKey resolves through t() on every render so
// a language switch needs no reload.
const USAGE_PERIODS = [
  { id: 'day', labelKey: 'config.usage.tab.day' },
  { id: 'week', labelKey: 'config.usage.tab.week' },
  { id: 'month', labelKey: 'config.usage.tab.month' },
  { id: 'total', labelKey: 'config.usage.tab.total' }
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

// The strip, the 7 states and the async guards are this route's whole contract;
// keep the accessor list here so the missing-engine path is one comparison.
const USAGE_REQUIRED_METHODS = ['usageStatus', 'usageSummary', 'usageDaily', 'usageBreakdown', 'usageRefresh', 'usageClear']

// B5 cards are progressive enhancement: their channels may arrive after the
// required ones, so a missing method hides just that card (never the page).
const USAGE_OPTIONAL_METHODS = ['usageHourly', 'usageHeatmap']

// Localized message per custom-range validation failure (helper reasons, see
// shared/usage-format.js validateCustomRange). Literals so the i18n checker can
// resolve them against the config table.
const USAGE_RANGE_REASON_KEYS = {
  from: 'config.usage.range.invalid',
  to: 'config.usage.range.invalid',
  order: 'config.usage.range.order',
  future: 'config.usage.range.future',
  span: 'config.usage.range.span',
  invalid: 'config.usage.range.invalid'
}

let usageRenderVersion = 0
let usagePeriod = USAGE_DEFAULT_PERIOD
let usageRange = { from: '', to: '' }
let usagePeriodBeforeCustom = USAGE_DEFAULT_PERIOD
let usageProgressUnsubscribe = null
let usageRefreshPending = false

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

// Custom period is only entered through the range control, but a stale range can
// survive a re-render/language switch; validate it before the IPC round trip and
// fall back to the month tab with a toast (plan B5-3).
function usageNormalizeRange() {
  if (usagePeriod !== 'custom') return
  const result = window.usageFormat.validateCustomRange(usageRange.from, usageRange.to, usageToday())
  if (result.valid) {
    usageRange = { from: result.from, to: result.to }
    return
  }
  usagePeriod = 'month'
  usageRange = { from: '', to: '' }
  usageToast(t(USAGE_RANGE_REASON_KEYS[result.reason] || 'config.usage.range.invalid'))
}

// Every query channel takes the same {period, tz, from?, to?} shape; the custom
// period is the only one that carries explicit bounds.
function usageQueryParams() {
  const tz = usageTimezone()
  if (usagePeriod === 'custom') {
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

// ---------------------------------------------------------------------------
// Page scaffold
// ---------------------------------------------------------------------------

function usageHeaderHtml(actionsHtml = '') {
  const actions = actionsHtml ? `<div class="page-head-actions">${actionsHtml}</div>` : ''
  return pageHeader(t('config.route.usage'), t('config.usage.subtitle'), actions)
}

function usageRefreshButtonHtml() {
  return `<button class="button" type="button" data-usage-refresh>${t('config.usage.refresh')}</button>`
}

function usageStateCardHtml(state, title, body, actionsHtml = '') {
  return `<div class="card usage-state-card usage-state-${state}" role="status">
    <b class="usage-state-title">${escapeHtml(title)}</b>
    <p class="usage-state-body">${escapeHtml(body)}</p>
    ${actionsHtml ? `<div class="usage-state-actions">${actionsHtml}</div>` : ''}
  </div>`
}

function usageRenderLoading(renderVersion) {
  if (!usageIsCurrent(renderVersion)) return
  view.innerHTML = `<div class="page usage-page" data-usage-state="loading">
    ${usageHeaderHtml()}
    <div class="empty">${t('config.usage.state.loading')}</div>
  </div>`
}

// Engine-not-integrated / status-read failure: no demo data and no coverage
// strip (there is no status payload to be honest about), just a retry action.
function usageRenderStandaloneError(renderVersion, title, body) {
  if (!usageIsCurrent(renderVersion)) return
  view.innerHTML = `<div class="page usage-page" data-usage-state="error">
    ${usageHeaderHtml()}
    ${usageStateCardHtml('error', title, body, `<button class="button" type="button" data-usage-retry>${t('config.usage.state.retry')}</button>`)}
  </div>`
  usageBindRetry()
}

function usageRenderConsent(renderVersion, status) {
  if (!usageIsCurrent(renderVersion)) return
  const points = USAGE_CONSENT_POINTS.map((key) => `<li>${t(key)}</li>`).join('')
  view.innerHTML = `<div class="page usage-page" data-usage-state="disabled">
    ${usageHeaderHtml(usageRefreshButtonHtml())}
    ${usageCoverageHtml(status, { disabled: true })}
    <div class="card usage-consent">
      <b class="usage-consent-title">${t('config.usage.consent.title')}</b>
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
    ${usageStateCardHtml('error', t('config.usage.state.error-title'), detail, `<button class="button" type="button" data-usage-retry>${t('config.usage.state.retry')}</button>`)}
  </div>`
  usageBindRetry()
  usageBindRefresh()
  usageBindCoverageActions()
  usageSubscribeProgress()
}

// ---------------------------------------------------------------------------
// Coverage strip (persistent)
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
  return `<span class="usage-source" data-usage-source="${escapeHtml(source && source.source)}" data-state="${escapeHtml(disabled ? 'disabled' : stateId)}" title="${escapeHtml(titleParts.join(' · '))}">
    <i class="usage-source-dot" aria-hidden="true"></i>
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

  const scanHtml = usageScanHtml(disabled ? null : status)

  let lastScan = ''
  if (!disabled) {
    lastScan = status && status.lastScanAt
      ? t('config.usage.coverage.last-scan', { time: usageDateTime(status.lastScanAt) })
      : t('config.usage.coverage.never-scanned')
  }

  const meta = []
  if (!disabled && status && usageNumber(status.dbBytes) > 0) meta.push(t('config.usage.coverage.db-size', { size: usageFormatBytes(status.dbBytes) }))
  if (!disabled && status && usageNumber(status.retentionMonths) > 0) meta.push(t('config.usage.coverage.retention', { months: usageNumber(status.retentionMonths) }))
  const clear = disabled ? '' : `<button class="button usage-clear-button" type="button" data-usage-clear>${t('config.usage.clear')}</button>`

  const errorBanner = !disabled && status && status.lastError
    ? `<div class="usage-banner usage-banner-error" role="alert">${escapeHtml(String(status.lastError))}</div>`
    : ''

  return `<div class="usage-coverage" id="usageCoverage">
    <div class="usage-coverage-head">
      <div class="usage-coverage-title">
        <b>${t('config.usage.coverage.title')}</b>
        <span>${t('config.usage.coverage.detected', { detected, total: USAGE_SUPPORTED_SOURCES.length })}</span>
        ${lastScan ? `<span class="usage-last-scan">${escapeHtml(lastScan)}</span>` : ''}
      </div>
      <div class="usage-coverage-actions">
        ${meta.map((item) => `<span class="usage-coverage-meta">${escapeHtml(item)}</span>`).join('')}
        ${clear}
      </div>
    </div>
    <div class="usage-coverage-sources">${chips}</div>
    ${scanHtml}
    ${errorBanner}
    <p class="usage-unsupported-note">${t('config.usage.coverage.cursor-note')}</p>
  </div>`
}

// ---------------------------------------------------------------------------
// KPI strip, overview, breakdown, trend, daily table
// ---------------------------------------------------------------------------

function usageKpiCardHtml(item) {
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
      sub: usagePeriodLabel((summary && summary.period) || usagePeriod)
    }
  ]
  return `<div class="usage-stats" id="usageKpis">${cards.map(usageKpiCardHtml).join('')}</div>`
}

// One primary-derived tone per source: no second brand colour enters the page,
// the share differences come from how much of the user's accent is mixed in.
const USAGE_SHARE_TONES = [92, 68, 48, 32, 20]

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

function usageOverviewHtml(summary, sources) {
  const totals = summary && summary.totals && typeof summary.totals === 'object' ? summary.totals : {}
  const billable = usageNumber(totals.billable_total_tokens)
  const range = usageRangeLabel(summary)
  const shareSources = usageShareSources(sources)
  const shareTotal = shareSources.reduce((sum, source) => sum + usageNumber(source.billable_total_tokens), 0)

  let shareBar = `<div class="usage-empty-text">${t('config.usage.breakdown.empty')}</div>`
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

  return `<section class="card usage-overview">
    <div class="usage-card-head">
      <h2>${t('config.usage.overview.title')}</h2>
      <span class="usage-range" title="${escapeHtml(t('config.usage.overview.range'))}">${escapeHtml(range)}</span>
    </div>
    <div class="usage-overview-body">
      <div class="usage-overview-number">
        <b class="usage-big-number" id="usageTotal" title="${escapeHtml(usageFull(billable))}">${escapeHtml(usageCompact(billable))}</b>
        <span class="usage-big-label">${t('config.usage.overview.billable')}</span>
        <small class="usage-big-hint">${t('config.usage.overview.billable-hint')}</small>
      </div>
      <div class="usage-share">
        <span class="usage-share-title">${t('config.usage.overview.share')}</span>
        ${shareBar}
        ${shareLegend}
      </div>
    </div>
  </section>`
}

function usageSourceCardHtml(source) {
  const models = usageNumber(source && source.modelCount)
  const conversations = usageNumber(source && source.conversationCount)
  const meta = [
    t('config.usage.breakdown.model-count', { count: models }),
    t('config.usage.breakdown.conversations', { count: conversations })
  ].join(' · ')
  const estimated = source && source.estimated === true
    ? `<em class="usage-estimated-badge">${t('config.usage.coverage.estimated')}</em>`
    : ''
  return `<div class="usage-source-card" data-usage-source="${escapeHtml(source && source.source)}">
    <div class="usage-source-card-head">
      <b>${escapeHtml(usageSourceLabel(source))}</b>
      ${estimated}
    </div>
    <span class="usage-source-card-value" title="${escapeHtml(usageFull(source && source.billable_total_tokens))}">${escapeHtml(usageCompact(source && source.billable_total_tokens))}</span>
    <small>${escapeHtml(meta)} · ${t('config.usage.breakdown.share', { pct: usageShare(source && source.sharePct) })}</small>
  </div>`
}

function usageModelRowHtml(model, maxTokens) {
  const tokens = usageNumber(model && model.billable_total_tokens)
  const width = maxTokens > 0 ? Math.max(1, Math.min(100, Math.round((tokens / maxTokens) * 100))) : 0
  const sourceLabel = usageSourceLabel({ source: model && model.source })
  return `<div class="usage-model-row" data-usage-model="${escapeHtml(model && model.model)}">
    <div class="usage-model-head">
      <b class="usage-model-name">${escapeHtml(model && model.model)}</b>
      <span class="usage-model-source">${escapeHtml(sourceLabel)}</span>
      <span class="usage-model-value" title="${escapeHtml(usageFull(tokens))}">${escapeHtml(usageCompact(tokens))}</span>
      <small class="usage-model-share">${usageShare(model && model.sharePct)}</small>
    </div>
    <div class="usage-model-bar" aria-hidden="true"><i style="width:${width}%"></i></div>
  </div>`
}

function usageBreakdownHtml(sources, models) {
  const sourceCards = sources.length > 0
    ? `<div class="usage-source-grid">${sources.map(usageSourceCardHtml).join('')}</div>`
    : `<div class="usage-empty-text">${t('config.usage.breakdown.empty')}</div>`
  const top = models.slice().sort((a, b) => usageNumber(b && b.billable_total_tokens) - usageNumber(a && a.billable_total_tokens)).slice(0, USAGE_MODEL_LIMIT)
  const maxTokens = top.length > 0 ? usageNumber(top[0].billable_total_tokens) : 0
  const modelRows = top.length > 0
    ? top.map((model) => usageModelRowHtml(model, maxTokens)).join('')
    : `<div class="usage-empty-text">${t('config.usage.breakdown.empty')}</div>`
  return `<section class="card usage-breakdown" id="usageBreakdown">
    <div class="usage-card-head">
      <h2>${t('config.usage.breakdown.title')}</h2>
      <span>${t('config.usage.breakdown.sources')}</span>
    </div>
    ${sourceCards}
    <div class="usage-model-section">
      <div class="usage-card-subhead">
        <b>${t('config.usage.breakdown.models')}</b>
        <span>${t('config.usage.breakdown.model-count', { count: models.length })}</span>
      </div>
      <div class="usage-model-list">${modelRows}</div>
    </div>
  </section>`
}

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

function usageTrendTooltipHtml(row) {
  const segments = usageTrendSegments(row)
  const rows = [
    { label: t('config.usage.trend.input'), value: segments.input },
    { label: t('config.usage.trend.cache'), value: segments.cache },
    { label: t('config.usage.trend.output'), value: segments.output },
    { label: t('config.usage.trend.total'), value: segments.total }
  ]
  const lines = rows.map((row) => `${row.label}: ${usageFull(row.value)}`).join('\n')
  return { html: `<b class="usage-tooltip-title">${escapeHtml(row.day)}</b>${rows.map((item) => `<span class="usage-tooltip-row"><i>${escapeHtml(item.label)}</i><b>${escapeHtml(usageFull(item.value))}</b></span>`).join('')}`, label: `${row.day}\n${lines}` }
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
      const aria = usageTrendTooltipHtml(row).label.replace(/\n/g, '; ')
      const stack = segments.total > 0
        ? `<div class="usage-trend-stack" style="height:${barHeight}%">
            <i class="usage-trend-seg usage-trend-output" style="height:${segmentHeight(segments.output).toFixed(2)}%"></i>
            <i class="usage-trend-seg usage-trend-cache" style="height:${segmentHeight(segments.cache).toFixed(2)}%"></i>
            <i class="usage-trend-seg usage-trend-input" style="height:${segmentHeight(segments.input).toFixed(2)}%"></i>
          </div>`
        : '<div class="usage-trend-stack usage-trend-empty" style="height:2px"></div>'
      return `<div class="usage-trend-col" tabindex="0" role="img" data-usage-day="${escapeHtml(row.day)}" aria-label="${escapeHtml(aria)}">${stack}</div>`
    }).join('')
    chart = `<div class="usage-trend-chart" data-usage-trend>
      ${columns}
      <div class="usage-tooltip" data-usage-tooltip hidden></div>
    </div>`
    axis = `<div class="usage-trend-axis"><span>${escapeHtml(rows[0].day)}</span><span>${escapeHtml(rows[rows.length - 1].day)}</span></div>`
  }
  return `<section class="card usage-trend" id="usageTrend">
    <div class="usage-card-head">
      <h2>${t('config.usage.trend.title')}</h2>
      <span>${t('config.usage.trend.hint')}</span>
    </div>
    ${chart}
    ${axis}
  </section>`
}

function usageTableCell(value, compact) {
  if (value === null || value === undefined || value === '') return '<td class="num">-</td>'
  const number = usageNumber(value)
  const text = compact ? usageCompact(number) : usageFull(number)
  return `<td class="num" title="${escapeHtml(usageFull(number))}">${escapeHtml(text)}</td>`
}

function usageDailyTableHtml(rows) {
  const sorted = rows
    .filter((row) => row && typeof row.day === 'string')
    .slice()
    .sort((a, b) => String(a.day).localeCompare(String(b.day)))
    .reverse()
  const body = sorted.length > 0
    ? sorted.map((row) => `<tr data-usage-day="${escapeHtml(row.day)}">
        <td class="usage-date">${escapeHtml(row.day)}</td>
        ${usageTableCell(row.billable_total_tokens, true)}
        ${usageTableCell(row.input_tokens, true)}
        ${usageTableCell(row.output_tokens, true)}
        ${usageTableCell(row.cached_input_tokens, true)}
        ${usageTableCell(row.reasoning_output_tokens, true)}
        ${usageTableCell(row.conversation_count, false)}
      </tr>`).join('')
    : `<tr><td class="usage-table-empty" colspan="7">${t('config.usage.table.empty')}</td></tr>`
  const head = [
    ['config.usage.table.date', ''],
    ['config.usage.table.total', 'num'],
    ['config.usage.table.input', 'num'],
    ['config.usage.table.output', 'num'],
    ['config.usage.table.cache-read', 'num'],
    ['config.usage.table.reasoning', 'num'],
    ['config.usage.table.conversations', 'num']
  ].map(([key, className]) => `<th scope="col" class="${className}">${t(key)}</th>`).join('')
  return `<section class="card usage-daily">
    <div class="usage-card-head">
      <h2>${t('config.usage.table.title')}</h2>
      <span>${t('config.usage.table.rows', { count: sorted.length })}</span>
    </div>
    <div class="usage-table-wrap">
      <table class="usage-table" id="usageDailyTable">
        <thead><tr>${head}</tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  </section>`
}

// ---------------------------------------------------------------------------
// Page state resolution + dashboard composition
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

function usageTabsHtml() {
  const buttons = USAGE_PERIODS.map((period) => {
    const selected = period.id === usagePeriod
    return `<button class="usage-tab${selected ? ' active' : ''}" type="button" role="tab" data-usage-tab="${period.id}" aria-selected="${selected}" tabindex="${selected ? 0 : -1}">${t(period.labelKey)}</button>`
  }).join('')
  return `<div class="tabs usage-tabs" role="tablist" aria-label="${escapeHtml(t('config.usage.tabs-label'))}">${buttons}</div>`
}

// --- B5: custom range control ------------------------------------------------

// Two native date inputs (CSP-safe, no picker library) that feed
// {period:'custom', from, to} into summary/daily/breakdown. The active range is
// echoed by the overview's range label; invalid input is rejected in
// usageApplyCustomRange() with the same validator the loading path uses.
function usageRangeBarHtml() {
  const format = window.usageFormat
  const today = usageToday()
  const defaultFrom = format.addDays(today, -(USAGE_TREND_DAYS - 1))
  const from = usageRange.from || defaultFrom
  const to = usageRange.to || today
  const min = format.addDays(today, -format.CUSTOM_RANGE_MAX_SPAN_DAYS)
  const active = usagePeriod === 'custom'
  return `<div class="usage-range-bar${active ? ' active' : ''}" data-usage-range>
    <span class="usage-range-name">${t('config.usage.range.label')}</span>
    <label class="usage-range-field"><span>${t('config.usage.range.from')}</span><input class="usage-range-input" type="date" data-usage-range-from value="${escapeHtml(from)}" min="${escapeHtml(min)}" max="${escapeHtml(today)}"></label>
    <label class="usage-range-field"><span>${t('config.usage.range.to')}</span><input class="usage-range-input" type="date" data-usage-range-to value="${escapeHtml(to)}" min="${escapeHtml(min)}" max="${escapeHtml(today)}"></label>
    <button class="button" type="button" data-usage-range-apply>${t('config.usage.range.apply')}</button>
    <button class="button" type="button" data-usage-range-reset>${t('config.usage.range.reset')}</button>
  </div>`
}

// --- B5: 52-week activity heatmap -------------------------------------------

function usageMonthLabel(monthKey) {
  const parts = String(monthKey || '').split('-')
  const year = Number(parts[0])
  const month = Number(parts[1])
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) return String(monthKey || '')
  try {
    return new Intl.DateTimeFormat(usageIntlLocale(), { year: 'numeric', month: 'short' }).format(new Date(year, month - 1, 1))
  } catch {
    return String(monthKey || '')
  }
}

function usageHeatmapLabel(cell) {
  return window.usageFormat.formatTooltip({
    title: cell.day,
    rows: [
      { label: t('config.usage.heatmap.billable'), value: cell.value },
      { label: t('config.usage.heatmap.conversations'), value: cell.conversation_count }
    ]
  }).replace(/\n/g, '; ')
}

function usageHeatmapTooltipHtml(cell) {
  const rows = [
    { label: t('config.usage.heatmap.billable'), value: cell.value },
    { label: t('config.usage.heatmap.conversations'), value: cell.conversation_count }
  ]
  return `<b class="usage-tooltip-title">${escapeHtml(cell.day)}</b>${rows.map((row) => `<span class="usage-tooltip-row"><i>${escapeHtml(row.label)}</i><b>${escapeHtml(usageFull(row.value))}</b></span>`).join('')}`
}

function usageHeatmapCellHtml(cell) {
  if (!cell) return '<i class="usage-heat-cell usage-heat-empty" aria-hidden="true"></i>'
  const levelClass = window.usageFormat.heatmapLevelClass(cell.level)
  return `<i class="usage-heat-cell ${levelClass}" tabindex="0" role="img" data-usage-heat-day="${escapeHtml(cell.day)}" data-usage-heat-value="${cell.value}" data-usage-heat-conversations="${cell.conversation_count}" aria-label="${escapeHtml(usageHeatmapLabel(cell))}"></i>`
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
    return `<section class="card usage-heatmap" id="usageHeatmap">${head}<div class="usage-empty-text">${t('config.usage.heatmap.empty')}</div></section>`
  }
  const monthLabels = model.months.map((entry, index) => {
    const next = model.months[index + 1] ? model.months[index + 1].index : model.columns.length
    const span = Math.max(1, next - entry.index)
    return `<span style="grid-column:${entry.index + 1} / span ${span}">${escapeHtml(usageMonthLabel(entry.month))}</span>`
  }).join('')
  const cells = model.columns.map((column) => column.map(usageHeatmapCellHtml).join('')).join('')
  const legend = ['0', '1', '2', '3', '4'].map((level) => `<i class="usage-heat-swatch level-${level}" aria-hidden="true"></i>`).join('')
  return `<section class="card usage-heatmap" id="usageHeatmap">
    ${head}
    <div class="usage-heatmap-chart" data-usage-heatmap>
      <div class="usage-heatmap-scroll" data-usage-heatmap-scroll>
        <div class="usage-heatmap-months" style="grid-template-columns:repeat(${model.columns.length},10px)">${monthLabels}</div>
        <div class="usage-heatmap-grid">${cells}</div>
      </div>
      <div class="usage-tooltip" data-usage-heatmap-tooltip hidden></div>
    </div>
    <div class="usage-heatmap-legend">
      <span>${t('config.usage.heatmap.less')}</span>${legend}<span>${t('config.usage.heatmap.more')}</span>
    </div>
  </section>`
}

// --- B5: hourly series for the day view -------------------------------------

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
  // Day view only, and only when the channel exists; the rest of the page keeps
  // rendering the same way it did before B5.
  if (usagePeriod !== 'day' || !usageHasOptionalApi('usageHourly') || !hourly) return ''
  const rows = Array.isArray(hourly.rows) ? hourly.rows : []
  const day = hourly.day || usageToday()
  const head = `<div class="usage-card-head">
    <h2>${t('config.usage.hourly.title')}</h2>
    <span>${escapeHtml(day)} · ${t('config.usage.hourly.hint')}</span>
  </div>`
  if (rows.length === 0) {
    return `<section class="card usage-hourly" id="usageHourly">${head}<div class="usage-empty-text">${t('config.usage.hourly.empty')}</div></section>`
  }
  const max = rows.reduce((value, row) => Math.max(value, usageNumber(row && row.billable_total_tokens)), 0)
  const bars = rows.map((row) => {
    const value = usageNumber(row && row.billable_total_tokens)
    const height = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 2
    const label = usageHourlyLabel(row, usageHourClock(row && row.hour))
    return `<div class="usage-hourly-col" tabindex="0" role="img" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}"><i class="usage-hourly-bar${value > 0 ? '' : ' is-empty'}" style="height:${height}%"></i></div>`
  }).join('')
  const firstHour = usageHourClock(rows[0] && rows[0].hour)
  const lastHour = usageHourClock(rows[rows.length - 1] && rows[rows.length - 1].hour)
  const axis = `<div class="usage-hourly-axis"><span>${escapeHtml(firstHour)}</span><span>${escapeHtml(lastHour)}</span></div>`
  return `<section class="card usage-hourly" id="usageHourly">${head}<div class="usage-hourly-chart" data-usage-hourly>${bars}</div>${axis}</section>`
}

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

  view.innerHTML = `<div class="page usage-page" data-usage-state="${escapeHtml(state)}">
    ${usageHeaderHtml(usageRefreshButtonHtml())}
    ${usageCoverageHtml(status)}
    ${usageStateBannerHtml(state)}
    ${usageTabsHtml()}
    ${usageRangeBarHtml()}
    ${usageKpisHtml(summary)}
    <div class="usage-main" data-usage-view="${escapeHtml(usagePeriod)}">
      ${usageOverviewHtml(summary, sources)}
      ${usageBreakdownHtml(sources, models)}
      ${usageTrendHtml(daily, payload.trend)}
      ${usageHourlyHtml(payload.hourly)}
      ${usageDailyTableHtml(dailyRows)}
    </div>
    ${usageHeatmapHtml(payload.heatmap)}
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
  // Optional B5 channels: rejections collapse to null so a missing/not-yet-
  // implemented heatmap or hourly channel hides its card instead of failing the
  // whole page (the required four channels keep the strict Promise.all below).
  const heatmapRequest = usageHasOptionalApi('usageHeatmap')
    ? window.electronAPI.usageHeatmap({ tz: params.tz, weeks: USAGE_HEATMAP_WEEKS }).catch(() => null)
    : Promise.resolve(null)
  const hourlyRequest = usagePeriod === 'day' && usageHasOptionalApi('usageHourly')
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

function usageHideTrendTooltip(tooltip) {
  if (tooltip) tooltip.hidden = true
}

// Absolute tooltip inside the chart card; horizontal flip keeps it inside the
// card when the hovered column sits near either edge.
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
  if (center - tooltipWidth / 2 < 0) {
    left = column.offsetLeft
    flip = 'left'
  } else if (center + tooltipWidth / 2 > chartWidth) {
    left = column.offsetLeft + column.offsetWidth
    flip = 'right'
  }
  tooltip.dataset.flip = flip
  tooltip.style.left = `${Math.round(left)}px`
  const tooltipHeight = tooltip.offsetHeight
  tooltip.style.top = `${Math.max(2, column.offsetTop - tooltipHeight - 6)}px`
}

function usageBindTrend(dailyRows, trend) {
  const chart = view.querySelector('[data-usage-trend]')
  const tooltip = view.querySelector('[data-usage-tooltip]')
  if (!chart || !tooltip) return
  const trendRows = usageTrendRows({ rows: dailyRows }, trend)
  const rowsByDay = new Map(trendRows.map((row) => [row.day, row]))
  const hide = () => usageHideTrendTooltip(tooltip)
  chart.querySelectorAll('[data-usage-day]').forEach((column) => {
    const show = () => usageShowTrendTooltip(chart, tooltip, column, rowsByDay)
    column.addEventListener('mouseenter', show)
    column.addEventListener('focus', show)
    column.addEventListener('mouseleave', hide)
    column.addEventListener('blur', hide)
  })
  chart.addEventListener('mouseleave', hide)
}

function usageBindDashboard(payload) {
  usageBindRefresh()
  usageBindCoverageActions()
  usageBindRetry()
  usageBindRangeBar()
  view.querySelectorAll('[data-usage-tab]').forEach((button) => {
    button.onclick = () => {
      const next = button.dataset.usageTab
      if (!USAGE_PERIODS.some((period) => period.id === next) || next === usagePeriod) return
      usagePeriod = next
      void renderUsage()
    }
  })
  const dailyRows = payload && payload.daily && Array.isArray(payload.daily.rows) ? payload.daily.rows : []
  usageBindTrend(dailyRows, payload ? payload.trend : null)
  usageBindHeatmapTooltip()
}

function usageReadRangeInput(selector) {
  const input = view.querySelector(selector)
  return input && typeof input.value === 'string' ? input.value : ''
}

// Invalid input falls back to the month tab with a toast (plan B5-3); valid
// input becomes {period:'custom', from, to} on the next query round.
function usageApplyCustomRange() {
  const result = window.usageFormat.validateCustomRange(
    usageReadRangeInput('[data-usage-range-from]'),
    usageReadRangeInput('[data-usage-range-to]'),
    usageToday()
  )
  if (!result.valid) {
    usageToast(t(USAGE_RANGE_REASON_KEYS[result.reason] || 'config.usage.range.invalid'))
    usagePeriod = 'month'
    usageRange = { from: '', to: '' }
    void renderUsage()
    return
  }
  if (usagePeriod !== 'custom') usagePeriodBeforeCustom = usagePeriod
  usageRange = { from: result.from, to: result.to }
  usagePeriod = 'custom'
  usageToast(t('config.usage.range.applied'))
  void renderUsage()
}

function usageResetCustomRange() {
  usageRange = { from: '', to: '' }
  usagePeriod = usagePeriodBeforeCustom || USAGE_DEFAULT_PERIOD
  void renderUsage()
}

function usageBindRangeBar() {
  const apply = view.querySelector('[data-usage-range-apply]')
  if (apply) apply.onclick = () => usageApplyCustomRange()
  const reset = view.querySelector('[data-usage-range-reset]')
  if (reset) reset.onclick = () => usageResetCustomRange()
}

// The heatmap tooltip is positioned from the hovered cell's viewport rect, which
// stays correct inside the horizontal scroller; horizontal flip keeps it inside
// the chart near either edge. The scroller starts at the newest week.
function usageBindHeatmapTooltip() {
  const chart = view.querySelector('[data-usage-heatmap]')
  const tooltip = view.querySelector('[data-usage-heatmap-tooltip]')
  if (!chart || !tooltip) return
  const hide = () => { tooltip.hidden = true }
  chart.querySelectorAll('[data-usage-heat-day]').forEach((cell) => {
    const show = () => {
      const data = {
        day: cell.dataset.usageHeatDay,
        value: usageNumber(cell.dataset.usageHeatValue),
        conversation_count: usageNumber(cell.dataset.usageHeatConversations)
      }
      tooltip.innerHTML = usageHeatmapTooltipHtml(data)
      tooltip.hidden = false
      const chartRect = chart.getBoundingClientRect()
      const cellRect = cell.getBoundingClientRect()
      const center = cellRect.left - chartRect.left + cellRect.width / 2
      const tooltipWidth = tooltip.offsetWidth
      const chartWidth = chart.clientWidth
      let left = center
      let flip = 'center'
      if (center - tooltipWidth / 2 < 0) {
        left = Math.max(0, cellRect.left - chartRect.left)
        flip = 'left'
      } else if (center + tooltipWidth / 2 > chartWidth) {
        left = Math.min(chartWidth, cellRect.right - chartRect.left)
        flip = 'right'
      }
      tooltip.dataset.flip = flip
      tooltip.style.left = `${Math.round(left)}px`
      tooltip.style.top = `${Math.max(2, cellRect.top - chartRect.top - tooltip.offsetHeight - 6)}px`
    }
    cell.addEventListener('mouseenter', show)
    cell.addEventListener('focus', show)
    cell.addEventListener('mouseleave', hide)
    cell.addEventListener('blur', hide)
  })
  chart.addEventListener('mouseleave', hide)
  const scroll = view.querySelector('[data-usage-heatmap-scroll]')
  if (scroll && scroll.scrollWidth > scroll.clientWidth) scroll.scrollLeft = scroll.scrollWidth
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
