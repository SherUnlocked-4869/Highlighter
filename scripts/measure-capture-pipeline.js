#!/usr/bin/env node
'use strict'

// DEV-03 measurement: the real on-demand screenshot pipeline in a real Electron
// main process, measured from the outside.
//
// It launches THIS checkout's app (not the installed app) against an isolated
// portable data root, hides its main window, puts the cursor on the secondary
// display, and then triggers the same entry the global hotkey uses
// (`window.electronAPI.executeFunction('screenshot')` -> function-router ->
// captureDomain.createCaptureWindow). One main-process observer (installed by
// this probe only, no product change) timestamps:
//
//   trigger -> BrowserWindow created -> dom-ready -> did-finish-load
//           -> capture:ready -> capture:render-ready (first operable frame)
//           -> closed
//
// The product's own `performanceMonitor` entries (`capture.acquired`,
// `capture.interactive` with captureMs/smartSelectMs/windowLoadMs) are read back
// from the isolated data root's app.log and joined per capture id. Memory comes
// from app.getAppMetrics() plus a read-only process-tree sample
// (scripts/memory-snapshot.js) and SmartSelect.exe's own process counters.
//
// Also measured here (probe-only, labelled as such in the report):
//   * a hidden pre-loaded capture window's boot cost and its idle memory delta
//     (candidate "pre-warm hidden window")
//   * the first hover-triggered SmartSelect query latency in the real renderer
//     (candidate "reuse SmartSelect session"; the sidecar lifecycle itself is
//     measured by scripts/probe-smart-select-lifecycle.js)
//
// Usage:
//   node scripts/measure-capture-pipeline.js --smoke
//   node scripts/measure-capture-pipeline.js --samples 30 --idle-seconds 600
// Env: TMP/TEMP under .tmp-work; no ELECTRON_RUN_AS_NODE; windows are created on
// the secondary display only.

const { execFileSync, spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const BASE = path.join(ROOT, '.tmp-work', 'experiment', 'dev03')

function argValue(args, name, fallback) {
  const index = args.indexOf(name)
  if (index < 0) return fallback
  const value = Number(args[index + 1])
  return Number.isFinite(value) ? value : fallback
}

const OPTIONS = {
  smoke: process.argv.includes('--smoke'),
  samples: argValue(process.argv, '--samples', 30),
  idleSeconds: argValue(process.argv, '--idle-seconds', 600),
  gapMs: argValue(process.argv, '--gap-ms', 500),
  closeDelayMs: argValue(process.argv, '--close-delay-ms', 200),
  prewarmIterations: argValue(process.argv, '--prewarm-iterations', 8),
  hoverSamples: argValue(process.argv, '--hover-samples', 6),
  timeoutMs: argValue(process.argv, '--timeout-ms', 30000),
  warmupCapture: !process.argv.includes('--no-warmup'),
  out: path.join(BASE, 'capture-pipeline.json')
}
{
  const outIndex = process.argv.indexOf('--out')
  if (outIndex >= 0 && process.argv[outIndex + 1]) OPTIONS.out = path.resolve(process.argv[outIndex + 1])
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const round = (value, digits = 2) => {
  const factor = 10 ** digits
  return Math.round((Number(value) || 0) * factor) / factor
}

function percentile(values, p) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
  if (!sorted.length) return null
  return round(sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)], 2)
}

function summarize(values) {
  const list = values.filter((value) => Number.isFinite(value))
  return {
    n: list.length,
    minMs: list.length ? round(Math.min(...list)) : null,
    p50Ms: percentile(list, 50),
    p95Ms: percentile(list, 95),
    maxMs: list.length ? round(Math.max(...list)) : null,
    samplesMs: list.map((value) => round(value))
  }
}

function powershell(command, timeout = 20000) {
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8', windowsHide: true, timeout
  }).trim()
  if (!output) return null
  try { return JSON.parse(output) } catch { return output }
}

function displayInfo() {
  const raw = powershell("Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::AllScreens | ForEach-Object { [pscustomobject]@{ device = $_.DeviceName; primary = $_.Primary; x = $_.Bounds.X; y = $_.Bounds.Y; width = $_.Bounds.Width; height = $_.Bounds.Height } } | ConvertTo-Json -Compress")
  const list = Array.isArray(raw) ? raw : raw ? [raw] : []
  return list
}

function cursorPosition() {
  const raw = powershell("Add-Type -AssemblyName System.Windows.Forms; $p = [System.Windows.Forms.Cursor]::Position; [pscustomobject]@{ x = $p.X; y = $p.Y } | ConvertTo-Json -Compress")
  return raw && Number.isFinite(Number(raw.x)) ? { x: Number(raw.x), y: Number(raw.y) } : null
}

function setCursorPosition(x, y) {
  try {
    powershell(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${Math.round(x)}, ${Math.round(y)}); Start-Sleep -Milliseconds 150`)
  } catch {}
}

// The cursor decides which display getDisplayCapture() snaps (screen.getDisplayNearestPoint
// (screen.getCursorScreenPoint())). On this host the primary display is 150% and the secondary
// 125%, so a cursor set in one coordinate space can land on the wrong screen - and the user is
// actively using the machine during the idle hold. Re-park the cursor before EVERY trigger and
// verify with Electron's own screen API that it landed on the secondary display.
async function resolveCursorTarget(electronApp) {
  return electronApp.evaluate(({ screen }) => {
    const primary = screen.getPrimaryDisplay()
    const secondary = screen.getAllDisplays().find((display) => display.id !== primary.id) || primary
    const dip = {
      x: secondary.bounds.x + Math.round(secondary.bounds.width / 2),
      y: secondary.bounds.y + Math.round(secondary.bounds.height * 0.4)
    }
    return {
      dip,
      physical: screen.dipToScreenPoint(dip),
      secondaryId: secondary.id,
      primaryId: primary.id,
      secondaryBounds: secondary.bounds,
      secondaryScale: secondary.scaleFactor,
      primaryScale: primary.scaleFactor
    }
  })
}

async function cursorStatus(electronApp) {
  return electronApp.evaluate(({ screen }) => {
    const point = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(point)
    const primary = screen.getPrimaryDisplay()
    return { point, displayId: display.id, isPrimary: display.id === primary.id }
  })
}

async function parkCursorOnSecondary(electronApp, target) {
  if (!target || target.secondaryId === target.primaryId) return { skipped: true, ok: false }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const candidate = attempt === 0 ? target.physical : target.dip
    setCursorPosition(candidate.x, candidate.y)
    await sleep(130)
    const status = await cursorStatus(electronApp)
    if (status && status.displayId === target.secondaryId) {
      return { ok: true, attempt, used: attempt === 0 ? 'physical' : 'dip', status }
    }
  }
  return { ok: false, status: await cursorStatus(electronApp) }
}

function sidecarCounts() {
  const raw = powershell([
    "$names = 'SmartSelect.exe','HighlighterOcrSidecar.exe','HighlighterClipboard.exe','HighlighterEverything.exe','Everything.exe','ffmpeg.exe','HighlighterShutterSound.exe'",
    "$items = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $names -contains $_.Name }",
    "$items | Group-Object Name | ForEach-Object { [pscustomobject]@{ name = $_.Name; count = $_.Count } } | ConvertTo-Json -Compress"
  ].join('; '))
  const list = raw ? (Array.isArray(raw) ? raw : [raw]) : []
  return list.map((item) => ({ name: String(item.name || ''), count: Number(item.count) || 0 }))
}

// Native children (SmartSelect.exe, OCR/clipboard/Everything sidecars) are outside
// app.getAppMetrics(), so the process tree is sampled by a read-only PowerShell
// collector keyed by the known main pid (no name-based discovery: the installed
// app must never be sampled by mistake).
const TREE_PS = `
param([int]$RootPid)
$ErrorActionPreference = 'Stop'
$all = Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,Name,ExecutablePath,CommandLine,WorkingSetSize,PageFileUsage -ErrorAction SilentlyContinue
$root = $all | Where-Object { $_.ProcessId -eq $RootPid } | Select-Object -First 1
if (-not $root) { '[]'; exit 0 }
$items = [System.Collections.Generic.List[object]]::new()
$seen = [System.Collections.Generic.HashSet[int]]::new()
$items.Add($root); [void]$seen.Add($root.ProcessId)
$children = $all | Group-Object -Property ParentProcessId -AsHashTable -AsString
for ($i = 0; $i -lt $items.Count; $i++) {
  $parent = $items[$i]
  foreach ($child in $children[[string]$parent.ProcessId]) {
    if ($child.CreationDate -ge $parent.CreationDate -and $seen.Add($child.ProcessId)) { $items.Add($child) }
  }
}
$processFilter = ($items | ForEach-Object { "IDProcess=$($_.ProcessId)" }) -join ' OR '
$perf = @{}
try {
  Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -Filter $processFilter -ErrorAction Stop | ForEach-Object { $perf[[int]$_.IDProcess] = $_ }
} catch {}
$gpuFilter = ($items | ForEach-Object { "Name LIKE 'pid_$($_.ProcessId)[_]%'" }) -join ' OR '
$gpu = @{}; $gpuAvailable = $true
try {
  foreach ($row in (Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory -Filter $gpuFilter -ErrorAction Stop)) {
    if ($row.Name -match '^pid_(\\d+)_') {
      $gpuPid = [int]$Matches[1]
      if (!$gpu.ContainsKey($gpuPid)) { $gpu[$gpuPid] = @{ Dedicated = 0; Shared = 0 } }
      $gpu[$gpuPid].Dedicated += $row.DedicatedUsage
      $gpu[$gpuPid].Shared += $row.SharedUsage
    }
  }
} catch { $gpuAvailable = $false }
$result = foreach ($item in $items) {
  $cpu = 0
  try { $process = Get-Process -Id $item.ProcessId -ErrorAction Stop; if ($null -ne $process.CPU) { $cpu = [double]$process.CPU } } catch {}
  $counter = $perf[[int]$item.ProcessId]; $gpuCounter = $gpu[[int]$item.ProcessId]
  [pscustomobject]@{
    ProcessId = $item.ProcessId; ParentProcessId = $item.ParentProcessId; Name = $item.Name
    ExecutablePath = $item.ExecutablePath; CommandLine = $item.CommandLine
    WorkingSetSize = $item.WorkingSetSize; PageFileUsage = $item.PageFileUsage; CpuSeconds = $cpu
    PrivateBytes = $(if ($counter) { $counter.PrivateBytes } else { $null })
    PercentProcessorTime = $(if ($counter) { $counter.PercentProcessorTime } else { $null })
    DedicatedUsage = $(if ($gpuAvailable) { [uint64]$gpuCounter.Dedicated } else { $null })
    SharedUsage = $(if ($gpuAvailable) { [uint64]$gpuCounter.Shared } else { $null })
  }
}
$result | ConvertTo-Json -Compress -Depth 3
`

function writeTreeCollector() {
  const psPath = path.join(BASE, 'collect-process-tree.ps1')
  fs.mkdirSync(BASE, { recursive: true })
  fs.writeFileSync(psPath, TREE_PS, 'utf8')
  return psPath
}

function classifyTreeName(name, commandLine, executablePath) {
  const base = String(name || '').toLowerCase()
  const signal = `${String(commandLine || '')}\n${String(executablePath || '')}`.toLowerCase()
  if (base === 'smartselect.exe' || signal.includes('\\native\\smart-select\\')) return 'smart-select'
  if (base === 'highlighterocrsidecar.exe') return 'ocr-sidecar'
  if (base === 'highlighterclipboard.exe') return 'clipboard-sidecar'
  if (base === 'highlightereverything.exe' || signal.includes('\\native\\everything')) return 'everything-sidecar'
  if (base === 'everything.exe') return 'everything-external'
  if (base === 'ffmpeg.exe') return 'ffmpeg'
  if (base === 'electron.exe' || base === 'highlighter.exe') return 'chromium'
  return 'other'
}

function collectProcessTree(rootPid, psPath) {
  try {
    const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psPath, '-RootPid', String(rootPid)], {
      encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 16 * 1048576
    }).trim()
    if (!output) return { samples: [], error: 'empty process tree output' }
    const parsed = JSON.parse(output)
    const list = Array.isArray(parsed) ? parsed : [parsed]
    const processes = list.map((item) => ({
      pid: Number(item.ProcessId),
      parentPid: Number(item.ParentProcessId) || null,
      role: classifyTreeName(item.Name, item.CommandLine, item.ExecutablePath),
      name: String(item.Name || ''),
      workingSetMiB: round((Number(item.WorkingSetSize) || 0) / 1048576, 1),
      privateMiB: round((Number(item.PrivateBytes) || 0) / 1048576, 1),
      cpuSeconds: round(item.CpuSeconds, 2),
      cpuPercentOfOneCore: item.PercentProcessorTime === null ? null : round(item.PercentProcessorTime, 2),
      gpuDedicatedMiB: item.DedicatedUsage === null || item.DedicatedUsage === undefined ? null : round(Number(item.DedicatedUsage) / 1048576, 2),
      gpuSharedMiB: item.SharedUsage === null || item.SharedUsage === undefined ? null : round(Number(item.SharedUsage) / 1048576, 2)
    }))
    const totals = { processCount: processes.length, workingSetMiB: 0, privateMiB: 0, cpuSeconds: 0 }
    const byRole = {}
    for (const proc of processes) {
      totals.workingSetMiB += proc.workingSetMiB
      totals.privateMiB += proc.privateMiB
      totals.cpuSeconds += proc.cpuSeconds
      const bucket = byRole[proc.role] || { count: 0, workingSetMiB: 0, privateMiB: 0, cpuSeconds: 0 }
      bucket.count += 1
      bucket.workingSetMiB += proc.workingSetMiB
      bucket.privateMiB += proc.privateMiB
      bucket.cpuSeconds += proc.cpuSeconds
      byRole[proc.role] = bucket
    }
    for (const bucket of Object.values(byRole)) {
      bucket.workingSetMiB = round(bucket.workingSetMiB, 1)
      bucket.privateMiB = round(bucket.privateMiB, 1)
      bucket.cpuSeconds = round(bucket.cpuSeconds, 2)
    }
    totals.workingSetMiB = round(totals.workingSetMiB, 1)
    totals.privateMiB = round(totals.privateMiB, 1)
    totals.cpuSeconds = round(totals.cpuSeconds, 2)
    return { sampledAt: new Date().toISOString(), totals, byRole, processes }
  } catch (error) {
    return { error: String(error?.message || error).slice(0, 2000) }
  }
}

// Persistent, low-overhead sidecar watcher: one PowerShell process polls
// Get-Process every 150 ms for the whole run and appends NDJSON rows, so helper
// memory can be attributed to a capture window without spawning a process per
// sample (which would distort the timings being measured).
const SIDECAR_WATCHER_PS = `
param([string]$OutFile,[string]$StopFile)
$names = 'SmartSelect','HighlighterOcrSidecar','HighlighterClipboard','HighlighterEverything','Everything','HighlighterShutterSound'
while (-not (Test-Path $StopFile)) {
  $items = Get-Process -Name $names -ErrorAction SilentlyContinue
  foreach ($p in $items) {
    $row = [pscustomobject]@{ t = (Get-Date).ToUniversalTime().ToString('o'); name = $p.ProcessName; pid = $p.Id; ws = $p.WorkingSet64; priv = $p.PrivateMemorySize64; cpu = $p.CPU } | ConvertTo-Json -Compress
    Add-Content -Path $OutFile -Value $row -Encoding utf8
  }
  Start-Sleep -Milliseconds 150
}
`

function startSidecarWatcher() {
  const psPath = path.join(BASE, 'sidecar-watcher.ps1')
  const outFile = path.join(BASE, `sidecars-${Date.now()}.ndjson`)
  const stopFile = path.join(BASE, 'sidecars.stop')
  fs.writeFileSync(psPath, SIDECAR_WATCHER_PS, 'utf8')
  try { fs.rmSync(stopFile, { force: true }) } catch {}
  try { fs.rmSync(outFile, { force: true }) } catch {}
  const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psPath, '-OutFile', outFile, '-StopFile', stopFile], {
    windowsHide: true, stdio: 'ignore'
  })
  return { proc, outFile, stopFile }
}

async function stopSidecarWatcher(watcher) {
  if (!watcher) return []
  try { fs.writeFileSync(watcher.stopFile, '') } catch {}
  await sleep(600)
  try { watcher.proc.kill() } catch {}
  const rows = []
  if (fs.existsSync(watcher.outFile)) {
    for (const line of fs.readFileSync(watcher.outFile, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try { rows.push(JSON.parse(line)) } catch {}
    }
  }
  return rows
}

function summarizeSidecarRows(rows) {
  const byName = {}
  for (const row of rows) {
    const name = String(row.name || '')
    const entry = byName[name] || { name, maxProcessCount: 0, samples: 0, maxPrivateMiB: 0, maxWorkingSetMiB: 0, pids: new Set(), cpuSecondsFirst: null, cpuSecondsLast: null }
    entry.samples += 1
    entry.pids.add(Number(row.pid))
    entry.maxProcessCount = Math.max(entry.maxProcessCount, 1)
    entry.maxPrivateMiB = Math.max(entry.maxPrivateMiB, round(Number(row.priv) / 1048576, 1))
    entry.maxWorkingSetMiB = Math.max(entry.maxWorkingSetMiB, round(Number(row.ws) / 1048576, 1))
    entry.cpuSecondsLast = Number(row.cpu)
    entry.cpuSecondsFirst ??= Number(row.cpu)
    byName[name] = entry
  }
  return Object.values(byName).map((entry) => ({
    name: entry.name,
    distinctPids: entry.pids.size,
    samples: entry.samples,
    maxPrivateMiB: entry.maxPrivateMiB,
    maxWorkingSetMiB: entry.maxWorkingSetMiB,
    cpuSecondsDelta: entry.cpuSecondsFirst === null ? null : round(entry.cpuSecondsLast - entry.cpuSecondsFirst, 2)
  }))
}

function rowsInWindow(rows, startMs, endMs) {
  return rows.filter((row) => {
    const time = Date.parse(row.t)
    return Number.isFinite(time) && time >= startMs - 400 && time <= endMs + 400
  })
}

function prepareDataRoot() {
  const portable = path.join(BASE, 'portable')
  const dataRoot = path.join(BASE, 'data-root')
  fs.mkdirSync(portable, { recursive: true })
  fs.mkdirSync(path.join(dataRoot, 'config'), { recursive: true })
  fs.writeFileSync(path.join(portable, 'Highlighter.location.json'), `${JSON.stringify({ version: 1, dataRoot }, null, 2)}\n`, 'utf8')
  // Keep the measurement instance quiet: no OCR sidecar hot start, no selection
  // hook, no history writes, no shutter-sound sidecar, and - importantly for a
  // dev launch - no login-item write (system.autoStart false).
  const settings = {
    settings: {
      selectionToolbar: { enabled: false },
      clipboard: { enabled: false },
      usage: { enabled: false },
      plugins: { ocr: false, translation: false, ai: false, video: true },
      ocr: { hotStart: false },
      screenshot: {
        historyEnabled: false,
        shutterSound: false,
        captureCursor: false,
        autoSaveOnCopy: false
      },
      system: { autoStart: false, runLog: true }
    }
  }
  fs.writeFileSync(path.join(dataRoot, 'config', 'config.json'), `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  return { portable, dataRoot, logFile: path.join(dataRoot, 'logs', 'app.log') }
}

// ---- product performance log -------------------------------------------------
function readLogEntries(logFile, offset) {
  if (!fs.existsSync(logFile)) return { entries: [], offset }
  const stat = fs.statSync(logFile)
  let start = offset
  if (stat.size < offset) start = 0
  const length = stat.size - start
  if (length <= 0) return { entries: [], offset: stat.size }
  const fd = fs.openSync(logFile, 'r')
  try {
    const buffer = Buffer.alloc(length)
    fs.readSync(fd, buffer, 0, length, start)
    const text = buffer.toString('utf8')
    const lines = text.split('\n')
    // The last fragment may be a partially written line; keep it for next time.
    const tail = lines.pop()
    const entries = []
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const parsed = JSON.parse(line)
        entries.push(parsed)
      } catch {}
    }
    return { entries, offset: stat.size - Buffer.byteLength(tail || '', 'utf8') }
  } finally {
    fs.closeSync(fd)
  }
}

function buildObserverInstaller(options) {
  return async ({ app, BrowserWindow, screen }, config) => {
    let execFileSync = null
    try { execFileSync = require('node:child_process').execFileSync } catch {}
    const state = { samples: [], current: null, closeDelayMs: config.closeDelayMs, hoverMode: false, canSpawn: typeof execFileSync === 'function' }
    globalThis.__capturePipelineProbe = state

    function aggregateMetrics() {
      let metrics = []
      try { metrics = app.getAppMetrics() } catch { return { processCount: 0, workingSetMiB: 0, peakWorkingSetMiB: 0, privateMiB: 0, byType: {} } }
      const summary = { processCount: 0, workingSetMiB: 0, peakWorkingSetMiB: 0, privateMiB: 0, cpuPercent: 0, byType: {} }
      for (const metric of metrics) {
        const type = String(metric?.type || 'Unknown')
        const memory = metric?.memory || {}
        const bucket = summary.byType[type] || { processCount: 0, workingSetMiB: 0, privateMiB: 0 }
        summary.processCount += 1
        summary.workingSetMiB += (Number(memory.workingSetSize) || 0) / 1024
        summary.peakWorkingSetMiB += (Number(memory.peakWorkingSetSize) || 0) / 1024
        summary.privateMiB += (Number(memory.privateBytes) || 0) / 1024
        summary.cpuPercent += Number(metric?.cpu?.percentCPUUsage) || 0
        bucket.processCount += 1
        bucket.workingSetMiB += (Number(memory.workingSetSize) || 0) / 1024
        bucket.privateMiB += (Number(memory.privateBytes) || 0) / 1024
        summary.byType[type] = bucket
      }
      for (const key of ['workingSetMiB', 'peakWorkingSetMiB', 'privateMiB', 'cpuPercent']) summary[key] = Math.round(summary[key] * 100) / 100
      for (const bucket of Object.values(summary.byType)) {
        bucket.workingSetMiB = Math.round(bucket.workingSetMiB * 100) / 100
        bucket.privateMiB = Math.round(bucket.privateMiB * 100) / 100
      }
      return summary
    }

    function sidecars() {
      const names = ['SmartSelect.exe', 'HighlighterOcrSidecar.exe', 'HighlighterClipboard.exe', 'HighlighterEverything.exe', 'HighlighterShutterSound.exe']
      if (typeof execFileSync !== 'function') return { count: -1, list: [], unavailable: true }
      try {
        const filter = names.map((name) => `Name='${name}'`).join(' OR ')
        const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          `$items = Get-CimInstance Win32_Process -Filter "${filter.replace(/"/g, '\\"')}" -ErrorAction SilentlyContinue; $items | Select-Object ProcessId,Name,ParentProcessId | ConvertTo-Json -Compress`
        ], { encoding: 'utf8', windowsHide: true, timeout: 15000 }).trim()
        if (!output) return { count: 0, list: [] }
        const parsed = JSON.parse(output)
        const list = Array.isArray(parsed) ? parsed : [parsed]
        return {
          count: list.length,
          list: list.map((item) => ({ pid: Number(item.ProcessId), name: String(item.Name), parentPid: Number(item.ParentProcessId) }))
        }
      } catch { return { count: 0, list: [], error: true } }
    }

    function helperMemory(sidecarInfo) {
      const helper = (sidecarInfo.list || []).find((item) => item.name === 'SmartSelect.exe')
      if (!helper) return null
      try {
        const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          `Get-Process -Id ${helper.pid} -ErrorAction Stop | Select-Object Id,WorkingSet64,PrivateMemorySize64,CPU,HandleCount | ConvertTo-Json -Compress`
        ], { encoding: 'utf8', windowsHide: true, timeout: 15000 }).trim()
        if (!output) return null
        const proc = JSON.parse(output)
        return {
          pid: Number(proc.Id),
          workingSetMiB: round(Number(proc.WorkingSet64) / 1048576, 1),
          privateMiB: round(Number(proc.PrivateMemorySize64) / 1048576, 1),
          cpuSeconds: round(proc.CPU, 2),
          handles: Number(proc.HandleCount) || 0
        }
      } catch { return null }
    }

    function captureMemory() {
      return { appMetrics: aggregateMetrics(), sidecars: sidecars() }
    }

    state.captureMemory = captureMemory
    state.aggregateMetrics = aggregateMetrics
    state.sidecars = sidecars
    state.hoverMode = !!config.hoverMode

    app.on('browser-window-created', (_event, win) => {
      const entry = { createdAt: Date.now(), marks: {}, isCapture: false, closed: false }
      try {
        win.webContents.on('dom-ready', () => { if (!entry.marks.domReady) entry.marks.domReady = Date.now() })
        win.webContents.on('did-finish-load', () => {
          const url = win.webContents.getURL()
          if (url.includes('/capture/capture.html')) {
            entry.isCapture = true
            if (!entry.marks.didFinishLoad) entry.marks.didFinishLoad = Date.now()
            state.current = entry
          }
        })
        win.webContents.on('ipc-message', (_event, channel) => {
          if (!entry.isCapture) return
          if (!entry.marks[channel]) entry.marks[channel] = Date.now()
          if (channel === 'capture:render-ready') {
            entry.readyMemory = captureMemory()
            const delay = state.hoverMode ? 20000 : state.closeDelayMs
            setTimeout(() => {
              try { if (!win.isDestroyed()) win.close() } catch {}
            }, delay)
          }
        })
        win.on('closed', () => {
          entry.closed = true
          entry.marks.closed = Date.now()
          if (entry.isCapture) state.samples.push(entry)
          if (state.current === entry) state.current = null
        })
      } catch (error) {
        entry.observerError = String(error?.message || error)
      }
    })
    return { pid: process.pid, display: (() => {
      const primary = screen.getPrimaryDisplay()
      const secondary = screen.getAllDisplays().find((item) => item.id !== primary.id) || primary
      return { id: secondary.id, bounds: secondary.bounds, scaleFactor: secondary.scaleFactor, primaryId: primary.id }
    })() }
  }
}

async function installObserver(electronApp, hoverMode) {
  return electronApp.evaluate(buildObserverInstaller(OPTIONS), { closeDelayMs: OPTIONS.closeDelayMs, hoverMode })
}

async function readProbeState(electronApp) {
  return electronApp.evaluate(() => {
    const state = globalThis.__capturePipelineProbe
    return {
      sampleCount: state.samples.length,
      samples: state.samples
    }
  })
}

async function triggerCapture(mainWindow) {
  return mainWindow.evaluate(() => {
    const triggerAt = Date.now()
    try { window.electronAPI.executeFunction('screenshot', {}) } catch (error) { return { triggerAt, error: String(error && error.message ? error.message : error) } }
    return { triggerAt }
  })
}

async function waitForNewSample(electronApp, previousCount, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = await readProbeState(electronApp)
    if (state.sampleCount > previousCount) return state.samples[state.sampleCount - 1]
    await sleep(50)
  }
  return null
}

async function waitForRenderReady(electronApp, previousCount, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = await electronApp.evaluate(() => {
      const probe = globalThis.__capturePipelineProbe
      return {
        sampleCount: probe.samples.length,
        currentReady: !!(probe.current && probe.current.marks['capture:render-ready'])
      }
    })
    if (state.currentReady || state.sampleCount > previousCount) return true
    await sleep(20)
  }
  return false
}

async function closeCaptureWindows(electronApp) {
  await electronApp.evaluate(({ BrowserWindow }) => {
    for (const win of BrowserWindow.getAllWindows()) {
      const url = win.webContents.getURL()
      if (url.includes('/capture/capture.html')) { try { win.close() } catch {} }
    }
  })
}

async function hoverProbe(electronApp, display, samples) {
  // The first hover after init makes the renderer call captureAPI.smartSelectAt and
  // the main process runs session.query(). Measure that visible round trip from
  // inside the capture page (renderer harness, no product change).
  const existing = electronApp.windows().find((candidate) => candidate.url().includes('/capture/capture.html'))
  const page = existing || await electronApp.waitForEvent('window', {
    predicate: (candidate) => candidate.url().includes('/capture/capture.html'),
    timeout: 10000
  }).catch(() => null)
  const targetPage = page || electronApp.windows().find((candidate) => candidate.url().includes('/capture/capture.html'))
  if (!targetPage) return { error: 'capture page not observed' }
  const results = []
  const points = []
  for (let index = 0; index < samples; index += 1) {
    points.push({
      x: display.bounds.x + Math.round(display.bounds.width * (0.2 + 0.1 * index)),
      y: display.bounds.y + Math.round(display.bounds.height * 0.35)
    })
  }
  for (const point of points) {
    const result = await targetPage.evaluate(async ({ x, y }) => {
      const clientX = x - (window.screenX || 0)
      const clientY = y - (window.screenY || 0)
      const readState = () => {
        try {
          return {
            candidates: Array.isArray(smartCandidates) ? smartCandidates.length : -1,
            running: !!smartQueryRunning,
            pending: !!smartQueryPending
          }
        } catch { return { candidates: -2, running: false, pending: false } }
      }
      const before = readState()
      const started = performance.now()
      const target = document.getElementById('stage') || document.body
      target.dispatchEvent(new PointerEvent('pointermove', {
        clientX, clientY, bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, buttons: 0
      }))
      let sawRunning = false
      let completedAt = null
      const deadline = performance.now() + 2500
      while (performance.now() < deadline) {
        const state = readState()
        if (state.running) sawRunning = true
        else if (sawRunning) { completedAt = performance.now(); break }
        await new Promise((resolve) => setTimeout(resolve, 1))
      }
      return {
        elapsedMs: completedAt === null ? null : completedAt - started,
        totalPolledMs: performance.now() - started,
        sawQueryRunning: sawRunning,
        candidatesBefore: before.candidates,
        candidatesAfter: readState().candidates,
        hasSmartSelectFlag: (() => { try { return !!initData?.smartSelect } catch { return null } })(),
        selectState: (() => { try { return selectState } catch { return null } })()
      }
    }, point).catch((error) => ({ error: String(error?.message || error) }))
    results.push({ point, ...result })
  }
  return { points: results }
}

async function prewarmProbe(electronApp, display, iterations) {
  return electronApp.evaluate(async ({ app, BrowserWindow, nativeImage }, config) => {
    const results = []
    const aggregate = () => {
      const metrics = app.getAppMetrics()
      let workingSetMiB = 0
      let peakWorkingSetMiB = 0
      let privateMiB = 0
      let processCount = 0
      for (const metric of metrics) {
        const memory = metric?.memory || {}
        workingSetMiB += (Number(memory.workingSetSize) || 0) / 1024
        peakWorkingSetMiB += (Number(memory.peakWorkingSetSize) || 0) / 1024
        privateMiB += (Number(memory.privateBytes) || 0) / 1024
        processCount += 1
      }
      return { processCount, workingSetMiB, peakWorkingSetMiB, privateMiB }
    }
    for (let index = 0; index < config.iterations; index += 1) {
      const before = aggregate()
      const constructedAt = Date.now()
      const win = new BrowserWindow({
        show: false,
        opacity: 0,
        frame: false,
        x: config.display.bounds.x,
        y: config.display.bounds.y,
        width: 800,
        height: 600,
        webPreferences: {
          preload: config.preloadPath,
          backgroundThrottling: false,
          autoplayPolicy: 'no-user-gesture-required'
        }
      })
      const readyAt = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('capture:ready timeout')), 8000)
        win.webContents.on('ipc-message', (_event, channel) => {
          if (channel === 'capture:ready') { clearTimeout(timer); resolve(Date.now()) }
        })
        win.loadFile(config.pagePath).catch(reject)
      }).catch((error) => ({ error: String(error?.message || error) }))
      if (readyAt && readyAt.error) { if (!win.isDestroyed()) win.destroy(); results.push({ error: readyAt.error }); continue }
      const hiddenMemory = aggregate()
      const loadDoneAt = Date.now()
      const content = win.getContentBounds()
      const png = nativeImage.createFromBitmap(Buffer.alloc(32 * 32 * 4, 255), { width: 32, height: 32 }).toPNG()
      const init = {
        mode: 'region',
        imageBuffer: png,
        smartSelect: false,
        serialNumber: 1,
        displayBounds: content,
        captureBounds: content,
        scaleFactor: 1,
        settings: { screenshot: { shutterSound: false } }
      }
      // Mirror the domain's bookkeeping so the app's own render-ready handler is a
      // no-op for this probe window (it must not throw).
      win._captureInit = init
      win._captureRendererReady = true
      win._captureVisible = true
      const initAt = Date.now()
      const renderReadyAt = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('render-ready timeout')), 8000)
        win.webContents.on('ipc-message', (_event, channel) => {
          if (channel === 'capture:render-ready') { clearTimeout(timer); resolve(Date.now()) }
        })
        win.webContents.send('capture:init', init)
      }).catch((error) => ({ error: String(error?.message || error) }))
      const hidden = {
        constructToReadyMs: Number(readyAt) - constructedAt,
        initToRenderReadyMs: renderReadyAt && renderReadyAt.error ? null : Number(renderReadyAt) - initAt,
        constructToFirstOperableMs: renderReadyAt && renderReadyAt.error ? null : Number(renderReadyAt) - constructedAt,
        error: renderReadyAt && renderReadyAt.error ? renderReadyAt.error : null,
        memoryDeltaWhileLoaded: {
          processCount: hiddenMemory.processCount - before.processCount,
          workingSetMiB: Math.round((hiddenMemory.workingSetMiB - before.workingSetMiB) * 100) / 100,
          privateMiB: Math.round((hiddenMemory.privateMiB - before.privateMiB) * 100) / 100
        }
      }
      if (!win.isDestroyed()) win.destroy()
      await new Promise((resolve) => setTimeout(resolve, 250))
      const after = aggregate()
      hidden.memoryAfterDestroy = {
        processCount: after.processCount,
        workingSetMiB: Math.round(after.workingSetMiB * 100) / 100,
        privateMiB: Math.round(after.privateMiB * 100) / 100
      }
      results.push(hidden)
    }
    return results
  }, {
    root: ROOT,
    display,
    iterations,
    pagePath: path.join(ROOT, 'capture', 'capture.html'),
    preloadPath: path.join(ROOT, 'preload-capture.js')
  })
}

function startCpuSampler() {
  const os = require('node:os')
  let previous = os.cpus().map((cpu) => ({ idle: cpu.times.idle, total: Object.values(cpu.times).reduce((sum, value) => sum + value, 0) }))
  const samples = []
  const timer = setInterval(() => {
    const current = os.cpus().map((cpu) => ({ idle: cpu.times.idle, total: Object.values(cpu.times).reduce((sum, value) => sum + value, 0) }))
    let idleDelta = 0
    let totalDelta = 0
    for (let index = 0; index < current.length; index += 1) {
      idleDelta += current[index].idle - (previous[index]?.idle || 0)
      totalDelta += current[index].total - (previous[index]?.total || 0)
    }
    previous = current
    if (totalDelta > 0) samples.push({ t: Date.now(), cpuPct: round(100 * (1 - idleDelta / totalDelta), 1) })
    if (samples.length > 4000) samples.shift()
  }, 1000)
  timer.unref?.()
  return {
    stop() { clearInterval(timer); return samples }
  }
}

function summarizeCpuSamples(samples, windowStart, windowEnd) {
  const values = samples.filter((sample) => sample.t >= windowStart && sample.t <= windowEnd).map((sample) => sample.cpuPct)
  if (!values.length) return null
  return { n: values.length, avgCpuPct: round(values.reduce((sum, value) => sum + value, 0) / values.length, 1), maxCpuPct: round(Math.max(...values), 1) }
}
async function main() {
  fs.mkdirSync(BASE, { recursive: true })
  const data = prepareDataRoot()
  const displays = displayInfo()
  const primary = displays.find((item) => Boolean(item.primary)) || displays[0]
  const secondary = displays.find((item) => !Boolean(item.primary)) || primary
  const secondaryBounds = secondary ? { x: secondary.x, y: secondary.y, width: secondary.width, height: secondary.height } : null
  const cursorBefore = cursorPosition()
  if (secondaryBounds) setCursorPosition(secondaryBounds.x + Math.round(secondaryBounds.width / 2), secondaryBounds.y + Math.round(secondaryBounds.height * 0.4))

  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.HIGHLIGHTER_E2E
  delete env.HIGHLIGHTER_E2E_DATA_ROOT
  delete env.HIGHLIGHTER_E2E_FAKE_EVERYTHING
  delete env.HIGHLIGHTER_E2E_FAKE_DEVICE_BATTERY
  env.PORTABLE_EXECUTABLE_DIR = data.portable
  env.TMP = path.join(BASE, 'tmp')
  env.TEMP = env.TMP
  fs.mkdirSync(env.TMP, { recursive: true })

  const { _electron: electron } = require('playwright')
  const startedAt = new Date().toISOString()
  const electronApp = await electron.launch({
    executablePath: require('electron'),
    args: ['--no-sandbox', ROOT],
    cwd: ROOT,
    env,
    artifactsDir: path.join(BASE, 'artifacts'),
    timeout: 120000
  })
  const mainPid = electronApp.process().pid
  const cpuSampler = startCpuSampler()
  const treePsPath = writeTreeCollector()
  let watcher = null
  try { watcher = startSidecarWatcher() } catch {}
  const report = {
    schema: 1,
    kind: 'capture-pipeline',
    startedAt,
    mainPid,
    options: OPTIONS,
    host: {
      platform: process.platform,
      node: process.version,
      cpus: require('node:os').cpus().length
    },
    displays,
    dataRoot: data.dataRoot,
    secondaryDisplay: secondary || null,
    secondaryBounds,
    cursorBefore,
    phases: {},
    samples: [],
    errors: [],
    logs: []
  }

  let mainWindow = null
  try {
    mainWindow = electronApp.windows().find((candidate) => candidate.url().includes('/config/config.html'))
    if (!mainWindow) {
      mainWindow = await electronApp.waitForEvent('window', {
        predicate: (candidate) => candidate.url().includes('/config/config.html'),
        timeout: 60000
      })
    }
    await mainWindow.locator('.window-shell').waitFor({ state: 'visible', timeout: 60000 })
    report.logs.push('main window visible')

    const info = await installObserver(electronApp, OPTIONS.hoverSamples > 0)
    report.observerPid = info.pid
    report.observerDisplay = info.display
    const cursorTarget = await resolveCursorTarget(electronApp)
    report.cursorTarget = cursorTarget
    report.cursorParking = await parkCursorOnSecondary(electronApp, cursorTarget)

    // Park the main window on the secondary display and hide it: the probe never
    // touches the user's primary display.
    await electronApp.evaluate(({ BrowserWindow, screen }) => {
      const primary = screen.getPrimaryDisplay()
      const secondary = screen.getAllDisplays().find((item) => item.id !== primary.id) || primary
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.webContents.getURL().includes('/config/config.html')) {
          win.setPosition(secondary.bounds.x, secondary.bounds.y)
          win.hide()
        }
      }
    })
    await sleep(500)
    report.phases.baseline = {
      appMetrics: await electronApp.evaluate(() => globalThis.__capturePipelineProbe.aggregateMetrics()),
      processTree: collectProcessTree(mainPid, treePsPath)
    }
    report.logs.push(`baseline app metrics: ${JSON.stringify(report.phases.baseline.appMetrics)}`)

    // A visible probe target on the secondary display so the SmartSelect query has
    // a real window to hit; probe-only, closed at the end.
    let targetWindow = null
    if (OPTIONS.hoverSamples > 0 && secondaryBounds) {
      targetWindow = await electronApp.evaluate(({ BrowserWindow }, display) => {
        const win = new BrowserWindow({
          x: display.bounds.x + 80,
          y: display.bounds.y + Math.round(display.bounds.height * 0.3),
          width: 520,
          height: 360,
          show: true,
          frame: true,
          title: 'HL Dev03 Target Window',
          skipTaskbar: true,
          webPreferences: { contextIsolation: false, nodeIntegration: false }
        })
        return win.id
      }, { bounds: secondaryBounds })
    }

    // The product log is appended synchronously by the app logger. Start reading at
    // the current end so startup entries are not attributed to a capture.
    const logState = { offset: 0 }
    {
      const initial = readLogEntries(data.logFile, 0)
      logState.offset = initial.offset
    }

    // Warm-up capture before the idle hold: the first screenshot of a fresh TMP
    // root makes the native screenshot helper compile its C# helper once (~500 ms).
    // That is a first-install cost, not the per-hotkey cost this experiment is
    // about, so it is paid and discarded here.
    if (OPTIONS.warmupCapture) {
      const park = cursorTarget ? await parkCursorOnSecondary(electronApp, cursorTarget) : null
      const before = await readProbeState(electronApp)
      const trigger = await triggerCapture(mainWindow)
      const warm = trigger && !trigger.error ? await waitForNewSample(electronApp, before.sampleCount, OPTIONS.timeoutMs) : null
      const warmRead = readLogEntries(data.logFile, logState.offset)
      logState.offset = warmRead.offset
      const warmPerf = warmRead.entries
        .filter((entry) => entry && entry.event === 'performance' && entry.details && String(entry.details.name || '').startsWith('capture.'))
        .map((entry) => ({ name: entry.details.name, durationMs: entry.details.durationMs, ...entry.details }))
      report.phases.warmup = {
        firstOperableMs: warm ? warm.marks['capture:render-ready'] - trigger.triggerAt : null,
        productPerf: warmPerf
      }
      await electronApp.evaluate(() => { globalThis.__capturePipelineProbe.samples.length = 0 })
      report.logs.push(`warm-up capture discarded (firstOperable=${report.phases.warmup.firstOperableMs}ms)`)
      await sleep(800)
    }

    const idleSeconds = OPTIONS.smoke ? 3 : OPTIONS.idleSeconds
    if (idleSeconds > 0) {
      report.logs.push(`idle hold ${idleSeconds}s before first capture`)
      const idleStarted = Date.now()
      const idleSamples = []
      while (Date.now() - idleStarted < idleSeconds * 1000) {
        const waitMs = Math.min(60000, idleSeconds * 1000 - (Date.now() - idleStarted))
        await sleep(waitMs)
        const metrics = await electronApp.evaluate(() => globalThis.__capturePipelineProbe.aggregateMetrics())
        idleSamples.push({ elapsedMs: Date.now() - idleStarted, appMetrics: metrics })
      }
      report.idleWindow = { start: idleStarted, end: Date.now() }
      report.phases.idle = {
        requestedSeconds: idleSeconds,
        measuredSeconds: round((Date.now() - idleStarted) / 1000, 1),
        samples: idleSamples,
        processTree: collectProcessTree(mainPid, treePsPath)
      }
    }

    // ---- capture samples ----
    let logEntries = []
    const sampleCount = OPTIONS.smoke ? 2 : OPTIONS.samples
    for (let index = 0; index < sampleCount; index += 1) {
      const hoverEnabled = index === 0 && OPTIONS.hoverSamples > 0
      await electronApp.evaluate((_electron, hover) => { globalThis.__capturePipelineProbe.hoverMode = hover }, hoverEnabled)
      const park = cursorTarget ? await parkCursorOnSecondary(electronApp, cursorTarget) : null
      const before = await readProbeState(electronApp)
      const trigger = await triggerCapture(mainWindow)
      if (trigger && trigger.error) {
        report.errors.push(`trigger failed: ${trigger.error}`)
        break
      }
      let hover = null
      if (hoverEnabled) {
        // Keep the window alive briefly so the hover round-trip can be measured
        // from inside the real capture renderer, then close it from here.
        const ready = await waitForRenderReady(electronApp, before.sampleCount, OPTIONS.timeoutMs)
        if (!ready) report.errors.push(`sample ${index}: render-ready not observed`)
        hover = await hoverProbe(electronApp, { bounds: secondaryBounds }, OPTIONS.hoverSamples)
        await closeCaptureWindows(electronApp)
      }
      const sample = await waitForNewSample(electronApp, before.sampleCount, OPTIONS.timeoutMs)
      if (!sample) {
        report.errors.push(`sample ${index} timed out`)
        break
      }
      const read = readLogEntries(data.logFile, logState.offset)
      logState.offset = read.offset
      logEntries.push(...read.entries)
      const perfEntries = read.entries
        .filter((entry) => entry && entry.event === 'performance' && entry.details && String(entry.details.name || '').startsWith('capture.'))
        .map((entry) => ({ name: entry.details.name, durationMs: entry.details.durationMs, ...entry.details }))
      const captureFrame = perfEntries.find((entry) => entry.name === 'capture.acquired') || {}
      const expectedDisplay = secondaryBounds || null
      const capturedExpectedDisplay = Boolean(expectedDisplay && captureFrame.width === expectedDisplay.width && captureFrame.height === expectedDisplay.height)
      const derived = {
        index,
        park,
        captureFrame: { width: captureFrame.width ?? null, height: captureFrame.height ?? null, scaleFactor: captureFrame.scaleFactor ?? null, backend: captureFrame.backend ?? null },
        expectedDisplay,
        capturedExpectedDisplay,
        cold: index === 0,
        triggerAt: trigger.triggerAt,
        closedAt: sample.marks.closed || null,
        windowCreatedMs: sample.createdAt - trigger.triggerAt,
        domReadyMs: sample.marks.domReady ? sample.marks.domReady - trigger.triggerAt : null,
        didFinishLoadMs: sample.marks.didFinishLoad ? sample.marks.didFinishLoad - trigger.triggerAt : null,
        rendererReadyMs: sample.marks['capture:ready'] ? sample.marks['capture:ready'] - trigger.triggerAt : null,
        firstOperableMs: sample.marks['capture:render-ready'] ? sample.marks['capture:render-ready'] - trigger.triggerAt : null,
        closedMs: sample.marks.closed ? sample.marks.closed - trigger.triggerAt : null,
        readyMemory: sample.readyMemory || null,
        productPerf: perfEntries,
        hover
      }
      report.samples.push(derived)
      const productTotal = (perfEntries.find((entry) => entry.name === 'capture.interactive') || {}).durationMs ?? null
      report.logs.push(`sample ${index}: firstOperable=${derived.firstOperableMs}ms productInteractive=${productTotal}ms captureMs=${(perfEntries.find((entry) => entry.name === 'capture.acquired') || {}).durationMs ?? 'n/a'} smartSelectMs=${(perfEntries.find((entry) => entry.name === 'capture.interactive') || {}).smartSelectMs ?? 'n/a'}`)
      await sleep(OPTIONS.gapMs)
    }

    // ---- steady state after the sample loop ----
    await sleep(1000)
    report.phases.afterSamples = {
      appMetrics: await electronApp.evaluate(() => globalThis.__capturePipelineProbe.aggregateMetrics()),
      processTree: collectProcessTree(mainPid, treePsPath)
    }

    // ---- hidden pre-warm window simulation ----
    if (!OPTIONS.smoke && OPTIONS.prewarmIterations > 0) {
      try {
        report.phases.prewarm = await prewarmProbe(electronApp, { bounds: secondaryBounds }, OPTIONS.prewarmIterations)
      } catch (error) {
        report.errors.push(`prewarm probe failed: ${String(error?.message || error)}`)
      }
      await sleep(500)
      report.phases.afterPrewarm = {
        appMetrics: await electronApp.evaluate(() => globalThis.__capturePipelineProbe.aggregateMetrics())
      }
    }

    if (targetWindow !== null) {
      await electronApp.evaluate(({ BrowserWindow }, id) => {
        const win = BrowserWindow.fromId(id)
        if (win && !win.isDestroyed()) win.destroy()
      }, targetWindow).catch(() => {})
    }

    // ---- summaries ----
    const cold = report.samples.filter((sample) => sample.cold)
    const hot = report.samples.filter((sample) => !sample.cold)
    const pick = (sample, section, key) => {
      if (section === 'derived') return sample[key]
      if (section === 'capture') return (sample.productPerf.find((entry) => entry.name === 'capture.acquired') || {}).durationMs
      if (section === 'interactive') return (sample.productPerf.find((entry) => entry.name === 'capture.interactive') || {}).durationMs
      if (section === 'smartselect') return (sample.productPerf.find((entry) => entry.name === 'capture.interactive') || {}).smartSelectMs
      if (section === 'windowload') return (sample.productPerf.find((entry) => entry.name === 'capture.interactive') || {}).windowLoadMs
      return null
    }
    const metricNames = [
      ['windowCreatedMs', 'derived', 'windowCreatedMs'],
      ['didFinishLoadMs', 'derived', 'didFinishLoadMs'],
      ['firstOperableMs', 'derived', 'firstOperableMs'],
      ['productCaptureMs', 'capture', 'captureMs'],
      ['productInteractiveMs', 'interactive', 'durationMs'],
      ['productSmartSelectMs', 'smartselect', 'smartSelectMs'],
      ['productWindowLoadMs', 'windowload', 'windowLoadMs']
    ]
    report.summary = { coldCount: cold.length, hotCount: hot.length, metrics: {} }
    for (const [label, section, fetchKey] of metricNames) {
      report.summary.metrics[label] = {
        cold: summarize(cold.map((sample) => pick(sample, section, fetchKey)).filter(Number.isFinite)),
        hot: summarize(hot.map((sample) => pick(sample, section, fetchKey)).filter(Number.isFinite))
      }
    }
    const readyMetrics = (samples) => samples.map((sample) => sample.readyMemory?.appMetrics).filter(Boolean)
    report.summary.memory = {
      ready: {
        processCount: summarize(readyMetrics(report.samples).map((entry) => entry.processCount)),
        workingSetMiB: summarize(readyMetrics(report.samples).map((entry) => entry.workingSetMiB)),
        privateMiB: summarize(readyMetrics(report.samples).map((entry) => entry.privateMiB)),
        peakWorkingSetMiB: summarize(readyMetrics(report.samples).map((entry) => entry.peakWorkingSetMiB))
      },
      helperAtReady: null
    }
    if (report.phases.prewarm) {
      const ok = report.phases.prewarm.filter((entry) => !entry.error)
      report.summary.prewarm = {
        n: ok.length,
        constructToReadyMs: summarize(ok.map((entry) => entry.constructToReadyMs)),
        initToRenderReadyMs: summarize(ok.map((entry) => entry.initToRenderReadyMs).filter(Number.isFinite)),
        constructToFirstOperableMs: summarize(ok.map((entry) => entry.constructToFirstOperableMs).filter(Number.isFinite)),
        memoryDeltaWhileLoaded: ok.length ? ok[ok.length - 1].memoryDeltaWhileLoaded : null
      }
    }
    report.ok = report.samples.length > 0 && cold.length > 0
  } catch (error) {
    report.error = error?.stack || String(error)
  } finally {
    try { await electronApp.close() } catch {}
    try { execFileSync('taskkill', ['/PID', String(mainPid), '/T', '/F'], { windowsHide: true, timeout: 15000 }) } catch {}
    if (cursorBefore) setCursorPosition(cursorBefore.x, cursorBefore.y)
    const cpuSamples = cpuSampler.stop()
    report.hostCpu = { samples: cpuSamples }
    if (report.idleWindow) report.hostCpu.idle = summarizeCpuSamples(cpuSamples, report.idleWindow.start, report.idleWindow.end)
    report.sampleCpu = report.samples.map((sample) => ({
      index: sample.index,
      cold: sample.cold,
      ...(summarizeCpuSamples(cpuSamples, sample.triggerAt, sample.closedAt) || {})
    }))
    if (report.samples.length) {
      const first = report.samples[0].triggerAt
      const last = report.samples[report.samples.length - 1].closedAt || Date.now()
      report.hostCpu.sampling = summarizeCpuSamples(cpuSamples, first, last)
    }
    let watcherRows = []
    try { watcherRows = await stopSidecarWatcher(watcher) } catch {}
    report.sidecarTimeline = summarizeSidecarRows(watcherRows)
    report.sampleSidecars = report.samples.map((sample) => {
      if (!sample.triggerAt || !sample.closedAt) return null
      const rows = rowsInWindow(watcherRows, sample.triggerAt, sample.closedAt)
      const smart = rows.filter((row) => String(row.name || '').toLowerCase() === 'smartselect')
      const cpuValues = smart.map((row) => Number(row.cpu)).filter(Number.isFinite)
      return {
        index: sample.index,
        cold: sample.cold,
        helperProcessCount: new Set(smart.map((row) => row.pid)).size,
        helperMaxPrivateMiB: smart.length ? round(Math.max(...smart.map((row) => Number(row.priv) || 0)) / 1048576, 1) : null,
        helperMaxWorkingSetMiB: smart.length ? round(Math.max(...smart.map((row) => Number(row.ws) || 0)) / 1048576, 1) : null,
        helperCpuSeconds: cpuValues.length > 1 ? round(Math.max(...cpuValues) - Math.min(...cpuValues), 3) : null,
        sidecarNames: [...new Set(rows.map((row) => String(row.name || '')))]
      }
    })
    if (report.idleWindow) {
      const idleRows = rowsInWindow(watcherRows, report.idleWindow.start, report.idleWindow.end)
      report.idleSidecars = {
        windowMs: report.idleWindow.end - report.idleWindow.start,
        sidecarTimeline: summarizeSidecarRows(idleRows),
        smartSelectObserved: idleRows.some((row) => String(row.name || '').toLowerCase() === 'smartselect')
      }
    }
    if (report.summary) {
      report.summary.memory.helperAtReady = report.sampleSidecars.filter((entry) => entry && entry.helperProcessCount > 0).length
    }
    report.finishedAt = new Date().toISOString()
    const outPath = path.resolve(OPTIONS.out)
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    console.log(`CAPTURE_PIPELINE_DONE ${outPath}`)
    if (report.summary) {
      for (const [label, entry] of Object.entries(report.summary.metrics)) {
        console.log(`${label}: cold p50=${entry.cold.p50Ms} p95=${entry.cold.p95Ms} (n=${entry.cold.n}); hot p50=${entry.hot.p50Ms} p95=${entry.hot.p95Ms} (n=${entry.hot.n})`)
      }
      if (report.summary.prewarm) console.log(`prewarm: constructToReady p50=${report.summary.prewarm.constructToReadyMs.p50Ms} p95=${report.summary.prewarm.constructToReadyMs.p95Ms}; initToRenderReady p50=${report.summary.prewarm.initToRenderReadyMs.p50Ms} p95=${report.summary.prewarm.initToRenderReadyMs.p95Ms}`)
      console.log(`memory at ready: private p95=${report.summary.memory.ready.privateMiB.p95Ms}MiB workingSet p95=${report.summary.memory.ready.workingSetMiB.p95Ms}MiB (n=${report.summary.memory.ready.privateMiB.n})`)
    }
    if (report.error) console.error(report.error)
  }
  process.exitCode = report.ok ? 0 : 1
}

if (require.main === module) {
  main().catch((error) => {
    console.error('measure-capture-pipeline failed:', error?.stack || error)
    process.exitCode = 1
  })
}






