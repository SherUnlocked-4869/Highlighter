#!/usr/bin/env node
'use strict'

// C02 (docs/reviews/2026-11-24-windows-product-architecture-review.md): a fixed-machine
// baseline needs the SAME procedure every time - N cold starts, the same readiness markers,
// and the thresholds from the review. This script is that procedure:
//
//   node scripts/startup-baseline.js \
//     --probe "npx electron --no-sandbox scripts/probe-startup.js" --runs 20 \
//     --marker loginToTrayMs=HIGHLIGHTER_TRAY_READY \
//     --marker manualToFirstFrameMs=HIGHLIGHTER_FIRST_FRAME \
//     --marker firstEditableMs=HIGHLIGHTER_EDITABLE_1 \
//     --marker secondEditableMs=HIGHLIGHTER_EDITABLE_2 \
//     --out .tmp-perf/current.json --baseline .tmp-perf/baseline.json
//
// Plan item 15: each required metric is its OWN event series with its own run id. The old
// collector used one "ready" marker for startup and then COPIED the startup array into
// `firstEditableMs`, so a metric nobody measured could pass the gate. A metric whose marker
// never appears is reported as missing (with the reason) instead of being filled in.
//
// Idle numbers come from a 30-minute standby sampling run, not from a cold start, so they are
// passed in with --idle-private-commit / --idle-cpu plus the round id and span flags.

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { evaluateBaseline, summarize, currentFromReport, THRESHOLDS } = require('../main/services/performance-budget')

const READY_TIMEOUT_MS = 120000

// The event the probe prints and the series it feeds. `startupMs` is the default so a caller
// that only knows the old `--ready` marker still measures the cold start; every other series
// needs its own marker.
const KNOWN_MARKERS = ['startupMs', 'loginToTrayMs', 'manualToFirstFrameMs', 'firstEditableMs', 'secondEditableMs']

function parseArgs(argv) {
  const args = {
    runs: 20,
    ready: 'HIGHLIGHTER_READY',
    timeoutMs: READY_TIMEOUT_MS,
    idlePrivateCommit: [],
    idleCpu: [],
    idleRoundIds: [],
    idleSpanMs: 0,
    markers: { startupMs: 'HIGHLIGHTER_READY' },
    out: '',
    baseline: '',
    probe: '',
    packageType: '',
    version: '',
    config: '',
    dataScale: '',
    device: '',
    driver: ''
  }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const next = () => { index += 1; return argv[index] }
    if (flag === '--probe') args.probe = next() || ''
    else if (flag === '--ready') {
      args.ready = next() || args.ready
      args.markers = { ...args.markers, startupMs: args.ready }
    }
    else if (flag === '--marker') {
      const value = String(next() || '')
      const separator = value.indexOf('=')
      if (separator > 0) {
        const key = value.slice(0, separator).trim()
        const marker = value.slice(separator + 1).trim()
        if (KNOWN_MARKERS.includes(key) && marker) args.markers[key] = marker
      }
    }
    else if (flag === '--runs') {
      const parsed = Number(next())
      if (Number.isFinite(parsed)) args.runs = Math.max(1, Math.floor(parsed))
    }
    else if (flag === '--timeout') args.timeoutMs = Math.max(1000, Number(next()) || args.timeoutMs)
    else if (flag === '--out') args.out = next() || ''
    else if (flag === '--baseline') args.baseline = next() || ''
    else if (flag === '--idle-private-commit') args.idlePrivateCommit.push(Number(next()))
    else if (flag === '--idle-cpu') args.idleCpu.push(Number(next()))
    else if (flag === '--idle-round') args.idleRoundIds.push(String(next() || ''))
    else if (flag === '--idle-span-ms') args.idleSpanMs = Math.max(0, Number(next()) || 0)
    else if (flag === '--package-type') args.packageType = next() || ''
    else if (flag === '--version') args.version = next() || ''
    else if (flag === '--config') args.config = next() || ''
    else if (flag === '--data-scale') args.dataScale = next() || ''
    else if (flag === '--device') args.device = next() || ''
    else if (flag === '--driver') args.driver = next() || ''
  }
  if (!args.probe) throw new Error('--probe "<command>" is required')
  return args
}

// A probe that ignores SIGTERM on Windows would keep running (and keep the port/window), so
// the timeout reaps the whole tree. The failed run still counts in `startupFailures`.
function killTree(child) {
  if (!child || child.exitCode !== null) return
  try {
    if (process.platform === 'win32' && Number.isInteger(child.pid)) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      return
    }
  } catch {}
  try { child.kill('SIGKILL') } catch {}
}

// Runs once and records the first time EACH marker appears. Every series is stamped from the
// same start, but only a marker that actually appeared produces a sample; the rest are
// reported as missing for that run.
function runOnce({ probe, timeoutMs, markers = { startupMs: 'HIGHLIGHTER_READY' } }) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    let settled = false
    const child = spawn(probe, { shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const seen = {}
    const timer = setTimeout(() => finish('timeout'), timeoutMs)
    function finish(reason) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      killTree(child)
      resolve({ reason, seen, elapsedMs: seen.startupMs || null, finishedAt: Date.now() })
    }
    const scan = (chunk) => {
      output += String(chunk)
      for (const [key, marker] of Object.entries(markers)) {
        if (!marker || seen[key] !== undefined) continue
        if (output.includes(marker)) seen[key] = Date.now() - startedAt
      }
      // The run is over once every configured marker was seen.
      const allSeen = Object.values(markers).every((marker) => !marker || Object.values(seen).length >= Object.keys(markers).length)
      if (allSeen && !settled) finish('ready')
    }
    child.stdout?.on('data', scan)
    child.stderr?.on('data', scan)
    child.on('error', () => finish('spawn-error'))
    child.on('exit', () => finish(Object.keys(seen).length ? 'ready' : 'exited-before-ready'))
  })
}

async function collectSeries({ probe, markers, runs, timeoutMs }) {
  const series = {}
  for (const key of Object.keys(markers)) series[key] = []
  const missing = {}
  const failures = []
  for (let run = 0; run < runs; run += 1) {
    const result = await runOnce({ probe, timeoutMs, markers })
    for (const key of Object.keys(markers)) {
      if (Number.isFinite(result.seen[key])) series[key].push(result.seen[key])
    }
    if (result.reason !== 'ready') {
      failures.push({ run: run + 1, reason: result.reason, seen: Object.keys(result.seen) })
      for (const key of Object.keys(markers)) {
        if (result.seen[key] === undefined) missing[key] = result.reason
      }
    }
  }
  for (const key of Object.keys(markers)) {
    if (!series[key].length) missing[key] = missing[key] || 'no-marker'
  }
  return { series, missing, failures }
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
  const collected = await collectSeries(args)
  const idle = args.idlePrivateCommit.filter((value) => Number.isFinite(value))
  const cpu = args.idleCpu.filter((value) => Number.isFinite(value))
  const missing = { ...collected.missing }
  if (!idle.length) missing.idlePrivateCommitBytes = missing.idlePrivateCommitBytes || 'no-standby-rounds'
  if (!cpu.length) missing.idleCpuPct = missing.idleCpuPct || 'no-standby-rounds'
  const report = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    probe: args.probe,
    readyMarker: args.ready,
    markers: { ...args.markers },
    runs: args.runs,
    // Environment facts the review asks the report to record, so two runs can be compared.
    environment: {
      packageType: args.packageType,
      version: args.version,
      config: args.config,
      dataScale: args.dataScale,
      device: args.device,
      driver: args.driver
    },
    startupMs: collected.series.startupMs || [],
    loginToTrayMs: collected.series.loginToTrayMs || [],
    manualToFirstFrameMs: collected.series.manualToFirstFrameMs || [],
    firstEditableMs: collected.series.firstEditableMs || [],
    secondEditableMs: collected.series.secondEditableMs || [],
    idlePrivateCommitBytes: idle,
    idleCpuPct: cpu,
    idleRoundIds: args.idleRoundIds,
    idleSpanMs: args.idleSpanMs,
    missing,
    startupFailures: collected.failures,
    summary: {}
  }
  for (const key of Object.keys(report)) {
    if (!Array.isArray(report[key])) continue
    if (key === 'idleRoundIds' || key === 'startupFailures') continue
    report.summary[key] = summarize(report[key])
  }
  writeJson(args.out, report)
  console.log('samples:', JSON.stringify(report.summary))
  if (collected.failures.length) console.log('probe failures:', JSON.stringify(collected.failures))
  const baseline = args.baseline ? readJson(args.baseline) : null
  if (args.baseline && !baseline) {
    console.error('baseline file not found or invalid:', args.baseline)
    process.exitCode = 1
    return
  }
  if (baseline) {
    const verdict = evaluateBaseline({ current: currentFromReport(report), baseline })
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

module.exports = { collectSeries, killTree, parseArgs, runOnce, THRESHOLDS }
