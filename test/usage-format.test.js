'use strict'

// Unit tests for shared/usage-format.js (B4-4/B4-5 pure helpers).
//
// The formatters are the page's only numeric truth: every compact number,
// percentage, range label and tooltip goes through them, so the rounding
// boundaries are pinned here rather than discovered in a screenshot.

const test = require('node:test')
const assert = require('node:assert/strict')

const format = require('../shared/usage-format')

test('formatCompactToken renders English units with one trimmed decimal', () => {
  assert.equal(format.formatCompactToken(0), '0')
  assert.equal(format.formatCompactToken(1), '1')
  assert.equal(format.formatCompactToken(999), '999')
  assert.equal(format.formatCompactToken(1000), '1K')
  assert.equal(format.formatCompactToken(1500), '1.5K')
  assert.equal(format.formatCompactToken(195000), '195K')
  assert.equal(format.formatCompactToken(195200), '195.2K')
  assert.equal(format.formatCompactToken(195200000), '195.2M')
  assert.equal(format.formatCompactToken(1500000000), '1.5B')
  // Trailing zero is trimmed instead of printing "2.0B".
  assert.equal(format.formatCompactToken(2000000000), '2B')
  assert.equal(format.formatCompactToken(1234567890123), '1.2T')
})

test('formatCompactToken promotes when rounding crosses a unit boundary', () => {
  // 999.95K rounds to 1000K, which must become 1M (plan §2.8 example).
  assert.equal(format.formatCompactToken(999949), '999.9K')
  assert.equal(format.formatCompactToken(999950), '1M')
  // The same boundary at the integer -> K step.
  assert.equal(format.formatCompactToken(999.4), '999')
  assert.equal(format.formatCompactToken(999.6), '1K')
  // And the largest unit keeps a readable mantissa.
  assert.equal(format.formatCompactToken(1e15), '1000T')
})

test('formatCompactToken uses 万/亿 for Chinese and 萬/億 for zh-TW', () => {
  assert.equal(format.formatCompactToken(9999, 'zh-CN'), '9999')
  assert.equal(format.formatCompactToken(10000, 'zh-CN'), '1万')
  assert.equal(format.formatCompactToken(12345, 'zh-CN'), '1.2万')
  assert.equal(format.formatCompactToken(1952000, 'zh-CN'), '195.2万')
  assert.equal(format.formatCompactToken(18422310, 'zh-CN'), '1842.2万')
  assert.equal(format.formatCompactToken(100000000, 'zh-CN'), '1亿')
  assert.equal(format.formatCompactToken(150000000, 'zh-CN'), '1.5亿')
  // 9999.95万 rounds to 10000万, which promotes to 1亿.
  assert.equal(format.formatCompactToken(99999500, 'zh-CN'), '1亿')
  // Traditional Chinese uses the traditional unit glyphs.
  assert.equal(format.formatCompactToken(10000, 'zh-TW'), '1萬')
  assert.equal(format.formatCompactToken(150000000, 'zh-TW'), '1.5億')
  // An unknown / absent language falls back to the English units.
  assert.equal(format.formatCompactToken(1500), '1.5K')
})

test('token formatters treat negative and non-finite input as zero', () => {
  for (const value of [undefined, null, NaN, Infinity, -Infinity, 'abc', {}, [], -1, -1500]) {
    assert.equal(format.formatCompactToken(value), '0', `compact ${String(value)}`)
    assert.equal(format.formatFullToken(value), '0', `full ${String(value)}`)
  }
})

test('formatFullToken groups every digit for tooltips', () => {
  assert.equal(format.formatFullToken(0), '0')
  assert.equal(format.formatFullToken(999), '999')
  assert.equal(format.formatFullToken(1000), '1,000')
  assert.equal(format.formatFullToken(1234), '1,234')
  assert.equal(format.formatFullToken(18422310), '18,422,310')
  // Rounding happens before grouping.
  assert.equal(format.formatFullToken(999.6), '1,000')
  assert.equal(format.formatFullToken('5102000'), '5,102,000')
})

test('formatSharePct clamps to 0..100 and trims trailing zeros', () => {
  assert.equal(format.formatSharePct(0), '0%')
  assert.equal(format.formatSharePct(50), '50%')
  assert.equal(format.formatSharePct(77.08), '77.1%')
  assert.equal(format.formatSharePct(16.29), '16.3%')
  assert.equal(format.formatSharePct(0.54), '0.5%')
  assert.equal(format.formatSharePct(100), '100%')
  assert.equal(format.formatSharePct(100.4), '100%')
  assert.equal(format.formatSharePct(-3), '0%')
  assert.equal(format.formatSharePct(NaN), '0%')
  assert.equal(format.formatSharePct(undefined), '0%')
  assert.equal(format.formatSharePct(12.345, 2), '12.35%')
  // A malformed precision falls back to the documented one decimal.
  assert.equal(format.formatSharePct(12.345, 9), '12.3%')
})

test('formatRangeLabel renders the inclusive day range', () => {
  assert.equal(format.formatRangeLabel('month', '2026-10-01', '2026-10-21'), '2026-10-01 – 2026-10-21')
  assert.equal(format.formatRangeLabel('total', '2024-10-22', '2026-10-21'), '2024-10-22 – 2026-10-21')
  assert.equal(format.formatRangeLabel('day', '2026-10-21', '2026-10-21'), '2026-10-21')
  // A single boundary still renders; both missing renders nothing.
  assert.equal(format.formatRangeLabel('week', '2026-10-19', ''), '2026-10-19')
  assert.equal(format.formatRangeLabel('week', '', '2026-10-25'), '2026-10-25')
  assert.equal(format.formatRangeLabel('month', '', ''), '')
  // Garbage boundaries degrade to the valid side instead of "Invalid Date".
  assert.equal(format.formatRangeLabel('month', 'not-a-date', '2026-10-21'), '2026-10-21')
})

test('formatTooltip builds plain text with full grouped values', () => {
  const text = format.formatTooltip({
    title: '2026-10-20',
    rows: [
      { label: 'Input', value: 1234 },
      { label: 'Cache', value: 161700 },
      { label: 'Output', value: 1330 },
      { label: 'Total', value: 184223 }
    ]
  })
  assert.equal(text, '2026-10-20\nInput: 1,234\nCache: 161,700\nOutput: 1,330\nTotal: 184,223')
  // Invalid row values render as 0, malformed rows are skipped.
  assert.equal(format.formatTooltip({ title: 'Day', rows: [{ label: 'Input', value: NaN }, null, { value: 4 }, { label: ' ' }] }), 'Day\nInput: 0')
  assert.equal(format.formatTooltip({ rows: [{ label: 'Output', value: 5 }] }), 'Output: 5')
  assert.equal(format.formatTooltip(), '')
  assert.equal(format.formatTooltip({ title: '  2026-10-20  ' }), '2026-10-20')
})

test('heatmapLevelClass maps payload levels to the five CSS buckets', () => {
  assert.equal(format.heatmapLevelClass(0), 'level-0')
  assert.equal(format.heatmapLevelClass(1), 'level-1')
  assert.equal(format.heatmapLevelClass(2), 'level-2')
  assert.equal(format.heatmapLevelClass(3), 'level-3')
  assert.equal(format.heatmapLevelClass(4), 'level-4')
  // Out-of-range and malformed levels never paint a hot cell.
  assert.equal(format.heatmapLevelClass(5), 'level-4')
  assert.equal(format.heatmapLevelClass(-1), 'level-0')
  assert.equal(format.heatmapLevelClass(2.6), 'level-3')
  assert.equal(format.heatmapLevelClass('3'), 'level-3')
  for (const value of [undefined, null, NaN, Infinity, 'x']) {
    assert.equal(format.heatmapLevelClass(value), 'level-0', `level ${String(value)}`)
  }
})

test('layoutHeatmapWeeks normalizes and pads the frozen heatmap payload', () => {
  const fixture = require('./fixtures/usage/ipc/heatmap.json')
  const model = format.layoutHeatmapWeeks(fixture.weeks)
  assert.equal(model.columns.length, 2)
  // Monday-first payload order is preserved, seven rows per column.
  for (const column of model.columns) assert.equal(column.length, 7)
  assert.equal(model.columns[0][0].day, '2026-10-05')
  assert.equal(model.columns[0][0].value, 1700000)
  assert.equal(model.columns[0][0].level, 3)
  assert.equal(model.columns[1][6].day, '2026-10-18')
  // Both columns are October 2026, so the tick row has exactly one label.
  assert.deepEqual(model.months, [{ index: 0, month: '2026-10' }])
})

test('layoutHeatmapWeeks emits month ticks when the grid crosses a month', () => {
  const cell = (day) => ({ day, value: 10, level: 1, total_tokens: 10, conversation_count: 1 })
  const model = format.layoutHeatmapWeeks([
    [cell('2026-09-28'), cell('2026-09-29'), cell('2026-09-30'), cell('2026-10-01'), cell('2026-10-02'), cell('2026-10-03'), cell('2026-10-04')],
    [cell('2026-10-05'), cell('2026-10-06'), cell('2026-10-07'), cell('2026-10-08'), cell('2026-10-09'), cell('2026-10-10'), cell('2026-10-11')]
  ])
  // The tick is anchored on the first populated row (Monday) of each column.
  assert.deepEqual(model.months, [
    { index: 0, month: '2026-09' },
    { index: 1, month: '2026-10' }
  ])
})

test('layoutHeatmapWeeks pads short weeks and drops malformed cells', () => {
  const model = format.layoutHeatmapWeeks([
    [{ day: '2026-10-05', value: '123', level: 9, total_tokens: '9', conversation_count: '4' }],
    null,
    [null, { day: 'not-a-day', value: 5, level: 1 }, { day: '2026-10-13', value: -2, level: -1 }]
  ])
  assert.equal(model.columns.length, 3)
  assert.equal(model.columns[0].length, 7)
  assert.equal(model.columns[0][0].value, 123)
  assert.equal(model.columns[0][0].level, 4)
  assert.equal(model.columns[0][0].conversation_count, 4)
  assert.deepEqual(model.columns[0].slice(1), [null, null, null, null, null, null])
  assert.deepEqual(model.columns[1], [null, null, null, null, null, null, null])
  // Invalid day cells are dropped; negative values clamp to 0.
  assert.equal(model.columns[2][0], null)
  assert.equal(model.columns[2][1], null)
  assert.equal(model.columns[2][2].value, 0)
  assert.equal(model.columns[2][2].level, 0)
  // Only columns with an anchor produce a month tick; the all-null column is skipped.
  assert.deepEqual(model.months, [{ index: 0, month: '2026-10' }])
})

test('layoutHeatmapWeeks tolerates a missing or malformed payload', () => {
  for (const value of [undefined, null, {}, 'weeks', 42]) {
    assert.deepEqual(format.layoutHeatmapWeeks(value), { columns: [], months: [] }, `payload ${String(value)}`)
  }
})

test('validateCustomRange enforces order, future and the 800-day span', () => {
  const today = '2026-10-21'
  assert.deepEqual(format.validateCustomRange('2026-10-01', '2026-10-21', today), {
    valid: true, reason: '', from: '2026-10-01', to: '2026-10-21'
  })
  // A single day is a valid custom range.
  assert.equal(format.validateCustomRange(today, today, today).valid, true)
  // Exactly 800 days is accepted; 801 is not (plan §2.7 validation matrix).
  const from800 = format.addDays(today, -format.CUSTOM_RANGE_MAX_SPAN_DAYS)
  const from801 = format.addDays(today, -(format.CUSTOM_RANGE_MAX_SPAN_DAYS + 1))
  assert.equal(format.validateCustomRange(from800, today, today).valid, true)
  assert.deepEqual(format.validateCustomRange(from801, today, today), { valid: false, reason: 'span', from: from801, to: today })
  // Start after end.
  assert.equal(format.validateCustomRange(today, '2026-10-20', today).reason, 'order')
  // Future end date.
  assert.equal(format.validateCustomRange(today, format.addDays(today, 1), today).reason, 'future')
  // Malformed bounds name the offending side.
  assert.deepEqual(format.validateCustomRange('2026-1-1', today, today), { valid: false, reason: 'from', from: '', to: today })
  assert.equal(format.validateCustomRange('', today, today).reason, 'from')
  assert.deepEqual(format.validateCustomRange(today, 'not-a-day', today), { valid: false, reason: 'to', from: today, to: '' })
  // With no "today" reference the future check is skipped but the span still applies.
  assert.equal(format.validateCustomRange('2026-10-01', '2026-10-21').valid, true)
})

test('toDayKey normalizes Date instances and day-key strings', () => {
  assert.equal(format.toDayKey(new Date(2026, 9, 21, 23, 30)), '2026-10-21')
  assert.equal(format.toDayKey('2026-10-21'), '2026-10-21')
  assert.equal(format.toDayKey('  2026-10-21  '), '2026-10-21')
  assert.equal(format.toDayKey('2026-1-1'), '')
  assert.equal(format.toDayKey(new Date(NaN)), '')
  assert.equal(format.toDayKey(undefined), '')
  assert.equal(format.toDayKey(null), '')
})

test('addDays does calendar-day arithmetic across month and leap boundaries', () => {
  assert.equal(format.addDays('2026-10-01', -1), '2026-09-30')
  assert.equal(format.addDays('2026-12-31', 1), '2027-01-01')
  assert.equal(format.addDays('2026-03-01', -1), '2026-02-28')
  assert.equal(format.addDays('2024-02-28', 1), '2024-02-29')
  assert.equal(format.addDays('2026-10-21', 0), '2026-10-21')
  assert.equal(format.addDays('2026-10-01', -29), '2026-09-02')
  assert.equal(format.addDays('2026-10-21', '5'), '2026-10-26')
  assert.equal(format.addDays('invalid', 1), '')
  assert.equal(format.addDays('2026-10-21', NaN), '')
})

test('isChineseLanguage matches zh variants only', () => {
  assert.equal(format.isChineseLanguage('zh-CN'), true)
  assert.equal(format.isChineseLanguage('zh-TW'), true)
  assert.equal(format.isChineseLanguage('zh'), true)
  assert.equal(format.isChineseLanguage('en-US'), false)
  assert.equal(format.isChineseLanguage(''), false)
  assert.equal(format.isChineseLanguage(undefined), false)
})

test('the UMD surface exposes exactly the helpers the page uses', () => {
  assert.deepEqual(Object.keys(format).sort(), [
    'CUSTOM_RANGE_MAX_SPAN_DAYS',
    'addDays',
    'formatCompactToken',
    'formatFullToken',
    'formatRangeLabel',
    'formatSharePct',
    'formatTooltip',
    'heatmapLevelClass',
    'isChineseLanguage',
    'layoutHeatmapWeeks',
    'toDayKey',
    'validateCustomRange'
  ])
})
