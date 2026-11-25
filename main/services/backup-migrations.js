'use strict'

// D04 (plan item 19): the PRODUCTION backup migration registration.
//
// A restored package is only as trustworthy as the code that validated it. Before this
// module existed, `restoreDataRootBackup` looked up `deps.backupMigrationHooks` - a map only
// a test ever populated - so a real user restoring a package from the previous release got
// `migration-required`. The hooks here are the production default: they run inside the
// staging root (never the live data root), validate what the package claims to contain, and
// leave the staged tree untouched when a check fails.
//
// Two independent things are versioned and must not be conflated:
//   * the BACKUP package format (data-root-backup.js BACKUP_FORMAT_VERSION, currently 2);
//   * the APPLICATION version that produced the package (the manifest's `version`).
// A package from an older application version is migrated step by step; a package whose
// application version is outside the supported window is refused with the range, so the
// user is told what is supported instead of a generic failure.

const fs = require('node:fs')
const path = require('node:path')

// How many minor lines back a restore is supported. 1 means "the current minor line and the
// previous one" - the plan's "上一个受支持版本".
const SUPPORTED_MINOR_LINES = 1

function versionParts(value) {
  const text = String(value || '').trim()
  if (!/^\d+(\.\d+)*$/.test(text)) return null
  return text.split('.').map(Number)
}

function minimumSupportedVersion(currentVersion) {
  const parts = versionParts(currentVersion)
  if (!parts || parts.length < 2) return ''
  const minor = Math.max(0, parts[1] - SUPPORTED_MINOR_LINES)
  return [parts[0], minor, 0].join('.')
}

function compareVersions(left, right) {
  const a = versionParts(left)
  const b = versionParts(right)
  if (!a || !b) return 0
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0)
    if (difference !== 0) return difference < 0 ? -1 : 1
  }
  return 0
}

function readJsonFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8')
  const value = JSON.parse(text)
  return value
}

// The modules whose JSON is a contract the app will read after the relaunch. A staged file
// that does not parse is exactly the sort of silent corruption this step exists to catch.
function validateStagedModules(stageDirectory) {
  const problems = []
  const checkJson = (relative) => {
    const filePath = path.join(stageDirectory, ...relative.split('/'))
    if (!fs.existsSync(filePath)) return
    try {
      readJsonFile(filePath)
    } catch (error) {
      problems.push(`${relative}: ${error.message}`)
    }
  }
  checkJson('config/config.json')
  checkJson('config.json')
  checkJson('history/index.json')
  // Every recording project manifest must parse; a restore that cannot read one would show
  // an empty recordings list after the relaunch.
  const recordingsDirectory = path.join(stageDirectory, 'recordings')
  if (fs.existsSync(recordingsDirectory) && fs.statSync(recordingsDirectory).isDirectory()) {
    for (const entry of fs.readdirSync(recordingsDirectory)) {
      const manifest = path.join(recordingsDirectory, entry, 'project.json')
      if (!fs.existsSync(manifest)) continue
      try {
        readJsonFile(manifest)
      } catch (error) {
        problems.push(`recordings/${entry}/project.json: ${error.message}`)
      }
    }
  }
  return problems
}

// One step of an application-version migration. The checks are deliberately data-shaped
// rather than code-shaped: a step may not "upgrade" a package whose files it cannot read.
function migrateBackupStep(step) {
  if (!step || typeof step.directory !== 'string') {
    return { ok: false, message: 'the migration step has no staging directory' }
  }
  const problems = validateStagedModules(step.directory)
  if (problems.length) return { ok: false, message: `restored data failed validation: ${problems.join('; ')}` }
  return { ok: true, from: step.from, to: step.to, validated: true }
}

function verifyRestoredBackup(context = {}) {
  if (!context.directory) return { ok: false, message: 'the restored data has no staging directory' }
  const problems = validateStagedModules(context.directory)
  if (problems.length) return { ok: false, message: `restored data failed validation: ${problems.join('; ')}` }
  return { ok: true, phase: context.phase || 'copied' }
}

// The map shape the domain already understands (`from->to`), plus `resolve()` for steps that
// have no explicit entry. Registration is explicit for the versions this release claims to
// support from: a step outside the window is still validated, but the version window check
// in the service refuses it before a hook runs.
const backupMigrationHooks = {
  // The previous supported release line. Kept as an explicit entry so the intent is visible
  // in review: 5.0.0 -> 5.0.1 only validates the staged data; the layout is unchanged.
  '5.0.0->5.0.1': migrateBackupStep,
  resolve: (step) => (step ? migrateBackupStep : null),
  verify: verifyRestoredBackup,
  minimumSupportedVersion,
  compareVersions,
  isValidVersion: (value) => versionParts(value) !== null,
  supportedRange: (currentVersion) => {
    const minimum = minimumSupportedVersion(currentVersion)
    return minimum ? `${minimum} .. ${String(currentVersion || '')}` : ''
  },
  validateStagedModules
}

function createBackupMigrationHooks() {
  return backupMigrationHooks
}

function supportedRange(currentVersion) {
  const minimum = minimumSupportedVersion(currentVersion)
  return minimum ? minimum + ' .. ' + String(currentVersion || '') : ''
}

module.exports = {
  SUPPORTED_MINOR_LINES,
  backupMigrationHooks,
  compareVersions,
  createBackupMigrationHooks,
  migrateBackupStep,
  minimumSupportedVersion,
  supportedRange,
  validateStagedModules,
  verifyRestoredBackup,
  versionParts
}
