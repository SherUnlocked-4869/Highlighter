const test = require('node:test')
const assert = require('node:assert/strict')
const {
  PerformanceMonitor,
  summarizeAppMetrics
} = require('../main/services/performance-monitor')

test('records deterministic durations without exposing operation values', () => {
  const entries = []
  const times = [10, 25]
  const monitor = new PerformanceMonitor({
    logger: { event: (event, details) => entries.push({ event, details }) },
    now: () => times.shift()
  })

  const token = monitor.begin('capture.interactive', { mode: 'region' })
  const entry = monitor.finish(token, { width: 3840, height: 2160 })

  assert.deepEqual(entry, {
    name: 'capture.interactive',
    durationMs: 15,
    mode: 'region',
    width: 3840,
    height: 2160
  })
  assert.deepEqual(entries, [{ event: 'performance', details: entry }])
})

test('measure preserves synchronous and asynchronous results and records failures', async () => {
  const entries = []
  let current = 0
  const monitor = new PerformanceMonitor({
    logger: { event: (_event, details) => entries.push(details) },
    now: () => current += 5
  })

  assert.equal(monitor.measure('sync', () => 42), 42)
  assert.equal(await monitor.measure('async', async () => 'ok'), 'ok')
  await assert.rejects(
    monitor.measure('failure', async () => { throw new RangeError('no') }),
    RangeError
  )

  assert.deepEqual(entries.map((entry) => ({ name: entry.name, outcome: entry.outcome })), [
    { name: 'sync', outcome: 'success' },
    { name: 'async', outcome: 'success' },
    { name: 'failure', outcome: 'error' }
  ])
  assert.equal(entries[2].errorName, 'RangeError')
})

test('summarizes Electron process metrics in MiB by process type', () => {
  const summary = summarizeAppMetrics([
    {
      type: 'Browser',
      memory: { workingSetSize: 102400, peakWorkingSetSize: 122880, privateBytes: 81920 },
      cpu: { percentCPUUsage: 1.25 }
    },
    {
      type: 'Tab',
      memory: { workingSetSize: 51200, peakWorkingSetSize: 61440, privateBytes: 40960 },
      cpu: { percentCPUUsage: 0.75 }
    }
  ])

  assert.equal(summary.processCount, 2)
  assert.equal(summary.workingSetMiB, 150)
  assert.equal(summary.peakWorkingSetMiB, 180)
  assert.equal(summary.privateMiB, 120)
  assert.equal(summary.cpuPercent, 2)
  assert.deepEqual(summary.byType.Browser, {
    processCount: 1,
    workingSetMiB: 100,
    privateMiB: 80,
    cpuPercent: 1.25
  })
})
