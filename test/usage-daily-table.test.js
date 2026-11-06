'use strict'

// AI usage page — daily detail table columns (2026-11-06 feedback).
//
// The table used to carry a 推理 (reasoning tokens) column. It never moved a
// total (this MVP has no cost, and Codex reports reasoning as a subset of 输出),
// and in the data that triggered this change it was 0 on every single day — a
// column that could not inform a decision. It was replaced in place with
// 缓存命中率: the share of a day's prompt tokens the provider already had cached,
// which is where the large majority of these tokens actually go.
//
// The assertions below render the real `config/routes/usage.js` in a VM against
// the real zh-CN locale table, so the pinned contract is the markup a user sees:
// the header order, the derived percentage, the "—" for a day with no prompt,
// and the absence of the old column.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const ROOT = path.join(__dirname, '..')
const USAGE_SOURCE = fs.readFileSync(path.join(ROOT, 'config', 'routes', 'usage.js'), 'utf8')
const USAGE_FORMAT_SOURCE = fs.readFileSync(path.join(ROOT, 'shared', 'usage-format.js'), 'utf8')

// The real locale tables: a stub `t` would let the header copy drift away from
// shared/locales/config.js without this test noticing.
const i18n = require(path.join(ROOT, 'shared', 'i18n.js'))
require(path.join(ROOT, 'shared', 'locales', 'config.js'))

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// `config/routes/usage.js` is a classic script: load the formatter module first
// (same order as config.html), mirror it onto `window` the way the browser does,
// then evaluate the route. Top-level `function` declarations land on the
// context's global object, which is how the shell reaches them too.
function loadRoute() {
  const sandbox = {
    window: {},
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

const dailyRow = (overrides) => ({
  day: '2026-11-06',
  billable_total_tokens: 0,
  total_tokens: 0,
  input_tokens: 0,
  output_tokens: 0,
  cached_input_tokens: 0,
  cache_creation_input_tokens: 0,
  reasoning_output_tokens: 0,
  conversation_count: 0,
  total_cost_usd: null,
  ...overrides
})

const headerLabels = (html) => [...html.matchAll(/<th scope="col"[^>]*>([\s\S]*?)<\/th>/g)]
  .map((match) => match[1].replace(/<[^>]+>/g, '').replace(/[↑↓]/g, '').trim())

const bodyRows = (html) => [...html.matchAll(/<tr data-usage-day="([^"]+)"([^>]*)>([\s\S]*?)<\/tr>/g)].map((match) => ({
  day: match[1],
  className: (match[2].match(/class="([^"]*)"/) || [, ''])[1],
  cells: [...match[3].matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/g)].map((cell) => ({
    text: cell[2],
    title: (cell[1].match(/title="([^"]*)"/) || [, ''])[1]
  }))
}))

test('the daily detail header shows cache hit rate where reasoning used to be', () => {
  const page = loadRoute()
  const html = page.usageDailyTableHtml([dailyRow({ input_tokens: 100, cached_input_tokens: 300 })])

  assert.deepEqual(headerLabels(html), ['日期', '总计', '输入', '输出', '缓存读', '缓存命中率', '对话数'])
  // The old column is gone from the markup, not just hidden.
  assert.doesNotMatch(html, /推理/)
  // Every language carries the new copy (the header resolves through t()).
  for (const language of ['zh-CN', 'en-US', 'zh-TW']) {
    const table = globalThis.__LOCALES[language]
    assert.equal(typeof table['config.usage.table.cache-hit'], 'string', `${language} cache-hit copy`)
    // The three counters the tooltip interpolates: an unknown placeholder is
    // left as literal text by shared/i18n.js, so a renamed one would ship as
    // "{write}" on screen instead of failing.
    const detail = table['config.usage.table.cache-hit-detail']
    assert.equal(typeof detail, 'string', `${language} cache-hit title copy`)
    for (const name of ['read', 'write', 'prompt']) {
      assert.match(detail, new RegExp(`\\{${name}\\}`), `${language} title must interpolate {${name}}`)
    }
    assert.equal(table['config.usage.table.reasoning'], undefined, `${language} reasoning copy removed`)
  }
  assert.equal(globalThis.__LOCALES['en-US']['config.usage.table.cache-hit'], 'Cache hit rate')
  assert.equal(globalThis.__LOCALES['zh-TW']['config.usage.table.cache-hit'], '快取命中率')
})

test('a row reports the cached share of its prompt tokens', () => {
  const page = loadRoute()
  const html = page.usageDailyTableHtml([
    // Real shape from the field screenshot: almost all prompt tokens cached.
    // The distinctive reasoning count must not surface anywhere in the markup.
    dailyRow({ day: '2026-11-06', billable_total_tokens: 19142, input_tokens: 793, output_tokens: 81, cached_input_tokens: 18268, reasoning_output_tokens: 7777, conversation_count: 94 }),
    // Cache writes count as prompt tokens that missed, so they stay in the
    // denominator: 100 read of 400 prompt tokens.
    dailyRow({ day: '2026-11-05', billable_total_tokens: 700, input_tokens: 100, output_tokens: 200, cached_input_tokens: 100, cache_creation_input_tokens: 200 }),
    // A prompt with no cache read at all is a measured 0%, not a blank cell.
    dailyRow({ day: '2026-11-04', billable_total_tokens: 400, input_tokens: 400, cached_input_tokens: 0, conversation_count: 5 })
  ])
  const rows = bodyRows(html)

  assert.deepEqual(rows.map((row) => row.day), ['2026-11-06', '2026-11-05', '2026-11-04'])
  // Every body row has one cell per header column: a dropped or duplicated cell
  // would silently shift the whole table under the wrong labels.
  for (const row of rows) assert.equal(row.cells.length, headerLabels(html).length, `${row.day} cell count`)
  // 18268 / (793 + 18268) = 95.84% -> one decimal, page-wide convention.
  assert.equal(rows[0].cells[5].text, '95.8%')
  assert.equal(rows[0].cells[5].title, '缓存读 18,268 / 缓存写 0 / 提示 Token 19,061')
  // 100 / (100 + 100 + 200) = 25%; the write term is in the tooltip because the
  // row cannot show it (input + cache read would suggest 50%).
  assert.equal(rows[1].cells[5].text, '25%')
  assert.equal(rows[1].cells[5].title, '缓存读 100 / 缓存写 200 / 提示 Token 400')
  assert.equal(rows[2].cells[5].text, '0%')
  // Reasoning tokens still ride along in the row, but the table has no place for
  // them: neither the compact nor the grouped form may appear in the markup.
  assert.doesNotMatch(html, /7,777|7777/)
})

test('a day without prompt tokens keeps the hit rate blank like the token columns', () => {
  const page = loadRoute()
  const html = page.usageDailyTableHtml([
    // Nothing observed at all: the whole row is em-dashes.
    dailyRow({ day: '2026-11-02' }),
    // Only output tokens: the other columns have numbers, but there is no
    // prompt to hit or miss, so 0% would be a fabricated measurement.
    dailyRow({ day: '2026-11-01', billable_total_tokens: 15000, output_tokens: 15000, conversation_count: 2 })
  ])
  const rows = bodyRows(html)

  assert.equal(rows[0].className, 'is-empty')
  assert.deepEqual(rows[0].cells.map((cell) => cell.text), ['2026-11-02', '—', '—', '—', '—', '—', '—'])
  assert.equal(rows[1].className, '')
  assert.deepEqual(rows[1].cells.map((cell) => cell.text), ['2026-11-01', '1.5万', '0', '1.5万', '0', '—', '2'])
})

test('the empty range keeps the seven-column span and adds no reasoning header', () => {
  const page = loadRoute()
  const html = page.usageDailyTableHtml([])
  assert.equal(headerLabels(html).length, 7)
  assert.match(html, /<td class="usage-table-empty" colspan="7">当前区间没有每日记录<\/td>/)
  assert.doesNotMatch(html, /推理/)
})
