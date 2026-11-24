// Imported aggregate snapshots (B07, batch 1: preview + idempotent import).
//
// A snapshot is an *exported aggregate* (main/services/usage-export.js) that the
// user imported from another machine/profile. It is deliberately NOT merged into
// `usage_bucket`: that table is the scan ledger, whose rows are absolute
// per-(source, model, hour) snapshots owned by the collector. Writing foreign
// daily totals there would either be overwritten by the next scan or double
// count against it. Instead every accepted report becomes its own immutable
// snapshot file and the page lists them separately.
//
// Merge rules (ticket B07):
//   - identity: the report carries a content-derived snapshotId
//     (`sha256:<hex>`); a file without a verifiable identity is rejected by
//     usage-export.parseUsageReport before it reaches this store;
//   - idempotency: importing the same snapshotId again is a no-op, so the total
//     never grows;
//   - exclusivity: a *different* snapshot whose day range intersects an existing
//     one is refused (rather than merged), because two overlapping ranges cannot
//     be added without double counting the days they share.
//
// All fs access is injected-compatible and every write is tmp-file + rename, so
// a crash leaves either the old snapshot or the new one, never half of each.

const path = require('node:path')

const { parseUsageReport } = require('./usage-export')

const SNAPSHOT_SCHEMA_VERSION = 1
const MAX_SNAPSHOTS = 240
const FILE_SUFFIX = '.json'
// sha256 id -> file-safe stem. parseUsageReport has already pinned the id to
// ^sha256:[a-f0-9]{16,64}$, so only hex ever reaches the filesystem.
const ID_PATTERN = /^sha256:([a-f0-9]{16,64})$/

function fileStemFor(snapshotId) {
  const match = ID_PATTERN.exec(String(snapshotId || ''))
  if (!match) throw new Error('usage: invalid snapshot identity')
  return match[1]
}

function isValidDay(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

function rangesOverlap(left, right) {
  return isValidDay(left?.from) && isValidDay(left?.to) && isValidDay(right?.from) && isValidDay(right?.to) &&
    left.from <= right.to && right.from <= left.to
}

function metaOf(snapshot) {
  return {
    id: snapshot.id,
    sources: snapshot.sources,
    from: snapshot.from,
    to: snapshot.to,
    days: snapshot.days,
    totalTokens: snapshot.totals?.total || 0,
    costCny: snapshot.totals?.costCny ?? null,
    unpricedModels: snapshot.totals?.unpricedModelDays || 0,
    priceVersion: snapshot.pricing?.version || null,
    importedAt: snapshot.importedAt,
    generatedAt: snapshot.generatedAt || null
  }
}

function createUsageSnapshotStore({ directory, now = () => new Date(), fs, log = () => {} } = {}) {
  if (typeof directory !== 'string' || !directory) throw new TypeError('usage snapshot store requires a directory')
  if (!fs || typeof fs.readFileSync !== 'function' || typeof fs.writeFileSync !== 'function') {
    throw new TypeError('usage snapshot store requires fs')
  }

  function snapshotPath(snapshotId) {
    return path.join(directory, fileStemFor(snapshotId) + FILE_SUFFIX)
  }

  function readAll() {
    let names = []
    try {
      names = fs.readdirSync(directory)
    } catch (_error) {
      return []
    }
    const out = []
    for (const name of names) {
      if (!name.endsWith(FILE_SUFFIX)) continue
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'))
        if (!parsed || typeof parsed !== 'object' || !ID_PATTERN.test(String(parsed.id))) continue
        out.push(parsed)
      } catch (error) {
        log(`usage snapshots: ignoring unreadable ${name}: ${error?.message || String(error)}`)
      }
    }
    return out.sort((left, right) => String(right.importedAt || '').localeCompare(String(left.importedAt || '')))
  }

  function list() {
    return readAll().slice(0, MAX_SNAPSHOTS).map(metaOf)
  }

  // Pure decision step: parsed report + existing snapshots -> merge plan. Split
  // out from the write so the preview and the commit share ONE rule and the test
  // can assert the plan without touching disk.
  function planImport(report, existing) {
    const duplicates = []
    let overlap = false
    for (const snapshot of existing) {
      if (snapshot.id === report.snapshotId) {
        duplicates.push({ id: snapshot.id, kind: 'identical', from: snapshot.from, to: snapshot.to, sources: snapshot.sources })
        continue
      }
      if (rangesOverlap(snapshot, report)) {
        overlap = true
        duplicates.push({ id: snapshot.id, kind: 'overlap', from: snapshot.from, to: snapshot.to, sources: snapshot.sources })
      }
    }
    const identical = duplicates.some((entry) => entry.kind === 'identical')
    return {
      schemaVersion: report.schemaVersion,
      snapshotId: report.snapshotId,
      sources: report.sources,
      from: report.from,
      to: report.to,
      days: report.daily.length,
      totalRows: report.daily.length,
      totals: report.totals,
      duplicates,
      duplicate: identical,
      mergeable: !identical && !overlap,
      reason: identical ? 'duplicate' : (overlap ? 'range-overlap' : null)
    }
  }

  function preview(payload) {
    const report = parseUsageReport(payload)
    return planImport(report, readAll())
  }

  function commit(payload) {
    const report = parseUsageReport(payload)
    const existing = readAll()
    const plan = planImport(report, existing)
    if (plan.duplicate) {
      const current = existing.find((snapshot) => snapshot.id === report.snapshotId)
      return {
        imported: false,
        duplicate: true,
        reason: 'duplicate',
        snapshot: current ? metaOf(current) : null,
        totalRows: plan.totalRows,
        duplicates: plan.duplicates
      }
    }
    if (!plan.mergeable) {
      throw new Error('usage: aggregate snapshot overlaps an imported snapshot')
    }
    if (existing.length >= MAX_SNAPSHOTS) {
      throw new Error(`usage: at most ${MAX_SNAPSHOTS} aggregate snapshots can be imported`)
    }
    const importedAt = (now() instanceof Date ? now() : new Date(now())).toISOString()
    const snapshot = {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      id: report.snapshotId,
      sources: report.sources,
      from: report.from,
      to: report.to,
      days: report.daily.length,
      timeZone: report.timeZone,
      generatedAt: report.generatedAt,
      importedAt,
      pricing: report.pricing,
      totals: report.totals,
      daily: report.daily
    }
    const target = snapshotPath(report.snapshotId)
    const temporary = `${target}.${process.pid}.tmp`
    try {
      fs.mkdirSync(directory, { recursive: true })
      fs.writeFileSync(temporary, JSON.stringify(snapshot, null, 2) + '\n', 'utf8')
      fs.renameSync(temporary, target)
    } catch (error) {
      try { fs.rmSync(temporary, { force: true }) } catch (_cleanup) {}
      throw error
    }
    return { imported: true, duplicate: false, reason: null, snapshot: metaOf(snapshot), totalRows: plan.totalRows, duplicates: plan.duplicates }
  }

  return { commit, directory, list, planImport, preview }
}

module.exports = { MAX_SNAPSHOTS, SNAPSHOT_SCHEMA_VERSION, createUsageSnapshotStore, rangesOverlap }
