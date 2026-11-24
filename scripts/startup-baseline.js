#!/usr/bin/env node
'use strict'

// C02 (docs/reviews/2026-11-24-windows-product-architecture-review.md): a fixed-machine
// baseline needs the SAME procedure every time - N cold starts, the same readiness marker,
// and the three thresholds from the review. This script is that procedure:
//
//   node scripts/startup-baseline.js \
//     --probe "npx electron --no-sandbox scripts/probe-startup.js" \
//     --ready "HIGHLIGHTER_READY" --runs 20 --out .tmp-perf/current.json \
//     --baseline .tmp-perf/baseline.json
//
// It never launches a window itself: the probe command is the caller's, so the same harness
// measures a portable build, an NSIS install or a source run. The verdict (P95 regression
// <= 10%, idle commit <= 10%, idle CPU <= 0.5%) comes from main/services/performance-budget.js.
// Idle numbers are passed in with --idle-private-commit / --idle-cpu because they come from a
// 30-minute tasklist/app-metrics sampling run, not from a cold start.

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { evaluateBaseline, summarize } = require('../main/services/performance-budget')

const READY_TIMEOUT_MS = 120000

function parseArgs(argv) {
  const args = { runs: 20, ready: 'HIGHLIGHTER_READY', timeoutMs: READY_TIMEOUT_MS, idlePrivateCommit: [], idleCpu: [], out: '', baseline: '', probe: '' }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const next = () => { index += 1; return argv[index] }
    if (flag === '--probe') args.probe = next() || ''
    else if (flag === '--ready') args.ready = next() || args.ready
    else if (flag === '--runs') {
      const parsed = Number(next())
      if (Number.isFinite(parsed)) args.runs = Math.max(1, Math.floor(parsed))
    }
    else if (flag === '--timeout') args.timeoutMs = Math.max(1000, Number(next()) || args.timeoutMs)
    else if (flag === '--out') args.out = next() || ''
    else if (flag === '--baseline') args.baseline = next() || ''
    else if (flag === '--idle-private-commit') args.idlePrivateCommit.push(Number(next()))
    else if (flag === '--idle-cpu') args.idleCpu.push(Number(next()))
  }
  if (!args.probe) throw new Error('--probe "<command>" is required')
  return args
}

function runOnce({ probe, ready, timeoutMs }) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    let settled = false
    const child = spawn(probe, { shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const timer = setTimeout(() => finish(null, 'timeout'), timeoutMs)
    function finish(elapsed, reason) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child.kill() } catch {}
      resolve({ elapsedMs: elapsed, reason })
    }
    const scan = (chunk) => {
      output += String(chunk)
      if (output.includes(ready) && !settled) finish(Date.now() - startedAt, 'ready')
    }
    child.stdout?.on('data', scan)
    child.stderr?.on('data', scan)
    child.on('error', () => finish(null, 'spawn-error'))
    child.on('exit', () => finish(null, 'exited-before-ready'))
  })
}

async function collectStartup({ probe, ready, runs, timeoutMs }) {
  const samples = []
  const failures = []
  for (let run = 0; run < runs; run += 1) {
    const result = await runOnce({ probe, ready, timeoutMs })
    if (result.reason === 'ready') samples.push(result.elapsedMs)
    else failures.push({ run: run + 1, reason: result.reason })
  }
  return { samples, failures }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function writeJson(file, value) {
  if (!file) return
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const startup = await collectStartup(args)
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    probe: args.probe,
    readyMarker: args.ready,
    runs: args.runs,
    startupMs: startup.samples,
    startupFailures: startup.failures,
    summary: { startup: summarize(startup.samples) }
  }
  writeJson(args.out, report)
  console.log('startup samples:', JSON.stringify(report.summary.startup))
  if (startup.failures.length) console.log('startup failures:', JSON.stringify(startup.failures))
  const baseline = args.baseline ? readJson(args.baseline) : null
  if (args.baseline && !baseline) {
    console.error('baseline file not found or invalid:', args.baseline)
    process.exitCode = 1
    return
  }
  if (baseline) {
    const verdict = evaluateBaseline({
      current: {
        startupMs: startup.samples,
        firstEditableMs: startup.samples,
        idlePrivateCommitBytes: args.idlePrivateCommit.filter((value) => Number.isFinite(value)),
        idleCpuPct: args.idleCpu.filter((value) => Number.isFinite(value))
      },
      baseline
    })
    for (const check of verdict.checks) console.log(check.ok ? 'PASS' : 'FAIL', check.id, JSON.stringify(check))
    process.exitCode = verdict.ok ? 0 : 1
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('startup-baseline:', error.message)
    process.exitCode = 1
  })
}

module.exports = { collectStartup, parseArgs, runOnce }
