'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { performance } = require('node:perf_hooks')
const { ProcessResourceSeries } = require('./lib/process-resource-series')

function parseArguments(args) {
  const values = new Map()
  const allowed = new Set(['--root-pid', '--duration-seconds', '--interval-ms', '--output', '--label'])
  for (let i = 0; i < args.length; i += 2) {
    if (!allowed.has(args[i]) || !args[i + 1] || values.has(args[i])) throw new Error(`Invalid argument: ${args[i]}`)
    values.set(args[i], args[i + 1])
  }
  const rootPid = Number(values.get('--root-pid'))
  const durationSeconds = Number(values.get('--duration-seconds') || 60)
  const intervalMs = Number(values.get('--interval-ms') || 5000)
  const output = values.get('--output')
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0) throw new Error('--root-pid must identify the app main process')
  if (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 86400) throw new Error('Duration must be 1..86400 seconds')
  if (!Number.isInteger(intervalMs) || intervalMs < 1000 || intervalMs > 60000) throw new Error('Interval must be 1000..60000 ms')
  if (!output) throw new Error('--output is required')
  return { rootPid, durationSeconds, intervalMs, output: path.resolve(output), label: values.get('--label') || 'uncontrolled' }
}

async function collect(options, { sampleInventory, now = () => performance.now(), wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const read = sampleInventory || (async () => {
    const { stdout } = await promisify(execFile)('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'collect-process-inventory.ps1')
    ], { windowsHide: true, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 })
    const rows = JSON.parse(stdout.replace(/^\uFEFF/, ''))
    if (!Array.isArray(rows)) throw new Error('Process inventory must be an array')
    return rows
  })
  const started = now()
  const series = new ProcessResourceSeries(options)
  for (;;) {
    const inventory = await read()
    const elapsed = now() - started
    const sample = series.add(inventory, elapsed)
    if (!sample.rootAlive || elapsed >= options.durationSeconds * 1000) break
    await wait(Math.min(options.intervalMs, options.durationSeconds * 1000 - elapsed))
  }
  return { ...series.report(), collectedAt: new Date().toISOString(), durationMs: now() - started }
}

async function run() {
  if (process.platform !== 'win32') throw new Error('This collector currently supports Windows only')
  const options = parseArguments(process.argv.slice(2))
  const report = await collect(options)
  fs.mkdirSync(path.dirname(options.output), { recursive: true })
  fs.writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
  process.stdout.write(`${JSON.stringify({ output: options.output, label: report.label, samples: report.samples.length, summary: report.summary })}\n`)
}

if (require.main === module) run().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
module.exports = { collect, parseArguments }
