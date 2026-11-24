'use strict'

// C06 (docs/reviews/2026-11-24-windows-product-architecture-review.md): a single installer
// byte count cannot say whether growth came from a required component or from duplicated
// bytes. This module is the pure half of scripts/report-release-size.js: it groups a file
// inventory, finds duplicate content, walks an app.asar header, and compares two reports with
// the review's 5% attribution gate.

const MAX_GROWTH_RATIO = 0.05

function normalizeEntries(entries = []) {
  return (Array.isArray(entries) ? entries : [])
    .map((entry) => ({
      path: String(entry?.path || '').replace(/\\/g, '/'),
      size: Math.max(0, Math.round(Number(entry?.size) || 0)),
      hash: typeof entry?.hash === 'string' ? entry.hash : ''
    }))
    .filter((entry) => entry.path)
}

function topLevelOf(filePath) {
  const clean = String(filePath || '').replace(/^\.\//, '')
  if (!clean) return ''
  const [first, second] = clean.split('/')
  // Electron's unpacked app is the one tree where the second level is the real component
  // (resources/app.asar.unpacked/native/...), so report one level deeper there.
  if (first === 'resources' && second === 'app.asar.unpacked') return `resources/${second}`
  return first
}

function groupBy(entries, keyOf) {
  const groups = new Map()
  for (const entry of entries) {
    const key = keyOf(entry)
    const group = groups.get(key) || { id: key, bytes: 0, files: 0 }
    group.bytes += entry.size
    group.files += 1
    groups.set(key, group)
  }
  return [...groups.values()].sort((left, right) => right.bytes - left.bytes || left.id.localeCompare(right.id))
}

function extensionOf(filePath) {
  const clean = String(filePath || '').toLowerCase()
  const index = clean.lastIndexOf('.')
  if (index <= 0) return '(none)'
  return clean.slice(index)
}

function duplicateGroups(entries) {
  const byHash = new Map()
  for (const entry of entries) {
    if (!entry.hash || entry.size === 0) continue
    const list = byHash.get(entry.hash) || []
    list.push(entry)
    byHash.set(entry.hash, list)
  }
  const duplicates = []
  for (const [hash, list] of byHash) {
    if (list.length < 2) continue
    duplicates.push({
      hash,
      count: list.length,
      bytes: list.reduce((total, entry) => total + entry.size, 0),
      // Everything except one copy is recoverable duplicated bytes.
      duplicatedBytes: list.reduce((total, entry) => total + entry.size, 0) - list[0].size,
      paths: list.map((entry) => entry.path).sort()
    })
  }
  return duplicates.sort((left, right) => right.duplicatedBytes - left.duplicatedBytes)
}

// The asar header is the only place the packed tree's sizes exist without extracting it.
// `header.files` is a tree of { size, offset, unpacked, files }; this flattens it.
function flattenAsarHeader(header, prefix = '', output = []) {
  const files = header && typeof header === 'object' ? header.files : null
  if (!files || typeof files !== 'object') return output
  for (const [name, value] of Object.entries(files)) {
    const filePath = prefix ? `${prefix}/${name}` : name
    if (value && typeof value === 'object' && value.files) {
      flattenAsarHeader(value, filePath, output)
      continue
    }
    output.push({
      path: filePath,
      size: Math.max(0, Math.round(Number(value?.size) || 0)),
      unpacked: value?.unpacked === true
    })
  }
  return output
}

function summarizeAsar(header) {
  const entries = flattenAsarHeader(header)
  const packed = entries.filter((entry) => !entry.unpacked)
  const unpacked = entries.filter((entry) => entry.unpacked)
  const sum = (list) => list.reduce((total, entry) => total + entry.size, 0)
  return {
    files: entries.length,
    packedBytes: sum(packed),
    unpackedBytes: sum(unpacked),
    unpackedFiles: unpacked.length,
    topLevel: groupBy(packed.map((entry) => ({ ...entry, hash: '' })), (entry) => topLevelOf(entry.path))
  }
}

function ratio(current, baseline) {
  const base = Number(baseline)
  const value = Number(current)
  if (!Number.isFinite(base) || base <= 0 || !Number.isFinite(value)) return null
  return (value - base) / base
}

// Both reports: { totalBytes, topLevel: [{ id, bytes }] }.
// A component whose growth outruns the gate is reported as needing attribution; a component
// that shrank cannot hide another component's growth because the total is checked too.
function compareReports(current, baseline, { maxGrowthRatio = MAX_GROWTH_RATIO } = {}) {
  const currentTotal = Number(current?.totalBytes) || 0
  const baselineTotal = Number(baseline?.totalBytes) || 0
  const totalRatio = ratio(currentTotal, baselineTotal)
  const baselineGroups = new Map((baseline?.topLevel || []).map((group) => [group.id, Number(group.bytes) || 0]))
  const currentGroups = new Map((current?.topLevel || []).map((group) => [group.id, Number(group.bytes) || 0]))
  const ids = new Set([...baselineGroups.keys(), ...currentGroups.keys()])
  const components = [...ids].map((id) => {
    const before = baselineGroups.get(id) || 0
    const after = currentGroups.get(id) || 0
    const growth = ratio(after, before)
    return {
      id,
      currentBytes: after,
      baselineBytes: before,
      growthRatio: growth === null ? null : Math.round(growth * 10000) / 10000,
      // A brand-new component has no baseline to divide by; attribution is always required.
      needsAttribution: before === 0 ? after > 0 : (growth === null ? true : growth > maxGrowthRatio)
    }
  }).sort((left, right) => (right.growthRatio ?? 0) - (left.growthRatio ?? 0))
  const overGate = totalRatio !== null && totalRatio > maxGrowthRatio
  return {
    ok: !overGate && !components.some((component) => component.needsAttribution),
    maxGrowthRatio,
    currentBytes: currentTotal,
    baselineBytes: baselineTotal,
    totalGrowthRatio: totalRatio === null ? null : Math.round(totalRatio * 10000) / 10000,
    overGate,
    components
  }
}

module.exports = {
  MAX_GROWTH_RATIO,
  compareReports,
  duplicateGroups,
  extensionOf,
  flattenAsarHeader,
  groupBy,
  normalizeEntries,
  summarizeAsar,
  topLevelOf
}