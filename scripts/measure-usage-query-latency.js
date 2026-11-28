// E01 measurement helper: re-runs the exact latency characterization of
// test/usage-query.test.js behind a machine-readable report, adding p50/min/max
// that the test itself does not print.
//
// It is deliberately read-only and measurement-only: it builds the same 100k-row
// synthetic store through the shipped `openUsageStore` / `createUsageQuery`
// APIs, uses the same seven views and the same warm-up + 25-sample loop, and
// never changes a product file. The authoritative pass/fail gate remains
// `node --test test/usage-query.test.js`; this script exists so p50 can be
// recorded and so a loaded-host run can report every view even after the test
// aborts on its first over-budget p95.
//
// Usage:
//   node scripts/measure-usage-query-latency.js [--repeat 1] [--samples 25] [--out <path>]
// Output: a single `[usage-query latency] {...}` line (and optional JSON file).
'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createUsageQuery } = require('../main/services/usage-query')
const { openUsageStore } = require('../main/services/usage-store')

const FIXED_NOW = () => new Date('2026-10-21T03:00:00.000Z')
const ROWS = 100000

function argValue(args, name, fallback) {
  const index = args.indexOf(name)
  if (index < 0) return fallback
  const value = Number(args[index + 1])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function percentile(values, p) {
  const sorted = values.slice().sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}

function summarize(timings) {
  const round = (value) => Number(value.toFixed(2))
  return {
    samples: timings.length,
    minMs: round(Math.min(...timings)),
    p50Ms: round(percentile(timings, 50)),
    p95Ms: round(percentile(timings, 95)),
    maxMs: round(Math.max(...timings))
  }
}

function buildRows() {
  const sources = ['codex', 'dsh', 'opencode']
  const models = Array.from({ length: 24 }, (_, index) => `model-${index}`)
  const base = Date.parse('2024-11-01T00:00:00.000Z')
  const rows = new Array(ROWS)
  for (let i = 0; i < ROWS; i += 1) {
    rows[i] = {
      source: sources[i % sources.length],
      model: models[i % models.length],
      hour_start: new Date(base + Math.floor(i / models.length) * 30 * 60 * 1000).toISOString(),
      input_tokens: 100 + (i % 97),
      cached_input_tokens: 50,
      cache_creation_input_tokens: 0,
      output_tokens: 10,
      reasoning_output_tokens: 1,
      total_tokens: 161 + (i % 97),
      billable_total_tokens: 161 + (i % 97),
      conversation_count: 1,
      total_cost_usd: 0
    }
  }
  return rows
}

function run() {
  const args = process.argv.slice(2)
  const repeat = argValue(args, '--repeat', 1)
  const sampleCount = argValue(args, '--samples', 25)
  const outIndex = args.indexOf('--out')
  const outPath = outIndex >= 0 ? path.resolve(args[outIndex + 1]) : ''
  const rows = buildRows()
  const reports = []
  let root = null
  for (let iteration = 0; iteration < repeat; iteration += 1) {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-usage-latency-'))
    const store = openUsageStore({ dbPath: path.join(root, 'usage.db'), now: FIXED_NOW })
    try {
      const insertStarted = process.hrtime.bigint()
      for (const source of ['codex', 'dsh', 'opencode']) {
        store.commitScan({ source, upserts: rows.filter((row) => row.source === source) })
      }
      const insertMs = Number(process.hrtime.bigint() - insertStarted) / 1e6
      let clock = 0
      const query = createUsageQuery({
        getStore: () => store,
        now: FIXED_NOW,
        cacheMaxEntries: 4,
        cacheTtlMs: 0,
        cacheNow: () => (clock += 1000)
      })
      const views = {
        summary: () => query.summary({ period: 'total', tz: 'Asia/Shanghai' }),
        daily: () => query.daily({ period: 'total', tz: 'Asia/Shanghai' }),
        breakdown: () => query.breakdown({ period: 'total', tz: 'Asia/Shanghai', scope: 'model' }),
        heatmap: () => query.heatmap({ tz: 'Asia/Shanghai', weeks: 52 }),
        summaryCodex: () => query.summary({ period: 'total', tz: 'Asia/Shanghai', sources: ['codex'] }),
        dailyCodex: () => query.daily({ period: 'total', tz: 'Asia/Shanghai', sources: ['codex'] }),
        heatmapCodex: () => query.heatmap({ tz: 'Asia/Shanghai', weeks: 52, sources: ['codex'] })
      }
      const report = { iteration, rows: ROWS, insertMs: Number(insertMs.toFixed(2)), views: {} }
      for (const [name, runView] of Object.entries(views)) {
        runView() // warm-up (prepared statements / decode paths)
        const timings = []
        for (let i = 0; i < sampleCount; i += 1) {
          const started = process.hrtime.bigint()
          runView()
          timings.push(Number(process.hrtime.bigint() - started) / 1e6)
        }
        report.views[name] = summarize(timings)
      }
      report.countBuckets = store.countBuckets()
      reports.push(report)
    } finally {
      try { store.close() } catch {}
      try { fs.rmSync(root, { recursive: true, force: true }) } catch {}
    }
  }
  const payload = {
    at: new Date().toISOString(),
    host: { cpuCount: os.cpus().length, totalMemoryMiB: Math.round(os.totalmem() / 1048576) },
    budgetMs: { summary: 100, daily: 150, breakdown: 300, heatmap: 100, summaryCodex: 100, dailyCodex: 150, heatmapCodex: 100 },
    runs: reports
  }
  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  }
  process.stdout.write(`[usage-query latency] ${JSON.stringify(payload)}\n`)
}

if (require.main === module) {
  try {
    run()
  } catch (error) {
    console.error('measure-usage-query-latency failed:', error?.stack || error)
    process.exitCode = 1
  }
}

module.exports = { buildRows, percentile, summarize }
