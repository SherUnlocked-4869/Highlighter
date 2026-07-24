const fsp = require('node:fs/promises')
const path = require('node:path')
const { isNestedPath } = require('./data-root')

function failureMessage(reason) {
  return reason instanceof Error ? reason.message : String(reason)
}

function linkError(filePath) {
  return new Error(`数据目录不能包含符号链接或目录联接：${filePath}`)
}

async function readSourceIdentity(root) {
  const stat = await fsp.lstat(root).catch((error) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!stat) return null
  if (stat.isSymbolicLink()) throw linkError(root)
  if (!stat.isDirectory()) throw new Error(`迁移源不是目录：${root}`)
  return {
    type: 'directory',
    dev: String(stat.dev),
    ino: String(stat.ino),
    birthtimeMs: stat.birthtimeMs
  }
}

function identitiesEqual(actual, expected) {
  if (!actual || !expected || actual.type !== 'directory' || expected.type !== 'directory') return false
  if (actual.dev !== expected.dev) return false
  if (actual.ino !== '0' && expected.ino !== '0') return actual.ino === expected.ino
  return actual.birthtimeMs === expected.birthtimeMs
}

async function cleanupManagedSource(source, operations = fsp) {
  const targets = [
    ...(Array.isArray(source?.cleanupFiles) ? source.cleanupFiles : []),
    ...(Array.isArray(source?.cleanupDirectories) ? source.cleanupDirectories : [])
  ]
  const results = await Promise.allSettled(targets.map((target) => operations.rm(target, { recursive: true, force: true })))
  return results.filter((result) => result.status === 'rejected').map((result) => failureMessage(result.reason))
}

async function rejectExistingLinks(filePath) {
  const resolved = path.resolve(filePath)
  const parsed = path.parse(resolved)
  let current = parsed.root
  const segments = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)

  for (const segment of segments) {
    current = path.join(current, segment)
    const stat = await fsp.lstat(current).catch((error) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (!stat) break
    if (stat.isSymbolicLink()) throw linkError(current)
  }
}

async function canonicalPathWithoutCreating(directory) {
  const resolved = path.resolve(directory)
  return fsp.realpath(resolved).catch((error) => {
    if (error.code === 'ENOENT') return resolved
    throw error
  })
}

async function validateCleanupTopology(source, activeRoot) {
  const cleanupTargets = [source.root, ...source.cleanupFiles, ...source.cleanupDirectories]
  await Promise.all(cleanupTargets.map(rejectExistingLinks))
  const [canonicalSource, canonicalActive] = await Promise.all([
    canonicalPathWithoutCreating(source.root),
    canonicalPathWithoutCreating(activeRoot)
  ])
  if (isNestedPath(canonicalSource, canonicalActive) || isNestedPath(canonicalActive, canonicalSource)) {
    throw new Error('source and active root overlap')
  }
}

function quarantinePathFor(sourceRoot, migrationId) {
  return path.join(path.dirname(sourceRoot), `.highlighter-cleanup-${migrationId}`)
}

function mapSourceToQuarantine(source, quarantineRoot) {
  const mapPath = (target) => path.join(quarantineRoot, path.relative(source.root, target))
  return {
    root: quarantineRoot,
    configFile: mapPath(source.configFile),
    logFile: mapPath(source.logFile),
    history: mapPath(source.history),
    cleanupFiles: source.cleanupFiles.map(mapPath),
    cleanupDirectories: source.cleanupDirectories.map(mapPath)
  }
}

async function inspectIdentity(root, expected) {
  try {
    const identity = await readSourceIdentity(root)
    return { exists: identity !== null, matches: identitiesEqual(identity, expected), identity }
  } catch (error) {
    return { exists: true, matches: false, error }
  }
}

function cleanupStateError(message) {
  return { finalized: false, cleanupErrors: [message] }
}

async function cleanupQuarantineEntries({ source, quarantineRoot, expectedIdentity, cleanup }) {
  const mapped = mapSourceToQuarantine(source, quarantineRoot)
  if (cleanup !== cleanupManagedSource) {
    const state = await inspectIdentity(quarantineRoot, expectedIdentity)
    if (!state.matches) return ['隔离目录身份校验失败']
    try {
      return await cleanup(mapped)
    } catch (error) {
      return [failureMessage(error)]
    }
  }

  const targets = [...mapped.cleanupFiles, ...mapped.cleanupDirectories]
  for (const target of targets) {
    const state = await inspectIdentity(quarantineRoot, expectedIdentity)
    if (!state.matches) return ['隔离目录身份校验失败']
    try {
      await fsp.rm(target, { recursive: true, force: true })
    } catch (error) {
      return [failureMessage(error)]
    }
  }
  return []
}

async function runQuarantineCleanup({ pendingPath, pending, marker, cleanup, writePending }) {
  const sourceRoot = pending.source.root
  const quarantineRoot = pending.quarantineRoot
  const sourceState = await inspectIdentity(sourceRoot, marker.sourceIdentity)
  const quarantineState = await inspectIdentity(quarantineRoot, marker.sourceIdentity)

  if (sourceState.matches && !quarantineState.exists) {
    try {
      await fsp.rename(sourceRoot, quarantineRoot)
    } catch (error) {
      return cleanupStateError(`旧数据目录隔离失败：${failureMessage(error)}`)
    }
  } else if (!(quarantineState.matches && !sourceState.exists)) {
    return cleanupStateError('旧数据目录隔离状态冲突')
  }

  const renamedState = await inspectIdentity(quarantineRoot, marker.sourceIdentity)
  if (!renamedState.matches) {
    const currentSource = await inspectIdentity(sourceRoot, marker.sourceIdentity)
    if (!currentSource.exists) await fsp.rename(quarantineRoot, sourceRoot).catch(() => {})
    return cleanupStateError('隔离目录身份校验失败')
  }

  const cleanupErrors = await cleanupQuarantineEntries({
    source: pending.source,
    quarantineRoot,
    expectedIdentity: marker.sourceIdentity,
    cleanup
  })
  if (cleanupErrors.length) return { finalized: false, cleanupErrors }

  const beforeRestore = await inspectIdentity(quarantineRoot, marker.sourceIdentity)
  if (!beforeRestore.matches) return cleanupStateError('隔离目录恢复前身份校验失败')
  const sourceBeforeRestore = await inspectIdentity(sourceRoot, marker.sourceIdentity)
  if (sourceBeforeRestore.exists) return cleanupStateError('旧数据目录路径已被占用')
  try {
    await fsp.rename(quarantineRoot, sourceRoot)
  } catch (error) {
    return cleanupStateError(`旧数据目录恢复失败：${failureMessage(error)}`)
  }

  const cleaned = { ...pending, phase: 'cleaned' }
  try {
    await writePending(pendingPath, cleaned)
  } catch (error) {
    return cleanupStateError(failureMessage(error))
  }
  return { finalized: true, cleanupErrors: [], pending: cleaned }
}

module.exports = {
  cleanupManagedSource,
  cleanupStateError,
  failureMessage,
  identitiesEqual,
  quarantinePathFor,
  readSourceIdentity,
  runQuarantineCleanup,
  validateCleanupTopology
}
