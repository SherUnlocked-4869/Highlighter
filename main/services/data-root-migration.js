const crypto = require('node:crypto')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const {
  LOCATOR_NAME,
  PENDING_NAME,
  atomicWriteJson,
  createDataPaths,
  ensureDataLayout,
  isNestedPath,
  readLocator,
  validateDataRoot,
  writeLocator
} = require('./data-root')
const {
  cleanupManagedSource,
  cleanupStateError,
  failureMessage,
  quarantinePathFor,
  readSourceIdentity,
  runQuarantineCleanup,
  validateCleanupTopology
} = require('./data-root-migration-cleanup')

const MANAGED_DIRECTORIES = ['config', 'logs', 'history', 'cache', 'runtime']
const MIGRATION_MARKER = '.migration.json'
const MARKER_VERSION = 1

function createLegacySourcePaths(value) {
  const root = path.resolve(value)
  const configFile = path.join(root, 'config.json')
  const logFile = path.join(root, 'app.log')
  const history = path.join(root, 'capture-history')
  return {
    root,
    configFile,
    logFile,
    history,
    cleanupFiles: [configFile, logFile],
    cleanupDirectories: [history, path.join(root, 'temp', 'recordings')]
  }
}

function createManagedSourcePaths(value) {
  const paths = createDataPaths(value)
  return {
    root: paths.root,
    configFile: path.join(paths.config, 'config.json'),
    logFile: path.join(paths.logs, 'app.log'),
    history: paths.history,
    cleanupFiles: [],
    cleanupDirectories: MANAGED_DIRECTORIES.map((name) => paths[name])
  }
}

function remapInside(value, sourceDirectory, targetDirectory) {
  if (typeof value !== 'string' || !value.trim()) return value
  const source = path.resolve(sourceDirectory)
  const candidate = path.isAbsolute(value) ? path.resolve(value) : path.resolve(source, value)
  if (!isNestedPath(source, candidate)) return value
  return path.join(path.resolve(targetDirectory), path.relative(source, candidate))
}

function rewriteConfig(config, source, target) {
  const rewritten = JSON.parse(JSON.stringify(config))
  const screenshot = rewritten?.settings?.screenshot
  if (screenshot && Object.hasOwn(screenshot, 'historyDirectory')) {
    screenshot.historyDirectory = remapInside(screenshot.historyDirectory, source.history, target.history)
  }
  if (Array.isArray(rewritten?.captureHistory)) {
    rewritten.captureHistory = rewritten.captureHistory.map((item) => {
      if (!item || typeof item !== 'object') return item
      const result = { ...item }
      for (const name of ['filePath', 'thumbnailPath']) {
        if (Object.hasOwn(result, name)) result[name] = remapInside(result[name], source.history, target.history)
      }
      return result
    })
  }
  return rewritten
}

async function pathExists(filePath) {
  return fsp.lstat(filePath).then(() => true, (error) => {
    if (error.code === 'ENOENT') return false
    throw error
  })
}

function linkError(filePath) {
  return new Error(`数据目录不能包含符号链接或目录联接：${filePath}`)
}

async function regularFileIfPresent(filePath) {
  const stat = await fsp.lstat(filePath).catch((error) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (stat?.isSymbolicLink()) throw linkError(filePath)
  if (stat && !stat.isFile()) throw new Error(`迁移源不是普通文件：${filePath}`)
  return stat
}

async function listFiles(directory) {
  const rootStat = await fsp.lstat(directory).catch((error) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!rootStat) return []
  if (rootStat.isSymbolicLink()) throw linkError(directory)
  if (!rootStat.isDirectory()) throw new Error(`迁移源不是目录：${directory}`)

  const files = []
  async function walk(current, relativeDirectory) {
    const entries = await fsp.readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const sourcePath = path.join(current, entry.name)
      const relativePath = path.join(relativeDirectory, entry.name)
      const stat = await fsp.lstat(sourcePath)
      if (stat.isSymbolicLink()) throw linkError(sourcePath)
      if (stat.isDirectory()) await walk(sourcePath, relativePath)
      else if (stat.isFile()) files.push(relativePath)
      else throw new Error(`迁移源包含不支持的文件类型：${sourcePath}`)
    }
  }
  await walk(directory, '')
  return files
}

async function invokeCopyFile(copyFile, source, target) {
  await fsp.mkdir(path.dirname(target), { recursive: true })
  if (copyFile.length >= 3) {
    await new Promise((resolve, reject) => copyFile(source, target, (error) => error ? reject(error) : resolve()))
    return
  }
  await copyFile(source, target)
}

async function assertTargetAvailable(target) {
  const conflicts = await Promise.all(MANAGED_DIRECTORIES.map((name) => pathExists(target[name])))
  if (conflicts.some(Boolean)) throw new Error('目标目录已包含 Highlighter 数据')
}

function validateMarkerSchema(marker, newRoot, migrationId = marker?.migrationId) {
  const root = path.resolve(newRoot)
  if (!marker || marker.version !== MARKER_VERSION || marker.migrationId !== migrationId || marker.newRoot !== root) {
    throw new Error('迁移标记无效')
  }
  if (![0, 1].includes(marker.copiedConfigCount) || ![0, 1].includes(marker.copiedLogCount) || !Number.isInteger(marker.copiedHistoryCount)) {
    throw new Error('迁移标记无效')
  }
  validatePendingSource(marker.source, root)
  if (marker.sourceIdentity !== null && (
    marker.sourceIdentity?.type !== 'directory' ||
    typeof marker.sourceIdentity.dev !== 'string' ||
    typeof marker.sourceIdentity.ino !== 'string' ||
    typeof marker.sourceIdentity.birthtimeMs !== 'number'
  )) throw new Error('迁移标记无效')
  return marker
}

async function operationExists(filePath, operations) {
  return operations.lstat(filePath).then(() => true, (error) => {
    if (error.code === 'ENOENT') return false
    throw error
  })
}

async function archiveOwnedTarget(newRoot, migrationId, { operations = fsp } = {}) {
  const root = path.resolve(newRoot)
  const archiveRoot = path.join(root, `.highlighter-failed-${migrationId}`)
  const markerPath = path.join(root, MIGRATION_MARKER)
  const archivedMarkerPath = path.join(archiveRoot, MIGRATION_MARKER)
  const [hasMarker, hasArchivedMarker] = await Promise.all([
    operationExists(markerPath, operations),
    operationExists(archivedMarkerPath, operations)
  ])
  if (hasMarker && hasArchivedMarker) throw new Error('迁移诊断归档状态冲突')
  if (!hasMarker && !hasArchivedMarker) {
    const managed = createDataPaths(root)
    const hasManagedData = (await Promise.all(MANAGED_DIRECTORIES.map((name) => operationExists(managed[name], operations)))).some(Boolean)
    if (hasManagedData) throw new Error('目标目录缺少有效迁移标记')
    return null
  }

  const markerSource = hasMarker ? markerPath : archivedMarkerPath
  const marker = validateMarkerSchema(JSON.parse(await operations.readFile(markerSource, 'utf8')), root, migrationId)
  await operations.mkdir(archiveRoot, { recursive: true })
  const managed = createDataPaths(root)
  for (const name of MANAGED_DIRECTORIES) {
    const sourcePath = managed[name]
    const targetPath = path.join(archiveRoot, name)
    const [sourceExists, targetExists] = await Promise.all([
      operationExists(sourcePath, operations),
      operationExists(targetPath, operations)
    ])
    if (sourceExists && targetExists) throw new Error(`迁移诊断归档冲突：${name}`)
    if (sourceExists) await operations.rename(sourcePath, targetPath)
  }
  if (hasMarker) await operations.rename(markerPath, archivedMarkerPath)
  return { archiveRoot, marker }
}

async function archiveOrphanTarget(root) {
  const markerPath = path.join(root, MIGRATION_MARKER)
  if (!await pathExists(markerPath)) return false
  let marker
  try {
    marker = JSON.parse(await fsp.readFile(markerPath, 'utf8'))
    validateMarkerSchema(marker, root)
  } catch {
    throw new Error('目标目录已包含 Highlighter 数据')
  }
  await archiveOwnedTarget(root, marker.migrationId)
  return true
}

async function removeCreatedTarget(target) {
  const results = await Promise.allSettled(MANAGED_DIRECTORIES.map((name) => fsp.rm(target[name], { recursive: true, force: true })))
  return results.filter((result) => result.status === 'rejected').map((result) => failureMessage(result.reason))
}

async function cleanupPublishedTarget(target, root, migrationId) {
  const errors = await removeCreatedTarget(target)
  if (errors.length) return errors
  try {
    await removeMarkerForMigration(root, migrationId)
    return []
  } catch (error) {
    return [failureMessage(error)]
  }
}

function migrationCleanupError(migrationError, cleanupErrors) {
  const result = new Error(`${migrationError.message}；迁移回滚清理失败：${cleanupErrors.join('; ')}`)
  result.cause = migrationError
  result.migrationError = migrationError
  result.cleanupErrors = cleanupErrors
  return result
}

async function removePendingForMigration(pendingPath, migrationId) {
  try {
    const pending = JSON.parse(await fsp.readFile(pendingPath, 'utf8'))
    if (pending.migrationId === migrationId) await fsp.rm(pendingPath, { force: true })
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
  }
}

async function removeMarkerForMigration(root, migrationId) {
  const markerPath = path.join(root, MIGRATION_MARKER)
  try {
    const marker = JSON.parse(await fsp.readFile(markerPath, 'utf8'))
    if (marker.migrationId === migrationId) await fsp.rm(markerPath, { force: true })
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
  }
}

function sourceManifestsEqual(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected)
}

function migrationRollbackError(error, migrationError) {
  const result = new Error(`数据目录迁移回滚失败：${failureMessage(error)}`)
  result.cause = error
  result.migrationError = migrationError
  return result
}

async function restorePublishedLocator({ locatorPath, targetRoot, previousRoot, restoreLocatorFile, migrationError }) {
  let locator
  try {
    locator = await readLocator(locatorPath)
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw migrationRollbackError(error, migrationError)
  }
  if (locator.dataRoot !== path.resolve(targetRoot)) return

  try {
    if (previousRoot) await restoreLocatorFile(locatorPath, previousRoot)
    else await fsp.rm(locatorPath, { force: true })
  } catch (error) {
    throw migrationRollbackError(error, migrationError)
  }
}

async function migrateDataRoot({
  source,
  target,
  portableDirectory,
  previousRoot = '',
  copyFile = fs.copyFile,
  writePending = atomicWriteJson,
  writeLocatorFile = writeLocator,
  restoreLocatorFile = writeLocator,
  cleanupFailedTarget = cleanupPublishedTarget,
  renameTarget = fsp.rename
}) {
  await validateDataRoot(target.root, source.root)
  const targetLayout = createDataPaths(target.root)
  const targetSource = createManagedSourcePaths(target.root)
  const sourceManifest = validatePendingSource(source, target.root)
  const sourceIdentity = await readSourceIdentity(sourceManifest.root)
  await archiveOrphanTarget(target.root)
  await assertTargetAvailable(targetLayout)

  const migrationId = crypto.randomUUID()
  const stagingRoot = path.join(target.root, `.highlighter-migration-${migrationId}`)
  const staging = createManagedSourcePaths(stagingRoot)
  const locatorPath = path.join(portableDirectory, LOCATOR_NAME)
  const pendingPath = path.join(portableDirectory, PENDING_NAME)
  let locatorWriteStarted = false
  let markerPublished = false

  try {
    await ensureDataLayout(createDataPaths(staging.root))

    let copiedLogCount = 0
    if (await regularFileIfPresent(source.logFile)) {
      await invokeCopyFile(copyFile, source.logFile, staging.logFile)
      copiedLogCount = 1
    }

    const historyFiles = await listFiles(source.history)
    for (const relativePath of historyFiles) {
      await invokeCopyFile(copyFile, path.join(source.history, relativePath), path.join(staging.history, relativePath))
    }
    const copiedHistoryFiles = await listFiles(staging.history)
    if (copiedHistoryFiles.length !== historyFiles.length) throw new Error('截图历史迁移文件计数不一致')

    let copiedConfigCount = 0
    if (await regularFileIfPresent(source.configFile)) {
      const config = JSON.parse(await fsp.readFile(source.configFile, 'utf8'))
      await atomicWriteJson(staging.configFile, rewriteConfig(config, source, targetSource))
      JSON.parse(await fsp.readFile(staging.configFile, 'utf8'))
      copiedConfigCount = 1
    }

    const marker = {
      version: MARKER_VERSION,
      migrationId,
      newRoot: path.resolve(target.root),
      source: sourceManifest,
      sourceIdentity,
      copiedConfigCount,
      copiedLogCount,
      copiedHistoryCount: historyFiles.length
    }
    const stagingMarker = path.join(staging.root, MIGRATION_MARKER)
    await atomicWriteJson(stagingMarker, marker)

    const stagingLayout = createDataPaths(staging.root)
    await renameTarget(stagingMarker, path.join(target.root, MIGRATION_MARKER))
    markerPublished = true
    for (const name of ['config', 'logs', 'history']) await renameTarget(stagingLayout[name], targetLayout[name])
    await ensureDataLayout(targetLayout)
    await fsp.rm(stagingRoot, { recursive: true, force: true })

    const pending = {
      version: 1,
      migrationId,
      previousRoot: previousRoot ? path.resolve(previousRoot) : '',
      newRoot: path.resolve(target.root),
      source: sourceManifest
    }
    await writePending(pendingPath, pending)
    locatorWriteStarted = true
    await writeLocatorFile(locatorPath, target.root)
    return { locatorPath, pendingPath, migrationId }
  } catch (error) {
    const cleanupErrors = []
    await fsp.rm(stagingRoot, { recursive: true, force: true }).catch((cleanupError) => cleanupErrors.push(failureMessage(cleanupError)))
    if (locatorWriteStarted) {
      await restorePublishedLocator({
        locatorPath,
        targetRoot: target.root,
        previousRoot: previousRoot ? path.resolve(previousRoot) : '',
        restoreLocatorFile,
        migrationError: error
      })
    }
    await removePendingForMigration(pendingPath, migrationId).catch((cleanupError) => cleanupErrors.push(failureMessage(cleanupError)))
    if (markerPublished) {
      cleanupErrors.push(...await cleanupFailedTarget(targetLayout, target.root, migrationId))
    } else {
      cleanupErrors.push(...await removeCreatedTarget(targetLayout))
    }
    if (cleanupErrors.length) throw migrationCleanupError(error, cleanupErrors)
    throw error
  }
}

function verificationError(error) {
  const result = new Error('数据目录迁移验证失败')
  result.cause = error
  return result
}

function normalizedPath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('source path is not absolute')
  return path.resolve(value)
}

function comparablePath(value) {
  const resolved = normalizedPath(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function normalizedPathList(value) {
  if (!Array.isArray(value)) throw new Error('source cleanup list is invalid')
  return value.map(normalizedPath).sort((left, right) => comparablePath(left).localeCompare(comparablePath(right)))
}

function samePathList(actual, expected) {
  if (actual.length !== expected.length) return false
  return actual.every((value, index) => comparablePath(value) === comparablePath(expected[index]))
}

function validatePendingSource(source, activeRoot) {
  if (!source || typeof source !== 'object') throw new Error('migration source is invalid')
  const root = normalizedPath(source.root)
  if (isNestedPath(root, activeRoot) || isNestedPath(activeRoot, root)) throw new Error('source and active root overlap')

  const cleanupFiles = normalizedPathList(source.cleanupFiles)
  const cleanupDirectories = normalizedPathList(source.cleanupDirectories)
  for (const target of [...cleanupFiles, ...cleanupDirectories]) {
    if (comparablePath(target) === comparablePath(root) || !isNestedPath(root, target)) {
      throw new Error('cleanup path is outside source root')
    }
  }

  const normalizedFields = {
    configFile: normalizedPath(source.configFile),
    logFile: normalizedPath(source.logFile),
    history: normalizedPath(source.history)
  }
  const candidates = [createLegacySourcePaths(root), createManagedSourcePaths(root)]
  const match = candidates.find((candidate) => {
    const expectedFiles = normalizedPathList(candidate.cleanupFiles)
    const expectedDirectories = normalizedPathList(candidate.cleanupDirectories)
    return comparablePath(normalizedFields.configFile) === comparablePath(candidate.configFile) &&
      comparablePath(normalizedFields.logFile) === comparablePath(candidate.logFile) &&
      comparablePath(normalizedFields.history) === comparablePath(candidate.history) &&
      samePathList(cleanupFiles, expectedFiles) &&
      samePathList(cleanupDirectories, expectedDirectories)
  })
  if (!match) throw new Error('migration source layout is invalid')
  return match
}

async function removeFinalizationArtifacts({ pendingPath, markerPath, removeFile }) {
  try {
    await removeFile(markerPath, { force: true })
  } catch (error) {
    return [failureMessage(error)]
  }
  try {
    await removeFile(pendingPath, { force: true })
    return []
  } catch (error) {
    return [failureMessage(error)]
  }
}

async function verifyAndFinalizeMigration({
  pendingPath,
  activeRoot,
  cleanup = cleanupManagedSource,
  removeFile = fsp.rm,
  writePending = atomicWriteJson
}) {
  let pending
  try {
    pending = JSON.parse(await fsp.readFile(pendingPath, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return { finalized: false, cleanupErrors: [] }
    throw verificationError(error)
  }

  const root = path.resolve(activeRoot)
  const markerPath = path.join(root, MIGRATION_MARKER)
  try {
    pending = { ...pending, source: validatePendingSource(pending.source, root) }
  } catch (error) {
    if (pending.phase === 'quarantine-planned') return cleanupStateError(`数据目录迁移验证失败：${failureMessage(error)}`)
    throw verificationError(error)
  }
  if (pending.phase === 'cleaned') {
    try {
      if (typeof pending.newRoot !== 'string' || path.resolve(pending.newRoot) !== root) throw new Error('active root mismatch')
      const marker = await fsp.readFile(markerPath, 'utf8').then(JSON.parse).catch((error) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      if (marker && marker.migrationId !== pending.migrationId) throw new Error('marker mismatch')
    } catch (error) {
      throw verificationError(error)
    }
    const artifactErrors = await removeFinalizationArtifacts({ pendingPath, markerPath, removeFile })
    return { finalized: artifactErrors.length === 0, cleanupErrors: artifactErrors }
  }

  let marker
  try {
    marker = JSON.parse(await fsp.readFile(markerPath, 'utf8'))
    if (marker.version !== MARKER_VERSION || marker.newRoot !== root || path.resolve(pending.newRoot) !== root || marker.migrationId !== pending.migrationId) {
      throw new Error('marker mismatch')
    }
    const markerSource = validatePendingSource(marker.source, root)
    if (!sourceManifestsEqual(markerSource, pending.source)) throw new Error('source manifest mismatch')
    if (![0, 1].includes(marker.copiedConfigCount) || ![0, 1].includes(marker.copiedLogCount)) throw new Error('marker count mismatch')
    if (marker.sourceIdentity !== null && (
      marker.sourceIdentity?.type !== 'directory' ||
      typeof marker.sourceIdentity.dev !== 'string' ||
      typeof marker.sourceIdentity.ino !== 'string' ||
      typeof marker.sourceIdentity.birthtimeMs !== 'number'
    )) throw new Error('source identity mismatch')

    const active = createManagedSourcePaths(root)
    const configStat = await regularFileIfPresent(active.configFile)
    if (marker.copiedConfigCount === 1 && !configStat) throw new Error('target config missing')
    if (configStat) JSON.parse(await fsp.readFile(active.configFile, 'utf8'))
    const logStat = await regularFileIfPresent(active.logFile)
    if (marker.copiedLogCount === 1 && !logStat) throw new Error('target log missing')
    if ((await listFiles(active.history)).length !== marker.copiedHistoryCount) throw new Error('history count mismatch')
  } catch (error) {
    if (pending.phase === 'quarantine-planned') return cleanupStateError(`数据目录迁移验证失败：${failureMessage(error)}`)
    throw verificationError(error)
  }

  if (!pending.phase && marker.sourceIdentity !== null) {
    try {
      await validateCleanupTopology(pending.source, root)
    } catch (error) {
      throw verificationError(error)
    }
  }

  if (pending.phase === 'quarantine-planned') {
    const expectedQuarantine = quarantinePathFor(pending.source.root, pending.migrationId)
    if (typeof pending.quarantineRoot !== 'string' || !path.isAbsolute(pending.quarantineRoot) ||
      comparablePath(pending.quarantineRoot) !== comparablePath(expectedQuarantine) ||
      isNestedPath(root, expectedQuarantine) || isNestedPath(expectedQuarantine, root)) {
      return cleanupStateError('数据目录迁移验证失败：隔离目录计划无效')
    }
    const result = await runQuarantineCleanup({ pendingPath, pending, marker, cleanup, writePending })
    if (!result.finalized) return result
    const artifactErrors = await removeFinalizationArtifacts({ pendingPath, markerPath, removeFile })
    return { finalized: artifactErrors.length === 0, cleanupErrors: artifactErrors }
  }

  if (marker.sourceIdentity === null) {
    pending = { ...pending, phase: 'cleaned' }
    await writePending(pendingPath, pending)
  } else {
    const quarantineRoot = quarantinePathFor(pending.source.root, pending.migrationId)
    if (isNestedPath(root, quarantineRoot) || isNestedPath(quarantineRoot, root)) throw verificationError(new Error('quarantine overlaps active root'))
    if (await pathExists(quarantineRoot)) throw verificationError(new Error('quarantine already exists'))
    pending = { ...pending, phase: 'quarantine-planned', quarantineRoot }
    try {
      await writePending(pendingPath, pending)
    } catch (error) {
      const persisted = await fsp.readFile(pendingPath, 'utf8').then(JSON.parse).catch(() => null)
      if (persisted?.phase === 'quarantine-planned' && persisted.migrationId === pending.migrationId) {
        return cleanupStateError(failureMessage(error))
      }
      throw error
    }
    const result = await runQuarantineCleanup({ pendingPath, pending, marker, cleanup, writePending })
    if (!result.finalized) return result
    pending = result.pending
  }

  const artifactErrors = await removeFinalizationArtifacts({ pendingPath, markerPath, removeFile })
  return { finalized: artifactErrors.length === 0, cleanupErrors: artifactErrors }
}

async function hasOwnedTargetMarker(newRoot, migrationId) {
  const root = path.resolve(newRoot)
  const markerPaths = [
    path.join(root, MIGRATION_MARKER),
    path.join(root, `.highlighter-failed-${migrationId}`, MIGRATION_MARKER)
  ]
  for (const markerPath of markerPaths) {
    const marker = await fsp.readFile(markerPath, 'utf8').then(JSON.parse).catch(() => null)
    try {
      if (marker) {
        validateMarkerSchema(marker, root, migrationId)
        return true
      }
    } catch {}
  }
  return false
}

async function rollbackPendingMigration({ pendingPath, locatorPath, archive = archiveOwnedTarget }) {
  const pending = JSON.parse(await fsp.readFile(pendingPath, 'utf8'))
  if (pending.phase === 'quarantine-planned' || pending.phase === 'cleaned') {
    throw new Error('已验证的数据目录迁移不能回滚')
  }
  const previousRoot = pending.previousRoot || ''
  if (await hasOwnedTargetMarker(pending.newRoot, pending.migrationId)) {
    await archive(pending.newRoot, pending.migrationId)
  }
  if (previousRoot) await writeLocator(locatorPath, previousRoot)
  else await fsp.rm(locatorPath, { force: true })
  await fsp.rm(pendingPath, { force: true })
  return previousRoot
}

module.exports = {
  archiveOwnedTarget,
  cleanupManagedSource,
  createLegacySourcePaths,
  createManagedSourcePaths,
  migrateDataRoot,
  rewriteConfig,
  rollbackPendingMigration,
  verifyAndFinalizeMigration
}
