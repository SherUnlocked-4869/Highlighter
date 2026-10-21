// Usage aggregation queries (B3): summary / daily / hourly / breakdown / heatmap.
//
// All page-facing aggregation lives here so `usage-feature.js` stays a thin
// composition root. The metric rules come from the plan §2.6 and TokenTracker:
//   - rows are UTC half-hour buckets; every view maps them onto local calendar
//     days/hours with Intl (`usage-time.js`), never fixed offsets;
//   - totals always use `billable_total_tokens` (fall back to `total_tokens`
//     only if a future tool writes billable=0);
//   - rolling KPI: local last-7/last-30 days, active days = observed days,
//     avg = round(total/activeDays);
//   - daily rows are zero-filled up to local today (never fabricated future
//     days);
//   - heatmap: 52 weeks x 7, Monday first, future days null, level 0..4
//     max-relative quarters.
//
// A small LRU (default 60 s, 64 entries) is keyed by
// {view,period,tz,from,to,scope} + the store's in-process dbVersion, so it is
// invalidated by the next commit/clear without cross-process coordination.

const usageTime = require('./usage-time')

const RETENTION_MONTHS = usageTime.RETENTION_MONTHS
const SOURCE_LABELS = Object.freeze({
  codex: 'Codex',
  dsh: 'DeepSeek Harness',
  opencode: 'OpenCode'
})
const SUMMARY_INTEGER_COLUMNS = Object.freeze([
  'billable_total_tokens',
  'total_tokens',
  'input_tokens',
  'output_tokens',
  'cached_input_tokens',
  'cache_creation_input_tokens',
  'reasoning_output_tokens',
  'conversation_count'
])

function emptyTotals() {
  const totals = {}
  for (const column of SUMMARY_INTEGER_COLUMNS) totals[column] = 0
  return totals
}

function addTotals(target, source) {
  for (const column of SUMMARY_INTEGER_COLUMNS) {
    target[column] = (target[column] || 0) + (Number(source?.[column]) || 0)
  }
  return target
}

function pickQueueTokens(row) {
  const tokens = {}
  for (const column of SUMMARY_INTEGER_COLUMNS) tokens[column] = Number(row?.[column]) || 0
  return tokens
}

// TokenTracker's aggregate payload nests only the token columns inside
// source/model totals objects (conversation_count stays a flat source/model
// field), so mirror that shape for the oracle comparator.
const AGGREGATE_TOKEN_COLUMNS = Object.freeze([
  'input_tokens',
  'output_tokens',
  'cached_input_tokens',
  'cache_creation_input_tokens',
  'reasoning_output_tokens',
  'total_tokens',
  'billable_total_tokens'
])

function aggregateTokenTotals(totals) {
  const out = {}
  for (const column of AGGREGATE_TOKEN_COLUMNS) out[column] = Number(totals?.[column]) || 0
  return out
}

function addQueueTokens(target, source) {
  for (const column of SUMMARY_INTEGER_COLUMNS) target[column] = (target[column] || 0) + (Number(source?.[column]) || 0)
  return target
}

function sharePct(value, total) {
  if (!total) return 0
  return Math.round((value / total) * 10000) / 100
}

// Max-relative four-band level (plan §1.2 #10): 0 = no activity,
// 1..4 = <=25% / <=50% / <=75% / >75% of the range maximum.
function heatmapLevel(value, max) {
  if (!value || value <= 0 || !max || max <= 0) return 0
  const ratio = value / max
  if (ratio <= 0.25) return 1
  if (ratio <= 0.5) return 2
  if (ratio <= 0.75) return 3
  return 4
}

function toTotalsPayload(columns) {
  return {
    billable_total_tokens: Number(columns.billable_total_tokens) || 0,
    total_tokens: Number(columns.total_tokens) || 0,
    input_tokens: Number(columns.input_tokens) || 0,
    output_tokens: Number(columns.output_tokens) || 0,
    cached_input_tokens: Number(columns.cached_input_tokens) || 0,
    cache_creation_input_tokens: Number(columns.cache_creation_input_tokens) || 0,
    reasoning_output_tokens: Number(columns.reasoning_output_tokens) || 0,
    conversation_count: Number(columns.conversation_count) || 0,
    total_cost_usd: null,
    unpriced_tokens: 0
  }
}

function dailyRowFromTotals(day, columns) {
  return {
    day,
    total_tokens: Number(columns.total_tokens) || 0,
    billable_total_tokens: Number(columns.billable_total_tokens) || 0,
    input_tokens: Number(columns.input_tokens) || 0,
    output_tokens: Number(columns.output_tokens) || 0,
    cached_input_tokens: Number(columns.cached_input_tokens) || 0,
    cache_creation_input_tokens: Number(columns.cache_creation_input_tokens) || 0,
    reasoning_output_tokens: Number(columns.reasoning_output_tokens) || 0,
    conversation_count: Number(columns.conversation_count) || 0,
    total_cost_usd: null
  }
}

function createLruCache({ maxEntries = 64, ttlMs = 60000, now = () => Date.now() } = {}) {
  const entries = new Map()
  const stats = { hits: 0, misses: 0 }
  function get(key) {
    const entry = entries.get(key)
    if (!entry) {
      stats.misses += 1
      return undefined
    }
    if (now() - entry.at > ttlMs) {
      entries.delete(key)
      stats.misses += 1
      return undefined
    }
    entries.delete(key)
    entries.set(key, entry)
    stats.hits += 1
    return entry.value
  }
  function set(key, value) {
    entries.delete(key)
    entries.set(key, { value, at: now() })
    while (entries.size > maxEntries) {
      entries.delete(entries.keys().next().value)
    }
  }
  return {
    clear: () => entries.clear(),
    get,
    getStats: () => ({ ...stats, size: entries.size, maxEntries, ttlMs }),
    set,
    size: () => entries.size
  }
}

function createUsageQuery({
  getStore,
  now = () => new Date(),
  log = () => {},
  cacheTtlMs = 60000,
  cacheMaxEntries = 64,
  cacheNow = () => Date.now()
} = {}) {
  if (typeof getStore !== 'function') throw new TypeError('usage query requires getStore()')
  const cache = createLruCache({ maxEntries: cacheMaxEntries, ttlMs: cacheTtlMs, now: cacheNow })
  // Zoned key memo: Intl formatToParts costs ~20 us, and a 24-month range holds
  // at most ~35k distinct half-hour buckets, so memoizing per bucket keeps a
  // 100k-row daily/heatmap query well inside the 100 ms budget.
  const zonedDayMemo = new Map()
  const zonedHourMemo = new Map()

  function zonedDayOf(hourStart, tz) {
    const key = hourStart + '|' + tz
    let value = zonedDayMemo.get(key)
    if (value === undefined) {
      value = usageTime.zonedDayKey(hourStart, tz)
      zonedDayMemo.set(key, value)
    }
    return value
  }

  function zonedHourOf(hourStart, tz) {
    const key = hourStart + '|' + tz
    let value = zonedHourMemo.get(key)
    if (value === undefined) {
      value = usageTime.zonedHour(hourStart, tz)
      zonedHourMemo.set(key, value)
    }
    return value
  }

  function rangeForPeriod({ period = 'month', from = null, to = null, tz = 'UTC' } = {}) {
    const resolved = usageTime.resolveCalendarPeriod({ period, now: now(), timeZone: tz, from, to })
    return {
      period,
      tz,
      fromDay: resolved.fromDay,
      toDay: resolved.toDay,
      fromIso: new Date(resolved.startUtcMs).toISOString(),
      toIso: new Date(resolved.endUtcMs).toISOString()
    }
  }

  function dbVersion() {
    try {
      const store = getStore()
      return typeof store.getDbVersion === 'function' ? store.getDbVersion() : 0
    } catch (_error) {
      return 0
    }
  }

  function cached(key, compute) {
    const scopedKey = `${dbVersion()}|${key}`
    const hit = cache.get(scopedKey)
    if (hit !== undefined) return hit
    const value = compute()
    cache.set(scopedKey, value)
    return value
  }

  function rowsByZoneDay(rows, tz, range) {
    const grouped = new Map()
    for (const row of Array.isArray(rows) ? rows : []) {
      const day = zonedDayOf(row.hour_start, tz)
      if (day < range.fromDay || day > range.toDay) continue
      const bucket = grouped.get(day) || emptyTotals()
      addTotals(bucket, row)
      grouped.set(day, bucket)
    }
    return grouped
  }

  function summary(validated = {}) {
    const period = validated.period || 'month'
    const tz = validated.tz || 'UTC'
    return cached(`summary|${period}|${tz}|${validated.from || ''}|${validated.to || ''}`, () => {
      const range = rangeForPeriod({ ...validated, period, tz })
      const store = getStore()
      const totals = toTotalsPayload(store.sumRange({ fromIso: range.fromIso, toIso: range.toIso }))
      const current = now()
      const last7Window = usageTime.resolveRollingWindow({ days: 7, now: current, timeZone: tz })
      const last30Window = usageTime.resolveRollingWindow({ days: 30, now: current, timeZone: tz })
      const last7 = store.sumRange({
        fromIso: new Date(last7Window.startUtcMs).toISOString(),
        toIso: new Date(last7Window.endUtcMs).toISOString()
      })
      const last30 = store.sumRange({
        fromIso: new Date(last30Window.startUtcMs).toISOString(),
        toIso: new Date(last30Window.endUtcMs).toISOString()
      })
      const last30Rows = store.getRangeHourlyTotals({
        fromIso: new Date(last30Window.startUtcMs).toISOString(),
        toIso: new Date(last30Window.endUtcMs).toISOString()
      })
      const observedDays = new Set()
      for (const row of last30Rows) {
        if ((Number(row.billable_total_tokens) || 0) > 0 || (Number(row.conversation_count) || 0) > 0) {
          observedDays.add(zonedDayOf(row.hour_start, tz))
        }
      }
      const activeDays = observedDays.size
      const last30Billable = Number(last30.billable_total_tokens) || 0
      return {
        period,
        from: range.fromDay,
        to: range.toDay,
        tz,
        totals,
        rolling: {
          last7d: {
            billable_total_tokens: Number(last7.billable_total_tokens) || 0,
            conversation_count: Number(last7.conversation_count) || 0
          },
          last30d: {
            billable_total_tokens: last30Billable,
            conversation_count: Number(last30.conversation_count) || 0
          },
          avgPerActiveDay: activeDays > 0 ? Math.round(last30Billable / activeDays) : 0,
          activeDays
        },
        pricing: { mode: 'none', version: null }
      }
    })
  }

  function daily(validated = {}) {
    const period = validated.period || 'month'
    const tz = validated.tz || 'UTC'
    return cached(`daily|${period}|${tz}|${validated.from || ''}|${validated.to || ''}`, () => {
      const range = rangeForPeriod({ ...validated, period, tz })
      const store = getStore()
      const rows = store.getRangeHourlyTotals({ fromIso: range.fromIso, toIso: range.toIso })
      const grouped = rowsByZoneDay(rows, tz, range)
      const out = []
      const todayKey = usageTime.zonedDayKey(now(), tz)
      const lastFillDay = range.toDay < todayKey ? range.toDay : todayKey
      let cursor = range.fromDay
      let guard = 0
      while (cursor <= lastFillDay && guard < 4000) {
        out.push(dailyRowFromTotals(cursor, grouped.get(cursor) || emptyTotals()))
        cursor = usageTime.addDaysToDayKey(cursor, 1)
        guard += 1
      }
      return { period, from: range.fromDay, to: range.toDay, tz, rows: out }
    })
  }

  function hourly(validated = {}) {
    const tz = validated.tz || 'UTC'
    const day = validated.day
    return cached(`hourly|${day}|${tz}`, () => {
      const bounds = usageTime.resolveDayBounds(day, tz)
      const store = getStore()
      const rows = store.getRangeHourlyTotals({
        fromIso: new Date(bounds.startUtcMs).toISOString(),
        toIso: new Date(bounds.endUtcMs).toISOString()
      })
      const buckets = Array.from({ length: 24 }, () => emptyTotals())
      for (const row of rows) {
        const hour = zonedHourOf(row.hour_start, tz)
        if (!Number.isFinite(hour) || hour < 0 || hour > 23) continue
        addTotals(buckets[hour], row)
      }
      return {
        day,
        tz,
        from: new Date(bounds.startUtcMs).toISOString(),
        to: new Date(bounds.endUtcMs).toISOString(),
        rows: buckets.map((totals, hour) => ({
          hour: `${day}T${String(hour).padStart(2, '0')}:00`,
          billable_total_tokens: totals.billable_total_tokens,
          total_tokens: totals.total_tokens,
          input_tokens: totals.input_tokens,
          output_tokens: totals.output_tokens,
          conversation_count: totals.conversation_count,
          total_cost_usd: null
        }))
      }
    })
  }

  function breakdown(validated = {}) {
    const period = validated.period || 'month'
    const tz = validated.tz || 'UTC'
    return cached(
      `breakdown|${period}|${tz}|${validated.from || ''}|${validated.to || ''}|${validated.scope || 'source'}`,
      () => {
        const range = rangeForPeriod({ ...validated, period, tz })
        const store = getStore()
        const totals = toTotalsPayload(store.sumRange({ fromIso: range.fromIso, toIso: range.toIso }))
        const groupedRows = store.getGroupedTotals({
          fromIso: range.fromIso,
          toIso: range.toIso,
          dimensions: ['source', 'model']
        })
        const sources = new Map()
        const flatModels = []
        for (const row of groupedRows) {
          const tokens = pickQueueTokens(row)
          let sourceEntry = sources.get(row.source)
          if (!sourceEntry) {
            sourceEntry = {
              source: row.source,
              label: SOURCE_LABELS[row.source] || row.source,
              totals: emptyTotals(),
              models: []
            }
            sources.set(row.source, sourceEntry)
          }
          addQueueTokens(sourceEntry.totals, tokens)
          sourceEntry.models.push({
            model: row.model,
            source: row.source,
            totals: aggregateTokenTotals(tokens),
            ...tokens
          })
          flatModels.push({ source: row.source, model: row.model, ...tokens, total_cost_usd: null, pricing: 'none' })
        }
        const totalBillable = totals.billable_total_tokens || 0
        const sourceList = [...sources.values()]
          .map((entry) => ({
            source: entry.source,
            label: entry.label,
            billable_total_tokens: entry.totals.billable_total_tokens,
            sharePct: sharePct(entry.totals.billable_total_tokens, totalBillable),
            modelCount: entry.models.length,
            conversationCount: entry.totals.conversation_count,
            total_cost_usd: null,
            totals: aggregateTokenTotals(entry.totals),
            models: entry.models
              .map((modelEntry) => ({
                ...modelEntry,
                billable_total_tokens: modelEntry.totals.billable_total_tokens,
                sharePct: sharePct(modelEntry.totals.billable_total_tokens, totalBillable)
              }))
              .sort((a, b) => b.billable_total_tokens - a.billable_total_tokens)
          }))
          .sort((a, b) => b.billable_total_tokens - a.billable_total_tokens)
        const models = flatModels
          .map((modelEntry) => ({ ...modelEntry, sharePct: sharePct(modelEntry.billable_total_tokens, totalBillable) }))
          .sort((a, b) => b.billable_total_tokens - a.billable_total_tokens)
        return { scope: validated.scope || 'source', period, from: range.fromDay, to: range.toDay, tz, totals, sources: sourceList, models }
      }
    )
  }

  function heatmap(validated = {}) {
    const tz = validated.tz || 'UTC'
    const weeks = validated.weeks || 52
    return cached(`heatmap|${tz}|${weeks}`, () => {
      const store = getStore()
      const today = usageTime.zonedDayKey(now(), tz)
      const weekdayIndex = usageTime.zonedWeekdayIndex(now(), tz) // 0 = Monday
      const currentWeekStart = usageTime.addDaysToDayKey(today, -weekdayIndex)
      const fromDay = usageTime.addDaysToDayKey(currentWeekStart, -(weeks - 1) * 7)
      const toDay = usageTime.addDaysToDayKey(currentWeekStart, 6)
      const startBounds = usageTime.resolveDayBounds(fromDay, tz)
      const endBounds = usageTime.resolveDayBounds(toDay, tz)
      const rows = store.getRangeHourlyTotals({
        fromIso: new Date(startBounds.startUtcMs).toISOString(),
        toIso: new Date(endBounds.endUtcMs).toISOString()
      })
      const byDay = new Map()
      for (const row of rows) {
        const day = zonedDayOf(row.hour_start, tz)
        if (day < fromDay || day > toDay) continue
        const entry = byDay.get(day) || { billable_total_tokens: 0, total_tokens: 0, conversation_count: 0 }
        entry.billable_total_tokens += Number(row.billable_total_tokens) || 0
        entry.total_tokens += Number(row.total_tokens) || 0
        entry.conversation_count += Number(row.conversation_count) || 0
        byDay.set(day, entry)
      }
      let max = 0
      for (const entry of byDay.values()) max = Math.max(max, entry.billable_total_tokens)
      let activeDays = 0
      const grid = []
      for (let week = 0; week < weeks; week += 1) {
        const cells = []
        for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
          const day = usageTime.addDaysToDayKey(fromDay, week * 7 + dayIndex)
          if (day > today) {
            cells.push(null)
            continue
          }
          const entry = byDay.get(day) || { billable_total_tokens: 0, total_tokens: 0, conversation_count: 0 }
          if (entry.billable_total_tokens > 0) activeDays += 1
          cells.push({
            day,
            value: entry.billable_total_tokens,
            billable_total_tokens: entry.billable_total_tokens,
            level: heatmapLevel(entry.billable_total_tokens, max),
            total_tokens: entry.total_tokens,
            conversation_count: entry.conversation_count
          })
        }
        grid.push(cells)
      }
      return { from: fromDay, to: toDay, tz, weekStartsOn: 'mon', activeDays, max, weeks: grid }
    })
  }

  function invalidate() {
    cache.clear()
    log('usage query: cache invalidated')
  }

  return {
    breakdown,
    daily,
    getCacheStats: () => cache.getStats(),
    heatmap,
    hourly,
    invalidate,
    summary
  }
}

module.exports = {
  RETENTION_MONTHS,
  SOURCE_LABELS,
  SUMMARY_INTEGER_COLUMNS,
  createLruCache,
  createUsageQuery,
  heatmapLevel
}
