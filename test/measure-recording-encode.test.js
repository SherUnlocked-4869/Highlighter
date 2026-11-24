'use strict'

// C05 measurement helper (scripts/measure-recording-encode.js): argument parsing, the
// snapshot formats the app can produce, and the pairwise acceptance arithmetic
// (CPU >= 15% lower, dropped frames < 1%, A/V drift <= 100 ms). Nothing here starts a
// recording or a process.

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const {
  ACCEPTANCE,
  SAMPLE_CELLS,
  USAGE,
  buildReport,
  calculateAvDriftMs,
  calculateDroppedFramePercent,
  coerceReport,
  collectLiveSnapshots,
  compareReports,
  defaultOutPath,
  formatComparison,
  formatSummary,
  main,
  normalizeRecordingInfo,
  parseArgs,
  parseLogEntries,
  parseSnapshot,
  selectSnapshotEntry,
  summarizeLiveSamples,
  summarizeSnapshot,
  withinDriftBudget
} = require('../scripts/measure-recording-encode')

const MIB = 1024 * 1024

const browserMetric = {
  pid: 10,
  type: 'Browser',
  cpu: { percentCPUUsage: 12.5 },
  memory: { workingSetSize: 512 * MIB, privateBytes: 400 * MIB }
}
const gpuMetric = {
  pid: 11,
  type: 'GPU',
  cpu: { percentCPUUsage: 30 },
  memory: { workingSetSize: 256 * MIB, privateBytes: 200 * MIB }
}
const tabMetric = {
  pid: 12,
  type: 'Tab',
  cpu: { percentCPUUsage: 40 },
  memory: { workingSetSize: 300 * MIB, privateBytes: 250 * MIB }
}

function reportWith(cpuPercent, recording = {}) {
  return buildReport({
    label: 'sample',
    source: 'input',
    snapshot: [{ ...browserMetric, cpu: { percentCPUUsage: cpuPercent } }],
    recording: {
      droppedFrames: 3,
      totalFrames: 1800,
      avDriftMs: 40,
      qualityAcceptable: true,
      exportMs: 41_000,
      ...recording
    }
  })
}

test('parseArgs keeps the documented defaults', () => {
  const options = parseArgs([])
  assert.equal(options.snapshotLabel, 'record-compositor')
  assert.equal(options.samples, 5)
  assert.equal(options.interval, 2000)
  assert.equal(options.label, 'sample')
  assert.equal(options.live, false)
  assert.equal(options.noOut, false)
  assert.equal(options.json, false)
  assert.equal(options.compare, null)
  assert.equal(options.help, false)
})

test('parseArgs accepts every documented flag and resolves file paths', () => {
  const options = parseArgs([
    '--input', 'snapshot.json',
    '--recording', 'recording.json',
    '--label', 'igpu-1080p30-direct',
    '--out', 'report.json',
    '--json'
  ])
  assert.equal(path.isAbsolute(options.input), true)
  assert.equal(path.isAbsolute(options.recording), true)
  assert.equal(path.isAbsolute(options.out), true)
  assert.equal(options.label, 'igpu-1080p30-direct')
  assert.equal(options.json, true)

  const live = parseArgs(['--live', '--root-pid', '4321', '--samples', '3', '--interval', '500'])
  assert.equal(live.live, true)
  assert.equal(live.rootPid, 4321)
  assert.equal(live.samples, 3)
  assert.equal(live.interval, 500)

  const compare = parseArgs(['--compare', 'baseline.json', 'candidate.json'])
  assert.equal(compare.compare.length, 2)
  assert.ok(compare.compare[0].endsWith('baseline.json'))
  assert.ok(compare.compare[1].endsWith('candidate.json'))

  assert.equal(parseArgs(['--snapshot-label', 'other']).snapshotLabel, 'other')
  assert.equal(parseArgs(['--no-out']).noOut, true)
})

test('parseArgs rejects unknown or malformed arguments', () => {
  assert.throws(() => parseArgs(['--nope']), /未知参数/)
  assert.throws(() => parseArgs(['--input']), /缺少参数值/)
  assert.throws(() => parseArgs(['--root-pid', '0']), /正整数/)
  assert.throws(() => parseArgs(['--samples', '0']), /正整数/)
  assert.throws(() => parseArgs(['--interval', '-5']), /非负整数/)
  assert.throws(() => parseArgs(['--label', '   ']), /不能为空/)
  assert.throws(() => parseArgs(['--compare', 'only-one.json']), /两个参数/)
  assert.throws(() => parseArgs(['--compare', 'a.json', '--json']), /两个参数/)
})

test('the log reader tolerates noise and selects the newest labelled snapshot', () => {
  const first = {
    timestamp: '2026-11-25T00:00:00.000Z',
    event: 'performance-snapshot',
    details: { label: 'record-compositor', processes: [browserMetric] }
  }
  const unrelated = {
    timestamp: '2026-11-25T00:00:02.000Z',
    event: 'performance-snapshot',
    details: { label: 'startup', processes: [gpuMetric] }
  }
  const newest = {
    timestamp: '2026-11-25T00:00:09.000Z',
    event: 'performance-snapshot',
    details: { label: 'record-compositor', processes: [tabMetric] }
  }
  const logText = [
    JSON.stringify(first),
    'plain text line',
    '{broken json',
    JSON.stringify(unrelated),
    JSON.stringify(newest),
    ''
  ].join('\n')
  const entries = parseLogEntries(logText)
  assert.equal(entries.length, 3)
  const selected = selectSnapshotEntry(entries)
  assert.equal(selected.capturedAt, '2026-11-25T00:00:09.000Z')
  assert.equal(selected.processes[0].pid, 12)
  assert.equal(selectSnapshotEntry(entries, 'startup').capturedAt, '2026-11-25T00:00:02.000Z')
  assert.equal(selectSnapshotEntry(entries, 'missing'), null)
  assert.equal(selectSnapshotEntry([], 'anything'), null)
  assert.deepEqual(parseLogEntries(''), [])
})

test('parseSnapshot understands every snapshot the app can hand over', () => {
  const fromMetricsArray = parseSnapshot([browserMetric, gpuMetric])
  assert.equal(fromMetricsArray.processes.length, 2)
  assert.equal(fromMetricsArray.processes[0].workingSetMiB, 512)
  assert.equal(fromMetricsArray.processes[0].privateMiB, 400)
  assert.equal(fromMetricsArray.processes[0].cpuPercent, 12.5)

  const fromLogEntry = parseSnapshot({
    timestamp: '2026-11-25T00:00:00.000Z',
    event: 'performance-snapshot',
    details: { label: 'record-compositor', processes: [browserMetric] }
  })
  assert.equal(fromLogEntry.label, 'record-compositor')
  assert.equal(fromLogEntry.capturedAt, '2026-11-25T00:00:00.000Z')

  const fromMemorySnapshot = parseSnapshot({
    label: 'mem',
    generatedAt: '2026-11-25T01:00:00.000Z',
    summary: {
      sampleCount: 3,
      perRole: {
        chromium: { count: 4, workingSetMiB: 700.5, privateMiB: 512.25, cpu: 3 }
      },
      total: { processCount: 4, workingSetMiB: 700.5, privateMiB: 512.25, cpu: 3 }
    },
    samples: []
  })
  assert.equal(fromMemorySnapshot.sampleCount, 3)
  assert.equal(fromMemorySnapshot.processes[0].type, 'chromium')
  assert.equal(fromMemorySnapshot.cpuSeconds, 3)

  assert.equal(parseSnapshot({}), null)
  assert.equal(parseSnapshot(null), null)
  assert.equal(parseSnapshot('text'), null)
  assert.equal(parseSnapshot({ processes: [] }), null)
})

test('the summary splits CPU, memory, VRAM and the GPU process bucket', () => {
  const snapshot = parseSnapshot([
    browserMetric,
    { ...gpuMetric, gpuDedicatedMiB: 128, gpuSharedMiB: 64 },
    tabMetric
  ])
  const summary = summarizeSnapshot(snapshot)
  assert.equal(summary.processCount, 3)
  assert.equal(summary.cpuPercent, 82.5)
  assert.equal(summary.cpuAvailable, true)
  assert.equal(summary.workingSetMiB, (512 + 256 + 300))
  assert.equal(summary.privateMiB, (400 + 200 + 250))
  assert.equal(summary.vram.dedicatedMiB, 128)
  assert.equal(summary.vram.sharedMiB, 64)
  assert.equal(summary.gpu.processCount, 1)
  assert.equal(summary.gpu.cpuPercent, 30)
  assert.equal(summary.byType.Tab.processCount, 1)
  // A memory-snapshot summary has no CPU percentage: report it as unavailable.
  const memoryOnly = summarizeSnapshot(parseSnapshot({
    summary: { sampleCount: 1, perRole: { chromium: { workingSetMiB: 10, privateMiB: 5 } }, total: {} }
  }))
  assert.equal(memoryOnly.cpuAvailable, false)
  assert.equal(memoryOnly.cpuPercent, 0)
})

test('A/V drift is absolute and passes only up to 100 ms', () => {
  assert.equal(calculateAvDriftMs(1000, 1040), 40)
  assert.equal(calculateAvDriftMs(1040, 1000), 40)
  assert.equal(calculateAvDriftMs(1000, 900), 100)
  assert.equal(calculateAvDriftMs(undefined, 900), null)
  assert.equal(calculateAvDriftMs('x', 900), null)
  assert.equal(withinDriftBudget(0), true)
  assert.equal(withinDriftBudget(100), true)
  assert.equal(withinDriftBudget(100.1), false)
  assert.equal(withinDriftBudget(50, 40), false)
  assert.equal(withinDriftBudget(null), false)
  assert.equal(ACCEPTANCE.maxAvDriftMs, 100)
})

test('dropped-frame percentage is bounded and derived from frame counts', () => {
  assert.equal(calculateDroppedFramePercent(0, 1800), 0)
  assert.equal(calculateDroppedFramePercent(3, 1800), 0.167)
  assert.equal(calculateDroppedFramePercent(18, 1800), 1)
  assert.equal(calculateDroppedFramePercent(undefined, 1800), null)
  assert.equal(calculateDroppedFramePercent(3, 0), null)
  assert.equal(calculateDroppedFramePercent(-1, 100), null)
  assert.equal(ACCEPTANCE.maxDroppedFramePercent, 1)
})

test('recording info derives drift/dropped percent but honours explicit values', () => {
  const derived = normalizeRecordingInfo({
    droppedFrames: 3,
    totalFrames: 1800,
    videoStartMs: 500,
    audioStartMs: 540,
    directTrack: true,
    qualityAcceptable: true
  })
  assert.equal(derived.avDriftMs, 40)
  assert.equal(derived.droppedFramePercent, 0.167)
  assert.equal(derived.directTrack, true)
  assert.equal(derived.qualityAcceptable, true)

  const explicit = normalizeRecordingInfo({
    avDriftMs: 80,
    videoStartMs: 0,
    audioStartMs: 300,
    droppedFramePercent: 0.5,
    droppedFrames: 9,
    totalFrames: 1800
  })
  assert.equal(explicit.avDriftMs, 80)
  assert.equal(explicit.droppedFramePercent, 0.5)

  const empty = normalizeRecordingInfo(null)
  assert.equal(empty.avDriftMs, null)
  assert.equal(empty.droppedFramePercent, null)
  assert.equal(empty.qualityAcceptable, null)
  assert.equal(empty.directTrack, null)
})

test('buildReport stamps the acceptance thresholds and normalises the recording', () => {
  const report = buildReport({
    label: 'igpu-1080p30-direct',
    source: 'input',
    capturedAt: '2026-11-25T02:00:00.000Z',
    snapshot: parseSnapshot([browserMetric, gpuMetric]),
    recording: { videoStartMs: 1000, audioStartMs: 1040, droppedFrames: 3, totalFrames: 1800 }
  })
  assert.equal(report.label, 'igpu-1080p30-direct')
  assert.equal(report.source, 'input')
  assert.equal(report.capturedAt, '2026-11-25T02:00:00.000Z')
  assert.equal(report.platform, process.platform)
  assert.deepEqual(report.thresholds, { ...ACCEPTANCE })
  assert.equal(report.snapshot.processCount, 2)
  assert.equal(report.recording.avDriftMs, 40)
  assert.equal(report.recording.droppedFramePercent, 0.167)
})

test('the comparison expands only when CPU, frames, drift and quality all pass', () => {
  const baseline = reportWith(100, { exportMs: 50_000 })
  const candidate = reportWith(84, { droppedFrames: 3, avDriftMs: 40, exportMs: 41_000 })
  const comparison = compareReports(baseline, candidate)
  assert.equal(comparison.cpu.dropPercent, 16)
  assert.equal(comparison.checks.cpu, true)
  assert.equal(comparison.checks.droppedFrames, true)
  assert.equal(comparison.checks.avDrift, true)
  assert.equal(comparison.checks.quality, true)
  assert.deepEqual(comparison.missing, [])
  assert.equal(comparison.expand, true)
  assert.equal(comparison.exportMs.delta, -9000)
  // Exactly 15% is inside the threshold; 14.9% is not.
  assert.equal(compareReports(baseline, reportWith(85)).checks.cpu, true)
  assert.equal(compareReports(baseline, reportWith(85.1)).checks.cpu, false)
  // Dropped frames must stay strictly below 1%.
  assert.equal(compareReports(baseline, reportWith(84, { droppedFrames: 18 })).checks.droppedFrames, false)
  // Drift is inclusive at 100 ms.
  assert.equal(compareReports(baseline, reportWith(84, { avDriftMs: 100 })).checks.avDrift, true)
  assert.equal(compareReports(baseline, reportWith(84, { avDriftMs: 101 })).checks.avDrift, false)
  // Quality must be explicitly declared acceptable.
  assert.equal(compareReports(baseline, reportWith(84, { qualityAcceptable: false })).checks.quality, false)
})

test('the comparison names the data it is missing instead of guessing', () => {
  const baseline = reportWith(100)
  const candidate = buildReport({
    label: 'missing',
    snapshot: parseSnapshot([browserMetric]),
    recording: {}
  })
  const comparison = compareReports(baseline, candidate)
  assert.equal(comparison.expand, false)
  assert.deepEqual(comparison.missing.sort(), ['avDriftMs', 'droppedFramePercent', 'qualityAcceptable'])
  assert.equal(comparison.checks.cpu, true)

  const noBaselineCpu = compareReports(
    buildReport({ label: 'zero', snapshot: parseSnapshot([{ ...browserMetric, cpu: { percentCPUUsage: 0 } }]) }),
    reportWith(10)
  )
  assert.equal(noBaselineCpu.cpu.dropPercent, null)
  assert.equal(noBaselineCpu.missing.includes('cpuPercent'), true)
  assert.equal(noBaselineCpu.expand, false)
})

test('the printed summary carries the metrics and the thresholds', () => {
  const report = buildReport({
    label: 'igpu-1080p30-direct',
    source: 'input',
    snapshot: parseSnapshot([browserMetric, { ...gpuMetric, gpuDedicatedMiB: 128 }]),
    recording: {
      directTrack: true,
      droppedFrames: 3,
      totalFrames: 1800,
      videoStartMs: 1000,
      audioStartMs: 1040,
      exportMs: 41_000,
      qualityAcceptable: true
    }
  })
  const summary = formatSummary(report)
  assert.match(summary, /## 录制编码样本：igpu-1080p30-direct/)
  assert.match(summary, /CPU：/)
  assert.match(summary, /GPU Video Encode/)
  assert.match(summary, /掉帧：3\/1800 = 0\.167%/)
  assert.match(summary, /音画差：40\.0 ms/)
  assert.match(summary, /导出耗时：41\.0 s/)
  assert.match(summary, /直录源视频轨/)
  assert.match(summary, /画质：人工比对可接受/)

  const comparison = formatComparison(compareReports(reportWith(100), reportWith(84)))
  assert.match(comparison, /## 成对比较：/)
  assert.match(comparison, /下降 >= 15%/)
  assert.match(comparison, /\| CPU \|/)
  assert.match(comparison, /满足 C05 扩展门槛/)
  assert.match(comparison, /判定：CPU 达标/)

  const failing = formatComparison(compareReports(reportWith(100), reportWith(100)))
  assert.match(failing, /不满足扩展门槛/)
})

test('the help text documents the four GPU cells and the acceptance thresholds', () => {
  assert.match(USAGE, /HIGHLIGHTER_RECORD_DIRECT_TRACK=1/)
  assert.match(USAGE, /核显/)
  assert.match(USAGE, /独显/)
  assert.match(USAGE, /1080p30/)
  assert.match(USAGE, /4K30/)
  assert.match(USAGE, /15%/)
  assert.match(USAGE, /< 1%/)
  assert.match(USAGE, /100 ms/)
  assert.match(USAGE, /qualityAcceptable/)
  assert.equal(SAMPLE_CELLS.length, 4)
  assert.deepEqual(
    SAMPLE_CELLS.map((cell) => cell.id).sort(),
    ['dgpu-1080p30', 'dgpu-4k30', 'igpu-1080p30', 'igpu-4k30']
  )
  assert.deepEqual(SAMPLE_CELLS.map((cell) => cell.gpu).sort(), ['discrete', 'discrete', 'integrated', 'integrated'])
})

test('--help prints the usage and exits 0; bad input exits 1', () => {
  const printed = []
  assert.equal(main(['--help'], { stdout: (line) => printed.push(line), stderr: () => {} }), 0)
  assert.match(printed.join('\n'), /Usage: node scripts\/measure-recording-encode\.js/)

  const errors = []
  assert.equal(main(['--nope'], { stdout: () => {}, stderr: (line) => errors.push(line) }), 1)
  assert.match(errors.join('\n'), /未知参数/)

  const noSource = []
  assert.equal(main([], { stdout: () => {}, stderr: (line) => noSource.push(line) }), 1)
  assert.match(noSource.join('\n'), /需要 --input/)
})

test('live sampling converts cumulative CPU seconds into a percentage', () => {
  const sample = (timestampMs, cpuSeconds, workingSetMiB, privateMiB) => ({
    timestamp: new Date(timestampMs).toISOString(),
    timestampMs,
    processes: [{
      pid: 7,
      role: 'chromium',
      processType: 'gpu-process',
      name: 'electron.exe',
      cpuSeconds,
      workingSetMiB,
      privateMiB
    }]
  })
  const live = summarizeLiveSamples([
    sample(0, 10, 100, 80),
    sample(2000, 11.5, 110, 88)
  ])
  assert.equal(live.sampleCount, 2)
  assert.equal(live.durationMs, 2000)
  assert.equal(live.processes[0].cpuPercent, 75)
  assert.equal(live.processes[0].type, 'gpu-process')
  assert.equal(live.processes[0].workingSetMiB, 105)
  assert.equal(live.processes[0].privateMiB, 84)
  assert.equal(summarizeLiveSamples([]), null)
  assert.equal(summarizeLiveSamples(null), null)

  const clock = { value: 0 }
  const snapshots = collectLiveSnapshots(
    { rootPid: 7, samples: 2, interval: 5 },
    {
      collect: () => [{ pid: 7, cpuSeconds: 1, workingSetMiB: 1, privateMiB: 1 }],
      now: () => {
        clock.value += 10
        return clock.value
      },
      sleep: () => {}
    }
  )
  assert.equal(snapshots.length, 2)
  assert.equal(snapshots[0].timestampMs, 10)
  assert.equal(snapshots[1].timestampMs, 20)
  assert.throws(() => collectLiveSnapshots({ samples: 1 }), /--root-pid/)
})

test('--compare input can be a raw metrics array, a snapshot or a finished report', () => {
  const report = reportWith(100)
  assert.equal(coerceReport(report), report)
  const fromArray = coerceReport([browserMetric], 'raw')
  assert.equal(fromArray.snapshot.processCount, 1)
  assert.equal(fromArray.label, 'raw')
  const fromSnapshot = coerceReport({ label: 'snap', processes: [browserMetric] }, 'ignored')
  assert.equal(fromSnapshot.label, 'snap')
  assert.equal(coerceReport({}), null)
  assert.equal(coerceReport(null), null)
})

test('the default output path stays inside the gitignored scratch directory', () => {
  const outPath = defaultOutPath('igpu 1080p30/direct', new Date('2026-11-25T00:00:00.000Z'))
  assert.ok(outPath.endsWith('.json'))
  assert.ok(outPath.includes('.tmp-perf'))
  assert.ok(outPath.includes('igpu 1080p30_direct'))
  assert.equal(outPath.includes('..'), false)
})
