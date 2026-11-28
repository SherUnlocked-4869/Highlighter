#!/usr/bin/env node
'use strict'

// E01 deliverable: the repeatable isolated performance gate.
//
// Why this exists
// ---------------
// `test/usage-query.test.js` measures CPU-bound SQLite throughput. In the full
// `npm test` run (node --test with file-level parallelism) the host can be
// oversubscribed ~10-20x, so the measured p95 reflects CPU starvation rather
// than the query planner. Measured on this host 2026-11-28: solo low-load runs
// pass with large margins (summary p95 39-53 ms against a 100 ms budget), while
// 16 saturated CPU hogs push the same test to a summary p95 of 169 ms and a
// dense-heatmap p95 of 418 ms - a failure with no source change in between.
//
// This gate runs the timing-sensitive files one at a time, with no other test
// file in flight, so the numbers it publishes are a property of the code instead
// of the runner load. It does not replace or weaken the assertions: `npm test`
// keeps running the same files with the same budgets; this script is an extra,
// serial, repeatable entry point that CI can run as its own step.
//
// Usage
//   node scripts/run-perf-gate.js                       # usage-query + capture-first-paint
//   node scripts/run-perf-gate.js --repeat 3            # repeat each file 3x
//   node scripts/run-perf-gate.js --include-flake-check # also run clipboard-coordination x2
//   node scripts/run-perf-gate.js --sandbox-hook <abs path to no-sandbox spawn hook>
//   node scripts/run-perf-gate.js --files test/usage-query.test.js
//   node scripts/run-perf-gate.js --out .tmp-perf/gate.json --json-only
//
// Exit code: 0 all selected files passed, 1 any failure, 2 usage/setup error.
// Machine-readable result: the final `PERF_GATE_RESULT=<json>` line.

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const DEFAULT_FILES = ['test/usage-query.test.js', 'test/capture-first-paint.test.js']
const FLAKE_FILES = ['test/clipboard-coordination.test.js']

function parseArgs(argv) {
  const options = {
    files: [],
    repeat: 1,
    includeFlakeCheck: false,
    sandboxHook: process.env.HIGHLIGHTER_PERF_SANDBOX_HOOK || '',
    tmpRoot: path.join(ROOT, '.tmp-perf'),
    out: '',
    jsonOnly: false,
    timeoutMs: 300000
  }
  for (let index = 0; index < argv.length; index += 1) {
    const raw = String(argv[index])
    const flag = raw.startsWith('--') && raw.includes('=') ? raw.slice(0, raw.indexOf('=')) : raw
    const inline = raw.startsWith('--') && raw.includes('=') ? raw.slice(raw.indexOf('=') + 1) : null
    const readValue = () => {
      if (inline !== null) return inline
      const next = argv[index + 1]
      if (next === undefined || String(next).startsWith('--')) throw new Error(`${flag} needs a value`)
      index += 1
      return String(next)
    }
    switch (flag) {
      case '--files':
        options.files.push(...readValue().split(',').map((item) => item.trim()).filter(Boolean))
        break
      case '--repeat':
        options.repeat = Math.max(1, Number(readValue()) || 1)
        break
      case '--include-flake-check':
        options.includeFlakeCheck = true
        break
      case '--sandbox-hook':
        options.sandboxHook = path.resolve(readValue())
        break
      case '--tmp-root':
        options.tmpRoot = path.resolve(readValue())
        break
      case '--out':
        options.out = path.resolve(readValue())
        break
      case '--json-only':
        options.jsonOnly = true
        break
      case '--timeout-ms':
        options.timeoutMs = Math.max(1000, Number(readValue()) || options.timeoutMs)
        break
      case '-h':
      case '--help':
        options.help = true
        break
      default:
        throw new Error(`unknown argument: ${raw}`)
    }
  }
  return options
}

function percentile(values, p) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
  if (!sorted.length) return null
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}

// The usage-query test prints one p95 map for the 100k synthetic store and one
// line for the dense/plan/sparse heatmap fixtures. Parse both so the gate report
// carries the actual numbers, not just pass/fail.
function parseUsageMetrics(output) {
  const metrics = { usageQuery: null, heatmap: null }
  const usageMatch = output.match(/\[usage-query perf\] rows=(\d+) insert=([\d.]+)ms p95\(ms\)=(\{[^\n]*\})/)
  if (usageMatch) {
    let p95 = null
    try { p95 = JSON.parse(usageMatch[3]) } catch {}
    metrics.usageQuery = { rows: Number(usageMatch[1]), insertMs: Number(usageMatch[2]), p95Ms: p95 }
  }
  const heatmapMatch = output.match(/\[usage-heatmap perf\] ([^\n]+)/)
  if (heatmapMatch) {
    const line = heatmapMatch[1]
    const pick = (pattern) => {
      const match = line.match(pattern)
      return match ? Number(match[1]) : null
    }
    metrics.heatmap = {
      dense262kColdMs: pick(/dense262k cold=([\d.]+)ms?/),
      dense262kP50Ms: pick(/dense262k cold=[\d.]+ms? uncached p50=([\d.]+)/),
      dense262kP95Ms: pick(/dense262k cold=[\d.]+ms? uncached p50=[\d.]+ p95=([\d.]+)/),
      dense262kMaxMs: pick(/dense262k cold=[\d.]+ms? uncached p50=[\d.]+ p95=[\d.]+ max=([\d.]+)/),
      dense262kCachedP95Ms: pick(/cached p95=([\d.]+)/),
      plan88kColdMs: pick(/plan88k cold=([\d.]+)/),
      plan88kP50Ms: pick(/plan88k cold=[\d.]+ p50=([\d.]+)/),
      plan88kP95Ms: pick(/plan88k cold=[\d.]+ p50=[\d.]+ p95=([\d.]+)/),
      sparse5kColdMs: pick(/sparse5k cold=([\d.]+)/),
      sparse5kP95Ms: pick(/sparse5k cold=[\d.]+ p95=([\d.]+)/)
    }
  }
  return metrics
}

function parseTapCounts(output) {
  const pick = (name) => {
    const match = output.match(new RegExp(`^(?:#|ℹ) ${name} (\\d+)$`, 'm'))
    return match ? Number(match[1]) : null
  }
  return {
    tests: pick('tests'),
    pass: pick('pass'),
    fail: pick('fail'),
    cancelled: pick('cancelled'),
    testsFailed: (output.match(/(?:^not ok |^✖ )/gm) || []).length -
      // A summary line such as "✖ failing tests:" is not a failure count.
      (output.match(/^✖ failing tests:/gm) || []).length
  }
}

function firstFailureLine(output) {
  const line = output.split('\n').find((item) => /^\s*(not ok|✖)/.test(item) || /AssertionError/.test(item))
  return line ? line.trim().slice(0, 300) : ''
}

function prepareEnvironment(options) {
  // AGENTS.md: this host cannot start Chromium's sandbox, and direct Electron
  // probes are spawned as `<electron> <script>`; a spawn hook can insert
  // --no-sandbox. Everything else stays exactly what a developer shell had.
  const tmp = path.join(options.tmpRoot, 'tmp')
  const dataRootBase = path.join(options.tmpRoot, 'data-root')
  fs.mkdirSync(tmp, { recursive: true })
  fs.mkdirSync(dataRootBase, { recursive: true })
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  env.TMP = tmp
  env.TEMP = tmp
  env.HIGHLIGHTER_E2E_DATA_ROOT_BASE = dataRootBase
  if (options.sandboxHook) {
    if (!fs.existsSync(options.sandboxHook)) throw new Error(`sandbox hook not found: ${options.sandboxHook}`)
    // NODE_OPTIONS mangles Windows backslashes; forward slashes resolve fine on win32.
    const hookPath = options.sandboxHook.replace(/\\/g, '/')
    const requireFlag = `--require "${hookPath}"`
    env.NODE_OPTIONS = env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ${requireFlag}` : requireFlag
  }
  return env
}

function runFile(file, env, timeoutMs) {
  const absolute = path.resolve(ROOT, file)
  const startedAt = Date.now()
  const result = spawnSync(process.execPath, ['--test', absolute], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024
  })
  const wallMs = Date.now() - startedAt
  const output = `${result.stdout || ''}\n${result.stderr || ''}`
  const tap = parseTapCounts(output)
  const passed = result.status === 0 && tap.pass !== null && (tap.fail === null || tap.fail === 0) && tap.testsFailed === 0
  return {
    file: path.relative(ROOT, absolute).replace(/\\/g, '/'),
    passed,
    exitCode: result.status,
    signal: result.signal || null,
    timedOut: result.error?.code === 'ETIMEDOUT',
    wallMs,
    tap,
    failure: passed ? '' : firstFailureLine(output),
    usage: parseUsageMetrics(output),
    output,
    error: result.error ? String(result.error.message || result.error) : ''
  }
}

function main(argv = process.argv.slice(2)) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    console.error(`run-perf-gate: ${error.message}`)
    return 2
  }
  if (options.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 40).join('\n').replace(/^\/\/ ?/gm, ''))
    return 0
  }
  if (options.includeFlakeCheck) options.files.push(...FLAKE_FILES)
  const files = options.files.length ? options.files : DEFAULT_FILES
  for (const file of files) {
    if (!fs.existsSync(path.resolve(ROOT, file))) {
      console.error(`run-perf-gate: missing test file: ${file}`)
      return 2
    }
  }
  let env
  try {
    env = prepareEnvironment(options)
  } catch (error) {
    console.error(`run-perf-gate: ${error.message}`)
    return 2
  }

  const startedAt = new Date().toISOString()
  const attempts = []
  for (let repetition = 1; repetition <= options.repeat; repetition += 1) {
    for (const file of files) {
      const label = options.repeat > 1 ? `${file} #${repetition}` : file
      if (!options.jsonOnly) process.stdout.write(`perf gate: running ${label} ... `)
      const result = runFile(file, env, options.timeoutMs)
      const entry = { repetition, ...result }
      delete entry.output
      attempts.push(entry)
      if (!options.jsonOnly) {
        const numbers = result.usage.usageQuery ? ` summary p95=${result.usage.usageQuery.p95Ms?.summary}ms` : ''
        process.stdout.write(`${result.passed ? 'PASS' : 'FAIL'} ${result.wallMs}ms${numbers}\n`)
      }
      if (result.error) attempts[attempts.length - 1].error = result.error
    }
  }

  const failed = attempts.filter((attempt) => !attempt.passed)
  const summary = {
    schemaVersion: 1,
    kind: 'highlighter-perf-gate',
    startedAt,
    finishedAt: new Date().toISOString(),
    host: {
      platform: process.platform,
      node: process.version,
      cpuCount: os.cpus().length,
      totalMemoryMiB: Math.round(os.totalmem() / 1048576)
    },
    env: {
      tmpRoot: options.tmpRoot,
      sandboxHook: options.sandboxHook || null,
      electronRunAsNodeCleared: true
    },
    ok: failed.length === 0,
    files: files.map((file) => ({
      file,
      attempts: attempts.filter((attempt) => attempt.file === path.relative(ROOT, path.resolve(ROOT, file)).replace(/\\/g, '/'))
    })),
    failures: failed.map((attempt) => ({ file: attempt.file, repetition: attempt.repetition, failure: attempt.failure, exitCode: attempt.exitCode, timedOut: attempt.timedOut }))
  }

  if (options.out) {
    fs.mkdirSync(path.dirname(options.out), { recursive: true })
    fs.writeFileSync(options.out, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  }
  if (!options.jsonOnly) {
    console.log('')
    console.log(`perf gate: ${summary.ok ? 'OK' : `${failed.length} failed`} (${attempts.length} run(s), ${options.repeat}x)${options.out ? ` -> ${options.out}` : ''}`)
  }
  process.stdout.write(`PERF_GATE_RESULT=${JSON.stringify(summary)}\n`)
  return summary.ok ? 0 : 1
}

if (require.main === module) {
  process.exitCode = main()
}

module.exports = { main, parseArgs, parseUsageMetrics, parseTapCounts, runFile, prepareEnvironment }
