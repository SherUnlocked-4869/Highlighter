'use strict'

// C02 (docs/reviews/2026-11-24-windows-product-architecture-review.md): the performance rule is
// "measure the same fixed machine before and after, and let P95 - not a single run - decide".
// This module is the decision half (percentiles, sample sufficiency, the three thresholds);
// scripts/startup-baseline.js is the collection half. Keeping them apart means the verdict is
// unit-testable without a real Electron launch.

// Thresholds from the review: startup/first-editable P95 may regress by at most 10%, idle
// private-commit median over the last 5 minutes by at most 10%, idle CPU median by at most
// 0.5 percentage points. They are deliberately ratios for the first two: absolute numbers
// belong to the machine, not the product.
const THRESHOLDS = Object.freeze({
  startupP95RegressionRatio: 0.10,
  idleCommitGrowthRatio: 0.10,
  idleCpuMedianMaxPct: 0.5,
  minimumColdStarts: 20,
  minimumIdleRounds: 5
})

function percentile(values, ratio) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right)
  if (!sorted.length) return 0
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1))
  return sorted[index]
}

function summarize(values) {
  const samples = values.map((value) => Number(value)).filter((value) => Number.isFinite(value))
  if (!samples.length) return { runs: 0, p50: 0, p95: 0, min: 0, max: 0, median: 0 }
  return {
    runs: samples.length,
    p50: Math.round(percentile(samples, 0.5) * 100) / 100,
    p95: Math.round(percentile(samples, 0.95) * 100) / 100,
    min: Math.round(Math.min(...samples) * 100) / 100,
    max: Math.round(Math.max(...samples) * 100) / 100,
    median: Math.round(percentile(samples, 0.5) * 100) / 100
  }
}

function growthRatio(current, baseline) {
  const base = Number(baseline)
  const value = Number(current)
  if (!Number.isFinite(base) || base <= 0 || !Number.isFinite(value)) return null
  return (value - base) / base
}

function checkRatio({ id, current, baseline, ratio, label }) {
  const growth = growthRatio(current, baseline)
  if (growth === null) return { id, ok: false, code: 'no-baseline', label, current, baseline }
  return {
    id,
    ok: growth <= ratio,
    code: growth <= ratio ? 'ok' : 'regression',
    label,
    current,
    baseline,
    growthRatio: Math.round(growth * 10000) / 10000
  }
}

// current: { startupMs: [], firstEditableMs: [], idlePrivateCommitBytes: [], idleCpuPct: [] }
// baseline: { startupP95Ms, firstEditableP95Ms, idlePrivateCommitMedianBytes }
function evaluateBaseline({ current = {}, baseline = {}, thresholds = THRESHOLDS } = {}) {
  const checks = []
  const startup = summarize(current.startupMs || [])
  const firstEditable = summarize(current.firstEditableMs || [])
  const idleCommit = summarize(current.idlePrivateCommitBytes || [])
  const idleCpu = summarize(current.idleCpuPct || [])
  const coldStarts = Math.max(startup.runs, firstEditable.runs)
  if (coldStarts < thresholds.minimumColdStarts) {
    checks.push({ id: 'cold-starts', ok: false, code: 'insufficient-samples', label: 'cold starts', current: coldStarts, baseline: thresholds.minimumColdStarts })
  }
  if (checks.length === 0) {
    checks.push(checkRatio({ id: 'startup-p95', current: startup.p95, baseline: baseline.startupP95Ms, ratio: thresholds.startupP95RegressionRatio, label: 'startup P95' }))
    checks.push(checkRatio({ id: 'first-editable-p95', current: firstEditable.p95, baseline: baseline.firstEditableP95Ms, ratio: thresholds.startupP95RegressionRatio, label: 'first editable P95' }))
    checks.push(checkRatio({ id: 'idle-private-commit', current: idleCommit.median, baseline: baseline.idlePrivateCommitMedianBytes, ratio: thresholds.idleCommitGrowthRatio, label: 'idle private commit median' }))
    const cpu = idleCpu.median
    checks.push({
      id: 'idle-cpu',
      ok: Number.isFinite(cpu) && cpu <= thresholds.idleCpuMedianMaxPct,
      code: !Number.isFinite(cpu) ? 'no-samples' : cpu <= thresholds.idleCpuMedianMaxPct ? 'ok' : 'regression',
      label: 'idle CPU median (%)',
      current: cpu,
      baseline: thresholds.idleCpuMedianMaxPct
    })
  }
  return {
    ok: checks.every((check) => check.ok),
    checks,
    samples: { startup, firstEditable, idleCommit, idleCpu }
  }
}

module.exports = { THRESHOLDS, evaluateBaseline, growthRatio, percentile, summarize }
