'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { ProcessResourceSeries } = require('../scripts/lib/process-resource-series')
const { parseArguments, collect } = require('../scripts/benchmark-clipboard')

const row = (pid, parentPid, extra = {}) => ({
  pid, parentPid, createdAt: '2026-10-17T00:00:00.000Z', name: 'fixture.exe', role: 'native',
  available: true, cpuSeconds: 0, privateBytes: 1024, workingSetBytes: 2048, threadCount: 1, handleCount: 4, ...extra
})

test('resource series follows descendants without including an unrelated existing service', () => {
  const series = new ProcessResourceSeries({ rootPid: 10, logicalProcessors: 4 })
  const first = series.add([row(12, 11), row(10, 1), row(11, 10), row(99, 1)], 0)
  assert.equal(first.processCount, 3)
  assert.equal(first.privateBytes, 3072)
  assert.equal(first.cpuPercent, null)
  const second = series.add([row(10, 1, { cpuSeconds: 1 }), row(11, 10, { cpuSeconds: 1 }), row(12, 11)], 1000)
  assert.equal(second.cpuPercent, 50)
  const third = series.add([row(12, 1, { cpuSeconds: 2 }), row(10, 1), row(11, 10)], 2000)
  assert.equal(third.processCount, 3)
  assert.equal(third.cpuComplete, false) // reset counters cannot report negative CPU
})

test('PID reuse does not adopt the replacement or its descendants', () => {
  const series = new ProcessResourceSeries({ rootPid: 10, logicalProcessors: 4 })
  series.add([row(10, 1), row(11, 10)], 0)
  const next = series.add([row(10, 1), row(11, 1, { createdAt: '2026-10-17T00:01:00.000Z' }), row(12, 11)], 1000)
  assert.equal(next.processCount, 1)
  assert.equal(next.cpuPercent, null)
  assert.equal(series.report().events.at(-1).type, 'exited-or-unavailable')
})

test('missing metrics are null and cannot improve measured memory', () => {
  const series = new ProcessResourceSeries({ rootPid: 10, logicalProcessors: 4 })
  series.add([row(10, 1)], 0)
  const sample = series.add([row(10, 1, { available: false, privateBytes: null, cpuSeconds: null })], 1000)
  assert.equal(sample.privateBytes, null)
  assert.equal(sample.cpuPercent, null)
  assert.equal(series.report().summary.privateBytes.missing, 1)
})

test('root PID reuse ends a sample even while its original children remain', () => {
  const series = new ProcessResourceSeries({ rootPid: 10, logicalProcessors: 4 })
  series.add([row(10, 1), row(11, 10)], 0)
  const next = series.add([row(10, 1, { createdAt: '2026-10-17T00:01:00Z' }), row(11, 1)], 1000)
  assert.equal(next.rootAlive, false)
  assert.equal(next.processCount, 1)
})

test('collector validates arguments and never treats cumulative CPU as percent', async () => {
  assert.throws(() => parseArguments(['--root-pid', '1']), /output/)
  assert.throws(() => parseArguments(['--root-pid', '0', '--output', 'x']), /root-pid/)
  assert.throws(() => parseArguments(['--root-pid', '1', '--output', 'x', '--interval-ms', '0']), /Interval/)
  let now = 0
  const report = await collect({ rootPid: 10, durationSeconds: 1, intervalMs: 1000, logicalProcessors: 4 }, {
    now: () => now, wait: async (ms) => { now += ms },
    sampleInventory: async () => [row(10, 1, { cpuSeconds: 10 + now / 1000 })]
  })
  assert.equal(report.samples.length, 2)
  assert.equal(report.samples[1].cpuPercent, 25)
})
