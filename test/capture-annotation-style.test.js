const test = require('node:test')
const assert = require('node:assert/strict')

const {
  WIDTH_PRESETS,
  WIDTHS,
  DEFAULT_WIDTH,
  resolveWidth,
  scaleFactor,
  textFontSize,
  serialRadius,
  highlightWidth
} = require('../capture/annotation-style')

test('the thickness whitelist is exactly the three shipped levels', () => {
  assert.deepEqual(WIDTHS, [2, 4, 8])
  assert.deepEqual(WIDTH_PRESETS.map((preset) => preset.label), ['细', '中', '粗'])
  assert.equal(DEFAULT_WIDTH, 4)
})

test('resolveWidth keeps whitelisted values and falls back to medium', () => {
  for (const width of [2, 4, 8]) {
    assert.equal(resolveWidth(width), width)
    assert.equal(resolveWidth(String(width)), width)
  }
  for (const invalid of [0, 1, 3, 5, 9, 14, '', null, undefined, 'abc', NaN, Infinity, -4]) {
    assert.equal(resolveWidth(invalid), 4, `${String(invalid)} should fall back to 4`)
  }
})

test('tool mappings stay pixel-identical to the previous three levels', () => {
  assert.deepEqual([2, 4, 8].map((width) => textFontSize(width)), [14, 20, 40])
  // max(12, width*3): the 4px level is still clamped to the 12px floor.
  assert.deepEqual([2, 4, 8].map((width) => serialRadius(width)), [12, 12, 24])
  assert.deepEqual([2, 4, 8].map((width) => highlightWidth(width)), [14, 16, 32])
})

test('export scaling multiplies the mapped size instead of the whitelist match', () => {
  assert.equal(textFontSize(4, 1.5), 30)
  assert.equal(serialRadius(4, 1.5), 18)
  assert.equal(highlightWidth(8, 2), 64)
  // A scaled float must not be treated as an unknown width.
  assert.equal(resolveWidth(6), 4)
  assert.equal(textFontSize(2, 3), 30)
})

test('a missing or nonsensical scale is ignored', () => {
  assert.equal(scaleFactor(undefined), 1)
  assert.equal(scaleFactor(0), 1)
  assert.equal(scaleFactor(-2), 1)
  assert.equal(scaleFactor(NaN), 1)
  assert.equal(scaleFactor('2'), 2)
  assert.equal(textFontSize(4), 20)
  assert.equal(serialRadius(8, 0), 24)
})
