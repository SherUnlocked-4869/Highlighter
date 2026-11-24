'use strict'

// B07 batch 1: usage report export (main/services/usage-export.js) and the
// effective-dated price table it stamps.
//
// The tests below seed a throwaway SQLite store in a temp directory - never the
// real user data - and compare the exported totals with an oracle computed from
// the seed rows with plain UTC arithmetic (Asia/Shanghai has no DST), so a bug in
// the query's timezone folding cannot also produce the "expected" number.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { openUsageStore } = require('../main/services/usage-store')
const { createUsageQuery } = require('../main/services/usage-query')
const {
  REPORT_SCHEMA_VERSION,
  buildUsageReport,
  csvField,
  parseUsageReport,
  reportFileName,
  reportToCsv,
  reportToJson,
  snapshotIdFor
} = require('../main/services/usage-export')
const {
  assertUsagePrices,
  createPriceTable,
  migrateUsagePrices,
  normalizeUsagePrices,
  priceVersionStamp
} = require('../main/services/usage-pricing')

const NOW = new Date('2026-11-25T02:00:00.000Z')
const TZ = 'Asia/Shanghai'

function shanghaiDay(iso) {
  // Independent oracle for the only timezone this file uses: UTC+8, no DST.
  return new Date(Date.parse(iso) + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

function seedRow(source, model, hourStart, tokens) {
  const input = tokens.input || 0
  const cached = tokens.cached || 0
  const cacheWrite = tokens.cacheWrite || 0
  const output = tokens.output || 0
  return {
    source,
    model,
    hour_start: hourStart,
    input_tokens: input,
    cached_input_tokens: cached,
    cache_creation_input_tokens: cacheWrite,
    output_tokens: output,
    total_tokens: input + cached + cacheWrite + output,
    billable_total_tokens: input + cached + cacheWrite + output,
    conversation_count: tokens.conversations ?? 1
  }
}

function openHarness(t, prices = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-usage-export-'))
  const dbPath = path.join(root, 'usage.db')
  const store = openUsageStore({ dbPath, now: () => NOW })
  const query = createUsageQuery({ getStore: () => store, now: () => NOW, getPrices: () => prices })
  t.after(() => {
    try { store.close() } catch {}
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { root, dbPath, store, query }
}

// Cross-midnight fixture: the two local days of 2026-11-20/21 in Asia/Shanghai
// split at 16:00Z. Three sources, two models, plus the same rows re-committed
// twice to stand in for a duplicated/rotated log.
const SEED = [
  seedRow('codex', 'model-a', '2026-11-20T15:30:00.000Z', { input: 1000, cached: 200, cacheWrite: 100, output: 300 }),
  seedRow('codex', 'model-a', '2026-11-20T16:30:00.000Z', { input: 2000, cached: 400, cacheWrite: 200, output: 600 }),
  seedRow('dsh', 'model-a', '2026-11-20T15:30:00.000Z', { input: 500, cached: 100, cacheWrite: 0, output: 150 }),
  seedRow('dsh', 'model-b', '2026-11-20T16:30:00.000Z', { input: 700, cached: 140, cacheWrite: 0, output: 210 }),
  seedRow('opencode', 'model-b', '2026-11-20T15:30:00.000Z', { input: 300, cached: 60, cacheWrite: 0, output: 90 }),
  seedRow('opencode', 'model-b', '2026-11-20T16:30:00.000Z', { input: 900, cached: 180, cacheWrite: 0, output: 270 })
]

function oracleDays(rows) {
  const days = new Map()
  for (const row of rows) {
    const day = shanghaiDay(row.hour_start)
    const entry = days.get(day) || { day, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 }
    entry.input += row.input_tokens
    entry.cacheRead += row.cached_input_tokens
    entry.cacheWrite += row.cache_creation_input_tokens
    entry.output += row.output_tokens
    entry.total += row.billable_total_tokens
    days.set(day, entry)
  }
  return days
}

function exportParams(query) {
  const daily = query.daily({ period: 'custom', tz: TZ, from: '2026-11-20', to: '2026-11-21' })
  const breakdown = query.breakdown({ period: 'custom', tz: TZ, from: '2026-11-20', to: '2026-11-21', scope: 'model' })
  return { daily, breakdown }
}

test('three sources, two models and a midnight split export the same totals the rows add up to', (t) => {
  const { store, query } = openHarness(t)
  store.commitScan({ source: 'codex', upserts: SEED.filter((row) => row.source === 'codex') })
  store.commitScan({ source: 'dsh', upserts: SEED.filter((row) => row.source === 'dsh') })
  store.commitScan({ source: 'opencode', upserts: SEED.filter((row) => row.source === 'opencode') })

  const report = buildUsageReport({ ...exportParams(query), generatedAt: NOW, prices: [] })
  const expected = oracleDays(SEED)
  assert.deepEqual(report.daily.map((row) => row.day), ['2026-11-20', '2026-11-21'])
  for (const row of report.daily) {
    const want = expected.get(row.day)
    assert.equal(row.input, want.input, `${row.day} input`)
    assert.equal(row.cacheRead, want.cacheRead, `${row.day} cache read`)
    assert.equal(row.cacheWrite, want.cacheWrite, `${row.day} cache write`)
    assert.equal(row.output, want.output, `${row.day} output`)
    assert.equal(row.total, want.total, `${row.day} total`)
  }
  assert.equal(report.totals.total, SEED.reduce((sum, row) => sum + row.billable_total_tokens, 0))
  assert.equal(report.totals.days, 2)
  // The midnight boundary is what makes the two days different rows: 15:30Z and
  // 16:30Z land on 2026-11-20 and 2026-11-21 respectively.
  const late = report.daily[1]
  assert.equal(late.input, 2000 + 700 + 900)
  assert.equal(late.total, 3200 + 1050 + 1350)
})

test('a duplicated or rotated log cannot inflate the exported total', (t) => {
  const { store, query } = openHarness(t)
  for (const source of ['codex', 'dsh', 'opencode']) {
    const rows = SEED.filter((row) => row.source === source)
    store.commitScan({ source, upserts: rows })
    // Same buckets again: the parser re-read a duplicated line / the rotated
    // file kept the same session hours. Absolute bucket upserts must be a no-op.
    store.commitScan({ source, upserts: rows })
  }
  const before = buildUsageReport({ ...exportParams(query), generatedAt: NOW })
  // Rotation that ALSO contains one genuinely new hour: only that hour is added.
  store.commitScan({ source: 'codex', upserts: [seedRow('codex', 'model-a', '2026-11-21T01:00:00.000Z', { input: 10, output: 5 })] })
  const after = buildUsageReport({ ...exportParams(query), generatedAt: NOW })
  assert.equal(before.totals.total, SEED.reduce((sum, row) => sum + row.billable_total_tokens, 0))
  assert.equal(after.totals.total - before.totals.total, 15)
  assert.equal(store.countBuckets(), SEED.length + 1)
})

test('CSV is RFC4180: CRLF rows, doubled quotes, comma and newline quoting', () => {
  assert.equal(csvField('plain'), 'plain')
  assert.equal(csvField('a,b'), '"a,b"')
  assert.equal(csvField('say "hi"'), '"say ""hi"""')
  assert.equal(csvField('line1\nline2'), '"line1\nline2"')
  assert.equal(csvField('line1\r\nline2'), '"line1\r\nline2"')
  assert.equal(csvField(null), '')
  const report = buildUsageReport({
    daily: {
      period: 'custom', from: '2026-11-20', to: '2026-11-20', tz: TZ,
      rows: [{ day: '2026-11-20', input_tokens: 1, total_tokens: 1, billable_total_tokens: 1, costCny: null, conversation_count: 1 }]
    },
    model: 'weird "model", x',
    generatedAt: NOW
  })
  const csv = reportToCsv(report)
  assert.equal(csv.includes('\r\n'), true)
  assert.equal(csv.includes('\r\n\r\n'), true, 'metadata block and table are separated by a blank line')
  assert.match(csv, /modelFilter,"weird ""model"", x"/)
  // A model name that starts with a formula character is neutralized, not executed.
  const formula = buildUsageReport({
    daily: { period: 'custom', from: '2026-11-20', to: '2026-11-20', tz: TZ, rows: [{ day: '2026-11-20', input_tokens: 1, total_tokens: 1, billable_total_tokens: 1, conversation_count: 1 }] },
    model: '=SUM(A1)',
    generatedAt: NOW
  })
  assert.match(reportToCsv(formula), /modelFilter,'=SUM\(A1\)/)
  assert.equal(csv.split('\r\n').at(-2).startsWith('2026-11-20,'), true)
  assert.equal(report.schemaVersion, REPORT_SCHEMA_VERSION)
})

test('JSON carries the schema version, semantics and a content-derived identity', () => {
  const report = buildUsageReport({
    daily: { period: 'month', from: '2026-11-01', to: '2026-11-02', tz: 'UTC', rows: [{ day: '2026-11-01', input_tokens: 10, total_tokens: 10, billable_total_tokens: 10, conversation_count: 1 }] },
    sources: ['codex', 'dsh'],
    prices: [],
    generatedAt: NOW
  })
  const parsed = JSON.parse(reportToJson(report))
  assert.equal(parsed.schemaVersion, 1)
  assert.equal(parsed.kind, 'usage-daily-aggregate')
  assert.match(parsed.snapshotId, /^sha256:[a-f0-9]{64}$/)
  assert.deepEqual(parsed.sources, ['codex', 'dsh'])
  assert.equal(parsed.timeZone, 'UTC')
  assert.equal(parsed.dedupe.text.length > 40, true)
  assert.equal(parsed.tokenSemantics.input.length > 0, true)
  assert.equal(parsed.pricing.currency, 'CNY')
  assert.equal(parsed.pricing.unit, 'CNY per 1M tokens')
  assert.equal(parsed.unknownPrice.marker, 'unknown')
  // The id is a function of the content only, not of generatedAt.
  const later = buildUsageReport({
    daily: { period: 'month', from: '2026-11-01', to: '2026-11-02', tz: 'UTC', rows: [{ day: '2026-11-01', input_tokens: 10, total_tokens: 10, billable_total_tokens: 10, conversation_count: 1 }] },
    sources: ['codex', 'dsh'],
    generatedAt: new Date('2027-01-01T00:00:00.000Z')
  })
  assert.equal(later.snapshotId, report.snapshotId)
  assert.equal(snapshotIdFor(report), report.snapshotId)
  assert.match(reportFileName(report, 'json'), /\.json$/)
})

test('a price change is applied to the day on each side of its effective date', (t) => {
  const base = { model: 'model-a', input: 1, cached: 0.5, output: 2 }
  const changed = { model: 'model-a', input: 10, cached: 5, output: 20, effectiveFrom: '2026-11-20' }
  const { store, query } = openHarness(t, [base, changed])
  const tokens = { input: 1000000, cached: 200000, cacheWrite: 100000, output: 500000 }
  store.commitScan({ source: 'codex', upserts: [
    seedRow('codex', 'model-a', '2026-11-19T12:00:00.000Z', tokens),
    seedRow('codex', 'model-a', '2026-11-21T12:00:00.000Z', tokens)
  ] })
  const daily = query.daily({ period: 'custom', tz: 'UTC', from: '2026-11-19', to: '2026-11-21' })
  const byDay = new Map(daily.rows.map((row) => [row.day, row]))
  // Legacy rule for the base row: cache writes are charged at the input rate.
  assert.equal(byDay.get('2026-11-19').costCny, 2.2)
  assert.equal(byDay.get('2026-11-20').costCny, null, 'a day with no activity is not a zero-cost day')
  assert.equal(byDay.get('2026-11-21').costCny, 22)
  // The range summary must fold both versions, not apply the newest to the whole range.
  const summary = query.summary({ period: 'custom', tz: 'UTC', from: '2026-11-19', to: '2026-11-21' })
  assert.equal(summary.totals.costCny, 24.2)
  assert.equal(summary.totals.unpricedModels, 0)
  assert.equal(summary.pricing.mode, 'manual')
  assert.equal(summary.pricing.version, priceVersionStamp(normalizeUsagePrices([base, changed])))
  // Breakdown has one row per model and must agree with the summary.
  const breakdown = query.breakdown({ period: 'custom', tz: 'UTC', from: '2026-11-19', to: '2026-11-21', scope: 'model' })
  assert.equal(breakdown.models[0].costCny, 24.2)

  const report = buildUsageReport({
    daily,
    breakdown,
    prices: [base, changed],
    generatedAt: NOW
  })
  assert.equal(report.pricing.version, summary.pricing.version)
  assert.equal(report.pricing.effectiveDates, true)
  assert.deepEqual(report.daily.map((row) => row.costCny), [2.2, null, 22])
  assert.equal(report.totals.costCny, 24.2)
})

test('an optional cache-write rate overrides the input rate and stays backward compatible', (t) => {
  const { store, query } = openHarness(t, [{ model: 'model-a', input: 1, cached: 0.5, cachedWrite: 4, output: 2 }])
  store.commitScan({ source: 'codex', upserts: [
    seedRow('codex', 'model-a', '2026-11-20T12:00:00.000Z', { input: 1000000, cached: 200000, cacheWrite: 100000, output: 500000 })
  ] })
  const daily = query.daily({ period: 'custom', tz: 'UTC', from: '2026-11-20', to: '2026-11-20' })
  assert.equal(daily.rows[0].costCny, 2.5)
})

test('a day before the first effective price is unknown, never zero', (t) => {
  const { store, query } = openHarness(t, [{ model: 'model-a', input: 1, cached: 0.1, output: 2, effectiveFrom: '2026-11-20' }])
  store.commitScan({ source: 'codex', upserts: [
    seedRow('codex', 'model-a', '2026-11-19T12:00:00.000Z', { input: 1000000, output: 1000000 }),
    seedRow('codex', 'model-a', '2026-11-21T12:00:00.000Z', { input: 1000000, output: 1000000 })
  ] })
  const daily = query.daily({ period: 'custom', tz: 'UTC', from: '2026-11-19', to: '2026-11-21' })
  const byDay = new Map(daily.rows.map((row) => [row.day, row]))
  assert.equal(byDay.get('2026-11-19').costCny, null)
  assert.equal(byDay.get('2026-11-19').unpricedModels, 1)
  assert.equal(byDay.get('2026-11-21').costCny, 3)
  const report = buildUsageReport({ daily, prices: [{ model: 'model-a', input: 1, cached: 0.1, output: 2, effectiveFrom: '2026-11-20' }], generatedAt: NOW })
  const row = report.daily[0]
  assert.equal(row.costCny, null)
  assert.equal(row.priceState, 'unpriced')
  const csv = reportToCsv(report)
  assert.match(csv, /2026-11-19,1000000,0,0,1000000,2000000,unknown,unpriced,1,/)
  // A model with no price at all is reported by name in the JSON, counted per day.
  const json = JSON.parse(reportToJson(report))
  assert.equal(json.totals.unpricedDays, 1)
  assert.equal(json.daily[0].unpricedModels, 1)
})

test('the export never carries prompts, paths, session titles or tool arguments', (t) => {
  const { store, query, dbPath } = openHarness(t)
  store.commitScan({
    source: 'codex',
    upserts: [seedRow('codex', 'model-a', '2026-11-20T12:00:00.000Z', { input: 50, output: 10 })],
    // The detail ledger really holds the sensitive strings; the export must not.
    details: {
      pending: false,
      updates: [{
        key: 'rollout.jsonl',
        stamp: 'stamp-1',
        partial: false,
        buckets: [{
          session: 'raw-session-id',
          title: 'PRIVATE_SESSION_TITLE',
          project: 'project-hash',
          projectName: 'PRIVATE_FULL_PROJECT',
          model: 'model-a',
          hour_start: '2026-11-20T12:00:00.000Z',
          first: '2026-11-20T12:00:00.000Z',
          last: '2026-11-20T12:30:00.000Z',
          activeSeconds: 1800,
          input_tokens: 50,
          output_tokens: 10,
          total_tokens: 60,
          billable_total_tokens: 60,
          conversation_count: 1
        }],
        calls: [{ session: 'raw-session-id', project: 'project-hash', projectName: 'PRIVATE_FULL_PROJECT', model: 'model-a', hour_start: '2026-11-20T12:00:00.000Z', kind: 'tool', name: 'read', calls: 1, last: '2026-11-20T12:00:00.000Z' }]
      }],
      titleIndex: { stamp: 'title-1', rows: [{ session: 'raw-session-id', title: 'PRIVATE_SESSION_TITLE' }] }
    },
    status: { state: 'ok', detected: true, readable: true, files: 1 }
  })
  store.checkpoint()
  const rawDb = fs.readFileSync(dbPath)
  assert.equal(rawDb.includes('PRIVATE_SESSION_TITLE'), true, 'fixture proves the detail ledger holds the title')
  assert.equal(rawDb.includes('PRIVATE_FULL_PROJECT'), true, 'fixture proves the detail ledger holds the path')
  const json = reportToJson(buildUsageReport({ ...exportParams(query), generatedAt: NOW }))
  const csv = reportToCsv(buildUsageReport({ ...exportParams(query), generatedAt: NOW }))
  for (const marker of ['PRIVATE_SESSION_TITLE', 'PRIVATE_FULL_PROJECT', 'raw-session-id', 'rollout.jsonl', 'F:\\', 'C:\\']) {
    assert.equal(json.includes(marker), false, marker)
    assert.equal(csv.includes(marker), false, marker)
  }
  // No per-session/per-project shape at all: the only keys are aggregate ones.
  const parsed = JSON.parse(json)
  assert.deepEqual(Object.keys(parsed.daily[0]).sort(), ['cacheRead', 'cacheWrite', 'costCny', 'day', 'input', 'output', 'priceState', 'total', 'unpricedModels'])
  assert.equal(Object.hasOwn(parsed, 'sessions'), false)
  assert.equal(Object.hasOwn(parsed, 'projects'), false)
})

test('import parsing rejects a tampered or unidentified report', () => {
  const report = buildUsageReport({
    daily: { period: 'custom', from: '2026-11-20', to: '2026-11-20', tz: 'UTC', rows: [{ day: '2026-11-20', input_tokens: 10, total_tokens: 10, billable_total_tokens: 10, conversation_count: 1 }] },
    generatedAt: NOW
  })
  const parsed = parseUsageReport(reportToJson(report))
  assert.equal(parsed.snapshotId, report.snapshotId)
  assert.equal(parsed.from, '2026-11-20')
  assert.equal(parsed.daily[0].total, 10)

  const tampered = JSON.parse(reportToJson(report))
  tampered.daily[0].total = 999
  assert.throws(() => parseUsageReport(tampered), /identity does not match/)

  const unidentified = JSON.parse(reportToJson(report))
  delete unidentified.snapshotId
  assert.throws(() => parseUsageReport(unidentified), /identity is missing/)

  const wrongVersion = JSON.parse(reportToJson(report))
  wrongVersion.schemaVersion = 2
  assert.throws(() => parseUsageReport(wrongVersion), /unsupported report schemaVersion/)

  assert.throws(() => parseUsageReport('not json'), /not valid JSON/)
  assert.throws(() => parseUsageReport('{}'), /unsupported report schemaVersion/)
})

test('legacy three-rate prices migrate without losing a rate or changing history', () => {
  const legacy = [{ model: 'm', input: 1, cached: 0.2, output: 3 }]
  const migrated = migrateUsagePrices(legacy)
  assert.equal(migrated.schemaVersion, 2)
  assert.deepEqual(migrated.rows, [{ model: 'm', input: 1, cached: 0.2, cachedWrite: null, output: 3, effectiveFrom: null }])
  assert.equal(migrated.migrated, 1)
  assert.doesNotThrow(() => assertUsagePrices(legacy))
  assert.deepEqual(normalizeUsagePrices(legacy), legacy, 'a legacy row keeps its exact shape')
  const table = createPriceTable(legacy)
  assert.equal(table.versioned, false)
  assert.equal(table.cacheWriteMode, 'input')
  // Two versions of one model are legal; the same effective day twice is not.
  assert.doesNotThrow(() => assertUsagePrices([
    { model: 'm', input: 1, cached: 0.2, output: 3 },
    { model: 'm', input: 2, cached: 0.4, output: 6, effectiveFrom: '2026-11-20' }
  ]))
  assert.throws(() => assertUsagePrices([
    { model: 'm', input: 1, cached: 0.2, output: 3, effectiveFrom: '2026-11-20' },
    { model: 'm', input: 2, cached: 0.4, output: 6, effectiveFrom: '2026-11-20' }
  ]), /Duplicate model price/)
  assert.throws(() => assertUsagePrices([{ model: 'm', input: 1, cached: 0.2, output: 3, effectiveFrom: '2026-02-30' }]), /Model prices require/)
  assert.throws(() => assertUsagePrices([{ model: 'm', input: 1, cached: 0.2, output: 3, cachedWrite: -1 }]), /Model prices require/)
  // A table with effective dates reports itself as versioned so the query folds per day.
  assert.equal(createPriceTable([
    { model: 'm', input: 1, cached: 0.2, output: 3 },
    { model: 'm', input: 2, cached: 0.4, output: 6, effectiveFrom: '2026-11-20' }
  ]).versioned, true)
})
