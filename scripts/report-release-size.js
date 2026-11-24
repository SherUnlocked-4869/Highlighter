#!/usr/bin/env node
'use strict'

// C06: report what a packaged build is made of before shipping it: bytes by top-level
// component, bytes by extension, duplicate content, and the app.asar packed/unpacked split.
// With --baseline it applies the review's 5% growth gate and names the component to attribute.
//
//   node scripts/report-release-size.js --dir dist/win-unpacked --out .tmp-perf/size.json
//   node scripts/report-release-size.js --dir dist/win-unpacked --baseline .tmp-perf/size-base.json

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const {
  MAX_GROWTH_RATIO,
  compareReports,
  duplicateGroups,
  extensionOf,
  groupBy,
  normalizeEntries,
  summarizeAsar
} = require('./lib/release-size')

function parseArgs(argv) {
  const args = { dir: '', baseline: '', out: '', maxGrowth: MAX_GROWTH_RATIO, skipHashes: false }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const next = () => { index += 1; return argv[index] }
    if (flag === '--dir') args.dir = next() || ''
    else if (flag === '--baseline') args.baseline = next() || ''
    else if (flag === '--out') args.out = next() || ''
    else if (flag === '--max-growth') args.maxGrowth = Number(next())
    else if (flag === '--skip-hashes') args.skipHashes = true
  }
  if (!args.dir) throw new Error('--dir <packaged directory> is required')
  if (!Number.isFinite(args.maxGrowth) || args.maxGrowth < 0) args.maxGrowth = MAX_GROWTH_RATIO
  return args
}

function walk(root, prefix = '', output = []) {
  for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) walk(root, relative, output)
    else if (entry.isFile()) output.push(relative)
  }
  return output
}

function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function readAsar(headerPath) {
  try {
    const { getRawHeader } = require('@electron/asar')
    return summarizeAsar(getRawHeader(headerPath))
  } catch (error) {
    return { error: error?.message || String(error) }
  }
}

function buildReport({ dir, skipHashes = false }) {
  const root = path.resolve(dir)
  const files = walk(root)
  const entries = normalizeEntries(files.map((relative) => {
    const absolute = path.join(root, relative)
    const stat = fs.statSync(absolute)
    return {
      path: relative,
      size: stat.size,
      hash: skipHashes || stat.size === 0 ? '' : hashFile(absolute)
    }
  }))
  const totalBytes = entries.reduce((total, entry) => total + entry.size, 0)
  const asarPath = entries.find((entry) => entry.path === 'resources/app.asar')
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    root,
    totalBytes,
    files: entries.length,
    topLevel: groupBy(entries, (entry) => entry.path.split('/')[0]),
    byExtension: groupBy(entries, (entry) => extensionOf(entry.path)),
    duplicates: duplicateGroups(entries),
    asar: asarPath ? readAsar(path.join(root, 'resources', 'app.asar')) : null
  }
}

function printReport(report, verdict) {
  const mib = (bytes) => `${(Number(bytes || 0) / 1024 / 1024).toFixed(1)} MiB`
  console.log(`release size: ${mib(report.totalBytes)} in ${report.files} files`)
  for (const group of report.topLevel) console.log(`  ${group.id.padEnd(28)} ${mib(group.bytes).padStart(11)}  ${group.files} files`)
  const duplicateBytes = report.duplicates.reduce((total, group) => total + group.duplicatedBytes, 0)
  if (duplicateBytes > 0) console.log(`duplicate content: ${mib(duplicateBytes)} across ${report.duplicates.length} groups`)
  if (report.asar && !report.asar.error) console.log(`app.asar: packed ${mib(report.asar.packedBytes)}, unpacked ${mib(report.asar.unpackedBytes)} (${report.asar.unpackedFiles} files)`)
  if (!verdict) return
  console.log(verdict.ok ? 'size gate: PASS' : 'size gate: FAIL')
  console.log(`total growth: ${verdict.totalGrowthRatio === null ? 'n/a' : (verdict.totalGrowthRatio * 100).toFixed(1) + '%'}`)
  for (const component of verdict.components.filter((item) => item.needsAttribution)) {
    console.log(`  needs attribution: ${component.id} (${component.baselineBytes} -> ${component.currentBytes})`)
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const report = buildReport(args)
  let verdict = null
  if (args.baseline) {
    const baseline = JSON.parse(fs.readFileSync(args.baseline, 'utf8'))
    verdict = compareReports(report, baseline, { maxGrowthRatio: args.maxGrowth })
  }
  printReport(report, verdict)
  if (args.out) {
    fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true })
    fs.writeFileSync(args.out, JSON.stringify({ ...report, verdict }, null, 2) + '\n')
  }
  if (verdict && !verdict.ok) process.exitCode = 1
}

if (require.main === module) {
  try { main() } catch (error) { console.error('report-release-size:', error.message); process.exitCode = 1 }
}

module.exports = { buildReport, parseArgs, printReport, walk }
