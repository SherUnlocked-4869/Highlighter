const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { THRESHOLDS, evaluateBaseline, growthRatio, percentile, summarize } = require('../main/services/performance-budget')

function coldStarts(count, value) {
  return Array.from({ length: count }, () => value)
}

const baseline = {
  startupP95Ms: 1000,
  loginToTrayP95Ms: 800,
  manualToFirstFrameP95Ms: 600,
  firstEditableP95Ms: 400,
  secondEditableP95Ms: 300,
  idlePrivateCommitMedianBytes: 300 * 1024 * 1024
}

function fullCurrent(overrides = {}) {
  return {
    startupMs: coldStarts(20, 900),
    loginToTrayMs: coldStarts(20, 700),
    manualToFirstFrameMs: coldStarts(20, 500),
    firstEditableMs: coldStarts(20, 300),
    secondEditableMs: coldStarts(20, 200),
    idlePrivateCommitBytes: coldStarts(5, 300 * 1024 * 1024),
    idleCpuPct: [0.2, 0.2, 0.2, 0.2, 0.2],
    ...overrides
  }
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
    current: fullCurrent({
      startupMs: coldStarts(20, 1100),
      firstEditableMs: coldStarts(20, 440),
      idlePrivateCommitBytes: coldStarts(5, 330 * 1024 * 1024),
      idleCpuPct: [0.4, 0.5, 0.4, 0.5, 0.4]
    }),
    baseline
  })
  assert.equal(atLimit.ok, true)
  const overLimit = evaluateBaseline({
    current: fullCurrent({
      startupMs: coldStarts(20, 1101),
      firstEditableMs: coldStarts(20, 440),
      idlePrivateCommitBytes: coldStarts(5, 330 * 1024 * 1024),
      idleCpuPct: [0.4, 0.4, 0.4, 0.4, 0.4]
    }),
    baseline
  })
  assert.equal(overLimit.ok, false)
  assert.equal(overLimit.checks.find((check) => check.id === 'startup-p95').code, 'regression')
})

test('C02: idle CPU is an absolute 0.5% rule and idle commit a 10% rule', () => {
  const cpu = evaluateBaseline({
    current: fullCurrent({ idleCpuPct: [0.6, 0.6, 0.6, 0.6, 0.6] }),
    baseline
  })
  assert.equal(cpu.ok, false)
  assert.equal(cpu.checks.find((check) => check.id === 'idle-cpu').code, 'regression')
  const commit = evaluateBaseline({
    current: fullCurrent({ idlePrivateCommitBytes: coldStarts(5, 331 * 1024 * 1024) }),
    baseline
  })
  assert.equal(commit.ok, false)
  assert.equal(commit.checks.find((check) => check.id === 'idle-private-commit').code, 'regression')
})

test('C02: a short run cannot claim a pass', () => {
  const result = evaluateBaseline({
    current: fullCurrent({ startupMs: [900, 910, 905] }),
    baseline
  })
  assert.equal(result.ok, false)
  assert.equal(result.checks[0].code, 'insufficient-samples')
  assert.equal(result.checks[0].baseline, THRESHOLDS.minimumColdStarts)
})

test('C02: a missing baseline is a failure, not a silent pass', () => {
  const result = evaluateBaseline({
    current: fullCurrent(),
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


// ---------------------------------------------------------------------------
// C02 (plan item 15): every required metric is judged on its OWN samples and baseline.
// ---------------------------------------------------------------------------

const { REQUIRED_METRICS, currentFromReport } = require('../main/services/performance-budget')
const { collectSeries, runOnce } = require('../scripts/startup-baseline')

function completeCurrent(overrides = {}) {
  return fullCurrent({
    idleRoundIds: ['r1', 'r2', 'r3', 'r4', 'r5'],
    idleSpanMs: 5 * 30 * 60 * 1000,
    ...overrides
  })
}

test('C02 (15): only startup samples cannot pass the gate', () => {
  const current = { startupMs: coldStarts(20, 900) }
  const result = evaluateBaseline({ current, baseline })
  assert.equal(result.ok, false)
  const startup = result.checks.find((check) => check.id === 'startup-p95')
  assert.equal(startup.code, 'ok', 'the measured metric is judged normally')
  for (const id of ['login-to-tray-p95', 'manual-to-first-frame-p95', 'first-editable-p95', 'second-editable-p95']) {
    const check = result.checks.find((entry) => entry.id === id)
    assert.equal(check.code, 'insufficient-samples', id + ' has no samples')
    assert.equal(check.reason, 'not-measured', id + ' says why')
  }
  assert.equal(result.checks.find((entry) => entry.id === 'idle-cpu').code, 'insufficient-samples')
})

test('C02 (15): 19 first-editable samples fail that metric while the others pass', () => {
  const result = evaluateBaseline({ current: completeCurrent({ firstEditableMs: coldStarts(19, 300) }), baseline })
  assert.equal(result.ok, false)
  const firstEditable = result.checks.find((check) => check.id === 'first-editable-p95')
  assert.equal(firstEditable.code, 'insufficient-samples')
  assert.equal(firstEditable.current, 19)
  assert.equal(firstEditable.required, 20)
  for (const id of ['startup-p95', 'login-to-tray-p95', 'manual-to-first-frame-p95', 'second-editable-p95', 'idle-cpu']) {
    assert.equal(result.checks.find((entry) => entry.id === id).code, 'ok', id)
  }
})

test('C02 (15): four standby rounds are not a standby baseline', () => {
  const result = evaluateBaseline({
    current: completeCurrent({
      idlePrivateCommitBytes: coldStarts(4, 300 * 1024 * 1024),
      idleCpuPct: [0.1, 0.1, 0.1, 0.1],
      idleRoundIds: ['r1', 'r2', 'r3', 'r4'],
      idleSpanMs: 4 * 30 * 60 * 1000
    }),
    baseline
  })
  assert.equal(result.ok, false)
  for (const id of ['idle-private-commit', 'idle-cpu']) {
    const check = result.checks.find((entry) => entry.id === id)
    assert.equal(check.code, 'insufficient-samples')
    assert.equal(check.required, 5)
  }
})

test('C02 (15): one standby round repeated five times is one measurement', () => {
  const repeated = evaluateBaseline({
    current: completeCurrent({ idleRoundIds: ['r1', 'r1', 'r1', 'r1', 'r1'] }),
    baseline
  })
  assert.equal(repeated.ok, false)
  assert.equal(repeated.checks.find((check) => check.id === 'idle-cpu').reason, 'duplicate-standby-rounds')
  // A standby window shorter than the plan's 5 x 30 minutes is refused even with 5 arrays.
  const short = evaluateBaseline({
    current: completeCurrent({ idleSpanMs: 10 * 60 * 1000 }),
    baseline
  })
  assert.equal(short.ok, false)
  assert.equal(short.checks.find((check) => check.id === 'idle-private-commit').reason, 'standby-window-too-short')
})

test('C02 (15): a null or a text sample is not a number and shrinks the series', () => {
  const withNulls = completeCurrent({ startupMs: [...coldStarts(19, 900), null] })
  const result = evaluateBaseline({ current: withNulls, baseline })
  assert.equal(result.checks.find((check) => check.id === 'startup-p95').code, 'insufficient-samples')
  const withText = completeCurrent({ manualToFirstFrameMs: [...coldStarts(19, 500), 'slow'] })
  const textResult = evaluateBaseline({ current: withText, baseline })
  assert.equal(textResult.checks.find((check) => check.id === 'manual-to-first-frame-p95').code, 'insufficient-samples')
})

test('C02 (15): a real zero idle CPU is a measurement, not a missing value', () => {
  const result = evaluateBaseline({ current: completeCurrent({ idleCpuPct: [0, 0, 0, 0, 0] }), baseline })
  assert.equal(result.ok, true, JSON.stringify(result.checks.filter((check) => !check.ok)))
  const cpu = result.checks.find((check) => check.id === 'idle-cpu')
  assert.equal(cpu.code, 'ok')
  assert.equal(cpu.current, 0)
})

test('C02 (15): a complete sample set passes every required metric', () => {
  const result = evaluateBaseline({ current: completeCurrent(), baseline })
  assert.equal(result.ok, true, JSON.stringify(result.checks.filter((check) => !check.ok)))
  assert.deepEqual(result.checks.map((check) => check.id), REQUIRED_METRICS.map((metric) => metric.id))
})

test('C02 (15): an old report is sample-insufficient instead of silently passing', () => {
  // Schema 1 wrote only startupMs and copied that array into firstEditableMs.
  const legacy = { schemaVersion: 1, startupMs: coldStarts(20, 900) }
  const current = currentFromReport(legacy)
  assert.deepEqual(current.firstEditableMs, [], 'the copied array is not evidence')
  assert.match(current.missing.firstEditableMs, /legacy-report-(missing-column|copied-startup-samples)/)
  const result = evaluateBaseline({ current, baseline })
  assert.equal(result.ok, false)
  const firstEditable = result.checks.find((check) => check.id === 'first-editable-p95')
  assert.equal(firstEditable.code, 'insufficient-samples')
  assert.match(firstEditable.reason, /legacy-report/)
  // The modern shape keeps its own arrays.
  const modern = currentFromReport({ schemaVersion: 2, startupMs: [1], firstEditableMs: [2] })
  assert.deepEqual(modern.firstEditableMs, [2])
})

test('C02 (15): the collector records each marker as its own series, never a copied array', async (t) => {
  const markerScript = [
    "const m = process.argv[1]",
    "if (m === 'all') { console.log('READY'); setTimeout(() => console.log('EDITABLE_1'), 20); setTimeout(() => console.log('EDITABLE_2'), 40) }",
    "else console.log('READY')"
  ].join('; ')
  const probe = '"' + process.execPath + '" -e "' + markerScript.replace(/"/g, '\\"') + '"'
  const collected = await collectSeries({
    probe,
    runs: 2,
    timeoutMs: 20000,
    markers: {
      startupMs: 'READY',
      firstEditableMs: 'EDITABLE_1',
      secondEditableMs: 'EDITABLE_2'
    }
  })
  assert.equal(collected.series.startupMs.length, 2)
  assert.equal(collected.series.firstEditableMs.length, 2, 'the editable event is its own sample')
  assert.equal(collected.series.secondEditableMs.length, 2)
  assert.ok(collected.series.firstEditableMs[0] >= collected.series.startupMs[0])
  assert.ok(collected.series.secondEditableMs[0] >= collected.series.firstEditableMs[0])
})

test('C02 (15): a probe that never prints a marker reports it missing instead of inventing it', async (t) => {
  // A real probe file avoids shell-quoting differences between hosts.
  const os = require('node:os')
  const fsPromises = require('node:fs')
  const directory = fsPromises.mkdtempSync(path.join(os.tmpdir(), 'highlighter-perf-probe-'))
  const probeFile = path.join(directory, 'probe.js')
  fsPromises.writeFileSync(probeFile, 'process.stdout.write("READY")\n')
  t.after(() => fsPromises.rmSync(directory, { recursive: true, force: true }))
  const collected = await collectSeries({
    probe: JSON.stringify(process.execPath) + ' ' + JSON.stringify(probeFile),
    runs: 1,
    timeoutMs: 20000,
    markers: { startupMs: 'READY', firstEditableMs: 'EDITABLE_1' }
  })
  assert.equal(collected.series.startupMs.length, 1)
  assert.equal(collected.series.firstEditableMs.length, 0)
  assert.equal(typeof collected.missing.firstEditableMs, 'string')
  assert.ok(collected.missing.firstEditableMs.length > 0)
})

test('C02 (15): a probe timeout is reported per run and the child is reaped', async (t) => {
  // A probe that prints the startup marker and then hangs without the second one.
  const script = 'console.log(999); setTimeout(() => {}, 60000)'
  const probe = JSON.stringify(process.execPath) + ' -e ' + JSON.stringify(script)
  const result = await runOnce({ probe, timeoutMs: 4000, markers: { startupMs: '999', firstEditableMs: 'EDITABLE_1' } })
  assert.equal(result.reason, 'timeout')
  assert.equal(typeof result.seen.startupMs, 'number')
  assert.equal(result.seen.firstEditableMs, undefined)
})
