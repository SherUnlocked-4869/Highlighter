// Usage report export/import (B07, batch 1).
//
// ONE pure module turns the query payloads the page already renders into the two
// exchange formats, and parses a JSON report back for preview/import. No fs, no
// Electron, no clock of its own: the caller injects `generatedAt` (and the tests
// pin it), so an export is a pure function of its input.
//
// Privacy contract (the reason the payload is not just "the daily rows"):
// the report is AGGREGATE ONLY. It carries local day keys, five token counters,
// the cost and the model *names* that could not be priced. It never carries a
// session title, a project path, a raw prompt or a tool argument - those live in
// `usage_detail_store` and are not reachable from this module's inputs.
//
// Recomputability contract: sources, timezone, dedupe semantics, token
// semantics, currency/unit, the price table version (with the versioned rates)
// and an explicit unknown-price marker travel with the numbers. A reader with
// only the file can reproduce a day's cost.

const crypto = require('node:crypto')

const { PRICE_CURRENCY, PRICE_SCHEMA_VERSION, PRICE_UNIT, isDayKey, migrateUsagePrices, priceVersionStamp } = require('./usage-pricing')
const usageTime = require('./usage-time')

const REPORT_SCHEMA_VERSION = 1
const REPORT_KIND = 'usage-daily-aggregate'
const SUPPORTED_SOURCES = Object.freeze(['codex', 'dsh', 'opencode'])
const UNKNOWN_PRICE_MARKER = 'unknown'
const MAX_REPORT_BYTES = 8 * 1024 * 1024
const MAX_REPORT_DAYS = 4000
// Same ceiling the IPC validator uses for a page range; a report cannot describe
// a wider window than the page can query.
const MAX_RANGE_DAYS = 800
const IDENTITY_PATTERN = /^sha256:[a-f0-9]{16,64}$/

// RFC4180: a field is quoted when it contains a comma, a quote or a line break;
// an embedded quote is doubled. Everything else is emitted as-is.
function csvField(value) {
  if (value === null || value === undefined) return ''
  const text = String(value)
  if (/[",\r\n]/.test(text)) return '"' + text.replace(/"/g, '""') + '"'
  return text
}

function csvRow(values) {
  return values.map(csvField).join(',')
}

// Spreadsheet applications still evaluate a quoted cell that starts with =, +
// or @, so user-controlled text (the model filter) is prefixed with an
// apostrophe. The JSON export keeps the raw value; only the CSV is neutralized.
function formulaSafe(value) {
  const text = value === null || value === undefined ? '' : String(value)
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
}

function count(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0
}

function costValue(value) {
  if (value === null || value === undefined) return null
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}

// The five pricing states the page already renders (shared/usage-format.js
// costState), restated here because the report must stay decidable from the file
// without loading a renderer module.
function priceStateOf(row) {
  const tokens = count(row.total)
  const conversations = count(row.conversations)
  if (!tokens && !conversations) return 'none'
  if (row.costCny === null) return 'unpriced'
  if (count(row.unpricedModels) > 0) return 'partial'
  return row.costCny === 0 ? 'zero' : 'priced'
}

function normalizeDayRow(row) {
  if (!row || typeof row !== 'object' || !isDayKey(row.day)) return null
  const input = count(row.input_tokens)
  const cacheRead = count(row.cached_input_tokens)
  const cacheWrite = count(row.cache_creation_input_tokens)
  const output = count(row.output_tokens)
  const total = count(row.billable_total_tokens) || count(row.total_tokens)
  const costCny = costValue(row.costCny)
  const unpricedModels = count(row.unpricedModels)
  const normalized = { day: row.day, input, cacheRead, cacheWrite, output, total, costCny, unpricedModels }
  normalized.priceState = priceStateOf({
    total,
    conversations: count(row.conversation_count),
    costCny,
    unpricedModels
  })
  return normalized
}

function sumRows(rows) {
  const totals = {
    days: rows.length,
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    total: 0,
    costCny: null,
    // Sum of the daily `unpricedModels` counters (one model can be unpriced on
    // several days); `unpricedDays`/`partialDays` count days instead.
    unpricedModelDays: 0,
    unpricedDays: 0,
    partialDays: 0
  }
  for (const row of rows) {
    totals.input += row.input
    totals.cacheRead += row.cacheRead
    totals.cacheWrite += row.cacheWrite
    totals.output += row.output
    totals.total += row.total
    if (row.costCny !== null) totals.costCny = (totals.costCny ?? 0) + row.costCny
    totals.unpricedModelDays += row.unpricedModels
    if (row.priceState === 'unpriced') totals.unpricedDays += 1
    if (row.priceState === 'partial') totals.partialDays += 1
  }
  return totals
}

// Deterministic identity of a report's *content* (never of when it was
// generated), so re-importing the same export is provably the same snapshot and
// a hand-edited daily row cannot keep the old id.
function snapshotIdFor(report) {
  const identity = {
    schemaVersion: report.schemaVersion,
    kind: report.kind,
    timeZone: report.timeZone,
    sources: report.sources,
    from: report.period?.from ?? report.from ?? null,
    to: report.period?.to ?? report.to ?? null,
    daily: (Array.isArray(report.daily) ? report.daily : []).map((row) => [
      row.day,
      row.input,
      row.cacheRead,
      row.cacheWrite,
      row.output,
      row.total,
      row.costCny,
      row.unpricedModels
    ])
  }
  const digest = crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex')
  return `sha256:${digest}`
}

function dedupeText() {
  return 'Each (source, model, UTC hour) bucket is stored once as an absolute snapshot: a rescan replaces that bucket, and a duplicated or rotated log line cannot create a second bucket. Buckets are then folded into one local calendar day in the report timezone. Exports that cover the same days are not additive with each other.'
}

function tokenSemanticsText() {
  return 'input = uncached prompt tokens; cacheRead = prompt tokens served from cache; cacheWrite = prompt tokens written to cache (charged at the optional cache-write rate, else the input rate); output = completion tokens; total = billable_total_tokens (falls back to total_tokens).'
}

function sourceListLabel(sources) {
  return (Array.isArray(sources) ? sources : []).join(';')
}

function buildUsageReport(input = {}) {
  const daily = input.daily && typeof input.daily === 'object' ? input.daily : {}
  const rawRows = Array.isArray(daily.rows) ? daily.rows : []
  const rows = []
  const seenDays = new Set()
  for (const raw of rawRows) {
    const row = normalizeDayRow(raw)
    if (!row || seenDays.has(row.day)) continue
    seenDays.add(row.day)
    rows.push(row)
  }
  rows.sort((left, right) => left.day.localeCompare(right.day))
  const from = isDayKey(daily.from) ? daily.from : (rows[0]?.day || '')
  const to = isDayKey(daily.to) ? daily.to : (rows[rows.length - 1]?.day || '')
  const requestedSources = (Array.isArray(input.sources) && input.sources.length > 0 ? input.sources : SUPPORTED_SOURCES)
    .filter((source) => SUPPORTED_SOURCES.includes(source))
  // An unfiltered export names all three tools; a filter that matched nothing
  // supported must not produce a report with an empty source list.
  const sources = requestedSources.length > 0 ? requestedSources : [...SUPPORTED_SOURCES]
  const priceTable = migrateUsagePrices(input.prices)
  const breakdownModels = Array.isArray(input.breakdown?.models) ? input.breakdown.models : []
  const unpricedNames = breakdownModels
    .filter((model) => model && model.pricing === 'none' && typeof model.model === 'string')
    .map((model) => model.model)
    .sort()
  const totals = sumRows(rows)
  const generatedAt = input.generatedAt instanceof Date
    ? input.generatedAt.toISOString()
    : (typeof input.generatedAt === 'string' && Number.isFinite(Date.parse(input.generatedAt))
        ? new Date(input.generatedAt).toISOString()
        : new Date().toISOString())
  const sourceLabels = {}
  for (const source of sources) {
    sourceLabels[source] = input.sourceLabels?.[source] || source
  }
  const report = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    kind: REPORT_KIND,
    generatedAt,
    app: { name: 'Highlighter', version: typeof input.appVersion === 'string' ? input.appVersion : '' },
    timeZone: usageTime.safeTimeZone(daily.tz),
    period: { period: typeof daily.period === 'string' ? daily.period : 'custom', from, to },
    sources,
    sourceLabels,
    filters: {
      model: typeof input.model === 'string' && input.model ? input.model : null,
      project: input.projectFiltered === true ? 'filtered' : null
    },
    dedupe: { mode: 'bucket-identity', text: dedupeText() },
    tokenSemantics: {
      input: 'uncached prompt tokens',
      cacheRead: 'prompt tokens read from cache',
      cacheWrite: 'prompt tokens written to cache',
      output: 'completion tokens',
      total: 'billable_total_tokens (fallback total_tokens)',
      text: tokenSemanticsText()
    },
    pricing: {
      schemaVersion: PRICE_SCHEMA_VERSION,
      mode: priceTable.rows.length > 0 ? 'manual' : 'none',
      currency: PRICE_CURRENCY,
      unit: PRICE_UNIT,
      version: priceTable.rows.length > 0 ? priceVersionStamp(priceTable.rows) : null,
      effectiveDates: priceTable.rows.some((row) => row.effectiveFrom !== null),
      cacheWriteRate: priceTable.rows.some((row) => row.cachedWrite !== null) ? 'explicit' : 'input',
      table: priceTable.rows
    },
    unknownPrice: {
      marker: UNKNOWN_PRICE_MARKER,
      text: 'Unknown: usage was recorded for a model with no effective price on that day. It is not zero cost.'
    },
    daily: rows,
    totals,
    unpricedModels: {
      count: unpricedNames.length,
      names: unpricedNames
    },
    notes: [
      'Aggregated daily totals only: no prompts, tool arguments, project paths or session titles are included.',
      'Import is idempotent by snapshotId; snapshots with overlapping sources and date ranges are refused rather than merged.'
    ]
  }
  report.snapshotId = snapshotIdFor(report)
  return report
}

function reportToJson(report) {
  return JSON.stringify(report, null, 2) + '\n'
}

function reportToCsv(report) {
  const lines = []
  const meta = [
    ['schemaVersion', report.schemaVersion],
    ['kind', report.kind],
    ['snapshotId', report.snapshotId],
    ['generatedAt', report.generatedAt],
    ['timeZone', report.timeZone],
    ['period', `${report.period.period} ${report.period.from}..${report.period.to}`],
    ['from', report.period.from],
    ['to', report.period.to],
    ['sources', sourceListLabel(report.sources)],
    ['modelFilter', formulaSafe(report.filters.model)],
    ['projectFilter', report.filters.project || ''],
    ['dedupe', report.dedupe.text],
    ['tokenSemantics', report.tokenSemantics.text],
    ['priceMode', report.pricing.mode],
    ['priceCurrency', report.pricing.currency],
    ['priceUnit', report.pricing.unit],
    ['priceVersion', report.pricing.version || ''],
    ['cacheWriteRate', report.pricing.cacheWriteRate],
    ['unknownPrice', report.unknownPrice.marker],
    ['notes', report.notes.join(' ')]
  ]
  for (const [key, value] of meta) lines.push(csvRow([key, value]))
  lines.push('')
  lines.push(csvRow(['day', 'inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'totalTokens', 'costCny', 'priceState', 'unpricedModels', 'priceVersion']))
  for (const row of report.daily) {
    lines.push(csvRow([
      row.day,
      row.input,
      row.cacheRead,
      row.cacheWrite,
      row.output,
      row.total,
      // A day with no activity has no cost to know: leave the cell empty. A day
      // with activity but no price is the one that must read "unknown".
      row.costCny === null ? (row.priceState === 'none' ? '' : report.unknownPrice.marker) : row.costCny,
      row.priceState,
      row.unpricedModels,
      report.pricing.version || ''
    ]))
  }
  return lines.join('\r\n') + '\r\n'
}

function reportFileName(report, format) {
  const from = report.period?.from || 'report'
  const to = report.period?.to || from
  const stamp = (report.pricing?.version || 'no-price').replace(/[^a-z0-9-]/gi, '')
  return `Highlighter-usage-${from}_${to}-${stamp}.${format === 'json' ? 'json' : 'csv'}`
}

function fail(message) {
  throw new Error(`usage: ${message}`)
}

// Parses and validates one imported report. The returned payload is rebuilt from
// whitelisted fields only, so nothing a hand-edited file smuggled in (a path, a
// title, an extra blob) can reach the snapshot store.
function parseUsageReport(value) {
  let source = value
  if (typeof source === 'string') {
    if (source.length > MAX_REPORT_BYTES) fail('report is too large')
    try {
      source = JSON.parse(source)
    } catch (_error) {
      fail('report is not valid JSON')
    }
  }
  if (!source || typeof source !== 'object' || Array.isArray(source)) fail('report must be a JSON object')
  if (source.schemaVersion !== REPORT_SCHEMA_VERSION) fail(`unsupported report schemaVersion: ${String(source.schemaVersion)}`)
  if (source.kind !== REPORT_KIND) fail('report kind is not a usage daily aggregate')
  if (typeof source.snapshotId !== 'string' || !IDENTITY_PATTERN.test(source.snapshotId)) {
    fail('report identity is missing or malformed')
  }
  const timeZone = usageTime.safeTimeZone(source.timeZone)
  const sources = Array.isArray(source.sources) ? source.sources.filter((item) => SUPPORTED_SOURCES.includes(item)) : []
  if (sources.length === 0) fail('report has no recognizable source')
  const uniqueSources = [...new Set(sources)]
  const from = source.period && isDayKey(source.period.from) ? source.period.from : (isDayKey(source.from) ? source.from : '')
  const to = source.period && isDayKey(source.period.to) ? source.period.to : (isDayKey(source.to) ? source.to : '')
  if (!from || !to) fail('report has no valid period')
  if (from > to) fail('report period starts after it ends')
  const days = Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86400000) + 1
  if (days > MAX_RANGE_DAYS) fail(`report period is longer than ${MAX_RANGE_DAYS} days`)
  const rawDaily = Array.isArray(source.daily) ? source.daily : []
  if (rawDaily.length === 0) fail('report has no daily rows')
  if (rawDaily.length > MAX_REPORT_DAYS) fail('report has too many daily rows')
  const rows = []
  const seen = new Set()
  for (const entry of rawDaily) {
    if (!entry || typeof entry !== 'object') fail('report has an invalid daily row')
    const day = entry.day
    if (!isDayKey(day) || day < from || day > to) fail('report has a daily row outside its period')
    if (seen.has(day)) fail('report has duplicate daily rows')
    seen.add(day)
    const row = {
      day,
      input: count(entry.input ?? entry.inputTokens),
      cacheRead: count(entry.cacheRead ?? entry.cacheReadTokens),
      cacheWrite: count(entry.cacheWrite ?? entry.cacheWriteTokens),
      output: count(entry.output ?? entry.outputTokens),
      total: count(entry.total ?? entry.totalTokens),
      costCny: costValue(entry.costCny),
      unpricedModels: count(entry.unpricedModels)
    }
    row.priceState = priceStateOf({ total: row.total, conversations: 0, costCny: row.costCny, unpricedModels: row.unpricedModels })
    rows.push(row)
  }
  rows.sort((left, right) => left.day.localeCompare(right.day))
  const candidate = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    kind: REPORT_KIND,
    timeZone,
    sources: uniqueSources,
    period: { from, to },
    daily: rows
  }
  const expected = snapshotIdFor(candidate)
  if (expected !== source.snapshotId) fail('report identity does not match its content')
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    kind: REPORT_KIND,
    snapshotId: source.snapshotId,
    generatedAt: typeof source.generatedAt === 'string' && Number.isFinite(Date.parse(source.generatedAt))
      ? new Date(source.generatedAt).toISOString()
      : null,
    timeZone,
    sources: uniqueSources,
    from,
    to,
    daily: rows,
    totals: sumRows(rows),
    pricing: {
      version: typeof source.pricing?.version === 'string' ? source.pricing.version.slice(0, 64) : null,
      unit: typeof source.pricing?.unit === 'string' ? source.pricing.unit.slice(0, 64) : PRICE_UNIT,
      currency: typeof source.pricing?.currency === 'string' ? source.pricing.currency.slice(0, 16) : PRICE_CURRENCY,
      mode: source.pricing?.mode === 'manual' ? 'manual' : 'none'
    }
  }
}

module.exports = {
  MAX_RANGE_DAYS,
  MAX_REPORT_BYTES,
  MAX_REPORT_DAYS,
  REPORT_KIND,
  REPORT_SCHEMA_VERSION,
  SUPPORTED_SOURCES,
  buildUsageReport,
  csvField,
  parseUsageReport,
  reportFileName,
  reportToCsv,
  reportToJson,
  snapshotIdFor
}
