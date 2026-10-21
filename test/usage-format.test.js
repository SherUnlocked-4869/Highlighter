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
    'addDays',
    'formatCompactToken',
    'formatFullToken',
    'formatRangeLabel',
    'formatSharePct',
    'formatTooltip',
    'isChineseLanguage',
    'toDayKey'
  ])
})
