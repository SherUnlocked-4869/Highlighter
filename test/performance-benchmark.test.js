const test = require('node:test')
const assert = require('node:assert/strict')
const {
  benchmarkMatcher,
  percentile,
  summarizeSamples
} = require('../scripts/benchmark-performance')

test('performance sample summaries use deterministic median and p95 values', () => {
  assert.equal(percentile([5, 1, 3, 2, 4], 0.5), 3)
  assert.equal(percentile([5, 1, 3, 2, 4], 0.95), 5)
  assert.deepEqual(summarizeSamples([3.456, 1.234, 2.345]), {
    runs: 3,
    minMs: 1.23,
    medianMs: 2.35,
    p95Ms: 3.46,
    maxMs: 3.46,
    samplesMs: [3.46, 1.23, 2.35]
  })
})

test('long-capture benchmark verifies the expected shift as well as timing it', () => {
  const result = benchmarkMatcher({
    width: 32,
    height: 180,
    axis: 'vertical',
    shift: 36,
    runs: 1
  })

  assert.equal(result.status, 'matched')
  assert.equal(result.detectedShift, 36)
  assert.equal(result.runs, 1)
  assert.ok(result.p95Ms >= 0)
})
