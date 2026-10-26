#!/usr/bin/env node
'use strict'

// M0b: read-only external process sampler.
//
// `app.getAppMetrics()` only sees Electron's own process tree, so the native
// sidecars (clipboard / OCR / Everything / SmartSelect / ffmpeg) and the two
// Node utility processes are invisible to it. This script samples the whole
// Windows process table with PowerShell (`Get-CimInstance Win32_Process` for
// identity + memory, `Get-Process` for CPU), attributes every process to a role
// by executable name/path, and reports Working Set / Private / CPU per role.
//
// It is deliberately a separate, require-able module: requiring it performs no
// collection. Run it directly for the CLI:
//
//   node scripts/memory-snapshot.js --label tray-idle --samples 30 --interval 2000
//
// Safety: read-only. It never launches a window, never kills a process, and
// never writes outside the requested `--out` path (default `.tmp-memory/`,
// which is already gitignored).

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const DEFAULT_SAMPLES = 30
const DEFAULT_INTERVAL_MS = 2000
const DEFAULT_LABEL = 'snapshot'
const DEFAULT_OUT_DIR = '.tmp-memory'
const MIB = 1024 * 1024

// Canonical role order: also the Markdown table order.
const ROLE_ORDER = [
  'chromium',
  'ocr-sidecar',
  'clipboard-sidecar',
  'everything-sidecar',
  'everything-external',
  'smart-select',
  'ffmpeg',
  'selection-hook-utility',
  'usage-scan-utility',
  'other'
]

// Names we ask PowerShell for even when the app directory is unknown. Chromium
// children all share the Electron executable name, so one name covers
// main/gpu/renderer/utility.
const COLLECTIBLE_NAMES = [
  'Highlighter.exe',
  'electron.exe',
  'HighlighterOcrSidecar.exe',
  'HighlighterClipboard.exe',
  'HighlighterEverything.exe',
  'Everything.exe',
  'SmartSelect.exe',
  'ffmpeg.exe'
]

const SERVICE_NAMES = {
  'highlighter-usage-scan': 'usage-scan-utility',
  'highlighter-selection-hook': 'selection-hook-utility'
}

const USAGE = `Usage: node scripts/memory-snapshot.js [options]

  --label <name>        Report label (default: ${DEFAULT_LABEL})
  --samples <n>         Number of samples (default: ${DEFAULT_SAMPLES})
  --interval <ms>       Delay between samples in ms (default: ${DEFAULT_INTERVAL_MS})
  --app-dir <path>      App install directory; default: auto-detected running app
  --out <path>          Output JSON path (default: ${DEFAULT_OUT_DIR}/<label>-<ISO>.json)
  -h, --help            Show this help

Read-only: samples process memory only; launches no window and kills nothing.`

function round(value, digits) {
  const factor = 10 ** digits
  return Math.round((Number(value) || 0) * factor) / factor
}

function toText(value) {
  return typeof value === 'string' ? value : ''
}

function toLowerText(value) {
  return toText(value).toLowerCase()
}

function toWindowsPath(value) {
  return toText(value).replace(/\//g, '\\')
}

function baseNames(record) {
  const names = []
  for (const candidate of [record.name, record.Name, record.ProcessName, record.executablePath, record.ExecutablePath]) {
    const base = path.win32.basename(toWindowsPath(candidate)).toLowerCase()
    if (base && !names.includes(base)) names.push(base)
  }
  return names
}

function hasBase(names, stem) {
  return names.some((name) => name === `${stem}.exe` || name === stem)
}

function lowerPathOf(record) {
  return toWindowsPath(record.executablePath ?? record.ExecutablePath).toLowerCase()
}

/**
 * Attribute one process to a role using only its identity fields.
 *
 * `main` / `gpu` / `renderer` / `utility` are not distinguishable from the
 * executable name, so every Electron process is reported as `chromium`
 * (use `serviceName` / `commandLine` only to split out the two Node utilities).
 */
function classifyProcess(record = {}) {
  const names = baseNames(record)
  const executablePath = lowerPathOf(record)
  const signal = `${toLowerText(record.commandLine ?? record.CommandLine)}\n${toLowerText(record.serviceName ?? record.ServiceName)}`

  for (const [serviceName, role] of Object.entries(SERVICE_NAMES)) {
    if (signal.includes(serviceName)) return role
  }

  if (hasBase(names, 'highlighterocrsidecar') || executablePath.includes('\\native\\ocr\\')) return 'ocr-sidecar'
  if (hasBase(names, 'highlighterclipboard') || executablePath.includes('\\native\\clipboard\\')) return 'clipboard-sidecar'
  if (hasBase(names, 'highlightereverything') || executablePath.includes('\\native\\everything-search\\')) return 'everything-sidecar'
  if (
    hasBase(names, 'everything') ||
    executablePath.includes('\\native\\everything\\') ||
    executablePath.includes('\\runtime\\everything\\')
  ) {
    return 'everything-external'
  }
  if (hasBase(names, 'smartselect') || executablePath.includes('\\native\\smart-select\\')) return 'smart-select'
  if (hasBase(names, 'ffmpeg') || names.some((name) => name.startsWith('ffmpeg')) || executablePath.includes('\\ffmpeg\\')) {
    return 'ffmpeg'
  }
  if (hasBase(names, 'highlighter') || hasBase(names, 'electron')) return 'chromium'
  return 'other'
}

/**
 * Tolerate everything ConvertTo-Json can produce: nothing at all, a single
 * object (PowerShell unwraps one-element arrays), an array, a BOM, or garbage.
 * Invalid JSON yields an empty list rather than throwing: a failed sample must
 * not abort a measurement run.
 */
function parseProcessJson(stdout) {
  const text = toText(stdout).replace(/^\uFEFF/, '').trim()
  if (!text) return []
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  const items = Array.isArray(parsed) ? parsed : [parsed]
  return items.filter((item) => item && typeof item === 'object' && !Array.isArray(item))
}

function normalizeProcess(record) {
  if (!record || typeof record !== 'object') return null
  const pid = Number(record.ProcessId ?? record.pid ?? record.Id)
  if (!Number.isInteger(pid) || pid <= 0) return null

  const executablePath = toText(record.ExecutablePath ?? record.executablePath)
  const workingSetBytes = Number(record.WorkingSetSize ?? record.WorkingSet64 ?? 0) || 0
  // CIM's PageFileUsage is KiB (private commit); Get-Process exposes bytes.
  const pageFileUsageKb = record.PageFileUsage
  const privateBytes =
    pageFileUsageKb === null || pageFileUsageKb === undefined
      ? Number(record.PrivateMemorySize64 ?? 0) || 0
      : (Number(pageFileUsageKb) || 0) * 1024

  return {
    pid,
    parentPid: Number(record.ParentProcessId ?? record.ppid ?? 0) || null,
    role: classifyProcess(record),
    name: toText(record.Name ?? record.ProcessName) || path.win32.basename(executablePath) || 'unknown',
    executablePath,
    workingSetMiB: round(workingSetBytes / MIB, 1),
    privateMiB: round(privateBytes / MIB, 1),
    cpuSeconds: round(Number(record.CpuSeconds ?? record.CPU ?? 0) || 0, 2)
  }
}

function isInsideDirectory(candidatePath, directory) {
  const executable = toWindowsPath(candidatePath).toLowerCase()
  let root = toWindowsPath(directory).toLowerCase()
  if (!executable || !root) return false
  root = root.replace(/[\\]+$/, '')
  return executable === root || executable.startsWith(`${root}\\`)
}

function selectProcesses(records, { appDir = null, names = COLLECTIBLE_NAMES } = {}) {
  const whitelist = names.map((name) => name.toLowerCase())
  const selected = []
  for (const record of Array.isArray(records) ? records : []) {
    if (!record || typeof record !== 'object') continue
    const name = toLowerText(record.Name ?? record.ProcessName ?? path.win32.basename(toWindowsPath(record.ExecutablePath)))
    const insideAppDir = appDir ? isInsideDirectory(record.ExecutablePath, appDir) : false
    if (!insideAppDir && !whitelist.includes(name)) continue
    const normalized = normalizeProcess(record)
    if (normalized) selected.push(normalized)
  }
  return selected.sort((left, right) => left.pid - right.pid)
}

/**
 * Aggregate samples of `{ timestamp, processes: [{ role, workingSetMiB, privateMiB, cpuSeconds }] }`.
 *
 * `perRole[role].count` is the peak concurrent process count for that role;
 * memory and CPU are the per-sample sum averaged over all samples. `total`
 * mirrors perRole for the whole process set (peak count, average sums).
 */
function summarizeSamples(samples = []) {
  const list = (Array.isArray(samples) ? samples : []).filter(
    (sample) => sample && typeof sample === 'object' && !Array.isArray(sample)
  )
  const empty = {
    sampleCount: 0,
    first: null,
    last: null,
    perRole: {},
    total: { processCount: 0, workingSetMiB: 0, privateMiB: 0, cpu: 0 }
  }
  if (!list.length) return empty

  const totalsByRole = new Map()
  let workingSetSum = 0
  let privateSum = 0
  let cpuSum = 0
  let peakProcessCount = 0

  for (const sample of list) {
    const processes = (Array.isArray(sample.processes) ? sample.processes : []).filter(
      (process) => process && typeof process === 'object'
    )
    peakProcessCount = Math.max(peakProcessCount, processes.length)

    const perSample = new Map()
    for (const process of processes) {
      const role = ROLE_ORDER.includes(process.role) ? process.role : 'other'
      const tally = perSample.get(role) || { count: 0, workingSetMiB: 0, privateMiB: 0, cpu: 0 }
      tally.count += 1
      tally.workingSetMiB += Number(process.workingSetMiB) || 0
      tally.privateMiB += Number(process.privateMiB) || 0
      tally.cpu += Number(process.cpuSeconds) || 0
      perSample.set(role, tally)
    }

    for (const [role, tally] of perSample) {
      const accumulated = totalsByRole.get(role) || { count: 0, workingSetMiB: 0, privateMiB: 0, cpu: 0 }
      accumulated.count = Math.max(accumulated.count, tally.count)
      accumulated.workingSetMiB += tally.workingSetMiB
      accumulated.privateMiB += tally.privateMiB
      accumulated.cpu += tally.cpu
      totalsByRole.set(role, accumulated)
      workingSetSum += tally.workingSetMiB
      privateSum += tally.privateMiB
      cpuSum += tally.cpu
    }
  }

  const perRole = {}
  for (const role of ROLE_ORDER) {
    const accumulated = totalsByRole.get(role)
    if (!accumulated) continue
    perRole[role] = {
      count: accumulated.count,
      workingSetMiB: round(accumulated.workingSetMiB / list.length, 1),
      privateMiB: round(accumulated.privateMiB / list.length, 1),
      cpu: round(accumulated.cpu / list.length, 2)
    }
  }

  return {
    sampleCount: list.length,
    first: list[0].timestamp ?? null,
    last: list[list.length - 1].timestamp ?? null,
    perRole,
    total: {
      processCount: peakProcessCount,
      workingSetMiB: round(workingSetSum / list.length, 1),
      privateMiB: round(privateSum / list.length, 1),
      cpu: round(cpuSum / list.length, 2)
    }
  }
}

function formatReport(summary, meta = {}) {
  const roleEntries = ROLE_ORDER.filter((role) => summary.perRole[role])
  const lines = [
    `## 内存快照：${meta.label || DEFAULT_LABEL}`,
    '',
    `- 平台：${meta.platform || process.platform}`,
    `- 应用目录：${meta.appDir || '（未探测到，仅按进程名白名单采样）'}`,
    `- 生成时间：${meta.generatedAt || ''}`,
    `- 样本：${summary.sampleCount}/${meta.requestedSamples ?? summary.sampleCount}，采集失败 ${meta.failureCount || 0} 次`,
    '',
    '| 角色 | 进程数(峰值) | Working Set (MiB, 均值) | Private (MiB, 均值) | CPU (s, 均值) |',
    '| --- | ---: | ---: | ---: | ---: |'
  ]

  if (!roleEntries.length) {
    lines.push('| （无匹配进程） | 0 | 0.0 | 0.0 | 0.00 |')
  }
  for (const role of roleEntries) {
    const entry = summary.perRole[role]
    lines.push(`| ${role} | ${entry.count} | ${entry.workingSetMiB.toFixed(1)} | ${entry.privateMiB.toFixed(1)} | ${entry.cpu.toFixed(2)} |`)
  }
  lines.push(
    `| **合计** | ${summary.total.processCount} | ${summary.total.workingSetMiB.toFixed(1)} | ${summary.total.privateMiB.toFixed(1)} | ${summary.total.cpu.toFixed(2)} |`
  )
  return lines.join('\n')
}

function parseArgs(argv = []) {
  const options = {
    label: DEFAULT_LABEL,
    samples: DEFAULT_SAMPLES,
    interval: DEFAULT_INTERVAL_MS,
    appDir: null,
    out: null,
    help: false
  }

  const readValue = (flag, inline, index) => {
    if (inline !== null) return { value: inline, next: index }
    const candidate = argv[index + 1]
    if (candidate === undefined || candidate.startsWith('--')) throw new Error(`${flag} 缺少参数值`)
    return { value: candidate, next: index + 1 }
  }

  for (let index = 0; index < argv.length; index++) {
    const raw = String(argv[index])
    if (raw === '-h' || raw === '--help') {
      options.help = true
      continue
    }
    const equalsIndex = raw.indexOf('=')
    const flag = equalsIndex >= 0 ? raw.slice(0, equalsIndex) : raw
    const inline = equalsIndex >= 0 ? raw.slice(equalsIndex + 1) : null

    switch (flag) {
      case '--label': {
        const read = readValue(flag, inline, index)
        index = read.next
        if (!read.value.trim()) throw new Error('--label 不能为空')
        options.label = read.value.trim()
        break
      }
      case '--samples': {
        const read = readValue(flag, inline, index)
        index = read.next
        const samples = Number(read.value)
        if (!Number.isInteger(samples) || samples < 1) throw new Error('--samples 必须是正整数')
        options.samples = samples
        break
      }
      case '--interval': {
        const read = readValue(flag, inline, index)
        index = read.next
        const interval = Number(read.value)
        if (!Number.isInteger(interval) || interval < 0) throw new Error('--interval 必须是非负整数（毫秒）')
        options.interval = interval
        break
      }
      case '--app-dir': {
        const read = readValue(flag, inline, index)
        index = read.next
        options.appDir = path.resolve(read.value)
        break
      }
      case '--out': {
        const read = readValue(flag, inline, index)
        index = read.next
        options.out = path.resolve(read.value)
        break
      }
      default:
        throw new Error(`未知参数：${raw}`)
    }
  }
  return options
}

function runPowerShell(command) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
    maxBuffer: 8 * MIB
  })
}

const UTF8_CONSOLE = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8'

function collectProcesses({ appDir = null, names = COLLECTIBLE_NAMES } = {}) {
  if (process.platform !== 'win32') return []
  const nameList = names.map((name) => `'${name.replace(/'/g, "''")}'`).join(', ')
  const appDirLiteral = toText(appDir).replace(/'/g, "''")
  const command = [
    UTF8_CONSOLE,
    `$names = @(${nameList})`,
    `$appDir = '${appDirLiteral}'`,
    '$items = Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,WorkingSetSize,PageFileUsage -ErrorAction Stop | Where-Object {',
    '  $_.Name -and ($names -contains $_.Name -or ($appDir -and $_.ExecutablePath -and $_.ExecutablePath.StartsWith($appDir, [System.StringComparison]::OrdinalIgnoreCase)))',
    '}',
    '$result = foreach ($item in $items) {',
    '  $cpu = 0',
    '  try { $process = Get-Process -Id $item.ProcessId -ErrorAction Stop; if ($null -ne $process.CPU) { $cpu = [double]$process.CPU } } catch {}',
    '  [pscustomobject]@{',
    '    ProcessId = $item.ProcessId; ParentProcessId = $item.ParentProcessId; Name = $item.Name',
    '    ExecutablePath = $item.ExecutablePath; CommandLine = $item.CommandLine',
    '    WorkingSetSize = $item.WorkingSetSize; PageFileUsage = $item.PageFileUsage; CpuSeconds = $cpu',
    '  }',
    '}',
    '$result | ConvertTo-Json -Compress -Depth 3'
  ].join('\n')
  return selectProcesses(parseProcessJson(runPowerShell(command)), { appDir, names })
}

function deriveAppDirFromElectronPath(executablePath) {
  const normalized = toWindowsPath(executablePath)
  if (/\\node_modules\\electron\\dist\\electron\.exe$/i.test(normalized)) {
    // <root>\node_modules\electron\dist\electron.exe -> <root>
    return path.win32.resolve(path.win32.dirname(normalized), '..', '..', '..')
  }
  if (/[\\/]electron\.exe$/i.test(normalized)) return path.win32.dirname(normalized)
  if (normalized) return path.win32.dirname(normalized)
  return null
}

function detectAppDir() {
  if (process.platform !== 'win32') return null
  const command = [
    UTF8_CONSOLE,
    "$items = Get-CimInstance Win32_Process -Property ProcessId,Name,ExecutablePath | Where-Object { $_.Name -eq 'Highlighter.exe' -or $_.Name -eq 'electron.exe' }",
    '$items | Select-Object Name,ExecutablePath | ConvertTo-Json -Compress'
  ].join('; ')
  let records
  try {
    records = parseProcessJson(runPowerShell(command))
  } catch {
    return null
  }
  const counts = new Map()
  for (const record of records) {
    const name = toLowerText(record.Name)
    const executablePath = toText(record.ExecutablePath)
    if (!executablePath) continue
    const directory = name === 'highlighter.exe' ? path.win32.dirname(executablePath) : deriveAppDirFromElectronPath(executablePath)
    if (!directory) continue
    const weight = name === 'highlighter.exe' ? 2 : 1
    const entry = counts.get(directory) || { weight: 0, directory }
    entry.weight += weight
    counts.set(directory, entry)
  }
  let best = null
  for (const entry of counts.values()) {
    if (!best || entry.weight > best.weight) best = entry
  }
  return best ? path.resolve(best.directory) : null
}

// The label ends up in a filename, so path separators and Windows-reserved
// characters are folded to '_': `--label ../../x` must not escape .tmp-memory.
function safeLabel(label) {
  const cleaned = String(label || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/^\.+$/, '').slice(0, 80)
  return cleaned || DEFAULT_LABEL
}

function defaultOutPath(label, now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  return path.resolve(DEFAULT_OUT_DIR, `${safeLabel(label)}-${stamp}.json`)
}

function sleepSync(milliseconds) {
  if (!(milliseconds > 0)) return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

function main(argv = process.argv.slice(2)) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    console.error(`memory-snapshot: ${error.message}`)
    console.error('')
    console.error(USAGE)
    return 1
  }
  if (options.help) {
    console.log(USAGE)
    return 0
  }
  if (process.platform !== 'win32') {
    console.log(`memory-snapshot: unsupported platform "${process.platform}" (Windows only)`)
    return 0
  }

  const appDir = options.appDir || detectAppDir() || path.resolve(__dirname, '..')
  const generatedAt = new Date().toISOString()
  const samples = []
  let failureCount = 0

  for (let index = 0; index < options.samples; index++) {
    const timestamp = new Date().toISOString()
    try {
      const processes = collectProcesses({ appDir })
      samples.push({ index, timestamp, processes })
      console.error(`memory-snapshot: sample ${index + 1}/${options.samples} -> ${processes.length} 个进程`)
    } catch (error) {
      failureCount += 1
      const message = error && error.message ? error.message : String(error)
      samples.push({ index, timestamp, processes: [], error: message })
      console.error(`memory-snapshot: sample ${index + 1}/${options.samples} 采集失败：${message}`)
    }
    if (index < options.samples - 1) sleepSync(options.interval)
  }

  const summary = summarizeSamples(samples)
  const outPath = options.out || defaultOutPath(options.label)
  const payload = {
    label: options.label,
    generatedAt,
    platform: process.platform,
    appDir,
    requestedSamples: options.samples,
    intervalMs: options.interval,
    failureCount,
    summary,
    samples
  }

  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  } catch (error) {
    console.error(`memory-snapshot: 写入 ${outPath} 失败：${error.message}`)
    return 1
  }

  console.log(
    formatReport(summary, {
      label: options.label,
      platform: process.platform,
      appDir,
      generatedAt,
      requestedSamples: options.samples,
      failureCount
    })
  )
  console.log('')
  console.log(`JSON: ${outPath}`)
  return 0
}

module.exports = {
  ROLE_ORDER,
  COLLECTIBLE_NAMES,
  DEFAULT_LABEL,
  DEFAULT_SAMPLES,
  DEFAULT_INTERVAL_MS,
  deriveAppDirFromElectronPath,
  classifyProcess,
  parseProcessJson,
  normalizeProcess,
  selectProcesses,
  summarizeSamples,
  formatReport,
  parseArgs,
  collectProcesses,
  detectAppDir,
  defaultOutPath,
  main
}

if (require.main === module) {
  process.exitCode = main()
}
