const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { readConfigSource } = require('./helpers/config-source')

const ROOT = path.resolve(__dirname, '..')
const usage = fs.readFileSync(path.join(ROOT, 'config', 'routes', 'usage.js'), 'utf8').replace(/\r\n/g, '\n')
const css = fs.readFileSync(path.join(ROOT, 'config', 'config.css'), 'utf8')
const config = readConfigSource()
const locales = fs.readFileSync(path.join(ROOT, 'shared', 'locales', 'config.js'), 'utf8')
const format = require('../shared/usage-format')

test('A04: the chart draws a distinct mark for each cost state', () => {
  assert.match(usage, /const costState = usageTrendMetric === 'cost' \? usageCostState\(row\) : ''/)
  // Unknown days are an explicit dashed marker, never a zero-height bar.
  assert.match(usage, /if \(costState === 'unpriced'\)/)
  assert.match(usage, /usage-trend-unknown-mark/)
  // A real zero keeps a baseline tick; a partial day keeps its subtotal plus a cap.
  assert.match(usage, /costState === 'zero'/)
  assert.match(usage, /usage-trend-cost-zero/)
  assert.match(usage, /costState === 'partial' \? '<i class="usage-trend-cost-cap"/)
  assert.match(usage, /data-cost-state="\$\{costState\}"/)
})

test('A04: bar, legend, tooltip, table and aria label share one formatter', () => {
  assert.match(usage, /function usageCostState\(row\) \{\n  return window\.usageFormat\.costState\(row\)/)
  assert.match(usage, /function usageCostText\(row\)/)
  // The tooltip and the daily table both resolve through usageCostText (not the raw amount).
  assert.match(usage, /const value = usageTrendMetric === 'cost' \? usageCostText\(row\)/)
  assert.match(usage, /escapeHtml\(empty \? '—' : usageCostText\(row\)\)/)
  // The scope line names currency, range and filters for the same reading.
  assert.match(usage, /function usageCostScopeText\(summary\)/)
  assert.match(usage, /t\('config\.usage\.cost\.scope', \{/)
  assert.match(usage, /function usageFilterScopeText\(\)/)
  // The legend is rendered only for the cost metric and uses the same copy keys.
  assert.match(usage, /usageTrendMetric === 'cost' \? usageCostLegendHtml\(\)/)
  assert.match(usage, /config\.usage\.cost\.partial-legend/)
})

test('A04: the five states stay distinguishable in high contrast and have copy in every language', () => {
  for (const className of ['usage-trend-unknown-mark', 'usage-trend-cost-cap', 'usage-trend-cost-zero', 'usage-cost-legend']) {
    assert.ok(css.includes('.' + className), className + ' has a rule')
  }
  assert.match(css, /@media \(forced-colors: active\)\{[\s\S]*usage-trend-unknown-mark[\s\S]*usage-trend-cost-cap[\s\S]*usage-trend-cost-zero/)
  for (const key of ['no-activity', 'zero', 'partial', 'partial-legend', 'legend-title', 'all-sources', 'scope']) {
    // Trailing quote-and-colon so 'partial' does not also match 'partial-legend'.
    const occurrences = locales.split("'config.usage.cost." + key + "':").length - 1
    assert.equal(occurrences, 3, 'config.usage.cost.' + key + ' exists in all three languages')
  }
  // The formatter contract itself: five samples, five different answers.
  const samples = {
    none: { total_tokens: 0, costCny: null },
    unpriced: { total_tokens: 10, costCny: null, unpricedModels: 2 },
    partial: { total_tokens: 10, costCny: 0.5, unpricedModels: 1 },
    zero: { total_tokens: 10, costCny: 0, unpricedModels: 0 },
    priced: { total_tokens: 10, costCny: 0.5 }
  }
  for (const [expected, row] of Object.entries(samples)) assert.equal(format.costState(row), expected)
  // And the page actually consults the shared helper (no local re-implementation).
  assert.doesNotMatch(usage, /function costState\(/)
})
