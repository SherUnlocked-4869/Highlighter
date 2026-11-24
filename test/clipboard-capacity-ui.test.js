'use strict'

// B05 settings-page contract. The capacity card is plain renderer code, so the
// numbers it displays, the live projection and the panel jump are pinned here
// in source: the static page test cannot boot Electron, and the pure tests
// already cover the arithmetic.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const route = fs.readFileSync(path.join(root, 'config', 'routes', 'clipboard.js'), 'utf8')
const panel = fs.readFileSync(path.join(root, 'clipboard', 'clipboard.js'), 'utf8')
const domain = fs.readFileSync(path.join(root, 'main', 'domains', 'clipboard', 'index.js'), 'utf8')
const ipc = fs.readFileSync(path.join(root, 'main', 'ipc', 'clipboard-ipc.js'), 'utf8')
const moduleSource = fs.readFileSync(path.join(root, 'main', 'services', 'clipboard-capacity.js'), 'utf8')

test('the settings page renders the capacity view from the status snapshot', () => {
  assert.match(route, /window\.electronAPI\.getClipboardStatus\(\)/)
  assert.match(route, /s\.capacity\.counts\.ordinary\.value/)
  assert.match(route, /s\.capacity\.counts\.pinned\.value/)
  assert.match(route, /clipboardCapacityMarkup\(s\)/)
  assert.match(route, /id="clipboard-capacity-body"/)
  assert.match(route, /clipboard\.capacity\.title/)
  assert.match(route, /clipboard\.capacity\.skip-title/)
  assert.match(route, /clipboard\.capacity\.pinned-squeeze/)
  // Pins are never described as an eviction candidate; the copy states they are kept.
  assert.match(route, /clipboard\.capacity\.pinned-kept/)
  assert.match(route, /pinnedNeverEvicted: true/)
})

test('estimated and exact numbers are tagged in the card, not just colour-coded', () => {
  assert.match(route, /function clipboardCapacityEstimateTag\(metric\)/)
  assert.match(route, /metric\?\.estimated === true \? t\('clipboard\.capacity\.estimated'\) : t\('clipboard\.capacity\.exact'\)/)
  assert.match(route, /≈ \$\{clipboardCapacityMiB\(bytes\.thumbnails\.value\)\}/)
  assert.match(route, /clipboardCapacityMiB\(budgets\.disk\.limit\.value\)/)
  assert.match(route, /clipboard\.capacity\.bytes-shared/)
})

test('the lower-limit preview is local: the slider never calls IPC', () => {
  const start = route.indexOf('const updatePreviewText')
  const end = route.indexOf('const readStatus')
  assert.ok(start > 0 && end > start, 'the preview block exists')
  const block = route.slice(start, end)
  assert.match(block, /clipboardPreviewEviction\(capacityCounts\.ordinary, capacityCounts\.pinned, Number\(preview\.value\)\)/)
  assert.doesNotMatch(block, /electronAPI|await |ipc/i, 'moving the slider must not wait on the main process')
  assert.match(block, /previewField\.oninput/)
  assert.match(block, /limitField\.value = previewField\.value/)
  assert.match(block, /t\('clipboard\.capacity\.preview-evict'/)
  assert.match(block, /t\('clipboard\.capacity\.preview-none'/)
})

test('the preview reuses the number field the save path reads', () => {
  assert.match(route, /id="clipboard-limit-preview"/)
  assert.match(route, /type="range"/)
  assert.match(route, /Number\(document\.getElementById\(`clipboard-\$\{key\}`\)\.value\)/)
  assert.match(route, /patch\[key\] < value\[key\]/, 'the existing lower-limit confirmation still runs')
})

test('the panel offers Pinned only as a one-click view that reuses the existing filter', () => {
  assert.match(panel, /const pinnedJump = document\.createElement\('button'\)/)
  assert.match(panel, /pinnedJump\.className = 'quiet-button'/)
  assert.match(panel, /\$\('pinned'\)\.click\(\)/, 'the jump goes through the existing chip handler')
  assert.match(panel, /status\?\.capacity\?\.pinnedSqueeze\?\.possible === true/)
  assert.match(panel, /const statusRail = refreshNode\?\.closest\?\.\('\.status-rail'\)/)
  assert.match(panel, /if \(statusRail\) statusRail\.insertBefore\(pinnedJump, refreshNode\)/)
  assert.match(panel, /clipboard\.pinned-only/)
  assert.match(panel, /pinnedJump\.hidden = pinnedOnly \|\|/)
})

test('the main process attaches the capacity view without a native method', () => {
  assert.match(domain, /const \{ computeCapacity, emptySkipSession, nextSkipSession \} = require\('\.\.\/\.\.\/services\/clipboard-capacity'\)/)
  assert.match(domain, /service\.on\('status', \(value\) => send\('clipboard:status-changed', statusWithCapacity\(observeStatus\(value\)\)\)\)/)
  assert.match(domain, /function statusSnapshot\(\) \{ return statusWithCapacity\(service\.snapshot\(\)\) \}/)
  assert.match(domain, /function statusSnapshotFor\(event\)/, 'the settings window can ask for one fresh status round trip')
  assert.match(domain, /commitClear, statusSnapshot, statusSnapshotFor \}/, 'the IPC registration receives the enriched snapshots')
  assert.match(domain, /status: statusWithCapacity\(service\.snapshot\(\)\)/)
  assert.match(ipc, /handle\('status', \(event\) => \{/)
  assert.match(ipc, /if \(domain\.statusSnapshotFor\) return domain\.statusSnapshotFor\(event\)/)
  // No new sidecar method is requested by the capacity path.
  assert.doesNotMatch(domain, /request\('capacity'|request\('stats'/)
})

test('every capacity/skip key used by the two windows exists in all three tables', () => {
  globalThis.__LOCALES = {}
  const localeFile = path.join(root, 'shared', 'locales', 'clipboard.js')
  delete require.cache[require.resolve(localeFile)]
  require(localeFile)
  const tables = globalThis.__LOCALES
  const used = new Set()
  for (const source of [route, panel, moduleSource]) {
    for (const match of source.matchAll(/(['"])(clipboard\.[a-z0-9.-]+)\1/g)) used.add(match[2])
  }
  const keys = [...used].filter((key) => key.startsWith('clipboard.capacity.') || key.startsWith('clipboard.skip.') || key.startsWith('clipboard.pinned-only'))
  assert.ok(keys.length >= 30, 'the card and panel name their copy through locale keys')
  const missing = []
  for (const key of keys) {
    for (const language of ['zh-CN', 'en-US', 'zh-TW']) {
      if (!Object.hasOwn(tables[language] || {}, key)) missing.push(`${key} (${language})`)
    }
  }
  assert.deepEqual(missing, [], 'a missing table entry would render the raw key')
  for (const language of ['zh-CN', 'en-US', 'zh-TW']) {
    for (const key of ['clipboard.capacity.preview-evict', 'clipboard.capacity.preview-none', 'clipboard.capacity.skip-last', 'clipboard.capacity.remaining']) {
      assert.match(tables[language][key], /\{(limit|count|pinned|reason|free|disk)\}/, `${key} keeps its placeholder in ${language}`)
    }
  }
})

test('the capacity card renders localized exact/estimated values, not raw keys', () => {
  const routeModule = require('../config/routes/clipboard')
  const capacityModule = require('../main/services/clipboard-capacity')
  const i18n = require('../shared/i18n')
  globalThis.__LOCALES = {}
  const localeFile = path.join(root, 'shared', 'locales', 'clipboard.js')
  delete require.cache[require.resolve(localeFile)]
  require(localeFile)
  i18n.setLanguage('en-US')
  globalThis.t = i18n.t
  globalThis.escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char])
  const view = capacityModule.computeCapacity({
    status: { itemCount: 7, pinnedCount: 2, payloadBytes: 10 * 1048576, actualDiskBytes: 13 * 1048576, skipped: { excluded: 2, storage_error: 1 } },
    settings: { historyLimit: 100, retentionDays: 30, maxPayloadMiB: 256, maxDiskMiB: 384, maxThumbnailMiB: 64 }
  })
  const html = routeModule.clipboardCapacityMarkup({ capacity: view })
  assert.match(html, /Unpinned records/)
  assert.match(html, /Pinned records/)
  assert.match(html, /Original payloads/)
  assert.match(html, /Estimated/)
  assert.match(html, /≈/)
  assert.match(html, /Source app excluded/)
  assert.match(html, /Storage full or write failed/)
  assert.match(html, /never removed automatically/)
  assert.match(html, /Pinned records may be using the budget/)
  assert.match(html, /\{free\}|of original budget left/)
  assert.doesNotMatch(html, /clipboard\.(capacity|skip)\./)
  assert.doesNotMatch(html, /undefined|NaN/)
})

test('the skip copy never displays an excluded source name or content', () => {
  globalThis.__LOCALES = {}
  const localeFile = path.join(root, 'shared', 'locales', 'clipboard.js')
  delete require.cache[require.resolve(localeFile)]
  require(localeFile)
  const tables = globalThis.__LOCALES
  for (const language of ['zh-CN', 'en-US', 'zh-TW']) {
    for (const [key, value] of Object.entries(tables[language])) {
      if (!key.startsWith('clipboard.skip.') || !value.includes('{')) continue
      assert.fail(`${key} in ${language} must stay parameter-free so no payload can leak into it`)
    }
    assert.match(tables[language]['clipboard.capacity.skip-since'], /排除|excluded/i)
  }
})
