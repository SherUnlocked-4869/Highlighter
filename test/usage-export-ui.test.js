'use strict'

// B07: the usage page's exchange surface renders the way the ticket asks for.
//
// The real config/routes/usage.js is evaluated in a VM against the real locale
// tables (same technique as test/usage-daily-table.test.js), so these assertions
// pin the markup a user sees rather than a copied template.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '..')
const USAGE_SOURCE = fs.readFileSync(path.join(ROOT, 'config', 'routes', 'usage.js'), 'utf8')
const USAGE_FORMAT_SOURCE = fs.readFileSync(path.join(ROOT, 'shared', 'usage-format.js'), 'utf8')
const i18n = require(path.join(ROOT, 'shared', 'i18n.js'))
require(path.join(ROOT, 'shared', 'locales', 'config.js'))

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function loadRoute({ prices = [], electronAPI = {} } = {}) {
  const sandbox = {
    window: { electronAPI },
    settings: { usage: { prices } },
    document: {
      documentElement: { dataset: { language: 'zh-CN' } },
      body: { classList: { add() {}, remove() {} }, appendChild() {} },
      createElement: () => ({ dataset: {}, style: {}, classList: { add() {}, remove() {} }, addEventListener() {} }),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      removeEventListener() {}
    },
    view: { innerHTML: '', querySelector: () => null, querySelectorAll: () => [] },
    currentRoute: 'usage',
    t: i18n.t,
    escapeHtml,
    iconMarkup: () => '',
    pageHeader: () => '',
    toast: () => {},
    confirm: () => false,
    errorMessage: (error) => (error && error.message) || String(error || ''),
    updateSettings: async () => {},
    requestAnimationFrame: (fn) => { fn(); return 1 },
    matchMedia: () => ({ matches: false }),
    Intl,
    Date,
    Math,
    Number,
    String,
    Array,
    Object,
    Map,
    Set,
    JSON,
    console,
    setTimeout,
    clearTimeout
  }
  const context = vm.createContext(sandbox)
  vm.runInContext(USAGE_FORMAT_SOURCE, context, { filename: 'shared/usage-format.js' })
  sandbox.window.usageFormat = sandbox.usageFormat
  vm.runInContext(USAGE_SOURCE, context, { filename: 'config/routes/usage.js' })
  return sandbox
}

test('the toolbar exposes export CSV/JSON and the JSON import picker', () => {
  const page = loadRoute({ electronAPI: { usageExport: () => {}, usageImport: () => {} } })
  const html = page.usageTabsHtml([], [], { scanning: false, exchange: { export: true, import: true } })
  assert.match(html, /data-usage-export="csv"/)
  assert.match(html, /data-usage-export="json"/)
  assert.match(html, /data-usage-import>/)
  assert.match(html, /type="file"[^>]*data-usage-import-file/)
  assert.equal(html.includes('导出 CSV'), true)
  assert.equal(html.includes('导出 JSON'), true)
  assert.equal(html.includes('导入 JSON'), true)
  assert.equal(html.includes('usage-export-actions'), true)
  // No path input: the picker only ever produces JSON text.
  assert.equal(html.includes('accept="application/json,.json"'), true)

  // Without the preload surface the buttons are visibly unavailable, not silent.
  const bare = loadRoute()
  const disabled = bare.usageTabsHtml([], [], null)
  assert.match(disabled, /data-usage-export="csv" disabled/)
  assert.match(disabled, /data-usage-export="json" disabled/)
  assert.match(disabled, /data-usage-import disabled/)

  // A build whose main process did not register the channels says so up front.
  const gated = loadRoute({ electronAPI: { usageExport: () => {}, usageImport: () => {} } })
  const gatedHtml = gated.usageTabsHtml([], [], { scanning: false, exchange: { export: false, import: false } })
  assert.match(gatedHtml, /data-usage-export="csv" disabled/)
  assert.match(gatedHtml, /data-usage-import disabled/)
  assert.match(gatedHtml, /当前版本没有导出通道/)
})

test('a host without the exchange channels keeps only the frozen read buttons', () => {
  const page = loadRoute()
  const html = page.usageTabsHtml([], [], { scanning: false })
  // No exchange object (older main) + no preload surface: still disabled.
  assert.match(html, /data-usage-export="csv" disabled/)
})

test('the price editor shows one row per version with effective date and cache-write rate', () => {
  const page = loadRoute({
    prices: [
      { model: 'model-a', input: 1, cached: 0.5, output: 2 },
      { model: 'model-a', input: 4, cached: 2, output: 8, effectiveFrom: '2026-11-20' },
      { model: 'beta', input: 1, cached: 0.1, cachedWrite: 0.5, output: 1 }
    ]
  })
  const html = page.usagePricingHtml([{ model: 'gamma' }], false)
  const fields = [...html.matchAll(/data-usage-price-field="([A-Za-z]+)"/g)].map((match) => match[1])
  assert.equal(fields.includes('effectiveFrom'), true)
  assert.equal(fields.includes('cachedWrite'), true)
  assert.equal(fields.includes('input'), true)
  // model-a has two versions; the model cell is shared through rowspan.
  assert.match(html, /rowspan="2"/)
  assert.match(html, /value="2026-11-20"/)
  assert.equal((html.match(/data-usage-price-model="model-a"/g) || []).length, 2)
  assert.match(html, /data-usage-price-add="model-a"/)
  // A model with a known cache-write rate keeps the value; the base rows stay blank.
  assert.match(html, /value="0\.5"/)
  // gamma has no price yet: one blank base row so a rate can be typed directly.
  assert.match(html, /data-usage-price-model="gamma"/)
  assert.equal(html.includes('data-usage-price-key'), false, 'the old single-row key contract is gone')
  // The versioning rule is explained, not just implied by a date column.
  assert.equal(html.includes('按报表时区逐日选择生效版本'), true)
})

test('the snapshot card lists imported aggregates separately and never a path', () => {
  const page = loadRoute()
  const html = page.usageSnapshotsHtml({
    snapshots: [{
      id: 'sha256:' + 'a'.repeat(64),
      sources: ['codex', 'dsh'],
      from: '2026-11-19',
      to: '2026-11-21',
      days: 3,
      totalTokens: 720,
      importedAt: '2026-11-25T02:00:00.000Z',
      priceVersion: 'p2-1234567890ab'
    }]
  })
  assert.match(html, /id="usageSnapshots"/)
  assert.equal(html.includes('聚合快照'), true)
  assert.equal(html.includes('Codex'), true)
  assert.equal(html.includes('2026-11-19'), true)
  assert.equal(html.includes('3 天'), true)
  assert.equal(html.includes('p2-1234567890ab'), true)
  // Imported snapshots are not folded into the scanned totals (the note says so).
  assert.equal(html.includes('不并入本机扫描总数'), true)
  assert.equal(/[A-Z]:\\\\/.test(html), false, 'no drive-letter path in the snapshot card')
  assert.equal(html.includes('usage-import-preview'), false, 'no preview before a file is picked')

  const empty = page.usageSnapshotsHtml({ snapshots: [] })
  assert.equal(empty.includes('还没有导入过聚合快照'), true)
})
