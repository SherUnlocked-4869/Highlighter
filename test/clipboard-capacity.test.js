'use strict'

// B05 (docs/reviews/2026-11-24-windows-product-architecture-review.md):
// capacity is only explainable if the numbers keep their provenance. These
// tests pin the pure model: exact vs estimated, this-run skip counters, the
// lower-limit projection, and the two acceptance histories (ten identical
// copies, four kinds reaching the payload budget).

const test = require('node:test')
const assert = require('node:assert/strict')

const capacity = require('../main/services/clipboard-capacity')
const settingsRoute = require('../config/routes/clipboard')

const MIB = 1048576
const settings = (over = {}) => ({ historyLimit: 500, retentionDays: 30, maxPayloadMiB: 256, maxDiskMiB: 384, maxThumbnailMiB: 64, ...over })
const status = (over = {}) => ({ phase: 'running', itemCount: 0, pinnedCount: 0, payloadBytes: 0, actualDiskBytes: 0, pendingGcBytes: 0, ...over })

// Mirrors native/clipboard/src/storage.rs accept(): a payload is identified by
// its content hash, so the tenth copy of the same text updates one row instead
// of adding a tenth. Pins are never deleted by maintenance; when an admission
// exceeds a budget the sidecar first deletes at most 50 oldest ordinary rows and
// refuses the incoming copy only if it still does not fit.
function admit(history, incoming, rules) {
  const rows = new Map(history.map((row) => [row.hash, { ...row }]))
  let payloadBytes = [...rows.values()].reduce((sum, row) => sum + row.bytes, 0)
  const pins = [...rows.values()].filter((row) => row.pinned).length
  if (!rows.has(incoming.hash) && payloadBytes + incoming.bytes > rules.maxPayloadBytes) {
    const victims = [...rows.values()].filter((row) => !row.pinned).sort((a, b) => a.at - b.at).slice(0, 50)
    for (const victim of victims) { rows.delete(victim.hash); payloadBytes -= victim.bytes }
  }
  if (!rows.has(incoming.hash) && payloadBytes + incoming.bytes > rules.maxPayloadBytes) {
    return { refused: true, rows: [...rows.values()], pins }
  }
  const existing = rows.get(incoming.hash)
  if (existing) rows.set(incoming.hash, { ...existing, copies: (existing.copies || 1) + 1 })
  else rows.set(incoming.hash, { ...incoming, copies: 1 })
  return { refused: false, rows: [...rows.values()], pins }
}

test('ten identical copies are one ordinary record, not ten', () => {
  const copies = Array.from({ length: 10 }, () => ({ hash: 'sha256:same-text', kind: 'text', bytes: 42, pinned: false, at: 1 }))
  const final = copies.reduce((state, copy) => admit(state.rows, copy, { maxPayloadBytes: 256 * MIB }), { rows: [] })
  assert.equal(final.rows.length, 1, 'content-hash dedupe keeps one row')
  assert.equal(final.rows[0].copies, 10, 'the row records all ten copies')
  const view = capacity.computeCapacity({ status: status({ itemCount: final.rows.length }), settings: settings() })
  assert.equal(view.counts.ordinary.value, 1)
  assert.equal(view.counts.pinned.value, 0)
})

test('four kinds reaching the payload budget keep a checkable kept/evicted split', () => {
  // 1 MiB budget: the four kinds fit at 650 KiB; a 400 KiB image then pushes it
  // over, so the oldest ordinary row (text) is evicted and everything else stays.
  const history = [
    { hash: 't1', kind: 'text', bytes: 200 * 1024, pinned: false, at: 1 },
    { hash: 'u1', kind: 'url', bytes: 100 * 1024, pinned: true, at: 2 },
    { hash: 'i1', kind: 'image', bytes: 300 * 1024, pinned: false, at: 3 },
    { hash: 'f1', kind: 'files', bytes: 50 * 1024, pinned: false, at: 4 }
  ]
  const incoming = { hash: 'i2', kind: 'image', bytes: 400 * 1024, pinned: false, at: 5 }
  const result = admit(history, incoming, { maxPayloadBytes: 1 * MIB })
  assert.equal(result.refused, false)
  const byKind = (rows) => rows.reduce((counts, row) => ({ ...counts, [row.kind]: (counts[row.kind] || 0) + 1 }), {})
  // storage.rs reclaims up to 50 oldest ordinary rows in one pass, not exactly
  // the bytes needed: all three ordinary kinds go, the pinned URL and the
  // incoming image survive.
  assert.deepEqual(byKind(result.rows), { url: 1, image: 1 }, 'pinned URL plus the incoming image are kept')
  assert.equal(result.rows.filter((row) => row.pinned).length, 1, 'the pinned URL survives')
  assert.equal(result.rows.length, 2, 'two records kept')
  assert.equal(history.length + 1 - result.rows.length, 3, 'three ordinary records were evicted')
  const evictedKinds = history.filter((row) => !result.rows.some((kept) => kept.hash === row.hash)).map((row) => row.kind).sort()
  assert.deepEqual(evictedKinds, ['files', 'image', 'text'], 'kept/evicted arithmetic is checkable by kind')
})

test('pinned records are never the eviction victims, even when they fill the budget', () => {
  const history = [
    { hash: 'p1', kind: 'image', bytes: 600 * 1024, pinned: true, at: 1 },
    { hash: 'p2', kind: 'files', bytes: 500 * 1024, pinned: true, at: 2 }
  ]
  const result = admit(history, { hash: 'i2', kind: 'image', bytes: 400 * 1024, pinned: false, at: 3 }, { maxPayloadBytes: 1 * MIB })
  assert.equal(result.refused, true, 'pins cannot be evicted to make room')
  assert.equal(result.pins, 2, 'both pins remain')
  const preview = capacity.previewEviction({ ordinaryCount: 0, pinnedCount: 2, historyLimit: 100 })
  assert.equal(preview.evictedOrdinary, 0)
  assert.equal(preview.pinnedKept, 2)
})

test('occupancy splits ordinary and pinned counts exactly and marks byte estimates', () => {
  const view = capacity.computeCapacity({
    status: status({ itemCount: 7, pinnedCount: 2, payloadBytes: 10 * MIB, actualDiskBytes: 13 * MIB, pendingGcBytes: 512 * 1024 }),
    settings: settings({ historyLimit: 100 })
  })
  assert.equal(view.counts.ordinary.value, 5)
  assert.equal(view.counts.pinned.value, 2)
  assert.equal(view.counts.total.value, 7)
  for (const metric of [view.counts.ordinary, view.counts.pinned, view.counts.total, view.bytes.payload, view.budgets.payload.used]) {
    assert.equal(metric.estimated, false, 'counts and payload bytes come from exact SQLite aggregates')
  }
  assert.equal(view.bytes.payload.value, 10 * MIB)
  assert.equal(view.bytes.thumbnails.value, 3 * MIB, 'the difference is the only thumbnail bound the status supports')
  assert.equal(view.bytes.thumbnails.estimated, true)
  assert.equal(view.bytes.disk.estimated, true, 'the sidecar disk figure is calibrated, not exact')
  assert.equal(view.budgets.records.limit.value, 100)
  assert.equal(view.budgets.records.remaining.value, 95)
  assert.equal(view.budgets.payload.ratio.value, 10 / 256)
  assert.equal(view.budgets.thumbnails.used.estimated, true)
  assert.equal(view.budgets.disk.used.estimated, true)
  assert.equal(view.estimates.pinnedBytes, null, 'per-scope bytes are not invented')
})

test('every reported number carries an estimated flag', () => {
  const view = capacity.computeCapacity({ status: status({ itemCount: 1 }), settings: settings() })
  const metrics = []
  const walk = (value) => {
    if (!value || typeof value !== 'object') return
    if (Object.hasOwn(value, 'value') && Object.hasOwn(value, 'estimated')) { metrics.push(value); return }
    for (const child of Object.values(value)) walk(child)
  }
  walk(view)
  assert.ok(metrics.length >= 20)
  assert.ok(metrics.every((metric) => typeof metric.estimated === 'boolean'))
})

test('a disk reading below payload never produces negative bytes', () => {
  const view = capacity.computeCapacity({ status: status({ itemCount: 1, payloadBytes: 5 * MIB, actualDiskBytes: 2 * MIB }), settings: settings() })
  assert.equal(view.bytes.thumbnails.value, 0)
  assert.equal(view.bytes.thumbnails.estimated, true)
  assert.equal(view.budgets.thumbnails.ratio.value, 0)
})

test('pinned counts are clamped and missing limits do not invent a budget', () => {
  const view = capacity.computeCapacity({ status: status({ itemCount: 3, pinnedCount: 9 }), settings: {} })
  assert.equal(view.counts.pinned.value, 3)
  assert.equal(view.counts.ordinary.value, 0)
  assert.equal(view.budgets.records.limit.value, 0)
  assert.equal(view.budgets.records.remaining.value, 0)
  assert.equal(view.budgets.payload.ratio.value, 0)
})

test('pinned squeeze is a suspicion backed by evidence, never a claim about bytes', () => {
  const low = capacity.computeCapacity({ status: status({ itemCount: 2, pinnedCount: 2, payloadBytes: MIB }), settings: settings() })
  assert.equal(low.pinned.squeeze.possible, false)
  const near = capacity.computeCapacity({ status: status({ itemCount: 2, pinnedCount: 2, payloadBytes: 250 * MIB }), settings: settings() })
  assert.equal(near.pinned.squeeze.possible, true)
  assert.equal(near.pinned.squeeze.evidence, 'budget-near-limit')
  const rejected = capacity.computeCapacity({ status: status({ itemCount: 2, pinnedCount: 2, payloadBytes: MIB, skipped: { storage_error: 1 } }), settings: settings() })
  assert.equal(rejected.pinned.squeeze.possible, true)
  assert.equal(rejected.pinned.squeeze.evidence, 'storage-rejection')
  const noPins = capacity.computeCapacity({ status: status({ itemCount: 0, pinnedCount: 0, skipped: { storage_error: 3 } }), settings: settings() })
  assert.equal(noPins.pinned.squeeze.possible, false, 'without pins there is nothing to attribute')
  const message = capacity.computeCapacity({ status: status({ itemCount: 1, pinnedCount: 1, messageKey: 'STORAGE_FULL' }), settings: settings() })
  assert.equal(message.pinned.squeeze.evidence, 'storage-rejection')
})

test('an excluded source and a rejected file path report different reasons and handling', () => {
  const skip = capacity.describeSkips({ excluded: 4, unsupported: 2, invalid_encoding: 1, storage_error: 3 })
  const excluded = skip.reasons.find((reason) => reason.code === 'excluded')
  const invalidPath = skip.reasons.find((reason) => reason.code === 'invalid_encoding')
  assert.equal(excluded.group, 'excluded')
  assert.equal(excluded.handling, 'intentional')
  assert.equal(excluded.actionable, false)
  assert.equal(invalidPath.group, 'invalid_path')
  assert.equal(invalidPath.handling, 'rejected')
  assert.equal(invalidPath.actionable, true)
  assert.notEqual(excluded.messageKey, invalidPath.messageKey)
  assert.equal(skip.byHandling.intentional, 4)
  assert.equal(skip.byHandling.rejected, 3)
  assert.equal(skip.byHandling.budget, 3)
  assert.equal(skip.total, 10)
})

test('unknown reason codes stay visible as other instead of being dropped', () => {
  const skip = capacity.describeSkips({ future_reason: 2 })
  assert.equal(skip.reasons.length, 1)
  assert.equal(skip.reasons[0].known, false)
  assert.equal(skip.reasons[0].group, 'other')
  assert.equal(skip.reasons[0].messageKey, 'clipboard.skip.unknown')
  assert.equal(skip.total, 2)
})

test('this-run skip totals accumulate deltas and survive a sidecar restart', () => {
  const start = capacity.emptySkipSession(1000)
  const first = capacity.nextSkipSession(start, { excluded: 2, oversized: 1 }, 1100)
  assert.deepEqual(first.totals, { excluded: 2, oversized: 1 })
  assert.equal(first.last, null, 'the first observation is a baseline, not a recency claim')
  const second = capacity.nextSkipSession(first, { excluded: 3, oversized: 3 }, 1200)
  assert.deepEqual(second.totals, { excluded: 3, oversized: 3 })
  assert.equal(second.last.code, 'oversized')
  assert.equal(second.last.count, 2)
  // The sidecar restarted: its counters fell back to 1. That 1 is new work, not
  // a negative delta, and the old total is preserved.
  const restart = capacity.nextSkipSession(second, { excluded: 1 }, 1300)
  assert.deepEqual(restart.totals, { excluded: 4, oversized: 3 })
  assert.equal(restart.last.code, 'excluded')
  assert.equal(restart.last.count, 1)
  const steady = capacity.nextSkipSession(restart, { excluded: 1 }, 1400)
  assert.deepEqual(steady.totals, restart.totals)
  assert.equal(steady.last.count, 1)
  const missing = capacity.nextSkipSession(steady, undefined, 1500)
  assert.equal(missing, steady, 'a status without skip counters is not a reset')
  const described = capacity.describeSkips(steady.totals, { last: steady.last })
  assert.equal(described.total, 7)
  assert.equal(described.since, 'run')
  assert.equal(described.last.code, 'excluded')
})

test('invalid skip counters are ignored instead of corrupting the session', () => {
  const session = capacity.nextSkipSession(capacity.emptySkipSession(1), { excluded: -1, bad: 'x', 'UPPER': 2 }, 2)
  assert.deepEqual(session.totals, {})
  const described = capacity.describeSkips({ excluded: -1, bad: 'x', 'UPPER': 2 })
  assert.equal(described.total, 0)
})

test('lowering the limit previews ordinary-only eviction and always keeps pins', () => {
  const preview = capacity.previewEviction({ ordinaryCount: 500, pinnedCount: 12, historyLimit: 300 })
  assert.equal(preview.evictedOrdinary, 200)
  assert.equal(preview.keptOrdinary, 300)
  assert.equal(preview.pinnedKept, 12)
  assert.equal(preview.pinnedNeverEvicted, true)
  assert.equal(preview.estimated, true)
  assert.equal(capacity.previewEviction({ ordinaryCount: 500, pinnedCount: 12, historyLimit: 500 }).evictedOrdinary, 0)
  assert.equal(capacity.previewEviction({ ordinaryCount: 0, pinnedCount: 40, historyLimit: 100 }).evictedOrdinary, 0)
  assert.equal(capacity.previewEviction({ ordinaryCount: 20, pinnedCount: 40, historyLimit: 5 }).pinnedKept, 40)
})

test('the settings slider projection matches the main-process projection everywhere', () => {
  for (const ordinary of [0, 1, 99, 100, 500, 5000]) {
    for (const pinned of [0, 1, 12, 5000]) {
      for (let limit = 100; limit <= 5000; limit += 100) {
        assert.deepEqual(
          settingsRoute.clipboardPreviewEviction(ordinary, pinned, limit),
          capacity.previewEviction({ ordinaryCount: ordinary, pinnedCount: pinned, historyLimit: limit }),
          `ordinary=${ordinary} pinned=${pinned} limit=${limit}`
        )
      }
    }
  }
})

test('this-run skip totals are what the capacity view reports', () => {
  let session = capacity.emptySkipSession(1)
  session = capacity.nextSkipSession(session, { excluded: 2 }, 2)
  session = capacity.nextSkipSession(session, { excluded: 3, oversized: 2 }, 3)
  const view = capacity.computeCapacity({ status: status({ itemCount: 4, pinnedCount: 1 }), settings: settings(), session })
  assert.equal(view.skip.since, 'run')
  assert.equal(view.skip.total, 5)
  assert.equal(view.skip.reasons.find((reason) => reason.code === 'excluded').count, 3)
  assert.equal(view.skip.last.code, 'oversized')
  assert.equal(view.skip.last.count, 2)
})
