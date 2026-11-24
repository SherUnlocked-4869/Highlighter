const test = require('node:test')
const assert = require('node:assert/strict')
const { THRESHOLDS, evaluateBaseline, growthRatio, percentile, summarize } = require('../main/services/performance-budget')

function coldStarts(count, value) {
  return Array.from({ length: count }, () => value)
}

const baseline = {
  startupP95Ms: 1000,
  firstEditableP95Ms: 400,
  idlePrivateCommitMedianBytes: 300 * 1024 * 1024
}

test('C02: percentiles use the nearest-rank convention the report shows', () => {
  assert.equal(percentile([], 0.95), 0)
  assert.equal(percentile([5], 0.95), 5)
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5), 5)
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95), 10)
  assert.deepEqual(summarize([10, 20, 30]).runs, 3)
  // Non-finite samples never move a percentile.
  assert.equal(summarize([10, NaN, 20]).runs, 2)
})

test('C02: a 10% P95 regression is the boundary, not an approximation', () => {
  assert.equal(growthRatio(1100, 1000), 0.1)
  const atLimit = evaluateBaseline({
    current: { startupMs: coldStarts(20, 1100), firstEditableMs: coldStarts(20, 440), idlePrivateCommitBytes: coldStarts(5, 330 * 1024 * 1024), idleCpuPct: [0.4, 0.5, 0.4, 0.5, 0.4] },
    baseline
  })
  assert.equal(atLimit.ok, true)
  const overLimit = evaluateBaseline({
    current: { startupMs: coldStarts(20, 1101), firstEditableMs: coldStarts(20, 440), idlePrivateCommitBytes: coldStarts(5, 330 * 1024 * 1024), idleCpuPct: [0.4] },
    baseline
  })
  assert.equal(overLimit.ok, false)
  assert.equal(overLimit.checks.find((check) => check.id === 'startup-p95').code, 'regression')
})

test('C02: idle CPU is an absolute 0.5% rule and idle commit a 10% rule', () => {
  const cpu = evaluateBaseline({
    current: { startupMs: coldStarts(20, 900), firstEditableMs: coldStarts(20, 300), idlePrivateCommitBytes: coldStarts(5, 300 * 1024 * 1024), idleCpuPct: [0.6] },
    baseline
  })
  assert.equal(cpu.ok, false)
  assert.equal(cpu.checks.find((check) => check.id === 'idle-cpu').code, 'regression')
  const commit = evaluateBaseline({
    current: { startupMs: coldStarts(20, 900), firstEditableMs: coldStarts(20, 300), idlePrivateCommitBytes: coldStarts(5, 331 * 1024 * 1024), idleCpuPct: [0.2] },
    baseline
  })
  assert.equal(commit.ok, false)
  assert.equal(commit.checks.find((check) => check.id === 'idle-private-commit').code, 'regression')
})

test('C02: a short run cannot claim a pass', () => {
  const result = evaluateBaseline({
    current: { startupMs: [900, 910, 905], firstEditableMs: [300], idlePrivateCommitBytes: [300 * 1024 * 1024], idleCpuPct: [0.1] },
    baseline
  })
  assert.equal(result.ok, false)
  assert.equal(result.checks[0].code, 'insufficient-samples')
  assert.equal(result.checks[0].baseline, THRESHOLDS.minimumColdStarts)
})

test('C02: a missing baseline is a failure, not a silent pass', () => {
  const result = evaluateBaseline({
    current: { startupMs: coldStarts(20, 900), firstEditableMs: coldStarts(20, 300), idlePrivateCommitBytes: coldStarts(5, 1), idleCpuPct: [0.1] },
    baseline: {}
  })
  assert.equal(result.ok, false)
  assert.ok(result.checks.some((check) => check.code === 'no-baseline'))
})
const { parseArgs } = require('../scripts/startup-baseline')

test('C02: the collection script requires a probe and parses repeatable idle samples', () => {
  assert.throws(() => parseArgs([]), /--probe/)
  const args = parseArgs(['--probe', 'node -p READY', '--runs', '20', '--idle-private-commit', '100', '--idle-private-commit', '110', '--idle-cpu', '0.2'])
  assert.equal(args.probe, 'node -p READY')
  assert.equal(args.runs, 20)
  assert.deepEqual(args.idlePrivateCommit, [100, 110])
  assert.deepEqual(args.idleCpu, [0.2])
  assert.equal(parseArgs(['--probe', 'x', '--runs', '0']).runs, 1, 'runs is clamped to at least one')
})

