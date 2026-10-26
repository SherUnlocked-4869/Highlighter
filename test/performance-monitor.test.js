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

test('snapshot keeps per-process detail and joins registry windows by pid', () => {
  const metrics = [
    {
      pid: 100,
      type: 'Browser',
      name: 'Electron',
      creationTime: 1700000000,
      memory: { workingSetSize: 102400, privateBytes: 81920 },
      cpu: { percentCPUUsage: 1.25 }
    },
    {
      pid: 200,
      type: 'Utility',
      serviceName: 'highlighter-usage-scan',
      creationTime: 1700000001,
      memory: { workingSetSize: 20480, privateBytes: 4096 },
      cpu: { percentCPUUsage: 0.5 }
    }
  ]
  const windows = [{ role: 'main', feature: null, pid: 100, visible: true, workingSetMiB: 100 }]
  const monitor = new PerformanceMonitor({
    getAppMetrics: () => metrics,
    getWindowRegistry: () => ({ snapshot: () => ({ generatedAt: 7, windowCount: 1, windows }) })
  })

  const entry = monitor.snapshot('memory-probe', { scenario: 'idle' })
  assert.equal(entry.label, 'memory-probe')
  assert.equal(entry.scenario, 'idle')
  // Existing aggregate fields stay intact for compatibility.
  assert.equal(entry.processCount, 2)
  assert.equal(entry.byType.Browser.processCount, 1)
  // New per-process detail keeps what the type buckets used to discard.
  assert.equal(entry.processes.length, 2)
  assert.equal(entry.processes[0].pid, 100)
  assert.equal(entry.processes[0].name, 'Electron')
  assert.equal(entry.processes[0].workingSetMiB, 100)
  assert.equal(entry.processes[1].serviceName, 'highlighter-usage-scan')
  // Windows carry the role → pid attribution getAppMetrics cannot provide.
  assert.deepEqual(entry.windows, windows)
})

test('snapshot degrades to empty windows when the registry is unavailable', () => {
  const failing = new PerformanceMonitor({
    getAppMetrics: () => [],
    getWindowRegistry: () => { throw new Error('no registry') }
  })
  const entry = failing.snapshot('empty')
  assert.deepEqual(entry.windows, [])
  assert.deepEqual(entry.processes, [])

  const missing = new PerformanceMonitor({ getAppMetrics: () => [], getWindowRegistry: () => null })
  assert.deepEqual(missing.snapshot('none').windows, [])
  assert.equal(missing.snapshot('none').processCount, 0)
})
