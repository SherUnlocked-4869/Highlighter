#!/usr/bin/env node
'use strict'

// C05 build/measurement helper (docs/reviews/2026-11-24-windows-product-architecture-review.md).
//
// Summarises ONE recording session's app metrics and compares the composited take with
// the direct-track experiment. It NEVER starts a recording and never launches Electron:
// it either reads a saved snapshot, extracts the last performance snapshot from the
// application log, or samples an already-running process tree through
// scripts/memory-snapshot.js.
//
// Pure parsing/summary helpers are exported for test/measure-recording-encode.test.js;
// running this file directly only performs the CLI work described in the usage text.

const fs = require('node:fs')
const path = require('node:path')
const { collectProcesses } = require('./memory-snapshot')

const DEFAULT_SNAPSHOT_LABEL = 'record-compositor'
const DEFAULT_OUT_DIR = '.tmp-perf'
const DEFAULT_LABEL = 'sample'
const DEFAULT_SAMPLES = 5
const DEFAULT_INTERVAL_MS = 2000
const MIB = 1024 * 1024

// Acceptance thresholds (review §C05): expand only when the candidate keeps acceptable
// quality AND CPU/energy per minute drops by at least 15%, dropped frames stay below 1%
// and A/V drift stays at or below 100 ms.
const ACCEPTANCE = Object.freeze({
  minCpuDropPercent: 15,
  maxDroppedFramePercent: 1,
  maxAvDriftMs: 100
})

// The pairwise matrix the review asks for: integrated / discrete GPU x 1080p30 / 4K30.
// The script cannot choose a GPU; the labels only name the four cells a run must cover.
const SAMPLE_CELLS = Object.freeze([
  Object.freeze({ id: 'igpu-1080p30', gpu: 'integrated', resolution: '1080p30', width: 1920, height: 1080, frameRate: 30 }),
  Object.freeze({ id: 'igpu-4k30', gpu: 'integrated', resolution: '4K30', width: 3840, height: 2160, frameRate: 30 }),
  Object.freeze({ id: 'dgpu-1080p30', gpu: 'discrete', resolution: '1080p30', width: 1920, height: 1080, frameRate: 30 }),
  Object.freeze({ id: 'dgpu-4k30', gpu: 'discrete', resolution: '4K30', width: 3840, height: 2160, frameRate: 30 })
])

const USAGE = [
  'Usage: node scripts/measure-recording-encode.js [options]',
  '',
  'C05 编码实验度量（只读，不启动录制、不启动应用）：',
  '  --input <file>        读取 app metrics 快照 JSON（app.getAppMetrics() 数组、',
  '                        PerformanceMonitor.snapshot() 结果或 memory-snapshot 输出）',
  '  --log <file>          读取应用日志 JSONL（<userData>/logs/app.log），取最后一条',
  '                        event=performance-snapshot 的快照',
  '  --snapshot-label <s>  配合 --log 过滤快照 label（默认 record-compositor）',
  '  --live                采样正在运行的进程树（复用 scripts/memory-snapshot.js）',
  '  --root-pid <pid>      --live 必填：Highlighter 主进程 PID',
  '  --samples <n>         --live 采样次数（默认 5）',
  '  --interval <ms>       --live 采样间隔（默认 2000）',
  '  --recording <file>    录制状态描述 JSON（可选字段：droppedFrames/totalFrames/',
  '                        videoStartMs/audioStartMs/avDriftMs/exportMs/durationMs/',
  '                        qualityAcceptable/directTrack/resolution/gpu/mode）',
  '  --label <name>        报告标签，例如 igpu-1080p30-direct',
  '  --out <file>          结果 JSON 路径（默认 ${DEFAULT_OUT_DIR}/<label>-<时间>.json）',
  '  --no-out              只打印，不写 JSON 文件',
  '  --json                仅打印机器可读 JSON',
  '  --compare <a> <b>     成对比较：a=canvas 基线报告，b=直录候选报告',
  '  -h, --help            显示本帮助',
  '',
  '成对样本采集步骤（核显/独显 × 1080p30/4K30，共 4 个单元 × 2 条）：',
  '  1. 关闭无关应用，接通电源，固定电源计划/亮度/刷新率；记录显卡型号与驱动版本。',
  '  2. 四个单元：核显-1080p30、核显-4K30、独显-1080p30、独显-4K30；',
  '     分辨率由 Windows 显示设置决定，帧率固定 30（录制设置选 30 FPS）。',
  '  3. 每个单元录两条 60 秒、全屏、无标注、无裁剪/缩放的样本：',
  '       a) 基线：不设置任何环境变量（Canvas 合成 + MediaRecorder VP9）；',
  '       b) 候选：启动应用前设置 HIGHLIGHTER_RECORD_DIRECT_TRACK=1（源视频轨直录）。',
  '  4. 录制正在进行时另开终端采样（本脚本不会启动录制）：',
  '       node scripts/measure-recording-encode.js --live --root-pid <主进程PID>',
  '         --label igpu-1080p30-direct --out .tmp-perf/igpu-1080p30-direct.json',
  '     也可以从日志提取上一轮录制的合成器快照：',
  '       node scripts/measure-recording-encode.js --log <userData>/logs/app.log',
  '         --snapshot-label record-compositor --label igpu-1080p30-canvas',
  '  5. 录制结束后从编辑器导出 MP4，记录导出耗时；用同一文件量音画差，写进',
  '     --recording 描述（videoStartMs/audioStartMs 或 avDriftMs），并声明',
  '     qualityAcceptable=true/false（人工对比同码率画质）。',
  '  6. 每个单元做一次成对比较：',
  '       node scripts/measure-recording-encode.js --compare .tmp-perf/x-canvas.json',
  '         .tmp-perf/x-direct.json',
  '  7. 回归：窗口缩放、区域裁剪、GIF 导出各跑 1 条（不参与门槛，但不得新增失败）。',
  '',
  '验收门槛（同一单元同时满足才可扩展）：',
  '  * CPU（或每分钟能耗）相对基线下降 >= 15%；',
  '  * 掉帧率 < 1%（droppedFrames / totalFrames）；',
  '  * 音画差 <= 100 ms；',
  '  * 画质人工比对可接受（qualityAcceptable=true）。',
  '',
  'Read-only: reads JSON/JSONL files or samples existing processes; starts nothing.'
].join('\n')

function round(value, digits = 2) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  const factor = 10 ** digits
  return Math.round(number * factor) / factor
}

function toObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function nonNegativeOrNull(value) {
  const number = numberOrNull(value)
  return number === null || number < 0 ? null : number
}

function positiveOrNull(value) {
  const number = numberOrNull(value)
  return number === null || number <= 0 ? null : number
}

function text(value, fallback = '') {
  return typeof value === 'string' ? value.trim() || fallback : fallback
}

function sleepSync(milliseconds) {
  if (!(milliseconds > 0)) return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv = []) {
  const options = {
    input: null,
    log: null,
    snapshotLabel: DEFAULT_SNAPSHOT_LABEL,
    live: false,
    rootPid: null,
    samples: DEFAULT_SAMPLES,
    interval: DEFAULT_INTERVAL_MS,
    recording: null,
    label: DEFAULT_LABEL,
    out: null,
    noOut: false,
    json: false,
    compare: null,
    help: false
  }

  const readValue = (flag, inline, index) => {
    if (inline !== null) return { value: inline, next: index }
    const candidate = argv[index + 1]
    if (candidate === undefined || candidate.startsWith('--')) throw new Error(flag + ' 缺少参数值')
    return { value: candidate, next: index + 1 }
  }

  for (let index = 0; index < argv.length; index++) {
    const raw = String(argv[index])
    if (raw === '-h' || raw === '--help') {
      options.help = true
      continue
    }
    if (raw === '--live') {
      options.live = true
      continue
    }
    if (raw === '--no-out') {
      options.noOut = true
      continue
    }
    if (raw === '--json') {
      options.json = true
      continue
    }
    const equalsIndex = raw.indexOf('=')
    const flag = equalsIndex >= 0 ? raw.slice(0, equalsIndex) : raw
    const inline = equalsIndex >= 0 ? raw.slice(equalsIndex + 1) : null

    switch (flag) {
      case '--input': {
        const read = readValue(flag, inline, index)
        index = read.next
        options.input = path.resolve(read.value)
        break
      }
      case '--log': {
        const read = readValue(flag, inline, index)
        index = read.next
        options.log = path.resolve(read.value)
        break
      }
      case '--snapshot-label': {
        const read = readValue(flag, inline, index)
        index = read.next
        options.snapshotLabel = text(read.value, DEFAULT_SNAPSHOT_LABEL)
        break
      }
      case '--root-pid': {
        const read = readValue(flag, inline, index)
        index = read.next
        const pid = Number(read.value)
        if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('--root-pid 必须是正整数')
        options.rootPid = pid
        break
      }
      case '--samples': {
        const read = readValue(flag, inline, index)
        index = read.next
        const samples = Number(read.value)
        if (!Number.isSafeInteger(samples) || samples < 1) throw new Error('--samples 必须是正整数')
        options.samples = samples
        break
      }
      case '--interval': {
        const read = readValue(flag, inline, index)
        index = read.next
        const interval = Number(read.value)
        if (!Number.isSafeInteger(interval) || interval < 0) throw new Error('--interval 必须是非负整数（毫秒）')
        options.interval = interval
        break
      }
      case '--recording': {
        const read = readValue(flag, inline, index)
        index = read.next
        options.recording = path.resolve(read.value)
        break
      }
      case '--label': {
        const read = readValue(flag, inline, index)
        index = read.next
        if (!read.value.trim()) throw new Error('--label 不能为空')
        options.label = read.value.trim()
        break
      }
      case '--out': {
        const read = readValue(flag, inline, index)
        index = read.next
        options.out = path.resolve(read.value)
        break
      }
      case '--compare': {
        const first = readValue(flag, inline, index)
        index = first.next
        const second = argv[index + 1]
        if (second === undefined || second.startsWith('--')) throw new Error('--compare 需要两个参数：基线 候选')
        index += 1
        options.compare = [path.resolve(first.value), path.resolve(second)]
        break
      }
      default:
        throw new Error('未知参数：' + raw)
    }
  }

  return options
}

// ---------------------------------------------------------------------------
// Snapshot parsing (app.getAppMetrics, PerformanceMonitor.snapshot, memory-snapshot)
// ---------------------------------------------------------------------------

function normalizeProcessEntry(entry) {
  const source = toObject(entry)
  if (!source) return null
  const memory = toObject(source.memory) || {}
  const cpu = toObject(source.cpu) || {}
  const workingSetMiB = numberOrNull(source.workingSetMiB)
  const privateMiB = numberOrNull(source.privateMiB)
  const workingSetBytes = numberOrNull(source.workingSetSize !== undefined ? source.workingSetSize : memory.workingSetSize)
  const privateBytes = numberOrNull(source.privateBytes !== undefined ? source.privateBytes : memory.privateBytes)
  const processEntry = {
    pid: Number.isSafeInteger(Number(source.pid)) ? Number(source.pid) : null,
    type: text(source.type) || text(source.processType) || text(source.role) || 'Unknown',
    name: text(source.name),
    serviceName: text(source.serviceName),
    cpuPercent: round(numberOrNull(source.cpuPercent) ?? numberOrNull(cpu.percentCPUUsage) ?? 0, 2),
    workingSetMiB: workingSetMiB !== null
      ? round(workingSetMiB, 1)
      : round((workingSetBytes || 0) / MIB, 1),
    privateMiB: privateMiB !== null
      ? round(privateMiB, 1)
      : round((privateBytes || 0) / MIB, 1)
  }
  const dedicatedMiB = numberOrNull(source.gpuDedicatedMiB)
  const sharedMiB = numberOrNull(source.gpuSharedMiB)
  if (dedicatedMiB !== null) processEntry.gpuDedicatedMiB = round(dedicatedMiB, 1)
  if (sharedMiB !== null) processEntry.gpuSharedMiB = round(sharedMiB, 1)
  if (numberOrNull(source.cpuSeconds) !== null) processEntry.cpuSeconds = round(source.cpuSeconds, 2)
  return processEntry
}

function parseSnapshot(payload) {
  if (Array.isArray(payload)) {
    const processes = payload.map(normalizeProcessEntry).filter(Boolean)
    if (!processes.length) return null
    return { label: 'app-metrics', capturedAt: null, sampleCount: 1, processes }
  }
  const source = toObject(payload)
  if (!source) return null
  if (source.event === 'performance-snapshot' && toObject(source.details)) {
    return parseSnapshot({ ...source.details, capturedAt: source.timestamp || null })
  }
  if (Array.isArray(source.processes)) {
    const processes = source.processes.map(normalizeProcessEntry).filter(Boolean)
    if (!processes.length) return null
    return {
      label: text(source.label, 'snapshot'),
      capturedAt: text(source.capturedAt) || null,
      sampleCount: positiveOrNull(source.sampleCount) || 1,
      processes,
      ...(numberOrNull(source.cpuPercent) !== null ? { cpuPercent: round(source.cpuPercent, 2) } : {}),
      ...(numberOrNull(source.gpuVideoEncodePercent) !== null
        ? { gpuVideoEncodePercent: round(source.gpuVideoEncodePercent, 2) }
        : {}),
      ...(toObject(source.recording) ? { recording: source.recording } : {})
    }
  }
  const summary = toObject(source.summary)
  if (summary && toObject(summary.perRole)) {
    const processes = []
    for (const [role, entry] of Object.entries(summary.perRole)) {
      const value = toObject(entry) || {}
      processes.push({
        pid: null,
        type: role,
        name: role,
        serviceName: '',
        cpuPercent: 0,
        workingSetMiB: round(numberOrNull(value.workingSetMiB) || 0, 1),
        privateMiB: round(numberOrNull(value.privateMiB) || 0, 1)
      })
    }
    if (!processes.length) return null
    const total = toObject(summary.total) || {}
    return {
      label: text(source.label, 'memory-snapshot'),
      capturedAt: text(source.generatedAt) || null,
      sampleCount: positiveOrNull(summary.sampleCount) || 1,
      processes,
      ...(numberOrNull(total.cpu) !== null ? { cpuSeconds: round(total.cpu, 2) } : {})
    }
  }
  return null
}

function parseLogEntries(textValue) {
  const entries = []
  for (const line of String(textValue || '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed[0] !== '{') continue
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) entries.push(parsed)
    } catch {
      // A truncated or non-JSON log line is skipped, never fatal: the log is a ring
      // buffer that may have rotated mid-line.
    }
  }
  return entries
}

function selectSnapshotEntry(entries, label = DEFAULT_SNAPSHOT_LABEL) {
  const wanted = text(label)
  let selected = null
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || entry.event !== 'performance-snapshot') continue
    const details = toObject(entry.details)
    if (!details) continue
    if (wanted && text(details.label) !== wanted) continue
    selected = { ...details, capturedAt: text(entry.timestamp) || text(details.capturedAt) || null }
  }
  return selected
}

// ---------------------------------------------------------------------------
// Summary + recording state
// ---------------------------------------------------------------------------

function isGpuProcess(processEntry) {
  return /gpu/i.test(processEntry.type || '')
    || /gpu/i.test(processEntry.name || '')
    || /gpu/i.test(processEntry.serviceName || '')
}

function hasCpuNumbers(processes) {
  return processes.some((processEntry) => Number(processEntry.cpuPercent) > 0)
}

function summarizeSnapshot(snapshot = {}) {
  const source = toObject(snapshot) || {}
  const processes = Array.isArray(source.processes) ? source.processes.filter(Boolean) : []
  const byType = {}
  const gpu = { processCount: 0, cpuPercent: 0, workingSetMiB: 0, privateMiB: 0 }
  let cpuPercent = 0
  let workingSetMiB = 0
  let privateMiB = 0
  let dedicatedMiB = 0
  let sharedMiB = 0
  let hasDedicated = false
  let hasShared = false
  for (const processEntry of processes) {
    const type = text(processEntry.type, 'Unknown')
    const bucket = byType[type] || { processCount: 0, cpuPercent: 0, workingSetMiB: 0, privateMiB: 0 }
    bucket.processCount += 1
    bucket.cpuPercent += Number(processEntry.cpuPercent) || 0
    bucket.workingSetMiB += Number(processEntry.workingSetMiB) || 0
    bucket.privateMiB += Number(processEntry.privateMiB) || 0
    byType[type] = bucket
    cpuPercent += Number(processEntry.cpuPercent) || 0
    workingSetMiB += Number(processEntry.workingSetMiB) || 0
    privateMiB += Number(processEntry.privateMiB) || 0
    if (numberOrNull(processEntry.gpuDedicatedMiB) !== null) {
      dedicatedMiB += Number(processEntry.gpuDedicatedMiB)
      hasDedicated = true
    }
    if (numberOrNull(processEntry.gpuSharedMiB) !== null) {
      sharedMiB += Number(processEntry.gpuSharedMiB)
      hasShared = true
    }
    if (isGpuProcess(processEntry)) {
      gpu.processCount += 1
      gpu.cpuPercent += Number(processEntry.cpuPercent) || 0
      gpu.workingSetMiB += Number(processEntry.workingSetMiB) || 0
      gpu.privateMiB += Number(processEntry.privateMiB) || 0
    }
  }
  for (const bucket of Object.values(byType)) {
    bucket.cpuPercent = round(bucket.cpuPercent, 2)
    bucket.workingSetMiB = round(bucket.workingSetMiB, 1)
    bucket.privateMiB = round(bucket.privateMiB, 1)
  }
  const intrinsicCpu = numberOrNull(source.cpuPercent)
  return {
    processCount: processes.length,
    cpuPercent: intrinsicCpu !== null ? round(intrinsicCpu, 2) : round(cpuPercent, 2),
    cpuAvailable: intrinsicCpu !== null || hasCpuNumbers(processes),
    ...(numberOrNull(source.cpuSeconds) !== null ? { cpuSeconds: round(source.cpuSeconds, 2) } : {}),
    workingSetMiB: round(workingSetMiB, 1),
    privateMiB: round(privateMiB, 1),
    vram: {
      dedicatedMiB: hasDedicated ? round(dedicatedMiB, 1) : null,
      sharedMiB: hasShared ? round(sharedMiB, 1) : null
    },
    gpu: {
      processCount: gpu.processCount,
      cpuPercent: round(gpu.cpuPercent, 2),
      workingSetMiB: round(gpu.workingSetMiB, 1),
      privateMiB: round(gpu.privateMiB, 1)
    },
    gpuVideoEncodePercent: numberOrNull(source.gpuVideoEncodePercent),
    byType
  }
}

function calculateAvDriftMs(videoStartMs, audioStartMs) {
  const video = numberOrNull(videoStartMs)
  const audio = numberOrNull(audioStartMs)
  if (video === null || audio === null) return null
  return round(Math.abs(video - audio), 1)
}

function withinDriftBudget(driftMs, budgetMs = ACCEPTANCE.maxAvDriftMs) {
  const drift = numberOrNull(driftMs)
  const budget = numberOrNull(budgetMs)
  if (drift === null || drift < 0 || budget === null || budget < 0) return false
  return drift <= budget
}

function calculateDroppedFramePercent(droppedFrames, totalFrames) {
  const dropped = nonNegativeOrNull(droppedFrames)
  const total = positiveOrNull(totalFrames)
  if (dropped === null || total === null) return null
  return round(Math.min(100, (dropped / total) * 100), 3)
}

function normalizeRecordingInfo(value) {
  const source = toObject(value) || {}
  const droppedFrames = nonNegativeOrNull(source.droppedFrames)
  const totalFrames = positiveOrNull(source.totalFrames)
  const explicitDrift = nonNegativeOrNull(source.avDriftMs)
  return {
    mode: text(source.mode),
    directTrack: typeof source.directTrack === 'boolean' ? source.directTrack : null,
    resolution: text(source.resolution),
    gpu: text(source.gpu),
    droppedFrames,
    totalFrames,
    droppedFramePercent: nonNegativeOrNull(source.droppedFramePercent) !== null
      ? round(source.droppedFramePercent, 3)
      : calculateDroppedFramePercent(droppedFrames, totalFrames),
    videoStartMs: numberOrNull(source.videoStartMs),
    audioStartMs: numberOrNull(source.audioStartMs),
    avDriftMs: explicitDrift !== null ? explicitDrift : calculateAvDriftMs(source.videoStartMs, source.audioStartMs),
    exportMs: nonNegativeOrNull(source.exportMs),
    durationMs: nonNegativeOrNull(source.durationMs),
    qualityAcceptable: typeof source.qualityAcceptable === 'boolean' ? source.qualityAcceptable : null
  }
}

function buildReport(options = {}) {
  const source = toObject(options) || {}
  // Accept a normalized snapshot, a raw app.getAppMetrics() array or a
  // memory-snapshot payload; parseSnapshot is idempotent for normalized input.
  const snapshot = parseSnapshot(source.snapshot) || toObject(source.snapshot) || {}
  return {
    label: text(source.label) || text(snapshot.label) || DEFAULT_LABEL,
    source: text(source.source, 'input'),
    capturedAt: text(source.capturedAt) || text(snapshot.capturedAt) || null,
    platform: text(source.platform) || process.platform,
    snapshot: {
      sampleCount: positiveOrNull(snapshot.sampleCount) || 1,
      ...summarizeSnapshot(snapshot)
    },
    recording: normalizeRecordingInfo(source.recording),
    thresholds: { ...ACCEPTANCE }
  }
}

// ---------------------------------------------------------------------------
// Pairwise comparison
// ---------------------------------------------------------------------------

function deltaOf(baselineValue, candidateValue) {
  const baseline = numberOrNull(baselineValue)
  const candidate = numberOrNull(candidateValue)
  return {
    baseline,
    candidate,
    delta: baseline !== null && candidate !== null ? round(candidate - baseline, 2) : null
  }
}

function vramMiB(report, key) {
  const vram = toObject(report?.snapshot?.vram)
  return vram ? vram[key] : null
}

function compareReports(baselineReport, candidateReport) {
  const baseline = toObject(baselineReport) || {}
  const candidate = toObject(candidateReport) || {}
  const baselineSnapshot = toObject(baseline.snapshot) || {}
  const candidateSnapshot = toObject(candidate.snapshot) || {}
  const baselineRecording = normalizeRecordingInfo(baseline.recording)
  const candidateRecording = normalizeRecordingInfo(candidate.recording)

  const baseCpu = numberOrNull(baselineSnapshot.cpuPercent)
  const candidateCpu = numberOrNull(candidateSnapshot.cpuPercent)
  const cpuDropPercent = baseCpu !== null && candidateCpu !== null && baseCpu > 0
    ? round(((baseCpu - candidateCpu) / baseCpu) * 100, 2)
    : null

  const droppedFramePercent = candidateRecording.droppedFramePercent
  const avDriftMs = candidateRecording.avDriftMs
  const quality = candidateRecording.qualityAcceptable

  const checks = {
    cpu: cpuDropPercent !== null && cpuDropPercent >= ACCEPTANCE.minCpuDropPercent,
    droppedFrames: droppedFramePercent !== null && droppedFramePercent < ACCEPTANCE.maxDroppedFramePercent,
    avDrift: avDriftMs !== null && withinDriftBudget(avDriftMs),
    quality: quality === true
  }

  const missing = []
  if (cpuDropPercent === null) missing.push('cpuPercent')
  if (droppedFramePercent === null) missing.push('droppedFramePercent')
  if (avDriftMs === null) missing.push('avDriftMs')
  if (quality === null) missing.push('qualityAcceptable')

  return {
    baseline: text(baseline.label, 'baseline'),
    candidate: text(candidate.label, 'candidate'),
    cpu: { baselinePercent: baseCpu, candidatePercent: candidateCpu, dropPercent: cpuDropPercent },
    memory: {
      workingSetMiB: deltaOf(baselineSnapshot.workingSetMiB, candidateSnapshot.workingSetMiB),
      privateMiB: deltaOf(baselineSnapshot.privateMiB, candidateSnapshot.privateMiB),
      gpuDedicatedMiB: deltaOf(vramMiB(baseline, 'dedicatedMiB'), vramMiB(candidate, 'dedicatedMiB')),
      gpuSharedMiB: deltaOf(vramMiB(baseline, 'sharedMiB'), vramMiB(candidate, 'sharedMiB'))
    },
    gpuVideoEncodePercent: deltaOf(baselineSnapshot.gpuVideoEncodePercent, candidateSnapshot.gpuVideoEncodePercent),
    droppedFramePercent: { baseline: baselineRecording.droppedFramePercent, candidate: droppedFramePercent },
    avDriftMs: { baseline: baselineRecording.avDriftMs, candidate: avDriftMs },
    exportMs: deltaOf(baselineRecording.exportMs, candidateRecording.exportMs),
    checks,
    missing,
    expand: missing.length === 0 && checks.cpu && checks.droppedFrames && checks.avDrift && checks.quality
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatNumber(value, digits = 2, fallback = '未取得') {
  const number = numberOrNull(value)
  return number === null ? fallback : number.toFixed(digits)
}

function formatPercent(value, digits = 2) {
  const number = numberOrNull(value)
  return number === null ? '未取得' : number.toFixed(digits) + '%'
}

function formatMiB(value) {
  const number = numberOrNull(value)
  return number === null ? '未取得' : number.toFixed(1) + ' MiB'
}

function formatSeconds(milliseconds) {
  const number = numberOrNull(milliseconds)
  return number === null ? '未取得' : (number / 1000).toFixed(1)
}

function formatSummary(report) {
  const snapshot = toObject(report?.snapshot) || {}
  const recording = normalizeRecordingInfo(report?.recording)
  const gpu = toObject(snapshot.gpu) || {}
  const vram = toObject(snapshot.vram) || {}
  const lines = [
    '## 录制编码样本：' + text(report?.label, DEFAULT_LABEL),
    '',
    '- 来源：' + text(report?.source, 'input') + (report?.capturedAt ? '（' + report.capturedAt + '）' : ''),
    '- 进程：' + (snapshot.processCount || 0) + '（其中 GPU 进程 ' + (gpu.processCount || 0) + '）',
    '- CPU：' + formatPercent(snapshot.cpuPercent)
      + (gpu.processCount ? '（GPU 进程 ' + formatPercent(gpu.cpuPercent) + '）' : '')
      + (snapshot.cpuAvailable === false ? '（该快照不含 CPU 占用率）' : ''),
    '- 工作集：' + formatNumber(snapshot.workingSetMiB, 1) + ' MiB；私有提交：' + formatNumber(snapshot.privateMiB, 1) + ' MiB',
    '- 显存：专用 ' + formatMiB(vram.dedicatedMiB) + ' / 共享 ' + formatMiB(vram.sharedMiB),
    '- GPU Video Encode：' + (numberOrNull(snapshot.gpuVideoEncodePercent) === null
      ? '未取得（app.getAppMetrics 不提供；可在快照里写入 gpuVideoEncodePercent）'
      : formatNumber(snapshot.gpuVideoEncodePercent, 2) + '%')
  ]
  if (recording.droppedFramePercent !== null) {
    lines.push('- 掉帧：' + recording.droppedFrames + '/' + recording.totalFrames
      + ' = ' + formatNumber(recording.droppedFramePercent, 3) + '%（门槛 <' + ACCEPTANCE.maxDroppedFramePercent + '%）')
  } else {
    lines.push('- 掉帧：未提供（可选字段 droppedFrames/totalFrames）')
  }
  if (recording.avDriftMs !== null) {
    lines.push('- 音画差：' + formatNumber(recording.avDriftMs, 1) + ' ms（门槛 <='
      + ACCEPTANCE.maxAvDriftMs + ' ms，' + (withinDriftBudget(recording.avDriftMs) ? '达标' : '超标') + '）')
  } else {
    lines.push('- 音画差：未提供（可给 videoStartMs/audioStartMs）')
  }
  if (recording.exportMs !== null) lines.push('- 导出耗时：' + formatNumber(recording.exportMs / 1000, 1) + ' s')
  if (recording.directTrack !== null) lines.push('- 录制路径：' + (recording.directTrack ? '直录源视频轨' : 'Canvas 合成'))
  if (recording.qualityAcceptable !== null) {
    lines.push('- 画质：' + (recording.qualityAcceptable ? '人工比对可接受' : '不可接受'))
  }
  return lines.join('\n')
}

function formatComparison(comparison) {
  const cpu = toObject(comparison?.cpu) || {}
  const memory = toObject(comparison?.memory) || {}
  const lines = [
    '## 成对比较：' + text(comparison?.baseline, 'baseline') + ' -> ' + text(comparison?.candidate, 'candidate'),
    '',
    '| 指标 | 基线 | 候选 | 变化 | 门槛 |',
    '| --- | ---: | ---: | ---: | --- |',
    '| CPU | ' + formatPercent(cpu.baselinePercent) + ' | ' + formatPercent(cpu.candidatePercent)
      + ' | ' + formatPercent(cpu.dropPercent) + ' | 下降 >= ' + ACCEPTANCE.minCpuDropPercent + '% |',
    '| 工作集 (MiB) | ' + formatNumber(memory.workingSetMiB?.baseline, 1) + ' | '
      + formatNumber(memory.workingSetMiB?.candidate, 1) + ' | ' + formatNumber(memory.workingSetMiB?.delta, 1) + ' | 参考 |',
    '| 私有提交 (MiB) | ' + formatNumber(memory.privateMiB?.baseline, 1) + ' | '
      + formatNumber(memory.privateMiB?.candidate, 1) + ' | ' + formatNumber(memory.privateMiB?.delta, 1) + ' | 参考 |',
    '| 显存 (MiB) | ' + formatNumber(memory.gpuDedicatedMiB?.baseline, 1) + ' | '
      + formatNumber(memory.gpuDedicatedMiB?.candidate, 1) + ' | ' + formatNumber(memory.gpuDedicatedMiB?.delta, 1) + ' | 参考 |',
    '| 掉帧 (%) | ' + formatNumber(comparison?.droppedFramePercent?.baseline, 3) + ' | '
      + formatNumber(comparison?.droppedFramePercent?.candidate, 3) + ' | — | < ' + ACCEPTANCE.maxDroppedFramePercent + '% |',
    '| 音画差 (ms) | ' + formatNumber(comparison?.avDriftMs?.baseline, 1) + ' | '
      + formatNumber(comparison?.avDriftMs?.candidate, 1) + ' | — | <= ' + ACCEPTANCE.maxAvDriftMs + ' ms |',
    '| 导出耗时 (s) | ' + formatSeconds(comparison?.exportMs?.baseline) + ' | '
      + formatSeconds(comparison?.exportMs?.candidate) + ' | '
      + formatSeconds(comparison?.exportMs?.delta) + ' | 参考 |'
  ]
  const checks = toObject(comparison?.checks) || {}
  lines.push('')
  lines.push('- 判定：CPU ' + (checks.cpu ? '达标' : '未达标')
    + '；掉帧 ' + (checks.droppedFrames ? '达标' : '未达标')
    + '；音画差 ' + (checks.avDrift ? '达标' : '未达标')
    + '；画质 ' + (checks.quality ? '可接受' : '未声明/不可接受'))
  if (Array.isArray(comparison?.missing) && comparison.missing.length) {
    lines.push('- 缺少数据：' + comparison.missing.join('、'))
  }
  lines.push('- 结论：' + (comparison?.expand === true
    ? '满足 C05 扩展门槛，可安排下一轮更大范围验证'
    : '不满足扩展门槛，保持 Canvas 合成路径'))
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Inputs (files, log, live sampling)
// ---------------------------------------------------------------------------

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function readTextFile(filePath) {
  return fs.readFileSync(filePath, 'utf8')
}

function collectLiveSnapshots(options = {}, io = {}) {
  const collect = typeof io.collect === 'function' ? io.collect : collectProcesses
  const now = typeof io.now === 'function' ? io.now : () => Date.now()
  const sleep = typeof io.sleep === 'function' ? io.sleep : sleepSync
  const rootPid = positiveOrNull(options.rootPid)
  if (rootPid === null) throw new Error('--live 需要 --root-pid')
  const samples = Math.max(1, Math.round(Number(options.samples) || DEFAULT_SAMPLES))
  const intervalMs = Math.max(0, Math.round(Number(options.interval) || 0))
  const collected = []
  for (let index = 0; index < samples; index++) {
    const startedAt = now()
    const processes = collect({ rootPid })
    if (!processes.length) throw new Error('未取得 PID ' + rootPid + ' 的进程树（--live 仅支持 Windows）')
    collected.push({
      timestamp: new Date(startedAt).toISOString(),
      timestampMs: startedAt,
      processes
    })
    if (index < samples - 1 && intervalMs > 0) sleep(intervalMs)
  }
  return collected
}

function averageMemoryOf(list, pid) {
  let workingSetMiB = 0
  let privateMiB = 0
  let count = 0
  let dedicatedMiB = 0
  let sharedMiB = 0
  let hasDedicated = false
  let hasShared = false
  for (const sample of list) {
    const processEntry = sample.processes.find((entry) => entry && Number(entry.pid) === pid)
    if (!processEntry) continue
    workingSetMiB += Number(processEntry.workingSetMiB) || 0
    privateMiB += Number(processEntry.privateMiB) || 0
    if (numberOrNull(processEntry.gpuDedicatedMiB) !== null) {
      dedicatedMiB += Number(processEntry.gpuDedicatedMiB)
      hasDedicated = true
    }
    if (numberOrNull(processEntry.gpuSharedMiB) !== null) {
      sharedMiB += Number(processEntry.gpuSharedMiB)
      hasShared = true
    }
    count += 1
  }
  return {
    count,
    workingSetMiB: count ? workingSetMiB / count : 0,
    privateMiB: count ? privateMiB / count : 0,
    dedicatedMiB: hasDedicated ? dedicatedMiB / count : null,
    sharedMiB: hasShared ? sharedMiB / count : null
  }
}

// CPU percent is the delta of the cumulative CPU seconds between the first and the last
// sample, divided by the wall time between them: the same definition Windows Task
// Manager uses for a process.
function summarizeLiveSamples(samples = []) {
  const list = (Array.isArray(samples) ? samples : []).filter(
    (sample) => sample && Array.isArray(sample.processes) && sample.processes.length
  )
  if (!list.length) return null
  const first = list[0]
  const last = list[list.length - 1]
  const firstMs = numberOrNull(first.timestampMs) ?? Date.parse(first.timestamp)
  const lastMs = numberOrNull(last.timestampMs) ?? Date.parse(last.timestamp)
  const wallSeconds = Math.max(0, ((Number.isFinite(lastMs) ? lastMs : 0) - (Number.isFinite(firstMs) ? firstMs : 0)) / 1000)
  const firstByPid = new Map()
  for (const processEntry of first.processes) {
    if (processEntry && Number.isSafeInteger(Number(processEntry.pid))) {
      firstByPid.set(Number(processEntry.pid), processEntry)
    }
  }
  const processes = []
  for (const end of last.processes) {
    if (!end || !Number.isSafeInteger(Number(end.pid))) continue
    const pid = Number(end.pid)
    const start = firstByPid.get(pid)
    const startCpu = start ? numberOrNull(start.cpuSeconds) : null
    const endCpu = numberOrNull(end.cpuSeconds)
    const cpuDelta = startCpu !== null && endCpu !== null ? Math.max(0, endCpu - startCpu) : null
    const cpuPercent = cpuDelta !== null && wallSeconds > 0 ? round((cpuDelta / wallSeconds) * 100, 2) : 0
    const memory = averageMemoryOf(list, pid)
    processes.push({
      pid,
      type: text(end.processType) || text(end.role) || 'other',
      name: text(end.name),
      serviceName: '',
      cpuPercent,
      workingSetMiB: round(memory.workingSetMiB, 1),
      privateMiB: round(memory.privateMiB, 1),
      ...(memory.dedicatedMiB !== null ? { gpuDedicatedMiB: round(memory.dedicatedMiB, 1) } : {}),
      ...(memory.sharedMiB !== null ? { gpuSharedMiB: round(memory.sharedMiB, 1) } : {})
    })
  }
  return {
    label: 'live',
    capturedAt: new Date(Number.isFinite(lastMs) ? lastMs : Date.now()).toISOString(),
    sampleCount: list.length,
    durationMs: wallSeconds * 1000,
    processes
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function defaultOutPath(label, now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  const safe = String(label || DEFAULT_LABEL).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 80) || DEFAULT_LABEL
  return path.resolve(DEFAULT_OUT_DIR, safe + '-' + stamp + '.json')
}

function writeJsonFile(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + '\n', 'utf8')
  return filePath
}

function loadSnapshot(options) {
  if (options.input) {
    const snapshot = parseSnapshot(readJsonFile(options.input))
    if (!snapshot) throw new Error('无法识别的快照格式：' + options.input)
    return { snapshot, source: 'input', capturedAt: snapshot.capturedAt }
  }
  if (options.log) {
    const entry = selectSnapshotEntry(parseLogEntries(readTextFile(options.log)), options.snapshotLabel)
    if (!entry) throw new Error('日志中没有 performance-snapshot：' + options.log)
    const snapshot = parseSnapshot(entry)
    if (!snapshot) throw new Error('日志快照缺少进程数据：' + options.log)
    return { snapshot, source: 'log', capturedAt: snapshot.capturedAt }
  }
  if (options.live) {
    const live = summarizeLiveSamples(collectLiveSnapshots(options))
    if (!live) throw new Error('--live 未采集到进程')
    return { snapshot: live, source: 'live', capturedAt: live.capturedAt }
  }
  throw new Error('需要 --input、--log、--live 或 --compare')
}

function coerceReport(payload, label) {
  if (Array.isArray(payload)) {
    const arraySnapshot = parseSnapshot(payload)
    if (!arraySnapshot) return null
    return buildReport({
      label: text(label) || 'sample',
      source: 'file',
      capturedAt: arraySnapshot.capturedAt,
      snapshot: arraySnapshot,
      recording: null
    })
  }
  const source = toObject(payload)
  if (!source) return null
  if (toObject(source.snapshot) && toObject(source.recording)) return source
  const snapshot = parseSnapshot(payload)
  if (!snapshot) return null
  return buildReport({
    label: text(source.label) || text(label) || 'sample',
    source: 'file',
    capturedAt: snapshot.capturedAt,
    snapshot,
    recording: toObject(source.recording) || null
  })
}

function runComparison(options, log) {
  const baseline = coerceReport(readJsonFile(options.compare[0]), path.basename(options.compare[0]))
  const candidate = coerceReport(readJsonFile(options.compare[1]), path.basename(options.compare[1]))
  if (!baseline || !candidate) throw new Error('--compare 需要两份可识别的快照或报告 JSON')
  const comparison = compareReports(baseline, candidate)
  if (options.noOut || options.json) {
    if (options.json) log(JSON.stringify(comparison, null, 2))
    else log(formatComparison(comparison))
    return 0
  }
  const outPath = options.out || defaultOutPath('compare-' + text(candidate.label, 'candidate'))
  writeJsonFile(outPath, comparison)
  log(formatComparison(comparison))
  log('')
  log('JSON: ' + outPath)
  return 0
}

function main(argv = process.argv.slice(2), io = {}) {
  const log = typeof io.stdout === 'function' ? io.stdout : (line) => console.log(line)
  const warn = typeof io.stderr === 'function' ? io.stderr : (line) => console.error(line)
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    warn('measure-recording-encode: ' + (error && error.message ? error.message : String(error)))
    warn('')
    warn(USAGE)
    return 1
  }
  if (options.help) {
    log(USAGE)
    return 0
  }
  try {
    if (options.compare) return runComparison(options, log)
    const loaded = loadSnapshot(options)
    const recordingFile = options.recording ? readJsonFile(options.recording) : null
    const recording = toObject(recordingFile) || toObject(loaded.snapshot.recording) || null
    const report = buildReport({
      label: options.label,
      source: loaded.source,
      capturedAt: loaded.capturedAt,
      snapshot: loaded.snapshot,
      recording
    })
    if (options.json) {
      log(JSON.stringify(report, null, 2))
      return 0
    }
    const outPath = options.noOut ? null : options.out || defaultOutPath(report.label)
    if (outPath) writeJsonFile(outPath, report)
    log(formatSummary(report))
    log('')
    if (outPath) log('JSON: ' + outPath)
    return 0
  } catch (error) {
    warn('measure-recording-encode: ' + (error && error.message ? error.message : String(error)))
    return 1
  }
}

module.exports = {
  ACCEPTANCE,
  DEFAULT_INTERVAL_MS,
  DEFAULT_LABEL,
  DEFAULT_OUT_DIR,
  DEFAULT_SAMPLES,
  DEFAULT_SNAPSHOT_LABEL,
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
  normalizeProcessEntry,
  normalizeRecordingInfo,
  parseArgs,
  parseLogEntries,
  parseSnapshot,
  selectSnapshotEntry,
  summarizeLiveSamples,
  summarizeSnapshot,
  withinDriftBudget
}

if (require.main === module) {
  process.exitCode = main()
}
