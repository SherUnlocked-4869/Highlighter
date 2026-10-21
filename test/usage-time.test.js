const test = require('node:test')
const assert = require('node:assert/strict')

const {
  addDaysToDayKey,
  resolveCalendarPeriod,
  resolveDayBounds,
  resolveRollingWindow,
  splitDayKey,
  zonedDayKey,
  zonedDayStartUtcMs,
  zonedHour,
  zonedWeekdayIndex
} = require('../main/services/usage-time')

test('zonedDayKey maps UTC buckets onto local calendar days', () => {
  assert.equal(zonedDayKey('2026-10-20T16:30:00.000Z', 'Asia/Shanghai'), '2026-10-21')
  assert.equal(zonedDayKey('2026-10-20T15:30:00.000Z', 'Asia/Shanghai'), '2026-10-20')
  assert.equal(zonedDayKey('2026-10-21T00:00:00.000Z', 'UTC'), '2026-10-21')
  assert.equal(zonedDayKey(null, 'UTC'), '1970-01-01')
})

test('zonedDayStartUtcMs resolves local midnight for a fixed-offset zone', () => {
  assert.equal(
    zonedDayStartUtcMs('2026-10-21', 'Asia/Shanghai'),
    Date.parse('2026-10-20T16:00:00.000Z')
  )
  assert.equal(zonedDayStartUtcMs('2026-10-21', 'UTC'), Date.parse('2026-10-21T00:00:00.000Z'))
})

test('zonedDayStartUtcMs follows US DST transitions (2026-03-08 / 2026-11-01)', () => {
  // Spring forward: EST (UTC-5) -> EDT (UTC-4) on 2026-03-08 at 02:00 local.
  assert.equal(
    zonedDayStartUtcMs('2026-03-08', 'America/New_York'),
    Date.parse('2026-03-08T05:00:00.000Z')
  )
  assert.equal(
    zonedDayStartUtcMs('2026-03-09', 'America/New_York'),
    Date.parse('2026-03-09T04:00:00.000Z')
  )
  // Fall back: EDT (UTC-4) -> EST (UTC-5) on 2026-11-01 at 02:00 local.
  assert.equal(
    zonedDayStartUtcMs('2026-11-01', 'America/New_York'),
    Date.parse('2026-11-01T04:00:00.000Z')
  )
  assert.equal(
    zonedDayStartUtcMs('2026-11-02', 'America/New_York'),
    Date.parse('2026-11-02T05:00:00.000Z')
  )
})

test('resolveDayBounds reports 23h / 24h / 25h local days', () => {
  const spring = resolveDayBounds('2026-03-08', 'America/New_York')
  assert.equal(spring.startUtcMs, Date.parse('2026-03-08T05:00:00.000Z'))
  assert.equal(spring.endUtcMs, Date.parse('2026-03-09T04:00:00.000Z'))
  assert.equal(spring.hours, 23)

  const fall = resolveDayBounds('2026-11-01', 'America/New_York')
  assert.equal(fall.startUtcMs, Date.parse('2026-11-01T04:00:00.000Z'))
  assert.equal(fall.endUtcMs, Date.parse('2026-11-02T05:00:00.000Z'))
  assert.equal(fall.hours, 25)

  const shanghai = resolveDayBounds('2026-10-21', 'Asia/Shanghai')
  assert.equal(shanghai.hours, 24)
  assert.equal(shanghai.startUtcMs, Date.parse('2026-10-20T16:00:00.000Z'))
  assert.equal(shanghai.endUtcMs, Date.parse('2026-10-21T16:00:00.000Z'))
})

test('resolveCalendarPeriod: day/week/month/total use exact local bounds', () => {
  const now = new Date('2026-10-21T03:00:00.000Z') // Oct 21 11:00 Asia/Shanghai, Wednesday
  const day = resolveCalendarPeriod({ period: 'day', now, timeZone: 'Asia/Shanghai' })
  assert.deepEqual([day.fromDay, day.toDay], ['2026-10-21', '2026-10-21'])
  assert.equal(day.startUtcMs, Date.parse('2026-10-20T16:00:00.000Z'))
  assert.equal(day.endUtcMs, Date.parse('2026-10-21T16:00:00.000Z'))

  const week = resolveCalendarPeriod({ period: 'week', now, timeZone: 'Asia/Shanghai' })
  assert.deepEqual([week.fromDay, week.toDay], ['2026-10-19', '2026-10-25'])
  assert.equal(week.startUtcMs, Date.parse('2026-10-18T16:00:00.000Z'))
  assert.equal(week.endUtcMs, Date.parse('2026-10-25T16:00:00.000Z'))

  const month = resolveCalendarPeriod({ period: 'month', now, timeZone: 'Asia/Shanghai' })
  assert.deepEqual([month.fromDay, month.toDay], ['2026-10-01', '2026-10-31'])
  assert.equal(month.startUtcMs, Date.parse('2026-09-30T16:00:00.000Z'))
  assert.equal(month.endUtcMs, Date.parse('2026-10-31T16:00:00.000Z'))

  const total = resolveCalendarPeriod({ period: 'total', now, timeZone: 'Asia/Shanghai' })
  // 24 calendar months inclusive: first day of (current month - 23) .. local today.
  assert.deepEqual([total.fromDay, total.toDay], ['2024-11-01', '2026-10-21'])
  assert.equal(total.startUtcMs, Date.parse('2024-10-31T16:00:00.000Z'))
  assert.equal(total.endUtcMs, Date.parse('2026-10-21T16:00:00.000Z'))
})

test('resolveCalendarPeriod: custom range is inclusive of both local days', () => {
  const range = resolveCalendarPeriod({
    period: 'custom',
    timeZone: 'America/New_York',
    from: '2026-03-07',
    to: '2026-03-09'
  })
  assert.equal(range.fromDay, '2026-03-07')
  assert.equal(range.toDay, '2026-03-09')
  assert.equal(range.startUtcMs, Date.parse('2026-03-07T05:00:00.000Z'))
  // End is the start of 2026-03-10 (EDT): the 23h day is inside the range.
  assert.equal(range.endUtcMs, Date.parse('2026-03-10T04:00:00.000Z'))
  assert.throws(() => resolveCalendarPeriod({ period: 'custom', from: '2026-03-09', to: '2026-03-07' }), /range start is after range end/)
  assert.throws(() => resolveCalendarPeriod({ period: 'custom', from: '2026-02-30', to: '2026-03-07' }), /invalid day key/)
  assert.throws(() => resolveCalendarPeriod({ period: 'year' }), /invalid period/)
})

test('resolveRollingWindow: local last-7/last-30 days ending today', () => {
  const now = new Date('2026-10-21T03:00:00.000Z') // Oct 21 11:00 Asia/Shanghai
  const last7 = resolveRollingWindow({ days: 7, now, timeZone: 'Asia/Shanghai' })
  assert.deepEqual([last7.fromDay, last7.toDay], ['2026-10-15', '2026-10-21'])
  assert.equal(last7.startUtcMs, Date.parse('2026-10-14T16:00:00.000Z'))
  assert.equal(last7.endUtcMs, Date.parse('2026-10-21T16:00:00.000Z'))

  const last30 = resolveRollingWindow({ days: 30, now, timeZone: 'America/New_York' })
  // 2026-10-21T03:00Z is still 2026-10-20 23:00 in New York (EDT).
  assert.deepEqual([last30.fromDay, last30.toDay], ['2026-09-21', '2026-10-20'])
  assert.equal(last30.endUtcMs, Date.parse('2026-10-21T04:00:00.000Z'))
})

test('resolveCalendarPeriod: leap month, week across a year boundary, total across a year boundary', () => {
  const leapNow = new Date('2028-02-10T03:00:00.000Z')
  const leapMonth = resolveCalendarPeriod({ period: 'month', now: leapNow, timeZone: 'UTC' })
  assert.deepEqual([leapMonth.fromDay, leapMonth.toDay], ['2028-02-01', '2028-02-29'])

  const yearEnd = new Date('2026-12-31T03:00:00.000Z') // Thursday
  const week = resolveCalendarPeriod({ period: 'week', now: yearEnd, timeZone: 'UTC' })
  assert.deepEqual([week.fromDay, week.toDay], ['2026-12-28', '2027-01-03'])

  const newYear = new Date('2027-01-15T03:00:00.000Z')
  const total = resolveCalendarPeriod({ period: 'total', now: newYear, timeZone: 'UTC' })
  // 24 calendar months inclusive: February 2025 .. January 2027.
  assert.deepEqual([total.fromDay, total.toDay], ['2025-02-01', '2027-01-15'])
})

test('zoned helpers: hour, weekday and day arithmetic', () => {
  assert.equal(zonedHour('2026-10-20T16:30:00.000Z', 'Asia/Shanghai'), 0)
  assert.equal(zonedWeekdayIndex('2026-10-21T03:00:00.000Z', 'Asia/Shanghai'), 2) // Wednesday
  assert.equal(zonedWeekdayIndex('2026-10-25T03:00:00.000Z', 'Asia/Shanghai'), 6) // Sunday
  assert.equal(addDaysToDayKey('2026-02-28', 1), '2026-03-01')
  assert.equal(addDaysToDayKey('2026-12-31', 1), '2027-01-01')
  assert.equal(addDaysToDayKey('2026-10-21', -21), '2026-09-30')
  assert.deepEqual(splitDayKey('2026-10-21'), { year: 2026, month: 10, day: 21 })
})
