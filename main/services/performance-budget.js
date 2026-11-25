'use strict'

// C02 (docs/reviews/2026-11-24-windows-product-architecture-review.md): the performance rule is
// "measure the same fixed machine before and after, and let P95 - not a single run - decide".
// This module is the decision half (percentiles, sample sufficiency, the per-metric thresholds);
// scripts/startup-baseline.js is the collection half. Keeping them apart means the verdict is
// unit-testable without a real Electron launch.
//
// Plan item 15: every REQUIRED metric is now its own series with its own sample count and its
// own baseline. The old evaluator took `max(startupSamples, firstEditableSamples)` for the
// sufficiency gate and then skipped every remaining check whenever that gate failed; worse, the
// collector filled `firstEditableMs` with the startup array, so a metric that was NEVER measured
// (first F1 -> editable) could pass. A missing series is now "sample insufficient" for THAT
// metric and the gate fails.

// Thresholds from the review: startup/first-editable P95 may regress by at most 10%, idle
// private-commit median over the last 5 minutes by at most 10%, idle CPU median by at most
// 0.5 percentage points. They are deliberately ratios for the first two: absolute numbers
// belong to the machine, not the product.
const THRESHOLDS = Object.freeze({
  startupP95RegressionRatio: 0.10,
  idleCommitGrowthRatio: 0.10,
  idleCpuMedianMaxPct: 0.5,
  minimumColdStarts: 20,
  minimumIdleRounds: 5,
  // The plan's standby window: 5 rounds of 30 minutes, each judged on its last 5 minutes.
  idleRoundMinutes: 30,
  idleWindowMinutes: 5
})

// The series the gate requires, in report order. `kind: 'ratio'` compares this run's aggregate
// with the baseline; `kind: 'absolute'` compares it with a fixed maximum. `minimum` is the
// sample count required for THIS metric - never for a sibling.
const REQUIRED_METRICS = Object.freeze([
  {
    id: 'startup-p95',
    key: 'startupMs',
    baselineKey: 'startupP95Ms',
    aggregation: 'p95',
    minimum: THRESHOLDS.minimumColdStarts,
    kind: 'ratio',
    label: 'startup P95'
  },
  {
    id: 'login-to-tray-p95',
    key: 'loginToTrayMs',
    baselineKey: 'loginToTrayP95Ms',
    aggregation: 'p95',
    minimum: THRESHOLDS.minimumColdStarts,
    kind: 'ratio',
    label: 'sign-in to tray responsive P95'
  },
  {
    id: 'manual-to-first-frame-p95',
    key: 'manualToFirstFrameMs',
    baselineKey: 'manualToFirstFrameP95Ms',
    aggregation: 'p95',
    minimum: THRESHOLDS.minimumColdStarts,
    kind: 'ratio',
    label: 'manual start to main window first frame P95'
  },
  {
    id: 'first-editable-p95',
    key: 'firstEditableMs',
    baselineKey: 'firstEditableP95Ms',
    aggregation: 'p95',
    minimum: THRESHOLDS.minimumColdStarts,
    kind: 'ratio',
    label: 'first F1 to editable P95'
  },
  {
    id: 'second-editable-p95',
    key: 'secondEditableMs',
    baselineKey: 'secondEditableP95Ms',
    aggregation: 'p95',
    minimum: THRESHOLDS.minimumColdStarts,
    kind: 'ratio',
    label: 'second F1 to editable P95'
  },
  {
    id: 'idle-private-commit',
    key: 'idlePrivateCommitBytes',
    baselineKey: 'idlePrivateCommitMedianBytes',
    aggregation: 'median',
    minimum: THRESHOLDS.minimumIdleRounds,
    kind: 'ratio',
    ratio: THRESHOLDS.idleCommitGrowthRatio,
    label: 'idle private commit median'
  },
  {
    id: 'idle-cpu',
    key: 'idleCpuPct',
    aggregation: 'median',
    minimum: THRESHOLDS.minimumIdleRounds,
    kind: 'absolute',
    maximum: THRESHOLDS.idleCpuMedianMaxPct,
    label: 'idle CPU median (%)'
  }
])

function percentile(values, ratio) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right)
  if (!sorted.length) return 0
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1))
  return sorted[index]
}

function summarize(values) {
  const source = Array.isArray(values) ? values : []
  const samples = source
    // A null/'' entry is a missing measurement, NOT the number 0 (Number(null) === 0).
    .filter((value) => value !== null && value !== undefined && value !== '')
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
  if (!samples.length) return { runs: 0, p50: 0, p95: 0, min: 0, max: 0, median: 0, total: source.length }
  return {
    runs: samples.length,
    // `total` includes the non-numeric entries, so a report can say "19 of 20 measured".
    total: source.length,
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

// One metric, judged on its OWN samples and its OWN baseline.
function evaluateMetric(metric, current, baseline, thresholds) {
  const values = Array.isArray(current?.[metric.key]) ? current[metric.key] : []
  const summary = summarize(values)
  const numeric = values.filter((value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))).length
  const minimum = metric.id === 'idle-private-commit' || metric.id === 'idle-cpu'
    ? thresholds.minimumIdleRounds
    : thresholds.minimumColdStarts
  if (numeric < minimum) {
    return {
      id: metric.id,
      ok: false,
      code: 'insufficient-samples',
      label: metric.label,
      current: numeric,
      baseline: minimum,
      runs: numeric,
      required: minimum,
      // Why the series is short, when the collector knows (a timeout, a missing event, an
      // old report that has no such column at all).
      reason: String(current?.missing?.[metric.key] || 'not-measured')
    }
  }
  const isIdleMetric = metric.key === 'idlePrivateCommitBytes' || metric.key === 'idleCpuPct'
  if (isIdleMetric) {
    // A standby sample is one 30-minute round. Five copies of ONE round are five samples on
    // paper and one measurement in reality, so the round ids (when the collector records
    // them) must be distinct.
    if (Array.isArray(current?.idleRoundIds)) {
      const distinct = new Set(current.idleRoundIds.filter((id) => id !== null && id !== undefined && id !== '')).size
      if (distinct < minimum) {
        return {
          id: metric.id,
          ok: false,
          code: 'insufficient-samples',
          label: metric.label,
          current: distinct,
          baseline: minimum,
          runs: distinct,
          required: minimum,
          reason: 'duplicate-standby-rounds'
        }
      }
    }
    // The plan's window is 5 rounds x 30 minutes. A shorter span cannot be called a standby
    // baseline even when the per-round arrays happen to be full.
    const spanMs = Number(current?.idleSpanMs)
    const requiredSpanMs = minimum * thresholds.idleRoundMinutes * 60 * 1000
    if (Number.isFinite(spanMs) && spanMs > 0 && spanMs < requiredSpanMs) {
      return {
        id: metric.id,
        ok: false,
        code: 'insufficient-samples',
        label: metric.label,
        current: Math.round(spanMs / 60000),
        baseline: thresholds.idleRoundMinutes * minimum,
        runs: numeric,
        required: minimum,
        reason: 'standby-window-too-short'
      }
    }
  }
  const currentValue = metric.aggregation === 'median' ? summary.median : summary.p95
  if (metric.kind === 'absolute') {
    const ok = Number.isFinite(currentValue) && currentValue <= metric.maximum
    return {
      id: metric.id,
      ok,
      code: ok ? 'ok' : 'regression',
      label: metric.label,
      current: currentValue,
      baseline: metric.maximum,
      runs: numeric,
      aggregation: metric.aggregation
    }
  }
  const baselineValue = Number(baseline?.[metric.baselineKey])
  if (!Number.isFinite(baselineValue) || baselineValue <= 0) {
    return {
      id: metric.id,
      ok: false,
      code: 'no-baseline',
      label: metric.label,
      current: currentValue,
      baseline: baseline?.[metric.baselineKey] ?? null,
      runs: numeric,
      aggregation: metric.aggregation
    }
  }
  return {
    ...checkRatio({
      id: metric.id,
      current: currentValue,
      baseline: baselineValue,
      ratio: Number.isFinite(metric.ratio) ? metric.ratio : thresholds.startupP95RegressionRatio,
      label: metric.label
    }),
    runs: numeric,
    aggregation: metric.aggregation
  }
}

// current: {
//   startupMs, loginToTrayMs, manualToFirstFrameMs, firstEditableMs, secondEditableMs,
//   idlePrivateCommitBytes, idleCpuPct,
//   missing: { [key]: reason }   // optional, from the collector
// }
// baseline: { startupP95Ms, loginToTrayP95Ms, manualToFirstFrameP95Ms, firstEditableP95Ms,
//             secondEditableP95Ms, idlePrivateCommitMedianBytes }
function evaluateBaseline({ current = {}, baseline = {}, thresholds = THRESHOLDS } = {}) {
  const checks = REQUIRED_METRICS.map((metric) => evaluateMetric(metric, current, baseline, thresholds))
  const samples = {}
  for (const metric of REQUIRED_METRICS) samples[metric.key] = summarize(current?.[metric.key] || [])
  return {
    ok: checks.every((check) => check.ok),
    checks,
    samples
  }
}

// A collector report can be old (schema 1 wrote only startupMs and used the same array for
// "first editable"), empty, or full of nulls. The gate must call that "sample insufficient"
// and exit non-zero instead of treating a missing column as a pass.
function currentFromReport(report) {
  if (!report || typeof report !== 'object') {
    return {
      startupMs: [],
      loginToTrayMs: [],
      manualToFirstFrameMs: [],
      firstEditableMs: [],
      secondEditableMs: [],
      idlePrivateCommitBytes: [],
      idleCpuPct: [],
      missing: { startupMs: 'report-missing' }
    }
  }
  const legacy = Number(report.schemaVersion) < 2
  const series = (key) => (Array.isArray(report[key]) ? report[key] : [])
  const missing = { ...(report.missing && typeof report.missing === 'object' ? report.missing : {}) }
  const current = {
    startupMs: series('startupMs'),
    loginToTrayMs: series('loginToTrayMs'),
    manualToFirstFrameMs: series('manualToFirstFrameMs'),
    firstEditableMs: series('firstEditableMs'),
    secondEditableMs: series('secondEditableMs'),
    idlePrivateCommitBytes: series('idlePrivateCommitBytes'),
    idleCpuPct: series('idleCpuPct'),
    missing
  }
  for (const [key, values] of Object.entries(current)) {
    if (key === 'missing') continue
    if (!values.length && !missing[key]) missing[key] = legacy ? 'legacy-report-missing-column' : 'not-measured'
  }
  // A legacy report's "first editable" was the startup array copied over: it is not evidence.
  if (legacy && current.firstEditableMs.length && current.firstEditableMs === report.startupMs) {
    current.firstEditableMs = []
    missing.firstEditableMs = 'legacy-report-copied-startup-samples'
  }
  return current
}

module.exports = {
  REQUIRED_METRICS,
  THRESHOLDS,
  currentFromReport,
  evaluateBaseline,
  evaluateMetric,
  growthRatio,
  percentile,
  summarize
}
