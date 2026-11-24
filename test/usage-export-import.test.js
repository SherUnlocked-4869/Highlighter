'use strict'

// B07 batch 1: aggregate-snapshot import (preview -> commit), idempotency and
// the IPC/feature wiring that exposes export/import.
//
// Every filesystem write goes to a temp directory, and the feature test injects
// the save dialog and the file writer, so no real dialog opens and no user file
// is touched.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { openUsageStore } = require('../main/services/usage-store')
const { createUsageQuery } = require('../main/services/usage-query')
const { buildUsageReport, reportToCsv, reportToJson } = require('../main/services/usage-export')
const { createUsageSnapshotStore, rangesOverlap } = require('../main/services/usage-snapshot-store')
const { createUsageFeature, install } = require('../main/services/usage-feature')
const {
  MAX_IMPORT_BYTES,
  USAGE_EXCHANGE_CHANNELS,
  USAGE_HANDLE_CHANNELS,
  validateExportArgs,
  validateImportArgs
} = require('../main/ipc/usage-ipc')

const NOW = new Date('2026-11-25T02:00:00.000Z')
const TZ = 'Asia/Shanghai'

function seedRow(source, model, hourStart, input, output) {
  return {
    source,
    model,
    hour_start: hourStart,
    input_tokens: input,
    output_tokens: output,
    total_tokens: input + output,
    billable_total_tokens: input + output,
    conversation_count: 1
  }
}

const SEED = [
  seedRow('codex', 'model-a', '2026-11-19T12:00:00.000Z', 100, 20),
  seedRow('dsh', 'model-b', '2026-11-19T13:00:00.000Z', 200, 40),
  seedRow('opencode', 'model-a', '2026-11-21T12:00:00.000Z', 300, 60),
  seedRow('codex', 'model-a', '2026-11-04T12:00:00.000Z', 400, 80)
]

const PRICES = [
  { model: 'model-a', input: 1, cached: 0.5, output: 2 },
  { model: 'model-a', input: 4, cached: 2, output: 8, effectiveFrom: '2026-11-20' },
  { model: 'model-b', input: 3, cached: 1, output: 6 }
]

function seedStore(dbPath) {
  const store = openUsageStore({ dbPath, now: () => NOW })
  for (const source of ['codex', 'dsh', 'opencode']) {
    store.commitScan({ source, upserts: SEED.filter((row) => row.source === source) })
  }
  return store
}

function reportFor(query, from, to) {
  return buildUsageReport({
    daily: query.daily({ period: 'custom', tz: TZ, from, to }),
    breakdown: query.breakdown({ period: 'custom', tz: TZ, from, to, scope: 'model' }),
    prices: PRICES,
    generatedAt: NOW
  })
}

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hl-usage-import-' + label + '-'))
}

// Close every open handle BEFORE deleting the directory: Windows refuses to
// unlink a file that still has an open SQLite handle. Node runs after hooks in
// registration order, so one combined hook is easier to reason about than two.
function cleanup(t, dir, closers = []) {
  t.after(() => {
    for (const close of closers) {
      try { close() } catch {}
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch (_error) {
      // A leaked handle must not turn a passing test into a red one; the temp
      // root is cleaned by the OS.
    }
  })
}

test('import previews sources/period/rows, then refuses overlaps and stays idempotent', (t) => {
  const dir = tempDir('store')
  const dbPath = path.join(dir, 'usage.db')
  const store = seedStore(dbPath)
  const query = createUsageQuery({ getStore: () => store, now: () => NOW, getPrices: () => PRICES })
  cleanup(t, dir, [() => store.close()])

  const snapshots = createUsageSnapshotStore({ directory: path.join(dir, 'snapshots'), fs, now: () => NOW })
  const reportA = reportFor(query, '2026-11-19', '2026-11-21')
  const previewA = snapshots.preview(reportToJson(reportA))
  assert.equal(previewA.schemaVersion, 1)
  assert.deepEqual(previewA.sources, ['codex', 'dsh', 'opencode'])
  assert.equal(previewA.from, '2026-11-19')
  assert.equal(previewA.to, '2026-11-21')
  assert.equal(previewA.totalRows, 3)
  assert.equal(previewA.days, 3)
  assert.deepEqual(previewA.duplicates, [])
  assert.equal(previewA.mergeable, true)
  assert.equal(previewA.totals.total, 720)

  const first = snapshots.commit(reportToJson(reportA))
  assert.equal(first.imported, true)
  assert.equal(first.duplicate, false)
  assert.equal(snapshots.list().length, 1)
  assert.equal(snapshots.list()[0].totalTokens, 720)

  // Same snapshotId again: no new file, no new totals.
  const again = snapshots.commit(reportToJson(reportA))
  assert.equal(again.imported, false)
  assert.equal(again.duplicate, true)
  assert.equal(again.reason, 'duplicate')
  assert.equal(snapshots.list().length, 1)
  assert.equal(snapshots.list()[0].totalTokens, 720)

  // Same month, shifted by one day: a different id whose range intersects.
  const reportB = reportFor(query, '2026-11-20', '2026-11-22')
  assert.notEqual(reportB.snapshotId, reportA.snapshotId)
  const previewB = snapshots.preview(reportToJson(reportB))
  assert.equal(previewB.mergeable, false)
  assert.equal(previewB.reason, 'range-overlap')
  assert.equal(previewB.duplicates.some((entry) => entry.id === reportA.snapshotId && entry.kind === 'overlap'), true)
  assert.throws(() => snapshots.commit(reportToJson(reportB)), /overlaps an imported snapshot/)
  assert.equal(snapshots.list().length, 1)

  // A disjoint range merges alongside it.
  const reportC = reportFor(query, '2026-11-01', '2026-11-05')
  const previewC = snapshots.preview(reportToJson(reportC))
  assert.equal(previewC.mergeable, true)
  assert.equal(snapshots.commit(reportToJson(reportC)).imported, true)
  assert.equal(snapshots.list().length, 2)
  assert.deepEqual(snapshots.list().map((entry) => entry.from).sort(), ['2026-11-01', '2026-11-19'])

  // Overlap helper: touching endpoints count as overlap, adjacent days do not.
  assert.equal(rangesOverlap({ from: '2026-11-19', to: '2026-11-21' }, { from: '2026-11-21', to: '2026-11-23' }), true)
  assert.equal(rangesOverlap({ from: '2026-11-19', to: '2026-11-21' }, { from: '2026-11-22', to: '2026-11-23' }), false)

  // Nothing sensitive is persisted, and the file name is the identity's hex stem.
  const names = fs.readdirSync(path.join(dir, 'snapshots'))
  assert.equal(names.length, 2)
  assert.equal(names.every((name) => /^[a-f0-9]{64}\.json$/.test(name)), true)
  for (const name of names) {
    const stored = fs.readFileSync(path.join(dir, 'snapshots', name), 'utf8')
    assert.equal(stored.includes('PRIVATE'), false)
    assert.equal(stored.includes('"title"'), false)
  }
})

test('a report without a verifiable identity is refused before any write', (t) => {
  const dir = tempDir('identity')
  const snapshots = createUsageSnapshotStore({ directory: path.join(dir, 'snapshots'), fs, now: () => NOW })
  cleanup(t, dir)
  assert.throws(() => snapshots.preview('{"schemaVersion":1,"kind":"usage-daily-aggregate"}'), /identity is missing/)
  assert.throws(() => snapshots.preview('not a report'), /not valid JSON/)
  assert.equal(fs.existsSync(path.join(dir, 'snapshots')), false)
})

test('exchange IPC validators keep the frozen read surface untouched', () => {
  assert.equal(USAGE_HANDLE_CHANNELS.length, 8)
  assert.equal(USAGE_HANDLE_CHANNELS.includes('usage:export'), false)
  assert.equal(USAGE_HANDLE_CHANNELS.includes('usage:import'), false)
  assert.deepEqual(USAGE_EXCHANGE_CHANNELS, ['usage:export', 'usage:import'])

  const weekly = validateExportArgs({ period: 'week', format: 'json' })
  assert.equal(weekly.period, 'week')
  assert.equal(weekly.format, 'json')
  assert.equal(weekly.save, false)
  assert.equal(weekly.tz, 'UTC')
  assert.equal(validateExportArgs({ format: 'csv', save: true }).format, 'csv')
  assert.equal(validateExportArgs({ format: 'csv', save: true }).save, true)
  assert.equal(validateExportArgs({}).format, 'csv')
  assert.throws(() => validateExportArgs({ format: 'xml' }), /usage: invalid export format/)
  assert.throws(() => validateExportArgs({ period: 'custom' }), /requires from and to/)
  assert.throws(() => validateExportArgs('nope'), /args must be an object/)

  assert.equal(validateImportArgs({ payload: '{}' }).mode, 'preview')
  assert.equal(validateImportArgs({ mode: 'commit', payload: '{"a":1}' }).payload, '{"a":1}')
  assert.equal(validateImportArgs({ mode: 'preview', payload: { a: 1 } }).mode, 'preview')
  assert.throws(() => validateImportArgs({}), /payload must be a JSON object or string/)
  assert.throws(() => validateImportArgs({ mode: 'merge', payload: '{}' }), /invalid import mode/)
  assert.throws(() => validateImportArgs({ mode: 'preview', payload: '   ' }), /payload is empty/)
  assert.throws(() => validateImportArgs({ mode: 'preview', payload: ' '.repeat(MAX_IMPORT_BYTES + 1) }), /payload is too large/)
  assert.throws(() => validateImportArgs({ mode: 'preview', payload: [] }), /payload must be a JSON object or string/)
})

function fakeIpcMain({ policyThrows = false } = {}) {
  const handlers = new Map()
  return {
    handlers,
    assertComplete: () => true,
    handle: (channel, handler) => {
      if (policyThrows && (channel === 'usage:export' || channel === 'usage:import')) {
        throw new Error(`IPC channel has no sender policy: ${channel}`)
      }
      handlers.set(channel, handler)
    },
    on: () => {}
  }
}

function plainIpcMain() {
  const handlers = new Map()
  return { handlers, handle: (channel, handler) => handlers.set(channel, handler), on: () => {} }
}

test('exchange channels register only on the secure facade and degrade without a policy', async (t) => {
  const dir = tempDir('install')
  const usageDir = path.join(dir, 'usage')
  const featureDeps = (ipcMain) => ({
    ipcMain,
    app: { getPath: () => dir },
    getPaths: () => ({ usage: usageDir }),
    getSettings: () => ({ usage: { enabled: false } }),
    log: () => {}
  })
  const installed = []
  cleanup(t, dir, [() => { for (const feature of installed) feature.quiesce() }])

  const plain = plainIpcMain()
  const plainFeature = install(featureDeps(plain))
  installed.push(plainFeature)
  assert.deepEqual([...plain.handlers.keys()].sort(), [...USAGE_HANDLE_CHANNELS].sort())
  assert.deepEqual((await plainFeature.getStatus()).exchange, { export: false, import: false })

  const secure = fakeIpcMain()
  const secureFeature = install(featureDeps(secure))
  installed.push(secureFeature)
  assert.deepEqual([...secure.handlers.keys()].sort(), [...USAGE_HANDLE_CHANNELS, ...USAGE_EXCHANGE_CHANNELS].sort())
  assert.deepEqual((await secureFeature.getStatus()).exchange, { export: true, import: true })
  // The registered handler still validates before it reaches the feature.
  await assert.rejects(async () => secure.handlers.get('usage:export')(null, { format: 'xml' }), /usage: invalid export format/)

  // A build whose ipc-security policy does not list the channels must still start,
  // and must report the capability as unavailable so the page disables the buttons.
  const blocked = fakeIpcMain({ policyThrows: true })
  const blockedFeature = install(featureDeps(blocked))
  installed.push(blockedFeature)
  assert.deepEqual([...blocked.handlers.keys()].sort(), [...USAGE_HANDLE_CHANNELS].sort())
  assert.deepEqual((await blockedFeature.getStatus()).exchange, { export: false, import: false })
})

test('feature export writes through the injected save dialog and import lists the snapshot', async (t) => {
  const dir = tempDir('feature')
  const usageDir = path.join(dir, 'usage')
  fs.mkdirSync(usageDir, { recursive: true })
  seedStore(path.join(usageDir, 'usage.db')).close()

  const writes = []
  const dialogs = []
  let dialogMode = 'save'
  const feature = createUsageFeature({
    app: { getPath: () => dir },
    getPaths: () => ({ usage: usageDir }),
    getSettings: () => ({ usage: { enabled: false, prices: PRICES } }),
    now: () => NOW,
    log: () => {},
    dialog: {
      showSaveDialog: async (_window, options) => {
        dialogs.push(options)
        if (dialogMode === 'cancel') return { canceled: true }
        return { canceled: false, filePath: path.join(dir, options.defaultPath.split(/[\\/]/).pop()) }
      }
    },
    writeFile: async (target, content) => { writes.push({ target, content }) }
  })
  cleanup(t, dir, [() => feature.quiesce()])

  const exported = await feature.handlers.export({
    period: 'custom', tz: TZ, from: '2026-11-19', to: '2026-11-21', format: 'csv', save: true
  })
  assert.equal(exported.canceled, false)
  assert.equal(exported.format, 'csv')
  assert.equal(exported.rows, 3)
  assert.equal(exported.schemaVersion, 1)
  assert.match(exported.fileName, /^Highlighter-usage-2026-11-19_2026-11-21-p2-[a-f0-9]{12}\.csv$/)
  assert.equal(Object.hasOwn(exported, 'content'), false, 'a saved export does not echo the report back')
  assert.equal(dialogs.length, 1)
  const { t: translate } = require('../main/services/i18n-bootstrap')
  assert.equal(dialogs[0].title, translate('config.usage.dashboard.export-title'))
  assert.deepEqual(dialogs[0].filters[0].extensions, ['csv'])
  assert.equal(writes.length, 1)
  assert.equal(writes[0].target.endsWith('.csv'), true)
  assert.match(writes[0].content, /\r\n/)
  assert.match(writes[0].content, /^schemaVersion,1/)
  assert.match(writes[0].content, /day,inputTokens/)
  for (const marker of ['PRIVATE_SESSION_TITLE', 'PRIVATE_FULL_PROJECT', 'raw-session-id']) {
    assert.equal(writes[0].content.includes(marker), false, marker)
  }

  // Cancelling leaves no file behind and returns no content.
  dialogMode = 'cancel'
  const canceled = await feature.handlers.export({ period: 'custom', tz: TZ, from: '2026-11-19', to: '2026-11-21', format: 'json', save: true })
  assert.equal(canceled.canceled, true)
  assert.equal(Object.hasOwn(canceled, 'content'), false)
  assert.equal(writes.length, 1)

  // Unsaved JSON export returns the document; importing it previews then commits.
  const unsaved = await feature.handlers.export({ period: 'custom', tz: TZ, from: '2026-11-19', to: '2026-11-21', format: 'json', save: false })
  assert.equal(typeof unsaved.content, 'string')
  const preview = feature.handlers.import({ mode: 'preview', payload: unsaved.content })
  assert.equal(preview.mergeable, true)
  assert.equal(preview.totalRows, 3)
  const committed = feature.handlers.import({ mode: 'commit', payload: unsaved.content })
  assert.equal(committed.imported, true)
  const duplicate = feature.handlers.import({ mode: 'commit', payload: unsaved.content })
  assert.equal(duplicate.imported, false)

  const status = await feature.getStatus()
  assert.deepEqual(status.exchange, { export: false, import: false }, 'createUsageFeature alone registers nothing')
  assert.equal(status.snapshots.length, 1)
  assert.deepEqual(Object.keys(status.snapshots[0]).sort(), [
    'costCny', 'days', 'from', 'generatedAt', 'id', 'importedAt', 'priceVersion', 'sources', 'to', 'totalTokens', 'unpricedModels'
  ])
  assert.equal(status.snapshots[0].from, '2026-11-19')
  assert.equal(status.snapshots[0].days, 3)
})

test('the CSV export of the feature agrees with the JSON export row for row', async (t) => {
  const dir = tempDir('agree')
  const usageDir = path.join(dir, 'usage')
  fs.mkdirSync(usageDir, { recursive: true })
  seedStore(path.join(usageDir, 'usage.db')).close()
  const feature = createUsageFeature({
    app: { getPath: () => dir },
    getPaths: () => ({ usage: usageDir }),
    getSettings: () => ({ usage: { enabled: false, prices: PRICES } }),
    now: () => NOW,
    log: () => {}
  })
  cleanup(t, dir, [() => feature.quiesce()])

  const args = { period: 'custom', tz: TZ, from: '2026-11-19', to: '2026-11-21', save: false }
  const json = JSON.parse((await feature.handlers.export({ ...args, format: 'json' })).content)
  const csv = (await feature.handlers.export({ ...args, format: 'csv' })).content
  const table = csv.split('\r\n').filter(Boolean)
  const header = table.findIndex((line) => line.startsWith('day,inputTokens'))
  assert.equal(header > 0, true, 'metadata block precedes the table')
  const rows = table.slice(header + 1).map((line) => line.split(','))
  assert.equal(rows.length, json.daily.length)
  for (let index = 0; index < rows.length; index += 1) {
    const [day, input, cacheRead, cacheWrite, output, total, cost, state] = rows[index]
    const expected = json.daily[index]
    assert.equal(day, expected.day)
    assert.equal(Number(input), expected.input)
    assert.equal(Number(cacheRead), expected.cacheRead)
    assert.equal(Number(cacheWrite), expected.cacheWrite)
    assert.equal(Number(output), expected.output)
    assert.equal(Number(total), expected.total)
    assert.equal(cost, expected.costCny === null
      ? (expected.priceState === 'none' ? '' : 'unknown')
      : String(expected.costCny))
    assert.equal(state, expected.priceState)
  }
  assert.equal(reportToCsv(json).includes('priceVersion'), true)
  assert.equal(reportToJson(json).includes('"snapshotId"'), true)
})
