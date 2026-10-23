'use strict'

// AI usage page — round-3 interaction contract (2026-10-22 user feedback):
//   1. switching the period tab / AI-tool filter must not blank the page
//      (no loading card, no torn-down dashboard) while re-querying;
//   2. the account-level "Cursor cannot be measured" note is gone;
//   3. the header refresh action is icon-only and the toolbar carries an
//      AI-tool filter whose default state is "all".
//
// These three are pure renderer behaviours: a source-level contract keeps them
// from silently regressing without booting Electron, and the visual harness
// (scripts/usage-visual-preview.js --switching / --filter-click) covers the
// runtime side.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const usageSource = fs.readFileSync(path.join(ROOT, 'config', 'routes', 'usage.js'), 'utf8')
const css = fs.readFileSync(path.join(ROOT, 'config', 'config.css'), 'utf8')
const locales = fs.readFileSync(path.join(ROOT, 'shared', 'locales', 'config.js'), 'utf8')

test('period and filter switches keep the mounted dashboard instead of blanking it', () => {
  // The loading card may only be rendered on the first load path (keepCurrent
  // false); a user-initiated re-query must mark the page busy instead.
  assert.match(usageSource, /function usageRerenderKeepingDashboard\(\)[\s\S]*?keepDashboard: true/)
  assert.match(usageSource, /const keepCurrent = options\.keepDashboard === true && usageKeepDashboardForSwap\(\)/)
  assert.match(usageSource, /if \(!keepCurrent\) usageRenderLoading\(renderVersion\)\s*\n\s*else usageSetBusy\(renderVersion, swapVersion, true\)/)
  assert.match(usageSource, /function usageKeepDashboardForSwap\(\)[\s\S]*?page\.dataset\.usageState === 'loading'[\s\S]*?querySelector\('\.usage-dashboard'\)/)
  assert.match(usageSource, /dataset\.usageBusy = 'true'/)
  // Every user-triggered re-query goes through the keep-dashboard path.
  assert.match(usageSource, /usagePeriod = next\s*\n\s*void usageRerenderKeepingDashboard\(\)/)
  assert.match(usageSource, /void usageRerenderKeepingDashboard\(\)/)
  assert.doesNotMatch(usageSource, /button\.dataset\.usageTab[\s\S]{0,400}?void renderUsage\(\)/)
  // Scroll offset and focus survive the in-place swap.
  assert.match(usageSource, /function usageCaptureViewState\(\)/)
  assert.match(usageSource, /function usageRestoreViewState\(state\)/)
  assert.match(css, /\[data-usage-busy=true\] \.usage-dashboard\{opacity:\.55/)
})

test('the account-level Cursor note no longer renders', () => {
  assert.doesNotMatch(usageSource, /cursor-note/)
  assert.doesNotMatch(usageSource, /usage-unsupported-note/)
  assert.doesNotMatch(locales, /cursor-note/)
  assert.doesNotMatch(css, /\.usage-unsupported-note/)
  // The unsupported *state* copy stays: it is a page state, not a permanent note.
  assert.match(locales, /'config\.usage\.state\.unsupported-body'/)
})

test('header refresh is icon-only and the toolbar carries the AI-tool filter', () => {
  assert.match(usageSource, /function usageRefreshButtonHtml\(\)[\s\S]*?iconMarkup\('icons\/refresh\.svg'\)[\s\S]*?aria-label="\$\{label\}" title="\$\{label\}"/)
  assert.doesNotMatch(usageSource, /usage-refresh-button[^`]*<span>\$\{t\('config\.usage\.refresh'\)\}<\/span>/)
  assert.match(css, /\.usage-refresh-button\{display:grid;place-items:center;width:34px;height:32px;padding:0\}/)

  // Filter chips: one per supported tool + the "all" reset, all toggles.
  assert.match(usageSource, /function usageSourceFilterHtml\(\)/)
  assert.match(usageSource, /const allSelected = usageSourceFilter\.length === 0/)
  assert.match(usageSource, /USAGE_SUPPORTED_SOURCES\.map\(\(id\) => \{/)
  assert.match(usageSource, /data-usage-source-filter="\$\{id\}" aria-pressed=/)
  assert.match(usageSource, /data-usage-source-filter="all"/)
  assert.match(usageSource, /function usageBindSourceFilter\(\)/)
  // Clicking a selected tool again removes it; the last removal means "all".
  assert.match(usageSource, /const index = usageSourceFilter\.indexOf\(id\)\s*\n\s*if \(index === -1\) usageSourceFilter = \[\.\.\.usageSourceFilter, id\]\s*\n\s*else usageSourceFilter = usageSourceFilter\.filter\(\(item\) => item !== id\)/)
  // Visible in the same control band as the period tabs.
  assert.match(usageSource, /<div class="usage-toolbar">[\s\S]*?usageSourceFilterHtml\(\)/)

  for (const key of ['config.usage.filter.label', 'config.usage.filter.all']) {
    const occurrences = locales.split(`'${key}'`).length - 1
    assert.equal(occurrences, 3, `${key} must exist in all three locale tables`)
  }
})

test('the AI-tool filter reaches every query channel and stays a no-op for all', () => {
  assert.match(usageSource, /const sources = usageSourceFilter\.length > 0 \? usageSourceFilter\.slice\(\) : null/)
  assert.match(usageSource, /return sources \? \{ period: usagePeriod, tz, sources \} : \{ period: usagePeriod, tz \}/)
  // Trend window (30-day custom range) and the modal's 30-minute channel follow
  // the same selection, otherwise the cards would disagree with each other.
  assert.match(usageSource, /const query = \{ period: 'custom', tz: usageTimezone\(\), from, to: today \}/)
  assert.match(usageSource, /if \(usageSourceFilter\.length > 0\) query\.sources = usageSourceFilter\.slice\(\)/)
  assert.match(usageSource, /if \(usageSourceFilter\.length > 0\) hourlyQuery\.sources = usageSourceFilter\.slice\(\)/)
  // Heatmap is a page-wide card, so it follows the filter too.
  assert.match(usageSource, /usageHeatmap\(\{ tz: params\.tz, weeks: USAGE_HEATMAP_WEEKS, \.\.\.\(params\.sources \? \{ sources: params\.sources \} : \{\}\) \}\)/)
})

test('the heatmap month row shares the day grid column track (compact-safe)', () => {
  // The month header is a second grid laid over the same week columns: it must
  // step by exactly one cell track or the labels drift away from the days they
  // name. Compact mode shrinks the cells, so a literal column size in EITHER
  // row desyncs them (reported bug: at 11px cells the labels drifted 2px per
  // column, ~98px over 52 weeks). Both rows must read one shared token instead.
  assert.match(css, /\.usage-heat-canvas\{[^}]*--usage-heat-cell:[^;}]+/)
  assert.match(css, /\.usage-heat-months\{[^}]*gap:var\(--usage-heat-gap\)/)
  assert.match(css, /\.usage-heat-grid\{[^}]*grid-template-rows:repeat\(7,var\(--usage-heat-cell\)\)/)
  assert.match(css, /\.usage-heat-grid\{[^}]*grid-template-columns:repeat\(var\(--usage-heat-weeks,52\),var\(--usage-heat-cell\)\)/)
  assert.match(css, /\.usage-heat-cell\{[^}]*width:var\(--usage-heat-cell\);height:var\(--usage-heat-cell\)/)
  // The inline month-row template in the renderer must use the same token.
  assert.match(usageSource, /class="usage-heat-months" style="grid-template-columns:repeat\(\$\{model\.columns\.length\},var\(--usage-heat-cell\)\)"/)
  // No literal pixel column sizes may creep back into either heatmap row.
  for (const selector of ['.usage-heat-months{', '.usage-heat-grid{']) {
    const rule = css.slice(css.indexOf(selector)).split('}')[0]
    assert.doesNotMatch(rule, /\d+px\)/, `${selector} must not hardcode a column size`)
  }
  // Compact mode retunes the single token rather than re-declaring track sizes.
  assert.match(css, /body\.compact \.usage-heat-canvas\{--usage-heat-cell:11px\}/)
  assert.doesNotMatch(css, /body\.compact \.usage-heat-(grid|cell)\{[^}]*(width|grid-template)/)
})

test('the filter row degrades at narrow page widths instead of overflowing', () => {
  // Container queries only — the settings window's content column is narrower
  // than the viewport, so viewport media queries would be wrong here.
  assert.match(css, /@container usage \(min-width:560px\) and \(max-width:759px\)\{[\s\S]*?\.usage-source-filter\{margin-left:0;flex:1 1 100%\}/)
  assert.match(css, /@container usage \(max-width:659px\)\{[\s\S]*?\.usage-filter-caption\{display:none\}/)
  assert.match(css, /\.usage-filter-chip\.is-active\{[^}]*border-color:var\(--primary-line\)/)
  assert.doesNotMatch(css, /\.usage-source-filter\{[^}]*position:absolute/)
})
