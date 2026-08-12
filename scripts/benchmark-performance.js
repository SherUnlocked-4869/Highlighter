const { execFileSync, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { performance } = require('node:perf_hooks')
const { HistoryService } = require('../main/services/history-service')
const matcher = require('../long-capture/matcher')
const { createFramePacer } = require('../record/recording-utils')

const RESULT_PREFIX = 'HIGHLIGHTER_PERFORMANCE_BASELINE='

function percentile(values, ratio) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right)
  if (!sorted.length) return 0
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1))
  return sorted[index]
}

function summarizeSamples(values) {
  const samples = values.map((value) => Math.round(value * 100) / 100)
  if (!samples.length) {
    return { runs: 0, minMs: 0, medianMs: 0, p95Ms: 0, maxMs: 0, samplesMs: [] }
  }
  return {
    runs: samples.length,
    minMs: Math.min(...samples),
    medianMs: Math.round(percentile(samples, 0.5) * 100) / 100,
    p95Ms: Math.round(percentile(samples, 0.95) * 100) / 100,
    maxMs: Math.max(...samples),
    samplesMs: samples
  }
}

function createRandomBytes(length, seed = 0x12345678) {
  let state = seed >>> 0
  const output = new Uint8Array(length)
  for (let index = 0; index < output.length; index++) {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0
    output[index] = state >>> 24
  }
  return output
}

function createShiftedFrame(previous, width, height, axis, shift) {
  const current = createRandomBytes(previous.length, 0x87654321)
  if (axis === 'vertical') {
    for (let y = 0; y < height - shift; y++) {
      const source = (y + shift) * width
      current.set(previous.subarray(source, source + width), y * width)
    }
  } else {
    for (let y = 0; y < height; y++) {
      const row = y * width
      current.set(previous.subarray(row + shift, row + width), row)
    }
  }
  return current
}

function benchmarkMatcher({ width, height, axis, shift, runs = 5 }) {
  const previous = createRandomBytes(width * height)
  const current = createShiftedFrame(previous, width, height, axis, shift)
  const durations = []
  let lastResult = null
  for (let run = 0; run < runs; run++) {
    const startedAt = performance.now()
    lastResult = matcher.findBestShift(previous, current, width, height, axis)
    durations.push(performance.now() - startedAt)
  }
  return {
    width,
    height,
    axis,
    expectedShift: shift,
    detectedShift: lastResult?.shift || 0,
    status: lastResult?.status || 'unknown',
    ...summarizeSamples(durations)
  }
}

function benchmarkRecordingPacing({ displayFrameRate, targetFrameRate, durationSeconds = 60 }) {
  const pacer = createFramePacer(targetFrameRate)
  const callbackCount = Math.round(displayFrameRate * durationSeconds)
  for (let frame = 0; frame < callbackCount; frame++) {
    pacer.shouldDraw(frame * 1000 / displayFrameRate)
  }
  const stats = pacer.snapshot()
  return {
    displayFrameRate,
    targetFrameRate: stats.frameRate,
    durationSeconds,
    previousFullFrameDraws: callbackCount,
    pacedFullFrameDraws: stats.renderedFrames,
    skippedCallbacks: stats.skippedCallbacks,
    drawReductionPercent: Math.round((1 - stats.renderedFrames / callbackCount) * 10000) / 100
  }
}

function createHistoryFixture(root, count = 200) {
  const files = []
  const history = []
  fs.mkdirSync(root, { recursive: true })
  for (let index = 0; index < count; index++) {
    const id = `history-${String(index).padStart(4, '0')}`
    const filePath = path.join(root, `Highlighter_2026-08-12_${String(index).padStart(6, '0')}.png`)
    fs.writeFileSync(filePath, Buffer.alloc(1024, index % 255))
    files.push(filePath)
    history.push({
      id,
      filePath,
      createdAt: Date.now() - index * 1000,
      source: index % 5 === 0 ? 'long-capture' : 'capture',
      action: 'copy',
      width: 1920,
      height: 1080
    })
  }
  return { files, history }
}

function benchmarkHistory(runs = 10) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'highlighter-history-benchmark-'))
  try {
    const fixture = createHistoryFixture(root)
    const store = {
      get: (key, fallback) => key === 'captureHistory' ? fixture.history : fallback,
      set: () => {}
    }
    const service = new HistoryService({
      store,
      nativeImage: {},
      sharp: () => {},
      getSettings: () => ({ screenshot: { historyDirectory: root, historyEnabled: true, historyLimit: 200 } }),
      assertWritable: () => {},
      defaultHistoryDirectory: root,
      makeCaptureName: () => 'unused.png'
    })
    const listDurations = []
    const statsDurations = []
    for (let run = 0; run < runs; run++) {
      let startedAt = performance.now()
      service.list({ limit: 40 })
      service.listSources()
      listDurations.push(performance.now() - startedAt)
      startedAt = performance.now()
      service.stats()
      statsDurations.push(performance.now() - startedAt)
    }
    return {
      entries: fixture.history.length,
      firstPageAndSources: summarizeSamples(listDurations),
      statsAndOrphanScan: summarizeSamples(statsDurations)
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

function benchmarkColdRequire(moduleName, runs = 5) {
  const durations = []
  for (let run = 0; run < runs; run++) {
    const script = `const {performance}=require('node:perf_hooks');const t=performance.now();require(${JSON.stringify(moduleName)});process.stdout.write(String(performance.now()-t))`
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf8',
      windowsHide: true
    })
    if (result.status !== 0) throw new Error(`Unable to load ${moduleName}: ${result.stderr || result.stdout}`)
    durations.push(Number(result.stdout))
  }
  return summarizeSamples(durations)
}

function collectRunningAppSnapshot() {
  if (process.platform !== 'win32') return null
  const command = [
    "$items = Get-Process -Name 'Highlighter','HighlighterOcrSidecar' -ErrorAction SilentlyContinue",
    "$items | Select-Object ProcessName,Id,WorkingSet64,PrivateMemorySize64,CPU | ConvertTo-Json -Compress"
  ].join('; ')
  try {
    const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8',
      windowsHide: true
    }).trim()
    const items = output ? JSON.parse(output) : []
    const processes = Array.isArray(items) ? items : [items]
    const totals = processes.reduce((summary, item) => {
      summary.workingSetMiB += Number(item.WorkingSet64) / 1024 / 1024
      summary.privateMiB += Number(item.PrivateMemorySize64) / 1024 / 1024
      return summary
    }, { workingSetMiB: 0, privateMiB: 0 })
    return {
      advisoryOnly: true,
      processCount: processes.length,
      workingSetMiB: Math.round(totals.workingSetMiB * 10) / 10,
      privateMiB: Math.round(totals.privateMiB * 10) / 10,
      processes: processes.map((item) => ({
        name: item.ProcessName,
        pid: item.Id,
        workingSetMiB: Math.round(Number(item.WorkingSet64) / 1024 / 1024 * 10) / 10,
        privateMiB: Math.round(Number(item.PrivateMemorySize64) / 1024 / 1024 * 10) / 10,
        cpuSeconds: Number(item.CPU) || 0
      }))
    }
  } catch (error) {
    return { advisoryOnly: true, error: error.message || String(error) }
  }
}

function collectArtifactSnapshot(projectRoot) {
  const unpacked = path.join(projectRoot, 'dist', 'win-unpacked')
  if (!fs.existsSync(unpacked)) return null
  const totals = { bytes: 0, localesBytes: 0, localeCount: 0 }
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(target)
      else if (entry.isFile()) {
        const size = fs.statSync(target).size
        totals.bytes += size
        if (path.dirname(target) === path.join(unpacked, 'locales')) {
          totals.localesBytes += size
          totals.localeCount++
        }
      }
    }
  }
  visit(unpacked)
  return {
    unpackedMiB: Math.round(totals.bytes / 1024 / 1024 * 100) / 100,
    localeCount: totals.localeCount,
    localesMiB: Math.round(totals.localesBytes / 1024 / 1024 * 100) / 100
  }
}

function parseArguments(args) {
  const outputIndex = args.indexOf('--output')
  return {
    outputPath: outputIndex >= 0 && args[outputIndex + 1] ? path.resolve(args[outputIndex + 1]) : '',
    includeRunningApp: args.includes('--include-running-app')
  }
}

function run() {
  const projectRoot = path.resolve(__dirname, '..')
  const options = parseArguments(process.argv.slice(2))
  const packageJson = require('../package.json')
  const result = {
    schemaVersion: 1,
    collectedAt: new Date().toISOString(),
    project: {
      version: packageJson.version,
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8', windowsHide: true }).trim()
    },
    system: {
      platform: process.platform,
      release: os.release(),
      arch: process.arch,
      cpuModel: os.cpus()[0]?.model || '',
      logicalCpuCount: os.cpus().length,
      totalMemoryMiB: Math.round(os.totalmem() / 1024 / 1024)
    },
    modules: Object.fromEntries(['sharp', 'electron-updater', 'screenshot-desktop'].map((name) => [name, benchmarkColdRequire(name)])),
    longCapture: {
      vertical4k: benchmarkMatcher({ width: 96, height: 2160, axis: 'vertical', shift: 360 }),
      horizontal4k: benchmarkMatcher({ width: 3840, height: 96, axis: 'horizontal', shift: 640 })
    },
    recording: {
      display60Target24: benchmarkRecordingPacing({ displayFrameRate: 60, targetFrameRate: 24 }),
      display144Target24: benchmarkRecordingPacing({ displayFrameRate: 144, targetFrameRate: 24 })
    },
    history: benchmarkHistory(),
    artifact: collectArtifactSnapshot(projectRoot),
    runningApp: options.includeRunningApp ? collectRunningAppSnapshot() : null
  }

  const serialized = `${JSON.stringify(result, null, 2)}\n`
  if (options.outputPath) {
    fs.mkdirSync(path.dirname(options.outputPath), { recursive: true })
    fs.writeFileSync(options.outputPath, serialized, 'utf8')
  }
  process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(result)}\n`)
  return result
}

if (require.main === module) run()

module.exports = {
  benchmarkMatcher,
  benchmarkRecordingPacing,
  createRandomBytes,
  createShiftedFrame,
  percentile,
  summarizeSamples
}
