// Usage time helpers (B1 subset; B3 extends with the TokenTracker date-range
// parity cases).
//
// The parsers write UTC half-hour buckets, while the page works in local
// calendar days (`tz` from `Intl.DateTimeFormat().resolvedOptions().timeZone`).
// Calendar dates must therefore be converted to exact UTC instants: a
// `YYYY-MM-DD` local day starts at the previous UTC day's 16:00 for
// Asia/Shanghai, at 05:00Z for America/New_York in winter and at 04:00Z in
// summer. Reading to ~12:00 (the DOM hour of 2:00am) correctly resolves an
// offset even across DST transitions because the result is verified against
// the wall clock.
//
// Pure functions only: no Electron, no SQLite, no clock except the injected
// `now`. Week starts on Monday (plan S5); total = the last 24 months.

const DAY_MS = 24 * 60 * 60 * 1000
const RETENTION_MONTHS = 24

function isValidTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch (_error) {
    return false
  }
}

function safeTimeZone(timeZone) {
  return isValidTimeZone(timeZone) ? timeZone : 'UTC'
}

function toDate(value) {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isFinite(date.getTime()) ? date : new Date()
}

const PART_ORDERS = new Map()

function partsFormatter(timeZone) {
  let formatter = PART_ORDERS.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
    PART_ORDERS.set(timeZone, formatter)
  }
  return formatter
}

// Wall-clock parts of an instant interpreted in `timeZone`.
function zonedParts(value, timeZone = 'UTC') {
  const tz = safeTimeZone(timeZone)
  const date = toDate(value)
  const parts = partsFormatter(tz).formatToParts(date)
  const lookup = {}
  for (const part of parts) {
    if (part.type !== 'literal') lookup[part.type] = part.value
  }
  return {
    year: Number(lookup.year),
    month: Number(lookup.month),
    day: Number(lookup.day),
    hour: Number(lookup.hour),
    minute: Number(lookup.minute),
    second: Number(lookup.second)
  }
}

function pad2(value) {
  return String(value).padStart(2, '0')
}

// 'YYYY-MM-DD' calendar day of an instant in `timeZone`.
function zonedDayKey(value, timeZone = 'UTC') {
  const parts = zonedParts(value, timeZone)
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`
}

// 0 = Monday ... 6 = Sunday (plan S5: fixed Monday-first weeks).
function zonedWeekdayIndex(value, timeZone = 'UTC') {
  const tz = safeTimeZone(timeZone)
  try {
    const label = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(toDate(value))
    const index = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(label)
    return index === -1 ? 0 : index
  } catch (_error) {
    return 0
  }
}

function zonedHour(value, timeZone = 'UTC') {
  return zonedParts(value, timeZone).hour
}

// Pure calendar-day arithmetic on a day key (UTC date math, no zone involved).
function addDaysToDayKey(dayKey, days) {
  const ms = Date.parse(`${dayKey}T00:00:00.000Z`)
  if (!Number.isFinite(ms)) return dayKey
  return new Date(ms + Math.trunc(days) * DAY_MS).toISOString().slice(0, 10)
}

function splitDayKey(dayKey) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayKey || ''))
  if (!match) throw new Error(`usage: invalid day key ${String(dayKey)}`)
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const probe = new Date(Date.UTC(year, month - 1, day))
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new Error(`usage: invalid day key ${String(dayKey)}`)
  }
  return { year, month, day }
}

// UTC instant (ms) of `dayKey 00:00` in `timeZone`, resolved against the zone
// offset at that wall-clock time. Two passes settle the DST boundary cases; the
// final verification pass handles zones whose transition lands on midnight.
function zonedDayStartUtcMs(dayKey, timeZone = 'UTC') {
  const tz = safeTimeZone(timeZone)
  const { year, month, day } = splitDayKey(dayKey)
  const wallAsUtc = Date.UTC(year, month - 1, day, 0, 0, 0, 0)
  const offsetAt = (utcMs) => {
    const parts = zonedParts(utcMs, tz)
    return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - utcMs
  }
  let instant = wallAsUtc
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const adjusted = wallAsUtc - offsetAt(instant)
    if (adjusted === instant) break
    instant = adjusted
  }
  return instant
}

// Exact UTC bounds of one local calendar day: [start, end) with 23h/24h/25h
// durations on DST transition days.
function resolveDayBounds(dayKey, timeZone = 'UTC') {
  const tz = safeTimeZone(timeZone)
  const startUtcMs = zonedDayStartUtcMs(dayKey, tz)
  const endUtcMs = zonedDayStartUtcMs(addDaysToDayKey(dayKey, 1), tz)
  return { day: dayKey, startUtcMs, endUtcMs, hours: (endUtcMs - startUtcMs) / (60 * 60 * 1000) }
}

// Resolve a page period into local day labels + exact UTC instant bounds.
// Semantics (plan §2.6): day = today; week = Monday..Sunday around today;
// month = natural month; total = last 24 months; custom = caller-provided
// inclusive day range.
function resolveCalendarPeriod({
  period = 'month',
  now = new Date(),
  timeZone = 'UTC',
  from = null,
  to = null
} = {}) {
  const tz = safeTimeZone(timeZone)
  const current = toDate(now)
  const todayKey = zonedDayKey(current, tz)
  let fromDay = todayKey
  let toDay = todayKey
  if (period === 'week') {
    fromDay = addDaysToDayKey(todayKey, -zonedWeekdayIndex(current, tz))
    toDay = addDaysToDayKey(fromDay, 6)
  } else if (period === 'month') {
    fromDay = `${todayKey.slice(0, 7)}-01`
    const [year, month] = fromDay.split('-').map((part) => Number(part))
    toDay = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)
  } else if (period === 'total') {
    const [year, month] = todayKey.split('-').map((part) => Number(part))
    // 24 calendar months inclusive: current local month minus 23 ... local today
    // (TokenTracker date-range.ts semantics).
    const start = new Date(Date.UTC(year, month - RETENTION_MONTHS, 1))
    fromDay = start.toISOString().slice(0, 10)
    toDay = todayKey
  } else if (period === 'custom') {
    if (!from || !to) throw new Error('usage: custom period requires from and to')
    splitDayKey(from)
    splitDayKey(to)
    if (from > to) throw new Error('usage: range start is after range end')
    fromDay = from
    toDay = to
  } else if (period !== 'day') {
    throw new Error(`usage: invalid period: ${String(period)}`)
  }
  const startUtcMs = zonedDayStartUtcMs(fromDay, tz)
  const endUtcMs = zonedDayStartUtcMs(addDaysToDayKey(toDay, 1), tz)
  return { period, tz, fromDay, toDay, startUtcMs, endUtcMs }
}

// Rolling KPI windows (TokenTracker local-api.js 2427-2464): last N local days
// ending today, inclusive; active days are counted from the observed rows.
function resolveRollingWindow({ days = 7, now = new Date(), timeZone = 'UTC' } = {}) {
  const tz = safeTimeZone(timeZone)
  const current = toDate(now)
  const todayKey = zonedDayKey(current, tz)
  const fromDay = addDaysToDayKey(todayKey, -(Math.max(1, Math.trunc(days)) - 1))
  return {
    days: Math.max(1, Math.trunc(days)),
    fromDay,
    toDay: todayKey,
    startUtcMs: zonedDayStartUtcMs(fromDay, tz),
    endUtcMs: zonedDayStartUtcMs(addDaysToDayKey(todayKey, 1), tz)
  }
}

module.exports = {
  DAY_MS,
  RETENTION_MONTHS,
  addDaysToDayKey,
  isValidTimeZone,
  resolveCalendarPeriod,
  resolveDayBounds,
  resolveRollingWindow,
  safeTimeZone,
  splitDayKey,
  zonedDayKey,
  zonedDayStartUtcMs,
  zonedHour,
  zonedParts,
  zonedWeekdayIndex
}
