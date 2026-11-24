'use strict'

// B05 (docs/reviews/2026-11-24-windows-product-architecture-review.md):
// explain clipboard capacity instead of showing one record count.
//
// Every number here is derived from the status snapshot the sidecar already
// returns: SQLite count(*)/sum(byte_length) aggregates plus the sidecar's
// calibrated disk estimate. This module adds no sidecar method, reads no
// payload and performs no query of its own. The only new input is the in-memory
// skip-counter delta the main process observes while the app runs
// (nextSkipSession), which is labelled 'this run' everywhere it is shown.
//
// estimated marks a number the product cannot know exactly:
//   * disk bytes are the sidecar's calibrated estimate (actualDiskBytes);
//   * thumbnail/extra bytes are actualDiskBytes - payloadBytes, which also
//     contains the database, index and WAL - so the settings page calls it
//     'thumbnails and extra files (estimated)';
//   * pinned bytes cannot be split from ordinary bytes by the current status,
//     so they are deliberately absent rather than invented;
//   * the lower-limit preview is a projection: maintenance deletes ordinary
//     records in batches of 50 and concurrent copies change the count.
//
// Reason codes are the sidecar's own skip counters (native/clipboard/src/
// limits.rs + listener.rs). Unknown future codes are reported as 'other'
// instead of being dropped.

const MIB = 1048576
// storage.rs deletes at most this many ordinary records per maintenance pass.
const MAINTENANCE_BATCH = 50

const SKIP_ORDER = Object.freeze([
  'excluded',
  'private',
  'oversized',
  'unsupported',
  'invalid_encoding',
  'invalid_image',
  'storage_error',
  'clipboard_busy',
  'superseded',
  'stale_configuration',
  'transient_barrier'
])

// group: what kind of skip it is (drives the settings list)
// handling: what the product does about it
//   intentional - the user's own privacy/settings filter, no action needed
//   rejected    - this copy could not be stored; copying again may help
//   budget      - storage refused it; free space or raise a limit
//   transient   - the copy was superseded or the clipboard was busy
const SKIP_REASONS = Object.freeze({
  excluded: Object.freeze({ group: 'excluded', handling: 'intentional', messageKey: 'clipboard.skip.excluded', actionable: false }),
  private: Object.freeze({ group: 'private', handling: 'intentional', messageKey: 'clipboard.skip.private', actionable: false }),
  oversized: Object.freeze({ group: 'oversized', handling: 'rejected', messageKey: 'clipboard.skip.oversized', actionable: true }),
  unsupported: Object.freeze({ group: 'unsupported', handling: 'rejected', messageKey: 'clipboard.skip.unsupported', actionable: true }),
  invalid_encoding: Object.freeze({ group: 'invalid_path', handling: 'rejected', messageKey: 'clipboard.skip.invalid-path', actionable: true }),
  invalid_image: Object.freeze({ group: 'invalid_image', handling: 'rejected', messageKey: 'clipboard.skip.invalid-image', actionable: true }),
  storage_error: Object.freeze({ group: 'storage', handling: 'budget', messageKey: 'clipboard.skip.storage', actionable: true }),
  clipboard_busy: Object.freeze({ group: 'transient', handling: 'transient', messageKey: 'clipboard.skip.transient', actionable: false }),
  superseded: Object.freeze({ group: 'transient', handling: 'transient', messageKey: 'clipboard.skip.transient', actionable: false }),
  stale_configuration: Object.freeze({ group: 'transient', handling: 'transient', messageKey: 'clipboard.skip.transient', actionable: false }),
  transient_barrier: Object.freeze({ group: 'transient', handling: 'transient', messageKey: 'clipboard.skip.transient', actionable: false })
})

const UNKNOWN_REASON = Object.freeze({ group: 'other', handling: 'unknown', messageKey: 'clipboard.skip.unknown', actionable: false })
const CODE_PATTERN = /^[a-z_]{1,64}$/

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function safeTime(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function mibLimit(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value * MIB : 0
}

function metric(value, estimated, unit) {
  return { value, estimated: estimated === true, unit: unit || 'count' }
}

function reasonFor(code) {
  const known = typeof code === 'string' && Object.hasOwn(SKIP_REASONS, code) ? SKIP_REASONS[code] : null
  const entry = known || UNKNOWN_REASON
  return { code: typeof code === 'string' ? code : '', group: entry.group, handling: entry.handling, messageKey: entry.messageKey, actionable: entry.actionable, known: known !== null }
}

function priority(code) {
  const index = SKIP_ORDER.indexOf(code)
  return index < 0 ? SKIP_ORDER.length : index
}

// A status skipped object is a sidecar-lifetime counter map. This reducer
// turns successive observations into a main-process 'this run' total that also
// survives a sidecar restart: when a counter falls (a new backend process
// started) its current value is new work, not a negative delta.
function emptySkipSession(at) {
  const stamp = safeTime(at)
  return { startedAt: stamp, updatedAt: stamp, observed: false, totals: {}, baseline: {}, last: null }
}

function nextSkipSession(previous, skipped, at) {
  const base = previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : emptySkipSession(at)
  if (!skipped || typeof skipped !== 'object' || Array.isArray(skipped)) return base
  const stamp = safeTime(at)
  // Counters seen for the first time are a baseline, not "the latest skip": the
  // sidecar may have accumulated them long before this process looked. The
  // totals are still correct; only the recency claim waits for a real delta.
  const wasObserved = base.observed === true
  const totals = { ...plainObject(base.totals) }
  const baseline = { ...plainObject(base.baseline) }
  let best = null
  let changed = false
  for (const [code, count] of Object.entries(skipped)) {
    if (!CODE_PATTERN.test(code) || !Number.isSafeInteger(count) || count < 0) continue
    const prior = Number.isSafeInteger(baseline[code]) ? baseline[code] : 0
    // A smaller value means the sidecar restarted with a fresh counter; its
    // current value has never been observed by this process before.
    const delta = count >= prior ? count - prior : count
    if (baseline[code] !== count) changed = true
    baseline[code] = count
    if (delta > 0) {
      totals[code] = safeCount(totals[code]) + delta
      changed = true
      if (!best || delta > best.delta || (delta === best.delta && priority(code) < priority(best.code))) best = { code, delta }
    }
  }
  for (const code of Object.keys(baseline)) {
    if (!Object.hasOwn(skipped, code) && baseline[code] !== 0) {
      baseline[code] = 0
      changed = true
    }
  }
  if (!changed) return wasObserved ? base : { ...base, updatedAt: stamp, observed: true }
  const last = best && wasObserved ? { code: best.code, count: best.delta, at: stamp, total: totals[best.code] } : (base.last || null)
  return { startedAt: base.startedAt || stamp, updatedAt: stamp, observed: true, totals, baseline, last }
}

function describeSkips(skipped, options = {}) {
  const totals = {}
  for (const [code, count] of Object.entries(plainObject(skipped))) {
    if (!CODE_PATTERN.test(code) || !Number.isSafeInteger(count) || count <= 0) continue
    totals[code] = count
  }
  const reasons = Object.keys(totals)
    .map((code) => ({ ...reasonFor(code), count: totals[code] }))
    .sort((a, b) => b.count - a.count || priority(a.code) - priority(b.code) || a.code.localeCompare(b.code))
  const byHandling = { intentional: 0, rejected: 0, transient: 0, budget: 0, unknown: 0 }
  let total = 0
  for (const reason of reasons) {
    total += reason.count
    byHandling[reason.handling] = safeCount(byHandling[reason.handling]) + reason.count
  }
  const last = options.last && typeof options.last === 'object'
    ? {
        ...reasonFor(options.last.code),
        count: safeCount(options.last.count),
        at: safeCount(options.last.at),
        total: safeCount(options.last.total)
      }
    : null
  return { since: options.since === 'backend' ? 'backend' : 'run', total, reasons, byHandling, last }
}

function budget(used, limit, usedEstimated, unit) {
  const remaining = limit > 0 ? Math.max(0, limit - used) : 0
  const kind = unit || 'count'
  return {
    limit: metric(limit, false, kind),
    used: metric(used, usedEstimated === true, kind),
    remaining: metric(remaining, usedEstimated === true, kind),
    ratio: metric(limit > 0 ? used / limit : 0, usedEstimated === true, 'ratio')
  }
}

function computeCapacity(input = {}) {
  const status = plainObject(input.status)
  const settings = plainObject(input.settings)
  const session = input.session && typeof input.session === 'object' && !Array.isArray(input.session) ? input.session : null
  const total = safeCount(status.itemCount)
  const pinned = Math.min(safeCount(status.pinnedCount), total)
  const ordinary = total - pinned
  const payloadBytes = safeCount(status.payloadBytes)
  const diskBytes = safeCount(status.actualDiskBytes)
  const pendingGcBytes = safeCount(status.pendingGcBytes)
  // The status has no thumbnail-specific sum. The difference is the best
  // available bound and is labelled estimated everywhere it is displayed.
  const thumbnailBytes = Math.max(0, diskBytes - payloadBytes)
  const recordLimit = safeCount(settings.historyLimit)
  const payloadLimit = mibLimit(settings.maxPayloadMiB)
  const thumbnailLimit = mibLimit(settings.maxThumbnailMiB)
  const diskLimit = mibLimit(settings.maxDiskMiB)
  const skip = describeSkips(session ? session.totals : status.skipped, {
    since: session ? 'run' : 'backend',
    last: session ? session.last : null
  })
  const payloadRatio = payloadLimit > 0 ? payloadBytes / payloadLimit : 0
  const diskRatio = diskLimit > 0 ? diskBytes / diskLimit : 0
  let evidence = null
  if (pinned > 0 && skip.byHandling.budget > 0) evidence = 'storage-rejection'
  else if (pinned > 0 && status.messageKey === 'STORAGE_FULL') evidence = 'storage-rejection'
  else if (pinned > 0 && (payloadRatio >= 0.9 || diskRatio >= 0.9)) evidence = 'budget-near-limit'
  return {
    counts: {
      total: metric(total, false),
      ordinary: metric(ordinary, false),
      pinned: metric(pinned, false)
    },
    bytes: {
      payload: metric(payloadBytes, false, 'bytes'),
      // Includes thumbnails, the SQLite database/index/WAL and any payload the
      // sidecar still holds for GC; see the header comment.
      thumbnails: metric(thumbnailBytes, true, 'bytes'),
      disk: metric(diskBytes, true, 'bytes'),
      pendingGc: metric(pendingGcBytes, false, 'bytes')
    },
    budgets: {
      records: budget(ordinary, recordLimit, false, 'count'),
      payload: budget(payloadBytes, payloadLimit, false, 'bytes'),
      thumbnails: budget(thumbnailBytes, thumbnailLimit, true, 'bytes'),
      disk: budget(diskBytes, diskLimit, true, 'bytes')
    },
    pinned: {
      count: metric(pinned, false),
      shareOfRecords: metric(total > 0 ? pinned / total : 0, false, 'ratio'),
      neverEvicted: true,
      // The status cannot attribute bytes to pins, so this is a suspicion with
      // evidence, never a claim that pins are the cause.
      squeeze: { possible: evidence !== null, evidence, pinnedCount: pinned, storageRejections: skip.byHandling.budget }
    },
    retentionDays: metric(safeCount(settings.retentionDays), false, 'days'),
    skip,
    estimates: {
      diskBytes: true,
      thumbnailBytes: true,
      pinnedBytes: null,
      previewEviction: true
    }
  }
}

// Lowering historyLimit only evicts ordinary records; pins never appear in the
// deletion statement (storage.rs is_pinned=0). The count is an exact projection
// but the timing is not: maintenance deletes 50 at a time and a concurrent copy
// can add a record while the user is deciding.
function previewEviction(input = {}) {
  const ordinaryCount = safeCount(input.ordinaryCount)
  const pinnedCount = safeCount(input.pinnedCount)
  const newLimit = safeCount(input.historyLimit)
  const evictedOrdinary = Math.max(0, ordinaryCount - newLimit)
  return {
    ordinaryCount,
    pinnedCount,
    newLimit,
    evictedOrdinary,
    keptOrdinary: ordinaryCount - evictedOrdinary,
    pinnedKept: pinnedCount,
    pinnedNeverEvicted: true,
    estimated: true,
    batchSize: MAINTENANCE_BATCH
  }
}

module.exports = {
  MIB,
  MAINTENANCE_BATCH,
  SKIP_ORDER,
  SKIP_REASONS,
  computeCapacity,
  describeSkips,
  emptySkipSession,
  nextSkipSession,
  previewEviction,
  reasonFor
}
