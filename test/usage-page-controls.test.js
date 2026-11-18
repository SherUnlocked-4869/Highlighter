'use strict'


const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const usageSource = fs.readFileSync(path.join(ROOT, 'config', 'routes', 'usage.js'), 'utf8')
const shellSource = fs.readFileSync(path.join(ROOT, 'config', 'config.js'), 'utf8')
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


test('the page refreshes its own data while it is open (2026-10-23 feedback)', () => {
  // Regression: the page rendered once and then sat on whatever the DB held until
  // the header button was pressed, because nothing in production ever sent the
  // `page-open` refresh reason after the one-time consent click. The lifecycle
  // itself is exercised in test/usage-auto-refresh.test.js; these assertions pin
  // the wiring so the trigger cannot be removed silently.
  assert.match(usageSource, /const USAGE_AUTO_REFRESH_MS = 60 \* 1000/)
  // Route entry: armed before the first query, one initial trigger per entry.
  assert.match(usageSource, /usageAutoRefreshArm\(\)\s*\n\s*if \(options\.keepDashboard !== true\) void usageAutoRefreshTick\(\)/)
  // Poll + focus + visibility all funnel through one throttle-aware trigger.
  assert.match(usageSource, /function usageAutoRefreshTick\(\)[\s\S]*?usageRefresh\(\{ reason: 'page-open' \}\)/)
  assert.match(usageSource, /window\.addEventListener\('focus', focus\)/)
  assert.match(usageSource, /document\.addEventListener\('visibilitychange', visibility\)/)
  // A poll must re-arm itself and must not stack calls.
  assert.match(usageSource, /if \(currentRoute === 'usage'\) usageAutoRefreshSchedule\(\)/)
  assert.match(usageSource, /if \(usageAutoRefreshInFlight\) \{\s*\n\s*usageAutoRefreshSchedule\(\)/)
  // Leaving the route drops the timer, both listeners and the IPC subscription.
  assert.match(usageSource, /function usageDeactivate\(\)[\s\S]*?usageAutoRefreshStop\(\)[\s\S]*?usageUnsubscribeProgress\(\)/)
  assert.match(shellSource, /if \(currentRoute === 'usage' && route !== 'usage'\) \{\s*\n\s*if \(typeof usageDeactivate === 'function'\) usageDeactivate\(\)/)
  // A finished background scan repaints in place; it must not blank the page back
  // to the loading card nor destroy an open trend modal.
  assert.match(usageSource, /if \(progress\.done !== true\) return[\s\S]*?void usageRerenderKeepingDashboard\(\)/)
  assert.match(usageSource, /if \(usageTrendModal\) \{\s*\n\s*usageAutoRefreshRenderPending = true/)
  // The old consent-only trigger is gone: the render path owns it now, so the
  // consent handler must not fire a second scan of its own.
  assert.doesNotMatch(usageSource, /usageRefresh\(\{ reason: 'page-open' \}\)\.catch\(\(\) => null\)/)
})

test('the coverage strip shows how stale the numbers are', () => {
  // A bare timestamp reads as "current" at a glance; the relative form is what
  // tells a user they are looking at yesterday's scan.
  assert.match(usageSource, /function usageRelativeTime\(value, now = new Date\(\)\)/)
  assert.match(usageSource, /t\('config\.usage\.coverage\.last-scan-relative', \{ time: usageDateTime\(status\.lastScanAt\), relative \}\)/)
  for (const key of [
    'config.usage.coverage.last-scan-relative',
    'config.usage.coverage.relative-now',
    'config.usage.coverage.relative-minutes',
    'config.usage.coverage.relative-hours',
    'config.usage.coverage.relative-yesterday',
    'config.usage.coverage.relative-days'
  ]) {
    const occurrences = locales.split(`'${key}'`).length - 1
    assert.equal(occurrences, 3, `${key} must exist in all three locale tables`)
  }
})
