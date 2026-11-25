'use strict'

// D04 (docs/reviews/2026-11-24-windows-product-architecture-review.md): a
// user-facing, module-scoped local backup of the Highlighter data root, plus the
// restore path that consumes it.
//
// The data-root migration (./data-root-migration.js) and the diagnostics ZIP
// answer different questions. A migration moves one live root to another and
// keeps a versioned marker so a crash can be recovered; a diagnostics ZIP
// deliberately excludes user content. This module is the third thing: a
// portable, inspectable package a user can keep across machines and restore into
// a NEW root, with the old root left untouched if anything fails.
//
// Contract:
//   * A backup is a directory, not an archive:
//       <target>/highlighter-backup-<version>-<stamp>/
//         .highlighter-backup.json   identity marker (written first)
//         modules.json               complete module manifest (written last)
//         modules/<module>/...       copied files, grouped per module
//   * modules.json records the data version, per-module file count/bytes, every
//     file's sha256, external path references and whether the module carries
//     sensitive history. A manifest-level checksum detects tampering.
//   * Credentials, diagnostics/crash dumps, caches and runtime state are never
//     copied. The settings module is a redacted `config.json` snapshot.
//   * SQLite consistency is the caller's job: if any selected module contains a
//     .db/.sqlite file, an injectable quiesce/resume pair is called around the
//     copy. This module never opens a database.
//   * A killed backup leaves the marker plus an incomplete manifest, so
//     inspectBackup() reports `incomplete` and deleteBackup() can remove it.
//   * restoreBackup() copies into `.highlighter-restore-<id>` under the new
//     root, migrates one version at a time, verifies, publishes by rename, and
//     only then returns the locator to switch. Every failure path rolls the new
//     root back and leaves the old root untouched.
//
// All filesystem ordering is deterministic (sorted paths, fixed object key
// order) so the same inputs produce the same manifest on every platform except
// for timestamps the caller injects.

const crypto = require('node:crypto')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')

const BACKUP_FORMAT = 'highlighter-data-backup'
// D04 (plan item 06): format 2 gives the history module its OWN index file
// (modules/history/index.json) and keeps captureHistory out of the settings module.
// Format 1 packages stay readable - they are upgraded by reading the index out of their
// settings config, which is the only place an old package could have kept it.
const BACKUP_FORMAT_VERSION = 2
const MIN_SUPPORTED_FORMAT_VERSION = 1
const HISTORY_INDEX_FILE = 'index.json'
const HISTORY_INDEX_SCHEMA_VERSION = 1
const MARKER_FILE = '.highlighter-backup.json'
const MANIFEST_FILE = 'modules.json'
const BACKUP_DIRECTORY_PREFIX = 'highlighter-backup-'
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const SQLITE_EXTENSIONS = new Set(['.db', '.sqlite', '.sqlite3'])
const MAX_EXTERNAL_REFS = 200
const MAX_SCANNED_JSON_BYTES = 4 * 1024 * 1024
const MAX_JSON_SCAN_DEPTH = 8

// Which directories belong to which module. `directory` is both the source
// directory under the data root and the target directory after a restore, so a
// backup never invents a new layout. `settings` is the one module whose source
// is a single redacted file (config/config.json) rather than the whole folder.
const MODULE_DEFINITIONS = {
  history: {
    id: 'history',
    directory: 'history',
    sensitive: true,
    scanJson: true,
    labelKey: 'config.settings-system.backup-module-history'
  },
  clipboard: {
    id: 'clipboard',
    directory: 'clipboard',
    sensitive: true,
    scanJson: true,
    // The clipboard backend keeps preview thumbnails and copy staging under the
    // store directory; both are caches and are excluded from a migration too.
    excludePrefixes: ['thumbnails/', 'staging/', '.staging/'],
    labelKey: 'config.settings-system.backup-module-clipboard'
  },
  recordings: {
    id: 'recordings',
    directory: 'recordings',
    sensitive: true,
    scanJson: true,
    labelKey: 'config.settings-system.backup-module-recordings'
  },
  conversations: {
    id: 'conversations',
    directory: 'conversations',
    sensitive: true,
    scanJson: true,
    labelKey: 'config.settings-system.backup-module-conversations'
  },
  usage: {
    id: 'usage',
    directory: 'usage',
    sensitive: false,
    scanJson: false,
    labelKey: 'config.settings-system.backup-module-usage'
  },
  settings: {
    id: 'settings',
    directory: 'config',
    sensitive: false,
    settings: true,
    labelKey: 'config.settings-system.backup-module-settings'
  }
}

const MODULE_ORDER = ['history', 'clipboard', 'recordings', 'conversations', 'usage', 'settings']
const DEFAULT_MODULES = ['history', 'clipboard', 'recordings', 'settings']

// A normal (non-portable) installation that never chose a data root still uses
// the legacy userData layout: config.json at the root and capture-history/ rather
// than history/. A backup has to carry that layout too, because restoring it to
// the managed layout is exactly how an upgraded install rejoins the new shape.
const LEGACY_SOURCE_DIRECTORIES = {
  history: 'capture-history',
  clipboard: 'clipboard',
  recordings: 'recordings',
  conversations: 'conversations',
  usage: 'usage',
  settings: ''
}

// Cache, runtime state, logs and diagnostics are never part of a user backup.
// These names are matched at any depth so a module-local cache cannot sneak in.
const EXCLUDED_DIRECTORY_NAMES = new Set([
  'cache',
  'runtime',
  'logs',
  'diagnostics',
  'diagnostic-dumps',
  'crash-dumps',
  'crashdumps',
  'dumps',
  'credentials',
  'secrets',
  'keys',
  '.staging',
  'staging'
])
const EXCLUDED_FILE_PATTERN = /(^|[._-])(credentials?|secrets?)([._-]|$)|^\.env(\.|$)|\.(key|pem|pfx|p12|dmp|hdmp)$/i
const SECRET_KEY_PATTERN = /^(api[-_]?key|api[-_]?keys|providerApiKeys|credentials?|secrets?|password|token|access[-_]?token|refresh[-_]?token)$/i
const EXCLUDED_DESCRIPTIONS = [
  'credentials and secret keys',
  'diagnostics bundles and crash dumps',
  'cache and runtime directories',
  'logs'
]
const PATH_VALUE_KEYS = new Set([
  'path',
  'filePath',
  'sourcePath',
  'outputPath',
  'directory',
  'saveDirectory',
  'historyDirectory',
  'thumbnailPath',
  'targetPath',
  'originalPath',
  'fullPath',
  'filePaths',
  'paths',
  'files',
  'attachments'
])

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isSha256(value) {
  return typeof value === 'string' && SHA256_PATTERN.test(value)
}

function isWithin(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function isAbsolutePath(value) {
  return typeof value === 'string' && value.trim() !== '' && path.isAbsolute(value)
}

function normalizeVersion(value) {
  if (value === undefined || value === null || value === '') return '0'
  return String(value).trim()
}

function failure(code, message = '', extra = {}) {
  return { ok: false, code, message, ...extra }
}

function codedError(code, message, extra = {}) {
  const error = new Error(message || code)
  error.code = code
  Object.assign(error, extra)
  return error
}

function classifyError(error) {
  if (error?.code === 'ENOSPC') return 'insufficient-space'
  if (error?.code === 'EACCES' || error?.code === 'EPERM') return 'permission-denied'
  if (typeof error?.code === 'string' && /^[a-z][a-z0-9-]+$/.test(error.code) && !/^E[A-Z]+$/.test(error.code)) return error.code
  return 'io-error'
}

function errorMessage(error) {
  return error?.message || String(error || '')
}

function validManifestPath(value) {
  return typeof value === 'string' && value !== '' && !value.includes('\\') && !value.includes('\0') &&
    !value.includes(':') && !path.posix.isAbsolute(value) && path.posix.normalize(value) === value &&
    value.split('/').every((segment) => segment && segment !== '.' && segment !== '..')
}

function pad(value) {
  return String(value).padStart(2, '0')
}

function backupStamp(now) {
  const date = new Date(now)
  const safe = Number.isNaN(date.getTime()) ? new Date() : date
  return [
    `${safe.getFullYear()}${pad(safe.getMonth() + 1)}${pad(safe.getDate())}`,
    `${pad(safe.getHours())}${pad(safe.getMinutes())}${pad(safe.getSeconds())}`
  ].join('-')
}

function safeVersionSegment(version) {
  const text = normalizeVersion(version).replace(/[^0-9A-Za-z._-]+/g, '-').replace(/^-+|-+$/g, '')
  return text || '0'
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

async function defaultStat(filePath) {
  return fsp.stat(filePath)
}

async function lstatOrNull(filePath) {
  try {
    return await fsp.lstat(filePath)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

async function directoryExists(directory) {
  const stat = await lstatOrNull(directory)
  return !!stat && stat.isDirectory()
}

async function detectSourceLayout(root) {
  const [managedConfig, legacyConfig, managedHistory, legacyHistory] = await Promise.all([
    lstatOrNull(path.join(root, 'config', 'config.json')),
    lstatOrNull(path.join(root, 'config.json')),
    lstatOrNull(path.join(root, 'history')),
    lstatOrNull(path.join(root, 'capture-history'))
  ])
  if (managedConfig || (managedHistory && !legacyHistory)) return 'managed'
  if (legacyConfig || legacyHistory) return 'legacy'
  return 'managed'
}

function moduleSourceDirectory(root, moduleId, layout) {
  if (layout !== 'legacy') return path.join(root, MODULE_DEFINITIONS[moduleId].directory)
  return LEGACY_SOURCE_DIRECTORIES[moduleId] === ''
    ? root
    : path.join(root, LEGACY_SOURCE_DIRECTORIES[moduleId])
}

async function readJsonOrNull(filePath) {
  let text
  try {
    text = await fsp.readFile(filePath, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, value: null, error: null }
    throw error
  }
  try {
    return { exists: true, value: JSON.parse(text), error: null }
  } catch (error) {
    return { exists: true, value: null, error }
  }
}

async function writeJsonAtomic(filePath, value, operations = {}) {
  const writeFile = operations.writeFile || fsp.writeFile
  const rename = operations.rename || fsp.rename
  const remove = operations.remove || fsp.rm
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await rename(temporaryPath, filePath)
  } finally {
    await remove(temporaryPath, { force: true }).catch(() => {})
  }
}

async function defaultFreeBytes(directory) {
  if (typeof fsp.statfs !== 'function') return null
  const stats = await fsp.statfs(directory)
  const blockSize = Number(stats.bsize) || 0
  const available = Number(stats.bavail ?? stats.bfree) || 0
  return blockSize > 0 ? blockSize * available : null
}

function normalizeModuleSpecs(modules) {
  const input = modules === undefined || modules === null ? DEFAULT_MODULES : modules
  const list = Array.isArray(input) ? input : [input]
  const specs = []
  const seen = new Set()
  for (const entry of list) {
    const id = typeof entry === 'string' ? entry : entry?.id
    if (!Object.hasOwn(MODULE_DEFINITIONS, id)) return { error: `unsupported module: ${String(id)}` }
    if (seen.has(id)) continue
    seen.add(id)
    const directory = typeof entry === 'object' && isAbsolutePath(entry.directory) ? path.resolve(entry.directory) : ''
    specs.push({ id, directory: directory || null })
  }
  if (!specs.length) return { error: 'no modules selected' }
  specs.sort((left, right) => MODULE_ORDER.indexOf(left.id) - MODULE_ORDER.indexOf(right.id))
  return { specs }
}

function excludedDirectory(name) {
  return EXCLUDED_DIRECTORY_NAMES.has(name.toLowerCase())
}

function excludedFile(name) {
  return EXCLUDED_FILE_PATTERN.test(name)
}

async function listModuleFilePlan(sourceDirectory, definition) {
  const plan = {
    files: [],
    skippedFiles: 0,
    skippedDirectories: 0,
    hasSqlite: false
  }
  if (!await directoryExists(sourceDirectory)) return plan

  const walk = async (directory, relativePrefix) => {
    const entries = await fsp.readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name)
      const relativePath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name
      const stat = await fsp.lstat(absolutePath)
      if (stat.isSymbolicLink()) throw codedError('unsupported-link', `symbolic links are not allowed: ${absolutePath}`, { filePath: absolutePath })
      if (stat.isDirectory()) {
        if (excludedDirectory(entry.name) || definition.excludePrefixes?.some((prefix) => `${relativePath}/`.startsWith(prefix))) {
          plan.skippedDirectories += 1
          continue
        }
        await walk(absolutePath, relativePath)
        continue
      }
      if (!stat.isFile()) {
        plan.skippedFiles += 1
        continue
      }
      if (excludedFile(entry.name) || definition.excludePrefixes?.some((prefix) => relativePath.startsWith(prefix))) {
        plan.skippedFiles += 1
        continue
      }
      plan.files.push({ relativePath, absolutePath, size: stat.size })
      if (SQLITE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) plan.hasSqlite = true
    }
  }

  await walk(sourceDirectory, '')
  plan.files.sort((left, right) => (left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0))
  return plan
}

function redactSecrets(value, trail = '', redacted = [], depth = 0) {
  if (depth > MAX_JSON_SCAN_DEPTH) return value
  if (Array.isArray(value)) {
    return value.map((entry, index) => redactSecrets(entry, `${trail}[${index}]`, redacted, depth + 1))
  }
  if (!isPlainObject(value)) return value
  const result = {}
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      if (redacted.length < 64) redacted.push(trail ? `${trail}.${key}` : key)
      continue
    }
    result[key] = redactSecrets(entry, trail ? `${trail}.${key}` : key, redacted, depth + 1)
  }
  return result
}

// The settings module carries SETTINGS only. The capture history (paths, OCR text and
// document references) belongs to the history module's own index - leaving it here used to
// make a "settings only" package sensitive without ever saying so.
function sanitizeSettingsConfig(config) {
  const redacted = []
  const value = isPlainObject(config) ? redactSecrets(config, '', redacted) : {}
  if (isPlainObject(value) && Object.hasOwn(value, 'captureHistory')) delete value.captureHistory
  return { value, redacted }
}

// The history module's index. It keeps the same shape the renderer/main process uses
// (captureHistory), so a restore can publish it byte-for-byte into config.json.
function buildHistoryIndex(config) {
  const entries = Array.isArray(config?.captureHistory) ? config.captureHistory : []
  return {
    schemaVersion: HISTORY_INDEX_SCHEMA_VERSION,
    captureHistory: entries.filter((entry) => isPlainObject(entry))
  }
}

function historyConfigRefs(config) {
  const refs = []
  const historyDirectory = config?.settings?.screenshot?.historyDirectory
  if (isAbsolutePath(historyDirectory)) refs.push({ path: historyDirectory, kind: 'history-library' })
  for (const entry of Array.isArray(config?.captureHistory) ? config.captureHistory : []) {
    for (const key of ['filePath', 'thumbnailPath']) {
      if (isAbsolutePath(entry?.[key])) refs.push({ path: entry[key], kind: 'capture-file' })
    }
  }
  return refs
}

function configRefsForModule(moduleId, config) {
  if (!config) return []
  if (moduleId === 'history') return historyConfigRefs(config)
  if (moduleId === 'recordings') {
    const directory = config?.settings?.record?.saveDirectory
    return isAbsolutePath(directory) ? [{ path: directory, kind: 'recording-output' }] : []
  }
  if (moduleId === 'settings') {
    const refs = []
    for (const [kind, value] of [
      ['history-library', config?.settings?.screenshot?.historyDirectory],
      ['capture-output', config?.settings?.screenshot?.saveDirectory],
      ['recording-output', config?.settings?.record?.saveDirectory]
    ]) {
      if (isAbsolutePath(value)) refs.push({ path: value, kind })
    }
    return refs
  }
  return []
}

function scanValuesForPaths(value, collect, keyHint = '', depth = 0) {
  if (depth > MAX_JSON_SCAN_DEPTH) return
  if (typeof value === 'string') {
    if (PATH_VALUE_KEYS.has(keyHint) && isAbsolutePath(value)) collect(value)
    return
  }
  if (Array.isArray(value)) {
    for (const entry of value) scanValuesForPaths(entry, collect, keyHint, depth + 1)
    return
  }
  if (!isPlainObject(value)) return
  for (const [key, entry] of Object.entries(value)) {
    scanValuesForPaths(entry, collect, key, depth + 1)
  }
}

async function collectExternalRefs({ plans, dataRoot, config, sourceRoots, readFile }) {
  const roots = [dataRoot, ...sourceRoots].filter(Boolean)
  const isExternal = (value) => {
    const resolved = path.resolve(value)
    return roots.every((root) => !isWithin(root, resolved))
  }
  const byModule = new Map()
  const add = (moduleId, value, kind, force = false) => {
    if (!isAbsolutePath(value)) return
    const resolved = path.resolve(value)
    if (force) {
      // A module explicitly backed up from outside the data root (an external
      // screenshot library) is itself a reference the user has to know about,
      // even though the selected source root makes its files "internal".
      if (isWithin(dataRoot, resolved)) return
    } else if (!isExternal(resolved)) {
      return
    }
    const current = byModule.get(moduleId) || new Map()
    if (!current.has(resolved)) current.set(resolved, { path: resolved, kind })
    byModule.set(moduleId, current)
  }

  for (const plan of plans) {
    if (plan.definition.settings) {
      for (const ref of configRefsForModule('settings', config)) add('settings', ref.path, ref.kind)
      continue
    }
    for (const ref of configRefsForModule(plan.id, config)) add(plan.id, ref.path, ref.kind)
    add(plan.id, plan.sourceDirectory, 'module-source', true)
    if (plan.definition.scanJson === false) continue
    for (const file of plan.files) {
      if (path.extname(file.relativePath).toLowerCase() !== '.json' || file.size > MAX_SCANNED_JSON_BYTES) continue
      let parsed
      try {
        parsed = JSON.parse(await readFile(file.absolutePath, 'utf8'))
      } catch {
        continue
      }
      scanValuesForPaths(parsed, (value) => add(plan.id, value, 'file-reference'))
    }
  }

  const externalRefs = {}
  let total = 0
  let truncated = false
  for (const id of MODULE_ORDER) {
    const entries = byModule.get(id)
    if (!entries) continue
    const sorted = [...entries.values()].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
    const limited = sorted.slice(0, MAX_EXTERNAL_REFS)
    if (limited.length < sorted.length) truncated = true
    total += limited.length
    externalRefs[id] = limited
  }
  return { externalRefs, externalRefCount: total, externalRefsTruncated: truncated }
}

function manifestChecksum(manifest) {
  const { checksum, ...rest } = manifest
  return crypto.createHash('sha256').update(JSON.stringify(rest)).digest('hex')
}

function moduleSummaryEntry(id, entry) {
  return {
    id,
    path: entry.path,
    fileCount: entry.fileCount,
    bytes: entry.bytes,
    sensitive: entry.sensitive,
    sqlite: entry.sqlite === true,
    sourcePath: entry.sourcePath,
    redactedCount: entry.redactedCount || 0,
    files: entry.files.map((file) => ({ path: file.path, size: file.size, sha256: file.sha256 })),
    externalRefs: entry.externalRefs
  }
}

function summaryModules(modules) {
  const summary = {}
  for (const id of MODULE_ORDER) {
    if (Object.hasOwn(modules, id)) summary[id] = moduleSummaryEntry(id, modules[id])
  }
  return summary
}

function manifestWarnings(warnings) {
  return Array.isArray(warnings) ? warnings.filter((entry) => entry && typeof entry.code === 'string') : []
}

function validateManifest(manifest) {
  const fail = (message) => {
    throw codedError('corrupt-manifest', message)
  }
  if (!isPlainObject(manifest) || manifest.format !== BACKUP_FORMAT) fail('backup manifest format is invalid')
  if (!Number.isSafeInteger(manifest.formatVersion) || manifest.formatVersion < 1) fail('backup manifest version is invalid')
  if (typeof manifest.version !== 'string' || manifest.version === '') fail('backup data version is invalid')
  if (typeof manifest.createdAt !== 'string' || !manifest.createdAt) fail('backup createdAt is invalid')
  if (manifest.incomplete !== false) fail('backup manifest is not complete')
  if (!isPlainObject(manifest.modules)) fail('backup module table is invalid')
  if (!isPlainObject(manifest.source) || typeof manifest.source.dataRoot !== 'string') fail('backup source is invalid')
  if (!Array.isArray(manifest.excluded)) fail('backup exclusion list is invalid')

  let totalBytes = 0
  let totalFiles = 0
  for (const [id, entry] of Object.entries(manifest.modules)) {
    if (!Object.hasOwn(MODULE_DEFINITIONS, id) || !isPlainObject(entry)) fail(`backup module is invalid: ${id}`)
    if (entry.id !== id) fail(`backup module id mismatch: ${id}`)
    if (!validManifestPath(entry.path) || !entry.path.startsWith('modules/')) fail(`backup module path is invalid: ${id}`)
    if (typeof entry.sensitive !== 'boolean') fail(`backup module sensitivity is invalid: ${id}`)
    if (typeof entry.sourcePath !== 'string' || !path.isAbsolute(entry.sourcePath)) fail(`backup module source is invalid: ${id}`)
    if (!Array.isArray(entry.files)) fail(`backup module file list is invalid: ${id}`)
    if (!Number.isSafeInteger(entry.fileCount) || entry.fileCount !== entry.files.length) fail(`backup module file count is invalid: ${id}`)
    let previous = null
    let bytes = 0
    for (const file of entry.files) {
      if (!isPlainObject(file) || !validManifestPath(file.path) || !Number.isSafeInteger(file.size) || file.size < 0 || !isSha256(file.sha256)) {
        fail(`backup file entry is invalid: ${id}`)
      }
      if (previous !== null && previous >= file.path) fail(`backup file list is not sorted: ${id}`)
      previous = file.path
      bytes += file.size
    }
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes !== bytes) fail(`backup module byte count is invalid: ${id}`)
    if (!Array.isArray(entry.externalRefs)) fail(`backup external reference list is invalid: ${id}`)
    for (const ref of entry.externalRefs) {
      if (!isPlainObject(ref) || typeof ref.path !== 'string' || !path.isAbsolute(ref.path) || typeof ref.kind !== 'string') {
        fail(`backup external reference is invalid: ${id}`)
      }
    }
    totalBytes += entry.bytes
    totalFiles += entry.fileCount
  }
  if (!Number.isSafeInteger(manifest.totalBytes) || manifest.totalBytes !== totalBytes) fail('backup total bytes is invalid')
  if (!Number.isSafeInteger(manifest.totalFiles) || manifest.totalFiles !== totalFiles) fail('backup total file count is invalid')
  if (!isSha256(manifest.checksum) || manifestChecksum(manifest) !== manifest.checksum) fail('backup manifest checksum mismatch')
  return manifest
}

async function inspectBackup(directory, options = {}) {
  const {
    hash = sha256File,
    verifyChecksums = false,
    supportedFormatVersion = BACKUP_FORMAT_VERSION,
    exists = async (value) => lstatOrNull(value).then(Boolean)
  } = options
  const resolved = path.resolve(String(directory || ''))
  const markerPath = path.join(resolved, MARKER_FILE)
  const manifestPath = path.join(resolved, MANIFEST_FILE)
  const marker = await readJsonOrNull(markerPath).catch(() => null)
  if (!marker || !marker.exists) {
    // A process killed between creating the directory and writing the marker
    // leaves an empty (or temp-file-only) directory. Name it incomplete instead
    // of pretending it is unrelated user data, so it can be cleaned up.
    if (path.basename(resolved).startsWith(BACKUP_DIRECTORY_PREFIX)) {
      return failure('incomplete', 'the backup was interrupted before its manifest was written')
    }
    return failure('not-backup', 'the directory is not a Highlighter backup')
  }

  const markerValue = marker.value
  if (!isPlainObject(markerValue) || markerValue.format !== BACKUP_FORMAT || !Number.isSafeInteger(markerValue.formatVersion)) {
    return failure('not-backup', 'the backup marker is invalid')
  }
  if (markerValue.formatVersion > supportedFormatVersion) {
    return failure('future-schema', 'the backup was created by a newer Highlighter build', { formatVersion: markerValue.formatVersion })
  }

  const manifestRead = await readJsonOrNull(manifestPath).catch(() => null)
  if (!manifestRead || !manifestRead.exists) return failure('incomplete', 'the backup manifest is missing')
  if (manifestRead.error || !isPlainObject(manifestRead.value)) return failure('corrupt-manifest', 'the backup manifest is not valid JSON')

  const manifest = manifestRead.value
  if (manifest.format === BACKUP_FORMAT && Number.isSafeInteger(manifest.formatVersion) && manifest.formatVersion > supportedFormatVersion) {
    return failure('future-schema', 'the backup was created by a newer Highlighter build', { formatVersion: manifest.formatVersion })
  }
  if (manifest.format === BACKUP_FORMAT && manifest.formatVersion < 1) {
    return failure('unsupported-schema', 'the backup format version is not supported')
  }
  if (manifest.incomplete === true) return failure('incomplete', 'the backup did not finish')
  try {
    validateManifest(manifest)
  } catch (error) {
    return failure(error.code || 'corrupt-manifest', errorMessage(error))
  }

  try {
    for (const [id, entry] of Object.entries(manifest.modules)) {
      const moduleRoot = path.join(resolved, ...entry.path.split('/'))
      for (const file of entry.files) {
        const filePath = path.join(moduleRoot, ...file.path.split('/'))
        const stat = await lstatOrNull(filePath)
        if (!stat || !stat.isFile()) return failure('missing-file', `backup file is missing: ${id}/${file.path}`, { module: id, file: file.path })
        if (stat.size !== file.size) return failure('missing-file', `backup file size changed: ${id}/${file.path}`, { module: id, file: file.path })
        if (verifyChecksums) {
          const digest = await hash(filePath)
          if (digest !== file.sha256) return failure('checksum-mismatch', `backup file checksum mismatch: ${id}/${file.path}`, { module: id, file: file.path })
        }
      }
    }
  } catch (error) {
    if (error.code && error.code !== 'ENOENT') return failure(classifyError(error), errorMessage(error))
    return failure('missing-file', errorMessage(error))
  }

  const modules = summaryModules(manifest.modules)
  const externalRefs = []
  const sensitive = []
  for (const id of MODULE_ORDER) {
    const entry = manifest.modules[id]
    if (!entry) continue
    if (entry.sensitive) sensitive.push(id)
    for (const ref of entry.externalRefs) externalRefs.push({ module: id, ...ref })
  }
  const warnings = manifestWarnings(manifest.warnings)
  // Plan item 06: an old (format 1) package can still carry captureHistory inside its
  // settings module. It is sensitive even though the module itself is not, and the
  // inspection has to say so before the user restores it.
  const settingsEntry = manifest.modules.settings
  if (settingsEntry && !sensitive.includes('settings')) {
    const settingsFile = (settingsEntry.files || []).find((file) => file.path === 'config.json')
    if (settingsFile) {
      try {
        const rawConfig = JSON.parse(await fsp.readFile(path.join(resolved, ...settingsEntry.path.split('/'), 'config.json'), 'utf8'))
        if (Array.isArray(rawConfig?.captureHistory) && rawConfig.captureHistory.length) {
          sensitive.push('settings')
          if (!warnings.some((warning) => warning.code === 'settings-carries-history')) {
            warnings.push({ code: 'settings-carries-history' })
          }
        }
      } catch {}
    }
  }
  const historyIndex = inspectHistoryIndex(manifest, resolved)
  for (const ref of externalRefs.slice(0, 20)) {
    const available = await exists(ref.path).catch(() => false)
    if (!available) warnings.push({ code: 'external-ref-unavailable', module: ref.module, path: ref.path })
  }

  return {
    ok: true,
    code: 'ok',
    directory: resolved,
    version: manifest.version,
    formatVersion: manifest.formatVersion,
    createdAt: manifest.createdAt,
    completedAt: typeof manifest.completedAt === 'string' ? manifest.completedAt : '',
    source: manifest.source,
    modules,
    moduleOrder: Object.keys(manifest.modules),
    totalBytes: manifest.totalBytes,
    totalFiles: manifest.totalFiles,
    checksum: manifest.checksum,
    externalRefs,
    externalRefCount: externalRefs.length,
    externalRefsTruncated: manifest.externalRefsTruncated === true,
    sensitive: sensitive.length > 0,
    sensitiveModules: sensitive,
    containsSensitive: sensitive.length > 0,
    sqliteQuiesced: manifest.sqliteQuiesced === true,
    // Item 06: does this package carry a usable history index (its own, or an old
    // settings-carried one), and - when it does not - the files are still restorable but
    // the metadata is not.
    historyIndex,
    warnings
  }
}

function inspectHistoryIndex(manifest, resolved) {
  const historyEntry = manifest.modules?.history
  const indexFile = (historyEntry?.files || []).find((file) => file.path === HISTORY_INDEX_FILE)
  if (historyEntry && indexFile) {
    return { available: true, source: 'history-index', file: HISTORY_INDEX_FILE, entryCount: historyEntry.indexEntryCount ?? null }
  }
  // A format 1 package kept the list in the settings module.
  const settingsEntry = manifest.modules?.settings
  const settingsFile = (settingsEntry?.files || []).find((file) => file.path === 'config.json')
  if (settingsEntry && settingsFile) {
    return { available: true, source: 'settings-capture-history', file: 'config.json', entryCount: null }
  }
  return { available: false, source: '', file: '', entryCount: null }
}

async function createUniqueBackupDirectory(targetDirectory, version, now, mkdir) {
  const base = `${BACKUP_DIRECTORY_PREFIX}${safeVersionSegment(version)}-${backupStamp(now)}`
  for (let index = 1; index <= 1000; index += 1) {
    const name = index === 1 ? base : `${base}-${index}`
    const candidate = path.join(targetDirectory, name)
    try {
      await mkdir(candidate, { recursive: false })
      return candidate
    } catch (error) {
      if (error.code === 'EEXIST') continue
      throw error
    }
  }
  throw codedError('backup-name-conflict', 'could not allocate a unique backup directory')
}

async function readSourceConfig(dataRoot, layout = 'managed') {
  const configPath = layout === 'legacy'
    ? path.join(dataRoot, 'config.json')
    : path.join(dataRoot, 'config', 'config.json')
  const read = await readJsonOrNull(configPath).catch(() => null)
  if (!read || !read.exists) return { config: null, warning: null }
  if (read.error || !isPlainObject(read.value)) return { config: null, warning: { code: 'settings-unreadable' } }
  return { config: read.value, warning: null }
}

// D04 (plan item 08): the validation half of a backup, without touching a single writer or
// file. The data-root domain calls this FIRST so a refused request (unknown module, target
// inside the data root, insufficient space) can never stop a live recording.
async function validateBackupRequest(options = {}) {
  const {
    dataRoot,
    modules = DEFAULT_MODULES,
    targetDirectory,
    version = '',
    portable = false,
    layout = null,
    freeBytes = defaultFreeBytes,
    before = Date.now()
  } = options

  if (!isAbsolutePath(dataRoot)) return failure('invalid-request', 'dataRoot must be an absolute path')
  if (!isAbsolutePath(targetDirectory)) return failure('invalid-request', 'targetDirectory must be an absolute path')
  const root = path.resolve(dataRoot)
  const target = path.resolve(targetDirectory)
  if (isWithin(root, target)) return failure('invalid-target', 'the backup target cannot be inside the data root')
  const normalized = normalizeModuleSpecs(modules)
  if (normalized.error) return failure('invalid-request', normalized.error)

  const sourceLayout = layout === 'legacy' || layout === 'managed' ? layout : await detectSourceLayout(root)
  const configRead = await readSourceConfig(root, sourceLayout)
  const warnings = configRead.warning ? [configRead.warning] : []
  const plans = []
  let estimatedBytes = 0
  let hasSqlite = false
  try {
    for (const spec of normalized.specs) {
      const definition = MODULE_DEFINITIONS[spec.id]
      const sourceDirectory = spec.directory || moduleSourceDirectory(root, spec.id, sourceLayout)
      if (definition.settings) {
        const configPath = path.join(sourceDirectory, 'config.json')
        const configStat = await lstatOrNull(configPath)
        plans.push({ id: spec.id, definition, sourceDirectory, settingsSource: configStat && configStat.isFile() ? configPath : '' })
        if (configStat && configStat.isFile()) estimatedBytes += configStat.size
        continue
      }
      const plan = await listModuleFilePlan(sourceDirectory, definition)
      plans.push({ id: spec.id, definition, sourceDirectory, ...plan })
      estimatedBytes += plan.files.reduce((sum, file) => sum + file.size, 0)
      hasSqlite = hasSqlite || plan.hasSqlite
    }
  } catch (error) {
    return failure(classifyError(error), errorMessage(error))
  }
  if (!(await directoryExists(target))) {
    try {
      await lstatOrNull(target)
    } catch (error) {
      return failure(classifyError(error), errorMessage(error))
    }
  }
  let availableBytes = null
  try {
    availableBytes = await freeBytes(target)
  } catch {
    availableBytes = null
  }
  if (Number.isFinite(availableBytes) && availableBytes < estimatedBytes) {
    return failure('insufficient-space', 'not enough free space for the selected modules', {
      requiredBytes: estimatedBytes,
      freeBytes: availableBytes
    })
  }
  return {
    ok: true,
    code: 'ok',
    modules: normalized.specs.map((spec) => spec.id),
    layout: sourceLayout,
    version: normalizeVersion(version),
    portable: portable === true,
    estimatedBytes,
    hasSqlite,
    warnings,
    // Which modules need their own writer paused, and which need the app to be idle.
    requiresQuiesce: normalized.specs.map((spec) => spec.id).filter((id) => id === 'usage' || id === 'clipboard' || id === 'conversations'),
    requiresExclusive: normalized.specs.some((spec) => spec.id === 'recordings'),
    plans: plans.map((plan) => ({ id: plan.id, sourceDirectory: plan.sourceDirectory, fileCount: plan.files?.length || 0 }))
  }
}

async function createBackup(options = {}) {
  const {
    dataRoot,
    modules = DEFAULT_MODULES,
    targetDirectory,
    version = '',
    portable = false,
    layout = null,
    now = Date.now(),
    copy = fsp.copyFile,
    hash = sha256File,
    stat = defaultStat,
    freeBytes = defaultFreeBytes,
    writeFile = fsp.writeFile,
    readFile = fsp.readFile,
    mkdir = fsp.mkdir,
    rename = fsp.rename,
    remove = fsp.rm,
    quiesce = null,
    resume = null,
    writersQuiesced = false,
    sanitizeSettings = sanitizeSettingsConfig
  } = options

  if (!isAbsolutePath(dataRoot)) return failure('invalid-request', 'dataRoot must be an absolute path')
  if (!isAbsolutePath(targetDirectory)) return failure('invalid-request', 'targetDirectory must be an absolute path')
  const root = path.resolve(dataRoot)
  const target = path.resolve(targetDirectory)
  if (isWithin(root, target)) return failure('invalid-target', 'the backup target cannot be inside the data root')

  const normalized = normalizeModuleSpecs(modules)
  if (normalized.error) return failure('invalid-request', normalized.error)

  const sourceLayout = layout === 'legacy' || layout === 'managed' ? layout : await detectSourceLayout(root)
  const configRead = await readSourceConfig(root, sourceLayout)
  const warnings = configRead.warning ? [configRead.warning] : []
  const config = configRead.config

  const plans = []
  let estimatedBytes = 0
  let hasSqlite = false
  try {
    for (const spec of normalized.specs) {
      const definition = MODULE_DEFINITIONS[spec.id]
      const sourceDirectory = spec.directory || moduleSourceDirectory(root, spec.id, sourceLayout)
      if (definition.settings) {
        const configPath = path.join(sourceDirectory, 'config.json')
        const configStat = await lstatOrNull(configPath)
        plans.push({
          id: spec.id,
          definition,
          sourceDirectory,
          settingsSource: configStat && configStat.isFile() ? configPath : '',
          files: [],
          skippedFiles: 0,
          skippedDirectories: 0,
          hasSqlite: false
        })
        if (configStat && configStat.isFile()) estimatedBytes += configStat.size
        continue
      }
      const plan = await listModuleFilePlan(sourceDirectory, definition)
      plans.push({ id: spec.id, definition, sourceDirectory, settingsSource: '', ...plan })
      estimatedBytes += plan.files.reduce((sum, file) => sum + file.size, 0)
      hasSqlite = hasSqlite || plan.hasSqlite
    }
  } catch (error) {
    return failure(classifyError(error), errorMessage(error))
  }

  try {
    await mkdir(target, { recursive: true })
  } catch (error) {
    return failure(classifyError(error), errorMessage(error))
  }

  let availableBytes = null
  try {
    availableBytes = await freeBytes(target)
  } catch {
    availableBytes = null
  }
  if (Number.isFinite(availableBytes) && availableBytes < estimatedBytes) {
    return failure('insufficient-space', 'not enough free space for the selected modules', {
      requiredBytes: estimatedBytes,
      freeBytes: availableBytes
    })
  }

  let backupDirectory
  try {
    backupDirectory = await createUniqueBackupDirectory(target, version, now, mkdir)
  } catch (error) {
    return failure(classifyError(error), errorMessage(error))
  }

  const createdAt = new Date(now).toISOString()
  const marker = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    version: normalizeVersion(version),
    createdAt
  }
  const markerPath = path.join(backupDirectory, MARKER_FILE)
  const manifestPath = path.join(backupDirectory, MANIFEST_FILE)
  let quiesced = false
  let result

  try {
    await writeJsonAtomic(markerPath, marker, { writeFile, rename, remove })
    await writeJsonAtomic(manifestPath, {
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION,
      version: marker.version,
      createdAt,
      incomplete: true,
      modules: {}
    }, { writeFile, rename, remove })

    if (hasSqlite) {
      // The caller may already have stopped every managed writer (the data-root
      // domain does); in that case there is nothing left for the hook to do, but
      // the manifest must still record that the database was copied quiesced.
      if (typeof quiesce === 'function') {
        await quiesce()
        quiesced = true
      } else if (writersQuiesced === true) {
        quiesced = true
      }
    }

    const externalScan = await collectExternalRefs({
      plans,
      dataRoot: root,
      config,
      sourceRoots: plans.map((plan) => plan.sourceDirectory),
      readFile
    })

    const manifestModules = {}
    for (const plan of plans) {
      const moduleDirectory = path.join(backupDirectory, 'modules', plan.id)
      await mkdir(moduleDirectory, { recursive: true })
      const files = []
      if (plan.id === 'history') {
        // Item 06: the index travels with the module, not inside settings. It is written
        // first so the manifest's sorted file list stays valid.
        const index = buildHistoryIndex(config)
        const indexTarget = path.join(moduleDirectory, HISTORY_INDEX_FILE)
        await writeFile(indexTarget, JSON.stringify(index, null, 2) + '\n', 'utf8')
        const indexStat = await stat(indexTarget)
        files.push({ path: HISTORY_INDEX_FILE, size: indexStat.size, sha256: await hash(indexTarget) })
        for (const file of plan.files) {
          const targetFile = path.join(moduleDirectory, ...file.relativePath.split('/'))
          await mkdir(path.dirname(targetFile), { recursive: true })
          await copy(file.absolutePath, targetFile)
          const copiedStat = await stat(targetFile)
          if (!copiedStat || copiedStat.size !== file.size) throw codedError('copy-failed', 'copy did not produce the expected file: ' + file.relativePath)
          files.push({ path: file.relativePath, size: copiedStat.size, sha256: await hash(targetFile) })
        }
        files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
        manifestModules[plan.id] = {
          id: plan.id,
          path: 'modules/' + plan.id,
          sourcePath: plan.sourceDirectory,
          sensitive: true,
          sqlite: plan.hasSqlite === true,
          index: true,
          indexEntryCount: index.captureHistory.length,
          fileCount: files.length,
          bytes: files.reduce((sum, file) => sum + file.size, 0),
          files,
          externalRefs: externalScan.externalRefs[plan.id] || []
        }
        continue
      }
      if (plan.definition.settings && plan.settingsSource && config) {
        const { value, redacted } = sanitizeSettings(config)
        const targetFile = path.join(moduleDirectory, 'config.json')
        await writeFile(targetFile, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
        const copiedStat = await stat(targetFile)
        files.push({ path: 'config.json', size: copiedStat.size, sha256: await hash(targetFile) })
        manifestModules[plan.id] = {
          id: plan.id,
          path: `modules/${plan.id}`,
          sourcePath: plan.sourceDirectory,
          sensitive: false,
          redactedCount: redacted.length,
          sqlite: false,
          fileCount: files.length,
          bytes: files.reduce((sum, file) => sum + file.size, 0),
          files,
          externalRefs: externalScan.externalRefs[plan.id] || []
        }
        continue
      }
      if (!plan.definition.settings) {
        for (const file of plan.files) {
          const targetFile = path.join(moduleDirectory, ...file.relativePath.split('/'))
          await mkdir(path.dirname(targetFile), { recursive: true })
          await copy(file.absolutePath, targetFile)
          const copiedStat = await stat(targetFile)
          if (!copiedStat || copiedStat.size !== file.size) throw codedError('copy-failed', `copy did not produce the expected file: ${file.relativePath}`)
          files.push({ path: file.relativePath, size: copiedStat.size, sha256: await hash(targetFile) })
        }
      }
      manifestModules[plan.id] = {
        id: plan.id,
        path: `modules/${plan.id}`,
        sourcePath: plan.sourceDirectory,
        sensitive: plan.definition.sensitive === true,
        sqlite: plan.hasSqlite === true,
        fileCount: files.length,
        bytes: files.reduce((sum, file) => sum + file.size, 0),
        files,
        externalRefs: externalScan.externalRefs[plan.id] || []
      }
    }

    if (hasSqlite && !quiesced) warnings.push({ code: 'sqlite-not-quiesced' })
    const totalBytes = Object.values(manifestModules).reduce((sum, entry) => sum + entry.bytes, 0)
    const totalFiles = Object.values(manifestModules).reduce((sum, entry) => sum + entry.fileCount, 0)
    const manifest = {
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION,
      version: marker.version,
      createdAt,
      completedAt: new Date(now).toISOString(),
      incomplete: false,
      source: { dataRoot: root, portable: portable === true, layout: sourceLayout },
      modules: manifestModules,
      totalBytes,
      totalFiles,
      excluded: [...EXCLUDED_DESCRIPTIONS],
      sqliteQuiesced: quiesced,
      externalRefsTruncated: externalScan.externalRefsTruncated,
      warnings: manifestWarnings(warnings)
    }
    manifest.checksum = manifestChecksum(manifest)
    await writeJsonAtomic(manifestPath, manifest, { writeFile, rename, remove })

    result = {
      ok: true,
      code: 'ok',
      directory: backupDirectory,
      version: manifest.version,
      formatVersion: manifest.formatVersion,
      layout: sourceLayout,
      createdAt: manifest.createdAt,
      completedAt: manifest.completedAt,
      modules: summaryModules(manifestModules),
      moduleOrder: Object.keys(manifestModules),
      totalBytes,
      totalFiles,
      checksum: manifest.checksum,
      externalRefs: Object.entries(manifestModules).flatMap(([id, entry]) => entry.externalRefs.map((ref) => ({ module: id, ...ref }))),
      externalRefCount: externalScan.externalRefCount,
      externalRefsTruncated: externalScan.externalRefsTruncated,
      sensitive: MODULE_ORDER.some((id) => manifestModules[id]?.sensitive),
      sensitiveModules: MODULE_ORDER.filter((id) => manifestModules[id]?.sensitive),
      containsSensitive: MODULE_ORDER.some((id) => manifestModules[id]?.sensitive),
      sqliteQuiesced: quiesced,
      warnings: manifest.warnings
    }
  } catch (error) {
    result = failure(classifyError(error), errorMessage(error), {
      directory: backupDirectory,
      incomplete: true
    })
  } finally {
    if (quiesced) {
      try {
        await resume?.()
      } catch {
        // The backup itself is already complete or already failed; a failed
        // resume is reported by the caller's writer coordinator, not here.
      }
    }
  }
  return result
}

async function deleteBackup(directory, options = {}) {
  const { remove = fsp.rm, inspect = inspectBackup } = options
  if (!isAbsolutePath(directory)) return failure('invalid-request', 'the backup directory must be an absolute path')
  const resolved = path.resolve(directory)
  if (resolved === path.parse(resolved).root) return failure('invalid-target', 'refusing to remove a drive root')
  const directoryStat = await lstatOrNull(resolved)
  if (!directoryStat) return { ok: true, code: 'ok', removed: false, alreadyRemoved: true, directory: resolved }
  const marker = await lstatOrNull(path.join(resolved, MARKER_FILE))
  if (!marker || !marker.isFile()) {
    // Only a reserved-name directory that an interrupted creation left empty (or
    // with atomic-write temp files) may be removed without a marker.
    if (!path.basename(resolved).startsWith(BACKUP_DIRECTORY_PREFIX)) return failure('not-backup', 'the directory is not a Highlighter backup')
    const entries = await fsp.readdir(resolved).catch(() => null)
    if (!entries || entries.some((name) => !name.endsWith('.tmp'))) {
      return failure('not-backup', 'the directory is not an interrupted backup')
    }
    try {
      await remove(resolved, { recursive: true, force: true })
      return { ok: true, code: 'ok', removed: true, directory: resolved }
    } catch (error) {
      return failure(classifyError(error), errorMessage(error), { directory: resolved })
    }
  }
  const inspection = await inspect(resolved)
  if (inspection.ok) return failure('not-incomplete', 'the backup is complete and must not be deleted as a partial one')
  if (inspection.code !== 'incomplete') return failure(inspection.code, inspection.message || 'the backup cannot be removed safely')
  try {
    await remove(resolved, { recursive: true, force: true })
    return { ok: true, code: 'ok', removed: true, directory: resolved }
  } catch (error) {
    return failure(classifyError(error), errorMessage(error), { directory: resolved })
  }
}

function versionParts(value) {
  const text = String(value ?? '').trim()
  if (!/^\d+(\.\d+)*$/.test(text)) return null
  return text.split('.').map(Number)
}

function compareVersionParts(left, right) {
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] || 0) - (right[index] || 0)
    if (difference !== 0) return difference < 0 ? -1 : 1
  }
  return 0
}

function migrationSteps(fromVersion, toVersion) {
  const from = String(fromVersion)
  const to = String(toVersion)
  if (from === to) return []
  const fromParts = versionParts(from)
  const toParts = versionParts(to)
  if (!fromParts || !toParts) return [{ from, to }]
  if (compareVersionParts(fromParts, toParts) > 0) return null

  if (fromParts.length === 1 && toParts.length === 1 && toParts[0] - fromParts[0] <= 1000) {
    const steps = []
    for (let value = fromParts[0]; value < toParts[0]; value += 1) {
      steps.push({ from: String(value), to: String(value + 1) })
    }
    return steps
  }

  const fromPrefix = fromParts.slice(0, -1).join('.')
  const toPrefix = toParts.slice(0, -1).join('.')
  const lastFrom = fromParts[fromParts.length - 1]
  const lastTo = toParts[toParts.length - 1]
  if (fromPrefix === toPrefix && lastTo - lastFrom <= 1000) {
    const steps = []
    for (let value = lastFrom; value < lastTo; value += 1) {
      steps.push({
        from: [...fromParts.slice(0, -1), value].join('.'),
        to: [...fromParts.slice(0, -1), value + 1].join('.')
      })
    }
    return steps
  }
  return [{ from, to }]
}

function remapRestoredValue(value, roots, targetRoot) {
  if (!isAbsolutePath(value)) return value
  const resolved = path.resolve(value)
  for (const root of roots) {
    if (root && isWithin(root, resolved)) {
      const next = path.join(path.resolve(targetRoot), path.relative(path.resolve(root), resolved))
      // Item 07: a relative path may never climb out of the target it is being mapped into.
      return isWithin(path.resolve(targetRoot), path.resolve(next)) ? next : value
    }
  }
  return value
}

// Item 07: every path an editable capture actually reads. The old list rewrote only the
// render preview (filePath/thumbnailPath), so re-editing a restored capture still opened the
// document and the original base image under the OLD data root. docPath/baseImagePath are
// what the document service reads (capture-document-service.readDocument), so they have to
// move with the files.
const HISTORY_ENTRY_PATH_KEYS = Object.freeze([
  'filePath',
  'thumbnailPath',
  'docPath',
  'baseImagePath',
  'resultImagePath',
  'documentPath',
  'originalPath'
])

// Item 07: the managed history roots, in precedence order. Besides the module source and
// the managed/legacy layouts, this includes the history directory the user configured
// (an external screenshot library) - that is where their entries really point.
function historyRootsFor({ config, sourceRoot, historySource }) {
  const roots = []
  const configured = config?.settings?.screenshot?.historyDirectory
  const moduleSource = historySource ? path.resolve(historySource) : ''
  // The configured directory is a managed root only when it is the directory this package
  // actually copied. A pointer to a library that is NOT in the package (a disconnected
  // drive, a folder the user excluded) must stay an external reference, not be rewritten
  // to the restored history folder.
  if (isAbsolutePath(configured) && moduleSource) {
    const resolved = path.resolve(configured)
    if (resolved === moduleSource || isWithin(moduleSource, resolved) || isWithin(resolved, moduleSource)) {
      roots.push(resolved)
    }
  }
  if (moduleSource) roots.push(moduleSource)
  if (sourceRoot) {
    roots.push(path.join(path.resolve(sourceRoot), 'history'))
    roots.push(path.join(path.resolve(sourceRoot), 'capture-history'))
  }
  return [...new Set(roots)]
}

function remapRestoredConfig(config, { sourceRoot, historySource, targetRoot, historyTarget, warnings = [] }) {
  const rewritten = JSON.parse(JSON.stringify(config))
  const historyDirectory = path.resolve(historyTarget || path.join(targetRoot, 'history'))
  const historyRoots = historyRootsFor({ config: rewritten, sourceRoot, historySource })
  const screenshot = rewritten?.settings?.screenshot
  if (screenshot && Object.hasOwn(screenshot, 'historyDirectory')) {
    const value = remapRestoredValue(screenshot.historyDirectory, historyRoots, historyDirectory)
    // A configured library that was NOT part of this package stays an external pointer and
    // is reported; silently importing it would claim data the package does not contain.
    if (isAbsolutePath(value) && !isWithin(historyDirectory, path.resolve(value))) {
      warnings.push({ code: 'external-history-directory', path: String(value) })
    }
    screenshot.historyDirectory = value
  }
  if (Array.isArray(rewritten?.captureHistory)) {
    rewritten.captureHistory = rewritten.captureHistory.map((item) => {
      if (!isPlainObject(item)) return item
      const result = { ...item }
      for (const key of HISTORY_ENTRY_PATH_KEYS) {
        if (Object.hasOwn(result, key)) result[key] = remapRestoredValue(result[key], historyRoots, historyDirectory)
      }
      // A document revision may carry its own absolute reference to the base image.
      if (isPlainObject(result.document)) {
        result.document = JSON.parse(JSON.stringify(result.document))
        const base = result.document.baseImage
        if (isPlainObject(base) && Object.hasOwn(base, 'path')) {
          base.path = remapRestoredValue(base.path, historyRoots, historyDirectory)
        }
      }
      return result
    })
  }
  return rewritten
}

async function copyBackupModules({ inspection, backupDirectory, stage, modules, copy, hash, stat, mkdir }) {
  const selected = modules || inspection.moduleOrder
  for (const id of selected) {
    const entry = inspection.modules[id]
    if (!entry) throw codedError('invalid-request', `the backup does not contain module: ${id}`)
    const moduleRoot = path.join(backupDirectory, ...entry.path.split('/'))
    const stageRoot = path.join(stage, MODULE_DEFINITIONS[id].directory)
    await mkdir(stageRoot, { recursive: true })
    for (const file of entry.files) {
      const sourceFile = path.join(moduleRoot, ...file.path.split('/'))
      const targetFile = path.join(stageRoot, ...file.path.split('/'))
      await mkdir(path.dirname(targetFile), { recursive: true })
      await copy(sourceFile, targetFile)
      const copiedStat = await stat(targetFile)
      if (!copiedStat || copiedStat.size !== file.size) {
        throw codedError('copy-failed', `restored file size mismatch: ${id}/${file.path}`, { module: id, file: file.path })
      }
      const digest = await hash(targetFile)
      if (digest !== file.sha256) {
        throw codedError('checksum-mismatch', `restored file checksum mismatch: ${id}/${file.path}`, { module: id, file: file.path })
      }
    }
  }
  return selected
}

async function removeEmptyDirectory(directory, remove) {
  try {
    const entries = await fsp.readdir(directory)
    if (entries.length === 0) await remove(directory, { recursive: true, force: true })
  } catch {}
}

async function rollbackRestore({ stage, targetRoot, createdTarget, published, remove }) {
  const cleanupErrors = []
  for (const directory of [...published].reverse()) {
    try {
      await remove(directory, { recursive: true, force: true })
    } catch (error) {
      cleanupErrors.push(errorMessage(error))
    }
  }
  try {
    await remove(stage, { recursive: true, force: true })
  } catch (error) {
    cleanupErrors.push(errorMessage(error))
  }
  if (createdTarget) await removeEmptyDirectory(targetRoot, remove)
  return cleanupErrors
}

async function restoreBackup(options = {}) {
  const {
    backupDirectory,
    targetRoot,
    supportedVersion = null,
    modules = null,
    migrate = null,
    verify = null,
    copy = fsp.copyFile,
    hash = sha256File,
    stat = defaultStat,
    freeBytes = defaultFreeBytes,
    now = Date.now(),
    mkdir = fsp.mkdir,
    writeFile = fsp.writeFile,
    readFile = fsp.readFile,
    rename = fsp.rename,
    remove = fsp.rm,
    exists = async (value) => lstatOrNull(value).then(Boolean),
    supportedFormatVersion = BACKUP_FORMAT_VERSION,
    // Plan item 19: the APPLICATION version window is decided by the main process. A package
    // from before the window is refused with the range instead of a generic failure.
    minSupportedVersion = null,
    supportedVersionRange = ''
  } = options

  if (!isAbsolutePath(backupDirectory)) return failure('invalid-request', 'backupDirectory must be an absolute path')
  if (!isAbsolutePath(targetRoot)) return failure('invalid-request', 'targetRoot must be an absolute path')
  const backup = path.resolve(backupDirectory)
  const target = path.resolve(targetRoot)
  if (isWithin(backup, target) || isWithin(target, backup)) {
    return failure('invalid-target', 'the backup and the target directory cannot contain each other', { targetRoot: target, rolledBack: true })
  }

  const inspection = await inspectBackup(backup, { hash, supportedFormatVersion, exists })
  if (!inspection.ok) return { ...inspection, targetRoot: target, rolledBack: true }
  if (minSupportedVersion && String(minSupportedVersion) !== '') {
    const fromParts = inspection.version.split('.').map(Number)
    const minParts = String(minSupportedVersion).split('.').map(Number)
    const comparable = fromParts.every((value) => Number.isSafeInteger(value)) && minParts.every((value) => Number.isSafeInteger(value))
    if (comparable && compareVersionParts(fromParts, minParts) < 0) {
      return failure('unsupported-version', 'the backup was created by an older Highlighter release than this build supports', {
        targetRoot: target,
        rolledBack: true,
        version: inspection.version,
        minSupportedVersion: String(minSupportedVersion),
        supportedVersionRange: String(supportedVersionRange || ''),
        // The user's old root is untouched; the source package is kept for retrieval.
        originalKept: true
      })
    }
  }

  const selected = [...new Set(modules || inspection.moduleOrder)]
  const missingModules = selected.filter((id) => !Object.hasOwn(inspection.modules, id))
  if (missingModules.length) {
    return failure('invalid-request', `the backup does not contain module: ${missingModules.join(', ')}`, { targetRoot: target, rolledBack: true })
  }
  const selectedBytes = selected.reduce((sum, id) => sum + (inspection.modules[id]?.bytes || 0), 0)

  let targetStat = await lstatOrNull(target)
  let createdTarget = false
  if (targetStat) {
    if (!targetStat.isDirectory()) return failure('invalid-target', 'the target must be a directory', { targetRoot: target, rolledBack: true })
    const entries = await fsp.readdir(target).catch(() => null)
    if (entries && entries.length > 0) return failure('target-not-empty', 'the target directory must be empty', { targetRoot: target, rolledBack: true })
  } else {
    try {
      await mkdir(target, { recursive: true })
      createdTarget = true
      targetStat = true
    } catch (error) {
      return failure(classifyError(error), errorMessage(error), { targetRoot: target, rolledBack: true })
    }
  }

  let availableBytes = null
  try {
    availableBytes = await freeBytes(target)
  } catch {
    availableBytes = null
  }
  if (Number.isFinite(availableBytes) && availableBytes < selectedBytes) {
    await removeEmptyDirectory(target, remove)
    return failure('insufficient-space', 'not enough free space to restore the selected modules', {
      requiredBytes: selectedBytes,
      freeBytes: availableBytes,
      targetRoot: target,
      rolledBack: true
    })
  }

  const stage = path.join(target, `.highlighter-restore-${crypto.randomUUID()}`)
  const published = []
  let verification = null
  const warnings = [...inspection.warnings]
  try {
    await mkdir(stage, { recursive: true })
    let historyIndexRestored = null
    const restoredModules = await copyBackupModules({
      inspection,
      backupDirectory: backup,
      stage,
      modules: selected,
      copy,
      hash,
      stat,
      mkdir
    })

    // Item 06: the runtime index is published through config/config.json. The history
    // module carries its own index file; an old (format 1) package kept the same list in
    // its settings module. Either way there is exactly ONE publish: the config written here
    // is what the app reads after the relaunch.
    const settingsPath = path.join(stage, 'config', 'config.json')
    const historyIndexPath = path.join(stage, 'history', HISTORY_INDEX_FILE)
    const historySelected = restoredModules.includes('history')
    const settingsSelected = restoredModules.includes('settings')
    let historyIndex = null
    if (historySelected && await exists(historyIndexPath)) {
      try {
        const parsed = JSON.parse(await readFile(historyIndexPath, 'utf8'))
        if (Array.isArray(parsed?.captureHistory)) historyIndex = { entries: parsed.captureHistory, source: 'history-index' }
      } catch {}
    }
    let configSource = null
    if (settingsSelected && await exists(settingsPath)) {
      try {
        configSource = JSON.parse(await readFile(settingsPath, 'utf8'))
      } catch {
        configSource = null
      }
    }
    if (!historyIndex && Array.isArray(configSource?.captureHistory)) {
      // A format 1 package: the settings module carried the history list. That copy is the
      // trusted index of the SAME package, so it is used instead of guessing.
      historyIndex = { entries: configSource.captureHistory, source: 'settings-capture-history' }
    }
    if (historySelected && !historyIndex) {
      // The files are still restorable; the metadata is not. Say so instead of inventing an
      // empty history, and keep the source package for retrieval.
      warnings.push({ code: 'history-index-missing' })
    }
    const needsConfig = settingsSelected || (historySelected && historyIndex)
    if (needsConfig) {
      const baseConfig = isPlainObject(configSource) ? configSource : {}
      if (Array.isArray(baseConfig.captureHistory)) delete baseConfig.captureHistory
      if (historySelected && historyIndex) baseConfig.captureHistory = historyIndex.entries
      const rewritten = remapRestoredConfig(baseConfig, {
        sourceRoot: inspection.source?.dataRoot || '',
        historySource: inspection.modules.history?.sourcePath || '',
        targetRoot: target,
        historyTarget: path.join(target, 'history'),
        warnings
      })
      await mkdir(path.dirname(settingsPath), { recursive: true })
      await writeFile(settingsPath, `${JSON.stringify(rewritten, null, 2)}\n`, 'utf8')
      if (!settingsSelected && !restoredModules.includes('config')) {
        // "history only": the generated config is the published index carrier.
        restoredModules.push('config')
      }
    }
    if (await exists(historyIndexPath)) {
      // The index has been folded into the config; the history directory keeps captures
      // only, exactly like a live data root.
      await remove(historyIndexPath, { force: true })
    }
    historyIndexRestored = historySelected ? Boolean(historyIndex) : null

    const targetVersion = supportedVersion === null || supportedVersion === undefined
      ? inspection.version
      : String(supportedVersion)
    const steps = migrationSteps(inspection.version, targetVersion)
    if (steps === null) {
      throw codedError('unsupported-version', `cannot migrate data version ${inspection.version} down to ${targetVersion}`)
    }
    for (const step of steps) {
      if (typeof migrate !== 'function') {
        throw codedError('migration-required', `a migration from ${step.from} to ${step.to} is required`, step)
      }
      let migrationResult
      try {
        migrationResult = await migrate({ ...step, directory: stage, modules: inspection.modules })
      } catch (error) {
        throw codedError('migration-failed', errorMessage(error), step)
      }
      if (migrationResult && migrationResult.ok === false) {
        throw codedError('migration-failed', migrationResult.message || 'the migration step failed', step)
      }
      if (typeof verify === 'function') {
        let verified
        try {
          verified = await verify({
            directory: stage,
            phase: 'migrated',
            fromVersion: step.from,
            version: step.to,
            modules: inspection.modules
          })
        } catch (error) {
          throw codedError('verification-failed', errorMessage(error), step)
        }
        if (verified === false || (verified && verified.ok === false)) {
          throw codedError('verification-failed', verified?.message || 'the restored data failed verification', step)
        }
        verification = verified
      }
    }
    if (steps.length === 0 && typeof verify === 'function') {
      try {
        verification = await verify({
          directory: stage,
          phase: 'copied',
          fromVersion: inspection.version,
          version: inspection.version,
          modules: inspection.modules
        })
      } catch (error) {
        throw codedError('verification-failed', errorMessage(error))
      }
      if (verification === false || (verification && verification.ok === false)) {
        throw codedError('verification-failed', verification?.message || 'the restored data failed verification')
      }
    }

    for (const id of restoredModules) {
      // 'config' is the synthetic module name used when only the history was restored:
      // its directory is the settings module's directory (config/).
      const definition = MODULE_DEFINITIONS[id] || MODULE_DEFINITIONS.settings
      const sourceDirectory = path.join(stage, definition.directory)
      const targetDirectory = path.join(target, definition.directory)
      if (await exists(targetDirectory)) throw codedError('target-not-empty', `the target already contains ${id}`)
      await mkdir(path.dirname(targetDirectory), { recursive: true })
      await rename(sourceDirectory, targetDirectory)
      published.push(targetDirectory)
    }
    try {
      await remove(stage, { recursive: true, force: true })
    } catch {
      warnings.push({ code: 'stage-cleanup-failed' })
    }

    for (const ref of inspection.externalRefs.slice(0, 20)) {
      if (!await exists(ref.path).catch(() => false)) {
        if (!warnings.some((entry) => entry.code === 'external-ref-unavailable' && entry.path === ref.path)) {
          warnings.push({ code: 'external-ref-unavailable', module: ref.module, path: ref.path })
        }
      }
    }

    return {
      ok: true,
      code: 'ok',
      dataRoot: target,
      locator: { version: 1, dataRoot: target },
      version: targetVersion,
      sourceVersion: inspection.version,
      backupDirectory: backup,
      migrated: steps,
      // The synthetic 'config' publish carrier is not a backup module, so it never shows up
      // as one in the receipt.
      modules: Object.fromEntries(restoredModules.filter((id) => MODULE_DEFINITIONS[id]).map((id) => [id, inspection.modules[id]])),
      totalBytes: selectedBytes,
      externalRefs: inspection.externalRefs,
      externalRefCount: inspection.externalRefCount,
      sensitive: inspection.sensitive,
      sensitiveModules: inspection.sensitiveModules,
      containsSensitive: inspection.containsSensitive,
      checksum: inspection.checksum,
      verification,
      warnings,
      // Item 06: whether the restored data root has a runtime history list. Files restored
      // without a trusted index keep the material but not the metadata.
      historyIndexRestored,
      restoredAt: new Date(now).toISOString()
    }
  } catch (error) {
    const cleanupErrors = await rollbackRestore({ stage, targetRoot: target, createdTarget, published, remove })
    return failure(error.code && typeof error.code === 'string' && !/^E[A-Z]+$/.test(error.code) ? error.code : classifyError(error), errorMessage(error), {
      backupDirectory: backup,
      targetRoot: target,
      rolledBack: cleanupErrors.length === 0,
      cleanupErrors
    })
  }
}

module.exports = {
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  BACKUP_DIRECTORY_PREFIX,
  DEFAULT_MODULES,
  MANIFEST_FILE,
  MARKER_FILE,
  MODULE_DEFINITIONS,
  MODULE_ORDER,
  HISTORY_INDEX_FILE,
  HISTORY_INDEX_SCHEMA_VERSION,
  MIN_SUPPORTED_FORMAT_VERSION,
  buildHistoryIndex,
  createBackup,
  historyRootsFor,
  validateBackupRequest,
  deleteBackup,
  inspectBackup,
  restoreBackup
}
